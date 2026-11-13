#!/usr/bin/env node
/**
 * 渲染底层单元测试：WAV 编码器 + BS.1770 响度测量/归一 + MIDI 中立混音 CC。
 *
 *   node --import tsx scripts/test-render-units.mjs
 *
 * 直接从 TS 源码 import（tsx 提供 .ts 转译），断言的是渲染主链真正调用的函数：
 *
 *  A) apps/web/src/audio/wav.ts
 *     - 44 字节 RIFF/WAVE 头字段、字节数（estimateWavBytes 与实际编码一致）；
 *     - 16-bit / 24-bit 样本回读（24-bit 为 3 字节 LE signed）；
 *     - 超范围样本只夹住不回绕（爆音根因），NaN 视作 0；
 *     - TPDF dither：静音时 ≤1 LSB 三角噪声、同 seed 字节流一致、绝不削顶。
 *
 *  B) apps/web/src/audio/loudness.ts
 *     - K 加权响度对齐 BS.1770-4 理论值（含 1kHz 正弦两个参考口径，见下方说明）；
 *     - 400ms 块 / 相对门限把远处安静段剔除；
 *     - truePeakDb 与采样峰值一致（4x 线性插值不会超出采样包络）；
 *     - normalizeLoudness = 增益 + lookahead 限峰 + 迭代补偿：
 *       未触限峰时归一后 ≈ target±1；高 crest（短脉冲 + 低电平底噪、正弦 + 脉冲）也能收在
 *       target±1.5 且 true peak ≤ ceiling+0.1、无 |x|>=1（平滑包络，不是硬 clamp）；
 *     - 静音 / NaN 输入返回安全值（-Infinity 或有限数），绝不 NaN。
 *
 *  C) packages/core/src/midi.ts
 *     - mixControls='neutral' 写 CC7=127 / CC10=64 / CC91=0 / CC93=0（+ 亮度回中 / 颤音归零）；
 *     - mixControls='mix' 仍是旧公式值（CC7=round(vol*100) 等），保证历史行为不变。
 *
 * 说明（响度验收口径）：BS.1770 对“双声道同信号”是能量相加，因此
 *   LUFS = -0.691 + 20*log10(幅度) + K加权(1kHz)
 * 1kHz 处 K 加权增益 ≈ +0.70 dB（由规范附录 48k 系数算出），故：
 *   - 幅度 0.1（-20 dBFS 峰值）=> ≈ -20.0 LUFS；
 *   - 幅度 10^(-23/20)≈0.0708（-23 dBFS 峰值）=> ≈ -23.0 LUFS（EBU Tech 3341 参考信号）。
 * 两个口径都断言，避免把“0.1 幅度”错记成 -23 LUFS。
 *
 * 约束：不访问网络、不起服务、不读写运行中的工程文件；失败 exit 1。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WAV_TS = path.join(ROOT, 'apps', 'web', 'src', 'audio', 'wav.ts')
const LOUDNESS_TS = path.join(ROOT, 'apps', 'web', 'src', 'audio', 'loudness.ts')
const MODEL_TS = path.join(ROOT, 'packages', 'core', 'src', 'model.ts')
const MIDI_TS = path.join(ROOT, 'packages', 'core', 'src', 'midi.ts')

/** 1kHz 处 K 加权总增益（dB）：由 BS.1770-4 附录 48k 系数在 1kHz 计算 */
const K_WEIGHT_1K_DB = 0.7004

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', gold: '\x1b[33m' }

let passed = 0
let failed = 0
const failures = []
const startedAt = Date.now()

/* ------------------------------------------------------------------ */
/* 断言与输出工具                                                      */
/* ------------------------------------------------------------------ */

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} 期望 ${expected}，实际 ${actual}`)
}

function assertClose(actual, expected, tolerance, label) {
  assert(Number.isFinite(actual), `${label} 不是有限数：${actual}`)
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label} 期望 ${expected}±${tolerance}，实际 ${actual.toFixed(4)}`)
  }
}

function check(name, fn) {
  try {
    const detail = fn()
    passed++
    console.log(`  ${C.green}✓${C.reset} ${name}${detail ? `  ${C.dim}${detail}${C.reset}` : ''}`)
  } catch (error) {
    failed++
    const message = error instanceof Error ? error.message : String(error)
    failures.push(`${name}: ${message}`)
    console.log(`  ${C.red}✗${C.reset} ${name}  ${C.red}${message}${C.reset}`)
  }
}

function section(title) {
  console.log(`\n${C.bold}${title}${C.reset}`)
}

/* ------------------------------------------------------------------ */
/* 加载 TS 源码（tsx）                                                 */
/* ------------------------------------------------------------------ */

async function loadSourceModules() {
  const missing = [WAV_TS, LOUDNESS_TS, MODEL_TS, MIDI_TS].filter((file) => !existsSync(file))
  if (missing.length > 0) {
    throw new Error(`缺少源文件：${missing.map((file) => path.relative(ROOT, file)).join(', ')}`)
  }
  const [wav, loudness, model, midi] = await Promise.all([
    import(pathToFileURL(WAV_TS).href),
    import(pathToFileURL(LOUDNESS_TS).href),
    import(pathToFileURL(MODEL_TS).href),
    import(pathToFileURL(MIDI_TS).href),
  ])
  return { wav, loudness, model, midi }
}

const { wav, loudness, model, midi } = await loadSourceModules()
const { encodeWavBuffer, estimateWavBytes } = wav
const { measureIntegratedLufs, truePeakDb, normalizeLoudness } = loudness
const { createEmptyProject, createTrack, createClip, createNote } = model

