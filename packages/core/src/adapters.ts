/**
 * 适配器（LoRA / LoKR）清单与运行时兼容性校验。
 *
 * 这些规则不是拍脑袋来的，是 2026-11-08 实测结论（见
 * `music-gen/lora-data/ab/jrpg_v1/REPORT.md`）：
 *
 * 1. C++ 运行时（acestep.cpp / VST3 / NAS 侧）只认 PEFT 目录
 *    （`adapter_config.json` + `adapter_model.safetensors`，键名 `lora_A/lora_B`）。
 * 2. LoKR（LyCORIS，键名 `lokr_w1/lokr_w2`）在 C++ 侧**静默失效**：
 *    单文件载入 816 张量却 `Merged 0 pairs`；给目录则找不到
 *    `adapter_model.safetensors` 后跳过、继续生成基线音频，不报错。
 * 3. 适配器绑死基座 DiT 变体：`turbo` 上训的只能用于 text2music/cover；
 *    lego（加轨）必须在 `base` 上训；repaint 必须在 `sft` 上训。
 *
 * 所以模型清单里必须记录 `format`、`baseModel`、`tasks`，并在加载后
 * 校验 `mergedPairs > 0`；否则会出现"看起来加载了、其实没生效"。
 */
import { z } from 'zod'

/* ------------------------------------------------------------------ */
/* 枚举                                                                */
/* ------------------------------------------------------------------ */

/** 运行时：C++ 引擎（VST3/NAS/低延迟）或 Python 侧（研究/批量） */
export const ADAPTER_RUNTIMES = ['native-cpp', 'python'] as const
export type AdapterRuntime = (typeof ADAPTER_RUNTIMES)[number]

/** 适配器文件格式 */
export const ADAPTER_FORMATS = ['lora-peft', 'lora-comfyui', 'lokr-lycoris'] as const
export type AdapterFormat = (typeof ADAPTER_FORMATS)[number]

/** 基座 DiT 变体（与 ACE-Step 训练 CLI 的 --base-model 对齐） */
export const BASE_MODELS = ['turbo', 'base', 'sft', 'xl_turbo', 'xl_base', 'xl_sft'] as const
export type BaseModel = (typeof BASE_MODELS)[number]

/** ACE-Step 1.5 的六种任务 */
export const GENERATION_TASKS = ['text2music', 'cover', 'repaint', 'lego', 'extract', 'complete'] as const
export type GenerationTask = (typeof GENERATION_TASKS)[number]

/** 任务 → 必须使用的基座变体（null 表示不限定） */
export const TASK_REQUIRED_BASE: Record<GenerationTask, readonly BaseModel[] | null> = {
  text2music: null,
  cover: null,
  // 实测：lego 只支持 base 模型
  lego: ['base', 'xl_base'],
  // 实测：repaint 只支持 sft 模型
  repaint: ['sft', 'xl_sft'],
  extract: null,
  complete: null,
}

/** 各格式在哪些运行时可用（LoKR 目前只能 Python 侧） */
export const FORMAT_RUNTIME_SUPPORT: Record<AdapterFormat, readonly AdapterRuntime[]> = {
  'lora-peft': ['native-cpp', 'python'],
  'lora-comfyui': ['native-cpp', 'python'],
  'lokr-lycoris': ['python'],
}

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

export const adapterFileSchema = z.object({
  path: z.string(),
  bytes: z.number().min(0).default(0),
  sha256: z.string().optional(),
})

