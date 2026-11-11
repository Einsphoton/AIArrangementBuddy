#!/usr/bin/env node
/**
 * Companion 工作节点进程（P2-A）：把 NAS/服务端的音频生成任务在本机 GPU 上执行。
 *
 *   node scripts/companion.mjs --server http://127.0.0.1:8899 --name "本机 GPU" [--mock] [--acestep] [--once]
 *
 * 协议（HTTP JSON 轮询，见 docs/COMPANION.md 与 docs/STUDIO_ARCHITECTURE.md §4）：
 *   register → 循环 [heartbeat / claim / progress / complete]
 *
 * 执行器：
 * - --mock      无 GPU 自检：generate_audio / repaint_audio 都返回 2 秒 440Hz 立体声 48k WAV。
 * - --acestep   生产执行器（默认）：
 *     · EngineManager 常驻 ace-server 子进程，按 DiT 变体复用（generate_audio→turbo，repaint_audio→sft），
 *       同变体跨任务复用、切换变体才重启、空闲 --engine-idle 秒后自动退出、崩溃后下一任务重启；
 *     · generate_audio：POST /synth?wav=1（JSON）；
 *     · repaint_audio：先下载源资产，再 POST /synth?wav=1（multipart：request JSON + audio 文件，sft DiT）；
 *     · 合成期间每 ~2s 上报 progress；服务端 cancel:true 时 AbortController 中止请求并杀掉引擎进程。
 *
 * 设计取舍：
 * - 只用 node: 内置模块（Node 24），不引新依赖；
 * - 单任务串行；引擎同一时刻只有一个，变体切换/崩溃重启由 EngineManager 串行保证；
 * - 所有协议请求都走指数退避重试，服务端不可达时不崩；
 * - --once：处理完一个任务（成功或失败）就退出，用于验收。
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const COMPANION_VERSION = '0.2.0'
const USER_AGENT = `aiab-companion/${COMPANION_VERSION}`
const TASK_TYPE_GENERATE = 'generate_audio'
const TASK_TYPE_REPAINT = 'repaint_audio'
const TASK_TYPE_STEM = 'generate_stem'
const TASK_TYPE_COVER = 'cover_audio'
const TASKS = [TASK_TYPE_GENERATE, TASK_TYPE_REPAINT, TASK_TYPE_STEM, TASK_TYPE_COVER]
/** 任务类型 → ACE-Step DiT 变体（repaint 必须用 sft，lego 分轨必须用 base，cover 用 turbo） */
const TASK_VARIANT = {
  [TASK_TYPE_GENERATE]: 'turbo',
  [TASK_TYPE_REPAINT]: 'sft',
  [TASK_TYPE_STEM]: 'base',
  [TASK_TYPE_COVER]: 'turbo',
}

const DEFAULT_SERVER = 'http://127.0.0.1:8787'
const DEFAULT_HEARTBEAT_MS = 5000
const DEFAULT_POLL_MS = 3000
const DEFAULT_ENGINE_IDLE_SEC = 600

/** 数据目录：与产品一致（AIAB_DATA_DIR/DATA_DIR > <repo>/data） */
const DATA_ROOT = process.env.AIAB_DATA_DIR || process.env.DATA_DIR || path.join(ROOT, 'data')
/** P8 自动安装目录（node scripts/provision.mjs install 装到这里） */
const PROVISIONED_ACESTEP_DIR = path.join(DATA_ROOT, 'ace-step')
/** 旧版开发布局（Windows 本地实验区）；仅作为兼容回退 */
const LEGACY_ACESTEP_DIR = path.join(ROOT, 'music-gen', 'acestep-cpp')
const IS_WINDOWS = process.platform === 'win32'
const RUNTIME_BIN_NAMES = IS_WINDOWS
  ? ['ace-server.exe', 'bin/ace-server.exe']
  : ['ace-server', 'bin/ace-server']

/** 引擎根目录：AIAB_ACESTEP_DIR > 已安装目录 > 旧版目录 */
function resolveAceStepDir() {
  const explicit = process.env.AIAB_ACESTEP_DIR || process.env.ACESTEP_DIR
  if (explicit) return path.resolve(explicit)
  for (const candidate of [PROVISIONED_ACESTEP_DIR, LEGACY_ACESTEP_DIR]) {
    if (RUNTIME_BIN_NAMES.some((name) => existsSync(path.join(candidate, name)))) return candidate
  }
  return PROVISIONED_ACESTEP_DIR
}

export const ACESTEP_DIR = resolveAceStepDir()
export const ACESTEP_BIN =
  RUNTIME_BIN_NAMES.map((name) => path.join(ACESTEP_DIR, name)).find((candidate) => existsSync(candidate)) ??
  path.join(ACESTEP_DIR, RUNTIME_BIN_NAMES[0])
export const ACESTEP_MODELS_DIR = process.env.AIAB_ACESTEP_MODELS_DIR || path.join(ACESTEP_DIR, 'models')
/** 计算后端：macOS 用 Metal，其它平台默认 CUDA0（可用 GGML_BACKEND 覆盖） */
export const ACESTEP_BACKEND = process.env.GGML_BACKEND || (process.platform === 'darwin' ? 'METAL' : 'CUDA0')
/** 缺引擎时给用户的自动安装提示 */
export const PROVISION_HINT = 'node scripts/provision.mjs install --profile essential'
/** 三种 DiT 的文件名（模型能力按「文件是否存在」真实上报给服务端做任务匹配） */
export const MODEL_FILENAMES = Object.freeze({
  turbo: 'acestep-v15-turbo-Q8_0.gguf',
  sft: 'acestep-v15-sft-Q8_0.gguf',
  base: 'acestep-v15-base-Q8_0.gguf',
})
/** 三种 DiT：turbo = text2music，sft = repaint，base = lego（lego 留后续） */
export const MODEL_DITS = Object.freeze({
  turbo: path.join(ACESTEP_MODELS_DIR, MODEL_FILENAMES.turbo),
  sft: path.join(ACESTEP_MODELS_DIR, MODEL_FILENAMES.sft),
  base: path.join(ACESTEP_MODELS_DIR, MODEL_FILENAMES.base),
})
/** 与 DiT 搭配的辅助模型 */
export const MODEL_AUX = Object.freeze({
  embedding: path.join(ACESTEP_MODELS_DIR, 'Qwen3-Embedding-0.6B-Q8_0.gguf'),
  vae: path.join(ACESTEP_MODELS_DIR, 'vae-BF16.gguf'),
  /** 质量档（P7-A）用的 LM：/lm 提示词增强 + 语义 codes */
  lm: path.join(ACESTEP_MODELS_DIR, 'acestep-5Hz-lm-1.7B-Q8_0.gguf'),
})

/** 质量档（P7-A）：/lm → /synth（sft 50 步）。真机实测 20s 音频约 15–25s。 */
export const QUALITY_STEPS = 50
export const QUALITY_GUIDANCE = 1.0
export const QUALITY_SHIFT = 1.0
/** P2-A 支持的任务类型所必需的模型文件（base/lego 未开放，不强制要求） */
const REQUIRED_MODEL_FILES = [ACESTEP_BIN, MODEL_AUX.embedding, MODEL_AUX.vae, MODEL_DITS.turbo, MODEL_DITS.sft]
/** 合法的引擎变体（服务端 requiredVariant 的取值域） */
export const ENGINE_VARIANTS = ['turbo', 'sft', 'base']
/** mock 执行器三种任务都能伪造，按契约上报 turbo/sft/base（含 base 才能接到 generate_stem 做 UI 联调） */
const MOCK_MODEL_VARIANTS = ['turbo', 'sft', 'base']
/** lego 分轨的合法 arm（base 基座），以及 caption 缺省时的英文描述 */
export const STEM_ARMS = ['guitar', 'bass', 'drums', 'strings', 'keys', 'synth', 'vocals']
const STEM_ARM_CAPTIONS = Object.freeze({
  guitar: 'Isolated electric guitar stem: distorted rhythm and lead guitar, palm-muted power chords, no other instruments',
  bass: 'Isolated bass stem: electric bass line, round low end, no drums or guitars',
  drums: 'Isolated drum stem: acoustic drum kit, kick snare hi-hat toms, tight groove, no melodic instruments',
  strings: 'Isolated strings stem: orchestral string section, sustained legato, no brass or percussion',
  keys: 'Isolated keyboard stem: piano and electric keys, chordal comping, no guitar or drums',
  synth: 'Isolated synthesizer stem: analog synth pads and arpeggios, no acoustic instruments',
  vocals: 'Isolated vocal stem: lead vocals with clear diction, no instrumental backing',
})
const ACESTEP_PORT_MIN = 17900
const ACESTEP_PORT_MAX = 17999
const ACESTEP_HEALTH_TIMEOUT_MS = 240_000
const ACESTEP_HEALTH_POLL_MS = 1200
const ACESTEP_SYNTH_TIMEOUT_MS = 900_000
const ACESTEP_LM_TIMEOUT_MS = 180_000
const SYNTH_PROGRESS_INTERVAL_MS = 2000
const HEALTH_PROBE_TIMEOUT_MS = 3000
const REQUEST_TIMEOUT_MS = 15_000
const COMPLETE_TIMEOUT_MS = 120_000
const SOURCE_DOWNLOAD_TIMEOUT_MS = 120_000
/** 空闲时查询服务端队列能力的节流间隔（至少 30s 一次） */
const CAPABILITY_STATUS_INTERVAL_MS = 30_000
/** 能力不匹配提示日志的节流间隔（约 30s 一条，不刷屏） */
const CAPABILITY_HINT_INTERVAL_MS = 30_000

