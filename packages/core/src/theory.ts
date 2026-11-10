/**
 * 乐理工具：音阶、和弦、级数、声部进行、对位、调性识别。
 * 前后端共用；不依赖任何运行时库（纯 TS，可在 Node / 浏览器 / Worker 中运行）。
 *
 * 设计约定：
 * - 一切「音高」都是 MIDI 音高（0-127，C4 = 60），一切「时间」都是拍（beat）。
 * - 音阶级数 degree 可正可负、可跨八度。
 * - 和弦都以 ChordSpec（根音 pitch-class + 性质 + 时值）表示。
 */
import {
  CHORDS,
  SCALES,
  NOTE_NAMES_SHARP,
  keyToPitchClass,
  type ChordQualityId,
  type ScaleId,
} from './constants.js'
import { createNote, type ChordSpec, type NoteEvent } from './model.js'

/* ------------------------------------------------------------------ */
/* 音阶                                                                */
/* ------------------------------------------------------------------ */

/** 音级 -> 半音偏移（自动跨八度） */
export function scaleInterval(scale: ScaleId, degree: number): { semitone: number; octave: number } {
  const intervals = SCALES[scale].intervals
  const len = intervals.length
  const oct = Math.floor(degree / len)
  const idx = ((degree % len) + len) % len
  return { semitone: intervals[idx], octave: oct }
}

/** 音阶级数 -> 绝对音高。degree 可为负、可超过一个八度 */
export function scaleDegreeToPitch(key: string, scale: ScaleId, degree: number, octave = 4): number {
  const root = keyToPitchClass(key)
  const { semitone, octave: oct } = scaleInterval(scale, degree)
  return (octave + 1) * 12 + root + semitone + oct * 12
}

/** 一个八度内的音阶音高（从主音开始） */
export function scalePitches(key: string, scale: ScaleId, octave = 4): number[] {
  const root = keyToPitchClass(key)
  return SCALES[scale].intervals.map((iv) => (octave + 1) * 12 + root + iv)
}

/** 多八度音阶音高，升序 */
export function allScalePitches(key: string, scale: ScaleId, lowOctave = 2, highOctave = 6): number[] {
  const out: number[] = []
  const len = SCALES[scale].intervals.length
  for (let oct = lowOctave; oct <= highOctave; oct++) {
    for (let d = 0; d < len; d++) out.push(scaleDegreeToPitch(key, scale, d, oct))
  }
  return out.filter((p) => p >= 0 && p <= 127)
}

/** 音高是否在调内 */
export function isInScale(pitch: number, key: string, scale: ScaleId): boolean {
  const pc = (((pitch - keyToPitchClass(key)) % 12) + 12) % 12
  return SCALES[scale].intervals.includes(pc)
}

/** 取调内最近音（用于吸附） */
export function snapToScale(pitch: number, key: string, scale: ScaleId, preferDown = false): number {
  if (isInScale(pitch, key, scale)) return pitch
  for (let d = 1; d <= 6; d++) {
    const up = pitch + d
    const down = pitch - d
    if (preferDown && isInScale(down, key, scale)) return down
    if (isInScale(up, key, scale)) return up
    if (isInScale(down, key, scale)) return down
  }
  return pitch
}

/**
 * 用于「配和声」的音阶：五声/布鲁斯/全音阶不是七声的，
 * 直接七度堆叠会得到奇怪的三和弦，这里映射到最接近的七声母音阶。
 */
export function harmonyScale(scale: ScaleId): ScaleId {
  switch (scale) {
    case 'pentatonicMajor':
      return 'major'
    case 'pentatonicMinor':
    case 'blues':
      return 'minor'
    case 'wholeTone':
    case 'chromatic':
      return 'major'
    default:
      return scale
  }
}

/** 音阶内所有音高（指定音域，升序），比 allScalePitches 更精确地收在音域内 */
export function scalePitchesInRange(key: string, scale: ScaleId, range: { min: number; max: number }): number[] {
  const out: number[] = []
  const lo = Math.max(0, Math.min(127, Math.floor(range.min)))
  const hi = Math.max(0, Math.min(127, Math.ceil(range.max)))
  for (let p = lo; p <= hi; p++) if (isInScale(p, key, scale)) out.push(p)
  return out
}

/** 音级名称（1-7），用于提示文案 */
export const DEGREE_NAMES = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'] as const

/* ------------------------------------------------------------------ */
/* 和弦                                                                */
/* ------------------------------------------------------------------ */

/** 和弦音高（绝对音高），默认把根音放在给定八度 */
export function chordPitches(chord: ChordSpec, octave = 4): number[] {
  const base = (octave + 1) * 12 + ((chord.root % 12) + 12) % 12
  return CHORDS[chord.quality].intervals.map((iv) => base + iv).filter((p) => p >= 0 && p <= 127)
}

/** 和弦音的 pitch-class 集合（含 bass 指定低音） */
export function chordPitchClasses(chord: ChordSpec): number[] {
  const root = ((chord.root % 12) + 12) % 12
  return CHORDS[chord.quality].intervals.map((iv) => (root + iv) % 12)
}

export function chordLabel(chord: ChordSpec): string {
  const root = NOTE_NAMES_SHARP[((chord.root % 12) + 12) % 12]
  return root + CHORDS[chord.quality].symbol
}

export function chordRootName(chord: ChordSpec): string {
  return NOTE_NAMES_SHARP[((chord.root % 12) + 12) % 12]
}

