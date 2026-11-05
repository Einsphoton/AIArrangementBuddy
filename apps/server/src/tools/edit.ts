/**
 * 编曲编辑类工具（复制 / 重复段落 / 拆分 / 合并 / 量化 / 移调 / 人性化 / 力度 / 音阶锁定 /
 * 复制轨道 / 清空轨道 + 工程级 swing / 拍号 / loop / 整体移调）。
 *
 * 设计原则：
 * - 全部在 deepClone 的工程快照上修改，返回 { ok, message, project, data }；
 * - 时间单位一律是「拍」，clip.startBeat 是绝对起点，note.start 是相对片段的起点；
 * - 生成新 id（clip / note），不修改原对象的引用；
 * - 所有修改类工具都会在 message 里写清楚做了什么、限制是什么，方便模型继续决策。
 */
import {
  KEYS,
  beatsPerBar,
  createClip,
  createNote,
  deepClone,
  isInScale,
  newId,
  projectEndBeat,
  snapToScale,
  type Clip,
  type NoteEvent,
  type ScaleId,
  type Track,
} from '@aiab/core'
import { arr, bool, enm, int, num, str, toolSchema, CLIP_ID, TRACK_ID, type ToolDef, type ToolResult } from './schema.js'
import {
  clampNumber,
  cloneProject,
  failResult,
  findClipById,
  findTrackById,
  fitClipLength,
  okResult,
  overlapWarning,
  readNumber,
  readString,
  withProjectResult,
} from './project.js'
import { KEY_VALUES, normalizeKey, normalizeScale, SCALE_IDS } from './validate.js'
import { scaleLabel } from './summary.js'

const EPS = 1e-6
const SHAPES = ['accent', 'crescendo', 'decrescendo', 'flat'] as const
const DENOMINATORS = [2, 4, 8, 16] as const

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** 读整数参数（先 clamp 再四舍五入；整数语义的参数统一走这里） */
function readInt(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = clampNumber(args[key], min, max)
  return value === undefined ? undefined : Math.round(value)
}