const USAGE = `用法：
  node scripts/companion.mjs --server http://127.0.0.1:8899 --name "本机 GPU" [--mock|--acestep] [--once] [--engine-idle 秒]

参数：
  --server <url>       服务端地址（默认 ${DEFAULT_SERVER}）
  --name <名字>        工作节点显示名（默认取主机名）
  --mock               无 GPU 自检执行器：generate/repaint/stem 都返回 2 秒 440Hz 立体声 48k WAV
  --acestep            生产执行器（默认）：常驻本地 ACE-Step C++ 引擎（需要 CUDA/GPU）
  --engine-idle <秒>   引擎空闲多少秒后自动退出，默认 ${DEFAULT_ENGINE_IDLE_SEC}；0 = 不自动退出
  --once               处理完一个任务就退出（验收用）
  -h, --help           显示本帮助`

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 可被 AbortSignal 打断的 sleep；打断时抛 CancelledError。 */
async function abortableSleep(ms, signal) {
  if (signal?.aborted) throw new CancelledError('任务已取消')
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    // 注意：不能 unref——否则 await 期间事件循环为空时进程会提前退出（--once 会被误判成功）
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(new CancelledError('任务已取消'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** 指数退避延迟：500 → 1000 → 2000 → … → cap。纯函数，便于测试。 */
export function backoffDelay(attempt, { baseMs = 500, maxMs = 10_000 } = {}) {
  const step = Math.max(0, Math.floor(Number(attempt) || 0))
  if (!Number.isFinite(baseMs) || baseMs <= 0) return 0
  return Math.min(maxMs, baseMs * 2 ** step)
}

/** 把进度夹到 0..1；非法值按 0 处理。 */
export function clampProgress(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(1, Math.max(0, number))
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** 服务端返回的心跳/轮询周期做边界保护；纯函数。 */
export function normalizePollTiming(payload = {}) {
  return {
    heartbeatMs: clampInt(payload?.heartbeatMs, 1000, 60_000, DEFAULT_HEARTBEAT_MS),
    pollMs: clampInt(payload?.pollMs, 500, 30_000, DEFAULT_POLL_MS),
  }
}

/** 日志行：ISO 时间戳 + 可选任务 id。 */
export function formatLogLine(message, { taskId, now = new Date() } = {}) {
  return `${now.toISOString()}${taskId ? ` [${taskId}]` : ''} ${message}`
}

function createLogger() {
  return (message, options = {}) => {
    process.stdout.write(`${formatLogLine(message, options)}\n`)
  }
}

/** 过滤成可用作文件名的片段。 */
export function sanitizeFileName(value) {
  const base = String(value ?? '')
    .trim()
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[._]+/, '')
  return base || 'audio'
}

/** complete 上传的文件名必须以 .wav 结尾（契约要求）。 */
export function normalizeWavFileName(fileName, taskId = 'audio') {
  const base = sanitizeFileName(fileName || `${sanitizeFileName(taskId)}.wav`)
  return /\.wav$/i.test(base) ? base : `${base}.wav`
}

/** 把执行器/网络异常转成给用户看的中文原因（也写进 complete.error）。 */
export function readableError(error) {
  if (error instanceof CancelledError) return error.message || '任务已取消'
  const message = error?.message ? String(error.message) : String(error ?? '')
  const trimmed = message.trim()
  if (!trimmed) return '未知错误（没有错误详情）'
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed
}

function truncate(text, max) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new CancelledError('任务已取消')
}

function fetchFailureDetail(error) {
  return error?.cause?.message ?? error?.message ?? String(error)
}

/* ------------------------------------------------------------------ */
/* 错误类型 + 重试判定                                                  */
/* ------------------------------------------------------------------ */

export class CancelledError extends Error {
  constructor(message = '任务已取消') {
    super(message)
    this.name = 'CancelledError'
  }
}

export class SessionExpiredError extends Error {
  constructor(message = '工作节点会话失效') {
    super(message)
    this.name = 'SessionExpiredError'
  }
}

export class HttpError extends Error {
  constructor(message, status, body = '') {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.body = body
  }
}

/** 网络抖动 / 超时 / 5xx / 429 可重试；取消与鉴权失效不重试。 */
export function isRetryableError(error) {
  if (!error) return false
  if (error instanceof CancelledError || error instanceof SessionExpiredError) return false
  if (error instanceof HttpError) {
    return error.status >= 500 || error.status === 408 || error.status === 429
  }
  return error.retryable === true
}

function normalizeFetchError(error) {
  if (error instanceof CancelledError || error instanceof SessionExpiredError) return error
  const name = error?.name
  const detail = fetchFailureDetail(error)
  if (name === 'TimeoutError' || name === 'AbortError') {
    const wrapped = new Error(`请求超时或中断：${detail}`)
    wrapped.retryable = true
    wrapped.cause = error
    return wrapped
  }
  const wrapped = new Error(`无法连接服务端：${detail}`)
  wrapped.retryable = true
  wrapped.cause = error
  return wrapped
}

/**
 * 通用重试循环。attempts=Infinity 表示一直重试到成功（用于 claim/register 这类轮询）。
 * 非可重试错误（4xx、取消、协议错误）立即抛出。
 */
async function withRetry(fn, { label = '请求', attempts = Infinity, baseMs = 500, maxMs = 10_000, shouldStop, log } = {}) {
  let attempt = 0
  for (;;) {
    if (shouldStop?.()) throw new CancelledError(`已停止（${label}）`)
    try {
      return await fn()
    } catch (error) {
      if (attempt + 1 >= attempts || !isRetryableError(error)) throw error
      const delay = backoffDelay(attempt, { baseMs, maxMs })
      attempt += 1
      log?.(`⚠ ${label}失败：${readableError(error)}；${Math.round(delay / 100) / 10}s 后重试（第 ${attempt} 次）`)
      await sleep(delay)
    }
  }
}

/** HTTP 非鉴权错误转会话失效；401/403/404 都意味着服务端不认识这个 worker。 */
function toSessionExpired(error, action) {
  if (error instanceof HttpError && [401, 403, 404].includes(error.status)) {
    return new SessionExpiredError(`${action}失败（HTTP ${error.status}），工作节点会话失效`)
  }
  return error
}

/* ------------------------------------------------------------------ */
/* 参数解析与启动形状                                                   */
/* ------------------------------------------------------------------ */

/** 去掉尾斜杠并校验必须是 http(s) URL。 */
export function normalizeServerUrl(value) {
  const text = String(value ?? '').trim()
  if (!/^https?:\/\//i.test(text)) {
    throw new Error(`--server 必须是以 http:// 或 https:// 开头的地址，收到：${text || '(空)'}`)
  }
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error(`--server 不是合法 URL：${text}`)
  }
  return `${url.origin}${url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')}`
}

/**
 * 解析 CLI。纯函数（不读 process.env/argv），便于 verify_companion.mjs 直接测。
 * 返回 { server, name, executor: 'mock'|'acestep', once, engineIdleSec, help }
 */
export function parseArgs(argv = []) {
  const options = {
    server: DEFAULT_SERVER,
    name: '',
    executor: 'acestep',
    once: false,
    engineIdleSec: DEFAULT_ENGINE_IDLE_SEC,
    help: false,
  }
  let mock = false
  let acestep = false
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]
    const [flag, inlineValue] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined]
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('-')) throw new Error(`${flag} 缺少取值`)
      index += 1
      return next
    }
    switch (flag) {
      case '--server':
        options.server = normalizeServerUrl(takeValue())
        break
      case '--name':
        options.name = takeValue()
        break
      case '--engine-idle': {
        const seconds = Number(takeValue())
        if (!Number.isFinite(seconds) || seconds < 0) throw new Error('--engine-idle 必须是非负秒数（0 = 不自动退出）')
        options.engineIdleSec = seconds
        break
      }
      case '--mock':
        mock = true
        break
      case '--acestep':
        acestep = true
        break
      case '--once':
        options.once = true
        break
      case '-h':
      case '--help':
        options.help = true
        break
      default:
        throw new Error(`未知参数：${raw}\n\n${USAGE}`)
    }
  }
  if (mock && acestep) throw new Error('--mock 与 --acestep 只能二选一')
  options.executor = mock ? 'mock' : 'acestep'
  return options
}

/** 注册请求体（契约固定形状）。 */
export function buildRegisterBody({ name, version = COMPANION_VERSION, executor = 'acestep' } = {}) {
  return { name, version, capabilities: buildCapabilities(executor) }
}

/**
 * 扫描 models 目录，按真实存在的 GGUF 得出本机支持的 DiT 变体（纯函数，exists 可注入便于测试）。
 * 服务端用 capabilities.models 做任务能力匹配；返回顺序固定 turbo/sft/base。
 */
export function detectModelVariants({ exists = existsSync, modelsDir = ACESTEP_MODELS_DIR } = {}) {
  return ENGINE_VARIANTS.filter((variant) => {
    try {
      return Boolean(exists(path.join(modelsDir, MODEL_FILENAMES[variant])))
    } catch {
      return false
    }
  })
}

/** capabilities：mock 上报 turbo+sft；acestep 按真实存在的 GGUF 上报模型变体 + GPU 后端。 */
export function buildCapabilities(executor = 'acestep', { variants } = {}) {
  const tasks = [...TASKS]
  if (executor === 'mock') return { tasks, models: [...MOCK_MODEL_VARIANTS] }
  return {
    tasks,
    gpu: ACESTEP_BACKEND,
    models: variants ? [...variants] : detectModelVariants(),
  }
}

/** 鉴权公共字段；undefined 的扩展字段会被丢弃（status 可选）。 */
export function buildAuthBody(workerId, token, extra = {}) {
  const body = { workerId, token }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) body[key] = value
  }
  return body
}

/** 服务端 priority：0 普通 / 1 高 / 2 紧急；缺失或非法按 0（兼容旧服务端）。 */
export function normalizePriority(value) {
  return value === 1 || value === 2 ? value : 0
}

/** 任务类型 → 需要的 DiT 变体；未知类型返回 undefined（仍交给执行器报错，不做硬校验）。 */
export function inferRequiredVariant(type, params = {}) {
  // P7-A：质量模式 generate_audio 实际走 sft+LM，派单/校验都按 sft
  if (type === TASK_TYPE_GENERATE && params?.quality === true) return 'sft'
  return TASK_VARIANT[type] ?? undefined
}

/** claim 响应 → 任务信封；204/空响应返回 null。形状不对立刻报错；旧服务端缺 priority/requiredVariant 时补默认值。 */
export function parseTaskEnvelope(payload) {
  if (payload === null || payload === undefined) return null
  const task = payload.task ?? payload
  if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error('claim 响应缺少 task 对象')
  if (typeof task.id !== 'string' || !task.id.trim()) throw new Error('claim 响应中的任务缺少 id')
  if (typeof task.type !== 'string' || !task.type.trim()) throw new Error(`任务 ${task.id} 缺少 type`)
  const params = task.params === undefined || task.params === null ? {} : task.params
  if (typeof params !== 'object' || Array.isArray(params)) throw new Error(`任务 ${task.id} 的 params 不是对象`)
  const envelope = {
    id: task.id,
    type: task.type,
    params,
    priority: normalizePriority(task.priority),
  }
  const requiredVariant = ENGINE_VARIANTS.includes(task.requiredVariant) ? task.requiredVariant : inferRequiredVariant(task.type, params)
  if (requiredVariant) envelope.requiredVariant = requiredVariant
  if (task.projectId !== undefined) envelope.projectId = task.projectId
  return envelope
}

/* ------------------------------------------------------------------ */
/* mock WAV / WAV 元信息                                                */
/* ------------------------------------------------------------------ */

/**
 * 纯函数：生成 2 秒 440Hz 立体声 48k PCM16 WAV。
 * 左右声道同相；不依赖任何库。
 */
export function createMockWav({
  sampleRate = 48_000,
  channels = 2,
  durationSec = 2,
  frequency = 440,
  amplitude = 0.3,
} = {}) {
  const frames = Math.round(sampleRate * durationSec)
  const bytesPerSample = 2
  const blockAlign = channels * bytesPerSample
  const dataSize = frames * blockAlign
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16) // fmt 块大小
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * blockAlign, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * frequency * frame) / sampleRate) * amplitude * 32_767)
    for (let channel = 0; channel < channels; channel += 1) {
      buffer.writeInt16LE(sample, 44 + frame * blockAlign + channel * bytesPerSample)
    }
  }
  return buffer
}

/**
 * 解析 WAV 头（RIFF chunk 遍历，兼容 fmt/data 之间夹其他块），返回时长等元信息。
 * 纯函数；不是合法 WAV 时抛中文错误。
 */
export function readWavInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) throw new Error('不是有效 WAV（文件过短）')
  if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('不是有效 WAV（缺少 RIFF/WAVE 标识）')
  }
  let offset = 12
  let fmt = null
  let dataSize = null
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('latin1', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (chunkId === 'fmt ') {
      if (chunkSize < 16 || body + 16 > buffer.length) throw new Error('不是有效 WAV（fmt 块损坏）')
      fmt = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      }
    } else if (chunkId === 'data') {
      dataSize = Math.min(chunkSize, buffer.length - body)
    }
    offset = body + chunkSize + (chunkSize % 2)
    if (fmt && dataSize !== null) break
  }
  if (!fmt || dataSize === null) throw new Error('不是有效 WAV（缺少 fmt/data 块）')
  const bytesPerSample = Math.max(1, Math.round(fmt.bitsPerSample / 8))
  const blockAlign = fmt.channels * bytesPerSample
  if (!fmt.sampleRate || !blockAlign) throw new Error('不是有效 WAV（声道/采样率非法）')
  return {
    ...fmt,
    dataSize,
    durationSec: dataSize / (fmt.sampleRate * blockAlign),
  }
}

/* ------------------------------------------------------------------ */
/* /synth 请求体（照抄 gen_style_datasets.py / test_modes.py 的语义）    */
/* ------------------------------------------------------------------ */

