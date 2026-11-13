/**
 * 音频资产落轨（导入 / AI 生成共用）。
 *
 * **一次 store.mutate 内完成**：新增一条 `kind:'audio'` 轨道 + 一个 AudioClip +
 * 把 AssetRef 登记进 `project.assets`，因此整批改动只有一个撤销点。
 *
 * 关键语义（见 packages/core/src/audio.ts）：
 * - 工程里只存资产引用（assetId），不内联二进制；
 * - 片段拍长按工程 BPM 换算：`lengthBeats = durationSec / 60 * tempo`；
 * - 一期 `stretchRatio` **固定 1**：不做变速 / 时间拉伸（WebAudio 变速会变调，
 *   保音高需要 WASM phase vocoder，后续再启用）；
 * - 音频片段与 MIDI 片段平行：放在 `track.audioClips`，不占 `track.clips`。
 */
import {
  createAssetRef,
  createAudioClip,
  createTake,
  createTrack,
  getInstrument,
  newId,
  type AssetRef,
  type AudioClip,
  type Project,
  type Provenance,
  type Take,
} from '@aiab/core'
import type { AssetPeaksResult } from '../../lib/api'
import { TRACK_COLORS } from '../arrangement/timeline'

/**
 * 音频轨没有乐器，但 trackSchema 要求 instrumentId/emotionId 合法，
 * 混音器 / 轨道头也会读情绪参数，因此挂一个合法乐器的元数据占位。
 */
const AUDIO_TRACK_INSTRUMENT = 'piano.grand'

const round3 = (value: number): number => Math.round(value * 1000) / 1000

/** 秒 → 拍（一期不变速：直接按工程 BPM 线性换算） */
export function audioSecondsToBeats(durationSec: number, tempo: number): number {
  return Math.max(0.25, round3((Math.max(0, durationSec) / 60) * Math.max(20, tempo)))
}

/** 拍 → 秒（与 audioSecondsToBeats 互逆） */
export function audioBeatsToSeconds(beats: number, tempo: number): number {
  return (Math.max(0, beats) / Math.max(20, tempo)) * 60
}

/** 由上传结果 / 生成结果的峰值信息构造 AssetRef（服务端已给完整 AssetRef 时优先用那个） */
export function assetRefFromPeaks(
  assetId: string,
  peaks: AssetPeaksResult,
  options: { name?: string; sha256?: string; bytes?: number } = {},
): AssetRef {
  return createAssetRef({
    id: assetId,
    sha256: options.sha256 ?? '',
    kind: 'audio',
    bytes: options.bytes ?? 0,
    durationMs: Math.round(Math.max(0, peaks.durationSec) * 1000),
    sampleRate: peaks.sampleRate || undefined,
    channels: peaks.channels || undefined,
    residency: 'local',
    name: options.name,
    createdAt: Date.now(),
  })
}

/* ------------------------------------------------------------------ */
/* 分轨落轨增益（缺陷：分轨叠加比整曲响 14dB 并削顶到 peak 3.15）        */
/* ------------------------------------------------------------------ */

/** 叠加总峰值的硬上限：留 10% 余量，低于 1.0 全刻度就不会削顶 */
export const STEM_SUM_HEADROOM = 0.9
/** 推子下限：再低就等价于静音，留给用户自己推上去 */
export const STEM_VOLUME_MIN = 0.02

const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0

/**
 * 资产实测峰值绝对值（0..1+）：取 `peaks` 里 min/max 的全局极值。
 *
 * 为什么用峰值而不是 RMS：落轨时手上只有 `GET /api/assets/:id/peaks` 的 512 桶
 * min/max（已经请求过了），而 RMS 必须自己拉 44MB WAV 逐采样算。
 * 峰值这条路是可证的：服务端 `parseWav` 的桶内 min/max 是**真实采样极值**（只降采样
 * 到 512 桶，不丢极值），实测推出的峰值与逐采样最大值逐位一致。
 *
 * 已知代价：峰值预算不是等响匹配。实测两种做法在真实分轨上的频段失真为
 * 57.1pp（等增益）vs 47.2pp（等响匹配）——等响更好，但 (a) 需要额外解码 6×44MB，
 * (b) 从 512 桶 min/max 反推 RMS 完全不可靠（实测 5 种估计式的偏差散布 ±3.4dB），
 * 只能用峰值预算。等响匹配列为后续优化，不是已完成的改进。
 */
