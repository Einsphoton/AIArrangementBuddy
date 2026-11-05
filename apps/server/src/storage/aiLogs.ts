/**
 * AI 生成运行日志：每次 /api/ai/chat 都落一条结构化记录到 data/logs/ai-runs-<date>.jsonl。
 *
 * 目的：用户/开发者反馈「AI 生成失败」时可以直接抓到日志定位，而不是只有屏幕上的红卡片。
 *
 * 记录内容：
 * - 运行身份：runId / backend / model / intent / 工程 id 与名称 / 会话消息数
 * - 逐次调用：每次工具调用的名字、参数摘要、耗时、ok / 失败原因
 * - 服务商：每轮请求耗时、工具调用数、是否被 max_tokens 截断、自动重试（次数/状态码/退避）
 * - 输出：文本/推理字符数、usage、工程快照次数与最终工程统计
 * - 结果：ok / error / timeout / aborted / interrupted + 错误信息
 *
 * 日志只写本地 data 目录（已在 .gitignore 中），自动保留最近 14 天、单文件 8MB。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { beatsPerBar, type Project } from '@aiab/core'
import { aiLogsDir } from '../config.js'

export interface AiRunToolRecord {
  id?: string
  name: string
  ok: boolean
  durationMs: number
  /** 参数的人类可读摘要（不是完整 JSON，避免日志过大） */
  args?: string
  error?: string
  /** 成功结果的简短预览 */
  result?: string
}

