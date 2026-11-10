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
    volume: 0.8,
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
