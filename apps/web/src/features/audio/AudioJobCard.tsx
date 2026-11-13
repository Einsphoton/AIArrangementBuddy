/**
 * AI 面板内的音频任务卡 —— 「AI 生成舞台」。
 *
 * 与「任务中心」不同，这里只跟当前这一条 AI 触发的音频计划：
 * 模式、步骤（整曲 / 每条 stem / 渲染）、进度、取消、失败原因与下一步动作。
 *
 * 视觉结构：
 *   生成光球 + 标题 / 实时叙事行 / 动态频谱（进度揭示 + 扫描线）/ 大字进度 + ETA /
 *   横向分轨管道 / 取消与状态。阻塞态换成「等待节点接入」雷达待机舞台，
 *   并自动轮询 Companion，节点上线后自动继续任务（不伪造成功）。
 *
 * 硬约束：卡内无 <10px 文本、无横向溢出、按钮不换行；动效全部在
 * styles/index.css 的 `.gen-*` 段（transform / opacity + 进度 clip-path 揭示），
 * prefers-reduced-motion 下有静态回退。
 */
import { useEffect, useRef, useState } from 'react'
import {
  Check,
  CircleStop,
  Copy,
  Download,
  LoaderCircle,
  Play,
  RefreshCw,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useStore } from '../../store/store'
import { cn } from '../../lib/format'
import {
  companionVariantLabel,
  getCompanionStatus,
  type CompanionEngineLive,
  type CompanionStatus,
} from '../../lib/api'
import { cancelAudioJob, retryAudioJob } from './audioIntent'
import {
  useAudioJobStore,
  type AudioJob,
  type AudioJobPhase,
  type AudioJobStep,
  type AudioJobTelemetry,
} from './audioJobStore'
import {
  BlockedRadar,
  EngineTelemetryHud,
  GenerationOrb,
  GenerationSpectrum,
  GenerationStageRail,
  MODE_SHORT,
  StartChecklist,
  TrackPipeline,
  fallbackPhase,
  pipelineSummary,
  stepMeta,
  type CheckItem,
} from './AudioGenerationStage'
import { useCompanionNode } from './useCompanionNode'

/** 阻塞态自动检测 Companion 的轮询间隔（页面隐藏时跳过） */
const DETECT_POLL_MS = 2500

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** 剩余时间：排队用服务端 etaSec；运行中按「已用 × (1-p)/p」估算，取整到 5s */
function estimateEta(job: AudioJob, step: AudioJobStep | undefined, now: number): number | undefined {
  if (!step) return undefined
  if (step.queuePosition != null) {
    return typeof step.etaSec === 'number' && Number.isFinite(step.etaSec) ? Math.max(0, Math.round(step.etaSec)) : undefined
  }
  const progress = Math.max(0, Math.min(1, step.progress))
  if (progress <= 0.08) return undefined
  const startedAt = step.startedAt ?? job.createdAt
  const elapsedSec = Math.max(1, (now - startedAt) / 1000)
  const remaining = (elapsedSec * (1 - progress)) / progress
  if (!Number.isFinite(remaining) || remaining <= 0) return undefined
  return Math.round(remaining / 5) * 5
}

interface Narration {
  key: string
  text: string
}

