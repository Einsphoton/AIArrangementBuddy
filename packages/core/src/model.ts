/**
 * 工程数据模型（单一事实来源）
 *
 * 设计原则：
 * - 纯数据 + zod schema，前后端共享同一套校验；
 * - 客户端是权威状态，服务端 Agent 只处理「传入的快照」并回传新的快照；
 * - 时间单位统一为「拍（beat）」，1 拍 = 四分音符；1 小节 = beatsPerBar 拍。
 */
import { z } from 'zod'
import { mixChainSchema } from './mixChain.js'
import { masterChainSchema } from './masterChain.js'
import type { ChordQualityId, ScaleId, StyleId, TimeSignatureId } from './constants.js'
import {
  analysisRecordSchema,
  assetRefSchema,
  audioClipSchema,
  type AnalysisRecord,
  type AssetRef,
  type AudioClip,
  type Provenance,
  type Take,
} from './audio.js'

/**
 * 工程版本。
 * - v1：纯 MIDI
 * - v2：加入音频域（audioClips / assets / analyses），纯增量，v1 工程可直接加载
 */
export const PROJECT_VERSION = 2

/* ------------------------------------------------------------------ */
/* 基础 ID                                                             */
/* ------------------------------------------------------------------ */

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 短 ID：prefix_8位随机，碰撞概率可忽略，且可读 */
export function newId(prefix = 'id'): string {
  let out = ''
  const bytes = new Uint8Array(8)
  const c = globalThis.crypto
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  for (let i = 0; i < bytes.length; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length]
  return `${prefix}_${out}`
}

/* ------------------------------------------------------------------ */
/* 音符 / 片段                                                         */
/* ------------------------------------------------------------------ */

export const noteEventSchema = z.object({
  id: z.string(),
  /** MIDI 音高 0-127 */
  pitch: z.number().min(0).max(127),
  /** 相对片段起点的拍数 */
  start: z.number().min(0),
  /** 时值（拍），最小 1/64 */
  duration: z.number().min(1 / 64),
  /** 力度 1-127 */
  velocity: z.number().min(1).max(127),
})
export type NoteEvent = z.infer<typeof noteEventSchema>

/** 智能片段类型 */
export const SMART_KINDS = [
  'drums',
  'bass',
  'chords',
  'arp',
  'melody',
  'riff',
  'strum',
  'counter',
  'pad',
] as const
export type SmartKind = (typeof SMART_KINDS)[number]

export const SMART_KIND_META: Record<SmartKind, { name: string; nameEn: string; icon: string; hint: string }> = {
  drums: { name: '节奏', nameEn: 'Drums', icon: '🥁', hint: '鼓组律动，可调密度/切分/加花' },
  bass: { name: '低音', nameEn: 'Bass', icon: '🎸', hint: '跟着和弦走根音与律动型' },
  chords: { name: '和弦', nameEn: 'Chords', icon: '🎹', hint: '和弦铺底，自动转位与声部进行' },
  arp: { name: '琶音', nameEn: 'Arpeggio', icon: '✨', hint: '分解和弦律动' },
  melody: { name: '旋律', nameEn: 'Melody', icon: '🎼', hint: '动机式旋律生成，可控走向' },
  riff: { name: '动机', nameEn: 'Riff', icon: '⚡', hint: '摇滚式短动机与强力和弦' },
  strum: { name: '扫弦', nameEn: 'Strum', icon: '🪕', hint: '吉他扫弦分解型' },
  counter: { name: '对位', nameEn: 'Counter', icon: '🎻', hint: '与主旋律形成对位的副旋律' },
  pad: { name: '铺底', nameEn: 'Pad', icon: '🌫️', hint: '长音铺底、气氛音色' },
}

/** 和弦（供和弦轨 / 智能片段使用） */
export const chordSpecSchema = z.object({
  root: z.number().min(0).max(11),
  quality: z.string(),
  /** 持续拍数 */
  beats: z.number().min(0.25).default(4),
  /** 可选的转位 / 低音 */
  bass: z.number().min(0).max(11).optional(),
})
export type ChordSpec = Omit<z.infer<typeof chordSpecSchema>, 'quality'> & { quality: ChordQualityId }

export const smartParamsSchema = z.object({
  /** 片段长度（小节） */
  bars: z.number().min(1).max(64).default(4),
  /** 音符密度 0..1 */
  density: z.number().min(0).max(1).default(0.5),
  /** 复杂度（变化程度） 0..1 */
  complexity: z.number().min(0).max(1).default(0.5),
  /** 能量（力度/音量强度） 0..1 */
  energy: z.number().min(0).max(1).default(0.6),
  /** 基准八度 */
  octave: z.number().min(-1).max(7).default(4),
  /** 摇摆 0..1 */
  swing: z.number().min(0).max(1).default(0),
  /** 人性化（力度/时值微差） 0..1 */
  humanize: z.number().min(0).max(1).default(0.25),
  /** 音符长度比例 0.1..1.5 */
  gate: z.number().min(0.1).max(1.5).default(0.85),
  /** 指定图案 ID（留空则由生成器按风格挑选） */
  patternId: z.string().optional(),
  /** 是否跟随工程和弦 */
  followChords: z.boolean().default(true),
})
export type SmartParams = z.infer<typeof smartParamsSchema>

