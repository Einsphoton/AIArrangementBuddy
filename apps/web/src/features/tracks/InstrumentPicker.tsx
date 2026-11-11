/**
 * 乐器 / 情绪选择弹层（轨道面板专用）。
 *
 * 弹层用 fixed + 计算位置，避免被轨道列表的 overflow 裁掉；
 * 点击外部 / Esc 自动关闭。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Check, Search, X } from 'lucide-react'
import { getInstrument, groupedInstruments } from '@aiab/core'
import { cn } from '../../lib/format'
import { FAMILY_COLORS } from '@aiab/core'

/** 依据触发元素的位置计算弹层坐标（自动避开视口边缘） */
export function popoverPosition(rect: DOMRect, width: number, maxHeight: number): CSSProperties {
  const gap = 6
  const margin = 8
  let left = rect.left
  let top = rect.bottom + gap
  if (left + width > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - width - margin)
  if (top + maxHeight > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - maxHeight - gap)
  }
  return { position: 'fixed', left, top, width }
}

/** 点击外部 / Esc 关闭弹层 */
export function usePopoverDismiss(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (ref.current && target && !ref.current.contains(target)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [onClose])
  return ref
}

/* ------------------------------------------------------------------ */
/* 乐器选择                                                            */
/* ------------------------------------------------------------------ */

export function InstrumentPicker({
  currentId,
  onPick,
  onClose,
  style,
}: {
  currentId?: string
  onPick: (instrumentId: string) => void
  onClose: () => void
  style: CSSProperties
}) {
  const [query, setQuery] = useState('')
  const panelRef = usePopoverDismiss(onClose)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30)
    return () => window.clearTimeout(timer)
  }, [])

  const groups = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return groupedInstruments()
      .map((group) => ({
        ...group,
        items: group.items.filter((instrument) => {
          if (!keyword) return true
          return (
            instrument.name.toLowerCase().includes(keyword) ||
            instrument.nameEn.toLowerCase().includes(keyword) ||
            instrument.category.toLowerCase().includes(keyword) ||
            instrument.family.toLowerCase().includes(keyword)
          )
        }),
      }))
      .filter((group) => group.items.length > 0)
  }, [query])

  const total = groups.reduce((sum, group) => sum + group.items.length, 0)

  return (
    <div
      ref={panelRef}
      className="z-50 flex max-h-[400px] flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-[0_24px_60px_-16px_rgba(0,0,0,0.9)] animate-fade-up"
      style={style}
      role="dialog"
      aria-label="选择乐器"
    >
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="text-[12.5px] font-semibold">选择乐器</div>
        <button className="btn btn-ghost h-7 w-7 p-0" onClick={onClose} aria-label="关闭">
          <X size={13} />
        </button>
      </header>

      <div className="border-b border-line px-2.5 py-2.5">
        <div className="flex h-8 items-center gap-2 rounded-lg border border-line-strong bg-bg-soft px-2.5 transition-colors focus-within:border-accent/50">
          <Search size={13} className="shrink-0 text-ink-3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索乐器（钢琴 / 弦乐 / 鼓…）"
            aria-label="搜索乐器"
            className="h-full w-full bg-transparent text-[12.5px] outline-none placeholder:text-ink-4"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {groups.length === 0 && <div className="px-2 py-6 text-center text-[11.5px] text-ink-3">没有匹配的乐器</div>}
        {groups.map((group) => (
          <section key={group.family} className="mb-1">
            <div className="flex items-center gap-1.5 px-2 pb-1 pt-1.5">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: FAMILY_COLORS[group.family as keyof typeof FAMILY_COLORS] ?? '#6c7789' }}
              />
              <span className="label">{group.label}</span>
            </div>
            {group.items.map((instrument) => {
              const active = instrument.id === currentId
              const emotions = instrument.emotions.length
              return (
                <button
                  key={instrument.id}
                  onClick={() => onPick(instrument.id)}
                  className={cn(
                    'group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors',
                    active ? 'bg-accent/12' : 'hover:bg-surface-3',
                  )}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line bg-surface-2 text-[15px]">
                    {instrument.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate text-[12.5px] font-medium', active ? 'text-accent-soft' : 'text-ink')}>
                      {instrument.name}
                    </span>
                    <span className="block truncate text-[10.5px] text-ink-3">
                      {instrument.category} · {emotions} 种情绪{instrument.isDrumKit ? ' · 鼓组' : ''}
                    </span>
                  </span>
                  {active && <Check size={13} className="shrink-0 text-accent" />}
                </button>
              )
            })}
          </section>
        ))}
      </div>

      <footer className="flex items-center justify-between border-t border-line px-3 py-2 text-[10.5px] text-ink-4">
        <span>共 {total} 种乐器</span>
        <span>内置合成器 · 可按情绪切换演奏法</span>
      </footer>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 情绪 / 演奏法选择                                                    */
/* ------------------------------------------------------------------ */

export function EmotionPicker({
  instrumentId,
  currentEmotionId,
  onPick,
  onClose,
  style,
}: {
  instrumentId: string
  currentEmotionId: string
  onPick: (emotionId: string) => void
  onClose: () => void
  style: CSSProperties
}) {
  const panelRef = usePopoverDismiss(onClose)
  const instrument = getInstrument(instrumentId)

  return (
    <div
      ref={panelRef}
      className="z-50 overflow-hidden rounded-xl border border-line-strong bg-surface shadow-[0_24px_60px_-16px_rgba(0,0,0,0.9)] animate-fade-up"
      style={style}
      role="dialog"
      aria-label="选择情绪"
    >
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold">情绪 / 演奏法</div>
          <div className="truncate text-[10.5px] text-ink-3">
            {instrument.icon} {instrument.name}
          </div>
        </div>
        <button className="btn btn-ghost h-7 w-7 p-0" onClick={onClose} aria-label="关闭">
          <X size={13} />
        </button>
      </header>
      <div className="px-1.5 py-1.5">
        {instrument.emotions.map((emotion) => {
          const active = emotion.id === currentEmotionId
          return (
            <button
              key={emotion.id}
              onClick={() => onPick(emotion.id)}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors',
                active ? 'bg-accent/12' : 'hover:bg-surface-3',
              )}
              title={emotion.hint}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/40"
                style={{ background: emotion.color }}
              />
              <span className="min-w-0 flex-1">
                <span className={cn('block text-[12.5px] font-medium', active ? 'text-accent-soft' : 'text-ink')}>
                  {emotion.name}
                </span>
                <span className="block truncate text-[10.5px] text-ink-3">{emotion.hint}</span>
              </span>
              {active && <Check size={13} className="shrink-0 text-accent" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}
