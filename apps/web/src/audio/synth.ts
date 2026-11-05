/**
 * 内置合成器乐器引擎（无 SoundFont 时的「高保真兜底」，也是预听 / 离线渲染的主力）。
 *
 * 设计要点
 * --------
 * 1. 每个轨道构建一个「音色图」：按 `SynthPatch.layers` 逐层建 Tone.PolySynth，
 *    每层独立振荡器类型 / 八度 / 失谐 / 音量 / 包络 / 滤波包络；层求和后依次通过
 *    Vibrato（颤音）→ 低架滤波（温暖度）→ 失真（drive）→ 低通（亮度）→ 输出。
 * 2. `EmotionParams` 不是「换个预设名」，而是实时映射到上面每个环节：
 *    亮度→滤波截止，温暖度→低频搁架，attack/release/sustain→包络，
 *    vibrato/vibratoRate→颤音 LFO，drive→失真，velocityCurve/velocitySensitivity→力度曲线，
 *    articulation→演奏法（时值门限 + 音色/滤波微调）。
 * 3. 鼓组乐器（`instrument.isDrumKit`）走单独的 DrumKitVoice：按 GM 音高映射到
 *    kick / snare / clap / hat / tom / cymbal …，由 MembraneSynth / NoiseSynth / MetalSynth 组合，
 *    绝不当旋律弹。
 *
 * 这个文件不碰音频总线（master / reverb / delay / chorus），总线与静音/独奏/声像
 * 由 `engine.ts` 统一处理，因此同一套音色图可以同时用于实时播放与离线渲染。
 */
import * as Tone from 'tone'
import type { ArticulationId, EmotionParams, InstrumentDefinition, LayerSpec } from '@aiab/core'
import { brightnessScale, clamp, midiToNoteName, shapeVelocity, warmthGainDb } from './util'

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

export interface InstrumentVoice {
  /** 该乐器的输出节点，由调用方接到轨道总线上 */
  readonly output: Tone.Gain
  /**
   * 触发一个音符。
   * - `durationSec > 0`：一次性音符（常规播放 / 预听），内部自动释放；
   * - `durationSec <= 0`：持续音（MIDI 键盘按住），需要显式 `noteOff`。
   */
  noteOn(time: number, pitch: number, velocity: number, durationSec: number): void
  /** 释放某个音高（持续音用） */
  noteOff(time: number, pitch: number): void
  /** 紧急释放所有发声（停止播放 / 拖动播放头 / 换音色前） */
  allNotesOff(time?: number): void
  dispose(): void
}

/* ------------------------------------------------------------------ */
/* 演奏法                                                              */
/* ------------------------------------------------------------------ */

/** 演奏法对应的时值门限（相对音符时值） */
const ARTICULATION_GATE: Record<ArticulationId, number> = {
  sustain: 0.95,
  staccato: 0.4,
  legato: 1.02,
  marcato: 0.82,
  pizzicato: 0.3,
  tremolo: 0.98,
  palmMute: 0.58,
  harmonic: 0.95,
  pluck: 0.62,
  swell: 1.05,
  bowChange: 0.9,
}

/** 演奏法对滤波的倍数（palmMute 更闷，harmonic/pizzicato 更亮） */
const ARTICULATION_FILTER: Record<ArticulationId, number> = {
  sustain: 1,
  staccato: 1.05,
  legato: 1,
  marcato: 1.15,
  pizzicato: 1.2,
  tremolo: 1.05,
  palmMute: 0.33,
  harmonic: 1.6,
  pluck: 1.25,
  swell: 0.85,
  bowChange: 1,
}

/** 需要「拨弦式」音头的演奏法：额外建一个短包络发声层 */
const PLUCK_ARTICULATIONS = new Set<ArticulationId>(['pizzicato', 'palmMute', 'pluck', 'staccato'])
/** 需要颤音门限（amplitude LFO）的演奏法 */
const TREMOLO_ARTICULATIONS = new Set<ArticulationId>(['tremolo'])

export function articulationGate(articulation: ArticulationId): number {
  return ARTICULATION_GATE[articulation] ?? 0.95
}

/**
 * 计算实际发声时长。
 * 极短演奏法（pizzicato / staccato）除了门限还要压一个绝对上限，
 * 否则慢速长音会被拖成「弓子没抬起来」。
 */
