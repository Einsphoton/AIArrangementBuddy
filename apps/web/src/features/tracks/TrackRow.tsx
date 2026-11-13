/**
 * 单条轨道头（编曲视图左侧）。
 *
 * 对标 Logic / Cubase 的轨道头信息密度：
 * - R 录入预备（同时只 arm 一条）+ M 静音 + S 独奏 + 试听；
 * - 活动指示（按音量/静音估算的静态电平，非实时）；
 * - 点击色条选色、拖动色条排序；
 * - 底部 4px 热区拖动改行高（写入 uiStore，两侧视图同步），双击重置；
 * - 右键菜单：重命名 / 改色 / 复制 / 删除 / 上移下移 / 行高 / 折叠。
 *
 * 行高由父级传入（与编曲车道用同一 uiStore 值），保证严格对齐。
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, GripVertical, Info, Play, Waves } from 'lucide-react'
import { getInstrument, type Track } from '@aiab/core'
import { getAudioEngine } from '../../audio'
import { cn } from '../../lib/format'
import { useStore } from '../../store/store'
import { TRACK_HEIGHT_LIMITS, useUiStore } from '../../lib/uiStore'
import { resolveRecordClipId, trackAudibility } from '../../lib/trackRules'
import { clamp, trackColor, withAlpha } from '../arrangement/timeline'
import { usePointerDrag } from '../arrangement/usePointerDrag'
import { MiniHSlider, MiniKnob } from './controls'
import { TrackColorPopover, TrackContextMenu } from './trackMenu'
import { TrackCreativeInfoPopover, buildTrackCreativeInfo } from './trackCreativeInfo'

export interface DropTarget {
  index: number
  after: boolean
}

export function TrackRow({
  track,
  index,
  height,
  selected,
  dropTarget,
  renameSignal,
  registerMeter,
  onSelect,
  onOpenInstrument,
  onOpenEmotion,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  anySolo,
}: {
  track: Track
  index: number
  height: number
  selected: boolean
  dropTarget: DropTarget | null
  /** 父级收到 rename-track 命令时递增，用于弹出重命名输入框 */
  renameSignal: number
  /** 注册迷你电平填充元素（由 TrackPanel 的单条 rAF 统一驱动） */
  registerMeter: (trackId: string, element: HTMLSpanElement | null) => void
  onSelect: () => void
  onOpenInstrument: (rect: DOMRect) => void
  onOpenEmotion: (rect: DOMRect) => void
  onDragStart: (trackId: string) => void
  onDragEnd: () => void
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void
  /** 工程里是否有任意轨道在独奏：用于渲染「被独奏压住」的派生状态 */
  anySolo: boolean
}) {
  const updateTrack = useStore((s) => s.updateTrack)
  const project = useStore((s) => s.project)
  const pushHistory = useStore((s) => s.pushHistory)
  const setSaveStatus = useStore((s) => s.setSaveStatus)
  const toggleMute = useStore((s) => s.toggleMute)
  const toggleSolo = useStore((s) => s.toggleSolo)
  const armedTrackId = useUiStore((s) => s.armedTrackId)
  const setArmedTrackId = useUiStore((s) => s.setArmedTrackId)
  const setTrackHeight = useUiStore((s) => s.setTrackHeight)
  const hasCustomHeight = useUiStore((s) => Boolean(s.trackHeights[track.id]))

  const drag = usePointerDrag()
  const rowRef = useRef<HTMLDivElement>(null)
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastExpandedHeight = useRef<number | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(track.name)
  const [previewing, setPreviewing] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [colorAnchor, setColorAnchor] = useState<{ left: number; right: number; top: number; bottom: number } | null>(null)
  const [infoAnchor, setInfoAnchor] = useState<DOMRect | null>(null)

  /** 手势开始：记一次撤销点，并标记工程已修改（后续连续更新用 history:false） */
  const beginEdit = () => {
    pushHistory()
    setSaveStatus('dirty')
  }

  useEffect(() => setDraft(track.name), [track.name])

  useEffect(() => {
    if (!renameSignal) return
    setDraft(track.name)
    setRenaming(true)
    // 仅在信号变化时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameSignal])

  useEffect(
    () => () => {
      if (previewTimer.current) clearTimeout(previewTimer.current)
    },
    [],
  )

  const instrument = getInstrument(track.instrumentId)
  const emotion = instrument.emotions.find((item) => item.id === track.emotionId) ?? instrument.emotions[0]
  const color = trackColor(track.color)
  const collapsed = height <= TRACK_HEIGHT_LIMITS.collapsed + 2
  const showSecondRow = height >= 48 && !collapsed
  /** 第三行「创作信息」：默认行高 56px 起显示，紧凑/折叠行不强行塞入 */
  const showCreativeLine = showSecondRow && height >= 56
  const creative = buildTrackCreativeInfo(project, track)
  const armed = armedTrackId === track.id
  /*
   * 混音状态是**派生**出来的三态，不新增工程字段：
   * - muted：用户显式按了 M；
   * - suppressed：别的轨道在独奏，这条被「隐式静音」——它的 mute 仍是 false，
   *   取消独奏后会自动恢复出声（绝不把派生状态写回工程，见 lib/trackRules）；
   * - audible：正常出声。
   */
  const audibility = trackAudibility(track, anySolo)
  const suppressed = audibility === 'implicitly-muted'
  const muted = audibility === 'muted'
  const activityColor = muted || suppressed ? '#4a5466' : color
  /** armed + muted 是「录得进去但听不见」的经典陷阱：组合状态必须显式提示 */
  const armedButMuted = armed && (muted || suppressed)

  const commitRename = () => {
    setRenaming(false)
    const next = draft.trim()
    if (!next || next === track.name) {
      setDraft(track.name)
      return
    }
    updateTrack(track.id, { name: next })
  }

  const preview = () => {
    try {
      const engine = getAudioEngine()
      const base =
        track.kind === 'drum'
          ? 36
          : 60 + (instrument.previewNotes?.[0] ?? 0) + clamp(track.octaveShift, -3, 3) * 12
      engine.previewNote(track, clamp(base, 0, 127), 100, 0.55)
      setPreviewing(true)
      if (previewTimer.current) clearTimeout(previewTimer.current)
      previewTimer.current = setTimeout(() => setPreviewing(false), 380)
    } catch (error) {
      console.warn('[tracks] 试听失败', error)
    }
  }

  const toggleCollapse = (event: React.MouseEvent) => {
    event.stopPropagation()
    if (collapsed) {
      setTrackHeight(track.id, lastExpandedHeight.current ?? null)
    } else {
      lastExpandedHeight.current = height > TRACK_HEIGHT_LIMITS.collapsed ? height : null
      setTrackHeight(track.id, TRACK_HEIGHT_LIMITS.collapsed)
    }
  }

  /* 底部 4px 热区：拖动改行高（rAF 节流，避免每个 pointermove 都写 localStorage） */
  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()
    const startY = event.clientY
    const initial = height
    let latest = initial
    let frame = 0
    const flush = () => {
      frame = 0
      setTrackHeight(track.id, latest)
    }
    drag(event, {
      onMove: (moveEvent) => {
        latest = Math.round(
          clamp(initial + (moveEvent.clientY - startY), TRACK_HEIGHT_LIMITS.collapsed, TRACK_HEIGHT_LIMITS.max),
        )
        if (!frame) frame = requestAnimationFrame(flush)
      },
      onUp: () => {
        if (frame) {
          cancelAnimationFrame(frame)
          frame = 0
        }
        setTrackHeight(track.id, latest)
      },
    })
  }

  const resetHeight = (event: React.MouseEvent) => {
    event.stopPropagation()
    setTrackHeight(track.id, null)
  }

  const openColor = () => {
    const rect = rowRef.current?.getBoundingClientRect()
    if (!rect) return
    setColorAnchor({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
  }

  const showBefore = dropTarget?.index === index && !dropTarget.after
  const showAfter = dropTarget?.index === index && dropTarget.after

  return (
    <div
      ref={rowRef}
      data-track-row
      data-track-id={track.id}
      data-track-name={track.name}
      data-mix-state={audibility}
      onClick={onSelect}
      onContextMenu={(event) => {
        const target = event.target as HTMLElement
        if (target.tagName === 'INPUT') return
        event.preventDefault()
        event.stopPropagation()
        onSelect()
        setColorAnchor(null)
        setMenu({ x: event.clientX, y: event.clientY })
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn(
        'group relative flex cursor-default select-none border-b border-line/70 transition-colors',
        selected ? 'bg-surface-2' : 'bg-transparent hover:bg-surface-2/55',
      )}
      style={{ height }}
    >
      {selected && <span className="pointer-events-none absolute inset-y-0 left-0 z-[1] w-[2px]" style={{ background: color }} />}
      {showBefore && <span className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[2px] bg-accent shadow-[0_0_8px_rgba(240,180,41,0.8)]" />}
      {showAfter && <span className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[2px] bg-accent shadow-[0_0_8px_rgba(240,180,41,0.8)]" />}

      {/* 色条：拖动排序 / 点击选色 */}
      <div
        draggable
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', track.id)
          if (rowRef.current) event.dataTransfer.setDragImage(rowRef.current, 24, Math.min(height / 2, 40))
          onDragStart(track.id)
        }}
        onDragEnd={onDragEnd}
        onClick={(event) => {
          event.stopPropagation()
          openColor()
        }}
        title="拖动排序 · 点击选择轨道颜色"
        aria-label={`轨道颜色：${color}`}
        className="group/handle relative z-[2] flex w-[16px] shrink-0 cursor-grab items-center justify-center active:cursor-grabbing"
        style={{ background: withAlpha(color, 0.16), boxShadow: `inset -1px 0 0 ${withAlpha(color, 0.3)}` }}
      >
        <span
          className="absolute inset-y-[6px] left-[2px] w-[2px] rounded-full"
          style={{ background: color, boxShadow: `0 0 6px ${withAlpha(color, 0.7)}` }}
        />
        {!collapsed && (
          <GripVertical
            size={9}
            className="relative z-10 text-ink-4 opacity-0 transition-opacity group-hover/handle:opacity-90"
            aria-hidden
          />
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 overflow-hidden px-1.5">
        {/* 第一行：序号 / 名称 / R M S / 折叠 */}
        <div className="flex min-w-0 items-center gap-1">
          {/* 折叠态只保留「序号 + 名称 + 展开箭头」，避免 26px 行高下文字被裁 */}
          <span className="mono w-3.5 shrink-0 text-[9.5px] text-ink-4">{index + 1}</span>
          {renaming ? (
            <input
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitRename()
                if (event.key === 'Escape') {
                  setDraft(track.name)
                  setRenaming(false)
                }
              }}
              onClick={(event) => event.stopPropagation()}
              aria-label="轨道名称"
              className="h-[22px] min-w-0 flex-1 rounded-[5px] border border-accent/60 bg-bg px-1.5 text-[12px] outline-none"
            />
          ) : (
            <button
              onDoubleClick={() => {
                setDraft(track.name)
                setRenaming(true)
              }}
              onClick={(event) => {
                event.stopPropagation()
                onSelect()
              }}
              title={`${track.name}（双击重命名，右键更多操作）`}
              className={cn(
                'min-w-0 flex-1 truncate text-left text-[12.5px] font-medium leading-tight transition-colors',
                /* 显式静音划掉；被独奏压住只变暗（不是用户的选择，不该划掉） */
                muted ? 'text-ink-4 line-through' : suppressed ? 'text-ink-4' : selected ? 'text-ink' : 'text-ink-2 group-hover:text-ink',
              )}
            >
              <span className="block min-w-0 truncate text-[12.5px]">{track.name}</span>
            </button>
          )}
          <div className={cn('flex shrink-0 items-center gap-[3px]', collapsed && 'hidden')}>
            <button
              onClick={(event) => {
                event.stopPropagation()
                const next = armed ? null : track.id
                setArmedTrackId(next)
                /*
                 * 预备的同时把焦点移到这条轨道：
                 * 录制路径优先用 armedTrackId，但「MIDI Thru 试听 / 钢琴卷帘显示哪条轨」
                 * 仍然跟随 focusedTrackId。两边同步，点 R 之后的所见即所得才一致。
                 */
                if (next) useStore.getState().focusTrack(next)
                // 预备了却录不进去的情况要如实告知，不能只点亮一个红点
                if (next) {
                  const state = useStore.getState()
                  if (!state.midiRecord) {
                    state.pushToast('info', `已预备「${track.name}」：打开 MIDI 录入后才会写入音符`)
                  } else if (state.view !== 'pianoroll') {
                    state.pushToast('info', `已预备「${track.name}」：切到钢琴卷帘才会写入音符`)
                  } else if (!resolveRecordClipId(track, state.selection.clipId)) {
                    state.pushToast('info', `「${track.name}」还没有可录的片段：先建一个 MIDI 片段`)
                  } else if (muted || suppressed) {
                    /* 录得进去但监听听不到：这是最容易被误判成「没录上」的组合 */
                    state.pushToast(
                      'info',
                      muted
                        ? `「${track.name}」已预备，但它是静音的：录进去也听不到，点 M 取消静音`
                        : `「${track.name}」已预备，但被其它轨道的独奏压住：录进去也听不到，点上方总控 S 清空独奏`,
                    )
                  } else {
                    state.pushToast('success', `已预备「${track.name}」：弹奏会写进这条轨道`)
                  }
                }
              }}
              title={armed ? '取消录入预备（同时只 arm 一条轨道）' : '录入预备：MIDI 弹奏写入这条轨道'}
              aria-label={armed ? `取消 ${track.name} 的录入预备` : `预备录入 ${track.name}`}
              aria-pressed={armed}
              data-arm={armed ? 'true' : 'false'}
              className={cn(
                'flex h-[18px] w-[18px] items-center justify-center rounded-[5px] border transition-colors',
                armed
                  ? 'animate-[pulse-dot_1.4s_ease-in-out_infinite] border-danger/70 bg-danger/30 text-danger'
                  : 'border-line-strong bg-surface-2 text-ink-4 hover:text-danger',
              )}
            >
              <span className="text-[9.5px] font-bold leading-none">R</span>
            </button>
            <button
              onClick={(event) => {
                event.stopPropagation()
                toggleMute(track.id)
                useStore.getState().setSaveStatus('dirty')
              }}
              title={
                muted
                  ? '取消静音（M）'
                  : suppressed
                    ? '静音（M）· 当前已被其它轨道的独奏压住，这里按下去会把「显式静音」也置为开'
                    : '静音（M）'
              }
              aria-label={muted ? `取消静音 ${track.name}` : `静音 ${track.name}`}
              aria-pressed={muted}
              data-track-mute={muted ? 'true' : 'false'}
              data-implicit-mute={suppressed ? 'true' : 'false'}
              className={cn(
                'relative flex h-[18px] w-[18px] items-center justify-center rounded-[5px] border text-[9.5px] font-bold leading-none transition-colors',
                muted
                  ? 'border-danger/60 bg-danger/25 text-danger'
                  : suppressed
                    ? /* 隐式静音：描边点亮但不填色 —— 明确区分「被 solo 压住」与「用户真的静音了」 */
                      'border-danger/35 bg-surface-2 text-danger/55'
                    : 'border-line-strong bg-surface-2 text-ink-4 hover:text-ink-2',
              )}
            >
              <span className="text-[9.5px] font-bold leading-none">M</span>
            </button>
            <button
              onClick={(event) => {
                event.stopPropagation()
                /*
                 * 普通点击 = 累加独奏（可多条同时独奏）；
                 * Alt/Option+点击 = 独占独奏（清空其它，只留这条）。
                 * 与 Logic / Studio One 一致；Alt 在 Cubase 是 Solo Defeat，
                 * 所以语义必须写进 tooltip，别让用户猜。
                 */
                toggleSolo(track.id, { exclusive: event.altKey })
                useStore.getState().setSaveStatus('dirty')
              }}
              title={
                track.solo
                  ? '取消独奏（S）· 按住 Alt/Option 点击 = 只保留这条独奏'
                  : '独奏（S）· 再点其它轨可多条同时独奏 · 按住 Alt/Option 点击 = 独占独奏'
              }
              aria-label={track.solo ? `取消独奏 ${track.name}` : `独奏 ${track.name}`}
              aria-pressed={Boolean(track.solo)}
              data-track-solo={track.solo ? 'true' : 'false'}
              className={cn(
                'flex h-[18px] w-[18px] items-center justify-center rounded-[5px] border text-[9.5px] font-bold leading-none transition-colors',
                track.solo
                  ? 'border-accent/60 bg-accent/25 text-accent'
                  : muted
                    ? /* 已静音的轨：S 能点亮但不会出声，视觉上给一点提示 */
                      'border-line-strong bg-surface-2 text-ink-4/70 hover:text-accent'
                    : 'border-line-strong bg-surface-2 text-ink-4 hover:text-ink-2',
              )}
            >
              <span className="text-[9.5px] font-bold leading-none">S</span>
            </button>
            <button
              onClick={(event) => {
                event.stopPropagation()
                preview()
              }}
              title="试听音色"
              aria-label="试听音色"
              className={cn(
                'hidden h-[18px] w-[18px] items-center justify-center rounded-[5px] border border-transparent text-ink-4 transition-colors hover:border-line-strong hover:bg-surface-3 hover:text-accent sm:flex',
                previewing && 'animate-pulse text-accent',
              )}
            >
              <Play size={10} />
            </button>
            <button
              onClick={(event) => {
                event.stopPropagation()
                setInfoAnchor(event.currentTarget.getBoundingClientRect())
              }}
              title="创作信息：风格 / 调式 / BPM / 段落 / 乐器 / 智能片段参数"
              aria-label={`查看 ${track.name} 的创作信息`}
              data-creative-info-trigger
              className="flex h-[18px] w-[18px] items-center justify-center rounded-[5px] border border-transparent text-ink-4 transition-colors hover:border-line-strong hover:bg-surface-3 hover:text-accent"
            >
              <Info size={10} />
            </button>
          </div>
          <button
            onClick={toggleCollapse}
              title={collapsed ? '展开轨道' : '折叠轨道'}
              aria-label={collapsed ? `展开轨道 ${track.name}` : `折叠轨道 ${track.name}`}
              aria-expanded={!collapsed}
              className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] text-ink-4 transition-colors hover:bg-surface-3 hover:text-ink-2"
            >
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
        </div>

        {/* 第二行：乐器 / 情绪 / 音量 / 声像（行高不足时自动隐藏） */}
        {showSecondRow && (
          <div className="flex min-w-0 items-center gap-1">
            {track.kind === 'audio' ? (
              /* 音频轨没有乐器/情绪：显示片段数与来源提示，避免误显示「三角钢琴」 */
              <span
                className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden rounded px-0.5 text-[11px] text-ink-3"
                title="音频轨道：片段来自「文件 → 导入音频…」或「AI 生成音频」（音量 / 声像 / 静音照常生效）"
              >
                <Waves size={11} className="shrink-0 text-cyan/80" />
                <span className="truncate text-[11px]">音频 · {track.audioClips?.length ?? 0} 个片段</span>
              </span>
            ) : (
              <button
                onClick={(event) => {
                  event.stopPropagation()
                  onOpenInstrument(event.currentTarget.getBoundingClientRect())
                }}
                title={`更换乐器（当前：${instrument.name}）`}
                className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden rounded px-0.5 text-[11px] text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink-2"
              >
                <span className="shrink-0 text-[11px]">{instrument.icon}</span>
                <span className="truncate text-[11px]">{instrument.name}</span>
              </button>
            )}

            {track.kind !== 'audio' && (
              <button
                onClick={(event) => {
                  event.stopPropagation()
                  onOpenEmotion(event.currentTarget.getBoundingClientRect())
                }}
                title={`情绪 / 演奏法（当前：${emotion.name} · ${emotion.hint}）`}
                className="flex h-[18px] shrink-0 items-center gap-1 rounded-full border border-line-strong/80 bg-surface-2 px-1.5 text-[10px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: emotion.color }} />
                <span className="max-w-[58px] shrink-0 whitespace-nowrap text-[10px]">{emotion.name}</span>
              </button>
            )}

            <div className="ml-auto flex shrink-0 items-center gap-1">
              <MiniHSlider
                value={track.volume}
                min={0}
                max={1.5}
                width={40}
                title="音量"
                onGestureStart={beginEdit}
                onChange={(value) => updateTrack(track.id, { volume: clamp(value, 0, 1.5) }, { history: false })}
                formatValue={(value) => `${Math.round(value * 100)}%`}
                fillColor={`linear-gradient(90deg, ${withAlpha(color, 0.35)}, ${color})`}
              />
              <MiniKnob
                value={track.pan}
                size={17}
                title="声像"
                accent="#3ddbd9"
                onGestureStart={beginEdit}
                onChange={(value) => updateTrack(track.id, { pan: clamp(value, -1, 1) }, { history: false })}
                formatValue={(value) =>
                  Math.abs(value) < 0.03 ? 'C' : `${value < 0 ? 'L' : 'R'}${Math.round(Math.abs(value) * 100)}`
                }
              />
            </div>
          </div>
        )}

        {/* 第三行：创作信息（只读摘要；完整信息点第一行的 i 按钮） */}
        {showCreativeLine && (
          <div
            className="flex min-w-0 items-center gap-1 overflow-hidden text-[9.5px] leading-none text-ink-4"
            title={creative.detailTitle}
            data-creative-line
          >
            <span className="h-[3px] w-[3px] shrink-0 rounded-full" style={{ background: withAlpha(color, 0.5) }} />
            <span className="min-w-0 truncate">{creative.inlineSummary}</span>
          </div>
        )}

        {/* armed + 静音/被压下 = 「录得进去但听不见」。这是 DAW 里最经典的自我怀疑来源，
            必须显式说出来，而不是让用户对着一个红点猜 */}
        {armedButMuted && (
          <div
            className="flex min-w-0 items-center gap-1 overflow-hidden text-[9.5px] leading-none text-danger/85"
            data-armed-muted-warning
            title={
              muted
                ? `「${track.name}」已预备录入，但轨道是静音的：音符会写进片段，但监听时听不到。点 M 取消静音。`
                : `「${track.name}」已预备录入，但正被其它轨道的独奏压住：音符会写进片段，但监听时听不到。清空独奏（总控 S）后可听到。`
            }
          >
            <span className="shrink-0">⚠</span>
            <span className="min-w-0 truncate">{muted ? '已预备但静音 · 录进去也听不到' : '已预备但被独奏压住'}</span>
          </div>
        )}
      </div>

      {/* 迷你电平指示：由 TrackPanel 的单条 rAF 用 engine.getTrackLevels() 实时驱动。
          `data-mix-state` 让界面 / 自动化都能一眼看出这条轨是「静音」还是「被独奏压住」 */}
      <div
        data-activity-meter
        data-level="0.00"
        data-armed={armed ? 'true' : 'false'}
        data-mix-state={audibility}
        data-activity-label={`电平 ${track.name}${muted ? '（已静音）' : suppressed ? '（被独奏压住）' : ''}`}
        role="img"
        className="pointer-events-none absolute bottom-[6px] right-[2px] top-[3px] w-[3px] overflow-hidden rounded-full bg-white/[0.06]"
        title={`实时电平：引擎每轨读数（-60..0 dB 映射）· 音量 ${Math.round(track.volume * 100)}%${
          muted ? ' · 已静音' : suppressed ? ' · 被别的轨道的独奏压住（取消独奏即恢复）' : ''
        }`}
        aria-label={`实时电平 ${track.name}${muted ? '：已静音' : suppressed ? '：被独奏压住' : ''}`}
      >
        <span
          ref={(element) => registerMeter(track.id, element)}
          className="absolute inset-x-0 bottom-0 rounded-full"
          style={{
            height: '0%',
            background: withAlpha(activityColor, muted ? 0.35 : suppressed ? 0.45 : 0.85),
            boxShadow: muted || suppressed ? 'none' : `0 0 5px ${withAlpha(activityColor, 0.55)}`,
          }}
        />
      </div>

      {/* 行高拖拽热区（底部 4px，双击重置） */}
      <div
        role="separator"
        aria-label={`调整 ${track.name} 行高`}
        title="上下拖动调整行高，双击恢复默认"
        onPointerDown={beginResize}
        onDoubleClick={resetHeight}
        onClick={(event) => event.stopPropagation()}
        className="group/resize absolute inset-x-0 bottom-0 z-[3] h-[4px] cursor-ns-resize bg-transparent"
      >
        <span className="absolute inset-x-0 bottom-0 h-px bg-transparent transition-colors group-hover/resize:bg-accent/70" />
      </div>

      {/* 右键菜单 / 颜色弹层 */}
      {menu && (
        <TrackContextMenu
          x={menu.x}
          y={menu.y}
          track={track}
          index={index}
          height={height}
          hasCustomHeight={hasCustomHeight}
          onClose={() => setMenu(null)}
          onRequestRename={() => {
            setDraft(track.name)
            setRenaming(true)
          }}
          onOpenColor={openColor}
        />
      )}
      {colorAnchor && (
        <TrackColorPopover
          anchor={colorAnchor}
          current={track.color}
          onClose={() => setColorAnchor(null)}
          onPick={(nextColor) => {
            updateTrack(track.id, { color: nextColor })
            setColorAnchor(null)
            useStore.getState().setSaveStatus('dirty')
          }}
        />
      )}
      {infoAnchor && (
        <TrackCreativeInfoPopover
          anchor={infoAnchor}
          project={project}
          track={track}
          onClose={() => setInfoAnchor(null)}
        />
      )}
    </div>
  )
}
