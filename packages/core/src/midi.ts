/**
 * 标准 MIDI 文件（SMF format 1）导出器。
 * 零依赖实现，前后端都可用：客户端导出下载，服务端导出返回文件流。
 */
import {
  beatsPerBar,
  createClip,
  createEmptyProject,
  createNote,
  createTrack,
  newId,
  projectSchema,
  type NoteEvent,
  type Project,
  type Track,
} from './model.js'
import { keyToPitchClass, SCALES, type ScaleId } from './constants.js'
import { findInstrumentByProgram, getInstrument } from './instruments/index.js'
import { detectKey } from './theory.js'
import { buildSections } from './arrange.js'

const PPQ = 480
const DRUM_CHANNEL = 9

/* ---------------------------- 变长数量编码 ---------------------------- */

function vlq(value: number): number[] {
  const v = Math.max(0, Math.round(value))
  const out = [v & 0x7f]
  let rest = v >>> 7
  while (rest > 0) {
    out.unshift((rest & 0x7f) | 0x80)
    rest >>>= 7
  }
  return out
}

function u16(v: number): number[] {
  return [(v >>> 8) & 0xff, v & 0xff]
}

function u32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
}

function textBytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text))
}

interface RawEvent {
  tick: number
  /** 排序优先级：0 = meta/控制，1 = note off，2 = note on */
  priority: number
  bytes: number[]
}

function metaEvent(type: number, data: number[]): number[] {
  return [0xff, type, ...vlq(data.length), ...data]
}

/* ---------------------------- 主函数 ---------------------------- */

export interface MidiExportOptions {
  /** 是否在导出时把工程从第 0 拍开始整体平移 */
  normalizeStart?: boolean
  /** 每轨单独一个 MTrk（默认 true）；false 时全部合并到一个轨道 */
  separateTracks?: boolean
}

/** 工程 -> MIDI 字节 */
export function projectToMidiBytes(project: Project, options: MidiExportOptions = {}): Uint8Array {
  const { separateTracks = true, normalizeStart = true } = options
  const tracks = project.tracks.filter((t) => !t.mute && t.clips.length > 0)
  const anySolo = project.tracks.some((t) => t.solo)
  const active = anySolo ? tracks.filter((t) => t.solo) : tracks

  const chorusTrack: RawEvent[] = []
  const barBeats = beatsPerBar(project.timeSignature)
  const meter = getMeter(project)
  chorusTrack.push({ tick: 0, priority: 0, bytes: metaEvent(0x51, tempoBytes(project.tempo)) })
  chorusTrack.push({ tick: 0, priority: 0, bytes: metaEvent(0x58, [...meter, 24, 8]) })
  const keySig = keySignatureBytes(project.key, project.scale)
  if (keySig) chorusTrack.push({ tick: 0, priority: 0, bytes: metaEvent(0x59, keySig) })
  chorusTrack.push({ tick: 0, priority: 0, bytes: metaEvent(0x03, textBytes(project.name || 'Untitled')) })

  // 段落标记
  for (const section of project.sections) {
    const tick = Math.round(section.startBar * barBeats * PPQ)
    chorusTrack.push({ tick, priority: 0, bytes: metaEvent(0x06, textBytes(section.name)) })
  }

  const trackChunks: number[][] = []
  let channelCursor = 0
  for (const track of active) {
    if (track.kind === 'drum') {
      channelCursor = channelCursor % 16
    }
    const channel = track.kind === 'drum' ? DRUM_CHANNEL : nextChannel(channelCursor)
    if (track.kind !== 'drum') channelCursor++

    const events: RawEvent[] = []
    events.push({ tick: 0, priority: 0, bytes: metaEvent(0x03, textBytes(track.name)) })
    const inst = getInstrument(track.instrumentId)
    const program = Math.max(0, Math.min(127, track.gmProgram || inst.gmProgram))
    if (track.kind !== 'drum') events.push({ tick: 0, priority: 0, bytes: [0xc0 | channel, program] })
    events.push({ tick: 0, priority: 0, bytes: [0xb0 | channel, 7, clamp7(track.volume * 100)] })
    events.push({ tick: 0, priority: 0, bytes: [0xb0 | channel, 10, clamp7((track.pan + 1) * 63.5)] })
    events.push({ tick: 0, priority: 0, bytes: [0xb0 | channel, 91, clamp7(track.reverbSend * 127)] })
    events.push({ tick: 0, priority: 0, bytes: [0xb0 | channel, 93, clamp7(track.delaySend * 127)] })

    for (const clip of track.clips) {
      if (clip.muted) continue
      for (const note of clip.notes) {
        const absStart = clip.startBeat + note.start
        const startBeat = normalizeStart ? absStart : absStart
        const startTick = Math.round(startBeat * PPQ)
        const endTick = Math.round((startBeat + note.duration) * PPQ)
        const pitch = Math.max(0, Math.min(127, Math.round(note.pitch + track.octaveShift * 12)))
        const velocity = Math.max(1, Math.min(127, Math.round(note.velocity)))
        events.push({ tick: startTick, priority: 2, bytes: [0x90 | channel, pitch, velocity] })
        events.push({ tick: Math.max(startTick + 1, endTick), priority: 1, bytes: [0x80 | channel, pitch, 0] })
      }
    }
    events.sort((a, b) => a.tick - b.tick || a.priority - b.priority)
    trackChunks.push(encodeTrack(events))
  }

  const chunks: number[][] = [encodeTrack(chorusTrack)]
  if (separateTracks) {
    chunks.push(...trackChunks)
  } else if (trackChunks.length) {
    // 合并：直接拼接事件体（简单做法，保留各轨 delta 会导致时间错位，故此处不推荐）
    chunks.push(...trackChunks)
  }

  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, ...u16(1), ...u16(chunks.length), ...u16(PPQ)]
  const body = chunks.flat()
  return new Uint8Array([...header, ...body])
}