function formatBeats(value: number): string {
  const rounded = round6(value)
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

/** 按拍数生成人类可读的「1、2、3、4 拍」列表 */
function beatsLabel(values: number[], limit = 4): string {
  const items = values.slice(0, limit).map((value) => `${formatBeats(value)} 拍`)
  return values.length > limit ? `${items.join('、')} 等 ${values.length} 处` : items.join('、')
}

/** 复制音符：全部生成新 id；可选移调并 clamp 到 0..127，返回被压边界的音符数 */
function cloneNotes(notes: NoteEvent[], semitones = 0): { notes: NoteEvent[]; clamped: number } {
  let clamped = 0
  const out = notes.map((note) => {
    const raw = note.pitch + semitones
    const pitch = Math.round(clamp(raw, 0, 127))
    if (pitch !== raw) clamped++
    return createNote(pitch, note.start, note.duration, note.velocity)
  })
  return { notes: out, clamped }
}

/** 复制片段（新 clip / note id，保留名称/颜色/静音/智能配置） */
function cloneClip(
  source: Clip,
  trackId: string,
  startBeat: number,
  opts: { name?: string; semitones?: number } = {},
): { clip: Clip; clamped: number } {
  const { notes, clamped } = cloneNotes(source.notes, opts.semitones ?? 0)
  const clip = createClip({
    trackId,
    name: opts.name ?? source.name,
    color: source.color,
    startBeat: round6(startBeat),
    lengthBeats: source.lengthBeats,
    notes,
    muted: source.muted,
    smart: source.smart ? deepClone(source.smart) : undefined,
  })
  return { clip, clamped }
}

/** 给一组新片段汇总「与已有片段重叠」提示（不阻断，只提醒） */
function overlapNote(track: Track, clips: Clip[]): string {
  const names = new Set<string>()
  for (const clip of clips) {
    const warning = overlapWarning(track, clip)
    if (!warning) continue
    for (const match of warning.matchAll(/「([^」]+)」/g)) names.add(match[1])
  }
  if (names.size === 0) return ''
  const list = [...names].slice(0, 3).map((name) => `「${name}」`).join('、')
  const more = names.size > 3 ? ' 等' : ''
  return `\n注意：与已有片段${list}${more}时间重叠，播放会叠加`
}

function editsDisabled(): ToolResult {
  return failResult('设置中已禁用工程修改（allowProjectEdits=false）')
}

/* ------------------------------- 1. copy_clip ------------------------------- */

export const copyClipTool: ToolDef = {
  name: 'copy_clip',
  title: '复制片段',
  description:
    '复制已有片段（保持音符、音色、名称一致，不重新生成）。默认接在原片段后面依次平铺 count 份；可指定 startBeat 放到任意位置、targetTrackId 复制到别的轨道、transpose 移调。适合「把主歌铺到副歌」「主题重复」「加一层同音色声部」。需要按小节整段复制多条轨道用 repeat_section。',
  parameters: toolSchema(
    {
      clipId: CLIP_ID,
      targetTrackId: TRACK_ID,
      startBeat: num('第一份的绝对起点（拍），默认 = 原片段结束位置', { minimum: 0 }),
      count: int('复制份数 1..16（默认 1）', { minimum: 1, maximum: 16 }),
      transpose: int('复制后移调半音 -24..24（默认 0，超出 0..127 会压到边界）', { minimum: -24, maximum: 24 }),
      name: str('新片段名称（默认沿用原名，多份时自动加序号）'),
    },
    ['clipId'],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return editsDisabled()
    const project = cloneProject(ctx.project)
    const found = findClipById(project, args.clipId)
    if (!found) return failResult(`找不到片段：${String(args.clipId)}（可用 get_project_summary 获取 clipId）`)
    const targetTrackId = readString(args, 'targetTrackId')
    const targetTrack = targetTrackId ? findTrackById(project, targetTrackId) : found.track
    if (!targetTrack) return failResult(`找不到目标轨道：${targetTrackId}（可用 get_project_summary 获取 trackId）`)
    const count = readInt(args, 'count', 1, 16) ?? 1
    const semitones = readInt(args, 'transpose', -24, 24) ?? 0
    const startBeat = readNumber(args, 'startBeat', 0, 100000) ?? round6(found.clip.startBeat + found.clip.lengthBeats)
    const preferredName = readString(args, 'name')
    const createdIds: string[] = []
    const createdStarts: number[] = []
    const createdClips: Clip[] = []
    let clampedNotes = 0
    for (let index = 0; index < count; index++) {
      const at = round6(startBeat + index * found.clip.lengthBeats)
      const baseName = preferredName ?? found.clip.name
      const copyName = count > 1 ? `${baseName} ${index + 1}` : baseName
      const copied = cloneClip(found.clip, targetTrack.id, at, { name: copyName, semitones })
      targetTrack.clips.push(copied.clip)
      createdIds.push(copied.clip.id)
      createdStarts.push(at)
      createdClips.push(copied.clip)
      clampedNotes += copied.clamped
    }
    const crossedTrack = targetTrack.id !== found.track.id
    let message =
      `已把片段「${found.clip.name}」复制 ${count} 份到轨道「${targetTrack.name}」` +
      `（${beatsLabel(createdStarts)}${count > 1 ? `，每份 ${formatBeats(found.clip.lengthBeats)} 拍依次平铺` : ''}` +
      `${crossedTrack ? `，来自轨道「${found.track.name}」` : ''}）`
    if (semitones) message += `；已${semitones > 0 ? '升高' : '降低'} ${Math.abs(semitones)} 个半音`
    if (clampedNotes) message += `；${clampedNotes} 个音符移调后超出 0..127，已压到边界`
    message += overlapNote(targetTrack, createdClips)
    return withProjectResult(
      okResult(message, {
        createdClipIds: createdIds,
        trackId: targetTrack.id,
        count,
        startBeats: createdStarts,
        transposed: semitones,
        clampedNotes,
      }),
      project,
    )
  },
}

/* ----------------------------- 2. repeat_section ---------------------------- */

export const repeatSectionTool: ToolDef = {
  name: 'repeat_section',
  title: '重复段落',
  description:
    '把某几小节的「所有片段」整体复制到另一小节位置（不重新生成），用来快速构建段落结构：例如把主歌 4 小节复制成副歌前奏，或把副歌重复一遍。按片段 startBeat 是否落在 [fromBar, fromBar+bars) 判定；可只用 tracks 复制指定轨道。',
  parameters: toolSchema(
    {
      fromBar: int('源段落起始小节（从 0 开始）', { minimum: 0 }),
      bars: int('源段落小节数（>=1）', { minimum: 1, maximum: 64 }),
      toBar: int('复制到的目标小节（从 0 开始）', { minimum: 0 }),
      tracks: arr('只复制这些轨道 id（可选，缺省复制所有轨道）', str('轨道 id')),
    },
    ['fromBar', 'bars', 'toBar'],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return editsDisabled()
    const project = cloneProject(ctx.project)
    const fromBar = readInt(args, 'fromBar', 0, 1000)
    const bars = readInt(args, 'bars', 1, 64)
    const toBar = readInt(args, 'toBar', 0, 1000)
    if (fromBar === undefined || bars === undefined || toBar === undefined) {
      return failResult('repeat_section 需要 fromBar（源起始小节）、bars（源小节数）、toBar（目标小节），且都是整数')
    }
    const barBeats = beatsPerBar(project.timeSignature)
    const sourceStart = round6(fromBar * barBeats)
    const sourceEnd = round6((fromBar + bars) * barBeats)
    const offset = round6((toBar - fromBar) * barBeats)
    const requestedTracks = Array.isArray(args.tracks)
      ? args.tracks.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
      : []
    let targetTracks = project.tracks
    const ignoredTracks: string[] = []
    if (requestedTracks.length > 0) {
      const wanted = new Set<string>()
      for (const key of requestedTracks) {
        // 容错：模型可能传轨道名而不是 trackId
        const matched = project.tracks.find((track) => track.id === key) ?? project.tracks.find((track) => track.name === key)
        if (matched) wanted.add(matched.id)
        else ignoredTracks.push(key)
      }
      targetTracks = project.tracks.filter((track) => wanted.has(track.id))
      if (targetTracks.length === 0) {
        return failResult(`指定的轨道都不存在：${requestedTracks.join('、')}（可用 trackId 从 get_project_summary 获取）`)
      }
    }
    const sources: { track: Track; clip: Clip }[] = []
    for (const track of targetTracks) {
      for (const clip of track.clips) {
        if (clip.startBeat >= sourceStart - EPS && clip.startBeat < sourceEnd - EPS) sources.push({ track, clip })
      }
    }
    if (sources.length === 0) {
      return failResult(
        `第 ${fromBar} 小节起 ${bars} 小节（${formatBeats(sourceStart)}–${formatBeats(sourceEnd)} 拍）内没有片段，未复制。请检查 fromBar/bars，或先用 get_project_summary 查看片段位置`,
      )
    }
    const createdClips: Clip[] = []
    const createdIds: string[] = []
    const createdByTrack = new Map<string, { track: Track; clips: Clip[] }>()
    for (const source of sources) {
      const copied = cloneClip(source.clip, source.track.id, round6(source.clip.startBeat + offset))
      source.track.clips.push(copied.clip)
      createdClips.push(copied.clip)
      createdIds.push(copied.clip.id)
      const bucket = createdByTrack.get(source.track.id) ?? { track: source.track, clips: [] }
      bucket.clips.push(copied.clip)
      createdByTrack.set(source.track.id, bucket)
    }
    const trackNames = [...new Set(sources.map((source) => source.track.name))]
    let message =
      `已把第 ${fromBar}–${fromBar + bars - 1} 小节（共 ${sources.length} 个片段）复制到第 ${toBar} 小节起` +
      `（偏移 ${formatBeats(offset)} 拍；涉及轨道：${trackNames.join('、')}）` +
      `${ignoredTracks.length > 0 ? `；忽略不存在的轨道：${ignoredTracks.join('、')}` : ''}`
    for (const bucket of createdByTrack.values()) message += overlapNote(bucket.track, bucket.clips)
    return withProjectResult(
      okResult(message, {
        copiedClips: sources.length,
        createdClipIds: createdIds,
        fromBar,
        bars,
        toBar,
        offsetBeats: offset,
      }),
      project,
    )
  },
}

/* ------------------------------ 3. split_clip ------------------------------- */

export const splitClipTool: ToolDef = {
  name: 'split_clip',
  title: '拆分片段',
  description:
    '在指定绝对拍处把一个片段拆成左右两段（左段保留原 clipId，右段是新片段）。跨过切点的音符归左段并截断时值，右侧音符起点相对新片段重算。适合「只改后半段」「把一段鼓拆成前后两个 pattern」。',
  parameters: toolSchema(
    {
      clipId: CLIP_ID,
      atBeat: num('拆分点的绝对拍（必须落在片段内部，距两端至少 0.25 拍）', { minimum: 0 }),
      trackId: str('轨道 id（可选，用于加速定位）'),
    },
    ['clipId', 'atBeat'],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return editsDisabled()
    const project = cloneProject(ctx.project)
    const found = findClipById(project, args.clipId, args.trackId)
    if (!found) return failResult(`找不到片段：${String(args.clipId)}（可用 get_project_summary 获取 clipId）`)
    const { clip, track } = found
    const atBeat = readNumber(args, 'atBeat', 0, 100000)
    if (atBeat === undefined) return failResult('请提供拆分点 atBeat（绝对拍）')
    const clipStart = clip.startBeat
    const clipEnd = round6(clip.startBeat + clip.lengthBeats)
    if (atBeat - clipStart < 0.25 - EPS || clipEnd - atBeat < 0.25 - EPS) {
      return failResult(
        `拆分点必须落在片段内部且距两端至少 0.25 拍：片段「${clip.name}」范围 ${formatBeats(clipStart)}–${formatBeats(clipEnd)} 拍，收到 ${formatBeats(atBeat)} 拍`,
      )
    }
    const offset = round6(atBeat - clipStart)
    const leftNotes: NoteEvent[] = []
    const rightNotes: NoteEvent[] = []
    for (const note of clip.notes) {
      if (note.start < offset - EPS) {
        if (note.start + note.duration > offset + EPS) {
          leftNotes.push({ ...note, duration: Math.max(1 / 64, round6(offset - note.start)) })
        } else {
          leftNotes.push(note)
        }
      } else {
        rightNotes.push(createNote(note.pitch, round6(note.start - offset), note.duration, note.velocity))
      }
    }
    const barBeats = beatsPerBar(project.timeSignature)
    clip.notes = leftNotes
    clip.lengthBeats = offset
    const rightClip = createClip({
      trackId: track.id,
      name: `${clip.name} B`,
      color: clip.color,
      startBeat: round6(atBeat),
      lengthBeats: round6(clipEnd - atBeat),
      notes: rightNotes,
      muted: clip.muted,
    })
    fitClipLength(rightClip, barBeats)
    track.clips.push(rightClip)
    return withProjectResult(
      okResult(
        `已把片段「${clip.name}」（${track.name}）在 ${formatBeats(atBeat)} 拍处拆成两段：` +
          `左段「${clip.name}」${leftNotes.length} 个音符 / ${formatBeats(clip.lengthBeats)} 拍，` +
          `右段「${rightClip.name}」${rightNotes.length} 个音符 / ${formatBeats(rightClip.lengthBeats)} 拍（新 clipId=${rightClip.id}）`,
        {
          clipId: clip.id,
          newClipId: rightClip.id,
          trackId: track.id,
          leftNotes: leftNotes.length,
          rightNotes: rightNotes.length,
        },
      ),
      project,
    )
  },
}

/* ------------------------------ 4. merge_clips ------------------------------ */

export const mergeClipsTool: ToolDef = {
  name: 'merge_clips',
  title: '合并片段',
  description:
    '把同一条轨道上的多个片段合并成一个（音符按各自时间偏移拼到一起，删除其余片段，长度覆盖到最晚结束）。适合把拆开/分段生成的片段合成一个，方便整体量化或移调。要求所有片段在同一条轨道且至少 2 个。',
  parameters: toolSchema(
    {
      clipIds: arr('要合并的片段 id 列表（至少 2 个，必须在同一轨道）', str('片段 id')),
      name: str('合并后的片段名称（可选，默认沿用最早的片段名）'),
    },
    ['clipIds'],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return editsDisabled()
    const project = cloneProject(ctx.project)
    const rawIds = Array.isArray(args.clipIds)
      ? args.clipIds.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
      : []
    const clipIds = [...new Set(rawIds)]
    if (clipIds.length < 2) return failResult('merge_clips 需要至少 2 个不同的 clipId')
    const entries: { track: Track; clip: Clip }[] = []
    const missing: string[] = []
    for (const clipId of clipIds) {
      const found = findClipById(project, clipId)
      if (found) entries.push(found)
      else missing.push(clipId)
    }
    if (missing.length > 0) return failResult(`找不到片段：${missing.join('、')}（可用 get_project_summary 获取 clipId）`)
    const trackId = entries[0].track.id
    if (entries.some((entry) => entry.track.id !== trackId)) {
      return failResult(
        `合并要求所有片段在同一条轨道：${entries.map((entry) => `「${entry.clip.name}」@${entry.track.name}`).join('、')}` +
          '。可先用 copy_clip 把片段复制到同一轨道再合并',
      )
    }
    const track = entries[0].track
    const ordered = [...entries].sort((a, b) => a.clip.startBeat - b.clip.startBeat)
    const base = ordered[0].clip
    let endBeat = Math.max(...ordered.map((entry) => entry.clip.startBeat + entry.clip.lengthBeats))
    const notes: NoteEvent[] = []
    for (const entry of ordered) {
      const clipOffset = entry.clip.startBeat - base.startBeat
      for (const note of entry.clip.notes) {
        notes.push(createNote(note.pitch, round6(clipOffset + note.start), note.duration, note.velocity))
        endBeat = Math.max(endBeat, entry.clip.startBeat + note.start + note.duration)
      }
    }
    notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
    const removeIds = new Set(ordered.slice(1).map((entry) => entry.clip.id))
    track.clips = track.clips.filter((clip) => !removeIds.has(clip.id))
    const mergedName = readString(args, 'name') ?? base.name
    const mergedNames = ordered.map((entry) => entry.clip.name)
    base.notes = notes
    base.lengthBeats = Math.max(0.25, round6(endBeat - base.startBeat))
    base.smart = undefined
    base.name = mergedName
    fitClipLength(base, beatsPerBar(project.timeSignature))
    return withProjectResult(
      okResult(
        `已把 ${mergedNames.map((name) => `「${name}」`).join('、')} 合并为片段「${base.name}」` +
          `（${track.name}，起点 ${formatBeats(base.startBeat)} 拍，长度 ${formatBeats(base.lengthBeats)} 拍，共 ${notes.length} 个音符）`,
        { clipId: base.id, trackId: track.id, mergedCount: ordered.length, noteCount: notes.length },
      ),
      project,
    )
  },
}

/* --------------------------- 5. transpose_clip ------------------------------ */

export const transposeClipTool: ToolDef = {
  name: 'transpose_clip',
  title: '片段移调',
  description:
    '把单个片段的音符整体移调（半音，-48..48），不会改变调性设置。鼓组轨道拒绝（鼓音高=固定音色，请用 generate_smart_clip 换 pattern）。默认 clamp=true 把越界音高压到 0..127；clamp=false 时若越界则直接失败并说明。要整曲移调请用 transpose_project。',
  parameters: toolSchema(
    {
      clipId: CLIP_ID,
      semitones: int('移调半音数 -48..48（正数升高）', { minimum: -48, maximum: 48 }),
      clamp: bool('越界音高是否 clamp 到 0..127（默认 true；false = 越界时拒绝执行）'),
    },
    ['clipId', 'semitones'],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return editsDisabled()
    const project = cloneProject(ctx.project)
    const found = findClipById(project, args.clipId)
    if (!found) return failResult(`找不到片段：${String(args.clipId)}（可用 get_project_summary 获取 clipId）`)
    const { clip, track } = found
    const semitones = readInt(args, 'semitones', -48, 48)
    if (semitones === undefined) return failResult('请提供 semitones（-48..48 的整数半音数）')
    const clampPitches = typeof args.clamp === 'boolean' ? args.clamp : true
    if (track.kind === 'drum') {
      return failResult(
        `鼓组轨道「${track.name}」的片段不能移调（鼓音高对应固定音色，移调会变成别的鼓/杂音）。` +
          `替代方案：用 generate_smart_clip（kind="drums"、trackId="${track.id}"，可选 patternId/bars/seed）重新生成需要的鼓型，或 copy_clip 后单独调整。`,
      )
    }
    if (semitones === 0) {
      return withProjectResult(okResult(`semitones=0，片段「${clip.name}」未做修改`, { clipId: clip.id, transposedNotes: 0 }), project)
    }
    if (!clampPitches) {
      const outOfRange = clip.notes.filter((note) => note.pitch + semitones < 0 || note.pitch + semitones > 127)
      if (outOfRange.length > 0) {
        const lowest = Math.min(...clip.notes.map((note) => note.pitch))
        const highest = Math.max(...clip.notes.map((note) => note.pitch))
        return failResult(
          `移调 ${semitones > 0 ? '+' : ''}${semitones} 个半音后会有 ${outOfRange.length} 个音符超出 MIDI 0..127` +
            `（当前片段音域 ${lowest}..${highest}）。把 clamp 设为 true 可自动压到边界，或减小 semitones。`,
        )
      }
    }
    let transposed = 0
    let clampedNotes = 0
    for (const note of clip.notes) {
      const raw = note.pitch + semitones
      const next = Math.round(clamp(raw, 0, 127))
      if (next !== raw) clampedNotes++
      if (next !== note.pitch) {
        note.pitch = next
        transposed++
      }
    }
    let message = `片段「${clip.name}」（${track.name}）已${semitones > 0 ? '升高' : '降低'} ${Math.abs(semitones)} 个半音，修改 ${transposed} 个音符`
    if (clampedNotes) message += `；其中 ${clampedNotes} 个音符超出 0..127 已压到边界`
    return withProjectResult(okResult(message, { clipId: clip.id, semitones, transposedNotes: transposed, clampedNotes }), project)
  },
}

/* --------------------------- 6. quantize_clip ------------------------------- */

export const quantizeClipTool: ToolDef = {
  name: 'quantize_clip',
  title: '片段量化',
  description:
    '把片段内音符起点吸附到网格（grid 单位是拍：0.25=十六分音符，0.5=八分音符，1=四分音符），strength 控制吸附强度 0..1，swing>0 让奇数格音符再后移一点获得摇摆感。适合修正生成/手写音符的节奏不齐。',
  parameters: toolSchema(
    {
      clipId: CLIP_ID,
      grid: num('网格（拍）0.0625..4，默认 0.25', { minimum: 0.0625, maximum: 4 }),
      strength: num('吸附强度 0..1（默认 1 = 完全吸附）', { minimum: 0, maximum: 1 }),
      swing: num('摇摆量 0..1（默认 0，仅影响奇数格）', { minimum: 0, maximum: 1 }),
    },
    ['clipId'],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return editsDisabled()
    const project = cloneProject(ctx.project)
    const found = findClipById(project, args.clipId)
    if (!found) return failResult(`找不到片段：${String(args.clipId)}（可用 get_project_summary 获取 clipId）`)
    const { clip } = found
    const grid = readNumber(args, 'grid', 0.0625, 4) ?? 0.25
    const strength = readNumber(args, 'strength', 0, 1) ?? 1
    const swing = readNumber(args, 'swing', 0, 1) ?? 0
    let changed = 0
    for (const note of clip.notes) {
      const slot = Math.round(note.start / grid)
      let target = slot * grid
      if (slot % 2 !== 0) target += swing * grid * 0.5
      const next = round6(Math.max(0, note.start + (target - note.start) * strength))
      if (Math.abs(next - note.start) > EPS) changed++
      note.start = next
    }
    fitClipLength(clip, beatsPerBar(project.timeSignature))
    return withProjectResult(
      okResult(
        `已按 ${formatBeats(grid)} 拍网格量化片段「${clip.name}」：${changed} 个音符起点微调` +
          `${strength < 1 ? `（强度 ${Math.round(strength * 100)}%）` : ''}${swing > 0 ? `（swing ${Math.round(swing * 100)}%）` : ''}`,
        { clipId: clip.id, grid, strength, swing, changedNotes: changed },
      ),
      project,
    )
  },
}

/* ---------------------------- 7. humanize_clip ------------------------------ */

export const humanizeClipTool: ToolDef = {
  name: 'humanize_clip',
  title: '片段人性化',
  description:
    '给片段加入细微的时序与力度随机偏差，让机械的生成结果更自然。timing 控制起点抖动（±timing*0.08 拍），velocity 控制力度抖动（±velocity*24）。seed 可复现同一结果。适合量化后仍想要「人味」的片段。',
  parameters: toolSchema(
    {
      clipId: CLIP_ID,
      timing: num('时序抖动 0..1（默认 0.2）', { minimum: 0, maximum: 1 }),
      velocity: num('力度抖动 0..1（默认 0.15）', { minimum: 0, maximum: 1 }),
      seed: int('随机种子（同 seed 同结果）'),
    },
    ['clipId'],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return editsDisabled()
    const project = cloneProject(ctx.project)
    const found = findClipById(project, args.clipId)
    if (!found) return failResult(`找不到片段：${String(args.clipId)}（可用 get_project_summary 获取 clipId）`)
    const { clip } = found
    const timing = readNumber(args, 'timing', 0, 1) ?? 0.2
    const velocity = readNumber(args, 'velocity', 0, 1) ?? 0.15
    const seed = readInt(args, 'seed', 0, 2 ** 31 - 1) ?? Math.floor(Math.random() * 2 ** 31)
    // 小型 LCG（Numerical Recipes 参数），保证同 seed 可复现
    let state = (seed >>> 0) || 0x9e3779b9
    const random = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state / 4294967296
    }
    for (const note of clip.notes) {
      const startDelta = (random() * 2 - 1) * timing * 0.08
      note.start = round6(Math.max(0, note.start + startDelta))
      const velocityDelta = Math.round((random() * 2 - 1) * velocity * 24)
      note.velocity = Math.round(clamp(note.velocity + velocityDelta, 1, 127))
    }
    fitClipLength(clip, beatsPerBar(project.timeSignature))
    return withProjectResult(
      okResult(
        `已对片段「${clip.name}」做人性化：${clip.notes.length} 个音符时序抖动 ±${round6(timing * 0.08)} 拍、力度抖动 ±${Math.round(velocity * 24)}（seed ${seed}，可复现）`,
        { clipId: clip.id, seed, timing, velocity, noteCount: clip.notes.length },
      ),
      project,
    )
  },
}

