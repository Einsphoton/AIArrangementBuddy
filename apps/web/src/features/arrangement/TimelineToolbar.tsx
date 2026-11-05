/**
 * 编曲时间轴工具条（对标 Live / Logic / Cubase 的 timeline toolbar）。
 *
 * 只放高频操作：工具模式、吸附与网格细度、缩放、跟随、添加轨道、选区状态。
 * 高度固定 38px，左侧 TrackPanel 有一块同高的工具条，保证两边的行在纵向上严格对齐。
 *
 * 窄屏策略（AI 面板打开时编辑区可能只有 ~560px）：
 * - 用 ResizeObserver 量自己的实际宽度，而不是视口宽度（AI 面板宽可拖拽）；
 * - ≥700px：完整显示；
 * - 560–699px：隐藏操作提示文案、工具文字（保留 tooltip），保留「已选 N」与「+ 轨道」；
 * - <560px：再隐藏缩放百分比；
 * - 最右侧「选区 + 添加轨道」永远不收缩，保证不被裁掉。
 */
import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  LocateFixed,
  Magnet,
  Maximize2,
  Minus,
  MousePointer2,
  Plus,
  Scissors,
} from 'lucide-react'
import { cn } from '../../lib/format'
import { modSymbol } from '../../lib/shortcuts'
import { useStore } from '../../store/store'
import { useUiStore, type EditorTool } from '../../lib/uiStore'
import { SNAP_OPTIONS, snapFullLabel, snapShortLabel } from './timeline'

function ToolButton({
  title,
  active,
  disabled,
  onClick,
  children,
  className,
}: {
  title: string
  active?: boolean
  disabled?: boolean
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  children: React.ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border transition-colors',
        active
          ? 'border-accent/60 bg-accent/15 text-accent-soft'
          : 'border-transparent text-ink-3 hover:border-line-strong hover:bg-surface-3 hover:text-ink',
        disabled && 'cursor-not-allowed opacity-40 hover:border-transparent hover:bg-transparent hover:text-ink-3',
        className,
      )}
    >
      {children}
    </button>
  )
}

function Divider() {
  return <span className="mx-0.5 h-4 w-px shrink-0 bg-line" aria-hidden />
}

const TOOL_BUTTONS: { value: EditorTool; label: string; title: string; icon: React.ReactNode }[] = [
  {
    value: 'select',
    label: '选择',
    title: '选择工具：拖动片段、框选多个（默认工具）',
    icon: <MousePointer2 size={13} />,
  },
  {
    value: 'split',
    label: '切片',
    title: '切片工具：点击片段在点击位置拆分，移动鼠标可预览刀线',
    icon: <Scissors size={13} />,
  },
]

