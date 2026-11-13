#!/usr/bin/env node
/**
 * 生成参数链路回归（缺陷 #1：「非常难听 / 几乎听不出是音乐」）。
 *
 *   node scripts/test-audio-params.mjs
 *
 * 锁住两条根因，全部断言跑在**真实导出的函数**上（不复制逻辑）：
 *
 *  A) turbo DiT 的 shift 必须是 3.0
 *     - `buildSynthPayload()` 快速档按引擎 `/props` 的 `presets.turbo`
 *       （8 步 / guidance 1.0 / shift 3.0）；喂 1.0 会过曝发刺（实测峰值 0.996 vs 0.958）；
 *     - `applyModelSelection()`（现代运行时）按变体统一覆盖预设，2B turbo 也是 3.0，
 *       不再只对 xl_turbo 打补丁；
 *     - 质量档（sft 预设）仍是 50 步 / 1.0 / 1.0，且复用 QUALITY_* 常量。
 *
 *  B) 调性必须一路下传：工程 C minor 就要按 C minor 生成
 *     - `parseAudioPlan()` 保留 keyscale / timesignature（乱码、超长一律丢弃）；
 *     - `keyscaleFromProject()` 能从工程 key/scale 派生（前端兜底）；
 *     - 服务端 `generate_audio` 工具把 keyscale 写进 audioPlan，模型没给就按工程兜底。
 *
 * 为什么单独一个脚本：`parseAudioPlan` 在 apps/web（TS），`generate_audio` 在 apps/server（TS），
 * 而 `scripts/test-ai.mjs` 要起后端 + 占端口。这里用 Node 24 的 `module.registerHooks`
 * 直接跑 TS 源码（无 esbuild/tsx 依赖），companion.mjs 的断言同时也在 test-ai.mjs 里跑一份。
 *
 * 注：只 stub 两个与生成参数无关的模块（UI 提示串 / 浏览器音频引擎），其它全是真实模块。
 */
import module, { stripTypeScriptTypes } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CORE_ENTRY = path.join(ROOT, 'packages/core/src/index.ts')
const WEB_SRC = path.join(ROOT, 'apps/web/src')

/**
 * 与生成参数无关、且在 Node 里跑不起来的两个模块：
 * - CompanionBadge.tsx：只导出一个提示串辅助函数（TSX 无法用 strip-only 转译）；
 * - audio/index.ts：真实浏览器音频引擎（依赖 Tone.js / AudioContext）。
 */
const STUBBED = new Map([
  ['CompanionBadge.tsx', 'export function resolveCompanionHint(){ return "stub-companion-hint" }'],
  ['audio/index.ts', 'export function getAudioEngine(){ throw new Error("测试环境没有浏览器音频引擎") }'],
])

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', gold: '\x1b[33m', bold: '\x1b[1m' }

let passed = 0
let failed = 0
const failures = []

function ok(name, detail = '') {
  passed++
  console.log(`  ${C.green}✓${C.reset} ${name}${detail ? `${C.dim}  ${detail}${C.reset}` : ''}`)
}
function bad(name, error) {
  failed++
  const message = error instanceof Error ? error.message : String(error)
  failures.push({ name, message })
  console.log(`  ${C.red}✗${C.reset} ${name}${C.dim}  ${message}${C.reset}`)
}
function check(name, fn) {
  try {
    const detail = fn()
    if (detail === false) throw new Error('断言为 false')
    ok(name, typeof detail === 'string' ? detail : '')
  } catch (error) {
    bad(name, error)
  }
}

/* ------------------------------------------------------------------ */
/* TS 加载钩子：`.js` 说明符 → `.ts`，并就地转译（Node 24 内置）        */
/* ------------------------------------------------------------------ */

function installTsHooks() {
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@aiab/core' || specifier.startsWith('@aiab/core/')) {
        return { url: pathToFileURL(CORE_ENTRY).href, shortCircuit: true }
      }
      if (specifier.startsWith('@/')) {
        return { url: pathToFileURL(path.join(WEB_SRC, specifier.slice(2))).href, shortCircuit: true }
      }
      if (/^\.\.?\//.test(specifier) && context.parentURL?.startsWith('file:')) {
        const target = fileURLToPath(new URL(specifier, context.parentURL))
        const candidates = target.endsWith('.js')
          ? [target.slice(0, -3) + '.ts', target.slice(0, -3) + '.tsx', target]
          : [target + '.ts', target + '.tsx', path.join(target, 'index.ts'), target]
        for (const candidate of candidates) {
          if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true }
        }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url, context)
      const file = fileURLToPath(url)
      if (file.includes('node_modules') || !/\.(ts|tsx)$/.test(file)) return nextLoad(url, context)
      const stub = [...STUBBED.entries()].find(([suffix]) => file.replace(/\\/g, '/').endsWith(suffix))
      if (stub) return { format: 'module', source: stub[1], shortCircuit: true }
      return {
        format: 'module',
        source: stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'transform' }),
        shortCircuit: true,
      }
    },
  })
}

/** audioIntent / store 在模块顶层会摸 window/localStorage：给最小浏览器壳 */
function installBrowserGlobals() {
  const noop = () => {}
  globalThis.window = {
    dispatchEvent: noop,
    addEventListener: noop,
    removeEventListener: noop,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  }
  globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop }
}

/* ------------------------------------------------------------------ */
/* 载入被测模块                                                        */
/* ------------------------------------------------------------------ */

installBrowserGlobals()
installTsHooks()

const companion = await import('./companion.mjs')
const {
  applyModelSelection,
  buildQualityLmRequest,
  buildQualitySynthRequest,
  buildSynthPayload,
  normalizeKeyscale,
  normalizeTimesignature,
  presetForVariant,
  readWavInfo,
  toEngineDecodableWav,
  QUALITY_GUIDANCE,
  QUALITY_PEAK_CLIP,
  QUALITY_SHIFT,
  QUALITY_STEPS,
  resolveVocalLanguage,
  RUNTIME_API,
  TURBO_GUIDANCE,
  TURBO_SHIFT,
  TURBO_STEPS,
  withAuthoritativeMetadata,
} = companion
const audioIntent = await import('../apps/web/src/features/audio/audioIntent.ts')
const { parseAudioPlan, keyscaleFromProject, timesignatureFromProject } = audioIntent
const { AUDIO_TOOLS } = await import('../apps/server/src/tools/audio.ts')

/** 用一次性的模块实例验证「现代运行时」分支（RUNTIME_API 在 import 时读取环境变量） */
async function loadCompanionAs(api) {
  const previous = process.env.AIAB_ACESTEP_API
  process.env.AIAB_ACESTEP_API = api
  try {
    return await import(`./companion.mjs?runtime=${api}`)
  } finally {
    if (previous === undefined) delete process.env.AIAB_ACESTEP_API
    else process.env.AIAB_ACESTEP_API = previous
  }
}

