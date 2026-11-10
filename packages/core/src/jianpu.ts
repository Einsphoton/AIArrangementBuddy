/**
 * 简谱（numbered musical notation）导入（P7-D）。
 *
 * 支持常见子集：
 *   - 头信息：`1=C` / `1=D#`（调号）、`4/4`（拍号）、`♩=120` 或 `bpm=120`、`T: 标题`；
 *   - 音符：`1`–`7`（`#`/`b` 前缀升降号，`'`/`，`（或 `,`）八度点，可叠加）；
 *   - 时值：默认 1 拍（四分）；`/` 每多一个减半（`1/` 八分、`1//` 十六分）；`.` 附点 ×1.5；
 *   - `-` 延长上一个音 1 拍；`0` 休止；`~` 连音（与下一个同音高合并）；`|` 小节线；
 *   - 其他字符忽略并记 warning（不中断导入）。
 *
 * 输出一个可直接加载的工程（单条旋律轨 + 一个片段），旋律从第 0 拍开始。
 */
import type { ScaleId } from './constants.js'
import { projectSchema, type Project } from './model.js'

const MAJOR_OFFSETS = [0, 2, 4, 5, 7, 9, 11]
const MINOR_OFFSETS = [0, 2, 3, 5, 7, 8, 10]
const PITCH_CLASS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

export interface JianpuNote {
  degree: number
  pitch: number
  startBeat: number
  durationBeats: number
  rest: boolean
}

export interface JianpuParseResult {
  notes: JianpuNote[]
  warnings: string[]
  key: string
  scale: ScaleId
  timeSignature: { numerator: number; denominator: number }
  bpm?: number
  title?: string
  bars: number
  beatsPerBar: number
  totalBeats: number
}

export interface JianpuImportOptions {
  title?: string
  bpm?: number
  key?: string
  scale?: ScaleId
  baseOctave?: number
}

export interface JianpuImportResult {
  project: Project
  parse: JianpuParseResult
  summary: string
}

