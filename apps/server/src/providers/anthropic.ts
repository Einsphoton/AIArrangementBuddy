/**
 * Anthropic Messages API 适配（/v1/messages）。
 * 支持流式文本、thinking（reasoning）与 tool_use 工具调用。
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
  type ModelInfo,
  type ModelListResult,
  type LlmToolCall,
  type ProviderStreamRequest,
  type ProviderStreamResult,
  type TokenUsage,
} from './types.js'

const ANTHROPIC_VERSION = '2023-06-01'

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  thinking?: string
  tool_use_id?: string
  content?: unknown
}

interface AnthropicStreamEvent {
  type?: string
  index?: number
  message?: { usage?: { input_tokens?: number; output_tokens?: number } }
  content_block?: AnthropicContentBlock
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string
  }
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { type?: string; message?: string }
}

export function anthropicMessagesUrl(baseUrl: string): string {
  const trimmed = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!trimmed) throw new ProviderError('未配置服务商 baseUrl')
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/messages`
  return `${trimmed}/v1/messages`
}

function anthropicBase(baseUrl: string): string {
  const trimmed = (baseUrl || '').trim().replace(/\/+$/, '')
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`
}

function buildHeaders(provider: AiProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'anthropic-version': ANTHROPIC_VERSION,
    ...(provider.extraHeaders ?? {}),
  }
  if (provider.apiKey) headers['x-api-key'] = provider.apiKey
  return headers
}

function splitSystem(messages: LlmMessage[]): { system: string; rest: LlmMessage[] } {
  const systemParts: string[] = []
  const rest: LlmMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') systemParts.push(message.content)
    else rest.push(message)
  }
  return { system: systemParts.join('\n\n'), rest }
}

function toAnthropicMessages(messages: LlmMessage[]): { role: 'user' | 'assistant'; content: AnthropicContentBlock[] }[] {
  const out: { role: 'user' | 'assistant'; content: AnthropicContentBlock[] }[] = []
  let pendingToolResults: AnthropicContentBlock[] = []

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return
    out.push({ role: 'user', content: pendingToolResults })
    pendingToolResults = []
  }

  for (const message of messages) {
    if (message.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: message.content,
      })
      continue
    }
    flushToolResults()
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const blocks: AnthropicContentBlock[] = []
    if (message.content) blocks.push({ type: 'text', text: message.content })
    if (message.role === 'assistant' && message.toolCalls?.length) {
      for (const call of message.toolCalls) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} })
      }
    }
    // 空 content 的 assistant 消息 Anthropic 会拒绝，过滤掉
    if (blocks.length === 0) continue
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  flushToolResults()
  return out
}

function buildRequestBody(provider: AiProviderConfig, messages: LlmMessage[], tools?: ProviderStreamRequest['tools']) {
  const { system, rest } = splitSystem(messages)
  const body: Record<string, unknown> = {
    model: provider.model,
    max_tokens: provider.maxTokens,
    temperature: provider.temperature,
    stream: true,
    messages: toAnthropicMessages(rest),
  }
  if (system) body.system = system
  if (tools?.length) {
    body.tools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }))
  }
  return body
}

/** 发起一次流式对话，聚合文本 / thinking / tool_use（限流与临时性故障自动重试） */
export async function streamAnthropic(request: ProviderStreamRequest): Promise<ProviderStreamResult> {
  const { provider, messages, tools, signal, onText, onReasoning } = request
  /** 本次请求是否已经 emit 过增量：吐过文本/思考就绝不重试（否则 UI 会重复显示） */
  let emittedOutput = false

  const attempt = async (): Promise<ProviderStreamResult> => {
    let response: Response
    try {
      response = await fetch(anthropicMessagesUrl(provider.baseUrl), {
        method: 'POST',
        headers: buildHeaders(provider),
        body: JSON.stringify(buildRequestBody(provider, messages, tools)),
        signal,
      })
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error
      throw networkProviderError(provider.name, provider.baseUrl, provider.id, error)
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw httpProviderError(provider.name, provider.id, response.status, text, response.headers.get('retry-after'))
    }

    let text = ''
    let reasoning = ''
    let usage: TokenUsage | undefined
    let truncated = false
    const toolCalls: LlmToolCall[] = []
    const partialJson = new Map<number, string>()
    const toolMeta = new Map<number, { id: string; name: string }>()

    try {
      for await (const event of readSseEvents(response)) {
        if (!event.data || event.data === '[DONE]') continue
        let payload: AnthropicStreamEvent
        try {
          payload = JSON.parse(event.data) as AnthropicStreamEvent
        } catch {
          continue
        }
        if (payload.type === 'error') {
          throw new ProviderError(`${provider.name}：${payload.error?.message ?? '流式返回错误'}`, {
            providerId: provider.id,
          })
        }
        if (payload.type === 'message_start' && payload.message?.usage) {
          usage = { ...usage, inputTokens: payload.message.usage.input_tokens }
        }
        if (payload.type === 'message_delta') {
          if (payload.usage?.output_tokens !== undefined) usage = { ...usage, outputTokens: payload.usage.output_tokens }
          if (payload.delta?.stop_reason === 'max_tokens') truncated = true
        }
        if (payload.type === 'content_block_start' && payload.content_block) {
          const block = payload.content_block
          if (block.type === 'tool_use' && block.id && block.name) {
            toolMeta.set(payload.index ?? toolCalls.length, { id: block.id, name: block.name })
            partialJson.set(payload.index ?? 0, '')
          }
        }
        if (payload.type === 'content_block_delta' && payload.delta) {
          const delta = payload.delta
          if (delta.type === 'text_delta' && delta.text) {
            text += delta.text
            emittedOutput = true
            onText?.(delta.text)
          } else if (delta.type === 'thinking_delta' && delta.thinking) {
            reasoning += delta.thinking
            emittedOutput = true
            onReasoning?.(delta.thinking)
          } else if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
            const index = payload.index ?? 0
            partialJson.set(index, (partialJson.get(index) ?? '') + delta.partial_json)
          }
        }
        if (payload.type === 'content_block_stop') {
          const index = payload.index ?? 0
          const meta = toolMeta.get(index)
          if (meta) {
            const jsonText = partialJson.get(index) ?? ''
            let args: Record<string, unknown> = {}
            if (jsonText.trim()) {
              try {
                const parsed = JSON.parse(jsonText) as unknown
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                  args = parsed as Record<string, unknown>
              } catch {
                args = { _raw: jsonText }
              }
            }
            toolCalls.push({ id: meta.id, name: meta.name, args })
          }
        }
      }
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error
      if (error instanceof ProviderError) throw error
      // 流读到一半网络断了：没吐过内容可以整体重试
      throw networkProviderError(provider.name, provider.baseUrl, provider.id, error)
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

export async function listAnthropicModelInfos(
  provider: AiProviderConfig,
  signal?: AbortSignal,
): Promise<ModelListResult> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    ...(provider.extraHeaders ?? {}),
  }
  if (provider.apiKey) headers['x-api-key'] = provider.apiKey
  let response: Response
  try {
    const override = (provider.modelsUrl ?? '').trim()
    const url = override || `${anthropicBase(provider.baseUrl)}/models?limit=100`
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
  const body = (await response.json()) as {
    data?: { id?: string; display_name?: string; created_at?: string }[]
  }
  const details: Record<string, ModelInfo> = {}
  const ids: string[] = []
  for (const item of body.data ?? []) {
    if (!item?.id) continue
    ids.push(item.id)
    details[item.id] = {
      id: item.id,
      name: typeof item.display_name === 'string' ? item.display_name : undefined,
      ownedBy: 'anthropic',
      tools: true,
      reasoning: true,
    }
  }
  return { models: [...new Set(ids)].sort((a, b) => a.localeCompare(b)), details, anonymous: !provider.apiKey }
}

export async function listAnthropicModels(provider: AiProviderConfig, signal?: AbortSignal): Promise<string[]> {
  const result = await listAnthropicModelInfos(provider, signal)
  return result.models
}