export function noteDurationFor(articulation: ArticulationId, beatDurationSec: number): number {
  const gate = articulationGate(articulation)
  let seconds = Math.max(0.03, beatDurationSec * gate)
  if (articulation === 'pizzicato') seconds = Math.min(seconds, 0.32)
  if (articulation === 'staccato') seconds = Math.min(seconds, 0.55)
  if (articulation === 'palmMute') seconds = Math.min(seconds, 0.7)
  return seconds
}

/* ------------------------------------------------------------------ */
/* 旋律乐器                                                            */
/* ------------------------------------------------------------------ */

type ToneOscType = 'sine' | 'triangle' | 'sawtooth' | 'square' | 'pulse' | 'fatsawtooth' | 'fattriangle' | 'fatsquare'

const OSC_MAP: Record<string, ToneOscType> = {
  sine: 'sine',
  triangle: 'triangle',
  sawtooth: 'sawtooth',
  square: 'square',
  pulse: 'pulse',
  fatsawtooth: 'fatsawtooth',
  fattriangle: 'fattriangle',
  fatsquare: 'fatsquare',
  fm: 'sine',
}

function oscTypeFor(layer: LayerSpec): ToneOscType {
  return OSC_MAP[layer.osc] ?? 'triangle'
}

interface LayerRuntime {
  node: Tone.PolySynth
  gain: Tone.Gain
  octave: number
  /** 该层自己的亮度目标（用于换情绪时不做重建的轻量更新） */
  cutoff: number
}

/** 把 LayerSpec 的包络与情绪参数融合成实际包络 */
function envelopeFor(layer: LayerSpec, emotion: EmotionParams): { attack: number; decay: number; sustain: number; release: number } {
  const base = layer.envelope ?? {}
  const attack = clamp((base.attack ?? 0.01) * (0.55 + emotion.attack * 4.2), 0.001, 3)
  const decay = clamp((base.decay ?? 0.4) * (0.7 + emotion.warmth * 0.5), 0.02, 8)
  const sustain = clamp((base.sustain ?? 0.7) * (0.35 + emotion.sustain * 0.85), 0, 1)
  const release = clamp((base.release ?? 0.5) * (0.3 + emotion.release * 1.7), 0.02, 6)
  return { attack, decay, sustain, release }
}

/**
 * 单轨旋律音色。一个实例对应一个「乐器 + 情绪」组合；
 * 情绪或乐器变化时由 engine 重建实例（播放中会先释放再替换，避免挂音）。
 */
export class SynthVoice implements InstrumentVoice {
  readonly output: Tone.Gain
  private readonly bus: Tone.Gain
  private readonly layers: LayerRuntime[] = []
  private readonly vibrato: Tone.Vibrato
  private readonly shelf: Tone.Filter
  private readonly drive: Tone.Distortion
  private readonly toneFilter: Tone.Filter
  private readonly tremolo: Tone.Tremolo | null
  private readonly harmonicLayer: Tone.PolySynth | null = null
  private readonly pluckLayer: Tone.PolySynth | null = null
  private readonly articulation: ArticulationId
  private readonly velocityCurve: number
  private readonly velocitySensitivity: number
  /** 持续音记录：pitch -> 每层实际触发的音名（noteOff 需要完全一致） */
  private readonly held = new Map<number, string[]>()

