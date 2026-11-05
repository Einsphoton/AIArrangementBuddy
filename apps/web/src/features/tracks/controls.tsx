/**
 * 轨道 / 混音器用的迷你控件。
 *
 * 这些控件尺寸很小但交互要跟手：按下即抓取、拖动实时更新、松手提交。
 * 高频拖拽的撤销栈由调用方通过 onGestureStart（内部 pushHistory）保证只记一次。
 */
import { useRef, useState, type CSSProperties } from 'react'
import { cn } from '../../lib/format'
import { clamp } from '../arrangement/timeline'

/* ------------------------------------------------------------------ */
/* dB 换算 / 推子刻度                                                   */
/* ------------------------------------------------------------------ */

/** 推子底部的 dB 端点（-∞ 一侧） */
export const FADER_DB_FLOOR = -60

/** 增益值 → dB 文本（0 视为 -∞） */
export function gainToDbText(gain: number, digits = 1): string {
  if (!Number.isFinite(gain) || gain <= 0.0005) return '-∞'
  const db = 20 * Math.log10(gain)
  return `${db > 0 ? '+' : ''}${db.toFixed(digits)}`
}

/** 电平（0..1，引擎按 -60..0 dB 映射）→ dB 文本 */
export function levelToDbText(level: number, digits = 1): string {
  if (!Number.isFinite(level) || level <= 0.002) return '-∞'
  const db = level * 60 - 60
  return `${db.toFixed(digits)}`
}

/** 推子顶端的 dB（由最大增益决定，默认 1.5 ≈ +3.5 dB） */
export function faderDbCeil(max = 1.5): number {
  return 20 * Math.log10(Math.max(0.001, max))
}

/** dB → 推子比例（0..1，底部 -60 dB，顶部 faderDbCeil） */
export function dbToFaderRatio(db: number, max = 1.5): number {
  return clamp((db - FADER_DB_FLOOR) / (faderDbCeil(max) - FADER_DB_FLOOR), 0, 1)
}

/* ------------------------------------------------------------------ */
/* 迷你横向推子（轨道音量）                                             */
/* ------------------------------------------------------------------ */

