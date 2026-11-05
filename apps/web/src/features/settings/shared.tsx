import React from 'react'
import { cn } from '../../lib/format'

/** 设置页的分区卡片 */
export function Section({
  title,
  description,
  icon,
  badge,
  children,
  className,
}: {
  title: string
  description?: React.ReactNode
  icon?: React.ReactNode
  badge?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn('rounded-xl border border-line bg-surface-2/40', className)}>
      <header className="flex items-start gap-2 border-b border-line/80 px-3.5 py-2.5">
        {icon && <span className="mt-[1px] text-accent/80">{icon}</span>}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-[12.5px] font-semibold tracking-tight text-ink">{title}</h3>
            {badge}
          </div>
          {description && <p className="mt-0.5 text-[10.5px] leading-relaxed text-ink-3">{description}</p>}
        </div>
      </header>
      <div className="space-y-3 px-3.5 py-3">{children}</div>
    </section>
  )
}

/** 表单行：左标签 + 右控件 */
export function Row({
  label,
  hint,
  children,
  align = 'center',
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  children: React.ReactNode
  align?: 'center' | 'start'
}) {
  return (
    <div className={cn('flex gap-3', align === 'center' ? 'items-center' : 'items-start')}>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-ink-2">{label}</div>
        {hint && <div className="mt-0.5 text-[10.5px] leading-relaxed text-ink-4">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** 字段组（上下结构） */
export function FieldGroup({
  label,
  hint,
  children,
  className,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1 block text-[10.5px] font-semibold tracking-wide text-ink-3">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[10px] leading-relaxed text-ink-4">{hint}</span>}
    </label>
  )
}

/** 内联状态文本 */
export function StatusLine({
  tone = 'neutral',
  children,
  icon,
}: {
  tone?: 'neutral' | 'success' | 'danger' | 'accent'
  children: React.ReactNode
  icon?: React.ReactNode
}) {
  const tones = {
    neutral: 'text-ink-3',
    success: 'text-success',
    danger: 'text-danger',
    accent: 'text-accent-soft',
  }
  return (
    <span className={cn('flex items-center gap-1 text-[10.5px] leading-relaxed', tones[tone])}>
      {icon}
      <span className="min-w-0 break-words">{children}</span>
    </span>
  )
}

/** 折叠说明块 */
export function Details({
  summary,
  children,
  tone = 'neutral',
}: {
  summary: React.ReactNode
  children: React.ReactNode
  tone?: 'neutral' | 'accent'
}) {
  return (
    <details className="group rounded-lg border border-line bg-bg-soft/50 px-2.5 py-2">
      <summary
        className={cn(
          'cursor-pointer list-none text-[11px] font-medium',
          tone === 'accent' ? 'text-accent-soft' : 'text-ink-2',
        )}
      >
        {summary}
      </summary>
      <div className="mt-1.5 space-y-1 text-[10.5px] leading-relaxed text-ink-3">{children}</div>
    </details>
  )
}

/** 代码片段 */
export function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="mono inline-block max-w-full overflow-x-auto rounded border border-line bg-black/30 px-1.5 py-[1px] text-[10.5px] text-accent-soft">
      {children}
    </code>
  )
}

/** 请求错误 → 用户可读的中文提示 */
export function describeRequestError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message || '请求失败'
    if (/failed to fetch|load failed|fetch|network|ECONNREFUSED/i.test(message)) {
      return '无法连接本地服务（127.0.0.1:8787），请确认后端已启动（pnpm dev）。'
    }
    return message
  }
  return '请求失败，请稍后重试。'
}

/** 设置分区组件的统一 props（由 SettingsModal 注入） */
export interface SettingsSectionProps {
  draft: import('@aiab/core').AppSettings
  loaded: import('@aiab/core').AppSettings | null
  update: (recipe: (draft: import('@aiab/core').AppSettings) => void) => void
  clearedKeys: string[]
  onClearKey: (providerId: string) => void
  onRestoreKey: (providerId: string) => void
}
