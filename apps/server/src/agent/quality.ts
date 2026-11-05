/**
 * 编曲质量自检：对一次 AI 生成后的工程做「可听性/结构完整性」体检。
 *
 * AI 生成最常见的质量问题不是报错，而是**静默地做出有问题的工程**：
 * 片段时间重叠导致音符叠加、留下的空轨道/空片段、重复叠音、音符超出片段长度、
 * 多个同配置轨道、较多音符跑出调外、段落没盖住全曲……
 *
 * 这里把这些检查集中成一个纯函数：
 * - Agent 循环在模型结束时调用（只针对本次新增的问题做一次自动修复）；
 * - 每次 AI 运行的日志里也带一份结果，便于事后抓日志定位质量回退。
 */
import {
  beatsPerBar,
  projectEndBar,
  scalePitches,
  type Project,
  type ScaleId,
  type Track,
} from '@aiab/core'

export type QualitySeverity = 'high' | 'medium' | 'low'

export interface QualityIssue {
  code: string
  severity: QualitySeverity
  message: string
  trackId?: string
  clipId?: string
}

/** 可序列化的质量摘要（写入 AI 运行日志 / GET /api/ai/logs） */
export interface AiRunQuality {
  issueCount: number
  high: number
  medium: number
  low: number
  issues: QualityIssue[]
}

export interface QualityReport extends AiRunQuality {
  /** 高/中优先级问题（值得让模型自动修复的） */
  fixable: QualityIssue[]
  summary: string
}

const SEVERITY_ORDER: Record<QualitySeverity, number> = { high: 0, medium: 1, low: 2 }
const MAX_REPORTED_ISSUES = 12
/** 音符超出片段长度允许的误差（拍） */
const BEAT_EPSILON = 0.05
/** 判定「跑调」的最少音符数与比例阈值 */
const OUT_OF_SCALE_MIN_NOTES = 16
const OUT_OF_SCALE_RATIO = 0.35

function clipEnd(clip: { startBeat: number; lengthBeats: number }): number {
  return clip.startBeat + clip.lengthBeats
}

/** 同一轨道内片段时间重叠（静音片段不参与） */
function checkOverlaps(track: Track, issues: QualityIssue[]): void {
  const clips = [...track.clips].filter((clip) => !clip.muted).sort((a, b) => a.startBeat - b.startBeat)
  for (let index = 1; index < clips.length; index++) {
    const previous = clips[index - 1]
    const current = clips[index]
    if (clipEnd(previous) - current.startBeat > BEAT_EPSILON) {
      issues.push({
        code: 'overlapping_clips',
        severity: 'high',
        trackId: track.id,
        clipId: current.id,
        message: `轨道「${track.name}」的片段「${previous.name}」与「${current.name}」时间重叠，同时播放会叠加音符`,
      })
    }
  }
}

function checkClipContent(track: Track, issues: QualityIssue[]): void {
  for (const clip of track.clips) {
    if (clip.notes.length === 0) {
      issues.push({
        code: 'empty_clip',
        severity: 'low',
        trackId: track.id,
        clipId: clip.id,
        message: `轨道「${track.name}」的片段「${clip.name}」没有任何音符`,
      })
      continue
    }
    const beyond = clip.notes.filter((note) => note.start + note.duration > clip.lengthBeats + BEAT_EPSILON).length
    if (beyond > 0) {
      issues.push({
        code: 'notes_beyond_clip',
        severity: 'high',
        trackId: track.id,
        clipId: clip.id,
        message: `片段「${clip.name}」有 ${beyond} 个音符超出片段长度 ${clip.lengthBeats} 拍，尾部会被截断`,
      })
    }
    const seen = new Set<string>()
    let duplicates = 0
    for (const note of clip.notes) {
      const key = `${note.pitch}:${note.start.toFixed(3)}:${note.duration.toFixed(3)}`
      if (seen.has(key)) duplicates++
      else seen.add(key)
    }
    if (duplicates > 0) {
      issues.push({
        code: 'duplicate_notes',
        severity: 'medium',
        trackId: track.id,
        clipId: clip.id,
        message: `片段「${clip.name}」有 ${duplicates} 个完全重复的音符（同一音高同时发声，会被加倍/发糊）`,
      })
    }
  }
}

function checkDuplicateTracks(project: Project, issues: QualityIssue[]): void {
  const groups = new Map<string, Track[]>()
  for (const track of project.tracks) {
    const key = `${track.instrumentId}||${track.name.trim()}`
    const list = groups.get(key) ?? []
    list.push(track)
    groups.set(key, list)
  }
  for (const [, tracks] of groups) {
    if (tracks.length <= 1) continue
    issues.push({
      code: 'duplicate_tracks',
      severity: 'low',
      trackId: tracks[0].id,
      message: `有 ${tracks.length} 条同名同乐器的重复轨道「${tracks[0].name}」，可考虑合并`,
    })
  }
}

