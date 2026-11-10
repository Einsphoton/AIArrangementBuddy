/**
 * 「生成分轨 Stem」对话框（P5-B）。
 *
 * 入口：音频片段右键菜单「生成分轨 Stem…」（`data-stem-trigger`）。
 * 流程：多选乐器 arm → 每个 arm 各提交一个 `generate_stem` 任务（任务中心可见）
 *   → 轮询 N 个任务（900ms）→ 每个 done 用返回的 assetId 取 peaks，
 *     **一次 mutate** 新建独立音频轨（kind:'audio'）+ AudioClip（startBeat 对齐源片段）。
 *
 * ⚠️ 产品文案红线（必须保留）：stem 是按原曲上下文**独立生成**的，
 *    不保证与源音频逐样本对齐或相加还原——不是"分离音轨"。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, LoaderCircle, Sparkles, TriangleAlert, Waves, X } from 'lucide-react'
import { useStore } from '../../store/store'
import {
  ApiError,
  cancelCompanionTask,
  createCompanionStemTask,
  getAssetPeaks,
  getCompanionTask,
  STEM_ARM_LABEL,
  STEM_ARMS,
  type CompanionPriority,
  type CompanionTaskState,
  type CompanionTaskStatus,
  type StemArm,
} from '../../lib/api'
import { cn } from '../../lib/format'
import { assetRefFromPeaks, placeAudioClip } from './audioTrack'
import { primeAssetPeaks } from './peaks'

/** 轮询间隔：契约要求 800–1200ms */
const POLL_MS = 900

const STATUS_LABEL: Record<CompanionTaskStatus, string> = {
  queued: '排队中',
  running: '生成中',
  done: '完成',
  failed: '失败',
  canceled: '已取消',
}

const TERMINAL: ReadonlySet<CompanionTaskStatus> = new Set(['done', 'failed', 'canceled'])

const DEFAULT_ARMS: StemArm[] = ['guitar', 'bass', 'drums']

interface ArmOptions {
  caption: string
  seed: string
  expanded: boolean
}

interface StemTaskEntry {
  arm: StemArm
  taskId: string | null
  status: CompanionTaskStatus
  progress: number
  assetId?: string
  message?: string
  error?: string
  /** 该任务是否已落轨 */
  finalized: boolean
  /** 落轨失败原因 */
  landError?: string
  /** 提交时快照，供 provenance 使用 */
  caption: string
  seed?: number
}

function emptyArmOptions(): Record<StemArm, ArmOptions> {
  const result = {} as Record<StemArm, ArmOptions>
  for (const arm of STEM_ARMS) result[arm] = { caption: '', seed: '', expanded: false }
  return result
}

