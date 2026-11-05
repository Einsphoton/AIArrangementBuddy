#!/usr/bin/env node
/**
 * 风格画像（Style Profile）构建器 —— 把一堆同风格 MIDI 聚合成一份可被生成器消费的统计画像。
 *
 * 用法：
 *   node scripts/corpus/profile.mjs build data/corpus/jrpg --style jrpg --out data/corpus/profiles/jrpg.json
 *   node scripts/corpus/profile.mjs inspect data/corpus/jrpg/xxx.mid
 *
 * 目录结构约定（本地，`data/` 已在 .gitignore）：
 *   data/corpus/<style>/<source>/<file>.mid
 *   data/corpus/profiles/<style>.json      ← 本脚本的产物
 *
 * 产物是**纯数据**：不含任何原始音符，只有分布与分位数 —— 这一步天然避开了「把别人的 MIDI 打包进产品」的问题。
 */

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseMidi, summarize, primaryTimeSignature } from './midi-read.mjs'
import { extractFeatures, qualityGate, percentile, mean } from './features.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')

/* ------------------------------------------------------------------ */
/* 聚合原语                                                            */
/* ------------------------------------------------------------------ */

function numericSummary(values) {
  const clean = values.filter((v) => Number.isFinite(v))
  if (!clean.length) return null
  const sorted = [...clean].sort((a, b) => a - b)
  const r = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d
  return {
    n: clean.length,
    p10: r(percentile(sorted, 0.1)),
    p25: r(percentile(sorted, 0.25)),
    median: r(percentile(sorted, 0.5)),
    p75: r(percentile(sorted, 0.75)),
    p90: r(percentile(sorted, 0.9)),
    mean: r(mean(clean)),
  }
}

/** 把每首曲子内部的频率分布合并成全局分布（先各自归一，再取平均） */
function shareMap(dicts) {
  const totals = {}
  const counts = {}
  for (const dict of dicts) {
    const sum = Object.values(dict).reduce((a, b) => a + b, 0)
    if (!sum) continue
    for (const [key, value] of Object.entries(dict)) {
      totals[key] = (totals[key] ?? 0) + value / sum
      counts[key] = (counts[key] ?? 0) + 1
    }
  }
  const files = dicts.filter((d) => Object.values(d).some((v) => v > 0)).length || 1
  const out = {}
  for (const key of Object.keys(totals).sort((a, b) => totals[b] - totals[a])) {
    out[key] = Math.round((totals[key] / files) * 1000) / 1000
  }
  return out
}

function topEntries(share, limit = 20) {
  return Object.entries(share)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, value]) => [key, value])
}

/* ------------------------------------------------------------------ */
/* 画像构建                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {Array<{file:string, features:object, summary:object}>} entries
 * @param {{style:string, rejected?:Array<{file:string,reasons:string[],tags:string[]}>}} options
 */