  constructor(instrument: InstrumentDefinition, emotion: EmotionParams) {
    const patch = instrument.synth
    this.articulation = emotion.articulation
    this.velocityCurve = emotion.velocityCurve
    this.velocitySensitivity = patch.velocitySensitivity
    const bright = brightnessScale(emotion.brightness) * (ARTICULATION_FILTER[emotion.articulation] ?? 1)
    const masterCut = clamp(6800 * bright, 320, 17000)

    this.output = new Tone.Gain(1)
    this.bus = new Tone.Gain(1)

    // 颤音：depth 0 时 wet=0，避免无谓的相位处理
    this.vibrato = new Tone.Vibrato({
      frequency: clamp(emotion.vibratoRate || 5.2, 3, 9),
      depth: clamp(emotion.vibrato * 0.85, 0, 0.9),
      wet: emotion.vibrato > 0.02 ? 1 : 0,
    })
    // 温暖度：低频搁架
    this.shelf = new Tone.Filter({ type: 'lowshelf', frequency: 260, gain: warmthGainDb(emotion.warmth) })
    // 驱动：情绪 drive + 音色自带失真取较大者
    const driveWet = clamp(Math.max(emotion.drive * 0.9, patch.fx.distortion), 0, 1)
    this.drive = new Tone.Distortion({
      distortion: clamp(0.1 + Math.max(emotion.drive, patch.fx.distortion) * 0.8, 0.02, 0.96),
      wet: driveWet,
    })
    // 亮度：总线低通
    this.toneFilter = new Tone.Filter({ type: 'lowpass', frequency: masterCut, Q: 0.35, rolloff: -12 })

    this.bus.connect(this.vibrato)
    this.vibrato.connect(this.shelf)
    this.shelf.connect(this.drive)
    this.drive.connect(this.toneFilter)

    // 颤音演奏法：在总输出上加 amplitude LFO（弦乐 tremolo）
    if (TREMOLO_ARTICULATIONS.has(emotion.articulation)) {
      this.tremolo = new Tone.Tremolo({
        frequency: clamp(8 + emotion.vibratoRate * 0.2, 6, 13),
        depth: 0.82,
        spread: 120,
        wet: 1,
      }).start()
      this.toneFilter.connect(this.tremolo)
      this.tremolo.connect(this.output)
    } else {
      this.tremolo = null
      this.toneFilter.connect(this.output)
    }

    // 逐层构建振荡器
    for (const layer of patch.layers) {
      if (layer.osc === 'noise') continue // 旋律乐器的噪声层不参与音高，忽略（鼓组单独实现）
      const layerGain = new Tone.Gain(clamp(layer.gain, 0, 1) * 0.92)
      const detune = layer.detune + emotion.detune * 0.5
      const ampEnv = envelopeFor(layer, emotion)
      const baseCut = layer.filter
        ? clamp(layer.filter.frequency * bright, 120, 17000)
        : masterCut
      const portamento = patch.monophonic ? Math.max(0.005, patch.glide) : 0

      let node: Tone.PolySynth
      if (layer.osc === 'fm') {
        node = new Tone.PolySynth(Tone.FMSynth, {
          harmonicity: clamp(layer.fm?.harmonicity ?? 2, 0.1, 12),
          modulationIndex: clamp(layer.fm?.modulationIndex ?? 6, 0, 40),
          detune,
          portamento,
          envelope: ampEnv,
          modulationEnvelope: {
            attack: Math.max(0.001, ampEnv.attack * 0.9),
            decay: ampEnv.decay,
            sustain: ampEnv.sustain * 0.9,
            release: ampEnv.release,
          },
        })
      } else if (layer.filter) {
        const spec = layer.filter
        const env = spec.envelope ?? {}
        const filterEnv = {
          attack: clamp((env.attack ?? 0.01) * (0.6 + emotion.attack * 3), 0.001, 3),
          decay: clamp((env.decay ?? 0.4) * (0.6 + emotion.warmth * 0.6), 0.02, 6),
          sustain: clamp((env.sustain ?? 0.4) * (0.4 + emotion.sustain * 0.9), 0, 1),
          release: clamp((env.release ?? 0.4) * (0.35 + emotion.release * 1.5), 0.02, 5),
          baseFrequency: clamp(baseCut * (1 - clamp(spec.envAmount, 0, 1) * 0.45), 90, 16000),
          octaves: clamp(spec.envAmount * 4, 0.5, 5),
          exponent: 2,
        }
        node = new Tone.PolySynth(Tone.MonoSynth, {
          oscillator: { type: oscTypeFor(layer) },
          envelope: ampEnv,
          detune,
          portamento,
          filter: { type: spec.type, Q: clamp(spec.Q, 0.1, 12), rolloff: -24 },
          filterEnvelope: filterEnv,
        })
        node.connect(layerGain)
      } else {
        node = new Tone.PolySynth(Tone.Synth, {
          oscillator: { type: oscTypeFor(layer) },
          envelope: ampEnv,
          detune,
          portamento,
        })
        // 没有滤波包的层：用一个静态低通跟随亮度
        const post = new Tone.Filter({ type: 'lowpass', frequency: clamp(baseCut, 300, 17000), Q: 0.3 })
        node.connect(post)
        post.connect(layerGain)
      }

      // 复音上限：DAW 场景下同一层可能同时承担和弦 + 叠层片段，给足余量避免丢音
      node.maxPolyphony = Math.max(24, Math.min(96, patch.polyphony * 2))
      layerGain.connect(this.bus)
      this.layers.push({ node, gain: layerGain, octave: layer.octave, cutoff: baseCut })
    }

    // 泛音演奏法：额外的纯净正弦高八度层（真·泛音比原始音高亮 12 度）
    if (emotion.articulation === 'harmonic') {
      this.harmonicLayer = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'sine' },
        envelope: { attack: 0.004, decay: 2.4, sustain: 0, release: 1.4 },
        detune: 0,
      })
      this.harmonicLayer.maxPolyphony = Math.max(2, Math.min(8, patch.polyphony))
      const gain = new Tone.Gain(0.5)
      this.harmonicLayer.connect(gain)
      gain.connect(this.bus)
    }

    // 拨弦演奏法：短包络的辅助声部，给 pizzicato / palmMute / pluck 一个真实的「音头」
    if (PLUCK_ARTICULATIONS.has(emotion.articulation)) {
      this.pluckLayer = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'triangle' },
        envelope: {
          attack: 0.002,
          decay: clamp(0.1 + emotion.release * 0.25, 0.06, 0.5),
          sustain: 0,
          release: clamp(0.04 + emotion.release * 0.2, 0.04, 0.5),
        },
        detune: emotion.detune * 0.3,
      })
      this.pluckLayer.maxPolyphony = Math.max(2, Math.min(16, patch.polyphony))
      const gain = new Tone.Gain(0.42)
      this.pluckLayer.connect(gain)
      gain.connect(this.bus)
    }
  }

  private mappedVelocity(velocity: number): number {
    return shapeVelocity(clamp(velocity, 0, 1), this.velocityCurve, this.velocitySensitivity)
  }

  noteOn(time: number, pitch: number, velocity: number, durationSec: number): void {
    const vel = this.mappedVelocity(velocity)
    const at = Math.max(0, time)
    try {
      if (this.articulation === 'harmonic' && this.harmonicLayer) {
        // 泛音：只发高八度正弦，主层轻带一点基音保持「实体感」
        const note = midiToNoteName(pitch + 12)
        this.harmonicLayer.triggerAttackRelease(note, Math.max(0.12, durationSec), at, vel)
        this.layers.slice(0, 1).forEach((layer) => {
          layer.node.triggerAttackRelease(midiToNoteName(pitch + layer.octave * 12), durationSec, at, vel * 0.18)
        })
        return
      }

      if (durationSec > 0) {
        const pluckDur = Math.min(durationSec, this.articulation === 'pizzicato' ? 0.3 : 0.5)
        for (const layer of this.layers) {
          const note = midiToNoteName(pitch + layer.octave * 12)
          layer.node.triggerAttackRelease(note, durationSec, at, vel)
          if (this.pluckLayer) this.pluckLayer.triggerAttackRelease(note, pluckDur, at, vel * 0.7)
        }
      } else {
        // 持续音（MIDI 键盘）：记住每层音名，noteOff 时按同样音名释放
        const notes: string[] = []
        for (const layer of this.layers) {
          const note = midiToNoteName(pitch + layer.octave * 12)
          layer.node.triggerAttack(note, at, vel)
          this.pluckLayer?.triggerAttack(note, at, vel * 0.7)
          notes.push(note)
        }
        this.held.set(pitch, notes)
      }
    } catch {
      /* 非法音高 / 已被销毁的节点：静默忽略，绝不打断走带 */
    }
  }

  noteOff(time: number, pitch: number): void {
    const notes = this.held.get(pitch)
    if (!notes) return
    this.held.delete(pitch)
    const at = Math.max(0, time)
    try {
      this.layers.forEach((layer, i) => {
        if (notes[i]) layer.node.triggerRelease(notes[i], at)
      })
      if (this.pluckLayer && notes[0]) this.pluckLayer.triggerRelease(notes[0], at)
    } catch {
      /* ignore */
    }
  }

  allNotesOff(time?: number): void {
    const at = time ?? Tone.immediate()
    for (const layer of this.layers) {
      try {
        layer.node.releaseAll(at)
      } catch {
        /* ignore */
      }
    }
    try {
      this.pluckLayer?.releaseAll(at)
      this.harmonicLayer?.releaseAll(at)
    } catch {
      /* ignore */
    }
    this.held.clear()
  }

  dispose(): void {
    for (const layer of this.layers) {
      try {
        layer.node.dispose()
        layer.gain.dispose()
      } catch {
        /* ignore */
      }
    }
    this.layers.length = 0
    for (const node of [this.vibrato, this.shelf, this.drive, this.toneFilter, this.tremolo, this.harmonicLayer, this.pluckLayer]) {
      try {
        node?.dispose()
      } catch {
        /* ignore */
      }
    }
    try {
      this.bus.dispose()
      this.output.dispose()
    } catch {
      /* ignore */
    }
    this.held.clear()
  }
}