export function assetPeakFromPeaks(peaks: number[] | undefined): number {
  if (!Array.isArray(peaks) || peaks.length === 0) return 0
  let peak = 0
  for (const value of peaks) {
    if (!Number.isFinite(value)) continue
    const magnitude = Math.abs(value)
    if (magnitude > peak) peak = magnitude
  }
  return peak
}

/**
 * 分轨落轨音量（纯函数）。
 *
 * 为什么不能直接用 0.8：实测用户工程 `p_7atqcqig`，6 条分轨各按 0.8 叠加后
 * RMS 比整曲高 **+13.87 dB**、峰值 **3.149**（严重削顶）。根因是**引擎对每个输出
 * 文件独立做峰值归一化**（同一工程 7 个文件峰值全是 0.99997，而 RMS 从 -13.7 到
 * -20.7 dBFS 不等）——分轨之间的相对电平不含音乐信息，等增益叠加必然爆表。
 *
 * 推导（相位无关上界，因此不需要知道分轨之间的相干性）：
 *   |Σ g_i·x_i| ≤ Σ g_i·peak_i ，取所有 g_i 相同 g = budget/n 时上界正好是 budget。
 *   budget = min(HEADROOM, 整曲有效峰值)  —— 「分轨总和不超过整曲」+「不削顶」
 *   g      = budget / n
 *   再按单轨自身不削顶收紧：g ≤ HEADROOM / stemPeak
 *
 * n 条同峰值时 g = budget/n；因为引擎已把所有分轨峰值拉齐到 ~1.0，
 * 该式实际退化成一个「等分预算」的统一增益 —— 这正是正确的，不是偷懒。
 *
 * ## 读这段注释的人请注意：增益分级**没有**解决「糊」
 *
 * 分轨是**各自重合成的近似物，不是原曲的分解**，两者都是实测结论：
 *
 * 1) 分轨之间**正相干**：单位增益下 5 条乐器叠加实测 -6.08 dBFS，
 *    比「不相关」的等功率模型（sqrt(Σ) = -9.66 dBFS）高 +3.58 dB；
 *    两两在 1–6kHz 的相关最高 +0.43。所以**任何相位无关的混音建议都会偏**，
 *    包括「把所有分轨推子都设成 0.8」这种看起来无害的做法 —— 实测那条路
 *    peak 3.149、11.2% 采样贴顶。
 * 2) 中频/中高频根本不在分轨里：逐条实测 500–2000Hz 能量只有整曲同频段的
 *    **0.04–0.55 倍**，2–6kHz 只有 0.01–0.71 倍，且该频段与整曲相关仅
 *    **+0.006…+0.088**。叠加后中频缺 14.1pp、中高频缺 16.6pp。
 *    增益是线性缩放，**改不了频段占比**（实测修复前后占比逐位相同）。
 *
 * 换句话说：用户抱怨的「糊」= 中频/中高频缺失，**这个函数修不了**，
 * 它只修「14dB 过响 + 削顶」。要真正改善糊，得从引擎侧（extract 的分离能力）
 * 想办法，或改用真正的分离模型；不要在这里继续调增益然后以为问题解决了。
 *
 * ## 本函数的保证边界（别过度承诺）
 *
 * 只保证**落轨默认音量**下 sum 不削顶（相位无关上界 Σgᵢ·peakᵢ ≤ budget ≤ 0.9）。
 * DAW 允许用户事后把推子推到 1.5，**那时仍会削顶**——实测 6 条分轨全部推到
 * 0.8 时 peak 3.149、推到 1.0 时 peak 3.936。这是刻意的产品取舍：
 * 用户要能"推得动"，而不是被一个隐藏的总线限制器锁死。
 */
export function stemPlacementVolume(input: {
  /** 本分轨资产实测峰值（`GET /api/assets/:id/peaks` 的 min/max 全局极值） */
  stemPeak: number
  /** 同批一起落轨的分轨条数（含本条），用于等分叠加预算 */
  stemCount: number
  /** 整曲轨有效峰值 = 整曲资产原始峰值 × 整曲轨音量 */
  songPeak: number
}): number {
  const count = Math.max(1, Math.floor(Number(input.stemCount) || 1))
  const stemPeak = finitePositive(input.stemPeak) ? input.stemPeak : 1
  // 整曲峰值未知（旧服务端 / 峰值接口失败）时退回固定余量，仍然保证不削顶
  const songPeak = finitePositive(input.songPeak) ? input.songPeak : STEM_SUM_HEADROOM
  const budget = Math.min(STEM_SUM_HEADROOM, songPeak)
  const bySum = budget / count
  const bySelf = STEM_SUM_HEADROOM / stemPeak
  const volume = Math.min(bySum, bySelf)
  // 永不为负 / NaN / 超过 1.0；上限 1.0 保证用户还能自己往上推（推子 ≤1.5）
  return Math.min(1, Math.max(STEM_VOLUME_MIN, volume))
}

