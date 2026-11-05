/** Agent 统一入口：按设置选择后端，外部后端不可用时诚实回退到内置 Agent。 */
import { getActiveProvider } from '../storage/settings.js'
import { errorMessage } from '../util.js'
import { runBuiltinAgent } from './builtin.js'
import { runCodexAgent } from './codex.js'
import { runDshAgent } from './dsh.js'
import { resolveCodexPath, resolveDshPath } from './probe.js'
import { AgentUnavailableError, type AgentRunRequest } from './types.js'

function modelFor(req: AgentRunRequest): string | undefined {
  if (req.settings.agent.backend === 'builtin') return getActiveProvider(req.settings)?.model ?? undefined
  return req.settings.agent.model || undefined
}

export interface ResolvedBackend {
  /** 实际执行的后端（外部后端不可用时会变成 builtin） */
  backend: 'builtin' | 'codex' | 'dsh'
  /** 回退原因（有值时会在 start 之后立刻下发 error 事件说明） */
  fallbackReason?: string
  model?: string
}

/** 只在执行前做可用性判定，便于把 start 事件的 backend 写对 */
export function resolveBackend(req: AgentRunRequest): ResolvedBackend {
  const requested = req.settings.agent.backend
  if (requested === 'codex' && !resolveCodexPath(req.settings)) {
    return {
      backend: 'builtin',
      fallbackReason:
        '未检测到 Codex CLI（codex exec），已回退到内置 Agent。安装：npm i -g @openai/codex，或在「设置 → Agent」填写可执行文件路径。',
      model: getActiveProvider(req.settings)?.model ?? undefined,
    }
  }
  if (requested === 'dsh' && !resolveDshPath(req.settings)) {
    return {
      backend: 'builtin',
      fallbackReason:
        '未检测到 DSH（DeepSeek Harness）CLI，已回退到内置 Agent。可在「设置 → Agent」填写 dsh 可执行文件路径，或继续使用内置 Agent。',
      model: getActiveProvider(req.settings)?.model ?? undefined,
    }
  }
  return { backend: requested, model: modelFor(req) }
}

export async function runAgent(req: AgentRunRequest): Promise<void> {
  const resolved = resolveBackend(req)
  req.emit.start({ runId: req.runId, backend: resolved.backend, model: resolved.model })
  if (resolved.fallbackReason) req.emit.error(resolved.fallbackReason)

  try {
    if (resolved.backend === 'codex') {
      await runCodexAgent(req)
    } else if (resolved.backend === 'dsh') {
      await runDshAgent(req)
    } else {
      await runBuiltinAgent(req)
    }
  } catch (error) {
    if (req.signal.aborted) return
    if (error instanceof AgentUnavailableError) {
      req.emit.error(error.message)
      return
    }
    req.emit.error(errorMessage(error))
  }
}
