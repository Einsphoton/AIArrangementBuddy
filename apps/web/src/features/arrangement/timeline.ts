/**
 * 编辑器共享工具（编曲时间轴 / 钢琴卷帘 / 智能片段 共用）。
 *
 * 这里集中三类东西，避免三个视图各写一套导致行为不一致：
 * 1. 几何常量与缩放、吸附换算（行高、每拍像素、网格吸附）
 * 2. 颜色工具（轨道色 → 半透明填充）
 * 3. Canvas 绘制工具（片段内音符缩略图）
 * 4. 轨道面板与编曲视图之间的纵向滚动同步（轻量 window 事件总线，不污染 store）
 */
import { beatsPerBar, type NoteEvent, type TimeSignature } from '@aiab/core'

/* ------------------------------------------------------------------ */
/* 几何常量                                                            */
/* ------------------------------------------------------------------ */

/** TrackPanel 顶部标题栏高度（与主线 tab 栏 38px 对齐） */
export const TRACK_HEADER_HEIGHT = 38
/** TrackPanel 副标题高度（与编曲视图的标尺区总高对齐） */
export const RULER_HEIGHT = 54
/** 标尺区内部：循环条 / 段落条 / 小节标尺 */
export const LOOP_STRIP_HEIGHT = 12
export const SECTION_STRIP_HEIGHT = 18
export const BAR_RULER_HEIGHT = 24

/** 轨道行高基线（TrackPanel 与编曲视图共用同一公式，保证严格对齐） */
export const TRACK_ROW_BASE = 56
export const TRACK_ROW_MIN = 38
export const TRACK_ROW_MAX = 104

/** 编曲时间轴工具条高度：左侧轨道面板有一块同高工具条与它对齐 */
export const ARRANGEMENT_TOOLBAR_HEIGHT = 38

/** 编曲视图默认每拍像素 = zoomX × 系数；钢琴卷帘更“放大”一些 */
export const ARR_ZOOM_FACTOR = 0.5
export const PR_ZOOM_FACTOR = 1.25

export const MIN_ZOOM_X = 6
export const MAX_ZOOM_X = 260
export const MIN_ZOOM_Y = 9
export const MAX_ZOOM_Y = 34

/** 轨道默认色板（新建轨道 / 右键换色时使用） */
export const TRACK_COLORS = [
  '#f0b429',
  '#3ddbd9',
  '#f472b6',
  '#8b7bff',
  '#a3e635',
  '#f0563b',
  '#4ea1ff',
  '#d4a95c',
  '#34d399',
  '#e879f9',
] as const

/* ------------------------------------------------------------------ */
/* 数学 / 换算                                                         */
/* ------------------------------------------------------------------ */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 纵向缩放（zoomY 9..34）→ 轨道行高。默认 16 → 56px，与 TrackPanel 一致 */
export function rowHeightForZoom(zoomY: number): number {
  return Math.round(clamp(TRACK_ROW_BASE * (zoomY / 16), TRACK_ROW_MIN, TRACK_ROW_MAX))
}

/** 编曲视图每拍像素 */
export function arrangementPxPerBeat(zoomX: number): number {
  return clamp(zoomX, MIN_ZOOM_X, MAX_ZOOM_X) * ARR_ZOOM_FACTOR
}

/** 钢琴卷帘每拍像素 */
export function pianoRollPxPerBeat(zoomX: number): number {
  return clamp(zoomX, MIN_ZOOM_X, MAX_ZOOM_X) * PR_ZOOM_FACTOR
}

/** 吸附到网格（snap <= 0 时按网格最小值 1/64 处理，保证不会出现 0 长度） */
export function snapBeat(beat: number, snap: number, mode: 'round' | 'floor' = 'round'): number {
  const unit = snap > 0 ? snap : 1 / 64
  const snapped = mode === 'floor' ? Math.floor(beat / unit) : Math.round(beat / unit)
  return snapped * unit
}

/** 编辑网格单位：吸关闭时仍用十六分音符做兜底，避免拖拽出现浮点脏数据 */
export function gridUnit(snap: number): number {
  return snap > 0 ? snap : 0.25
}

