/** 工程编辑类工具（CONTRACTS §6）。所有修改都在 deepClone 的快照上完成。 */
import {
  FAMILY_COLORS,
  KEYS,
  SCALES,
  SMART_KINDS,
  STYLE_PROGRESSIONS,
  beatsPerBar,
  createChord,
  createClip,
  createNote,
  createSection,
  createTrack,
  deepClone,
  defaultSmartParams,
  generateSmartClip,
  getInstrument,
  hasInstrument,
  newId,
  progressionToChords,
  type ChordQualityId,
  type ChordSpec,
  type Clip,
  type InstrumentFamily,
  type NoteEvent,
  type Project,
  type SmartKind,
  type Section,
  type StyleId,
  type Track,
} from '@aiab/core'
import { chordSymbol, projectSummaryData, projectSummaryText, trackInstrumentLabel } from './summary.js'
import { profileForStyle } from '../style/profileStore.js'
import {
  arr,
  bool,
  enm,
  int,
  num,
  obj,
  str,
  toolSchema,
  TRACK_ID,
  type ToolDef,
  type ToolContext,
  type ToolResult,
} from './schema.js'
import {
  KEY_VALUES,
  QUALITY_IDS,
  SCALE_IDS,
  normalizeKey,
  normalizePitch,
  normalizeQuality,
  normalizeRoot,
  normalizeScale,
  parseChordString,
  resolveEmotionWithFallback,
  unknownEmotionMessage,
  unknownInstrumentMessage,
} from './validate.js'

const STYLES: StyleId[] = ['classical', 'rock', 'electronic', 'jazz', 'cinematic', 'pop', 'folk']

/* ---------------------------- 内部工具函数 ---------------------------- */

function ok(message: string, data?: unknown): ToolResult {
  return { ok: true, message, data }
}

function fail(message: string, data?: unknown): ToolResult {
  return { ok: false, message, data }
}

function withProject(result: ToolResult, project: Project): ToolResult {
  project.updatedAt = Date.now()
  return { ...result, project }
}

function clone(project: Project): Project {
  return deepClone(project)
}

function findTrack(project: Project, trackId: unknown): Track | undefined {
  if (typeof trackId !== 'string') return undefined
  return project.tracks.find((track) => track.id === trackId)
}

function findClip(
  project: Project,
  clipId: unknown,
  trackId?: unknown,
): { track: Track; clip: Clip } | undefined {
  if (typeof clipId !== 'string') return undefined
  const tracks = typeof trackId === 'string' ? project.tracks.filter((t) => t.id === trackId) : project.tracks
  for (const track of tracks) {
    const clip = track.clips.find((item) => item.id === clipId)
    if (clip) return { track, clip }
  }
  return undefined
}

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(min, Math.min(max, value))
}

function readNumber(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  return clampNumber(args[key], min, max)
}

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function noteFrom(raw: unknown): NoteEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const pitch = normalizePitch(source.pitch)
  if (pitch === null) return null
  const start = clampNumber(source.start, 0, 4096) ?? 0
  const duration = clampNumber(source.duration, 1 / 64, 256) ?? 1
  const velocity = clampNumber(source.velocity, 1, 127) ?? 90
  const id = typeof source.id === 'string' && source.id ? source.id : undefined
  return createNote(pitch, start, duration, Math.round(velocity), id)
}

function parseNoteList(value: unknown): NoteEvent[] {
  if (!Array.isArray(value)) return []
  const notes: NoteEvent[] = []
  for (const item of value) {
    const note = noteFrom(item)
    if (note) notes.push(note)
  }
  return notes
}

/** 保证片段能覆盖所有音符 */
function fitClipLength(clip: Clip, barBeats: number): void {
  const end = clip.notes.reduce((max, note) => Math.max(max, note.start + note.duration), 0)
  if (end <= clip.lengthBeats) return
  clip.lengthBeats = Math.max(barBeats, Math.ceil(end / barBeats) * barBeats)
}

function rangesOverlap(a: Clip, b: Clip): boolean {
  return a.startBeat < b.startBeat + b.lengthBeats - 1e-6 && b.startBeat < a.startBeat + a.lengthBeats - 1e-6
}

/** 同轨道片段时间重叠提示（不裁剪，只提醒模型/用户，避免播放叠加却不自知） */
function overlapWarning(track: Track, clip: Clip): string {
  const overlaps = track.clips.filter((other) => other.id !== clip.id && rangesOverlap(clip, other))
  if (overlaps.length === 0) return ''
  const names = overlaps.slice(0, 2).map((other) => `「${other.name}」`).join('、')
  return `\n注意：与片段${names}时间重叠，播放会叠加`
}

function resolveEmotion(instrumentId: string, emotionId: unknown): string {
  const instrument = getInstrument(instrumentId)
  if (typeof emotionId !== 'string' || !emotionId.trim()) {
    return instrument.emotions[0]?.id ?? 'default'
  }
  const resolution = resolveEmotionWithFallback(instrumentId, emotionId)
  return resolution?.emotionId ?? instrument.emotions[0]?.id ?? 'default'
}

function trackColorFor(instrumentId: string): string {
  try {
    const instrument = getInstrument(instrumentId)
    return FAMILY_COLORS[instrument.family] ?? instrument.emotions[0]?.color ?? '#7f9cf5'
  } catch {
    return '#7f9cf5'
  }
}

function defaultInstrumentForKind(kind: SmartKind, style: StyleId): string {
  const map: Record<SmartKind, string> = {
    drums: style === 'electronic' ? 'drums.electronic' : style === 'jazz' ? 'drums.jazz' : 'drums.acoustic',
    bass: style === 'electronic' ? 'synth.bass' : 'guitar.bass',
    chords: style === 'jazz' ? 'piano.electric' : 'piano.grand',
    arp: 'synth.pluck',
    melody: style === 'classical' || style === 'cinematic' ? 'woodwinds.flute' : 'synth.lead',
    riff: 'guitar.electric',
    strum: 'guitar.acoustic',
    counter: 'strings.cello',
    pad: style === 'classical' || style === 'cinematic' ? 'strings.ensemble' : 'synth.pad',
  }
  const candidate = map[kind] ?? 'piano.grand'
  return hasInstrument(candidate) ? candidate : 'piano.grand'
}

