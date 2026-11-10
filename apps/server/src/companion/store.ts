/**
 * Companion 工作节点注册表 + 音频生成任务队列（P1）。
 *
 * 协议（见 docs/COMPANION.md）：
 *   register → heartbeat → claim → progress → complete
 *
 * 设计取舍：
 * - workers 放内存（进程重启后 companion 会自动重新注册），tasks 落盘到
 *   data/companion/tasks.json，避免服务重启丢任务；
 * - claim 是"拉取+租约"：worker 认领后任务进入 running，超时未完成会被回收；
 * - 只做无状态 HTTP 轮询，不用 WebSocket（NAS 反向代理友好，P1 够用）。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { companionDir } from '../config.js'
import { saveAsset, type StoredAsset } from '../storage/assets.js'

export type CompanionTaskStatus = 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'canceled'

export interface CompanionWorker {
  id: string
  token: string
  name: string
  version: string
  capabilities: { tasks: string[]; gpu?: string; models?: string[] }
  status: {
    busy: boolean
    currentTaskId?: string
    lastMessage?: string
    /** 常驻引擎信息（P2）：变体 / 进程号 / 是否已预热 */
    engine?: { variant?: string; pid?: number; warm?: boolean }
  }
  registeredAt: number
  lastHeartbeatAt: number
}

/** 任务优先级：0 普通 / 1 高 / 2 紧急 */
export type CompanionPriority = 0 | 1 | 2

/** 任务所需的 DiT 变体（决定派给哪个 worker；与 Companion 上报的 models 匹配） */
export function variantForTaskType(type: string): 'turbo' | 'sft' | 'base' | undefined {
  if (type === 'generate_audio') return 'turbo'
  if (type === 'repaint_audio') return 'sft'
  if (type === 'generate_stem') return 'base'
  if (type === 'cover_audio') return 'turbo'
  return undefined
}

export interface CompanionTask {
  id: string
  type: string
  params: Record<string, unknown>
  projectId?: string
  status: CompanionTaskStatus
  progress: number
  message?: string
  workerId?: string
  error?: string
  assetId?: string
  /** 0 普通 / 1 高 / 2 紧急（越大越先派） */
  priority: CompanionPriority
  /** 派单所需的模型变体（缺省 = 不限制，兼容旧任务与 mock worker） */
  requiredVariant?: 'turbo' | 'sft' | 'base'
  cancelRequested: boolean
  createdAt: number
  updatedAt: number
  /** 实际开始执行的时刻（用于估算平均耗时） */
  startedAt?: number
  /** 实际执行耗时（毫秒，完成任务时写入） */
  durationMs?: number
  finishedAt?: number
}

export interface QueueInfo {
  /** 前面还有几个排队任务（0 = 下一个被派） */
  queuePosition: number
  /** 预计等待秒数（按最近同类任务平均耗时估算） */
  estimatedWaitSec: number
}

const tasksFile = () => path.join(companionDir, 'tasks.json')
const WORKER_TTL_MS = 60_000
const TASK_LEASE_MS = 10 * 60_000
const MAX_TASKS = 200
/** 没有历史数据时的默认单任务耗时（毫秒） */
const DEFAULT_DURATION_MS: Record<string, number> = {
  generate_audio: 45_000,
  repaint_audio: 35_000,
  generate_stem: 30_000,
  cover_audio: 35_000,
}

const workers = new Map<string, CompanionWorker>()

function normalizeTask(raw: Partial<CompanionTask> & { id: string; type: string }): CompanionTask {
  const now = Date.now()
  const priority = raw.priority === 1 || raw.priority === 2 ? raw.priority : 0
  return {
    id: raw.id,
    type: raw.type,
    params: raw.params ?? {},
    projectId: raw.projectId,
    status: raw.status ?? 'queued',
    progress: raw.progress ?? 0,
    message: raw.message,
    workerId: raw.workerId,
    error: raw.error,
    assetId: raw.assetId,
    priority,
    requiredVariant: raw.requiredVariant ?? variantForTaskType(raw.type),
    cancelRequested: raw.cancelRequested ?? false,
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? now,
    startedAt: raw.startedAt,
    durationMs: raw.durationMs,
    finishedAt: raw.finishedAt,
  }
}

