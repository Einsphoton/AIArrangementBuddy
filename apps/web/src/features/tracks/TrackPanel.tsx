/**
 * 左侧轨道面板：轨道头列表 + 行高工具条。
 *
 * 与编曲视图严格对齐的三段结构（相对主编辑区顶部）：
 *   38px 标题栏（对齐主编辑区 tab 栏）
 *   38px 行高工具条（对齐编曲视图的时间轴工具条）
 *   54px 标尺占位（对齐 LOOP/SECT/BAR 标尺）
 * 因此两边的第 N 条轨道在同一 y 位置，且共用 uiStore.trackHeights 的行高。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Minus,
  Plus,
  Trash2,
} from 'lucide-react'
import { getInstrument } from '@aiab/core'
import { getAudioEngine } from '../../audio'
import { Badge, EmptyState, IconButton } from '../../components/ui'
import { useStore } from '../../store/store'
import { resolveTrackHeight, TRACK_HEIGHT_LIMITS, useUiStore } from '../../lib/uiStore'
import {
  clamp,
  MAX_ZOOM_Y,
  MIN_ZOOM_Y,
  publishVerticalScroll,
  RULER_HEIGHT,
  rowHeightForZoom,
  subscribeVerticalScroll,
} from '../arrangement/timeline'
import { EmotionPicker, InstrumentPicker, popoverPosition } from './InstrumentPicker'
import { TrackRow, type DropTarget } from './TrackRow'
import { GenerationTrackHeader } from '../audio/GenerationTrack'
import { useAudioJobStore } from '../audio/audioJobStore'

type PickerState =
  | { kind: 'instrument'; mode: 'new'; rect: DOMRect }
  | { kind: 'instrument'; mode: 'change'; rect: DOMRect; trackId: string }
  | { kind: 'emotion'; rect: DOMRect; trackId: string }

export function TrackPanel() {
  const tracks = useStore((s) => s.project.tracks)
  const selectedTrackId = useStore((s) => s.selectedTrackId)
  const zoomY = useStore((s) => s.zoomY)
  const selectTrack = useStore((s) => s.selectTrack)
  const addTrack = useStore((s) => s.addTrack)
  const removeTrack = useStore((s) => s.removeTrack)
  const duplicateTrack = useStore((s) => s.duplicateTrack)
  const setTrackInstrument = useStore((s) => s.setTrackInstrument)
  const setZoom = useStore((s) => s.setZoom)
  const pushToast = useStore((s) => s.pushToast)
  const commitReorder = useStore((s) => s.mutate)
  const pushHistory = useStore((s) => s.pushHistory)
  const setSaveStatus = useStore((s) => s.setSaveStatus)
  const trackHeights = useUiStore((s) => s.trackHeights)
  /* 生成中的占位轨：编曲车道与轨道头同步出现，落轨后逐条移除 */
  const generationSlots = useAudioJobStore((s) => s.slots)
  const audioJob = useAudioJobStore((s) => s.job)

  const listRef = useRef<HTMLDivElement>(null)
  /* 每轨电平：单条 rAF 直接改 DOM style（与 MixerPanel 同一策略），不触发 React 重渲染 */
  const meterRefs = useRef<Record<string, HTMLSpanElement | null>>({})
  const meterLevels = useRef<Map<string, number>>(new Map())
  const [picker, setPicker] = useState<PickerState | null>(null)
  const [dragTrackId, setDragTrackId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [renameRequest, setRenameRequest] = useState<{ trackId: string; token: number } | null>(null)

  const fallbackRowHeight = rowHeightForZoom(zoomY)
  const clipCount = tracks.reduce((sum, track) => sum + track.clips.length, 0)
  const noteCount = tracks.reduce(
    (sum, track) => sum + track.clips.reduce((count, clip) => count + clip.notes.length, 0),
    0,
  )

  /* 与编曲视图的纵向滚动同步 */
  useEffect(() => {
    return subscribeVerticalScroll((top, source) => {
      const element = listRef.current
      if (!element || source === 'tracks') return
      if (Math.abs(element.scrollTop - top) > 1) element.scrollTop = top
    })
  }, [])

  const registerMeter = useCallback((trackId: string, element: HTMLSpanElement | null) => {
    if (element) meterRefs.current[trackId] = element
    else delete meterRefs.current[trackId]
  }, [])

  /* 每轨真实电平（engine.getTrackLevels，0..1）：单条 rAF 写入 DOM，不 setState */
  useEffect(() => {
    const engine = getAudioEngine()
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(64, now - last)
      last = now
      const state = useStore.getState()
      const anySolo = state.project.tracks.some((track) => track.solo)
      const hasTrackLevels = typeof engine.getTrackLevels === 'function'
      let levels: Record<string, number> = {}
      if (hasTrackLevels) {
        try {
          levels = engine.getTrackLevels?.() ?? {}
        } catch {
          levels = {}
        }
      }
      let masterLevel = 0
      if (!hasTrackLevels) {
        try {
          masterLevel = engine.getMeterLevel() || 0
        } catch {
          masterLevel = 0
        }
      }
      for (const track of state.project.tracks) {
        const fill = meterRefs.current[track.id]
        if (!fill) continue
        const audible = !track.mute && (!anySolo || track.solo)
        const target = audible
          ? hasTrackLevels
            ? clamp(levels[track.id] ?? 0, 0, 1)
            : clamp(masterLevel * (track.volume / 1.5) * 1.35, 0, 1)
          : 0
        const previous = meterLevels.current.get(track.id) ?? 0
        // 上升快、回落慢，与混音器通道表一致
        const next = target > previous ? target : Math.max(target, previous - dt * 0.0026)
        meterLevels.current.set(track.id, next)
        fill.style.height = `${(next * 100).toFixed(1)}%`
        const wrap = fill.parentElement
        if (wrap) wrap.dataset.level = next.toFixed(2)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  /* 命令面板 / 全局快捷键的「重命名轨道」命令 → 让对应轨道头进入重命名 */
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ trackId?: string }>).detail
      if (!detail?.trackId) return
      setRenameRequest((previous) => ({ trackId: detail.trackId as string, token: (previous?.token ?? 0) + 1 }))
    }
    window.addEventListener('aiab:track-rename', handler)
    return () => window.removeEventListener('aiab:track-rename', handler)
  }, [])

  const handleScroll = () => {
    const element = listRef.current
    if (element) publishVerticalScroll(element.scrollTop, 'tracks')
  }

  const openInstrumentPicker = (rect: DOMRect) => setPicker({ kind: 'instrument', mode: 'new', rect })
  const openInstrumentForTrack = (trackId: string, rect: DOMRect) =>
    setPicker({ kind: 'instrument', mode: 'change', rect, trackId })
  const openEmotionForTrack = (trackId: string, rect: DOMRect) =>
    setPicker({ kind: 'emotion', rect, trackId })

  const closePicker = () => setPicker(null)

  const collapseAll = () => {
    const ui = useUiStore.getState()
    for (const track of tracks) ui.setTrackHeight(track.id, TRACK_HEIGHT_LIMITS.collapsed)
  }

  const expandAll = () => {
    useUiStore.getState().resetTrackHeights()
  }

  const reorder = (trackId: string, targetIndex: number) => {
    const current = useStore.getState().project.tracks
    const from = current.findIndex((track) => track.id === trackId)
    if (from < 0) return
    let to = targetIndex
    if (from < to) to -= 1
    to = Math.max(0, Math.min(current.length - 1, to))
    if (to === from) return
    pushHistory()
    setSaveStatus('dirty')
    commitReorder(
      (draft) => {
        const [moved] = draft.tracks.splice(from, 1)
        if (moved) draft.tracks.splice(to, 0, moved)
      },
      { history: false },
    )
  }

  const handleDragOverRow = (event: React.DragEvent<HTMLDivElement>, index: number) => {
    if (!dragTrackId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const after = event.clientY - rect.top > rect.height / 2
    setDropTarget((previous) =>
      previous && previous.index === index && previous.after === after ? previous : { index, after },
    )
  }

  const handleDropRow = (event: React.DragEvent<HTMLDivElement>, index: number) => {
    event.preventDefault()
    const sourceId = dragTrackId ?? event.dataTransfer.getData('text/plain')
    const rect = event.currentTarget.getBoundingClientRect()
    const after = event.clientY - rect.top > rect.height / 2
    if (sourceId) reorder(sourceId, index + (after ? 1 : 0))
    setDragTrackId(null)
    setDropTarget(null)
  }

  return (
    <aside className="relative flex w-[264px] shrink-0 flex-col border-r border-line bg-surface" data-track-panel>
      {/* 标题栏（与主编辑区 tab 栏同高 38px） */}
      <header className="flex h-[38px] shrink-0 items-center gap-1.5 border-b border-line px-2.5">
        <span className="label">轨道</span>
        <Badge>{tracks.length}</Badge>
        {generationSlots.length > 0 && (
          <span
            data-gen-track-count
            className="inline-flex h-[16px] shrink-0 items-center gap-1 rounded-full border border-accent/35 bg-accent/10 px-1.5 text-[10px] font-semibold leading-none text-accent-soft"
            title={`AI 正在生成 ${generationSlots.length} 条音频轨`}
            aria-label={`AI 正在生成 ${generationSlots.length} 条音频轨`}
          >
            <span className="gen-live-dot" aria-hidden />
            AI +{generationSlots.length}
          </span>
        )}
        <div className="flex-1" />
        <IconButton
          title="添加轨道"
          onClick={(event) => openInstrumentPicker(event.currentTarget.getBoundingClientRect())}
          className="h-7 w-7"
        >
          <Plus size={13} />
        </IconButton>
        <IconButton
          title="复制选中轨道"
          disabled={!selectedTrackId}
          onClick={() => {
            if (selectedTrackId) {
              duplicateTrack(selectedTrackId)
              pushToast('success', '已复制轨道')
            }
          }}
          className="h-7 w-7"
        >
          <Copy size={12} />
        </IconButton>
        <IconButton
          title="删除选中轨道"
          disabled={!selectedTrackId}
          onClick={() => {
            if (!selectedTrackId) return
            const track = tracks.find((item) => item.id === selectedTrackId)
            removeTrack(selectedTrackId)
            pushToast('info', `已删除轨道「${track?.name ?? ''}」`)
          }}
          className="h-7 w-7 hover:text-danger"
        >
          <Trash2 size={12} />
        </IconButton>
      </header>

      {/* 行高工具条（与编曲视图时间轴工具条同高 38px，保证行严格对齐） */}
      <div
        className="flex h-[38px] shrink-0 items-center gap-0.5 border-b border-line bg-surface px-2"
        data-track-toolbar
        aria-label="轨道行高工具条"
        title="轨道行高：拖动轨道头底部 4px 可单独调整；这里统一折叠/展开与纵向缩放"
      >
        <IconButton title="全部折叠（26px）" onClick={collapseAll} className="h-7 w-7 shrink-0">
          <ChevronsDownUp size={12} />
        </IconButton>
        <IconButton title="展开全部（跟随纵向缩放）" onClick={expandAll} className="h-7 w-7 shrink-0">
          <ChevronsUpDown size={12} />
        </IconButton>
        <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
        <IconButton
          title="纵向缩放：减小行高"
          onClick={() => setZoom(undefined, clamp(zoomY - 1, MIN_ZOOM_Y, MAX_ZOOM_Y))}
          className="h-7 w-7 shrink-0"
        >
          <Minus size={12} />
        </IconButton>
        <span className="mono w-[34px] shrink-0 text-center text-[10.5px] tabular-nums text-ink-4" title="默认行高">
          {fallbackRowHeight}px
        </span>
        <IconButton
          title="纵向缩放：增大行高"
          onClick={() => setZoom(undefined, clamp(zoomY + 1, MIN_ZOOM_Y, MAX_ZOOM_Y))}
          className="h-7 w-7 shrink-0"
        >
          <Plus size={12} />
        </IconButton>
        <div className="flex-1" />
      </div>

      {/* 与编曲视图标尺对齐的副标题 */}
      <div
        className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-2.5"
        style={{ height: RULER_HEIGHT }}
      >
        <div className="min-w-0">
          <div className="label">轨道 / 乐器</div>
          <div className="mt-0.5 text-[10.5px] text-ink-4">
            {clipCount} 片段 · {noteCount} 音符
          </div>
        </div>
        <div className="shrink-0 text-right text-[10px] leading-tight text-ink-4">
          拖色条排序
          <br />
          右键更多操作
        </div>
      </div>

      {/* 轨道列表 */}
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        aria-label="轨道列表"
      >
        {tracks.length === 0 && generationSlots.length === 0 ? (
          <EmptyState
            icon={<Plus size={20} />}
            title="还没有轨道"
            hint="添加一条轨道，开始你的编曲。可以先用钢琴打底，再加鼓组与贝斯。"
            action={
              <button
                className="btn btn-accent mt-1 h-7 px-2.5 text-[11.5px]"
                onClick={(event) => openInstrumentPicker(event.currentTarget.getBoundingClientRect())}
              >
                <Plus size={12} />
                <span className="text-[11.5px]">添加第一条轨道</span>
              </button>
            }
          />
        ) : (
          <>
            {tracks.map((track, index) => (
              <TrackRow
                key={track.id}
                track={track}
                index={index}
                height={resolveTrackHeight(trackHeights, track.id, fallbackRowHeight)}
                selected={track.id === selectedTrackId}
                dropTarget={dropTarget}
                renameSignal={renameRequest?.trackId === track.id ? renameRequest.token : 0}
                registerMeter={registerMeter}
                onSelect={() => selectTrack(track.id)}
                onOpenInstrument={(rect) => openInstrumentForTrack(track.id, rect)}
                onOpenEmotion={(rect) => openEmotionForTrack(track.id, rect)}
                onDragStart={(trackId) => {
                  setDragTrackId(trackId)
                  setDropTarget(null)
                }}
                onDragEnd={() => {
                  setDragTrackId(null)
                  setDropTarget(null)
                }}
                onDragOver={(event) => handleDragOverRow(event, index)}
                onDrop={(event) => handleDropRow(event, index)}
              />
            ))}
            {generationSlots.map((slot) => (
              <GenerationTrackHeader
                key={slot.id}
                slot={slot}
                job={audioJob}
                height={resolveTrackHeight(trackHeights, slot.id, fallbackRowHeight)}
              />
            ))}
            <button
              onClick={(event) => openInstrumentPicker(event.currentTarget.getBoundingClientRect())}
              className="group flex h-9 w-full items-center justify-center gap-1.5 border-b border-line/60 text-[11.5px] text-ink-4 transition-colors hover:bg-surface-3/50 hover:text-ink-2"
              title="添加轨道"
            >
              <Plus size={12} />
              <span className="text-[11.5px]">添加轨道</span>
            </button>
            {/* 底部留白 58px：36(添加轨道按钮) + 58 = 94 = 编曲视图底部留白 84 + 横向滚动条 10，
                保证两边的最大滚动距离一致，滚到底部时轨道仍严格对齐 */}
            <div className="h-[58px]" />
          </>
        )}
      </div>

      {/* 弹层 */}
      {picker?.kind === 'instrument' && (
        <InstrumentPicker
          currentId={
            picker.mode === 'change' ? tracks.find((track) => track.id === picker.trackId)?.instrumentId : undefined
          }
          style={popoverPosition(picker.rect, 300, 400)}
          onClose={closePicker}
          onPick={(instrumentId) => {
            if (picker.mode === 'new') {
              addTrack({ instrumentId })
              pushToast('success', `已添加 ${getInstrument(instrumentId).name} 轨道`)
            } else {
              setTrackInstrument(picker.trackId, instrumentId)
            }
            closePicker()
          }}
        />
      )}
      {picker?.kind === 'emotion' && (
        <EmotionPicker
          instrumentId={tracks.find((track) => track.id === picker.trackId)?.instrumentId ?? 'piano.grand'}
          currentEmotionId={tracks.find((track) => track.id === picker.trackId)?.emotionId ?? ''}
          style={popoverPosition(picker.rect, 244, 280)}
          onClose={closePicker}
          onPick={(emotionId) => {
            const track = tracks.find((item) => item.id === picker.trackId)
            if (track) setTrackInstrument(track.id, track.instrumentId, emotionId)
            closePicker()
          }}
        />
      )}
    </aside>
  )
}
