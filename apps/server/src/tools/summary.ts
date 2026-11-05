/** 工程概览工具函数：既用于 get_project_summary 工具，也用于 Agent 系统提示词。 */
import {
  CHORDS,
  NOTE_NAMES_SHARP,
  beatsPerBar,
  projectEndBar,
  projectEndBeat,
  type Clip,
  type Project,
  type Track,
} from '@aiab/core'
import { getInstrument } from '@aiab/core'

const SCALE_NAMES: Record<string, string> = {
  major: '大调',
  minor: '自然小调',
  harmonicMinor: '和声小调',
  melodicMinor: '旋律小调',
  dorian: '多利亚',
  phrygian: '弗里几亚',
  lydian: '利底亚',
  mixolydian: '混合利底亚',
  locrian: '洛克里亚',
  pentatonicMajor: '大调五声',
  pentatonicMinor: '小调五声',
  blues: '布鲁斯',
  chromatic: '半音阶',
}

export function scaleLabel(scale: string): string {
  return SCALE_NAMES[scale] ?? scale
}

export function chordSymbol(chord: { root: number; quality: string }): string {
  const quality = (CHORDS as Record<string, { symbol?: string } | undefined>)[chord.quality]
  return `${NOTE_NAMES_SHARP[((chord.root % 12) + 12) % 12] ?? 'C'}${quality?.symbol ?? chord.quality}`
}

export function trackInstrumentLabel(track: Track): string {
  try {
    const instrument = getInstrument(track.instrumentId)
    const emotion = instrument.emotions.find((item) => item.id === track.emotionId)
    return emotion ? `${instrument.name} · ${emotion.name}` : instrument.name
  } catch {
    return track.instrumentId
  }
}

function clipLabel(clip: Clip): string {
  const kind = clip.smart ? `/${clip.smart.kind}` : ''
  return `「${clip.name}」${kind} 起点 ${round(clip.startBeat)} 拍，长 ${round(clip.lengthBeats)} 拍，${clip.notes.length} 个音符`
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

export interface ProjectSummaryData {
  id: string
  name: string
  tempo: number
  timeSignature: string
  key: string
  scale: string
  bars: number
  endBeat: number
  masterVolume: number
  sections: { name: string; startBar: number; bars: number; energy: number }[]
  chords: { beat: number; chord: string }[]
  tracks: {
    id: string
    name: string
    kind: string
    instrument: string
    instrumentId: string
    emotionId: string
    volume: number
    pan: number
    mute: boolean
    solo: boolean
    clips: { id: string; name: string; startBeat: number; lengthBeats: number; noteCount: number; smartKind?: string }[]
  }[]
}

/** 结构化概览（工具 data 字段） */
export function projectSummaryData(project: Project): ProjectSummaryData {
  const barBeats = beatsPerBar(project.timeSignature)
  let beat = 0
  const chords: { beat: number; chord: string }[] = []
  for (const chord of project.chords) {
    chords.push({ beat: round(beat), chord: chordSymbol(chord) })
    beat += chord.beats
  }
  return {
    id: project.id,
    name: project.name,
    tempo: project.tempo,
    timeSignature: `${project.timeSignature.numerator}/${project.timeSignature.denominator}`,
    key: project.key,
    scale: project.scale,
    bars: projectEndBar(project),
    endBeat: round(projectEndBeat(project)),
    masterVolume: project.masterVolume,
    sections: project.sections.map((section) => ({
      name: section.name,
      startBar: section.startBar,
      bars: section.bars,
      energy: section.energy,
    })),
    chords,
    tracks: project.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      kind: track.kind,
      instrument: trackInstrumentLabel(track),
      instrumentId: track.instrumentId,
      emotionId: track.emotionId,
      volume: track.volume,
      pan: track.pan,
      mute: track.mute,
      solo: track.solo,
      clips: track.clips.map((clip) => ({
        id: clip.id,
        name: clip.name,
        startBeat: round(clip.startBeat),
        lengthBeats: round(clip.lengthBeats),
        noteCount: clip.notes.length,
        smartKind: clip.smart?.kind,
      })),
    })),
  }
}

/** 适合塞进系统提示词的紧凑文本概览 */
export function projectSummaryText(project: Project): string {
  const data = projectSummaryData(project)
  const lines: string[] = []
  lines.push(
    `工程「${data.name}」 调性 ${data.key} ${scaleLabel(data.scale)}，${data.tempo} BPM，${data.timeSignature}，约 ${data.bars} 小节，主音量 ${data.masterVolume}。`,
  )
  if (data.sections.length) {
    lines.push(`段落：${data.sections.map((s) => `${s.name}(第${s.startBar + 1}小节×${s.bars})`).join('、')}`)
  }
  if (data.chords.length) {
    const head = data.chords.slice(0, 16).map((c) => `第${Math.floor(c.beat / 4) + 1}小节 ${c.chord}`)
    lines.push(`和弦进行：${head.join('，')}${data.chords.length > 16 ? ` …共 ${data.chords.length} 个` : ''}`)
  } else {
    lines.push('和弦进行：（空，可先用 set_chords 铺和弦）')
  }
  if (data.tracks.length === 0) {
    lines.push('轨道：（无，工程为空）')
  } else {
    lines.push('轨道：')
    for (const track of data.tracks) {
      const clips = track.clips.length
        ? track.clips.map((clip) => `${clip.name}@${clip.startBeat}拍/${clip.noteCount}音`).join('，')
        : '空'
      lines.push(
        `- [${track.id}] ${track.name}｜${track.instrument}｜音量 ${track.volume} 声像 ${track.pan}${track.mute ? '｜静音' : ''}${track.solo ? '｜独奏' : ''}｜片段：${clips}`,
      )
    }
  }
  return lines.join('\n')
}

/** 单个片段的详细信息（write_notes 前参考） */
export function clipNotesSummary(clip: Clip): string {
  if (clip.notes.length === 0) return clipLabel(clip) + '（无音符）'
  const sorted = [...clip.notes].sort((a, b) => a.start - b.start)
  const notes = sorted.slice(0, 64).map((note) => `${NOTE_NAMES_SHARP[note.pitch % 12]}${Math.floor(note.pitch / 12) - 1}@${round(note.start)}/${round(note.duration)}/${note.velocity}`)
  return `${clipLabel(clip)}\n音符：${notes.join(' ')}${sorted.length > 64 ? ` …共 ${sorted.length} 个` : ''}`
}
