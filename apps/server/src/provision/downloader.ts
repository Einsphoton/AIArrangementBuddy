/**
 * 下载器 v2（P10）：代理感知 + 多源回退 + 多连接 Range 分片 + 跨运行续传 + 实时测速 + 网络重试。
 *
 * 兼容 P8 的旧的 `url / dest / sha256 / size / onProgress / signal / fetchImpl / log` 用法：
 * - 只传 url 时等价于「单源单连接」，行为与 P8 一致（缓存命中、sha256 校验、.part 续传）；
 * - 新增 sources 多源按顺序回退；新增 concurrency 多连接 Range 分片（size 已知且 ≥8MB 才启用）；
 * - 分片状态落盘 <dest>.parts.json + <dest>.part.<i>，跨进程/重启续传；最终整文件 sha256 兜底；
 * - 进度回调带 speedBps / source / segments，日志带「源」「速度」中文提示；
 * - 默认 fetchImpl 是 net/proxy.ts 的 proxyAwareFetch（有 HTTPS_PROXY / 系统代理时自建 CONNECT 隧道），
 *   同时保留 fetchImpl 注入 seam 供无网络单测使用；
 * - attempts（默认 3）只对网络类错误与 HTTP 429/5xx 重试，指数退避 800ms→2s，重试复用 Range/分片状态；
 *   sha256/大小不符不自动重试，保持可读错误；最终网络错误会带上代理诊断提示。
 *
 * 只依赖 Node 内置（fetch / fs / crypto / stream），不新增依赖。
 */
import { createHash, type Hash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { detectProxyForUrl, networkFailureOf, proxyAwareFetch, ProxyFetchError, type NetworkFailure } from '../net/proxy.js'
import { sleep } from '../util.js'
import type { DownloadSource } from './sources.js'

export interface DownloadProgress {
  received: number
  total: number
  /** 本次会话实时速度（字节/秒），始终提供 */
  speedBps?: number
  /** 当前下载源名称（多源分片时为各源汇总） */
  source?: string
  /** 分片数（单连接为 1，分片下载为实际段数） */
  segments?: number
  /** 当前是第几次尝试（1 起；缓存命中/完整分片直接完成时为 undefined） */
  attempt?: number
  /** 本次下载配置的总尝试次数（仅 attempts>1 时提供） */
  attempts?: number
}

export interface DownloadOptions {
  /** 单源兼容：与 sources 二选一（都提供时以 sources 为准） */
  url?: string
  /** 多源候选（按顺序回退；分片时轮换使用不同源） */
  sources?: DownloadSource[]
  dest: string
  sha256?: string
  size?: number
  /** 分片并发数：0/1 = 单连接；默认 0（保持旧行为）。>1 且 size 已知且 ≥8MB 时启用分片 */
  concurrency?: number
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

/** HTTP 状态码是否值得重试（限流 / 服务端临时不可用） */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599)
}

/** 下载失败是否值得整体重试：网络类错误 / 429 / 5xx（续传状态保留，重试会接着下） */
function isRetryableDownloadError(error: unknown): boolean {
  if (error instanceof DownloadHttpError) return error.retryable || isRetryableStatus(error.status)
  const failure = networkFailureOf(error)
  if (failure) return true
  return /HTTP\s*(429|5\d\d)|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|fetch failed/i.test(errorMessage(error))
}

function hostOfUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).hostname.replace(/^\[/, '').replace(/\]$/, '')
  } catch {
    return undefined
  }
}

/**
 * 网络错误 → 用户可读的诊断文案。
 *   - 代理连接本身失败：提示检查代理软件；
 *   - 已配置代理、但连接是在传输中途被掐断（body 阶段错误拿不到代理上下文）：
 *     明确说明「经代理传输时连接被中断」，避免误报成「可能需要代理」；
 *   - 无代理：提示设置 HTTPS_PROXY / ALL_PROXY 后重启。
 */
function formatNetworkFailure(
  failure: NetworkFailure,
  url: string | undefined,
  proxy: { host: string; port: number } | null,
): string {
  const host = failure.host ?? hostOfUrl(url) ?? '下载源'
  const head = `下载失败：网络错误（${failure.code}，${host}）。`
  if (failure.proxy) {
    return `${head}代理 ${failure.proxy.host}:${failure.proxy.port} 连接失败，请检查代理软件（或关闭代理后重试）。`
  }
  if (proxy) {
    return `${head}数据经代理 ${proxy.host}:${proxy.port} 传输时连接被中断：请检查代理软件 / 更换节点后重试（断点已保留，重新下载会续传）。`
  }
  return `${head}当前网络可能需要代理：请设置 HTTPS_PROXY/ALL_PROXY（macOS 也可在系统设置里开代理）后重启应用再试。`
}

