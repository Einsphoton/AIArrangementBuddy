/**
 * 演奏层人性化 —— 用「语料里真人演奏的统计」去抖动生成结果。
 *
 * 为什么单独一层：同样一堆音符，等力度 + 严格网格听起来像音源 demo，
 * 按真实演奏的力度分布与时序偏差抖动之后就像人弹的。这是性价比最高的听感改进。
 *
 * 纯函数 + 由 seed 驱动，因此仍然满足「同 seed 同结果」。
 */

import type { NoteEvent } from '../model.js'

export interface HumanizeOptions {
  /** 随机种子（与生成器同一个可复现体系） */
  seed: number
  /** 人性化强度 0..1（来自 SmartParams.humanize） */
  amount: number
  /** 语料的力度标准差（画像 dynamics.velocityStd）；缺省用 6 */
  velocityStd?: number
  /** 语料的网格偏离（画像 rhythm.gridDeviation16，单位：16 分音符） */
  gridDeviation16?: number
  /** 打击乐不做时值抖动（时值是鼓组语义的一部分） */
  isDrums?: boolean
}

/** 本地 PRNG：避免与 generators 的 mulberry32 形成循环依赖 */
function xorshift32(seed: number): () => number {
  let state = (seed >>> 0) || 0x9e3779b9
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 4294967296
  }
}

/** 近似正态（三个均匀分布之和），范围约 [-1, 1]，标准差约 0.58 */
function gaussianLike(rnd: () => number): number {
  return (rnd() + rnd() + rnd() - 1.5) / 1.5
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * 对音符做力度与微时序抖动。
 * @returns 新的音符数组（不修改入参）；amount 为 0 时原样返回
 */
export function humanizeNotes(notes: NoteEvent[], options: HumanizeOptions): NoteEvent[] {
  const amount = clamp(options.amount, 0, 1)
  if (!notes.length || amount <= 0) return notes

  const rnd = xorshift32(options.seed ^ 0x5bf03635)
  const velocitySigma = clamp(options.velocityStd ?? 6, 0, 24) * amount * 0.85
  // gridDeviation16 = 1 表示平均偏离一个 16 分音符（0.25 拍）；实际演奏远小于此
  const timingSigma = clamp((options.gridDeviation16 ?? 0.04) * amount * 0.06, 0, 0.02)

  return notes
    .map((note) => {
      const velocity = clamp(Math.round(note.velocity + gaussianLike(rnd) * velocitySigma), 1, 127)
      const start = options.isDrums ? note.start : Math.max(0, note.start + gaussianLike(rnd) * timingSigma)
      return { ...note, velocity, start: Math.round(start * 1e6) / 1e6 }
    })
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch)
}
