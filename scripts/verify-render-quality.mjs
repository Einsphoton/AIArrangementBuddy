#!/usr/bin/env node
/**
 * 渲染质量验收（P0「MIDI → 音频」修复）—— 独立脚本，自包含、不装依赖、不污染用户数据。
 *
 * 做法：用**构建后的生产产物**（`apps/server/dist/server.mjs` + `SERVE_STATIC=1`）在临时
 * DATA_DIR 上起一个独立服务，再用 headless Chrome + CDP 打开真实界面，在页面内直接调用
 * `window.AIAB.engine.renderToWav(project, options)` / `window.AIAB.audio.bounceTrack(trackId)`，
 * 把 WAV 分块回传到 Node 侧逐样本分析，验证：
 *
 *   1) 整工程 @48kHz / 24-bit / -14 LUFS：WAV 头（48000 / 24 / 2ch）、时长 ≈ 21.78s、
 *      峰值 ≤ -0.9 dBFS（最终峰值保护 + 量化容差）、无削顶样本；
 *   2) 对齐：只渲染主旋律轨（`trackIds:['t_3vkd4tyh']`，44.1k/16bit）：
 *      首个非静音样本 ≈ clip 起点（第 8 拍 = 4.444s ±50ms）；
 *      第 8 拍音符（pitch 64/65/67）基频能量在「正确位置」比「提前 4.444s」高 ≥ 6dB（Goertzel）；
 *   3) 电平一致性：SoundFont 版 vs 强制 synth 版（track.engine='synth'）RMS 差 ≤ 5dB，且都不削顶；
 *      （回归护栏：修复前差 15.1dB；修复后实测 3.2–4.2dB（Tone patch 本身比采样响），阈值只拦系统性失衡）
 *   4) 选项：bitDepth 16 / 24 的 WAV 头字段与体积比；loudnessTargetLufs -14 vs null 的
 *      BS.1770 积分响度（归一版应更接近 -14 LUFS，宽容 ±3dB 断言；lookahead limiter 升级后应 -14±1）；
 *   5) 单轨 bounce：`window.AIAB.audio.bounceTrack('t_3vkd4tyh')` 后新增 kind='audio' 轨、
 *      audioClips 非空、clip.startBeat === 0、原轨 mute === true（API 不存在则明确报未就绪）；
 *   6) 导出对话框：打开 WAV 格式后，采样率默认 48000、位深默认 24、响度归一默认开，
 *      质量摘要显示 48kHz / 24-bit（防止 UI 选项被改坏）。
 *
 * 安全约束：
 *   - 只用临时 DATA_DIR（`os.tmpdir()` 下 mkdtemp），音色库从 `data/soundfonts` 复制；
 *   - 独立端口（默认 8896），绝不连接/停止 8787 或 5183 上运行中的应用；
 *   - 工程数据由 Node 读取后注入页面内存（`setProject(..., { dirty:false })`），
 *     并在页面内拦截对 `/api/projects/*` 的非 GET 请求（防止自动保存写回）；
 *   - 结束清理 Chrome / 服务端 / 临时目录；`--keep` 保留临时目录（含 WAV）便于排查。
 *
 * 用法：
 *   node scripts/verify-render-quality.mjs             # 先 node scripts/build.mjs，再全量验收
 *   node scripts/verify-render-quality.mjs --no-build  # 直接用现有构建产物（源码未改时更快）
 *   node scripts/verify-render-quality.mjs --keep      # 保留临时目录与 WAV 产物
 *   node scripts/verify-render-quality.mjs --port 8896 # 自定义临时服务端口
 *   CHROME_PATH=/path/to/chrome node scripts/verify-render-quality.mjs
 *
 * 退出码：0 全部通过；1 有检查失败；2 脚本自身异常（构建失败 / 环境缺失 / 启动失败）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/* ------------------------------------------------------------------ */
/* 0. 常量 / CLI                                                       */
/* ------------------------------------------------------------------ */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_ID = 'p_rdew9m4a'
const PROJECT_FILE = path.join(ROOT, 'data', 'projects', `${PROJECT_ID}.json`)
const SOUNDFONT_SRC = path.join(ROOT, 'data', 'soundfonts', 'MuseScore_General.sf3')
const ALIGN_TRACK_ID = 't_3vkd4tyh'

const clipArg = (name) => {
  const prefix = `${name}=`
  const index = process.argv.findIndex((item) => item === name || item.startsWith(prefix))
  if (index < 0) return undefined
  const raw = process.argv[index]
  return raw === name ? process.argv[index + 1] : raw.slice(prefix.length)
}
const KEEP = process.argv.includes('--keep') || process.env.VERIFY_KEEP === '1'
const NO_BUILD = process.argv.includes('--no-build')
const PORT = Number(clipArg('--port') ?? process.env.VERIFY_PORT ?? 8896)
const BASE = `http://127.0.0.1:${PORT}`

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', gold: '\x1b[33m', bold: '\x1b[1m' }

let passed = 0
let failed = 0
let skipped = 0
const failures = []
const T0 = Date.now()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const stamp = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`
const log = (...args) => console.log(`${C.dim}[${stamp()}]${C.reset}`, ...args)
const section = (title) => console.log(`\n${C.gold}${C.bold}${title}${C.reset}`)
const info = (message) => console.log(`  ${C.dim}· ${message}${C.reset}`)
const warn = (message) => console.log(`  ${C.gold}! ${message}${C.reset}`)

function expect(condition, label, detail) {
  const suffix = detail ? `  ${C.dim}${detail}${C.reset}` : ''
  if (condition) {
    passed++
    console.log(`  ${C.green}✓${C.reset} ${label}${suffix}`)
  } else {
    failed++
    failures.push(detail ? `${label}（${detail}）` : label)
    console.log(`  ${C.red}✗${C.reset} ${label}${suffix}`)
  }
  return Boolean(condition)
}

function bad(label, error) {
  failed++
  const detail = error ? String(error).split('\n')[0].slice(0, 300) : ''
  failures.push(detail ? `${label}（${detail}）` : label)
  console.log(`  ${C.red}✗${C.reset} ${label}${detail ? `  ${C.dim}${detail}${C.reset}` : ''}`)
}

const shortError = (error) => String(error?.message ?? error).split('\n')[0].slice(0, 300)
const fmtBytes = (bytes) => (typeof bytes === 'number' && Number.isFinite(bytes) ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : '—')
const fmtDb = (value) => (typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)} dB` : '-inf')
const fmtDbfs = (value) => (typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)} dBFS` : '-inf')
const fmtSec = (value) => (typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(3)}s` : '—')

/* 共享运行状态（cleanup 用） */
const state = { tempDir: null, artifactsDir: null, server: null, chrome: null, page: null, userProjectShaBefore: null }

/* ------------------------------------------------------------------ */
/* 1. 通用工具：端口 / Chrome / 哈希                                   */
/* ------------------------------------------------------------------ */

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean)
  return candidates.find((file) => existsSync(file)) ?? null
}