const near = (a, b) => Math.abs(a - b) < 1e-9
const expectEq = (label, actual, expected) => {
  const same = typeof expected === 'number' ? near(Number(actual), expected) : JSON.stringify(actual) === JSON.stringify(expected)
  if (!same) throw new Error(`${label} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

console.log(`\n${C.gold}${C.bold}生成参数链路 · 缺陷 #1 回归${C.reset}`)
console.log(`${C.dim}当前 RUNTIME_API=${RUNTIME_API}（/props presets.turbo = 8 步 / guidance 1.0 / shift 3.0）${C.reset}\n`)

/* ================================================================== */
/* A. turbo DiT 的采样预设                                             */
/* ================================================================== */

console.log(`${C.bold}A. turbo DiT 的 shift 必须是 3.0${C.reset}`)

check('presetForVariant：turbo / xl_turbo → 8 步 / 1.0 / shift 3.0', () => {
  for (const variant of ['turbo', 'xl_turbo']) {
    const preset = presetForVariant(variant)
    expectEq(`${variant}.inference_steps`, preset.inference_steps, TURBO_STEPS)
    expectEq(`${variant}.guidance_scale`, preset.guidance_scale, TURBO_GUIDANCE)
    expectEq(`${variant}.shift`, preset.shift, TURBO_SHIFT)
  }
  return `shift=${TURBO_SHIFT}（引擎 presets.turbo）`
})

check('presetForVariant：sft / base / xl_sft / xl_base → 50 步 / 1.0 / shift 1.0', () => {
  for (const variant of ['sft', 'base', 'xl_sft', 'xl_base']) {
    const preset = presetForVariant(variant)
    expectEq(`${variant}.inference_steps`, preset.inference_steps, QUALITY_STEPS)
    expectEq(`${variant}.shift`, preset.shift, QUALITY_SHIFT)
  }
  return `复用 QUALITY_STEPS/GUIDANCE/SHIFT 常量，未重复定义`
})

check('QUALITY_* 常量与引擎 presets.sft 一致', () => {
  expectEq('QUALITY_STEPS', QUALITY_STEPS, 50)
  expectEq('QUALITY_GUIDANCE', QUALITY_GUIDANCE, 1)
  expectEq('QUALITY_SHIFT', QUALITY_SHIFT, 1)
  return '50 / 1.0 / 1.0'
})

check('buildSynthPayload({caption,bpm,keyscale}) → shift 3.0 且 keyscale 透传', () => {
  const payload = buildSynthPayload({ caption: 'energetic japanese rock, guitar bass drums', bpm: 178, keyscale: 'C minor' })
  expectEq('shift', payload.shift, 3)
  expectEq('inference_steps', payload.inference_steps, 8)
  expectEq('guidance_scale', payload.guidance_scale, 1)
  expectEq('keyscale', payload.keyscale, 'C minor')
  expectEq('bpm', payload.bpm, 178)
  return `shift=${payload.shift} · keyscale=${payload.keyscale}`
})

check('buildSynthPayload 未给调性时才回落 "C major"', () => {
  const payload = buildSynthPayload({ caption: 'lofi beat' })
  expectEq('keyscale', payload.keyscale, 'C major')
  if (payload.shift !== 3) throw new Error(`shift 期望 3，实际 ${payload.shift}`)
  return '缺省 keyscale=C major（仅此一处回落）'
})

check('buildSynthPayload：乱码调性不喂给引擎（回落 C major）', () => {
  for (const garbage of ['', '   ', 'loud and fast', 'C', 'Cminorminorminor!!!']) {
    const payload = buildSynthPayload({ caption: 'x', keyscale: garbage })
    expectEq(`keyscale(${JSON.stringify(garbage)})`, payload.keyscale, 'C major')
  }
  return '非法调性统一回落 C major'
})

check('buildSynthPayload：timesignature 取分子字符串', () => {
  expectEq('缺省', buildSynthPayload({ caption: 'x' }).timesignature, '4')
  expectEq("'4/4'", buildSynthPayload({ caption: 'x', timesignature: '4/4' }).timesignature, '4')
  expectEq("'3/4'", buildSynthPayload({ caption: 'x', timesignature: '3/4' }).timesignature, '3')
  expectEq('数字 6', buildSynthPayload({ caption: 'x', timesignature: 6 }).timesignature, '6')
  return '引擎只认分子字符串'
})

check('normalizeKeyscale：大小写/写法规整，非法形状返回 undefined', () => {
  expectEq('c minor', normalizeKeyscale('c minor'), 'C minor')
  expectEq('C#minor', normalizeKeyscale('C#minor'), 'C# minor')
  expectEq('F# major', normalizeKeyscale('F# major'), 'F# major')
  expectEq('b♭ major', normalizeKeyscale('b♭ major'), 'Bb major')
  expectEq('多空格', normalizeKeyscale('  D   major  '), 'D major')
  expectEq('乱码', normalizeKeyscale('definitely not a key'), undefined)
  expectEq('超长', normalizeKeyscale(`${'C minor '.repeat(20)}`), undefined)
  expectEq('非字符串', normalizeKeyscale(42), undefined)
  return 'C minor / C# minor / F# major 接受，乱码拒绝'
})

check('normalizeTimesignature：只接受 1–16 的分子', () => {
  expectEq("'4/4'", normalizeTimesignature('4/4'), '4')
  expectEq("'3/4'", normalizeTimesignature('3/4'), '3')
  expectEq('4', normalizeTimesignature(4), '4')
  expectEq("'x'", normalizeTimesignature('x'), '4')
  expectEq('0', normalizeTimesignature(0), '4')
  expectEq('99', normalizeTimesignature(99), '4')
  return '非法回落 4'
})

check('applyModelSelection（现代运行时）：turbo 保持 shift 3.0，绝不回落 1.0', async () => {
  const modern = await loadCompanionAs('modern')
  if (modern.RUNTIME_API !== 'modern') throw new Error(`未切到现代运行时：${modern.RUNTIME_API}`)
  const base = modern.buildSynthPayload({ caption: 'j-rock', keyscale: 'C minor' })
  for (const variant of ['turbo', 'xl_turbo']) {
    const applied = modern.applyModelSelection(base, { variant })
    expectEq(`${variant}.shift`, applied.shift, 3)
    expectEq(`${variant}.inference_steps`, applied.inference_steps, 8)
    expectEq(`${variant}.guidance_scale`, applied.guidance_scale, 1)
    if (applied.shift === 1) throw new Error(`${variant} 的 shift 仍为 1.0（缺陷未修）`)
    if (!applied.synth_model) throw new Error(`${variant} 缺少 synth_model`)
  }
  for (const variant of ['sft', 'xl_sft']) {
    const applied = modern.applyModelSelection(base, { variant })
    expectEq(`${variant}.shift`, applied.shift, 1)
    expectEq(`${variant}.inference_steps`, applied.inference_steps, 50)
  }
  return 'turbo/xl_turbo→shift 3.0 · sft→1.0'
})

check('applyModelSelection（现代运行时）：/lm 请求体不被塞采样字段', async () => {
  const modern = await loadCompanionAs('modern')
  const lmPayload = modern.buildQualityLmRequest({ caption: 'j-rock' })
  if ('inference_steps' in lmPayload) throw new Error('buildQualityLmRequest 不应带 inference_steps')
  const applied = modern.applyModelSelection(lmPayload, { variant: 'sft', lmTier: '1.7B' })
  if ('inference_steps' in applied || 'shift' in applied) {
    throw new Error(`/lm 请求被写入采样字段：${JSON.stringify(applied)}`)
  }
  expectEq('output_format', applied.output_format, 'wav16')
  return '只有 /synth 请求体才覆盖采样预设'
})

check('buildQualitySynthRequest：sft 预设 50 步 / 1.0 / shift 1.0', () => {
  const request = buildQualitySynthRequest({ caption: 'x', bpm: 170 }, { durationSec: 45 })
  expectEq('inference_steps', request.inference_steps, QUALITY_STEPS)
  expectEq('guidance_scale', request.guidance_scale, QUALITY_GUIDANCE)
  expectEq('shift', request.shift, QUALITY_SHIFT)
  return `${request.inference_steps} 步 · shift ${request.shift}`
})

/* ================================================================== */
/* A2. 质量档：工程元数据必须压过 LM（bpm/keyscale/timesignature/语言） */
/* ================================================================== */

console.log(`\n${C.bold}A2. 质量档：工程元数据压过 LM 推断（165 BPM / A minor 必须保住）${C.reset}`)

check('质量档 /lm 请求体带工程 bpm/keyscale/timesignature', () => {
  const payload = buildQualityLmRequest({
    caption: 'j-rock',
    bpm: 165,
    keyscale: 'a minor',
    timesignature: '4',
    durationSec: 240,
  })
  // 真机实证：不带这三项时引擎会走 CoT「fill gaps」，实测同一工程跑出 83/167/176 BPM、
  // timesignature=6、vocal_language=ar。必须在 /lm 就钉住。
  expectEq('bpm', payload.bpm, 165)
  expectEq('keyscale', payload.keyscale, 'A minor')
  expectEq('timesignature', payload.timesignature, '4')
  if ('inference_steps' in payload || 'shift' in payload || 'peak_clip' in payload) {
    throw new Error(`/lm 请求体不应带采样/限幅字段：${JSON.stringify(payload)}`)
  }
  return `bpm=${payload.bpm} key=${payload.keyscale} ts=${payload.timesignature}`
})

check('质量档 /lm：未给 bpm/keyscale 时不写入（保持旧行为）', () => {
  const payload = buildQualityLmRequest({ caption: 'j-rock' })
  if ('bpm' in payload || 'keyscale' in payload || 'timesignature' in payload) {
    throw new Error(`没给工程元数据却写进了请求：${JSON.stringify(payload)}`)
  }
  return '缺省不写，交给引擎推断'
})

check('质量档 /synth：LM 回显的错误 bpm/keyscale 被工程值覆盖', () => {
  // 模拟真机 LM 的回显：bpm=83（半速）、keyscale 正常、timesignature=6
  const lmResult = { caption: 'j-rock', bpm: 83, keyscale: 'A minor', timesignature: '6', duration: 240 }
  const request = buildQualitySynthRequest(lmResult, {
    bpm: 165,
    keyscale: 'A minor',
    timesignature: '4',
    durationSec: 240,
  })
  expectEq('bpm（LM 的 83 必须被覆盖）', request.bpm, 165)
  expectEq('timesignature（LM 的 6 必须被覆盖）', request.timesignature, '4')
  expectEq('keyscale', request.keyscale, 'A minor')
  // 不要动 LM 的其他字段
  expectEq('caption', request.caption, 'j-rock')
  expectEq('duration', request.duration, 240)
  return `LM bpm=83/ts=6 → 强制 165/4`
})

check('质量档 /synth：peak_clip 取 QUALITY_PEAK_CLIP（默认 10 会削顶）', () => {
  const request = buildQualitySynthRequest({ caption: 'x', bpm: 165 }, { bpm: 165 })
  expectEq('peak_clip', request.peak_clip, QUALITY_PEAK_CLIP)
  if (request.peak_clip >= 10) throw new Error('peak_clip 仍是引擎默认的 10（成品会贴顶削顶）')
  return `peak_clip=${request.peak_clip}`
})

check('withAuthoritativeMetadata：非法工程值不写入，不污染请求', () => {
  const request = withAuthoritativeMetadata({ caption: 'x' }, { bpm: 0, keyscale: '？？？', timesignature: 'x' })
  if ('bpm' in request || 'keyscale' in request) throw new Error('非法值不该写进请求')
  expectEq('timesignature 回落 4', request.timesignature, '4')
  // bpm 越界要被 clamp，而不是原样透传
  const clamped = withAuthoritativeMetadata({ caption: 'x' }, { bpm: 999 })
  expectEq('越界 bpm 被 clamp', clamped.bpm, 300)
  return '非法 bpm/keyscale 丢弃 · 越界 clamp'
})

/* ================================================================== */
/* A3. 演唱语言                                                        */
/* ================================================================== */

console.log(`\n${C.bold}A3. 演唱语言（vocalLanguage 一路下传，缺省 unknown/推断）${C.reset}`)

check('vocalLanguage：纯乐器时一律 unknown（不因 caption 有 Japanese 就开日语）', () => {
  // 旧行为必须保住：instrumental 缺省 true → vocal_language 仍是 'unknown'
  expectEq('缺省', resolveVocalLanguage({ caption: 'japanese j-rock' }), 'unknown')
  expectEq('explicit true', resolveVocalLanguage({ caption: 'japanese j-rock', instrumental: true }), 'unknown')
  return 'unknown'
})

check('vocalLanguage：显式值优先', () => {
  expectEq('ja', resolveVocalLanguage({ instrumental: false, vocalLanguage: 'ja' }), 'ja')
  // 显式值和 caption 线索冲突时，以显式值为准
  expectEq('显式 en 压过 caption 的 Japanese', resolveVocalLanguage({
    instrumental: false,
    vocalLanguage: 'en',
    caption: 'japanese j-rock',
  }), 'en')
  return 'ja / en'
})

check('vocalLanguage：要人声且无显式值时按 caption 线索推断', () => {
  expectEq('J-ROCK → ja', resolveVocalLanguage({ instrumental: false, caption: 'hot-blooded japanese j-rock anime opening' }), 'ja')
  expectEq('非日语 → en', resolveVocalLanguage({ instrumental: false, caption: 'warm cinematic piano' }), 'en')
  return 'ja / en 推断'
})

check('buildSynthPayload：vocal_language 随 vocalLanguage 下传', () => {
  const payload = buildSynthPayload({ caption: 'j-rock', bpm: 165, instrumental: false, vocalLanguage: 'ja' })
  expectEq('vocal_language', payload.vocal_language, 'ja')
  // 纯乐器分支保持旧值
  const instrumental = buildSynthPayload({ caption: 'j-rock', bpm: 165 })
  expectEq('纯乐器 vocal_language', instrumental.vocal_language, 'unknown')
  expectEq('纯乐器 lyrics', instrumental.lyrics, '[Instrumental]')
  return 'ja · 纯乐器仍 unknown'
})

check('parseAudioPlan：vocalLanguage 归一化为小写 BCP-47', () => {
  const plan = parseAudioPlan({ audioPlan: { mode: 'text_to_audio', instrumental: false, vocalLanguage: 'JA-jp' } })
  expectEq('vocalLanguage', plan?.vocalLanguage, 'ja-jp')
  const garbage = parseAudioPlan({ audioPlan: { mode: 'text_to_audio', vocalLanguage: '非常に長い言語名がここに' } })
  expectEq('乱码被丢弃', garbage?.vocalLanguage, undefined)
  const missing = parseAudioPlan({ audioPlan: { mode: 'text_to_audio' } })
  expectEq('缺省 undefined', missing?.vocalLanguage, undefined)
  return 'JA-jp → ja-jp · 乱码丢弃'
})

check('generate_audio 工具：vocalLanguage 能进计划', async () => {
  const tool = AUDIO_TOOLS.find((item) => item.name === 'generate_audio')
  if (!tool) throw new Error('找不到 generate_audio 工具')
  const properties = tool.parameters.properties ?? {}
  const field = properties.vocalLanguage
  if (!field) throw new Error('schema 里没有 vocalLanguage')
  // 不在 required 里：缺省可用（Companion 按 caption 推断）
  const required = tool.parameters.required ?? []
  if (required.includes('vocalLanguage')) throw new Error('vocalLanguage 不能是必填')
  const result = await runGenerateAudio({
    mode: 'text_to_audio',
    caption: 'j-rock',
    instrumental: false,
    vocalLanguage: 'JA',
  })
  if (!result.ok) throw new Error(result.message)
  expectEq('计划里的 vocalLanguage', result.data?.audioPlan?.vocalLanguage, 'ja')
  return 'schema 有 vocalLanguage · JA → ja'
})

/* ================================================================== */
/* B. 调性一路下传                                                     */
/* ================================================================== */

console.log(`\n${C.bold}B. 调性必须一路下传（工程 C minor → 引擎 C minor）${C.reset}`)

check('parseAudioPlan：保留 keyscale / timesignature', () => {
  const plan = parseAudioPlan({
    audioPlan: { mode: 'text_to_audio', caption: 'j-rock', bpm: 178, keyscale: 'C minor', timesignature: '4' },
  })
  if (!plan) throw new Error('parseAudioPlan 返回 null')
  expectEq('keyscale', plan.keyscale, 'C minor')
  expectEq('timesignature', plan.timesignature, '4')
  expectEq('bpm', plan.bpm, 178)
  return `keyscale=${plan.keyscale}`
})

check('parseAudioPlan：keyscale 归一化（"c#minor" → "C# minor"）', () => {
  const plan = parseAudioPlan({ audioPlan: { mode: 'text_to_audio', keyscale: 'c#minor' } })
  expectEq('keyscale', plan?.keyscale, 'C# minor')
  return 'c#minor → C# minor'
})

check('parseAudioPlan：超长 / 乱码 keyscale 被丢弃', () => {
  const tooLong = parseAudioPlan({ audioPlan: { mode: 'text_to_audio', keyscale: 'C minor '.repeat(30) } })
  expectEq('超长 keyscale', tooLong?.keyscale, undefined)
  const garbage = parseAudioPlan({ audioPlan: { mode: 'text_to_audio', keyscale: ' très énergique et très rapide ' } })
  expectEq('乱码 keyscale', garbage?.keyscale, undefined)
  const nonString = parseAudioPlan({ audioPlan: { mode: 'text_to_audio', keyscale: { evil: true } } })
  expectEq('非字符串 keyscale', nonString?.keyscale, undefined)
  const badTimesig = parseAudioPlan({ audioPlan: { mode: 'text_to_audio', timesignature: '4/4' } })
  expectEq('非分子 timesignature', badTimesig?.timesignature, undefined)
  return '乱码/超长/非字符串一律丢弃，由工程兜底'
})

check('keyscaleFromProject：工程 key/scale → 引擎 keyscale', () => {
  expectEq('C minor', keyscaleFromProject({ key: 'C', scale: 'minor' }), 'C minor')
  expectEq('C major', keyscaleFromProject({ key: 'C', scale: 'major' }), 'C major')
  expectEq('F# minor', keyscaleFromProject({ key: 'F#', scale: 'minor' }), 'F# minor')
  expectEq('Eb major（工程无此调名但形状合法）', keyscaleFromProject({ key: 'Eb', scale: 'major' }), 'Eb major')
  expectEq('harmonicMinor', keyscaleFromProject({ key: 'A', scale: 'harmonicMinor' }), 'A harmonic minor')
  expectEq('无 key', keyscaleFromProject({ scale: 'minor' }), undefined)
  expectEq('空工程', keyscaleFromProject(undefined), undefined)
  return 'C+minor → C minor'
})

check('timesignatureFromProject：工程拍号 → 分子字符串', () => {
  expectEq('4/4', timesignatureFromProject({ timeSignature: { numerator: 4, denominator: 4 } }), '4')
  expectEq('3/4', timesignatureFromProject({ timeSignature: { numerator: 3, denominator: 4 } }), '3')
  expectEq('缺字段', timesignatureFromProject({}), undefined)
  expectEq('非法', timesignatureFromProject({ timeSignature: { numerator: 0 } }), undefined)
  return '4/4 → "4"'
})

/* 服务端工具：generate_audio → audioPlan 带 keyscale */
const generateAudio = AUDIO_TOOLS.find((tool) => tool.name === 'generate_audio')
if (!generateAudio) throw new Error('找不到 generate_audio 工具定义')

/** 造一个最小 ToolContext（工具只读 project.tracks / tempo / key / scale / timeSignature） */
function toolContext(overrides = {}) {
  const project = {
    id: 'p_test',
    name: 'C minor J-ROCK',
    tempo: 178,
    timeSignature: { numerator: 4, denominator: 4 },
    key: 'C',
    scale: 'minor',
    tracks: [],
    ...overrides,
  }
  return { project, settings: {}, allowProjectEdits: true, allowWebSearch: false }
}

async function runGenerateAudio(args, ctx = toolContext()) {
  const result = await generateAudio.handler(args, ctx)
  return result
}

check('generate_audio 工具 schema 暴露 keyscale 参数', () => {
  const properties = generateAudio.parameters.properties ?? {}
  if (!properties.keyscale) throw new Error('schema 里没有 keyscale')
  const description = String(properties.keyscale.description ?? '')
  if (!description.includes('C minor')) throw new Error(`keyscale 描述缺少示例 "C minor"：${description}`)
  return 'schema 含 keyscale（示例 "C minor"）'
})

await check('generate_audio：模型给的 keyscale 写进 audioPlan', async () => {
  const result = await runGenerateAudio({ mode: 'text_to_audio', caption: 'j-rock', keyscale: 'C# minor' })
  if (!result.ok) throw new Error(result.message)
  const plan = result.data?.audioPlan
  expectEq('keyscale', plan?.keyscale, 'C# minor')
  expectEq('timesignature', plan?.timesignature, '4')
  expectEq('bpm（缺省取工程）', plan?.bpm, 178)
  return `audioPlan.keyscale=${plan.keyscale}`
})

await check('generate_audio：模型没给 keyscale → 按工程 key/scale 兜底', async () => {
  const result = await runGenerateAudio({ mode: 'text_to_audio', caption: 'j-rock' })
  if (!result.ok) throw new Error(result.message)
  const plan = result.data?.audioPlan
  expectEq('keyscale', plan?.keyscale, 'C minor')
  return `工程 C minor → audioPlan.keyscale=${plan.keyscale}`
})

await check('generate_audio：乱码 keyscale → 回落工程调性', async () => {
  const result = await runGenerateAudio({ mode: 'text_to_audio', caption: 'j-rock', keyscale: 'loud energetic rock' })
  if (!result.ok) throw new Error(result.message)
  expectEq('keyscale', result.data?.audioPlan?.keyscale, 'C minor')
  return '乱码被丢弃，工程调性兜底'
})

await check('generate_audio：工程是 G major 时兜底为 G major（不写死 C major）', async () => {
  const result = await runGenerateAudio({ mode: 'text_to_audio', caption: 'pop' }, toolContext({ key: 'G', scale: 'major' }))
  if (!result.ok) throw new Error(result.message)
  expectEq('keyscale', result.data?.audioPlan?.keyscale, 'G major')
  return '兜底跟随工程，不是硬编码'
})

await check('generate_audio：midi_to_audio 也带调性（render 路径不被破坏）', async () => {
  const ctx = toolContext({
    tracks: [{ id: 't1', clips: [{ id: 'c1', notes: [], startBeat: 0, lengthBeats: 4 }], audioClips: [] }],
  })
  const result = await runGenerateAudio({ mode: 'midi_to_audio', caption: 'render' }, ctx)
  if (!result.ok) throw new Error(result.message)
  expectEq('keyscale', result.data?.audioPlan?.keyscale, 'C minor')
  expectEq('stems', result.data?.audioPlan?.stems, undefined)
  return 'midi_to_audio 计划仍正常，含 keyscale'
})

/* ================================================================== */
/* C. 端到端：工程 C minor → 工具计划 → 前端 POST → 引擎 /synth 请求体   */
/* ================================================================== */

console.log(`\n${C.bold}C. 端到端：工程 C minor 一路走到 /synth 请求体${C.reset}`)

await check('前端 runCompanionFlow 真的把 keyscale/timesignature 发出去', async () => {
  // 捕获取事件，替换全局 fetch（只回答本测试需要的几个接口）
  const calls = []
  const originalFetch = globalThis.fetch
  const jsonOk = (value) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => value,
    text: async () => JSON.stringify(value),
  })
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    calls.push({ path: target, method: init?.method ?? 'GET', body: init?.body ? String(init.body) : null })
    if (target.includes('/api/companion/tasks') && init?.method === 'POST') {
      return jsonOk({ taskId: 'task_probe', status: 'queued', summary: 'ok' })
    }
    if (/\/api\/companion\/tasks\//.test(target)) {
      return jsonOk({ task: { id: 'task_probe', status: 'done', progress: 1, assetId: 'asset_probe' } })
    }
    if (target.includes('/api/companion/status')) return jsonOk({ online: true, summary: { workers: 1 }, workers: [], tasks: [] })
    if (target.includes('/api/companion/node')) return jsonOk({ available: true, controllable: true, state: 'running' })
    if (target.includes('/peaks')) {
      return jsonOk({ durationSec: 30, sampleRate: 48_000, channels: 2, peaks: Array.from({ length: 32 }, () => 0.5) })
    }
    if (target.includes('/api/provision/status')) {
      return jsonOk({ supported: true, runtime: { installed: true }, profiles: [{ id: 'essential', ready: true }] })
    }
    return jsonOk({})
  }
  try {
    const { useStore } = await import('../apps/web/src/store/store.ts')
    // 复刻用户真实故障场景：C minor / 178 BPM
    useStore.getState().setProject(
      {
        ...useStore.getState().project,
        key: 'C',
        scale: 'minor',
        tempo: 178,
        timeSignature: { numerator: 4, denominator: 4 },
      },
      { resetHistory: true },
    )
    await audioIntent.runAudioPlan({
      mode: 'text_to_audio',
      caption: 'energetic japanese rock, guitar bass drums, 178 bpm',
      bpm: 178,
      durationSec: 30,
    })
    const post = calls.find((call) => call.method === 'POST' && call.path.includes('/api/companion/tasks'))
    if (!post) throw new Error('前端没有发出 generate_audio 任务')
    const params = JSON.parse(post.body).params
    expectEq('params.keyscale', params.keyscale, 'C minor')
    expectEq('params.timesignature', params.timesignature, '4')
    expectEq('params.bpm', params.bpm, 178)
    // 计划里给了调性时，前端不得用工程调性覆盖
    const withPlanKey = await runGenerateAudio({ mode: 'text_to_audio', caption: 'x', keyscale: 'F# major' })
    expectEq('显式 keyscale 优先', withPlanKey.data?.audioPlan?.keyscale, 'F# major')
    return `POST params.keyscale=${params.keyscale} · timesignature=${params.timesignature}`
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('最终 /synth 请求体：shift=3.0 且 keyscale=C minor（两条缺陷同时验证）', () => {
  // 模拟 claim 回来的一整圈：工具 plan → 路由透传 → companion buildSynthPayload
  const params = { caption: 'energetic japanese rock', bpm: 178, keyscale: 'C minor', timesignature: '4', durationSec: 30 }
  const payload = buildSynthPayload(params)
  expectEq('shift', payload.shift, 3)
  expectEq('inference_steps', payload.inference_steps, 8)
  expectEq('keyscale', payload.keyscale, 'C minor')
  expectEq('timesignature', payload.timesignature, '4')
  expectEq('bpm', payload.bpm, 178)
  if (payload.keyscale === 'C major') throw new Error('调性又变回 C major 了（缺陷 #1-B 复发）')
  if (payload.shift === 1) throw new Error('shift 又变回 1.0 了（缺陷 #1-A 复发）')
  return JSON.stringify({ shift: payload.shift, keyscale: payload.keyscale, steps: payload.inference_steps })
})

/* ================================================================== */
/* D. 人声意图一路下传（缺陷 #3：人声轨全是噪音）                        */
/* ================================================================== */

console.log(`\n${C.bold}D. 人声意图：工具 plan → 前端 POST → companion payload / 分轨护栏${C.reset}`)

check('generate_audio 工具 schema 暴露 instrumental（缺省 true = 纯乐器）', () => {
  const properties = generateAudio.parameters.properties ?? {}
  const field = properties.instrumental
  if (!field) throw new Error('schema 里没有 instrumental')
  if (field.type !== 'boolean') throw new Error(`instrumental 应是 boolean，实际 ${field.type}`)
  const description = String(field.description ?? '')
  if (!/人声/.test(description) || !/true/.test(description)) {
    throw new Error(`instrumental 描述应中文说明「要人声传 false」，实际：${description}`)
  }
  // 不在 required 里：缺省必须可用（旧调用方不传）
  const required = generateAudio.parameters.required ?? []
  if (required.includes('instrumental')) throw new Error('instrumental 不能是必填（缺省 true）')
  return 'schema 含 instrumental（可选，缺省 true）'
})

await check('generate_audio：缺省 instrumental=true 写进 audioPlan', async () => {
  const result = await runGenerateAudio({ mode: 'text_to_audio', caption: 'lofi beat' })
  if (!result.ok) throw new Error(result.message)
  expectEq('audioPlan.instrumental', result.data?.audioPlan?.instrumental, true)
  return '缺省 = true（纯乐器，旧行为）'
})

await check('generate_audio：instrumental=false 写进 audioPlan（要人声）', async () => {
  const result = await runGenerateAudio({
    mode: 'text_to_audio',
    caption: 'emotional powerful male Japanese rock vocals',
    instrumental: false,
  })
  if (!result.ok) throw new Error(result.message)
  expectEq('audioPlan.instrumental', result.data?.audioPlan?.instrumental, false)
  if (!/含人声/.test(result.message)) throw new Error(`工具回执应说明含人声，实际：${result.message}`)
  return 'audioPlan.instrumental=false · 回执含「含人声」'
})

await check('generate_audio：纯乐器时人声臂自动从分轨计划里去掉（不留噪声轨）', async () => {
  const result = await runGenerateAudio({
    mode: 'audio_with_stems',
    caption: 'lofi instrumental beat',
    stems: ['guitar', 'vocals'],
    instrumental: true,
  })
  if (!result.ok) throw new Error(result.message)
  const stems = result.data?.audioPlan?.stems ?? []
  if (stems.includes('vocals')) throw new Error(`纯乐器计划不该保留 vocals 臂，实际 ${JSON.stringify(stems)}`)
  if (!stems.includes('guitar')) throw new Error('其它臂不能被误删')
  if (!/跳过|去掉/.test(result.message)) throw new Error(`回执应说明人声分轨已去掉，实际：${result.message}`)
  // 要人声时人声臂必须保留
  const vocalPlan = await runGenerateAudio({
    mode: 'audio_with_stems',
    caption: 'japanese rock with vocals',
    stems: ['guitar', 'vocals'],
    instrumental: false,
  })
  expectEq('要人声时保留 vocals', vocalPlan.data?.audioPlan?.stems, ['guitar', 'vocals'])
  return `纯乐器去掉 vocals，保留 ${stems.join('/')}；要人声时保留`
})

check('parseAudioPlan：instrumental 只认显式 false（缺省/非法一律纯乐器）', () => {
  const defaulted = parseAudioPlan({ audioPlan: { mode: 'text_to_audio', caption: 'x' } })
  expectEq('缺省', defaulted?.instrumental, undefined)
  const vocal = parseAudioPlan({ audioPlan: { mode: 'text_to_audio', caption: 'x', instrumental: false } })
  expectEq('显式 false', vocal?.instrumental, false)
  const truthy = parseAudioPlan({ audioPlan: { mode: 'text_to_audio', caption: 'x', instrumental: true } })
  expectEq('显式 true', truthy?.instrumental, undefined)
  const garbage = parseAudioPlan({ audioPlan: { mode: 'text_to_audio', caption: 'x', instrumental: 'yes' } })
  expectEq('非法值', garbage?.instrumental, undefined)
  return '只有 false 才视为要人声'
})

check('resolveStemPlan：纯乐器源跳过 vocals 并给出中文原因，其它臂保留', () => {
  const { resolveStemPlan } = audioIntent
  const skip = resolveStemPlan({ stems: ['guitar', 'bass', 'vocals'], instrumental: true })
  expectEq('保留臂', skip.stems, ['guitar', 'bass'])
  if (skip.skipped.length !== 1 || skip.skipped[0].arm !== 'vocals') {
    throw new Error(`应跳过 vocals 一臂，实际 ${JSON.stringify(skip.skipped)}`)
  }
  if (!/人声/.test(skip.skipped[0].reason) || !/噪声/.test(skip.skipped[0].reason)) {
    throw new Error(`跳过原因应是可执行的中文说明，实际 ${skip.skipped[0].reason}`)
  }
  // 要人声：不动
  expectEq('要人声不跳', resolveStemPlan({ stems: ['guitar', 'vocals'], instrumental: false }).stems, ['guitar', 'vocals'])
  // 缺省 = 纯乐器（计划没写字段时 Companion 仍发 [Instrumental]），所以同样要跳
  const defaulted = resolveStemPlan({ stems: ['guitar', 'vocals'] })
  expectEq('缺省不保留 vocals', defaulted.stems, ['guitar'])
  return '纯乐器/缺省跳过 vocals（含原因），要人声时保留'
})

await check('前端 runCompanionFlow 把 instrumental 真的发出去（要人声场景）', async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  const jsonOk = (value) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => value,
    text: async () => JSON.stringify(value),
  })
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    calls.push({ path: target, method: init?.method ?? 'GET', body: init?.body ? String(init.body) : null })
    if (target.includes('/api/companion/tasks') && init?.method === 'POST') {
      return jsonOk({ taskId: 'task_probe', status: 'queued', summary: 'ok' })
    }
    if (/\/api\/companion\/tasks\//.test(target)) {
      return jsonOk({ task: { id: 'task_probe', status: 'done', progress: 1, assetId: 'asset_probe' } })
    }
    if (target.includes('/api/companion/status')) return jsonOk({ online: true, summary: { workers: 1 }, workers: [], tasks: [] })
    if (target.includes('/api/companion/node')) return jsonOk({ available: true, controllable: true, state: 'running' })
    if (target.includes('/peaks')) {
      return jsonOk({ durationSec: 30, sampleRate: 48_000, channels: 2, peaks: Array.from({ length: 32 }, () => 0.5) })
    }
    if (target.includes('/api/provision/status')) {
      return jsonOk({ supported: true, runtime: { installed: true }, profiles: [{ id: 'essential', ready: true }] })
    }
    return jsonOk({})
  }
  try {
    await audioIntent.runAudioPlan({
      mode: 'text_to_audio',
      caption: 'emotional powerful male Japanese rock vocals',
      bpm: 165,
      durationSec: 30,
      instrumental: false,
    })
    const post = calls.find((call) => call.method === 'POST' && call.path.includes('/api/companion/tasks'))
    if (!post) throw new Error('前端没有发出 generate_audio 任务')
    const params = JSON.parse(post.body).params
    expectEq('params.instrumental', params.instrumental, false)
    // 同一份 params 交给 companion 必须产出「人声」条件
    const payload = buildSynthPayload(params)
    expectEq('引擎 lyrics', payload.lyrics, '')
    expectEq('引擎 vocal_language', payload.vocal_language, 'ja')
    return `POST params.instrumental=false → /synth lyrics="" / vocal_language=ja`
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('纯乐器计划端到端：POST 带 instrumental=true，payload 与旧行为一致', async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  const jsonOk = (value) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => value,
    text: async () => JSON.stringify(value),
  })
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    calls.push({ path: target, method: init?.method ?? 'GET', body: init?.body ? String(init.body) : null })
    if (target.includes('/api/companion/tasks') && init?.method === 'POST') {
      return jsonOk({ taskId: 'task_probe', status: 'queued', summary: 'ok' })
    }
    if (/\/api\/companion\/tasks\//.test(target)) {
      return jsonOk({ task: { id: 'task_probe', status: 'done', progress: 1, assetId: 'asset_probe' } })
    }
    if (target.includes('/api/companion/status')) return jsonOk({ online: true, summary: { workers: 1 }, workers: [], tasks: [] })
    if (target.includes('/api/companion/node')) return jsonOk({ available: true, controllable: true, state: 'running' })
    if (target.includes('/peaks')) {
      return jsonOk({ durationSec: 30, sampleRate: 48_000, channels: 2, peaks: Array.from({ length: 32 }, () => 0.5) })
    }
    if (target.includes('/api/provision/status')) {
      return jsonOk({ supported: true, runtime: { installed: true }, profiles: [{ id: 'essential', ready: true }] })
    }
    return jsonOk({})
  }
  try {
    await audioIntent.runAudioPlan({ mode: 'text_to_audio', caption: 'lofi instrumental beat', bpm: 90, durationSec: 30 })
    const post = calls.find((call) => call.method === 'POST' && call.path.includes('/api/companion/tasks'))
    if (!post) throw new Error('前端没有发出 generate_audio 任务')
    const params = JSON.parse(post.body).params
    expectEq('params.instrumental', params.instrumental, true)
    const payload = buildSynthPayload(params)
    expectEq('引擎 lyrics（旧行为）', payload.lyrics, '[Instrumental]')
    expectEq('引擎 vocal_language（旧行为）', payload.vocal_language, 'unknown')
    return `POST params.instrumental=true → /synth lyrics="[Instrumental]" / vocal_language=unknown`
  } finally {
    globalThis.fetch = originalFetch
  }
})