function toChordSpec(raw: unknown): ChordSpec | null {
  if (typeof raw === 'string') {
    const parsed = parseChordString(raw)
    if (!parsed) return null
    return createChord(parsed.root, parsed.quality, 4)
  }
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const root = normalizeRoot(source.root)
  if (root === null) return null
  let quality: ChordQualityId = 'maj'
  if (source.quality !== undefined && source.quality !== null && source.quality !== '') {
    const parsed = normalizeQuality(source.quality)
    if (!parsed) return null
    quality = parsed
  }
  const beats = clampNumber(source.beats, 0.25, 32) ?? 4
  return createChord(root, quality, beats)
}

function parseChords(value: unknown): ChordSpec[] {
  if (!Array.isArray(value)) return []
  const chords: ChordSpec[] = []
  for (const item of value) {
    const chord = toChordSpec(item)
    if (chord) chords.push(chord)
  }
  return chords
}

function resolveStyle(args: Record<string, unknown>, fallback: StyleId = 'pop'): StyleId {
  const value = readString(args, 'style')
  return value && (STYLES as string[]).includes(value) ? (value as StyleId) : fallback
}

function trackName(track: Track): string {
  return `${track.name}（${trackInstrumentLabel(track)}）`
}

/* ------------------------------ 概览 / 分析 ------------------------------ */

export const getProjectSummary: ToolDef = {
  name: 'get_project_summary',
  title: '读取工程概览',
  readOnly: true,
  description:
    '获取当前工程的完整概览：速度、调性、段落、和弦进行、每条轨道（id / 乐器 / 情绪 / 音量 / 声像 / 片段 / 音符数）。修改工程前建议先调用。',
  parameters: toolSchema({}),
  async handler(_args, ctx) {
    return ok(projectSummaryText(ctx.project), projectSummaryData(ctx.project))
  },
}

export const analyzeHarmony: ToolDef = {
  name: 'analyze_harmony',
  title: '分析和声与编排',
  readOnly: true,
  description:
    '分析调性、和弦进行、节奏密度与声部配置，给出可执行的编曲建议（不修改工程）。适合在「优化当前编排」前调用。',
  parameters: toolSchema({}),
  async handler(_args, ctx) {
    const project = ctx.project
    const barBeats = beatsPerBar(project.timeSignature)
    const data = projectSummaryData(project)
    let totalNotes = 0
    const perBar = new Map<number, number>()
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        for (const note of clip.notes) {
          totalNotes++
          const bar = Math.floor((clip.startBeat + note.start) / barBeats)
          perBar.set(bar, (perBar.get(bar) ?? 0) + 1)
        }
      }
    }
    const bars = Math.max(1, data.bars)
    const avgPerBar = totalNotes / bars
    const densityVerdict = avgPerBar < 6 ? '偏稀疏' : avgPerBar > 40 ? '过于密集' : '适中'
    const hasBass = project.tracks.some((track) => track.name.includes('低音') || /bass/i.test(track.instrumentId))
    const hasDrums = project.tracks.some((track) => track.kind === 'drum')
    const melodyTracks = project.tracks.filter((track) => track.name.includes('旋律') || /lead|melody/i.test(track.name))

    const suggestions: string[] = []
    if (project.chords.length === 0) suggestions.push('工程还没有和弦进行，可先用 set_chords 铺一段进行，或直接用 arrange_from_melody 生成伴奏。')
    if (!hasBass) suggestions.push('缺少低音声部，建议增加贝斯轨（跟和弦根音）来稳住低频。')
    if (!hasDrums) suggestions.push('没有鼓组轨道，可加一条鼓组提供律动。')
    if (melodyTracks.length === 0 && project.tracks.length > 0) suggestions.push('没有明确的旋律声部，可加主旋律或对位声部提升辨识度。')
    if (avgPerBar < 6) suggestions.push(`音符密度${densityVerdict}（每小节约 ${avgPerBar.toFixed(1)} 个音），可提高智能片段的 density/energy。`)
    if (avgPerBar > 40) suggestions.push(`音符密度${densityVerdict}（每小节约 ${avgPerBar.toFixed(1)} 个音），建议减少铺底声部或简化节奏。`)
    const tedious = project.tracks.filter((track) => track.clips.length <= 1 && data.bars > 8)
    if (tedious.length) suggestions.push(`${tedious.length} 条轨道只有一个片段且曲子较长，可复制/变奏片段让循环更耐听。`)
    // 质量自检：同一条轨道里片段重叠会在播放时叠加，让模型能自己发现并修
    const clipOverlaps: { trackId: string; trackName: string; clipA: string; clipB: string }[] = []
    for (const track of project.tracks) {
      const ordered = [...track.clips].sort((a, b) => a.startBeat - b.startBeat)
      for (let index = 1; index < ordered.length; index++) {
        const previous = ordered[index - 1]
        const current = ordered[index]
        if (rangesOverlap(previous, current)) {
          clipOverlaps.push({ trackId: track.id, trackName: track.name, clipA: previous.name, clipB: current.name })
        }
      }
    }
    if (clipOverlaps.length) {
      const sample = clipOverlaps
        .slice(0, 3)
        .map((item) => `${item.trackName}「${item.clipA}」×「${item.clipB}」`)
        .join('、')
      suggestions.unshift(
        `发现 ${clipOverlaps.length} 处轨道内片段时间重叠（${sample}${clipOverlaps.length > 3 ? ' …' : ''}），同时播放会叠加；可用 update_clip 移动/缩短或 delete_clip 删除多余片段。`,
      )
    }
    if (project.sections.length === 0) suggestions.push('没有段落标记，建议用 set_sections 划分主歌/副歌，便于做能量起伏。')
    if (suggestions.length === 0) suggestions.push('整体结构完整，可继续在配器色彩与段落能量上打磨。')

    const chordLine = project.chords.length
      ? project.chords.map((chord, index) => `${index + 1}:${chordSymbol(chord)}`).join(' ')
      : '（无）'
    const message = [
      `调性：${project.key} ${project.scale}；速度 ${project.tempo} BPM；约 ${data.bars} 小节。`,
      `和弦：${chordLine}`,
      `轨道：${project.tracks.length} 条（${project.tracks.map((track) => track.name).join('、') || '无'}）`,
      `音符密度：${densityVerdict}（平均每小节 ${avgPerBar.toFixed(1)} 个音，总计 ${totalNotes} 个）`,
      `建议：\n- ${suggestions.join('\n- ')}`,
    ].join('\n')

    return ok(message, {
      key: project.key,
      scale: project.scale,
      tempo: project.tempo,
      bars: data.bars,
      chords: data.chords,
      averageNotesPerBar: Math.round(avgPerBar * 10) / 10,
      totalNotes,
      densityVerdict,
      hasBass,
      hasDrums,
      clipOverlaps,
      suggestions,
    })
  },
}

