/**
 * 音频引擎总装。
 *
 * 结构
 * ----
 * ```
 *  synth 轨 voice ──► dry ─────────────┐
 *                 ├─► reverbSend ─► ReverbBus ─┐
 *                 ├─► delaySend  ─► DelayBus  ─┼─► mixBus ─► masterGain ─► Limiter ─► destination
 *                 └─► chorusSend ─► ChorusBus ─┘                         └► Meter
 *  soundfont 轨 ──(MIDI CC 混音)──► sfBus ─────┘
 * ```
 *
 * 走带调度
 * --------
 * 没有用 Tone.Transport 的事件表，而是自建 **look-ahead 调度器**：
 * 每 25ms 把「未来 160ms 内」的音符按绝对 AudioContext 时间丢给合成器 / 采样器。
 * 好处：
 * - 循环区间只需要把「时间轴位置」映射回「拍」，不需要重排事件；
 * - 播放中热更新（增删轨、换音色、改情绪、改速度）不会打断走带；
 * - 1000+ 音符时每 tick 只处理新进入窗口的少量音符，不会卡主线程。
 *
 * 限制：后台标签页 setInterval 被浏览器节流到 1s 时，可能出现短暂掉音
 * （音频线程仍在跑，只是调度跟不上），重新聚焦会自动追回。
 */
import * as Tone from 'tone'
import {
  beatsPerBar,
  getEmotion,
  getInstrument,
  projectEndBeat,
  type AudioClip,
  type Project,
  type Track,
} from '@aiab/core'
import type { AudioEngine, MidiInput, PlayOptions, RenderOptions, SoundfontManager } from './types'
import { getMultiband, resolveDuckSource, type DuckConfig } from './advancedChain'
import { createInstrumentVoice, noteDurationFor, type InstrumentVoice } from './synth'
import { SoundfontEngine } from './soundfont'
import { WebMidiInput } from './midi'
import { renderProjectToWav } from './render'
import { clamp } from './util'
import { computeAudibleTrackIds } from '../lib/trackRules'
import {
  beatAtPosition as timelineBeatAtPosition,
  beatSegments as timelineBeatSegments,
  contextTimeAtPosition as timelineContextTimeAtPosition,
  normalizeStartBeat,
  positionAt as timelinePositionAt,
  type TimelineMapping,
} from './timeline'

export { encodeWav } from './render'

/* ------------------------------------------------------------------ */
/* 内部类型                                                            */
/* ------------------------------------------------------------------ */

type TrackRoute = 'synth' | 'soundfont'

interface TrackNode {
  channel: Tone.Channel
  widener: Tone.StereoWidener
  dry: Tone.Gain
  /**
   * 音频域处理链（P3 / P3.1 修复）：
   * dry → lowShelf → mid(peaking) → highShelf → compressor → makeup → channel。
   *
   * 注意：Chrome/Edge 的 DynamicsCompressorNode 自带**固定自动补偿增益**（实测
   * threshold=-50/ratio=20 约 +29dB，与输入电平无关），会把压缩前的 EQ 衰减整体抵消；
   * 因此 `makeup` 节点会在压缩后抵消掉这个自动补偿（现场用 OfflineAudioContext 标定，
   * 见 calibrateCompressorMakeup），使 core 的 MixChain（标准无补偿压缩 + makeupDb）按设计生效。
   *
   * 参数来自 `track.mixChain`；没有链 / enabled=false 时全部归零，等价 bypass。
   * 音频片段 Player 与 SoundFont 逐通道抽头（sfIn）都接在 `dry` 上，因此同样经过这条链。
   */
  eqLow: Tone.Filter
  eqMid: Tone.Filter
  eqHigh: Tone.Filter
  compressor: Tone.Compressor
  makeup: Tone.Gain
  /**
   * P3.1：处理链之后的 send 抽头（0/1 门控）。
   * per-channel SoundFont 模式下为 1，把**处理后**信号送到混响/延迟/合唱总线；
   * 其它路由为 0 —— 合成器 voice 自己已直连 send（前置），避免重复发送。
   */
  postSend: Tone.Gain
  /**
   * P6-A：侧链 ducking 增益（默认 1）。
   * 位置在处理链之后、推子/发送之前；由 duck 触发源（默认鼓组）的包络驱动衰减。
   */
  duckGain: Tone.Gain
  /**
   * 静音 / 独奏门（默认 1，0.02s 过渡）。
   *
   * 为什么单独一个节点，而不是直接用 `channel.mute`：
   * - `Tone.Channel.mute` 是把推子直接设成 -Infinity 的**硬切**，静音瞬间会有咔哒声；
   * - 它和 `volume.rampTo()` 抢同一个参数：先 mute 再 ramp 会被 ramp 撤销（M / S 表现为按了没用）；
   * - 放在 makeup 之后、duckGain 之前，send 抽头（postSend）天然在它下游，
   *   因此「静音」也能掐掉混响 / 延迟尾巴，而不只是掐干声。
   */
  muteGain: Tone.Gain
  sendReverb: Tone.Gain
  sendDelay: Tone.Gain
  sendChorus: Tone.Gain
  /**
   * 每轨电平表（只读旁路 tap）。
   * 接在 widener 之后，不串入主信号链：meter 没有输出，不影响音色 / 音量 / 声像。
   * 合成器路由用它读数；采样音源路由的音频不经过这里（见 sfAnalyser）。
   */
  meter: Tone.Meter
  /**
   * 采样音源路由的逐轨电平：spessasynth 每个 MIDI 通道都有独立的可视化输出，
   * 用它做真实逐轨读数（见 attachSoundfontTap）。
   */
  sfAnalyser: AnalyserNode | null
  sfAnalyserBuffer: Float32Array<ArrayBuffer> | null
  sfSink: GainNode | null
  sfSynth: SoundfontEngine['synthesizer'] | null
  sfChannel: number | null
  /**
   * P3.1：SoundFont 逐通道输出抽头的入口（原生 GainNode），接到本轨的 dry，
   * 使采样音源与合成器/音频片段一样经过该轨的 EQ → 压缩 → 推子处理链。
   * 只有在 per-channel 路由模式下才会有输入；global 模式下它没有连接、无害。
   */
  sfIn: GainNode | null
  voice: InstrumentVoice | null
  voiceKey: string
  route: TrackRoute
}

interface FlatNote {
  beat: number
  pitch: number
  velocity: number
  durationBeats: number
  trackId: string
}

interface PreviewState {
  timer: ReturnType<typeof setInterval> | null
  notes: FlatNote[]
  nextIndex: number
  startContextTime: number
  secPerBeat: number
  endContextTime: number
  trackId: string
}

interface SchedulerLoop {
  startBeat: number
  endBeat: number
}

/* ---------------- 音频片段（AudioClip）播放的数据结构 ---------------- */

interface AudioBufferEntry {
  buffer: Tone.ToneAudioBuffer | null
  promise: Promise<Tone.ToneAudioBuffer | null>
}

interface AudioPlayerEntry {
  /** 一个片段一个 Player（同一 asset 共享解码后的 buffer） */
  player: Tone.Player
  /** 片段级增益（audioClip.gainDb） */
  gain: Tone.Gain
  assetId: string
  trackId: string
}

/** 一次「走带 pass」的音频排期参数（位置是单调时间轴坐标，拍是乐谱绝对拍） */
interface AudioPass {
  /** 该 pass 在时间轴上的起点（拍坐标，单调递增） */
  positionFrom: number
  /** 该 pass 对应的乐谱起始拍 */
  beatFrom: number
  /** 该 pass 对应的乐谱结束拍 */
  beatTo: number
  /** 该 pass 内真正开始发声的乐谱拍（第一段 / 循环首圈取播放头位置） */
  audibleFromBeat: number
}

const LOOK_AHEAD_SEC = 0.16
const TICK_MS = 25
const MAX_CATCH_UP_SEC = 0.4

/* ------------------------------------------------------------------ */
/* 引擎实现                                                            */
/* ------------------------------------------------------------------ */

