/**
 * 工具参数归一化 / 校验层（在 executeTool 的 handler 之前统一执行）。
 *
 * 目标：模型经常给出「人类写法」的参数（"0.7"、POP、Drums、C4、Am、Bb、
 * { startBeat, lengthBeats } 的段落、字符串和弦 …），旧代码要么静默忽略、
 * 要么解析错（"Am" 被当成 A 大三和弦）。这里按每个工具的 JSON Schema 做
 * 宽松归一化 + 必填校验：
 *
 * - 数字字符串 → number，数字字符串布尔 → boolean；
 * - 枚举大小写不敏感 + 常见别名（POP→pop、Drums→drums、major→maj …）；
 * - notes[].pitch 支持音名（C4 / F#3 / Bb2）与数字字符串 → MIDI 音高；
 * - chords 支持降号根音（Bb→10）与字符串和弦（"Am" / "F#m7"）；
 * - key / scale / quality 统一别名；
 * - sections 支持 { startBar, bars } 或 { startBeat, lengthBeats }（按拍号换算）；
 * - 未知属性静默丢弃；校验失败返回 ok:false（message ≤ 400 字符），绝不半执行。
 */
import {
  CHORDS,
  KEYS,
  SCALES,
  beatsPerBar,
  getInstrument,
  hasInstrument,
  listInstruments,
  nameToPitch,
  type ChordQualityId,
  type EmotionPreset,
  type ScaleId,
} from '@aiab/core'
import type { ToolContext, ToolDef } from './schema.js'

const MAX_MESSAGE_CHARS = 400

export const KEY_VALUES = [...KEYS] as string[]
export const QUALITY_IDS = Object.keys(CHORDS) as ChordQualityId[]
export const SCALE_IDS = Object.keys(SCALES) as ScaleId[]

const NOTE_NAMES = KEY_VALUES

/* ------------------------------ 小工具 ------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asSchema(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {}
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const text = value.trim().replace(/,/g, '')
    if (!text) return undefined
    if (text.endsWith('%')) {
      const percent = Number.parseFloat(text.slice(0, -1))
      return Number.isFinite(percent) ? percent / 100 : undefined
    }
    const parsed = Number.parseFloat(text)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
    return undefined
  }
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (['true', 'yes', 'y', 'on', '1'].includes(text)) return true
    if (['false', 'no', 'n', 'off', '0'].includes(text)) return false
  }
  return undefined
}

function coerceString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return undefined
}

function brief(value: unknown, max = 32): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (typeof text !== 'string') text = String(text)
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function clampMessage(message: string): string {
  return message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS - 1)}…` : message
}

/* --------------------------- 音名 / 调性 --------------------------- */

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const FLAT_PITCH_CLASS: Record<string, number> = {
  Cb: 11,
  Db: 1,
  Eb: 3,
  Fb: 4,
  Gb: 6,
  Ab: 8,
  Bb: 10,
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
}
const SHARP_PITCH_CLASS: Record<string, number> = { 'E#': 5, 'B#': 0 }

