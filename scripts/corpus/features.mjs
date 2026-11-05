/**
 * MIDI 语料特征提取 —— 把一首 MIDI 变成一组可聚合、可解释的风格统计量。
 *
 * 设计原则：
 * 1. **可解释**：每个数字都要能回指一个音乐概念（音区、密度、和声变化率、律动偏移……），
 *    否则「学习」就退化成不可调试的黑箱；
 * 2. **可聚合**：单曲特征 → 风格画像（profile.mjs）只做分位数与频率统计；
 * 3. **可归一**：按拍（beat）而不是按秒，小节的换算用文件自己的拍号，避免速度差异污染。
 *
 * 时间单位：beat（1 = 四分音符）。16 分音符网格 = 0.25 beat。
 */

import { flattenNotes, primaryTimeSignature, DRUM_CHANNEL } from './midi-read.mjs'

/* ------------------------------------------------------------------ */
/* 通用统计                                                            */
/* ------------------------------------------------------------------ */

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
export const std = (xs) => {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
}
export function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0
  const idx = (sortedAsc.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sortedAsc[lo]
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo)
}
const round = (v, digits = 4) => (Number.isFinite(v) ? Math.round(v * 10 ** digits) / 10 ** digits : 0)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/* ------------------------------------------------------------------ */
/* 调性估计（Krumhansl-Schmuckler）                                     */
/* ------------------------------------------------------------------ */

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

function correlate(a, b) {
  const ma = mean(a)
  const mb = mean(b)
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb)
    da += (a[i] - ma) ** 2
    db += (b[i] - mb) ** 2
  }
  return da && db ? num / Math.sqrt(da * db) : 0
}

/**
 * @param {number[]} pitchClassHist 12 维、按时值加权的音级直方图
 * @returns {{tonic:number, mode:'major'|'minor', confidence:number, correlation:number}}
 */
export function estimateKey(pitchClassHist) {
  const total = pitchClassHist.reduce((a, b) => a + b, 0) || 1
  const norm = pitchClassHist.map((v) => v / total)
  let best = { tonic: 0, mode: 'major', correlation: -2 }
  const scores = []
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor']) {
      const profile = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE
      // 旋转：profile[i] 对应 (tonic + i) % 12
      const rotated = new Array(12)
      for (let i = 0; i < 12; i++) rotated[i] = norm[(tonic + i) % 12]
      const r = correlate(rotated, profile)
      scores.push({ tonic, mode, r })
      if (r > best.correlation) best = { tonic, mode, correlation: r }
    }
  }
  scores.sort((a, b) => b.r - a.r)
  const gap = scores.length > 1 ? scores[0].r - scores[1].r : 0
  return {
    tonic: best.tonic,
    mode: best.mode,
    correlation: round(best.correlation),
    confidence: round(clamp(gap * 8, 0, 1)),
  }
}

/* ------------------------------------------------------------------ */
/* 和弦识别（模板匹配，仅用于统计而不是还原记谱）                        */
/* ------------------------------------------------------------------ */

const CHORD_TEMPLATES = [
  { suffix: '', intervals: [0, 4, 7], prior: 1 },
  { suffix: 'm', intervals: [0, 3, 7], prior: 1 },
  { suffix: '7', intervals: [0, 4, 7, 10], prior: 0.95 },
  { suffix: 'm7', intervals: [0, 3, 7, 10], prior: 0.95 },
  { suffix: 'maj7', intervals: [0, 4, 7, 11], prior: 0.9 },
  { suffix: 'sus4', intervals: [0, 5, 7], prior: 0.7 },
  { suffix: 'sus2', intervals: [0, 2, 7], prior: 0.6 },
  { suffix: 'dim', intervals: [0, 3, 6], prior: 0.6 },
  { suffix: 'm7b5', intervals: [0, 3, 6, 10], prior: 0.6 },
  { suffix: '5', intervals: [0, 7], prior: 0.55 },
  { suffix: 'add9', intervals: [0, 4, 7, 2], prior: 0.5 },
  { suffix: '6', intervals: [0, 4, 7, 9], prior: 0.45 },
  { suffix: 'm9', intervals: [0, 3, 7, 10, 2], prior: 0.4 },
  { suffix: 'maj9', intervals: [0, 4, 7, 11, 2], prior: 0.4 },
  { suffix: 'aug', intervals: [0, 4, 8], prior: 0.35 },
  { suffix: 'dim7', intervals: [0, 3, 6, 9], prior: 0.3 },
]

