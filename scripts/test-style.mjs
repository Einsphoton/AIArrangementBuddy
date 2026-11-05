#!/usr/bin/env node
/**
 * 风格画像接入（P1）的核心单测。
 *
 *   node scripts/test-style.mjs
 *
 * 用 esbuild 把 `packages/core` 打成临时 ESM 再 import —— 这样测的是**真实发布形态**的代码，
 * 而不是另写一份逻辑。断言重点：
 *   1. 不传画像时行为与改造前完全一致（零回归）；
 *   2. 画像的每个采样都确定性（同 seed 同结果）；
 *   3. 画像真的影响输出（密度、力度、和弦进行、人性化）。
 */

import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
  } else {
    failed++
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  \x1b[31m${detail}\x1b[0m` : ''}`)
  }
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
/**
 * 比较音符时忽略 id：id 由 newId() 生成（随机），不参与可复现性判断。
 * 音高/起点/时值/力度才是生成器真正要保证可复现的部分。
 */
const stripIds = (notes) => notes.map(({ id, ...rest }) => rest)
const eqNotes = (a, b) => eq(stripIds(a), stripIds(b))

/* ------------------------------------------------------------------ */
/* 打包 core                                                           */
/* ------------------------------------------------------------------ */

const tmp = mkdtempSync(path.join(tmpdir(), 'aiab-style-test-'))
const outfile = path.join(tmp, 'core.mjs')
await build({
  entryPoints: [path.join(ROOT, 'packages/core/src/index.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})
const core = await import(`${outfile}?t=${Date.now()}`)

const {
  defaultSmartParams,
  generateSmartClip,
  coerceStyleProfile,
  describeProfile,
  neutralStyleProfile,
  profileProgression,
  profileDensityScale,
  profileVelocityScale,
  profileSwingAmount,
  isUsableProfile,
  humanizeNotes,
  STYLE_PROGRESSIONS,
} = core

console.log('\n风格画像接入（P1）单测\n')

/* ------------------------------------------------------------------ */
/* 1. 基础用例                                                          */
/* ------------------------------------------------------------------ */

const baseCtx = {
  kind: 'riff',
  style: 'rock',
  key: 'A',
  scale: 'minor',
  tempo: 150,
  timeSignature: { numerator: 4, denominator: 4 },
  bars: 4,
  params: defaultSmartParams({ bars: 4, density: 0.55, energy: 0.7, humanize: 0.25 }),
  chords: [],
  seed: 4242,
}

const plain = generateSmartClip(baseCtx)
check('无声风格上下文能生成音符', plain.length > 0, `${plain.length} 个音符`)
check('同 seed 结果一致（忽略随机 id）', eqNotes(plain, generateSmartClip(baseCtx)))
check('换 seed 结果不同', !eqNotes(plain, generateSmartClip({ ...baseCtx, seed: 4243 })))

/* ------------------------------------------------------------------ */
/* 2. 零回归：中性画像 == 不传画像                                       */
/* ------------------------------------------------------------------ */

const neutral = generateSmartClip({ ...baseCtx, profile: neutralStyleProfile('rock') })
check('中性画像与不传画像完全一致（零回归）', eqNotes(plain, neutral))

/* ------------------------------------------------------------------ */
/* 3. 反序列化：真实画像 JSON 形状                                       */
/* ------------------------------------------------------------------ */

const fixture = {
  schema: 'aiab.style-profile.v1',
  style: 'j-rock',
  tempo: { n: 120, p10: 150, p25: 160, median: 172, p75: 184, p90: 200, mean: 174 },
  timeSignature: { hist: { '4/4': 1 }, beatsPerBar: { median: 4 } },
  key: { majorShare: 0.6 },
  rhythm: {
    densityPerBar: { median: 24 },
    offbeat8thRate: { median: 0.42 },
    gridDeviation16: { median: 0.02 },
    swingRatio: { median: 1.0 },
  },
  harmony: {
    changePerBar: { median: 1.4 },
    diatonicRate: { median: 0.72 },
    topProgressions: [
      ['IV>V', 0.3],
      ['V>iii', 0.2],
      ['iii>vi', 0.2],
      ['vi>IV', 0.15],
      ['V>I', 0.15],
    ],
  },
  texture: {
    perRole: {
      guitar: { notesPerBar: { median: 18 } },
      bass: { notesPerBar: { median: 4 } },
      drums: { notesPerBar: { median: 9 } },
    },
    layerCount: { median: 5 },
  },
  dynamics: { velocityMean: { median: 104 }, velocityStd: { median: 11 } },
  repetition: { barRepeatRate: { median: 0.3 } },
}

const profile = coerceStyleProfile(fixture)
check('跳过解析：画像被正确反序列化', profile?.style === 'j-rock')
check('isUsableProfile 判定为空壳时返回 false', isUsableProfile(neutralStyleProfile('x')) === false)
check('isUsableProfile 判定真实画像为 true', isUsableProfile(profile) === true)
check('coerceStyleProfile 拒绝无 style 的输入', coerceStyleProfile({ tempo: { median: 120 } }) === null)

const card = describeProfile(profile)
check('风格卡包含速度与密度', card.includes('172') && card.includes('每小节'), card.slice(0, 60))

/* ------------------------------------------------------------------ */
/* 4. 采样函数                                                          */
/* ------------------------------------------------------------------ */

const rndSeq = () => {
  let seed = 7
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
}

const progA = profileProgression(profile, rndSeq(), 4)
const progB = profileProgression(profile, rndSeq(), 4)
check('画像进行可复现', eq(progA, progB), JSON.stringify(progA))
check('画像进行长度为 4 且每步都来自语料 bigram', progA.length === 4 && progA.every((r) => typeof r === 'string'), JSON.stringify(progA))
const emptyProfile = neutralStyleProfile('x')
check('无进行数据时返回 null（由调用方回落）', profileProgression(emptyProfile, rndSeq(), 4) === null)

check('吉他密度缩放 > 1（语料 18 音/小节）', profileDensityScale(profile, 'riff') > 1, String(profileDensityScale(profile, 'riff')))
check('中性画像密度缩放 = 1', profileDensityScale(emptyProfile, 'riff') === 1)
check('力度缩放跟随语料（104/90）', Math.abs(profileVelocityScale(profile) - 104 / 90) < 1e-6)
check('中性画像力度缩放 = 1', profileVelocityScale(emptyProfile) === 1)
check('swing 比率 1.0 → 0', profileSwingAmount(profile) === 0)
check('中性画像 swing 无建议', profileSwingAmount(emptyProfile) === null)

/* ------------------------------------------------------------------ */
/* 5. 画像真的改变输出                                                 */
/* ------------------------------------------------------------------ */

const withProfile = generateSmartClip({ ...baseCtx, profile })
check('带画像时输出不同于默认', !eq(plain, withProfile), `${plain.length} → ${withProfile.length} 个音符`)
check('带画像时结果可复现', eqNotes(withProfile, generateSmartClip({ ...baseCtx, profile })))

const sparse = coerceStyleProfile({
  style: 'sparse',
  texture: { perRole: { guitar: { notesPerBar: { median: 2 } } } },
})
const dense = coerceStyleProfile({
  style: 'dense',
  texture: { perRole: { guitar: { notesPerBar: { median: 20 } } } },
})
const sparseNotes = generateSmartClip({ ...baseCtx, profile: sparse })
const denseNotes = generateSmartClip({ ...baseCtx, profile: dense })
check('语料密度更高 → 生成音符更多', denseNotes.length > sparseNotes.length, `${sparseNotes.length} vs ${denseNotes.length}`)

const quiet = coerceStyleProfile({ style: 'q', dynamics: { velocityMean: { median: 55 } } })
const loud = coerceStyleProfile({ style: 'l', dynamics: { velocityMean: { median: 115 } } })
const quietMean = mean(generateSmartClip({ ...baseCtx, profile: quiet }).map((n) => n.velocity))
const loudMean = mean(generateSmartClip({ ...baseCtx, profile: loud }).map((n) => n.velocity))
check('语料力度更高 → 生成力度更大', loudMean > quietMean, `${quietMean.toFixed(1)} vs ${loudMean.toFixed(1)}`)

const swingProfile = coerceStyleProfile({ style: 'swing', rhythm: { swingRatio: { median: 1.33 } } })
check('swing 语料会传导到生成结果', !eqNotes(generateSmartClip({ ...baseCtx, profile: swingProfile }), plain))

const progProfile = coerceStyleProfile({
  style: 'prog',
  harmony: {
    topProgressions: [
      ['V>i', 1],
      ['i>VI', 1],
      ['VI>III', 1],
      ['III>V', 1],
    ],
  },
})
const progNotes = generateSmartClip({ ...baseCtx, kind: 'chords', profile: progProfile })
check('画像和弦进行参与生成（输出非空）', progNotes.length > 0, `${progNotes.length} 个音符`)

/* ------------------------------------------------------------------ */
/* 6. 演奏层人性化                                                      */
/* ------------------------------------------------------------------ */

const rawNotes = [
  { id: 'a', pitch: 60, start: 0, duration: 1, velocity: 90 },
  { id: 'b', pitch: 64, start: 1, duration: 1, velocity: 90 },
  { id: 'c', pitch: 67, start: 2, duration: 1, velocity: 90 },
  { id: 'd', pitch: 72, start: 3, duration: 1, velocity: 90 },
]
check('人性化强度 0 时原样返回', humanizeNotes(rawNotes, { seed: 1, amount: 0 }) === rawNotes)

const humanized = humanizeNotes(rawNotes, { seed: 1, amount: 0.6, velocityStd: 12, gridDeviation16: 0.06 })
check('人性化改变力度', humanized.some((n) => n.velocity !== 90), JSON.stringify(humanized.map((n) => n.velocity)))
check('人性化后力度仍在合法范围', humanized.every((n) => n.velocity >= 1 && n.velocity <= 127))
check('人性化后起点非负', humanized.every((n) => n.start >= 0))
check('人性化可复现', eq(humanized, humanizeNotes(rawNotes, { seed: 1, amount: 0.6, velocityStd: 12, gridDeviation16: 0.06 })))
check('打击乐不做时序抖动', humanizeNotes(rawNotes, { seed: 1, amount: 0.6, gridDeviation16: 0.06, isDrums: true }).every((n) => Number.isInteger(n.start)))

/* ------------------------------------------------------------------ */
/* 7. 内置风格常量仍然完好（没有被画像改动）                             */
/* ------------------------------------------------------------------ */

check('STYLE_PROGRESSIONS 仍是内置默认', eq(STYLE_PROGRESSIONS.rock, ['i', 'bVII', 'bVI', 'bVII']))

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} 通过，${failed} 失败\x1b[0m\n`)
process.exit(failed ? 1 : 0)