/** 和弦的转位：把最低 n 个音抬高八度 */
export function invertChord(pitches: number[], inversion: number, octaveSpan = 0): number[] {
  const out = [...pitches]
  const count = ((inversion % Math.max(1, out.length)) + out.length) % Math.max(1, out.length)
  for (let i = 0; i < count; i++) {
    out.push(out.shift()! + 12)
  }
  if (octaveSpan > 0) for (let i = 0; i < out.length; i++) out[i] += 12 * octaveSpan
  return out
}

/** 离给定音高最近的和弦音 */
export function nearestChordTone(pitch: number, chord: ChordSpec): number {
  const candidates = [-1, 0, 1].flatMap((oct) => chordPitches(chord, 4 + oct))
  return candidates.reduce((best, c) => (Math.abs(c - pitch) < Math.abs(best - pitch) ? c : best), candidates[0])
}

/** 在音域内、离 pitch 最近的和弦音（优先「不低于」） */
export function nearestChordToneInRange(
  pitch: number,
  chord: ChordSpec,
  range: { min: number; max: number },
  preferUp = true,
): number {
  const lo = Math.max(0, range.min - 12)
  const hi = Math.min(127, range.max + 12)
  const tones: number[] = []
  for (let oct = 0; oct <= 10; oct++) {
    for (const p of chordPitches(chord, oct)) if (p >= lo && p <= hi) tones.push(p)
  }
  if (!tones.length) return clampPitch(pitch, range)
  const sorted = [...new Set(tones)].sort((a, b) => a - b)
  let best = sorted[0]
  let bestCost = Infinity
  for (const tone of sorted) {
    const dist = Math.abs(tone - pitch)
    const dirPenalty = preferUp && tone < pitch ? 0.75 : 0
    const cost = dist + dirPenalty
    if (cost < bestCost) {
      bestCost = cost
      best = tone
    }
  }
  return clampPitch(best, range)
}

/** 和弦是否包含某个 pitch-class */
export function chordHasPitchClass(chord: ChordSpec, pc: number): boolean {
  return chordPitchClasses(chord).includes(((pc % 12) + 12) % 12)
}

/** 转调和弦 */
export function transposeChord(chord: ChordSpec, semitones: number): ChordSpec {
  const root = ((((chord.root + semitones) % 12) + 12) % 12) as number
  const out: ChordSpec = { ...chord, root, beats: chord.beats }
  if (typeof chord.bass === 'number') out.bass = ((((chord.bass + semitones) % 12) + 12) % 12) as number
  return out
}

/* ------------------------------------------------------------------ */
/* 罗马数字 <-> 和弦                                                   */
/* ------------------------------------------------------------------ */

const ROMAN_TABLE: Record<string, number> = {
  I: 0, II: 1, III: 2, IV: 3, V: 4, VI: 5, VII: 6,
  i: 0, ii: 1, iii: 2, iv: 3, v: 4, vi: 5, vii: 6,
}

const DEGREE_ROMAN_UPPER = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'] as const
const DEGREE_ROMAN_LOWER = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii'] as const

export interface ParsedRoman {
  degree: number
  accidental: number
  qualityOverride?: ChordQualityId
  seventh?: boolean
  minor: boolean
}

const ROMAN_QUALITY_SUFFIXES: { match: string[]; quality: ChordQualityId; seventh?: boolean }[] = [
  { match: ['maj9'], quality: 'maj9' },
  { match: ['maj7'], quality: 'maj7', seventh: true },
  { match: ['m7b5', 'ø7', 'ø'], quality: 'm7b5', seventh: true },
  { match: ['m9'], quality: 'min9' },
  { match: ['m7'], quality: 'min7', seventh: true },
  { match: ['m6'], quality: 'm6' },
  { match: ['mmaj7'], quality: 'mMaj7', seventh: true },
  { match: ['add9'], quality: 'add9' },
  { match: ['dim7', '°7', 'o7'], quality: 'dim7', seventh: true },
  { match: ['dim', '°', 'o'], quality: 'dim' },
  { match: ['aug', '+'], quality: 'aug' },
  { match: ['sus4', 'sus'], quality: 'sus4' },
  { match: ['sus2'], quality: 'sus2' },
  { match: ['9'], quality: 'dom9' },
  { match: ['7'], quality: 'dom7', seventh: true },
  { match: ['6'], quality: 'six' },
  { match: ['5'], quality: 'power' },
]

/** 解析 `bVII7`、`iv`、`Vmaj7`、`iii°`、`iiø7` 之类 */
export function parseRoman(roman: string): ParsedRoman | null {
  const src = roman.trim()
  if (!src) return null
  let i = 0
  let accidental = 0
  while (i < src.length && (src[i] === 'b' || src[i] === '#')) {
    accidental += src[i] === 'b' ? -1 : 1
    i++
  }
  let numeral = ''
  while (i < src.length && /[IViv]/.test(src[i])) {
    numeral += src[i]
    i++
  }
  if (!numeral) return null
  const degree = ROMAN_TABLE[numeral]
  if (degree === undefined) return null
  const minor = numeral === numeral.toLowerCase()
  const suffix = src.slice(i).trim().toLowerCase()
  let qualityOverride: ChordQualityId | undefined
  let seventh = false
  for (const entry of ROMAN_QUALITY_SUFFIXES) {
    if (entry.match.some((m) => suffix.startsWith(m) || suffix === m)) {
      qualityOverride = entry.quality
      seventh = entry.seventh ?? entry.quality.includes('7')
      break
    }
  }
  // 小写罗马数字 + 7 = 小七（ii7 / vi7），不是属七
  if (qualityOverride === 'dom7' && minor) qualityOverride = 'min7'
  if (qualityOverride === 'dom9' && minor) qualityOverride = 'min9'
  return { degree, accidental, qualityOverride, seventh, minor }
}

