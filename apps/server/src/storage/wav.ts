/**
 * 极简 WAV 解析 + 波形峰值提取（服务端用，无第三方依赖）。
 *
 * 只支持 RIFF/WAVE：PCM 16/24/32 bit 与 IEEE float 32/64。
 * 立体声取两声道平均；峰值按桶存 min/max，前端画波形用。
 */

export interface WavInfo {
  sampleRate: number
  channels: number
  bitsPerSample: number
  durationSec: number
  /** 每桶 [min, max]（-1..1）交错排列，长度 = buckets*2 */
  peaks: number[]
}

export const DEFAULT_PEAK_BUCKETS = 512

function readAscii(buffer: Buffer, offset: number, length: number): string {
  return buffer.toString('latin1', offset, offset + length)
}

export function parseWav(buffer: Buffer, buckets = DEFAULT_PEAK_BUCKETS): WavInfo {
  if (buffer.length < 44 || readAscii(buffer, 0, 4) !== 'RIFF' || readAscii(buffer, 8, 4) !== 'WAVE') {
    throw new Error('不是合法的 WAV 文件（缺少 RIFF/WAVE 头）')
  }

  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null
  let dataOffset = -1
  let dataSize = 0
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const chunkId = readAscii(buffer, offset, 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (chunkId === 'fmt ' && body + 16 <= buffer.length) {
      fmt = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      }
    } else if (chunkId === 'data') {
      dataOffset = body
      dataSize = Math.min(chunkSize, buffer.length - body)
      break
    }
    offset = body + chunkSize + (chunkSize % 2)
  }

  if (!fmt) throw new Error('WAV 缺少 fmt 块')
  if (dataOffset < 0 || dataSize <= 0) throw new Error('WAV 缺少 data 块')
  if (![1, 3].includes(fmt.audioFormat)) {
    throw new Error(`暂只支持 PCM / float WAV（当前 audioFormat=${fmt.audioFormat}，请先转成 WAV PCM16）`)
  }
  const bytesPerSample = fmt.bitsPerSample / 8
  if (![2, 3, 4, 8].includes(bytesPerSample)) throw new Error(`不支持的位深 ${fmt.bitsPerSample}`)
  const frameSize = bytesPerSample * fmt.channels
  const frames = Math.floor(dataSize / frameSize)
  if (frames <= 0) throw new Error('WAV 没有音频帧')

  const readSample = (byteOffset: number): number => {
    if (fmt!.audioFormat === 3) {
      return bytesPerSample === 4 ? buffer.readFloatLE(byteOffset) : buffer.readDoubleLE(byteOffset)
    }
    if (fmt!.bitsPerSample === 16) return buffer.readInt16LE(byteOffset) / 32768
    if (fmt!.bitsPerSample === 24) {
      const v = buffer.readIntLE(byteOffset, 3)
      return v / 8388608
    }
    return buffer.readInt32LE(byteOffset) / 2147483648
  }

  const perBucket = Math.max(1, Math.ceil(frames / buckets))
  const peaks: number[] = []
  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = bucket * perBucket
    const end = Math.min(frames, start + perBucket)
    if (start >= frames) {
      peaks.push(0, 0)
      continue
    }
    let min = 0
    let max = 0
    for (let frame = start; frame < end; frame++) {
      let sum = 0
      for (let ch = 0; ch < fmt.channels; ch++) sum += readSample(dataOffset + frame * frameSize + ch * bytesPerSample)
      const value = sum / fmt.channels
      if (value < min) min = value
      if (value > max) max = value
    }
    peaks.push(Math.round(min * 1000) / 1000, Math.round(max * 1000) / 1000)
  }

  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    durationSec: frames / fmt.sampleRate,
    peaks,
  }
}
