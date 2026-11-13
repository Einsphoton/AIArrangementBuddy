#!/usr/bin/env node
/**
 * 冒烟测试：启动一个临时后端，把关键接口跑一遍。
 *
 *   node scripts/test.mjs           # 全量
 *   node scripts/test.mjs --keep    # 跑完不关服务（调试用）
 *   node scripts/test.mjs --unit-only # 只跑纯逻辑单测（不起服务、不起浏览器）
 *
 * 不依赖任何测试框架，输出彩色 ✓ / ✗。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { IS_WINDOWS, spawnBin } from './lib/spawn-bin.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.AIAB_TEST_PORT || 8899)
const BASE = `http://127.0.0.1:${PORT}`
const unitOnly = process.argv.includes('--unit-only')

/* ------------------------------------------------------------------ */
/* 进程内 TS 加载器                                                    */
/*                                                                     */
/* 打卡点的纯逻辑（lib/trackRules.ts）是 TS，为了让单测直接跑真实源码、   */
/* 而不是复制一份逻辑，这里用 typescript 现场转译（与 verify-downloads.mjs */
/* 同样的做法，不依赖 tsx / 子进程）。                                    */
/* ------------------------------------------------------------------ */

process.on('warning', (warning) => {
  if (warning?.name === 'ExperimentalWarning') return
  console.warn(warning?.stack ?? String(warning))
})

function installTsLoader() {
  const require = createRequire(import.meta.url)
  const ts = require('typescript')
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
        const base = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : process.cwd()
        const candidate = path.resolve(base, `${specifier.slice(0, -3)}.ts`)
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true }
        }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url.endsWith('.ts')) {
        const file = fileURLToPath(url)
        const source = readFileSync(file, 'utf8')
        const output = ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          fileName: file,
        }).outputText
        return { format: 'module', source: output, shortCircuit: true }
      }
      return nextLoad(url, context)
    },
  })
}
const keep = process.argv.includes('--keep')
const dataDir = mkdtempSync(path.join(tmpdir(), 'aiab-test-'))

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  gold: '\x1b[33m',
  bold: '\x1b[1m',
}

let passed = 0
let failed = 0
const failures = []

function ok(name, detail = '') {
  passed++
  console.log(`  ${c.green}✓${c.reset} ${name}${detail ? c.dim + '  ' + detail + c.reset : ''}`)
}

function bad(name, error) {
  failed++
  const message = error instanceof Error ? error.message : String(error)
  failures.push({ name, message })
  console.log(`  ${c.red}✗${c.reset} ${name}${c.dim}  ${message}${c.reset}`)
}

async function check(name, fn) {
  try {
    const detail = await fn()
    ok(name, typeof detail === 'string' ? detail : '')
  } catch (error) {
    bad(name, error)
  }
}

/* ------------------------------------------------------------------ */
/* 测试用的最小工程                                                     */
/* ------------------------------------------------------------------ */

function fixtureProject() {
  const now = Date.now()
  return {
    id: 'p_test1234',
    name: '冒烟测试工程',
    version: 1,
    tempo: 112,
    timeSignature: { numerator: 4, denominator: 4 },
    key: 'C',
    scale: 'major',
    swing: 0,
    masterVolume: 0.9,
    tracks: [
      {
        id: 't_1',
        name: '钢琴',
        color: '#f0b429',
        kind: 'instrument',
        instrumentId: 'piano.grand',
        emotionId: 'warm',
        gmProgram: 0,
        engine: 'auto',
        volume: 0.8,
        pan: 0,
        mute: false,
        solo: false,
        reverbSend: 0.2,
        delaySend: 0.05,
        octaveShift: 0,
        clips: [
          {
            id: 'c_1',
            trackId: 't_1',
            name: '钢琴',
            startBeat: 0,
            lengthBeats: 16,
            muted: false,
            notes: [
              { id: 'n_1', pitch: 60, start: 0, duration: 1, velocity: 96 },
              { id: 'n_2', pitch: 64, start: 1, duration: 1, velocity: 88 },
              { id: 'n_3', pitch: 67, start: 2, duration: 1, velocity: 92 },
            ],
          },
        ],
      },
    ],
    sections: [{ id: 's_1', name: '主歌', startBar: 0, bars: 4, energy: 0.5 }],
    chords: [{ root: 0, quality: 'maj', beats: 4 }],
    loop: { enabled: false, startBeat: 0, endBeat: 16 },
    createdAt: now,
    updatedAt: now,
  }
}

/* ------------------------------------------------------------------ */
/* 纯逻辑单测：静音 / 独奏判定 + 录入目标解析                            */
/*                                                                     */
/* 被测代码是 apps/web/src/lib/trackRules.ts —— 引擎与界面共用同一份实现， */
/* 所以这些断言覆盖的是真实运行逻辑，不是测试里另写一份。                  */
/* ------------------------------------------------------------------ */

let trackRules = null

async function loadTrackRules() {
  if (trackRules) return trackRules
  installTsLoader()
  trackRules = await import('../apps/web/src/lib/trackRules.ts')
  return trackRules
}