/** 调内音阶堆叠出的三和弦（默认七和弦可选） */
export function diatonicChord(key: string, scale: ScaleId, degree: number, seventh = false): ChordSpec {
  const useScale = harmonyScale(scale)
  const rootPitch = scaleDegreeToPitch(key, useScale, degree, 4)
  const third = scaleDegreeToPitch(key, useScale, degree + 2, 4) - rootPitch
  const fifth = scaleDegreeToPitch(key, useScale, degree + 4, 4) - rootPitch
  const sev = scaleDegreeToPitch(key, useScale, degree + 6, 4) - rootPitch
  let quality: ChordQualityId = 'maj'
  if (third === 4 && fifth === 7) quality = seventh ? (sev === 11 ? 'maj7' : 'dom7') : 'maj'
  else if (third === 3 && fifth === 7) quality = seventh ? (sev === 10 ? 'min7' : 'mMaj7') : 'min'
  else if (third === 3 && fifth === 6) quality = seventh ? 'm7b5' : 'dim'
  else if (third === 2 && fifth === 7) quality = seventh ? 'm7b5' : 'sus2'
  else if (third === 5 && fifth === 7) quality = seventh ? 'dom7' : 'sus4'
  else if (third === 4 && fifth === 8) quality = seventh ? 'aug' : 'aug'
  else if (third === 3 && fifth === 8) quality = 'aug'
  return { root: ((rootPitch % 12) + 12) % 12, quality, beats: 4 }
}

/** 调内 7 个三和弦（或七和弦） */
export function diatonicChords(key: string, scale: ScaleId, seventh = false): ChordSpec[] {
  const out: ChordSpec[] = []
  for (let d = 0; d < 7; d++) out.push(diatonicChord(key, scale, d, seventh))
  return out
}

/** 依大小写修正和弦性质（大写 = 大/属，小写 = 小/减） */
function applyRomanCase(quality: ChordQualityId, minor: boolean): ChordQualityId {
  const toMinor: Partial<Record<ChordQualityId, ChordQualityId>> = {
    maj: 'min',
    maj7: 'min7',
    maj9: 'min9',
    dom7: 'min7',
    dom9: 'min9',
    six: 'm6',
  }
  // 大写罗马数字 + 7 = 属七（V7 / II7 等），不是大七
  const toMajor: Partial<Record<ChordQualityId, ChordQualityId>> = {
    min: 'maj',
    min7: 'dom7',
    min9: 'dom9',
    m6: 'six',
    mMaj7: 'maj7',
  }
  if (minor) return toMinor[quality] ?? quality
  return toMajor[quality] ?? quality
}

/** 罗马数字 -> 和弦（自动补正调内性质） */
export function romanToChord(roman: string, key: string, scale: ScaleId, beats = 4): ChordSpec | null {
  const parsed = parseRoman(roman)
  if (!parsed) return null
  const diatonic = diatonicChord(key, scale, parsed.degree, parsed.seventh)
  let quality = parsed.qualityOverride ?? diatonic.quality
  if (!parsed.qualityOverride) {
    if (parsed.accidental !== 0) {
      // 借用和弦（bVII / bVI / bII…）：性质由大小写决定，而不是沿用调内级数
      quality = parsed.minor ? (parsed.seventh ? 'min7' : 'min') : parsed.seventh ? 'dom7' : 'maj'
    } else {
      quality = applyRomanCase(quality, parsed.minor)
    }
  }
  const root = (((diatonic.root + parsed.accidental) % 12) + 12) % 12
  return { root, quality, beats }
}

/** 解析整个进行，如 ['i', 'VI', 'III', 'VII'] */
export function progressionToChords(
  progression: string[],
  key: string,
  scale: ScaleId,
  beatsPerChord = 4,
): ChordSpec[] {
  const out: ChordSpec[] = []
  for (const roman of progression) {
    const chord = romanToChord(roman, key, scale, beatsPerChord)
    if (chord) out.push(chord)
    else out.push({ root: keyToPitchClass(key), quality: 'maj', beats: beatsPerChord })
  }
  return out
}

