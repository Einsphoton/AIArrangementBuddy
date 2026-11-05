/**
 * OpenAI 兼容服务商适配（/chat/completions）。
 * 兼容 OpenAI / DeepSeek / Moonshot / 通义 / 智谱 / OpenRouter / Ollama / vLLM 等。
 *
 * 支持：
 * - 流式文本 delta
 * - reasoning_content（DeepSeek 等国产模型的思考过程）
 * - function calling（流式 tool_calls 拼接）
 */
import type { AiProviderConfig } from '@aiab/core'
import { httpProviderError, networkProviderError, withProviderRetry } from './retry.js'
import { readSseEvents } from './sse.js'
import {
  describeHttpError,
  describeNetworkError,
  isAbortError,
  ProviderError,
  type LlmMessage,
  type LlmToolCall,
  type ModelInfo,
  type ModelListResult,
  type ProviderStreamRequest,
  type ProviderStreamResult,
  type TokenUsage,
} from './types.js'

/** 进程内稳定的会话标识（OpenCode Go 要求 x-opencode-session 才会路由） */
const PROCESS_SESSION_ID = `aiab-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`

/** 是否为 OpenCode Go 推理网关（需要额外的会话头与客户端标识） */
function isOpenCodeGo(provider: AiProviderConfig): boolean {
  return /opencode\.ai\/inference\/go/i.test(provider.baseUrl)
}

/**
 * 按网关要求补齐请求头：
 * - OpenCode Go：x-opencode-session（稳定会话 id）+ 自定义 User-Agent
 * - OpenRouter：来源标识（已有）
 */
function applyGatewayHeaders(
  provider: AiProviderConfig,
  headers: Record<string, string>,
  sessionId?: string,
): Record<string, string> {
  if (isOpenCodeGo(provider)) {
    headers['x-opencode-session'] = headers['x-opencode-session'] ?? sessionId ?? PROCESS_SESSION_ID
    headers['User-Agent'] = headers['User-Agent'] ?? 'ai-arrangement-buddy/0.1 (local DAW agent)'
  }
  return headers
}

interface OpenAiToolCallDelta {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface OpenAiStreamChunk {
  choices?: {
    index?: number
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: OpenAiToolCallDelta[]
    }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    input_tokens?: number
    output_tokens?: number
  }
  error?: { message?: string }
}

interface OpenAiMessagePayload {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
  name?: string
}

export function openAiBaseUrl(baseUrl: string): string {
  const trimmed = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!trimmed) throw new ProviderError('未配置服务商 baseUrl')
  return trimmed
}

export function toOpenAiMessages(messages: LlmMessage[]): OpenAiMessagePayload[] {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      const payload: OpenAiMessagePayload = { role: 'assistant', content: message.content || null }
      if (message.toolCalls?.length) {
        payload.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        }))
      }
      return payload
    }
    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: message.content,
        tool_call_id: message.toolCallId ?? '',
        name: message.name,
      }
    }
    return { role: message.role, content: message.content }
  })
}

function buildRequestBody(options: {
  provider: AiProviderConfig
  messages: LlmMessage[]
  tools?: ProviderStreamRequest['tools']
  streamOptions: boolean
}): Record<string, unknown> {
  const { provider, messages, tools, streamOptions } = options
  const body: Record<string, unknown> = {
    model: provider.model,
    messages: toOpenAiMessages(messages),
    stream: true,
    temperature: provider.temperature,
    max_tokens: provider.maxTokens,
  }
  if (streamOptions) body.stream_options = { include_usage: true }
  if (tools?.length) {
    body.tools = tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
    body.tool_choice = 'auto'
    if (provider.parallelToolCalls === false) body.parallel_tool_calls = false
  }
  return body
}

