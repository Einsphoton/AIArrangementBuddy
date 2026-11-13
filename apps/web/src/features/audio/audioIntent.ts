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
  createCompanionCoverTask,
  createCompanionGenerateTask,
  createCompanionStemTask,
  getAssetPeaks,
  getCompanionNode,
  getCompanionStatus,
  getCompanionTask,
  getProvisionStatus,
  startCompanionNode,
  STEM_ARM_LABEL,
  STEM_ARMS,
  uploadAudioAsset,
  type CompanionEngine,
  type CompanionNodeStatus,
  type CompanionPriority,
  type CompanionTaskState,
  type CompanionTaskStatus,
  type ProvisionProfileId,
  type StemArm,
} from '../../lib/api'
import { getAudioEngine } from '../../audio'
import { useStore } from '../../store/store'
import { useAudioJobStore, type AudioJobPhase, type AudioJobTelemetry } from './audioJobStore'
import { assetPeakFromPeaks, assetRefFromPeaks, generatedAudioProvenance, placeAudioClip, stemPlacementVolume } from './audioTrack'
import type { AudioJobTrackSpec } from './audioJobStore'
import { TRACK_COLORS } from '../arrangement/timeline'
import { primeAssetPeaks } from './peaks'
import { resolveCompanionHint } from './CompanionBadge'

export type AudioMode = 'text_to_audio' | 'midi_to_audio' | 'ai_cover' | 'audio_with_stems'

