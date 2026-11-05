/**
 * 零依赖标准 MIDI 文件（SMF）解析器 —— 语料分析用。
 *
 * 与 `packages/core/src/midi.ts`（只导出、被前后端共享）互补：
 * 这里只用于离线语料管线（`scripts/corpus/`），因此实现成独立 .mjs，不进 core、不影响产物。
 *
 * 支持：format 0 / 1 / 2、running status、SysEx 跳过、meta 事件
 * （tempo / 拍号 / 调号 / 轨道名 / 乐器名 / 版权）、note on velocity=0 视作 note off。
 * 时间输出统一为「拍」（beat），1 拍 = 四分音符，与 core 的数据模型一致。
 */

const META = {
  TEXT: 0x01,
  COPYRIGHT: 0x02,
  TRACK_NAME: 0x03,
  INSTRUMENT_NAME: 0x04,
  LYRIC: 0x05,
  MARKER: 0x06,
  CUE: 0x07,
  CHANNEL_PREFIX: 0x20,
  PORT: 0x21,
  END_OF_TRACK: 0x2f,
  TEMPO: 0x51,
  SMPTE_OFFSET: 0x54,
  TIME_SIGNATURE: 0x58,
  KEY_SIGNATURE: 0x59,
  SEQUENCER_SPECIFIC: 0x7f,
}

class ByteReader {
  constructor(bytes, offset = 0, end = bytes.length) {
    this.bytes = bytes
    this.pos = offset
    this.end = end
  }

  get remaining() {
    return this.end - this.pos
  }

  u8() {
    if (this.pos >= this.end) throw new Error('MIDI: 意外的文件结尾')
    return this.bytes[this.pos++]
  }

  u16() {
    return (this.u8() << 8) | this.u8()
  }

  u32() {
    return ((this.u8() << 24) >>> 0) + ((this.u8() << 16) | (this.u8() << 8) | this.u8())
  }

  /** 变长数量（VLQ） */
  vlq() {
    let value = 0
    for (let i = 0; i < 4; i++) {
      const byte = this.u8()
      value = (value << 7) | (byte & 0x7f)
      if ((byte & 0x80) === 0) return value
    }
    throw new Error('MIDI: VLQ 超过 4 字节')
  }

  slice(length) {
    const out = this.bytes.subarray(this.pos, this.pos + length)
    this.pos += length
    return out
  }

  ascii(length) {
    return new TextDecoder('latin1').decode(this.slice(length))
  }
}

const CHANNEL_EVENT_LENGTH = {
  0x80: 2, // note off
  0x90: 2, // note on
  0xa0: 2, // poly aftertouch
  0xb0: 2, // control change
  0xc0: 1, // program change
  0xd0: 1, // channel aftertouch
  0xe0: 2, // pitch bend
}

/** GM 鼓通道 */
export const DRUM_CHANNEL = 9

/**
 * 解析 MIDI 字节流。
 * @param {Uint8Array} input
 * @returns {{
 *   format: number, ppq: number, smpte: {fps:number, ticksPerFrame:number}|null,
 *   tracks: Array<{
 *     index:number, name:string, instrumentName:string, copyright:string,
 *     channels:number[], program:number|null,
 *     notes:Array<{startTick:number, durationTick:number, startBeat:number, durationBeat:number, pitch:number, velocity:number, channel:number}>,
 *   }>,
 *   tempoMap: Array<{tick:number, usPerQuarter:number, bpm:number}>,
 *   timeSigs: Array<{tick:number, numerator:number, denominator:number, clocksPerClick:number, thirtySeconds:number}>,
 *   keySigs: Array<{tick:number, sf:number, mi:number}>,
 *   markers: Array<{tick:number, text:string}>,
 * }}
 */