export const adapterManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 风格归属，如 'jrpg' / 'jrock'；自定义风格可留空 */
  styleId: z.string().optional(),
  /** 训练时使用的基座变体 */
  baseModel: z.enum(BASE_MODELS),
  /** 基座权重指纹，防止"换了基座却复用了旧适配器" */
  baseModelHash: z.string().optional(),
  /** 该适配器适用的任务；空数组表示未声明（调用方需自行把关） */
  tasks: z.array(z.enum(GENERATION_TASKS)).default([]),
  format: z.enum(ADAPTER_FORMATS),
  /** 训练时的 rank / alpha（LoRA）或 linear dim（LoKR） */
  rank: z.number().min(0).optional(),
  alpha: z.number().min(0).optional(),
  /** 推理时的默认缩放，1.0 为原样 */
  scale: z.number().min(0).max(4).default(1),
  bytes: z.number().min(0).default(0),
  sha256: z.string().optional(),
  files: z.array(adapterFileSchema).default([]),
  /** 训练数据来源与许可（合规追溯用；空 = 未知，产品侧应视为不可商用） */
  license: z.string().optional(),
  /** 训练数据集的说明，例如 "ace-step-self-generated:30 clips" */
  datasetNote: z.string().optional(),
  /** 训练摘要：步数 / 最终 loss / 时长 */
  training: z
    .object({
      steps: z.number().min(0).optional(),
      epochs: z.number().min(0).optional(),
      finalLoss: z.number().optional(),
      bestLoss: z.number().optional(),
      seconds: z.number().min(0).optional(),
      peakVramGb: z.number().min(0).optional(),
      createdAt: z.number().optional(),
    })
    .optional(),
  /** 首次在某个运行时上实测通过（C++ 侧要求 mergedPairs > 0） */
  verified: z
    .object({
      runtime: z.enum(ADAPTER_RUNTIMES),
      mergedPairs: z.number().min(0),
      at: z.number(),
    })
    .optional(),
  createdAt: z.number(),
})
export type AdapterManifest = z.infer<typeof adapterManifestSchema>

/* ------------------------------------------------------------------ */
/* 兼容性校验                                                          */
/* ------------------------------------------------------------------ */

export interface AdapterCompatibilityQuery {
  runtime: AdapterRuntime
  baseModel?: BaseModel
  task?: GenerationTask
}

export interface AdapterCompatibility {
  ok: boolean
  /** 阻断级问题（不能加载 / 加载了也不会生效） */
  errors: string[]
  /** 警告级问题（能跑，但结果可能不符预期或存在合规风险） */
  warnings: string[]
}

export function checkAdapterCompatibility(
  adapter: AdapterManifest,
  query: AdapterCompatibilityQuery,
): AdapterCompatibility {
  const errors: string[] = []
  const warnings: string[] = []

  // 规则 1：格式 × 运行时
  const supported = FORMAT_RUNTIME_SUPPORT[adapter.format] ?? []
  if (!supported.includes(query.runtime)) {
    errors.push(
      adapter.format === 'lokr-lycoris'
        ? `LoKR 适配器在 ${query.runtime} 上会被静默跳过（实测 Merged 0 pairs），请改用 lora-peft 格式`
        : `格式 ${adapter.format} 不支持 ${query.runtime} 运行时`,
    )
  }

  // 规则 2：基座绑定
  if (query.baseModel && adapter.baseModel !== query.baseModel) {
    errors.push(`适配器基于 ${adapter.baseModel} 训练，不能用于 ${query.baseModel} 基座`)
  }

  // 规则 3：任务 × 基座
  if (query.task) {
    const required = TASK_REQUIRED_BASE[query.task]
    if (required && !required.includes(adapter.baseModel)) {
      errors.push(`任务 ${query.task} 只能使用 ${required.join('/')} 基座，该适配器基于 ${adapter.baseModel}`)
    }
    if (adapter.tasks.length && !adapter.tasks.includes(query.task)) {
      errors.push(`适配器未声明支持任务 ${query.task}（已声明：${adapter.tasks.join(',')}）`)
    }
  }

  // 规则 4：C++ 侧需要实测过 mergedPairs > 0
  if (query.runtime === 'native-cpp') {
    if (!adapter.verified) {
      warnings.push('该适配器尚未在 C++ 运行时实测加载（请校验 mergedPairs > 0）')
    } else if (adapter.verified.runtime !== 'native-cpp' || adapter.verified.mergedPairs <= 0) {
      errors.push(
        `C++ 侧实测 mergedPairs=${adapter.verified.mergedPairs}（必须 > 0），适配器实际未生效`,
      )
    }
  }

  // 合规提示
  if (!adapter.license) {
    warnings.push('未声明许可：产品分发前必须确认训练数据权利')
  }

  return { ok: errors.length === 0, errors, warnings }
}

