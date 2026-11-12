import { variantDisplayName } from '@aiab/core'
import type { AppSettings, AssetRef, MasterChain, MixPlan, Project, TrackChainSuggestion } from '@aiab/core'

/* ------------------------------------------------------------------ */
/* 通用请求                                                            */
/* ------------------------------------------------------------------ */

export class ApiError extends Error {
  status: number
  detail?: string
  /**
   * 服务端错误响应体（成功 JSON.parse 时才有）。
   * P11：安装接口在已有任务时返回 409 { error, jobId, job }，UI 靠它自动接管进行中的任务。
   */
  data?: unknown
  constructor(status: number, message: string, detail?: string, data?: unknown) {
    super(message)
    this.status = status
    this.detail = detail
    this.data = data
  }
}

const BASE = ''

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  })
  if (!response.ok) {
    let detail = ''
    let data: unknown
    try {
      data = await response.json()
      const body = (data ?? {}) as { error?: unknown; message?: unknown }
      detail = typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : ''
    } catch {
      data = undefined
      detail = await response.text().catch(() => '')
    }
    throw new ApiError(response.status, detail || `请求失败（${response.status}）`, detail || undefined, data)
  }
  if (response.status === 204) return undefined as T
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) return (await response.json()) as T
  return (await response.text()) as unknown as T
}

/* ------------------------------------------------------------------ */
/* 健康检查 / 元信息                                                   */
/* ------------------------------------------------------------------ */

export interface HealthInfo {
  ok: boolean
  version: string
  node: string
  uptimeSec: number
  dataDir: string
  soundfonts: { name: string; url: string; size: number }[]
  ffmpeg: boolean
  agents: { backend: string; available: boolean; version?: string; path?: string }[]
}

export function getHealth(): Promise<HealthInfo> {
  return request<HealthInfo>('/api/health')
}

/* ------------------------------------------------------------------ */
/* 工程                                                               */
/* ------------------------------------------------------------------ */

export interface ProjectSummary {
  id: string
  name: string
  updatedAt: number
  createdAt: number
  trackCount: number
  tempo: number
}

export function listProjects(): Promise<ProjectSummary[]> {
  return request<ProjectSummary[]>('/api/projects')
}

export function getProject(id: string): Promise<Project> {
  return request<Project>(`/api/projects/${encodeURIComponent(id)}`)
}

export function saveProject(project: Project): Promise<{ ok: true; savedAt: number }> {
  return request<{ ok: true; savedAt: number }>(`/api/projects/${encodeURIComponent(project.id)}`, {
    method: 'PUT',
    body: JSON.stringify(project),
  })
}

export function deleteProject(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/* ------------------------------------------------------------------ */
/* 设置                                                               */
/* ------------------------------------------------------------------ */

export function getSettings(): Promise<AppSettings> {
  return request<AppSettings>('/api/settings')
}

export function saveSettings(settings: AppSettings): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/settings', { method: 'PUT', body: JSON.stringify(settings) })
}

export interface TestProviderResult {
  ok: boolean
  message: string
  latencyMs?: number
  models?: string[]
}

export function testProvider(providerId: string, settings: AppSettings): Promise<TestProviderResult> {
  return request<TestProviderResult>('/api/settings/test-provider', {
    method: 'POST',
    body: JSON.stringify({ providerId, settings }),
  })
}

/** 服务商返回的模型元数据（能拿到多少填多少） */
export interface ProviderModelInfo {
  id: string
  name?: string
  ownedBy?: string
  contextLength?: number
  maxOutput?: number
  tools?: boolean
  reasoning?: boolean
  free?: boolean
  description?: string
}

export interface ProviderModelsResult {
  models: string[]
  details?: Record<string, ProviderModelInfo>
  /** 未使用 API Key 拉取（部分网关的 /models 是公开的） */
  anonymous?: boolean
  warning?: string
}

/**
 * 拉取某个服务商的全部模型（含能力元数据）。
 * 支持填 Key 之前的公开预取（OpenCode Zen/Go、OpenRouter、Ollama 等）。
 */
export function fetchProviderModels(
  providerId: string,
  settings: AppSettings,
): Promise<ProviderModelsResult> {
  return request<ProviderModelsResult>('/api/settings/models', {
    method: 'POST',
    body: JSON.stringify({ settings, providerId }),
  })
}

/** 兼容旧调用：只取模型 id 列表 */
export async function listProviderModels(settings: AppSettings): Promise<{ models: string[] }> {
  const result = await fetchProviderModels(settings.activeProviderId, settings)
  return { models: result.models }
}

/* ------------------------------------------------------------------ */
/* AI 对话（SSE 流）                                                   */
/* ------------------------------------------------------------------ */

export interface ChatRequestPayload {
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[]
  project: Project
  /** 快捷任务：如 compose / arrange / melody / optimize */
  intent?: string
  attachments?: { melodyTrackId?: string; referenceClipId?: string }
}

