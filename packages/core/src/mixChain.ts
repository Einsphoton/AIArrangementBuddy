/**
 * 音频域处理链（P3）：每轨 EQ + 压缩，落成可撤销的参数，由 Web Audio 引擎实时执行。
 *
 * 与 `mix.ts` 的分工：
 * - `mix.ts` 管"推子"（音量/声像/发送/总线）——不改音色；
 * - 本文件管"音色与动态"（三段 EQ + 压缩 + 补偿增益）——真正改变听感。
 *
 * 设计约束：
 * - 纯数据 + 纯函数，不 import model（避免 model ↔ mix 的循环依赖）；
 * - 所有参数裁剪到安全范围，schema 校验不过就是无效链；
 * - 不追求"母带级"，目标是"每轨更清楚、不打架"，且用户能一键撤销。
 */
import { z } from 'zod'
import { STYLES, type StyleId } from './constants.js'

/* ------------------------------------------------------------------ */
/* 角色                                                                */
/* ------------------------------------------------------------------ */

export const MIX_ROLES = ['drums', 'bass', 'harmony', 'pad', 'lead', 'counter', 'arp', 'other'] as const
export type MixRole = (typeof MIX_ROLES)[number]

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

export const eqBandSchema = z.object({
  /** 中心/搁架频率（Hz） */
  hz: z.number().min(20).max(20000),
  /** 增益（dB） */
  gainDb: z.number().min(-18).max(18),
  /** 仅 peaking 用 */
  q: z.number().min(0.1).max(12).optional(),
})

export const compressorSchema = z.object({
  thresholdDb: z.number().min(-60).max(0),
  ratio: z.number().min(1).max(20),
  attackSec: z.number().min(0.0005).max(0.5),
  releaseSec: z.number().min(0.01).max(2),
  kneeDb: z.number().min(0).max(40),
})

/** 侧链 ducking：用某个源轨（默认鼓组）的包络压低本轨音量 */
export const duckSchema = z.object({
  enabled: z.boolean().default(true),
  /** 触发源轨道 id；留空 = 引擎自动找鼓组轨 */
  sourceTrackId: z.string().optional(),
  /** 最大衰减量（dB，负值；-3 轻微、-12 明显） */
  amountDb: z.number().min(-24).max(0),
  attackSec: z.number().min(0.0005).max(0.1),
  releaseSec: z.number().min(0.02).max(1),
})

export const mixChainSchema = z.object({
  enabled: z.boolean().default(true),
  eq: z.object({
    lowShelf: eqBandSchema,
    mid: eqBandSchema,
    highShelf: eqBandSchema,
  }),
  compressor: compressorSchema,
  /** 补偿增益（dB），抵消 EQ 提升带来的响度变化 */
  makeupDb: z.number().min(-12).max(12),
  /** 侧链 ducking（可选）：贝斯让位给底鼓之类的动感处理 */
  duck: duckSchema.optional(),
})
export type MixChain = z.infer<typeof mixChainSchema>

export const trackChainSuggestionSchema = z.object({
  trackId: z.string(),
  name: z.string(),
  role: z.enum(MIX_ROLES),
  chain: mixChainSchema,
  reasons: z.array(z.string()).default([]),
})
export type TrackChainSuggestion = z.infer<typeof trackChainSuggestionSchema>

/* ------------------------------------------------------------------ */
/* 角色基准链                                                          */
/* ------------------------------------------------------------------ */

type ChainTarget = Omit<MixChain, 'enabled'>

const NEUTRAL: ChainTarget = {
  eq: {
    lowShelf: { hz: 90, gainDb: 0 },
    mid: { hz: 1000, gainDb: 0, q: 0.9 },
    highShelf: { hz: 8000, gainDb: 0 },
  },
  compressor: { thresholdDb: -18, ratio: 2, attackSec: 0.01, releaseSec: 0.2, kneeDb: 12 },
  makeupDb: 0,
}