/* --------------------------- 8. scale_lock_clip ----------------------------- */

export const scaleLockClipTool: ToolDef = {
  name: 'scale_lock_clip',
  title: '音阶锁定',
  description:
    '把片段里不在音阶内的音符移到最近的音阶音（默认用工程调性，也可指定 key/scale），strength 控制移动比例。适合修正 AI 生成或手写旋律里的「跑调」音。鼓组轨道不适用。',
  parameters: toolSchema(
    {
      clipId: CLIP_ID,
      key: str(`目标调性（默认工程调性；可用：${KEY_VALUES.join(' / ')}）`),
      scale: str(`目标调式（默认工程调式；可用：${SCALE_IDS.join(' / ')}）`),
      strength: num('修正强度 0..1（默认 1 = 完全吸到音阶）', { minimum: 0, maximum: 1 }),
    },
    ['clipId'],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return editsDisabled()
    const project = cloneProject(ctx.project)
    const found = findClipById(project, args.clipId)
    if (!found) return failResult(`找不到片段：${String(args.clipId)}（可用 get_project_summary 获取 clipId）`)
    const { clip, track } = found
    if (track.kind === 'drum') {
      return failResult(`鼓组轨道「${track.name}」的片段不适用音阶锁定（鼓音高对应固定音色）。可对旋律/和弦/低音等乐器轨道使用。`)
    }
    const rawKey = readString(args, 'key')
    const key = rawKey ? normalizeKey(rawKey) : project.key
    if (!key) return failResult(`未知调性「${rawKey}」，可用：${KEY_VALUES.join(' / ')}（降号写法会自动转升号，如 Bb→A#）`)
    const rawScale = readString(args, 'scale')
    const scale: ScaleId | null = rawScale ? normalizeScale(rawScale) : project.scale
    if (!scale) return failResult(`未知调式「${rawScale}」，可用：${SCALE_IDS.join(' / ')}`)
    const strength = readNumber(args, 'strength', 0, 1) ?? 1
    let corrected = 0
    for (const note of clip.notes) {
      if (isInScale(note.pitch, key, scale)) continue
      const nearest = snapToScale(note.pitch, key, scale)
      const applied = Math.round((nearest - note.pitch) * strength)
      if (applied === 0) continue
      const next = Math.round(clamp(note.pitch + applied, 0, 127))
      if (next !== note.pitch) {
        note.pitch = next
        corrected++
      }
    }
    const scaleName = `${key} ${scaleLabel(scale)}`
    const message = corrected
      ? `已把片段「${clip.name}」中 ${corrected} / ${clip.notes.length} 个音符吸到 ${scaleName} 音阶内${strength < 1 ? `（强度 ${Math.round(strength * 100)}%）` : ''}`
      : `片段「${clip.name}」的音符都已在 ${scaleName} 音阶内，未改动`
    return withProjectResult(okResult(message, { clipId: clip.id, key, scale, correctedNotes: corrected, noteCount: clip.notes.length }), project)
  },
}