/** 数值保留两位小数，去掉浮点毛刺（0.30000000000000004 → 0.3） */
export function tidy(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** 拍 → 小节/拍/嗒（全部 1-based，用于走带时间码） */
export function barBeatTick(beat: number, ts: TimeSignature): { bar: number; beat: number; tick: number; barBeats: number } {
  const barBeats = beatsPerBar(ts)
  const safe = Math.max(0, beat)
  const bar = Math.floor(safe / barBeats) + 1
  const beatInBar = Math.floor(safe % barBeats) + 1
  const tick = Math.floor(((safe % barBeats) % 1) * 480)
  return { bar, beat: beatInBar, tick, barBeats }
}

/** 001 · 1 · 000 */
export function formatBarBeatTick(beat: number, ts: TimeSignature): string {
  const { bar, beat: b, tick } = barBeatTick(beat, ts)
  return `${String(bar).padStart(3, '0')} · ${b} · ${String(tick).padStart(3, '0')}`
}

/** 小节号 → 拍 */
export function barToBeat(bar: number, ts: TimeSignature): number {
  return bar * beatsPerBar(ts)
}

/* ------------------------------------------------------------------ */
/* 颜色                                                                */
/* ------------------------------------------------------------------ */

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

export function hexToRgb(hex: string): [number, number, number] {
  const match = HEX_RE.exec((hex || '').trim())
  if (!match) return [240, 180, 41]
  let value = match[1]
  if (value.length === 3) value = value.split('').map((c) => c + c).join('')
  const num = parseInt(value, 16)
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255]
}

/** hex + alpha → rgba() 字符串 */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1).toFixed(3)})`
}

/** 提亮/压暗：amount > 0 向白色混合，< 0 向黑色混合 */
export function shade(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex)
  const mix = (channel: number) =>
    Math.round(amount >= 0 ? channel + (255 - channel) * amount : channel * (1 + amount))
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`
}

/** 轨道色（容错：非法颜色回退到琥珀金） */
export function trackColor(color: string | undefined): string {
  return color && HEX_RE.test(color.trim()) ? color : '#f0b429'
}

/* ------------------------------------------------------------------ */
/* Canvas：片段音符缩略图                                              */
/* ------------------------------------------------------------------ */

export interface ThumbnailOptions {
  /** 小节拍数，用于画小节分隔线 */
  barBeats?: number
  /** 上下留白 */
  padY?: number
  /** 单个音符最大高度 */
  maxNoteHeight?: number
}

/**
 * 把片段内的音符画成缩略图（编曲视图的 Clip、智能片段预览共用）。
 * canvas 的 CSS 尺寸由布局决定，这里按 devicePixelRatio 自动设置位图尺寸。
 */