/* ------------------------------------------------------------------ */
/* WAV 解析工具                                                        */
/* ------------------------------------------------------------------ */

function ascii(bytes, offset, length) {
  let text = ''
  for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[offset + i])
  return text
}

function dataView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function readWavHeader(bytes) {
  const view = dataView(bytes)
  return {
    riff: ascii(bytes, 0, 4),
    riffSize: view.getUint32(4, true),
    wave: ascii(bytes, 8, 4),
    fmtId: ascii(bytes, 12, 4),
    fmtSize: view.getUint32(16, true),
    audioFormat: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    dataId: ascii(bytes, 36, 4),
    dataSize: view.getUint32(40, true),
  }
}

/** 读取 24-bit little-endian signed（3 字节）并做符号扩展 */
function readInt24(bytes, offset) {
  const raw = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
  return raw & 0x800000 ? raw - 0x1000000 : raw
}

function readWavSamples16(bytes, frameCount) {
  const view = dataView(bytes)
  const out = new Int32Array(frameCount)
  for (let i = 0; i < frameCount; i++) out[i] = view.getInt16(44 + i * 2, true)
  return out
}

function readWavSamples24(bytes, frameCount, channels) {
  const out = new Int32Array(frameCount * channels)
  for (let i = 0; i < out.length; i++) out[i] = readInt24(bytes, 44 + i * 3)
  return out
}

/* ------------------------------------------------------------------ */
/* 测试信号工具                                                        */
/* ------------------------------------------------------------------ */

function sine(frames, amplitude, frequency = 1000, sampleRate = 48000, phase = 0) {
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) out[i] = amplitude * Math.sin(2 * Math.PI * frequency * (i / sampleRate) + phase)
  return out
}

function clone(samples) {
  const out = new Float32Array(samples.length)
  out.set(samples)
  return out
}

function maxAbs(samples) {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i])
    if (value > peak) peak = value
  }
  return peak
}

/**
 * 高 crest 测试信号：低电平底噪（正弦）+ 周期性短脉冲（4ms 半正弦）。
 * crest factor = 峰值 - 积分响度，真实工程里常见 16~20 dB；这种素材
 * 「整体抬增益」必然撞 ceiling，只有 lookahead 限峰才能把平均响度顶到目标。
 */
function highCrestSignal(
  seconds,
  bedAmplitude,
  impulseAmplitude,
  sampleRate = 48000,
  bedFrequency = 220,
  periodSec = 0.5,
  impulseSec = 0.004,
) {
  const frames = Math.round(seconds * sampleRate)
  const signal = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    signal[i] = bedAmplitude * Math.sin((2 * Math.PI * bedFrequency * i) / sampleRate)
  }
  const width = Math.round(impulseSec * sampleRate)
  const period = Math.round(periodSec * sampleRate)
  for (let start = Math.round(0.1 * sampleRate); start + width < frames; start += period) {
    for (let k = 0; k < width; k++) {
      signal[start + k] += impulseAmplitude * Math.sin((Math.PI * k) / width)
    }
  }
  return signal
}

/** 归一后的公共质量断言：收在 target±1.5、true peak ≤ ceiling+0.1、无 |x|>=1、无硬削波平台 */
function assertNormalizedQuality(left, right, sampleRate, targetLufs, ceilingDb, label) {
  const lufs = measureIntegratedLufs(left, right, sampleRate)
  assertClose(lufs, targetLufs, 1.5, `${label} 归一后响度`)
  const peakDb = truePeakDb(left, right, sampleRate)
  assert(peakDb <= ceilingDb + 0.1, `${label} true peak ${peakDb.toFixed(3)} 超过 ceiling+0.1（${ceilingDb + 0.1}）`)
  const ceiling = 10 ** (ceilingDb / 20)
  let maxSample = 0
  // 硬 clamp / 削波会留下连续贴住 ceiling 的"平台"；平滑包络最多贴住个别峰值样本
  let run = 0
  let maxRun = 0
  for (const channel of [left, right]) {
    for (let i = 0; i < channel.length; i++) {
      const abs = Math.abs(channel[i])
      assert(Number.isFinite(abs), `${label} 出现非有限样本`)
      if (abs > maxSample) maxSample = abs
      if (abs >= ceiling - 1e-6) {
        run++
        if (run > maxRun) maxRun = run
      } else {
        run = 0
      }
    }
  }
  assert(maxSample < 1, `${label} 出现 |x| >= 1 的削顶样本`)
  assert(maxSample < 0.999, `${label} 出现 |x| >= 0.999 的满幅样本`)
  assert(maxSample <= ceiling + 1e-6, `${label} 样本峰值 ${maxSample} 超过 ceiling 线性值 ${ceiling}`)
  assert(maxRun <= 4, `${label} 出现 ${maxRun} 个连续满幅样本，疑似硬削波平台`)
  return { lufs, peakDb }
}

/* ------------------------------------------------------------------ */
/* SMF（标准 MIDI 文件）最小解析：只提取通道事件，用于断言 CC          */
/* ------------------------------------------------------------------ */

