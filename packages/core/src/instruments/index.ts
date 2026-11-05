import type { StyleId } from '../constants.js'
import { STYLES } from '../constants.js'
import { INSTRUMENT_CATALOG } from './catalog.js'
import type { EmotionPreset, InstrumentDefinition } from './types.js'

export * from './types.js'
export * from './helpers.js'
export { INSTRUMENT_CATALOG }

const BY_ID = new Map<string, InstrumentDefinition>()
for (const inst of INSTRUMENT_CATALOG) BY_ID.set(inst.id, inst)

/** 按 id 取乐器；未知 id 时返回钢琴兜底，保证 UI 不崩 */
export function getInstrument(id: string): InstrumentDefinition {
  return BY_ID.get(id) ?? INSTRUMENT_CATALOG[0]
}

export function hasInstrument(id: string): boolean {
  return BY_ID.has(id)
}

/** 取乐器的某个情绪预设，未知时返回默认情绪 */
export function getEmotion(instrumentId: string, emotionId: string | undefined): EmotionPreset {
  const inst = getInstrument(instrumentId)
  return inst.emotions.find((e) => e.id === emotionId) ?? inst.emotions[0]
}

export function defaultEmotion(instrumentId: string): EmotionPreset {
  return getInstrument(instrumentId).emotions[0]
}

export function listInstruments(family?: InstrumentDefinition['family']): InstrumentDefinition[] {
  return family ? INSTRUMENT_CATALOG.filter((i) => i.family === family) : INSTRUMENT_CATALOG
}

export function instrumentsForStyle(style: StyleId): InstrumentDefinition[] {
  const meta = STYLES[style]
  const preferred = meta.recommendedInstruments
    .map((id) => BY_ID.get(id))
    .filter((i): i is InstrumentDefinition => Boolean(i))
  if (preferred.length >= 4) return preferred
  const rest = INSTRUMENT_CATALOG.filter((i) => !preferred.includes(i) && i.styles.includes(style))
  return [...preferred, ...rest]
}

/** 按 GM 程序号找最匹配的乐器（用于导入 MIDI 时映射） */
export function findInstrumentByProgram(gmProgram: number, isDrum: boolean): InstrumentDefinition | undefined {
  const pool = INSTRUMENT_CATALOG.filter((i) => i.isDrumKit === isDrum)
  let best: InstrumentDefinition | undefined
  let bestDist = Infinity
  for (const inst of pool) {
    const dist = Math.abs(inst.gmProgram - gmProgram)
    if (dist < bestDist) {
      bestDist = dist
      best = inst
    }
  }
  return best
}

/** 目录按 family 分组，UI 下拉框使用 */
export function groupedInstruments(): { family: string; label: string; items: InstrumentDefinition[] }[] {
  const labels: Record<string, string> = {
    classical: '古典 / 管弦',
    rock: '摇滚 / 流行',
    electronic: '电子',
    world: '民族 / 世界',
    drums: '鼓组',
  }
  const order: InstrumentDefinition['family'][] = ['classical', 'rock', 'electronic', 'world', 'drums']
  return order
    .map((family) => ({
      family,
      label: labels[family] ?? family,
      items: INSTRUMENT_CATALOG.filter((i) => i.family === family),
    }))
    .filter((g) => g.items.length > 0)
}
