/**
 * AI 音频意图桥（P9）：
 *
 * AI 编曲助手在对话里识别出「要音频」后，服务端工具 `generate_audio` 只返回一份
 * **音频计划（AudioPlan）**，真正的执行在这里：
 *
 *   1) 文本 → 音频（Companion generate_audio）
 *   2) MIDI → 音频（浏览器离线渲染当前工程 → 上传资产 → 落一条音频轨）
 *   3) 文本 → 音频 → 分轨（整曲完成后按 arm 依次 generate_stem）
 *   4) 先做 MIDI 再渲染（等价于 1 完成后 2，由 AI 保证顺序）
 *
 * 设计约束：
 * - 生成任务可能持续几分钟：进度写进 audioJobStore，由 AI 面板里的任务卡展示；
 * - 音频工具只决定「做什么」，不在服务端执行，因此 Codex/DSH 等外部 Agent 后端
 *   也能复用同一套前端执行逻辑（外部后端拿不到 tool data 时走启发式兜底）；
 * - 缺少本机模型/运行时 → 自动弹出「安装本机引擎」对话框询问是否下载，并保留任务卡说明；
 * - 模型已安装但 Companion 没启动 → 给出可复制的启动命令，不伪造成功。
 */
import { projectEndBeat } from '@aiab/core'
import {
  cancelCompanionTask,
  createCompanionGenerateTask,
  createCompanionStemTask,
  getAssetPeaks,
  getCompanionStatus,
  getCompanionTask,
  getProvisionStatus,
  STEM_ARM_LABEL,
  STEM_ARMS,
  uploadAudioAsset,
  type CompanionEngine,
  type CompanionPriority,
  type CompanionTaskState,
  type CompanionTaskStatus,
  type ProvisionProfileId,
  type StemArm,
} from '../../lib/api'
import { getAudioEngine } from '../../audio'
import { useStore } from '../../store/store'
import { useAudioJobStore, type AudioJobPhase, type AudioJobTelemetry } from './audioJobStore'
import { assetRefFromPeaks, generatedAudioProvenance, placeAudioClip } from './audioTrack'
import type { AudioJobTrackSpec } from './audioJobStore'
import { TRACK_COLORS } from '../arrangement/timeline'
import { primeAssetPeaks } from './peaks'
import { resolveCompanionHint } from './CompanionBadge'

export type AudioMode = 'text_to_audio' | 'midi_to_audio' | 'audio_with_stems' | 'midi_then_audio'

export interface AudioPlan {
  mode: AudioMode
  /** 英文提示词（风格 / 乐器 / 情绪 / BPM） */
  caption?: string
  bpm?: number
  durationSec?: number
  style?: string
  stems?: StemArm[]
  startBeat?: number
  trackName?: string
  quality?: boolean
  /**
   * P9：引擎量级（可选）。AI 工具可以指定 xl，但这里**不把 xl 当作生成前置条件**：
   * 缺省仍走 2b，装没装 XL 只需要在任务失败时由服务端报错说明。
   */
  engine?: CompanionEngine
  priority?: CompanionPriority
  /** AI 给出的一句话理由（展示在任务卡里） */
  reason?: string
}

const POLL_MS = 900
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const round3 = (value: number) => Math.round(value * 1000) / 1000

const MODE_TITLE: Record<AudioMode, string> = {
  text_to_audio: '生成整首音频',
  midi_to_audio: 'MIDI 渲染为音频',
  audio_with_stems: '生成整首音频 + 分轨',
  midi_then_audio: '编曲后渲染为音频',
}

const TERMINAL = new Set<CompanionTaskStatus>(['done', 'failed', 'canceled'])

class JobCanceledError extends Error {
  constructor() {
    super('任务已取消')
    this.name = 'JobCanceledError'
  }
}

/** 正在执行 / 刚被取消的任务（只用于阻止旧轮询继续写状态） */
const canceledJobs = new Set<string>()

/**
 * 最近一次音频计划：失败 / 生成节点未启动时留着它，让任务卡可以
 * 「重试」或在节点上线后自动继续（不需要用户重新说一遍）。
 */
