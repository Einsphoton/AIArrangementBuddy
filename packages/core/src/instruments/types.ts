/**
 * 乐器目录的数据结构。
 *
 * 一个 InstrumentDefinition 描述「音色 + 演奏法（情绪）」：
 * - synth  → 内置合成器引擎的音色配方（Tone.js 实现，任何环境都能出声）
 * - gmProgram → SoundFont 引擎的 GM 程序号（安装了音色库时获得极高保真度）
 * - emotions → 情绪/演奏法预设，映射到合成器参数或 MIDI CC（11 表情 / 1 调制 / 74 亮度）
 */
import type { ScaleId, StyleId } from '../constants.js'
import type { SmartKind } from '../model.js'

export type InstrumentFamily = 'classical' | 'rock' | 'electronic' | 'world' | 'drums'

export type EngineKind = 'synth' | 'soundfont'

/** 演奏法 */
export type ArticulationId =
  | 'sustain'
  | 'staccato'
  | 'legato'
  | 'marcato'
  | 'pizzicato'
  | 'tremolo'
  | 'palmMute'
  | 'harmonic'
  | 'pluck'
  | 'swell'
  | 'bowChange'

export type OscType =
  | 'sine'
  | 'triangle'
  | 'sawtooth'
  | 'square'
  | 'fatsawtooth'
  | 'fattriangle'
  | 'fatsquare'
  | 'pulse'
  | 'fm'
  | 'noise'

export interface EnvelopeSpec {
  attack: number
  decay: number
  sustain: number
  release: number
}

export interface FilterSpec {
  type: 'lowpass' | 'highpass' | 'bandpass' | 'notch'
  frequency: number
  Q: number
  /** 包络调制深度（-1..1），相对基准频率 */
  envAmount: number
  envelope?: Partial<EnvelopeSpec>
}

/** 单层振荡器 */
export interface LayerSpec {
  osc: OscType
  /** 八度偏移 -3..3 */
  octave: number
  /** 微调（音分） */
  detune: number
  /** 相对音量 0..1 */
  gain: number
  fm?: { harmonicity: number; modulationIndex: number }
  pulseWidth?: number
  envelope?: Partial<EnvelopeSpec>
  filter?: FilterSpec
  /** 颤音（depth 单位：音分） */
  vibrato?: { rate: number; depth: number }
}

export interface FxSpec {
  /** 混响发送 0..1 */
  reverb: number
  /** 延迟发送 0..1 */
  delay: number
  /** 合唱 0..1 */
  chorus: number
  /** 失真 0..1 */
  distortion: number
  /** 总线低通（Hz），0 表示不启用 */
  busLowpass: number
}

/** 合成器音色配方 —— 音频引擎按此构建 Tone.js 图 */
export interface SynthPatch {
  layers: LayerSpec[]
  fx: FxSpec
  /** 连奏滑音（秒） */
  glide: number
  monophonic: boolean
  /** 力度对音量/亮度的敏感度 0..1 */
  velocitySensitivity: number
  /** 复音数上限 */
  polyphony: number
}

/**
 * 情绪 / 演奏法预设。
 * 所有参数归一化到 0..1，具体映射由音频引擎决定，这样 UI 与引擎解耦。
 */
export interface EmotionParams {
  /** 亮度：滤波器截止频率的映射 */
  brightness: number
  /** 温暖度：低频与饱和 */
  warmth: number
  /** 起音（0=极快，1=很慢） */
  attack: number
  /** 释放（0=短，1=长） */
  release: number
  /** 延音电平 */
  sustain: number
  /** 颤音深度 */
  vibrato: number
  /** 颤音速率 Hz */
  vibratoRate: number
  /** 过载/失真 */
  drive: number
  /** 混响发送 */
  reverb: number
  /** 延迟发送 */
  delay: number
  /** 合唱 */
  chorus: number
  /** 失谐宽度（音分） */
  detune: number
  /** 立体声宽度 */
  stereoWidth: number
  /** 力度曲线：负值更柔和，正值更硬朗 */
  velocityCurve: number
  /** 演奏法 */
  articulation: ArticulationId
}

export interface EmotionPreset {
  id: string
  /** 中文名，如「温暖」 */
  name: string
  nameEn: string
  /** 一句话说明，用于 UI 悬浮提示 */
  hint: string
  /** UI 圆点颜色 */
  color: string
  params: EmotionParams
}

export interface InstrumentDefinition {
  id: string
  name: string
  nameEn: string
  family: InstrumentFamily
  /** 中文分类，如 '键盘' / '弦乐' */
  category: string
  /** 默认引擎 */
  engine: EngineKind
  /** GM 程序号 0-127 */
  gmProgram: number
  isDrumKit: boolean
  /** 建议音域 */
  range: { min: number; max: number }
  /** 该乐器适合的智能片段类型 */
  smartKinds: SmartKind[]
  /** 合成器配方 */
  synth: SynthPatch
  /** 情绪预设，至少 3 个 */
  emotions: EmotionPreset[]
  /** 试听音符（相对主音的半音偏移，用于快速试听） */
  previewNotes: number[]
  description: string
  /** emoji 图标 */
  icon: string
  /** 默认推荐风格 */
  styles: StyleId[]
}

export interface DigitonePreset extends InstrumentDefinition {
  /** 可选的音色库同名映射（部分 SF2 使用不同命名） */
  soundfontHint?: string
}

/** 引擎默认混响/延迟发送量 */
export const DEFAULT_FX: FxSpec = { reverb: 0.16, delay: 0.05, chorus: 0, distortion: 0, busLowpass: 0 }

/** 常用情绪参数基线 */
export const BASE_EMOTION_PARAMS: EmotionParams = {
  brightness: 0.55,
  warmth: 0.5,
  attack: 0.25,
  release: 0.35,
  sustain: 0.8,
  vibrato: 0.1,
  vibratoRate: 5.2,
  drive: 0,
  reverb: 0.16,
  delay: 0.05,
  chorus: 0,
  detune: 0,
  stereoWidth: 0.6,
  velocityCurve: 0,
  articulation: 'sustain',
}

/** 测试用的空音色（不应出现在目录中） */
export const EMPTY_PATCH: SynthPatch = {
  layers: [{ osc: 'sine', octave: 0, detune: 0, gain: 1 }],
  fx: DEFAULT_FX,
  glide: 0,
  monophonic: false,
  velocitySensitivity: 0.4,
  polyphony: 16,
}

/** 风格推荐的色板，UI 用来给轨道分配颜色 */
export const FAMILY_COLORS: Record<InstrumentFamily, string> = {
  classical: '#d4a95c',
  rock: '#e0562a',
  electronic: '#3ddbd9',
  world: '#a3b86c',
  drums: '#f472b6',
}

/** 调式到风格的默认映射（供推荐逻辑使用） */
export const SCALE_STYLE_AFFINITY: Partial<Record<ScaleId, StyleId>> = {
  major: 'pop',
  minor: 'cinematic',
  dorian: 'jazz',
  mixolydian: 'rock',
  pentatonicMinor: 'rock',
  harmonicMinor: 'classical',
}
