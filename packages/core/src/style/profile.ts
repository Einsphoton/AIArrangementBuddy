/**
 * 风格画像（StyleProfile）—— 语料统计与生成器之间的唯一接口。
 *
 * 设计约束：
 * 1. **纯数据 + 纯函数**：core 不读文件、不碰 IO，画像由服务端加载后传进来；
 * 2. **零回归**：没有画像（Web UI 直接调用）时所有采样返回中性值，行为与改造前完全一致；
 * 3. **可复现**：所有采样都必须吃调用方的 `rnd`（由 seed 派生），保证「同 seed 同结果」。
 *
 * 画像 JSON 的产出方见 `scripts/corpus/profile.mjs`（schema: aiab.style-profile.v1）。
 */

import type { NoteEvent, SmartKind } from '../model.js'

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export interface NumericSummary {
  n?: number
  p10?: number
  p25?: number
  median?: number
  p75?: number
  p90?: number
  mean?: number
}

export interface RoleProfile {
  files?: number
  notesPerBar?: NumericSummary
  meanPitch?: NumericSummary
  pitchRange?: NumericSummary
  polyphony?: NumericSummary
  velocityStd?: NumericSummary
  registerOverlap?: NumericSummary
}

export interface StyleProfile {
  schema?: string
  style: string
  tempo?: NumericSummary
  bars?: NumericSummary
  timeSignature?: { hist?: Record<string, number>; beatsPerBar?: NumericSummary }
  key?: { majorShare?: number; confidenceMedian?: number; tonicHist?: Record<string, number> }
  rhythm?: {
    densityPerBar?: NumericSummary
    tonalDensityPerBar?: NumericSummary
    offbeatRate?: NumericSummary
    offbeat8thRate?: NumericSummary
    gridDeviation16?: NumericSummary
    swingRatio?: NumericSummary
  }
  harmony?: {
    changePerBar?: NumericSummary
    diatonicRate?: NumericSummary
    qualities?: Record<string, number>
    topProgressions?: Array<[string, number]>
  }
  texture?: {
    perRole?: Record<string, RoleProfile>
    layerCount?: NumericSummary
    meanPolyphony?: NumericSummary
  }
  dynamics?: { velocityMean?: NumericSummary; velocityStd?: NumericSummary }
  articulation?: { legatoRatio?: NumericSummary; staccatoRate?: NumericSummary }
  repetition?: { barRepeatRate?: NumericSummary; phrase4RepeatRate?: NumericSummary }
}

/* ------------------------------------------------------------------ */
/* 中性值（无画像时的行为 = 改造前）                                    */
/* ------------------------------------------------------------------ */

/** 中性画像：任何一项都没有统计值，所有采样函数返回中性结果。 */
export function neutralStyleProfile(style: string): StyleProfile {
  return { schema: 'aiab.style-profile.neutral', style }
}

/** 判断一个画像是否真的有统计值（避免把空壳当画像用） */
export function isUsableProfile(profile: StyleProfile | undefined | null): profile is StyleProfile {
  if (!profile) return false
  const has = (summary: NumericSummary | undefined) =>
    summary !== undefined &&
    [summary.p10, summary.p25, summary.median, summary.p75, summary.p90, summary.mean].some((v) => typeof v === 'number')
  if (has(profile.tempo) || has(profile.bars)) return true
  if (has(profile.rhythm?.densityPerBar) || has(profile.rhythm?.swingRatio) || has(profile.rhythm?.offbeat8thRate)) return true
  if (has(profile.rhythm?.offbeatRate) || has(profile.rhythm?.gridDeviation16)) return true
  if (has(profile.harmony?.changePerBar) || has(profile.harmony?.diatonicRate)) return true
  if ((profile.harmony?.topProgressions?.length ?? 0) > 0) return true
  if (has(profile.dynamics?.velocityMean) || has(profile.dynamics?.velocityStd)) return true
  if (has(profile.texture?.layerCount)) return true
  // 只有分角色密度的画像也算可用（语料小的时候常常只有这一项）
  for (const role of Object.values(profile.texture?.perRole ?? {})) {
    if (has(role?.notesPerBar) || has(role?.meanPitch)) return true
  }
  return false
}

/* ------------------------------------------------------------------ */
/* 采样                                                                */
/* ------------------------------------------------------------------ */

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function validSummary(summary: NumericSummary | undefined): NumericSummary | null {
  if (!summary) return null
  const values = [summary.p10, summary.p25, summary.median, summary.p75, summary.p90, summary.mean].filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  )
  return values.length ? summary : null
}

