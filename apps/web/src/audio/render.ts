/**
 * 离线渲染（导出 WAV）。
 *
 * 两种引擎混合渲染，尽量贴近实时听到的效果：
 * 1. **SoundFont 轨**：把工程导出成标准 MIDI，交给 spessasynth 的
 *    `OfflineAudioContext + WorkletSynthesizer.startOfflineRender` 渲染成高保真采样音频；
 * 2. **合成器轨**（以及没有音色库时）：用 `Tone.Offline` 重建同一套音色图（synth.ts）
 *    与总线效果，逐音符按绝对时间触发，得到确定性结果。
 *
 * 2026-11 渲染质量修复（P0）：
 * - 采样轨 MIDI 的混音 CC 改为中性（CC7=127/CC10=64/CC91=0/CC93=0），音量/声像/发送只由本文件的节点链负责，
 *   修掉历史「CC7/CC10 双重应用 ≈ −10dB」与「delaySend 被写成 Chorus」；
 * - SoundFont 离线渲染保留绝对时间轴（`skipToFirstNoteOn:false`），修掉「首个音符不在 0 拍的轨道整体前移」；
 * - 离线也重建共享混响/延迟/合唱总线（与合成器轨同一套参数），不再依赖 SF3 内建效果；
 * - 支持 trackIds（单轨 bounce / 分轨导出）、音频片段混音、16/24-bit 输出与响度归一。
 *
 * 长曲子（>3 分钟）没问题：整段用一次 OfflineAudioContext 渲染，内存约
 * 3min * 44100 * 2ch * 4B ≈ 63MB。
 */
import * as Tone from 'tone'
import {
  beatsPerBar,
  getEmotion,
  getInstrument,
  projectDurationSeconds,
  projectToMidiBytes,
  type Project,
  type Track,
} from '@aiab/core'
import { createInstrumentVoice, noteDurationFor } from './synth'
import type { SoundfontEngine } from './soundfont'
import type { RenderOptions } from './types'
import { clamp } from './util'
import { computeAudibleTrackIds } from '../lib/trackRules'
import {
  applyMasterChainOffline,
  autoMakeupFor,
  buildDuckAutomation,
  preloadOfflineCalibration,
  renderTracksWithChainsOffline,
} from './offlineChain'
import { encodeWavBuffer } from './wav'
import { normalizeLoudness } from './loudness'

/* ------------------------------------------------------------------ */
/* WAV 编码（兼容旧接口）                                               */
/* ------------------------------------------------------------------ */

/**
 * Float32 PCM -> 16bit WAV Blob（与基线实现保持同一签名，UI/服务端都在用）。
 * 新代码请使用 `encodeWavBuffer`（支持 24-bit / dither）。
 */
export function encodeWav(left: Float32Array, right: Float32Array | undefined, sampleRate: number): Blob {
  const bytes = encodeWavBuffer(left, right, { sampleRate, bitDepth: 16, dither: false })
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return new Blob([buffer], { type: 'audio/wav' })
}

/* ------------------------------------------------------------------ */
/* 轨道路由                                                            */
/* ------------------------------------------------------------------ */

/**
 * 当前工程里应该发声的轨道（考虑 mute / solo）。
 *
 * 判定与实时引擎共用 `computeAudibleTrackIds`，避免「导出听到的和播放听到的不一致」。
 * 传入 `trackIds` 时表示用户明确指定要渲染的轨道（单轨 bounce / 分轨）：忽略 mute/solo。
 */
export function audibleTracks(project: Project, trackIds?: string[]): Track[] {
  if (trackIds && trackIds.length > 0) {
    const wanted = new Set(trackIds)
    return project.tracks.filter((track) => wanted.has(track.id))
  }
  const audible = computeAudibleTrackIds(project.tracks)
  return project.tracks.filter((track) => audible.has(track.id))
}

/**
 * 这条轨道走采样引擎还是合成器引擎。
 * `track.engine === 'synth'` 强制合成器；'soundfont' 与 'auto' 在有音色库时都用采样。
 */
export function trackUsesSoundfont(track: Track, soundfontUsable: boolean): boolean {
  if (!soundfontUsable) return false
  return track.engine !== 'synth'
}

export interface RenderRouting {
  synth: Track[]
  soundfont: Track[]
}

export function routeTracks(project: Project, soundfontUsable: boolean, trackIds?: string[]): RenderRouting {
  const routing: RenderRouting = { synth: [], soundfont: [] }
  for (const track of audibleTracks(project, trackIds)) {
    if (track.clips.length === 0) continue
    if (trackUsesSoundfont(track, soundfontUsable)) routing.soundfont.push(track)
    else routing.synth.push(track)
  }
  return routing
}