/** generate_audio：task.params → ACE-Step /synth JSON 请求体。纯函数；缺 caption 直接报错。 */
export function buildSynthPayload(params = {}) {
  const caption = typeof params?.caption === 'string' ? params.caption.trim() : ''
  if (!caption) throw new Error('任务参数缺少 caption（生成提示词）')
  const keyscale = typeof params.keyscale === 'string' && params.keyscale.trim() ? params.keyscale.trim() : 'C major'
  const rawBpm = Number(params.bpm)
  const bpm = Number.isFinite(rawBpm) ? clampInt(rawBpm, 30, 300, 120) : 120
  const rawDuration = Number(params.durationSec)
  const duration = Number.isFinite(rawDuration) ? Math.min(300, Math.max(1, rawDuration)) : 30
  const seed = Number.isInteger(params.seed) && params.seed >= 0 ? params.seed : 0
  return {
    caption,
    lyrics: '[Instrumental]',
    bpm,
    keyscale,
    timesignature: '4',
    vocal_language: 'unknown',
    seed,
    batch_size: 1,
    inference_steps: 8,
    guidance_scale: 1.0,
    shift: 1.0,
    use_cot_caption: false,
    duration,
  }
}

/** repaint 的 seed：缺省/非法时随机（纯函数，可注入 rng 方便测试）。 */
export function resolveSeed(seed, rng = Math.random) {
  if (Number.isInteger(seed) && seed >= 0) return seed
  const value = Number(rng())
  const safe = Number.isFinite(value) ? Math.min(0.999999, Math.max(0, value)) : 0.5
  return Math.floor(safe * 1_000_000)
}

/**
 * repaint_audio 参数校验（纯函数）。分两步用：
 * 1) 引擎启动前先校验 caption/sourceAssetId/startSec/endSec 基本合法性；
 * 2) 下载源音频后带上 sourceDurationSec 再校验 endSec 不越界。
 */
export function validateRepaintParams(params = {}, { sourceDurationSec } = {}) {
  const caption = typeof params?.caption === 'string' ? params.caption.trim() : ''
  if (!caption) throw new Error('repaint_audio 需要 params.caption（重绘提示词）')
  const sourceAssetId = typeof params?.sourceAssetId === 'string' ? params.sourceAssetId.trim() : ''
  if (!sourceAssetId) throw new Error('repaint_audio 需要 params.sourceAssetId（源音频资产 id）')
  const startSec = Number(params?.startSec)
  if (!Number.isFinite(startSec)) throw new Error('repaint_audio 需要 params.startSec（重绘起点，秒）')
  const endSec = Number(params?.endSec)
  if (!Number.isFinite(endSec)) throw new Error('repaint_audio 需要 params.endSec（重绘终点，秒）')
  if (startSec < 0) throw new Error(`repaint_audio 的 startSec 不能为负（收到 ${startSec}）`)
  if (startSec >= endSec) throw new Error(`repaint_audio 的 startSec 必须小于 endSec（收到 ${startSec} / ${endSec}）`)
  if (Number.isFinite(sourceDurationSec) && sourceDurationSec > 0 && endSec > sourceDurationSec + 0.05) {
    throw new Error(`repaint_audio 的 endSec=${endSec}s 超过源音频时长 ${sourceDurationSec.toFixed(2)}s`)
  }
  const normalized = { caption, sourceAssetId, startSec, endSec, seed: resolveSeed(params?.seed) }
  if (typeof params?.style === 'string' && params.style.trim()) normalized.style = params.style.trim()
  if (typeof params?.adapterId === 'string' && params.adapterId.trim()) normalized.adapterId = params.adapterId.trim()
  // 服务端（模型管理器）下发 LoRA 目录路径；Companion 启动引擎时用 --lora 加载
  if (typeof params?.adapterPath === 'string' && params.adapterPath.trim()) normalized.adapterPath = params.adapterPath.trim()
  return normalized
}

/** repaint_audio：校验后的参数 → ACE-Step /synth multipart 里的 request JSON。 */
export function buildRepaintRequest(params = {}) {
  return {
    caption: params.caption,
    lyrics: '[Instrumental]',
    seed: Number.isInteger(params.seed) ? params.seed : resolveSeed(params.seed),
    batch_size: 1,
    repainting_start: params.startSec,
    repainting_end: params.endSec,
    inference_steps: 50,
    guidance_scale: 1.0,
    shift: 1.0,
  }
}

/**
 * generate_stem（lego 分轨）参数校验（纯函数）：
 * 启动引擎/下载源音频之前先拦掉缺 sourceAssetId 与非法 arm。
 */
export function validateStemParams(params = {}) {
  const sourceAssetId = typeof params?.sourceAssetId === 'string' ? params.sourceAssetId.trim() : ''
  if (!sourceAssetId) throw new Error('generate_stem 需要 params.sourceAssetId（源音频资产 id）')
  const rawArm = typeof params?.arm === 'string' ? params.arm.trim().toLowerCase() : ''
  if (!rawArm) throw new Error(`generate_stem 需要 params.arm（分轨乐器：${STEM_ARMS.join('/')}）`)
  if (!STEM_ARMS.includes(rawArm)) {
    throw new Error(`generate_stem 的 arm 非法：${rawArm}（合法值：${STEM_ARMS.join('/')}）`)
  }
  const caption =
    typeof params?.caption === 'string' && params.caption.trim() ? params.caption.trim() : STEM_ARM_CAPTIONS[rawArm]
  const normalized = { sourceAssetId, arm: rawArm, caption, seed: resolveSeed(params?.seed) }
  if (typeof params?.adapterId === 'string' && params.adapterId.trim()) normalized.adapterId = params.adapterId.trim()
  if (typeof params?.adapterPath === 'string' && params.adapterPath.trim()) normalized.adapterPath = params.adapterPath.trim()
  return normalized
}

/** generate_stem：校验后的参数 → ACE-Step lego request JSON（multipart 的 request 字段）。 */
export function buildLegoRequest(params = {}) {
  return {
    caption: params.caption,
    lyrics: '[Instrumental]',
    seed: Number.isInteger(params.seed) ? params.seed : resolveSeed(params.seed),
    batch_size: 1,
    lego: params.arm,
    inference_steps: 50,
    guidance_scale: 1.0,
    shift: 1.0,
  }
}

/** 默认 caption（arm → 英文描述），导出便于文档/测试核对。 */
export function defaultStemCaption(arm) {
  return STEM_ARM_CAPTIONS[String(arm ?? '').trim().toLowerCase()] ?? ''
}

/**
 * 构造 repaint 的 multipart 请求体（与 test_modes.py 实测形状一致）：
 * 字段 request（JSON 字符串）+ 文件字段 audio（源 WAV）。
 * 纯函数；boundary 可注入以便测试。
 */
export function buildSynthMultipart({ request, audio, fileName = 'source.wav', boundary } = {}) {
  if (!Buffer.isBuffer(audio) || audio.length === 0) throw new Error('buildSynthMultipart 需要非空音频 Buffer')
  const requestJson = typeof request === 'string' ? request : JSON.stringify(request)
  if (!requestJson || requestJson === '{}' || requestJson === 'undefined') throw new Error('buildSynthMultipart 需要 request JSON')
  const boundaryToken = boundary || `----aiab${randomBytes(12).toString('hex')}`
  const safeName = String(fileName || 'source.wav').replace(/["\r\n]/g, '_')
  const head = Buffer.from(
    `--${boundaryToken}\r\n` +
      'Content-Disposition: form-data; name="request"\r\n' +
      'Content-Type: application/json\r\n\r\n' +
      `${requestJson}\r\n` +
      `--${boundaryToken}\r\n` +
      `Content-Disposition: form-data; name="audio"; filename="${safeName}"\r\n` +
      'Content-Type: audio/wav\r\n\r\n',
    'utf8',
  )
  const tail = Buffer.from(`\r\n--${boundaryToken}--\r\n`, 'utf8')
  return {
    body: Buffer.concat([head, audio, tail]),
    contentType: `multipart/form-data; boundary=${boundaryToken}`,
    boundary: boundaryToken,
  }
}

/* ------------------------------------------------------------------ */
/* 进度估算 / 取消判定 / 引擎调度（纯函数）                              */
/* ------------------------------------------------------------------ */

/** 任务类型 → DiT 变体；不支持的类型抛中文错误。 */
export function variantForTask(type) {
  const variant = TASK_VARIANT[type]
  if (!variant) throw new Error(`不支持的任务类型：${type}（当前支持：${TASKS.join('、')}）`)
  return variant
}

/**
 * 引擎复用决策（纯函数）：
 * - reuse：同变体 + 同 LoRA 适配器且 ready → 复用（调用方仍需做 /health 探活）；
 * - switch：当前有引擎但变体/适配器不同 → 停旧起新；
 * - start：没有可用引擎（首次 / 崩溃后）。
 */
export function engineDecision({
  currentVariant,
  currentAdapterPath,
  currentLm = false,
  state,
  desiredVariant,
  desiredAdapterPath,
  desiredLm = false,
} = {}) {
  const sameAdapter = (currentAdapterPath ?? '') === (desiredAdapterPath ?? '')
  const sameLm = Boolean(currentLm) === Boolean(desiredLm)
  if (currentVariant && currentVariant === desiredVariant && sameAdapter && sameLm && state === 'ready') return 'reuse'
  if (
    currentVariant &&
    (currentVariant !== desiredVariant || !sameAdapter || !sameLm) &&
    state !== 'stopped' &&
    state !== 'crashed'
  ) {
    return 'switch'
  }
  return 'start'
}

/** 引擎展示名：`turbo` / `sft+LoRA(adapter_dir)`（纯函数，仅用于日志）。 */
export function engineLabel(variant, adapterPath, lm = false) {
  if (!variant) return '无'
  const adapterName = adapterPath ? path.basename(String(adapterPath)) : ''
  const suffix = lm ? '+LM' : ''
  return (adapterName ? `${variant}+LoRA(${adapterName})` : variant) + suffix
}

/** 空闲回收判断（纯函数）。idleMs<=0 表示禁用自动退出。 */
export function isEngineIdle(lastUsedAt, now, idleMs) {
  if (!Number.isFinite(idleMs) || idleMs <= 0) return false
  if (!Number.isFinite(lastUsedAt) || lastUsedAt <= 0) return false
  return now - lastUsedAt >= idleMs
}

/**
 * 质量档：/lm 请求体。
 * 只给"描述 + 时长 + 歌词占位"，bpm/keyscale 等编曲参数交给 LM 自己推断——
 * 实测把 bpm/keyscale 塞给 /lm 会让它回显这些值、生成更暗的编曲（真机对照）。
 */
export function buildQualityLmRequest(params = {}) {
  const base = buildSynthPayload(params)
  return {
    caption: base.caption,
    lyrics: base.lyrics,
    duration: base.duration,
    batch_size: 1,
    use_cot_caption: false,
  }
}

/** 质量档：把 /lm 返回结果变成 /synth 的 passthrough 请求（固定 50 步 / guidance 1.0 / shift 1.0）。 */
export function buildQualitySynthRequest(lmResult = {}, params = {}) {
  const request = { ...lmResult }
  request.inference_steps = QUALITY_STEPS
  request.guidance_scale = QUALITY_GUIDANCE
  request.shift = QUALITY_SHIFT
  if (!request.duration && Number(params?.durationSec) > 0) request.duration = params.durationSec
  return request
}

/** 合成阶段的估算进度：0.3→0.9 线性（纯函数）。 */
export function estimateProgress({ elapsedMs = 0, estimatedMs = 0, from = 0.3, to = 0.9 } = {}) {
  const floor = clampProgress(from)
  const ceiling = Math.max(floor, clampProgress(to))
  if (!Number.isFinite(estimatedMs) || estimatedMs <= 0) return floor
  const ratio = clampProgress(elapsedMs / estimatedMs)
  return Math.round((floor + (ceiling - floor) * ratio) * 1000) / 1000
}

/**
 * 预计合成耗时（秒，纯函数，仅用于进度估算，不影响正确性）：
 * - repaint：sft 50 步，实测 20s 源音频重绘 6-12s 区间约 14.3s → 10 + 区间*0.8；
 * - generate：turbo 8 步 → 8 + 时长*0.3。
 */
export function estimateGenerationSeconds({ type, params = {} } = {}) {
  if (params?.quality === true) {
    const duration = Number(params?.durationSec)
    const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 30
    return Math.min(600, Math.max(20, 20 + safeDuration * 1.2))
  }
  if (type === TASK_TYPE_STEM) {
    // base 50 步；实测 20s 源音频单条 stem 1.7–14.5s，取 10 + 源时长*0.5 作估算
    const duration = Number(params?.sourceDurationSec)
    const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 20
    return Math.min(300, Math.max(12, 10 + safeDuration * 0.5))
  }
  if (type === TASK_TYPE_COVER) {
    const duration = Number(params?.sourceDurationSec)
    const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 20
    return Math.min(300, Math.max(12, 8 + safeDuration * 0.6))
  }
  if (type === TASK_TYPE_REPAINT) {
    const region = Number(params?.endSec) - Number(params?.startSec)
    const safeRegion = Number.isFinite(region) && region > 0 ? region : 10
    return Math.min(300, Math.max(12, 10 + safeRegion * 0.8))
  }
  const duration = Number(params?.durationSec)
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 30
  return Math.min(300, Math.max(10, 8 + safeDuration * 0.3))
}

/** progress 响应是否要求取消（纯函数）。 */
export function isCancelSignal(payload) {
  return Boolean(payload && typeof payload === 'object' && payload.cancel === true)
}

/* ------------------------------------------------------------------ */
/* 能力匹配自检（P4-A）：空闲时才查队列、30s 节流，不刷屏                */
/* ------------------------------------------------------------------ */

/** 空闲时是否该查一次 GET /api/companion/status（默认至少间隔 30s）。 */
export function shouldCheckCapabilityStatus({ now, lastCheckedAt, intervalMs = CAPABILITY_STATUS_INTERVAL_MS } = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return false
  if (!Number.isFinite(lastCheckedAt) || lastCheckedAt <= 0) return true
  return now - lastCheckedAt >= intervalMs
}

/** 提示日志节流（默认 30s 一条）。 */
export function shouldEmitThrottledLog({ now, lastAt, intervalMs = CAPABILITY_HINT_INTERVAL_MS } = {}) {
  return shouldCheckCapabilityStatus({ now, lastCheckedAt: lastAt, intervalMs })
}

/**
 * 从服务端 status.blockedByCapability 找出「本机没有的变体」任务（纯函数）：
 * - 本机 models 为空 = 兼容全收（旧 Companion），不提示；
 * - 忽略非法条目与 count<=0。
 */
export function detectCapabilityGaps({ blockedByCapability, supportedVariants = [] } = {}) {
  if (!Array.isArray(blockedByCapability)) return []
  const supported = new Set(Array.isArray(supportedVariants) ? supportedVariants : [])
  if (supported.size === 0) return []
  return blockedByCapability
    .filter((entry) => {
      if (!entry || typeof entry !== 'object') return false
      if (!ENGINE_VARIANTS.includes(entry.variant)) return false
      const count = Number(entry.count)
      return Number.isFinite(count) && count > 0
    })
    .filter((entry) => !supported.has(entry.variant))
    .map((entry) => ({ variant: entry.variant, count: Math.round(Number(entry.count)) }))
}

/** 生成能力不匹配提示（纯函数），例如「当前队列有 2 个任务需要 sft，但本机只上报了 turbo」。 */
export function formatCapabilityGapHint({ gaps = [], supportedVariants = [] } = {}) {
  if (!Array.isArray(gaps) || gaps.length === 0) return ''
  const needs = gaps.map((gap) => `${gap.count} 个任务需要 ${gap.variant}`).join('、')
  const local = Array.isArray(supportedVariants) && supportedVariants.length ? supportedVariants.join('/') : '（未限制）'
  return `⚠ 当前队列有${needs}，但本机只上报了 ${local}；服务端不会派单——安装对应模型，或用 --mock 自检`
}

/* ------------------------------------------------------------------ */
/* 端口探测                                                             */
/* ------------------------------------------------------------------ */

export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
  })
}