/* --------------------------- 9. velocity_curve ------------------------------ */

export const velocityCurveTool: ToolDef = {
  name: 'velocity_curve',
  title: '力度曲线',
  description:
    '按音符起点顺序重设片段力度，做出强弱起伏：accent=每拍重音/小节头更强（律动感）、crescendo=渐强、decrescendo=渐弱、flat=统一力度。minVelocity/maxVelocity 指定力度范围（1..127）。',
  parameters: toolSchema(
    {
      clipId: CLIP_ID,
      shape: enm('曲线形状', SHAPES),
      minVelocity: int('最弱力度 1..127（默认 40）', { minimum: 1, maximum: 127 }),
      maxVelocity: int('最强力度 1..127（默认 120）', { minimum: 1, maximum: 127 }),
    },
    ['clipId', 'shape'],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return editsDisabled()
    const project = cloneProject(ctx.project)
    const found = findClipById(project, args.clipId)
    if (!found) return failResult(`找不到片段：${String(args.clipId)}（可用 get_project_summary 获取 clipId）`)
    const { clip } = found
    const shape = readString(args, 'shape')
    if (!shape || !(SHAPES as readonly string[]).includes(shape)) {
      return failResult(`未知力度曲线形状「${shape ?? ''}」，可用：${SHAPES.join(' / ')}`)
    }
    let minVelocity = Math.round(readNumber(args, 'minVelocity', 1, 127) ?? 40)
    let maxVelocity = Math.round(readNumber(args, 'maxVelocity', 1, 127) ?? 120)
    let swappedNote = ''
    if (minVelocity > maxVelocity) {
      const swap = minVelocity
      minVelocity = maxVelocity
      maxVelocity = swap
      swappedNote = '（minVelocity 大于 maxVelocity，已自动对调）'
    }
    const notes = [...clip.notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch)
    if (notes.length === 0) return failResult(`片段「${clip.name}」没有音符，无法设置力度曲线`)
    const barBeats = beatsPerBar(project.timeSignature)
    const progress = (index: number): number => (notes.length === 1 ? 0.5 : index / (notes.length - 1))
    notes.forEach((note, index) => {
      let value: number
      if (shape === 'flat') {
        value = Math.round((minVelocity + maxVelocity) / 2)
      } else if (shape === 'crescendo') {
        value = Math.round(minVelocity + (maxVelocity - minVelocity) * progress(index))
      } else if (shape === 'decrescendo') {
        value = Math.round(minVelocity + (maxVelocity - minVelocity) * (1 - progress(index)))
      } else {
        const absolute = clip.startBeat + note.start
        const beatInBar = ((absolute % barBeats) + barBeats) % barBeats
        const distanceToBar = Math.min(beatInBar, barBeats - beatInBar)
        const distanceToBeat = Math.abs(beatInBar - Math.round(beatInBar))
        const weight = distanceToBar < 1 / 64 ? 1 : distanceToBeat < 1 / 64 ? 0.75 : 0.4
        value = Math.round(minVelocity + (maxVelocity - minVelocity) * weight)
      }
      note.velocity = Math.round(clamp(value, 1, 127))
    })
    return withProjectResult(
      okResult(
        `已按「${shape}」重设片段「${clip.name}」的 ${notes.length} 个音符力度（范围 ${minVelocity}–${maxVelocity}）${swappedNote}`,
        { clipId: clip.id, shape, minVelocity, maxVelocity, noteCount: notes.length },
      ),
      project,
    )
  },
}