/* ------------------------------------------------------------------ */
/* 合成器离线渲染                                                       */
/* ------------------------------------------------------------------ */

/** 与实时引擎一致的情绪 -> 发送量映射（实时版在 engine.ts） */
function reverbAmount(track: Track): number {
  const emotion = getEmotion(track.instrumentId, track.emotionId).params
  return clamp(track.reverbSend * 0.6 + emotion.reverb * 0.7, 0, 1)
}
function delayAmount(track: Track): number {
  const emotion = getEmotion(track.instrumentId, track.emotionId).params
  return clamp(track.delaySend * 0.6 + emotion.delay * 0.7, 0, 1)
}
function chorusAmount(track: Track): number {
  const emotion = getEmotion(track.instrumentId, track.emotionId).params
  const instrument = getInstrument(track.instrumentId)
  return clamp(emotion.chorus * 0.9 + instrument.synth.fx.chorus * 0.5, 0, 1)
}

async function renderSynthGroup(
  project: Project,
  tracks: Track[],
  duration: number,
  sampleRate: number,
  metronome: boolean,
  onProgress?: (ratio: number) => void,
): Promise<AudioBuffer> {
  const secPerBeat = 60 / Math.max(20, project.tempo)
  // 先统计音符总数，用于进度反馈
  let totalNotes = 0
  for (const track of tracks) for (const clip of track.clips) if (!clip.muted) totalNotes += clip.notes.length
  let scheduled = 0

  // 用**原生** OfflineAudioContext 渲染（比 Tone.Offline 的 standardized 包装快约 3 倍：
  // 120 秒工程 4.2s vs 12s）。Tone 节点需要先切换到临时的离线上下文，
  // 因此调用方（engine.renderToWav）会在渲染期间暂停实时播放，避免两边抢全局上下文。
  const length = Math.max(1, Math.ceil(duration * sampleRate))
  const OfflineCtor = window.OfflineAudioContext
  const offline = new OfflineCtor(2, length, sampleRate)
  const previousContext = Tone.getContext()
  Tone.setContext(new Tone.Context(offline))
  const disposables: { dispose(): void }[] = []
  try {
    /* 母线/母带链在最后对混好的 PCM 统一应用（见 renderProjectToWav），这里只做轨道混音与发送 */
    const mix = new Tone.Gain(1).toDestination()
    disposables.push(mix)

    // ---- 共享效果总线（wet=1，逐轨用 send 增益控制发送量）----
    const reverb = new Tone.Reverb({ decay: 2.6, preDelay: 0.02, wet: 1 }).connect(mix)
    // Reverb 的 IR 是异步生成的；离线渲染里最多等 2 秒，超时就当无混响，保证总能出结果
    await Promise.race([reverb.ready, new Promise((resolve) => setTimeout(resolve, 2000))])
    const delay = new Tone.FeedbackDelay({
      delayTime: Math.max(0.05, secPerBeat * 0.75),
      feedback: 0.3,
      wet: 1,
    }).connect(mix)
    const chorus = new Tone.Chorus({ frequency: 1.1, delayTime: 3.5, depth: 0.55, wet: 1 }).start()
    chorus.connect(mix)
    disposables.push(reverb, delay, chorus)

    for (const track of tracks) {
      const instrument = getInstrument(track.instrumentId)
      const emotion = getEmotion(track.instrumentId, track.emotionId).params
      const voice = createInstrumentVoice(instrument, emotion)
      disposables.push(voice)

      const channel = new Tone.Channel({
        volume: Tone.gainToDb(Math.max(0.0005, track.volume)),
        pan: clamp(track.pan, -1, 1),
      })
      const widener = new Tone.StereoWidener(clamp(emotion.stereoWidth, 0, 1))
      const sendReverb = new Tone.Gain(reverbAmount(track))
      const sendDelay = new Tone.Gain(delayAmount(track))
      const sendChorus = new Tone.Gain(chorusAmount(track))
      disposables.push(channel, widener, sendReverb, sendDelay, sendChorus)

      /* P6-A：每轨 mixChain（EQ → 压缩 → makeup 自动补偿 → duckGain）重建；sends 仍按实时取自 voice 输出 */
      const chain = track.mixChain
      const chainEnabled = Boolean(chain && chain.enabled !== false)
      let chainOut: Tone.ToneAudioNode = voice.output
      if (chain && chainEnabled) {
        const eqLow = new Tone.Filter({ type: 'lowshelf', frequency: chain.eq.lowShelf.hz, gain: chain.eq.lowShelf.gainDb })
        const eqMid = new Tone.Filter({ type: 'peaking', frequency: chain.eq.mid.hz, gain: chain.eq.mid.gainDb, Q: chain.eq.mid.q ?? 0.9 })
        const eqHigh = new Tone.Filter({ type: 'highshelf', frequency: chain.eq.highShelf.hz, gain: chain.eq.highShelf.gainDb })
        const comp = new Tone.Compressor({
          threshold: chain.compressor.thresholdDb,
          ratio: chain.compressor.ratio,
          attack: chain.compressor.attackSec,
          release: chain.compressor.releaseSec,
          knee: chain.compressor.kneeDb,
        })
        const makeup = new Tone.Gain(
          Math.pow(10, (chain.makeupDb - autoMakeupFor(chain.compressor.thresholdDb, chain.compressor.ratio, chain.compressor.kneeDb)) / 20),
        )
        const duckGain = new Tone.Gain(1)
        const automation = buildDuckAutomation(project, track, duration, secPerBeat)
        if (automation) {
          try {
            duckGain.gain.setValueAtTime(automation.gains[0] ?? 1, 0)
            for (let i = 1; i < automation.times.length; i += 1) {
              duckGain.gain.linearRampToValueAtTime(automation.gains[i], automation.times[i])
            }
          } catch {
            /* ignore */
          }
        }
        voice.output.connect(eqLow)
        eqLow.connect(eqMid)
        eqMid.connect(eqHigh)
        eqHigh.connect(comp)
        comp.connect(makeup)
        makeup.connect(duckGain)
        chainOut = duckGain
        disposables.push(eqLow, eqMid, eqHigh, comp, makeup, duckGain)
      }
      chainOut.connect(channel)
      channel.connect(widener)
      widener.connect(mix)
      voice.output.connect(sendReverb)
      sendReverb.connect(reverb)
      voice.output.connect(sendDelay)
      sendDelay.connect(delay)
      voice.output.connect(sendChorus)
      sendChorus.connect(chorus)

      const isDrum = track.kind === 'drum' || instrument.isDrumKit
      for (const clip of track.clips) {
        if (clip.muted) continue
        for (const note of clip.notes) {
          const startSec = (clip.startBeat + note.start) * secPerBeat
          if (startSec > duration) continue
          const pitch = clamp(Math.round(note.pitch + track.octaveShift * 12), 0, 127)
          const beatDur = Math.max(0.02, note.duration * secPerBeat)
          const durSec = isDrum ? beatDur : noteDurationFor(emotion.articulation, beatDur)
          voice.noteOn(startSec, pitch, clamp(note.velocity, 1, 127) / 127, durSec)
          scheduled++
          if (scheduled % 16 === 0 && totalNotes > 0) onProgress?.(0.1 + 0.8 * (scheduled / totalNotes))
        }
      }
    }

    // ---- 节拍器 ----
    if (metronome) {
      const click = new Tone.MembraneSynth({ octaves: 1.5 }).connect(mix)
      const barBeats = beatsPerBar(project.timeSignature)
      const endBeat = duration / secPerBeat
      for (let beat = 0; beat < endBeat; beat++) {
        const accent = beat % barBeats === 0
        click.triggerAttackRelease(accent ? 'C5' : 'C4', 0.03, beat * secPerBeat, accent ? 0.85 : 0.45)
      }
      disposables.push(click)
    }

    onProgress?.(0.92)
    const buffer = await offline.startRendering()
    onProgress?.(1)
    return buffer
  } finally {
    Tone.setContext(previousContext)
    for (const node of disposables.reverse()) {
      try {
        node.dispose()
      } catch {
        /* ignore */
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 音频片段解码                                                         */
/* ------------------------------------------------------------------ */

/** 把工程里用到的音频资产解码成 AudioBuffer（同一资产只解码一次） */
async function loadAudioClipBuffers(
  project: Project,
  tracks: Track[],
  sampleRate: number,
): Promise<Map<string, AudioBuffer>> {
  const ids = new Set<string>()
  for (const track of tracks) {
    for (const clip of track.audioClips ?? []) {
      if (!clip.muted) ids.add(clip.assetId)
    }
  }
  const result = new Map<string, AudioBuffer>()
  if (ids.size === 0) return result
  const OfflineCtor = window.OfflineAudioContext
  const decoder = new OfflineCtor(2, 1, sampleRate)
  await Promise.all(
    [...ids].map(async (assetId) => {
      try {
        const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}/file`)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.arrayBuffer()
        result.set(assetId, await decoder.decodeAudioData(data))
      } catch (error) {
        console.warn('[render] 音频资产加载/解码失败（该片段将被跳过）', assetId, error)
      }
    }),
  )
  return result
}

/* ------------------------------------------------------------------ */
/* 混音                                                                */
/* ------------------------------------------------------------------ */

interface StereoPcm {
  left: Float32Array
  right: Float32Array
  sampleRate: number
}

function emptyPcm(length: number, sampleRate: number): StereoPcm {
  return { left: new Float32Array(length), right: new Float32Array(length), sampleRate }
}

function addBuffer(target: StereoPcm, buffer: AudioBuffer): void {
  const length = Math.min(target.left.length, buffer.length)
  const left = buffer.getChannelData(0)
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left
  for (let i = 0; i < length; i++) {
    target.left[i] += left[i]
    target.right[i] += right[i]
  }
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 渲染整个工程为 WAV。
 * @param project 工程快照
 * @param options 采样率 / 位深 / 尾音 / 轨道子集 / 音频片段 / 响度 / 进度回调
 * @param soundfont 采样引擎（可选；不可用或未加载时自动全走合成器）
 */
export async function renderProjectToWav(
  project: Project,
  options: RenderOptions,
  soundfont?: SoundfontEngine,
): Promise<Blob> {
  const sampleRate = clamp(Math.round(options.sampleRate ?? 44100), 8000, 192000)
  const bitDepth = options.bitDepth === 24 ? 24 : 16
  const tail = clamp(options.tailSeconds ?? 2, 0, 10)
  /**
   * 时长规则：默认「工程末拍 + 2s（projectDurationSeconds 已含）+ tail」；
   * 传入 trackIds 时仍用**整个工程**的时长，保证单轨 bounce 保留前导静音、可原地对齐。
   */
  const duration = Math.max(
    0.5,
    Number.isFinite(options.durationSec) && (options.durationSec as number) > 0
      ? (options.durationSec as number)
      : projectDurationSeconds(project) + tail,
  )
  const routing = routeTracks(project, Boolean(soundfont?.usable), options.trackIds)
  const report = (ratio: number) => {
    try {
      options.onProgress?.(clamp(ratio, 0, 1))
    } catch {
      /* 进度回调异常不影响渲染 */
    }
  }

  report(0.01)
  /* P6-A：先标定所有压缩器的浏览器自动补偿（导出链与实时一致） */
  await preloadOfflineCalibration(project)

  const selectedTracks = audibleTracks(project, options.trackIds)
  const audioTracks =
    options.includeAudioClips === false
      ? []
      : selectedTracks.filter((track) => (track.audioClips?.length ?? 0) > 0)

  const pcm = emptyPcm(Math.ceil(duration * sampleRate), sampleRate)
  const soundfontTracks = [...routing.soundfont]
  const synthTracks = [...routing.synth]

  // 1) 采样轨：逐轨渲染原始 buffer（每轨单独 MIDI），再统一重建每轨处理链（EQ/压缩/duck）+ 音量声像 + 发送
  const rawBuffers = new Map<string, AudioBuffer>()
  const fallbackTracks: Track[] = []
  if (soundfontTracks.length > 0 && soundfont?.usable) {
    for (let index = 0; index < soundfontTracks.length; index += 1) {
      const track = soundfontTracks[index]
      report(0.02 + (0.48 * index) / Math.max(1, soundfontTracks.length))
      try {
        /* 子工程只保留该轨；mute/solo 必须清掉，否则 projectToMidiBytes 会把它过滤掉 */
        const subTrack: Track = { ...track, mute: false, solo: false }
        const subProject: Project = { ...project, tracks: [subTrack] }
        /* neutral：音量/声像/发送不写进 MIDI CC，统一由下面的节点链负责（修双重应用） */
        const midiBytes = projectToMidiBytes(subProject, { mixControls: 'neutral' })
        const midiBuffer = midiBytes.buffer.slice(
          midiBytes.byteOffset,
          midiBytes.byteOffset + midiBytes.byteLength,
        ) as ArrayBuffer
        /* tailSeconds=0：buffer 长度精确等于 duration，避免末尾 2s 被浪费 */
        rawBuffers.set(track.id, await soundfont.renderOffline(midiBuffer, duration, sampleRate, undefined, 0))
      } catch (error) {
        console.warn('[render] SoundFont 单轨渲染失败，回退合成器', track.name, error)
        fallbackTracks.push(track)
      }
    }
  }
  const audioBuffers = await loadAudioClipBuffers(project, audioTracks, sampleRate)
  const sendAmounts = new Map<string, { reverb: number; delay: number; chorus: number }>()
  for (const track of selectedTracks) {
    /* 实时引擎里音频片段只接 dry（不进发送总线），所以纯音频轨的发送量记 0，避免导出多出混响 */
    const hasMidi = track.clips.some((clip) => clip.notes.length > 0)
    sendAmounts.set(track.id, hasMidi
      ? { reverb: reverbAmount(track), delay: delayAmount(track), chorus: chorusAmount(track) }
      : { reverb: 0, delay: 0, chorus: 0 })
  }

  // 2) 采样轨 + 音频片段：同一套 native 离线图（每轨链、推子、声像、共享效果总线）
  if (rawBuffers.size > 0 || audioBuffers.size > 0) {
    try {
      const chained = await renderTracksWithChainsOffline(project, rawBuffers, duration, sampleRate, {
        tracks: selectedTracks,
        audioBuffers,
        sends: sendAmounts,
      })
      if (chained) addBuffer(pcm, chained)
      report(0.56)
    } catch (error) {
      // 处理链重建失败不影响导出：按原始采样电平回退，避免整段静音
      console.warn('[render] 采样轨处理链离线重建失败，按未处理电平导出', error)
      for (const buffer of rawBuffers.values()) addBuffer(pcm, buffer)
    }
  }

  // 3) 合成器轨（含回退后的采样轨；内部已重建每轨链与 duck）
  synthTracks.push(...fallbackTracks)
  if (synthTracks.length > 0) {
    const synthBuffer = await renderSynthGroup(
      project,
      synthTracks,
      duration,
      sampleRate,
      Boolean(options.metronome),
      (ratio) => report(0.58 + ratio * 0.22),
    )
    addBuffer(pcm, synthBuffer)
  }

  // 4) 母线 / 母带链：bus EQ + 三段压缩(multiband) + 整体压缩 + makeup + masterVolume + limiter
  report(0.86)
  const OfflineCtor = window.OfflineAudioContext
  let mixBuffer: AudioBuffer
  try {
    mixBuffer = new AudioBuffer({ length: pcm.left.length, numberOfChannels: 2, sampleRate })
  } catch {
    mixBuffer = new OfflineCtor(2, Math.max(1, pcm.left.length), sampleRate).createBuffer(
      2,
      Math.max(1, pcm.left.length),
      sampleRate,
    )
  }
  mixBuffer.copyToChannel(pcm.left as Float32Array<ArrayBuffer>, 0)
  mixBuffer.copyToChannel(pcm.right as Float32Array<ArrayBuffer>, 1)
  let finalBuffer: AudioBuffer = mixBuffer
  try {
    finalBuffer = await applyMasterChainOffline(project, mixBuffer, sampleRate)
  } catch (error) {
    // 母线链重建失败：按未处理电平导出（仍保证有 WAV）
    console.warn('[render] 母线/母带链离线重建失败，按未处理电平导出', error)
  }
  report(0.95)

  const left = new Float32Array(finalBuffer.getChannelData(0))
  const right =
    finalBuffer.numberOfChannels > 1
      ? new Float32Array(finalBuffer.getChannelData(1))
      : new Float32Array(left)

  /* 响度归一（可选）：默认调用方决定；UI/单轨 bounce 会传 -14 LUFS */
  if (typeof options.loudnessTargetLufs === 'number' && Number.isFinite(options.loudnessTargetLufs)) {
    try {
      normalizeLoudness(left, right, sampleRate, { targetLufs: options.loudnessTargetLufs, ceilingDb: -1 })
    } catch (error) {
      console.warn('[render] 响度归一失败，按原始电平导出', error)
    }
  }

  /* 最终峰值保护：母带 limiter 是 DynamicsCompressor（非砖墙），合成器轨仍可能冒出 0dBFS；
     整体缩放（不是硬削波）到 -1dBFS 以内，保证任何配置下都不削顶。 */
  let peak = 0
  for (let i = 0; i < left.length; i++) {
    const a = Math.abs(left[i])
    const b = Math.abs(right[i])
    if (a > peak) peak = a
    if (b > peak) peak = b
  }
  const ceiling = Math.pow(10, -1 / 20)
  if (peak > ceiling) {
    const gain = ceiling / peak
    for (let i = 0; i < left.length; i++) {
      left[i] *= gain
      right[i] *= gain
    }
  }

  report(1)
  const bytes = encodeWavBuffer(left, right, {
    sampleRate,
    bitDepth,
    dither: options.dither ?? true,
  })
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return new Blob([buffer], { type: 'audio/wav' })
}
