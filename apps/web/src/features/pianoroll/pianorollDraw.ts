/**
 * 钢琴卷帘的 Canvas 绘制层。
 *
 * 只做「读场景 → 画一帧」，所有交互状态由组件维护，方便在拖拽时直接以 60fps 重绘，
 * 而无需让 React 参与每一帧。
 */
import {
  DRUM_LABELS,
  isBlackKey,
  isInScale,
  pitchToName,
  type NoteEvent,
  type ScaleId,
  type TimeSignature,
} from '@aiab/core'
import { clamp, withAlpha } from '../arrangement/timeline'

export const KEYBOARD_WIDTH = 68
export const VELOCITY_HEIGHT = 78
export const SCROLLBAR_HEIGHT = 10

export interface PianoRollLayout {
  width: number
  height: number
  keyboardWidth: number
  gridLeft: number
  gridWidth: number
  gridHeight: number
  velocityTop: number
  velocityHeight: number
  scrollbarTop: number
  scrollbarHeight: number
}

export type GridDivision = 'beat' | 'half' | 'triplet'

export interface NotePreview {
  ids: Set<string>
  deltaBeats: number
  deltaSemis: number
  mode: 'move' | 'resize'
}

/** 幽灵音符：同一轨道其它片段里、当前片段前后若干小节的音符（坐标已换算为当前片段的相对拍） */
export interface GhostNote {
  pitch: number
  start: number
  duration: number
  velocity: number
}

/** 拖拽时跟随指针的信息浮层（画在 canvas 上，不触发 React 渲染） */
export interface DragTooltip {
  x: number
  y: number
  lines: string[]
}

export interface PianoRollScene {
  layout: PianoRollLayout
  pxPerBeat: number
  pitchHeight: number
  scrollBeat: number
  topPitch: number
  notes: NoteEvent[]
  selected: Set<string>
  color: string
  barBeats: number
  timeSignature: TimeSignature
  snap: number
  gridDivision: GridDivision
  scaleHighlight: boolean
  scaleLock: boolean
  keyName: string
  scale: ScaleId
  isDrum: boolean
  clipLengthBeats: number
  hoverPitch: number | null
  hoverBeat: number | null
  hoverNoteId: string | null
  preview: NotePreview | null
  velocityPreview: Record<string, number> | null
  ghost: { pitch: number; start: number; duration: number } | null
  ghostNotes: GhostNote[]
  marquee: { x1: number; y1: number; x2: number; y2: number } | null
  pressedPitch: number | null
  scrollThumb: { left: number; width: number } | null
  velocityLane: boolean
  tooltip: DragTooltip | null
  hasNotes: boolean
}

