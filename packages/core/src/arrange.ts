/**
 * 编曲器：把「风格 + 和弦 + 可选旋律」变成一组带智能片段的轨道。
 *
 * 两个核心需求都在这里实现：
 * 1) 根据旋律自动编曲  —— arrangeFromMelody()
 * 2) 根据和弦填写旋律  —— melodyFromChords()
 *
 * 编曲思路：
 * - 先分段落（前奏 / 主歌 / 副歌 / 尾声），每段能量不同；
 * - 每个声部按段落切片生成（而不是一段 loop 复制粘贴），所以 32 小节不会机械重复；
 * - 低音避开主旋律音域，对位声部读取主旋律做反向进行；
 * - 鼓的加花、贝斯的预备音、和弦的声部进行都由生成器负责，这里负责「何时该满、何时该空」。
 */
import { CHORDS, STYLES, keyToPitchClass, type ScaleId, type StyleId } from './constants.js'
import { STYLE_PROGRESSIONS, createVariationSeed, generateSmartClip } from './generators/index.js'
import type { StyleProfile } from './style/profile.js'
import { FAMILY_COLORS, getInstrument, hasInstrument } from './instruments/index.js'
import { detectKey, harmonizeMelody, progressionToChords, romanToChord, voiceLeadChords } from './theory.js'
import {
  barToBeat,
  beatsPerBar,
  createClip,
  createEmptyProject,
  createNote,
  createSection,
  createTrack,
  newId,
  type ChordSpec,
  type Clip,
  type NoteEvent,
  type Project,
  type Section,
  type SmartKind,
  type SmartParams,
  type TimeSignature,
  type Track,
} from './model.js'

/* ------------------------------------------------------------------ */
/* 角色模板                                                            */
/* ------------------------------------------------------------------ */

interface RoleSpec {
  instrumentId: string
  emotionId?: string
  kind: SmartKind
  octave: number
  name: string
  /** 相对密度/复杂度微调 */
  densityDelta?: number
  complexityDelta?: number
  /** 音符时值比例（打击乐/拨弦需要短音） */
  gate?: number
  /** 指定生成器图案（缺省由风格决定） */
  patternId?: string
}

/**
 * 各风格的默认编制（instrumentId 不存在时会自动跳过）。
 * 注意：伴奏编制里刻意不放「主旋律」角色——主旋律由 arrangeFromMelody / composeProject 单独生成，
 * 其余声部的 kind 都是能与人声/主奏互补的类型（counter / pad / arp / riff / strum…）。
 */
