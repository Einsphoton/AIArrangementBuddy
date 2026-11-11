#!/usr/bin/env node
/**
 * AI 编曲助手 → 音频工具 → 前端自动执行 的端到端验收（P9）。
 *
 *   node scripts/verify-audio-agent.mjs
 *   AUDIO_AGENT_SKIP_BUILD=1 node scripts/verify-audio-agent.mjs
 *
 * 链路：
 *   UI 输入「把当前编曲渲染成音频」→ /api/ai/chat（内置 Agent + mock 模型）
 *   → 模型调用 generate_audio(mode=midi_to_audio) → tool_end.data.audioPlan
 *   → 前端自动离线渲染工程 → 上传资产 → 新增音频轨
 *
 * 断言：
 *   - 发送的 intent=audio，系统提示包含音频意图判定
 *   - 对话里出现「生成音频」工具卡
 *   - 任务卡从 running → done，工程新增 1 条音频轨
 *   - 控制台无未预期错误
 *
 * 产物：.verify-audio/agent-*.png
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { ROOT, sleep, startStaticServer, launchChrome } from './lib/browser-harness.mjs'
import { pickFreePort } from './lib/ports.mjs'

const OUT_DIR = path.join(ROOT, '.verify-audio')
const DATA_DIR = path.join(ROOT, '.cache', 'audio-agent-data')
const SKIP_BUILD = process.env.AUDIO_AGENT_SKIP_BUILD === '1'

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', bold: '\x1b[1m' }
let passed = 0
let failed = 0
const failures = []

function ok(message, detail = '') {
  passed++
  console.log(`  ${C.green}✓${C.reset} ${message}${detail ? `${C.dim}  ${detail}${C.reset}` : ''}`)
}
function bad(message, error) {
  failed++
  failures.push(`${message}${error ? `: ${error}` : ''}`)
  console.log(`  ${C.red}✗${C.reset} ${message}${error ? `${C.dim}  ${error}${C.reset}` : ''}`)
}
async function check(name, fn) {
  try {
    const detail = await fn()
    ok(name, typeof detail === 'string' ? detail : '')
  } catch (error) {
    bad(name, error instanceof Error ? error.message : String(error))
  }
}

function prepareDataDir() {
  if (!existsSync(path.join(DATA_DIR, 'projects'))) {
    if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true })
    mkdirSync(DATA_DIR, { recursive: true })
    const source = path.join(ROOT, 'data')
    const copyDir = (from, to) => {
      if (existsSync(from)) cpSync(from, to, { recursive: true, force: true })
    }
    const settings = path.join(source, 'settings.json')
    if (existsSync(settings)) cpSync(settings, path.join(DATA_DIR, 'settings.json'))
    copyDir(path.join(source, 'projects'), path.join(DATA_DIR, 'projects'))
    copyDir(path.join(source, 'assets'), path.join(DATA_DIR, 'assets'))
    copyDir(path.join(source, 'soundfonts'), path.join(DATA_DIR, 'soundfonts'))
  }
  return DATA_DIR
}

function runBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs')], { cwd: ROOT, stdio: 'ignore' })
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('构建失败'))))
  })
}

/** 最小 OpenAI 兼容 mock：第一轮返回 generate_audio 工具调用，第二轮返回收尾文本 */
function startMockProvider(port, captured) {
  const send = (res, payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
  const chunk = (res, delta, finish = null) =>
    send(res, {
      id: 'chatcmpl-audio-e2e',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-model',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })
  const server = http.createServer(async (req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }))
      return
    }
    if (!req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end('not found')
      return
    }
    let body = ''
    for await (const part of req) body += part
    let payload = {}
    try {
      payload = JSON.parse(body)
    } catch {
      /* ignore */
    }
    captured.push(payload)
    const toolRounds = (payload.messages ?? []).filter((message) => message.role === 'tool').length
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    chunk(res, { role: 'assistant', content: '' })
    if (toolRounds === 0) {
      chunk(res, { content: '好的，我把当前工程渲染成音频。' })
      chunk(res, {
        tool_calls: [
          {
            index: 0,
            id: 'call_audio_render',
            type: 'function',
            function: {
              name: 'generate_audio',
              arguments: JSON.stringify({ mode: 'midi_to_audio', reason: '工程里已有编配，用户要成品音频' }),
            },
          },
        ],
      })
      chunk(res, {}, 'tool_calls')
    } else {
      chunk(res, { content: '已安排渲染，进度会显示在音频任务卡里。' })
      chunk(res, {}, 'stop')
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

async function configureProvider(base, mockUrl) {
  const settings = await (await fetch(`${base}/api/settings`)).json()
  settings.providers = [
    {
      id: 'audio-e2e-mock',
      name: '音频验收 Mock',
      kind: 'openai',
      baseUrl: mockUrl,
      apiKey: 'mock-key',
      model: 'mock-model',
      temperature: 0.4,
      maxTokens: 2048,
      parallelToolCalls: false,
      extraHeaders: {},
    },
  ]
  settings.activeProviderId = 'audio-e2e-mock'
  settings.agent = { ...settings.agent, backend: 'builtin', timeoutMs: 120000 }
  const response = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
  if (!response.ok) throw new Error(`设置 mock 服务商失败：${response.status}`)
}

async function main() {
  if (!SKIP_BUILD) {
    console.log(`${C.dim}构建前后端…${C.reset}`)
    await runBuild()
  }
  mkdirSync(OUT_DIR, { recursive: true })
  const dataDir = prepareDataDir()
  const mockPort = await pickFreePort(8975)
  const captured = []
  const mock = await startMockProvider(mockPort, captured)

  const server = await startStaticServer({ preferredPort: 8970, dataDir })
  await configureProvider(server.base, `http://127.0.0.1:${mockPort}/v1`)
  const page = await launchChrome({ dataDir: server.dataDir })
  try {
    await page.setViewport(1600, 1000)
    await page.goto(`${server.base}/?intro=0`)
    await page.waitFor('window.AIAB && document.querySelector("[data-track-row]")', 30000)
    await sleep(800)

    await check('通过对话发送音频请求（intent=audio）', async () => {
      await page.evaluate(`
        const area = document.querySelector('textarea[aria-label="给 AI 的指令"]')
        if (!area) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        setter.call(area, '把当前编曲渲染成音频，直接给我成品。')
        area.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 200))
        const send = [...document.querySelectorAll('button')].find((button) => (button.getAttribute('title') || '').startsWith('发送'))
        send?.click()
        return true
      `)
      await page.waitFor('document.body.textContent.includes("好的，我把当前工程渲染成音频")', 15000)
      await page.waitFor('document.body.textContent.includes("生成音频")', 10000)
      return '用户消息已发送，出现「生成音频」工具卡'
    })

    await check('系统提示包含音频意图判定，且请求 body 带 intent=audio', async () => {
      await page.waitFor('document.body.textContent.includes("已安排渲染")', 20000)
      const first = captured[0]
      if (!first) throw new Error('mock 没有收到模型请求')
      const system = (first.messages ?? []).find((message) => message.role === 'system')?.content ?? ''
      if (!/音频产出判定/.test(system)) throw new Error('系统提示缺少音频判定说明')
      if (!/本次任务意图（audio）/.test(system)) throw new Error('系统提示缺少 intent=audio 指令')
      const tools = (first.tools ?? []).map((tool) => tool.function?.name)
      if (!tools.includes('generate_audio')) throw new Error('工具列表缺少 generate_audio')
      return `工具 ${tools.length} 个，system ${system.length} 字`
    })

    await check('前端自动执行 audioPlan：任务卡完成并新增音频轨', async () => {
      await page.waitFor('document.querySelector("[data-audio-job]")', 20000)
      await page.waitFor('document.querySelector("[data-audio-job-status=\\"done\\"],[data-audio-job-status=\\"failed\\"]")', 120000)
      await page.screenshot(path.join(OUT_DIR, 'agent-01-audio-rendered.png'))
      const state = await page.evaluate(`
        const project = window.AIAB.useStore.getState().project
        const chatPanel = document.querySelector('textarea[aria-label="给 AI 的指令"]')?.closest('aside')
        return {
          status: document.querySelector('[data-audio-job]')?.getAttribute('data-audio-job-status'),
          audioTracks: project.tracks.filter((track) => track.kind === 'audio' && track.audioClips.length > 0).length,
          chatText: chatPanel?.innerText ?? '',
        }
      `)
      if (state.status !== 'done') throw new Error(`任务卡状态 ${state.status}`)
      if (state.audioTracks < 1) throw new Error('没有新增音频轨')
      if (!/已安排渲染/.test(state.chatText)) throw new Error('对话里没有助手收尾文本')
      return `任务卡 done，音频轨 ${state.audioTracks} 条`
    })

    await check('控制台无未预期错误', async () => {
      const errors = page.consoleErrors.filter(
        (text) =>
          !/AudioContext|autoplay|MIDI|favicon|Web MIDI|Max polyphony|polyphony|Note dropped|SoundFont|回退合成器|AudioWorkletNode|addModule/i.test(
            text,
          ),
      )
      if (errors.length) throw new Error(errors.slice(0, 3).join(' | '))
      return '0 条错误'
    })
  } finally {
    // 失败时输出足够的现场信息，便于定位是模型链路还是前端执行链路的问题
    if (failed > 0) {
      try {
        const snapshot = await page.evaluate(`
          const state = window.AIAB?.useStore?.getState?.() ?? {}
          return {
            aiError: state.aiError ?? null,
            messages: (state.messages ?? []).map((message) => ({ role: message.role, error: message.error, tools: (message.toolCalls ?? []).map((call) => call.name + ':' + call.status), text: (message.content ?? '').slice(0, 120) })),
            job: document.querySelector('[data-audio-job]')?.getAttribute('data-audio-job-status') ?? null,
            aside: (document.querySelector('aside')?.innerText ?? '').slice(0, 800),
          }
        `)
        console.log(`${C.dim}调试快照：${JSON.stringify({ requests: captured.length, ...snapshot }, null, 2)}${C.reset}`)
      } catch {
        /* ignore */
      }
    }
    page.close()
    server.child.kill('SIGKILL')
    mock.close()
    await sleep(200)
  }

  console.log(`\n${C.bold}AI→音频工具链路验收${C.reset}：通过 ${C.green}${passed}${C.reset}，失败 ${C.red}${failed}${C.reset}`)
  console.log(`${C.dim}截图：.verify-audio/agent-*.png${C.reset}`)
  if (failed > 0) {
    for (const failure of failures) console.log(`  ${C.red}${failure}${C.reset}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
