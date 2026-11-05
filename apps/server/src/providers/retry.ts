/**
 * 服务商请求层的自动重试（OpenAI / Anthropic 适配器共用）。
 *
 * 目标：网关偶发 429 / 5xx / 网络抖动时不要让整轮 AI 直接失败。
 * 约束：
 * - 最多重试 2 次（即最多 3 次尝试），退避 0.8s / 1.6s；
 * - 服务端给了 Retry-After 时优先按它等待（用毫秒数上限封顶，避免对话长时间卡死）；
 * - 只有「本次请求还没有向前端 emit 任何文本/推理增量」时才重试，否则 UI 会出现重复内容；
 * - AbortSignal 一触发立刻放弃（取消要即时生效）。
 */
import { describeHttpError, describeNetworkError, isAbortError, ProviderError } from './types.js'

/** 与常见网关约定一致的可重试状态码（429 限流 + 5xx 临时性故障） */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529])
const MAX_RETRIES = 2
const BASE_DELAY_MS = 800
/** Retry-After 等待封顶：网关有时会要求等几十秒，但对话场景不能真的卡这么久 */
const MAX_RETRY_AFTER_MS = 10_000

export function isRetryableStatus(status: number | undefined): boolean {
  return status !== undefined && RETRYABLE_STATUS.has(status)
}

/** 解析 Retry-After（秒数或 HTTP-date），返回毫秒；无法解析返回 undefined */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  const text = value?.trim()
  if (!text) return undefined
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text)
    return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : undefined
  }
  const at = Date.parse(text)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - now)
}

/** 生成 name === 'AbortError' 的错误，与 fetch 的取消错误保持同构 */
export function abortError(): Error {
  const error = new Error('请求已取消')
  error.name = 'AbortError'
  return error
}

/** 可被 AbortSignal 打断的等待 */
export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 把网络层异常包装成可重试的 ProviderError */
export function networkProviderError(
  providerName: string,
  baseUrl: string,
  providerId: string | undefined,
  error: unknown,
): ProviderError {
  return new ProviderError(describeNetworkError(providerName, baseUrl, error), {
    providerId,
    retryable: true,
  })
}

/** 把 HTTP 错误响应包装成 ProviderError（429/5xx 标记为可重试，并带上 Retry-After） */
export function httpProviderError(
  providerName: string,
  providerId: string | undefined,
  status: number,
  bodyText: string,
  retryAfterHeader?: string | null,
): ProviderError {
  const retryable = isRetryableStatus(status)
  return new ProviderError(describeHttpError(status, bodyText, providerName), {
    status,
    providerId,
    retryable,
    retryAfterMs: retryable ? parseRetryAfter(retryAfterHeader) : undefined,
  })
}

export interface ProviderRetryInfo {
  /** 第几次重试（1 起） */
  attempt: number
  status?: number
  delayMs: number
  message: string
}

export interface ProviderRetryOptions<T> {
  signal?: AbortSignal
  /** 本次流是否已经 emit 过文本/推理增量（有则不允许重试，避免重复内容） */
  hasEmittedOutput: () => boolean
  /** 一次完整尝试（含读取完整个 SSE 流） */
  attempt: (attemptIndex: number) => Promise<T>
  /** 即将重试前回调（用于运行日志/诊断，不影响重试流程） */
  onRetry?: (info: ProviderRetryInfo) => void
}

/** 带退避的执行器：只对标记为 retryable 的错误重试，重试耗尽后原样抛出最后一个错误 */
export async function withProviderRetry<T>(options: ProviderRetryOptions<T>): Promise<T> {
  const { signal, hasEmittedOutput, attempt, onRetry } = options
  let lastError: unknown
  for (let attemptIndex = 0; attemptIndex <= MAX_RETRIES; attemptIndex++) {
    if (signal?.aborted) throw abortError()
    try {
      return await attempt(attemptIndex)
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error
      lastError = error
      const retryable =
        error instanceof ProviderError && (error.retryable === true || isRetryableStatus(error.status))
      if (!retryable || attemptIndex >= MAX_RETRIES || hasEmittedOutput()) throw error
      const retryAfterMs = error instanceof ProviderError ? error.retryAfterMs : undefined
      const delay =
        retryAfterMs !== undefined ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS) : BASE_DELAY_MS * 2 ** attemptIndex
      try {
        onRetry?.({
          attempt: attemptIndex + 1,
          status: error instanceof ProviderError ? error.status : undefined,
          delayMs: delay,
          message: error instanceof Error ? error.message : String(error),
        })
      } catch {
        /* 日志回调异常不能影响重试 */
      }
      await sleepWithSignal(delay, signal)
    }
  }
  throw lastError
}
