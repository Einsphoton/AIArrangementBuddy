/**
 * 智能片段生成器（Logic Pro Session Player 风格）。
 *
 * 所有生成器都是纯函数：相同 seed + 参数 => 相同结果（id 除外），
 * 因此 AI、UI 与导出三方一致。
 *
 * 每个生成器产出「相对片段起点」的 NoteEvent[]，并遵循：
 * - 32 小节长片段里循环使用和弦进行，但每 2 / 4 小节有变化（乐句感）；
 * - density / complexity / energy / swing / humanize / gate 必须真实影响结果；
 * - 输出在 generateSmartClip 中统一做合法性兜底（音高 / 时值 / 力度 / id）。
 */
import { CHORDS, DRUM_MAP, STYLES, type ChordQualityId, type ScaleId, type StyleId } from '../constants.js'
import {
  chordPitches,
  counterpointAgainst,
  nearestChordToneInRange,
  progressionToChords,
  scalePitchesInRange,
  snapToScale,
  voiceLeadChords,
} from '../theory.js'
import {
  createNote,
  beatsPerBar,
  type ChordSpec,
  type NoteEvent,
  type SmartKind,
  type SmartParams,
  type TimeSignature,
} from '../model.js'
import { humanizeNotes } from '../style/humanize.js'
import {
  profileDensityScale,
  profileProgression,
  profileSwingAmount,
  profileVelocityScale,
  isUsableProfile,
  type StyleProfile,
} from '../style/profile.js'

export interface GenerateContext {
  kind: SmartKind
  style: StyleId
  key: string
  scale: ScaleId
  tempo: number
  timeSignature: TimeSignature
  /** 片段长度（小节） */
  bars: number
  params: SmartParams
  /**
   * 风格画像（可选）。由服务端从 `data/corpus/profiles/*.json` 加载后注入；
   * 不传时所有采样回落到中性值 —— 行为与引入画像之前完全一致。
   */
  profile?: StyleProfile
  /** 和弦进行（每项含持续拍数），空时用风格默认 */
  chords: ChordSpec[]
  seed: number
  /** 参考声部（用于对位、根据旋律配和声） */
  reference?: NoteEvent[]
  /** 轨道音域限制 */
  range?: { min: number; max: number }
}

export type GeneratorFn = (ctx: GenerateContext) => NoteEvent[]

/* ------------------------------------------------------------------ */
/* 随机数                                                              */
/* ------------------------------------------------------------------ */

/** mulberry32：快速、可复现的伪随机 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function createVariationSeed(seed: number, index: number): number {
  return (seed + Math.imul(index + 1, 0x9e3779b9)) >>> 0
}

/** 风格默认和弦进行 */
export const STYLE_PROGRESSIONS: Record<StyleId, string[]> = {
  classical: ['I', 'V', 'vi', 'IV'],
  rock: ['i', 'bVII', 'bVI', 'bVII'],
  electronic: ['i', 'VI', 'III', 'VII'],
  jazz: ['ii7', 'V7', 'Imaj7', 'Imaj7'],
  cinematic: ['i', 'VI', 'III', 'VII'],
  pop: ['I', 'V', 'vi', 'IV'],
  folk: ['I', 'IV', 'vi', 'V'],
  // 日摇：小调王道进行（i-VI-III-VII），副歌向 VI/III 借力
  jrock: ['i', 'VI', 'III', 'VII'],
  // JRPG：小调 + 自然小调 iv 与 VII-III 的调式交替，游戏配乐常用
  jrpg: ['i', 'iv', 'VII', 'III'],
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

const EPS = 1e-6

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5))
}

function pickOne<T>(rnd: () => number, arr: readonly T[]): T {
  return arr[Math.min(arr.length - 1, Math.floor(rnd() * arr.length))] as T
}

function chance(rnd: () => number, p: number): boolean {
  return rnd() < p
}

function totalBeats(ctx: GenerateContext): number {
  return Math.max(1, ctx.bars) * beatsPerBar(ctx.timeSignature)
}

function barBeatsOf(ctx: GenerateContext): number {
  return beatsPerBar(ctx.timeSignature)
}

/** 片段的乐句长度（小节）：8 小节以上按 4，4-7 按 2，短片段整段 */
function phraseLength(bars: number): number {
  if (bars >= 8) return 4
  if (bars >= 4) return 2
  return 1
}

/** 由 seed 派生的独立随机流（用于画像采样，避免干扰生成器自己的 rnd 序列） */
function profileRnd(ctx: GenerateContext): () => number {
  return mulberry32((ctx.seed ^ 0x9e3779b9) >>> 0)
}

/**
 * 有效密度 = 用户参数 × 语料画像的密度缩放。
 * 没有画像时缩放为 1，等价于原来的 `clamp01(ctx.params.density)`。
 */
function effectiveDensity(ctx: GenerateContext): number {
  const base = clamp01(ctx.params.density)
  if (!isUsableProfile(ctx.profile)) return base
  return clamp01(base * profileDensityScale(ctx.profile, ctx.kind))
}

/**
 * 有效 swing：用户明确给了非 0 就以用户为准，否则用画像里的律动偏移作为建议。
 * 这样既不会覆盖用户意图，也能在默认参数下自动贴近语料。
 */
function effectiveSwing(ctx: GenerateContext): number {
  const base = clamp01(ctx.params.swing)
  if (base > 0 || !isUsableProfile(ctx.profile)) return base
  return profileSwingAmount(ctx.profile) ?? base
}

function resolveChords(ctx: GenerateContext, beatsPerChord = 4): ChordSpec[] {
  const usable = (ctx.chords ?? []).filter((c) => c && c.beats > 0)
  if (ctx.params.followChords !== false && usable.length > 0) return usable
  // 有画像时，从语料高频功能进行里走一条；数据不足自动回落到风格默认
  const fromProfile = isUsableProfile(ctx.profile) ? profileProgression(ctx.profile, profileRnd(ctx), 4) : null
  const romans = fromProfile ?? STYLE_PROGRESSIONS[ctx.style] ?? STYLE_PROGRESSIONS.pop
  return progressionToChords(romans, ctx.key, ctx.scale, beatsPerChord)
}

function keyToPc(key: string): number {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const idx = names.indexOf(key)
  if (idx >= 0) return idx
  const flatMap: Record<string, number> = { Db: 1, Eb: 3, Gb: 6, Ab: 8, Bb: 10 }
  return flatMap[key] ?? 0
}

function clampPitchRange(pitch: number, range?: { min: number; max: number }): number {
  if (!range) return Math.max(0, Math.min(127, Math.round(pitch)))
  let p = Math.round(pitch)
  let guard = 0
  while (p < range.min && guard++ < 10) p += 12
  guard = 0
  while (p > range.max && guard++ < 10) p -= 12
  return Math.max(0, Math.min(127, p))
}

/** 在音域内、离 target 最近的指定 pitch-class 音高 */
function pitchForPc(pc: number, target: number, range?: { min: number; max: number }): number {
  const lo = range?.min ?? 0
  const hi = range?.max ?? 127
  const base: number[] = []
  for (let oct = 0; oct <= 10; oct++) {
    const p = oct * 12 + (((pc % 12) + 12) % 12)
    if (p >= lo && p <= hi) base.push(p)
  }
  if (!base.length) return clampPitchRange(72, range)
  return base.reduce((best, p) => (Math.abs(p - target) < Math.abs(best - target) ? p : best), base[0])
}

/** 应用摇摆：把后半拍往后推 */
function applySwing(beat: number, swing: number): number {
  if (swing <= 0) return beat
  const frac = beat % 1
  if (Math.abs(frac - 0.5) < 0.001) return beat + swing * 0.16
  if (Math.abs(frac - 0.25) < 0.001 || Math.abs(frac - 0.75) < 0.001) return beat + swing * 0.08
  return beat
}

function humanize(value: number, amount: number, rnd: () => number): number {
  return value + (rnd() * 2 - 1) * amount
}

function velocityFor(base: number, energy: number, rnd: () => number, humanizeAmt: number): number {
  const v = base * (0.55 + clamp01(energy) * 0.65)
  const jitter = (rnd() * 2 - 1) * 18 * clamp01(humanizeAmt)
  return Math.max(1, Math.min(127, Math.round(v + jitter)))
}

/** 把 UI 的 gate 参数映射为音符时值 */
function gated(duration: number, ctx: GenerateContext, min = 0.05): number {
  // gate 0.1 -> 0.39 倍（极短）/ 1.5 -> 1.58 倍（连奏）
  return Math.max(min, duration * (0.3 + clamp01(ctx.params.gate) * 0.85))
}

interface ChordSlot {
  chord: ChordSpec
  startBeat: number
  endBeat: number
  index: number
}