/* ================================================================== */
/* E. 分轨落轨增益（缺陷 #2：分轨叠加比整曲响 14dB 并削顶）             */
/* ================================================================== */

console.log(`\n${C.bold}E. 分轨落轨增益：叠加不超过整曲、且永不削顶${C.reset}`)

const audioTrack = await import('../apps/web/src/features/audio/audioTrack.ts')
const { stemPlacementVolume, assetPeakFromPeaks, STEM_SUM_HEADROOM, STEM_VOLUME_MIN } = audioTrack

check('assetPeakFromPeaks：取 min/max 全局极值（服务端桶内极值不丢峰）', () => {
  expectEq('典型 -1..1 交错', assetPeakFromPeaks([-0.2, 0.2, -0.5, 0.31]), 0.5)
  expectEq('单边极值', assetPeakFromPeaks([0.1, 0.9, 0.2, 0.3]), 0.9)
  expectEq('空数组', assetPeakFromPeaks([]), 0)
  expectEq('undefined', assetPeakFromPeaks(undefined), 0)
  expectEq('含 NaN 时跳过', assetPeakFromPeaks([Number.NaN, 0.4, -0.7]), 0.7)
  return '峰值来自真实采样极值，可用于「不削顶」推导'
})

check('stemPlacementVolume：6 条分轨叠加 ≤ 整曲峰值，且永不削顶', () => {
  // 按用户工程的实测值：整曲原始峰值≈1.0、整曲推子 0.8；每条 stem 峰值都被引擎拉到≈1.0
  const songPeak = 1.0 * 0.8
  const count = 6
  const vol = stemPlacementVolume({ stemPeak: 1.0, stemCount: count, songPeak })
  const sumPeakUpperBound = count * vol * 1.0 // 相位无关上界
  if (sumPeakUpperBound > 1.0) throw new Error(`叠加上界 ${sumPeakUpperBound} 会削顶（>1.0）`)
  if (sumPeakUpperBound > songPeak + 1e-9) throw new Error(`叠加上界 ${sumPeakUpperBound} 超过整曲 ${songPeak}`)
  if (vol >= 0.8) throw new Error(`音量 ${vol} 未低于旧的 0.8，等于没修`)
  expectEq('量化到 4 位', Math.round(vol * 1e4) / 1e4, Math.round((songPeak / count) * 1e4) / 1e4)
  return `volume=${vol} → 上界 ${sumPeakUpperBound} ≤ 整曲 ${songPeak}`
})