function sha256File(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 2. WAV 解析 / 逐样本统计 / Goertzel / BS.1770 积分响度              */
/* ------------------------------------------------------------------ */

const dbOf = (value) => (value > 0 ? 20 * Math.log10(value) : Number.NEGATIVE_INFINITY)

/** 解析 WAV 头 + 解码左右声道 + 计算峰值 / RMS / 削顶 / 静音 / 起止 */
function readWav(buffer, name) {
  if (buffer.length < 44) throw new Error(`WAV 过短：${buffer.length} 字节`)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const id = (offset) =>
    String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
  const root = { riff: id(0), wave: id(8), riffSize: view.getUint32(4, true), byteLength: buffer.length }
  let fmt = null
  let data = null
  const chunkIds = []
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const chunkId = id(offset)
    const chunkSize = view.getUint32(offset + 4, true)
    chunkIds.push(chunkId.trim() || '?')
    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: view.getUint16(offset + 8, true),
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        byteRate: view.getUint32(offset + 16, true),
        blockAlign: view.getUint16(offset + 20, true),
        bitsPerSample: view.getUint16(offset + 22, true),
      }
    } else if (chunkId === 'data') {
      data = { offset: offset + 8, size: chunkSize }
    }
    offset += 8 + chunkSize + (chunkSize % 2)
  }
  if (!fmt || !data) throw new Error(`WAV 缺少 fmt/data 块：${name}`)

  const bytesPerSample = fmt.bitsPerSample / 8
  const blockAlign = fmt.blockAlign || fmt.channels * bytesPerSample
  const frames = Math.max(0, Math.floor(Math.min(data.size, buffer.length - data.offset) / blockAlign))
  const hasRight = fmt.channels > 1
  const readSample = (frame, channel) => {
    const base = data.offset + frame * blockAlign + channel * bytesPerSample
    if (fmt.bitsPerSample === 16) return view.getInt16(base, true) / 32768
    if (fmt.bitsPerSample === 24) {
      /* 24-bit signed little-endian：3 字节补码 */
      const b0 = view.getUint8(base)
      const b1 = view.getUint8(base + 1)
      const b2 = view.getInt8(base + 2)
      return (b0 | (b1 << 8) | (b2 << 16)) / 8388608
    }
    if (fmt.bitsPerSample === 32 && fmt.audioFormat === 1) return view.getInt32(base, true) / 2147483648
    if (fmt.bitsPerSample === 32) return view.getFloat32(base, true)
    return view.getInt8(base) / 128
  }

  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  let peak = 0
  let clippedSamples = 0
  let silentFrames = 0
  let firstNonSilent = -1
  let lastNonSilent = -1
  let sumL = 0
  let sumR = 0
  let sumL2 = 0
  let sumR2 = 0
  let sumLR = 0
  let sumAll2 = 0
  for (let frame = 0; frame < frames; frame++) {
    const l = readSample(frame, 0)
    const r = hasRight ? readSample(frame, 1) : l
    left[frame] = l
    right[frame] = r
    const al = Math.abs(l)
    const ar = Math.abs(r)
    if (al > peak) peak = al
    if (ar > peak) peak = ar
    if (al >= 0.999) clippedSamples++
    if (hasRight && ar >= 0.999) clippedSamples++
    sumL += l
    sumR += r
    sumL2 += l * l
    sumR2 += r * r
    sumLR += l * r
    sumAll2 += l * l + r * r
    if (Math.max(al, ar) < 1e-4) {
      silentFrames++
    } else {
      if (firstNonSilent < 0) firstNonSilent = frame
      lastNonSilent = frame
    }
  }
  const channels = Math.max(1, fmt.channels)
  const sampleRate = fmt.sampleRate
  return {
    name,
    file: null,
    byteLength: buffer.length,
    header: {
      ...root,
      ...fmt,
      chunkIds,
      dataSize: data.size,
      dataOffset: data.offset,
      frameCount: frames,
      dataConsistent: data.offset + data.size === buffer.length && data.size === frames * blockAlign,
    },
    frames,
    durationSec: sampleRate > 0 ? frames / sampleRate : 0,
    peak,
    peakDbfs: dbOf(peak),
    rmsDbfs: dbOf(Math.sqrt(sumAll2 / Math.max(1, frames * channels))),
    rmsLDbfs: dbOf(Math.sqrt(sumL2 / Math.max(1, frames))),
    rmsRDbfs: dbOf(Math.sqrt(sumR2 / Math.max(1, frames))),
    correlationLR: sumL2 > 0 && sumR2 > 0 ? sumLR / Math.sqrt(sumL2 * sumR2) : hasRight ? 0 : 1,
    dcOffsetL: sumL / Math.max(1, frames),
    dcOffsetR: sumR / Math.max(1, frames),
    silentRatio: frames > 0 ? silentFrames / frames : 1,
    clippedSamples,
    clipped: clippedSamples > 0,
    firstNonSilentSec: firstNonSilent < 0 ? null : firstNonSilent / sampleRate,
    lastNonSilentSec: lastNonSilent < 0 ? null : lastNonSilent / sampleRate,
    left,
    right,
  }
}

/** 下混为单声道（(L+R)/2），供 Goertzel 用 */
function mixdown(wav) {
  const frames = wav.frames
  const mono = new Float32Array(frames)
  for (let i = 0; i < frames; i++) mono[i] = (wav.left[i] + wav.right[i]) * 0.5
  return mono
}

/**
 * Goertzel：在 [startSec, startSec+lenSec) 内估计 freq 的能量。
 * 与 .runtime/research/analyze-pitch-agg.mjs 的写法一致（幅度平方 / n²）。
 */
function goertzel(samples, sampleRate, freq, startSec, lenSec) {
  const start = Math.max(0, Math.round(startSec * sampleRate))
  const count = Math.min(Math.round(lenSec * sampleRate), samples.length - start)
  if (count <= 8) return 0
  const w = (2 * Math.PI * freq) / sampleRate
  const c = 2 * Math.cos(w)
  let a = 0
  let b = 0
  for (let i = 0; i < count; i++) {
    const v = samples[start + i] + c * a - b
    b = a
    a = v
  }
  return (a * a + b * b - c * a * b) / (count * count)
}

const energyDb = (energy) => (energy > 1e-20 ? 10 * Math.log10(energy) : -200)

/** BS.1770 两级 K 加权（高架 + 高通）的 biquad 系数 */
function highShelfCoeffs(sampleRate) {
  /* 与 ITU-R BS.1770-4 / libebur128 一致的设计参数（在 48kHz 下给出标准系数） */
  const f0 = 1681.974450955533
  const gainDb = 3.999843853973347
  const q = 0.7071752369554196
  const k = Math.tan((Math.PI * f0) / sampleRate)
  const vh = 10 ** (gainDb / 20)
  const vb = vh ** 0.4996667741545416
  const a0 = 1 + k / q + k * k
  return {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  }
}

function highPassCoeffs(sampleRate) {
  const f0 = 38
  const q = 0.5
  const k = Math.tan((Math.PI * f0) / sampleRate)
  const a0 = 1 + k / q + k * k
  return {
    b0: 1 / a0,
    b1: -2 / a0,
    b2: 1 / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  }
}

/** 直接 I 型转置（DF2T）biquad，原地不改输入 */
function applyBiquad(input, coeffs) {
  const { b0, b1, b2, a1, a2 } = coeffs
  const out = new Float32Array(input.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x = input[i]
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    out[i] = y
  }
  return out
}

/** 积分响度（LUFS）：400ms 块 / 75% 重叠 / -70 LUFS 绝对门限 / -10 LU 相对门限 */
function integratedLufs(wav) {
  const sampleRate = wav.header.sampleRate
  const left = applyBiquad(applyBiquad(wav.left, highShelfCoeffs(sampleRate)), highPassCoeffs(sampleRate))
  const mono = wav.header.channels < 2
  const right = mono ? null : applyBiquad(applyBiquad(wav.right, highShelfCoeffs(sampleRate)), highPassCoeffs(sampleRate))
  const frames = left.length
  if (frames === 0) return Number.NEGATIVE_INFINITY
  const blockSize = Math.max(1, Math.round(0.4 * sampleRate))
  const hop = Math.max(1, Math.round(0.1 * sampleRate))
  const energies = []
  if (frames < blockSize) {
    let sum = 0
    for (let i = 0; i < frames; i++) sum += left[i] * left[i] + (right ? right[i] * right[i] : 0)
    energies.push(sum / frames)
  } else {
    for (let start = 0; start + blockSize <= frames; start += hop) {
      let sum = 0
      for (let i = start; i < start + blockSize; i++) sum += left[i] * left[i] + (right ? right[i] * right[i] : 0)
      energies.push(sum / blockSize)
    }
  }
  const blockLoudness = (energy) => (energy > 0 ? -0.691 + 10 * Math.log10(energy) : Number.NEGATIVE_INFINITY)
  const gated = energies.filter((energy) => blockLoudness(energy) > -70)
  if (gated.length === 0) return Number.NEGATIVE_INFINITY
  const meanGated = gated.reduce((sum, energy) => sum + energy, 0) / gated.length
  const relativeThreshold = blockLoudness(meanGated) - 10
  const kept = gated.filter((energy) => blockLoudness(energy) > relativeThreshold)
  const meanKept = kept.length > 0 ? kept.reduce((sum, energy) => sum + energy, 0) / kept.length : meanGated
  return blockLoudness(meanKept)
}