export function createAudioEngine(): AudioEngine {
  let initialized = false
  let isPlaying = false
  let lastPosition = 0

  let currentProject: Project | null = null
  let flatNotes: FlatNote[] = []
  let trackRuntime = new Map<string, { route: TrackRoute; emotion: ReturnType<typeof getEmotion>['params']; isDrum: boolean }>()

  const trackNodes = new Map<string, TrackNode>()

  /**
   * 静音汇流：Tone.Meter / Analyser 这类「叶子」节点只有被 destination 拉动才会更新读数，
   * 直接挂在总线末尾会永远读到 -∞（表现为电平表死掉）。用一个 0 增益节点把读数链拉到 destination。
   */
  let meterSink: Tone.Gain | null = null
  let lastAudition: { trackId: string; kind: 'synth' | 'soundfont'; detail: string; at: number } | null = null
  let scheduledNoteCount = 0
  let lastScheduledAt = 0
  let masterGain: Tone.Gain | null = null
  let limiter: Tone.Limiter | null = null
  let meter: Tone.Meter | null = null
  let mixBus: Tone.Gain | null = null
  /* P3.2 总线 / 母带处理链：mixBus → busEqLow → busEqMid → busEqHigh → busComp → busMakeup → masterGain */
  let busEqLow: Tone.Filter | null = null
  let busEqMid: Tone.Filter | null = null
  let busEqHigh: Tone.Filter | null = null
  let busComp: Tone.Compressor | null = null
  let busMakeup: Tone.Gain | null = null
  /** 当前母线压缩实际抵消的浏览器自动补偿增益（dB，调试/回归用） */
  let busAutoMakeupDb = 0
  let busChainEnabled = false
  /* P6-A：三段总线压缩（multiband）：busEqHigh → mbInput → 三路分频/压缩/补偿 → mbSum → busComp；
     关闭时走 mbBypass（busEqHigh → busComp），节点常驻避免断连爆音。 */
  let mbInput: Tone.Gain | null = null
  let mbBypass: Tone.Gain | null = null
  let mbSum: Tone.Gain | null = null
  let mbLowFilter: Tone.Filter | null = null
  let mbLowComp: Tone.Compressor | null = null
  let mbLowMakeup: Tone.Gain | null = null
  let mbMidHighpass: Tone.Filter | null = null
  let mbMidLowpass: Tone.Filter | null = null
  let mbMidComp: Tone.Compressor | null = null
  let mbMidMakeup: Tone.Gain | null = null
  let mbHighFilter: Tone.Filter | null = null
  let mbHighComp: Tone.Compressor | null = null
  let mbHighMakeup: Tone.Gain | null = null
  let mbEnabledState = false
  let mbAutoMakeupDb = { low: 0, mid: 0, high: 0 }
  let reverbBus: Tone.Reverb | null = null
  let delayBus: Tone.FeedbackDelay | null = null
  let chorusBus: Tone.Chorus | null = null
  let sfNative: GainNode | null = null
  let nativeContext: AudioContext | null = null
  let metronomeSynth: Tone.MembraneSynth | null = null

  let metronome = false

  /* ---------------- 音频片段播放状态 ---------------- */

  /** assetId → 解码后的 WAV buffer（同一资产只下载 / 解码一次） */
  const audioBuffers = new Map<string, AudioBufferEntry>()
  /** clipId → Player（每个音频片段一个，输出接该轨道的 dry 输入，复用轨道音量/声像/静音） */
  const audioPlayers = new Map<string, AudioPlayerEntry>()
  /** 已经排期的循环 pass 序号（避免同一 pass 重复 start 触发 Tone 的断言） */
  let audioArmedPasses = new Set<number>()
  /** 首个循环 pass 的序号 / 该 pass 的实际起播拍（从循环中间起播时用于取 offset） */
  let audioFirstPassIndex = 0
  let audioFirstAudibleBeat = 0
  /** 音频排布签名：只有片段排布 / BPM / 循环区间变化时才重排，混音改动不打断音频 */
  let audioSignature = ''

  /** 音频片段在时间轴上的结束拍（与 clip.startBeat 一起用于排期） */
  const audioClipEnd = (clip: AudioClip): number => clip.startBeat + clip.lengthBeats

  /** 资产 WAV 的直链（Tone.Player 直接流式加载） */
  const audioAssetUrl = (assetId: string): string => `/api/assets/${encodeURIComponent(assetId)}/file`

  /**
   * 音频排布签名。**刻意不包含 volume/pan/mute**：这些由轨道 Channel 实时生效，
   * 不需要重排（重排会打断正在播放的音频）。
   */
  const audioSignatureOf = (project: Project): string => {
    const parts: string[] = [
      `tempo:${project.tempo}`,
      `loop:${project.loop.enabled ? 1 : 0}:${project.loop.startBeat}:${project.loop.endBeat}`,
    ]
    for (const track of project.tracks) {
      const clips = track.audioClips ?? []
      if (clips.length === 0) continue
      parts.push(`track:${track.id}:${track.kind}`)
      for (const clip of clips) {
        parts.push(
          [
            clip.id,
            clip.assetId,
            clip.trackId,
            clip.startBeat,
            clip.lengthBeats,
            clip.offsetSec,
            clip.durationSec,
            clip.stretchRatio,
            clip.gainDb,
            clip.muted ? 1 : 0,
          ].join(':'),
        )
      }
    }
    return parts.join('|')
  }

  /** 加载（并缓存）某个资产的音频 buffer；失败返回 null（前端不白屏，只是没声音） */
  const loadAudioBuffer = (assetId: string): Promise<Tone.ToneAudioBuffer | null> => {
    const cached = audioBuffers.get(assetId)
    if (cached) return cached.promise
    const entry: AudioBufferEntry = { buffer: null, promise: Promise.resolve(null) }
    entry.promise = (async () => {
      try {
        const raw = await Tone.ToneAudioBuffer.load(audioAssetUrl(assetId))
        const buffer = new Tone.ToneAudioBuffer(raw)
        entry.buffer = buffer
        return buffer
      } catch (error) {
        console.warn('[audio] 音频资产加载失败（波形仍可用，但不会发声）', assetId, error)
        return null
      }
    })()
    audioBuffers.set(assetId, entry)
    return entry.promise
  }

  /** 预加载工程里所有音频片段用到的资产（play() 前 await，保证排期时 buffer 已就绪） */
  const preloadAudioAssets = async (project: Project): Promise<void> => {
    const ids = new Set<string>()
    for (const track of project.tracks) {
      for (const clip of track.audioClips ?? []) ids.add(clip.assetId)
    }
    if (ids.size === 0) return
    await Promise.all([...ids].map((assetId) => loadAudioBuffer(assetId)))
  }

  const disposeAudioPlayer = (clipId: string): void => {
    const entry = audioPlayers.get(clipId)
    if (!entry) return
    try {
      entry.player.stop(now())
    } catch {
      /* ignore */
    }
    try {
      entry.player.dispose()
    } catch {
      /* ignore */
    }
    try {
      entry.gain.dispose()
    } catch {
      /* ignore */
    }
    audioPlayers.delete(clipId)
  }

  /** 确保片段有 Player：输出接该轨道节点的 dry 输入（音量/声像/静音/发送全部复用轨道混音） */
  const ensureAudioPlayer = (clip: AudioClip): AudioPlayerEntry | null => {
    const existing = audioPlayers.get(clip.id)
    if (existing) {
      if (existing.assetId !== clip.assetId || existing.trackId !== clip.trackId) {
        disposeAudioPlayer(clip.id)
      } else {
        try {
          existing.gain.gain.rampTo(Tone.dbToGain(clip.gainDb), 0.05)
        } catch {
          /* ignore */
        }
        return existing
      }
    }
    const buffer = audioBuffers.get(clip.assetId)?.buffer
    if (!buffer) return null
    const trackNode = trackNodes.get(clip.trackId)
    if (!trackNode) return null
    const player = new Tone.Player()
    try {
      // 一期不变速：stretchRatio 固定 1（变速会变调，见 core/audio.ts）
      player.playbackRate = 1
      player.buffer = buffer
    } catch (error) {
      console.warn('[audio] 音频片段初始化失败', clip.id, error)
      return null
    }
    const gain = new Tone.Gain(Tone.dbToGain(clip.gainDb))
    player.connect(gain)
    gain.connect(trackNode.dry)
    const entry: AudioPlayerEntry = { player, gain, assetId: clip.assetId, trackId: clip.trackId }
    audioPlayers.set(clip.id, entry)
    return entry
  }

  /** 停掉所有音频片段发声（暂停 / 停止 / 重排前调用；会同时取消未来已排期的 start） */
  const stopAudioPlayers = (): void => {
    const at = now()
    for (const entry of audioPlayers.values()) {
      try {
        entry.player.stop(at)
      } catch {
        /* ignore */
      }
    }
  }

  const resetAudioSchedule = (): void => {
    stopAudioPlayers()
    audioArmedPasses = new Set()
  }

  /**
   * 排一个「走带 pass」内的音频片段。
   *
   * 把片段与 pass 的拍区间求交，按拍 → AudioContext 时间的线性映射排给 Tone.Player：
   * - 片段起点在 pass 之前 → 从 `audibleFromBeat` 起播，offset 加上已过去的部分（seek 后正确）；
   * - 片段起点在 pass 内 → 用绝对时间排在它的起点；
   * - 循环时每个 pass 单独排，片段在循环边界处截断、下一圈从头再起（不做时间拉伸）。
   */
  const scheduleAudioPass = (pass: AudioPass): void => {
    const project = currentProject
    if (!project || !initialized) return
    const secPerBeat = scheduler.secPerBeat
    const mappingNow = mapping()
    for (const track of project.tracks) {
      const clips = track.audioClips ?? []
      if (clips.length === 0) continue
      for (const clip of clips) {
        if (clip.muted) continue
        const stretch = clip.stretchRatio || 1
        const fromBeat = Math.max(clip.startBeat, pass.audibleFromBeat)
        const toBeat = Math.min(audioClipEnd(clip), pass.beatTo)
        if (toBeat - fromBeat < 0.01) continue
        const entry = ensureAudioPlayer(clip)
        if (!entry) continue
        const position = pass.positionFrom + (fromBeat - pass.beatFrom)
        /* seek / 起播瞬间可能略早于当前时间：夹到 now 之后，避免 Tone 排到过去 */
        const startTime = Math.max(contextTimeAtPosition(position), now() + 0.004)
        const bufferDuration = entry.player.buffer.duration || 0
        /* offsetSec = 片段裁剪起点 + 片段内已经播放掉的秒数（不变速） */
        let offsetSec = clip.offsetSec + ((fromBeat - clip.startBeat) * secPerBeat) / stretch
        let durationSec = ((toBeat - fromBeat) * secPerBeat) / stretch
        if (bufferDuration > 0) {
          if (offsetSec >= bufferDuration) continue
          offsetSec = Math.min(offsetSec, Math.max(0, bufferDuration - 0.02))
          durationSec = Math.min(durationSec, Math.max(0.02, bufferDuration - offsetSec))
        }
        if (durationSec <= 0) continue
        /* 比 pass 末尾少 10ms：同一 Player 相邻两次 start 必须严格递增（Tone 的断言） */
        const safeDuration = Math.max(0.02, durationSec - 0.01)
        try {
          entry.player.start(startTime, offsetSec, safeDuration)
        } catch (error) {
          console.warn('[audio] 音频片段排期失败', clip.id, error)
        }
      }
    }
  }

  /** 当前时间轴位置对应的循环 pass 序号（无循环返回 0） */
  const currentAudioPass = (position: number): number => {
    const loop = scheduler.loop
    if (!loop) return 0
    const length = loop.endBeat - loop.startBeat
    if (length <= 0.001) return 0
    return Math.max(0, Math.floor((position - loop.startBeat) / length))
  }

  /** 循环中：保证「当前 pass」和「下一个 pass」已排期（提前一整圈，循环边界不会漏音） */
  const pumpAudio = (): void => {
    const loop = scheduler.loop
    if (!loop || !currentProject) return
    const length = loop.endBeat - loop.startBeat
    if (length <= 0.001) return
    const reference = Math.max(positionAt(now()), scheduler.startPosition)
    const pass = currentAudioPass(reference)
    for (let index = pass; index <= pass + 1; index += 1) {
      if (audioArmedPasses.has(index)) continue
      audioArmedPasses.add(index)
      scheduleAudioPass({
        positionFrom: loop.startBeat + index * length,
        beatFrom: loop.startBeat,
        beatTo: loop.endBeat,
        audibleFromBeat:
          index === audioFirstPassIndex ? Math.max(loop.startBeat, audioFirstAudibleBeat) : loop.startBeat,
      })
    }
  }

  /**
   * 从当前走带位置重建音频排期。**所有 play / seek / 播放中工程变化都走这里**，
   * 这样音频始终和引擎自己的时钟（startContextTime + secPerBeat）对齐，不另建时钟。
   */
  const armAudioPlayback = (): void => {
    if (!initialized || !currentProject) return
    resetAudioSchedule()
    const loop = scheduler.loop
    const reference = Math.max(positionAt(now()), scheduler.startPosition)
    audioFirstAudibleBeat = beatAtPosition(reference)
    audioFirstPassIndex = currentAudioPass(reference)
    if (!loop) {
      scheduleAudioPass({
        positionFrom: scheduler.startPosition,
        beatFrom: scheduler.startPosition,
        beatTo: scheduler.endBeat,
        audibleFromBeat: Math.max(scheduler.startPosition, audioFirstAudibleBeat),
      })
      return
    }
    /* 循环起点之前的直通段（从循环外起播） */
    if (scheduler.startPosition < loop.startBeat) {
      const preLoopAudible = Math.max(scheduler.startPosition, audioFirstAudibleBeat)
      scheduleAudioPass({
        positionFrom: scheduler.startPosition,
        beatFrom: scheduler.startPosition,
        beatTo: loop.startBeat,
        audibleFromBeat: preLoopAudible,
      })
      audioFirstAudibleBeat = loop.startBeat
      audioFirstPassIndex = 0
    }
    pumpAudio()
  }

  /** 工程里已经不存在的音频片段：释放对应 Player / buffer */
  const pruneAudioPlayback = (project: Project): void => {
    const alive = new Set<string>()
    for (const track of project.tracks) {
      for (const clip of track.audioClips ?? []) alive.add(clip.id)
    }
    for (const clipId of [...audioPlayers.keys()]) {
      if (!alive.has(clipId)) disposeAudioPlayer(clipId)
    }
    const assetIds = new Set<string>()
    for (const track of project.tracks) {
      for (const clip of track.audioClips ?? []) assetIds.add(clip.assetId)
    }
    for (const [assetId, entry] of [...audioBuffers.entries()]) {
      if (assetIds.has(assetId)) continue
      try {
        entry.buffer?.dispose()
      } catch {
        /* ignore */
      }
      audioBuffers.delete(assetId)
    }
  }

  /**
   * 工程变化 → 音频排期同步。
   * - 排布没变（例如只调了音量/声像/静音）：只更新片段增益，不打断播放；
   * - 排布变了且正在播放：从当前位置重排（buffer 已缓存时同步完成）。
   */
  const syncAudioPlayback = (project: Project): void => {
    const signature = audioSignatureOf(project)
    const changed = signature !== audioSignature
    audioSignature = signature
    pruneAudioPlayback(project)
    if (!changed) {
      for (const track of project.tracks) {
        for (const clip of track.audioClips ?? []) {
          const entry = audioPlayers.get(clip.id)
          if (!entry) continue
          try {
            entry.gain.gain.rampTo(Tone.dbToGain(clip.gainDb), 0.05)
          } catch {
            /* ignore */
          }
        }
      }
      return
    }
    if (!isPlaying) {
      resetAudioSchedule()
      return
    }
    void preloadAudioAssets(project).then(() => {
      if (!isPlaying || !currentProject) return
      if (audioSignature !== signature) return
      armAudioPlayback()
    })
  }

  const playheadHandlers = new Set<(beat: number) => void>()
  const levelHandlers = new Set<(level: number) => void>()

  const midi = new WebMidiInput()
  const soundfont = new SoundfontEngine()

  /* ---------------- 走带状态 ---------------- */
  const scheduler = {
    timer: null as ReturnType<typeof setInterval> | null,
    startContextTime: 0,
    startPosition: 0,
    scheduledPosition: 0,
    position: 0,
    secPerBeat: 0.5,
    endBeat: 0,
    loop: null as SchedulerLoop | null,
    countInEndsAt: 0,
  }

  let rafId: number | null = null
  let lastLevelEmit = 0
  let previewState: PreviewState | null = null
  /** 兜底试听音色（轨道节点尚未建立时用），按「轨道 id + 音色签名」失效重建 */
  const fallbackPreview = new Map<string, { key: string; voice: InstrumentVoice; gain: Tone.Gain }>()
  /** 正被预听 / MIDI 按住的音符（用于精确 noteOff，避免误伤播放中的同音） */
  const auditionHeld = new Map<string, Set<number>>()

  const now = () => Tone.immediate()

  /* ------------------------------------------------------------------ */
  /* 音频图                                                              */
  /* ------------------------------------------------------------------ */

  const ensureGraph = () => {
    if (masterGain) return
    limiter = new Tone.Limiter(-1)
    limiter.toDestination()
    masterGain = new Tone.Gain(0.9)
    masterGain.connect(limiter)
    meter = new Tone.Meter({ smoothing: 0.72, normalRange: false })
    limiter.connect(meter)
    // 把电平表链拉到 destination（0 增益，不发声），否则读数恒为 -∞
    meterSink = new Tone.Gain(0)
    meter.connect(meterSink)
    meterSink.toDestination()

    mixBus = new Tone.Gain(1)
    /* P3.2 总线/母带链（默认中性 bypass）：mixBus → EQ → 压缩 → 补偿 → masterGain */
    busEqLow = new Tone.Filter({ type: 'lowshelf', frequency: 100, gain: 0 })
    busEqMid = new Tone.Filter({ type: 'peaking', frequency: 420, gain: 0, Q: 0.9 })
    busEqHigh = new Tone.Filter({ type: 'highshelf', frequency: 10000, gain: 0 })
    busComp = new Tone.Compressor({ threshold: 0, ratio: 1, attack: 0.02, release: 0.22, knee: 0 })
    busMakeup = new Tone.Gain(1)
    /* P6-A 三段总线压缩：输入门控 + bypass 门控（默认 bypass），三路各自压缩后求和 */
    mbInput = new Tone.Gain(0)
    mbBypass = new Tone.Gain(1)
    mbSum = new Tone.Gain(1)
    mbLowFilter = new Tone.Filter({ type: 'lowpass', frequency: 200, rolloff: -24 })
    mbLowComp = new Tone.Compressor({ threshold: 0, ratio: 1, attack: 0.02, release: 0.2, knee: 0 })
    mbLowMakeup = new Tone.Gain(1)
    mbMidHighpass = new Tone.Filter({ type: 'highpass', frequency: 200, rolloff: -24 })
    mbMidLowpass = new Tone.Filter({ type: 'lowpass', frequency: 3000, rolloff: -24 })
    mbMidComp = new Tone.Compressor({ threshold: 0, ratio: 1, attack: 0.012, release: 0.16, knee: 0 })
    mbMidMakeup = new Tone.Gain(1)
    mbHighFilter = new Tone.Filter({ type: 'highpass', frequency: 3000, rolloff: -24 })
    mbHighComp = new Tone.Compressor({ threshold: 0, ratio: 1, attack: 0.008, release: 0.12, knee: 0 })
    mbHighMakeup = new Tone.Gain(1)
    busEqHigh.connect(mbInput)
    busEqHigh.connect(mbBypass)
    mbInput.connect(mbLowFilter)
    mbLowFilter.connect(mbLowComp)
    mbLowComp.connect(mbLowMakeup)
    mbLowMakeup.connect(mbSum)
    mbInput.connect(mbMidHighpass)
    mbMidHighpass.connect(mbMidLowpass)
    mbMidLowpass.connect(mbMidComp)
    mbMidComp.connect(mbMidMakeup)
    mbMidMakeup.connect(mbSum)
    mbInput.connect(mbHighFilter)
    mbHighFilter.connect(mbHighComp)
    mbHighComp.connect(mbHighMakeup)
    mbHighMakeup.connect(mbSum)
    mbSum.connect(busComp)
    mbBypass.connect(busComp)
    mixBus.connect(busEqLow)
    busEqLow.connect(busEqMid)
    busEqMid.connect(busEqHigh)
    busComp.connect(busMakeup)
    busMakeup.connect(masterGain)

    reverbBus = new Tone.Reverb({ decay: 2.8, preDelay: 0.02, wet: 1 })
    reverbBus.connect(mixBus)
    delayBus = new Tone.FeedbackDelay({ delayTime: '8n', feedback: 0.28, wet: 1 })
    delayBus.connect(mixBus)
    chorusBus = new Tone.Chorus({ frequency: 1.1, delayTime: 3.5, depth: 0.5, wet: 1 }).start()
    chorusBus.connect(mixBus)

    metronomeSynth = new Tone.MembraneSynth({
      pitchDecay: 0.008,
      octaves: 1.2,
      envelope: { attack: 0.001, decay: 0.06, sustain: 0, release: 0.02 },
    })
    metronomeSynth.connect(masterGain)

    // 采样音源的输出先进入原生 GainNode，再汇入 Tone 总线
    const raw = nativeContext ?? (Tone.getContext().rawContext as AudioContext)
    sfNative = raw.createGain()
    sfNative.gain.value = 1
    Tone.connect(sfNative, mixBus)
    soundfont.configure(raw, sfNative)
  }

  const disposeTrackNode = (node: TrackNode) => {
    detachSoundfontTap(node)
    /* P3.1：先断开逐通道抽头入口（路由表里的目标仍由 routeSoundfontChannels 负责 unroute） */
    try {
      node.sfIn?.disconnect()
    } catch {
      /* ignore */
    }
    node.sfIn = null
    try {
      node.voice?.allNotesOff()
      node.voice?.dispose()
    } catch {
      /* ignore */
    }
    for (const target of [
      node.dry,
      node.eqLow,
      node.eqMid,
      node.eqHigh,
      node.compressor,
      node.makeup,
      node.postSend,
      node.duckGain,
      node.muteGain,
      node.channel,
      node.widener,
      node.meter,
      node.sendReverb,
      node.sendDelay,
      node.sendChorus,
    ]) {
      try {
        target.dispose()
      } catch {
        /* ignore */
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 每轨电平（只读旁路，不参与信号链）                                   */
  /* ------------------------------------------------------------------ */

  /**
   * 采样音源轨道：把该轨 MIDI 通道的「可视化输出」接到一个 AnalyserNode。
   * spessasynth 的通道可视化输出本来就是给电平表用的，不会改变主输出；
   * 末端再串一个 0 增益节点到 destination，保证 analyser 一定被音频图拉取。
   */
  const attachSoundfontTap = (trackId: string, channel: number) => {
    const node = trackNodes.get(trackId)
    if (!node) return
    const synth = soundfont.synthesizer
    const context = nativeContext
    if (!synth || !context) return
    if (node.sfAnalyser && node.sfSynth === synth && node.sfChannel === channel) return
    detachSoundfontTap(node)
    try {
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.5
      const sink = context.createGain()
      sink.gain.value = 0
      synth.connectChannel(analyser, channel)
      analyser.connect(sink)
      sink.connect(context.destination)
      node.sfAnalyser = analyser
      node.sfAnalyserBuffer = new Float32Array(analyser.fftSize)
      node.sfSink = sink
      node.sfSynth = synth
      node.sfChannel = channel
    } catch {
      detachSoundfontTap(node)
    }
  }

  const detachSoundfontTap = (node: TrackNode) => {
    const analyser = node.sfAnalyser
    if (analyser) {
      if (node.sfSynth && node.sfChannel != null) {
        try {
          node.sfSynth.disconnectChannel(analyser, node.sfChannel)
        } catch {
          /* ignore */
        }
      }
      try {
        analyser.disconnect()
      } catch {
        /* ignore */
      }
    }
    try {
      node.sfSink?.disconnect()
    } catch {
      /* ignore */
    }
    node.sfAnalyser = null
    node.sfAnalyserBuffer = null
    node.sfSink = null
    node.sfSynth = null
    node.sfChannel = null
  }

  /** 读一条轨道的电平（0..1，由 dB 映射；0 = 静音 / -∞） */
  const readTrackLevel = (node: TrackNode): number => {
    if (node.route === 'soundfont' && node.sfAnalyser && node.sfAnalyserBuffer) {
      try {
        node.sfAnalyser.getFloatTimeDomainData(node.sfAnalyserBuffer)
        const buffer = node.sfAnalyserBuffer
        let peak = 0
        for (let i = 0; i < buffer.length; i += 1) {
          const value = Math.abs(buffer[i])
          if (value > peak) peak = value
        }
        if (peak < 1e-4) return 0
        return clamp((20 * Math.log10(peak) + 60) / 60, 0, 1)
      } catch {
        return 0
      }
    }
    try {
      const value = node.meter.getValue()
      const db = typeof value === 'number' ? value : value[0]
      if (!Number.isFinite(db)) return 0
      return clamp((db + 60) / 60, 0, 1)
    } catch {
      return 0
    }
  }

  /* ------------------------------------------------------------------ */
  /* P3.1：SoundFont 输出路由（global 主输出 / 逐通道抽头）               */
  /* ------------------------------------------------------------------ */

  interface SoundfontRouteEntry {
    channel: number
    target: AudioNode
    connected: boolean
  }

  const soundfontRouting = {
    mode: 'none' as 'none' | 'global' | 'per-channel',
    mainOutput: true,
    routes: new Map<string, SoundfontRouteEntry>(),
  }

  /** 断开所有逐通道抽头（全局输出 / 无音色库 / 回退时调用） */
  const clearSoundfontChannelRoutes = () => {
    for (const [trackId, route] of [...soundfontRouting.routes]) {
      soundfont.unrouteChannelFrom(route.target, route.channel)
      soundfontRouting.routes.delete(trackId)
    }
  }

  /**
   * 按当前路由模式刷新每条采样轨的 CC。
   * per-channel 模式下音量/声像/发送由节点链负责，CC 必须用中性值，不能压两次。
   */
  const refreshSoundfontChannelMix = (project: Project, audible: Set<string>) => {
    const perChannel = soundfontRouting.mode === 'per-channel'
    for (const track of project.tracks) {
      const node = trackNodes.get(track.id)
      if (!node || node.route !== 'soundfont') continue
      if (soundfont.channelFor(track.id) == null) continue
      const emotion = getEmotion(track.instrumentId, track.emotionId).params
      const instrument = getInstrument(track.instrumentId)
      soundfont.applyChannelMix(
        track.id,
        {
          volume: track.volume,
          pan: track.pan,
          reverb: reverbAmount(track, emotion.reverb),
          chorus: chorusAmount(track, emotion.chorus, instrument.synth.fx.chorus),
          brightness: emotion.brightness,
          modulation: emotion.vibrato * 0.9,
          muted: !audible.has(track.id),
        },
        { perChannelRouting: perChannel },
      )
    }
  }

  /**
   * 同步 SoundFont 输出路由（P3.1）。在每轮轨道同步后调用。
   *
   * 模式判定：
   * - 无音色库 / 没有采样轨 → `none`（主输出保持开，行为与旧版一致）；
   * - 有采样轨且 spessasynth 支持 `connectChannel`、通道无冲突 → `per-channel`
   *   （主输出关，每个通道接到该轨 `sfIn` → dry → EQ/压缩 → 推子）；
   * - 通道共用（>16 条采样轨）或运行时不支持逐通道 → `global`（保留旧行为）；
   * - 任何一次 `connectChannel` 失败 → 清理并回退 `global`，绝不静默丢音。
   *
   * 采用增量 diff：切轨/删轨/通道重分配只动变化的通道，避免频繁断开重连爆音。
   */
  const routeSoundfontChannels = (project: Project, audible: Set<string>) => {
    const synth = soundfont.synthesizer
    const usable = Boolean(synth && soundfont.usable)

    const entries: { trackId: string; channel: number; node: TrackNode }[] = []
    if (usable) {
      for (const track of project.tracks) {
        const node = trackNodes.get(track.id)
        if (!node || node.route !== 'soundfont') continue
        const channel = soundfont.channelFor(track.id)
        if (channel == null) continue
        entries.push({ trackId: track.id, channel, node })
      }
    }

    let mode: 'none' | 'global' | 'per-channel' = 'none'
    if (entries.length > 0) {
      const supports = soundfont.supportsPerChannelRouting()
      const usage = new Map<number, number>()
      for (const entry of entries) usage.set(entry.channel, (usage.get(entry.channel) ?? 0) + 1)
      const conflict = [...usage.values()].some((count) => count > 1)
      const allHaveInput = entries.every((entry) => Boolean(entry.node.sfIn))
      mode = supports && !conflict && allHaveInput ? 'per-channel' : 'global'
      if (mode === 'global' && soundfontRouting.mode !== 'global') {
        console.warn(
          conflict
            ? '[audio] SoundFont 轨道数超过可用通道（出现共用通道），回退全局输出（不经过每轨处理链）'
            : '[audio] 当前 spessasynth 不支持逐通道输出，SoundFont 轨回退全局输出（不经过每轨处理链）',
        )
      }
    }

    /* 只有 per-channel 才关主输出；其它模式先清抽头再开主输出（顺序避免瞬间双声） */
    if (mode === 'per-channel') {
      soundfont.setMainOutput(false)
      /* 1) 断开失效 / 通道变了的路由 */
      for (const [trackId, route] of [...soundfontRouting.routes]) {
        const wanted = entries.find((entry) => entry.trackId === trackId)
        if (wanted && wanted.channel === route.channel && route.target === wanted.node.sfIn) continue
        soundfont.unrouteChannelFrom(route.target, route.channel)
        soundfontRouting.routes.delete(trackId)
      }
      /* 2) 建立新路由；任何一条失败 → 全部回退 global */
      let failed = false
      for (const entry of entries) {
        if (soundfontRouting.routes.has(entry.trackId)) continue
        const target = entry.node.sfIn
        if (!target || !soundfont.routeChannelTo(target, entry.channel)) {
          failed = true
          break
        }
        soundfontRouting.routes.set(entry.trackId, { channel: entry.channel, target, connected: true })
      }
      if (failed) {
        clearSoundfontChannelRoutes()
        soundfont.setMainOutput(true)
        mode = 'global'
        console.warn('[audio] SoundFont 逐通道路由失败，回退全局输出（保持有声）')
      }
    } else {
      clearSoundfontChannelRoutes()
      soundfont.setMainOutput(true)
    }

    soundfontRouting.mode = mode
    soundfontRouting.mainOutput = mode !== 'per-channel'
    /*
     * send 门控：只有 per-channel SoundFont 轨用「处理链之后」的信号喂 send 总线；
     * 其它轨（合成器 voice）已直连 send，这里保持 0 避免重复发送。
     */
    for (const track of project.tracks) {
      const node = trackNodes.get(track.id)
      if (!node) continue
      const routed = mode === 'per-channel' && soundfontRouting.routes.has(track.id)
      try {
        node.postSend.gain.rampTo(routed ? 1 : 0, 0.05)
      } catch {
        /* ignore */
      }
    }
    /* 路由模式可能刚变化：按正确模式重刷 CC，避免音量/声像压两次 */
    refreshSoundfontChannelMix(project, audible)
  }

  /* ------------------------------------------------------------------ */
  /* 情绪 / 路由映射                                                      */
  /* ------------------------------------------------------------------ */

  const reverbAmount = (track: Track, emotionReverb: number) => clamp(track.reverbSend * 0.6 + emotionReverb * 0.7, 0, 1)
  const delayAmount = (track: Track, emotionDelay: number) => clamp(track.delaySend * 0.6 + emotionDelay * 0.7, 0, 1)
  const chorusAmount = (track: Track, emotionChorus: number, patchChorus: number) =>
    clamp(emotionChorus * 0.9 + patchChorus * 0.5, 0, 1)

  const shouldUseSoundfont = (track: Track): boolean => soundfont.usable && track.engine !== 'synth'

  /* ------------------------------------------------------------------ */
  /* 轨道节点                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 处理链 bypass 目标值（没有 mixChain / enabled=false 时把节点归零到这些值）。
   * 频率用中性值而不是保留上一次，便于 `__debugChain` 断言与可复现。
   */
  const CHAIN_NEUTRAL = {
    lowShelf: { hz: 90, gainDb: 0 },
    mid: { hz: 1000, gainDb: 0, q: 0.9 },
    highShelf: { hz: 8000, gainDb: 0 },
    compressor: { thresholdDb: 0, ratio: 1, attackSec: 0.01, releaseSec: 0.2, kneeDb: 0 },
  } as const

  const ensureTrackNode = (track: Track): TrackNode => {
    let node = trackNodes.get(track.id)
    if (node) return node
    const channel = new Tone.Channel({ volume: -6, pan: 0 })
    const widener = new Tone.StereoWidener(0.5)
    const dry = new Tone.Gain(1)
    const sendReverb = new Tone.Gain(0)
    const sendDelay = new Tone.Gain(0)
    const sendChorus = new Tone.Gain(0)
    /* P3 处理链：三段 EQ → 压缩 → 补偿增益（默认就是 bypass 的零值） */
    const eqLow = new Tone.Filter({
      type: 'lowshelf',
      frequency: CHAIN_NEUTRAL.lowShelf.hz,
      gain: CHAIN_NEUTRAL.lowShelf.gainDb,
    })
    const eqMid = new Tone.Filter({
      type: 'peaking',
      frequency: CHAIN_NEUTRAL.mid.hz,
      gain: CHAIN_NEUTRAL.mid.gainDb,
      Q: CHAIN_NEUTRAL.mid.q,
    })
    const eqHigh = new Tone.Filter({
      type: 'highshelf',
      frequency: CHAIN_NEUTRAL.highShelf.hz,
      gain: CHAIN_NEUTRAL.highShelf.gainDb,
    })
    const compressor = new Tone.Compressor({
      threshold: CHAIN_NEUTRAL.compressor.thresholdDb,
      ratio: CHAIN_NEUTRAL.compressor.ratio,
      attack: CHAIN_NEUTRAL.compressor.attackSec,
      release: CHAIN_NEUTRAL.compressor.releaseSec,
      knee: CHAIN_NEUTRAL.compressor.kneeDb,
    })
    const makeup = new Tone.Gain(1)
    /* 处理链之后的 send 门控：仅 per-channel SoundFont 路由时打开（见 routeSoundfontChannels） */
    const postSend = new Tone.Gain(0)
    /* P6-A：侧链 ducking 增益（默认 1，pump 时按触发源包络压低） */
    const duckGain = new Tone.Gain(1)
    /* 静音 / 独奏门：放在 ducking 之前、推子之前，send 抽头在其下游（见 TrackNode.muteGain 注释） */
    const muteGain = new Tone.Gain(1)
    /* P3.1：SoundFont 逐通道抽头的入口；接 dry 后与合成器共用同一条处理链 */
    const rawContextForTrack = nativeContext ?? (Tone.getContext().rawContext as AudioContext)
    const sfIn = rawContextForTrack.createGain()
    sfIn.gain.value = 1
    Tone.connect(sfIn, dry)
    // 每轨电平表：旁路 tap（meter 无输出），接在 widener 之后，不改变主信号链
    const trackMeter = new Tone.Meter({ smoothing: 0.6, normalRange: false })
    dry.connect(eqLow)
    eqLow.connect(eqMid)
    eqMid.connect(eqHigh)
    eqHigh.connect(compressor)
    compressor.connect(makeup)
    makeup.connect(muteGain)
    muteGain.connect(duckGain)
    duckGain.connect(channel)
    /* send 走处理链输出（门控），避免逐通道模式下「dry 直达 send」绕过 EQ/压缩；ducking 也作用于 send */
    duckGain.connect(postSend)
    postSend.connect(sendReverb)
    postSend.connect(sendDelay)
    postSend.connect(sendChorus)
    channel.connect(widener)
    widener.connect(mixBus as Tone.Gain)
    widener.connect(trackMeter)
    if (meterSink) trackMeter.connect(meterSink)
    sendReverb.connect(reverbBus as Tone.Reverb)
    sendDelay.connect(delayBus as Tone.FeedbackDelay)
    sendChorus.connect(chorusBus as Tone.Chorus)
    node = {
      channel,
      widener,
      dry,
      eqLow,
      eqMid,
      eqHigh,
      compressor,
      makeup,
      postSend,
      duckGain,
      muteGain,
      sendReverb,
      sendDelay,
      sendChorus,
      meter: trackMeter,
      sfAnalyser: null,
      sfAnalyserBuffer: null,
      sfSink: null,
      sfSynth: null,
      sfChannel: null,
      sfIn,
      voice: null,
      voiceKey: '',
      route: 'synth',
    }
    trackNodes.set(track.id, node)
    return node
  }

  const attachVoice = (node: TrackNode, voice: InstrumentVoice) => {
    voice.output.connect(node.dry)
    voice.output.connect(node.sendReverb)
    voice.output.connect(node.sendDelay)
    voice.output.connect(node.sendChorus)
  }

  const rebuildVoice = (track: Track, node: TrackNode, route: TrackRoute): void => {
    const instrument = getInstrument(track.instrumentId)
    const emo = getEmotion(track.instrumentId, track.emotionId).params
    const key = `${route}:${track.instrumentId}:${track.emotionId}:${track.octaveShift}`
    if (node.voiceKey === key && node.voice) {
      node.route = route
      return
    }
    const old = node.voice
    node.voice = null
    node.voiceKey = ''
    if (old) {
      old.allNotesOff()
      // 给旧音色 120ms 自然释放，避免换音色时「咔」的一声
      setTimeout(() => {
        try {
          old.dispose()
        } catch {
          /* ignore */
        }
      }, 120)
    }
    node.route = route
    if (route === 'synth') {
      const voice = createInstrumentVoice(instrument, emo)
      attachVoice(node, voice)
      node.voice = voice
      node.voiceKey = key
    }
  }

  /* ------------------------------------------------------------------ */
  /* 工程应用（热更新）                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * 重建播放用音符索引。
   *
   * **只跳过片段级静音（`clip.muted`），不再按轨道可听性过滤**：
   * 轨道静音 / 独奏是混音层的事，由 `applyMix` 的通道静音承担。
   * 早期版本把不可听轨道的音符直接从索引里删掉，导致「播放中取消静音」时
   * 这批音符要等下一次进入 look-ahead 窗口才会被重新排上，中间几十毫秒必然丢音；
   * 反过来把索引留着，取消静音可以立刻恢复发声，也让「播放」这一件事只有一个真相。
   */
  const rebuildNoteIndex = (project: Project) => {
    const notes: FlatNote[] = []
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (clip.muted) continue
        for (const note of clip.notes) {
          notes.push({
            beat: clip.startBeat + note.start,
            pitch: clamp(Math.round(note.pitch + track.octaveShift * 12), 0, 127),
            velocity: clamp(Math.round(note.velocity), 1, 127),
            durationBeats: Math.max(0.02, note.duration),
            trackId: track.id,
          })
        }
      }
    }
    notes.sort((a, b) => a.beat - b.beat || a.trackId.localeCompare(b.trackId))
    flatNotes = notes
  }

  /** 处理链参数过渡时长（秒）：与推子一致，避免拖动/切换链时爆音 */
  const CHAIN_RAMP_SEC = 0.08

  /**
   * Blink（Chrome/Edge）的 DynamicsCompressorNode 自带一个**固定的自动补偿增益**
   * （实测 threshold=-50/ratio=20 约 +29dB、threshold=-20/ratio=4 约 +9dB，且与输入电平无关）。
   * 这不是 WebAudio 规范行为，却会把「压缩前」的 EQ 衰减整体抵消掉；
   * core 的 MixChain 按标准无补偿压缩设计（makeupDb 只用于抵消 EQ 响度），
   * 因此这里在压缩后用 makeup 节点抵消浏览器的自动补偿，恢复预期处理链行为。
   *
   * 补偿量用 OfflineAudioContext 现场标定（不同浏览器/版本可能不同），按参数组合缓存；
   * 标定完成前先按 0 处理，完成后自动重刷一遍链参数。
   */
  const compMakeupCache = new Map<string, number>()
  const compMakeupPending = new Map<string, Promise<number>>()

  const compMakeupKey = (thresholdDb: number, ratio: number, kneeDb: number) =>
    `${thresholdDb.toFixed(2)}|${ratio.toFixed(2)}|${kneeDb.toFixed(2)}`

  const reapplyMixChains = (): void => {
    const project = currentProject
    if (!project) return
    for (const track of project.tracks) {
      const node = trackNodes.get(track.id)
      if (node) applyMixChain(track, node)
    }
    /* 总线链复用同一个标定缓存：标定完成后也要重刷母带链 */
    applyMasterChain(project)
  }

  /** 标定浏览器 DynamicsCompressor 的自动补偿增益（dB，>=0）；失败返回 0 */
  const calibrateCompressorMakeup = (thresholdDb: number, ratio: number, kneeDb: number): Promise<number> => {
    const key = compMakeupKey(thresholdDb, ratio, kneeDb)
    const cached = compMakeupCache.get(key)
    if (cached !== undefined) return Promise.resolve(cached)
    const pending = compMakeupPending.get(key)
    if (pending) return pending
    const run = (async () => {
      let makeup = 0
      try {
        const OfflineCtor = (globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext })
          .OfflineAudioContext
        if (!OfflineCtor) return 0
        const sampleRate = 44100
        const length = Math.floor(sampleRate * 0.25)
        const render = async (withCompressor: boolean) => {
          const offline = new OfflineCtor(1, length, sampleRate)
          const osc = offline.createOscillator()
          osc.type = 'sawtooth'
          osc.frequency.value = 220
          const gain = offline.createGain()
          gain.gain.value = 0.08
          osc.connect(gain)
          let tail: AudioNode = gain
          let comp: DynamicsCompressorNode | null = null
          if (withCompressor) {
            comp = offline.createDynamicsCompressor()
            comp.threshold.value = thresholdDb
            comp.ratio.value = ratio
            comp.knee.value = kneeDb
            comp.attack.value = 0.003
            comp.release.value = 0.1
            gain.connect(comp)
            tail = comp
          }
          tail.connect(offline.destination)
          osc.start(0)
          const buffer = await offline.startRendering()
          const data = buffer.getChannelData(0)
          const start = Math.floor(data.length * 0.4)
          let sum = 0
          for (let i = start; i < data.length; i += 1) sum += data[i] * data[i]
          const rms = Math.sqrt(sum / Math.max(1, data.length - start))
          return { rms, reduction: comp ? comp.reduction : 0 }
        }
        const dry = await render(false)
        const wet = await render(true)
        if (!(dry.rms > 1e-8) || !(wet.rms > 1e-8)) return 0
        const reduction = Number.isFinite(wet.reduction) ? wet.reduction : 0
        const measured = 20 * Math.log10(wet.rms / dry.rms) - reduction
        makeup = Number.isFinite(measured) ? Math.min(48, Math.max(0, measured)) : 0
        return makeup
      } catch (error) {
        console.warn('[audio] 压缩器补偿标定失败（按 0 处理）', error)
        return 0
      } finally {
        compMakeupCache.set(key, makeup)
        compMakeupPending.delete(key)
      }
    })()
    compMakeupPending.set(key, run)
    void run.then(() => reapplyMixChains())
    return run
  }

  /**
   * 把 `track.mixChain` 同步到实际音频节点（P3 / P3.1 修复）。
   *
   * 链路：dry → lowShelf → mid(peaking) → highShelf → compressor → makeup → channel。
   * - 有链且 enabled：按 EQ / 压缩参数更新；makeup 还会抵消浏览器压缩器的自动补偿
   *   （见 calibrateCompressorMakeup 的说明），否则极端 EQ 会被自动补偿抹平；
   * - 没有链或 enabled=false：全部归零（gainDb 0 / ratio 1 / threshold 0 / makeup 0dB）作为 bypass。
   *
   * 说明：采样音源（SoundFont）逐通道模式会把通道输出接到 `sfIn` → `dry`，因此同样经过本链。
   */
  const applyMixChain = (track: Track, node: TrackNode): void => {
    try {
      const chain = track.mixChain
      const bypass = !chain || chain.enabled === false
      const low = bypass ? CHAIN_NEUTRAL.lowShelf : chain.eq.lowShelf
      const mid = bypass ? CHAIN_NEUTRAL.mid : chain.eq.mid
      const high = bypass ? CHAIN_NEUTRAL.highShelf : chain.eq.highShelf
      const comp = bypass ? CHAIN_NEUTRAL.compressor : chain.compressor
      const makeupDb = bypass ? 0 : chain.makeupDb
      /* 压缩器自动补偿抵消量（标定前先 0，完成后会自动重刷） */
      let autoMakeupDb = 0
      if (!bypass) {
        const key = compMakeupKey(comp.thresholdDb, comp.ratio, comp.kneeDb)
        const cached = compMakeupCache.get(key)
        if (cached === undefined) void calibrateCompressorMakeup(comp.thresholdDb, comp.ratio, comp.kneeDb)
        else autoMakeupDb = cached
      }
      /*
       * 用 `linearRampToValueAtTime` + 绝对时间，而不是 `rampTo`/`linearRampTo`：
       * Tone 的 ramp 辅助函数会先走 `setRampPoint()`，当 dB 参数当前值正好是 0 时
       * 它会拿 `_minOutput`（1e-7）去 setValueAtTime，而压缩阈值 AudioParam 的合法范围
       * 是 [-100, 0]，于是抛 RangeError（表现为压缩参数永远不生效）。
       */
      const at = now() + CHAIN_RAMP_SEC
      node.eqLow.frequency.linearRampToValueAtTime(low.hz, at)
      node.eqLow.gain.linearRampToValueAtTime(low.gainDb, at)
      node.eqMid.frequency.linearRampToValueAtTime(mid.hz, at)
      node.eqMid.gain.linearRampToValueAtTime(mid.gainDb, at)
      node.eqMid.Q.linearRampToValueAtTime(mid.q ?? 0.9, at)
      node.eqHigh.frequency.linearRampToValueAtTime(high.hz, at)
      node.eqHigh.gain.linearRampToValueAtTime(high.gainDb, at)
      node.compressor.threshold.linearRampToValueAtTime(comp.thresholdDb, at)
      node.compressor.ratio.linearRampToValueAtTime(comp.ratio, at)
      node.compressor.attack.linearRampToValueAtTime(comp.attackSec, at)
      node.compressor.release.linearRampToValueAtTime(comp.releaseSec, at)
      node.compressor.knee.linearRampToValueAtTime(comp.kneeDb, at)
      node.makeup.gain.linearRampToValueAtTime(Tone.dbToGain(makeupDb - autoMakeupDb), at)
    } catch (error) {
      console.warn('[audio] 处理链同步失败', track.id, error)
    }
  }

  /* ------------------------------------------------------------------ */
  /* P6-A：侧链 ducking（按触发源轨包络压低目标轨 gain）                  */
  /* ------------------------------------------------------------------ */

  interface DuckState {
    analyser: AnalyserNode
    buffer: Float32Array<ArrayBuffer>
    sink: GainNode
    sourceTrackId: string
    config: DuckConfig
    currentGain: number
    lastTick: number
  }

  const duckStates = new Map<string, DuckState>()

  const disposeDuck = (trackId: string): void => {
    const state = duckStates.get(trackId)
    if (!state) return
    try {
      state.analyser.disconnect()
    } catch {
      /* ignore */
    }
    try {
      state.sink.disconnect()
    } catch {
      /* ignore */
    }
    duckStates.delete(trackId)
  }

  /** 停止/暂停时把所有 duck gain 恢复为 1（避免停在衰减态） */
  const releaseAllDucks = (): void => {
    for (const [trackId, state] of duckStates) {
      state.currentGain = 1
      state.lastTick = now()
      const node = trackNodes.get(trackId)
      if (!node) continue
      try {
        node.duckGain.gain.rampTo(1, 0.05)
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 同步 duck 路由：为每个启用 duck 的目标轨，把触发源轨的 channel 输出接一个分析器，
   * 由 `updateDucking()` 在走带 pump 里读包络并驱动目标轨的 `duckGain`。
   */
  const syncDucking = (project: Project): void => {
    const raw = nativeContext ?? (Tone.getContext().rawContext as AudioContext)
    const alive = new Set<string>()
    for (const track of project.tracks) {
      const node = trackNodes.get(track.id)
      if (!node) continue
      const duck = track.mixChain?.duck
      const source = resolveDuckSource(project, duck, track.id)
      if (!duck || duck.enabled === false || !source) {
        disposeDuck(track.id)
        try {
          node.duckGain.gain.rampTo(1, 0.05)
        } catch {
          /* ignore */
        }
        continue
      }
      alive.add(track.id)
      let state = duckStates.get(track.id)
      if (state && state.sourceTrackId !== source.id) {
        disposeDuck(track.id)
        state = undefined
      }
      if (!state) {
        const sourceNode = trackNodes.get(source.id)
        if (!sourceNode) continue
        try {
          const analyser = raw.createAnalyser()
          analyser.fftSize = 256
          analyser.smoothingTimeConstant = 0.3
          const sink = raw.createGain()
          sink.gain.value = 0
          analyser.connect(sink)
          sink.connect(raw.destination)
          Tone.connect(sourceNode.channel, analyser)
          state = {
            analyser,
            buffer: new Float32Array(analyser.fftSize),
            sink,
            sourceTrackId: source.id,
            config: duck,
            currentGain: 1,
            lastTick: now(),
          }
          duckStates.set(track.id, state)
        } catch (error) {
          console.warn('[audio] ducking 探针创建失败', error)
          continue
        }
      }
      state.config = duck
      state.lastTick = now()
    }
    for (const trackId of [...duckStates.keys()]) if (!alive.has(trackId)) disposeDuck(trackId)
  }

  /** 走带 pump 每 25ms 调用：读触发源峰值 → attack/release 平滑 → 写 duckGain */
  const updateDucking = (): void => {
    if (duckStates.size === 0) return
    const t = now()
    for (const [trackId, state] of duckStates) {
      const node = trackNodes.get(trackId)
      if (!node) continue
      let peak = 0
      try {
        state.analyser.getFloatTimeDomainData(state.buffer)
        for (let i = 0; i < state.buffer.length; i += 1) {
          const value = Math.abs(state.buffer[i])
          if (value > peak) peak = value
        }
      } catch {
        peak = 0
      }
      const amountDb = Math.min(0, Math.max(-24, state.config.amountDb))
      const target = peak > 0.02 ? Tone.dbToGain(amountDb) : 1
      const dt = Math.max(0, Math.min(0.1, t - state.lastTick))
      state.lastTick = t
      const tau =
        target < state.currentGain
          ? Math.max(0.001, state.config.attackSec)
          : Math.max(0.01, state.config.releaseSec)
      const coeff = 1 - Math.exp(-dt / tau)
      state.currentGain += (target - state.currentGain) * coeff
      try {
        node.duckGain.gain.rampTo(state.currentGain, 0.01)
      } catch {
        /* ignore */
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* P3.2：总线 / 母带处理链                                               */
  /* ------------------------------------------------------------------ */

  /** 总线链中性值（无 masterChain / enabled=false 时的 bypass 目标） */
  const MASTER_NEUTRAL = {
    eq: {
      lowShelf: { hz: 100, gainDb: 0 },
      mid: { hz: 420, gainDb: 0, q: 0.9 },
      highShelf: { hz: 10000, gainDb: 0 },
    },
    compressor: { thresholdDb: 0, ratio: 1, attackSec: 0.02, releaseSec: 0.22, kneeDb: 0 },
  } as const
  /** 现有硬限幅默认上限（无 masterChain 时保持旧行为） */
  const MASTER_DEFAULT_LIMITER_DB = -1

  /**
   * 把 `project.masterChain` 同步到总线节点：
   * mixBus → lowShelf → mid(peaking) → highShelf → compressor → makeup → masterGain。
   * - 有链且 enabled：写入 EQ / 压缩 / 补偿 / 限幅上限；压缩后抵消浏览器自动补偿（复用 P3.1 标定）；
   * - 没有链或 enabled=false：EQ 0dB、ratio 1、threshold 0、makeup 0dB、限幅回 -1（bypass）。
   */
  const applyMasterChain = (project: Project): void => {
    if (!busEqLow || !busEqMid || !busEqHigh || !busComp || !busMakeup || !limiter) return
    try {
      const chain = project.masterChain
      const enabled = Boolean(chain && chain.enabled !== false)
      const eq = enabled && chain ? chain.eq : MASTER_NEUTRAL.eq
      const comp = enabled && chain ? chain.compressor : MASTER_NEUTRAL.compressor
      const makeupDb = enabled && chain ? chain.makeupDb : 0
      /* 母线压缩同样要抵消浏览器 DynamicsCompressor 的自动补偿（标定缓存与每轨链共用） */
      let autoMakeupDb = 0
      if (enabled) {
        const key = compMakeupKey(comp.thresholdDb, comp.ratio, comp.kneeDb)
        const cached = compMakeupCache.get(key)
        if (cached === undefined) void calibrateCompressorMakeup(comp.thresholdDb, comp.ratio, comp.kneeDb)
        else autoMakeupDb = cached
      }
      busAutoMakeupDb = autoMakeupDb
      busChainEnabled = enabled
      const at = now() + CHAIN_RAMP_SEC
      busEqLow.frequency.linearRampToValueAtTime(eq.lowShelf.hz, at)
      busEqLow.gain.linearRampToValueAtTime(eq.lowShelf.gainDb, at)
      busEqMid.frequency.linearRampToValueAtTime(eq.mid.hz, at)
      busEqMid.gain.linearRampToValueAtTime(eq.mid.gainDb, at)
      busEqMid.Q.linearRampToValueAtTime(eq.mid.q ?? 0.9, at)
      busEqHigh.frequency.linearRampToValueAtTime(eq.highShelf.hz, at)
      busEqHigh.gain.linearRampToValueAtTime(eq.highShelf.gainDb, at)
      busComp.threshold.linearRampToValueAtTime(comp.thresholdDb, at)
      busComp.ratio.linearRampToValueAtTime(comp.ratio, at)
      busComp.attack.linearRampToValueAtTime(comp.attackSec, at)
      busComp.release.linearRampToValueAtTime(comp.releaseSec, at)
      busComp.knee.linearRampToValueAtTime(comp.kneeDb, at)
      busMakeup.gain.linearRampToValueAtTime(Tone.dbToGain(makeupDb - autoMakeupDb), at)
      const ceiling = enabled && chain ? clamp(chain.limiterCeilingDb, -6, 0) : MASTER_DEFAULT_LIMITER_DB
      limiter.threshold.linearRampToValueAtTime(ceiling, at)

      /* P6-A：三段总线压缩（multiband）—— 关闭时走 mbBypass，节点常驻避免断连爆音 */
      if (mbInput && mbBypass && mbSum && mbLowComp && mbMidComp && mbHighComp) {
        const mbRaw = enabled ? getMultiband(project) : null
        const mb = mbRaw && mbRaw.enabled !== false ? mbRaw : null
        mbEnabledState = Boolean(mb)
        mbInput.gain.linearRampToValueAtTime(mb ? 1 : 0, at)
        mbBypass.gain.linearRampToValueAtTime(mb ? 0 : 1, at)
        const [crossLow, crossHigh] = mb?.crossoverHz ?? [200, 3000]
        if (mbLowFilter) mbLowFilter.frequency.linearRampToValueAtTime(crossLow, at)
        if (mbMidHighpass) mbMidHighpass.frequency.linearRampToValueAtTime(crossLow, at)
        if (mbMidLowpass) mbMidLowpass.frequency.linearRampToValueAtTime(crossHigh, at)
        if (mbHighFilter) mbHighFilter.frequency.linearRampToValueAtTime(crossHigh, at)
        const bands: { key: 'low' | 'mid' | 'high'; params: { thresholdDb: number; ratio: number; attackSec: number; releaseSec: number } | null; comp: Tone.Compressor; makeup: Tone.Gain | null }[] = [
          { key: 'low', params: mb ? mb.low : null, comp: mbLowComp, makeup: mbLowMakeup },
          { key: 'mid', params: mb ? mb.mid : null, comp: mbMidComp, makeup: mbMidMakeup },
          { key: 'high', params: mb ? mb.high : null, comp: mbHighComp, makeup: mbHighMakeup },
        ]
        for (const band of bands) {
          const params = band.params ?? {
            thresholdDb: 0,
            ratio: 1,
            attackSec: band.key === 'low' ? 0.02 : band.key === 'mid' ? 0.012 : 0.008,
            releaseSec: band.key === 'low' ? 0.2 : band.key === 'mid' ? 0.16 : 0.12,
          }
          let bandAuto = 0
          if (band.params) {
            const key = compMakeupKey(params.thresholdDb, params.ratio, 0)
            const cached = compMakeupCache.get(key)
            if (cached === undefined) void calibrateCompressorMakeup(params.thresholdDb, params.ratio, 0)
            else bandAuto = cached
          }
          mbAutoMakeupDb = { ...mbAutoMakeupDb, [band.key]: bandAuto }
          band.comp.threshold.linearRampToValueAtTime(params.thresholdDb, at)
          band.comp.ratio.linearRampToValueAtTime(params.ratio, at)
          band.comp.attack.linearRampToValueAtTime(params.attackSec, at)
          band.comp.release.linearRampToValueAtTime(params.releaseSec, at)
          try {
            band.makeup?.gain.linearRampToValueAtTime(Tone.dbToGain(-bandAuto), at)
          } catch {
            /* ignore */
          }
        }
      }
    } catch (error) {
      console.warn('[audio] 总线处理链同步失败', error)
    }
  }

  const applyMix = (track: Track, node: TrackNode, audible: boolean) => {
    const emotion = getEmotion(track.instrumentId, track.emotionId).params
    const instrument = getInstrument(track.instrumentId)
    /*
     * 静音 / 独奏走独立的 muteGain（0.02s 过渡），不再用 `channel.mute`：
     * - `Channel.mute` 是硬切推子（瞬间 -Infinity），会有咔哒声；
     * - 它和下一行的 `volume.rampTo()` 抢同一个参数，先 mute 会被 ramp 撤销，
     *   M / S 于是表现为「按了没用」（Tone 的 setRampPoint 还会把 -Infinity 换成 1e-7）。
     * muteGain 在 send 抽头上游，静音同时掐掉混响 / 延迟尾巴。
     */
    node.muteGain.gain.rampTo(audible ? 1 : 0, 0.02)
    node.channel.mute = false
    node.channel.volume.rampTo(Tone.gainToDb(Math.max(0.0005, track.volume)), 0.06)
    node.channel.pan.rampTo(clamp(track.pan, -1, 1), 0.06)
    node.widener.width.rampTo(clamp(emotion.stereoWidth, 0, 1), 0.1)
    /*
     * send 也必须跟着可听性归零：
     * 合成器 voice 是**前置**直连 send 的（见 attachVoice，为了绕开 dry 的处理链），
     * 它不经过 muteGain，所以只关 muteGain 的话静音轨仍会从混响 / 延迟里漏出尾巴。
     */
    node.sendReverb.gain.rampTo(audible ? reverbAmount(track, emotion.reverb) : 0, 0.1)
    node.sendDelay.gain.rampTo(audible ? delayAmount(track, emotion.delay) : 0, 0.1)
    node.sendChorus.gain.rampTo(
      audible ? chorusAmount(track, emotion.chorus, instrument.synth.fx.chorus) : 0,
      0.1,
    )

    /* P3：音色/动态处理链与推子参数在同一处同步（0.05–0.1s 过渡，避免爆音） */
    applyMixChain(track, node)

    if (node.route === 'soundfont') {
      const channel = soundfont.channelFor(track.id)
      if (channel != null) {
        soundfont.setProgram(track.id, track.gmProgram || instrument.gmProgram, instrument.isDrumKit || track.kind === 'drum')
        soundfont.applyChannelMix(
          track.id,
          {
            volume: track.volume,
            pan: track.pan,
            reverb: reverbAmount(track, emotion.reverb),
            chorus: chorusAmount(track, emotion.chorus, instrument.synth.fx.chorus),
            brightness: emotion.brightness,
            modulation: emotion.vibrato * 0.9,
            muted: !audible,
          },
          /* 逐通道路由时 CC 只保留音色型参数（音量/声像交给节点链） */
          { perChannelRouting: soundfontRouting.mode === 'per-channel' },
        )
      }
    }
  }

  const applyProjectInternal = (project: Project) => {
    currentProject = project
    if (!initialized) return
    ensureGraph()
    /* P3.2：总线/母带链参数同步（在任何声音进来之前先写好，避免首帧未处理） */
    applyMasterChain(project)

    /* 静音 / 独奏判定抽成纯函数（lib/trackRules），界面与单测共用同一份语义 */
    const audible = computeAudibleTrackIds(project.tracks)

    /* 先释放已经不存在的音频片段 Player：它们的输出还连着即将被销毁的轨道节点 */
    pruneAudioPlayback(project)

    // 清理已经删除的轨道
    for (const [id, node] of [...trackNodes.entries()]) {
      if (!project.tracks.some((track) => track.id === id)) {
        disposeTrackNode(node)
        trackNodes.delete(id)
        const fallback = fallbackPreview.get(id)
        if (fallback) {
          try {
            fallback.voice.dispose()
            fallback.gain.dispose()
          } catch {
            /* ignore */
          }
          fallbackPreview.delete(id)
        }
        auditionHeld.delete(id)
        soundfont.releaseChannel(id)
      }
    }

    trackRuntime = new Map()
    for (const track of project.tracks) {
      const instrument = getInstrument(track.instrumentId)
      const emotion = getEmotion(track.instrumentId, track.emotionId).params
      const isDrum = track.kind === 'drum' || instrument.isDrumKit
      const route: TrackRoute = shouldUseSoundfont(track) ? 'soundfont' : 'synth'

      const node = ensureTrackNode(track)
      if (track.kind === 'audio') {
        /*
         * 音频轨：轨道节点只当混音通道用（音量 / 声像 / 静音 / 发送），
         * 片段声音由 audioPlayers 直接送进 node.dry；不建 MIDI 音色，避免白占 CPU。
         */
        soundfont.releaseChannel(track.id)
        detachSoundfontTap(node)
        if (node.voice) {
          try {
            node.voice.allNotesOff()
            node.voice.dispose()
          } catch {
            /* ignore */
          }
          node.voice = null
          node.voiceKey = ''
        }
        node.route = 'synth'
      } else if (route === 'soundfont') {
        const channel = soundfont.assignChannel(track.id, isDrum)
        if (channel == null) {
          // 采样器不可用（还未 ready / 通道分配失败）=> 回退合成器
          rebuildVoice(track, node, 'synth')
          detachSoundfontTap(node)
        } else {
          rebuildVoice(track, node, 'soundfont')
          soundfont.setProgram(track.id, track.gmProgram || instrument.gmProgram, isDrum)
          // 逐轨电平：接该通道的可视化输出（旁路，只用于读数）
          attachSoundfontTap(track.id, channel)
        }
      } else {
        rebuildVoice(track, node, 'synth')
        soundfont.releaseChannel(track.id)
        detachSoundfontTap(node)
      }
      applyMix(track, node, audible.has(track.id))
      trackRuntime.set(track.id, { route: node.route, emotion, isDrum })
    }

    /* P3.1：轨道同步完成后重算 SoundFont 输出路由（切轨/删轨/换音色库/通道重分配都会走到） */
    routeSoundfontChannels(project, audible)
    /* P6-A：侧链 ducking 探针随工程变化重建（目标轨/触发源/参数） */
    syncDucking(project)

    rebuildNoteIndex(project)

    scheduler.endBeat = Math.max(1, projectEndBeat(project))
    scheduler.secPerBeat = 60 / Math.max(20, project.tempo)
    if (isPlaying) {
      // 保持当前播放位置，热切换后继续走
      const pos = positionAt(now())
      scheduler.startPosition = pos
      scheduler.startContextTime = now()
      /*
       * 只允许「向前补排」，不允许回退：
       * 已经排进 look-ahead（160ms）的音符是直接交给合成器的，若把 scheduledPosition
       * 拨回当前位置，下一个 pump 会把同一批音符**再排一次**（表现为每次改静音/独奏都有一记重音）。
       * 位置是绝对拍坐标，换映射后依然有效，所以取两者较大值即可。
       */
      scheduler.scheduledPosition = Math.max(pos, scheduler.scheduledPosition)
    }
    // 延迟总线跟随速度（八分音符）
    if (delayBus) {
      try {
        delayBus.delayTime.rampTo(Math.max(0.05, scheduler.secPerBeat * 0.75), 0.1)
      } catch {
        /* ignore */
      }
    }

    // 音频片段与走带同步（play / seek / 播放中工程变化都复用同一套排期）
    syncAudioPlayback(project)
  }

  /* ------------------------------------------------------------------ */
  /* 位置 <-> 拍 映射（数学部分在 timeline.ts，纯函数便于测试）             */
  /* ------------------------------------------------------------------ */

  const mapping = (): TimelineMapping => ({
    startContextTime: scheduler.startContextTime,
    startPosition: scheduler.startPosition,
    secPerBeat: scheduler.secPerBeat,
    loop: scheduler.loop,
  })

  const positionAt = (contextTime: number) => timelinePositionAt(mapping(), contextTime)
  const contextTimeAtPosition = (position: number) => timelineContextTimeAtPosition(mapping(), position)
  const beatAtPosition = (position: number) => timelineBeatAtPosition(mapping(), position)

  /* ------------------------------------------------------------------ */
  /* 音符调度                                                            */
  /* ------------------------------------------------------------------ */

  const scheduleNote = (note: FlatNote, time: number) => {
    const runtime = trackRuntime.get(note.trackId)
    if (!runtime) return
    scheduledNoteCount += 1
    lastScheduledAt = time
    const node = trackNodes.get(note.trackId)
    if (!node) return
    const at = Math.max(time, now() + 0.002)
    const durSec = note.durationBeats * scheduler.secPerBeat

    if (runtime.route === 'soundfont') {
      const channel = soundfont.channelFor(note.trackId)
      if (channel == null) return
      const gated = runtime.isDrum ? durSec : noteDurationFor(runtime.emotion.articulation, durSec)
      const started = soundfont.noteOn(note.trackId, note.pitch, note.velocity, at)
      if (started) soundfont.noteOff(note.trackId, note.pitch, at + Math.max(0.03, gated))
      return
    }

    if (node.voice) {
      // 合成器音色自己按演奏法收窄发声时长（见 synth.ts 的 noteDurationFor）
      node.voice.noteOn(at, note.pitch, note.velocity / 127, durSec)
    }
  }

  const scheduleWindow = (fromPos: number, toPos: number) => {
    for (const segment of timelineBeatSegments(mapping(), fromPos, toPos)) {
      const { beatFrom, beatTo, positionFrom: posFrom } = segment
      // 二分查找窗口内的音符
      let low = 0
      let high = flatNotes.length
      while (low < high) {
        const mid = (low + high) >> 1
        if (flatNotes[mid].beat < beatFrom) low = mid + 1
        else high = mid
      }
      for (let i = low; i < flatNotes.length; i++) {
        const note = flatNotes[i]
        if (note.beat >= beatTo) break
        const pos = posFrom + (note.beat - beatFrom)
        scheduleNote(note, contextTimeAtPosition(pos))
      }

      // 节拍器（整拍）
      if (metronome && metronomeSynth) {
        const barBeats = beatsPerBar(currentProject?.timeSignature ?? { numerator: 4, denominator: 4 })
        const firstBeat = Math.ceil(beatFrom - 1e-6)
        for (let beat = firstBeat; beat < beatTo; beat++) {
          const pos = posFrom + (beat - beatFrom)
          const at = Math.max(contextTimeAtPosition(pos), now() + 0.002)
          const accent = Math.abs(beat % barBeats) < 1e-6
          try {
            metronomeSynth.triggerAttackRelease(accent ? 'C6' : 'C5', 0.03, at, accent ? 0.7 : 0.35)
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  const pump = () => {
    if (!isPlaying) return
    const t = now()
    const horizonTime = Math.max(scheduler.startContextTime, t) + LOOK_AHEAD_SEC
    let horizonPos = positionAt(horizonTime)
    // 长时间被节流后：丢掉过期音符，只补最后 0.3 秒，避免「一次性爆音」
    const gapSec = (horizonPos - scheduler.scheduledPosition) * scheduler.secPerBeat
    if (gapSec > MAX_CATCH_UP_SEC) {
      horizonPos = scheduler.scheduledPosition + (MAX_CATCH_UP_SEC * 0.8) / scheduler.secPerBeat
    }
    if (horizonPos > scheduler.scheduledPosition) {
      scheduleWindow(scheduler.scheduledPosition, horizonPos)
      scheduler.scheduledPosition = horizonPos
    }
    // 循环时提前一整圈排音频，保证循环边界处音频不断
    pumpAudio()
    // P6-A：侧链 ducking 包络跟随（只在走带中更新；暂停/停止会恢复增益 1）
    updateDucking()
  }

  /* ------------------------------------------------------------------ */
  /* 播放头 / 电平 / 结束检测                                             */
  /* ------------------------------------------------------------------ */

  const emitPlayhead = (beat: number) => {
    for (const handler of playheadHandlers) {
      try {
        handler(beat)
      } catch {
        /* ignore */
      }
    }
  }

  const currentBeat = (): number => {
    if (!isPlaying) return lastPosition
    const pos = positionAt(now())
    const beat = beatAtPosition(pos)
    return clamp(beat, 0, scheduler.endBeat)
  }

  const finishPlayback = (endBeat: number) => {
    releaseAllVoices()
    stopClock()
    isPlaying = false
    resetAudioSchedule()
    releaseAllDucks()
    lastPosition = clamp(endBeat, 0, scheduler.endBeat)
    emitPlayhead(lastPosition)
  }

  const rafLoop = () => {
    if (rafId != null) return
    const tick = () => {
      if (!isPlaying) {
        rafId = null
        return
      }
      const t = now()
      const pos = positionAt(t)
      const beat = beatAtPosition(pos)
      if (!scheduler.loop && pos >= scheduler.endBeat) {
        finishPlayback(scheduler.endBeat)
        return
      }
      emitPlayhead(clamp(beat, 0, scheduler.endBeat))
      if (t - lastLevelEmit > 0.08) {
        lastLevelEmit = t
        const level = readMeter()
        for (const handler of levelHandlers) {
          try {
            handler(level)
          } catch {
            /* ignore */
          }
        }
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
  }

  const readMeter = (): number => {
    if (!meter) return 0
    try {
      const value = meter.getValue()
      const db = typeof value === 'number' ? value : value[0]
      return clamp((db + 60) / 60, 0, 1)
    } catch {
      return 0
    }
  }

  function releaseAllVoices() {
    for (const node of trackNodes.values()) {
      try {
        node.voice?.allNotesOff()
      } catch {
        /* ignore */
      }
    }
    stopAudition()
    soundfont.panic()
  }

  const startClock = () => {
    stopClock()
    scheduler.timer = setInterval(() => {
      try {
        pump()
      } catch (error) {
        console.warn('[audio] 调度异常', error)
      }
    }, TICK_MS)
    rafLoop()
  }

  function stopClock() {
    if (scheduler.timer) clearInterval(scheduler.timer)
    scheduler.timer = null
    if (rafId != null) cancelAnimationFrame(rafId)
    rafId = null
  }

  /* ------------------------------------------------------------------ */
  /* 预听                                                                */
  /* ------------------------------------------------------------------ */

  type AuditionTarget =
    | { kind: 'synth'; voice: InstrumentVoice }
    | { kind: 'soundfont'; trackId: string }

  /**
   * 试听（钢琴卷帘点音符 / 乐器选择器试听 / MIDI 键盘）必须和「播放这一轨」用同一套音色与混音，
   * 否则会出现「MIDI 弹出来的声音和聚焦轨道的乐器不一致」：
   * - 合成器路由：直接用这条轨道正在发声的 InstrumentVoice（情绪、滤波、效果发送全部一致）
   * - 采样路由：直接用这条轨道的 SoundFont 通道（GM program 已按轨道设置好）
   * - 轨道节点还没建立（页面刚打开就按键）：用同乐器 + 同情绪临时建一个兜底 voice
   */
  const fallbackVoiceFor = (track: Track): InstrumentVoice => {
    const key = `${track.instrumentId}:${track.emotionId}`
    const existing = fallbackPreview.get(track.id)
    if (existing && existing.key === key) return existing.voice
    if (existing) {
      try {
        existing.voice.dispose()
        existing.gain.dispose()
      } catch {
        /* ignore */
      }
      fallbackPreview.delete(track.id)
    }
    const instrument = getInstrument(track.instrumentId)
    const emotion = getEmotion(track.instrumentId, track.emotionId).params
    const voice = createInstrumentVoice(instrument, emotion)
    const gain = new Tone.Gain(0.8)
    voice.output.connect(gain)
    gain.connect((mixBus ?? masterGain) as Tone.Gain)
    fallbackPreview.set(track.id, { key, voice, gain })
    return voice
  }

  const auditionTargetFor = (track: Track): AuditionTarget => {
    ensureGraph()
    const node = trackNodes.get(track.id)
    if (node) {
      if (node.route === 'soundfont' && soundfont.channelFor(track.id) != null) {
        return { kind: 'soundfont', trackId: track.id }
      }
      if (node.voice) return { kind: 'synth', voice: node.voice }
    }
    return { kind: 'synth', voice: fallbackVoiceFor(track) }
  }

  /** 试听也遵守轨道八度偏移，保证与播放音高一致 */
  const auditionPitch = (track: Track, pitch: number) => clamp(Math.round(pitch + track.octaveShift * 12), 0, 127)

  /**
   * 触发一个试听音符。`durationSec <= 0` 表示按住不放（MIDI 键盘），需要 auditionNoteOff 释放。
   */
  const auditionNote = (
    track: Track,
    pitch: number,
    velocity: number,
    durationSec: number,
    atTime?: number,
  ): void => {
    try {
      const target = auditionTargetFor(track)
      const shifted = auditionPitch(track, pitch)
      const vel127 = clamp(Math.round(velocity), 1, 127)
      const time = atTime ?? now() + 0.005
      if (target.kind === 'soundfont') {
        const started = soundfont.noteOn(target.trackId, shifted, vel127, Math.max(time, now()))
        if (started && durationSec > 0) {
          soundfont.noteOff(target.trackId, shifted, Math.max(time, now()) + Math.max(0.03, durationSec))
        }
        lastAudition = {
          trackId: track.id,
          kind: 'soundfont',
          detail: `${track.instrumentId}/${track.emotionId} · GM ${track.gmProgram} · ch${soundfont.channelFor(track.id) ?? '?'}`,
          at: Date.now(),
        }
      } else {
        target.voice.noteOn(time, shifted, vel127 / 127, durationSec)
        lastAudition = {
          trackId: track.id,
          kind: 'synth',
          detail: `${track.instrumentId}/${track.emotionId}`,
          at: Date.now(),
        }
      }
      if (durationSec <= 0) {
        const held = auditionHeld.get(track.id) ?? new Set<number>()
        held.add(shifted)
        auditionHeld.set(track.id, held)
      }
    } catch (error) {
      console.warn('[audio] 试听失败', error)
    }
  }

  const auditionNoteOff = (track: Track, pitch: number): void => {
    try {
      const target = auditionTargetFor(track)
      const shifted = auditionPitch(track, pitch)
      if (target.kind === 'soundfont') soundfont.noteOff(target.trackId, shifted, now())
      else target.voice.noteOff(now(), shifted)
      auditionHeld.get(track.id)?.delete(shifted)
    } catch {
      /* ignore */
    }
  }

  /** 释放所有被按住的试听音 + 兜底音色 */
  const stopAudition = () => {
    for (const [trackId, pitches] of auditionHeld) {
      if (pitches.size === 0) continue
      const track = currentProject?.tracks.find((item) => item.id === trackId)
      if (track) {
        const target = auditionTargetFor(track)
        for (const shifted of pitches) {
          try {
            if (target.kind === 'soundfont') soundfont.noteOff(trackId, shifted, now())
            else target.voice.noteOff(now(), shifted)
          } catch {
            /* ignore */
          }
        }
      }
      pitches.clear()
    }
    auditionHeld.clear()
    for (const entry of fallbackPreview.values()) {
      try {
        entry.voice.allNotesOff()
      } catch {
        /* ignore */
      }
    }
  }

  const stopPreviewInternal = () => {
    if (previewState?.timer) clearInterval(previewState.timer)
    previewState = null
    stopAudition()
  }

  /* ------------------------------------------------------------------ */
  /* API                                                                 */
  /* ------------------------------------------------------------------ */

  const engine: AudioEngine = {
    get ready() {
      return initialized
    },
    get playing() {
      return isPlaying
    },

    async init() {
      if (initialized) return
      // 关键：Tone v15 默认把 AudioContext 包一层 standardized-audio-context，
      // 而 spessasynth_lib 的 AudioWorklet 需要**原生** BaseAudioContext
      // （它直接用原生 AudioWorkletNode 构造器创建 18 输出的节点）。
      // 因此这里自己建原生 AudioContext 并设为 Tone 的全局上下文，
      // 让合成器与采样器共用同一个时钟、同一个输出总线。
      if (!nativeContext) {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!Ctor) throw new Error('当前浏览器不支持 Web Audio API')
        nativeContext = new Ctor({ latencyHint: 'interactive' })
        Tone.setContext(new Tone.Context(nativeContext))
      }
      await Tone.start()
      ensureGraph()
      initialized = true
      soundfont.configure(nativeContext, sfNative as GainNode)
      // 开箱体验：后台自动探测服务端音色库并加载（失败静默回退合成器，不阻塞 init）
      void soundfont.autoLoad()
      // 后端可能比前端晚几秒就绪：6 秒后再补一次（已加载 / 已被用户关闭则自动跳过）
      setTimeout(() => {
        if (initialized && !soundfont.loaded) void soundfont.autoLoad()
      }, 6000)
      midi
        .init()
        .then(() => {
          if (midi.activeId) midi.select(midi.activeId)
        })
        .catch(() => undefined)
      if (currentProject) applyProjectInternal(currentProject)
    },

    dispose() {
      stopPreviewInternal()
      stopClock()
      isPlaying = false
      // 音频片段：先停声 + 释放 Player / 解码缓存，再拆总线
      stopAudioPlayers()
      for (const clipId of [...audioPlayers.keys()]) disposeAudioPlayer(clipId)
      for (const entry of audioBuffers.values()) {
        try {
          entry.buffer?.dispose()
        } catch {
          /* ignore */
        }
      }
      audioBuffers.clear()
      audioArmedPasses = new Set()
      audioSignature = ''
      for (const node of trackNodes.values()) disposeTrackNode(node)
      trackNodes.clear()
      for (const entry of fallbackPreview.values()) {
        try {
          entry.voice.dispose()
          entry.gain.dispose()
        } catch {
          /* ignore */
        }
      }
      fallbackPreview.clear()
      auditionHeld.clear()
      midi.dispose()
      /* P3.1：逐通道路由随合成器/轨道节点一起失效，清空本地记录 */
      soundfontRouting.routes.clear()
      soundfontRouting.mode = 'none'
      soundfontRouting.mainOutput = true
      soundfont.destroy()
      /* P6-A：释放侧链 ducking 探针 */
      for (const [trackId] of [...duckStates]) disposeDuck(trackId)
      for (const target of [
        meterSink,
        reverbBus,
        delayBus,
        chorusBus,
        metronomeSynth,
        busEqLow,
        busEqMid,
        busEqHigh,
        mbInput,
        mbBypass,
        mbSum,
        mbLowFilter,
        mbLowComp,
        mbLowMakeup,
        mbMidHighpass,
        mbMidLowpass,
        mbMidComp,
        mbMidMakeup,
        mbHighFilter,
        mbHighComp,
        mbHighMakeup,
        busComp,
        busMakeup,
        mixBus,
        masterGain,
        limiter,
        meter,
      ]) {
        try {
          target?.dispose()
        } catch {
          /* ignore */
        }
      }
      meterSink = null
      reverbBus = null
      delayBus = null
      chorusBus = null
      metronomeSynth = null
      busEqLow = null
      busEqMid = null
      busEqHigh = null
      busComp = null
      busMakeup = null
      mbInput = null
      mbBypass = null
      mbSum = null
      mbLowFilter = null
      mbLowComp = null
      mbLowMakeup = null
      mbMidHighpass = null
      mbMidLowpass = null
      mbMidComp = null
      mbMidMakeup = null
      mbHighFilter = null
      mbHighComp = null
      mbHighMakeup = null
      mbEnabledState = false
      mbAutoMakeupDb = { low: 0, mid: 0, high: 0 }
      busAutoMakeupDb = 0
      busChainEnabled = false
      mixBus = null
      masterGain = null
      limiter = null
      meter = null
      sfNative = null
      if (nativeContext) {
        void nativeContext.close().catch(() => undefined)
        nativeContext = null
      }
      initialized = false
    },

    applyProject(project) {
      applyProjectInternal(project)
    },

    async play(project, options: PlayOptions = {}) {
      await engine.init()
      applyProjectInternal(project)

      const loopOption = options.loop ?? (project.loop?.enabled ? project.loop : null)
      const loop: SchedulerLoop | null =
        loopOption && loopOption.endBeat > loopOption.startBeat
          ? { startBeat: Math.max(0, loopOption.startBeat), endBeat: loopOption.endBeat }
          : null

      const fromBeat = normalizeStartBeat(options.fromBeat ?? lastPosition, loop, scheduler.endBeat)

      const secPerBeat = 60 / Math.max(20, project.tempo)
      const countInBeats = options.countIn ? beatsPerBar(project.timeSignature) : 0
      const startDelay = 0.06 + countInBeats * secPerBeat

      stopPreviewInternal()
      releaseAllVoices()
      scheduler.secPerBeat = secPerBeat
      scheduler.loop = loop
      scheduler.startPosition = fromBeat
      scheduler.startContextTime = now() + startDelay
      scheduler.scheduledPosition = fromBeat
      scheduler.position = fromBeat
      scheduler.countInEndsAt = scheduler.startContextTime
      scheduler.endBeat = Math.max(1, projectEndBeat(project))

      // 预备拍（count-in）：单独排一小时的 click
      if (countInBeats > 0 && metronomeSynth) {
        const barBeats = beatsPerBar(project.timeSignature)
        for (let i = 0; i < countInBeats; i++) {
          const at = now() + 0.06 + i * secPerBeat
          try {
            metronomeSynth.triggerAttackRelease(i % barBeats === 0 ? 'C6' : 'C5', 0.03, at, i % barBeats === 0 ? 0.7 : 0.35)
          } catch {
            /* ignore */
          }
        }
      }

      // 音频片段：先把 WAV 缓冲拉齐（此时还没开始走带），再与走带起点对齐排期。
      // 循环 / seek / 播放中工程变化的重排都走同一个 armAudioPlayback。
      await preloadAudioAssets(project).catch(() => undefined)
      isPlaying = true
      lastPosition = fromBeat
      armAudioPlayback()
      startClock()
      emitPlayhead(fromBeat)
    },

    pause() {
      if (!isPlaying) return
      const beat = currentBeat()
      releaseAllVoices()
      stopClock()
      isPlaying = false
      resetAudioSchedule()
      releaseAllDucks()
      lastPosition = clamp(beat, 0, scheduler.endBeat)
      emitPlayhead(lastPosition)
    },

    stop() {
      stopPreviewInternal()
      releaseAllVoices()
      stopClock()
      isPlaying = false
      resetAudioSchedule()
      releaseAllDucks()
      lastPosition = 0
      scheduler.position = 0
      scheduler.scheduledPosition = 0
      emitPlayhead(0)
    },

    seek(beat) {
      const target = clamp(beat, 0, scheduler.endBeat || beat)
      lastPosition = target
      if (isPlaying) {
        releaseAllVoices()
        const t = now()
        scheduler.startPosition = target
        scheduler.startContextTime = t
        scheduler.scheduledPosition = target
        /* 关键：seek 后音频必须按新位置重新排期（Tone.Player 的 start 时间是绝对 AudioContext 时间） */
        armAudioPlayback()
      }
      emitPlayhead(target)
    },

    playheadBeat() {
      return currentBeat()
    },

    previewNote(track, pitch, velocity = 100, durationSec = 0.45) {
      // 关键：走「轨道真实发声链」，换乐器 / 换情绪 / 采样音源后立刻一致
      const trigger = () => auditionNote(track, pitch, velocity, Math.max(0.05, durationSec))
      if (!initialized) {
        void engine.init().then(trigger).catch(() => undefined)
      } else {
        trigger()
      }
    },

    previewClip(track, clip) {
      const start = () => {
        try {
          ensureGraph()
          stopPreviewInternal()
          const tempo = currentProject?.tempo ?? 120
          const secPerBeat = 60 / Math.max(20, tempo)
          const notes: FlatNote[] = clip.notes
            .map((note) => ({
              beat: note.start,
              // 八度偏移交由 auditionNote 统一处理，避免重复偏移
              pitch: clamp(Math.round(note.pitch), 0, 127),
              velocity: clamp(Math.round(note.velocity), 1, 127),
              durationBeats: Math.max(0.02, note.duration),
              trackId: track.id,
            }))
            .sort((a, b) => a.beat - b.beat)
          const startTime = now() + 0.08
          const endTime = startTime + Math.max(clip.lengthBeats, notes[notes.length - 1]?.beat ?? 0) * secPerBeat + 1.2
          const state: PreviewState = {
            timer: null,
            notes,
            nextIndex: 0,
            startContextTime: startTime,
            secPerBeat,
            endContextTime: endTime,
            trackId: track.id,
          }
          const instrument = getInstrument(track.instrumentId)
          const isDrum = track.kind === 'drum' || instrument.isDrumKit
          const emotion = getEmotion(track.instrumentId, track.emotionId).params
          const pumpPreview = () => {
            const t = now()
            const horizon = t + 0.2
            while (state.nextIndex < notes.length) {
              const note = notes[state.nextIndex]
              const at = state.startContextTime + note.beat * secPerBeat
              if (at > horizon) break
              state.nextIndex++
              if (at < t - 0.05) continue
              const durSec = note.durationBeats * secPerBeat
              auditionNote(
                track,
                note.pitch,
                note.velocity,
                isDrum ? durSec : noteDurationFor(emotion.articulation, durSec),
                Math.max(at, t + 0.002),
              )
            }
            if (t > state.endContextTime) {
              stopPreviewInternal()
            }
          }
          previewState = state
          pumpPreview()
          state.timer = setInterval(pumpPreview, 40)
        } catch (error) {
          console.warn('[audio] 片段预听失败', error)
        }
      }
      if (!initialized) {
        void engine.init().then(start).catch(() => undefined)
      } else {
        start()
      }
    },

    stopPreview() {
      stopPreviewInternal()
    },

    midiNoteOn(track, pitch, velocity) {
      const trigger = () => auditionNote(track, pitch, velocity, -1)
      if (!initialized) void engine.init().then(trigger).catch(() => undefined)
      else trigger()
    },

    midiNoteOff(track, pitch) {
      auditionNoteOff(track, pitch)
    },

    debugState() {
      return {
        initialized,
        scheduler: {
          isPlaying,
          noteCount: flatNotes.length,
          scheduledNoteCount,
          lastScheduledAt,
          startContextTime: scheduler.startContextTime,
          scheduledPosition: scheduler.scheduledPosition,
          position: scheduler.position,
          endBeat: scheduler.endBeat,
          secPerBeat: scheduler.secPerBeat,
          now: now(),
          runtimeTracks: trackRuntime.size,
        },
        contextState: nativeContext?.state ?? 'none',
        masterLevel: readMeter(),
        lastAudition,
        tracks: [...trackNodes.entries()].map(([id, node]) => {
          const track = currentProject?.tracks.find((item) => item.id === id)
          return {
            id,
            instrumentId: track?.instrumentId ?? '',
            emotionId: track?.emotionId ?? '',
            route: node.route,
            voiceKey: node.voiceKey,
            hasVoice: Boolean(node.voice),
            soundfontChannel: node.sfChannel,
            level: readTrackLevel(node),
          }
        }),
      }
    },

    setMetronome(on) {
      metronome = on
    },

    setMasterVolume(volume) {
      if (!initialized) return
      ensureGraph()
      masterGain?.gain.rampTo(clamp(volume, 0, 1.5), 0.05)
    },

    getMeterLevel() {
      return readMeter()
    },

    /**
     * 每轨实时电平（0..1，由 dB 映射；0 = 静音或 -∞）。
     * 合成器路由读 widener 之后的旁路 Tone.Meter；
     * 采样音源路由读该轨 MIDI 通道的可视化输出。两者都是真实音频读数。
     */
    getTrackLevels() {
      const levels: Record<string, number> = {}
      if (!initialized) return levels
      for (const [trackId, node] of trackNodes) {
        levels[trackId] = readTrackLevel(node)
      }
      return levels
    },

    /**
     * 调试（P3 真机验收）：返回某轨处理链**实际节点上的数值**。
     * 读的是 Tone Signal/Param 的 `.value`（ramp 过程中是中间值），
     * 因此调用方应等 0.1–0.2s 过渡结束后再断言。
     * 轨道不存在 / 引擎未初始化时返回 null。
     */
    __debugChain(trackId) {
      const node = trackNodes.get(trackId)
      if (!node) return null
      const chain = currentProject?.tracks.find((track) => track.id === trackId)?.mixChain
      const makeupGain = Number(node.makeup.gain.value)
      const makeupDbRaw = Tone.gainToDb(makeupGain)
      return {
        enabled: Boolean(chain && chain.enabled !== false),
        lowShelf: {
          hz: Number(node.eqLow.frequency.value),
          gainDb: Number(node.eqLow.gain.value),
        },
        mid: {
          hz: Number(node.eqMid.frequency.value),
          gainDb: Number(node.eqMid.gain.value),
          q: Number(node.eqMid.Q.value),
        },
        highShelf: {
          hz: Number(node.eqHigh.frequency.value),
          gainDb: Number(node.eqHigh.gain.value),
        },
        compressor: {
          thresholdDb: Number(node.compressor.threshold.value),
          ratio: Number(node.compressor.ratio.value),
          attackSec: Number(node.compressor.attack.value),
          releaseSec: Number(node.compressor.release.value),
        },
        /* 补偿增益是线性 Gain，转回 dB；0 增益时给一个有限下界，避免 -Infinity 进 JSON */
        makeupDb: Number.isFinite(makeupDbRaw) ? makeupDbRaw : -120,
      }
    },

    /**
     * 调试（P3.2 真机验收）：总线 / 母带处理链的**真实节点值**。
     * 读的是 Tone Signal/Param 的 `.value`（ramp 进行中为中间值，断言前等 ~0.2s）。
     * `autoMakeupCompDb` 是当前为抵消浏览器 DynamicsCompressor 自动补偿而减去的 dB。
     */
    __debugMasterChain() {
      if (!busEqLow || !busEqMid || !busEqHigh || !busComp || !busMakeup || !limiter) return null
      const makeupDbRaw = Tone.gainToDb(Number(busMakeup.gain.value))
      return {
        enabled: busChainEnabled,
        lowShelf: {
          hz: Number(busEqLow.frequency.value),
          gainDb: Number(busEqLow.gain.value),
        },
        mid: {
          hz: Number(busEqMid.frequency.value),
          gainDb: Number(busEqMid.gain.value),
          q: Number(busEqMid.Q.value),
        },
        highShelf: {
          hz: Number(busEqHigh.frequency.value),
          gainDb: Number(busEqHigh.gain.value),
        },
        compressor: {
          thresholdDb: Number(busComp.threshold.value),
          ratio: Number(busComp.ratio.value),
          attackSec: Number(busComp.attack.value),
          releaseSec: Number(busComp.release.value),
        },
        makeupDb: Number.isFinite(makeupDbRaw) ? makeupDbRaw : -120,
        limiterCeilingDb: Number(limiter.threshold.value),
        autoMakeupCompDb: busAutoMakeupDb,
      }
    },

    /**
     * 调试（P6-A）：三段总线压缩的**真实节点值**。
     * gainDb 为各段压缩器补偿后实际写进 makeup 节点的增益（已抵消浏览器自动补偿）。
     */
    __debugMultiband() {
      if (!mbInput || !mbBypass || !mbLowComp || !mbMidComp || !mbHighComp) return null
      const band = (comp: Tone.Compressor, makeup: Tone.Gain | null) => {
        const makeupDbRaw = makeup ? Tone.gainToDb(Number(makeup.gain.value)) : 0
        return {
          thresholdDb: Number(comp.threshold.value),
          ratio: Number(comp.ratio.value),
          attackSec: Number(comp.attack.value),
          releaseSec: Number(comp.release.value),
          makeupDb: Number.isFinite(makeupDbRaw) ? makeupDbRaw : -120,
        }
      }
      return {
        enabled: mbEnabledState,
        inputGain: Number(mbInput.gain.value),
        bypassGain: Number(mbBypass.gain.value),
        crossoverHz: [
          mbLowFilter ? Number(mbLowFilter.frequency.value) : 200,
          mbMidLowpass ? Number(mbMidLowpass.frequency.value) : 3000,
        ] as [number, number],
        low: band(mbLowComp, mbLowMakeup),
        mid: band(mbMidComp, mbMidMakeup),
        high: band(mbHighComp, mbHighMakeup),
        autoMakeupCompDb: { ...mbAutoMakeupDb },
      }
    },

    /**
     * 调试（P6-A）：侧链 ducking 的真实状态（触发源 / 配置 / 当前实际 gain）。
     * 返回数组；没有启用 duck 的轨道时为空数组。
     */
    __debugDuck() {
      return [...duckStates.entries()].map(([trackId, state]) => {
        const node = trackNodes.get(trackId)
        const gain = Number(node?.duckGain.gain.value ?? state.currentGain)
        const gainDbRaw = Tone.gainToDb(gain)
        return {
          trackId,
          sourceTrackId: state.sourceTrackId,
          enabled: true,
          amountDb: state.config.amountDb,
          attackSec: state.config.attackSec,
          releaseSec: state.config.releaseSec,
          gain,
          gainDb: Number.isFinite(gainDbRaw) ? gainDbRaw : -120,
        }
      })
    },

    /**
     * 调试（P3.1 真机验收）：SoundFont 输出路由的**真实状态**。
     * - mode：none（无音色库）/ global（主输出直连总线）/ per-channel（逐通道接每轨处理链）
     * - mainOutput：synth → 总线的主输出当前是否真的连着
     * - routes：逐通道路由表（trackId / MIDI 通道 / 是否连接成功）
     */
    __debugRouting() {
      return {
        mode: soundfontRouting.mode,
        mainOutput: soundfontRouting.mainOutput,
        routes: [...soundfontRouting.routes.entries()].map(([trackId, route]) => ({
          trackId,
          channel: route.channel,
          connected: route.connected,
        })),
      }
    },

    /**
     * 调试（P3.1）：SoundFont 管理器 + 路由的真实状态汇总。
     * `mainOutputActive` 直接读 soundfont 管理器的真实连接状态（不是引擎缓存）。
     */
    __debugSoundfont() {
      return {
        usable: soundfont.usable,
        loaded: soundfont.loaded,
        loading: soundfont.loading,
        error: soundfont.error,
        name: soundfont.name,
        perChannelSupported: soundfont.supportsPerChannelRouting(),
        mainOutputActive: soundfont.mainOutputActive,
        mainOutputEnabled: soundfontRouting.mainOutput,
        routingMode: soundfontRouting.mode,
        routeCount: soundfontRouting.routes.size,
        channels: [...soundfontRouting.routes.values()].map((route) => route.channel),
      }
    },

    /** 调试（P3.1）：分级 tap 采样（别名，便于真机脚本按需调用 / 回归）。 */
    __probeTapRms(trackId, durationMs = 500) {
      return engine.__debugTaps ? engine.__debugTaps(trackId, durationMs) : Promise.resolve(null)
    },

    /**
     * 调试（P3.1 修复）：分级探针。
     * 在一条轨的 `sfIn` / `dry` / `makeup`（链后）/ `channel`（推子后）各临时挂一个
     * AnalyserNode，播放（或静音）条件下采样 ~durationMs，返回各点 RMS（0..1）与链参数。
     * 用于定位「采样音频从哪一级绕过了处理链」。采样结束后自动断开探针。
     */
    async __debugTaps(trackId, durationMs = 500) {
      const node = trackNodes.get(trackId)
      if (!node) return null
      const raw = nativeContext ?? (Tone.getContext().rawContext as AudioContext)
      const probes: { name: string; analyser: AnalyserNode; buffer: Float32Array<ArrayBuffer>; sink: GainNode }[] = []
      const attach = (name: string, connectFn: (analyser: AnalyserNode) => void) => {
        try {
          const analyser = raw.createAnalyser()
          analyser.fftSize = 2048
          analyser.smoothingTimeConstant = 0
          /* 0 增益 sink 把探针拉进音频渲染图（与电平表 tap 的做法一致，不发声） */
          const sink = raw.createGain()
          sink.gain.value = 0
          analyser.connect(sink)
          sink.connect(raw.destination)
          connectFn(analyser)
          probes.push({ name, analyser, buffer: new Float32Array(analyser.fftSize), sink })
        } catch (error) {
          console.warn('[audio] 探针挂载失败', name, error)
        }
      }
      const firstSfIn = node.sfIn
      if (firstSfIn) attach('sfIn', (analyser) => firstSfIn.connect(analyser))
      attach('dry', (analyser) => {
        Tone.connect(node.dry, analyser)
      })
      attach('eqLow', (analyser) => {
        Tone.connect(node.eqLow, analyser)
      })
      attach('eqMid', (analyser) => {
        Tone.connect(node.eqMid, analyser)
      })
      attach('eqHigh', (analyser) => {
        Tone.connect(node.eqHigh, analyser)
      })
      attach('compressor', (analyser) => {
        Tone.connect(node.compressor, analyser)
      })
      attach('makeup', (analyser) => {
        Tone.connect(node.makeup, analyser)
      })
      attach('channel', (analyser) => {
        Tone.connect(node.channel, analyser)
      })

      const buckets: Record<string, number[]> = {}
      for (const probe of probes) buckets[probe.name] = []
      const startedAt = Date.now()
      const windowMs = Math.max(80, durationMs)
      while (Date.now() - startedAt < windowMs) {
        for (const probe of probes) {
          probe.analyser.getFloatTimeDomainData(probe.buffer)
          let sum = 0
          for (let i = 0; i < probe.buffer.length; i += 1) sum += probe.buffer[i] * probe.buffer[i]
          buckets[probe.name].push(Math.sqrt(sum / probe.buffer.length))
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      for (const probe of probes) {
        try {
          probe.analyser.disconnect()
        } catch {
          /* ignore */
        }
        try {
          probe.sink.disconnect()
        } catch {
          /* ignore */
        }
      }
      const summary: Record<string, { avg: number; max: number; n: number }> = {}
      for (const [name, values] of Object.entries(buckets)) {
        summary[name] = {
          avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
          max: values.length ? Math.max(...values) : 0,
          n: values.length,
        }
      }
      const makeupDbRaw = Tone.gainToDb(Number(node.makeup.gain.value))
      return {
        trackId,
        durationMs: windowMs,
        probes: summary,
        chain: {
          lowShelfGainDb: Number(node.eqLow.gain.value),
          midGainDb: Number(node.eqMid.gain.value),
          highShelfGainDb: Number(node.eqHigh.gain.value),
          compressorThresholdDb: Number(node.compressor.threshold.value),
          compressorRatio: Number(node.compressor.ratio.value),
          makeupGainDb: Number.isFinite(makeupDbRaw) ? makeupDbRaw : -120,
        },
        routing: { mode: soundfontRouting.mode, mainOutput: soundfontRouting.mainOutput },
        channel: {
          volumeDb: Number(node.channel.volume.value),
          mute: Boolean(node.channel.mute),
          /* 静音 / 独奏门：0 = 该轨被静音（或未被独奏），1 = 正常出声 */
          muteGain: Number(node.muteGain.gain.value),
        },
      }
    },

    /**
     * 调试（P3.1 修复）：往某轨 `dry` 注入一个已知测试音，并在
     * dry / eqLow / eqMid / eqHigh / compressor / makeup / channel 分级采样 RMS。
     * 用途：排除节目素材与音色差异，直接确认整条链（含 compressor）是否真的在处理。
     */
    async __debugChainTest(trackId, durationMs = 600) {
      const node = trackNodes.get(trackId)
      if (!node) return null
      const raw = nativeContext ?? (Tone.getContext().rawContext as AudioContext)
      const osc = raw.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = 220
      const toneGain = raw.createGain()
      toneGain.gain.value = 0.08
      osc.connect(toneGain)
      try {
        Tone.connect(toneGain, node.dry)
      } catch {
        /* ignore */
      }
      const probes: { name: string; analyser: AnalyserNode; buffer: Float32Array<ArrayBuffer>; sink: GainNode }[] = []
      const attach = (name: string, connectFn: (analyser: AnalyserNode) => void) => {
        try {
          const analyser = raw.createAnalyser()
          analyser.fftSize = 2048
          analyser.smoothingTimeConstant = 0
          const sink = raw.createGain()
          sink.gain.value = 0
          analyser.connect(sink)
          sink.connect(raw.destination)
          connectFn(analyser)
          probes.push({ name, analyser, buffer: new Float32Array(analyser.fftSize), sink })
        } catch (error) {
          console.warn('[audio] 测试探针挂载失败', name, error)
        }
      }
      attach('dry', (analyser) => Tone.connect(node.dry, analyser))
      attach('eqLow', (analyser) => Tone.connect(node.eqLow, analyser))
      attach('eqMid', (analyser) => Tone.connect(node.eqMid, analyser))
      attach('eqHigh', (analyser) => Tone.connect(node.eqHigh, analyser))
      attach('compressor', (analyser) => Tone.connect(node.compressor, analyser))
      attach('makeup', (analyser) => Tone.connect(node.makeup, analyser))
      attach('channel', (analyser) => Tone.connect(node.channel, analyser))

      osc.start()
      const buckets: Record<string, number[]> = {}
      for (const probe of probes) buckets[probe.name] = []
      const startedAt = Date.now()
      while (Date.now() - startedAt < Math.max(100, durationMs)) {
        for (const probe of probes) {
          probe.analyser.getFloatTimeDomainData(probe.buffer)
          let sum = 0
          for (let i = 0; i < probe.buffer.length; i += 1) sum += probe.buffer[i] * probe.buffer[i]
          buckets[probe.name].push(Math.sqrt(sum / probe.buffer.length))
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      try {
        osc.stop()
      } catch {
        /* ignore */
      }
      try {
        osc.disconnect()
      } catch {
        /* ignore */
      }
      try {
        toneGain.disconnect()
      } catch {
        /* ignore */
      }
      for (const probe of probes) {
        try {
          probe.analyser.disconnect()
        } catch {
          /* ignore */
        }
        try {
          probe.sink.disconnect()
        } catch {
          /* ignore */
        }
      }
      const summary: Record<string, { avg: number; max: number; n: number }> = {}
      for (const [name, values] of Object.entries(buckets)) {
        summary[name] = {
          avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
          max: values.length ? Math.max(...values) : 0,
          n: values.length,
        }
      }
      return {
        trackId,
        probes: summary,
        chain: {
          lowShelfGainDb: Number(node.eqLow.gain.value),
          midGainDb: Number(node.eqMid.gain.value),
          highShelfGainDb: Number(node.eqHigh.gain.value),
          compressorThresholdDb: Number(node.compressor.threshold.value),
          compressorRatio: Number(node.compressor.ratio.value),
        },
      }
    },

    async renderToWav(project, options: RenderOptions = {}) {
      // 离线渲染会在渲染期间临时切换 Tone 的全局上下文，必须先把实时走带停下来，
      // 否则正在排期的音符会被调度到离线上下文里（表现为丢音 / 报错）。
      const wasPlaying = isPlaying
      const resumeBeat = wasPlaying ? currentBeat() : 0
      const resumeLoop = scheduler.loop
      if (wasPlaying) engine.pause()
      try {
        return await renderProjectToWav(project, options, soundfont)
      } finally {
        if (wasPlaying) {
          // 恢复播放（从暂停时的位置继续，循环区间保持不变）
          await engine.play(project, { fromBeat: resumeBeat, loop: resumeLoop }).catch(() => undefined)
        }
      }
    },

    onPlayhead(cb) {
      playheadHandlers.add(cb)
      return () => playheadHandlers.delete(cb)
    },

    onLevel(cb) {
      levelHandlers.add(cb)
      return () => levelHandlers.delete(cb)
    },

    get midi(): MidiInput {
      return midi
    },

    get soundfont(): SoundfontManager {
      return soundfont
    },
  }

  // 音色库加载 / 卸载后重新路由轨道（采样器可用性变化）
  let soundfontWasUsable = false
  soundfont.onStatus(() => {
    if (!currentProject || !initialized) return
    const usableNow = soundfont.usable
    if (usableNow !== soundfontWasUsable) {
      soundfontWasUsable = usableNow
      applyProjectInternal(currentProject)
    }
  })

  return engine
}

/* ------------------------------------------------------------------ */
/* 单例                                                                */
/* ------------------------------------------------------------------ */

let singleton: AudioEngine | null = null

/**
 * 全局唯一音频引擎。
 * 注意：`getAudioEngine()` 不会创建 AudioContext（浏览器要求用户手势），
 * 真正的初始化在 `engine.init()` 里（App 在首次交互后调用）。
 */
export function getAudioEngine(): AudioEngine {
  if (!singleton) singleton = createAudioEngine()
  return singleton
}
