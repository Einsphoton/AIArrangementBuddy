/**
 * DeepSeek Harness（DSH）Agent 后端 —— 实验性接入。
 *
 * 诚实原则：本机/用户的 DSH CLI 协议并不固定，代码不会假装成功：
 * - 探测不到 dsh 可执行文件 -> 抛 AgentUnavailableError，由上层明确回退到内置 Agent；
 * - 探测到但启动/协议不匹配 -> 如实把 stderr / 失败信息作为 error 事件上报。
 *
 * 协议假设（可用 AIAB_DSH_ARGS 覆盖命令行）：
 *   dsh exec --json "{prompt}"
 * stdout 每行一个 JSON，支持两类事件：
 *   A) 与前端 SSE 同名：{ event: 'text', data: { delta } } / { type: 'tool_start', ... }
 *   B) codex 风格：{ type: 'item.completed', item: { type: 'agent_message', text } }
 * 工程修改通过环境变量 AIAB_PROJECT_FILE 指向的会话文件同步（DSH 若支持 MCP，
 * 可用 `node apps/server/dist/mcp.mjs` 或 `tsx apps/server/src/mcp/server.ts` 接入）。
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import process from 'node:process'
import { createExternalSession } from './session.js'
import { buildExternalAgentPrompt } from './prompt.js'
import { toolTitle } from '../tools/index.js'
import { truncate } from '../util.js'
import { invalidateAgentProbe, probeDsh, resolveDshPath } from './probe.js'
import { AgentUnavailableError, type AgentRunRequest, type TokenUsage } from './types.js'

interface DshLine {
  event?: string
  type?: string
  data?: Record<string, unknown>
  delta?: string
  message?: string
  call?: { id?: string; name?: string; args?: Record<string, unknown>; title?: string }
  id?: string
  ok?: boolean
  result?: string
  error?: string
  usage?: { inputTokens?: number; outputTokens?: number; input_tokens?: number; output_tokens?: number }
  item?: { id?: string; type?: string; text?: string }
}

/** 解析 AIAB_DSH_ARGS（简单的空格分割，支持双引号包裹） */
function parseArgsTemplate(template: string | undefined, prompt: string): string[] {
  if (!template || !template.trim()) return ['exec', '--json', prompt]
  const tokens: string[] = []
  const regex = /"([^"]*)"|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(template))) tokens.push(match[1] ?? match[2] ?? '')
  const hasPlaceholder = tokens.some((token) => token.includes('{prompt}'))
  const resolved = tokens.map((token) => token.replace('{prompt}', prompt))
  if (!hasPlaceholder) resolved.push(prompt)
  return resolved
}

