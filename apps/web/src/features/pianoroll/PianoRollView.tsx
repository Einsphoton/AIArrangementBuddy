/**
 * 钢琴卷帘：Canvas 2D 实现的可编辑卷帘。
 *
 * 性能策略：
 * - 静态内容（网格 / 琴键 / 音符 / 幽灵音符 / 力度条）画在一张 canvas 上，按需重绘（rAF 合并）；
 * - 播放头是一条 1px DOM，由 rAF 每帧直接改 style，不触发 React 重渲染；
 * - 拖拽 / 悬停期间只更新 ref + rAF 重绘（previewRef / hoverRef / dragTipRef），松手时一次性提交到 store
 *   —— 撤销栈只留一步，且拖动时不会重建 React 树。
 *
 * 交互一致性：
 * - 鼠标（单击 / 拖拽 / 右键菜单 / 工具栏）与键盘（Q / Delete / ⌘A / ⌘C / ⌘V / 方向键）以及
 *   editorBus（命令面板 / 全局快捷键）都调用同一组动作函数，避免多套逻辑漂移。
 * - 右键音符只打开菜单，不直接删除；右键空白会先取消选择，再给出粘贴 / 全选 / 在播放头新建。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Boxes,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  Eraser,
  Gauge,
  Ghost,
  Grid3x3,
  Lock,
  LockOpen,
  Magnet,
  Maximize2,
  MoreHorizontal,
  MoveHorizontal,
  Piano,
  Plus,
  Redo2,
  Sparkles,
  SquareDashed,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  createNote,
  isInScale,
  pitchToName,
  SCALES,
  SMART_KIND_META,
  snapToScale,
  type Clip,
  type NoteEvent,
  type Project,
  type ScaleId,
  type Track,
} from '@aiab/core'
import { getAudioEngine } from '../../audio'
import { EmptyState, IconButton, Select } from '../../components/ui'
import { ContextMenu, MenuDivider, MenuItem, MenuLabel, Popover } from '../../components/ui/menu'
import { cn } from '../../lib/format'
import { useStore } from '../../store/store'
import { useUiStore } from '../../lib/uiStore'
import { subscribeEditorCommand } from '../../lib/editorBus'
import {
  clamp,
  gridUnit,
  MAX_ZOOM_X,
  MAX_ZOOM_Y,
  MIN_ZOOM_X,
  MIN_ZOOM_Y,
  pianoRollPxPerBeat,
  PR_ZOOM_FACTOR,
  snapBeat,
  tidy,
  trackColor,
} from '../arrangement/timeline'
import { usePointerDrag } from '../arrangement/usePointerDrag'
import {
  computeLayout,
  drawPianoRoll,
  type DragTooltip,
  type GhostNote,
  type GridDivision,
  type NotePreview,
  type PianoRollLayout,
  type PianoRollScene,
} from './pianorollDraw'

const PITCH_HEIGHT_MIN = 8
const PITCH_HEIGHT_MAX = 32
const DEFAULT_TOP_PITCH = 84

const SNAP_OPTIONS = [
  { value: '0', label: '吸附关闭' },
  { value: '4', label: '1/1' },
  { value: '2', label: '1/2' },
  { value: '1', label: '1/4' },
  { value: '0.5', label: '1/8' },
  { value: '0.25', label: '1/16' },
  { value: '0.125', label: '1/32' },
  { value: '0.666667', label: '1/4 三连' },
  { value: '0.333333', label: '1/8 三连' },
  { value: '0.166667', label: '1/16 三连' },
]

const GRID_OPTIONS: { value: GridDivision; label: string }[] = [
  { value: 'beat', label: '拍线' },
  { value: 'half', label: '半拍' },
  { value: 'triplet', label: '三连音' },
]

const QUANTIZE_STRENGTH_OPTIONS = [
  { value: '1', label: '100%' },
  { value: '0.75', label: '75%' },
  { value: '0.5', label: '50%' },
]

/** 动作集合：鼠标 / 键盘 / editorBus 共用同一套实现 */
interface PianoRollActions {
  zoomBy: (factor: number) => void
  zoomFit: () => void
  selectAllNotes: () => void
  deleteSelection: () => void
  copySelection: () => void
  pasteClipboard: () => void
  duplicateSelection: () => void
  applyQuantize: (strength: number) => void
  applyHumanize: () => void
  transposeSelection: (semitones: number) => void
  splitAtPlayhead: () => void
  createNoteAtPlayhead: () => void
}

interface ContextMenuState {
  x: number
  y: number
  kind: 'note' | 'empty'
  noteId?: string
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function findClipById(project: Project, clipId: string): { track: Track; clip: Clip } | null {
  for (const track of project.tracks) {
    const clip = track.clips.find((item) => item.id === clipId)
    if (clip) return { track, clip }
  }
  return null
}

/** 移调：音阶锁定开启时，±1 半音改为「调内下一级」，避免半音落调外 */
function movePitch(pitch: number, semitones: number, scaleLock: boolean, key: string, scale: ScaleId): number {
  if (!scaleLock || Math.abs(semitones) !== 1) return clamp(pitch + semitones, 0, 127)
  const direction = semitones > 0 ? 1 : -1
  for (let step = 1; step <= 12; step += 1) {
    const candidate = pitch + direction * step
    if (candidate < 0 || candidate > 127) break
    if (isInScale(candidate, key, scale)) return candidate
  }
  return clamp(pitch + semitones, 0, 127)
}

function snapLabelText(unit: number): string {
  if (unit >= 4) return '1/1'
  if (unit >= 2) return '1/2'
  if (unit >= 1) return '1/4'
  if (unit >= 0.5) return '1/8'
  if (unit >= 0.25) return '1/16'
  if (unit >= 0.125) return '1/32'
  return '三连音'
}

function strengthLabel(strength: number): string {
  return `${Math.round(clamp(strength, 0, 1) * 100)}%`
}

/* ------------------------------------------------------------------ */
/* 组件                                                                */
/* ------------------------------------------------------------------ */

export function PianoRollView() {
  /* ---------------- store ---------------- */
  const project = useStore((s) => s.project)
  const selection = useStore((s) => s.selection)
  const snap = useStore((s) => s.snap)
  const zoomX = useStore((s) => s.zoomX)
  const zoomY = useStore((s) => s.zoomY)
  const scrollBeat = useStore((s) => s.scrollBeat)
  const selectedTrackId = useStore((s) => s.selectedTrackId)
  const setSnap = useStore((s) => s.setSnap)
  const setScrollBeat = useStore((s) => s.setScrollBeat)
  const setZoom = useStore((s) => s.setZoom)
  const setView = useStore((s) => s.setView)
  const selectClip = useStore((s) => s.selectClip)
  const addClip = useStore((s) => s.addClip)
  const pushToast = useStore((s) => s.pushToast)
  const canUndo = useStore((s) => s.past.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)

  /* ---------------- UI 偏好 ---------------- */
  const scaleLock = useUiStore((s) => s.scaleLock)
  const showGhostNotes = useUiStore((s) => s.showGhostNotes)
  const velocityLane = useUiStore((s) => s.velocityLane)
  const followPlayhead = useUiStore((s) => s.followPlayhead)
  const setScaleLock = useUiStore((s) => s.setScaleLock)
  const setShowGhostNotes = useUiStore((s) => s.setShowGhostNotes)
  const setVelocityLane = useUiStore((s) => s.setVelocityLane)
  const toggleFollowPlayhead = useUiStore((s) => s.toggleFollowPlayhead)

  const clipInfo = useMemo(() => findClipById(project, selection.clipId ?? ''), [project, selection.clipId])
  const clip = clipInfo?.clip ?? null
  const track = clipInfo?.track ?? null

  const barBeats = (project.timeSignature.numerator * 4) / project.timeSignature.denominator
  const pxPerBeat = pianoRollPxPerBeat(zoomX)
  const pitchHeight = clamp(zoomY, PITCH_HEIGHT_MIN, PITCH_HEIGHT_MAX)

  /* ---------------- 本地视图状态 ---------------- */
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [topPitch, setTopPitch] = useState(DEFAULT_TOP_PITCH)
  const [gridDivision, setGridDivision] = useState<GridDivision>('beat')
  const [scaleHighlight, setScaleHighlight] = useState(true)
  const [quantizeStrength, setQuantizeStrength] = useState(1)
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [moreAnchor, setMoreAnchor] = useState<DOMRect | null>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [toolbarWidth, setToolbarWidth] = useState(0)

  /** 工具条宽度分档：宽屏文字 / 中屏图标 / 窄屏「更多」 */
  const toolbarMode: 'wide' | 'compact' | 'narrow' =
    toolbarWidth >= 940 ? 'wide' : toolbarWidth >= 680 ? 'compact' : 'narrow'
  /** 极窄（<600px）：网格细度/量化强度移入「更多」，避免工具栏溢出到 AI 面板下方 */
  const ultraNarrow = toolbarWidth > 0 && toolbarWidth < 600

  const layout = useMemo(
    () => computeLayout(size.width, size.height, { velocityLane }),
    [size, velocityLane],
  )
  const layoutRef = useRef<PianoRollLayout>(layout)
  layoutRef.current = layout

  const drag = usePointerDrag()
  const drawRef = useRef<() => void>(() => undefined)
  const drawRaf = useRef(0)
  const hoverRef = useRef<{ pitch: number | null; beat: number | null; noteId: string | null }>({
    pitch: null,
    beat: null,
    noteId: null,
  })
  const pressedPitchRef = useRef<number | null>(null)
  const marqueeRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const previewRef = useRef<NotePreview | null>(null)
  const velocityPreviewRef = useRef<Record<string, number> | null>(null)
  const ghostRef = useRef<{ pitch: number; start: number; duration: number } | null>(null)
  const dragTipRef = useRef<DragTooltip | null>(null)
  const interactingRef = useRef(false)
  const clipboardRef = useRef<NoteEvent[]>([])
  const topPitchRef = useRef(topPitch)
  topPitchRef.current = topPitch
  const clipRef = useRef<Clip | null>(clip)
  clipRef.current = clip
  const trackRef = useRef<Track | null>(track)
  trackRef.current = track
  const quantizeStrengthRef = useRef(quantizeStrength)
  quantizeStrengthRef.current = quantizeStrength
  const actionsRef = useRef<PianoRollActions | null>(null)

  /* 指针被系统取消（如切窗口）时复位交互标记 */
  useEffect(() => {
    const reset = () => {
      interactingRef.current = false
    }
    window.addEventListener('pointercancel', reset)
    window.addEventListener('pointerup', reset)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('pointercancel', reset)
      window.removeEventListener('pointerup', reset)
      window.removeEventListener('blur', reset)
    }
  }, [])

