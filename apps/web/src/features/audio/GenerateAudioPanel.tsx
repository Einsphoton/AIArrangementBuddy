/**
 * 「AI 生成音频」面板（Companion 任务）。
 *
 * 流程：表单（描述必填 / BPM / 时长 / 风格 / 适配器）
 *   → POST /api/companion/tasks（type=generate_audio）
 *   → 每 900ms 轮询 GET /api/companion/tasks/:id 显示进度
 *   → done：用返回的 assetId 拉 peaks（波形缓存）并**一次 mutate** 落一条音频轨
 *   → failed 显示 error；可 POST cancel 取消；页面卸载 / 关闭面板停止轮询。
 *
 * 无 Companion 时：`GET /api/companion/status` 仍是 200 + online:false（不是 404），
 * 只有提交任务才可能 503 —— 这里把 503 的 error（带启动命令）原样展示。
 *
 * 信息架构：一屏只放主路径（描述 + BPM/时长/风格 + 提交）；
 * 优先级 / 适配器 / 质量模式 / AI 重编 / 一键整曲都收进默认折叠的「高级参数」
 * 与「一键整曲 + 分轨」，所有 data-* 自动化钩子保持不变。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Copy, LoaderCircle, SlidersHorizontal, Sparkles, TriangleAlert, Wand2, X } from 'lucide-react'
import {
  ApiError,
  cancelCompanionTask,
  createCompanionCoverTask,
  createCompanionGenerateTask,
  getAssetPeaks,
  getCompanionStatus,
  getCompanionTask,
  getProvisionStatus,
  listAdapters,
  uploadAudioAsset,
  type AdapterInfo,
  type CompanionEngine,
  type CompanionPriority,
  type CompanionStatus,
  type CompanionTaskState,
  type CompanionTaskStatus,
  type ProvisionStatus,
} from '../../lib/api'
import { cn } from '../../lib/format'
import { getAudioEngine } from '../../audio'
import { SongWorkflow } from './SongWorkflow'
import { useStore } from '../../store/store'
import { clamp, tidy } from '../arrangement/timeline'
import { assetRefFromPeaks, generatedAudioProvenance, placeAudioClip } from './audioTrack'
import { resolveCompanionHint } from './CompanionBadge'
import { primeAssetPeaks } from './peaks'

/** 轮询间隔：契约要求 800–1200ms */
const POLL_MS = 900

const STATUS_LABEL: Record<CompanionTaskStatus, string> = {
  queued: '排队中',
  running: '生成中',
  done: '已完成',
  failed: '生成失败',
  canceled: '已取消',
}

const TERMINAL: ReadonlySet<CompanionTaskStatus> = new Set(['done', 'failed', 'canceled'])

/**
 * P9 引擎量级选项（对外用中性档位名，不暴露底层模型/权重名）。
 * 标准档是默认档（旧版生成节点也支持）；增强版需要「已装增强版模型 + 节点上报增强版能力」。
 */
const ENGINE_OPTIONS: { id: CompanionEngine; label: string; hint: string }[] = [
  { id: '2b', label: '标准档', hint: '快，显存占用低' },
  { id: 'xl', label: '增强版', hint: '最佳质量，需 ≥12GB 显存' },
]

/** 增强版体积估算（服务端未给出 xl profile 时的提示数字） */
const XL_APPROX_BYTES = 23.8 * 1024 ** 3

/** 常用提示词糖：点一下就能得到一句可用的 caption */
const CAPTION_PRESETS = [
  'warm cinematic piano with soft strings, slow, emotional, 72 bpm',
  'upbeat pop rock groove, electric guitar, punchy drums, 124 bpm',
  'lofi hip hop beat, dusty vinyl, mellow keys, 82 bpm',
  'epic orchestral battle theme, brass and timpani, 150 bpm',
]

