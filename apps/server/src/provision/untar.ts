/**
 * 极简 tar.gz 解压（P8）：只服务于官方 ACE-Step 运行时包与 LoRA 适配器（扁平/单层 ustar/pax）。
 * 不新增依赖：node:zlib 解压 + 手写 512 字节块解析。
 *
 * P8 修复：官方 macOS 运行时包里的 dylib 用相对软链（libggml.0.dylib -> libggml.0.9.8.dylib），
 * 原来只收 typeflag '0' 普通文件，软链被跳过 → ace-server 启动时 dyld 找不到 @rpath 库。
 * 现在解析 typeflag '2'，并提供 extractTarGzToDir 把「普通文件 + 软链」一起安全落盘。
 */
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { gunzipSync } from 'node:zlib'

const MAX_ENTRIES = 4096
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
const MAX_SYMLINK_CHAIN = 16

export interface TarEntries {
  /** 普通文件：相对路径 → 文件内容 */
  files: Map<string, Buffer>
  /** 软链：相对路径 → 相对目标（tar header 里的 linkname） */
  symlinks: Map<string, string>
}

export interface ExtractTarGzToDirOptions {
  log?: (message: string) => void
}

export interface ExtractTarGzToDirResult {
  /** 写入的普通文件数 */
  files: number
  /** 创建的软链数 */
  symlinks: number
  /** Windows 无软链权限时回退复制的文件数 */
  copies: number
}

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

/** 解析 pax 扩展头（记录格式：`<长度> <key>=<value>\n`） */
function parsePax(data: Buffer): Record<string, string> {
  const result: Record<string, string> = {}
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space < 0) break
    const length = Number.parseInt(data.subarray(offset, space).toString('utf8'), 10)
    if (!Number.isFinite(length) || length <= 0 || offset + length > data.length) break
    const record = data.subarray(space + 1, offset + length).toString('utf8')
    const separator = record.indexOf('=')
    if (separator > 0) {
      const key = record.slice(0, separator)
      const value = record.slice(separator + 1).replace(/\n$/, '')
      if (key) result[key] = value
    }
    offset += length
  }
  return result
}

/**
 * 规范化 tar 内的相对路径；不安全（绝对路径 / 盘符 / `..` 段 / 空）时返回 null。
 * 导出给 installer 等调用方复用，保证路径处理口径一致。
 */
export function safeArchivePath(name: string): string | null {
  const normalized = name.replace(/\\/g, '/').replace(/^\.\/+/, '')
  if (!normalized || normalized === '.') return null
  if (normalized.startsWith('/')) return null
  if (/^[A-Za-z]:/.test(normalized)) return null
  const segments = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '..')) return null
  return segments.join('/')
}

/** 软链目标必须是相对路径，且按层级不能直接越出所在目录（最终还会按真实落盘位置二次校验） */
export function isSafeSymlinkTarget(target: string): boolean {
  const normalized = target.replace(/\\/g, '/').trim()
  if (!normalized || normalized.startsWith('/')) return false
  if (/^[A-Za-z]:/.test(normalized)) return false
  let depth = 0
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      depth -= 1
      if (depth < 0) return false
    } else {
      depth += 1
    }
  }
  return depth >= 0
}

/**
 * 解析 gzip tar，返回普通文件与软链（目录/元数据条目跳过；pax path/linkpath/size 覆盖已支持）。
 * 路径在解析阶段就做安全校验，命中不安全路径直接抛错（拒绝整包）。
 */
export function extractTarGzEntries(compressed: Buffer): TarEntries {
  const tar = gunzipSync(compressed)
  const files = new Map<string, Buffer>()
  const symlinks = new Map<string, string>()
  let offset = 0
  let totalBytes = 0
  let pendingPax: Record<string, string> = {}
  let globalPax: Record<string, string> = {}

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    const headerName = readString(header, 0, 100)
    if (!headerName) {
      // 连续的 0 块 = 结束标记
      break
    }
    const typeflag = String.fromCharCode(header[156] ?? 0)
    const headerSize = readOctal(header, 124, 12)
    const prefix = readString(header, 345, 155)
    const pax = { ...globalPax, ...pendingPax }
    pendingPax = {}
    const declaredSize = pax.size ? Number.parseInt(pax.size, 10) : headerSize
    const size = Number.isFinite(declaredSize) && declaredSize >= 0 ? declaredSize : headerSize
    const name = pax.path ?? (prefix ? `${prefix}/${headerName}` : headerName)
    const linkname = pax.linkpath ?? readString(header, 157, 100)
    const dataOffset = offset + 512
    const dataEnd = dataOffset + size
    if (dataEnd > tar.length) throw new Error(`tar 包损坏：${name} 的数据区越界`)
    const data = tar.subarray(dataOffset, dataEnd)

    if (typeflag === 'x') {
      // pax 扩展头：仅作用于下一个条目
      pendingPax = parsePax(data)
    } else if (typeflag === 'g') {
      // pax 全局扩展头：作用于后续所有条目
      globalPax = { ...globalPax, ...parsePax(data) }
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      const safeName = safeArchivePath(name)
      if (!safeName) throw new Error(`tar 包含不安全的文件路径：${name}`)
      if (files.size + symlinks.size >= MAX_ENTRIES) throw new Error(`tar 条目数超过 ${MAX_ENTRIES}，拒绝解压`)
      totalBytes += size
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('tar 解压后体积超过 2GB，拒绝解压')
      files.set(safeName, Buffer.from(data))
    } else if (typeflag === '2') {
      const safeName = safeArchivePath(name)
      if (!safeName) throw new Error(`tar 包含不安全的软链路径：${name}`)
      if (!isSafeSymlinkTarget(linkname)) throw new Error(`tar 软链目标不安全（必须是相对且不越界）：${safeName} -> ${linkname}`)
      if (files.size + symlinks.size >= MAX_ENTRIES) throw new Error(`tar 条目数超过 ${MAX_ENTRIES}，拒绝解压`)
      symlinks.set(safeName, linkname.replace(/\\/g, '/').trim())
    }
    // 目录 '5'、GNU 长文件名 'L'/'K'、其他类型条目按 size 跳过
    offset = dataOffset + Math.ceil(size / 512) * 512
  }
  return { files, symlinks }
}

