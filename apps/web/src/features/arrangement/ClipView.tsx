/**
 * 编曲车道里的单个片段。
 *
 * 交互都通过父级回调完成（多选整体移动 / Alt 复制 / 切片都在 ArrangementView 统一处理），
 * 这里只负责渲染、hover/选中态、canvas 缩略图与切片刀线预览。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { EyeOff, Scissors } from 'lucide-react'
import { getInstrument, SMART_KIND_META, type Clip, type Track } from '@aiab/core'
import { cn } from '../../lib/format'
import type { EditorTool } from '../../lib/uiStore'
import { drawNotesThumbnail, trackColor, withAlpha } from './timeline'

export type ClipDragMode = 'move' | 'left' | 'right'

export function ClipView({
  clip,
  track,
  pxPerBeat,
  barBeats,
  rowHeight,
  selected,
  toolMode,
  onPointerDown,
  onDoubleClick,
  onContextMenu,
  onSplitHover,
}: {
  clip: Clip
  track: Track
  pxPerBeat: number
  barBeats: number
  rowHeight: number
  selected: boolean
  toolMode: EditorTool
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>, mode: ClipDragMode) => void
  onDoubleClick: () => void
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void
  /** 刀线预览移动时上报（用于顶部状态提示，可为空） */
  onSplitHover?: (beat: number | null) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [bladeX, setBladeX] = useState<number | null>(null)
  const color = trackColor(track.color)
  const instrument = getInstrument(track.instrumentId)
  const splitMode = toolMode === 'split'

  /* 内容哈希：拖拽/缩放片段时 notes 数组引用会变，但内容没变，避免重复重绘 canvas */
  const notesHash = useMemo(() => {
    let hash = Math.round(clip.lengthBeats * 1000) + clip.notes.length * 7
    for (const note of clip.notes) {
      hash += note.pitch * 31 + note.start * 7.13 + note.duration * 3.7 + note.velocity * 0.5
    }
    return hash
  }, [clip.notes, clip.lengthBeats])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    drawNotesThumbnail(canvas, clip.notes, clip.lengthBeats, color, { barBeats, padY: 2, maxNoteHeight: 3 })
    // 依赖里用哈希代替 notes 引用，见上
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesHash, pxPerBeat, rowHeight, color, barBeats])

  const width = Math.max(10, clip.lengthBeats * pxPerBeat)
  const clipHeight = Math.max(18, rowHeight - 8)
  const smartMeta = clip.smart ? SMART_KIND_META[clip.smart.kind] : null
  const bladeBeat = bladeX == null ? null : clip.startBeat + bladeX / Math.max(1, pxPerBeat)

  return (
    <div
      ref={rootRef}
      data-clip
      data-clip-id={clip.id}
      data-track-id={track.id}
      data-selected={selected ? 'true' : 'false'}
      className={cn(
        'group/clip absolute top-[4px] flex flex-col overflow-hidden rounded-[6px] border transition-[box-shadow,border-color,filter,opacity] duration-100',
        splitMode ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing',
        selected
          ? 'z-10 border-accent/80 shadow-[0_0_0_1px_rgba(240,180,41,0.4),0_8px_20px_-10px_rgba(0,0,0,0.95)]'
          : 'border-line-strong/70 hover:border-line-strong hover:brightness-[1.07]',
        clip.muted && 'opacity-55',
        smartMeta && selected && 'ring-1 ring-violet/40',
      )}
      style={{
        left: clip.startBeat * pxPerBeat,
        width,
        height: clipHeight,
        background: `linear-gradient(180deg, ${withAlpha(color, selected ? 0.34 : 0.24)}, ${withAlpha(color, 0.1)})`,
      }}
      title={
        splitMode
          ? `${clip.name} · 点击在鼠标位置拆分`
          : `${clip.name} · ${instrument.name} · ${clip.notes.length} 音符（拖动移动，双击进入钢琴卷帘）`
      }
      onPointerDown={(event) => onPointerDown(event, 'move')}
      onPointerMove={(event) => {
        if (!splitMode) return
        const rect = rootRef.current?.getBoundingClientRect()
        if (!rect) return
        const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left))
        setBladeX(x)
        onSplitHover?.(clip.startBeat + x / Math.max(1, pxPerBeat))
      }}
      onPointerLeave={() => {
        if (bladeX != null) {
          setBladeX(null)
          onSplitHover?.(null)
        }
      }}
      onDoubleClick={(event) => {
        event.stopPropagation()
        if (splitMode) return
        onDoubleClick()
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (bladeX != null) setBladeX(null)
        onContextMenu(event)
      }}
    >
      {/* 标题条 */}
      <div
        className="flex shrink-0 items-center gap-1 border-b px-1.5"
        style={{ height: 17, background: withAlpha(color, 0.26), borderColor: withAlpha(color, 0.35) }}
      >
        <span className="h-[5px] w-[5px] shrink-0 rounded-full" style={{ background: color }} />
        <span className="min-w-0 flex-1 truncate text-[10px] font-medium leading-none text-ink/95">{clip.name}</span>
        {smartMeta && <span className="shrink-0 text-[9px] leading-none opacity-80">{smartMeta.icon}</span>}
        {clip.muted && <EyeOff size={9} className="shrink-0 text-ink-2" />}
        {width > 110 && (
          <span className="mono shrink-0 text-[8.5px] leading-none text-ink-3">{clip.notes.length}</span>
        )}
      </div>

      {/* 音符缩略图 */}
      <div className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="block h-full w-full" />
      </div>

      {/* 多选：左上角计数徽标（只在不影响内容的宽度下显示） */}
      {selected && width > 58 && (
        <span className="pointer-events-none absolute right-1 top-[2px] hidden h-[12px] items-center rounded-[3px] bg-accent/25 px-1 text-[8px] font-semibold leading-none text-accent-soft group-hover/clip:flex">
          选中
        </span>
      )}

      {/* 切片刀线预览 */}
      {splitMode && bladeX != null && (
        <div className="pointer-events-none absolute inset-y-0 z-20 w-px bg-accent shadow-[0_0_6px_rgba(240,180,41,0.9)]" style={{ left: bladeX }}>
          <Scissors size={8} className="absolute -left-[3.5px] top-0 text-accent" />
        </div>
      )}
      {splitMode && bladeX != null && bladeBeat != null && width > 96 && (
        <span className="mono pointer-events-none absolute bottom-[2px] z-20 rounded bg-black/65 px-1 text-[8px] leading-tight text-accent-soft" style={{ left: Math.min(bladeX + 4, width - 38) }}>
          {bladeBeat.toFixed(2)} 拍
        </span>
      )}

      {/* 缩放把手（切片工具下隐藏，避免和点击拆分冲突） */}
      {!splitMode && (
        <>
          <div
            className="absolute inset-y-0 left-0 z-20 w-[5px] cursor-ew-resize bg-transparent transition-colors hover:bg-accent/35"
            title="拖动修改片段起点"
            onPointerDown={(event) => {
              event.stopPropagation()
              onPointerDown(event, 'left')
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          />
          <div
            className="absolute inset-y-0 right-0 z-20 w-[5px] cursor-ew-resize bg-transparent transition-colors hover:bg-accent/35"
            title="拖动修改片段长度"
            onPointerDown={(event) => {
              event.stopPropagation()
              onPointerDown(event, 'right')
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          />
        </>
      )}
    </div>
  )
}