let lastPlan: AudioPlan | null = null

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ */
/* 意图识别（前端启发式：只用于给 Agent 一个强提示 + 外部后端兜底）      */
/* ------------------------------------------------------------------ */

const AUDIO_ACTION_RE =
  /(生成|制作|做|来|写|出|渲染|导出|转|变|输出|bounce|render|export|generate|make).{0,24}(音频|audio|wav|mp3|成品|声音文件)/i
const AUDIO_EXPLICIT_RE = /(音频|audio|wav|mp3|分轨|stem|text.?to.?audio|文生音乐|整曲音频|成品音频)/i

/** 用户这句话是否明确要求「音频」而不是「MIDI 编曲」 */
export function detectAudioIntent(text: string): boolean {
  const source = text.trim()
  if (!source) return false
  if (!AUDIO_EXPLICIT_RE.test(source)) return false
  if (AUDIO_ACTION_RE.test(source)) return true
  // 「把这段编曲做成成品」「按这首 MIDI 导出」这类省略了“音频”二字的说法
  if (/(midi|工程|编曲|伴奏|这段|这首|当前).{0,12}(渲染|导出|转成|变成|做成|输出)/i.test(source)) return true
  // 「分轨」单独出现也属于音频能力
  return /分轨|stem|拆轨/i.test(source)
}

const ARM_LABEL_RE: Array<[StemArm, RegExp]> = [
  ['guitar', /吉他|guitar/i],
  ['bass', /贝斯|bass/i],
  ['drums', /鼓组|鼓|drum/i],
  ['strings', /弦乐|strings/i],
  ['keys', /键盘|钢琴|keys|piano/i],
  ['synth', /合成器|synth/i],
  ['vocals', /人声|vocal/i],
]

function extractStemArms(text: string): StemArm[] | undefined {
  const found = ARM_LABEL_RE.filter(([, pattern]) => pattern.test(text)).map(([arm]) => arm)
  return found.length ? found : undefined
}

/** 外部 Agent 后端 / 模型没调用工具时的兜底计划（保守：只处理明确音频请求） */
export function buildHeuristicAudioPlan(text: string): AudioPlan | null {
  if (!detectAudioIntent(text)) return null
  const source = text.trim()
  const stems = /分轨|stem|拆轨|分开.*(乐器|轨)/i.test(source) ? (extractStemArms(source) ?? ['guitar', 'bass', 'drums']) : undefined
  if (stems) {
    return { mode: 'audio_with_stems', caption: source.slice(0, 600), stems, reason: '按你的描述识别为「整曲 + 分轨」' }
  }
  if (/(midi|工程|编曲|伴奏|这段|这首|当前).{0,14}(渲染|导出|转成|变成|做成|输出)|渲染成音频|导出成音频/i.test(source)) {
    return { mode: 'midi_to_audio', reason: '工程里已有素材，识别为「MIDI → 音频」' }
  }
  return { mode: 'text_to_audio', caption: source.slice(0, 600), reason: '识别为「文本 → 音频」' }
}

/* ------------------------------------------------------------------ */
/* 工具返回值 → 音频计划                                                */
/* ------------------------------------------------------------------ */

function isAudioMode(value: unknown): value is AudioMode {
  return value === 'text_to_audio' || value === 'midi_to_audio' || value === 'audio_with_stems' || value === 'midi_then_audio'
}