export interface PlaceAudioInput {
  asset: AssetRef
  /** 有效音频时长（秒），来自上传返回或 peaks 接口 */
  durationSec: number
  name: string
  /** 落轨位置（拍），一般取播放头 */
  startBeat: number
  trackName?: string
  color?: string
  /** 生成产物的溯源（导入时为 import） */
  provenance?: Provenance
  /** 轨道推子音量；缺省 0.8（导入 / MIDI 渲染 / 重绘都是这个值，保持原行为） */
  volume?: number
}

/**
 * 把一段音频资产落到工程里（调用方负责包在 store.mutate 里）。
 * 返回新轨道 / 片段 id，便于上层选中和 toast。
 */
export function placeAudioClip(draft: Project, input: PlaceAudioInput): { trackId: string; clipId: string } {
  const instrument = getInstrument(AUDIO_TRACK_INSTRUMENT)
  const color = input.color ?? TRACK_COLORS[draft.tracks.length % TRACK_COLORS.length]
  const track = createTrack({
    name: input.trackName ?? `音频 · ${input.name}`,
    color,
    kind: 'audio',
    instrumentId: instrument.id,
    emotionId: instrument.emotions[0].id,
    gmProgram: instrument.gmProgram,
    // 分轨会传入按实测峰值推导的音量；其余场景（导入/渲染/重绘）保持 0.8
    volume: Number.isFinite(input.volume) && (input.volume as number) > 0 ? Math.min(1.5, input.volume as number) : 0.8,
  })
  const clip = createAudioClip({
    trackId: track.id,
    name: input.name,
    assetId: input.asset.id,
    startBeat: Math.max(0, round3(input.startBeat)),
    lengthBeats: audioSecondsToBeats(input.durationSec, draft.tempo),
    offsetSec: 0,
    durationSec: Math.max(0.01, round3(input.durationSec)),
    gainDb: 0,
    fadeInBeats: 0,
    fadeOutBeats: 0,
    /* 一期固定 1：与走带同步，不做变速 / 时间拉伸 */
    stretchRatio: 1,
    muted: false,
    takes: [],
    provenance: input.provenance,
  })
  track.audioClips.push(clip)
  draft.tracks.push(track)
  if (!draft.assets.some((item) => item.id === input.asset.id)) draft.assets.push(input.asset)
  return { trackId: track.id, clipId: clip.id }
}

/** 删除音频片段（同样一次 mutate） */
export function removeAudioClip(draft: Project, trackId: string, clipId: string): boolean {
  const track = draft.tracks.find((item) => item.id === trackId)
  if (!track) return false
  const before = track.audioClips.length
  track.audioClips = track.audioClips.filter((clip) => clip.id !== clipId)
  return track.audioClips.length !== before
}

/** 生成任务的溯源快照（同 seed 可复现 / 合规追溯） */
export function generatedAudioProvenance(params: {
  caption: string
  seed?: number
  adapterId?: string
  bpm?: number
  durationSec?: number
  style?: string
  keyscale?: string
}): Provenance {
  const extra: Record<string, unknown> = {}
  if (params.bpm != null) extra.bpm = params.bpm
  if (params.durationSec != null) extra.durationSec = params.durationSec
  if (params.style) extra.style = params.style
  if (params.keyscale) extra.keyscale = params.keyscale
  return {
    source: 'ace-step',
    modelId: 'ace-step',
    adapterIds: params.adapterId ? [params.adapterId] : [],
    seed: params.seed,
    prompt: params.caption,
    params: extra,
    sourceAssetIds: [],
    createdAt: Date.now(),
  }
}

/** 从文件名里取出不带扩展名的片段名 */
export function audioFileBaseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '') || '音频片段'
}

/** 判断某个片段是否是可播放的音频片段（供 UI / 调试用） */
export function isPlayableAudioClip(clip: AudioClip): boolean {
  return Boolean(clip.assetId) && clip.lengthBeats > 0 && clip.durationSec > 0
}

/* ------------------------------------------------------------------ */
/* P2-B：局部重绘与 takes（版本）                                        */
/* ------------------------------------------------------------------ */

/** 老片段没有 provenance 时给 take 一个合法的兜底溯源（schema 要求 createdAt） */
function fallbackProvenance(at: number): Provenance {
  return { source: 'import', modelId: '', adapterIds: [], params: {}, sourceAssetIds: [], createdAt: at }
}

