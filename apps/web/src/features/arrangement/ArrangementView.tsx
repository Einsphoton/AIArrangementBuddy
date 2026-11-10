/**
 * 编曲视图：多轨时间轴 + 时间轴工具条。
 *
 * 结构：
 *   工具条(38px，与左侧轨道面板同高工具条对齐)
 *   └─ 单一滚动容器：sticky 标尺 + 绝对定位的片段 + 播放头
 *
 * 关键约定：
 * - 行高来自 uiStore.trackHeights（未自定义时用 zoomY 推默认值），左侧 TrackPanel 用同一公式，保证严格对齐；
 * - 网格、小节线用 CSS repeating-gradient 绘制，缩放时只改样式，零 DOM 增量；
 * - 拖动/框选用 history:false 的批量 mutate，一次手势只产生一个撤销点；
 * - 片段内音符缩略图用 canvas（内容哈希缓存，拖拽不重绘）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  Boxes,
  ClipboardPaste,
  Copy,
  Grid3x3,
  Layers,
  Piano,
  Play,
  Plus,
  Scissors,
  Sparkles,
  Trash2,
  Wand2,
  Waves,
} from 'lucide-react'
import {
  chordTimeline,
  createSection,
  projectEndBar,
  type Section,
} from '@aiab/core'
import { getAudioEngine } from '../../audio'
import { ContextMenu, MenuDivider, MenuItem, MenuLabel } from '../../components/ui/menu'
import { getAssetPeaks } from '../../lib/api'
import { cn, formatRelativeTime } from '../../lib/format'
import { useStore } from '../../store/store'
import { modSymbol } from '../../lib/shortcuts'
import { resolveTrackHeight, useUiStore, type EditorTool } from '../../lib/uiStore'
import { subscribeEditorCommand } from '../../lib/editorBus'
import { InstrumentPicker, popoverPosition } from '../tracks/InstrumentPicker'
import { RepaintAudioDialog } from '../audio/RepaintAudioDialog'
import { StemGenerateDialog } from '../audio/StemGenerateDialog'
import { primeAssetPeaks } from '../audio/peaks'
import { switchActiveTake } from '../audio/audioTrack'
import { AudioClipView } from './AudioClipView'
import { ClipView, type ClipDragMode } from './ClipView'
import { TimelineToolbar } from './TimelineToolbar'
import {
  beginEdit,
  copySelection,
  deleteClips,
  duplicateClipsAfter,
  duplicateClipsInPlace,
  locateClips,
  moveClipsBy,
  nudgeClips,
  pasteClipboard,
  quantizeClips,
  splitClipAtPoint,
  splitClipsAtBeat,
  transposeClips,
  type ClipboardEntry,
  type ClipLocation,
} from './clipEditing'
import {
  arrangementPxPerBeat,
  BAR_RULER_HEIGHT,
  clamp,
  fitZoomXForWidth,
  formatDragPosition,
  gridUnit,
  LOOP_STRIP_HEIGHT,
  MAX_ZOOM_X,
  MAX_ZOOM_Y,
  MIN_ZOOM_X,
  MIN_ZOOM_Y,
  publishVerticalScroll,
  rowHeightForZoom,
  RULER_HEIGHT,
  SECTION_STRIP_HEIGHT,
  snapBeat,
  subscribeVerticalScroll,
  tidy,
  trackColor,
  withAlpha,
} from './timeline'
import { usePointerDrag } from './usePointerDrag'

const SECTION_COLORS = ['#8b7bff', '#3ddbd9', '#f472b6', '#a3e635', '#f0b429', '#4ea1ff']

interface Marquee {
  x1: number
  y1: number
  x2: number
  y2: number
}

interface ClipMenuState {
  x: number
  y: number
  trackId: string
  clipId: string
}

interface EmptyMenuState {
  x: number
  y: number
  beat: number
}

/** 音频片段右键菜单（音频片段与 MIDI 片段的选择/删除是两套，见下方 selectedAudioIds） */
interface AudioClipMenuState {
  x: number
  y: number
  trackId: string
  clipId: string
}

/** 音频片段「切换版本（takes）」弹层 */
interface TakeMenuState {
  x: number
  y: number
  trackId: string
  clipId: string
}

/** 局部重绘对话框目标 */
interface RepaintTargetState {
  trackId: string
  clipId: string
}

/** P5-B：生成分轨 Stem 对话框目标 */
type StemTargetState = RepaintTargetState

/* ------------------------------------------------------------------ */
/* 标尺（循环条 / 段落条 / 小节号）                                     */
/* ------------------------------------------------------------------ */