function parseKeyToken(raw: string): string | null {
  const match = /^([A-Ga-g])([#b]?)$/.exec(raw.trim())
  if (!match) return null
  const letter = match[1]!.toUpperCase()
  const accidental = match[2] ?? ''
  return `${letter}${accidental}`
}

function parseHeaderLine(line: string): Partial<JianpuParseResult> | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const keyMatch = /^1\s*=\s*(.+)$/.exec(trimmed)
  if (keyMatch) {
    const key = parseKeyToken(keyMatch[1]!) ?? null
    if (key) return { key }
  }
  const tsMatch = /^(\d{1,2})\s*\/\s*(\d{1,2})$/.exec(trimmed)
  if (tsMatch) {
    const numerator = Number(tsMatch[1])
    const denominator = Number(tsMatch[2])
    if (numerator >= 1 && numerator <= 16 && [2, 4, 8, 16].includes(denominator)) {
      return { timeSignature: { numerator, denominator } }
    }
  }
  const bpmMatch = /^(?:♩|bpm|BPM)\s*[=:]\s*(\d{2,3})$/.exec(trimmed)
  if (bpmMatch) {
    const bpm = Number(bpmMatch[1])
    if (bpm >= 20 && bpm <= 320) return { bpm }
  }
  const titleMatch = /^T\s*:\s*(.+)$/.exec(trimmed)
  if (titleMatch) return { title: titleMatch[1]!.trim() }
  return null
}

function durationFactor(token: string): { factor: number; dot: boolean } {
  let factor = 1
  let dot = false
  for (const char of token) {
    if (char === '/') factor /= 2
    else if (char === '.') dot = true
  }
  if (dot) factor *= 1.5
  return { factor, dot }
}

/**
 * 解析简谱文本（纯函数，不依赖工程）。
 * 无法识别的 token 忽略并写 warning；完全没有音符时抛错。
 */
export function parseJianpu(text: string, options: JianpuImportOptions = {}): JianpuParseResult {
  const lines = String(text ?? '').split(/\r?\n/)
  const warnings: string[] = []
  let key = options.key ?? 'C'
  let scale = options.scale ?? 'major'
  let timeSignature = { numerator: 4, denominator: 4 }
  let bpm = options.bpm
  let title = options.title

  const bodyLines: string[] = []
  for (const line of lines) {
    const header = parseHeaderLine(line)
    if (header) {
      if (header.key) key = header.key
      if (header.timeSignature) timeSignature = header.timeSignature
      if (header.bpm) bpm = header.bpm
      if (header.title) title = header.title
      continue
    }
    bodyLines.push(line)
  }

  const beatsPerBar = timeSignature.numerator
  const offsets = scale === 'minor' ? MINOR_OFFSETS : MAJOR_OFFSETS
  const rootPc = PITCH_CLASS[key[0]!.toUpperCase()] ?? 0
  const accidentalKey = key.slice(1) === '#' ? 1 : key.slice(1) === 'b' ? -1 : 0
  const baseOctave = options.baseOctave ?? 5

  const notes: JianpuNote[] = []
  let cursor = 0
  let bars = 0
  let tieNext = false

  // 空白/逗号/中文逗号都当分隔符；保留 '|' 作为独立 token
  const tokens = bodyLines
    .join(' ')
    .replace(/\|/g, ' | ')
    .split(/[\s，、]+/)
    .filter(Boolean)

  for (const rawToken of tokens) {
    if (rawToken === '|') {
      bars += 1
      continue
    }
    if (rawToken === '~') {
      tieNext = true
      continue
    }
    if (rawToken === '-') {
      const last = notes[notes.length - 1]
      if (last) {
        last.durationBeats += 1
        cursor += 1
      } else {
        warnings.push('开头的延音线「-」没有可延长的音符，已忽略')
      }
      continue
    }

    // 解析：可选升降号 + 数字 + 八度点 + 时值后缀 (+ 连音 ~)
    const match = /^([#b]?)([0-7])((?:['’，,]*))([/.]*)(~?)$/.exec(rawToken)
    if (!match) {
      warnings.push(`无法识别「${rawToken}」，已跳过`)
      continue
    }
    const accidental = match[1] === '#' ? 1 : match[1] === 'b' ? -1 : 0
    const degree = Number(match[2])
    const octaveMarks = match[3] ?? ''
    const durationToken = match[4] ?? ''
    const tie = match[5] === '~'
    const { factor } = durationFactor(durationToken)
    const durationBuffered = cursor

    if (degree === 0) {
      const duration = factor
      cursor += duration
      if (tieNext) tieNext = false
      continue
    }

    let octave = baseOctave
    for (const mark of octaveMarks) octave += mark === ',' || mark === '，' ? -1 : 1
    const semitone = offsets[degree - 1] ?? 0
    const pitch = 12 * (octave + 1) + rootPc + accidentalKey + semitone + accidental
    if (pitch < 0 || pitch > 127) {
      warnings.push(`音高越界「${rawToken}」（${pitch}），已跳过`)
      continue
    }

    const duration = factor
    if (tieNext) {
      const last = notes[notes.length - 1]
      if (last && last.pitch === pitch && !last.rest) {
        last.durationBeats += duration
        cursor += duration
        tieNext = tie
        continue
      }
      tieNext = false
    }

    notes.push({ degree, pitch, startBeat: durationBuffered, durationBeats: duration, rest: false })
    cursor += duration
    tieNext = tie
  }

  const totalBeats = notes.reduce((max, note) => Math.max(max, note.startBeat + note.durationBeats), 0)
  if (notes.length === 0) throw new Error('简谱里没有可用音符（需要 1–7 数字，0 为休止）')
  if (bars === 0) bars = Math.max(1, Math.ceil(totalBeats / beatsPerBar))

  return {
    notes,
    warnings,
    key,
    scale,
    timeSignature,
    bpm,
    title,
    bars: Math.max(1, bars),
    beatsPerBar,
    totalBeats: Math.max(totalBeats, bars * beatsPerBar),
  }
}

/**
 * 解析简谱并生成一个可直接加载的工程（单条旋律轨 + 一个片段，从第 0 拍开始）。
 * 标题/调号/拍号/BPM 可来自简谱头信息，也可用 options 覆盖。
 */
export function jianpuToProject(text: string, options: JianpuImportOptions = {}): JianpuImportResult {
  const parse = parseJianpu(text, options)
  const now = Date.now()
  const bars = parse.bars
  const lengthBeats = bars * parse.beatsPerBar
  const trackId = 'track_jianpu_melody'
  const clipId = 'clip_jianpu_melody'

  const project = projectSchema.parse({
    id: `jianpu_${now.toString(36)}`,
    name: parse.title || options.title || '简谱导入',
    version: 2,
    tempo: parse.bpm ?? options.bpm ?? 110,
    timeSignature: parse.timeSignature,
    key: parse.key,
    scale: parse.scale,
    swing: 0,
    masterVolume: 0.9,
    tracks: [
      {
        id: trackId,
        name: '简谱旋律',
        color: '#7f9cf5',
        kind: 'instrument',
        instrumentId: 'piano.grand',
        emotionId: 'clear',
        gmProgram: 0,
        engine: 'auto',
        volume: 0.85,
        pan: 0,
        mute: false,
        solo: false,
        reverbSend: 0.2,
        delaySend: 0.05,
        octaveShift: 0,
        clips: [
          {
            id: clipId,
            trackId,
            name: '简谱旋律',
            color: '#7f9cf5',
            startBeat: 0,
            lengthBeats: Math.max(0.25, lengthBeats),
            notes: parse.notes.map((note, index) => ({
              id: `n_${clipId}_${index}`,
              pitch: note.pitch,
              start: note.startBeat,
              duration: Math.max(1 / 64, note.durationBeats),
              velocity: 92,
            })),
            muted: false,
          },
        ],
        audioClips: [],
      },
    ],
    sections: [{ id: 'sec_jianpu', name: '旋律', startBar: 0, bars, energy: 0.5 }],
    chords: [],
    assets: [],
    analyses: [],
    loop: { enabled: false, startBeat: 0, endBeat: lengthBeats },
    createdAt: now,
    updatedAt: now,
  }) as unknown as Project

  return {
    project,
    parse,
    summary: `已导入简谱：${parse.notes.length} 个音 · ${bars} 小节 · ${parse.key} ${parse.scale} · ${project.tempo} BPM${
      parse.warnings.length > 0 ? `（${parse.warnings.length} 条警告）` : ''
    }`,
  }
}