function checkOutOfScale(project: Project, issues: QualityIssue[]): void {
  let scalePitchClasses: Set<number>
  try {
    scalePitchClasses = new Set(scalePitches(project.key, project.scale as ScaleId, 0).map((pitch) => ((pitch % 12) + 12) % 12))
  } catch {
    return
  }
  for (const track of project.tracks) {
    if (track.kind === 'drum') continue
    let total = 0
    let outside = 0
    for (const clip of track.clips) {
      for (const note of clip.notes) {
        total++
        if (!scalePitchClasses.has(((note.pitch % 12) + 12) % 12)) outside++
      }
    }
    if (total >= OUT_OF_SCALE_MIN_NOTES && outside / total >= OUT_OF_SCALE_RATIO) {
      issues.push({
        code: 'out_of_scale',
        severity: 'low',
        trackId: track.id,
        message: `轨道「${track.name}」有 ${Math.round((outside / total) * 100)}% 的音符不在 ${project.key} ${project.scale} 调内，听感可能跑调`,
      })
    }
  }
}

function checkStructure(project: Project, issues: QualityIssue[]): void {
  const endBar = projectEndBar(project)
  if (project.sections.length > 0) {
    const coveredBar = project.sections.reduce((max, section) => Math.max(max, section.startBar + section.bars), 0)
    if (coveredBar < endBar - 1) {
      issues.push({
        code: 'sections_gap',
        severity: 'low',
        message: `段落只覆盖到第 ${coveredBar} 小节，但工程实际有 ${endBar} 小节，后半段缺少段落标记`,
      })
    }
  }
  if (project.chords.length === 0 && project.tracks.length >= 2) {
    issues.push({
      code: 'missing_chords',
      severity: 'low',
      message: '工程有多个声部但没有和弦进行，和声支撑不足',
    })
  }
  const barBeats = beatsPerBar(project.timeSignature)
  for (const track of project.tracks) {
    if (track.clips.length === 0 && track.kind !== 'drum') {
      issues.push({
        code: 'empty_track',
        severity: 'medium',
        trackId: track.id,
        message: `轨道「${track.name}」没有任何片段（空轨道）`,
      })
    } else if (track.clips.length > 0) {
      const totalBeats = track.clips.reduce((sum, clip) => sum + clip.lengthBeats, 0)
      if (totalBeats < barBeats && track.clips.every((clip) => clip.notes.length === 0)) {
        issues.push({
          code: 'empty_track',
          severity: 'medium',
          trackId: track.id,
          message: `轨道「${track.name}」只有空片段，没有实际内容`,
        })
      }
    }
  }
}

/** 工程质量体检（纯函数，不修改工程） */
export function auditProjectQuality(project: Project): QualityReport {
  const issues: QualityIssue[] = []
  for (const track of project.tracks) {
    checkOverlaps(track, issues)
    checkClipContent(track, issues)
  }
  checkDuplicateTracks(project, issues)
  checkOutOfScale(project, issues)
  checkStructure(project, issues)

  const sorted = [...issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  const high = sorted.filter((issue) => issue.severity === 'high').length
  const medium = sorted.filter((issue) => issue.severity === 'medium').length
  const low = sorted.filter((issue) => issue.severity === 'low').length
  const reported = sorted.slice(0, MAX_REPORTED_ISSUES)
  const summary =
    sorted.length === 0
      ? '工程质量自检通过，未发现明显问题。'
      : `工程质量自检发现 ${sorted.length} 个问题（高 ${high} / 中 ${medium} / 低 ${low}）：${reported
          .slice(0, 4)
          .map((issue) => issue.message)
          .join('；')}${sorted.length > 4 ? ' …' : ''}`

  return {
    issueCount: sorted.length,
    high,
    medium,
    low,
    issues: reported,
    fixable: sorted.filter((issue) => issue.severity === 'high' || issue.severity === 'medium'),
    summary,
  }
}

/** 只保留「本次运行新引入」的高/中问题（避免把用户工程里原有的问题也自动改掉） */
export function newQualityIssues(previous: QualityReport, current: QualityReport): QualityIssue[] {
  const seen = new Set(previous.issues.map((issue) => `${issue.code}|${issue.trackId ?? ''}|${issue.clipId ?? ''}`))
  const result: QualityIssue[] = []
  for (const issue of current.fixable) {
    const key = `${issue.code}|${issue.trackId ?? ''}|${issue.clipId ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(issue)
  }
  return result
}

/** 给模型的修复指令（简洁、只描述问题与期望，不教它写代码） */
export function qualityRepairPrompt(issues: QualityIssue[]): string {
  const lines = issues.slice(0, 8).map((issue) => `- ${issue.message}`)
  return [
    '生成结束前的编曲质量自检发现问题，请直接用工具修复（不要只解释）：',
    ...lines,
    '修复原则：时间重叠用 update_clip 移动/缩短或用 delete_clip 删除多余片段（优先保留音符更多的片段）；空轨道/空片段补内容或删除；超长音符改成不超过片段长度；重复音符去重。不要改动与这些问题无关的轨道和片段。',
  ].join('\n')
}
