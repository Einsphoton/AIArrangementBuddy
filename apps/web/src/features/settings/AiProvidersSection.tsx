import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AI_PROVIDER_PRESETS,
  defaultProviderFromPreset,
  type AiProviderConfig,
  type AiProviderPreset,
  type AppSettings,
} from '@aiab/core'
import {
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Plus,
  Sparkles,
  Trash2,
  Wand2,
  X,
  Zap,
} from 'lucide-react'
import { fetchProviderModels, testProvider, type ProviderModelInfo, type TestProviderResult } from '../../lib/api'
import { Badge, Button, NumberField, Select, Slider, Switch } from '../../components/ui'
import { cn } from '../../lib/format'
import { Details, FieldGroup, Section, StatusLine, describeRequestError, type SettingsSectionProps } from './shared'
import { looksMasked, mergeSecrets } from './secretMerge'
import { ModelPicker } from './ModelPicker'

interface ModelSlot {
  loading: boolean
  models: ProviderModelInfo[]
  warning?: string
  error?: string
}

const PRESET_GROUP_ORDER: AiProviderPreset['group'][] = ['国内直连', '聚合网关', '本地部署', '其它']

function presetFor(providerId: string): AiProviderPreset | undefined {
  return AI_PROVIDER_PRESETS.find((preset) => preset.id === providerId)
}