/** 音名/调性 → 规范调性（Bb→A#，db→C#，C major→C）；解析失败返回 null */
export function normalizeKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/♯/g, '#').replace(/♭/g, 'b')
  const match = text.match(/^([A-Ga-g])\s*([#b]?)/)
  if (!match) return null
  const letter = match[1].toUpperCase()
  const accidental = match[2]
  if (accidental === 'b') {
    const index = FLAT_PITCH_CLASS[`${letter}b`]
    return index === undefined ? null : SHARP_NAMES[index]
  }
  if (accidental === '#') {
    if (SHARP_PITCH_CLASS[`${letter}#`] !== undefined) return SHARP_NAMES[SHARP_PITCH_CLASS[`${letter}#`]]
    const index = SHARP_NAMES.indexOf(`${letter}#`)
    return index >= 0 ? `${letter}#` : null
  }
  return NOTE_NAMES.includes(letter) ? letter : null
}

/** 和弦根音 → 0..11（C=0，Bb→10，Eb→3，F#→6） */
export function normalizeRoot(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? ((Math.round(value) % 12) + 12) % 12 : null
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const parsed = Number.parseFloat(text)
    return Number.isFinite(parsed) ? ((Math.round(parsed) % 12) + 12) % 12 : null
  }
  const key = normalizeKey(text)
  return key === null ? null : NOTE_NAMES.indexOf(key)
}

/** MIDI 音高：数字 / 数字字符串 / 音名（C4、F#3、Bb2、c-1）；非法返回 null */
export function normalizePitch(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    const pitch = Math.round(value)
    return pitch >= 0 && pitch <= 127 ? pitch : null
  }
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/♯/g, '#').replace(/♭/g, 'b')
  if (!text) return null
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const parsed = Number.parseFloat(text)
    if (!Number.isFinite(parsed)) return null
    const pitch = Math.round(parsed)
    return pitch >= 0 && pitch <= 127 ? pitch : null
  }
  if (!/^[A-Ga-g][#b]?-?\d$/.test(text)) return null
  const pitch = nameToPitch(text)
  return pitch !== null && pitch >= 0 && pitch <= 127 ? pitch : null
}

/* ------------------------------ 和弦 ------------------------------ */

const QUALITY_ALIASES: Record<string, ChordQualityId> = {
  maj: 'maj',
  major: 'maj',
  ionian: 'maj',
  m: 'min',
  min: 'min',
  minor: 'min',
  aeolian: 'min',
  dim: 'dim',
  diminished: 'dim',
  augmented: 'aug',
  sus: 'sus4',
  suspended: 'sus4',
  'sus-4': 'sus4',
  'sus-2': 'sus2',
  dom7: 'dom7',
  dominant: 'dom7',
  dominant7: 'dom7',
  '7': 'dom7',
  maj7: 'maj7',
  major7: 'maj7',
  min7: 'min7',
  minor7: 'min7',
  m7: 'min7',
  'm7b5': 'm7b5',
  min7b5: 'm7b5',
  halfdiminished: 'm7b5',
  halfdim: 'm7b5',
  hdim: 'm7b5',
  dim7: 'dim7',
  diminished7: 'dim7',
  mmaj7: 'mMaj7',
  minmaj7: 'mMaj7',
  minmaj: 'mMaj7',
  maj9: 'maj9',
  major9: 'maj9',
  min9: 'min9',
  minor9: 'min9',
  m9: 'min9',
  dom9: 'dom9',
  dominant9: 'dom9',
  '9': 'dom9',
  add9: 'add9',
  six: 'six',
  '6': 'six',
  maj6: 'six',
  major6: 'six',
  m6: 'm6',
  min6: 'm6',
  minor6: 'm6',
  power: 'power',
  '5': 'power',
  powerchord: 'power',
  大三: 'maj',
  大: 'maj',
  小: 'min',
  小三: 'min',
  属七: 'dom7',
  大七: 'maj7',
  小七: 'min7',
  减: 'dim',
  减七: 'dim7',
  增: 'aug',
  挂四: 'sus4',
  挂二: 'sus2',
}

/** 精确大小写别名（"M" = major、"m" = minor、"o" = dim …） */
const CASE_SENSITIVE_QUALITY: Record<string, ChordQualityId> = {
  // 传统记谱：大写 M（含 "CM"/"C M" 这类写法）= 大三和弦，小写 m = 小三和弦。
  // 后缀按大小写整体判断，避免 "M7" 被拆成 M + 7：M7/M9/M6 = maj7/maj9/six。
  M: 'maj',
  M7: 'maj7',
  M9: 'maj9',
  M6: 'six',
  Δ: 'maj7',
  Δ7: 'maj7',
  ø: 'm7b5',
  ø7: 'm7b5',
  o: 'dim',
  o7: 'dim7',
  '+': 'aug',
  '-': 'min',
  '-7': 'min7',
  '-6': 'm6',
  '': 'maj',
}

/** 和弦性质 → 规范 quality；无法识别返回 null */
export function normalizeQuality(value: unknown): ChordQualityId | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (CHORDS[text as ChordQualityId]) return text as ChordQualityId
  if (CASE_SENSITIVE_QUALITY[text]) return CASE_SENSITIVE_QUALITY[text]
  const key = text.toLowerCase().replace(/[\s_-]/g, '')
  const alias = QUALITY_ALIASES[text.toLowerCase()] ?? QUALITY_ALIASES[key]
  if (alias) return alias
  if (CHORDS[key as ChordQualityId]) return key as ChordQualityId
  return null
}

const CHORD_SYMBOL_RE = /^([A-Ga-g])\s*([#b]?)\s*(.*)$/

/** 字符串和弦（"Am" / "F#m7" / "Bb" / "C/E"）→ { root, quality } */
export function parseChordString(value: string): { root: number; quality: ChordQualityId } | null {
  const text = value.trim().replace(/♯/g, '#').replace(/♭/g, 'b')
  const head = text.split('/')[0]?.trim() ?? ''
  const match = head.match(CHORD_SYMBOL_RE)
  if (!match) return null
  const root = normalizeRoot(`${match[1]}${match[2]}`)
  if (root === null) return null
  const quality = normalizeQuality(match[3] ?? '')
  if (!quality) return null
  return { root, quality }
}

/* ------------------------------ 调式 ------------------------------ */

const SCALE_ALIASES: Record<string, ScaleId> = {
  major: 'major',
  maj: 'major',
  ionian: 'major',
  naturalscale: 'major',
  majorScale: 'major',
  大调: 'major',
  自然大调: 'major',
  minor: 'minor',
  min: 'minor',
  aeolian: 'minor',
  naturalminor: 'minor',
  小调: 'minor',
  自然小调: 'minor',
  harmonicminor: 'harmonicMinor',
  harmonic: 'harmonicMinor',
  和声小调: 'harmonicMinor',
  melodicminor: 'melodicMinor',
  旋律小调: 'melodicMinor',
  dorian: 'dorian',
  多利亚: 'dorian',
  phrygian: 'phrygian',
  弗里吉亚: 'phrygian',
  lydian: 'lydian',
  利底亚: 'lydian',
  mixolydian: 'mixolydian',
  混合利底亚: 'mixolydian',
  locrian: 'locrian',
  洛克里亚: 'locrian',
  pentatonicmajor: 'pentatonicMajor',
  majorpentatonic: 'pentatonicMajor',
  pentatonic: 'pentatonicMajor',
  大调五声: 'pentatonicMajor',
  五声: 'pentatonicMajor',
  pentatonicminor: 'pentatonicMinor',
  minorpentatonic: 'pentatonicMinor',
  小调五声: 'pentatonicMinor',
  blues: 'blues',
  bluesscale: 'blues',
  布鲁斯: 'blues',
  wholetone: 'wholeTone',
  wholetonescale: 'wholeTone',
  全音阶: 'wholeTone',
  chromatic: 'chromatic',
  chromaticscale: 'chromatic',
  半音阶: 'chromatic',
}

/** 调式 → 规范 ScaleId；无法识别返回 null */
export function normalizeScale(value: unknown): ScaleId | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  if ((SCALE_IDS as string[]).includes(text)) return text as ScaleId
  const canonical = SCALE_IDS.find((id) => id.toLowerCase() === text.toLowerCase())
  if (canonical) return canonical
  const key = text.toLowerCase().replace(/[\s_-]/g, '')
  return SCALE_ALIASES[text.toLowerCase()] ?? SCALE_ALIASES[key] ?? null
}

/* --------------------------- 理论查询别名 --------------------------- */

const THEORY_QUERY_IDS = [
  'scale',
  'chord',
  'progression',
  'inversion',
  'detect',
  'harmonize',
  'roman',
  'instrument',
  'list_instruments',
] as const

const THEORY_QUERY_ALIASES: Record<string, string> = {
  scale: 'scale',
  scales: 'scale',
  scalenotes: 'scale',
  scalenames: 'scale',
  notenames: 'scale',
  notes: 'scale',
  note: 'scale',
  chord: 'chord',
  chords: 'chord',
  chordnotes: 'chord',
  chordquality: 'chord',
  progression: 'progression',
  progressions: 'progression',
  chordprogression: 'progression',
  romanprogression: 'progression',
  inversion: 'inversion',
  inversions: 'inversion',
  invert: 'inversion',
  detect: 'detect',
  detectkey: 'detect',
  keydetection: 'detect',
  analyzekey: 'detect',
  harmonize: 'harmonize',
  harmonise: 'harmonize',
  harmonization: 'harmonize',
  harmonizemelody: 'harmonize',
  harmony: 'harmonize',
  roman: 'roman',
  romans: 'roman',
  romannumeral: 'roman',
  romannumerals: 'roman',
  instrument: 'instrument',
  instrumentinfo: 'instrument',
  getinstrument: 'instrument',
  listinstruments: 'list_instruments',
  instruments: 'list_instruments',
  instrumentlist: 'list_instruments',
  instrumentslist: 'list_instruments',
  allinstruments: 'list_instruments',
  instrumentcatalog: 'list_instruments',
  list: 'list_instruments',
}

/** music_theory 的 query 别名（scale_notes→scale、instruments→list_instruments、notes→scale …） */
export function normalizeTheoryQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  const exact = THEORY_QUERY_IDS.find((id) => id === text)
  if (exact) return exact
  const lower = text.toLowerCase()
  const insensitive = THEORY_QUERY_IDS.find((id) => id.toLowerCase() === lower)
  if (insensitive) return insensitive
  const key = lower.replace(/[\s_-]/g, '')
  return THEORY_QUERY_ALIASES[key] ?? null
}

