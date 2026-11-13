#!/usr/bin/env node
/**
 * AI 生成链路回归测试（T3）。
 *
 * 目标：不依赖 Chrome、不调用真实 AI API，用「mock OpenAI 兼容服务 + 真实后端」
 * 把「AI 对话 → function calling → 工具执行 → 工程快照回传」整条链路跑一遍，
 * 防止工具调用失败 / 静默改错在修复后复发。
 *
 *   node scripts/test-ai.mjs            # 跑全部场景
 *   node scripts/test-ai.mjs --keep     # 保留临时数据目录（排查用）
 *   AIAB_AI_TEST_PORT=8893 node scripts/test-ai.mjs   # 指定后端端口（mock 用 +1）
 *   AIAB_AI_TEST_KEEP=1 node scripts/test-ai.mjs      # 同上，等价于 --keep
 *
 * 结构：
 *   - 脚本内起 mock OpenAI SSE 服务（默认 8896），按场景返回预置的 tool_calls / 文本 /
 *     500 错误 / 40 轮工具调用（超出 MAX_ROUNDS=32）/ finish_reason=length /
 *     只有 reasoning 的截断响应；
 *   - 用临时 DATA_DIR 启动真实后端（spawn tsx apps/server/src/index.ts，默认 8895，
 *     SERVE_STATIC=0），初始化 settings.json 指向 mock 服务商；
 *   - 每个场景独立 setup/teardown（重置 mock 行为 + 全新工程快照），逐场景 POST
 *     /api/ai/chat 解析 SSE，断言 tool_end.ok / project 事件 / done 与最终文本；
 *   - mock 会记录每次请求体（messages / max_tokens），供「截断自愈」等场景断言；
 *   - 每场景超时 60s、整体兜底超时 10min，失败时打印相关 SSE 事件摘要。
 *
 * 只测试服务端链路，与 T1（tools 修复）、T2（agent/providers 修复）、
 * T4（AI 运行日志 / max_tokens 截断自愈 / 质量自检自动修复）联动。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { IS_WINDOWS, spawnBin } from './lib/spawn-bin.mjs'
import {
  applyModelSelection,
  buildExtractRequest,
  buildRepaintRequest,
  buildCoverRequest,
  buildLegoRequest,
  buildQualityLmRequest,
  buildQualitySynthRequest,
  buildSynthPayload,
  createMockWav,
  DC_OFFSET_HEALTHY,
  DC_OFFSET_THRESHOLD,
  defaultStemCaption,
  ENGINE_TRACKS,
  engineTrackForArm,
  normalizeKeyscale,
  normalizeTimesignature,
  presetForVariant,
  QUALITY_GUIDANCE,
  QUALITY_SHIFT,
  QUALITY_STEPS,
  readMeanDcOffset,
  readWavInfo,
  resolveStemArmDecision,
  resolveVocalLanguage,
  sanitizeWavDcOffset,
  STEM_ARMS,
  STEM_SEED,
  stripDcOffsetFromWav16,
  TURBO_GUIDANCE,
  TURBO_SHIFT,
  TURBO_STEPS,
  validateStemParams,
  wantsVocals,
} from './companion.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'aiab-ai-test-'))
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
const KEEP = process.argv.includes('--keep') || process.env.AIAB_AI_TEST_KEEP === '1'
const SCENARIO_TIMEOUT_MS = 60_000
const GLOBAL_TIMEOUT_MS = 600_000

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  gold: '\x1b[33m',
  bold: '\x1b[1m',
}

let passed = 0
let failed = 0
const failures = []

function ok(name, detail = '') {
  passed++
  console.log(`  ${C.green}✓${C.reset} ${name}${detail ? C.dim + '  ' + detail + C.reset : ''}`)
}

function bad(name, error) {
  failed++
  const message = error instanceof Error ? error.message : String(error)
  failures.push({ name, message })
  console.log(`  ${C.red}✗${C.reset} ${name}${C.dim}  ${message}${C.reset}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ */
/* 1. 端口选择（不 kill 别人的进程，只检测占用）                        */
/* ------------------------------------------------------------------ */

/** 尝试绑定端口：能绑上说明空闲 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.unref()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
  })
}

async function pickPorts() {
  const explicit = process.env.AIAB_AI_TEST_PORT ? Number(process.env.AIAB_AI_TEST_PORT) : null
  const candidates = explicit ? [explicit] : [8895, 8893]
  for (const port of candidates) {
    if (!Number.isInteger(port) || port < 1024) continue
    if ((await isPortFree(port)) && (await isPortFree(port + 1))) return port
  }
  throw new Error(
    `端口被占用：${candidates.map((port) => `${port}/${port + 1}（后端/mock）`).join('、')} 均不可用。` +
      '请先释放端口，或设置 AIAB_AI_TEST_PORT 指定一个空闲端口（mock 使用 +1）。',
  )
}

/* ------------------------------------------------------------------ */
/* 2. mock OpenAI 兼容服务（SSE + 可配置失败/多轮/截断）                */
/* ------------------------------------------------------------------ */

const mockState = {
  /** @type {(ctx: { round: number, payload: any }) => any} */
  handler: async () => ({ text: '完成。' }),
  round: 0,
  requests: 0,
  /** 每次请求体摘要（按到达顺序）：供「截断自愈」「质量修复」等场景断言 */
  payloads: [],
}

function setMock(handler) {
  mockState.handler = handler
  mockState.round = 0
  mockState.requests = 0
  mockState.payloads = []
}

/* ---- 请求体读取小工具（mock 编排 + 断言都用） ---- */

function payloadMessages(payload) {
  const messages = payload?.messages
  return Array.isArray(messages) ? messages : []
}

/** 最后一条 user 消息内容（chat() 的 messages 中角色为 user） */
function payloadLastUser(payload) {
  const messages = payloadMessages(payload)
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message && message.role === 'user' && typeof message.content === 'string') return message.content
  }
  return ''
}

/** 是否存在「最后一条消息就是 user」的情况（质量修复指令注入后的第一轮） */
function payloadEndsWithUser(payload) {
  const messages = payloadMessages(payload)
  const last = messages[messages.length - 1]
  return !!last && last.role === 'user' && typeof last.content === 'string'
}

/** 消息里的工具结果文本（role=tool 的 content） */
function payloadToolContents(payload) {
  const result = []
  for (const message of payloadMessages(payload)) {
    if (message && message.role === 'tool' && typeof message.content === 'string') result.push(message.content)
  }
  return result
}

/** 从工具结果里提取 create_clip 新建出来的片段 id（用于质量修复回合删除重叠片段） */
function payloadCreatedClipIds(payload) {
  const ids = []
  for (const content of payloadToolContents(payload)) {
    if (!content.includes('创建片段')) continue
    const match = content.match(/"clipId":"(c_[A-Za-z0-9_-]+)"/)
    if (match) ids.push(match[1])
  }
  return ids
}

/** 从 mock 收到的工具结果 JSON 文本里取某个 data 字段（例如 split_clip 的 newClipId） */
function payloadToolDataField(payload, field) {
  for (const content of payloadToolContents(payload)) {
    const match = content.match(new RegExp(`"${field}":"([^"]+)"`))
    if (match) return match[1]
  }
  return ''
}

function sendSse(res, payload) {
  if (res.writableEnded || res.destroyed) return
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

async function writeSse(res, spec) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const base = {
    id: 'chatcmpl-aitest',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
  }
  const chunk = (delta, finish = null) =>
    sendSse(res, { ...base, choices: [{ index: 0, delta, finish_reason: finish }] })

  chunk({ role: 'assistant', content: '' })
  if (spec.reasoning) chunk({ reasoning_content: spec.reasoning })

  const text = typeof spec.text === 'string' ? spec.text : ''
  if (text) {
    // 拆成小块，模拟流式文本增量
    for (const piece of text.match(/.{1,12}/gu) ?? []) {
      chunk({ content: piece })
      if (spec.delayMs) await sleep(spec.delayMs)
    }
  }

  const calls = Array.isArray(spec.toolCalls) ? spec.toolCalls : []
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index] ?? {}
    const args = typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {})
    chunk({
      tool_calls: [
        {
          index,
          id: call.id ?? `call_${index}_${Date.now().toString(36)}`,
          type: 'function',
          function: { name: String(call.name ?? ''), arguments: args },
        },
      ],
    })
    if (spec.delayMs) await sleep(spec.delayMs)
  }

  const finish = spec.finishReason ?? (calls.length ? 'tool_calls' : 'stop')
  chunk({}, finish)
  if (spec.usage) sendSse(res, { ...base, choices: [], usage: spec.usage })
  if (!res.writableEnded && !res.destroyed) {
    res.write('data: [DONE]\n\n')
    res.end()
  }
}

function startMockProvider(port) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }))
        return
      }
      if (!req.url?.endsWith('/chat/completions')) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'not found' } }))
        return
      }
      let body = ''
      for await (const part of req) body += part
      let payload = {}
      try {
        payload = JSON.parse(body)
      } catch {
        /* 保持空对象 */
      }
      const round = mockState.round++
      mockState.requests++
      // 记录请求体摘要：断言「第 2 次请求 max_tokens 变大」「收到质量修复指令」等
      mockState.payloads.push({
        index: round,
        maxTokens: typeof payload?.max_tokens === 'number' ? payload.max_tokens : undefined,
        lastUser: payloadLastUser(payload),
        messages: payloadMessages(payload),
      })
      let spec
      try {
        spec = await mockState.handler({ round, payload })
      } catch (error) {
        spec = { status: 500, body: { error: { message: `mock handler error: ${error?.message ?? error}` } } }
      }
      spec = spec ?? { text: '完成。' }

      if (spec.status) {
        res.writeHead(spec.status, { 'Content-Type': 'application/json', ...(spec.headers ?? {}) })
        res.end(JSON.stringify(spec.body ?? { error: { message: 'mock upstream failure', type: 'server_error' } }))
        return
      }
      await writeSse(res, spec)
    } catch {
      // 客户端（被测后端 / 测试脚本）断开时忽略
      try {
        if (!res.writableEnded) res.end()
      } catch {
        /* ignore */
      }
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

/* ------------------------------------------------------------------ */
/* 3. 被测后端                                                         */
/* ------------------------------------------------------------------ */

let BASE = ''
let MOCK_BASE = ''

function writeMockSettings() {
  const settings = {
    providers: [
      {
        id: 'mock',
        name: 'Mock AI（回归测试）',
        kind: 'openai',
        baseUrl: `${MOCK_BASE}/v1`,
        modelsUrl: '',
        apiKey: 'mock-key',
        model: 'mock-model',
        temperature: 0,
        maxTokens: 4096,
        parallelToolCalls: false,
        extraHeaders: {},
      },
    ],
    activeProviderId: 'mock',
    search: { provider: 'none', apiKey: '', maxResults: 6 },
    agent: {
      backend: 'builtin',
      executablePath: '',
      workdir: '',
      allowWebSearch: false,
      allowProjectEdits: true,
      model: '',
      timeoutMs: 60_000,
    },
    audio: {
      masterVolume: 0.9,
      soundfontUrl: '',
      preferSoundfont: true,
      midiInputId: '',
      midiLatencyMs: 0,
      midiThru: true,
    },
    ui: {
      theme: 'dark',
      language: 'zh',
      showGrid: true,
      showMinimap: true,
      defaultVelocity: 96,
      scaleHighlight: true,
    },
  }
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8')
}

function startServer(port) {
  const entry = path.join(ROOT, 'apps', 'server', 'src', 'index.ts')
  const tsxBin = path.join(ROOT, 'node_modules', '.bin', IS_WINDOWS ? 'tsx.cmd' : 'tsx')
  const child = spawnBin(tsxBin, [entry], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR,
      SERVE_STATIC: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const state = { child, log: '' }
  const append = (chunk) => {
    state.log += chunk
    if (state.log.length > 200_000) state.log = state.log.slice(-100_000)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  child.on('exit', (code, signal) => append(`\n[server exited code=${code} signal=${signal}]\n`))
  return state
}

async function waitForHealth(timeoutMs = 90_000) {
  const started = Date.now()
  let lastError = 'timeout'
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${BASE}/api/health`)
      if (response.ok) return await response.json()
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error?.message ?? String(error)
    }
    await sleep(300)
  }
  throw new Error(`后端未在 ${timeoutMs}ms 内就绪：${lastError}`)
}

/* ------------------------------------------------------------------ */
/* 4. 工程 fixture（2 条轨道 / 每轨 1 个片段 / 1 个 smart clip）        */
/* ------------------------------------------------------------------ */

function fixtureProject() {
  const now = Date.now()
  return {
    id: 'p_aitest01',
    name: 'AI 回归测试工程',
    version: 1,
    tempo: 112,
    timeSignature: { numerator: 4, denominator: 4 },
    key: 'C',
    scale: 'major',
    swing: 0,
    masterVolume: 0.9,
    tracks: [
      {
        id: 't_piano',
        name: '钢琴',
        color: '#f0b429',
        kind: 'instrument',
        instrumentId: 'piano.grand',
        emotionId: 'warm',
        gmProgram: 0,
        engine: 'auto',
        volume: 0.8,
        pan: 0,
        mute: false,
        solo: false,
        reverbSend: 0.2,
        delaySend: 0.05,
        octaveShift: 0,
        clips: [
          {
            id: 'c_piano',
            trackId: 't_piano',
            name: '钢琴',
            startBeat: 0,
            lengthBeats: 16,
            muted: false,
            notes: [
              { id: 'n_1', pitch: 60, start: 0, duration: 1, velocity: 96 },
              { id: 'n_2', pitch: 64, start: 1, duration: 1, velocity: 88 },
              { id: 'n_3', pitch: 67, start: 2, duration: 1, velocity: 92 },
            ],
          },
        ],
      },
      {
        id: 't_drums',
        name: '鼓组',
        color: '#ef4444',
        kind: 'drum',
        instrumentId: 'drums.acoustic',
        emotionId: 'studio',
        gmProgram: 0,
        engine: 'auto',
        volume: 0.7,
        pan: 0,
        mute: false,
        solo: false,
        reverbSend: 0.15,
        delaySend: 0.02,
        octaveShift: 0,
        clips: [
          {
            id: 'c_drums',
            trackId: 't_drums',
            name: '节奏',
            startBeat: 8,
            lengthBeats: 8,
            muted: false,
            notes: [
              { id: 'n_d1', pitch: 36, start: 0, duration: 0.5, velocity: 110 },
              { id: 'n_d2', pitch: 38, start: 1, duration: 0.5, velocity: 100 },
            ],
            smart: { kind: 'drums', style: 'pop', seed: 1234, params: {} },
          },
        ],
      },
    ],
    sections: [{ id: 's_1', name: '主歌', startBar: 0, bars: 4, energy: 0.5 }],
    chords: [{ root: 0, quality: 'maj', beats: 4 }],
    loop: { enabled: false, startBeat: 0, endBeat: 16 },
    createdAt: now,
    updatedAt: now,
  }
}

/** 基于基础 fixture 的深拷贝；单场景需要改工程时用，避免污染其他场景 */
function scenarioProject(mutate) {
  const project = JSON.parse(JSON.stringify(fixtureProject()))
  if (mutate) mutate(project)
  return project
}

/* ------------------------------------------------------------------ */
/* 5. SSE 解析与断言小工具                                              */
/* ------------------------------------------------------------------ */

/** 当前场景最近一次 chat 的 SSE 事件（失败时打摘要用） */
let currentEvents = []

function parseSse(raw) {
  const events = []
  for (const block of raw.split(/\r?\n\r?\n/)) {
    let event = 'message'
    const dataLines = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (!dataLines.length) continue
    const dataText = dataLines.join('\n')
    let data
    try {
      data = JSON.parse(dataText)
    } catch {
      data = dataText
    }
    events.push({ event, data })
  }
  return events
}

async function chat(body, signal) {
  const response = await fetch(`${BASE}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`POST /api/ai/chat 返回 HTTP ${response.status}：${text.slice(0, 300)}`)
  }
  const raw = await response.text()
  currentEvents = parseSse(raw)
  return currentEvents
}

/** GET 一个 JSON 接口（AI 日志查询等） */
async function apiGet(pathname) {
  const response = await fetch(`${BASE}${pathname}`)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`GET ${pathname} 返回 HTTP ${response.status}：${text.slice(0, 300)}`)
  }
  return await response.json()
}