const midiFrequency = (pitch) => 440 * 2 ** ((pitch - 69) / 12)

/**
 * 对齐分析：对「clip 起点处的音符」比较两个位置的基频能量：
 * - 正确位置：clipStart + 音符相对时间（在窗口内扫 ±60ms 取最大）；
 * - 提前 clipStart 秒：若渲染丢绝对时间轴（历史缺陷），能量会集中到这里。
 */
function analyzeAlignment(wav, clipStartSec, notes) {
  const mono = mixdown(wav)
  const sampleRate = wav.header.sampleRate
  const offsets = [-0.06, -0.03, 0, 0.03, 0.06]
  const rows = notes.map((note) => {
    const frequency = midiFrequency(note.pitch)
    let correct = 0
    let shifted = 0
    for (const offset of offsets) {
      correct = Math.max(correct, goertzel(mono, sampleRate, frequency, note.timeSec + offset, 0.18))
      shifted = Math.max(shifted, goertzel(mono, sampleRate, frequency, note.timeSec - clipStartSec + offset, 0.18))
    }
    return { pitch: note.pitch, timeSec: note.timeSec, frequency, correct, shifted, correctDb: energyDb(correct), shiftedDb: energyDb(shifted) }
  })
  const mean = (values) => (values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NEGATIVE_INFINITY)
  return {
    rows,
    avgCorrectDb: mean(rows.map((row) => row.correctDb)),
    avgShiftedDb: mean(rows.map((row) => row.shiftedDb)),
    diffDb: mean(rows.map((row) => row.correctDb)) - mean(rows.map((row) => row.shiftedDb)),
  }
}

/* ------------------------------------------------------------------ */
/* 3. 工程 / 期望值                                                    */
/* ------------------------------------------------------------------ */

function loadProject() {
  if (!existsSync(PROJECT_FILE)) throw new Error(`找不到测试工程：${PROJECT_FILE}`)
  const project = JSON.parse(readFileSync(PROJECT_FILE, 'utf8'))
  if (!Array.isArray(project.tracks) || project.tracks.length === 0) throw new Error('测试工程没有轨道')
  return project
}

function summarizeProject(project) {
  let endBeat = 0
  let noteCount = 0
  for (const track of project.tracks) {
    for (const clip of track.clips ?? []) {
      endBeat = Math.max(endBeat, (clip.startBeat ?? 0) + (clip.lengthBeats ?? 0))
      noteCount += clip.notes?.length ?? 0
    }
  }
  return { endBeat, noteCount, tempo: project.tempo, tracks: project.tracks.length }
}

function computeExpectations(project) {
  const tempo = Number(project.tempo) || 120
  const secPerBeat = 60 / tempo
  const { endBeat } = summarizeProject(project)
  /* 渲染时长规则（见 apps/web/src/audio/render.ts）：projectDurationSeconds（末拍 + 2s）+ tailSeconds（默认 2s） */
  const durationSec = (endBeat / tempo) * 60 + 2 + 2

  const track = project.tracks.find((item) => item.id === ALIGN_TRACK_ID) ?? project.tracks.find((item) => item.clips?.length)
  if (!track) throw new Error(`找不到用于对齐测试的轨道（${ALIGN_TRACK_ID}）`)
  const clip = track.clips.find((item) => item.startBeat > 0) ?? track.clips[0]
  const clipStartSec = clip.startBeat * secPerBeat

  /* 第 8 拍附近（clip 内前 1.2 拍）的音符；优先用任务指定的 pitch 64/65/67 */
  const nearby = clip.notes
    .filter((note) => note.start < 1.2)
    .map((note) => ({ pitch: Math.round(note.pitch), timeSec: (clip.startBeat + note.start) * secPerBeat }))
  const wanted = [64, 65, 67].map((pitch) => nearby.find((note) => note.pitch === pitch)).filter(Boolean)
  const alignNotes = wanted.length > 0 ? wanted : nearby.slice(0, 3)
  if (alignNotes.length === 0) throw new Error(`对齐轨道 ${track.id} 的前 1.2 拍没有音符`)

  return {
    tempo,
    secPerBeat,
    endBeat,
    durationSec,
    alignTrackId: track.id,
    alignClipStartBeat: clip.startBeat,
    alignStartSec: clipStartSec,
    alignNotes,
  }
}

/* ------------------------------------------------------------------ */
/* 4. 构建 / 临时数据目录 / 服务端                                     */
/* ------------------------------------------------------------------ */

function buildApp() {
  console.log(`\n${C.gold}▶${C.reset} 构建生产产物  ${C.dim}node scripts/build.mjs${C.reset}`)
  const started = Date.now()
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs')], { cwd: ROOT, stdio: 'inherit', env: process.env })
  if (result.error) throw new Error(`构建进程启动失败：${result.error.message}`)
  if (result.status !== 0) throw new Error(`构建失败（exit=${result.status ?? result.signal}）`)
  console.log(`${C.dim}  构建耗时 ${((Date.now() - started) / 1000).toFixed(1)}s${C.reset}`)
}

function assertBuildArtifacts() {
  const serverEntry = path.join(ROOT, 'apps', 'server', 'dist', 'server.mjs')
  const webEntry = path.join(ROOT, 'apps', 'web', 'dist', 'index.html')
  if (!existsSync(serverEntry)) throw new Error(`未找到后端构建产物：${serverEntry}（先运行 node scripts/build.mjs）`)
  if (!existsSync(webEntry)) throw new Error(`未找到前端构建产物：${webEntry}（先运行 node scripts/build.mjs）`)
  return { serverEntry, webEntry }
}

function prepareTempDir() {
  if (!existsSync(SOUNDFONT_SRC)) throw new Error(`找不到音色库：${SOUNDFONT_SRC}`)
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'aiab-render-quality-'))
  const artifactsDir = path.join(tempDir, 'audio')
  for (const sub of ['projects', 'soundfonts', 'assets', 'audio', 'chrome-profile']) mkdirSync(path.join(tempDir, sub), { recursive: true })

  const sourceSize = statSync(SOUNDFONT_SRC).size
  const started = Date.now()
  copyFileSync(SOUNDFONT_SRC, path.join(tempDir, 'soundfonts', path.basename(SOUNDFONT_SRC)))
  const copiedSize = statSync(path.join(tempDir, 'soundfonts', path.basename(SOUNDFONT_SRC))).size
  if (copiedSize !== sourceSize) throw new Error(`音色库复制不完整：${copiedSize} != ${sourceSize}`)

  state.tempDir = tempDir
  state.artifactsDir = artifactsDir
  info(`临时数据目录 ${tempDir}`)
  info(`音色库已复制（${fmtBytes(sourceSize)}，耗时 ${Date.now() - started}ms）`)
  return { tempDir, artifactsDir }
}