/** 和弦 -> 罗马数字（转调/替和弦 UI 用） */
export function chordToRoman(
  chord: ChordSpec,
  key: string,
  scale: ScaleId,
  opts: { seventh?: boolean } = {},
): string {
  const useScale = harmonyScale(scale)
  const root = ((chord.root % 12) + 12) % 12
  const intervals = SCALES[useScale].intervals
  const keyPc = keyToPitchClass(key)
  let bestDegree = 0
  let bestDiff = 99
  for (let d = 0; d < 7; d++) {
    const iv = intervals[d % intervals.length]
    let diff = root - ((keyPc + iv) % 12)
    while (diff > 6) diff -= 12
    while (diff < -6) diff += 12
    if (Math.abs(diff) < Math.abs(bestDiff)) {
      bestDiff = diff
      bestDegree = d
    }
  }
  const accidentals = bestDiff < 0 ? 'b'.repeat(-bestDiff) : '#'.repeat(bestDiff)
  const minorQuality =
    chord.quality === 'min' || chord.quality === 'min7' || chord.quality === 'min9' || chord.quality === 'm6' || chord.quality === 'mMaj7'
  const numeral = (minorQuality ? DEGREE_ROMAN_LOWER : DEGREE_ROMAN_UPPER)[bestDegree]
  const suffix: Record<ChordQualityId, string> = {
    maj: '',
    min: '',
    dim: '°',
    aug: '+',
    sus2: 'sus2',
    sus4: 'sus4',
    maj7: 'maj7',
    min7: '7',
    dom7: '7',
    m7b5: 'ø7',
    dim7: '°7',
    mMaj7: 'mMaj7',
    maj9: 'maj9',
    min9: '9',
    dom9: '9',
    add9: 'add9',
    six: '6',
    m6: 'm6',
    power: '5',
  }
  const base = `${accidentals}${numeral}${suffix[chord.quality] ?? ''}`
  if (opts.seventh && !base.match(/7|9|6|5/)) return `${accidentals}${numeral}7`
  return base
}

/** 调内 7 个级数的罗马数字（UI 和弦选择器用） */
export function romanNumerals(key: string, scale: ScaleId, seventh = false): string[] {
  return diatonicChords(key, scale, seventh).map((c) => chordToRoman(c, key, scale, { seventh }))
}

/** 常用进行库（按风格） */
export const PROGRESSION_PRESETS: { id: string; name: string; styles: string[]; romans: string[] }[] = [
  { id: 'axis', name: '流行万能进行', styles: ['pop', 'rock'], romans: ['I', 'V', 'vi', 'IV'] },
  { id: 'canon', name: '卡农进行', styles: ['classical', 'pop'], romans: ['I', 'V', 'vi', 'iii', 'IV', 'I', 'IV', 'V'] },
  { id: 'minorEpic', name: '史诗小调', styles: ['cinematic', 'electronic', 'jrpg'], romans: ['i', 'VI', 'III', 'VII'] },
  { id: 'jazz251', name: '爵士 II-V-I', styles: ['jazz'], romans: ['ii7', 'V7', 'Imaj7', 'Imaj7'] },
  { id: 'blues', name: '12 小节布鲁斯', styles: ['jazz', 'rock'], romans: ['I7', 'I7', 'I7', 'I7', 'IV7', 'IV7', 'I7', 'I7', 'V7', 'IV7', 'I7', 'V7'] },
  { id: 'phrygian', name: '弗里吉亚进行', styles: ['cinematic', 'rock'], romans: ['i', 'bII', 'bVII', 'i'] },
  { id: 'edm', name: 'EDM 循环', styles: ['electronic'], romans: ['vi', 'IV', 'I', 'V'] },
  { id: 'ballad', name: '抒情进行', styles: ['pop', 'folk'], romans: ['I', 'iii', 'IV', 'V'] },
  { id: 'andalusian', name: '安达卢西亚终止', styles: ['classical', 'folk', 'rock'], romans: ['i', 'bVII', 'bVI', 'V'] },
  { id: 'royalRoad', name: '王道进行', styles: ['pop', 'jazz', 'folk', 'jrock'], romans: ['IV', 'V', 'iii', 'vi'] },
]

/** 把和弦序列按时值平铺成时间轴（拍） */
export function chordTimeline(chords: ChordSpec[]): { chord: ChordSpec; startBeat: number; endBeat: number }[] {
  const out: { chord: ChordSpec; startBeat: number; endBeat: number }[] = []
  let cursor = 0
  for (const chord of chords) {
    const beats = chord.beats > 0 ? chord.beats : 4
    out.push({ chord, startBeat: cursor, endBeat: cursor + beats })
    cursor += beats
  }
  return out
}

/** 取某一拍位置的和弦 */
export function chordAtBeat(chords: ChordSpec[], beat: number): ChordSpec {
  const timeline = chordTimeline(chords)
  for (const slot of timeline) {
    if (beat >= slot.startBeat && beat < slot.endBeat) return slot.chord
  }
  if (timeline.length) return timeline[timeline.length - 1].chord
  return { root: 0, quality: 'maj', beats: 4 }
}

/** 取某一拍位置的和弦槽位（含起止） */
export function chordSlotAtBeat(
  chords: ChordSpec[],
  beat: number,
): { chord: ChordSpec; startBeat: number; endBeat: number; index: number } {
  const timeline = chordTimeline(chords)
  for (let i = 0; i < timeline.length; i++) {
    const slot = timeline[i]
    if (beat >= slot.startBeat && beat < slot.endBeat) return { ...slot, index: i }
  }
  if (timeline.length) return { ...timeline[timeline.length - 1], index: timeline.length - 1 }
  return { chord: { root: 0, quality: 'maj', beats: 4 }, startBeat: 0, endBeat: 4, index: 0 }
}

/** 下一个和弦（用于预备音 / 切分提前量） */
export function nextChord(chords: ChordSpec[], index: number): ChordSpec | null {
  if (!chords.length) return null
  return chords[(index + 1) % chords.length]
}

/* ------------------------------------------------------------------ */
/* 调性识别 / 旋律分析                                                 */
/* ------------------------------------------------------------------ */