/**
 * 识别某一时刻的和弦（只看音级，不看排列）。
 * 模板带「常见度先验」，否则 sus/aug/dim7 这类对称或近似模板会抢走普通三和弦。
 * @param {Map<number, number>} pitchClassWeights 音级 -> 权重（时值或命中次数）
 */
export function detectChord(pitchClassWeights) {
  const total = [...pitchClassWeights.values()].reduce((a, b) => a + b, 0)
  if (total < 1 || pitchClassWeights.size < 2) return null
  let best = null
  for (let root = 0; root < 12; root++) {
    for (const tpl of CHORD_TEMPLATES) {
      let inside = 0
      let outside = 0
      const tones = new Set(tpl.intervals.map((i) => (root + i) % 12))
      for (const [pc, w] of pitchClassWeights) {
        if (tones.has(pc)) inside += w
        else outside += w
      }
      // 根音要真的在响，否则会出现「无根音的减七和弦」这类误判
      const rootWeight = pitchClassWeights.get(root) ?? 0
      if (rootWeight <= 0) continue
      const coverage = inside / total
      if (coverage < 0.62) continue
      const score = ((inside - outside * 0.9) / total) * tpl.prior + Math.min(rootWeight / total, 0.35) * 0.4
      if (!best || score > best.score) best = { root, suffix: tpl.suffix, score, coverage }
    }
  }
  if (!best || best.coverage < 0.62) return null
  return best
}

const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
export const chordName = (root, suffix) => `${PC_NAMES[root]}${suffix}`

/** 把和弦写成相对主音的功能级数（大调/小调各一套映射） */
const MAJOR_DEGREE = { 0: 'I', 1: 'bII', 2: 'II', 3: 'bIII', 4: 'III', 5: 'IV', 6: '#IV', 7: 'V', 8: 'bVI', 9: 'VI', 10: 'bVII', 11: 'VII' }
const MINOR_DEGREE = { 0: 'I', 1: 'bII', 2: 'II', 3: 'III', 4: '#III', 5: 'IV', 6: '#IV', 7: 'V', 8: 'VI', 9: '#VI', 10: 'VII', 11: 'VII#' }

const ROMAN_INDEX = { I: 0, II: 1, III: 2, IV: 3, V: 4, VI: 5, VII: 6 }
const lowerRoman = (roman) => roman.replace(/[IVX]/g, (c) => c.toLowerCase())

export function chordToRoman(chord, key) {
  if (!chord) return null
  const degree = (((chord.root - key.tonic) % 12) + 12) % 12
  const table = key.mode === 'major' ? MAJOR_DEGREE : MINOR_DEGREE
  const base = table[degree]
  if (!base) return null
  const letters = base.replace(/[^IVX]/g, '')
  const degreeIndex = ROMAN_INDEX[letters] ?? null
  const suffix = chord.suffix ?? ''
  let numeral = base
  if (suffix === 'dim' || suffix === 'm7b5') numeral = `${lowerRoman(base)}°`
  else if (suffix === 'dim7') numeral = `${lowerRoman(base)}°7`
  else if (/^m(?!aj)/.test(suffix)) numeral = `${lowerRoman(base)}${suffix.slice(1)}`
  else if (suffix) numeral = base + suffix
  return { numeral, degreeIndex, degree, diatonic: isDiatonic(chord, key) }
}

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]
/** 自然大调 / 自然小调各音级上「三和弦性质」的合法集合（七和弦按同性质归并） */
const DIATONIC_QUALITY = {
  major: { 0: ['', 'maj7'], 2: ['m', 'm7'], 4: ['m', 'm7'], 5: ['', 'maj7'], 7: ['', '7'], 9: ['m', 'm7'], 11: ['dim', 'm7b5'] },
  minor: { 0: ['m', 'm7'], 2: ['dim', 'm7b5'], 3: ['', 'maj7'], 5: ['m', 'm7'], 7: ['m', 'm7'], 8: ['', 'maj7'], 10: ['', '7'] },
}

