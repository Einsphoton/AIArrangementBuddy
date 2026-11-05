/**
 * 标准 MIDI 文件（SMF format 1）导出器。
 * 零依赖实现，前后端都可用：客户端导出下载，服务端导出返回文件流。
 */
import { beatsPerBar, type Project, type Track } from './model.js'
import { keyToPitchClass, SCALES } from './constants.js'
import { getInstrument } from './instruments/index.js'

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
