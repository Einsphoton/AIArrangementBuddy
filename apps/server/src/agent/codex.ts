/**
 * Codex CLI Agent 后端。
 *
 * 启动方式：
 *   codex exec --json --skip-git-repo-check -C <workdir> \
 *     -c mcp_servers.aiab.command="node" \
 *     -c mcp_servers.aiab.args=[".../mcp.mjs"] \
 *     -c mcp_servers.aiab.env={...} \
 *     "<prompt>"
 *
 * codex 输出 JSONL（stdout 一行一个 JSON 事件），我们把它映射成前端 SSE 事件：
 *   thread.started / turn.started        -> 忽略
 *   item.completed(agent_message)        -> text
 *   item.completed(reasoning)            -> reasoning
 *   item.started/completed(mcp_tool_call)-> tool_start / tool_end（并轮询工程文件发 project）
 *   item.started/completed(command_execution) -> tool_start / tool_end
 *   turn.completed                       -> done（带 usage）
 *   turn.failed / error                  -> error
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import process from 'node:process'
import { dataDir, resolveMcpLaunch } from '../config.js'
import { createExternalSession } from './session.js'
import { buildExternalAgentPrompt } from './prompt.js'
import { toolTitle } from '../tools/index.js'
import { truncate } from '../util.js'
import { resolveCodexPath, invalidateAgentProbe } from './probe.js'
import { AgentUnavailableError, type AgentRunRequest, type TokenUsage } from './types.js'

interface CodexItem {
  id?: string
  type?: string
  text?: string
  command?: string
  aggregated_output?: string
  exit_code?: number | null
  status?: string
  server?: string
  tool?: string
  name?: string
  arguments?: unknown
  result?: unknown
  changes?: unknown
  error?: { message?: string } | string
}

interface CodexLine {
  type?: string
  thread_id?: string
  message?: string
  item?: CodexItem
  usage?: {
    input_tokens?: number
    cached_input_tokens?: number
    output_tokens?: number
    reasoning_output_tokens?: number
  }
  error?: { message?: string }
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

/** 生成 codex 的 -c 覆盖参数：把本服务的 MCP server 注入进去 */
function buildMcpConfigArgs(projectFile: string, settings: AgentRunRequest['settings']): string[] {
  const launch = resolveMcpLaunch()
  const args: string[] = []
  args.push('-c', `mcp_servers.aiab.command=${tomlString(launch.command)}`)
  args.push('-c', `mcp_servers.aiab.args=[${launch.args.map(tomlString).join(', ')}]`)
  const env: Record<string, string> = {
    AIAB_PROJECT_FILE: projectFile,
    AIAB_DATA_DIR: dataDir,
    DATA_DIR: dataDir,
    AIAB_ALLOW_PROJECT_EDITS: String(settings.agent.allowProjectEdits),
    AIAB_ALLOW_WEB_SEARCH: String(settings.agent.allowWebSearch),
  }
  const envPairs = Object.entries(env)
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(', ')
  args.push('-c', `mcp_servers.aiab.env={ ${envPairs} }`)
  return args
}

function itemToolName(item: CodexItem): { name: string; title: string; args: Record<string, unknown> } {
  const type = item.type ?? 'tool'
  if (type === 'mcp_tool_call') {
    const name = item.tool ?? item.name ?? 'mcp_tool'
    return { name, title: toolTitle(name), args: (item.arguments as Record<string, unknown>) ?? {} }
  }
  if (type === 'command_execution') {
    return { name: 'shell', title: '执行命令', args: { command: item.command ?? '' } }
  }
  if (type === 'file_change' || type === 'patch') {
    return { name: 'apply_patch', title: '修改文件', args: { changes: item.changes ?? null } }
  }
  return { name: type, title: type, args: {} }
}

function resultText(item: CodexItem): string {
  if (item.aggregated_output) return truncate(item.aggregated_output, 1200)
  if (item.result !== undefined) {
    try {
      return truncate(typeof item.result === 'string' ? item.result : JSON.stringify(item.result), 1200)
    } catch {
      return '（结果无法序列化）'
    }
  }
  if (typeof item.error === 'string') return truncate(item.error, 1200)
  if (item.error && typeof item.error === 'object' && item.error.message) return truncate(item.error.message, 1200)
  return item.status ? `status=${item.status}` : '完成'
}

