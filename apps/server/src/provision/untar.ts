/**
 * 极简 tar.gz 解压（P8）：只服务于官方 ACE-Step 运行时包（扁平 ustar/pax）。
 * 不新增依赖：node:zlib 解压 + 手写 512 字节块解析。
 */
import { gunzipSync } from 'node:zlib'

const MAX_ENTRIES = 4096
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

function readString(buffer: Buffer, offset: number, length: number): string {
  const raw = buffer.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8').trim()
}

function readOctal(buffer: Buffer, offset: number, length: number): number {
  const text = readString(buffer, offset, length).replace(/\0/g, '').trim()
  if (!text) return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}

/** 解压 gzip tar；只返回普通文件（目录/链接/元数据条目跳过）。 */
export function extractTarGz(compressed: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(compressed)
  const entries = new Map<string, Buffer>()
  let offset = 0
  let totalBytes = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    const name = readString(header, 0, 100)
    if (!name) {
      // 连续的 0 块 = 结束标记
      break
    }
    const size = readOctal(header, 124, 12)
    const typeflag = String.fromCharCode(header[156] ?? 0)
    const prefix = readString(header, 345, 155)
    const fullName = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, '')
    const dataOffset = offset + 512
    const dataEnd = dataOffset + size
    if (dataEnd > tar.length) throw new Error(`tar 包损坏：${fullName} 的数据区越界`)
    if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      if (entries.size >= MAX_ENTRIES) throw new Error(`tar 条目数超过 ${MAX_ENTRIES}，拒绝解压`)
      totalBytes += size
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('tar 解压后体积超过 2GB，拒绝解压')
      entries.set(fullName, Buffer.from(tar.subarray(dataOffset, dataEnd)))
    }
    // pax/GNU 扩展头（x/g/L/K）也按其 size 跳过
    offset = dataOffset + Math.ceil(size / 512) * 512
  }
  if (entries.size === 0) throw new Error('tar 包为空或格式不支持')
  return entries
}