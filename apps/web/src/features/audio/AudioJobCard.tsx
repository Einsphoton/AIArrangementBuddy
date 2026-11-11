/**
 * AI 面板内的音频任务卡：展示 AI 决定并执行的音频生成进度。
 *
 * 与「任务中心」不同，这里只跟当前这一条 AI 触发的音频计划：
 * 模式、步骤（整曲 / 每条 stem / 渲染）、进度、取消、失败原因与下一步动作。
 */
import { useState } from 'react'
import {
  AudioLines,
  Check,
  CircleAlert,
  Copy,
  Download,
  Layers,
  LoaderCircle,
  Music4,
  Scissors,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useStore } from '../../store/store'
import { cn } from '../../lib/format'
import { cancelAudioJob } from './audioIntent'
import { useAudioJobStore, type AudioJob, type AudioJobMode, type AudioStepStatus } from './audioJobStore'

const MODE_ICON: Record<AudioJobMode, typeof AudioLines> = {
  text_to_audio: Music4,
  midi_to_audio: AudioLines,
  audio_with_stems: Layers,
  midi_then_audio: Scissors,
}

const MODE_LABEL: Record<AudioJobMode, string> = {
  text_to_audio: '文本 → 整首音频',
  midi_to_audio: 'MIDI → 音频',
  audio_with_stems: '整曲 + 分轨',
  midi_then_audio: '编曲 → 音频',
}

const STEP_DOT: Record<AudioStepStatus, string> = {
  pending: 'bg-surface-3',
  running: 'bg-accent animate-pulse',
  done: 'bg-success',
  failed: 'bg-danger',
  canceled: 'bg-ink-4',
}

