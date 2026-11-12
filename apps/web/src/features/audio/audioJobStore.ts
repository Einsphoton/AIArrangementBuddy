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
  /** 服务端排队位置（0-based：0 = 下一个被派）；仅在 queued 阶段有值 */
  queuePosition?: number
  /** 服务端给出的预计等待秒数；仅在 queued 阶段有值 */
  etaSec?: number
  /** 本步第一次进入 running 的时间戳（UI 用来估算剩余时间） */
  startedAt?: number
  /** 服务端给出的当前阶段文案（P13，旧 Companion 可能没有） */
  message?: string
  error?: string
}

/** P13：生成阶段（与 Companion 协议一致；前端另有 prepare/render 兜底） */
export type AudioJobPhase =
  | 'queued'
  | 'prepare'
  | 'engine'
  | 'prompt'
  | 'sampling'
  | 'decoding'
  | 'upload'
  | 'done'
  | 'idle'
  | 'render'

/** P13：引擎实时遥测（任务卡 HUD 用；缺失字段如实留空，不伪造） */
export interface AudioJobTelemetry {
  phase?: AudioJobPhase
  phaseLabel?: string
  /** 扩散采样步数（estimated=true 表示按时间推算） */
  step?: number
  stepTotal?: number
  speed?: number
  estimated?: boolean
  cpuPct?: number
  rssMb?: number
  gpuName?: string
  gpuUtilPct?: number
  vramUsedMb?: number
  vramTotalMb?: number
  gpuTempC?: number
  sampledAt?: number
  /** 执行节点 / 引擎快照 */
  engine?: {
    state?: string
    variant?: string
    device?: string
    warm?: boolean
    pid?: number
    lm?: string | null
  }
  workerName?: string
}

/** 阻塞原因：需要下载环境 / 需要启动生成节点 / 工程为空 */
export type AudioJobBlockReason = 'provision' | 'start-companion' | 'empty-project'

/* ------------------------------------------------------------------ */
/* 生成中的「轨道槽位」                                                  */
/* ------------------------------------------------------------------ */

/**
 * 任务开始时就先占好的音频轨（DAW 里立刻出现一条会呼吸的占位轨）。
 *
 * 它不是真实 Track，也不写进工程（不参与保存 / 撤销）：只是 UI 层的
 * 「这条轨正在生成」承诺。生成完成后由 audioIntent 落成真实音频轨并
 * `removeSlot`，占位轨无缝变成真实片段，不会在工程里留下空轨。
 */
export type AudioJobTrackRole = 'song' | 'stem' | 'render'

export interface AudioJobTrackSlot {
  id: string
  /** 与 AudioJobStep.key 对应（song / stem:guitar / render） */
  key: string
  /** 最终落成的轨道名（实时对齐音频轨命名） */
  name: string
  /** 界面短标签（整曲 / 鼓组 / 吉他…） */
  label: string
  role: AudioJobTrackRole
  color: string
  /** 占位片段在时间轴上的起点（拍） */
  startBeat: number
  /** 预估时长（秒）——生成完成后按真实峰值的时长替换 */
  durationSec: number
  status: AudioStepStatus
  progress: number
  /** 这条轨第一次进入生成的时间（用于 ETA 估算） */
  startedAt?: number
  queuePosition?: number
  etaSec?: number
  message?: string
  error?: string
  createdAt: number
}

/** 创建任务时给槽位的初始描述（状态 / 进度由 store 维护） */
export type AudioJobTrackSpec = Pick<
  AudioJobTrackSlot,
  'key' | 'name' | 'label' | 'role' | 'color' | 'startBeat' | 'durationSec'
>

export interface AudioJob {
  id: string
  mode: AudioJobMode
  title: string
  caption: string
  status: AudioJobStatus
  /** 0..1，整体进度（步骤均值） */
  progress: number
  steps: AudioJobStep[]
  /** P13：引擎实时阶段 / 资源遥测（由任务轮询写入） */
  telemetry?: AudioJobTelemetry
  /** 当前 Companion 任务 id（可取消） */
  taskId?: string
  error?: string
  /** 阻塞时给用户的下一步操作 */
  blockReason?: AudioJobBlockReason
  hint?: string
  /** 已落轨的轨道名 */
  placed: string[]
  /** 该任务是否可以用上一份计划重试（失败 / 生成节点未启动） */
  retryable?: boolean
  createdAt: number
  updatedAt: number
}

