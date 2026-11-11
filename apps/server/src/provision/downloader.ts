/**
 * 下载器（P8）：代理感知 + 断点续传 + sha256 校验 + 网络错误重试 + 进度回调。
 *
 * 只依赖 Node 内置（fetch / fs / crypto / stream），不新增依赖；
 * 默认 fetchImpl 是 net/proxy.ts 的 proxyAwareFetch（有代理时自建 CONNECT 隧道），
 * 同时保留 fetchImpl 注入 seam，便于用本地 HTTP 服务做无网络单测（含 Range 续传、重试）。
 *
 * 关键行为：
 *   - 已有 .part 续传时，先把已有字节流式喂进同一个 sha256，再继续追加（不再为了哈希从头重下）；
 *   - 206 用 content-range 解析总大小；服务器忽略 Range 返回 200 时截断 .part 并重置哈希；
 *   - attempts（默认 3）只在网络类错误与 HTTP 429/5xx 时重试，指数退避 800ms→2s，重试复用 Range；
 *   - sha256/大小不符不自动重试，保持可读错误；
 *   - 网络错误信息带代理诊断提示，避免 UI 只看到 "fetch failed"。
 */
import { createHash } from 'node:crypto'
import type { Hash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { networkFailureOf, proxyAwareFetch, type NetworkFailure } from '../net/proxy.js'
import { sleep } from '../util.js'

export interface DownloadProgress {
  received: number
  total: number
}

export interface DownloadOptions {
  url: string
  dest: string
  sha256?: string
  size?: number
  onProgress?: (progress: DownloadProgress) => void
  signal?: AbortSignal
  /** 可注入的 fetch（单测用）；默认走代理感知的 proxyAwareFetch */
  fetchImpl?: typeof fetch
  /** 进度回调节流（毫秒） */
  progressIntervalMs?: number
  /** 网络类错误 / HTTP 429/5xx 的最大尝试次数（默认 3）；sha256/大小不符不重试 */
  attempts?: number
  log?: (message: string) => void
}

export interface DownloadResult {
  status: 'downloaded' | 'cached'
  path: string
  bytes: number
}

const DEFAULT_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 800
const RETRY_MAX_DELAY_MS = 2000

/** 非 2xx 响应（429/5xx 可重试；416 在清理分片后可重试） */
class DownloadHttpError extends Error {
  readonly status: number
  readonly retryable: boolean

  constructor(status: number, message: string, retryable = false) {
    super(message)
    this.name = 'DownloadHttpError'
    this.status = status
    this.retryable = retryable
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** 把已有 .part 的字节流式喂进同一个 hash（用于续传时补齐前半段哈希） */
async function feedHashFromFile(hash: Hash, path: string): Promise<number> {
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer
    hash.update(buffer)
    bytes += buffer.length
  }
  return bytes
}

interface ContentRange {
  start?: number
  end?: number
  total?: number
}

/** 解析 `content-range: bytes 100-999/1000`（416 场景可能是 `bytes *\/1000`） */
function parseContentRange(raw: string | null): ContentRange | null {
  if (!raw) return null
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(raw.trim())
  if (match) {
    const range: ContentRange = { start: Number(match[1]), end: Number(match[2]) }
    if (match[3] !== '*') range.total = Number(match[3])
    return range
  }
  const unsatisfied = /^bytes\s+\*\/(\d+)$/i.exec(raw.trim())
  if (unsatisfied) return { total: Number(unsatisfied[1]) }
  return null
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599)
}

function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[/, '').replace(/\]$/, '')
  } catch {
    return url
  }
}

/**
 * 网络错误 → 用户可读的诊断文案。
 * 有代理：提示检查代理软件；无代理：提示设置 HTTPS_PROXY/ALL_PROXY 后重启。
 */
function formatNetworkFailure(failure: NetworkFailure, url: string): string {
  const host = failure.host ?? hostOfUrl(url)
  const head = `下载失败：网络错误（${failure.code}，${host}）。`
  if (failure.proxy) {
    return `${head}代理 ${failure.proxy.host}:${failure.proxy.port} 连接失败，请检查代理软件（或关闭代理后重试）。`
  }
  return `${head}当前网络可能需要代理：请设置 HTTPS_PROXY/ALL_PROXY（macOS 也可在系统设置里开代理）后重启应用再试。`
}

