/**
 * 单轨 bounce（bounce in place）：把一条 MIDI 轨道离线渲染成音频，并落到一条新的音频轨。
 *
 * 与 `audioIntent.runMidiRender`（整工程 MACI → 音频）的区别：
 * - **只渲染一条轨**（`RenderOptions.trackIds`），且**不传 durationSec**，让渲染侧按整工程
 *   时间轴决定长度 —— 这样原轨从第 8 拍开始的内容，bounce 出来的片段起始位置（拍 0 =
 *   工程 0 拍）与时间轴完全对齐，不会因为裁掉前导静音而整体前移；
 * - 原轨在同一个 `store.mutate` 里被静音，所以「渲染 + 落轨 + 静音原轨」只有一个撤销点。
 *
 * 落轨复用导入 / 生成共用的 `placeAudioClip`（一次 mutate 内建轨 + 建片段 + 登记资产），
 * 这里不重复实现音频轨构造逻辑。
 *
 * 防重入：同一轨道渲染期间再次触发直接忽略（模块级 Set；UI 用 `isBouncingTrack` 读状态）。
 */
import type { Track } from '@aiab/core'
import { getAudioEngine } from '../../audio'
import { getAssetPeaks, uploadAudioAsset } from '../../lib/api'
import { useStore } from '../../store/store'
import { assetRefFromPeaks, placeAudioClip } from './audioTrack'
import { primeAssetPeaks } from './peaks'

/** 与 P0 渲染质量目标一致：48kHz / 24bit / -14 LUFS */
const BOUNCE_SAMPLE_RATE = 48000
const BOUNCE_BIT_DEPTH = 24
/**
 * bounce 是「把这条轨的贡献冻成音频」，**不能**做 -14 LUFS 归一：
 * 归一会把单轨整体抬到成品响度，放回工程里会比原来响 ~10dB。
 * 保持 null，让渲染侧沿用工程母带链的自然电平。
 */
const BOUNCE_LOUDNESS_TARGET_LUFS = null

/** 正在渲染的轨道 id（防重入；同时供 UI 显示「渲染中…」）。 */
const bouncingTracks = new Set<string>()

/** 该轨道当前是否正在 bounce（UI 可读；渲染期间再次点击会被忽略）。 */
export function isBouncingTrack(trackId: string): boolean {
  return bouncingTracks.has(trackId)
}

/** 文件名里不能出现的字符统一换掉（Windows / macOS 通用），并限制长度 */
function safeFileName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 40)
  return cleaned || 'track'
}

/** 轨道上是否有可渲染的 MIDI 音符（纯音频轨 / 空轨不计） */
function hasMidiNotes(track: Track): boolean {
  return track.clips.some((clip) => clip.notes.length > 0)
}

/**
 * 把单条 MIDI 轨渲染成音频并落轨（bounce in place）。
 *
 * 成功返回新轨 / 新片段 id；失败或前置条件不满足返回 `null`（并已 toast 说明原因）。
 */