/* ---- AI 运行日志（<DATA_DIR>/logs/ai-runs-<date>.jsonl + GET /api/ai/logs） ---- */

function aiLogsDir() {
  return path.join(DATA_DIR, 'logs')
}

/** 临时数据目录下已落盘的 AI 运行日志文件（按文件名排序） */
function aiLogFilesOnDisk() {
  if (!existsSync(aiLogsDir())) return []
  return readdirSync(aiLogsDir())
    .filter((name) => /^ai-runs-.*\.jsonl$/.test(name))
    .sort()
}

/** 解析落盘 JSONL 的全部条目；无法解析的行直接报错（日志必须是合法 JSONL） */
function readAiLogEntriesFromDisk() {
  const files = aiLogFilesOnDisk()
  if (!files.length) throw new Error(`临时目录下没有 AI 运行日志文件：${aiLogsDir()}`)
  const entries = []
  for (const name of files) {
    const full = path.join(aiLogsDir(), name)
    const lines = readFileSync(full, 'utf8').split('\n')
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim()
      if (!line) continue
      try {
        entries.push({ file: name, entry: JSON.parse(line) })
      } catch (error) {
        throw new Error(`日志文件 ${name} 第 ${index + 1} 行不是合法 JSON：${error?.message ?? error}`)
      }
    }
  }
  return entries
}

/** 通过 GET /api/ai/logs 查询某次 run 的日志（runId 来自 start 事件的 data.runId） */
async function fetchRunLog(runId) {
  if (!runId) throw new Error('没有从 start 事件拿到 runId，无法查询 AI 运行日志')
  const result = await apiGet(`/api/ai/logs?runId=${encodeURIComponent(runId)}&limit=5`)
  if (!result || result.ok !== true) throw new Error(`GET /api/ai/logs 返回异常：${JSON.stringify(result)?.slice(0, 240)}`)
  if (!Array.isArray(result.logs)) throw new Error('GET /api/ai/logs 没有返回 logs 数组')
  const entry = result.logs.find((log) => log.runId === runId)
  if (!entry) throw new Error(`AI 运行日志里找不到 runId=${runId}（共 ${result.count} 条）`)
  return entry
}

function eventsOf(events, name) {
  return events.filter((event) => event.event === name).map((event) => event.data)
}

function toolEnds(events) {
  return eventsOf(events, 'tool_end')
}

function toolStarts(events) {
  return eventsOf(events, 'tool_start')
}

function errorMessages(events) {
  return eventsOf(events, 'error').map((data) => String(data?.message ?? data))
}

function textOf(events) {
  return eventsOf(events, 'text').map((data) => String(data?.delta ?? '')).join('')
}

function lastProject(events) {
  const list = eventsOf(events, 'project')
  if (!list.length) throw new Error('没有收到 project 事件（工程快照未回传）')
  return list[list.length - 1].project
}

function findTrack(project, trackId) {
  const track = project.tracks.find((item) => item.id === trackId)
  if (!track) throw new Error(`工程里找不到轨道 ${trackId}（现有：${project.tracks.map((item) => item.id).join(', ')}）`)
  return track
}

function findClip(track, clipId) {
  const clip = track.clips.find((item) => item.id === clipId)
  if (!clip) throw new Error(`轨道 ${track.id} 里找不到片段 ${clipId}（现有：${track.clips.map((item) => item.id).join(', ')}）`)
  return clip
}

function assertNoError(events) {
  const messages = errorMessages(events)
  if (messages.length) throw new Error(`收到 error 事件：${messages.join(' | ')}`)
}

function assertDone(events) {
  const done = eventsOf(events, 'done')
  if (!done.length) throw new Error('没有收到 done 事件（run 未正常结束）')
  return done[done.length - 1]
}

function assertAllToolEndsOk(events, expectedCount) {
  const ends = toolEnds(events)
  if (typeof expectedCount === 'number' && ends.length !== expectedCount) {
    throw new Error(`期望 ${expectedCount} 次工具调用，实际 ${ends.length} 次`)
  }
  const bad = ends.filter((end) => !end.ok)
  if (bad.length) {
    throw new Error(`有 ${bad.length} 次工具调用失败：${bad.map((end) => `[${end.id}] ${end.error ?? end.result ?? ''}`).join(' | ')}`)
  }
  return ends
}

function assertClose(actual, expected, label) {
  if (typeof actual !== 'number' || !Number.isFinite(actual) || Math.abs(actual - expected) > 0.001) {
    throw new Error(`${label} 期望 ${expected}，实际 ${actual}`)
  }
}

/** 失败时打印相关 SSE 事件摘要 */
function printEventDigest(events) {
  if (!events?.length) {
    console.log(`      ${C.dim}（本次场景没有收到任何 SSE 事件）${C.reset}`)
    return
  }
  const lines = []
  const counts = {}
  for (const event of events) counts[event.event] = (counts[event.event] ?? 0) + 1
  lines.push(`事件统计：${Object.entries(counts).map(([name, count]) => `${name}×${count}`).join(' ') || '无'}`)

  const starts = toolStarts(events)
  const ends = toolEnds(events)
  if (starts.length) {
    lines.push(
      '工具调用：' +
        starts
          .map((start, index) => {
            const end = ends[index]
            const status = end ? (end.ok ? 'ok' : `fail（${end.error ?? end.result ?? ''}）`) : '无 tool_end'
            return `${start.name}[${start.id}] ${status}`
          })
          .join('；'),
    )
  }
  const messages = errorMessages(events)
  if (messages.length) lines.push(`error 事件：${messages.join(' | ')}`)
  const text = textOf(events)
  if (text) lines.push(`文本：${JSON.stringify(text.slice(0, 240))}`)
  const projects = eventsOf(events, 'project')
  if (projects.length) {
    const project = projects[projects.length - 1].project
    lines.push(`工程：${project.tracks.length} 轨 / ${project.chords.length} 和弦 / ${project.sections.length} 段落`)
    lines.push(
      '轨道：' +
        project.tracks
          .map((track) => {
            const clips = track.clips
              .map((clip) => `${clip.id}@${clip.startBeat}+${clip.lengthBeats}/${clip.notes?.length ?? 0}音`)
              .join(',')
            return `${track.id}(${track.instrumentId})${clips ? `[${clips}]` : ''}`
          })
          .join('；'),
    )
    lines.push(`和弦：${project.chords.map((chord) => `${chord.root}/${chord.quality}`).join(',') || '（空）'}`)
    lines.push(
      `段落：${project.sections.map((section) => `${section.name}@${section.startBar}+${section.bars}`).join(',') || '（空）'}`,
    )
  }
  const done = eventsOf(events, 'done')
  if (done.length) lines.push(`done：usage=${JSON.stringify(done[done.length - 1]?.usage ?? null)}`)
  for (const line of lines) {
    console.log(`      ${C.dim}${line.length > 600 ? line.slice(0, 600) + '…' : line}${C.reset}`)
  }
}

/* ------------------------------------------------------------------ */
/* 6. 场景执行器                                                       */
/* ------------------------------------------------------------------ */

async function waitForIdle(timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const state = await (await fetch(`${BASE}/api/ai/status`)).json()
      if (!state?.running) return true
    } catch {
      return false
    }
    await sleep(100)
  }
  return false
}

async function cancelActiveRun() {
  try {
    await fetch(`${BASE}/api/ai/cancel`, { method: 'POST' })
  } catch {
    /* 后端可能已退出 */
  }
}

async function runScenario(name, fn) {
  currentEvents = []
  let timedOut = false
  const controller = new AbortController()
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, SCENARIO_TIMEOUT_MS)
  try {
    const detail = await fn(controller.signal)
    ok(name, typeof detail === 'string' ? detail : '')
  } catch (error) {
    if (timedOut) bad(name, new Error(`场景超时（${SCENARIO_TIMEOUT_MS / 1000}s，已中止该 run）`))
    else bad(name, error)
    printEventDigest(currentEvents)
    await cancelActiveRun()
  } finally {
    clearTimeout(timer)
    await waitForIdle(5000)
    currentEvents = []
  }
}

/* ------------------------------------------------------------------ */
/* 7. 回归场景（1-11）+ T4/T6/T7 新增（12-24）                        */
/* ------------------------------------------------------------------ */

/** 场景 1：update_track 只改 reverbSend/delaySend 必须 ok=true 且真的生效 */
async function scenarioUpdateTrackSends(signal) {
  setMock(({ round }) =>
    round === 0
      ? {
          toolCalls: [
            { id: 'call_reverb', name: 'update_track', args: { trackId: 't_piano', reverbSend: 0.3, delaySend: 0.1 } },
          ],
        }
      : { text: '已经把钢琴的混响调到 0.3、延迟发送调到 0.1。' },
  )
  const events = await chat(
    {
      messages: [{ role: 'user', content: '把钢琴轨的混响调到 0.3，延迟发送调到 0.1' }],
      project: fixtureProject(),
      intent: 'optimize',
    },
    signal,
  )
  assertNoError(events)
  assertAllToolEndsOk(events, 1)
  const starts = toolStarts(events)
  if (starts.length !== 1 || starts[0].name !== 'update_track') {
    throw new Error(`工具名异常：${starts.map((start) => start.name).join(',')}`)
  }
  const track = findTrack(lastProject(events), 't_piano')
  assertClose(track.reverbSend, 0.3, 'reverbSend')
  assertClose(track.delaySend, 0.1, 'delaySend')
  return `reverbSend=${track.reverbSend} · delaySend=${track.delaySend}`
}

/** 场景 2：字符串和弦 + quality 别名（"Am" 不能变成 A 大三和弦） */
async function scenarioChordQualityAlias(signal) {
  setMock(({ round }) =>
    round === 0
      ? { toolCalls: [{ id: 'call_chords', name: 'set_chords', args: { chords: ['Am', 'F#m7', 'Bb'] } }] }
      : { text: '和弦进行已设置为 Am - F#m7 - Bb。' },
  )
  const events = await chat(
    {
      messages: [{ role: 'user', content: '把和弦进行设成 Am F#m7 Bb' }],
      project: fixtureProject(),
      intent: 'chords',
    },
    signal,
  )
  assertNoError(events)
  assertAllToolEndsOk(events, 1)
  const project = lastProject(events)
  if (project.chords.length !== 3) throw new Error(`期望 3 个和弦，实际 ${project.chords.length}`)
  const expected = [
    { root: 9, quality: 'min' },
    { root: 6, quality: 'min7' },
    { root: 10, quality: 'maj' },
  ]
  expected.forEach((want, index) => {
    const got = project.chords[index]
    if (got.root !== want.root) throw new Error(`第 ${index + 1} 个和弦根音期望 ${want.root}，实际 ${got.root}`)
    if (got.quality !== want.quality) throw new Error(`第 ${index + 1} 个和弦 quality 期望 ${want.quality}，实际 ${got.quality}`)
  })
  return `chords=${project.chords.map((chord) => `${chord.root}/${chord.quality}`).join(',')}`
}

/** 场景 3：write_notes 支持音名音高（pitch:"C4"），且不能静默清空片段 */
async function scenarioNoteNamePitch(signal) {
  setMock(({ round }) =>
    round === 0
      ? {
          toolCalls: [
            {
              id: 'call_notes',
              name: 'write_notes',
              args: {
                clipId: 'c_piano',
                mode: 'replace',
                notes: [
                  { pitch: 'C4', start: 0, duration: 1 },
                  { pitch: 'E4', start: 1, duration: 1 },
                ],
              },
            },
          ],
        }
      : { text: '已写入 C4、E4 两个音符。' },
  )
  const events = await chat(
    {
      messages: [{ role: 'user', content: '把钢琴片段改成 C4 和 E4 两个音' }],
      project: fixtureProject(),
      intent: 'optimize',
    },
    signal,
  )
  assertNoError(events)
  assertAllToolEndsOk(events, 1)
  const clip = findClip(findTrack(lastProject(events), 't_piano'), 'c_piano')
  if (clip.notes.length !== 2) throw new Error(`期望 2 个音符，实际 ${clip.notes.length}（片段被清空？）`)
  const pitches = [...clip.notes].sort((a, b) => a.start - b.start).map((note) => note.pitch)
  if (pitches[0] !== 60 || pitches[1] !== 64) throw new Error(`音高期望 [60,64]，实际 [${pitches.join(',')}]`)
  return `notes=${clip.notes.length} · pitch=${pitches.join(',')}`
}