/**
 * 下载到 dest；已存在且 size 匹配时直接返回 cached（不重复校验大文件哈希）。
 * 校验失败会删除文件/分片并抛中文错误，调用方可安全重试（支持断点续传）。
 */
export async function downloadFile(options: DownloadOptions): Promise<DownloadResult> {
  const fetchImpl = options.fetchImpl ?? proxyAwareFetch
  const log = options.log ?? (() => {})
  const attempts = Math.max(1, Math.floor(options.attempts ?? DEFAULT_ATTEMPTS))
  const partPath = `${options.dest}.part`
  mkdirSync(dirname(options.dest), { recursive: true })

  const destSize = fileSize(options.dest)
  if (existsSync(options.dest) && destSize > 0) {
    const sizeOk = !options.size || destSize === options.size
    if (sizeOk) {
      if (options.sha256) {
        const actual = await hashFile(options.dest)
        if (actual !== options.sha256.toLowerCase()) {
          log('缓存文件哈希不符，重新下载：' + options.dest)
          rmSync(options.dest, { force: true })
        } else {
          return { status: 'cached', path: options.dest, bytes: destSize }
        }
      } else {
        return { status: 'cached', path: options.dest, bytes: destSize }
      }
    } else {
      log(`缓存大小不符（${destSize} ≠ ${options.size}），重新下载`)
      rmSync(options.dest, { force: true })
    }
  }

  // .part 已完整（例如上次校验后 rename 前中断）：校验通过就直接转正，避免再下一次
  const initialPartSize = fileSize(partPath)
  if (initialPartSize > 0 && options.size && initialPartSize === options.size) {
    const hashOk = !options.sha256 || (await hashFile(partPath)) === options.sha256.toLowerCase()
    if (hashOk) {
      log('发现完整分片文件，校验通过，直接完成')
      renameSync(partPath, options.dest)
      options.onProgress?.({ received: initialPartSize, total: initialPartSize })
      return { status: 'downloaded', path: options.dest, bytes: initialPartSize }
    }
    log('完整分片哈希不符，丢弃后重新下载')
    rmSync(partPath, { force: true })
  } else if (initialPartSize > 0 && options.size && initialPartSize > options.size) {
    log(`分片大小异常（${initialPartSize} > ${options.size}），丢弃后重新下载`)
    rmSync(partPath, { force: true })
  }

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await downloadAttempt({ options, fetchImpl, log, partPath })
    } catch (error) {
      lastError = error
      if (options.signal?.aborted) throw error
      const failure = networkFailureOf(error)
      const status = error instanceof DownloadHttpError ? error.status : undefined
      const retryable =
        failure !== null ||
        (error instanceof DownloadHttpError && (error.retryable || (status !== undefined && isRetryableStatus(status))))
      if (!retryable || attempt >= attempts) break
      const delayMs = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS)
      const reason = failure ? failure.code : `HTTP ${status ?? '未知'}`
      log(`下载失败（${reason}），${delayMs}ms 后重试（第 ${attempt}/${attempts} 次尝试）`)
      await sleep(delayMs, options.signal)
    }
  }

  if (options.signal?.aborted) throw lastError instanceof Error ? lastError : new Error('已取消')
  const failure = networkFailureOf(lastError)
  if (failure) throw new Error(formatNetworkFailure(failure, options.url))
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

interface AttemptOptions {
  options: DownloadOptions
  fetchImpl: typeof fetch
  log: (message: string) => void
  partPath: string
}

