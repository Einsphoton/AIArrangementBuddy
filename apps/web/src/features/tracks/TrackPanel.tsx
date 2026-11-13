/**
 * 左侧轨道面板：轨道头列表 + 行高工具条 + 多选 / 框选。
 *
 * 与编曲视图严格对齐的四段结构（相对主编辑区顶部）：
 *   38px 标题栏（对齐主编辑区 tab 栏）
 *   38px 行高工具条（对齐编曲视图的时间轴工具条）
 *   54px 总控行（对齐 LOOP/SECT/BAR 标尺）
 *   轨道列表
 * 因此两边的第 N 条轨道在同一 y 位置，且共用 uiStore.trackHeights 的行高。
 *
 * 多选交互（本轮新增，对标 Logic / Cubase / Studio One）：
 * - 单击 = 单选；Ctrl/⌘ 点击 = 切换；Shift 点击 = 从 anchor 连选；
 * - 在列表任意位置按下拖动 = 框选（**包含最后一条轨以下的空白区域**，
 *   旧实现只能从行内起拖，鼠标落在轨道外就完全失效）；
 * - 拖动时靠近列表上下边缘自动滚动；
 * - 表头 / 右键菜单的批量操作作用到整个选中集合。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckSquare, ChevronsDownUp, ChevronsUpDown, Copy, Minus, Plus, Trash2 } from 'lucide-react'
import { getInstrument } from '@aiab/core'
import { getAudioEngine } from '../../audio'
import { Badge, EmptyState, IconButton } from '../../components/ui'
import { useStore } from '../../store/store'
import {
  resolveTrackHeight,
  TRACK_HEIGHT_LIMITS,
  TRACK_PANEL_WIDTH_LIMITS,
  useUiStore,
} from '../../lib/uiStore'
import { computeAudibleTrackIds } from '../../lib/trackRules'
import { keyScaleLabel, resolveProjectStyle, styleLabel } from '../../lib/studioMeta'
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
import { MixMasterControls } from './MixMasterControls'
import { TrackRow, type DropTarget, type TrackSelectGesture } from './TrackRow'
import { GenerationTrackHeader } from '../audio/GenerationTrack'
import { useAudioJobStore } from '../audio/audioJobStore'

type PickerState =
  | { kind: 'instrument'; mode: 'new'; rect: DOMRect }
  | { kind: 'instrument'; mode: 'change'; rect: DOMRect; trackId: string }
  | { kind: 'emotion'; rect: DOMRect; trackId: string }

/** 框选矩形（相对轨道列表视口） */
interface MarqueeBox {
  top: number
  height: number
}