function isDiatonic(chord, key) {
  const scale = key.mode === 'major' ? MAJOR_SCALE : MINOR_SCALE
  const degree = (((chord.root - key.tonic) % 12) + 12) % 12
  if (!scale.includes(degree)) return false
  const allowed = DIATONIC_QUALITY[key.mode][degree]
  if (!allowed) return false
  const suffix = chord.suffix ?? ''
  return allowed.includes(suffix)
}

/* ------------------------------------------------------------------ */
/* 轨道角色                                                            */
/* ------------------------------------------------------------------ */

/** GM 音色族 → 角色（仅用于编曲统计，不追求精确） */
function programRole(program) {
  if (program === null || program === undefined) return null
  if (program >= 32 && program <= 39) return 'bass'
  if (program >= 24 && program <= 31) return 'guitar'
  if (program >= 0 && program <= 7) return 'keys'
  if (program >= 40 && program <= 47) return 'strings'
  if (program >= 48 && program <= 55) return 'ensemble'
  if (program >= 56 && program <= 63) return 'brass'
  if (program >= 64 && program <= 79) return 'winds'
  if (program >= 80 && program <= 87) return 'synthLead'
  if (program >= 88 && program <= 95) return 'synthPad'
  return 'other'
}

/**
 * 每轨的形态统计 + 角色推断。
 * 角色优先级：鼓通道 > GM 音色族 > 音高位置（最低 = bass，最高且单声部 = melody）。
 */
export function analyzeTracks(parsed) {
  const raw = parsed.tracks
    .filter((t) => t.notes.length > 0)
    .map((t) => {
      const pitches = t.notes.map((n) => n.pitch)
      const sortedPitches = [...pitches].sort((a, b) => a - b)
      const isDrum = t.channels.includes(DRUM_CHANNEL)
      return {
        index: t.index,
        name: t.name || '',
        channels: t.channels,
        program: t.program,
        isDrum,
        noteCount: t.notes.length,
        meanPitch: round(mean(pitches), 2),
        p10: round(percentile(sortedPitches, 0.1), 2),
        p90: round(percentile(sortedPitches, 0.9), 2),
        range: round(percentile(sortedPitches, 0.9) - percentile(sortedPitches, 0.1), 2),
        velocityMean: round(mean(t.notes.map((n) => n.velocity)), 1),
        velocityStd: round(std(t.notes.map((n) => n.velocity)), 2),
        polyphony: round(timeWeightedPolyphony(t.notes), 2),
        densityPerBar: 0,
      }
    })

  // 音高位置推断（只在没有可信 GM 角色时用）
  const tonal = raw.filter((t) => !t.isDrum)
  const sortedByPitch = [...tonal].sort((a, b) => a.meanPitch - b.meanPitch)
  const lowest = sortedByPitch[0]
  const highest = sortedByPitch[sortedByPitch.length - 1]

  for (const track of raw) {
    if (track.isDrum) {
      track.role = 'drums'
    } else {
      track.role = programRole(track.program) ?? 'other'
      if (track.role === 'other') {
        if (track === lowest) track.role = 'bass'
        else if (track === highest && track.polyphony < 1.4) track.role = 'melody'
        else track.role = 'harmony'
      }
    }
  }

  // 音区重叠：该轨 [p10,p90] 与其它轨交叠的比例
  for (const track of raw) {
    if (track.isDrum) {
      track.registerOverlap = 0
      continue
    }
    let overlap = 0
    let others = 0
    for (const other of raw) {
      if (other === track || other.isDrum) continue
      others++
      const lo = Math.max(track.p10, other.p10)
      const hi = Math.min(track.p90, other.p90)
      const span = Math.max(1, track.p90 - track.p10)
      overlap += Math.max(0, hi - lo) / span
    }
    track.registerOverlap = round(others ? overlap / others : 0, 3)
  }

  return raw
}