/** 把和弦进行平铺到整个片段长度（32 小节时循环使用） */
function chordSlots(ctx: GenerateContext): ChordSlot[] {
  const total = totalBeats(ctx)
  const chords = resolveChords(ctx, 4)
  const out: ChordSlot[] = []
  if (!chords.length) return out
  let cursor = 0
  let i = 0
  let guard = 0
  while (cursor < total - EPS && guard++ < 1024) {
    const chord = chords[i % chords.length]
    const beats = Math.max(0.25, chord.beats > 0 ? chord.beats : 4)
    const end = Math.min(total, cursor + beats)
    out.push({ chord, startBeat: cursor, endBeat: end, index: i })
    cursor = end
    i++
  }
  return out
}

/** 某拍所在的和弦槽（平铺版） */
function slotAtBeat(slots: ChordSlot[], beat: number): ChordSlot | null {
  for (const slot of slots) if (beat >= slot.startBeat - EPS && beat < slot.endBeat - EPS) return slot
  return slots.length ? slots[slots.length - 1] : null
}

function slotLength(slot: ChordSlot): number {
  return Math.max(0.25, slot.endBeat - slot.startBeat)
}

/* ------------------------------------------------------------------ */
/* 鼓                                                                  */
/* ------------------------------------------------------------------ */

type DrumId = keyof typeof DRUM_MAP

interface Groove {
  id: string
  /** 相对 4 拍小节的偏移（非 4/4 拍号会按比例缩放） */
  kick: number[]
  snare: number[]
  ghost: number[]
  /** 踩镲步长（0 = 不踩）；0.5 = 八分，0.25 = 十六分 */
  hatStep: number
  /** 只踩反拍（四踩风格） */
  offbeatHats?: boolean
  openHats: number[]
  ride: number[]
  rideSwing?: boolean
  hatPedal: number[]
  clap: number[]
  rim: number[]
  shaker: number[]
  tom?: number[]
  /** 定音鼓 / 低频打击 */
  timpani: number[]
  brush?: boolean
}

const GROOVES: Record<string, Groove> = {
  basic: {
    id: 'basic',
    kick: [0, 2],
    snare: [1, 3],
    ghost: [],
    hatStep: 0.5,
    openHats: [3.5],
    ride: [],
    hatPedal: [],
    clap: [],
    rim: [],
    shaker: [],
    timpani: [],
  },
  rock: {
    id: 'rock',
    kick: [0, 1.5, 2],
    snare: [1, 3],
    ghost: [],
    hatStep: 0.5,
    openHats: [3.5],
    ride: [],
    hatPedal: [],
    clap: [],
    rim: [],
    shaker: [],
    timpani: [],
  },
  halfTime: {
    id: 'halfTime',
    kick: [0, 2.5],
    snare: [2],
    ghost: [1.25, 3.75],
    hatStep: 0.5,
    openHats: [3.5],
    ride: [],
    hatPedal: [],
    clap: [],
    rim: [],
    shaker: [],
    timpani: [],
  },
  fourOnFloor: {
    id: 'fourOnFloor',
    kick: [0, 1, 2, 3],
    snare: [1, 3],
    ghost: [],
    hatStep: 0.5,
    offbeatHats: true,
    openHats: [1.5, 3.5],
    ride: [],
    hatPedal: [],
    clap: [1, 3],
    rim: [],
    shaker: [],
    timpani: [],
  },
  breakbeat: {
    id: 'breakbeat',
    kick: [0, 1.75, 2.5],
    snare: [1, 3.25],
    ghost: [1.25, 2.75, 3.75],
    hatStep: 0.25,
    openHats: [2.75],
    ride: [],
    hatPedal: [],
    clap: [],
    rim: [1.75],
    shaker: [],
    timpani: [],
  },
  swing: {
    id: 'swing',
    kick: [0, 2],
    snare: [1, 3],
    ghost: [1.5, 2.5, 3.5],
    hatStep: 0,
    openHats: [],
    ride: [0, 0.66, 1.33, 2, 2.66, 3.33],
    rideSwing: true,
    hatPedal: [1, 3],
    clap: [],
    rim: [],
    shaker: [],
    timpani: [],
    brush: true,
  },
  folk: {
    id: 'folk',
    kick: [0, 2],
    snare: [1, 3],
    ghost: [],
    hatStep: 0.5,
    openHats: [],
    ride: [],
    hatPedal: [],
    clap: [],
    rim: [],
    shaker: [0.5, 1.5, 2.5, 3.5],
    timpani: [],
  },
  cinematic: {
    id: 'cinematic',
    kick: [0, 2],
    snare: [],
    ghost: [],
    hatStep: 0,
    openHats: [],
    ride: [],
    hatPedal: [],
    clap: [],
    rim: [],
    shaker: [],
    timpani: [0, 2],
  },
  classical: {
    id: 'classical',
    kick: [0],
    snare: [],
    ghost: [],
    hatStep: 0,
    openHats: [],
    ride: [],
    hatPedal: [],
    clap: [],
    rim: [],
    shaker: [],
    timpani: [0, 2],
  },
  /** 日摇：军鼓 backbeat + 切分底鼓 + 16 分踩镲 */
  jrock: {
    id: 'jrock',
    kick: [0, 1.5, 2.5],
    snare: [1, 3],
    ghost: [],
    hatStep: 0.25,
    openHats: [1.5, 3.5],
    ride: [],
    hatPedal: [],
    clap: [],
    rim: [],
    shaker: [],
    timpani: [],
  },
  /** JRPG：管弦摇滚混合，八分踩镲 + 定音鼓重音 + 切分底鼓 */
  jrpg: {
    id: 'jrpg',
    kick: [0, 1.5, 2, 3.5],
    snare: [1, 3],
    ghost: [],
    hatStep: 0.5,
    openHats: [3.5],
    ride: [],
    hatPedal: [],
    clap: [],
    rim: [],
    shaker: [],
    timpani: [0, 2],
  },
}

const STYLE_GROOVE: Record<StyleId, string> = {
  pop: 'basic',
  rock: 'rock',
  electronic: 'fourOnFloor',
  jazz: 'swing',
  cinematic: 'cinematic',
  classical: 'classical',
  folk: 'folk',
  jrock: 'jrock',
  jrpg: 'jrpg',
}

function resolveGroove(ctx: GenerateContext): Groove {
  const wanted = ctx.params.patternId
  if (wanted && GROOVES[wanted]) return GROOVES[wanted]
  return GROOVES[STYLE_GROOVE[ctx.style] ?? 'basic'] ?? GROOVES.basic
}