function parseSmf(bytes) {
  let pos = 0
  const readU8 = () => {
    assert(pos < bytes.length, 'SMF 数据意外结束')
    return bytes[pos++]
  }
  const readU16 = () => (readU8() << 8) | readU8()
  const readU32 = () => ((readU16() << 16) | readU16()) >>> 0
  const readAscii = (length) => {
    let text = ''
    for (let i = 0; i < length; i++) text += String.fromCharCode(readU8())
    return text
  }
  const readVlq = () => {
    let value = 0
    for (let i = 0; i < 4; i++) {
      const byte = readU8()
      value = (value << 7) | (byte & 0x7f)
      if ((byte & 0x80) === 0) return value
    }
    throw new Error('SMF 的变长数值（VLQ）超过 4 字节')
  }

  assertEq(readAscii(4), 'MThd', 'SMF 文件头')
  const headerLength = readU32()
  const format = readU16()
  const trackCount = readU16()
  const ppq = readU16()
  assertEq(headerLength, 6, 'MThd 长度')
  if (headerLength > 6) pos += headerLength - 6

  const tracks = []
  while (pos + 8 <= bytes.length) {
    const chunkId = readAscii(4)
    const chunkLength = readU32()
    assert(pos + chunkLength <= bytes.length, `MTrk 块声明 ${chunkLength} 字节超出文件范围`)
    const chunkEnd = pos + chunkLength
    if (chunkId !== 'MTrk') {
      pos = chunkEnd
      continue
    }
    const events = []
    let tick = 0
    let runningStatus = 0
    while (pos < chunkEnd) {
      tick += readVlq()
      let status = bytes[pos]
      if (status === 0xff) {
        pos++
        const metaType = readU8()
        const length = readVlq()
        pos += length
        if (metaType === 0x2f) break // End of Track
        continue
      }
      if (status === 0xf0 || status === 0xf7) {
        pos++
        pos += readVlq()
        runningStatus = 0
        continue
      }
      if (status & 0x80) {
        runningStatus = status
        pos++
      } else {
        assert(runningStatus !== 0, 'SMF 缺少 running status')
        status = runningStatus
      }
      const type = status & 0xf0
      const channel = status & 0x0f
      if (type === 0xc0 || type === 0xd0) {
        events.push({ tick, status, type, channel, data1: readU8() })
        continue
      }
      events.push({ tick, status, type, channel, data1: readU8(), data2: readU8() })
    }
    tracks.push(events)
    pos = chunkEnd
  }
  assertEq(tracks.length, trackCount, 'MTrk 块数量')
  return { format, trackCount, ppq, tracks }
}

/** 收集每个 MIDI 通道的 CC 事件（控制器号 -> 值，同一控制器取首个） */
function collectControlChanges(parsed) {
  const byChannel = new Map()
  for (const events of parsed.tracks) {
    for (const event of events) {
      if (event.type !== 0xb0) continue
      if (!byChannel.has(event.channel)) byChannel.set(event.channel, new Map())
      const map = byChannel.get(event.channel)
      if (!map.has(event.data1)) map.set(event.data1, event.data2)
    }
  }
  return byChannel
}

/** 构造一个固定混音参数的工程（两条旋律轨 => 两个通道），用于 CC 断言 */
function buildMidiFixture() {
  const project = createEmptyProject({ name: 'unit-test', tempo: 120 })
  project.tracks = [
    { name: 'Piano', instrumentId: 'piano.grand', pitch: 60 },
    { name: 'Guitar', instrumentId: 'guitar.acoustic', pitch: 64 },
  ].map((spec) => {
    const track = createTrack({
      name: spec.name,
      instrumentId: spec.instrumentId,
      emotionId: 'default',
      volume: 0.5,
      pan: -1,
      reverbSend: 0.18,
      delaySend: 0.06,
    })
    track.clips = [
      createClip({
        trackId: track.id,
        name: spec.name,
        startBeat: 0,
        lengthBeats: 4,
        notes: [createNote(spec.pitch, 0, 1, 90), createNote(spec.pitch + 4, 1, 1, 90)],
      }),
    ]
    return track
  })
  return project
}

/* ================================================================== */
/* A) WAV 编码器                                                       */
/* ================================================================== */

section('A) WAV 编码器（apps/web/src/audio/wav.ts）')

check('WAV 头：44 字节 RIFF/WAVE/fmt(PCM=1)/data 字段与字节数自洽', () => {
  const frames = 4410 // 0.1s @44.1k
  const left = sine(frames, 0.5, 1000, 44100)
  const right = sine(frames, 0.5, 1000, 44100)
  const bytes = encodeWavBuffer(left, right, { sampleRate: 44100, bitDepth: 16, dither: false })
  const header = readWavHeader(bytes)
  assertEq(bytes.length, 44 + frames * 2 * 2, '文件总长度')
  assertEq(header.riff, 'RIFF', 'RIFF 标记')
  assertEq(header.wave, 'WAVE', 'WAVE 标记')
  assertEq(header.riffSize, bytes.length - 8, 'RIFF 块大小')
  assertEq(header.fmtId, 'fmt ', 'fmt 块标记')
  assertEq(header.fmtSize, 16, 'fmt 块大小')
  assertEq(header.audioFormat, 1, 'audioFormat（PCM）')
  assertEq(header.channels, 2, '声道数')
  assertEq(header.sampleRate, 44100, '采样率')
  assertEq(header.byteRate, 44100 * 4, 'byteRate')
  assertEq(header.blockAlign, 4, 'blockAlign')
  assertEq(header.bitsPerSample, 16, '位深')
  assertEq(header.dataId, 'data', 'data 块标记')
  assertEq(header.dataSize, frames * 2 * 2, 'data 块大小')
  return `${bytes.length} 字节 / ${frames} 帧 / 2ch / 16-bit`
})