export interface AiRunProviderCall {
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

export interface AiRunProviderRetry {
  round: number
  attempt: number
  status?: number
  delayMs: number
  message: string
}

export interface AiRunProjectStats {
  tracks: number
  clips: number
  notes: number
  bars: number
  tempo: number
  key: string
  scale: string
  chords: number
  sections: number
}

export type AiRunOutcome = 'ok' | 'error' | 'timeout' | 'aborted' | 'interrupted'

export interface AiRunLogEntry {
  version: 1
  runId: string
  startedAt: string
  finishedAt: string
  elapsedMs: number
  outcome: AiRunOutcome
  backend?: string
  model?: string
  intent?: string
  projectId?: string
  projectName?: string
  messageCount: number
  textChars: number
  reasoningChars: number
  toolCallCount: number
  toolFailureCount: number
  toolCalls: AiRunToolRecord[]
  providerCalls: AiRunProviderCall[]
  providerRetries: AiRunProviderRetry[]
  projectEvents: number
  usage?: { inputTokens?: number; outputTokens?: number }
  error?: string
  finalProject?: AiRunProjectStats
  /** 生成结束后的工程质量自检摘要（由调用方注入审计函数） */
  quality?: {
    issueCount: number
    high: number
    medium: number
    low: number
    issues: { code: string; severity: string; message: string; trackId?: string; clipId?: string }[]
  }
  /** 是否触发过质量自动修复（模型被要求修复新引入的问题） */
  qualityRepair?: { triggered: boolean; issueCount: number; repaired: boolean }
  /** 模型最终回复的开头片段（便于排查「AI 说做不到 / 只回了半句」） */
  textPreview?: string
  /** 推理过程片段（开头 400 字符；便于排查「AI 想做但应用不支持」类问题） */
  reasoningPreview?: string
}

/* ------------------------------ 文件读写 ------------------------------ */

const MAX_FILE_BYTES = 8 * 1024 * 1024
const RETENTION_DAYS = 14
const FILE_PREFIX = 'ai-runs-'

function ensureLogsDir(): void {
  if (!existsSync(aiLogsDir)) mkdirSync(aiLogsDir, { recursive: true })
}

function dateStamp(date = new Date()): string {
  return date.toISOString().slice(0, 10)
}

function pruneOldLogs(now = Date.now()): void {
  let files: string[]
  try {
    files = readdirSync(aiLogsDir)
  } catch {
    return
  }
  const retentionMs = RETENTION_DAYS * 24 * 60 * 60 * 1000
  for (const file of files) {
    if (!file.startsWith(FILE_PREFIX)) continue
    const full = path.join(aiLogsDir, file)
    try {
      const stat = statSync(full)
      if (now - stat.mtimeMs > retentionMs) rmSync(full, { force: true })
    } catch {
      /* 忽略单个文件失败 */
    }
  }
}

/** 追加一条运行日志；失败不影响主流程（返回结构化结果便于调用方忽略） */
export function appendAiRunLog(entry: AiRunLogEntry): { ok: boolean; file?: string; error?: string } {
  try {
    ensureLogsDir()
    const file = path.join(aiLogsDir, `${FILE_PREFIX}${dateStamp()}.jsonl`)
    // 单文件超过上限就滚动到 .1（保留当天旧日志，新的继续写主文件）
    try {
      if (existsSync(file) && statSync(file).size > MAX_FILE_BYTES) {
        rmSync(`${file}.1`, { force: true })
        renameSync(file, `${file}.1`)
      }
    } catch {
      /* 滚动失败不影响写入 */
    }
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
    pruneOldLogs()
    return { ok: true, file }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 日志文件列表（新的在前） */
export function aiLogFiles(): { name: string; size: number; modifiedAt: string }[] {
  try {
    return readdirSync(aiLogsDir)
      .filter((file) => file.startsWith(FILE_PREFIX) && file.endsWith('.jsonl'))
      .map((file) => {
        const stat = statSync(path.join(aiLogsDir, file))
        return { name: file, size: stat.size, modifiedAt: new Date(stat.mtimeMs).toISOString() }
      })
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  } catch {
    return []
  }
}

/**
 * 读取最近的运行日志（新的在前）。
 * - limit：最多返回多少条
 * - failedOnly：只要有工具失败或运行失败就返回
 * - runId：只返回某个 run
 */
export function listAiRunLogs(options: { limit?: number; failedOnly?: boolean; runId?: string } = {}): AiRunLogEntry[] {
  const limit = Math.min(Math.max(Math.round(options.limit ?? 20), 1), 500)
  const files = aiLogFiles()
  const entries: AiRunLogEntry[] = []
  for (const file of files) {
    let lines: string[]
    try {
      lines = readFileSync(path.join(aiLogsDir, file.name), 'utf8').split('\n')
    } catch {
      continue
    }
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]?.trim()
      if (!line) continue
      let entry: AiRunLogEntry
      try {
        entry = JSON.parse(line) as AiRunLogEntry
      } catch {
        continue
      }
      if (options.runId && entry.runId !== options.runId) continue
      const failed = entry.outcome !== 'ok' || entry.toolFailureCount > 0
      if (options.failedOnly && !failed) continue
      entries.push(entry)
      if (entries.length >= limit) return entries
    }
  }
  return entries
}

/* ------------------------------ 运行记录器 ------------------------------ */

/** 参数摘要：只保留可读的短字段，避免日志里塞满完整 JSON */
export function summarizeToolArgs(args: Record<string, unknown> | undefined, maxChars = 180): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const preferred = ['trackId', 'clipId', 'instrumentId', 'emotionId', 'kind', 'style', 'mode', 'tempo', 'key', 'scale', 'query', 'url', 'name', 'bars', 'startBeat', 'replaceClipId']
  const parts: string[] = []
  for (const key of preferred) {
    const value = args[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}=${String(value).slice(0, 40)}`)
    } else if (Array.isArray(value)) {
      parts.push(`${key}=[${value.length}]`)
    }
  }
  let summary = parts.join(' · ')
  if (!summary) {
    try {
      summary = JSON.stringify(args)
    } catch {
      summary = String(args)
    }
  }
  return summary.length > maxChars ? `${summary.slice(0, maxChars - 1)}…` : summary
}

function shortText(text: string | undefined, maxChars = 160): string | undefined {
  if (!text) return undefined
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return undefined
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 1)}…` : compact
}

interface PendingTool {
  name: string
  args?: Record<string, unknown>
  startedAt: number
}

export interface RunLogSeed {
  runId: string
  /** 初始工程（用于最终工程统计对比） */
  initialProject: unknown
  intent?: string
  messageCount: number
  /** 工程质量审计函数（由 routes 注入，避免 storage 反向依赖 agent） */
  auditQuality?: (project: unknown) => AiRunLogEntry['quality'] | undefined
}

export interface RunLogBuilder {
  /** 消费一条 SSE 事件（与发给前端的完全一致） */
  onEvent(event: string, data: unknown): void
  /** 消费 Agent/服务商内部记录（provider_call / provider_retry） */
  onLog(record: unknown): void
  /** 记录质量自动修复状态 */
  setQualityRepair(info: NonNullable<AiRunLogEntry['qualityRepair']>): void
  /** 收尾并落盘；返回写入结果 */
  finish(options: { outcome: AiRunOutcome; error?: string }): { ok: boolean; file?: string; error?: string }
}

function projectStats(project: unknown): AiRunProjectStats | undefined {
  const value = project as Partial<Project> & {
    tracks?: { clips?: { startBeat?: number; lengthBeats?: number; notes?: unknown[] }[] }[]
  }
  if (!value || !Array.isArray(value.tracks)) return undefined
  let clips = 0
  let notes = 0
  let endBeat = 0
  const barBeats = beatsPerBar(value.timeSignature ?? { numerator: 4, denominator: 4 })
  for (const track of value.tracks) {
    for (const clip of track.clips ?? []) {
      clips++
      notes += clip.notes?.length ?? 0
      endBeat = Math.max(endBeat, (clip.startBeat ?? 0) + (clip.lengthBeats ?? 0))
    }
  }
  return {
    tracks: value.tracks.length,
    clips,
    notes,
    bars: Math.max(1, Math.round(endBeat / barBeats)),
    tempo: value.tempo ?? 0,
    key: value.key ?? '',
    scale: value.scale ?? '',
    chords: value.chords?.length ?? 0,
    sections: value.sections?.length ?? 0,
  }
}

/** 创建一个运行记录器（每个 /api/ai/chat 请求一个） */
export function createRunLogBuilder(seed: RunLogSeed): RunLogBuilder {
  const startedAtDate = new Date()
  const startedAt = Date.now()
  let backend: string | undefined
  let model: string | undefined
  let textChars = 0
  let reasoningChars = 0
  /** 只保留尾部片段用于排查，避免日志过大 */
  let textTail = ''
  let reasoningHead = ''
  let projectEvents = 0
  let finalProject: unknown = seed.initialProject
  let errorMessage: string | undefined
  let usage: AiRunLogEntry['usage']
  const toolCalls: AiRunToolRecord[] = []
  const pending = new Map<string, PendingTool>()
  const providerCalls: AiRunProviderCall[] = []
  const providerRetries: AiRunProviderRetry[] = []
  let qualityRepair: AiRunLogEntry['qualityRepair']
  let finished = false

  const initial = seed.initialProject as { id?: string; name?: string }
  const projectId = initial?.id
  const projectName = initial?.name

  return {
    onEvent(event, data) {
      const payload = (data ?? {}) as Record<string, unknown>
      switch (event) {
        case 'start': {
          backend = typeof payload.backend === 'string' ? payload.backend : backend
          model = typeof payload.model === 'string' ? payload.model : model
          break
        }
        case 'text': {
          if (typeof payload.delta === 'string') {
            textChars += payload.delta.length
            textTail = `${textTail}${payload.delta}`.slice(-800)
          }
          break
        }
        case 'reasoning': {
          if (typeof payload.delta === 'string') {
            reasoningChars += payload.delta.length
            if (reasoningHead.length < 400) reasoningHead = `${reasoningHead}${payload.delta}`.slice(0, 400)
          }
          break
        }
        case 'tool_start': {
          const id = typeof payload.id === 'string' ? payload.id : `idx_${pending.size}`
          pending.set(id, {
            name: typeof payload.name === 'string' ? payload.name : 'unknown',
            args: payload.args && typeof payload.args === 'object' ? (payload.args as Record<string, unknown>) : undefined,
            startedAt: Date.now(),
          })
          break
        }
        case 'tool_end': {
          const id = typeof payload.id === 'string' ? payload.id : ''
          const started = pending.get(id)
          pending.delete(id)
          toolCalls.push({
            id,
            name: started?.name ?? 'unknown',
            ok: payload.ok !== false,
            durationMs: started ? Date.now() - started.startedAt : 0,
            args: summarizeToolArgs(started?.args),
            error: payload.ok === false ? shortText(typeof payload.error === 'string' ? payload.error : undefined, 240) : undefined,
            result: payload.ok !== false ? shortText(typeof payload.result === 'string' ? payload.result : undefined, 160) : undefined,
          })
          break
        }
        case 'project': {
          projectEvents++
          if (payload.project) finalProject = payload.project
          break
        }
        case 'error': {
          errorMessage = typeof payload.message === 'string' ? payload.message : errorMessage
          break
        }
        case 'done': {
          const nextUsage = payload.usage as AiRunLogEntry['usage'] | undefined
          if (nextUsage) usage = nextUsage
          break
        }
        default:
          break
      }
    },

    onLog(record) {
      const value = (record ?? {}) as Record<string, unknown>
      if (value.type === 'provider_call') {
        providerCalls.push({
          round: typeof value.round === 'number' ? value.round : providerCalls.length + 1,
          durationMs: typeof value.durationMs === 'number' ? value.durationMs : 0,
          toolCalls: typeof value.toolCalls === 'number' ? value.toolCalls : 0,
          textChars: typeof value.textChars === 'number' ? value.textChars : 0,
          reasoningChars: typeof value.reasoningChars === 'number' ? value.reasoningChars : 0,
          truncated: value.truncated === true || undefined,
          maxTokens: typeof value.maxTokens === 'number' ? value.maxTokens : undefined,
          escalated: value.escalated === true || undefined,
        })
      } else if (value.type === 'provider_retry') {
        providerRetries.push({
          round: typeof value.round === 'number' ? value.round : providerCalls.length + 1,
          attempt: typeof value.attempt === 'number' ? value.attempt : 1,
          status: typeof value.status === 'number' ? value.status : undefined,
          delayMs: typeof value.delayMs === 'number' ? value.delayMs : 0,
          message: shortText(typeof value.message === 'string' ? value.message : '') ?? '',
        })
      }
    },

    setQualityRepair(info) {
      qualityRepair = info
    },

    finish(options) {
      if (finished) return { ok: false, error: 'already finished' }
      finished = true
      const toolFailureCount = toolCalls.filter((call) => !call.ok).length
      let quality: AiRunLogEntry['quality']
      if (seed.auditQuality) {
        try {
          quality = seed.auditQuality(finalProject)
        } catch {
          /* 质量审计失败不影响日志落盘 */
        }
      }
      const entry: AiRunLogEntry = {
        version: 1,
        runId: seed.runId,
        startedAt: startedAtDate.toISOString(),
        finishedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        outcome: options.outcome,
        backend,
        model,
        intent: seed.intent,
        projectId,
        projectName,
        messageCount: seed.messageCount,
        textChars,
        reasoningChars,
        toolCallCount: toolCalls.length,
        toolFailureCount,
        toolCalls,
        providerCalls,
        providerRetries,
        projectEvents,
        usage,
        error: shortText(options.error ?? errorMessage, 400),
        finalProject: projectStats(finalProject),
        quality,
        qualityRepair,
        textPreview: shortText(textTail, 500),
        reasoningPreview: shortText(reasoningHead, 400),
      }
      return appendAiRunLog(entry)
    },
  }
}
