import { useEffect, useRef, useState } from 'react'
import { Copy, Headphones, LoaderCircle, Sparkles, Trash2, X } from 'lucide-react'
import { getInstrument } from '@aiab/core'
import { getAudioEngine } from '../../audio'
import { ContextMenu, MenuDivider, MenuItem } from '../../components/ui/menu'
import { ApiError, suggestMix, type MixSuggestResult } from '../../lib/api'
import { cn } from '../../lib/format'
import { MIXER_HEIGHT_LIMITS, useUiStore } from '../../lib/uiStore'
import { useStore } from '../../store/store'
import { clamp, trackColor, withAlpha } from '../arrangement/timeline'
import { AiMixDialog } from './AiMixDialog'
import { DbRuler, MiniKnob, VerticalFader, gainToDbText, levelToDbText } from './controls'

/* ------------------------------------------------------------------ */
/* 尺寸常量（面板高度可拖拽，推子高度随之伸缩）                          */
/* ------------------------------------------------------------------ */

/** 面板固定 chrome：标题栏 34 + 顶部拖拽热区 4 + 底部颜色条 3 */
const MIXER_CHROME = 41
/** 通道条固定 chrome：内边距 / 轨道名 / 声像 / 数值 / M·S / 发送 / 乐器行 */
const STRIP_CHROME = 146
/** 推子区上方的偏移：pt-2(8) + 名称(15) + gap(4) + 声像(20) + gap(4) */
const STRIP_FADER_TOP = 48
const DEFAULT_MIXER_HEIGHT = 318
/** 推子最小高度：再小 dB 标尺与推子帽就挤在一起了 */
const MIN_FADER_HEIGHT = 48

const METER_GRADIENT = 'linear-gradient(to top, #34d399 0%, #a3e635 58%, #f0b429 82%, #f0563b 100%)'

/** 混音器最多占视口高度的比例（窄屏/矮屏时按此收缩，避免吃掉编辑区） */
const MIXER_MAX_VIEWPORT_RATIO = 0.46

/** 当前视口高度：混音器高度按视口收缩（≤46% vh） */
function useViewportHeight(): number {
  const [height, setHeight] = useState(() => (typeof window === 'undefined' ? 900 : window.innerHeight))
  useEffect(() => {
    let raf = 0
    const onResize = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setHeight(window.innerHeight))
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [])
  return height
}

/* ------------------------------------------------------------------ */
/* 通道条                                                              */
/* ------------------------------------------------------------------ */