check('WAV 头：24-bit 单声道字段与 3 字节对齐', () => {
  const frames = 480
  const bytes = encodeWavBuffer(new Float32Array(frames), undefined, { sampleRate: 48000, bitDepth: 24 })
  const header = readWavHeader(bytes)
  assertEq(header.channels, 1, '声道数')
  assertEq(header.sampleRate, 48000, '采样率')
  assertEq(header.byteRate, 48000 * 3, 'byteRate')
  assertEq(header.blockAlign, 3, 'blockAlign（3 字节对齐）')
  assertEq(header.bitsPerSample, 24, '位深')
  assertEq(header.dataSize, frames * 3, 'data 块大小')
  assertEq(bytes.length, 44 + frames * 3, '文件总长度')
  return `${bytes.length} 字节 / 24-bit 单声道`
})

check('estimateWavBytes 与实际编码字节数一致（16/24-bit × 单/双声道）', () => {
  const sampleRate = 48000
  const durationSec = 0.5
  const frames = Math.round(durationSec * sampleRate)
  for (const bitDepth of [16, 24]) {
    for (const channels of [1, 2]) {
      const left = new Float32Array(frames)
      const right = channels === 2 ? new Float32Array(frames) : undefined
      const actual = encodeWavBuffer(left, right, { sampleRate, bitDepth, dither: false }).length
      const estimated = estimateWavBytes(durationSec, sampleRate, bitDepth, channels)
      assertEq(actual, estimated, `${bitDepth}-bit / ${channels}ch 预估字节数`)
    }
  }
  assertEq(estimateWavBytes(1, 44100, 16, 2), 44 + 44100 * 4, '1s 立体声 16-bit')
  assertEq(estimateWavBytes(0.1, 48000, 24, 1), 44 + 4800 * 3, '0.1s 单声道 24-bit')
  return '4 种组合一致'
})

check('空输入只输出 44 字节头（data 长度 0，不抛错）', () => {
  const mono = encodeWavBuffer(new Float32Array(0), undefined, { sampleRate: 44100 })
  const stereo = encodeWavBuffer(new Float32Array(0), new Float32Array(0), { sampleRate: 44100, bitDepth: 24 })
  assertEq(mono.length, 44, '单声道空文件长度')
  assertEq(stereo.length, 44, '立体声空文件长度')
  assertEq(readWavHeader(stereo).dataSize, 0, '空文件 data 大小')
  return '44 字节'
})

check('16-bit 样本回读：量化正确，超范围只夹住不回绕（不爆音）', () => {
  const values = [0, 0.5, -0.5, 1, -1, 2, -2, 0.25, Number.NaN, -0.25]
  const bytes = encodeWavBuffer(Float32Array.from(values), undefined, {
    sampleRate: 44100,
    bitDepth: 16,
    dither: false,
  })
  const samples = readWavSamples16(bytes, values.length)
  const expected = [0, 16384, -16384, 32767, -32768, 32767, -32768, 8192, 0, -8192]
  expected.forEach((want, index) => assertEq(samples[index], want, `第 ${index} 个样本`))
  // 关键：+2 / -2 这类过载样本必须停在正/负满量程，绝不能翻符号（翻符号 = 爆音）
  assert(samples[5] > 0 && samples[6] < 0, '过载样本发生符号翻转（回绕爆音）')
  return '过载样本夹在 ±满量程'
})

check('24-bit 样本回读：3 字节 little-endian signed + 符号扩展', () => {
  const left = Float32Array.from([0.5, -1, 2, 0.25, -0.25])
  const right = Float32Array.from([-0.5, 1, -2, 0, -1 / 8388608])
  const frames = left.length
  const bytes = encodeWavBuffer(left, right, { sampleRate: 48000, bitDepth: 24, dither: false })
  const samples = readWavSamples24(bytes, frames, 2)
  const expected = [
    4194304,
    -4194304, // frame 0: L=0.5 R=-0.5
    -8388608,
    8388607, // frame 1: L=-1 R=1
    8388607,
    -8388608, // frame 2: L=2（夹住） R=-2（夹住）
    2097152,
    0, // frame 3
    -2097152,
    -1, // frame 4: R=-1 LSB（符号扩展必须得到 -1 而不是 16777215）
  ]
  expected.forEach((want, index) => assertEq(samples[index], want, `第 ${index} 个样本`))
  assertEq(bytes.length, 44 + frames * 2 * 3, '文件长度')
  return '24-bit 交织 + 符号扩展正确'
})

check('TPDF dither：静音产生 ≤1 LSB 噪声、可复现、绝不削顶（16-bit）', () => {
  const frames = 2048
  const options = { sampleRate: 44100, bitDepth: 16, dither: true, ditherSeed: 12345 }
  const bytes = encodeWavBuffer(new Float32Array(frames), undefined, options)
  const samples = readWavSamples16(bytes, frames)
  let nonZero = 0
  let peak = 0
  for (const sample of samples) {
    if (sample !== 0) nonZero++
    peak = Math.max(peak, Math.abs(sample))
  }
  assert(nonZero > frames * 0.2, `抖动后非零样本太少：${nonZero}/${frames}`)
  assert(peak <= 1, `静音抖动峰值 ${peak} LSB 超过 ±1 LSB（会听到噪声/削顶）`)
  const decodedPeak = peak / 32768
  assert(decodedPeak < 2 / 32768, `抖动噪声幅度 ${decodedPeak} 过大`)
  // 同 seed 完全一致
  const again = encodeWavBuffer(new Float32Array(frames), undefined, options)
  assertEq(again.length, bytes.length, '同 seed 长度')
  for (let i = 0; i < bytes.length; i++) assertEq(again[i], bytes[i], `同 seed 第 ${i} 字节`)
  // 不同 seed 应产生不同字节流
  const other = encodeWavBuffer(new Float32Array(frames), undefined, { ...options, ditherSeed: 54321 })
  let diff = 0
  for (let i = 44; i < bytes.length; i++) if (bytes[i] !== other[i]) diff++
  assert(diff > 0, '不同 seed 的抖动字节流完全相同（seed 未生效）')
  // 不加 dither 时静音必须逐样本为 0
  const dry = readWavSamples16(
    encodeWavBuffer(new Float32Array(frames), undefined, { sampleRate: 44100, bitDepth: 16, dither: false }),
    frames,
  )
  assert(dry.every((sample) => sample === 0), '未开启 dither 时静音样本不为 0')
  return `${nonZero}/${frames} 个 ±1 LSB 样本，峰值 ${peak} LSB`
})