/* --------------------------------- 轨道 --------------------------------- */

export const createTrackTool: ToolDef = {
  name: 'create_track',
  title: '新建轨道',
  description: '新建一条乐器轨道（可同时指定乐器与情绪预设），返回新轨道 id。乐器 id 可通过 music_theory 的 instrument 查询或参考系统提示词。',
  parameters: toolSchema(
    {
      instrumentId: str('乐器 id，例如 piano.grand / guitar.bass / drums.acoustic / synth.pad / strings.ensemble'),
      name: str('轨道名称（中文，如「贝斯」「弦乐铺底」）'),
      emotionId: str('情绪预设 id（可选，缺省用乐器第一个预设）'),
      volume: num('音量 0..1.5', { minimum: 0, maximum: 1.5 }),
      pan: num('声像 -1..1', { minimum: -1, maximum: 1 }),
      volumeValue: num('兼容字段，等同 volume', { minimum: 0, maximum: 1.5 }),
    },
    ['instrumentId'],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return fail('设置中已禁用工程修改（allowProjectEdits=false）')
    const instrumentId = readString(args, 'instrumentId')
    if (!instrumentId) return fail('请提供 instrumentId（可用 music_theory query=list_instruments 查询）')
    if (!hasInstrument(instrumentId)) return fail(unknownInstrumentMessage(instrumentId))
    const instrument = getInstrument(instrumentId)
    const emotionInput = readString(args, 'emotionId')
    // 情绪兜底：精确 → 同义词 → 包含 → 编辑距离；不精确时 message 明确说明，不静默
    const resolution = resolveEmotionWithFallback(instrumentId, emotionInput)
    if (!resolution) return fail(unknownEmotionMessage(instrumentId, emotionInput))
    const emotionId = resolution.emotionId
    const project = clone(ctx.project)
    const track = createTrack({
      instrumentId,
      emotionId,
      name: readString(args, 'name') ?? instrument.name,
      color: trackColorFor(instrumentId),
      kind: instrument.isDrumKit ? 'drum' : 'instrument',
      gmProgram: instrument.gmProgram,
      volume: readNumber(args, 'volume', 0, 1.5) ?? readNumber(args, 'volumeValue', 0, 1.5) ?? 0.8,
      pan: readNumber(args, 'pan', -1, 1) ?? 0,
    })
    project.tracks.push(track)
    const emotionNote = resolution.note ? `\n${resolution.note}` : ''
    return withProject(
      ok(`已新建轨道「${track.name}」（${instrument.name}），id=${track.id}${emotionNote}`, { trackId: track.id, track, emotionId }),
      project,
    )
  },
}

export const updateTrackTool: ToolDef = {
  name: 'update_track',
  title: '修改轨道',
  description: '修改轨道属性：名称、音量、声像、静音、独奏、混响/延迟发送、八度偏移、情绪预设、乐器。',
  parameters: toolSchema(
    {
      trackId: TRACK_ID,
      name: str('新名称'),
      volume: num('音量 0..1.5', { minimum: 0, maximum: 1.5 }),
      pan: num('声像 -1..1', { minimum: -1, maximum: 1 }),
      mute: bool('是否静音'),
      solo: bool('是否独奏'),
      reverbSend: num('混响发送 0..1', { minimum: 0, maximum: 1 }),
      delaySend: num('延迟发送 0..1', { minimum: 0, maximum: 1 }),
      octaveShift: num('八度偏移 -3..3', { minimum: -3, maximum: 3 }),
      emotionId: str('情绪预设 id'),
      instrumentId: str('乐器 id（相当于 set_instrument）'),
    },
    ['trackId'],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return fail('设置中已禁用工程修改（allowProjectEdits=false）')
    const project = clone(ctx.project)
    const track = findTrack(project, args.trackId)
    if (!track) return fail(`找不到轨道：${String(args.trackId)}`)
    const changes: string[] = []

    // 乐器 / 情绪先校验（语义错误必须 ok:false，不能静默忽略或回退到钢琴）
    const rawInstrument = readString(args, 'instrumentId')
    if (rawInstrument && !hasInstrument(rawInstrument)) return fail(unknownInstrumentMessage(rawInstrument))
    const targetInstrumentId = rawInstrument ?? track.instrumentId
    const rawEmotion = readString(args, 'emotionId')
    let nextEmotionId: string | undefined
    let emotionNote = ''
    if (rawEmotion) {
      // 情绪兜底：不精确时使用最接近的可用情绪，并在 message 里说明（不静默）
      const resolution = resolveEmotionWithFallback(targetInstrumentId, rawEmotion)
      if (!resolution) return fail(unknownEmotionMessage(targetInstrumentId, rawEmotion))
      nextEmotionId = resolution.emotionId
      emotionNote = resolution.note ?? ''
    }

    const name = readString(args, 'name')
    if (name) {
      track.name = name
      changes.push(`名称「${name}」`)
    }
    const volume = readNumber(args, 'volume', 0, 1.5)
    if (volume !== undefined) {
      track.volume = volume
      changes.push(`音量 ${volume}`)
    }
    const pan = readNumber(args, 'pan', -1, 1)
    if (pan !== undefined) {
      track.pan = pan
      changes.push(`声像 ${pan}`)
    }
    if (typeof args.mute === 'boolean') {
      track.mute = args.mute
      changes.push(args.mute ? '静音' : '取消静音')
    }
    if (typeof args.solo === 'boolean') {
      track.solo = args.solo
      changes.push(args.solo ? '独奏' : '取消独奏')
    }
    const reverb = readNumber(args, 'reverbSend', 0, 1)
    if (reverb !== undefined) {
      track.reverbSend = reverb
      changes.push(`混响发送 ${reverb}`)
    }
    const delay = readNumber(args, 'delaySend', 0, 1)
    if (delay !== undefined) {
      track.delaySend = delay
      changes.push(`延迟发送 ${delay}`)
    }
    const octave = readNumber(args, 'octaveShift', -3, 3)
    if (octave !== undefined) {
      track.octaveShift = Math.round(octave)
      changes.push(`八度偏移 ${track.octaveShift}`)
    }
    if (rawInstrument) {
      const instrument = getInstrument(rawInstrument)
      track.instrumentId = rawInstrument
      track.gmProgram = instrument.gmProgram
      track.kind = instrument.isDrumKit ? 'drum' : 'instrument'
      track.color = trackColorFor(rawInstrument)
      changes.push(`乐器 ${instrument.name}`)
    }
    if (nextEmotionId) {
      track.emotionId = nextEmotionId
      const emotion = getInstrument(track.instrumentId).emotions.find((item) => item.id === nextEmotionId)
      changes.push(`情绪 ${emotion?.name ?? nextEmotionId}`)
    } else if (rawInstrument) {
      track.emotionId = getInstrument(rawInstrument).emotions[0].id
    }
    if (changes.length === 0) {
      return fail(
        '没有可应用的修改：请至少提供一个字段（name / volume / pan / mute / solo / reverbSend / delaySend / octaveShift / emotionId / instrumentId）',
      )
    }
    const noteSuffix = emotionNote ? `\n${emotionNote}` : ''
    return withProject(
      ok(`已更新轨道「${track.name}」：${changes.join('、')}${noteSuffix}`, { trackId: track.id, changes, emotionId: nextEmotionId }),
      project,
    )
  },
}

