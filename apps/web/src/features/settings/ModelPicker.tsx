import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, LoaderCircle, RefreshCw, Search, Sparkles, Wrench, X } from 'lucide-react'
import type { ProviderModelInfo } from '../../lib/api'
import { cn } from '../../lib/format'

export interface ModelPickerProps {
  value: string
  models: ProviderModelInfo[]
  loading?: boolean
  error?: string
  warning?: string
  /** 拉取/刷新模型列表 */
  onRefresh: () => void
  /** 打开下拉时调用（用于懒加载） */
  onOpen?: () => void
  /** 预设推荐模型（还没拉到列表时也能点选） */
  recommended?: string[]
  onChange: (model: string) => void
  disabled?: boolean
  placeholder?: string
}

interface ScoredModel {
  info: ProviderModelInfo
  score: number
}

function scoreModel(info: ProviderModelInfo, tokens: string[]): number {
  if (tokens.length === 0) return 1
  const id = info.id.toLowerCase()
  const name = (info.name ?? '').toLowerCase()
  let score = 0
  for (const token of tokens) {
    const inId = id.includes(token)
    const inName = name.includes(token)
    if (!inId && !inName) return -1
    if (id === token) score += 100
    else if (id.startsWith(token)) score += 40
    else if (name.startsWith(token)) score += 25
    else if (inId) score += 12
    else score += 6
  }
  if (info.free) score += 3
  if (info.tools) score += 2
  return score
}

/** 高亮匹配片段 */
function Highlight({ text, query }: { text: string; query: string }) {
  const keyword = query.trim().split(/\s+/)[0]
  if (!keyword) return <>{text}</>
  const index = text.toLowerCase().indexOf(keyword.toLowerCase())
  if (index < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-[2px] bg-accent/25 px-[1px] text-accent-soft">{text.slice(index, index + keyword.length)}</mark>
      {text.slice(index + keyword.length)}
    </>
  )
}