const ROLE_TARGETS: Record<MixRole, ChainTarget> = {
  drums: {
    eq: {
      lowShelf: { hz: 60, gainDb: 2 },
      mid: { hz: 420, gainDb: -1.5, q: 1.1 },
      highShelf: { hz: 6500, gainDb: 1.5 },
    },
    compressor: { thresholdDb: -14, ratio: 4, attackSec: 0.005, releaseSec: 0.12, kneeDb: 6 },
    makeupDb: 1,
  },
  bass: {
    eq: {
      lowShelf: { hz: 80, gainDb: 2 },
      mid: { hz: 320, gainDb: -2, q: 1.0 },
      highShelf: { hz: 8000, gainDb: -1 },
    },
    compressor: { thresholdDb: -18, ratio: 3.5, attackSec: 0.01, releaseSec: 0.18, kneeDb: 8 },
    makeupDb: 0.5,
  },
  harmony: {
    eq: {
      lowShelf: { hz: 110, gainDb: -2 },
      mid: { hz: 1800, gainDb: 1.5, q: 0.9 },
      highShelf: { hz: 6000, gainDb: 1 },
    },
    compressor: { thresholdDb: -20, ratio: 3, attackSec: 0.008, releaseSec: 0.14, kneeDb: 10 },
    makeupDb: 0.5,
  },
  pad: {
    eq: {
      lowShelf: { hz: 120, gainDb: -1.5 },
      mid: { hz: 900, gainDb: -1, q: 0.7 },
      highShelf: { hz: 7000, gainDb: 1.5 },
    },
    compressor: { thresholdDb: -24, ratio: 2.5, attackSec: 0.02, releaseSec: 0.3, kneeDb: 14 },
    makeupDb: 0,
  },
  lead: {
    eq: {
      lowShelf: { hz: 150, gainDb: -3 },
      mid: { hz: 3000, gainDb: 2, q: 1.2 },
      highShelf: { hz: 8000, gainDb: 1 },
    },
    compressor: { thresholdDb: -16, ratio: 3, attackSec: 0.006, releaseSec: 0.15, kneeDb: 8 },
    makeupDb: 0.5,
  },
  counter: {
    eq: {
      lowShelf: { hz: 140, gainDb: -2.5 },
      mid: { hz: 2400, gainDb: 1, q: 1.0 },
      highShelf: { hz: 7500, gainDb: 0.5 },
    },
    compressor: { thresholdDb: -20, ratio: 2.8, attackSec: 0.008, releaseSec: 0.16, kneeDb: 10 },
    makeupDb: 0.5,
  },
  arp: {
    eq: {
      lowShelf: { hz: 200, gainDb: -3 },
      mid: { hz: 3500, gainDb: 1, q: 1.1 },
      highShelf: { hz: 9000, gainDb: 1.5 },
    },
    compressor: { thresholdDb: -22, ratio: 2.5, attackSec: 0.006, releaseSec: 0.2, kneeDb: 12 },
    makeupDb: 0,
  },
  other: NEUTRAL,
}

/** 风格微调（小幅度，避免风格特征被处理链抹平） */
const STYLE_TWEAKS: Partial<Record<StyleId, { compRatio?: number; highShelf?: number; lowShelf?: number }>> = {
  electronic: { compRatio: 1.5, highShelf: 0.5 },
  classical: { compRatio: -1, highShelf: -0.5 },
  jazz: { compRatio: -0.5 },
  jrpg: { compRatio: 0.5, highShelf: 0.5 },
  jrock: { compRatio: 1, highShelf: 0.5 },
  rock: { compRatio: 1 },
  cinematic: { compRatio: -0.5, lowShelf: 0.5 },
}

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value))
const round = (value: number, digits = 2) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * 给某个声部角色生成处理链。
 * energy 高 → 压缩略收紧（更"贴脸"）；低 → 保留动态。
 */
export function suggestRoleChain(role: MixRole, style: StyleId, energy = 0.6): MixChain {
  const target = ROLE_TARGETS[role] ?? NEUTRAL
  const tweak = STYLE_TWEAKS[style] ?? {}
  const energyUp = clamp(energy - 0.6, -0.4, 0.4)

  const lowGain = clamp(target.eq.lowShelf.gainDb + (tweak.lowShelf ?? 0), -12, 12)
  const highGain = clamp(target.eq.highShelf.gainDb + (tweak.highShelf ?? 0), -12, 12)
  const ratio = clamp(target.compressor.ratio + (tweak.compRatio ?? 0) + energyUp * 6, 1, 12)
  const threshold = clamp(target.compressor.thresholdDb - energyUp * 8, -40, -3)

  // 补偿：EQ 净提升的一半（别把电平推爆，也别把动态压死）
  const makeup = clamp(-(lowGain + highGain) * 0.5 + target.makeupDb, -6, 6)

  return {
    enabled: true,
    eq: {
      lowShelf: { hz: round(target.eq.lowShelf.hz, 0), gainDb: round(lowGain) },
      mid: {
        hz: round(target.eq.mid.hz, 0),
        gainDb: round(target.eq.mid.gainDb),
        q: round(target.eq.mid.q ?? 0.9, 2),
      },
      highShelf: { hz: round(target.eq.highShelf.hz, 0), gainDb: round(highGain) },
    },
    compressor: {
      thresholdDb: round(threshold),
      ratio: round(ratio),
      attackSec: round(target.compressor.attackSec, 4),
      releaseSec: round(target.compressor.releaseSec, 3),
      kneeDb: round(target.compressor.kneeDb, 0),
    },
    makeupDb: round(makeup, 1),
  }
}

/** 人类可读的链摘要（UI/日志用） */
export function describeChain(chain: MixChain): string {
  if (!chain.enabled) return '未启用'
  const { lowShelf, mid, highShelf } = chain.eq
  const c = chain.compressor
  return (
    `低频 ${lowShelf.gainDb > 0 ? '+' : ''}${lowShelf.gainDb}dB@${lowShelf.hz}Hz · ` +
    `中频 ${mid.gainDb > 0 ? '+' : ''}${mid.gainDb}dB@${mid.hz}Hz · ` +
    `高频 ${highShelf.gainDb > 0 ? '+' : ''}${highShelf.gainDb}dB@${highShelf.hz}Hz · ` +
    `压缩 ${c.thresholdDb}dB ${c.ratio}:1`
  )
}

/** 风格中文名（给 reasons 用） */
export function styleLabel(style: StyleId): string {
  return STYLES[style]?.name ?? style
}