check('TPDF dither：24-bit 静音噪声 ≤1 LSB，过载输入不回绕', () => {
  const frames = 1024
  const silent = encodeWavBuffer(new Float32Array(frames), undefined, {
    sampleRate: 48000,
    bitDepth: 24,
    dither: true,
    ditherSeed: 777,
  })
  const quiet = readWavSamples24(silent, frames, 1)
  let nonZero = 0
  let peak = 0
  for (const sample of quiet) {
    if (sample !== 0) nonZero++
    peak = Math.max(peak, Math.abs(sample))
  }
  assert(nonZero > 0, '24-bit 抖动没有生效')
  assert(peak <= 1, `24-bit 静音抖动峰值 ${peak} LSB 超过 ±1 LSB`)

  const hot = Float32Array.from([3, -3, 3, -3, 3, -3])
  const hotBytes = encodeWavBuffer(hot, undefined, { sampleRate: 48000, bitDepth: 24, dither: true, ditherSeed: 1 })
  const hotSamples = readWavSamples24(hotBytes, hot.length, 1)
  for (const [index, sample] of hotSamples.entries()) {
    const expected = index % 2 === 0 ? 8388607 : -8388608
    assertEq(sample, expected, `过载 24-bit 第 ${index} 个样本`)
  }
  return `静音峰值 ${peak} LSB，过载夹在 ±满量程`
})

/* ================================================================== */
/* B) 响度测量与归一                                                   */
/* ================================================================== */

section('B) 响度测量与归一（apps/web/src/audio/loudness.ts）')

check('LUFS：1kHz 立体声正弦幅度 0.1 -> ≈ -20.0 LUFS（BS.1770 公式值）', () => {
  // 双声道同信号 => 能量相加：-0.691 + 20log10(0.1) + K加权(1k)
  const expected = -0.691 + 20 * Math.log10(0.1) + K_WEIGHT_1K_DB
  for (const [sampleRate, label] of [
    [48000, '48k'],
    [44100, '44.1k'],
  ]) {
    const tone = sine(2 * sampleRate, 0.1, 1000, sampleRate)
    const lufs = measureIntegratedLufs(tone, tone, sampleRate)
    assertClose(lufs, expected, 0.5, `${label} 积分响度`)
  }
  return `实测 ≈ ${(-0.691 + 20 * Math.log10(0.1) + K_WEIGHT_1K_DB).toFixed(2)} LUFS（幅度 0.1）`
})

check('LUFS：-23 dBFS 峰值（幅度 10^(-23/20)）-> ≈ -23.0 LUFS（EBU Tech 3341 参考）', () => {
  const amplitude = 10 ** (-23 / 20)
  const expected = -0.691 + 20 * Math.log10(amplitude) + K_WEIGHT_1K_DB
  assertClose(expected, -23, 0.5, '理论值口径')
  for (const sampleRate of [48000, 44100]) {
    const tone = sine(2 * sampleRate, amplitude, 1000, sampleRate)
    const lufs = measureIntegratedLufs(tone, tone, sampleRate)
    assertClose(lufs, -23, 0.5, `${sampleRate}Hz 积分响度`)
  }
  return `幅度 ${amplitude.toFixed(4)} -> ≈ -23 LUFS`
})

check('LUFS：相对门限（-10 LU）剔除远处安静段', () => {
  const sampleRate = 48000
  const loud = sine(3 * sampleRate, 0.5, 1000, sampleRate)
  const quiet = sine(9 * sampleRate, 0.0005, 1000, sampleRate)
  const mixed = new Float32Array(loud.length + quiet.length)
  mixed.set(loud, 0)
  mixed.set(quiet, loud.length)
  const loudLufs = measureIntegratedLufs(loud, loud, sampleRate)
  const quietLufs = measureIntegratedLufs(quiet, quiet, sampleRate)
  const mixedLufs = measureIntegratedLufs(mixed, mixed, sampleRate)
  // 安静段（≈ -66 LUFS）比响亮段低 60 LU，必须被相对门限剔除；
  // 若不剔除，所有块的能量平均会落在 ≈ -12 LUFS（被 9 秒安静段拉低）。
  assertClose(mixedLufs, loudLufs, 0.5, '安静段应被相对门限剔除')
  assert(mixedLufs > -9, `混合响度 ${mixedLufs.toFixed(2)} 说明相对门限没生效（应接近响亮段）`)
  assert(quietLufs < -60, `安静段基准响度 ${quietLufs.toFixed(2)} 不对`)
  return `响亮段 ${loudLufs.toFixed(2)} / 混合 ${mixedLufs.toFixed(2)} / 安静段 ${quietLufs.toFixed(2)} LUFS`
})

