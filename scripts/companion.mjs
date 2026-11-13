#!/usr/bin/env node
/**
 * Companion 工作节点进程（P2-A）：把 NAS/服务端的音频生成任务在本机 GPU 上执行。
 *
 *   node scripts/companion.mjs --server http://127.0.0.1:8899 --name "本机 GPU" [--mock|--engine] [--once]
 *
 * 协议（HTTP JSON 轮询，见 docs/COMPANION.md 与 docs/STUDIO_ARCHITECTURE.md §4）：
 *   register → 循环 [heartbeat / claim / progress / complete]
 *
 * 执行器：
 * - --mock      无 GPU 自检：generate_audio / repaint_audio 都返回 2 秒 440Hz 立体声 48k WAV。
 * - --engine    生产执行器（默认）：
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
import { execFileSync, spawn } from 'node:child_process'
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
/** 任务类型 → AI 音频生成引擎 DiT 变体（repaint 必须用 sft，lego 分轨必须用 base，cover 用 turbo） */
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
const PROVISIONED_ENGINE_DIR = path.join(DATA_ROOT, 'audio-engine')
/** 旧版自动安装目录（服务端首次读取状态时会自动迁移到新目录） */
const LEGACY_PROVISIONED_ENGINE_DIR = path.join(DATA_ROOT, 'ace-step')
/** 旧版开发布局（Windows 本地实验区）；仅作为兼容回退 */
const LEGACY_ENGINE_DIR = path.join(ROOT, 'music-gen', 'acestep-cpp')
const IS_WINDOWS = process.platform === 'win32'
const RUNTIME_BIN_NAMES = IS_WINDOWS
  ? ['ace-server.exe', 'bin/ace-server.exe']
  : ['ace-server', 'bin/ace-server']

/** 模型文件 → 对用户/界面展示的名字（不暴露真实权重名，与 packages/core/src/branding.ts 一致） */
export const MODEL_DISPLAY_NAMES = Object.freeze({
  'Qwen3-Embedding-0.6B-Q8_0.gguf': '语义编码器',
  'vae-BF16.gguf': '音频编解码器',
  'acestep-v15-turbo-Q8_0.gguf': '快速生成模型',
  'acestep-v15-sft-Q8_0.gguf': '精修生成模型',
  'acestep-5Hz-lm-1.7B-Q8_0.gguf': '提示词增强模型',
  'acestep-v15-base-Q8_0.gguf': '分轨生成模型',
  // P9：XL（4B）增强档（展示名保持中性，不暴露真实权重名）
  'acestep-v15-xl-turbo-Q8_0.gguf': '快速生成模型（增强版）',
  'acestep-v15-xl-sft-Q8_0.gguf': '精修生成模型（增强版）',
  'acestep-v15-xl-base-Q8_0.gguf': '分轨生成模型（增强版）',
  'acestep-5Hz-lm-4B-Q8_0.gguf': '提示词增强模型（增强版）',
})

/** 引擎变体 → 展示名（进度/错误信息里出现，避免暴露内部变体名） */
export const VARIANT_DISPLAY_NAMES = Object.freeze({
  turbo: '快速生成模型',
  sft: '精修生成模型',
  base: '分轨生成模型',
  // P9：XL（4B）变体
  xl_turbo: '快速生成模型（增强版）',
  xl_sft: '精修生成模型（增强版）',
  xl_base: '分轨生成模型（增强版）',
})

/** 引擎根目录：AIAB_ENGINE_DIR（兼容旧 AIAB_ACESTEP_DIR）> 已安装目录 > 旧版目录 */
function resolveAceStepDir() {
  const explicit = process.env.AIAB_ENGINE_DIR || process.env.AIAB_ACESTEP_DIR || process.env.ACESTEP_DIR
  if (explicit) return path.resolve(explicit)
  for (const candidate of [PROVISIONED_ENGINE_DIR, LEGACY_PROVISIONED_ENGINE_DIR, LEGACY_ENGINE_DIR]) {
    if (RUNTIME_BIN_NAMES.some((name) => existsSync(path.join(candidate, name)))) return candidate
  }
  return PROVISIONED_ENGINE_DIR
}

export const ACESTEP_DIR = resolveAceStepDir()
export const ACESTEP_BIN =
  RUNTIME_BIN_NAMES.map((name) => path.join(ACESTEP_DIR, name)).find((candidate) => existsSync(candidate)) ??
  path.join(ACESTEP_DIR, RUNTIME_BIN_NAMES[0])
export const ACESTEP_MODELS_DIR =
  process.env.AIAB_ENGINE_MODELS_DIR || process.env.AIAB_ACESTEP_MODELS_DIR || path.join(ACESTEP_DIR, 'models')
/**
 * 计算后端：macOS 用 Metal 的 ggml 后端名 `MTL0`（不是 `METAL`！旧默认会导致
 * ace-server 启动时报 `GGML_BACKEND=METAL not found. Available: MTL0 BLAS CPU` 后 exit=1）；
 * 其它平台默认 CUDA0。可用同名环境变量 GGML_BACKEND 覆盖。
 */
export const ACESTEP_BACKEND = process.env.GGML_BACKEND || (process.platform === 'darwin' ? 'MTL0' : 'CUDA0')
/** 缺引擎时给用户的自动安装提示 */
export const PROVISION_HINT = 'node scripts/provision.mjs install --profile essential'
/**
 * 运行时 API 形态（P9）：产品 Windows 侧已升级到上游现代版（acestep.cpp 2026-11-06），
 * 使用 `--models <dir>` + 异步 job HTTP API；mac/linux 与旧安装仍是 v0.1.0 legacy。
 * 判定顺序：AIAB_ACESTEP_API 环境变量 > <引擎目录>/runtime.json 的 api 字段 > legacy。
 */
function resolveRuntimeApi() {
  const explicit = String(process.env.AIAB_ACESTEP_API ?? '').trim().toLowerCase()
  if (explicit === 'legacy' || explicit === 'modern') return explicit
  try {
    const marker = JSON.parse(readFileSync(path.join(ACESTEP_DIR, 'runtime.json'), 'utf8'))
    if (marker?.api === 'modern') return 'modern'
  } catch {
    /* 没有 runtime.json：按旧版开发目录处理 */
  }
  return 'legacy'
}
/** 'legacy'（v0.1.0：--dit/--lm + 同步 API）或 'modern'（--models + 异步 job API） */
export const RUNTIME_API = resolveRuntimeApi()
/** 现代运行时支持 XL 4B 系列；legacy 运行时加载 XL 会在推理时崩溃（已实测） */
export const MODERN_RUNTIME = RUNTIME_API === 'modern'
/** 计算设备名（现代运行时用 --device 指定）；macOS 用 MTL0，其它默认 CUDA0 */
export const ACESTEP_DEVICE =
  process.env.AIAB_ACESTEP_DEVICE ||
  process.env.ACESTEP_DEVICE ||
  (process.platform === 'darwin' ? 'MTL0' : 'CUDA0')

/** DiT 文件名（模型能力按「文件是否存在」真实上报给服务端做任务匹配） */
export const MODEL_FILENAMES = Object.freeze({
  turbo: 'acestep-v15-turbo-Q8_0.gguf',
  sft: 'acestep-v15-sft-Q8_0.gguf',
  base: 'acestep-v15-base-Q8_0.gguf',
  xl_turbo: 'acestep-v15-xl-turbo-Q8_0.gguf',
  xl_sft: 'acestep-v15-xl-sft-Q8_0.gguf',
  xl_base: 'acestep-v15-xl-base-Q8_0.gguf',
})
/** DiT 路径：turbo = text2music，sft = repaint，base = lego；xl_* = 4B 高质量/快速档 */
export const MODEL_DITS = Object.freeze({
  turbo: path.join(ACESTEP_MODELS_DIR, MODEL_FILENAMES.turbo),
  sft: path.join(ACESTEP_MODELS_DIR, MODEL_FILENAMES.sft),
  base: path.join(ACESTEP_MODELS_DIR, MODEL_FILENAMES.base),
  xl_turbo: path.join(ACESTEP_MODELS_DIR, MODEL_FILENAMES.xl_turbo),
  xl_sft: path.join(ACESTEP_MODELS_DIR, MODEL_FILENAMES.xl_sft),
  xl_base: path.join(ACESTEP_MODELS_DIR, MODEL_FILENAMES.xl_base),
})
/** LoRA 适配器目录（现代运行时用 --adapters 扫描；legacy 用 --lora 单路径） */
export const ADAPTERS_DIR =
  process.env.AIAB_ADAPTERS_DIR || path.join(DATA_ROOT, 'adapters')
/** 与 DiT 搭配的辅助模型 */
export const MODEL_AUX = Object.freeze({
  embedding: path.join(ACESTEP_MODELS_DIR, 'Qwen3-Embedding-0.6B-Q8_0.gguf'),
  vae: path.join(ACESTEP_MODELS_DIR, 'vae-BF16.gguf'),
  /** 质量档（P7-A）用的 LM：/lm 提示词增强 + 语义 codes（2B 引擎用 1.7B） */
  lm: path.join(ACESTEP_MODELS_DIR, 'acestep-5Hz-lm-1.7B-Q8_0.gguf'),
  lm17: path.join(ACESTEP_MODELS_DIR, 'acestep-5Hz-lm-1.7B-Q8_0.gguf'),
  lm4b: path.join(ACESTEP_MODELS_DIR, 'acestep-5Hz-lm-4B-Q8_0.gguf'),
})
/** LM 档位 → 文件名/路径（'' = 不需要 LM） */
export const LM_TIERS = Object.freeze({
  '1.7B': { file: 'acestep-5Hz-lm-1.7B-Q8_0.gguf', path: MODEL_AUX.lm17 },
  '4B': { file: 'acestep-5Hz-lm-4B-Q8_0.gguf', path: MODEL_AUX.lm4b },
})

/** 质量档（P7-A）：/lm → /synth（sft 50 步）。真机实测 20s 音频约 15–25s。 */
export const QUALITY_STEPS = 50
export const QUALITY_GUIDANCE = 1.0
export const QUALITY_SHIFT = 1.0
/**
 * 质量档成品的 peak_clip（引擎 `GET /props` 默认是 10）。
 *
 * 语义（真机实测，同一份 audio_codes / 同 seed，只改这个值）：它是「峰值软限幅强度」，
 * 值越大越把波形往满刻度顶。实测 20s turbo 渲染：
 *
 *   peak_clip=100 → 6.70% 的 0.1s 帧 >0.95、1.03% 帧贴 0.999（明确削顶）
 *   peak_clip=10  → 3.09% 帧 >0.95（引擎默认，成品峰值贴到 1.000）
 *   peak_clip=3   → 1.03% 帧 >0.95
 *   peak_clip=1   → 0.52% 帧 >0.95
 *   peak_clip=0   → 0.00% 帧 >0.95（= 关闭，与 -1 逐字节相同）
 *
 * 取 1：既压掉贴顶削顶（用户反馈「成品品质不高」的一部分），又保留 0 档会丢的
 * 峰值余量；RMS 只降 0.3dB，动态范围不变（均为 20.0dB）。
 */
export const QUALITY_PEAK_CLIP = 1
/**
 * 快速档（turbo）采样预设：照抄引擎 `GET /props` 的 `presets.turbo`
 * （acestep.cpp 07abf07 / 2026-11-06 实测）：
 *
 *   presets.turbo = { inference_steps: 8, guidance_scale: 1.0, shift: 3.0 }
 *   presets.sft   = { inference_steps: 50, guidance_scale: 1.0, shift: 1.0 }
 *
 * turbo 必须用 shift=3.0：喂 1.0 会过曝发刺（实测峰值 0.996 vs 0.958、
 * 高频占比 25.7% vs 22.1%、频谱质心 1793Hz vs 1477Hz），听感更刺更糊。
 * sft 预设与上面的 QUALITY_* 同值，因此 sft 类变体直接复用 QUALITY_*。
 */
export const TURBO_STEPS = 8
export const TURBO_GUIDANCE = 1.0
export const TURBO_SHIFT = 3.0
/** turbo 类变体（其余 sft/base 类按 sft 预设）；xl_* 同名同档 */
const TURBO_CLASS_VARIANTS = ['turbo', 'xl_turbo']

/**
 * DiT 变体 → 引擎采样预设（纯函数）。这是「步数 / guidance / shift」的**唯一**来源：
 * 请求体构造与 applyModelSelection 都走这里，避免 shift 在多处各写一份而不一致。
 * 缺省（无变体）/ turbo 类 → turbo 预设；sft / base / xl_sft / xl_base → sft 预设。
 */
export function presetForVariant(variant = 'turbo') {
  const name = typeof variant === 'string' ? variant.trim().toLowerCase() : ''
  if (!name || TURBO_CLASS_VARIANTS.includes(name)) {
    return { inference_steps: TURBO_STEPS, guidance_scale: TURBO_GUIDANCE, shift: TURBO_SHIFT }
  }
  return { inference_steps: QUALITY_STEPS, guidance_scale: QUALITY_GUIDANCE, shift: QUALITY_SHIFT }
}

