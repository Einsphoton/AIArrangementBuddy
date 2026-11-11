/**
 * 轨道「创作信息」：只读展示该轨的风格 / 调式 / BPM / 段落 / 乐器 / 智能片段参数。
 *
 * 数据全部来自现有工程字段，不改 schema：
 * - 风格：优先读片段 smart.style 快照（composeProject 生成时写入），否则用工程内出现最多的片段风格，
 *   再否则显示「未标注」（MIDI 导入的工程没有风格元数据）；
 * - 调式：智能片段快照优先，其次工程 key/scale；
 * - 段落：该轨第一个片段起点所在的工程段落；
 * - 智能片段参数：片段 smart.params 摘要。
 */
import { SMART_KIND_META, STYLES, beatsPerBar, getInstrument, getScene } from '@aiab/core'
import type { Project, ScaleId, SmartKind, SmartParams, StyleId, Track } from '@aiab/core'
import { Popover } from '../../components/ui/menu'
import { keyScaleLabel, resolveProjectStyle, styleLabel } from '../../lib/studioMeta'

export interface TrackCreativeSmartInfo {
  kind: SmartKind
  kindName: string
  icon: string
  params: SmartParams
  bars: number
  seedHex: string
  key: string
  scale: ScaleId
  followChords: boolean
  progressionLength: number
}

export interface TrackCreativeInfo {
  styleName: string | null
  /** 用途场景中文名（project.scene → core SCENES），未指定为 null */
  sceneLabel: string | null
  keyScale: string
  tempo: number
  timeSignature: string
  /** 「主歌（第 1–8 小节）」，未划分段落时为 null */
  sectionLabel: string | null
  instrumentIcon: string
  instrumentName: string
  emotionName: string
  smart: TrackCreativeSmartInfo | null
  /** 轨道头第三行的一行摘要 */
  inlineSummary: string
  /** 悬停/无障碍用的完整摘要 */
  detailTitle: string
}

const pct = (value: number): string => `${Math.round(value * 100)}%`

function seedHex(seed: number): string {
  return (seed >>> 0).toString(16).toUpperCase().padStart(8, '0')
}

export function buildTrackCreativeInfo(project: Project, track: Track): TrackCreativeInfo {
  const clips = [...track.clips].sort((a, b) => a.startBeat - b.startBeat)
  const smartClip = clips.find((clip) => Boolean(clip.smart)) ?? null
  const smart = smartClip?.smart ?? null

  /* 风格优先级：工程主风格（向导落盘）→ 该轨智能片段快照 → 全工程片段推断 → 未标注 */
  const declaredStyle: StyleId | null =
    typeof project.style === 'string' && project.style in STYLES ? (project.style as StyleId) : null
  const smartStyle: StyleId | null =
    smart && typeof smart.style === 'string' && smart.style in STYLES ? (smart.style as StyleId) : null
  const styleId: StyleId | null = declaredStyle ?? smartStyle ?? resolveProjectStyle(project)
  const styleName = styleLabel(styleId)

  /* 用途场景：project.scene → core SCENES 里的中文名；未知 id 原样显示 */
  const scenePreset = typeof project.scene === 'string' && project.scene ? getScene(project.scene) : undefined
  const sceneLabel = scenePreset?.name ?? (project.scene ? project.scene : null)

  const key = smart?.key ?? project.key
  const scale: ScaleId = smart?.scale ?? project.scale
  const barBeats = beatsPerBar(project.timeSignature)
  const firstClip = clips[0] ?? null
  const startBar = firstClip ? firstClip.startBeat / barBeats : 0
  const section =
    project.sections.find((item) => startBar >= item.startBar && startBar < item.startBar + item.bars) ??
    (firstClip ? null : (project.sections[0] ?? null))
  const sectionLabel = section
    ? `${section.name}（第 ${section.startBar + 1}–${section.startBar + section.bars} 小节）`
    : null

  const instrument = getInstrument(track.instrumentId)
  const emotion = instrument.emotions.find((item) => item.id === track.emotionId) ?? instrument.emotions[0]

  const smartInfo: TrackCreativeSmartInfo | null = smart
    ? {
        kind: smart.kind,
        kindName: SMART_KIND_META[smart.kind].name,
        icon: SMART_KIND_META[smart.kind].icon,
        params: smart.params,
        bars: Math.max(1, Math.round((smartClip?.lengthBeats ?? 0) / barBeats)) || smart.params.bars,
        seedHex: seedHex(smart.seed),
        key: smart.key ?? project.key,
        scale: smart.scale ?? project.scale,
        followChords: smart.params.followChords,
        progressionLength: smart.progression?.length ?? 0,
      }
    : null

  const inlineSummary = [
    styleName ?? '风格未标注',
    sceneLabel,
    keyScaleLabel(key, scale),
    `${project.tempo} BPM`,
    section?.name ?? null,
  ]
    .filter(Boolean)
    .join(' · ')

  const smartSummary = smartInfo
    ? `｜智能片段：${smartInfo.kindName} ${smartInfo.bars} 小节 · 密度 ${pct(smartInfo.params.density)} · 复杂度 ${pct(
        smartInfo.params.complexity,
      )} · 能量 ${pct(smartInfo.params.energy)} · 跟随和弦 ${smartInfo.followChords ? '开' : '关'}`
    : '｜智能片段：无'
  const detailTitle = `风格：${styleName ?? '未标注'}｜用途：${sceneLabel ?? '未指定'}｜调式：${keyScaleLabel(
    key,
    scale,
  )}｜速度：${project.tempo} BPM｜段落：${sectionLabel ?? '未划分段落'}｜乐器：${instrument.name} · ${
    emotion.name
  }${smartSummary}`

  return {
    styleName,
    sceneLabel,
    keyScale: keyScaleLabel(key, scale),
    tempo: project.tempo,
    timeSignature: `${project.timeSignature.numerator}/${project.timeSignature.denominator}`,
    sectionLabel,
    instrumentIcon: instrument.icon,
    instrumentName: instrument.name,
    emotionName: emotion.name,
    smart: smartInfo,
    inlineSummary,
    detailTitle,
  }
}

