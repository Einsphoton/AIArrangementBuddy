/**
 * 极简 tar.gz **写入**（P11）：把「已解压目录」回打成 tar.gz，用于 LoRA 适配器归档补建。
 *
 * 背景：离线包（`enginePackage.ts`）原本只从 `<dataDir>/audio-engine/.downloads/<adapter 归档>` 拷贝
 * LoRA 适配器；但用户机器上安装完成后往往只剩解压后的 `<dataDir>/adapters/<id>/`
 * （adapter.json + adapter_model.safetensors），归档缓存被清理 → 打出的离线包缺 LoRA。
 * 这里用纯 Node（node:zlib + 手写 512 字节 ustar 头）把已解压目录**回打**成归档，与 `untar.ts`
 * 的解析口径（普通文件 / ustar prefix / 安全路径）严格对齐，不需要系统 `tar` 命令、不新增依赖。
 *
 * 约定：
 * - 只写普通文件条目（typeflag `0`）：解压方（`extractTarGzToDir`）会按路径自动建目录；
 * - ustar header：name 段 ≤100 字节，超长时按最后一个 `/` 拆到 prefix（≤155 字节），与 untar 的
 *   `prefix/name` 拼接逻辑一致；单段超长（无法拆分）直接抛错；
 * - 路径安全：统一 `/` 分隔、拒绝绝对路径 / 盘符 / `..` / 空名（解压端同样拒绝，写入端先挡一层）；
 * - 确定性：默认 `mtime=0`、按传入顺序写条目，因此「同样的输入 → 同样的字节 → 同样的 sha256」，
 *   离线包 manifest 里的 size/sha256 可以稳定复用。
 */
import { gzipSync } from 'node:zlib'

/** tar 块大小（固定 512 字节） */
const BLOCK_SIZE = 512
/** ustar header 里 name 段 / prefix 段的字节上限 */
const MAX_HEADER_NAME = 100
const MAX_HEADER_PREFIX = 155
/** 八进制 size 字段 12 字节 → 11 位八进制（约 8GB，单文件上限，适配器远小于此） */
const MAX_ENTRY_BYTES = 8 ** 11 - 1

export interface TarFileEntry {
  /** tar 内的相对路径（`/` 分隔）；必须是普通文件条目 */
  name: string
  /** 文件内容 */
  data: Buffer
}

export interface CreateTarGzOptions {
  /** 头里的 mtime（秒级 Unix 时间戳）；默认 0（固定值，保证可复现的字节输出） */
  mtime?: number
}

export type TarEntryInput = Map<string, Buffer> | ReadonlyArray<TarFileEntry>

/** 规范化条目名；不安全时抛错（与 untar.safeArchivePath 的口径一致） */
function normalizeEntryName(name: string): string {
  if (typeof name !== 'string') throw new TypeError('tar 条目名必须是字符串')
  const normalized = name.replace(/\\/g, '/').replace(/^\.\/+/, '')
  if (!normalized) throw new Error('tar 条目名不能为空')
  if (normalized.startsWith('/')) throw new Error(`tar 条目名不能是绝对路径：${name}`)
  if (/^[A-Za-z]:/.test(normalized)) throw new Error(`tar 条目名不能带盘符：${name}`)
  const segments = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.length === 0) throw new Error(`tar 条目名不合法：${name}`)
  if (segments.some((segment) => segment === '..')) throw new Error(`tar 条目名不能包含 ..：${name}`)
  return segments.join('/')
}

function writeString(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8')
  bytes.copy(header, offset, 0, Math.min(bytes.length, length))
}

/** 写八进制数字字段（高位补 0、末尾保留 NUL，符合 tar 约定） */
function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`tar 头字段不能为负数：${value}`)
  const text = Math.floor(value).toString(8)
  if (text.length > length - 1) throw new Error(`tar 头字段溢出（${length - 1} 位八进制）：${value}`)
  writeString(header, offset, length, text.padStart(length - 1, '0'))
}