export interface AudioPlan {
  mode: AudioMode
  /** 英文提示词（风格 / 乐器 / 情绪 / BPM） */
  caption?: string
  bpm?: number
  /**
   * 调性（主音 + 调式，如 "C minor"）。服务端工具会先按模型给的值填，
   * 没给就按工程 key/scale 兜底；前端执行时再兜一层，确保引擎拿到的调性
   * 与 DAW 工程一致（否则 C minor 的工程会被当成 C major 生成）。
   */
  keyscale?: string
  /** 拍号分子（如 "4"）。引擎只认分子字符串；缺省按工程 timeSignature 推导 */
  timesignature?: string
  durationSec?: number
  style?: string
  stems?: StemArm[]
  /**
   * 是否纯乐器（无人声），缺省 true（= 旧行为）。
   * false 表示这次生成**要人声**：Companion 会把歌词条件从 `[Instrumental]`（禁止人声）
   * 改成 `''`（让 LM 写歌词）。不传 = 纯乐器，与今天的生成完全一致。
   */
  instrumental?: boolean
  /**
   * 演唱语言（BCP-47，如 'ja'）。仅要人声时有意义；缺省由 Companion 按 caption
   * 线索推断（Japanese/anime/J-ROCK → ja），不能推断时给 'en'。
   */
  vocalLanguage?: string
  /** AI 重编贴近度（仅 ai_cover，0–1）：越大越贴近原结构，缺省 0.7 */
  coverStrength?: number
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
  midi_to_audio: 'MIDI 渲染为音频（忠实）',
  ai_cover: 'AI 重编（保结构再创作）',
  audio_with_stems: '生成整首音频 + 分轨',
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

/**
 * 「AI 重编」类说法（只用于意图提示 + 外部后端兜底）：
 * 用户说「用 AI 渲染 / AI 重编 / 换编制 / 重新配器 / 别只是 MIDI 转音频」时，
 * 他要的是模型参与再创作，不是采样器忠实导出。
 */
const COVER_INTENT_RE =
  /(ai\s*重编|ai\s*cover|重编成|换编制|重新配器|换音色|用\s*ai.{0,10}(重编|重新编曲|配器|渲染|做成|发挥)|让\s*ai\s*发挥|别只是.{0,6}midi|不是.{0,6}midi.{0,6}(转|变))/i

/** 用户这句话是否明确要求「音频」而不是「MIDI 编曲」 */
export function detectAudioIntent(text: string): boolean {
  const source = text.trim()
  if (!source) return false
  if (COVER_INTENT_RE.test(source)) return true
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
  /* 兜底识别「要人声」：用户说「人声/带唱/主唱/vocal」时不能按纯乐器生成，
     否则整曲没人声、人声分轨只能拆出噪声（本轮缺陷的根因链路）。 */
  const wantsVocal = /人声|带唱|主唱|演唱|清唱|vocal|唱/i.test(source)
  const vocalFlag = wantsVocal ? { instrumental: false } : {}
  if (stems) {
    return { mode: 'audio_with_stems', caption: source.slice(0, 600), stems, ...vocalFlag, reason: '按你的描述识别为「整曲 + 分轨」' }
  }
  if (COVER_INTENT_RE.test(source)) {
    // cover 的 caption 走英文文本编码器：中文原文没法直接用，给一句通用英文重编描述兜底
    const caption = /[A-Za-z]{3}/.test(source)
      ? source.slice(0, 600)
      : 're-orchestrate the current arrangement into a fuller, more polished production with richer instrumentation and a modern mix'
    return { mode: 'ai_cover', caption, reason: '识别为「AI 重编」：保留编曲骨架，交给 AI 重新配器' }
  }
  if (/(midi|工程|编曲|伴奏|这段|这首|当前).{0,14}(渲染|导出|转成|变成|做成|输出)|渲染成音频|导出成音频/i.test(source)) {
    return { mode: 'midi_to_audio', reason: '工程里已有素材，识别为「忠实渲染为音频」' }
  }
  return { mode: 'text_to_audio', caption: source.slice(0, 600), ...vocalFlag, reason: '识别为「文本 → 音频」' }
}

/**
 * 分轨计划护栏（纯函数，返回决策而不是抛错）：
 *
 * extract 只能「分离源音频里已经存在的东西」。整曲若是按纯乐器（`instrumental: true`）
 * 生成的，源里根本没有人声，抽 vocals 的结果是噪声（实测 DC +0.64、99.7% 能量是直流）。
 * 与其静默产出一条「名字叫人声、实际是噪音」的轨，不如把这一臂从计划里去掉，
 * 并把原因明确告诉用户 —— 整曲与其它分轨照常执行，任务不中断。
 *
 * 注意 `instrumental` 缺省也为「纯乐器」：计划里没写这个字段时，Companion 仍会发
 * `[Instrumental]`（旧行为），所以源音频确实不含人声。这里与「原始分轨 API 的来源未知
 * 就不拦」不同 —— 计划层是**已知**的，因为整曲正是本流程自己生成的。
 *
 * 返回 `{ stems, skipped }`；`skipped` 为空时行为与旧实现完全一致。
 */
export function resolveStemPlan(input: { stems: StemArm[]; instrumental?: boolean }): {
  stems: StemArm[]
  skipped: Array<{ arm: StemArm; reason: string }>
} {
  const stems = Array.isArray(input.stems) ? input.stems : []
  // 缺省（undefined）= 纯乐器 = 旧行为；只有显式 false 才算「这次生成含人声」
  if (input.instrumental === false) return { stems, skipped: [] }
  const skipped: Array<{ arm: StemArm; reason: string }> = []
  const kept = stems.filter((arm) => {
    if (arm !== 'vocals') return true
    skipped.push({
      arm,
      reason:
        '整曲是按「纯乐器（无人声）」生成的，里面本来就没有人声，硬拆人声只会得到噪声，已跳过「人声」分轨。' +
        '要人声分轨，请重新生成整曲并勾选「要人声」（或描述里写明「要人声/带唱」）后再分轨。',
    })
    return false
  })
  return { stems: kept, skipped }
}

/* ------------------------------------------------------------------ */
/* 工具返回值 → 音频计划                                                */
/* ------------------------------------------------------------------ */

function isAudioMode(value: unknown): value is AudioMode {
  return value === 'text_to_audio' || value === 'midi_to_audio' || value === 'ai_cover' || value === 'audio_with_stems'
}

/** 本工程调式 id → 引擎 keyscale 里的英文调式名 */
const SCALE_LABEL: Record<string, string> = {
  major: 'major',
  minor: 'minor',
  harmonicMinor: 'harmonic minor',
  melodicMinor: 'melodic minor',
  dorian: 'dorian',
  phrygian: 'phrygian',
  lydian: 'lydian',
  mixolydian: 'mixolydian',
  locrian: 'locrian',
  pentatonicMajor: 'major pentatonic',
  pentatonicMinor: 'minor pentatonic',
  blues: 'blues',
  wholeTone: 'whole tone',
  chromatic: 'chromatic',
}

/**
 * 调性字符串轻量归一化（纯函数）：`"c minor"` → `"C minor"`、`"C#minor"` → `"C# minor"`。
 * 只认「主音 + 调式」形状；乱码 / 过长返回 undefined（调用方回落到工程调性）。
 */
export function normalizeKeyscale(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const compact = value.trim().replace(/\s+/g, ' ')
  if (!compact || compact.length > 24) return undefined
  const matched = /^([A-Ga-g])([#b♯♭]?)\s*([A-Za-z]{2,12}(?:\s+[A-Za-z]{2,12})?)$/.exec(compact)
  if (!matched) return undefined
  const accidental = matched[2].replace('♯', '#').replace('♭', 'b')
  return `${matched[1].toUpperCase()}${accidental} ${matched[3].toLowerCase()}`
}

/**
 * 工程 key/scale → 引擎 keyscale（纯函数）。
 * 计划里没有调性时按这条兜底，保证「引擎的调 = DAW 工程的调」。
 */
export function keyscaleFromProject(project?: { key?: string; scale?: string }): string | undefined {
  const key = typeof project?.key === 'string' ? project.key.trim() : ''
  if (!key) return undefined
  const scale = typeof project?.scale === 'string' ? project.scale.trim() : ''
  return normalizeKeyscale(`${key} ${SCALE_LABEL[scale] ?? (scale || 'major')}`)
}

/** 工程拍号 → 引擎 timesignature（分子字符串，如 "4"；引擎不认 "4/4"） */
export function timesignatureFromProject(project?: { timeSignature?: { numerator?: number } }): string | undefined {
  const numerator = Number(project?.timeSignature?.numerator)
  if (!Number.isInteger(numerator) || numerator < 1 || numerator > 16) return undefined
  return String(numerator)
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
    // 调性：归一化后不合形状（乱码 / 超长）就当没给，由执行阶段回落到工程调性
    keyscale: normalizeKeyscale(value.keyscale),
    timesignature: /^\d{1,2}$/.test(String(value.timesignature ?? '')) ? String(value.timesignature) : undefined,
    durationSec: toNumber(value.durationSec),
    style: typeof value.style === 'string' ? value.style.slice(0, 80) : undefined,
    stems: stems && stems.length ? stems : undefined,
    // 只有显式 false 才是「要人声」；缺省/非法值一律按纯乐器（= 旧行为，绝不误开人声）
    instrumental: value.instrumental === false ? false : undefined,
    // 演唱语言：小写归一化，非法/空值当没给（由 Companion 按 caption 推断）
    vocalLanguage: /^[a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{2,8})*$/.test(String(value.vocalLanguage ?? ''))
      ? String(value.vocalLanguage).trim().toLowerCase().replace(/_/g, '-')
      : undefined,
    startBeat: toNumber(value.startBeat),
    trackName: typeof value.trackName === 'string' ? value.trackName.slice(0, 60) : undefined,
    quality: value.quality === true,
    // AI 重编贴近度：clamp 到 0–1，非法值当没给（执行阶段用 0.7 兜底）
    coverStrength: (() => {
      const parsed = toNumber(value.coverStrength)
      return parsed === undefined ? undefined : Math.min(1, Math.max(0, parsed))
    })(),
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
  | {
      ok: false
      reason: 'start-companion'
      message: string
      hint: string
      /** P15：本机节点能否被一键拉起（旧服务端没有该接口时为 undefined） */
      node?: CompanionNodeStatus
    }

/**
 * P15：确保有在线生成节点 —— 没有就请服务端把本机节点拉起来。
 *
 * 返回 true 表示「真的能派单」。任何异常都降级为 false（旧服务端没有该接口、
 * 部署形态不支持自动启动等），调用方继续走原有的「复制启动命令」路径。
 */
export async function ensureCompanionOnline(waitMs?: number): Promise<boolean> {
  try {
    const status = await getCompanionStatus()
    if (status.online && (status.summary?.workers ?? 0) > 0) return true
  } catch {
    /* 服务端不可达：下面的启动请求同样会失败，按不可用处理 */
  }
  try {
    const result = await startCompanionNode(waitMs === undefined ? {} : { waitMs })
    return result.online === true
  } catch {
    return false
  }
}

/** P15：读取本机节点状态（旧服务端 404 时返回 null，界面据此隐藏一键启动） */
export async function loadCompanionNode(): Promise<CompanionNodeStatus | null> {
  try {
    return await getCompanionNode()
  } catch {
    return null
  }
}

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
  // 模型已就绪：单机形态直接请服务端拉起本机节点（这正是「等再久也不动」的根因）
  const lifted = await ensureCompanionOnline()
  if (lifted) return { ok: true }
  const node = await loadCompanionNode()
  return {
    ok: false,
    reason: 'start-companion',
    message: node?.reason
      ? `本机模型已安装，但生成节点（Companion）没能启动：${node.reason}`
      : '本机模型已安装，但生成节点（Companion）未启动。',
    // 服务端返回的启动命令已带真实地址；没有时按当前 origin 兜底
    hint: node?.command || resolveCompanionHint(),
    node: node ?? undefined,
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

async function waitCompanionTask(
  jobId: string,
  stepKey: string,
  taskId: string,
  mapProgress: (progress: number) => number = (progress) => progress,
): Promise<string> {
  for (;;) {
    assertActive(jobId)
    const { task } = await getCompanionTask(taskId)
    const stepStatus = STATUS_TO_STEP[task.status]
    const queued = task.status === 'queued'
    useAudioJobStore.getState().updateStep(stepKey, {
      status: stepStatus,
      progress: task.status === 'done' ? 1 : mapProgress(clamp(task.progress ?? 0, 0, 1)),
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
  options: {
    name: string
    trackName: string
    startBeat: number
    caption: string
    bpm: number
    durationSec?: number
    /** 落轨后整轨静音（分轨用：避免整曲 + 所有 stem 同时可闻 → 叠加削顶） */
    muted?: boolean
    /**
     * 分轨增益预算：给了就按实测峰值算推子音量（见 `stemPlacementVolume`）。
     * 整曲 / 渲染等不给 = 沿用 0.8 的旧行为。
     */
    stemGain?: { stemCount: number; songPeak: number }
  },
): Promise<{ trackId: string; clipId: string; durationSec: number; startBeat: number; peak: number }> {
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
  // 真实时长只认资产峰值：extract 会锁源时长，写死 30s 会让 stem 片段长度错位
  const realDurationSec = peaks.durationSec
  // 实测峰值：引擎对每个输出文件独立峰值归一化，所以这个值 ≈1.0，是「不削顶」预算的依据
  const peak = assetPeakFromPeaks(peaks.peaks)
  const asset = assetRefFromPeaks(assetId, peaks, { name: `${options.name}.wav` })
  const store = useStore.getState()
  const trackName = slot?.name || options.trackName
  const placedRef: { value: { trackId: string; clipId: string } | null } = { value: null }
  store.mutate((draft) => {
    placedRef.value = placeAudioClip(draft, {
      asset,
      durationSec: realDurationSec,
      name: options.name,
      startBeat: options.startBeat,
      trackName,
      color: slot?.color,
      // 分轨按实测峰值推导的预算音量落轨；其余场景 undefined → placeAudioClip 用 0.8
      volume: options.stemGain
        ? stemPlacementVolume({
            stemPeak: peak,
            stemCount: options.stemGain.stemCount,
            songPeak: options.stemGain.songPeak,
          })
        : undefined,
      provenance: generatedAudioProvenance({
        caption: options.caption,
        bpm: options.bpm,
        durationSec: options.durationSec ?? Math.round(realDurationSec),
      }),
    })
    // 轨道级静音（M 按钮/混音台都读它），同一个 mutate 内完成 → 只有一个撤销点
    if (options.muted && placedRef.value) {
      const placedTrack = draft.tracks.find((track) => track.id === placedRef.value?.trackId)
      if (placedTrack) placedTrack.mute = true
    }
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
  return { ...placed, durationSec: realDurationSec, startBeat: options.startBeat, peak }
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
      sampleRate: 48000,
      bitDepth: 24,
      loudnessTargetLufs: -14,
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
    /* 渲染的是整工程、从 0 拍开始，落轨也必须是 0；
       旧实现落轨用 playhead，播放头不在 0 时整首歌会整体后移（已修）。 */
    const startBeat = 0
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

/**
 * AI 重编（cover）：先把当前工程离线渲染成参考音频 → 上传资产 →
 * 交给 Companion 的 cover_audio（保结构换编制）→ 落一条新音频轨。
 *
 * 与 `runMidiRender` 的区别是这个函数**会启动 AI 引擎**：
 * - 参考音频只是条件输入，产物由模型重新生成（会改细节、不保证逐音对齐）；
 * - 参考音频是整工程从 0 拍渲染的，产物固定落 0 拍；
 * - 进度按「渲染 0–15% / 模型 15–100%」加权，避免任务卡一开始就跳到 50%。
 */
async function runCoverFlow(jobId: string, plan: AudioPlan, bpm: number) {
  const store = useStore.getState()
  const project = store.project
  const hasContent = project.tracks.some((track) => track.clips.length > 0 || track.audioClips.length > 0)
  if (!hasContent) {
    fail(jobId, '工程还是空的：先编一段 MIDI，再让 AI 重编。', { blockReason: 'empty-project' })
    return
  }
  const caption = (plan.caption ?? '').trim()
  if (!caption) {
    fail(jobId, 'AI 重编需要一句英文描述（希望重编成什么风格 / 编制）。')
    return
  }
  const stepKey = 'cover'
  const RENDER_SHARE = 0.15
  const baseName = (plan.trackName || project.name || 'AI 重编').slice(0, 40)
  useAudioJobStore.getState().updateStep(stepKey, { status: 'running', progress: 0, startedAt: Date.now() })
  useAudioJobStore.getState().update({
    telemetry: { phase: 'prepare', phaseLabel: '准备渲染参考音频', engine: { state: 'ready', device: '浏览器离线渲染（AI 源）' } },
  })
  try {
    const engine = getAudioEngine()
    const blob = await engine.renderToWav(project, {
      sampleRate: 48000,
      bitDepth: 24,
      loudnessTargetLufs: -14,
      onProgress: (ratio) => {
        if (canceledJobs.has(jobId)) return
        useAudioJobStore.getState().updateStep(stepKey, { progress: clamp(ratio, 0, 1) * RENDER_SHARE, status: 'running' })
        useAudioJobStore.getState().update({
          telemetry: { phase: 'render', phaseLabel: '渲染参考音频（AI 源）', engine: { state: 'ready', device: '浏览器离线渲染' } },
        })
      },
    })
    assertActive(jobId)
    useAudioJobStore.getState().updateStep(stepKey, { progress: RENDER_SHARE, status: 'running' })
    useAudioJobStore.getState().update({
      // 仍停留在「渲染参考」阶段：这里上传的是 AI 的输入，不是产物写入
      telemetry: { phase: 'prepare', phaseLabel: '上传参考音频', engine: { state: 'ready', device: '浏览器离线渲染' } },
    })
    const file = new File([blob], `${baseName}-cover-source.wav`, { type: 'audio/wav' })
    const uploaded = await uploadAudioAsset(file)
    assertActive(jobId)
    const created = await createCompanionCoverTask(
      {
        sourceAssetId: uploaded.asset.id,
        caption,
        audioCoverStrength: plan.coverStrength ?? 0.7,
        engine: plan.engine,
      },
      project.id,
      plan.priority ?? 0,
    )
    assertActive(jobId)
    useAudioJobStore.getState().update({ taskId: created.taskId })
    const assetId = await waitCompanionTask(jobId, stepKey, created.taskId, (progress) => RENDER_SHARE + progress * (1 - RENDER_SHARE))
    const slot = useAudioJobStore.getState().slots.find((item) => item.key === stepKey)
    const trackName = slot?.name ?? `AI 重编 · ${baseName}`
    await placeGeneratedAsset(jobId, stepKey, assetId, {
      name: baseName,
      trackName,
      // 参考音频是整工程从 0 拍渲染的，产物必须落 0 拍（否则整首后移）
      startBeat: 0,
      caption,
      bpm,
    })
    useAudioJobStore.getState().updateStep(stepKey, { status: 'done', progress: 1 })
    useAudioJobStore.getState().finish('done')
    useStore
      .getState()
      .pushToast('success', `AI 重编完成：${trackName}（AI 会改细节，不是逐音还原；原 MIDI 未改动，⌘Z 可撤销）`)
  } catch (error) {
    if (error instanceof JobCanceledError) {
      useAudioJobStore.getState().updateStep(stepKey, { status: 'canceled' })
      useAudioJobStore.getState().finish('canceled')
      return
    }
    fail(jobId, error instanceof Error ? error.message : 'AI 重编失败')
  }
}

/** 文本 → 音频（可带分轨） */
async function runCompanionFlow(
  jobId: string,
  plan: AudioPlan,
  stems: StemArm[],
  bpm: number,
  durationSec: number,
  skippedStems: Array<{ arm: StemArm; reason: string }> = [],
) {
  const store = useStore.getState()
  const projectId = store.project.id
  const startBeat = Math.max(0, plan.startBeat ?? store.playhead)
  const fallbackKind = plan.instrumental === false ? 'song with vocals' : 'instrumental'
  const caption = (plan.caption ?? '').trim() || `${plan.style ?? ''} ${fallbackKind}, ${bpm} bpm`.trim()
  const priority = plan.priority ?? 0
  /**
   * 调性/拍号必须下传到引擎：计划带来了就用计划的，否则按当前工程的 key/scale 兜底。
   * 「C minor 的工程按 C major 生成」就是这里漏传造成的 —— 引擎只会用它收到的 keyscale。
   */
  const keyscale = normalizeKeyscale(plan.keyscale) ?? keyscaleFromProject(store.project)
  const timesignature = plan.timesignature ?? timesignatureFromProject(store.project)
  try {
    const songStep = 'song'
    useAudioJobStore.getState().updateStep(songStep, { status: 'running', progress: 0 })
    const created = await createCompanionGenerateTask(
      {
        caption,
        bpm,
        keyscale,
        timesignature,
        durationSec,
        style: plan.style,
        quality: plan.quality || undefined,
        /* P9：AI 可指定引擎量级；缺省不传 = 服务端按 2b */
        engine: plan.engine,
        /* 要人声时必须下传：Companion 据此把歌词条件从 [Instrumental] 换成空串（LM 写歌词） */
        instrumental: plan.instrumental,
        /* 演唱语言（可选）：只对「要人声」有意义，缺省由 Companion 按 caption 推断 */
        vocalLanguage: plan.vocalLanguage,
      },
      projectId,
      priority,
    )
    assertActive(jobId)
    useAudioJobStore.getState().update({ taskId: created.taskId })
    const songAssetId = await waitCompanionTask(jobId, songStep, created.taskId)
    const songName = plan.trackName || caption.slice(0, 32) || 'AI 生成音频'
    const songPlacement = await placeGeneratedAsset(jobId, songStep, songAssetId, {
      name: songName,
      trackName: `生成 · ${songName.slice(0, 20)}`,
      startBeat,
      caption,
      bpm,
    })
    useAudioJobStore.getState().updateStep(songStep, { status: 'done', progress: 1 })

    /**
     * 分轨激励预算：整曲的**有效峰值**（资产原始峰值 × 整曲轨推子）。
     * 分轨叠加只要不超过它，就不会比整曲更响、也不会削顶。
     */
    const songTrackVolume =
      useStore.getState().project.tracks.find((track) => track.id === songPlacement.trackId)?.volume ?? 0.8
    const songPeak = songPlacement.peak * songTrackVolume

    /* 分轨：extract（从整曲里分离该乐器）。不能再把整曲 caption 拼进去 ——
       整曲描述会让模型「重新生成一首歌」而不是分离；caption 交给 Companion 的
       每 arm 隔离描述（"Isolated electric guitar stem…"），这里只补风格关键词。 */
    const styleHint = (plan.style ?? '').trim()
    for (const arm of stems) {
      const key = `stem:${arm}`
      useAudioJobStore.getState().updateStep(key, { status: 'running', progress: 0 })
      const stemTask = await createCompanionStemTask(
        {
          sourceAssetId: songAssetId,
          arm,
          caption: styleHint || undefined,
          engine: plan.engine,
          /* 把「源是否含人声」这个已知事实一起下发（未知就不传，Companion 不拦）：
             计划里 instrumental 缺省 = 纯乐器，人声臂已在 resolveStemPlan 里被去掉。 */
          sourceInstrumental: plan.instrumental === false ? false : true,
        },
        projectId,
        priority,
      )
      assertActive(jobId)
      useAudioJobStore.getState().update({ taskId: stemTask.taskId })
      const stemAssetId = await waitCompanionTask(jobId, key, stemTask.taskId)
      // 落轨时长只认资产真实峰值（extract 锁源时长），不再用整曲的预估值
      await placeGeneratedAsset(jobId, key, stemAssetId, {
        name: `Stem · ${STEM_ARM_LABEL[arm]}`,
        trackName: `Stem · ${STEM_ARM_LABEL[arm]}`,
        startBeat: songPlacement.startBeat,
        caption: `Extract ${arm} stem from: ${songName}`,
        bpm,
        // 分轨默认静音：整曲 + 全部 stem 同时可闻会叠加削顶（实测 peak≈1.84）
        muted: true,
        /* 按实测峰值把 N 条分轨的叠加预算等分 → 全部解开静音也不会爆表 */
        stemGain: { stemCount: stems.length, songPeak },
      })
      useAudioJobStore.getState().updateStep(key, { status: 'done', progress: 1 })
    }

    useAudioJobStore.getState().finish('done')
    /* 被护栏跳过的臂必须让用户看见原因：静默少一条轨比报错更让人困惑 */
    for (const item of skippedStems) useStore.getState().pushToast('info', item.reason)
    useStore
      .getState()
      .pushToast(
        'success',
        stems.length === 0
          ? `音频已生成并加入工程：${songName}（⌘Z 可撤销）`
          : skippedStems.length
            ? `音频生成完成：1 条整曲 + ${stems.length} 条分轨（「${skippedStems
                .map((item) => STEM_ARM_LABEL[item.arm])
                .join('/')}」因源音频不含人声已跳过）；分轨已默认静音，点 M/S 可单独试听。分轨是分别重合成的，不是原曲的严格分解，叠加不会与原曲完全对齐`
            : `音频生成完成：1 条整曲 + ${stems.length} 条分轨；分轨已默认静音，点 M/S 可单独试听（每条轨可单独撤销）。分轨是模型按乐器分别重合成的，不是原曲的严格分解，叠加不会与原曲完全对齐`,
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
  // 忠实渲染不跑模型：外部后端 / 旧计划若硬塞 engine/quality，剥掉并明确告知，绝不让它"看起来生效"
  let effectivePlan: AudioPlan = plan
  if (plan.mode === 'midi_to_audio' && (plan.engine || plan.quality)) {
    effectivePlan = { ...plan, engine: undefined, quality: undefined }
    useStore.getState().pushToast('info', '忠实渲染不使用 AI 引擎 / 精修参数，已忽略')
  } else if (plan.mode === 'ai_cover' && plan.quality) {
    // cover 固定 8 步快模式；sft 精修尚未开放，静默当没看见会让任务卡参数说谎
    effectivePlan = { ...plan, quality: undefined }
    useStore.getState().pushToast('info', 'AI 重编固定 8 步，精修参数已忽略（要更高质量请选 XL 引擎）')
  }
  lastPlan = effectivePlan
  const mode: AudioMode = effectivePlan.mode
  const project = useStore.getState().project
  const bpm = Number.isFinite(effectivePlan.bpm)
    ? Math.round(clamp(Number(effectivePlan.bpm), 20, 320))
    : Math.round(project.tempo)
  const needsStems = mode === 'audio_with_stems'
  const isRenderMode = mode === 'midi_to_audio'
  const isCoverMode = mode === 'ai_cover'
  if (isCoverMode && !(effectivePlan.caption ?? '').trim()) {
    useStore.getState().pushToast('error', 'AI 重编需要一句英文描述（希望重编成什么风格 / 编制）')
    return
  }
  const requestedStems: StemArm[] = needsStems
    ? effectivePlan.stems?.length
      ? effectivePlan.stems
      : ['guitar', 'bass', 'drums']
    : []
  /* 分轨护栏：纯乐器整曲不拆人声（源里没人声，只能拆出噪声）。
     去掉的臂连占位轨都不建，避免用户看到一条空的「Stem · 人声」轨。 */
  const stemPlan = resolveStemPlan({ stems: requestedStems, instrumental: effectivePlan.instrumental })
  const stems = stemPlan.stems
  const skippedStems = stemPlan.skipped
  const durationSec = Number.isFinite(effectivePlan.durationSec)
    ? Math.round(clamp(Number(effectivePlan.durationSec), 5, 300))
    : needsStems
      ? 45
      : 30
  const title = effectivePlan.trackName || MODE_TITLE[mode]

  const stepDefs = isRenderMode
    ? [{ key: 'render', label: '离线渲染当前工程 → WAV（忠实，采样器）' }]
    : isCoverMode
      ? [{ key: 'cover', label: '渲染参考音频 → AI 重编（cover）' }]
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
  const startBeat = Math.max(0, effectivePlan.startBeat ?? useStore.getState().playhead)
  // 兜底 caption 不能说 "instrumental"：要人声时那会与歌词条件自相矛盾
  const fallbackKind = effectivePlan.instrumental === false ? 'song with vocals' : 'instrumental'
  const caption = (effectivePlan.caption ?? '').trim() || `${effectivePlan.style ?? ''} ${fallbackKind}, ${bpm} bpm`.trim()
  const songName = effectivePlan.trackName || caption.slice(0, 32) || 'AI 生成音频'
  const renderBaseName = (effectivePlan.trackName || project.name || 'AI 渲染').slice(0, 40)
  const coverBaseName = (effectivePlan.trackName || project.name || 'AI 重编').slice(0, 40)
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
          // 渲染的是整工程、从 0 拍开始：占位轨也必须在 0 拍，不能跟播放头
          startBeat: 0,
          durationSec: projectDurationSec,
        },
      ]
    : isCoverMode
      ? [
          {
            key: 'cover',
            name: `AI 重编 · ${coverBaseName}`,
            label: 'AI 重编',
            role: 'cover',
            color: colorAt(0),
            // 参考音频是整工程从 0 拍渲染的，产物固定落 0 拍
            startBeat: 0,
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
    caption: effectivePlan.caption ?? '',
    steps: stepDefs,
    slots: slotSpecs,
  })
  // 立刻把视线带到编曲视图：用户能先看到「轨道已建好、AI 正在生成」
  useStore.getState().setView('arrangement')
  useStore.getState().pushToast('info', `AI 已安排音频任务：${MODE_TITLE[mode]}`)

  if (isRenderMode) {
    await runMidiRender(jobId, effectivePlan)
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

  if (isCoverMode) {
    await runCoverFlow(jobId, effectivePlan, bpm)
    return
  }

  await runCompanionFlow(jobId, effectivePlan, stems, bpm, durationSec, skippedStems)
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
