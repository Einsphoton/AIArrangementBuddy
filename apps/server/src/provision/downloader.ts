/**
 * 下载器（P8）：断点续传 + sha256 校验 + 进度回调。
 *
 * 只依赖 Node 内置（fetch / fs / crypto / stream），不新增依赖；
 * fetchImpl 可注入，便于用本地 HTTP 服务做无网络单测（含 Range 续传、哈希不符）。
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

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
  fetchImpl?: typeof fetch
  /** 进度回调节流（毫秒） */
  progressIntervalMs?: number
  log?: (message: string) => void
}

export interface DownloadResult {
  status: 'downloaded' | 'cached'
  path: string
  bytes: number
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  const { createReadStream } = await import('node:fs')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/**
 * 下载到 dest；已存在且 size 匹配时直接返回 cached（不重复校验大文件哈希）。
 * 校验失败会删除文件并抛中文错误，调用方可安全重试（支持断点续传）。
 */
export async function downloadFile(options: DownloadOptions): Promise<DownloadResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const log = options.log ?? (() => {})
  const partPath = `${options.dest}.part`
  mkdirSync(dirname(options.dest), { recursive: true })

  if (existsSync(options.dest)) {
    const existing = fileSize(options.dest)
    const sizeOk = !options.size || existing === options.size
    if (sizeOk) {
      if (options.sha256) {
        const actual = await sha256File(options.dest)
        if (actual !== options.sha256) {
          log(`缓存文件哈希不符，重新下载：${options.dest}`)
          rmSync(options.dest, { force: true })
        } else {
          return { status: 'cached', path: options.dest, bytes: existing }
        }
      } else {
        return { status: 'cached', path: options.dest, bytes: existing }
      }
    } else {
      log(`缓存大小不符（${existing} ≠ ${options.size}），重新下载`)
      rmSync(options.dest, { force: true })
    }
  }

  const startOffset = fileSize(partPath)
  const headers: Record<string, string> = { 'User-Agent': 'aiab-provision/1' }
  if (startOffset > 0) {
    headers.Range = `bytes=${startOffset}-`
    log(`续传：已有 ${startOffset} 字节（${partPath}）`)
  }

  const response = await fetchImpl(options.url, { headers, signal: options.signal })
  if (!response.ok && response.status !== 206) {
    throw new Error(`下载失败（HTTP ${response.status}）：${options.url}`)
  }
  if (!response.body) throw new Error(`下载响应没有 body：${options.url}`)

  const resumed = response.status === 206
  const totalHeader = Number(response.headers.get('content-length') ?? 0)
  const total = resumed ? startOffset + totalHeader : totalHeader || options.size || 0
  const writePath = resumed && startOffset > 0 ? partPath : partPath
  if (!resumed && startOffset > 0) {
    // 服务器不支持 Range：从头来
    rmSync(partPath, { force: true })
  }

  const hash = createHash('sha256')
  let received = resumed ? startOffset : 0
  if (resumed) {
    // 已有部分需要先补哈希（仅当需要校验时）
    if (options.sha256 && startOffset > 0) {
      const head = createHash('sha256')
      const { createReadStream } = await import('node:fs')
      await pipeline(createReadStream(partPath), head)
      // 重新开始哈希不现实（需要把已下载字节喂进去）；直接重下更稳，避免错误校验
      log('续传文件需要重新计算哈希：为稳妥起见从头下载')
      rmSync(partPath, { force: true })
      return downloadFile({ ...options, log })
    }
  }

  const stream = createWriteStream(writePath, { flags: resumed ? 'a' : 'w' })
  const nodeStream = Readable.fromWeb(response.body as never)
  const interval = options.progressIntervalMs ?? 300
  let lastReport = 0
  nodeStream.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (options.sha256) hash.update(chunk)
    const now = Date.now()
    if (now - lastReport >= interval) {
      lastReport = now
      options.onProgress?.({ received, total })
    }
  })
  try {
    await pipeline(nodeStream, stream)
  } catch (error) {
    options.onProgress?.({ received, total })
    throw error instanceof Error ? error : new Error(String(error))
  }
  options.onProgress?.({ received, total })

  if (options.size && received !== options.size) {
    throw new Error(`下载大小不符：期望 ${options.size}，实际 ${received}（可重试续传）`)
  }
  if (options.sha256) {
    const digest = options.sha256.toLowerCase()
    const prefix = createHash('sha256')
    const { createReadStream } = await import('node:fs')
    await pipeline(createReadStream(partPath), prefix)
    const actual = prefix.digest('hex')
    if (actual !== digest) {
      rmSync(partPath, { force: true })
      throw new Error(`sha256 校验失败：期望 ${digest.slice(0, 16)}…，实际 ${actual.slice(0, 16)}…（已删除损坏文件，可重试）`)
    }
  }
  renameSync(partPath, options.dest)
  return { status: 'downloaded', path: options.dest, bytes: received }
}