const sameSet = (actual, expected) => {
  const list = [...actual].sort()
  const want = [...expected].sort()
  return list.length === want.length && list.every((value, index) => value === want[index])
}

async function runUnitTests() {
  console.log(`${c.gold}${c.bold}纯逻辑：静音 / 独奏 / 录入预备${c.reset}`)

  const rules = await loadTrackRules().catch((error) => {
    bad('加载 lib/trackRules.ts', error)
    return null
  })
  if (!rules) return
  const { computeAudibleTrackIds, resolveRecordTrackId, resolveRecordClipId } = rules

  await check('可听：普通工程 = 全部未静音轨道', () => {
    const ids = computeAudibleTrackIds([
      { id: 'a', mute: false, solo: false },
      { id: 'b', mute: false, solo: false },
    ])
    if (!sameSet(ids, ['a', 'b'])) throw new Error(`实际 ${[...ids].join(',')}`)
    return [...ids].join(',')
  })

  await check('可听：静音轨被排除，其余照常', () => {
    const ids = computeAudibleTrackIds([
      { id: 'a', mute: true, solo: false },
      { id: 'b', mute: false, solo: false },
    ])
    if (!sameSet(ids, ['b'])) throw new Error(`实际 ${[...ids].join(',')}`)
    return 'mute 生效'
  })

  await check('可听：独奏压过非独奏（solo beats non-solo）', () => {
    const ids = computeAudibleTrackIds([
      { id: 'a', mute: false, solo: true },
      { id: 'b', mute: false, solo: false },
      { id: 'c', mute: false, solo: false },
    ])
    if (!sameSet(ids, ['a'])) throw new Error(`实际 ${[...ids].join(',')}`)
    return '只有 a 出声'
  })

  await check('可听：静音压过独奏（mute beats solo）', () => {
    const ids = computeAudibleTrackIds([
      { id: 'a', mute: true, solo: true },
      { id: 'b', mute: false, solo: false },
    ])
    if (ids.size !== 0) throw new Error(`应全静音，实际 ${[...ids].join(',')}`)
    return '全部静音'
  })

  await check('可听：多条轨道同时独奏都出声', () => {
    const ids = computeAudibleTrackIds([
      { id: 'a', mute: false, solo: true },
      { id: 'b', mute: false, solo: true },
      { id: 'c', mute: false, solo: false },
    ])
    if (!sameSet(ids, ['a', 'b'])) throw new Error(`实际 ${[...ids].join(',')}`)
    return 'a+b'
  })

  await check('可听：空工程返回空集合（不抛异常）', () => {
    const ids = computeAudibleTrackIds([])
    if (ids.size !== 0) throw new Error('应为空')
    return '空'
  })

  /* ---------------- 录入目标解析 ---------------- */

  const tracks = [{ id: 't1' }, { id: 't2' }, { id: 't3' }]

  await check('录入目标：预备优先于聚焦 / 选中', () => {
    const id = resolveRecordTrackId({ armedTrackId: 't1', focusedTrackId: 't2', selectedTrackId: 't2' }, tracks)
    if (id !== 't1') throw new Error(`实际 ${id}`)
    return 'armed 生效'
  })

  await check('录入目标：没有预备时回落到聚焦轨道', () => {
    const id = resolveRecordTrackId({ armedTrackId: null, focusedTrackId: 't2', selectedTrackId: 't3' }, tracks)
    if (id !== 't2') throw new Error(`实际 ${id}`)
    return 'focused 生效'
  })

  await check('录入目标：焦点缺失时回落到选中轨道', () => {
    const id = resolveRecordTrackId({ armedTrackId: null, focusedTrackId: '', selectedTrackId: 't3' }, tracks)
    if (id !== 't3') throw new Error(`实际 ${id}`)
    return 'selected 生效'
  })

  await check('录入目标：已删除的轨道 id 不会指到不存在的轨道', () => {
    const id = resolveRecordTrackId({ armedTrackId: 'gone', focusedTrackId: 't2', selectedTrackId: null }, tracks)
    if (id !== 't2') throw new Error(`实际 ${id}`)
    return '跳过失效 id'
  })

  await check('录入目标：全空返回 null', () => {
    const id = resolveRecordTrackId({ armedTrackId: null, focusedTrackId: null, selectedTrackId: null }, tracks)
    if (id !== null) throw new Error(`实际 ${id}`)
    return 'null'
  })

  await check('录入片段：已选片段属于目标轨时沿用它', () => {
    const id = resolveRecordClipId({ clips: [{ id: 'c1' }, { id: 'c2' }] }, 'c2')
    if (id !== 'c2') throw new Error(`实际 ${id}`)
    return 'c2'
  })

  await check('录入片段：没选片段时退到第一个未静音片段', () => {
    const id = resolveRecordClipId({ clips: [{ id: 'c1', muted: true }, { id: 'c2' }] }, null)
    if (id !== 'c2') throw new Error(`实际 ${id}`)
    return 'c2'
  })

  await check('录入片段：选中片段属于别的轨时不硬套', () => {
    const id = resolveRecordClipId({ clips: [{ id: 'c1' }] }, 'other-track-clip')
    if (id !== 'c1') throw new Error(`实际 ${id}`)
    return 'c1'
  })

  await check('录入片段：轨道没有可用片段返回 null（界面据此提示）', () => {
    if (resolveRecordClipId({ clips: [] }, null) !== null) throw new Error('应为 null')
    if (resolveRecordClipId({ clips: [{ id: 'c1', muted: true }] }, null) !== null) throw new Error('全静音应为 null')
    if (resolveRecordClipId(null, 'c1') !== null) throw new Error('无轨道应为 null')
    return 'null'
  })

  /* 音频轨的可听语义与 MIDI 轨完全一致（同一个函数，无需另写一套） */
  await check('可听：音频轨与 MIDI 轨共用同一套静音 / 独奏语义', () => {
    const ids = computeAudibleTrackIds([
      { id: 'audio1', mute: false, solo: false },
      { id: 'midi1', mute: false, solo: true },
    ])
    if (!sameSet(ids, ['midi1'])) throw new Error(`实际 ${[...ids].join(',')}`)
    return '一致'
  })

  /* ---------------- 三态混音状态（显式静音 vs 被独奏压住） ---------------- */

  const { trackAudibility, computeAudibilityMap, summarizeMix } = rules

  await check('三态：无独奏时只有「静音 / 正常」两态', () => {
    if (trackAudibility({ id: 'a', mute: false }, false) !== 'audible') throw new Error('a 应为可听')
    if (trackAudibility({ id: 'b', mute: true }, false) !== 'muted') throw new Error('b 应为静音')
    return 'audible / muted'
  })

  await check('三态：别的轨道独奏时，未独奏的轨是「被压住」而不是「静音」', () => {
    if (trackAudibility({ id: 'b', mute: false }, true) !== 'implicitly-muted') {
      throw new Error('被 solo 压住的轨不该被判成 muted（否则会误亮 M 灯）')
    }
    return 'implicitly-muted'
  })

  await check('三态：静音优先于独奏（静音 + 被压住 → 仍算 muted）', () => {
    if (trackAudibility({ id: 'b', mute: true }, true) !== 'muted') throw new Error('应为 muted')
    return 'mute 优先'
  })

  await check('三态：audibilityMap 与 computeAudibleTrackIds 结论一致', () => {
    const tracks = [
      { id: 'a', mute: false, solo: true },
      { id: 'b', mute: false, solo: false },
      { id: 'c', mute: true, solo: false },
      { id: 'd', mute: true, solo: true },
    ]
    const map = computeAudibilityMap(tracks)
    const audible = computeAudibleTrackIds(tracks)
    if (map.get('a') !== 'audible' || map.get('b') !== 'implicitly-muted') throw new Error('a/b 状态错')
    if (map.get('c') !== 'muted' || map.get('d') !== 'muted') throw new Error('c/d 状态错')
    if (!sameSet(audible, ['a'])) throw new Error(`可听集应为 a，实际 ${[...audible].join(',')}`)
    return '一致'
  })

  await check('汇总：静音数 / 独奏数 / 是否有独奏', () => {
    const summary = summarizeMix([
      { id: 'a', mute: true, solo: false },
      { id: 'b', mute: false, solo: true },
      { id: 'c', mute: false, solo: true },
      { id: 'd' },
    ])
    if (summary.mutedCount !== 1 || summary.soloCount !== 2 || !summary.anySolo) {
      throw new Error(`实际 ${JSON.stringify(summary)}`)
    }
    if (summarizeMix([]).anySolo) throw new Error('空工程不应有独奏')
    return `M${summary.mutedCount} S${summary.soloCount}`
  })

  /* ---------------- 总控批量补丁（关键：solo 绝不写回 mute） ---------------- */

  const { soloTogglePatch, clearSoloPatch, muteAllPatch, nextMuteAllValue } = rules

  await check('总控：按 S 只改 solo，绝不把别人的 mute 写回工程', () => {
    const tracks = [
      { id: 'a', mute: false, solo: false },
      { id: 'b', mute: true, solo: false },
      { id: 'c', mute: false, solo: false },
    ]
    const patches = soloTogglePatch(tracks, 'a')
    if (patches.length !== 1) throw new Error(`补丁数应为 1，实际 ${patches.length}`)
    if (patches[0].id !== 'a' || patches[0].solo !== true) throw new Error('应只切 a 的 solo')
    if (patches.some((patch) => 'mute' in patch && patch.mute !== undefined)) {
      throw new Error('点 S 不能附带写 mute（否则取消独奏后静音状态就乱了）')
    }
    return '只切 solo'
  })

  await check('总控：Alt 独占独奏 = 只留这条独奏，其它全清', () => {
    const tracks = [
      { id: 'a', mute: false, solo: true },
      { id: 'b', mute: false, solo: true },
      { id: 'c', mute: true, solo: false },
    ]
    const patches = soloTogglePatch(tracks, 'a', { exclusive: true })
    /* 补丁只包含「需要改的轨道」：把补丁应用回夹具，检查最终独奏集合 */
    const applied = tracks.map((track) => {
      const patch = patches.find((item) => item.id === track.id)
      return { ...track, solo: patch?.solo ?? track.solo, mute: patch?.mute ?? track.mute }
    })
    const soloed = applied.filter((track) => track.solo).map((track) => track.id)
    if (!sameSet(soloed, ['a'])) throw new Error(`应只剩 a 独奏，实际 ${soloed.join(',') || '无'}`)
    if (patches.some((patch) => patch.mute !== undefined)) throw new Error('独占独奏不应动 mute')
    /* c 的 mute 必须保持原样（补丁里不出现在 mute 通道上） */
    const c = applied.find((track) => track.id === 'c')
    if (!c.mute) throw new Error('独占独奏不应改动别的轨的静音状态')
    return '只剩 a'
  })

  await check('总控：Alt 独占点击「唯一在独奏的轨」= 退出独奏（Logic 语义）', () => {
    const tracks = [
      { id: 'a', mute: false, solo: true },
      { id: 'b', mute: false, solo: false },
    ]
    const patches = soloTogglePatch(tracks, 'a', { exclusive: true })
    if (patches.some((patch) => patch.solo === true)) throw new Error('不该再点亮任何 solo')
    return '全部退出'
  })

  await check('总控：清空独奏只产生 solo=false 补丁', () => {
    const tracks = [
      { id: 'a', mute: true, solo: true },
      { id: 'b', mute: false, solo: false },
      { id: 'c', mute: false, solo: true },
    ]
    const patches = clearSoloPatch(tracks)
    if (!sameSet(patches.map((patch) => patch.id), ['a', 'c'])) throw new Error('应清 a 与 c')
    if (patches.some((patch) => patch.solo !== false)) throw new Error('必须是 solo=false')
    if (patches.some((patch) => patch.mute !== undefined)) throw new Error('清空独奏不该动 mute')
    return 'a,c'
  })

  await check('总控：全部静音只补丁需要变的轨（幂等）', () => {
    const tracks = [
      { id: 'a', mute: true },
      { id: 'b', mute: false },
      { id: 'c', mute: false },
    ]
    const patches = muteAllPatch(tracks, true)
    if (!sameSet(patches.map((patch) => patch.id), ['b', 'c'])) throw new Error('a 已静音不该再进补丁')
    if (muteAllPatch(tracks, true).some((patch) => patch.mute !== true)) throw new Error('目标应为 true')
    if (muteAllPatch([{ id: 'a', mute: true }], false).length !== 1) throw new Error('取消静音应包含 a')
    return '幂等'
  })

  await check('总控：M 点击语义 = 全静音状态取反', () => {
    if (nextMuteAllValue([]) !== true) throw new Error('空工程点 M 应为「要静音」')
    if (nextMuteAllValue([{ id: 'a', mute: false }]) !== true) throw new Error('无静音时应全静音')
    if (nextMuteAllValue([{ id: 'a', mute: true }]) !== false) throw new Error('已有静音时应取消')
    return '取反'
  })

  await check('总控：独奏不会让「可听集」出现幽灵轨（只受 mute/solo 影响）', () => {
    const tracks = [
      { id: 'a', mute: false, solo: true },
      { id: 'b', mute: false, solo: false },
    ]
    const before = computeAudibleTrackIds(tracks)
    if (!sameSet(before, ['a'])) throw new Error('solo 时应只有 a 可听')
    /* 模拟「退出独奏」：b 的 mute 从头到尾没被改过 */
    const after = computeAudibleTrackIds(tracks.map((track) => ({ ...track, solo: false })))
    if (!sameSet(after, ['a', 'b'])) throw new Error('退出独奏后应全部恢复')
    return '可逆'
  })

  /* ---------------- 引擎接线不变量（源码级，防回归） ---------------- */

  await check('引擎：可听判定来自共享纯函数，没有第二份内联实现', () => {
    const source = readFileSync(path.join(root, 'apps/web/src/audio/engine.ts'), 'utf8')
    if (!source.includes('computeAudibleTrackIds(project.tracks)')) {
      throw new Error('engine.ts 没有使用 computeAudibleTrackIds')
    }
    /* 旧的「内联 anySolo 循环」若回来，两处语义迟早分叉 */
    if (/const\s+anySolo\s*=/.test(source)) throw new Error('engine.ts 仍残留内联 anySolo 判定')
    return '单一真相'
  })

  await check('引擎：静音走 muteGain（不是会和 volume ramp 打架的 channel.mute）', () => {
    const source = readFileSync(path.join(root, 'apps/web/src/audio/engine.ts'), 'utf8')
    if (!/node\.muteGain\.gain\.rampTo\(\s*audible\s*\?\s*1\s*:\s*0/.test(source)) {
      throw new Error('applyMix 里没有 muteGain 的可听性写入')
    }
    /* 若重新出现 `channel.mute = !audible`，M/S 又会静音失效 */
    if (/node\.channel\.mute\s*=\s*!audible/.test(source)) {
      throw new Error('仍在使用 channel.mute 做静音（会被 volume ramp 撤销）')
    }
    /* muteGain 必须在 applyMix 里被驱动前就建好并被释放 */
    if (!source.includes('muteGain,')) throw new Error('TrackNode 未登记 muteGain')
    return 'muteGain 生效'
  })

  await check('引擎：静音时 send 也归零（合成器 voice 直连 send，会绕过 muteGain）', () => {
    const source = readFileSync(path.join(root, 'apps/web/src/audio/engine.ts'), 'utf8')
    /* attachVoice 把 voice 前置直连 send：只关 muteGain 会从混响 / 延迟里漏音 */
    const attach = source.match(/const attachVoice =[\s\S]*?\n  \}/)
    if (!attach) throw new Error('找不到 attachVoice')
    const directSends = /voice\.output\.connect\(node\.send(Reverb|Delay|Chorus)\)/.test(attach[0])
    if (!directSends) return 'voice 已不走前置 send（无需额外处理）'
    for (const bus of ['sendReverb', 'sendDelay', 'sendChorus']) {
      const guarded = new RegExp(`node\\.${bus}\\.gain\\.rampTo\\(\\s*audible\\s*\\?`)
      if (!guarded.test(source)) throw new Error(`${bus} 没有跟随可听性归零，静音轨会漏尾巴`)
    }
    return 'send 随可听性归零'
  })

  await check('引擎：音符索引不再按轨道可听性删音符（取消静音才能立刻恢复）', () => {
    const source = readFileSync(path.join(root, 'apps/web/src/audio/engine.ts'), 'utf8')
    const fn = source.match(/const rebuildNoteIndex =[\s\S]*?\n  \}/)
    if (!fn) throw new Error('找不到 rebuildNoteIndex')
    if (/audibleIds|audible\.has/.test(fn[0])) {
      throw new Error('rebuildNoteIndex 仍在按可听性过滤音符')
    }
    if (!fn[0].includes('clip.muted')) throw new Error('片段静音不能被一起丢掉')
    return '只滤片段静音'
  })

  await check('引擎：播放中热更新不会把已排期的 look-ahead 音重复排一次', () => {
    const source = readFileSync(path.join(root, 'apps/web/src/audio/engine.ts'), 'utf8')
    if (/scheduler\.scheduledPosition = pos(?!\s*,)/.test(source.replace(/scheduler\.scheduledPosition = Math\.max\(pos, scheduler\.scheduledPosition\)/g, ''))) {
      throw new Error('scheduledPosition 被无条件回拨，会导致重音')
    }
    if (!source.includes('scheduler.scheduledPosition = Math.max(pos, scheduler.scheduledPosition)')) {
      throw new Error('缺少「只向前补排」的保护')
    }
    return '不回拨'
  })

  await check('接线：录入路径优先 armedTrackId（R 不再只点亮红点）', () => {
    const source = readFileSync(path.join(root, 'apps/web/src/features/midi/useMidiPerformance.ts'), 'utf8')
    if (!source.includes('resolveRecordTrackId')) throw new Error('录入路径没有用共享解析')
    if (/t\.id === state\.focusedTrackId\)/.test(source)) {
      throw new Error('录入路径又退回只看 focusedTrackId')
    }
    if (!source.includes('armedTrackId: useUiStore.getState().armedTrackId')) {
      throw new Error('录入路径没有把 armedTrackId 传进解析')
    }
    return 'armed 优先'
  })

  await check('接线：走带条 / 状态栏与录入路径共用同一套目标解析', () => {
    const transport = readFileSync(path.join(root, 'apps/web/src/features/transport/TransportBar.tsx'), 'utf8')
    const status = readFileSync(path.join(root, 'apps/web/src/features/status/StatusBar.tsx'), 'utf8')
    if (!transport.includes('resolveRecordTrackId')) throw new Error('TransportBar 没有用共享解析')
    if (!status.includes('resolveRecordTrackId')) throw new Error('StatusBar 没有用共享解析')
    if (!status.includes('resolveRecordClipId')) throw new Error('StatusBar 没有判断可录片段')
    return '三处一致'
  })

  await check('接线：R 按钮预备时同步焦点，且不再只写 armedTrackId', () => {
    const trackRow = readFileSync(path.join(root, 'apps/web/src/features/tracks/TrackRow.tsx'), 'utf8')
    if (!trackRow.includes('setArmedTrackId(next)')) throw new Error('R 按钮没写 armedTrackId')
    if (!trackRow.includes('focusTrack(next)')) {
      throw new Error('R 按钮没有同步焦点（钢琴卷帘会仍停在别的轨道）')
    }
    /* 预备了却录不进去必须如实提示，不能只点亮红点 */
    if (!trackRow.includes('pushToast')) throw new Error('R 按钮缺少「录不进去」的提示')
    return '同步 + 提示'
  })

  /* ---------------- 总控按钮 / 三态渲染（源码级不变量，防回归） ---------------- */

  await check('接线：存在常驻总控 M/S/R（轨道列表 + 混音器都用同一组件）', () => {
    const panel = readFileSync(path.join(root, 'apps/web/src/features/tracks/TrackPanel.tsx'), 'utf8')
    const mixer = readFileSync(path.join(root, 'apps/web/src/features/tracks/MixerPanel.tsx'), 'utf8')
    if (!panel.includes('MixMasterControls')) throw new Error('轨道列表没有挂总控按钮')
    if (!mixer.includes('MixMasterControls')) throw new Error('混音器没有挂总控按钮')
    const master = readFileSync(path.join(root, 'apps/web/src/features/tracks/MixMasterControls.tsx'), 'utf8')
    for (const action of ['toggleMuteAll', 'clearAllSolos', 'setArmedTrackId']) {
      if (!master.includes(action)) throw new Error(`总控缺少 ${action}`)
    }
    return '两处共用'
  })

  await check('接线：总控 S 显示独奏数量（只有颜色不够，深色主题会漏看）', () => {
    const master = readFileSync(path.join(root, 'apps/web/src/features/tracks/MixMasterControls.tsx'), 'utf8')
    if (!/count=\{[^}]*soloCount\}/.test(master)) throw new Error('总控 S 不是用 soloCount 驱动的')
    if (!master.includes('data-count=')) throw new Error('总控按钮缺少数量的 data 属性（自动化无法断言）')
    return '带数量'
  })

  await check('接线：轨道头 M/S 区分「显式静音」与「被独奏压住」', () => {
    const trackRow = readFileSync(path.join(root, 'apps/web/src/features/tracks/TrackRow.tsx'), 'utf8')
    if (!trackRow.includes('trackAudibility')) throw new Error('轨道头没有用共享三态判定')
    if (!trackRow.includes('data-implicit-mute')) throw new Error('缺少派生静音的标记（M 灯会误亮）')
    if (!trackRow.includes('data-track-solo')) throw new Error('缺少独奏状态标记')
    if (!trackRow.includes('armedButMuted')) throw new Error('缺少 armed+muted 的组合警告')
    return '三态 + 警告'
  })

  await check('接线：S 按钮支持 Alt 独占独奏，且语义写在 tooltip 里', () => {
    const trackRow = readFileSync(path.join(root, 'apps/web/src/features/tracks/TrackRow.tsx'), 'utf8')
    if (!trackRow.includes('exclusive: event.altKey')) throw new Error('轨道头 S 没有接 Alt 独占')
    if (!trackRow.includes('Alt/Option')) throw new Error('tooltip 没写清修饰键语义（跨 DAW 不统一，必须说明）')
    const mixer = readFileSync(path.join(root, 'apps/web/src/features/tracks/MixerPanel.tsx'), 'utf8')
    if (!mixer.includes('exclusive: event.altKey')) throw new Error('混音器 S 与轨道头语义不一致')
    return '轨道头 + 混音器一致'
  })

  await check('接线：编曲车道按三态变暗（solo 不能只在混音器可见）', () => {
    const view = readFileSync(path.join(root, 'apps/web/src/features/arrangement/ArrangementView.tsx'), 'utf8')
    if (!view.includes('computeAudibilityMap')) throw new Error('编曲视图没算三态')
    /* 显式静音与被压住必须给不同强度的视觉（同一个 opacity 用户还是分不清） */
    if (!/mixState === 'muted' && 'opacity-/.test(view)) throw new Error('显式静音的车道没有变暗')
    if (!/mixState === 'implicitly-muted' && 'opacity-/.test(view)) {
      throw new Error('被独奏压住的车道没有变暗（solo 状态只在混音器可见）')
    }
    if (!view.includes('data-mix-state={mixState}')) throw new Error('车道没有暴露 data-mix-state')
    return '编曲车道也有反馈'
  })

  await check('接线：状态栏常驻静音 / 独奏计数并可一键清空', () => {
    const status = readFileSync(path.join(root, 'apps/web/src/features/status/StatusBar.tsx'), 'utf8')
    if (!status.includes('summarizeMix')) throw new Error('状态栏没有混音汇总')
    if (!status.includes('data-status-solo-count')) throw new Error('缺少独奏计数的 data 属性')
    if (!status.includes('clearAllSolos')) throw new Error('状态栏不能一键清空独奏')
    return '常驻计数'
  })

  await check('接线：节拍器改用 C（M 已让给轨道静音，避免误触）', () => {
    const commands = readFileSync(path.join(root, 'apps/web/src/lib/commands.ts'), 'utf8')
    const block = (id) => {
      const start = commands.indexOf(`id: '${id}'`)
      if (start < 0) return ''
      return commands.slice(start, start + 900)
    }
    if (!/keys: 'c'/.test(block('transport.metronome'))) throw new Error('节拍器没有改用 C 键')
    if (!/keys: 'm'/.test(block('track.mute'))) throw new Error('静音命令没有占用 M 键')
    if (!/keys: 's'/.test(block('track.solo'))) throw new Error('独奏命令没有占用 S 键')
    if (/keys: 'm'/.test(block('transport.metronome'))) throw new Error('节拍器仍占用 M 键')
    const shortcuts = readFileSync(path.join(root, 'apps/web/src/hooks/useGlobalShortcuts.ts'), 'utf8')
    if (!shortcuts.includes("combo: 'm', commandId: 'track.mute'")) throw new Error('全局快捷键没绑 M→静音')
    if (!shortcuts.includes("combo: 's', commandId: 'track.solo'")) throw new Error('全局快捷键没绑 S→独奏')
    if (!shortcuts.includes("combo: 'c', commandId: 'transport.metronome'")) throw new Error('全局快捷键没绑 C→节拍器')
    return 'M/S/C'
  })

  await check('store：M/S 写入统一走 applyFlagPatches（一条撤销 + 标脏）', () => {
    const storeSource = readFileSync(path.join(root, 'apps/web/src/store/store.ts'), 'utf8')
    if (!storeSource.includes('function applyFlagPatches')) throw new Error('缺少统一写入路径')
    /* M/S 必须标脏，否则静音 / 独奏不会被自动保存（历史 bug） */
    if (!/applyFlagPatches[\s\S]{0,600}setSaveStatus\('dirty'\)/.test(storeSource)) {
      throw new Error('applyFlagPatches 没有标脏')
    }
    if (!storeSource.includes('toggleMuteAll') || !storeSource.includes('clearAllSolos')) {
      throw new Error('store 缺少总控 action')
    }
    return '一条撤销 + 标脏'
  })

  await check('接线：删除轨道后不会留下「幽灵录入预备」', () => {
    const panel = readFileSync(path.join(root, 'apps/web/src/features/tracks/TrackPanel.tsx'), 'utf8')
    if (!/armedTrackId[\s\S]{0,400}setArmedTrackId\(null\)/.test(panel)) {
      throw new Error('TrackPanel 没有对账 armedTrackId（删轨后会留下幽灵 arm，总控 R 报错）')
    }
    return '自动对账'
  })

  console.log('')
}