function encodeTrack(events: RawEvent[]): number[] {
  const sorted = [...events].sort((a, b) => a.tick - b.tick || a.priority - b.priority)
  const out: number[] = []
  let lastTick = 0
  for (const ev of sorted) {
    out.push(...vlq(ev.tick - lastTick))
    out.push(...ev.bytes)
    lastTick = ev.tick
  }
  out.push(0, 0xff, 0x2f, 0)
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(out.length), ...out]
}

function nextChannel(cursor: number): number {
  let ch = cursor % 16
  if (ch === DRUM_CHANNEL) ch = (ch + 1) % 16
  return ch
}

function clamp7(v: number): number {
  return Math.max(0, Math.min(127, Math.round(v)))
}

function tempoBytes(bpm: number): number[] {
  const micros = Math.round(60000000 / Math.max(20, Math.min(320, bpm)))
  return u32(micros).slice(1)
}

function getMeter(project: Project): [number, number] {
  const { numerator, denominator } = project.timeSignature
  const denPow = Math.round(Math.log2(denominator))
  return [numerator, denPow]
}

/** 调号 meta：sf 为 -7..7 的升降号数，mi 0 大调 1 小调；无法表达时返回 null */
function keySignatureBytes(key: string, scale: string): number[] | null {
  const pc = keyToPitchClass(key)
  const majorCircle = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]
  const idx = majorCircle.indexOf(pc)
  if (idx === -1) return null
  let sf = idx <= 6 ? idx : idx - 12
  const isMinor = scale === 'minor' || scale === 'harmonicMinor' || scale === 'melodicMinor'
  if (isMinor) sf -= 3
  if (sf < -7 || sf > 7) sf = Math.max(-7, Math.min(7, sf))
  return [((sf & 0xff) << 24) >> 24, isMinor ? 1 : 0].map((n) => n & 0xff)
}

/** 导出为可下载的 Blob（浏览器端） */
export function projectToMidiBlob(project: Project): Blob {
  const bytes = projectToMidiBytes(project)
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return new Blob([buffer], { type: 'audio/midi' })
}