/** 轨道头「创作信息」只读弹层 */
export function TrackCreativeInfoPopover({
  anchor,
  project,
  track,
  onClose,
}: {
  anchor: DOMRect | { left: number; right: number; top: number; bottom: number }
  project: Project
  track: Track
  onClose: () => void
}) {
  const info = buildTrackCreativeInfo(project, track)
  return (
    <Popover anchor={anchor} onClose={onClose} width={280} estimatedHeight={380} align="end" label="创作信息">
      <div className="p-2.5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="label">创作信息</span>
          <span className="shrink-0 text-[9.5px] text-ink-4">只读 · 来自工程数据</span>
        </div>

        <div className="space-y-1">
          <InfoRow label="风格" value={info.styleName ?? '未标注'} />
          <InfoRow label="用途" value={info.sceneLabel ?? '未指定'} />
          <InfoRow label="调式" value={info.keyScale} />
          <InfoRow label="速度" value={`${info.tempo} BPM · ${info.timeSignature}`} />
          <InfoRow label="段落" value={info.sectionLabel ?? '未划分段落'} />
          <InfoRow label="乐器" value={`${info.instrumentIcon} ${info.instrumentName} · ${info.emotionName}`} />
        </div>

        {info.smart ? (
          <div className="mt-2 rounded-lg border border-violet/30 bg-violet/8 px-2 py-1.5">
            <div className="mb-1 flex items-center gap-1">
              <span className="min-w-0 truncate text-[11.5px] font-medium text-violet">
                {info.smart.icon} 智能片段 · {info.smart.kindName}
              </span>
              <span className="mono ml-auto shrink-0 text-[9.5px] text-ink-4">seed {info.smart.seedHex}</span>
            </div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-[3px]">
              <ParamCell label="密度" value={pct(info.smart.params.density)} />
              <ParamCell label="复杂度" value={pct(info.smart.params.complexity)} />
              <ParamCell label="能量" value={pct(info.smart.params.energy)} />
              <ParamCell label="摇摆" value={pct(info.smart.params.swing)} />
              <ParamCell label="人性化" value={pct(info.smart.params.humanize)} />
              <ParamCell label="音符长度" value={pct(info.smart.params.gate)} />
              <ParamCell label="八度" value={`C${info.smart.params.octave}`} />
              <ParamCell label="长度" value={`${info.smart.bars} 小节`} />
            </div>
            <div className="mt-1 flex items-center gap-1 text-[9.5px] text-ink-4">
              <span className="min-w-0 truncate">
                跟随工程和弦：{info.smart.followChords ? '开' : '关（用生成时快照）'}
              </span>
              {info.smart.progressionLength > 0 && (
                <span className="mono ml-auto shrink-0">快照 {info.smart.progressionLength} 个和弦</span>
              )}
            </div>
          </div>
        ) : (
          <p className="mt-2 rounded-lg border border-line bg-surface-2/40 px-2 py-1.5 text-[10px] leading-relaxed text-ink-4">
            该轨没有智能片段参数（普通 MIDI / 音频片段）。
          </p>
        )}

        <p className="mt-2 text-[9.5px] leading-relaxed text-ink-4">
          风格与调式优先读智能片段的生成快照；工程没有记录风格时显示「未标注」。
        </p>
      </div>
    </Popover>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="shrink-0 text-ink-4">{label}</span>
      <span className="min-w-0 truncate text-right text-ink-2" title={value}>
        {value}
      </span>
    </div>
  )
}

function ParamCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-1 text-[10px]">
      <span className="shrink-0 text-ink-4">{label}</span>
      <span className="mono shrink-0 text-ink-2">{value}</span>
    </div>
  )
}