const drums: GeneratorFn = (ctx) => {
  const rnd = mulberry32(ctx.seed)
  const barBeats = barBeatsOf(ctx)
  const bars = Math.max(1, Math.round(ctx.bars))
  const density = effectiveDensity(ctx)
  const complexity = clamp01(ctx.params.complexity)
  const energy = clamp01(ctx.params.energy)
  const humanizeAmt = clamp01(ctx.params.humanize)
  const groove = resolveGroove(ctx)
  const meterScale = barBeats / 4
  const notes: NoteEvent[] = []
  const seen = new Set<string>()
  const swing = effectiveSwing(ctx)

  const push = (drum: DrumId, offsetBeats: number, baseVel: number, baseDur: number) => {
    const start = offsetBeats
    const key = `${DRUM_MAP[drum]}_${Math.round(start * 96)}`
    if (seen.has(key)) return
    seen.add(key)
    const dur = Math.max(0.02, gated(baseDur, ctx, 0.02))
    notes.push(
      createNote(
        DRUM_MAP[drum],
        Math.max(0, humanize(start, humanizeAmt * 0.008, rnd)),
        dur,
        velocityFor(baseVel, energy, rnd, humanizeAmt),
      ),
    )
  }

  const fillBars = new Set<number>()
  if (bars >= 2 && complexity > 0.22) {
    for (let b = phraseLength(bars) - 1; b < bars; b += phraseLength(bars)) fillBars.add(b)
    if (!fillBars.has(bars - 1)) fillBars.add(bars - 1)
  }

  for (let bar = 0; bar < bars; bar++) {
    const barStart = bar * barBeats
    const phrasePos = bar % phraseLength(bars)
    const isPhraseStart = phrasePos === 0
    const isFillBar = fillBars.has(bar) && bars >= 2
    const fillBeats = isFillBar ? (complexity > 0.68 ? Math.min(2, barBeats / 2) : 1) : 0
    const fillFrom = barBeats - fillBeats
    const inFill = (offset: number) => isFillBar && offset >= fillFrom - EPS

    /* 底鼓 */
    for (const off of groove.kick) {
      const offset = off * meterScale
      if (offset >= barBeats - EPS) continue
      if (groove.id === 'swing' && off % 1 !== 0) {
        if (density < 0.6) continue
      }
      if (inFill(offset) && complexity > 0.5) continue
      const vel = groove.id === 'swing' ? 58 : off % 1 === 0 ? 112 : 92
      push('kick', barStart + offset, vel, 0.25)
    }
    if (complexity > 0.5 && density > 0.45 && bar % 2 === 1) {
      const extra = barBeats - 0.5
      if (!inFill(extra)) push('kick', barStart + extra, 72, 0.22)
    }
    if (energy > 0.72 && complexity > 0.6 && bar % 4 === 2) {
      if (!inFill(2.75 * meterScale)) push('kick', barStart + 2.75 * meterScale, 78, 0.2)
    }

    /* 军鼓 / 刷奏 */
    for (const off of groove.snare) {
      const offset = off * meterScale
      if (offset >= barBeats - EPS) continue
      if (inFill(offset)) continue
      if (groove.brush) {
        push('snareBrush', barStart + offset, 66, 0.3)
        push('hatPedal', barStart + offset, 58, 0.12)
      } else {
        push('snare', barStart + offset, offset % 1 === 0 ? 108 : 92, 0.2)
      }
    }

    /* ghost note */
    const ghostBudget = Math.round(density * 3 + complexity * 2)
    if (ghostBudget > 0) {
      const positions = groove.ghost.length
        ? groove.ghost
        : [0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75]
      let placed = 0
      for (const off of positions) {
        if (placed >= ghostBudget) break
        const offset = off * meterScale
        if (offset >= barBeats - EPS) continue
        if (inFill(offset)) continue
        if (!chance(rnd, 0.35 + complexity * 0.45)) continue
        push('snare', barStart + offset, 26 + Math.round(energy * 14), 0.1)
        placed++
      }
    }

    /* 踩镲 / 骑镲 */
    if (groove.hatStep > 0 && !groove.brush) {
      const step = groove.hatStep * meterScale
      const startOffset = groove.offbeatHats ? step / 2 : 0
      for (let off = startOffset; off < barBeats - EPS; off += step) {
        if (inFill(off)) continue
        if (groove.offbeatHats && groove.openHats.some((h) => Math.abs(h * meterScale - off) < 0.01)) {
          push('hatOpen', barStart + applySwing(off, swing), 58 + energy * 16, 0.4)
          continue
        }
        if (density < 0.28 && Math.abs(off % 1) > 0.01) continue
        if (groove.hatStep <= 0.25 && density < 0.55 && Math.abs((off * 4) % 2) > 0.01) continue
        push('hatClosed', barStart + applySwing(off, swing), 70 + Math.round(energy * 12), 0.07)
        // 十六分加花：高密度时在八分之间补一颗
        if (density > 0.72 && complexity > 0.4 && groove.hatStep <= 0.25 + EPS) {
          const mid = off + step / 2
          if (mid < barBeats - EPS) push('hatClosed', barStart + mid, 46 + Math.round(energy * 12), 0.05)
        }
      }
      for (const off of groove.openHats) {
        const offset = off * meterScale
        if (offset >= barBeats - EPS) continue
        if (groove.offbeatHats) continue
        if (density < 0.42) continue
        if (inFill(offset)) continue
        push('hatOpen', barStart + applySwing(offset, swing), 64 + energy * 18, 0.38)
      }
    }

    /* 骑镲（爵士） */
    for (const off of groove.ride) {
      const offset = off * meterScale
      if (offset >= barBeats - EPS) continue
      push('ride', barStart + (groove.rideSwing ? applySwing(offset, Math.max(0.35, swing)) : offset), 58 + Math.round(energy * 16), 0.12)
      if (complexity > 0.7 && bar % 4 === 3) {
        push('rideBell', barStart + offset, 50, 0.1)
      }
    }

    /* 拍手 / 边击 / 沙锤 / 定音鼓 */
    for (const off of groove.clap) {
      const offset = off * meterScale
      if (offset < barBeats - EPS && energy > 0.45) push('clap', barStart + offset, 88, 0.14)
    }
    for (const off of groove.rim) {
      const offset = off * meterScale
      if (offset < barBeats - EPS && density > 0.5) push('snareRim', barStart + offset, 60, 0.1)
    }
    for (const off of groove.shaker) {
      const offset = off * meterScale
      if (offset < barBeats - EPS && density > 0.35) push('shaker', barStart + offset, 52 + Math.round(energy * 14), 0.08)
    }
    for (const off of groove.timpani) {
      const offset = off * meterScale
      if (offset >= barBeats - EPS) continue
      if (isFillBar && offset >= fillFrom) continue
      const vel = offset === 0 ? 104 : 86
      push('tomLow', barStart + offset, vel, 0.6)
      if (complexity > 0.6 && offset === 0 && energy > 0.6) push('tomMidLow', barStart + offset, 74, 0.5)
    }
    if (groove.tom) {
      for (const off of groove.tom) {
        const offset = off * meterScale
        if (offset < barBeats - EPS && !inFill(offset)) push('tomMid', barStart + offset, 78, 0.2)
      }
    }

    /* 加花：桶鼓下行 / 军鼓滚奏 */
    if (isFillBar) {
      const fillStart = barBeats - fillBeats
      const fillToms: DrumId[] = ['tomHigh', 'tomMidHigh', 'tomMid', 'tomMidLow', 'tomLow']
      const stepSize = complexity > 0.68 ? 0.25 : 0.5
      const steps = Math.max(1, Math.round(fillBeats / stepSize))
      for (let s = 0; s < steps; s++) {
        const offset = fillStart + s * stepSize
        if (offset >= barBeats - EPS) break
        const useSnare = complexity > 0.55 && s === 0
        const drum = useSnare ? 'snare' : fillToms[Math.min(fillToms.length - 1, Math.floor((s / steps) * fillToms.length))]
        const ramp = 0.8 + (s / steps) * 0.35
        push(drum, barStart + applySwing(offset, swing), Math.round(96 * ramp), 0.12)
        if (complexity > 0.78 && s % 2 === 1) {
          push('snare', barStart + offset + stepSize / 2, Math.round(72 * ramp), 0.08)
        }
      }
    }

    /* 段落起点镲片 */
    if (isPhraseStart && energy > 0.42 && groove.id !== 'classical') {
      push('crash', barStart, 82 + Math.round(energy * 28), 1.1)
    }
  }

  return notes
}

/* ------------------------------------------------------------------ */
/* 低音                                                                */
/* ------------------------------------------------------------------ */

function rootPitchFor(ctx: GenerateContext, rootPc: number, range: { min: number; max: number }): number {
  const octave = Math.max(0, Math.min(6, Math.round(ctx.params.octave)))
  return pitchForPc(rootPc, (octave + 1) * 12, range)
}

/** 把贝斯锁在「旋律之下」，避免与主旋律音域相撞 */
function bassRange(ctx: GenerateContext, fallback: { min: number; max: number }): { min: number; max: number } {
  let range = ctx.range ? { ...ctx.range } : { ...fallback }
  const ref = ctx.reference?.filter((n) => Number.isFinite(n.pitch)) ?? []
  if (ref.length) {
    const melodyMin = Math.min(...ref.map((n) => n.pitch))
    const cap = melodyMin - 5
    if (cap > range.min + 7) range = { min: range.min, max: Math.min(range.max, cap) }
  }
  return range
}

function chordIntervals(chord: ChordSpec): number[] {
  const def = CHORDS[chord.quality]
  return def ? def.intervals : [0, 4, 7]
}