/** 时间加权平均同时发声音数（O(n log n)；比逐时刻采样快且更稳定） */
function timeWeightedPolyphony(notes) {
  if (!notes.length) return 0
  const events = []
  for (const n of notes) {
    events.push([n.startBeat, 1])
    events.push([n.startBeat + Math.max(n.durationBeat, 0.01), -1])
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const start = events[0][0]
  let cur = 0
  let prev = start
  let weighted = 0
  for (const [t, delta] of events) {
    weighted += cur * (t - prev)
    prev = t
    cur += delta
  }
  const span = prev - start
  return span > 0.001 ? weighted / span : 1
}

/**
 * 抽取一条「主旋律线」：按 8 分网格取样，每个网格取最高音。
 * 复调轨道（吉他琶音、钢琴伴奏）用它算音程，避免把和弦内音当成旋律跳进。
 */
export function melodyLine(notes, gridBeats = 0.5) {
  const buckets = new Map()
  for (const n of notes) {
    const slot = Math.round(n.startBeat / gridBeats)
    const prev = buckets.get(slot)
    if (!prev || n.pitch > prev.pitch) buckets.set(slot, n)
  }
  const line = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n)
  // 相邻同音合并（同一和弦的重复取样会造成假「重复音」）
  const merged = []
  for (const n of line) {
    const prev = merged[merged.length - 1]
    if (prev && prev.pitch === n.pitch && n.startBeat - prev.startBeat < gridBeats * 1.01) continue
    merged.push(n)
  }
  return merged
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {object} parsed parseMidi 的返回值
 * @param {{ bars?: number, beatsPerBar?: number }} [options]
 */
export function extractFeatures(parsed, options = {}) {
  const ts = primaryTimeSignature(parsed)
  const beatsPerBar = (ts.numerator * 4) / ts.denominator
  const notes = flattenNotes(parsed)
  const tonalNotes = notes.filter((n) => n.channel !== DRUM_CHANNEL)
  const drumNotes = notes.filter((n) => n.channel === DRUM_CHANNEL)

  const endBeat = notes.reduce((m, n) => Math.max(m, n.startBeat + n.durationBeat), 0)
  const bars = options.bars ?? Math.max(1, endBeat / beatsPerBar)
  const tracks = analyzeTracks(parsed)
  for (const t of tracks) t.densityPerBar = round(t.noteCount / bars, 2)

  /* --- 音级直方图（按时值加权） --- */
  const pitchClassHist = new Array(12).fill(0)
  for (const n of tonalNotes) pitchClassHist[n.pitch % 12] += n.durationBeat
  const key = estimateKey(pitchClassHist)

  /* --- 音程分布（melodic interval，按轨分别算再合并） --- */
  const intervalHist = new Map()
  let steps = 0
  let leaps = 0
  let repeats = 0
  let intervalCount = 0
  for (const track of parsed.tracks) {
    if (track.channels.includes(DRUM_CHANNEL)) continue
    // 复调轨（吉他琶音 / 钢琴伴奏）取主旋律线，避免把和弦内音当成旋律跳进
    const line = melodyLine(track.notes)
    if (line.length < 3) continue
    for (let i = 1; i < line.length; i++) {
      const delta = line[i].pitch - line[i - 1].pitch
      const bucket = delta > 12 ? '>12' : delta < -12 ? '<-12' : String(clamp(delta, -12, 12))
      intervalHist.set(bucket, (intervalHist.get(bucket) ?? 0) + 1)
      intervalCount++
      const abs = Math.abs(delta)
      if (abs === 0) repeats++
      else if (abs <= 2) steps++
      else if (abs >= 5) leaps++
    }
  }

  /* --- 节奏：16 分网格位置、时值、偏离度 --- */
  const grid16 = new Array(16).fill(0)
  const durationHist = new Map()
  const deviations = []
  for (const n of notes) {
    const pos = n.startBeat * 4 // 16 分音符序号
    const nearest = Math.round(pos)
    deviations.push(Math.abs(pos - nearest))
    const inBar = ((nearest % 16) + 16) % 16
    grid16[inBar]++
    const dur16 = Math.max(1, Math.round(n.durationBeat * 4))
    const bucket = dur16 <= 1 ? '1' : dur16 <= 2 ? '2' : dur16 <= 4 ? '4' : dur16 <= 8 ? '8' : dur16 <= 16 ? '16' : '>16'
    durationHist.set(bucket, (durationHist.get(bucket) ?? 0) + 1)
  }
  const gridDeviation = mean(deviations)

  /* --- swing：反拍八分音符的实际位置 --- */
  const swingSamples = []
  for (const n of notes) {
    const pos = n.startBeat * 4
    const nearest = Math.round(pos)
    const inBar = ((nearest % 16) + 16) % 16
    if (inBar % 4 === 2) swingSamples.push((pos % 4 + 4) % 4)
  }
  const swingRatio = swingSamples.length >= 8 ? round(mean(swingSamples) / 2, 3) : null

  /* --- 和弦：逐拍扫描 --- */
  const chordSequence = scanChords(parsed, beatsPerBar, endBeat)
  const chordChanges = chordSequence.filter((c, i) => i === 0 || c.chord?.name !== chordSequence[i - 1].chord?.name)
  const romanSequence = chordChanges.map((c) => (c.chord ? chordToRoman({ root: c.chord.root, suffix: c.chord.suffix }, key) : null))
  const romanBigrams = new Map()
  for (let i = 1; i < romanSequence.length; i++) {
    const a = romanSequence[i - 1]?.numeral
    const b = romanSequence[i]?.numeral
    if (a && b) romanBigrams.set(`${a}>${b}`, (romanBigrams.get(`${a}>${b}`) ?? 0) + 1)
  }
  const diatonicRate = romanSequence.length
    ? romanSequence.filter((r) => r?.diatonic).length / romanSequence.length
    : null
  const qualityHist = new Map()
  for (const c of chordChanges) if (c.chord) qualityHist.set(c.chord.suffix || 'maj', (qualityHist.get(c.chord.suffix || 'maj') ?? 0) + 1)

  /* --- 复调密度（全曲层面） --- */
  const meanPolyphony = round(mean(tracks.filter((t) => !t.isDrum).map((t) => t.polyphony)), 2)

  /* --- 力度 --- */
  const velocities = tonalNotes.map((n) => n.velocity)
  const velocityMean = round(mean(velocities), 1)
  const velocityStd = round(std(velocities), 2)
  const accentByBeat = [0, 1, 2, 3].map((b) => {
    const onBeat = tonalNotes.filter((n) => Math.round(n.startBeat) % 4 === b).map((n) => n.velocity)
    return round(mean(onBeat), 1)
  })

  /* --- 重复度 / 曲式 --- */
  const repetition = analyzeRepetition(parsed, beatsPerBar, bars)

  /* --- 演奏层：连断与句法 --- */
  const articulation = analyzeArticulation(parsed)

  return {
    meta: {
      beatsPerBar: round(beatsPerBar, 3),
      bars: round(bars, 2),
      noteCount: notes.length,
      tonalNoteCount: tonalNotes.length,
      drumNoteCount: drumNotes.length,
      trackCount: tracks.length,
      bpm: parsed.tempoMap[0]?.bpm ?? 120,
    },
    key,
    pitchClassHist: pitchClassHist.map((v) => round(v / (pitchClassHist.reduce((a, b) => a + b, 0) || 1), 4)),
    intervals: {
      hist: Object.fromEntries(intervalHist),
      stepRate: intervalCount ? round(steps / intervalCount, 3) : null,
      leapRate: intervalCount ? round(leaps / intervalCount, 3) : null,
      repeatRate: intervalCount ? round(repeats / intervalCount, 3) : null,
      samples: intervalCount,
    },
    rhythm: {
      grid16: grid16.map((v) => round(v / (notes.length || 1), 3)),
      offbeatRate: round(grid16.reduce((acc, v, i) => acc + (i % 4 !== 0 ? v : 0), 0) / (notes.length || 1), 3),
      offbeat8thRate: round(grid16.reduce((acc, v, i) => acc + (i % 4 === 2 ? v : 0), 0) / (notes.length || 1), 3),
      durationHist: Object.fromEntries(durationHist),
      gridDeviation16: round(gridDeviation, 4),
      swingRatio,
      densityPerBar: round(notes.length / bars, 2),
      tonalDensityPerBar: round(tonalNotes.length / bars, 2),
    },
    harmony: {
      changePerBar: round(chordChanges.length / bars, 2),
      changeCount: chordChanges.length,
      diatonicRate,
      qualityHist: Object.fromEntries(qualityHist),
      topProgressions: [...romanBigrams.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => [k, v]),
      progression: romanSequence.map((r) => r?.numeral ?? '?').slice(0, 32),
    },
    texture: {
      tracks,
      meanPolyphony,
      layerCount: tracks.filter((t) => !t.isDrum).length,
      drumTrackCount: tracks.filter((t) => t.isDrum).length,
      roles: countRoles(tracks),
    },
    dynamics: { velocityMean, velocityStd, accentByBeat },
    articulation,
    repetition,
  }
}

function countRoles(tracks) {
  const out = {}
  for (const t of tracks) out[t.role] = (out[t.role] ?? 0) + 1
  return out
}

function isMonophonic(sortedNotes) {
  if (sortedNotes.length < 3) return false
  let overlaps = 0
  for (let i = 1; i < sortedNotes.length; i++) {
    if (sortedNotes[i].startBeat < sortedNotes[i - 1].startBeat + sortedNotes[i - 1].durationBeat - 0.05) overlaps++
  }
  return overlaps / sortedNotes.length < 0.15
}

/** 逐拍扫描正在发声的音，识别和弦并合并相邻同名和弦 */
function scanChords(parsed, beatsPerBar, endBeat) {
  const notes = flattenNotes(parsed).filter((n) => n.channel !== DRUM_CHANNEL)
  notes.sort((a, b) => a.startBeat - b.startBeat)
  const totalBeats = Math.ceil(endBeat)
  if (totalBeats <= 0) return []

  const result = []
  let cursor = 0
  const active = []
  for (let beat = 0; beat < totalBeats; beat++) {
    // 移除已结束的音
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].startBeat + active[i].durationBeat <= beat + 0.001) active.splice(i, 1)
    }
    // 加入本拍之前开始的音
    while (cursor < notes.length && notes[cursor].startBeat <= beat + 0.001) {
      if (notes[cursor].startBeat + notes[cursor].durationBeat > beat + 0.001) active.push(notes[cursor])
      cursor++
    }
    const weights = new Map()
    for (const n of active) {
      const w = Math.min(n.durationBeat, 1)
      weights.set(n.pitch % 12, (weights.get(n.pitch % 12) ?? 0) + w)
    }
    const chord = detectChord(weights)
    result.push({ beat, chord: chord ? { ...chord, name: chordName(chord.root, chord.suffix) } : null })
  }
  return result
}

