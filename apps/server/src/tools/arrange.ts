/** 编曲类工具：旋律 → 自动编曲 / 和弦 → 旋律（CONTRACTS 需求 8a / 8b）。 */
import { profileForStyle } from '../style/profileStore.js'
import {
  STYLE_PROGRESSIONS,
  arrangeFromMelody,
  beatsPerBar,
  createClip,
  createNote,
  createTrack,
  deepClone,
  getInstrument,
  hasInstrument,
  melodyFromChords,
  progressionToChords,
  type ChordSpec,
  type Clip,
  type NoteEvent,
  type Project,
  type Track,
} from '@aiab/core'
import {
  arr,
  enm,
  int,
  num,
  obj,
  str,
  toolSchema,
  type ToolDef,
  type ToolResult,
} from './schema.js'
import {
  cloneProject,
  defaultInstrumentForKind,
  failResult,
  findTrackById,
  okResult,
  parseChordSpec,
  parseNoteList,
  readNumber,
  readString,
  resolveEmotion,
  resolveStyle,
  STYLES,
  trackColorFor,
} from './project.js'
import { normalizeKey, normalizeScale, unknownInstrumentMessage } from './validate.js'
import { scaleLabel } from './summary.js'

function normalizeMelody(notes: NoteEvent[]): NoteEvent[] {
  if (notes.length === 0) return []
  const minStart = notes.reduce((min, note) => Math.min(min, note.start), Number.POSITIVE_INFINITY)
  const shift = Number.isFinite(minStart) ? Math.max(0, minStart) : 0
  return notes
    .map((note) => createNote(note.pitch, Math.max(0, note.start - shift), note.duration, note.velocity))
    .sort((a, b) => a.start - b.start)
}

interface MelodySource {
  notes: NoteEvent[]
  source: string
  clip?: Clip
  track?: Track
}

function collectMelody(project: Project, args: Record<string, unknown>): MelodySource | null {
  const direct = parseNoteList(args.melody ?? args.notes)
  if (direct.length) return { notes: direct, source: '参数传入的音符' }

  const clipId = readString(args, 'melodyClipId') ?? readString(args, 'clipId')
  if (clipId) {
    for (const track of project.tracks) {
      const clip = track.clips.find((item) => item.id === clipId)
      if (clip) return { notes: clip.notes, source: `${track.name} / ${clip.name}`, clip, track }
    }
  }
  const trackId = readString(args, 'melodyTrackId') ?? readString(args, 'trackId')
  if (trackId) {
    const track = findTrackById(project, trackId)
    if (track) {
      const clip = [...track.clips].sort((a, b) => b.notes.length - a.notes.length)[0]
      if (clip) return { notes: clip.notes, source: `${track.name} / ${clip.name}`, clip, track }
    }
  }
  // 自动找：名字带「旋律 / melody / lead」的轨道优先，否则找音符最多的非鼓轨
  const candidates = project.tracks.filter((track) => track.kind !== 'drum' && track.clips.some((clip) => clip.notes.length > 0))
  const named = candidates.find((track) => /旋律|melody|lead|主音|人声/i.test(track.name))
  const ordered = named ? [named, ...candidates.filter((track) => track !== named)] : candidates
  for (const track of ordered) {
    const clip = [...track.clips].sort((a, b) => b.notes.length - a.notes.length)[0]
    if (clip) return { notes: clip.notes, source: `${track.name} / ${clip.name}`, clip, track }
  }
  return null
}

/* ------------------------------ 旋律 → 编曲 ------------------------------ */

