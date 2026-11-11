import React, { useEffect, useId, useRef, useState } from 'react'
import { cn } from '../../lib/format'

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

type ButtonVariant = 'default' | 'accent' | 'ghost' | 'danger'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  icon?: React.ReactNode
  active?: boolean
}

export function Button({ variant = 'default', size = 'md', icon, active, className, children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      data-active={active || undefined}
      className={cn(
        'btn',
        variant === 'accent' && 'btn-accent',
        variant === 'ghost' && 'btn-ghost',
        variant === 'danger' && 'border-danger/50 text-danger hover:bg-danger/10',
        size === 'sm' && 'h-7 rounded-lg px-2 text-[11.5px]',
        active && 'border-accent/60 bg-accent/12 text-accent-soft',
        className,
      )}
    >
      {icon}
      {children}
    </button>
  )
}

export function IconButton({
  title,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { title: string }) {
  return (
    <button {...rest} title={title} aria-label={title} className={cn('btn btn-ghost btn-icon', className)}>
      {children}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Slider                                                              */
/* ------------------------------------------------------------------ */

export interface SliderProps {
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (value: number) => void
  onCommit?: (value: number) => void
  className?: string
  /** 竖排（混音推子） */
  vertical?: boolean
  ariaLabel?: string
}

export function Slider({ value, min = 0, max = 1, step = 0.01, onChange, onCommit, className, vertical, ariaLabel }: SliderProps) {
  const ratio = max === min ? 0 : (value - min) / (max - min)
  const percent = Math.max(0, Math.min(100, ratio * 100))
  return (
    <input
      type="range"
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      onPointerUp={() => onCommit?.(value)}
      onKeyUp={() => onCommit?.(value)}
      className={cn(
        'slider appearance-none bg-transparent cursor-pointer',
        vertical ? 'h-full w-4 [writing-mode:vertical-lr] [direction:rtl]' : 'h-4 w-full',
        className,
      )}
      style={{ ['--slider-fill' as string]: `${percent}%` }}
    />
  )
}

/* ------------------------------------------------------------------ */
/* Select                                                              */
/* ------------------------------------------------------------------ */

export interface SelectOption {
  value: string
  label: string
  group?: string
  hint?: string
}

export function Select({
  value,
  options,
  onChange,
  className,
  placeholder,
  ariaLabel,
}: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  className?: string
  placeholder?: string
  ariaLabel?: string
}) {
  const groups = new Map<string, SelectOption[]>()
  for (const option of options) {
    const key = option.group ?? ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(option)
  }
  return (
    <select
      aria-label={ariaLabel}
      className={cn('field cursor-pointer appearance-none pr-6', className)}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236c7789' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E\")",
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 10px center',
      }}
    >
      {placeholder && <option value="">{placeholder}</option>}
      {[...groups.entries()].map(([group, items]) =>
        group ? (
          <optgroup key={group} label={group}>
            {items.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </optgroup>
        ) : (
          items.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))
        ),
      )}
    </select>
  )
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 'md',
}: {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  subtitle?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  width?: 'sm' | 'md' | 'lg' | 'xl'
}) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      /* 弹层（下拉 / 菜单）已经消化过的 Esc 不再关闭整个对话框 */
      if (event.defaultPrevented) return
      onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  /* 打开时把焦点移到对话框容器：Esc / 滚动立刻可用，且不会误触第一个按钮；
     关闭时把焦点还给打开它的控件。 */
  useEffect(() => {
    if (!open) return
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const timer = window.setTimeout(() => panelRef.current?.focus(), 30)
    return () => {
      window.clearTimeout(timer)
      restoreFocusRef.current?.focus?.({ preventScroll: true })
    }
  }, [open])

  if (!open) return null
  /** 焦点 trap：Tab 只在对话框内部循环，避免跑到被遮住的背景控件上 */
  const trapFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return
    const panel = panelRef.current
    if (!panel) return
    const focusables = [...panel.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
    )].filter((element) => element.offsetParent !== null || element === document.activeElement)
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement as HTMLElement | null
    if (event.shiftKey) {
      if (!active || active === panel || active === first) {
        event.preventDefault()
        last.focus()
      }
      return
    }
    if (!active || active === panel) {
      event.preventDefault()
      first.focus()
      return
    }
    if (active === last) {
      event.preventDefault()
      first.focus()
    }
  }
  const widths = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-4xl', xl: 'max-w-6xl' }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/65 backdrop-blur-sm" onClick={onClose} role="presentation" />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ outline: 'none' }}
        onKeyDown={trapFocus}
        className={cn(
          'relative z-10 flex max-h-[86vh] w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_32px_80px_-24px_rgba(0,0,0,0.9)] animate-fade-up',
          widths[width],
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[15px] font-semibold tracking-tight">
              {title}
            </h2>
            {subtitle && <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{subtitle}</p>}
          </div>
          <button type="button" className="btn btn-ghost btn-icon -mr-1 -mt-1" onClick={onClose} aria-label="关闭">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div data-modal-body className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {children}
        </div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Tooltip                                                             */
/* ------------------------------------------------------------------ */

export function Tooltip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span className="pointer-events-none absolute -top-1 left-1/2 z-50 hidden -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-line-strong bg-surface-3 px-2 py-1 text-[11px] text-ink shadow-lg group-hover/tt:block">
        {label}
      </span>
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Switch / Field                                                      */
/* ------------------------------------------------------------------ */

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-[20px] w-[34px] shrink-0 rounded-full border transition-colors',
        checked ? 'border-accent/70 bg-accent/80' : 'border-line-strong bg-surface-3',
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all',
          checked ? 'left-[17px]' : 'left-[2px] bg-ink-2',
        )}
      />
    </button>
  )
}

