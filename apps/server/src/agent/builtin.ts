/**
 * 内置 Agent：自家 function-calling 循环（默认后端，开箱即用）。
 *
 * 流程：系统提示 + 裁剪后的历史 -> 调模型（流式）-> 有工具调用就执行 -> 把结果回灌 ->
 * 最多 32 轮，直到模型不再调用工具。最后一轮的工具调用仍然执行，执行完收尾说明。
 * 修改工程的工具会立刻下发完整工程快照。
 */
import { getActiveProvider, providerReady } from '../storage/settings.js'
import { streamProvider } from '../providers/index.js'
import type { LlmMessage, ProviderStreamResult, TokenUsage } from '../providers/types.js'
import {
  describeToolArgs,
  executeTool,
  resolveToolAlias,
  toProviderTools,
  toolResultForModel,
  toolResultForUi,
  toolTitle,
  toolsForContext,
} from '../tools/index.js'
import type { ToolContext } from '../tools/schema.js'
import { buildSystemPrompt } from './prompt.js'
import { auditProjectQuality, newQualityIssues, qualityRepairPrompt, type QualityReport } from './quality.js'
import type { AgentRunRequest, AgentUiAction } from './types.js'

/** 单轮最多工具调用轮数：复杂编曲（多轨、复制段落、逐段微调）需要更多步；32 轮足够且不会失控 */
const MAX_ROUNDS = 32
/** 发给模型的历史消息上限：只保留最近 12 条会话消息（前端完整历史不受影响） */
const MAX_HISTORY_MESSAGES = 12
/** 单条历史消息发给模型时的字符上限，避免长对话撑爆上下文 */
const MAX_HISTORY_CONTENT_CHARS = 6000

const INVALID_ARGS_MESSAGE = '工具参数不是合法 JSON（可能被 max_tokens 截断），请拆小后重试'
const TRUNCATED_HINT =
  '\n\n（本轮输出达到 max_tokens 上限被截断，建议把任务拆小或减少一次写入的音符数）'
const ROUND_LIMIT_HINT = '\n\n（已达到本轮工具调用上限，以上改动均已执行。可以让我继续处理剩余部分。）'

/** 历史消息裁剪：超长内容截断，避免长对话/大工程撑爆上下文导致请求 400 */
function truncateHistoryContent(content: string): string {
  if (content.length <= MAX_HISTORY_CONTENT_CHARS) return content
  const marker = `\n…（已截断 ${content.length - MAX_HISTORY_CONTENT_CHARS} 字符）`
  const keep = MAX_HISTORY_CONTENT_CHARS - marker.length
  if (keep <= 0) return content.slice(0, MAX_HISTORY_CONTENT_CHARS)
  return `${content.slice(0, keep)}${marker}`
}

function toLlmMessages(req: AgentRunRequest): LlmMessage[] {
  const messages: LlmMessage[] = [
    { role: 'system', content: buildSystemPrompt(req.project, req.settings, req.intent, req.attachments) },
  ]
  const history: LlmMessage[] = []
  for (const message of req.messages) {
    if (message.role === 'system') continue
    if (!message.content?.trim()) continue
    history.push({ role: message.role, content: truncateHistoryContent(message.content) })
  }
  // 只把最近 12 条发给模型；前端对话历史仍然完整保留
  messages.push(...history.slice(-MAX_HISTORY_MESSAGES))
  const last = messages[messages.length - 1]
  // 兜底：保证最后一条一定是 user（部分网关要求 user 结尾）
  if (!last || last.role !== 'user') {
    messages.push({ role: 'user', content: '请根据当前工程继续完成编曲任务。' })
  }
  return messages
}

/** 供应商在参数 JSON 解析失败时会用 { _raw: rawText } 占位：这种调用绝不能执行 */
function hasInvalidArgs(args: Record<string, unknown> | undefined): boolean {
  return !!args && typeof args._raw === 'string'
}

/**
 * 从工具结果 data 里提取界面动作请求。
 * 约定：ui_action 工具返回 { ok:true, data:{ uiAction:{ action, beat?, view?, clipId? } } }。
 * 只有带非空 action 字符串才算有效，其它结构一律忽略（不能干扰正常工具结果）。
 */
function extractUiAction(data: unknown): AgentUiAction | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const candidate = (data as { uiAction?: unknown }).uiAction
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  const action = (candidate as { action?: unknown }).action
  if (typeof action !== 'string' || !action.trim()) return null
  return candidate as AgentUiAction
}

