/**
 * AI 对话路由：POST /api/ai/chat（SSE）+ POST /api/ai/cancel + GET /api/ai/logs。
 *
 * 关键点：
 * - 未配置 API Key / 服务商不可用时，仍然返回 200 + 结构化 error 事件（不是 500 崩溃）；
 * - 同一时间只跑一个 run，新请求会中止旧 run；
 * - 客户端断开 / 主动取消 / 超时都会中止下游（模型请求与 Codex 子进程）；
 * - 每次 run 都落一条结构化日志（data/logs/ai-runs-<date>.jsonl），可用 GET /api/ai/logs 抓取。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { projectSchema, type AppSettings, type Project } from '@aiab/core'
import { createEmitter, type ChatHistoryMessage } from '../agent/types.js'
import { runAgent } from '../agent/index.js'
import { auditProjectQuality } from '../agent/quality.js'
import { loadSettings } from '../storage/settings.js'
import { aiLogFiles, createRunLogBuilder, listAiRunLogs, type AiRunOutcome } from '../storage/aiLogs.js'
import { errorMessage } from '../util.js'
import { newId } from '@aiab/core'

interface ActiveRun {
  runId: string
  controller: AbortController
  startedAt: number
}

let activeRun: ActiveRun | null = null

interface ChatBody {
  messages?: unknown
  project?: unknown
  intent?: unknown
  attachments?: unknown
}

function parseMessages(raw: unknown): ChatHistoryMessage[] | null {
  if (!Array.isArray(raw)) return null
  const messages: ChatHistoryMessage[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const source = item as Record<string, unknown>
    const role = source.role
    const content = source.content
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue
    if (typeof content !== 'string') continue
    if (!content.trim() && role !== 'assistant') continue
    messages.push({ role, content })
  }
  return messages.length ? messages : null
}

function parseAttachments(raw: unknown): { melodyTrackId?: string; referenceClipId?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const source = raw as Record<string, unknown>
  const attachments: { melodyTrackId?: string; referenceClipId?: string } = {}
  if (typeof source.melodyTrackId === 'string') attachments.melodyTrackId = source.melodyTrackId
  if (typeof source.referenceClipId === 'string') attachments.referenceClipId = source.referenceClipId
  return Object.keys(attachments).length ? attachments : undefined
}

export function cancelActiveAiRun(): boolean {
  if (!activeRun) return false
  activeRun.controller.abort(new Error('用户取消'))
  activeRun = null
  return true
}

export function isAiRunActive(): boolean {
  return activeRun !== null
}

export function registerAiRoutes(app: FastifyInstance): void {
  app.post('/api/ai/chat', async (request: FastifyRequest<{ Body: ChatBody }>, reply: FastifyReply) => {
    const body = (request.body ?? {}) as ChatBody
    const settings: AppSettings = loadSettings()

    // 1) 校验工程快照（这是请求体错误，用普通 4xx JSON 返回）
    const parsedProject = projectSchema.safeParse(body.project)
    if (!parsedProject.success) {
      const issue = parsedProject.error.issues[0]
      return reply.code(400).send({
        error: `project 快照不合法：${issue ? `${issue.path.join('.')} ${issue.message}` : '未知错误'}`,
      })
    }
    const project = parsedProject.data as unknown as Project

    // 2) 校验消息
    const messages = parseMessages(body.messages)
    if (!messages) return reply.code(400).send({ error: 'messages 必须是非空数组，元素为 { role, content }' })

    const intent =
      typeof body.intent === 'string' &&
      ['compose', 'arrange', 'melody', 'chords', 'optimize', 'audio'].includes(body.intent)
        ? body.intent
        : undefined
    const attachments = parseAttachments(body.attachments)

    // 3) 并发保护：中止上一个 run
    if (activeRun) {
      activeRun.controller.abort(new Error('新的请求已开始'))
      activeRun = null
    }

    const runId = newId('run')
    const controller = new AbortController()
    const run: ActiveRun = { runId, controller, startedAt: Date.now() }
    activeRun = run

    // 4) 接管原始响应，开始 SSE
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    raw.write(': connected\n\n')

    // 诊断日志：每次 run 一条结构化记录（data/logs/ai-runs-<date>.jsonl）
    const recorder = createRunLogBuilder({
      runId,
      initialProject: project,
      intent,
      messageCount: messages.length,
      auditQuality: (candidate) => {
        try {
          const report = auditProjectQuality(candidate as Project)
          return {
            issueCount: report.issueCount,
            high: report.high,
            medium: report.medium,
            low: report.low,
            issues: report.issues,
          }
        } catch {
          return undefined
        }
      },
    })
    let emittedAny = false
    let sawDone = false
    let sawErrorEvent = false
    let runError: unknown = null
    const write = (event: string, data: unknown): void => {
      try {
        recorder.onEvent(event, data)
      } catch {
        /* 日志不能影响主流程 */
      }
      if (event === 'done') sawDone = true
      if (event === 'error') sawErrorEvent = true
      if (raw.writableEnded || raw.destroyed) return
      try {
        emittedAny = true
        raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      } catch {
        /* 客户端已断开 */
      }
    }
    const emit = createEmitter(write)

    let timedOut = false
    const heartbeat = setInterval(() => {
      if (!raw.writableEnded && !raw.destroyed) raw.write(': keepalive\n\n')
    }, 15_000)
    heartbeat.unref?.()

    const timeoutMs = Math.max(30_000, settings.agent.timeoutMs + 60_000)
    const timeoutTimer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('超时'))
    }, timeoutMs)
    timeoutTimer.unref?.()

    // 注意：要监听响应流的 close（连接断开），不能监听 request.raw 的 close ——
    // 后者在请求体读取完成后就会触发，会把正常请求误判成断开。
    const onClose = (): void => {
      if (!raw.writableEnded && !raw.destroyed) controller.abort(new Error('客户端断开'))
    }
    raw.on('close', onClose)

    try {
      await runAgent({
        runId,
        messages,
        project,
        intent,
        attachments,
        settings,
        signal: controller.signal,
        emit,
        log: (record) => {
          try {
            recorder.onLog(record)
          } catch {
            /* 诊断日志失败不影响生成 */
          }
        },
        reportQualityRepair: (info) => {
          try {
            recorder.setQualityRepair(info)
          } catch {
            /* 诊断日志失败不影响生成 */
          }
        },
      })
      if (timedOut && !raw.writableEnded) {
        emit.error(`执行超时（>${Math.round(timeoutMs / 1000)} 秒），已中止。`)
      }
    } catch (error) {
      runError = error
      if (!controller.signal.aborted) emit.error(errorMessage(error))
    } finally {
      clearInterval(heartbeat)
      clearTimeout(timeoutTimer)
      raw.off('close', onClose)
      if (activeRun === run) activeRun = null
      // 诊断日志收尾：即使客户端断开/取消也要记录失败原因，便于事后抓日志定位
      let outcome: AiRunOutcome = 'ok'
      let logError: string | undefined
      if (timedOut) {
        outcome = 'timeout'
        logError = `执行超时（>${Math.round(timeoutMs / 1000)} 秒），已中止。`
      } else if (runError) {
        outcome = 'error'
        logError = errorMessage(runError)
      } else if (sawErrorEvent) {
        outcome = 'error'
        logError = '运行中下发过 error 事件（详见 log 内的 error）'
      } else if (controller.signal.aborted) {
        outcome = 'interrupted'
        logError = `已中止：${errorMessage(controller.signal.reason)}`
      } else if (!sawDone) {
        outcome = 'interrupted'
        logError = '流未收到 done 事件就结束'
      }
      const logResult = recorder.finish({ outcome, error: logError })
      if (!logResult.ok) request.log.warn({ err: logResult.error }, '写入 AI 运行日志失败')
      if (!raw.writableEnded) {
        if (!emittedAny && controller.signal.aborted && !timedOut) {
          // 极端情况：还没发出任何事件就被取消，补一个 error 让前端能收尾
          write('error', { message: '请求已取消' })
        }
        raw.end()
      }
    }
  })

  app.post('/api/ai/cancel', async () => {
    const cancelled = cancelActiveAiRun()
    return { ok: true, cancelled }
  })

  app.get('/api/ai/status', async () => ({
    running: activeRun !== null,
    runId: activeRun?.runId,
    elapsedMs: activeRun ? Date.now() - activeRun.startedAt : 0,
  }))

  /**
   * 抓取最近的 AI 生成日志（新的在前）。
   * - ?limit=20      最多多少条（1..500）
   * - ?failed=1      只看有失败（运行失败或工具调用失败）的
   * - ?runId=run_xx  只看某次运行
   * 返回 { logs, files }；日志同时落盘在 data/logs/ai-runs-<date>.jsonl。
   */
  app.get('/api/ai/logs', async (request: FastifyRequest<{ Querystring: { limit?: string; failed?: string; runId?: string } }>) => {
    const query = request.query ?? {}
    const limit = Number(query.limit)
    const logs = listAiRunLogs({
      limit: Number.isFinite(limit) ? limit : 20,
      failedOnly: query.failed === '1' || query.failed === 'true',
      runId: typeof query.runId === 'string' && query.runId ? query.runId : undefined,
    })
    return { ok: true, count: logs.length, files: aiLogFiles(), logs }
  })
}
