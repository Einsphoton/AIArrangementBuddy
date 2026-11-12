/**
 * 生成中的「占位音频轨」——DAW 里的等待反馈。
 *
 * 用户发起音频生成后，轨道不是等生成完才出现，而是**立刻**在编曲视图和
 * 轨道面板里占好位置：
 *   - 编曲车道：一条带极光 / 扫描光带 / 动态波形 / 粒子的「生成中片段」，
 *     宽度按预估时长画，进度直接跟随服务端采样进度；
 *   - 轨道头：AI 徽标 + 实时百分比 + 呼吸的迷你频谱，一眼看出这条轨在工作。
 *
 * 这些只是 UI 占位（AudioJobTrackSlot），不写进工程；生成完成后由
 * audioIntent 落成真实音频片段并移除槽位，位置与配色保持一致。
 *
 * 动效约定：只动 transform / opacity，不触发 layout；prefers-reduced-motion
 * 下保留静态层次（波形、进度、文字），不依赖动画传达信息。
 */
import { useMemo, type CSSProperties } from 'react'
import { AudioLines, Sparkles } from 'lucide-react'
import { cn } from '../../lib/format'
import { useAudioJobStore, type AudioJob, type AudioJobTrackSlot } from './audioJobStore'
import { audioSecondsToBeats } from './audioTrack'

/* ------------------------------------------------------------------ */
/* 状态解析                                                            */
/* ------------------------------------------------------------------ */

export type GenerationSlotVisualState =
  | 'pending'
  | 'queued'
  | 'running'
  | 'writing'
  | 'blocked'
  | 'failed'
  | 'canceled'
  | 'done'

export interface GenerationSlotVisual {
  state: GenerationSlotVisualState
  /** 卡片 / 车道主文案 */
  title: string
  /** 副文案（阶段、排队位、错误原因…） */
  detail: string
  /** 0..100 */
  percent: number
  /** 是否处于「AI 正在动」的状态（用于点亮动效） */
  active: boolean
}

const PHASE_LABEL: Record<string, string> = {
  prepare: '准备生成',
  engine: '载入音频模型',
  prompt: '理解音乐描述',
  sampling: '扩散采样',
  decoding: '解码音频',
  upload: '写入音频轨',
  render: '离线渲染',
}

function phaseText(job: AudioJob | null): string {
  const phase = job?.telemetry?.phase
  if (!phase) return 'AI 生成中'
  return PHASE_LABEL[phase] ?? job?.telemetry?.phaseLabel ?? 'AI 生成中'
}

