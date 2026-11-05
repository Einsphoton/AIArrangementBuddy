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