export function parseMidi(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const reader = new ByteReader(bytes)

  if (reader.ascii(4) !== 'MThd') throw new Error('MIDI: 缺少 MThd 头')
  const headerLength = reader.u32()
  const headerEnd = reader.pos + headerLength
  const format = reader.u16()
  const declaredTracks = reader.u16()
  const division = reader.u16()
  let ppq = division
  let smpte = null
  if (division & 0x8000) {
    // SMPTE 时间：高字节是负的帧率，低字节是每帧 tick
    const fps = 256 - (division >> 8)
    const ticksPerFrame = division & 0xff
    smpte = { fps, ticksPerFrame }
    ppq = fps * ticksPerFrame
  }
  reader.pos = headerEnd

  const tracks = []
  const tempoMap = []
  const timeSigs = []
  const keySigs = []
  const markers = []

  for (let t = 0; t < declaredTracks && reader.remaining >= 8; t++) {
    const chunkType = reader.ascii(4)
    const chunkLength = reader.u32()
    const chunkEnd = reader.pos + chunkLength
    if (chunkLength <= 0 || chunkEnd > reader.end) break // 防御：损坏的块长度
    if (chunkType !== 'MTrk') {
      reader.pos = chunkEnd
      t--
      continue
    }
    const track = parseTrack(reader, chunkEnd, t, { tempoMap, timeSigs, keySigs, markers }, ppq)
    tracks.push(track)
    reader.pos = chunkEnd
  }

  if (tempoMap.length === 0) tempoMap.push({ tick: 0, usPerQuarter: 500000, bpm: 120 })
  tempoMap.sort((a, b) => a.tick - b.tick)

  return {
    format,
    ppq,
    smpte,
    tracks,
    tempoMap,
    timeSigs,
    keySigs,
    markers,
    declaredTracks,
    bytes: bytes.length,
  }
}

function parseTrack(reader, end, index, sinks, ppq) {
  const track = {
    index,
    name: '',
    instrumentName: '',
    copyright: '',
    channels: [],
    program: null,
    notes: [],
  }
  const open = new Map() // `${channel}:${pitch}` -> { startTick, velocity }
  let tick = 0
  let runningStatus = 0

  while (reader.pos < end) {
    const delta = reader.vlq()
    tick += delta
    if (reader.pos >= end) break
    let status = reader.u8()

    if (status === 0xff) {
      const type = reader.u8()
      const length = reader.vlq()
      const data = reader.slice(length)
      switch (type) {
        case META.TRACK_NAME:
          track.name = decodeText(data, track.name)
          break
        case META.INSTRUMENT_NAME:
          track.instrumentName = decodeText(data, track.instrumentName)
          break
        case META.COPYRIGHT:
          track.copyright = decodeText(data, track.copyright)
          break
        case META.MARKER:
          sinks.markers.push({ tick, text: decodeText(data, '') })
          break
        case META.TEMPO: {
          if (length >= 3) {
            const usPerQuarter = (data[0] << 16) | (data[1] << 8) | data[2]
            sinks.tempoMap.push({ tick, usPerQuarter, bpm: Math.round((60_000_000 / usPerQuarter) * 100) / 100 })
          }
          break
        }
        case META.TIME_SIGNATURE: {
          if (length >= 2) {
            sinks.timeSigs.push({
              tick,
              numerator: data[0],
              denominator: 2 ** data[1],
              clocksPerClick: data[2] ?? 24,
              thirtySeconds: data[3] ?? 8,
            })
          }
          break
        }
        case META.KEY_SIGNATURE: {
          if (length >= 2) sinks.keySigs.push({ tick, sf: (data[0] << 24) >> 24, mi: data[1] })
          break
        }
        default:
          break
      }
      if (type === META.END_OF_TRACK) break
      continue
    }

    if (status === 0xf0 || status === 0xf7) {
      const length = reader.vlq()
      reader.slice(length)
      runningStatus = 0
      continue
    }

    // running status：数据字节 < 0x80 时复用上一个状态
    if (status < 0x80) {
      if (!runningStatus) throw new Error('MIDI: 非法的 running status')
      reader.pos--
      status = runningStatus
    } else {
      runningStatus = status
    }

    const type = status & 0xf0
    const channel = status & 0x0f
    const length = CHANNEL_EVENT_LENGTH[type]
    if (!length) {
      // 未知状态：跳过 1 字节，避免死循环
      reader.u8()
      continue
    }
    const d1 = reader.u8()
    const d2 = length === 2 ? reader.u8() : 0

    if (!track.channels.includes(channel)) track.channels.push(channel)

    if (type === 0x90 && d2 > 0) {
      const key = `${channel}:${d1}`
      if (!open.has(key)) open.set(key, { startTick: tick, velocity: d2 })
    } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
      const key = `${channel}:${d1}`
      const note = open.get(key)
      if (note) {
        open.delete(key)
        track.notes.push({
          startTick: note.startTick,
          durationTick: Math.max(1, tick - note.startTick),
          startBeat: note.startTick / ppq,
          durationBeat: Math.max(1, tick - note.startTick) / ppq,
          pitch: d1,
          velocity: note.velocity,
          channel,
        })
      }
    } else if (type === 0xc0) {
      if (track.program === null) track.program = d1
    }
  }

  // 未闭合的音符（有些文件省略 note off）：按轨道末尾收尾
  for (const [key, note] of open) {
    const [channel, pitch] = key.split(':').map(Number)
    track.notes.push({
      startTick: note.startTick,
      durationTick: Math.max(1, tick - note.startTick),
      startBeat: note.startTick / ppq,
      durationBeat: Math.max(1, tick - note.startTick) / ppq,
      pitch,
      velocity: note.velocity,
      channel,
    })
  }

  track.notes.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch)
  return track
}