/* --------------------------- 10. duplicate_track ---------------------------- */

export const duplicateTrackTool: ToolDef = {
  name: 'duplicate_track',
  title: '复制轨道',
  description:
    '深拷贝一条轨道（新轨道 / 片段 / 音符 id，音符与混音参数完全一致），插在原轨道之后。适合做「同一乐器再加一层」「复制鼓组做 double」。跨轨复制单个片段用 copy_clip。',
  parameters: toolSchema(
    {
      trackId: TRACK_ID,
      name: str('新轨道名称（默认「原名 副本」）'),
    },
    ['trackId'],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return editsDisabled()
    const project = cloneProject(ctx.project)
    const track = findTrackById(project, args.trackId)
    if (!track) return failResult(`找不到轨道：${String(args.trackId)}（可用 get_project_summary 获取 trackId）`)
    const index = project.tracks.indexOf(track)
    const copy: Track = deepClone(track)
    copy.id = newId('t')
    copy.name = readString(args, 'name') ?? `${track.name} 副本`
    for (const clip of copy.clips) {
      clip.trackId = copy.id
      clip.id = newId('c')
      clip.notes = clip.notes.map((note) => createNote(note.pitch, note.start, note.duration, note.velocity))
    }
    project.tracks.splice(index + 1, 0, copy)
    return withProjectResult(
      okResult(`已复制轨道「${track.name}」为「${copy.name}」（${copy.clips.length} 个片段），新 trackId=${copy.id}`, {
        trackId: copy.id,
        sourceTrackId: track.id,
        clips: copy.clips.length,
      }),
      project,
    )
  },
}