/** 小节级重复度：完全相同的「小节指纹」占比 */
function analyzeRepetition(parsed, beatsPerBar, bars) {
  const notes = flattenNotes(parsed).filter((n) => n.channel !== DRUM_CHANNEL)
  const perBar = new Map()
  for (const n of notes) {
    const bar = Math.floor(n.startBeat / beatsPerBar)
    const pos16 = Math.round((n.startBeat - bar * beatsPerBar) * 4) % Math.round(beatsPerBar * 4)
    const key = `${pos16}:${n.pitch % 12}`
    if (!perBar.has(bar)) perBar.set(bar, [])
    perBar.get(bar).push(key)
  }
  const signatures = []
  const barCount = Math.max(1, Math.round(bars))
  for (let bar = 0; bar < barCount; bar++) {
    const items = perBar.get(bar)
    signatures.push(items && items.length >= 2 ? [...items].sort().join('|') : null)
  }
  const valid = signatures.filter(Boolean)
  const unique = new Set(valid)
  const repeatRate = valid.length ? 1 - unique.size / valid.length : 0

  // 4 小节乐句重复率
  let phraseHits = 0
  let phraseChecks = 0
  for (let bar = 0; bar + 4 < signatures.length; bar++) {
    if (!signatures[bar] || !signatures[bar + 4]) continue
    phraseChecks++
    if (signatures[bar] === signatures[bar + 4]) phraseHits++
  }

  return {
    barCount: Math.round(bars),
    uniqueBarPatterns: unique.size,
    barRepeatRate: round(repeatRate, 3),
    phrase4RepeatRate: phraseChecks ? round(phraseHits / phraseChecks, 3) : null,
  }
}