function startServer(serverEntry) {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: state.tempDir,
      SERVE_STATIC: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logText = ''
  const append = (chunk) => {
    logText += String(chunk)
    if (logText.length > 200_000) logText = logText.slice(-100_000)
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  const server = { child, getLog: () => logText }
  state.server = server
  return server
}

async function waitForServer(server) {
  const started = Date.now()
  while (Date.now() - started < 60_000) {
    if (server.child.exitCode !== null) {
      throw new Error(`后端进程提前退出（exit=${server.child.exitCode}）\n${server.getLog().split('\n').slice(-20).join('\n')}`)
    }
    try {
      const response = await fetch(`${BASE}/api/health`)
      if (response.ok) return await response.json()
    } catch {
      /* 还没起来 */
    }
    await sleep(300)
  }
  throw new Error(`后端启动超时（60s）\n${server.getLog().split('\n').slice(-20).join('\n')}`)
}

/* ------------------------------------------------------------------ */
/* 5. CDP 客户端 / 页面封装                                            */
/* ------------------------------------------------------------------ */

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.handlers = new Map()
    ws.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(`${message.method ?? 'cdp'}: ${message.error.message}`))
        else resolve(message.result)
        return
      }
      const list = this.handlers.get(message.method)
      if (list) for (const handler of list) handler(message.params)
    }
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'))
    })
    return new Cdp(ws)
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, handler) {
    const list = this.handlers.get(method) ?? []
    list.push(handler)
    this.handlers.set(method, list)
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

class Page {
  constructor(cdp) {
    this.cdp = cdp
    this.consoleMessages = []
    this.exceptions = []
    cdp.on('Runtime.consoleAPICalled', (params) => {
      const text = (params.args ?? [])
        .map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description !== undefined ? String(arg.description) : ''))
        .join(' ')
      this.consoleMessages.push({ type: params.type, text })
    })
    cdp.on('Runtime.exceptionThrown', (params) => {
      const detail = params.exceptionDetails ?? {}
      this.exceptions.push(detail?.exception?.description ?? detail?.text ?? 'unknown exception')
    })
    cdp.on('Log.entryAdded', (params) => {
      const entry = params.entry ?? {}
      if (entry.level === 'error' || entry.level === 'warning') this.consoleMessages.push({ type: `log:${entry.level}`, text: String(entry.text ?? '') })
    })
  }

  async init() {
    await this.cdp.send('Runtime.enable')
    await this.cdp.send('Page.enable')
    try {
      await this.cdp.send('Log.enable')
    } catch {
      /* ignore */
    }
  }

  async goto(url) {
    await this.cdp.send('Page.navigate', { url })
    await sleep(1200)
  }

  async evaluate(body, { timeoutMs = 300_000 } = {}) {
    const expression = `(async () => { ${body} })()`
    const call = this.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    let timer = null
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`页面脚本执行超时（${timeoutMs}ms）`)), timeoutMs)
    })
    let result
    try {
      result = await Promise.race([call, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '页面脚本执行失败')
    }
    return result.result.value
  }

  async waitFor(expression, timeoutMs = 30_000, intervalMs = 250) {
    const started = Date.now()
    let lastError = null
    while (Date.now() - started < timeoutMs) {
      try {
        if (await this.evaluate(`return !!(${expression})`, { timeoutMs: 15000 })) return true
      } catch (error) {
        lastError = error
      }
      await sleep(intervalMs)
    }
    throw new Error(`等待超时：${expression}${lastError ? `（最后错误：${lastError.message}）` : ''}`)
  }

  close() {
    this.cdp.close()
  }
}

function findChromeLogTail(chrome) {
  const text = chrome?.getLog?.() ?? ''
  return text.split('\n').filter(Boolean).slice(-8).join('\n')
}

async function launchChrome(profileDir) {
  const chromePath = findChrome()
  if (!chromePath) throw new Error('未找到 Chrome/Chromium（可用 CHROME_PATH 指定）')
  const debugPort = await freePort()
  const child = spawn(
    chromePath,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-crashpad',
      '--disable-background-networking',
      '--disable-default-apps',
      '--hide-scrollbars',
      '--no-first-run',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=1680,1050',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let logText = ''
  const append = (chunk) => {
    logText += String(chunk)
    if (logText.length > 100_000) logText = logText.slice(-50_000)
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)

  let wsUrl = null
  let version = null
  for (let i = 0; i < 120 && !wsUrl; i++) {
    await sleep(150)
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      wsUrl = targets.find((target) => target.type === 'page')?.webSocketDebuggerUrl ?? null
      if (wsUrl) {
        const versionInfo = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()
        version = versionInfo.Browser ?? null
      }
    } catch {
      /* 还没起来 */
    }
  }
  if (!wsUrl) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    throw new Error(`无法连接 Chrome DevTools（headless 启动失败）\n${logText.split('\n').slice(-10).join('\n')}`)
  }
  const chrome = { child, chromePath, debugPort, wsUrl, version, getLog: () => logText }
  state.chrome = chrome
  return chrome
}

/* ------------------------------------------------------------------ */
/* 6. 页面内注入的辅助函数                                             */
/* ------------------------------------------------------------------ */

const PAGE_HELPERS = String.raw`
window.__vrq = window.__vrq || {
  blobs: {},
  bytes: {},
  renders: [],
  variants: {},
  sfCalls: 0,
  blockedWrites: [],
  project: null,
  guardInstalled: false,
  sfWrapped: false,
};

/* 防自动保存写回：拦截对 /api/projects/ 的非 GET 请求（只包一层页面 fetch，不改应用源码） */
if (!window.__vrq.guardInstalled) {
  const originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (/\/api\/projects\//.test(url) && method !== 'GET') {
      window.__vrq.blockedWrites.push(method + ' ' + url);
      return Promise.reject(new Error('verify-render-quality: blocked project write'));
    }
    return originalFetch(input, init);
  };
  window.__vrq.guardInstalled = true;
}

/* 注入待测工程（仅内存）：生成 full / synth 两个渲染变体 */
window.__vrqSetProject = function (project) {
  const APP = window.AIAB;
  const clone = function (value) { return JSON.parse(JSON.stringify(value)); };
  window.__vrq.project = clone(project);
  const variants = { full: clone(project) };
  variants.synth = Object.assign(clone(project), {
    tracks: project.tracks.map(function (track) { return Object.assign(clone(track), { engine: 'synth' }); }),
  });
  window.__vrq.variants = variants;
  APP.useStore.getState().setProject(clone(project), { resetHistory: true, dirty: false });
  return { id: APP.useStore.getState().project.id, tracks: APP.useStore.getState().project.tracks.length };
};

/* 确保 store 里仍是注入工程（页面初始加载可能异步覆盖） */
window.__vrqEnsureProject = function () {
  const APP = window.AIAB;
  const current = APP.useStore.getState().project;
  if (!current || !window.__vrq.project || current.id !== window.__vrq.project.id) {
    APP.useStore.getState().setProject(JSON.parse(JSON.stringify(window.__vrq.project)), { resetHistory: true, dirty: false });
  }
  const state = APP.useStore.getState();
  return {
    id: state.project ? state.project.id : null,
    name: state.project ? state.project.name : null,
    tracks: state.project ? state.project.tracks.length : 0,
    saveStatus: state.saveStatus,
  };
};

/* 引擎信息 + 等 SoundFont 就绪 + 包一层 renderOffline 计数 */
window.__vrqEngineInfo = async function () {
  const APP = window.AIAB;
  let initError = null;
  const initStarted = performance.now();
  try { await APP.engine.init(); } catch (error) { initError = String((error && error.stack) || error); }
  const initMs = performance.now() - initStarted;

  const waitStarted = performance.now();
  let lastError = null;
  while (performance.now() - waitStarted < 90000) {
    const sf = APP.engine.soundfont;
    if (sf && sf.usable) break;
    if (sf && sf.error) {
      lastError = sf.error;
      if (performance.now() - waitStarted > 20000) break;
    }
    await new Promise(function (resolve) { setTimeout(resolve, 200); });
  }
  const soundfontWaitMs = performance.now() - waitStarted;

  if (!window.__vrq.sfWrapped) {
    const sf = APP.engine.soundfont;
    if (sf && typeof sf.renderOffline === 'function') {
      const original = sf.renderOffline.bind(sf);
      sf.renderOffline = function () {
        window.__vrq.sfCalls = (window.__vrq.sfCalls || 0) + 1;
        return original.apply(null, arguments);
      };
      window.__vrq.sfWrapped = true;
    }
  }

  const sf = APP.engine.soundfont;
  return {
    initMs: initMs,
    initError: initError,
    soundfontWaitMs: soundfontWaitMs,
    usable: !!(sf && sf.usable),
    loaded: !!(sf && sf.loaded),
    loading: !!(sf && sf.loading),
    name: sf ? sf.name : null,
    error: (sf && sf.error) || lastError,
  };
};

/* 一次真实离线渲染：Blob 留在页面内，只回传计时 / 大小 / SoundFont 调用次数 */
window.__vrqRender = async function (name, variantKey, options, timeoutMs) {
  const APP = window.AIAB;
  const project = window.__vrq.variants[variantKey];
  if (!project) throw new Error('未知渲染变体：' + variantKey);
  const sfBefore = window.__vrq.sfCalls || 0;
  const startedAt = performance.now();
  let blob = null;
  let error = null;
  try {
    blob = await Promise.race([
      APP.engine.renderToWav(JSON.parse(JSON.stringify(project)), options || {}),
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error('渲染超时（' + timeoutMs + 'ms）')); }, timeoutMs);
      }),
    ]);
  } catch (caught) {
    error = String((caught && (caught.stack || caught.message)) || caught);
  }
  const renderMs = performance.now() - startedAt;
  const record = {
    name: name,
    variantKey: variantKey,
    options: options || {},
    renderMs: renderMs,
    size: blob ? blob.size : 0,
    type: blob ? blob.type : null,
    error: error,
    soundfontCalls: (window.__vrq.sfCalls || 0) - sfBefore,
  };
  if (blob) window.__vrq.blobs[name] = blob;
  window.__vrq.renders.push(record);
  return record;
};

/* 把 Blob 读成 Uint8Array 留在页面，供分块回传 */
window.__vrqMaterialize = async function (name) {
  const blob = window.__vrq.blobs[name];
  if (!blob) throw new Error('Blob 不存在：' + name);
  const buffer = await blob.arrayBuffer();
  window.__vrq.bytes[name] = new Uint8Array(buffer);
  return window.__vrq.bytes[name].length;
};

/* 分块回传（base64）：避免依赖浏览器下载行为，也不落用户目录 */
window.__vrqChunk = function (name, offset, size) {
  const bytes = window.__vrq.bytes[name];
  if (!bytes) throw new Error('bytes 不存在：' + name);
  const end = Math.min(bytes.length, offset + size);
  let text = '';
  const step = 0x8000;
  for (let index = offset; index < end; index += step) {
    text += String.fromCharCode.apply(null, bytes.subarray(index, Math.min(end, index + step)));
  }
  return { b64: btoa(text), next: end, total: bytes.length };
};

/* 释放页面内缓冲，避免多次渲染累积内存 */
window.__vrqRelease = function (name) {
  delete window.__vrq.bytes[name];
  delete window.__vrq.blobs[name];
  return true;
};

/* SoundFont 状态快照（诊断用） */
window.__vrqSoundfont = function () {
  const sf = window.AIAB.engine.soundfont;
  return sf ? { usable: !!sf.usable, loaded: !!sf.loaded, loading: !!sf.loading, name: sf.name, error: sf.error } : null;
};

/* 单轨 bounce：调用 window.AIAB.audio.bounceTrack(trackId)，返回前后工程快照 */
window.__vrqBounce = async function (trackId, timeoutMs) {
  const APP = window.AIAB;
  const api = APP.audio || {};
  const fn = typeof api.bounceTrack === 'function' ? api.bounceTrack : null;
  if (!fn) return { available: false };
  const before = APP.useStore.getState().project;
  const beforeIds = before.tracks.map(function (track) { return track.id; });
  const startedAt = performance.now();
  let result = null;
  let error = null;
  try {
    result = await Promise.race([
      fn(trackId),
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error('bounce 超时（' + timeoutMs + 'ms）')); }, timeoutMs);
      }),
    ]);
  } catch (caught) {
    error = String((caught && (caught.stack || caught.message)) || caught);
  }
  const renderMs = performance.now() - startedAt;
  const project = APP.useStore.getState().project;
  const source = project.tracks.find(function (track) { return track.id === trackId; });
  const added = project.tracks.filter(function (track) { return beforeIds.indexOf(track.id) < 0; });
  return {
    available: true,
    error: error,
    result: result,
    renderMs: renderMs,
    beforeTrackCount: beforeIds.length,
    afterTrackCount: project.tracks.length,
    sourceMute: source ? !!source.mute : null,
    added: added.map(function (track) {
      return {
        id: track.id,
        kind: track.kind,
        name: track.name,
        audioClips: (track.audioClips || []).map(function (clip) {
          return { id: clip.id, startBeat: clip.startBeat, durationSec: clip.durationSec, assetId: clip.assetId };
        }),
      };
    }),
  };
};
`