export const smartClipConfigSchema = z.object({
  kind: z.enum(SMART_KINDS),
  style: z.string(),
  seed: z.number(),
  params: smartParamsSchema,
  /** 生成时的调性快照，保证可复现 */
  key: z.string().optional(),
  scale: z.string().optional(),
  /** 和弦进行（空则跟随工程 chords） */
  progression: z.array(chordSpecSchema).optional(),
})
export type SmartClipConfig = {
  kind: SmartKind
  style: StyleId
  seed: number
  params: SmartParams
  key?: string
  scale?: ScaleId
  progression?: ChordSpec[]
}

export const clipSchema = z.object({
  id: z.string(),
  trackId: z.string(),
  name: z.string(),
  color: z.string().optional(),
  /** 绝对起点（拍） */
  startBeat: z.number().min(0),
  /** 长度（拍） */
  lengthBeats: z.number().min(0.25),
  notes: z.array(noteEventSchema).default([]),
  smart: smartClipConfigSchema.optional(),
  muted: z.boolean().default(false),
})
export type Clip = Omit<z.infer<typeof clipSchema>, 'smart'> & { smart?: SmartClipConfig }

/* ------------------------------------------------------------------ */
/* 轨道                                                                */
/* ------------------------------------------------------------------ */

export const trackSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** UI 颜色（hex） */
  color: z.string(),
  kind: z.enum(['instrument', 'drum', 'audio']).default('instrument'),
  /** 乐器 id，指向内置乐器目录 */
  instrumentId: z.string(),
  /** 情绪预设 id（乐器内的子预设） */
  emotionId: z.string(),
  /** GM 程序号 0-127，用于 SoundFont 引擎 */
  gmProgram: z.number().min(0).max(127).default(0),
  /** 声音引擎：auto = 有音色库用 SoundFont，否则用内置合成器 */
  engine: z.enum(['auto', 'synth', 'soundfont']).default('auto'),
  volume: z.number().min(0).max(1.5).default(0.8),
  pan: z.number().min(-1).max(1).default(0),
  mute: z.boolean().default(false),
  solo: z.boolean().default(false),
  /** 混响发送 0..1 */
  reverbSend: z.number().min(0).max(1).default(0.18),
  /** 延迟发送 0..1 */
  delaySend: z.number().min(0).max(1).default(0.06),
  /** 八度偏移 */
  octaveShift: z.number().min(-3).max(3).default(0),
  /** 音频处理链（P3：EQ + 压缩），空 = 不处理 */
  mixChain: mixChainSchema.optional(),
  clips: z.array(clipSchema).default([]),
  /** 音频片段（Studio 形态）：与 MIDI clips 平行，只存资产引用 */
  audioClips: z.array(audioClipSchema).default([]),
})
export type Track = Omit<z.infer<typeof trackSchema>, 'clips' | 'audioClips'> & {
  clips: Clip[]
  audioClips: AudioClip[]
}

/* ------------------------------------------------------------------ */
/* 段落 / 工程                                                         */
/* ------------------------------------------------------------------ */

export const sectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  startBar: z.number().min(0),
  bars: z.number().min(1),
  energy: z.number().min(0).max(1).default(0.6),
  color: z.string().optional(),
})
export type Section = z.infer<typeof sectionSchema>

export const timeSignatureSchema = z.object({
  numerator: z.number().min(1).max(16).default(4),
  denominator: z.number().min(1).max(16).default(4),
})
export type TimeSignature = z.infer<typeof timeSignatureSchema>

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().default(PROJECT_VERSION),
  /** 主要风格（Studio 新建时选择；留空 = 未知/混合，老工程没有这个字段） */
  style: z.string().optional(),
  /** 用途场景 id（battle/town/ending…），用于展示创作意图与二次生成 */
  scene: z.string().optional(),
  tempo: z.number().min(20).max(320).default(110),
  timeSignature: timeSignatureSchema,
  key: z.string().default('C'),
  scale: z.string().default('major'),
  swing: z.number().min(0).max(1).default(0),
  masterVolume: z.number().min(0).max(1.5).default(0.9),
  tracks: z.array(trackSchema).default([]),
  sections: z.array(sectionSchema).default([]),
  /** 全曲和弦进行（每小节/每几拍一个） */
  chords: z.array(chordSpecSchema).default([]),
  /** 资产登记表：音频/波形/MIDI/分析产物的引用集中在此，工程本身不内联二进制 */
  assets: z.array(assetRefSchema).default([]),
  /** 音频分析结果（bpm / 和弦 / 节拍锚点） */
  analyses: z.array(analysisRecordSchema).default([]),
  /** 总线 / 母带处理链（P3.2：总线 EQ + 母线压缩 + 限幅上限），空 = 不处理 */
  masterChain: masterChainSchema.optional(),
  loop: z.object({ enabled: z.boolean(), startBeat: z.number(), endBeat: z.number() }).default({
    enabled: false,
    startBeat: 0,
    endBeat: 16,
  }),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Project = Omit<
  z.infer<typeof projectSchema>,
  'scale' | 'tracks' | 'chords' | 'assets' | 'analyses'