/**
 * 调性字符串轻量归一化（纯函数）：`"c minor"` → `"C minor"`、`"C#minor"` → `"C# minor"`。
 * 引擎 keyscale 是自由字符串，这里只做「主音 + 调式」的形状校验与大小写规整；
 * 形状不认识（乱码 / 过长）返回 undefined，由调用方回落到缺省调性。
 */
export function normalizeKeyscale(value) {
  if (typeof value !== 'string') return undefined
  const compact = value.trim().replace(/\s+/g, ' ')
  if (!compact || compact.length > 24) return undefined
  const matched = /^([A-Ga-g])([#b♯♭]?)\s*([A-Za-z]{2,12})$/.exec(compact)
  if (!matched) return undefined
  const accidental = matched[2].replace('♯', '#').replace('♭', 'b')
  return `${matched[1].toUpperCase()}${accidental} ${matched[3].toLowerCase()}`
}
/** P2-A 支持的任务类型所必需的模型文件（base/lego 未开放，不强制要求） */
const REQUIRED_MODEL_FILES = [ACESTEP_BIN, MODEL_AUX.embedding, MODEL_AUX.vae, MODEL_DITS.turbo, MODEL_DITS.sft]
/** 合法的引擎变体（服务端 requiredVariant 的取值域；xl_* 仅在 modern 运行时可用） */
export const ENGINE_VARIANTS = ['turbo', 'sft', 'base', 'xl_turbo', 'xl_sft', 'xl_base']
/** 现代运行时下可用的 XL 变体（legacy 运行时不支持） */
export const XL_VARIANTS = ['xl_turbo', 'xl_sft', 'xl_base']
/** mock 执行器三种任务都能伪造，按契约上报 turbo/sft/base（含 base 才能接到 generate_stem 做 UI 联调） */
const MOCK_MODEL_VARIANTS = ['turbo', 'sft', 'base']
/** 分轨的合法 arm（产品/界面用名，base 基座），以及 caption 缺省时的英文描述 */
export const STEM_ARMS = ['guitar', 'bass', 'drums', 'strings', 'keys', 'synth', 'vocals']
/**
 * 引擎（acestep）认可的标准轨道名白名单（acestep/constants.py:153 与二进制一致）。
 * 产品 arm 名不等于引擎轨道名（`keys` → `keyboard`），只在引擎边界翻译。
 */
export const ENGINE_TRACKS = [
  'vocals',
  'backing_vocals',
  'drums',
  'bass',
  'guitar',
  'keyboard',
  'percussion',
  'strings',
  'synth',
  'fx',
  'brass',
  'woodwinds',
]
/** 产品 arm → 引擎轨道名（界面/文案继续用 STEM_ARMS 的名字，别把 `keys` 发进引擎） */
export const STEM_ARM_TRACKS = Object.freeze({
  guitar: 'guitar',
  bass: 'bass',
  drums: 'drums',
  strings: 'strings',
  keys: 'keyboard',
  synth: 'synth',
  vocals: 'vocals',
})
/** 分轨的固定 seed：extract 是「按源音频条件分离」，固定 seed 让重复运行可复现（不再每次随机） */
export const STEM_SEED = 777
/**
 * 分轨隔离描述。
 *
 * 写这里的两个约束：
 * 1) 必须描述「只有这件乐器」，否则 extract 会按整支乐队去理解；
 * 2) **不要写会造成音色收窄的形容词**。实测用户工程 `p_7atqcqig` 的 5 条乐器分轨
 *    2–6kHz 相对整曲只有 0.01–0.71 倍能量、500–2000Hz 与整曲的相关只有 0.006–0.088，
 *    叠加后中频缺 14.1pp、中高频缺 16.6pp —— 这正是「糊」的实测表征。
 *    旧描述里 `round low end`（低音沉）与 `palm-muted power chords`（闷音和弦）
 *    都是**主动要求窄带/闷音色**的写法，与「全频段隔离」目标相反，故移除。
 *    保留 `dry` / `full frequency range` 引导模型给出未经混音处理的完整频谱。
 *
 * 说明：以上为代码层可证的改动方向；**没有**真机 A/B 证明改完一定更好听
 *（当时引擎未运行，无法跑 extract 对照），因此只删掉明确有害的措辞，不新增激进要求。
 */
const STEM_ARM_CAPTIONS = Object.freeze({
  guitar: 'Isolated electric guitar stem: electric guitar only, dry close-mic recording, full frequency range, no other instruments',
  bass: 'Isolated bass stem: electric bass guitar only, dry direct recording, full frequency range and natural harmonics, no drums or guitars',
  drums: 'Isolated drum stem: acoustic drum kit only, dry close-mic recording, full frequency range, kick snare hi-hat toms cymbals with natural brightness, no melodic instruments',
  strings: 'Isolated strings stem: orchestral string section only, dry recording, sustained legato, full frequency range, no brass or percussion',
  keys: 'Isolated keyboard stem: piano and electric keys only, dry recording, full frequency range, no guitar or drums',
  synth: 'Isolated synthesizer stem: analog synth only, dry recording, full frequency range, no acoustic instruments',
  /**
   * 人声不能用「乐器隔离」模板：extract 会把「没有乐器伴奏」理解成「去掉伴奏后剩下的东西」，
   * 而源音频若是 `[Instrumental]` 条件生成的，剩下就只有噪声（实测 DC +0.64 = 实测噪声场）。
   * 这里显式要求 a cappella / 干声清唱，让模型按「人声」这一语义去分离。
   */
  vocals:
    'Isolated a cappella lead vocal stem: only the sung voice, dry close-mic vocal with clear diction and natural vibrato, no instrumental backing, no drums, no bass, no reverb wash',
})
const ACESTEP_PORT_MIN = 17900
const ACESTEP_PORT_MAX = 17999
const ACESTEP_HEALTH_TIMEOUT_MS = 240_000
const ACESTEP_HEALTH_POLL_MS = 1200
const ACESTEP_SYNTH_TIMEOUT_MS = 900_000
const ACESTEP_LM_TIMEOUT_MS = 180_000
const SYNTH_PROGRESS_INTERVAL_MS = 2000
/** P13：资源遥测缓存（心跳 5s / 进度 2s 都会取一次，避免重复拉起 ps） */
const TELEMETRY_CACHE_MS = 1500
const GPU_TELEMETRY_CACHE_MS = 5000
const TELEMETRY_CMD_TIMEOUT_MS = 1200
/** P13：生成阶段 → 界面中性文案（服务端白名单透传，前端直接展示） */
const PHASE_LABELS = Object.freeze({
  queued: '排队中',
  prepare: '准备任务',
  engine: '载入音频引擎',
  prompt: '理解你的描述',
  sampling: '扩散采样',
  decoding: '解码音频',
  upload: '写入工程',
  done: '完成',
  idle: '待机',
})
const HEALTH_PROBE_TIMEOUT_MS = 3000
const REQUEST_TIMEOUT_MS = 15_000
const COMPLETE_TIMEOUT_MS = 120_000
const SOURCE_DOWNLOAD_TIMEOUT_MS = 120_000
/** 空闲时查询服务端队列能力的节流间隔（至少 30s 一次） */
const CAPABILITY_STATUS_INTERVAL_MS = 30_000
/** 能力不匹配提示日志的节流间隔（约 30s 一条，不刷屏） */
const CAPABILITY_HINT_INTERVAL_MS = 30_000

const USAGE = `用法：
  node scripts/companion.mjs --server http://127.0.0.1:8899 --name "本机 GPU" [--mock|--engine] [--once] [--engine-idle 秒]

参数：
  --server <url>       服务端地址（默认 ${DEFAULT_SERVER}）
  --name <名字>        工作节点显示名（默认取主机名）
  --mock               无 GPU 自检执行器：generate/repaint/stem 都返回 2 秒 440Hz 立体声 48k WAV
  --engine             生产执行器（默认）：常驻本机 AI 音频生成引擎（需要 CUDA/GPU）
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
      case '--engine':
      case '--acestep': // 旧参数名，保留兼容
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
  if (mock && acestep) throw new Error('--mock 与 --engine 只能二选一')
  options.executor = mock ? 'mock' : 'acestep'
  return options
}

/** 注册请求体（契约固定形状）。 */
export function buildRegisterBody({ name, version = COMPANION_VERSION, executor = 'acestep' } = {}) {
  return { name, version, capabilities: buildCapabilities(executor) }
}

/**
 * 扫描 models 目录，按真实存在的 GGUF 得出本机支持的 DiT 变体（纯函数，exists 可注入便于测试）。
 * XL 变体只在 modern 运行时（支持 4B DiT）下上报；legacy 运行时下即使文件存在也不上报。
 * 服务端用 capabilities.models 做任务能力匹配；返回顺序固定 turbo/sft/base/xl_turbo/xl_sft/xl_base。
 */
export function detectModelVariants({ exists = existsSync, modelsDir = ACESTEP_MODELS_DIR, modern = MODERN_RUNTIME } = {}) {
  return ENGINE_VARIANTS.filter((variant) => {
    if (!modern && XL_VARIANTS.includes(variant)) return false
    try {
      return Boolean(exists(path.join(modelsDir, MODEL_FILENAMES[variant])))
    } catch {
      return false
    }
  })
}

/** capabilities：mock 上报 turbo+sft；acestep 按真实存在的 GGUF 上报模型变体 + GPU 后端 + 运行时形态。 */
export function buildCapabilities(executor = 'acestep', { variants } = {}) {
  const tasks = [...TASKS]
  if (executor === 'mock') return { tasks, models: [...MOCK_MODEL_VARIANTS] }
  return {
    tasks,
    gpu: ACESTEP_BACKEND,
    api: RUNTIME_API,
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

/** 任务参数里的引擎量级：'2b'（默认，快）或 'xl'（4B，最高质量） */
export function normalizeEngineTier(params = {}) {
  return params?.engine === 'xl' ? 'xl' : '2b'
}

/** 质量档/分轨需要的 LM 档位：XL 引擎用 4B，2B 引擎用 1.7B；快模式不需要 LM（''）。 */
export function lmTierForTask(type, params = {}, variant = '') {
  if (type === TASK_TYPE_GENERATE && params?.quality === true) return normalizeEngineTier(params) === 'xl' ? '4B' : '1.7B'
  // 现代运行时的 lego 走 LM 生成 codes；旧版运行时 stem 历来不需要 --lm，保持原行为
  if (type === TASK_TYPE_STEM && MODERN_RUNTIME) return normalizeEngineTier(params) === 'xl' ? '4B' : '1.7B'
  return ''
}

/** 任务类型 + 引擎档位 → 需要的 DiT 变体；未知类型返回 undefined（仍交给执行器报错，不做硬校验）。 */
export function inferRequiredVariant(type, params = {}) {
  const xl = normalizeEngineTier(params) === 'xl'
  if (type === TASK_TYPE_GENERATE) {
    if (params?.quality === true) return xl ? 'xl_sft' : 'sft'
    return xl ? 'xl_turbo' : 'turbo'
  }
  if (type === TASK_TYPE_REPAINT) return xl ? 'xl_sft' : 'sft'
  if (type === TASK_TYPE_STEM) return xl ? 'xl_base' : 'base'
  if (type === TASK_TYPE_COVER) return xl ? 'xl_turbo' : 'turbo'
  return undefined
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
/* 直流偏置（DC offset）防御：安全网，不是本轮修复本身                   */
/*                                                                     */
/* 实测：源音频按 `[Instrumental]` 生成后再 extract vocals，模型会吐出一条 */
/* 99.7% 能量都是 DC 的噪声场（+0.6367 → 去 DC 后 RMS -29dBFS）。真正的  */
/* 修复是「不生成本来就没人声的源音频」（见 wantsVocals / 分轨护栏），   */
/* 这里只是**最后一道防线**：宁可多洗一次，也不要把带巨型 DC 的 WAV 交给工程。*/
/* ------------------------------------------------------------------ */

/** 判定阈值（相对满幅 1.0）：|mean| 超过它就算病态 DC，必须就地校正。 */
export const DC_OFFSET_THRESHOLD = 0.05
/** 低于该值视为正常音频（留出余量），用于「健康区间」判定与自检 */
export const DC_OFFSET_HEALTHY = 0.01

/**
 * 读 16bit PCM WAV 每声道均值（纯函数）。
 * 只支持 `bitsPerSample === 16` 的 PCM；其它格式返回 null（不猜、不改）。
 * 返回值：`{ mean, peak, channels, frames }`，mean 为各声道均值（-1..1）。
 */
export function readMeanDcOffset(buffer) {
  let info
  try {
    info = readWavInfo(buffer)
  } catch {
    return null
  }
  if (info.audioFormat !== 1 || info.bitsPerSample !== 16) return null
  const dataStart = findWavDataOffset(buffer)
  if (dataStart < 0) return null
  const frames = Math.floor(info.dataSize / (info.channels * 2))
  if (!frames) return null
  const sums = new Array(info.channels).fill(0)
  let peak = 0
  for (let frame = 0; frame < frames; frame += 1) {
    const base = dataStart + frame * info.channels * 2
    for (let channel = 0; channel < info.channels; channel += 1) {
      const sample = buffer.readInt16LE(base + channel * 2) / 32768
      sums[channel] += sample
      const abs = Math.abs(sample)
      if (abs > peak) peak = abs
    }
  }
  const perChannel = sums.map((sum) => sum / frames)
  // 多声道取平均：立体声两边同号偏置时才有意义（实测就是两边同号）
  const mean = perChannel.reduce((total, value) => total + value, 0) / perChannel.length
  return { mean, peak, channels: info.channels, frames }
}

/** 在 WAV 里定位 data 块的数据起点（纯函数，找不到返回 -1）。 */
function findWavDataOffset(buffer) {
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('latin1', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (chunkId === 'data') return body
    offset = body + chunkSize + (chunkSize % 2)
  }
  return -1
}

/** 在 WAV 里定位指定 chunk 的数据起点（纯函数，找不到返回 -1）。 */
function findWavChunkBody(buffer, chunkId) {
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === chunkId) return body
    offset = body + chunkSize + (chunkSize % 2)
  }
  return -1
}

/**
 * 把源 WAV 转成引擎可解码的 **16-bit PCM**（纯函数）。
 *
 * 为什么必须转：引擎的 WAV loader 只认 16-bit，24-bit 会直接
 * `[WAV] Unsupported: format=1 bits=24`，/synth 返回
 * `400 {"error":"failed to decode audio"}`。浏览器离线渲染为了导出质量默认
 * 24-bit，于是 cover / repaint / stem 的源音频一进引擎就失败。
 *
 * 覆盖：PCM 8/16/24/32-bit、IEEE float 32/64、WAVE_FORMAT_EXTENSIBLE
 * （按 subFormat GUID 取 PCM/float）。已经是 canonical 16-bit PCM 时原样返回；
 * 其它情况输出标准 44 字节头 + 16-bit 采样（同采样率/声道/时长）。
 * 非 WAV 或无法识别的编码抛中文错误，调用方按「源资产不可用」处理。
 */
export function toEngineDecodableWav(buffer) {
  const info = readWavInfo(buffer)
  const dataOffset = findWavDataOffset(buffer)
  if (dataOffset < 0) throw new Error('不是有效 WAV（找不到 data 块）')
  const isCanonical16 =
    info.audioFormat === 1 &&
    info.bitsPerSample === 16 &&
    dataOffset === 44 &&
    buffer.length >= 44 + info.dataSize
  if (isCanonical16) return buffer

  let format = info.audioFormat
  if (format === 0xfffe) {
    const fmtBody = findWavChunkBody(buffer, 'fmt ')
    if (fmtBody < 0 || buffer.readUInt32LE(fmtBody - 4) < 40) {
      throw new Error('不是有效 WAV（WAVE_FORMAT_EXTENSIBLE 的 fmt 块不完整）')
    }
    format = buffer.readUInt16LE(fmtBody + 24)
  }
  const bits = info.bitsPerSample
  const containerBytes = Math.max(1, Math.round(bits / 8))
  const channels = info.channels
  const sampleRate = info.sampleRate
  if (!channels || !sampleRate) throw new Error('不是有效 WAV（声道/采样率非法）')
  const blockAlign = channels * containerBytes
  const frames = Math.floor(info.dataSize / blockAlign)
  if (frames <= 0) throw new Error('源 WAV 没有可解码的音频帧')

  const isPcm = format === 1 && [8, 16, 24, 32].includes(bits)
  const isFloat = format === 3 && [32, 64].includes(bits)
  if (!isPcm && !isFloat) {
    throw new Error(`不支持的 WAV 编码（format=${format}, ${bits}bit）`)
  }

  const outDataSize = frames * channels * 2
  const out = Buffer.alloc(44 + outDataSize)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + outDataSize, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20) // PCM
  out.writeUInt16LE(channels, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * channels * 2, 28)
  out.writeUInt16LE(channels * 2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(outDataSize, 40)

  const readSample = (base) => {
    if (isFloat) {
      return bits === 32 ? buffer.readFloatLE(base) : buffer.readDoubleLE(base)
    }
    if (bits === 8) return (buffer.readUInt8(base) - 128) / 128
    if (bits === 16) return buffer.readInt16LE(base) / 32768
    if (bits === 24) return buffer.readIntLE(base, 3) / 8388608
    return buffer.readInt32LE(base) / 2147483648
  }
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const src = dataOffset + (frame * channels + channel) * containerBytes
      // 用 32768 定标再夹到 int16：-0.5 才能精确落到 -16384（乘 32767 会差 1 LSB）
      const scaled = Math.round(Math.max(-1, Math.min(1, readSample(src))) * 32768)
      out.writeInt16LE(Math.max(-32768, Math.min(32767, scaled)), 44 + (frame * channels + channel) * 2)
    }
  }
  return out
}

/**
 * 是否该做 DC 校正（纯函数）：
 * - 不是 16bit PCM WAV → false（不动它）；读不出数据 → false；
 * - `|mean| > DC_OFFSET_THRESHOLD` → true（病态，必须洗）；
 * - 健康区间（`|mean| < DC_OFFSET_HEALTHY`）→ false，**保证正常音频逐字节不变**。
 */
export function shouldStripDcOffset(info, { threshold = DC_OFFSET_THRESHOLD } = {}) {
  if (!info || !Number.isFinite(info.mean)) return false
  return Math.abs(info.mean) > threshold
}

/**
 * 就地去掉 16bit PCM WAV 的直流偏置（纯函数：不改入参，返回新 Buffer）。
 *
 * 实现：逐声道减去该声道均值 → 四舍五入 → 夹到 int16 范围 → 原地写回样本。
 * 每声道独立求均值，避免「左右偏置不同」时把声像洗歪。
 * 非 16bit PCM / 非 WAV / 解析失败一律**原样返回**（绝不破坏输入）。
 *
 * 注意：这是安全网，不是根因修复 —— 根因是「不该从无人声的源音频里抽人声」。
 * 触发时会由调用方打中文日志（见 postSynthWithProgress），默认不改动正常音频。
 */
export function stripDcOffsetFromWav16(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return buffer
  let info
  try {
    info = readWavInfo(buffer)
  } catch {
    return buffer
  }
  if (info.audioFormat !== 1 || info.bitsPerSample !== 16) return buffer
  const dataStart = findWavDataOffset(buffer)
  if (dataStart < 0) return buffer
  const channels = info.channels
  const frames = Math.floor(info.dataSize / (channels * 2))
  if (!frames) return buffer
  const sums = new Array(channels).fill(0)
  for (let frame = 0; frame < frames; frame += 1) {
    const base = dataStart + frame * channels * 2
    for (let channel = 0; channel < channels; channel += 1) sums[channel] += buffer.readInt16LE(base + channel * 2)
  }
  // 用原始整数均值做减法，不引入浮点漂移：四舍五入后逐样本减掉
  const means = sums.map((sum) => Math.round(sum / frames))
  if (means.every((value) => value === 0)) return buffer
  const next = Buffer.from(buffer)
  for (let frame = 0; frame < frames; frame += 1) {
    const base = dataStart + frame * channels * 2
    for (let channel = 0; channel < channels; channel += 1) {
      const pos = base + channel * 2
      const value = next.readInt16LE(pos) - means[channel]
      next.writeInt16LE(Math.max(-32768, Math.min(32767, value)), pos)
    }
  }
  return next
}

/**
 * 安全网总入口（纯函数）：返回值直接把「该不该洗/洗完什么」交给调用方打日志。
 * `changed=false` 时 `buffer` 与入参**同一引用**（保证正常音频逐字节不变）。
 */
export function sanitizeWavDcOffset(buffer, { threshold = DC_OFFSET_THRESHOLD } = {}) {
  const info = readMeanDcOffset(buffer)
  if (!shouldStripDcOffset(info, { threshold })) return { buffer, changed: false, info }
  const cleaned = stripDcOffsetFromWav16(buffer)
  return { buffer: cleaned, changed: cleaned !== buffer, info }
}

/* ------------------------------------------------------------------ */
/* /synth 请求体（照抄 gen_style_datasets.py / test_modes.py 的语义）    */
/* ------------------------------------------------------------------ */

/**
 * 拍号归一化（纯函数）：引擎要的是**分子字符串**（`"4"`），不是 `"4/4"`。
 * 接受 `4` / `'4'` / `'4/4'` / `'3/4'`，别的一律回落到 4/4。
 */
export function normalizeTimesignature(value) {
  const matched = /^\s*(\d{1,2})(?:\s*\/\s*\d{1,2})?\s*$/.exec(String(value ?? ''))
  if (!matched) return '4'
  const numerator = Number(matched[1])
  return numerator >= 1 && numerator <= 16 ? String(numerator) : '4'
}

/**
 * 这次生成是否要人声（纯函数）。`instrumental` 缺省 true（保持旧行为 = 纯乐器）；
 * 只有显式 `instrumental: false`（或 `params.vocals === true`）才算「要人声」。
 */
export function wantsVocals(params = {}) {
  if (params?.instrumental === false) return true
  if (params?.instrumental === true) return false
  return params?.vocals === true
}

/** 日语线索（纯函数）：caption/语言字段里出现日语或日系风格关键词 → 'ja'。 */
const JAPANESE_HINT_RE = /japanese|j-?rock|jpop|j-?pop|anime|日语|日文|日系|日本/i
/**
 * 生成请求的 vocal_language（纯函数）：
 * - 显式 `params.vocalLanguage` 优先（前端/工具可选下发）；
 * - 无人声 → 'unknown'（与旧行为逐字节一致，引擎据此不进人声通道）；
 * - 要人声但没指定语言 → 'ja'（本仓库用户绝大多数诉求是日语 J-ROCK；引擎只把 language
 *   当自由文本提示写进 LM 条件，写错不至于失败，但会让歌词/咬字跑偏，所以按 caption 判一次）；
 * - caption 有日语线索 → 'ja'。非日语且未显式给语言时给 'en'，避免把中文诉求硬塞成日语。
 */
export function resolveVocalLanguage(params = {}) {
  const explicit = typeof params?.vocalLanguage === 'string' ? params.vocalLanguage.trim() : ''
  if (explicit) return explicit
  if (!wantsVocals(params)) return 'unknown'
  const caption = `${params?.caption ?? ''} ${params?.style ?? ''}`
  if (JAPANESE_HINT_RE.test(caption)) return 'ja'
  return 'en'
}

/**
 * generate_audio：task.params → AI 音频生成引擎 /synth JSON 请求体。纯函数；缺 caption 直接报错。
 * 采样参数走 presetForVariant（turbo 预设 = 8 步 / guidance 1.0 / shift 3.0），
 * 调性来自 params.keyscale（前端从工程 key/scale 派生），缺省才回落 'C major'。
 *
 * 歌词条件（本轮修复的核心）：
 * - `instrumental: true`（缺省）→ `lyrics: '[Instrumental]'` + `vocal_language: 'unknown'`，与旧行为完全一致；
 * - 要人声 → `lyrics: ''`：引擎语义是「`''` = 让 LM 自己写歌词」，
 *   `'[Instrumental]'` = 明确告诉 DiT「不要人声」。以前不管用户要不要人声都写 `[Instrumental]`，
 *   于是「caption 要日语男声、lyrics 条件却禁止人声」自相矛盾 → 出不来人声，人声 stem 只能抽到噪声。
 */
export function buildSynthPayload(params = {}) {
  const caption = typeof params?.caption === 'string' ? params.caption.trim() : ''
  if (!caption) throw new Error('任务参数缺少 caption（生成提示词）')
  const keyscale = normalizeKeyscale(params.keyscale) ?? 'C major'
  const rawBpm = Number(params.bpm)
  const bpm = Number.isFinite(rawBpm) ? clampInt(rawBpm, 30, 300, 120) : 120
  const rawDuration = Number(params.durationSec)
  const duration = Number.isFinite(rawDuration) ? Math.min(300, Math.max(1, rawDuration)) : 30
  const seed = Number.isInteger(params.seed) && params.seed >= 0 ? params.seed : 0
  // generate_audio 快速档固定走 turbo DiT；这里显式取 turbo 预设（不要再写死 shift: 1.0）
  const preset = presetForVariant('turbo')
  const vocals = wantsVocals(params)
  return {
    caption,
    lyrics: vocals ? '' : '[Instrumental]',
    bpm,
    keyscale,
    timesignature: normalizeTimesignature(params.timesignature),
    vocal_language: resolveVocalLanguage(params),
    seed,
    batch_size: 1,
    inference_steps: preset.inference_steps,
    guidance_scale: preset.guidance_scale,
    shift: preset.shift,
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

/**
 * repaint_audio：校验后的参数 → AI 音频生成引擎 /synth multipart 里的 request JSON。
 *
 * **必须显式发 `task_type: 'repaint'`**：引擎的掩码只在 repaint 任务下生效；
 * 缺这个字段会回落 `task_type=text2music`，`repainting_start/end` 被完全忽略，
 * 结果变成「整段重新生成」（实测区域外相关从 +1.0000 掉到 +0.0059）。
 * 这与 generate_stem 曾经漏发 task_type 是同一类缺陷。
 *
 * 时长无需下发：引擎在 repaint 任务下自动锁源音频时长（实测带/不带 duration 均为 240s）。
 */
export function buildRepaintRequest(params = {}) {
  return {
    caption: params.caption,
    lyrics: '[Instrumental]',
    seed: Number.isInteger(params.seed) ? params.seed : resolveSeed(params.seed),
    batch_size: 1,
    task_type: 'repaint',
    repainting_start: params.startSec,
    repainting_end: params.endSec,
    inference_steps: 50,
    guidance_scale: 1.0,
    shift: 1.0,
  }
}

/** 产品 arm → 引擎轨道名；未知 arm 返回 ''（调用方应先过 validateStemParams）。 */
export function engineTrackForArm(arm) {
  return STEM_ARM_TRACKS[String(arm ?? '').trim().toLowerCase()] ?? ''
}

/**
 * 分轨 caption（纯函数）：始终先给「只保留该乐器」的隔离描述，
 * 调用方补充的描述（如风格）只作为后缀追加。
 *
 * 背景：以前调用方把**整曲** caption 传进来，等于告诉模型「按整首歌生成」，
 * 与 extract（从这段音频里分离出该乐器）的语义打架 —— 所以约束必须排在最前。
 *
 * 人声特殊处理：vocals 的隔离描述是「a cappella 干声清唱」（见 STEM_ARM_CAPTIONS.vocals），
 * 不再沿用「no instrumental backing」这类乐器模板；同时把调用方后缀里的「伴奏/纯音乐」
 * 这类会与「要人声」自相矛盾的词剔掉（否则 caption 自己就在说「没有人声」）。
 */
export function buildStemCaption(arm, detail = '') {
  const key = String(arm ?? '').trim().toLowerCase()
  const own = STEM_ARM_CAPTIONS[key] ?? ''
  // 去掉调用方顺手加的「<arm> stem / stem」这类冗余后缀（隔离描述里已说清楚）
  let extra =
    typeof detail === 'string'
      ? detail
          .trim()
          .replace(/[\s·,\-–—]*\bstem\b\s*$/i, '')
          .replace(/[\s·,\-–—]+$/, '')
          .trim()
      : ''
  // 结尾只剩 arm 名（"… · guitar"）也没有信息量，连同分隔符一起去掉
  if (key) {
    const tail = new RegExp(`[\\s·,\\-–—]+${key}$`, 'i')
    if (tail.test(extra)) extra = extra.replace(tail, '').trim()
  }
  // 整段只剩 arm 名本身时同样丢掉
  if (extra.toLowerCase() === key) extra = ''
  // vocals：后缀若在说「无人声/纯伴奏/乐器」，与「分离人声」直接冲突，整段丢弃
  if (key === 'vocals' && /instrumental|no\s+vocals?|backing\s+track|karaoke|伴奏|纯音乐|无人声/i.test(extra)) extra = ''
  extra = extra.slice(0, 160)
  if (!own) return extra
  return extra ? `${own}. ${extra}` : own
}

/**
 * 「从纯乐器源里抽人声」护栏（纯函数，返回决策而不是抛错）：
 *
 * extract 是**按源音频条件分离**：源音频里没有的东西抽不出来。实测从
 * `lyrics:'[Instrumental]'` 生成的整曲里 extract vocals，模型会吐一条 99.7% 能量是
 * 直流偏置的噪声场（DC +0.6367 → 去 DC 后 RMS 仅 -29dBFS、ZCR 0.42 = 纯嘶声）。
 * 与其静默产出一条「名字叫人声、实际是噪音」的轨，不如明确告诉用户并跳过这一臂，
 * 让整曲和其它分轨照常完成（任务保持 alive）。
 *
 * 判据（任一成立即认为源不含人声）：
 * - `sourceInstrumental === true`（前端/调用方从生成计划带下来的**明确事实**）；
 * - 或 `sourceLyrics === '[Instrumental]'`（源音频是按无人声条件生成的）。
 * 「不知道」时**不拦**（旧调用方/外部 Agent 不传该字段，保持可用）。
 *
 * 返回：`{ ok: true }` 或 `{ ok: false, code: 'vocals-from-instrumental', message }`。
 */
export function resolveStemArmDecision(params = {}, { sourceInstrumental, sourceLyrics } = {}) {
  const arm = String(params?.arm ?? '').trim().toLowerCase()
  if (arm !== 'vocals') return { ok: true }
  const claimsInstrumental =
    sourceInstrumental === true ||
    params?.sourceInstrumental === true ||
    sourceLyrics === '[Instrumental]' ||
    params?.sourceLyrics === '[Instrumental]'
  if (!claimsInstrumental) return { ok: true }
  return {
    ok: false,
    code: 'vocals-from-instrumental',
    message:
      '这条整曲是按「纯乐器（无人声）」生成的，里面本来就没有人声，硬拆人声只会得到噪声，已跳过「人声」分轨。' +
      '要人声分轨，请重新生成整曲并勾选「要人声」（或在描述里明确写「要人声/带唱」），再分轨。',
  }
}

/**
 * generate_stem（extract 分轨）参数校验（纯函数）：
 * 启动引擎/下载源音频之前先拦掉缺 sourceAssetId 与非法 arm。
 *
 * seed：默认固定（STEM_SEED）而不是随机 —— extract 是按源音频条件分离，
 * 固定 seed 让同一源音频的重复运行可复现，不再每次都是「另一个版本」。
 *
 * 源音频是否含人声的**事实**由调用方通过 `sourceInstrumental` 传入（见 resolveStemArmDecision），
 * 校验本身不猜；没人声的源要抽 vocals 时直接抛可执行的中文错误（顶层由执行器跳过该臂）。
 */
export function validateStemParams(params = {}) {
  const sourceAssetId = typeof params?.sourceAssetId === 'string' ? params.sourceAssetId.trim() : ''
  if (!sourceAssetId) throw new Error('generate_stem 需要 params.sourceAssetId（源音频资产 id）')
  const rawArm = typeof params?.arm === 'string' ? params.arm.trim().toLowerCase() : ''
  if (!rawArm) throw new Error(`generate_stem 需要 params.arm（分轨乐器：${STEM_ARMS.join('/')}）`)
  if (!STEM_ARMS.includes(rawArm)) {
    throw new Error(`generate_stem 的 arm 非法：${rawArm}（合法值：${STEM_ARMS.join('/')}）`)
  }
  const decision = resolveStemArmDecision(
    { arm: rawArm, sourceInstrumental: params?.sourceInstrumental, sourceLyrics: params?.sourceLyrics },
    { sourceInstrumental: params?.sourceInstrumental, sourceLyrics: params?.sourceLyrics },
  )
  if (!decision.ok) throw new Error(decision.message)
  const detail = typeof params?.caption === 'string' && params.caption.trim() ? params.caption.trim() : ''
  const normalized = {
    sourceAssetId,
    arm: rawArm,
    track: engineTrackForArm(rawArm),
    caption: buildStemCaption(rawArm, detail),
    seed: Number.isInteger(params?.seed) && params.seed >= 0 ? params.seed : STEM_SEED,
  }
  if (typeof params?.adapterId === 'string' && params.adapterId.trim()) normalized.adapterId = params.adapterId.trim()
  if (typeof params?.adapterPath === 'string' && params.adapterPath.trim()) normalized.adapterPath = params.adapterPath.trim()
  return normalized
}

/**
 * generate_stem：校验后的参数 → 引擎 request JSON（multipart 的 request 字段）。
 *
 * 必须是 `task_type: 'extract'` + `track: <引擎轨道名>`：引擎的 `lego` 是「另生成一条
 * 叠加轨」，`extract` 才是「从源音频分离出该乐器」；发 `{lego: arm}` 这类未知键会被
 * 忽略并回落 `task_type=text2music`，等于按 caption 重生成一首 30s 新歌（时长也对不上）。
 * export 名保留 `buildLegoRequest` 仅为兼容既有调用点/自检脚本。
 */
export function buildExtractRequest(params = {}) {
  const arm = String(params.arm ?? '').trim().toLowerCase()
  const track = engineTrackForArm(arm)
  if (!track) throw new Error(`分轨需要合法 arm（收到 ${JSON.stringify(params.arm)}）`)
  return {
    caption: params.caption,
    lyrics: '[Instrumental]',
    seed: Number.isInteger(params.seed) && params.seed >= 0 ? params.seed : STEM_SEED,
    batch_size: 1,
    task_type: 'extract',
    track,
    inference_steps: 50,
    guidance_scale: 1.0,
    shift: 1.0,
  }
}

/** 旧名兼容壳（历史调用点/自检仍在用 buildLegoRequest）。 */
export function buildLegoRequest(params = {}) {
  return buildExtractRequest(params)
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

/** 任务类型 + 引擎档位 → DiT 变体；不支持的类型抛中文错误。 */
export function variantForTask(type, params = {}) {
  if (!TASKS.includes(type)) throw new Error(`不支持的任务类型：${type}（当前支持：${TASKS.join('、')}）`)
  return inferRequiredVariant(type, params)
}

/** 适配器所在目录：现代运行时按目录扫描（--adapters），legacy 直接给适配器路径。 */
export function adapterDirOf(adapterPath) {
  if (!adapterPath) return ''
  return MODERN_RUNTIME ? path.dirname(String(adapterPath)) : String(adapterPath)
}

/**
 * 引擎复用决策（纯函数）：
 * - legacy：同变体 + 同 LoRA 适配器 + 同 LM 档位且 ready → 复用；否则停旧起新；
 * - modern：一个引擎进程按请求选择模型与 LM，只有「适配器目录」变化才需要重启；
 * - start：没有可用引擎（首次 / 崩溃后）。
 */
export function engineDecision({
  api = RUNTIME_API,
  currentVariant,
  currentAdapterPath,
  currentLm = '',
  state,
  desiredVariant,
  desiredAdapterPath,
  desiredLm = '',
} = {}) {
  const sameAdapter = adapterDirOf(currentAdapterPath) === adapterDirOf(desiredAdapterPath)
  const normalizeLm = (value) => (typeof value === 'string' ? value.trim() : value ? '1.7B' : '')
  const sameLm = normalizeLm(currentLm) === normalizeLm(desiredLm)
  if (api === 'modern') {
    if (state === 'ready' && sameAdapter) return 'reuse'
    if (currentVariant && state !== 'stopped' && state !== 'crashed') return 'switch'
    return 'start'
  }
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

/** 引擎展示名（用于任务进度/日志，不暴露内部变体名；LM 档位仍按 P9 逻辑展示 1.7B/4B）。 */
export function engineLabel(variant, adapterPath, lm = '') {
  if (!variant) return '无'
  const adapterName = adapterPath ? path.basename(String(adapterPath)) : ''
  const base = VARIANT_DISPLAY_NAMES[variant] ?? '生成模型'
  const lmTier = typeof lm === 'string' ? lm.trim() : lm ? '1.7B' : ''
  const suffix = lmTier ? `（含提示词增强 ${lmTier}）` : ''
  return (adapterName ? `${base}+风格适配器(${adapterName})` : base) + suffix
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
 *
 * 人声一致性：旧实现无条件把 `[Instrumental]` 交给 /lm，等于告诉 LM「这是纯乐器」，
 * 与「caption 要日语男声」互相打架（质量模式不出人声的根因）。现在：
 * - 无人声 → 与旧行为逐字节一致（`[Instrumental]`，不带 vocal_language）；
 * - 要人声 → `lyrics: ''`（LM 自写歌词）并带 `vocal_language`，让歌词语言跟着用户意图走。
 */
export function buildQualityLmRequest(params = {}) {
  const base = buildSynthPayload(params)
  const request = {
    caption: base.caption,
    lyrics: base.lyrics,
    duration: base.duration,
    batch_size: 1,
    use_cot_caption: false,
  }
  if (wantsVocals(params)) request.vocal_language = base.vocal_language
  return withAuthoritativeMetadata(request, params)
}

/**
 * 工程元数据必须压过 LM 的推断（纯函数）：
 *
 * `bpm`/`keyscale`/`timesignature` 一旦缺省，引擎就会走 CoT「fill gaps」替用户决定，
 * 实测同一工程（165 BPM / A minor）不同次跑出 83 / 167 / 176 BPM、6/4、甚至
 * `vocal_language:'ar'` —— DAW 工程里写的是 165，成品却不在这个网格上，听感就是
 * 「不像质量模式」。所以质量档**显式下发**这三项；给了值引擎就不再改写它们
 * （vst3-README「Everything provided → LLM skips CoT」）。
 *
 * 早期注释里「塞 bpm/keyscale 会让编曲变暗」是 2B 时代的真机观察；当前 4B 上
 * A/B（同 seed / 同 50 步 / 合成端一律 165）没有复现出该退化，见报告。
 *
 * `peak_clip`：引擎默认 10 会让成品贴顶削顶（实测削顶帧 1.3%、峰值 1.000）。
 * 这里只在质量档下发 `QUALITY_PEAK_CLIP`，见常量注释。
 */
export function withAuthoritativeMetadata(request = {}, params = {}) {
  const next = { ...request }
  const rawBpm = Number(params?.bpm)
  if (Number.isFinite(rawBpm) && rawBpm > 0) next.bpm = clampInt(rawBpm, 30, 300, 120)
  const keyscale = normalizeKeyscale(params?.keyscale)
  if (keyscale) next.keyscale = keyscale
  // 拍号只在调用方真的给了才下发：normalizeTimesignature 对空值会回落 '4'，
  // 无条件写会把「调用方没管拍号」变成「我们改了他的拍号」。
  const rawTimesignature = params?.timesignature
  if (rawTimesignature !== undefined && rawTimesignature !== null && String(rawTimesignature).trim() !== '') {
    next.timesignature = normalizeTimesignature(rawTimesignature)
  }
  return next
}

/**
 * 质量档 /synth passthrough 的人声一致性（纯函数）：
 * - 无人声：强制 `[Instrumental]` + `unknown`（LM 回显什么都不能让 DiT 误开人声通道）；
 * - 要人声：LM 真写出歌词就用它；LM 只回 `[Instrumental]`/空 → 交空串让 DiT 走人声条件，
 *   语言用用户意图解析出的值（LM 的 `unknown` 不能盖掉显式 `ja`）。
 */
export function applyVocalIntentToQualityRequest(request = {}, params = {}) {
  const next = { ...request }
  if (!wantsVocals(params)) {
    next.lyrics = '[Instrumental]'
    next.vocal_language = 'unknown'
    return next
  }
  const lyrics = typeof request?.lyrics === 'string' ? request.lyrics.trim() : ''
  next.lyrics = !lyrics || lyrics === '[Instrumental]' ? '' : lyrics
  next.vocal_language = resolveVocalLanguage({ ...params, caption: params?.caption ?? request?.caption ?? '' })
  return next
}

/** 质量档：把 /lm 返回结果变成 /synth 的 passthrough 请求（sft 预设：50 步 / guidance 1.0 / shift 1.0）。 */
export function buildQualitySynthRequest(lmResult = {}, params = {}) {
  const request = { ...lmResult }
  const preset = presetForVariant('sft')
  request.inference_steps = preset.inference_steps
  request.guidance_scale = preset.guidance_scale
  request.shift = preset.shift
  if (!request.duration && Number(params?.durationSec) > 0) request.duration = params.durationSec
  request.peak_clip = QUALITY_PEAK_CLIP
  const withVocals = applyVocalIntentToQualityRequest(request, params)
  // 第二道保险：LM 回显的 bpm/keyscale/timesignature 一律让位给工程值。
  // /lm 阶段已经下发过（见 withAuthoritativeMetadata），这里再钉一次，
  // 保证「即使 LM 改写了、或调用方没走质量档 /lm，成品也落在工程网格上」。
  return withAuthoritativeMetadata(withVocals, params)
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
 * 把整体进度映射成「第 N/M 步」（纯函数）。
 *
 * 引擎只暴露任务级进度，不暴露采样步数；这里按已知的 inference_steps（快速 8 / 精修 50 /
 * 分轨 50）线性推算，并标记 estimated=true，界面显示为「≈ N/M 步」，不冒充引擎精确值。
 */
export function estimateStepProgress({ progress = 0, totalSteps = 0, from = 0.3, to = 0.9 } = {}) {
  const total = Math.max(0, Math.round(Number(totalSteps) || 0))
  if (!total) return {}
  const floor = clampProgress(from)
  const ceiling = Math.max(floor + 0.001, clampProgress(to))
  const ratio = clampProgress((clampProgress(progress) - floor) / (ceiling - floor))
  const step = Math.min(total, Math.max(1, Math.ceil(ratio * total)))
  return { step, stepTotal: total, estimated: true }
}

/**
 * 预计合成耗时（秒，纯函数，仅用于进度估算，不影响正确性）：
 * - repaint：sft 50 步，实测 20s 源音频重绘 6-12s 区间约 14.3s → 10 + 区间*0.8；
 * - generate：turbo 8 步 → 8 + 时长*0.3；
 * - XL（4B）各任务约 1.6–1.9 倍（diffusion 更重，仅为估算）。
 */
export function estimateGenerationSeconds({ type, params = {} } = {}) {
  const xl = params?.engine === 'xl'
  const factor = xl ? (params?.quality === true ? 1.9 : 1.65) : 1
  const scale = (seconds) => seconds * factor
  if (params?.quality === true) {
    const duration = Number(params?.durationSec)
    const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 30
    return scale(Math.min(600, Math.max(20, 20 + safeDuration * 1.2)))
  }
  if (type === TASK_TYPE_STEM) {
    // base 50 步；实测 20s 源音频单条 stem 1.7–14.5s，取 10 + 源时长*0.5 作估算
    const duration = Number(params?.sourceDurationSec)
    const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 20
    return scale(Math.min(300, Math.max(12, 10 + safeDuration * 0.5)))
  }
  if (type === TASK_TYPE_COVER) {
    const duration = Number(params?.sourceDurationSec)
    const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 20
    return scale(Math.min(300, Math.max(12, 8 + safeDuration * 0.6)))
  }
  if (type === TASK_TYPE_REPAINT) {
    const region = Number(params?.endSec) - Number(params?.startSec)
    const safeRegion = Number.isFinite(region) && region > 0 ? region : 10
    return scale(Math.min(300, Math.max(12, 10 + safeRegion * 0.8)))
  }
  const duration = Number(params?.durationSec)
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 30
  return scale(Math.min(300, Math.max(10, 8 + safeDuration * 0.3)))
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
  const needs = gaps
    .map((gap) => `${gap.count} 个任务需要 ${VARIANT_DISPLAY_NAMES[gap.variant] ?? '生成模型'}`)
    .join('、')
  const local =
    Array.isArray(supportedVariants) && supportedVariants.length
      ? supportedVariants.map((variant) => VARIANT_DISPLAY_NAMES[variant] ?? '生成模型').join('/')
      : '（未限制）'
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
/* AI 音频生成引擎 预检 / 健康检查                                             */
/* ------------------------------------------------------------------ */

/** 检查 bin + 必需模型（turbo/sft/embedding/vae）是否存在；缺失时返回中文原因，不抛异常。 */
export function preflightAceStep({ exists = existsSync } = {}) {
  const missing = REQUIRED_MODEL_FILES.filter((file) => !exists(file))
  if (missing.length === 0) return { ok: true, missing: [] }
  const names = missing.map((file) =>
    file === ACESTEP_BIN ? '引擎可执行文件' : (MODEL_DISPLAY_NAMES[path.basename(file)] ?? '模型文件'),
  )
  return {
    ok: false,
    missing,
    message:
      `本机 AI 音频生成引擎未安装完整（缺少${names.join('、')}）。` +
      `可运行自动安装：${PROVISION_HINT}（或在产品界面点“安装本机引擎”）；` +
      `已装好但路径不同可设置 AIAB_ENGINE_DIR / AIAB_ENGINE_MODELS_DIR`,
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
    if (spawnError) throw new Error(`无法启动 AI 音频生成引擎：${spawnError.message}`)
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`AI 音频生成引擎 启动后提前退出（exit=${child.exitCode}）${aceLogTail(logTail())}`)
    }
    try {
      const response = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) })
      if (response.ok) return
    } catch {
      /* 还没起来，继续等 */
    }
    await sleep(ACESTEP_HEALTH_POLL_MS)
  }
  throw new Error(`AI 音频生成引擎 ${Math.round(timeoutMs / 1000)}s 内未就绪${aceLogTail(logTail())}`)
}

/* ------------------------------------------------------------------ */
/* P13：本机资源遥测（CPU / 内存 / GPU）                                  */
/* ------------------------------------------------------------------ */

/**
 * 这些采样只用于「让人看见正在发生什么」，不参与生成正确性：
 * - CPU/内存：macOS/Linux 用 ps；Windows 用 PowerShell 读 CPU 时间与 WorkingSet；
 * - GPU：只在 nvidia-smi 可用时采样（Windows/Linux NVIDIA）；macOS Metal 无免密接口，
 *   如实缺省，不伪造数字；
 * - 任何命令失败都静默返回空值，绝不因为遥测把生成任务拖垮。
 */
let processTelemetryCache = { pid: 0, at: 0, value: {} }
let gpuTelemetryCache = { at: 0, value: null, failedAt: 0 }
/** Windows 进程 CPU 是累计 CPU 秒数，需要两次采样求差 */
const windowsCpuSamples = new Map()

function execTelemetry(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    timeout: TELEMETRY_CMD_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })
}

function cleanNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER, digits = 1 } = {}) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < min) return undefined
  const clamped = Math.min(max, n)
  return digits === 0 ? Math.round(clamped) : Math.round(clamped * 10 ** digits) / 10 ** digits
}

/** 采样引擎子进程 CPU% / RSS（MB）。失败或无权限时返回 {}。 */
export function sampleProcessTelemetry(pid, now = Date.now()) {
  const safePid = Number(pid)
  if (!Number.isInteger(safePid) || safePid <= 0) return {}
  try {
    if (IS_WINDOWS) {
      const output = execTelemetry('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-Process -Id ${safePid} -ErrorAction SilentlyContinue; if ($p) { "$($p.CPU);$($p.WorkingSet64)" }`,
      ])
      const [cpuSecondsRaw, workingSetRaw] = String(output).trim().split(';')
      const cpuSeconds = Number(cpuSecondsRaw)
      const workingSet = Number(workingSetRaw)
      const previous = windowsCpuSamples.get(safePid)
      windowsCpuSamples.set(safePid, { cpuSeconds, at: now })
      const rssMb = cleanNumber(workingSet / (1024 * 1024), { digits: 0 })
      if (Number.isFinite(cpuSeconds) && previous && Number.isFinite(previous.cpuSeconds)) {
        const wallMs = Math.max(1, now - previous.at)
        const deltaCpuMs = Math.max(0, (cpuSeconds - previous.cpuSeconds) * 1000)
        return { cpuPct: cleanNumber((deltaCpuMs / wallMs) * 100), rssMb }
      }
      return { rssMb }
    }
    const output = execTelemetry('ps', ['-p', String(safePid), '-o', '%cpu=,rss='])
    const [cpuRaw, rssRaw] = String(output).trim().split(/\s+/)
    const rssKb = Number(rssRaw)
    return {
      cpuPct: cleanNumber(cpuRaw),
      rssMb: cleanNumber(rssKb / 1024, { digits: 0 }),
    }
  } catch {
    windowsCpuSamples.delete(safePid)
    return {}
  }
}