export function TrackPanel() {
  const tracks = useStore((s) => s.project.tracks)
  const project = useStore((s) => s.project)
  const selectedTrackId = useStore((s) => s.selectedTrackId)
  const selectedTrackIds = useStore((s) => s.selectedTrackIds)
  const zoomY = useStore((s) => s.zoomY)
  const selectTrack = useStore((s) => s.selectTrack)
  const selectTracks = useStore((s) => s.selectTracks)
  const selectAllTracks = useStore((s) => s.selectAllTracks)
  const addTrack = useStore((s) => s.addTrack)
  const removeTracks = useStore((s) => s.removeTracks)
  const duplicateTracks = useStore((s) => s.duplicateTracks)
  const setTrackInstrument = useStore((s) => s.setTrackInstrument)
  const setZoom = useStore((s) => s.setZoom)
  const pushToast = useStore((s) => s.pushToast)
  const commitReorder = useStore((s) => s.mutate)
  const pushHistory = useStore((s) => s.pushHistory)
  const setSaveStatus = useStore((s) => s.setSaveStatus)
  const trackHeights = useUiStore((s) => s.trackHeights)
  const panelWidth = useUiStore((s) => s.trackPanelWidth)
  const setTrackPanelWidth = useUiStore((s) => s.setTrackPanelWidth)
  /* 生成中的占位轨：编曲车道与轨道头同步出现，落轨后逐条移除 */
  const generationSlots = useAudioJobStore((s) => s.slots)
  const audioJob = useAudioJobStore((s) => s.job)

  const listRef = useRef<HTMLDivElement>(null)
  /* 每轨电平：单条 rAF 直接改 DOM style（与 MixerPanel 同一策略），不触发 React 重渲染 */
  const meterRefs = useRef<Record<string, HTMLSpanElement | null>>({})
  const meterLevels = useRef<Map<string, number>>(new Map())
  /* 框选：拖动超过阈值后抑制随后的 click，避免拖完又被复位成单选 */
  const suppressClickRef = useRef(false)
  const marqueeDragRef = useRef<{ top: number; height: number } | null>(null)
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null)
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
  /* 独奏态只在这里算一次，再传给每一行：每行各自 some() 会在 24 轨时变成 O(n²) */
  const anySolo = tracks.some((track) => track.solo)
  const multiSelected = selectedTrackIds.length > 1
  const projectStyle = styleLabel(resolveProjectStyle(project))
  const projectMeta = [projectStyle ?? '风格未标注', keyScaleLabel(project.key, project.scale), `${project.tempo} BPM`]
    .filter(Boolean)
    .join(' · ')
  const narrow = panelWidth < 280

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
      /* 与引擎共用同一份可听判定（lib/trackRules）：电平表不能用第二套 mute/solo 语义 */
      const audibleIds = computeAudibleTrackIds(state.project.tracks)
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
        const audible = audibleIds.has(track.id)
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

  /*
   * 录入预备对账：删除轨道 / 切换工程 / AI 整体替换工程之后，armedTrackId 可能指向
   * 一个已经不存在的轨道。那就是「幽灵 arm」——总控 R 会显示有预备、按录音却没目标。
   * 这里做一次幂等对账：预备轨不在了就清空。
   */
  useEffect(() => {
    const armed = useUiStore.getState().armedTrackId
    if (!armed) return
    if (tracks.some((track) => track.id === armed)) return
    useUiStore.getState().setArmedTrackId(null)
  }, [tracks])

  const handleScroll = () => {
    const element = listRef.current
    if (element) publishVerticalScroll(element.scrollTop, 'tracks')
  }

  /* ---------------- 面板宽度拖拽 ---------------- */

  const startPanelResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = useUiStore.getState().trackPanelWidth
    const onMove = (moveEvent: PointerEvent) => {
      setTrackPanelWidth(
        clamp(
          startWidth + (moveEvent.clientX - startX),
          TRACK_PANEL_WIDTH_LIMITS.min,
          TRACK_PANEL_WIDTH_LIMITS.max,
        ),
      )
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /* ---------------- 多选：点击 / 框选 ---------------- */

  const applyRowGesture = (trackId: string, gesture: TrackSelectGesture) => {
    if (gesture.range) selectTrack(trackId, { mode: 'range' })
    else if (gesture.additive) selectTrack(trackId, { mode: 'toggle' })
    else selectTrack(trackId, { mode: 'replace' })
  }

  /** 列表里所有轨道行（顺序 = 工程顺序） */
  const rowElements = (): HTMLElement[] =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-track-row]') ?? [])

  /** clientY → 行序号；clamp=true 时把「最后一行以下」吸附到最后一行（框选锚点用） */
  const rowIndexAtClientY = (rows: HTMLElement[], clientY: number, clampToRows: boolean): number | null => {
    if (rows.length === 0) return null
    for (let index = 0; index < rows.length; index += 1) {
      const rect = rows[index].getBoundingClientRect()
      if (clientY >= rect.top && clientY < rect.bottom) return index
    }
    const lastRect = rows[rows.length - 1].getBoundingClientRect()
    const firstRect = rows[0].getBoundingClientRect()
    if (!clampToRows) return null
    if (clientY >= lastRect.bottom) return rows.length - 1
    if (clientY <= firstRect.top) return 0
    return null
  }

  const startListGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    /* 上一轮拖选若没等到 click（例如在窗口外松开），不要吞掉下一次点击 */
    suppressClickRef.current = false
    const target = event.target as HTMLElement
    /* 控件自己的点击语义（M/S/R/滑杆/重命名/行高热区/拖色条排序）不要被框选抢走 */
    if (target.closest('button, input, select, textarea, a, [role="slider"], [role="separator"], [draggable="true"]')) return
    const list = listRef.current
    if (!list) return
    const rows = rowElements()
    if (rows.length === 0) return
    const startY = event.clientY
    const anchorIndex = rowIndexAtClientY(rows, startY, true)
    if (anchorIndex == null) return
    const anchorId = rows[anchorIndex]?.dataset.trackId ?? null
    const additiveBase = event.shiftKey ? useStore.getState().selectedTrackIds : null
    const startX = event.clientX
    let moved = false
    let lastIndex = anchorIndex

    const applyRange = (index: number) => {
      const [from, to] = anchorIndex <= index ? [anchorIndex, index] : [index, anchorIndex]
      const ids = rows
        .slice(from, to + 1)
        .map((row) => row.dataset.trackId)
        .filter((id): id is string => Boolean(id))
      const next = additiveBase ? [...new Set([...additiveBase, ...ids])] : ids
      selectTracks(next, anchorId)
    }

    const onMove = (moveEvent: PointerEvent) => {
      if (!moved && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 4) moved = true
      if (!moved) return
      const listNow = listRef.current
      if (!listNow) return
      const rect = listNow.getBoundingClientRect()
      /* 靠近上下边缘时自动滚动，长列表也能一路拖选 */
      if (moveEvent.clientY < rect.top + 24) listNow.scrollTop -= 14
      else if (moveEvent.clientY > rect.bottom - 24) listNow.scrollTop += 14
      const index = rowIndexAtClientY(rowElements(), moveEvent.clientY, true) ?? lastIndex
      lastIndex = index
      marqueeDragRef.current = {
        top: Math.min(startY, moveEvent.clientY) - rect.top,
        height: Math.abs(moveEvent.clientY - startY),
      }
      setMarquee(marqueeDragRef.current)
      applyRange(index)
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      marqueeDragRef.current = null
      setMarquee(null)
      if (moved) {
        suppressClickRef.current = true
        /* 按最终区间落一次选择；anchor 仍是按下时那一条，后续 Shift 连选有明确起点 */
        applyRange(lastIndex)
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const handleListClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    const target = event.target as HTMLElement
    if (target.closest('button, input, select, textarea, a, [role="slider"], [role="separator"], [draggable="true"]')) return
    const row = target.closest('[data-track-row]') as HTMLElement | null
    const trackId = row?.dataset.trackId
    if (!trackId) return
    applyRowGesture(trackId, {
      additive: event.metaKey || event.ctrlKey,
      range: event.shiftKey,
    })
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

  /**
   * 拖动排序：若拖动的轨道在多选集合里，则整体移动选中块（保持相对顺序）。
   * `targetIndex` 是「插入点」（已按 before/after 换算）。
   */
  const reorder = (trackId: string, targetIndex: number) => {
    const state = useStore.getState()
    const current = state.project.tracks
    const from = current.findIndex((track) => track.id === trackId)
    if (from < 0) return
    const selection = state.selectedTrackIds
    const movingIds =
      selection.includes(trackId) && selection.length > 1 ? new Set(selection) : new Set([trackId])
    let to = targetIndex
    to = Math.max(0, Math.min(current.length, to))
    /* 插入点落在选中块内部：不移动，避免原地抖动 */
    if (current[to] && movingIds.has(current[to].id)) return
    const before = current.slice(0, to).filter((track) => movingIds.has(track.id)).length
    const insertAt = Math.max(0, Math.min(current.length - movingIds.size, to - before))
    const fromMoving = current.findIndex((track) => movingIds.has(track.id))
    if (fromMoving === from && insertAt === fromMoving) return
    const nextOrder = (() => {
      const moving = current.filter((track) => movingIds.has(track.id))
      const rest = current.filter((track) => !movingIds.has(track.id))
      rest.splice(insertAt, 0, ...moving)
      return rest
    })()
    if (nextOrder.every((track, index) => track.id === current[index]?.id)) return
    pushHistory()
    setSaveStatus('dirty')
    commitReorder(
      (draft) => {
        draft.tracks = nextOrder
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
    <aside
      className="relative flex shrink-0 flex-col border-r border-line bg-surface"
      style={{ width: panelWidth }}
      data-track-panel
      data-track-panel-width={panelWidth}
    >
      {/* 标题栏（与主编辑区 tab 栏同高 38px） */}
      <header className="flex h-[38px] shrink-0 items-center gap-1 border-b border-line px-2">
        <span className="label">轨道</span>
        <Badge>{tracks.length}</Badge>
        {multiSelected && (
          <span
            data-track-selection-count={selectedTrackIds.length}
            className="inline-flex h-[16px] shrink-0 items-center rounded-full border border-accent/35 bg-accent/12 px-1.5 text-[10px] font-semibold leading-none text-accent-soft"
            title={`已选中 ${selectedTrackIds.length} 条轨道：M / S、删除、复制、改色、音量会作用于全部选中轨`}
          >
            已选 {selectedTrackIds.length}
          </span>
        )}
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
          title={multiSelected ? '清空多选（只保留主轨）' : '全选轨道'}
          onClick={() => {
            if (multiSelected || selectedTrackIds.length === tracks.length) {
              useStore.getState().clearTrackSelection()
            } else {
              selectAllTracks()
            }
          }}
          className="h-6 w-6"
        >
          <CheckSquare size={12} />
        </IconButton>
        <IconButton
          title="添加轨道"
          onClick={(event) => openInstrumentPicker(event.currentTarget.getBoundingClientRect())}
          className="h-6 w-6"
        >
          <Plus size={13} />
        </IconButton>
        <IconButton
          title={multiSelected ? `复制选中的 ${selectedTrackIds.length} 条轨道` : '复制选中轨道'}
          disabled={selectedTrackIds.length === 0}
          onClick={() => {
            const ids = duplicateTracks(selectedTrackIds)
            if (ids.length > 0) pushToast('success', ids.length > 1 ? `已复制 ${ids.length} 条轨道` : '已复制轨道')
          }}
          className="h-6 w-6"
        >
          <Copy size={12} />
        </IconButton>
        <IconButton
          title={multiSelected ? `删除选中的 ${selectedTrackIds.length} 条轨道（⌘Z 可撤销）` : '删除选中轨道'}
          disabled={selectedTrackIds.length === 0}
          onClick={() => {
            if (selectedTrackIds.length === 0) return
            const names = tracks
              .filter((track) => selectedTrackIds.includes(track.id))
              .map((track) => track.name)
            removeTracks(selectedTrackIds)
            pushToast(
              'info',
              names.length > 1 ? `已删除 ${names.length} 条轨道（⌘Z 可撤销）` : `已删除轨道「${names[0] ?? ''}」`,
            )
          }}
          className="h-6 w-6 hover:text-danger"
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

      {/* 总控行：项目级信息只在这一次显示（旧版每行重复「风格 · 调号 · BPM」，是拥挤的根源），
          第二行是常驻的 M / S / R 总控。高度必须严格等于 RULER_HEIGHT，否则左右轨道行会错位 */}
      <div
        className="flex shrink-0 flex-col justify-center gap-1 border-b border-line px-2.5"
        style={{ height: RULER_HEIGHT }}
        data-track-master-row
        title="总控：M 全部静音 / S 清空全部独奏 / R 取消录入预备。独奏不会改写其它轨道的静音开关。"
      >
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="label shrink-0">工程</span>
            <span className="min-w-0 truncate text-[10px] text-ink-4" title={projectMeta}>
              {projectMeta}
            </span>
          </div>
          <span
            data-track-selection-count={selectedTrackIds.length}
            className={multiSelected ? 'shrink-0 text-[10px] font-semibold text-accent-soft' : 'shrink-0 text-[10px] text-ink-4/80'}
            title={
              multiSelected
                ? `已选中 ${selectedTrackIds.length} 条轨道`
                : `当前工程：${clipCount} 个片段 · ${noteCount} 个音符`
            }
          >
            {multiSelected ? `已选 ${selectedTrackIds.length} 轨` : narrow ? '' : `${clipCount} 片段 · ${noteCount} 音符`}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1">
          <MixMasterControls variant="panel" />
        </div>
      </div>

      {/* 轨道列表 + 框选覆盖层（覆盖层放在滚动视口外层，滚动时矩形不跟着内容跑） */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={listRef}
          onScroll={handleScroll}
          onPointerDown={startListGesture}
          onClick={handleListClick}
          className="h-full overflow-y-auto overflow-x-hidden"
          aria-label="轨道列表"
          data-track-list
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
                  selected={selectedTrackIds.includes(track.id)}
                  primary={track.id === selectedTrackId}
                  selectionIds={selectedTrackIds}
                  panelWidth={panelWidth}
                  dropTarget={dropTarget}
                  renameSignal={renameRequest?.trackId === track.id ? renameRequest.token : 0}
                  registerMeter={registerMeter}
                  onSelect={(gesture) => applyRowGesture(track.id, gesture)}
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
                  anySolo={anySolo}
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

        {/* 框选矩形：竖条覆盖整个列表宽度，起点即使在最后一条轨道以下也能拖 */}
        {marquee && (
          <div
            data-track-marquee
            className="pointer-events-none absolute inset-x-0 z-20 border-y border-accent/70 bg-accent/10"
            style={{ top: marquee.top, height: Math.max(2, marquee.height) }}
          />
        )}
      </div>

      {/* 面板宽度拖拽条 */}
      <div
        data-track-panel-splitter
        role="separator"
        aria-orientation="vertical"
        aria-label="调整轨道面板宽度"
        title="拖动调整轨道面板宽度，双击复位 288px"
        onPointerDown={startPanelResize}
        onDoubleClick={() => setTrackPanelWidth(TRACK_PANEL_WIDTH_LIMITS.default)}
        className="group/splitter absolute inset-y-0 -right-[2px] z-30 w-[5px] cursor-col-resize"
      >
        <span className="absolute inset-y-0 left-[2px] w-[1.5px] bg-transparent transition-colors group-hover/splitter:bg-accent/60" />
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