export function computeLayout(width: number, height: number, options: { velocityLane?: boolean } = {}): PianoRollLayout {
  const keyboardWidth = Math.min(KEYBOARD_WIDTH, Math.max(40, width * 0.16))
  const velocityHeight = options.velocityLane === false ? 0 : VELOCITY_HEIGHT
  const gridHeight = Math.max(40, height - velocityHeight - SCROLLBAR_HEIGHT)
  return {
    width,
    height,
    keyboardWidth,
    gridLeft: keyboardWidth,
    gridWidth: Math.max(20, width - keyboardWidth),
    gridHeight,
    velocityTop: gridHeight,
    velocityHeight,
    scrollbarTop: height - SCROLLBAR_HEIGHT,
    scrollbarHeight: SCROLLBAR_HEIGHT,
  }
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + width - r, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + r)
  ctx.lineTo(x + width, y + height - r)
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  ctx.lineTo(x + r, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

const FONT_SMALL = '9.5px "Inter", "PingFang SC", system-ui, sans-serif'
const FONT_LABEL = '10px "Inter", "PingFang SC", system-ui, sans-serif'

/* ------------------------------------------------------------------ */
/* 主绘制                                                              */
/* ------------------------------------------------------------------ */

export function drawPianoRoll(canvas: HTMLCanvasElement, scene: PianoRollScene): void {
  const { layout, pxPerBeat, pitchHeight, scrollBeat, topPitch } = scene
  if (layout.width <= 0 || layout.height <= 0) return

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const bitmapWidth = Math.max(1, Math.round(layout.width * dpr))
  const bitmapHeight = Math.max(1, Math.round(layout.height * dpr))
  if (canvas.width !== bitmapWidth) canvas.width = bitmapWidth
  if (canvas.height !== bitmapHeight) canvas.height = bitmapHeight

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, layout.width, layout.height)

  const beatToX = (beat: number) => layout.gridLeft + (beat - scrollBeat) * pxPerBeat
  const pitchToRow = (pitch: number) => topPitch - pitch
  const visibleBeats = layout.gridWidth / pxPerBeat
  const visibleRows = Math.ceil(layout.gridHeight / pitchHeight) + 1
  const rowHeight = pitchHeight

  /* ---------------- 背景 ---------------- */
  ctx.fillStyle = '#0a0d13'
  ctx.fillRect(0, 0, layout.width, layout.height)
  ctx.fillStyle = '#0b0f16'
  ctx.fillRect(layout.gridLeft, 0, layout.gridWidth, layout.gridHeight)

  /* ---------------- 横向音高行 ---------------- */
  for (let row = 0; row < visibleRows; row += 1) {
    const pitch = topPitch - row
    if (pitch < 0) break
    const y = row * rowHeight
    if (y > layout.gridHeight) break
    const black = isBlackKey(pitch)
    if (black) {
      ctx.fillStyle = 'rgba(255,255,255,0.022)'
      ctx.fillRect(layout.gridLeft, y, layout.gridWidth, rowHeight)
    }
    if (scene.scaleHighlight && !isInScale(pitch, scene.keyName, scene.scale)) {
      ctx.fillStyle = 'rgba(0,0,0,0.22)'
      ctx.fillRect(layout.gridLeft, y, layout.gridWidth, rowHeight)
    }
    // 行分隔线
    ctx.fillStyle = pitch % 12 === 0 ? 'rgba(255,255,255,0.075)' : 'rgba(255,255,255,0.026)'
    ctx.fillRect(layout.gridLeft, y + rowHeight - 1, layout.gridWidth, 1)
  }

  /* ---------------- 纵向网格 ---------------- */
  const subdivision = scene.gridDivision === 'half' ? 0.5 : scene.gridDivision === 'triplet' ? 1 / 3 : 1
  const startBeat = Math.floor(scrollBeat / subdivision) * subdivision
  const endBeat = scrollBeat + visibleBeats
  const drawGridLines = (top: number, height: number) => {
    for (let beat = startBeat; beat <= endBeat + subdivision; beat += subdivision) {
      const isBar = Math.abs(beat / scene.barBeats - Math.round(beat / scene.barBeats)) < 1e-6
      const isBeatLine = Math.abs(beat - Math.round(beat)) < 1e-6
      if (!isBar && !isBeatLine && subdivision >= 0.5) continue
      const x = Math.round(beatToX(beat)) + 0.5
      if (x < layout.gridLeft - 1 || x > layout.width) continue
      ctx.fillStyle = isBar ? 'rgba(255,255,255,0.15)' : isBeatLine ? 'rgba(255,255,255,0.055)' : 'rgba(255,255,255,0.028)'
      ctx.fillRect(x, top, 1, height)
    }
  }
  drawGridLines(0, layout.gridHeight)

  // 小节号
  if (scene.barBeats * pxPerBeat >= 42) {
    ctx.font = FONT_SMALL
    ctx.fillStyle = 'rgba(163,173,192,0.65)'
    ctx.textBaseline = 'top'
    const firstBar = Math.max(0, Math.floor(scrollBeat / scene.barBeats))
    const lastBar = Math.ceil((scrollBeat + visibleBeats) / scene.barBeats)
    for (let bar = firstBar; bar <= lastBar; bar += 1) {
      const x = beatToX(bar * scene.barBeats)
      if (x < layout.gridLeft - 2 || x > layout.width - 6) continue
      ctx.fillStyle = 'rgba(240,180,41,0.45)'
      ctx.fillRect(Math.round(x), 0, 1, 5)
      ctx.fillStyle = 'rgba(163,173,192,0.72)'
      ctx.fillText(String(bar + 1), Math.round(x) + 4, 2)
    }
  }

  /* ---------------- 片段范围 ---------------- */
  const clipEndX = beatToX(scene.clipLengthBeats)
  if (clipEndX < layout.width) {
    ctx.fillStyle = 'rgba(0,0,0,0.32)'
    ctx.fillRect(Math.max(layout.gridLeft, clipEndX), 0, layout.width - Math.max(layout.gridLeft, clipEndX), layout.gridHeight)
    ctx.fillStyle = 'rgba(240,180,41,0.35)'
    ctx.fillRect(Math.round(clipEndX), 0, 1, layout.gridHeight)
  }

  /* ---------------- 音符（裁剪到网格区，避免溢出到琴键） ---------------- */
  ctx.save()
  ctx.beginPath()
  ctx.rect(layout.gridLeft, 0, layout.gridWidth, layout.gridHeight)
  ctx.clip()

  const preview = scene.preview
  const velocityPreview = scene.velocityPreview
  const selected = scene.selected
  const visibleStart = scrollBeat - 1
  const visibleEnd = scrollBeat + visibleBeats + 1

  /* 幽灵音符：其它片段里同轨道的音符，淡显以辅助对位 */
  for (const ghost of scene.ghostNotes) {
    if (ghost.start + ghost.duration < visibleStart || ghost.start > visibleEnd) continue
    const row = pitchToRow(ghost.pitch)
    if (row < -1 || row > visibleRows + 1) continue
    const x = beatToX(ghost.start)
    const width = Math.max(3, ghost.duration * pxPerBeat - 1.5)
    const y = row * rowHeight + 1
    const height = Math.max(2, rowHeight - 2.5)
    if (x > layout.width || x + width < layout.gridLeft) continue
    ctx.fillStyle = withAlpha(scene.color, 0.14)
    ctx.fillRect(x, y, width, height)
    ctx.strokeStyle = withAlpha(scene.color, 0.24)
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, width - 1), Math.max(1, height - 1))
  }

  for (const note of scene.notes) {
    let start = note.start
    let duration = note.duration
    let pitch = note.pitch
    const isSelected = selected.has(note.id)
    if (preview && preview.ids.has(note.id)) {
      start += preview.deltaBeats
      if (preview.mode === 'move') pitch += preview.deltaSemis
      else duration = Math.max(1 / 32, duration + preview.deltaBeats)
    }
    if (start + duration < visibleStart || start > visibleEnd) continue
    const row = pitchToRow(pitch)
    if (row < -1 || row > visibleRows + 1) continue
    if (pitch < 0 || pitch > 127) continue

    const x = beatToX(Math.max(0, start))
    const width = Math.max(3, duration * pxPerBeat - 1.5)
    const y = row * rowHeight + 0.5
    const height = Math.max(2, rowHeight - 1.5)
    if (x > layout.width || x + width < layout.gridLeft) continue
    const velocity = velocityPreview?.[note.id] ?? note.velocity
    const alpha = 0.55 + (clamp(velocity, 1, 127) / 127) * 0.42

    ctx.fillStyle = isSelected ? withAlpha('#f0b429', Math.min(1, alpha + 0.15)) : withAlpha(scene.color, alpha)
    ctx.fillRect(x, y, width, height)
    // 顶部高光，让音符有体积感
    if (height >= 5) {
      ctx.fillStyle = isSelected ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.22)'
      ctx.fillRect(x, y, width, 1)
    }
    if (isSelected) {
      ctx.strokeStyle = '#ffe6a3'
      ctx.lineWidth = 1
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, width - 1), Math.max(1, height - 1))
    }
    // 极短音符也保证可点选
    if (width < 4) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillRect(x + width - 1, y, 1, height)
    }
  }

  /* ---------------- 悬停音符高亮（ref 驱动，不经过 React state） ---------------- */
  if (scene.hoverNoteId && !preview) {
    const hovered = scene.notes.find((note) => note.id === scene.hoverNoteId)
    if (hovered) {
      const row = pitchToRow(hovered.pitch)
      const x = beatToX(Math.max(0, hovered.start))
      const width = Math.max(3, hovered.duration * pxPerBeat - 1.5)
      const y = row * rowHeight + 0.5
      const height = Math.max(2, rowHeight - 1.5)
      if (x <= layout.width && x + width >= layout.gridLeft && row >= -1 && row <= visibleRows + 1) {
        ctx.fillStyle = 'rgba(255,255,255,0.16)'
        ctx.fillRect(x, y, width, height)
        ctx.strokeStyle = 'rgba(255,230,163,0.9)'
        ctx.lineWidth = 1
        ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, width - 1), Math.max(1, height - 1))
      }
    }
  }

  /* ---------------- 新建音符的幽灵预览 ---------------- */
  if (scene.ghost) {
    const row = pitchToRow(scene.ghost.pitch)
    const x = beatToX(Math.max(0, scene.ghost.start))
    const width = Math.max(3, scene.ghost.duration * pxPerBeat - 1.5)
    const y = row * rowHeight + 0.5
    const height = Math.max(2, rowHeight - 1.5)
    ctx.fillStyle = withAlpha('#f0b429', 0.55)
    ctx.fillRect(x, y, width, height)
    ctx.strokeStyle = '#ffe6a3'
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, width - 1), Math.max(1, height - 1))
  }

  /* ---------------- 悬停辅助线 ---------------- */
  if (scene.hoverPitch !== null) {
    const row = pitchToRow(scene.hoverPitch)
    if (row >= 0 && row * rowHeight < layout.gridHeight) {
      ctx.fillStyle = 'rgba(240,180,41,0.16)'
      ctx.fillRect(layout.gridLeft, row * rowHeight, layout.gridWidth, rowHeight)
    }
  }
  if (scene.hoverBeat !== null) {
    const x = Math.round(beatToX(scene.hoverBeat)) + 0.5
    if (x > layout.gridLeft && x < layout.width) {
      ctx.fillStyle = 'rgba(255,255,255,0.14)'
      ctx.fillRect(x, 0, 1, layout.gridHeight)
    }
  }

  /* ---------------- 框选 ---------------- */
  if (scene.marquee) {
    const left = Math.min(scene.marquee.x1, scene.marquee.x2)
    const top = Math.min(scene.marquee.y1, scene.marquee.y2)
    const width = Math.abs(scene.marquee.x2 - scene.marquee.x1)
    const height = Math.abs(scene.marquee.y2 - scene.marquee.y1)
    ctx.fillStyle = 'rgba(240,180,41,0.10)'
    ctx.fillRect(left, top, width, height)
    ctx.strokeStyle = 'rgba(240,180,41,0.75)'
    ctx.lineWidth = 1
    ctx.strokeRect(left + 0.5, top + 0.5, width, height)
  }

  ctx.restore()

  /* ---------------- 钢琴键 ---------------- */
  drawKeyboard(ctx, scene, beatToX)

  /* ---------------- 力度条 ---------------- */
  if (scene.velocityLane && layout.velocityHeight > 0) drawVelocityLane(ctx, scene)

  /* ---------------- 底部滚动条 ---------------- */
  drawScrollbar(ctx, scene)

  /* ---------------- 拖拽信息浮层 ---------------- */
  if (scene.tooltip) drawTooltip(ctx, scene.tooltip, layout)

  /* ---------------- 空提示 ---------------- */
  if (!scene.hasNotes) {
    ctx.font = '12px "Inter", "PingFang SC", system-ui, sans-serif'
    ctx.fillStyle = 'rgba(163,173,192,0.65)'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('单击网格添加音符 · 拖拽框选 · ⌘拖拽画长度', layout.gridLeft + layout.gridWidth / 2, layout.gridHeight / 2 - 8)
    ctx.font = '10.5px "Inter", "PingFang SC", system-ui, sans-serif'
    ctx.fillStyle = 'rgba(108,119,137,0.8)'
    ctx.fillText('右键音符 = 编辑菜单 · 右键空白 = 粘贴/全选 · Q 量化', layout.gridLeft + layout.gridWidth / 2, layout.gridHeight / 2 + 12)
    ctx.textAlign = 'left'
  }
}