export function MiniHSlider({
  value,
  min = 0,
  max = 1,
  onChange,
  onGestureStart,
  onCommit,
  title,
  width = 42,
  className,
  formatValue,
  fillColor,
}: {
  value: number
  min?: number
  max?: number
  onChange: (value: number) => void
  onGestureStart?: () => void
  onCommit?: (value: number) => void
  title: string
  width?: number
  className?: string
  formatValue?: (value: number) => string
  fillColor?: string
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const gesture = useRef(false)
  const ratio = clamp((value - min) / (max - min || 1), 0, 1)

  const setFromClientX = (clientX: number) => {
    const element = trackRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const next = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1)
    onChange(min + next * (max - min))
  }

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-label={title}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Number(value.toFixed(2))}
      title={formatValue ? `${title}：${formatValue(value)}` : title}
      className={cn(
        'group/sl relative flex h-[14px] cursor-ew-resize items-center rounded-full border border-line-strong/80 bg-bg-soft px-[2px] transition-colors hover:border-[#3b4557]',
        className,
      )}
      style={{ width }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        dragging.current = true
        if (!gesture.current) {
          gesture.current = true
          onGestureStart?.()
        }
        setFromClientX(event.clientX)
      }}
      onPointerMove={(event) => {
        if (dragging.current) setFromClientX(event.clientX)
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        if (dragging.current) {
          dragging.current = false
          gesture.current = false
          onCommit?.(value)
        }
      }}
      onPointerCancel={() => {
        dragging.current = false
        gesture.current = false
      }}
      onDoubleClick={() => {
        onGestureStart?.()
        onChange(min + (max - min) * 0.5)
      }}
    >
      <div
        className="pointer-events-none absolute inset-y-[2px] left-[2px] rounded-full transition-[width] duration-75"
        style={{
          width: `calc(${(ratio * 100).toFixed(1)}% - 2px)`,
          background: fillColor ?? 'linear-gradient(90deg, #8a6a1f, #f0b429)',
        }}
      />
      <div
        className="pointer-events-none relative h-[8px] w-[8px] rounded-full border border-black/70 bg-[#eef2f9] shadow-[0_1px_3px_rgba(0,0,0,0.7)] transition-transform group-hover/sl:scale-110"
        style={{ marginLeft: `calc(${(ratio * 100).toFixed(1)}% - 4px)` }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 迷你旋钮（声像 / 发送量）                                            */
/* ------------------------------------------------------------------ */

export function MiniKnob({
  value,
  min = -1,
  max = 1,
  onChange,
  onGestureStart,
  onCommit,
  title,
  size = 18,
  center = 0,
  formatValue,
  accent = '#3ddbd9',
}: {
  value: number
  min?: number
  max?: number
  onChange: (value: number) => void
  onGestureStart?: () => void
  onCommit?: (value: number) => void
  title: string
  size?: number
  center?: number
  formatValue?: (value: number) => string
  accent?: string
}) {
  const dragRef = useRef<{ y: number; value: number } | null>(null)
  const gesture = useRef(false)
  const ratio = clamp((value - min) / (max - min || 1), 0, 1)
  const angle = -135 + ratio * 270
  const centerRatio = clamp((center - min) / (max - min || 1), 0, 1)
  const label = formatValue ? formatValue(value) : value.toFixed(2)

  return (
    <div
      role="slider"
      aria-label={title}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Number(value.toFixed(2))}
      title={`${title}：${label}（上下拖动，双击复位）`}
      className="relative shrink-0 cursor-ns-resize rounded-full outline-offset-2"
      style={{ width: size, height: size }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        dragRef.current = { y: event.clientY, value }
        if (!gesture.current) {
          gesture.current = true
          onGestureStart?.()
        }
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current
        if (!drag) return
        const deltaY = drag.y - event.clientY
        const sensitivity = event.shiftKey ? 560 : 140
        onChange(clamp(drag.value + (deltaY / sensitivity) * (max - min), min, max))
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        if (dragRef.current) {
          dragRef.current = null
          gesture.current = false
          onCommit?.(value)
        }
      }}
      onDoubleClick={() => {
        onGestureStart?.()
        onChange(center)
      }}
    >
      <div
        className="absolute inset-0 rounded-full border border-line-strong bg-[radial-gradient(circle_at_35%_30%,#2b3242,#12161f)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
        style={{}}
      />
      {/* 中心刻度（声像 C） */}
      <div
        className="absolute left-1/2 top-0 h-[2px] w-[1px] -translate-x-1/2 bg-ink-4/60"
        style={{ transform: `translateX(-50%) rotate(${-135 + centerRatio * 270}deg)`, transformOrigin: `50% ${size / 2}px` }}
      />
      {/* 指针 */}
      <div
        className="absolute inset-0 transition-transform duration-75"
        style={{ transform: `rotate(${angle}deg)`, transformOrigin: '50% 50%' }}
      >
        <div
          className="absolute left-1/2 top-[2px] h-[5px] w-[1.5px] -translate-x-1/2 rounded-full"
          style={{ background: accent, boxShadow: `0 0 4px ${accent}` }}
        />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 竖向推子（混音器）                                                  */
/* ------------------------------------------------------------------ */

export function VerticalFader({
  value,
  min = 0,
  max = 1.5,
  onChange,
  onGestureStart,
  onCommit,
  title,
  height = 112,
  formatValue,
  taper = 'linear',
  resetValue,
  onDragStateChange,
  bubbleFormatter,
}: {
  value: number
  min?: number
  max?: number
  onChange: (value: number) => void
  onGestureStart?: () => void
  onCommit?: (value: number) => void
  title: string
  height?: number
  formatValue?: (value: number) => string
  /** `db` = 对数（专业推子）刻度：0 dB 落在约 90% 高度，便于读 dB 标尺 */
  taper?: 'linear' | 'db'
  /** 双击复位值 */
  resetValue?: number
  /** 拖动开始 / 结束（用于把数值显示切到 dB） */
  onDragStateChange?: (dragging: boolean) => void
  /** 悬浮气泡文本（默认同 formatValue） */
  bubbleFormatter?: (value: number) => string
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ lastY: number; lastRatio: number } | null>(null)
  const gesture = useRef(false)
  const [dragging, setDragging] = useState(false)

  const dbTaper = taper === 'db' && min === 0 && max > 0
  const ratio = dbTaper
    ? dbToFaderRatio(20 * Math.log10(Math.max(value, 1e-4)), max)
    : clamp((value - min) / (max - min || 1), 0, 1)
  const label = formatValue ? formatValue(value) : value.toFixed(2)
  const bubble = (bubbleFormatter ?? formatValue)?.(value) ?? label

  const ratioToValue = (nextRatio: number) => {
    const r = clamp(nextRatio, 0, 1)
    if (!dbTaper) return min + r * (max - min)
    const ceil = faderDbCeil(max)
    return clamp(Math.pow(10, (FADER_DB_FLOOR + r * (ceil - FADER_DB_FLOOR)) / 20), 0, max)
  }

  const endDrag = () => {
    dragRef.current = null
    gesture.current = false
    setDragging(false)
    onDragStateChange?.(false)
  }

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-label={title}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Number(value.toFixed(3))}
      aria-valuetext={bubble}
      title={`${title}：${label}（上下拖动，Shift 精调，双击复位）`}
      className="group/fader relative flex w-full cursor-ns-resize items-center justify-center"
      style={{ height }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        const element = trackRef.current
        if (!element) return
        const rect = element.getBoundingClientRect()
        const clickedRatio = clamp(1 - (event.clientY - rect.top) / Math.max(1, rect.height), 0, 1)
        // 普通拖动：点击即跳到位；Shift：精调，不跳变，只做相对微调
        const startRatio = event.shiftKey ? ratio : clickedRatio
        if (!event.shiftKey) onChange(ratioToValue(startRatio))
        dragRef.current = { lastY: event.clientY, lastRatio: startRatio }
        setDragging(true)
        if (!gesture.current) {
          gesture.current = true
          onGestureStart?.()
        }
        onDragStateChange?.(true)
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current
        if (!drag) return
        // 相对拖动 + 加速度：慢拖更精细，快拖更快（DAW 推子手感）
        const dy = event.clientY - drag.lastY
        drag.lastY = event.clientY
        const magnitude = Math.abs(dy)
        const acceleration = magnitude < 2 ? 0.45 : magnitude < 7 ? 0.8 : 1.25
        const fine = event.shiftKey ? 0.2 : 1
        const next = clamp(drag.lastRatio - (dy / Math.max(1, height)) * acceleration * fine, 0, 1)
        drag.lastRatio = next
        onChange(ratioToValue(next))
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        if (!dragRef.current) return
        endDrag()
        onCommit?.(value)
      }}
      onPointerCancel={endDrag}
      onDoubleClick={() => {
        onGestureStart?.()
        onChange(resetValue ?? min + (max - min) * 0.55)
      }}
    >
      {/* 轨道槽 */}
      <div className="absolute inset-y-0 w-[5px] rounded-full border border-line bg-bg shadow-[inset_0_2px_6px_rgba(0,0,0,0.8)]" />
      {/* 推子帽 */}
      <div
        className="pointer-events-none absolute left-1/2 h-[16px] w-[26px] -translate-x-1/2 rounded-[4px] border border-line-strong bg-[linear-gradient(180deg,#3a4356,#1b2230)] shadow-[0_3px_8px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.12)] transition-transform group-hover/fader:scale-[1.04]"
        style={{ bottom: `calc(${(ratio * 100).toFixed(2)}% - 8px)` }}
      >
        <div className="absolute left-1/2 top-1/2 h-[1.5px] w-[16px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/70" />
      </div>
      {/* 悬浮数值气泡 */}
      <div
        className="mono pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-[5px] border border-line-strong bg-surface px-1.5 py-[2px] text-[9.5px] tabular-nums text-ink opacity-0 shadow-[0_6px_18px_-6px_rgba(0,0,0,0.9)] transition-opacity duration-100 group-hover/fader:opacity-100"
        style={{ bottom: `calc(${(ratio * 100).toFixed(2)}% + 12px)`, opacity: dragging ? 1 : undefined }}
      >
        {bubble}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* dB 标尺                                                             */