check('LUFS：短于 400ms 的片段仍能测出响度（退化为单块）', () => {
  const sampleRate = 48000
  const short = sine(Math.round(0.1 * sampleRate), 0.1, 1000, sampleRate)
  const lufs = measureIntegratedLufs(short, short, sampleRate)
  assert(Number.isFinite(lufs), `短视频响度不是有限数：${lufs}`)
  assertClose(lufs, -20, 1, '短视频积分响度')
  return `${lufs.toFixed(2)} LUFS`
})

check('LUFS / truePeak：静音与全 NaN 输入安全（-Infinity，不 NaN）', () => {
  const sampleRate = 48000
  const silent = new Float32Array(sampleRate)
  const silentLufs = measureIntegratedLufs(silent, silent, sampleRate)
  assert(!Number.isNaN(silentLufs), '静音 LUFS 是 NaN')
  assert(!Number.isFinite(silentLufs) && silentLufs < 0, `静音 LUFS 应为 -Infinity，实际 ${silentLufs}`)
  const silentPeak = truePeakDb(silent, silent, sampleRate)
  assert(!Number.isNaN(silentPeak), '静音 true peak 是 NaN')
  assert(!Number.isFinite(silentPeak), `静音 true peak 应为 -Infinity，实际 ${silentPeak}`)

  const allNaN = new Float32Array(4096).fill(Number.NaN)
  const nanLufs = measureIntegratedLufs(allNaN, allNaN, sampleRate)
  assert(!Number.isNaN(nanLufs), '全 NaN 输入返回了 NaN')
  assert(!Number.isFinite(nanLufs), '全 NaN 输入应视作静音 -> -Infinity')

  const emptyLufs = measureIntegratedLufs(new Float32Array(0), undefined, sampleRate)
  assert(!Number.isNaN(emptyLufs) && !Number.isFinite(emptyLufs), `空输入应是 -Infinity，实际 ${emptyLufs}`)

  // 混入少数 NaN 的合法信号仍应测出有限响度（NaN 视作 0）
  const dirty = sine(sampleRate, 0.1, 1000, sampleRate)
  for (let i = 0; i < dirty.length; i += 97) dirty[i] = Number.NaN
  const dirtyLufs = measureIntegratedLufs(dirty, dirty, sampleRate)
  assert(Number.isFinite(dirtyLufs), `含 NaN 的信号响度不是有限数：${dirtyLufs}`)
  return '静音/NaN/空输入都不是 NaN'
})

check('truePeakDb：与采样峰值一致（4x 线性插值不超出采样包络）', () => {
  const signal = Float32Array.from([0.1, -0.2, 0.3, 0.05, -0.3, 0])
  const peak = truePeakDb(signal, undefined, 44100)
  assertClose(peak, 20 * Math.log10(0.3), 1e-6, '单声道 true peak')
  const stereoPeak = truePeakDb(Float32Array.from([0.1]), Float32Array.from([0.2]), 48000)
  assertClose(stereoPeak, 20 * Math.log10(0.2), 1e-6, '双声道分别取峰值')
  return `${peak.toFixed(2)} dBFS`
})

check('normalizeLoudness：未触限峰时归一后 ≈ target±1，峰值 ≤ ceiling', () => {
  const sampleRate = 48000
  const left = sine(2 * sampleRate, 0.1, 1000, sampleRate)
  const right = clone(left)
  const result = normalizeLoudness(left, right, sampleRate, { targetLufs: -14, ceilingDb: -1 })
  assertClose(result.lufsBefore, -20, 0.5, '归一前响度')
  assertClose(result.lufsAfter, -14, 1, '归一后响度')
  assertEq(result.limited, false, '不该触发限峰')
  assert(result.peakDb <= -1 + 1e-9, `峰值 ${result.peakDb.toFixed(3)} dBFS 超过 ceiling -1`)
  // gainDb 应与实际应用的增益一致
  assertClose(result.gainDb, -14 - result.lufsBefore, 1e-6, 'gainDb')
  const applied = maxAbs(left) / 0.1
  assertClose(20 * Math.log10(applied), result.gainDb, 1e-3, '实际样本增益')
  return `gain ${result.gainDb.toFixed(2)} dB，${result.lufsBefore.toFixed(2)} -> ${result.lufsAfter.toFixed(2)} LUFS，peak ${result.peakDb.toFixed(2)} dBFS`
})

check('normalizeLoudness：目标不可达（0 LUFS）时 lookahead 限峰兜底，代价 ≈1 dB 且不硬削波', () => {
  const sampleRate = 48000
  const left = sine(2 * sampleRate, 0.1, 1000, sampleRate)
  const right = clone(left)
  const result = normalizeLoudness(left, right, sampleRate, { targetLufs: 0, ceilingDb: -1 })
  assertEq(result.limited, true, '应触发限峰')
  // ceiling=-1 时最高只能到约 -1 LUFS，残差应如实上报（不是静默失败）
  assertClose(result.lufsAfter, -1, 0.6, '限峰后响度')
  assert(result.shortfallDb > 0.3, `残差 ${result.shortfallDb} 应如实上报`)
  assert(result.peakDb <= -1 + 1e-6, `限峰后峰值 ${result.peakDb} 仍超过 ceiling -1`)
  assertNormalizedQuality(left, right, sampleRate, -1, -1, '不可达目标')
  assert(maxAbs(right) === maxAbs(left), '左右声道增益包络应一致')
  return `limited=true，peak ${result.peakDb.toFixed(2)} dBFS，响度 ${result.lufsAfter.toFixed(2)} LUFS，残差 ${result.shortfallDb.toFixed(2)} dB`
})