export function AiProvidersSection({
  draft,
  loaded,
  update,
  clearedKeys,
  onClearKey,
  onRestoreKey,
}: SettingsSectionProps) {
  const [modelSlots, setModelSlots] = useState<Record<string, ModelSlot>>({})
  const [testingActive, setTestingActive] = useState(false)
  const [activeTest, setActiveTest] = useState<TestProviderResult | null>(null)

  // 用 ref 保存最新草稿：新增服务商后立刻拉模型时，闭包里不能是旧状态
  const latest = useRef({ draft, loaded, clearedKeys })
  latest.current = { draft, loaded, clearedKeys }
  const effective = useCallback(() => {
    const { draft: d, loaded: l, clearedKeys: c } = latest.current
    return mergeSecrets(d, l, c)
  }, [])

  const loadModels = useCallback(
    async (providerId: string) => {
      setModelSlots((prev) => ({
        ...prev,
        [providerId]: { loading: true, models: prev[providerId]?.models ?? [], warning: undefined, error: undefined },
      }))
      try {
        const result = await fetchProviderModels(providerId, effective())
        const details = result.details ?? {}
        const models: ProviderModelInfo[] = result.models.map((id) => details[id] ?? { id })
        setModelSlots((prev) => ({ ...prev, [providerId]: { loading: false, models, warning: result.warning } }))
      } catch (error) {
        setModelSlots((prev) => ({
          ...prev,
          [providerId]: { loading: false, models: [], error: describeRequestError(error) },
        }))
      }
    },
    [effective],
  )

  const updateProvider = (id: string, patch: Partial<AiProviderConfig>) =>
    update((next) => {
      next.providers = next.providers.map((provider) => (provider.id === id ? { ...provider, ...patch } : provider))
    })

  const addPreset = (presetId: string) => {
    const existing = draft.providers.find((provider) => provider.id === presetId)
    update((next) => {
      if (existing) {
        next.activeProviderId = existing.id
        return
      }
      const provider = defaultProviderFromPreset(presetId)
      next.providers = [...next.providers, provider]
      next.activeProviderId = provider.id
    })
    // 新增后立刻预取模型（OpenCode 等网关的 /models 是公开的）
    if (!existing) setTimeout(() => void loadModels(presetId), 80)
  }

  const removeProvider = (id: string) =>
    update((next) => {
      next.providers = next.providers.filter((provider) => provider.id !== id)
      if (next.activeProviderId === id) next.activeProviderId = next.providers[0]?.id ?? ''
    })

  const setActive = (id: string) =>
    update((next) => {
      next.activeProviderId = id
    })

  const activeProvider =
    draft.providers.find((provider) => provider.id === draft.activeProviderId) ?? draft.providers[0]

  const runActiveTest = async () => {
    if (!activeProvider) return
    setTestingActive(true)
    setActiveTest(null)
    try {
      const result = await testProvider(activeProvider.id, effective())
      setActiveTest(result)
      if (result.ok) void loadModels(activeProvider.id)
    } catch (error) {
      setActiveTest({ ok: false, message: describeRequestError(error) })
    } finally {
      setTestingActive(false)
    }
  }

  /* 自动预取：已有 Key，或网关的模型列表是公开的（OpenCode Zen/Go、OpenRouter、Ollama） */
  const providerKey = draft.providers.map((provider) => provider.id).join('|')
  const slotKey = Object.keys(modelSlots).join('|')
  useEffect(() => {
    if (!loaded) return
    const timers: ReturnType<typeof setTimeout>[] = []
    draft.providers.forEach((provider, index) => {
      if (modelSlots[provider.id]) return
      const preset = presetFor(provider.id)
      const hasKey = Boolean(provider.apiKey)
      const publicList = Boolean(preset?.publicModelList) || /127\.0\.0\.1|localhost/.test(provider.baseUrl)
      if (!hasKey && !publicList) return
      timers.push(setTimeout(() => void loadModels(provider.id), 120 + index * 120))
    })
    return () => timers.forEach((timer) => clearTimeout(timer))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerKey, slotKey, loaded])

  const recommendedPresets = AI_PROVIDER_PRESETS.filter((preset) => preset.group === '推荐')
  const heroPresets = recommendedPresets.filter((preset) => preset.id.startsWith('opencode-'))
  const otherRecommended = recommendedPresets.filter((preset) => !preset.id.startsWith('opencode-'))
  const groupedPresets = useMemo(
    () =>
      PRESET_GROUP_ORDER.map((group) => ({
        group,
        presets: AI_PROVIDER_PRESETS.filter((preset) => preset.group === group),
      })).filter((entry) => entry.presets.length > 0),
    [],
  )

  return (
    <div className="space-y-3">
      {/* ---------------- 当前使用 ---------------- */}
      <Section
        title="当前使用的 AI 服务商"
        description="内置 Agent 用这里选中的服务商与模型来推理、调用编曲工具。"
        icon={<Bot size={13} />}
        badge={
          draft.providers.length ? (
            <Badge tone="accent">{draft.providers.length} 个已添加</Badge>
          ) : (
            <Badge tone="danger">未配置</Badge>
          )
        }
      >
        {draft.providers.length === 0 ? (
          <p className="text-[11.5px] leading-relaxed text-ink-3">
            还没有服务商。下面「快捷配置」里挑一个（推荐 OpenCode Go / Zen，一个 Key 就能用全部模型）。
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span
                className="min-w-0 flex-1"
                title={
                  activeProvider
                    ? `${activeProvider.name} · ${activeProvider.model || '未选模型'}`
                    : '选择当前 AI 服务商'
                }
              >
                <Select
                  value={activeProvider?.id ?? ''}
                  ariaLabel="当前 AI 服务商"
                  className="h-9"
                  options={draft.providers.map((provider) => ({
                    value: provider.id,
                    label: `${provider.name} · ${provider.model || '未选模型'}`,
                  }))}
                  onChange={setActive}
                />
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-9 shrink-0"
                onClick={() => void runActiveTest()}
                disabled={testingActive}
                icon={testingActive ? <LoaderCircle size={11} className="animate-spin" /> : <Zap size={11} />}
              >
                {testingActive ? '测试中' : '测试连接'}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {activeProvider?.apiKey ? (
                <StatusLine tone="success" icon={<Check size={10} />}>
                  Key 已配置
                </StatusLine>
              ) : (
                <StatusLine tone="danger" icon={<KeyRound size={10} />}>
                  缺少 API Key
                </StatusLine>
              )}
              <span className="flex min-w-0 max-w-full items-center gap-1 text-[11px] text-ink-4">
                <span className="shrink-0">模型</span>
                <span className="mono min-w-0 max-w-[220px] truncate text-ink-2" title={activeProvider?.model || '未选模型'}>
                  {activeProvider?.model || '—'}
                </span>
              </span>
              {activeTest && (
                <StatusLine
                  tone={activeTest.ok ? 'success' : 'danger'}
                  icon={activeTest.ok ? <Check size={10} /> : <X size={10} />}
                >
                  {activeTest.ok ? '连接正常' : '连接失败'}
                  {activeTest.latencyMs ? ` · ${activeTest.latencyMs}ms` : ''}
                  {activeTest.message && !activeTest.ok ? ` · ${activeTest.message}` : ''}
                </StatusLine>
              )}
            </div>
          </div>
        )}
      </Section>

      {/* ---------------- 快捷配置 ---------------- */}
      <Section
        title="快捷配置"
        description="OpenCode 两个网关一个 Key 打通几乎所有模型；其余服务商按需添加。Key 只保存在本机。"
        icon={<Wand2 size={13} />}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {heroPresets.map((preset) => (
            <PresetHeroCard
              key={preset.id}
              preset={preset}
              added={draft.providers.some((provider) => provider.id === preset.id)}
              active={draft.activeProviderId === preset.id}
              modelCount={modelSlots[preset.id]?.models.length}
              loading={modelSlots[preset.id]?.loading}
              onAdd={() => addPreset(preset.id)}
            />
          ))}
        </div>

        {otherRecommended.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {otherRecommended.map((preset) => (
              <PresetChip
                key={preset.id}
                preset={preset}
                added={draft.providers.some((provider) => provider.id === preset.id)}
                active={draft.activeProviderId === preset.id}
                onAdd={() => addPreset(preset.id)}
              />
            ))}
          </div>
        )}

        <Details summary="更多服务商（国内直连 / 聚合网关 / 本地部署 / 自定义）">
          <div className="space-y-2 pt-1">
            {groupedPresets.map((entry) => (
              <div key={entry.group}>
                <div className="mb-1 text-[10.5px] font-semibold tracking-wide text-ink-4">{entry.group}</div>
                <div className="flex flex-wrap gap-1.5">
                  {entry.presets.map((preset) => (
                    <PresetChip
                      key={preset.id}
                      preset={preset}
                      added={draft.providers.some((provider) => provider.id === preset.id)}
                      active={draft.activeProviderId === preset.id}
                      onAdd={() => addPreset(preset.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Details>
      </Section>

      {/* ---------------- 服务商卡片 ---------------- */}
      {draft.providers.map((provider) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          preset={presetFor(provider.id)}
          active={provider.id === draft.activeProviderId}
          original={loaded?.providers.find((item) => item.id === provider.id) ?? null}
          cleared={clearedKeys.includes(provider.id)}
          slot={modelSlots[provider.id]}
          onUpdate={(patch) => updateProvider(provider.id, patch)}
          onSetActive={() => setActive(provider.id)}
          onRemove={() => removeProvider(provider.id)}
          onLoadModels={() => void loadModels(provider.id)}
          onClearKey={() => onClearKey(provider.id)}
          onRestoreKey={() => onRestoreKey(provider.id)}
          getEffectiveSettings={effective}
        />
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 快捷配置卡片                                                        */
/* ------------------------------------------------------------------ */

function PresetHeroCard({
  preset,
  added,
  active,
  modelCount,
  loading,
  onAdd,
}: {
  preset: AiProviderPreset
  added: boolean
  active: boolean
  modelCount?: number
  loading?: boolean
  onAdd: () => void
}) {
  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-xl border p-3 transition-colors',
        active
          ? 'border-accent/50 bg-gradient-to-br from-accent/12 via-surface-2 to-surface-2'
          : 'border-line bg-gradient-to-br from-surface-2 to-bg-soft hover:border-line-strong',
      )}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-accent/35 bg-accent/12 text-accent">
          <Sparkles size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[12.5px] font-semibold text-ink">{preset.name}</span>
            {preset.tag && <Badge tone="accent">{preset.tag}</Badge>}
            {active && <Badge tone="success">使用中</Badge>}
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">{preset.blurb ?? preset.hint}</p>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          className={cn('btn h-7 px-2.5 text-[11.5px]', added ? '' : 'btn-accent')}
          onClick={onAdd}
          title={added ? `设为当前：${preset.name}` : `添加并使用：${preset.name}`}
        >
          {added ? (
            <>
              <Check size={11} />
              设为当前
            </>
          ) : (
            <>
              <Plus size={11} />
              一键添加
            </>
          )}
        </button>
        {preset.docsUrl && (
          <a
            className="btn h-7 px-2 text-[11.5px] text-ink-2"
            href={preset.docsUrl}
            target="_blank"
            rel="noreferrer"
            title="打开服务商后台获取 API Key"
          >
            获取 Key
            <ArrowUpRight size={10} />
          </a>
        )}
        <span className="ml-auto text-[10.5px] text-ink-4">
          {loading ? '读取模型中…' : modelCount ? `${modelCount} 个模型` : '填 Key 即可用'}
        </span>
      </div>
    </div>
  )
}

function PresetChip({
  preset,
  added,
  active,
  onAdd,
}: {
  preset: AiProviderPreset
  added: boolean
  active: boolean
  onAdd: () => void
}) {
  return (
    <button
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-lg border px-2 text-[11.5px] transition-colors',
        active
          ? 'border-accent/50 bg-accent/12 text-accent-soft'
          : added
            ? 'border-line-strong bg-surface-2 text-ink-2'
            : 'border-line bg-bg-soft/50 text-ink-3 hover:border-line-strong hover:text-ink',
      )}
      onClick={onAdd}
      title={`${preset.name} · ${preset.hint}`}
    >
      {added ? <Check size={10} /> : <Plus size={10} />}
      {preset.name}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* 服务商配置卡片                                                      */
/* ------------------------------------------------------------------ */

function ProviderCard({
  provider,
  preset,
  active,
  original,
  cleared,
  slot,
  onUpdate,
  onSetActive,
  onRemove,
  onLoadModels,
  onClearKey,
  onRestoreKey,
  getEffectiveSettings,
}: {
  provider: AiProviderConfig
  preset?: AiProviderPreset
  active: boolean
  original: AiProviderConfig | null
  cleared: boolean
  slot?: ModelSlot
  onUpdate: (patch: Partial<AiProviderConfig>) => void
  onSetActive: () => void
  onRemove: () => void
  onLoadModels: () => void
  onClearKey: () => void
  onRestoreKey: () => void
  getEffectiveSettings: () => AppSettings
}) {
  const [showKey, setShowKey] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [headersText, setHeadersText] = useState(() => {
    const headers = provider.extraHeaders ?? {}
    return Object.keys(headers).length ? JSON.stringify(headers) : ''
  })
  const [headersError, setHeadersError] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestProviderResult | null>(null)
  const [testError, setTestError] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)

  const hasStoredKey = Boolean(original?.apiKey)
  const keyMasked = provider.apiKey ? looksMasked(provider.apiKey) : false
  const models = slot?.models ?? []

  const runTest = async () => {
    setTesting(true)
    setTestResult(null)
    setTestError('')
    try {
      const result = await testProvider(provider.id, getEffectiveSettings())
      setTestResult(result)
      if (result.ok) onLoadModels()
    } catch (error) {
      setTestError(describeRequestError(error))
    } finally {
      setTesting(false)
    }
  }

  return (
    <section
      className={cn('rounded-xl border bg-surface-2/40', active ? 'border-accent/40' : 'border-line')}
    >
      <header className="flex flex-wrap items-center gap-2 rounded-t-xl border-b border-line/80 px-3 py-2">
        <input
          className="field h-8 w-40 min-w-0 shrink-0 text-[12px] font-medium sm:w-52"
          value={provider.name}
          aria-label="服务商名称"
          title={provider.name}
          onChange={(event) => onUpdate({ name: event.target.value })}
        />
        <Badge tone={active ? 'accent' : 'neutral'}>
          {active ? '当前使用' : provider.kind === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'}
        </Badge>
        {keyMasked && <Badge tone="violet">Key 已保存</Badge>}
        {!provider.apiKey && <Badge tone="danger">缺 Key</Badge>}
        <div className="ml-auto flex items-center gap-1">
          {!active && (
            <button className="btn h-8 px-2 text-[11.5px]" onClick={onSetActive} title="设为当前服务商">
              设为当前
            </button>
          )}
          <button
            className={cn(
              'btn h-8 px-2 text-[11.5px]',
              confirmRemove ? 'border-danger/50 text-danger' : 'text-ink-3 hover:text-danger',
            )}
            onClick={() => {
              if (confirmRemove) onRemove()
              else {
                setConfirmRemove(true)
                setTimeout(() => setConfirmRemove(false), 3000)
              }
            }}
            title={confirmRemove ? '再次点击确认删除' : '删除该服务商'}
          >
            <Trash2 size={11} />
            {confirmRemove ? '确认删除' : ''}
          </button>
        </div>
      </header>

      <div className="space-y-2.5 px-3 py-3">
        {/* Base URL */}
        <FieldGroup
          label={
            <span className="flex items-center justify-between">
              <span>接口地址（Base URL）</span>
              {preset?.docsUrl && (
                <a
                  className="flex items-center gap-0.5 text-[10.5px] font-normal text-accent/80 hover:text-accent"
                  href={preset.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  获取 Key
                  <ArrowUpRight size={9} />
                </a>
              )}
            </span>
          }
        >
          <input
            className="field mono text-[11.5px]"
            value={provider.baseUrl}
            placeholder="https://api.deepseek.com/v1"
            spellCheck={false}
            onChange={(event) => onUpdate({ baseUrl: event.target.value })}
          />
        </FieldGroup>

        {/* API Key */}
        <FieldGroup
          label="API Key"
          hint={
            cleared
              ? '保存后将清空该服务商的 Key。'
              : keyMasked
                ? '已保存的 Key 以脱敏形式显示；不修改则保存时保持原值。'
                : '只保存在本机 data/settings.json，不会上传到除该服务商以外的任何地方。'
          }
        >
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1">
              <input
                className="field mono pr-8 text-[11.5px]"
                type={showKey ? 'text' : 'password'}
                value={provider.apiKey}
                placeholder={cleared ? '已清空，可输入新的 Key' : '粘贴 API Key（sk-…）'}
                onChange={(event) => onUpdate({ apiKey: event.target.value })}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-ink-4 hover:text-ink-2"
                onClick={() => setShowKey((value) => !value)}
                title={showKey ? '隐藏 Key' : '显示 Key'}
                aria-label={showKey ? '隐藏 Key' : '显示 Key'}
              >
                {showKey ? <EyeOff size={11} /> : <Eye size={11} />}
              </button>
            </div>
            {hasStoredKey && !cleared && (
              <button className="btn h-8 shrink-0 px-2 text-[10.5px] text-ink-3 hover:text-danger" onClick={onClearKey}>
                清除
              </button>
            )}
            {cleared && hasStoredKey && (
              <button className="btn h-8 shrink-0 px-2 text-[10.5px]" onClick={onRestoreKey}>
                撤销清除
              </button>
            )}
          </div>
        </FieldGroup>

        {/* 模型：可搜索、可读取全部模型 */}
        <FieldGroup
          label={
            <span className="flex items-center justify-between">
              <span>模型</span>
              <span className="text-[10.5px] font-normal text-ink-4">
                {slot?.loading
                  ? '读取中…'
                  : models.length
                    ? `已读取 ${models.length} 个，可搜索`
                    : '点下拉框刷新可读取全部模型'}
              </span>
            </span>
          }
        >
          <ModelPicker
            value={provider.model}
            models={models}
            loading={slot?.loading}
            error={slot?.error}
            warning={slot?.warning}
            recommended={preset?.recommendedModels}
            onRefresh={onLoadModels}
            onOpen={() => {
              if (!slot || (!slot.models.length && !slot.loading && !slot.error)) onLoadModels()
            }}
            onChange={(model) => onUpdate({ model })}
          />
        </FieldGroup>

        {/* 高级参数 */}
        <button
          className="flex w-full items-center gap-1.5 border-t border-line/70 pt-2 text-[11px] text-ink-3 hover:text-ink-2"
          onClick={() => setAdvanced((value) => !value)}
        >
          <ChevronDown size={11} className={cn('transition-transform', advanced && 'rotate-180')} />
          高级参数（温度 / 最大 Token / 接口类型 / 额外请求头）
        </button>

        {advanced && (
          <div className="grid gap-2.5 sm:grid-cols-2">
            <FieldGroup label={`温度 ${provider.temperature.toFixed(2)}`} hint="越低越稳定，越高越有创意">
              <Slider
                value={provider.temperature}
                min={0}
                max={2}
                step={0.05}
                ariaLabel="温度"
                onChange={(value) => onUpdate({ temperature: value })}
              />
            </FieldGroup>

            <FieldGroup label="最大 Token" hint="单次回复上限">
              <div className="flex items-center gap-2">
                <NumberField
                  value={provider.maxTokens}
                  min={256}
                  max={200000}
                  step={256}
                  width={92}
                  onChange={(value) => onUpdate({ maxTokens: Math.round(value) })}
                />
                <div className="flex items-center gap-1.5 text-[11px] text-ink-3">
                  <Switch
                    checked={provider.parallelToolCalls}
                    label="并行工具调用"
                    onChange={(value) => onUpdate({ parallelToolCalls: value })}
                  />
                  并行工具
                </div>
              </div>
            </FieldGroup>

            <FieldGroup label="接口类型" hint="绝大多数服务用 OpenAI 兼容格式">
              <Select
                value={provider.kind}
                ariaLabel="接口类型"
                options={[
                  { value: 'openai', label: 'OpenAI 兼容（/chat/completions）' },
                  { value: 'anthropic', label: 'Anthropic（/v1/messages）' },
                ]}
                onChange={(value) => onUpdate({ kind: value as AiProviderConfig['kind'] })}
              />
            </FieldGroup>

            <FieldGroup label="模型列表地址（可选）" hint="列表与推理地址不同时才需要（如 OpenCode Go）">
              <input
                className="field mono text-[11px]"
                value={provider.modelsUrl ?? ''}
                placeholder="留空 = Base URL + /models"
                spellCheck={false}
                onChange={(event) => onUpdate({ modelsUrl: event.target.value })}
              />
            </FieldGroup>

            <FieldGroup
              label="额外请求头（JSON，可选）"
              className="sm:col-span-2"
              hint={headersError || '例如组织 ID，一般留空'}
            >
              <input
                className={cn('field mono text-[11px]', headersError && 'border-danger/60')}
                value={headersText}
                placeholder='{"X-Custom-Header":"value"}'
                spellCheck={false}
                onChange={(event) => {
                  const text = event.target.value
                  setHeadersText(text)
                  if (!text.trim()) {
                    setHeadersError('')
                    onUpdate({ extraHeaders: {} })
                    return
                  }
                  try {
                    const parsed = JSON.parse(text) as unknown
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                      setHeadersError('需要一个 JSON 对象，例如 {"OpenAI-Organization":"org_xxx"}')
                      return
                    }
                    const headers: Record<string, string> = {}
                    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
                      headers[key] = String(value)
                    }
                    setHeadersError('')
                    onUpdate({ extraHeaders: headers })
                  } catch {
                    setHeadersError('JSON 格式错误，保存时会忽略这项')
                  }
                }}
              />
            </FieldGroup>
          </div>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-2 rounded-b-xl border-t border-line/80 bg-bg-soft/40 px-3 py-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void runTest()}
          disabled={testing}
          icon={testing ? <LoaderCircle size={11} className="animate-spin" /> : <Zap size={11} />}
        >
          {testing ? '测试中…' : '测试连接'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onLoadModels}
          disabled={slot?.loading}
          icon={slot?.loading ? <LoaderCircle size={11} className="animate-spin" /> : <Download size={11} />}
        >
          读取模型
        </Button>
        {testResult && (
          <StatusLine
            tone={testResult.ok ? 'success' : 'danger'}
            icon={testResult.ok ? <Check size={10} /> : <X size={10} />}
          >
            {testResult.ok ? '连接成功' : '连接失败'}
            {typeof testResult.latencyMs === 'number' ? ` · ${testResult.latencyMs}ms` : ''}
            {testResult.message ? ` · ${testResult.message}` : ''}
          </StatusLine>
        )}
        {testError && (
          <StatusLine tone="danger" icon={<X size={10} />}>
            {testError}
          </StatusLine>
        )}
        {!testResult && !testError && !testing && (
          <span className="text-[10.5px] text-ink-4">改完记得点右下角「保存」</span>
        )}
      </footer>
    </section>
  )
}