function loadTasks(): CompanionTask[] {
  try {
    const parsed = JSON.parse(readFileSync(tasksFile(), 'utf8')) as CompanionTask[]
    return parsed.map((task) => normalizeTask(task))
  } catch {
    return []
  }
}

let tasks: CompanionTask[] = loadTasks()

function persist(): void {
  try {
    mkdirSync(companionDir, { recursive: true })
    writeFileSync(tasksFile(), JSON.stringify(tasks.slice(-MAX_TASKS), null, 2), 'utf8')
  } catch (error) {
    console.warn('[companion] 任务队列落盘失败', error)
  }
}

/** 回收过期 worker 与超时租约（不抛异常） */
function housekeeping(): void {
  const now = Date.now()
  for (const [id, worker] of workers) {
    if (now - worker.lastHeartbeatAt > WORKER_TTL_MS) {
      workers.delete(id)
      for (const task of tasks) {
        if (task.workerId === id && (task.status === 'claimed' || task.status === 'running')) {
          task.status = 'queued'
          task.workerId = undefined
          task.progress = 0
          task.message = '工作节点离线，任务已重新排队'
          task.updatedAt = now
        }
      }
    }
  }
  for (const task of tasks) {
    if ((task.status === 'claimed' || task.status === 'running') && now - task.updatedAt > TASK_LEASE_MS) {
      task.status = 'queued'
      task.workerId = undefined
      task.progress = 0
      task.message = '任务租约超时，已重新排队'
      task.updatedAt = now
    }
  }
}

export function registerWorker(input: {
  name?: string
  version?: string
  capabilities?: Partial<CompanionWorker['capabilities']>
}): { worker: CompanionWorker; token: string } {
  housekeeping()
  const worker: CompanionWorker = {
    id: `worker_${randomUUID().slice(0, 8)}`,
    token: randomUUID().replace(/-/g, ''),
    name: input.name?.trim() || '匿名 Companion',
    version: input.version?.trim() || '0.0.0',
    capabilities: {
      tasks: input.capabilities?.tasks?.length ? input.capabilities.tasks : ['generate_audio'],
      gpu: input.capabilities?.gpu,
      models: input.capabilities?.models,
    },
    status: { busy: false },
    registeredAt: Date.now(),
    lastHeartbeatAt: Date.now(),
  }
  workers.set(worker.id, worker)
  return { worker, token: worker.token }
}

export function authWorker(workerId: string, token: string): CompanionWorker | null {
  const worker = workers.get(workerId)
  if (!worker || worker.token !== token) return null
  return worker
}

export function heartbeat(
  workerId: string,
  token: string,
  status?: { busy?: boolean; currentTaskId?: string; engine?: { variant?: string; pid?: number; warm?: boolean } },
): { ok: boolean; cancelTaskIds: string[]; serverTime: number } | null {
  const worker = authWorker(workerId, token)
  if (!worker) return null
  housekeeping()
  worker.lastHeartbeatAt = Date.now()
  if (status) {
    worker.status = {
      busy: Boolean(status.busy),
      currentTaskId: status.currentTaskId,
      lastMessage: worker.status.lastMessage,
      engine: status.engine,
    }
  }
  const cancelTaskIds = tasks
    .filter((task) => task.workerId === worker.id && task.cancelRequested && task.status === 'running')
    .map((task) => task.id)
  return { ok: true, cancelTaskIds, serverTime: Date.now() }
}

/** 队列排序：优先级高的先派，同优先级按入队时间 */
function queueComparator(a: CompanionTask, b: CompanionTask): number {
  return b.priority - a.priority || a.createdAt - b.createdAt
}

/** 最近同类任务的平均执行耗时（毫秒），用于排队 ETA */
function averageDurationMs(type: string): number {
  const recent = tasks
    .filter((task) => task.type === type && task.status === 'done' && task.durationMs && task.durationMs > 0)
    .slice(-10)
  if (recent.length === 0) return DEFAULT_DURATION_MS[type] ?? 40_000
  return Math.round(recent.reduce((sum, task) => sum + (task.durationMs ?? 0), 0) / recent.length)
}