/* --------------------------- 枚举别名表 --------------------------- */

const SMART_KIND_ALIASES: Record<string, string> = {
  drum: 'drums',
  drumkit: 'drums',
  percussion: 'drums',
  beat: 'drums',
  rhythm: 'drums',
  bassline: 'bass',
  bassguitar: 'bass',
  lowend: 'bass',
  chord: 'chords',
  chords: 'chords',
  chordpad: 'chords',
  harmony: 'chords',
  arpeggio: 'arp',
  arpeggios: 'arp',
  arpeggiated: 'arp',
  lead: 'melody',
  leadline: 'melody',
  mainmelody: 'melody',
  tune: 'melody',
  melodyline: 'melody',
  hook: 'riff',
  motif: 'riff',
  ostinato: 'riff',
  strumming: 'strum',
  guitarstrum: 'strum',
  countermelody: 'counter',
  pads: 'pad',
  athmosphere: 'pad',
  atmosphere: 'pad',
  ambient: 'pad',
  texture: 'pad',
}

const STYLE_ALIASES: Record<string, string> = {
  pop: 'pop',
  流行: 'pop',
  rock: 'rock',
  摇滚: 'rock',
  electronic: 'electronic',
  electronica: 'electronic',
  edm: 'electronic',
  dance: 'electronic',
  电子: 'electronic',
  jazz: 'jazz',
  爵士: 'jazz',
  classical: 'classical',
  古典: 'classical',
  cinematic: 'cinematic',
  film: 'cinematic',
  filmscore: 'cinematic',
  orchestral: 'cinematic',
  soundtrack: 'cinematic',
  影视配乐: 'cinematic',
  folk: 'folk',
  acoustic: 'folk',
  singer: 'folk',
  民谣: 'folk',
}

const WRITE_MODE_ALIASES: Record<string, string> = {
  overwrite: 'replace',
  overwriteall: 'replace',
  set: 'replace',
  reset: 'replace',
  insert: 'add',
  append: 'add',
  push: 'add',
  modify: 'update',
  edit: 'update',
  patch: 'update',
  change: 'update',
  remove: 'delete',
  del: 'delete',
  erase: 'delete',
  clear: 'replace',
}

const ARRANGE_MODE_ALIASES: Record<string, string> = {
  new: 'replace',
  rebuild: 'replace',
  overwrite: 'replace',
  recreate: 'replace',
  append: 'append',
  keep: 'append',
  add: 'append',
}

function enumAlias(toolName: string, key: string, value: string): string | undefined {
  const lower = value.trim().toLowerCase()
  const compact = lower.replace(/[\s_-]/g, '')
  if (key === 'kind') return SMART_KIND_ALIASES[lower] ?? SMART_KIND_ALIASES[compact]
  if (key === 'style') return STYLE_ALIASES[lower] ?? STYLE_ALIASES[compact]
  if (key === 'mode' && toolName === 'write_notes') return WRITE_MODE_ALIASES[lower] ?? WRITE_MODE_ALIASES[compact]
  if (key === 'mode' && toolName === 'arrange_from_melody') return ARRANGE_MODE_ALIASES[lower] ?? ARRANGE_MODE_ALIASES[compact]
  return undefined
}

/* ------------------------------ 乐器 ------------------------------ */

const INSTRUMENT_IDS = listInstruments().map((instrument) => instrument.id)

