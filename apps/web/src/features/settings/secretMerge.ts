import type { AppSettings } from '@aiab/core'

/**
 * API Key 脱敏合并（docs/CONTRACTS.md §4）：
 * 服务端 GET 返回的是脱敏值，用户没有修改时必须原样带回，不能覆盖真实 Key。
 *
 * 约定：
 * - 草稿中的 Key 与加载值完全一致 → 未修改，原样提交（服务端识别脱敏值后保留原 Key）；
 * - 草稿中被清空且原来有 Key → 默认视为「未修改」；要真正删除，需通过 clearedProviderIds 显式标记；
 * - 用户输入了新值 → 使用新值。
 */
export function mergeSecrets(
  draft: AppSettings,
  loaded: AppSettings | null,
  clearedProviderIds: string[] = [],
): AppSettings {
  if (!loaded) return draft
  const providers = draft.providers.map((provider) => {
    const original = loaded.providers.find((item) => item.id === provider.id)
    if (!original) return provider
    if (clearedProviderIds.includes(provider.id)) return { ...provider, apiKey: '' }
    if (!provider.apiKey) return { ...provider, apiKey: original.apiKey }
    return provider
  })
  const search = {
    ...draft.search,
    apiKey: draft.search.apiKey ? draft.search.apiKey : (loaded.search?.apiKey ?? ''),
  }
  return { ...draft, providers, search }
}

/** 是否像脱敏后的 Key（用于提示语判断，不做强校验） */
export function looksMasked(value: string): boolean {
  return value.includes('•') || value.includes('*')
}

/** 服务商是否已配置 Key（脱敏值也算已配置） */
export function hasProviderKey(settings: AppSettings): boolean {
  const active =
    settings.providers.find((provider) => provider.id === settings.activeProviderId) ?? settings.providers[0]
  return Boolean(active?.apiKey)
}
