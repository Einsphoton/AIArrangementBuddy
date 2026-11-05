/**
 * 每条 AI 消息的耗时统计。
 *
 * 为什么放在模块级 Map 而不是 store：
 * - store 的消息类型（ChatMessage）由共享契约定义，不归 UI 层扩展；
 * - 耗时只是展示信息，不需要持久化、不参与撤销；
 * - 消息对象在流式结束时会被 patch 一次，组件随之重渲染，此时读取即可。
 */
export interface MessageMetrics {
  /** 流开始时间（毫秒时间戳） */
  startedAt: number
  /** 本轮总耗时（毫秒）；结束时写入 */
  elapsedMs?: number
}

const metrics = new Map<string, MessageMetrics>()

/** 一轮生成开始：记录起点 */
export function startMessageMetrics(messageId: string): void {
  metrics.set(messageId, { startedAt: Date.now() })
}

/** 一轮生成结束：优先使用服务端上报的 elapsedMs，否则本地计算 */
export function finishMessageMetrics(messageId: string, elapsedMs?: number): void {
  const entry = metrics.get(messageId)
  const now = Date.now()
  if (!entry) {
    metrics.set(messageId, { startedAt: now, elapsedMs: typeof elapsedMs === 'number' ? elapsedMs : 0 })
    return
  }
  if (entry.elapsedMs != null) return
  entry.elapsedMs = typeof elapsedMs === 'number' && elapsedMs >= 0 ? elapsedMs : now - entry.startedAt
}

export function getMessageMetrics(messageId: string): MessageMetrics | undefined {
  return metrics.get(messageId)
}

/** 清空对话时一并清掉，避免长时间使用后 Map 无限增长 */
export function clearMessageMetrics(): void {
  metrics.clear()
}

/** 把毫秒格式化成「1.2s」「12s」「1m 05s」 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m ${String(rest).padStart(2, '0')}s`
}
