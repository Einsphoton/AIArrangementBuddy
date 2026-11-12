/**
 * P7-E：一键「整曲 + 分轨 Stem」工作流。
 *
 * 流程：
 *   1) 提交 generate_audio（可选质量模式）→ 完成后落一条整曲音频轨；
 *   2) 以整曲为源，按所选乐器依次提交 generate_stem（lego/base）→ 每条落一条独立音频轨；
 *   3) 进度、失败原因、取消都在面板内可见；每一步落轨都是独立撤销记录。
 */
import { useState } from 'react'
import { Layers, LoaderCircle } from 'lucide-react'
import {
  ApiError,
  STEM_ARM_LABEL,
  STEM_ARMS,
  createCompanionGenerateTask,
  createCompanionStemTask,
  getAssetPeaks,
  getCompanionTask,
  type CompanionEngine,
  type CompanionPriority,
  type StemArm,
} from '../../lib/api'
import { useStore } from '../../store/store'
import { cn } from '../../lib/format'
import { assetRefFromPeaks, generatedAudioProvenance, placeAudioClip } from './audioTrack'
import { primeAssetPeaks } from './peaks'

type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'canceled'
interface Step {
  key: string
  label: string
  status: StepStatus
  progress: number
  error?: string
  assetId?: string
}

const TERMINAL = new Set<string>(['done', 'failed', 'canceled'])
const POLL_MS = 900
const DEFAULT_ARMS: StemArm[] = ['guitar', 'bass', 'drums']

const STATUS_LABEL: Record<StepStatus, string> = {
  pending: '等待',
  running: '进行中',
  done: '完成',
  failed: '失败',
  canceled: '已取消',
}

