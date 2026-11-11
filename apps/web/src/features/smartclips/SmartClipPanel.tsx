/**
 * 智能片段工作台。
 *
 * 左：当前轨道片段列表 + 9 类智能片段生成入口
 * 中：智能参数（实时重新生成，拖拽时 history:false，松手落一次历史）
 * 右：缩略图预览 + 变奏 + 试听 + 和弦上下文
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AudioLines,
  ChevronRight,
  CircleDot,
  Copy,
  FlipHorizontal2,
  Lightbulb,
  LoaderCircle,
  Music4,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  Wand2,
} from 'lucide-react'
import {
  CHORDS,
  chordLabel,
  getInstrument,
  patternOptions,
  SMART_KIND_META,
  SMART_KINDS,
  type ChordQualityId,
  type ChordSpec,
  type Clip,
  type Project,
  type SmartKind,
  type SmartParams,
  type Track,
} from '@aiab/core'
import { getAudioEngine } from '../../audio'
import { EmptyState, Select, Slider, Switch } from '../../components/ui'
import { ApiError, completeProgression, suggestProgressions, type CompleteProgressionResult, type ProgressionSuggestion } from '../../lib/api'
import { cn } from '../../lib/format'
import { keyScaleLabel, resolveProjectStyle, styleLabel } from '../../lib/studioMeta'
import { useStore } from '../../store/store'
import { clamp, drawNotesThumbnail, tidy, trackColor } from '../arrangement/timeline'

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

function hexSeed(seed: number): string {
  return (seed >>> 0).toString(16).toUpperCase().padStart(8, '0')
}

/** 后端返回的 quality 是字符串：非法/未知时退回大三和弦，避免 chordLabel 崩溃 */
function normalizeChordQuality(quality: string): ChordQualityId {
  return (quality in CHORDS ? quality : 'maj') as ChordQualityId
}

/** 把接口返回的 {root,quality,beats} 规整成可直接写进 project.chords 的 ChordSpec */
function toChordSpecs(chords: { root: number; quality: string; beats: number }[]): ChordSpec[] {
  return chords
    .filter((chord) => Number.isFinite(chord.root))
    .map((chord) => ({
      root: ((Math.round(chord.root) % 12) + 12) % 12,
      quality: normalizeChordQuality(chord.quality),
      beats: Number.isFinite(chord.beats) && chord.beats >= 0.25 ? chord.beats : 4,
    }))
}

/* ------------------------------------------------------------------ */
/* 参数预设 / A-B 快照                                                  */
/* ------------------------------------------------------------------ */

interface ParamPreset {
  id: string
  name: string
  hint: string
  params: Partial<SmartParams>
}

/** 三种常用手感：紧凑（律动型）/ 舒展（氛围型）/ 高级（主奏型） */
const PARAM_PRESETS: ParamPreset[] = [
  {
    id: 'compact',
    name: '紧凑',
    hint: '更密、更短促的律动，适合鼓、低音、琶音',
    params: { density: 0.78, complexity: 0.62, energy: 0.72, gate: 0.55, humanize: 0.14, swing: 0.04 },
  },
  {
    id: 'spacious',
    name: '舒展',
    hint: '更疏、更长音，适合铺底、氛围与慢歌',
    params: { density: 0.34, complexity: 0.4, energy: 0.5, gate: 1.18, humanize: 0.3, swing: 0.1 },
  },
  {
    id: 'advanced',
    name: '高级',
    hint: '更多变化与摇摆，适合主奏、对位',
    params: { density: 0.58, complexity: 0.84, energy: 0.66, gate: 0.88, humanize: 0.26, swing: 0.22 },
  },
]

/** 复制文本：优先 Clipboard API，失败时退回临时 textarea（无权限的浏览器也能复制） */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 退回到 execCommand */
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

/** A/B 对比用的快照：保存 seed 与完整参数，切换时原样还原 */
interface ParamSnapshot {
  seed: number
  params: SmartParams
  bars: number
}

/* ------------------------------------------------------------------ */
/* 参数滑块                                                            */
/* ------------------------------------------------------------------ */