/** 场景 4：数字字符串参数（volume:"0.7"）要归一化成数字 */
async function scenarioNumericString(signal) {
  setMock(({ round }) =>
    round === 0
      ? { toolCalls: [{ id: 'call_volume', name: 'update_track', args: { trackId: 't_piano', volume: '0.7' } }] }
      : { text: '音量已调低到 0.7。' },
  )
  const events = await chat(
    {
      messages: [{ role: 'user', content: '把钢琴音量调到 0.7' }],
      project: fixtureProject(),
      intent: 'optimize',
    },
    signal,
  )
  assertNoError(events)
  assertAllToolEndsOk(events, 1)
  const track = findTrack(lastProject(events), 't_piano')
  assertClose(track.volume, 0.7, 'volume')
  return `volume=${track.volume}`
}

/** 场景 5：非法乐器 id 不能静默回退钢琴；模型按提示修正后要成功 */
async function scenarioInvalidInstrument(signal) {
  setMock(({ round }) => {
    if (round === 0) {
      return { toolCalls: [{ id: 'call_bad_instrument', name: 'create_track', args: { instrumentId: 'strings' } }] }
    }
    if (round === 1) {
      return {
        toolCalls: [
          { id: 'call_good_instrument', name: 'create_track', args: { instrumentId: 'strings.ensemble', name: '弦乐' } },
        ],
      }
    }
    return { text: '已新建弦乐轨（之前那个乐器 id 无效，已改成 strings.ensemble）。' }
  })
  const events = await chat(
    {
      messages: [{ role: 'user', content: '加一条弦乐轨' }],
      project: fixtureProject(),
      intent: 'compose',
    },
    signal,
  )
  assertNoError(events)
  const ends = toolEnds(events)
  if (ends.length !== 2) throw new Error(`期望 2 次 create_track 调用，实际 ${ends.length} 次`)
  if (ends[0].ok) throw new Error('非法乐器 id "strings" 被静默接受了（应 ok=false）')
  const hint = String(ends[0].error ?? ends[0].result ?? '')
  if (!/piano\.grand|strings\.ensemble|可用|可选|有效|instrument/i.test(hint)) {
    throw new Error(`非法乐器的失败提示不可操作：${JSON.stringify(hint.slice(0, 200))}`)
  }
  if (!ends[1].ok) throw new Error(`修正后的合法乐器调用仍失败：${ends[1].error ?? ''}`)
  const project = lastProject(events)
  if (project.tracks.length !== 3) throw new Error(`期望工程 3 条轨道，实际 ${project.tracks.length} 条`)
  if (!project.tracks.some((track) => track.instrumentId === 'strings.ensemble')) {
    throw new Error(`工程里没有 strings.ensemble 轨道：${project.tracks.map((track) => track.instrumentId).join(',')}`)
  }
  return `invalid→ok=false（提示可操作）· valid→ok=true · tracks=${project.tracks.length}`
}

/** 场景 6：set_sections 支持 startBeat/lengthBeats 别名（4/4 下 8拍/16拍 → 第2小节/4小节） */
async function scenarioSectionAlias(signal) {
  setMock(({ round }) =>
    round === 0
      ? {
          toolCalls: [
            {
              id: 'call_sections',
              name: 'set_sections',
              args: { sections: [{ name: '主歌', startBeat: 8, lengthBeats: 16 }] },
            },
          ],
        }
      : { text: '段落已设置：主歌从第 2 小节开始，共 4 小节。' },
  )
  const events = await chat(
    {
      messages: [{ role: 'user', content: '把主歌设成从第 2 小节开始，持续 4 小节' }],
      project: fixtureProject(),
      intent: 'compose',
    },
    signal,
  )
  assertNoError(events)
  assertAllToolEndsOk(events, 1)
  const sections = lastProject(events).sections
  if (!sections.length) throw new Error('工程没有段落')
  if (sections[0].startBar !== 2) throw new Error(`startBar 期望 2，实际 ${sections[0].startBar}`)
  if (sections[0].bars !== 4) throw new Error(`bars 期望 4，实际 ${sections[0].bars}`)
  return `startBar=${sections[0].startBar} · bars=${sections[0].bars}`
}

/** 场景 7：generate_smart_clip 传 replaceClipId 但不传 startBeat 时必须保留原起点 */
async function scenarioReplaceClipKeepsStart(signal) {
  setMock(({ round }) =>
    round === 0
      ? {
          toolCalls: [
            {
              id: 'call_replace',
              name: 'generate_smart_clip',
              args: { kind: 'drums', trackId: 't_drums', replaceClipId: 'c_drums', bars: 4 },
            },
          ],
        }
      : { text: '鼓组片段已按 4 小节重写。' },
  )
  const events = await chat(
    {
      messages: [{ role: 'user', content: '把鼓组那个片段重新生成一下，4 小节' }],
      project: fixtureProject(),
      intent: 'optimize',
    },
    signal,
  )
  assertNoError(events)
  assertAllToolEndsOk(events, 1)
  const clip = findClip(findTrack(lastProject(events), 't_drums'), 'c_drums')
  assertClose(clip.startBeat, 8, '替换后 startBeat（不应被重置为 0）')
  if (!clip.notes.length) throw new Error('替换后的片段没有音符')
  return `startBeat=${clip.startBeat} · notes=${clip.notes.length}`
}

/** 场景 8：服务商瞬时错误（第一次 500）必须自动重试成功，run 不报错 */
async function scenarioProviderRetry(signal) {
  setMock(({ round }) =>
    round === 0
      ? { status: 500, body: { error: { message: 'mock upstream temporary failure', type: 'server_error' } } }
      : { text: '重试成功，已经完成。' },
  )
  const events = await chat(
    {
      messages: [{ role: 'user', content: '帮我规划一下这首歌' }],
      project: fixtureProject(),
      intent: 'compose',
    },
    signal,
  )
  assertNoError(events)
  assertDone(events)
  const text = textOf(events)
  if (!text.includes('重试成功')) throw new Error(`重试后未收到模型文本，实际：${JSON.stringify(text.slice(0, 160))}`)
  const starts = eventsOf(events, 'start')
  if (!starts.length) throw new Error('没有收到 start 事件')
  return `mock 第 1 次 500 → 自动重试成功（共 ${mockState.requests} 次请求）`
}

/** 场景 9：工具轮数上限从 24 提到 32；mock 准备 40 轮，最多执行 32 轮且最后一轮不产生「未执行」失败卡片 */
async function scenarioMaxRounds(signal) {
  setMock(({ round }) =>
    round < 40
      ? { toolCalls: [{ id: `call_summary_${round}`, name: 'get_project_summary', args: {} }] }
      : { text: '工程概览已读完。' },
  )
  const events = await chat(
    {
      messages: [{ role: 'user', content: '反复检查工程，尽量多调用工具' }],
      project: fixtureProject(),
      intent: 'optimize',
    },
    signal,
  )
  assertNoError(events)
  assertDone(events)
  const starts = toolStarts(events)
  const ends = toolEnds(events)
  if (starts.length > 32) throw new Error(`工具调用 ${starts.length} 次，超过上限 32`)
  if (starts.length !== 32) {
    throw new Error(`工具调用期望恰好 32 次（MAX_ROUNDS=32，mock 准备了 40 轮），实际 ${starts.length} 次`)
  }
  if (ends.length !== starts.length) throw new Error(`tool_start=${starts.length} 与 tool_end=${ends.length} 数量不一致`)
  const notExecuted = ends.filter(
    (end) => !end.ok && /轮数上限|未执行|上限/.test(String(end.error ?? end.result ?? '')),
  )
  if (notExecuted.length) {
    throw new Error(`仍产生「轮数上限未执行」失败卡片：${notExecuted.map((end) => end.error).join(' | ')}`)
  }
  const failedEnds = ends.filter((end) => !end.ok)
  if (failedEnds.length) throw new Error(`有 ${failedEnds.length} 次工具调用失败：${failedEnds[0]?.error ?? ''}`)
  const text = textOf(events)
  if (!text.trim()) throw new Error('达到轮数上限后没有收尾文本')
  return `tool_calls=${starts.length}（=32 上限）· 无失败卡片 · 有收尾文本`
}

/** 场景 10：完整 compose 流程（set_tempo → create_track → generate_smart_clip → set_sections → text） */
async function scenarioComposeFlow(signal) {
  const usage = (round) => ({ prompt_tokens: 100 + round * 10, completion_tokens: 40 + round * 5 })
  setMock(({ round }) => {
    if (round === 0) {
      return { toolCalls: [{ id: 'call_tempo', name: 'set_tempo', args: { tempo: 118 } }], usage: usage(round) }
    }
    if (round === 1) {
      return {
        toolCalls: [
          { id: 'call_track', name: 'create_track', args: { instrumentId: 'piano.grand', name: '和声钢琴' } },
        ],
        usage: usage(round),
      }
    }
    if (round === 2) {
      return {
        toolCalls: [
          { id: 'call_pad', name: 'generate_smart_clip', args: { kind: 'pad', bars: 4, style: 'cinematic' } },
        ],
        usage: usage(round),
      }
    }
    if (round === 3) {
      return {
        toolCalls: [
          {
            id: 'call_sections',
            name: 'set_sections',
            args: { sections: [{ name: '主歌', startBar: 0, bars: 4 }, { name: '副歌', startBar: 4, bars: 8 }] },
          },
        ],
        usage: usage(round),
      }
    }
    return { text: '编曲完成：118 BPM，已有和声钢琴、铺底与段落结构。', usage: usage(round) }
  })
  const events = await chat(
    {
      messages: [{ role: 'user', content: '做一首 8 小节的电影感流行歌' }],
      project: fixtureProject(),
      intent: 'compose',
    },
    signal,
  )
  assertNoError(events)
  const done = assertDone(events)
  const ends = assertAllToolEndsOk(events, 4)
  const projectEvents = eventsOf(events, 'project')
  if (projectEvents.length < 1) throw new Error('没有收到任何 project 事件')
  const project = lastProject(events)
  if (project.tempo !== 118) throw new Error(`tempo 期望 118，实际 ${project.tempo}`)
  if (project.sections.length !== 2) throw new Error(`段落期望 2 个，实际 ${project.sections.length}`)
  if (project.tracks.length < 3) throw new Error(`轨道期望 ≥3 条，实际 ${project.tracks.length}`)
  const totalNotes = project.tracks.reduce(
    (sum, track) => sum + track.clips.reduce((count, clip) => count + clip.notes.length, 0),
    0,
  )
  if (totalNotes <= 0) throw new Error('工程里没有音符')
  const usageResult = done.usage ?? {}
  if (!(Number(usageResult.inputTokens) > 0) && !(Number(usageResult.outputTokens) > 0)) {
    throw new Error(`done 事件没有 usage：${JSON.stringify(usageResult)}`)
  }
  return `${ends.length} 次工具全 ok · ${project.tracks.length} 轨/${totalNotes} 音 · usage=${usageResult.inputTokens}/${usageResult.outputTokens}`
}

/** 场景 11：finish_reason=length 不能崩，要给出「输出被截断」提示 */
async function scenarioFinishLength(signal) {
  setMock(({ round }) => ({
    text: round === 0 ? '好的，我来安排。' : '',
    finishReason: 'length',
    usage: { prompt_tokens: 80, completion_tokens: 16 },
  }))
  const events = await chat(
    {
      messages: [{ role: 'user', content: '帮我完成整首歌的编曲' }],
      project: fixtureProject(),
      intent: 'compose',
    },
    signal,
  )
  assertNoError(events)
  assertDone(events)
  const text = textOf(events)
  if (!/截断|长度上限|达到.{0,6}上限|拆小|拆分|truncat/i.test(text)) {
    throw new Error(`finish_reason=length 时没有截断提示，实际文本：${JSON.stringify(text.slice(0, 240))}`)
  }
  return `truncated 提示：${JSON.stringify(text.slice(-80))}`
}

/* ------------------------------------------------------------------ */
/* 7b. T4 新增场景：运行日志 / 截断自愈 / 质量自检自动修复              */
/* ------------------------------------------------------------------ */

/** 从 start 事件拿 runId（GET /api/ai/logs?runId= 要用） */
function runIdOf(events) {
  const starts = eventsOf(events, 'start')
  const runId = starts[0]?.runId
  if (!runId) throw new Error('没有收到 start 事件（拿不到 runId）')
  return runId
}

/** 同一轨道内片段时间重叠检查（与后端质量自检的判定保持一致） */
function clipOverlaps(track) {
  const clips = track.clips.filter((clip) => !clip.muted).sort((a, b) => a.startBeat - b.startBeat)
  const overlaps = []
  for (let index = 1; index < clips.length; index++) {
    const previous = clips[index - 1]
    const current = clips[index]
    if (previous.startBeat + previous.lengthBeats - current.startBeat > 0.05) {
      overlaps.push(`${previous.id}(@${previous.startBeat}+${previous.lengthBeats}) 与 ${current.id}(@${current.startBeat}+${current.lengthBeats})`)
    }
  }
  return overlaps
}