/* ------------------------------------------------------------------ */
/* 7. 渲染 + WAV 回传                                                  */
/* ------------------------------------------------------------------ */

async function renderAndTransfer(ctx, name, variantKey, options, timeoutMs) {
  const started = Date.now()
  const record = await ctx.page.evaluate(
    `return await window.__vrqRender(${JSON.stringify(name)}, ${JSON.stringify(variantKey)}, ${JSON.stringify(options)}, ${timeoutMs})`,
    { timeoutMs: timeoutMs + 60_000 },
  )
  ctx.renders.push(record)
  if (record.error) throw new Error(`渲染失败：${String(record.error).split('\n')[0]}`)
  if (!(record.size > 0)) throw new Error('渲染返回空 Blob')

  const materialized = await ctx.page.evaluate(`return await window.__vrqMaterialize(${JSON.stringify(name)})`)
  if (materialized !== record.size) throw new Error(`页面内 Blob 大小与记录不一致：${materialized} != ${record.size}`)

  const chunks = []
  const chunkSize = 512 * 1024
  let offset = 0
  for (let index = 0; index < 512; index++) {
    const chunk = await ctx.page.evaluate(`return window.__vrqChunk(${JSON.stringify(name)}, ${offset}, ${chunkSize})`)
    chunks.push(Buffer.from(chunk.b64, 'base64'))
    offset = chunk.next
    if (offset >= chunk.total) break
  }
  const buffer = Buffer.concat(chunks)
  if (buffer.length !== record.size) throw new Error(`回传大小不一致：${buffer.length} != ${record.size}`)

  const file = path.join(ctx.artifactsDir, `${name}.wav`)
  writeFileSync(file, buffer)
  const analysis = readWav(buffer, name)
  analysis.file = file
  await ctx.page.evaluate(`return window.__vrqRelease(${JSON.stringify(name)})`)
  record.transferMs = Date.now() - started
  return { record, file, buffer, analysis }
}

/* ------------------------------------------------------------------ */
/* 8. 验收用例                                                         */
/* ------------------------------------------------------------------ */

async function test1FullRender(ctx) {
  section('1) 整工程渲染：48kHz / 24-bit / -14 LUFS')
  const name = 't1-full-48k-24bit-lufs14'
  let out
  try {
    out = await renderAndTransfer(ctx, name, 'full', { sampleRate: 48000, bitDepth: 24, loudnessTargetLufs: -14 }, 180_000)
  } catch (error) {
    bad('整工程 @48k/24-bit 渲染', shortError(error))
    return
  }
  const wav = out.analysis
  const header = wav.header
  info(`渲染 ${(out.record.renderMs / 1000).toFixed(1)}s · ${fmtBytes(out.record.size)} · 回传 ${out.record.transferMs}ms · SoundFont 调用 ${out.record.soundfontCalls} 次`)
  info(`文件 ${path.basename(out.file)}`)

  expect(header.riff === 'RIFF' && header.wave === 'WAVE' && header.audioFormat === 1, 'WAV 头合法（RIFF/WAVE/PCM）', `chunks=${header.chunkIds.join(',')} audioFormat=${header.audioFormat}`)
  expect(header.sampleRate === 48000, '采样率 = 48000', `实际 ${header.sampleRate}`)
  expect(header.bitsPerSample === 24, '位深 = 24-bit', `实际 ${header.bitsPerSample}-bit`)
  expect(header.channels === 2, '声道数 = 2', `实际 ${header.channels}`)
  expect(header.dataConsistent, 'data 块大小与帧数 / 文件长度一致', `frames=${header.frameCount} dataSize=${header.dataSize} byteLength=${header.byteLength}`)
  expect(Math.abs(wav.durationSec - ctx.expected.durationSec) <= 0.1, `时长 ≈ ${ctx.expected.durationSec.toFixed(3)}s（±0.1s）`, `实际 ${fmtSec(wav.durationSec)}`)
  expect(wav.peakDbfs <= -0.9, '峰值 ≤ -0.9 dBFS（最终峰值保护，量化误差容差）', `实际 ${fmtDbfs(wav.peakDbfs)}`)
  expect(wav.clippedSamples === 0, '无削顶样本（|x| ≥ 0.999）', `削顶样本 ${wav.clippedSamples}`)
  info(`RMS ${fmtDbfs(wav.rmsDbfs)} · 静音占比 ${(wav.silentRatio * 100).toFixed(1)}% · 峰值 ${fmtDbfs(wav.peakDbfs)}`)
}

