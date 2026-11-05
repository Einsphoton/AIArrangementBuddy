/** Agent 工具注册表：权限过滤、描述转换、统一执行入口、工具名别名兜底。 */
import type { ProviderTool } from '../providers/types.js'
import { ARRANGE_TOOLS } from './arrange.js'
import { EDIT_TOOLS } from './edit.js'
import { PROJECT_TOOLS } from './project.js'
import { THEORY_TOOLS } from './theory.js'
import { UI_TOOLS } from './ui.js'
import { WEB_TOOLS } from './web.js'
import { errorMessage, truncate } from '../util.js'
import type { ToolContext, ToolDef, ToolResult } from './schema.js'
import { normalizeToolArgs } from './validate.js'

export * from './schema.js'
export { projectSummaryData, projectSummaryText, clipNotesSummary, scaleLabel } from './summary.js'

/** 全部工具（顺序会影响模型看到的工具列表，PROJECT → 编辑 → 界面 → 编排 → 乐理 → 联网） */
export const ALL_TOOLS: ToolDef[] = [
  ...PROJECT_TOOLS,
  ...EDIT_TOOLS,
  ...UI_TOOLS,
  ...ARRANGE_TOOLS,
  ...THEORY_TOOLS,
  ...WEB_TOOLS,
]

const byName = new Map(ALL_TOOLS.map((tool) => [tool.name, tool]))

export function getTool(name: string): ToolDef | undefined {
  return byName.get(name)
}

/* ------------------------------ 工具名别名 ------------------------------ */

/**
 * 工具别名：模型经常会「自创」工具名（add_drums / duplicate_clip / set_volume …），
 * 以前会直接「未知工具」失败。这里映射到真实工具，并可补默认参数。
 */
export interface ToolAlias {
  /** 真实工具名 */
  name: string
  /** 命中别名时补的默认参数（模型显式传的参数优先） */
  args?: Record<string, unknown>
}

export const TOOL_ALIASES: Record<string, ToolAlias> = {
  // 生成类 → generate_smart_clip（补 kind）
  add_drum_groove: { name: 'generate_smart_clip', args: { kind: 'drums' } },
  add_drums: { name: 'generate_smart_clip', args: { kind: 'drums' } },
  add_drum_pattern: { name: 'generate_smart_clip', args: { kind: 'drums' } },
  add_drum_loop: { name: 'generate_smart_clip', args: { kind: 'drums' } },
  add_bass: { name: 'generate_smart_clip', args: { kind: 'bass' } },
  add_bass_line: { name: 'generate_smart_clip', args: { kind: 'bass' } },
  add_bassline: { name: 'generate_smart_clip', args: { kind: 'bass' } },
  add_chords: { name: 'generate_smart_clip', args: { kind: 'chords' } },
  add_chord_progression: { name: 'generate_smart_clip', args: { kind: 'chords' } },
  add_pad: { name: 'generate_smart_clip', args: { kind: 'pad' } },
  add_arp: { name: 'generate_smart_clip', args: { kind: 'arp' } },
  add_arpeggio: { name: 'generate_smart_clip', args: { kind: 'arp' } },
  add_melody: { name: 'generate_smart_clip', args: { kind: 'melody' } },
  add_lead: { name: 'generate_smart_clip', args: { kind: 'melody' } },
  add_riff: { name: 'generate_smart_clip', args: { kind: 'riff' } },
  add_rhythm_guitar: { name: 'generate_smart_clip', args: { kind: 'riff' } },
  add_strum: { name: 'generate_smart_clip', args: { kind: 'strum' } },
  add_counter: { name: 'generate_smart_clip', args: { kind: 'counter' } },
  add_countermelody: { name: 'generate_smart_clip', args: { kind: 'counter' } },
  // 编辑类
  duplicate_clip: { name: 'copy_clip' },
  transpose_notes: { name: 'transpose_clip' },
  quantize_notes: { name: 'quantize_clip' },
  humanize_notes: { name: 'humanize_clip' },
  // 轨道属性 → update_track / set_instrument
  set_volume: { name: 'update_track' },
  mute_track: { name: 'update_track', args: { mute: true } },
  rename_track: { name: 'update_track' },
  set_track_instrument: { name: 'set_instrument' },
}

/** 别名查表 key：大小写 / 空格 / 下划线 / 连字符都不敏感（AddDrums == add_drums） */
function normalizeAliasKey(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, '')
}

const aliasByKey = new Map<string, ToolAlias>()
for (const [key, alias] of Object.entries(TOOL_ALIASES)) {
  aliasByKey.set(normalizeAliasKey(key), alias)
}

/** 解析 AI 自创的工具名：命中别名返回真实工具名（+默认参数），否则 null */
export function resolveToolAlias(name: string): ToolAlias | null {
  if (typeof name !== 'string' || !name.trim()) return null
  const alias = aliasByKey.get(normalizeAliasKey(name))
  if (!alias) return null
  return { name: alias.name, ...(alias.args ? { args: { ...alias.args } } : {}) }
}

