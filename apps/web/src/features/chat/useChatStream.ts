import { useCallback, useRef, useState } from 'react'
import type { Project } from '@aiab/core'
import { cancelChat, streamChat, type ChatRequestPayload } from '../../lib/api'
import { useStore } from '../../store/store'
import { toolMeta } from './toolDisplay'
import { applyAgentUiAction } from './uiActionBridge'
import { finishMessageMetrics, startMessageMetrics } from './chatMetrics'
import { handleAudioPlanFromToolData, runHeuristicAudioFallback } from '../audio/audioIntent'

interface SendOptions {
  intent?: string
  /** 结构化上下文：选中的旋律轨 / 参考片段（CONTRACTS §5） */
  attachments?: { melodyTrackId?: string; referenceClipId?: string }
}

export interface ChatStreamApi {
  /** 发送一条用户消息并开始流式接收 */
  send: (text: string, options?: SendOptions) => void
  /** 停止当前生成（同时通知服务端中止 Agent） */
  stop: () => void
  /** 重发上一次请求（断流 / 失败后重试） */
  retry: () => void
  /** 重新生成最后一条助手消息（复用上一次请求，替换原回答） */
  regenerate: () => void
  /** SSE 断流（未收到 done 事件即断开） */
  interrupted: boolean
  dismissInterrupted: () => void
}

interface StartEvent {
  runId?: string
  backend?: string
  model?: string
}

/**
 * AI 对话流：把 /api/ai/chat 的 SSE 事件翻译成 store 里的消息状态。
 * 事件协议见 docs/CONTRACTS.md §5。
 */