export const STYLE_ROLES: Record<StyleId, RoleSpec[]> = {
  classical: [
    { instrumentId: 'strings.ensemble', emotionId: 'soft', kind: 'pad', octave: 4, name: '弦乐群' },
    { instrumentId: 'piano.grand', emotionId: 'warm', kind: 'chords', octave: 3, name: '钢琴和声' },
    { instrumentId: 'strings.cello', emotionId: 'warm', kind: 'bass', octave: 2, name: '大提琴低音' },
    { instrumentId: 'woodwinds.flute', emotionId: 'airy', kind: 'counter', octave: 5, name: '长笛对位', densityDelta: -0.12 },
    { instrumentId: 'brass.horn', emotionId: 'warm', kind: 'pad', octave: 3, name: '圆号内声部', densityDelta: -0.22 },
    { instrumentId: 'timpani', emotionId: 'marcato', kind: 'bass', octave: 2, name: '定音鼓', densityDelta: -0.55, gate: 0.16 },
    { instrumentId: 'harp', emotionId: 'clear', kind: 'arp', octave: 5, name: '竖琴琶音', densityDelta: -0.32 },
  ],
  rock: [
    { instrumentId: 'drums.acoustic', emotionId: 'power', kind: 'drums', octave: 2, name: '鼓组' },
    { instrumentId: 'guitar.bass', emotionId: 'pick', kind: 'bass', octave: 2, name: '贝斯' },
    { instrumentId: 'guitar.electric', emotionId: 'crunch', kind: 'riff', octave: 3, name: '节奏吉他' },
    { instrumentId: 'organ.rock', emotionId: 'drawbar', kind: 'pad', octave: 4, name: '风琴铺底', densityDelta: -0.24 },
    { instrumentId: 'guitar.electric', emotionId: 'gain', kind: 'counter', octave: 4, name: '主音吉他', densityDelta: -0.18 },
  ],
  electronic: [
    { instrumentId: 'drums.electronic', emotionId: 'punch', kind: 'drums', octave: 2, name: '鼓机' },
    { instrumentId: 'synth.bass', emotionId: 'round', kind: 'bass', octave: 2, name: '合成贝斯' },
    { instrumentId: 'synth.pad', emotionId: 'cold', kind: 'pad', octave: 4, name: '合成铺底' },
    { instrumentId: 'synth.pluck', emotionId: 'pluck', kind: 'arp', octave: 5, name: '琶音' },
    { instrumentId: 'synth.arp', emotionId: 'sparkle', kind: 'arp', octave: 6, name: '高音琶音', densityDelta: -0.3 },
    { instrumentId: 'synth.lead', emotionId: 'soft', kind: 'counter', octave: 5, name: '副主音', densityDelta: -0.25 },
  ],
  jazz: [
    { instrumentId: 'drums.jazz', emotionId: 'brush', kind: 'drums', octave: 2, name: '爵士鼓' },
    { instrumentId: 'guitar.bass', emotionId: 'finger', kind: 'bass', octave: 2, name: '贝斯' },
    { instrumentId: 'piano.electric', emotionId: 'warm', kind: 'chords', octave: 3, name: '电钢伴奏' },
    { instrumentId: 'guitar.jazz', emotionId: 'muted', kind: 'strum', octave: 3, name: '爵士吉他', densityDelta: -0.4, patternId: 'ballad' },
    { instrumentId: 'brass.trumpet', emotionId: 'jazz', kind: 'counter', octave: 4, name: '小号对位', densityDelta: -0.2 },
  ],
  cinematic: [
    { instrumentId: 'strings.ensemble', emotionId: 'epic', kind: 'pad', octave: 4, name: '弦乐群' },
    { instrumentId: 'choir', emotionId: 'ooh', kind: 'pad', octave: 3, name: '合唱', densityDelta: -0.3 },
    { instrumentId: 'piano.grand', emotionId: 'melancholy', kind: 'chords', octave: 3, name: '钢琴' },
    { instrumentId: 'strings.cello', emotionId: 'deep', kind: 'bass', octave: 2, name: '低音弦乐' },
    { instrumentId: 'timpani', emotionId: 'marcato', kind: 'bass', octave: 2, name: '定音鼓', densityDelta: -0.5, gate: 0.18 },
    { instrumentId: 'harp', emotionId: 'celestial', kind: 'arp', octave: 5, name: '竖琴', densityDelta: -0.35 },
  ],
  pop: [
    { instrumentId: 'drums.acoustic', emotionId: 'studio', kind: 'drums', octave: 2, name: '鼓组' },
    { instrumentId: 'guitar.bass', emotionId: 'finger', kind: 'bass', octave: 2, name: '贝斯' },
    { instrumentId: 'piano.grand', emotionId: 'clear', kind: 'chords', octave: 3, name: '钢琴' },
    { instrumentId: 'synth.pad', emotionId: 'bright', kind: 'pad', octave: 4, name: '铺底', densityDelta: -0.2 },
    { instrumentId: 'guitar.acoustic', emotionId: 'strum', kind: 'strum', octave: 3, name: '木吉他' },
    { instrumentId: 'synth.pluck', emotionId: 'bright', kind: 'arp', octave: 5, name: '点缀琶音', densityDelta: -0.35 },
  ],
  folk: [
    { instrumentId: 'guitar.acoustic', emotionId: 'strum', kind: 'strum', octave: 3, name: '木吉他' },
    { instrumentId: 'guitar.bass', emotionId: 'finger', kind: 'bass', octave: 2, name: '贝斯' },
    { instrumentId: 'piano.grand', emotionId: 'warm', kind: 'chords', octave: 3, name: '钢琴', densityDelta: -0.22 },
    { instrumentId: 'woodwinds.flute', emotionId: 'airy', kind: 'counter', octave: 5, name: '长笛对白', densityDelta: -0.18 },
    { instrumentId: 'strings.cello', emotionId: 'deep', kind: 'pad', octave: 2, name: '大提琴铺底', densityDelta: -0.3 },
  ],
}

export function defaultSmartParams(overrides: Partial<SmartParams> = {}): SmartParams {
  return {
    bars: 4,
    density: 0.5,
    complexity: 0.45,
    energy: 0.6,
    octave: 4,
    swing: 0,
    humanize: 0.22,
    gate: 0.85,
    followChords: true,
    ...overrides,
  }
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5))

const MINOR_SCALES = new Set<ScaleId>(['minor', 'harmonicMinor', 'melodicMinor', 'dorian', 'phrygian', 'locrian', 'pentatonicMinor', 'blues'])

function isMinorish(scale: ScaleId): boolean {
  return MINOR_SCALES.has(scale)
}

/** 该调式的「I 级」是否是小三和弦（自然/和声/旋律小调与 phrygian/locrian 是；dorian 等不是） */
function tonicIsMinor(scale: ScaleId): boolean {
  return scale === 'minor' || scale === 'harmonicMinor' || scale === 'melodicMinor' || scale === 'phrygian' || scale === 'locrian'
}

/* ------------------------------------------------------------------ */
/* 单轨构建                                                            */
/* ------------------------------------------------------------------ */

export interface BuildClipOptions {
  style: StyleId
  key: string
  scale: ScaleId
  tempo: number
  timeSignature: TimeSignature
  bars: number
  chords: ChordSpec[]
  seed: number
  kind: SmartKind
  params: SmartParams
  startBeat?: number
  reference?: NoteEvent[]
  range?: { min: number; max: number }
  /** 风格画像（可选）：有则按语料统计采样，没有则用内置常量 */
  profile?: StyleProfile
}