check('normalizeLoudness：高 crest（4ms 短脉冲 + 低电平底噪，crest>20dB）归一后收在 target±1.5', () => {
  const sampleRate = 48000
  const left = highCrestSignal(4, 0.02, 0.73, sampleRate)
  const right = clone(left)
  const rawLufs = measureIntegratedLufs(left, right, sampleRate)
  const rawPeak = truePeakDb(left, right, sampleRate)
  const crest = rawPeak - rawLufs
  assert(crest > 20, `测试信号 crest 只有 ${crest.toFixed(1)} dB，不够高`)
  const result = normalizeLoudness(left, right, sampleRate, { targetLufs: -14, ceilingDb: -1 })
  assertEq(result.limited, true, '高 crest 素材必须触发限峰')
  assert(result.gainDb > 0, `高 crest 素材应为正增益，实际 ${result.gainDb}`)
  const { lufs, peakDb } = assertNormalizedQuality(left, right, sampleRate, -14, -1, '高 crest')
  assertClose(result.lufsAfter, lufs, 1e-6, '返回值与实测响度')
  assert(Math.abs(result.shortfallDb) <= 1.5, `残差 ${result.shortfallDb.toFixed(2)} 超过 1.5 dB`)
  return `crest ${crest.toFixed(1)} dB，gain ${result.gainDb.toFixed(2)} dB，${rawLufs.toFixed(2)} -> ${lufs.toFixed(2)} LUFS，peak ${peakDb.toFixed(2)} dBFS`
})

check('normalizeLoudness：模拟真实工程口径（raw≈-19.8 LUFS / crest≈17.7 dB）归一后 -14±1', () => {
  const sampleRate = 48000
  const left = highCrestSignal(4, 0.1, 0.73, sampleRate, 220)
  const right = clone(left)
  const rawLufs = measureIntegratedLufs(left, right, sampleRate)
  const rawPeak = truePeakDb(left, right, sampleRate)
  const crest = rawPeak - rawLufs
  assert(crest > 15 && crest < 20, `模拟素材 crest ${crest.toFixed(1)} 不在 15~20 dB`)
  const result = normalizeLoudness(left, right, sampleRate, { targetLufs: -14, ceilingDb: -1 })
  assertEq(result.limited, true, '该素材应触发限峰')
  assertClose(result.lufsAfter, -14, 1, '真实工程口径归一后响度')
  assertNormalizedQuality(left, right, sampleRate, -14, -1, '真实工程口径')
  return `raw ${rawLufs.toFixed(2)} LUFS / crest ${crest.toFixed(1)} dB -> ${result.lufsAfter.toFixed(2)} LUFS，gain ${result.gainDb.toFixed(2)} dB`
})

check('normalizeLoudness：密集瞬态（每 100ms 一个 4ms 脉冲）无贴顶平台且收在 target±1.5', () => {
  const sampleRate = 48000
  const left = highCrestSignal(4, 0.1, 0.73, sampleRate, 220, 0.1, 0.004)
  const right = clone(left)
  const result = normalizeLoudness(left, right, sampleRate, { targetLufs: -14, ceilingDb: -1 })
  assertEq(result.limited, true, '密集瞬态应触发限峰')
  assertNormalizedQuality(left, right, sampleRate, -14, -1, '密集瞬态')
  assertClose(result.lufsAfter, -14, 1.5, '密集瞬态归一后响度')
  return `${result.lufsAfter.toFixed(2)} LUFS / peak ${result.peakDb.toFixed(2)} dBFS，无贴顶平台`
})

check('normalizeLoudness：1kHz 正弦 + 短脉冲 -> target±1.5 且 truePeak ≤ ceiling+0.1', () => {
  const sampleRate = 48000
  const left = highCrestSignal(3, 0.05, 0.95, sampleRate, 1000)
  const right = clone(left)
  const rawPeak = truePeakDb(left, right, sampleRate)
  const rawLufs = measureIntegratedLufs(left, right, sampleRate)
  const result = normalizeLoudness(left, right, sampleRate, { targetLufs: -14, ceilingDb: -1 })
  assertEq(result.limited, true, '正弦 + 脉冲应触发限峰')
  assertClose(result.lufsAfter, -14, 1.5, '正弦+脉冲归一后响度')
  const { lufs, peakDb } = assertNormalizedQuality(left, right, sampleRate, -14, -1, '正弦+脉冲')
  // 需求口径：true peak ≤ ceiling + 0.1 dB（-1 → -0.9）
  assert(peakDb <= -0.9, `true peak ${peakDb.toFixed(3)} 超过 -0.9 dBFS`)
  assert(result.peakDb <= -0.9, `返回值 peakDb ${result.peakDb.toFixed(3)} 超过 -0.9 dBFS`)
  return `raw ${rawLufs.toFixed(2)} LUFS / ${rawPeak.toFixed(2)} dBFS -> ${lufs.toFixed(2)} LUFS / ${peakDb.toFixed(2)} dBFS`
})

check('normalizeLoudness：目标低于当前响度时只衰减、不触发限峰', () => {
  const sampleRate = 48000
  const left = sine(sampleRate, 0.5, 1000, sampleRate)
  const result = normalizeLoudness(left, clone(left), sampleRate, { targetLufs: -30 })
  assertEq(result.limited, false, '衰减不该触发限峰')
  assertClose(result.lufsAfter, -30, 1, '衰减后响度')
  assert(result.gainDb < 0, `衰减增益应为负，实际 ${result.gainDb}`)
  return `gain ${result.gainDb.toFixed(2)} dB`
})

