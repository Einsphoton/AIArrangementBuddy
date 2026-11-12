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
  RefreshCw,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useStore } from '../../store/store'
import { cn } from '../../lib/format'
import { getCompanionStatus } from '../../lib/api'
import { cancelAudioJob, retryAudioJob } from './audioIntent'
import { useAudioJobStore, type AudioJob, type AudioJobStep } from './audioJobStore'
import {
  BlockedRadar,
  GenerationOrb,
  GenerationSpectrum,
  MODE_SHORT,
  TrackPipeline,
  pipelineSummary,
  stepMeta,
} from './AudioGenerationStage'

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
function buildNarration(job: AudioJob, step: AudioJob['steps'][number] | undefined): Narration {
  if (job.status === 'done') return { key: 'done', text: '生成完成 · 已写入工程' }
  if (job.status === 'failed') return { key: 'failed', text: '音频生成中断 · 可重试或关闭' }
  if (!step) return { key: 'prep', text: '正在准备音频生成…' }
  if (step.queuePosition != null) {
    const wait = step.etaSec != null ? `，预计 ${Math.max(0, Math.round(step.etaSec))} 秒` : ''
    // 服务端 queuePosition 是 0-based（第一个排队任务 = 0），展示时 +1
    return { key: `queue-${step.key}-${step.queuePosition}`, text: `排队中 · 第 ${step.queuePosition + 1} 位${wait}` }
  }
  const progress = Math.max(0, Math.min(1, step.progress))
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

export function AudioJobCard({ compact = false }: { compact?: boolean }) {
  const job = useAudioJobStore((s) => s.job)
  const clear = useAudioJobStore((s) => s.clear)
  const pushToast = useStore((s) => s.pushToast)
  const [canceling, setCanceling] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  /** 同一阻塞任务只自动继续一次，避免节点状态抖动时重复拉起 */
  const autoResumedRef = useRef<string | null>(null)

  /* 运行 / 等待中每秒刷新计时（关闭卡片或组件卸载时自动清理） */
  useEffect(() => {
    if (!job || (job.status !== 'running' && job.status !== 'blocked')) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [job?.id, job?.status])

  /* 生成节点未启动：每 2.5s 自动检测，上线后自动用上一份计划继续 */
  useEffect(() => {
    if (!job || job.status !== 'blocked' || job.blockReason !== 'start-companion') return
    const jobId = job.id
    let cancelled = false

    const probe = async () => {
      if (cancelled || document.hidden) return
      try {
        const status = await getCompanionStatus()
        if (cancelled) return
        const online = status.online && (status.summary?.workers ?? 0) > 0
        if (!online || autoResumedRef.current === jobId) return
        autoResumedRef.current = jobId
        if (retryAudioJob(jobId)) {
          pushToast('success', '生成节点已上线，继续生成音频…')
        } else {
          autoResumedRef.current = null
        }
      } catch {
        /* 后端未就绪：保持等待提示，下个周期再试 */
      }
    }

    void probe()
    const timer = window.setInterval(() => void probe(), DETECT_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [job?.id, job?.status, job?.blockReason, pushToast])

  if (!job || job.status === 'canceled') return null

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
  const etaText = etaSec != null ? `预计 ${formatElapsed(etaSec * 1000)}` : `已用 ${formatElapsed(elapsedMs)}`
  const waitSec = Math.max(0, Math.floor(elapsedMs / 1000))

  const narration = buildNarration(job, runningStep)
  const compactSummary = done
    ? job.placed.length > 0
      ? `已写入 ${job.placed.length} 条轨`
      : '已写入工程'
    : pipelineSummary(job.steps)

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
          title={running ? '关闭任务卡（任务会继续）' : '关闭'}
          aria-label="关闭音频任务卡"
          onClick={clear}
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
                <span className="mono min-w-0 truncate text-[10px] tabular-nums text-ink-3">{done ? `已用 ${formatElapsed(elapsedMs)}` : etaText}</span>
              </div>
              <div className="gen-progress mt-1">
                <span className="gen-progress-fill" style={{ transform: `scaleX(${progressFill})` }} />
                <span className="gen-progress-head" style={{ left: `${percent}%` }} />
              </div>

              {running ? (
                <TrackPipeline className="mt-2" steps={job.steps} />
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
              {job.placed.length > 0 ? `已加入 ${job.placed.length} 条轨 · AI 自动执行中` : 'AI 自动执行中'}
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

          <div className="mt-2 flex items-center gap-1.5">
            {job.blockReason === 'start-companion' && job.hint && (
              <button type="button" className="gen-btn gen-btn-accent" onClick={() => void copyHint()}>
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