/** 场景 12（A）：AI 运行日志落盘为 JSONL，且 GET /api/ai/logs?failed=1 能抓到工具失败 */
async function scenarioAiRunLogs(signal) {
  setMock(({ round }) =>
    round === 0
      ? { toolCalls: [{ id: 'call_log_bad_instrument', name: 'create_track', args: { instrumentId: 'strings' } }] }
      : { text: '这个乐器 id 无效，本次没有创建轨道。' },
  )
  const events = await chat(
    {
      messages: [{ role: 'user', content: '用 strings 这个乐器建一条轨道' }],
      project: fixtureProject(),
      intent: 'compose',
    },
    signal,
  )
  assertNoError(events)
  assertDone(events)
  const runId = runIdOf(events)
  const failedEnd = toolEnds(events).find((end) => !end.ok)
  if (!failedEnd) throw new Error('预期 create_track(instrumentId:"strings") 返回 ok=false，但所有工具都成功了')

  // 1) GET /api/ai/logs?failed=1 至少能查到失败运行
  const failedQuery = await apiGet('/api/ai/logs?failed=1&limit=50')
  if (!failedQuery || failedQuery.ok !== true) throw new Error(`GET /api/ai/logs?failed=1 返回异常：${JSON.stringify(failedQuery)?.slice(0, 240)}`)
  if (!(failedQuery.count >= 1) || !Array.isArray(failedQuery.logs) || failedQuery.logs.length < 1) {
    throw new Error(`GET /api/ai/logs?failed=1 没有返回失败运行（count=${failedQuery?.count}）`)
  }
  if (!Array.isArray(failedQuery.files) || !failedQuery.files.some((file) => /^ai-runs-.*\.jsonl$/.test(String(file?.name)))) {
    throw new Error(`GET /api/ai/logs 的 files 字段缺少 ai-runs-*.jsonl：${JSON.stringify(failedQuery.files)?.slice(0, 200)}`)
  }

  // 2) 按 runId 查到本条运行，字段/工具失败记录齐全
  const entry = await fetchRunLog(runId)
  if (!(entry.toolFailureCount >= 1)) throw new Error(`日志 toolFailureCount 期望 ≥1，实际 ${entry.toolFailureCount}`)
  const toolRecord = (entry.toolCalls ?? []).find((call) => call.name === 'create_track' && call.ok === false)
  if (!toolRecord) {
    throw new Error(
      `日志 toolCalls 里没有 create_track(ok=false)：${JSON.stringify((entry.toolCalls ?? []).map((call) => `${call.name}:${call.ok}`))}`,
    )
  }
  if (typeof toolRecord.error !== 'string' || !toolRecord.error.trim()) {
    throw new Error(`失败的 create_track 日志没有 error 文本：${JSON.stringify(toolRecord)}`)
  }

  // 3) 临时 DATA_DIR/logs/ 下真的落盘了 JSONL 且每行可解析
  const diskFiles = aiLogFilesOnDisk()
  if (!diskFiles.length) throw new Error(`临时目录下没有 ai-runs-*.jsonl：${aiLogsDir()}`)
  const diskRows = readAiLogEntriesFromDisk()
  const diskEntry = diskRows.find((row) => row.entry?.runId === runId)?.entry
  if (!diskEntry) throw new Error(`落盘 JSONL 里找不到 runId=${runId}（共 ${diskRows.length} 条）`)
  if (!(diskEntry.toolFailureCount >= 1)) throw new Error(`落盘日志 toolFailureCount 期望 ≥1，实际 ${diskEntry.toolFailureCount}`)

  return `runId=${runId} · failed 运行 ${failedQuery.count} 条 · 落盘 ${diskFiles.join(',')} · toolFailures=${entry.toolFailureCount}`
}

/** 场景 13（B）：只有 reasoning 的 finish_reason=length 自动加倍 max_tokens 重试，且不再提示截断 */
async function scenarioReasoningTruncationSelfHeal(signal) {
  setMock(({ round }) =>
    round === 0
      ? {
          // 推理模型把预算全花在思考上：只有 reasoning_content，正文/工具调用为空
          reasoning: '让我仔细想想这首歌的段落与配器……（推理吃满预算，正文还没开始）',
          finishReason: 'length',
          usage: { prompt_tokens: 60, completion_tokens: 64 },
        }
      : { text: '推理预算自愈成功，编曲已经完成。', usage: { prompt_tokens: 80, completion_tokens: 32 } },
  )
  const events = await chat(
    {
      messages: [{ role: 'user', content: '帮我完整编一段 8 小节的歌' }],
      project: fixtureProject(),
      intent: 'compose',
    },
    signal,
  )
  assertNoError(events)
  assertDone(events)
  const text = textOf(events)
  if (!text.includes('自愈成功')) throw new Error(`自愈重试后的模型文本没收到，实际：${JSON.stringify(text.slice(0, 200))}`)
  if (/被截断|达到 max_tokens|拆小|拆分/.test(text)) {
    throw new Error(`自动加大 max_tokens 成功后仍出现截断提示：${JSON.stringify(text.slice(0, 240))}`)
  }

  // mock 侧：第 2 次请求的 max_tokens 必须比第 1 次大
  const requests = mockState.payloads
  if (requests.length < 2) throw new Error(`mock 只收到 ${requests.length} 次请求（期望 ≥2：截断后自动重试）`)
  const firstTokens = requests[0].maxTokens
  const secondTokens = requests[1].maxTokens
  if (typeof firstTokens !== 'number' || typeof secondTokens !== 'number') {
    throw new Error(`请求体 max_tokens 不是数字：第 1 次 ${firstTokens} / 第 2 次 ${secondTokens}`)
  }
  if (!(secondTokens > firstTokens)) throw new Error(`第 2 次请求 max_tokens 期望变大，实际 ${firstTokens} → ${secondTokens}`)

  // 日志：providerCalls 里要有 escalated=true 的重试，且预算确实变大
  const entry = await fetchRunLog(runIdOf(events))
  const providerCalls = Array.isArray(entry.providerCalls) ? entry.providerCalls : []
  if (providerCalls.length < 2) throw new Error(`日志 providerCalls 期望 ≥2，实际 ${providerCalls.length}`)
  const escalated = providerCalls.find((call) => call.escalated === true)
  if (!escalated) throw new Error(`日志里没有 escalated=true 的 providerCall：${JSON.stringify(providerCalls)}`)
  if (!(typeof escalated.maxTokens === 'number' && escalated.maxTokens > firstTokens)) {
    throw new Error(`escalated providerCall 的 maxTokens 期望 > ${firstTokens}，实际 ${escalated.maxTokens}`)
  }
  if (!(escalated.maxTokens === secondTokens)) {
    throw new Error(`日志 maxTokens(${escalated.maxTokens}) 与 mock 收到的第 2 次请求(${secondTokens}) 不一致`)
  }

  return `max_tokens ${firstTokens} → ${secondTokens} · escalated=true · 无截断提示 · 有正文`
}

/** 场景 14（C）：本次生成引入片段重叠 → 质量自检提示 + 注入修复指令 → 模型删除重叠片段，日志 qualityRepair.triggered=true */
async function scenarioQualitySelfRepair(signal) {
  const usage = (round) => ({ prompt_tokens: 120 + round * 10, completion_tokens: 30 + round * 5 })
  setMock(({ round, payload }) => {
    const lastUser = payloadLastUser(payload)
    // 质量修复回合：消息以注入的 user 指令结尾（只在这一轮触发，避免工具结果轮重复触发）
    if (payloadEndsWithUser(payload) && /质量自检|自动修复|修复/.test(lastUser)) {
      const createdIds = payloadCreatedClipIds(payload)
      const target = createdIds[createdIds.length - 1]
      if (!target) {
        return { status: 500, body: { error: { message: 'mock：质量修复回合无法从工具结果提取新建片段 id' } } }
      }
      return {
        toolCalls: [{ id: 'call_fix_overlap', name: 'delete_clip', args: { clipId: target, trackId: 't_piano' } }],
        text: '收到质量自检结果：删除重叠的片段。',
        usage: usage(round),
      }
    }
    if (round === 0) {
      // 第 1 轮：同一轨道上创建两个起点/长度完全相同的片段 → 时间重叠（本次生成新引入的高优先级问题）
      return {
        toolCalls: [
          { id: 'call_clip_a', name: 'create_clip', args: { trackId: 't_piano', name: '重叠A', startBeat: 32, lengthBeats: 8 } },
          { id: 'call_clip_b', name: 'create_clip', args: { trackId: 't_piano', name: '重叠B', startBeat: 32, lengthBeats: 8 } },
        ],
        text: '已在钢琴轨上新增两个片段。',
        usage: usage(round),
      }
    }
    return { text: '完成，轨道已经整理好。', usage: usage(round) }
  })
  const events = await chat(
    {
      messages: [{ role: 'user', content: '在钢琴轨上补两段伴奏' }],
      project: fixtureProject(),
      intent: 'compose',
    },
    signal,
  )
  assertNoError(events)
  assertDone(events)

  // 前端可见的自动修复提示
  const text = textOf(events)
  if (!/质量自检/.test(text)) throw new Error(`前端文本里没有「质量自检」提示：${JSON.stringify(text.slice(0, 300))}`)
  // mock 收到过质量修复指令（最后一条 user 消息）
  const repairRequest = mockState.payloads.find((request) => /质量自检|自动修复/.test(request.lastUser))
  if (!repairRequest) throw new Error('mock 没有收到质量修复的用户消息（没有注入修复指令）')
  // 修复回合真的执行了 delete_clip 且成功
  const fixEnds = toolEnds(events).filter((end) => end.id === 'call_fix_overlap')
  if (!fixEnds.length) throw new Error('没有收到 delete_clip 修复调用的 tool_end')
  if (!fixEnds[0].ok) throw new Error(`delete_clip 修复调用失败：${fixEnds[0].error ?? fixEnds[0].result ?? ''}`)

  // 最终工程该轨道没有时间重叠
  const track = findTrack(lastProject(events), 't_piano')
  const overlaps = clipOverlaps(track)
  if (overlaps.length) throw new Error(`质量修复后轨道 ${track.id} 仍有片段重叠：${overlaps.join('；')}`)

  // 日志：qualityRepair.triggered=true 且 repaired=true
  const entry = await fetchRunLog(runIdOf(events))
  const repair = entry.qualityRepair
  if (!repair || repair.triggered !== true) throw new Error(`日志 qualityRepair.triggered 期望 true，实际 ${JSON.stringify(repair)}`)
  if (!(repair.issueCount >= 1)) throw new Error(`日志 qualityRepair.issueCount 期望 ≥1，实际 ${repair.issueCount}`)
  if (repair.repaired !== true) throw new Error(`日志 qualityRepair.repaired 期望 true，实际 ${repair.repaired}`)

  return `${track.clips.length} 片段无重叠 · qualityRepair.triggered=true · 前端出现质量自检提示`
}

/** 场景 15（D 补充）：自动加倍预算耗尽（2 次）后仍截断，才应该出现「被截断」提示 */
async function scenarioTruncationAfterEscalationExhausted(signal) {
  setMock(({ round }) =>
    round < 3
      ? {
          reasoning: '继续深度推理…（每一轮都把预算花在思考上，正文仍未开始）',
          finishReason: 'length',
          usage: { prompt_tokens: 50, completion_tokens: 128 },
        }
      : { text: '（不应走到这里：前 3 次都已被截断）' },
  )
  const events = await chat(
    {
      messages: [{ role: 'user', content: '帮我一次性生成一整首复杂编曲' }],
      project: fixtureProject(),
      intent: 'compose',
    },
    signal,
  )
  assertNoError(events)
  assertDone(events)
  const text = textOf(events)
  if (!/截断|拆小|拆分/.test(text)) {
    throw new Error(`自动加倍预算仍被截断时没有截断提示，实际文本：${JSON.stringify(text.slice(0, 240))}`)
  }
  // 截断自愈：mock 应连续收到 3 次请求（初始 + 2 次加倍），max_tokens 逐次变大
  const requests = mockState.payloads
  if (requests.length !== 3) throw new Error(`期望 3 次请求（原有 1 + 自愈 2），实际 ${requests.length}`)
  const tokens = requests.map((request) => request.maxTokens)
  if (tokens.some((value) => typeof value !== 'number')) throw new Error(`请求体 max_tokens 异常：${JSON.stringify(tokens)}`)
  if (!(tokens[0] < tokens[1] && tokens[1] < tokens[2])) {
    throw new Error(`max_tokens 期望逐次变大，实际 ${tokens.join(' → ')}`)
  }
  const entry = await fetchRunLog(runIdOf(events))
  const calls = Array.isArray(entry.providerCalls) ? entry.providerCalls : []
  const escalatedCalls = calls.filter((call) => call.escalated === true)
  if (escalatedCalls.length < 2) throw new Error(`日志里期望 ≥2 次 escalated providerCall，实际 ${escalatedCalls.length}`)
  if (!calls.some((call) => call.truncated === true)) throw new Error('日志里没有 truncated=true 的 providerCall')
  return `max_tokens ${tokens.join(' → ')} · ${escalatedCalls.length} 次自愈 · 自愈耗尽后出现截断提示`
}

/** 场景 16：系统提示要带上「版权类误拒消解」策略，既允许正当用途、也保留两条收窄条件 */
async function scenarioCopyrightPolicyInPrompt(signal) {
  setMock(() => ({ text: '好的，我来写一段最终幻想风格的原创前奏。' }))
  const events = await chat(
    {
      messages: [{ role: 'user', content: '帮我写一段最终幻想风格的前奏' }],
      project: fixtureProject(),
      intent: 'compose',
    },
    signal,
  )
  assertNoError(events)
  assertDone(events)

  const payload = mockState.payloads[0]
  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  const system = messages.find((message) => message.role === 'system')
  const content = typeof system?.content === 'string' ? system.content : ''
  if (!content) throw new Error('首个请求没有 system 消息')

  const mustHave = [
    ['策略标题', '版权与用途判定'],
    ['允许情形：风格参照', '植松伸夫风格'],
    ['允许情形：学习分析', '和声进行'],
    ['允许情形：用户自备素材', '自己扒的 MIDI'],
    ['允许情形：个人练习 cover', 'cover 编曲'],
    ['收窄条件：逐音复刻', '逐音逐句精确还原'],
    ['收窄条件：歌词原文', '歌词原文'],
    ['措辞要求：不宣称原创', '受 XX 启发的原创编曲'],
  ]
  for (const [label, needle] of mustHave) {
    if (!content.includes(needle)) throw new Error(`系统提示缺少「${label}」：${needle}`)
  }
  if (content.indexOf('版权与用途判定') > content.indexOf('可用工具')) {
    throw new Error('版权策略应排在工具清单之前（先判定再行动）')
  }
  return `system 提示 ${content.length} 字符 · 8 条策略锚点齐全`
}