/** 连断：平均时值 / 平均音间间隔；> 0.9 视为 legato 演奏 */
function analyzeArticulation(parsed) {
  const perTrack = []
  for (const track of parsed.tracks) {
    if (track.channels.includes(DRUM_CHANNEL) || !isMonophonic(track.notes)) continue
    const notes = [...track.notes].sort((a, b) => a.startBeat - b.startBeat)
    const iois = []
    for (let i = 1; i < notes.length; i++) iois.push(notes[i].startBeat - notes[i - 1].startBeat)
    const ratio = mean(iois) ? mean(notes.map((n) => n.durationBeat)) / mean(iois) : 0
    perTrack.push(round(clamp(ratio, 0, 2), 3))
  }
  const all = perTrack
  return {
    legatoRatio: all.length ? round(mean(all), 3) : null,
    staccatoRate: all.length ? round(all.filter((r) => r < 0.5).length / all.length, 3) : null,
    perTrack: all,
  }
}

/* ------------------------------------------------------------------ */
/* 质量闸门                                                             */
/* ------------------------------------------------------------------ */

/**
 * 语料准入检查（对应 docs/MIDI_CORPUS_STYLE_LEARNING.md 的「八道闸门」）。
 * @returns {{ok:boolean, tags:string[], reasons:string[]}}
 */
