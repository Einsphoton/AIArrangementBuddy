/**
 * 全局常量：音名、音阶、和弦、风格、GM 鼓映射。
 * 这是「音乐理论」层的静态词典，生成器与 UI 都从这里取。
 */

export const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const
export const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const

/** 所有调性（12 个） */
export const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const
export type KeyName = (typeof KEYS)[number]

/** 调式 */
export type ScaleId =
  | 'major'
  | 'minor'
  | 'harmonicMinor'
  | 'melodicMinor'
  | 'dorian'
  | 'phrygian'
  | 'lydian'
  | 'mixolydian'
  | 'locrian'
  | 'pentatonicMajor'
  | 'pentatonicMinor'
  | 'blues'
  | 'wholeTone'
  | 'chromatic'

export interface ScaleDefinition {
  id: ScaleId
  name: string
  nameEn: string
  /** 半音音程（从主音开始） */
  intervals: number[]
  /** 常用和弦级数（0-based 音阶级数） */
  commonDegrees: number[]
}

export const SCALES: Record<ScaleId, ScaleDefinition> = {
  major: { id: 'major', name: '自然大调', nameEn: 'Major', intervals: [0, 2, 4, 5, 7, 9, 11], commonDegrees: [0, 3, 4, 5] },
  minor: { id: 'minor', name: '自然小调', nameEn: 'Natural Minor', intervals: [0, 2, 3, 5, 7, 8, 10], commonDegrees: [0, 3, 4, 6] },
  harmonicMinor: { id: 'harmonicMinor', name: '和声小调', nameEn: 'Harmonic Minor', intervals: [0, 2, 3, 5, 7, 8, 11], commonDegrees: [0, 2, 3, 4] },
  melodicMinor: { id: 'melodicMinor', name: '旋律小调', nameEn: 'Melodic Minor', intervals: [0, 2, 3, 5, 7, 9, 11], commonDegrees: [0, 1, 4, 3] },
  dorian: { id: 'dorian', name: '多利亚', nameEn: 'Dorian', intervals: [0, 2, 3, 5, 7, 9, 10], commonDegrees: [0, 3, 6, 4] },
  phrygian: { id: 'phrygian', name: '弗里吉亚', nameEn: 'Phrygian', intervals: [0, 1, 3, 5, 7, 8, 10], commonDegrees: [0, 1, 6, 3] },
  lydian: { id: 'lydian', name: '利底亚', nameEn: 'Lydian', intervals: [0, 2, 4, 6, 7, 9, 11], commonDegrees: [0, 1, 4, 5] },
  mixolydian: { id: 'mixolydian', name: '混合利底亚', nameEn: 'Mixolydian', intervals: [0, 2, 4, 5, 7, 9, 10], commonDegrees: [0, 3, 4, 6] },
  locrian: { id: 'locrian', name: '洛克里亚', nameEn: 'Locrian', intervals: [0, 1, 3, 5, 6, 8, 10], commonDegrees: [0, 1, 3, 4] },
  pentatonicMajor: { id: 'pentatonicMajor', name: '大调五声', nameEn: 'Major Pentatonic', intervals: [0, 2, 4, 7, 9], commonDegrees: [0, 3, 4] },
  pentatonicMinor: { id: 'pentatonicMinor', name: '小调五声', nameEn: 'Minor Pentatonic', intervals: [0, 3, 5, 7, 10], commonDegrees: [0, 3, 4] },
  blues: { id: 'blues', name: '布鲁斯', nameEn: 'Blues', intervals: [0, 3, 5, 6, 7, 10], commonDegrees: [0, 3, 4] },
  wholeTone: { id: 'wholeTone', name: '全音阶', nameEn: 'Whole Tone', intervals: [0, 2, 4, 6, 8, 10], commonDegrees: [0] },
  chromatic: { id: 'chromatic', name: '半音阶', nameEn: 'Chromatic', intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], commonDegrees: [0] },
}