function formatContext(tokens?: number): string | null {
  if (!tokens || tokens < 1000) return null
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M 上下文`
  return `${Math.round(tokens / 1000)}K 上下文`
}

/**
 * 模型选择器：可搜索、可键盘操作、可手动输入任意模型 ID。
 * 模型列表来自服务商的 /models 接口（含上下文长度、是否支持工具/免费等元数据）。
 */
export function ModelPicker({
  value,
  models,
  loading,
  error,
  warning,
  onRefresh,
  onOpen,
  recommended = [],
  onChange,
  disabled,
  placeholder = '选择或输入模型 ID',
}: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [anchor, setAnchor] = useState<{
    left: number
    width: number
    top?: number
    bottom?: number
    maxHeight: number
  } | null>(null)
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  const current = models.find((model) => model.id === value)

  const filtered = useMemo<ScoredModel[]>(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!tokens.length) return models.map((info) => ({ info, score: info.id === value ? 200 : info.free ? 2 : 1 }))
    return models
      .map((info) => ({ info, score: scoreModel(info, tokens) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.info.id.localeCompare(b.info.id))
  }, [models, query, value])

  const suggestions = useMemo(() => {
    if (models.length) return []
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return recommended
      .filter((id) => tokens.length === 0 || tokens.every((token) => id.toLowerCase().includes(token)))
      .map((id) => ({ info: { id } as ProviderModelInfo, score: 0 }))
  }, [models, recommended, query])

  const rows = models.length ? filtered : suggestions
  const exactExists = models.some((model) => model.id.toLowerCase() === query.trim().toLowerCase())

  /* 定位：跟随触发按钮；空间不足时向上展开，并按可用空间限制高度。
     触发按钮可能被滚到弹窗可视区外（设置页很长），先滚进视野再测量。 */
  useEffect(() => {
    if (!open) return
    rootRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const margin = 8
      const preferredHeight = 344
      const spaceBelow = window.innerHeight - rect.bottom - margin
      const spaceAbove = rect.top - margin
      const openUp = spaceBelow < preferredHeight && spaceAbove > spaceBelow
      const maxHeight = Math.max(180, Math.min(preferredHeight, openUp ? spaceAbove : spaceBelow))
      setAnchor({
        left: Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - rect.width - margin)),
        width: rect.width,
        maxHeight,
        ...(openUp ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  /* 点击外部关闭（portal 内的点击不算外部） */
  useEffect(() => {
    if (!open) return
    const handler = (event: MouseEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target)) return
      if (popupRef.current?.contains(target)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [open])

  /* 打开时聚焦并重置 */
  useEffect(() => {
    if (!open) return
    setQuery('')
    setHighlight(0)
    onOpen?.()
    const timer = setTimeout(() => inputRef.current?.focus(), 30)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /* 高亮项滚动到可视区 */
  useEffect(() => {
    if (!open) return
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [highlight, open])

  const select = (model: string) => {
    const next = model.trim()
    if (!next) return
    onChange(next)
    setOpen(false)
    setQuery('')
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlight((index) => Math.min(index + 1, Math.max(0, rows.length - 1)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight((index) => Math.max(0, index - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const target = rows[highlight]?.info.id
      if (target) select(target)
      else if (query.trim()) select(query)
    } else if (event.key === 'Escape') {
      /* 只关闭这个下拉：阻止事件继续冒泡去关闭整个设置对话框 */
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
  }

  const badge = (info?: ProviderModelInfo) => {
    if (!info) return null
    const ctx = formatContext(info.contextLength)
    return (
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {info.free && (
          <span className="rounded border border-success/40 bg-success/10 px-1 text-[9.5px] font-medium text-success">免费</span>
        )}
        {info.tools && (
          <span
            className="flex items-center gap-0.5 rounded border border-violet/40 bg-violet/10 px-1 text-[9.5px] font-medium text-violet"
            title="支持工具调用（AI 编曲需要）"
          >
            <Wrench size={8} />
            工具
          </span>
        )}
        {ctx && <span className="hidden text-[9.5px] text-ink-4 sm:inline">{ctx}</span>}
      </span>
    )
  }

  return (
    <div className="relative" ref={rootRef}>
      {/* 触发按钮 */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        aria-label="选择模型"
        aria-expanded={open}
        title={value || placeholder}
        className={cn(
          'field flex h-8 w-full items-center gap-2 pr-2 text-left transition-colors',
          open && 'border-accent/60 bg-surface-2',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <span className={cn('min-w-0 flex-1 truncate font-mono text-[12px]', !value && 'text-ink-4')}>
          {value || placeholder}
        </span>
        {current && <span className="hidden items-center gap-1 sm:flex">{badge(current)}</span>}
        {loading ? (
          <LoaderCircle size={11} className="shrink-0 animate-spin text-accent" />
        ) : (
          <ChevronDown size={12} className={cn('shrink-0 text-ink-4 transition-transform', open && 'rotate-180')} />
        )}
      </button>

      {open &&
        anchor &&
        createPortal(
          <div
            ref={popupRef}
            data-model-picker-popup
            style={{
              position: 'fixed',
              left: anchor.left,
              width: anchor.width,
              top: anchor.top,
              bottom: anchor.bottom,
              maxHeight: anchor.maxHeight,
            }}
            className="z-[80] flex flex-col overflow-hidden rounded-xl border border-line-strong bg-surface-2 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.9)]"
          >
          {/* 搜索框 */}
          <div className="flex shrink-0 items-center gap-2 border-b border-line/80 px-2.5 py-1.5">
            <Search size={12} className="shrink-0 text-ink-4" />
            <input
              ref={inputRef}
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-ink-4"
              placeholder={models.length ? `在 ${models.length} 个模型中搜索…` : '搜索模型（可手动输入）'}
              aria-label="搜索模型"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setHighlight(0)
              }}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              autoComplete="off"
            />
            {query && (
              <button
                className="rounded p-0.5 text-ink-4 hover:text-ink-2"
                onClick={() => {
                  setQuery('')
                  setHighlight(0)
                  inputRef.current?.focus()
                }}
                aria-label="清空搜索"
              >
                <X size={11} />
              </button>
            )}
            <button
              className="rounded p-0.5 text-ink-4 hover:text-accent"
              onClick={(event) => {
                event.stopPropagation()
                onRefresh()
              }}
              title="重新拉取模型列表"
              aria-label="刷新模型列表"
            >
              <RefreshCw size={11} className={cn(loading && 'animate-spin')} />
            </button>
          </div>

          {/* 列表 */}
          <div
            ref={listRef}
            className="min-h-0 flex-1 overflow-y-auto py-1"
            role="listbox"
            aria-label="模型列表"
            style={{ maxHeight: Math.max(120, anchor.maxHeight - 92) }}
          >
            {loading && rows.length === 0 && (
              <div className="flex items-center gap-2 px-3 py-4 text-[11.5px] text-ink-3">
                <LoaderCircle size={12} className="animate-spin text-accent" />
                正在读取服务商的模型列表…
              </div>
            )}

            {!loading && error && (
              <div className="px-3 py-3">
                <p className="text-[11px] leading-relaxed text-danger">{error}</p>
                <p className="mt-1 text-[10.5px] leading-relaxed text-ink-4">
                  仍可直接手动输入模型 ID；部分服务商需要先填 API Key 才能读取模型列表。
                </p>
              </div>
            )}

            {rows.map((row, index) => {
              const info = row.info
              const active = info.id === value
              return (
                <button
                  key={info.id}
                  data-index={index}
                  role="option"
                  aria-selected={active}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors',
                    index === highlight ? 'bg-surface-4/80' : 'hover:bg-surface-3/70',
                    active && 'bg-accent/10',
                  )}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => select(info.id)}
                  title={info.description ?? info.id}
                >
                  <span className={cn('shrink-0', active ? 'text-accent' : 'text-transparent')}>
                    <Check size={11} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[12px] text-ink">
                      <Highlight text={info.id} query={query} />
                    </span>
                    {(info.name || info.description) && (
                      <span className="mt-0.5 block truncate text-[10.5px] text-ink-4">
                        {info.name && info.name !== info.id ? `${info.name} · ` : ''}
                        {info.description ?? ''}
                      </span>
                    )}
                  </span>
                  {badge(info)}
                </button>
              )
            })}

            {/* 自定义值 */}
            {query.trim() && !exactExists && (
              <button
                className="flex w-full items-center gap-2 border-t border-line/70 px-3 py-2 text-left hover:bg-surface-3/70"
                onClick={() => select(query)}
              >
                <Sparkles size={11} className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink">
                  使用自定义模型 <span className="font-mono text-accent-soft">{query.trim()}</span>
                </span>
              </button>
            )}

            {!loading && !error && rows.length === 0 && !query.trim() && (
              <div className="px-3 py-4 text-[11.5px] leading-relaxed text-ink-3">
                还没有模型列表。点右上角刷新读取服务商的 <span className="font-mono text-ink-2">/models</span>；
                也可以直接在上方输入模型 ID。
                {recommended.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {recommended.map((id) => (
                      <button
                        key={id}
                        className="chip h-5 font-mono text-[10px]"
                        onClick={() => select(id)}
                        title={`使用推荐模型 ${id}`}
                      >
                        {id}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 底部状态 */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-line/80 bg-bg-soft/60 px-2.5 py-1.5 text-[10.5px] text-ink-4">
            <span>
              {models.length ? `共 ${models.length} 个模型${query.trim() ? ` · 匹配 ${rows.length}` : ''}` : '未读取模型列表'}
            </span>
            <span className="truncate">{warning ? warning : '↑↓ 选择 · Enter 确认 · Esc 关闭'}</span>
          </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
