/**
 * 单条轨道头（编曲视图左侧）。
 *
 * 对标 Logic / Cubase 的轨道头信息密度，但不再把所有东西塞进同一行：
 * - **第一行**：序号 + 名称（优先占满可用宽度）+ 试听 / 创作信息 / 折叠；
 * - **第二行**：乐器（音频轨为片段数）· 情绪 + 音量 / 声像；
 * - **第三行**：只属于这条轨道的创作信息（段落 / 智能片段类型）。项目级风格 / 调号 / BPM
 *   上移到 `TrackPanel` 总控行，不再每行重复——重复行是「拥挤」的最大来源；
 * - **右侧竖排控制轨**：R / M / S 三个按钮竖排（Cubase / Logic 的既有范式），
 *   把横向空间还给名称；窄行高自动降级为紧凑尺寸；
 * - 行尾实时电平条；底部 4px 热区拖动改行高（写入 uiStore，两侧视图同步），双击重置；
 * - 右键菜单：重命名 / 改色 / 复制 / 删除 / 上移下移 / 行高 / 折叠 / 试听。
 *
 * 多选（本轮新增）：
 * - 行高亮由 `selectedTrackIds` 决定，`selectedTrackId`（anchor）是主轨；
 * - 在多选状态下点 M / S = 批量作用到全部选中轨；音量 / 声像相对同步；换色应用到全部；
 * - 行本身的普通点击 / Shift / Ctrl 选择由 `TrackPanel` 的列表容器统一处理（见 TrackPanel 注释）。
 */
import { useEffect, useRef, useState } from 'react'
import { AudioLines, ChevronDown, ChevronRight, GripVertical, Info, Play, Waves } from 'lucide-react'
import { getInstrument, type Track } from '@aiab/core'
import { getAudioEngine } from '../../audio'
import { bounceTrackToAudio, isBouncingTrack } from '../audio/bounceTrack'
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

/** 行内点击的修饰键语义（由列表容器 / 名称按钮转发） */
export interface TrackSelectGesture {
  /** Ctrl / ⌘：切换该轨的选中状态 */
  additive: boolean
  /** Shift：从 anchor 连选到该轨 */
  range: boolean
}