/* ------------------------------------------------------------------ */
/* 7c. T7 新增场景：16 个编辑/工程/界面工具 + 别名 + 情绪兜底 + ui 事件  */
/* ------------------------------------------------------------------ */

/** 片段内音符起点（按时间排序），断言量化/移调/人性化用 */
function noteStartsOf(clip) {
  return [...clip.notes].sort((a, b) => a.start - b.start).map((note) => note.start)
}

/** 片段内音高（按起点排序） */
function notePitchesOf(clip) {
  return [...clip.notes].sort((a, b) => a.start - b.start).map((note) => note.pitch)
}

/** 场景 17（A）：copy_clip 依次平铺 count 份 + transpose，起点/片段数/音高都要对 */
async function scenarioCopyClip(signal) {
  setMock(({ round }) =>
    round === 0
      ? {
          toolCalls: [
            { id: 'call_copy', name: 'copy_clip', args: { clipId: 'c_piano', count: 2, transpose: 2, startBeat: 8 } },
          ],
        }
      : { text: '已把钢琴主题复制两份、升高 2 个半音，并从第 8 拍开始平铺。' },
  )
  // 基础片段改成 8 拍（0..8），复制两份依次落在 8..16、16..24，不会与原片段重叠
  const project = scenarioProject((draft) => {
    const clip = draft.tracks[0].clips[0]
    clip.lengthBeats = 8
  })
  const events = await chat(
    {
      messages: [{ role: 'user', content: '把钢琴主题复制两份、升高两个半音，从第 8 拍接下去' }],
      project,
      intent: 'optimize',
    },
    signal,
  )
  assertNoError(events)
  assertAllToolEndsOk(events, 1)
  const track = findTrack(lastProject(events), 't_piano')
  const original = findClip(track, 'c_piano')
  if (track.clips.length !== 3) throw new Error(`片段数期望 3（原 1 + 复制 2），实际 ${track.clips.length}`)
  const copies = track.clips
    .filter((clip) => clip.id !== 'c_piano')
    .sort((a, b) => a.startBeat - b.startBeat)
  if (copies.length !== 2) throw new Error(`复制片段期望 2 个，实际 ${copies.length}`)
  if (copies[0].startBeat !== 8 || copies[1].startBeat !== 16) {
    throw new Error(`复制片段起点期望 8/16，实际 ${copies.map((clip) => clip.startBeat).join('/')}`)
  }
  const basePitches = notePitchesOf(original)
  for (const copy of copies) {
    const pitches = notePitchesOf(copy)
    if (pitches.length !== basePitches.length) {
      throw new Error(`复制片段音符数期望 ${basePitches.length}，实际 ${pitches.length}（音符没被完整复制）`)
    }
    const expected = basePitches.map((pitch) => pitch + 2)
    if (pitches.some((pitch, index) => pitch !== expected[index])) {
      throw new Error(`复制片段音高期望 ${expected.join(',')}（原+2），实际 ${pitches.join(',')}`)
    }
  }
  return `clips=3 · starts=8/16 · pitch=${notePitchesOf(copies[0]).join(',')}（原+2）`
}

/** 场景 18（B）：repeat_section 按小节整段复制，偏移 = (toBar-fromBar) * 每小节拍数 */
async function scenarioRepeatSection(signal) {
  setMock(({ round }) =>
    round === 0
      ? { toolCalls: [{ id: 'call_repeat', name: 'repeat_section', args: { fromBar: 2, bars: 2, toBar: 6 } }] }
      : { text: '已把第 2 小节起的 2 小节复制到第 6 小节。' },
  )
  // fixture：4/4 拍，鼓组片段起点 8 拍（=第 2 小节）→ 复制后新片段起点 8 + 16 = 24 拍
  const events = await chat(
    {
      messages: [{ role: 'user', content: '把第 2 小节开始的两小节整体复制到第 6 小节' }],
      project: fixtureProject(),
      intent: 'compose',
    },
    signal,
  )
  assertNoError(events)
  assertAllToolEndsOk(events, 1)
  const track = findTrack(lastProject(events), 't_drums')
  if (track.clips.length !== 2) throw new Error(`鼓组片段数期望 2（原 1 + 复制 1），实际 ${track.clips.length}`)
  const added = track.clips.find((clip) => clip.id !== 'c_drums')
  if (!added) throw new Error('没有找到 repeat_section 复制出来的新片段')
  assertClose(added.startBeat, 24, '重复段落新片段 startBeat（原 8 + 偏移 16）')
  assertClose(added.lengthBeats, 8, '重复段落新片段 lengthBeats')
  if (added.notes.length !== 2) throw new Error(`复制片段音符数期望 2，实际 ${added.notes.length}`)
  return `t_drums 片段 1→2 · 新片段 @${added.startBeat}（偏移 16 拍）· notes=${added.notes.length}`
}

/** 场景 19（C）：quantize_clip 把所有起点吸到 0.25 网格；humanize_clip 再叠加微小偏移且同 seed 可复现 */
async function scenarioQuantizeHumanize(signal) {
  const humanizeArgs = { clipId: 'c_piano', timing: 0.2, velocity: 0, seed: 7 }
  setMock(({ round }) => {
    if (round === 0) return { toolCalls: [{ id: 'call_quantize', name: 'quantize_clip', args: { clipId: 'c_piano', grid: 0.25 } }] }
    if (round === 1) return { toolCalls: [{ id: 'call_humanize', name: 'humanize_clip', args: humanizeArgs }] }
    return { text: '已把节奏量化到 0.25 拍网格，再加了人性化抖动。' }
  })
  // 故意给不齐的音符起点：0.1 / 0.37 / 1.62
  const project = scenarioProject((draft) => {
    const clip = draft.tracks[0].clips[0]
    clip.lengthBeats = 4
    clip.notes = [
      { id: 'n_off_1', pitch: 60, start: 0.1, duration: 0.2, velocity: 90 },
      { id: 'n_off_2', pitch: 64, start: 0.37, duration: 0.2, velocity: 88 },
      { id: 'n_off_3', pitch: 67, start: 1.62, duration: 0.2, velocity: 92 },
    ]
  })
  const events = await chat(
    {
      messages: [{ role: 'user', content: '把这段钢琴量化到十六分音符，再稍微人性化一点' }],
      project,
      intent: 'optimize',
    },
    signal,
  )
  assertNoError(events)
  const ends = assertAllToolEndsOk(events, 2)
  if (ends[0].id !== 'call_quantize' || ends[1].id !== 'call_humanize') {
    throw new Error(`工具执行顺序异常：${ends.map((end) => end.id).join(',')}`)
  }
  const snapshots = eventsOf(events, 'project').map((event) => event.project)
  if (snapshots.length !== 2) throw new Error(`期望 2 次工程快照（量化后、人性化后），实际 ${snapshots.length}`)

  // 1) 量化后：所有音符起点都是 0.25 的整数倍
  const quantized = snapshots[0]
  const quantizedStarts = noteStartsOf(findClip(findTrack(quantized, 't_piano'), 'c_piano'))
  for (const start of quantizedStarts) {
    const slots = start / 0.25
    if (Math.abs(slots - Math.round(slots)) > 1e-6) {
      throw new Error(`量化后音符起点 ${start} 不是 0.25 拍的整数倍（starts=${quantizedStarts.join(',')}）`)
    }
  }

  // 2) 人性化后：音符还在，起点只有 ±timing*0.08 的微小偏移（至少一个真的动了）
  const humanized = lastProject(events)
  const humanizedClip = findClip(findTrack(humanized, 't_piano'), 'c_piano')
  if (humanizedClip.notes.length !== 3) {
    throw new Error(`人性化后音符数期望 3，实际 ${humanizedClip.notes.length}（音符被弄丢？）`)
  }
  const humanizedStarts = noteStartsOf(humanizedClip)
  const maxDelta = 0.2 * 0.08
  let moved = 0
  for (let index = 0; index < quantizedStarts.length; index++) {
    const delta = Math.abs(humanizedStarts[index] - quantizedStarts[index])
    if (delta > maxDelta + 1e-6) {
      throw new Error(`人性化偏移 ${delta} 超过 ±${maxDelta} 拍（timing=0.2）`)
    }
    if (delta > 1e-9) moved++
  }
  if (moved === 0) throw new Error('humanize 后所有起点都没变化（timing 没生效）')

  // 3) 同 seed 可复现：拿量化后的快照再跑一次 humanize，起点应完全一致
  setMock(({ round }) =>
    round === 0
      ? { toolCalls: [{ id: 'call_humanize_replay', name: 'humanize_clip', args: humanizeArgs }] }
      : { text: '复现完成。' },
  )
  const replay = await chat(
    {
      messages: [{ role: 'user', content: '再对量化后的钢琴片段做一次同 seed 的人性化' }],
      project: quantized,
      intent: 'optimize',
    },
    signal,
  )
  assertNoError(replay)
  assertAllToolEndsOk(replay, 1)
  const replayStarts = noteStartsOf(findClip(findTrack(lastProject(replay), 't_piano'), 'c_piano'))
  for (let index = 0; index < humanizedStarts.length; index++) {
    if (Math.abs(replayStarts[index] - humanizedStarts[index]) > 1e-9) {
      throw new Error(
        `同 seed humanize 结果不可复现：第 ${index + 1} 个音符 ${humanizedStarts[index]} vs ${replayStarts[index]}`,
      )
    }
  }
  return `量化后 starts=${quantizedStarts.join(',')}（0.25 倍数）· humanize ${moved}/3 个音符偏移 · 同 seed 可复现`
}

/** 场景 20（D）：set_swing / set_time_signature / set_loop / transpose_project 四个工程级工具依次生效 */
async function scenarioProjectSettingsTools(signal) {
  const steps = [
    { id: 'call_swing', name: 'set_swing', args: { swing: 0.4 } },
    { id: 'call_meter', name: 'set_time_signature', args: { numerator: 6, denominator: 8 } },
    { id: 'call_loop', name: 'set_loop', args: { enabled: true, startBeat: 4, endBeat: 20 } },
    { id: 'call_transpose_project', name: 'transpose_project', args: { semitones: 2 } },
  ]
  setMock(({ round }) =>
    round < steps.length ? { toolCalls: [{ id: steps[round].id, name: steps[round].name, args: steps[round].args }] } : { text: '工程设置已更新：摇摆、拍号、循环与整体移调。' },
  )
  const events = await chat(
    {
      messages: [{ role: 'user', content: '把工程设成 6/8、swing 0.4，循环 4–20 拍，整体升高两个半音' }],
      project: fixtureProject(),
      intent: 'optimize',
    },
    signal,
  )
  assertNoError(events)
  const ends = assertAllToolEndsOk(events, 4)
  const project = lastProject(events)
  assertClose(project.swing, 0.4, 'project.swing')
  if (project.timeSignature.numerator !== 6 || project.timeSignature.denominator !== 8) {
    throw new Error(`拍号期望 6/8，实际 ${project.timeSignature.numerator}/${project.timeSignature.denominator}`)
  }
  if (project.loop.enabled !== true) throw new Error(`loop.enabled 期望 true，实际 ${project.loop.enabled}`)
  assertClose(project.loop.startBeat, 4, 'loop.startBeat')
  assertClose(project.loop.endBeat, 20, 'loop.endBeat')
  const pianoPitches = notePitchesOf(findClip(findTrack(project, 't_piano'), 'c_piano'))
  const expectedPitches = [62, 66, 69]
  if (pianoPitches.join(',') !== expectedPitches.join(',')) {
    throw new Error(`非鼓音符期望整体 +2（${expectedPitches.join(',')}），实际 ${pianoPitches.join(',')}`)
  }
  const drumPitches = notePitchesOf(findClip(findTrack(project, 't_drums'), 'c_drums'))
  if (drumPitches.join(',') !== '36,38') {
    throw new Error(`鼓组默认不应移调（期望 36,38），实际 ${drumPitches.join(',')}`)
  }
  if (project.key !== 'D') throw new Error(`整体移调 +2 后工程调性期望 D（C+2），实际 ${project.key}`)
  if (project.chords[0]?.root !== 2) throw new Error(`和弦根音期望 +2 → 2，实际 ${project.chords[0]?.root}`)
  return `swing=${project.swing} · ${project.timeSignature.numerator}/${project.timeSignature.denominator} · loop=${project.loop.startBeat}–${project.loop.endBeat} · key=${project.key} · piano=${pianoPitches.join(',')}`
}

/** 场景 21（E）：split_clip 把一个片段拆成两段，merge_clips 再合并回一个片段 */
async function scenarioSplitMerge(signal) {
  setMock(({ round, payload }) => {
    if (round === 0) {
      return { toolCalls: [{ id: 'call_split', name: 'split_clip', args: { clipId: 'c_piano', atBeat: 4 } }] }
    }
    if (round === 1) {
      const newClipId = payloadToolDataField(payload, 'newClipId')
      if (!newClipId) {
        return { status: 500, body: { error: { message: 'mock：split_clip 的工具结果里没有 newClipId' } } }
      }
      return { toolCalls: [{ id: 'call_merge', name: 'merge_clips', args: { clipIds: ['c_piano', newClipId] } }] }
    }
    return { text: '已拆成两段再合并回一个片段。' }
  })
  // 8 拍片段：音符 2..6 跨过 4 拍切点，必须被拆开截断
  const project = scenarioProject((draft) => {
    const clip = draft.tracks[0].clips[0]
    clip.lengthBeats = 8
    clip.notes = [
      { id: 'n_left', pitch: 60, start: 0, duration: 1, velocity: 90 },
      { id: 'n_cross', pitch: 64, start: 2, duration: 4, velocity: 92 },
      { id: 'n_right', pitch: 67, start: 5, duration: 1, velocity: 94 },
    ]
  })
  const events = await chat(
    {
      messages: [{ role: 'user', content: '把这个钢琴片段在第 4 拍拆开，然后再合并回去' }],
      project,
      intent: 'optimize',
    },
    signal,
  )
  assertNoError(events)
  assertAllToolEndsOk(events, 2)
  const snapshots = eventsOf(events, 'project').map((event) => event.project)
  if (snapshots.length !== 2) throw new Error(`期望 2 次工程快照（拆分后、合并后），实际 ${snapshots.length}`)
  const afterSplit = findTrack(snapshots[0], 't_piano')
  if (afterSplit.clips.length !== 2) throw new Error(`拆分后轨道片段数期望 2，实际 ${afterSplit.clips.length}`)
  const afterMerge = findTrack(lastProject(events), 't_piano')
  if (afterMerge.clips.length !== 1) throw new Error(`合并后轨道片段数期望 1，实际 ${afterMerge.clips.length}`)
  const merged = afterMerge.clips[0]
  if (merged.notes.length !== 3) throw new Error(`合并后片段音符数期望 3，实际 ${merged.notes.length}`)
  if (merged.startBeat !== 0) throw new Error(`合并后片段起点期望 0，实际 ${merged.startBeat}`)
  return `split→2 片段 · merge→1 片段/${merged.notes.length} 音 · start=${merged.startBeat}`
}