export function qualityGate(parsed, features) {
  const reasons = []
  const tags = []
  const summary = features.meta

  if (!summary.noteCount || summary.noteCount < 16) reasons.push('音符太少(<16)')
  if (summary.bars < 8) reasons.push('长度不足 8 小节')
  if (summary.bars > 400) reasons.push('长度异常(>400 小节)')

  const outOfRange = flattenNotes(parsed).filter((n) => n.pitch < 21 || n.pitch > 108).length
  if (outOfRange > summary.noteCount * 0.02) reasons.push('音高越界')

  const ghost = features.texture.tracks.filter((t) => t.noteCount < 4).length
  if (ghost) tags.push(`ghostTracks:${ghost}`)

  // 「机械力度」按轨道判断：只要每条有声轨道内部力度恒定，就是音源导出的死板数据，
  // 这种文件不能用于学习演奏层（力度/重音/人性化）。
  const tonalTracks = features.texture.tracks.filter((t) => !t.isDrum && t.noteCount >= 8)
  if (tonalTracks.length && tonalTracks.every((t) => t.velocityStd === 0)) tags.push('robotVelocity')
  if (features.rhythm.gridDeviation16 < 0.002 && summary.noteCount > 64) tags.push('overQuantized')
  if (!features.texture.drumTrackCount && features.meta.noteCount > 200) tags.push('noDrums')

  const drumNotes = flattenNotes(parsed).filter((n) => n.channel === DRUM_CHANNEL)
  if (drumNotes.some((n) => n.pitch < 27 || n.pitch > 87)) tags.push('gmDrumOutOfRange')

  return { ok: reasons.length === 0, tags, reasons }
}
