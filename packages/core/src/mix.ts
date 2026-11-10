/**
 * AI 混音（MIDI 域版）：按「声部角色 × 风格 × 能量」给出可解释的混音方案。
 *
 * 边界说明：
 * - `suggestMix` 管"推子"（音量/声像/发送/总线）；`suggestMixChains` 管音频域处理链（EQ/压缩），
 *   后者由 Web Audio 引擎实时执行，见 mixChain.ts。
 * - 方案是纯函数：同工程同参数给同一结果，可预览、可整批应用、可一步撤销。
 */
import { STYLES, type StyleId } from './constants.js'
import { deepClone, type Project, type Track } from './model.js'
import { describeChain, suggestRoleChain, type MixRole, type TrackChainSuggestion } from './mixChain.js'
import type { MasterChain } from './masterChain.js'

export type { MixRole } from './mixChain.js'

export interface MixRoleTarget {
  volume: number
  pan: number
  reverbSend: number
  delaySend: number
}

export interface MixTrackPlan extends MixRoleTarget {
  trackId: string
  name: string
  role: MixRole
  /** 推子对应的 dB（volume → dBFS 线性增益），仅用于展示 */
  gainDb: number
  reasons: string[]
}

export interface MixPlan {
  style: StyleId
  energy: number
  tracks: MixTrackPlan[]
  masterVolume: number
  /** 整体说明，给 UI 直接展示 */
  notes: string[]
}

/* ------------------------------------------------------------------ */
/* 角色识别                                                            */
/* ------------------------------------------------------------------ */

const BASS_HINTS = ['bass', 'cello', 'contrabass', 'tuba', 'bassoon', 'synth.sub']
const PAD_HINTS = ['strings.ensemble', 'pad', 'organ', 'choir', 'synth.pad']
const ARP_HINTS = ['harp', 'celesta', 'glockenspiel', 'marimba', 'synth.arp', 'kalimba']
const PERC_HINTS = ['timpani', 'percussion', 'taiko', 'cymbal']

export function detectMixRole(track: Track): MixRole {
  const id = track.instrumentId.toLowerCase()
  if (track.kind === 'drum' || id.startsWith('drums.') || PERC_HINTS.some((h) => id.includes(h))) return 'drums'

  // 智能片段的类型是最可靠的声部线索（track.kind 只有 instrument/drum/audio 三等分）
  const smartKind = track.clips.find((clip) => clip.smart)?.smart?.kind
  switch (smartKind) {
    case 'drums':
      return 'drums'
    case 'bass':
      return 'bass'
    case 'chords':
    case 'strum':
    case 'riff':
      return 'harmony'
    case 'pad':
      return 'pad'
    case 'melody':
      return 'lead'
    case 'counter':
      return 'counter'
    case 'arp':
      return 'arp'
    default:
      break
  }

  if (track.name.includes('主旋律')) return 'lead'
  if (BASS_HINTS.some((h) => id.includes(h))) return 'bass'
  if (ARP_HINTS.some((h) => id.includes(h))) return 'arp'
  if (PAD_HINTS.some((h) => id.includes(h))) return 'pad'
  return 'other'
}

/* ------------------------------------------------------------------ */
/* 风格曲线                                                            */
/* ------------------------------------------------------------------ */

const BASE_TARGET: Record<MixRole, MixRoleTarget> = {
  drums: { volume: 0.86, pan: 0, reverbSend: 0.08, delaySend: 0 },
  bass: { volume: 0.8, pan: 0, reverbSend: 0.04, delaySend: 0 },
  harmony: { volume: 0.74, pan: 0.24, reverbSend: 0.12, delaySend: 0.04 },
  pad: { volume: 0.58, pan: 0.34, reverbSend: 0.24, delaySend: 0.06 },
  lead: { volume: 0.82, pan: 0, reverbSend: 0.14, delaySend: 0.1 },
  counter: { volume: 0.62, pan: -0.28, reverbSend: 0.16, delaySend: 0.06 },
  arp: { volume: 0.55, pan: 0.42, reverbSend: 0.26, delaySend: 0.12 },
  other: { volume: 0.7, pan: 0, reverbSend: 0.14, delaySend: 0.04 },
}