/** 训练完成后、发布前的清单体检：返回所有会导致"静默失效"的问题 */
export function auditAdapter(adapter: AdapterManifest): AdapterCompatibility {
  return checkAdapterCompatibility(adapter, { runtime: 'native-cpp' })
}

/* ------------------------------------------------------------------ */
/* 从磁盘目录构建清单（纯函数 + 注入 fs，便于单测）                        */
/* ------------------------------------------------------------------ */

/** 目录里一个文件（相对路径 + 字节数） */
export interface AdapterFsEntry {
  path: string
  bytes: number
}

/** 读取适配器目录所需的最小文件系统能力 */
export interface AdapterFsReader {
  listFiles(dir: string): AdapterFsEntry[]
  readJson<T = unknown>(path: string): T | null
}

/** 我们的适配器旁注文件（由训练脚本写入，非 PEFT 标准） */
export interface AdapterSidecar {
  id?: string
  name?: string
  styleId?: string
  baseModel?: BaseModel
  tasks?: GenerationTask[]
  license?: string
  datasetNote?: string
  scale?: number
  training?: AdapterManifest['training']
  sha256?: string
}

const PEFT_WEIGHTS = 'adapter_model.safetensors'
const PEFT_CONFIG = 'adapter_config.json'
const LOKR_WEIGHTS = 'lokr_weights.safetensors'
const COMFY_WEIGHTS = 'comfyui_lora.safetensors'
const SIDECAR = 'adapter.json'
const VERIFIED = 'verified.json'

/**
 * 扫描一个适配器目录，推断格式并产出清单。
 * 目录结构不合法时返回 error（而不是抛异常，方便批量扫描）。
 */
export function buildAdapterManifest(
  dirName: string,
  fs: AdapterFsReader,
): { ok: true; manifest: AdapterManifest } | { ok: false; error: string } {
  const files = fs.listFiles(dirName)
  const names = new Set(files.map((f) => f.path))
  const pick = (name: string) => files.find((f) => f.path === name)

  let format: AdapterFormat
  if (pick(PEFT_WEIGHTS)) {
    format = 'lora-peft'
  } else if (pick(LOKR_WEIGHTS)) {
    format = 'lokr-lycoris'
  } else if (pick(COMFY_WEIGHTS)) {
    format = 'lora-comfyui'
  } else {
    return {
      ok: false,
      error: `找不到适配器权重（${PEFT_WEIGHTS} / ${LOKR_WEIGHTS} / ${COMFY_WEIGHTS}）`,
    }
  }

  const sidecar = names.has(SIDECAR)
    ? (fs.readJson<AdapterSidecar>(`${dirName}/${SIDECAR}`) ?? {})
    : {}
  const peftConfig = names.has(PEFT_CONFIG)
    ? (fs.readJson<{ r?: number; lora_alpha?: number }>(`${dirName}/${PEFT_CONFIG}`) ?? {})
    : {}
  const verifiedRaw = names.has(VERIFIED)
    ? fs.readJson<{ runtime?: AdapterRuntime; mergedPairs?: number; at?: number }>(
        `${dirName}/${VERIFIED}`,
      )
    : null
  const verified =
    verifiedRaw && typeof verifiedRaw.mergedPairs === 'number'
      ? {
          runtime: verifiedRaw.runtime ?? ('native-cpp' as AdapterRuntime),
          mergedPairs: verifiedRaw.mergedPairs,
          at: verifiedRaw.at ?? 0,
        }
      : undefined

  const manifest = {
    id: sidecar.id ?? dirName.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? dirName,
    name: sidecar.name ?? (dirName.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? dirName),
    styleId: sidecar.styleId,
    baseModel: sidecar.baseModel ?? 'turbo',
    tasks: sidecar.tasks ?? [],
    format,
    rank: peftConfig.r,
    alpha: peftConfig.lora_alpha,
    scale: sidecar.scale ?? 1,
    bytes: files.reduce((sum, f) => sum + (f.bytes || 0), 0),
    sha256: sidecar.sha256,
    files: files.map((f) => ({ path: f.path, bytes: f.bytes })),
    license: sidecar.license,
    datasetNote: sidecar.datasetNote,
    training: sidecar.training,
    verified,
    createdAt: 0,
  }

  // 旁注/配置里常见 null（例如未填 license / 未跑验证），zod 的 .optional() 只接受 undefined
  const cleaned = JSON.parse(
    JSON.stringify(manifest, (_key, value) => (value === null ? undefined : value)),
  ) as Record<string, unknown>
  const parsed = adapterManifestSchema.safeParse(cleaned)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      ok: false,
      error: `清单校验失败：${issue ? `${issue.path.join('.')} ${issue.message}` : '未知'}`,
    }
  }
  return { ok: true, manifest: parsed.data }
}