/** 场景 22（F）：AI 自创工具名 add_drum_groove → generate_smart_clip（kind=drums），要成功且回显说明 */
async function scenarioToolAlias(signal) {
  setMock(({ round }) =>
    round === 0
      ? { toolCalls: [{ id: 'call_alias', name: 'add_drum_groove', args: {} }] }
      : { text: '已按鼓组生成器补了一段鼓。' },
  )
  const events = await chat(
    {
      messages: [{ role: 'user', content: '加一段鼓的律动' }],
      project: fixtureProject(),
      intent: 'compose',
    },
    signal,
  )
  assertNoError(events)
  const ends = assertAllToolEndsOk(events, 1)
  const starts = toolStarts(events)
  if (starts.length !== 1 || starts[0].name !== 'generate_smart_clip') {
    throw new Error(`tool_start 名称期望解析成 generate_smart_clip，实际 ${starts.map((start) => start.name).join(',')}`)
  }
  if (starts[0].args?.kind !== 'drums') {
    throw new Error(`tool_start 参数应补上 kind=drums，实际 ${JSON.stringify(starts[0].args)}`)
  }
  const resultText = String(ends[0].result ?? '')
  if (!resultText.includes('已将 add_drum_groove 按 generate_smart_clip 执行')) {
    throw new Error(`工具结果没有回显别名解析说明：${JSON.stringify(resultText.slice(0, 240))}`)
  }
  const project = lastProject(events)
  if (project.tracks.length !== 3) throw new Error(`期望新增 1 条鼓轨（共 3 条），实际 ${project.tracks.length} 条`)
  const created = project.tracks.find((track) => track.id !== 't_piano' && track.id !== 't_drums')
  if (!created) throw new Error('没有找到别名调用新建的轨道')
  if (created.kind !== 'drum') throw new Error(`新建轨道 kind 期望 drum，实际 ${created.kind}`)
  const drumClips = created.clips.filter((clip) => clip.smart?.kind === 'drums')
  if (!drumClips.length) throw new Error(`新建轨道里没有 kind=drums 的智能片段：${created.clips.map((clip) => clip.smart?.kind).join(',')}`)
  if (!drumClips[0].notes.length) throw new Error('别名生成的鼓片段没有音符')
  return `add_drum_groove→generate_smart_clip · tracks=3 · 鼓片段 notes=${drumClips[0].notes.length}`
}

/** 场景 23（G）：set_instrument 传不精确情绪 "swing" → 兜底到 brush，并在 message 里说明「不精确」 */
async function scenarioEmotionFallback(signal) {
  setMock(({ round }) =>
    round === 0
      ? {
          toolCalls: [
            { id: 'call_emotion', name: 'set_instrument', args: { trackId: 't_drums', instrumentId: 'drums.jazz', emotionId: 'swing' } },
          ],
        }
      : { text: '已换成爵士鼓并选用刷奏音色。' },
  )
  const project = scenarioProject((draft) => {
    const drums = draft.tracks[1]
    drums.instrumentId = 'drums.jazz'
    drums.emotionId = 'brush'
    drums.kind = 'drum'
    drums.gmProgram = 0
  })
  const events = await chat(
    {
      messages: [{ role: 'user', content: '鼓组换成爵士鼓，情绪用 swing' }],
      project,
      intent: 'optimize',
    },
    signal,
  )
  assertNoError(events)
  const ends = assertAllToolEndsOk(events, 1)
  const resultText = String(ends[0].result ?? '')
  if (!/不精确/.test(resultText) || !/brush/.test(resultText)) {
    throw new Error(`情绪兜底说明缺失（应含「不精确」和 brush）：${JSON.stringify(resultText.slice(0, 240))}`)
  }
  const track = findTrack(lastProject(events), 't_drums')
  if (track.instrumentId !== 'drums.jazz') throw new Error(`乐器期望 drums.jazz，实际 ${track.instrumentId}`)
  if (track.emotionId !== 'brush') throw new Error(`情绪兜底期望 brush，实际 ${track.emotionId}`)
  return `emotion "swing" → brush（不精确提示已回显）· instrument=${track.instrumentId}`
}

/** 场景 24（H）：ui_action 是只读的，play/seek 通过 SSE `ui` 事件下发且不产生工程快照 */
async function scenarioUiActionEvents(signal) {
  setMock(({ round }) =>
    round === 0
      ? {
          toolCalls: [
            { id: 'call_play', name: 'ui_action', args: { action: 'play' } },
            { id: 'call_seek', name: 'ui_action', args: { action: 'seek', beat: 8 } },
          ],
        }
      : { text: '已开始播放，并跳到第 8 拍。' },
  )
  const events = await chat(
    {
      messages: [{ role: 'user', content: '播放一下，然后跳到第 8 拍' }],
      project: fixtureProject(),
      intent: 'optimize',
    },
    signal,
  )
  assertNoError(events)
  assertDone(events)
  assertAllToolEndsOk(events, 2)
  const uiEvents = eventsOf(events, 'ui')
  if (uiEvents.length !== 2) throw new Error(`期望 2 个 ui 事件（play/seek），实际 ${uiEvents.length}`)
  const actions = uiEvents.map((event) => event.action)
  if (!actions.includes('play') || !actions.includes('seek')) {
    throw new Error(`ui 事件 action 期望包含 play/seek，实际 ${actions.join(',')}`)
  }
  const seek = uiEvents.find((event) => event.action === 'seek')
  assertClose(seek.beat, 8, 'ui seek.beat')
  const projectEvents = eventsOf(events, 'project')
  if (projectEvents.length) {
    throw new Error(`ui_action 是只读工具，不应回传工程快照，实际回传了 ${projectEvents.length} 次`)
  }
  return `ui 事件 ${uiEvents.map((event) => `${event.action}${event.beat === undefined ? '' : `@${event.beat}`}`).join(' + ')} · project 快照 0 次`
}

/** 场景 25（I）：generate_audio 的 quality 是布尔开关（精修模式），不能被当成「和弦性质」枚举拒绝 */
async function scenarioAudioQualityBoolean(signal) {
  setMock(({ round }) =>
    round === 0
      ? {
          toolCalls: [
            {
              id: 'call_audio_quality',
              name: 'generate_audio',
              args: {
                mode: 'audio_with_stems',
                caption: 'energetic japanese rock, guitar bass drums, 172 bpm',
                quality: true,
                reason: '用户要成品 + 分轨，并选择精修模式',
              },
            },
          ],
        }
      : { text: '已安排整曲 + 分轨生成，使用精修模式。' },
  )
  const events = await chat(
    {
      messages: [{ role: 'user', content: '生成一首 J-Rock 成品，按乐器分轨，用精修模式' }],
      project: fixtureProject(),
      intent: 'audio',
    },
    signal,
  )
  assertNoError(events)
  assertDone(events)
  const ends = assertAllToolEndsOk(events, 1)
  const plan = ends[0]?.data?.audioPlan
  if (!plan) throw new Error('tool_end 没有返回 audioPlan')
  if (plan.quality !== true) throw new Error(`audioPlan.quality 期望 true，实际 ${JSON.stringify(plan.quality)}`)
  if (plan.mode !== 'audio_with_stems') throw new Error(`audioPlan.mode 期望 audio_with_stems，实际 ${plan.mode}`)
  const stems = (plan.stems ?? []).join('/')
  if (stems !== 'guitar/bass/drums') throw new Error(`默认分轨期望 guitar/bass/drums，实际 ${stems}`)
  return `quality=true · mode=audio_with_stems · stems=${stems}`
}

/* ------------------------------------------------------------------ */
/* 7.5 分轨（generate_stem / extract）纯函数断言 —— 缺陷 #2 回归        */
/* ------------------------------------------------------------------ */

/**
 * 缺陷 #2「分轨不是同一首歌的乐器」的纯函数回归：
 * 1) 请求必须是 `task_type=extract` + `track=<引擎轨道名>`，不能再发 `{lego: arm}`
 *    （未知键会让引擎回落 text2music，等于按 caption 重生成一首 30s 新歌）；
 * 2) 产品 arm 名（含 `keys`）必须映射成引擎白名单里的轨道名；
 * 3) seed 必须稳定（extract 可复现），caption 必须以隔离描述开头。
 */
function scenarioStemExtractRequest(signal) {
  void signal
  // 1) arm → 引擎轨道名：7 个全部合法，keys → keyboard
  for (const arm of STEM_ARMS) {
    const track = engineTrackForArm(arm)
    if (!track) throw new Error(`arm ${arm} 没有引擎轨道映射`)
    if (!ENGINE_TRACKS.includes(track)) throw new Error(`arm ${arm} → ${track} 不在引擎白名单内`)
  }
  if (engineTrackForArm('keys') !== 'keyboard') {
    throw new Error(`keys 必须映射成 keyboard，实际 ${engineTrackForArm('keys')}`)
  }

  // 2) 请求形状：extract + track，且没有 lego 键
  const validated = validateStemParams({ sourceAssetId: 'asset_src', arm: 'keys' })
  const request = buildExtractRequest(validated)
  if (request.task_type !== 'extract') throw new Error(`task_type 期望 extract，实际 ${request.task_type}`)
  if (request.track !== 'keyboard') throw new Error(`track 期望 keyboard，实际 ${request.track}`)
  if ('lego' in request) throw new Error('请求里不能出现 lego 键（引擎会回落 text2music）')
  if (request.inference_steps !== 50 || request.guidance_scale !== 1 || request.shift !== 1) {
    throw new Error(`采样预设不对：${JSON.stringify(request)}`)
  }
  if (request.lyrics !== '[Instrumental]') throw new Error(`lyrics 期望 [Instrumental]，实际 ${request.lyrics}`)

  // 3) seed 稳定：同输入两次一致，且等于固定默认值
  const seedA = validateStemParams({ sourceAssetId: 'asset_src', arm: 'guitar' }).seed
  const seedB = validateStemParams({ sourceAssetId: 'asset_src', arm: 'guitar' }).seed
  if (seedA !== seedB) throw new Error(`seed 应稳定，实际 ${seedA} / ${seedB}`)
  if (seedA !== STEM_SEED) throw new Error(`缺省 seed 期望固定 ${STEM_SEED}，实际 ${seedA}`)

  // 4) caption 必须以「隔离该乐器」开头（整曲描述会让模型重新生成一首歌）
  const withHint = validateStemParams({ sourceAssetId: 'a', arm: 'guitar', caption: 'japanese rock 178 bpm' })
  if (!/^Isolated .*guitar/i.test(withHint.caption)) {
    throw new Error(`caption 应以隔离描述开头，实际 ${withHint.caption}`)
  }
  // 旧名兼容壳必须走同一实现，避免历史调用点继续发 lego
  if (buildLegoRequest(validated).task_type !== 'extract') {
    throw new Error('buildLegoRequest 兼容壳没有走 extract 实现')
  }

  /* 5) 隔离描述不能带「主动要求窄带/闷音色」的措辞。
     实测证据（.verify-audio/band_corr.py）：用户工程 5 条乐器分轨叠加后
     中频缺 14.1pp、中高频缺 16.6pp（正是用户说的「糊」）。旧描述里
     `round low end`（低音沉）与 `palm-muted power chords`（闷音）方向相反，已移除；
     这里锁住它们不再回来。 */
  const forbidden = [/palm-muted/i, /round low end/i, /\bmuffled\b/i, /\bdark\b/i, /bass[- ]heavy/i]
  for (const arm of STEM_ARMS) {
    const caption = defaultStemCaption(arm)
    if (!caption) throw new Error(`arm ${arm} 没有默认隔离描述`)
    for (const pattern of forbidden) {
      if (pattern.test(caption)) throw new Error(`arm ${arm} 的描述里仍有窄带措辞 ${pattern}：${caption}`)
    }
  }
  // 乐器分轨应显式要求干声 + 全频段（引导模型给出未混音的完整频谱）
  for (const arm of STEM_ARMS.filter((item) => item !== 'vocals')) {
    const caption = defaultStemCaption(arm)
    if (!/\bdry\b/i.test(caption)) throw new Error(`arm ${arm} 的描述缺 dry（干声）：${caption}`)
    if (!/full frequency range/i.test(caption)) throw new Error(`arm ${arm} 的描述缺 full frequency range：${caption}`)
  }
  return `extract + track=${request.track} · seed=${seedA} · 7 arm 全合法 · 描述无窄带措辞`
}

/* ------------------------------------------------------------------ */
/* 7.6b 所有 /synth 请求都必须显式带 task_type —— schema 漂移回归        */
/* ------------------------------------------------------------------ */

/**
 * 引擎的 AceRequest schema 用 `task_type` 选择任务，缺省值是 `text2music`。
 * 只要某个请求构造器漏发 `task_type`，该任务专属字段（掩码/覆盖率/轨道名）
 * 就会被**静默忽略**，退化成"整段重新生成"——而且不报错，极难发现。
 *
 * 已实测踩过的三个坑（每个都是漏发 task_type）：
 *   - generate_stem 曾发 `{lego: arm}` → 回落 text2music，分轨变成另一首歌
 *   - repaint 曾无 task_type → 掩码失效（区域外相关 +1.0000 → +0.0059），
 *     且 240s 源被裁成 30s
 *   - cover 曾无 task_type → audio_cover_strength 失效（包络相关 +0.3363 → +0.0274），
 *     240s 源同样被裁成 30s
 *
 * 这个场景把「每个请求构造器都必须声明 task_type，且值必须与引擎白名单一致」钉住。
 */