const bass: GeneratorFn = (ctx) => {
  const rnd = mulberry32(ctx.seed)
  const slots = chordSlots(ctx)
  if (!slots.length) return []
  const notes: NoteEvent[] = []
  const range = bassRange(ctx, { min: 28, max: 55 })
  const density = effectiveDensity(ctx)
  const complexity = clamp01(ctx.params.complexity)
  const energy = clamp01(ctx.params.energy)
  const swing = effectiveSwing(ctx)
  const pattern = ctx.params.patternId
  const style = ctx.style
  const walking = pattern === 'walking' || (style === 'jazz' && pattern !== 'root' && pattern !== 'pumping' && pattern !== 'syncopated')

  const push = (pitch: number, start: number, duration: number, baseVel: number) => {
    if (start < -EPS || start >= totalBeats(ctx) - EPS) return
    notes.push(
      createNote(
        clampPitchRange(pitch, range),
        Math.max(0, humanize(start, clamp01(ctx.params.humanize) * 0.012, rnd)),
        Math.max(0.08, gated(duration, ctx)),
        velocityFor(baseVel, energy, rnd, ctx.params.humanize),
      ),
    )
  }

  /** 走路贝斯：每拍一个音，级进接近下一个和弦根音 */
  if (walking) {
    const scalePool = scalePitchesInRange(ctx.key, ctx.scale, range)
    let prevPitch = 0
    for (const slot of slots) {
      const beats = Math.max(0.5, slotLength(slot))
      const steps = Math.max(1, Math.round(beats))
      const root = rootPitchFor(ctx, slot.chord.root, range)
      const nextSlot = slots[slot.index + 1]
      const nextRoot = nextSlot ? rootPitchFor(ctx, nextSlot.chord.root, range) : root
      for (let s = 0; s < steps; s++) {
        const start = slot.startBeat + s * (beats / steps)
        if (start >= totalBeats(ctx) - EPS) break
        let pitch: number
        if (s === 0) {
          pitch = root
        } else if (s === steps - 1 && nextSlot) {
          // 最后一拍：半音/全音接近下一个根音
          const dir = nextRoot > root ? -1 : 1
          const near = nextRoot + dir
          pitch = near >= range.min && near <= range.max ? near : nextRoot
        } else {
          // 走路贝斯：在和弦音之间级进上行，走到高处再折返，避免原地重复
          const candidates = chordIntervals(slot.chord)
            .map((iv) => pitchForPc(slot.chord.root + iv, prevPitch + 4, range))
            .filter((p) => p >= range.min && p <= range.max)
          const unique = [...new Set(candidates)].sort((a, b) => a - b)
          const up = unique.filter((p) => p > prevPitch + 1)
          const down = [...unique].reverse().filter((p) => p < prevPitch - 1)
          const preferUp = prevPitch < (range.min + range.max) / 2 + 2 || s % 2 === 1
          pitch =
            (preferUp ? up[0] : down[0]) ??
            up[0] ??
            down[0] ??
            clampPitchRange(snapToScale(prevPitch + 2, ctx.key, ctx.scale), range)
          void scalePool
          void rnd
        }
        push(pitch, start, (beats / steps) * 0.92, s === 0 ? 100 : 84)
        prevPitch = pitch
      }
    }
    return notes
  }

  for (const slot of slots) {
    const beats = Math.max(0.5, slotLength(slot))
    const root = rootPitchFor(ctx, slot.chord.root, range)
    const intervals = chordIntervals(slot.chord)
    const fifth = pitchForPc(slot.chord.root + (intervals[2] ?? 7), root, range)
    const octave = pitchForPc(slot.chord.root + 12, root, range)
    const third = pitchForPc(slot.chord.root + (intervals[1] ?? 4), root, range)
    const nextSlot = slots[slot.index + 1]
    const nextRoot = nextSlot ? rootPitchFor(ctx, nextSlot.chord.root, range) : root

    let offsets: number[]
    let useShort = false
    if (pattern === 'root' || density < 0.3) {
      offsets = [0]
      if (beats >= 4 && density >= 0.2) offsets.push(beats / 2)
    } else if (pattern === 'pumping' || style === 'electronic') {
      offsets = []
      const step = density > 0.62 ? 0.5 : 1
      for (let o = 0; o < beats - EPS; o += step) offsets.push(o)
      useShort = density > 0.62
    } else if (style === 'classical' || style === 'cinematic') {
      offsets = [0]
      if (beats >= 4) offsets.push(beats * 0.5)
      if (beats >= 6) offsets.push(beats * 0.75)
    } else if (style === 'rock') {
      offsets = density > 0.55 ? [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] : [0, 1, 2, 3]
      useShort = density > 0.55
    } else if (style === 'folk') {
      offsets = [0, 1, 2, 3]
      useShort = false
    } else if (style === 'jrock') {
      // 日摇：16 分音符驱动（高密度时全 16 分，常规为 8 分根音推进）
      offsets = []
      const step = density > 0.58 ? 0.25 : 0.5
      for (let o = 0; o < beats - EPS; o += step) offsets.push(o)
      useShort = true
    } else if (style === 'jrpg') {
      // JRPG：低音弦乐 ostinato（八分音符持续推动，弱密度回到四分）
      offsets = []
      const step = density > 0.5 ? 0.5 : 1
      for (let o = 0; o < beats - EPS; o += step) offsets.push(o)
      useShort = true
    } else if (pattern === 'syncopated') {
      offsets = density > 0.6 ? [0, 0.75, 1.5, 2.5, 3.25] : [0, 1.5, 2.5]
      useShort = density > 0.5
    } else {
      // pop / 其他：根音 + 切分
      offsets = density > 0.62 ? [0, 0.75, 1.5, 2, 2.75, 3.5] : density > 0.35 ? [0, 1.5, 2, 3.5] : [0, 2]
      useShort = density > 0.62
    }
    offsets = offsets.filter((o) => o < beats - EPS)
    if (offsets.length === 0) offsets = [0]

    offsets.forEach((off, i) => {
      const start = slot.startBeat + applySwing(off, swing)
      if (start >= totalBeats(ctx) - EPS) return
      if (pattern !== 'root' && chance(rnd, (1 - density) * 0.18)) return
      let pitch: number
      const rel = off / Math.max(1, beats)
      if (i === 0) pitch = root
      else if (complexity > 0.6 && off > beats - 0.75 && nextSlot && Math.abs(nextRoot - root) > 2 && density > 0.45) {
        // 预备音：提前接近下一个根音
        pitch = nextRoot > root ? nextRoot - 1 : nextRoot + 1
      } else if (rel > 0.75 && complexity > 0.55) pitch = useShort ? octave : fifth
      else if (rel > 0.45 && complexity > 0.4) pitch = chance(rnd, 0.6) ? fifth : third
      else pitch = chance(rnd, 0.4 + complexity * 0.3) ? root : fifth
      const dur = useShort ? Math.min(0.5, (beats / offsets.length) * 0.9) : (i + 1 < offsets.length ? offsets[i + 1] - off : beats - off) * 0.95
      push(pitch, start, Math.max(0.12, dur), i === 0 ? (off === 0 ? 104 : 92) : 82)
    })
  }
  return notes
}

/* ------------------------------------------------------------------ */
/* 和弦 / 铺底                                                          */
/* ------------------------------------------------------------------ */

function voicedChords(ctx: GenerateContext, octave: number): number[][] {
  const chords = resolveChords(ctx, 4)
  if (!chords.length) return []
  return voiceLeadChords(chords, octave, ctx.range)
}

/** 高叠和弦的颜色音（9 度 / 6 度），让和弦不只是三和弦 */
function colorInterval(quality: ChordQualityId, complexity: number): number[] {
  if (complexity < 0.55) return []
  if (quality === 'maj' || quality === 'maj7') return complexity > 0.75 ? [14] : [14]
  if (quality === 'min' || quality === 'min7') return [10, 14]
  if (quality === 'dom7' || quality === 'dom9') return [14]
  return []
}

const chordsGen: GeneratorFn = (ctx) => {
  const rnd = mulberry32(ctx.seed)
  const slots = chordSlots(ctx)
  if (!slots.length) return []
  const notes: NoteEvent[] = []
  const density = effectiveDensity(ctx)
  const complexity = clamp01(ctx.params.complexity)
  const energy = clamp01(ctx.params.energy)
  const swing = effectiveSwing(ctx)
  const octave = Math.max(1, Math.min(6, Math.round(ctx.params.octave)))
  const voiced = voicedChords(ctx, octave)
  const pattern = ctx.params.patternId
  const stab = pattern === 'stab' || pattern === 'syncopated' || (styleNeedsStabs(ctx.style) && density > 0.62)

  const pushVoicing = (slot: ChordSlot, start: number, duration: number, baseVel: number, withColor = false) => {
    if (start < -EPS || start >= totalBeats(ctx) - EPS) return
    const voicing = voiced[slot.index % Math.max(1, voiced.length)] ?? []
    const chordTones = voicing.length ? voicing : chordPitches(slot.chord, octave)
    const pitches = [...chordTones]
    if (withColor) {
      for (const iv of colorInterval(slot.chord.quality, complexity)) {
        pitches.push(clampPitchRange(pitchForPc(slot.chord.root + iv, chordTones[chordTones.length - 1] + 3, ctx.range), ctx.range))
      }
    }
    for (const pitch of pitches) {
      notes.push(
        createNote(
          clampPitchRange(pitch, ctx.range),
          Math.max(0, humanize(start, clamp01(ctx.params.humanize) * 0.01, rnd)),
          Math.max(0.1, gated(duration, ctx)),
          velocityFor(baseVel, energy, rnd, ctx.params.humanize),
        ),
      )
    }
  }

  slots.forEach((slot, idx) => {
    const beats = Math.max(0.5, slotLength(slot))
    const accent = Math.round(energy * 10) + (idx % 2 === 0 ? 4 : 0)
    if (stab) {
      const base: number[] = density > 0.72 ? [0, 0.75, 1.5, 2.5, 3.25] : [0, 1.5, 2.5]
      for (const off of base) {
        if (off >= beats - EPS) continue
        if (off > 0 && !chance(rnd, 0.55 + complexity * 0.4)) continue
        const start = slot.startBeat + applySwing(off, swing)
        pushVoicing(slot, start, 0.22 + complexity * 0.14, 86 + accent, false)
      }
      // 切分提前量：在换和弦前半拍轻击下一个和弦
      if (complexity > 0.62 && beats >= 2) {
        const next = slots[idx + 1]
        if (next) pushVoicing(next, slot.startBeat + beats - 0.5, 0.2, 70, false)
      }
    } else {
      const splits = density > 0.7 ? 2 : 1
      const step = beats / splits
      for (let s = 0; s < splits; s++) {
        pushVoicing(slot, slot.startBeat + s * step, step * (splits > 1 ? 0.82 : 0.95), 82 + accent, complexity > 0.55)
      }
    }
  })
  return notes
}