check('stemPlacementVolume：单条满量程分轨不削顶；异常超标的轨被 bySelf 兜住', () => {
  const vol = stemPlacementVolume({ stemPeak: 1.0, stemCount: 1, songPeak: 0.8 })
  expectEq('n=1 音量', Math.round(vol * 1e4) / 1e4, 0.8)
  if (vol * 1.0 > 1.0) throw new Error('单轨仍会削顶')
  /* 说明：正常分轨（引擎峰值归一化后 ≈1.0）由「叠加预算」项先约束，bySelf 项不生效。
     bySelf 只在峰值异常超标时才兜底（例如峰值 3.0 的坏文件），确保单轨自身不削顶。 */
  const runaway = stemPlacementVolume({ stemPeak: 3.0, stemCount: 1, songPeak: 0.8 })
  if (!(runaway * 3.0 <= STEM_SUM_HEADROOM + 1e-9)) {
    throw new Error(`峰值 3.0 的轨音量 ${runaway} 仍让自身削顶（${runaway * 3.0} > ${STEM_SUM_HEADROOM}）`)
  }
  if (!(runaway < vol)) throw new Error(`峰值 3.0 的轨音量 ${runaway} 应小于满量程轨 ${vol}`)
  return `n=1 vol=${vol}；峰值 3.0 的坏轨被压到 ${Math.round(runaway * 1e4) / 1e4}（bySelf 兜底）`
})