/** 解压 gzip tar；只返回普通文件（保留旧 API，training.ts 等仍可用；软链条目忽略）。 */
export function extractTarGz(compressed: Buffer): Map<string, Buffer> {
  const { files, symlinks } = extractTarGzEntries(compressed)
  if (files.size === 0 && symlinks.size === 0) throw new Error('tar 包为空或格式不支持')
  return files
}

function lstatSafe(target: string): Stats | null {
  try {
    return lstatSync(target)
  } catch {
    return null
  }
}

function resolveInside(root: string, relative: string): string {
  const resolved = path.resolve(root, relative)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`tar 条目路径越界：${relative}`)
  }
  return resolved
}

/** 阻止通过已有软链目录把文件写到 root 之外 */
function assertNoSymlinkParents(root: string, target: string): void {
  const parent = path.dirname(target)
  const relative = path.relative(root, parent)
  if (!relative) return
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`tar 条目路径越界：${target}`)
  }
  let current = root
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue
    current = path.join(current, segment)
    const stat = lstatSafe(current)
    if (!stat) return // 后续目录尚不存在，安全
    if (stat.isSymbolicLink()) throw new Error(`tar 条目路径经过符号链接，拒绝写入：${current}`)
    if (!stat.isDirectory()) throw new Error(`tar 条目路径被非目录占用：${current}`)
  }
}

/** 解析软链最终指向的真实路径（支持软链套软链；返回 null 表示无法解析/越界） */
function resolveSymlinkChain(
  root: string,
  destination: string,
  linkTarget: string,
  symlinks: Map<string, string>,
): string | null {
  let current = path.resolve(path.dirname(destination), linkTarget)
  if (!current.startsWith(root + path.sep) && current !== root) return null
  for (let depth = 0; depth < MAX_SYMLINK_CHAIN; depth += 1) {
    const relative = path.relative(root, current).split(path.sep).join('/')
    const nextTarget = symlinks.get(relative)
    if (!nextTarget) return current
    current = path.resolve(path.dirname(current), nextTarget)
    if (!current.startsWith(root + path.sep) && current !== root) return null
  }
  return null
}

function removeExisting(target: string): void {
  const stat = lstatSafe(target)
  if (!stat) return
  rmSync(target, { force: true, recursive: true })
}

/**
 * 解压 gzip tar 到指定目录：普通文件 writeFileSync、软链 symlinkSync。
 * - 所有条目路径禁止 `..` / 绝对路径 / 盘符 / 经软链逃逸；
 * - 软链目标必须是相对路径且不能逃出 dir；
 * - Windows 上软链可能因权限失败：回退为复制目标文件（打日志，不影响安装）。
 */
export function extractTarGzToDir(
  compressed: Buffer,
  dir: string,
  options: ExtractTarGzToDirOptions = {},
): ExtractTarGzToDirResult {
  const { files, symlinks } = extractTarGzEntries(compressed)
  const root = path.resolve(dir)
  mkdirSync(root, { recursive: true })
  let fileCount = 0
  let symlinkCount = 0
  let copyCount = 0

  // 先落普通文件：Windows 软链回退复制时目标文件已经存在
  for (const [relative, data] of files) {
    const destination = resolveInside(root, relative)
    assertNoSymlinkParents(root, destination)
    removeExisting(destination)
    mkdirSync(path.dirname(destination), { recursive: true })
    writeFileSync(destination, data)
    fileCount += 1
  }

  for (const [relative, linkTarget] of symlinks) {
    const destination = resolveInside(root, relative)
    assertNoSymlinkParents(root, destination)
    mkdirSync(path.dirname(destination), { recursive: true })
    removeExisting(destination)
    const resolvedTarget = resolveSymlinkChain(root, destination, linkTarget, symlinks)
    if (!resolvedTarget) {
      throw new Error(`tar 软链目标越界或无法解析：${relative} -> ${linkTarget}`)
    }
    try {
      symlinkSync(linkTarget, destination)
      symlinkCount += 1
    } catch (error) {
      const stat = lstatSafe(resolvedTarget)
      if (process.platform === 'win32' && stat?.isFile()) {
        copyFileSync(resolvedTarget, destination)
        copyCount += 1
        options.log?.(`符号链接创建失败（${(error as Error).message}），已复制文件代替：${relative}`)
      } else {
        throw error
      }
    }
  }

  if (fileCount === 0 && symlinkCount === 0 && copyCount === 0) {
    throw new Error('tar 包为空或格式不支持')
  }
  return { files: fileCount, symlinks: symlinkCount, copies: copyCount }
}

/** 便捷读取：从 .tar.gz 路径解压到目录（installer 等调用方使用） */
export function extractTarGzFileToDir(
  archivePath: string,
  dir: string,
  options: ExtractTarGzToDirOptions = {},
): ExtractTarGzToDirResult {
  return extractTarGzToDir(readFileSync(archivePath), dir, options)
}
