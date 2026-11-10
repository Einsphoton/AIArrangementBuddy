/**
 * 音频域数据模型（Studio 形态扩展）
 *
 * 设计约束：
 * - 工程里**只存资产引用**（hash + 元数据），绝不内联音频二进制；
 * - 音频片段与 MIDI 片段平行：`Track.clips` 放 MIDI，`Track.audioClips` 放音频；
 * - 每次生成都带 `Provenance`（模型 / seed / 提示词 / 适配器 / 许可快照），
 *   既支撑"同 seed 重生成"，也支撑合规追溯。
 *
 * 目录：本文件只放 zod schema 与类型，工厂函数留在 model.ts，避免循环依赖。
 */
import { z } from 'zod'

/* ------------------------------------------------------------------ */
/* 资产引用                                                            */
/* ------------------------------------------------------------------ */

export const ASSET_KINDS = ['audio', 'waveform', 'midi', 'analysis'] as const
export type AssetKind = (typeof ASSET_KINDS)[number]

export const assetRefSchema = z.object({
  id: z.string(),
  /** 内容哈希（sha256），用于去重与完整性校验 */
  sha256: z.string(),
  kind: z.enum(ASSET_KINDS),
  /** 字节数 */
  bytes: z.number().min(0).default(0),
  durationMs: z.number().min(0).optional(),
  sampleRate: z.number().min(0).optional(),
  channels: z.number().min(0).optional(),
  /** 默认留在生成它的设备上；cloud 表示已上传可跨设备 */
  residency: z.enum(['local', 'cloud']).default('local'),
  /** residency=local 时，哪台设备持有该文件 */
  deviceId: z.string().optional(),
  /** 仅本地可见的绝对路径（不参与云同步） */
  localPath: z.string().optional(),
  /** 低码率试听地址（跨设备没拿到原始文件时先听这个） */
  previewUrl: z.string().optional(),
  name: z.string().optional(),
  createdAt: z.number(),
})
export type AssetRef = z.infer<typeof assetRefSchema>

/* ------------------------------------------------------------------ */
/* 溯源                                                                */
/* ------------------------------------------------------------------ */

export const PROVENANCE_SOURCES = ['ace-step', 'ace-lm', 'render', 'import', 'manual'] as const
export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number]

export const provenanceSchema = z.object({
  source: z.enum(PROVENANCE_SOURCES).default('ace-step'),
  /** 例如 acestep-v15-turbo-Q8_0 */
  modelId: z.string().default(''),
  /** 上游 checkpoint 名，便于复现 */
  checkpoint: z.string().optional(),
  /** 使用的 LoRA / LoKR 适配器 id（可多个叠加） */
  adapterIds: z.array(z.string()).default([]),
  seed: z.number().optional(),
  /** 逐字提示词（不做改写，保证可复现） */
  prompt: z.string().optional(),
  /** 其余生成参数：steps / shift / guidance / coverStrength / lego / repaint 区间等 */
  params: z.record(z.string(), z.unknown()).default({}),
  /** 输入资产（cover/repaint/lego 的 src_audio） */
  sourceAssetIds: z.array(z.string()).default([]),
  license: z.string().optional(),
  licenseSnapshotAt: z.number().optional(),
  deviceId: z.string().optional(),
  createdAt: z.number(),
})
export type Provenance = z.infer<typeof provenanceSchema>

/* ------------------------------------------------------------------ */
/* Take（同一片段的多次生成版本）                                       */
/* ------------------------------------------------------------------ */

export const takeSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  label: z.string().default(''),
  provenance: provenanceSchema,
  favorite: z.boolean().default(false),
  createdAt: z.number(),
})
export type Take = z.infer<typeof takeSchema>

/* ------------------------------------------------------------------ */
/* 音频片段                                                            */
/* ------------------------------------------------------------------ */

export const audioClipSchema = z.object({
  id: z.string(),
  trackId: z.string(),
  name: z.string().default('音频片段'),
  color: z.string().optional(),
  /** 网格位置（绝对拍） */
  startBeat: z.number().min(0),
  /** 在时间轴上占用的长度（拍） */
  lengthBeats: z.number().min(0.25),
  /** 当前生效资产 */
  assetId: z.string(),
  /** 从音频文件第几秒开始截取 */
  offsetSec: z.number().min(0).default(0),
  /** 有效音频时长（秒），用于计算边界与淡入淡出 */
  durationSec: z.number().min(0),
  gainDb: z.number().min(-60).max(24).default(0),
  fadeInBeats: z.number().min(0).default(0),
  fadeOutBeats: z.number().min(0).default(0),
  /**
   * 变速比：工程 BPM 与音频原始 BPM 不一致时用于对齐。
   * 1 = 不变速。注意 WebAudio 的 playbackRate 变速会变调，
   * 保音高需 WASM/原生 phase vocoder（一期不启用）。
   */
  stretchRatio: z.number().min(0.5).max(2).default(1),
  muted: z.boolean().default(false),
  /** 生成参数溯源（当前生效 take 的副本，便于列表直读） */
  provenance: provenanceSchema.optional(),
  /** 备选版本；切换 activeTakeId 即换版本 */
  takes: z.array(takeSchema).default([]),
  activeTakeId: z.string().optional(),
})
export type AudioClip = z.infer<typeof audioClipSchema>

/* ------------------------------------------------------------------ */
/* 节拍锚点 / 分析结果                                                  */
/* ------------------------------------------------------------------ */

export const beatAnchorSchema = z.object({
  /** 第几拍（工程网格） */
  beat: z.number().min(0),
  /** 对应音频秒数 */
  sec: z.number().min(0),
})
export type BeatAnchor = z.infer<typeof beatAnchorSchema>

export const ANALYSIS_SOURCES = ['beat_this', 'btc', 'librosa', 'acestep-understand', 'manual'] as const
export type AnalysisSource = (typeof ANALYSIS_SOURCES)[number]

export const analysisChordSchema = z.object({
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  /** 展示用符号，如 "Dm7" */
  symbol: z.string(),
  confidence: z.number().min(0).max(1).default(0.5),
})

export const analysisRecordSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  bpm: z.number().min(0).optional(),
  key: z.string().optional(),
  scale: z.string().optional(),
  timeSignature: z.string().optional(),
  /** BPM 漂移时用于把音频秒映射回工程拍 */
  beatAnchors: z.array(beatAnchorSchema).default([]),
  chords: z.array(analysisChordSchema).default([]),
  source: z.enum(ANALYSIS_SOURCES),
  /** 置信度与是否被用户确认过（人工确认后 AI 不再覆盖） */
  confidence: z.number().min(0).max(1).default(0.5),
  confirmed: z.boolean().default(false),
  createdAt: z.number(),
})
export type AnalysisRecord = z.infer<typeof analysisRecordSchema>

/* ------------------------------------------------------------------ */
/* 辅助函数（纯函数，无副作用）                                          */
/* ------------------------------------------------------------------ */

/** 音频片段在时间轴上的结束拍 */
export function audioClipEndBeat(clip: AudioClip): number {
  return clip.startBeat + clip.lengthBeats
}

/**
 * 把音频秒数换算成拍数（用于对齐 / 波形绘制 / 淡变时长）。
 * stretchRatio 改变播放速率，因此"实际占用的拍"要乘以它。
 */
export function audioSecToBeats(sec: number, tempo: number, stretchRatio = 1): number {
  return (sec / 60) * tempo * stretchRatio
}

/** 拍数换算回音频秒数 */
export function beatsToAudioSec(beats: number, tempo: number, stretchRatio = 1): number {
  return (beats / tempo) * 60 / (stretchRatio || 1)
}
