/**
 * ITU-R BS.1770-4 响度测量与归一（纯函数，零依赖）。
 *
 * 提供三件事：
 * 1. `measureIntegratedLufs`：K 加权（高架 + 高通两级 biquad）→ 400ms 块 / 75% 重叠
 *    → -70 LUFS 绝对门限 → 相对门限（绝对门限内块均值 -10 LU）→ 积分响度；
 * 2. `truePeakDb`：4x 线性插值近似真峰值（线性插值不会超出相邻样本的包络，
 *    因此是"不低估采样峰值"的保守近似；要捕捉 inter-sample peak 需要真过采样）；
 * 3. `normalizeLoudness`：增益 + lookahead 限峰（≈5ms 前瞻、慢释放、只做平滑乘性衰减，
 *    不硬 clamp），迭代补偿到目标响度；返回前后响度 / 峰值 / 是否被限峰 / 残差。
 *
 * K 加权系数按 BS.1770-4 的模拟原型用双线性变换现算（与规范附录 48kHz 系数表逐位一致），
 * 因此 44.1k / 48k / 96k 都可用。静音返回 -Infinity，NaN 视为 0，绝不向外抛 NaN。
 */

/** 积分门限：绝对门限（LUFS） */
const ABSOLUTE_GATE_LUFS = -70
/** 相对门限：比绝对门限内的块均值低 10 LU（存正值，计算时相减） */
const RELATIVE_GATE_LU = 10
/** 块长（秒）：BS.1770 规定 400ms */
const BLOCK_SECONDS = 0.4
/** 重叠率 75% => 步进 100ms */
const BLOCK_OVERLAP = 0.75
/** BS.1770 响度公式常数：-0.691 dB */
const LOUDNESS_OFFSET_DB = -0.691

/** 限峰器前瞻窗口（秒）：峰值到来前 5ms 就开始平滑下压 */
const LIMITER_LOOKAHEAD_SECONDS = 0.005
/** 限峰器释放时间（秒）：增益回涨较慢，避免抽吸感 */
const LIMITER_RELEASE_SECONDS = 0.1
/** 归一迭代上限：每轮「补增益 → 限峰 → 重新测量」（含首次），最多 3 轮 */
const MAX_NORMALIZE_ITERATIONS = 3
/** 收敛阈值（LU）：与目标差距小于该值就不再补增益 */
const CONVERGED_LU = 0.05

/** 默认归一目标（流媒体常用 -14 LUFS） */
export const DEFAULT_TARGET_LUFS = -14
/** 默认峰值上限（-1 dBFS，避免编码/重采样时溢出） */
export const DEFAULT_CEILING_DB = -1

/** 两级 biquad 系数（已按 a0 归一化） */
interface BiquadCoefficients {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/** 采样率校验：非法值抛可读错误（渲染主链应保证传入有效采样率） */
function normalizeSampleRate(sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`非法的采样率：${String(sampleRate)}`)
  }
  return Math.round(sampleRate)
}

/**
 * K 加权第一级：高架预滤波。
 * 模拟原型：+4 dB 高架，中心 1681.97 Hz，Q = 0.70718；双线性变换后与 BS.1770-4 附录系数一致。
 */
function preFilterCoefficients(sampleRate: number): BiquadCoefficients {
  const f0 = 1681.974450955533
  const gainDb = 3.999843853973347
  const q = 0.7071752369554196
  const k = Math.tan((Math.PI * f0) / sampleRate)
  const vh = 10 ** (gainDb / 20)
  const vb = vh ** 0.4996667741545416
  const a0 = 1 + k / q + k * k
  return {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  }
}

/** K 加权第二级：RLB 二阶高通（38.14 Hz，Q = 0.50033） */
function highPassCoefficients(sampleRate: number): BiquadCoefficients {
  const f0 = 38.13547087602444
  const q = 0.5003270373238773
  const k = Math.tan((Math.PI * f0) / sampleRate)
  const a0 = 1 + k / q + k * k
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  }
}