export function useChatStream(): ChatStreamApi {
  const [interrupted, setInterrupted] = useState(false)
  const assistantRef = useRef<string | null>(null)
  const payloadRef = useRef<ChatRequestPayload | null>(null)
  const cancelRef = useRef<(() => void) | null>(null)
  const sendingRef = useRef(false)
  const sawDoneRef = useRef(false)
  const stoppedRef = useRef(false)
  /** 本次运行是否已经由 generate_audio 工具计划接管音频任务 */
  const audioPlanHandledRef = useRef(false)

  const run = useCallback((payload: ChatRequestPayload, reuseMessageId?: string) => {
    if (sendingRef.current) return
    const store = useStore.getState()
    sendingRef.current = true
    sawDoneRef.current = false
    stoppedRef.current = false
    audioPlanHandledRef.current = false
    setInterrupted(false)
    payloadRef.current = payload

    let assistantId: string
    if (reuseMessageId) {
      // 重新生成：复用原来的助手消息，避免消息列表里出现两条回答
      assistantId = reuseMessageId
      store.patchMessage(reuseMessageId, {
        content: '',
        reasoning: '',
        toolCalls: [],
        error: undefined,
        changedProject: false,
        streaming: true,
        model: undefined,
      })
    } else {
      assistantId = store.addMessage({ role: 'assistant', content: '', streaming: true })
    }
    assistantRef.current = assistantId
    startMessageMetrics(assistantId)
    store.setAiBusy(true)
    store.setAiError(null)

    let settled = false
    const settle = (streamError?: string) => {
      if (settled) return
      settled = true
      sendingRef.current = false
      cancelRef.current = null
      const state = useStore.getState()
      const id = assistantRef.current
      state.setAiBusy(false)
      if (!id) return
      const message = state.messages.find((m) => m.id === id)
      if (!message) return

      // 用户主动停止：只需收尾，不报错
      if (stoppedRef.current) {
        finishMessageMetrics(id)
        state.patchMessage(id, { streaming: false })
        return
      }
      if (streamError) {
        finishMessageMetrics(id)
        state.patchMessage(id, { streaming: false, error: streamError })
        state.setAiError(streamError)
        return
      }
      // 服务端主动下发了 error 事件：错误块里已有重试按钮，不再叠断开提示
      if (message.error) {
        finishMessageMetrics(id)
        state.patchMessage(id, { streaming: false })
        return
      }
      if (!sawDoneRef.current) {
        const hasBody = Boolean(
          message.content.trim() || message.reasoning?.trim() || message.toolCalls?.length,
        )
        if (hasBody) {
          // 已有部分输出：保留内容，提示可重试
          finishMessageMetrics(id)
          state.patchMessage(id, { streaming: false })
          setInterrupted(true)
        } else {
          const text = 'AI 服务未返回内容就断开了连接。请确认后端正在运行（pnpm dev），或稍后重试。'
          finishMessageMetrics(id)
          state.patchMessage(id, { streaming: false, error: text })
          state.setAiError(text)
          setInterrupted(true)
        }
        return
      }
      finishMessageMetrics(id)
      state.patchMessage(id, { streaming: false })
    }

    const handleEvent = (event: string, data: unknown) => {
      const state = useStore.getState()
      const id = assistantRef.current
      if (!id) return
      switch (event) {
        case 'start': {
          const payload = (data ?? {}) as StartEvent
          state.setAiBusy(true, payload.runId ?? null)
          if (payload.model) state.patchMessage(id, { model: payload.model })
          break
        }
        case 'text': {
          const delta = (data as { delta?: string } | null)?.delta
          if (typeof delta === 'string' && delta) state.appendToMessage(id, delta)
          break
        }
        case 'reasoning': {
          const delta = (data as { delta?: string } | null)?.delta
          if (typeof delta === 'string' && delta) state.appendToMessage(id, delta, 'reasoning')
          break
        }
        case 'tool_start': {
          // 服务端按 CONTRACTS §5 下发扁平结构；同时兼容 { call: {...} } 的包装形式
          const raw = (data ?? {}) as {
            call?: { id?: string; name?: string; args?: Record<string, unknown>; title?: string }
            id?: string
            name?: string
            args?: Record<string, unknown>
            title?: string
          }
          const call = raw.call ?? raw
          if (!call?.id || !call.name) break
          const meta = toolMeta(call.name)
          state.addToolCall(id, {
            id: call.id,
            name: call.name,
            title: call.title || meta.title,
            args: call.args ?? {},
            status: 'running',
            startedAt: Date.now(),
          })
          break
        }
        case 'tool_end': {
          const payload = data as {
            id?: string
            ok?: boolean
            result?: unknown
            error?: string
            data?: unknown
          } | null
          if (!payload?.id) break
          state.finishToolCall(id, payload.id, payload.ok !== false, stringifyResult(payload.result), payload.error)
          // generate_audio 工具会带回执行计划：交给前端音频桥异步生成并落轨
          if (payload.ok !== false && payload.data && handleAudioPlanFromToolData(payload.data)) {
            audioPlanHandledRef.current = true
          }
          break
        }
        case 'project': {
          const payload = data as { project?: Project; label?: string } | null
          if (!payload?.project) break
          state.applyAgentProject(payload.project, payload.label || 'AI 修改')
          state.patchMessage(id, { changedProject: true })
          break
        }
        case 'ui': {
          // AI 请求的前端界面动作（播放/停止/跳转/切视图/选中片段/打开导出…）
          // 复用界面真实路径执行；参数非法时静默忽略，不影响对话流
          applyAgentUiAction(data)
          break
        }
        case 'done': {
          sawDoneRef.current = true
          const elapsed = (data as { elapsedMs?: number } | null)?.elapsedMs
          finishMessageMetrics(id, typeof elapsed === 'number' ? elapsed : undefined)
          state.patchMessage(id, { streaming: false })
          state.setAiBusy(false)
          // 兜底：音频意图已识别，但 Agent 没调用 generate_audio（常见于 Codex/DSH 等外部后端，
          // 它们的 tool_end 不携带 data）。此时按用户原话启发式执行一次，避免“只说不做”。
          if (payloadRef.current?.intent === 'audio' && !audioPlanHandledRef.current) {
            const messages = useStore.getState().messages
            const lastUser = [...messages].reverse().find((message) => message.role === 'user')
            if (lastUser?.content) {
              audioPlanHandledRef.current = runHeuristicAudioFallback(lastUser.content)
            }
          }
          break
        }
        case 'error': {
          const text = (data as { message?: string } | null)?.message || 'AI 执行失败，请稍后重试。'
          // 外部 Agent 不可用会自动回退到内置 Agent：这是提示而不是失败
          if (/已回退|回退到内置/.test(text)) {
            state.addMessage({ role: 'system', content: text })
            break
          }
          state.patchMessage(id, { streaming: false, error: text })
          state.setAiError(text)
          break
        }
        case 'message': {
          // 兼容服务端直接下发 data 的情况
          if (typeof data === 'string' && data) state.appendToMessage(id, data)
          break
        }
        default:
          break
      }
    }

    cancelRef.current = streamChat(payload, {
      onEvent: handleEvent,
      onError: (error) => {
        const text = describeError(error)
        const state = useStore.getState()
        state.setAiError(text)
        settle(text)
      },
      onClose: () => settle(),
    })
  }, [])

  const send = useCallback(
    (text: string, options?: SendOptions) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const store = useStore.getState()
      if (sendingRef.current || store.aiBusy) {
        store.pushToast('info', 'AI 正在生成，请稍候或先停止')
        return
      }
      store.addMessage({ role: 'user', content: trimmed })
      const history = useStore
        .getState()
        .messages.filter((message) => message.role !== 'system')
        .map((message) => ({
          role: message.role as 'user' | 'assistant',
          content: message.content.trim(),
        }))
        .filter((message) => message.content.length > 0)

      run({
        messages: history,
        project: useStore.getState().project,
        intent: options?.intent,
        attachments: options?.attachments,
      })
    },
    [run],
  )

  const stop = useCallback(() => {
    stoppedRef.current = true
    try {
      cancelRef.current?.()
    } catch {
      /* ignore */
    }
    cancelRef.current = null
    void cancelChat().catch(() => undefined)

    const state = useStore.getState()
    const id = assistantRef.current
    if (id) {
      finishMessageMetrics(id)
      const message = state.messages.find((item) => item.id === id)
      state.patchMessage(id, { streaming: false })
      if (message && !message.error && !message.content.includes('（已停止生成）')) {
        state.appendToMessage(id, message.content.trim() ? '\n\n（已停止生成）' : '（已停止生成）')
      }
    }
    state.setAiBusy(false)
    state.pushToast('info', '已停止生成')
  }, [])

  const retry = useCallback(() => {
    const payload = payloadRef.current
    if (!payload) return
    if (sendingRef.current || useStore.getState().aiBusy) return
    run({ ...payload, project: useStore.getState().project })
  }, [run])

  const regenerate = useCallback(() => {
    const payload = payloadRef.current
    const state = useStore.getState()
    if (!payload || sendingRef.current || state.aiBusy) return
    const lastAssistant = [...state.messages].reverse().find((message) => message.role === 'assistant')
    if (!lastAssistant) return
    run({ ...payload, project: state.project }, lastAssistant.id)
  }, [run])

  const dismissInterrupted = useCallback(() => setInterrupted(false), [])

  return { send, stop, retry, regenerate, interrupted, dismissInterrupted }
}

function stringifyResult(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

/** 把底层错误翻译成用户能懂的中文提示 */
export function describeError(error: Error): string {
  const raw = error?.message || '未知错误'
  const offline = /failed to fetch|fetch|network|load failed|ECONNREFUSED|连接|请求失败（5\d\d）/i.test(raw)
  if (offline) {
    return '无法连接本地服务（http://127.0.0.1:8787）。请在项目根目录运行 pnpm dev 启动后端后重试。'
  }
  if (/401|403|unauthor|鉴权|api[\s-]?key|密钥|未配置/i.test(raw)) {
    return `AI 服务鉴权失败：${raw}。请到「设置 → AI 服务商」检查 API Key。`
  }
  return raw
}
