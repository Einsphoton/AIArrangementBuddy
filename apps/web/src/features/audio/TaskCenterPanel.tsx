/**
 * Companion 任务中心（P4-B）。
 *
 * 入口：顶栏 Companion 徽标旁的「任务中心」按钮（`data-task-center-trigger`）。
 * 面板（`data-task-center`）打开时每 2s 轮询 `GET /api/companion/status`，关闭即停止。
 *
 * 展示：
 * - 队列概览（普通/高/紧急）+ 运行/完成/失败计数 + 缺能力阻塞提示；
 * - 任务列表：类型、短 id、状态、进度、优先级徽标、排队位置/预计等待、错误；
 * - 操作：queued/running 可取消（`data-task-cancel`）；done 且有 assetId 时可「打开产物」
 *   （只在当前工程里已引用该 asset 时定位，绝不自动落轨，避免重复）。
 *
 * 离线（online:false）是正常状态（200 + online:false），显示启动命令与复制按钮。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Bot,
  ClipboardList,
  Copy,
  LoaderCircle,
  Music4,
  RefreshCw,
  Timer,
  TriangleAlert,
  X,
} from 'lucide-react'
import {
  ApiError,
  cancelCompanionTask,
  COMPANION_PRIORITY_LABEL,
  getCompanionStatus,
  type CompanionPriority,
  type CompanionQueueSummary,
  type CompanionStatus,
  type CompanionTaskState,
  type CompanionTaskStatus,
} from '../../lib/api'
import { cn } from '../../lib/format'
import { useStore } from '../../store/store'
import { switchActiveTake } from './audioTrack'
import { COMPANION_START_HINT } from './CompanionBadge'

/** 轮询间隔：契约要求 2s */
const POLL_MS = 2000

const STATUS_META: Record<CompanionTaskStatus, { label: string; chip: string }> = {
  queued: { label: '排队中', chip: 'border-line-strong bg-surface-2 text-ink-3' },
  running: { label: '运行中', chip: 'border-cyan/45 bg-cyan/10 text-cyan' },
  done: { label: '完成', chip: 'border-success/45 bg-success/10 text-success' },
  failed: { label: '失败', chip: 'border-danger/45 bg-danger/10 text-danger' },
  canceled: { label: '已取消', chip: 'border-line bg-bg-soft text-ink-4' },
}

const PRIORITY_META: Record<CompanionPriority, { label: string; chip: string }> = {
  0: { label: '普通', chip: 'border-line-strong bg-bg-soft text-ink-3' },
  1: { label: '高', chip: 'border-accent/55 bg-accent/10 text-accent-soft' },
  2: { label: '紧急', chip: 'border-danger/60 bg-danger/12 text-danger' },
}

const TASK_TYPE_LABEL: Record<string, string> = {
  generate_audio: '生成音频',
  repaint_audio: '局部重绘',
  generate_stem: '分轨',
}

function normalizePriority(value: number | undefined): CompanionPriority {
  if (value === 1 || value === 2) return value
  return 0
}

function shortId(id: string): string {
  return id.length > 10 ? id.slice(-8) : id
}