/** 每个风格在基准曲线上的偏移（只写差异项） */
const STYLE_OFFSETS: Partial<Record<StyleId, Partial<Record<MixRole, Partial<MixRoleTarget>>>>> = {
  jrock: {
    drums: { volume: 0.04, reverbSend: -0.04 },
    harmony: { volume: 0.06, pan: 0.32 },
    pad: { volume: -0.06, pan: 0.3 },
    lead: { volume: 0.02 },
    counter: { volume: 0.04, pan: -0.32 },
  },
  jrpg: {
    pad: { volume: 0.1, pan: 0.4, reverbSend: 0.04 },
    drums: { volume: -0.06 },
    harmony: { volume: -0.12, pan: 0.18 },
    arp: { volume: 0.04, pan: 0.5 },
    lead: { volume: 0.02 },
  },
  cinematic: {
    pad: { volume: 0.08, pan: 0.46, reverbSend: 0.08 },
    drums: { volume: -0.1, reverbSend: 0.06 },
    lead: { volume: 0.04, reverbSend: 0.08 },
    arp: { reverbSend: 0.08 },
  },
  classical: {
    pad: { volume: 0.06, pan: 0.42, reverbSend: 0.06 },
    drums: { volume: -0.12, reverbSend: 0.08 },
    harmony: { pan: 0.2 },
  },
  rock: {
    drums: { volume: 0.05 },
    harmony: { volume: 0.06, pan: 0.3 },
    pad: { volume: -0.08 },
  },
  electronic: {
    drums: { volume: 0.06, reverbSend: -0.04 },
    bass: { volume: 0.04 },
    arp: { volume: 0.05, delaySend: 0.08 },
    pad: { delaySend: 0.06 },
  },
  jazz: {
    drums: { volume: -0.04, reverbSend: 0.04 },
    bass: { volume: 0.04 },
    harmony: { volume: 0.02, pan: 0.16 },
  },
  pop: {
    lead: { volume: 0.06, reverbSend: -0.02 },
    drums: { volume: 0.03 },
    pad: { volume: -0.04 },
  },
  folk: {
    harmony: { volume: 0.02, reverbSend: -0.04 },
    drums: { volume: -0.06 },
    pad: { reverbSend: -0.04 },
  },
}

/* ------------------------------------------------------------------ */
/* 生成方案                                                            */
/* ------------------------------------------------------------------ */

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

function styleName(style: StyleId): string {
  return STYLES[style]?.name ?? style
}

/** 同角色多轨时做左右分散，避免全挤在中间 */
function spreadPan(role: MixRole, basePan: number, index: number, total: number): number {
  if (role === 'drums' || role === 'bass' || role === 'lead') return 0
  if (total <= 1) return clamp(basePan, -0.65, 0.65)
  const step = role === 'pad' ? 0.18 : role === 'harmony' ? 0.2 : 0.26
  const sign = index % 2 === 0 ? 1 : -1
  const tier = Math.floor(index / 2) + 1
  return clamp(basePan + sign * step * tier, -0.65, 0.65)
}

/**
 * 生成混音方案。纯函数、确定性：同一工程 + 同一参数 → 同一方案。
 */