/** 采样 NVIDIA GPU（利用率 / 显存 / 温度）。没有 nvidia-smi 时缓存 60s 避免反复失败。 */
export function sampleGpuTelemetry(now = Date.now()) {
  if (now - gpuTelemetryCache.at < GPU_TELEMETRY_CACHE_MS) return gpuTelemetryCache.value
  if (gpuTelemetryCache.failedAt && now - gpuTelemetryCache.failedAt < 60_000) return null
  let value = null
  try {
    const candidates = IS_WINDOWS
      ? ['nvidia-smi', 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe']
      : ['nvidia-smi']
    let output = ''
    let lastError
    for (const candidate of candidates) {
      try {
        output = execTelemetry(candidate, [
          '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu',
          '--format=csv,noheader,nounits',
        ])
        lastError = undefined
        break
      } catch (error) {
        lastError = error
      }
    }
    if (lastError) throw lastError
    const firstLine = String(output).trim().split(/\r?\n/)[0]
    if (firstLine) {
      const parts = firstLine.split(',').map((part) => part.trim())
      if (parts.length >= 5) {
        const name = parts.slice(0, parts.length - 4).join(', ')
        value = {
          gpuName: name.slice(0, 80),
          gpuUtilPct: cleanNumber(parts[parts.length - 4], { max: 100 }),
          vramUsedMb: cleanNumber(parts[parts.length - 3], { digits: 0 }),
          vramTotalMb: cleanNumber(parts[parts.length - 2], { digits: 0 }),
          gpuTempC: cleanNumber(parts[parts.length - 1], { max: 200 }),
        }
      }
    }
    if (!value) gpuTelemetryCache.failedAt = now
  } catch {
    gpuTelemetryCache.failedAt = now
  }
  gpuTelemetryCache = { at: now, value, failedAt: gpuTelemetryCache.failedAt }
  return value
}

/** 引擎进程 + GPU 的合并遥测（1.5s 缓存，心跳与进度上报共用）。 */
export function sampleTelemetry(pid, now = Date.now()) {
  if (!pid) return {}
  if (processTelemetryCache.pid === pid && now - processTelemetryCache.at < TELEMETRY_CACHE_MS) {
    return processTelemetryCache.value
  }
  const value = {
    ...sampleProcessTelemetry(pid, now),
    ...(sampleGpuTelemetry(now) ?? {}),
    sampledAt: now,
  }
  processTelemetryCache = { pid, at: now, value }
  return value
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
    api = RUNTIME_API,
  } = {}) {
    this.idleMs = Math.max(0, Number(idleMs) || 0)
    this.log = log
    this.spawnImpl = spawnImpl
    this.fetchImpl = fetchImpl
    this.now = now
    this.portRange = portRange
    this.api = api
    this.child = null
    this.variant = null
    this.adapterPath = null
    this.lm = ''
    this.state = 'stopped'
    this.port = null
    this.baseUrl = null
    this.startedAt = 0
    this.lastUsedAt = 0
    this.busy = false
    /** P13：当前生成阶段与采样步数（由执行器 / 合成轮询更新，心跳里上报） */
    this.phase = 'idle'
    this.phaseLabel = PHASE_LABELS.idle
    this.step = undefined
    this.stepTotal = undefined
    this.speed = undefined
    this.estimated = undefined
    this.logStream = null
    this.logPath = null
    this.logTail = ''
    this.spawnError = null
    this.idleTimer = null
  }

  status() {
    return {
      state: this.state,
      api: this.api,
      variant: this.variant,
      adapterPath: this.adapterPath ?? undefined,
      lm: this.lm || null,
      pid: this.child?.pid ?? null,
      port: this.port,
      warm: this.state === 'ready',
      busy: this.busy,
      phase: this.phase,
      phaseLabel: this.phaseLabel,
      step: this.step,
      stepTotal: this.stepTotal,
      speed: this.speed,
      ...this.telemetry(),
    }
  }

  /** P13：当前引擎进程的资源快照（无进程时为空对象，不伪造）。 */
  telemetry() {
    if (!this.child?.pid) return {}
    return sampleTelemetry(this.child.pid, this.now())
  }

  /** 更新当前阶段；执行器在每个阶段切换时调用（同时清掉上一步的采样步数）。 */
  setPhase(phase, phaseLabel, detail = {}) {
    this.phase = phase || 'idle'
    this.phaseLabel = phaseLabel || PHASE_LABELS[this.phase] || ''
    this.step = Number.isFinite(Number(detail.step)) ? Number(detail.step) : undefined
    this.stepTotal = Number.isFinite(Number(detail.stepTotal)) ? Number(detail.stepTotal) : undefined
    this.speed = Number.isFinite(Number(detail.speed)) ? Number(detail.speed) : undefined
    this.estimated = typeof detail.estimated === 'boolean' ? detail.estimated : undefined
  }

  /** 心跳里上报的引擎信息；没有引擎时也上报 state=stopped（界面据此显示「引擎未启动」）。 */
  heartbeatInfo() {
    const info = {
      state: this.state === 'crashed' ? 'error' : this.state,
      api: this.api,
      variant: this.variant ?? undefined,
      pid: this.child?.pid ?? undefined,
      warm: this.state === 'ready',
      lm: this.lm || null,
      device: ACESTEP_DEVICE,
      phase: this.phase,
      phaseLabel: this.phaseLabel,
      step: this.step,
      stepTotal: this.stepTotal,
      speed: this.speed,
      estimated: this.estimated,
      ...this.telemetry(),
    }
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

  /** 主入口：确保所需变体（+可选 LoRA/LM）就绪，返回 { variant, adapterPath, lm, pid, warm, baseUrl }。 */
  async ensure(desiredVariant, { adapterPath, signal, onProgress, lm = '' } = {}) {
    if (!MODEL_DITS[desiredVariant]) throw new Error(`未知引擎能力：${VARIANT_DISPLAY_NAMES[desiredVariant] ?? '生成模型'}`)
    throwIfAborted(signal)
    const desiredAdapter = adapterPath || null
    const desiredLm = typeof lm === 'string' ? lm.trim() : lm ? '1.7B' : ''
    const decision = engineDecision({
      api: this.api,
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

  async start(variant, { adapterPath, lm = '', signal, onProgress } = {}) {
    throwIfAborted(signal)
    const ditPath = MODEL_DITS[variant]
    const adapter = adapterPath || null
    const useLm = typeof lm === 'string' ? lm.trim() : lm ? '1.7B' : ''
    const modern = this.api === 'modern'
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
    let args
    if (modern) {
      if (!existsSync(ACESTEP_MODELS_DIR)) {
        this.state = 'stopped'
        this.closeLogStream()
        throw new Error('现代运行时需要模型目录，但本机缺少模型文件：请重新安装本机引擎')
      }
      args = [
        '--models', ACESTEP_MODELS_DIR,
        '--host', '127.0.0.1',
        '--port', String(port),
        '--device', ACESTEP_DEVICE,
      ]
      const adaptersDir = adapter ? path.dirname(adapter) : ADAPTERS_DIR
      if (existsSync(adaptersDir)) args.push('--adapters', adaptersDir)
    } else {
      args = [
        '--host', '127.0.0.1',
        '--port', String(port),
        '--sleep', '300',
        '--embedding', MODEL_AUX.embedding,
        '--dit', ditPath,
        '--vae', MODEL_AUX.vae,
      ]
      if (adapter) args.push('--lora', adapter, '--lora-scale', '1.0')
      if (useLm) {
        if (useLm !== '1.7B') throw new Error(`旧版运行时只支持 1.7B 档提示词增强（收到 ${useLm}）；增强档需要现代运行时`)
        if (!existsSync(MODEL_AUX.lm)) {
          this.state = 'stopped'
          this.closeLogStream()
          throw new Error('质量模式需要提示词增强模型，但本机缺少该模型文件：请重新下载“质量增强”能力')
        }
        args.push('--lm', MODEL_AUX.lm)
      }
    }
    this.log(`启动 AI 音频生成引擎：api=${this.api} variant=${engineLabel(variant, adapter, useLm)} port=${port} 日志=${logPath}`)
    if (modern) {
      this.log('现代运行时：模型按请求按需加载（增强版首次任务约 30–60s），同一进程可切换变体不重启')
    } else if (variant === 'base') {
      this.log('分轨生成模型用于音轨分离（generate_stem），冷启动较慢（真机实测 ~36s），请耐心等待…')
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
      throw new Error(`启动 AI 音频生成引擎 失败：${readableError(error)}`)
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
      this.lm = ''
      this.port = null
      this.baseUrl = null
      this.setPhase('idle', PHASE_LABELS.idle)
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
      if (this.child !== child) throw new Error('AI 音频生成引擎 启动失败：进程提前退出')
      this.state = 'ready'
      const elapsed = ((this.now() - this.startedAt) / 1000).toFixed(1)
      this.log(`AI 音频生成引擎 就绪（variant=${engineLabel(variant, adapter, useLm)} pid=${child.pid} ${elapsed}s）`)
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
    this.lm = ''
    this.port = null
    this.baseUrl = null
    this.setPhase('idle', PHASE_LABELS.idle)
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
async function acquireEngine({ ctx, engineManager, variant, adapterPath, lm = '' }) {
  const startedAt = Date.now()
  engineManager.setPhase('engine', PHASE_LABELS.engine)
  const engine = await engineManager.ensure(variant, {
    adapterPath,
    lm,
    signal: ctx.signal,
    onProgress: (progress, message) =>
      ctx.progress(progress, message, { phase: 'engine', phaseLabel: PHASE_LABELS.engine }),
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
  if (isModernRuntime()) {
    ctx.log(
      adapterPath
        ? `LoRA 适配器：adapterId=${params.adapterId} → 请求里 adapter=${path.basename(adapterPath)}`
        : `LoRA 适配器：adapterId=${params.adapterId}（服务端未下发 adapterPath，按基座执行）`,
    )
    return
  }
  ctx.log(
    adapterPath
      ? `风格适配器：adapterId=${params.adapterId} → 启动引擎时 --lora ${adapterPath}`
      : `风格适配器：adapterId=${params.adapterId}（服务端未下发 adapterPath，按基座执行）`,
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

/**
 * cover_audio 的 /synth 请求（multipart 的 request 字段）：保结构换编制。
 *
 * **必须显式发 `task_type: 'cover'`**：缺这个字段会回落 `task_type=text2music`，
 * `audio_cover_strength` 被忽略，源结构全丢、时长也被裁成默认值。
 * 实测（240s 源，同 seed）：带 task_type → 240s / 包络相关 +0.3363；
 * 不带 → 30s / 包络相关 +0.0274（= 退化为整段重新生成）。
 * 与 repaint / generate_stem 曾漏发 task_type 是同一类缺陷。
 */
export function buildCoverRequest(validated) {
  return {
    caption: validated.caption,
    lyrics: '[Instrumental]',
    seed: validated.seed,
    batch_size: 1,
    task_type: 'cover',
    audio_cover_strength: validated.strength,
    inference_steps: 8,
    guidance_scale: 1.0,
    shift: 1.0,
  }
}

/* ------------------------------------------------------------------ */
/* 现代运行时（modern API）：请求按模型选择 + 异步 job                     */
/* ------------------------------------------------------------------ */

/** 当前是否现代运行时（--models + 异步 job API）。 */
function isModernRuntime() {
  return RUNTIME_API === 'modern'
}

/**
 * 现代运行时：把 DiT/LM 选择（以及 WAV 输出格式）写进 /lm、/synth 请求体，
 * 并**按变体统一覆盖采样预设**（见 presetForVariant 与 TURBO_STEPS / TURBO_SHIFT 等常量）。
 *
 * 这是采样参数唯一的收口处：turbo 类一定是 8 步 / guidance 1.0 / shift 3.0，
 * 不允许再用「只对 xl_turbo 打补丁」的方式修 shift（那会让 2B turbo 一直吃 shift=1.0）。
 * 只对已经是 /synth 的请求体生效（/lm 请求不带采样字段，见 buildQualityLmRequest）。
 * 纯函数（不改入参），旧运行时原样返回。
 */
export function applyModelSelection(payload = {}, { variant, lmTier = '' } = {}) {
  if (!isModernRuntime()) return payload
  const next = { ...payload }
  if (variant && MODEL_FILENAMES[variant]) next.synth_model = MODEL_FILENAMES[variant]
  if (lmTier && LM_TIERS[lmTier]) next.lm_model = LM_TIERS[lmTier].file
  next.output_format = 'wav16'
  const isSynthRequest =
    Object.hasOwn(payload, 'inference_steps') || Object.hasOwn(payload, 'shift') || Object.hasOwn(payload, 'guidance_scale')
  if (isSynthRequest) {
    const preset = presetForVariant(variant)
    next.inference_steps = preset.inference_steps
    next.guidance_scale = preset.guidance_scale
    next.shift = preset.shift
  }
  return next
}

/** POST 一个现代运行时异步 job，返回 job id。 */
async function postAceJob({ baseUrl, path: jobPath, body, contentType, timeoutMs = REQUEST_TIMEOUT_MS, signal }) {
  const headers = { 'User-Agent': USER_AGENT, 'Content-Type': contentType || 'application/json' }
  let response
  try {
    response = await fetch(`${baseUrl}${jobPath}`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    })
  } catch (error) {
    if (signal?.aborted) throw new CancelledError('任务已取消')
    if (error?.name === 'TimeoutError') throw new Error(`AI 音频生成引擎 ${jobPath} 提交超时（${Math.round(timeoutMs / 1000)}s）`)
    throw new Error(`调用 AI 音频生成引擎 ${jobPath} 失败：${fetchFailureDetail(error)}`)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`AI 音频生成引擎 ${jobPath} 失败（HTTP ${response.status}）：${truncate(text, 300)}`)
  }
  let parsed
  try {
    parsed = await response.json()
  } catch {
    throw new Error(`AI 音频生成引擎 ${jobPath} 返回的不是 JSON（缺少 job id）`)
  }
  const jobId = parsed?.id
  if (!jobId) throw new Error(`AI 音频生成引擎 ${jobPath} 未返回 job id`)
  return String(jobId)
}

/** 轮询 job 直到 done/failed/cancelled；超时抛中文错误。 */
async function waitAceJob({ baseUrl, jobId, timeoutMs, signal, label = '任务', logTail = () => '', onStatus }) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(signal)
    let response
    try {
      response = await fetch(`${baseUrl}/job?id=${encodeURIComponent(jobId)}`, {
        signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
      })
    } catch (error) {
      if (signal?.aborted) throw new CancelledError('任务已取消')
      throw new Error(`查询 AI 音频生成引擎 job 失败：${fetchFailureDetail(error)}`)
    }
    if (!response.ok) throw new Error(`查询 AI 音频生成引擎 job 失败（HTTP ${response.status}）${aceLogTail(logTail())}`)
    let status = ''
    try {
      const parsed = await response.json()
      status = String(parsed?.status ?? '')
      if (parsed && typeof parsed === 'object') {
        try {
          onStatus?.(parsed)
        } catch {
          /* 状态回调失败不影响任务 */
        }
      }
    } catch {
      status = ''
    }
    if (status === 'done') return
    if (status === 'failed') throw new Error(`AI 音频生成引擎 ${label}失败（job ${jobId}）${aceLogTail(logTail())}`)
    if (status === 'cancelled') throw new Error(`AI 音频生成引擎 ${label}已取消（job ${jobId}）`)
    await sleep(1000)
  }
  throw new Error(`AI 音频生成引擎 ${label}超时（${Math.round(timeoutMs / 1000)}s）${aceLogTail(logTail())}`)
}

/** 取现代运行时 job 结果（原始 Response，可能是 multipart/mixed）。 */
async function fetchAceJobResult({ baseUrl, jobId, timeoutMs = 300_000, signal }) {
  let response
  try {
    response = await fetch(`${baseUrl}/job?id=${encodeURIComponent(jobId)}&result=1`, {
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    })
  } catch (error) {
    if (signal?.aborted) throw new CancelledError('任务已取消')
    throw new Error(`获取 AI 音频生成引擎 job 结果失败：${fetchFailureDetail(error)}`)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`获取 AI 音频生成引擎 job 结果失败（HTTP ${response.status}）：${truncate(text, 300)}`)
  }
  return response
}

/** 尽力取消现代运行时 job（失败忽略；取消主要靠杀引擎保证）。 */
async function cancelAceJob(baseUrl, jobId) {
  if (!jobId) return
  try {
    await fetch(`${baseUrl}/job?id=${encodeURIComponent(jobId)}&cancel=1`, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    /* ignore */
  }
}

/** 从 multipart/mixed（或裸 WAV）响应里取出 WAV 音频段。 */
export function extractWavFromMultipart(buffer, contentType = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('AI 音频生成引擎 返回为空')
  const asWav = (chunk) => chunk.subarray(0, 4).toString('latin1') === 'RIFF'
  if (!/multipart/i.test(contentType)) {
    if (asWav(buffer)) return buffer
    throw new Error(`AI 音频生成引擎 返回的不是 WAV（${buffer.length} 字节，content-type=${contentType || '未知'}）`)
  }
  const boundaryMatch = /boundary="?([^";]+)"?/i.exec(contentType)
  if (!boundaryMatch) throw new Error('AI 音频生成引擎 返回的 multipart 缺少 boundary')
  const marker = `--${boundaryMatch[1]}`
  const parts = []
  let index = buffer.indexOf(marker)
  while (index >= 0) {
    const start = index + marker.length
    const next = buffer.indexOf(marker, start)
    if (next < 0) break
    const chunk = buffer.subarray(start, next)
    const headerEnd = chunk.indexOf('\r\n\r\n')
    if (headerEnd >= 0) {
      const body = chunk.subarray(headerEnd + 4)
      const clean = body.subarray(0, Math.max(0, body.length - 2))
      if (asWav(clean)) parts.push(clean)
    }
    index = next
  }
  if (parts.length === 0) throw new Error(`AI 音频生成引擎 multipart 结果里没有 WAV（${buffer.length} 字节）`)
  return parts[0]
}

/**
 * 质量档（P7-A）第一步：/lm 提示词增强 + 生成语义 codes。
 * 网络/服务错误转成可读中文；取消沿用 ctx.signal。
 * 现代运行时走异步 job：POST /lm → 轮询 → GET 结果 JSON。
 */
async function postLm({ ctx, baseUrl, body, timeoutMs = ACESTEP_LM_TIMEOUT_MS }) {
  if (isModernRuntime()) {
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ctx.signal])
    const jobId = await postAceJob({ baseUrl, path: '/lm', body, timeoutMs: 60_000, signal })
    try {
      await waitAceJob({ baseUrl, jobId, timeoutMs, signal, label: '/lm' })
    } catch (error) {
      if (ctx.isCanceled?.()) {
        await cancelAceJob(baseUrl, jobId)
        throw new CancelledError(ctx.cancelReason?.() ?? '用户取消')
      }
      throw error
    }
    const response = await fetchAceJobResult({ baseUrl, jobId, timeoutMs: 120_000, signal })
    let parsed
    try {
      parsed = await response.json()
    } catch {
      throw new Error('AI 音频生成引擎 /lm 返回的不是 JSON')
    }
    const first = Array.isArray(parsed) ? parsed[0] : parsed
    if (!first || typeof first !== 'object') throw new Error('AI 音频生成引擎 /lm 返回为空')
    return first
  }
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
    if (error?.name === 'TimeoutError') throw new Error(`AI 音频生成引擎 /lm 超时（${Math.round(timeoutMs / 1000)}s）`)
    throw new Error(`调用 AI 音频生成引擎 /lm 失败：${fetchFailureDetail(error)}`)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`AI 音频生成引擎 /lm 失败（HTTP ${response.status}）：${truncate(text, 300)}`)
  }
  let parsed
  try {
    parsed = await response.json()
  } catch {
    throw new Error('AI 音频生成引擎 /lm 返回的不是 JSON')
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed
  if (!first || typeof first !== 'object') throw new Error('AI 音频生成引擎 /lm 返回为空')
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
  totalSteps = 0,
}) {
  const startedAt = Date.now()
  const pollAbort = new AbortController()
  let canceled = false
  /** 现代运行时 job 若暴露 progress，就用引擎真实比例覆盖估算（feature-detect） */
  let engineRatio
  engineManager.setPhase('sampling', PHASE_LABELS.sampling, {
    step: 1,
    stepTotal: totalSteps || undefined,
    estimated: Boolean(totalSteps),
  })
  const pollTask = (async () => {
    while (!pollAbort.signal.aborted) {
      try {
        await abortableSleep(SYNTH_PROGRESS_INTERVAL_MS, AbortSignal.any([pollAbort.signal, ctx.signal]))
      } catch {
        return
      }
      if (pollAbort.signal.aborted) return
      const elapsedMs = Date.now() - startedAt
      const progress =
        engineRatio == null
          ? estimateProgress({ elapsedMs, estimatedMs })
          : 0.3 + Math.min(1, Math.max(0, engineRatio)) * 0.6
      const stepInfo =
        engineRatio == null
          ? estimateStepProgress({ progress, totalSteps })
          : { step: Math.max(1, Math.ceil(engineRatio * Math.max(1, totalSteps))), stepTotal: totalSteps, estimated: false }
      const speed =
        totalSteps > 0 && stepInfo.step
          ? Math.round((stepInfo.step / Math.max(0.5, elapsedMs / 1000)) * 10) / 10
          : undefined
      const stepText = totalSteps > 0 ? ` · ${stepInfo.estimated ? '≈' : ''}第 ${stepInfo.step}/${totalSteps} 步` : ''
      try {
        await ctx.progress(progress, `${label}${stepText}${engineRatio == null ? '（估算）' : ''}`, {
          phase: 'sampling',
          phaseLabel: PHASE_LABELS.sampling,
          step: stepInfo.step,
          stepTotal: totalSteps || undefined,
          speed,
          estimated: stepInfo.estimated,
        })
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
  let currentJobId = ''
  try {
    let file
    if (isModernRuntime()) {
      const jobSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ctx.signal, pollAbort.signal])
      currentJobId = await postAceJob({ baseUrl, path: '/synth', body, contentType, timeoutMs: 120_000, signal: jobSignal })
      await waitAceJob({
        baseUrl,
        jobId: currentJobId,
        timeoutMs,
        signal: jobSignal,
        label: '合成',
        logTail: () => engineManager?.logTail,
        onStatus: (status) => {
          const raw = Number(status?.progress)
          if (!Number.isFinite(raw)) return
          const ratio = raw > 1 ? raw / 100 : raw
          if (ratio >= 0 && ratio <= 1) engineRatio = ratio
        },
      })
      const resultResponse = await fetchAceJobResult({ baseUrl, jobId: currentJobId, timeoutMs: 300_000, signal: jobSignal })
      const buffer = Buffer.from(await resultResponse.arrayBuffer())
      file = extractWavFromMultipart(buffer, resultResponse.headers.get('content-type') || '')
    } else {
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
        throw new Error(`AI 音频生成引擎 /synth 失败（HTTP ${response.status}）：${truncate(text, 300)}`)
      }
      file = Buffer.from(await response.arrayBuffer())
    }
    try {
      readWavInfo(file)
    } catch {
      throw new Error(`AI 音频生成引擎 返回的不是有效 WAV（${file.length} 字节）`)
    }
    // 安全网：病态直流偏置就地校正（正常音频 |mean|<0.01 原样返回，逐字节不变）。
    // 真正修复在「不要从无人声的源里抽人声」；这里只是保证坏 WAV 不流进工程。
    const sanitized = sanitizeWavDcOffset(file)
    if (sanitized.changed && sanitized.info) {
      const before = sanitized.info.mean
      const after = readMeanDcOffset(sanitized.buffer)
      ctx.log(
        `检测到异常直流偏置 (${before >= 0 ? '+' : ''}${before.toFixed(4)})，已就地校正` +
          (after ? ` → ${after.mean >= 0 ? '+' : ''}${after.mean.toFixed(6)}` : '') +
          '（安全网：本次生成可能缺少真实人声，建议检查是否误从纯乐器源音频分轨人声）',
      )
      file = sanitized.buffer
    }
    await ctx.progress(0.94, '正在解码音频…', {
      phase: 'decoding',
      phaseLabel: PHASE_LABELS.decoding,
      estimated: false,
    })
    return file
  } catch (error) {
    if (canceled || ctx.isCanceled()) {
      await cancelAceJob(baseUrl, currentJobId)
      await engineManager.kill(ctx.cancelReason())
      throw new CancelledError(ctx.cancelReason())
    }
    if (error?.name === 'TimeoutError') throw new Error(`AI 音频生成引擎 /synth 超时（${Math.round(timeoutMs / 1000)}s）`)
    if (error?.name === 'AbortError') throw new Error('AI 音频生成引擎 /synth 请求被中断')
    if (error instanceof Error && error.message.startsWith('AI 音频生成引擎')) throw error
    throw new Error(`调用 AI 音频生成引擎 /synth 失败：${fetchFailureDetail(error)}`)
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
    await ctx.progress(0.98, '正在写入工程…', {
      phase: 'upload',
      phaseLabel: PHASE_LABELS.upload,
      estimated: false,
    })
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
  const raw = Buffer.from(await response.arrayBuffer())
  try {
    readWavInfo(raw)
  } catch (error) {
    throw new Error(`源资产不是有效 WAV（${readableError(error)}）`)
  }
  // 引擎只认 16-bit PCM：24-bit 浏览器渲染 / 导入音频必须先转，否则
  // /synth 直接 400 failed to decode audio（实测日志 [WAV] Unsupported: bits=24）。
  let bytes
  try {
    bytes = toEngineDecodableWav(raw)
  } catch (error) {
    throw new Error(`源资产无法转成引擎可解码的 WAV（${readableError(error)}）`)
  }
  const tempFile = path.join(
    os.tmpdir(),
    `aiab-companion-src-${sanitizeFileName(sourceAssetId)}-${process.pid}-${Date.now()}.wav`,
  )
  writeFileSync(tempFile, bytes)
  return { tempFile, bytes, converted: bytes !== raw }
}

/**
 * 生产执行器：常驻引擎 + generate_audio / repaint_audio。
 * 引擎生命周期由共享的 EngineManager 管理（跨任务复用，变体切换才重启）。
 */
export function createAceStepExecutor({ serverUrl, engineManager, log = () => {} } = {}) {
  if (!engineManager) throw new Error('createAceStepExecutor 需要 engineManager（常驻引擎管理器）')
  return {
    kind: 'acestep',
    name: '本机生成引擎（GPU 常驻）',
    capabilities: buildCapabilities('acestep'),
    async run(task, ctx) {
      const preflight = preflightAceStep()
      if (!preflight.ok) throw new Error(preflight.message)
      if (task.type === TASK_TYPE_GENERATE) return runGenerate(task, ctx, { engineManager })
      if (task.type === TASK_TYPE_REPAINT) return runRepaint(task, ctx, { engineManager, serverUrl })
      if (task.type === TASK_TYPE_STEM) return runStem(task, ctx, { engineManager, serverUrl })
      if (task.type === TASK_TYPE_COVER) return runCover(task, ctx, { engineManager, serverUrl })
      throw new Error(`AI 音频生成引擎 执行器不支持任务类型：${task.type}`)
    },
  }
}

async function runGenerate(task, ctx, { engineManager }) {
  const params = task.params ?? {}
  const adapterPath = resolveAdapterPath(params)
  const quality = params.quality === true
  const engineTier = normalizeEngineTier(params)
  const variant = variantForTask(TASK_TYPE_GENERATE, params)
  const lmTier = quality ? lmTierForTask(TASK_TYPE_GENERATE, params, variant) : ''
  if (engineTier === 'xl' && !MODERN_RUNTIME) {
    throw new Error('XL 引擎需要现代运行时（旧版运行时不支持 4B 模型）；请先安装最新本机引擎')
  }
  if (quality && adapterPath) {
    throw new Error('质量模式使用精修生成模型，暂不支持同时使用风格适配器：请关闭适配器，或改用快速模式')
  }
  if (quality) {
    const lmPath = LM_TIERS[lmTier]?.path
    if (!lmPath || !existsSync(lmPath)) {
      throw new Error(`质量模式需要提示词增强模型（${lmTier} 档），但本机缺少该模型文件：请重新下载“质量增强”能力`)
    }
  }
  if (!existsSync(MODEL_DITS[variant])) {
    throw new Error(`缺少${VARIANT_DISPLAY_NAMES[variant] ?? '生成模型'}模型文件，请先安装对应模型档`)
  }
  logAdapterUsage(ctx, params, adapterPath)
  const basePayload = quality ? buildQualityLmRequest(params) : buildSynthPayload(params)
  const lmPayload = quality ? applyModelSelection(basePayload, { variant, lmTier }) : basePayload
  ctx.log(
    `执行 generate_audio（${engineLabel(variant, adapterPath, lmTier)}，${basePayload.duration}s / ${basePayload.bpm ?? params.bpm ?? '?'} BPM / ${basePayload.keyscale ?? params.keyscale ?? '?'}${quality ? `，质量模式：提示词增强(${lmTier})→${VARIANT_DISPLAY_NAMES[variant] ?? '精修生成模型'} ${QUALITY_STEPS} 步` : ''}）`,
  )
  await ctx.progress(0.05, '准备任务', { phase: 'prepare', phaseLabel: PHASE_LABELS.prepare })
  const engine = await acquireEngine({ ctx, engineManager, variant, adapterPath, lm: lmTier })
  try {
    const totalSteps = quality ? QUALITY_STEPS : Number(basePayload.inference_steps) || 8
    if (quality) {
      const engineHint = `（${VARIANT_DISPLAY_NAMES[variant] ?? '精修生成模型'} + 提示词增强 ${lmTier}）`
      await ctx.progress(0.3, engine.warm ? `复用常驻引擎${engineHint}` : `开始质量合成${engineHint}`, {
        phase: 'prompt',
        phaseLabel: PHASE_LABELS.prompt,
      })
      const lmStartedAt = Date.now()
      const lmResult = await postLm({ ctx, baseUrl: engine.baseUrl, body: JSON.stringify(lmPayload) })
      const codeLen = typeof lmResult.audio_codes === 'string' ? lmResult.audio_codes.length : 0
      ctx.log(`LM 返回字段：${Object.keys(lmResult).join(',')}（audio_codes ${codeLen} 字符）`)
      const synthRequest = applyModelSelection(buildQualitySynthRequest(lmResult, params), { variant, lmTier })
      ctx.log(
        `LM 完成（${((Date.now() - lmStartedAt) / 1000).toFixed(1)}s）：bpm=${synthRequest.bpm ?? '?'} key=${synthRequest.keyscale ?? '?'} → ${VARIANT_DISPLAY_NAMES[variant] ?? '精修生成模型'} ${QUALITY_STEPS} 步合成`,
      )
      await ctx.progress(0.4, `合成中（质量模式 ${QUALITY_STEPS} 步）`, {
        phase: 'sampling',
        phaseLabel: PHASE_LABELS.sampling,
        step: 1,
        stepTotal: totalSteps,
        estimated: true,
      })
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
        totalSteps,
      })
      await reportCompletionProgress({ ctx, engineManager })
      return { file, fileName: `${sanitizeFileName(task.id)}.wav` }
    }

    // 采样预设（含 turbo 的 shift=3.0）已由 buildSynthPayload / applyModelSelection 统一决定
    const payload = applyModelSelection(basePayload, { variant })
    await ctx.progress(
      0.3,
      engine.warm ? `复用常驻引擎（${engineLabel(variant, adapterPath)}）` : `开始生成音频（${VARIANT_DISPLAY_NAMES[variant] ?? '快速生成模型'}）`,
      { phase: 'sampling', phaseLabel: PHASE_LABELS.sampling, step: 1, stepTotal: totalSteps, estimated: true },
    )
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
      totalSteps,
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
  const engineTier = normalizeEngineTier(params)
  const variant = variantForTask(TASK_TYPE_REPAINT, params)
  if (engineTier === 'xl' && !MODERN_RUNTIME) {
    throw new Error('XL 引擎需要现代运行时（旧版运行时不支持 4B 模型）；请先安装最新本机引擎')
  }
  if (!existsSync(MODEL_DITS[variant])) {
    throw new Error(`repaint_audio 需要${VARIANT_DISPLAY_NAMES[variant] ?? '生成模型'}模型文件，请先安装对应模型档`)
  }
  logAdapterUsage(ctx, params, adapterPath)
  // 1) 引擎启动前先做基本参数校验（服务端若已下发 sourceDurationSec，可提前拦住越界区间，省一次下载）
  const serverDuration = Number(params.sourceDurationSec)
  const basicOptions = Number.isFinite(serverDuration) && serverDuration > 0 ? { sourceDurationSec: serverDuration } : {}
  const basic = validateRepaintParams(params, basicOptions)
  if (basic.style) ctx.log(`style=${basic.style}（仅记录，未参与引擎参数）`)
  ctx.log(`执行 repaint_audio（${engineLabel(variant, adapterPath)}）：source=${basic.sourceAssetId} ${basic.startSec}-${basic.endSec}s`)
  await ctx.progress(0.05, '下载源音频', { phase: 'prepare', phaseLabel: PHASE_LABELS.prepare })
  const source = await downloadSourceToTemp({ serverUrl, sourceAssetId: basic.sourceAssetId, ctx })
  try {
    const info = readWavInfo(source.bytes)
    // 2) 拿到源时长后再校验 endSec 不越界（这一步仍在启动引擎之前）
    const validated = validateRepaintParams(params, { sourceDurationSec: info.durationSec })
    ctx.log(`源音频 ${info.durationSec.toFixed(2)}s / ${info.sampleRate}Hz / ${info.channels}ch${source.converted ? ' · 已转 16-bit 供引擎解码' : ''}`)
    const engine = await acquireEngine({ ctx, engineManager, variant, adapterPath: validated.adapterPath })
    try {
      const regionSec = (validated.endSec - validated.startSec).toFixed(1)
      await ctx.progress(
        0.3,
        `开始重绘 ${validated.startSec}-${validated.endSec}s（${engineLabel(variant, validated.adapterPath)}，${regionSec}s）`,
        { phase: 'sampling', phaseLabel: PHASE_LABELS.sampling, step: 1, stepTotal: 50, estimated: true },
      )
      const request = applyModelSelection(buildRepaintRequest(validated), { variant })
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
        totalSteps: Number(request.inference_steps) || 50,
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
 * cover_audio（P7-B）：保结构换编制（multipart request+audio）。
 */
async function runCover(task, ctx, { engineManager, serverUrl }) {
  const params = task.params ?? {}
  const validated = validateCoverParams(params)
  const engineTier = normalizeEngineTier(params)
  const variant = variantForTask(TASK_TYPE_COVER, params)
  if (engineTier === 'xl' && !MODERN_RUNTIME) {
    throw new Error('XL 引擎需要现代运行时（旧版运行时不支持 4B 模型）；请先安装最新本机引擎')
  }
  if (!existsSync(MODEL_DITS[variant])) {
    throw new Error(`cover_audio 需要${VARIANT_DISPLAY_NAMES[variant] ?? '生成模型'}模型文件，请先安装对应模型档`)
  }
  ctx.log(
    `执行 cover_audio（${engineLabel(variant)}）：source=${validated.sourceAssetId} strength=${validated.strength.toFixed(2)}`,
  )
  await ctx.progress(0.05, '下载源音频', { phase: 'prepare', phaseLabel: PHASE_LABELS.prepare })
  const source = await downloadSourceToTemp({ serverUrl, sourceAssetId: validated.sourceAssetId, ctx })
  try {
    const info = readWavInfo(source.bytes)
    ctx.log(`源音频 ${info.durationSec.toFixed(2)}s / ${info.sampleRate}Hz / ${info.channels}ch${source.converted ? ' · 已转 16-bit 供引擎解码' : ''}`)
    const engine = await acquireEngine({ ctx, engineManager, variant })
    try {
      await ctx.progress(0.15, engine.warm ? `复用常驻引擎（${variant}）` : `开始重编（cover，${variant}）`, {
        phase: 'sampling',
        phaseLabel: PHASE_LABELS.sampling,
        step: 1,
        stepTotal: 8,
        estimated: true,
      })
      const request = applyModelSelection(
        buildCoverRequest({
          ...validated,
          sourceDurationSec: info.durationSec,
        }),
        { variant },
      )
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
        totalSteps: Number(request.inference_steps) || 8,
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
  const engineTier = normalizeEngineTier(params)
  const variant = variantForTask(TASK_TYPE_STEM, params)
  if (engineTier === 'xl' && !MODERN_RUNTIME) {
    throw new Error('XL 引擎需要现代运行时（旧版运行时不支持 4B 模型）；请先安装最新本机引擎')
  }
  logAdapterUsage(ctx, params, adapterPath)
  if (!existsSync(MODEL_DITS[variant])) {
    throw new Error('分轨生成需要分轨生成模型，但本机缺少该模型文件：请先下载“分轨能力”')
  }
  const lmTier = lmTierForTask(TASK_TYPE_STEM, params)
  ctx.log(
    `执行 generate_stem（${engineLabel(variant, adapterPath)}，arm=${validated.arm} → track=${validated.track}）：source=${validated.sourceAssetId}`,
  )
  ctx.log('说明：extract 会按源音频时长锁定输出，分离出该乐器的 stem（不是另一首新歌）')
  await ctx.progress(0.05, '下载源音频', { phase: 'prepare', phaseLabel: PHASE_LABELS.prepare })
  const source = await downloadSourceToTemp({ serverUrl, sourceAssetId: validated.sourceAssetId, ctx })
  try {
    const info = readWavInfo(source.bytes)
    ctx.log(`源音频 ${info.durationSec.toFixed(2)}s / ${info.sampleRate}Hz / ${info.channels}ch${source.converted ? ' · 已转 16-bit 供引擎解码' : ''}`)
    const engine = await acquireEngine({ ctx, engineManager, variant, adapterPath, lm: lmTier })
    try {
      await ctx.progress(0.3, `开始拆分 ${validated.arm}（${engineLabel(variant, adapterPath)}）`, {
        phase: 'sampling',
        phaseLabel: PHASE_LABELS.sampling,
        step: 1,
        stepTotal: 50,
        estimated: true,
      })
      const request = applyModelSelection(buildExtractRequest(validated), { variant, lmTier })
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
        totalSteps: Number(request.inference_steps) || 50,
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

  async progress(taskId, progress, message, extra = {}) {
    try {
      const json = await withRetry(
        () =>
          this.requestJson('/api/companion/progress', {
            body: this.authBody({
              taskId,
              progress: clampProgress(progress),
              message: message || undefined,
              ...extra,
            }),
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

async function handleTask(task, executor, client, state, log, engineManager = null) {
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
  engineManager?.setPhase('prepare', PHASE_LABELS.prepare)
  const runCtx = {
    signal: controller.signal,
    isCanceled: () => state.cancelRequested || controller.signal.aborted,
    cancelReason: () => state.cancelReason || '用户取消',
    log: (message) => log(message, { taskId: task.id }),
    progress: async (value, message, extra = {}) => {
      const progress = clampProgress(value)
      if (extra.phase || extra.stepTotal) {
        engineManager?.setPhase(extra.phase ?? engineManager.phase, extra.phaseLabel, extra)
      }
      log(`进度 ${Math.round(progress * 100)}%${message ? ` · ${message}` : ''}`, { taskId: task.id })
      let response
      try {
        response = await client.progress(task.id, progress, message, {
          ...extra,
          telemetry: engineManager?.telemetry(),
        })
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
    engineManager?.setPhase('idle', PHASE_LABELS.idle)
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
  log(
    `运行时形态：${RUNTIME_API === 'modern' ? 'modern（--models + 异步 job，支持 XL 4B）' : 'legacy（v0.1.0，仅 2B）'}` +
      ` · 引擎目录=${ACESTEP_DIR}` +
      (RUNTIME_API === 'modern' ? ` · 设备=${ACESTEP_DEVICE}` : ''),
  )

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
      const succeeded = await handleTask(task, activeExecutor, client, state, log, engineManager)
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