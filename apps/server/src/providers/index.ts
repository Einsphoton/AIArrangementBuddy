/** 服务商统一入口：按 kind 分发到 OpenAI 兼容 / Anthropic 适配器。 */
import type { AiProviderConfig } from '@aiab/core'
import { listAnthropicModelInfos, listAnthropicModels, streamAnthropic } from './anthropic.js'
import { listOpenAiModelInfos, listOpenAiModels, streamOpenAi } from './openai.js'
import {
  ProviderError,
  type ModelListResult,
  type ProviderStreamRequest,
  type ProviderStreamResult,
} from './types.js'

export * from './types.js'
export { streamOpenAi, listOpenAiModels, listOpenAiModelInfos } from './openai.js'
export { streamAnthropic, listAnthropicModels, listAnthropicModelInfos } from './anthropic.js'

export async function streamProvider(request: ProviderStreamRequest): Promise<ProviderStreamResult> {
  if (!request.provider.model) throw new ProviderError('未选择模型（model 为空）')
  if (request.provider.kind === 'anthropic') return streamAnthropic(request)
  return streamOpenAi(request)
}

/** 拉取服务商模型列表（失败抛 ProviderError） */
export async function listModels(provider: AiProviderConfig, signal?: AbortSignal): Promise<string[]> {
  if (provider.kind === 'anthropic') return listAnthropicModels(provider, signal)
  return listOpenAiModels(provider, signal)
}

/** 拉取模型列表 + 能力元数据（设置页的模型选择器用） */
export async function listModelInfos(provider: AiProviderConfig, signal?: AbortSignal): Promise<ModelListResult> {
  if (provider.kind === 'anthropic') return listAnthropicModelInfos(provider, signal)
  return listOpenAiModelInfos(provider, signal)
}

export interface ProviderTestResult {
  ok: boolean
  message: string
  latencyMs?: number
  models?: string[]
}

/**
 * 测试连接：优先拉模型列表（便宜），失败时再用一次极短对话 ping。
 * 绝不抛异常——前端「测试连接」按钮需要结构化结果。
 */
export async function testProvider(provider: AiProviderConfig): Promise<ProviderTestResult> {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const models = await listModels(provider, controller.signal)
    const latencyMs = Date.now() - startedAt
    return {
      ok: true,
      message: `连接成功${models.length ? `，可用模型 ${models.length} 个` : ''}`,
      latencyMs,
      models: models.slice(0, 200),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message, latencyMs: Date.now() - startedAt }
  } finally {
    clearTimeout(timer)
  }
}
