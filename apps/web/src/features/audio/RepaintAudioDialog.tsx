/**
 * 音频片段「局部重绘」对话框（P2-B / Companion 任务）。
 *
 * 流程：选中音频片段 → 右键「局部重绘…」→ 选区间（相对 clip 内，秒）+ 写提示词
 *   → POST /api/companion/tasks {type:'repaint_audio'} → 900ms 轮询
 *   → done：取**新 assetId** 的 peaks（缓存按 assetId，不复用旧波形）→ 一次 mutate
 *     追加 Take + 切 activeTakeId/assetId/durationSec（原版本自动补成 take，可切回）。
 *
 * 已知限制（文案里也提示）：
 * - 重绘产物是**整段音频**（区间外由模型重建保持连续），所以是整段替换而不是拼接；
 * - 轮询只在对话框生命周期内，关闭后任务在服务端继续（重新打开不会恢复任务显示）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LoaderCircle, Scissors, TriangleAlert, Wand2, X } from 'lucide-react'
import {
  ApiError,
  cancelCompanionTask,
  createCompanionRepaintTask,
  getAssetPeaks,
  getCompanionTask,
  listAdapters,
  type AdapterInfo,
  type CompanionPriority,
  type CompanionTaskState,
  type CompanionTaskStatus,
} from '../../lib/api'
import { cn } from '../../lib/format'
import { useStore } from '../../store/store'
import { applyRepaintTake, assetRefFromPeaks, activeTakeOf } from './audioTrack'
import { primeAssetPeaks } from './peaks'

/** 轮询间隔：契约要求 800–1200ms */
const POLL_MS = 900

const STATUS_LABEL: Record<CompanionTaskStatus, string> = {
  queued: '排队中',
  running: '重绘中',
  done: '已完成',
  failed: '重绘失败',
  canceled: '已取消',
}

const TERMINAL: ReadonlySet<CompanionTaskStatus> = new Set(['done', 'failed', 'canceled'])

const round2 = (value: number) => Math.round(value * 100) / 100

/** 只保留数字与一个小数点（受控输入允许用户从空串 / "1." 开始输入） */
function sanitizeDecimal(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, '')
  const parts = cleaned.split('.')
  return parts.length > 1 ? `${parts[0]}.${parts.slice(1).join('')}` : cleaned
}

/** 默认区间：中间 1/3 */
function defaultRange(durationSec: number): { start: number; end: number } {
  const duration = Math.max(0.2, durationSec)
  const start = round2(duration / 3)
  const end = round2((duration * 2) / 3)
  return end - start > 0.05 ? { start, end } : { start: 0, end: round2(duration) }
}