/** 调式各音级的权重（主音最高，五度/三度其次） */
const DEGREE_WEIGHTS = [6.3, 3.1, 4.6, 3.3, 5.2, 3.8, 2.9]
const CHROMATIC_WEIGHT = 1.55
const CANDIDATE_SCALES: ScaleId[] = [
  'major',
  'minor',
  'dorian',
  'mixolydian',
  'lydian',
  'phrygian',
  'harmonicMinor',
  'melodicMinor',
  'pentatonicMajor',
  'pentatonicMinor',
  'blues',
  'locrian',
]
const SCALE_PRIOR: Partial<Record<ScaleId, number>> = {
  major: 0.035,
  minor: 0.03,
  dorian: 0.012,
  mixolydian: 0.012,
  harmonicMinor: 0.01,
  melodicMinor: 0.008,
  pentatonicMajor: 0.006,
  pentatonicMinor: 0.006,
  blues: 0.004,
  lydian: 0.004,
  phrygian: 0.004,
  locrian: 0.001,
}

function scaleProfile(scale: ScaleId, rootPc: number): number[] {
  const profile: number[] = new Array(12).fill(CHROMATIC_WEIGHT)
  const intervals = SCALES[scale].intervals
  for (let d = 0; d < intervals.length; d++) {
    const pc = (rootPc + intervals[d]) % 12
    // 五声音阶用 7 级权重截断，保证主音/三度/五度的相对重要性
    profile[pc] = DEGREE_WEIGHTS[d % DEGREE_WEIGHTS.length]
  }
  return profile
}

function correlation(hist: number[], profile: number[]): number {
  let num = 0
  let d1 = 0
  let d2 = 0
  for (let i = 0; i < 12; i++) {
    num += hist[i] * profile[i]
    d1 += hist[i] * hist[i]
    d2 += profile[i] * profile[i]
  }
  const den = Math.sqrt(d1 * d2) || 1
  return num / den
}

/**
 * 用音级分布猜调性（Krumhansl 思想的加权扩展版）。
 * - 支持 12 个调 × 常见调式；
 * - 可用和弦做加权（chords 参数），让「旋律 + 和声」一起判断；
 * - 首尾音会得到额外权重（旋律通常终止在主音）。
 */
export function detectKey(
  notes: NoteEvent[],
  chords: ChordSpec[] = [],
): { key: string; scale: ScaleId; confidence: number } {
  const hist = new Array(12).fill(0)
  for (const note of notes) {
    const pc = ((note.pitch % 12) + 12) % 12
    hist[pc] += Math.max(0.25, note.duration) * (0.35 + note.velocity / 127)
  }
  for (const chord of chords) {
    const weight = Math.max(0.5, chord.beats) * 0.5
    for (const pc of chordPitchClasses(chord)) hist[pc] += weight
    hist[((chord.root % 12) + 12) % 12] += weight * 0.8
  }
  if (hist.every((v) => v === 0)) return { key: 'C', scale: 'major', confidence: 0 }

  const sorted = [...notes].sort((a, b) => a.start - b.start)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (first) hist[((first.pitch % 12) + 12) % 12] += 1.2
  if (last) hist[((last.pitch % 12) + 12) % 12] += 2.2

  let best = { key: 'C', scale: 'major' as ScaleId, confidence: -Infinity }
  for (const scale of CANDIDATE_SCALES) {
    // 音数越少的音阶（五声/布鲁斯）越容易被误判，按缺失音级扣分
    const completeness = Math.min(7, SCALES[scale].intervals.length)
    const subsetPenalty = (7 - completeness) * 0.022
    for (let root = 0; root < 12; root++) {
      const profile = scaleProfile(scale, root)
      const score = correlation(hist, profile) + (SCALE_PRIOR[scale] ?? 0) - subsetPenalty
      if (score > best.confidence) best = { key: NOTE_NAMES_SHARP[root], scale, confidence: score }
    }
  }
  return { key: best.key, scale: best.scale, confidence: Math.max(0, Math.min(1, best.confidence)) }
}

/** 只根据和弦进行猜调性 */
export function detectKeyFromChords(chords: ChordSpec[]): { key: string; scale: ScaleId; confidence: number } {
  return detectKey([], chords)
}

export interface MelodyAnalysis {
  noteCount: number
  minPitch: number
  maxPitch: number
  spanBeats: number
  rhythmDensity: number
  avgVelocity: number
  contour: number
  inScaleRatio: number
  avgInterval: number
  /** 出现次数最多的音级（0-11） */
  strongestPitchClass: number
}

/** 旋律体检：音域/密度/轮廓/调内比例，编曲与提示用 */
export function analyzeMelody(notes: NoteEvent[], key: string, scale: ScaleId): MelodyAnalysis {
  if (!notes.length) {
    return {
      noteCount: 0,
      minPitch: 60,
      maxPitch: 60,
      spanBeats: 0,
      rhythmDensity: 0,
      avgVelocity: 0,
      contour: 0,
      inScaleRatio: 0,
      avgInterval: 0,
      strongestPitchClass: 0,
    }
  }
  const pitches = notes.map((n) => n.pitch)
  const sortedByTime = [...notes].sort((a, b) => a.start - b.start)
  const spanBeats = Math.max(...notes.map((n) => n.start + n.duration))
  const inScale = notes.filter((n) => isInScale(n.pitch, key, scale)).length
  let intervalSum = 0
  for (let i = 1; i < sortedByTime.length; i++) intervalSum += Math.abs(sortedByTime[i].pitch - sortedByTime[i - 1].pitch)
  const hist = new Array(12).fill(0)
  for (const n of notes) hist[n.pitch % 12] += 1
  let strongest = 0
  for (let i = 1; i < 12; i++) if (hist[i] > hist[strongest]) strongest = i
  return {
    noteCount: notes.length,
    minPitch: Math.min(...pitches),
    maxPitch: Math.max(...pitches),
    spanBeats,
    rhythmDensity: spanBeats > 0 ? notes.length / spanBeats : 0,
    avgVelocity: notes.reduce((a, n) => a + n.velocity, 0) / notes.length,
    contour: melodicContour(sortedByTime.map((n) => n.pitch)),
    inScaleRatio: inScale / notes.length,
    avgInterval: sortedByTime.length > 1 ? intervalSum / (sortedByTime.length - 1) : 0,
    strongestPitchClass: strongest,
  }
}