check('stemPlacementVolume：空/非法输入不产生 NaN、负数或 >1', () => {
  const cases = [
    { stemPeak: 0, stemCount: 0, songPeak: 0 },
    { stemPeak: -1, stemCount: -3, songPeak: -1 },
    { stemPeak: Number.NaN, stemCount: Number.NaN, songPeak: Number.NaN },
    { stemPeak: Number.POSITIVE_INFINITY, stemCount: 1, songPeak: 1 },
    { stemPeak: 1e-12, stemCount: 5, songPeak: 0.8 },
  ]
  for (const input of cases) {
    const vol = stemPlacementVolume(input)
    if (!Number.isFinite(vol)) throw new Error(`${JSON.stringify(input)} → 非有限值 ${vol}`)
    if (vol < 0) throw new Error(`${JSON.stringify(input)} → 负数 ${vol}`)
    if (vol > 1) throw new Error(`${JSON.stringify(input)} → 超过 1.0 的 ${vol}（应留出让用户推上去的空间）`)
    if (vol < STEM_VOLUME_MIN) throw new Error(`${JSON.stringify(input)} → 低于下限 ${STEM_VOLUME_MIN}`)
  }
  return `${cases.length} 组非法输入全部落在 [${STEM_VOLUME_MIN}, 1]`
})

