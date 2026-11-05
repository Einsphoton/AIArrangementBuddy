/** 通用小工具：超时 fetch、信号合并、文本截断等。 */
import process from 'node:process'

export class TimeoutError extends Error {
  constructor(message = '请求超时') {
    super(message)
    this.name = 'TimeoutError'
  }
}

/** 合并多个 AbortSignal（Node 20+ 自带 AbortSignal.any，这里做兼容兜底） */
export function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => !!s)
  if (list.length === 0) return new AbortController().signal
  if (list.length === 1) return list[0]
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  if (typeof anyFn === 'function') return anyFn(list)
  const controller = new AbortController()
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

/** 带超时的 fetch；内部超时会抛 TimeoutError */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 60_000, signal, ...rest } = init
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new TimeoutError()), timeoutMs)
  const merged = anySignal([signal ?? undefined, controller.signal])
  try {
    return await fetch(url, { ...rest, signal: merged })
  } catch (error) {
    if (controller.signal.aborted && !(signal?.aborted ?? false)) {
      throw new TimeoutError(`请求超过 ${Math.round(timeoutMs / 1000)} 秒未完成`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function readJsonSafe<T = unknown>(response: Response): Promise<T | null> {
  const text = await response.text().catch(() => '')
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…（已截断，原长 ${text.length} 字符）`
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

export function toNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return fallback
}

export function toBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** 只保留 id 需要的安全字符，避免路径穿越 */
export function safeFileId(id: string): string | null {
  if (!id || id.length > 120) return null
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return null
  if (id === '.' || id === '..') return null
  return id
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('已取消'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 简单的并发上限映射 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/** 给日志用的简短环境信息 */
export function runtimeInfo(): { node: string; platform: string; pid: number } {
  return { node: process.version, platform: `${process.platform}/${process.arch}`, pid: process.pid }
}