/** 单通道 K 加权：两级 biquad 串行，Direct Form I，NaN 输入按 0 处理 */
function applyKWeighting(input: Float32Array, sampleRate: number): Float32Array {
  const pre = preFilterCoefficients(sampleRate)
  const highPass = highPassCoefficients(sampleRate)
  const out = new Float32Array(input.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  let u1 = 0
  let u2 = 0
  let v1 = 0
  let v2 = 0
  for (let i = 0; i < input.length; i++) {
    const x = Number.isFinite(input[i]) ? input[i] : 0
    const y = pre.b0 * x + pre.b1 * x1 + pre.b2 * x2 - pre.a1 * y1 - pre.a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    const v = highPass.b0 * y + highPass.b1 * u1 + highPass.b2 * u2 - highPass.a1 * v1 - highPass.a2 * v2
    u2 = u1
    u1 = y
    v2 = v1
    v1 = v
    out[i] = v
  }
  return out
}

/** 求 [start, start + count) 区间的均方值（count 为 0 时返回 0） */
function meanSquare(samples: Float32Array, start: number, count: number): number {
  if (count <= 0) return 0
  let sum = 0
  const end = Math.min(samples.length, start + count)
  for (let i = start; i < end; i++) {
    const value = samples[i]
    sum += value * value
  }
  return sum / count
}

/**
 * 计算单通道每个 400ms 块的均方能量（逐块，75% 重叠）。
 * 信号短于 400ms 时退化成整段一个块（避免短片段永远测不出响度）。
 */
function blockEnergiesOf(samples: Float32Array, frameCount: number, sampleRate: number): number[] {
  if (frameCount <= 0) return []
  const weighted = applyKWeighting(samples, sampleRate)
  const blockSize = Math.max(1, Math.round(BLOCK_SECONDS * sampleRate))
  const hop = Math.max(1, Math.round(blockSize * (1 - BLOCK_OVERLAP)))
  const energies: number[] = []
  if (frameCount < blockSize) {
    energies.push(meanSquare(weighted, 0, frameCount))
    return energies
  }
  for (let start = 0; start + blockSize <= frameCount; start += hop) {
    energies.push(meanSquare(weighted, start, blockSize))
  }
  return energies
}

/** 块能量（多通道求和）-> 块响度（LUFS） */
function blockLoudness(energy: number): number {
  if (!(energy > 0)) return Number.NEGATIVE_INFINITY
  return LOUDNESS_OFFSET_DB + 10 * Math.log10(energy)
}

/**
 * 测量积分响度（LUFS）。
 *
 * - 立体声按左右声道能量求和（G = 1.0，见 BS.1770 表 1）；
 * - 静音 / 全 NaN / 空输入返回 -Infinity（不会返回 NaN）；
 * - 时长不足 400ms 时整段作为一个块计算。
 */
export function measureIntegratedLufs(
  left: Float32Array,
  right: Float32Array | undefined,
  sampleRate: number,
): number {
  const fs = normalizeSampleRate(sampleRate)
  const leftData = left && left.length > 0 ? left : null
  if (!leftData) return Number.NEGATIVE_INFINITY
  const rightData = right && right.length > 0 ? right : null
  const frames = rightData ? Math.min(leftData.length, rightData.length) : leftData.length
  if (frames <= 0) return Number.NEGATIVE_INFINITY

  const leftEnergies = blockEnergiesOf(leftData, frames, fs)
  const rightEnergies = rightData ? blockEnergiesOf(rightData, frames, fs) : null
  const energies: number[] = []
  for (let i = 0; i < leftEnergies.length; i++) {
    const rightEnergy = rightEnergies ? (rightEnergies[i] ?? 0) : 0
    energies.push(leftEnergies[i] + rightEnergy)
  }
  if (energies.length === 0) return Number.NEGATIVE_INFINITY

  // 第一轮：绝对门限 -70 LUFS
  const gated: number[] = []
  for (const energy of energies) {
    if (blockLoudness(energy) > ABSOLUTE_GATE_LUFS) gated.push(energy)
  }
  if (gated.length === 0) return Number.NEGATIVE_INFINITY
  const absoluteMean = gated.reduce((sum, energy) => sum + energy, 0) / gated.length
  // 第二轮：相对门限 = 绝对门限内的块均值 - 10 LU（更安静的块不计入积分响度）
  const relativeThreshold = blockLoudness(absoluteMean) - RELATIVE_GATE_LU
  let sum = 0
  let count = 0
  for (const energy of gated) {
    if (blockLoudness(energy) > relativeThreshold) {
      sum += energy
      count++
    }
  }
  // 相对门限必然保留至少一个块（最大值 >= 均值），这里仍做兜底
  const finalMean = count > 0 ? sum / count : absoluteMean
  return blockLoudness(finalMean)
}

/** 单通道近似真峰值：采样点绝对值 + 相邻点之间 4x 线性插值（1/4、2/4、3/4 处） */
function channelPeak(samples: Float32Array): number {
  let peak = 0
  const last = samples.length - 1
  for (let i = 0; i < samples.length; i++) {
    const current = Number.isFinite(samples[i]) ? samples[i] : 0
    const abs = Math.abs(current)
    if (abs > peak) peak = abs
    if (i < last) {
      const next = Number.isFinite(samples[i + 1]) ? samples[i + 1] : 0
      const step = (next - current) / 4
      for (let k = 1; k <= 3; k++) {
        const interpolated = Math.abs(current + step * k)
        if (interpolated > peak) peak = interpolated
      }
    }
  }
  return peak
}

/**
 * 近似真峰值（dBFS）：采样峰值 + 相邻样本之间 4x 线性插值取最大绝对值。
 *
 * 注意：线性插值只能落在相邻两样本之间，因此结果等于（不会低于）采样峰值，
 * 是"绝不低估实际峰值"的保守近似；真正捕捉 inter-sample peak 需要 4x 以上过采样。
 * 静音返回 -Infinity。
 */
export function truePeakDb(left: Float32Array, right: Float32Array | undefined, sampleRate: number): number {
  // 线性插值近似不依赖采样率，参数保留是为了与未来「真 4x 过采样」实现保持签名一致
  void sampleRate
  let peak = left ? channelPeak(left) : 0
  if (right && right.length > 0) peak = Math.max(peak, channelPeak(right))
  return peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY
}

/** 逐样本乘增益（原地）；NaN 样本按 0 处理，避免污染后续编码 */
function scaleInPlace(samples: Float32Array, gain: number): void {
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Number.isFinite(samples[i]) ? samples[i] * gain : 0
  }
}