/** 直接触发浏览器下载 */
export function downloadMidi(project: Project, filename?: string): void {
  const blob = projectToMidiBlob(project)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename ?? `${project.name || 'project'}.mid`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** 计算工程时长（秒），用于音频导出 */
export function projectDurationSeconds(project: Project): number {
  let endBeat = 0
  for (const track of project.tracks) {
    for (const clip of track.clips) endBeat = Math.max(endBeat, clip.startBeat + clip.lengthBeats)
  }
  return (endBeat / project.tempo) * 60 + 2
}

/* ------------------------------------------------------------------ */
/* SMF 解析（MIDI 导入）                                                */
/* ------------------------------------------------------------------ */

/** 导入时长上限（秒）：超过 5 分钟的文件直接拒绝，避免把浏览器拖死 */
const MAX_IMPORT_SECONDS = 5 * 60
/** 音符最小时值（拍），与 noteEventSchema 的 1/64 下限一致 */
const MIN_NOTE_BEATS = 1 / 64
/** 导入轨道的配色（按通道出现顺序循环取用） */
const IMPORT_TRACK_COLORS = ['#7f9cf5', '#f472b6', '#3ddbd9', '#d4a95c', '#a3b86c', '#e0562a', '#a97bd6', '#c9a227']

export interface MidiImportOptions {
  /** 工程名；缺省时优先用文件里的序列名（首个没有音符的轨道名），再退回「导入的 MIDI」 */
  name?: string
}

export interface MidiImportSummary {
  /** 导入后的轨道数（一个 MIDI 通道一条轨道，鼓通道单独成轨） */
  tracks: number
  /** 音符总数 */
  notes: number
  /** 工程 BPM（取文件里第一个 tempo 事件；没有 tempo 事件时为 MIDI 默认的 120） */
  tempo: number
  key: string
  scale: ScaleId
  /** SMF 格式：0 或 1 */
  format: number
}

export interface MidiImportResult {
  project: Project
  summary: MidiImportSummary
}

interface ParsedNote {
  channel: number
  pitch: number
  velocity: number
  startTick: number
  endTick: number
}

interface OpenNote {
  channel: number
  pitch: number
  velocity: number
  startTick: number
}

interface ParsedChunkInfo {
  name: string
  /** 该块里出现过 Note On 的通道（用于给「按通道分轨」的轨道取名） */
  channels: Set<number>
}

interface ParsedMidiFile {
  format: number
  ppq: number
  tempo: number
  timeSignature: { numerator: number; denominator: number }
  notes: ParsedNote[]
  chunkInfos: ParsedChunkInfo[]
  programs: Map<number, number>
}

/** 顺序读取字节的小工具；越界统一抛可读中文错误 */
class MidiByteReader {
  private pos = 0

  constructor(private readonly bytes: Uint8Array) {}

  get offset(): number {
    return this.pos
  }

  get remaining(): number {
    return this.bytes.byteLength - this.pos
  }

  u8(): number {
    if (this.pos >= this.bytes.byteLength) throw new Error('MIDI 文件不完整：数据意外结束')
    return this.bytes[this.pos++]
  }

  u16(): number {
    return (this.u8() << 8) | this.u8()
  }

  u32(): number {
    return ((this.u16() << 16) | this.u16()) >>> 0
  }

  /** 变长数量（VLQ）：最多 4 字节，遇到非法编码抛错 */
  vlq(): number {
    let value = 0
    for (let i = 0; i < 4; i++) {
      const byte = this.u8()
      value = (value << 7) | (byte & 0x7f)
      if ((byte & 0x80) === 0) return value
    }
    throw new Error('MIDI 文件损坏：变长数值（VLQ）超过 4 字节')
  }

  slice(length: number): Uint8Array {
    if (length < 0 || this.pos + length > this.bytes.byteLength) {
      throw new Error(`MIDI 文件不完整：需要 ${length} 字节，但只剩 ${this.remaining} 字节`)
    }
    const out = this.bytes.subarray(this.pos, this.pos + length)
    this.pos += length
    return out
  }

  ascii(length: number): string {
    const data = this.slice(length)
    let out = ''
    for (let i = 0; i < data.length; i++) out += String.fromCharCode(data[i])
    return out
  }

  skip(length: number): void {
    this.slice(length)
  }
}

/** 解码 MIDI 文本：优先 UTF-8，失败回落 latin1（老 MIDI 常见 Shift-JIS，这里不做猜测） */
function decodeMidiText(data: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/\u0000+$/g, '').trim()
  } catch {
    return new TextDecoder('latin1').decode(data).replace(/\u0000+$/g, '').trim()
  }
}

