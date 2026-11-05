/**
 * 轻量浮层组件：右键菜单 / 锚定气泡 / 快捷键角标。
 *
 * DAW 里「右键 = 就地操作」是绝对惯例（Ableton/Logic/Bitwig 都是如此），
 * 但每个视图各写一套菜单很容易漂移。这里提供统一外观与行为：
 * - 自动夹取到视口内，不会溢出屏幕；
 * - 点击外部 / Esc / 滚轮 / 窗口尺寸变化自动关闭；
 * - 键盘可读（role=menu / menuitem、aria-checked）；
 * - 通过 portal 渲染到 body，避免被父级 overflow/transform 裁剪。
 */
import React, { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/format'

/* ------------------------------------------------------------------ */
/* 快捷键角标                                                          */
/* ------------------------------------------------------------------ */

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-[4px] border border-line-strong bg-surface-3 px-1 font-mono text-[9.5px] font-medium text-ink-3">
      {children}
    </kbd>
  )
}

/* ------------------------------------------------------------------ */
/* 菜单项                                                              */
/* ------------------------------------------------------------------ */

export interface MenuItemProps {
  icon?: React.ReactNode
  label: React.ReactNode
  hint?: React.ReactNode
  /** 右侧的快捷键角标（字符串） */
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  /** 复选类菜单项：显示勾选状态 */
  checked?: boolean
  title?: string
  onClick?: () => void
  /** 是否显示右侧展开箭头（用于后续升级为子菜单） */
  submenu?: boolean
  className?: string
}

export function MenuItem({
  icon,
  label,
  hint,
  shortcut,
  danger,
  disabled,
  checked,
  title,
  onClick,
  submenu,
  className,
}: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      aria-checked={checked}
      title={title}
      onClick={(event) => {
        event.stopPropagation()
        if (!disabled) onClick?.()
      }}
      className={cn(
        'flex h-[26px] w-full items-center gap-2 px-2 text-left text-[11.5px] transition-colors',
        disabled
          ? 'cursor-not-allowed text-ink-4/70'
          : danger
            ? 'text-danger hover:bg-danger/12'
            : 'text-ink-2 hover:bg-surface-3 hover:text-ink',
        className,
      )}
    >
      <span className={cn('flex w-3.5 shrink-0 items-center justify-center', danger ? 'text-danger' : 'text-ink-3')}>
        {checked ? <Check size={11} /> : icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint != null && <span className="mono shrink-0 text-[9px] text-ink-4">{hint}</span>}
      {shortcut && (
        <span className="mono shrink-0 rounded border border-line bg-surface-2 px-1 text-[9px] text-ink-4">
          {shortcut}
        </span>
      )}
      {submenu && <ChevronRight size={11} className="shrink-0 text-ink-4" />}
    </button>
  )
}

export function MenuDivider() {
  return <div className="my-1 h-px bg-line" role="separator" />
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <div className="truncate px-2 pb-1 pt-1.5 text-[9.5px] uppercase tracking-[0.08em] text-ink-4">{children}</div>
}

/* ------------------------------------------------------------------ */
/* 右键菜单                                                            */
/* ------------------------------------------------------------------ */

export interface ContextMenuProps {
  x: number
  y: number
  onClose: () => void
  label?: React.ReactNode
  width?: number
  children: React.ReactNode
}

export function ContextMenu({ x, y, onClose, label, width = 212, children }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number }>({
    left: x,
    top: y,
    maxHeight: 480,
  })

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const margin = 8
    const rect = element.getBoundingClientRect()
    const maxHeight = Math.max(160, window.innerHeight - margin * 2)
    const left = Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - rect.width - margin))
    const top = Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - Math.min(rect.height, maxHeight) - margin))
    setPosition({ left, top, maxHeight })
  }, [x, y])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && ref.current.contains(event.target)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('wheel', onClose, { passive: true })
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('wheel', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={typeof label === 'string' ? label : undefined}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      className="fixed z-[80] overflow-y-auto rounded-[10px] border border-line-strong bg-surface py-1 shadow-[0_28px_70px_-18px_rgba(0,0,0,0.95),0_0_0_1px_rgba(255,255,255,0.04)] animate-fade-up"
      style={{ left: position.left, top: position.top, width, maxHeight: position.maxHeight }}
    >
      {label != null && (
        <div className="truncate border-b border-line/70 px-2 pb-1.5 pt-0.5 text-[10px] text-ink-4">{label}</div>
      )}
      {children}
    </div>,
    document.body,
  )
}

/* ------------------------------------------------------------------ */
/* 锚定气泡                                                            */
/* ------------------------------------------------------------------ */

export interface PopoverProps {
  /** 锚点：通常是按钮的 getBoundingClientRect() */
  anchor: DOMRect | { left: number; right: number; top: number; bottom: number }
  onClose: () => void
  width: number
  /** 预估高度，用于决定向上还是向下展开 */
  estimatedHeight?: number
  align?: 'start' | 'end'
  className?: string
  children: React.ReactNode
  /** 无障碍标签 */
  label?: string
}

/** 计算锚定浮层的位置（fixed 定位） */
export function popoverPosition(
  anchor: PopoverProps['anchor'],
  width: number,
  estimatedHeight = 260,
  align: 'start' | 'end' = 'start',
): CSSProperties {
  const gap = 6
  const margin = 8
  let left = align === 'end' ? anchor.right - width : anchor.left
  let top = anchor.bottom + gap
  left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin))
  if (top + estimatedHeight > window.innerHeight - margin) {
    const above = anchor.top - estimatedHeight - gap
    top = above >= margin ? above : Math.max(margin, window.innerHeight - estimatedHeight - margin)
  }
  return { position: 'fixed', left, top, width }
}

export function Popover({ anchor, onClose, width, estimatedHeight = 260, align = 'start', className, children, label }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && ref.current.contains(event.target)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const style = popoverPosition(anchor, width, estimatedHeight, align)

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      onPointerDown={(event) => event.stopPropagation()}
      className={cn(
        'z-[80] animate-fade-up overflow-hidden rounded-[12px] border border-line-strong bg-surface shadow-[0_28px_70px_-18px_rgba(0,0,0,0.95)]',
        className,
      )}
      style={style}
    >
      {children}
    </div>,
    document.body,
  )
}