/** 在 [min, max] 里随机起点探测空闲端口（避免固定端口撞车）。 */
export async function pickFreePortInRange(min, max, host = '127.0.0.1') {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min <= 0 || max < min || max > 65_535) {
    throw new Error(`端口范围无效：${min}-${max}`)
  }
  const span = max - min + 1
  const start = Math.floor(Math.random() * span)
  for (let offset = 0; offset < span; offset += 1) {
    const port = min + ((start + offset) % span)
    if (await isPortFree(port, host)) return port
  }
  throw new Error(`在 ${min}-${max} 内找不到空闲端口`)
}

/* ------------------------------------------------------------------ */
/* 子进程终止（terminate → 超时 kill）                                  */
/* ------------------------------------------------------------------ */

function onceExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    child.once('exit', resolve)
    child.once('close', resolve)
  })
}

async function waitWithTimeout(promise, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 保证子进程不残留：先 terminate（Windows 上即 TerminateProcess），
 * graceMs 内未退出再 kill(SIGKILL)，最后返回处置结果。
 */
export async function terminateChild(child, { graceMs = 15_000, killMs = 5000, log } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return 'already-exited'
  const exited = onceExit(child)
  try {
    child.kill()
  } catch {
    /* 已经退出 */
  }
  if (await waitWithTimeout(exited, graceMs)) return 'terminated'
  try {
    child.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  if (await waitWithTimeout(exited, killMs)) return 'killed'
  log?.(`⚠ 子进程 ${child.pid ?? '?'} 在 ${graceMs + killMs}ms 内仍未退出`)
  return 'still-running'
}

/* ------------------------------------------------------------------ */
/* ACE-Step 预检 / 健康检查                                             */
/* ------------------------------------------------------------------ */

/** 检查 bin + 必需模型（turbo/sft/embedding/vae）是否存在；缺失时返回中文原因，不抛异常。 */
export function preflightAceStep({ exists = existsSync } = {}) {
  const missing = REQUIRED_MODEL_FILES.filter((file) => !exists(file))
  if (missing.length === 0) return { ok: true, missing: [] }
  const names = missing.map((file) => path.relative(ROOT, file) || file)
  return {
    ok: false,
    missing,
    message:
      `本机 AI 引擎未安装完整（缺少 ${names.join(', ')}）。` +
      `可运行自动安装：${PROVISION_HINT}（或在产品界面点“安装本机引擎”）；` +
      `已装好但路径不同可设置 AIAB_ACESTEP_DIR / AIAB_ACESTEP_MODELS_DIR`,
  }
}


function aceLogTail(logTail) {
  const text = String(logTail ?? '').trim()
  if (!text) return ''
  return `\n引擎日志尾部：\n${text.split('\n').slice(-15).join('\n')}`
}

async function waitForAceHealth({
  base,
  child,
  getSpawnError,
  signal,
  logTail,
  fetchImpl = (...args) => fetch(...args),
  timeoutMs = ACESTEP_HEALTH_TIMEOUT_MS,
}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    throwIfAborted(signal)
    const spawnError = getSpawnError()
    if (spawnError) throw new Error(`无法启动 ACE-Step：${spawnError.message}`)
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`ACE-Step 启动后提前退出（exit=${child.exitCode}）${aceLogTail(logTail())}`)
    }
    try {
      const response = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) })
      if (response.ok) return
    } catch {
      /* 还没起来，继续等 */
    }
    await sleep(ACESTEP_HEALTH_POLL_MS)
  }
  throw new Error(`ACE-Step ${Math.round(timeoutMs / 1000)}s 内未就绪${aceLogTail(logTail())}`)
}

/* ------------------------------------------------------------------ */
/* EngineManager：常驻引擎（懒启动 / 复用 / 切换 / 空闲退出 / 崩溃重启）  */
/* ------------------------------------------------------------------ */

/**
 * 常驻 ace-server 管理器。同一时刻最多一个子进程：
 * - ensure(variant) 复用同变体（先 /health 探活），否则停旧起新；
 * - release() 任务结束，记 lastUsedAt 并安排空闲回收；
 * - kill(reason) 取消任务时直接杀进程（推理无法安全中断，杀进程最可靠）；
 * - shutdown() 进程退出时回收（SIGINT/SIGTERM 的 finally 调用）。
 *
 * spawnImpl/fetchImpl/now 可注入，便于 verify_companion.mjs 不依赖 GPU 做逻辑测试。
 */
export class EngineManager {
  constructor({
    idleMs = DEFAULT_ENGINE_IDLE_SEC * 1000,
    log = () => {},
    spawnImpl = spawn,
    fetchImpl = (...args) => fetch(...args),
    now = () => Date.now(),
    portRange = [ACESTEP_PORT_MIN, ACESTEP_PORT_MAX],
  } = {}) {
    this.idleMs = Math.max(0, Number(idleMs) || 0)
    this.log = log
    this.spawnImpl = spawnImpl
    this.fetchImpl = fetchImpl
    this.now = now
    this.portRange = portRange
    this.child = null
    this.variant = null
    this.adapterPath = null
    this.lm = false
    this.state = 'stopped'
    this.port = null
    this.baseUrl = null
    this.startedAt = 0
    this.lastUsedAt = 0
    this.busy = false
    this.logStream = null
    this.logPath = null
    this.logTail = ''
    this.spawnError = null
    this.idleTimer = null
  }

  status() {
    return {
      state: this.state,
      variant: this.variant,
      adapterPath: this.adapterPath ?? undefined,
      lm: this.lm,
      pid: this.child?.pid ?? null,
      port: this.port,
      warm: this.state === 'ready',
      busy: this.busy,
    }
  }

  /** 心跳里上报的引擎信息；没有引擎时返回 undefined（buildAuthBody 会丢弃）。 */
  heartbeatInfo() {
    if (!this.child) return undefined
    const info = { variant: this.variant, pid: this.child.pid, warm: this.state === 'ready', lm: this.lm }
    if (this.adapterPath) info.adapter = path.basename(this.adapterPath)
    return info
  }

