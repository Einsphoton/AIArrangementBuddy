import type { AppSettings, Project } from '@aiab/core'

/* ------------------------------------------------------------------ */
/* 通用请求                                                            */
/* ------------------------------------------------------------------ */

export class ApiError extends Error {
  status: number
  detail?: string
  constructor(status: number, message: string, detail?: string) {
    super(message)
    this.status = status
    this.detail = detail
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
    try {
      const body = (await response.json()) as { error?: string; message?: string }
      detail = body.error ?? body.message ?? ''
    } catch {
      detail = await response.text().catch(() => '')
    }
    throw new ApiError(response.status, detail || `请求失败（${response.status}）`, detail)
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