/** 和弦性质 */
export type ChordQualityId =
  | 'maj'
  | 'min'
  | 'dim'
  | 'aug'
  | 'sus2'
  | 'sus4'
  | 'maj7'
  | 'min7'
  | 'dom7'
  | 'm7b5'
  | 'dim7'
  | 'mMaj7'
  | 'maj9'
  | 'min9'
  | 'dom9'
  | 'add9'
  | 'six'
  | 'm6'
  | 'power'

export interface ChordDefinition {
  id: ChordQualityId
  symbol: string
  name: string
  nameEn: string
  intervals: number[]
}

export const CHORDS: Record<ChordQualityId, ChordDefinition> = {
  maj: { id: 'maj', symbol: '', name: '大三和弦', nameEn: 'Major', intervals: [0, 4, 7] },
  min: { id: 'min', symbol: 'm', name: '小三和弦', nameEn: 'Minor', intervals: [0, 3, 7] },
  dim: { id: 'dim', symbol: 'dim', name: '减三和弦', nameEn: 'Diminished', intervals: [0, 3, 6] },
  aug: { id: 'aug', symbol: 'aug', name: '增三和弦', nameEn: 'Augmented', intervals: [0, 4, 8] },
  sus2: { id: 'sus2', symbol: 'sus2', name: '挂二和弦', nameEn: 'Suspended 2nd', intervals: [0, 2, 7] },
  sus4: { id: 'sus4', symbol: 'sus4', name: '挂四和弦', nameEn: 'Suspended 4th', intervals: [0, 5, 7] },
  maj7: { id: 'maj7', symbol: 'maj7', name: '大七和弦', nameEn: 'Major 7th', intervals: [0, 4, 7, 11] },
  min7: { id: 'min7', symbol: 'm7', name: '小七和弦', nameEn: 'Minor 7th', intervals: [0, 3, 7, 10] },
  dom7: { id: 'dom7', symbol: '7', name: '属七和弦', nameEn: 'Dominant 7th', intervals: [0, 4, 7, 10] },
  m7b5: { id: 'm7b5', symbol: 'm7b5', name: '半减七和弦', nameEn: 'Half Diminished', intervals: [0, 3, 6, 10] },
  dim7: { id: 'dim7', symbol: 'dim7', name: '减七和弦', nameEn: 'Diminished 7th', intervals: [0, 3, 6, 9] },
  mMaj7: { id: 'mMaj7', symbol: 'mMaj7', name: '小大七和弦', nameEn: 'Minor Major 7th', intervals: [0, 3, 7, 11] },
  maj9: { id: 'maj9', symbol: 'maj9', name: '大九和弦', nameEn: 'Major 9th', intervals: [0, 4, 7, 11, 14] },
  min9: { id: 'min9', symbol: 'm9', name: '小九和弦', nameEn: 'Minor 9th', intervals: [0, 3, 7, 10, 14] },
  dom9: { id: 'dom9', symbol: '9', name: '属九和弦', nameEn: 'Dominant 9th', intervals: [0, 4, 7, 10, 14] },
  add9: { id: 'add9', symbol: 'add9', name: '加九和弦', nameEn: 'Added 9th', intervals: [0, 4, 7, 14] },
  six: { id: 'six', symbol: '6', name: '大六和弦', nameEn: 'Major 6th', intervals: [0, 4, 7, 9] },
  m6: { id: 'm6', symbol: 'm6', name: '小六和弦', nameEn: 'Minor 6th', intervals: [0, 3, 7, 9] },
  power: { id: 'power', symbol: '5', name: '强力和弦', nameEn: 'Power Chord', intervals: [0, 7, 12] },
}

/** 音乐风格 */
export type StyleId =
  | 'classical'
  | 'rock'
  | 'electronic'
  | 'jazz'
  | 'cinematic'
  | 'pop'
  | 'folk'
  | 'jrock'
  | 'jrpg'