export async function runDshAgent(req: AgentRunRequest): Promise<void> {
  const { settings, signal, emit } = req
  const dshPath = resolveDshPath(settings)
  if (!dshPath) {
    invalidateAgentProbe()
    const probe = probeDsh(settings)
    throw new AgentUnavailableError(
      'dsh',
      `未检测到 DSH（DeepSeek Harness）CLI。${probe.note ?? ''} 已回退到内置 Agent。`,
    )
  }

  const session = createExternalSession(req.runId, req.project)
  const prompt = truncate(
    buildExternalAgentPrompt(req.messages, req.project, settings, req.intent, req.attachments),
    120_000,
  )
  const args = parseArgsTemplate(process.env.AIAB_DSH_ARGS, prompt)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIAB_PROJECT_FILE: session.projectFile,
    AIAB_SESSION_DIR: session.dir,
    AIAB_ALLOW_PROJECT_EDITS: String(settings.agent.allowProjectEdits),
    AIAB_ALLOW_WEB_SEARCH: String(settings.agent.allowWebSearch),
  }

  const child = spawn(dshPath, args, { cwd: session.workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const startedTools = new Set<string>()
  const stderrLines: string[] = []
  const usage: TokenUsage = {}
  let completed = false
  let failure: string | null = null
  let timedOut = false
  let toolCounter = 0

  let lastProjectJson = JSON.stringify(req.project)
  const stopWatch = session.watch((project) => {
    const serialized = JSON.stringify(project)
    if (serialized === lastProjectJson) return
    lastProjectJson = serialized
    emit.project(project, 'AI 修改工程（DSH）')
  })

  const mapEvent = (payload: DshLine): void => {
    const name = payload.event ?? payload.type ?? ''
    const data = payload.data ?? {}
    if (name === 'text' || name === 'agent_message') {
      const delta = (data.delta as string) ?? payload.delta ?? payload.item?.text
      if (typeof delta === 'string' && delta) emit.text(delta)
      return
    }
    if (name === 'reasoning' || name === 'thinking') {
      const delta = (data.delta as string) ?? payload.delta
      if (typeof delta === 'string' && delta) emit.reasoning(delta)
      return
    }
    if (name === 'tool_start') {
      const call = (data.call as DshLine['call']) ?? payload.call ?? {}
      const id = call.id ?? `dsh_tool_${toolCounter++}`
      startedTools.add(id)
      emit.toolStart({
        id,
        name: call.name ?? 'tool',
        args: call.args ?? {},
        title: call.title ?? toolTitle(call.name ?? ''),
      })
      return
    }
    if (name === 'tool_end') {
      const id = (data.id as string) ?? payload.id ?? ''
      emit.toolEnd({
        id,
        ok: data.ok === undefined ? payload.ok !== false : data.ok !== false,
        result: (data.result as string) ?? payload.result,
        error: (data.error as string) ?? payload.error,
      })
      return
    }
    if (name === 'ui') {
      // DSH 若直接透传界面动作（与 SSE 同名），原样转发给前端
      emit.ui(data as { action: string })
      return
    }
    if (name === 'done' || name === 'turn.completed') {
      completed = true
      const rawUsage = (data.usage as DshLine['usage']) ?? payload.usage
      if (rawUsage) {
        usage.inputTokens = rawUsage.inputTokens ?? rawUsage.input_tokens
        usage.outputTokens = rawUsage.outputTokens ?? rawUsage.output_tokens
      }
      return
    }
    if (name === 'error' || name === 'turn.failed') {
      failure = (data.message as string) ?? payload.message ?? payload.error ?? 'DSH 执行失败'
      return
    }
    if (name === 'item.completed' && payload.item) {
      const item = payload.item
      const id = item.id ?? `dsh_tool_${toolCounter++}`
      if (item.type === 'agent_message') {
        if (item.text) emit.text(item.text)
        return
      }
      if (item.type === 'reasoning') {
        if (item.text) emit.reasoning(item.text)
        return
      }
      if (!startedTools.has(id)) {
        startedTools.add(id)
        emit.toolStart({ id, name: item.type ?? 'tool', args: {}, title: toolTitle(item.type ?? '') })
      }
      emit.toolEnd({ id, ok: true, result: item.text })
    }
  }

  if (child.stdout) {
    createInterface({ input: child.stdout }).on('line', (line) => {
      const text = line.trim()
      if (!text || (!text.startsWith('{') && !text.startsWith('data:'))) return
      const jsonText = text.startsWith('data:') ? text.slice(5).trim() : text
      try {
        mapEvent(JSON.parse(jsonText) as DshLine)
      } catch {
        /* 非 JSON 行忽略 */
      }
    })
  }
  if (child.stderr) {
    createInterface({ input: child.stderr }).on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      stderrLines.push(trimmed)
      if (stderrLines.length > 40) stderrLines.shift()
    })
  }

  const timer = settings.agent.timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL')
        }, 3000).unref?.()
      }, settings.agent.timeoutMs)
    : null

  const onAbort = (): void => {
    child.kill('SIGTERM')
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL')
    }, 2000).unref?.()
  }
  signal.addEventListener('abort', onAbort, { once: true })

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', (error) => reject(error))
    child.once('close', (code) => resolve(code))
  }).finally(() => {
    if (timer) clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    stopWatch()
  })

  const latest = session.readProject()
  if (latest && JSON.stringify(latest) !== lastProjectJson) emit.project(latest, 'AI 修改工程（DSH）')
  session.cleanup()

  if (signal.aborted) return
  if (timedOut) throw new Error(`DSH 执行超时（>${Math.round(settings.agent.timeoutMs / 1000)} 秒），已终止。`)
  if (failure) throw new Error(`DSH 执行失败：${failure}`)
  if (exitCode !== 0) {
    const tail = stderrLines.slice(-6).join('\n')
    throw new Error(`DSH 退出码 ${exitCode}。${tail || '没有更多错误信息。'}`)
  }
  if (!completed) {
    throw new Error(
      'DSH 没有返回可识别的事件流（可能版本/参数不兼容）。可在环境变量 AIAB_DSH_ARGS 中指定正确的命令行参数，或改用内置 Agent。',
    )
  }
  emit.done({
    runId: req.runId,
    usage: usage.inputTokens || usage.outputTokens ? usage : undefined,
  })
}
