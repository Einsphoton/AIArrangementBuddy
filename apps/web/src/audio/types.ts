import type { Clip, Project, Track } from '@aiab/core'

export interface MidiNoteEvent {
  pitch: number
  velocity: number
  channel: number
  /** performance.now() 时间戳 */
  timestamp: number
}

export interface MidiCCEvent {
  controller: number
  value: number
  channel: number
  timestamp: number
}

export interface MidiInput {
  readonly supported: boolean
  readonly devices: { id: string; name: string; manufacturer?: string }[]
  readonly activeId: string | null
  init(): Promise<void>
  refresh(): Promise<{ id: string; name: string; manufacturer?: string }[]>
  select(id: string | null): void
  onNoteOn(cb: (event: MidiNoteEvent) => void): () => void
  onNoteOff(cb: (event: MidiNoteEvent) => void): () => void
  onCC(cb: (event: MidiCCEvent) => void): () => void
  onDevicesChanged(cb: (devices: { id: string; name: string; manufacturer?: string }[]) => void): () => void
}

export interface SoundfontManager {
  readonly loaded: boolean
  readonly name: string
  /** 列出服务端可用音色库 */
  available(): Promise<{ name: string; url: string; size: number; license?: string }[]>
  load(url: string): Promise<void>
  unload(): void
  onStatus(cb: (status: { loaded: boolean; name: string; loading: boolean; error: string | null; progress?: number }) => void): () => void
  /** 当前 spessasynth 是否支持逐通道输出抽头（connectChannel / disconnectChannel） */
  supportsPerChannelRouting(): boolean
  /** 把某个 MIDI 通道输出接到目标节点（逐通道路由用），失败返回 false */
  routeChannelTo(target: AudioNode, channel: number): boolean
  /** 断开某个 MIDI 通道到目标节点的连接 */
  unrouteChannelFrom(target: AudioNode, channel: number): void
  /**
   * 开关主输出（synth → 引擎总线）。逐通道路由时必须关闭，否则会与 `sfIn` 抽头双声。
   */
  setMainOutput(enabled: boolean): void
}

/** P3.1：SoundFont 输出路由模式（engine.__debugRouting） */
export type SoundfontRoutingMode = 'none' | 'global' | 'per-channel'

export interface SoundfontRoutingDebugState {
  mode: SoundfontRoutingMode
  /** 主输出（synth → 总线）当前是否开启 */
  mainOutput: boolean
  routes: { trackId: string; channel: number; connected: boolean }[]
}

/**
 * P3 音频域处理链的调试读数（engine.__debugChain）。
 * 数值来自真实 Web Audio 节点（Tone Signal/Param 的 `.value`），不是工程数据。
 */
export interface MixChainDebugState {
  enabled: boolean
  lowShelf: { hz: number; gainDb: number }
  mid: { hz: number; gainDb: number; q: number }
  highShelf: { hz: number; gainDb: number }
  compressor: { thresholdDb: number; ratio: number; attackSec: number; releaseSec: number }
  makeupDb: number
}

/** P3.2：总线 / 母带处理链的调试读数（engine.__debugMasterChain） */
export interface MasterChainDebugState {
  enabled: boolean
  lowShelf: { hz: number; gainDb: number }
  mid: { hz: number; gainDb: number; q: number }
  highShelf: { hz: number; gainDb: number }
  compressor: { thresholdDb: number; ratio: number; attackSec: number; releaseSec: number }
  makeupDb: number
  limiterCeilingDb: number
  /** 当前为抵消浏览器 DynamicsCompressor 自动补偿而减去的 dB */
  autoMakeupCompDb: number
}

/** P6-A：三段总线压缩的调试读数（engine.__debugMultiband） */
export interface MultibandDebugState {
  enabled: boolean
  inputGain: number
  bypassGain: number
  crossoverHz: [number, number]
  low: { thresholdDb: number; ratio: number; attackSec: number; releaseSec: number; makeupDb: number }
  mid: { thresholdDb: number; ratio: number; attackSec: number; releaseSec: number; makeupDb: number }
  high: { thresholdDb: number; ratio: number; attackSec: number; releaseSec: number; makeupDb: number }
  autoMakeupCompDb: { low: number; mid: number; high: number }
}

/** P6-A：侧链 ducking 的调试读数（engine.__debugDuck，每目标轨一项） */
export interface DuckDebugState {
  trackId: string
  sourceTrackId: string
  enabled: boolean
  amountDb: number
  attackSec: number
  releaseSec: number
  gain: number
  gainDb: number
}

export interface RenderOptions {
  /** 采样率，默认 44100 */
  sampleRate?: number
  /** 尾部混响时长（秒） */
  tailSeconds?: number
  /** 是否包含节拍器 */
  metronome?: boolean
  onProgress?: (ratio: number) => void
}

export interface PlayOptions {
  fromBeat?: number
  /** 循环区间（拍） */
  loop?: { startBeat: number; endBeat: number } | null
  countIn?: boolean
}

/**
 * 音频引擎契约。
 *
 * UI 只依赖这个接口，具体实现（Tone.js 合成器 / SoundFont 采样器）由 audio/engine.ts 提供。
 */
export interface AudioEngine {
  readonly ready: boolean
  readonly playing: boolean

  init(): Promise<void>
  dispose(): void

  /** 应用工程变更（增删轨、换音色、调混音）——播放中调用应平滑生效 */
  applyProject(project: Project): void

  play(project: Project, options?: PlayOptions): Promise<void>
  pause(): void
  stop(): void
  seek(beat: number): void
  playheadBeat(): number

  /** 试听单个音符（点选乐器、钢琴卷帘点击） */
  previewNote(track: Track, pitch: number, velocity?: number, durationSec?: number): void
  /** 试听整个片段 */
  previewClip(track: Track, clip: Clip): void
  stopPreview(): void

