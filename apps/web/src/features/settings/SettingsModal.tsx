import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AudioLines,
  Bot,
  Check,
  Globe,
  LoaderCircle,
  Palette,
  RefreshCw,
  RotateCcw,
  Save,
  Terminal,
  TriangleAlert,
} from 'lucide-react'
import { createDefaultSettings, deepClone, type AppSettings } from '@aiab/core'
import { Button, Modal } from '../../components/ui'
import { getHealth, getSettings, saveSettings } from '../../lib/api'
import { useStore } from '../../store/store'
import { cn } from '../../lib/format'
import { AiProvidersSection } from './AiProvidersSection'
import { SearchSection } from './SearchSection'
import { AgentSection, type AgentProbeInfo } from './AgentSection'
import { AudioSection } from './AudioSection'
import { UiSection } from './UiSection'
import { mergeSecrets } from './secretMerge'
import { StatusLine, describeRequestError } from './shared'

type TabId = 'ai' | 'search' | 'agent' | 'audio' | 'ui'

const TABS: {
  id: TabId
  label: string
  description: string
  /** 右侧内容顶部的一句话说明 */
  summary: string
  icon: typeof Bot
}[] = [
  {
    id: 'ai',
    label: 'AI 服务商',
    description: '模型与 API Key',
    summary: '选择内置 Agent 使用的模型服务商，配置 API Key 与生成参数；密钥只保存在本机。',
    icon: Bot,
  },
  {
    id: 'search',
    label: '联网搜索',
    description: '搜索服务商',
    summary: '让 AI 在编曲前检索参考信息；不配置也能正常编曲，只是不能联网。',
    icon: Globe,
  },
  {
    id: 'agent',
    label: 'Agent 后端',
    description: '内置 / Codex / DSH',
    summary: '决定对话由内置 Agent 还是本机 Codex / DeepSeek Harness 执行，并控制执行权限与超时。',
    icon: Terminal,
  },
  {
    id: 'audio',
    label: '音频',
    description: '音色库与 MIDI',
    summary: '音色库、MIDI 输入与主音量；这些改动会影响试听与录入手感。',
    icon: AudioLines,
  },
  {
    id: 'ui',
    label: '界面',
    description: '主题与视图',
    summary: '主题、网格与小地图等显示偏好，只影响本机界面。',
    icon: Palette,
  },
]