check('stemPlacementVolume：stemCount 越大音量越低（预算等分单调性）', () => {
  let previous = Number.POSITIVE_INFINITY
  for (const count of [1, 2, 3, 5, 6, 7]) {
    const vol = stemPlacementVolume({ stemPeak: 1.0, stemCount: count, songPeak: 0.8 })
    if (!(vol < previous)) throw new Error(`n=${count} 音量 ${vol} 未随条数下降（上一个是 ${previous}）`)
    previous = vol
  }
  return '1→7 条单调递减'
})

check('stemPlacementVolume：整曲峰值缺失时退回固定余量，仍不削顶', () => {
  const vol = stemPlacementVolume({ stemPeak: 1.0, stemCount: 6, songPeak: 0 })
  const bound = 6 * vol
  if (bound > STEM_SUM_HEADROOM + 1e-9) throw new Error(`无整曲峰值时上界 ${bound} 超过余量 ${STEM_SUM_HEADROOM}`)
  if (bound > 1.0) throw new Error('无整曲峰值时仍会削顶')
  return `volume=${vol}，上界 ${Math.round(bound * 1e4) / 1e4} ≤ ${STEM_SUM_HEADROOM}`
})

check('placeAudioClip：不传 volume 时仍是 0.8（导入/渲染/重绘行为不变）', () => {
  const { placeAudioClip } = audioTrack
  const draft = { tempo: 120, tracks: [], assets: [] }
  const asset = { id: 'asset_x', sha256: '', kind: 'audio', bytes: 0, durationMs: 1000, residency: 'local', createdAt: 0 }
  const placed = placeAudioClip(draft, { asset, durationSec: 30, name: 'x', startBeat: 0 })
  const track = draft.tracks.find((item) => item.id === placed.trackId)
  expectEq('默认 volume', track.volume, 0.8)
  // 显式传 volume 时生效，且被夹到合法范围
  const draft2 = { tempo: 120, tracks: [], assets: [] }
  const p2 = placeAudioClip(draft2, { asset, durationSec: 30, name: 'y', startBeat: 0, volume: 0.1333 })
  expectEq('显式 volume', draft2.tracks.find((item) => item.id === p2.trackId).volume, 0.1333)
  return '缺省 0.8 保持向后兼容，分轨路径可覆写'
})