  /* ---------------- 尺寸监听 ---------------- */
  useEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /* ---------------- 工具条宽度监听（窄屏自适应，避免隐藏溢出） ---------------- */
  useEffect(() => {
    const element = toolbarRef.current
    if (!element) return
    const update = () => setToolbarWidth(element.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /* ---------------- 选中片段变化时把视图移到音符区域 ---------------- */
  const lastClipIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!clip) return
    // 卷帘里的横轴是片段内相对拍，切换片段时回到片段开头
    if (lastClipIdRef.current !== clip.id) {
      lastClipIdRef.current = clip.id
      setScrollBeat(0)
    }
    const notes = clip.notes
    const rows = Math.max(8, Math.floor((size.height || 400) / pitchHeight))
    if (notes.length === 0) {
      setTopPitch((previous) => (previous === DEFAULT_TOP_PITCH ? previous : DEFAULT_TOP_PITCH))
      return
    }
    let minPitch = 127
    let maxPitch = 0
    for (const note of notes) {
      if (note.pitch < minPitch) minPitch = note.pitch
      if (note.pitch > maxPitch) maxPitch = note.pitch
    }
    const center = (minPitch + maxPitch) / 2
    setTopPitch(clamp(Math.round(center + rows / 2), 12, 127))
    // 仅当切换片段时重置视图
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.id])

  /* ---------------- 幽灵音符（同轨道其它片段，前后 ±2 小节） ---------------- */
  const ghostNotes = useMemo<GhostNote[]>(() => {
    if (!showGhostNotes || !track || !clip) return []
    const pad = barBeats * 2
    const from = -pad
    const to = clip.lengthBeats + pad
    const result: GhostNote[] = []
    for (const other of track.clips) {
      if (other.id === clip.id) continue
      const otherStart = other.startBeat - clip.startBeat
      if (otherStart > to || otherStart + other.lengthBeats < from) continue
      for (const note of other.notes) {
        const start = otherStart + note.start
        if (start + note.duration < from || start > to) continue
        result.push({ pitch: note.pitch, start, duration: note.duration, velocity: note.velocity })
      }
    }
    return result
  }, [showGhostNotes, track, clip, barBeats])

  /* ---------------- 绘制调度 ---------------- */
  const scheduleDraw = useCallback(() => {
    if (drawRaf.current) return
    drawRaf.current = window.requestAnimationFrame(() => {
      drawRaf.current = 0
      drawRef.current()
    })
  }, [])

  const scrollThumb = useMemo(() => {
    if (layout.gridWidth <= 0) return null
    const totalBeats = Math.max((clip?.lengthBeats ?? 16) + 8, 16, scrollBeat + layout.gridWidth / pxPerBeat)
    const viewBeats = layout.gridWidth / pxPerBeat
    if (totalBeats <= viewBeats) return { left: 0, width: layout.gridWidth }
    const width = Math.max(24, (viewBeats / totalBeats) * layout.gridWidth)
    const ratio = scrollBeat / Math.max(0.001, totalBeats - viewBeats)
    return { left: clamp(ratio * (layout.gridWidth - width), 0, layout.gridWidth - width), width }
  }, [clip?.lengthBeats, layout.gridWidth, pxPerBeat, scrollBeat])