/** 叙事行：让等待有「AI 正在做什么」的代入感；key 变化触发 fade-up */
function buildNarration(
  job: AudioJob,
  step: AudioJob['steps'][number] | undefined,
  telemetry: AudioJobTelemetry | undefined,
): Narration {
  if (job.status === 'done') return { key: 'done', text: '生成完成 · 已写入工程' }
  if (job.status === 'failed') return { key: 'failed', text: '音频生成中断 · 可重试或关闭' }
  if (!step) return { key: 'prep', text: '正在准备音频生成…' }
  if (step.queuePosition != null) {
    const wait = step.etaSec != null ? `，预计 ${Math.max(0, Math.round(step.etaSec))} 秒` : ''
    // 服务端 queuePosition 是 0-based（第一个排队任务 = 0），展示时 +1
    return { key: `queue-${step.key}-${step.queuePosition}`, text: `排队中 · 第 ${step.queuePosition + 1} 位${wait}` }
  }
  const progress = Math.max(0, Math.min(1, step.progress))
  const phase = telemetry?.phase
  const stepCount =
    telemetry?.stepTotal != null && telemetry.step != null
      ? `${telemetry.estimated ? '≈' : ''}第 ${telemetry.step}/${telemetry.stepTotal} 步`
      : ''
  const speed = telemetry?.speed != null && telemetry.speed > 0 ? `${telemetry.speed.toFixed(1)} 步/s` : ''
  // 引擎阶段优先：服务端给出阶段时直接说明「在哪一步」，不再只靠进度猜
  if (phase === 'engine') {
    const variant = telemetry?.engine?.variant ? companionVariantLabel(telemetry.engine.variant) : ''
    return {
      key: 'phase-engine',
      text: `${telemetry?.phaseLabel ?? '正在载入音频引擎'}${variant ? ` · ${variant}` : ''}（冷启动可能需 30–60s）`,
    }
  }
  if (phase === 'prompt') {
    return { key: 'phase-prompt', text: telemetry?.phaseLabel ?? '正在理解你的描述，整理编曲结构…' }
  }
  if (phase === 'sampling') {
    return {
      key: `phase-sampling-${telemetry?.step ?? 0}`,
      text: `正在扩散采样${stepCount ? ` · ${stepCount}` : ''}${speed ? ` · ${speed}` : ''}`,
    }
  }
  if (phase === 'decoding') return { key: 'phase-decoding', text: '正在解码音频波形…' }
  if (phase === 'upload') return { key: 'phase-upload', text: '正在写入轨道…' }
  if (step.key === 'render') {
    return progress >= 0.9
      ? { key: 'render-write', text: '正在写入轨道…' }
      : { key: 'render-run', text: '正在离线渲染整曲音频…' }
  }
  if (progress >= 0.94) return { key: `${step.key}-write`, text: '正在写入轨道…' }
  const meta = stepMeta(step)
  if (meta.kind === 'song') {
    return progress <= 0.02
      ? {
          key: 'song-wake',
          text: job.steps.length > 1 ? '正在唤醒音频引擎，准备生成整曲…' : '正在唤醒音频引擎…',
        }
      : { key: 'song-run', text: '正在合成整曲音频…' }
  }
  return { key: `${step.key}-run`, text: `正在生成「${meta.label}」分轨…` }
}


interface BlockedCopy {
  title: string
  body: string
  tone: 'companion' | 'provision'
}

/** 阻塞态文案：琥珀 + 紫罗兰的「待接入」观感，不用大面积红色报错 */
function blockedCopy(job: AudioJob): BlockedCopy {
  if (job.blockReason === 'provision') {
    return {
      title: '安装本机音频引擎后继续',
      body: job.error ?? '本机还缺少生成音频所需的模型，安装完成后即可继续。',
      tone: 'provision',
    }
  }
  const disconnected = job.error?.includes('无法连接本地服务') === true
  return {
    title: '等待生成节点接入',
    body: disconnected
      ? job.error ?? '本地服务未启动，暂时无法检查音频引擎。'
      : '模型已就绪，只差在你的 GPU 机器上启动生成节点；启动后这里会自动继续。',
    tone: 'companion',
  }
}

/**
 * 合并两路遥测：任务轮询（更贴近当前任务）优先，心跳 worker 快照补足资源字段。
 * 只保留有值的字段，避免把任务里已有的阶段/步数覆盖成 undefined。
 */