/** 折叠区（details）统一外观：去掉原生三角、hover 提亮、展开旋转箭头 */
const DETAILS_CLASS = 'group rounded-xl border border-line bg-bg-soft/60'
const SUMMARY_CLASS =
  'flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[11.5px] font-medium text-ink-2 transition-colors hover:text-ink [&::-webkit-details-marker]:hidden'

/** 多行输入里只需一个「小数输入」清洗：保留数字与一个小数点，避免 "1..2" 这类值 */
function sanitizeDecimal(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, '')
  const parts = cleaned.split('.')
  return parts.length > 1 ? `${parts[0]}.${parts.slice(1).join('')}` : cleaned
}

export function GenerateAudioPanel({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project)
  const pushToast = useStore((s) => s.pushToast)

  const [caption, setCaption] = useState('')
  const [bpm, setBpm] = useState(String(project.tempo))
  const [durationSec, setDurationSec] = useState('30')
  const [style, setStyle] = useState('')
  const [adapterId, setAdapterId] = useState('')
  /** P4-B：任务优先级（0 普通 / 1 高 / 2 紧急），默认普通 */
  const [priority, setPriority] = useState<CompanionPriority>(0)
  /** P7-A：质量模式（精修 50 步，更慢；与风格适配器互斥） */
  const [quality, setQuality] = useState(false)
  /** P9：引擎量级（标准档 / 增强版），默认标准档；增强版不可用时自动退回标准档 */
  const [engine, setEngine] = useState<CompanionEngine>('2b')
  /** P7-B：AI 重编（cover）——把当前工程渲染成 WAV 后整体换编制 */
  const [coverStrength, setCoverStrength] = useState(0.7)
  const [coverRendering, setCoverRendering] = useState(false)
  const [coverProgress, setCoverProgress] = useState(0)
  const [coverError, setCoverError] = useState<string | null>(null)

  const [adapters, setAdapters] = useState<AdapterInfo[] | null>(null)
  const [adapterHint, setAdapterHint] = useState<string | null>(null)
  const [companion, setCompanion] = useState<CompanionStatus | null>(null)
  const [companionFailed, setCompanionFailed] = useState(false)
  /** P9：本机安装状态（判断增强版模型是否已安装；拿不到时降级为「可显示但提示」） */
  const [provision, setProvision] = useState<ProvisionStatus | null>(null)
  const [provisionFailed, setProvisionFailed] = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [task, setTask] = useState<CompanionTaskState | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [canceling, setCanceling] = useState(false)
  const [placing, setPlacing] = useState(false)
  const [placedName, setPlacedName] = useState<string | null>(null)
  const [placingError, setPlacingError] = useState<string | null>(null)
  const finalizedRef = useRef(false)

  const refreshCompanion = useCallback(async () => {
    try {
      const next = await getCompanionStatus()
      setCompanion(next)
      setCompanionFailed(false)
      return next
    } catch {
      setCompanion(null)
      setCompanionFailed(true)
      return null
    }
  }, [])

  /** P9：读本机安装状态（只用于增强版可用性判断，失败不阻塞面板） */
  const refreshProvision = useCallback(async () => {
    try {
      const next = await getProvisionStatus()
      setProvision(next)
      setProvisionFailed(false)
      return next
    } catch {
      setProvision(null)
      setProvisionFailed(true)
      return null
    }
  }, [])

  /* 打开面板：拉适配器（nativeReady）与 Companion 状态 */
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
            ? '适配器接口未就绪（404），不影响使用默认模型生成'
            : '读取适配器失败，将使用默认模型',
        )
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    void refreshCompanion()
    void refreshProvision()
  }, [refreshCompanion, refreshProvision])

  /* Esc 关闭（document 捕获阶段：模态框抢在编曲视图等全局 Escape 之前关闭） */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [onClose])

  /* 轮询：任务进入终态或组件卸载时自动停止 */
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

  /** done → 取 peaks → 一次 mutate 落轨（整批可撤销） */
  const placeGeneratedAudio = useCallback(
    async (assetId: string) => {
      setPlacing(true)
      setPlacingError(null)
      try {
        const peaks = await getAssetPeaks(assetId)
        primeAssetPeaks(assetId, peaks)
        const name = caption.trim().slice(0, 40) || 'AI 生成音频'
        const asset = assetRefFromPeaks(assetId, peaks, { name: `${name}.wav` })
        const store = useStore.getState()
        const startBeat = tidy(Math.max(0, store.playhead))
        const parsedBpm = Number(bpm)
        const parsedDuration = Number(durationSec)
        const placeRef: { value: { trackId: string; clipId: string } | null } = { value: null }
        store.mutate((draft) => {
          placeRef.value = placeAudioClip(draft, {
            asset,
            durationSec: peaks.durationSec,
            name,
            startBeat,
            trackName: `生成 · ${name}`,
            provenance: generatedAudioProvenance({
              caption: caption.trim(),
              adapterId: adapterId || undefined,
              bpm: Number.isFinite(parsedBpm) ? Math.round(parsedBpm) : undefined,
              durationSec: Number.isFinite(parsedDuration) ? Math.round(parsedDuration) : undefined,
              style: style.trim() || undefined,
            }),
          })
        })
        const placed = placeRef.value
        if (placed) {
          store.selectTrack(placed.trackId)
          store.setView('arrangement')
        }
        setPlacedName(name)
        pushToast('success', `AI 音频已加入工程：${name}（⌘Z 可撤销）`)
      } catch (error) {
        setPlacingError(error instanceof Error ? error.message : '创建音频轨失败')
      } finally {
        setPlacing(false)
      }
    },
    [adapterId, bpm, caption, durationSec, pushToast, quality, style],
  )

  useEffect(() => {
    if (!task || task.status !== 'done' || !task.assetId) return
    if (finalizedRef.current) return
    finalizedRef.current = true
    void placeGeneratedAudio(task.assetId)
  }, [task, placeGeneratedAudio])

  const submit = async () => {
    const text = caption.trim()
    if (!text) {
      setSubmitError('请填写音频描述（英文提示词：风格 / 乐器 / 情绪 / 速度）')
      return
    }
    setSubmitError(null)
    setPlacingError(null)
    setPlacedName(null)
    finalizedRef.current = false
    setSubmitting(true)
    try {
      const parsedBpm = Number(bpm)
      const parsedDuration = Number(durationSec)
      const result = await createCompanionGenerateTask(
        {
          caption: text,
          bpm: Number.isFinite(parsedBpm) ? clamp(Math.round(parsedBpm), 20, 320) : undefined,
          durationSec: Number.isFinite(parsedDuration) ? clamp(parsedDuration, 1, 300) : undefined,
          style: style.trim() || undefined,
          adapterId: quality || engine === 'xl' ? undefined : adapterId || undefined,
          quality: quality || undefined,
          /* P9：显式带上引擎量级（缺省标准档；增强版需服务端/节点支持） */
          engine,
        },
        project.id,
        priority,
      )
      setTaskId(result.taskId)
      setTask({ id: result.taskId, status: result.status ?? 'queued', progress: 0 })
      pushToast('info', '已提交生成任务，等待 Companion 处理…')
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) {
        /* 无在线 Companion：把服务端 error（含启动命令）原样展示，并刷新状态 */
        setSubmitError(error.detail || error.message)
        setCompanionFailed(true)
        void refreshCompanion()
      } else if (error instanceof ApiError && error.status === 404) {
        setSubmitError('生成接口未就绪（404）：请确认后端已更新并重启')
      } else {
        setSubmitError(error instanceof Error ? error.message : '提交生成任务失败')
      }
    } finally {
      setSubmitting(false)
    }
  }

  /** P7-B：离线渲染当前工程 → 上传资产 → 提交 cover 任务（完成后复用已 done 的落轨流程） */
  const renderAndCover = async () => {
    if (coverRendering) return
    const text = caption.trim()
    if (!text) {
      pushToast('error', '先写一句描述（希望重编成什么编制/风格）')
      return
    }
    setCoverRendering(true)
    setCoverProgress(0)
    setCoverError(null)
    setSubmitError(null)
    try {
      const audioEngine = getAudioEngine()
      const blob = await audioEngine.renderToWav(project, {
        sampleRate: 44100,
        onProgress: (ratio) => setCoverProgress(Math.min(0.6, ratio * 0.6)),
      })
      setCoverProgress(0.65)
      const file = new File([blob], 'aiab-cover-source.wav', { type: 'audio/wav' })
      const uploaded = await uploadAudioAsset(file)
      setCoverProgress(0.75)
      const res = await createCompanionCoverTask(
        { sourceAssetId: uploaded.asset.id, caption: text, audioCoverStrength: coverStrength, engine },
        project.id,
        priority,
      )
      setTaskId(res.taskId)
      setTask({ id: res.taskId, status: res.status ?? 'queued', progress: 0 })
      finalizedRef.current = false
      pushToast('info', '已提交 AI 重编任务（cover），等待 Companion 处理…')
    } catch (error) {
      setCoverError(error instanceof Error ? error.message : 'AI 重编失败')
    } finally {
      setCoverRendering(false)
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
      pushToast('info', '已取消生成任务')
    } catch (error) {
      setSubmitError(error instanceof Error ? `取消失败：${error.message}` : '取消失败')
    } finally {
      setCanceling(false)
    }
  }

  const copyStartCommand = async () => {
    const hint = resolveCompanionHint(companion?.hint)
    try {
      await navigator.clipboard?.writeText(hint)
      pushToast('success', '启动命令已复制')
    } catch {
      pushToast('info', hint)
    }
  }

  const status = task?.status ?? null
  const progress = clamp(task?.progress ?? 0, 0, 1)
  const companionChecking = !companion && !companionFailed
  const offline = companionFailed || companion?.online === false
  const startHint = resolveCompanionHint(companion?.hint)
  const running = status === 'queued' || status === 'running'

  /*
   * P9：增强版可用性。
   * ① /api/provision/status 的 xl profile 未就绪 → 禁用并提示去装；
   * ② /api/companion/status 的在线节点能力里没有增强版 → 禁用并解释；
   * 状态拿不到（接口失败/尚未返回）→ 不阻塞 UI：选项可点，但提示「需已安装增强版且生成节点支持」。
   */
  const xlProfile = provision?.profiles?.find((item) => item.id === 'xl')
  const provisionChecked = provision !== null && !provisionFailed
  const xlInstalled = provisionChecked ? xlProfile?.ready === true : null
  const workers = companion?.workers ?? []
  const onlineWorkerCount = companion?.online === true ? workers.length : 0
  const xlWorkerReady = workers.some((worker) => (worker.capabilities?.models ?? []).includes('xl_turbo'))
  let xlBlockedReason: string | null = null
  if (xlInstalled === false) {
    xlBlockedReason = `增强版模型未安装：需先下载增强版模型档（约 ${(XL_APPROX_BYTES / 1024 ** 3).toFixed(1)}GB，需 ≥12GB 显存）。入口：「音频引擎」菜单 →「模型档位」。`
  } else if (companion && !companion.online) {
    xlBlockedReason = '生成节点（Companion）离线：增强版需要已启动、且上报增强版能力的节点。'
  } else if (onlineWorkerCount > 0 && !xlWorkerReady) {
    xlBlockedReason = '当前生成节点未上报增强版能力：需已安装增强版模型，并使用支持增强版的新版生成节点（旧版只支持标准档）。'
  }
  const xlUsable = xlBlockedReason === null
  const xlHint =
    xlBlockedReason ??
    (xlInstalled === null || !companion
      ? '暂时读取不到安装/节点状态：可以选，但需已安装增强版模型且生成节点支持。'
      : '增强版已就绪：快速模式使用增强版快速生成模型（质量模式用增强版精修生成模型），与风格适配器互斥。')

  /* 状态刷新后增强版变为不可用时，选择退回标准档，避免"看起来选了其实不能用" */
  useEffect(() => {
    if (!xlUsable && engine === 'xl') setEngine('2b')
  }, [xlUsable, engine])

  return createPortal(
    <div
      data-generate-audio-panel
      role="dialog"
      aria-modal="true"
      aria-label="AI 生成音频"
      className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-black/65 p-4 pt-[6vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-[680px] flex-col overflow-hidden rounded-xl border border-line-strong bg-surface-2 shadow-[0_32px_80px_-24px_rgba(0,0,0,0.9)]"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 顶部 */}
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
              <Sparkles size={14} className="shrink-0 text-accent" />
              AI 生成音频
              <span className="rounded-full border border-line bg-bg-soft px-1.5 text-[10px] font-normal text-ink-4">
                Companion
              </span>
            </h2>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">
              由本地 Companion 上的音乐生成模型产出音频，完成后自动加一条音频轨（落轨为一条撤销记录）。
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon -mr-1 -mt-1 h-7 w-7 shrink-0"
            onClick={onClose}
            aria-label="关闭 AI 生成音频面板"
            title="关闭（Esc）"
          >
            <X size={14} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* Companion 状态 */}
          <div
            data-generate-audio-status={status ?? 'idle'}
            className={cn(
              'mb-3 flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11px] leading-relaxed',
              offline ? 'border-danger/35 bg-danger/8 text-ink-2' : 'border-line bg-bg-soft text-ink-3',
            )}
          >
            <span
              className={cn(
                'mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full',
                offline ? 'bg-ink-4' : companionChecking ? 'bg-ink-3' : 'bg-success',
              )}
            />
            <div className="min-w-0 flex-1">
              {offline ? (
                <>
                  <div className="font-medium text-ink-2">Companion 离线（生成节点未连接）</div>
                  <div className="mono mt-1 break-all rounded border border-line bg-bg px-1.5 py-1 text-[10px] text-ink-3">
                    {startHint}
                  </div>
                </>
              ) : companionChecking ? (
                <div>正在检查 Companion 状态…</div>
              ) : (
                <div>
                  Companion 在线 · {companion?.summary.workers ?? 0} 节点 · 运行 {companion?.summary.running ?? 0} /
                  排队 {companion?.summary.queued ?? 0}
                </div>
              )}
            </div>
            {offline && (
              <button
                type="button"
                className="btn btn-ghost h-6 shrink-0 gap-1 px-1.5 text-[10.5px]"
                onClick={() => void copyStartCommand()}
                title="复制启动命令"
              >
                <Copy size={10} />
                复制
              </button>
            )}
          </div>

          {/* 描述 */}
          <label className="block">
            <span className="mb-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] font-medium text-ink-2">
              音频描述
              <span className="text-danger">*</span>
              <span className="font-normal text-ink-4">英文提示词 · 风格 / 乐器 / 情绪 / 速度</span>
            </span>
            <textarea
              value={caption}
              onChange={(event) => setCaption(event.target.value)}
              rows={3}
              maxLength={600}
              placeholder="例如 warm cinematic piano with soft strings, slow, emotional, 72 bpm"
              className="field w-full resize-none text-[12.5px] leading-relaxed"
              aria-label="音频描述（caption）"
              data-generate-audio-caption
            />
          </label>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {CAPTION_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className="chip max-w-full truncate text-[10.5px]"
                title={preset}
                onClick={() => setCaption(preset)}
              >
                {preset.slice(0, 32)}…
              </button>
            ))}
          </div>

          {/* 主路径参数：只保留风格/速度相关三项 */}
          <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-[11px] text-ink-3">BPM</span>
              <input
                value={bpm}
                onChange={(event) => setBpm(event.target.value.replace(/[^\d]/g, ''))}
                inputMode="numeric"
                className="field w-full text-[12.5px]"
                aria-label="生成 BPM"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-ink-3">时长（秒）</span>
              <input
                value={durationSec}
                onChange={(event) => setDurationSec(sanitizeDecimal(event.target.value))}
                inputMode="decimal"
                className="field w-full text-[12.5px]"
                aria-label="生成时长（秒）"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-ink-3">
                风格（可选）<span className="ml-1 text-ink-4">如 cinematic</span>
              </span>
              <input
                value={style}
                onChange={(event) => setStyle(event.target.value)}
                placeholder="cinematic"
                className="field w-full text-[12.5px]"
                aria-label="生成风格"
              />
            </label>
          </div>

          {/* 高级参数（默认收起） */}
          <details className={cn(DETAILS_CLASS, 'mt-4')} data-generate-audio-advanced>
            <summary className={SUMMARY_CLASS}>
              <SlidersHorizontal size={12} className="shrink-0 text-ink-3" />
              高级参数
              <span className="min-w-0 truncate text-[10.5px] font-normal text-ink-4">
                优先级 · 适配器 · 引擎量级 · 质量模式 · AI 重编
              </span>
              <ChevronDown size={12} className="ml-auto shrink-0 text-ink-4 transition-transform group-open:rotate-180" />
            </summary>
            <div className="space-y-3 border-t border-line/70 px-3 py-3">
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-[11px] text-ink-3">优先级</span>
                  <select
                    value={String(priority)}
                    onChange={(event) => setPriority(Number(event.target.value) as CompanionPriority)}
                    className="field w-full text-[12.5px]"
                    aria-label="生成任务优先级"
                    title="任务中心按 紧急 > 高 > 普通 调度；Companion 空闲时立即执行"
                  >
                    <option value="0">普通</option>
                    <option value="1">高</option>
                    <option value="2">紧急</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] text-ink-3">风格适配器（可选）</span>
                  <select
                    value={adapterId}
                    onChange={(event) => setAdapterId(event.target.value)}
                    className="field w-full text-[12.5px]"
                    aria-label="风格适配器"
                    disabled={quality || engine === 'xl' || !adapters || adapters.length === 0}
                  >
                    <option value="">
                      {engine === 'xl'
                        ? '增强版不使用风格适配器'
                        : adapters && adapters.length > 0
                          ? '默认模型'
                          : '无可用适配器'}
                    </option>
                    {(adapters ?? []).map((adapter) => (
                      <option key={adapter.id} value={adapter.id}>
                        {adapter.name || adapter.id}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {adapterHint && <p className="text-[10.5px] leading-relaxed text-ink-4">{adapterHint}</p>}

              {/* P9 引擎量级：标准档 / 增强版（与质量模式共存：增强版 + 质量 = 增强版精修） */}
              <div className="rounded-lg border border-line bg-surface-2/50 px-2.5 py-2">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-[11px] font-medium text-ink-2">引擎量级</span>
                  <span className="text-[10px] text-ink-4">默认标准档（快）；增强版质量更好但需要额外模型与显存</span>
                </div>
                <div className="mt-1.5 flex gap-1.5" role="group" aria-label="引擎量级">
                  {ENGINE_OPTIONS.map((option) => {
                    const isXl = option.id === 'xl'
                    const optionDisabled = isXl && !xlUsable
                    const active = engine === option.id
                    return (
                      <button
                        key={option.id}
                        type="button"
                        data-engine-option={option.id}
                        aria-pressed={active}
                        disabled={optionDisabled}
                        title={optionDisabled ? xlHint : option.hint}
                        onClick={() => {
                          setEngine(option.id)
                          /* 增强版与标准档的风格适配器基座不同，切到增强版时清空适配器 */
                          if (isXl) setAdapterId('')
                        }}
                        className={cn(
                          'min-w-0 flex-1 rounded-md border px-2 py-1.5 text-left transition-colors',
                          active
                            ? 'border-accent/60 bg-accent/12 text-ink'
                            : 'border-line bg-surface-2/60 text-ink-3 hover:border-accent/35',
                          optionDisabled && 'cursor-not-allowed opacity-45 hover:border-line',
                        )}
                      >
                        <span className="block text-[10.5px] font-medium">{option.label}</span>
                        <span className="mt-0.5 block truncate text-[9px] text-ink-4">{option.hint}</span>
                      </button>
                    )
                  })}
                </div>
                <p data-engine-hint className="mt-1 text-[10px] leading-relaxed text-ink-4">
                  {xlHint}
                </p>
              </div>

              {/* P7-A 质量模式 */}
              <label className="flex items-start gap-2 rounded-lg border border-line bg-surface-2/50 px-2.5 py-2 text-[11px] text-ink-3">
                <input
                  type="checkbox"
                  data-quality-toggle
                  checked={quality}
                  onChange={(event) => {
                    setQuality(event.target.checked)
                    if (event.target.checked) setAdapterId('')
                  }}
                  className="mt-[1px] h-4 w-4 shrink-0 accent-[var(--accent,#4fd1c5)]"
                />
                <span className="min-w-0">
                  <span className="font-medium text-ink-2">质量模式（精修 50 步）</span>
                  <span className="mt-0.5 block text-[10.5px] leading-relaxed text-ink-4">
                    更慢（20s 音频约 15–25s），高频/编曲更完整；与风格适配器互斥（勾选后自动清空适配器）。
                    与引擎量级组合：标准档 → 精修生成模型，增强版 → 增强版精修生成模型（含提示词增强）。
                  </span>
                </span>
              </label>

              {/* P7-B AI 重编（cover） */}
              <div className="rounded-lg border border-line bg-surface-2/50 px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-ink-2">AI 重编（cover）：渲染当前工程 → 换编制</span>
                  <button
                    type="button"
                    data-cover-render
                    className="btn h-6 shrink-0 px-2 text-[10.5px]"
                    onClick={() => void renderAndCover()}
                    disabled={coverRendering || running || offline}
                    title="把当前工程离线渲染成 WAV，交给模型保结构换编制（不改变你的 MIDI）"
                  >
                    {coverRendering ? (
                      <LoaderCircle size={10} className="mr-1 animate-spin" />
                    ) : (
                      <Sparkles size={10} className="mr-1" />
                    )}
                    {coverRendering ? '渲染中…' : '渲染并重编'}
                  </button>
                </div>
                <label className="mt-2 flex items-center gap-2 text-[10.5px] text-ink-4">
                  <span className="shrink-0">贴近原结构</span>
                  <input
                    type="range"
                    data-cover-strength
                    min={0}
                    max={1}
                    step={0.05}
                    value={coverStrength}
                    onChange={(event) => setCoverStrength(Number(event.target.value))}
                    className="h-2 flex-1 accent-[var(--accent,#4fd1c5)]"
                  />
                  <span className="mono w-8 shrink-0 text-right">{coverStrength.toFixed(2)}</span>
                </label>
                <p className="mt-1 text-[10px] leading-relaxed text-ink-4">
                  越高越保留你 MIDI 的旋律/节奏走向（0.7 推荐）；越低越自由。重编产物作为新音频轨加入，不改动原轨。
                </p>
                {coverRendering && <p className="mt-1 text-[10.5px] text-ink-3">渲染进度 {Math.round(coverProgress * 100)}%…</p>}
                {coverError && <p className="mt-1 text-[10.5px] leading-relaxed text-danger">{coverError}</p>}
              </div>
            </div>
          </details>

          {/* P7-E 一键整曲 + 分轨（进阶工作流，默认收起） */}
          <details className={cn(DETAILS_CLASS, 'mt-2.5')} data-generate-audio-song-workflow>
            <summary className={SUMMARY_CLASS}>
              <Sparkles size={12} className="shrink-0 text-accent/80" />
              一键整曲 + 分轨 Stem
              <span className="min-w-0 truncate text-[10.5px] font-normal text-ink-4">
                先生成整曲，再逐条生成独立分轨
              </span>
              <ChevronDown size={12} className="ml-auto shrink-0 text-ink-4 transition-transform group-open:rotate-180" />
            </summary>
            <div className="border-t border-line/70 px-3 py-3 [&>div]:mt-0 [&>div]:border-0 [&>div]:bg-transparent [&>div]:px-0 [&>div]:py-0">
              <SongWorkflow caption={caption} quality={quality} priority={priority} offline={offline} engine={engine} />
            </div>
          </details>

          {/* 进度 / 错误 */}
          {(taskId || submitError || placingError) && (
            <div className="mt-3 rounded-lg border border-line bg-bg-soft px-3 py-2.5">
              {taskId && (
                <>
                  <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
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
                        data-generate-audio-cancel
                        className="btn btn-ghost h-6 px-2 text-[10.5px]"
                        onClick={() => void cancelTask()}
                        disabled={canceling}
                        title="取消生成任务（POST /api/companion/tasks/:id/cancel）"
                      >
                        {canceling ? <LoaderCircle size={10} className="mr-1 animate-spin" /> : null}
                        取消任务
                      </button>
                    )}
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3" data-generate-audio-progress={Math.round(progress * 100)}>
                    <div
                      className={cn(
                        'h-full rounded-full transition-[width] duration-300',
                        status === 'failed' ? 'bg-danger' : status === 'done' ? 'bg-success' : 'bg-accent',
                      )}
                      style={{ width: `${Math.round(progress * 100)}%` }}
                    />
                  </div>
                  {task?.message && <p className="mt-1 text-[10.5px] leading-relaxed text-ink-4">{task.message}</p>}
                  {task?.error && (
                    <p className="mt-1 break-all text-[11px] leading-relaxed text-danger">{task.error}</p>
                  )}
                  {status === 'done' &&
                    (placing ? (
                      <p className="mt-1 flex items-center gap-1 text-[11px] text-ink-3">
                        <LoaderCircle size={10} className="animate-spin" /> 正在取波形并创建音频轨…
                      </p>
                    ) : placedName ? (
                      <p className="mt-1 text-[11px] text-success">
                        已加入工程：{placedName}（在编曲视图播放头位置，⌘Z 可撤销）
                      </p>
                    ) : null)}
                </>
              )}
              {submitError && (
                <p className="mt-1.5 flex items-start gap-1 text-[11px] leading-relaxed text-danger">
                  <TriangleAlert size={11} className="mt-[2px] shrink-0" />
                  <span className="min-w-0 flex-1 break-words">{submitError}</span>
                </p>
              )}
              {placingError && <p className="mt-1.5 text-[11px] leading-relaxed text-danger">{placingError}</p>}
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <footer className="flex shrink-0 items-center gap-2 border-t border-line px-5 py-3">
          <span className="min-w-0 flex-1 truncate text-[10.5px] leading-tight text-ink-4" title="一期：音频按原速播放，片段从播放头开始，不支持变速 / 时间拉伸">
            一期：音频按原速播放，片段从播放头开始，不支持变速 / 时间拉伸
          </span>
          <button className="btn btn-ghost h-8 shrink-0 px-3 text-[12px]" onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            data-generate-audio-submit
            className="btn btn-accent h-8 shrink-0 px-3 text-[12px]"
            onClick={() => void submit()}
            disabled={submitting || Boolean(taskId && running)}
            title="提交音频生成任务"
          >
            {submitting ? <LoaderCircle size={12} className="mr-1 animate-spin" /> : <Wand2 size={12} className="mr-1" />}
            {submitting ? '提交中…' : '开始生成'}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