function canonicalInstrumentId(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text) return text
  if (hasInstrument(text)) return text
  const lower = text.toLowerCase()
  return INSTRUMENT_IDS.find((id) => id.toLowerCase() === lower) ?? text
}

function closestInstrumentId(raw: string): string | undefined {
  const text = raw.trim().toLowerCase()
  let best: string | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const id of INSTRUMENT_IDS) {
    const distance = editDistance(text, id.toLowerCase())
    if (distance < bestDistance) {
      bestDistance = distance
      best = id
    }
  }
  if (bestDistance <= 3) return best
  // 退化按族名/片段匹配：piano → piano.grand、drums → drums.acoustic、bass → guitar.bass
  let familyBest: string | undefined
  for (const id of INSTRUMENT_IDS) {
    const lower = id.toLowerCase()
    const matched = lower.startsWith(`${text}.`) || lower.endsWith(`.${text}`) || lower === text
    if (matched && (!familyBest || id.length < familyBest.length)) familyBest = id
  }
  return familyBest
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const matrix: number[] = new Array(rows * cols).fill(0)
  for (let i = 0; i < rows; i++) matrix[i * cols] = i
  for (let j = 0; j < cols; j++) matrix[j] = j
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i * cols + j] = Math.min(
        matrix[(i - 1) * cols + j] + 1,
        matrix[i * cols + (j - 1)] + 1,
        matrix[(i - 1) * cols + (j - 1)] + cost,
      )
    }
  }
  return matrix[(rows - 1) * cols + (cols - 1)]
}

/** 非法乐器 id 的可操作提示（列可用的近似 id / 示例，并指引完整目录） */
export function unknownInstrumentMessage(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : String(raw)
  const closest = closestInstrumentId(text)
  return clampMessage(
    `未知乐器 id「${brief(text, 40)}」${closest ? `，是否想用「${closest}」？` : '。'}` +
      '示例：piano.grand / guitar.bass / synth.pad / drums.acoustic / strings.ensemble；' +
      '完整列表请调用 music_theory（query=list_instruments）。',
  )
}

/** 非法情绪 id 的可操作提示（列出该乐器所有情绪 id） */
export function unknownEmotionMessage(instrumentId: string, raw: unknown): string {
  const instrument = getInstrument(instrumentId)
  const ids = instrument.emotions.map((emotion) => emotion.id)
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  let closest: string | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const id of ids) {
    const distance = editDistance(text, id.toLowerCase())
    if (distance < bestDistance) {
      bestDistance = distance
      closest = id
    }
  }
  const suggestion = closest && bestDistance <= 3 ? `，是否想用「${closest}」？` : '。'
  return clampMessage(`乐器「${instrument.name}」没有情绪预设「${brief(raw, 24)}」${suggestion}可用情绪：${ids.join(' / ')}`)
}

/** 在乐器情绪里按 id（大小写不敏感）解析，失败返回 null */
export function matchEmotion(instrumentId: string, emotionId: string): string | null {
  const instrument = getInstrument(instrumentId)
  const lower = emotionId.trim().toLowerCase()
  const found =
    instrument.emotions.find((emotion) => emotion.id === emotionId) ??
    instrument.emotions.find((emotion) => emotion.id.toLowerCase() === lower) ??
    instrument.emotions.find((emotion) => emotion.name === emotionId)
  return found?.id ?? null
}

/* --------------------------- 情绪兜底解析 --------------------------- */

export interface EmotionResolution {
  /** 最终使用的情绪 id */
  emotionId: string
  /** true = 精确命中（id / 大小写 / 中文名 / 英文名）；false = 走了同义词/包含/编辑距离兜底 */
  exact: boolean
  /** 非精确命中时给模型和用户看的一句话说明（如「情绪「swing」不精确，已使用「brush（刷子）」」） */
  note?: string
}

/**
 * 情绪词同义词 → 候选情绪 id（按该乐器实际可用情绪动态挑选，越靠前越优先）。
 * 模型常把「演奏风格/形容词」当情绪 id 传（swing / shuffle / 激烈 / 梦幻 …），
 * 这些词在多数乐器里并不存在，直接 ok:false 会让整轮任务失败，因此做一次保守兜底。
 */
