/** Agent 工具定义：JSON Schema 参数描述 + 统一返回结构（CONTRACTS §6）。 */
import type { AppSettings, Project } from '@aiab/core'

export type JsonSchemaObject = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolContext {
  /** 当前工程快照（工具以「不可变更新」方式返回新快照） */
  project: Project
  settings: AppSettings
  signal?: AbortSignal
  /** codex / dsh 的工作目录 */
  workdir?: string
  allowProjectEdits: boolean
  allowWebSearch: boolean
}

export interface ToolResult {
  ok: boolean
  message: string
  /** 修改了工程时必须返回完整新快照 */
  project?: Project
  data?: unknown
}

export interface ToolDef {
  name: string
  /** 中文展示名（前端工具卡片用） */
  title: string
  description: string
  parameters: JsonSchemaObject
  /** 只读工具（不修改工程） */
  readOnly?: boolean
  /** 需要联网 */
  web?: boolean
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}

/* ------------------------------ schema 小工具 ------------------------------ */

export function str(description: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'string', description, ...extra }
}

export function num(description: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'number', description, ...extra }
}

export function int(description: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'integer', description, ...extra }
}

export function bool(description: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'boolean', description, ...extra }
}

export function enm(description: string, values: readonly string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'string', description, enum: [...values], ...extra }
}

export function arr(description: string, items: Record<string, unknown>): Record<string, unknown> {
  return { type: 'array', description, items }
}

export function obj(
  description: string,
  properties: Record<string, unknown>,
  required?: string[],
): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: 'object', description, properties }
  if (required?.length) schema.required = required
  return schema
}

export function toolSchema(properties: Record<string, unknown>, required?: string[]): JsonSchemaObject {
  return { type: 'object', properties, required, additionalProperties: false }
}

/** 常用参数：trackId / clipId */
export const TRACK_ID = str('轨道 id（可从 get_project_summary 获取）')
export const CLIP_ID = str('片段 id（可从 get_project_summary 获取）')