export async function runCodexAgent(req: AgentRunRequest): Promise<void> {
  const { settings, signal, emit } = req
  const codexPath = resolveCodexPath(settings)
  if (!codexPath) {
    invalidateAgentProbe()
    throw new AgentUnavailableError(
      'codex',
      '未检测到 Codex CLI（codex exec）。安装方式：npm i -g @openai/codex，或在「设置 → Agent」里填写可执行文件路径。',
    )
  }

  const session = createExternalSession(req.runId, req.project)
  let stopWatch: (() => void) | null = null
  let timeoutTimer: NodeJS.Timeout | null = null
  let timedOut = false

  const prompt = truncate(
    buildExternalAgentPrompt(req.messages, req.project, settings, req.intent, req.attachments),
    120_000,
  )

  const args = ['exec', '--json', '--skip-git-repo-check', '-C', session.workspace]
  if (settings.agent.model) args.push('-m', settings.agent.model)
  args.push(...buildMcpConfigArgs(session.projectFile, settings))
  args.push(prompt)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIAB_PROJECT_FILE: session.projectFile,
    AIAB_SESSION_DIR: session.dir,
    AIAB_ALLOW_PROJECT_EDITS: String(settings.agent.allowProjectEdits),
    AIAB_ALLOW_WEB_SEARCH: String(settings.agent.allowWebSearch),
  }
  if (process.env.AIAB_CODEX_HOME) env.CODEX_HOME = process.env.AIAB_CODEX_HOME

  const child = spawn(codexPath, args, {
    cwd: session.workspace,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const usage: TokenUsage = {}
  const startedTools = new Set<string>()
  const emittedText = new Set<string>()
  const stderrLines: string[] = []
  let turnFailed: string | null = null
  let completed = false
  let toolCounter = 0

  let lastProjectJson = JSON.stringify(req.project)
  const emitProjectIfChanged = (label: string): void => {
    const project = session.readProject()
    if (!project) return
    const serialized = JSON.stringify(project)
    if (serialized === lastProjectJson) return
    lastProjectJson = serialized
    emit.project(project, label)
  }

  const handleLine = (line: string): void => {
    const text = line.trim()
    if (!text || !text.startsWith('{')) return
    let event: CodexLine
    try {
      event = JSON.parse(text) as CodexLine
    } catch {
      return
    }
    const type = event.type ?? ''
    if (type === 'item.completed' && event.item) {
      const item = event.item
      const itemType = item.type ?? ''
      if (itemType === 'agent_message') {
        const id = item.id ?? `msg_${emittedText.size}`
        if (item.text && !emittedText.has(id)) {
          emittedText.add(id)
          emit.text(item.text)
        }
        return
      }
      if (itemType === 'reasoning') {
        if (item.text) emit.reasoning(item.text)
        return
      }
      const id = item.id ?? `codex_tool_${toolCounter++}`
      const tool = itemToolName(item)
      if (!startedTools.has(id)) {
        startedTools.add(id)
        emit.toolStart({ id, name: tool.name, args: tool.args, title: tool.title })
      }
      const ok = item.exit_code === undefined || item.exit_code === null ? item.status !== 'failed' : item.exit_code === 0
      emit.toolEnd({ id, ok, result: resultText(item), error: ok ? undefined : resultText(item) })
      if (itemType === 'mcp_tool_call') emitProjectIfChanged(tool.title)
      return
    }
    if (type === 'item.started' && event.item) {
      const item = event.item
      const itemType = item.type ?? ''
      if (itemType === 'agent_message' || itemType === 'reasoning') return
      const id = item.id ?? `codex_tool_${toolCounter++}`
      if (!startedTools.has(id)) {
        startedTools.add(id)
        const tool = itemToolName(item)
        emit.toolStart({ id, name: tool.name, args: tool.args, title: tool.title })
      }
      return
    }
    if (type === 'item.updated' && event.item?.type === 'agent_message') {
      // 部分版本会流式给 item.updated，这里不重复发（completed 里有完整文本）
      return
    }
    if (type === 'turn.completed') {
      completed = true
      if (event.usage) {
        usage.inputTokens = (event.usage.input_tokens ?? 0) + (event.usage.cached_input_tokens ?? 0)
        usage.outputTokens = event.usage.output_tokens ?? 0
      }
      return
    }
    if (type === 'turn.failed') {
      turnFailed = event.error?.message ?? event.message ?? 'Codex 执行失败'
      return
    }
    if (type === 'error') {
      // 可恢复错误（重连提示）先记下，等 turn.failed 或退出码再决定是否上报
      if (event.message) stderrLines.push(event.message)
      return
    }
  }

  if (child.stdout) {
    createInterface({ input: child.stdout }).on('line', handleLine)
  }
  if (child.stderr) {
    createInterface({ input: child.stderr }).on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      stderrLines.push(trimmed)
      if (stderrLines.length > 40) stderrLines.shift()
    })
  }

  stopWatch = session.watch((project) => {
    const serialized = JSON.stringify(project)
    if (serialized === lastProjectJson) return
    lastProjectJson = serialized
    emit.project(project, 'AI 修改工程（Codex）')
  })

  if (settings.agent.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 3000).unref?.()
    }, settings.agent.timeoutMs)
  }

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
    if (timeoutTimer) clearTimeout(timeoutTimer)
    signal.removeEventListener('abort', onAbort)
    stopWatch?.()
  })

  // 收尾：把最后一批工程变更补发出去
  emitProjectIfChanged('AI 修改工程（Codex）')

  if (signal.aborted) {
    session.cleanup()
    return
  }
  if (timedOut) {
    session.cleanup()
    throw new Error(`Codex 执行超时（>${Math.round(settings.agent.timeoutMs / 1000)} 秒），已终止。可在设置里调大超时时间。`)
  }
  if (turnFailed) {
    session.cleanup()
    throw new Error(`Codex 执行失败：${turnFailed}`)
  }
  if (exitCode !== 0) {
    const tail = stderrLines.slice(-6).join('\n')
    session.cleanup()
    throw new Error(`Codex 退出码 ${exitCode}。${tail || '没有更多错误信息。'}`)
  }
  if (!completed) {
    // 有输出但没有 turn.completed：仍然认为成功（部分 codex 版本事件不同）
    const tail = stderrLines.slice(-3).join('\n')
    if (tail) emit.reasoning(`Codex 提示：${tail}`)
  }

  session.cleanup()
  emit.done({ runId: req.runId, usage: usage.inputTokens || usage.outputTokens ? usage : undefined })
}