export function drawNotesThumbnail(
  canvas: HTMLCanvasElement,
  notes: NoteEvent[],
  lengthBeats: number,
  color: string,
  options: ThumbnailOptions = {},
): void {
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (width <= 0 || height <= 0) return

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const bitmapWidth = Math.max(1, Math.round(width * dpr))
  const bitmapHeight = Math.max(1, Math.round(height * dpr))
  if (canvas.width !== bitmapWidth) canvas.width = bitmapWidth
  if (canvas.height !== bitmapHeight) canvas.height = bitmapHeight

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  const spanBeats = Math.max(0.25, lengthBeats)
  const barBeats = options.barBeats && options.barBeats > 0 ? options.barBeats : 0

  // 小节分隔线
  if (barBeats) {
    ctx.fillStyle = 'rgba(255,255,255,0.075)'
    for (let bar = 1; bar * barBeats < spanBeats; bar += 1) {
      const x = Math.round((bar * barBeats * width) / spanBeats)
      ctx.fillRect(x, 0, 1, height)
    }
  }

  if (notes.length === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.09)'
    const y = Math.round(height / 2)
    ctx.fillRect(Math.round(width * 0.12), y, Math.round(width * 0.76), 1)
    return
  }

  let minPitch = 127
  let maxPitch = 0
  for (const note of notes) {
    if (note.pitch < minPitch) minPitch = note.pitch
    if (note.pitch > maxPitch) maxPitch = note.pitch
  }

  const padY = options.padY ?? 2
  const usable = Math.max(4, height - padY * 2)
  const pitchSpan = Math.max(1, maxPitch - minPitch + 1)
  const unit = usable / pitchSpan
  const noteHeight = Math.max(1, Math.min(unit - 0.15, options.maxNoteHeight ?? 3))
  const baseY = padY + (maxPitch - minPitch) * unit

  const [r, g, b] = hexToRgb(color)
  for (const note of notes) {
    let x = (note.start / spanBeats) * width
    let w = (Math.max(1 / 64, note.duration) / spanBeats) * width
    if (x > width) continue
    if (x + w < 0) continue
    x = Math.max(0, x)
    w = Math.max(1, w)
    if (x + w > width) w = width - x

    const y = padY + (maxPitch - note.pitch) * unit - noteHeight
    const alpha = 0.32 + (clamp(note.velocity, 1, 127) / 127) * 0.6
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`
    ctx.fillRect(Math.round(x), Math.round(clamp(y, padY, baseY)), Math.ceil(w), Math.max(1, Math.round(noteHeight)))
  }
}

/* ------------------------------------------------------------------ */
/* 吸附网格 / 缩放适合                                                  */
/* ------------------------------------------------------------------ */

export interface SnapOption {
  /** store.snap 的数值（0 = 关闭） */
  value: number
  /** 选择器里的文案 */
  label: string
  /** 工具条紧凑显示用的角标 */
  short: string
}

/** 编曲 / 钢琴卷帘共用的吸附网格选项（顺序从粗到细） */
export const SNAP_OPTIONS: SnapOption[] = [
  { value: 4, label: '1/1 全音符', short: '1/1' },
  { value: 2, label: '1/2 二分音符', short: '1/2' },
  { value: 1, label: '1/4 四分音符', short: '1/4' },
  { value: 0.5, label: '1/8 八分音符', short: '1/8' },
  { value: 0.25, label: '1/16 十六分音符', short: '1/16' },
  { value: 0.125, label: '1/32 三十二分音符', short: '1/32' },
  { value: 0.666667, label: '1/4 三连音', short: '1/4T' },
  { value: 0.333333, label: '1/8 三连音', short: '1/8T' },
  { value: 0.166667, label: '1/16 三连音', short: '1/16T' },
  { value: 0, label: '关闭', short: '关' },
]

/** 吸附数值 → 简短标签（1/16、1/8T…） */
export function snapShortLabel(snap: number): string {
  const found = SNAP_OPTIONS.find((option) => Math.abs(option.value - snap) < 1e-6)
  if (found) return found.short
  if (!(snap > 0)) return '关'
  return `1/${Math.round(1 / snap)}`
}

/** 吸附数值 → 完整标签 */
export function snapFullLabel(snap: number): string {
  const found = SNAP_OPTIONS.find((option) => Math.abs(option.value - snap) < 1e-6)
  return found ? found.label : `${snap} 拍`
}

/**
 * 按「工程总小节 + 可视宽度」反算 zoomX（编曲视图 px/拍 = zoomX × ARR_ZOOM_FACTOR）。
 * 留 20px 呼吸空间，避免最后一个片段贴住右边缘。
 */
export function fitZoomXForWidth(totalBars: number, viewportWidth: number): number | null {
  if (!(viewportWidth > 0) || !(totalBars > 0)) return null
  const usable = Math.max(80, viewportWidth - 20)
  const beats = totalBars * 4
  const pxPerBeat = usable / beats
  return clamp(pxPerBeat / ARR_ZOOM_FACTOR, MIN_ZOOM_X, MAX_ZOOM_X)
}

/** 拖动 / 移动时 tooltip 用的短时间提示：`003 · 2` */
export function formatDragPosition(beat: number, ts: TimeSignature): string {
  const { bar, beat: b } = barBeatTick(beat, ts)
  return `${String(bar).padStart(3, '0')} · ${b}`
}

/* ------------------------------------------------------------------ */
/* TrackPanel ↔ ArrangementView 纵向滚动同步                            */
/* ------------------------------------------------------------------ */

const SCROLL_EVENT = 'aiab:editor-vertical-scroll'

/** 广播纵向滚动位置（source 用来避免回声） */
export function publishVerticalScroll(top: number, source: 'tracks' | 'arrangement'): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(SCROLL_EVENT, { detail: { top, source } }))
}

/** 订阅纵向滚动位置，返回取消订阅函数 */
export function subscribeVerticalScroll(
  callback: (top: number, source: 'tracks' | 'arrangement') => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ top: number; source: 'tracks' | 'arrangement' }>).detail
    if (detail) callback(detail.top, detail.source)
  }
  window.addEventListener(SCROLL_EVENT, handler)
  return () => window.removeEventListener(SCROLL_EVENT, handler)
}
