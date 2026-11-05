/** 乐理查询工具（只读，不修改工程）。 */
import {
  CHORDS,
  NOTE_NAMES_SHARP,
  PROGRESSION_PRESETS,
  SCALES,
  beatsPerBar,
  chordPitches,
  detectKey,
  getInstrument,
  harmonizeMelody,
  invertChord,
  listInstruments,
  progressionToChords,
  romanToChord,
  scalePitches,
  type ChordQualityId,
  type NoteEvent,
  type ScaleId,
} from '@aiab/core'
import { enm, int, num, str, toolSchema, type ToolDef, type ToolResult } from './schema.js'
import { parseNoteList, readNumber, readString } from './project.js'
import { normalizeKey, normalizeQuality, normalizeRoot, normalizeScale, normalizeTheoryQuery } from './validate.js'
import { scaleLabel } from './summary.js'

const QUERIES = ['scale', 'chord', 'progression', 'inversion', 'detect', 'harmonize', 'roman', 'instrument', 'list_instruments'] as const

function noteName(pitch: number): string {
  return `${NOTE_NAMES_SHARP[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`
}

function parseScale(value: unknown, fallback: ScaleId = 'major'): ScaleId {
  return normalizeScale(value) ?? fallback
}

function parseKey(value: unknown, fallback = 'C'): string {
  return normalizeKey(value) ?? fallback
}

function parseQuality(value: unknown, fallback: ChordQualityId = 'maj'): ChordQualityId {
  return normalizeQuality(value) ?? fallback
}

function rootPitchClass(value: unknown, fallback = 0): number {
  return normalizeRoot(value) ?? fallback
}