/** 排队位置与预计等待（只对 queued 任务有意义；其它状态 position=0） */
export function queueInfo(task: CompanionTask): QueueInfo {
  if (task.status !== 'queued') return { queuePosition: 0, estimatedWaitSec: 0 }
  const queued = tasks.filter((item) => item.status === 'queued').sort(queueComparator)
  const index = queued.findIndex((item) => item.id === task.id)
  if (index < 0) return { queuePosition: 0, estimatedWaitSec: 0 }

  // 前面每个排队任务按其类型平均耗时累加；在跑的同变体任务算半程
  let waitMs = 0
  for (const ahead of queued.slice(0, index)) waitMs += averageDurationMs(ahead.type)
  const runningSameVariant = tasks.filter(
    (item) => item.status === 'running' && item.requiredVariant === task.requiredVariant,
  )
  if (runningSameVariant.length > 0) waitMs += averageDurationMs(task.type) / 2
  return { queuePosition: index, estimatedWaitSec: Math.round(waitMs / 1000) }
}

export function enqueueTask(input: {
  type: string
  params?: Record<string, unknown>
  projectId?: string
  priority?: CompanionPriority
  /** 覆盖默认变体要求（例如质量模式 generate_audio 实际用 sft+LM，需要 sft worker） */
  variantOverride?: 'turbo' | 'sft' | 'base'
}): CompanionTask {
  housekeeping()
  const now = Date.now()
  const task: CompanionTask = {
    id: `task_${randomUUID().slice(0, 8)}`,
    type: input.type,
    params: input.params ?? {},
    projectId: input.projectId,
    status: 'queued',
    progress: 0,
    priority: input.priority === 1 || input.priority === 2 ? input.priority : 0,
    requiredVariant: input.variantOverride ?? variantForTaskType(input.type),
    cancelRequested: false,
    createdAt: now,
    updatedAt: now,
  }
  tasks.push(task)
  if (tasks.length > MAX_TASKS) tasks = tasks.slice(-MAX_TASKS)
  persist()
  return task
}

export function claimTask(workerId: string, token: string): CompanionTask | null {
  const worker = authWorker(workerId, token)
  if (!worker) return null
  housekeeping()
  const allowed = new Set(worker.capabilities.tasks)
  // 能力匹配：worker 上报了 models 时，只派发它支持的变体；未上报（空数组）视为全收（兼容旧 Companion）
  const models = worker.capabilities.models ?? []
  const candidates = tasks
    .filter((item) => {
      if (item.status !== 'queued' || !allowed.has(item.type)) return false
      if (models.length === 0) return true
      if (!item.requiredVariant) return true
      return models.includes(item.requiredVariant)
    })
    .sort(queueComparator)
  const task = candidates[0]
  if (!task) return null
  task.status = 'running'
  task.workerId = worker.id
  task.progress = 0
  task.message = '已认领'
  task.startedAt = Date.now()
  task.updatedAt = Date.now()
  worker.status = { ...worker.status, busy: true, currentTaskId: task.id }
  persist()
  return task
}

export function reportProgress(input: {
  workerId: string
  token: string
  taskId: string
  progress: number
  message?: string
}): { ok: boolean; cancel: boolean } | null {
  const worker = authWorker(input.workerId, input.token)
  if (!worker) return null
  const task = tasks.find((item) => item.id === input.taskId)
  if (!task || task.workerId !== worker.id) return null
  if (task.status !== 'running' && task.status !== 'claimed') return { ok: false, cancel: task.cancelRequested }
  task.progress = Math.max(0, Math.min(1, input.progress))
  task.message = input.message
  task.updatedAt = Date.now()
  persist()
  return { ok: true, cancel: task.cancelRequested }
}