const EMOTION_SYNONYMS: Record<string, string[]> = {
  swing: ['brush', 'ride', 'bop', 'swing', 'soft'],
  swung: ['brush', 'ride', 'bop', 'swing', 'soft'],
  shuffle: ['brush', 'ride', 'soft', 'swing'],
  groove: ['brush', 'ride', 'bop', 'soft'],
  jazz: ['brush', 'ride', 'bop', 'jazz', 'soft'],
  brush: ['brush'],
  ride: ['ride'],
  bop: ['bop'],
  loud: ['power', 'bright', 'marcato', 'hard', 'attack'],
  hard: ['power', 'bright', 'marcato', 'hard', 'attack'],
  heavy: ['power', 'distortion', 'drive', 'marcato', 'hard'],
  aggressive: ['power', 'distortion', 'drive', 'marcato', 'hard'],
  soft: ['soft', 'mellow', 'warm', 'gentle', 'calm'],
  gentle: ['soft', 'mellow', 'warm', 'gentle', 'calm'],
  mellow: ['mellow', 'soft', 'warm', 'calm'],
  calm: ['soft', 'mellow', 'calm', 'warm'],
  chill: ['soft', 'mellow', 'calm', 'warm'],
  warm: ['warm', 'mellow', 'soft'],
  bright: ['bright', 'crisp', 'clean', 'clear'],
  crisp: ['bright', 'crisp', 'clean', 'clear'],
  clear: ['clean', 'crisp', 'bright', 'clear'],
  clean: ['clean', 'crisp', 'bright', 'natural'],
  acoustic: ['acoustic', 'natural', 'clean', 'warm'],
  natural: ['natural', 'acoustic', 'clean', 'warm'],
  dark: ['dark', 'moody', 'melancholy', 'dreamy', 'soft'],
  moody: ['dark', 'moody', 'melancholy', 'dreamy', 'soft'],
  dreamy: ['dreamy', 'ambient', 'atmospheric', 'mellow', 'soft'],
  dream: ['dreamy', 'ambient', 'atmospheric', 'mellow', 'soft'],
  ambient: ['ambient', 'dreamy', 'atmospheric', 'pad', 'soft'],
  atmospheric: ['ambient', 'dreamy', 'atmospheric', 'pad', 'soft'],
  epic: ['epic', 'cinematic', 'swell', 'marcato', 'power'],
  cinematic: ['cinematic', 'epic', 'swell', 'tremolo'],
  pop: ['pop', 'bright', 'clean'],
  rock: ['rock', 'power', 'bright', 'distortion', 'drive'],
  funk: ['funk', 'clean', 'bright', 'pluck'],
  lofi: ['lofi', 'loFi', 'soft', 'warm', 'mellow'],
  classical: ['classical', 'warm', 'soft', 'legato'],
  pizzicato: ['pizzicato', 'pluck', 'staccato'],
  pluck: ['pluck', 'pizzicato', 'staccato'],
  staccato: ['staccato', 'pluck', 'pizzicato', 'marcato'],
  marcato: ['marcato', 'staccato', 'power'],
  sustain: ['sustain', 'legato', 'swell'],
  legato: ['legato', 'sustain', 'swell'],
  tremolo: ['tremolo', 'vibrato'],
  vibrato: ['vibrato', 'tremolo'],
  swell: ['swell', 'sustain', 'tremolo'],
  harmonic: ['harmonic', 'harmonics', 'pluck'],
  palmmute: ['palmMute', 'palm_mute', 'muted', 'mute', 'staccato'],
  muted: ['muted', 'mute', 'palmMute', 'soft'],
  distortion: ['distortion', 'drive', 'fuzz', 'overdrive', 'hard'],
  overdrive: ['overdrive', 'distortion', 'drive', 'hard'],
  // 中文常用说法
  摇摆: ['brush', 'ride', 'bop', 'swing', 'soft'],
  爵士: ['brush', 'ride', 'bop', 'jazz', 'soft'],
  激烈: ['power', 'bright', 'marcato', 'hard', 'attack'],
  强烈: ['power', 'bright', 'marcato', 'hard'],
  柔和: ['soft', 'mellow', 'warm', 'gentle', 'calm'],
  温柔: ['soft', 'mellow', 'warm', 'gentle', 'calm'],
  温暖: ['warm', 'mellow', 'soft'],
  明亮: ['bright', 'crisp', 'clean'],
  清澈: ['clean', 'crisp', 'bright'],
  干净: ['clean', 'crisp', 'natural'],
  暗: ['dark', 'moody', 'melancholy', 'soft'],
  阴暗: ['dark', 'moody', 'melancholy', 'soft'],
  忧郁: ['dark', 'moody', 'melancholy', 'soft'],
  悲伤: ['dark', 'moody', 'melancholy', 'soft'],
  梦幻: ['dreamy', 'ambient', 'atmospheric', 'mellow'],
  氛围: ['ambient', 'dreamy', 'atmospheric', 'pad'],
  空灵: ['dreamy', 'ambient', 'pad', 'soft'],
  史诗: ['epic', 'cinematic', 'swell', 'marcato'],
  摇滚: ['rock', 'power', 'bright', 'distortion', 'drive'],
  电子: ['electronic', 'synth', 'bright'],
  原声: ['acoustic', 'natural', 'clean'],
  拨奏: ['pizzicato', 'pluck', 'staccato'],
  拨弦: ['pluck', 'pizzicato', 'staccato'],
  断奏: ['staccato', 'pluck', 'marcato'],
  连奏: ['legato', 'sustain', 'swell'],
  颤音: ['tremolo', 'vibrato'],
  泛音: ['harmonic', 'harmonics'],
  闷音: ['palmMute', 'palm_mute', 'muted', 'mute'],
  失真: ['distortion', 'drive', 'overdrive'],
  复古: ['lofi', 'loFi', 'warm', 'soft'],
  低保真: ['lofi', 'loFi', 'soft', 'warm'],
}

function normalizeEmotionToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_\-·/\\]+/g, '')
}

function emotionFallbackNote(emotion: EmotionPreset, raw: string): EmotionResolution {
  const label = emotion.name ? `${emotion.id}（${emotion.name}）` : emotion.id
  return { emotionId: emotion.id, exact: false, note: `情绪「${brief(raw, 24)}」不精确，已使用「${label}」` }
}

function emotionSynonymCandidates(text: string): string[] {
  const normalized = normalizeEmotionToken(text)
  if (!normalized) return []
  const candidates: string[] = []
  for (const [rawKey, ids] of Object.entries(EMOTION_SYNONYMS)) {
    const key = normalizeEmotionToken(rawKey)
    if (!key) continue
    const hit =
      normalized === key ||
      (key.length >= 2 && normalized.includes(key)) ||
      (normalized.length >= 3 && key.includes(normalized))
    if (!hit) continue
    for (const id of ids) if (!candidates.includes(id)) candidates.push(id)
  }
  return candidates
}

/**
 * 带兜底的情绪解析：精确 → 同义词 → id/name/nameEn/hint 包含 → 编辑距离。
 * 返回 null 表示彻底无法识别（调用方应返回 ok:false + unknownEmotionMessage）。
 * 非精确命中时 note 非空，调用方必须把 note 拼进工具 message，避免「静默改动」。
 */