/** 设置：AI 服务商 / 联网搜索 / Agent 后端 / 音频 / 界面。 */
export function SettingsModal() {
  const open = useStore((s) => s.settingsOpen)
  const setOpen = useStore((s) => s.setSettingsOpen)
  const pushToast = useStore((s) => s.pushToast)

  const [tab, setTab] = useState<TabId>('ai')
  const [draft, setDraft] = useState<AppSettings | null>(null)
  const [loaded, setLoaded] = useState<AppSettings | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [clearedKeys, setClearedKeys] = useState<string[]>([])
  const [resetArmed, setResetArmed] = useState(false)
  const [reloadArmed, setReloadArmed] = useState(false)
  /** 关闭时若有未保存修改：显示放弃确认 */
  const [confirmClose, setConfirmClose] = useState(false)
  /** 已经确认关闭 / 保存成功：避免「重开确认」逻辑再次弹回 */
  const closingRef = useRef(false)

  const [agents, setAgents] = useState<AgentProbeInfo[] | null>(null)
  const [probing, setProbing] = useState(false)
  const [probeError, setProbeError] = useState<string | null>(null)
  const [probedAt, setProbedAt] = useState<number | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  /** 切换分区 / 重新打开时把弹窗内容滚回顶部，避免停在上一页的中间位置 */
  const scrollToTop = useCallback(() => {
    const body = contentRef.current?.closest('[data-modal-body]')
    if (body instanceof HTMLElement) body.scrollTop = 0
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    setSaveError(null)
    try {
      const settings = await getSettings()
      setDraft(settings)
      setLoaded(settings)
      setClearedKeys([])
    } catch (error) {
      setDraft(createDefaultSettings())
      setLoaded(null)
      setLoadError(describeRequestError(error))
    } finally {
      setLoading(false)
    }
  }, [])

  const probeAgents = useCallback(async () => {
    setProbing(true)
    setProbeError(null)
    try {
      const health = await getHealth()
      setAgents(health.agents ?? [])
      setProbedAt(Date.now())
    } catch (error) {
      setAgents(null)
      setProbeError(describeRequestError(error))
    } finally {
      setProbing(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    closingRef.current = false
    setConfirmClose(false)
    setReloadArmed(false)
    setResetArmed(false)
    void load()
    void probeAgents()
    scrollToTop()
  }, [open, load, probeAgents, scrollToTop])

  const selectTab = useCallback(
    (next: TabId) => {
      setTab(next)
      scrollToTop()
    },
    [scrollToTop],
  )

  const update = useCallback((recipe: (next: AppSettings) => void) => {
    setDraft((prev) => {
      if (!prev) return prev
      const next = deepClone(prev)
      recipe(next)
      return next
    })
  }, [])

  const dirty = useMemo(() => {
    if (!draft || !loaded) return false
    return JSON.stringify(mergeSecrets(draft, loaded, clearedKeys)) !== JSON.stringify(loaded)
  }, [draft, loaded, clearedKeys])

  /** 每个分区是否各自有未保存修改（左侧导航显示小圆点） */
  const tabDirty = useMemo<Record<TabId, boolean>>(() => {
    const clean: Record<TabId, boolean> = { ai: false, search: false, agent: false, audio: false, ui: false }
    if (!draft || !loaded) return clean
    const merged = mergeSecrets(draft, loaded, clearedKeys)
    const slice = (value: AppSettings): Record<TabId, unknown> => ({
      ai: { providers: value.providers, activeProviderId: value.activeProviderId },
      search: value.search,
      agent: value.agent,
      audio: value.audio,
      ui: value.ui,
    })
    const next = slice(merged)
    const prev = slice(loaded)
    for (const id of Object.keys(clean) as TabId[]) {
      clean[id] = JSON.stringify(next[id]) !== JSON.stringify(prev[id])
    }
    return clean
  }, [draft, loaded, clearedKeys])

  /** 真正关闭（已确认放弃修改 / 保存成功） */
  const doClose = useCallback(() => {
    closingRef.current = true
    setConfirmClose(false)
    setResetArmed(false)
    setReloadArmed(false)
    setSaveError(null)
    setOpen(false)
  }, [setOpen])

  /** 关闭请求：有未保存修改时先确认，避免误丢配置 */
  const requestClose = useCallback(() => {
    if (saving) return
    if (dirty) {
      setConfirmClose(true)
      return
    }
    doClose()
  }, [dirty, saving, doClose])

  /**
   * Esc 关闭（捕获阶段）：App.tsx 的全局 Esc 会直接 setSettingsOpen(false)，
   * 绕过「未保存修改」确认并丢掉草稿。这里在事件到达 window 之前先接管：
   * - 有未保存修改 → 只显示放弃确认，不关闭；
   * - 模型选择等嵌套弹层自己处理 Esc（target 在弹层里）→ 不拦截。
   */
  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target && (target.closest('[data-model-picker-popup]') || target.closest('[role="listbox"]'))) return
      event.stopPropagation()
      requestClose()
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [open, requestClose])

  /**
   * App.tsx 的全局 Esc 会直接 `setSettingsOpen(false)`（绕过 Modal 的 onClose）。
   * 这里在「有未保存修改却被关掉」时把确认流程补回来：重新打开并显示放弃确认。
   */
  useEffect(() => {
    if (open || saving) return
    if (closingRef.current) return
    if (!draft || !loaded || !dirty) return
    setOpen(true)
    setConfirmClose(true)
  }, [open, saving, draft, loaded, dirty, setOpen])

  const requestReload = () => {
    if (!dirty) {
      void load()
      return
    }
    if (!reloadArmed) {
      setReloadArmed(true)
      window.setTimeout(() => setReloadArmed(false), 3200)
      return
    }
    setReloadArmed(false)
    void load()
  }

  const handleSave = async () => {    if (!draft || !loaded) return
    setSaving(true)
    setSaveError(null)
    try {
      await saveSettings(mergeSecrets(draft, loaded, clearedKeys))
      try {
        const fresh = await getSettings()
        setDraft(fresh)
        setLoaded(fresh)
      } catch {
        /* 保存成功但回读失败：保持当前草稿 */
      }
      setClearedKeys([])
      setConfirmClose(false)
      pushToast('success', '设置已保存')
      window.dispatchEvent(new CustomEvent('aiab:settings-saved'))
      closingRef.current = true
      setOpen(false)
    } catch (error) {
      const text = `保存失败：${describeRequestError(error)}`
      setSaveError(text)
      pushToast('error', text)
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    if (!resetArmed) {
      setResetArmed(true)
      window.setTimeout(() => setResetArmed(false), 3200)
      return
    }
    setDraft(createDefaultSettings())
    setClearedKeys([])
    setResetArmed(false)
    pushToast('info', '已恢复默认设置，点击「保存」后生效')
  }

  const handleClose = requestClose

  const currentTab = TABS.find((item) => item.id === tab) ?? TABS[0]
  const CurrentTabIcon = currentTab.icon

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="设置"
      subtitle="AI 服务商、联网搜索、Agent 后端、音频与界面偏好。所有配置都只保存在本机。"
      width="xl"
      footer={
        <div className="flex w-full items-center gap-2">
          <div className="mr-auto flex min-w-0 items-center gap-2">
            {confirmClose ? (
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/8 px-2 py-1">
                <TriangleAlert size={11} className="shrink-0 text-accent" />
                <span className="text-[10.5px] text-accent-soft">有未保存的修改，关闭后会丢失</span>
                <button
                  className="flex h-6 items-center gap-1 rounded-md border border-danger/45 bg-danger/10 px-2 text-[10.5px] text-danger hover:bg-danger/16"
                  onClick={doClose}
                  title="放弃修改并关闭设置"
                >
                  放弃修改
                </button>
                <button
                  className="flex h-6 items-center gap-1 rounded-md border border-line-strong bg-surface-2 px-2 text-[10.5px] text-ink-2 hover:text-ink"
                  onClick={() => setConfirmClose(false)}
                  title="回到设置继续编辑"
                >
                  继续编辑
                </button>
              </div>
            ) : loadError ? (
              <StatusLine tone="danger" icon={<TriangleAlert size={10} />}>
                无法读取服务端设置，保存已禁用
              </StatusLine>
            ) : saveError ? (
              <StatusLine tone="danger" icon={<TriangleAlert size={10} />}>
                {saveError}
              </StatusLine>
            ) : dirty ? (
              <StatusLine tone="accent" icon={<span className="h-1.5 w-1.5 rounded-full bg-accent" />}>
                有未保存的修改
              </StatusLine>
            ) : (
              <StatusLine tone="neutral" icon={<Check size={10} />}>
                设置已同步
              </StatusLine>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReset}
            disabled={saving || !draft}
            icon={<RotateCcw size={11} />}
            title="把所有设置恢复为默认值（保存后生效）"
          >
            {resetArmed ? '确认恢复默认？' : '恢复默认'}
          </Button>
          {/* 放弃确认条里已经有「继续编辑 / 放弃修改」，这里不再重复同一组操作 */}
          {!confirmClose && (
            <Button size="sm" onClick={handleClose} disabled={saving}>
              取消
            </Button>
          )}
          <Button
            variant="accent"
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving || loading || !draft || !loaded}
            icon={saving ? <LoaderCircle size={11} className="animate-spin" /> : <Save size={11} />}
            title={loaded ? '保存到本机 data/settings.json' : '后端未连接，无法保存'}
          >
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      }
    >
      <div className="flex gap-4">
        {/* 左侧 tab */}
        <aside className="sticky top-0 flex w-[148px] shrink-0 flex-col gap-0.5 self-start" aria-label="设置分区">
          {TABS.map((item) => {
            const Icon = item.icon
            const active = tab === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => selectTab(item.id)}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors',
                  active
                    ? 'border-accent/40 bg-accent/10 text-ink'
                    : 'border-transparent text-ink-3 hover:bg-surface-2/70 hover:text-ink-2',
                )}
                aria-current={active ? 'page' : undefined}
                title={tabDirty[item.id] ? `${item.label}：有未保存的修改` : item.label}
              >
                <span className={cn('shrink-0', active ? 'text-accent' : 'text-ink-4')}>
                  <Icon size={13} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[12px] font-medium">{item.label}</span>
                    {tabDirty[item.id] && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label="有未保存的修改" />
                    )}
                  </span>
                  <span className="block truncate text-[10px] text-ink-4">{item.description}</span>
                </span>
              </button>
            )
          })}
          <div className="mt-2 flex items-center gap-1 px-2 text-[10.5px] text-ink-4">
            <RefreshCw size={10} />
            <button
              type="button"
              className={cn('hover:text-ink-2', reloadArmed && 'text-accent-soft')}
              onClick={requestReload}
              disabled={loading}
              title={dirty ? '有未保存修改，点击两次确认丢弃并重新读取' : '从服务端重新读取设置'}
            >
              {reloadArmed ? '确认丢弃修改？' : '重新读取设置'}
            </button>
          </div>
        </aside>

        {/* 右侧内容 */}
        <div ref={contentRef} className="min-h-[480px] min-w-0 flex-1 pb-8">
          {/* 分区顶部：一句话说明 + 脏标记 */}
          <div className="mb-3 flex items-start gap-2 border-b border-line/70 pb-2.5">
            <span className="mt-[1px] shrink-0 text-accent/80">
              <CurrentTabIcon size={13} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="text-[12.5px] font-semibold tracking-tight text-ink">{currentTab.label}</h3>
                {tabDirty[currentTab.id] && (
                  <span className="rounded border border-accent/40 bg-accent/10 px-1 py-[1px] text-[9.5px] text-accent-soft">
                    未保存
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">{currentTab.summary}</p>
            </div>
          </div>

          {loadError && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-danger/35 bg-danger/8 px-3 py-2">
              <TriangleAlert size={12} className="mt-[1px] shrink-0 text-danger" />
              <div className="text-[11px] leading-relaxed text-ink-2">
                <div className="font-medium text-danger">后端未连接</div>
                <div className="mt-0.5 text-ink-3">
                  当前显示的是默认设置，为避免覆盖已有配置，保存已被禁用。请在项目根目录运行{' '}
                  <code className="mono rounded bg-black/30 px-1 text-[10.5px] text-accent-soft">pnpm dev</code>{' '}
                  后点击「重新读取设置」。
                </div>
                <div className="mt-1 text-[10px] text-ink-4">{loadError}</div>
              </div>
            </div>
          )}

          {loading || !draft ? (
            <SettingsSkeleton />
          ) : tab === 'ai' ? (
            <AiProvidersSection
              draft={draft}
              loaded={loaded}
              update={update}
              clearedKeys={clearedKeys}
              onClearKey={(id) => setClearedKeys((prev) => (prev.includes(id) ? prev : [...prev, id]))}
              onRestoreKey={(id) => setClearedKeys((prev) => prev.filter((item) => item !== id))}
            />
          ) : tab === 'search' ? (
            <SearchSection
              draft={draft}
              loaded={loaded}
              update={update}
              clearedKeys={clearedKeys}
              onClearKey={() => undefined}
              onRestoreKey={() => undefined}
            />
          ) : tab === 'agent' ? (
            <AgentSection
              draft={draft}
              loaded={loaded}
              update={update}
              clearedKeys={clearedKeys}
              onClearKey={() => undefined}
              onRestoreKey={() => undefined}
              agents={agents}
              probing={probing}
              probeError={probeError}
              probedAt={probedAt}
              onProbe={() => void probeAgents()}
            />
          ) : tab === 'audio' ? (
            <AudioSection
              draft={draft}
              loaded={loaded}
              update={update}
              clearedKeys={clearedKeys}
              onClearKey={() => undefined}
              onRestoreKey={() => undefined}
            />
          ) : (
            <UiSection
              draft={draft}
              loaded={loaded}
              update={update}
              clearedKeys={clearedKeys}
              onClearKey={() => undefined}
              onRestoreKey={() => undefined}
            />
          )}
        </div>
      </div>
    </Modal>
  )
}

function SettingsSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((index) => (
        <div key={index} className="rounded-xl border border-line bg-surface-2/40">
          <div className="border-b border-line/80 px-3.5 py-3">
            <div className="shimmer h-3 w-32 rounded" />
            <div className="shimmer mt-2 h-2.5 w-64 rounded" />
          </div>
          <div className="space-y-2 px-3.5 py-3">
            <div className="shimmer h-8 w-full rounded-lg" />
            <div className="shimmer h-8 w-full rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  )
}