function Ruler({
  pxPerBeat,
  barBeats,
  totalBeats,
  sections,
  chords,
  loop,
}: {
  pxPerBeat: number
  barBeats: number
  totalBeats: number
  sections: Section[]
  chords: ReturnType<typeof chordTimeline>
  loop: { enabled: boolean; startBeat: number; endBeat: number }
}) {
  const drag = usePointerDrag()
  const loopStripRef = useRef<HTMLDivElement>(null)
  const rulerRef = useRef<HTMLDivElement>(null)
  const [renamingSectionId, setRenamingSectionId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')

  const beatAt = (element: HTMLElement | null, clientX: number): number => {
    if (!element) return 0
    const rect = element.getBoundingClientRect()
    return Math.max(0, (clientX - rect.left) / pxPerBeat)
  }

  const pxPerBar = barBeats * pxPerBeat

  /* ---------- 循环区 ---------- */

  const startLoopDrag = (event: React.PointerEvent, mode: 'band' | 'left' | 'right') => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const store = useStore.getState()
    const initial = { ...store.project.loop }
    const anchor = snapBeat(beatAt(loopStripRef.current, event.clientX), gridUnit(store.snap))
    const inside = anchor > initial.startBeat && anchor < initial.endBeat && store.loopEnabled

    drag(event, {
      onMove: (moveEvent) => {
        const current = snapBeat(beatAt(loopStripRef.current, moveEvent.clientX), gridUnit(useStore.getState().snap))
        const state = useStore.getState()
        if (mode === 'band' && inside) {
          const length = initial.endBeat - initial.startBeat
          const delta = current - anchor
          const nextStart = Math.max(0, initial.startBeat + delta)
          state.setLoopRange(nextStart, nextStart + length)
        } else if (mode === 'left') {
          state.setLoopRange(Math.min(current, initial.endBeat - 0.25), initial.endBeat)
        } else if (mode === 'right') {
          state.setLoopRange(initial.startBeat, Math.max(current, initial.startBeat + 0.25))
        } else {
          state.setLoopRange(anchor, current)
        }
      },
      onUp: () => {
        const state = useStore.getState()
        if (!inside) {
          const span = state.project.loop.endBeat - state.project.loop.startBeat
          if (span < barBeats) state.setLoopRange(state.project.loop.startBeat, state.project.loop.startBeat + barBeats)
        }
        state.setLoopEnabled(true)
        state.setSaveStatus('dirty')
      },
    })
  }

  /* ---------- 段落 ---------- */

  const startSectionDrag = (event: React.PointerEvent, section: Section, mode: 'move' | 'resize') => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const initialStartBar = section.startBar
    const initialBars = section.bars
    let started = false

    drag(event, {
      onMove: (moveEvent) => {
        const dx = moveEvent.clientX - startX
        if (!started) {
          if (Math.abs(dx) < 3) return
          started = true
          useStore.getState().pushHistory()
          useStore.getState().setSaveStatus('dirty')
        }
        const deltaBars = Math.round(dx / Math.max(1, pxPerBar))
        const state = useStore.getState()
        state.mutate(
          (draftProject) => {
            const target = draftProject.sections.find((item) => item.id === section.id)
            if (!target) return
            if (mode === 'move') target.startBar = Math.max(0, initialStartBar + deltaBars)
            else target.bars = Math.max(1, initialBars + deltaBars)
          },
          { history: false },
        )
      },
    })
  }

  const addSection = () => {
    const store = useStore.getState()
    const lastEnd = sections.reduce((end, section) => Math.max(end, section.startBar + section.bars), 0)
    store.addSection(createSection({ name: `段落 ${sections.length + 1}`, startBar: lastEnd, bars: 4 }))
  }

  const commitRename = (section: Section) => {
    const name = draftName.trim()
    setRenamingSectionId(null)
    if (!name || name === section.name) return
    const store = useStore.getState()
    store.setSections(store.project.sections.map((item) => (item.id === section.id ? { ...item, name } : item)))
  }

  /* ---------- 小节标尺（点/拖 = 移动播放头） ---------- */

  const seekFromClientX = (clientX: number) => {
    const beat = beatAt(rulerRef.current, clientX)
    const store = useStore.getState()
    store.setPlayhead(beat)
    if (store.isPlaying) {
      try {
        getAudioEngine().seek(beat)
      } catch {
        /* ignore */
      }
    }
  }

  const onRulerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    seekFromClientX(event.clientX)
    drag(event, { onMove: (moveEvent) => seekFromClientX(moveEvent.clientX) })
  }

  const barCount = Math.max(1, Math.ceil(totalBeats / barBeats))
  const labelEvery = pxPerBar < 26 ? 8 : pxPerBar < 46 ? 4 : pxPerBar < 80 ? 2 : 1
  const showBeatTicks = pxPerBeat >= 22

  return (
    <div className="sticky top-0 z-20 select-none border-b border-line-strong bg-[#0b0e14]" style={{ height: RULER_HEIGHT }}>
      {/* 循环条 */}
      <div
        ref={loopStripRef}
        className="relative cursor-copy border-b border-line/60 bg-bg-soft"
        style={{ height: LOOP_STRIP_HEIGHT }}
        onPointerDown={(event) => startLoopDrag(event, 'band')}
        title="拖动创建循环区间；拖动区间可整体移动"
      >
        <div
          className={cn(
            'absolute inset-y-[2px] rounded-[3px] border transition-colors',
            loop.enabled ? 'border-accent/55 bg-accent/16' : 'border-line-strong bg-surface-3/50',
          )}
          style={{ left: loop.startBeat * pxPerBeat, width: Math.max(6, (loop.endBeat - loop.startBeat) * pxPerBeat) }}
        >
          <div
            className="absolute inset-y-0 left-0 w-[5px] cursor-ew-resize rounded-l-[3px] hover:bg-accent/40"
            title="拖动调整循环起点"
            onPointerDown={(event) => startLoopDrag(event, 'left')}
          />
          <div
            className="absolute inset-y-0 right-0 w-[5px] cursor-ew-resize rounded-r-[3px] hover:bg-accent/40"
            title="拖动调整循环终点"
            onPointerDown={(event) => startLoopDrag(event, 'right')}
          />
        </div>
        <span className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-[8px] font-semibold tracking-[0.14em] text-ink-4">
          LOOP
        </span>
      </div>

      {/* 段落条 */}
      <div className="relative border-b border-line/60 bg-surface/50" style={{ height: SECTION_STRIP_HEIGHT }}>
        {sections.map((section, index) => {
          const color = section.color ?? SECTION_COLORS[index % SECTION_COLORS.length]
          const width = Math.max(14, section.bars * pxPerBar)
          return (
            <div
              key={section.id}
              className="group/section absolute inset-y-[2px] flex cursor-grab items-center gap-1 overflow-hidden rounded-[4px] border px-1.5 active:cursor-grabbing"
              style={{
                left: section.startBar * pxPerBar,
                width,
                borderColor: withAlpha(color, 0.45),
                background: withAlpha(color, 0.16),
              }}
              title={`${section.name} · ${section.bars} 小节（拖动移动，右边缘改长度，双击重命名）`}
              onPointerDown={(event) => startSectionDrag(event, section, 'move')}
              onDoubleClick={(event) => {
                event.stopPropagation()
                setDraftName(section.name)
                setRenamingSectionId(section.id)
              }}
            >
              {renamingSectionId === section.id ? (
                <input
                  autoFocus
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  onPointerDown={(event) => event.stopPropagation()}
                  onBlur={() => commitRename(section)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitRename(section)
                    if (event.key === 'Escape') setRenamingSectionId(null)
                  }}
                  className="w-full min-w-0 rounded bg-bg px-1 text-[9.5px] outline-none"
                  aria-label="段落名称"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate text-[9.5px] font-medium" style={{ color }}>
                  {section.name}
                </span>
              )}
              {/* 能量条 */}
              <span
                className="pointer-events-none absolute inset-x-0 bottom-0 h-[1.5px]"
                style={{ background: withAlpha(color, 0.25 + section.energy * 0.5) }}
              />
              <button
                className="absolute right-1 top-1/2 hidden h-3 w-3 -translate-y-1/2 items-center justify-center rounded bg-black/40 text-ink-2 hover:text-danger group-hover/section:flex"
                title="删除段落"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  useStore.getState().removeSection(section.id)
                }}
              >
                <Trash2 size={8} />
              </button>
              <div
                className="absolute inset-y-0 right-0 w-[5px] cursor-ew-resize bg-transparent hover:bg-white/25"
                onPointerDown={(event) => {
                  event.stopPropagation()
                  startSectionDrag(event, section, 'resize')
                }}
              />
            </div>
          )
        })}
        <button
          className="absolute inset-y-[2px] flex w-[18px] items-center justify-center rounded-[4px] border border-dashed border-line-strong text-ink-4 transition-colors hover:border-accent/50 hover:text-accent"
          style={{ left: sections.reduce((end, section) => Math.max(end, section.startBar + section.bars), 0) * pxPerBar + 6 }}
          title="在末尾添加段落"
          onClick={addSection}
        >
          <Plus size={10} />
        </button>
        <span className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-[8px] font-semibold tracking-[0.14em] text-ink-4">
          SECT
        </span>
      </div>

      {/* 小节标尺 */}
      <div
        ref={rulerRef}
        className="relative cursor-col-resize bg-surface-2/70"
        style={{ height: BAR_RULER_HEIGHT }}
        onPointerDown={onRulerDown}
        title="点击或拖动移动播放头"
      >
        {Array.from({ length: barCount }, (_, index) => {
          const x = index * pxPerBar
          const showLabel = index % labelEvery === 0
          return (
            <div key={index} className="absolute inset-y-0" style={{ left: x }}>
              <span className="absolute left-[3px] top-[2px] h-[5px] w-px bg-line-strong" />
              {showLabel && (
                <span className="mono pointer-events-none absolute left-[5px] top-[2px] text-[9.5px] font-medium tabular-nums text-ink-3">
                  {index + 1}
                </span>
              )}
              {showBeatTicks &&
                Array.from({ length: Math.floor(barBeats) - 1 }, (_, beatIndex) => (
                  <span
                    key={beatIndex}
                    className="absolute bottom-0 h-[3px] w-px bg-line"
                    style={{ left: (beatIndex + 1) * pxPerBeat }}
                  />
                ))}
            </div>
          )
        })}
        {/* 和弦进行 */}
        {pxPerBar >= 44 &&
          chords.map((slot, index) => (
            <span
              key={`${slot.chord.root}-${slot.chord.quality}-${index}`}
              className="pointer-events-none absolute bottom-[1px] truncate text-[8.5px] text-cyan/60"
              style={{ left: slot.startBeat * pxPerBeat + 4, maxWidth: Math.max(18, (slot.endBeat - slot.startBeat) * pxPerBeat - 6) }}
            >
              {chordLabelSafe(slot.chord)}
            </span>
          ))}
        <span className="pointer-events-none absolute right-2 top-[2px] text-[8px] tracking-[0.16em] text-ink-4">BAR</span>
      </div>
    </div>
  )
}

function chordLabelSafe(chord: { root: number; quality: string }): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const qualitySymbols: Record<string, string> = {
    maj: '',
    min: 'm',
    dim: 'dim',
    aug: 'aug',
    sus2: 'sus2',
    sus4: 'sus4',
    maj7: 'maj7',
    min7: 'm7',
    dom7: '7',
    m7b5: 'm7b5',
    dim7: 'dim7',
    mMaj7: 'mMaj7',
    maj9: 'maj9',
    min9: 'm9',
    dom9: '9',
    add9: 'add9',
    six: '6',
    m6: 'm6',
    power: '5',
  }
  return `${names[((chord.root % 12) + 12) % 12]}${qualitySymbols[chord.quality] ?? ''}`
}

/* ------------------------------------------------------------------ */
/* 播放头                                                              */
/* ------------------------------------------------------------------ */