/** 清掉非有限样本（NaN / ±Infinity -> 0）：静音分支也要做，避免脏样本流进编码器 */
function sanitizeInPlace(samples: Float32Array): void {
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) samples[i] = 0
  }
}

/**
 * 计算限峰所需的「允许增益」包络（分块处理，避免为整段音频额外分配大数组）。
 *
 * envelope[i] = min(1, ceiling / windowPeak[i])，
 * 其中 windowPeak[i] = 所有声道 |x| 在 [i - r, i + r] 窗口内的最大值。
 * 用窗口峰值而不是逐样本峰值是「不产生贴顶平台」的关键：
 * 一段瞬态（例如 4ms 脉冲）整体落在同一个窗口里时 windowPeak 恒定，
 * 增益也恒定 —— 波形被等比例压低、形状保留；逐样本 clamp 才会把峰削成平台。
 */
function fillLimiterEnvelope(
  channels: Float32Array[],
  frames: number,
  windowRadius: number,
  ceilingLinear: number,
): { envelope: Float32Array; limited: boolean } {
  const envelope = new Float32Array(frames)
  // 分块：每块额外带 radius 的 padding，块内用单调队列算滑动窗口最大值
  const chunkSize = 1 << 16
  const capacity = chunkSize + windowRadius * 2
  const peaks = new Float32Array(capacity)
  const windowed = new Float32Array(capacity)
  const deque = new Int32Array(capacity)
  let limited = false

  for (let start = 0; start < frames; start += chunkSize) {
    const count = Math.min(chunkSize, frames - start)
    const from = Math.max(0, start - windowRadius)
    const to = Math.min(frames, start + count + windowRadius)
    const length = to - from

    // 1) 每帧峰值（左右声道取最大）
    for (let i = 0; i < length; i++) {
      const frame = from + i
      let peak = 0
      for (const channel of channels) {
        if (frame >= channel.length) continue
        const value = channel[frame]
        const abs = Number.isFinite(value) ? Math.abs(value) : 0
        if (abs > peak) peak = abs
      }
      peaks[i] = peak
    }

    // 2) 单调队列求 [i-radius, i+radius] 窗口最大值
    let head = 0
    let tail = 0
    for (let i = 0; i < length; i++) {
      while (tail > head && peaks[deque[tail - 1]] <= peaks[i]) tail--
      deque[tail++] = i
      if (deque[head] < i - windowRadius) head++
      windowed[i] = peaks[deque[head]]
    }
    head = 0
    tail = 0
    for (let i = length - 1; i >= 0; i--) {
      while (tail > head && peaks[deque[tail - 1]] <= peaks[i]) tail--
      deque[tail++] = i
      if (deque[head] > i + windowRadius) head++
      if (peaks[deque[head]] > windowed[i]) windowed[i] = peaks[deque[head]]
    }

    // 3) 只写本块主体的允许增益（padding 区域是相邻块的主体）
    for (let i = 0; i < count; i++) {
      const windowPeak = windowed[start - from + i]
      if (windowPeak > ceilingLinear) {
        envelope[start + i] = ceilingLinear / windowPeak
        limited = true
      } else {
        envelope[start + i] = 1
      }
    }
  }
  return { envelope, limited }
}

