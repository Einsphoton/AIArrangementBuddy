/**
 * 设置持久化：<DATA_DIR>/settings.json。
 *
 * 关键约定（CONTRACTS §4）：
 * - GET 返回时 API Key / 搜索 Key 一律脱敏；
 * - PUT 时前端会把脱敏值原样回传，若等于脱敏值必须保留真实 Key，不能覆盖。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  appSettingsSchema,
  createDefaultSettings,
  defaultProviderFromPreset,
  maskSecret,
  type AiProviderConfig,
  type AppSettings,
} from '@aiab/core'
import { settingsFile } from '../config.js'

/** 读取设置；文件不存在 / 解析失败时返回默认设置 */
export function loadSettings(): AppSettings {
  if (!existsSync(settingsFile)) {
    const defaults = createDefaultSettings()
    saveSettings(defaults)
    return defaults
  }
  try {
    const raw = JSON.parse(readFileSync(settingsFile, 'utf8')) as unknown
    const parsed = appSettingsSchema.safeParse(raw)
    if (!parsed.success) return createDefaultSettings()
    return parsed.data as AppSettings
  } catch {
    return createDefaultSettings()
  }
}

export function saveSettings(settings: AppSettings): void {
  const dir = dirname(settingsFile)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8')
}

/** GET /api/settings 的输出：所有密钥脱敏 */
export function maskSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    providers: settings.providers.map((provider) => ({ ...provider, apiKey: maskSecret(provider.apiKey) })),
    search: { ...settings.search, apiKey: maskSecret(settings.search.apiKey) },
  }
}

/** 判断某个值是否是另一个密钥的脱敏形式 */
function isMaskedOf(maskedValue: string, realValue: string): boolean {
  if (!realValue) return false
  if (!maskedValue) return false
  if (maskedValue === maskSecret(realValue)) return true
  // 前端可能把别的 provider 的脱敏值带过来 / 字符被截断，做宽松判断
  if (maskedValue.includes('••')) return true
  return false
}

/**
 * 合并前端 PUT 的设置与已存设置：
 * - 脱敏值视为「未修改」，保留旧的真实 Key；
 * - 其余值（含空字符串 = 主动清空）原样保存。
 */
export function mergeIncomingSettings(incoming: AppSettings): AppSettings {
  const stored = loadSettings()
  const providers = incoming.providers.map((provider) => {
    const existing =
      stored.providers.find((item) => item.id === provider.id) ??
      stored.providers.find((item) => item.name === provider.name)
    let apiKey = provider.apiKey
    if (existing && isMaskedOf(provider.apiKey, existing.apiKey)) {
      // 回传的是脱敏值：保留已存的真实 Key
      apiKey = existing.apiKey
    } else if (apiKey.includes('••')) {
      // 找不到对应旧配置却收到脱敏值（例如先删后加）：无法还原，按空处理，避免把 •••• 当 Key 发出去
      apiKey = ''
    }
    return { ...provider, apiKey }
  })
  let searchApiKey = incoming.search.apiKey
  if (isMaskedOf(incoming.search.apiKey, stored.search.apiKey)) {
    searchApiKey = stored.search.apiKey
  } else if (searchApiKey.includes('••')) {
    searchApiKey = ''
  }
  return {
    ...incoming,
    providers,
    search: { ...incoming.search, apiKey: searchApiKey },
  }
}

/** 当前使用的服务商（activeProviderId 无效时退化为第一个） */
export function getActiveProvider(settings: AppSettings): AiProviderConfig | null {
  if (settings.providers.length === 0) return null
  const active = settings.providers.find((provider) => provider.id === settings.activeProviderId)
  return active ?? settings.providers[0]
}

/** 前端传入的设置里可能带脱敏 Key，这里用已存设置补全真实 Key */
export function withRealSecrets(incoming: AppSettings): AppSettings {
  return mergeIncomingSettings(incoming)
}

/** 按 id 或 preset id 找服务商，找不到时按 preset 建一个 */
export function resolveProvider(settings: AppSettings, providerId: string): AiProviderConfig | null {
  const exact = settings.providers.find((provider) => provider.id === providerId)
  if (exact) return exact
  const byName = settings.providers.find((provider) => provider.name === providerId)
  if (byName) return byName
  if (providerId) return defaultProviderFromPreset(providerId)
  return getActiveProvider(settings)
}

/** 服务商配置是否具备调用条件（本地服务允许空 Key） */
export function providerReady(provider: AiProviderConfig): { ready: boolean; reason?: string } {
  if (!provider.baseUrl) return { ready: false, reason: '未填写 baseUrl（接口地址）' }
  if (!provider.model) return { ready: false, reason: '未选择模型' }
  if (!provider.apiKey) {
    const isLocal = /127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]/.test(provider.baseUrl)
    if (!isLocal) return { ready: false, reason: `未配置 API Key（${provider.name}）` }
  }
  return { ready: true }
}