/** 从 `generate_audio` 工具的 data 里提取计划；数据不合法时返回 null */
export function parseAudioPlan(data: unknown): AudioPlan | null {
  if (!data || typeof data !== 'object') return null
  const source = data as { audioPlan?: unknown }
  const raw = source.audioPlan
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (!isAudioMode(value.mode)) return null
  const stems = Array.isArray(value.stems)
    ? value.stems.filter((item): item is StemArm => typeof item === 'string' && (STEM_ARMS as readonly string[]).includes(item))
    : undefined
  const toNumber = (input: unknown): number | undefined => {
    const parsed = Number(input)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const toPriority = (input: unknown): CompanionPriority | undefined => {
    const parsed = toNumber(input)
    return parsed === 1 || parsed === 2 ? parsed : parsed === 0 ? 0 : undefined
  }
  return {
    mode: value.mode,
    caption: typeof value.caption === 'string' ? value.caption.slice(0, 600) : undefined,
    bpm: toNumber(value.bpm),
    durationSec: toNumber(value.durationSec),
    style: typeof value.style === 'string' ? value.style.slice(0, 80) : undefined,
    stems: stems && stems.length ? stems : undefined,
    startBeat: toNumber(value.startBeat),
    trackName: typeof value.trackName === 'string' ? value.trackName.slice(0, 60) : undefined,
    quality: value.quality === true,
    engine: value.engine === 'xl' ? 'xl' : value.engine === '2b' ? '2b' : undefined,
    priority: toPriority(value.priority),
    reason: typeof value.reason === 'string' ? value.reason.slice(0, 200) : undefined,
  }
}

/** tool_end 里带 audioPlan 时执行；返回是否识别并接管 */
export function handleAudioPlanFromToolData(data: unknown): boolean {
  const plan = parseAudioPlan(data)
  if (!plan) return false
  void runAudioPlan(plan).catch((error: unknown) => {
    useStore
      .getState()
      .pushToast('error', `音频任务启动失败：${error instanceof Error ? error.message : String(error)}`)
  })
  return true
}

/* ------------------------------------------------------------------ */
/* 可用性检查：缺模型 → 自动弹下载对话框                                 */
/* ------------------------------------------------------------------ */

type Readiness =
  | { ok: true }
  | { ok: false; reason: 'provision'; profiles: ProvisionProfileId[]; message: string; bytes: number }
  | { ok: false; reason: 'start-companion'; message: string; hint: string }

async function checkGenerationReady(needsStems: boolean): Promise<Readiness> {
  try {
    const companion = await getCompanionStatus()
    if (companion.online && (companion.summary?.workers ?? 0) > 0) return { ok: true }
  } catch {
    /* 服务端未就绪：继续检查本机安装状态 */
  }
  let provision: Awaited<ReturnType<typeof getProvisionStatus>> | null = null
  let provisionFailed = false
  try {
    provision = await getProvisionStatus()
  } catch {
    provisionFailed = true
  }
  if (!provision && provisionFailed) {
    // 连本地服务都没起来：不要误导用户去下载模型
    return {
      ok: false,
      reason: 'start-companion',
      message: '无法连接本地服务，暂时无法检查音频引擎。请先启动后端（pnpm dev / pnpm start）。',
      hint: 'pnpm dev',
    }
  }
  const essential = provision?.profiles?.find((profile) => profile.id === 'essential')
  const installed = Boolean(provision?.runtime?.installed) && essential?.ready === true
  if (!provision?.supported || !installed) {
    const profiles: ProvisionProfileId[] = ['essential']
    if (needsStems) profiles.push('stems')
    const bytes =
      (essential?.downloadBytes ?? 3_200_000_000) +
      (needsStems ? (provision?.profiles?.find((profile) => profile.id === 'stems')?.downloadBytes ?? 5_800_000_000) : 0)
    const size = bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)}GB` : `${Math.round(bytes / 1024 ** 2)}MB`
    return {
      ok: false,
      reason: 'provision',
      profiles,
      bytes,
      message: `生成音频需要本机 AI 引擎与模型（约 ${size}）。是否现在下载？下载完成后还差「启动生成节点」一步。`,
    }
  }
  const hint = resolveCompanionHint()
  return {
    ok: false,
    reason: 'start-companion',
    message: '本机模型已安装，但生成节点（Companion）未启动。',
    hint,
  }
}

/* ------------------------------------------------------------------ */
/* 执行                                                                 */
/* ------------------------------------------------------------------ */

function activeJob() {
  return useAudioJobStore.getState().job
}

/** 打开「安装本机引擎」对话框（ProvisionButton 全局监听该事件） */
function openProvisionDialog(input: { reason: string; profiles: ProvisionProfileId[] }) {
  window.dispatchEvent(new CustomEvent('aiab:provision-open', { detail: { ...input, source: 'audio-intent' } }))
}

function fail(jobId: string, message: string, extra: { blockReason?: 'provision' | 'start-companion' | 'empty-project'; hint?: string } = {}) {
  const state = useAudioJobStore.getState()
  if (state.job?.id !== jobId) return
  state.finish('failed', {
    error: message,
    ...extra,
    // 空工程重试没有意义；其它失败保留计划，任务卡给出「重试」
    retryable: extra.blockReason !== 'empty-project',
  })
  useStore.getState().pushToast('error', message)
}

function assertActive(jobId: string) {
  if (canceledJobs.has(jobId)) throw new JobCanceledError()
  if (activeJob()?.id !== jobId) throw new JobCanceledError()
}

const STATUS_TO_STEP: Record<CompanionTaskStatus, 'running' | 'done' | 'failed' | 'canceled'> = {
  queued: 'running',
  running: 'running',
  done: 'done',
  failed: 'failed',
  canceled: 'canceled',
}

/** 去掉 undefined，避免旧服务端/旧 Companion 的缺字段把已有遥测覆盖空 */
function compactObject<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T
}

function compactTelemetry(input: AudioJobTelemetry): AudioJobTelemetry {
  return compactObject(input)
}

/** 服务端任务详情 → 任务卡 HUD 状态（P13；字段缺失就留空，由界面做降级） */
export function telemetryFromTask(task: CompanionTaskState): AudioJobTelemetry {
  const engine = task.worker?.status?.engine
  const phase: AudioJobPhase | undefined =
    (task.phase as AudioJobPhase | undefined) ?? (task.status === 'queued' ? 'queued' : undefined)
  return compactTelemetry({
    phase,
    phaseLabel: task.phaseLabel,
    step: task.step,
    stepTotal: task.stepTotal,
    speed: task.speed,
    estimated: task.estimated,
    cpuPct: task.telemetry?.cpuPct ?? engine?.cpuPct,
    rssMb: task.telemetry?.rssMb ?? engine?.rssMb,
    gpuName: task.telemetry?.gpuName ?? engine?.gpuName,
    gpuUtilPct: task.telemetry?.gpuUtilPct ?? engine?.gpuUtilPct,
    vramUsedMb: task.telemetry?.vramUsedMb ?? engine?.vramUsedMb,
    vramTotalMb: task.telemetry?.vramTotalMb ?? engine?.vramTotalMb,
    gpuTempC: task.telemetry?.gpuTempC ?? engine?.gpuTempC,
    sampledAt: task.telemetry?.sampledAt ?? engine?.sampledAt,
    engine: engine
      ? compactObject({
          state: engine.state,
          variant: engine.variant,
          device: engine.device,
          warm: engine.warm,
          pid: engine.pid,
          lm: engine.lm,
        })
      : undefined,
    workerName: task.worker?.name,
  })
}

async function waitCompanionTask(jobId: string, stepKey: string, taskId: string): Promise<string> {
  for (;;) {
    assertActive(jobId)
    const { task } = await getCompanionTask(taskId)
    const stepStatus = STATUS_TO_STEP[task.status]
    const queued = task.status === 'queued'
    useAudioJobStore.getState().updateStep(stepKey, {
      status: stepStatus,
      progress: task.status === 'done' ? 1 : clamp(task.progress ?? 0, 0, 1),
      error: task.error,
      message: task.message,
      // 排队信息只在 queued 阶段有意义（服务端其它状态返回 0）
      queuePosition: queued ? task.queuePosition : undefined,
      etaSec: queued ? task.estimatedWaitSec : undefined,
    })
    const currentJob = useAudioJobStore.getState().job
    if (currentJob) {
      useAudioJobStore.getState().update({
        telemetry: { ...currentJob.telemetry, ...telemetryFromTask(task) },
      })
    }
    if (TERMINAL.has(task.status)) {
      if (task.status !== 'done' || !task.assetId) {
        throw new Error(task.error || (task.status === 'canceled' ? '任务已取消' : '生成失败'))
      }
      return task.assetId
    }
    await sleep(POLL_MS)
  }
}

async function placeGeneratedAsset(
  jobId: string,
  stepKey: string,
  assetId: string,
  options: { name: string; trackName: string; startBeat: number; caption: string; bpm: number; durationSec?: number },
): Promise<void> {
  const slot = useAudioJobStore.getState().slots.find((item) => item.key === stepKey)
  // 生成完成 → 写入阶段：占位轨原地变成「正在写入」，不凭空消失
  useAudioJobStore.getState().updateSlot(stepKey, {
    status: 'running',
    progress: 0.99,
    message: '正在写入音频轨…',
  })
  const peaks = await getAssetPeaks(assetId)
  assertActive(jobId)
  primeAssetPeaks(assetId, peaks)
  const asset = assetRefFromPeaks(assetId, peaks, { name: `${options.name}.wav` })
  const store = useStore.getState()
  const trackName = slot?.name || options.trackName
  const placedRef: { value: { trackId: string; clipId: string } | null } = { value: null }
  store.mutate((draft) => {
    placedRef.value = placeAudioClip(draft, {
      asset,
      durationSec: peaks.durationSec,
      name: options.name,
      startBeat: options.startBeat,
      trackName,
      color: slot?.color,
      provenance: generatedAudioProvenance({
        caption: options.caption,
        bpm: options.bpm,
        durationSec: options.durationSec ?? Math.round(peaks.durationSec),
      }),
    })
  })
  const placed = placedRef.value
  if (!placed) {
    useAudioJobStore.getState().updateStep(stepKey, { status: 'failed', error: '创建音频轨失败' })
    throw new Error('创建音频轨失败')
  }
  // 真实轨已在同一位置出现：移除占位轨，选中并把视图滚到这条新轨
  useAudioJobStore.getState().removeSlot(stepKey)
  useStore.getState().selectTrack(placed.trackId)
  useStore.getState().setView('arrangement')
  useStore.getState().requestReveal(placed.trackId, options.startBeat)
  const job = activeJob()
  if (job) useAudioJobStore.getState().update({ placed: [...job.placed, trackName] })
}

/** MIDI → 音频：浏览器离线渲染当前工程，上传资产后落一条音频轨 */
async function runMidiRender(jobId: string, plan: AudioPlan) {
  const store = useStore.getState()
  const project = store.project
  const hasContent = project.tracks.some((track) => track.clips.length > 0 || track.audioClips.length > 0)
  if (!hasContent) {
    fail(jobId, '工程还是空的：先让 AI 编一段 MIDI，或先生成音频。', { blockReason: 'empty-project' })
    return
  }
  const stepKey = 'render'
  useAudioJobStore.getState().updateStep(stepKey, { status: 'running', progress: 0 })
  useAudioJobStore.getState().update({
    telemetry: { phase: 'prepare', phaseLabel: '准备离线渲染', engine: { state: 'ready', device: '浏览器离线渲染' } },
  })
  try {
    const engine = getAudioEngine()
    const baseName = (plan.trackName || project.name || 'AI 渲染').slice(0, 40)
    const blob = await engine.renderToWav(project, {
      sampleRate: 44100,
      onProgress: (ratio) => {
        if (canceledJobs.has(jobId)) return
        useAudioJobStore.getState().updateStep(stepKey, { progress: clamp(ratio, 0, 0.9), status: 'running' })
        useAudioJobStore.getState().update({
          telemetry: { phase: 'render', phaseLabel: '离线渲染中', engine: { state: 'ready', device: '浏览器离线渲染' } },
        })
      },
    })
    assertActive(jobId)
    useAudioJobStore.getState().updateStep(stepKey, { progress: 0.92, status: 'running' })
    useAudioJobStore.getState().update({
      telemetry: { phase: 'upload', phaseLabel: '编码并写入工程', engine: { state: 'ready', device: '浏览器离线渲染' } },
    })
    const file = new File([blob], `${baseName}.wav`, { type: 'audio/wav' })
    const uploaded = await uploadAudioAsset(file)
    assertActive(jobId)
    const asset = assetRefFromPeaks(uploaded.asset.id, {
      id: uploaded.asset.id,
      durationSec: uploaded.durationSec,
      sampleRate: uploaded.sampleRate,
      channels: uploaded.channels,
      peaks: uploaded.peaks,
    }, { name: `${baseName}.wav` })
    primeAssetPeaks(uploaded.asset.id, {
      id: uploaded.asset.id,
      durationSec: uploaded.durationSec,
      sampleRate: uploaded.sampleRate,
      channels: uploaded.channels,
      peaks: uploaded.peaks,
    })
    const startBeat = Math.max(0, plan.startBeat ?? store.playhead)
    const slot = useAudioJobStore.getState().slots.find((item) => item.key === stepKey)
    const trackName = slot?.name ?? `渲染 · ${baseName}`
    const current = useStore.getState()
    const placedRef: { value: { trackId: string; clipId: string } | null } = { value: null }
    current.mutate((draft) => {
      placedRef.value = placeAudioClip(draft, {
        asset,
        durationSec: uploaded.durationSec,
        name: baseName,
        startBeat,
        trackName,
        color: slot?.color,
        provenance: generatedAudioProvenance({
          caption: plan.caption ?? `MIDI render: ${project.name}`,
          bpm: plan.bpm ?? project.tempo,
          durationSec: Math.round(uploaded.durationSec),
        }),
      })
    })
    const placed = placedRef.value
    if (!placed) throw new Error('创建音频轨失败')
    useAudioJobStore.getState().removeSlot(stepKey)
    useStore.getState().selectTrack(placed.trackId)
    useStore.getState().setView('arrangement')
    useStore.getState().requestReveal(placed.trackId, startBeat)
    useAudioJobStore.getState().updateStep(stepKey, { status: 'done', progress: 1 })
    useAudioJobStore.getState().update({ placed: [trackName] })
    useAudioJobStore.getState().finish('done')
    useStore.getState().pushToast('success', `已渲染为音频并加入工程：${baseName}（⌘Z 可撤销）`)
  } catch (error) {
    if (error instanceof JobCanceledError) {
      useAudioJobStore.getState().updateStep(stepKey, { status: 'canceled' })
      return
    }
    fail(jobId, error instanceof Error ? error.message : 'MIDI 渲染失败')
  }
}

/** 文本 → 音频（可带分轨） */
async function runCompanionFlow(jobId: string, plan: AudioPlan, stems: StemArm[], bpm: number, durationSec: number) {
  const store = useStore.getState()
  const projectId = store.project.id
  const startBeat = Math.max(0, plan.startBeat ?? store.playhead)
  const caption = (plan.caption ?? '').trim() || `${plan.style ?? ''} instrumental, ${bpm} bpm`.trim()
  const priority = plan.priority ?? 0
  try {
    const songStep = 'song'
    useAudioJobStore.getState().updateStep(songStep, { status: 'running', progress: 0 })
    const created = await createCompanionGenerateTask(
      {
        caption,
        bpm,
        durationSec,
        style: plan.style,
        quality: plan.quality || undefined,
        /* P9：AI 可指定引擎量级；缺省不传 = 服务端按 2b */
        engine: plan.engine,
      },
      projectId,
      priority,
    )
    assertActive(jobId)
    useAudioJobStore.getState().update({ taskId: created.taskId })
    const songAssetId = await waitCompanionTask(jobId, songStep, created.taskId)
    const songName = plan.trackName || caption.slice(0, 32) || 'AI 生成音频'
    await placeGeneratedAsset(jobId, songStep, songAssetId, {
      name: songName,
      trackName: `生成 · ${songName.slice(0, 20)}`,
      startBeat,
      caption,
      bpm,
      durationSec,
    })
    useAudioJobStore.getState().updateStep(songStep, { status: 'done', progress: 1 })

    for (const arm of stems) {
      const key = `stem:${arm}`
      useAudioJobStore.getState().updateStep(key, { status: 'running', progress: 0 })
      const stemTask = await createCompanionStemTask(
        { sourceAssetId: songAssetId, arm, caption: `${caption} · ${arm} stem`, engine: plan.engine },
        projectId,
        priority,
      )
      assertActive(jobId)
      useAudioJobStore.getState().update({ taskId: stemTask.taskId })
      const stemAssetId = await waitCompanionTask(jobId, key, stemTask.taskId)
      await placeGeneratedAsset(jobId, key, stemAssetId, {
        name: `Stem · ${STEM_ARM_LABEL[arm]}`,
        trackName: `Stem · ${STEM_ARM_LABEL[arm]}`,
        startBeat,
        caption: `${caption} · ${arm} stem`,
        bpm,
        durationSec,
      })
      useAudioJobStore.getState().updateStep(key, { status: 'done', progress: 1 })
    }

    useAudioJobStore.getState().finish('done')
    useStore
      .getState()
      .pushToast(
        'success',
        stems.length
          ? `音频生成完成：1 条整曲 + ${stems.length} 条分轨（每条轨可单独撤销）`
          : `音频已生成并加入工程：${songName}（⌘Z 可撤销）`,
      )
  } catch (error) {
    if (error instanceof JobCanceledError) {
      useAudioJobStore.getState().finish('canceled')
      return
    }
    fail(jobId, error instanceof Error ? error.message : '音频生成失败')
  }
}

/** 入口：执行一份音频计划（AI 工具结果 / 前端兜底都走这里） */
export async function runAudioPlan(plan: AudioPlan): Promise<void> {
  const running = activeJob()
  if (running && running.status === 'running') {
    useStore.getState().pushToast('info', `已有音频任务进行中：${running.title}，完成后再试`)
    return
  }
  // 只记住真正开始执行的计划：被「已有任务进行中」拦下的计划不应覆盖当前任务的重试依据
  lastPlan = plan
  const mode: AudioMode = plan.mode
  const project = useStore.getState().project
  const bpm = Number.isFinite(plan.bpm) ? Math.round(clamp(Number(plan.bpm), 20, 320)) : Math.round(project.tempo)
  const needsStems = mode === 'audio_with_stems'
  const stems: StemArm[] = needsStems
    ? plan.stems?.length
      ? plan.stems
      : ['guitar', 'bass', 'drums']
    : []
  const durationSec = Number.isFinite(plan.durationSec)
    ? Math.round(clamp(Number(plan.durationSec), 5, 300))
    : needsStems
      ? 45
      : 30
  const title = plan.trackName || MODE_TITLE[mode]
  const isRenderMode = mode === 'midi_to_audio' || mode === 'midi_then_audio'

  const stepDefs = isRenderMode
    ? [{ key: 'render', label: '离线渲染当前工程 → WAV' }]
    : [
        { key: 'song', label: needsStems ? '生成整曲音频' : '生成音频' },
        ...stems.map((arm) => ({ key: `stem:${arm}`, label: `分轨 · ${STEM_ARM_LABEL[arm]}` })),
      ]

  /* 任务一开始就在 DAW 里占好音频轨：不用等生成完才看到结果。
     配色优先避开工程里已有的颜色，至少让整曲 / 每条分轨之间一眼可分。 */
  const usedColors = new Set(project.tracks.map((track) => track.color))
  const colorAt = (index: number) => {
    const start = (project.tracks.length + index) % TRACK_COLORS.length
    for (let step = 0; step < TRACK_COLORS.length; step += 1) {
      const color = TRACK_COLORS[(start + step) % TRACK_COLORS.length]
      if (!usedColors.has(color)) {
        usedColors.add(color)
        return color
      }
    }
    return TRACK_COLORS[start]
  }
  const startBeat = Math.max(0, plan.startBeat ?? useStore.getState().playhead)
  const caption = (plan.caption ?? '').trim() || `${plan.style ?? ''} instrumental, ${bpm} bpm`.trim()
  const songName = plan.trackName || caption.slice(0, 32) || 'AI 生成音频'
  const renderBaseName = (plan.trackName || project.name || 'AI 渲染').slice(0, 40)
  const projectDurationSec = Math.max(
    4,
    Math.round((projectEndBeat(project) / Math.max(20, project.tempo)) * 60),
  )
  const slotSpecs: AudioJobTrackSpec[] = isRenderMode
    ? [
        {
          key: 'render',
          name: `渲染 · ${renderBaseName}`,
          label: '工程',
          role: 'render',
          color: colorAt(0),
          startBeat,
          durationSec: projectDurationSec,
        },
      ]
    : [
        {
          key: 'song',
          name: `生成 · ${songName.slice(0, 20)}`,
          label: '整曲',
          role: 'song',
          color: colorAt(0),
          startBeat,
          durationSec,
        },
        ...stems.map((arm, index) => ({
          key: `stem:${arm}`,
          name: `Stem · ${STEM_ARM_LABEL[arm]}`,
          label: STEM_ARM_LABEL[arm],
          role: 'stem' as const,
          color: colorAt(index + 1),
          startBeat,
          durationSec,
        })),
      ]

  const jobId = useAudioJobStore.getState().start({
    mode,
    title,
    caption: plan.caption ?? '',
    steps: stepDefs,
    slots: slotSpecs,
  })
  // 立刻把视线带到编曲视图：用户能先看到「轨道已建好、AI 正在生成」
  useStore.getState().setView('arrangement')
  useStore.getState().pushToast('info', `AI 已安排音频任务：${MODE_TITLE[mode]}`)

  if (isRenderMode) {
    await runMidiRender(jobId, plan)
    return
  }

  const readiness = await checkGenerationReady(needsStems)
  if (!readiness.ok) {
    const job = activeJob()
    if (job?.id !== jobId) return
    if (readiness.reason === 'provision') {
      useAudioJobStore.getState().finish('blocked', {
        blockReason: 'provision',
        error: readiness.message,
        hint: '已为你打开「安装本机引擎」对话框，确认下载即可。',
        retryable: true,
      })
      useStore.getState().pushToast('info', '需要先下载本机音频模型，已打开安装对话框')
      openProvisionDialog({ reason: readiness.message, profiles: readiness.profiles })
    } else {
      useAudioJobStore.getState().finish('blocked', {
        blockReason: 'start-companion',
        error: readiness.message,
        hint: readiness.hint,
        retryable: true,
      })
      useStore.getState().pushToast('error', readiness.message)
    }
    return
  }

  await runCompanionFlow(jobId, plan, stems, bpm, durationSec)
}

/**
 * 用上一份计划重试当前失败 / 被阻塞的任务。
 *
 * - 生成节点（Companion）未启动：任务卡会轮询节点状态，上线后自动调用这里继续；
 * - 失败（引擎报错 / 断线）：任务卡给出「重试」；
 * - `expectedJobId` 用于自动继续：只重试仍停留在卡上的那个阻塞任务，
 *   避免用户已经关闭/换任务后又被旧轮询拉起。
 */
export function retryAudioJob(expectedJobId?: string): boolean {
  const current = activeJob()
  if (!current) return false
  if (expectedJobId && current.id !== expectedJobId) return false
  if (!current.retryable) return false
  if (current.status !== 'failed' && current.status !== 'blocked') return false
  const plan = lastPlan
  if (!plan) return false
  useAudioJobStore.getState().clear()
  void runAudioPlan(plan).catch((error: unknown) => {
    useStore.getState().pushToast('error', `重试音频任务失败：${error instanceof Error ? error.message : String(error)}`)
  })
  return true
}

/** 取消当前音频任务（Companion 任务会通知服务端取消；离线渲染忽略结果） */
export async function cancelAudioJob(): Promise<void> {
  const job = activeJob()
  if (!job) return
  canceledJobs.add(job.id)
  useAudioJobStore.getState().finish('canceled')
  if (job.taskId) {
    try {
      await cancelCompanionTask(job.taskId)
    } catch {
      /* 服务端会自行收尾 */
    }
  }
  useStore.getState().pushToast('info', '已取消音频任务')
  // 清理取消标记，避免同一 id 长时间占用内存（id 唯一，1 分钟后释放）
  window.setTimeout(() => canceledJobs.delete(job.id), 60_000)
}

/** 外部 Agent 后端拿不到 tool data 时的兜底：仅对明确的音频请求生效 */
export function runHeuristicAudioFallback(text: string): boolean {
  const plan = buildHeuristicAudioPlan(text)
  if (!plan) return false
  const store = useStore.getState()
  store.addMessage({
    role: 'system',
    content: `未收到音频工具调用，已按「${MODE_TITLE[plan.mode]}」直接执行。${plan.reason ?? ''}\n如需更准确的风格提示词，建议切回内置 Agent 或使用「高级生成设置」手动填写英文描述。`,
  })
  void runAudioPlan(plan).catch((error: unknown) => {
    useStore
      .getState()
      .pushToast('error', `音频任务启动失败：${error instanceof Error ? error.message : String(error)}`)
  })
  return true
}