/* ------------------------------------------------------------------ */
/* 鼓组                                                                */
/* ------------------------------------------------------------------ */

export type DrumKind =
  | 'kick'
  | 'kickSoft'
  | 'snare'
  | 'rim'
  | 'clap'
  | 'brush'
  | 'tom'
  | 'hatClosed'
  | 'hatPedal'
  | 'hatOpen'
  | 'crash'
  | 'ride'
  | 'rideBell'
  | 'china'
  | 'splash'
  | 'tambourine'
  | 'cowbell'
  | 'bongo'
  | 'conga'
  | 'shaker'
  | 'woodblock'
  | 'triangleHit'

/** GM 打击乐音高 -> 鼓件（与 @aiab/core 的 DRUM_MAP 一致，未知音高按低音 tom 兜底） */
export function drumKindFor(pitch: number): DrumKind {
  switch (pitch) {
    case 35:
      return 'kickSoft'
    case 36:
      return 'kick'
    case 37:
      return 'rim'
    case 38:
      return 'snare'
    case 40:
      return 'brush'
    case 39:
      return 'clap'
    case 41:
    case 43:
    case 45:
    case 47:
    case 48:
    case 50:
      return 'tom'
    case 42:
      return 'hatClosed'
    case 44:
      return 'hatPedal'
    case 46:
      return 'hatOpen'
    case 49:
    case 57:
      return 'crash'
    case 51:
      return 'ride'
    case 53:
      return 'rideBell'
    case 52:
      return 'china'
    case 55:
      return 'splash'
    case 54:
      return 'tambourine'
    case 56:
      return 'cowbell'
    case 60:
    case 61:
      return 'bongo'
    case 62:
    case 63:
      return 'conga'
    case 70:
      return 'shaker'
    case 76:
      return 'woodblock'
    case 81:
      return 'triangleHit'
    default:
      return pitch < 40 ? 'kickSoft' : pitch < 50 ? 'tom' : 'shaker'
  }
}