/* ------------------------------------------------------------------ */
/* 键盘                                                                */
/* ------------------------------------------------------------------ */

function drawKeyboard(ctx: CanvasRenderingContext2D, scene: PianoRollScene, beatToX: (beat: number) => number): void {
  const { layout, pitchHeight, topPitch } = scene
  const rows = Math.ceil(layout.gridHeight / pitchHeight) + 1

  ctx.fillStyle = '#0a0d13'
  ctx.fillRect(0, 0, layout.gridLeft, layout.gridHeight)

  for (let row = 0; row < rows; row += 1) {
    const pitch = topPitch - row
    if (pitch < 0) break
    const y = row * pitchHeight
    if (y > layout.gridHeight) break
    const h = Math.max(1, pitchHeight - 1)
    const black = isBlackKey(pitch)
    const drumLabel = scene.isDrum ? (DRUM_LABELS[pitch] ?? '') : ''

    if (scene.isDrum) {
      ctx.fillStyle = black ? '#151b26' : '#1c2433'
      ctx.fillRect(0, y, layout.gridLeft - 1, h)
      ctx.fillStyle = 'rgba(255,255,255,0.05)'
      ctx.fillRect(0, y + h - 1, layout.gridLeft - 1, 1)
      if (drumLabel) {
        ctx.font = FONT_SMALL
        ctx.fillStyle = pitch === 36 || pitch === 38 ? 'rgba(240,180,41,0.85)' : 'rgba(163,173,192,0.8)'
        ctx.textBaseline = 'middle'
        ctx.fillText(drumLabel, 6, y + h / 2)
      }
    } else {
      // 黑键行：右侧是白键之间的空隙（深色），先铺底色再画黑键
      if (black) {
        ctx.fillStyle = '#0b0f16'
        ctx.fillRect(0, y, layout.gridLeft - 1, h)
        const keyWidth = (layout.gridLeft - 1) * 0.66
        ctx.fillStyle = '#11161f'
        ctx.fillRect(0, y, keyWidth, h)
        ctx.fillStyle = 'rgba(255,255,255,0.12)'
        ctx.fillRect(keyWidth - 1, y, 1, h)
        ctx.fillStyle = 'rgba(0,0,0,0.5)'
        ctx.fillRect(0, y + h - 1, keyWidth, 1)
      } else {
        // 白键底（纯色填充，避免每帧创建渐变对象）
        ctx.fillStyle = pitch % 12 === 0 ? '#ccd5e3' : '#c1cad9'
        ctx.fillRect(0, y, layout.gridLeft - 1, h)
        ctx.fillStyle = 'rgba(255,255,255,0.32)'
        ctx.fillRect(0, y, layout.gridLeft - 1, 1)
        ctx.fillStyle = 'rgba(0,0,0,0.28)'
        ctx.fillRect(0, y + h - 1, layout.gridLeft - 1, 1)
      }
      if (pitch % 12 === 0) {
        ctx.font = FONT_LABEL
        ctx.fillStyle = '#2a3140'
        ctx.textBaseline = 'middle'
        const keyWidth = black ? (layout.gridLeft - 1) * 0.66 : layout.gridLeft
        ctx.fillText(pitchToName(pitch), 6, y + h / 2)
        void keyWidth
      }
    }

    // 音阶锁定：调内琴键加琥珀底色，一眼能看出可写音级
    if (scene.scaleLock && !scene.isDrum && isInScale(pitch, scene.keyName, scene.scale)) {
      ctx.fillStyle = black ? 'rgba(240,180,41,0.26)' : 'rgba(240,180,41,0.15)'
      ctx.fillRect(0, y, layout.gridLeft - 1, h)
      ctx.fillStyle = 'rgba(240,180,41,0.55)'
      ctx.fillRect(layout.gridLeft - 2, y, 1, h)
    }

    if (scene.pressedPitch === pitch) {
      ctx.fillStyle = 'rgba(240,180,41,0.5)'
      ctx.fillRect(0, y, layout.gridLeft - 1, h)
    } else if (scene.hoverPitch === pitch) {
      ctx.fillStyle = 'rgba(240,180,41,0.18)'
      ctx.fillRect(0, y, layout.gridLeft - 1, h)
    }
  }

  // 右边界
  ctx.fillStyle = 'rgba(255,255,255,0.12)'
  ctx.fillRect(layout.gridLeft - 1, 0, 1, layout.gridHeight)
  // 力度区左侧标签（隐藏力度条时不占空间）
  if (layout.velocityHeight > 0) {
    ctx.fillStyle = '#0a0d13'
    ctx.fillRect(0, layout.velocityTop, layout.gridLeft, layout.velocityHeight)
    ctx.font = FONT_SMALL
    ctx.fillStyle = 'rgba(108,119,137,0.85)'
    ctx.textBaseline = 'middle'
    ctx.fillText('VEL', 8, layout.velocityTop + 14)
    ctx.save()
    ctx.translate(14, layout.velocityTop + layout.velocityHeight - 14)
    ctx.rotate(-Math.PI / 2)
    ctx.fillStyle = 'rgba(74,84,102,0.9)'
    ctx.fillText('力度', 0, 0)
    ctx.restore()
  }

  void beatToX
}