/* ------------------------------------------------------------------ */
/* 旋律配和声（先有旋律，后配和声）                                     */
/* ------------------------------------------------------------------ */

export interface HarmonizeOptions {
  /** 使用七和弦（爵士/影视更合适） */
  seventh?: boolean
  /** 终止式偏好：末小节回到主和弦 */
  cadence?: boolean
  /** 每小节窗口内的强拍位置（拍），默认 [0, 2]（4/4） */
  strongBeats?: number[]
  /** 是否允许副属和弦（V/x）染色 */
  secondaryDominants?: boolean
}

/**
 * 根据旋律音高推断和弦（每个窗口一个和弦），用于「先有旋律，后配和声」。
 * 采用加权音级匹配 + 强拍优先 + 终止式偏好 + 避免原位重复。
 */
export function harmonizeMelody(
  notes: NoteEvent[],
  key: string,
  scale: ScaleId,
  windowBeats = 4,
  totalBeats?: number,
  opts: HarmonizeOptions = {},
): ChordSpec[] {
  const useScale = harmonyScale(scale)
  if (!notes.length) return [{ root: keyToPitchClass(key), quality: 'maj', beats: windowBeats }]
  const end = totalBeats ?? Math.max(...notes.map((n) => n.start + n.duration))
  const windows = Math.max(1, Math.ceil(end / windowBeats))
  const strongBeats = opts.strongBeats ?? [0, windowBeats / 2]
  const diatonic = diatonicChords(key, useScale, Boolean(opts.seventh))
  const result: ChordSpec[] = []
  let previousRoot = -1
  let repeats = 0

  for (let w = 0; w < windows; w++) {
    const from = w * windowBeats
    const to = from + windowBeats
    const inWindow = notes.filter((n) => n.start + n.duration > from + 1e-6 && n.start < to - 1e-6)
    const weights = new Array(12).fill(0)
    for (const note of inWindow) {
      const overlap = Math.min(to, note.start + note.duration) - Math.max(from, note.start)
      const local = note.start - from
      const onStrong = strongBeats.some((b) => Math.abs(((local - b) % windowBeats + windowBeats) % windowBeats) < 0.26)
      weights[((note.pitch % 12) + 12) % 12] += Math.max(0.1, overlap) * (0.4 + note.velocity / 127) * (onStrong ? 1.6 : 0.7)
    }

    const candidates: { chord: ChordSpec; degree: number }[] = diatonic.map((chord, degree) => ({ chord, degree }))
    if (opts.secondaryDominants) {
      for (let degree = 1; degree < 7; degree++) {
        const target = diatonic[degree]
        candidates.push({ chord: { root: (target.root + 7) % 12, quality: 'dom7', beats: windowBeats }, degree: 4 })
      }
    }

    let bestChord = diatonic[0]
    let bestDegree = 0
    let bestScore = -Infinity
    for (const { chord, degree } of candidates) {
      const tones = chordPitchClasses(chord)
      let score = 0
      for (const pc of tones) score += weights[pc]
      score += weights[chord.root] * 0.7
      // 三音（色彩音）额外加权，避免只靠根音/五度选中空洞和弦
      const third = tones[1]
      if (typeof third === 'number') score += weights[third] * 0.25
      if (degree === 0) score += 0.45
      if (degree === 4) score += 0.35
      if (degree === 5) score += 0.15
      if (opts.cadence !== false) {
        if (w === windows - 1 && degree === 0) score += 1.1
        if (w === windows - 2 && (degree === 4 || degree === 3)) score += 0.45
        if (w === 0 && degree === 0) score += 0.55
      }
      if (chord.root === previousRoot) score -= repeats >= 1 ? 0.9 : 0.18
      if (score > bestScore) {
        bestScore = score
        bestChord = chord
        bestDegree = degree
      }
    }
    if (bestChord.root === previousRoot) repeats += 1
    else repeats = 0
    previousRoot = bestChord.root
    result.push({ root: bestChord.root, quality: bestChord.quality, beats: windowBeats })
    void bestDegree
  }
  return result
}

/* ------------------------------------------------------------------ */
/* 声部进行                                                            */
/* ------------------------------------------------------------------ */

interface VoicingCostOptions {
  previous?: number[]
  /** 低音允许的最低音 */
  lowBound?: number
  /** 高音允许的最高音 */
  highBound?: number
}

