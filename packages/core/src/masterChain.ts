/**
 * 总线 / 母带处理链（P3.2）：总线 EQ + 母线压缩 + 补偿增益 + 限幅上限。
 *
 * 与 `mixChain.ts`（每轨）的分工：这里作用于整首混音，目标是"粘合 + 响度控制 + 不糊"。
 * 纯数据 + 纯函数，不 import model（避免循环依赖）。
 */
import { z } from 'zod'
import { STYLES, type StyleId } from './constants.js'

/** 多段总线压缩：低/中/高 三段各自压缩后再合并 */
export const multibandSchema = z.object({
  enabled: z.boolean().default(true),
  low: z.object({
    thresholdDb: z.number().min(-60).max(0),
    ratio: z.number().min(1).max(20),
    attackSec: z.number().min(0.001).max(0.3),
    releaseSec: z.number().min(0.02).max(1.5),
  }),
  mid: z.object({
    thresholdDb: z.number().min(-60).max(0),
    ratio: z.number().min(1).max(20),
    attackSec: z.number().min(0.001).max(0.3),
    releaseSec: z.number().min(0.02).max(1.5),
  }),
  high: z.object({
    thresholdDb: z.number().min(-60).max(0),
    ratio: z.number().min(1).max(20),
    attackSec: z.number().min(0.001).max(0.3),
    releaseSec: z.number().min(0.02).max(1.5),
  }),
  /** 分频点（Hz）：low 段上沿 / mid 段上沿 */
  crossoverHz: z.tuple([z.number().min(60).max(600), z.number().min(1500).max(8000)]).default([200, 3000]),
})

export const masterChainSchema = z.object({
  enabled: z.boolean().default(true),
  eq: z.object({
    lowShelf: z.object({ hz: z.number().min(20).max(400), gainDb: z.number().min(-12).max(12) }),
    mid: z.object({
      hz: z.number().min(200).max(5000),
      gainDb: z.number().min(-12).max(12),
      q: z.number().min(0.2).max(6),
    }),
    highShelf: z.object({ hz: z.number().min(2000).max(16000), gainDb: z.number().min(-12).max(12) }),
  }),
  compressor: z.object({
    thresholdDb: z.number().min(-40).max(0),
    ratio: z.number().min(1).max(10),
    attackSec: z.number().min(0.001).max(0.2),
    releaseSec: z.number().min(0.05).max(1.5),
    kneeDb: z.number().min(0).max(30),
  }),
  /** 显式补偿增益（dB）：抵消 EQ 与压缩造成的电平变化 */
  makeupDb: z.number().min(-6).max(6),
  /** 输出限幅上限（dBFS），默认 -1 */
  limiterCeilingDb: z.number().min(-6).max(0),
  /** 多段总线压缩（可选） */
  multiband: multibandSchema.optional(),
})
export type MasterChain = z.infer<typeof masterChainSchema>

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value))
const round = (value: number, digits = 2) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** 风格 → 母线粘合强度（压缩比与阈值微调） */
const STYLE_GLUE: Partial<Record<StyleId, { ratio?: number; threshold?: number; mid?: number; high?: number }>> = {
  electronic: { ratio: 0.8, threshold: -2, high: 0.5 },
  rock: { ratio: 0.6, threshold: -1, high: 0.3 },
  jrock: { ratio: 0.7, threshold: -1, high: 0.4 },
  jrpg: { ratio: 0.4, threshold: -1, high: 0.3 },
  cinematic: { ratio: -0.2, threshold: 1, mid: -0.3 },
  classical: { ratio: -0.6, threshold: 2, high: -0.4 },
  jazz: { ratio: -0.4, threshold: 1, mid: -0.2 },
  pop: { ratio: 0.4, high: 0.3 },
  folk: { ratio: -0.2, mid: -0.2 },
}

/**
 * 生成总线 / 母带处理链。
 * 语义：温和粘合（1.5–2.5:1）、去浑浊（300–500Hz 微减）、提空气感（10kHz 微加）、
 * 高能量段落稍微收紧、低能量保留动态；限幅默认 -1dBFS。
 */
export function suggestMasterChain(
  style: StyleId,
  energy = 0.6,
  trackCount = 8,
): MasterChain {
  const glue = STYLE_GLUE[style] ?? {}
  const energyUp = clamp(energy - 0.6, -0.4, 0.4)
  // 轨数越多，中频越容易堆叠：中频削减略增
  const densityMud = clamp((trackCount - 6) * 0.08, 0, 0.6)

  const ratio = clamp(1.6 + (glue.ratio ?? 0) + energyUp * 1.6, 1.1, 4)
  const threshold = clamp(-20 + (glue.threshold ?? 0) - energyUp * 6, -34, -10)
  const midGain = clamp(-0.8 + (glue.mid ?? 0) - densityMud, -3, 0.5)
  const highGain = clamp(0.6 + (glue.high ?? 0) + energyUp * 0.4, -1, 2)
  const lowGain = clamp(0.8 - energyUp * 0.3, -1, 2)
  const makeup = clamp(-(lowGain + highGain + midGain) * 0.35, -3, 3)

  return {
    enabled: true,
    eq: {
      lowShelf: { hz: 100, gainDb: round(lowGain, 1) },
      mid: { hz: 420, gainDb: round(midGain, 1), q: round(0.9 + densityMud * 0.3, 2) },
      highShelf: { hz: 10000, gainDb: round(highGain, 1) },
    },
    compressor: {
      thresholdDb: round(threshold, 1),
      ratio: round(ratio, 2),
      attackSec: round(0.02 + energyUp * 0.01, 3),
      releaseSec: round(0.22, 3),
      kneeDb: 20,
    },
    makeupDb: round(makeup, 1),
    limiterCeilingDb: -1,
  }
}

/** 人类可读摘要（UI/日志用） */
export function describeMasterChain(chain: MasterChain): string {
  if (!chain.enabled) return '未启用'
  const { lowShelf, mid, highShelf } = chain.eq
  const c = chain.compressor
  const sign = (v: number) => (v > 0 ? '+' : '')
  return (
    `总线 EQ：低 ${sign(lowShelf.gainDb)}${lowShelf.gainDb}dB@${lowShelf.hz}Hz · ` +
    `中 ${sign(mid.gainDb)}${mid.gainDb}dB@${mid.hz}Hz · 高 ${sign(highShelf.gainDb)}${highShelf.gainDb}dB@${highShelf.hz}Hz · ` +
    `母线压缩 ${c.thresholdDb}dB ${c.ratio}:1 · 限幅 ${chain.limiterCeilingDb}dBFS`
  )
}

/** 中文原因（给 UI 预览） */
export function masterChainReasons(style: StyleId, energy = 0.6): string[] {
  const reasons = [
    '母线轻度压缩做粘合（1.5–2.5:1），不要压成"响度墙"',
    '300–500Hz 微减，消除多轨堆叠的浑浊',
    '10kHz 微加空气感；限幅 -1dBFS 留余量',
  ]
  if (energy > 0.72) reasons.push('高能量：阈值下移、压缩比略增')
  else if (energy < 0.45) reasons.push('低能量：保留动态，压缩更轻')
  if ((STYLE_GLUE[style]?.ratio ?? 0) >= 0.6) reasons.push(`${STYLES[style]?.name ?? style}：需要更紧的母线粘合`)
  return reasons
}
