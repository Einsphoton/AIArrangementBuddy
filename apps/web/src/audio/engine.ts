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
  type Project,
  type Track,
} from '@aiab/core'
import type { AudioEngine, MidiInput, PlayOptions, RenderOptions, SoundfontManager } from './types'
import { createInstrumentVoice, noteDurationFor, type InstrumentVoice } from './synth'
import { SoundfontEngine } from './soundfont'
import { WebMidiInput } from './midi'
import { renderProjectToWav } from './render'
import { clamp } from './util'
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
  let reverbBus: Tone.Reverb | null = null
  let delayBus: Tone.FeedbackDelay | null = null
  let chorusBus: Tone.Chorus | null = null
  let sfNative: GainNode | null = null
  let nativeContext: AudioContext | null = null
  let metronomeSynth: Tone.MembraneSynth | null = null

  let metronome = false

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
    mixBus.connect(masterGain)

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
    try {
      node.voice?.allNotesOff()
      node.voice?.dispose()
    } catch {
      /* ignore */
    }
    for (const target of [
      node.dry,
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

  const ensureTrackNode = (track: Track): TrackNode => {
    let node = trackNodes.get(track.id)
    if (node) return node
    const channel = new Tone.Channel({ volume: -6, pan: 0 })
    const widener = new Tone.StereoWidener(0.5)
    const dry = new Tone.Gain(1)
    const sendReverb = new Tone.Gain(0)
    const sendDelay = new Tone.Gain(0)
    const sendChorus = new Tone.Gain(0)
    // 每轨电平表：旁路 tap（meter 无输出），接在 widener 之后，不改变主信号链
    const trackMeter = new Tone.Meter({ smoothing: 0.6, normalRange: false })
    dry.connect(channel)
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
      sendReverb,
      sendDelay,
      sendChorus,
      meter: trackMeter,
      sfAnalyser: null,
      sfAnalyserBuffer: null,
      sfSink: null,
      sfSynth: null,
      sfChannel: null,
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

  const rebuildNoteIndex = (project: Project, audibleIds: Set<string>) => {
    const notes: FlatNote[] = []
    for (const track of project.tracks) {
      if (!audibleIds.has(track.id)) continue
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

  const applyMix = (track: Track, node: TrackNode, audible: boolean) => {
    const emotion = getEmotion(track.instrumentId, track.emotionId).params
    const instrument = getInstrument(track.instrumentId)
    node.channel.mute = !audible
    node.channel.volume.rampTo(Tone.gainToDb(Math.max(0.0005, track.volume)), 0.06)
    node.channel.pan.rampTo(clamp(track.pan, -1, 1), 0.06)
    node.widener.width.rampTo(clamp(emotion.stereoWidth, 0, 1), 0.1)
    node.sendReverb.gain.rampTo(reverbAmount(track, emotion.reverb), 0.1)
    node.sendDelay.gain.rampTo(delayAmount(track, emotion.delay), 0.1)
    node.sendChorus.gain.rampTo(chorusAmount(track, emotion.chorus, instrument.synth.fx.chorus), 0.1)

    if (node.route === 'soundfont') {
      const channel = soundfont.channelFor(track.id)
      if (channel != null) {
        soundfont.setProgram(track.id, track.gmProgram || instrument.gmProgram, instrument.isDrumKit || track.kind === 'drum')
        soundfont.applyChannelMix(track.id, {
          volume: track.volume,
          pan: track.pan,
          reverb: reverbAmount(track, emotion.reverb),
          chorus: chorusAmount(track, emotion.chorus, instrument.synth.fx.chorus),
          brightness: emotion.brightness,
          modulation: emotion.vibrato * 0.9,
          muted: !audible,
        })
      }
    }
  }

  const applyProjectInternal = (project: Project) => {
    currentProject = project
    if (!initialized) return
    ensureGraph()

    const anySolo = project.tracks.some((track) => track.solo)
    const audible = new Set<string>()
    for (const track of project.tracks) {
      if (track.mute) continue
      if (anySolo && !track.solo) continue
      audible.add(track.id)
    }

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
      if (route === 'soundfont') {
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

    rebuildNoteIndex(project, audible)

    scheduler.endBeat = Math.max(1, projectEndBeat(project))
    scheduler.secPerBeat = 60 / Math.max(20, project.tempo)
    if (isPlaying) {
      // 保持当前播放位置，热切换后继续走
      const pos = positionAt(now())
      scheduler.startPosition = pos
      scheduler.startContextTime = now()
      scheduler.scheduledPosition = pos
    }
    // 延迟总线跟随速度（八分音符）
    if (delayBus) {
      try {
        delayBus.delayTime.rampTo(Math.max(0.05, scheduler.secPerBeat * 0.75), 0.1)
      } catch {
        /* ignore */
      }
    }
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
      soundfont.destroy()
      for (const target of [meterSink, reverbBus, delayBus, chorusBus, metronomeSynth, mixBus, masterGain, limiter, meter]) {
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

      isPlaying = true
      lastPosition = fromBeat
      startClock()
      emitPlayhead(fromBeat)
    },

    pause() {
      if (!isPlaying) return
      const beat = currentBeat()
      releaseAllVoices()
      stopClock()
      isPlaying = false
      lastPosition = clamp(beat, 0, scheduler.endBeat)
      emitPlayhead(lastPosition)
    },

    stop() {
      stopPreviewInternal()
      releaseAllVoices()
      stopClock()
      isPlaying = false
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