  /**
   * 可选扩展：MIDI 键盘「按住」的音符（按下 / 抬起分别触发）。
   * 未实现时调用方应回退到 `previewNote`。
   */
  midiNoteOn?(track: Track, pitch: number, velocity: number): void
  midiNoteOff?(track: Track, pitch: number): void

  setMetronome(on: boolean): void
  setMasterVolume(volume: number): void
  getMeterLevel(): number

  /**
   * 可选扩展：每轨实时电平（0..1，由 dB 映射；0 = 静音 / -∞）。
   * 未实现时调用方应回退到 master 电平估算。
   */
  getTrackLevels?(): Record<string, number>

  /**
   * 调试（P3）：某轨 EQ/压缩处理链的**实际节点数值**（用于真机验收）。
   * 轨道不存在时返回 null。
   */
  __debugChain?(trackId: string): MixChainDebugState | null

  /**
   * 调试（P3.1）：SoundFont 输出路由的**真实状态**（模式 / 主输出 / 逐通道路由表）。
   * 供真机验收断言；不读工程数据。
   */
  __debugRouting?(): SoundfontRoutingDebugState

  /**
   * 调试（P3.1）：分级探针。在 `sfIn` / `dry` / `makeup`（处理后）/ `channel`（推子后）
   * 各临时挂 Analyser 采样 RMS，用于定位音频在哪一级绕过处理链。探针采样后自动断开。
   */
  __debugTaps?(trackId: string, durationMs?: number): Promise<{
    trackId: string
    durationMs: number
    probes: Record<string, { avg: number; max: number; n: number }>
    chain: {
      lowShelfGainDb: number
      midGainDb: number
      highShelfGainDb: number
      compressorThresholdDb: number
      compressorRatio: number
      makeupGainDb: number
    }
    routing: { mode: SoundfontRoutingMode; mainOutput: boolean }
    /** muteGain：静音 / 独奏门的实际增益（0 = 该轨被静音）；mute 是推子硬静音，静音不再用它 */
    channel: { volumeDb: number; mute: boolean; muteGain: number }
  } | null>

  /** 调试（P3.1）：`__debugTaps` 的别名（tap RMS 探针）。 */
  __probeTapRms?(trackId: string, durationMs?: number): Promise<{
    trackId: string
    durationMs: number
    probes: Record<string, { avg: number; max: number; n: number }>
    chain: {
      lowShelfGainDb: number
      midGainDb: number
      highShelfGainDb: number
      compressorThresholdDb: number
      compressorRatio: number
      makeupGainDb: number
    }
    routing: { mode: SoundfontRoutingMode; mainOutput: boolean }
    channel: { volumeDb: number; mute: boolean; muteGain: number }
  } | null>

  /**
   * 调试（P3.2）：总线 / 母带处理链的**实际节点数值**（EQ / 压缩 / 补偿 / 限幅上限）。
   * 用于真机验收；节点未就绪时返回 null。
   */
  __debugMasterChain?(): MasterChainDebugState | null

  /** 调试（P6-A）：三段总线压缩的真实节点值（启用状态 / 分频点 / 三段参数与补偿）。 */
  __debugMultiband?(): MultibandDebugState | null

  /** 调试（P6-A）：侧链 ducking 的真实状态（触发源 / 配置 / 当前实际 gain）。 */
  __debugDuck?(): DuckDebugState[]

  /** 调试（P3.1）：SoundFont 管理器 + 路由的真实状态汇总。 */
  __debugSoundfont?(): {
    usable: boolean
    loaded: boolean
    loading: boolean
    error: string | null
    name: string
    perChannelSupported: boolean
    /** 主输出是否真的连着（读 soundfont 管理器，不是引擎缓存） */
    mainOutputActive: boolean
    mainOutputEnabled: boolean
    routingMode: SoundfontRoutingMode
    routeCount: number
    channels: number[]
  }

  /**
   * 调试（P3.1）：向某轨 dry 注入已知测试音，逐级采样 RMS（dry→EQ→压缩→推子），
   * 用于排除节目素材差异、直接确认整条处理链是否生效。
   */
  __debugChainTest?(trackId: string, durationMs?: number): Promise<{
    trackId: string
    probes: Record<string, { avg: number; max: number; n: number }>
    chain: {
      lowShelfGainDb: number
      midGainDb: number
      highShelfGainDb: number
      compressorThresholdDb: number
      compressorRatio: number
    }
  } | null>

  /** 离线渲染为 WAV（用于 MP3/FLAC 转码与分享） */
  renderToWav(project: Project, options?: RenderOptions): Promise<Blob>

  onPlayhead(cb: (beat: number) => void): () => void
  onLevel(cb: (level: number) => void): () => void

  /**
   * 诊断信息（可选）：当前音频上下文状态、每轨实际发声路由、
   * 以及最近一次试听/MIDI Thru 用的是哪条音色（排查「听到的音色与轨道不一致」时很有用）。
   */
  debugState?(): {
    initialized: boolean
    scheduler: {
      isPlaying: boolean
      noteCount: number
      scheduledNoteCount: number
      lastScheduledAt: number
      startContextTime: number
      scheduledPosition: number
      position: number
      endBeat: number
      secPerBeat: number
      now: number
      runtimeTracks: number
    }
    contextState: string
    masterLevel: number
    lastAudition: { trackId: string; kind: 'synth' | 'soundfont'; detail: string; at: number } | null
    tracks: {
      id: string
      instrumentId: string
      emotionId: string
      route: 'synth' | 'soundfont'
      voiceKey: string
      hasVoice: boolean
      soundfontChannel: number | null
      level: number
    }[]
  }

  readonly midi: MidiInput
  readonly soundfont: SoundfontManager
}