function voicingCost(voicing: number[], opts: VoicingCostOptions): number {
  const low = opts.lowBound ?? 30
  const high = opts.highBound ?? 96
  const sorted = [...voicing].sort((a, b) => a - b)
  let cost = 0
  if (sorted[0] < low) cost += (low - sorted[0]) * 2.5
  const top = sorted[sorted.length - 1]
  if (top > high) cost += (top - high) * 2
  const spread = top - sorted[0]
  if (spread > 28) cost += (spread - 28) * 0.9
  if (spread < 10) cost += (10 - spread) * 0.8
  const prev = opts.previous
  if (prev) {
    const p = [...prev].sort((a, b) => a - b)
    const n = Math.min(p.length, sorted.length)
    for (let i = 0; i < n; i++) cost += Math.abs(p[i] - sorted[i])
    cost += Math.abs(p[p.length - 1] - top) * 0.8
    // 共同音保持（重合音数量奖励）
    const common = p.filter((v) => sorted.some((s) => Math.abs(s - v) <= 1)).length
    cost -= common * 1.6
  }
  return cost
}

function chordVoicingCandidates(chord: ChordSpec, octave: number): number[][] {
  const base = chordPitches(chord, octave)
  const candidates: number[][] = []
  const inversions = Math.min(4, base.length)
  for (let inversion = 0; inversion < inversions; inversion++) {
    const inverted = invertChord(base, inversion)
    for (let oct = -1; oct <= 1; oct++) {
      const shifted = inverted.map((p) => p + oct * 12)
      if (shifted.every((p) => p >= 12 && p <= 120)) candidates.push(shifted)
    }
  }
  return candidates
}

/**
 * 声部进行优化：为每个和弦选择一个转位，使相邻和弦的声部移动最小。
 * 返回各和弦音的绝对音高（升序排列，可直接写成音符）。
 */
export function voiceLeadChords(
  chords: ChordSpec[],
  octave = 3,
  range?: { min: number; max: number },
): number[][] {
  const result: number[][] = []
  let previous: number[] | undefined
  for (const chord of chords) {
    let best = chordPitches(chord, octave)
    let bestCost = Infinity
    for (const candidate of chordVoicingCandidates(chord, octave)) {
      const cost = voicingCost(candidate, {
        previous,
        lowBound: range ? Math.max(0, range.min) : 34,
        highBound: range ? Math.min(127, range.max) : 92,
      })
      if (cost < bestCost) {
        bestCost = cost
        best = candidate
      }
    }
    const sorted = [...best].sort((a, b) => a - b)
    result.push(sorted)
    previous = sorted
  }
  return result
}

/**
 * 和弦声部的「铺开」写法：低音 + 内声部 + 高音旋律线，用于 pad / 弦乐 / 风琴。
 * 返回分组：bass（单音）、inner（和弦内声部）、top（顶声部）。
 */
export function spreadVoicing(
  chord: ChordSpec,
  octave: number,
  range?: { min: number; max: number },
): { bass: number; inner: number[]; top: number } {
  const tones = chordPitches(chord, octave)
  const lo = range?.min ?? 36
  const hi = range?.max ?? 92
  const bass = clampPitch(tones[0] - 12, { min: Math.max(lo, 24), max: Math.max(lo + 12, hi - 24) })
  const inner = tones.slice(1, Math.max(2, tones.length - 1)).map((p) => clampPitch(p, { min: lo, max: hi }))
  const top = clampPitch(tones[tones.length - 1] + 12, { min: lo, max: hi })
  return { bass, inner, top }
}

/* ------------------------------------------------------------------ */
/* 对位                                                                */
/* ------------------------------------------------------------------ */

/** 强拍可用音程（相对参考声部，取模 12）：小三/大三/纯四/纯五/小六/大六/八度 */
const CONSONANT_STRONG = [3, 4, 5, 7, 8, 9, 0]

function isConsonant(interval: number): boolean {
  const mod = ((Math.abs(interval) % 12) + 12) % 12
  return CONSONANT_STRONG.includes(mod)
}

export interface CounterpointOptions {
  key: string
  scale: ScaleId
  chords: ChordSpec[]
  /** 对位声部音域 */
  range: { min: number; max: number }
  /** 与参考声部的关系：'below' 低八度（大提琴/贝斯），'above' 高八度（长笛/小提琴） */
  register?: 'below' | 'above'
  /** 音符密度 0..1 */
  density?: number
  /** 起始拍 */
  startBeat?: number
  /** 结束拍（不含） */
  endBeat?: number
  seed?: number
  /** 力度基准 */
  velocity?: number
}

/**
 * 依据参考旋律写一条对位副旋律：
 * - 反向进行优先（参考上行 -> 对位下行）；
 * - 强拍落在和弦音 / 协和音程上；
 * - 节奏互补（参考长音时对位走动，参考密集时对位拉长）；
 * - 音域与参考声部错开，避免同度与声部交叉。
 */