export const setInstrumentTool: ToolDef = {
  name: 'set_instrument',
  title: '更换乐器与情绪',
  description: '把某条轨道换成另一个乐器，并可选设置情绪预设（如弦乐 pizzicato、合成器 dark）。会同步 GM 音色号。',
  parameters: toolSchema(
    {
      trackId: TRACK_ID,
      instrumentId: str('新乐器 id'),
      emotionId: str('情绪预设 id（可选，缺省保留/用默认）'),
    },
    ['trackId', 'instrumentId'],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return fail('设置中已禁用工程修改（allowProjectEdits=false）')
    const project = clone(ctx.project)
    const track = findTrack(project, args.trackId)
    if (!track) return fail(`找不到轨道：${String(args.trackId)}`)
    const instrumentId = readString(args, 'instrumentId')
    if (!instrumentId) return fail('请提供 instrumentId（可用 music_theory query=list_instruments 查询完整列表）')
    if (!hasInstrument(instrumentId)) return fail(unknownInstrumentMessage(instrumentId))
    const instrument = getInstrument(instrumentId)
    const emotionInput = readString(args, 'emotionId')
    const resolution = resolveEmotionWithFallback(instrumentId, emotionInput)
    if (!resolution) return fail(unknownEmotionMessage(instrumentId, emotionInput))
    const emotionId = resolution.emotionId
    track.instrumentId = instrumentId
    track.gmProgram = instrument.gmProgram
    track.kind = instrument.isDrumKit ? 'drum' : 'instrument'
    track.color = trackColorFor(instrumentId)
    track.emotionId = emotionId
    const emotion = instrument.emotions.find((item) => item.id === emotionId)
    const emotionNote = resolution.note ? `\n${resolution.note}` : ''
    return withProject(
      ok(`轨道「${track.name}」已换成 ${instrument.name}${emotion ? ` · ${emotion.name}` : ''}${emotionNote}`, {
        trackId: track.id,
        instrumentId,
        emotionId: track.emotionId,
      }),
      project,
    )
  },
}

export const deleteTrackTool: ToolDef = {
  name: 'delete_track',
  title: '删除轨道',
  description: '删除一条轨道及其所有片段。',
  parameters: toolSchema({ trackId: TRACK_ID }, ['trackId']),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return fail('设置中已禁用工程修改（allowProjectEdits=false）')
    const project = clone(ctx.project)
    const index = project.tracks.findIndex((track) => track.id === args.trackId)
    if (index === -1) return fail(`找不到轨道：${String(args.trackId)}`)
    const [removed] = project.tracks.splice(index, 1)
    return withProject(ok(`已删除轨道「${removed.name}」`, { trackId: removed.id }), project)
  },
}

/* --------------------------------- 片段 --------------------------------- */

export const createClipTool: ToolDef = {
  name: 'create_clip',
  title: '新建片段',
  description: '在指定轨道上新建一个空片段（可附带音符）。startBeat 为绝对起点（拍）。',
  parameters: toolSchema(
    {
      trackId: TRACK_ID,
      name: str('片段名称'),
      startBeat: num('绝对起点（拍），默认 0', { minimum: 0 }),
      bars: num('长度（小节）', { minimum: 0.25, maximum: 64 }),
      lengthBeats: num('长度（拍），优先于 bars'),
      notes: arr('音符列表（start 为相对片段的拍）', obj('音符', {
        pitch: int('MIDI 音高 0..127', { minimum: 0, maximum: 127 }),
        start: num('相对起点（拍）', { minimum: 0 }),
        duration: num('时值（拍）', { minimum: 0.015625 }),
        velocity: int('力度 1..127', { minimum: 1, maximum: 127 }),
      }, ['pitch'])),
    },
    ['trackId'],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return fail('设置中已禁用工程修改（allowProjectEdits=false）')
    const project = clone(ctx.project)
    const track = findTrack(project, args.trackId)
    if (!track) return fail(`找不到轨道：${String(args.trackId)}`)
    const barBeats = beatsPerBar(project.timeSignature)
    const startBeat = readNumber(args, 'startBeat', 0, 100000) ?? 0
    const bars = readNumber(args, 'bars', 0.25, 64)
    const lengthBeats = readNumber(args, 'lengthBeats', 0.25, 100000) ?? (bars ? bars * barBeats : barBeats * 2)
    const clip = createClip({
      trackId: track.id,
      name: readString(args, 'name') ?? '片段',
      startBeat,
      lengthBeats,
      notes: parseNoteList(args.notes),
    })
    fitClipLength(clip, barBeats)
    track.clips.push(clip)
    return withProject(
      ok(`已在轨道「${track.name}」创建片段「${clip.name}」（${clip.notes.length} 个音符），id=${clip.id}`, {
        trackId: track.id,
        clipId: clip.id,
      }),
      project,
    )
  },
}

