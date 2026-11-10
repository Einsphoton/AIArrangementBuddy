/**
 * 极简 ZIP 读取器（无第三方依赖，压缩体用 node:zlib 的 inflateRawSync 解压）。
 *
 * 为什么需要它：仓库里已有零依赖 ZIP 写入器（apps/server/src/zip.ts，导出分轨 MIDI 用），
 * 但同步包要「导出 + 导入」双向可用，且 node_modules 里没有已声明的 zip 库（fflate 只是
 * 某个包的传递依赖，未在 apps/server 的依赖里，不能直接 import）。因此这里补一个只读解析器，
 * 不新增 npm 依赖，同步包保持单文件 `.aiabsync`（标准 ZIP）。
 *
 * 支持范围（覆盖同步包与常见 ZIP）：
 * - 中央目录（EOCD + central directory）定位，不依赖 data descriptor；
 * - 压缩方法 0（store）/ 8（deflate）；
 * - 目录条目跳过；UTF-8 文件名（best effort）；
 * - 拒绝：ZIP64、加密条目、重名条目、解压后 >512MB（防 zip bomb）。
 * 不写盘，只返回内存中的 条目名 → Buffer，因此天然规避 zip-slip。
 */
import { inflateRawSync } from 'node:zlib'

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

/** 条目数上限（同步包通常只有几十个文件） */
const MAX_ENTRIES = 4096
/** 解压后总大小上限：超过按 zip bomb 处理 */
const MAX_TOTAL_UNCOMPRESSED = 512 * 1024 * 1024

function findEndOfCentralDirectory(buffer: Buffer): number {
  // EOCD 固定 22 字节，后面可能跟最多 65535 字节注释
  const minOffset = Math.max(0, buffer.length - 22 - 0xffff)
  for (let offset = buffer.length - 22; offset >= minOffset; offset--) {
    if (buffer.readUInt32LE(offset) === SIG_EOCD) return offset
  }
  throw new Error('不是合法的 ZIP：找不到中央目录结尾（可能文件损坏或被截断）')
}

/**
 * 读取 ZIP 的所有文件条目。
 * @returns 条目名（用 / 分隔）→ 解压后的内容；目录条目会被跳过。
 */
export function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('不是合法的 ZIP：文件太小')
  const eocd = findEndOfCentralDirectory(buffer)

  const totalEntries = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('暂不支持的 ZIP64 同步包（请用普通 zip 重新打包）')
  }
  if (totalEntries === 0) throw new Error('同步包是空的（ZIP 里没有文件）')
  if (totalEntries > MAX_ENTRIES) throw new Error(`同步包条目过多（${totalEntries} > ${MAX_ENTRIES}）`)
  if (centralOffset + centralSize > buffer.length) throw new Error('不是合法的 ZIP：中央目录越界')

  const entries = new Map<string, Buffer>()
  let cursor = centralOffset
  let totalUncompressed = 0

  for (let index = 0; index < totalEntries; index++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== SIG_CENTRAL) {
      throw new Error('不是合法的 ZIP：中央目录损坏')
    }
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)

    const nameStart = cursor + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd + extraLength + commentLength > buffer.length) throw new Error('不是合法的 ZIP：条目名越界')
    const name = buffer.toString('utf8', nameStart, nameEnd)
    cursor = nameEnd + extraLength + commentLength

    // 目录条目（以 / 结尾）没有内容
    if (!name || name.endsWith('/')) continue
    if ((flags & 0x0001) !== 0) throw new Error(`同步包里有加密条目，暂不支持：${name}`)
    if (method !== 0 && method !== 8) {
      throw new Error(`不支持的 ZIP 压缩方法 ${method}（仅支持 store / deflate）：${name}`)
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`不是合法的 ZIP：找不到条目 ${name} 的本地头`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length) throw new Error(`不是合法的 ZIP：条目 ${name} 的数据越界`)

    const raw = buffer.subarray(dataStart, dataEnd)
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    totalUncompressed += data.length
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) {
      throw new Error(`同步包解压后过大（>${Math.round(MAX_TOTAL_UNCOMPRESSED / 1024 / 1024)}MB）`)
    }
    if (uncompressedSize !== 0 && data.length !== uncompressedSize) {
      throw new Error(`ZIP 条目 ${name} 解压后大小不符（${data.length} ≠ ${uncompressedSize}）`)
    }
    if (entries.has(name)) throw new Error(`ZIP 包内有重名条目：${name}`)
    entries.set(name, data)
  }

  return entries
}