/** 生成单个 ustar header（512 字节；name 过长时拆到 prefix 段） */
function createHeader(name: string, size: number, mtime: number): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE)
  let shortName = name
  let prefix = ''
  if (Buffer.byteLength(name, 'utf8') > MAX_HEADER_NAME) {
    const segments = name.split('/')
    let split = -1
    for (let index = segments.length - 1; index > 0; index -= 1) {
      const candidatePrefix = segments.slice(0, index).join('/')
      const candidateName = segments.slice(index).join('/')
      if (
        Buffer.byteLength(candidateName, 'utf8') <= MAX_HEADER_NAME &&
        Buffer.byteLength(candidatePrefix, 'utf8') <= MAX_HEADER_PREFIX
      ) {
        prefix = candidatePrefix
        shortName = candidateName
        split = index
        break
      }
    }
    if (split < 0) throw new Error(`tar 条目路径过长（无法用 ustar prefix 拆分）：${name}`)
  }

  writeString(header, 0, MAX_HEADER_NAME, shortName)
  writeOctal(header, 100, 8, 0o644) // mode
  writeOctal(header, 108, 8, 0) // uid
  writeOctal(header, 116, 8, 0) // gid
  writeOctal(header, 124, 12, size)
  writeOctal(header, 136, 12, mtime)
  header.fill(0x20, 148, 156) // 计算校验和时这 8 字节按空格算
  header[156] = '0'.charCodeAt(0) // typeflag：普通文件
  writeString(header, 257, 6, 'ustar\0')
  writeString(header, 263, 2, '00')
  writeString(header, 265, 32, 'root')
  writeString(header, 297, 32, 'root')
  writeString(header, 345, MAX_HEADER_PREFIX, prefix)

  let checksum = 0
  for (const byte of header) checksum += byte
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
  return header
}

function paddingFor(size: number): Buffer | null {
  const remainder = size % BLOCK_SIZE
  if (remainder === 0) return null
  return Buffer.alloc(BLOCK_SIZE - remainder)
}

function toEntryList(entries: TarEntryInput): TarFileEntry[] {
  if (entries instanceof Map) {
    return [...entries].map(([name, data]) => ({ name, data }))
  }
  if (!Array.isArray(entries)) throw new TypeError('createTarGz：entries 必须是 Map<string, Buffer> 或 { name, data } 数组')
  return entries.map((entry) => ({ name: entry?.name, data: entry?.data }))
}

/**
 * 把若干普通文件打成 gzip tar（ustar）并返回完整字节。
 *
 * @example
 * ```ts
 * const archive = createTarGz(new Map([
 *   ['jrpg_v1/adapter.json', readFileSync(configPath)],
 *   ['jrpg_v1/adapter_model.safetensors', readFileSync(weightsPath)],
 * ]))
 * writeFileSync('adapter-jrpg_v1.tar.gz', archive)
 * ```
 */
export function createTarGz(entries: TarEntryInput, opts: CreateTarGzOptions = {}): Buffer {
  const mtime = Number.isFinite(opts.mtime) && (opts.mtime as number) >= 0 ? Math.floor(opts.mtime as number) : 0
  const blocks: Buffer[] = []
  for (const entry of toEntryList(entries)) {
    if (typeof entry.name !== 'string' || !entry.name) throw new Error('createTarGz：条目名不能为空')
    if (!Buffer.isBuffer(entry.data)) throw new TypeError(`createTarGz：条目内容必须是 Buffer（${entry.name}）`)
    const name = normalizeEntryName(entry.name)
    if (entry.data.length > MAX_ENTRY_BYTES) throw new Error(`createTarGz：单文件超过 tar 上限（${name}）`)
    blocks.push(createHeader(name, entry.data.length, mtime))
    if (entry.data.length > 0) blocks.push(entry.data)
    const padding = paddingFor(entry.data.length)
    if (padding) blocks.push(padding)
  }
  // 结束标记：两个全 0 的 512 字节块
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2))
  return gzipSync(Buffer.concat(blocks))
}