  touch() {
    this.lastUsedAt = this.now()
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  closeLogStream() {
    const stream = this.logStream
    this.logStream = null
    if (stream) {
      try {
        stream.end()
      } catch {
        /* ignore */
      }
    }
  }

  scheduleIdleCheck() {
    this.clearIdleTimer()
    if (!this.idleMs || this.idleMs <= 0) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.handleIdle().catch((error) => this.log(`⚠ 引擎空闲回收失败：${readableError(error)}`))
    }, this.idleMs)
    this.idleTimer.unref?.()
  }

  async handleIdle() {
    if (!this.child || this.busy) return
    if (!isEngineIdle(this.lastUsedAt, this.now(), this.idleMs)) {
      this.scheduleIdleCheck()
      return
    }
    this.log(`引擎空闲 ${Math.round(this.idleMs / 1000)}s，自动退出（下次任务冷启动）`)
    await this.stop('空闲超时')
  }

  async probeHealth() {
    if (!this.child || !this.baseUrl) return false
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) })
      return Boolean(response?.ok)
    } catch {
      return false
    }
  }

  /** 主入口：确保所需变体（+可选 LoRA）就绪，返回 { variant, adapterPath, pid, warm, baseUrl }。 */
  async ensure(desiredVariant, { adapterPath, signal, onProgress, lm = false } = {}) {
    if (!MODEL_DITS[desiredVariant]) throw new Error(`未知引擎变体：${desiredVariant}`)
    throwIfAborted(signal)
    const desiredAdapter = adapterPath || null
    const desiredLm = Boolean(lm)
    const decision = engineDecision({
      currentVariant: this.variant,
      currentAdapterPath: this.adapterPath,
      currentLm: this.lm,
      state: this.state,
      desiredVariant,
      desiredAdapterPath: desiredAdapter,
      desiredLm,
    })
    if (decision === 'reuse') {
      if (await this.probeHealth()) {
        this.busy = true
        this.clearIdleTimer()
        this.touch()
        return {
          variant: desiredVariant,
          adapterPath: this.adapterPath ?? undefined,
          lm: this.lm,
          pid: this.child.pid,
          warm: true,
          baseUrl: this.baseUrl,
        }
      }
      this.log(`引擎健康检查失败（${engineLabel(this.variant, this.adapterPath, this.lm)}），重启`)
      await this.stop('健康检查失败')
    } else if (decision === 'switch') {
      this.log(
        `切换模型：${engineLabel(this.variant, this.adapterPath, this.lm)} → ${engineLabel(desiredVariant, desiredAdapter, desiredLm)}`,
      )
      await this.stop('切换模型')
    }
    const engine = await this.start(desiredVariant, { adapterPath: desiredAdapter, lm: desiredLm, signal, onProgress })
    this.busy = true
    this.clearIdleTimer()
    this.touch()
    return engine
  }

  async start(variant, { adapterPath, lm = false, signal, onProgress } = {}) {
    throwIfAborted(signal)
    const ditPath = MODEL_DITS[variant]
    const adapter = adapterPath || null
    const useLm = Boolean(lm)
    await onProgress?.(0.15, `引擎启动中（${engineLabel(variant, adapter, useLm)}）`)
    throwIfAborted(signal)
    const [portMin, portMax] = this.portRange
    const port = await pickFreePortInRange(portMin, portMax)
    const baseUrl = `http://127.0.0.1:${port}`
    const logPath = path.join(os.tmpdir(), `aiab-companion-ace-${process.pid}-${port}.log`)
    let logStream
    try {
      logStream = createWriteStream(logPath, { flags: 'w' })
    } catch {
      logStream = null
    }
    this.logPath = logPath
    this.logStream = logStream
    this.logTail = ''
    this.spawnError = null
    this.variant = variant
    this.adapterPath = adapter
    this.lm = useLm
    this.port = port
    this.baseUrl = baseUrl
    this.startedAt = this.now()
    this.lastUsedAt = this.startedAt
    this.state = 'starting'
    const appendLog = (chunk) => {
      try {
        logStream?.write(chunk)
      } catch {
        /* ignore */
      }
      this.logTail = `${this.logTail}${chunk.toString('utf8')}`.slice(-4000)
    }
    const args = [
      '--host', '127.0.0.1',
      '--port', String(port),
      '--sleep', '300',
      '--embedding', MODEL_AUX.embedding,
      '--dit', ditPath,
      '--vae', MODEL_AUX.vae,
    ]
    if (adapter) args.push('--lora', adapter, '--lora-scale', '1.0')
    if (useLm) {
      if (!existsSync(MODEL_AUX.lm)) {
        this.state = 'stopped'
        this.closeLogStream()
        throw new Error(`质量模式需要 LM 模型，但文件不存在：${MODEL_AUX.lm}`)
      }
      args.push('--lm', MODEL_AUX.lm)
    }
    this.log(`启动 ACE-Step：variant=${engineLabel(variant, adapter, useLm)} port=${port} 日志=${logPath}`)
    if (variant === 'base') {
      this.log('base 变体用于 lego 分轨（generate_stem），冷启动较慢（真机实测 ~36s），请耐心等待…')
    }
    let child
    try {
      child = this.spawnImpl(ACESTEP_BIN, args, {
        cwd: ACESTEP_DIR,
        env: { ...process.env, GGML_BACKEND: ACESTEP_BACKEND },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      this.state = 'stopped'
      this.closeLogStream()
      throw new Error(`启动 ACE-Step 失败：${readableError(error)}`)
    }
    this.child = child
    child.once('error', (error) => {
      this.spawnError = error
    })
    child.stdout?.on('data', appendLog)
    child.stderr?.on('data', appendLog)
    child.once('exit', (code) => {
      if (this.child !== child) return
      this.log(`⚠ 引擎进程意外退出（variant=${engineLabel(this.variant, this.adapterPath)} code=${code}），下一任务将自动重启`)
      this.child = null
      this.state = 'crashed'
      this.variant = null
      this.adapterPath = null
      this.lm = false
      this.port = null
      this.baseUrl = null
      this.closeLogStream()
    })
    try {
      await waitForAceHealth({
        base: baseUrl,
        child,
        getSpawnError: () => this.spawnError,
        signal,
        logTail: () => this.logTail,
        fetchImpl: this.fetchImpl,
      })
      if (this.child !== child) throw new Error('ACE-Step 启动失败：进程提前退出')
      this.state = 'ready'
      const elapsed = ((this.now() - this.startedAt) / 1000).toFixed(1)
      this.log(`ACE-Step 就绪（variant=${engineLabel(variant, adapter, useLm)} pid=${child.pid} ${elapsed}s）`)
      return { variant, adapterPath: adapter ?? undefined, lm: useLm, pid: child.pid, warm: false, baseUrl, startedAt: this.startedAt }
    } catch (error) {
      await this.stop('启动失败')
      throw error
    }
  }

  /** 正常停止（空闲/切换/退出）：terminate → 超时 kill。 */
  async stop(reason, { graceMs = 15_000 } = {}) {
    this.clearIdleTimer()
    this.busy = false
    const child = this.child
    const variant = this.variant
    this.child = null
    this.state = 'stopped'
    this.variant = null
    this.adapterPath = null
    this.lm = false
    this.port = null
    this.baseUrl = null
    if (child) {
      this.log(`停止引擎${variant ? `（${variant}）` : ''}：${reason}`)
      const disposal = await terminateChild(child, { graceMs, log: this.log })
      this.log(`引擎已停止（${disposal}）`)
    }
    this.closeLogStream()
  }

  /** 取消任务：推理无法安全中断，直接杀进程；下一任务会冷启动。 */
  async kill(reason) {
    await this.stop(`终止进程（${reason}；推理无法安全中断）`, { graceMs: 3000, killMs: 2000 })
  }

  /** 任务结束：记录空闲起点并按 idleMs 安排自动退出。 */
  release() {
    this.busy = false
    this.touch()
    if (this.child) this.scheduleIdleCheck()
  }

  async shutdown(reason = 'Companion 退出') {
    await this.stop(reason)
  }
}

/* ------------------------------------------------------------------ */
/* 执行器                                                              */
/* ------------------------------------------------------------------ */

/** mock 执行器：无 GPU 下验证注册/心跳/claim/progress/complete 全链路（含 repaint）。 */
export function createMockExecutor() {
  return {
    kind: 'mock',
    name: 'mock（无 GPU 自检）',
    capabilities: buildCapabilities('mock'),
    async run(task, ctx) {
      if (!TASKS.includes(task.type)) throw new Error(`mock 执行器不支持任务类型：${task.type}`)
      ctx.log(`mock：生成 2 秒 440Hz 立体声 48k WAV（${task.type}）`)
      await ctx.progress(0.2, '生成音频（mock）')
      throwIfAborted(ctx.signal)
      const file = createMockWav()
      await abortableSleep(200, ctx.signal)
      await ctx.progress(0.6, '写入 RIFF 头（mock）')
      await abortableSleep(200, ctx.signal)
      throwIfAborted(ctx.signal)
      await ctx.progress(1, '完成（mock）')
      ctx.log(`mock：WAV ${file.length} 字节`)
      let fileName
      if (task.type === TASK_TYPE_REPAINT) {
        fileName = `repaint-${sanitizeFileName(task.id)}.wav`
      } else if (task.type === TASK_TYPE_STEM) {
        const arm = typeof task.params?.arm === 'string' && task.params.arm.trim() ? sanitizeFileName(task.params.arm) : 'stem'
        fileName = `stem-${arm}-${sanitizeFileName(task.id)}.wav`
      } else if (task.type === TASK_TYPE_COVER) {
        fileName = `cover-${sanitizeFileName(task.id)}.wav`
      } else {
        fileName = `${sanitizeFileName(task.id)}.wav`
      }
      return { file, fileName }
    },
  }
}

/** 从 task.params 取服务端下发的 LoRA 目录（纯函数；空/非字符串返回 undefined）。 */
export function resolveAdapterPath(params = {}) {
  return typeof params?.adapterPath === 'string' && params.adapterPath.trim() ? params.adapterPath.trim() : undefined
}

/** 领取/复用引擎（引擎启动进度由 EngineManager 经 onProgress 上报 0.15）。 */
async function acquireEngine({ ctx, engineManager, variant, adapterPath, lm = false }) {
  const startedAt = Date.now()
  const engine = await engineManager.ensure(variant, {
    adapterPath,
    lm,
    signal: ctx.signal,
    onProgress: (progress, message) => ctx.progress(progress, message),
  })
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
  const label = engineLabel(variant, adapterPath, lm)
  ctx.log(
    engine.warm ? `复用常驻引擎（${label}，pid=${engine.pid}）` : `引擎就绪（${label}，pid=${engine.pid}，${elapsedSec}s）`,
  )
  return engine
}

function logAdapterUsage(ctx, params, adapterPath) {
  if (!params?.adapterId) return
  ctx.log(
    adapterPath
      ? `LoRA 适配器：adapterId=${params.adapterId} → 启动引擎时 --lora ${adapterPath}`
      : `LoRA 适配器：adapterId=${params.adapterId}（服务端未下发 adapterPath，按基座执行）`,
  )
}

/**
 * cover_audio 参数校验（P7-B）：源资产 + 描述必填，strength 归一化 0–1（缺省 0.8）。
 * 在启动引擎/下载之前调用，参数错立刻 failed（不浪费 GPU）。
 */
export function validateCoverParams(params = {}) {
  const sourceAssetId = typeof params.sourceAssetId === 'string' ? params.sourceAssetId.trim() : ''
  if (!sourceAssetId) throw new Error('cover_audio 需要 params.sourceAssetId（要重编的音频资产）')
  const caption = typeof params.caption === 'string' ? params.caption.trim() : ''
  if (!caption) throw new Error('cover_audio 需要 params.caption（希望变成什么编制/风格）')
  const rawStrength = Number(params.audioCoverStrength)
  const strength = Number.isFinite(rawStrength) ? Math.min(1, Math.max(0, rawStrength)) : 0.8
  return {
    sourceAssetId,
    caption,
    strength,
    seed: Number.isInteger(params.seed) && params.seed >= 0 ? params.seed : resolveSeed(params.seed),
    sourceDurationSec: Number.isFinite(Number(params.sourceDurationSec)) ? Number(params.sourceDurationSec) : undefined,
  }
}

/** cover_audio 的 /synth 请求（multipart 的 request 字段）：保结构换编制。 */
export function buildCoverRequest(validated) {
  return {
    caption: validated.caption,
    lyrics: '[Instrumental]',
    seed: validated.seed,
    batch_size: 1,
    audio_cover_strength: validated.strength,
    inference_steps: 8,
    guidance_scale: 1.0,
    shift: 1.0,
  }
}

/**
 * 质量档（P7-A）第一步：/lm 提示词增强 + 生成语义 codes。
 * 网络/服务错误转成可读中文；取消沿用 ctx.signal。
 */
async function postLm({ ctx, baseUrl, body, timeoutMs = ACESTEP_LM_TIMEOUT_MS }) {
  let response
  try {
    response = await fetch(`${baseUrl}/lm`, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ctx.signal]),
    })
  } catch (error) {
    if (ctx.isCanceled?.()) throw new CancelledError(ctx.cancelReason?.() ?? '用户取消')
    if (error?.name === 'TimeoutError') throw new Error(`ACE-Step /lm 超时（${Math.round(timeoutMs / 1000)}s）`)
    throw new Error(`调用 ACE-Step /lm 失败：${fetchFailureDetail(error)}`)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`ACE-Step /lm 失败（HTTP ${response.status}）：${truncate(text, 300)}`)
  }
  let parsed
  try {
    parsed = await response.json()
  } catch {
    throw new Error('ACE-Step /lm 返回的不是 JSON')
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed
  if (!first || typeof first !== 'object') throw new Error('ACE-Step /lm 返回为空')
  return first
}

