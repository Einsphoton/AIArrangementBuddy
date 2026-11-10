/**
 * Studio 元信息：从工程数据里「读」出风格 / 调式等展示信息。
 *
 * 工程数据模型里没有工程级 style 字段（避免改 schema），
 * 但 composeProject 生成的智能片段都带着生成时的 style 快照，
 * 所以用「出现次数最多的片段风格」作为工程风格推断；
 * 无法推断时返回 null，由 UI 显示「未标注」。
 */
import { SCALES, STYLES, type Project, type ScaleId, type StyleId } from '@aiab/core'

/** 从所有片段的 smart.style 里推断工程风格（出现最多者优先），推断不出返回 null */
export function inferProjectStyle(project: Project): StyleId | null {
  const counts = new Map<StyleId, number>()
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const style = clip.smart?.style
      if (typeof style !== 'string' || !(style in STYLES)) continue
      const id = style as StyleId
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  }
  let best: StyleId | null = null
  let bestCount = 0
  for (const [style, count] of counts) {
    if (count > bestCount) {
      best = style
      bestCount = count
    }
  }
  return best
}

/**
 * 工程主风格：优先读 project.style（Studio 向导落盘的创作意图），
 * 老工程没有该字段时按片段 smart.style 推断，仍推断不出返回 null。
 */
export function resolveProjectStyle(project: Project): StyleId | null {
  const declared = project.style
  if (typeof declared === 'string' && declared in STYLES) return declared as StyleId
  return inferProjectStyle(project)
}

/** 风格中文名；未知风格返回 null（由 UI 决定显示占位文案） */
export function styleLabel(style: StyleId | null): string | null {
  if (!style) return null
  return STYLES[style]?.name ?? null
}

/** 「A 自然小调」这种调式标签；scale 非法时退回原始字符串 */
export function keyScaleLabel(key: string, scale: string): string {
  const definition = SCALES[scale as ScaleId]
  return definition ? `${key} ${definition.name}` : `${key} ${scale}`
}