function scenarioSynthRequestTaskTypes(signal) {
  void signal
  /** 引擎 constants.py:TASK_TYPES 里的合法值 */
  const ENGINE_TASK_TYPES = ['text2music', 'repaint', 'cover', 'cover-nofsq', 'extract', 'lego', 'complete']

  const cases = [
    ['repaint', buildRepaintRequest({ caption: 'jazz trio', startSec: 30, endSec: 45, seed: 7 })],
    ['cover', buildCoverRequest({ caption: 'metal version', seed: 7, strength: 0.8 })],
    ['extract(stem)', buildExtractRequest(validateStemParams({ sourceAssetId: 'asset', arm: 'guitar' }))],
  ]

  for (const [label, request] of cases) {
    if (!request.task_type) {
      throw new Error(`${label} 请求缺 task_type → 引擎会回落 text2music，任务专属字段将静默失效`)
    }
    if (!ENGINE_TASK_TYPES.includes(request.task_type)) {
      throw new Error(`${label} 的 task_type=${request.task_type} 不在引擎白名单内`)
    }
    // generate_audio 是 text2music，显式不写 task_type 是允许的（引擎缺省值即它）
  }

  // repaint 必须同时带掩码区间，否则 task_type 对了也没用
  const repaint = cases.find(([label]) => label === 'repaint')[1]
  if (repaint.repainting_start !== 30 || repaint.repainting_end !== 45) {
    throw new Error(`repaint 缺掩码区间：${JSON.stringify(repaint)}`)
  }
  if (repaint.task_type !== 'repaint') throw new Error(`repaint 的 task_type 应为 repaint，实际 ${repaint.task_type}`)

  // cover 必须带覆盖率，否则注意不到它被忽略
  const cover = cases.find(([label]) => label === 'cover')[1]
  if (cover.audio_cover_strength !== 0.8) throw new Error(`cover 缺 audio_cover_strength：${JSON.stringify(cover)}`)
  if (cover.task_type !== 'cover') throw new Error(`cover 的 task_type 应为 cover，实际 ${cover.task_type}`)

  // applyModelSelection 不得冲掉任务类型（现代运行时会改写采样字段与模型名）
  for (const [label, request] of cases) {
    const merged = applyModelSelection(request, { variant: 'sft' })
    if (merged.task_type !== request.task_type) {
      throw new Error(`${label} 经 applyModelSelection 后 task_type 被改写：${request.task_type} → ${merged.task_type}`)
    }
  }

  return `repaint/cover/extract 均带合法 task_type · applyModelSelection 不改写`
}

/* ------------------------------------------------------------------ */
/* 7.6 生成参数（shift / keyscale）纯函数断言 —— 缺陷 #1 回归           */
/* ------------------------------------------------------------------ */

/**
 * 缺陷 #1「非常难听、几乎听不出是音乐」的两条根因，跑在**真实导出的函数**上：
 *
 * A) turbo DiT 被喂了 shift=1.0。引擎 `/props` 的 `presets.turbo` 是
 *    `{ inference_steps: 8, guidance_scale: 1.0, shift: 3.0 }`；喂 1.0 会过曝发刺
 *    （实测峰值 0.996 vs 0.958、频谱质心 1793Hz vs 1477Hz）。
 *    这里锁住 `buildSynthPayload` / `applyModelSelection` / `presetForVariant` 都不再出现 1.0。
 *
 * B) 调性从未下传：`buildSynthPayload` 兜底 'C major'，而工程其实是 C minor。
 *    这里锁住 keyscale 一旦传入就原样透传，且**只有真的没传**时才回落 'C major'。
 *
 * 端到端那一半（parseAudioPlan / generate_audio 工具 / 工程兜底）在
 * `scripts/test-audio-params.mjs`（那是 TS 源码，本文件只测 companion.mjs）。
 */
function scenarioGenerationParams(signal) {
  void signal

  // A1) turbo 预设：与引擎 /props 的 presets.turbo 完全一致
  const turbo = presetForVariant('turbo')
  if (turbo.inference_steps !== TURBO_STEPS || TURBO_STEPS !== 8) {
    throw new Error(`turbo 步数期望 8，实际 ${turbo.inference_steps}/${TURBO_STEPS}`)
  }
  if (turbo.guidance_scale !== TURBO_GUIDANCE || TURBO_GUIDANCE !== 1) {
    throw new Error(`turbo guidance 期望 1.0，实际 ${turbo.guidance_scale}`)
  }
  if (turbo.shift !== TURBO_SHIFT || TURBO_SHIFT !== 3) {
    throw new Error(`turbo shift 期望 3.0（引擎 presets.turbo），实际 ${turbo.shift}/${TURBO_SHIFT}`)
  }
  if (presetForVariant('xl_turbo').shift !== 3) throw new Error('xl_turbo 的 shift 必须保持 3.0（原有行为）')
  for (const variant of ['sft', 'base', 'xl_sft', 'xl_base']) {
    const preset = presetForVariant(variant)
    if (preset.shift !== QUALITY_SHIFT || preset.inference_steps !== QUALITY_STEPS) {
      throw new Error(`${variant} 应走 sft 预设（复用 QUALITY_* 常量），实际 ${JSON.stringify(preset)}`)
    }
  }

  // A2) buildSynthPayload 实际产出的请求体
  const payload = buildSynthPayload({ caption: 'energetic japanese rock, guitar bass drums', bpm: 178, keyscale: 'C minor' })
  if (payload.shift !== 3) throw new Error(`buildSynthPayload.shift 期望 3.0，实际 ${payload.shift}`)
  if (payload.inference_steps !== 8) throw new Error(`buildSynthPayload.inference_steps 期望 8，实际 ${payload.inference_steps}`)
  if (payload.guidance_scale !== 1) throw new Error(`buildSynthPayload.guidance_scale 期望 1.0，实际 ${payload.guidance_scale}`)
  if (payload.keyscale !== 'C minor') throw new Error(`keyscale 期望透传 "C minor"，实际 ${payload.keyscale}`)
  if (payload.bpm !== 178) throw new Error(`bpm 期望 178，实际 ${payload.bpm}`)
  // 调性只在「真的没传」时才回落
  const noKey = buildSynthPayload({ caption: 'lofi beat' })
  if (noKey.keyscale !== 'C major') throw new Error(`未给调性时应回落 "C major"，实际 ${noKey.keyscale}`)
  for (const garbage of ['', '   ', 'loud and fast', 'C']) {
    if (buildSynthPayload({ caption: 'x', keyscale: garbage }).keyscale !== 'C major') {
      throw new Error(`非法调性 ${JSON.stringify(garbage)} 应回落到 "C major"`)
    }
  }
  // 质量档仍是 sft 预设
  const quality = buildQualitySynthRequest({ caption: 'x' }, { durationSec: 20 })
  if (quality.shift !== QUALITY_SHIFT || quality.inference_steps !== QUALITY_STEPS) {
    throw new Error(`质量档预设不对：${JSON.stringify(quality)}`)
  }
  // 调性归一化
  if (normalizeKeyscale('c#minor') !== 'C# minor') throw new Error('normalizeKeyscale 未把 c#minor 规整成 C# minor')
  if (normalizeKeyscale('loud and fast') !== undefined) throw new Error('normalizeKeyscale 应拒绝乱码调性')
  if (normalizeTimesignature('3/4') !== '3') throw new Error('normalizeTimesignature 未把 3/4 取成 "3"')

  return `turbo shift=${payload.shift} · keyscale=${payload.keyscale} · 非法调性回落 C major`
}

/**
 * 现代运行时的 applyModelSelection：RUNTIME_API 在 import 时读取，因此用一个
 * 查询串强制新实例（与 scripts/test-audio-params.mjs 同一手法）。
 */
async function scenarioApplyModelSelectionModern(signal) {
  void signal
  const previous = process.env.AIAB_ACESTEP_API
  process.env.AIAB_ACESTEP_API = 'modern'
  let modern
  try {
    modern = await import(`./companion.mjs?runtime=modern&t=${Date.now()}`)
  } finally {
    if (previous === undefined) delete process.env.AIAB_ACESTEP_API
    else process.env.AIAB_ACESTEP_API = previous
  }
  if (modern.RUNTIME_API !== 'modern') throw new Error(`未切到现代运行时：${modern.RUNTIME_API}`)
  const base = modern.buildSynthPayload({ caption: 'j-rock', keyscale: 'C minor' })
  for (const variant of ['turbo', 'xl_turbo']) {
    const applied = modern.applyModelSelection(base, { variant })
    if (applied.shift !== 3) throw new Error(`${variant} 经 applyModelSelection 后 shift 应为 3.0，实际 ${applied.shift}`)
    if (applied.shift === 1) throw new Error(`${variant} 的 shift 仍为 1.0（缺陷 #1 未修）`)
    if (applied.inference_steps !== 8) throw new Error(`${variant} 步数应为 8，实际 ${applied.inference_steps}`)
    if (!applied.synth_model) throw new Error(`${variant} 缺少 synth_model`)
  }
  for (const variant of ['sft', 'xl_sft']) {
    const applied = modern.applyModelSelection(base, { variant })
    if (applied.shift !== QUALITY_SHIFT || applied.inference_steps !== QUALITY_STEPS) {
      throw new Error(`${variant} 应走 sft 预设（50 步 / shift 1.0），实际 ${JSON.stringify(applied)}`)
    }
  }
  // /lm 请求体不能被塞采样字段
  const lmApplied = modern.applyModelSelection(modern.buildQualityLmRequest({ caption: 'j-rock' }), { variant: 'sft', lmTier: '1.7B' })
  if ('inference_steps' in lmApplied || 'shift' in lmApplied) {
    throw new Error(`/lm 请求被写入采样字段：${JSON.stringify(lmApplied)}`)
  }
  return 'turbo/xl_turbo → shift 3.0 · sft → 1.0 · /lm 不塞采样字段'
}

/* ------------------------------------------------------------------ */
/* 7.7 人声意图 + DC 防御 + 分轨护栏 —— 「人声轨全是噪音」回归          */
/* ------------------------------------------------------------------ */

/**
 * 「人声部分里面根本没有人声，全都是噪音」的三层修复，全部跑在真实导出函数上：
 *
 * A) 人声意图必须显式：旧实现无条件 `lyrics:'[Instrumental]'`（DiT 的「不要人声」条件），
 *    与「caption 要日语男声」自相矛盾 → 成品没人声。现在 instrumental=false 时 `lyrics:''`
 *    （引擎语义 = 让 LM 写歌词），instrumental 缺省=true 时与旧行为逐字节一致。
 *
 * B) 分轨护栏：从纯乐器源里 extract vocals 只能拆出噪声（实测 DC +0.6367 / 99.69% 能量），
 *    护栏要把这一臂明确拒绝/跳过，而不是静默产出噪声。
 *
 * C) DC 安全网：病态直流偏置就地校正；正常音频必须**逐字节不变**（返回同一引用）。
 */