/**
 * 合成请求 + 期间进度/取消轮询：
 * - 每 ~2s progress 0.3→0.9 估算值；
 * - progress 返回 cancel 时 AbortController.abort() 中止 HTTP，并杀掉引擎进程；
 * - 取消统一抛 CancelledError(用户取消)，由 handleTask 转成 complete(failed)。
 */
async function postSynthWithProgress({
  ctx,
  engineManager,
  baseUrl,
  body,
  contentType,
  timeoutMs,
  estimatedMs,
  label,
}) {
  const startedAt = Date.now()
  const pollAbort = new AbortController()
  let canceled = false
  const pollTask = (async () => {
    while (!pollAbort.signal.aborted) {
      try {
        await abortableSleep(SYNTH_PROGRESS_INTERVAL_MS, AbortSignal.any([pollAbort.signal, ctx.signal]))
      } catch {
        return
      }
      if (pollAbort.signal.aborted) return
      const progress = estimateProgress({ elapsedMs: Date.now() - startedAt, estimatedMs })
      try {
        await ctx.progress(progress, `${label} ${Math.round(progress * 100)}%（估算）`)
      } catch (error) {
        if (error instanceof CancelledError) {
          canceled = true
          pollAbort.abort()
          await engineManager.kill('用户取消')
          return
        }
        /* 进度上报的网络/会话问题不致命，继续生成 */
      }
    }
  })()
  try {
    const headers = { 'User-Agent': USER_AGENT }
    if (contentType) headers['Content-Type'] = contentType
    const response = await fetch(`${baseUrl}/synth?wav=1`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ctx.signal, pollAbort.signal]),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`ACE-Step /synth 失败（HTTP ${response.status}）：${truncate(text, 300)}`)
    }
    const file = Buffer.from(await response.arrayBuffer())
    try {
      readWavInfo(file)
    } catch {
      throw new Error(`ACE-Step 返回的不是有效 WAV（${file.length} 字节）`)
    }
    return file
  } catch (error) {
    if (canceled || ctx.isCanceled()) {
      await engineManager.kill(ctx.cancelReason())
      throw new CancelledError(ctx.cancelReason())
    }
    if (error?.name === 'TimeoutError') throw new Error(`ACE-Step /synth 超时（${Math.round(timeoutMs / 1000)}s）`)
    if (error?.name === 'AbortError') throw new Error('ACE-Step /synth 请求被中断')
    if (error instanceof Error && error.message.startsWith('ACE-Step')) throw error
    throw new Error(`调用 ACE-Step /synth 失败：${fetchFailureDetail(error)}`)
  } finally {
    pollAbort.abort()
    try {
      await pollTask
    } catch {
      /* ignore */
    }
  }
}

/** 合成完成 → progress(1)；此刻若服务端要求取消，同样杀引擎并按取消处理。 */
async function reportCompletionProgress({ ctx, engineManager }) {
  try {
    await ctx.progress(1, '完成')
  } catch (error) {
    if (error instanceof CancelledError) {
      await engineManager.kill(ctx.cancelReason())
      throw new CancelledError(ctx.cancelReason())
    }
    throw error
  }
}