export function resolveEmotionWithFallback(instrumentId: string, raw: unknown): EmotionResolution | null {
  const instrument = getInstrument(instrumentId)
  const emotions = instrument.emotions
  if (emotions.length === 0) return { emotionId: 'default', exact: true }
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return { emotionId: emotions[0].id, exact: true }

  const normalized = normalizeEmotionToken(text)
  const exact = emotions.find(
    (emotion) =>
      emotion.id === text ||
      emotion.name === text ||
      emotion.nameEn === text ||
      normalizeEmotionToken(emotion.id) === normalized ||
      normalizeEmotionToken(emotion.nameEn) === normalized ||
      normalizeEmotionToken(emotion.name) === normalized,
  )
  if (exact) return { emotionId: exact.id, exact: true }

  // 1) 同义词表（按该乐器可用情绪动态挑选）
  for (const candidate of emotionSynonymCandidates(text)) {
    const candidateToken = normalizeEmotionToken(candidate)
    const found = emotions.find((emotion) => normalizeEmotionToken(emotion.id) === candidateToken)
    if (found) return emotionFallbackNote(found, text)
  }

  // 2) 对 id / 名称 / 提示语做包含匹配（取命中 token 最长的）
  let containsBest: { emotion: EmotionPreset; score: number } | undefined
  for (const emotion of emotions) {
    for (const token of [emotion.id, emotion.nameEn, emotion.name, emotion.hint]) {
      const tokenNorm = normalizeEmotionToken(token)
      if (!tokenNorm) continue
      const hit =
        normalized === tokenNorm ||
        (tokenNorm.length >= 2 && normalized.includes(tokenNorm)) ||
        (normalized.length >= 3 && tokenNorm.includes(normalized))
      if (!hit) continue
      if (!containsBest || tokenNorm.length > containsBest.score) containsBest = { emotion, score: tokenNorm.length }
    }
  }
  if (containsBest) return emotionFallbackNote(containsBest.emotion, text)

  // 3) 编辑距离兜底（容忍拼写/近义转写误差）
  let closest: EmotionPreset | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const emotion of emotions) {
    for (const token of [emotion.id, emotion.nameEn, emotion.name]) {
      const tokenNorm = normalizeEmotionToken(token)
      if (!tokenNorm) continue
      const distance = editDistance(normalized, tokenNorm)
      if (distance < bestDistance) {
        bestDistance = distance
        closest = emotion
      }
    }
  }
  const threshold = normalized.length <= 3 ? 1 : normalized.length <= 6 ? 2 : 3
  if (closest && bestDistance <= threshold) return emotionFallbackNote(closest, text)
  return null
}

/* --------------------------- 归一化主流程 --------------------------- */

interface NormalizeState {
  toolName: string
  /** 每小节拍数（sections 的 startBeat/lengthBeats 换算用） */
  barBeats: number
  errors: string[]
}

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key
}

function describeSchema(schema: unknown): string {
  const node = asSchema(schema)
  if (Array.isArray(node.enum)) {
    const values = node.enum.map((item) => String(item)).slice(0, 12)
    return values.join(' / ')
  }
  const type = typeof node.type === 'string' ? node.type : '值'
  if (type === 'number') return '数字'
  if (type === 'integer') return '整数'
  if (type === 'boolean') return 'true / false'
  if (type === 'array') return '数组'
  if (type === 'object') return '对象'
  return '字符串'
}