/**
 * 鼓组音色。
 *
 * 每一个鼓件都是真实合成的鼓声（而不是把音高当旋律弹）：
 * - kick：MembraneSynth 音高包络 + 高频 click；808 情绪下自动拉长尾音
 * - snare：带通噪声 + MembraneSynth 鼓腔
 * - clap：三次快速噪声重触发（经典 clap 的「群延迟」）
 * - hat：高通噪声；closed hat 会截断 open hat（choke）
 * - cymbal：MetalSynth 金属噪声
 */
export class DrumKitVoice implements InstrumentVoice {
  readonly output: Tone.Gain
  private readonly bus: Tone.Gain
  private readonly brightFilter: Tone.Filter
  private readonly drive: Tone.Distortion
  private readonly kick: Tone.MembraneSynth
  private readonly kickClick: Tone.NoiseSynth
  private readonly snareNoise: Tone.NoiseSynth
  private readonly snareBody: Tone.MembraneSynth
  private readonly rimNoise: Tone.NoiseSynth
  private readonly clapNoise: Tone.NoiseSynth
  private readonly tom: Tone.MembraneSynth
  private readonly hatClosed: Tone.NoiseSynth
  private readonly hatOpen: Tone.NoiseSynth
  private readonly metalCymbal: Tone.MetalSynth
  private readonly metalRide: Tone.MetalSynth
  private readonly metalBell: Tone.MetalSynth
  private readonly shakerNoise: Tone.NoiseSynth
  private readonly miscNoise: Tone.NoiseSynth
  private readonly velocityCurve: number
  private readonly velocitySensitivity: number
  private readonly releaseScale: number
  private readonly isBrush: boolean