export function Field({
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
      <span className="mb-1.5 block text-[11px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-relaxed text-ink-3">{hint}</span>}
    </label>
  )
}

export function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-line bg-surface-2/60 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[12.5px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] leading-relaxed text-ink-3">{hint}</div>}
      </div>
      <Switch
        checked={checked}
        onChange={onChange}
        label={typeof label === 'string' ? label : typeof hint === 'string' ? hint : undefined}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Segmented                                                           */
/* ------------------------------------------------------------------ */

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T
  options: { value: T; label: React.ReactNode; icon?: React.ReactNode }[]
  onChange: (value: T) => void
  className?: string
}) {
  return (
    <div className={cn('flex items-center gap-0.5 rounded-[10px] border border-line bg-bg-soft p-0.5', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-[7px] px-2.5 text-[12px] font-medium transition-all',
            value === option.value ? 'bg-surface-3 text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2',
          )}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export function EmptyState({ icon, title, hint, action }: { icon?: React.ReactNode; title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon && <div className="text-ink-4">{icon}</div>}
      <div className="text-[13px] font-medium text-ink-2">{title}</div>
      {hint && <div className="max-w-xs text-[11.5px] leading-relaxed text-ink-3">{hint}</div>}
      {action}
    </div>
  )
}

export function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'accent' | 'success' | 'danger' | 'violet' }) {
  const tones: Record<string, string> = {
    neutral: 'border-line-strong bg-surface-3 text-ink-2',
    accent: 'border-accent/40 bg-accent/12 text-accent-soft',
    success: 'border-success/40 bg-success/10 text-success',
    danger: 'border-danger/40 bg-danger/10 text-danger',
    violet: 'border-violet/40 bg-violet/12 text-violet',
  }
  return (
    <span className={cn('inline-flex h-[19px] items-center rounded-md border px-1.5 text-[10.5px] font-semibold tracking-wide', tones[tone])}>
      {children}
    </span>
  )
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin text-accent" aria-label="加载中">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.4" fill="none" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.4" fill="none" strokeLinecap="round" />
    </svg>
  )
}

/** 数字输入（带拖拽调整） */
export function NumberField({
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
  width = 64,
}: {
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (v: number) => void
  suffix?: string
  width?: number
}) {
  const [draft, setDraft] = useState(String(value))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(String(value))
  }, [value])
  const commit = (raw: string) => {
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) {
      const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed))
      onChange(clamped)
      setDraft(String(clamped))
    } else {
      setDraft(String(value))
    }
  }
  return (
    <div className="flex items-center gap-1 rounded-lg border border-line-strong bg-bg-soft px-1.5" style={{ height: 30, width }}>
      <input
        className="w-full bg-transparent text-center text-[12.5px] tabular-nums outline-none"
        value={draft}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false
          commit(draft)
        }}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            commit(String(value + step))
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            commit(String(value - step))
          }
        }}
      />
      {suffix && <span className="text-[10.5px] text-ink-3">{suffix}</span>}
    </div>
  )
}

/** 用 useId 生成表单 id，避免重复 */
export function useFieldId(prefix: string): string {
  const id = useId()
  return `${prefix}-${id}`
}
