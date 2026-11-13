/**
 * P7-E：一键「整曲 + 分轨 Stem」工作流。
 *
 * 流程：
 *   1) 提交 generate_audio（可选质量模式）→ 完成后落一条整曲音频轨；
 *   2) 以整曲为源，按所选乐器依次提交 generate_stem（extract/base）→ 每条落一条独立音频轨（默认静音）；
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
import { assetPeakFromPeaks, assetRefFromPeaks, generatedAudioProvenance, placeAudioClip, stemPlacementVolume } from './audioTrack'
import { primeAssetPeaks } from './peaks'
import { keyscaleFromProject, timesignatureFromProject } from './audioIntent'

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

  const placeAsset = async (
    assetId: string,
    name: string,
    trackName: string,
    provenanceCaption: string,
    options: { startBeat?: number; muted?: boolean; stemGain?: { stemCount: number; songPeak: number } } = {},
  ) => {
    const peaks = await getAssetPeaks(assetId)
    primeAssetPeaks(assetId, peaks)
    /* 实测峰值：引擎对每个输出文件独立峰值归一化，因此它是「不削顶」预算的依据 */
    const peak = assetPeakFromPeaks(peaks.peaks)
    const asset = assetRefFromPeaks(assetId, peaks, { name: `${name}.wav` })
    const store = useStore.getState()
    const placedRef: { value: { trackId: string; clipId: string } | null } = { value: null }
    store.mutate((draft) => {
      placedRef.value = placeAudioClip(draft, {
        asset,
        durationSec: peaks.durationSec,
        name,
        startBeat: options.startBeat ?? 0,
        trackName,
        /* 分轨按实测峰值推导的预算音量落轨；其余场景 undefined → placeAudioClip 用 0.8 */
        volume: options.stemGain
          ? stemPlacementVolume({ stemPeak: peak, stemCount: options.stemGain.stemCount, songPeak: options.stemGain.songPeak })
          : undefined,
        provenance: generatedAudioProvenance({ caption: provenanceCaption, bpm: project.tempo, durationSec: Math.round(peaks.durationSec) }),
      })
      /* 分轨默认静音：整曲与全部分轨同时可闻会叠加爆表（实测 peak≈1.84），用户点 M/S 再单独试听 */
      if (options.muted && placedRef.value) {
        const placedTrack = draft.tracks.find((track) => track.id === placedRef.value?.trackId)
        if (placedTrack) placedTrack.mute = true
      }
    })
    store.setView('arrangement')
    store.setSaveStatus('dirty')
    return placedRef.value ? { ...placedRef.value, peak } : null
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
        {
          caption: text,
          quality: quality || undefined,
          engine,
          /* 调性/拍号跟工程走：不传时引擎会退回写死的 C major，与工程调式打架 */
          keyscale: keyscaleFromProject(project),
          timesignature: timesignatureFromProject(project),
        },
        project.id,
        priority,
      )
      songAssetId = await waitTask(song.taskId, 'song')
      const songPlacement = await placeAsset(songAssetId, `整曲 · ${text.slice(0, 28)}`, `音轨 · ${text.slice(0, 20)}`, text)
      /* 分轨与整曲同起点：整曲片段落在 startBeat 0，这里保持一致（后续若整曲改起点也跟着走） */
      const songStartBeat =
        useStore
          .getState()
          .project.tracks.find((track) => track.id === songPlacement?.trackId)
          ?.audioClips.find((clip) => clip.id === songPlacement?.clipId)?.startBeat ?? 0
      /* 整曲有效峰值（资产峰值 × 整曲推子）：分轨叠加不超过它，就不会比整曲响、也不会削顶 */
      const songTrackVolume =
        useStore.getState().project.tracks.find((track) => track.id === songPlacement?.trackId)?.volume ?? 0.8
      const songPeak = (songPlacement?.peak ?? 0) * songTrackVolume

      for (const arm of arms) {
        update(`stem:${arm}`, { status: 'running' })
        const stem = await createCompanionStemTask(
          /* caption 只传风格补充：整曲描述会与 extract（分离该乐器）的语义打架 */
          { sourceAssetId: songAssetId, arm, engine },
          project.id,
          priority,
        )
        const stemAssetId = await waitTask(stem.taskId, `stem:${arm}`)
        /* 与整曲同起点、真实时长；默认静音，避免整曲+分轨叠加爆表 */
        await placeAsset(stemAssetId, `Stem · ${STEM_ARM_LABEL[arm]}`, `Stem · ${STEM_ARM_LABEL[arm]}`, `${text} · ${arm} stem`, {
          startBeat: songStartBeat,
          muted: true,
          /* 按实测峰值把 N 条分轨的叠加预算等分 → 全部解开静音也不会爆表 */
          stemGain: { stemCount: arms.length, songPeak },
        })
      }
      pushToast(
        'success',
        `一键工作流完成：1 条整曲 + ${arms.length} 条分轨（已按实测电平压低音量，分轨默认静音，点 M/S 可单独试听）。分轨是分别重合成的，不是原曲的严格分解，叠加不会与原曲完全对齐`,
      )
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
        先出整曲（质量模式更慢但高频/编曲更完整），再以整曲为上下文逐条生成 stem；整曲与每条 stem 各自成轨、各自撤销。分轨按实测电平自动压低音量，避免叠加削顶；分轨是分别重合成的，叠加与原曲不完全对齐。
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