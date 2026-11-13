/**
 * WAV（RIFF/WAVE）PCM 编码器：16-bit / 24-bit，可选 TPDF 抖动。
 *
 * 设计约束：
 * - 纯函数、零 DOM 依赖（只有 `encodeWavBlob` 用到 Blob），Node 单测可直接 import；
 * - 量化前把样本夹到 [-1, 1) 并把整数结果限制在 [-2^(n-1), 2^(n-1)-1]，
 *   超范围样本只会被夹住，绝不产生整数回绕（回绕就是爆音）；
 * - 抖动用 ±1 LSB 峰值的三角分布（TPDF：两个均匀分布之差），
 *   seed 可注入，同一 seed 输出完全一致，便于回归测试；
 * - 头部固定 44 字节：RIFF/WAVE + fmt（PCM=1）+ data，24-bit 按 3 字节 little-endian signed 写入。
 *
 * 输出位深与抖动策略由调用方（渲染主链）按 `RenderOptions.bitDepth / dither` 决定，
 * 本模块只做编码，不猜测产品默认值。
 */
import type { RenderBitDepth } from './types'

/** RIFF + fmt + data 头部固定长度（PCM，无附加块） */
const HEADER_BYTES = 44

export interface WavEncodeOptions {
  /** 采样率（Hz），必须为正有限数 */
  sampleRate: number
  /** 位深：16（默认）或 24 */
  bitDepth?: RenderBitDepth
  /**
   * 是否加 TPDF 抖动（±1 LSB 三角噪声），默认 false。
   * 渲染主链需要显式开启（历史行为：16-bit 导出默认开启）。
   */
  dither?: boolean
  /** 抖动随机种子；不传则用 Math.random（测试注入固定值以获得确定性输出） */
  ditherSeed?: number
}

/** 位深 -> 每个样本占用字节数；非法位深直接抛错，避免写出坏文件 */
function bytesPerSample(bitDepth: RenderBitDepth): number {
  if (bitDepth === 16) return 2
  if (bitDepth === 24) return 3
  throw new RangeError(`不支持的 WAV 位深：${String(bitDepth)}（仅支持 16 / 24）`)
}

/** 采样率校验：非法值直接抛错（渲染主链应保证传入有效采样率） */
function normalizeSampleRate(sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`非法的 WAV 采样率：${String(sampleRate)}`)
  }
  return Math.round(sampleRate)
}

/** ASCII 写标签（'RIFF' / 'WAVE' / 'fmt ' / 'data'） */
function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i) & 0x7f
}

/** 写 44 字节 PCM 头；dataBytes = 所有采样点占用的字节数 */
function writeHeader(
  bytes: Uint8Array,
  sampleRate: number,
  channels: number,
  bitDepth: RenderBitDepth,
  dataBytes: number,
): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES)
  const blockAlign = channels * bytesPerSample(bitDepth)
  writeAscii(bytes, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true) // RIFF 块大小 = 文件长度 - 8
  writeAscii(bytes, 8, 'WAVE')
  writeAscii(bytes, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt 块大小（PCM 固定 16）
  view.setUint16(20, 1, true) // audioFormat = 1（PCM）
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true) // byteRate
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitDepth, true)
  writeAscii(bytes, 36, 'data')
  view.setUint32(40, dataBytes, true)
}

/** 24-bit 采样：3 字节 little-endian 二进制补码（负数按 2^24 取模） */
function writeInt24(bytes: Uint8Array, offset: number, value: number): void {
  const v = value & 0xffffff
  bytes[offset] = v & 0xff
  bytes[offset + 1] = (v >>> 8) & 0xff
  bytes[offset + 2] = (v >>> 16) & 0xff
}

/**
 * 量化单个样本：
 * - NaN / Infinity 视作 0（安全兜底，避免把 NaN 写进文件）；
 * - 乘满量程后加抖动再四舍五入；
 * - 结果限制在 [-maxInt, maxInt-1]，等价于把输入夹到 [-1, 1)，无回绕。
 */