async function test2Alignment(ctx) {
  section('2) 单轨对齐：44.1kHz / 16-bit / trackIds')
  const name = 't2-align-44k-16bit'
  let out
  try {
    out = await renderAndTransfer(
      ctx,
      name,
      'full',
      { trackIds: [ctx.expected.alignTrackId], sampleRate: 44100, bitDepth: 16, includeAudioClips: false },
      180_000,
    )
  } catch (error) {
    bad(`单轨（${ctx.expected.alignTrackId}）@44.1k/16bit 渲染`, shortError(error))
    return
  }
  const wav = out.analysis
  const header = wav.header
  info(`渲染 ${(out.record.renderMs / 1000).toFixed(2)}s · ${fmtBytes(out.record.size)} · 时长 ${fmtSec(wav.durationSec)} · SoundFont 调用 ${out.record.soundfontCalls} 次`)

  expect(header.sampleRate === 44100, '采样率 = 44100', `实际 ${header.sampleRate}`)
  expect(header.bitsPerSample === 16, '位深 = 16-bit', `实际 ${header.bitsPerSample}-bit`)
  expect(header.channels === 2, '声道数 = 2', `实际 ${header.channels}`)

  const expectedStart = ctx.expected.alignStartSec
  const actualStart = wav.firstNonSilentSec
  expect(
    actualStart !== null && Math.abs(actualStart - expectedStart) <= 0.05,
    `首个非静音样本 ≈ clip 起点 ${expectedStart.toFixed(3)}s（±50ms）`,
    `实际 ${actualStart === null ? '全静音' : fmtSec(actualStart)}`,
  )

  const alignment = analyzeAlignment(wav, expectedStart, ctx.expected.alignNotes)
  for (const row of alignment.rows) {
    info(`pitch ${row.pitch}（${row.frequency.toFixed(1)}Hz @ ${row.timeSec.toFixed(3)}s）：正确位置 ${fmtDb(row.correctDb)} / 提前 ${expectedStart.toFixed(3)}s ${fmtDb(row.shiftedDb)}`)
  }
  expect(alignment.avgCorrectDb > -120, '正确位置存在第 8 拍音符基频能量', `平均 ${fmtDb(alignment.avgCorrectDb)}`)
  expect(alignment.diffDb >= 6, '正确位置能量比「提前 4.444s」高 ≥ 6dB（Goertzel）', `平均差 ${alignment.diffDb.toFixed(1)} dB`)
}

async function test3LevelConsistency(ctx) {
  section('3) 电平一致性：SoundFont 版 vs 强制合成器版')
  const options = { sampleRate: 44100, bitDepth: 16 }
  let sfOut = null
  let synthOut = null
  try {
    sfOut = await renderAndTransfer(ctx, 't3-soundfont-44k-16bit', 'full', options, 180_000)
  } catch (error) {
    bad('SoundFont 版渲染', shortError(error))
  }
  try {
    synthOut = await renderAndTransfer(ctx, 't3-synth-44k-16bit', 'synth', options, 300_000)
  } catch (error) {
    bad('强制合成器版渲染', shortError(error))
  }
  if (!sfOut || !synthOut) return

  const sfWav = sfOut.analysis
  const synthWav = synthOut.analysis
  info(`SoundFont ${fmtBytes(sfOut.record.size)} / 渲染 ${(sfOut.record.renderMs / 1000).toFixed(1)}s / SoundFont 调用 ${sfOut.record.soundfontCalls} 次`)
  info(`合成器   ${fmtBytes(synthOut.record.size)} / 渲染 ${(synthOut.record.renderMs / 1000).toFixed(1)}s`)

  expect(sfOut.record.soundfontCalls > 0, 'SoundFont 版确实走了采样引擎（非静默回退合成器）', `renderOffline 调用 ${sfOut.record.soundfontCalls} 次`)
  const LEVEL_RMS_TOLERANCE_DB = 5 /* 回归护栏：修复前 SF vs synth 差 15.1dB；修复后实测 3.2–4.2dB（Tone patch 本身比采样响，母带 limiter 已压到 -1dBFS）。阈值 5dB 只拦「系统性失衡」，不要求两套引擎等响 */
  const deltaDb = Math.abs(sfWav.rmsDbfs - synthWav.rmsDbfs)
  expect(
    Number.isFinite(deltaDb) && deltaDb <= LEVEL_RMS_TOLERANCE_DB,
    `SoundFont 与合成器版 RMS 差 ≤ ${LEVEL_RMS_TOLERANCE_DB}dB`,
    `SF ${fmtDbfs(sfWav.rmsDbfs)} / synth ${fmtDbfs(synthWav.rmsDbfs)}，差 ${Number.isFinite(deltaDb) ? `${deltaDb.toFixed(2)} dB` : '—'}`,
  )
  expect(sfWav.clippedSamples === 0 && synthWav.clippedSamples === 0, '两版均无削顶', `SF ${sfWav.clippedSamples} / synth ${synthWav.clippedSamples}`)
  info(`时长 SF ${fmtSec(sfWav.durationSec)} / synth ${fmtSec(synthWav.durationSec)}`)
}

async function test4Options(ctx) {
  section('4) 输出选项：16/24-bit 头字段 + 响度归一（-14 LUFS vs null）')
  const options16 = { sampleRate: 44100, bitDepth: 16 }
  let p16 = null
  let p24 = null
  let norm = null
  try {
    p16 = await renderAndTransfer(ctx, 't4-44k-16bit', 'full', options16, 180_000)
  } catch (error) {
    bad('44.1k / 16-bit 渲染', shortError(error))
  }
  try {
    p24 = await renderAndTransfer(ctx, 't4-44k-24bit', 'full', { sampleRate: 44100, bitDepth: 24 }, 180_000)
  } catch (error) {
    bad('44.1k / 24-bit 渲染', shortError(error))
  }
  try {
    norm = await renderAndTransfer(ctx, 't4-44k-16bit-lufs14', 'full', { sampleRate: 44100, bitDepth: 16, loudnessTargetLufs: -14 }, 180_000)
  } catch (error) {
    bad('44.1k / 16-bit / -14 LUFS 渲染', shortError(error))
  }

  if (p16) {
    expect(p16.analysis.header.bitsPerSample === 16, 'bitDepth:16 的头字段 = 16', `实际 ${p16.analysis.header.bitsPerSample}`)
    expect(p16.analysis.header.sampleRate === 44100, 'bitDepth:16 的采样率 = 44100', `实际 ${p16.analysis.header.sampleRate}`)
  }
  if (p24) {
    expect(p24.analysis.header.bitsPerSample === 24, 'bitDepth:24 的头字段 = 24', `实际 ${p24.analysis.header.bitsPerSample}`)
    expect(p24.analysis.header.sampleRate === 44100, 'bitDepth:24 的采样率 = 44100', `实际 ${p24.analysis.header.sampleRate}`)
  }
  if (p16 && p24) {
    const sameFrames = p16.analysis.frames === p24.analysis.frames
    expect(sameFrames, '16 / 24-bit 帧数一致（仅位深不同）', `${p16.analysis.frames} vs ${p24.analysis.frames}`)
    const ratio = p16.analysis.byteLength > 0 ? p24.analysis.byteLength / p16.analysis.byteLength : 0
    expect(sameFrames && Math.abs(ratio - 1.5) < 0.01, '24-bit 数据量 ≈ 16-bit 的 1.5 倍', `实际 比值 ${ratio.toFixed(3)}`)
  }

  if (p16 && norm) {
    const lufsRaw = integratedLufs(p16.analysis)
    const lufsNorm = integratedLufs(norm.analysis)
    const target = -14
    const distRaw = Number.isFinite(lufsRaw) ? Math.abs(lufsRaw - target) : Number.POSITIVE_INFINITY
    const distNorm = Number.isFinite(lufsNorm) ? Math.abs(lufsNorm - target) : Number.POSITIVE_INFINITY
    info(`积分响度（BS.1770）：未归一 ${Number.isFinite(lufsRaw) ? `${lufsRaw.toFixed(2)} LUFS` : '-inf'} / 归一 ${Number.isFinite(lufsNorm) ? `${lufsNorm.toFixed(2)} LUFS` : '-inf'}`)
    expect(distNorm <= 3, `归一版响度接近 -14 LUFS（±3dB）`, `实际 ${Number.isFinite(lufsNorm) ? `${lufsNorm.toFixed(2)} LUFS` : '-inf'}，偏差 ${Number.isFinite(distNorm) ? `${distNorm.toFixed(2)} dB` : '∞'}`)
    /* 原始版本若本来就在目标 ±1 LU 内，则「更接近」没有可改进空间，不算失败 */
    const closer = distNorm < distRaw || distRaw <= 1
    expect(closer, '归一版比未归一版更接近 -14 LUFS', `未归一偏差 ${Number.isFinite(distRaw) ? `${distRaw.toFixed(2)} dB` : '∞'} → 归一偏差 ${Number.isFinite(distNorm) ? `${distNorm.toFixed(2)} dB` : '∞'}`)
    info(`归一版峰值 ${fmtDbfs(norm.analysis.peakDbfs)} · 削顶样本 ${norm.analysis.clippedSamples}`)
  }
}