function Playhead({
  pxPerBeat,
  height,
  scrollRef,
}: {
  pxPerBeat: number
  height: number
  scrollRef: React.RefObject<HTMLDivElement | null>
}) {
  const playhead = useStore((s) => s.playhead)
  const playing = useStore((s) => s.isPlaying)
  const followPlayhead = useUiStore((s) => s.followPlayhead)

  /* 播放时按 uiStore.followPlayhead 自动跟随（默认开启） */
  useEffect(() => {
    if (!playing || !followPlayhead) return
    const container = scrollRef.current
    if (!container) return
    const x = playhead * pxPerBeat
    const left = container.scrollLeft
    const right = left + container.clientWidth
    if (x < left + 24 || x > right - 90) {
      container.scrollLeft = Math.max(0, x - container.clientWidth * 0.25)
    }
  }, [playhead, pxPerBeat, playing, followPlayhead, scrollRef])

  return (
    <div className="pointer-events-none absolute top-0 z-30" style={{ left: playhead * pxPerBeat, height }}>
      <div className="absolute -left-[5px] top-0 h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-accent" />
      <div
        className="absolute left-0 top-0 w-[1.5px] bg-accent shadow-[0_0_9px_rgba(240,180,41,0.85)]"
        style={{ height }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 编曲视图                                                            */
/* ------------------------------------------------------------------ */

export function ArrangementView() {
  const project = useStore((s) => s.project)
  const zoomX = useStore((s) => s.zoomX)
  const zoomY = useStore((s) => s.zoomY)
  const selection = useStore((s) => s.selection)
  const selectedTrackId = useStore((s) => s.selectedTrackId)
  const setView = useStore((s) => s.setView)
  const setZoom = useStore((s) => s.setZoom)
  const setSmartClipTarget = useStore((s) => s.setSmartClipTarget)
  const addClip = useStore((s) => s.addClip)
  const addTrack = useStore((s) => s.addTrack)
  const pushToast = useStore((s) => s.pushToast)
  const trackHeights = useUiStore((s) => s.trackHeights)
  const toolMode = useUiStore((s) => s.toolMode)

  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const drag = usePointerDrag()
  const recentActionsRef = useRef<Record<string, number>>({})

  const [selectedIds, setSelectedIds] = useState<string[]>(() => (selection.clipId ? [selection.clipId] : []))
  const selectedIdsRef = useRef(selectedIds)
  selectedIdsRef.current = selectedIds
  const lastStoreClipRef = useRef(selection.clipId)
  const clipboardRef = useRef<ClipboardEntry[]>([])
  const [marquee, setMarquee] = useState<Marquee | null>(null)
  const [clipMenu, setClipMenu] = useState<ClipMenuState | null>(null)
  const [emptyMenu, setEmptyMenu] = useState<EmptyMenuState | null>(null)
  const [audioMenu, setAudioMenu] = useState<AudioClipMenuState | null>(null)
  const [takeMenu, setTakeMenu] = useState<TakeMenuState | null>(null)
  const [repaintTarget, setRepaintTarget] = useState<RepaintTargetState | null>(null)
  const [stemTarget, setStemTarget] = useState<StemTargetState | null>(null)
  /* 音频片段单独一套选择集：不复用 store.selection（那是 MIDI 片段的语义，钢琴卷帘会用） */
  const [selectedAudioIds, setSelectedAudioIds] = useState<string[]>([])
  const selectedAudioIdsRef = useRef(selectedAudioIds)
  selectedAudioIdsRef.current = selectedAudioIds
  const [addTrackAnchor, setAddTrackAnchor] = useState<DOMRect | null>(null)
  /** 滚动容器可视宽度：用于保证横向滚动条常驻，使左右两个滚动容器的可滚范围一致 */
  const [viewportWidth, setViewportWidth] = useState(0)

  /* ---------- 几何 ---------- */

  const barBeats = (project.timeSignature.numerator * 4) / project.timeSignature.denominator
  const pxPerBeat = arrangementPxPerBeat(zoomX)
  const fallbackRowHeight = rowHeightForZoom(zoomY)
  const rowHeights = useMemo(
    () => project.tracks.map((track) => resolveTrackHeight(trackHeights, track.id, fallbackRowHeight)),
    [project.tracks, trackHeights, fallbackRowHeight],
  )
  const rowsHeight = rowHeights.reduce((sum, height) => sum + height, 0)
  const endBar = projectEndBar(project)
  /* 至少画出 10 小节：短工程也有可双击的空白；与「适合窗口」使用同一公式 */
  const totalBars = Math.max(endBar + 2, 10)
  const totalBeats = totalBars * barBeats
  /* 内容宽度至少比视口宽 24px：保证横向滚动条始终存在（固定 10px 高），
     这样 TrackPanel 列表与编曲视图的可滚动范围才能完全一致，滚到底也不跑偏 */
  const contentWidth = Math.max(totalBeats * pxPerBeat, viewportWidth + 24, 320)
  /* 底部留白 84px：TrackPanel 列表尾部是「添加轨道按钮 36px + 58px 留白」= 94px，
     其中多出的 10px 正好等于本视图横向滚动条高度，因此两边的最大 scrollTop 完全一致 */
  const BOTTOM_SPACER = 84
  const contentHeight = RULER_HEIGHT + rowsHeight + BOTTOM_SPACER
  const chords = useMemo(() => chordTimeline(project.chords), [project.chords])
  const totalClips = project.tracks.reduce((sum, track) => sum + track.clips.length, 0)

  const heightsNow = useCallback((): number[] => {
    const ui = useUiStore.getState()
    const fallback = rowHeightForZoom(useStore.getState().zoomY)
    return useStore
      .getState()
      .project.tracks.map((track) => resolveTrackHeight(ui.trackHeights, track.id, fallback))
  }, [])

  const rowIndexAtY = useCallback(
    (y: number): number => {
      const heights = heightsNow()
      let top = RULER_HEIGHT
      for (let index = 0; index < heights.length; index += 1) {
        if (y >= top && y < top + heights[index]) return index
        top += heights[index]
      }
      return -1
    },
    [heightsNow],
  )

  const showTooltip = (clientX: number, clientY: number, text: string) => {
    const element = tooltipRef.current
    if (!element) return
    element.textContent = text
    element.style.left = `${clientX + 14}px`
    element.style.top = `${clientY - 34}px`
    element.style.display = 'block'
  }

  const hideTooltip = () => {
    if (tooltipRef.current) tooltipRef.current.style.display = 'none'
  }

  /* ---------- 选择同步 ---------- */

  useEffect(() => {
    if (selection.clipId === lastStoreClipRef.current) return
    lastStoreClipRef.current = selection.clipId
    setSelectedIds(selection.clipId ? [selection.clipId] : [])
  }, [selection.clipId])

  /* 撤销 / 外部工程变化后，剪掉已经不存在的片段 id */
  useEffect(() => {
    const valid = new Set<string>()
    for (const track of project.tracks) for (const clip of track.clips) valid.add(clip.id)
    setSelectedIds((previous) => (previous.some((id) => !valid.has(id)) ? previous.filter((id) => valid.has(id)) : previous))
  }, [project.tracks])

  /* 音频片段：撤销 / 删除后同步剪掉失效 id */
  useEffect(() => {
    const valid = new Set<string>()
    for (const track of project.tracks) for (const clip of track.audioClips ?? []) valid.add(clip.id)
    setSelectedAudioIds((previous) =>
      previous.some((id) => !valid.has(id)) ? previous.filter((id) => valid.has(id)) : previous,
    )
  }, [project.tracks])

  const selectOnly = useCallback((ids: string[]) => {
    setSelectedIds(ids)
    if (ids.length === 0) return
    const state = useStore.getState()
    const first = locateClips(ids, state.project)[0]
    if (first) {
      lastStoreClipRef.current = first.clipId
      state.selectClip(first.trackId, first.clipId)
    }
  }, [])

  /* ---------- 纵向滚动同步 ---------- */

  useEffect(() => {
    return subscribeVerticalScroll((top, source) => {
      const element = scrollRef.current
      if (!element || source === 'arrangement') return
      if (Math.abs(element.scrollTop - top) > 1) element.scrollTop = top
    })
  }, [])

  /* 记录视口宽度：保证横向滚动条常驻（左右滚动范围一致，见 contentWidth） */
  useEffect(() => {
    const element = scrollRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setViewportWidth(element.clientWidth))
    observer.observe(element)
    setViewportWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])

  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    publishVerticalScroll(event.currentTarget.scrollTop, 'arrangement')
  }

  /* ---------- 缩放：⌘/Ctrl + 滚轮横向，Shift + 滚轮纵向 ---------- */

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const onWheel = (event: WheelEvent) => {
      const store = useStore.getState()
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault()
        const rect = container.getBoundingClientRect()
        const cursorX = event.clientX - rect.left
        const beatAtCursor = (container.scrollLeft + cursorX) / Math.max(1, arrangementPxPerBeat(store.zoomX))
        const factor = event.deltaY > 0 ? 0.88 : 1.14
        const nextZoomX = clamp(store.zoomX * factor, MIN_ZOOM_X, MAX_ZOOM_X)
        store.setZoom(nextZoomX)
        requestAnimationFrame(() => {
          const nextPx = arrangementPxPerBeat(useStore.getState().zoomX)
          container.scrollLeft = Math.max(0, beatAtCursor * nextPx - cursorX)
        })
      } else if (event.shiftKey) {
        event.preventDefault()
        const factor = event.deltaY > 0 ? 0.94 : 1.06
        store.setZoom(undefined, clamp(store.zoomY * factor, MIN_ZOOM_Y, MAX_ZOOM_Y))
      }
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [])

  /* ---------- 缩放动作 ---------- */

  const zoomIn = useCallback(() => {
    const store = useStore.getState()
    store.setZoom(clamp(store.zoomX * 1.25, MIN_ZOOM_X, MAX_ZOOM_X))
  }, [])

  const zoomOut = useCallback(() => {
    const store = useStore.getState()
    store.setZoom(clamp(store.zoomX * 0.8, MIN_ZOOM_X, MAX_ZOOM_X))
  }, [])

  const zoomFit = useCallback(() => {
    const container = scrollRef.current
    if (!container) return
    const store = useStore.getState()
    const bars = Math.max(projectEndBar(store.project) + 2, 10)
    const next = fitZoomXForWidth(bars, container.clientWidth)
    if (next == null) return
    store.setZoom(next)
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollLeft = 0
    })
  }, [])

  const openAddTrack = (rect: DOMRect) => setAddTrackAnchor(rect)

  /* ---------- 片段编辑动作（快捷键 / 命令面板 / 右键菜单共用） ---------- */

  const runAction = useCallback((action: string, fn: () => void) => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const last = recentActionsRef.current[action] ?? 0
    if (now - last < 180) return
    recentActionsRef.current[action] = now
    fn()
  }, [])

  const handleCopy = useCallback(() => {
    const ids = selectedIdsRef.current
    if (ids.length === 0) {
      pushToast('info', '先选中片段再复制')
      return
    }
    clipboardRef.current = copySelection(ids)
    pushToast('info', `已复制 ${clipboardRef.current.length} 个片段`)
  }, [pushToast])

  const handlePasteAt = useCallback(
    (beat: number) => {
      if (clipboardRef.current.length === 0) {
        pushToast('info', '剪贴板为空：先选中片段按 ⌘C')
        return
      }
      const state = useStore.getState()
      const at = state.snap > 0 ? snapBeat(beat, state.snap) : beat
      const newIds = pasteClipboard(clipboardRef.current, Math.max(0, at))
      if (newIds.length === 0) return
      selectOnly(newIds)
      pushToast('success', `已粘贴 ${newIds.length} 个片段到播放头`)
    },
    [pushToast, selectOnly],
  )

  const handlePaste = useCallback(() => {
    handlePasteAt(useStore.getState().playhead)
  }, [handlePasteAt])

  const handleDuplicate = useCallback(() => {
    const ids = selectedIdsRef.current
    if (ids.length === 0) {
      pushToast('info', '先选中片段再复制')
      return
    }
    const newIds = duplicateClipsAfter(ids)
    if (newIds.length === 0) return
    selectOnly(newIds)
    pushToast('success', `已复制 ${newIds.length} 个片段`)
  }, [pushToast, selectOnly])

  const handleDelete = useCallback(() => {
    const ids = selectedIdsRef.current
    if (ids.length === 0) return
    const count = deleteClips(ids)
    setSelectedIds([])
    lastStoreClipRef.current = null
    if (count > 0) pushToast('info', count > 1 ? `已删除 ${count} 个片段` : '已删除片段')
  }, [pushToast])

  /* ---------- 音频片段动作（选择 / 删除，与 MIDI 片段互不影响） ---------- */

  const selectAudioClip = useCallback((trackId: string, clipId: string, additive = false) => {
    setSelectedIds([])
    setSelectedAudioIds((previous) => {
      if (!additive) return [clipId]
      return previous.includes(clipId) ? previous.filter((id) => id !== clipId) : [...previous, clipId]
    })
    useStore.getState().selectTrack(trackId)
  }, [])

  const deleteAudioClips = useCallback((ids: string[]) => {
    if (ids.length === 0) return 0
    const target = new Set(ids)
    let removed = 0
    useStore.getState().mutate((draft) => {
      for (const track of draft.tracks) {
        const before = track.audioClips?.length ?? 0
        track.audioClips = (track.audioClips ?? []).filter((clip) => !target.has(clip.id))
        removed += before - track.audioClips.length
      }
    })
    setSelectedAudioIds([])
    return removed
  }, [])

  const handleSelectAll = useCallback(() => {
    const state = useStore.getState()
    const ids = state.project.tracks.flatMap((track) => track.clips.map((clip) => clip.id))
    if (ids.length === 0) {
      pushToast('info', '工程里还没有片段')
      return
    }
    selectOnly(ids)
    pushToast('info', `已全选 ${ids.length} 个片段`)
  }, [pushToast, selectOnly])

  const handleSplit = useCallback(() => {
    const state = useStore.getState()
    const beat = state.snap > 0 ? snapBeat(state.playhead, state.snap) : state.playhead
    let ids = selectedIdsRef.current
    if (ids.length === 0) {
      ids = state.project.tracks.flatMap((track) =>
        track.clips.filter((clip) => beat > clip.startBeat && beat < clip.startBeat + clip.lengthBeats).map((clip) => clip.id),
      )
    }
    const count = splitClipsAtBeat(ids, beat)
    if (count === 0) {
      pushToast('info', '播放头不在片段内部：先选中片段或移动播放头')
      return
    }
    pushToast('success', `已在播放头处拆分 ${count} 个片段`)
  }, [pushToast])

  const handleQuantize = useCallback(() => {
    const ids = selectedIdsRef.current
    if (ids.length === 0) {
      pushToast('info', '先选中片段再量化')
      return
    }
    const state = useStore.getState()
    const count = quantizeClips(ids, gridUnit(state.snap))
    if (count === 0) pushToast('info', '选中的片段里没有音符')
    else pushToast('success', `已量化 ${count} 个音符到 ${gridUnit(state.snap)} 拍网格`)
  }, [pushToast])

  const handleTranspose = useCallback(
    (semitones: number) => {
      const ids = selectedIdsRef.current
      if (ids.length === 0) {
        pushToast('info', '先选中片段再移调')
        return
      }
      const count = transposeClips(ids, semitones)
      if (count === 0) pushToast('info', '选中的片段里没有音符')
      else pushToast('success', `已移调 ${semitones > 0 ? '+' : ''}${semitones} 个半音（${count} 个音符）`)
    },
    [pushToast],
  )

  const handleNudge = useCallback((beats?: number) => {
    const ids = selectedIdsRef.current
    if (ids.length === 0) return
    const state = useStore.getState()
    const step = beats ?? Math.max(1 / 64, gridUnit(state.snap))
    nudgeClips(ids, step)
  }, [])

  const handleAddTrack = useCallback(() => {
    const state = useStore.getState()
    const id = state.addTrack()
    if (id) pushToast('success', '已添加钢琴轨道：双击时间轴空白处创建片段')
  }, [pushToast])

  const handleRenameTrack = useCallback((trackId: string) => {
    useStore.getState().selectTrack(trackId)
    window.dispatchEvent(new CustomEvent('aiab:track-rename', { detail: { trackId } }))
  }, [])

  /* 命令总线：⌘K 命令面板 / 全局快捷键都从这里进来 */
  const actionsRef = useRef<{
    zoomIn: () => void
    zoomOut: () => void
    zoomFit: () => void
    duplicate: () => void
    split: () => void
    quantize: () => void
    remove: () => void
    selectAll: () => void
    copy: () => void
    paste: () => void
    transpose: (semitones: number) => void
    nudge: (beats?: number) => void
    addTrack: () => void
    renameTrack: (trackId: string) => void
  } | null>(null)
  actionsRef.current = {
    zoomIn,
    zoomOut,
    zoomFit,
    duplicate: handleDuplicate,
    split: handleSplit,
    quantize: handleQuantize,
    remove: handleDelete,
    selectAll: handleSelectAll,
    copy: handleCopy,
    paste: handlePaste,
    transpose: handleTranspose,
    nudge: handleNudge,
    addTrack: handleAddTrack,
    renameTrack: handleRenameTrack,
  }

  useEffect(() => {
    return subscribeEditorCommand((payload) => {
      const actions = actionsRef.current
      if (!actions) return
      switch (payload.action) {
        case 'zoom-in':
          runAction('zoom-in', actions.zoomIn)
          break
        case 'zoom-out':
          runAction('zoom-out', actions.zoomOut)
          break
        case 'zoom-fit':
          runAction('zoom-fit', actions.zoomFit)
          break
        case 'duplicate':
          runAction('duplicate', actions.duplicate)
          break
        case 'split':
          runAction('split', actions.split)
          break
        case 'quantize':
          runAction('quantize', actions.quantize)
          break
        case 'delete':
          runAction('delete', actions.remove)
          break
        case 'select-all':
          runAction('select-all', actions.selectAll)
          break
        case 'copy':
          runAction('copy', actions.copy)
          break
        case 'paste':
          runAction('paste', actions.paste)
          break
        case 'transpose':
          runAction('transpose', () => actions.transpose(payload.semitones ?? 1))
          break
        case 'nudge':
          runAction('nudge', () => actions.nudge(payload.beats))
          break
        case 'add-track':
          runAction('add-track', actions.addTrack)
          break
        case 'rename-track':
          if (payload.trackId) actions.renameTrack(payload.trackId)
          break
        default:
          break
      }
    })
  }, [runAction])

  /* 视图内键盘：多选复制/粘贴/微移/删除（与 commands.ts 的键位一致） */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
      const state = useStore.getState()
      if (state.settingsOpen || state.helpOpen || state.exportOpen) return
      const actions = actionsRef.current
      if (!actions) return
      const meta = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()
      if (event.key === 'Escape') {
        setSelectedIds([])
        setSelectedAudioIds([])
        setClipMenu(null)
        setEmptyMenu(null)
        setAudioMenu(null)
        return
      }
      if (meta && key === 'a') {
        event.preventDefault()
        runAction('select-all', actions.selectAll)
        return
      }
      if (meta && key === 'c') {
        event.preventDefault()
        runAction('copy', actions.copy)
        return
      }
      if (meta && key === 'v') {
        event.preventDefault()
        runAction('paste', actions.paste)
        return
      }
      /* ⌘D 复制、⌘E 拆分、⌘0/=/− 缩放、F 跟随等全局键由 Lead 统一绑定并派发 editorBus，这里不再重复监听 */
      if (event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        if (meta) return
        event.preventDefault()
        actions.transpose(event.key === 'ArrowUp' ? 1 : -1)
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        /* 音频片段优先：它用的是独立的选中集 */
        if (selectedAudioIdsRef.current.length > 0) {
          const count = deleteAudioClips(selectedAudioIdsRef.current)
          if (count > 0) useStore.getState().pushToast('info', count > 1 ? `已删除 ${count} 个音频片段` : '已删除音频片段')
          return
        }
        runAction('delete', actions.remove)
        return
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (meta) return
        event.preventDefault()
        const barBeatsNow = (() => {
          const ts = useStore.getState().project.timeSignature
          return (ts.numerator * 4) / ts.denominator
        })()
        const step = event.shiftKey ? barBeatsNow : Math.max(1 / 64, gridUnit(useStore.getState().snap))
        actions.nudge(event.key === 'ArrowLeft' ? -step : step)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [runAction, deleteAudioClips])

  /* ---------- 片段手势（整体移动 / Alt 复制 / 缩放 / 切片） ---------- */

  const beginClipGesture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, trackId: string, clipId: string, mode: ClipDragMode) => {
      if (event.button !== 0) return
      event.stopPropagation()
      event.preventDefault()
      const state = useStore.getState()
      const tool = useUiStore.getState().toolMode
      const additive = event.shiftKey

      let nextIds = selectedIdsRef.current
      if (additive) {
        nextIds = nextIds.includes(clipId) ? nextIds.filter((id) => id !== clipId) : [...nextIds, clipId]
      } else if (!nextIds.includes(clipId)) {
        nextIds = [clipId]
      }
      setSelectedIds(nextIds)
      if (nextIds.includes(clipId)) {
        lastStoreClipRef.current = clipId
        state.selectClip(trackId, clipId)
      }
      if (!nextIds.includes(clipId)) return

      /* 切片工具：点击即拆，不进入拖拽 */
      if (tool === 'split' && mode === 'move') {
        const clip = state.project.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId)
        if (!clip) return
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
        const localX = Math.max(0, Math.min(rect.width, event.clientX - rect.left))
        let beat = clip.startBeat + localX / Math.max(1, pxPerBeat)
        if (state.snap > 0) beat = snapBeat(beat, state.snap)
        const ok = splitClipAtPoint(trackId, clipId, tidy(beat))
        pushToast(ok ? 'info' : 'error', ok ? `已在 ${tidy(beat).toFixed(2)} 拍拆分「${clip.name}」` : '请在片段内部点击以拆分')
        return
      }

      const startX = event.clientX
      let dragIds = nextIds
      let items: ClipLocation[] = locateClips(nextIds, state.project)
      let firstItem = items.find((item) => item.clipId === clipId) ?? items[0]
      const altCopy = mode === 'move' && event.altKey
      let started = false
      let appliedDelta = 0
      let anchorDragId = clipId

      drag(event, {
        onMove: (moveEvent) => {
          const dx = moveEvent.clientX - startX
          if (!started) {
            if (Math.abs(dx) < 3) return
            started = true
            beginEdit()
            if (altCopy) {
              const { newIds, originalToNew } = duplicateClipsInPlace(dragIds)
              if (newIds.length > 0) {
                anchorDragId = originalToNew.get(clipId) ?? newIds[0]
                dragIds = newIds
                items = locateClips(newIds)
                firstItem = items.find((item) => item.clipId === anchorDragId) ?? items[0]
                setSelectedIds(newIds)
                if (firstItem) {
                  lastStoreClipRef.current = firstItem.clipId
                  useStore.getState().selectClip(firstItem.trackId, firstItem.clipId)
                }
              }
            }
          }

          if (mode === 'move') {
            if (items.length === 0) return
            const anchor = items.find((item) => item.clipId === anchorDragId) ?? items[0]
            if (!anchor) return
            const current = useStore.getState()
            const rawDelta = dx / Math.max(1, pxPerBeat)
            let delta = rawDelta
            if (current.snap > 0) {
              const targetStart = snapBeat(anchor.startBeat + rawDelta, current.snap)
              delta = targetStart - anchor.startBeat
            }
            const minStart = Math.min(...items.map((item) => item.startBeat))
            if (delta < -minStart) delta = -minStart
            delta = tidy(delta)
            if (delta !== appliedDelta) {
              moveClipsBy(dragIds, delta - appliedDelta)
              appliedDelta = delta
            }
            const position = Math.max(0, anchor.startBeat + appliedDelta)
            showTooltip(moveEvent.clientX, moveEvent.clientY, `移动至 ${formatDragPosition(position, current.project.timeSignature)}`)
            return
          }

          /* 单片段左右缩放 */
          const clip = state.project.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId)
          if (!clip) return
          const current = useStore.getState()
          const rawDelta = dx / Math.max(1, pxPerBeat)
          const unit = Math.max(1 / 64, gridUnit(current.snap))
          if (mode === 'right') {
            const length = tidy(Math.max(unit, snapBeat(clip.lengthBeats + rawDelta, current.snap)))
            current.updateClip(trackId, clipId, { lengthBeats: length }, { history: false })
            showTooltip(moveEvent.clientX, moveEvent.clientY, `长度 ${length.toFixed(2)} 拍`)
          } else {
            const maxStart = clip.startBeat + clip.lengthBeats - unit
            const start = tidy(clamp(snapBeat(clip.startBeat + rawDelta, current.snap), 0, maxStart))
            const length = tidy(Math.max(unit, clip.lengthBeats + (clip.startBeat - start)))
            current.updateClip(trackId, clipId, { startBeat: start, lengthBeats: length }, { history: false })
            showTooltip(moveEvent.clientX, moveEvent.clientY, `起点 ${start.toFixed(2)} 拍 · 长度 ${length.toFixed(2)} 拍`)
          }
        },
        onUp: () => {
          hideTooltip()
          if (started) useStore.getState().setSaveStatus('dirty')
        },
      })
    },
    [drag, pushToast, pxPerBeat],
  )

  /* ---------- 空白处：框选 / 单击定位播放头 ---------- */

  const onRowsPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('[data-clip]') || target.closest('[data-audio-clip]')) return
    if (target.closest('button, select, input, textarea, a')) return
    const content = contentRef.current
    if (!content) return
    const rect = content.getBoundingClientRect()
    const startX = event.clientX - rect.left
    const startY = event.clientY - rect.top
    let moved = false

    drag(event, {
      onMove: (moveEvent) => {
        const x = moveEvent.clientX - rect.left
        const y = moveEvent.clientY - rect.top
        if (!moved && Math.hypot(x - startX, y - startY) > 4) moved = true
        if (moved) setMarquee({ x1: startX, y1: startY, x2: x, y2: y })
      },
      onUp: (upEvent) => {
        setMarquee(null)
        const state = useStore.getState()
        const currentRect = content.getBoundingClientRect()
        const x2 = upEvent.clientX - currentRect.left
        const y2 = upEvent.clientY - currentRect.top
        const currentPx = arrangementPxPerBeat(state.zoomX)

        if (!moved) {
          /* 单击时间轴空白 = 定位播放头；同时选中该行轨道 */
          const beat = Math.max(0, x2 / Math.max(1, currentPx))
          state.setPlayhead(beat)
          if (state.isPlaying) {
            try {
              getAudioEngine().seek(beat)
            } catch {
              /* ignore */
            }
          }
          const rowIndex = rowIndexAtY(y2)
          const track = rowIndex >= 0 ? state.project.tracks[rowIndex] : undefined
          if (track) {
            state.selectTrack(track.id)
            lastStoreClipRef.current = track.clips[0]?.id ?? null
          }
          setSelectedIds([])
          setSelectedAudioIds([])
          return
        }

        const heights = heightsNow()
        const left = Math.min(startX, x2)
        const right = Math.max(startX, x2)
        const top = Math.min(startY, y2)
        const bottom = Math.max(startY, y2)
        const hits: string[] = []
        const audioHits: string[] = []
        let rowTop = RULER_HEIGHT
        state.project.tracks.forEach((track, index) => {
          const rowBottom = rowTop + (heights[index] ?? 0)
          if (rowBottom >= top && rowTop <= bottom) {
            for (const clip of track.clips) {
              const clipLeft = clip.startBeat * currentPx
              const clipRight = clipLeft + clip.lengthBeats * currentPx
              if (clipRight >= left && clipLeft <= right) hits.push(clip.id)
            }
            /* 音频片段也参与框选（复用同一套坐标换算） */
            for (const clip of track.audioClips ?? []) {
              const clipLeft = clip.startBeat * currentPx
              const clipRight = clipLeft + clip.lengthBeats * currentPx
              if (clipRight >= left && clipLeft <= right) audioHits.push(clip.id)
            }
          }
          rowTop = rowBottom
        })

        const additive = upEvent.shiftKey
        const base = additive ? selectedIdsRef.current : []
        const merged = additive ? [...base.filter((id) => !hits.includes(id)), ...hits] : hits
        setSelectedIds(merged)
        setSelectedAudioIds(additive ? [...selectedAudioIdsRef.current, ...audioHits] : audioHits)
        const first = locateClips(hits, state.project)[0]
        if (first) {
          lastStoreClipRef.current = first.clipId
          state.selectClip(first.trackId, first.clipId)
        }
        if (hits.length === 0 && !additive) setSelectedIds([])
      },
    })
  }

  /* 空白处双击新建片段 */
  const onRowsDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-clip]') || target.closest('[data-audio-clip]')) return
    if (target.closest('button, select, input, textarea, a')) return
    const rowElement = target.closest('[data-track-row]') as HTMLElement | null
    if (!rowElement) return
    const index = Number(rowElement.dataset.trackIndex)
    const track = project.tracks[index]
    if (!track) return
    /* 音频轨只放音频片段：不在这里新建 MIDI 片段，避免出现「空片段 + 无音色」 */
    if (track.kind === 'audio') {
      pushToast('info', '音频轨道：用「文件 → 导入音频…」或「AI 生成音频」添加音频片段')
      return
    }
    const rect = rowElement.getBoundingClientRect()
    const rawBeat = Math.max(0, (event.clientX - rect.left) / pxPerBeat)
    const startBeat = tidy(Math.floor(rawBeat / barBeats) * barBeats)
    const id = addClip(track.id, {
      name: `${track.name} ${track.clips.length + 1}`,
      startBeat,
      lengthBeats: barBeats * 2,
    })
    if (id) {
      setSelectedIds([id])
      lastStoreClipRef.current = id
      pushToast('info', '已创建 2 小节片段，双击片段可进入钢琴卷帘')
    }
  }

  /* 空白处右键菜单 */
  const onRowsContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-clip]') || target.closest('[data-audio-clip]')) return
    if (target.closest('button, select, input, textarea, a')) return
    event.preventDefault()
    const content = contentRef.current
    if (!content) return
    const rect = content.getBoundingClientRect()
    const beat = Math.max(0, (event.clientX - rect.left) / Math.max(1, pxPerBeat))
    const snapped = useStore.getState().snap > 0 ? snapBeat(beat, useStore.getState().snap) : beat
    setClipMenu(null)
    setEmptyMenu({ x: event.clientX, y: event.clientY, beat: tidy(snapped) })
  }

  const openClipMenu = (event: React.MouseEvent<HTMLDivElement>, trackId: string, clipId: string) => {
    const state = useStore.getState()
    let ids = selectedIdsRef.current
    if (!ids.includes(clipId)) {
      ids = [clipId]
      setSelectedIds(ids)
      lastStoreClipRef.current = clipId
      state.selectClip(trackId, clipId)
    }
    setEmptyMenu(null)
    setClipMenu({ x: event.clientX, y: event.clientY, trackId, clipId })
  }

  /* Esc 关闭菜单（菜单组件自己处理 Esc；这里兜底关闭空态菜单） */
  useEffect(() => {
    if (!clipMenu && !emptyMenu) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setClipMenu(null)
      setEmptyMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clipMenu, emptyMenu])

  /* ---------- 派生数据 ---------- */

  const playheadHeight = Math.max(contentHeight, RULER_HEIGHT + rowsHeight)
  const gridStyle: CSSProperties = {
    backgroundImage: [
      ...(pxPerBeat >= 12
        ? [
            `repeating-linear-gradient(90deg, rgba(255,255,255,0.045) 0px, rgba(255,255,255,0.045) 1px, transparent 1px, transparent ${pxPerBeat}px)`,
          ]
        : []),
      `repeating-linear-gradient(90deg, rgba(255,255,255,0.1) 0px, rgba(255,255,255,0.1) 1px, transparent 1px, transparent ${barBeats * pxPerBeat}px)`,
    ].join(','),
  }

  const menuClip = clipMenu
    ? project.tracks.find((track) => track.id === clipMenu.trackId)?.clips.find((clip) => clip.id === clipMenu.clipId)
    : null
  const menuTrack = clipMenu ? project.tracks.find((track) => track.id === clipMenu.trackId) : null
  const menuSelectedCount = menuClip && selectedIdsRef.current.includes(menuClip.id) ? selectedIdsRef.current.length : 1
  const menuAudioClip = audioMenu
    ? project.tracks
        .find((track) => track.id === audioMenu.trackId)
        ?.audioClips.find((clip) => clip.id === audioMenu.clipId)
    : null
  const menuAudioTrack = audioMenu ? project.tracks.find((track) => track.id === audioMenu.trackId) : null
  const takeMenuClip = takeMenu
    ? project.tracks
        .find((track) => track.id === takeMenu.trackId)
        ?.audioClips.find((clip) => clip.id === takeMenu.clipId)
    : null

  /**
   * 切换音频版本（take）：先按**目标 assetId** 取 peaks（缓存按 assetId，不复用旧波形），
   * 再在一次 mutate 里切 activeTakeId / assetId / durationSec；⌘Z 可整批回退。
   */
  const switchAudioTake = useCallback(
    async (trackId: string, clipId: string, takeId: string) => {
      const store = useStore.getState()
      const clip = store.project.tracks.find((track) => track.id === trackId)?.audioClips.find((item) => item.id === clipId)
      const take = clip?.takes.find((item) => item.id === takeId)
      if (!clip || !take) {
        store.pushToast('error', '版本不存在（片段或 take 已被删除）')
        return
      }
      let durationSec = 0
      try {
        const peaks = await getAssetPeaks(take.assetId)
        primeAssetPeaks(take.assetId, peaks)
        durationSec = peaks.durationSec
      } catch (error) {
        console.warn('[arrangement] 切换版本时取波形失败（仍会切换，波形稍后重试）', error)
      }
      let switched = false
      store.mutate((draft) => {
        switched = switchActiveTake(draft, trackId, clipId, takeId, durationSec || undefined)
      })
      if (switched) {
        store.pushToast('success', `已切换到版本「${take.label || take.id}」（⌘Z 可撤销）`)
      } else {
        store.pushToast('error', '切换版本失败：片段或版本已不存在')
      }
    },
    [],
  )

  const openClipInPianoRoll = (trackId: string, clipId: string) => {
    const store = useStore.getState()
    lastStoreClipRef.current = clipId
    store.selectClip(trackId, clipId)
    setSelectedIds([clipId])
    store.setView('pianoroll')
  }

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden bg-bg-soft"
      data-arrangement-view
      data-tool-mode={toolMode}
      data-selected-count={selectedIds.length}
    >
      <TimelineToolbar
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onZoomFit={zoomFit}
        onOpenAddTrack={openAddTrack}
        selectedCount={selectedIds.length}
        totalClips={totalClips}
      />

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          aria-label="编曲时间轴"
          className={cn('h-full overflow-auto', toolMode === 'split' ? 'cursor-crosshair' : '')}
          style={{ overscrollBehavior: 'contain' }}
          onScroll={handleScroll}
        >
          <div ref={contentRef} className="relative" style={{ width: contentWidth, minHeight: '100%' }}>
            {/* 网格 */}
            <div className="pointer-events-none absolute inset-0" style={gridStyle} />

            {/* 标尺 */}
            <Ruler
              pxPerBeat={pxPerBeat}
              barBeats={barBeats}
              totalBeats={totalBeats}
              sections={project.sections}
              chords={chords}
              loop={project.loop}
            />

            {/* 轨道行 */}
            <div onPointerDown={onRowsPointerDown} onDoubleClick={onRowsDoubleClick} onContextMenu={onRowsContextMenu}>
              {project.tracks.length === 0 && (
                <div className="flex h-[260px] flex-col items-center justify-center gap-3 px-6 text-center">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-line-strong bg-surface-2 text-ink-3">
                    <Boxes size={18} />
                  </div>
                  <div className="text-[13px] font-medium text-ink-2">工程里还没有轨道</div>
                  <div className="max-w-sm text-[11.5px] leading-relaxed text-ink-3">
                    添加一条乐器轨道后，在时间轴双击空白处创建片段；也可以让右侧 AI 帮你搭一版编曲。
                  </div>
                  <button
                    className="btn btn-accent mt-1 h-8 px-3 text-[12px]"
                    onClick={(event) => openAddTrack(event.currentTarget.getBoundingClientRect())}
                  >
                    <Plus size={13} />
                    <span className="text-[12px]">添加第一条轨道</span>
                  </button>
                </div>
              )}
              {project.tracks.map((track, index) => {
                const color = trackColor(track.color)
                const rowHeight = rowHeights[index] ?? fallbackRowHeight
                return (
                  <div
                    key={track.id}
                    data-track-row
                    data-track-index={index}
                    data-track-id={track.id}
                    className={cn(
                      'relative border-b border-line/60 transition-colors',
                      track.id === selectedTrackId ? 'bg-white/[0.022]' : index % 2 === 1 ? 'bg-white/[0.008]' : '',
                      toolMode === 'split' && 'hover:bg-accent/[0.035]',
                    )}
                    style={{ height: rowHeight }}
                  >
                    {track.clips.length === 0 && (track.audioClips?.length ?? 0) === 0 && (
                      <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center gap-1.5 text-[10px] text-ink-4/70">
                        <span className="h-[3px] w-[3px] rounded-full" style={{ background: withAlpha(color, 0.5) }} />
                        {track.kind === 'audio'
                          ? '音频轨道：用「文件 → 导入音频…」放置音频'
                          : '双击空白处新建片段'}
                      </div>
                    )}
                    {track.clips.map((clip) => (
                      <ClipView
                        key={clip.id}
                        clip={clip}
                        track={track}
                        pxPerBeat={pxPerBeat}
                        barBeats={barBeats}
                        rowHeight={rowHeight}
                        selected={selectedIds.includes(clip.id)}
                        toolMode={toolMode}
                        onPointerDown={(event, mode) => beginClipGesture(event, track.id, clip.id, mode)}
                        onDoubleClick={() => openClipInPianoRoll(track.id, clip.id)}
                        onContextMenu={(event) => openClipMenu(event, track.id, clip.id)}
                      />
                    ))}
                    {/* 音频片段：与 MIDI 片段平行，画波形（peaks 缓存 + SVG，不占主线程） */}
                    {(track.audioClips ?? []).map((clip) => (
                      <AudioClipView
                        key={clip.id}
                        clip={clip}
                        track={track}
                        pxPerBeat={pxPerBeat}
                        rowHeight={rowHeight}
                        selected={selectedAudioIds.includes(clip.id)}
                        onSelect={(event) => selectAudioClip(track.id, clip.id, event.shiftKey)}
                        onContextMenu={(event) => {
                          selectAudioClip(track.id, clip.id, event.shiftKey)
                          setAudioMenu({ x: event.clientX, y: event.clientY, trackId: track.id, clipId: clip.id })
                        }}
                        onDoubleClick={() => {
                          /* 双击音频片段 = 把播放头定位到片段起点（不进入钢琴卷帘） */
                          const store = useStore.getState()
                          store.setPlayhead(clip.startBeat)
                          if (store.isPlaying) {
                            try {
                              getAudioEngine().seek(clip.startBeat)
                            } catch {
                              /* ignore */
                            }
                          }
                        }}
                      />
                    ))}
                  </div>
                )
              })}
              <div style={{ height: BOTTOM_SPACER }} />
            </div>

            {/* 播放头 */}
            <Playhead pxPerBeat={pxPerBeat} height={playheadHeight} scrollRef={scrollRef} />

            {/* 框选 */}
            {marquee && (
              <div
                className="pointer-events-none absolute z-30 rounded-[2px] border border-accent/70 bg-accent/10"
                style={{
                  left: Math.min(marquee.x1, marquee.x2),
                  top: Math.min(marquee.y1, marquee.y2),
                  width: Math.abs(marquee.x2 - marquee.x1),
                  height: Math.abs(marquee.y2 - marquee.y1),
                }}
              />
            )}
          </div>
        </div>

        {/* 拖动位置 tooltip（命令式更新，避免每帧重渲染） */}
        <div
          ref={tooltipRef}
          data-drag-tooltip
          className="pointer-events-none fixed z-[70] hidden -translate-y-full rounded-md border border-accent/40 bg-surface/95 px-2 py-1 text-[10px] font-medium text-accent-soft shadow-lg backdrop-blur"
          aria-hidden
        />
      </div>

      {/* 添加轨道：乐器选择 */}
      {addTrackAnchor && (
        <InstrumentPicker
          style={popoverPosition(addTrackAnchor, 300, 400)}
          onClose={() => setAddTrackAnchor(null)}
          onPick={(instrumentId) => {
            addTrack({ instrumentId })
            setAddTrackAnchor(null)
            pushToast('success', '已添加轨道')
          }}
        />
      )}

      {/* 片段右键菜单 */}
      {clipMenu && menuClip && (
        <ContextMenu
          x={clipMenu.x}
          y={clipMenu.y}
          onClose={() => setClipMenu(null)}
          label={`${menuClip.name} · ${menuTrack?.name ?? ''}${menuSelectedCount > 1 ? ` · 已选 ${menuSelectedCount} 个片段` : ''}`}
        >
          <MenuItem icon={<Piano size={12} />} label="在钢琴卷帘中编辑" shortcut="双击" onClick={() => { openClipInPianoRoll(clipMenu.trackId, clipMenu.clipId); setClipMenu(null) }} />
          <MenuItem
            icon={<Play size={12} />}
            label="试听片段"
            onClick={() => {
              if (menuTrack) {
                try {
                  getAudioEngine().previewClip(menuTrack, menuClip)
                } catch (error) {
                  console.warn('[arrangement] 试听失败', error)
                }
              }
              setClipMenu(null)
            }}
          />
          <MenuDivider />
          <MenuItem icon={<Copy size={12} />} label={`复制片段${menuSelectedCount > 1 ? `（${menuSelectedCount} 个）` : ''}`} shortcut={`${modSymbol()}D`} onClick={() => { runAction('duplicate', handleDuplicate); setClipMenu(null) }} />
          <MenuItem icon={<ClipboardPaste size={12} />} label="复制到剪贴板" shortcut={`${modSymbol()}C`} onClick={() => { runAction('copy', handleCopy); setClipMenu(null) }} />
          <MenuItem icon={<Scissors size={12} />} label="在播放头处拆分" shortcut={`${modSymbol()}E`} onClick={() => { runAction('split', handleSplit); setClipMenu(null) }} />
          <MenuItem icon={<Grid3x3 size={12} />} label="量化到吸附网格" shortcut="Q" onClick={() => { runAction('quantize', handleQuantize); setClipMenu(null) }} />
          {menuClip.smart && (
            <MenuItem
              icon={<Sparkles size={12} />}
              label="智能片段参数"
              onClick={() => {
                const store = useStore.getState()
                store.selectClip(clipMenu.trackId, clipMenu.clipId)
                store.setSmartClipTarget({ trackId: clipMenu.trackId, clipId: clipMenu.clipId })
                store.setView('smartclips')
                setClipMenu(null)
              }}
            />
          )}
          <MenuDivider />
          <MenuItem icon={<Trash2 size={12} />} label="删除片段" shortcut="Del" danger onClick={() => { runAction('delete', handleDelete); setClipMenu(null) }} />
        </ContextMenu>
      )}

      {/* 音频片段右键菜单（一期：定位 / 选中 / 删除；变速与裁切未启用） */}
      {audioMenu && menuAudioClip && (
        <ContextMenu
          x={audioMenu.x}
          y={audioMenu.y}
          onClose={() => setAudioMenu(null)}
          label={`${menuAudioClip.name} · ${menuAudioTrack?.name ?? ''} · ${menuAudioClip.durationSec.toFixed(1)}s`}
        >
          <MenuItem
            icon={<Play size={12} />}
            label="从片段开头播放定位"
            onClick={() => {
              const store = useStore.getState()
              store.setPlayhead(menuAudioClip.startBeat)
              if (store.isPlaying) {
                try {
                  getAudioEngine().seek(menuAudioClip.startBeat)
                } catch {
                  /* ignore */
                }
              }
              setAudioMenu(null)
            }}
          />
          <MenuItem
            icon={<Waves size={12} />}
            label="选中此片段"
            onClick={() => {
              selectAudioClip(audioMenu.trackId, audioMenu.clipId)
              setAudioMenu(null)
            }}
          />
          <MenuDivider />
          {/* P2-B：局部重绘（整段替换当前版本，原版本自动保留为 take） */}
          <MenuItem
            icon={<Wand2 size={12} />}
            label="局部重绘…"
            dataAttr={{ 'data-repaint-trigger': '' }}
            onClick={() => {
              setRepaintTarget({ trackId: audioMenu.trackId, clipId: audioMenu.clipId })
              setAudioMenu(null)
            }}
          />
          {/* P5-B：按原曲上下文生成分轨 stem（独立轨道，非分离音轨） */}
          <MenuItem
            icon={<Waves size={12} />}
            label="生成分轨 Stem…"
            dataAttr={{ 'data-stem-trigger': '' }}
            onClick={() => {
              setStemTarget({ trackId: audioMenu.trackId, clipId: audioMenu.clipId })
              setAudioMenu(null)
            }}
          />
          {(menuAudioClip.takes?.length ?? 0) > 0 && (
            <MenuItem
              icon={<Layers size={12} />}
              label={`切换版本（${menuAudioClip.takes.length}）`}
              hint={
                menuAudioClip.takes.find((take) => take.id === menuAudioClip.activeTakeId)?.label ||
                (menuAudioClip.activeTakeId ? '当前版本' : '')
              }
              submenu
              onClick={() => {
                setTakeMenu({
                  x: audioMenu.x,
                  y: audioMenu.y,
                  trackId: audioMenu.trackId,
                  clipId: audioMenu.clipId,
                })
                setAudioMenu(null)
              }}
            />
          )}
          <MenuDivider />
          <MenuItem
            icon={<Trash2 size={12} />}
            label="删除音频片段"
            shortcut="Del"
            danger
            onClick={() => {
              const count = deleteAudioClips([audioMenu.clipId])
              if (count > 0) pushToast('info', '已删除音频片段')
              setAudioMenu(null)
            }}
          />
        </ContextMenu>
      )}

      {/* 音频片段「切换版本（takes）」弹层：每个版本带 data-take-switch / data-take-id */}
      {takeMenu && takeMenuClip && takeMenuClip.takes.length > 0 && (
        <ContextMenu
          x={takeMenu.x}
          y={takeMenu.y}
          onClose={() => setTakeMenu(null)}
          width={248}
          label={`切换版本 · ${takeMenuClip.name}（当前：${
            takeMenuClip.takes.find((take) => take.id === takeMenuClip.activeTakeId)?.label ?? '原版本'
          }）`}
        >
          {takeMenuClip.takes.map((take) => {
            const active = take.id === takeMenuClip.activeTakeId
            return (
              <MenuItem
                key={take.id}
                checked={active}
                icon={<Layers size={12} />}
                label={`${take.label || '版本'} · ${formatRelativeTime(take.createdAt)}`}
                hint={active ? '当前' : undefined}
                dataAttr={{ 'data-take-switch': '', 'data-take-id': take.id }}
                onClick={() => {
                  setTakeMenu(null)
                  void switchAudioTake(takeMenu.trackId, takeMenu.clipId, take.id)
                }}
              />
            )
          })}
        </ContextMenu>
      )}

      {/* 局部重绘对话框（portal 模态；轮询只活在对话框生命周期内） */}
      {repaintTarget && (
        <RepaintAudioDialog
          trackId={repaintTarget.trackId}
          clipId={repaintTarget.clipId}
          onClose={() => setRepaintTarget(null)}
        />
      )}

      {/* P5-B：生成分轨 Stem 对话框（多 arm 任务 + 自动新建独立音频轨） */}
      {stemTarget && (
        <StemGenerateDialog
          trackId={stemTarget.trackId}
          clipId={stemTarget.clipId}
          onClose={() => setStemTarget(null)}
        />
      )}

      {/* 空白处右键菜单 */}
      {emptyMenu && (
        <ContextMenu x={emptyMenu.x} y={emptyMenu.y} onClose={() => setEmptyMenu(null)} label="时间轴">
          <MenuItem
            icon={<Play size={12} />}
            label="从此处开始播放定位"
            onClick={() => {
              const store = useStore.getState()
              store.setPlayhead(emptyMenu.beat)
              if (store.isPlaying) {
                try {
                  getAudioEngine().seek(emptyMenu.beat)
                } catch {
                  /* ignore */
                }
              }
              setEmptyMenu(null)
            }}
          />
          <MenuItem icon={<ClipboardPaste size={12} />} label="粘贴到此处" shortcut={`${modSymbol()}V`} onClick={() => { handlePasteAt(emptyMenu.beat); setEmptyMenu(null) }} />
          <MenuItem icon={<Boxes size={12} />} label="全选片段" shortcut={`${modSymbol()}A`} onClick={() => { runAction('select-all', handleSelectAll); setEmptyMenu(null) }} />
          <MenuDivider />
          <MenuLabel>轨道</MenuLabel>
          <MenuItem icon={<Plus size={12} />} label="添加轨道" shortcut={`${modSymbol()}⇧N`} onClick={() => { handleAddTrack(); setEmptyMenu(null) }} />
        </ContextMenu>
      )}
    </div>
  )
}