/** 生成一个带智能片段配置的 Clip（含音符） */
export function buildSmartClip(opts: BuildClipOptions, trackId: string): Clip {
  const barBeats = beatsPerBar(opts.timeSignature)
  const notes = generateSmartClip({
    kind: opts.kind,
    style: opts.style,
    key: opts.key,
    scale: opts.scale,
    tempo: opts.tempo,
    timeSignature: opts.timeSignature,
    bars: opts.bars,
    params: opts.params,
    chords: opts.chords,
    seed: opts.seed,
    reference: opts.reference,
    range: opts.range,
    profile: opts.profile,
  })
  return createClip({
    trackId,
    name: `${opts.kind}`,
    startBeat: opts.startBeat ?? 0,
    lengthBeats: opts.bars * barBeats,
    notes,
    smart: {
      kind: opts.kind,
      style: opts.style,
      seed: opts.seed,
      params: opts.params,
      key: opts.key,
      scale: opts.scale,
    },
  })
}

/** 去掉模板里不存在的乐器 */
function filterRoles(roles: RoleSpec[]): RoleSpec[] {
  return roles.filter((r) => hasInstrument(r.instrumentId))
}

/** 轨道默认混音（按声部职能） */
function roleMix(kind: SmartKind, isDrum: boolean): { volume: number; pan: number; reverbSend: number; delaySend: number } {
  if (isDrum) return { volume: 0.72, pan: 0, reverbSend: 0.12, delaySend: 0 }
  switch (kind) {
    case 'bass':
      return { volume: 0.82, pan: 0, reverbSend: 0.05, delaySend: 0 }
    case 'pad':
      return { volume: 0.56, pan: -0.08, reverbSend: 0.38, delaySend: 0.08 }
    case 'chords':
      return { volume: 0.7, pan: 0.12, reverbSend: 0.24, delaySend: 0.06 }
    case 'arp':
      return { volume: 0.54, pan: 0.28, reverbSend: 0.3, delaySend: 0.18 }
    case 'strum':
      return { volume: 0.72, pan: -0.22, reverbSend: 0.2, delaySend: 0.05 }
    case 'riff':
      return { volume: 0.7, pan: 0.18, reverbSend: 0.14, delaySend: 0.05 }
    case 'counter':
      return { volume: 0.56, pan: -0.26, reverbSend: 0.3, delaySend: 0.12 }
    default:
      return { volume: 0.74, pan: 0, reverbSend: 0.2, delaySend: 0.06 }
  }
}

/* ------------------------------------------------------------------ */
/* 段落                                                                */
/* ------------------------------------------------------------------ */

const SECTION_NAMES: Record<StyleId, string[]> = {
  classical: ['呈示', '发展', '再现', '尾声'],
  rock: ['前奏', '主歌', '副歌', '尾奏'],
  electronic: ['Intro', 'Build', 'Drop', 'Outro'],
  jazz: ['前奏', '主题', '即兴', '主题再现'],
  cinematic: ['铺陈', '推进', '高潮', '收束'],
  pop: ['前奏', '主歌', '副歌', '尾声'],
  folk: ['前奏', '主歌', '副歌', '尾奏'],
}

/** 前奏类段落名（用于把主旋律推迟到第 2 段进入） */
const INTRO_NAMES = new Set(['前奏', 'Intro', '铺陈'])

/**
 * 段落规划：前奏 / 主歌 / 副歌 / 尾声，能量递增再回落。
 * 小节数很少时退化为一到两段，保证任何长度都能用。
 */
export function buildSections(bars: number, style: StyleId): Section[] {
  const total = Math.max(1, Math.round(bars))
  const names = SECTION_NAMES[style] ?? SECTION_NAMES.pop
  const make = (plan: { name: string; bars: number; energy: number }[]): Section[] => {
    const out: Section[] = []
    let cursor = 0
    for (const item of plan) {
      const b = Math.round(item.bars)
      if (b <= 0) continue
      out.push(createSection({ name: item.name, startBar: cursor, bars: b, energy: clamp01(item.energy) }))
      cursor += b
    }
    // 修正四舍五入误差
    if (out.length) {
      const last = out[out.length - 1]
      const diff = total - cursor
      if (diff !== 0) last.bars = Math.max(1, last.bars + diff)
    }
    return out
  }

  if (total <= 2) {
    return make([{ name: names[1], bars: total, energy: 0.6 }])
  }
  if (total <= 6) {
    return make([
      { name: names[0], bars: 1, energy: 0.36 },
      { name: names[1], bars: total - 2, energy: 0.62 },
      { name: names[2], bars: 1, energy: 0.86 },
    ])
  }
  if (total <= 10) {
    return make([
      { name: names[0], bars: 2, energy: 0.34 },
      { name: names[1], bars: total - 4, energy: 0.6 },
      { name: names[2], bars: 2, energy: 0.9 },
    ])
  }
  const intro = Math.max(2, Math.round(total * 0.15))
  const outro = Math.max(2, Math.round(total * 0.15))
  const verse = Math.max(2, Math.round(total * 0.35))
  const chorus = Math.max(2, total - intro - verse - outro)
  return make([
    { name: names[0], bars: intro, energy: 0.34 },
    { name: names[1], bars: verse, energy: 0.6 },
    { name: names[2], bars: chorus, energy: 0.92 },
    { name: names[3], bars: outro, energy: 0.48 },
  ])
}