export interface StreamHandlers {
  onEvent: (event: string, data: unknown) => void
  onError?: (error: Error) => void
  onClose?: () => void
  signal?: AbortSignal
}

/**
 * 以 SSE 方式消费 Agent 流。服务端使用 POST + text/event-stream。
 * 返回一个取消函数。
 */
export function streamChat(payload: ChatRequestPayload, handlers: StreamHandlers): () => void {
  const controller = new AbortController()
  const signal = payload && handlers.signal ? handlers.signal : controller.signal
  const abort = () => controller.abort()
  if (handlers.signal) handlers.signal.addEventListener('abort', abort, { once: true })

  ;(async () => {
    try {
      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(payload),
        signal,
      })
      if (!response.ok || !response.body) {
        let message = `AI 服务不可用（${response.status}）`
        try {
          const body = (await response.json()) as { error?: string }
          if (body.error) message = body.error
        } catch {
          /* ignore */
        }
        throw new Error(message)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let eventName = 'message'
      let dataLines: string[] = []

      const flush = () => {
        if (dataLines.length === 0) return
        const raw = dataLines.join('\n')
        dataLines = []
        try {
          handlers.onEvent(eventName, JSON.parse(raw))
        } catch {
          handlers.onEvent(eventName, raw)
        }
        eventName = 'message'
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index = buffer.indexOf('\n')
        while (index !== -1) {
          const line = buffer.slice(0, index).replace(/\r$/, '')
          buffer = buffer.slice(index + 1)
          if (line === '') {
            flush()
          } else if (line.startsWith('event:')) {
            eventName = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart())
          }
          index = buffer.indexOf('\n')
        }
      }
      flush()
      handlers.onClose?.()
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        handlers.onClose?.()
        return
      }
      handlers.onError?.(error as Error)
    }
  })()

  return () => controller.abort()
}

export function cancelChat(): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/ai/cancel', { method: 'POST', body: '{}' })
}

/* ------------------------------------------------------------------ */
/* 片段生成（无需 AI Key 的本地能力，服务端复用 core 生成器）           */
/* ------------------------------------------------------------------ */

export interface GenerateRequest {
  intent: 'compose' | 'arrange' | 'melody' | 'chords' | 'variation'
  project: Project
  options?: Record<string, unknown>
}

