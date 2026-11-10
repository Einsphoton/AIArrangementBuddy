/**
 * VST3 桥接辅助：把内部任务对象收窄成插件需要的稳定形状。
 *
 * 插件的状态机只需要：排队位置 / 预计等待 / 进度 / 是否终态 / 产物 assetId。
 * 其余内部字段（workerId、params、lease 等）不下发，避免插件依赖内部实现。
 */
import { taskWithQueueInfo, type CompanionTask } from '../companion/store.js'

export interface Vst3TaskView {
  /** 0 = 下一个被派；无排队意义时为 0 */
  queuePosition: number
  estimatedWaitSec: number
  /** 0..1 */
  progress: number
  /** queued / running / done / failed / canceled */
  status: string
  /** 已到终态（插件应停止轮询） */
  terminal: boolean
  assetId?: string
  error?: string
  message?: string
  durationMs?: number
}

export function enrichTask(task: CompanionTask): Vst3TaskView {
  const info = taskWithQueueInfo(task)
  return {
    queuePosition: info.queuePosition,
    estimatedWaitSec: info.estimatedWaitSec,
    progress: Math.round(task.progress * 100) / 100,
    status: task.status,
    terminal: ['done', 'failed', 'canceled'].includes(task.status),
    assetId: task.assetId,
    error: task.error,
    message: task.message,
    durationMs: task.durationMs,
  }
}