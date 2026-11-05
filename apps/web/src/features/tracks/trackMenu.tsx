/**
 * 轨道头右键菜单与颜色选择弹层。
 *
 * 右键 = 就地操作（Ableton / Logic / Cubase 的通用惯例）：
 * 重命名、改色、复制、删除、上移/下移、行高、折叠都在这里，不用去别处找按钮。
 */
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Palette,
  Pencil,
  Rows2,
  Rows3,
  Rows4,
  Trash2,
  ChevronsDownUp,
} from 'lucide-react'
import { ContextMenu, MenuDivider, MenuItem, MenuLabel, Popover, popoverPosition } from '../../components/ui/menu'
import { useStore } from '../../store/store'
import { TRACK_HEIGHT_LIMITS, useUiStore } from '../../lib/uiStore'
import { cn } from '../../lib/format'
import { TRACK_COLORS, trackColor } from '../arrangement/timeline'
import type { Track } from '@aiab/core'

export function TrackContextMenu({
  x,
  y,
  track,
  index,
  height,
  hasCustomHeight,
  onClose,
  onRequestRename,
  onOpenColor,
}: {
  x: number
  y: number
  track: Track
  index: number
  height: number
  hasCustomHeight: boolean
  onClose: () => void
  onRequestRename: () => void
  onOpenColor: () => void
}) {
  const collapsed = height <= TRACK_HEIGHT_LIMITS.collapsed + 2
  const pickHeight = (value: number | null) => {
    useUiStore.getState().setTrackHeight(track.id, value)
    onClose()
  }

  return (
    <ContextMenu x={x} y={y} onClose={onClose} label={`轨道 ${index + 1} · ${track.name}`} width={216}>
      <MenuItem icon={<Pencil size={12} />} label="重命名" hint="双击名称" onClick={() => { onClose(); onRequestRename() }} />
      <MenuItem icon={<Palette size={12} />} label="更改颜色…" onClick={() => { onClose(); onOpenColor() }} />
      <MenuDivider />
      <MenuItem
        icon={<Copy size={12} />}
        label="复制轨道"
        onClick={() => {
          useStore.getState().duplicateTrack(track.id)
          useStore.getState().pushToast('success', '已复制轨道')
          onClose()
        }}
      />
      <MenuItem
        icon={<Trash2 size={12} />}
        label="删除轨道"
        danger
        onClick={() => {
          useStore.getState().removeTrack(track.id)
          useStore.getState().pushToast('info', `已删除轨道「${track.name}」`)
          onClose()
        }}
      />
      <MenuDivider />
      <MenuItem
        icon={<ArrowUp size={12} />}
        label="上移"
        disabled={index === 0}
        onClick={() => {
          useStore.getState().moveTrack(track.id, -1)
          onClose()
        }}
      />
      <MenuItem
        icon={<ArrowDown size={12} />}
        label="下移"
        disabled={index >= useStore.getState().project.tracks.length - 1}
        onClick={() => {
          useStore.getState().moveTrack(track.id, 1)
          onClose()
        }}
      />
      <MenuDivider />
      <MenuLabel>行高</MenuLabel>
      <MenuItem icon={<ChevronsDownUp size={12} />} label="折叠" checked={collapsed} onClick={() => pickHeight(TRACK_HEIGHT_LIMITS.collapsed)} />
      <MenuItem icon={<Rows2 size={12} />} label="紧凑 44px" checked={!collapsed && height === 44} onClick={() => pickHeight(44)} />
      <MenuItem icon={<Rows3 size={12} />} label="标准 56px" checked={!collapsed && height === 56} onClick={() => pickHeight(56)} />
      <MenuItem icon={<Rows4 size={12} />} label="舒展 80px" checked={!collapsed && height === 80} onClick={() => pickHeight(80)} />
      <MenuItem
        icon={<Rows2 size={12} />}
        label="跟随纵向缩放"
        checked={!hasCustomHeight}
        onClick={() => pickHeight(null)}
      />
    </ContextMenu>
  )
}

export function TrackColorPopover({
  anchor,
  current,
  onPick,
  onClose,
}: {
  anchor: DOMRect | { left: number; right: number; top: number; bottom: number }
  current: string
  onPick: (color: string) => void
  onClose: () => void
}) {
  const currentColor = trackColor(current)
  return (
    <Popover
      anchor={anchor}
      onClose={onClose}
      width={214}
      estimatedHeight={150}
      label="轨道颜色"
      className="p-2.5"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="label">轨道颜色</span>
        <span className="mono text-[9px] text-ink-4">{currentColor}</span>
      </div>
      <div className="grid grid-cols-5 gap-1.5">
        {TRACK_COLORS.map((color) => {
          const active = color.toLowerCase() === currentColor.toLowerCase()
          return (
            <button
              key={color}
              type="button"
              aria-label={`轨道颜色 ${color}`}
              title={color}
              onClick={() => onPick(color)}
              className={cn(
                'flex h-7 w-full items-center justify-center rounded-md border transition-transform hover:scale-105',
                active ? 'border-white/70' : 'border-black/40',
              )}
              style={{ background: color }}
            >
              {active && <span className="h-1.5 w-1.5 rounded-full bg-black/70" />}
            </button>
          )
        })}
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-ink-4">颜色同步到编曲车道与片段标题；拖动左侧色条可给轨道排序。</p>
    </Popover>
  )
}

/* popoverPosition 供 TrackRow 复用（避免重复计算） */
export { popoverPosition }