function ChannelStrip({
  trackId,
  faderHeight,
  dragging,
  meterRef,
  peakRef,
  onDragStateChange,
  onResetPeak,
  onContextMenu,
}: {
  trackId: string
  faderHeight: number
  dragging: boolean
  meterRef: (element: HTMLDivElement | null) => void
  peakRef: (element: HTMLDivElement | null) => void
  onDragStateChange: (trackId: string, dragging: boolean) => void
  onResetPeak: (trackId: string) => void
  onContextMenu: (trackId: string, x: number, y: number) => void
}) {
  const track = useStore((s) => s.project.tracks.find((item) => item.id === trackId))
  const selected = useStore((s) => s.selectedTrackId === trackId)
  const selectTrack = useStore((s) => s.selectTrack)
  const toggleMute = useStore((s) => s.toggleMute)
  const toggleSolo = useStore((s) => s.toggleSolo)
  const pushHistory = useStore((s) => s.pushHistory)
  const setSaveStatus = useStore((s) => s.setSaveStatus)

  const beginEdit = () => {
    pushHistory()
    setSaveStatus('dirty')
  }

  if (!track) return null
  const instrument = getInstrument(track.instrumentId)
  const color = trackColor(track.color)

  return (
    <div
      data-channel-strip={track.id}
      data-track-name={track.name}
      onClick={() => selectTrack(track.id)}
      onContextMenu={(event) => {
        event.preventDefault()
        selectTrack(track.id)
        onContextMenu(track.id, event.clientX, event.clientY)
      }}
      className={cn(
        'group relative flex min-w-[88px] max-w-[144px] flex-1 cursor-default flex-col items-center gap-[3px] overflow-hidden border-r border-line/70 px-2 pb-1.5 pt-1.5 transition-colors',
        selected ? 'bg-surface-2' : 'hover:bg-surface-2/50',
      )}
      title={`${track.name} · ${instrument.name}（右键打开通道菜单）`}
    >
      {/* 顶部颜色条 */}
      <span className="absolute inset-x-0 top-0 h-[2px]" style={{ background: color, opacity: selected ? 1 : 0.55 }} />

      {/* 轨道名 */}
      <div className="flex h-4 w-full items-center gap-1">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span
          className={cn('min-w-0 flex-1 truncate text-[11.5px] font-medium', selected ? 'text-ink' : 'text-ink-2')}
          title={`${track.name} · ${instrument.name}`}
        >
          {track.name}
        </span>
      </div>

      {/* 声像 */}
      <div className="flex h-5 w-full items-center justify-between">
        <span className="text-[9.5px] text-ink-4">PAN</span>
        <MiniKnob
          value={track.pan}
          size={18}
          title="声像"
          accent="#3ddbd9"
          onGestureStart={beginEdit}
          onChange={(value) =>
            useStore.getState().updateTrack(track.id, { pan: clamp(value, -1, 1) }, { history: false })
          }
          formatValue={(value) =>
            Math.abs(value) < 0.03 ? 'C' : `${value < 0 ? 'L' : 'R'}${Math.round(Math.abs(value) * 100)}`
          }
        />
      </div>

      {/* 推子 + 电平表（真实每轨电平） */}
      <div className="flex items-end justify-center gap-1.5" style={{ height: faderHeight }}>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onResetPeak(track.id)
          }}
          aria-label={`${track.name} 通道电平表（点击重置峰值）`}
          title="通道电平（真实）；点击重置峰值"
          className="relative w-2 shrink-0 overflow-hidden rounded-[2px] bg-bg/90 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]"
          style={{ height: faderHeight }}
        >
          <div
            ref={meterRef}
            className="meter-fill absolute bottom-0 left-0 w-full"
            style={{ height: '0%', background: METER_GRADIENT }}
          />
          <div
            ref={peakRef}
            className="pointer-events-none absolute inset-x-0 h-[1px] bg-white/80 opacity-0"
            style={{ bottom: '0%' }}
          />
        </button>
        <div className="shrink-0" style={{ width: 30 }}>
          <VerticalFader
            value={track.volume}
            height={faderHeight}
            min={0}
            max={1.5}
            taper="db"
            resetValue={1}
            title="音量"
            formatValue={(value) => `${Math.round(value * 100)}%`}
            bubbleFormatter={(value) => `${gainToDbText(value)} dB`}
            onGestureStart={beginEdit}
            onDragStateChange={(next) => onDragStateChange(track.id, next)}
            onCommit={() => setSaveStatus('dirty')}
            onChange={(value) =>
              useStore.getState().updateTrack(track.id, { volume: clamp(value, 0, 1.5) }, { history: false })
            }
          />
        </div>
      </div>

      {/* 音量数值：拖动时显示 dB，松手恢复百分比 */}
      <div
        className={cn(
          'mono h-[14px] w-full truncate text-center text-[10.5px] tabular-nums',
          dragging ? 'text-accent-soft' : 'text-ink-2',
        )}
        data-volume-db={gainToDbText(track.volume)}
        title={`音量 ${gainToDbText(track.volume)} dB`}
      >
        {dragging ? `${gainToDbText(track.volume)} dB` : `${Math.round(track.volume * 100)}%`}
      </div>

      {/* M / S */}
      <div className="flex h-[19px] w-full items-center gap-1">
        <button
          onClick={(event) => {
            event.stopPropagation()
            toggleMute(track.id)
            useStore.getState().setSaveStatus('dirty')
          }}
          title="静音"
          aria-pressed={track.mute}
          aria-label={`${track.name} 静音`}
          className={cn(
            'flex h-[19px] flex-1 items-center justify-center rounded-[5px] border text-[10px] font-bold transition-colors',
            track.mute
              ? 'border-danger/60 bg-danger/25 text-danger'
              : 'border-line-strong bg-surface-2 text-ink-4 hover:text-ink-2',
          )}
        >
          M
        </button>
        <button
          onClick={(event) => {
            event.stopPropagation()
            toggleSolo(track.id)
            useStore.getState().setSaveStatus('dirty')
          }}
          title="独奏"
          aria-pressed={track.solo}
          aria-label={`${track.name} 独奏`}
          className={cn(
            'flex h-[19px] flex-1 items-center justify-center rounded-[5px] border text-[10px] font-bold transition-colors',
            track.solo
              ? 'border-accent/60 bg-accent/25 text-accent'
              : 'border-line-strong bg-surface-2 text-ink-4 hover:text-ink-2',
          )}
        >
          S
        </button>
      </div>

      {/* 发送 */}
      <div className="flex h-4 w-full items-center justify-between">
        <span className="text-[9.5px] text-ink-4">REV</span>
        <MiniKnob
          value={track.reverbSend}
          min={0}
          max={1}
          size={16}
          title="混响发送"
          center={0.18}
          accent="#8b7bff"
          onGestureStart={beginEdit}
          onChange={(value) =>
            useStore.getState().updateTrack(track.id, { reverbSend: clamp(value, 0, 1) }, { history: false })
          }
          formatValue={(value) => `${Math.round(value * 100)}`}
        />
      </div>
      <div className="flex h-4 w-full items-center justify-between">
        <span className="text-[9.5px] text-ink-4">DLY</span>
        <MiniKnob
          value={track.delaySend}
          min={0}
          max={1}
          size={16}
          title="延迟发送"
          center={0.06}
          accent="#4ea1ff"
          onGestureStart={beginEdit}
          onChange={(value) =>
            useStore.getState().updateTrack(track.id, { delaySend: clamp(value, 0, 1) }, { history: false })
          }
          formatValue={(value) => `${Math.round(value * 100)}`}
        />
      </div>

      {/* 乐器 */}
      <div className="h-3 w-full truncate text-center text-[9.5px] text-ink-4" title={instrument.name}>
        {instrument.icon} {instrument.name}
      </div>

      {/* 底部颜色条 */}
      <span
        className="absolute inset-x-0 bottom-0 h-[2px]"
        style={{ background: color, opacity: selected ? 0.95 : 0.5 }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 混音器                                                              */
/* ------------------------------------------------------------------ */

export function MixerPanel() {
  const tracks = useStore((s) => s.project.tracks)
  const masterVolume = useStore((s) => s.project.masterVolume)
  const setMasterVolume = useStore((s) => s.setMasterVolume)
  const setShowMixer = useStore((s) => s.setShowMixer)
  const pushHistory = useStore((s) => s.pushHistory)
  const setSaveStatus = useStore((s) => s.setSaveStatus)
  const pushToast = useStore((s) => s.pushToast)

  /* AI 混音：请求中按钮禁用+转圈，成功后才弹出只读预览面板 */
  const [aiMixLoading, setAiMixLoading] = useState(false)
  const [aiMixResult, setAiMixResult] = useState<MixSuggestResult | null>(null)

  const requestAiMix = async () => {
    if (aiMixLoading) return
    setAiMixLoading(true)
    try {
      // 用当前时刻的工程发起请求（面板打开后即固定为这次请求的结果）
      const result = await suggestMix(useStore.getState().project)
      setAiMixResult(result)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        pushToast('error', '混音接口未就绪（404），请确认后端已更新并重启')
      } else if (error instanceof ApiError) {
        pushToast('error', error.detail || error.message || `混音方案生成失败（${error.status}）`)
      } else {
        pushToast('error', error instanceof Error ? error.message : '混音方案生成失败，请稍后重试')
      }
    } finally {
      setAiMixLoading(false)
    }
  }

  const mixerHeight = useUiStore((s) => s.mixerHeight)
  const setMixerHeight = useUiStore((s) => s.setMixerHeight)

  const beginEdit = () => {
    pushHistory()
    setSaveStatus('dirty')
  }

  const viewportHeight = useViewportHeight()
  // 视口收缩：持久化的 mixerHeight 只在空间足够时生效
  const maxHeightByViewport = Math.max(180, Math.round(viewportHeight * MIXER_MAX_VIEWPORT_RATIO))
  /* 固定 chrome + 最小推子 = 混音器能正常显示的最小高度；低于它宁可不缩，也不让通道条底部被裁掉 */
  const minFeasibleHeight = MIXER_CHROME + STRIP_CHROME + MIN_FADER_HEIGHT
  const effectiveHeight = Math.max(
    Math.min(mixerHeight, maxHeightByViewport),
    Math.min(minFeasibleHeight, maxHeightByViewport),
  )
  const faderHeight = clamp(effectiveHeight - MIXER_CHROME - STRIP_CHROME, MIN_FADER_HEIGHT, 260)

  /* 高度拖拽 */
  const resizeDrag = useRef<{ startY: number; startHeight: number } | null>(null)
  const [resizing, setResizing] = useState(false)

  /* 展开过渡（尊重 reduced-motion） */
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setEntered(true)
      return
    }
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  /* 通道区横向溢出检测（滚动条 / 渐变提示） */
  useEffect(() => {
    const element = channelsScrollRef.current
    if (!element) return
    const update = () => setChannelsScrollable(element.scrollWidth - element.clientWidth > 2)
    update()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    observer?.observe(element)
    element.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      element.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [tracks.length, effectiveHeight])

  /* 通道右键菜单 */
  const [menu, setMenu] = useState<{ trackId: string; x: number; y: number } | null>(null)
  const menuTrack = menu ? tracks.find((track) => track.id === menu.trackId) : undefined

  /* 通道条电平动画：单条 rAF 直接改 DOM style，避免每帧 setState */
  const meterRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const peakRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const smoothedRef = useRef<Map<string, number>>(new Map())
  const peaksRef = useRef<Map<string, number>>(new Map())
  const peakAtRef = useRef<Map<string, number>>(new Map())
  const [draggingTrackId, setDraggingTrackId] = useState<string | null>(null)

  /* 通道区是否横向溢出：用于显示滚动条与右缘渐变提示（不隐藏溢出） */
  const channelsScrollRef = useRef<HTMLDivElement>(null)
  const [channelsScrollable, setChannelsScrollable] = useState(false)

  const masterMeterRef = useRef<HTMLDivElement>(null)
  const masterPeakRef = useRef<HTMLDivElement>(null)
  const masterPeakDbRef = useRef<HTMLSpanElement>(null)
  const masterLimRef = useRef<HTMLSpanElement>(null)
  const masterSmoothRef = useRef(0)
  const masterPeakValueRef = useRef(0)
  const masterPeakAtRef = useRef(0)

  useEffect(() => {
    const engine = getAudioEngine()
    const hasTrackLevels = typeof engine.getTrackLevels === 'function'
    let raf = 0
    let last = performance.now()

    const tick = (now: number) => {
      const dt = Math.min(64, now - last)
      last = now
      const state = useStore.getState()
      const anySolo = state.project.tracks.some((track) => track.solo)

      let levels: Record<string, number> = {}
      if (hasTrackLevels) {
        try {
          levels = engine.getTrackLevels?.() ?? {}
        } catch {
          levels = {}
        }
      }
      let masterLevel = 0
      try {
        masterLevel = engine.getMeterLevel() || 0
      } catch {
        masterLevel = 0
      }

      for (const track of state.project.tracks) {
        const fill = meterRefs.current[track.id]
        const peakEl = peakRefs.current[track.id]
        if (!fill && !peakEl) continue
        const audible = !track.mute && (!anySolo || track.solo)
        const target = audible
          ? hasTrackLevels
            ? clamp(levels[track.id] ?? 0, 0, 1)
            : // 引擎没有每轨电平接口时的降级估算（master × 轨道音量）
              clamp(masterLevel * (track.volume / 1.5) * 1.35, 0, 1)
          : 0
        const previous = smoothedRef.current.get(track.id) ?? 0
        // 上升快、回落慢
        const next = target > previous ? target : Math.max(target, previous - dt * 0.0024)
        smoothedRef.current.set(track.id, next)
        if (fill) fill.style.height = `${(next * 100).toFixed(1)}%`

        const previousPeak = peaksRef.current.get(track.id) ?? 0
        if (next >= previousPeak) {
          peaksRef.current.set(track.id, next)
          peakAtRef.current.set(track.id, now)
        } else if (now - (peakAtRef.current.get(track.id) ?? 0) > 850) {
          peaksRef.current.set(track.id, Math.max(next, previousPeak - dt * 0.0013))
        }
        const peak = peaksRef.current.get(track.id) ?? 0
        if (peakEl) {
          peakEl.style.bottom = `${Math.min(99.5, peak * 100).toFixed(1)}%`
          peakEl.style.opacity = peak > 0.01 ? '1' : '0'
        }
      }

      /* 主输出：电平 + 峰值保持 + limiter 指示 */
      const previousMaster = masterSmoothRef.current
      masterSmoothRef.current =
        masterLevel > previousMaster ? masterLevel : Math.max(masterLevel, previousMaster - dt * 0.0024)
      const masterShown = masterSmoothRef.current
      if (masterShown >= masterPeakValueRef.current) {
        masterPeakValueRef.current = masterShown
        masterPeakAtRef.current = now
      } else if (now - masterPeakAtRef.current > 850) {
        masterPeakValueRef.current = Math.max(masterShown, masterPeakValueRef.current - dt * 0.0013)
      }
      const masterPeak = masterPeakValueRef.current
      if (masterMeterRef.current) masterMeterRef.current.style.height = `${(masterShown * 100).toFixed(1)}%`
      if (masterPeakRef.current) {
        masterPeakRef.current.style.bottom = `${Math.min(99.5, masterPeak * 100).toFixed(1)}%`
        masterPeakRef.current.style.opacity = masterPeak > 0.01 ? '1' : '0'
      }
      if (masterPeakDbRef.current) masterPeakDbRef.current.textContent = levelToDbText(masterPeak, 1)
      if (masterLimRef.current) {
        // limiter 在 -1 dB 处工作：峰值电平 ≈ 0.983 以上点亮
        masterLimRef.current.style.opacity = masterPeak >= 0.983 ? '1' : '0.22'
      }

      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const resetPeak = (trackId: string) => {
    peaksRef.current.set(trackId, smoothedRef.current.get(trackId) ?? 0)
    peakAtRef.current.set(trackId, performance.now())
  }

  const resetMasterPeak = () => {
    masterPeakValueRef.current = masterSmoothRef.current
    masterPeakAtRef.current = performance.now()
  }

  const registerMeter = (trackId: string) => (element: HTMLDivElement | null) => {
    meterRefs.current[trackId] = element
  }
  const registerPeak = (trackId: string) => (element: HTMLDivElement | null) => {
    peakRefs.current[trackId] = element
  }

  /* ---------------- 高度拖拽 ---------------- */

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    // 从「实际显示高度」开始拖，避免视口收缩后拖拽一段距离没有反馈
    resizeDrag.current = { startY: event.clientY, startHeight: effectiveHeight }
    setResizing(true)
  }

  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = resizeDrag.current
    if (!drag) return
    setMixerHeight(drag.startHeight + (drag.startY - event.clientY))
  }

  const endResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    resizeDrag.current = null
    setResizing(false)
  }

  return (
    <div
      data-mixer-panel=""
      data-mixer-height={effectiveHeight}
      className="relative z-20 flex w-full shrink-0 flex-col overflow-hidden border-t border-line-strong bg-[linear-gradient(180deg,#10141c,#0b0e14)] shadow-[0_-28px_70px_-24px_rgba(0,0,0,0.95)]"
      style={{
        height: effectiveHeight,
        transform: entered ? 'translateY(0)' : 'translateY(100%)',
        transition: resizing ? 'none' : 'height 160ms ease-out, transform 240ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      {/* 通道区滚动条样式：只作用于混音器（不改全局 CSS） */}
      <style>{`
        .mixer-channels { scrollbar-width: thin; scrollbar-color: #3b4557 #0b0e14; }
        .mixer-channels::-webkit-scrollbar { height: 9px; }
        .mixer-channels::-webkit-scrollbar-track { background: #0b0e14; }
        .mixer-channels::-webkit-scrollbar-thumb { background: #2f3848; border: 2px solid #0b0e14; border-radius: 999px; }
        .mixer-channels::-webkit-scrollbar-thumb:hover { background: rgba(240, 180, 41, 0.55); }
      `}</style>

      {/* 顶部 4px 拖拽热区：改混音器高度（持久化到 uiStore） */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="拖动调整混音器高度"
        title={`拖动调整混音器高度（${MIXER_HEIGHT_LIMITS.min}–${MIXER_HEIGHT_LIMITS.max}px，最多 ${Math.round(MIXER_MAX_VIEWPORT_RATIO * 100)}% 视口高；双击恢复默认）`}
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onDoubleClick={() => setMixerHeight(DEFAULT_MIXER_HEIGHT)}
        className="group/resize absolute inset-x-0 top-0 z-30 h-[4px] cursor-ns-resize"
      >
        <span className="absolute left-1/2 top-[1px] h-[2px] w-10 -translate-x-1/2 rounded-full bg-line-strong/70 transition-colors group-hover/resize:bg-accent/70" />
      </div>

      {/* 标题栏 */}
      <header className="flex h-[34px] min-w-0 shrink-0 items-center gap-2 overflow-hidden border-b border-line px-3">
        <Headphones size={14} className="shrink-0 text-accent" />
        <span className="shrink-0 whitespace-nowrap text-[12.5px] font-semibold">混音器</span>
        <span className="shrink-0 whitespace-nowrap text-[11px] text-ink-4">
          {tracks.length} 条通道 · 真实每轨电平
        </span>
        <div className="flex-1" />
        <span className="hidden min-w-0 truncate text-right text-[10.5px] text-ink-4 min-[1280px]:block">
          右键通道条：复制/删除/静音/独奏 · 点击电平表重置峰值 · 拖动顶部边缘调整高度
        </span>
        <button
          type="button"
          data-ai-mix-trigger=""
          className="btn btn-ghost h-7 shrink-0 gap-1 whitespace-nowrap px-2 text-[11.5px]"
          onClick={() => void requestAiMix()}
          disabled={aiMixLoading}
          aria-label="AI 混音：生成混音方案预览"
          aria-busy={aiMixLoading}
          title="AI 混音：按声部角色/风格/能量生成方案，可预览、一步撤销"
        >
          {aiMixLoading ? (
            <LoaderCircle size={12} className="shrink-0 animate-spin text-accent" />
          ) : (
            <Sparkles size={12} className="shrink-0 text-accent" />
          )}
          {aiMixLoading ? '生成中…' : 'AI 混音…'}
        </button>
        <button
          className="btn btn-ghost h-7 shrink-0 whitespace-nowrap px-2 text-[11.5px]"
          onClick={() => setShowMixer(false)}
          title="收起混音器（⌘⇧M）"
        >
          <X size={12} />
          收起
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 通道条（横向滚动：滚动条可见 + 右缘渐变提示；dB 标尺吸附在左侧） */}
        <div className="relative flex min-w-0 flex-1">
          <div
            ref={channelsScrollRef}
            className="mixer-channels flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
            data-mixer-channels=""
          >
          {tracks.length === 0 ? (
            <div className="flex h-full w-full items-center justify-center text-[11.5px] text-ink-3">
              还没有轨道，先在左侧添加一条轨道
            </div>
          ) : (
            <div className="flex h-full">
              <div
                className="sticky left-0 z-10 flex shrink-0 flex-col items-center bg-[#0b0e14] pr-1"
                style={{ paddingTop: STRIP_FADER_TOP }}
                aria-hidden="true"
              >
                <DbRuler height={faderHeight} max={1.5} />
              </div>
              {tracks.map((track) => (
                <ChannelStrip
                  key={track.id}
                  trackId={track.id}
                  faderHeight={faderHeight}
                  dragging={draggingTrackId === track.id}
                  meterRef={registerMeter(track.id)}
                  peakRef={registerPeak(track.id)}
                  onDragStateChange={(trackId, next) => setDraggingTrackId(next ? trackId : null)}
                  onResetPeak={resetPeak}
                  onContextMenu={(trackId, x, y) => setMenu({ trackId, x, y })}
                />
              ))}
              <div className="w-6 shrink-0" />
            </div>
          )}
          </div>
          {channelsScrollable && (
            <div
              className="pointer-events-none absolute inset-y-0 right-0 w-7 bg-[linear-gradient(to_right,rgba(11,14,20,0),rgba(11,14,20,0.92))]"
              aria-hidden="true"
            />
          )}
        </div>

        {/* 主输出 */}
        <div
          data-master-strip=""
          className="flex w-[138px] shrink-0 flex-col items-center border-l border-line-strong bg-surface/60 px-2 py-2"
        >
          <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-accent">
            <span className="h-2 w-2 rounded-full bg-accent" />
            MASTER
          </div>
          <div className="mono mt-1 text-[10.5px] tabular-nums text-ink-2" data-master-gain-db="" title="主音量增益（dB）">
            {gainToDbText(masterVolume)} dB
          </div>

          <div className="mt-1 flex items-end justify-center gap-1">
            <DbRuler height={faderHeight} max={1.5} className="w-[24px]" />
            <button
              type="button"
              onClick={resetMasterPeak}
              aria-label="主输出电平表（点击重置峰值）"
              title="主输出电平（真实）；点击重置峰值"
              className="relative w-2 shrink-0 overflow-hidden rounded-[2px] bg-bg/90 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]"
              style={{ height: faderHeight }}
            >
              <div
                ref={masterMeterRef}
                className="meter-fill absolute bottom-0 left-0 w-full"
                style={{ height: '0%', background: METER_GRADIENT }}
              />
              <div
                ref={masterPeakRef}
                className="pointer-events-none absolute inset-x-0 h-[1px] bg-white/80 opacity-0"
                style={{ bottom: '0%' }}
              />
            </button>
            <div className="shrink-0" style={{ width: 30 }}>
              <VerticalFader
                value={masterVolume}
                height={faderHeight}
                min={0}
                max={1.5}
                taper="db"
                resetValue={1}
                title="主音量"
                formatValue={(value) => `${Math.round(value * 100)}%`}
                bubbleFormatter={(value) => `${gainToDbText(value)} dB`}
                onGestureStart={beginEdit}
                onCommit={() => setSaveStatus('dirty')}
                onChange={(value) => setMasterVolume(clamp(value, 0, 1.5))}
              />
            </div>
          </div>

          {/* 峰值数值 + limiter 指示 */}
          <div className="mt-1 w-full rounded-md border border-line bg-bg-soft px-1.5 py-1 text-center">
            <div className="flex items-center justify-between">
              <span className="text-[9.5px] text-ink-4">峰值</span>
              <span className="mono text-[10.5px] tabular-nums text-ink-2">
                <span ref={masterPeakDbRef} data-master-peak-db="" aria-label="主输出峰值（dB）">-∞</span>
                <span className="ml-0.5 text-[9.5px] text-ink-4">dB</span>
              </span>
            </div>
            <div className="mt-0.5 flex items-center justify-center gap-1">
              <span
                ref={masterLimRef}
                className="mono rounded-[3px] border border-danger/50 bg-danger/15 px-1 text-[9.5px] font-bold tracking-wider text-danger opacity-[0.22] transition-opacity"
                title="limiter 指示：主输出接近 -1 dB 时点亮"
              >
                LIM
              </span>
              <span className="text-[9.5px] text-ink-4">-1 dB</span>
            </div>
          </div>

          <div className="mt-auto pb-0.5 text-center text-[9.5px] leading-tight text-ink-4">
            主输出电平
            <br />
            真实峰值保持
          </div>
        </div>
      </div>

      {/* 底部颜色条（呼应通道色） */}
      <div className="flex h-[3px] shrink-0">
        {tracks.slice(0, 40).map((track) => (
          <span key={track.id} className="flex-1" style={{ background: withAlpha(trackColor(track.color), 0.55) }} />
        ))}
      </div>

      {/* 通道右键菜单 */}
      {menu && menuTrack && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          label={`${menuTrack.name} · 通道`}
          width={204}
        >
          <MenuItem
            icon={<Copy size={11} />}
            label="复制轨道"
            hint="⌘D"
            onClick={() => {
              useStore.getState().duplicateTrack(menuTrack.id)
              setMenu(null)
            }}
          />
          <MenuItem
            icon={<Trash2 size={11} />}
            label="删除轨道"
            danger
            onClick={() => {
              useStore.getState().removeTrack(menuTrack.id)
              setMenu(null)
            }}
          />
          <MenuDivider />
          <MenuItem
            label="静音"
            checked={menuTrack.mute}
            onClick={() => {
              useStore.getState().toggleMute(menuTrack.id)
              useStore.getState().setSaveStatus('dirty')
              setMenu(null)
            }}
          />
          <MenuItem
            label="独奏"
            checked={menuTrack.solo}
            onClick={() => {
              useStore.getState().toggleSolo(menuTrack.id)
              useStore.getState().setSaveStatus('dirty')
              setMenu(null)
            }}
          />
          <MenuDivider />
          <MenuItem
            label="重置声像"
            hint="C"
            onClick={() => {
              useStore.getState().updateTrack(menuTrack.id, { pan: 0 })
              setMenu(null)
            }}
          />
          <MenuItem
            label="重置音量"
            hint="0.0 dB"
            onClick={() => {
              useStore.getState().updateTrack(menuTrack.id, { volume: 1 })
              setMenu(null)
            }}
          />
        </ContextMenu>
      )}

      {/* AI 混音只读预览（portal + z-[200]；应用走 store 一条撤销记录） */}
      {aiMixResult && <AiMixDialog result={aiMixResult} onClose={() => setAiMixResult(null)} />}
    </div>
  )
}