function scenarioVocalIntent(signal) {
  void signal

  // A1) 缺省 = 纯乐器：与旧行为逐字节一致
  const instrumental = buildSynthPayload({ caption: 'lofi beat', bpm: 90 })
  if (instrumental.lyrics !== '[Instrumental]') {
    throw new Error(`instrumental 缺省 lyrics 必须是 [Instrumental]（旧行为），实际 ${JSON.stringify(instrumental.lyrics)}`)
  }
  if (instrumental.vocal_language !== 'unknown') {
    throw new Error(`instrumental 缺省 vocal_language 必须是 unknown，实际 ${JSON.stringify(instrumental.vocal_language)}`)
  }

  // A2) 要人声：lyrics 必须是空串（引擎语义 = LM 生成歌词），语言按 caption 判
  const vocal = buildSynthPayload({ caption: 'emotional powerful male Japanese rock vocals, j-rock', bpm: 165, instrumental: false })
  if (vocal.lyrics !== '') throw new Error(`要人声时 lyrics 必须是空串（LM 写歌词），实际 ${JSON.stringify(vocal.lyrics)}`)
  if (vocal.vocal_language !== 'ja') throw new Error(`日语线索应得到 vocal_language=ja，实际 ${vocal.vocal_language}`)
  // 非日语诉求不能硬塞成日语
  const englishVocal = buildSynthPayload({ caption: 'emotional male pop vocals', instrumental: false })
  if (englishVocal.vocal_language !== 'en') {
    throw new Error(`非日语人声应得到 en（不硬塞 ja），实际 ${englishVocal.vocal_language}`)
  }
  // 显式 vocalLanguage 优先
  const explicit = buildSynthPayload({ caption: 'x', instrumental: false, vocalLanguage: 'zh' })
  if (explicit.vocal_language !== 'zh') throw new Error(`显式 vocalLanguage 应优先，实际 ${explicit.vocal_language}`)

  // A3) wantsVocals 三元语义：只有显式 false 才算要人声
  if (wantsVocals({}) !== false) throw new Error('缺省应视为纯乐器')
  if (wantsVocals({ instrumental: true }) !== false) throw new Error('instrumental=true 应视为纯乐器')
  if (wantsVocals({ instrumental: false }) !== true) throw new Error('instrumental=false 应视为要人声')
  if (resolveVocalLanguage({ instrumental: true }) !== 'unknown') throw new Error('纯乐器语言必须是 unknown')

  // A4) 质量路径一致：/lm 不能被告知「这是纯乐器」
  const lmInstr = buildQualityLmRequest({ caption: 'j-rock' })
  if (lmInstr.lyrics !== '[Instrumental]') throw new Error(`质量档纯乐器 /lm lyrics 应为 [Instrumental]，实际 ${lmInstr.lyrics}`)
  if ('vocal_language' in lmInstr) throw new Error('质量档纯乐器 /lm 不应带 vocal_language（保持旧请求体形状）')
  const lmVocal = buildQualityLmRequest({ caption: 'japanese rock vocals', instrumental: false })
  if (lmVocal.lyrics !== '') throw new Error(`质量档要人声 /lm lyrics 应为空串（LM 写歌词），实际 ${JSON.stringify(lmVocal.lyrics)}`)
  if (lmVocal.vocal_language !== 'ja') throw new Error(`质量档要人声 /lm 应带 ja，实际 ${lmVocal.vocal_language}`)
  // LM 回显 [Instrumental] 不能把人声意图洗掉
  const synthAfterLm = buildQualitySynthRequest(
    { caption: 'x', lyrics: '[Instrumental]', vocal_language: 'unknown' },
    { caption: 'japanese rock vocals', instrumental: false },
  )
  if (synthAfterLm.lyrics !== '') {
    throw new Error(`LM 回显 [Instrumental] 时仍应保持人声条件（空串），实际 ${JSON.stringify(synthAfterLm.lyrics)}`)
  }
  if (synthAfterLm.vocal_language !== 'ja') throw new Error(`LM 的 unknown 不能盖掉显式 ja，实际 ${synthAfterLm.vocal_language}`)
  // 纯乐器的质量合成必须把 LM 可能写出的歌词强制回 [Instrumental]
  const instrAfterLm = buildQualitySynthRequest({ caption: 'x', lyrics: 'some lyrics', vocal_language: 'ja' }, { caption: 'j-rock' })
  if (instrAfterLm.lyrics !== '[Instrumental]' || instrAfterLm.vocal_language !== 'unknown') {
    throw new Error(`纯乐器质量合成必须回 [Instrumental]+unknown，实际 ${JSON.stringify(instrAfterLm)}`)
  }

  // B) 分轨护栏：纯乐器源的人声臂必须被拒
  const blocked = resolveStemArmDecision({ arm: 'vocals' }, { sourceInstrumental: true })
  if (blocked.ok !== false || blocked.code !== 'vocals-from-instrumental') {
    throw new Error(`纯乐器源抽 vocals 必须被拒，实际 ${JSON.stringify(blocked)}`)
  }
  if (!/人声/.test(blocked.message) || !/跳过|噪声/.test(blocked.message)) {
    throw new Error(`护栏消息应是可执行的中文说明，实际 ${blocked.message}`)
  }
  // 其它臂不受影响（任务保持 alive）
  for (const arm of ['guitar', 'bass', 'drums', 'strings', 'keys', 'synth']) {
    if (resolveStemArmDecision({ arm }, { sourceInstrumental: true }).ok !== true) {
      throw new Error(`${arm} 臂不该被护栏拦下`)
    }
  }
  // 未知来源 / 明确含人声的源：不拦（兼容旧调用方）
  if (resolveStemArmDecision({ arm: 'vocals' }, {}).ok !== true) throw new Error('来源未知时不该拦（兼容旧调用方）')
  if (resolveStemArmDecision({ arm: 'vocals' }, { sourceInstrumental: false }).ok !== true) {
    throw new Error('源明确含人声时不该拦')
  }
  // validateStemParams 要真的抛中文错误
  let threw = ''
  try {
    validateStemParams({ sourceAssetId: 'a', arm: 'vocals', sourceInstrumental: true })
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  if (!threw) throw new Error('validateStemParams 应从纯乐器源拒绝 vocals 臂')
  // 人声 caption 必须是 a cappella 干声，不能是乐器模板
  const vocalsCaption = buildStemCaptionOf('vocals')
  if (!/a cappella|vocal/i.test(vocalsCaption)) throw new Error(`vocals caption 应要求人声，实际 ${vocalsCaption}`)

  return `instrumental→[Instrumental]/unknown · vocals→''/${vocal.vocal_language} · 护栏拦截 + 6 臂放行`
}

/** 取 arm 的默认分轨 caption（走真实 buildStemCaption） */
function buildStemCaptionOf(arm) {
  return validateStemParams({ sourceAssetId: 'a', arm }).caption
}

/**
 * DC 偏置安全网：合成一条带病态 DC 的 16bit WAV → 洗掉；正常音频必须字节不变。
 */
function scenarioDcOffsetGuard(signal) {
  void signal
  // 1) 合成 DC 偏置波形：正弦 + 0.63 直流（复刻实测 +0.6367）
  const base = createMockWav({ durationSec: 0.5, amplitude: 0.3 })
  const info = readWavInfo(base)
  const dataStart = findDataStart(base)
  const biased = Buffer.from(base)
  const frames = Math.floor(info.dataSize / (info.channels * 2))
  const dc = 0.63
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < info.channels; channel += 1) {
      const pos = dataStart + frame * info.channels * 2 + channel * 2
      const value = Math.max(-32768, Math.min(32767, biased.readInt16LE(pos) + Math.round(dc * 32767)))
      biased.writeInt16LE(value, pos)
    }
  }
  const before = readMeanDcOffset(biased)
  if (!before || Math.abs(before.mean) < DC_OFFSET_THRESHOLD) {
    throw new Error(`合成样本的 DC 偏置不够大（${before ? before.mean : 'null'}），测试前置条件不成立`)
  }
  const result = sanitizeWavDcOffset(biased)
  if (!result.changed) throw new Error('病态 DC 未被校正')
  const after = readMeanDcOffset(result.buffer)
  if (!after || Math.abs(after.mean) > 0.001) throw new Error(`校正后 DC 应≈0，实际 ${after ? after.mean : 'null'}`)
  // 仍是合法的 16bit WAV，长度与头不变
  const cleanedInfo = readWavInfo(result.buffer)
  if (cleanedInfo.bitsPerSample !== 16 || cleanedInfo.audioFormat !== 1) throw new Error('校正后不再是 16bit PCM')
  if (result.buffer.length !== biased.length) throw new Error('校正后长度变了（应只改样本）')
  if (result.buffer.toString('latin1', 0, 4) !== 'RIFF') throw new Error('校正后 RIFF 头损坏')
  // 校正必须可复现
  if (!stripDcOffsetFromWav16(biased).equals(result.buffer)) throw new Error('校正结果不可复现')

  // 2) 正常音频（|mean|<0.01）：必须逐字节不变、返回同一引用
  const healthy = readMeanDcOffset(base)
  if (!healthy || Math.abs(healthy.mean) >= DC_OFFSET_HEALTHY) throw new Error('对照样本不是健康音频')
  const healthyResult = sanitizeWavDcOffset(base)
  if (healthyResult.changed) throw new Error('健康音频不该被改写（必须保持位精确）')
  if (healthyResult.buffer !== base) throw new Error('健康音频应原样返回同一引用')
  if (!stripDcOffsetFromWav16(base).equals(base)) throw new Error('健康音频 strip 后必须字节不变')

  // 3) 非 WAV / 空输入：不崩、原样返回
  for (const junk of [Buffer.from('not a wav at all'), Buffer.alloc(0), Buffer.from([0x52, 0x49, 0x46, 0x46])]) {
    const out = sanitizeWavDcOffset(junk)
    if (out.changed) throw new Error('非 WAV 输入不该被判为可校正')
    if (!stripDcOffsetFromWav16(junk).equals(junk)) throw new Error('非 WAV 输入必须原样返回')
  }

  return `DC ${before.mean.toFixed(3)} → ${after.mean.toFixed(6)} · 健康音频位精确不变 · 非 WAV 不崩`
}

/** WAV 里 data 块起点（测试用，故意独立实现以避免自证） */
function findDataStart(buffer) {
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'data') return offset + 8
    offset = offset + 8 + size + (size % 2)
  }
  throw new Error('WAV 里找不到 data 块')
}

/* ------------------------------------------------------------------ */
/* 8. main / cleanup                                                   */
/* ------------------------------------------------------------------ */

let mockServer = null
let serverState = null
let finalCleanup = false

async function shutdown() {
  if (finalCleanup) return
  finalCleanup = true
  await cancelActiveRun()
  if (serverState?.child && serverState.child.exitCode === null) serverState.child.kill('SIGTERM')
  await sleep(400)
  if (serverState?.child && serverState.child.exitCode === null) {
    try {
      serverState.child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
  if (mockServer) {
    await new Promise((resolve) => mockServer.close(() => resolve()))
  }
  if (!KEEP) {
    try {
      rmSync(DATA_DIR, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  } else {
    console.log(`${C.dim}保留临时目录：${DATA_DIR}${C.reset}`)
  }
}

function printServerLogTail() {
  const log = serverState?.log ?? ''
  if (!log.trim()) return
  console.log(`\n${C.dim}—— 服务端日志（尾部）——${C.reset}`)
  console.log(C.dim + log.split('\n').slice(-25).join('\n') + C.reset)
}

async function main() {
  console.log(`\n${C.gold}${C.bold}AI 编曲伴侣 · AI 生成回归测试${C.reset}`)
  console.log(`${C.dim}临时数据目录 ${DATA_DIR}${C.reset}\n`)

  let globalTimer = null
  try {
    const port = await pickPorts()
    BASE = `http://127.0.0.1:${port}`
    MOCK_BASE = `http://127.0.0.1:${port + 1}`
    console.log(`${C.dim}后端 ${BASE} · mock OpenAI ${MOCK_BASE}${C.reset}\n`)

    globalTimer = setTimeout(() => {
      console.error(`\n${C.red}${C.bold}✗ 整体超时（>${GLOBAL_TIMEOUT_MS / 1000}s），强制退出${C.reset}`)
      void shutdown().finally(() => process.exit(1))
    }, GLOBAL_TIMEOUT_MS)

    mockServer = await startMockProvider(port + 1)
    writeMockSettings()
    serverState = startServer(port)
    const health = await waitForHealth()
    console.log(`  ${C.green}✓${C.reset} 后端就绪 v${health.version}（node ${health.node}）\n`)

    const scenarios = [
      ['1. update_track 只改 reverbSend/delaySend 要生效', scenarioUpdateTrackSends],
      ['2. 和弦质量别名 "Am"/"F#m7"/"Bb" 解析正确', scenarioChordQualityAlias],
      ['3. write_notes 音名音高（"C4"/"E4"）不能清空片段', scenarioNoteNamePitch],
      ['4. 数字字符串参数（volume:"0.7"）归一化', scenarioNumericString],
      ['5. 非法乐器 id 不静默回退钢琴，修正后成功', scenarioInvalidInstrument],
      ['6. set_sections startBeat/lengthBeats 别名换算', scenarioSectionAlias],
      ['7. generate_smart_clip replaceClipId 保留原起点', scenarioReplaceClipKeepsStart],
      ['8. 服务商 500 瞬时错误自动重试', scenarioProviderRetry],
      ['9. 工具轮数上限 32 且无「未执行」失败卡片', scenarioMaxRounds],
      ['10. 完整 compose 流程（4 工具 + text + usage）', scenarioComposeFlow],
      ['11. finish_reason=length 截断提示不崩溃', scenarioFinishLength],
      ['12. AI 运行日志落盘 JSONL + GET /api/ai/logs?failed=1', scenarioAiRunLogs],
      ['13. 推理截断自动加倍 max_tokens 自愈（日志 escalated）', scenarioReasoningTruncationSelfHeal],
      ['14. 质量自检发现片段重叠自动修复（日志 qualityRepair）', scenarioQualitySelfRepair],
      ['15. 截断自愈耗尽后仍截断才提示（不误报）', scenarioTruncationAfterEscalationExhausted],
      ['16. 系统提示带版权误拒消解策略（允许正当用途 + 保留收窄条件）', scenarioCopyrightPolicyInPrompt],
      ['17. copy_clip 复制 2 份 + 移调（起点 8/16、音高 +2）', scenarioCopyClip],
      ['18. repeat_section 整段复制（片段 +1、偏移 16 拍）', scenarioRepeatSection],
      ['19. quantize_clip 吸附 0.25 网格 + humanize_clip 可复现抖动', scenarioQuantizeHumanize],
      ['20. set_swing/set_time_signature/set_loop/transpose_project 生效', scenarioProjectSettingsTools],
      ['21. split_clip 拆分 → merge_clips 合并回 1 个片段', scenarioSplitMerge],
      ['22. 工具名别名 add_drum_groove → generate_smart_clip', scenarioToolAlias],
      ['23. 情绪兜底 emotionId:"swing" → brush（提示不精确）', scenarioEmotionFallback],
      ['24. ui_action play/seek 下发 SSE ui 事件且工程不变', scenarioUiActionEvents],
      ['25. generate_audio quality 布尔开关不被当成和弦枚举拒绝', scenarioAudioQualityBoolean],
      ['26. generate_stem 走 extract + track 映射 + 固定 seed（缺陷 #2）', scenarioStemExtractRequest],
      ['27. 生成参数：turbo shift=3.0 + keyscale 透传（缺陷 #1）', scenarioGenerationParams],
      ['28. applyModelSelection 现代运行时：turbo shift 保持 3.0（缺陷 #1）', scenarioApplyModelSelectionModern],
      ['29. 人声意图端到端：instrumental 缺省不变 · 要人声 lyrics="" · 质量路径一致 · 分轨护栏（缺陷 #3）', scenarioVocalIntent],
      ['30. DC 偏置安全网：病态 DC 校正 · 健康音频位精确不变 · 非 WAV 不崩（缺陷 #3）', scenarioDcOffsetGuard],
      ['31. /synth 请求必须显式带 task_type（repaint 掩码 / cover 覆盖率不再静默失效）', scenarioSynthRequestTaskTypes],
    ]

    for (const [name, fn] of scenarios) {
      await runScenario(name, fn)
    }
  } catch (error) {
    bad('测试流程中断', error)
    printServerLogTail()
  } finally {
    if (globalTimer) clearTimeout(globalTimer)
    await shutdown()
  }

  const total = passed + failed
  console.log('')
  if (failed === 0) {
    console.log(`${C.green}${C.bold}✓ AI 生成回归测试全部通过${C.reset}  ${passed}/${total}\n`)
    process.exit(0)
  }
  console.log(`${C.red}${C.bold}✗ ${failed} 项失败${C.reset}  ${passed}/${total} 通过\n`)
  for (const item of failures) console.log(`  ${C.red}•${C.reset} ${item.name}: ${C.dim}${item.message}${C.reset}`)
  console.log('')
  process.exit(1)
}

main()