function buildHeaders(provider: AiProviderConfig, sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    ...(provider.extraHeaders ?? {}),
  }
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`
  if (provider.id === 'openrouter') {
    headers['HTTP-Referer'] = headers['HTTP-Referer'] ?? 'https://github.com/aiab'
    headers['X-Title'] = headers['X-Title'] ?? 'AI Arrangement Buddy'
  }
  return applyGatewayHeaders(provider, headers, sessionId)
}

function normalizeUsage(usage: OpenAiStreamChunk['usage']): TokenUsage | undefined {
  if (!usage) return undefined
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens
  const outputTokens = usage.completion_tokens ?? usage.output_tokens
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  return { inputTokens, outputTokens }
}

/** 发起一次流式对话，聚合文本 / 推理 / 工具调用（限流与临时性故障自动重试） */
export async function streamOpenAi(request: ProviderStreamRequest): Promise<ProviderStreamResult> {
  const { provider, messages, tools, signal, onText, onReasoning } = request
  const url = `${openAiBaseUrl(provider.baseUrl)}/chat/completions`
  /** 本次请求是否已经 emit 过增量：吐过文本/推理就绝不重试（否则 UI 会重复显示） */
  let emittedOutput = false

  const doRequest = async (streamOptions: boolean): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: buildHeaders(provider, request.sessionId),
      body: JSON.stringify(buildRequestBody({ provider, messages, tools, streamOptions })),
      signal,
    })

  const attempt = async (): Promise<ProviderStreamResult> => {
    let response: Response
    try {
      response = await doRequest(true)
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error
      throw networkProviderError(provider.name, provider.baseUrl, provider.id, error)
    }
    if (!response.ok && (response.status === 400 || response.status === 422)) {
      // 少数兼容端点不认识 stream_options，去掉后重试一次
      const text = await response.text().catch(() => '')
      if (/stream_options/i.test(text)) {
        try {
          response = await doRequest(false)
        } catch (error) {
          if (isAbortError(error) || signal?.aborted) throw error
          throw networkProviderError(provider.name, provider.baseUrl, provider.id, error)
        }
      } else {
        throw httpProviderError(provider.name, provider.id, response.status, text, response.headers.get('retry-after'))
      }
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw httpProviderError(provider.name, provider.id, response.status, text, response.headers.get('retry-after'))
    }

    let text = ''
    let reasoning = ''
    let usage: TokenUsage | undefined
    let truncated = false
    const callMap = new Map<number, { id: string; name: string; argsText: string }>()
    let fallbackId = 0

    try {
      for await (const event of readSseEvents(response)) {
        const data = event.data.trim()
        if (!data || data === '[DONE]') continue
        let chunk: OpenAiStreamChunk
        try {
          chunk = JSON.parse(data) as OpenAiStreamChunk
        } catch {
          continue
        }
        if (chunk.error?.message) {
          throw new ProviderError(`${provider.name}：${chunk.error.message}`, { providerId: provider.id })
        }
        if (chunk.usage) {
          const normalized = normalizeUsage(chunk.usage)
          if (normalized) usage = { ...usage, ...normalized }
        }
        const choice = chunk.choices?.[0]
        if (choice?.finish_reason === 'length' || choice?.finish_reason === 'max_tokens') truncated = true
        const delta = choice?.delta
        if (!delta) continue
        const reasoningDelta = delta.reasoning_content ?? delta.reasoning
        if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
          reasoning += reasoningDelta
          emittedOutput = true
          onReasoning?.(reasoningDelta)
        }
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          text += delta.content
          emittedOutput = true
          onText?.(delta.content)
        }
        if (delta.tool_calls?.length) {
          for (const call of delta.tool_calls) {
            const index = typeof call.index === 'number' ? call.index : call.id ? fallbackId++ : 0
            const entry = callMap.get(index) ?? { id: '', name: '', argsText: '' }
            if (call.id) entry.id = call.id
            if (call.function?.name) entry.name = call.function.name
            if (call.function?.arguments) entry.argsText += call.function.arguments
            callMap.set(index, entry)
          }
        }
      }
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error
      if (error instanceof ProviderError) throw error
      // 流读到一半网络断了：没吐过内容可以整体重试
      throw networkProviderError(provider.name, provider.baseUrl, provider.id, error)
    }

    const toolCalls: LlmToolCall[] = []
    for (const [index, entry] of [...callMap.entries()].sort((a, b) => a[0] - b[0])) {
      if (!entry.name) continue
      let args: Record<string, unknown> = {}
      if (entry.argsText.trim()) {
        try {
          const parsed = JSON.parse(entry.argsText) as unknown
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
          else args = { value: parsed }
        } catch {
          args = { _raw: entry.argsText }
        }
      }
      toolCalls.push({ id: entry.id || `call_${index}_${Date.now().toString(36)}`, name: entry.name, args })
    }

    return { text, reasoning, toolCalls, usage, truncated: truncated || undefined }
  }

  return withProviderRetry({
    signal,
    hasEmittedOutput: () => emittedOutput,
    attempt,
    onRetry: (info) => request.onRetry?.(info),
  })
}

/** GET /models -> 模型列表（含能力元数据，能解析多少算多少） */
export async function listOpenAiModelInfos(
  provider: AiProviderConfig,
  signal?: AbortSignal,
): Promise<ModelListResult> {
  const override = (provider.modelsUrl ?? '').trim()
  const url = override || `${openAiBaseUrl(provider.baseUrl)}/models`
  const headers: Record<string, string> = { Accept: 'application/json', ...(provider.extraHeaders ?? {}) }
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`
  applyGatewayHeaders(provider, headers)
  let response: Response
  try {
    response = await fetch(url, { headers, signal })
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new ProviderError(describeNetworkError(provider.name, provider.baseUrl, error), { providerId: provider.id })
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new ProviderError(describeHttpError(response.status, text, provider.name), {
      status: response.status,
      providerId: provider.id,
    })
  }
  const body = (await response.json()) as unknown
  const rawList: unknown[] = Array.isArray((body as { data?: unknown[] })?.data)
    ? ((body as { data: unknown[] }).data)
    : Array.isArray((body as { models?: unknown[] })?.models)
      ? ((body as { models: unknown[] }).models)
      : []

  const details: Record<string, ModelInfo> = {}
  const ids: string[] = []
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : ''
    if (!id) continue
    const pickNum = (...values: unknown[]): number | undefined => {
      for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
        if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
      }
      return undefined
    }
    const limit = (item.limit ?? {}) as { context?: unknown; input?: unknown; output?: unknown }
    const capabilities = (item.capabilities ?? {}) as {
      tools?: { supported?: unknown }
      reasoning?: { supported?: unknown }
    }
    const supportedParams = Array.isArray(item.supported_parameters)
      ? (item.supported_parameters as unknown[]).map((value) => String(value))
      : []
    const pricing = (item.pricing ?? {}) as { prompt?: unknown; completion?: unknown }
    const priceZero =
      (typeof pricing.prompt === 'string' && Number(pricing.prompt) === 0) ||
      (typeof pricing.prompt === 'number' && pricing.prompt === 0)
    const tools =
      typeof capabilities.tools?.supported === 'boolean'
        ? capabilities.tools.supported
        : supportedParams.length
          ? supportedParams.includes('tools') || supportedParams.includes('tool_choice')
          : undefined
    const reasoning =
      typeof capabilities.reasoning?.supported === 'boolean'
        ? capabilities.reasoning.supported
        : supportedParams.length
          ? supportedParams.includes('reasoning') || supportedParams.includes('include_reasoning')
          : undefined

    details[id] = {
      id,
      name: typeof item.name === 'string' ? item.name : undefined,
      ownedBy: typeof item.owned_by === 'string' ? item.owned_by : undefined,
      description: typeof item.description === 'string' ? item.description : undefined,
      contextLength: pickNum(
        item.context_length,
        item.context_window,
        item.max_context_length,
        limit.context,
        limit.input,
        (item.top_provider as { context_length?: unknown } | undefined)?.context_length,
      ),
      maxOutput: pickNum(item.max_output_tokens, limit.output),
      tools,
      reasoning,
      free: priceZero || /(^|[-/])free$/.test(id) || id.includes('-free') ? true : undefined,
    }
    ids.push(id)
  }

  const unique = [...new Set(ids)].sort((a, b) => a.localeCompare(b))
  return {
    models: unique,
    details,
    anonymous: !provider.apiKey,
  }
}

/** GET /models -> 模型 id 列表 */
export async function listOpenAiModels(
  provider: AiProviderConfig,
  signal?: AbortSignal,
): Promise<string[]> {
  const result = await listOpenAiModelInfos(provider, signal)
  return result.models
}