function ParamSlider({
  label,
  hint,
  value,
  min,
  max,
  step,
  display,
  onGestureStart,
  onChange,
  onCommit,
}: {
  label: string
  hint?: string
  value: number
  min: number
  max: number
  step: number
  display: string
  onGestureStart: () => void
  onChange: (value: number) => void
  onCommit: () => void
}) {
  return (
    <div
      className="rounded-lg border border-line bg-surface-2/50 px-2.5 py-2 transition-colors hover:border-line-strong"
      onPointerDownCapture={onGestureStart}
      title={hint}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[11.5px] text-ink-2">{label}</span>
        <span className="mono text-[11px] tabular-nums text-accent-soft">{display}</span>
      </div>
      <Slider
        ariaLabel={label}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={onChange}
        onCommit={onCommit}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 类型选择（9 类智能片段）                                             */
/* ------------------------------------------------------------------ */

function KindGrid({
  activeKind,
  compact,
  onPick,
}: {
  activeKind?: SmartKind
  compact?: boolean
  onPick: (kind: SmartKind) => void
}) {
  return (
    <div className="grid grid-cols-3 gap-1">
      {SMART_KINDS.map((kind) => {
        const meta = SMART_KIND_META[kind]
        const active = kind === activeKind
        return (
          <button
            key={kind}
            onClick={() => onPick(kind)}
            title={`${meta.name} · ${meta.hint}`}
            className={cn(
              'flex flex-col items-center justify-center gap-0.5 rounded-lg border py-1.5 transition-all',
              compact ? 'h-[46px]' : 'h-[50px]',
              active
                ? 'border-accent/60 bg-accent/12 text-accent-soft'
                : 'border-line bg-surface-2/60 text-ink-2 hover:border-line-strong hover:bg-surface-3 hover:text-ink',
            )}
          >
            <span className="text-[14px] leading-none">{meta.icon}</span>
            <span className="text-[10px] font-medium leading-none">{meta.name}</span>
          </button>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 播放头 / 小节输入                                                    */
/* ------------------------------------------------------------------ */

function BarCountPicker({ value, onChange, showUnit = true }: { value: number; onChange: (value: number) => void; showUnit?: boolean }) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-line bg-bg-soft p-0.5">
      {[1, 2, 4, 8].map((bars) => (
        <button
          key={bars}
          onClick={() => onChange(bars)}
          className={cn(
            'h-7 min-w-[28px] rounded-[6px] px-1.5 text-[10.5px] transition-colors',
            value === bars ? 'bg-surface-3 text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2',
          )}
          title={`${bars} 小节`}
        >
          {bars}
        </button>
      ))}
      {showUnit && <span className="px-1 text-[10px] text-ink-4">小节</span>}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 预览缩略图                                                          */
/* ------------------------------------------------------------------ */

function PreviewCanvas({ notes, lengthBeats, color, barBeats }: { notes: Clip['notes']; lengthBeats: number; color: string; barBeats: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  // 高度随右侧面板宽度自适应（窄屏更扁，宽屏更高），保持音符有足够辨识度
  const [canvasHeight, setCanvasHeight] = useState(112)
  const notesHash = useMemo(() => {
    let hash = Math.round(lengthBeats * 100) + notes.length * 13
    for (const note of notes) hash += note.pitch * 17 + note.start * 5.3 + note.duration * 2.1
    return hash
  }, [notes, lengthBeats])

  useEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const update = () => {
      const width = element.clientWidth
      if (width <= 0) return
      setCanvasHeight(Math.round(clamp(width * 0.42, 88, 168)))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // 等浏览器把 style 高度应用后再按真实 clientHeight 绘制
    const raf = requestAnimationFrame(() => {
      drawNotesThumbnail(canvas, notes, lengthBeats, color, { barBeats, padY: 6, maxNoteHeight: 5 })
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesHash, color, barBeats, canvasHeight])

  return (
    <div ref={wrapRef} className="w-full">
      <canvas
        ref={canvasRef}
        aria-label="智能片段预览"
        className="block w-full rounded-lg border border-line bg-bg"
        style={{ height: canvasHeight }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 主体                                                                */
/* ------------------------------------------------------------------ */

export function SmartClipPanel() {
  const project = useStore((s) => s.project)
  const selectedTrackId = useStore((s) => s.selectedTrackId)
  const target = useStore((s) => s.smartClipTarget)
  const selectionClipId = useStore((s) => s.selection.clipId)
  const selectTrack = useStore((s) => s.selectTrack)
  const selectClip = useStore((s) => s.selectClip)
  const createSmartClip = useStore((s) => s.createSmartClip)
  const updateSmartParams = useStore((s) => s.updateSmartParams)
  const updateClip = useStore((s) => s.updateClip)
  const regenerateSmartClip = useStore((s) => s.regenerateSmartClip)
  const setSmartClipTarget = useStore((s) => s.setSmartClipTarget)
  const pushToast = useStore((s) => s.pushToast)

  /* 和弦进行灵感：点击「换一组进行」才请求，失败只提示、不影响现有工程 */
  const [progressionIdeas, setProgressionIdeas] = useState<ProgressionSuggestion[]>([])
  const [suggestingProgressions, setSuggestingProgressions] = useState(false)
  const [progressionError, setProgressionError] = useState<string | null>(null)
  /* P7-C：补全不完整进行 */
  const [partialRoman, setPartialRoman] = useState('I V vi')
  const [completeLength, setCompleteLength] = useState(8)
  const [completing, setCompleting] = useState(false)
  const [completion, setCompletion] = useState<CompleteProgressionResult | null>(null)
  const [completionError, setCompletionError] = useState<string | null>(null)

  const suggestedStyle = resolveProjectStyle(project)
  const suggestedStyleName = styleLabel(suggestedStyle) ?? '流行'

  const barBeats = (project.timeSignature.numerator * 4) / project.timeSignature.denominator
  const [newBars, setNewBars] = useState(4)
  const [convertKind, setConvertKind] = useState<SmartKind>('melody')
  const [presetId, setPresetId] = useState<string | null>(null)
  const [slots, setSlots] = useState<{ A: ParamSnapshot | null; B: ParamSnapshot | null }>({ A: null, B: null })
  const [activeSlot, setActiveSlot] = useState<'A' | 'B' | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [panelWidth, setPanelWidth] = useState(0)

  /* 三栏在窄宽度会互相挤压：≥780 保持三栏，更窄时右栏移到参数下方，参数改单列 */
  const threeColumns = panelWidth >= 780
  /* 参数区分单列的依据是「参数列自身宽度」，而不是整个面板宽度：
     两栏回退布局下左栏固定 190px，若按面板宽度判断会把 8 个参数全部堆成单列（信息密度骤降、需要长滚动）。 */
  const paramsColumnWidth = threeColumns ? panelWidth - 492 : panelWidth - 220
  const singleColumnParams = panelWidth > 0 && paramsColumnWidth < 300

  useEffect(() => {
    const element = rootRef.current
    if (!element) return
    const update = () => setPanelWidth(element.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const selectedTrack = project.tracks.find((track) => track.id === selectedTrackId) ?? project.tracks[0] ?? null

  /* 当前工作片段：优先智能片段目标，其次全局选中片段 */
  const activeInfo = useMemo(() => {
    const preferred = target?.clipId ?? selectionClipId
    if (!preferred) return null
    const found = findClipById(project, preferred)
    if (found) return found
    if (target?.clipId && selectionClipId) return findClipById(project, selectionClipId)
    return null
  }, [project, target?.clipId, selectionClipId])

  const activeTrack = activeInfo?.track ?? selectedTrack
  const activeClip = activeInfo?.clip ?? null
  const smart = activeClip?.smart ?? null
  const activeColor = trackColor(activeTrack?.color)

  /* 切换片段时清空 A/B 快照与预设高亮，避免把快照套到别的片段上 */
  useEffect(() => {
    setSlots({ A: null, B: null })
    setActiveSlot(null)
    setPresetId(null)
  }, [activeClip?.id])

  /* 新建智能片段 */
  const createFromKind = (kind: SmartKind) => {
    const track = activeTrack ?? selectedTrack
    if (!track) {
      pushToast('info', '请先在左侧选择一条轨道')
      return
    }
    const startBeat = tidy(Math.floor(useStore.getState().playhead / barBeats) * barBeats)
    const id = createSmartClip(track.id, kind, { bars: newBars }, startBeat)
    if (!id) {
      pushToast('error', '生成失败，请检查轨道与调性设置')
      return
    }
    selectClip(track.id, id)
    setSmartClipTarget({ trackId: track.id, clipId: id })
    pushToast('success', `已生成${SMART_KIND_META[kind].name}片段`)
  }

  /* 把当前片段转为智能片段（在同轨道同位置新建） */
  const convertToSmart = () => {
    if (!activeClip || !activeTrack) return
    const bars = Math.max(1, Math.round(activeClip.lengthBeats / barBeats))
    const id = createSmartClip(activeTrack.id, convertKind, { bars }, activeClip.startBeat)
    if (!id) {
      pushToast('error', '生成失败')
      return
    }
    selectClip(activeTrack.id, id)
    setSmartClipTarget({ trackId: activeTrack.id, clipId: id })
    pushToast('success', `已在同位置生成${SMART_KIND_META[convertKind].name}智能片段`)
  }

  /* 参数写入（拖拽期间不记历史；由 ParamSlider 的 pointerdown 记录一次） */
  const beginGesture = () => {
    const store = useStore.getState()
    store.pushHistory()
    store.setSaveStatus('dirty')
  }
  const commitGesture = () => {
    useStore.getState().setSaveStatus('dirty')
  }
  const applyParam = (patch: Parameters<typeof updateSmartParams>[2]) => {
    if (!activeTrack || !activeClip) return
    setActiveSlot(null)
    updateSmartParams(activeTrack.id, activeClip.id, patch, { history: false })
  }
  /** 单次点击类修改（下拉、开关）：直接记一条历史，可撤销 */
  const applyParamOnce = (patch: Parameters<typeof updateSmartParams>[2]) => {
    if (!activeTrack || !activeClip) return
    setActiveSlot(null)
    updateSmartParams(activeTrack.id, activeClip.id, patch)
  }

  /* 小节数：同时调整片段长度，再按新长度重新生成 */
  const applyBars = (bars: number) => {
    if (!activeTrack || !activeClip) return
    const store = useStore.getState()
    setActiveSlot(null)
    updateClip(activeTrack.id, activeClip.id, { lengthBeats: tidy(bars * barBeats) }, { history: false })
    updateSmartParams(activeTrack.id, activeClip.id, { bars }, { history: false })
    store.setSaveStatus('dirty')
  }

  /* ---------------- 参数预设 ---------------- */
  const applyPreset = (preset: ParamPreset) => {
    if (!activeTrack || !activeClip || !smart) {
      pushToast('info', '先选中一个智能片段，再套用参数预设')
      return
    }
    applyParamOnce(preset.params)
    setPresetId(preset.id)
    pushToast('success', `已应用「${preset.name}」预设`)
  }

  /* ---------------- A/B 快照对比 ---------------- */
  const snapshotCurrent = (): ParamSnapshot | null => {
    if (!activeClip?.smart) return null
    return {
      seed: activeClip.smart.seed,
      params: { ...activeClip.smart.params },
      bars: Math.max(1, Math.round(activeClip.lengthBeats / barBeats)),
    }
  }

  const saveSlot = (slot: 'A' | 'B') => {
    const snapshot = snapshotCurrent()
    if (!snapshot) {
      pushToast('info', '只有智能片段可以保存 A/B 快照')
      return
    }
    setSlots((previous) => ({ ...previous, [slot]: snapshot }))
    setActiveSlot(slot)
    pushToast('success', `已保存 ${slot} 快照 · seed ${hexSeed(snapshot.seed)}`)
  }

  const applySlot = (slot: 'A' | 'B') => {
    const snapshot = slots[slot]
    if (!snapshot || !activeTrack || !activeClip) return
    const store = useStore.getState()
    // 一次手势 = 一条撤销记录：先快照，再静默写入 seed / 长度 / 参数
    store.pushHistory()
    const nextLength = tidy(snapshot.bars * barBeats)
    if (Math.abs(activeClip.lengthBeats - nextLength) > 1e-6) {
      updateClip(activeTrack.id, activeClip.id, { lengthBeats: nextLength }, { history: false })
    }
    store.mutate(
      (draft) => {
        const found = findClipById(draft, activeClip.id)
        if (found?.clip.smart) found.clip.smart.seed = snapshot.seed
      },
      { history: false },
    )
    updateSmartParams(activeTrack.id, activeClip.id, snapshot.params, { history: false })
    store.setSaveStatus('dirty')
    setActiveSlot(slot)
    pushToast('success', `已切到 ${slot} 快照`)
  }

  const copySeed = async () => {
    if (!smart) return
    const text = hexSeed(smart.seed)
    const copied = await writeClipboard(text)
    if (copied) pushToast('success', `已复制 seed ${text}`)
    else pushToast('info', `seed：${text}（浏览器未允许写剪贴板）`)
  }

  /* 换一个变奏：只换种子，不动参数 */
  const regenerateVariant = () => {
    if (!activeTrack || !activeClip) return
    regenerateSmartClip(activeTrack.id, activeClip.id, 1)
    setActiveSlot(null)
    pushToast('success', '已换一个变奏')
  }

  /* 用当前类型 / 参数在播放头所在小节生成一个新片段 */
  const createAtPlayhead = () => {
    const track = activeTrack ?? selectedTrack
    if (!track) {
      pushToast('info', '请先在左侧选择一条轨道')
      return
    }
    const kind = smart?.kind ?? convertKind
    const params: Partial<SmartParams> = smart ? { ...smart.params } : { bars: newBars }
    const startBeat = tidy(Math.floor(useStore.getState().playhead / barBeats) * barBeats)
    const id = createSmartClip(track.id, kind, { ...params, bars: params.bars ?? newBars }, startBeat)
    if (!id) {
      pushToast('error', '生成失败，请检查轨道与调性设置')
      return
    }
    selectClip(track.id, id)
    setSmartClipTarget({ trackId: track.id, clipId: id })
    setSlots({ A: null, B: null })
    setActiveSlot(null)
    setPresetId(null)
    pushToast('success', `已在播放头生成${SMART_KIND_META[kind].name}片段`)
  }

  /* ---------------- 和弦进行灵感 ---------------- */
  const fetchProgressionIdeas = async () => {
    if (suggestingProgressions) return
    setSuggestingProgressions(true)
    setProgressionError(null)
    try {
      const result = await suggestProgressions({
        style: resolveProjectStyle(project) ?? 'pop',
        key: project.key,
        scale: project.scale,
        count: 5,
        seed: Math.floor(Math.random() * 1_000_000),
      })
      const ideas = (result?.suggestions ?? []).filter(
        (idea) => Array.isArray(idea.roman) && Array.isArray(idea.chords) && idea.chords.length > 0,
      )
      setProgressionIdeas(ideas)
      if (ideas.length === 0) setProgressionError('没有可用的进行建议，稍后再试')
      else pushToast('success', `已换一组和弦进行灵感（${ideas.length} 条）`)
    } catch (error) {
      setProgressionIdeas([])
      const unavailable = error instanceof ApiError ? error.status === 404 || error.status === 405 : true
      setProgressionError(
        unavailable
          ? '和弦建议接口未就绪（404），后端更新后可换一组进行'
          : error instanceof Error
            ? error.message
            : '获取和弦进行失败',
      )
    } finally {
      setSuggestingProgressions(false)
    }
  }

  /** P7-C：把用户给的半截进行补全成完整进行（服务端可解释算法） */
  const fetchCompletion = async () => {
    if (completing) return
    const partial = partialRoman
      .split(/[\s,，·]+/)
      .map((token) => token.trim())
      .filter(Boolean)
    if (partial.length === 0) {
      setCompletionError('先写至少一个和弦（罗马数字，例如 I V vi IV）')
      return
    }
    setCompleting(true)
    setCompletionError(null)
    try {
      const result = await completeProgression({
        partial,
        key: project.key,
        scale: project.scale,
        style: resolveProjectStyle(project) ?? 'pop',
        targetLength: completeLength,
      })
      setCompletion(result)
      if (result.completion.length === 0) setCompletionError(result.reasons[0] ?? '已经达到目标长度，无需补全')
    } catch (error) {
      setCompletion(null)
      setCompletionError(
        error instanceof ApiError
          ? error.detail || error.message
          : error instanceof Error
            ? error.message
            : '补全进行失败',
      )
    } finally {
      setCompleting(false)
    }
  }

  /** 把补全结果写进工程和弦（一次撤销；跟随和弦的智能片段自动重算） */
  const applyCompletion = (result: CompleteProgressionResult) => {
    const chords = toChordSpecs(result.chords)
    if (chords.length === 0) {
      pushToast('error', '补全结果没有可用和弦')
      return
    }
    const store = useStore.getState()
    const followers: { trackId: string; clipId: string }[] = []
    for (const track of store.project.tracks) {
      for (const clip of track.clips) {
        if (clip.smart?.params.followChords) followers.push({ trackId: track.id, clipId: clip.id })
      }
    }
    store.setChords(chords)
    for (const target of followers) {
      store.updateSmartParams(target.trackId, target.clipId, {}, { history: false })
    }
    store.setSaveStatus('dirty')
    pushToast(
      'success',
      `已写入补全后的 ${result.full.length} 个和弦（${result.cadence}）${followers.length > 0 ? ` · ${followers.length} 个智能片段已跟随` : ''}（可撤销）`,
    )
  }

  /** 应用一条建议：一次点击 = 一条撤销记录；「跟随工程和弦」的智能片段会按新和声静默重算 */
  const applyProgressionIdea = (idea: ProgressionSuggestion) => {
    const chords = toChordSpecs(idea.chords)
    if (chords.length === 0) {
      pushToast('error', '这条进行没有可用的和弦')
      return
    }
    const store = useStore.getState()
    const followers: { trackId: string; clipId: string }[] = []
    for (const track of store.project.tracks) {
      for (const clip of track.clips) {
        if (clip.smart?.params.followChords) followers.push({ trackId: track.id, clipId: clip.id })
      }
    }
    store.setChords(chords)
    for (const target of followers) {
      store.updateSmartParams(target.trackId, target.clipId, {}, { history: false })
    }
    store.setSaveStatus('dirty')
    pushToast(
      'success',
      `已应用「${idea.label}」到工程和弦${followers.length > 0 ? ` · ${followers.length} 个智能片段已跟随` : ''}（可撤销）`,
    )
  }

  const previewClipAudio = () => {
    if (!activeTrack || !activeClip) return
    try {
      getAudioEngine().previewClip(activeTrack, activeClip)
    } catch (error) {
      console.warn('[smartclips] 试听失败', error)
      pushToast('error', '试听失败：音频引擎未就绪')
    }
  }

  const stopPreview = () => {
    try {
      getAudioEngine().stopPreview()
    } catch {
      /* ignore */
    }
  }

  const trackOptions = project.tracks.map((track) => ({ value: track.id, label: track.name }))

  /* 右栏内容：三栏时作为独立一列，窄屏时移到参数下方（避免互相挤压/裁切） */
  const rightPanels = (
    <>
      <section className="panel-flat rounded-xl p-2.5">
        <div className="mb-2 flex items-center justify-between">
          <span className="label">预览</span>
          {activeClip && (
            <span className="mono text-[10px] text-ink-4">
              {activeClip.notes.length} 音符 · {Math.round(activeClip.lengthBeats / barBeats)} 小节
            </span>
          )}
        </div>
        {activeClip ? (
          <>
            <PreviewCanvas
              notes={activeClip.notes}
              lengthBeats={activeClip.lengthBeats}
              color={activeColor}
              barBeats={barBeats}
            />
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              <button className="btn h-8 px-2 text-[11px]" onClick={previewClipAudio} title="试听片段">
                <Play size={11} />
                试听
              </button>
              <button className="btn h-8 px-2 text-[11px]" onClick={stopPreview} title="停止试听">
                <Square size={10} />
                停止
              </button>
              <button
                className="btn h-8 px-2 text-[11px]"
                onClick={regenerateVariant}
                disabled={!smart}
                title={smart ? '换一个变奏' : '仅智能片段支持变奏'}
              >
                <RefreshCw size={11} />
                变奏
              </button>
              <button
                className="btn h-8 px-2 text-[11px]"
                onClick={() => {
                  if (!activeClip) return
                  useStore.getState().setView('pianoroll')
                }}
                title="在钢琴卷帘中精细编辑"
              >
                <FlipHorizontal2 size={11} />
                卷帘
              </button>
            </div>
            <button
              className="btn btn-accent mt-2 h-8 w-full px-2 text-[11px]"
              onClick={createAtPlayhead}
              title="用当前类型与参数，在播放头所在小节生成一个新片段"
            >
              <Plus size={11} />
              生成到播放头
            </button>
            <div className="mt-2 space-y-1 rounded-lg border border-line bg-surface-2/40 px-2 py-1.5">
              <Row label="轨道" value={activeTrack?.name ?? '—'} />
              <Row
                label="乐器"
                value={activeTrack ? `${getInstrument(activeTrack.instrumentId).icon} ${getInstrument(activeTrack.instrumentId).name}` : '—'}
              />
              {smart && <Row label="种子" value={hexSeed(smart.seed)} mono />}
              {smart && <Row label="调性快照" value={`${smart.key ?? project.key} ${smart.scale ?? project.scale}`} />}
            </div>
          </>
        ) : (
          <div className="flex h-[104px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line text-[10.5px] text-ink-4">
            <AudioLines size={16} />
            选中片段后显示缩略图
          </div>
        )}
      </section>

      <section className="panel-flat rounded-xl p-2.5">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="label">A/B 对比</span>
          <span className="mono text-[10px] text-ink-4">
            {smart ? (activeSlot ? `当前 ${activeSlot}` : '未保存') : '仅智能片段'}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {(['A', 'B'] as const).map((slot) => {
            const snapshot = slots[slot]
            const active = activeSlot === slot
            return (
              <button
                key={`apply-${slot}`}
                type="button"
                className={cn(
                  'flex h-8 items-center justify-center gap-1 rounded-lg border px-2 text-[11px] transition-colors',
                  active
                    ? 'border-accent/60 bg-accent/12 text-accent-soft'
                    : 'border-line bg-surface-2/60 text-ink-2 hover:border-line-strong hover:bg-surface-3 hover:text-ink',
                  !snapshot && 'cursor-not-allowed opacity-45',
                )}
                onClick={() => applySlot(slot)}
                disabled={!snapshot}
                aria-label={`切换到 ${slot} 快照`}
                title={snapshot ? `切到 ${slot}：seed ${hexSeed(snapshot.seed)}` : `${slot} 还没有快照`}
              >
                切到 {slot}
              </button>
            )
          })}
        </div>
        <div className="mt-1 grid grid-cols-2 gap-1.5">
          {(['A', 'B'] as const).map((slot) => (
            <button
              key={`save-${slot}`}
              type="button"
              className="btn h-8 px-2 text-[11px]"
              onClick={() => saveSlot(slot)}
              disabled={!smart}
              aria-label={`保存 ${slot} 快照`}
              title={`把当前 seed 与参数保存到 ${slot}`}
            >
              存到 {slot}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn mt-2 h-8 w-full px-2 text-[11px]"
          onClick={() => void copySeed()}
          disabled={!smart}
          aria-label="复制 seed"
          title="复制当前 seed，便于记录或分享这个版本"
        >
          <Copy size={11} />
          复制 seed
        </button>
        <p className="mt-2 text-[10px] leading-relaxed text-ink-4">
          先把满意的版本存到 A，调参后再存 B；点「切到 A / B」即可原样还原 seed 与全部参数，方便对比。
        </p>
      </section>

      <section className="panel-flat rounded-xl p-2.5">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-1">
          <span className="label shrink-0">和弦进行</span>
          <button
            type="button"
            className="btn h-6 shrink-0 gap-1 px-2 text-[10px]"
            onClick={() => void fetchProgressionIdeas()}
            disabled={suggestingProgressions}
            data-suggest-progressions
            title={`按工程风格「${suggestedStyleName}」给出 5 条和弦进行建议（当前调性 ${project.key} ${project.scale}）`}
          >
            {suggestingProgressions ? <LoaderCircle size={9} className="animate-spin" /> : <RefreshCw size={9} />}
            换一组进行
          </button>
        </div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="mono shrink-0 text-[10px] text-ink-4">{project.chords.length} 个和弦</span>
          <span className="min-w-0 truncate text-[9.5px] text-ink-4">
            {suggestedStyleName} · {keyScaleLabel(project.key, project.scale)}
          </span>
        </div>
        {project.chords.length === 0 ? (
          <p className="text-[10.5px] leading-relaxed text-ink-4">
            工程还没有和弦进行。点上方「换一组进行」拿几条灵感，或在 AI 助手里说「配一套和弦」。
          </p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {project.chords.slice(0, 24).map((chord, index) => (
              <span
                key={`${chord.root}-${chord.quality}-${index}`}
                className="rounded border border-line bg-surface-2/60 px-1.5 py-0.5 font-mono text-[10px] text-cyan/80"
                title={`${chord.beats} 拍`}
              >
                {chordLabel(chord)}
              </span>
            ))}
          </div>
        )}
        {progressionError && (
          <p className="mt-1.5 rounded border border-danger/30 bg-danger/8 px-1.5 py-1 text-[9.5px] leading-relaxed text-danger">
            {progressionError}
          </p>
        )}
        {progressionIdeas.length > 0 && (
          <div className="mt-1.5 border-t border-line pt-1.5">
            <div className="mb-1 flex items-center gap-1 text-[10px] text-ink-4">
              <Lightbulb size={10} className="shrink-0 text-accent/70" />
              灵感建议 · 点击应用到工程和弦
            </div>
            <div className="space-y-1">
              {progressionIdeas.map((idea) => (
                <button
                  key={idea.id}
                  type="button"
                  onClick={() => applyProgressionIdea(idea)}
                  data-progression-id={idea.id}
                  title={`${idea.description}${idea.patternHint ? `\n配器提示：${idea.patternHint}` : ''}`}
                  className="block w-full rounded-lg border border-line bg-surface-2/50 px-1.5 py-1 text-left transition-colors hover:border-accent/45 hover:bg-surface-3"
                >
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium text-ink-2">{idea.label}</span>
                    <span className="mono shrink-0 text-[9.5px] text-accent-soft">{idea.roman.join(' · ')}</span>
                  </span>
                  <span className="mono mt-0.5 block truncate text-[9.5px] text-cyan/80">
                    {toChordSpecs(idea.chords)
                      .map((chord) => chordLabel(chord))
                      .join(' · ')}
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[9.5px] leading-snug text-ink-4">{idea.description}</span>
                </button>
              ))}
            </div>
            <p className="mt-1 text-[9.5px] leading-relaxed text-ink-4">应用后会自动重算「跟随工程和弦」的智能片段，⌘Z 可撤销。</p>
          </div>
        )}

        {/* P7-C：补全不完整进行 */}
        <div className="mt-1.5 border-t border-line pt-1.5" data-complete-progression-block>
          <div className="mb-1 flex items-center gap-1 text-[10px] text-ink-4">
            <Wand2 size={10} className="shrink-0 text-accent/70" />
            补全进行 · 给半截和声，AI 接后半段
          </div>
          {/* 窄列（右栏 248px）时自动换行：输入框不再被压到 120px 以下，select 也不再只有 56px */}
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              value={partialRoman}
              onChange={(event) => setPartialRoman(event.target.value)}
              placeholder="I V vi"
              aria-label="部分和弦进行（罗马数字）"
              data-complete-partial
              className="field h-7 min-w-[120px] flex-1 text-[11px]"
            />
            <select
              value={String(completeLength)}
              onChange={(event) => setCompleteLength(Number(event.target.value))}
              aria-label="补全目标长度"
              data-complete-length
              className="field h-7 w-[88px] shrink-0 text-[11px]"
              title="补全后的总和弦数"
            >
              <option value="4">4 个</option>
              <option value="8">8 个</option>
              <option value="16">16 个</option>
            </select>
            <button
              type="button"
              data-complete-progression
              onClick={() => void fetchCompletion()}
              disabled={completing}
              className="btn h-7 shrink-0 px-2.5 text-[10.5px]"
              title={`按当前调性 ${project.key} ${project.scale} 与风格补全`}
            >
              {completing ? <LoaderCircle size={10} className="animate-spin" /> : '补全'}
            </button>
          </div>
          {completionError && <p className="mt-1 text-[9.5px] leading-relaxed text-danger">{completionError}</p>}
          {completion && (
            <div data-complete-result className="mt-1 rounded border border-line bg-surface-2/50 px-1.5 py-1">
              <div className="mono break-all text-[10px] text-cyan/85">{completion.full.join(' · ')}</div>
              <div className="mt-0.5 text-[9.5px] leading-relaxed text-ink-4">
                {completion.cadence} · {completion.reasons.slice(0, 2).join('；')}
              </div>
              <div className="mt-1 flex items-center gap-1">
                <button
                  type="button"
                  data-complete-apply
                  onClick={() => applyCompletion(completion)}
                  className="btn btn-secondary h-6 px-2 text-[10px]"
                >
                  写入工程和弦
                </button>
                <span className="text-[9.5px] text-ink-4">补全 {completion.completion.length} 个 · 总 {completion.full.length} 个</span>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="panel-flat rounded-xl p-2.5">
        <div className="mb-1.5 flex items-center gap-1.5">
          <Plus size={11} className="text-ink-3" />
          <span className="label">小贴士</span>
        </div>
        <ul className="space-y-1 text-[10px] leading-relaxed text-ink-4">
          <li>· 智能片段生成后是普通片段，可以在编曲视图拖到别的小节。</li>
          <li>· 想保留 A 段、换一个 B 段？先复制片段，再对新片段点「变奏」。</li>
          <li>· 密度与能量同时拉高会得到更饱满的律动。</li>
        </ul>
      </section>
    </>
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-soft">
      {/* 顶部标题 */}
      <div className="flex h-[38px] shrink-0 items-center gap-2 border-b border-line px-3">
        <Sparkles size={13} className="shrink-0 text-accent" />
        <span className="shrink-0 text-[12.5px] font-semibold">智能片段工作台</span>
        {panelWidth >= 900 && (
          <span className="truncate text-[11px] text-ink-4">9 类生成器 · 参数实时重算 · 变奏不会覆盖原创意</span>
        )}
        <div className="flex-1" />
        {project.tracks.length > 0 && (
          <div className="flex shrink-0 items-center gap-1.5">
            {panelWidth >= 760 && <span className="text-[10.5px] text-ink-4">当前轨道</span>}
            <Select
              ariaLabel="当前轨道"
              value={selectedTrack?.id ?? ''}
              onChange={(value) => {
                selectTrack(value)
                setSmartClipTarget(null)
              }}
              className={cn('h-8 text-[11.5px]', panelWidth >= 760 ? 'w-[140px]' : 'w-[118px]')}
              options={trackOptions}
            />
          </div>
        )}
      </div>

      <div
        ref={rootRef}
        className={cn(
          'min-h-0 flex-1 gap-2.5 p-2.5',
          threeColumns ? 'flex overflow-hidden' : 'flex flex-col overflow-y-auto',
        )}
      >
        <div className={cn('flex min-h-0 gap-2.5', threeColumns ? 'flex-1' : 'h-[430px] shrink-0')}>
        {/* 左：片段列表 + 新建 */}
        <aside className={cn('flex shrink-0 flex-col gap-2 overflow-hidden', threeColumns ? 'w-[204px]' : 'w-[190px]')}>
          <section className="panel-flat flex flex-col rounded-xl p-2">
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-1">
              <span className="label shrink-0 whitespace-nowrap">新建片段</span>
              <BarCountPicker value={newBars} onChange={setNewBars} showUnit={panelWidth >= 900} />
            </div>
            <KindGrid onPick={createFromKind} compact />
            <p className="mt-2 text-[10px] leading-relaxed text-ink-4">
              点类型立即生成并选中；从播放头所在小节开始，长度 {newBars} 小节。
            </p>
          </section>

          <section className="panel-flat flex min-h-0 flex-1 flex-col rounded-xl">
            <div className="flex shrink-0 items-center justify-between border-b border-line px-2.5 py-1.5">
              <span className="label">轨道片段</span>
              <span className="mono text-[10px] text-ink-4">{activeTrack?.clips.length ?? 0}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {!activeTrack && <div className="px-2 py-6 text-center text-[11px] text-ink-4">还没有轨道</div>}
              {activeTrack && activeTrack.clips.length === 0 && (
                <div className="px-2 py-6 text-center text-[11px] leading-relaxed text-ink-4">
                  这条轨道还没有片段
                  <br />
                  点上方类型即可生成
                </div>
              )}
              {activeTrack?.clips.map((clip) => {
                const isActive = clip.id === activeClip?.id
                const meta = clip.smart ? SMART_KIND_META[clip.smart.kind] : null
                return (
                  <button
                    key={clip.id}
                    onClick={() => {
                      selectClip(activeTrack.id, clip.id)
                      setSmartClipTarget(clip.smart ? { trackId: activeTrack.id, clipId: clip.id } : null)
                    }}
                    className={cn(
                      'mb-1 flex w-full items-center gap-1.5 rounded-lg border px-2 py-1.5 text-left transition-colors',
                      isActive
                        ? 'border-accent/50 bg-accent/10'
                        : 'border-transparent hover:border-line-strong hover:bg-surface-2',
                    )}
                  >
                    <span className="shrink-0 text-[11px]">{meta ? meta.icon : '🎵'}</span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn('block truncate text-[11.5px]', isActive ? 'text-accent-soft' : 'text-ink-2')}
                        title={clip.name}
                      >
                        {clip.name}
                      </span>
                      <span className="block text-[9.5px] text-ink-4">
                        {Math.round(clip.lengthBeats / barBeats)} 小节 · {clip.notes.length} 音符
                      </span>
                    </span>
                    {clip.smart && <CircleDot size={8} className="shrink-0 text-violet" />}
                  </button>
                )
              })}
            </div>
          </section>
        </aside>

        {/* 中：参数 */}
        <section className="panel-flat flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl">
          {activeClip && smart ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
                <span className="shrink-0 text-[15px] leading-none">{SMART_KIND_META[smart.kind].icon}</span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="shrink-0 whitespace-nowrap text-[12.5px] font-semibold">
                      {SMART_KIND_META[smart.kind].name}
                    </span>
                    <span className="shrink-0 rounded border border-violet/40 bg-violet/10 px-1 py-[1px] text-[9.5px] text-violet">
                      智能
                    </span>
                    <button
                      type="button"
                      className="mono flex shrink-0 items-center gap-1 rounded border border-line bg-surface-2 px-1.5 py-[2px] text-[10px] text-ink-4 transition-colors hover:border-accent/40 hover:text-accent-soft"
                      onClick={() => void copySeed()}
                      aria-label="复制 seed"
                      title="复制随机种子（seed），便于记录或分享这个版本"
                    >
                      seed {hexSeed(smart.seed)}
                      <Copy size={9} />
                    </button>
                  </div>
                  <div className="truncate text-[10.5px] text-ink-3">{SMART_KIND_META[smart.kind].hint}</div>
                </div>
                <div className="flex-1" />
                <button
                  className="btn btn-ghost h-8 shrink-0 px-2.5 text-[11px]"
                  onClick={previewClipAudio}
                  title="试听当前片段"
                >
                  <Play size={11} />
                  试听
                </button>
                <button
                  className="btn btn-ghost h-8 shrink-0 px-2.5 text-[11px]"
                  onClick={regenerateVariant}
                  title="用新种子重新生成（换一个变奏），不改变调好的参数"
                >
                  <RefreshCw size={11} />
                  换一个变奏
                </button>
                <button
                  className="btn btn-accent h-8 shrink-0 px-2.5 text-[11px]"
                  onClick={createAtPlayhead}
                  title="用当前类型与参数，在播放头所在小节生成一个新片段"
                >
                  <Plus size={11} />
                  生成到播放头
                </button>
              </header>

              <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-[10.5px] text-ink-4">参数预设</span>
                  {PARAM_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => applyPreset(preset)}
                      title={preset.hint}
                      aria-pressed={presetId === preset.id}
                      className={cn(
                        'rounded-lg border px-2.5 py-1.5 text-[11px] transition-colors',
                        presetId === preset.id
                          ? 'border-accent/60 bg-accent/12 text-accent-soft'
                          : 'border-line bg-surface-2/60 text-ink-2 hover:border-line-strong hover:bg-surface-3 hover:text-ink',
                      )}
                    >
                      {preset.name}
                    </button>
                  ))}
                  <span className="ml-1 hidden text-[10px] text-ink-4 sm:block">一次点击套用一组手感参数（可撤销）</span>
                </div>
                <div className={cn('mb-2 grid gap-2', singleColumnParams ? 'grid-cols-1' : 'grid-cols-2')}>
                  <ParamSlider
                    label="小节数"
                    hint="片段长度（会同时改变片段在小节上的长度）"
                    value={Math.max(1, Math.round(activeClip.lengthBeats / barBeats))}
                    min={1}
                    max={16}
                    step={1}
                    display={`${Math.max(1, Math.round(activeClip.lengthBeats / barBeats))} 小节`}
                    onGestureStart={beginGesture}
                    onChange={(value) => applyBars(Math.round(value))}
                    onCommit={commitGesture}
                  />
                  <ParamSlider
                    label="密度"
                    hint="单位时间内音符的多少"
                    value={smart.params.density}
                    min={0}
                    max={1}
                    step={0.01}
                    display={`${Math.round(smart.params.density * 100)}%`}
                    onGestureStart={beginGesture}
                    onChange={(value) => applyParam({ density: value })}
                    onCommit={commitGesture}
                  />
                  <ParamSlider
                    label="复杂度"
                    hint="音高与节奏变化的丰富程度"
                    value={smart.params.complexity}
                    min={0}
                    max={1}
                    step={0.01}
                    display={`${Math.round(smart.params.complexity * 100)}%`}
                    onGestureStart={beginGesture}
                    onChange={(value) => applyParam({ complexity: value })}
                    onCommit={commitGesture}
                  />
                  <ParamSlider
                    label="能量"
                    hint="力度与音区强度"
                    value={smart.params.energy}
                    min={0}
                    max={1}
                    step={0.01}
                    display={`${Math.round(smart.params.energy * 100)}%`}
                    onGestureStart={beginGesture}
                    onChange={(value) => applyParam({ energy: value })}
                    onCommit={commitGesture}
                  />
                  <ParamSlider
                    label="八度"
                    hint="基准八度音区"
                    value={smart.params.octave}
                    min={-1}
                    max={7}
                    step={1}
                    display={`C${smart.params.octave}`}
                    onGestureStart={beginGesture}
                    onChange={(value) => applyParam({ octave: Math.round(value) })}
                    onCommit={commitGesture}
                  />
                  <ParamSlider
                    label="摇摆"
                    hint="0 = 直拍，100% = 强摇摆"
                    value={smart.params.swing}
                    min={0}
                    max={1}
                    step={0.01}
                    display={`${Math.round(smart.params.swing * 100)}%`}
                    onGestureStart={beginGesture}
                    onChange={(value) => applyParam({ swing: value })}
                    onCommit={commitGesture}
                  />
                  <ParamSlider
                    label="人性化"
                    hint="力度与时值的细微随机，让演奏更自然"
                    value={smart.params.humanize}
                    min={0}
                    max={1}
                    step={0.01}
                    display={`${Math.round(smart.params.humanize * 100)}%`}
                    onGestureStart={beginGesture}
                    onChange={(value) => applyParam({ humanize: value })}
                    onCommit={commitGesture}
                  />
                  <ParamSlider
                    label="音符长度"
                    hint="门限：实际时值相对格子的比例"
                    value={smart.params.gate}
                    min={0.1}
                    max={1.5}
                    step={0.01}
                    display={`${Math.round(smart.params.gate * 100)}%`}
                    onGestureStart={beginGesture}
                    onChange={(value) => applyParam({ gate: value })}
                    onCommit={commitGesture}
                  />
                </div>

                <div className={cn('grid gap-2', singleColumnParams ? 'grid-cols-1' : 'grid-cols-2')}>
                  <div className="rounded-lg border border-line bg-surface-2/50 px-2.5 py-2">
                    <div className="mb-1.5 text-[11.5px] text-ink-2">图案（pattern）</div>
                    {patternOptions(smart.kind, smart.style).length > 0 ? (
                      <Select
                        ariaLabel="图案"
                        value={smart.params.patternId ?? ''}
                        onChange={(value) => applyParamOnce({ patternId: value || undefined })}
                        className="h-8 text-[11.5px]"
                        options={[
                          { value: '', label: '自动（按风格挑选）' },
                          ...patternOptions(smart.kind, smart.style).map((option) => ({ value: option.id, label: option.name })),
                        ]}
                      />
                    ) : (
                      <div className="flex h-8 items-center text-[10.5px] text-ink-4">该类型由生成器自动决定图案</div>
                    )}
                  </div>
                  <div className="rounded-lg border border-line bg-surface-2/50 px-2.5 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="text-[11.5px] text-ink-2">跟随工程和弦</div>
                        <div className="mt-0.5 text-[10px] text-ink-4">关闭后使用生成时的和弦快照</div>
                      </div>
                      <Switch
                        label="跟随工程和弦"
                        checked={smart.params.followChords}
                        onChange={(checked) => applyParamOnce({ followChords: checked })}
                      />
                    </div>
                  </div>
                </div>

                <div className="mt-2 rounded-lg border border-line bg-surface-2/40 px-2.5 py-2">
                  <div className="mb-1 flex items-center gap-1.5">
                    <Wand2 size={11} className="text-ink-3" />
                    <span className="text-[11px] text-ink-2">参数说明</span>
                  </div>
                  <p className="text-[10px] leading-relaxed text-ink-4">
                    所有参数会立即重新生成音符（撤销可逐步回退）。「换一个变奏」只更换随机种子，
                    不改变你调好的参数。生成结果保存在当前片段里，可直接在编曲视图拖动、在钢琴卷帘里微调。
                  </p>
                </div>
              </div>
            </div>
          ) : activeClip ? (
            /* 普通片段 → 转为智能片段 */
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
              <div className="rounded-xl border border-dashed border-line-strong bg-surface-2/40 p-4">
                <div className="flex items-start gap-2.5">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2">
                    <Sparkles size={14} className="text-ink-3" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[12.5px] font-medium">「{activeClip.name}」还不是智能片段</div>
                    <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">
                      智能片段由生成器实时计算，可以调整密度、复杂度、能量等参数并「换一个变奏」。
                      转换会在这条轨道上、同一位置新建一个类型片段（原片段保留，可随时对比）。
                    </p>
                  </div>
                </div>
                <div className="mt-3">
                  <div className="label mb-1.5">选择生成类型</div>
                  <KindGrid activeKind={convertKind} onPick={setConvertKind} compact />
                </div>
                <button className="btn btn-accent mt-3 h-9 w-full text-[12.5px]" onClick={convertToSmart}>
                  <Wand2 size={12} />
                  生成{SMART_KIND_META[convertKind].name}智能片段
                </button>
                <div className="mt-2 flex items-center gap-1 text-[10px] text-ink-4">
                  <ChevronRight size={11} />
                  片段位置 {activeClip.startBeat} 拍 · 长度 {activeClip.lengthBeats} 拍 ·{' '}
                  {activeClip.notes.length} 音符
                </div>
              </div>
              <div className="mt-3 rounded-xl border border-line bg-surface-2/40 p-3">
                <div className="mb-1.5 flex items-center gap-1.5">
                  <Music4 size={11} className="text-ink-3" />
                  <span className="text-[11px] text-ink-2">也可以直接在左侧新建</span>
                </div>
                <p className="text-[10px] leading-relaxed text-ink-4">
                  选择左侧任一类型即可在当前轨道生成一个全新的智能片段；从播放头所在小节开始。
                </p>
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center p-6">
              <div className="max-w-sm">
                <EmptyState
                  icon={<Sparkles size={22} />}
                  title="选一个片段，开始用参数创作"
                  hint="在左侧点任意类型生成智能片段，或在编曲视图里选中一个片段。所有参数都可以边听边调。"
                />
                <ol className="mx-auto mt-2 max-w-xs space-y-1 text-[11px] leading-relaxed text-ink-4">
                  <li>1. 左侧选择「轨道」</li>
                  <li>2. 选一个智能类型（节奏/低音/和弦…）</li>
                  <li>3. 在这里拖动参数实时听变化</li>
                </ol>
              </div>
            </div>
          )}
        </section>

        </div>

        {threeColumns && (
          <aside className="flex w-[248px] shrink-0 flex-col gap-2 overflow-y-auto">{rightPanels}</aside>
        )}
        {!threeColumns && (
          <div className={cn('grid shrink-0 gap-2.5', panelWidth >= 700 ? 'grid-cols-3' : 'grid-cols-2')}>{rightPanels}</div>
        )}
      </div>
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[10px]">
      <span className="shrink-0 text-ink-4">{label}</span>
      <span className={cn('truncate text-ink-2', mono && 'mono')}>{value}</span>
    </div>
  )
}