/** 别名调用时把模型常用的同义字段名映射到真实工具字段（不覆盖已传的规范字段） */
function remapAliasArgs(aliasName: string, args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args }
  const key = normalizeAliasKey(aliasName)
  const take = (...names: string[]): unknown => {
    for (const name of names) {
      const value = out[name]
      if (value !== undefined && value !== null && value !== '') return value
    }
    return undefined
  }
  switch (key) {
    case 'setvolume': {
      if (out.volume === undefined) {
        const value = take('value', 'level', 'vol', 'gain')
        if (value !== undefined) out.volume = value
      }
      break
    }
    case 'mutetrack': {
      if (out.mute === undefined) {
        const value = take('muted', 'isMuted')
        if (value !== undefined) out.mute = value
      }
      break
    }
    case 'renametrack': {
      if (out.name === undefined) {
        const value = take('newName', 'title', 'newTitle')
        if (value !== undefined) out.name = value
      }
      break
    }
    case 'settrackinstrument': {
      if (out.instrumentId === undefined) {
        const value = take('instrument', 'id')
        if (value !== undefined) out.instrumentId = value
      }
      if (out.emotionId === undefined) {
        const value = take('emotion')
        if (value !== undefined) out.emotionId = value
      }
      break
    }
    case 'transposenotes': {
      if (out.semitones === undefined) {
        const value = take('transpose', 'amount', 'steps', 'interval')
        if (value !== undefined) out.semitones = value
      }
      break
    }
    case 'duplicateclip':
    case 'quantizenotes':
    case 'humanizenotes': {
      if (out.clipId === undefined) {
        const value = take('sourceClipId', 'id', 'clip')
        if (value !== undefined) out.clipId = value
      }
      break
    }
    default:
      break
  }
  return out
}

/** 按权限过滤：禁用工程修改时只保留只读工具；禁用联网时去掉 web 工具 */
export function toolsForContext(ctx: Pick<ToolContext, 'allowProjectEdits' | 'allowWebSearch'>): ToolDef[] {
  return ALL_TOOLS.filter((tool) => {
    if (tool.web && !ctx.allowWebSearch) return false
    if (!tool.readOnly && !ctx.allowProjectEdits) return false
    return true
  })
}

/** 转成服务商 function-calling 使用的工具描述 */
export function toProviderTools(tools: ToolDef[]): ProviderTool[] {
  return tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
}

export function toolTitle(name: string): string {
  const resolved = resolveToolAlias(name)
  return byName.get(resolved?.name ?? name)?.title ?? name
}

/** 从参数里提取一句人类可读摘要（工具卡片副标题 / 日志） */
export function describeToolArgs(args: Record<string, unknown>): string {
  const parts: string[] = []
  for (const key of [
    'trackId',
    'clipId',
    'clipIds',
    'instrumentId',
    'emotionId',
    'kind',
    'style',
    'tempo',
    'key',
    'scale',
    'bar',
    'bars',
    'query',
    'url',
    'mode',
    'semitones',
    'grid',
    'swing',
    'count',
    'shape',
    'fromBar',
    'toBar',
    'action',
    'view',
  ]) {
    const value = args[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}=${String(value).slice(0, 40)}`)
    } else if (Array.isArray(value)) {
      parts.push(`${key}=[${value.length}]`)
    }
  }
  return parts.slice(0, 4).join(' · ')
}

/* --------------------------------- 执行入口 --------------------------------- */

/** 执行工具：支持工具名别名；任何异常都转换成结构化失败结果，绝不把 Agent 循环搞崩 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const resolved = resolveToolAlias(name)
  const toolName = resolved?.name ?? name
  const tool = getTool(toolName)
  if (!tool) {
    return { ok: false, message: `未知工具：${name}（可用工具：${ALL_TOOLS.map((item) => item.name).join(', ')}）` }
  }
  if (tool.web && !ctx.allowWebSearch) return { ok: false, message: '设置中已禁用联网搜索' }
  if (!tool.readOnly && !ctx.allowProjectEdits) return { ok: false, message: '设置中已禁用工程修改' }
  try {
    // 别名：补默认参数 + 同义字段名映射（模型显式传的规范字段优先）
    const incoming = resolved ? remapAliasArgs(name, { ...(resolved.args ?? {}), ...(args ?? {}) }) : (args ?? {})
    // 统一归一化 + 必填校验：handler 之前完成，校验失败绝不半执行
    const normalized = normalizeToolArgs(tool, incoming, ctx)
    if (!normalized.ok) {
      const prefix = resolved ? `（已将 ${name} 按 ${toolName} 执行）` : ''
      return { ok: false, message: `${prefix}${normalized.message ?? `工具 ${name} 的参数无效`}` }
    }
    const result = await tool.handler(normalized.args, ctx)
    if (!result || typeof result !== 'object') return { ok: false, message: `工具 ${name} 返回了无效结果` }
    if (resolved) return { ...result, message: `（已将 ${name} 按 ${toolName} 执行）${result.message}` }
    return result
  } catch (error) {
    return { ok: false, message: `工具 ${name} 执行失败：${errorMessage(error)}` }
  }
}

/** 工具结果 -> 交给模型阅读的文本（控制 token） */
export function toolResultForModel(result: ToolResult, maxChars = 4000): string {
  const payload = {
    ok: result.ok,
    message: result.message,
    ...(result.data === undefined ? {} : { data: result.data }),
  }
  let text: string
  try {
    text = JSON.stringify(payload)
  } catch {
    text = JSON.stringify({ ok: result.ok, message: result.message })
  }
  return truncate(text, maxChars)
}

/** 工具结果 -> 前端 tool_end 卡片的文本（更短） */
export function toolResultForUi(result: ToolResult, maxChars = 1200): string {
  return truncate(result.message, maxChars)
}
