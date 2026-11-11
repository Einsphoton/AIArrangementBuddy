/**
 * 音频生成任务的前端状态（AI 编曲助手 → 自动执行音频计划）。
 *
 * 这里只放「界面需要展示的进度」，真正的任务在 Companion 服务端队列里。
 * 属于 UI 状态，不写入工程、不持久化。
 */
import { create } from 'zustand'

export type AudioJobMode = 'text_to_audio' | 'midi_to_audio' | 'audio_with_stems' | 'midi_then_audio'
export type AudioJobStatus = 'running' | 'done' | 'failed' | 'canceled' | 'blocked'

export type AudioStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'canceled'

export interface AudioJobStep {
  key: string
  label: string
  status: AudioStepStatus
  /** 0..1 */
  progress: number
  error?: string
}

/** 阻塞原因：需要下载环境 / 需要启动生成节点 / 工程为空 */
export type AudioJobBlockReason = 'provision' | 'start-companion' | 'empty-project'

export interface AudioJob {
  id: string
  mode: AudioJobMode
  title: string
  caption: string
  status: AudioJobStatus
  /** 0..1，整体进度（步骤均值） */
  progress: number
  steps: AudioJobStep[]
  /** 当前 Companion 任务 id（可取消） */
  taskId?: string
  error?: string
  /** 阻塞时给用户的下一步操作 */
  blockReason?: AudioJobBlockReason
  hint?: string
  /** 已落轨的轨道名 */
  placed: string[]
  createdAt: number
  updatedAt: number
}

interface AudioJobState {
  job: AudioJob | null
  /** 开始一个新任务（旧任务未完成时由调用方拦截） */
  start: (input: {
    mode: AudioJobMode
    title: string
    caption: string
    steps: Array<Pick<AudioJobStep, 'key' | 'label'>>
  }) => string
  update: (patch: Partial<Omit<AudioJob, 'id'>>) => void
  updateStep: (key: string, patch: Partial<Omit<AudioJobStep, 'key'>>) => void
  finish: (status: AudioJobStatus, patch?: Partial<Omit<AudioJob, 'id'>>) => void
  clear: () => void
}

function aggregateProgress(steps: AudioJobStep[]): number {
  if (steps.length === 0) return 0
  const sum = steps.reduce((total, step) => {
    if (step.status === 'done') return total + 1
    if (step.status === 'failed' || step.status === 'canceled') return total
    return total + Math.max(0, Math.min(1, step.progress))
  }, 0)
  return sum / steps.length
}

let jobSeq = 0

export const useAudioJobStore = create<AudioJobState>((set, get) => ({
  job: null,

  start: ({ mode, title, caption, steps }) => {
    const id = `audio_job_${Date.now()}_${(jobSeq += 1)}`
    const now = Date.now()
    const job: AudioJob = {
      id,
      mode,
      title,
      caption,
      status: 'running',
      progress: 0,
      steps: steps.map((step) => ({ ...step, status: 'pending', progress: 0 })),
      placed: [],
      createdAt: now,
      updatedAt: now,
    }
    set({ job })
    return id
  },

  update: (patch) => {
    const current = get().job
    if (!current) return
    set({ job: { ...current, ...patch, updatedAt: Date.now() } })
  },

  updateStep: (key, patch) => {
    const current = get().job
    if (!current) return
    const steps = current.steps.map((step) => (step.key === key ? { ...step, ...patch } : step))
    set({ job: { ...current, steps, progress: aggregateProgress(steps), updatedAt: Date.now() } })
  },

  finish: (status, patch) => {
    const current = get().job
    if (!current) return
    const steps = current.steps.map((step) =>
      status === 'done'
        ? { ...step, status: step.status === 'done' ? step.status : 'done', progress: 1 }
        : status === 'canceled' && step.status === 'pending'
          ? { ...step, status: 'canceled' as AudioStepStatus }
          : step,
    )
    set({
      job: {
        ...current,
        ...patch,
        steps,
        status,
        progress: status === 'done' ? 1 : aggregateProgress(steps),
        updatedAt: Date.now(),
      },
    })
  },

  clear: () => set({ job: null }),
}))

export function currentAudioJob(): AudioJob | null {
  return useAudioJobStore.getState().job
}