function normalizeObject(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  state: NormalizeState,
): Record<string, unknown> | null {
  if (!isPlainObject(value)) {
    state.errors.push(`参数 ${path || '（整个入参）'} 应为对象`)
    return null
  }
  const properties = asSchema(schema.properties)
  const out: Record<string, unknown> = {}
  const errored = new Set<string>()
  for (const [key, rawSchema] of Object.entries(properties)) {
    const raw = value[key]
    if (raw === undefined || raw === null) continue
    const errorsBefore = state.errors.length
    const normalized = normalizeProperty(raw, asSchema(rawSchema), joinPath(path, key), key, state)
    if (normalized === undefined) {
      if (state.errors.length > errorsBefore) errored.add(key)
      continue
    }
    if (Array.isArray(normalized) && normalized.length === 0 && state.errors.length > errorsBefore) errored.add(key)
    out[key] = normalized
  }
  // 未知属性静默丢弃；声明 additionalProperties=true 的 schema 才透传
  if (schema.additionalProperties === true) {
    for (const [key, raw] of Object.entries(value)) {
      if (key in out || raw === undefined || raw === null) continue
      if (key in properties) continue
      out[key] = raw
    }
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : []
  for (const key of required) {
    if (errored.has(key)) continue
    const current = out[key]
    const missing = current === undefined || current === '' || (Array.isArray(current) && current.length === 0)
    if (missing) {
      state.errors.push(`缺少必填参数 ${joinPath(path, key) || key}（${describeSchema(properties[key])}）`)
    }
  }
  // emotionId 若同批带了 instrumentId，做一次大小写不敏感的规范化
  if (typeof out.emotionId === 'string' && typeof out.instrumentId === 'string' && hasInstrument(out.instrumentId)) {
    const matched = matchEmotion(out.instrumentId, out.emotionId)
    if (matched) out.emotionId = matched
  }
  return out
}

function normalizeProperty(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  key: string,
  state: NormalizeState,
): unknown {
  // 1) 结构变化类：和弦 / 段落 / romans 简写
  if (key === 'chords' && Array.isArray(value)) return normalizeChords(value, path, schema, state)
  // "Am F C G" / "Am-F-C-G" / "Am,F,C,G" 这类整串写法先拆 token 再逐项解析
  if (key === 'chords' && typeof value === 'string') return normalizeChords(splitChordList(value), path, schema, state)
  if (key === 'sections' && Array.isArray(value)) return normalizeSections(value, path, state)
  if (key === 'romans' && typeof value === 'string') {
    const tokens = value
      .split(/[\s,、|]+/)
      .map((token) => token.trim())
      .filter(Boolean)
    return tokens
  }

  // 2) 字段级语义归一化
  let next = value
  switch (key) {
    case 'pitch': {
      const pitch = normalizePitch(value)
      if (pitch === null) {
        state.errors.push(`参数 ${path}「${brief(value)}」无法识别为音高（用 MIDI 0..127 或音名 C4 / F#3 / Bb2）`)
        return undefined
      }
      return pitch
    }
    case 'root': {
      const root = normalizeRoot(value)
      if (root === null) {
        state.errors.push(`参数 ${path}「${brief(value)}」不是合法根音（用音名 C / F# / Bb 或 0..11）`)
        return undefined
      }
      return root
    }
    case 'quality': {
      const quality = normalizeQuality(value)
      if (!quality) {
        state.errors.push(`参数 ${path}「${brief(value)}」不是合法和弦性质，可用：${QUALITY_IDS.join(' / ')}`)
        return undefined
      }
      return quality
    }
    case 'key': {
      const keyName = normalizeKey(value)
      if (!keyName) {
        state.errors.push(`参数 ${path}「${brief(value)}」不是合法调性，可用：${KEY_VALUES.join(' / ')}（支持降号，如 Bb→A#）`)
        return undefined
      }
      return keyName
    }
    case 'scale': {
      const scale = normalizeScale(value)
      if (!scale) {
        state.errors.push(`参数 ${path}「${brief(value)}」不是合法调式，可用：${SCALE_IDS.join(' / ')}`)
        return undefined
      }
      return scale
    }
    case 'instrumentId':
      return canonicalInstrumentId(value)
    case 'emotionId':
      return typeof value === 'string' ? value.trim() : value
    case 'query': {
      if (state.toolName !== 'music_theory') break
      const query = normalizeTheoryQuery(value)
      if (!query) {
        state.errors.push(`参数 query「${brief(value)}」无效，可用：${THEORY_QUERY_IDS.join(' / ')}（也支持 scale_notes / instruments / notes 等别名）`)
        return undefined
      }
      return query
    }
    default:
      break
  }

  // 3) 枚举别名（大小写不敏感由后续 enum 分支兜底）
  if (typeof next === 'string') {
    const alias = enumAlias(state.toolName, key, next)
    if (alias) next = alias
  }

  return normalizeByType(next, schema, path, key, state)
}

function normalizeByType(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  key: string,
  state: NormalizeState,
): unknown {
  const type = typeof schema.type === 'string' ? schema.type : undefined

  if (type === 'object' || (type === undefined && isPlainObject(value))) {
    return normalizeObject(value, schema, path, state)
  }

  if (type === 'array') {
    if (!Array.isArray(value)) {
      state.errors.push(`参数 ${path} 应为数组`)
      return undefined
    }
    const itemsSchema = asSchema(schema.items)
    const result: unknown[] = []
    value.forEach((item, index) => {
      const itemPath = `${path}[${index}]`
      if ((typeof item === 'string' || typeof item === 'number') && itemsSchema.type === 'object') {
        if (key === 'notes' || key === 'melody') {
          const note = normalizeObject({ pitch: item }, itemsSchema, itemPath, state)
          if (note) result.push(note)
          return
        }
        state.errors.push(`参数 ${itemPath} 应为对象`)
        return
      }
      const normalized = normalizeByType(item, itemsSchema, itemPath, key, state)
      if (normalized !== undefined) result.push(normalized)
    })
    return result
  }

  if (type === 'boolean') {
    const boolean = coerceBoolean(value)
    if (boolean === undefined) {
      state.errors.push(`参数 ${path} 应为 true / false，收到「${brief(value)}」`)
      return undefined
    }
    return boolean
  }

  if (type === 'number' || type === 'integer') {
    const numeric = coerceNumber(value)
    if (numeric === undefined) {
      state.errors.push(`参数 ${path} 应为${type === 'integer' ? '整数' : '数字'}，收到「${brief(value)}」`)
      return undefined
    }
    return type === 'integer' ? Math.round(numeric) : numeric
  }

  if (type === 'string') {
    if (Array.isArray(schema.enum)) {
      const values = schema.enum.filter((item): item is string => typeof item === 'string')
      const text = coerceString(value)
      if (text === undefined) {
        state.errors.push(`参数 ${path} 应为字符串，收到「${brief(value)}」`)
        return undefined
      }
      if (values.includes(text)) return text
      const insensitive = values.find((item) => item.toLowerCase() === text.trim().toLowerCase())
      if (insensitive) return insensitive
      state.errors.push(`参数 ${path}「${brief(text)}」无效，可用：${values.join(' / ')}`)
      return undefined
    }
    const text = coerceString(value)
    if (text === undefined) {
      state.errors.push(`参数 ${path} 应为字符串，收到「${brief(value)}」`)
      return undefined
    }
    return text
  }

  return value
}

/**
 * 整串和弦列表 → token 数组：支持空格/逗号/顿号/分号/竖线分隔，以及「仅在后接音名时」
 * 把 "-" 当分隔符（这样 "Am-F-C-G" 可拆，而 C-7 / Bb-maj7 这类减号写法不会被拆坏）。
 */
function splitChordList(value: string): string[] {
  return value
    .split(/[\s,、|;]+|-(?=[A-Ga-g])/)
    .map((token) => token.trim())
    .filter(Boolean)
}

function normalizeChords(
  value: unknown[],
  path: string,
  schema: Record<string, unknown>,
  state: NormalizeState,
): unknown[] {
  const itemsSchema = asSchema(schema.items)
  const result: unknown[] = []
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`
    let candidate: unknown = item
    if (typeof item === 'string') {
      const parsed = parseChordString(item)
      if (!parsed) {
        state.errors.push(
          `参数 ${itemPath}「${brief(item)}」无法解析为和弦（写法如 "Am"/"F#m7"/"Bb"；quality 可用：${QUALITY_IDS.join(' / ')}）`,
        )
        return
      }
      candidate = { root: parsed.root, quality: parsed.quality }
    } else if (typeof item === 'number') {
      candidate = { root: item }
    }
    if (!isPlainObject(candidate)) {
      state.errors.push(`参数 ${itemPath} 应为和弦对象（{ root, quality, beats }）或字符串（如 "Am"）`)
      return
    }
    const normalized = normalizeObject(candidate, itemsSchema, itemPath, state)
    if (!normalized) return
    if (normalized.root === undefined) {
      state.errors.push(`参数 ${itemPath}.root 缺失（用音名 C / F# / Bb 或 0..11）`)
      return
    }
    if (normalized.quality === undefined) normalized.quality = 'maj'
    result.push(normalized)
  })
  return result
}