/* ------------------------------------------------------------------ */
/* 适配器推荐（按风格 / 任务 / 运行时挑一个能用的）                        */
/* ------------------------------------------------------------------ */

export interface AdapterPickQuery {
  /** 目标风格，如 'jrpg'；为空则不按风格过滤 */
  styleId?: string
  baseModel?: BaseModel
  task?: GenerationTask
  runtime: AdapterRuntime
}

export interface AdapterPick {
  /** 选中的适配器；没有可用适配器时为 undefined（应回退到基线模型） */
  adapter?: AdapterManifest
  /** 候选与不可用原因，便于 UI 解释"为什么没用上 LoRA" */
  candidates: { id: string; ok: boolean; errors: string[] }[]
  reasons: string[]
}

/**
 * 挑适配器：先按兼容性过滤，再按「风格匹配 > 已实测 > 名称」排序。
 * 没有可用适配器时返回空（调用方应无 LoRA 直接生成，而不是报错）。
 */
export function recommendAdapter(adapters: AdapterManifest[], query: AdapterPickQuery): AdapterPick {
  const candidates: AdapterPick['candidates'] = []
  const usable: AdapterManifest[] = []

  for (const adapter of adapters) {
    const compat = checkAdapterCompatibility(adapter, {
      runtime: query.runtime,
      baseModel: query.baseModel,
      task: query.task,
    })
    candidates.push({ id: adapter.id, ok: compat.ok, errors: compat.errors })
    if (compat.ok) usable.push(adapter)
  }

  if (usable.length === 0) {
    const first = candidates[0]
    return {
      candidates,
      reasons: [
        candidates.length === 0
          ? '没有已注册的适配器，使用基线模型'
          : `没有兼容 ${query.runtime} 的适配器${first ? `（${first.id}: ${first.errors[0] ?? '不兼容'}）` : ''}，使用基线模型`,
      ],
    }
  }

  const score = (a: AdapterManifest) =>
    (query.styleId && a.styleId === query.styleId ? 4 : 0) +
    (a.verified && a.verified.mergedPairs > 0 ? 2 : 0) +
    (a.styleId ? 1 : 0)
  const sorted = [...usable].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))
  const chosen = sorted[0]!
  const reasons: string[] = []
  if (query.styleId && chosen.styleId === query.styleId) reasons.push(`风格匹配 ${query.styleId}`)
  else if (query.styleId) reasons.push(`没有 ${query.styleId} 专用适配器，回退到通用适配器 ${chosen.id}`)
  if (chosen.verified && chosen.verified.mergedPairs > 0) {
    reasons.push(`C++ 实测 mergedPairs=${chosen.verified.mergedPairs}`)
  } else {
    reasons.push('该适配器尚未实测加载，建议先跑 register_adapter.py --verify')
  }
  return { adapter: chosen, candidates, reasons }
}
