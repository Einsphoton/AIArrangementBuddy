/**
 * 命令面板（⌘K / Ctrl+K）
 *
 * 参考 REAPER 的 Action List、Logic 的 Key Commands 窗口、以及现代编辑器的 Spotlight 交互：
 * - 一处搜索全部可执行命令，不需要先知道它在哪个菜单里；
 * - 键盘优先：↑↓ 选择、↵ 执行、Esc 关闭、Tab 切换分组过滤；
 * - 空查询时按分组展示，并给出「最近使用」，降低重复操作成本；
 * - 命令来源是 lib/commands.ts，与帮助页/工具栏同源，避免文案与行为漂移。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CornerDownLeft, Search, X } from 'lucide-react'
import { COMMAND_GROUP_ORDER, isCommandEnabled, primaryShortcut, searchCommands, type CommandDef } from '../../lib/commands'
import { formatCombo } from '../../lib/shortcuts'
import { cn } from '../../lib/format'
import { Kbd } from '../../components/ui/menu'

const RECENT_KEY = 'aiab:recent-commands:v1'
const MAX_RECENT = 5

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, MAX_RECENT) : []
  } catch {
    return []
  }
}

function pushRecent(id: string): void {
  try {
    const next = [id, ...readRecent().filter((item) => item !== id)].slice(0, MAX_RECENT)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
}

/** 把命令按分组切成带分组标题的渲染项 */
type Row =
  | { kind: 'group'; label: string; key: string }
  | { kind: 'command'; command: CommandDef; index: number; key: string }

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [recent, setRecent] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    setRecent(readRecent())
    const timer = setTimeout(() => inputRef.current?.focus(), 20)
    return () => clearTimeout(timer)
  }, [open])

  const results = useMemo(() => searchCommands(query), [query])

  /** 渲染项：空查询时顶部单独一段「最近使用」，其余按分组 */
  const rows = useMemo<Row[]>(() => {
    const list: Row[] = []
    let index = 0
    const recentCommands = query.trim()
      ? []
      : recent
          .map((id) => results.find((command) => command.id === id))
          .filter((command): command is CommandDef => Boolean(command))
    const recentIds = new Set(recentCommands.map((command) => command.id))

    if (recentCommands.length > 0) {
      list.push({ kind: 'group', label: '最近使用', key: 'group:recent' })
      for (const command of recentCommands) {
        list.push({ kind: 'command', command, index: index++, key: `recent:${command.id}` })
      }
    }

    let lastGroup = ''
    for (const command of results) {
      if (recentIds.has(command.id)) continue
      if (command.group !== lastGroup) {
        lastGroup = command.group
        list.push({ kind: 'group', label: command.group, key: `group:${command.group}` })
      }
      list.push({ kind: 'command', command, index: index++, key: command.id })
    }
    return list
  }, [query, recent, results])

  const flatCommands = useMemo(() => rows.filter((row): row is Extract<Row, { kind: 'command' }> => row.kind === 'command'), [rows])

  useEffect(() => {
    if (!open) return
    setActiveIndex((index) => Math.min(Math.max(0, index), Math.max(0, flatCommands.length - 1)))
  }, [open, flatCommands.length])

  useEffect(() => {
    const element = listRef.current?.querySelector<HTMLElement>(`[data-command-index="${activeIndex}"]`)
    element?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const runCommand = (command: CommandDef) => {
    if (!isCommandEnabled(command)) return
    pushRecent(command.id)
    onClose()
    // 让浮层先关闭，再执行带弹窗/焦点的命令，避免互相抢焦点
    setTimeout(() => {
      void command.run()
    }, 10)
  }

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
        event.preventDefault()
        setActiveIndex((index) => (index + 1) % Math.max(1, flatCommands.length))
        return
      }
      if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
        event.preventDefault()
        setActiveIndex((index) => (index - 1 + Math.max(1, flatCommands.length)) % Math.max(1, flatCommands.length))
        return
      }
      if (event.key === 'Enter') {
        const row = flatCommands[activeIndex]
        if (row) {
          event.preventDefault()
          runCommand(row.command)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeIndex, flatCommands])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-black/55 px-4 pt-[12vh] backdrop-blur-[3px]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label="命令面板"
    >
      <div className="w-full max-w-[600px] overflow-hidden rounded-[14px] border border-line-strong bg-surface shadow-[0_40px_120px_-24px_rgba(0,0,0,0.98)] animate-fade-up">
        {/* 搜索框 */}
        <div className="flex h-[52px] items-center gap-2.5 border-b border-line px-4">
          <Search size={15} className="shrink-0 text-ink-3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            placeholder="搜索命令、功能或设置…"
            className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-4"
            aria-label="搜索命令"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="hidden shrink-0 items-center gap-1 text-[10px] text-ink-4 sm:flex">
            <Kbd>Esc</Kbd>
            关闭
          </span>
          <button
            className="shrink-0 rounded-md p-1 text-ink-4 transition-colors hover:bg-surface-3 hover:text-ink-2 sm:hidden"
            onClick={onClose}
            aria-label="关闭命令面板"
          >
            <X size={14} />
          </button>
        </div>

        {/* 结果列表 */}
        <div ref={listRef} className="max-h-[min(440px,54vh)] overflow-y-auto py-1.5">
          {flatCommands.length === 0 && (
            <div className="flex flex-col items-center gap-1 px-6 py-10 text-center">
              <span className="text-[12.5px] text-ink-2">没有找到匹配的命令</span>
              <span className="text-[11.5px] text-ink-4">试试「播放」「量化」「导出」「混音」等关键词</span>
            </div>
          )}
          {flatCommands.length > 0 &&
            rows.map((row) => {
              if (row.kind === 'group') {
                const label = row.label
                return (
                  <div
                    key={row.key}
                    className="px-3.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-4"
                  >
                    {label}
                  </div>
                )
              }
              const command = row.command
              const active = row.index === activeIndex
              const Icon = command.icon
              const shortcut = primaryShortcut(command)
              return (
                <button
                  key={row.key}
                  data-command-index={row.index}
                  role="menuitem"
                  onPointerMove={() => setActiveIndex(row.index)}
                  onClick={() => runCommand(command)}
                  className={cn(
                    'flex h-[38px] w-full items-center gap-2.5 px-3 text-left transition-colors',
                    active ? 'bg-accent/12 text-ink' : 'text-ink-2 hover:bg-surface-2',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] border',
                      active ? 'border-accent/45 bg-accent/14 text-accent' : 'border-line bg-surface-2 text-ink-3',
                    )}
                  >
                    {Icon ? <Icon size={13} /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium">{command.title}</span>
                    {command.subtitle && <span className="block truncate text-[10.5px] text-ink-4">{command.subtitle}</span>}
                  </span>
                  {shortcut && (
                    <span className="flex shrink-0 items-center gap-0.5">
                      {formatCombo(shortcut).map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </span>
                  )}
                  {active && <CornerDownLeft size={12} className="shrink-0 text-accent/80" />}
                </button>
              )
            })}
        </div>

        {/* 底部提示 */}
        <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[10.5px] text-ink-4">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            选择
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd>
            执行
          </span>
          <span className="flex items-center gap-1">
            <Kbd>{formatCombo('mod+k')[0]}</Kbd>
            <Kbd>K</Kbd>
            随时呼出
          </span>
          <span className="ml-auto">{COMMAND_GROUP_ORDER.length} 类命令</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