export function AudioJobCard() {
  const job = useAudioJobStore((s) => s.job)
  const clear = useAudioJobStore((s) => s.clear)
  const pushToast = useStore((s) => s.pushToast)
  const [canceling, setCanceling] = useState(false)
  if (!job) return null
  if (job.status === 'canceled') return null

  const Icon = MODE_ICON[job.mode]
  const running = job.status === 'running'
  const blocked = job.status === 'blocked'
  const failed = job.status === 'failed'
  const done = job.status === 'done'
  const percent = Math.round(job.progress * 100)

  const copyHint = async () => {
    if (!job.hint) return
    try {
      await navigator.clipboard?.writeText(job.hint)
      pushToast('success', '启动命令已复制')
    } catch {
      pushToast('info', job.hint)
    }
  }

  return (
    <div
      data-audio-job
      data-audio-job-status={job.status}
      className={cn(
        'mx-0 rounded-xl border px-2.5 py-2',
        blocked || failed
          ? 'border-danger/35 bg-danger/8'
          : done
            ? 'border-success/30 bg-success/8'
            : 'border-accent/30 bg-accent/8',
      )}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-1.5">
        <Icon size={12} className={cn('shrink-0', done ? 'text-success' : blocked || failed ? 'text-danger' : 'text-accent')} />
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-ink" title={job.title}>
          {job.title}
        </span>
        <span className="shrink-0 rounded-full border border-line bg-surface-2 px-1.5 text-[9px] text-ink-4">
          {MODE_LABEL[job.mode]}
        </span>
        {running ? (
          <span className="mono shrink-0 text-[10px] text-ink-3">{percent}%</span>
        ) : done ? (
          <span className="flex shrink-0 items-center gap-0.5 text-[9.5px] text-success">
            <Check size={9} /> 完成
          </span>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost btn-icon h-5 w-5 shrink-0"
          title={running ? '关闭任务卡（任务会继续）' : '关闭'}
          aria-label="关闭音频任务卡"
          onClick={clear}
        >
          <X size={10} />
        </button>
      </div>

      {(running || done) && (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
          <div
            className={cn('h-full rounded-full transition-[width] duration-300', done ? 'bg-success' : 'bg-accent')}
            style={{ width: `${done ? 100 : Math.max(3, percent)}%` }}
          />
        </div>
      )}

      {(job.steps.length > 1 || running) && (
        <div className="mt-1.5 space-y-0.5">
          {job.steps.map((step) => (
            <div key={step.key} className="flex items-center gap-1.5 text-[9.5px]">
              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STEP_DOT[step.status])} />
              <span className={cn('min-w-0 flex-1 truncate', step.status === 'done' ? 'text-ink-3' : 'text-ink-2')}>
                {step.label}
              </span>
              {step.status === 'running' ? (
                <span className="mono shrink-0 text-ink-4">{Math.round(step.progress * 100)}%</span>
              ) : (
                <span className="shrink-0 text-ink-4">
                  {step.status === 'done'
                    ? '完成'
                    : step.status === 'failed'
                      ? '失败'
                      : step.status === 'canceled'
                        ? '已取消'
                        : '等待'}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {job.error && (
        <p className="mt-1.5 flex items-start gap-1 text-[10px] leading-relaxed text-danger">
          <TriangleAlert size={10} className="mt-[2px] shrink-0" />
          <span className="min-w-0 flex-1 break-words">{job.error}</span>
        </p>
      )}

      {blocked && job.blockReason === 'provision' && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <button
            type="button"
            data-audio-job-install
            className="flex h-6 items-center gap-1 rounded-md border border-accent/45 bg-accent/12 px-2 text-[10px] text-accent-soft hover:bg-accent/20"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent('aiab:provision-open', {
                  detail: {
                    reason: job.error,
                    profiles: job.mode === 'audio_with_stems' ? ['essential', 'stems'] : ['essential'],
                    source: 'audio-intent',
                  },
                }),
              )
            }}
          >
            <Download size={9} />
            打开下载面板
          </button>
          {job.hint && <span className="min-w-0 truncate text-[9.5px] text-ink-4">{job.hint}</span>}
        </div>
      )}

      {blocked && job.blockReason === 'start-companion' && job.hint && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <button
            type="button"
            className="flex h-6 items-center gap-1 rounded-md border border-line-strong bg-surface-2 px-2 text-[10px] text-ink-2 hover:text-ink"
            onClick={() => void copyHint()}
            title={job.hint}
          >
            <Copy size={9} />
            复制启动命令
          </button>
          <span className="mono min-w-0 truncate text-[9px] text-ink-4">{job.hint}</span>
        </div>
      )}

      {(running || failed || blocked) && (
        <div className="mt-1.5 flex items-center gap-1.5">
          {running && (
            <button
              type="button"
              data-audio-job-cancel
              className="flex h-6 items-center gap-1 rounded-md border border-line-strong bg-surface-2 px-2 text-[10px] text-ink-2 hover:text-ink disabled:opacity-50"
              disabled={canceling}
              onClick={() => {
                setCanceling(true)
                void cancelAudioJob().finally(() => setCanceling(false))
              }}
            >
              {canceling ? <LoaderCircle size={9} className="animate-spin" /> : <CircleAlert size={9} />}
              取消
            </button>
          )}
          {(failed || blocked) && (
            <button
              type="button"
              className="flex h-6 items-center gap-1 rounded-md border border-line-strong bg-surface-2 px-2 text-[10px] text-ink-2 hover:text-ink"
              onClick={clear}
            >
              关闭
            </button>
          )}
          <span className="ml-auto truncate text-[9px] text-ink-4">
            {job.placed.length > 0 ? `已加入 ${job.placed.length} 条轨` : 'AI 自动执行中'}
          </span>
        </div>
      )}

      {done && job.placed.length > 0 && (
        <p className="mt-1.5 truncate text-[9.5px] text-ink-3" title={job.placed.join('、')}>
          已加入工程：{job.placed.join('、')}（⌘Z 可撤销）
        </p>
      )}
    </div>
  )
}