function normalizeSections(value: unknown[], path: string, state: NormalizeState): unknown[] {
  const barBeats = state.barBeats > 0 ? state.barBeats : 4
  const result: unknown[] = []
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`
    if (!isPlainObject(item)) {
      state.errors.push(`参数 ${itemPath} 应为对象（{ name, startBar, bars } 或 { name, startBeat, lengthBeats }）`)
      return
    }
    const rawName = item.name ?? item.title ?? item.label
    const name = typeof rawName === 'string' ? rawName.trim() : ''
    let startBar = coerceNumber(item.startBar)
    if (startBar === undefined) {
      const startBeat = coerceNumber(item.startBeat)
      if (startBeat !== undefined) startBar = startBeat / barBeats
    }
    let bars = coerceNumber(item.bars)
    if (bars === undefined) {
      const lengthBeats = coerceNumber(item.lengthBeats)
      if (lengthBeats !== undefined) bars = lengthBeats / barBeats
    }
    if (!name) state.errors.push(`参数 ${itemPath}.name 缺失（段落名，如「主歌」/「副歌」）`)
    if (startBar === undefined || !Number.isFinite(startBar)) {
      state.errors.push(`参数 ${itemPath} 缺少起点：startBar（小节，从 0 开始）或 startBeat（拍）`)
    }
    if (bars === undefined || !Number.isFinite(bars)) {
      state.errors.push(`参数 ${itemPath} 缺少长度：bars（小节）或 lengthBeats（拍）`)
    }
    if (!name || startBar === undefined || bars === undefined || !Number.isFinite(startBar) || !Number.isFinite(bars)) {
      return
    }
    const section: Record<string, unknown> = {
      name,
      startBar: Math.max(0, Math.round(startBar)),
      bars: Math.max(1, Math.round(bars)),
    }
    const energy = coerceNumber(item.energy)
    if (energy !== undefined) section.energy = Math.max(0, Math.min(1, energy))
    result.push(section)
  })
  return result
}

/** 少数工具对「解析出 0 个有效项」有硬性要求（避免数据丢失） */
function checkSemanticMinimums(tool: ToolDef, args: Record<string, unknown>, state: NormalizeState): void {
  if (tool.name === 'write_notes') {
    const mode = args.mode
    if ((mode === 'replace' || mode === 'add') && Array.isArray(args.notes)) {
      args.notes.forEach((note, index) => {
        if (!isPlainObject(note) || typeof note.pitch !== 'number') {
          state.errors.push(`参数 notes[${index}] 缺少合法 pitch（MIDI 0..127 或音名 C4 / F#3）`)
        }
      })
      if (args.notes.length === 0) {
        state.errors.push('参数 notes 为空：replace / add 模式至少需要 1 个有效音符（不会清空片段）')
      }
    }
  }
}

export interface NormalizedArgs {
  ok: boolean
  args: Record<string, unknown>
  message?: string
}

/**
 * 按工具 JSON Schema 归一化参数 + 校验必填字段。
 * 返回 ok:false 时 executeTool 必须直接返回 message，不得调用 handler（绝不半执行）。
 */
export function normalizeToolArgs(
  tool: ToolDef,
  args: Record<string, unknown>,
  ctx: Pick<ToolContext, 'project'>,
): NormalizedArgs {
  if (!isPlainObject(args)) {
    return { ok: false, args: {}, message: clampMessage(`参数校验失败：工具 ${tool.name} 的入参应为对象`) }
  }
  const barBeats = beatsPerBar(ctx.project.timeSignature)
  const state: NormalizeState = { toolName: tool.name, barBeats, errors: [] }
  const normalized = normalizeObject(args, tool.parameters as Record<string, unknown>, '', state)
  const finalArgs = normalized ?? {}
  if (state.errors.length === 0) checkSemanticMinimums(tool, finalArgs, state)
  if (state.errors.length === 0) return { ok: true, args: finalArgs }

  const unique = [...new Set(state.errors)]
  const head = unique.slice(0, 3).join('；')
  const extra = unique.length > 3 ? `（共 ${unique.length} 处参数问题）` : ''
  return {
    ok: false,
    args: {},
    message: clampMessage(`参数校验失败：${head}${extra}`),
  }
}