export function suggestMix(project: Project, opts: { style?: StyleId; energy?: number } = {}): MixPlan {
  const style = opts.style ?? (project.style as StyleId | undefined) ?? 'pop'
  const avgSectionEnergy = project.sections.length
    ? project.sections.reduce((sum, s) => sum + s.energy, 0) / project.sections.length
    : 0.6
  const energy = clamp(opts.energy ?? avgSectionEnergy, 0, 1)
  const offsets = STYLE_OFFSETS[style] ?? {}

  // 先按角色分组，便于分散声像与做整体平衡
  const roles = project.tracks.map((track) => detectMixRole(track))
  const counts = new Map<MixRole, number>()
  for (const role of roles) counts.set(role, (counts.get(role) ?? 0) + 1)
  const seen = new Map<MixRole, number>()

  const energyUp = energy - 0.6
  const tracks: MixTrackPlan[] = project.tracks.map((track, index) => {
    const role = roles[index]!
    const base = BASE_TARGET[role]
    const offset = offsets[role] ?? {}
    const indexInRole = seen.get(role) ?? 0
    seen.set(role, indexInRole + 1)

    let volume = base.volume + (offset.volume ?? 0)
    let reverb = base.reverbSend + (offset.reverbSend ?? 0)
    const delay = (base.delaySend + (offset.delaySend ?? 0)) * (1 + Math.max(0, -energyUp) * 0.3)
    // 能量越高：鼓/贝斯前推、pad 后撤、混响收紧
    if (role === 'drums' || role === 'bass' || role === 'harmony' || role === 'lead') volume += energyUp * 0.12
    if (role === 'pad' || role === 'arp') volume -= energyUp * 0.12
    reverb -= energyUp * 0.08
    // 声部越多，单轨略退，给总线留 headroom
    if (project.tracks.length > 8) volume -= 0.02 * (project.tracks.length - 8)

    volume = clamp(volume, 0.1, 1.2)
    reverb = clamp(reverb, 0, 0.6)
    const pan = spreadPan(role, base.pan + (offset.pan ?? 0), indexInRole, counts.get(role) ?? 1)

    const reasons: string[] = []
    if (role === 'drums') reasons.push('鼓组居中、少混响，保证冲击力')
    else if (role === 'bass') reasons.push('贝斯居中，与底鼓同轴')
    else if (role === 'lead') reasons.push('主旋律置于中央并略送延迟，突出叙事')
    else if (role === 'harmony') reasons.push('和声/节奏声部对置声像，让出中频')
    else if (role === 'pad') reasons.push('铺底放宽声像、多送混响，做空间层')
    else if (role === 'arp') reasons.push('琶音走两侧并加延迟，制造流动感')
    else if (role === 'counter') reasons.push('对位声部放在反侧，避免与主旋律冲突')
    if (energyUp > 0.12) reasons.push('高能量：收紧混响、前推节奏声部')
    else if (energyUp < -0.12) reasons.push('低能量：放宽混响、后撤节奏声部')

    return {
      trackId: track.id,
      name: track.name,
      role,
      volume: Math.round(volume * 100) / 100,
      pan: Math.round(pan * 100) / 100,
      reverbSend: Math.round(reverb * 100) / 100,
      delaySend: Math.round(clamp(delay, 0, 0.5) * 100) / 100,
      gainDb: Math.round(20 * Math.log10(Math.max(volume, 0.001)) * 10) / 10,
      reasons,
    }
  })

  const masterVolume = Math.round(clamp(0.92 - Math.max(0, project.tracks.length - 8) * 0.01, 0.7, 0.95) * 100) / 100
  const notes = [
    `${styleName(style)} · 能量 ${Math.round(energy * 100)}%`,
    `按 ${tracks.length} 条轨道的声部角色分配音量与声像`,
    '只改轨道参数（可撤销），不做频段/动态处理',
  ]

  return { style, energy: Math.round(energy * 100) / 100, tracks, masterVolume, notes }
}

/**
 * 应用方案：返回新工程（不修改入参），由调用方决定是否记一条撤销。
 */
export function applyMixPlan(project: Project, plan: MixPlan): Project {
  const next = deepClone(project)
  const byId = new Map(plan.tracks.map((item) => [item.trackId, item]))
  next.tracks = next.tracks.map((track) => {
    const item = byId.get(track.id)
    if (!item) return track
    return {
      ...track,
      volume: clamp(item.volume, 0, 1.5),
      pan: clamp(item.pan, -1, 1),
      reverbSend: clamp(item.reverbSend, 0, 1),
      delaySend: clamp(item.delaySend, 0, 1),
    }
  })
  next.masterVolume = clamp(plan.masterVolume, 0, 1.5)
  next.updatedAt = Date.now()
  return next
}

/** 方案差异摘要（应用前给用户看"会改什么"） */
export function summarizeMixPlan(project: Project, plan: MixPlan): string[] {
  const current = new Map(project.tracks.map((track) => [track.id, track]))
  return plan.tracks.map((item) => {
    const track = current.get(item.trackId)
    const delta = track ? Math.round((item.volume - track.volume) * 100) : 0
    const sign = delta > 0 ? '+' : ''
    return `${item.name}：音量 ${item.volume.toFixed(2)}（${sign}${delta}）· 声像 ${item.pan.toFixed(2)} · 混响 ${item.reverbSend.toFixed(2)}`
  })
}