/** 取中位数（没有中位数就退回均值 / p50 近似） */
export function summaryMedian(summary: NumericSummary | undefined): number | null {
  const valid = validSummary(summary)
  if (!valid) return null
  return valid.median ?? valid.mean ?? valid.p25 ?? null
}

/**
 * 在 p25~p75 之间按 rnd 采样（没有分位数就用中位数）。
 * 用四分位区间而不是全区间，是为了避免被长尾极端值拖走。
 */
export function sampleSummary(summary: NumericSummary | undefined, rnd: () => number): number | null {
  const valid = validSummary(summary)
  if (!valid) return null
  const median = valid.median ?? valid.mean
  if (median === null || median === undefined) return null
  const lo = valid.p25 ?? median
  const hi = valid.p75 ?? median
  if (!(hi > lo)) return median
  return lo + (hi - lo) * rnd()
}

/** 速度建议值（用于新工程默认速度 / 风格卡，不直接覆盖用户设置） */
export function profileTempo(profile: StyleProfile, rnd: () => number, fallback: number): number {
  const sampled = sampleSummary(profile.tempo, rnd)
  return sampled === null ? fallback : Math.round(clamp(sampled, 40, 240))
}

/**
 * 从语料的「功能进行 bigram」里走一条随机游走，得到一段罗马数字进行。
 * 数据不足时返回 null，由调用方回落到 `STYLE_PROGRESSIONS`。
 */
export function profileProgression(profile: StyleProfile, rnd: () => number, length = 4): string[] | null {
  const entries = profile.harmony?.topProgressions ?? []
  if (entries.length < 2) return null

  const outgoing = new Map<string, Array<{ to: string; weight: number }>>()
  const incoming = new Map<string, number>()
  for (const [key, weight] of entries) {
    if (typeof key !== 'string' || !Number.isFinite(weight) || weight <= 0) continue
    const [from, to] = key.split('>')
    if (!from || !to) continue
    if (!outgoing.has(from)) outgoing.set(from, [])
    outgoing.get(from)!.push({ to, weight })
    incoming.set(to, (incoming.get(to) ?? 0) + weight)
  }
  if (outgoing.size === 0) return null

  // 起点偏向「最常被接上的和弦」（终止感强的那个），再加一点随机性
  const starts = [...outgoing.keys()].sort((a, b) => (incoming.get(b) ?? 0) - (incoming.get(a) ?? 0))
  const start = starts[Math.min(starts.length - 1, Math.floor(rnd() * Math.min(3, starts.length)))]
  if (!start) return null

  const result = [start]
  let current = start
  for (let i = 1; i < length; i++) {
    const next = outgoing.get(current)
    if (!next?.length) {
      // 走不下去时「回到起点重开一句」，而不是提前结束 ——
      // 语料里的 bigram 常常不成环（例如只有 IV>V、V>I），硬停会得到两和弦的短进行。
      current = start
      if (result[result.length - 1] === start) break
      result.push(start)
      continue
    }
    const total = next.reduce((sum, item) => sum + item.weight, 0)
    let roll = rnd() * total
    let chosen = next[next.length - 1].to
    for (const item of next) {
      roll -= item.weight
      if (roll <= 0) {
        chosen = item.to
        break
      }
    }
    result.push(chosen)
    current = chosen
  }
  return result.length >= 2 ? result.slice(0, length) : null
}

/**
 * 生成器种类 → 画像里的角色。
 * 用于把「语料里这个角色每小节弹多少音」换算成密度缩放系数。
 */
const KIND_ROLES: Record<SmartKind, string[]> = {
  arp: ['guitar', 'keys', 'synthPad', 'harmony'],
  drums: ['drums'],
  bass: ['bass'],
  chords: ['keys', 'guitar', 'harmony', 'strings'],
  melody: ['melody', 'harmony', 'keys', 'guitar'],
  riff: ['guitar'],
  strum: ['guitar', 'folk'],
  counter: ['harmony', 'keys', 'strings'],
  pad: ['strings', 'synthPad', 'ensemble', 'keys'],
}

/** 各生成器在「密度 0.5」时的参考音符数（用于换算倍率） */
const KIND_REFERENCE_DENSITY: Record<SmartKind, number> = {
  arp: 8,
  drums: 8,
  bass: 4,
  chords: 4,
  melody: 3,
  riff: 8,
  strum: 8,
  counter: 3,
  pad: 3,
}