export function buildProfile(entries, options) {
  const feats = entries.map((e) => e.features)
  const perRole = {}
  for (const key of ['bass', 'guitar', 'keys', 'strings', 'ensemble', 'brass', 'winds', 'synthLead', 'synthPad', 'melody', 'harmony', 'drums']) {
    const tracks = feats.flatMap((f) => f.texture.tracks.filter((t) => t.role === key))
    if (tracks.length < 3) continue
    perRole[key] = {
      files: tracks.length,
      notesPerBar: numericSummary(tracks.map((t) => t.densityPerBar)),
      meanPitch: numericSummary(tracks.map((t) => t.meanPitch)),
      pitchRange: numericSummary(tracks.map((t) => t.range)),
      polyphony: numericSummary(tracks.map((t) => t.polyphony)),
      velocityStd: numericSummary(tracks.map((t) => t.velocityStd)),
      registerOverlap: numericSummary(tracks.map((t) => t.registerOverlap)),
    }
  }

  const roleCount = {}
  for (const f of feats) for (const [role, n] of Object.entries(f.texture.roles)) roleCount[role] = (roleCount[role] ?? 0) + n
  const roleSum = Object.values(roleCount).reduce((a, b) => a + b, 0) || 1
  const roleShare = Object.fromEntries(Object.entries(roleCount).map(([k, v]) => [k, Math.round((v / roleSum) * 1000) / 1000]))

  const progressionTotals = {}
  for (const f of feats) {
    for (const [prog, count] of f.harmony.topProgressions) progressionTotals[prog] = (progressionTotals[prog] ?? 0) + count
  }
  const progressionSum = Object.values(progressionTotals).reduce((a, b) => a + b, 0) || 1
  const topProgressions = Object.entries(progressionTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([prog, count]) => [prog, Math.round((count / progressionSum) * 1000) / 1000])

  const chordVocab = {}
  for (const f of feats) for (const [chord, count] of Object.entries(f.harmony.qualityHist)) chordVocab[chord] = (chordVocab[chord] ?? 0) + count
  const chordSum = Object.values(chordVocab).reduce((a, b) => a + b, 0) || 1
  const qualities = Object.fromEntries(Object.entries(chordVocab).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round((v / chordSum) * 1000) / 1000]))

  const timeSigHist = {}
  for (const e of entries) {
    const ts = primaryTimeSignature(e.parsed)
    const label = `${ts.numerator}/${ts.denominator}`
    timeSigHist[label] = (timeSigHist[label] ?? 0) + 1
  }

  const keyTonics = {}
  for (const f of feats) keyTonics[f.key.tonic] = (keyTonics[f.key.tonic] ?? 0) + 1

  return {
    schema: 'aiab.style-profile.v1',
    style: options.style,
    generatedAt: new Date().toISOString(),
    corpus: {
      files: entries.length,
      rejected: options.rejected?.length ?? 0,
      totalBars: numericSummary(feats.map((f) => f.meta.bars))?.mean ?? 0,
      totalNotes: numericSummary(feats.map((f) => f.meta.noteCount))?.mean ?? 0,
      sources: [...new Set(entries.map((e) => e.file.split(path.sep).slice(0, -1).join('/')))].slice(0, 20),
    },
    tempo: numericSummary(feats.map((f) => f.meta.bpm)),
    bars: numericSummary(feats.map((f) => f.meta.bars)),
    timeSignature: {
      hist: Object.fromEntries(Object.entries(timeSigHist).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round((v / entries.length) * 1000) / 1000])),
      beatsPerBar: numericSummary(feats.map((f) => f.meta.beatsPerBar)),
    },
    key: {
      majorShare: Math.round((feats.filter((f) => f.key.mode === 'major').length / (feats.length || 1)) * 1000) / 1000,
      confidenceMedian: numericSummary(feats.map((f) => f.key.confidence))?.median ?? 0,
      tonicHist: Object.fromEntries(Object.entries(keyTonics).sort((a, b) => b[1] - a[1])),
    },
    rhythm: {
      densityPerBar: numericSummary(feats.map((f) => f.rhythm.densityPerBar)),
      tonalDensityPerBar: numericSummary(feats.map((f) => f.rhythm.tonalDensityPerBar)),
      offbeatRate: numericSummary(feats.map((f) => f.rhythm.offbeatRate)),
      offbeat8thRate: numericSummary(feats.map((f) => f.rhythm.offbeat8thRate)),
      gridDeviation16: numericSummary(feats.map((f) => f.rhythm.gridDeviation16)),
      swingRatio: numericSummary(feats.map((f) => f.rhythm.swingRatio).filter((v) => v !== null)),
      durationHist: shareMap(feats.map((f) => f.rhythm.durationHist)),
      grid16: shareMap(feats.map((f) => Object.fromEntries(f.rhythm.grid16.map((v, i) => [String(i), v])))),
    },
    harmony: {
      changePerBar: numericSummary(feats.map((f) => f.harmony.changePerBar)),
      diatonicRate: numericSummary(feats.map((f) => f.harmony.diatonicRate).filter((v) => v !== null)),
      qualities,
      topProgressions,
    },
    intervals: {
      stepRate: numericSummary(feats.map((f) => f.intervals.stepRate).filter((v) => v !== null)),
      leapRate: numericSummary(feats.map((f) => f.intervals.leapRate).filter((v) => v !== null)),
      repeatRate: numericSummary(feats.map((f) => f.intervals.repeatRate).filter((v) => v !== null)),
      hist: shareMap(feats.map((f) => f.intervals.hist)),
    },
    texture: {
      layerCount: numericSummary(feats.map((f) => f.texture.layerCount)),
      drumTrackCount: numericSummary(feats.map((f) => f.texture.drumTrackCount)),
      meanPolyphony: numericSummary(feats.map((f) => f.texture.meanPolyphony)),
      roleShare,
      perRole,
    },
    dynamics: {
      velocityMean: numericSummary(feats.map((f) => f.dynamics.velocityMean)),
      velocityStd: numericSummary(feats.map((f) => f.dynamics.velocityStd)),
      accentByBeat: numericSummary(feats.flatMap((f) => f.dynamics.accentByBeat)),
    },
    articulation: {
      legatoRatio: numericSummary(feats.map((f) => f.articulation.legatoRatio).filter((v) => v !== null)),
      staccatoRate: numericSummary(feats.map((f) => f.articulation.staccatoRate).filter((v) => v !== null)),
    },
    repetition: {
      barRepeatRate: numericSummary(feats.map((f) => f.repetition.barRepeatRate)),
      phrase4RepeatRate: numericSummary(feats.map((f) => f.repetition.phrase4RepeatRate).filter((v) => v !== null)),
    },
  }
}