function styleNeedsStabs(style: StyleId): boolean {
  return style === 'jazz' || style === 'electronic' || style === 'rock' || style === 'pop' || style === 'jrock' || style === 'jrpg'
}

const pad: GeneratorFn = (ctx) => {
  const rnd = mulberry32(ctx.seed)
  const slots = chordSlots(ctx)
  if (!slots.length) return []
  const notes: NoteEvent[] = []
  const energy = clamp01(ctx.params.energy)
  const density = effectiveDensity(ctx)
  const complexity = clamp01(ctx.params.complexity)
  const octave = Math.max(1, Math.min(6, Math.round(ctx.params.octave)))
  const voiced = voicedChords(ctx, octave)
  const total = totalBeats(ctx)

  const push = (pitch: number, start: number, dur: number, baseVel: number) => {
    if (start < -EPS || start >= total - EPS) return
    notes.push(
      createNote(
        clampPitchRange(pitch, ctx.range),
        Math.max(0, humanize(start, clamp01(ctx.params.humanize) * 0.02, rnd)),
        Math.max(0.25, gated(dur, ctx, 0.2)),
        velocityFor(baseVel, energy, rnd, ctx.params.humanize),
      ),
    )
  }

  slots.forEach((slot) => {
    const beats = Math.max(0.5, slotLength(slot))
    const voicing = voiced[slot.index % Math.max(1, voiced.length)] ?? chordPitches(slot.chord, octave)
    const dur = Math.min(beats * 1.02, total - slot.startBeat)
    for (const pitch of voicing) {
      // 音量随乐句呼吸（弱-强-弱），用不同力度模拟起音/收束
      const breathing = 70 + Math.sin((slot.startBeat / Math.max(1, barBeatsOf(ctx))) * Math.PI) * 8
      push(pitch, slot.startBeat, dur, breathing)
    }
    // 低音根音
    if (slot.index % 2 === 0 || density > 0.4) {
      const rootPitch = pitchForPc(slot.chord.root, (octave + 1) * 12 - 12, ctx.range)
      push(rootPitch, slot.startBeat, dur * 0.98, 78)
    }
    // 顶声部小旋律：复杂度高时长音上做一点级进流动
    if (complexity > 0.5 && beats >= 2) {
      const top = voicing[voicing.length - 1] ?? voicing[0]
      const neighbor = clampPitchRange(snapToScale(top + (chance(rnd, 0.5) ? 2 : -2), ctx.key, ctx.scale), ctx.range)
      push(neighbor, slot.startBeat + beats * 0.5, beats * 0.48, 64)
    }
    if (density > 0.66) {
      const top = voicing[voicing.length - 1] ?? voicing[0]
      push(clampPitchRange(top + 12, ctx.range), slot.startBeat, dur * 0.6, 58)
    }
  })
  return notes
}

/* ------------------------------------------------------------------ */
/* 琶音                                                                */
/* ------------------------------------------------------------------ */

const ARP_PATTERNS = ['up', 'down', 'updown', 'random', 'pedal'] as const
type ArpPattern = (typeof ARP_PATTERNS)[number]

