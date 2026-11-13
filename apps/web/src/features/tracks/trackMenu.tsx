/**
 * 轨道头右键菜单与颜色选择弹层。
 *
 * 右键 = 就地操作（Ableton / Logic / Cubase 的通用惯例）：
 * 重命名、改色、复制、删除、上移/下移、行高、折叠、试听都在这里，不用去别处找按钮。
 *
 * 多选（本轮新增）：菜单的作用域跟随当前选中集合——删除 / 复制 / 静音 / 独奏 / 行高
 * 都会同时作用于所有选中轨道，并在标题里写明数量，避免「以为只删了一条」。
 */
import {
  ArrowDown,
  ArrowUp,
  CheckSquare,
  Copy,
  Music4,
  Palette,
  Pencil,
  Play,
  Rows2,
  Rows3,
  Rows4,
  Square,
  Trash2,
  ChevronsDownUp,
  Volume2,
  VolumeX,
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
  selectionIds,
  onPreview,
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
  /** 菜单作用域：包含被右键轨道时为其所在的完整选中集合，否则只有这一条 */
  selectionIds: string[]
  /** 试听音色（原轨道头上的 ▶ 按钮收进菜单，窄面板不再挤占名称） */
  onPreview: () => void
  onClose: () => void
  onRequestRename: () => void
  onOpenColor: () => void
}) {
  const collapsed = height <= TRACK_HEIGHT_LIMITS.collapsed + 2
  const multi = selectionIds.length > 1
  const countSuffix = multi ? `（${selectionIds.length} 条）` : ''

  const pickHeight = (value: number | null) => {
    const ui = useUiStore.getState()
    for (const id of selectionIds) ui.setTrackHeight(id, value)
    onClose()
  }
  const muteAll = () => {
    const state = useStore.getState()
    const next = !track.mute
    state.setTracksMuted(selectionIds, next)
    state.setSaveStatus('dirty')
    state.pushToast('info', next ? `已静音 ${selectionIds.length} 条轨道` : `已取消静音 ${selectionIds.length} 条轨道`)
  }
  const soloAll = () => {
    const state = useStore.getState()
    const next = !track.solo
    state.setTracksSolo(selectionIds, next)
    state.setSaveStatus('dirty')
    state.pushToast('info', next ? `已独奏 ${selectionIds.length} 条轨道` : `已取消独奏 ${selectionIds.length} 条轨道`)
  }

  return (
    <ContextMenu
      x={x}
      y={y}
      onClose={onClose}
      label={`轨道 ${index + 1} · ${track.name}${multi ? ` · 已选 ${selectionIds.length} 条` : ''}`}
      width={224}
    >
      <MenuItem icon={<Pencil size={12} />} label="重命名" hint="双击名称" onClick={() => { onClose(); onRequestRename() }} />
      <MenuItem icon={<Palette size={12} />} label={multi ? `更改颜色${countSuffix}…` : '更改颜色…'} onClick={() => { onClose(); onOpenColor() }} />
      <MenuItem icon={<Play size={12} />} label="试听音色" onClick={() => { onClose(); onPreview() }} />
      <MenuDivider />
      <MenuLabel>选择</MenuLabel>
      <MenuItem
        icon={<CheckSquare size={12} />}
        label="全选轨道"
        hint="Ctrl/⌘+A"
        onClick={() => {
          useStore.getState().selectAllTracks()
          onClose()
        }}
      />
      <MenuItem
        icon={<Square size={12} />}
        label="仅选这条"
        disabled={selectionIds.length === 1 && selectionIds[0] === track.id}
        onClick={() => {
          useStore.getState().selectTrack(track.id, { mode: 'replace' })
          onClose()
        }}
      />
      <MenuDivider />
      <MenuItem
        icon={<Copy size={12} />}
        label={`复制轨道${countSuffix}`}
        onClick={() => {
          const ids = useStore.getState().duplicateTracks(selectionIds)
          useStore.getState().pushToast('success', ids.length > 1 ? `已复制 ${ids.length} 条轨道` : '已复制轨道')
          onClose()
        }}
      />
      <MenuItem
        icon={<Trash2 size={12} />}
        label={`删除轨道${countSuffix}`}
        danger
        onClick={() => {
          const state = useStore.getState()
          state.removeTracks(selectionIds)
          state.pushToast('info', selectionIds.length > 1 ? `已删除 ${selectionIds.length} 条轨道（⌘Z 可撤销）` : `已删除轨道「${track.name}」`)
          onClose()
        }}
      />
      <MenuDivider />
      {/* 静音 / 独奏：与轨道头 M / S 同一套 store action，右键也能完成
          （右键菜单是 DAW 里「就地操作」的通用入口，不该只留一个 M/S 小按钮） */}
      <MenuLabel>混音{multi ? ` · 作用于 ${selectionIds.length} 条选中轨` : ''}</MenuLabel>
      <MenuItem
        icon={<Volume2 size={12} />}
        label={multi ? (track.mute ? '取消静音' : '静音') : track.mute ? '取消静音' : '静音'}
        checked={Boolean(track.mute)}
        hint="M"
        onClick={() => {
          if (multi) {
            muteAll()
            onClose()
          } else {
            useStore.getState().toggleMute(track.id)
            onClose()
          }
        }}
      />
      <MenuItem
        icon={<Music4 size={12} />}
        label={multi ? (track.solo ? '取消独奏' : '独奏') : track.solo ? '取消独奏' : '独奏'}
        checked={Boolean(track.solo)}
        hint="S"
        onClick={() => {
          if (multi) {
            soloAll()
            onClose()
          } else {
            useStore.getState().toggleSolo(track.id)
            onClose()
          }
        }}
      />
      <MenuItem
        icon={<Music4 size={12} />}
        label="独占独奏（只留这条）"
        hint="Alt+S"
        disabled={
          Boolean(track.solo) && useStore.getState().project.tracks.filter((item) => item.solo).length <= 1
        }
        onClick={() => {
          useStore.getState().setTrackSolo(track.id, true, { exclusive: true })
          onClose()
        }}
      />
      <MenuItem
        icon={<VolumeX size={12} />}
        label="清空全部独奏"
        disabled={!useStore.getState().project.tracks.some((item) => item.solo)}
        onClick={() => {
          useStore.getState().clearAllSolos()
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
      <MenuLabel>行高{multi ? ` · 作用于 ${selectionIds.length} 条选中轨` : ''}</MenuLabel>
      <MenuItem icon={<ChevronsDownUp size={12} />} label="折叠" checked={collapsed} onClick={() => pickHeight(TRACK_HEIGHT_LIMITS.collapsed)} />
      <MenuItem icon={<Rows2 size={12} />} label="紧凑 44px" checked={!collapsed && height === 44} onClick={() => pickHeight(44)} />
      <MenuItem icon={<Rows3 size={12} />} label="标准 60px" checked={!collapsed && height === 60} onClick={() => pickHeight(60)} />
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
      <p className="mt-2 text-[10px] leading-relaxed text-ink-4">颜色同步到编曲车道与片段标题；拖动左侧色条可给轨道排序，多选时会应用到全部选中轨道。</p>
    </Popover>
  )
}

/* popoverPosition 供 TrackRow 复用（避免重复计算） */
export { popoverPosition }
