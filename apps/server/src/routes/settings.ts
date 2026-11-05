/** 设置路由：读写（API Key 脱敏）+ 测试连接 + 模型列表。 */
import type { FastifyInstance } from 'fastify'
import { appSettingsSchema, maskSecret, type AppSettings } from '@aiab/core'
import {
  getActiveProvider,
  loadSettings,
  maskSettings,
  mergeIncomingSettings,
  providerReady,
  resolveProvider,
  saveSettings,
  withRealSecrets,
} from '../storage/settings.js'
import { listModelInfos, listModels, testProvider } from '../providers/index.js'
import { invalidateAgentProbe } from '../agent/probe.js'

function parseIncoming(body: unknown): AppSettings | null {
  if (!body || typeof body !== 'object') return null
  const parsed = appSettingsSchema.safeParse(body)
  return parsed.success ? (parsed.data as AppSettings) : null
}

export function registerSettingsRoutes(app: FastifyInstance): void {
  app.get('/api/settings', async () => maskSettings(loadSettings()))

  app.put<{ Body: unknown }>('/api/settings', async (request, reply) => {
    const incoming = parseIncoming(request.body)
    if (!incoming) return reply.code(400).send({ error: '设置数据不合法（AppSettings schema 校验失败）' })
    const merged = mergeIncomingSettings(incoming)
    saveSettings(merged)
    invalidateAgentProbe()
    return { ok: true }
  })

  app.post<{ Body: { providerId?: string; settings?: unknown } }>('/api/settings/test-provider', async (request, reply) => {
    const body = request.body ?? {}
    const incoming = parseIncoming(body.settings)
    if (!incoming) return reply.code(400).send({ error: 'settings 不合法' })
    const settings = withRealSecrets(incoming)
    const provider = resolveProvider(settings, typeof body.providerId === 'string' ? body.providerId : '')
    if (!provider) return reply.send({ ok: false, message: '找不到该服务商配置' })
    const ready = providerReady(provider)
    if (!ready.ready) return reply.send({ ok: false, message: ready.reason ?? '服务商配置不完整' })
    const result = await testProvider(provider)
    return reply.send(result)
  })

  app.post<{ Body: { settings?: unknown; providerId?: string; provider?: unknown } }>(
    '/api/settings/models',
    async (request, reply) => {
      const body = request.body ?? {}
      const incoming = parseIncoming(body.settings)
      if (!incoming) return reply.code(400).send({ error: 'settings 不合法' })
      const settings = withRealSecrets(incoming)
      const provider = resolveProvider(settings, typeof body.providerId === 'string' ? body.providerId : '')
      if (!provider) return reply.code(400).send({ error: '找不到该服务商配置' })
      if (!provider.baseUrl) return reply.code(400).send({ error: '请先填写 Base URL' })

      // 很多网关（OpenCode Zen/Go、OpenRouter、Ollama）的 /models 是公开的：
      // 没填 Key 也先尝试拉取，失败再给出「需要 Key」的提示，体验更顺。
      const ready = providerReady(provider)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20_000)
      try {
        const result = await listModelInfos(provider, controller.signal)
        return {
          models: result.models,
          details: result.details,
          anonymous: result.anonymous,
          warning: ready.ready ? undefined : '未填写 API Key，已尝试读取公开模型列表；实际对话仍需 Key。',
        }
      } catch (error) {
        if (!ready.ready) {
          return reply
            .code(400)
            .send({ error: `${ready.reason ?? '服务商配置不完整'}（公开模型列表也不可用：${(error as Error).message}）` })
        }
        return reply.code(502).send({ error: `获取模型列表失败：${(error as Error).message}` })
      } finally {
        clearTimeout(timer)
      }
    },
  )

  // 便于前端展示脱敏规则（可选新路径，不影响契约）
  app.get('/api/settings/mask-example', async () => ({ masked: maskSecret('sk-1234567890abcdef') }))

  // 供内部调试：当前生效的服务商（不含 Key）
  app.get('/api/settings/active-provider', async () => {
    const settings = loadSettings()
    const provider = getActiveProvider(settings)
    if (!provider) return { provider: null }
    return {
      provider: {
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        model: provider.model,
        ready: providerReady(provider).ready,
        reason: providerReady(provider).reason,
        apiKey: maskSecret(provider.apiKey),
      },
    }
  })
}