/* ================================================================== */
/* F. 「忠实渲染 / AI 重编」必须分开：渲染不接受引擎参数，cover 才跑模型   */
/* ================================================================== */

console.log(`\n${C.bold}F. 渲染 vs AI 重编：参数、回执、意图判定${C.reset}`)

const contentCtx = () =>
  toolContext({
    tracks: [{ id: 't1', clips: [{ id: 'c1', notes: [], startBeat: 0, lengthBeats: 4 }], audioClips: [] }],
  })

check('generate_audio：midi_to_audio 拒绝 engine（不再假称用了 XL 引擎）', async () => {
  const result = await runGenerateAudio({ mode: 'midi_to_audio', engine: 'xl' }, contentCtx())
  if (result.ok) throw new Error('渲染模式不该接受 engine')
  if (!/忠实渲染/.test(result.message)) throw new Error(`回执应说明是忠实渲染，实际：${result.message}`)
  if (!/ai_cover/.test(result.message)) throw new Error(`回执应指向 ai_cover，实际：${result.message}`)
  return 'engine 被拒绝，回执指向 ai_cover'
})

check('generate_audio：midi_to_audio 拒绝 quality，回执不再出现「引擎：XL」', async () => {
  const bad = await runGenerateAudio({ mode: 'midi_to_audio', quality: true }, contentCtx())
  if (bad.ok) throw new Error('渲染模式不该接受 quality')
  const good = await runGenerateAudio({ mode: 'midi_to_audio' }, contentCtx())
  if (!good.ok) throw new Error(good.message)
  if (/引擎：/.test(good.message)) throw new Error(`渲染回执仍在暗示 AI 引擎：${good.message}`)
  if (!/忠实/.test(good.message)) throw new Error(`渲染回执应说明忠实渲染：${good.message}`)
  expectEq('engine', good.data?.audioPlan?.engine, undefined)
  expectEq('quality', good.data?.audioPlan?.quality, undefined)
  return 'quality 被拒绝；正常渲染回执不含引擎字样'
})

check('generate_audio：ai_cover 计划带 caption / coverStrength / engine', async () => {
  const result = await runGenerateAudio(
    { mode: 'ai_cover', caption: 'epic orchestral rock with distorted guitars', coverStrength: 0.8, engine: '2b' },
    contentCtx(),
  )
  if (!result.ok) throw new Error(result.message)
  const plan = result.data?.audioPlan
  expectEq('mode', plan?.mode, 'ai_cover')
  expectEq('coverStrength', plan?.coverStrength, 0.8)
  expectEq('engine', plan?.engine, '2b')
  expectEq('durationSec（跟随工程，不写死）', plan?.durationSec, undefined)
  if (!/AI 重编/.test(result.message)) throw new Error(`回执应说明 AI 重编：${result.message}`)
  if (!/不是逐音渲染/.test(result.message)) throw new Error(`回执应提示会改细节：${result.message}`)
  return 'ai_cover 计划完整，回执明确「不是逐音渲染」'
})

check('generate_audio：非 Windows 平台拒绝 XL（不再承诺跑不了的引擎）', async () => {
  if (process.platform === 'win32') return 'Windows：XL 走能力校验，跳过平台拒绝断言'
  const result = await runGenerateAudio(
    { mode: 'ai_cover', caption: 'epic orchestral rock', engine: 'xl' },
    contentCtx(),
  )
  if (result.ok) throw new Error(`非 Windows 平台不该接受 XL：${JSON.stringify(result.data?.audioPlan)}`)
  if (!/Windows/.test(result.message) || !/2b/.test(result.message)) {
    throw new Error(`拒绝原因应说明 XL 仅 Windows 并给出 2b 退路：${result.message}`)
  }
  return 'macOS/Linux 传 xl 被拒绝，回执指向 2b'
})

check('generate_audio：ai_cover 缺 strength 默认 0.7', async () => {
  const result = await runGenerateAudio({ mode: 'ai_cover', caption: 'jazz trio re-orchestration' }, contentCtx())
  if (!result.ok) throw new Error(result.message)
  expectEq('coverStrength', result.data?.audioPlan?.coverStrength, 0.7)
  return '缺省 0.7（与生成面板一致）'
})

check('generate_audio：ai_cover 缺 caption / 带 quality / 要人声 → 明确拒绝', async () => {
  const noCaption = await runGenerateAudio({ mode: 'ai_cover' }, contentCtx())
  if (noCaption.ok) throw new Error('ai_cover 缺 caption 应失败')
  if (!/caption/.test(noCaption.message)) throw new Error(noCaption.message)
  const quality = await runGenerateAudio({ mode: 'ai_cover', caption: 'x', quality: true }, contentCtx())
  if (quality.ok) throw new Error('ai_cover 不该接受 quality')
  const vocal = await runGenerateAudio({ mode: 'ai_cover', caption: 'x', instrumental: false }, contentCtx())
  if (vocal.ok) throw new Error('ai_cover 不该支持人声')
  return 'caption / quality / 人声三种非法组合都被挡住'
})