export const updateClipTool: ToolDef = {
  name: 'update_clip',
  title: '修改片段',
  description: '修改片段名称、起点、长度（拍）或静音状态。',
  parameters: toolSchema(
    {
      clipId: str('片段 id'),
      trackId: str('轨道 id（可选，用于加速定位）'),
      name: str('新名称'),
      startBeat: num('新的绝对起点（拍）', { minimum: 0 }),
      bars: num('新的长度（小节）', { minimum: 0.25 }),
      lengthBeats: num('新的长度（拍）'),
      muted: bool('是否静音'),
    },
    ['clipId'],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return fail('设置中已禁用工程修改（allowProjectEdits=false）')
    const project = clone(ctx.project)
    const found = findClip(project, args.clipId, args.trackId)
    if (!found) return fail(`找不到片段：${String(args.clipId)}`)
    const { clip, track } = found
    const changes: string[] = []
    const name = readString(args, 'name')
    if (name) {
      clip.name = name
      changes.push(`名称「${name}」`)
    }
    const startBeat = readNumber(args, 'startBeat', 0, 100000)
    if (startBeat !== undefined) {
      clip.startBeat = startBeat
      changes.push(`起点 ${startBeat} 拍`)
    }
    const barBeats = beatsPerBar(project.timeSignature)
    const bars = readNumber(args, 'bars', 0.25, 64)
    const lengthBeats = readNumber(args, 'lengthBeats', 0.25, 100000)
    if (lengthBeats !== undefined) {
      clip.lengthBeats = lengthBeats
      changes.push(`长度 ${lengthBeats} 拍`)
    } else if (bars !== undefined) {
      clip.lengthBeats = bars * barBeats
      changes.push(`长度 ${bars} 小节`)
    }
    if (typeof args.muted === 'boolean') {
      clip.muted = args.muted
      changes.push(args.muted ? '静音' : '取消静音')
    }
    if (changes.length === 0) return fail('没有提供任何需要修改的字段')
    fitClipLength(clip, barBeats)
    return withProject(ok(`已更新片段「${clip.name}」（${track.name}）：${changes.join('、')}`, { clipId: clip.id }), project)
  },
}

export const deleteClipTool: ToolDef = {
  name: 'delete_clip',
  title: '删除片段',
  description: '删除一个片段。',
  parameters: toolSchema({ clipId: str('片段 id'), trackId: str('轨道 id（可选）') }, ['clipId']),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return fail('设置中已禁用工程修改（allowProjectEdits=false）')
    const project = clone(ctx.project)
    const found = findClip(project, args.clipId, args.trackId)
    if (!found) return fail(`找不到片段：${String(args.clipId)}`)
    const { clip, track } = found
    track.clips = track.clips.filter((item) => item.id !== clip.id)
    return withProject(ok(`已删除片段「${clip.name}」（${track.name}）`, { clipId: clip.id }), project)
  },
}

export const writeNotesTool: ToolDef = {
  name: 'write_notes',
  title: '写入音符',
  description:
    '在片段里写入/修改/删除音符。mode=replace 覆盖全部；add 追加；update 按音符 id 更新；delete 按音符 id 删除。start 为相对片段起点的拍，duration 为拍。',
  parameters: toolSchema(
    {
      trackId: str('轨道 id（可选）'),
      clipId: str('片段 id（不传则使用该轨道第一个片段；轨道无片段会自动新建）'),
      mode: enm('写入模式', ['replace', 'add', 'update', 'delete']),
      notes: arr('音符列表', obj('音符', {
        id: str('音符 id（update/delete 时必填）'),
        pitch: int('MIDI 音高 0..127', { minimum: 0, maximum: 127 }),
        start: num('相对起点（拍）', { minimum: 0 }),
        duration: num('时值（拍）', { minimum: 0.015625 }),
        velocity: int('力度 1..127', { minimum: 1, maximum: 127 }),
      })),
      noteIds: arr('要删除的音符 id 列表（mode=delete 时可用）', str('音符 id')),
    },
    ['mode'],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return fail('设置中已禁用工程修改（allowProjectEdits=false）')
    const project = clone(ctx.project)
    const mode = readString(args, 'mode') ?? 'replace'
    let track = findTrack(project, args.trackId)
    let clip: Clip | undefined
    if (readString(args, 'clipId')) {
      const found = findClip(project, args.clipId, args.trackId)
      if (!found) return fail(`找不到片段：${String(args.clipId)}`)
      track = found.track
      clip = found.clip
    } else {
      if (!track) return fail('请提供 clipId，或提供有效的 trackId')
      clip = track.clips[0]
      if (!clip) {
        clip = createClip({ trackId: track.id, name: '片段', startBeat: 0, lengthBeats: beatsPerBar(project.timeSignature) * 2 })
        track.clips.push(clip)
      }
    }
    const barBeats = beatsPerBar(project.timeSignature)
    const rawNotes = Array.isArray(args.notes) ? args.notes : []
    const incoming = parseNoteList(args.notes)
    const ids = Array.isArray(args.noteIds) ? args.noteIds.filter((id): id is string => typeof id === 'string') : []

    if (mode === 'replace' || mode === 'add') {
      if (!Array.isArray(args.notes)) {
        return fail(`${mode} 模式需要提供 notes 数组（每个音符至少包含 pitch）`)
      }
      if (incoming.length === 0) {
        return fail(
          `notes 提供了 ${rawNotes.length} 项但没有解析出任何有效音符（每个音符至少需要合法 pitch），已保持片段不变（共 ${clip.notes.length} 个音符）`,
        )
      }
      if (incoming.length < rawNotes.length) {
        return fail(
          `notes 中有 ${rawNotes.length - incoming.length} 项无法解析（缺少/非法 pitch），已保持片段不变；请修正后重试`,
        )
      }
    }

    if (mode === 'replace') {
      clip.notes = incoming
    } else if (mode === 'add') {
      clip.notes.push(...incoming)
    } else if (mode === 'update') {
      if (rawNotes.length === 0) return fail('update 模式需要提供 notes 数组（含 id）')
      let updated = 0
      for (const rawNote of rawNotes) {
        if (!rawNote || typeof rawNote !== 'object') continue
        const source = rawNote as Record<string, unknown>
        if (typeof source.id !== 'string') continue
        const target = clip.notes.find((item) => item.id === source.id)
        if (!target) continue
        const pitch = normalizePitch(source.pitch)
        const start = clampNumber(source.start, 0, 4096)
        const duration = clampNumber(source.duration, 1 / 64, 256)
        const velocity = clampNumber(source.velocity, 1, 127)
        if (pitch !== null) target.pitch = pitch
        if (start !== undefined) target.start = start
        if (duration !== undefined) target.duration = duration
        if (velocity !== undefined) target.velocity = Math.round(velocity)
        updated++
      }
      if (updated === 0) return fail('没有匹配到任何音符 id')
    } else if (mode === 'delete') {
      const remove = new Set(ids)
      const before = clip.notes.length
      clip.notes = clip.notes.filter((note) => !remove.has(note.id))
      if (clip.notes.length === before) return fail('没有匹配到任何音符 id')
    } else {
      return fail(`未知 mode：${mode}`)
    }
    fitClipLength(clip, barBeats)

    const label =
      mode === 'replace' ? `覆盖为 ${clip.notes.length} 个音符` : mode === 'add' ? `追加 ${incoming.length} 个音符` : mode === 'update' ? `更新音符` : `删除 ${ids.length} 个音符`
    return withProject(
      ok(`片段「${clip.name}」（${track.name}）${label}，现在共 ${clip.notes.length} 个音符`, {
        clipId: clip.id,
        trackId: track.id,
        noteCount: clip.notes.length,
      }),
      project,
    )
  },
}