/** 单次下载尝试：检查 .part → 发 Range 请求 → 续传/重下 → 校验 → rename */
async function downloadAttempt({ options, fetchImpl, log, partPath }: AttemptOptions): Promise<DownloadResult> {
  let offset = fileSize(partPath)
  if (offset > 0 && options.size && offset > options.size) {
    log(`分片大小异常（${offset} > ${options.size}），丢弃后重新下载`)
    rmSync(partPath, { force: true })
    offset = 0
  }

  const headers: Record<string, string> = { 'User-Agent': 'aiab-provision/1' }
  if (offset > 0) {
    headers.Range = `bytes=${offset}-`
    log(`续传：已有 ${offset} 字节，请求剩余部分`)
  }

  const response = await fetchImpl(options.url, { headers, signal: options.signal })

  if (response.status === 416 && offset > 0) {
    // 已有分片比服务器文件还长/不匹配：丢掉分片，下一次尝试从头下载
    await response.body?.cancel().catch(() => {})
    rmSync(partPath, { force: true })
    throw new DownloadHttpError(416, `服务器拒绝续传范围（HTTP 416，已有 ${offset} 字节）：${options.url}`, true)
  }
  if (!response.ok && response.status !== 206) {
    await response.body?.cancel().catch(() => {})
    const status = response.status
    const hint = status === 429 || status >= 500 ? '（服务器暂时不可用，请稍后重试）' : ''
    throw new DownloadHttpError(status, `下载失败（HTTP ${status}）${hint}：${options.url}`)
  }
  if (!response.body) throw new Error(`下载响应没有 body：${options.url}`)

  const contentRange = parseContentRange(response.headers.get('content-range'))
  let resumed = offset > 0 && response.status === 206
  let startOffset = resumed ? offset : 0
  if (resumed && contentRange?.start !== undefined && contentRange.start !== offset) {
    // 服务器给的区间起点与本地分片不一致：这个 206 响应体是「服务器起点」开始的内容，
    // 直接写进空文件会拼出坏文件。取消响应、丢弃分片，抛可重试错误让外层从头下载。
    await response.body.cancel().catch(() => {})
    rmSync(partPath, { force: true })
    log(`续传区间不一致（期望 ${offset}，实际 ${contentRange.start}），丢弃分片后从头重试`)
    throw new DownloadHttpError(
      206,
      `续传区间不一致（期望 ${offset}，实际 ${contentRange.start}），已丢弃分片：${options.url}`,
      true,
    )
  }
  if (!resumed && offset > 0) {
    // 服务器忽略了 Range（返回 200）：截断 .part 并从 0 重新计算哈希
    log('服务器不支持断点续传（返回 200），从头下载')
    rmSync(partPath, { force: true })
    offset = 0
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0)
  const total = resumed
    ? (contentRange?.total ?? options.size ?? (contentLength > 0 ? startOffset + contentLength : 0))
    : contentLength || options.size || 0

  const hash = options.sha256 ? createHash('sha256') : null
  if (hash && resumed && startOffset > 0) {
    // 关键修复：把已有 .part 字节喂进同一个 hash，再继续追加，避免 2.5GB 模型从头重下
    const fed = await feedHashFromFile(hash, partPath)
    if (fed !== startOffset) {
      rmSync(partPath, { force: true })
      throw new Error(`续传分片读取异常（${fed} ≠ ${startOffset}）：${partPath}`)
    }
  }

  const writeStream = createWriteStream(partPath, { flags: resumed ? 'a' : 'w' })
  const nodeStream = Readable.fromWeb(response.body as never) as Readable
  const interval = options.progressIntervalMs ?? 300
  let received = resumed ? startOffset : 0
  let lastReport = 0
  nodeStream.on('data', (chunk: Buffer) => {
    received += chunk.length
    hash?.update(chunk)
    const now = Date.now()
    if (now - lastReport >= interval) {
      lastReport = now
      options.onProgress?.({ received, total })
    }
  })
  try {
    await pipeline(nodeStream, writeStream)
  } catch (error) {
    options.onProgress?.({ received, total })
    throw error instanceof Error ? error : new Error(String(error))
  }
  options.onProgress?.({ received, total })

  if (options.size && received !== options.size) {
    throw new Error(`下载大小不符：期望 ${options.size}，实际 ${received}（已保留分片，可重试续传）`)
  }
  if (hash) {
    const expected = options.sha256!.toLowerCase()
    const actual = hash.digest('hex')
    if (actual !== expected) {
      rmSync(partPath, { force: true })
      throw new Error(
        `sha256 校验失败：期望 ${expected.slice(0, 16)}…，实际 ${actual.slice(0, 16)}…（已删除损坏文件，可重试）`,
      )
    }
  }
  renameSync(partPath, options.dest)
  return { status: 'downloaded', path: options.dest, bytes: received }
}