export function counterpointAgainst(reference: NoteEvent[], opts: CounterpointOptions): NoteEvent[] {
  const ref = [...reference].filter((n) => n.duration > 0).sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  if (!ref.length) return []
  const startBeat = opts.startBeat ?? 0
  const endBeat = opts.endBeat ?? Math.max(...ref.map((n) => n.start + n.duration))
  const density = Math.max(0.05, Math.min(1, opts.density ?? 0.5))
  const range = opts.range
  const register = opts.register ?? 'below'
  const chords = opts.chords.length ? opts.chords : [{ root: keyToPitchClass(opts.key), quality: 'maj' as ChordQualityId, beats: 4 }]
  const velocity = opts.velocity ?? 76
  const out: NoteEvent[] = []

  // 参考声部的平均音高，用来把对位声部放在它的另一侧
  const refAvg = ref.reduce((a, n) => a + n.pitch, 0) / ref.length
  const placementTarget = register === 'above' ? Math.min(range.max, Math.max(range.min, refAvg + 9)) : Math.max(range.min, Math.min(range.max, refAvg - 9))

  let prevPitch = placementTarget
  let prevDirection = 0

  const chordFor = (beat: number) => chordAtBeat(chords, beat)

  for (let i = 0; i < ref.length; i++) {
    const note = ref[i]
    if (note.start < startBeat || note.start >= endBeat) continue
    const next = i + 1 < ref.length ? ref[i + 1] : null
    const chord = chordFor(note.start)
    const strong = Math.abs(note.start - Math.round(note.start / 4) * 4) < 0.01 || Math.abs(note.start % 2) < 0.01
    const refMove = next ? next.pitch - note.pitch : 0
    // 节奏互补：参考长音 -> 对位切分；参考短音 -> 对位拉长
    const longRef = note.duration >= 1.5
    const shortRef = note.duration <= 0.5
    const segmentStart = Math.max(note.start, startBeat)
    const segmentEnd = Math.min(next ? next.start : endBeat, endBeat)
    const span = Math.max(note.duration, segmentEnd - segmentStart)
    const pieces = longRef && density > 0.35 ? 2 : shortRef ? 1 : density > 0.6 ? 2 : 1
    const pieceLen = span / pieces

    for (let p = 0; p < pieces; p++) {
      const start = segmentStart + p * pieceLen
      if (start >= endBeat - 1e-6) break
      // 只在密度允许时填充后半段（变得像真乐句）
      if (p > 0 && density < 0.35 && (i + p) % 2 === 0) continue
      const dirWanted = refMove > 1 ? -1 : refMove < -1 ? 1 : prevDirection === 0 ? -1 : -prevDirection
      const strongHere = strong && p === 0
      let target: number
      if (strongHere) {
        target = nearestChordToneInRange(prevPitch, chord, range, dirWanted > 0)
      } else {
        // 弱拍走音阶（经过音），并保持与参考声部的协和优先
        const scalePitches = scalePitchesInRange(opts.key, opts.scale, {
          min: Math.max(range.min, prevPitch - 5),
          max: Math.min(range.max, prevPitch + 5),
        })
        const pool = scalePitches.filter((p) => p !== prevPitch)
        const consonant = pool.filter((p) => isConsonant(p - note.pitch))
        const candidates = consonant.length ? consonant : pool.length ? pool : [prevPitch + dirWanted * 2]
        const wanted = prevPitch + dirWanted * (density > 0.6 ? 2 : 1)
        target = candidates.reduce((best, p) => (Math.abs(p - wanted) < Math.abs(best - wanted) ? p : best), candidates[0])
      }
      let pitch = clampPitch(target, range)
      if (Math.abs(pitch - note.pitch) % 12 === 0 && pitch !== note.pitch) {
        // 避免与参考形成平行八度/同度
        pitch = clampPitch(pitch + dirWanted * 3, range)
      }
      if (Math.abs(pitch - note.pitch) < 2) pitch = clampPitch(pitch + dirWanted * 4, range)
      const dur = Math.max(0.12, Math.min(pieceLen * 0.94, endBeat - start))
      const vel = Math.max(1, Math.min(127, Math.round(velocity + (strongHere ? 10 : -4) + (p === 0 ? 0 : -6))))
      out.push(createNote(pitch, start, dur, vel))
      if (pitch !== prevPitch) prevDirection = pitch > prevPitch ? 1 : -1
      prevPitch = pitch
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 其他                                                                */
/* ------------------------------------------------------------------ */

/** 旋律轮廓方向：+1 上行，-1 下行，0 平稳 */
export function melodicContour(pitches: number[]): number {
  if (pitches.length < 2) return 0
  const delta = pitches[pitches.length - 1] - pitches[0]
  if (delta > 2) return 1
  if (delta < -2) return -1
  return 0
}

/** 把音高限制到指定音域 */
export function clampPitch(pitch: number, range: { min: number; max: number }): number {
  let p = pitch
  let guard = 0
  while (p < range.min && guard++ < 10) p += 12
  guard = 0
  while (p > range.max && guard++ < 10) p -= 12
  return Math.min(127, Math.max(0, p))
}

/** 音程名称（半音数，取模 12，升序） */
export function intervalLabel(semitones: number): string {
  const names = ['纯 1 度', '小二度', '大二度', '小三度', '大三度', '纯四度', '增四度', '纯五度', '小六度', '大六度', '小七度', '大七度']
  const mod = ((Math.abs(semitones) % 12) + 12) % 12
  return names[mod]
}

/** 两个音的音程（带方向） */
export function intervalBetween(a: number, b: number): number {
  return b - a
}

/** 五度圈位置（-1 未知） */
export function circleOfFifths(key: string): number {
  const pc = keyToPitchClass(key)
  const order = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]
  return order.indexOf(pc)
}

/** 关系小调 / 关系大调 */
export function relativeKey(key: string, scale: ScaleId): { key: string; scale: ScaleId } {
  const pc = keyToPitchClass(key)
  if (scale === 'major') return { key: NOTE_NAMES_SHARP[(pc + 9) % 12], scale: 'minor' }
  return { key: NOTE_NAMES_SHARP[(pc + 3) % 12], scale: 'major' }
}

/** 拍点量化 */
export function quantizeBeat(beat: number, grid = 0.25): number {
  return Math.round(beat / grid) * grid
}