export const arrangeFromMelodyTool: ToolDef = {
  name: 'arrange_from_melody',
  title: '旋律 → 自动编曲',
  description:
    '【核心能力】读取一条已有旋律（默认自动挑选旋律轨），识别调性、配和声、生成整套伴奏声部（鼓/贝斯/和弦/铺底/对位等）。默认保留原旋律轨并追加伴奏；mode=replace 会重建全部轨道。',
  parameters: toolSchema(
    {
      melodyClipId: str('旋律片段 id（可选，默认自动挑选）'),
      melodyTrackId: str('旋律轨道 id（可选）'),
      clipId: str('旋律片段 id（melodyClipId 的旧别名）'),
      trackId: str('旋律轨道 id（melodyTrackId 的旧别名）'),
      melody: arr('直接传入旋律音符（可选，pitch/start/duration/velocity）', obj('音符', {
        pitch: int('MIDI 音高或音名（如 C4 / F#3），必填', { minimum: 0, maximum: 127 }),
        start: num('起点（拍）', { minimum: 0 }),
        duration: num('时值（拍）', { minimum: 0.015625 }),
        velocity: int('力度 1..127', { minimum: 1, maximum: 127 }),
      })),
      notes: arr('直接传入旋律音符（melody 的旧别名）', obj('音符', {
        pitch: int('MIDI 音高或音名（如 C4 / F#3），必填', { minimum: 0, maximum: 127 }),
        start: num('起点（拍）', { minimum: 0 }),
        duration: num('时值（拍）', { minimum: 0.015625 }),
        velocity: int('力度 1..127', { minimum: 1, maximum: 127 }),
      })),
      style: enm('编曲风格', STYLES),
      key: str('调性（可选，缺省自动识别）'),
      scale: str('调式（可选，缺省自动识别）'),
      bars: num('编曲长度（小节，可选）', { minimum: 1, maximum: 64 }),
      energy: num('整体强度 0..1', { minimum: 0, maximum: 1 }),
      seed: int('随机种子'),
      mode: enm('结果模式：append 保留现有轨道并追加伴奏 / replace 重建全部轨道', ['append', 'replace']),
    },
    [],
  ),
  async handler(args, ctx): Promise<ToolResult> {
    if (!ctx.allowProjectEdits) return failResult('设置中已禁用工程修改（allowProjectEdits=false）')
    const project = cloneProject(ctx.project)
    const melodySource = collectMelody(project, args)
    if (!melodySource || melodySource.notes.length === 0) {
      return failResult('没有找到可用的旋律。请先在旋律轨上写入音符，或通过 melodyClipId 指定片段。')
    }
    const melody = normalizeMelody(melodySource.notes)
    const style = resolveStyle(args)
    const timeSignature = project.timeSignature
    const barBeats = beatsPerBar(timeSignature)
    const melodyEnd = melody.reduce((max, note) => Math.max(max, note.start + note.duration), 0)
    const bars = Math.max(1, Math.round(readNumber(args, 'bars', 1, 64) ?? Math.max(4, Math.ceil(melodyEnd / barBeats))))
    const energy = readNumber(args, 'energy', 0, 1) ?? 0.62
    const seed = Math.floor(readNumber(args, 'seed', 0, 2 ** 31) ?? Math.floor(Math.random() * 100000))
    const keyArg = normalizeKey(readString(args, 'key') ?? project.key) ?? project.key
    const scaleArg = normalizeScale(readString(args, 'scale') ?? project.scale) ?? project.scale

    let result
    try {
      result = arrangeFromMelody({
        style,
        key: keyArg,
        scale: scaleArg,
        tempo: project.tempo,
        bars,
        chords: project.chords,
        melody,
        energy,
        seed,
        timeSignature,
        profile: profileForStyle(style),
      })
    } catch (error) {
      return failResult(`编曲失败：${(error as Error).message}`)
    }

    project.key = result.key
    project.scale = result.scale
    project.chords = result.chords
    if (result.sections.length) project.sections = result.sections

    // 旋律来源片段带起点时，伴奏/旋律整体对齐到该起点（core arrangeFromMelody 从 0 拍生成）
    const startOffset = Math.max(0, melodySource.clip?.startBeat ?? 0)
    if (startOffset > 0) {
      for (const track of result.tracks) {
        for (const clip of track.clips) clip.startBeat += startOffset
      }
    }

    const mode = readString(args, 'mode') === 'replace' ? 'replace' : 'append'
    const accompaniment = result.tracks.filter((track) => track.name !== '主旋律')
    let replacedTracks: string[] = []
    if (mode === 'replace') {
      project.tracks = result.tracks
    } else {
      // append 模式重复调用：先移除同名伴奏轨再追加，避免叠出一堆重复轨道
      const names = new Set(accompaniment.map((track) => track.name))
      replacedTracks = project.tracks.filter((track) => names.has(track.name)).map((track) => track.name)
      project.tracks = project.tracks.filter((track) => !names.has(track.name))
      project.tracks.push(...accompaniment)
    }
    project.updatedAt = Date.now()
    const added = mode === 'replace' ? result.tracks : accompaniment
    const alignNote = startOffset > 0 ? `\n（已按旋律片段起点 ${startOffset} 拍对齐伴奏）` : ''
    const replaceNote = replacedTracks.length
      ? `\n（已替换原有同名伴奏轨：${[...new Set(replacedTracks)].join('、')}，未重复叠加）`
      : ''
    return {
      ok: true,
      message: `${result.analysis}\n已生成声部：${added.map((track) => track.name).join('、')}（旋律来源：${melodySource.source}）${alignNote}${replaceNote}`,
      project,
      data: {
        analysis: result.analysis,
        key: result.key,
        scale: result.scale,
        chords: result.chords,
        tracks: added.map((track) => ({ id: track.id, name: track.name, instrumentId: track.instrumentId, clips: track.clips.length })),
        mode,
        melodySource: melodySource.source,
        startOffset,
        replacedTracks: [...new Set(replacedTracks)],
      },
    }
  },
}

