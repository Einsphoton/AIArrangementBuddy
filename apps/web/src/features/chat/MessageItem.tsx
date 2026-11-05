import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Brain,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  LoaderCircle,
  RotateCcw,
  Settings2,
  Sparkles,
  TriangleAlert,
  Undo2,
} from 'lucide-react'
import { useStore } from '../../store/store'
import type { ChatMessage, ToolCallInfo } from '../../store/types'
import { cn } from '../../lib/format'
import { prettyToolResult, summarizeArgs, summarizeToolResult, toolMeta } from './toolDisplay'
import { MarkdownLite } from './MarkdownLite'
import { formatElapsed, getMessageMetrics } from './chatMetrics'

interface MessageItemProps {
  message: ChatMessage
  /** 是否为最后一条助手消息（只有最后一条可以重新生成） */
  isLast?: boolean
  /** 是否有请求正在生成（生成中禁用重新生成） */
  busy?: boolean
  /** 失败后重发上一条请求 */
  onRetry: () => void
  /** 重新生成这一条回答 */
  onRegenerate?: () => void
  onOpenSettings: () => void
}

export function MessageItem({ message, isLast, busy, onRetry, onRegenerate, onOpenSettings }: MessageItemProps) {
  if (message.role === 'user') return <UserBubble message={message} />
  if (message.role === 'system') {
    return (
      <div className="my-1 flex justify-center">
        <span className="whitespace-pre-wrap rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-ink-3">
          {message.content}
        </span>
      </div>
    )
  }
  return (
    <AssistantMessage
      message={message}
      isLast={isLast}
      busy={busy}
      onRetry={onRetry}
      onRegenerate={onRegenerate}
      onOpenSettings={onOpenSettings}
    />
  )
}

/* ------------------------------------------------------------------ */
/* 复制按钮（带降级方案：非安全上下文也能用）                            */
/* ------------------------------------------------------------------ */

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 继续尝试降级方案 */
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* 用户气泡                                                            */
/* ------------------------------------------------------------------ */