/* ----------------------------- 11. clear_track ------------------------------ */

export const clearTrackTool: ToolDef = {
  name: 'clear_track',
  title: '清空轨道',
  description:
    '删除轨道上的所有片段但保留轨道本身（乐器/音量/名称不变）。适合「重新排这条轨」前清场。想删整条轨道用 delete_track。',
  parameters: toolSchema({ trackId: TRACK_ID }, ['trackId']),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return editsDisabled()
    const project = cloneProject(ctx.project)
    const track = findTrackById(project, args.trackId)
    if (!track) return failResult(`找不到轨道：${String(args.trackId)}（可用 get_project_summary 获取 trackId）`)
    const removed = track.clips.length
    track.clips = []
    return withProjectResult(
      okResult(removed ? `已清空轨道「${track.name}」的 ${removed} 个片段（轨道本身保留）` : `轨道「${track.name}」本来就没有片段`, {
        trackId: track.id,
        removedClips: removed,
      }),
      project,
    )
  },
}

/* ------------------------------- 12. set_swing ------------------------------ */

export const setSwingTool: ToolDef = {
  name: 'set_swing',
  title: '设置摇摆',
  description: '设置工程级 swing（0..1，0=直拍，0.35 左右接近爵士摇摆）。影响后续智能片段生成与整体律动感；要对已有片段加摇摆可用 quantize_clip 的 swing 参数。',
  parameters: toolSchema({ swing: num('swing 0..1', { minimum: 0, maximum: 1 }) }, ['swing']),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return editsDisabled()
    const swing = readNumber(args, 'swing', 0, 1)
    if (swing === undefined) return failResult('请提供 0..1 的 swing')
    const project = cloneProject(ctx.project)
    project.swing = swing
    return withProjectResult(
      okResult(`工程 swing 已设置为 ${round6(swing)}${swing === 0 ? '（直拍）' : ''}`, { swing }),
      project,
    )
  },
}