function quantize(value: number, maxInt: number, noiseLsb: number): number {
  const safe = Number.isFinite(value) ? value : 0
  const rounded = Math.round(safe * maxInt + noiseLsb)
  if (rounded > maxInt - 1) return maxInt - 1
  if (rounded < -maxInt) return -maxInt
  return rounded
}

/** 可 seeded 的 32-bit PRNG（mulberry32）：测试里同一 seed 必须得到同一字节流 */
function createRandom(seed: number | undefined): () => number {
  if (seed === undefined) return Math.random
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 把左右声道编码成 WAV 字节。
 *
 * - `right` 省略 = 单声道；传入时按双声道交织，两侧长度不一致按较短的一侧截断；
 * - 空输入只输出 44 字节头（data 长度 0），不抛错。
 */
export function encodeWavBuffer(
  left: Float32Array,
  right: Float32Array | undefined,
  options: WavEncodeOptions,
): Uint8Array {
  const sampleRate = normalizeSampleRate(options.sampleRate)
  const bitDepth = options.bitDepth ?? 16
  const useDither = options.dither ?? false
  const bytesPer = bytesPerSample(bitDepth)
  const channels = right ? 2 : 1
  const frames = right ? Math.min(left.length, right.length) : left.length
  const dataBytes = frames * channels * bytesPer
  const bytes = new Uint8Array(HEADER_BYTES + dataBytes)
  writeHeader(bytes, sampleRate, channels, bitDepth, dataBytes)
  if (frames === 0) return bytes

  const view = new DataView(bytes.buffer)
  const maxInt = 2 ** (bitDepth - 1)
  const random = useDither ? createRandom(options.ditherSeed) : null
  const frameBytes = channels * bytesPer
  // 16-bit 用 DataView 批量写更省事；24-bit 手写 3 字节
  if (bitDepth === 16) {
    for (let frame = 0; frame < frames; frame++) {
      const offset = HEADER_BYTES + frame * frameBytes
      // TPDF：两个均匀分布之差，范围 (-1, 1) 个 LSB，即 ±1 LSB 峰峰值 2 LSB
      const noiseL = random ? random() - random() : 0
      view.setInt16(offset, quantize(left[frame], maxInt, noiseL), true)
      if (right) {
        const noiseR = random ? random() - random() : 0
        view.setInt16(offset + 2, quantize(right[frame], maxInt, noiseR), true)
      }
    }
  } else {
    for (let frame = 0; frame < frames; frame++) {
      const offset = HEADER_BYTES + frame * frameBytes
      const noiseL = random ? random() - random() : 0
      writeInt24(bytes, offset, quantize(left[frame], maxInt, noiseL))
      if (right) {
        const noiseR = random ? random() - random() : 0
        writeInt24(bytes, offset + 3, quantize(right[frame], maxInt, noiseR))
      }
    }
  }
  return bytes
}

/** 编码为可下载的 Blob（仅浏览器端使用；Node 单测不调用） */
export function encodeWavBlob(
  left: Float32Array,
  right: Float32Array | undefined,
  options: WavEncodeOptions,
): Blob {
  const bytes = encodeWavBuffer(left, right, options)
  // 复制到独立 ArrayBuffer：Blob 不应引用渲染过程可能复用的底层缓冲
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return new Blob([buffer], { type: 'audio/wav' })
}

/**
 * 预估 WAV 文件字节数（44 字节头 + 采样数据）。
 * 帧数按四舍五入计算，与实际编码时的 `Float32Array.length` 对齐。
 * 传入非法时长/采样率/声道数时按 0 帧或最小声道数处理，不抛错。
 */
export function estimateWavBytes(
  durationSec: number,
  sampleRate: number,
  bitDepth: RenderBitDepth,
  channels: number,
): number {
  const fs = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : 0
  const sec = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
  const ch = Number.isFinite(channels) && channels >= 1 ? Math.round(channels) : 1
  const frames = Math.max(0, Math.round(sec * fs))
  return HEADER_BYTES + frames * ch * bytesPerSample(bitDepth)
}