/** 取前奏小节数（没有前奏概念的风格返回 0） */
function introBarsOf(sections: Section[]): number {
  if (sections.length < 3) return 0
  const first = sections[0]
  return INTRO_NAMES.has(first.name) ? first.bars : 0
}

/* ------------------------------------------------------------------ */
/* 伴奏编排                                                            */
/* ------------------------------------------------------------------ */

export interface ArrangeOptions {
  style: StyleId
  /** 缺省时由旋律自动识别 */
  key?: string
  scale?: ScaleId
  tempo: number
  bars: number
  chords: ChordSpec[]
  melody?: NoteEvent[]
  /** 0..1，整体强度 */
  energy?: number
  seed?: number
  timeSignature?: TimeSignature
  /** 只生成这些乐器（缺省用风格模板） */
  instrumentIds?: string[]
  /** 自定义段落（缺省按小节数自动规划） */
  sections?: Section[]
  /** 摇摆量 0..1（缺省按风格） */
  swing?: number
  /** 风格画像（可选）：有则按语料统计采样 */
  profile?: StyleProfile
}

function energyScale<T extends { density: number; complexity: number; energy: number }>(params: T, energy: number): T {
  return {
    ...params,
    density: clamp01(params.density * (0.6 + energy * 0.7)),
    complexity: clamp01(params.complexity * (0.55 + energy * 0.8)),
    energy: clamp01(energy),
  }
}

/** 把音符裁剪到某个段落并平移为片段内相对时间（给对位/和声参考用） */
function sliceReference(melody: NoteEvent[] | undefined, startBeat: number, lengthBeats: number): NoteEvent[] | undefined {
  if (!melody?.length) return undefined
  const end = startBeat + lengthBeats
  const out: NoteEvent[] = []
  for (const note of melody) {
    const noteEnd = note.start + note.duration
    if (noteEnd <= startBeat + 1e-6 || note.start >= end - 1e-6) continue
    const localStart = Math.max(0, note.start - startBeat)
    const localEnd = Math.min(lengthBeats, noteEnd - startBeat)
    if (localEnd <= localStart) continue
    out.push({ ...note, start: localStart, duration: Math.min(note.duration, localEnd - localStart) })
  }
  return out.length ? out : undefined
}

/**
 * 根据风格 + 和弦生成伴奏轨道组（不含主旋律轨）。
 * 若传入 melody，则按旋律做参考生成对位/和声走向，并让低音避开旋律音域。
 */