export function TimelineToolbar({
  onZoomIn,
  onZoomOut,
  onZoomFit,
  onOpenAddTrack,
  selectedCount,
  totalClips,
}: {
  onZoomIn: () => void
  onZoomOut: () => void
  onZoomFit: () => void
  onOpenAddTrack: (rect: DOMRect) => void
  selectedCount: number
  totalClips: number
}) {
  const snap = useStore((s) => s.snap)
  const setSnap = useStore((s) => s.setSnap)
  const zoomX = useStore((s) => s.zoomX)
  const toolMode = useUiStore((s) => s.toolMode)
  const setToolMode = useUiStore((s) => s.setToolMode)
  const followPlayhead = useUiStore((s) => s.followPlayhead)
  const toggleFollowPlayhead = useUiStore((s) => s.toggleFollowPlayhead)
  const lastSnapRef = useRef(snap > 0 ? snap : 0.25)
  const rootRef = useRef<HTMLDivElement>(null)
  const [barWidth, setBarWidth] = useState(0)

  useEffect(() => {
    if (snap > 0) lastSnapRef.current = snap
  }, [snap])

  /* 工具条宽度会随 AI 面板拖动变化，用自身的宽度决定紧凑程度，而不是 window 宽度 */
  useEffect(() => {
    const element = rootRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setBarWidth(element.clientWidth))
    observer.observe(element)
    setBarWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])

  const compact = barWidth > 0 && barWidth < 700
  const tight = barWidth > 0 && barWidth < 560

  /* 完整提示文案；窄宽度下只保留「已选 N 个片段」（提示收进 tooltip） */
  const fullHint =
    toolMode === 'split'
      ? '切片工具 · 点击片段在点击位置拆分'
      : selectedCount > 0
        ? `已选 ${selectedCount} 个片段`
        : totalClips === 0
          ? '双击空白处新建片段'
          : '空白处框选 · ⇧ 加选'
  const selectionText = selectedCount > 0 ? `已选 ${selectedCount} 个片段` : compact ? '' : fullHint

  return (
    <div
      ref={rootRef}
      data-timeline-toolbar
      data-tool-mode={toolMode}
      data-follow-playhead={followPlayhead ? 'true' : 'false'}
      data-snap={String(snap)}
      data-selected-count={selectedCount}
      data-compact={compact ? 'true' : 'false'}
      className="relative z-30 flex h-[38px] shrink-0 items-center gap-1 overflow-hidden border-b border-line bg-surface px-2"
      role="toolbar"
      aria-label="编曲时间轴工具条"
      title={fullHint}
    >
      {/* 左侧高频控件：窄宽度时隐藏次要文案，右侧「已选 + 轨道」永远完整 */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {/* 工具模式 */}
        <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-line bg-bg-soft/80 p-0.5" role="group" aria-label="编辑工具">
          {TOOL_BUTTONS.map((tool) => (
            <button
              key={tool.value}
              type="button"
              data-tool={tool.value}
              title={tool.title}
              aria-label={tool.label}
              aria-pressed={toolMode === tool.value}
              onClick={() => setToolMode(tool.value)}
              className={cn(
                'flex h-[23px] shrink-0 items-center gap-1 rounded-[6px] px-1.5 text-[10.5px] font-medium transition-colors',
                toolMode === tool.value ? 'bg-surface-3 text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2',
              )}
            >
              {tool.icon}
              {!compact && <span className="hidden text-[10.5px] sm:inline">{tool.label}</span>}
            </button>
          ))}
        </div>

        <Divider />

        {/* 吸附开关 + 网格细度 */}
        <ToolButton
          title={snap > 0 ? `吸附已开启（${snapShortLabel(snap)}），点击临时关闭` : '吸附已关闭，点击恢复'}
          active={snap > 0}
          onClick={() => setSnap(snap > 0 ? 0 : lastSnapRef.current)}
        >
          <Magnet size={13} />
        </ToolButton>
        <div className="relative shrink-0">
          <select
            aria-label="网格细度"
            title={`网格细度（吸附单位）：${snapFullLabel(snap)}`}
            value={String(snap)}
            onChange={(event) => {
              const next = Number(event.target.value)
              if (Number.isFinite(next)) setSnap(next)
            }}
            className="mono h-[26px] w-[66px] shrink-0 cursor-pointer appearance-none rounded-md border border-line-strong bg-surface-2 pl-1.5 pr-5 text-center text-[10.5px] text-ink-2 outline-none transition-colors hover:border-line-strong hover:text-ink"
          >
            {SNAP_OPTIONS.map((option) => (
              <option key={option.value} value={String(option.value)} title={option.label}>
                {option.short}
              </option>
            ))}
          </select>
          <ChevronDown size={10} className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-4" />
        </div>

        <Divider />

        {/* 缩放 */}
        <ToolButton title={`缩小时间轴（${modSymbol()}−）`} onClick={onZoomOut}>
          <Minus size={13} />
        </ToolButton>
        {!tight && (
          <span
            className="mono hidden w-[54px] shrink-0 text-center text-[10px] tabular-nums text-ink-3 sm:block"
            title="横向缩放：⌘/Ctrl + 滚轮横向缩放，Shift + 滚轮纵向缩放"
          >
            {Math.round((zoomX / 64) * 100)}%
          </span>
        )}
        <ToolButton title={`放大时间轴（${modSymbol()}=）`} onClick={onZoomIn}>
          <Plus size={13} />
        </ToolButton>
        <ToolButton title={`缩放至适合窗口（${modSymbol()}0）`} onClick={onZoomFit}>
          <Maximize2 size={13} />
        </ToolButton>

        <Divider />

        {/* 跟随播放头 */}
        <button
          type="button"
          title={`播放时跟随播放头（F）：${followPlayhead ? '开' : '关'}`}
          aria-label="跟随播放头"
          aria-pressed={followPlayhead}
          onClick={toggleFollowPlayhead}
          className={cn(
            'flex h-[26px] shrink-0 items-center gap-1 rounded-md border px-1.5 text-[10.5px] font-medium transition-colors',
            followPlayhead
              ? 'border-accent/55 bg-accent/12 text-accent-soft'
              : 'border-transparent text-ink-3 hover:border-line-strong hover:bg-surface-3 hover:text-ink',
          )}
        >
          <LocateFixed size={12} />
          {!compact && <span className="hidden text-[10.5px] lg:inline">跟随</span>}
        </button>
      </div>

      {/* 右侧：选区状态 + 添加轨道。shrink-0，任何宽度下都不被裁 */}
      <div
        className="flex shrink-0 items-center gap-2 pl-2"
        title={selectionText ? `${selectionText} · ${fullHint}` : fullHint}
      >
        {selectionText && (
          <span
            data-selection-hint
            aria-label={`选区状态：${selectionText}`}
            className="hidden max-w-[92px] shrink-0 truncate text-[10px] text-ink-4 sm:block"
          >
            {selectionText}
          </span>
        )}
        <button
          type="button"
          title={`添加轨道（${modSymbol()}⇧N）：选择乐器后加入编曲`}
          aria-label="添加轨道"
          onClick={(event) => onOpenAddTrack(event.currentTarget.getBoundingClientRect())}
          className="btn btn-accent h-[26px] shrink-0 gap-1 px-2 text-[11px]"
        >
          <Plus size={12} />
          <span className="text-[11px]">轨道</span>
        </button>
      </div>
    </div>
  )
}