/* ------------------------------------------------------------------ */
/* 启动服务                                                            */
/* ------------------------------------------------------------------ */

async function waitForHealth(timeoutMs = 60000) {
  const started = Date.now()
  let lastError = 'timeout'
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${BASE}/api/health`)
      if (response.ok) return await response.json()
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error.message
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error(`服务未在 ${timeoutMs}ms 内就绪：${lastError}`)
}

async function main() {
  console.log(`\n${c.gold}${c.bold}AI 编曲伴侣 · 冒烟测试${c.reset}`)
  console.log(`${c.dim}数据目录 ${dataDir}${c.reset}\n`)

  /* ---------------- 纯逻辑单测（不需要服务） ---------------- */
  await runUnitTests()

  if (unitOnly) {
    reportAndExit()
    return
  }

  const serverEntry = path.join(root, 'apps/server/src/index.ts')
  const tsxBin = path.join(root, 'node_modules', '.bin', IS_WINDOWS ? 'tsx.cmd' : 'tsx')
  const child = spawnBin(tsxBin, [serverEntry], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      SERVE_STATIC: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let serverLog = ''
  child.stdout.on('data', (chunk) => (serverLog += chunk))
  child.stderr.on('data', (chunk) => (serverLog += chunk))

  const cleanup = () => {
    if (!keep) {
      // Windows 下 tsx 是 .cmd shim：child.kill 只杀掉 cmd.exe，真正监听端口的 node 子进程会变孤儿，
      // 占住 8899 端口，导致随后跑的 e2e（Chrome 调试端口也是 PORT+2）连不上。这里按进程树杀。
      if (IS_WINDOWS) {
        try {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        } catch {
          child.kill('SIGTERM')
        }
      } else {
        child.kill('SIGTERM')
      }
      setTimeout(() => rmSync(dataDir, { recursive: true, force: true }), 500)
    }
  }
  process.on('exit', cleanup)

  try {
    const health = await waitForHealth()
    ok('服务启动 /api/health', `v${health.version} · node ${health.node}`)

    /* ---------------- 基础接口 ---------------- */
    await check('GET /api/projects 返回数组', async () => {
      const response = await fetch(`${BASE}/api/projects`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      if (!Array.isArray(body)) throw new Error('不是数组')
      return `${body.length} 个工程`
    })

    await check('GET /api/settings 返回默认设置', async () => {
      const response = await fetch(`${BASE}/api/settings`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      if (!body.providers || !body.agent || !body.audio) throw new Error('结构不完整')
      return `providers=${body.providers.length} backend=${body.agent.backend}`
    })

    await check('GET /api/agents 返回后端探测结果', async () => {
      const response = await fetch(`${BASE}/api/agents`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      if (!Array.isArray(body)) throw new Error('不是数组')
      return body.map((item) => `${item.backend}:${item.available ? '✓' : '✗'}`).join(' ')
    })

    /* ---------------- 工程读写 ---------------- */
    const project = fixtureProject()
    await check('PUT /api/projects/:id 保存工程', async () => {
      const response = await fetch(`${BASE}/api/projects/${project.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(project),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status} ${await response.text()}`)
      const body = await response.json()
      if (!body.ok) throw new Error('ok 不为 true')
      return 'savedAt=' + new Date(body.savedAt).toISOString().slice(11, 19)
    })

    await check('GET /api/projects/:id 读回工程且一致', async () => {
      const response = await fetch(`${BASE}/api/projects/${project.id}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      if (body.name !== project.name) throw new Error('工程名不一致')
      if (body.tracks?.[0]?.clips?.[0]?.notes?.length !== 3) throw new Error('音符数量不一致')
      return `${body.tracks.length} 轨 / ${body.tracks[0].clips[0].notes.length} 音`
    })

    await check('GET /api/projects 列表包含刚保存的工程', async () => {
      const response = await fetch(`${BASE}/api/projects`)
      const body = await response.json()
      if (!body.some((item) => item.id === project.id)) throw new Error('列表里没有该工程')
      return body.map((item) => item.name).join(', ')
    })

    /* ---------------- 生成能力（不依赖 AI Key） ---------------- */
    await check('POST /api/generate (compose) 生成完整工程', async () => {
      const response = await fetch(`${BASE}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: 'compose', project, options: { style: 'rock', bars: 8, key: 'A', scale: 'minor' } }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status} ${await response.text()}`)
      const body = await response.json()
      if (!body.project?.tracks?.length) throw new Error('没有生成轨道')
      const notes = body.project.tracks.reduce(
        (sum, track) => sum + track.clips.reduce((n, clip) => n + clip.notes.length, 0),
        0,
      )
      if (notes < 20) throw new Error(`音符太少（${notes}）`)
      return `${body.project.tracks.length} 轨 / ${notes} 音`
    })

    await check('POST /api/generate (melody) 由和弦生成旋律', async () => {
      const response = await fetch(`${BASE}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: 'melody', project, options: { bars: 4 } }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status} ${await response.text()}`)
      const body = await response.json()
      const tracks = body.project?.tracks ?? []
      const notes = tracks.reduce((sum, track) => sum + track.clips.length, 0)
      if (!notes) throw new Error('没有旋律片段')
      return `${notes} 个片段`
    })

    /* ---------------- 导出 ---------------- */
    await check('POST /api/export/midi 返回合法 MIDI', async () => {
      const response = await fetch(`${BASE}/api/export/midi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length < 32) throw new Error('文件过小')
      if (buffer.subarray(0, 4).toString('ascii') !== 'MThd') throw new Error('缺少 MThd 头')
      return `${buffer.length} 字节`
    })

    /* ---------------- 未配置 Key 的 AI 接口应优雅失败 ---------------- */
    await check('POST /api/ai/chat 未配置 Key 时结构化报错', async () => {
      const response = await fetch(`${BASE}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: '写一段钢琴' }],
          project,
        }),
      })
      // 允许 4xx / 200+error 事件；不允许 5xx 崩溃
      if (response.status >= 500) throw new Error(`服务崩溃 HTTP ${response.status}`)
      const text = await response.text()
      if (response.ok && !text.includes('error')) throw new Error('既没报错也没返回 error 事件')
      return `HTTP ${response.status}`
    })

    /* ---------------- 删除 ---------------- */
    await check('DELETE /api/projects/:id 删除工程', async () => {
      const response = await fetch(`${BASE}/api/projects/${project.id}`, { method: 'DELETE' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const list = await (await fetch(`${BASE}/api/projects`)).json()
      if (list.some((item) => item.id === project.id)) throw new Error('删除后仍在列表里')
      return 'ok'
    })
  } catch (error) {
    bad('测试流程中断', error)
    if (serverLog) {
      console.log(`\n${c.dim}—— 服务端日志（尾部）——${c.reset}`)
      console.log(serverLog.split('\n').slice(-30).join('\n'))
    }
  }

  reportAndExit(cleanup)
}

/** 统一输出汇总并退出（单测模式与全量模式共用） */
function reportAndExit(cleanup) {
  console.log('')
  const total = passed + failed
  if (failed === 0) {
    console.log(`${c.green}${c.bold}✓ 全部通过${c.reset}  ${passed}/${total}\n`)
    cleanup?.()
    process.exit(0)
  } else {
    console.log(`${c.red}${c.bold}✗ ${failed} 项失败${c.reset}  ${passed}/${total} 通过\n`)
    for (const item of failures) console.log(`  ${c.red}•${c.reset} ${item.name}: ${c.dim}${item.message}${c.reset}`)
    console.log('')
    cleanup?.()
    process.exit(1)
  }
}

main()