export function buildAccompaniment(opts: ArrangeOptions): Track[] {
  const style = opts.style
  const timeSignature = opts.timeSignature ?? { numerator: 4, denominator: 4 }
  const barBeats = beatsPerBar(timeSignature)
  const totalBars = Math.max(1, Math.round(opts.bars))
  const totalBeats = totalBars * barBeats
  const key = opts.key || 'C'
  const scale = opts.scale ?? STYLES[style].defaultScale
  const seed = opts.seed ?? 12345
  const baseEnergy = clamp01(opts.energy ?? 0.62)
  const sections = (opts.sections?.length ? opts.sections : buildSections(totalBars, style))
    .filter((s) => s.bars > 0)
    .sort((a, b) => a.startBar - b.startBar)

  let roles = filterRoles(STYLE_ROLES[style])
  if (opts.instrumentIds?.length) {
    const wanted = new Set(opts.instrumentIds)
    roles = roles.filter((r) => wanted.has(r.instrumentId))
  }

  const tracks: Track[] = []
  roles.forEach((role, roleIndex) => {
    const inst = getInstrument(role.instrumentId)
    const emotionId =
      role.emotionId && inst.emotions.some((e) => e.id === role.emotionId) ? role.emotionId : inst.emotions[0].id
    const kind: SmartKind = inst.isDrumKit ? 'drums' : role.kind
    const mix = roleMix(kind, inst.isDrumKit)
    const track = createTrack({
      instrumentId: inst.id,
      emotionId,
      name: role.name,
      color: FAMILY_COLORS[inst.family] ?? inst.emotions[0].color,
      kind: inst.isDrumKit ? 'drum' : 'instrument',
      gmProgram: inst.gmProgram,
      volume: mix.volume,
      pan: mix.pan,
      reverbSend: mix.reverbSend,
      delaySend: mix.delaySend,
    })

    for (let s = 0; s < sections.length; s++) {
      const section = sections[s]
      const sectionStartBeat = barToBeat(section.startBar, timeSignature)
      const sectionBars = Math.max(1, Math.round(section.bars))
      const sectionEndBeat = Math.min(totalBeats, sectionStartBeat + sectionBars * barBeats)
      const reachableBars = Math.max(1, Math.round((sectionEndBeat - sectionStartBeat) / barBeats))
      if (sectionStartBeat >= totalBeats - 1e-6) continue

      // 能量曲线：段落能量 × 全曲能量 × 后段渐强
      const arc = sections.length > 1 ? 0.86 + (s / (sections.length - 1)) * 0.28 : 1
      const energy = clamp01(section.energy * arc * (0.62 + baseEnergy * 0.56))

      let params = defaultSmartParams({
        bars: reachableBars,
        octave: inst.isDrumKit ? 2 : role.octave,
        density: clamp01((0.48 + (role.densityDelta ?? 0)) * (0.62 + energy * 0.66)),
        complexity: clamp01((0.46 + (role.complexityDelta ?? 0)) * (0.58 + energy * 0.66)),
        energy,
        swing: clamp01(opts.swing ?? (style === 'jazz' ? 0.42 : style === 'electronic' ? 0.06 : 0)),
        humanize: 0.2,
        gate: role.gate ?? (kind === 'pad' ? 1.05 : kind === 'drums' ? 0.72 : 0.88),
        patternId: role.patternId,
      })
      // 前奏要「薄」：鼓少一点、和声空一点，才有进入感
      if (s === 0 && sections.length > 1) {
        params.density = clamp01(params.density * (kind === 'drums' ? 0.82 : 0.68))
        params.complexity = clamp01(params.complexity * 0.85)
      }
      // 副歌推起来
      if (sections.length > 2 && s === sections.length - 2) {
        params.density = clamp01(params.density * 1.08)
        params.energy = clamp01(params.energy * 1.06)
      }
      params = energyScale(params, params.energy)

      const reference = sliceReference(opts.melody, sectionStartBeat, sectionEndBeat - sectionStartBeat)
      const clip = buildSmartClip(
        {
          style,
          key,
          scale,
          tempo: opts.tempo,
          timeSignature,
          bars: reachableBars,
          chords: opts.chords,
          seed: createVariationSeed(seed, roleIndex * 131 + s * 17 + 7),
          kind,
          params,
          startBeat: sectionStartBeat,
          reference,
          range: inst.range,
          profile: opts.profile,
        },
        track.id,
      )
      clip.name = sections.length > 1 ? `${role.name}·${section.name}` : role.name
      track.clips.push(clip)
    }

    if (track.clips.length) tracks.push(track)
  })

  return tracks
}

/* ------------------------------------------------------------------ */
/* 和弦工具                                                            */
/* ------------------------------------------------------------------ */

/** 把一段和弦裁成「指定小节范围」的和弦（用于让主旋律和伴奏对同一段和声） */
function chordsForBarRange(chords: ChordSpec[], startBar: number, bars: number, barBeats: number): ChordSpec[] {
  const from = startBar * barBeats
  const to = (startBar + bars) * barBeats
  const out: ChordSpec[] = []
  let cursor = 0
  for (const chord of chords) {
    const beats = chord.beats > 0 ? chord.beats : barBeats
    const start = cursor
    const end = cursor + beats
    cursor = end
    if (end <= from + 1e-6 || start >= to - 1e-6) continue
    const clipped = Math.min(end, to) - Math.max(start, from)
    if (clipped <= 0) continue
    out.push({ ...chord, beats: Math.max(0.25, clipped) })
  }
  return out
}

/** 把和弦进行铺满指定小节数（不足则循环，超出则裁剪） */
function fitChords(chords: ChordSpec[], bars: number, barBeats: number, key: string, scale: ScaleId): ChordSpec[] {
  const total = Math.max(1, bars) * barBeats
  const fallback: ChordSpec = {
    root: keyToPitchClass(key),
    quality: isMinorish(scale) ? 'min' : 'maj',
    beats: barBeats,
  }
  const source = chords.length ? chords : [fallback]
  const out: ChordSpec[] = []
  let cursor = 0
  let i = 0
  let guard = 0
  while (cursor < total - 1e-6 && guard++ < 512) {
    const chord = source[i % source.length]
    const beats = Math.max(0.25, Math.min(chord.beats > 0 ? chord.beats : barBeats, total - cursor))
    out.push({ ...chord, beats })
    cursor += beats
    i++
  }
  return out
}