export async function bounceTrackToAudio(trackId: string): Promise<{ trackId: string; clipId: string } | null> {
  const store = useStore.getState()
  const track = store.project.tracks.find((item) => item.id === trackId)
  if (!track) {
    store.pushToast('error', '渲染失败：轨道不存在，可能已被删除')
    return null
  }
  if (!hasMidiNotes(track)) {
    store.pushToast('info', `「${track.name}」没有 MIDI 音符：纯音频轨 / 空轨不需要渲染`)
    return null
  }
  if (bouncingTracks.has(trackId)) {
    store.pushToast('info', `「${track.name}」正在渲染中，请稍候`)
    return null
  }

  bouncingTracks.add(trackId)
  store.pushToast('info', `正在渲染轨道「${track.name}」…`)
  /* 渲染 / 上传期间轨道可能被改名或改色：这里按触发时的快照落轨，保证撤销点语义稳定 */
  const trackName = track.name
  const trackColor = track.color
  const fileName = `${safeFileName(trackName)}-bounce.wav`

  try {
    const engine = getAudioEngine()
    /*
     * 不传 durationSec：渲染侧按工程时间轴决定总长（保留原轨内容的前导静音，
     * 片段 startBeat=0 时与工程绝对位置对齐）。trackIds 会让渲染只包含这一条轨。
     */
    const blob = await engine.renderToWav(store.project, {
      trackIds: [trackId],
      sampleRate: BOUNCE_SAMPLE_RATE,
      bitDepth: BOUNCE_BIT_DEPTH,
      loudnessTargetLufs: BOUNCE_LOUDNESS_TARGET_LUFS,
      includeAudioClips: false,
    })

    const file = new File([blob], fileName, { type: 'audio/wav' })
    const uploaded = await uploadAudioAsset(file)
    /*
     * 上传接口其实已经回传 peaks；这里再按产物约定走一次 GET + prime，
     * 保证波形缓存与「刚上传的资产」严格同源；GET 失败时退回上传响应，避免白渲染一场。
     */
    const peaks = await getAssetPeaks(uploaded.asset.id).catch(() => ({
      id: uploaded.asset.id,
      durationSec: uploaded.durationSec,
      sampleRate: uploaded.sampleRate,
      channels: uploaded.channels,
      peaks: uploaded.peaks,
    }))
    primeAssetPeaks(uploaded.asset.id, peaks)
    const asset = assetRefFromPeaks(uploaded.asset.id, peaks, {
      name: fileName,
      sha256: uploaded.asset.sha256,
      bytes: uploaded.asset.bytes,
    })

    /* 渲染期间轨道可能被删掉：此时不落轨，避免留下一条「无源」的渲染片段 */
    if (!useStore.getState().project.tracks.some((item) => item.id === trackId)) {
      useStore.getState().pushToast('error', '渲染完成，但原轨道已被删除，未落轨')
      return null
    }

    const placedRef: { value: { trackId: string; clipId: string } | null } = { value: null }
    useStore.getState().mutate((draft) => {
      const sourceTrack = draft.tracks.find((item) => item.id === trackId)
      if (!sourceTrack) return
      placedRef.value = placeAudioClip(draft, {
        asset,
        durationSec: peaks.durationSec,
        name: `${trackName} · 渲染`,
        startBeat: 0,
        trackName: `音频 · ${trackName}`,
        color: trackColor,
        /*
         * 推子 = 1：渲染侧已经把原轨的音量/声像/发送烘进 PCM，落轨再乘默认的 0.8
         * 会让 bounce 比原轨低约 1.9dB（bounce in place 应当与原轨等响）。
         */
        volume: 1,
        provenance: {
          source: 'render',
          modelId: 'soundfont-render',
          adapterIds: [],
          sourceAssetIds: [],
          params: {
            sourceTrackId: trackId,
            sampleRate: BOUNCE_SAMPLE_RATE,
            bitDepth: BOUNCE_BIT_DEPTH,
          },
          createdAt: Date.now(),
        },
      })
      // 同一撤销点内静音原轨：bounce 后听到的就只有新音频轨，不会与原 MIDI 轨叠在一起
      sourceTrack.mute = true
    })

    const placed = placedRef.value
    if (!placed) {
      useStore.getState().pushToast('error', '渲染失败：无法创建音频轨道')
      return null
    }
    const state = useStore.getState()
    state.selectTrack(placed.trackId)
    state.setView('arrangement')
    state.pushToast('success', `已渲染「${trackName}」为音频（⌘Z 可撤销）`)
    return placed
  } catch (error) {
    console.warn('[audio] 单轨 bounce 失败', trackId, error)
    useStore
      .getState()
      .pushToast('error', `渲染轨道「${trackName}」失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  } finally {
    bouncingTracks.delete(trackId)
  }
}
