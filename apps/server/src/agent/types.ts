/** Agent 运行时共享类型与 SSE 事件发射器（CONTRACTS §5）。 */
import type { AppSettings, Project } from '@aiab/core'
export type { TokenUsage } from '../providers/types.js'

export type AgentBackendId = 'builtin' | 'codex' | 'dsh'

export interface ChatHistoryMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface AgentAttachments {
  melodyTrackId?: string
  referenceClipId?: string
}

/** Agent / 服务商内部诊断记录：只写入 AI 运行日志，不发给前端 */
export type AgentLogRecord =
  | {
      type: 'provider_call'
      round: number
      durationMs: number
      toolCalls: number
      textChars: number
      reasoningChars: number
      truncated?: boolean
      /** 本次请求实际使用的 max_tokens 预算 */
      maxTokens?: number
      /** 是否是为了避开截断而自动加大预算后的重试 */
      escalated?: boolean
    }
  | {
      type: 'provider_retry'
      round: number
      attempt: number
      status?: number
      delayMs: number
      message: string
    }

export interface AgentRunRequest {
  runId: string
  messages: ChatHistoryMessage[]
  project: Project
  intent?: string
  attachments?: AgentAttachments
  settings: AppSettings
  signal: AbortSignal
  emit: AgentEmitter
  /** 诊断日志回调（失败不影响主流程） */
  log?: (record: AgentLogRecord) => void
  /** 质量自检自动修复的状态回报（写入运行日志） */
  reportQualityRepair?: (info: { triggered: boolean; issueCount: number; repaired: boolean }) => void
}

export type AgentEventWriter = (event: string, data: unknown) => void

/**
 * AI 请求前端执行的界面动作（`ui_action` 工具 -> SSE `event: ui`）。
 * 由 tools 层约定放在 ToolResult.data.uiAction 里，builtin Agent 原样转发给前端。
 */
export interface AgentUiAction {
  action: string
  /** 绝对拍：seek 目标位置（play 时可选：先跳转再播放） */
  beat?: number
  /** 视图：arrangement / pianoroll / mixer / smartclips */
  view?: string
  /** 片段 id：select_clip 目标 */
  clipId?: string
  /** 允许工具补充其它字段（前端会忽略不认识的字段） */
  [key: string]: unknown
}

/** 严格按前端 AgentStreamEvent 发事件，避免各 Backend 手写错字段 */
export interface AgentEmitter {
  raw: AgentEventWriter
  start(data: { runId: string; backend: string; model?: string }): void
  text(delta: string): void
  reasoning(delta: string): void
  toolStart(call: { id: string; name: string; args: Record<string, unknown>; title?: string }): void
  toolEnd(data: { id: string; ok: boolean; result?: string; error?: string; data?: unknown }): void
  project(project: Project, label: string): void
  /** AI 请求前端执行界面动作（播放/跳转/切视图…） */
  ui(action: AgentUiAction): void
  done(data: { runId: string; usage?: { inputTokens?: number; outputTokens?: number }; elapsedMs?: number }): void
  error(message: string): void
}

export function createEmitter(write: AgentEventWriter): AgentEmitter {
  return {
    raw: write,
    start(data) {
      write('start', data)
    },
    text(delta) {
      if (delta) write('text', { delta })
    },
    reasoning(delta) {
      if (delta) write('reasoning', { delta })
    },
    toolStart(call) {
      write('tool_start', { id: call.id, name: call.name, args: call.args, title: call.title })
    },
    toolEnd(data) {
      write('tool_end', data)
    },
    project(project, label) {
      write('project', { project, label })
    },
    ui(action) {
      write('ui', action)
    },
    done(data) {
      write('done', data)
    },
    error(message) {
      write('error', { message })
    },
  }
}

/** 已知但不可用 / 需要回退的错误（用于「诚实回退」逻辑） */
export class AgentUnavailableError extends Error {
  backend: AgentBackendId
  constructor(backend: AgentBackendId, message: string) {
    super(message)
    this.name = 'AgentUnavailableError'
    this.backend = backend
  }
}