export const generateSmartClipTool: ToolDef = {
  name: 'generate_smart_clip',
  title: '生成智能片段',
  description:
    '用内置生成器生成一段音乐片段（节奏/低音/和弦/琶音/旋律/动机/扫弦/对位/铺底），并写入轨道。不传 trackId 会自动新建合适乐器的轨道。生成结果可复现（seed）。',
  parameters: toolSchema(
    {
      kind: enm('生成器类型', SMART_KINDS),
      name: str('片段名称（可选，默认用生成器类型名，如「和弦」）'),
      trackId: str('目标轨道 id（可选）'),
      style: enm('风格', STYLES),
      bars: num('长度（小节）', { minimum: 1, maximum: 32 }),
      startBeat: num('片段起点（拍）', { minimum: 0 }),
      seed: int('随机种子（同 seed 同结果）'),
      density: num('密度 0..1', { minimum: 0, maximum: 1 }),
      complexity: num('复杂度 0..1', { minimum: 0, maximum: 1 }),
      energy: num('能量 0..1', { minimum: 0, maximum: 1 }),
      octave: int('基准八度 -1..7', { minimum: -1, maximum: 7 }),
      swing: num('摇摆 0..1', { minimum: 0, maximum: 1 }),
      humanize: num('人性化 0..1', { minimum: 0, maximum: 1 }),
      gate: num('音符长度比例 0.1..1.5', { minimum: 0.1, maximum: 1.5 }),
      patternId: str('指定图案 id（可选）'),
      replaceClipId: str('替换已有片段 id（可选）'),
    },
    ['kind'],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return fail('设置中已禁用工程修改（allowProjectEdits=false）')
    const project = clone(ctx.project)
    const kindRaw = readString(args, 'kind') ?? ''
    if (!(SMART_KINDS as readonly string[]).includes(kindRaw)) {
      return fail(`未知生成器类型：${kindRaw}，可选 ${SMART_KINDS.join(' / ')}`)
    }
    const kind = kindRaw as SmartKind
    const clipName = readString(args, 'name')
    const style = resolveStyle(args)
    const barBeats = beatsPerBar(project.timeSignature)
    const bars = readNumber(args, 'bars', 1, 32) ?? 4
    const params = defaultSmartParams({
      bars,
      density: readNumber(args, 'density', 0, 1) ?? 0.55,
      complexity: readNumber(args, 'complexity', 0, 1) ?? 0.5,
      energy: readNumber(args, 'energy', 0, 1) ?? 0.62,
      octave: readNumber(args, 'octave', -1, 7) ?? 4,
      swing: readNumber(args, 'swing', 0, 1) ?? (style === 'jazz' ? 0.35 : 0),
      humanize: readNumber(args, 'humanize', 0, 1) ?? 0.22,
      gate: readNumber(args, 'gate', 0.1, 1.5) ?? 0.85,
      patternId: readString(args, 'patternId'),
    })
    const seed = Math.floor(readNumber(args, 'seed', 0, 2 ** 31) ?? Math.floor(Math.random() * 100000))
    const chords = project.chords
    const notes = generateSmartClip({
      kind,
      style,
      key: project.key,
      scale: project.scale,
      tempo: project.tempo,
      timeSignature: project.timeSignature,
      bars,
      params,
      chords,
      seed,
      range: kind === 'drums' ? { min: 35, max: 81 } : undefined,
      // 有本地语料画像时按画像采样（密度/力度/swing/和弦进行），没有时行为不变
      profile: profileForStyle(style),
    })
    if (notes.length === 0) return fail('生成器没有产出音符（可能参数过于极端），请调整 density/bars 后重试')

    const startBeatInput = readNumber(args, 'startBeat', 0, 100000)
    const smart = { kind, style, seed, params, key: project.key, scale: project.scale }

    const replaceClipId = readString(args, 'replaceClipId')
    if (replaceClipId) {
      const found = findClip(project, replaceClipId, args.trackId)
      if (!found) return fail(`找不到要替换的片段：${replaceClipId}`)
      const clip = found.clip
      // 独立 bug 修复：只传 replaceClipId、不传 startBeat 时必须保留原片段起点
      const keptStartBeat = startBeatInput ?? clip.startBeat
      clip.notes = notes
      clip.smart = smart
      clip.name = clipName ?? kind
      clip.startBeat = keptStartBeat
      clip.lengthBeats = bars * barBeats
      fitClipLength(clip, barBeats)
      return withProject(
        ok(
          `已用生成器「${kind}」重写片段「${clip.name}」：${notes.length} 个音符（起点 ${clip.startBeat} 拍）${overlapWarning(found.track, clip)}`,
          { clipId: clip.id, trackId: found.track.id, noteCount: notes.length, startBeat: clip.startBeat },
        ),
        project,
      )
    }

    let track = findTrack(project, args.trackId)
    let createdTrack = false
    if (!track) {
      const instrumentId = defaultInstrumentForKind(kind, style)
      const instrument = getInstrument(instrumentId)
      track = createTrack({
        instrumentId,
        emotionId: instrument.emotions[0]?.id ?? 'default',
        name: kind === 'drums' ? '鼓组' : `${kind}`,
        color: trackColorFor(instrumentId),
        kind: instrument.isDrumKit ? 'drum' : 'instrument',
        gmProgram: instrument.gmProgram,
      })
      project.tracks.push(track)
      createdTrack = true
    }
    const startBeat = startBeatInput ?? 0
    const lengthBeats = bars * barBeats

    // 同轨道已有同 kind 的智能片段且时间范围相同/被完全覆盖 → 复用替换，避免叠一层
    const reusable = track.clips.find((item) => {
      if (item.smart?.kind !== kind) return false
      const itemEnd = item.startBeat + item.lengthBeats
      const sameRange = Math.abs(item.startBeat - startBeat) < 1e-6 && Math.abs(itemEnd - (startBeat + lengthBeats)) < 1e-6
      const covers = item.startBeat <= startBeat + 1e-6 && itemEnd >= startBeat + lengthBeats - 1e-6
      return sameRange || covers
    })
    if (reusable) {
      reusable.notes = notes
      reusable.smart = smart
      reusable.name = clipName ?? kind
      reusable.startBeat = startBeat
      reusable.lengthBeats = lengthBeats
      fitClipLength(reusable, barBeats)
      return withProject(
        ok(
          `已复用同类型智能片段「${reusable.name}」并重写：${notes.length} 个音符（轨道「${track.name}」，起点 ${startBeat} 拍）${overlapWarning(track, reusable)}`,
          { trackId: track.id, clipId: reusable.id, noteCount: notes.length, createdTrack, reused: true },
        ),
        project,
      )
    }

    const clip = createClip({
      trackId: track.id,
      name: clipName ?? kind,
      startBeat,
      lengthBeats,
      notes,
      smart,
    })
    fitClipLength(clip, barBeats)
    track.clips.push(clip)
    return withProject(
      ok(
        `已生成「${kind}」片段（${style} 风格，${notes.length} 个音符）${createdTrack ? `并新建轨道「${track.name}」` : `写入轨道「${track.name}」`}，id=${clip.id}${overlapWarning(track, clip)}`,
        { trackId: track.id, clipId: clip.id, noteCount: notes.length, createdTrack },
      ),
      project,
    )
  },
}