function addUsage(total: TokenUsage, next?: TokenUsage): TokenUsage {
  if (!next) return total
  return {
    inputTokens: (total.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (total.outputTokens ?? 0) + (next.outputTokens ?? 0),
  }
}

/** 模型只调工具没说话时，用一句中文总结说明做了什么（而不是干巴巴的「已完成本次操作。」） */
function buildCompletionSummary(actions: string[]): string {
  const counts = new Map<string, number>()
  for (const action of actions) counts.set(action, (counts.get(action) ?? 0) + 1)
  const names = [...counts.keys()]
  const shown = names.slice(0, 6)
  const detail = shown.map((name) => {
    const count = counts.get(name) ?? 1
    return count > 1 ? `${name}×${count}` : name
  })
  const more = names.length > shown.length ? ' 等' : ''
  return `已完成 ${actions.length} 项改动：${detail.join('、')}${more}。`
}

export async function runBuiltinAgent(req: AgentRunRequest): Promise<void> {
  const { settings, signal, emit } = req
  const provider = getActiveProvider(settings)
  if (!provider) {
    throw new Error('还没有配置 AI 服务商。请打开「设置 → AI 服务商」添加一个（推荐 DeepSeek 或 OpenAI）。')
  }
  const ready = providerReady(provider)
  if (!ready.ready) {
    throw new Error(`${ready.reason ?? '服务商配置不完整'}，请在「设置 → AI 服务商」中补全后重试。`)
  }

  const tools = toolsForContext({
    allowProjectEdits: settings.agent.allowProjectEdits,
    allowWebSearch: settings.agent.allowWebSearch,
  })
  const providerTools = toProviderTools(tools)
  const ctx: ToolContext = {
    project: req.project,
    settings,
    signal,
    allowProjectEdits: settings.agent.allowProjectEdits,
    allowWebSearch: settings.agent.allowWebSearch,
  }
  const messages = toLlmMessages(req)
  const startedAt = Date.now()
  let usage: TokenUsage = {}
  let textChars = 0
  let reachedLimit = false
  /** 截断提示每次运行只发一次，避免多轮都被截断时刷屏 */
  let truncatedNotified = false
  /** 成功执行的工具展示名，用于模型没说话时生成一句总结 */
  const completedActions: string[] = []
  /** 本次运行是否改过工程（质量自检只在有改动时做） */
  let projectChanged = false
  /** 质量自检自动修复：每次运行最多触发一次，只修「本次新引入」的高优先级问题 */
  let qualityRepairUsed = false
  let qualityRepairIssued = 0
  /** 初始工程质量（懒计算并缓存，避免纯问答也做体检） */
  let initialQuality: QualityReport | null = null
  const getInitialQuality = (): QualityReport => {
    if (!initialQuality) initialQuality = auditProjectQuality(req.project)
    return initialQuality
  }

  /**
   * 有效 max_tokens：推理模型（reasoning）可能把预算大量花在思考上，
   * 导致正文/工具参数还没开始就被截断。截断且本轮没有可见文本时自动加倍预算重试同一轮。
   */
  let effectiveMaxTokens = provider.maxTokens
  const MAX_TOKEN_ESCALATIONS = 2
  const MAX_TOKENS_CEILING = 32768
  const MIN_TOKENS_AFTER_ESCALATION = 8192

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal.aborted) return
    const isLastRound = round === MAX_ROUNDS - 1
    let result: ProviderStreamResult | null = null
    let escalations = 0
    // 同一轮内最多重试 2 次（只在本轮没有可见文本、截断的是思考/工具参数时）
    while (true) {
      const providerStartedAt = Date.now()
      const attempt = await streamProvider({
        provider: effectiveMaxTokens !== provider.maxTokens ? { ...provider, maxTokens: effectiveMaxTokens } : provider,
        messages,
        sessionId: req.runId,
        tools: providerTools.length ? providerTools : undefined,
        signal,
        onText: (delta) => {
          textChars += delta.length
          emit.text(delta)
        },
        onReasoning: (delta) => emit.reasoning(delta),
        onRetry: (info) => req.log?.({ type: 'provider_retry', round, ...info }),
      })
      // 诊断：每轮服务商调用耗时/输出量/是否截断/实际预算，写入 AI 运行日志（失败不影响主流程）
      try {
        req.log?.({
          type: 'provider_call',
          round,
          durationMs: Date.now() - providerStartedAt,
          toolCalls: attempt.toolCalls.length,
          textChars: attempt.text.length,
          reasoningChars: attempt.reasoning.length,
          truncated: attempt.truncated,
          maxTokens: effectiveMaxTokens,
          escalated: escalations > 0,
        })
      } catch {
        /* 诊断日志失败不影响生成 */
      }
      usage = addUsage(usage, attempt.usage)
      const invalidToolArgs = attempt.toolCalls.some(
        (call) => call.args && typeof (call.args as Record<string, unknown>)._raw === 'string',
      )
      const wastedOnReasoning = attempt.text.trim().length === 0 && attempt.toolCalls.length === 0
      const shouldEscalate =
        attempt.truncated === true &&
        !signal.aborted &&
        escalations < MAX_TOKEN_ESCALATIONS &&
        (wastedOnReasoning || invalidToolArgs)
      if (shouldEscalate) {
        const next = Math.min(MAX_TOKENS_CEILING, Math.max(MIN_TOKENS_AFTER_ESCALATION, effectiveMaxTokens * 2))
        if (next > effectiveMaxTokens) {
          effectiveMaxTokens = next
          escalations++
          continue
        }
      }
      result = attempt
      break
    }
    if (!result) break
    if (result.truncated && !truncatedNotified) {
      // 自动加预算后仍被截断：提示用户拆小任务，而不是继续拿半截参数调工具
      truncatedNotified = true
      emit.text(TRUNCATED_HINT)
    }
    messages.push({
      role: 'assistant',
      content: result.text,
      toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
    })
    if (result.toolCalls.length === 0) {
      // 质量自检：模型认为完成时，如果本次改动引入了新的高优先级问题
      // （片段时间重叠 / 音符超出片段长度等「静默做坏」的问题），追加一轮修复指令。
      // 只修本次新引入的问题，不动用户原有内容；每次运行最多触发一次。
      if (settings.agent.allowProjectEdits && projectChanged && !qualityRepairUsed && round < MAX_ROUNDS - 2) {
        try {
          const report = auditProjectQuality(ctx.project)
          const introduced = newQualityIssues(getInitialQuality(), report).filter((issue) => issue.severity === 'high')
          if (introduced.length > 0) {
            qualityRepairUsed = true
            qualityRepairIssued = introduced.length
            emit.text(`\n\n（质量自检：发现 ${introduced.length} 个本次生成引入的问题，正在自动修复…）`)
            messages.push({ role: 'user', content: qualityRepairPrompt(introduced) })
            continue
          }
        } catch {
          /* 质量自检失败不阻塞生成 */
        }
      }
      break
    }

    for (const call of result.toolCalls) {
      if (signal.aborted) return
      const args = call.args ?? {}
      // 工具名别名（AI 自创名，如 add_drums / duplicate_clip）：解析成真实工具名再展示，
      // 这样前端图标/标题正确、日志可读；真正的执行仍交给 executeTool（它内部也会解析别名，
      // 并负责补默认参数与同义字段映射，避免这里重复实现一套合并规则）。
      const alias = resolveToolAlias(call.name)
      const toolName = alias?.name ?? call.name
      const displayArgs = alias?.args ? { ...alias.args, ...args } : args
      emit.toolStart({
        id: call.id,
        name: toolName,
        args: displayArgs,
        title: toolTitle(toolName),
      })
      if (hasInvalidArgs(args)) {
        // 参数被截断/写坏：不执行该工具，但必须回一条 tool 结果，保持消息协议完整
        emit.toolEnd({ id: call.id, ok: false, error: INVALID_ARGS_MESSAGE })
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: toolName,
          content: JSON.stringify({ ok: false, message: INVALID_ARGS_MESSAGE }),
        })
        continue
      }
      const toolResult = await executeTool(call.name, args, ctx)
      if (toolResult.project) {
        ctx.project = toolResult.project
        projectChanged = true
        emit.project(toolResult.project, toolTitle(toolName))
      }
      emit.toolEnd({
        id: call.id,
        ok: toolResult.ok,
        result: toolResultForUi(toolResult),
        error: toolResult.ok ? undefined : toolResult.message,
        // 音频类工具把执行计划放在 data.audioPlan：前端据此提交生成任务并落轨。
        // 其它工具的 data 里可能只有 uiAction，前端会忽略不认识的字段。
        data: toolResult.ok ? toolResult.data : undefined,
      })
      // ui_action：工具本身不改工程，只请求前端执行界面动作（播放/跳转/切视图…）。
      // 作为独立 SSE `ui` 事件下发，不占用也不影响正常 tool_end / done 协议。
      if (toolResult.ok) {
        const uiAction = extractUiAction(toolResult.data)
        if (uiAction) emit.ui(uiAction)
      }
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: toolName,
        content: toolResultForModel(toolResult),
      })
      if (toolResult.ok) {
        completedActions.push(toolTitle(toolName))
      } else {
        // 失败时把参数摘要留给下一轮模型参考（放在结果文本里，避免额外消息）
        const argSummary = describeToolArgs(args)
        if (argSummary) messages[messages.length - 1].content += `（参数：${argSummary}）`
      }
    }
    if (isLastRound) {
      // 最后一轮的工具照常执行，执行完停止并收尾（不再产生「未执行该调用」失败卡片）
      reachedLimit = true
      break
    }
  }

  if (reachedLimit) emit.text(ROUND_LIMIT_HINT)
  // 质量自检结果回报给运行日志（是否有本次新引入的问题、修复后是否清零），并在对话里给用户一个明确交代
  try {
    if (qualityRepairUsed) {
      const remaining = newQualityIssues(getInitialQuality(), auditProjectQuality(ctx.project)).filter(
        (issue) => issue.severity === 'high',
      ).length
      req.reportQualityRepair?.({ triggered: true, issueCount: qualityRepairIssued, repaired: remaining === 0 })
      emit.text(
        remaining === 0
          ? '\n\n（质量自检：上述问题已自动修复）'
          : `\n\n（质量自检：仍有 ${remaining} 个问题未解决，可以让我继续修复）`,
      )
    } else {
      req.reportQualityRepair?.({ triggered: false, issueCount: 0, repaired: false })
    }
  } catch {
    /* 诊断回报失败不影响生成 */
  }
  if (textChars === 0) {
    if (completedActions.length > 0) emit.text(buildCompletionSummary(completedActions))
    else if (!reachedLimit) emit.text('已完成本次操作。')
  }
  emit.done({ runId: req.runId, usage, elapsedMs: Date.now() - startedAt })
}