export interface StyleDefinition {
  id: StyleId
  name: string
  nameEn: string
  description: string
  tempoRange: [number, number]
  defaultTempo: number
  /** 默认调式 */
  defaultScale: ScaleId
  /** UI 主题色（HSL 字符串） */
  accent: string
  /** 推荐编制（乐器 id） */
  recommendedInstruments: string[]
}

export const STYLES: Record<StyleId, StyleDefinition> = {
  classical: {
    id: 'classical',
    name: '古典',
    nameEn: 'Classical',
    description: '管弦乐编制、声部进行讲究，适合叙事与仪式感',
    tempoRange: [50, 152],
    defaultTempo: 92,
    defaultScale: 'major',
    accent: '#d4a95c',
    recommendedInstruments: ['strings.ensemble', 'piano.grand', 'woodwinds.flute', 'brass.horn', 'harp', 'timpani'],
  },
  rock: {
    id: 'rock',
    name: '摇滚',
    nameEn: 'Rock',
    description: '电吉他 + 鼓组驱动，强力和弦与推进感',
    tempoRange: [80, 180],
    defaultTempo: 124,
    defaultScale: 'minor',
    accent: '#e0562a',
    recommendedInstruments: ['guitar.electric', 'guitar.bass', 'drums.acoustic', 'organ.rock', 'piano.electric'],
  },
  electronic: {
    id: 'electronic',
    name: '电子',
    nameEn: 'Electronic',
    description: '合成器层次、侧链律动与空间感',
    tempoRange: [90, 150],
    defaultTempo: 124,
    defaultScale: 'minor',
    accent: '#3ddbd9',
    recommendedInstruments: ['synth.pad', 'synth.lead', 'synth.bass', 'synth.pluck', 'drums.electronic'],
  },
  jazz: {
    id: 'jazz',
    name: '爵士',
    nameEn: 'Jazz',
    description: '七和弦色彩、摇摆节奏与即兴空间',
    tempoRange: [70, 200],
    defaultTempo: 112,
    defaultScale: 'dorian',
    accent: '#a97bd6',
    recommendedInstruments: ['piano.electric', 'guitar.jazz', 'guitar.bass', 'drums.jazz', 'brass.trumpet'],
  },
  cinematic: {
    id: 'cinematic',
    name: '影视配乐',
    nameEn: 'Cinematic',
    description: '铺底弦乐、低频冲击与情绪推进',
    tempoRange: [60, 140],
    defaultTempo: 84,
    defaultScale: 'minor',
    accent: '#7f9cf5',
    recommendedInstruments: ['strings.ensemble', 'choir', 'synth.pad', 'piano.grand', 'timpani'],
  },
  pop: {
    id: 'pop',
    name: '流行',
    nameEn: 'Pop',
    description: '和弦铺底 + 抓耳旋律，结构清晰',
    tempoRange: [80, 140],
    defaultTempo: 108,
    defaultScale: 'major',
    accent: '#f472b6',
    recommendedInstruments: ['piano.grand', 'synth.pad', 'guitar.acoustic', 'guitar.bass', 'drums.acoustic'],
  },
  folk: {
    id: 'folk',
    name: '民谣',
    nameEn: 'Folk',
    description: '木吉他扫弦、人声化的旋律线条',
    tempoRange: [60, 130],
    defaultTempo: 96,
    defaultScale: 'major',
    accent: '#a3b86c',
    recommendedInstruments: ['guitar.acoustic', 'piano.grand', 'strings.cello', 'woodwinds.flute'],
  },
  jrock: {
    id: 'jrock',
    name: '日式摇滚',
    nameEn: 'J-Rock',
    description: '双吉他 riff 与和声、16 分贝斯驱动与军鼓 backbeat，明快而带青春感的日系摇滚',
    tempoRange: [140, 200],
    defaultTempo: 172,
    defaultScale: 'minor',
    accent: '#ff2e63',
    recommendedInstruments: ['guitar.electric.dist', 'guitar.electric', 'guitar.bass', 'drums.acoustic', 'piano.electric', 'organ.rock'],
  },
  jrpg: {
    id: 'jrpg',
    name: 'JRPG 配乐',
    nameEn: 'JRPG Score',
    description: '管弦与摇滚混合的游戏配乐：低音弦乐 ostinato、铜管切分、打击乐重音与失真吉他铺底，适合战斗与冒险场景',
    tempoRange: [70, 190],
    defaultTempo: 144,
    defaultScale: 'minor',
    accent: '#c9a227',
    recommendedInstruments: [
      'strings.ensemble',
      'brass.horn',
      'brass.trumpet',
      'timpani',
      'choir',
      'piano.grand',
      'guitar.electric.dist',
      'guitar.bass',
      'drums.acoustic',
      'woodwinds.flute',
      'harp',
      'organ.pipe',
    ],
  },
}