  constructor(instrument: InstrumentDefinition, emotion: EmotionParams) {
    const patch = instrument.synth
    this.velocityCurve = emotion.velocityCurve
    this.velocitySensitivity = patch.velocitySensitivity
    this.releaseScale = clamp(0.6 + emotion.release * 1.8, 0.5, 2.6)
    this.isBrush = emotion.articulation === 'swell'

    const bright = brightnessScale(emotion.brightness)
    this.output = new Tone.Gain(1)
    this.bus = new Tone.Gain(1)
    this.brightFilter = new Tone.Filter({
      type: 'lowpass',
      frequency: clamp(11000 * bright, 1800, 18000),
      Q: 0.4,
    })
    this.drive = new Tone.Distortion({
      distortion: clamp(0.12 + Math.max(emotion.drive, patch.fx.distortion) * 0.8, 0.02, 0.95),
      wet: clamp(emotion.drive * 0.85, 0, 0.9),
    })
    this.bus.connect(this.brightFilter)
    this.brightFilter.connect(this.drive)
    this.drive.connect(this.output)

    const connectPiece = (node: Tone.ToneAudioNode, pan = 0, gain = 1) => {
      const panner = new Tone.Panner(clamp(pan, -1, 1))
      const g = new Tone.Gain(gain)
      node.connect(g)
      g.connect(panner)
      panner.connect(this.bus)
      return node
    }

    // ---- kick ----
    this.kick = new Tone.MembraneSynth({
      pitchDecay: clamp(0.028 + emotion.warmth * 0.02, 0.02, 0.06),
      octaves: clamp(3 + emotion.warmth * 2.5, 2, 6),
      oscillator: { type: 'sine' },
      envelope: {
        attack: 0.001,
        decay: clamp(0.16 + emotion.release * 0.9, 0.12, 1.2),
        sustain: 0,
        release: clamp(0.06 + emotion.release * 0.25, 0.05, 0.4),
      },
    })
    connectPiece(this.kick, 0, 1)
    this.kickClick = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.0005, decay: 0.014, sustain: 0, release: 0.01 },
    })
    const clickFilter = new Tone.Filter({ type: 'highpass', frequency: 2600, Q: 0.7 })
    this.kickClick.connect(clickFilter)
    connectPiece(clickFilter, 0, 0.35)

    // ---- snare ----
    this.snareNoise = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: {
        attack: 0.0006,
        decay: clamp(0.13 + emotion.release * 0.16, 0.1, 0.4),
        sustain: 0,
        release: clamp(0.04 + emotion.release * 0.12, 0.03, 0.22),
      },
    })
    const snareFilter = new Tone.Filter({ type: 'bandpass', frequency: clamp(1500 + emotion.brightness * 1400, 1200, 3400), Q: 0.9 })
    this.snareNoise.connect(snareFilter)
    connectPiece(snareFilter, 0.06, 0.85)
    this.snareBody = new Tone.MembraneSynth({
      pitchDecay: 0.012,
      octaves: 1.6,
      envelope: { attack: 0.001, decay: 0.1, sustain: 0, release: 0.06 },
    })
    connectPiece(this.snareBody, -0.04, 0.5)

    // ---- rim / brush ----
    this.rimNoise = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.0005, decay: 0.035, sustain: 0, release: 0.02 },
    })
    const rimFilter = new Tone.Filter({ type: 'highpass', frequency: 2400, Q: 1.2 })
    this.rimNoise.connect(rimFilter)
    connectPiece(rimFilter, -0.15, 0.5)

    // ---- clap ----
    this.clapNoise = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.045, sustain: 0, release: 0.03 },
    })
    const clapFilter = new Tone.Filter({ type: 'bandpass', frequency: 1250, Q: 1.1 })
    this.clapNoise.connect(clapFilter)
    connectPiece(clapFilter, 0.12, 0.7)

    // ---- toms ----
    this.tom = new Tone.MembraneSynth({
      pitchDecay: 0.06,
      octaves: 1.4,
      envelope: { attack: 0.001, decay: clamp(0.22 + emotion.release * 0.2, 0.18, 0.6), sustain: 0, release: 0.1 },
    })
    connectPiece(this.tom, -0.2, 0.8)

    // ---- hats ----
    this.hatClosed = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.0004, decay: 0.03, sustain: 0, release: 0.02 },
    })
    const hatHz = clamp(7200 + emotion.brightness * 2600, 6000, 11000)
    const hatClosedFilter = new Tone.Filter({ type: 'highpass', frequency: hatHz, Q: 0.9 })
    this.hatClosed.connect(hatClosedFilter)
    connectPiece(hatClosedFilter, 0.28, 0.45)
    this.hatOpen = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.32, sustain: 0, release: 0.16 },
    })
    const hatOpenFilter = new Tone.Filter({ type: 'highpass', frequency: hatHz * 0.82, Q: 0.8 })
    this.hatOpen.connect(hatOpenFilter)
    connectPiece(hatOpenFilter, 0.32, 0.4)

    // ---- cymbals ----
    this.metalCymbal = new Tone.MetalSynth({
      harmonicity: 4.2,
      modulationIndex: 24,
      resonance: clamp(3200 + emotion.brightness * 3200, 2500, 7000),
      octaves: 1.8,
      envelope: { attack: 0.001, decay: clamp(1.4 * this.releaseScale, 0.8, 3.2), sustain: 0, release: 0.5 },
    })
    connectPiece(this.metalCymbal, -0.3, 0.35)
    this.metalRide = new Tone.MetalSynth({
      harmonicity: 3.1,
      modulationIndex: 16,
      resonance: clamp(4200 + emotion.brightness * 3000, 3500, 8000),
      octaves: 1.2,
      envelope: { attack: 0.001, decay: clamp(0.7 * this.releaseScale, 0.4, 1.8), sustain: 0, release: 0.3 },
    })
    connectPiece(this.metalRide, 0.34, 0.28)
    this.metalBell = new Tone.MetalSynth({
      harmonicity: 5.7,
      modulationIndex: 32,
      resonance: 6000,
      octaves: 1,
      envelope: { attack: 0.001, decay: clamp(0.28 * this.releaseScale, 0.15, 0.7), sustain: 0, release: 0.12 },
    })
    connectPiece(this.metalBell, 0.2, 0.3)

    // ---- shaker / tambourine / misc noise ----
    this.shakerNoise = new Tone.NoiseSynth({
      noise: { type: 'pink' },
      envelope: { attack: 0.004, decay: 0.055, sustain: 0, release: 0.04 },
    })
    const shakerFilter = new Tone.Filter({ type: 'bandpass', frequency: 6200, Q: 0.8 })
    this.shakerNoise.connect(shakerFilter)
    connectPiece(shakerFilter, 0.4, 0.4)
    this.miscNoise = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.002, decay: 0.08, sustain: 0, release: 0.05 },
    })
    const miscFilter = new Tone.Filter({ type: 'highpass', frequency: 3800, Q: 0.7 })
    this.miscNoise.connect(miscFilter)
    connectPiece(miscFilter, -0.1, 0.45)

    // 刷奏（爵士 brush）时把鼓壳噪音降下来，只留刷子沙沙声
    if (this.isBrush) {
      try {
        this.snareBody.volume.value = -16
        this.kick.volume.value = -8
      } catch {
        /* ignore */
      }
    }
  }

  private mappedVelocity(velocity: number): number {
    return shapeVelocity(clamp(velocity, 0, 1), this.velocityCurve, Math.max(0.55, this.velocitySensitivity))
  }

  noteOn(time: number, pitch: number, velocity: number, durationSec: number): void {
    const at = Math.max(0, time)
    const vel = this.mappedVelocity(velocity)
    const kind = drumKindFor(pitch)
    try {
      switch (kind) {
        case 'kick':
        case 'kickSoft': {
          const accent = kind === 'kickSoft' ? 0.7 : 1
          this.kick.triggerAttackRelease('C1', clamp(0.18 + this.releaseScale * 0.12, 0.12, 0.8), at, vel * accent)
          this.kickClick.triggerAttackRelease(0.012, at, vel * 0.5 * accent)
          break
        }
        case 'snare':
        case 'brush': {
          this.snareNoise.triggerAttackRelease(this.isBrush ? 0.12 : 0.16, at, vel * 0.9)
          if (!this.isBrush) this.snareBody.triggerAttackRelease('F#3', 0.09, at, vel * 0.55)
          else this.snareNoise.triggerAttackRelease(0.09, at + 0.018, vel * 0.4)
          break
        }
        case 'rim':
          this.rimNoise.triggerAttackRelease(0.03, at, vel * 0.75)
          this.snareBody.triggerAttackRelease('A3', 0.03, at, vel * 0.3)
          break
        case 'clap': {
          // 经典 clap：连续三次快速重触发形成「啪」的尾巴
          this.clapNoise.triggerAttackRelease(0.028, at, vel * 0.85)
          this.clapNoise.triggerAttackRelease(0.028, at + 0.011, vel * 0.7)
          this.clapNoise.triggerAttackRelease(0.05, at + 0.022, vel * 0.55)
          break
        }
        case 'tom': {
          const note = midiToNoteName(clamp(pitch, 40, 60))
          this.tom.triggerAttackRelease(note, clamp(0.24 + this.releaseScale * 0.1, 0.16, 0.7), at, vel * 0.85)
          break
        }
        case 'hatClosed':
          this.hatClosed.triggerAttackRelease(0.03, at, vel * 0.8)
          // choke：闭镲打断开镲
          this.hatOpen.triggerRelease(at)
          break
        case 'hatPedal':
          this.hatClosed.triggerAttackRelease(0.045, at, vel * 0.55)
          this.hatOpen.triggerRelease(at)
          break
        case 'hatOpen': {
          const openDur = clamp(0.18 + this.releaseScale * 0.14, 0.16, 0.6)
          this.hatOpen.triggerAttackRelease(openDur, at, vel * 0.75)
          break
        }
        case 'crash':
        case 'china':
        case 'splash': {
          const hz = kind === 'splash' ? 620 : kind === 'china' ? 360 : 430
          this.metalCymbal.frequency.value = hz
          const dur = kind === 'splash' ? 0.5 : kind === 'china' ? 1.2 : 1.6 * this.releaseScale
          this.metalCymbal.triggerAttackRelease(clamp(dur, 0.3, 3), at, vel * 0.8)
          break
        }
        case 'ride':
        case 'rideBell': {
          this.metalRide.frequency.value = kind === 'rideBell' ? 700 : 520
          this.metalRide.triggerAttackRelease(clamp(0.9 * this.releaseScale, 0.3, 2.4), at, vel * 0.55)
          break
        }
        case 'tambourine':
          this.miscNoise.triggerAttackRelease(0.06, at, vel * 0.5)
          this.metalBell.frequency.value = 2400
          this.metalBell.triggerAttackRelease(0.08, at, vel * 0.25)
          break
        case 'cowbell':
          this.metalBell.frequency.value = 820
          this.metalBell.triggerAttackRelease(0.1, at, vel * 0.55)
          break
        case 'bongo':
        case 'conga': {
          const note = midiToNoteName(clamp(pitch, 55, 72))
          this.tom.triggerAttackRelease(note, 0.16, at, vel * 0.6)
          break
        }
        case 'shaker':
          this.shakerNoise.triggerAttackRelease(0.06, at, vel * 0.6)
          break
        case 'woodblock':
          this.metalBell.frequency.value = 1200
          this.metalBell.triggerAttackRelease(0.05, at, vel * 0.45)
          break
        case 'triangleHit':
          this.metalBell.frequency.value = 3200
          this.metalBell.triggerAttackRelease(0.12, at, vel * 0.35)
          break
        default:
          this.miscNoise.triggerAttackRelease(0.06, at, vel * 0.5)
      }
      void durationSec
    } catch {
      /* ignore */
    }
  }

  noteOff(_time: number, _pitch: number): void {
    /* 鼓组是一次性发声，不需要 noteOff；持续音由 stopPreview / allNotesOff 处理 */
  }

  allNotesOff(time?: number): void {
    const at = time ?? Tone.immediate()
    const sustained: { triggerRelease(time: number): unknown }[] = [
      this.kick,
      this.snareBody,
      this.tom,
      this.metalCymbal,
      this.metalRide,
      this.metalBell,
    ]
    for (const node of sustained) {
      try {
        node.triggerRelease(at)
      } catch {
        /* ignore */
      }
    }
    for (const node of [this.kickClick, this.snareNoise, this.rimNoise, this.clapNoise, this.hatClosed, this.hatOpen, this.shakerNoise, this.miscNoise]) {
      try {
        node.triggerRelease(at)
      } catch {
        /* ignore */
      }
    }
  }

  dispose(): void {
    const nodes: { dispose(): unknown }[] = [
      this.kick,
      this.kickClick,
      this.snareNoise,
      this.snareBody,
      this.rimNoise,
      this.clapNoise,
      this.tom,
      this.hatClosed,
      this.hatOpen,
      this.metalCymbal,
      this.metalRide,
      this.metalBell,
      this.shakerNoise,
      this.miscNoise,
      this.brightFilter,
      this.drive,
      this.bus,
      this.output,
    ]
    for (const node of nodes) {
      try {
        node.dispose()
      } catch {
        /* ignore */
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 工厂                                                                */
/* ------------------------------------------------------------------ */

export function createInstrumentVoice(instrument: InstrumentDefinition, emotion: EmotionParams): InstrumentVoice {
  if (instrument.isDrumKit) return new DrumKitVoice(instrument, emotion)
  return new SynthVoice(instrument, emotion)
}
