/**
 * 产品对外命名（本机 AI 音频生成相关）。
 *
 * 产品界面统一使用这里的中性名称：**不暴露底层开源模型、权重仓库与量化文件的真实名字**。
 * 这里只影响「展示」——下载地址、磁盘文件名、内部 id / 枚举仍指向真实资产，
 * 这样既有安装不需要迁移、能力匹配也不会被命名改动影响。
 *
 * 例：
 *   ACE-Step 1.5 运行时 / 权重   → AI 音频生成引擎运行时 / 快速生成模型…
 *   Qwen3-Embedding              → 语义编码器
 *   VAE                          → 音频编解码器
 */

/** 本机 AI 音频生成引擎的对外名称 */
export const AI_ENGINE_NAME = 'AI 音频生成引擎'

/** 本机运行时（可执行文件）的对外名称 */
export const AI_ENGINE_RUNTIME_NAME = 'AI 音频生成引擎运行时'

/**
 * 磁盘上的模型文件名 → 界面展示名。
 * 键必须是运行时真实读取的文件名；新增模型时在这里补一行展示名即可。
 */
export const MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  'Qwen3-Embedding-0.6B-Q8_0.gguf': '语义编码器',
  'vae-BF16.gguf': '音频编解码器',
  'acestep-v15-turbo-Q8_0.gguf': '快速生成模型',
  'acestep-v15-sft-Q8_0.gguf': '精修生成模型',
  'acestep-5Hz-lm-1.7B-Q8_0.gguf': '提示词增强模型',
  'acestep-v15-base-Q8_0.gguf': '分轨生成模型',
  // P9 XL（4B）档：与标准档同名的能力用「（增强版）」区分，界面不暴露真实权重文件名
  'acestep-v15-xl-turbo-Q8_0.gguf': '快速生成模型（增强版）',
  'acestep-v15-xl-sft-Q8_0.gguf': '精修生成模型（增强版）',
  'acestep-v15-xl-base-Q8_0.gguf': '分轨生成模型（增强版）',
  'acestep-5Hz-lm-4B-Q8_0.gguf': '提示词增强模型（增强版）',
}

/** 引擎变体（内部 id：turbo / sft / base / xl_*）→ 界面展示名 */
export const ENGINE_VARIANT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  turbo: '快速生成模型',
  sft: '精修生成模型',
  base: '分轨生成模型',
  xl_turbo: '快速生成模型（增强版）',
  xl_sft: '精修生成模型（增强版）',
  xl_base: '分轨生成模型（增强版）',
}

/** 未知模型文件的兜底展示名（宁可笼统，也不泄露真实名字） */
const FALLBACK_MODEL_DISPLAY_NAME = '本机 AI 模型'

/** 取文件名（容忍 Windows 反斜杠 / 绝对路径） */
function baseName(fileName: string): string {
  const normalized = fileName.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/** 模型文件名 → 对外展示名 */
export function modelDisplayName(fileName: string): string {
  const name = baseName(fileName)
  return MODEL_DISPLAY_NAMES[name] ?? FALLBACK_MODEL_DISPLAY_NAME
}

/** 引擎变体 → 对外展示名（未知值也给一个笼统名字） */
export function variantDisplayName(variant: string | null | undefined): string {
  const key = String(variant ?? '').trim().toLowerCase()
  if (!key) return FALLBACK_MODEL_DISPLAY_NAME
  return ENGINE_VARIANT_DISPLAY_NAMES[key] ?? FALLBACK_MODEL_DISPLAY_NAME
}