function remainingText(slot: AudioJobTrackSlot): string {
  const progress = Math.max(0, Math.min(1, slot.progress))
  if (progress <= 0.06) return ''
  const elapsedMs = Math.max(1000, Date.now() - (slot.startedAt ?? slot.createdAt))
  const remaining = (elapsedMs * (1 - progress)) / progress
  if (!Number.isFinite(remaining) || remaining <= 0) return ''
  const seconds = Math.max(1, Math.round(remaining / 1000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes > 0 ? `预计 ${minutes}:${String(rest).padStart(2, '0')}` : `预计 ${rest}s`
}

/** 槽位 + 任务状态 → 车道 / 轨道头要显示的内容 */
export function resolveSlotVisual(slot: AudioJobTrackSlot, job: AudioJob | null): GenerationSlotVisual {
  const percent = slot.status === 'done' ? 100 : Math.round(Math.max(0, Math.min(1, slot.progress)) * 100)
  const roleLabel = slot.role === 'song' ? '整曲' : slot.role === 'render' ? '渲染' : slot.label

  if (slot.status === 'done') {
    return { state: 'done', title: `已写入音频轨 · ${roleLabel}`, detail: '完成', percent: 100, active: false }
  }
  if (slot.status === 'failed' || (job?.status === 'failed' && slot.status === 'running')) {
    return {
      state: 'failed',
      title: `生成中断 · ${roleLabel}`,
      detail: slot.error || job?.error || '可在任务卡里重试',
      percent,
      active: false,
    }
  }
  if (slot.status === 'canceled' || job?.status === 'canceled') {
    return { state: 'canceled', title: `已中止 · ${roleLabel}`, detail: '任务已取消', percent, active: false }
  }
  if (job?.status === 'blocked') {
    const provision = job.blockReason === 'provision'
    return {
      state: 'blocked',
      title: provision ? `等待安装模型 · ${roleLabel}` : `等待生成节点 · ${roleLabel}`,
      detail: provision ? '模型就绪后自动继续' : '节点上线后自动继续',
      percent: 0,
      active: true,
    }
  }
  if (slot.status === 'running') {
    if (slot.queuePosition != null) {
      return {
        state: 'queued',
        title: `排队中 · ${roleLabel}`,
        detail: `第 ${slot.queuePosition + 1} 位${slot.etaSec != null ? ` · 预计 ${Math.round(slot.etaSec)}s` : ''}`,
        percent: 0,
        active: true,
      }
    }
    if (slot.progress >= 0.985 || job?.telemetry?.phase === 'upload') {
      return {
        state: 'writing',
        title: `正在写入音频轨 · ${roleLabel}`,
        detail: '解码完成，正在落轨',
        percent: Math.max(99, percent),
        active: true,
      }
    }
    const phase = phaseText(job)
    const step =
      job?.telemetry?.step != null && job.telemetry.stepTotal != null
        ? `${job.telemetry.estimated ? '≈' : ''}第 ${job.telemetry.step}/${job.telemetry.stepTotal} 步`
        : ''
    const speed = job?.telemetry?.speed != null && job.telemetry.speed > 0 ? `${job.telemetry.speed.toFixed(1)} 步/s` : ''
    const remaining = remainingText(slot)
    const detail = [phase, step, speed, remaining].filter(Boolean).join(' · ')
    return { state: 'running', title: `AI 正在生成 · ${roleLabel}`, detail, percent, active: true }
  }
  // pending：轨道已建好，等上一步完成 / 等节点
  const detail =
    slot.role === 'stem'
      ? '整曲完成后自动开始'
      : slot.role === 'render'
        ? '等待离线渲染'
        : '等待引擎派发任务'
  return { state: 'pending', title: `已建轨 · 等待生成 · ${roleLabel}`, detail, percent: 0, active: true }
}

/* ------------------------------------------------------------------ */
/* 确定性波形                                                          */
/* ------------------------------------------------------------------ */

function hashCode(text: string): number {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** 由槽位 id 生成稳定的「波形」高度（避免每次 render 抖动） */
function buildBars(seed: string, count: number): number[] {
  let state = hashCode(seed) || 1
  const bars: number[] = []
  for (let index = 0; index < count; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const noise = (state % 1000) / 1000
    // 中段更饱满，两端稍低，像一段真实的编曲能量
    const envelope = Math.sin((Math.PI * (index + 0.5)) / count) * 0.55 + 0.45
    bars.push(Math.round((0.16 + noise * 0.84) * envelope * 100))
  }
  return bars
}

function useBars(seed: string, width: number): number[] {
  return useMemo(() => {
    const count = Math.max(18, Math.min(160, Math.round(width / 6)))
    return buildBars(seed, count)
  }, [seed, width])
}

/* ------------------------------------------------------------------ */
/* 编曲车道：生成中的片段                                                */
/* ------------------------------------------------------------------ */

export function GenerationTrackClip({
  slot,
  job,
  pxPerBeat,
  rowHeight,
  tempo,
  className,
}: {
  slot: AudioJobTrackSlot
  job: AudioJob | null
  pxPerBeat: number
  rowHeight: number
  tempo: number
  className?: string
}) {
  const visual = resolveSlotVisual(slot, job)
  const width = Math.max(26, audioSecondsToBeats(slot.durationSec, tempo) * pxPerBeat)
  const clipHeight = Math.max(18, rowHeight - 8)
  const compact = rowHeight < 42
  const narrow = width < 178
  const bars = useBars(slot.id, width)
  const particles = useMemo(() => {
    let state = hashCode(`${slot.id}:particles`) || 7
    return Array.from({ length: 5 }, () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return {
        left: 6 + (state % 88),
        top: 12 + ((state >>> 8) % 66),
        delay: ((state >>> 16) % 2200) / 1000,
        size: 2 + ((state >>> 20) % 3),
      }
    })
  }, [slot.id])

  return (
    <div
      data-gen-track-clip
      data-gen-slot-key={slot.key}
      data-gen-slot-status={visual.state}
      data-gen-slot-progress={visual.percent}
      className={cn('genlane-clip', className)}
      style={{
        left: slot.startBeat * pxPerBeat,
        width,
        height: clipHeight,
        '--genlane-color': slot.color,
      } as CSSProperties}
      title={`${visual.title} · ${visual.detail}${visual.percent > 0 && visual.percent < 100 ? ` · ${visual.percent}%` : ''}`}
      role="img"
      aria-label={`${visual.title}，${visual.detail}`}
    >
      {/* 基底：极光 + 网格 + 扫描光带 */}
      <span className="genlane-aurora" aria-hidden />
      <span className="genlane-grid" aria-hidden />
      <span className="genlane-sweep" aria-hidden />
      <span className="genlane-vignette" aria-hidden />

      {/* 已生成进度：从左往右抬亮 */}
      <span
        className="genlane-fill"
        aria-hidden
        style={{ transform: `scaleX(${Math.max(0.004, Math.min(1, visual.percent / 100))})` }}
      />
      <span className="genlane-progress-head" aria-hidden style={{ left: `${visual.percent}%` }} />

      {/* 动态波形：上下镜像，像正在被填充的音频 */}
      {!compact && (
        <span className="genlane-wave" aria-hidden>
          <span className="genlane-wave-row">
            {bars.map((height, index) => (
              <span
                key={index}
                className="genlane-bar"
                style={{
                  height: `${height}%`,
                  animationDelay: `${(index % 12) * 70}ms`,
                  animationDuration: `${900 + (index % 5) * 130}ms`,
                }}
              />
            ))}
          </span>
          <span className="genlane-wave-row genlane-wave-row--mirror">
            {bars.map((height, index) => (
              <span
                key={index}
                className="genlane-bar"
                style={{
                  height: `${height}%`,
                  animationDelay: `${(index % 9) * 90}ms`,
                  animationDuration: `${1050 + (index % 6) * 120}ms`,
                }}
              />
            ))}
          </span>
        </span>
      )}

      {/* 粒子：少量漂浮的光点，增加「正在生成」的生命感 */}
      {!compact && visual.active && (
        <span className="genlane-particles" aria-hidden>
          {particles.map((particle, index) => (
            <span
              key={index}
              className="genlane-particle"
              style={{
                left: `${particle.left}%`,
                top: `${particle.top}%`,
                width: particle.size,
                height: particle.size,
                animationDelay: `${particle.delay}s`,
              }}
            />
          ))}
        </span>
      )}

      {/* 文案层 */}
      <span className="genlane-content">
        <span className="genlane-title-row">
          <span className="genlane-orb" aria-hidden>
            {visual.state === 'blocked' ? <AudioLines size={10} /> : <Sparkles size={10} />}
          </span>
          <span className="genlane-title">{visual.title}</span>
          {!narrow && visual.state === 'running' && (
            <span className="genlane-eq" aria-hidden>
              <span />
              <span />
              <span />
            </span>
          )}
          <span className="genlane-pct">{visual.state === 'pending' ? '待生成' : `${visual.percent}%`}</span>
        </span>
        {!compact && !narrow && <span className="genlane-detail">{visual.detail}</span>}
      </span>

      <span className="genlane-status-glow" aria-hidden />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 轨道面板：生成中的轨道头                                              */
/* ------------------------------------------------------------------ */

export function GenerationTrackHeader({
  slot,
  job,
  height,
  className,
}: {
  slot: AudioJobTrackSlot
  job: AudioJob | null
  height: number
  className?: string
}) {
  const visual = resolveSlotVisual(slot, job)
  const cardHidden = useAudioJobStore((s) => s.hidden)
  const compact = height < 46
  const seconds = Math.max(0, Math.round(slot.durationSec))
  const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

  return (
    <div
      data-gen-track-header
      data-gen-slot-key={slot.key}
      data-gen-slot-status={visual.state}
      data-gen-slot-progress={visual.percent}
      className={cn('genhead', className)}
      style={{ height, ['--genlane-color' as string]: slot.color }}
    >
      {/* 色条 / 频谱：与真实轨道头的色条同宽，保持左右对齐的视觉语言 */}
      <div className="genhead-handle" aria-hidden>
        <span className="genhead-eq">
          <span />
          <span />
          <span />
          <span />
        </span>
      </div>

      <div className="genhead-main">
        <div className="genhead-title-row">
          <span className="genhead-badge" aria-hidden>
            <Sparkles size={8} />
            AI
          </span>
          <span className="genhead-name" title={slot.name}>
            {slot.name}
          </span>
          {cardHidden && !compact && (
            <button
              type="button"
              className="genhead-focus"
              title="恢复音频任务卡"
              onClick={(event) => {
                event.stopPropagation()
                useAudioJobStore.getState().setHidden(false)
              }}
            >
              查看
            </button>
          )}
          <span className="genhead-pct">{visual.state === 'pending' ? '待生成' : `${visual.percent}%`}</span>
        </div>

        {!compact && (
          <div className="genhead-meta">
            <span className="genhead-state">{visual.detail}</span>
            <span className="genhead-duration">{duration}</span>
          </div>
        )}

        <span className="genhead-progress" aria-hidden>
          <span
            className="genhead-progress-fill"
            style={{ transform: `scaleX(${Math.max(0.004, Math.min(1, visual.percent / 100))})` }}
          />
        </span>
      </div>
    </div>
  )
}
