/**
 * 编曲车道里的单个**音频片段**（`track.audioClips`）。
 *
 * 与 MIDI 的 ClipView 平行，但渲染的是波形：
 * - 峰值由服务端算好（512 桶 [min,max]），这里用 SVG `<polygon>` 画，主线程零 IO；
 * - 同一 asset 的 peaks 由 `useAssetPeaks` 缓存（见 features/audio/peaks.ts）；
 * - 坐标沿用编曲时间轴现有体系：`left = startBeat * pxPerBeat`、`width = lengthBeats * pxPerBeat`；
 * - 交互只做「选中 + 右键删除（菜单在 ArrangementView 里）+ 双击定位播放头」，
 *   拖动 / 裁切 / 变速不在一期范围（stretchRatio 固定 1）。
 */
import { useMemo } from 'react'
import { EyeOff, Layers, Waves } from 'lucide-react'
import type { AudioClip, Track } from '@aiab/core'
import { cn } from '../../lib/format'
import { formatAudioDuration, peaksPolygonPoints, useAssetPeaks } from '../audio/peaks'
import { trackColor, withAlpha } from './timeline'

export function AudioClipView({
  clip,
  track,
  pxPerBeat,
  rowHeight,
  selected,
  onSelect,
  onContextMenu,
  onDoubleClick,
}: {
  clip: AudioClip
  track: Track
  pxPerBeat: number
  rowHeight: number
  selected: boolean
  onSelect: (event: React.PointerEvent<HTMLDivElement>) => void
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void
  onDoubleClick?: () => void
}) {
  const peaks = useAssetPeaks(clip.assetId)
  const color = trackColor(track.color)

  const width = Math.max(10, clip.lengthBeats * pxPerBeat)
  const clipHeight = Math.max(18, rowHeight - 8)
  const waveHeight = Math.max(10, clipHeight - 17)

  /* 波形点串按 (asset, 区间, 尺寸) 缓存，缩放 / 拖动只重算一次 */
  const points = useMemo(
    () => (peaks ? peaksPolygonPoints(peaks, clip.offsetSec, clip.durationSec, width, waveHeight, clip.assetId) : ''),
    [peaks, clip.assetId, clip.offsetSec, clip.durationSec, width, waveHeight],
  )

  const duration = clip.durationSec > 0 ? clip.durationSec : peaks?.durationSec ?? 0
  /* P2-B：takes 版本（切换版本后 assetId 变 → useAssetPeaks 会按新 assetId 重新取峰值） */
  const takeCount = clip.takes?.length ?? 0
  const activeTakeIndex = takeCount > 0 ? clip.takes.findIndex((take) => take.id === clip.activeTakeId) : -1

  return (
    <div
      data-audio-clip
      data-clip-id={clip.id}
      data-track-id={track.id}
      data-asset-id={clip.assetId}
      data-selected={selected ? 'true' : 'false'}
      className={cn(
        'group/audio absolute top-[4px] flex cursor-pointer flex-col overflow-hidden rounded-[6px] border transition-[box-shadow,border-color,filter,opacity] duration-100',
        selected
          ? 'z-10 border-accent/80 shadow-[0_0_0_1px_rgba(240,180,41,0.4),0_8px_20px_-10px_rgba(0,0,0,0.95)]'
          : 'border-line-strong/70 hover:border-line-strong hover:brightness-[1.07]',
        clip.muted && 'opacity-55',
      )}
      style={{
        left: clip.startBeat * pxPerBeat,
        width,
        height: clipHeight,
        background: `linear-gradient(180deg, ${withAlpha(color, selected ? 0.3 : 0.2)}, ${withAlpha(color, 0.07)})`,
      }}
      title={`${clip.name} · ${formatAudioDuration(duration)} · 音频片段${
        takeCount > 0 ? ` · ${takeCount} 个版本（右键「切换版本」）` : ''
      }（单击选中，右键删除/重绘，双击定位播放头）`}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.stopPropagation()
        onSelect(event)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onContextMenu(event)
      }}
      onDoubleClick={(event) => {
        event.stopPropagation()
        onDoubleClick?.()
      }}
    >
      {/* 标题条：名称 + 时长 */}
      <div
        className="flex shrink-0 items-center gap-1 border-b px-1.5"
        style={{ height: 17, background: withAlpha(color, 0.26), borderColor: withAlpha(color, 0.35) }}
      >
        <Waves size={9} className="shrink-0" style={{ color }} />
        <span className="min-w-0 flex-1 truncate text-[10px] font-medium leading-none text-ink/95">{clip.name}</span>
        {clip.muted && <EyeOff size={9} className="shrink-0 text-ink-2" />}
        {takeCount > 0 && width > 84 && (
          <span
            className="mono flex shrink-0 items-center gap-[1px] text-[8.5px] leading-none text-ink-3"
            title={`${takeCount} 个版本（右键「切换版本」）`}
          >
            <Layers size={8} />
            {activeTakeIndex >= 0 ? `${activeTakeIndex + 1}/${takeCount}` : takeCount}
          </span>
        )}
        {width > 74 && (
          <span className="mono shrink-0 text-[8.5px] leading-none text-ink-3" title="音频时长">
            {formatAudioDuration(duration)}
          </span>
        )}
      </div>

      {/* 波形（SVG polygon，零主线程 IO） */}
      <div className="relative min-h-0 flex-1">
        {points ? (
          <svg
            className="block h-full w-full"
            viewBox={`0 0 ${Math.max(2, Math.round(width))} ${waveHeight}`}
            preserveAspectRatio="none"
            aria-hidden
          >
            <polygon points={points} fill={withAlpha(color, 0.85)} />
          </svg>
        ) : (
          <div className="flex h-full items-center px-2" aria-label="波形加载中">
            <span className="h-px w-full" style={{ background: withAlpha(color, 0.35) }} />
          </div>
        )}
        {/* 中线：无波形时给一个视觉锚点 */}
        <span
          className="pointer-events-none absolute inset-x-0 top-1/2 h-px"
          style={{ background: withAlpha(color, points ? 0.16 : 0) }}
        />
      </div>

      {selected && width > 58 && (
        <span className="pointer-events-none absolute right-1 top-[2px] hidden h-[12px] items-center rounded-[3px] bg-accent/25 px-1 text-[8px] font-semibold leading-none text-accent-soft group-hover/audio:flex">
          选中
        </span>
      )}
    </div>
  )
}
