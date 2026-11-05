/**
 * 极简 ZIP 打包器（无第三方依赖，node:zlib 压缩）。
 * 用于 /api/export/midi?split=true 输出分轨 MIDI 压缩包。
 */
import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date = new Date()): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear())
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f)
  const day = (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  return { time, date: day }
}

export interface ZipEntry {
  /** 压缩包内路径（用 / 分隔） */
  name: string
  data: Buffer
}

interface PreparedEntry {
  name: Buffer
  compressed: Buffer
  crc: number
  uncompressedSize: number
  method: number
  offset: number
}

/** 生成标准 ZIP（deflate；压缩后更大时改用 store） */
export function createZip(entries: ZipEntry[], now = new Date()): Buffer {
  const stamp = dosDateTime(now)
  const prepared: PreparedEntry[] = []
  const localParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8')
    const raw = entry.data
    const deflated = deflateRawSync(raw, { level: 6 })
    const useDeflate = deflated.length < raw.length
    const body = useDeflate ? deflated : raw
    const method = useDeflate ? 8 : 0
    const crc = crc32(raw)

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4) // version needed
    header.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(stamp.time, 10)
    header.writeUInt16LE(stamp.date, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(body.length, 18)
    header.writeUInt32LE(raw.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28)

    const local = Buffer.concat([header, name, body])
    prepared.push({ name, compressed: body, crc, uncompressedSize: raw.length, method, offset })
    localParts.push(local)
    offset += local.length
  }

  const centralParts: Buffer[] = []
  let centralSize = 0
  for (const entry of prepared) {
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(entry.method, 10)
    central.writeUInt16LE(stamp.time, 12)
    central.writeUInt16LE(stamp.date, 14)
    central.writeUInt32LE(entry.crc, 16)
    central.writeUInt32LE(entry.compressed.length, 20)
    central.writeUInt32LE(entry.uncompressedSize, 24)
    central.writeUInt16LE(entry.name.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk start
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(entry.offset, 42)
    const record = Buffer.concat([central, entry.name])
    centralParts.push(record)
    centralSize += record.length
  }

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(prepared.length, 8)
  end.writeUInt16LE(prepared.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, ...centralParts, end])
}