/**
 * 重绘前把「当前生效版本」补成 take（只补一次）。
 * 这样用户第一次重绘后，原始版本仍然可在「切换版本」里切回来。
 */
function ensureCurrentVersionTake(clip: AudioClip, at: number): Take | null {
  if (clip.takes.some((take) => take.assetId === clip.assetId)) return null
  const take = createTake({
    id: newId('take'),
    assetId: clip.assetId,
    label: '原版本',
    provenance: clip.provenance ?? fallbackProvenance(at),
    createdAt: at,
  })
  clip.takes.push(take)
  return take
}

export interface ApplyRepaintInput {
  trackId: string
  clipId: string
  /** 重绘产出的新资产（已登记或即将登记到 project.assets） */
  asset: AssetRef
  /** 新资产的峰值时长（秒）；旧的整段被替换，长度一般与原来一致 */
  durationSec: number
  caption: string
  /** 相对 clip 内的重绘区间（秒） */
  startSec: number
  endSec: number
  seed?: number
  style?: string
  adapterId?: string
  /** 版本标签，默认「重绘 a–b 秒」 */
  label?: string
}

/**
 * 重绘成功 → **一次 mutate 内**追加 Take 并切到新版本（整批可撤销）。
 *
 * 说明：重绘产物是**整段音频**（区间外由模型重建保持连续），所以这里做的是
 * 整段替换而不是把结果拼接进原文件；原版本作为 take 保留。
 */
export function applyRepaintTake(
  draft: Project,
  input: ApplyRepaintInput,
): { takeId: string; baselineTakeId: string | null } | null {
  const track = draft.tracks.find((item) => item.id === input.trackId)
  const clip = track?.audioClips.find((item) => item.id === input.clipId)
  if (!clip) return null
  const now = Date.now()
  const baseline = ensureCurrentVersionTake(clip, now)

  const label = input.label ?? `重绘 ${input.startSec.toFixed(2)}–${input.endSec.toFixed(2)}s`
  const params: Record<string, unknown> = { startSec: input.startSec, endSec: input.endSec }
  if (input.style) params.style = input.style
  if (input.adapterId) params.adapterId = input.adapterId
  const provenance: Provenance = {
    source: 'ace-step',
    modelId: 'ace-step',
    adapterIds: input.adapterId ? [input.adapterId] : [],
    seed: input.seed,
    prompt: input.caption,
    params,
    /* 重绘的输入资产（区间外由模型重建，整段返回） */
    sourceAssetIds: [clip.assetId],
    createdAt: now,
  }
  const take = createTake({
    id: newId('take'),
    assetId: input.asset.id,
    label,
    provenance,
    createdAt: now,
  })
  clip.takes.push(take)
  clip.activeTakeId = take.id
  clip.assetId = input.asset.id
  clip.durationSec = Math.max(0.01, round3(input.durationSec))
  clip.provenance = provenance

  const existing = draft.assets.find((item) => item.id === input.asset.id)
  if (!existing) draft.assets.push(input.asset)
  else if (!existing.durationMs && input.durationSec > 0) {
    existing.durationMs = Math.round(input.durationSec * 1000)
  }
  return { takeId: take.id, baselineTakeId: baseline?.id ?? null }
}

/**
 * 切换生效版本（一次 mutate）。
 * `durationSec` 建议由调用方先用新 assetId 取 peaks 再传入；缺省时回退到 asset.durationMs。
 */
export function switchActiveTake(
  draft: Project,
  trackId: string,
  clipId: string,
  takeId: string,
  durationSec?: number,
): boolean {
  const track = draft.tracks.find((item) => item.id === trackId)
  const clip = track?.audioClips.find((item) => item.id === clipId)
  const take = clip?.takes.find((item) => item.id === takeId)
  if (!clip || !take) return false
  const asset = draft.assets.find((item) => item.id === take.assetId)
  const fromAsset = (asset?.durationMs ?? 0) / 1000
  const nextDuration =
    durationSec && durationSec > 0 ? durationSec : fromAsset > 0 ? fromAsset : clip.durationSec
  clip.activeTakeId = take.id
  clip.assetId = take.assetId
  clip.durationSec = Math.max(0.01, round3(nextDuration))
  if (take.provenance) clip.provenance = take.provenance
  return true
}

/** 当前生效的 take（没有 activeTakeId 或列表为空时返回 undefined） */
export function activeTakeOf(clip: AudioClip): Take | undefined {
  if (!clip.activeTakeId) return undefined
  return clip.takes.find((take) => take.id === clip.activeTakeId)
}