/* ------------------------------ 工程级设置 ------------------------------ */

export const setTempoTool: ToolDef = {
  name: 'set_tempo',
  title: '设置速度',
  description: '设置工程速度（BPM，20..320）。',
  parameters: toolSchema({ tempo: num('BPM', { minimum: 20, maximum: 320 }) }, ['tempo']),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return fail('设置中已禁用工程修改（allowProjectEdits=false）')
    const tempo = readNumber(args, 'tempo', 20, 320)
    if (tempo === undefined) return fail('请提供有效的 tempo（20..320）')
    const project = clone(ctx.project)
    project.tempo = tempo
    return withProject(ok(`速度已设置为 ${tempo} BPM`, { tempo }), project)
  },
}

export const setKeyScaleTool: ToolDef = {
  name: 'set_key_scale',
  title: '设置调性与调式',
  description: '设置工程调性（如 C / F#）与调式（major / minor / dorian / lydian / mixolydian / pentatonicMinor / blues 等）。',
  parameters: toolSchema(
    {
      key: enm('根音音名', KEYS),
      scale: enm('调式', Object.keys(SCALES)),
    },
    ['key', 'scale'],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return fail('设置中已禁用工程修改（allowProjectEdits=false）')
    const rawKey = readString(args, 'key')
    if (!rawKey) return fail(`请提供 key（可用：${KEY_VALUES.join(' / ')}）`)
    const key = normalizeKey(rawKey)
    if (!key) return fail(`未知调性「${rawKey}」，可用：${KEY_VALUES.join(' / ')}（降号写法会自动转升号，如 Bb→A#）`)
    const rawScale = readString(args, 'scale')
    if (!rawScale) return fail(`请提供 scale（可用：${SCALE_IDS.join(' / ')}）`)
    const scale = normalizeScale(rawScale)
    if (!scale) return fail(`未知调式「${rawScale}」，可用：${SCALE_IDS.join(' / ')}`)
    const project = clone(ctx.project)
    project.key = key
    project.scale = scale
    return withProject(ok(`调性已设置为 ${key} ${scale}`, { key, scale }), project)
  },
}