/* --------------------------- 13. set_time_signature ------------------------- */

export const setTimeSignatureTool: ToolDef = {
  name: 'set_time_signature',
  title: '设置拍号',
  description:
    '设置工程拍号（numerator 1..16，denominator 2/4/8/16）。已有片段按「拍」保持原位（不会被拉伸），但每小节拍数变化会导致小节编号与段落位置改变；需要时再用 set_sections 重新对齐段落。',
  parameters: toolSchema(
    {
      numerator: int('每小节拍数分子 1..16', { minimum: 1, maximum: 16 }),
      denominator: int('拍号分母：2 / 4 / 8 / 16（默认沿用当前）', { enum: [2, 4, 8, 16] }),
    },
    ['numerator'],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return editsDisabled()
    const numerator = readInt(args, 'numerator', 1, 16)
    if (numerator === undefined) return failResult('请提供 numerator（1..16 的整数，每小节拍数）')
    const denominatorInput = readInt(args, 'denominator', 2, 16) ?? ctx.project.timeSignature.denominator
    if (!(DENOMINATORS as readonly number[]).includes(denominatorInput)) {
      return failResult(`拍号分母只能是 ${DENOMINATORS.join(' / ')}，收到 ${denominatorInput}`)
    }
    const project = cloneProject(ctx.project)
    const oldBarBeats = beatsPerBar(project.timeSignature)
    project.timeSignature = { numerator, denominator: denominatorInput }
    const barBeats = beatsPerBar(project.timeSignature)
    return withProjectResult(
      okResult(
        `拍号已改为 ${numerator}/${denominatorInput}（每小节 ${formatBeats(barBeats)} 拍，原来是 ${formatBeats(oldBarBeats)} 拍）。` +
          '已有片段按拍保持原位，小节编号/段落位置会随之变化，如有需要请用 set_sections 重新对齐段落。',
        { timeSignature: project.timeSignature, barBeats, oldBarBeats },
      ),
      project,
    )
  },
}

/* -------------------------------- 14. set_loop ------------------------------ */