async function test5Bounce(ctx) {
  section('5) 单轨 Bounce：MIDI 轨 → 音频轨（bounce in place）')
  const ensured = await ctx.page.evaluate('return window.__vrqEnsureProject()')
  info(`store 工程：${ensured.id} / ${ensured.tracks} 轨（saveStatus=${ensured.saveStatus}）`)

  let bounce = null
  try {
    bounce = await ctx.page.evaluate(`return await window.__vrqBounce(${JSON.stringify(ALIGN_TRACK_ID)}, 240000)`, { timeoutMs: 300_000 })
  } catch (error) {
    bad('调用 window.AIAB.audio.bounceTrack', shortError(error))
    return
  }
  if (!bounce || bounce.available !== true) {
    bad('单轨 bounce API 未就绪', 'window.AIAB.audio.bounceTrack 不存在（App.tsx 尚未暴露调试句柄）')
    return
  }
  info(`bounce 耗时 ${(bounce.renderMs / 1000).toFixed(1)}s · 轨道 ${bounce.beforeTrackCount} → ${bounce.afterTrackCount}`)
  if (bounce.error) {
    bad('bounce 调用抛错', shortError(bounce.error))
    return
  }
  expect(bounce.result && typeof bounce.result.trackId === 'string' && typeof bounce.result.clipId === 'string', 'bounce 返回新轨 / 新片段 id', `返回 ${JSON.stringify(bounce.result ?? null).slice(0, 160)}`)

  const audioTracks = (bounce.added ?? []).filter((track) => track.kind === 'audio')
  expect(audioTracks.length >= 1, '新增 kind="audio" 轨道', `新增 ${audioTracks.length} 条音频轨；全部新增：${(bounce.added ?? []).map((track) => `${track.id}:${track.kind}`).join(',') || '无'}`)
  const audioTrack = audioTracks[0] ?? null
  if (audioTrack) {
    expect(Array.isArray(audioTrack.audioClips) && audioTrack.audioClips.length > 0, '新音频轨 audioClips 非空', `audioClips ${audioTrack.audioClips.length} 个`)
    const clip = audioTrack.audioClips[0]
    expect(clip && clip.startBeat === 0, '新音频片段 startBeat = 0', `实际 ${clip ? clip.startBeat : '无片段'}`)
    if (clip && clip.assetId && clip.durationSec > 0) {
      try {
        const response = await fetch(`${BASE}/api/assets/${encodeURIComponent(clip.assetId)}/file`)
        const bytes = response.ok ? (await response.arrayBuffer()).byteLength : 0
        expect(response.ok && bytes > 100_000, 'bounce 的 WAV 资产已上传且可下载', `HTTP ${response.status} · ${fmtBytes(bytes)}`)
      } catch (error) {
        bad('bounce 资产检查', shortError(error))
      }
    }
  }
  expect(bounce.sourceMute === true, `原轨 ${ALIGN_TRACK_ID} 已静音（mute=true）`, `实际 mute=${bounce.sourceMute}`)
}

/* ------------------------------------------------------------------ */
/* 9. 收尾诊断 / 清理                                                  */
/* ------------------------------------------------------------------ */

async function test6ExportDialog(ctx) {
  section('6) 导出对话框：采样率 / 位深 / 响度归一选项')
  const options = await ctx.page.evaluate(`
    const store = window.AIAB.useStore.getState()
    store.setExportOpen(true)
    await new Promise((resolve) => setTimeout(resolve, 400))
    const wavButton = [...document.querySelectorAll('button')].find((button) => /WAV/.test(button.textContent || '') && !/MP3|FLAC|OGG/.test(button.textContent || ''))
    if (wavButton) wavButton.click()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const sampleRate = document.querySelector('select[aria-label="采样率"]')
    const bitDepth = document.querySelector('select[aria-label="位深"]')
    const lufs = document.querySelector('[role="switch"][aria-label="响度归一 -14 LUFS"]')
    const summary = document.querySelector('[data-testid="export-audio-quality-summary"]')
    const result = {
      sampleRate: sampleRate ? sampleRate.value : null,
      bitDepth: bitDepth ? bitDepth.value : null,
      lufs: lufs ? lufs.getAttribute('aria-checked') : null,
      summary: summary ? summary.textContent.trim() : '',
    }
    window.AIAB.useStore.getState().setExportOpen(false)
    return result
  `)
  info(`选项：采样率=${options.sampleRate ?? '缺失'} 位深=${options.bitDepth ?? '缺失'} 响度归一=${options.lufs ?? '缺失'} 摘要=${options.summary || '缺失'}`)
  expect(options.sampleRate === '48000', '采样率默认 48kHz', `实际 ${options.sampleRate ?? '缺失'}`)
  expect(options.bitDepth === '24', '位深默认 24-bit', `实际 ${options.bitDepth ?? '缺失'}`)
  expect(options.lufs === 'true', '响度归一默认开启', `实际 aria-checked=${options.lufs ?? '缺失'}`)
  expect(/48kHz/.test(options.summary) && /24-bit/.test(options.summary), '质量摘要显示 48kHz / 24-bit', options.summary || '摘要缺失')
}

async function finalDiagnostics(ctx) {
  section('环境与安全')
  const soundfont = await ctx.page.evaluate('return window.__vrqSoundfont()').catch(() => null)
  if (soundfont) info(`SoundFont：usable=${soundfont.usable} loaded=${soundfont.loaded} name=${soundfont.name ?? '—'} error=${soundfont.error ?? '—'}`)

  const blockedWrites = await ctx.page.evaluate('return window.__vrq.blockedWrites.slice(0)').catch(() => [])
  if (blockedWrites.length > 0) info(`已拦截对 /api/projects/* 的非 GET 写请求 ${blockedWrites.length} 次（自动保存被阻断，符合预期）`)
  else info('未拦截到工程写请求（未触发自动保存）')

  const benign = /AudioContext|autoplay|favicon|DevTools|Failed to load resource.*\/(favicon|api\/health)|soundfont/i
  const consoleErrors = ctx.page.consoleMessages.filter((message) => (message.type === 'error' || message.type === 'log:error' || message.type === 'assert') && !benign.test(message.text))
  const exceptions = ctx.page.exceptions.filter((text) => !benign.test(text))
  if (consoleErrors.length === 0 && exceptions.length === 0) {
    info('浏览器控制台无异常')
  } else {
    warn(`浏览器控制台有 ${consoleErrors.length} 条 error / ${exceptions.length} 条未捕获异常（供排查，不计为失败）`)
    for (const line of consoleErrors.slice(0, 4)) console.log(`      ${C.dim}${line.text.slice(0, 200)}${C.reset}`)
    for (const line of exceptions.slice(0, 2)) console.log(`      ${C.dim}${line.slice(0, 200)}${C.reset}`)
  }

  const shaAfter = sha256File(PROJECT_FILE)
  expect(state.userProjectShaBefore !== null && shaAfter === state.userProjectShaBefore, '用户工程文件未被修改（data/projects）', `sha256 ${String(shaAfter).slice(0, 12)}…`)
}