  // 每帧从这里取最新场景，避免闭包过期
  useEffect(() => {
    drawRef.current = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const scene: PianoRollScene = {
        layout: layoutRef.current,
        pxPerBeat,
        pitchHeight,
        scrollBeat,
        topPitch: topPitchRef.current,
        notes: clip?.notes ?? [],
        selected: new Set(selection.noteIds),
        color: clipInfo ? trackColor(clipInfo.track.color) : '#f0b429',
        barBeats,
        timeSignature: project.timeSignature,
        snap,
        gridDivision,
        scaleHighlight,
        scaleLock,
        keyName: project.key,
        scale: project.scale,
        isDrum: clipInfo?.track.kind === 'drum',
        clipLengthBeats: clip?.lengthBeats ?? 16,
        hoverPitch: hoverRef.current.pitch,
        hoverBeat: hoverRef.current.beat,
        hoverNoteId: hoverRef.current.noteId,
        preview: previewRef.current,
        velocityPreview: velocityPreviewRef.current,
        ghost: ghostRef.current,
        ghostNotes,
        marquee: marqueeRef.current,
        pressedPitch: pressedPitchRef.current,
        scrollThumb,
        velocityLane,
        tooltip: dragTipRef.current,
        hasNotes: Boolean(clip?.notes.length),
      }
      drawPianoRoll(canvas, scene)
    }
    scheduleDraw()
  })

  /* ---------------- 播放头 / 自动跟随 ---------------- */
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const element = playheadRef.current
      const currentLayout = layoutRef.current
      if (element && currentLayout) {
        const store = useStore.getState()
        const currentClip = clipRef.current
        const px = pianoRollPxPerBeat(store.zoomX)
        // 卷帘里的拍是「片段内相对拍」，播放头要减掉片段起点
        const relativePlayhead = store.playhead - (currentClip?.startBeat ?? 0)
        const inClip = relativePlayhead >= 0 && relativePlayhead <= (currentClip?.lengthBeats ?? 0)
        const x = currentLayout.gridLeft + (relativePlayhead - store.scrollBeat) * px
        element.style.left = `${x}px`
        element.style.height = `${currentLayout.gridHeight}px`
        element.style.opacity = inClip ? (store.playhead > 0 || store.isPlaying ? '1' : '0.55') : '0'
        if (store.isPlaying && useUiStore.getState().followPlayhead) {
          const localX = x - currentLayout.gridLeft
          if (localX > currentLayout.gridWidth - 60) {
            store.setScrollBeat(store.scrollBeat + Math.max(0.5, (localX - currentLayout.gridWidth * 0.72) / px))
          } else if (localX < 0) {
            store.setScrollBeat(Math.max(0, relativePlayhead - 1))
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  /* ---------------- 坐标换算 ---------------- */
  const localPoint = (event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
  const beatAtX = (x: number) => scrollBeat + (x - layout.gridLeft) / pxPerBeat
  const pitchAtY = (y: number) => topPitchRef.current - Math.floor(y / pitchHeight)
  const regionAt = (x: number, y: number): 'scrollbar' | 'velocity' | 'keyboard' | 'grid' => {
    if (y >= layout.scrollbarTop) return 'scrollbar'
    if (layout.velocityHeight > 0 && y >= layout.velocityTop) return 'velocity'
    if (x < layout.gridLeft) return 'keyboard'
    return 'grid'
  }

  const hitTestNote = (x: number, y: number): { note: NoteEvent; edge: boolean } | null => {
    if (!clip) return null
    const notes = clip.notes
    for (let index = notes.length - 1; index >= 0; index -= 1) {
      const note = notes[index]
      const row = topPitchRef.current - note.pitch
      const noteY = row * pitchHeight
      if (y < noteY || y > noteY + pitchHeight - 1.5) continue
      const noteX = layout.gridLeft + (note.start - scrollBeat) * pxPerBeat
      const noteWidth = Math.max(3, note.duration * pxPerBeat - 1.5)
      if (x < noteX || x > noteX + noteWidth) continue
      return { note, edge: x > noteX + noteWidth - Math.min(7, Math.max(3, noteWidth * 0.35)) }
    }
    return null
  }

  const previewPitch = (pitch: number) => {
    const currentTrack = trackRef.current
    if (!currentTrack) return
    try {
      getAudioEngine().previewNote(currentTrack, clamp(pitch, 0, 127), 100, 0.35)
    } catch {
      /* 引擎未就绪时静默 */
    }
  }

  const beginInteraction = (
    event: React.PointerEvent,
    handlers: { onMove: (event: PointerEvent) => void; onUp?: (event: PointerEvent) => void },
  ) => {
    interactingRef.current = true
    drag(event, {
      onMove: handlers.onMove,
      onUp: (upEvent) => {
        interactingRef.current = false
        handlers.onUp?.(upEvent)
      },
    })
  }

  /* ------------------------------------------------------------------ */
  /* 共用动作（鼠标 / 键盘 / 右键菜单 / editorBus）                       */
  /* ------------------------------------------------------------------ */

  const zoomBy = (factor: number) => {
    const state = useStore.getState()
    state.setZoom(clamp(state.zoomX * factor, MIN_ZOOM_X, MAX_ZOOM_X))
  }

  const zoomFit = () => {
    const state = useStore.getState()
    const info = findClipById(state.project, state.selection.clipId ?? '')
    if (!info) return
    const currentLayout = layoutRef.current
    const totalBeats = Math.max(1, info.clip.lengthBeats + Math.min(8, Math.max(2, info.clip.lengthBeats * 0.12)))
    const desiredPxPerBeat = currentLayout.gridWidth / totalBeats
    state.setZoom(clamp(desiredPxPerBeat / PR_ZOOM_FACTOR, MIN_ZOOM_X, MAX_ZOOM_X))
    state.setScrollBeat(0)
    if (info.clip.notes.length > 0) {
      let minPitch = 127
      let maxPitch = 0
      for (const note of info.clip.notes) {
        if (note.pitch < minPitch) minPitch = note.pitch
        if (note.pitch > maxPitch) maxPitch = note.pitch
      }
      const span = Math.max(6, maxPitch - minPitch + 1)
      const nextPitchHeight = clamp(currentLayout.gridHeight / (span + 4), PITCH_HEIGHT_MIN, PITCH_HEIGHT_MAX)
      state.setZoom(undefined, clamp(nextPitchHeight, MIN_ZOOM_Y, MAX_ZOOM_Y))
      setTopPitch(clamp(Math.round(maxPitch + 2), 6, 127))
    }
  }

  const selectAllNotes = () => {
    const state = useStore.getState()
    const info = findClipById(state.project, state.selection.clipId ?? '')
    if (!info) return
    state.setSelectedNotes(info.clip.notes.map((note) => note.id))
    pushToast('info', `已全选 ${info.clip.notes.length} 个音符`)
  }

  const deleteSelection = (ids?: string[]) => {
    const state = useStore.getState()
    const info = findClipById(state.project, state.selection.clipId ?? '')
    if (!info) return
    const noteIds = ids && ids.length > 0 ? ids : state.selection.noteIds
    if (noteIds.length === 0) return
    state.removeNotes(info.track.id, info.clip.id, noteIds)
    pushToast('info', noteIds.length > 1 ? `已删除 ${noteIds.length} 个音符` : '已删除音符')
  }

  const copySelection = (ids?: string[]) => {
    const state = useStore.getState()
    const info = findClipById(state.project, state.selection.clipId ?? '')
    if (!info) return
    const noteIds = ids && ids.length > 0 ? ids : state.selection.noteIds
    const source = noteIds.length > 0 ? info.clip.notes.filter((note) => noteIds.includes(note.id)) : info.clip.notes
    if (source.length === 0) return
    clipboardRef.current = source.map((note) => ({ ...note }))
    pushToast('info', `已复制 ${source.length} 个音符`)
  }

  const pasteClipboard = (atAbsoluteBeat?: number) => {
    const state = useStore.getState()
    const info = findClipById(state.project, state.selection.clipId ?? '')
    if (!info) return
    const copied = clipboardRef.current
    if (copied.length === 0) {
      pushToast('info', '剪贴板里还没有音符')
      return
    }
    const base = Math.min(...copied.map((note) => note.start))
    const target = atAbsoluteBeat ?? state.playhead
    const offset = Math.max(0, target - info.clip.startBeat - base)
    const notes = copied.map((note) =>
      createNote(note.pitch, Math.max(0, tidy(note.start + offset)), note.duration, note.velocity),
    )
    state.addNotes(info.track.id, info.clip.id, notes)
    state.setSelectedNotes(notes.map((note) => note.id))
    pushToast('success', `已粘贴 ${notes.length} 个音符`)
  }

  const duplicateSelection = () => {
    const state = useStore.getState()
    const info = findClipById(state.project, state.selection.clipId ?? '')
    if (!info) return
    const noteIds = state.selection.noteIds
    const source = noteIds.length > 0 ? info.clip.notes.filter((note) => noteIds.includes(note.id)) : info.clip.notes
    if (source.length === 0) return
    const end = Math.max(...source.map((note) => note.start + note.duration))
    clipboardRef.current = source.map((note) => ({ ...note }))
    pasteClipboard(info.clip.startBeat + end)
  }

  const applyQuantize = (strength = 1, ids?: string[]) => {
    const state = useStore.getState()
    const info = findClipById(state.project, state.selection.clipId ?? '')
    if (!info) return
    const ratio = clamp(strength, 0, 1)
    const unit = gridUnit(state.snap)
    // 未显式传 ids（工具栏 / Q / 命令面板）= 量化整个片段，保持原有行为；
    // 音符右键菜单传入选中的 ids，只量化这些音符。
    const idSet = new Set(ids && ids.length > 0 ? ids : info.clip.notes.map((note) => note.id))
    state.mutate((draft) => {
      const target = findClipById(draft, info.clip.id)?.clip
      if (!target) return
      for (const note of target.notes) {
        if (!idSet.has(note.id)) continue
        const snappedStart = Math.round(note.start / unit) * unit
        note.start = tidy(Math.max(0, note.start + (snappedStart - note.start) * ratio))
        const snappedDuration = Math.max(unit, Math.round(note.duration / unit) * unit)
        note.duration = tidy(Math.max(1 / 64, note.duration + (snappedDuration - note.duration) * ratio))
      }
    })
    pushToast('info', `已量化 ${strengthLabel(ratio)} 到 ${snapLabelText(unit)}`)
  }

  const applyHumanize = () => {
    const state = useStore.getState()
    const info = findClipById(state.project, state.selection.clipId ?? '')
    if (!info) return
    const noteIds = state.selection.noteIds
    const idSet = new Set(noteIds.length > 0 ? noteIds : info.clip.notes.map((note) => note.id))
    if (idSet.size === 0) return
    const unit = gridUnit(state.snap)
    const timeJitter = Math.min(0.04, unit * 0.14)
    const velocityJitter = 9
    state.mutate((draft) => {
      const target = findClipById(draft, info.clip.id)?.clip
      if (!target) return
      for (const note of target.notes) {
        if (!idSet.has(note.id)) continue
        note.start = tidy(Math.max(0, note.start + (Math.random() * 2 - 1) * timeJitter))
        note.velocity = clamp(Math.round(note.velocity + (Math.random() * 2 - 1) * velocityJitter), 1, 127)
      }
    })
    pushToast('success', `已人性化 ${idSet.size} 个音符（可撤销）`)
  }

  const transposeSelection = (semitones: number, ids?: string[]) => {
    const state = useStore.getState()
    const info = findClipById(state.project, state.selection.clipId ?? '')
    if (!info) return
    const noteIds = ids && ids.length > 0 ? ids : state.selection.noteIds
    if (noteIds.length === 0) return
    const idSet = new Set(noteIds)
    // 鼓组轨道的音高是鼓件映射，不参与音阶锁定
    const lock = useUiStore.getState().scaleLock && info.track.kind !== 'drum'
    const { key, scale } = state.project
    state.mutate((draft) => {
      const target = findClipById(draft, info.clip.id)?.clip
      if (!target) return
      for (const note of target.notes) {
        if (!idSet.has(note.id)) continue
        note.pitch = movePitch(note.pitch, semitones, lock, key, scale)
      }
    })
    pushToast('info', `已移调 ${semitones > 0 ? '+' : ''}${semitones} 半音`)
  }

  const scaleDuration = (factor: number) => {
    const state = useStore.getState()
    const info = findClipById(state.project, state.selection.clipId ?? '')
    if (!info) return
    const noteIds = state.selection.noteIds
    const idSet = new Set(noteIds.length > 0 ? noteIds : info.clip.notes.map((note) => note.id))
    state.mutate((draft) => {
      const target = findClipById(draft, info.clip.id)?.clip
      if (!target) return
      for (const note of target.notes) {
        if (!idSet.has(note.id)) continue
        note.duration = tidy(clamp(note.duration * factor, 1 / 64, 32))
      }
    })
    pushToast('info', factor > 1 ? '时值已 ×2' : '时值已 ÷2')
  }

  const adjustVelocity = (delta: number) => {
    const state = useStore.getState()
    const info = findClipById(state.project, state.selection.clipId ?? '')
    if (!info) return
    const noteIds = state.selection.noteIds
    const idSet = new Set(noteIds.length > 0 ? noteIds : info.clip.notes.map((note) => note.id))
    state.mutate((draft) => {
      const target = findClipById(draft, info.clip.id)?.clip
      if (!target) return
      for (const note of target.notes) {
        if (!idSet.has(note.id)) continue
        note.velocity = clamp(Math.round(note.velocity + delta), 1, 127)
      }
    })
    pushToast('info', `力度 ${delta > 0 ? '+' : ''}${delta}`)
  }

  const splitAtPlayhead = () => {
    const state = useStore.getState()
    const info = findClipById(state.project, state.selection.clipId ?? '')
    if (!info) return
    const relative = state.playhead - info.clip.startBeat
    if (relative <= 0 || relative >= info.clip.lengthBeats) {
      pushToast('info', '播放头不在当前片段内，无法拆分')
      return
    }
    state.mutate((draft) => {
      const target = findClipById(draft, info.clip.id)?.clip
      if (!target) return
      const created: NoteEvent[] = []
      for (const note of target.notes) {
        if (note.start >= relative - 1e-6 || note.start + note.duration <= relative + 1e-6) continue
        const head = relative - note.start
        const tail = note.duration - head
        if (head < 1 / 64 || tail < 1 / 64) continue
        note.duration = tidy(head)
        created.push(createNote(note.pitch, tidy(relative), tidy(tail), note.velocity))
      }
      target.notes.push(...created)
    })
    pushToast('info', '已在播放头处拆分音符')
  }

  const createNoteAtPlayhead = () => {
    const state = useStore.getState()
    const info = findClipById(state.project, state.selection.clipId ?? '')
    if (!info) return
    const lock = useUiStore.getState().scaleLock && info.track.kind !== 'drum'
    const unit = state.snap > 0 ? state.snap : 0.25
    const relative = clamp(state.playhead - info.clip.startBeat, 0, Math.max(0, info.clip.lengthBeats - unit))
    const referencePitch = hoverRef.current.pitch ?? 60
    const pitch = lock
      ? clamp(snapToScale(referencePitch, state.project.key, state.project.scale), 0, 127)
      : clamp(referencePitch, 0, 127)
    const note = createNote(pitch, tidy(relative), unit, 100)
    state.addNotes(info.track.id, info.clip.id, [note])
    state.setSelectedNotes([note.id])
    previewPitch(pitch)
    pushToast('success', `已在播放头写入 ${pitchToName(pitch)}`)
  }

  const createNoteAtPoint = (point: { x: number; y: number }) => {
    const state = useStore.getState()
    const info = findClipById(state.project, state.selection.clipId ?? '')
    if (!info) return
    const lock = useUiStore.getState().scaleLock && info.track.kind !== 'drum'
    const unit = state.snap > 0 ? state.snap : 1
    const rawPitch = clamp(pitchAtY(point.y), 0, 127)
    const pitch = lock ? clamp(snapToScale(rawPitch, state.project.key, state.project.scale), 0, 127) : rawPitch
    const start = tidy(Math.max(0, snapBeat(beatAtX(point.x), state.snap, 'floor')))
    const note = createNote(pitch, start, unit, 100)
    state.addNotes(info.track.id, info.clip.id, [note])
    state.setSelectedNotes([note.id])
    previewPitch(pitch)
  }

  // 键盘 / editorBus 通过 ref 取最新动作，避免闭包过期
  actionsRef.current = {
    zoomBy,
    zoomFit,
    selectAllNotes,
    deleteSelection,
    copySelection,
    pasteClipboard,
    duplicateSelection,
    applyQuantize,
    applyHumanize,
    transposeSelection,
    splitAtPlayhead,
    createNoteAtPlayhead,
  }

  /* ---------------- 拖拽：移动音符 ---------------- */
  const startMoveNotes = (event: React.PointerEvent, ids: string[], anchorNote: NoteEvent) => {
    const startX = event.clientX
    const startY = event.clientY
    const anchorPitch = anchorNote.pitch
    const anchorStart = anchorNote.start
    let moved = false
    beginInteraction(event, {
      onMove: (moveEvent) => {
        const dx = moveEvent.clientX - startX
        const dy = moveEvent.clientY - startY
        if (!moved && Math.hypot(dx, dy) < 3) return
        moved = true
        const state = useStore.getState()
        const unit = state.snap > 0 ? state.snap : gridUnit(state.snap)
        const deltaBeats = Math.round(dx / pxPerBeat / unit) * unit
        let deltaSemis = -Math.round(dy / pitchHeight)
        if (useUiStore.getState().scaleLock && trackRef.current?.kind !== 'drum') {
          const targetPitch = clamp(anchorPitch + deltaSemis, 0, 127)
          deltaSemis = snapToScale(targetPitch, state.project.key, state.project.scale) - anchorPitch
        }
        previewRef.current = { ids: new Set(ids), deltaBeats, deltaSemis, mode: 'move' }
        const point = localPoint(moveEvent)
        dragTipRef.current = {
          x: point.x,
          y: point.y,
          lines: [
            `${pitchToName(clamp(anchorPitch + deltaSemis, 0, 127))} · 第 ${tidy(Math.max(0, anchorStart + deltaBeats))} 拍`,
            `Δ ${deltaBeats >= 0 ? '+' : ''}${tidy(deltaBeats)} 拍 / ${deltaSemis >= 0 ? '+' : ''}${deltaSemis} 半音`,
          ],
        }
        scheduleDraw()
      },
      onUp: () => {
        const preview = previewRef.current
        previewRef.current = null
        dragTipRef.current = null
        const currentClip = clipRef.current
        if (!moved || !preview || !currentClip) {
          scheduleDraw()
          return
        }
        const state = useStore.getState()
        state.mutate((draft) => {
          const target = findClipById(draft, currentClip.id)?.clip
          if (!target) return
          for (const note of target.notes) {
            if (!preview.ids.has(note.id)) continue
            note.start = tidy(Math.max(0, note.start + preview.deltaBeats))
            note.pitch = clamp(note.pitch + preview.deltaSemis, 0, 127)
          }
        })
        scheduleDraw()
      },
    })
  }

  /* ---------------- 拖拽：改时长 ---------------- */
  const startResizeNotes = (event: React.PointerEvent, ids: string[], anchorNote: NoteEvent) => {
    const startX = event.clientX
    const anchorDuration = anchorNote.duration
    let moved = false
    beginInteraction(event, {
      onMove: (moveEvent) => {
        const dx = moveEvent.clientX - startX
        if (!moved && Math.abs(dx) < 3) return
        moved = true
        const state = useStore.getState()
        const unit = state.snap > 0 ? state.snap : gridUnit(state.snap)
        const deltaBeats = Math.round(dx / pxPerBeat / unit) * unit
        previewRef.current = { ids: new Set(ids), deltaBeats, deltaSemis: 0, mode: 'resize' }
        const point = localPoint(moveEvent)
        dragTipRef.current = {
          x: point.x,
          y: point.y,
          lines: [`时值 ${Math.max(1 / 32, anchorDuration + deltaBeats).toFixed(2)} 拍`],
        }
        scheduleDraw()
      },
      onUp: () => {
        const preview = previewRef.current
        previewRef.current = null
        dragTipRef.current = null
        const currentClip = clipRef.current
        if (!moved || !preview || !currentClip) {
          scheduleDraw()
          return
        }
        const state = useStore.getState()
        state.mutate((draft) => {
          const target = findClipById(draft, currentClip.id)?.clip
          if (!target) return
          for (const note of target.notes) {
            if (!preview.ids.has(note.id)) continue
            note.duration = tidy(Math.max(1 / 32, note.duration + preview.deltaBeats))
          }
        })
        scheduleDraw()
      },
    })
  }

  /* ---------------- 拖拽：框选 ---------------- */
  const startMarquee = (event: React.PointerEvent, point: { x: number; y: number }) => {
    const startX = point.x
    const startY = point.y
    let moved = false
    beginInteraction(event, {
      onMove: (moveEvent) => {
        const current = localPoint(moveEvent)
        if (!moved && Math.hypot(current.x - startX, current.y - startY) < 4) return
        moved = true
        marqueeRef.current = { x1: startX, y1: startY, x2: current.x, y2: current.y }
        scheduleDraw()
      },
      onUp: () => {
        const box = marqueeRef.current
        marqueeRef.current = null
        const currentClip = clipRef.current
        if (!moved || !box || !currentClip) {
          // 单击空白 = 在网格上新建一个音符
          if (!moved) createNoteAtPoint(point)
          scheduleDraw()
          return
        }
        const left = Math.min(box.x1, box.x2)
        const right = Math.max(box.x1, box.x2)
        const top = Math.min(box.y1, box.y2)
        const bottom = Math.max(box.y1, box.y2)
        const ids = currentClip.notes
          .filter((note) => {
            const noteX = layout.gridLeft + (note.start - scrollBeat) * pxPerBeat
            const noteWidth = Math.max(3, note.duration * pxPerBeat)
            const noteY = (topPitchRef.current - note.pitch) * pitchHeight
            return noteX + noteWidth >= left && noteX <= right && noteY + pitchHeight >= top && noteY <= bottom
          })
          .map((note) => note.id)
        useStore.getState().setSelectedNotes(ids)
        scheduleDraw()
      },
    })
  }

  /* ---------------- 拖拽：⌘ + 拖拽画出指定长度音符 ---------------- */
  const startCreateNote = (event: React.PointerEvent, point: { x: number; y: number }) => {
    const state = useStore.getState()
    const lock = useUiStore.getState().scaleLock && trackRef.current?.kind !== 'drum'
    const unit = state.snap > 0 ? state.snap : 1
    const rawPitch = clamp(pitchAtY(point.y), 0, 127)
    const pitch = lock ? clamp(snapToScale(rawPitch, state.project.key, state.project.scale), 0, 127) : rawPitch
    const anchorBeat = tidy(Math.max(0, snapBeat(beatAtX(point.x), state.snap, 'floor')))
    ghostRef.current = { pitch, start: anchorBeat, duration: unit }
    scheduleDraw()
    beginInteraction(event, {
      onMove: (moveEvent) => {
        const current = localPoint(moveEvent)
        const raw = beatAtX(current.x)
        const s = useStore.getState()
        const gridStep = s.snap > 0 ? s.snap : gridUnit(s.snap)
        const duration = Math.max(gridStep, Math.abs(snapBeat(raw, s.snap, 'round') - anchorBeat))
        const startAt = raw >= anchorBeat ? anchorBeat : anchorBeat - duration
        ghostRef.current = { pitch, start: tidy(Math.max(0, startAt)), duration: tidy(duration) }
        dragTipRef.current = {
          x: current.x,
          y: current.y,
          lines: [
            `${pitchToName(pitch)} · ${tidy(duration)} 拍`,
            `起点 ${tidy(Math.max(0, startAt))} 拍`,
          ],
        }
        scheduleDraw()
      },
      onUp: () => {
        const ghost = ghostRef.current
        ghostRef.current = null
        dragTipRef.current = null
        const currentClip = clipRef.current
        const currentTrack = trackRef.current
        if (!ghost || !currentClip || !currentTrack) {
          scheduleDraw()
          return
        }
        const s = useStore.getState()
        const note = createNote(ghost.pitch, ghost.start, Math.max(1 / 32, ghost.duration), 100)
        s.addNotes(currentTrack.id, currentClip.id, [note])
        s.setSelectedNotes([note.id])
        previewPitch(ghost.pitch)
        scheduleDraw()
      },
    })
  }

  /* ---------------- 拖拽：力度条（多选整体调整） ---------------- */
  const startVelocityDrag = (event: React.PointerEvent, point: { x: number; y: number }) => {
    const currentClip = clipRef.current
    if (!currentClip) return
    const beat = beatAtX(point.x)
    let nearest: NoteEvent | null = null
    let nearestDistance = Infinity
    for (const note of currentClip.notes) {
      const center = note.start + note.duration / 2
      const distance = Math.abs(center - beat) * pxPerBeat
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearest = note
      }
    }
    if (!nearest || nearestDistance > 16) return
    const state = useStore.getState()
    // 拖任一根力度条：若它属于当前多选，则整体改力度；否则先选中它再改
    const ids = state.selection.noteIds.includes(nearest.id) ? state.selection.noteIds : [nearest.id]
    if (!state.selection.noteIds.includes(nearest.id)) state.setSelectedNotes([nearest.id])
    const initialVelocities: Record<string, number> = {}
    for (const note of currentClip.notes) if (ids.includes(note.id)) initialVelocities[note.id] = note.velocity
    const startVelocity = nearest.velocity
    const usable = layout.velocityHeight - 14
    const baseline = layout.velocityTop + 2

    beginInteraction(event, {
      onMove: (moveEvent) => {
        const current = localPoint(moveEvent)
        const ratio = clamp(1 - (current.y - baseline) / usable, 0, 1)
        const velocity = clamp(Math.round(ratio * 127), 1, 127)
        const delta = velocity - startVelocity
        const preview: Record<string, number> = {}
        for (const id of ids) preview[id] = clamp((initialVelocities[id] ?? 90) + delta, 1, 127)
        velocityPreviewRef.current = preview
        dragTipRef.current = { x: current.x, y: current.y, lines: [`力度 ${velocity}`, `${ids.length} 个音符`] }
        scheduleDraw()
      },
      onUp: () => {
        const preview = velocityPreviewRef.current
        velocityPreviewRef.current = null
        dragTipRef.current = null
        const clipNow = clipRef.current
        if (!preview || !clipNow) {
          scheduleDraw()
          return
        }
        useStore.getState().mutate((draft) => {
          const target = findClipById(draft, clipNow.id)?.clip
          if (!target) return
          for (const note of target.notes) {
            const velocity = preview[note.id]
            if (velocity !== undefined) note.velocity = velocity
          }
        })
        scheduleDraw()
      },
    })
  }

  /* ---------------- 拖拽：滚动条 ---------------- */
  const startScrollbarDrag = (event: React.PointerEvent, point: { x: number; y: number }) => {
    const totalBeats = Math.max((clip?.lengthBeats ?? 16) + 8, 16)
    const viewBeats = layout.gridWidth / pxPerBeat
    if (totalBeats <= viewBeats) return
    const startX = point.x
    const startScroll = useStore.getState().scrollBeat
    beginInteraction(event, {
      onMove: (moveEvent) => {
        const current = localPoint(moveEvent)
        const deltaBeats = ((current.x - startX) / layout.gridWidth) * totalBeats
        useStore.getState().setScrollBeat(clamp(startScroll + deltaBeats, 0, totalBeats - viewBeats))
      },
    })
  }

  /* ---------------- 拖拽：琴键试听 ---------------- */
  const startKeyPreview = (event: React.PointerEvent, point: { x: number; y: number }) => {
    let pitch = clamp(pitchAtY(point.y), 0, 127)
    pressedPitchRef.current = pitch
    previewPitch(pitch)
    scheduleDraw()
    beginInteraction(event, {
      onMove: (moveEvent) => {
        const current = localPoint(moveEvent)
        const next = clamp(pitchAtY(current.y), 0, 127)
        if (next === pitch) return
        pitch = next
        pressedPitchRef.current = next
        previewPitch(next)
        scheduleDraw()
      },
      onUp: () => {
        pressedPitchRef.current = null
        scheduleDraw()
      },
    })
  }

  /* ---------------- 指针事件 ---------------- */
  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return
    const point = localPoint(event)
    const region = regionAt(point.x, point.y)

    if (region === 'scrollbar') {
      startScrollbarDrag(event, point)
      return
    }
    if (region === 'keyboard') {
      startKeyPreview(event, point)
      return
    }
    if (region === 'velocity') {
      startVelocityDrag(event, point)
      return
    }
    if (!clip) return

    const hit = hitTestNote(point.x, point.y)
    if (hit) {
      const store = useStore.getState()
      const selectedIds = store.selection.noteIds
      if (hit.edge) {
        const ids = selectedIds.includes(hit.note.id) ? selectedIds : [hit.note.id]
        if (!selectedIds.includes(hit.note.id)) store.setSelectedNotes([hit.note.id])
        startResizeNotes(event, ids, hit.note)
      } else if (event.shiftKey) {
        // Shift + 点击：切换选中，不进入拖拽
        store.toggleNoteSelection(hit.note.id)
        previewPitch(hit.note.pitch)
        return
      } else {
        if (!selectedIds.includes(hit.note.id)) store.setSelectedNotes([hit.note.id])
        const ids = useStore.getState().selection.noteIds
        startMoveNotes(event, ids.includes(hit.note.id) ? ids : [hit.note.id], hit.note)
      }
      previewPitch(hit.note.pitch)
      return
    }

    if (event.metaKey || event.ctrlKey) startCreateNote(event, point)
    else startMarquee(event, point)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (interactingRef.current) return
    const point = localPoint(event)
    const region = regionAt(point.x, point.y)
    const canvas = canvasRef.current
    const hit = region === 'grid' ? hitTestNote(point.x, point.y) : null
    if (canvas) {
      if (region === 'grid') {
        canvas.style.cursor = hit ? (hit.edge ? 'ew-resize' : 'grab') : 'crosshair'
      } else if (region === 'keyboard') {
        canvas.style.cursor = 'pointer'
      } else if (region === 'velocity') {
        canvas.style.cursor = 'ns-resize'
      } else {
        canvas.style.cursor = 'grab'
      }
    }
    const state = useStore.getState()
    const nextHover =
      region === 'grid'
        ? {
            pitch: clamp(pitchAtY(point.y), 0, 127),
            beat: state.snap > 0 ? snapBeat(beatAtX(point.x), state.snap) : beatAtX(point.x),
            noteId: hit?.note.id ?? null,
          }
        : { pitch: null, beat: null, noteId: null }
    const previous = hoverRef.current
    if (previous.pitch === nextHover.pitch && previous.beat === nextHover.beat && previous.noteId === nextHover.noteId) return
    hoverRef.current = nextHover
    scheduleDraw()
  }

  const handlePointerLeave = () => {
    if (interactingRef.current) return
    const previous = hoverRef.current
    if (previous.pitch === null && previous.beat === null && previous.noteId === null) return
    hoverRef.current = { pitch: null, beat: null, noteId: null }
    scheduleDraw()
  }

  /* ---------------- 右键菜单 ---------------- */
  const handleContextMenu = (event: React.MouseEvent<HTMLCanvasElement>) => {
    event.preventDefault()
    if (!clip || !track) return
    const point = localPoint(event)
    const hit = hitTestNote(point.x, point.y)
    const store = useStore.getState()
    if (hit) {
      if (!store.selection.noteIds.includes(hit.note.id)) store.setSelectedNotes([hit.note.id])
      previewPitch(hit.note.pitch)
      setMenu({ x: event.clientX, y: event.clientY, kind: 'note', noteId: hit.note.id })
      return
    }
    // 右键空白 = 取消选择（保留直觉），同时提供粘贴 / 全选 / 在播放头新建
    store.setSelectedNotes([])
    setMenu({ x: event.clientX, y: event.clientY, kind: 'empty' })
  }

  const runMenuAction = (action: () => void) => {
    setMenu(null)
    action()
  }

  /* ---------------- 滚轮：⌘ 缩放 / Shift 纵向缩放 / 双轴滚动 ---------------- */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const element = canvasRef.current
      if (!element) return
      const rect = element.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      const store = useStore.getState()
      const currentLayout = layoutRef.current

      if (event.metaKey || event.ctrlKey) {
        const px = pianoRollPxPerBeat(store.zoomX)
        const beatAtCursor = store.scrollBeat + (x - currentLayout.gridLeft) / Math.max(1, px)
        const factor = event.deltaY > 0 ? 0.9 : 1.12
        store.setZoom(clamp(store.zoomX * factor, MIN_ZOOM_X, MAX_ZOOM_X))
        requestAnimationFrame(() => {
          const nextPx = pianoRollPxPerBeat(useStore.getState().zoomX)
          const nextScroll = beatAtCursor - (x - currentLayout.gridLeft) / nextPx
          useStore.getState().setScrollBeat(Math.max(0, nextScroll))
        })
      } else if (event.shiftKey) {
        const pitchAtCursor = topPitchRef.current - y / pitchHeight
        const nextZoomY = clamp(store.zoomY * (event.deltaY > 0 ? 0.92 : 1.08), MIN_ZOOM_Y, MAX_ZOOM_Y)
        store.setZoom(undefined, nextZoomY)
        const nextPitchHeight = clamp(nextZoomY, PITCH_HEIGHT_MIN, PITCH_HEIGHT_MAX)
        setTopPitch(clamp(Math.round(pitchAtCursor + y / nextPitchHeight), 6, 127))
      } else {
        if (Math.abs(event.deltaX) > 0.5) {
          const px = pianoRollPxPerBeat(store.zoomX)
          store.setScrollBeat(Math.max(0, store.scrollBeat + event.deltaX / px))
        }
        if (Math.abs(event.deltaY) > 0.5) {
          // 滚轮向下 = 看更低的音区
          setTopPitch((previous) => clamp(Math.round(previous - event.deltaY / pitchHeight), 6, 127))
        }
      }
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [pitchHeight])

  /* ---------------- 键盘（仅保留视图内高频操作；⌘J/⌘K/⌘0 等由全局命令派发） ---------------- */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
      const store = useStore.getState()
      if (store.settingsOpen || store.helpOpen || store.exportOpen) return
      const meta = event.metaKey || event.ctrlKey
      const key = event.key
      const actions = actionsRef.current

      if (key === 'Escape') {
        store.clearSelection()
        setMenu(null)
        return
      }
      if (!actions) return
      const info = findClipById(store.project, store.selection.clipId ?? '')
      if (!info) return
      const ids = store.selection.noteIds

      if (meta && key.toLowerCase() === 'a') {
        event.preventDefault()
        actions.selectAllNotes()
        return
      }
      if (meta && key.toLowerCase() === 'c') {
        event.preventDefault()
        actions.copySelection()
        return
      }
      if (meta && key.toLowerCase() === 'v') {
        event.preventDefault()
        actions.pasteClipboard()
        return
      }
      if (meta) return
      if (key === 'Delete' || key === 'Backspace') {
        if (ids.length === 0) return
        event.preventDefault()
        actions.deleteSelection()
        return
      }
      if (key === 'q' || key === 'Q') {
        event.preventDefault()
        actions.applyQuantize(quantizeStrengthRef.current)
        return
      }
      if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') {
        if (ids.length === 0) return
        event.preventDefault()
        if (key === 'ArrowUp' || key === 'ArrowDown') {
          actions.transposeSelection((event.shiftKey ? 12 : 1) * (key === 'ArrowUp' ? 1 : -1))
        } else {
          const unit = gridUnit(store.snap) * (key === 'ArrowRight' ? 1 : -1)
          store.pushHistory()
          store.nudgeNotes(info.track.id, info.clip.id, ids, unit, 0)
          store.setSaveStatus('dirty')
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  /* ---------------- 编辑器命令总线（命令面板 / 全局快捷键统一入口） ---------------- */
  useEffect(
    () =>
      subscribeEditorCommand(({ action, semitones }) => {
        const actions = actionsRef.current
        if (!actions) return
        switch (action) {
          case 'zoom-in':
            actions.zoomBy(1.25)
            break
          case 'zoom-out':
            actions.zoomBy(0.8)
            break
          case 'zoom-fit':
            actions.zoomFit()
            break
          case 'delete':
            actions.deleteSelection()
            break
          case 'select-all':
            actions.selectAllNotes()
            break
          case 'duplicate':
            actions.duplicateSelection()
            break
          case 'quantize':
            actions.applyQuantize(quantizeStrengthRef.current)
            break
          case 'split':
            actions.splitAtPlayhead()
            break
          case 'transpose':
            if (typeof semitones === 'number' && semitones !== 0) actions.transposeSelection(semitones)
            break
          default:
            break
        }
      }),
    [],
  )

  /* ---------------- 空状态 ---------------- */
  const pickerTrack = project.tracks.find((item) => item.id === selectedTrackId) ?? project.tracks[0] ?? null
  const emptyHint = project.tracks.length === 0 ? '先在编曲视图添加一条轨道' : pickerTrack ? '选择一个片段开始编辑' : ''

  const createClipNow = () => {
    if (!pickerTrack) return
    const startBeat = tidy(Math.floor(useStore.getState().playhead / barBeats) * barBeats)
    const id = addClip(pickerTrack.id, {
      name: `${pickerTrack.name} 片段`,
      startBeat,
      lengthBeats: barBeats * 2,
    })
    if (id) pushToast('success', '已创建 2 小节片段，单击网格即可写音符')
  }

  const menuNote = menu?.kind === 'note' ? clip?.notes.find((note) => note.id === menu.noteId) ?? null : null
  const selectedCount = selection.noteIds.length

  /** 第二行的高频开关：宽屏显示文字，中屏显示图标，窄屏收进「更多」菜单 */
  const toolbarToggles: {
    id: string
    label: string
    title: string
    icon: ReactNode
    active?: boolean
    disabled?: boolean
    action?: boolean
    onClick: () => void
  }[] = [
    {
      id: 'scale-lock',
      label: '音阶锁定',
      title: `音阶锁定：新建 / 拖动音符吸附到 ${project.key} ${SCALES[project.scale]?.name ?? project.scale} 调内音级`,
      icon: scaleLock ? <Lock size={12} /> : <LockOpen size={12} />,
      active: scaleLock,
      onClick: () => setScaleLock(!scaleLock),
    },
    {
      id: 'ghost-notes',
      label: '幽灵音符',
      title: '幽灵音符：淡显同轨道其它片段里、前后 ±2 小节的音符，方便对位写作',
      icon: <Ghost size={12} />,
      active: showGhostNotes,
      onClick: () => setShowGhostNotes(!showGhostNotes),
    },
    {
      id: 'humanize',
      label: '人性化',
      title: '人性化：对选中音符（未选中则整个片段）做微小的时值与力度扰动，可撤销',
      icon: <Sparkles size={12} />,
      disabled: !clip || clip.notes.length === 0,
      action: true,
      onClick: applyHumanize,
    },
    {
      id: 'zoom-fit',
      label: '适合窗口',
      title: '缩放至适合窗口（⌘0）：水平适配片段长度，纵向适配音域',
      icon: <Maximize2 size={12} />,
      disabled: !clip,
      action: true,
      onClick: zoomFit,
    },
    {
      id: 'follow',
      label: '跟随',
      title: '播放时自动跟随播放头滚动（F）',
      icon: <MoveHorizontal size={12} />,
      active: followPlayhead,
      onClick: toggleFollowPlayhead,
    },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-soft">
      {/* 工具栏第一行：片段信息 + 撤销 + 缩放 */}
      <div className="flex h-[38px] shrink-0 items-center gap-1.5 border-b border-line px-2.5">
        <IconButton title="返回编曲视图（1）" onClick={() => setView('arrangement')} className="h-7 w-7">
          <Boxes size={13} />
        </IconButton>
        <span className="vdivider mx-1 h-5" />
        {clipInfo ? (
          <>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: trackColor(clipInfo.track.color) }} />
            <span className="max-w-[130px] truncate text-[10.5px] text-ink-3" title={clipInfo.track.name}>
              {clipInfo.track.name}
            </span>
            <span className="text-[10px] text-ink-4">/</span>
            <span className="max-w-[160px] truncate text-[12px] font-medium" title={clipInfo.clip.name}>
              {clipInfo.clip.name}
            </span>
            {clipInfo.clip.smart && toolbarMode !== 'narrow' && (
              <span className="rounded border border-violet/40 bg-violet/12 px-1 py-[1px] text-[9px] text-violet">
                智能 {SMART_KIND_META[clipInfo.clip.smart.kind].name}
              </span>
            )}
            {toolbarMode !== 'narrow' && (
              <span className="mono text-[10px] text-ink-4">{clipInfo.clip.notes.length} 音符</span>
            )}
            {selectedCount > 0 && (
              <span className="rounded bg-accent/12 px-1.5 py-[1px] text-[9.5px] text-accent-soft">已选 {selectedCount}</span>
            )}
          </>
        ) : (
          <span className="text-[11px] text-ink-4">未选择片段</span>
        )}
        <div className="flex-1" />
        <IconButton title="撤销（⌘Z）" disabled={!canUndo} onClick={undo} className="h-7 w-7">
          <Undo2 size={13} />
        </IconButton>
        <IconButton title="重做（⌘⇧Z）" disabled={!canRedo} onClick={redo} className="h-7 w-7">
          <Redo2 size={13} />
        </IconButton>
        <span className="vdivider mx-1 h-5" />
        <IconButton
          title="缩小时间轴（⌘滚轮）"
          onClick={() => zoomBy(0.8)}
          className="h-7 w-7"
        >
          <ZoomOut size={12} />
        </IconButton>
        <span className="mono w-[42px] text-center text-[10px] tabular-nums text-ink-4">{pxPerBeat.toFixed(0)}px</span>
        <IconButton title="放大时间轴（⌘滚轮）" onClick={() => zoomBy(1.25)} className="h-7 w-7">
          <ZoomIn size={12} />
        </IconButton>
      </div>

      {/* 工具栏第二行：按可用宽度自适应（宽屏文字 / 中屏图标 / 窄屏「更多」），不产生隐藏溢出 */}
      <div
        ref={toolbarRef}
        data-toolbar-mode={toolbarMode}
        className="flex h-[36px] shrink-0 items-center gap-1.5 border-b border-line px-2.5"
      >
        <Magnet size={12} className="shrink-0 text-ink-3" />
        <Select
          ariaLabel="吸附网格"
          value={String(snap)}
          onChange={(value) => setSnap(Number(value))}
          className="h-7 w-[92px] shrink-0 text-[11px]"
          options={SNAP_OPTIONS}
        />
        {!ultraNarrow && (
          <>
            <Grid3x3 size={12} className="ml-1 shrink-0 text-ink-3" />
            <Select
              ariaLabel="网格线细度"
              value={gridDivision}
              onChange={(value) => setGridDivision(value as GridDivision)}
              className="h-7 w-[76px] shrink-0 text-[11px]"
              options={GRID_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
            />
          </>
        )}
        <span className="vdivider mx-1 h-5" />
        {!ultraNarrow && (
          <Select
            ariaLabel="量化强度"
            value={String(quantizeStrength)}
            onChange={(value) => setQuantizeStrength(Number(value))}
            className="h-7 w-[86px] shrink-0 text-[11px]"
            options={QUANTIZE_STRENGTH_OPTIONS}
          />
        )}
        <button
          className="btn btn-ghost h-7 shrink-0 px-2 text-[10.5px]"
          onClick={() => applyQuantize(quantizeStrength)}
          title={`量化到吸附网格（Q），按 ${strengthLabel(quantizeStrength)} 强度插值`}
          disabled={!clip}
        >
          <Eraser size={12} />
          量化
        </button>
        <span className="vdivider mx-1 h-5" />
        {toolbarMode === 'wide' &&
          toolbarToggles.map((toggle) => (
            <button
              key={toggle.id}
              type="button"
              className={cn('btn btn-ghost h-7 shrink-0 px-2 text-[10.5px]', toggle.active && 'text-accent')}
              aria-pressed={toggle.action ? undefined : toggle.active}
              aria-label={toggle.label}
              title={toggle.title}
              disabled={toggle.disabled}
              onClick={toggle.onClick}
            >
              {toggle.icon}
              {toggle.label}
            </button>
          ))}
        {toolbarMode === 'compact' &&
          toolbarToggles.map((toggle) => (
            <button
              key={toggle.id}
              type="button"
              className={cn('btn btn-ghost h-7 w-7 shrink-0 px-0', toggle.active && 'text-accent')}
              aria-pressed={toggle.action ? undefined : toggle.active}
              aria-label={toggle.label}
              title={toggle.title}
              disabled={toggle.disabled}
              onClick={toggle.onClick}
            >
              {toggle.icon}
            </button>
          ))}
        <span className="vdivider mx-1 h-5" />
        {/* 低频操作收进「更多」菜单，保证 1024px 编辑区也不溢出（DAW 常见做法） */}
        <button
          className={cn('btn btn-ghost h-7 shrink-0 gap-1 px-2 text-[10.5px]', moreAnchor && 'text-accent')}
          aria-label="更多编辑操作"
          aria-haspopup="menu"
          aria-expanded={Boolean(moreAnchor)}
          title="更多编辑操作：移调 / 复制粘贴 / 删除 / 全选 / 显示选项"
          onClick={(event) => setMoreAnchor(moreAnchor ? null : event.currentTarget.getBoundingClientRect())}
        >
          <MoreHorizontal size={13} />
          更多
        </button>
        <div className="flex-1" />
      </div>

      {/* 更多操作菜单 */}
      {moreAnchor && (
        <Popover
          anchor={moreAnchor}
          width={248}
          estimatedHeight={toolbarMode === 'narrow' ? 600 : 460}
          onClose={() => setMoreAnchor(null)}
          label="更多编辑操作"
        >
          <div className="py-1">
            {ultraNarrow && (
              <>
                <MenuLabel>网格与量化</MenuLabel>
                <div className="space-y-1.5 px-2 pb-2">
                  <Select
                    ariaLabel="网格线细度"
                    value={gridDivision}
                    onChange={(value) => setGridDivision(value as GridDivision)}
                    className="h-7 w-full text-[11px]"
                    options={GRID_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                  />
                  <Select
                    ariaLabel="量化强度"
                    value={String(quantizeStrength)}
                    onChange={(value) => setQuantizeStrength(Number(value))}
                    className="h-7 w-full text-[11px]"
                    options={QUANTIZE_STRENGTH_OPTIONS}
                  />
                </div>
                <MenuDivider />
              </>
            )}
            {toolbarMode === 'narrow' && (
              <>
                <MenuLabel>显示与工具</MenuLabel>
                {toolbarToggles.map((toggle) => (
                  <MenuItem
                    key={toggle.id}
                    icon={toggle.icon}
                    label={toggle.label}
                    title={toggle.title}
                    checked={toggle.action ? undefined : toggle.active}
                    disabled={toggle.disabled}
                    onClick={() => {
                      toggle.onClick()
                      if (toggle.action) setMoreAnchor(null)
                    }}
                  />
                ))}
                <MenuDivider />
              </>
            )}
            <MenuLabel>移调（已选 {selectedCount} 个音符）</MenuLabel>
            {[-12, -1, 1, 12].map((semitones) => (
              <MenuItem
                key={semitones}
                label={semitones > 0 ? `升高 ${semitones} 半音` : `降低 ${Math.abs(semitones)} 半音`}
                hint={semitones > 0 ? `+${semitones}` : String(semitones)}
                shortcut={semitones === 1 ? 'Shift+↑' : semitones === -1 ? 'Shift+↓' : undefined}
                disabled={!clip || selectedCount === 0}
                onClick={() => {
                  transposeSelection(semitones)
                  setMoreAnchor(null)
                }}
              />
            ))}
            <MenuDivider />
            <MenuItem
              icon={<ClipboardCopy size={11} />}
              label="复制选中音符"
              shortcut="⌘C"
              disabled={!clip}
              onClick={() => {
                copySelection()
                setMoreAnchor(null)
              }}
            />
            <MenuItem
              icon={<ClipboardPaste size={11} />}
              label="粘贴到播放头"
              shortcut="⌘V"
              disabled={!clip || clipboardRef.current.length === 0}
              onClick={() => {
                pasteClipboard()
                setMoreAnchor(null)
              }}
            />
            <MenuItem
              icon={<SquareDashed size={11} />}
              label="全选本片段音符"
              shortcut="⌘A"
              disabled={!clip}
              onClick={() => {
                selectAllNotes()
                setMoreAnchor(null)
              }}
            />
            <MenuItem
              icon={<Trash2 size={11} />}
              label="删除选中音符"
              shortcut="Del"
              danger
              disabled={!clip || selectedCount === 0}
              onClick={() => {
                deleteSelection()
                setMoreAnchor(null)
              }}
            />
            <MenuDivider />
            <MenuItem
              checked={scaleHighlight}
              label="音阶高亮"
              title="高亮调内音，淡化调外音"
              onClick={() => setScaleHighlight((value) => !value)}
            />
            <MenuItem
              checked={velocityLane}
              label="力度条"
              title="显示 / 隐藏力度条（可多选后整体拖动）"
              onClick={() => setVelocityLane(!velocityLane)}
            />
          </div>
        </Popover>
      )}

      {/* 画布 */}
      <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden">
        <canvas
          ref={canvasRef}
          aria-label="钢琴卷帘画布：单击写音符，拖拽框选，右键打开音符菜单"
          className="absolute inset-0 block h-full w-full touch-none"
          style={{ cursor: 'crosshair' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
          onContextMenu={handleContextMenu}
        />
        <div
          ref={playheadRef}
          className="pointer-events-none absolute top-0 w-[1.5px] bg-accent shadow-[0_0_8px_rgba(240,180,41,0.85)]"
          style={{ left: -20, height: 0, opacity: 0 }}
        />

        {/* 未选择片段的引导 */}
        {!clipInfo && (
          <div className="absolute inset-0 z-10 flex items-center justify-center overflow-auto bg-bg-soft/95 p-6 backdrop-blur-sm">
            <div className="panel w-full max-w-md p-5">
              {project.tracks.length === 0 ? (
                <>
                  <EmptyState
                    icon={<Piano size={22} />}
                    title="还没有任何轨道"
                    hint="先去编曲视图添加一条乐器轨道，再回到这里写音符。"
                  />
                  <button className="btn btn-accent mt-2 h-8 w-full text-[12px]" onClick={() => setView('arrangement')}>
                    去编曲视图
                  </button>
                </>
              ) : (
                <>
                  <EmptyState
                    icon={<Piano size={22} />}
                    title={emptyHint}
                    hint="钢琴卷帘编辑的是「当前选中的片段」。可以从下面挑一个片段，或直接新建。"
                  />
                  <div className="mt-2 max-h-[180px] space-y-1 overflow-y-auto">
                    {pickerTrack?.clips.map((item) => (
                      <button
                        key={item.id}
                        className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface-2/60 px-2.5 py-2 text-left transition-colors hover:border-accent/40 hover:bg-surface-3"
                        onClick={() => selectClip(pickerTrack.id, item.id)}
                      >
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: trackColor(pickerTrack.color) }} />
                        <span className="min-w-0 flex-1 truncate text-[12px]">{item.name}</span>
                        <span className="mono shrink-0 text-[10px] text-ink-4">
                          {item.lengthBeats} 拍 · {item.notes.length} 音符
                        </span>
                      </button>
                    ))}
                    {pickerTrack && pickerTrack.clips.length === 0 && (
                      <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[11px] text-ink-4">
                        这条轨道上还没有片段
                      </div>
                    )}
                  </div>
                  <button
                    className="btn btn-accent mt-2.5 h-8 w-full text-[12px]"
                    onClick={createClipNow}
                    disabled={!pickerTrack}
                  >
                    <Plus size={12} />
                    在「{pickerTrack?.name ?? '轨道'}」上新建 2 小节片段
                  </button>
                  <p className="mt-2 text-center text-[9.5px] leading-relaxed text-ink-4">
                    写音符后：右键音符可删除 / 复制 / 量化 / 移调；右键空白可粘贴、全选或在播放头新建。
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 底部状态条 */}
      <div className="flex h-[24px] shrink-0 items-center gap-3 border-t border-line px-2.5 text-[9.5px] text-ink-4">
        <span>
          音域{' '}
          {clip && clip.notes.length > 0
            ? `${pitchToName(Math.min(...clip.notes.map((note) => note.pitch)))} – ${pitchToName(
                Math.max(...clip.notes.map((note) => note.pitch)),
              )}`
            : '—'}
        </span>
        <span>·</span>
        <span>
          {project.key} 调 {SCALES[project.scale]?.name ?? project.scale} · {barBeats}/4
        </span>
        {scaleLock && (
          <>
            <span>·</span>
            <span className="text-accent-soft">音阶锁定</span>
          </>
        )}
        {showGhostNotes && ghostNotes.length > 0 && (
          <>
            <span>·</span>
            <span>幽灵 {ghostNotes.length}</span>
          </>
        )}
        <div className="flex-1" />
        <span className="mono">
          {Math.round(pxPerBeat)}px/拍 · 行高 {pitchHeight}px
        </span>
      </div>

      {/* 音符右键菜单 */}
      {menu && menu.kind === 'note' && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          label={menuNote ? `${pitchToName(menuNote.pitch)} · 已选 ${Math.max(1, selectedCount)} 个音符` : '音符'}
        >
          <MenuItem
            icon={<Trash2 size={11} />}
            label="删除音符"
            shortcut="Del"
            danger
            onClick={() => runMenuAction(() => deleteSelection())}
          />
          <MenuItem icon={<Copy size={11} />} label="复制" shortcut="⌘C" onClick={() => runMenuAction(() => copySelection())} />
          <MenuItem
            icon={<Eraser size={11} />}
            label={`量化（${strengthLabel(quantizeStrength)}）`}
            shortcut="Q"
            onClick={() => runMenuAction(() => applyQuantize(quantizeStrength, useStore.getState().selection.noteIds))}
          />
          <MenuDivider />
          <MenuItem label="力度 +10" onClick={() => runMenuAction(() => adjustVelocity(10))} />
          <MenuItem label="力度 −10" onClick={() => runMenuAction(() => adjustVelocity(-10))} />
          <MenuDivider />
          <MenuItem label="移调 +1 半音" shortcut="⇧↑" onClick={() => runMenuAction(() => transposeSelection(1))} />
          <MenuItem label="移调 −1 半音" shortcut="⇧↓" onClick={() => runMenuAction(() => transposeSelection(-1))} />
          <MenuItem label="升高八度" shortcut="+12" onClick={() => runMenuAction(() => transposeSelection(12))} />
          <MenuItem label="降低八度" shortcut="−12" onClick={() => runMenuAction(() => transposeSelection(-12))} />
          <MenuDivider />
          <MenuItem label="时值 ×2" onClick={() => runMenuAction(() => scaleDuration(2))} />
          <MenuItem label="时值 ÷2" onClick={() => runMenuAction(() => scaleDuration(0.5))} />
          <MenuDivider />
          <MenuItem
            label="取消选择"
            shortcut="Esc"
            onClick={() => runMenuAction(() => useStore.getState().setSelectedNotes([]))}
          />
        </ContextMenu>
      )}

      {/* 空白右键菜单 */}
      {menu && menu.kind === 'empty' && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} label="空白处">
          <MenuItem
            icon={<ClipboardPaste size={11} />}
            label="粘贴到播放头"
            shortcut="⌘V"
            disabled={clipboardRef.current.length === 0}
            onClick={() => runMenuAction(() => pasteClipboard())}
          />
          <MenuItem icon={<SquareDashed size={11} />} label="全选音符" shortcut="⌘A" onClick={() => runMenuAction(selectAllNotes)} />
          <MenuItem
            icon={<Plus size={11} />}
            label="在播放头新建音符"
            onClick={() => runMenuAction(createNoteAtPlayhead)}
          />
          <MenuDivider />
          <MenuItem icon={<ClipboardCopy size={11} />} label="复制选中音符" shortcut="⌘C" onClick={() => runMenuAction(() => copySelection())} />
          <MenuItem
            icon={<Trash2 size={11} />}
            label="删除选中音符"
            shortcut="Del"
            danger
            disabled={selectedCount === 0}
            onClick={() => runMenuAction(() => deleteSelection())}
          />
        </ContextMenu>
      )}
    </div>
  )
}