/** 由罗马数字生成「每小节一个」的和弦，并在结尾补 V-I 终止式 */
function buildProgressionChords(
  romans: string[],
  key: string,
  scale: ScaleId,
  bars: number,
  barBeats: number,
  seventh = false,
): ChordSpec[] {
  const list = romans.length ? romans : STYLE_PROGRESSIONS.pop
  const chords: ChordSpec[] = []
  let i = 0
  while (chords.length < bars) {
    const roman = list[i % list.length]
    const chord = romanToChord(roman, key, scale, barBeats) ?? progressionToChords([roman], key, scale, barBeats)[0]
    chords.push(chord ? { ...chord, beats: barBeats } : { root: keyToPitchClass(key), quality: isMinorish(scale) ? 'min' : 'maj', beats: barBeats })
    i++
  }
  // 终止式：最后两小节 V(7) - I，确保听感「收得住」
  if (bars >= 4) {
    const tonicRoman = tonicIsMinor(scale) ? 'i' : seventh ? 'Imaj7' : 'I'
    const dominantRoman = isMinorish(scale) || seventh ? 'V7' : 'V'
    const tonic = romanToChord(tonicRoman, key, scale, barBeats)
    const dominant = romanToChord(dominantRoman, key, scale, barBeats)
    if (tonic) chords[bars - 1] = { ...tonic, beats: barBeats }
    if (dominant) chords[bars - 2] = { ...dominant, beats: barBeats }
  }
  return chords
}

/* ------------------------------------------------------------------ */
/* 主旋律音色 / 音区                                                   */
/* ------------------------------------------------------------------ */

export interface MelodyInstrumentSpec {
  instrumentId: string
  emotionId: string
  octave: number
}

const MELODY_INSTRUMENTS: Record<StyleId, MelodyInstrumentSpec> = {
  classical: { instrumentId: 'strings.violin', emotionId: 'solo', octave: 5 },
  rock: { instrumentId: 'guitar.electric', emotionId: 'gain', octave: 4 },
  electronic: { instrumentId: 'synth.lead', emotionId: 'saw', octave: 5 },
  jazz: { instrumentId: 'brass.trumpet', emotionId: 'jazz', octave: 4 },
  cinematic: { instrumentId: 'strings.violin', emotionId: 'expressive', octave: 5 },
  pop: { instrumentId: 'piano.grand', emotionId: 'clear', octave: 4 },
  folk: { instrumentId: 'woodwinds.flute', emotionId: 'airy', octave: 5 },
}

/** 某风格的「主旋律」推荐音色 */
export function melodyInstrumentFor(style: StyleId): MelodyInstrumentSpec {
  const spec = MELODY_INSTRUMENTS[style] ?? MELODY_INSTRUMENTS.pop
  if (!hasInstrument(spec.instrumentId)) return { ...MELODY_INSTRUMENTS.pop }
  return { ...spec }
}

/* ------------------------------------------------------------------ */
/* 需求 1：根据旋律自动编曲                                             */
/* ------------------------------------------------------------------ */

export interface MelodyArrangeResult {
  tracks: Track[]
  chords: ChordSpec[]
  sections: Section[]
  key: string
  scale: ScaleId
  analysis: string
}

/** 清洗导入的旋律：音高/时值/力度合法化，重新分配 id */
function normalizeMelody(melody: NoteEvent[]): NoteEvent[] {
  return melody
    .filter((n) => n && Number.isFinite(n.pitch) && Number.isFinite(n.start) && Number.isFinite(n.duration))
    .map((n) => ({
      id: newId('n'),
      pitch: Math.max(0, Math.min(127, Math.round(n.pitch))),
      start: Math.max(0, n.start),
      duration: Math.max(1 / 64, n.duration),
      velocity: Math.max(1, Math.min(127, Math.round(Number.isFinite(n.velocity) ? n.velocity : 90))),
    }))
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch)
}