export function StemGenerateDialog({
  trackId,
  clipId,
  onClose,
}: {
  trackId: string
  clipId: string
  onClose: () => void
}) {
  const pushToast = useStore((s) => s.pushToast)
  /** 打开时的源片段快照（落轨对齐用，后续工程变化不影响） */
  const [initial] = useState(() => {
    const state = useStore.getState()
    const clip = state.project.tracks
      .find((track) => track.id === trackId)
      ?.audioClips.find((item) => item.id === clipId)
    return {
      name: clip?.name ?? '音频片段',
      assetId: clip?.assetId ?? '',
      durationSec: Math.max(0, clip?.durationSec ?? 0),
      startBeat: Math.max(0, clip?.startBeat ?? 0),
      exists: Boolean(clip && clip.assetId),
    }
  })

  const [selectedArms, setSelectedArms] = useState<StemArm[]>(DEFAULT_ARMS)
  const [armOptions, setArmOptions] = useState<Record<StemArm, ArmOptions>>(emptyArmOptions)
  const [priority, setPriority] = useState<CompanionPriority>(0)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [tasks, setTasks] = useState<StemTaskEntry[]>([])
  const [canceling, setCanceling] = useState<string | null>(null)

  const tasksRef = useRef<StemTaskEntry[]>([])
  tasksRef.current = tasks
  const finalizedRef = useRef<Set<string>>(new Set())
  const summarySentRef = useRef(false)

  /** 每个任务 done 后落一条独立音频轨（一次 mutate） */
  const landStem = useCallback(
    async (entry: StemTaskEntry, assetId: string): Promise<void> => {
      try {
        const peaks = await getAssetPeaks(assetId)
        primeAssetPeaks(assetId, peaks)
        const armLabel = STEM_ARM_LABEL[entry.arm]
        const name = `${initial.name} · ${armLabel}`
        const asset = assetRefFromPeaks(assetId, peaks, { name: `${name}.wav` })
        const store = useStore.getState()
        const placed = { value: null as { trackId: string; clipId: string } | null }
        store.mutate((draft) => {
          placed.value = placeAudioClip(draft, {
            asset,
            durationSec: peaks.durationSec,
            name,
            startBeat: initial.startBeat,
            trackName: name,
            provenance: {
              source: 'ace-step',
              modelId: 'ace-step',
              adapterIds: [],
              seed: entry.seed,
              prompt: entry.caption || undefined,
              params: { arm: entry.arm, sourceAssetId: initial.assetId },
              sourceAssetIds: [initial.assetId],
              createdAt: Date.now(),
            },
          })
        })
        if (placed.value) {
          store.selectTrack(placed.value.trackId)
          store.setView('arrangement')
        }
        setTasks((previous) =>
          previous.map((item) =>
            item.taskId === entry.taskId ? { ...item, finalized: true, landError: undefined } : item,
          ),
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : '创建分轨轨道失败'
        setTasks((previous) =>
          previous.map((item) => (item.taskId === entry.taskId ? { ...item, landError: message } : item)),
        )
        pushToast('error', `分轨落轨失败（${STEM_ARM_LABEL[entry.arm]}）：${message}`)
      }
    },
    [initial.assetId, initial.name, initial.startBeat, pushToast],
  )

  /* 轮询进行中的任务；组件卸载（关闭对话框）即停止 */
  useEffect(() => {
    if (tasks.length === 0) return
    let stopped = false
    let timer: number | undefined
    const tick = async () => {
      if (stopped) return
      const active = tasksRef.current.filter(
        (item) => item.taskId && (item.status === 'queued' || item.status === 'running'),
      )
      const results = await Promise.all(
        active.map(async (item) => {
          try {
            const response = await getCompanionTask(item.taskId as string)
            return { item, task: response.task, error: undefined as unknown }
          } catch (error) {
            return { item, task: undefined as CompanionTaskState | undefined, error }
          }
        }),
      )
      if (stopped) return
      for (const { item, task, error } of results) {
        if (error) {
          setTasks((previous) =>
            previous.map((entry) =>
              entry.taskId === item.taskId
                ? { ...entry, error: error instanceof Error ? error.message : '查询任务失败' }
                : entry,
            ),
          )
          continue
        }
        if (!task) continue
        setTasks((previous) =>
          previous.map((entry) =>
            entry.taskId === item.taskId
              ? {
                  ...entry,
                  status: task.status,
                  progress: Math.min(1, Math.max(0, task.progress ?? 0)),
                  assetId: task.assetId ?? entry.assetId,
                  message: task.message,
                  error: task.error,
                }
              : entry,
          ),
        )
        if (task.status === 'done' && task.assetId && !finalizedRef.current.has(task.id)) {
          finalizedRef.current.add(task.id)
          const snapshot = tasksRef.current.find((entry) => entry.taskId === task.id)
          if (snapshot) void landStem({ ...snapshot, caption: snapshot.caption }, task.assetId)
        }
      }
      const allTerminal = tasksRef.current.every((item) => !item.taskId || TERMINAL.has(item.status))
      if (allTerminal) {
        if (!summarySentRef.current) {
          summarySentRef.current = true
          const done = tasksRef.current.filter((item) => item.status === 'done').length
          const failed = tasksRef.current.filter((item) => item.status === 'failed').length
          const canceled = tasksRef.current.filter((item) => item.status === 'canceled').length
          pushToast(
            done > 0 ? 'success' : 'info',
            `分轨任务完成：成功 ${done} 个${failed > 0 ? ` / 失败 ${failed} 个` : ''}${
              canceled > 0 ? ` / 取消 ${canceled} 个` : ''
            }${done > 0 ? '（已按源片段位置新建独立音频轨，⌘Z 可逐步撤销）' : ''}`,
          )
        }
        return
      }
      timer = window.setTimeout(() => void tick(), POLL_MS)
    }
    timer = window.setTimeout(() => void tick(), POLL_MS)
    return () => {
      stopped = true
      if (timer) window.clearTimeout(timer)
    }
  }, [tasks.length, landStem, pushToast])

  /* Esc 关闭（任务在服务端继续，面板底部有说明） */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [onClose])

  const toggleArm = (arm: StemArm) => {
    setSelectedArms((previous) =>
      previous.includes(arm) ? previous.filter((item) => item !== arm) : [...previous, arm],
    )
  }

  const patchArm = (arm: StemArm, patch: Partial<ArmOptions>) => {
    setArmOptions((previous) => ({ ...previous, [arm]: { ...previous[arm], ...patch } }))
  }

  const formDisabled = submitting || tasks.length > 0
  const selectedSet = useMemo(() => new Set(selectedArms), [selectedArms])

  const submit = async () => {
    if (selectedArms.length === 0) {
      setSubmitError('至少选择一个乐器分轨')
      return
    }
    if (!initial.exists) {
      setSubmitError('源音频片段没有有效资产，无法生成分轨')
      return
    }
    setSubmitError(null)
    summarySentRef.current = false
    finalizedRef.current = new Set()
    setSubmitting(true)
    const created: StemTaskEntry[] = []
    const failures: string[] = []
    try {
      for (const arm of selectedArms) {
        const options = armOptions[arm]
        const parsedSeed = Number.parseInt(options.seed.replace(/[^\d]/g, ''), 10)
        try {
          const result = await createCompanionStemTask(
            {
              sourceAssetId: initial.assetId,
              arm,
              caption: options.caption.trim() || undefined,
              seed: Number.isFinite(parsedSeed) ? parsedSeed : undefined,
            },
            useStore.getState().project.id,
            priority,
          )
          created.push({
            arm,
            taskId: result.taskId,
            status: result.status ?? 'queued',
            progress: 0,
            finalized: false,
            caption: options.caption.trim(),
            seed: Number.isFinite(parsedSeed) ? parsedSeed : undefined,
          })
        } catch (error) {
          const detail =
            error instanceof ApiError
              ? error.status === 503
                ? error.detail || error.message || '没有在线 Companion（需要带 base 能力的工作节点）'
                : error.detail || error.message
              : error instanceof Error
                ? error.message
                : '提交分轨任务失败'
          failures.push(`${STEM_ARM_LABEL[arm]}：${detail}`)
        }
      }
      if (created.length > 0) {
        setTasks(created)
        pushToast('info', `已提交 ${created.length} 个分轨任务，等待 Companion（base 模型，可能冷启动较慢）…`)
      }
      if (failures.length > 0) setSubmitError(`部分任务提交失败：${failures.join('；')}`)
    } finally {
      setSubmitting(false)
    }
  }

  const cancelTask = async (taskId: string) => {
    if (canceling) return
    setCanceling(taskId)
    try {
      await cancelCompanionTask(taskId)
      setTasks((previous) =>
        previous.map((item) => (item.taskId === taskId ? { ...item, status: 'canceled', message: '已取消' } : item)),
      )
      pushToast('info', '已取消分轨任务')
    } catch (error) {
      const detail = error instanceof ApiError ? error.detail || error.message : error instanceof Error ? error.message : '取消失败'
      pushToast('error', `取消失败：${detail}`)
    } finally {
      setCanceling(null)
    }
  }

  return createPortal(
    <div
      data-stem-panel
      role="dialog"
      aria-modal="true"
      aria-label="生成分轨 Stem"
      className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-black/65 p-4 pt-[6vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-[720px] flex-col overflow-hidden rounded-xl border border-line-strong bg-surface-2 shadow-[0_32px_80px_-24px_rgba(0,0,0,0.9)]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
              <Sparkles size={14} className="shrink-0 text-accent" />
              生成分轨 Stem
              <span className="rounded-full border border-line bg-bg-soft px-1.5 text-[9.5px] font-normal text-ink-4">
                Companion · base
              </span>
            </h2>
            <p className="mt-1 min-w-0 truncate text-[11px] leading-relaxed text-ink-3" title={initial.name}>
              源片段：{initial.name} · {initial.durationSec.toFixed(2)}s
              {initial.exists ? '' : '（缺少有效资产）'}
            </p>
          </div>
          <button
            className="btn btn-ghost btn-icon -mr-1 -mt-1 h-7 w-7 shrink-0"
            onClick={onClose}
            aria-label="关闭生成分轨对话框"
            title="关闭（Esc）"
          >
            <X size={14} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* 产品红线说明 */}
          <div className="mb-3 rounded-lg border border-accent/30 bg-accent/[0.06] px-3 py-2.5">
            <div className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-ink-2">
              <TriangleAlert size={12} className="mt-[2px] shrink-0 text-accent" />
              <p>
                stem 是按原曲上下文<strong className="font-semibold text-ink">独立生成</strong>的，
                <strong className="font-semibold text-ink">不保证与源音频逐样本对齐或相加还原</strong>
                ——用于快速得到可编辑/可重混的分轨素材，而不是“分离音轨”。
              </p>
            </div>
          </div>

          {/* 乐器多选 */}
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium text-ink-2">选择乐器（可多选）</span>
            <span className="text-[9.5px] text-ink-4">每个 arm 会单独生成一个任务 / 一条轨道</span>
          </div>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {STEM_ARMS.map((arm) => {
              const active = selectedSet.has(arm)
              return (
                <button
                  key={arm}
                  type="button"
                  data-stem-arm={arm}
                  aria-pressed={active}
                  disabled={formDisabled}
                  onClick={() => toggleArm(arm)}
                  className={cn(
                    'flex items-center gap-1 rounded-full border px-2 py-1 text-[10.5px] transition-colors',
                    active
                      ? 'border-cyan/55 bg-cyan/12 text-ink'
                      : 'border-line-strong bg-bg-soft text-ink-3 hover:text-ink',
                    formDisabled && !active && 'opacity-50',
                  )}
                >
                  <span className={cn('h-1.5 w-1.5 rounded-full', active ? 'bg-cyan' : 'bg-ink-4')} />
                  {STEM_ARM_LABEL[arm]}
                  <span className="mono text-[8.5px] text-ink-4">{arm}</span>
                </button>
              )
            })}
          </div>

          {/* 每个 arm 的可选参数（折叠） */}
          {selectedArms.length > 0 && !formDisabled && (
            <div className="mb-3 space-y-1.5">
              {selectedArms.map((arm) => {
                const options = armOptions[arm]
                return (
                  <div key={arm} className="rounded-lg border border-line bg-bg-soft/60">
                    <button
                      type="button"
                      className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[10.5px] text-ink-3 hover:text-ink-2"
                      onClick={() => patchArm(arm, { expanded: !options.expanded })}
                      aria-expanded={options.expanded}
                    >
                      <ChevronDown
                        size={11}
                        className={cn('shrink-0 transition-transform', options.expanded ? '' : '-rotate-90')}
                      />
                      <span className="font-medium">{STEM_ARM_LABEL[arm]}</span>
                      <span className="min-w-0 truncate text-[9.5px] text-ink-4">
                        {options.caption.trim() || '描述留空时使用 Companion 内置映射'}
                        {options.seed.trim() ? ` · seed ${options.seed.trim()}` : ''}
                      </span>
                    </button>
                    {options.expanded && (
                      <div className="grid grid-cols-1 gap-2 border-t border-line/60 px-2.5 py-2 sm:grid-cols-[minmax(0,1fr)_120px]">
                        <label className="block">
                          <span className="mb-1 block text-[9.5px] text-ink-3">单独描述（可选）</span>
                          <input
                            value={options.caption}
                            onChange={(event) => patchArm(arm, { caption: event.target.value })}
                            placeholder={`${arm} stem, follow the original song context`}
                            className="field h-8 w-full text-[11.5px]"
                            aria-label={`${STEM_ARM_LABEL[arm]} 描述`}
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-[9.5px] text-ink-3">seed（可选）</span>
                          <input
                            value={options.seed}
                            onChange={(event) => patchArm(arm, { seed: event.target.value.replace(/[^\d]/g, '') })}
                            placeholder="随机"
                            inputMode="numeric"
                            className="field h-8 w-full text-[11.5px]"
                            aria-label={`${STEM_ARM_LABEL[arm]} seed`}
                          />
                        </label>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* 优先级 */}
          <label className="mb-3 block max-w-[200px]">
            <span className="mb-1 block text-[10.5px] text-ink-3">任务优先级</span>
            <select
              value={String(priority)}
              onChange={(event) => setPriority(Number(event.target.value) as CompanionPriority)}
              className="field h-8 w-full text-[12px]"
              aria-label="分轨任务优先级"
              disabled={formDisabled}
              title="任务中心按 紧急 > 高 > 普通 调度"
            >
              <option value="0">普通</option>
              <option value="1">高</option>
              <option value="2">紧急</option>
            </select>
          </label>

          {/* 任务进度 */}
          {tasks.length > 0 && (
            <div className="rounded-lg border border-line bg-bg-soft px-3 py-2.5">
              <div className="mb-1 flex items-center gap-2 text-[10.5px] text-ink-3">
                <Waves size={11} />
                分轨任务（{tasks.length} 个）
                <span className="text-[9.5px] text-ink-4">关闭对话框会停止轮询，任务在服务端继续</span>
              </div>
              {tasks.map((entry) => {
                const progress = entry.status === 'done' ? 1 : Math.min(1, Math.max(0, entry.progress))
                const active = entry.status === 'queued' || entry.status === 'running'
                return (
                  <div key={`${entry.arm}-${entry.taskId}`} className="mt-1.5">
                    <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                      <span className="w-[52px] shrink-0 text-ink-2">{STEM_ARM_LABEL[entry.arm]}</span>
                      <span
                        className={cn(
                          'shrink-0 rounded border px-1 py-[1px] text-[9px]',
                          entry.status === 'done'
                            ? 'border-success/45 bg-success/10 text-success'
                            : entry.status === 'failed'
                              ? 'border-danger/45 bg-danger/10 text-danger'
                              : entry.status === 'canceled'
                                ? 'border-line bg-bg-soft text-ink-4'
                                : 'border-cyan/45 bg-cyan/10 text-cyan',
                        )}
                      >
                        {STATUS_LABEL[entry.status]}
                      </span>
                      {entry.finalized && <span className="text-[9px] text-success">已生成独立轨道</span>}
                      {entry.landError && (
                        <span className="min-w-0 flex-1 truncate text-[9px] text-danger" title={entry.landError}>
                          落轨失败：{entry.landError}
                        </span>
                      )}
                      {entry.message && (
                        <span className="min-w-0 flex-1 truncate text-[9px] text-ink-4" title={entry.message}>
                          {entry.message}
                        </span>
                      )}
                      <div className="flex-1" />
                      {active && entry.taskId && (
                        <button
                          type="button"
                          data-stem-cancel={entry.arm}
                          className="btn btn-ghost h-6 shrink-0 px-2 text-[9.5px]"
                          onClick={() => void cancelTask(entry.taskId as string)}
                          disabled={canceling === entry.taskId}
                          title="取消该分轨任务"
                        >
                          {canceling === entry.taskId ? <LoaderCircle size={9} className="mr-1 animate-spin" /> : null}
                          取消
                        </button>
                      )}
                    </div>
                    {(active || entry.status === 'done') && (
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-3">
                        <div
                          className={cn('h-full rounded-full transition-[width] duration-300', entry.status === 'done' ? 'bg-success' : 'bg-accent')}
                          style={{ width: `${Math.round(progress * 100)}%` }}
                        />
                      </div>
                    )}
                    {entry.error && (
                      <p className="mt-0.5 truncate text-[9px] text-danger" title={entry.error}>
                        {entry.error}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {submitError && (
            <p className="mt-2 flex items-start gap-1 text-[10.5px] leading-relaxed text-danger">
              <TriangleAlert size={11} className="mt-[2px] shrink-0" />
              <span className="min-w-0 flex-1 break-words">{submitError}</span>
            </p>
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-line px-5 py-3">
          <span className="min-w-0 flex-1 truncate text-[10px] leading-tight text-ink-4">
            完成后每个 stem 会按源片段位置新建独立音频轨（可逐步 ⌘Z 撤销）；产物不与源音频逐样本对齐
          </span>
          <button className="btn btn-ghost h-8 px-3 text-[12px]" onClick={onClose}>
            {tasks.length > 0 ? '关闭' : '取消'}
          </button>
          <button
            type="button"
            data-stem-submit
            className="btn btn-accent h-8 px-3 text-[12px]"
            onClick={() => void submit()}
            disabled={formDisabled || selectedArms.length === 0 || submitting}
            title="为每个选中的乐器各提交一个 generate_stem 任务"
          >
            {submitting ? (
              <LoaderCircle size={12} className="mr-1 animate-spin" />
            ) : (
              <Sparkles size={12} className="mr-1" />
            )}
            {submitting ? '提交中…' : `生成 ${selectedArms.length} 个分轨`}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}