/** 拍数保留 6 位小数，避免 tick/PPQ 浮点噪声落进工程快照 */
function roundBeat(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/** 关闭一个未释放的音符（同一通道同一音高按先进先出配对） */
function closeOpenNote(
  openNotes: Map<string, OpenNote[]>,
  notes: ParsedNote[],
  channel: number,
  pitch: number,
  endTick: number,
): void {
  const key = `${channel}:${pitch}`
  const list = openNotes.get(key)
  if (!list || list.length === 0) return
  const open = list.shift()!
  if (list.length === 0) openNotes.delete(key)
  notes.push({
    channel,
    pitch,
    velocity: open.velocity,
    startTick: open.startTick,
    endTick: Math.max(open.startTick + 1, endTick),
  })
}

/** 解析 SMF 字节：只做结构解析，不做工程映射 */
function parseMidiFile(bytes: Uint8Array): ParsedMidiFile {
  if (!bytes || bytes.byteLength === 0) throw new Error('MIDI 文件为空：没有可读取的内容')
  const reader = new MidiByteReader(bytes)
  if (reader.remaining < 14) throw new Error('不是合法的 MIDI 文件：文件太小（不足 14 字节）')
  if (reader.ascii(4) !== 'MThd') throw new Error('不是合法的 MIDI 文件：缺少 MThd 文件头')
  const headerLength = reader.u32()
  if (headerLength < 6) throw new Error('不是合法的 MIDI 文件：MThd 文件头长度小于 6 字节')
  const format = reader.u16()
  const declaredTracks = reader.u16()
  const division = reader.u16()
  if (format !== 0 && format !== 1) {
    throw new Error(`不支持的 MIDI 格式：SMF format ${format}（仅支持 format 0 / 1）`)
  }
  if (headerLength > 6) reader.skip(headerLength - 6)
  if ((division & 0x8000) !== 0) throw new Error('暂不支持 SMPTE 时间码的 MIDI 文件（division 最高位为 1）')
  const ppq = division & 0x7fff
  if (ppq === 0) throw new Error('不是合法的 MIDI 文件：每四分音符 Tick 数（PPQ）为 0')

  let tempo = 0
  let timeSignature: { numerator: number; denominator: number } | null = null
  const notes: ParsedNote[] = []
  const chunkInfos: ParsedChunkInfo[] = []
  const programs = new Map<number, number>()
  let parsedChunks = 0

  while (reader.remaining > 0) {
    // 文件尾部允许补零填充（部分工具会这么干）
    if (reader.remaining < 8) {
      reader.skip(reader.remaining)
      break
    }
    const chunkId = reader.ascii(4)
    const chunkLength = reader.u32()
    if (chunkLength > reader.remaining) {
      throw new Error(
        `MIDI 文件不完整：${chunkId === 'MTrk' ? 'MTrk 轨道块' : `「${chunkId}」块`}声明 ${chunkLength} 字节，但实际只剩 ${reader.remaining} 字节`,
      )
    }
    const chunkEnd = reader.offset + chunkLength
    if (chunkId !== 'MTrk') {
      reader.skip(chunkLength)
      continue
    }
    parsedChunks++

    let tick = 0
    // running status 在每个 MTrk 块内独立；SMF 里 meta / sysex 事件之后仍可继续复用
    let runningStatus = 0
    let chunkName = ''
    const chunkChannels = new Set<number>()
    const openNotes = new Map<string, OpenNote[]>()
    let endOfTrack = false

    while (!endOfTrack && reader.offset < chunkEnd) {
      tick += reader.vlq()
      if (reader.offset >= chunkEnd) throw new Error('MIDI 文件损坏：轨道事件在 delta 之后意外结束')
      const firstByte = reader.u8()

      // 元事件：FF type VLQ-length data
      if (firstByte === 0xff) {
        const metaType = reader.u8()
        const metaLength = reader.vlq()
        if (reader.offset + metaLength > chunkEnd) throw new Error('MIDI 文件损坏：元事件长度越过轨道块边界')
        const metaData = reader.slice(metaLength)
        if (metaType === 0x2f) {
          endOfTrack = true
          continue
        }
        if (metaType === 0x51 && metaLength === 3) {
          const microsPerQuarter = (metaData[0] << 16) | (metaData[1] << 8) | metaData[2]
          // 取第一个 tempo 事件；工程模型一个工程只能有一个 BPM
          if (tempo === 0 && microsPerQuarter > 0) {
            const bpm = 60_000_000 / microsPerQuarter
            tempo = Math.round(Math.max(20, Math.min(320, bpm)) * 100) / 100
          }
          continue
        }
        if (metaType === 0x58 && metaLength >= 2) {
          const numerator = metaData[0]
          const denominatorPow = metaData[1]
          // 工程只支持 1..16 / 1..16 的拍号，超出范围时忽略
          if (timeSignature === null && numerator >= 1 && numerator <= 16 && denominatorPow <= 4) {
            timeSignature = { numerator, denominator: 2 ** denominatorPow }
          }
          continue
        }
        if (metaType === 0x03) {
          chunkName = decodeMidiText(metaData)
          continue
        }
        continue
      }

      // SysEx：F0 / F7 + VLQ 长度 + 数据（跳过）
      if (firstByte === 0xf0 || firstByte === 0xf7) {
        reader.skip(reader.vlq())
        runningStatus = 0
        continue
      }

      // 其它系统消息（SMF 里罕见）：按类型跳过数据字节
      if (firstByte > 0xf0) {
        const dataBytes = firstByte === 0xf2 ? 2 : firstByte === 0xf1 || firstByte === 0xf3 ? 1 : 0
        if (dataBytes) reader.skip(dataBytes)
        continue
      }

      let status: number
      let firstData: number | null = null
      if (firstByte >= 0x80) {
        status = firstByte
        runningStatus = status
      } else {
        if (runningStatus === 0) {
          throw new Error(`MIDI 文件损坏：偏移 ${reader.offset - 1} 处出现没有状态字节的数据（running status 缺失）`)
        }
        status = runningStatus
        firstData = firstByte
      }

      const type = status & 0xf0
      const channel = status & 0x0f
      const data1 = firstData ?? reader.u8()
      if (data1 > 0x7f) throw new Error(`MIDI 文件损坏：偏移 ${reader.offset - 1} 处的事件数据字节非法`)
      let data2 = 0
      if (type !== 0xc0 && type !== 0xd0) {
        data2 = reader.u8()
        if (data2 > 0x7f) throw new Error(`MIDI 文件损坏：偏移 ${reader.offset - 1} 处的事件数据字节非法`)
      }

      if (type === 0x90 && data2 > 0) {
        // Note On
        chunkChannels.add(channel)
        const key = `${channel}:${data1}`
        const open: OpenNote = { channel, pitch: data1, velocity: data2, startTick: tick }
        const list = openNotes.get(key)
        if (list) list.push(open)
        else openNotes.set(key, [open])
        continue
      }
      if (type === 0x80 || type === 0x90) {
        // Note Off；Note On + velocity 0 也视作 Note Off
        chunkChannels.add(channel)
        closeOpenNote(openNotes, notes, channel, data1, tick)
        continue
      }
      if (type === 0xc0) {
        // Program Change：每个通道记第一个，用于映射内置乐器
        if (!programs.has(channel)) programs.set(channel, data1)
        continue
      }
      // 其它通道消息（CC / 触后 / 弯音）忽略
    }

    // 块结束时仍未释放的音符：以当前 tick 收尾，避免整段丢音
    for (const [, list] of openNotes) {
      for (const open of list) {
        notes.push({
          channel: open.channel,
          pitch: open.pitch,
          velocity: open.velocity,
          startTick: open.startTick,
          endTick: Math.max(open.startTick + 1, tick),
        })
      }
    }
    openNotes.clear()

    if (reader.offset > chunkEnd) throw new Error('MIDI 文件损坏：轨道事件越过轨道块边界')
    if (reader.offset < chunkEnd) reader.skip(chunkEnd - reader.offset)
    chunkInfos.push({ name: chunkName, channels: chunkChannels })
  }

  if (parsedChunks === 0) throw new Error('不是合法的 MIDI 文件：没有找到 MTrk 轨道块')
  void declaredTracks
  return {
    format,
    ppq,
    tempo: tempo || 120,
    timeSignature: timeSignature ?? { numerator: 4, denominator: 4 },
    notes,
    chunkInfos,
    programs,
  }
}

/** 取「序列名」：format 1 里第一个不带音符的块（通常是 tempo 轨）的轨道名 */
function sequenceNameOf(chunkInfos: ParsedChunkInfo[]): string {
  const first = chunkInfos[0]
  return first && first.channels.size === 0 ? first.name : ''
}

/** 分通道轨道名：取第一个「有该通道音符」的 MTrk 块的轨道名 */
function channelNameOf(chunkInfos: ParsedChunkInfo[], channel: number): string {
  for (const info of chunkInfos) {
    if (info.name && info.channels.has(channel)) return info.name
  }
  return ''
}

/**
 * 读取标准 MIDI 文件（SMF format 0 / 1），转换成工程快照。
 *
 * - 一个 MIDI 通道一条轨道，通道 9（GM 鼓）单独成 `kind='drum'` 轨道；
 * - tick / PPQ 换算成拍，音符 start / duration 都以拍为单位；
 * - key / scale 由 `detectKey` 从导入的音符（不含鼓）推断；
 * - style 固定按 `'pop'` 规划段落，`chords` 留空，交给后续 AI 编曲补全。
 *
 * 空文件、非法头、format 2、SMPTE 时间码、超长（>5 分钟）都会抛可读中文 Error。
 */
export function readMidiBytes(bytes: Uint8Array, options: MidiImportOptions = {}): MidiImportResult {
  const parsed = parseMidiFile(bytes)
  const { format, ppq, tempo, timeSignature, chunkInfos, programs } = parsed
  if (parsed.notes.length === 0) throw new Error('MIDI 文件里没有可导入的音符（可能只有元事件或控制事件）')

  const barBeats = (timeSignature.numerator * 4) / timeSignature.denominator
  let lastBeat = 0
  for (const note of parsed.notes) lastBeat = Math.max(lastBeat, roundBeat(note.endTick / ppq))
  const durationSeconds = (lastBeat * 60) / tempo
  if (durationSeconds > MAX_IMPORT_SECONDS) {
    throw new Error(
      `MIDI 文件过长：约 ${(durationSeconds / 60).toFixed(1)} 分钟，超过 ${MAX_IMPORT_SECONDS / 60} 分钟导入上限`,
    )
  }

  // 按通道归组
  const byChannel = new Map<number, ParsedNote[]>()
  for (const note of parsed.notes) {
    const list = byChannel.get(note.channel)
    if (list) list.push(note)
    else byChannel.set(note.channel, [note])
  }

  const tracks: Track[] = []
  const melodicNotes: NoteEvent[] = []
  const channels = [...byChannel.keys()].sort((a, b) => a - b)
  channels.forEach((channel, index) => {
    const rawNotes = (byChannel.get(channel) ?? []).sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch)
    if (rawNotes.length === 0) return
    const isDrum = channel === DRUM_CHANNEL
    const program = programs.get(channel) ?? 0
    const instrument = findInstrumentByProgram(program, isDrum) ?? getInstrument(isDrum ? 'drums.acoustic' : 'piano.grand')
    // format 0 只有一个块，块名通常是曲名，不适合当轨名；改用乐器名
    const channelName = format === 0 ? '' : channelNameOf(chunkInfos, channel)
    const name = channelName || (isDrum ? '鼓组' : instrument.name)
    const noteEvents = rawNotes.map((raw) =>
      createNote(
        Math.max(0, Math.min(127, Math.round(raw.pitch))),
        roundBeat(raw.startTick / ppq),
        Math.max(MIN_NOTE_BEATS, roundBeat((raw.endTick - raw.startTick) / ppq)),
        Math.max(1, Math.min(127, Math.round(raw.velocity))),
      ),
    )
    if (!isDrum) melodicNotes.push(...noteEvents)

    const trackEnd = noteEvents.reduce((end, note) => Math.max(end, note.start + note.duration), barBeats)
    const lengthBeats = Math.max(barBeats, Math.ceil(trackEnd / barBeats - 1e-9) * barBeats)
    const track = createTrack({
      id: newId('t'),
      name,
      kind: isDrum ? 'drum' : 'instrument',
      instrumentId: instrument.id,
      emotionId: instrument.emotions[0]?.id ?? 'default',
      gmProgram: program,
      color: IMPORT_TRACK_COLORS[index % IMPORT_TRACK_COLORS.length],
      clips: [],
    })
    track.clips = [
      createClip({
        id: newId('c'),
        trackId: track.id,
        name,
        startBeat: 0,
        lengthBeats,
        notes: noteEvents,
      }),
    ]
    tracks.push(track)
  })

  if (tracks.length === 0) throw new Error('MIDI 文件里没有可导入的音符')

  const detected = detectKey(melodicNotes)
  const project = createEmptyProject({
    name: options.name?.trim() || sequenceNameOf(chunkInfos) || '导入的 MIDI',
    tempo,
    key: detected.key,
    scale: detected.scale,
  })
  project.timeSignature = { numerator: timeSignature.numerator, denominator: timeSignature.denominator }
  project.tracks = tracks
  // 段落先按 pop 规划，具体风格等 AI 编曲时再换
  project.sections = buildSections(Math.max(1, Math.ceil(lastBeat / barBeats - 1e-9)), 'pop')
  project.chords = []
  project.updatedAt = Date.now()

  const validation = projectSchema.safeParse(project)
  if (!validation.success) {
    const issue = validation.error.issues[0]
    throw new Error(`MIDI 解析结果不合法：${issue ? `${issue.path.join('.')} ${issue.message}` : '未知字段错误'}`)
  }

  const summary: MidiImportSummary = {
    tracks: project.tracks.length,
    notes: project.tracks.reduce((sum, track) => sum + track.clips.reduce((n, clip) => n + clip.notes.length, 0), 0),
    tempo: project.tempo,
    key: project.key,
    scale: project.scale,
    format,
  }
  return { project, summary }
}