/**
 * 密度缩放系数：语料里该角色每小节 N 个音，对照当前生成器的参考值。
 * 返回值收敛在 [0.65, 1.5]，避免一个极端语料把生成器带跑偏。
 */
export function profileDensityScale(profile: StyleProfile, kind: SmartKind): number {
  const roles = KIND_ROLES[kind] ?? []
  const reference = KIND_REFERENCE_DENSITY[kind] ?? 4
  for (const role of roles) {
    const observed = summaryMedian(profile.texture?.perRole?.[role]?.notesPerBar)
    if (observed !== null && observed > 0) return clamp(observed / reference, 0.65, 1.5)
  }
  return 1
}

/** 力度缩放：语料的平均力度 ÷ 生成器基准 90，收敛在 [0.8, 1.2] */
export function profileVelocityScale(profile: StyleProfile): number {
  const observed = summaryMedian(profile.dynamics?.velocityMean)
  if (observed === null || observed <= 0) return 1
  return clamp(observed / 90, 0.8, 1.2)
}

/**
 * swing 强度 0..1：语料 swingRatio 1.0 = 平直、1.33 = 三连音摇摆。
 * 返回 null 表示语料没给出可信值，调用方保持用户参数。
 */
export function profileSwingAmount(profile: StyleProfile): number | null {
  const observed = summaryMedian(profile.rhythm?.swingRatio)
  if (observed === null) return null
  return clamp((observed - 1) / 0.33, 0, 1)
}

/** 语料里「反拍/切分」的比例，可用于提示生成器偏向切分（0..1） */
export function profileOffbeatRate(profile: StyleProfile): number | null {
  return summaryMedian(profile.rhythm?.offbeat8thRate ?? profile.rhythm?.offbeatRate)
}

/** 语料里和弦变化频率（次/小节），用于提示和声节奏 */
export function profileChordChangeRate(profile: StyleProfile): number | null {
  return summaryMedian(profile.harmony?.changePerBar)
}

/** 语料的调内和弦占比（0..1），越低说明语料越爱用借用和弦 */
export function profileDiatonicRate(profile: StyleProfile): number | null {
  return summaryMedian(profile.harmony?.diatonicRate)
}

/* ------------------------------------------------------------------ */
/* 画像 → 人读风格卡（注入系统提示 / 界面展示）                          */
/* ------------------------------------------------------------------ */

/**
 * 把画像渲染成一段紧凑的「风格卡」文本。
 * 这是 RAG 的第一层：让 LLM 在选和弦、定密度时有具体锚点，而不是凭想象。
 */
export function describeProfile(profile: StyleProfile): string {
  const lines: string[] = []
  const tempo = summaryMedian(profile.tempo)
  const density = summaryMedian(profile.rhythm?.densityPerBar)
  const offbeat = summaryMedian(profile.rhythm?.offbeat8thRate)
  const change = summaryMedian(profile.harmony?.changePerBar)
  const diatonic = summaryMedian(profile.harmony?.diatonicRate)
  const velocity = summaryMedian(profile.dynamics?.velocityMean)
  const layers = summaryMedian(profile.texture?.layerCount)
  const repeat = summaryMedian(profile.repetition?.barRepeatRate)

  if (tempo !== null) lines.push(`速度约 ${Math.round(tempo)} BPM`)
  if (profile.timeSignature?.hist) {
    const top = Object.entries(profile.timeSignature.hist).sort((a, b) => b[1] - a[1])[0]
    if (top) lines.push(`拍号以 ${top[0]} 为主（${Math.round(top[1] * 100)}%）`)
  }
  if (typeof profile.key?.majorShare === 'number') {
    lines.push(`大调 ${Math.round(profile.key.majorShare * 100)}% / 小调 ${Math.round((1 - profile.key.majorShare) * 100)}%`)
  }
  if (change !== null) lines.push(`每小节约 ${change.toFixed(1)} 次和弦变化`)
  if (diatonic !== null) lines.push(`调内和弦占 ${Math.round(diatonic * 100)}%`)
  if (profile.harmony?.topProgressions?.length) {
    const top = profile.harmony.topProgressions.slice(0, 4).map(([prog]) => prog.split('>').join('→'))
    lines.push(`高频进行：${top.join('、')}`)
  }
  if (density !== null) lines.push(`每小节约 ${density.toFixed(1)} 个音`)
  if (offbeat !== null) lines.push(`反拍八分占 ${Math.round(offbeat * 100)}%`)
  if (velocity !== null) lines.push(`平均力度 ${Math.round(velocity)}/127`)
  if (layers !== null) lines.push(`典型 ${Math.round(layers)} 个声部`)
  if (repeat !== null) lines.push(`小节重复率 ${Math.round(repeat * 100)}%`)

  if (!lines.length) return `风格「${profile.style}」暂无可用统计（先跑 pnpm corpus:profile）`
  return `【${profile.style} 风格画像】${lines.join('；')}`
}