export const setLoopTool: ToolDef = {
  name: 'set_loop',
  title: '设置循环区间',
  description: '开启/关闭工程循环播放，并设置循环起止拍（startBeat < endBeat）。缺省沿用当前区间或工程末尾。想播放/停止循环也可用 ui_action（toggle_loop）。',
  parameters: toolSchema(
    {
      enabled: bool('是否开启循环'),
      startBeat: num('循环起点（拍），默认沿用当前', { minimum: 0 }),
      endBeat: num('循环终点（拍），默认沿用当前', { minimum: 0 }),
    },
    ['enabled'],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return editsDisabled()
    const enabled = typeof args.enabled === 'boolean' ? args.enabled : undefined
    if (enabled === undefined) return failResult('请提供 enabled（true / false）')
    const project = cloneProject(ctx.project)
    const current = project.loop
    const barBeats = beatsPerBar(project.timeSignature)
    const explicitEnd = readNumber(args, 'endBeat', 0, 100000)
    const startBeat = round6(readNumber(args, 'startBeat', 0, 100000) ?? current.startBeat)
    // 缺省终点：沿用当前；若当前终点已经不在起点之后，则退到「工程末尾」（按小节取整）
    let endBeat = round6(explicitEnd ?? current.endBeat)
    if (explicitEnd === undefined && startBeat >= endBeat - EPS) {
      endBeat = Math.max(barBeats, Math.ceil(projectEndBeat(project) / barBeats) * barBeats)
    }
    if (startBeat >= endBeat - EPS) {
      return failResult(
        `循环起点必须小于终点：当前 startBeat=${formatBeats(startBeat)}、endBeat=${formatBeats(endBeat)}。` +
          '请用 startBeat / endBeat 指定一个有效区间（例如 0 到 16 拍），或传 endBeat 为工程末尾。',
      )
    }
    project.loop = { enabled, startBeat, endBeat }
    const bars = round6((endBeat - startBeat) / barBeats)
    return withProjectResult(
      okResult(
        enabled
          ? `已开启循环：${formatBeats(startBeat)}–${formatBeats(endBeat)} 拍（约 ${formatBeats(bars)} 小节）`
          : `已关闭循环（保留区间 ${formatBeats(startBeat)}–${formatBeats(endBeat)} 拍）`,
        { loop: project.loop },
      ),
      project,
    )
  },
}

/* --------------------------- 15. transpose_project -------------------------- */

export const transposeProjectTool: ToolDef = {
  name: 'transpose_project',
  title: '整体移调',
  description:
    '把整首工程移调（半音，-24..24）：默认所有非鼓轨音符移调、工程调性与和弦同步移调（updateKey=true）；鼓组默认跳过（includeDrums=true 才一起移，可能破坏鼓音色）。只想改一个片段用 transpose_clip。',
  parameters: toolSchema(
    {
      semitones: int('移调半音数 -24..24（正数升高）', { minimum: -24, maximum: 24 }),
      includeDrums: bool('是否连鼓组一起移调（默认 false）'),
      updateKey: bool('是否同步更新工程调性与和弦（默认 true）'),
    },
    ['semitones'],
  ),
  async handler(args, ctx) {
    if (!ctx.allowProjectEdits) return editsDisabled()
    const semitones = readInt(args, 'semitones', -24, 24)
    if (semitones === undefined) return failResult('请提供 semitones（-24..24 的整数半音数）')
    const includeDrums = args.includeDrums === true
    const updateKey = args.updateKey !== false
    const project = cloneProject(ctx.project)
    if (semitones === 0) {
      return withProjectResult(
        okResult('semitones=0，工程未做修改', { semitones: 0, transposedNotes: 0, skippedDrumTracks: 0, key: project.key }),
        project,
      )
    }
    let transposedNotes = 0
    let clampedNotes = 0
    let skippedDrumTracks = 0
    for (const track of project.tracks) {
      if (track.kind === 'drum' && !includeDrums) {
        skippedDrumTracks++
        continue
      }
      for (const clip of track.clips) {
        for (const note of clip.notes) {
          const raw = note.pitch + semitones
          const next = Math.round(clamp(raw, 0, 127))
          if (next !== raw) clampedNotes++
          if (next !== note.pitch) {
            note.pitch = next
            transposedNotes++
          }
        }
      }
    }
    let keyNote = ''
    let chordsTransposed = 0
    if (updateKey) {
      const oldKey = project.key
      const keys = [...KEYS] as string[]
      const index = keys.indexOf(oldKey)
      const nextIndex = (((index < 0 ? 0 : index) + semitones) % 12 + 12) % 12
      project.key = keys[nextIndex]
      for (const chord of project.chords) {
        chord.root = (((chord.root + semitones) % 12) + 12) % 12
        chordsTransposed++
      }
      keyNote = `；工程调性 ${oldKey} → ${project.key}${chordsTransposed > 0 ? `（${chordsTransposed} 个和弦同步移调）` : ''}`
    }
    let message =
      `全曲已移调 ${semitones > 0 ? '+' : ''}${semitones} 个半音：${transposedNotes} 个音符` +
      `${skippedDrumTracks > 0 ? `；跳过 ${skippedDrumTracks} 条鼓组轨道（如需鼓也移调可传 includeDrums=true）` : ''}` +
      `${clampedNotes > 0 ? `；${clampedNotes} 个音符超出 0..127 已压到边界` : ''}${keyNote}`
    return withProjectResult(
      okResult(message, {
        semitones,
        transposedNotes,
        clampedNotes,
        skippedDrumTracks,
        includeDrums,
        updateKey,
        key: project.key,
        chordsTransposed,
      }),
      project,
    )
  },
}

/** 编曲编辑类工具集合（在 index.ts 的 ALL_TOOLS 里排在 PROJECT_TOOLS 之后） */
export const EDIT_TOOLS: ToolDef[] = [
  copyClipTool,
  repeatSectionTool,
  splitClipTool,
  mergeClipsTool,
  transposeClipTool,
  quantizeClipTool,
  humanizeClipTool,
  scaleLockClipTool,
  velocityCurveTool,
  duplicateTrackTool,
  clearTrackTool,
  setSwingTool,
  setTimeSignatureTool,
  setLoopTool,
  transposeProjectTool,
]