function formatWait(seconds: number | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null
  if (seconds < 60) return `约 ${Math.max(1, Math.round(seconds))}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `约 ${minutes}m${rest > 0 ? ` ${rest}s` : ''}`
}

/** 旧服务端没有 queue 时，用 tasks 里的 priority 兜底统计 */
function deriveQueue(tasks: CompanionTaskState[] | undefined): CompanionQueueSummary {
  const result: CompanionQueueSummary = { normal: 0, high: 0, urgent: 0 }
  for (const task of tasks ?? []) {
    if (task.status !== 'queued') continue
    const priority = normalizePriority(task.priority)
    if (priority === 2) result.urgent += 1
    else if (priority === 1) result.high += 1
    else result.normal += 1
  }
  return result
}

export function TaskCenterPanel({ onClose }: { onClose: () => void }) {
  const pushToast = useStore((s) => s.pushToast)
  const [status, setStatus] = useState<CompanionStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [canceling, setCanceling] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState(0)
  const requestSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++requestSeq.current
    try {
      const next = await getCompanionStatus()
      if (seq !== requestSeq.current) return
      setStatus(next)
      setError(null)
      setLastUpdated(Date.now())
    } catch (err) {
      if (seq !== requestSeq.current) return
      setError(err instanceof Error ? err.message : '读取任务队列失败（后端可能未就绪）')
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [])

  /* 打开时轮询，关闭/卸载立即停止 */
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  /* Esc 关闭（document 捕获阶段，避免被其它全局 Escape 处理抢先） */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [onClose])

  const cancelTask = async (taskId: string) => {
    if (canceling) return
    setCanceling(taskId)
    try {
      await cancelCompanionTask(taskId)
      pushToast('info', `已取消任务 ${shortId(taskId)}`)
      await load()
    } catch (err) {
      const detail = err instanceof ApiError ? err.detail || err.message : err instanceof Error ? err.message : '未知错误'
      pushToast('error', `取消失败：${detail}`)
    } finally {
      setCanceling(null)
    }
  }

  /** 打开产物：只在工程已引用该 asset 时定位（不自动落轨） */
  const openArtifact = (task: CompanionTaskState) => {
    const assetId = task.assetId
    if (!assetId) return
    const store = useStore.getState()
    const project = store.project
    for (const track of project.tracks) {
      const clip = (track.audioClips ?? []).find(
        (item) => item.assetId === assetId || item.takes.some((take) => take.assetId === assetId),
      )
      if (!clip) continue
      const take = clip.takes.find((item) => item.assetId === assetId)
      if (take && clip.activeTakeId !== take.id) {
        const asset = project.assets.find((item) => item.id === assetId)
        const durationSec = asset?.durationMs ? asset.durationMs / 1000 : undefined
        store.mutate((draft) => {
          switchActiveTake(draft, track.id, clip.id, take.id, durationSec)
        })
      }
      store.selectTrack(track.id)
      store.setPlayhead(clip.startBeat)
      store.setView('arrangement')
      pushToast('success', `已定位到产物所在片段「${clip.name}」`)
      return
    }
    const asset = project.assets.find((item) => item.id === assetId)
    pushToast(
      'info',
      asset
        ? `产物已在资产库（${asset.name ?? assetId}），当前工程没有引用它的音频片段；可重新生成或手动导入`
        : '当前工程里还没有这个产物对应的片段（任务产物不会自动落轨，避免重复）',
    )
  }

  const online = status?.online === true && !error
  const offline = !loading && (status?.online === false || Boolean(error && !status))
  const queue = status?.queue ?? deriveQueue(status?.tasks)
  const tasks = status?.tasks ?? []
  const summary = status?.summary
  const activeCount = tasks.filter((task) => task.status === 'queued' || task.status === 'running').length
  const startHint = status?.hint ?? COMPANION_START_HINT

  const copyStartHint = async () => {
    try {
      await navigator.clipboard?.writeText(startHint)
      pushToast('success', '启动命令已复制')
    } catch {
      pushToast('info', startHint)
    }
  }

  return createPortal(
    <div
      data-task-center
      role="dialog"
      aria-modal="true"
      aria-label="Companion 任务中心"
      className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-black/65 p-4 pt-[6vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-[760px] flex-col overflow-hidden rounded-xl border border-line-strong bg-surface-2 shadow-[0_32px_80px_-24px_rgba(0,0,0,0.9)]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="shrink-0 border-b border-line px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
                <ClipboardList size={14} className="shrink-0 text-accent" />
                任务中心
                <span
                  className={cn(
                    'flex items-center gap-1 rounded-full border px-1.5 text-[9.5px] font-normal',
                    online ? 'border-success/40 bg-success/8 text-success' : 'border-line bg-bg-soft text-ink-4',
                  )}
                >
                  <span className={cn('h-1.5 w-1.5 rounded-full', online ? 'bg-success' : 'bg-ink-4')} />
                  {online ? 'Companion 在线' : loading ? '检查中…' : 'Companion 离线'}
                </span>
              </h2>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
                队列按优先级调度：紧急 &gt; 高 &gt; 普通。面板打开时每 2s 刷新，关闭即停止。
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                className="btn btn-ghost btn-icon h-7 w-7"
                onClick={() => void load()}
                aria-label="刷新任务队列"
                title="立即刷新"
                disabled={loading}
              >
                <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
              </button>
              <button
                className="btn btn-ghost btn-icon -mr-1 -mt-1 h-7 w-7"
                onClick={onClose}
                aria-label="关闭任务中心"
                title="关闭（Esc）"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <span className="chip cursor-default" title="普通优先级排队数">
              普通 {queue.normal}
            </span>
            <span className="chip cursor-default border-accent/45 text-accent-soft" title="高优先级排队数">
              高 {queue.high}
            </span>
            <span className="chip cursor-default border-danger/45 text-danger" title="紧急优先级排队数">
              紧急 {queue.urgent}
            </span>
            <span className="chip cursor-default" title="活跃任务数（排队 + 运行）">
              活跃 {activeCount}
            </span>
            <span className="chip cursor-default" title="运行中 / 完成 / 失败">
              运行 {summary?.running ?? 0} · 完成 {summary?.done ?? 0} · 失败 {summary?.failed ?? 0}
            </span>
            {lastUpdated > 0 && (
              <span className="chip cursor-default text-ink-4" title="最近一次刷新时间">
                {new Date(lastUpdated).toLocaleTimeString('zh-CN', { hour12: false })}
              </span>
            )}
          </div>

          {status?.blockedByCapability && status.blockedByCapability.length > 0 && (
            <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-danger/35 bg-danger/8 px-2.5 py-1.5">
              <TriangleAlert size={11} className="mt-[2px] shrink-0 text-danger" />
              <p className="min-w-0 flex-1 text-[10px] leading-relaxed text-ink-2">
                有任务因缺少工作节点能力被阻塞：
                {status.blockedByCapability.map((item) => `${item.variant} ×${item.count}`).join(' · ')}
              </p>
            </div>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {offline && (
            <div className="border-b border-line bg-bg-soft/60 px-4 py-3">
              <div className="flex items-start gap-2 text-[10.5px] leading-relaxed text-ink-2">
                <Bot size={12} className="mt-[2px] shrink-0 text-ink-3" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-ink-2">Companion 离线（生成节点未连接）</div>
                  <div className="mono mt-1 break-all rounded border border-line bg-bg px-1.5 py-1 text-[9.5px] text-ink-3">
                    {startHint}
                  </div>
                  {error && <div className="mt-1 break-all text-[9.5px] text-danger">{error}</div>}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost h-6 shrink-0 gap-1 px-1.5 text-[10px]"
                  onClick={() => void copyStartHint()}
                  title="复制启动命令"
                >
                  <Copy size={10} />
                  复制
                </button>
              </div>
            </div>
          )}

          {error && !offline && (
            <div className="border-b border-line bg-danger/8 px-4 py-2 text-[10.5px] text-danger">{error}</div>
          )}

          {loading && !status ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[11px] text-ink-3">
              <LoaderCircle size={13} className="animate-spin" />
              正在读取任务队列…
            </div>
          ) : tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
              <Timer size={20} className="text-ink-4" />
              <div className="text-[12px] font-medium text-ink-2">暂无任务</div>
              <div className="max-w-sm text-[11px] leading-relaxed text-ink-4">
                从「AI 生成音频」或音频片段的「局部重绘」提交任务后，会在这里看到排队位置与进度。
              </div>
            </div>
          ) : (
            tasks.map((task) => {
              const meta = STATUS_META[task.status] ?? STATUS_META.queued
              const priority = normalizePriority(task.priority)
              const priorityMeta = PRIORITY_META[priority]
              const progress = task.status === 'done' ? 1 : Math.min(1, Math.max(0, task.progress ?? 0))
              const wait = formatWait(task.estimatedWaitSec)
              const canCancel = task.status === 'queued' || task.status === 'running'
              const canOpen = task.status === 'done' && Boolean(task.assetId)
              return (
                <div
                  key={task.id}
                  data-task-row
                  data-task-id={task.id}
                  data-task-status={task.status}
                  className="border-t border-line/50 px-4 py-2"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className={cn('rounded border px-1 py-[1px] text-[9.5px] font-medium', meta.chip)}>
                      {meta.label}
                    </span>
                    <span className="min-w-0 truncate text-[11px] text-ink-2" title={`${task.type ?? 'task'} · ${task.id}`}>
                      {TASK_TYPE_LABEL[task.type ?? ''] ?? '任务'}
                      <span className="mono ml-1.5 text-[9.5px] text-ink-4">{shortId(task.id)}</span>
                    </span>
                    <span
                      data-task-priority={priority}
                      className={cn('shrink-0 rounded border px-1 py-[1px] text-[9px] font-medium', priorityMeta.chip)}
                      title={`优先级：${COMPANION_PRIORITY_LABEL[priority]}`}
                    >
                      {priorityMeta.label}
                    </span>
                    {task.requiredVariant && (
                      <span className="shrink-0 rounded border border-line bg-bg-soft px-1 py-[1px] text-[9px] text-ink-4">
                        {task.requiredVariant}
                      </span>
                    )}
                    <div className="flex-1" />
                    {canCancel && (
                      <button
                        type="button"
                        data-task-cancel
                        className="btn btn-ghost h-7 shrink-0 px-2 text-[10.5px]"
                        onClick={() => void cancelTask(task.id)}
                        disabled={canceling === task.id}
                        title="取消任务（服务端不可中断推理时会标记取消并清理）"
                      >
                        {canceling === task.id ? (
                          <LoaderCircle size={10} className="mr-1 animate-spin" />
                        ) : null}
                        取消
                      </button>
                    )}
                    {canOpen && (
                      <button
                        type="button"
                        data-task-open-asset
                        className="btn btn-ghost h-7 shrink-0 gap-1 px-2 text-[10.5px]"
                        onClick={() => openArtifact(task)}
                        title={`打开产物：${task.assetId}`}
                      >
                        <Music4 size={10} />
                        打开产物
                      </button>
                    )}
                  </div>

                  {(task.status === 'queued' || task.status === 'running' || task.status === 'done') && (
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
                      <div
                        className={cn(
                          'h-full rounded-full transition-[width] duration-300',
                          task.status === 'done' ? 'bg-success' : 'bg-accent',
                        )}
                        style={{ width: `${Math.round(progress * 100)}%` }}
                      />
                    </div>
                  )}

                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[9.5px] text-ink-4">
                    {(task.status === 'queued' || task.status === 'running') && (
                      <span>{Math.round(progress * 100)}%</span>
                    )}
                    {typeof task.queuePosition === 'number' && task.queuePosition > 0 && (
                      <span title="排队位置">排队第 {task.queuePosition} 位</span>
                    )}
                    {wait && <span title="预计等待（服务端估算）">预计等待 {wait}</span>}
                    {task.message && (
                      <span className="min-w-0 flex-1 truncate" title={task.message}>
                        {task.message}
                      </span>
                    )}
                  </div>
                  {task.error && (
                    <p className="mt-0.5 truncate text-[9.5px] text-danger" title={task.error}>
                      {task.error}
                    </p>
                  )}
                </div>
              )
            })
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-line px-5 py-3">
          <span className="min-w-0 flex-1 truncate text-[10px] leading-tight text-ink-4">
            {status
              ? `${summary?.workers ?? 0} 个节点在线 · 队列 ${summary?.queued ?? 0} · 运行 ${summary?.running ?? 0}`
              : '等待 Companion 状态…'}
          </span>
          <button className="btn btn-ghost h-8 px-3 text-[12px]" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