interface AudioJobState {
  job: AudioJob | null
  /** 用户收起任务卡（任务继续执行；仍可在轨道头恢复） */
  hidden: boolean
  /** 生成中的占位轨（不属于工程；落轨后逐条移除） */
  slots: AudioJobTrackSlot[]
  /** 开始一个新任务（旧任务未完成时由调用方拦截） */
  start: (input: {
    mode: AudioJobMode
    title: string
    caption: string
    steps: Array<Pick<AudioJobStep, 'key' | 'label'>>
    /** 一开始就占好的轨道（DAW 里立刻可见）；旧调用方可以不传 */
    slots?: AudioJobTrackSpec[]
  }) => string
  update: (patch: Partial<Omit<AudioJob, 'id'>>) => void
  updateStep: (key: string, patch: Partial<Omit<AudioJobStep, 'key'>>) => void
  /** 单独改占位轨状态（落轨写入阶段用） */
  updateSlot: (key: string, patch: Partial<Omit<AudioJobTrackSlot, 'id' | 'key'>>) => void
  /** 真实音频轨已落成：移除占位轨，让真实轨在原位置出现 */
  removeSlot: (key: string) => void
  finish: (status: AudioJobStatus, patch?: Partial<Omit<AudioJob, 'id'>>) => void
  setHidden: (hidden: boolean) => void
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
  hidden: false,
  slots: [],

  start: ({ mode, title, caption, steps, slots: slotSpecs }) => {
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
    const slots: AudioJobTrackSlot[] = (slotSpecs ?? []).map((spec, index) => ({
      ...spec,
      id: `${id}_slot_${index}_${spec.key.replace(/[^a-z0-9]+/gi, '_')}`,
      status: 'pending',
      progress: 0,
      createdAt: now,
    }))
    set({ job, hidden: false, slots })
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
    const now = Date.now()
    const steps = current.steps.map((step) => {
      if (step.key !== key) return step
      const next: AudioJobStep = { ...step, ...patch }
      // 第一次进入 running 时记下开始时间：任务卡据此估算剩余时间。
      // 若调用方显式传入 startedAt（自动化注入 / 恢复任务），以传入值为准。
      if (patch.status === 'running' && patch.startedAt == null && !step.startedAt) next.startedAt = now
      if (patch.status === 'done') next.progress = 1
      return next
    })
    // 占位轨跟随对应 step：排队 / 生成 / 写入的进度都直接反映在 DAW 车道上
    const slots = get().slots.map((slot) => {
      if (slot.key !== key) return slot
      const next: AudioJobTrackSlot = {
        ...slot,
        status: patch.status ?? slot.status,
        progress: patch.status === 'done' ? 1 : (patch.progress ?? slot.progress),
        message: patch.message ?? slot.message,
        error: patch.error ?? slot.error,
        startedAt: slot.startedAt ?? (patch.status === 'running' ? (patch.startedAt ?? now) : undefined),
      }
      if ('queuePosition' in patch) next.queuePosition = patch.queuePosition
      if ('etaSec' in patch) next.etaSec = patch.etaSec
      return next
    })
    set({ job: { ...current, steps, progress: aggregateProgress(steps), updatedAt: now }, slots })
  },

  updateSlot: (key, patch) => {
    const current = get().job
    if (!current) return
    set({
      slots: get().slots.map((slot) => (slot.key === key ? { ...slot, ...patch } : slot)),
    })
  },

  removeSlot: (key) => {
    const current = get().job
    if (!current) return
    set({ slots: get().slots.filter((slot) => slot.key !== key) })
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
    // 终态语义：
    // - done / canceled：占位轨全部退场（done 时真实轨已落成；canceled 不留幽灵轨）
    // - failed：保留失败的占位轨（就地显示红态，重试 / 关闭时再移除）
    // - blocked：保留占位轨，显示「等待节点接入」——轨道已经建好，只是还没开始生成
    let slots = get().slots
    if (status === 'done' || status === 'canceled') slots = []
    else if (status === 'failed') {
      slots = slots.map((slot) =>
        slot.status === 'done'
          ? slot
          : { ...slot, status: slot.status === 'running' ? 'failed' : 'canceled' },
      )
    }
    set({
      job: {
        ...current,
        ...patch,
        steps,
        status,
        progress: status === 'done' ? 1 : aggregateProgress(steps),
        updatedAt: Date.now(),
      },
      // 完成时把收起的卡片重新亮出来，给用户一个明确的收尾确认
      hidden: status === 'done' ? false : get().hidden,
      slots,
    })
  },

  setHidden: (hidden) => set({ hidden }),

  clear: () => set({ job: null, hidden: false, slots: [] }),
}))

export function currentAudioJob(): AudioJob | null {
  return useAudioJobStore.getState().job
}