/**
 * lookahead 限峰：乘一条平滑增益包络，把峰值压到 ceiling 以内。
 *
 * 纯乘性处理，**不做硬 clamp**，因此输出没有贴顶的削波平台：
 * 1. 用 [i-r, i+r] 窗口内的最大峰值决定允许增益（r ≈ 2.5ms，总前瞻约 5ms）；
 * 2. 反向扫描做攻击平滑：包络每样本最多下降 attackStep（≈5ms 走完 1→0），
 *    且始终 <= 允许增益 —— 峰值点精确满足约束、峰值到来前几毫秒就开始下压；
 * 3. 正向扫描做释放平滑：包络每样本最多回升 releaseStep（≈100ms 恢复满增益）；
 * 4. 同一条包络作用于所有声道，保持声像与立体声关系。
 *
 * @returns 是否真的做了衰减（有样本超过 ceiling）
 */
function applyLookaheadLimiter(channels: Float32Array[], sampleRate: number, ceilingLinear: number): boolean {
  let frames = 0
  for (const channel of channels) frames = Math.max(frames, channel.length)
  if (frames === 0 || !(ceilingLinear > 0)) return false
  const windowRadius = Math.max(1, Math.round((LIMITER_LOOKAHEAD_SECONDS * sampleRate) / 2))
  const attackSamples = Math.max(1, Math.round(LIMITER_LOOKAHEAD_SECONDS * sampleRate))
  const releaseSamples = Math.max(1, Math.round(LIMITER_RELEASE_SECONDS * sampleRate))
  const attackStep = 1 / attackSamples
  const releaseStep = 1 / releaseSamples

  const { envelope, limited } = fillLimiterEnvelope(channels, frames, windowRadius, ceilingLinear)
  if (!limited) return false

  // 攻击平滑（反向）：保证每个样本 gain <= 允许增益，且下降坡度受 attackStep 限制
  let next = 1
  for (let i = frames - 1; i >= 0; i--) {
    const value = Math.min(envelope[i], next + attackStep)
    envelope[i] = value
    next = value
  }
  // 释放平滑（正向）：增益回升坡度受 releaseStep 限制
  let previous = 1
  for (let i = 0; i < frames; i++) {
    const value = Math.min(envelope[i], previous + releaseStep)
    envelope[i] = value
    previous = value
  }

  for (const channel of channels) {
    const count = Math.min(frames, channel.length)
    for (let i = 0; i < count; i++) {
      const value = channel[i]
      channel[i] = Number.isFinite(value) ? value * envelope[i] : 0
    }
  }
  return true
}

export interface NormalizeLoudnessOptions {
  /** 目标积分响度（LUFS），默认 -14 */
  targetLufs?: number
  /** 峰值上限（dBFS），默认 -1；超过 0 按 0 处理（保证不削顶） */
  ceilingDb?: number
}