export const setChordsTool: ToolDef = {
  name: 'set_chords',
  title: '设置和弦进行',
  description:
    '设置全曲和弦进行（按顺序循环）。每项 { root: 0-11 或音名, quality: maj/min/dim/aug/sus2/sus4/dom7/maj7/min7/m7b5/dim7/6/9/add9, beats: 持续拍数 }。也可用 romans: ["I","V","vi","IV"] 按当前调性生成。',
  parameters: toolSchema(
    {
      chords: arr('和弦列表（对象或字符串，如 [{ root: "C", quality: "maj" }] 或 ["Am", "F", "C", "G"]）', obj('和弦', {
        root: str('根音：音名 C / F# / Bb，或音级 0..11（C=0）'),
        quality: str('和弦性质：maj / min / dim / aug / sus2 / sus4 / dom7 / maj7 / min7 / m7b5 / dim7 / 6 / min9 / add9 / power（也接受 major / m / 7 / M7 / m7 等别名）'),
        beats: num('持续拍数', { minimum: 0.25, maximum: 32 }),
      })),
      romans: arr('罗马数字进行（与 chords 二选一）', str('如 I / V / vi / IV / ii7')),
      beats: num('每个和弦的持续拍数（配合 romans）', { minimum: 0.25, maximum: 32 }),
    },
    [],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return fail('设置中已禁用工程修改（allowProjectEdits=false）')
    const project = clone(ctx.project)
    const rawChords = Array.isArray(args.chords) ? args.chords : []
    const chords: ChordSpec[] = []
    for (let index = 0; index < rawChords.length; index++) {
      const chord = toChordSpec(rawChords[index])
      if (!chord) {
        return fail(
          `第 ${index + 1} 个和弦无法解析（${JSON.stringify(rawChords[index])?.slice(0, 40) ?? String(rawChords[index])}）。` +
            `根音用音名 C / F# / Bb 或 0..11；quality 可用：${QUALITY_IDS.join(' / ')}`,
        )
      }
      chords.push(chord)
    }
    if (chords.length === 0 && rawChords.length > 0) {
      return fail('chords 里没有任何可解析的和弦（不会部分写入），请检查后重试')
    }
    if (chords.length === 0 && Array.isArray(args.romans) && args.romans.length > 0) {
      const romans = args.romans.filter((item): item is string => typeof item === 'string')
      const beat = readNumber(args, 'beats', 0.25, 32) ?? 4
      chords.push(...progressionToChords(romans, project.key, project.scale, beat))
      if (chords.length === 0) return fail(`无法解析罗马数字进行：${romans.join(' ')}（示例：I / V / vi / IV / ii7）`)
    }
    if (chords.length === 0) {
      return fail('请提供 chords（如 ["Am","F","C","G"] 或 [{ root: "C", quality: "maj" }]）或 romans（如 ["I","V","vi","IV"]）')
    }
    project.chords = chords
    return withProject(
      ok(`和弦进行已设置：${chords.map((chord) => chordSymbol(chord)).join(' - ')}`, {
        chords: chords.map((chord) => chordSymbol(chord)),
      }),
      project,
    )
  },
}

export const setSectionsTool: ToolDef = {
  name: 'set_sections',
  title: '设置段落',
  description: '设置歌曲段落（前奏/主歌/副歌/桥段/尾声等），用于做能量起伏。startBar 从 0 开始。',
  parameters: toolSchema(
    {
      sections: arr('段落列表（每项 { name, startBar, bars } 或 { name, startBeat, lengthBeats }，按拍号自动换算）', obj('段落', {
        name: str('段落名（如「主歌」「副歌」）'),
        startBar: int('起始小节（从 0 开始）', { minimum: 0 }),
        bars: int('小节数', { minimum: 1 }),
        startBeat: num('起始拍（与 startBar 二选一）', { minimum: 0 }),
        lengthBeats: num('长度（拍，与 bars 二选一）', { minimum: 0.25 }),
        energy: num('能量 0..1', { minimum: 0, maximum: 1 }),
      }, ['name'])),
    },
    ['sections'],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return fail('设置中已禁用工程修改（allowProjectEdits=false）')
    const project = clone(ctx.project)
    const rawSections = Array.isArray(args.sections) ? args.sections : []
    if (rawSections.length === 0) {
      return fail('请提供 sections 数组（每项至少包含 name，以及 startBar+bars 或 startBeat+lengthBeats）')
    }
    const sections: Section[] = []
    for (let index = 0; index < rawSections.length; index++) {
      const raw = rawSections[index]
      if (!raw || typeof raw !== 'object') return fail(`第 ${index + 1} 个段落不是对象`)
      const source = raw as Record<string, unknown>
      const name = readString(source, 'name')
      if (!name) return fail(`第 ${index + 1} 个段落缺少 name（段落名，如「主歌」/「副歌」）`)
      const startBar = clampNumber(source.startBar, 0, 1000)
      if (startBar === undefined) {
        return fail(`第 ${index + 1} 个段落缺少起点：startBar（小节，从 0 开始）或 startBeat（拍）`)
      }
      const bars = clampNumber(source.bars, 1, 1000)
      if (bars === undefined) return fail(`第 ${index + 1} 个段落缺少长度：bars（小节）或 lengthBeats（拍）`)
      sections.push(
        createSection({
          name,
          startBar: Math.round(startBar),
          bars: Math.round(bars),
          energy: clampNumber(source.energy, 0, 1) ?? 0.6,
        }),
      )
    }
    if (sections.length === 0) return fail('sections 数据无效：没有任何可用段落')
    project.sections = sections
    return withProject(ok(`段落已设置：${sections.map((section) => `${section.name}(${section.bars}小节)`).join('、')}`, { sections }), project)
  },
}

export const setMasterVolumeTool: ToolDef = {
  name: 'set_master_volume',
  title: '设置主音量',
  description: '设置工程主音量（0..1.5）。',
  parameters: toolSchema({ volume: num('主音量 0..1.5', { minimum: 0, maximum: 1.5 }) }, ['volume']),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return fail('设置中已禁用工程修改（allowProjectEdits=false）')
    const volume = readNumber(args, 'volume', 0, 1.5)
    if (volume === undefined) return fail('请提供 0..1.5 的 volume')
    const project = clone(ctx.project)
    project.masterVolume = volume
    return withProject(ok(`主音量已设置为 ${volume}`, { masterVolume: volume }), project)
  },
}

/** 工程编辑类工具集合 */
export const PROJECT_TOOLS: ToolDef[] = [
  getProjectSummary,
  analyzeHarmony,
  createTrackTool,
  updateTrackTool,
  setInstrumentTool,
  deleteTrackTool,
  createClipTool,
  updateClipTool,
  deleteClipTool,
  writeNotesTool,
  generateSmartClipTool,
  setTempoTool,
  setKeyScaleTool,
  setChordsTool,
  setSectionsTool,
  setMasterVolumeTool,
]

/** 便于其他模块复用 */
export {
  findTrack as findTrackById,
  findClip as findClipById,
  withProject as withProjectResult,
  fitClipLength,
  overlapWarning,
  rangesOverlap,
  clampNumber,
  parseNoteList,
  parseChords,
  toChordSpec as parseChordSpec,
  trackColorFor,
  trackName,
  resolveEmotion,
  defaultInstrumentForKind,
  clone as cloneProject,
  fail as failResult,
  ok as okResult,
  resolveStyle,
  readString,
  readNumber,
  newId,
  STYLES,
  STYLE_PROGRESSIONS,
  obj,
  arr,
  str,
}