check('generate_audio：midi_then_audio 已废弃并给出迁移路径', async () => {
  const result = await runGenerateAudio({ mode: 'midi_then_audio' }, contentCtx())
  if (result.ok) throw new Error('midi_then_audio 应被拒绝')
  if (!/ai_cover/.test(result.message) || !/midi_to_audio/.test(result.message)) {
    throw new Error(`回执应同时指向 ai_cover / midi_to_audio：${result.message}`)
  }
  return '旧 mode 被拒绝，回执给出两条正确路径'
})

check('parseAudioPlan：ai_cover 保留 coverStrength 并 clamp 到 0–1', () => {
  const base = parseAudioPlan({ audioPlan: { mode: 'ai_cover', caption: 'x', coverStrength: 1.7 } })
  expectEq('>1 clamp', base?.coverStrength, 1)
  const low = parseAudioPlan({ audioPlan: { mode: 'ai_cover', caption: 'x', coverStrength: -0.2 } })
  expectEq('<0 clamp', low?.coverStrength, 0)
  const garbage = parseAudioPlan({ audioPlan: { mode: 'ai_cover', caption: 'x', coverStrength: 'loud' } })
  expectEq('非法值', garbage?.coverStrength, undefined)
  const okPlan = parseAudioPlan({ audioPlan: { mode: 'ai_cover', caption: 'x', coverStrength: 0.55 } })
  expectEq('正常值', okPlan?.coverStrength, 0.55)
  return 'clamp + 丢弃非法值'
})

check('buildHeuristicAudioPlan：AI 重编说法 → ai_cover，纯渲染 → midi_to_audio', () => {
  const { buildHeuristicAudioPlan } = audioIntent
  const cover1 = buildHeuristicAudioPlan('用 AI 引擎把这个编曲渲染成高品质成品')
  expectEq('用 AI 引擎渲染', cover1?.mode, 'ai_cover')
  const cover2 = buildHeuristicAudioPlan('别只是把 MIDI 转成音频，用 AI 重编成摇滚版')
  expectEq('AI 重编', cover2?.mode, 'ai_cover')
  const render = buildHeuristicAudioPlan('把当前编曲渲染成音频')
  expectEq('纯渲染', render?.mode, 'midi_to_audio')
  const render2 = buildHeuristicAudioPlan('把这段 MIDI 导出成 wav')
  expectEq('导出 wav', render2?.mode, 'midi_to_audio')
  return 'AI 说法走 cover，导出说法仍走渲染'
})

check('detectAudioIntent：AI 重编 / 换编制 也算音频意图', () => {
  const { detectAudioIntent } = audioIntent
  for (const text of ['用 AI 重编这版编曲', '帮我换编制，做成摇滚版', '重新配器一下', '让 AI 发挥一下']) {
    if (!detectAudioIntent(text)) throw new Error(`应识别为音频意图：${text}`)
  }
  if (detectAudioIntent('把和弦改成 C-G-Am-F')) throw new Error('编曲请求不该被识别为音频')
  return '4 条 AI 重编说法命中，和声编辑不误判'
})

/* ================================================================== */
/* G. 源音频 → 引擎：24-bit 必须转 16-bit（cover / repaint / stem 共用）   */
/* ================================================================== */

console.log(`\n${C.bold}G. 源音频解码：引擎只认 16-bit（修复 400 failed to decode audio）${C.reset}`)

/** 构造最小 WAV（单声道，便于逐采样断言） */
function makeWav({ format = 1, bits = 16, sampleRate = 8000, samples }) {
  const bytesPer = bits / 8
  const dataSize = samples.length * bytesPer
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(format, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * bytesPer, 28)
  buffer.writeUInt16LE(bytesPer, 32)
  buffer.writeUInt16LE(bits, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)
  samples.forEach((value, index) => {
    const at = 44 + index * bytesPer
    if (format === 3) {
      if (bits === 32) buffer.writeFloatLE(value, at)
      else buffer.writeDoubleLE(value, at)
    } else if (bits === 8) buffer.writeUInt8(value, at)
    else if (bits === 16) buffer.writeInt16LE(value, at)
    else if (bits === 24) buffer.writeIntLE(value, at, 3)
    else buffer.writeInt32LE(value, at)
  })
  return buffer
}

check('toEngineDecodableWav：24-bit PCM → 16-bit，采样率/声道/时长不变', () => {
  const src = makeWav({ bits: 24, samples: [0x400000, -0x400000, 0x7fffff] })
  const out = toEngineDecodableWav(src)
  const info = readWavInfo(out)
  expectEq('format', info.audioFormat, 1)
  expectEq('bits', info.bitsPerSample, 16)
  expectEq('channels', info.channels, 1)
  expectEq('sampleRate', info.sampleRate, 8000)
  expectEq('duration', Number(info.durationSec.toFixed(6)), 3 / 8000)
  expectEq('+0.5', out.readInt16LE(44), 16384)
  expectEq('-0.5', out.readInt16LE(46), -16384)
  expectEq('full scale', out.readInt16LE(48), 32767)
  return '24-bit 0x400000 → 16384，时长保持'
})

check('toEngineDecodableWav：canonical 16-bit 原样返回（逐字节不变）', () => {
  const src = makeWav({ bits: 16, samples: [1234, -4321] })
  if (toEngineDecodableWav(src) !== src) throw new Error('16-bit 不该被重编码')
  return '返回同一 Buffer'
})

check('toEngineDecodableWav：float32 → 16-bit', () => {
  const src = makeWav({ format: 3, bits: 32, samples: [0.25, -0.5] })
  const out = toEngineDecodableWav(src)
  expectEq('bits', readWavInfo(out).bitsPerSample, 16)
  expectEq('+0.25', out.readInt16LE(44), 8192)
  expectEq('-0.5', out.readInt16LE(46), -16384)
  return 'float 归一化到 int16'
})

check('toEngineDecodableWav：32-bit PCM / 8-bit PCM 也能转', () => {
  const pcm32 = toEngineDecodableWav(makeWav({ bits: 32, samples: [0x40000000, -0x40000000] }))
  expectEq('32-bit +0.5', pcm32.readInt16LE(44), 16384)
  expectEq('32-bit -0.5', pcm32.readInt16LE(46), -16384)
  const pcm8 = toEngineDecodableWav(makeWav({ bits: 8, samples: [192, 64] }))
  expectEq('8-bit +0.5', pcm8.readInt16LE(44), 16384)
  expectEq('8-bit -0.5', pcm8.readInt16LE(46), -16384)
  return '32-bit / 8-bit 均落到 16-bit'
})

check('toEngineDecodableWav：不支持的编码给出明确中文错误', () => {
  // 用 ADPCM（format=2）伪装一个 16-bit WAV：位深合法但编码不支持
  const bad = makeWav({ bits: 16, samples: [0, 0] })
  bad.writeUInt16LE(2, 20)
  let message = ''
  try {
    toEngineDecodableWav(bad)
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  if (!/不支持的 WAV 编码/.test(message)) throw new Error(`应报「不支持的 WAV 编码」，实际：${message}`)
  return message
})

/* ------------------------------------------------------------------ */

console.log('')
if (failed === 0) {
  console.log(`${C.green}${C.bold}✓ 生成参数链路回归全部通过${C.reset}  ${passed}/${passed + failed}\n`)
  process.exit(0)
}
console.log(`${C.red}${C.bold}✗ ${failed} 项失败${C.reset}  ${passed}/${passed + failed} 通过\n`)
for (const item of failures) console.log(`  ${C.red}•${C.reset} ${item.name}: ${C.dim}${item.message}${C.reset}`)
console.log('')
process.exit(1)