export function SongWorkflow({
  caption,
  quality,
  priority,
  offline,
  engine = '2b',
}: {
  caption: string
  quality: boolean
  priority: CompanionPriority
  offline: boolean
  /** P9：引擎量级（默认标准档）；增强版时整曲/分轨走增强版生成模型 */
  engine?: CompanionEngine
}) {
  const project = useStore((s) => s.project)
  const pushToast = useStore((s) => s.pushToast)
  const [arms, setArms] = useState<StemArm[]>(DEFAULT_ARMS)
  const [running, setRunning] = useState(false)
  const [steps, setSteps] = useState<Step[]>([])
  const [error, setError] = useState<string | null>(null)

  const update = (key: string, patch: Partial<Step>) => {
    setSteps((prev) => prev.map((step) => (step.key === key ? { ...step, ...patch } : step)))
  }

  const toggleArm = (arm: StemArm) => {
    if (running) return
    setArms((prev) => (prev.includes(arm) ? prev.filter((item) => item !== arm) : [...prev, arm]))
  }

  const waitTask = async (taskId: string, key: string): Promise<string> => {
    for (;;) {
      const { task } = await getCompanionTask(taskId)
      update(key, { status: (task.status as StepStatus) ?? 'running', progress: task.progress ?? 0 })
      if (TERMINAL.has(task.status)) {
        if (task.status !== 'done') throw new Error(task.error || `任务${STATUS_LABEL[(task.status as StepStatus) ?? 'failed']}`)
        if (!task.assetId) throw new Error('任务完成但没有 assetId')
        update(key, { status: 'done', progress: 1, assetId: task.assetId })
        return task.assetId
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  }

  const placeAsset = async (assetId: string, name: string, trackName: string, provenanceCaption: string) => {
    const peaks = await getAssetPeaks(assetId)
    primeAssetPeaks(assetId, peaks)
    const asset = assetRefFromPeaks(assetId, peaks, { name: `${name}.wav` })
    const store = useStore.getState()
    store.mutate((draft) => {
      placeAudioClip(draft, {
        asset,
        durationSec: peaks.durationSec,
        name,
        startBeat: 0,
        trackName,
        provenance: generatedAudioProvenance({ caption: provenanceCaption, bpm: project.tempo, durationSec: Math.round(peaks.durationSec) }),
      })
    })
    store.setView('arrangement')
    store.setSaveStatus('dirty')
  }

  const start = async () => {
    if (running) return
    const text = caption.trim()
    if (!text) {
      setError('先写一句描述（整曲的风格/编制），再一键生成')
      return
    }
    if (arms.length === 0) {
      setError('至少选一种分轨乐器')
      return
    }
    setError(null)
    setRunning(true)
    const tierLabel = engine === 'xl' ? '增强版' : '标准档'
    const initial: Step[] = [
      {
        key: 'song',
        label: `整曲（${tierLabel} · ${quality ? '质量模式 · 精修 50 步' : '快速模式'}）`,
        status: 'running',
        progress: 0,
      },
      ...arms.map((arm) => ({ key: `stem:${arm}`, label: `分轨 · ${STEM_ARM_LABEL[arm]}`, status: 'pending' as StepStatus, progress: 0 })),
    ]
    setSteps(initial)
    let songAssetId: string | null = null
    try {
      const song = await createCompanionGenerateTask(
        { caption: text, quality: quality || undefined, engine },
        project.id,
        priority,
      )
      songAssetId = await waitTask(song.taskId, 'song')
      await placeAsset(songAssetId, `整曲 · ${text.slice(0, 28)}`, `音轨 · ${text.slice(0, 20)}`, text)

      for (const arm of arms) {
        update(`stem:${arm}`, { status: 'running' })
        const stem = await createCompanionStemTask(
          { sourceAssetId: songAssetId, arm, caption: `${arm} stem`, engine },
          project.id,
          priority,
        )
        const stemAssetId = await waitTask(stem.taskId, `stem:${arm}`)
        await placeAsset(stemAssetId, `Stem · ${STEM_ARM_LABEL[arm]}`, `Stem · ${STEM_ARM_LABEL[arm]}`, `${text} · ${arm} stem`)
      }
      pushToast('success', `一键工作流完成：1 条整曲 + ${arms.length} 条分轨（每条轨可单独撤销）`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '一键工作流失败')
      pushToast('error', `一键工作流中断：${err instanceof Error ? err.message : String(err)}`)
      setSteps((prev) =>
        prev.map((step) => (step.status === 'running' ? { ...step, status: 'failed' as StepStatus, error: err instanceof Error ? err.message : String(err) } : step)),
      )
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="mt-2.5 rounded-lg border border-line bg-bg-soft px-2.5 py-2" data-song-workflow>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-[10.5px] font-medium text-ink-2">
          <Layers size={11} className="shrink-0 text-accent" />
          一键整曲 + 分轨 Stem
        </span>
        <button
          type="button"
          data-song-workflow-start
          className="btn btn-secondary h-6 px-2 text-[10px]"
          onClick={() => void start()}
          disabled={running || offline}
          title={`生成整曲后自动按所选乐器逐条生成分轨（${engine === 'xl' ? '增强版' : '标准档'} · 分轨生成模型，冷启动较慢）`}
        >
          {running ? <LoaderCircle size={10} className="mr-1 animate-spin" /> : null}
          {running ? '工作流进行中…' : '一键生成'}
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[9px] text-ink-4">
        <span className="shrink-0">分轨乐器</span>
        {STEM_ARMS.map((arm) => (
          <button
            key={arm}
            type="button"
            data-song-arm={arm}
            aria-pressed={arms.includes(arm)}
            disabled={running}
            onClick={() => toggleArm(arm)}
            className={cn(
              'rounded-full border px-1.5 py-[1px] text-[9px] transition-colors',
              arms.includes(arm)
                ? 'border-accent/60 bg-accent/15 text-accent-soft'
                : 'border-line bg-surface-2/60 text-ink-4 hover:border-accent/35',
            )}
          >
            {STEM_ARM_LABEL[arm]}
          </button>
        ))}
      </div>
      <p className="mt-1 text-[9px] leading-relaxed text-ink-4">
        先出整曲（质量模式更慢但高频/编曲更完整），再以整曲为上下文逐条生成 stem；整曲与每条 stem 各自成轨、各自撤销。
      </p>
      {error && <p className="mt-1 text-[9.5px] leading-relaxed text-danger">{error}</p>}
      {steps.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {steps.map((step) => (
            <div key={step.key} data-song-step data-song-step-status={step.status} className="flex items-center gap-1.5 text-[9px]">
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  step.status === 'done'
                    ? 'bg-success'
                    : step.status === 'failed'
                      ? 'bg-danger'
                      : step.status === 'running'
                        ? 'bg-accent animate-pulse'
                        : 'bg-surface-3',
                )}
              />
              <span className="min-w-0 flex-1 truncate text-ink-3">{step.label}</span>
              <span className="mono shrink-0 text-ink-4">
                {step.status === 'running' ? `${Math.round(step.progress * 100)}%` : STATUS_LABEL[step.status]}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}