/* ------------------------------------------------------------------ */
/* 力度条                                                              */
/* ------------------------------------------------------------------ */

function drawVelocityLane(ctx: CanvasRenderingContext2D, scene: PianoRollScene): void {
  const { layout, pxPerBeat, scrollBeat } = scene
  const top = layout.velocityTop
  const height = layout.velocityHeight - 6
  const baseline = top + height + 2

  ctx.save()
  ctx.beginPath()
  ctx.rect(layout.gridLeft, top, layout.gridWidth, layout.velocityHeight)
  ctx.clip()

  ctx.fillStyle = '#080b10'
  ctx.fillRect(layout.gridLeft, top, layout.gridWidth, layout.velocityHeight)
  ctx.fillStyle = 'rgba(255,255,255,0.07)'
  ctx.fillRect(layout.gridLeft, top, layout.gridWidth, 1)

  // 与主网格对齐的纵向节拍线
  const subdivision = scene.gridDivision === 'half' ? 0.5 : scene.gridDivision === 'triplet' ? 1 / 3 : 1
  const firstBeat = Math.floor(scrollBeat / subdivision) * subdivision
  const lastBeat = scrollBeat + layout.gridWidth / pxPerBeat
  for (let beat = firstBeat; beat <= lastBeat + subdivision; beat += subdivision) {
    const isBar = Math.abs(beat / scene.barBeats - Math.round(beat / scene.barBeats)) < 1e-6
    const isBeatLine = Math.abs(beat - Math.round(beat)) < 1e-6
    if (!isBar && !isBeatLine && subdivision >= 0.5) continue
    const x = Math.round(layout.gridLeft + (beat - scrollBeat) * pxPerBeat) + 0.5
    if (x < layout.gridLeft || x > layout.width) continue
    ctx.fillStyle = isBar ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.035)'
    ctx.fillRect(x, top, 1, layout.velocityHeight)
  }

  // 背景参考线（力度 32 / 64 / 96 / 127）
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'
  ctx.lineWidth = 1
  for (const reference of [32, 64, 96, 127]) {
    const y = Math.round(baseline - (reference / 127) * height) + 0.5
    ctx.beginPath()
    ctx.moveTo(layout.gridLeft, y)
    ctx.lineTo(layout.width, y)
    ctx.stroke()
  }

  const visibleStart = scrollBeat - 1
  const visibleEnd = scrollBeat + layout.gridWidth / pxPerBeat + 1
  const barWidth = clamp(pxPerBeat * 0.28, 2, 7)

  for (const note of scene.notes) {
    if (note.start + note.duration < visibleStart || note.start > visibleEnd) continue
    const x = layout.gridLeft + (note.start - scrollBeat) * pxPerBeat
    if (x > layout.width || x + barWidth < layout.gridLeft) continue
    const velocity = scene.velocityPreview?.[note.id] ?? note.velocity
    const isSelected = scene.selected.has(note.id)
    const barHeight = Math.max(2, (clamp(velocity, 1, 127) / 127) * height)
    ctx.fillStyle = isSelected ? '#f0b429' : withAlpha(scene.color, 0.55 + (velocity / 127) * 0.4)
    ctx.fillRect(x, baseline - barHeight, barWidth, barHeight)
    if (isSelected) {
      ctx.fillStyle = 'rgba(255,230,163,0.95)'
      ctx.fillRect(x, baseline - barHeight, barWidth, 1.5)
    }
  }

  ctx.restore()

  // 分隔线
  ctx.fillStyle = 'rgba(255,255,255,0.08)'
  ctx.fillRect(0, top, layout.width, 1)
}