/* ------------------------------------------------------------------ */
/* 反序列化                                                            */
/* ------------------------------------------------------------------ */

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function summary(value: unknown): NumericSummary | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const out: NumericSummary = {
    n: num(raw.n),
    p10: num(raw.p10),
    p25: num(raw.p25),
    median: num(raw.median),
    p75: num(raw.p75),
    p90: num(raw.p90),
    mean: num(raw.mean),
  }
  return Object.values(out).some((v) => v !== undefined) ? out : undefined
}

/**
 * 把磁盘上的画像 JSON 转成可信对象。字段缺失是常态（语料小），不做严格校验，
 * 只保证类型正确 —— 采样函数自己会处理「没有值」的情况。
 */
export function coerceStyleProfile(input: unknown): StyleProfile | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  const style = typeof raw.style === 'string' && raw.style ? raw.style : null
  if (!style) return null

  const rhythm = (raw.rhythm ?? {}) as Record<string, unknown>
  const harmony = (raw.harmony ?? {}) as Record<string, unknown>
  const texture = (raw.texture ?? {}) as Record<string, unknown>
  const dynamics = (raw.dynamics ?? {}) as Record<string, unknown>

  const perRole: Record<string, RoleProfile> = {}
  const rawPerRole = (texture.perRole ?? {}) as Record<string, unknown>
  for (const [role, value] of Object.entries(rawPerRole)) {
    if (!value || typeof value !== 'object') continue
    const item = value as Record<string, unknown>
    perRole[role] = {
      files: num(item.files),
      notesPerBar: summary(item.notesPerBar),
      meanPitch: summary(item.meanPitch),
      pitchRange: summary(item.pitchRange),
      polyphony: summary(item.polyphony),
      velocityStd: summary(item.velocityStd),
      registerOverlap: summary(item.registerOverlap),
    }
  }

  const progressions = Array.isArray(harmony.topProgressions)
    ? harmony.topProgressions
        .filter((item): item is [string, number] => Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'number')
        .slice(0, 40)
    : undefined

  const profile: StyleProfile = {
    schema: typeof raw.schema === 'string' ? raw.schema : undefined,
    style,
    tempo: summary(raw.tempo),
    bars: summary(raw.bars),
    timeSignature: raw.timeSignature && typeof raw.timeSignature === 'object'
      ? {
          hist: (raw.timeSignature as Record<string, unknown>).hist as Record<string, number> | undefined,
          beatsPerBar: summary((raw.timeSignature as Record<string, unknown>).beatsPerBar),
        }
      : undefined,
    key: raw.key && typeof raw.key === 'object' ? (raw.key as StyleProfile['key']) : undefined,
    rhythm: {
      densityPerBar: summary(rhythm.densityPerBar),
      tonalDensityPerBar: summary(rhythm.tonalDensityPerBar),
      offbeatRate: summary(rhythm.offbeatRate),
      offbeat8thRate: summary(rhythm.offbeat8thRate),
      gridDeviation16: summary(rhythm.gridDeviation16),
      swingRatio: summary(rhythm.swingRatio),
    },
    harmony: {
      changePerBar: summary(harmony.changePerBar),
      diatonicRate: summary(harmony.diatonicRate),
      qualities: harmony.qualities as Record<string, number> | undefined,
      topProgressions: progressions,
    },
    texture: {
      perRole,
      layerCount: summary(texture.layerCount),
      meanPolyphony: summary(texture.meanPolyphony),
    },
    dynamics: {
      velocityMean: summary(dynamics.velocityMean),
      velocityStd: summary(dynamics.velocityStd),
    },
    articulation: raw.articulation && typeof raw.articulation === 'object'
      ? {
          legatoRatio: summary((raw.articulation as Record<string, unknown>).legatoRatio),
          staccatoRate: summary((raw.articulation as Record<string, unknown>).staccatoRate),
        }
      : undefined,
    repetition: raw.repetition && typeof raw.repetition === 'object'
      ? {
          barRepeatRate: summary((raw.repetition as Record<string, unknown>).barRepeatRate),
          phrase4RepeatRate: summary((raw.repetition as Record<string, unknown>).phrase4RepeatRate),
        }
      : undefined,
  }
  return profile
}