export function RepaintAudioDialog({
  trackId,
  clipId,
  onClose,
}: {
  trackId: string
  clipId: string
  onClose: () => void
}) {
  const pushToast = useStore((s) => s.pushToast)
  /* 打开时的片段快照：用于默认区间 / 显示时长（后续 mutate 不覆盖表单初始值） */
  const [initial] = useState(() => {
    const state = useStore.getState()
    const target = state.project.tracks.find((track) => track.id === trackId)?.audioClips.find((clip) => clip.id === clipId)
    return {
      durationSec: Math.max(0, target?.durationSec ?? 0),
      name: target?.name ?? '音频片段',
      assetId: target?.assetId ?? '',
    }
  })
  /* 区间输入保留「文本」状态：受控的数字 state 会把 "0." 立刻归一成 0，
     用户根本没法输入小数秒；校验/提交时再 parse。 */
  const [startText, setStartText] = useState(() => String(defaultRange(initial.durationSec).start))
  const [endText, setEndText] = useState(() => String(defaultRange(initial.durationSec).end))
  const [caption, setCaption] = useState('')
  const [style, setStyle] = useState('')
  const [seedText, setSeedText] = useState('')
  const [adapterId, setAdapterId] = useState('')
  /** P4-B：任务优先级（0 普通 / 1 高 / 2 紧急），默认普通 */
  const [priority, setPriority] = useState<CompanionPriority>(0)

  const [adapters, setAdapters] = useState<AdapterInfo[] | null>(null)
  const [adapterHint, setAdapterHint] = useState<string | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [task, setTask] = useState<CompanionTaskState | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [canceling, setCanceling] = useState(false)
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [doneTakeId, setDoneTakeId] = useState<string | null>(null)

  const finalizedRef = useRef(false)
  const failedNotifiedRef = useRef<string | null>(null)
  /** 提交时的参数快照（轮询期间表单被禁用，这里再钉一次避免闭包漂移） */
  const submittedRef = useRef<{ startSec: number; endSec: number; caption: string; seed?: number } | null>(null)

  const liveClip = useStore((s) => s.project.tracks.find((track) => track.id === trackId)?.audioClips.find((clip) => clip.id === clipId))
  const activeTake = liveClip ? activeTakeOf(liveClip) : undefined

  /* 适配器（nativeReady） */
  useEffect(() => {
    let cancelled = false
    listAdapters()
      .then((result) => {
        if (cancelled) return
        const ready = new Set(result.nativeReady ?? [])
        setAdapters((result.adapters ?? []).filter((adapter) => ready.has(adapter.id)))
        setAdapterHint(null)
      })
      .catch((error) => {
        if (cancelled) return
        setAdapters(null)
        setAdapterHint(
          error instanceof ApiError && error.status === 404
            ? '适配器接口未就绪（404），将使用默认模型重绘'
            : '读取适配器失败，将使用默认模型重绘',
        )
      })
    return () => {
      cancelled = true
    }
  }, [])

  /* Esc 关闭（关闭即停止轮询；服务端任务继续） */
  /* Esc 关闭（关闭即停止轮询；服务端任务继续）。
     用 document 捕获阶段：模态框要抢在编曲视图等全局 Escape 处理之前关闭。 */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [onClose])

  const startSec = Number.parseFloat(startText)
  const endSec = Number.parseFloat(endText)
  /** 输入框可能为空 / 只有小数点：可视化条用兜底值，避免 NaN% 让高亮条消失 */
  const safeStart = Number.isFinite(startSec) ? startSec : 0
  const safeEnd = Number.isFinite(endSec) ? endSec : 0

  const rangeError = (() => {
    if (!(initial.durationSec > 0)) return '源片段没有有效时长，无法重绘'
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return '区间必须是有效数字'
    if (startSec < 0) return '起点不能小于 0 秒'
    if (endSec > initial.durationSec + 1e-6) return `终点不能超过片段时长 ${initial.durationSec.toFixed(2)} 秒`
    if (endSec - startSec < 0.05) return '终点必须大于起点（至少 0.05 秒）'
    return null
  })()

  const status = task?.status ?? null
  const progress = Math.min(1, Math.max(0, task?.progress ?? 0))
  const running = status === 'queued' || status === 'running'
  const finished = status === 'done' && Boolean(doneTakeId)
  const formDisabled = submitting || running || finished || applying

  /** 轮询：任务进入终态 / 组件卸载后停止 */
  useEffect(() => {
    if (!taskId) return
    let stopped = false
    let timer: number | undefined
    const tick = async () => {
      if (stopped) return
      try {
        const result = await getCompanionTask(taskId)
        if (stopped) return
        setTask(result.task)
        if (TERMINAL.has(result.task.status)) return
      } catch (error) {
        if (stopped) return
        setSubmitError(
          error instanceof ApiError && error.status === 404
            ? '任务不存在（后端可能已重启，任务队列在内存里）'
            : `查询任务失败：${error instanceof Error ? error.message : '未知错误'}`,
        )
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), POLL_MS)
    }
    timer = window.setTimeout(() => void tick(), POLL_MS)
    return () => {
      stopped = true
      if (timer) window.clearTimeout(timer)
    }
  }, [taskId])

  const finalize = useCallback(
    async (assetId: string) => {
      const snapshot = submittedRef.current
      if (!snapshot) return
      setApplying(true)
      setApplyError(null)
      try {
        /* 关键：按**新 assetId** 取峰值（缓存按 assetId，不复用旧 asset 的波形） */
        const peaks = await getAssetPeaks(assetId)
        primeAssetPeaks(assetId, peaks)
        const asset = assetRefFromPeaks(assetId, peaks, { name: `${initial.name}-repaint.wav` })
        const store = useStore.getState()
        const applyRef: { value: { takeId: string; baselineTakeId: string | null } | null } = { value: null }
        store.mutate((draft) => {
          applyRef.value = applyRepaintTake(draft, {
            trackId,
            clipId,
            asset,
            durationSec: peaks.durationSec,
            caption: snapshot.caption,
            startSec: snapshot.startSec,
            endSec: snapshot.endSec,
            seed: snapshot.seed,
            style: style.trim() || undefined,
            adapterId: adapterId || undefined,
          })
        })
        if (!applyRef.value) throw new Error('片段已不存在（可能被删除或撤销）')
        setDoneTakeId(applyRef.value.takeId)
        store.pushToast(
          'success',
          `已重绘 ${snapshot.startSec.toFixed(2)}–${snapshot.endSec.toFixed(2)} 秒，原版本保留为 take（⌘Z 可撤销）`,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : '创建重绘 take 失败'
        setApplyError(message)
        pushToast('error', `重绘落盘失败：${message}`)
      } finally {
        setApplying(false)
      }
    },
    [adapterId, clipId, initial.name, pushToast, style, trackId],
  )

  /* done → 只落盘一次 */
  useEffect(() => {
    if (!task || task.status !== 'done' || !task.assetId) return
    if (finalizedRef.current) return
    finalizedRef.current = true
    void finalize(task.assetId)
  }, [task, finalize])

  /* failed / canceled → toast 一次（后端 error 原样提示，不白屏） */
  useEffect(() => {
    if (!task || !TERMINAL.has(task.status) || task.status === 'done') return
    const key = `${task.id}:${task.status}`
    if (failedNotifiedRef.current === key) return
    failedNotifiedRef.current = key
    const detail = task.error || task.message || (task.status === 'canceled' ? '已取消重绘任务' : '重绘失败')
    if (task.status === 'failed') pushToast('error', `重绘失败：${detail}`)
    else pushToast('info', detail)
  }, [pushToast, task])

  const submit = async () => {
    if (rangeError) {
      setSubmitError(rangeError)
      return
    }
    const text = caption.trim()
    if (!text) {
      setSubmitError('请填写重绘描述（英文提示词：想在这个区间听到什么）')
      return
    }
    setSubmitError(null)
    setApplyError(null)
    setDoneTakeId(null)
    finalizedRef.current = false
    failedNotifiedRef.current = null
    const parsedSeed = Number.parseInt(seedText.replace(/[^\d]/g, ''), 10)
    submittedRef.current = {
      startSec,
      endSec,
      caption: text,
      seed: Number.isFinite(parsedSeed) ? parsedSeed : undefined,
    }
    setSubmitting(true)
    try {
      const result = await createCompanionRepaintTask(
        {
          caption: text,
          sourceAssetId: initial.assetId,
          startSec: round2(startSec),
          endSec: round2(endSec),
          seed: Number.isFinite(parsedSeed) ? parsedSeed : undefined,
          style: style.trim() || undefined,
          adapterId: adapterId || undefined,
        },
        useStore.getState().project.id,
        priority,
      )
      setTaskId(result.taskId)
      setTask({ id: result.taskId, status: result.status ?? 'queued', progress: 0 })
      pushToast('info', '已提交重绘任务，等待 Companion 处理…')
    } catch (error) {
      const detail =
        error instanceof ApiError
          ? error.status === 503
            ? error.detail ||
              error.message ||
              '没有在线 Companion：先启动本地工作节点 node scripts/companion.mjs --server <本服务地址>'
            : error.detail || error.message
          : error instanceof Error
            ? error.message
            : '提交重绘任务失败'
      setSubmitError(detail)
      pushToast('error', `重绘提交失败：${detail}`)
    } finally {
      setSubmitting(false)
    }
  }

  const cancelTask = async () => {
    if (!taskId || canceling) return
    setCanceling(true)
    try {
      const result = await cancelCompanionTask(taskId)
      setTask((previous) =>
        previous
          ? { ...previous, status: result.task?.status ?? 'canceled', message: result.task?.message ?? '已取消' }
          : previous,
      )
      pushToast('info', '已取消重绘任务')
    } catch (error) {
      const detail =
        error instanceof ApiError ? error.detail || error.message : error instanceof Error ? error.message : '取消失败'
      setSubmitError(detail)
      pushToast('error', `取消重绘失败：${detail}`)
    } finally {
      setCanceling(false)
    }
  }

  const duration = initial.durationSec
  const bandLeft = duration > 0 ? (Math.max(0, Math.min(safeStart, safeEnd)) / duration) * 100 : 0
  const bandWidth = duration > 0 ? (Math.abs(safeEnd - safeStart) / duration) * 100 : 0

  return createPortal(
    <div
      data-repaint-panel
      role="dialog"
      aria-modal="true"
      aria-label="音频局部重绘"
      className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-black/65 p-4 pt-[6vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-[680px] flex-col overflow-hidden rounded-xl border border-line-strong bg-surface-2 shadow-[0_32px_80px_-24px_rgba(0,0,0,0.9)]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
              <Wand2 size={14} className="shrink-0 text-accent" />
              局部重绘
              <span className="rounded-full border border-line bg-bg-soft px-1.5 text-[9.5px] font-normal text-ink-4">
                Companion
              </span>
            </h2>
            <p className="mt-1 min-w-0 truncate text-[11px] leading-relaxed text-ink-3" title={initial.name}>
              源片段：{initial.name} · {duration.toFixed(2)}s
              {activeTake ? ` · 当前版本「${activeTake.label || '未命名'}」` : ''}
            </p>
          </div>
          <button
            className="btn btn-ghost btn-icon -mr-1 -mt-1 h-7 w-7 shrink-0"
            onClick={onClose}
            aria-label="关闭局部重绘对话框"
            title="关闭（Esc）"
          >
            <X size={14} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!liveClip ? (
            <div className="rounded-lg border border-danger/35 bg-danger/8 px-3 py-2 text-[11px] text-ink-2">
              音频片段已不存在（可能被删除或撤销），请关闭对话框。
            </div>
          ) : (
            <>
              {/* 区间 */}
              <div className="mb-3 rounded-lg border border-line bg-bg-soft px-3 py-2.5">
                <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-medium text-ink-2">
                  <Scissors size={12} className="text-ink-3" />
                  重绘区间（相对片段内部，秒）
                </div>
                <div className="relative mb-2 h-2 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                  <div
                    className="absolute inset-y-0 rounded-full bg-accent/70"
                    style={{ left: `${bandLeft}%`, width: `${Math.max(1, bandWidth)}%` }}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  <label className="block">
                    <span className="mb-1 block text-[11px] text-ink-3">起点（秒）</span>
                    <input
                      value={startText}
                      onChange={(event) => setStartText(sanitizeDecimal(event.target.value))}
                      inputMode="decimal"
                      className="field w-full text-[12px]"
                      aria-label="重绘起点（秒）"
                      placeholder="0"
                      disabled={formDisabled}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11px] text-ink-3">终点（秒）</span>
                    <input
                      value={endText}
                      onChange={(event) => setEndText(sanitizeDecimal(event.target.value))}
                      inputMode="decimal"
                      className="field w-full text-[12px]"
                      aria-label="重绘终点（秒）"
                      placeholder={duration.toFixed(2)}
                      disabled={formDisabled}
                    />
                  </label>
                  <div className="flex items-end sm:col-span-2">
                    <button
                      type="button"
                      className="btn btn-ghost h-8 px-2 text-[10.5px]"
                      onClick={() => {
                        const range = defaultRange(duration)
                        setStartText(String(range.start))
                        setEndText(String(range.end))
                      }}
                      disabled={formDisabled}
                      title="重置为片段中间 1/3"
                    >
                      <Scissors size={10} className="mr-1" />
                      取中间 1/3
                    </button>
                  </div>
                </div>
              <p className={cn('mt-1.5 text-[10.5px] leading-relaxed', rangeError ? 'text-danger' : 'text-ink-4')}>
                {rangeError ?? `要求 0 ≤ 起点 < 终点 ≤ ${duration.toFixed(2)} 秒；重绘按整段返回替换当前版本`}
              </p>
              </div>

              {/* 描述 */}
              <label className="block">
                <span className="mb-1 flex items-center gap-1 text-[11px] font-medium text-ink-2">
                  重绘描述
                  <span className="text-danger">*</span>
                  <span className="ml-1 font-normal text-ink-4">英文提示词：这段区间想听到什么</span>
                </span>
                <textarea
                  value={caption}
                  onChange={(event) => setCaption(event.target.value)}
                  rows={3}
                  maxLength={600}
                  aria-label="重绘描述"
                  placeholder="例如 replace this section with a softer piano fill and light strings"
                  className="field w-full resize-none text-[12px] leading-relaxed"
                  disabled={formDisabled}
                />
              </label>

              {/* 可选参数 */}
              <div className="mt-2.5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <label className="block">
                  <span className="mb-1 block text-[11px] text-ink-3">风格（可选）</span>
                  <input
                    value={style}
                    onChange={(event) => setStyle(event.target.value)}
                    placeholder="cinematic"
                    className="field h-8 w-full text-[12px]"
                    aria-label="重绘风格"
                    disabled={formDisabled}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] text-ink-3">seed（可选）</span>
                  <input
                    value={seedText}
                    onChange={(event) => setSeedText(event.target.value.replace(/[^\d]/g, ''))}
                    placeholder="随机"
                    inputMode="numeric"
                    className="field h-8 w-full text-[12px]"
                    aria-label="重绘 seed"
                    disabled={formDisabled}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] text-ink-3">优先级</span>
                  <select
                    value={String(priority)}
                    onChange={(event) => setPriority(Number(event.target.value) as CompanionPriority)}
                    className="field h-8 w-full text-[12px]"
                    aria-label="重绘任务优先级"
                    disabled={formDisabled}
                    title="任务中心按 紧急 > 高 > 普通 调度"
                  >
                    <option value="0">普通</option>
                    <option value="1">高</option>
                    <option value="2">紧急</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] text-ink-3">LoRA 适配器（可选）</span>
                  <select
                    value={adapterId}
                    onChange={(event) => setAdapterId(event.target.value)}
                    className="field h-8 w-full text-[12px]"
                    aria-label="重绘适配器"
                    disabled={formDisabled || !adapters || adapters.length === 0}
                  >
                    <option value="">{adapters && adapters.length > 0 ? '默认模型' : '无可用适配器'}</option>
                    {(adapters ?? []).map((adapter) => (
                      <option key={adapter.id} value={adapter.id}>
                        {adapter.name || adapter.id}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {adapterHint && <p className="mt-1 text-[10px] text-ink-4">{adapterHint}</p>}

              {/* 进度 / 错误 */}
              {(taskId || submitError || applyError || doneTakeId) && (
                <div className="mt-3 rounded-lg border border-line bg-bg-soft px-3 py-2.5">
                  {taskId && (
                    <>
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className="text-ink-2">
                          {status ? STATUS_LABEL[status] : '已提交'}
                          {running && <span className="ml-1 text-ink-4">{Math.round(progress * 100)}%</span>}
                        </span>
                        <span className="mono truncate text-[10px] text-ink-4" title={taskId}>
                          #{taskId}
                        </span>
                        <div className="flex-1" />
                        {running && (
                          <button
                            type="button"
                            data-repaint-cancel
                            className="btn btn-ghost h-6 px-2 text-[10px]"
                            onClick={() => void cancelTask()}
                            disabled={canceling}
                            title="取消重绘任务（POST /api/companion/tasks/:id/cancel）"
                          >
                            {canceling ? <LoaderCircle size={10} className="mr-1 animate-spin" /> : null}
                            取消任务
                          </button>
                        )}
                      </div>
                      <div
                        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3"
                        data-repaint-progress={Math.round(progress * 100)}
                      >
                        <div
                          className={cn(
                            'h-full rounded-full transition-[width] duration-300',
                            status === 'failed' ? 'bg-danger' : status === 'done' ? 'bg-success' : 'bg-accent',
                          )}
                          style={{ width: `${Math.round(progress * 100)}%` }}
                        />
                      </div>
                      {task?.message && <p className="mt-1 text-[10px] leading-relaxed text-ink-4">{task.message}</p>}
                      {task?.error && <p className="mt-1 break-all text-[11px] leading-relaxed text-danger">{task.error}</p>}
                      {finished &&
                        (applying ? (
                          <p className="mt-1 flex items-center gap-1 text-[10px] text-ink-3">
                            <LoaderCircle size={10} className="animate-spin" /> 正在取新波形并写入 take…
                          </p>
                        ) : (
                          <p className="mt-1 text-[10px] text-success">
                            已写入新版本（原版本保留为 take）。可在片段右键「切换版本」里回退。
                          </p>
                        ))}
                    </>
                  )}
                  {submitError && (
                    <p className="mt-1.5 flex items-start gap-1 text-[10.5px] leading-relaxed text-danger">
                      <TriangleAlert size={11} className="mt-[2px] shrink-0" />
                      <span className="min-w-0 flex-1 break-words">{submitError}</span>
                    </p>
                  )}
                  {applyError && <p className="mt-1.5 text-[10.5px] leading-relaxed text-danger">{applyError}</p>}
                </div>
              )}
            </>
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-line px-5 py-3">
          <span className="min-w-0 flex-1 truncate text-[10.5px] leading-tight text-ink-4" title="关闭对话框会停止轮询，但任务仍在服务端继续；重绘产物为整段替换">
            关闭对话框会停止轮询，但任务仍在服务端继续；重绘产物为整段替换
          </span>
          <div className="flex-1" />
          <button className="btn btn-ghost h-8 px-3 text-[12px]" onClick={onClose}>
            {finished ? '关闭' : '取消'}
          </button>
          <button
            type="button"
            data-repaint-submit
            className="btn btn-accent h-8 px-3 text-[12px]"
            onClick={() => void submit()}
            disabled={formDisabled || Boolean(rangeError)}
            title="提交 repaint_audio 任务"
          >
            {submitting || applying ? (
              <LoaderCircle size={12} className="mr-1 animate-spin" />
            ) : (
              <Wand2 size={12} className="mr-1" />
            )}
            {submitting ? '提交中…' : applying ? '写入中…' : finished ? '已重绘' : '开始重绘'}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