function decodeText(data, fallback) {
  // 优先 UTF-8，失败回落 latin1（很多老 MIDI 用 Shift-JIS，这里不做猜测）
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data)
    return text.replace(/\0+$/, '')
  } catch {
    const text = new TextDecoder('latin1').decode(data)
    return text.replace(/\0+$/, '') || fallback
  }
}

/** 把 tick 转换为秒（按 tempo map 分段积分） */
export function ticksToSeconds(parsed, tick) {
  let seconds = 0
  let lastTick = 0
  let usPerQuarter = parsed.tempoMap[0]?.usPerQuarter ?? 500000
  for (const change of parsed.tempoMap) {
    if (change.tick > tick) break
    seconds += ((change.tick - lastTick) / parsed.ppq) * (usPerQuarter / 1_000_000)
    lastTick = change.tick
    usPerQuarter = change.usPerQuarter
  }
  return seconds + ((tick - lastTick) / parsed.ppq) * (usPerQuarter / 1_000_000)
}

/** 拍号（取第一个） */
export function primaryTimeSignature(parsed) {
  const ts = parsed.timeSigs[0]
  return ts ? { numerator: ts.numerator, denominator: ts.denominator } : { numerator: 4, denominator: 4 }
}

/** 文件级摘要（用于索引与快速筛除） */
export function summarize(parsed) {
  const notes = flattenNotes(parsed)
  const ts = primaryTimeSignature(parsed)
  const endTick = Math.max(0, ...parsed.tracks.map((t) => t.notes.reduce((m, n) => Math.max(m, n.startTick + n.durationTick), 0)))
  const beats = endTick / parsed.ppq
  const bpm = parsed.tempoMap[0]?.bpm ?? 120
  return {
    format: parsed.format,
    ppq: parsed.ppq,
    trackCount: parsed.tracks.length,
    noteCount: notes.length,
    beats: Math.round(beats * 100) / 100,
    bars: Math.round((beats / ((ts.numerator * 4) / ts.denominator)) * 100) / 100,
    seconds: Math.round(ticksToSeconds(parsed, endTick) * 100) / 100,
    bpm,
    timeSignature: ts,
    programs: [...new Set(parsed.tracks.map((t) => t.program).filter((p) => p !== null))],
    hasDrums: parsed.tracks.some((t) => t.channels.includes(DRUM_CHANNEL)),
    names: parsed.tracks.map((t) => t.name).filter(Boolean),
    copyright: parsed.tracks.find((t) => t.copyright)?.copyright ?? '',
  }
}

/** 把所有轨道的音符拍平成带轨道的列表 */
export function flattenNotes(parsed) {
  const out = []
  for (const track of parsed.tracks) {
    for (const note of track.notes) out.push({ ...note, track: track.index })
  }
  return out
}
