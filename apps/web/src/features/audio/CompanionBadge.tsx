/**
 * Companion 在线状态小徽标（顶栏）。
 *
 * 契约：`GET /api/companion/status` 在**没有 Companion 时也是 200 + online:false**，
 * 所以「离线」不是错误态：灰点 + tooltip 给出启动命令；只有接口本身失败才提示未就绪。
 * 30s 轮询一次，卸载时清理定时器。
 */
import { useEffect, useState } from 'react'
import { Bot } from 'lucide-react'
import { getCompanionStatus, type CompanionStatus } from '../../lib/api'
import { cn } from '../../lib/format'

const POLL_MS = 30_000

/** 无 Companion 时的兜底启动命令（服务端 hint 缺失时展示） */
export const COMPANION_START_HINT =
  '没有在线 Companion：在跑 GPU 的机器上执行 node scripts/companion.mjs --server <本服务地址> --engine'

/**
 * 直接把「本服务地址」填成当前页面 origin：用户复制后就能跑，
 * 不用再猜 <本服务地址> 是 5183 还是 8787（开发时 Vite 会把 /api 代理到后端）。
 */
export function companionStartHint(origin?: string): string {
  const base = (origin ?? (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/$/, '')
  if (!base) return COMPANION_START_HINT
  return `没有在线 Companion：在跑 GPU 的机器上执行 node scripts/companion.mjs --server ${base} --engine`
}

/** 服务端 hint 若是带 <本服务地址> 的模板，就用当前 origin 填好；否则保留服务端原文 */
export function resolveCompanionHint(serverHint?: string, origin?: string): string {
  const hint = serverHint?.trim()
  if (hint && !hint.includes('<')) return hint
  return companionStartHint(origin)
}

export function CompanionBadge({ onOpenPanel }: { onOpenPanel?: () => void }) {
  const [status, setStatus] = useState<CompanionStatus | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const next = await getCompanionStatus()
        if (cancelled) return
        setStatus(next)
        setFailed(false)
      } catch {
        if (cancelled) return
        setStatus(null)
        setFailed(true)
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const online = !failed && status?.online === true
  const summary = status?.summary
  const hint = resolveCompanionHint(status?.hint)
  const title = online
    ? `Companion 在线：${summary?.workers ?? 0} 个节点 · 运行 ${summary?.running ?? 0} / 排队 ${summary?.queued ?? 0}（点击打开「AI 生成音频」）`
    : failed
      ? 'Companion 状态接口未就绪（可能是旧后端），点击打开「AI 生成音频」查看详情'
      : `Companion 离线：${hint}`

  return (
    <button
      type="button"
      data-companion-badge
      data-online={online ? 'true' : 'false'}
      className={cn(
        'flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-[10px] transition-colors',
        online
          ? 'border-success/35 bg-success/8 text-ink-2 hover:bg-success/12'
          : 'border-line-strong bg-surface-2 text-ink-3 hover:bg-surface-3',
      )}
      title={title}
      aria-label={online ? 'Companion 在线' : 'Companion 离线'}
      onClick={onOpenPanel}
    >
      <Bot size={11} className="shrink-0" />
      <span
        className={cn('h-1.5 w-1.5 rounded-full', online ? 'bg-success' : 'bg-ink-4')}
        style={online ? { animation: 'pulse-dot 2.4s ease-in-out infinite' } : undefined}
      />
      <span className="hidden min-[1420px]:inline">{online ? '生成节点在线' : '生成节点离线'}</span>
    </button>
  )
}