export function arrangeFromMelody(opts: ArrangeOptions & { melody: NoteEvent[] }): MelodyArrangeResult {
  const style = opts.style
  const timeSignature = opts.timeSignature ?? { numerator: 4, denominator: 4 }
  const barBeats = beatsPerBar(timeSignature)
  const melody = normalizeMelody(opts.melody ?? [])
  const melodyEnd = melody.reduce((max, n) => Math.max(max, n.start + n.duration), 0)
  const bars = Math.max(1, Math.round(opts.bars || Math.ceil(melodyEnd / barBeats)))

  const detected = melody.length ? detectKey(melody) : null
  const key = opts.key || detected?.key || 'C'
  const scale = opts.scale ?? detected?.scale ?? STYLES[style].defaultScale

  // 1) 和声：优先用户给的和弦，否则按旋律配（爵士/电子用七和弦并允许副属）
  const seventh = style === 'jazz' || style === 'electronic' || style === 'cinematic'
  const harmonized = opts.chords.length
    ? opts.chords
    : harmonizeMelody(melody, key, scale, barBeats, bars * barBeats, {
        seventh,
        cadence: true,
        secondaryDominants: style === 'jazz',
      })
  const chords = fitChords(harmonized, bars, barBeats, key, scale)

  // 2) 能量：由旋律的力度与密度决定（抒情歌不会配成摇滚）
  const avgVelocity = melody.length ? melody.reduce((a, n) => a + n.velocity, 0) / melody.length : 96
  const noteDensity = bars > 0 ? melody.length / bars : 2
  const inferredEnergy = clamp01(0.18 + (avgVelocity / 127) * 0.55 + Math.min(0.3, noteDensity * 0.09))
  const energy = clamp01(opts.energy ?? inferredEnergy)

  // 3) 段落 + 伴奏
  const sections = buildSections(bars, style)
  const accompaniment = buildAccompaniment({
    ...opts,
    key,
    scale,
    bars,
    chords,
    melody,
    energy,
    sections,
  })

  // 4) 主旋律轨（音色随风格）
  const spec = melodyInstrumentFor(style)
  const inst = getInstrument(spec.instrumentId)
  const emotionId = inst.emotions.some((e) => e.id === spec.emotionId) ? spec.emotionId : inst.emotions[0].id
  const melodyTrack = createTrack({
    instrumentId: inst.id,
    emotionId,
    name: '主旋律',
    color: '#f0d9a8',
    gmProgram: inst.gmProgram,
    volume: 0.84,
    pan: 0,
    reverbSend: 0.24,
    delaySend: 0.08,
  })
  const totalBeats = bars * barBeats
  melodyTrack.clips = [
    createClip({
      trackId: melodyTrack.id,
      name: '旋律',
      startBeat: 0,
      lengthBeats: totalBeats,
      notes: melody
        .filter((n) => n.start < totalBeats - 1e-6)
        .map((n) => createNote(n.pitch, n.start, Math.min(n.duration, totalBeats - n.start), n.velocity)),
    }),
  ]

  // 5) 分析文案
  const melodyRegister = melody.length
    ? `${Math.min(...melody.map((n) => n.pitch))}–${Math.max(...melody.map((n) => n.pitch))}`
    : '—'
  const progressionText = chords
    .map((c) => `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][c.root]}${CHORDS[c.quality].symbol}`)
    .slice(0, 10)
    .join(' - ')
  const analysis = [
    `识别调性：${key} ${scale === 'major' ? '大调' : scale === 'minor' ? '小调' : scale}${detected ? `（置信度 ${(detected.confidence * 100).toFixed(0)}%）` : ''}`,
    `旋律：${bars} 小节 / ${melody.length} 个音 / 音域 ${melodyRegister}`,
    `和声：${progressionText}${chords.length > 10 ? ' …' : ''}`,
    `段落：${sections.map((s) => `${s.name}(${s.bars})`).join(' → ')}`,
    `伴奏声部：${accompaniment.map((t) => t.name).join('、')}`,
    `整体能量：${(energy * 100).toFixed(0)}%（低音自动避开旋律音域，对位声部做反向进行）`,
  ].join('\n')

  return {
    tracks: [melodyTrack, ...accompaniment],
    chords,
    sections,
    key,
    scale,
    analysis,
  }
}

/* ------------------------------------------------------------------ */
/* 需求 2：根据和弦填写旋律                                             */
/* ------------------------------------------------------------------ */

export interface MelodyFromChordsOptions {
  chords: ChordSpec[]
  style: StyleId
  key: string
  scale: ScaleId
  tempo: number
  bars: number
  timeSignature?: TimeSignature
  octave?: number
  density?: number
  complexity?: number
  energy?: number
  seed?: number
  /** 作为参考的既有旋律片段（用于风格模仿） */
  reference?: NoteEvent[]
  instrumentId?: string
  /** 图案（motif / sequence / lyrical / rhythmic） */
  patternId?: string
  /** 情绪预设 id（缺省用该乐器默认情绪） */
  emotionId?: string
  /** 风格画像（可选）：有则按语料统计采样 */
  profile?: StyleProfile
}

export function melodyFromChords(opts: MelodyFromChordsOptions): { notes: NoteEvent[]; track: Track } {
  const timeSignature = opts.timeSignature ?? { numerator: 4, denominator: 4 }
  const barBeats = beatsPerBar(timeSignature)
  const bars = Math.max(1, Math.round(opts.bars))
  const chords = fitChords(opts.chords, bars, barBeats, opts.key, opts.scale)
  const spec = melodyInstrumentFor(opts.style)
  const instrumentId = opts.instrumentId && hasInstrument(opts.instrumentId) ? opts.instrumentId : spec.instrumentId
  const inst = getInstrument(instrumentId)
  const emotionId =
    opts.emotionId && inst.emotions.some((e) => e.id === opts.emotionId)
      ? opts.emotionId
      : instrumentId === spec.instrumentId && inst.emotions.some((e) => e.id === spec.emotionId)
        ? spec.emotionId
        : inst.emotions[0].id
  const octave = opts.octave ?? (instrumentId === spec.instrumentId ? spec.octave : 4)
  const params = defaultSmartParams({
    bars,
    octave,
    density: clamp01(opts.density ?? 0.55),
    complexity: clamp01(opts.complexity ?? 0.55),
    energy: clamp01(opts.energy ?? 0.6),
    swing: clamp01(opts.style === 'jazz' ? 0.42 : opts.style === 'electronic' ? 0.05 : 0.02),
    humanize: 0.24,
    gate: 0.92,
    patternId: opts.patternId,
  })
  const seed = opts.seed ?? 4242
  const notes = generateSmartClip({
    kind: 'melody',
    style: opts.style,
    key: opts.key,
    scale: opts.scale,
    tempo: opts.tempo,
    timeSignature,
    bars,
    params,
    chords,
    seed,
    reference: opts.reference,
    range: inst.range,
    profile: opts.profile,
  })
  const track = createTrack({
    instrumentId,
    emotionId,
    name: 'AI 旋律',
    color: inst.emotions[0].color,
    gmProgram: inst.gmProgram,
    volume: 0.82,
    reverbSend: 0.24,
    delaySend: 0.08,
  })
  track.clips = [
    createClip({
      trackId: track.id,
      name: '旋律',
      startBeat: 0,
      lengthBeats: bars * barBeats,
      notes: notes.map((n) => ({ ...n, id: newId('n') })),
      smart: {
        kind: 'melody',
        style: opts.style,
        seed,
        params,
        key: opts.key,
        scale: opts.scale,
        progression: chords,
      },
    }),
  ]
  return { notes, track }
}