/** 分片下载的最小文件大小（8MB）：太小的文件分片收益低、开销大 */
export const SEGMENTED_MIN_BYTES = 8 * 1024 * 1024
/** 分片并发上限（与 settings.provision.concurrency 的上限 16 对齐） */
export const MAX_SEGMENT_CONCURRENCY = 16

/** 服务器不支持 Range（返回 200）时内部抛出的信号：外层清理分片状态并回退单连接。 */
export class RangeUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RangeUnsupportedError'
  }
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function createAbortError(): Error {
  const error = new Error('下载已取消')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createAbortError()
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)}GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)}MB`
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)}KB`
  return `${bytes}B`
}

function formatSpeed(bytesPerSecond: number): string {
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)}MB/s`
}

function sourceSummary(sources: DownloadSource[]): string {
  const labels = [...new Set(sources.map((source) => source.label || source.url))]
  return labels.join(' / ')
}

/** 把文件内容按块喂进一个 sha256 Hash（不结束流，便于随后继续 update 新数据）。 */
async function feedFileIntoHash(hash: Hash, filePath: string): Promise<void> {
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await feedFileIntoHash(hash, filePath)
  return hash.digest('hex')
}

/** 归一化下载源：sources 优先；否则用 url 作为单源；都没有则明确报错。 */
function normalizeSources(options: DownloadOptions): DownloadSource[] {
  const sources = (options.sources ?? []).filter((source) => source && typeof source.url === 'string' && source.url.length > 0)
  if (sources.length > 0) return sources.map((source) => ({ ...source, label: source.label || source.url }))
  if (options.url) return [{ label: '默认源', url: options.url, kind: 'official' }]
  throw new Error('downloadFile 缺少下载源：请提供 url 或 sources')
}

interface AttemptInfo {
  attempt: number
  attempts: number
}

interface ProgressTracker {
  update(received: number, source: string, segments?: number, force?: boolean): void
}

/** 节流进度回调；每次回调都带实时速度（本次会话下载字节 / 会话耗时）与重试进度。 */
function createProgressTracker(
  options: DownloadOptions,
  total: number,
  initialReceived: number,
  attemptInfo?: AttemptInfo,
): ProgressTracker {
  const interval = Math.max(0, options.progressIntervalMs ?? 300)
  const startedAt = Date.now()
  let lastReportedAt = 0
  let lastLoggedAt = 0
  const log = options.log
  const speedOf = (received: number): number => {
    const elapsed = Math.max(1, Date.now() - startedAt)
    return Math.max(0, Math.round(((received - initialReceived) * 1000) / elapsed))
  }
  return {
    update(received, source, segments, force = false) {
      const now = Date.now()
      if (!force && now - lastReportedAt < interval) return
      lastReportedAt = now
      const speedBps = speedOf(received)
      const progress: DownloadProgress = { received, total, speedBps }
      if (source) progress.source = source
      if (segments && segments > 0) progress.segments = segments
      if (attemptInfo) {
        progress.attempt = attemptInfo.attempt
        progress.attempts = attemptInfo.attempts
      }
      options.onProgress?.(progress)
      if (log && now - lastLoggedAt >= Math.max(interval, 1500)) {
        lastLoggedAt = now
        const totalText = total > 0 ? ` / ${formatBytes(total)}` : ''
        const segmentText = segments && segments > 1 ? ` · ${segments} 段并发` : ''
        const attemptText = attemptInfo && attemptInfo.attempts > 1 ? ` · 第 ${attemptInfo.attempt}/${attemptInfo.attempts} 次尝试` : ''
        log(`下载中：源「${source}」 ${formatBytes(received)}${totalText} · ${formatSpeed(speedBps)}${segmentText}${attemptText}`)
      }
    },
  }
}

/* ------------------------------------------------------------------ */
/* 分片状态文件                                                        */
/* ------------------------------------------------------------------ */

interface SegmentPlan {
  index: number
  /** 起始字节（含） */
  start: number
  /** 结束字节（含） */
  end: number
}

interface SegmentedState {
  version: 1
  size: number
  sha256?: string
  concurrency: number
  segments: SegmentPlan[]
  /** 上次落盘的各段已完成字节（仅用于展示；续传以分片文件实际大小为准） */
  received?: number[]
  updatedAt?: string
}

function partPathFor(dest: string): string {
  return `${dest}.part`
}

function statePathFor(dest: string): string {
  return `${dest}.parts.json`
}

function segmentPathFor(dest: string, index: number): string {
  return `${dest}.part.${index}`
}

function buildSegmentPlan(size: number, count: number): SegmentPlan[] {
  const safeCount = Math.max(1, count)
  const segmentSize = Math.ceil(size / safeCount)
  const plan: SegmentPlan[] = []
  for (let index = 0; index < safeCount; index++) {
    const start = index * segmentSize
    if (start >= size) break
    plan.push({ index, start, end: Math.min(size - 1, start + segmentSize - 1) })
  }
  return plan
}

function plansEqual(left: SegmentPlan[], right: SegmentPlan[]): boolean {
  if (left.length !== right.length) return false
  return left.every((segment, index) => segment.start === right[index]?.start && segment.end === right[index]?.end)
}

function loadSegmentedState(statePath: string, size: number, sha256: string | undefined, plan: SegmentPlan[]): SegmentedState | null {
  if (!existsSync(statePath)) return null
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as SegmentedState
    if (!parsed || parsed.version !== 1) return null
    if (parsed.size !== size) return null
    if (sha256 && parsed.sha256 && parsed.sha256.toLowerCase() !== sha256.toLowerCase()) return null
    if (!Array.isArray(parsed.segments) || !plansEqual(parsed.segments, plan)) return null
    return parsed
  } catch {
    return null
  }
}

/** 清理某 dest 的所有分片状态与分片文件（含半成品 .part）。 */
function cleanupSegmentedFiles(dest: string): void {
  const base = basename(dest)
  rmSync(statePathFor(dest), { force: true })
  rmSync(partPathFor(dest), { force: true })
  try {
    const directory = dirname(dest)
    for (const name of readdirSync(directory)) {
      if (!name.startsWith(`${base}.part.`)) continue
      // 只删 <dest>.part.<数字>，避免误删用户其它 .part.* 文件
      if (!/^\d+$/.test(name.slice(base.length + '.part.'.length))) continue
      rmSync(join(directory, name), { force: true })
    }
  } catch {
    /* 目录不存在/被占用时忽略：下次下载会覆盖 */
  }
}

/* ------------------------------------------------------------------ */
/* 校验并落盘（单连接与分片共用）                                      */
/* ------------------------------------------------------------------ */

async function verifyAndCommit(
  options: DownloadOptions,
  partPath: string,
  received: number,
  sourceLabel: string,
  actualSha?: string,
): Promise<DownloadResult> {
  const log = options.log ?? (() => {})
  if (options.size && received !== options.size) {
    throw new Error(`下载大小不符：期望 ${options.size}，实际 ${received}（已保留 ${partPath}，可重试续传）`)
  }
  if (options.sha256) {
    const expected = options.sha256.toLowerCase()
    const actual = actualSha ?? (await sha256File(partPath))
    if (actual !== expected) {
      rmSync(partPath, { force: true })
      throw new Error(
        `sha256 校验失败：期望 ${expected.slice(0, 16)}…，实际 ${actual.slice(0, 16)}…（已删除损坏文件，可重试）`,
      )
    }
  }
  mkdirSync(dirname(options.dest), { recursive: true })
  rmSync(options.dest, { force: true })
  renameSync(partPath, options.dest)
  log(`下载完成：${options.dest}（${formatBytes(received)}，源「${sourceLabel}」）`)
  return { status: 'downloaded', path: options.dest, bytes: received }
}

/** 缓存命中检查：大小一致（且需要时 sha256 一致）→ cached，否则删除重下。 */
async function checkCached(options: DownloadOptions): Promise<DownloadResult | null> {
  if (!existsSync(options.dest)) return null
  const log = options.log ?? (() => {})
  const existing = fileSize(options.dest)
  const sizeOk = !options.size || existing === options.size
  if (!sizeOk) {
    log(`缓存大小不符（${existing} ≠ ${options.size}），重新下载`)
    rmSync(options.dest, { force: true })
    return null
  }
  if (options.sha256) {
    const actual = await sha256File(options.dest)
    if (actual !== options.sha256.toLowerCase()) {
      log(`缓存文件哈希不符，重新下载：${options.dest}`)
      rmSync(options.dest, { force: true })
      return null
    }
  }
  return { status: 'cached', path: options.dest, bytes: existing }
}

/* ------------------------------------------------------------------ */
/* 单连接下载（支持多源回退 + .part 续传）                              */
/* ------------------------------------------------------------------ */

function singleConnectionHeaders(startOffset: number): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': 'aiab-provision/2' }
  if (startOffset > 0) headers.Range = `bytes=${startOffset}-`
  return headers
}

async function requestSource(
  fetchImpl: typeof fetch,
  source: DownloadSource,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<Response> {
  try {
    return await fetchImpl(source.url, { headers, signal })
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error
    // 保留代理失败的可判别信息（ProxyFetchError 的 code/host/proxy），只在消息前加「哪个源」
    if (error instanceof ProxyFetchError) {
      throw new ProxyFetchError(`下载请求失败：源「${source.label}」（${error.message}）`, {
        code: error.code,
        host: error.host,
        proxy: error.proxy,
        cause: error,
      })
    }
    throw new Error(`下载请求失败：源「${source.label}」（${errorMessage(error)}）`, { cause: error })
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    /* ignore */
  }
}

interface ParsedContentRange {
  start: number
  end: number
  total: number | null
}

/** 解析 `Content-Range: bytes <start>-<end>/<total>`；格式非法/区间非法返回 null。 */
function parseContentRange(value: string | null): ParsedContentRange | null {
  if (!value) return null
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim())
  if (!match) return null
  const start = Number(match[1])
  const end = Number(match[2])
  const total = match[3] === '*' ? null : Number(match[3])
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  if (total !== null && (!Number.isFinite(total) || end >= total)) return null
  return { start, end, total }
}

async function attemptSingleSource(options: DownloadOptions, source: DownloadSource, attemptInfo?: AttemptInfo): Promise<DownloadResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const log = options.log ?? (() => {})
  const dest = options.dest
  const partPath = partPathFor(dest)
  const expectedSize = options.size && options.size > 0 ? options.size : 0
  mkdirSync(dirname(dest), { recursive: true })

  let startOffset = fileSize(partPath)
  if (expectedSize > 0 && startOffset > expectedSize) {
    log(`续传缓存比目标大（${startOffset} > ${expectedSize}），从头下载`)
    rmSync(partPath, { force: true })
    startOffset = 0
  }
  // 上次已下满（rename 前崩溃）：先校验落盘，校验失败则从头重下
  if (expectedSize > 0 && startOffset === expectedSize) {
    log(`续传缓存已完整（${formatBytes(startOffset)}），直接校验`)
    try {
      return await verifyAndCommit(options, partPath, startOffset, source.label)
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) throw error
      log(`续传缓存校验失败（${errorMessage(error)}），从头重新下载`)
      startOffset = 0
    }
  }
  throwIfAborted(options.signal)

  let hash: Hash | null = null
  if (options.sha256) {
    hash = createHash('sha256')
    if (startOffset > 0) {
      log(`续传：已有 ${formatBytes(startOffset)}，先计算前缀哈希`)
      await feedFileIntoHash(hash, partPath)
    }
  }

  let response = await requestSource(fetchImpl, source, singleConnectionHeaders(startOffset), options.signal)
  if (startOffset > 0 && response.status === 200) {
    // 源不支持 Range：服务器已返回从 0 开始的完整 body，直接丢掉半成品重写（无需再请求一次）
    log(`源「${source.label}」不支持 Range，丢掉半成品从头重写 ${partPath}`)
    rmSync(partPath, { force: true })
    startOffset = 0
    hash = options.sha256 ? createHash('sha256') : null
  }
  if (response.status === 416 && startOffset > 0) {
    // 本地分片比服务器文件还长/不匹配：丢掉分片，交给外层重试从头下载
    await discardBody(response)
    rmSync(partPath, { force: true })
    throw new DownloadHttpError(416, `服务器拒绝续传范围（HTTP 416，已有 ${startOffset} 字节）：源「${source.label}」`, true)
  }
  if (response.status !== 200 && response.status !== 206) {
    await discardBody(response)
    const status = response.status
    const hint = isRetryableStatus(status) ? '（服务器暂时不可用，请稍后重试）' : ''
    throw new DownloadHttpError(status, `下载失败（HTTP ${status}）${hint}：源「${source.label}」${source.url}`)
  }
  // 续传响应必须严格匹配 Range 请求：否则（无 sha256 时）会把错误字节 append 成坏文件
  if (startOffset > 0 && response.status === 206) {
    const parsed = parseContentRange(response.headers.get('content-range'))
    const headerLength = Number(response.headers.get('content-length') ?? 0)
    const invalidReason = ((): string | null => {
      if (!parsed) return '缺少/非法 Content-Range'
      if (parsed.start !== startOffset) return `起点 ${parsed.start} ≠ 本地断点 ${startOffset}`
      if (expectedSize > 0 && parsed.total !== expectedSize) return `总大小 ${parsed.total ?? '未知'} ≠ 期望 ${expectedSize}`
      if (headerLength > 0 && headerLength !== parsed.end - parsed.start + 1) {
        return `Content-Length ${headerLength} 与 Content-Range 区间 ${parsed.end - parsed.start + 1} 不一致`
      }
      return null
    })()
    if (invalidReason) {
      log(`源「${source.label}」续传响应不符（${invalidReason}）；丢弃 .part 从头重下`)
      await discardBody(response)
      rmSync(partPath, { force: true })
      startOffset = 0
      hash = options.sha256 ? createHash('sha256') : null
      response = await requestSource(fetchImpl, source, singleConnectionHeaders(0), options.signal)
      if (response.status !== 200) {
        await discardBody(response)
        throw new Error(`续传校验失败后从头下载失败（HTTP ${response.status}）：源「${source.label}」`)
      }
    }
  }
  if (startOffset === 0 && response.status === 206) {
    await discardBody(response)
    throw new Error(`服务器返回异常 Range 响应（206）：源「${source.label}」`)
  }
  if (!response.body) throw new Error(`下载响应没有 body：源「${source.label}」${source.url}`)

  const resumed = response.status === 206 && startOffset > 0
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  const total = resumed
    ? startOffset + (contentLength > 0 ? contentLength : Math.max(0, expectedSize - startOffset))
    : contentLength > 0
      ? contentLength
      : expectedSize
  const tracker = createProgressTracker(options, total, resumed ? startOffset : 0, attemptInfo)
  let received = resumed ? startOffset : 0
  tracker.update(received, source.label, 1, true)

  const nodeStream = Readable.fromWeb(response.body as never)
  nodeStream.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (hash) hash.update(chunk)
    tracker.update(received, source.label, 1)
  })
  try {
    await pipeline(nodeStream, createWriteStream(partPath, { flags: resumed ? 'a' : 'w' }))
  } catch (error) {
    tracker.update(received, source.label, 1, true)
    if (options.signal?.aborted || isAbortError(error)) throw error
    throw new Error(`下载中断：源「${source.label}」（${errorMessage(error)}）；已保留 ${partPath}，可重试续传`)
  }
  tracker.update(received, source.label, 1, true)

  if (total > 0 && received !== total) {
    throw new Error(`下载不完整：源「${source.label}」期望 ${total} 字节，实际 ${received}（已保留 ${partPath}，可重试续传）`)
  }
  return verifyAndCommit(options, partPath, received, source.label, hash?.digest('hex'))
}

async function downloadSingleConnection(options: DownloadOptions, sources: DownloadSource[], attemptInfo?: AttemptInfo): Promise<DownloadResult> {
  const log = options.log ?? (() => {})
  const failures: string[] = []
  const causes: unknown[] = []
  for (const source of sources) {
    throwIfAborted(options.signal)
    try {
      return await attemptSingleSource(options, source, attemptInfo)
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) throw error
      failures.push(`源「${source.label}」：${errorMessage(error)}`)
      causes.push(error)
      log(`源「${source.label}」失败：${errorMessage(error)}；换下一个源`)
    }
  }
  const aggregate = new Error(
    `所有下载源均失败（${failures.join('；') || '无可用源'}）。已保留进度，可重试续传：${partPathFor(options.dest)}`,
  )
  // 保留最后一个底层错误（可能是 ProxyFetchError / ETIMEDOUT），供上层做「代理/网络」诊断与重试判定
  const lastCause = causes.at(-1)
  if (lastCause !== undefined) (aggregate as { cause?: unknown }).cause = lastCause
  throw aggregate
}

/* ------------------------------------------------------------------ */
/* 分片并发下载（Range + 跨运行续传 + 逐段换源重试）                    */
/* ------------------------------------------------------------------ */

interface SegmentContext {
  options: DownloadOptions
  sources: DownloadSource[]
  dest: string
  size: number
  signal: AbortSignal
  tracker: ProgressTracker
  summary: string
  segmentCount: number
  /** 每段已完成字节（续传时按分片文件实际大小初始化） */
  receivedBySegment: number[]
  /** 整文件累计已完成字节（回调用） */
  totalReceived: () => number
  persistState: () => void
}

async function downloadSegment(context: SegmentContext, segment: SegmentPlan): Promise<void> {
  const { options, sources, dest, size, signal } = context
  const fetchImpl = options.fetchImpl ?? fetch
  const index = segment.index
  const length = segment.end - segment.start + 1
  const segPath = segmentPathFor(dest, index)
  const refreshReceived = (): number => {
    const actual = Math.min(fileSize(segPath), length)
    context.receivedBySegment[index] = actual
    return actual
  }
  let received = refreshReceived()
  if (received >= length) {
    context.tracker.update(context.totalReceived(), context.summary, context.segmentCount)
    return
  }

  const failures: string[] = []
  let lastCause: unknown
  let rangeUnsupportedCount = 0
  const maxAttempts = Math.max(2, sources.length * 2)
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    throwIfAborted(signal)
    const source = sources[(index + attempt) % sources.length]
    const from = segment.start + received
    const headers: Record<string, string> = {
      'User-Agent': 'aiab-provision/2',
      Range: `bytes=${from}-${segment.end}`,
    }
    let response: Response
    try {
      response = await fetchImpl(source.url, { headers, signal })
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error
      lastCause = error
      failures.push(`源「${source.label}」请求失败（${errorMessage(error)}）`)
      context.tracker.update(context.totalReceived(), context.summary, context.segmentCount)
      continue
    }
    if (response.status === 416) {
      // 分片请求越界（常见于源端文件被替换/分片状态过期）：丢掉该段已完成字节，换源从头下这一段
      await discardBody(response)
      if (received > 0) {
        rmSync(segPath, { force: true })
        received = 0
        context.receivedBySegment[index] = 0
        context.tracker.update(context.totalReceived(), context.summary, context.segmentCount)
      }
      failures.push(`源「${source.label}」拒绝 Range（HTTP 416）`)
      continue
    }
    if (response.status === 200) {
      await discardBody(response)
      rangeUnsupportedCount += 1
      failures.push(`源「${source.label}」不支持 Range`)
      continue
    }
    if (response.status !== 206) {
      await discardBody(response)
      failures.push(`源「${source.label}」HTTP ${response.status}`)
      continue
    }
    // Range 响应必须严格匹配请求：Content-Range 起点/终点/总大小不对就拒绝（避免拼出坏文件）
    const contentRange = (response.headers.get('content-range') ?? '').trim()
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange)
    if (!match) {
      await discardBody(response)
      failures.push(`源「${source.label}」Content-Range 非法（${contentRange || '空'}）`)
      continue
    }
    const rangeStart = Number(match[1])
    const rangeEnd = Number(match[2])
    const rangeTotal = match[3] === '*' ? null : Number(match[3])
    if (rangeStart !== from || rangeEnd < from || rangeEnd > segment.end || (rangeTotal !== null && rangeTotal !== size)) {
      await discardBody(response)
      failures.push(`源「${source.label}」Content-Range 不符（期望 ${from}-${segment.end}/${size}，实际 ${contentRange}）`)
      continue
    }
    if (!response.body) {
      failures.push(`源「${source.label}」响应没有 body`)
      continue
    }
    const expected = rangeEnd - from + 1
    const contentLength = Number(response.headers.get('content-length') ?? 0)
    if (contentLength > 0 && contentLength !== expected) {
      await discardBody(response)
      failures.push(`源「${source.label}」Content-Length 与 Content-Range 不一致`)
      continue
    }
    const before = fileSize(segPath)
    const target = before + expected
    try {
      const nodeStream = Readable.fromWeb(response.body as never)
      nodeStream.on('data', (chunk: Buffer) => {
        context.receivedBySegment[index] = Math.min(length, context.receivedBySegment[index] + chunk.length)
        context.tracker.update(context.totalReceived(), context.summary, context.segmentCount)
        context.persistState()
      })
      await pipeline(nodeStream, createWriteStream(segPath, { flags: before > 0 ? 'a' : 'w' }))
      const written = fileSize(segPath)
      if (written > target) truncateSync(segPath, target)
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error
      lastCause = error
      failures.push(`源「${source.label}」网络中断（${errorMessage(error)}）`)
      received = refreshReceived()
      context.tracker.update(context.totalReceived(), context.summary, context.segmentCount)
      continue
    }
    received = refreshReceived()
    context.tracker.update(context.totalReceived(), context.summary, context.segmentCount)
    context.persistState()
    if (received >= length) return
    failures.push(`源「${source.label}」分片 ${index} 未完成（${received}/${length}）`)
  }
  if (rangeUnsupportedCount > 0 && rangeUnsupportedCount >= Math.min(sources.length, maxAttempts)) {
    throw new RangeUnsupportedError(`下载源不支持 Range 分段下载：${failures.join('；')}`)
  }
  const aggregate = new Error(`分片 ${index} 下载失败（${failures.slice(0, 4).join('；')}）。已保留进度，可重试续传`)
  if (lastCause !== undefined) (aggregate as { cause?: unknown }).cause = lastCause
  throw aggregate
}

async function downloadSegmented(
  options: DownloadOptions,
  sources: DownloadSource[],
  concurrency: number,
  attemptInfo?: AttemptInfo,
): Promise<DownloadResult> {
  const log = options.log ?? (() => {})
  const dest = options.dest
  const size = options.size as number
  const statePath = statePathFor(dest)
  const segmentCount = Math.max(2, Math.min(concurrency, Math.floor(size / (1024 * 1024)), MAX_SEGMENT_CONCURRENCY))
  const plan = buildSegmentPlan(size, segmentCount)
  mkdirSync(dirname(dest), { recursive: true })

  let state = loadSegmentedState(statePath, size, options.sha256, plan)
  const resumedSegments: number[] = []
  if (!state) {
    cleanupSegmentedFiles(dest)
    state = {
      version: 1,
      size,
      sha256: options.sha256?.toLowerCase(),
      concurrency,
      segments: plan,
      received: plan.map(() => 0),
      updatedAt: new Date().toISOString(),
    }
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
    log(`开始分片下载：${formatBytes(size)}，${plan.length} 段并发（源「${sourceSummary(sources)}」）`)
  } else {
    for (const segment of plan) {
      const segPath = segmentPathFor(dest, segment.index)
      const length = segment.end - segment.start + 1
      const existing = fileSize(segPath)
      if (existing > length) truncateSync(segPath, length)
      resumedSegments.push(Math.min(existing, length))
    }
    log(
      `分片续传：已完成 ${formatBytes(resumedSegments.reduce((sum, value) => sum + value, 0))} / ${formatBytes(size)}（${plan.length} 段）`,
    )
    state.received = [...resumedSegments]
    state.updatedAt = new Date().toISOString()
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
  }

  const initialReceived = resumedSegments.reduce((sum, value) => sum + value, 0)
  const tracker = createProgressTracker(options, size, initialReceived, attemptInfo)
  const receivedBySegment = plan.map((segment) => resumedSegments[segment.index] ?? 0)
  const totalReceived = (): number => receivedBySegment.reduce((sum, value) => sum + value, 0)
  tracker.update(totalReceived(), sourceSummary(sources), plan.length, true)

  const controller = new AbortController()
  const externalSignal = options.signal
  const onExternalAbort = (): void => controller.abort()
  if (externalSignal) {
    if (externalSignal.aborted) throw createAbortError()
    externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }

  let stateWrittenAt = 0
  const persistState = (force = false): void => {
    const now = Date.now()
    if (!force && now - stateWrittenAt < 500) return
    stateWrittenAt = now
    try {
      state!.received = plan.map((segment) => Math.min(fileSize(segmentPathFor(dest, segment.index)), segment.end - segment.start + 1))
      state!.updatedAt = new Date().toISOString()
      writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
    } catch {
      /* 状态落盘失败不影响下载；续传时以分片文件实际大小为准 */
    }
  }

  const context: SegmentContext = {
    options,
    sources,
    dest,
    size,
    signal: controller.signal,
    tracker,
    summary: sourceSummary(sources),
    segmentCount: plan.length,
    receivedBySegment,
    totalReceived,
    persistState: () => persistState(),
  }

  try {
    const tasks = plan.map((segment) =>
      downloadSegment(context, segment).catch((error: unknown) => {
        if (error instanceof RangeUnsupportedError) controller.abort()
        throw error
      }),
    )
    const outcomes = await Promise.allSettled(tasks)
    const failures = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      .map((outcome) => outcome.reason)
    if (failures.length > 0) {
      // 只要有一段确认「源不支持 Range」，整文件回退单连接（其它段可能只是被内部 abort 打断）
      const rangeFailure = failures.find((reason) => reason instanceof RangeUnsupportedError)
      if (rangeFailure) {
        cleanupSegmentedFiles(dest)
        throw rangeFailure
      }
      persistState(true)
      const failure = failures[0]
      throw failure instanceof Error ? failure : new Error(String(failure))
    }
  } finally {
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }

  persistState(true)
  tracker.update(size, sourceSummary(sources), plan.length, true)

  // 按序拼接成 <dest>.part
  const partPath = partPathFor(dest)
  rmSync(partPath, { force: true })
  try {
    await pipeline(
      async function* assembleSegments() {
        for (const segment of plan) {
          const segPath = segmentPathFor(dest, segment.index)
          const length = segment.end - segment.start + 1
          if (fileSize(segPath) !== length) throw new Error(`分片 ${segment.index} 大小不符（可能未下载完整）`)
          for await (const chunk of createReadStream(segPath)) yield chunk as Buffer
        }
      },
      createWriteStream(partPath),
    )
  } catch (error) {
    rmSync(partPath, { force: true })
    throw new Error(`分片拼接失败：${errorMessage(error)}（分片状态已保留，可重试续传）`)
  }

  const actualSha = options.sha256 ? await sha256File(partPath) : undefined
  if (options.sha256 && actualSha !== options.sha256.toLowerCase()) {
    cleanupSegmentedFiles(dest)
    throw new Error(
      `sha256 校验失败：期望 ${options.sha256.slice(0, 16)}…，实际 ${actualSha?.slice(0, 16)}…（已删除损坏分片，可重试）`,
    )
  }
  const result = await verifyAndCommit(options, partPath, size, sourceSummary(sources), actualSha)
  cleanupSegmentedFiles(dest)
  return result
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 下载到 dest。
 * - 已存在且 size/sha256 匹配 → cached；
 * - concurrency>1 且 size 已知且 ≥8MB → Range 分片并发（多源轮换、跨运行续传、自动回退）；
 * - 否则单连接（.part 续传；服务端不支持 Range 时从头重写）；
 * - 默认走代理感知 fetch；网络类错误 / HTTP 429/5xx 自动重试（attempts 默认 3，续传状态保留）；
 * - 校验失败会删除损坏文件/分片状态并抛中文错误，调用方可安全重试。
 */
export async function downloadFile(options: DownloadOptions): Promise<DownloadResult> {
  const log = options.log ?? (() => {})
  const normalized: DownloadOptions = { ...options, fetchImpl: options.fetchImpl ?? proxyAwareFetch }
  const sources = normalizeSources(normalized)
  mkdirSync(dirname(normalized.dest), { recursive: true })
  const cached = await checkCached(normalized)
  if (cached) return cached

  const concurrency = Math.min(MAX_SEGMENT_CONCURRENCY, Math.max(0, Math.floor(normalized.concurrency ?? 0)))
  const size = normalized.size && normalized.size > 0 ? normalized.size : 0
  const attempts = Math.max(1, Math.floor(normalized.attempts ?? DEFAULT_ATTEMPTS))

  const attemptOnce = async (attemptInfo?: AttemptInfo): Promise<DownloadResult> => {
    if (concurrency > 1 && size >= SEGMENTED_MIN_BYTES) {
      try {
        return await downloadSegmented(normalized, sources, concurrency, attemptInfo)
      } catch (error) {
        if (error instanceof RangeUnsupportedError) {
          log('下载源不支持 Range 分片；已清理分片状态，回退单连接下载')
          return downloadSingleConnection(normalized, sources, attemptInfo)
        }
        throw error
      }
    }
    const result = await downloadSingleConnection(normalized, sources, attemptInfo)
    // 本次走单连接：清理历史分片残留（分片流程失败会保留状态，但单连接成功后已无意义）
    cleanupSegmentedFiles(normalized.dest)
    return result
  }

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const attemptInfo: AttemptInfo | undefined = attempts > 1 ? { attempt, attempts } : undefined
    try {
      return await attemptOnce(attemptInfo)
    } catch (error) {
      lastError = error
      if (normalized.signal?.aborted || isAbortError(error)) throw error
      const retryable = isRetryableDownloadError(error)
      if (!retryable || attempt >= attempts) break
      const delayMs = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS)
      const nextAttempt = Math.min(attempt + 1, attempts)
      log(`下载失败（${errorMessage(error)}），${delayMs}ms 后重试（第 ${nextAttempt}/${attempts} 次尝试）`)
      await sleep(delayMs, normalized.signal)
    }
  }

  if (normalized.signal?.aborted) throw lastError instanceof Error ? lastError : createAbortError()
  const failure = networkFailureOf(lastError)
  if (failure) {
    const url = sources[0]?.url ?? normalized.url
    throw new Error(formatNetworkFailure(failure, url, detectProxyForUrl(url ?? '')))
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}