/* ------------------------------ 和弦 → 旋律 ------------------------------ */

export const melodyFromChordsTool: ToolDef = {
  name: 'melody_from_chords',
  title: '和弦 → 填写旋律',
  description:
    '【核心能力】根据和弦进行生成一条有乐句感的旋律，写入新轨道或指定轨道。若工程没有和弦，会先按风格生成一段进行。',
  parameters: toolSchema(
    {
      chords: arr('和弦进行（可选，缺省用工程和弦 / 按风格生成）', obj('和弦', {
        root: str('根音：音名 C / F# / Bb，或音级 0..11（C=0）'),
        quality: str('性质 maj / min / dom7 / maj7 / min7 等（也接受 major / m / 7 / M7 等别名）'),
        beats: num('持续拍数', { minimum: 0.25, maximum: 32 }),
      })),
      romans: arr('罗马数字进行（可选，替代 chords）', str('如 I / V / vi / IV')),
      beats: num('每个和弦的持续拍数（配合 romans 使用，缺省 4）', { minimum: 0.25, maximum: 32 }),
      style: enm('风格', STYLES),
      key: str('调性（可选）'),
      scale: str('调式（可选）'),
      bars: num('旋律长度（小节）', { minimum: 1, maximum: 64 }),
      octave: int('旋律基准八度 2..7', { minimum: 2, maximum: 7 }),
      density: num('密度 0..1', { minimum: 0, maximum: 1 }),
      complexity: num('复杂度 0..1', { minimum: 0, maximum: 1 }),
      energy: num('能量 0..1', { minimum: 0, maximum: 1 }),
      seed: int('随机种子'),
      instrumentId: str('旋律音色 id（可选，默认钢琴）'),
      emotionId: str('情绪预设 id（可选，新建轨道时用）'),
      trackId: str('写入已有轨道（可选，缺省新建轨道）'),
      startBeat: num('片段起点（拍）', { minimum: 0 }),
    },
    [],
  ),
  async handler(args, ctx): Promise<ToolResult> {
    if (!ctx.allowProjectEdits) return failResult('设置中已禁用工程修改（allowProjectEdits=false）')
    const project = cloneProject(ctx.project)
    const style = resolveStyle(args)
    const barBeats = beatsPerBar(project.timeSignature)
    const key = normalizeKey(readString(args, 'key') ?? project.key) ?? project.key
    const scale = normalizeScale(readString(args, 'scale') ?? project.scale) ?? project.scale

    const rawChords = Array.isArray(args.chords) ? args.chords : []
    let chords: ChordSpec[] = []
    for (let index = 0; index < rawChords.length; index++) {
      const spec = parseChordSpec(rawChords[index])
      if (!spec) {
        return failResult(
          `第 ${index + 1} 个和弦无法解析（${JSON.stringify(rawChords[index])?.slice(0, 40) ?? String(rawChords[index])}）。` +
            '根音用音名 C / F# / Bb 或 0..11；quality 可用 maj / min / dom7 / maj7 / min7 / sus4 / dim / m7b5 等',
        )
      }
      chords.push(spec)
    }
    if (chords.length === 0 && Array.isArray(args.romans) && args.romans.length > 0) {
      chords = progressionToChords(
        args.romans.filter((item): item is string => typeof item === 'string'),
        key,
        scale,
        readNumber(args, 'beats', 0.25, 32) ?? 4,
      )
    }
    if (chords.length === 0) chords = project.chords
    if (chords.length === 0) {
      chords = progressionToChords(STYLE_PROGRESSIONS[style] ?? STYLE_PROGRESSIONS.pop, key, scale, barBeats)
    }
    const chordBeats = chords.reduce((sum, chord) => sum + chord.beats, 0)
    const bars = Math.max(1, Math.round(readNumber(args, 'bars', 1, 64) ?? Math.max(2, Math.ceil(chordBeats / barBeats))))
    const seed = Math.floor(readNumber(args, 'seed', 0, 2 ** 31) ?? Math.floor(Math.random() * 100000))
    const instrumentInput = readString(args, 'instrumentId')
    if (instrumentInput && !hasInstrument(instrumentInput)) return failResult(unknownInstrumentMessage(instrumentInput))
    const instrumentId = instrumentInput ?? defaultInstrumentForKind('melody', style)
    const startBeat = readNumber(args, 'startBeat', 0, 100000) ?? 0

    let result
    try {
      result = melodyFromChords({
        chords,
        style,
        key,
        scale,
        tempo: project.tempo,
        bars,
        timeSignature: project.timeSignature,
        octave: readNumber(args, 'octave', 2, 7) ?? 5,
        density: readNumber(args, 'density', 0, 1) ?? 0.55,
        complexity: readNumber(args, 'complexity', 0, 1) ?? 0.55,
        energy: readNumber(args, 'energy', 0, 1) ?? 0.62,
        seed,
        instrumentId,
        profile: profileForStyle(style),
      })
    } catch (error) {
      return failResult(`旋律生成失败：${(error as Error).message}`)
    }
    if (result.notes.length === 0) return failResult('旋律生成器没有产出音符，请调整 density/energy 后重试')

    // 工程和弦同步（原来为空时补上，便于后续编排）
    if (project.chords.length === 0) project.chords = chords

    const targetTrack = findTrackById(project, args.trackId)
    let track: Track
    let clip: Clip
    if (targetTrack) {
      track = targetTrack
      clip = createClip({
        trackId: track.id,
        name: 'AI 旋律',
        startBeat,
        lengthBeats: bars * barBeats,
        notes: result.notes,
      })
      track.clips.push(clip)
    } else {
      track = createTrack({
        instrumentId: result.track.instrumentId,
        emotionId: resolveEmotion(result.track.instrumentId, args.emotionId),
        name: 'AI 旋律',
        color: trackColorFor(result.track.instrumentId),
        gmProgram: result.track.gmProgram,
        volume: 0.82,
        reverbSend: 0.22,
      })
      clip = result.track.clips[0] ?? createClip({ trackId: track.id, name: '旋律', lengthBeats: bars * barBeats })
      clip.trackId = track.id
      clip.startBeat = startBeat
      clip.lengthBeats = bars * barBeats
      clip.notes = result.notes
      track.clips = [clip]
      project.tracks.push(track)
    }

    project.updatedAt = Date.now()
    const chordLine = chords.slice(0, 8).map((chord) => `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][chord.root]}${chord.quality}`).join(' - ')
    return {
      ok: true,
      message: `已按和弦（${chordLine}${chords.length > 8 ? ' …' : ''}）生成 ${result.notes.length} 个音符的旋律，${targetTrack ? `写入轨道「${track.name}」` : `新建轨道「${track.name}」`}（${getInstrument(track.instrumentId).name}，调性 ${key} ${scaleLabel(scale)}）。`,
      project,
      data: {
        trackId: track.id,
        clipId: clip.id,
        noteCount: result.notes.length,
        chords: chords.map((chord) => ({ root: chord.root, quality: chord.quality, beats: chord.beats })),
        key,
        scale,
      },
    }
  },
}

export const ARRANGE_TOOLS: ToolDef[] = [arrangeFromMelodyTool, melodyFromChordsTool]

export { deepClone }