/* ------------------------------------------------------------------ */
/* 文件发现与流水线                                                    */
/* ------------------------------------------------------------------ */

function walkMidi(dir) {
  const out = []
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue
        stack.push(full)
      } else if (/\.(mid|midi|smf)$/i.test(entry.name)) {
        out.push(full)
      }
    }
  }
  return out.sort()
}

/**
 * 跑完整条流水线：解析 → 特征 → 准入 → 聚合。
 * @param {string} dir
 * @param {{style:string, strict?:boolean, log?:Function}} options
 */
export function buildProfileFromDir(dir, options) {
  const log = options.log ?? (() => {})
  const files = walkMidi(dir)
  if (!files.length) throw new Error(`目录里没有 MIDI 文件：${dir}`)

  const accepted = []
  const rejected = []
  let index = 0
  for (const file of files) {
    index++
    if (index % 200 === 0) log(`  已处理 ${index}/${files.length}`)
    try {
      const parsed = parseMidi(readFileSync(file))
      const summary = summarize(parsed)
      const features = extractFeatures(parsed, { bars: summary.bars })
      const gate = qualityGate(parsed, features)
      if (!gate.ok) {
        rejected.push({ file, reasons: gate.reasons, tags: gate.tags })
        if (options.strict) continue
        continue
      }
      accepted.push({ file, parsed, summary, features, tags: gate.tags })
    } catch (error) {
      rejected.push({ file, reasons: [`解析失败: ${error.message}`], tags: [] })
    }
  }

  log(`  通过 ${accepted.length} / ${files.length}，丢弃 ${rejected.length}`)
  if (!accepted.length) throw new Error('没有任何文件通过质量闸门，检查语料来源')
  const profile = buildProfile(accepted, { style: options.style, rejected })

  // 标签统计：用于判断这批语料里有多少「机械量化 / 无鼓 / 幽灵轨」
  const tagCount = {}
  for (const item of accepted) for (const tag of item.tags ?? []) {
    const key = tag.split(':')[0]
    tagCount[key] = (tagCount[key] ?? 0) + 1
  }
  profile.corpus.tags = tagCount
  profile.corpus.rejectedSamples = rejected.slice(0, 20)

  return { profile, accepted, rejected }
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function argValue(args, name, fallback) {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 ? args[idx + 1] : fallback
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  if (command === 'inspect') {
    const file = args[1]
    if (!file) throw new Error('用法: node scripts/corpus/profile.mjs inspect <file.mid>')
    const parsed = parseMidi(readFileSync(file))
    const summary = summarize(parsed)
    const features = extractFeatures(parsed, { bars: summary.bars })
    const gate = qualityGate(parsed, features)
    console.log(JSON.stringify({ summary, gate, features }, null, 2))
    return
  }

  if (command === 'build') {
    const dir = path.resolve(args[1] ?? '')
    const style = argValue(args, 'style', path.basename(dir))
    const out = path.resolve(argValue(args, 'out', path.join(ROOT, 'data/corpus/profiles', `${style}.json`)))
    console.log(`\n构建风格画像  style=${style}`)
    console.log(`  语料目录 ${dir}`)
    const { profile, accepted, rejected } = buildProfileFromDir(dir, { style, strict: args.includes('--strict'), log: console.log })
    mkdirSync(path.dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify(profile, null, 2))
    console.log(`  通过 ${accepted.length} 首，丢弃 ${rejected.length} 首`)
    console.log(`  画像已写入 ${out}`)
    console.log(`\n  摘要：`)
    console.log(`    速度中位数   ${profile.tempo?.median ?? '?'} BPM`)
    console.log(`    和弦变化     ${profile.harmony.changePerBar?.median ?? '?'} 次/小节`)
    console.log(`    调内和弦占比 ${((profile.harmony.diatonicRate?.median ?? 0) * 100).toFixed(1)}%`)
    console.log(`    音符密度     ${profile.rhythm.densityPerBar?.median ?? '?'} 个/小节`)
    console.log(`    调性分布     大调 ${((profile.key.majorShare ?? 0) * 100).toFixed(0)}%`)
    console.log(`    常见进行     ${profile.harmony.topProgressions.slice(0, 6).map(([p, s]) => `${p}(${(s * 100).toFixed(0)}%)`).join(' ')}`)
    return
  }

  console.log(`MIDI 风格画像工具

  node scripts/corpus/profile.mjs inspect <file.mid>          查看单曲特征
  node scripts/corpus/profile.mjs build <dir> --style <name>  构建风格画像
        [--out <path>] [--strict]

语料目录建议结构：data/corpus/<style>/<source>/*.mid（data/ 已被 .gitignore 忽略）
`)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  main().catch((error) => {
    console.error(`\n✗ ${error.message}\n`)
    process.exit(1)
  })
}