export interface LoudnessNormalizeResult {
  /**
   * 实际施加的总（宽带）增益（dB）：各轮「补到目标」的增益之和。
   * 限峰时峰值附近会被包络额外衰减，因此这个数不等于逐样本增益；
   * 未触发限峰时等于 `targetLufs - lufsBefore`。
   */
  gainDb: number
  /** 归一前积分响度（静音为 -Infinity） */
  lufsBefore: number
  /** 归一后积分响度（静音为 -Infinity） */
  lufsAfter: number
  /** 归一后近似真峰值（dBFS） */
  peakDb: number
  /** 是否触发了 lookahead 限峰（有样本曾超过 ceiling） */
  limited: boolean
  /** 残余误差（dB）：`targetLufs - lufsAfter`，0 表示达标；极端素材可能为正（没补够） */
  shortfallDb: number
}

/**
 * 响度归一（原地修改样本）：增益 + lookahead 限峰 + 迭代补偿。
 *
 * 对每个迭代轮次：
 * 1. 按「目标 - 当前响度」施加宽带增益（先抬到目标电平）；
 * 2. lookahead 限峰把峰值压到 ceiling 以内（平滑包络、不硬削波）；
 * 3. 重新测积分响度，若仍低于目标就再补增益（最多 {@link MAX_NORMALIZE_ITERATIONS} 轮）。
 *
 * 这样高 crest（峰值高、平均能量低）的素材也能把平均响度顶到 target，
 * 而不是「一抬就撞 ceiling、整体缩回」。极端素材（例如持续满幅方波 + 目标 0 LUFS）
 * 无法同时满足 target 与 ceiling，会在 `shortfallDb` 里如实报告残差（通常在 1~3 dB 内）。
 *
 * 静音 / 全 NaN 输入不做响度归一，返回 gainDb = 0 且响度字段为 -Infinity（不产生 NaN）；
 * 其中非有限样本（NaN / ±Infinity）会被清成 0，避免脏样本流进 WAV 编码器。
 */
export function normalizeLoudness(
  left: Float32Array,
  right: Float32Array | undefined,
  sampleRate: number,
  options: NormalizeLoudnessOptions = {},
): LoudnessNormalizeResult {
  const fs = normalizeSampleRate(sampleRate)
  const targetLufs = Number.isFinite(options.targetLufs) ? (options.targetLufs as number) : DEFAULT_TARGET_LUFS
  const ceilingDb = Number.isFinite(options.ceilingDb) ? Math.min(0, options.ceilingDb as number) : DEFAULT_CEILING_DB
  const ceilingLinear = 10 ** (ceilingDb / 20)
  const lufsBefore = measureIntegratedLufs(left, right, fs)
  if (!Number.isFinite(lufsBefore)) {
    // 静音 / 全 NaN：不归一，但把 NaN / ±Infinity 清成 0，保证后续编码安全
    sanitizeInPlace(left)
    if (right && right.length > 0) sanitizeInPlace(right)
    return {
      gainDb: 0,
      lufsBefore,
      lufsAfter: lufsBefore,
      peakDb: truePeakDb(left, right, fs),
      limited: false,
      shortfallDb: 0,
    }
  }

  // 先清掉非有限样本（限峰器只处理有限值，避免把 NaN 带进包络计算）
  sanitizeInPlace(left)
  if (right && right.length > 0) sanitizeInPlace(right)
  const channels: Float32Array[] = right && right.length > 0 ? [left, right] : [left]

  let lufs = lufsBefore
  let totalGainDb = 0
  let limited = false
  for (let iteration = 0; iteration < MAX_NORMALIZE_ITERATIONS; iteration++) {
    const correctionDb = targetLufs - lufs
    // 第一轮必须跑（即使已经接近目标，也要保证峰值 <= ceiling）；之后够接近就收敛
    if (iteration > 0 && Math.abs(correctionDb) <= CONVERGED_LU) break
    if (Math.abs(correctionDb) > 0.001) {
      const gain = 10 ** (correctionDb / 20)
      for (const channel of channels) scaleInPlace(channel, gain)
      totalGainDb += correctionDb
    }
    limited = applyLookaheadLimiter(channels, fs, ceilingLinear) || limited
    lufs = measureIntegratedLufs(left, right, fs)
  }

  const peakDb = truePeakDb(left, right, fs)
  const shortfallDb = Number.isFinite(lufs) ? targetLufs - lufs : 0
  return { gainDb: totalGainDb, lufsBefore, lufsAfter: lufs, peakDb, limited, shortfallDb }
}