> & {
  scale: ScaleId
  tracks: Track[]
  chords: ChordSpec[]
  assets: AssetRef[]
  analyses: AnalysisRecord[]
  timeSignature: TimeSignature
  loop: { enabled: boolean; startBeat: number; endBeat: number }
}

export const projectPatchSchema = z.object({
  baseVersion: z.number().optional(),
  project: projectSchema,
  label: z.string().optional(),
})
export type ProjectPatch = z.infer<typeof projectPatchSchema>

/* ------------------------------------------------------------------ */
/* 工厂函数                                                            */
/* ------------------------------------------------------------------ */

export function createNote(pitch: number, start: number, duration: number, velocity = 90, id?: string): NoteEvent {
  return { id: id ?? newId('n'), pitch, start, duration, velocity }
}

export function createClip(partial: Partial<Clip> & { trackId: string }): Clip {
  return {
    id: partial.id ?? newId('c'),
    trackId: partial.trackId,
    name: partial.name ?? '片段',
    color: partial.color,
    startBeat: partial.startBeat ?? 0,
    lengthBeats: partial.lengthBeats ?? 16,
    notes: partial.notes ?? [],
    muted: partial.muted ?? false,
    smart: partial.smart,
  }
}

export function createTrack(partial: Partial<Track> & { instrumentId: string; emotionId: string }): Track {
  return {
    id: partial.id ?? newId('t'),
    name: partial.name ?? '新轨道',
    color: partial.color ?? '#7f9cf5',
    kind: partial.kind ?? 'instrument',
    instrumentId: partial.instrumentId,
    emotionId: partial.emotionId,
    gmProgram: partial.gmProgram ?? 0,
    engine: partial.engine ?? 'auto',
    volume: partial.volume ?? 0.8,
    pan: partial.pan ?? 0,
    mute: partial.mute ?? false,
    solo: partial.solo ?? false,
    reverbSend: partial.reverbSend ?? 0.18,
    delaySend: partial.delaySend ?? 0.06,
    octaveShift: partial.octaveShift ?? 0,
    clips: partial.clips ?? [],
    audioClips: partial.audioClips ?? [],
  }
}

export function createSection(partial: Partial<Section> & { name: string; startBar: number; bars: number }): Section {
  return {
    id: partial.id ?? newId('s'),
    name: partial.name,
    startBar: partial.startBar,
    bars: partial.bars,
    energy: partial.energy ?? 0.6,
    color: partial.color,
  }
}

export function createChord(root: number, quality: ChordQualityId = 'maj', beats = 4): ChordSpec {
  return { root: ((root % 12) + 12) % 12, quality, beats }
}

export interface CreateProjectOptions {
  name?: string
  style?: StyleId
  key?: string
  scale?: ScaleId
  tempo?: number
  timeSignature?: TimeSignatureId
}

/** 空工程（4 轨骨架由上层编排服务填充） */
export function createEmptyProject(opts: CreateProjectOptions = {}): Project {
  const now = Date.now()
  const [num, den] = (opts.timeSignature ?? '4/4').split('/').map((n) => parseInt(n, 10))
  return {
    id: newId('p'),
    name: opts.name ?? '未命名工程',
    version: PROJECT_VERSION,
    ...(opts.style ? { style: opts.style } : {}),
    tempo: opts.tempo ?? 110,
    timeSignature: { numerator: num || 4, denominator: den || 4 },
    key: opts.key ?? 'C',
    scale: opts.scale ?? 'major',
    swing: 0,
    masterVolume: 0.9,
    tracks: [],
    sections: [],
    chords: [],
    assets: [],
    analyses: [],
    loop: { enabled: false, startBeat: 0, endBeat: 16 },
    createdAt: now,
    updatedAt: now,
  }
}

export function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value)) as T
}

/* ------------------------------------------------------------------ */
/* 时间换算                                                            */
/* ------------------------------------------------------------------ */

export function beatsPerBar(ts: TimeSignature): number {
  return (ts.numerator * 4) / ts.denominator
}