/* ------------------------------------------------------------------ */
/* 音频域处理链（EQ + 压缩，P3）                                       */
/* ------------------------------------------------------------------ */

export interface MixChainPlan {
  style: StyleId
  energy: number
  tracks: TrackChainSuggestion[]
  notes: string[]
}

/**
 * 给每条轨道生成 EQ + 压缩链。纯函数、确定性，与 `suggestMix` 独立：
 * 推子方案（音量/声像/发送）和音色处理链可以分开应用，也可以一起。
 */
export function suggestMixChains(project: Project, opts: { style?: StyleId; energy?: number } = {}): MixChainPlan {
  const style = opts.style ?? (project.style as StyleId | undefined) ?? 'pop'
  const avgSectionEnergy = project.sections.length
    ? project.sections.reduce((sum, section) => sum + section.energy, 0) / project.sections.length
    : 0.6
  const energy = clamp(opts.energy ?? avgSectionEnergy, 0, 1)
  const energyUp = energy - 0.6

  const tracks: TrackChainSuggestion[] = project.tracks.map((track) => {
    const role = detectMixRole(track)
    const chain = suggestRoleChain(role, style, energy)
    const reasons: string[] = []
    if (role === 'drums') reasons.push('鼓组：抬低频与高频、压中低箱声，收紧动态')
    else if (role === 'bass') reasons.push('贝斯：补低频、切中低浑浊，稳住动态')
    else if (role === 'lead') reasons.push('主旋律：切低频泥、推 3kHz 存在感')
    else if (role === 'harmony') reasons.push('和声：避让中频、提亮拾音')
    else if (role === 'pad') reasons.push('铺底：削低频、加空气感，轻压缩')
    else if (role === 'counter') reasons.push('对位：与主旋律错开频段')
    else if (role === 'arp') reasons.push('琶音：切低频、提亮颗粒')
    else reasons.push('通用：轻度压缩，保留动态')
    if (energyUp > 0.12) reasons.push('高能量：压缩比与阈值偏紧')
    else if (energyUp < -0.12) reasons.push('低能量：保留更多动态')
    return {
      trackId: track.id,
      name: track.name,
      role,
      chain,
      reasons,
    }
  })

  return {
    style,
    energy: Math.round(energy * 100) / 100,
    tracks,
    notes: [
      `${styleName(style)} · 能量 ${Math.round(energy * 100)}%`,
      `${tracks.length} 条轨道：三段 EQ + 压缩 + 补偿增益`,
      '只改音色与动态，不改音符、推子与发送',
    ],
  }
}

/** 应用处理链：返回新工程（不修改入参），由调用方决定撤销粒度 */
export function applyMixChains(project: Project, plan: MixChainPlan): Project {
  const next = deepClone(project)
  const byId = new Map(plan.tracks.map((item) => [item.trackId, item.chain]))
  next.tracks = next.tracks.map((track) => {
    const chain = byId.get(track.id)
    if (!chain) return track
    return { ...track, mixChain: chain }
  })
  next.updatedAt = Date.now()
  return next
}

/** 处理链摘要（UI 预览用） */
export function summarizeMixChains(plan: MixChainPlan): string[] {
  return plan.tracks.map((item) => `${item.name}（${item.role}）：${describeChain(item.chain)}`)
}

/** 清除所有轨道的处理链（返回新工程） */
export function clearMixChains(project: Project): Project {
  const next = deepClone(project)
  next.tracks = next.tracks.map((track) => {
    if (!track.mixChain) return track
    const { mixChain: _mixChain, ...rest } = track
    return rest as typeof track
  })
  next.updatedAt = Date.now()
  return next
}

/* ------------------------------------------------------------------ */
/* 总线 / 母带处理链（P3.2）                                            */
/* ------------------------------------------------------------------ */

/** 把母带链写入工程（返回新工程，不修改入参） */
export function applyMasterChain(project: Project, chain: MasterChain): Project {
  const next = deepClone(project)
  next.masterChain = chain
  next.updatedAt = Date.now()
  return next
}

/** 清除母带链（返回新工程） */
export function clearMasterChain(project: Project): Project {
  const next = deepClone(project)
  delete next.masterChain
  next.updatedAt = Date.now()
  return next
}