/** 构建琶音音池：和弦音铺开 2 个八度，收进音域 */
function arpPool(ctx: GenerateContext, chord: ChordSpec, octave: number): number[] {
  const base = chordPitches(chord, octave)
  const range = ctx.range
  const out: number[] = []
  for (const p of base) {
    for (let oct = 0; oct <= 2; oct++) {
      const pitch = p + oct * 12
      if (pitch >= 0 && pitch <= 127) {
        const clamped = range ? clampPitchRange(pitch, range) : pitch
        if (clamped >= 0 && clamped <= 127) out.push(clamped)
      }
    }
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

function arpSequence(pool: number[], pattern: ArpPattern, rnd: () => number): number[] {
  if (pool.length <= 1) return pool
  switch (pattern) {
    case 'down':
      return [...pool].reverse()
    case 'updown':
      return [...pool, ...[...pool].reverse().slice(1, -1)]
    case 'pedal': {
      const upper = pool.slice(1)
      const seq: number[] = []
      for (const u of upper) seq.push(pool[0], u)
      return seq
    }
    case 'random': {
      const seq: number[] = []
      for (let i = 0; i < pool.length * 2; i++) seq.push(pool[Math.floor(rnd() * pool.length)])
      return seq
    }
    case 'up':
    default:
      return pool
  }
}

const arp: GeneratorFn = (ctx) => {
  const rnd = mulberry32(ctx.seed)
  const slots = chordSlots(ctx)
  if (!slots.length) return []
  const notes: NoteEvent[] = []
  const density = effectiveDensity(ctx)
  const complexity = clamp01(ctx.params.complexity)
  const energy = clamp01(ctx.params.energy)
  const swing = effectiveSwing(ctx)
  const octave = Math.max(2, Math.min(6, Math.round(ctx.params.octave) - 1))
  const total = totalBeats(ctx)
  const bpb = barBeatsOf(ctx)
  const wanted = ctx.params.patternId
  const basePattern: ArpPattern =
    wanted && (ARP_PATTERNS as readonly string[]).includes(wanted)
      ? (wanted as ArpPattern)
      : (pickOne(rnd, ['up', 'down', 'updown'] as ArpPattern[]))
  let pattern = basePattern
  let seq: number[] = []

  slots.forEach((slot, idx) => {
    const beats = slotLength(slot)
    const pool = arpPool(ctx, slot.chord, octave)
    if (!pool.length) return
    // 每 2 小节换方向 / 起点，长片段不会一成不变
    if (idx % 2 === 0 || !seq.length) {
      pattern = idx === 0 ? basePattern : chance(rnd, 0.45 + complexity * 0.35) ? pickOne(rnd, ARP_PATTERNS.slice(0, 5) as readonly ArpPattern[]) : pattern
      seq = arpSequence(pool, pattern, rnd)
    }
    const startShift = 0
    // 步长：密度决定 16/8 分；复杂度高时奇数小节切三连音
    const isTripletBar = complexity > 0.58 && Math.floor(slot.startBeat / Math.max(1, bpb)) % 2 === 1
    const step = isTripletBar ? 1 / 3 : density > 0.68 ? 0.25 : density > 0.34 ? 0.5 : 1
    const accents = isTripletBar ? 3 : 4
    let i = startShift
    for (let off = 0; off < beats - EPS / 2; off += step) {
      const start = slot.startBeat + applySwing(off, swing)
      if (start >= total - EPS) break
      if (density < 0.3 && off % 1 > 0.01) continue
      const pitch = seq[i % Math.max(1, seq.length)] ?? pool[0]
      const isAccent = i % accents === 0
      const octaveJump = complexity > 0.7 && isAccent && chance(rnd, 0.18) ? 12 : 0
      notes.push(
        createNote(
          clampPitchRange(pitch + octaveJump, ctx.range),
          Math.max(0, humanize(start, clamp01(ctx.params.humanize) * 0.008, rnd)),
          Math.max(0.05, gated(step * 0.92, ctx)),
          velocityFor(isAccent ? 92 : 72 - (i % 6) * 2, energy, rnd, ctx.params.humanize),
        ),
      )
      i++
    }
  })
  return notes
}

/* ------------------------------------------------------------------ */
/* 旋律                                                                */
/* ------------------------------------------------------------------ */

const MELODY_RHYTHMS: number[][] = [
  [1, 0.5, 0.5, 1, 1],
  [0.5, 0.5, 1, 1, 1],
  [1, 1, 1, 1],
  [0.75, 0.25, 1, 1, 1],
  [1.5, 0.5, 1, 1],
  [0.5, 0.5, 0.5, 0.5, 1, 1],
  [1.5, 0.5, 0.5, 0.5, 1],
  [0.5, 1, 0.5, 1, 1],
  [2, 1, 1],
]

const LYRIC_RHYTHMS: number[][] = [
  [1.5, 0.5, 2],
  [2, 1, 1],
  [1.5, 1.5, 1],
  [2, 2],
]

/** 变奏节奏：拆分/合并/交换，总时值保持不变 */
function varyRhythm(rhythm: number[], rnd: () => number): number[] {
  const r = [...rhythm]
  if (r.length < 2) return r
  const mode = Math.floor(rnd() * 3)
  if (mode === 0) {
    const i = Math.floor(rnd() * (r.length - 1))
    const t = r[i]
    r[i] = r[i + 1]
    r[i + 1] = t
  } else if (mode === 1) {
    const candidates = r.map((v, i) => ({ v, i })).filter((x) => x.v >= 1)
    if (candidates.length) {
      const { v, i } = candidates[Math.floor(rnd() * candidates.length)]
      r.splice(i, 1, v / 2, v / 2)
    }
  } else {
    const i = Math.floor(rnd() * (r.length - 1))
    r.splice(i, 2, r[i] + r[i + 1])
  }
  return r
}

/** 从参考声部提取节奏骨架（用于「按已有旋律动机写新旋律」） */
function referenceRhythm(ctx: GenerateContext, bpb: number): number[] | null {
  const ref = ctx.reference?.filter((n) => n.start < totalBeats(ctx)).sort((a, b) => a.start - b.start)
  if (!ref || ref.length < 2) return null
  const inBar = ref.filter((n) => n.start < bpb)
  if (inBar.length < 2) return null
  const durs: number[] = []
  let sum = 0
  for (const n of inBar) {
    const d = Math.max(0.125, Math.min(bpb, n.duration))
    durs.push(d)
    sum += d
    if (durs.length >= 8) break
  }
  if (sum <= 0 || durs.length < 2) return null
  const scale = bpb / sum
  const scaled = durs.map((d) => Math.max(0.125, Math.round(d * scale * 8) / 8))
  // 修正总长
  const diff = bpb - scaled.reduce((a, b) => a + b, 0)
  if (Math.abs(diff) < 0.26) scaled[scaled.length - 1] = Math.max(0.25, scaled[scaled.length - 1] + diff)
  return scaled
}

function nearestIndex(pool: number[], pitch: number): number {
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < pool.length; i++) {
    const d = Math.abs(pool[i] - pitch)
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  }
  return best
}

const melody: GeneratorFn = (ctx) => {
  const rnd = mulberry32(ctx.seed)
  const bpb = barBeatsOf(ctx)
  const bars = Math.max(1, Math.round(ctx.bars))
  const total = totalBeats(ctx)
  const slots = chordSlots(ctx)
  const density = effectiveDensity(ctx)
  const complexity = clamp01(ctx.params.complexity)
  const energy = clamp01(ctx.params.energy)
  const octave = Math.max(2, Math.min(6, Math.round(ctx.params.octave)))
  const center = clampPitchRange((octave + 1) * 12, ctx.range)
  const range = ctx.range ?? { min: Math.max(0, center - 14), max: Math.min(127, center + 16) }
  const pool = scalePitchesInRange(ctx.key, ctx.scale, {
    min: Math.max(0, Math.min(center - 12, range.min)),
    max: Math.min(127, Math.max(center + 16, range.max)),
  })
  if (!pool.length) return []
  const pLen = phraseLength(bars)
  const phrases = Math.max(1, Math.ceil(bars / pLen))
  const wantLyrical = ctx.params.patternId === 'lyrical'
  const wantSequence = ctx.params.patternId === 'sequence'
  // 密度低用长句（呼吸感），密度高用密集节奏（推动感）
  const denseRhythms = MELODY_RHYTHMS.filter((r) => r.length >= 5)
  const rhythmPool =
    wantLyrical || density < 0.35 ? LYRIC_RHYTHMS : density > 0.72 ? denseRhythms : MELODY_RHYTHMS
  const rhythm = referenceRhythm(ctx, bpb) ?? pickOne(rnd, rhythmPool)
  const motifLen = Math.max(2, rhythm.length)

  // 动机轮廓：拱形 / 下行 / 上行 / 波浪（乐句呼吸的核心）
  const shape = pickOne(rnd, ['arch', 'wave', 'descend', 'ascend'] as const)
  const motifIdx: number[] = []
  let idx = nearestIndex(pool, clampPitchRange(center + (rnd() * 8 - 4), range))
  for (let i = 0; i < motifLen; i++) {
    motifIdx.push(idx)
    let dir: number
    if (shape === 'arch') dir = i + 1 <= motifLen / 2 ? 1 : -1
    else if (shape === 'ascend') dir = 1
    else if (shape === 'descend') dir = -1
    else dir = (i % 2 === 0 ? 1 : -1) * (rnd() < 0.5 ? 1 : 2)
    const stepSize = rnd() < 0.22 + complexity * 0.25 ? 2 : 1
    idx = Math.max(0, Math.min(pool.length - 1, idx + dir * stepSize))
  }

  // 模进：每个乐句把动机平移若干音级
  const sequenceSteps = wantSequence ? [0, 2, 2, -1] : [0, 2, 1, -1]
  const notes: NoteEvent[] = []
  let lastPitch = -1
  const push = (pitch: number, start: number, dur: number, accented: boolean) => {
    if (start < -EPS || start >= total - EPS) return
    notes.push(
      createNote(
        clampPitchRange(pitch, range),
        Math.max(0, humanize(start, clamp01(ctx.params.humanize) * 0.012, rnd)),
        Math.max(0.08, gated(dur, ctx, 0.08)),
        velocityFor(accented ? 100 : 82, energy, rnd, ctx.params.humanize),
      ),
    )
    lastPitch = pitch
  }

  for (let p = 0; p < phrases; p++) {
    const phraseStartBar = p * pLen
    const phraseBars = Math.min(pLen, bars - phraseStartBar)
    const isLastPhrase = p === phrases - 1
    const offset = sequenceSteps[p % sequenceSteps.length] * (p === 0 ? 0 : 1)
    for (let b = 0; b < phraseBars; b++) {
      const barIdx = phraseStartBar + b
      const barStart = barIdx * bpb
      if (barStart >= total - EPS) break
      const slot = slotAtBeat(slots, barStart + 0.001)
      // 长片段里：每 4 小节的后半用变奏节奏
      const useVariation = b > 0 && (b % 4 === 2 || chance(rnd, 0.25 + complexity * 0.3))
      const localRhythm = useVariation ? varyRhythm(rhythm, rnd) : rhythm
      let cursor = barStart
      let noteIndex = 0
      localRhythm.forEach((baseDur) => {
        const dur = Math.max(0.125, baseDur * (bpb / 4))
        if (cursor >= total - EPS) return
        const beatInBar = cursor - barStart
        const strong = Math.abs(beatInBar) < 0.01 || Math.abs((beatInBar % (bpb / 2) + bpb / 2) % (bpb / 2)) < 0.26
        // 乐句呼吸：句尾留白 / 低密度时更多休止
        const isPhraseTail = b === phraseBars - 1 && noteIndex >= localRhythm.length - 2
        const restChance = (1 - density) * 0.28 + (isPhraseTail && !isLastPhrase ? 0.35 : 0)
        if (chance(rnd, restChance)) {
          cursor += dur
          noteIndex++
          return
        }
        const rawIdx = (motifIdx[noteIndex % motifLen] ?? 0) + offset + (b > 0 && useVariation ? (rnd() < 0.5 ? 1 : -1) * (rnd() < 0.5 ? 0 : 1) : 0)
        let pitch = pool[Math.max(0, Math.min(pool.length - 1, rawIdx))]
        // 强拍落和弦音，弱拍走音阶（经过音）
        if (strong && slot) {
          const chordTone = nearestChordToneInRange(pitch, slot.chord, range, true)
          if (Math.abs(chordTone - pitch) <= 4) pitch = chordTone
        }
        // 大跳之后反向级进（旋律法则）
        if (lastPitch > 0 && Math.abs(pitch - lastPitch) > 7) {
          pitch = clampPitchRange(lastPitch + (pitch > lastPitch ? 2 : -2), range)
        }
        push(pitch, cursor, dur * (isLastPhrase ? 0.95 : 0.9), strong || noteIndex === 0)
        cursor += dur
        noteIndex++
      })
    }
  }

  // 终止音：整段最后一个音落在主音（或和弦根音）上并延长
  if (notes.length) {
    const sorted = [...notes].sort((a, b) => a.start + a.duration - (b.start + b.duration))
    const lastNote = sorted[sorted.length - 1]
    const tonicPc = keyToPc(ctx.key)
    const target = pitchForPc(tonicPc, lastNote.pitch, range)
    lastNote.pitch = clampPitchRange(target, range)
    lastNote.duration = Math.min(Math.max(lastNote.duration, bpb / 2), Math.max(0.5, total - lastNote.start))
    lastNote.velocity = Math.max(1, Math.min(127, Math.round(lastNote.velocity * 0.94)))
  }
  return notes
}

/* ------------------------------------------------------------------ */
/* 摇滚动机                                                            */
/* ------------------------------------------------------------------ */

const RIFF_PATTERNS: Record<string, number[]> = {
  chug: [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75],
  gallop: [0, 0.5, 0.75, 1, 1.5, 1.75, 2, 2.5, 2.75, 3, 3.5, 3.75],
  stab: [0.5, 1.5, 2.5, 3.5],
  pedal: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
}

const riff: GeneratorFn = (ctx) => {
  const rnd = mulberry32(ctx.seed)
  const bpb = barBeatsOf(ctx)
  const bars = Math.max(1, Math.round(ctx.bars))
  const total = totalBeats(ctx)
  const slots = chordSlots(ctx)
  const notes: NoteEvent[] = []
  const density = effectiveDensity(ctx)
  const complexity = clamp01(ctx.params.complexity)
  const energy = clamp01(ctx.params.energy)
  const swing = effectiveSwing(ctx)
  const octave = Math.max(1, Math.min(6, Math.round(ctx.params.octave)))
  const range = ctx.range ?? { min: 40, max: 76 }
  const target = clampPitchRange((octave + 1) * 12, range)
  const patternId = ctx.params.patternId && RIFF_PATTERNS[ctx.params.patternId] ? ctx.params.patternId : 'chug'
  const meterScale = bpb / 4

  for (let bar = 0; bar < bars; bar++) {
    const barStart = bar * bpb
    if (barStart >= total - EPS) break
    const slot = slotAtBeat(slots, barStart + 0.001)
    const chord = slot?.chord ?? { root: keyToPc(ctx.key), quality: 'power' as ChordQualityId, beats: bpb }
    const root = pitchForPc(chord.root, target, range)
    const fifth = clampPitchRange(root + 7, range)
    const octaveUp = clampPitchRange(root + 12, range)
    let offsets = RIFF_PATTERNS[patternId] ?? RIFF_PATTERNS.chug
    // 长片段里每 4 小节换一次律动
    if (bar > 0 && bar % 4 === 3 && chance(rnd, 0.45 + complexity * 0.35)) {
      const alternates = Object.keys(RIFF_PATTERNS).filter((k) => k !== patternId)
      offsets = RIFF_PATTERNS[pickOne(rnd, alternates)] ?? offsets
    }
    offsets = offsets.map((o) => o * meterScale).filter((o) => o < bpb - EPS)
    const step = density > 0.62 ? 0.25 * meterScale : 0.5 * meterScale
    // 低密度只保留重音位置
    if (density < 0.35) offsets = offsets.filter((o) => Math.abs(o % (meterScale * 1)) < 0.01)
    offsets.forEach((off, i) => {
      const start = barStart + applySwing(off, swing)
      if (start >= total - EPS) return
      if (off > 0 && chance(rnd, (1 - density) * 0.3)) return
      if (density < 0.55 && Math.abs((off / meterScale) % 1) > 0.01 && chance(rnd, 0.5)) return
      const accent = Math.abs(off % (meterScale * 1)) < 0.01
      const openChord = accent && complexity > 0.42
      const pitches = openChord ? [root, fifth, octaveUp] : [root]
      // 泛音尖叫 / 八度跳
      if (complexity > 0.72 && accent && chance(rnd, 0.16)) pitches.push(clampPitchRange(octaveUp + 7, range))
      const dur = Math.max(0.06, (accent ? step * 1.6 : step * 0.85) * (0.5 + clamp01(ctx.params.gate) * 0.6))
      for (const pitch of pitches) {
        notes.push(
          createNote(
            clampPitchRange(pitch, range),
            Math.max(0, humanize(start, clamp01(ctx.params.humanize) * 0.006, rnd)),
            dur,
            velocityFor(accent ? 108 : 84, energy, rnd, ctx.params.humanize),
          ),
        )
      }
      // 闷音 chug：在长音内部补一颗低力度闷音
      if (patternId === 'chug' && density > 0.6 && complexity > 0.4 && i % 4 === 2) {
        notes.push(
          createNote(
            clampPitchRange(root, range),
            start + step * 0.5,
            Math.max(0.05, step * 0.45),
            velocityFor(62, energy, rnd, ctx.params.humanize),
          ),
        )
      }
    })
  }
  return notes
}

/* ------------------------------------------------------------------ */
/* 扫弦                                                                */
/* ------------------------------------------------------------------ */

interface StrumHit {
  off: number
  down: boolean
  /** 0 = 必须，1 = 常规，2 = 装饰（高密度才出现） */
  level: 0 | 1 | 2
  accent?: boolean
}

const STRUM_PATTERNS: Record<string, StrumHit[]> = {
  downUp: [
    { off: 0, down: true, level: 0, accent: true },
    { off: 0.5, down: false, level: 1 },
    { off: 1, down: true, level: 0 },
    { off: 1.5, down: false, level: 2 },
    { off: 2, down: true, level: 0, accent: true },
    { off: 2.5, down: false, level: 1 },
    { off: 3, down: true, level: 0 },
    { off: 3.5, down: false, level: 1 },
  ],
  folk: [
    { off: 0, down: true, level: 0, accent: true },
    { off: 0.5, down: false, level: 2 },
    { off: 1, down: true, level: 1 },
    { off: 1.5, down: false, level: 2 },
    { off: 2, down: true, level: 0 },
    { off: 2.5, down: false, level: 1 },
    { off: 3, down: true, level: 1 },
    { off: 3.5, down: false, level: 2 },
  ],
  ballad: [
    { off: 0, down: true, level: 0, accent: true },
    { off: 1.5, down: false, level: 2 },
    { off: 2, down: true, level: 0 },
    { off: 3, down: true, level: 1 },
    { off: 3.5, down: false, level: 2 },
  ],
}

/** 吉他可用和弦排列：低音 + 五度 + 八度 + 三音（不超过 5 个音） */
function guitarVoicing(chord: ChordSpec, octave: number, range?: { min: number; max: number }): number[] {
  const tones = chordPitches(chord, octave)
  const intervals = CHORDS[chord.quality]?.intervals ?? [0, 4, 7]
  const root = tones[0]
  const out: number[] = [root]
  const fifthIv = intervals[2] ?? 7
  out.push(root + fifthIv)
  out.push(root + 12)
  if (intervals.length >= 2) out.push(root + intervals[1])
  if (intervals.length >= 4) out.push(root + intervals[3])
  const uniq = [...new Set(out.map((p) => clampPitchRange(p, range)))].sort((a, b) => a - b)
  return uniq.slice(0, 6)
}

const strum: GeneratorFn = (ctx) => {
  const rnd = mulberry32(ctx.seed)
  const bpb = barBeatsOf(ctx)
  const bars = Math.max(1, Math.round(ctx.bars))
  const total = totalBeats(ctx)
  const slots = chordSlots(ctx)
  const notes: NoteEvent[] = []
  const density = effectiveDensity(ctx)
  const complexity = clamp01(ctx.params.complexity)
  const energy = clamp01(ctx.params.energy)
  const swing = effectiveSwing(ctx)
  const octave = Math.max(1, Math.min(6, Math.round(ctx.params.octave)))
  const meterScale = bpb / 4
  const defaultStrum = ctx.style === 'rock' || ctx.style === 'jrock' ? 'downUp' : ctx.style === 'pop' ? 'folk' : 'folk'
  const patternId = ctx.params.patternId && STRUM_PATTERNS[ctx.params.patternId] ? ctx.params.patternId : defaultStrum
  const arpeggioMode = ctx.params.patternId === 'arpeggio'

  const push = (pitch: number, start: number, dur: number, vel: number) => {
    if (start < -EPS || start >= total - EPS) return
    notes.push(
      createNote(
        clampPitchRange(pitch, ctx.range),
        Math.max(0, humanize(start, clamp01(ctx.params.humanize) * 0.006, rnd)),
        Math.max(0.06, gated(dur, ctx, 0.06)),
        velocityFor(vel, energy, rnd, ctx.params.humanize),
      ),
    )
  }

  for (let bar = 0; bar < bars; bar++) {
    const barStart = bar * bpb
    if (barStart >= total - EPS) break
    const slot = slotAtBeat(slots, barStart + 0.001)
    const chord = slot?.chord ?? { root: keyToPc(ctx.key), quality: 'maj' as ChordQualityId, beats: bpb }
    const voicing = guitarVoicing(chord, octave, ctx.range)
    if (!voicing.length) continue
    const bassNote = voicing[0]
    let pattern = STRUM_PATTERNS[patternId]
    if (bar > 0 && bar % 4 === 3 && chance(rnd, 0.3 + complexity * 0.3)) {
      pattern = STRUM_PATTERNS[pickOne(rnd, ['downUp', 'folk', 'ballad'])]
    }

    if (arpeggioMode) {
      // 分解：8 分音符逐个拨弦，低音先出现
      const order = [...voicing, ...voicing.slice(0, -1).reverse()]
      const step = density > 0.6 ? 0.25 : 0.5
      let i = 0
      for (let off = 0; off < bpb - EPS; off += step) {
        const start = barStart + applySwing(off, swing)
        if (start >= total - EPS) break
        if (density < 0.4 && off % 1 > 0.01) continue
        const pitch = order[i % order.length]
        push(pitch, start, step * 1.6, i % 4 === 0 ? 92 : 74)
        i++
      }
      continue
    }

    // 低音 + 扫弦
    pattern.forEach((hit, hi) => {
      if (hit.level > 0 && hit.level === 2 && density < 0.5) return
      if (hit.level === 1 && density < 0.28) return
      const start = barStart + applySwing(hit.off * meterScale, swing)
      if (start >= total - EPS) return
      const accent = Boolean(hit.accent)
      // 强拍先给低音（根音 / 五度交替），再扫整个和弦
      if (accent && complexity > 0.45) {
        const alt = voicing.length > 1 && hi % 4 === 2 ? voicing[1] : bassNote
        push(alt, start, (bpb / 4) * 0.9, 96)
      }
      const order = hit.down ? voicing : [...voicing].reverse()
      const spread = 0.011 + complexity * 0.006
      const dur = (hit.down ? 0.85 : 0.45) * (bpb / 4) * (0.55 + clamp01(ctx.params.gate) * 0.6)
      order.forEach((pitch, i) => {
        // 反拍扫弦跳过最低音，保持轻盈
        if (!hit.down && i === order.length - 1) return
        push(pitch, start + i * spread, dur, hit.down ? (accent ? 104 : 88) : 68)
      })
      // 闷音扫弦装饰
      if (complexity > 0.68 && density > 0.6 && hi % 3 === 2) {
        const muteStart = start + hit.off * meterScale / 2
        for (const pitch of voicing.slice(0, 3)) push(pitch, muteStart, 0.08, 54)
      }
    })
  }
  return notes
}

/* ------------------------------------------------------------------ */
/* 对位                                                                */
/* ------------------------------------------------------------------ */

const counter: GeneratorFn = (ctx) => {
  const slots = chordSlots(ctx)
  if (!slots.length) return []
  const total = totalBeats(ctx)
  const energy = clamp01(ctx.params.energy)
  const density = effectiveDensity(ctx)
  const octave = Math.max(2, Math.min(6, Math.round(ctx.params.octave)))
  const center = (octave + 1) * 12
  const range = ctx.range ?? { min: Math.max(0, center - 14), max: Math.min(127, center + 14) }
  const reference = (ctx.reference ?? []).filter((n) => n.start < total - EPS)

  if (reference.length >= 2) {
    const refAvg = reference.reduce((a, n) => a + n.pitch, 0) / reference.length
    const register: 'above' | 'below' = refAvg > (range.min + range.max) / 2 ? 'below' : 'above'
    const tiledChords = slots.map((s) => ({ ...s.chord, beats: Math.max(0.25, s.endBeat - s.startBeat) }))
    return counterpointAgainst(reference, {
      key: ctx.key,
      scale: ctx.scale,
      chords: tiledChords,
      range,
      register,
      density,
      startBeat: 0,
      endBeat: total,
      seed: ctx.seed,
      velocity: 62 + energy * 18,
    })
  }

  // 无参考：用「抒情长句」的参数生成一条独立副旋律（音区与主旋律错开）
  const counterParams = {
    ...ctx.params,
    density: (effectiveDensity(ctx) * 0.62),
    complexity: clamp01(ctx.params.complexity * 0.8),
    patternId: 'lyrical',
    humanize: clamp01(ctx.params.humanize + 0.05),
  }
  return melody({ ...ctx, params: counterParams, seed: (ctx.seed ^ 0x9e3779b9) >>> 0 })
}

export const GENERATORS: Record<SmartKind, GeneratorFn> = {
  drums,
  bass,
  chords: chordsGen,
  arp,
  melody,
  riff,
  strum,
  counter,
  pad,
}

/**
 * 主入口：生成一个智能片段的音符。
 * 统一做合法性兜底：音高 / 起始 / 时值 / 力度 / 去重 / 排序。
 */
export function generateSmartClip(ctx: GenerateContext): NoteEvent[] {
  const limit = totalBeats(ctx)
  const fn = GENERATORS[ctx.kind] ?? GENERATORS.melody
  let raw: NoteEvent[] = []
  try {
    raw = fn(ctx) ?? []
  } catch {
    raw = []
  }
  const seen = new Set<string>()
  const out: NoteEvent[] = []
  // 画像只在合法时参与：力度校准（平均力度对齐语料）
  const velocityScale = isUsableProfile(ctx.profile) ? profileVelocityScale(ctx.profile) : 1
  for (const note of raw) {
    const pitch = Math.round(note.pitch)
    const velocity = Math.round(note.velocity * velocityScale)
    let start = note.start
    let duration = note.duration
    if (!Number.isFinite(pitch) || !Number.isFinite(velocity) || !Number.isFinite(start) || !Number.isFinite(duration)) continue
    if (pitch < 0 || pitch > 127) continue
    if (velocity < 1 || velocity > 127) continue
    if (start < -0.001 || start >= limit - 1e-4) continue
    start = Math.max(0, start)
    duration = Math.max(1 / 64, Math.min(duration, Math.max(1 / 64, limit - start)))
    if (!note.id || seen.has(note.id)) continue
    seen.add(note.id)
    out.push({ id: note.id, pitch, start, duration, velocity })
  }
  const sorted = out.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  // 演奏层人性化：用语料的力度方差 / 网格偏离去抖动（没有画像时原样返回）
  if (!isUsableProfile(ctx.profile) || ctx.params.humanize <= 0) return sorted
  return humanizeNotes(sorted, {
    seed: ctx.seed,
    amount: clamp01(ctx.params.humanize),
    velocityStd: ctx.profile.dynamics?.velocityStd?.median,
    gridDeviation16: ctx.profile.rhythm?.gridDeviation16?.median,
    isDrums: ctx.kind === 'drums',
  })
}

/** 供 UI 显示可选的图案 */
export function patternOptions(kind: SmartKind, style: StyleId): { id: string; name: string }[] {
  switch (kind) {
    case 'arp':
      return [
        { id: 'up', name: '上行' },
        { id: 'down', name: '下行' },
        { id: 'updown', name: '上下行' },
        { id: 'random', name: '随机' },
        { id: 'pedal', name: '持续音' },
      ]
    case 'drums': {
      const base = [
        { id: 'basic', name: `${STYLES[style].name}基础律动` },
        { id: 'halfTime', name: '半速' },
        { id: 'fourOnFloor', name: '四踩' },
        { id: 'breakbeat', name: '碎拍' },
      ]
      if (style === 'jazz') base.push({ id: 'swing', name: '摇摆' })
      if (style === 'rock') base.push({ id: 'rock', name: '摇滚' })
      if (style === 'jrock') base.push({ id: 'jrock', name: '日摇 16 分' })
      if (style === 'jrpg') base.push({ id: 'jrpg', name: 'JRPG 定音鼓' })
      if (style === 'folk') base.push({ id: 'folk', name: '民谣' })
      if (style === 'cinematic' || style === 'classical') base.push({ id: 'cinematic', name: '定音鼓 / 冲击' })
      return base
    }
    case 'bass':
      return [
        { id: 'root', name: '根音持续' },
        { id: 'walking', name: '走路贝斯' },
        { id: 'pumping', name: '八分推进' },
        { id: 'syncopated', name: '切分' },
      ]
    case 'chords':
      return [
        { id: 'sustain', name: '长音铺底' },
        { id: 'stab', name: '切分短促' },
        { id: 'syncopated', name: '切分节奏' },
      ]
    case 'melody':
      return [
        { id: 'motif', name: '动机' },
        { id: 'sequence', name: '模进' },
        { id: 'lyrical', name: '抒情长句' },
        { id: 'rhythmic', name: '节奏型' },
      ]
    case 'riff':
      return [
        { id: 'chug', name: '闷音推进' },
        { id: 'gallop', name: '奔马节奏' },
        { id: 'stab', name: '强力和弦切分' },
        { id: 'pedal', name: '持续音型' },
      ]
    case 'strum':
      return [
        { id: 'folk', name: '民谣扫弦' },
        { id: 'downUp', name: '上下扫' },
        { id: 'ballad', name: '抒情扫弦' },
        { id: 'arpeggio', name: '分解和弦' },
      ]
    default:
      return []
  }
}

export function isGeneratorKind(kind: string): kind is SmartKind {
  return kind in GENERATORS
}