/* ------------------------------------------------------------------ */
/* 一键从零创作                                                        */
/* ------------------------------------------------------------------ */

export interface ComposeOptions {
  style: StyleId
  key?: string
  scale?: ScaleId
  tempo?: number
  bars?: number
  seed?: number
  energy?: number
  /** 使用的和弦进行（罗马数字），缺省用风格模板 */
  progression?: string[]
  name?: string
  swing?: number
  /** 风格画像（可选）：有则按语料统计采样 */
  profile?: StyleProfile
}

/** 各风格的默认主音（按常用调写，听感更自然） */
const STYLE_DEFAULT_KEY: Record<StyleId, string> = {
  classical: 'C',
  rock: 'A',
  electronic: 'A',
  jazz: 'D',
  cinematic: 'D',
  pop: 'C',
  folk: 'G',
}

/** 从零生成一首完整的编曲（工程） */
export function composeProject(opts: ComposeOptions): Project {
  const style = opts.style
  const meta = STYLES[style]
  const timeSignature: TimeSignature = { numerator: 4, denominator: 4 }
  const barBeats = beatsPerBar(timeSignature)
  const key = opts.key ?? STYLE_DEFAULT_KEY[style] ?? 'C'
  const scale = opts.scale ?? meta.defaultScale
  const tempo = opts.tempo ?? meta.defaultTempo
  const bars = Math.max(4, Math.round(opts.bars ?? 16))
  const seed = opts.seed ?? 20260101

  const project = createEmptyProject({
    name: opts.name ?? `${meta.name}作品 · ${key}`,
    style,
    key,
    scale,
    tempo,
    timeSignature: '4/4',
  })
  project.swing = clamp01(opts.swing ?? (style === 'jazz' ? 0.45 : style === 'electronic' ? 0.06 : 0))

  // 段落与和声
  const sections = buildSections(bars, style)
  project.sections = sections
  const seventhStyle = style === 'jazz' || style === 'electronic' || style === 'cinematic'
  const chords = buildProgressionChords(
    opts.progression?.length ? opts.progression : STYLE_PROGRESSIONS[style],
    key,
    scale,
    bars,
    barBeats,
    seventhStyle,
  )
  project.chords = chords

  // 主旋律：前奏之后进入（有前奏概念的风格）
  const introBars = introBarsOf(sections)
  const melodyBars = Math.max(2, bars - introBars)
  const melodyChords = chordsForBarRange(chords, introBars, melodyBars, barBeats)
  const melodyResult = melodyFromChords({
    chords: melodyChords,
    style,
    key,
    scale,
    tempo,
    bars: melodyBars,
    timeSignature,
    seed: createVariationSeed(seed, 9001),
    density: 0.55,
    complexity: 0.58,
    energy: clamp01((opts.energy ?? 0.62) + 0.1),
    profile: opts.profile,
  })
  const melodyTrack = melodyResult.track
  melodyTrack.name = '主旋律'
  melodyTrack.color = '#f0d9a8'
  const melodyClip = melodyTrack.clips[0]
  if (melodyClip) {
    melodyClip.startBeat = introBars * barBeats
    melodyClip.lengthBeats = melodyBars * barBeats
    melodyClip.notes = melodyClip.notes.filter((n) => n.start < melodyClip.lengthBeats)
  }
  const melodyAbsolute = (melodyClip?.notes ?? []).map((n) => ({ ...n, start: n.start + introBars * barBeats }))

  // 伴奏：读取主旋律做对位与低音避让
  const accompaniment = buildAccompaniment({
    style,
    key,
    scale,
    tempo,
    bars,
    chords,
    energy: opts.energy ?? 0.62,
    seed,
    timeSignature,
    melody: melodyAbsolute,
    sections,
    profile: opts.profile,
  })

  project.tracks = [melodyTrack, ...accompaniment]
  project.loop = { enabled: false, startBeat: 0, endBeat: bars * barBeats }
  project.updatedAt = Date.now()
  return project
}

export { voiceLeadChords, CHORDS }