function mergeTelemetry(
  task: AudioJobTelemetry | undefined,
  engine: CompanionEngineLive | undefined,
  workerName?: string,
): AudioJobTelemetry | undefined {
  if (!task && !engine) return undefined
  const merged: AudioJobTelemetry = { ...task }
  if (engine) {
    // 任务轮询（~1s）里的遥测比心跳（5s）新，已有值不覆盖
    if (engine.cpuPct != null && merged.cpuPct == null) merged.cpuPct = engine.cpuPct
    if (engine.rssMb != null && merged.rssMb == null) merged.rssMb = engine.rssMb
    if (engine.gpuName && merged.gpuName == null) merged.gpuName = engine.gpuName
    if (engine.gpuUtilPct != null && merged.gpuUtilPct == null) merged.gpuUtilPct = engine.gpuUtilPct
    if (engine.vramUsedMb != null && merged.vramUsedMb == null) merged.vramUsedMb = engine.vramUsedMb
    if (engine.vramTotalMb != null && merged.vramTotalMb == null) merged.vramTotalMb = engine.vramTotalMb
    if (engine.gpuTempC != null && merged.gpuTempC == null) merged.gpuTempC = engine.gpuTempC
    if (engine.sampledAt != null && merged.sampledAt == null) merged.sampledAt = engine.sampledAt
    if (engine.phase && !merged.phase) merged.phase = engine.phase as AudioJobPhase
    if (engine.phaseLabel && !merged.phaseLabel) merged.phaseLabel = engine.phaseLabel
    if (engine.step != null && merged.step == null) merged.step = engine.step
    if (engine.stepTotal != null && merged.stepTotal == null) merged.stepTotal = engine.stepTotal
    if (engine.speed != null && merged.speed == null) merged.speed = engine.speed
    if (engine.estimated != null && merged.estimated == null) merged.estimated = engine.estimated
    merged.engine = {
      ...(merged.engine ?? {}),
      ...(engine.state ? { state: engine.state } : {}),
      ...(engine.variant ? { variant: engine.variant } : {}),
      ...(engine.device ? { device: engine.device } : {}),
      ...(engine.warm != null ? { warm: engine.warm } : {}),
      ...(engine.pid != null ? { pid: engine.pid } : {}),
      ...(engine.lm !== undefined ? { lm: engine.lm } : {}),
    }
  }
  if (workerName) merged.workerName = workerName
  return merged
}