export const musicTheoryTool: ToolDef = {
  name: 'music_theory',
  title: '乐理查询',
  readOnly: true,
  description:
    '查询乐理信息（不修改工程）：scale=音阶音高、chord=和弦构成、progression=罗马数字进行、inversion=转位、detect=识别调性、harmonize=为旋律配和声、instrument=乐器信息、list_instruments=乐器目录。query 也接受常见别名（scale_notes→scale、instruments→list_instruments、notes→scale、chords→chord）；quality / key / scale 会自动归一化（major/m/M、Bb、小调五声 等）。',
  parameters: toolSchema(
    {
      query: enm('查询类型', QUERIES),
      key: str('调性 / 根音（如 C、F#、Bb）'),
      root: str('根音（音名 C/F#/Bb 或 0..11；chord/inversion 用）'),
      scale: str('调式（major/minor/dorian/lydian/mixolydian/pentatonicMinor/blues 等）'),
      quality: str('和弦性质（maj/min/dim/aug/sus4/dom7/maj7/min7/m7b5 等）'),
      roman: str('罗马数字（roman 查询用，如 "V7"）'),
      inversion: int('转位序号 0..3', { minimum: 0, maximum: 3 }),
      octave: int('八度 0..8', { minimum: 0, maximum: 8 }),
      beats: num('每个和弦的持续拍数（progression 用）', { minimum: 0.25, maximum: 32 }),
      romans: {
        type: 'array',
        description: '罗马数字进行，如 ["I","V","vi","IV"]',
        items: { type: 'string' },
      },
      notes: {
        type: 'array',
        description: '音符列表（detect/harmonize 用），pitch 为 MIDI 音高',
        items: {
          type: 'object',
          properties: {
            pitch: { type: 'integer' },
            start: { type: 'number' },
            duration: { type: 'number' },
            velocity: { type: 'integer' },
          },
        },
      },
      instrumentId: str('乐器 id（instrument 查询用）'),
      family: str('乐器家族过滤：classical/rock/electronic/world/drums'),
    },
    ['query'],
  ),
  async handler(args, ctx): Promise<ToolResult> {
    const rawQuery = readString(args, 'query')
    const query = (rawQuery ? normalizeTheoryQuery(rawQuery) : 'scale') ?? 'scale'
    const key = parseKey(args.key ?? (args as Record<string, unknown>).root, ctx.project.key)
    const scale = parseScale(args.scale ?? ctx.project.scale, ctx.project.scale)
    const octave = Math.round(readNumber(args, 'octave', 0, 8) ?? 4)
    const quality = parseQuality(args.quality)

    if (query === 'scale') {
      const pitches = scalePitches(key, scale, octave)
      const intervals = SCALES[scale]?.intervals ?? []
      const message = `${key} ${scaleLabel(scale)}：${pitches.map(noteName).join(' ')}（音程 ${intervals.join(' ')}）`
      return {
        ok: true,
        message,
        data: { key, scale, type: SCALES[scale]?.name ?? scale, intervals, pitches, noteNames: pitches.map(noteName) },
      }
    }

    if (query === 'chord') {
      const root = rootPitchClass(args.root ?? key, 0)
      const chord = { root, quality, beats: 4 }
      const pitches = chordPitches(chord, octave)
      const definition = CHORDS[quality]
      return {
        ok: true,
        message: `${NOTE_NAMES_SHARP[root]}${definition.symbol}（${definition.name}）：${pitches.map(noteName).join(' ')}（音程 ${definition.intervals.join(' ')}）`,
        data: {
          symbol: `${NOTE_NAMES_SHARP[root]}${definition.symbol}`,
          name: definition.name,
          intervals: definition.intervals,
          pitches,
          noteNames: pitches.map(noteName),
        },
      }
    }

    if (query === 'progression') {
      const romans = Array.isArray(args.romans) ? args.romans.filter((item): item is string => typeof item === 'string') : []
      const beats = readNumber(args, 'beats', 0.25, 32) ?? 4
      const chords = romans.length ? progressionToChords(romans, key, scale, beats) : []
      if (chords.length === 0) {
        const preset = PROGRESSION_PRESETS.find((item) => item.styles.includes('pop')) ?? PROGRESSION_PRESETS[0]
        const fallback = preset?.romans ?? ['I', 'V', 'vi', 'IV']
        const fallbackChords = progressionToChords(fallback, key, scale, beats)
        return {
          ok: true,
          message: `未提供 romans，返回常用进行 ${fallback.join(' - ')}（${key} ${scaleLabel(scale)}）：${fallbackChords.map((chord) => `${NOTE_NAMES_SHARP[chord.root]}${CHORDS[chord.quality].symbol}`).join(' - ')}`,
          data: { key, scale, romans: fallback, chords: fallbackChords },
        }
      }
      const labels = chords.map((chord) => `${NOTE_NAMES_SHARP[chord.root]}${CHORDS[chord.quality].symbol}`)
      return {
        ok: true,
        message: `进行 ${romans.join(' - ')} 在 ${key} ${scaleLabel(scale)}：${labels.join(' - ')}`,
        data: { key, scale, romans, chords, labels },
      }
    }

    if (query === 'inversion') {
      const root = rootPitchClass(args.root ?? key, 0)
      const base = chordPitches({ root, quality, beats: 4 }, octave)
      const inversion = Math.round(readNumber(args, 'inversion', 0, 3) ?? 0)
      const voiced = invertChord(base, inversion)
      return {
        ok: true,
        message: `${NOTE_NAMES_SHARP[root]}${CHORDS[quality].symbol} 第 ${inversion} 转位：${voiced.map(noteName).join(' ')}`,
        data: { root, quality, inversion, pitches: voiced, noteNames: voiced.map(noteName) },
      }
    }

    if (query === 'detect') {
      const notes = parseNoteList(args.notes)
      if (notes.length === 0) return { ok: false, message: 'detect 需要提供 notes（pitch 列表）' }
      const result = detectKey(notes as NoteEvent[])
      return {
        ok: true,
        message: `识别结果：${result.key} ${scaleLabel(result.scale)}（置信度 ${(result.confidence * 100).toFixed(0)}%）`,
        data: result,
      }
    }

    if (query === 'harmonize') {
      const notes = parseNoteList(args.notes)
      if (notes.length === 0) return { ok: false, message: 'harmonize 需要提供 notes' }
      const barBeats = beatsPerBar(ctx.project.timeSignature)
      const end = notes.reduce((max, note) => Math.max(max, note.start + note.duration), 0)
      const bars = Math.max(1, Math.ceil(end / barBeats))
      const chords = harmonizeMelody(notes as NoteEvent[], key, scale, barBeats, bars * barBeats)
      const labels = chords.map((chord) => `${NOTE_NAMES_SHARP[chord.root]}${CHORDS[chord.quality].symbol}`)
      return {
        ok: true,
        message: `为 ${notes.length} 个音符配和声（${key} ${scaleLabel(scale)}）：${labels.join(' - ')}`,
        data: { key, scale, chords, labels },
      }
    }

    if (query === 'instrument') {
      const instrumentId = readString(args, 'instrumentId')
      if (!instrumentId) return { ok: false, message: 'instrument 查询需要 instrumentId' }
      try {
        const instrument = getInstrument(instrumentId)
        return {
          ok: true,
          message: `${instrument.name}（${instrument.nameEn}，${instrument.family}，GM ${instrument.gmProgram}）：情绪预设 ${instrument.emotions.map((emotion) => emotion.id).join(' / ')}`,
          data: {
            id: instrument.id,
            name: instrument.name,
            nameEn: instrument.nameEn,
            family: instrument.family,
            gmProgram: instrument.gmProgram,
            isDrumKit: instrument.isDrumKit,
            range: instrument.range,
            emotions: instrument.emotions.map((emotion) => ({ id: emotion.id, name: emotion.name, nameEn: emotion.nameEn, hint: emotion.hint })),
          },
        }
      } catch {
        return { ok: false, message: `未知乐器：${instrumentId}` }
      }
    }

    if (query === 'list_instruments') {
      const family = readString(args, 'family')
      const instruments = listInstruments(family as Parameters<typeof listInstruments>[0])
      const lines = instruments.map((instrument) => `${instrument.id}（${instrument.name}·${instrument.family}）`)
      return {
        ok: true,
        message: `共 ${instruments.length} 个乐器：${lines.slice(0, 40).join('、')}${lines.length > 40 ? ' …' : ''}`,
        data: instruments.map((instrument) => ({
          id: instrument.id,
          name: instrument.name,
          family: instrument.family,
          gmProgram: instrument.gmProgram,
          emotions: instrument.emotions.map((emotion) => emotion.id),
        })),
      }
    }

    if (query === 'roman') {
      const roman = readString(args, 'roman')
      if (!roman) return { ok: false, message: 'roman 查询需要 roman 参数' }
      const chord = romanToChord(roman, key, scale, 4)
      if (!chord) return { ok: false, message: `无法解析罗马数字：${roman}` }
      return {
        ok: true,
        message: `${roman} 在 ${key} ${scaleLabel(scale)} = ${NOTE_NAMES_SHARP[chord.root]}${CHORDS[chord.quality].symbol}`,
        data: chord,
      }
    }

    return { ok: false, message: `未知查询类型：${query}` }
  },
}

export const THEORY_TOOLS: ToolDef[] = [musicTheoryTool]