async function cleanup() {
  try {
    state.page?.close()
  } catch {
    /* ignore */
  }
  try {
    state.chrome?.child?.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  try {
    state.server?.child?.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  await sleep(400)
  if (state.tempDir && !KEEP) {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        rmSync(state.tempDir, { recursive: true, force: true })
        break
      } catch {
        await sleep(400)
      }
    }
  }
}

function printSummary() {
  const total = passed + failed
  console.log('')
  if (failed === 0) {
    console.log(`${C.green}${C.bold}✓ 渲染质量验收全部通过${C.reset}  ${passed}/${total} 项检查${skipped ? `（跳过 ${skipped}）` : ''}`)
    console.log(`${C.dim}验收项：整工程 48k/24bit+归一 · 单轨对齐+Goertzel · SF/synth 电平 · 位深/响度选项 · 单轨 bounce · 导出对话框选项${C.reset}`)
  } else {
    console.log(`${C.red}${C.bold}✗ ${failed} 项失败${C.reset}  ${passed}/${total} 项检查`)
    for (const line of failures) console.log(`  ${C.red}•${C.reset} ${line}`)
  }
  if (KEEP && state.tempDir) {
    console.log(`\n${C.dim}临时目录（含 WAV 与报告）：${state.tempDir}${C.reset}`)
    console.log(`${C.dim}  WAV：${state.artifactsDir}${C.reset}`)
  } else if (failed > 0) {
    console.log(`\n${C.dim}排查提示：加 --keep 重跑可保留临时 DATA_DIR 与 WAV 产物${C.reset}`)
  }
  console.log('')
}

/* ------------------------------------------------------------------ */
/* 10. 主流程                                                          */
/* ------------------------------------------------------------------ */

async function main() {
  if (!Number.isFinite(PORT) || PORT <= 0 || PORT > 65535) throw new Error(`非法端口：${PORT}`)
  if (PORT === 8787 || PORT === 5183) throw new Error(`拒绝使用端口 ${PORT}（不会碰用户正在运行的应用）；请用 --port 指定其它端口`)

  console.log(`\n${C.gold}${C.bold}AI 编曲伴侣 · 渲染质量验收（P0 MIDI→音频）${C.reset}`)
  console.log(`${C.dim}工程 ${PROJECT_ID} · 临时服务 ${BASE} · 本机 Chrome headless + CDP · 不写用户数据${C.reset}`)
  if (NO_BUILD) warn('--no-build：直接使用现有构建产物（源码改动后可能不是最新）')

  const project = loadProject()
  const expected = computeExpectations(project)
  const summary = summarizeProject(project)
  log(`测试工程「${project.name}」：${summary.tracks} 轨 / ${summary.noteCount} 音符 / ${summary.tempo} BPM / 末拍 ${summary.endBeat}`)
  log(
    `期望：整工程时长 ${expected.durationSec.toFixed(3)}s；对齐轨 ${expected.alignTrackId} 的 clip 起点第 ${expected.alignClipStartBeat} 拍 = ${expected.alignStartSec.toFixed(3)}s；第 8 拍音符 ${expected.alignNotes.map((note) => `p${note.pitch}@${note.timeSec.toFixed(2)}s`).join(' ')}`,
  )
  state.userProjectShaBefore = sha256File(PROJECT_FILE)

  const watchdog = setTimeout(() => {
    console.error(`\n${C.red}[FATAL] 验收整体超时（20 分钟），强制结束${C.reset}`)
    void cleanup()
    process.exit(2)
  }, 20 * 60 * 1000)
  watchdog.unref?.()

  let exitCode = 0
  try {
    if (NO_BUILD) {
      assertBuildArtifacts()
      const entry = path.join(ROOT, 'apps', 'server', 'dist', 'server.mjs')
      info(`使用现有构建产物（mtime ${new Date(statSync(entry).mtimeMs).toLocaleString()}）`)
    } else {
      buildApp()
      assertBuildArtifacts()
    }

    const { serverEntry } = assertBuildArtifacts()
    if (!(await isPortFree(PORT))) throw new Error(`端口 ${PORT} 已被占用（可用 --port 指定其它端口）`)
    log(`开始构建已完成，准备临时环境（端口 ${PORT}）`)
    prepareTempDir()

    log('启动临时后端 ...')
    const server = startServer(serverEntry)
    const health = await waitForServer(server)
    log(`后端就绪：v${health.version ?? '?'} · node ${health.node ?? '?'} · ffmpeg ${health.ffmpeg ? '✓' : '✗'}`)

    log('启动 headless Chrome ...')
    const chrome = await launchChrome(path.join(state.tempDir, 'chrome-profile'))
    log(`Chrome ${chrome.version ?? '?'}（debug 端口 ${chrome.debugPort}）`)

    const cdp = await Cdp.connect(chrome.wsUrl)
    const page = new Page(cdp)
    state.page = page
    await page.init()

    log(`打开界面 ${BASE}/ ...`)
    await page.goto(`${BASE}/`)
    await page.waitFor('window.AIAB && window.AIAB.engine && window.AIAB.useStore && typeof window.AIAB.useStore.getState === "function"', 90_000)
    log('window.AIAB 就绪')

    await page.evaluate(PAGE_HELPERS)
    log('已注入页面辅助函数 + 工程写回拦截器')

    const engineInfo = await page.evaluate('return await window.__vrqEngineInfo()')
    log(
      `engine.init：${engineInfo.initMs.toFixed(0)}ms · SoundFont usable=${engineInfo.usable} loaded=${engineInfo.loaded} name=${engineInfo.name ?? '—'}（等待 ${(engineInfo.soundfontWaitMs / 1000).toFixed(1)}s）`,
    )
    if (engineInfo.initError) warn(`engine.init 报错：${engineInfo.initError}`)
    if (engineInfo.error) warn(`SoundFont 加载错误：${engineInfo.error}`)
    const healthSf = Array.isArray(health.soundfonts) ? health.soundfonts : []
    expect(
      healthSf.some((file) => /MuseScore_General\.sf3$/i.test(file.name ?? '')),
      '临时服务识别到音色库（MuseScore_General.sf3）',
      `health.soundfonts=${healthSf.map((file) => file.name).join(',') || '空'}`,
    )
    expect(engineInfo.usable, 'SoundFont 引擎可用（采样渲染前提）', `usable=${engineInfo.usable} error=${engineInfo.error ?? '—'}`)

    const projectB64 = Buffer.from(JSON.stringify(project), 'utf8').toString('base64')
    const injected = await page.evaluate(`
      const raw = atob(${JSON.stringify(projectB64)});
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const project = JSON.parse(new TextDecoder().decode(bytes));
      window.__vrqSetProject(project);
      return window.__vrqEnsureProject();
    `)
    await sleep(400)
    const ensured = await page.evaluate('return window.__vrqEnsureProject()')
    log(`工程已注入内存：${ensured.id}（${ensured.tracks} 轨，saveStatus=${ensured.saveStatus}）`)
    expect(ensured.id === PROJECT_ID, '测试工程已注入页面 store（内存）', `实际 ${ensured.id}`)

    const ctx = { page, project, expected, artifactsDir: state.artifactsDir, renders: [] }
    await test1FullRender(ctx)
    await test2Alignment(ctx)
    await test3LevelConsistency(ctx)
    await test4Options(ctx)
    await test5Bounce(ctx)
    await test6ExportDialog(ctx)
    await finalDiagnostics(ctx)

    exitCode = failed === 0 ? 0 : 1
  } catch (error) {
    bad('验收流程中断', shortError(error))
    const serverLog = state.server?.getLog?.() ?? ''
    if (serverLog) console.log(`${C.dim}后端日志（尾部）：\n${serverLog.split('\n').filter(Boolean).slice(-12).join('\n')}${C.reset}`)
    const chromeLog = findChromeLogTail(state.chrome)
    if (chromeLog) console.log(`${C.dim}Chrome 日志（尾部）：\n${chromeLog}${C.reset}`)
    exitCode = 2
  } finally {
    clearTimeout(watchdog)
    printSummary()
    await cleanup()
  }
  process.exit(exitCode)
}

main().catch((error) => {
  console.error(`\n${C.red}验收脚本自身异常：${error?.stack ?? error}${C.reset}`)
  void cleanup().finally(() => process.exit(2))
})