/** 下载源资产到临时文件（repaint 用）；返回 { tempFile, bytes }，调用方负责 unlink。 */
async function downloadSourceToTemp({ serverUrl, sourceAssetId, ctx }) {
  const url = `${serverUrl}/api/assets/${encodeURIComponent(sourceAssetId)}/file`
  let response
  try {
    response = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(SOURCE_DOWNLOAD_TIMEOUT_MS), ctx.signal]) })
  } catch (error) {
    if (ctx.isCanceled()) throw new CancelledError(ctx.cancelReason())
    throw new Error(`下载源音频失败：${fetchFailureDetail(error)}`)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`下载源音频失败（HTTP ${response.status}）：${truncate(text, 300)}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  try {
    readWavInfo(bytes)
  } catch (error) {
    throw new Error(`源资产不是有效 WAV（${readableError(error)}）`)
  }
  const tempFile = path.join(
    os.tmpdir(),
    `aiab-companion-src-${sanitizeFileName(sourceAssetId)}-${process.pid}-${Date.now()}.wav`,
  )
  writeFileSync(tempFile, bytes)
  return { tempFile, bytes }
}

/**
 * 生产执行器：常驻引擎 + generate_audio / repaint_audio。
 * 引擎生命周期由共享的 EngineManager 管理（跨任务复用，变体切换才重启）。
 */
export function createAceStepExecutor({ serverUrl, engineManager, log = () => {} } = {}) {
  if (!engineManager) throw new Error('createAceStepExecutor 需要 engineManager（常驻引擎管理器）')
  return {
    kind: 'acestep',
    name: 'ACE-Step（本地 GPU，常驻引擎）',
    capabilities: buildCapabilities('acestep'),
    async run(task, ctx) {
      const preflight = preflightAceStep()
      if (!preflight.ok) throw new Error(preflight.message)
      if (task.type === TASK_TYPE_GENERATE) return runGenerate(task, ctx, { engineManager })
      if (task.type === TASK_TYPE_REPAINT) return runRepaint(task, ctx, { engineManager, serverUrl })
      if (task.type === TASK_TYPE_STEM) return runStem(task, ctx, { engineManager, serverUrl })
      if (task.type === TASK_TYPE_COVER) return runCover(task, ctx, { engineManager, serverUrl })
      throw new Error(`ACE-Step 执行器不支持任务类型：${task.type}`)
    },
  }
}

async function runGenerate(task, ctx, { engineManager }) {
  const params = task.params ?? {}
  const adapterPath = resolveAdapterPath(params)
  const quality = params.quality === true
  if (quality && adapterPath) {
    throw new Error('质量模式使用 sft 基座，暂不支持 turbo LoRA 适配器：请关闭适配器，或改用快模式')
  }
  if (quality && !existsSync(MODEL_AUX.lm)) {
    throw new Error(`质量模式需要 LM 模型，但文件不存在：${path.relative(ROOT, MODEL_AUX.lm)}`)
  }
  logAdapterUsage(ctx, params, adapterPath)
  const variant = quality ? 'sft' : 'turbo'
  const payload = quality ? buildQualityLmRequest(params) : buildSynthPayload(params)
  ctx.log(
    `执行 generate_audio（${engineLabel(variant, adapterPath, quality)}，${payload.duration}s / ${payload.bpm ?? params.bpm ?? '?'} BPM / ${payload.keyscale ?? params.keyscale ?? '?'}${quality ? '，质量模式：LM→sft 50 步' : ''}）`,
  )
  await ctx.progress(0.05, '准备任务')
  const engine = await acquireEngine({ ctx, engineManager, variant, adapterPath, lm: quality })
  try {
    if (quality) {
      await ctx.progress(0.3, engine.warm ? '复用常驻引擎（sft+LM）' : '开始质量合成（sft+LM）')
      const lmStartedAt = Date.now()
      const lmResult = await postLm({ ctx, baseUrl: engine.baseUrl, body: JSON.stringify(payload) })
      const codeLen = typeof lmResult.audio_codes === 'string' ? lmResult.audio_codes.length : 0
      ctx.log(`LM 返回字段：${Object.keys(lmResult).join(',')}（audio_codes ${codeLen} 字符）`)
      const synthRequest = buildQualitySynthRequest(lmResult, params)
      ctx.log(
        `LM 完成（${((Date.now() - lmStartedAt) / 1000).toFixed(1)}s）：bpm=${synthRequest.bpm ?? '?'} key=${synthRequest.keyscale ?? '?'} → sft ${QUALITY_STEPS} 步合成`,
      )
      await ctx.progress(0.4, '合成中（质量模式 50 步）')
      const estimatedMs = Math.max(20_000, estimateGenerationSeconds({ type: TASK_TYPE_GENERATE, params }) * 1000)
      const file = await postSynthWithProgress({
        ctx,
        engineManager,
        baseUrl: engine.baseUrl,
        body: JSON.stringify(synthRequest),
        contentType: 'application/json',
        timeoutMs: ACESTEP_SYNTH_TIMEOUT_MS,
        estimatedMs,
        label: '质量合成中',
      })
      await reportCompletionProgress({ ctx, engineManager })
      return { file, fileName: `${sanitizeFileName(task.id)}.wav` }
    }

    await ctx.progress(0.3, engine.warm ? `复用常驻引擎（${engineLabel('turbo', adapterPath)}）` : '开始生成音频（turbo）')
    const estimatedMs = estimateGenerationSeconds({ type: TASK_TYPE_GENERATE, params }) * 1000
    const file = await postSynthWithProgress({
      ctx,
      engineManager,
      baseUrl: engine.baseUrl,
      body: JSON.stringify(payload),
      contentType: 'application/json',
      timeoutMs: ACESTEP_SYNTH_TIMEOUT_MS,
      estimatedMs,
      label: '生成中',
    })
    await reportCompletionProgress({ ctx, engineManager })
    return { file, fileName: `${sanitizeFileName(task.id)}.wav` }
  } finally {
    engineManager.release()
  }
}

async function runRepaint(task, ctx, { engineManager, serverUrl }) {
  const params = task.params ?? {}
  const adapterPath = resolveAdapterPath(params)
  logAdapterUsage(ctx, params, adapterPath)
  // 1) 引擎启动前先做基本参数校验（服务端若已下发 sourceDurationSec，可提前拦住越界区间，省一次下载）
  const serverDuration = Number(params.sourceDurationSec)
  const basicOptions = Number.isFinite(serverDuration) && serverDuration > 0 ? { sourceDurationSec: serverDuration } : {}
  const basic = validateRepaintParams(params, basicOptions)
  if (basic.style) ctx.log(`style=${basic.style}（仅记录，未参与引擎参数）`)
  ctx.log(`执行 repaint_audio（${engineLabel('sft', adapterPath)}）：source=${basic.sourceAssetId} ${basic.startSec}-${basic.endSec}s`)
  await ctx.progress(0.05, '下载源音频')
  const source = await downloadSourceToTemp({ serverUrl, sourceAssetId: basic.sourceAssetId, ctx })
  try {
    const info = readWavInfo(source.bytes)
    // 2) 拿到源时长后再校验 endSec 不越界（这一步仍在启动引擎之前）
    const validated = validateRepaintParams(params, { sourceDurationSec: info.durationSec })
    ctx.log(`源音频 ${info.durationSec.toFixed(2)}s / ${info.sampleRate}Hz / ${info.channels}ch`)
    const engine = await acquireEngine({ ctx, engineManager, variant: 'sft', adapterPath: validated.adapterPath })
    try {
      const regionSec = (validated.endSec - validated.startSec).toFixed(1)
      await ctx.progress(
        0.3,
        `开始重绘 ${validated.startSec}-${validated.endSec}s（${engineLabel('sft', validated.adapterPath)}，${regionSec}s）`,
      )
      const request = buildRepaintRequest(validated)
      const sourceAudio = readFileSync(source.tempFile)
      const multipart = buildSynthMultipart({
        request,
        audio: sourceAudio,
        fileName: path.basename(source.tempFile),
      })
      const estimatedMs = estimateGenerationSeconds({ type: TASK_TYPE_REPAINT, params: validated }) * 1000
      const file = await postSynthWithProgress({
        ctx,
        engineManager,
        baseUrl: engine.baseUrl,
        body: multipart.body,
        contentType: multipart.contentType,
        timeoutMs: ACESTEP_SYNTH_TIMEOUT_MS,
        estimatedMs,
        label: '重绘中',
      })
      await reportCompletionProgress({ ctx, engineManager })
      return { file, fileName: `repaint-${sanitizeFileName(task.id)}.wav` }
    } finally {
      engineManager.release()
    }
  } finally {
    try {
      unlinkSync(source.tempFile)
    } catch {
      /* ignore */
    }
  }
}

/**
 * generate_stem：用 base 变体做 lego 分轨（multipart request+audio）。
 * 注意：ACE-Step 输出的是「该 arm 独立生成的 stem」，不是源+stem 混音，也不保证与源音频逐样本对齐。
 */
async function runCover(task, ctx, { engineManager, serverUrl }) {
  const params = task.params ?? {}
  const validated = validateCoverParams(params)
  ctx.log(
    `执行 cover_audio（${engineLabel('turbo')}）：source=${validated.sourceAssetId} strength=${validated.strength.toFixed(2)}`,
  )
  await ctx.progress(0.05, '下载源音频')
  const source = await downloadSourceToTemp({ serverUrl, sourceAssetId: validated.sourceAssetId, ctx })
  try {
    const info = readWavInfo(source.bytes)
    ctx.log(`源音频 ${info.durationSec.toFixed(2)}s / ${info.sampleRate}Hz / ${info.channels}ch`)
    const engine = await acquireEngine({ ctx, engineManager, variant: 'turbo' })
    try {
      await ctx.progress(0.15, engine.warm ? '复用常驻引擎（turbo）' : '开始重编（cover）')
      const request = buildCoverRequest({
        ...validated,
        sourceDurationSec: info.durationSec,
      })
      const multipart = buildSynthMultipart({
        request,
        audio: source.bytes,
        fileName: path.basename(source.tempFile),
      })
      const estimatedMs = Math.max(12_000, estimateGenerationSeconds({ type: TASK_TYPE_COVER, params: validated }) * 1000)
      const file = await postSynthWithProgress({
        ctx,
        engineManager,
        baseUrl: engine.baseUrl,
        body: multipart.body,
        contentType: multipart.contentType,
        timeoutMs: ACESTEP_SYNTH_TIMEOUT_MS,
        estimatedMs,
        label: '重编中（cover）',
      })
      await reportCompletionProgress({ ctx, engineManager })
      ctx.log(`cover_audio 完成：${(file.length / 1024 / 1024).toFixed(2)}MB（保结构换编制，原旋律走向可调 strength）`)
      return { file, fileName: `cover-${sanitizeFileName(task.id)}.wav` }
    } finally {
      engineManager.release()
    }
  } finally {
    try {
      unlinkSync(source.tempFile)
    } catch {
      /* ignore */
    }
  }
}

async function runStem(task, ctx, { engineManager, serverUrl }) {
  const params = task.params ?? {}
  // 1) 启动引擎/下载源音频前先校验 arm 与 sourceAssetId（非法 arm 直接 failed）
  const validated = validateStemParams(params)
  const adapterPath = validated.adapterPath
  logAdapterUsage(ctx, params, adapterPath)
  if (!existsSync(MODEL_DITS.base)) {
    throw new Error(`generate_stem 需要 base 模型，但文件不存在：${path.relative(ROOT, MODEL_DITS.base)}`)
  }
  ctx.log(`执行 generate_stem（${engineLabel('base', adapterPath)}，arm=${validated.arm}）：source=${validated.sourceAssetId}`)
  ctx.log('说明：输出是该 arm 独立生成的 stem（不是源音频+stem 混音），不保证与源音频逐样本对齐')
  await ctx.progress(0.05, '下载源音频')
  const source = await downloadSourceToTemp({ serverUrl, sourceAssetId: validated.sourceAssetId, ctx })
  try {
    const info = readWavInfo(source.bytes)
    ctx.log(`源音频 ${info.durationSec.toFixed(2)}s / ${info.sampleRate}Hz / ${info.channels}ch`)
    const engine = await acquireEngine({ ctx, engineManager, variant: 'base', adapterPath })
    try {
      await ctx.progress(0.3, `开始拆分 ${validated.arm}（${engineLabel('base', adapterPath)}）`)
      const request = buildLegoRequest(validated)
      const sourceAudio = readFileSync(source.tempFile)
      const multipart = buildSynthMultipart({
        request,
        audio: sourceAudio,
        fileName: path.basename(source.tempFile),
      })
      const estimatedMs =
        estimateGenerationSeconds({
          type: TASK_TYPE_STEM,
          params: { ...params, sourceDurationSec: info.durationSec },
        }) * 1000
      const startedAt = Date.now()
      const file = await postSynthWithProgress({
        ctx,
        engineManager,
        baseUrl: engine.baseUrl,
        body: multipart.body,
        contentType: multipart.contentType,
        timeoutMs: ACESTEP_SYNTH_TIMEOUT_MS,
        estimatedMs,
        label: `拆分 ${validated.arm}`,
      })
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
      await reportCompletionProgress({ ctx, engineManager })
      ctx.log(
        `generate_stem 完成：arm=${validated.arm} ${(file.length / 1e6).toFixed(2)}MB ${elapsedSec}s（独立 stem，非混音）`,
      )
      return { file, fileName: `stem-${validated.arm}-${sanitizeFileName(task.id)}.wav` }
    } finally {
      engineManager.release()
    }
  } finally {
    try {
      unlinkSync(source.tempFile)
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 协议客户端                                                           */
/* ------------------------------------------------------------------ */

/** complete 的 multipart 表单（Node 24 内置 FormData/Blob，无三方依赖）。 */
export function buildCompleteForm({ workerId, token, taskId, status, error, file, fileName }) {
  const form = new FormData()
  form.append('workerId', String(workerId))
  form.append('token', String(token))
  form.append('taskId', String(taskId))
  form.append('status', status === 'failed' ? 'failed' : 'done')
  if (status === 'failed') form.append('error', readableError(new Error(error || '未知错误')))
  if (file && file.length > 0) {
    form.append('file', new Blob([file], { type: 'audio/wav' }), normalizeWavFileName(fileName, taskId))
  }
  return form
}

export class CompanionClient {
  constructor({
    baseUrl,
    name,
    version = COMPANION_VERSION,
    executor = 'acestep',
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    pollMs = DEFAULT_POLL_MS,
    log = () => {},
    shouldStop = () => false,
  }) {
    this.baseUrl = normalizeServerUrl(baseUrl)
    this.name = name
    this.version = version
    this.executor = executor
    this.heartbeatMs = heartbeatMs
    this.pollMs = pollMs
    this.log = log
    this.shouldStop = shouldStop
    this.workerId = ''
    this.token = ''
    /** 心跳/Session 失效标记：由心跳 401/403/404 或 claim 置位，主循环据此重新注册 */
    this.sessionExpired = false
  }

  authBody(extra = {}) {
    return buildAuthBody(this.workerId, this.token, extra)
  }

  async requestJson(pathname, { body, timeoutMs = REQUEST_TIMEOUT_MS, method = 'POST' } = {}) {
    const init = { method, signal: AbortSignal.timeout(timeoutMs) }
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT }
      init.body = JSON.stringify(body)
    }
    let response
    try {
      response = await fetch(`${this.baseUrl}${pathname}`, init)
    } catch (error) {
      throw normalizeFetchError(error)
    }
    if (response.status === 204) return null
    const text = await response.text().catch(() => '')
    let json = null
    if (text.trim()) {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }
    if (!response.ok) throw new HttpError(`HTTP ${response.status}：${truncate(text || response.statusText, 300)}`, response.status, text)
    if (json === null && text.trim()) throw new HttpError(`响应不是 JSON：${truncate(text, 200)}`, response.status, text)
    return json
  }

  /** 注册（幂等重试；404 视为服务端可能正在重启/升级，先重试再退出）。 */
  async register() {
    const body = buildRegisterBody({ name: this.name, version: this.version, executor: this.executor })
    const doRegister = async () => {
      const json = await this.requestJson('/api/companion/register', { body })
      if (!json || typeof json !== 'object') throw new Error('注册响应不是 JSON 对象')
      const workerId = typeof json.workerId === 'string' ? json.workerId : json.worker?.id
      if (typeof workerId !== 'string' || !workerId) throw new Error('注册响应缺少 workerId')
      if (typeof json.token !== 'string' || !json.token) throw new Error('注册响应缺少 token')
      this.workerId = workerId
      this.token = json.token
      this.sessionExpired = false
      const timing = normalizePollTiming(json)
      this.heartbeatMs = timing.heartbeatMs
      this.pollMs = timing.pollMs
      return { workerId: this.workerId, heartbeatMs: this.heartbeatMs, pollMs: this.pollMs }
    }
    try {
      return await withRetry(
        async () => {
          // 404 单独重试：服务端重启/升级的窗口期（最多约 1 分钟），避免工作节点被一次重启打死
          for (let attempt = 0; ; attempt++) {
            try {
              return await doRegister()
            } catch (error) {
              const retry404 = error instanceof HttpError && error.status === 404 && attempt < 8
              if (!retry404) throw error
              if (this.shouldStop?.()) throw new CancelledError('已停止（注册）')
              const delay = backoffDelay(attempt, { baseMs: 1_000, maxMs: 10_000 })
              this.log?.(`⚠ 注册收到 HTTP 404（服务端可能正在重启/升级），${Math.round(delay / 100) / 10}s 后重试（第 ${attempt + 1} 次）`)
              await sleep(delay)
            }
          }
        },
        { label: '注册', attempts: Infinity, shouldStop: this.shouldStop, log: this.log },
      )
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        throw new Error(
          `注册失败：服务端没有 Companion 协议路由（HTTP 404，已重试 8 次）。请确认服务端已升级并重启，且 --server 指向正确（当前 ${this.baseUrl}）。`,
        )
      }
      throw error
    }
  }

  async heartbeat(status) {
    try {
      const json = await this.requestJson('/api/companion/heartbeat', { body: this.authBody({ status }) })
      return json ?? { ok: true }
    } catch (error) {
      throw toSessionExpired(error, '心跳')
    }
  }

  /** 204 → null（无任务）；否则返回任务信封。网络错误无限重试。 */
  async claim() {
    try {
      const json = await withRetry(
        () => this.requestJson('/api/companion/claim', { body: this.authBody() }),
        { label: 'claim', attempts: Infinity, shouldStop: this.shouldStop, log: this.log },
      )
      return parseTaskEnvelope(json)
    } catch (error) {
      throw toSessionExpired(error, 'claim')
    }
  }

  /** 只读队列概览（GET，无鉴权）；失败返回 null，避免空闲诊断刷屏。 */
  async getCompanionStatus() {
    try {
      return await this.requestJson('/api/companion/status', { method: 'GET', timeoutMs: 5000 })
    } catch {
      return null
    }
  }

  async progress(taskId, progress, message) {
    try {
      const json = await withRetry(
        () =>
          this.requestJson('/api/companion/progress', {
            body: this.authBody({ taskId, progress: clampProgress(progress), message: message || undefined }),
          }),
        { label: 'progress', attempts: 3, baseMs: 300, maxMs: 3000, shouldStop: this.shouldStop, log: this.log },
      )
      return json ?? { ok: true }
    } catch (error) {
      throw toSessionExpired(error, 'progress')
    }
  }

  /** multipart/form-data 上传结果；done 必须带 file，failed 必须带 error。 */
  async complete({ taskId, status = 'done', error, file, fileName }) {
    try {
      return await withRetry(
        async () => {
          const form = buildCompleteForm({
            workerId: this.workerId,
            token: this.token,
            taskId,
            status,
            error,
            file,
            fileName,
          })
          let response
          try {
            response = await fetch(`${this.baseUrl}/api/companion/complete`, {
              method: 'POST',
              body: form,
              signal: AbortSignal.timeout(COMPLETE_TIMEOUT_MS),
            })
          } catch (fetchError) {
            throw normalizeFetchError(fetchError)
          }
          if (response.status === 204) return { ok: true }
          const text = await response.text().catch(() => '')
          let json = null
          if (text.trim()) {
            try {
              json = JSON.parse(text)
            } catch {
              json = null
            }
          }
          if (!response.ok) throw new HttpError(`HTTP ${response.status}：${truncate(text || response.statusText, 300)}`, response.status, text)
          if (json && json.ok === false) throw new Error(`complete 被拒绝：${json.error ?? truncate(text, 200)}`)
          return json ?? { ok: true }
        },
        { label: 'complete', attempts: 4, shouldStop: this.shouldStop, log: this.log },
      )
    } catch (completeError) {
      throw toSessionExpired(completeError, 'complete')
    }
  }

  /**
   * 心跳定时器：每 heartbeatMs 上报 busy/currentTaskId/engine；
   * cancelTaskIds 命中当前任务时回调 onCancelTaskIds。
   */
  startHeartbeat(getStatus, { onCancelTaskIds } = {}) {
    let stopped = false
    let inFlight = false
    const tick = async () => {
      if (stopped || inFlight) return
      inFlight = true
      try {
        const response = await this.heartbeat(getStatus())
        const cancelTaskIds = response?.cancelTaskIds
        if (Array.isArray(cancelTaskIds) && cancelTaskIds.length) onCancelTaskIds?.(cancelTaskIds)
      } catch (heartbeatError) {
        // 服务端重启后 claim 可能仍返回 204，心跳的 401 是唯一可靠的失效信号：
        // 只置标记，由主循环在两次 claim 之间重新注册，避免打断在途任务。
        if (heartbeatError instanceof SessionExpiredError) this.sessionExpired = true
        this.log(`⚠ 心跳失败：${readableError(heartbeatError)}${this.sessionExpired ? '（等待重新注册）' : ''}`)
      } finally {
        inFlight = false
      }
    }
    const timer = setInterval(tick, this.heartbeatMs)
    timer.unref?.()
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }
}

/* ------------------------------------------------------------------ */
/* 任务执行                                                             */
/* ------------------------------------------------------------------ */

async function handleTask(task, executor, client, state, log) {
  const priority = normalizePriority(task.priority)
  const requiredVariant = task.requiredVariant ?? inferRequiredVariant(task.type, task.params)
  const arm = typeof task.params?.arm === 'string' && task.params.arm.trim() ? task.params.arm.trim() : null
  log(
    `认领任务 ${task.id}（${task.type}，priority=${priority}，requiredVariant=${requiredVariant ?? '未指定'}${
      arm ? `，arm=${arm}` : ''
    }）`,
    { taskId: task.id },
  )
  const expectedVariant = inferRequiredVariant(task.type, task.params)
  if (requiredVariant && expectedVariant && requiredVariant !== expectedVariant) {
    log(`⚠ requiredVariant=${requiredVariant} 与任务类型推断（${expectedVariant}）不一致，按任务类型执行`, {
      taskId: task.id,
    })
  }
  const controller = new AbortController()
  state.currentTaskId = task.id
  state.cancelRequested = false
  state.cancelReason = null
  state.activeAbort = controller
  const runCtx = {
    signal: controller.signal,
    isCanceled: () => state.cancelRequested || controller.signal.aborted,
    cancelReason: () => state.cancelReason || '用户取消',
    log: (message) => log(message, { taskId: task.id }),
    progress: async (value, message) => {
      const progress = clampProgress(value)
      log(`进度 ${Math.round(progress * 100)}%${message ? ` · ${message}` : ''}`, { taskId: task.id })
      let response
      try {
        response = await client.progress(task.id, progress, message)
      } catch (error) {
        if (error instanceof SessionExpiredError) throw error
        log(`progress 上报失败（不影响生成）：${readableError(error)}`, { taskId: task.id })
        return
      }
      if (isCancelSignal(response)) {
        state.cancelRequested = true
        state.cancelReason = '用户取消'
        controller.abort()
        throw new CancelledError('用户取消')
      }
    },
  }
  let succeeded = false
  try {
    const result = await executor.run(task, runCtx)
    if (!result?.file?.length) throw new Error('执行器没有产出音频数据')
    const completeResult = await client.complete({
      taskId: task.id,
      status: 'done',
      file: result.file,
      fileName: result.fileName,
    })
    succeeded = true
    log(`任务完成${completeResult?.assetId ? `，assetId=${completeResult.assetId}` : ''}`, { taskId: task.id })
  } catch (error) {
    const reason = error instanceof CancelledError ? error.message : runCtx.isCanceled() ? runCtx.cancelReason() : readableError(error)
    log(`任务失败：${reason}`, { taskId: task.id })
    try {
      await client.complete({ taskId: task.id, status: 'failed', error: reason })
    } catch (completeError) {
      log(`complete(failed) 也失败：${readableError(completeError)}`, { taskId: task.id })
    }
  } finally {
    state.currentTaskId = null
    state.activeAbort = null
    state.cancelRequested = false
  }
  return succeeded
}

/**
 * 空闲时（claim 204）能力匹配自检：每 30s 至多查一次 GET /api/companion/status，
 * 用 blockedByCapability 判断队列里是否有本机不支持变体的任务，并节流提示，避免刷屏。
 */
async function checkCapabilityMismatch({ client, supportedVariants, watch, log, now = Date.now() }) {
  if (!shouldCheckCapabilityStatus({ now, lastCheckedAt: watch.lastStatusCheckAt })) return
  watch.lastStatusCheckAt = now
  const status = await client.getCompanionStatus()
  if (!status) return
  const gaps = detectCapabilityGaps({ blockedByCapability: status.blockedByCapability, supportedVariants })
  if (gaps.length === 0) {
    watch.lastHintAt = 0
    return
  }
  if (!shouldEmitThrottledLog({ now, lastAt: watch.lastHintAt })) return
  watch.lastHintAt = now
  log(formatCapabilityGapHint({ gaps, supportedVariants }))
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * 主循环：注册 → 心跳 → claim → 执行 → complete。
 * acestep 模式下创建并持有常驻 EngineManager，退出时在 finally 回收。
 */
export async function runCompanion(options, { log = createLogger(), executor } = {}) {
  const name = options.name || os.hostname() || '未命名设备'
  const serverUrl = normalizeServerUrl(options.server)
  let engineManager = null
  let activeExecutor = executor
  if (!activeExecutor) {
    if (options.executor === 'mock') {
      activeExecutor = createMockExecutor()
    } else {
      const preflight = preflightAceStep()
      if (!preflight.ok) log(`⚠ ${preflight.message}（任务会以 failed 结束，而不是静默退出）`)
      engineManager = new EngineManager({
        idleMs: Math.round(Number(options.engineIdleSec ?? DEFAULT_ENGINE_IDLE_SEC) * 1000),
        log,
      })
      activeExecutor = createAceStepExecutor({ serverUrl, engineManager, log })
    }
  }
  const supportedVariants = Array.isArray(activeExecutor.capabilities?.models) ? [...activeExecutor.capabilities.models] : []
  log(
    `Companion 启动：executor=${activeExecutor.name} server=${serverUrl} name=${name} once=${options.once}` +
      (engineManager ? ` engineIdle=${Math.round(engineManager.idleMs / 1000)}s` : ''),
  )
  log(`能力上报：tasks=[${(activeExecutor.capabilities?.tasks ?? []).join(', ')}] models=[${supportedVariants.join(', ')}]`)

  const state = {
    stopping: false,
    currentTaskId: null,
    cancelRequested: false,
    cancelReason: null,
    activeAbort: null,
    capabilityWatch: { lastStatusCheckAt: 0, lastHintAt: 0 },
  }
  const client = new CompanionClient({
    baseUrl: serverUrl,
    name,
    version: COMPANION_VERSION,
    executor: options.executor,
    log,
    shouldStop: () => state.stopping,
  })

  const onSignal = (signal) => {
    if (state.stopping) return
    state.stopping = true
    state.cancelRequested = true
    state.cancelReason = 'Companion 退出，任务中断'
    log(`收到 ${signal}，正在停止${state.currentTaskId ? `（当前任务 ${state.currentTaskId}）` : ''}…`)
    state.activeAbort?.abort()
  }
  const sigint = () => onSignal('SIGINT')
  const sigterm = () => onSignal('SIGTERM')
  process.on('SIGINT', sigint)
  process.on('SIGTERM', sigterm)

  let stopHeartbeat = () => {}
  try {
    const registration = await client.register()
    log(`已注册：workerId=${registration.workerId} heartbeatMs=${registration.heartbeatMs} pollMs=${registration.pollMs} 版本=${COMPANION_VERSION}`)
    stopHeartbeat = client.startHeartbeat(
      () => ({
        busy: Boolean(state.currentTaskId),
        currentTaskId: state.currentTaskId ?? undefined,
        engine: engineManager?.heartbeatInfo(),
      }),
      {
        onCancelTaskIds: (taskIds) => {
          if (state.currentTaskId && taskIds.includes(state.currentTaskId)) {
            log(`服务端要求取消当前任务：${state.currentTaskId}`, { taskId: state.currentTaskId })
            state.cancelRequested = true
            state.cancelReason = '用户取消'
            state.activeAbort?.abort()
          }
        },
      },
    )

    while (!state.stopping) {
      if (client.sessionExpired) {
        client.sessionExpired = false
        log('会话已失效（心跳 401/403/404），重新注册…')
        await client.register()
        log(`已重新注册：workerId=${client.workerId}`)
        continue
      }
      let task
      try {
        task = await client.claim()
      } catch (claimError) {
        if (claimError instanceof CancelledError) break
        if (claimError instanceof SessionExpiredError) {
          log(`会话失效（${readableError(claimError)}），重新注册…`)
          await client.register()
          continue
        }
        log(`claim 失败：${readableError(claimError)}；${client.pollMs}ms 后重试`)
        await sleep(client.pollMs)
        continue
      }
      if (!task) {
        // 空闲：静默轮询；每 30s 至多查一次队列能力，判断是否有本机不支持变体的任务
        await checkCapabilityMismatch({
          client,
          supportedVariants,
          watch: state.capabilityWatch,
          log,
        })
        await sleep(client.pollMs)
        continue
      }
      const succeeded = await handleTask(task, activeExecutor, client, state, log)
      if (options.once) {
        log(`--once：已处理 1 个任务（${succeeded ? '成功' : '失败'}），退出`)
        return succeeded ? 0 : 1
      }
    }
    return 0
  } catch (error) {
    if (error instanceof CancelledError) return 0
    log(`✗ Companion 退出：${readableError(error)}`)
    return 1
  } finally {
    stopHeartbeat()
    state.activeAbort?.abort()
    if (engineManager) {
      try {
        await engineManager.shutdown('Companion 退出')
      } catch (error) {
        log(`⚠ 回收引擎失败：${readableError(error)}`)
      }
    }
    process.removeListener('SIGINT', sigint)
    process.removeListener('SIGTERM', sigterm)
    log('Companion 已停止')
  }
}

async function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  return runCompanion(options)
}

const invokedDirectly = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url : false
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      process.stderr.write(`${error?.stack ?? error}\n`)
      process.exitCode = 1
    })
}