export function completeTask(input: {
  workerId: string
  token: string
  taskId: string
  status: 'done' | 'failed'
  error?: string
  file?: Buffer
  fileName?: string
}): { ok: boolean; assetId?: string; task?: CompanionTask; error?: string } | null {
  const worker = authWorker(input.workerId, input.token)
  if (!worker) return null
  const task = tasks.find((item) => item.id === input.taskId)
  if (!task) return { ok: false, error: '任务不存在' }
  if (task.workerId && task.workerId !== worker.id) return { ok: false, error: '任务不属于该工作节点' }

  let asset: StoredAsset | undefined
  if (input.status === 'done') {
    if (!input.file || input.file.length === 0) {
      input.status = 'failed'
      input.error = '完成时没有上传音频文件'
    } else {
      try {
        asset = saveAsset(input.file, { name: input.fileName ?? `生成音频 ${task.id}.wav` })
      } catch (error) {
        input.status = 'failed'
        input.error = `音频资产入库失败：${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  task.status = input.status === 'done' ? 'done' : 'failed'
  task.progress = input.status === 'done' ? 1 : task.progress
  task.error = input.error
  task.assetId = asset?.id
  task.finishedAt = Date.now()
  task.updatedAt = Date.now()
  if (task.startedAt) task.durationMs = task.finishedAt - task.startedAt
  if (task.status !== 'done') task.message = '执行失败'
  // 保留心跳上报的 engine 信息（否则任务完成后状态面板会短暂丢引擎状态）
  worker.status = { ...worker.status, busy: false, currentTaskId: undefined }
  persist()
  return { ok: true, assetId: asset?.id, task }
}

export function cancelTask(taskId: string): boolean {
  const task = tasks.find((item) => item.id === taskId)
  if (!task || task.status === 'done' || task.status === 'failed' || task.status === 'canceled') return false
  task.cancelRequested = true
  task.updatedAt = Date.now()
  if (task.status === 'queued') {
    task.status = 'canceled'
    task.finishedAt = Date.now()
  }
  persist()
  return true
}

export function getTask(id: string): CompanionTask | null {
  housekeeping()
  return tasks.find((item) => item.id === id) ?? null
}

/** 任务 + 排队信息（供 routes 直接返回给前端） */
export function taskWithQueueInfo(task: CompanionTask): CompanionTask & QueueInfo {
  const info = queueInfo(task)
  return { ...task, ...info }
}

export function listTasks(limit = 20): Array<CompanionTask & QueueInfo> {
  housekeeping()
  return tasks
    .slice(-limit)
    .reverse()
    .map((task) => taskWithQueueInfo(task))
}

export function listWorkers(): Array<Omit<CompanionWorker, 'token'>> {
  housekeeping()
  return [...workers.values()].map(({ token: _token, ...rest }) => rest)
}

/** 队列按优先级分组计数 */
export function queueCounts(): { normal: number; high: number; urgent: number } {
  const queued = tasks.filter((task) => task.status === 'queued')
  return {
    normal: queued.filter((task) => task.priority === 0).length,
    high: queued.filter((task) => task.priority === 1).length,
    urgent: queued.filter((task) => task.priority === 2).length,
  }
}

/**
 * 因能力不匹配而无法派发的排队任务（variant × count），
 * 供 Companion 在空闲时提示"本机能力不足"，也供 UI 展示。
 */
export function blockedByCapability(): Array<{ variant: string; count: number }> {
  const caps = [...workers.values()].flatMap((worker) => worker.capabilities.models ?? [])
  const known = new Set(caps)
  const blocked = new Map<string, number>()
  for (const task of tasks) {
    if (task.status !== 'queued' || !task.requiredVariant) continue
    if (known.size === 0) continue
    if (known.has(task.requiredVariant)) continue
    blocked.set(task.requiredVariant, (blocked.get(task.requiredVariant) ?? 0) + 1)
  }
  return [...blocked.entries()].map(([variant, count]) => ({ variant, count }))
}

/** 只读：给状态接口用的摘要 */
export function companionSummary(): {
  workers: number
  queued: number
  running: number
  done: number
  failed: number
} {
  housekeeping()
  const count = (status: CompanionTaskStatus) => tasks.filter((task) => task.status === status).length
  return {
    workers: workers.size,
    queued: count('queued'),
    running: count('claimed') + count('running'),
    done: count('done'),
    failed: count('failed'),
  }
}