/* ------------------------------------------------------------------ */

/** 竖向 dB 标尺：与 db 刻度推子严格对齐（0 / -6 / -12 / -24 / -48） */
export function DbRuler({ height = 112, max = 1.5, className }: { height?: number; max?: number; className?: string }) {
  const ticks = [0, -6, -12, -24, -48]
  return (
    <div className={cn('relative w-[23px] shrink-0 select-none', className)} style={{ height }} aria-hidden="true">
      {ticks.map((db) => (
        <div
          key={db}
          className="absolute inset-x-0 flex items-center gap-[3px]"
          style={{ bottom: `calc(${(dbToFaderRatio(db, max) * 100).toFixed(2)}% - 4px)` }}
        >
          <span className="mono w-[13px] text-right text-[8.5px] leading-none tabular-nums text-ink-4">{db}</span>
          <span className="h-px flex-1 bg-line-strong/60" />
        </div>
      ))}
      <span className="mono absolute bottom-0 left-0 text-[8px] leading-none text-ink-4/80">dB</span>
    </div>
  )
}


/* ------------------------------------------------------------------ */
/* 电平条                                                              */
/* ------------------------------------------------------------------ */

/** 只读电平条：fill 直接由父级 rAF 通过 ref 更新 style.height，避免 React 重渲染 */
export function MeterStrip({
  height = 112,
  className,
  style,
}: {
  height?: number
  className?: string
  style?: CSSProperties
}) {
  return (
    <div
      className={cn('relative w-[6px] overflow-hidden rounded-[2px] bg-bg/90 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]', className)}
      style={{ height, ...style }}
    >
      <div
        className="meter-fill absolute bottom-0 left-0 w-full rounded-[2px]"
        style={{
          height: '0%',
          background: 'linear-gradient(to top, #34d399 0%, #a3e635 58%, #f0b429 82%, #f0563b 100%)',
        }}
      />
    </div>
  )
}