export function TrackRow({
  track,
  index,
  height,
  selected,
  primary,
  selectionIds,
  panelWidth,
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
  /** 是否在多选集合中 */
  selected: boolean
  /** 是否为主轨（anchor）：主轨的左侧色条/背景更亮 */
  primary: boolean
  /** 当前全部选中轨道 id（批量 M / S / 音量 / 声像 / 换色用） */
  selectionIds: string[]
  /** 轨道面板当前宽度（px）：窄面板降级隐藏次要按钮 */
  panelWidth: number
  dropTarget: DropTarget | null
  /** 父级收到 rename-track 命令时递增，用于弹出重命名输入框 */
  renameSignal: number
  /** 注册迷你电平填充元素（由 TrackPanel 的单条 rAF 统一驱动） */
  registerMeter: (trackId: string, element: HTMLSpanElement | null) => void
  onSelect: (gesture: TrackSelectGesture) => void
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
  const setTracksMuted = useStore((s) => s.setTracksMuted)
  const setTracksSolo = useStore((s) => s.setTracksSolo)
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
  /** 单轨 bounce 进行中：只做行内轻量提示，不阻塞其它 UI（渲染/上传可能要几秒） */
  const [bouncing, setBouncing] = useState(() => isBouncingTrack(track.id))
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [colorAnchor, setColorAnchor] = useState<{ left: number; right: number; top: number; bottom: number } | null>(null)
  const [infoAnchor, setInfoAnchor] = useState<DOMRect | null>(null)

  /** 音量 / 声像多选相对编辑：手势开始时快照所有目标轨道的基准值 */
  const gainGesture = useRef<{
    base: number
    targets: { id: string; value: number }[]
  } | null>(null)

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
  /** 第二行（乐器 / 音量）从 48px 起显示；更矮时只保留名称行 */
  const showSecondRow = !collapsed && height >= 48
  /** 第三行创作信息：默认 60px 行高下显示（比旧版多 4px 呼吸空间），更矮时隐藏 */
  const showCreativeLine = showSecondRow && height >= 56
  /** 右侧 R/M/S 竖排控制轨：折叠条或过矮行放不下三个按钮时不显示（右键菜单仍可操作） */
  const showRail = !collapsed && height >= 44
  /** 竖排按钮在较矮行里收紧到 12px，保证 3 个按钮 + 间距不溢出 */
  const compactRail = height < 58
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
  /** 多选状态下 M / S / 音量 / 声像 / 换色作用到整个选中集合 */
  const multiSelected = selectionIds.length > 1 && selectionIds.includes(track.id)
  const narrow = panelWidth < 292
  const showPreviewButton = panelWidth >= 320 && !collapsed

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

  /**
   * 单轨渲染为音频（bounce in place）。
   * 成功/失败的 toast 都由 bounceTrack 负责，这里只管行内「渲染中…」状态。
   */
  const bounce = () => {
    if (bouncing || isBouncingTrack(track.id)) return
    setBouncing(true)
    void bounceTrackToAudio(track.id).finally(() => setBouncing(false))
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

  /* ---------------- 多选批量手势 ---------------- */

  const muteTargets = () => (multiSelected ? selectionIds : [track.id])
  const soloTargets = () => (multiSelected ? selectionIds : [track.id])

  const applyMute = (event: React.MouseEvent) => {
    event.stopPropagation()
    const next = !muted
    if (muteTargets().length > 1) {
      setTracksMuted(selectionIds, next)
      setSaveStatus('dirty')
      return
    }
    toggleMute(track.id)
    setSaveStatus('dirty')
  }

  const applySolo = (event: React.MouseEvent) => {
    event.stopPropagation()
    /* Alt/Option = 独占独奏：只保留这一条（与单轨语义一致，多选时也以点中的那条为准） */
    if (event.altKey) {
      toggleSolo(track.id, { exclusive: event.altKey })
      setSaveStatus('dirty')
      return
    }
    const next = !Boolean(track.solo)
    if (soloTargets().length > 1) {
      setTracksSolo(selectionIds, next)
      setSaveStatus('dirty')
      return
    }
    toggleSolo(track.id, { exclusive: event.altKey })
    setSaveStatus('dirty')
  }

  /**
   * 音量 / 声像的多选相对编辑：
   * 手势开始时快照全部目标轨道的值，拖动时按「被拖轨道的增量」同步到其它选中轨，
   * 保持多条轨道之间的相对差（Logic 多选推子的行为），而不是把它们压成同一个值。
   */
  const beginGainGesture = (field: 'volume' | 'pan') => {
    beginEdit()
    const state = useStore.getState()
    const ids = multiSelected ? state.selectedTrackIds : [track.id]
    gainGesture.current = {
      base: field === 'volume' ? track.volume : track.pan,
      targets: state.project.tracks
        .filter((item) => ids.includes(item.id))
        .map((item) => ({ id: item.id, value: field === 'volume' ? item.volume : item.pan })),
    }
  }

  const changeVolume = (value: number) => {
    const gesture = gainGesture.current
    const next = clamp(value, 0, 1.5)
    if (!gesture || gesture.targets.length <= 1) {
      updateTrack(track.id, { volume: next }, { history: false })
      return
    }
    const delta = next - gesture.base
    for (const target of gesture.targets) {
      updateTrack(target.id, { volume: clamp(target.value + delta, 0, 1.5) }, { history: false })
    }
  }

  const changePan = (value: number) => {
    const gesture = gainGesture.current
    const next = clamp(value, -1, 1)
    if (!gesture || gesture.targets.length <= 1) {
      updateTrack(track.id, { pan: next }, { history: false })
      return
    }
    const delta = next - gesture.base
    for (const target of gesture.targets) {
      updateTrack(target.id, { pan: clamp(target.value + delta, -1, 1) }, { history: false })
    }
  }

  const pickColor = (nextColor: string) => {
    const ids = multiSelected ? selectionIds : [track.id]
    if (ids.length > 1) {
      pushHistory()
      for (const id of ids) updateTrack(id, { color: nextColor }, { history: false })
    } else {
      updateTrack(track.id, { color: nextColor })
    }
    setColorAnchor(null)
    setSaveStatus('dirty')
  }

  const showBefore = dropTarget?.index === index && !dropTarget.after
  const showAfter = dropTarget?.index === index && dropTarget.after
  const warnTitle = muted
    ? `「${track.name}」已预备录入，但轨道是静音的：音符会写进片段，但监听时听不到。点 M 取消静音。`
    : `「${track.name}」已预备录入，但正被其它轨道的独奏压住：音符会写进片段，但监听时听不到。清空独奏（总控 S）后可听到。`

  return (
    <div
      ref={rowRef}
      data-track-row="panel"
      data-track-id={track.id}
      data-track-name={track.name}
      data-track-index={index}
      data-track-selected={selected ? 'true' : 'false'}
      data-track-primary={primary ? 'true' : 'false'}
      data-mix-state={audibility}
      data-track-bouncing={bouncing ? 'true' : 'false'}
      onContextMenu={(event) => {
        const target = event.target as HTMLElement
        if (target.tagName === 'INPUT') return
        event.preventDefault()
        event.stopPropagation()
        /* 右键未选中的轨：先把它设为单选，菜单里的批量操作才有明确作用域 */
        if (!selected) onSelect({ additive: false, range: false })
        setColorAnchor(null)
        setMenu({ x: event.clientX, y: event.clientY })
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn(
        'group relative flex cursor-default select-none border-b border-line/70 transition-colors',
        selected
          ? primary
            ? 'bg-surface-3/55 shadow-[inset_0_0_0_1px_rgba(240,180,41,0.16)]'
            : 'bg-surface-2/70'
          : 'bg-transparent hover:bg-surface-2/55',
      )}
      style={{ height }}
    >
      {selected && (
        <span
          className="pointer-events-none absolute inset-y-0 left-0 z-[1] w-[2px]"
          style={{ background: primary ? color : withAlpha(color, 0.5) }}
        />
      )}
      {showBefore && <span className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[2px] bg-accent shadow-[0_0_8px_rgba(240,180,41,0.8)]" />}
      {showAfter && <span className="pointer-events-none absolute inset-x-0 bottom-0 z-[10] h-[2px] bg-accent shadow-[0_0_8px_rgba(240,180,41,0.8)]" />}

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
        title="拖动排序 · 点击选择轨道颜色（多选时应用到全部选中轨）"
        aria-label={`轨道颜色：${color}`}
        className="group/handle relative z-[2] flex w-[14px] shrink-0 cursor-grab items-center justify-center active:cursor-grabbing"
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

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-[3px] px-2">
        {/* 第一行：序号 / 名称 / 试听 / 创作信息 / 折叠 */}
        <div className="flex min-w-0 items-center gap-1">
          <span className="mono w-[14px] shrink-0 text-right text-[9.5px] leading-none text-ink-4/85">{index + 1}</span>
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
            /*
             * 名称用 span 而不是 button：轨道名的横向面积最大，若它是 button，
             * 列表的框选就会把它当成「控件」跳过——用户最自然的起拖点直接失效。
             * 单击选择交给 TrackPanel 的列表统一处理（避免 Ctrl 切换被触发两次），
             * 双击重命名仍在这里。
             */
            <span
              role="button"
              tabIndex={0}
              onDoubleClick={() => {
                setDraft(track.name)
                setRenaming(true)
              }}
              onKeyDown={(event) => {
                if (event.key === 'F2' || event.key === 'Enter') {
                  event.preventDefault()
                  setDraft(track.name)
                  setRenaming(true)
                }
              }}
              title={`${track.name}（双击重命名；Shift 连选 / Ctrl 加选；拖动可框选多条）`}
              data-track-name={track.name}
              className={cn(
                'min-w-0 flex-1 cursor-default truncate text-left text-[12.5px] font-medium leading-tight outline-none transition-colors',
                /* 显式静音划掉；被独奏压住只变暗（不是用户的选择，不该划掉） */
                muted ? 'text-ink-4 line-through' : suppressed ? 'text-ink-4' : selected ? 'text-ink' : 'text-ink-2 group-hover:text-ink',
              )}
            >
              <span className="block min-w-0 truncate text-[12.5px]">{track.name}</span>
            </span>
          )}
          {/* 渲染中：行内轻量提示（不遮挡操作、不禁用其它轨道；完成后 bounceTrack 会 toast） */}
          {bouncing && (
            <span
              data-track-bouncing-label
              title="正在离线渲染为音频…完成后自动落一条音频轨并静音原轨（⌘Z 可撤销）"
              className="flex shrink-0 items-center gap-0.5 text-[9.5px] leading-none text-accent/90"
            >
              <AudioLines size={9} className="animate-pulse" />
              <span className="whitespace-nowrap">渲染中…</span>
            </span>
          )}
          <div className="flex shrink-0 items-center gap-0.5">
            {showPreviewButton && (
              <button
                onClick={(event) => {
                  event.stopPropagation()
                  preview()
                }}
                title="试听音色"
                aria-label="试听音色"
                className={cn(
                  'flex h-[16px] w-[16px] items-center justify-center rounded-[4px] text-ink-3/80 transition-colors hover:bg-surface-3 hover:text-accent',
                  previewing && 'animate-pulse text-accent',
                )}
              >
                <Play size={9} />
              </button>
            )}
            {!collapsed && (
              <button
                onClick={(event) => {
                  event.stopPropagation()
                  setInfoAnchor(event.currentTarget.getBoundingClientRect())
                }}
                title="创作信息：风格 / 调式 / BPM / 段落 / 乐器 / 智能片段参数"
                aria-label={`查看 ${track.name} 的创作信息`}
                data-creative-info-trigger
                className="flex h-[16px] w-[16px] items-center justify-center rounded-[4px] text-ink-3/80 transition-colors hover:bg-surface-3 hover:text-accent"
              >
                <Info size={9} />
              </button>
            )}
            <button
              onClick={toggleCollapse}
              title={collapsed ? '展开轨道' : '折叠轨道'}
              aria-label={collapsed ? `展开轨道 ${track.name}` : `折叠轨道 ${track.name}`}
              aria-expanded={!collapsed}
              className="flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[4px] text-ink-3/80 transition-colors hover:bg-surface-3 hover:text-ink-2"
            >
              {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
            </button>
          </div>
        </div>

        {/* 第二行：乐器 / 情绪 / 音量 / 声像（行高不足时自动隐藏） */}
        {showSecondRow && (
          <div className="flex min-w-0 items-center gap-1.5">
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
                className={cn(
                  'flex h-[17px] shrink-0 items-center gap-1 rounded-full border border-line-strong/80 bg-surface-2 text-[10px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink',
                  narrow ? 'px-1' : 'px-1.5',
                )}
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: emotion.color }} />
                {!narrow && <span className="max-w-[54px] shrink-0 truncate whitespace-nowrap text-[10px]">{emotion.name}</span>}
              </button>
            )}

            <div className="ml-auto flex shrink-0 items-center gap-1">
              <MiniHSlider
                value={track.volume}
                min={0}
                max={1.5}
                width={panelWidth >= 320 ? 38 : 30}
                title="音量"
                onGestureStart={() => beginGainGesture('volume')}
                onChange={changeVolume}
                formatValue={(value) => `${Math.round(value * 100)}%`}
                fillColor={`linear-gradient(90deg, ${withAlpha(color, 0.35)}, ${color})`}
              />
              <MiniKnob
                value={track.pan}
                size={15}
                title="声像"
                accent="#3ddbd9"
                onGestureStart={() => beginGainGesture('pan')}
                onChange={changePan}
                formatValue={(value) =>
                  Math.abs(value) < 0.03 ? 'C' : `${value < 0 ? 'L' : 'R'}${Math.round(Math.abs(value) * 100)}`
                }
              />
            </div>
          </div>
        )}

        {/* 第三行：只属于这条轨道的创作信息（段落 / 智能片段）；armed+静音警告优先占这一行 */}
        {showCreativeLine && !armedButMuted && (
          <div
            className="flex min-w-0 items-center gap-1 overflow-hidden text-[9.5px] leading-none text-ink-4"
            title={creative.detailTitle}
            data-creative-line
          >
            <span className="h-[3px] w-[3px] shrink-0 rounded-full" style={{ background: withAlpha(color, 0.5) }} />
            <span className="min-w-0 truncate">{creative.trackSummary}</span>
          </div>
        )}

        {/* armed + 静音/被压下 = 「录得进去但听不见」。这是 DAW 里最经典的自我怀疑来源，
            必须显式说出来，而不是让用户对着一个红点猜 */}
        {armedButMuted && height >= 58 && (
          <div
            className="flex min-w-0 items-center gap-1 overflow-hidden text-[9.5px] leading-none text-danger/85"
            data-armed-muted-warning
            title={warnTitle}
          >
            <span className="shrink-0">⚠</span>
            <span className="min-w-0 truncate">{muted ? '已预备但静音 · 录进去也听不到' : '已预备但被独奏压住'}</span>
          </div>
        )}
      </div>

      {/* 右侧竖排控制轨：R / M / S（Cubase / Logic 范式，把横向空间留给名称） */}
      {showRail && (
        <div className="flex w-[22px] shrink-0 flex-col items-center justify-center gap-[2px]" data-track-rail>
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
              'flex w-[18px] items-center justify-center rounded-[4px] border transition-colors',
              compactRail ? 'h-[12px]' : 'h-[14px]',
              armed
                ? 'animate-[pulse-dot_1.4s_ease-in-out_infinite] border-danger/70 bg-danger/30 text-danger'
                : 'border-line-strong bg-surface-2 text-ink-4 hover:text-danger',
            )}
          >
            <span className="text-[9px] font-bold leading-none">R</span>
          </button>
          <button
            onClick={applyMute}
            title={
              multiSelected
                ? muted
                  ? `取消静音（M）· 将同时作用于已选 ${selectionIds.length} 条轨道`
                  : `静音（M）· 将同时作用于已选 ${selectionIds.length} 条轨道`
                : muted
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
              'relative flex w-[18px] items-center justify-center rounded-[4px] border text-[9px] font-bold leading-none transition-colors',
              compactRail ? 'h-[12px]' : 'h-[14px]',
              muted
                ? 'border-danger/60 bg-danger/25 text-danger'
                : suppressed
                  ? /* 隐式静音：描边点亮但不填色 —— 明确区分「被 solo 压住」与「用户真的静音了」 */
                    'border-danger/35 bg-surface-2 text-danger/55'
                  : 'border-line-strong bg-surface-2 text-ink-4 hover:text-ink-2',
            )}
          >
            <span className="text-[9px] font-bold leading-none">M</span>
          </button>
          <button
            onClick={applySolo}
            title={
              multiSelected
                ? track.solo
                  ? `取消独奏（S）· 将同时作用于已选 ${selectionIds.length} 条轨道 · Alt/Option 点击 = 只保留这条`
                  : `独奏（S）· 将同时作用于已选 ${selectionIds.length} 条轨道 · Alt/Option 点击 = 只保留这条`
                : track.solo
                  ? '取消独奏（S）· 按住 Alt/Option 点击 = 只保留这条独奏'
                  : '独奏（S）· 再点其它轨可多条同时独奏 · 按住 Alt/Option 点击 = 独占独奏'
            }
            aria-label={track.solo ? `取消独奏 ${track.name}` : `独奏 ${track.name}`}
            aria-pressed={Boolean(track.solo)}
            data-track-solo={track.solo ? 'true' : 'false'}
            className={cn(
              'flex w-[18px] items-center justify-center rounded-[4px] border text-[9px] font-bold leading-none transition-colors',
              compactRail ? 'h-[12px]' : 'h-[14px]',
              track.solo
                ? 'border-accent/60 bg-accent/25 text-accent'
                : muted
                  ? /* 已静音的轨：S 能点亮但不会出声，视觉上给一点提示 */
                    'border-line-strong bg-surface-2 text-ink-4/70 hover:text-accent'
                  : 'border-line-strong bg-surface-2 text-ink-4 hover:text-ink-2',
            )}
          >
            <span className="text-[9px] font-bold leading-none">S</span>
          </button>
        </div>
      )}

      {/* 折叠行放不下竖排控制轨时，用极小的 ⚠ 提醒「已预备但听不见」 */}
      {armedButMuted && height < 58 && (
        <span
          data-armed-muted-warning
          title={warnTitle}
          className="absolute right-[26px] top-[3px] z-[5] text-[10px] leading-none text-danger"
        >
          ⚠
        </span>
      )}

      {/* 迷你电平指示：由 TrackPanel 的单条 rAF 用 engine.getTrackLevels() 实时驱动。
          `data-mix-state` 让界面 / 自动化都能一眼看出这条轨是「静音」还是「被独奏压住」 */}
      <div
        data-activity-meter
        data-level="0.00"
        data-armed={armed ? 'true' : 'false'}
        data-mix-state={audibility}
        data-activity-label={`电平 ${track.name}${muted ? '（已静音）' : suppressed ? '（被独奏压住）' : ''}`}
        role="img"
        className={cn(
          'pointer-events-none absolute bottom-[5px] top-[4px] w-[3px] overflow-hidden rounded-full bg-white/[0.06]',
          showRail ? 'right-[23px]' : 'right-[2px]',
        )}
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

      {/* 右键菜单 / 颜色弹层 / 创作信息 */}
      {menu && (
        <TrackContextMenu
          x={menu.x}
          y={menu.y}
          track={track}
          index={index}
          height={height}
          hasCustomHeight={hasCustomHeight}
          selectionIds={selectionIds.includes(track.id) ? selectionIds : [track.id]}
          onPreview={preview}
          onBounce={bounce}
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
          onPick={pickColor}
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
