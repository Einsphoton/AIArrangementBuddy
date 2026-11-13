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
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { companionVariantLabel } from '../../lib/api'
import { cn } from '../../lib/format'
import type {
  AudioJobMode,
  AudioJobPhase,
  AudioJobStatus,
  AudioJobStep,
  AudioJobTelemetry,
} from './audioJobStore'

/* ------------------------------------------------------------------ */
/* 模式 / 乐器映射                                                      */
/* ------------------------------------------------------------------ */

export const MODE_ICON: Record<AudioJobMode, LucideIcon> = {
  text_to_audio: Music4,
  midi_to_audio: AudioLines,
  ai_cover: Sparkles,
  audio_with_stems: Layers,
}

export const MODE_SHORT: Record<AudioJobMode, string> = {
  text_to_audio: '整曲',
  midi_to_audio: '忠实渲染',
  ai_cover: 'AI 重编',
  audio_with_stems: '分轨',
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

export type StepKind = 'song' | 'stem' | 'render' | 'cover'

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
  if (step.key === 'cover') return { label: 'AI 重编', icon: Sparkles, kind: 'cover' }
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
  else if (meta.kind === 'cover') parts.push('AI 重编')
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
/* 阶段轨道：让「现在到底在做哪一步」一眼可见                             */
/* ------------------------------------------------------------------ */

interface StageDef {
  key: string
  label: string
}

const COMPANION_STAGES: StageDef[] = [
  { key: 'queued', label: '排队' },
  { key: 'engine', label: '载入模型' },
  { key: 'sampling', label: '扩散采样' },
  { key: 'decoding', label: '解码封装' },
  { key: 'upload', label: '写入轨道' },
]

const RENDER_STAGES: StageDef[] = [
  { key: 'prepare', label: '准备' },
  { key: 'render', label: '离线渲染' },
  { key: 'upload', label: '写入轨道' },
]

/** AI 重编 = 先渲染参考音频，再交给模型；阶段比纯生成多一个「渲染参考」 */
const COVER_STAGES: StageDef[] = [
  { key: 'render', label: '渲染参考' },
  { key: 'queued', label: '排队' },
  { key: 'engine', label: '载入模型' },
  { key: 'sampling', label: '重编' },
  { key: 'decoding', label: '封装' },
  { key: 'upload', label: '写入' },
]

const PHASE_STAGE_INDEX: Record<string, number> = {
  queued: 0,
  prepare: 0,
  engine: 1,
  prompt: 2,
  sampling: 2,
  decoding: 3,
  upload: 4,
  done: 5,
  idle: 0,
  render: 1,
}

const COVER_STAGE_INDEX: Record<string, number> = {
  prepare: 0,
  render: 0,
  queued: 1,
  engine: 2,
  prompt: 3,
  sampling: 3,
  decoding: 4,
  upload: 5,
  done: 6,
  idle: 0,
}

function stageIndexOf(mode: AudioJobMode, phase: AudioJobPhase): number {
  const table = mode === 'ai_cover' ? COVER_STAGE_INDEX : PHASE_STAGE_INDEX
  return table[phase] ?? 0
}

/** 没有服务端阶段时的兜底：按进度推断（旧 Companion / 注入状态都能显示合理的阶段） */
export function fallbackPhase(jobMode: AudioJobMode, progress: number, queued: boolean): AudioJobPhase {
  if (queued) return 'queued'
  if (jobMode === 'midi_to_audio') {
    if (progress >= 0.92) return 'upload'
    return progress <= 0.01 ? 'prepare' : 'render'
  }
  if (jobMode === 'ai_cover') {
    // 渲染参考占 0–15%，之后是模型阶段；没有遥测时按进度推断
    if (progress <= 0.15) return progress <= 0.01 ? 'prepare' : 'render'
    if (progress >= 0.94) return 'upload'
    if (progress >= 0.9) return 'decoding'
    return 'sampling'
  }
  if (progress <= 0.04) return 'engine'
  if (progress >= 0.94) return 'upload'
  if (progress >= 0.9) return 'decoding'
  return 'sampling'
}

export function GenerationStageRail({
  mode,
  phase,
  progress,
  queued,
  done,
  className,
}: {
  mode: AudioJobMode
  phase?: AudioJobPhase
  progress: number
  queued: boolean
  done: boolean
  className?: string
}) {
  const stages = mode === 'midi_to_audio' ? RENDER_STAGES : mode === 'ai_cover' ? COVER_STAGES : COMPANION_STAGES
  const resolved = phase ?? fallbackPhase(mode, progress, queued)
  const activeIndex = done ? stages.length : Math.min(stages.length - 1, stageIndexOf(mode, resolved))
  return (
    <div
      className={cn('gen-stages', className)}
      data-gen-stages
      data-phase={resolved}
      role="list"
      aria-label="生成阶段"
    >
      {stages.map((stage, index) => {
        const state = done || index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'pending'
        return (
          <span key={stage.key} className="gen-stage" data-state={state} role="listitem" aria-current={state === 'active' ? 'step' : undefined}>
            <span className="gen-stage-dot" aria-hidden="true" />
            <span className="gen-stage-label">{stage.label}</span>
          </span>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 引擎遥测 HUD：引擎状态 + GPU / 显存 / CPU / 内存                       */
/* ------------------------------------------------------------------ */

const ENGINE_STATE_LABEL: Record<string, string> = {
  stopped: '未启动',
  starting: '启动中',
  ready: '就绪',
  busy: '生成中',
  error: '异常',
}

const PHASE_ACTIVE_LABEL: Record<string, string> = {
  prepare: '准备中',
  engine: '载入中',
  prompt: '理解中',
  sampling: '采样中',
  decoding: '解码中',
  upload: '写入中',
  queued: '排队中',
  render: '渲染中',
}

function roundPercent(value: number): string {
  return `${Math.round(value)}%`
}

/** MB → 「6.2G / 512M」；用于显存与内存 */
export function formatMemory(mb: number | undefined): string | undefined {
  if (typeof mb !== 'number' || !Number.isFinite(mb) || mb < 0) return undefined
  if (mb >= 1024) {
    const gb = mb / 1024
    return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)}G`
  }
  return `${Math.round(mb)}M`
}

interface MetricItem {
  key: string
  label: string
  value: string
  ratio?: number
}

/** 从任务遥测里抽出 HUD 指标；没有 GPU 字段时如实只显示 CPU/内存 */
export function telemetryMetrics(telemetry?: AudioJobTelemetry): MetricItem[] {
  if (!telemetry) return []
  const items: MetricItem[] = []
  if (typeof telemetry.gpuUtilPct === 'number' && Number.isFinite(telemetry.gpuUtilPct)) {
    items.push({
      key: 'gpu',
      label: 'GPU',
      value: roundPercent(telemetry.gpuUtilPct),
      ratio: Math.max(0, Math.min(1, telemetry.gpuUtilPct / 100)),
    })
  }
  const used = formatMemory(telemetry.vramUsedMb)
  const total = formatMemory(telemetry.vramTotalMb)
  if (used && total) {
    const ratio =
      telemetry.vramUsedMb != null && telemetry.vramTotalMb
        ? Math.max(0, Math.min(1, telemetry.vramUsedMb / telemetry.vramTotalMb))
        : undefined
    items.push({ key: 'vram', label: '显存', value: `${used}/${total}`, ratio })
  }
  if (typeof telemetry.cpuPct === 'number' && Number.isFinite(telemetry.cpuPct)) {
    items.push({
      key: 'cpu',
      label: 'CPU',
      value: roundPercent(telemetry.cpuPct),
      ratio: Math.max(0, Math.min(1, telemetry.cpuPct / 100)),
    })
  }
  const rss = formatMemory(telemetry.rssMb)
  if (rss) items.push({ key: 'rss', label: '内存', value: rss })
  return items
}

export function EngineTelemetryHud({
  telemetry,
  fallbackState,
  mode,
  className,
}: {
  telemetry?: AudioJobTelemetry
  fallbackState?: 'running' | 'done'
  mode?: AudioJobMode
  className?: string
}) {
  const engine = telemetry?.engine
  const phase = telemetry?.phase
  const activeLabel = phase ? PHASE_ACTIVE_LABEL[phase] : undefined
  const stateLabel =
    activeLabel ??
    ENGINE_STATE_LABEL[engine?.state ?? ''] ??
    (fallbackState === 'running' ? '生成中' : '就绪')
  const engineMeta = [
    companionVariantLabel(engine?.variant),
    engine?.device,
    telemetry?.workerName,
    engine?.pid ? `pid ${engine.pid}` : '',
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ')
  const metrics = telemetryMetrics(telemetry)
  const loading = engine?.state === 'starting' || phase === 'engine'
  const active =
    fallbackState === 'running' && phase !== 'queued' && phase !== 'prepare' && phase !== 'done' && phase !== 'idle'
  const live = Boolean(engine?.state === 'busy' || active)
  const placeholder =
    mode === 'midi_to_audio'
      ? '浏览器离线渲染 · 不使用 GPU'
      : '资源遥测待接入（旧版节点或无 GPU 采样）'

  return (
    <div
      className={cn('gen-hud', className)}
      data-gen-telemetry
      data-engine-state={engine?.state ?? (phase === 'queued' ? 'queued' : 'running')}
      data-phase={phase ?? ''}
    >
      <div className="gen-hud-engine">
        <span className="gen-hud-dot" data-live={live ? 'true' : 'false'} aria-hidden="true" />
        <span className="gen-hud-key">引擎</span>
        <span className="gen-hud-state" data-state={engine?.state ?? ''}>
          {stateLabel}
        </span>
        {loading ? <span className="gen-hud-loading">冷启动可能需 30–60s</span> : null}
        {engineMeta ? (
          <span className="gen-hud-meta" title={engineMeta}>
            {engineMeta}
          </span>
        ) : null}
      </div>
      {metrics.length > 0 ? (
        <div className="gen-hud-metrics">
          {metrics.map((item) => (
            <span
              key={item.key}
              className="gen-metric"
              data-metric={item.key}
              title={
                item.key === 'gpu' && telemetry?.gpuName
                  ? `${telemetry.gpuName}${telemetry.gpuTempC != null ? ` · ${Math.round(telemetry.gpuTempC)}°C` : ''}`
                  : undefined
              }
            >
              <span className="gen-metric-label">{item.label}</span>
              <span className="gen-metric-value mono">{item.value}</span>
              {item.ratio != null ? (
                <span className="gen-metric-track" aria-hidden="true">
                  <span className="gen-metric-fill" style={{ transform: `scaleX(${Math.max(0.02, item.ratio)})` }} />
                </span>
              ) : null}
            </span>
          ))}
        </div>
      ) : (
        <div className="gen-hud-metrics gen-hud-metrics--empty" data-metric="none">
          <span className="gen-hud-placeholder">{placeholder}</span>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 阻塞态：启动检查清单（本地服务 / 节点 / 模型）                        */
/* ------------------------------------------------------------------ */

export type CheckState = 'ok' | 'warn' | 'pending' | 'bad'

export interface CheckItem {
  key: string
  label: string
  value: string
  state: CheckState
}

export function StartChecklist({ items, className }: { items: CheckItem[]; className?: string }) {
  return (
    <div className={cn('gen-check', className)} data-gen-check>
      {items.map((item) => (
        <span key={item.key} className="gen-check-item" data-state={item.state} title={`${item.label}：${item.value}`}>
          <span className="gen-check-dot" aria-hidden="true" />
          <span className="gen-check-label">{item.label}</span>
          <span className="gen-check-value">{item.value}</span>
        </span>
      ))}
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