check('normalizeLoudness：静音输入不产生 NaN / ±Infinity 增益', () => {
  const silent = new Float32Array(4800)
  const result = normalizeLoudness(silent, undefined, 48000)
  assertEq(result.gainDb, 0, '静音 gainDb')
  assert(!Number.isNaN(result.lufsBefore), '静音 lufsBefore 是 NaN')
  assert(!Number.isFinite(result.lufsBefore), '静音 lufsBefore 应为 -Infinity')
  assert(!Number.isFinite(result.lufsAfter), '静音 lufsAfter 应为 -Infinity')
  assert(!Number.isNaN(result.lufsAfter), '静音 lufsAfter 是 NaN')
  assertEq(result.limited, false, '静音 limited')
  assert(silent.every((sample) => sample === 0), '静音样本被改动')

  const allNaN = new Float32Array(1024).fill(Number.NaN)
  const nanResult = normalizeLoudness(allNaN, undefined, 48000)
  assert(!Number.isNaN(nanResult.gainDb), '全 NaN 输入 gainDb 是 NaN')
  assert(allNaN.every((sample) => sample === 0), '全 NaN 输入归一后没有清成 0')
  return '安全兜底'
})

check('normalizeLoudness：含 NaN 样本归一后无 NaN 残留', () => {
  const sampleRate = 48000
  const left = sine(sampleRate, 0.2, 1000, sampleRate)
  for (let i = 0; i < left.length; i += 53) left[i] = Number.NaN
  const result = normalizeLoudness(left, undefined, sampleRate, { targetLufs: -14 })
  assert(left.every((sample) => Number.isFinite(sample)), '归一后仍残留 NaN')
  assert(Number.isFinite(result.lufsAfter) || !Number.isNaN(result.lufsAfter), '结果字段出现 NaN')
  assert(result.peakDb <= -1 + 1e-6, `峰值 ${result.peakDb} 超过 ceiling`)
  return `lufsAfter ${result.lufsAfter.toFixed(2)} LUFS`
})

/* ================================================================== */
/* C) MIDI 中立混音 CC                                                 */
/* ================================================================== */

section('C) MIDI 混音 CC（packages/core/src/midi.ts）')

check('mixControls=neutral：CC7=127 / CC10=64 / CC91=0 / CC93=0（含 74/1 回中）', () => {
  const bytes = midi.projectToMidiBytes(buildMidiFixture(), { mixControls: 'neutral' })
  const parsed = parseSmf(bytes)
  assertEq(parsed.format, 1, 'SMF 格式')
  assertEq(parsed.tracks.length, 3, '轨道块数（1 个 tempo 轨 + 2 个乐器轨）')
  const controls = collectControlChanges(parsed)
  assertEq(controls.size, 2, '带 CC 的通道数')
  for (const [channel, map] of controls) {
    assertEq(map.get(7), 127, `ch${channel} CC7（音量中性值）`)
    assertEq(map.get(10), 64, `ch${channel} CC10（声像居中）`)
    assertEq(map.get(91), 0, `ch${channel} CC91（混响发送归零）`)
    assertEq(map.get(93), 0, `ch${channel} CC93（合唱深度归零）`)
    assertEq(map.get(74), 64, `ch${channel} CC74（亮度回中）`)
    assertEq(map.get(1), 0, `ch${channel} CC1（颤音归零）`)
  }
  return `${controls.size} 个通道均写入中性 CC`
})

check('mixControls=mix：仍是旧公式值（CC7=50 / CC10=0 / CC91=23 / CC93=8）', () => {
  const bytes = midi.projectToMidiBytes(buildMidiFixture(), { mixControls: 'mix' })
  const controls = collectControlChanges(parseSmf(bytes))
  assertEq(controls.size, 2, '带 CC 的通道数')
  for (const [channel, map] of controls) {
    // volume=0.5 -> round(0.5*100)=50；pan=-1 -> round((-1+1)*63.5)=0
    // reverbSend=0.18 -> round(0.18*127)=23；delaySend=0.06 -> round(0.06*127)=8
    assertEq(map.get(7), 50, `ch${channel} CC7（旧公式）`)
    assertEq(map.get(10), 0, `ch${channel} CC10（旧公式）`)
    assertEq(map.get(91), 23, `ch${channel} CC91（旧公式）`)
    assertEq(map.get(93), 8, `ch${channel} CC93（旧公式）`)
  }
  return '历史行为保持不变'
})

check('mixControls=omit：完全不写混音 CC', () => {
  const bytes = midi.projectToMidiBytes(buildMidiFixture(), { mixControls: 'omit' })
  const controls = collectControlChanges(parseSmf(bytes))
  assertEq(controls.size, 0, 'omit 模式仍写入了 CC')
  return '无 CC 事件'
})

/* ------------------------------------------------------------------ */
/* 汇总                                                                */
/* ------------------------------------------------------------------ */

const total = passed + failed
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
console.log('')
if (failed === 0) {
  console.log(`${C.green}${C.bold}✓ 渲染底层单元测试全部通过${C.reset}  ${passed}/${total} 项  ${C.dim}${seconds}s${C.reset}\n`)
  process.exit(0)
}
console.log(`${C.red}${C.bold}✗ ${failed} 项失败${C.reset}  ${passed}/${total} 通过  ${C.dim}${seconds}s${C.reset}\n`)
for (const failure of failures) console.log(`  ${C.red}–${C.reset} ${failure}`)
console.log('')
process.exit(1)
