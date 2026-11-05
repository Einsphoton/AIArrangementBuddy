import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { useStore } from '../store/store'
import { cn } from '../lib/format'

/**
 * 提示条（Toast）。
 *
 * DAW 里的提示通常发生在「操作完成/失败」的瞬间，必须：
 * - 不挡住正在编辑的区域（底部居中、状态栏上方）；
 * - 明确成功/失败语义（颜色 + 图标 + 左侧色条）；
 * - 可快速关掉，并且知道它何时自动消失（进度线）。
 */
export function ToastHost() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)

  return (
    <div className="pointer-events-none fixed bottom-9 left-1/2 z-[70] flex w-[min(92vw,560px)] -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} id={toast.id} kind={toast.kind} message={toast.message} onDismiss={dismiss} />
      ))}
    </div>
  )
}

function ToastItem({
  id,
  kind,
  message,
  onDismiss,
}: {
  id: string
  kind: 'info' | 'success' | 'error'
  message: string
  onDismiss: (id: string) => void
}) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 10)
    return () => clearTimeout(timer)
  }, [])

  const tone =
    kind === 'success'
      ? { bar: 'bg-success', icon: <CheckCircle2 size={14} className="text-success" /> }
      : kind === 'error'
        ? { bar: 'bg-danger', icon: <XCircle size={14} className="text-danger" /> }
        : { bar: 'bg-cyan', icon: <Info size={14} className="text-cyan" /> }

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'pointer-events-auto relative flex w-full items-center gap-2.5 overflow-hidden rounded-xl border bg-surface/95 py-2 pl-3 pr-2 shadow-[0_18px_44px_-18px_rgba(0,0,0,0.95)] backdrop-blur transition-all duration-200',
        kind === 'error' ? 'border-danger/40' : 'border-line-strong',
        visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
      )}
    >
      <span className={cn('absolute inset-y-0 left-0 w-[2px]', tone.bar)} />
      {kind === 'error' ? <AlertTriangle size={14} className="shrink-0 text-danger" /> : <span className="shrink-0">{tone.icon}</span>}
      <span className="min-w-0 flex-1 text-[12px] leading-relaxed text-ink">{message}</span>
      <button
        className="shrink-0 rounded p-1 text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
        onClick={() => onDismiss(id)}
        aria-label="关闭提示"
      >
        <X size={11} />
      </button>
      <span className={cn('absolute bottom-0 left-0 h-[1.5px] opacity-60 toast-progress', tone.bar)} />
    </div>
  )
}
