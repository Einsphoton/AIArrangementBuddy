/**
 * 离线渲染（导出 WAV）。
 *
 * 两种引擎混合渲染，尽量贴近实时听到的效果：
 * 1. **SoundFont 轨**：把工程导出成标准 MIDI，交给 spessasynth 的
 *    `OfflineAudioContext + WorkletSynthesizer.startOfflineRender` 渲染成高保真采样音频；
 * 2. **合成器轨**（以及没有音色库时）：用 `Tone.Offline` 重建同一套音色图（synth.ts）
 *    与总线效果，逐音符按绝对时间触发，得到确定性结果。
 *
 * 两组音频按采样点相加后统一应用主音量与软限幅，因此：
 * - 没有音色库 => 纯合成器渲染，一切正常；
 * - 有音色库 => 采样轨明显更真实，合成器轨（如 Synth Pad）仍是合成器音色。
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
import { clamp, softClip } from './util'

/* ------------------------------------------------------------------ */
/* WAV 编码                                                            */
/* ------------------------------------------------------------------ */

/** Float32 PCM -> 16bit WAV Blob（与基线实现保持同一签名，UI/服务端都在用） */
export function encodeWav(left: Float32Array, right: Float32Array | undefined, sampleRate: number): Blob {
  const channels = right ? 2 : 1
  const length = left.length
  const bytesPerSample = 2
  const blockAlign = channels * bytesPerSample
  const dataSize = length * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  const clampSample = (sample: number) => Math.max(-1, Math.min(1, sample))
  for (let i = 0; i < length; i++) {
    view.setInt16(offset, clampSample(left[i]) * 0x7fff, true)
    offset += 2
    if (right) {
      view.setInt16(offset, clampSample(right[i]) * 0x7fff, true)
      offset += 2
    }
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

/* ------------------------------------------------------------------ */
/* 轨道路由                                                            */
/* ------------------------------------------------------------------ */

/** 当前工程里应该发声的轨道（考虑 mute / solo） */
export function audibleTracks(project: Project): Track[] {
  const anySolo = project.tracks.some((track) => track.solo)
  return project.tracks.filter((track) => !track.mute && (!anySolo || track.solo))
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

export function routeTracks(project: Project, soundfontUsable: boolean): RenderRouting {
  const routing: RenderRouting = { synth: [], soundfont: [] }
  for (const track of audibleTracks(project)) {
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
    const master = new Tone.Gain(clamp(project.masterVolume, 0, 1.5)).toDestination()
    const limiter = new Tone.Limiter(-1).connect(master)
    const mix = new Tone.Gain(1).connect(limiter)
    disposables.push(master, limiter, mix)

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
      voice.output.connect(channel)
      channel.connect(widener)
      widener.connect(mix)
      voice.output.connect(sendReverb)
      sendReverb.connect(reverb)
      voice.output.connect(sendDelay)
      sendDelay.connect(delay)
      voice.output.connect(sendChorus)
      sendChorus.connect(chorus)
      disposables.push(channel, widener, sendReverb, sendDelay, sendChorus)

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
 * @param options 采样率 / 尾部时长 / 节拍器 / 进度回调
 * @param soundfont 采样引擎（可选；不可用或未加载时自动全走合成器）
 */
export async function renderProjectToWav(
  project: Project,
  options: RenderOptions,
  soundfont?: SoundfontEngine,
): Promise<Blob> {
  const sampleRate = clamp(Math.round(options.sampleRate ?? 44100), 8000, 192000)
  const tail = clamp(options.tailSeconds ?? 2, 0, 10)
  const duration = Math.max(1, projectDurationSeconds(project) + tail)
  const routing = routeTracks(project, Boolean(soundfont?.usable))
  const report = (ratio: number) => {
    try {
      options.onProgress?.(clamp(ratio, 0, 1))
    } catch {
      /* 进度回调异常不影响渲染 */
    }
  }

  report(0.01)
  const pcm = emptyPcm(Math.ceil(duration * sampleRate), sampleRate)

  // 1) 采样轨
  if (routing.soundfont.length > 0 && soundfont?.usable) {
    try {
      const subProject: Project = { ...project, tracks: routing.soundfont }
      const midiBytes = projectToMidiBytes(subProject)
      const midiBuffer = midiBytes.buffer.slice(
        midiBytes.byteOffset,
        midiBytes.byteOffset + midiBytes.byteLength,
      ) as ArrayBuffer
      const sfBuffer = await soundfont.renderOffline(midiBuffer, duration, sampleRate, (ratio) => {
        report(0.02 + ratio * 0.55)
      })
      addBuffer(pcm, sfBuffer)
    } catch (error) {
      // 采样渲染失败不影响导出：退回归合成器渲染同一批轨道
      console.warn('[render] SoundFont 离线渲染失败，回退合成器', error)
      routing.synth.push(...routing.soundfont)
      routing.soundfont = []
    }
  }

  // 2) 合成器轨（含回退后的采样轨）
  if (routing.synth.length > 0) {
    const synthBuffer = await renderSynthGroup(
      project,
      routing.synth,
      duration,
      sampleRate,
      Boolean(options.metronome),
      (ratio) => report(0.58 + ratio * 0.34),
    )
    addBuffer(pcm, synthBuffer)
  }

  // 3) 主音量 + 软限幅
  const masterVolume = clamp(project.masterVolume, 0, 1.5)
  for (let i = 0; i < pcm.left.length; i++) {
    pcm.left[i] = softClip(pcm.left[i] * masterVolume)
    pcm.right[i] = softClip(pcm.right[i] * masterVolume)
  }
  report(1)
  return encodeWav(pcm.left, pcm.right, sampleRate)
}