export function AudioJobCard({ compact = false }: { compact?: boolean }) {
  const job = useAudioJobStore((s) => s.job)
  const slots = useAudioJobStore((s) => s.slots)
  const hidden = useAudioJobStore((s) => s.hidden)
  const clear = useAudioJobStore((s) => s.clear)
  const setHidden = useAudioJobStore((s) => s.setHidden)
  const pushToast = useStore((s) => s.pushToast)
  const [canceling, setCanceling] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  /** P13：节点/引擎快照（运行中 5s 轮询、阻塞时 2.5s 轮询；任务详情里的遥测更实时） */
  const [companion, setCompanion] = useState<CompanionStatus | null>(null)
  const [companionFailed, setCompanionFailed] = useState(false)
  /** 同一阻塞任务只自动继续一次，避免节点状态抖动时重复拉起 */
  const autoResumedRef = useRef<string | null>(null)
  /**
   * P15：本机生成节点（Companion 进程）控制器。
   *
   * 这才是「等再久也不动」的解法：以前界面只给复制命令，而那个进程从来不会自己起来。
   * 现在阻塞态直接给一个「启动生成节点」按钮，由服务端把本机节点拉起。
   */
  const nodeCtl = useCompanionNode({
    onStarted: () => {
      const current = useAudioJobStore.getState().job
      if (current && current.status === 'blocked' && current.retryable) {
        autoResumedRef.current = current.id
        retryAudioJob(current.id)
      }
    },
  })

  /* 运行 / 等待中每秒刷新计时（关闭卡片或组件卸载时自动清理） */
  useEffect(() => {
    if (!job || (job.status !== 'running' && job.status !== 'blocked')) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [job?.id, job?.status])

  /* 节点/引擎状态：阻塞时 2.5s 检测并自动续跑；运行中 5s 刷新引擎遥测 */
  useEffect(() => {
    if (!job) return
    const waiting = job.status === 'blocked' && job.blockReason === 'start-companion'
    const runningJob = job.status === 'running'
    if (!waiting && !runningJob) return
    const jobId = job.id
    const blockedJob = waiting
    let cancelled = false

    const probe = async () => {
      if (cancelled || document.hidden) return
      try {
        const status = await getCompanionStatus()
        if (cancelled) return
        setCompanion(status)
        setCompanionFailed(false)
        const online = status.online && (status.summary?.workers ?? 0) > 0
        if (!blockedJob || !online || autoResumedRef.current === jobId) return
        autoResumedRef.current = jobId
        if (retryAudioJob(jobId)) {
          pushToast('success', '生成节点已上线，继续生成音频…')
        } else {
          autoResumedRef.current = null
        }
      } catch {
        if (!cancelled) setCompanionFailed(true)
        /* 后端未就绪：保持等待提示，下个周期再试 */
      }
    }

    void probe()
    const timer = window.setInterval(() => void probe(), blockedJob ? DETECT_POLL_MS : 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [job?.id, job?.status, job?.blockReason, pushToast])

  if (!job || job.status === 'canceled' || hidden) return null

  const running = job.status === 'running'
  const blocked = job.status === 'blocked'
  const done = job.status === 'done'
  const failed = job.status === 'failed'
  const tone = done ? 'done' : failed ? 'failed' : blocked ? 'blocked' : 'run'
  const completed = done || failed

  const elapsedBase =
    job.steps.reduce<number>(
      (min, step) => (step.startedAt && (!min || step.startedAt < min) ? step.startedAt : min),
      0,
    ) || job.createdAt
  const elapsedMs = Math.max(0, (completed ? job.updatedAt : now) - elapsedBase)

  const runningStep = job.steps.find((step) => step.status === 'running')
  const queued = Boolean(runningStep && runningStep.queuePosition != null)
  const percent = done ? 100 : Math.max(0, Math.min(100, Math.round(job.progress * 100)))
  const etaSec = estimateEta(job, runningStep, now)
  const waitSec = Math.max(0, Math.floor(elapsedMs / 1000))

  const companionWorkers = companion?.workers ?? []
  const worker =
    companionWorkers.find((item) => job.taskId && item.status?.currentTaskId === job.taskId) ??
    companionWorkers.find((item) => item.status?.busy) ??
    companionWorkers[0]
  const engineLive = worker?.status?.engine ?? worker?.engine
  const telemetry = mergeTelemetry(job.telemetry, engineLive, worker?.name)
  const phase: AudioJobPhase | undefined = runningStep
    ? telemetry?.phase ?? fallbackPhase(job.mode, job.progress, queued)
    : undefined
  const hudTelemetry: AudioJobTelemetry | undefined = runningStep
    ? { ...(telemetry ?? {}), phase, phaseLabel: telemetry?.phaseLabel ?? runningStep.message }
    : telemetry
  // 有采样步数/速度时用「剩余步数 ÷ 速度」估 ETA，比整体进度外推更贴近当前阶段
  const stepEtaSec =
    runningStep &&
    telemetry?.step != null &&
    telemetry.stepTotal != null &&
    telemetry.speed != null &&
    telemetry.speed > 0.05
      ? Math.max(0, Math.round((telemetry.stepTotal - telemetry.step) / telemetry.speed / 5) * 5)
      : undefined
  const displayEtaSec = stepEtaSec ?? etaSec
  const displayEtaText =
    displayEtaSec != null ? `预计 ${formatElapsed(displayEtaSec * 1000)}` : `已用 ${formatElapsed(elapsedMs)}`
  const narration = buildNarration(job, runningStep, hudTelemetry)
  const compactSummary = done
    ? job.placed.length > 0
      ? `已写入 ${job.placed.length} 条轨`
      : '已写入工程'
    : pipelineSummary(job.steps)
  const checkItems: CheckItem[] = [
    {
      key: 'service',
      label: '本地服务',
      state: companionFailed ? 'bad' : companion ? 'ok' : 'pending',
      value: companionFailed ? '未连接' : companion ? '在线' : '检测中',
    },
    {
      key: 'worker',
      label: '生成节点',
      state: companion?.online === true && (companion.summary?.workers ?? 0) > 0 ? 'ok' : 'bad',
      value:
        companion?.online === true
          ? `${companion.summary?.workers ?? 0} 在线`
          : companion
            ? '未连接'
            : '待检测',
    },
    {
      key: 'model',
      label: '音频模型',
      state: job.blockReason === 'start-companion' ? 'ok' : job.blockReason === 'provision' ? 'bad' : 'pending',
      value:
        job.blockReason === 'start-companion' ? '已就绪' : job.blockReason === 'provision' ? '未安装' : '未知',
    },
  ]

  const copyHint = async () => {
    const hint = job.hint
    if (!hint) return
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(hint)
      pushToast('success', '启动命令已复制')
    } catch {
      pushToast('info', hint)
    }
  }

  const handleRetry = () => {
    if (!retryAudioJob(job.id)) pushToast('info', '暂时无法直接重试，请重新发起音频生成')
  }

  const handleCancel = () => {
    if (canceling) return
    setCanceling(true)
    void cancelAudioJob().finally(() => setCanceling(false))
  }

  /** 运行中关闭 = 收起，不中断生成（避免「生成完了却没有结果」）；终态才真正关闭 */
  const handleClose = () => {
    if (job.status === 'running' || job.status === 'blocked') {
      setHidden(true)
      pushToast('info', '任务卡已收起，音频生成会继续；可在轨道头点「查看」恢复')
      return
    }
    clear()
  }

  const openProvision = () => {
    window.dispatchEvent(
      new CustomEvent('aiab:provision-open', {
        detail: {
          reason: job.error,
          profiles: job.mode === 'audio_with_stems' ? ['essential', 'stems'] : ['essential'],
          source: 'audio-intent',
        },
      }),
    )
  }

  const blockedState = blocked ? blockedCopy(job) : null
  const progressFill = done ? 1 : Math.max(0.005, Math.min(1, job.progress))

  return (
    <div
      data-audio-job
      data-audio-job-status={job.status}
      data-audio-job-tone={tone}
      data-audio-job-progress={percent}
      data-audio-job-compact={compact ? 'true' : 'false'}
      className={cn('gen-card', compact && 'gen-card--compact')}
      data-tone={tone}
    >
      {/* 头部：生成光球 + 标题 + 模式 chip + 已用时间 + 关闭 */}
      <div className="flex items-center gap-1.5">
        <GenerationOrb mode={job.mode} status={job.status} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold leading-4 text-ink" title={job.title}>
          {job.title}
        </span>
        {!compact && <span className="gen-mode-chip">{MODE_SHORT[job.mode]}</span>}
        <span className="mono shrink-0 text-[10px] tabular-nums text-ink-3" title="已用时间">
          {formatElapsed(elapsedMs)}
        </span>
        {compact && running && (
          <button
            type="button"
            data-audio-job-cancel
            className="gen-icon-btn"
            aria-label="取消音频任务"
            title={canceling ? '正在取消…' : '取消任务'}
            disabled={canceling}
            onClick={handleCancel}
          >
            {canceling ? <LoaderCircle size={11} className="animate-spin" /> : <CircleStop size={11} />}
          </button>
        )}
        <button
          type="button"
          className="gen-icon-btn"
          title={running || blocked ? '收起任务卡（任务会继续）' : '关闭'}
          aria-label="关闭音频任务卡"
          onClick={handleClose}
        >
          <X size={11} />
        </button>
      </div>

      {/* 运行 / 完成：叙事 + 动态频谱 + 进度 + 分轨管道 */}
      {(running || done) && (
        <>
          <p className="gen-narration mt-1.5" aria-live="polite" aria-atomic="true">
            <span key={narration.key} className="block animate-fade-up truncate">
              {narration.text}
            </span>
          </p>
          <GenerationSpectrum
            className="mt-1.5"
            progress={done ? 1 : job.progress}
            state={queued ? 'queued' : done ? 'done' : 'running'}
            size={compact ? 'sm' : 'md'}
          />
          {compact ? (
            <>
              <div className="mt-1 flex items-center gap-1.5 text-[10.5px] leading-[13px] text-ink-3">
                <span className="min-w-0 flex-1 truncate">{compactSummary}</span>
                <span className="mono shrink-0 text-[11px] font-semibold tabular-nums text-ink">{percent}%</span>
              </div>
              <div className="gen-progress mt-1">
                <span className="gen-progress-fill" style={{ transform: `scaleX(${progressFill})` }} />
                <span className="gen-progress-head" style={{ left: `${percent}%` }} />
              </div>
            </>
          ) : (
            <>
              <div className="gen-progress-row mt-2">
                <span className="gen-percent mono tabular-nums">{percent}%</span>
                <span className="mono min-w-0 truncate text-[10px] tabular-nums text-ink-3">
                  {done ? `已用 ${formatElapsed(elapsedMs)}` : displayEtaText}
                </span>
              </div>
              <div className="gen-progress mt-1">
                <span className="gen-progress-fill" style={{ transform: `scaleX(${progressFill})` }} />
                <span className="gen-progress-head" style={{ left: `${percent}%` }} />
              </div>

              {running ? (
                <>
                  <GenerationStageRail
                    className="mt-2"
                    mode={job.mode}
                    phase={phase}
                    progress={job.progress}
                    queued={queued}
                    done={false}
                  />
                  <EngineTelemetryHud
                    className="mt-1.5"
                    telemetry={hudTelemetry}
                    fallbackState="running"
                    mode={job.mode}
                  />
                  <TrackPipeline className="mt-2" steps={job.steps} />
                </>
              ) : (
                <div className="mt-2 flex items-center gap-1.5">
                  <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                    {job.placed.length > 0 ? (
                      job.placed.map((name) => (
                        <span key={name} className="gen-placed-chip" title={name}>
                          {name}
                        </span>
                      ))
                    ) : (
                      <span className="flex items-center gap-1 text-[10.5px] leading-[18px] text-success">
                        <Check size={10} />已写入工程
                      </span>
                    )}
                  </div>
                  <span className="mono shrink-0 text-[10px] text-ink-4">⌘Z 可撤销</span>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* 运行底部：取消 + 已加入轨数 */}
      {running && !compact && (
        <div className="mt-2 flex items-center gap-1.5">
          <button
            type="button"
            data-audio-job-cancel
            className="gen-btn"
            disabled={canceling}
            onClick={handleCancel}
          >
            {canceling ? <LoaderCircle size={10} className="animate-spin" /> : <CircleStop size={10} />}
            取消
          </button>
          <span className="ml-auto flex min-w-0 items-center gap-1 text-[10px] text-ink-4">
            <span className="gen-live-dot" aria-hidden="true" />
            <span className="truncate">
              {slots.length + job.placed.length > 0
                ? `${job.placed.length > 0 ? `已落 ${job.placed.length} 条 · ` : ''}DAW 已建 ${slots.length + job.placed.length} 条轨`
                : 'AI 自动执行中'}
            </span>
          </span>
        </div>
      )}

      {/* 阻塞：等待节点接入（琥珀 + 紫罗兰待机观感，雷达 + 启动命令 + 自动检测） */}
      {blocked && blockedState && (
        <>
          <div className="mt-2 flex items-start gap-2">
            <BlockedRadar tone={blockedState.tone} />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold leading-4 text-accent-soft">{blockedState.title}</p>
              <p className="mt-1 break-words text-[11px] leading-[15px] text-ink-2">{blockedState.body}</p>
              <StartChecklist className="mt-1.5" items={checkItems} />
              {job.blockReason === 'start-companion' && (
                <p className="mt-1 flex items-center gap-1 text-[10px] leading-[13px] text-ink-4">
                  <span className="gen-detect-dot" aria-hidden="true" />
                  <span className="truncate">正在自动检测节点… 已等待 {waitSec}s</span>
                </p>
              )}
              {job.blockReason === 'provision' && job.hint && (
                <p className="mt-1 break-words text-[10px] leading-[13px] text-ink-4">{job.hint}</p>
              )}
            </div>
          </div>

          {job.blockReason === 'start-companion' && job.hint && (
            <div className="gen-command mt-2" data-audio-job-command title={job.hint}>
              <span className="gen-command-text">{job.hint}</span>
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {/* P15：主操作 = 由服务端把本机生成节点拉起来（原来只有「复制命令」，用户得自己开终端） */}
            {job.blockReason === 'start-companion' && nodeCtl.available && (
              <button
                type="button"
                data-audio-job-start-node
                className="gen-btn gen-btn-accent"
                disabled={nodeCtl.starting}
                title={
                  nodeCtl.starting
                    ? '正在启动生成节点并等待注册…'
                    : '在本机启动生成节点（Companion），成功后自动继续生成'
                }
                onClick={() => {
                  void nodeCtl.start().then((online) => {
                    if (online) pushToast('success', '生成节点已上线，继续生成音频…')
                  })
                }}
              >
                {nodeCtl.starting ? <LoaderCircle size={10} className="animate-spin" /> : <Play size={10} />}
                {nodeCtl.starting ? '正在启动生成节点…' : '启动生成节点'}
              </button>
            )}
            {job.blockReason === 'start-companion' && job.hint && (
              <button type="button" className="gen-btn" onClick={() => void copyHint()}>
                <Copy size={10} />
                复制启动命令
              </button>
            )}
            {job.blockReason === 'provision' && (
              <button type="button" data-audio-job-install className="gen-btn gen-btn-accent" onClick={openProvision}>
                <Download size={10} />
                打开下载面板
              </button>
            )}
            {job.retryable && (
              <button type="button" className="gen-btn" onClick={handleRetry}>
                <RefreshCw size={10} />
                重试
              </button>
            )}
            <button type="button" className="gen-btn gen-btn-quiet ml-auto" onClick={clear}>
              <X size={10} />
              关闭
            </button>
          </div>

          {/* 启动失败原因（服务端给的中文原因 / 日志尾部），不伪造成功 */}
          {nodeCtl.error && (
            <p
              data-audio-job-node-error
              className="mt-1.5 break-words rounded-lg border border-danger/25 bg-danger/8 px-2 py-1.5 text-[10.5px] leading-[15px] text-danger"
            >
              {nodeCtl.error}
            </p>
          )}
        </>
      )}

      {/* 失败：错误原因 + 重试 / 关闭 */}
      {failed && (
        <>
          <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/8 px-2 py-1.5">
            <TriangleAlert size={11} className="mt-[1px] shrink-0 text-danger" />
            <p className="min-w-0 flex-1 break-words text-[11px] leading-[15px] text-danger">
              {job.error ?? '音频生成失败'}
            </p>
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            {job.retryable && (
              <button type="button" className="gen-btn gen-btn-accent" onClick={handleRetry}>
                <RefreshCw size={10} />
                重试
              </button>
            )}
            <button type="button" className="gen-btn gen-btn-quiet ml-auto" onClick={clear}>
              <X size={10} />
              关闭
            </button>
          </div>
        </>
      )}
    </div>
  )
}