/* ------------------------------------------------------------------ */
/* 横向滚动条                                                          */
/* ------------------------------------------------------------------ */

function drawScrollbar(ctx: CanvasRenderingContext2D, scene: PianoRollScene): void {
  const { layout } = scene
  ctx.fillStyle = '#0a0d13'
  ctx.fillRect(0, layout.scrollbarTop, layout.width, layout.scrollbarHeight)
  ctx.fillStyle = 'rgba(255,255,255,0.04)'
  ctx.fillRect(layout.gridLeft, layout.scrollbarTop + 4, layout.gridWidth, 3)
  if (scene.scrollThumb) {
    const { left, width } = scene.scrollThumb
    ctx.fillStyle = 'rgba(163,173,192,0.35)'
    roundedRect(ctx, layout.gridLeft + left, layout.scrollbarTop + 2, Math.max(18, width), 7, 3.5)
    ctx.fill()
  }
}

/* ------------------------------------------------------------------ */
/* 拖拽信息浮层                                                        */
/* ------------------------------------------------------------------ */

function drawTooltip(ctx: CanvasRenderingContext2D, tooltip: DragTooltip, layout: PianoRollLayout): void {
  if (tooltip.lines.length === 0) return
  const padding = 7
  const lineHeight = 14
  ctx.font = '11px "Inter", "PingFang SC", system-ui, sans-serif'
  let textWidth = 0
  for (const line of tooltip.lines) textWidth = Math.max(textWidth, ctx.measureText(line).width)
  const width = Math.min(layout.width - 16, textWidth + padding * 2)
  const height = tooltip.lines.length * lineHeight + padding * 2 - 3
  let x = tooltip.x + 16
  let y = tooltip.y + 18
  if (x + width > layout.width - 8) x = tooltip.x - width - 12
  if (y + height > layout.height - 8) y = tooltip.y - height - 12
  x = clamp(x, 8, Math.max(8, layout.width - width - 8))
  y = clamp(y, 8, Math.max(8, layout.height - height - 8))
  roundedRect(ctx, x, y, width, height, 6)
  ctx.fillStyle = 'rgba(9,12,18,0.95)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(240,180,41,0.45)'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = 'rgba(240,245,255,0.95)'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  tooltip.lines.forEach((line, index) => {
    ctx.fillText(line, x + padding, y + padding + index * lineHeight)
  })
}