export function generate(payload: GenerateRequest): Promise<{ project: Project; summary: string }> {
  return request<{ project: Project; summary: string }>('/api/generate', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/* ------------------------------------------------------------------ */
/* Studio 创作入口（风格/用途向导、和弦进行灵感、MIDI 导入）             */
/* ------------------------------------------------------------------ */

/** GET /api/studio/presets 的风格卡片 */
export interface StudioStylePreset {
  id: string
  name: string
  nameEn: string
  description: string
  bpm: number
  tempoRange?: [number, number]
  scale?: string
  accent: string
  recommendedInstruments?: string[]
}

/** GET /api/studio/presets 的用途场景卡片 */
export interface StudioScenePreset {
  id: string
  name: string
  nameEn: string
  description: string
  styleId: string
  bpm: number
  key: string
  scale: string
  bars: number
  energy: number
  sectionNames?: string[]
}

export interface StudioPresets {
  styles: StudioStylePreset[]
  scenes: StudioScenePreset[]
}

export function getStudioPresets(): Promise<StudioPresets> {
  return request<StudioPresets>('/api/studio/presets')
}

export interface CreateStudioProjectPayload {
  style: string
  scene?: string
  bars?: number
  seed?: number
  name?: string
}

/** POST /api/studio/new：按风格 + 用途直接生成工程（服务端复用 core 生成器） */
export function createStudioProject(
  payload: CreateStudioProjectPayload,
): Promise<{ project: Project; scene?: string | null; summary?: string }> {
  return request<{ project: Project; scene?: string | null; summary?: string }>('/api/studio/new', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/** 和弦进行建议里的一个和弦（未解析成 ChordSpec 的原始形态） */
export interface ProgressionSuggestionChord {
  root: number
  quality: string
  beats: number
}

export interface ProgressionSuggestion {
  id: string
  roman: string[]
  chords: ProgressionSuggestionChord[]
  label: string
  description: string
  patternHint?: string
}

export interface ProgressionSuggestionsResult {
  suggestions: ProgressionSuggestion[]
  /** 服务端额外拼好的 8 小节版本（可选） */
  chained?: ProgressionSuggestionChord[]
  summary?: string
}

/** POST /api/suggest/progressions：按风格/调性给出可解释的和弦进行灵感 */
export function suggestProgressions(payload: {
  style: string
  key?: string
  scale?: string
  count?: number
  seed?: number
}): Promise<ProgressionSuggestionsResult> {
  return request<ProgressionSuggestionsResult>('/api/suggest/progressions', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/** 和弦进行补全结果（P7-C） */
export interface CompleteProgressionResult {
  id: string
  key: string
  scale: string
  style: string
  partial: string[]
  completion: string[]
  full: string[]
  chords: ProgressionSuggestionChord[]
  beatsPerChord: number
  cadence: string
  reasons: string[]
  targetLength: number
  summary?: string
}

/** POST /api/suggest/complete-progression：给不完整进行补全后半段（可解释） */
export function completeProgression(payload: {
  partial: string[]
  key?: string
  scale?: string
  style?: string
  targetLength?: number
  beatsPerChord?: number
}): Promise<CompleteProgressionResult> {
  return request<CompleteProgressionResult>('/api/suggest/complete-progression', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/**
 * POST /api/import/midi：上传 .mid 二进制并解析成工程。
 * 走 octet-stream（不包 FormData），与后端契约一致。
 */
export async function importMidiFile(bytes: ArrayBuffer): Promise<{ project: Project; summary?: string }> {
  const response = await fetch('/api/import/midi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  })
  if (!response.ok) {
    let detail = ''
    try {
      const body = (await response.json()) as { error?: string; message?: string }
      detail = body.error ?? body.message ?? ''
    } catch {
      detail = await response.text().catch(() => '')
    }
    throw new ApiError(response.status, detail || `MIDI 导入失败（${response.status}）`, detail || undefined)
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    return (await response.json()) as { project: Project; summary?: string }
  }
  throw new ApiError(response.status, 'MIDI 导入失败：服务端返回了非 JSON 内容')
}

/* ------------------------------------------------------------------ */
/* AI 混音（MIDI 域：只改轨道参数，可预览、可整批撤销）                  */
/* ------------------------------------------------------------------ */

/** POST /api/mix/suggest 的返回：方案 + 逐轨差异文本 + 一句话总结 */
export interface MixSuggestResult {
  plan: MixPlan
  /** 每轨一行的可读差异（音量/声像/混响），可直接展示 */
  preview: string[]
  summary: string
  /**
   * P3：逐轨音频处理链建议（EQ / 压缩 / 补偿增益）。
   * 服务端扩展后才有；旧服务端不返回时 UI 自动隐藏处理链相关区块。
   */
  chains?: TrackChainSuggestion[]
  /** P3：处理链整体说明（可选） */
  chainNotes?: string[]
  /** P3.2：总线 / 母带处理链建议（服务端扩展后才有） */
  masterChain?: MasterChain
  /** P3.2：总线链逐行摘要（可直接展示） */
  masterPreview?: string[]
  /** P3.2：总线链整体说明（可选） */
  masterNotes?: string[]
}

/**
 * POST /api/mix/suggest：按声部角色 × 风格 × 能量给出混音方案。
 * 只返回方案，不落库；应用由前端走 store（一条撤销记录）。
 */
export function suggestMix(project: Project): Promise<MixSuggestResult> {
  return request<MixSuggestResult>('/api/mix/suggest', {
    method: 'POST',
    body: JSON.stringify({ project }),
  })
}

/* ------------------------------------------------------------------ */
/* 导出                                                               */
/* ------------------------------------------------------------------ */

export function exportMidiFile(project: Project): Promise<Blob> {
  return fetch('/api/export/midi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project }),
  }).then(async (res) => {
    if (!res.ok) throw new ApiError(res.status, 'MIDI 导出失败')
    return res.blob()
  })
}

/** 服务端用 ffmpeg 转码（wav/mp3/flac/ogg）。需要先上传客户端渲染好的 WAV。 */
export async function convertAudio(
  wavBlob: Blob,
  format: 'mp3' | 'flac' | 'ogg',
  options: { bitrate?: string; projectName?: string } = {},
): Promise<Blob> {
  const form = new FormData()
  form.append('file', wavBlob, 'render.wav')
  form.append('format', format)
  if (options.bitrate) form.append('bitrate', options.bitrate)
  if (options.projectName) form.append('name', options.projectName)
  const res = await fetch('/api/export/audio', { method: 'POST', body: form })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new ApiError(res.status, `音频转码失败：${detail || res.status}`)
  }
  return res.blob()
}

/* ------------------------------------------------------------------ */
/* 音色库                                                             */
/* ------------------------------------------------------------------ */

export interface SoundfontInfo {
  name: string
  url: string
  size: number
  license?: string
}

export function listSoundfonts(): Promise<{ files: SoundfontInfo[]; bundled: boolean }> {
  return request<{ files: SoundfontInfo[]; bundled: boolean }>('/api/soundfonts')
}

export function downloadSoundfont(id: string): Promise<{ ok: boolean; message: string; url?: string }> {
  return request<{ ok: boolean; message: string; url?: string }>(`/api/soundfonts/${encodeURIComponent(id)}/download`, {
    method: 'POST',
  })
}

/* ------------------------------------------------------------------ */
/* 音频资产（导入 / 波形 / 播放）                                       */
/* ------------------------------------------------------------------ */

/** 从 fetch 响应里读出服务端错误文案（JSON 的 error/message，否则退回纯文本） */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; message?: string }
    return body.error ?? body.message ?? ''
  } catch {
    return await response.text().catch(() => '')
  }
}

/** POST /api/assets/upload（multipart，字段 file，WAV）的返回 */
export interface AudioUploadResult {
  asset: AssetRef
  durationSec: number
  sampleRate: number
  channels: number
  /** 波形峰值：[min,max] 交错，-1..1，默认 512 桶 */
  peaks: number[]
  summary: string
}

/** 上传 WAV：入库 + 服务端算好峰值。一次调用即可落轨（不用再拉 peaks）。 */
export async function uploadAudioAsset(file: File | Blob): Promise<AudioUploadResult> {
  const form = new FormData()
  const name = typeof File !== 'undefined' && file instanceof File ? file.name : 'audio.wav'
  form.append('file', file, name)
  const response = await fetch('/api/assets/upload', { method: 'POST', body: form })
  if (!response.ok) {
    const detail = await readErrorDetail(response)
    throw new ApiError(response.status, detail || `音频上传失败（${response.status}）`, detail || undefined)
  }
  return (await response.json()) as AudioUploadResult
}

/** GET /api/assets/:id/peaks 的返回 */
export interface AssetPeaksResult {
  id: string
  durationSec: number
  sampleRate: number
  channels: number
  peaks: number[]
}

export function getAssetPeaks(assetId: string): Promise<AssetPeaksResult> {
  return request<AssetPeaksResult>(`/api/assets/${encodeURIComponent(assetId)}/peaks`)
}

/** 资产的原始 WAV 地址：可直接给 <audio> / Tone.Player 播放 */
export function assetFileUrl(assetId: string): string {
  return `/api/assets/${encodeURIComponent(assetId)}/file`
}

/** GET /api/assets 的资产摘要（不含 peaks；sha256 在该接口里不返回） */
export interface AssetSummary {
  id: string
  kind: string
  bytes: number
  durationMs?: number
  sampleRate?: number
  channels?: number
  name?: string
  createdAt: number
  sha256?: string
}

export function listAssets(): Promise<{ count: number; assets: AssetSummary[] }> {
  return request<{ count: number; assets: AssetSummary[] }>('/api/assets')
}

/* ------------------------------------------------------------------ */
/* Companion（本地生成工作节点）                                        */
/* ------------------------------------------------------------------ */

export type CompanionTaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled'

/** 任务优先级：0 普通 / 1 高 / 2 紧急 */
export type CompanionPriority = 0 | 1 | 2

export const COMPANION_PRIORITY_LABEL: Record<CompanionPriority, string> = {
  0: '普通',
  1: '高',
  2: '紧急',
}

/**
 * P9：引擎量级（DiT 模型档）。
 * - '2b'：标准档（turbo / sft / base），显存占用低、速度快；
 * - 'xl'：XL 4B 档（xl_turbo / xl_sft / xl_base），最佳质量，需 ≥12GB 显存。
 * 任务参数缺省按 '2b'。XL 只在已装 xl 模型档、且生成节点上报 xl_turbo 能力时可用。
 */
export type CompanionEngine = '2b' | 'xl'

/** P9：引擎量级 → 界面中性名称（不暴露底层模型档位名） */
export const COMPANION_ENGINE_LABEL: Record<CompanionEngine, string> = {
  '2b': '标准档',
  xl: '增强版',
}

/** P9：内部变体 id → 界面中性名称（与 packages/core/src/branding.ts 保持一致） */
export const COMPANION_VARIANT_LABEL: Record<string, string> = {
  turbo: '快速生成模型',
  sft: '精修生成模型',
  base: '分轨生成模型',
  xl_turbo: '快速生成模型（增强版）',
  xl_sft: '精修生成模型（增强版）',
  xl_base: '分轨生成模型（增强版）',
}

/** 变体 id 的可读文案：未知变体走 branding 的兜底名（不回显内部 id） */
export function companionVariantLabel(variant: string | undefined): string {
  if (!variant) return ''
  return COMPANION_VARIANT_LABEL[variant] ?? variantDisplayName(variant)
}

export interface CompanionTaskState {
  id: string
  /** 任务类型（服务端返回，旧版可能没有） */
  type?: string
  status: CompanionTaskStatus
  /** 0..1 */
  progress: number
  /** 0 普通 / 1 高 / 2 紧急（旧服务端可能没有） */
  priority?: CompanionPriority | number
  /** 排队位置（1-based，有值时） */
  queuePosition?: number
  /** 预计等待秒数（有值时） */
  estimatedWaitSec?: number
  /** 该任务需要的工作节点能力（例如音频引擎变体） */
  requiredVariant?: string
  message?: string
  error?: string
  /** 完成后的音频资产 id */
  assetId?: string
  createdAt?: number
  startedAt?: number
  finishedAt?: number
}

export interface CompanionSummary {
  workers: number
  queued: number
  running: number
  done: number
  failed: number
}

/** 按优先级分组的排队数（旧服务端可能没有，做兜底） */
export interface CompanionQueueSummary {
  normal: number
  high: number
  urgent: number
}

/** 因缺少某类工作节点能力而无法执行的任务 */
export interface CompanionBlockedCapability {
  variant: string
  count: number
}

/** GET /api/companion/status：**没有 Companion 时也是 200 + online:false**（不是 404） */
export interface CompanionStatus {
  summary: CompanionSummary
  online: boolean
  /** 按优先级分组的排队数 */
  queue?: CompanionQueueSummary
  /** 缺能力被阻塞的任务 */
  blockedByCapability?: CompanionBlockedCapability[]
  workers: {
    id?: string
    name?: string
    busy?: boolean
    lastSeenAt?: number
    /** P9：节点上报的能力；capabilities.models 含 'xl_turbo' 表示支持 XL 变体（旧节点可能没有该字段） */
    capabilities?: { tasks?: string[]; gpu?: string; models?: string[] }
    engine?: unknown
  }[]
  tasks: CompanionTaskState[]
  /** 离线时的启动提示（服务端给出） */
  hint?: string
}

export function getCompanionStatus(): Promise<CompanionStatus> {
  return request<CompanionStatus>('/api/companion/status')
}

/* ---------------- P8：本机引擎自动安装 ---------------- */

/** P9：'xl' = XL 4B 最佳质量档（xl_turbo/xl_sft/xl_base + LM 4B，约 23.8GB，需 ≥12GB 显存） */
export type ProvisionProfileId = 'essential' | 'quality' | 'stems' | 'xl'

export interface ProvisionProfileInfo {
  id: ProvisionProfileId
  label: string
  files: string[]
  downloadBytes: number
  ready: boolean
}

export interface ProvisionModelStatus {
  /** 展示名（服务端不下发真实权重文件名） */
  displayName: string
  installed: boolean
  sizeBytes: number
  expectedBytes: number
  profiles: ProvisionProfileId[]
}

export interface ProvisionAdapterStatus {
  id: string
  name: string
  installed: boolean
  bytes: number
  expectedBytes: number
  style?: string
  license: string
}

/* ---------------- P10：下载加速（国内镜像 / 多源分片 / 服务器离线包） ---------------- */

/** 下载源策略：auto = 探测最快；mirror = 国内镜像优先（失败回落官方）；direct = 只用官方源 */
export type ProvisionSourceStrategy = 'auto' | 'mirror' | 'direct'

/**
 * 安装 / 训练下载配置（P10），字段对应服务端 `sources.ts` 的 `ProvisionDownloadConfig`
 * 与 settings.provision。服务端以 settings 为准；本类型用于请求体透传与状态展示
 * （全部可选，旧服务端没有也能渲染）。
 */
export interface ProvisionDownloadConfig {
  /** 源策略；服务端字段名为 strategy（设置里叫 sourceStrategy） */
  strategy?: ProvisionSourceStrategy
  /** HuggingFace 镜像：空 = 内置 https://hf-mirror.com，'off' = 关闭 */
  hfMirror?: string
  /** GitHub 加速前缀：空 = 内置 https://ghfast.top/，'off' = 关闭 */
  githubMirror?: string
  /** 运行时 / CUDA 镜像基础 URL：空 = 官方 + 服务器离线包 */
  runtimeMirror?: string
  /** 分片并发数：0/1 = 单连接，默认 4 */
  concurrency?: number
  /** 服务器助攻：优先用本机/服务器离线包与镜像 */
  serverAssist?: boolean
  /** 服务器镜像地址：空 = 只用本机离线包 */
  serverAssistUrl?: string
  /** 服务器镜像令牌（服务端开启 token 校验时使用） */
  serverAssistToken?: string
  /** 自动使用本机离线包 */
  useLocalPackage?: boolean
  /** 离线包目录：空 = 数据目录下 engine-package */
  packageDir?: string
  /** 源探测超时（毫秒，服务端可选字段） */
  probeTimeoutMs?: number
}

/** GET /api/provision/status 的 download 段：配置 + 本机离线包概况（旧服务端不返回该字段） */
export interface ProvisionDownloadInfo extends ProvisionDownloadConfig {
  /** 是否发现可用离线包（engine-package.json + 清单内文件） */
  packagePresent?: boolean
  /** 离线包内文件数 */
  packageFiles?: number
  /** 离线包总字节数 */
  packageBytes?: number
  /** 服务端解析后的离线包目录（settings.packageDir 为空时是 <dataDir>/engine-package） */
  packagePath?: string
  /** 离线包构建平台（如 win32-x64，可选） */
  packagePlatform?: string
}

export interface ProvisionStatus {
  platform: string
  supported: boolean
  error?: string
  root?: string
  dataDir?: string
/** P10：下载加速配置与本机离线包概况（旧服务端不返回，UI 按可选处理） */
  download?: ProvisionDownloadInfo
  runtime: { installed: boolean; sizeBytes: number; version?: string }
  models: ProvisionModelStatus[]
  adapters: ProvisionAdapterStatus[]
  profiles: ProvisionProfileInfo[]
  missingBytes: number
  notes: string[]
  /**
   * P11：最近安装任务（服务端返回前 3 条，按开始时间倒序；旧服务端可能没有）。
   * 前端状态恢复优先用 getProvisionJobs()，接口不可用时用它兜底。
   */
  jobs?: ProvisionJob[]
}

export interface ProvisionJobStep {
  key: string
  label: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  progress: number
  bytes?: number
  totalBytes?: number
  message?: string
}

export interface ProvisionJob {
  id: string
  status: 'running' | 'done' | 'failed' | 'canceled'
  profiles: ProvisionProfileId[]
  steps: ProvisionJobStep[]
  progress: number
  startedAt: number
  updatedAt: number
  error?: string
}

/** GET /api/provision/status：本机引擎/模型安装状态 */
export function getProvisionStatus(): Promise<ProvisionStatus> {
  return request<ProvisionStatus>('/api/provision/status')
}

/** POST /api/provision/install：开始自动下载（服务端执行） */
export function startProvisionInstall(
  profiles: ProvisionProfileId[],
  options: { adapters?: boolean; download?: ProvisionDownloadConfig } = {},
): Promise<{ jobId: string; job: ProvisionJob }> {
  const body: Record<string, unknown> = {
    profiles,
    adapters: options.adapters !== false,
  }
  /* P10：下载配置以服务端 settings 为准，这里透传一份（旧服务端忽略未知字段） */
  if (options.download) body.download = options.download
  return request<{ jobId: string; job: ProvisionJob }>('/api/provision/install', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function getProvisionJob(jobId: string): Promise<{ job: ProvisionJob }> {
  return request<{ job: ProvisionJob }>(`/api/provision/jobs/${encodeURIComponent(jobId)}`)
}

/**
 * P11：最近安装任务（GET /api/provision/jobs，按开始时间倒序）。
 * 刷新/重开面板时用它找回进行中的任务并续轮询；旧服务端没有该接口时调用方应兜底 status.jobs。
 */
export function getProvisionJobs(): Promise<{ jobs: ProvisionJob[] }> {
  return request<{ jobs: ProvisionJob[] }>('/api/provision/jobs')
}

export function cancelProvisionJob(jobId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/provision/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' })
}

/* ---------------- P10：下载源探测 / 服务器离线包 ---------------- */

/** 单条下载源探测结果（对应服务端 sources.ts 的 SourceProbeEntry；字段全部按可选处理） */
export interface ProvisionSourceProbe {
  label: string
  url?: string
  ok?: boolean
  latencyMs?: number
  /** 失败原因（服务端 field: error） */
  error?: string
  /** 失败原因 / 补充说明（兼容部分服务端字段） */
  detail?: string
  /** 源类型：official / mirror / server … */
  kind?: string
}

export interface ProvisionSourcesResult {
  sources: ProvisionSourceProbe[]
  /** 当前生效的源策略（服务端可能放在 config.strategy 里，已归一化到这里） */
  strategy?: ProvisionSourceStrategy | string
  /** 探测时间（毫秒时间戳，可选） */
  probedAt?: number
  /** 探测整体失败的说明（服务端可能 200 + error 返回，不阻塞页面） */
  error?: string
}

/** 服务端 /api/provision/sources 的原始返回（route 用 results，部分实现可能用 sources，都兼容） */
interface RawProvisionSources {
  sources?: ProvisionSourceProbe[]
  results?: ProvisionSourceProbe[]
  strategy?: ProvisionSourceStrategy | string
  config?: { strategy?: ProvisionSourceStrategy | string }
  probedAt?: number
  error?: string
}

/**
 * GET /api/provision/sources?probe=1：当前下载源配置与（可选）各源探测延迟。
 * 服务端可能直接返回数组、`{ results: [...] }` 或 `{ sources: [...] }`，这里统一成对象。
 */
export async function getProvisionSources(
  options: { probe?: boolean } = {},
): Promise<ProvisionSourcesResult> {
  const raw = await request<RawProvisionSources | ProvisionSourceProbe[]>(
    `/api/provision/sources${options.probe ? '?probe=1' : ''}`,
  )
  if (Array.isArray(raw)) return { sources: raw }
  const sources = Array.isArray(raw?.sources)
    ? raw.sources
    : Array.isArray(raw?.results)
      ? raw.results
      : []
  return {
    sources,
    strategy: raw?.strategy ?? raw?.config?.strategy,
    probedAt: raw?.probedAt,
    error: raw?.error,
  }
}

/** 离线包内单个文件（对应 engine-package.json 的 files） */
export interface ProvisionPackageFile {
  key: string
  kind?: string
  file?: string
  size: number
  sha256?: string
}

export interface ProvisionPackageManifest {
  schema?: number
  createdAt?: string
  platform?: string
  label?: string
  files: ProvisionPackageFile[]
}

export type ProvisionPackageJobStatus = 'running' | 'done' | 'failed' | 'canceled'

/** 离线包构建任务（服务端内存态，由 UI 轮询） */
export interface ProvisionPackageJob {
  id: string
  status: ProvisionPackageJobStatus
  progress: number
  message?: string
  error?: string
  result?: {
    dir?: string
    files?: number
    bytes?: number
    copied?: number
    linked?: number
    warnings?: string[]
  }
  createdAt?: number
  startedAt?: number
  updatedAt?: number
}

export interface BuildProvisionPackageOptions {
  profiles?: ProvisionProfileId[]
  includeTraining?: boolean
  outDir?: string
}

/** POST /api/provision/package/build：把已装好的运行时/模型打成服务器离线包 */
export function buildProvisionPackage(
  options: BuildProvisionPackageOptions = {},
): Promise<{ jobId: string; job: ProvisionPackageJob }> {
  const payload: BuildProvisionPackageOptions = {
    profiles: options.profiles ?? ['essential'],
    includeTraining: options.includeTraining === true,
  }
  if (options.outDir) payload.outDir = options.outDir
  return request<{ jobId: string; job: ProvisionPackageJob }>('/api/provision/package/build', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function getProvisionPackageJob(jobId: string): Promise<{ job: ProvisionPackageJob }> {
  return request<{ job: ProvisionPackageJob }>(
    `/api/provision/package/jobs/${encodeURIComponent(jobId)}`,
  )
}

/* ---------------- P8-C：按需训练 ---------------- */

export type TrainingPhaseId = 'code' | 'datasets' | 'python' | 'checkpoints' | 'env'

export interface TrainingStatus {
  platform: string
  phases: Record<TrainingPhaseId, boolean>
  bytes: { code: number; datasets: number; checkpoints: number; python: number; env: number }
  missingBytes: number
  checkpointBytes: number
  datasetBytes: number
  datasets: { id: string; installed: boolean; size: number }[]
  venvPython: string | null
  notes: string[]
}

export interface TrainingJobStep {
  key: string
  label: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  progress: number
  message?: string
}

export interface TrainingJob {
  id: string
  kind: 'setup' | 'train'
  status: 'running' | 'done' | 'failed' | 'canceled'
  steps: TrainingJobStep[]
  progress: number
  tag?: string
  adapterId?: string
  error?: string
  startedAt: number
  updatedAt: number
  logTail?: string
}

export function getTrainingStatus(): Promise<TrainingStatus> {
  return request<TrainingStatus>('/api/training/status')
}

export function startTrainingSetup(): Promise<{ jobId: string; job: TrainingJob }> {
  return request<{ jobId: string; job: TrainingJob }>('/api/training/setup', {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export function startTrainingJob(params: {
  datasetId: string
  tag: string
  styleId?: string
  name?: string
  epochs?: number
  rank?: number
  device?: string
  precision?: string
}): Promise<{ jobId: string; job: TrainingJob }> {
  return request<{ jobId: string; job: TrainingJob }>('/api/training/train', {
    method: 'POST',
    body: JSON.stringify(params),
  })
}

export function getTrainingJob(jobId: string): Promise<{ job: TrainingJob }> {
  return request<{ job: TrainingJob }>(`/api/training/jobs/${encodeURIComponent(jobId)}`)
}

export function cancelTrainingJob(jobId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/training/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' })
}

/** POST /api/companion/tasks 的 generate_audio 参数 */
export interface GenerateAudioParams {
  /** 英文提示词：风格 / 乐器 / 情绪 / 速度 */
  caption: string
  bpm?: number
  keyscale?: string
  durationSec?: number
  seed?: number
  style?: string
  /** 来自 GET /api/adapters 的 nativeReady 列表 */
  adapterId?: string
  /** P7-A 质量模式：LM → sft 50 步（更慢；与 LoRA 适配器互斥） */
  quality?: boolean
  /** P9 引擎量级：'2b'（缺省）或 'xl'（需已装 XL 档 + 支持 XL 的节点） */
  engine?: CompanionEngine
}

/** 提交生成任务；无在线 Companion 时服务端返回 503（error 里带启动命令） */
export function createCompanionGenerateTask(
  params: GenerateAudioParams,
  projectId?: string,
  priority: CompanionPriority = 0,
): Promise<{ taskId: string; status: CompanionTaskStatus; summary: string }> {
  return request<{ taskId: string; status: CompanionTaskStatus; summary: string }>('/api/companion/tasks', {
    method: 'POST',
    body: JSON.stringify({ type: 'generate_audio', params, projectId, priority }),
  })
}

/** POST /api/companion/tasks 的 repaint_audio 参数（区间相对 clip 内部，单位秒） */
export interface RepaintAudioParams {
  /** 重绘描述（英文提示词） */
  caption: string
  /** 要重绘的片段的当前资产 id */
  sourceAssetId: string
  startSec: number
  endSec: number
  seed?: number
  style?: string
  /** 来自 GET /api/adapters 的 nativeReady 列表 */
  adapterId?: string
  /** P9 引擎量级：'xl' 时走 xl_sft（缺省 2b） */
  engine?: CompanionEngine
}

/** 局部重绘任务；产物是整段音频（区间外由模型重建保持连续） */
export function createCompanionRepaintTask(
  params: RepaintAudioParams,
  projectId?: string,
  priority: CompanionPriority = 0,
): Promise<{ taskId: string; status: CompanionTaskStatus; summary: string }> {
  return request<{ taskId: string; status: CompanionTaskStatus; summary: string }>('/api/companion/tasks', {
    method: 'POST',
    body: JSON.stringify({ type: 'repaint_audio', params, projectId, priority }),
  })
}

/* ---------------- P7-B：AI 重编（cover）---------------- */

/** POST /api/companion/tasks 的 cover_audio 参数（把渲染好的工程整体"保结构换编制"） */
export interface CoverAudioParams {
  /** 要重编的音频资产（通常是浏览器离线渲染当前工程得到的 WAV） */
  sourceAssetId: string
  /** 希望变成什么编制/风格（英文提示词） */
  caption: string
  /** 0–1：越大越贴近原结构（默认 0.7）；越小越自由 */
  audioCoverStrength?: number
  seed?: number
  /** P9 引擎量级：'xl' 时走 xl_turbo（缺省 2b） */
  engine?: CompanionEngine
}

/** AI 重编（cover）任务；产物是整段新音频 */
export function createCompanionCoverTask(
  params: CoverAudioParams,
  projectId?: string,
  priority: CompanionPriority = 0,
): Promise<{ taskId: string; status: CompanionTaskStatus; summary: string }> {
  return request<{ taskId: string; status: CompanionTaskStatus; summary: string }>('/api/companion/tasks', {
    method: 'POST',
    body: JSON.stringify({ type: 'cover_audio', params, projectId, priority }),
  })
}

/* ---------------- P5-B：分轨 Stem ---------------- */

/** 分轨 stem 允许的乐器 arm */
export const STEM_ARMS = ['guitar', 'bass', 'drums', 'strings', 'keys', 'synth', 'vocals'] as const
export type StemArm = (typeof STEM_ARMS)[number]

/** arm → 中文名（UI/轨道命名用） */
export const STEM_ARM_LABEL: Record<StemArm, string> = {
  guitar: '吉他',
  bass: '贝斯',
  drums: '鼓组',
  strings: '弦乐',
  keys: '键盘',
  synth: '合成器',
  vocals: '人声',
}

/** POST /api/companion/tasks 的 generate_stem 参数 */
export interface GenerateStemParams {
  /** 源音频资产 id（从要分轨的音频片段来） */
  sourceAssetId: string
  arm: StemArm
  /** 可选：该 arm 的额外描述（留空用 Companion 内置映射） */
  caption?: string
  seed?: number
  /** P9 引擎量级：'xl' 时走 xl_base（缺省 2b） */
  engine?: CompanionEngine
}

/** 提交分轨任务（服务端会派给带 base 能力的 Companion，冷启动可能较慢） */
export function createCompanionStemTask(
  params: GenerateStemParams,
  projectId?: string,
  priority: CompanionPriority = 0,
): Promise<{ taskId: string; status: CompanionTaskStatus; summary: string }> {
  return request<{ taskId: string; status: CompanionTaskStatus; summary: string }>('/api/companion/tasks', {
    method: 'POST',
    body: JSON.stringify({ type: 'generate_stem', params, projectId, priority }),
  })
}

export function getCompanionTask(taskId: string): Promise<{ task: CompanionTaskState }> {
  return request<{ task: CompanionTaskState }>(`/api/companion/tasks/${encodeURIComponent(taskId)}`)
}

export function cancelCompanionTask(
  taskId: string,
): Promise<{ ok: boolean; task?: CompanionTaskState }> {
  return request<{ ok: boolean; task?: CompanionTaskState }>(
    `/api/companion/tasks/${encodeURIComponent(taskId)}/cancel`,
    { method: 'POST', body: '{}' },
  )
}

/* ------------------------------------------------------------------ */
/* LoRA 适配器                                                          */
/* ------------------------------------------------------------------ */

export interface AdapterInfo {
  id: string
  name: string
  styleId?: string
  format: string
  baseModel: string
  tasks: string[]
  rank?: number
  alpha?: number
  bytes: number
  license?: string
  audit: { ok: boolean; errors: string[]; warnings: string[] }
}

export interface AdaptersResult {
  root: string
  count: number
  adapters: AdapterInfo[]
  broken: { dir: string; error: string }[]
  /** 真正能被 C++ 运行时加载的适配器 id（下拉只列这些） */
  nativeReady: string[]
}

export function listAdapters(): Promise<AdaptersResult> {
  return request<AdaptersResult>('/api/adapters')
}

/* ------------------------------------------------------------------ */
/* 工具                                                               */
/* ------------------------------------------------------------------ */

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}
