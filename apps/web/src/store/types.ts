import type { ChordSpec, NoteEvent, Project, Section, TimeSignature, Track } from '@aiab/core'

export type ViewTab = 'arrangement' | 'pianoroll' | 'smartclips'

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

export interface ToolCallInfo {
  id: string
  name: string
  /** 展示用标题，如「创建轨道」 */
  title: string
  args: Record<string, unknown>
  status: 'running' | 'ok' | 'error'
  result?: string
  error?: string
  startedAt: number
  endedAt?: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  /** 深度思考内容（reasoning / thinking） */
  reasoning?: string
  toolCalls?: ToolCallInfo[]
  createdAt: number
  streaming?: boolean
  error?: string
  /** 这条消息是否改动了工程（用于「撤销 AI 修改」） */
  changedProject?: boolean
  model?: string
}

/** SSE 流事件协议 —— 服务端与前端共用 */
export type AgentStreamEvent =
  | { type: 'start'; runId: string; backend: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_start'; call: { id: string; name: string; args: Record<string, unknown>; title?: string } }
  | { type: 'tool_end'; id: string; ok: boolean; result?: string; error?: string }
  | { type: 'project'; project: Project; label: string }
  /** AI 请求前端执行的界面动作（ui_action 工具）：实际 SSE 事件为 event: ui + data */
  | { type: 'ui'; action: string; beat?: number; view?: string; clipId?: string }
  | { type: 'done'; runId: string; usage?: { inputTokens?: number; outputTokens?: number }; elapsedMs?: number }
  | { type: 'error'; message: string }

export interface ToastItem {
  id: string
  kind: 'info' | 'success' | 'error'
  message: string
}

export interface MidiDeviceInfo {
  id: string
  name: string
  manufacturer?: string
}

export type ExportFormat = 'mid' | 'wav' | 'mp3' | 'flac' | 'ogg'

export interface ExportJobState {
  id: string
  format: ExportFormat
  status: 'idle' | 'rendering' | 'uploading' | 'done' | 'error'
  progress: number
  url?: string
  filename?: string
  error?: string
}

/** 智能片段的 UI 参数（不含生成结果） */
export interface SmartClipDraft {
  trackId: string
  clipId: string
  kind: import('@aiab/core').SmartKind
  params: import('@aiab/core').SmartParams
  seed: number
}

export interface SelectionState {
  clipId: string | null
  noteIds: string[]
}

export interface ProjectHistoryEntry {
  project: Project
  label: string
  at: number
}

export type { ChordSpec, NoteEvent, Project, Section, TimeSignature, Track }
