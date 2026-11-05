/** AI 服务商适配层共享类型。 */
import type { AiProviderConfig } from '@aiab/core'

/** 传给模型的消息（供应商无关的内部格式） */
export interface LlmToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** assistant 消息附带的工具调用 */
  toolCalls?: LlmToolCall[]
  /** role === 'tool' 时对应的调用 id */
  toolCallId?: string
  /** role === 'tool' 时的工具名（部分供应商需要） */
  name?: string
}

export interface ProviderTool {
  name: string
  description: string
  /** JSON Schema（object） */
  parameters: Record<string, unknown>
}

/** 服务商返回的模型元数据（能拿到多少填多少） */
export interface ModelInfo {
  id: string
  /** 展示名，如 "DeepSeek V4.1 Flash" */
  name?: string
  ownedBy?: string
  /** 上下文长度（token） */
  contextLength?: number
  maxOutput?: number
  /** 是否支持工具调用 / function calling */
  tools?: boolean
  /** 是否支持推理（thinking） */
  reasoning?: boolean
  /** 是否免费 */
  free?: boolean
  description?: string
}

export interface ModelListResult {
  models: string[]
  details: Record<string, ModelInfo>
  /** 未使用 API Key 拉取（部分网关的 /models 是公开的） */
  anonymous?: boolean
}

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
}

export interface ProviderStreamRequest {
  provider: AiProviderConfig
  messages: LlmMessage[]
  /** 本轮会话 id（部分网关如 OpenCode Go 需要稳定的会话标识做路由/缓存） */
  sessionId?: string
  tools?: ProviderTool[]
  signal?: AbortSignal
  onText?: (delta: string) => void
  onReasoning?: (delta: string) => void
  /** 服务商请求即将自动重试（429 / 5xx / 网络抖动），用于诊断日志 */
  onRetry?: (info: { attempt: number; status?: number; delayMs: number; message: string }) => void
}

export interface ProviderStreamResult {
  text: string
  reasoning: string
  toolCalls: LlmToolCall[]
  usage?: TokenUsage
  /** 本轮输出因 max_tokens 上限被截断（finish_reason === 'length' / stop_reason === 'max_tokens'） */
  truncated?: boolean
}

export class ProviderError extends Error {
  status?: number
  providerId?: string
  /** 是否值得自动重试（HTTP 429/5xx 与网络抖动），由适配器标记 */
  retryable?: boolean
  /** 服务端 Retry-After 建议的等待时间（毫秒） */
  retryAfterMs?: number
  constructor(
    message: string,
    options: { status?: number; providerId?: string; retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message)
    this.name = 'ProviderError'
    this.status = options.status
    this.providerId = options.providerId
    this.retryable = options.retryable
    this.retryAfterMs = options.retryAfterMs
  }
}

/** 把供应商返回的错误体尽量解析成人话 */
export function describeHttpError(status: number, text: string, providerName: string): string {
  let detail = text.trim()
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; type?: string } | string
      message?: string
    }
    if (typeof parsed.error === 'string') detail = parsed.error
    else if (parsed.error?.message) detail = parsed.error.message
    else if (parsed.message) detail = parsed.message
  } catch {
    /* 保留原始文本 */
  }
  if (detail.length > 600) detail = `${detail.slice(0, 600)}…`
  return `${providerName} 接口返回 HTTP ${status}${detail ? `：${detail}` : ''}`
}

/** 把 fetch 的网络层错误翻译成可操作的中文提示 */
export function describeNetworkError(providerName: string, baseUrl: string, error: unknown): string {
  const err = error as { message?: string; cause?: { code?: string; message?: string } }
  const detail = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(error)
  return `无法连接 ${providerName}（${baseUrl}）：${detail}。请检查网络、接口地址（baseUrl）或代理设置。`
}

/** AbortError 要继续向上抛（取消要能被识别），其他网络错误包装成 ProviderError */
export function isAbortError(error: unknown): boolean {
  return (error as { name?: string })?.name === 'AbortError'
}