/** GM 打击乐映射（channel 10 / program 0） */
export const DRUM_MAP = {
  kick: 36,
  kickSoft: 35,
  snare: 38,
  snareRim: 37,
  clap: 39,
  snareBrush: 40,
  tomLow: 41,
  hatClosed: 42,
  tomMidLow: 43,
  hatPedal: 44,
  tomMid: 45,
  hatOpen: 46,
  tomMidHigh: 47,
  tomHigh: 50,
  crash: 49,
  ride: 51,
  china: 52,
  rideBell: 53,
  tambourine: 54,
  splash: 55,
  cowbell: 56,
  crash2: 57,
  ride2: 59,
  bongoHigh: 60,
  bongoLow: 61,
  congaHigh: 62,
  congaLow: 63,
  shaker: 70,
  woodblock: 76,
  triangle: 81,
} as const

export type DrumName = keyof typeof DRUM_MAP

/** 打击乐音域（用于钢琴卷帘显示） */
export const DRUM_PITCH_MIN = 35
export const DRUM_PITCH_MAX = 81

/** 常用鼓组标签，在钢琴卷帘左侧显示 */
export const DRUM_LABELS: Record<number, string> = {
  35: 'Kick 2',
  36: 'Kick',
  37: 'Rim',
  38: 'Snare',
  39: 'Clap',
  40: 'Brush',
  41: 'Tom 1',
  42: 'Hat',
  43: 'Tom 2',
  44: 'Pedal Hat',
  45: 'Tom 3',
  46: 'Open Hat',
  47: 'Tom 4',
  48: 'Tom 5',
  49: 'Crash',
  50: 'Tom 6',
  51: 'Ride',
  52: 'China',
  53: 'Ride Bell',
  54: 'Tamb',
  55: 'Splash',
  56: 'Cowbell',
  57: 'Crash 2',
  59: 'Ride 2',
  70: 'Shaker',
  76: 'Woodblock',
  81: 'Triangle',
}

/** 常见拍号 */
export const TIME_SIGNATURES = ['4/4', '3/4', '6/8', '5/4', '7/8', '2/4', '12/8'] as const
export type TimeSignatureId = (typeof TIME_SIGNATURES)[number]

export const DEFAULT_TICKS_PER_QUARTER = 480

/** 音高 -> 音名（科学音高记谱，C4 = MIDI 60） */
export function pitchToName(pitch: number, useFlat = false): string {
  const names = useFlat ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP
  const pc = ((pitch % 12) + 12) % 12
  const octave = Math.floor(pitch / 12) - 1
  return `${names[pc]}${octave}`
}

/** 音名 -> 音高，支持 C4 / C#4 / Db4 / C-1 */
export function nameToPitch(name: string): number | null {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(name.trim())
  if (!m) return null
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  let pc = base[m[1].toUpperCase()]
  if (m[2] === '#') pc += 1
  if (m[2] === 'b') pc -= 1
  const octave = parseInt(m[3], 10)
  return pc + (octave + 1) * 12
}

export function keyToPitchClass(key: string): number {
  const idx = KEYS.indexOf(key as KeyName)
  return idx >= 0 ? idx : 0
}

export function isBlackKey(pitch: number): boolean {
  const pc = ((pitch % 12) + 12) % 12
  return [1, 3, 6, 8, 10].includes(pc)
}