export function beatToBar(beat: number, ts: TimeSignature): number {
  return Math.floor(beat / beatsPerBar(ts))
}

export function barToBeat(bar: number, ts: TimeSignature): number {
  return bar * beatsPerBar(ts)
}

/** 工程总长度（拍） */
export function projectEndBeat(project: Project): number {
  let end = 0
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      end = Math.max(end, clip.startBeat + clip.lengthBeats)
    }
    for (const clip of track.audioClips ?? []) {
      end = Math.max(end, clip.startBeat + clip.lengthBeats)
    }
  }
  if (project.sections.length) {
    const last = project.sections[project.sections.length - 1]
    end = Math.max(end, barToBeat(last.startBar + last.bars, project.timeSignature))
  }
  return Math.max(end, beatsPerBar(project.timeSignature) * 4)
}

export function projectEndBar(project: Project): number {
  return Math.ceil(projectEndBeat(project) / beatsPerBar(project.timeSignature))
}

/** 全曲有效的打击乐/乐器音高范围 */
export function trackPitchRange(track: Track): { min: number; max: number } {
  if (track.kind === 'drum') return { min: 35, max: 81 }
  let min = 127
  let max = 0
  for (const clip of track.clips) {
    for (const note of clip.notes) {
      min = Math.min(min, note.pitch)
      max = Math.max(max, note.pitch)
    }
  }
  if (min > max) return { min: 48, max: 72 }
  return { min: Math.max(0, min - 6), max: Math.min(127, max + 6) }
}

/* ------------------------------------------------------------------ */
/* Studio 扩展：资产 / 音频片段工厂与版本迁移                            */
/* ------------------------------------------------------------------ */

export function createAssetRef(
  partial: Partial<AssetRef> & { sha256: string; kind: AssetRef['kind'] },
): AssetRef {
  return {
    id: partial.id ?? newId('as'),
    sha256: partial.sha256,
    kind: partial.kind,
    bytes: partial.bytes ?? 0,
    durationMs: partial.durationMs,
    sampleRate: partial.sampleRate,
    channels: partial.channels,
    residency: partial.residency ?? 'local',
    deviceId: partial.deviceId,
    localPath: partial.localPath,
    previewUrl: partial.previewUrl,
    name: partial.name,
    createdAt: partial.createdAt ?? Date.now(),
  }
}

export function createAudioClip(
  partial: Partial<AudioClip> & { trackId: string; assetId: string; durationSec: number },
): AudioClip {
  return {
    id: partial.id ?? newId('ac'),
    trackId: partial.trackId,
    name: partial.name ?? '音频片段',
    color: partial.color,
    startBeat: partial.startBeat ?? 0,
    lengthBeats: partial.lengthBeats ?? Math.max(0.25, (partial.durationSec * 120) / 60),
    assetId: partial.assetId,
    offsetSec: partial.offsetSec ?? 0,
    durationSec: partial.durationSec,
    gainDb: partial.gainDb ?? 0,
    fadeInBeats: partial.fadeInBeats ?? 0,
    fadeOutBeats: partial.fadeOutBeats ?? 0,
    stretchRatio: partial.stretchRatio ?? 1,
    muted: partial.muted ?? false,
    provenance: partial.provenance,
    takes: partial.takes ?? [],
    activeTakeId: partial.activeTakeId,
  }
}

export function createTake(partial: Partial<Take> & { assetId: string; provenance: Provenance }): Take {
  return {
    id: partial.id ?? newId('tk'),
    assetId: partial.assetId,
    label: partial.label ?? '',
    provenance: partial.provenance,
    favorite: partial.favorite ?? false,
    createdAt: partial.createdAt ?? Date.now(),
  }
}

/**
 * 工程版本迁移：把任意版本的原始工程对象升级到当前版本。
 * 只补齐新增字段，**不修改已有语义**；解析失败会抛出 zod 错误由调用方处理。
 */
export function migrateProject(raw: unknown): Project {
  const obj = (raw ?? {}) as Record<string, unknown>
  const rawTracks = Array.isArray(obj.tracks) ? obj.tracks : []
  const upgraded = {
    ...obj,
    version: PROJECT_VERSION,
    assets: Array.isArray(obj.assets) ? obj.assets : [],
    analyses: Array.isArray(obj.analyses) ? obj.analyses : [],
    tracks: rawTracks.map((track) => {
      const t = (track ?? {}) as Record<string, unknown>
      const kind = t.kind === 'audio' || t.kind === 'drum' ? t.kind : 'instrument'
      return {
        ...t,
        kind,
        clips: Array.isArray(t.clips) ? t.clips : [],
        audioClips: Array.isArray(t.audioClips) ? t.audioClips : [],
      }
    }),
  }
  return projectSchema.parse(upgraded) as Project
}

export function isAudioTrack(track: Track): boolean {
  return track.kind === 'audio'
}