function UserBubble({ message }: { message: ChatMessage }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const copy = async () => {
    if (!(await copyText(message.content))) return
    setCopied(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="group/user flex flex-col items-end gap-1">
      <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-[13px] rounded-br-[5px] border border-accent/25 bg-accent/12 px-3 py-2 text-[12.5px] leading-[1.65] text-ink [overflow-wrap:anywhere]">
        {message.content}
      </div>
      <div className="flex items-center gap-1.5 pr-1 text-[10px] text-ink-4">
        <button
          className="hidden h-5 w-5 items-center justify-center rounded-md border border-line bg-surface-2 text-ink-3 hover:text-ink group-hover/user:flex focus-visible:flex"
          title={copied ? '已复制' : '复制这条提问'}
          aria-label={copied ? '已复制' : '复制这条提问'}
          onClick={() => void copy()}
        >
          {copied ? <Check size={10} /> : <Copy size={10} />}
        </button>
        <span className="tabular-nums">{formatTime(message.createdAt)}</span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* AI 消息                                                             */
/* ------------------------------------------------------------------ */

function AssistantMessage({ message, isLast, busy, onRetry, onRegenerate, onOpenSettings }: MessageItemProps) {
  const [copied, setCopied] = useState(false)
  /** 消息级折叠：一键收起思考过程与工具调用详情 */
  const [detailsExpanded, setDetailsExpanded] = useState(true)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const hasBody = Boolean(message.content?.trim()) || Boolean(message.toolCalls?.length) || Boolean(message.reasoning?.trim())
  const hasDetails = Boolean(message.reasoning?.trim()) || Boolean(message.toolCalls?.length)
  const keyIssue = message.error ? /key|密钥|鉴权|401|403|unauthor|配置|服务商|api[\s-]?key/i.test(message.error) : false
  const elapsed = useLiveElapsed(message)
  const canRegenerate = Boolean(isLast) && !message.streaming && !busy && Boolean(onRegenerate) && Boolean(message.content?.trim() || message.toolCalls?.length)

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
  }, [])

  const copy = async () => {
    if (!(await copyText(message.content ?? ''))) return
    setCopied(true)
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="group/msg flex gap-2.5">
      <div className="mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[7px] border border-accent/30 bg-gradient-to-b from-accent/22 to-accent/5">
        <Sparkles size={11} className="text-accent" />
      </div>
      <div className="min-w-0 flex-1">
        {message.reasoning?.trim() ? (
          <ReasoningBlock text={message.reasoning} streaming={Boolean(message.streaming)} collapsed={!detailsExpanded} />
        ) : null}
        {message.toolCalls?.length ? (
          <div className="mb-2 mt-1.5 space-y-1.5">
            {message.toolCalls.map((call) => (
              <ToolCallCard key={call.id} call={call} collapsed={!detailsExpanded} />
            ))}
          </div>
        ) : null}

        {message.content?.trim() ? (
          <div className="relative">
            <MarkdownLite text={message.content} />
            {message.streaming && <StreamCaret />}
          </div>
        ) : message.streaming ? (
          <TypingDots />
        ) : null}

        {!hasBody && !message.error && !message.streaming ? (
          <p className="text-[11.5px] text-ink-3">（这一轮没有返回内容）</p>
        ) : null}

        {message.changedProject ? <ChangedProjectChip /> : null}

        {message.error ? (
          <div className="mt-2 rounded-lg border border-danger/35 bg-danger/8 px-2.5 py-2">
            <div className="flex items-start gap-1.5">
              <TriangleAlert size={12} className="mt-[2px] shrink-0 text-danger" />
              <p className="text-[11.5px] leading-relaxed text-ink-2">{message.error}</p>
            </div>
            <div className="mt-1.5 flex items-center gap-1.5">
              <button
                className="flex h-6 items-center gap-1 rounded-md border border-line-strong bg-surface-2 px-2 text-[11px] text-ink-2 hover:text-ink"
                onClick={onRetry}
                title="重新发送上一条提问"
              >
                <RotateCcw size={10} />
                重试
              </button>
              {keyIssue && (
                <button
                  className="flex h-6 items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-2 text-[11px] text-accent-soft hover:bg-accent/16"
                  onClick={onOpenSettings}
                >
                  <Settings2 size={10} />
                  配置 AI 服务商
                </button>
              )}
            </div>
          </div>
        ) : null}

        <MessageMeta message={message} elapsedMs={elapsed} />

        {/* 操作条：hover / 键盘聚焦时出现，避免常驻噪音 */}
        {!message.streaming && (hasBody || message.error) ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100">
            <ActionButton
              label={copied ? '已复制' : '复制回答'}
              title={copied ? '已复制到剪贴板' : '复制回答（纯文本）'}
              onClick={() => void copy()}
              disabled={!message.content?.trim()}
            >
              {copied ? <Check size={10} /> : <Copy size={10} />}
              <span>{copied ? '已复制' : '复制'}</span>
            </ActionButton>
            {canRegenerate ? (
              <ActionButton label="重新生成" title="用同一条提问重新生成回答（替换本条）" onClick={onRegenerate}>
                <RotateCcw size={10} />
                <span>重新生成</span>
              </ActionButton>
            ) : null}
            {hasDetails ? (
              <ActionButton
                label={detailsExpanded ? '收起详情' : '展开详情'}
                title={detailsExpanded ? '收起思考过程与工具调用' : '展开思考过程与工具调用'}
                onClick={() => setDetailsExpanded((value) => !value)}
              >
                <ChevronDown size={10} className={cn('transition-transform', !detailsExpanded && '-rotate-90')} />
                <span>{detailsExpanded ? '收起详情' : '展开详情'}</span>
              </ActionButton>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ActionButton({
  label,
  title,
  onClick,
  disabled,
  children,
}: {
  label: string
  title: string
  onClick?: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      className="flex h-[22px] items-center gap-1 rounded-md px-1.5 text-[10.5px] text-ink-4 transition-colors hover:bg-surface-3 hover:text-ink-2 disabled:cursor-not-allowed disabled:opacity-40"
      title={title}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

function MessageMeta({ message, elapsedMs }: { message: ChatMessage; elapsedMs: number | null }) {
  if (message.streaming) {
    return (
      <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-ink-4">
        <LoaderCircle size={9} className="animate-spin text-accent/80" />
        <span>生成中{elapsedMs ? ` · ${formatElapsed(elapsedMs)}` : '…'}</span>
      </div>
    )
  }
  const parts: string[] = []
  if (message.model) parts.push(message.model)
  if (elapsedMs) parts.push(`耗时 ${formatElapsed(elapsedMs)}`)
  if (message.changedProject) parts.push('工程已变更')
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] text-ink-4">
      {parts.map((part, index) => (
        <span key={part} className="flex min-w-0 max-w-full items-center gap-1.5">
          {index > 0 && <span className="h-2 w-px shrink-0 bg-line-strong" />}
          {index === 0 && <CheckCheck size={9} className="shrink-0 text-success/70" />}
          <span className="mono max-w-full truncate" title={part}>
            {part}
          </span>
        </span>
      ))}
      <span className="ml-auto tabular-nums">{formatTime(message.createdAt)}</span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 思考过程（可折叠）                                                   */
/* ------------------------------------------------------------------ */

function ReasoningBlock({ text, streaming, collapsed }: { text: string; streaming: boolean; collapsed: boolean }) {
  const [open, setOpen] = useState(streaming)
  const touchedRef = useRef(false)
  useEffect(() => {
    if (streaming) setOpen(true)
    else if (!touchedRef.current) setOpen(false)
  }, [streaming])
  const expanded = open && !collapsed
  return (
    <div className="mb-1.5">
      <button
        className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px] text-violet/90 transition-colors hover:bg-violet/10"
        onClick={() => {
          touchedRef.current = true
          setOpen((value) => !value)
        }}
        aria-expanded={expanded}
        title={expanded ? '收起思考过程' : '展开思考过程'}
      >
        <Brain size={11} className={streaming ? 'animate-pulse' : undefined} />
        <span>{streaming ? '正在思考…' : `思考过程 · ${text.trim().length} 字`}</span>
        <ChevronDown size={10} className={cn('transition-transform', expanded && 'rotate-180')} />
      </button>
      {expanded && (
        <div className="mt-1 max-h-52 overflow-y-auto whitespace-pre-wrap break-words border-l border-violet/25 pl-2.5 text-[11.5px] leading-[1.65] text-ink-3 [overflow-wrap:anywhere]">
          {text}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 工具调用卡片                                                        */
/* ------------------------------------------------------------------ */

function ToolCallCard({ call, collapsed }: { call: ToolCallInfo; collapsed: boolean }) {
  const meta = toolMeta(call.name)
  const Icon = meta.icon
  const [open, setOpen] = useState(false)
  const expanded = open && !collapsed
  const summary = summarizeArgs(call.args)
  const resultText = call.error || summarizeToolResult(call.result)
  const fullText = prettyToolResult(call.result)
  const duration = call.endedAt ? Math.max(1, Math.round((call.endedAt - call.startedAt) / 100) / 10) : null

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-surface-2/55 transition-colors',
        call.status === 'running'
          ? 'border-accent/30'
          : call.status === 'error'
            ? 'border-danger/30'
            : 'border-line',
      )}
    >
      <button
        className="flex w-full items-center gap-2 px-2.5 py-[7px] text-left hover:bg-surface-3/60"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={expanded}
        title={expanded ? '收起执行结果' : '展开执行结果'}
      >
        <span className={cn('shrink-0', meta.tone)}>
          <Icon size={12} />
        </span>
        <span className="max-w-[56%] shrink-0 truncate text-[11.5px] font-medium text-ink" title={call.title || meta.title}>
          {call.title || meta.title}
        </span>
        <span className="mono min-w-0 flex-1 truncate text-[10.5px] text-ink-4" title={summary || undefined}>
          {summary}
        </span>
        {duration !== null && <span className="shrink-0 text-[10px] tabular-nums text-ink-4">{duration}s</span>}
        <StatusPill status={call.status} />
        <ChevronRight size={10} className={cn('shrink-0 text-ink-4 transition-transform', expanded && 'rotate-90')} />
      </button>

      {expanded && (
        <div className="border-t border-line/70 bg-bg-soft/60 px-2.5 py-2">
          {call.error ? (
            <p className="text-[11px] leading-relaxed text-danger">{call.error}</p>
          ) : fullText ? (
            <pre className="mono max-h-44 overflow-auto whitespace-pre-wrap break-words text-[10.5px] leading-relaxed text-ink-2">
              {fullText}
            </pre>
          ) : (
            <p className="text-[11px] text-ink-3">{call.status === 'running' ? '执行中…' : resultText || '无返回内容'}</p>
          )}
          {call.args && Object.keys(call.args).length > 0 && (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-[10px] text-ink-4 hover:text-ink-2">查看调用参数</summary>
              <pre className="mono mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed text-ink-3">
                {JSON.stringify(call.args, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

function StatusPill({ status }: { status: ToolCallInfo['status'] }) {
  if (status === 'running') {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded-md border border-accent/35 bg-accent/10 px-1.5 py-[1px] text-[9.5px] font-semibold text-accent-soft">
        <LoaderCircle size={8} className="animate-spin" />
        执行中
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded-md border border-danger/40 bg-danger/10 px-1.5 py-[1px] text-[9.5px] font-semibold text-danger">
        <CircleAlert size={8} />
        失败
      </span>
    )
  }
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-md border border-success/35 bg-success/10 px-1.5 py-[1px] text-[9.5px] font-semibold text-success">
      <Check size={8} />
      完成
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* 工程变更 / 流式指示                                                  */
/* ------------------------------------------------------------------ */

function ChangedProjectChip() {
  const undoAiChanges = useStore((s) => s.undoAiChanges)
  const hasSnapshot = useStore((s) => Boolean(s.aiUndoSnapshot))
  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg border border-success/25 bg-success/8 px-2.5 py-1.5">
      <Check size={11} className="shrink-0 text-success" />
      <span className="text-[11.5px] text-ink-2">已更新工程</span>
      <span className="text-[10.5px] text-ink-4">· 可撤销</span>
      <button
        className="ml-auto flex h-[22px] items-center gap-1 rounded-md border border-line-strong bg-surface-2 px-2 text-[10.5px] text-ink-2 hover:text-ink disabled:opacity-40"
        disabled={!hasSnapshot}
        onClick={undoAiChanges}
        title="撤销 AI 对工程的全部改动"
      >
        <Undo2 size={9} />
        撤销
      </button>
    </div>
  )
}

function StreamCaret() {
  return <span className="ml-0.5 inline-block h-[13px] w-[2px] translate-y-[2px] animate-pulse bg-accent align-baseline" />
}

function TypingDots() {
  return (
    <div className="flex items-center gap-2 py-1 text-[11px] text-ink-3">
      <span className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-[4px] w-[4px] rounded-full bg-accent/80"
            style={{ animation: `pulse-dot 1.1s ease-in-out ${i * 0.16}s infinite` }}
          />
        ))}
      </span>
      正在组织回答…
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 计时：生成中每秒刷新一次，结束后读固定值                              */
/* ------------------------------------------------------------------ */

function useLiveElapsed(message: ChatMessage): number | null {
  const streaming = Boolean(message.streaming)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!streaming) return
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [streaming])
  const metrics = getMessageMetrics(message.id)
  if (!metrics) return null
  if (metrics.elapsedMs != null) return metrics.elapsedMs
  if (!streaming) return null
  return Math.max(0, now - metrics.startedAt)
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
