/**
 * 「AI 生成舞台」的视觉零件：生成光球、动态频谱、横向分轨管道、等待节点雷达。
 *
 * 只负责画：状态判定、节点轮询、计时都在 AudioJobCard 里（单一状态源，
 * 也方便自动化验收直接注入 audioJobStore 状态）。
 *
 * 动效全部来自 styles/index.css 的 `.gen-*` 段：
 * - 只用 transform / opacity（进度揭示用 clip-path，是规格要求），不改宽高/定位；
 * - prefers-reduced-motion 下退化为静态波形 + 静态雷达圈，信息不依赖动画。
 */
import { Fragment, useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import {
  AudioLines,
  Bot,
  Check,
  Disc3,
  Download,
  Drum,
  Guitar,
  Layers,
  MicVocal,
  Music4,
  Piano,
  Scissors,
  SlidersHorizontal,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/format'
import type { AudioJobMode, AudioJobStatus, AudioJobStep } from './audioJobStore'

/* ------------------------------------------------------------------ */
/* 模式 / 乐器映射                                                      */
/* ------------------------------------------------------------------ */

export const MODE_ICON: Record<AudioJobMode, LucideIcon> = {
  text_to_audio: Music4,
  midi_to_audio: AudioLines,
  audio_with_stems: Layers,
  midi_then_audio: Scissors,
}

export const MODE_SHORT: Record<AudioJobMode, string> = {
  text_to_audio: '整曲',
  midi_to_audio: '渲染',
  audio_with_stems: '分轨',
  midi_then_audio: '编曲→音频',
}

const ARM_META: Record<string, { label: string; icon: LucideIcon }> = {
  drums: { label: '鼓组', icon: Drum },
  bass: { label: '贝斯', icon: Guitar },
  guitar: { label: '吉他', icon: Guitar },
  vocals: { label: '人声', icon: MicVocal },
  keys: { label: '键盘', icon: Piano },
  synth: { label: '合成', icon: SlidersHorizontal },
  strings: { label: '弦乐', icon: AudioLines },
}

export type StepKind = 'song' | 'stem' | 'render'

export interface StepMeta {
  label: string
  icon: LucideIcon
  kind: StepKind
  arm?: string
}

/** 步骤 → 乐器图标 / 2-3 字短标签（管道 chip、叙事行共用） */
export function stepMeta(step: AudioJobStep): StepMeta {
  if (step.key === 'song') return { label: '整曲', icon: Disc3, kind: 'song' }
  if (step.key === 'render') return { label: '渲染', icon: AudioLines, kind: 'render' }
  const arm = step.key.startsWith('stem:') ? step.key.slice('stem:'.length) : step.key
  const meta = ARM_META[arm]
  const fallbackLabel = step.label.replace(/^分轨\s*·\s*/, '').slice(0, 4)
  return {
    label: meta?.label ?? (fallbackLabel || '分轨'),
    icon: meta?.icon ?? AudioLines,
    kind: 'stem',
    arm,
  }
}

/** compact 模式的一行摘要：「第 2/5 步 · 分轨 · 鼓组」 */
export function pipelineSummary(steps: AudioJobStep[]): string {
  if (steps.length === 0) return '准备中'
  const active = steps.find((step) => step.status === 'running') ?? steps.find((step) => step.status === 'failed')
  const fallback = steps.filter((step) => step.status === 'done').length - 1
  const index = active ? steps.indexOf(active) : fallback
  const bounded = Math.min(steps.length - 1, Math.max(0, index))
  const step = steps[bounded]
  if (!step) return '准备中'
  const meta = stepMeta(step)
  const parts = [`第 ${bounded + 1}/${steps.length} 步`]
  if (meta.kind === 'stem') parts.push('分轨', meta.label)
  else if (meta.kind === 'render') parts.push('渲染')
  else parts.push('整曲')
  return parts.join(' · ')
}

/* ------------------------------------------------------------------ */
/* 动态频谱                                                             */
/* ------------------------------------------------------------------ */

const BAR_COUNT = 44

interface BarSpec {
  height: number
  delay: number
  duration: number
  idleDelay: number
}

/** 确定性伪随机：同一列柱子每次渲染的相位一致，避免闪烁/跳动 */
const BARS: BarSpec[] = Array.from({ length: BAR_COUNT }, (_, index) => {
  const seed = Math.abs(Math.sin((index + 1) * 12.9898) * 43758.5453) % 1
  const wave = Math.sin(index * 0.52 + 0.4) * 0.5 + Math.sin(index * 0.21 + 1.7) * 0.5
  const height = Math.round(Math.min(100, Math.max(20, 54 + wave * 32 + seed * 18)))
  return {
    height,
    delay: Math.round(seed * 820),
    duration: 900 + Math.round(((seed * 7919) % 1) * 620),
    idleDelay: Math.round(((seed * 3571) % 1) * 1400),
  }
})

function barStyle(bar: BarSpec): CSSProperties {
  return {
    height: `${bar.height}%`,
    '--gen-delay': `${bar.delay}ms`,
    '--gen-dur': `${bar.duration}ms`,
    '--gen-idle-delay': `${bar.idleDelay}ms`,
  } as CSSProperties
}

export type SpectrumState = 'queued' | 'running' | 'done'

interface SpectrumProps {
  /** 0..1 整体进度：决定「已生成波形」从左往右揭示的比例 */
  progress: number
  state: SpectrumState
  size?: 'md' | 'sm'
  className?: string
}

/**
 * 44 柱频谱：底层 25% 幽灵波形（静态慢呼吸），上层渐变色已生成波形按进度裁剪，
 * 进度头部一根 2px 发光扫描线。所有柱子只做 scaleY 动画。
 */
export function GenerationSpectrum({ progress, state, size = 'md', className }: SpectrumProps) {
  const ratio = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0))
  const reveal = Math.round(ratio * 1000) / 10
  const scanLeft = Math.max(0, Math.min(99, reveal))

  const bars = (kind: 'ghost' | 'live') =>
    BARS.map((bar, index) => (
      <span key={`${kind}-${index}`} className={cn('gen-bar', `gen-bar-${kind}`)} style={barStyle(bar)} />
    ))

  return (
    <div className={cn('gen-spectrum', className)} data-state={state} data-size={size} data-gen-spectrum aria-hidden="true">
      <div className="gen-spectrum-ghost">{bars('ghost')}</div>
      <div
        className="gen-spectrum-live"
        style={{ clipPath: `inset(0 ${Math.max(0, 100 - reveal)}% 0 0)` }}
      >
        {bars('live')}
      </div>
      {state !== 'done' && <span className="gen-scan" style={{ left: `${scanLeft}%` }} />}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 生成光球（24px：conic 光环 + 中心模式图标 + 呼吸光晕）                 */
/* ------------------------------------------------------------------ */

export function GenerationOrb({ mode, status }: { mode: AudioJobMode; status: AudioJobStatus }) {
  const Icon = status === 'blocked' ? Bot : status === 'done' ? Check : MODE_ICON[mode]
  return (
    <span className="gen-orb" data-state={status} aria-hidden="true">
      <span className="gen-orb-halo" />
      <span className="gen-orb-ring" />
      <span className="gen-orb-core">
        <Icon size={11} strokeWidth={2.2} />
      </span>
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* 横向分轨管道                                                         */
/* ------------------------------------------------------------------ */

function MiniEq() {
  return (
    <span className="gen-eq" aria-hidden="true">
      <span style={{ '--gen-delay': '0ms' } as CSSProperties} />
      <span style={{ '--gen-delay': '140ms' } as CSSProperties} />
      <span style={{ '--gen-delay': '280ms' } as CSSProperties} />
    </span>
  )
}

/** 每个 step 一个 chip；chip 之间极细连接线体现流水线（仅在 steps > 1 时有） */
export function TrackPipeline({ steps, className }: { steps: AudioJobStep[]; className?: string }) {
  const chipRefs = useRef(new Map<string, HTMLSpanElement>())
  const activeKey = steps.find((step) => step.status === 'running')?.key ?? null

  /* 窄面板下管道可横向滚动：只在「运行中的步骤」变化时把当前 chip 滚进视野，
     避免每秒进度刷新导致横向抖动 */
  useEffect(() => {
    if (!activeKey) return
    const el = chipRefs.current.get(activeKey)
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ inline: 'nearest', block: 'nearest' })
    }
  }, [activeKey])

  if (steps.length === 0) return null
  return (
    <div className={cn('gen-pipeline', className)} data-gen-pipeline>
      {steps.map((step, index) => {
        const meta = stepMeta(step)
        const Icon = meta.icon
        const percent = Math.round(Math.max(0, Math.min(1, step.progress)) * 100)
        return (
          <Fragment key={step.key}>
            {index > 0 && <span className="gen-link" aria-hidden="true" />}
            <span
              ref={(node) => {
                if (node) chipRefs.current.set(step.key, node)
                else chipRefs.current.delete(step.key)
              }}
              className="gen-chip"
              data-status={step.status}
              title={step.label}
            >
              <Icon size={10} className="shrink-0" />
              <span className="gen-chip-label">{meta.label}</span>
              {step.status === 'running' ? (
                <>
                  <MiniEq />
                  <span className="gen-chip-pct mono">{percent}%</span>
                </>
              ) : null}
              {step.status === 'done' ? <Check size={9} className="shrink-0" /> : null}
              {step.status === 'failed' ? <span className="gen-chip-pct">!</span> : null}
            </span>
          </Fragment>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 等待生成节点：雷达扩散圈                                             */
/* ------------------------------------------------------------------ */

export function BlockedRadar({ tone }: { tone: 'companion' | 'provision' }) {
  const Icon = tone === 'provision' ? Download : Bot
  return (
    <span className="gen-radar" data-tone={tone} data-gen-radar aria-hidden="true">
      <span className="gen-radar-ring" />
      <span className="gen-radar-ring" />
      <span className="gen-radar-ring" />
      <span className="gen-radar-core">
        <Icon size={12} strokeWidth={2.1} />
      </span>
    </span>
  )
}