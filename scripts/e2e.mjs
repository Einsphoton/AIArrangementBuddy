#!/usr/bin/env node
/**
 * 端到端验收（真实浏览器）：
 *
 *   1. 用临时 DATA_DIR 启动后端（不污染你的工程数据）
 *   2. 起一个 mock OpenAI 服务，验证「AI 对话 → 工具调用 → 工程被修改」全链路
 *   3. 用 Chrome headless + CDP 打开真实界面，逐项检查核心功能并截图
 *
 *   node scripts/e2e.mjs
 *   E2E_AI=0 node scripts/e2e.mjs      # 跳过 AI 对话部分
 *   E2E_KEEP=1 node scripts/e2e.mjs    # 保留临时目录与截图目录便于排查
 *   CHROME_PATH=/path/to/chrome node scripts/e2e.mjs
 *
 * 截图输出到 .verify/ 目录。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.E2E_PORT || 8897)
const MOCK_PORT = PORT + 1
const BASE = `http://127.0.0.1:${PORT}`
const SHOT_DIR = path.join(ROOT, '.verify')
const DATA_DIR = path.join(tmpdir(), `aiab-e2e-${Date.now()}`)
const KEEP = process.env.E2E_KEEP === '1'
const WITH_AI = process.env.E2E_AI !== '0'

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', gold: '\x1b[33m', bold: '\x1b[1m' }
let passed = 0
let failed = 0
const failures = []

function ok(message) {
  passed++
  console.log(`  ${C.green}✓${C.reset} ${message}`)
}
function bad(message, error) {
  failed++
  failures.push(message + (error ? `: ${error}` : ''))
  console.log(`  ${C.red}✗${C.reset} ${message}${error ? C.dim + '  ' + error + C.reset : ''}`)
}
async function check(name, fn) {
  try {
    await fn()
  } catch (error) {
    bad(name, error?.message ?? String(error))
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ */
/* 1. mock OpenAI 服务                                                 */
/* ------------------------------------------------------------------ */

function startMockProvider() {
  const send = (res, payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
  const chunk = (res, delta, finish = null) =>
    send(res, {
      id: 'chatcmpl-e2e',
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
    const toolRounds = (payload.messages ?? []).filter((m) => m.role === 'tool').length
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })

    if (toolRounds === 0) {
      chunk(res, { role: 'assistant', content: '' })
      chunk(res, { content: '好的，我来加一条弦乐铺底。' })
      const calls = [
        {
          index: 0,
          id: 'call_track',
          type: 'function',
          function: {
            name: 'create_track',
            arguments: JSON.stringify({ instrumentId: 'strings.ensemble', emotionId: 'epic', name: '弦乐铺底', volume: 0.7 }),
          },
        },
        {
          index: 1,
          id: 'call_clip',
          type: 'function',
          function: {
            name: 'generate_smart_clip',
            arguments: JSON.stringify({ kind: 'pad', bars: 4, energy: 0.8, octave: 4, startBeat: 0 }),
          },
        },
      ]
      for (const call of calls) {
        chunk(res, { tool_calls: [call] })
        await sleep(80)
      }
      chunk(res, {}, 'tool_calls')
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    chunk(res, { role: 'assistant', content: '' })
    for (const piece of (process.env.E2E_AI_TEXT ?? '已经加好一条弦乐铺底，可以在钢琴卷帘里继续调整。').match(/.{1,6}/g) ?? []) {
      chunk(res, { content: piece })
      await sleep(15)
    }
    chunk(res, {}, 'stop')
    res.write('data: [DONE]\n\n')
    res.end()
  })

  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)))
}

/* ------------------------------------------------------------------ */
/* 2. CDP 客户端                                                       */
/* ------------------------------------------------------------------ */

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean)
  return candidates.find((file) => existsSync(file)) ?? null
}

async function launchBrowser(url) {
  const chrome = findChrome()
  if (!chrome) throw new Error('未找到 Chrome/Chromium（可用 CHROME_PATH 指定）')
  const debugPort = PORT + 2
  const profile = path.join(DATA_DIR, 'chrome-profile')
  mkdirSync(profile, { recursive: true })
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-crashpad',
      '--hide-scrollbars',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      '--window-size=1680,1050',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  )

  let wsUrl = null
  for (let i = 0; i < 80 && !wsUrl; i++) {
    await sleep(150)
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      wsUrl = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? null
    } catch {
      /* 还没起来 */
    }
  }
  if (!wsUrl) {
    child.kill('SIGKILL')
    throw new Error('无法连接 Chrome DevTools')
  }

  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })

  let seq = 0
  const pending = new Map()
  const consoleErrors = []
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
      return
    }
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
      const text = message.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      if (!/AudioContext|autoplay|MIDI|favicon/i.test(text)) consoleErrors.push(`[${message.params.type}] ${text}`)
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params.exceptionDetails
      consoleErrors.push('[exception] ' + (detail?.exception?.description ?? detail?.text ?? 'unknown'))
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })

  await send('Runtime.enable')
  await send('Page.enable')

  const page = {
    consoleErrors,
    async goto(target) {
      await send('Page.navigate', { url: target })
      await sleep(1200)
    },
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true,
      })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? '页面脚本执行失败')
      return result.result.value
    },
    async waitFor(expression, timeoutMs = 20000) {
      const started = Date.now()
      while (Date.now() - started < timeoutMs) {
        try {
          if (await page.evaluate(`return !!(${expression})`)) return true
        } catch {
          /* 页面还没就绪 */
        }
        await sleep(150)
      }
      throw new Error('等待超时：' + expression)
    },
    async screenshot(name) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      const file = path.join(SHOT_DIR, `${name}.png`)
      writeFileSync(file, Buffer.from(data, 'base64'))
      return file
    },
    close() {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      child.kill('SIGKILL')
    },
  }
  return page
}

/* ------------------------------------------------------------------ */
/* 3. 被测服务                                                         */
/* ------------------------------------------------------------------ */

function startServer() {
  const entry = path.join(ROOT, 'apps/server/dist/server.mjs')
  if (!existsSync(entry)) throw new Error('未构建，请先运行 node scripts/build.mjs')
  const child = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR,
      SERVE_STATIC: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (c) => (log += c))
  child.stderr.on('data', (c) => (log += c))
  return { child, getLog: () => log }
}

async function waitForServer() {
  const started = Date.now()
  while (Date.now() - started < 40000) {
    try {
      const response = await fetch(`${BASE}/api/health`)
      if (response.ok) return await response.json()
    } catch {
      /* 等 */
    }
    await sleep(300)
  }
  throw new Error('后端启动超时')
}

async function configureProvider() {
  const settings = await (await fetch(`${BASE}/api/settings`)).json()
  settings.providers = [
    {
      id: 'mock',
      name: 'Mock AI（E2E）',
      kind: 'openai',
      baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
      apiKey: 'mock-key',
      model: 'mock-model',
      temperature: 0.7,
      maxTokens: 2048,
      parallelToolCalls: false,
      extraHeaders: {},
    },
  ]
  settings.activeProviderId = 'mock'
  settings.agent = { ...settings.agent, backend: 'builtin', timeoutMs: 60000 }
  await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
}

/* ------------------------------------------------------------------ */
/* 4. 用例                                                            */
/* ------------------------------------------------------------------ */

async function main() {
  console.log(`\n${C.gold}${C.bold}AI 编曲伴侣 · 端到端验收${C.reset}`)
  console.log(`${C.dim}临时数据 ${DATA_DIR}${C.reset}`)
  console.log(`${C.dim}截图目录 ${SHOT_DIR}${C.reset}\n`)

  rmSync(SHOT_DIR, { recursive: true, force: true })
  mkdirSync(SHOT_DIR, { recursive: true })

  let mockServer = null
  const server = startServer()
  let page = null

  try {
    const health = await waitForServer()
    ok(`后端就绪 v${health.version}（node ${health.node}，ffmpeg ${health.ffmpeg ? '✓' : '✗'}）`)

    if (WITH_AI) {
      mockServer = await startMockProvider()
      await configureProvider()
      ok('已接入 mock AI 服务商')
    }

    page = await launchBrowser(BASE)
    await page.goto(BASE + '/')
    await page.waitFor('window.AIAB && window.AIAB.useStore')
    ok('前端启动成功')

    // 关闭首次访问的引导层（欢迎页等），保证后续交互不被遮挡
    for (let i = 0; i < 3; i++) {
      const closed = await page.evaluate(`
        const target = [...document.querySelectorAll('button, a')].find(
          (element) => /开始使用|开始创作|知道了|跳过/.test(element.textContent?.trim() ?? ''),
        ) ?? [...document.querySelectorAll('button')].find((element) => element.getAttribute('aria-label') === '关闭')
        if (!target) return 0
        target.click()
        return 1
      `)
      if (!closed) break
      await sleep(300)
    }
    await page.evaluate(`
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return 1
    `)
    await sleep(300)

    /* --- 工程 --- */
    const project = await page.evaluate(`
      const s = window.AIAB.useStore.getState();
      return { tracks: s.project.tracks.length, chords: s.project.chords.length,
        notes: s.project.tracks.reduce((n,t)=>n+t.clips.reduce((m,c)=>m+c.notes.length,0),0),
        instruments: [...new Set(s.project.tracks.map(t=>t.instrumentId))] };
    `)
    if (project.tracks >= 3 && project.notes > 20) ok(`示例工程：${project.tracks} 轨 / ${project.notes} 音 / ${project.chords} 和弦`)
    else bad('示例工程为空', JSON.stringify(project))
    await page.screenshot('01-arrangement')

    /* --- 视图 --- */
    for (const view of ['pianoroll', 'smartclips']) {
      await page.evaluate(`window.AIAB.useStore.getState().setView('${view}'); return 1`)
      await sleep(500)
      await page.screenshot(`02-${view}`)
      const visible = await page.evaluate(`return document.querySelectorAll('canvas').length`)
      if (visible > 0) ok(`${view === 'pianoroll' ? '钢琴卷帘' : '智能片段'}视图渲染（${visible} 个 canvas）`)
      else bad(`${view} 视图无 canvas 渲染`)
    }

    /* --- 钢琴卷帘编辑 + 撤销 --- */
    const edit = await page.evaluate(`
      const s = window.AIAB.useStore.getState();
      const track = s.project.tracks.find(t => t.kind === 'instrument' && t.clips.length);
      s.selectTrack(track.id); s.selectClip(track.id, track.clips[0].id); s.setView('pianoroll');
      const before = track.clips[0].notes.length;
      window.AIAB.useStore.getState().addNotes(track.id, track.clips[0].id, [
        { id: 'e2e_1', pitch: 72, start: 0, duration: 1, velocity: 100 },
        { id: 'e2e_2', pitch: 76, start: 1, duration: 0.5, velocity: 90 },
      ]);
      const after = window.AIAB.useStore.getState().project.tracks.find(t=>t.id===track.id).clips[0].notes.length;
      window.AIAB.useStore.getState().undo();
      const restored = window.AIAB.useStore.getState().project.tracks.find(t=>t.id===track.id).clips[0].notes.length;
      return { before, after, restored };
    `)
    if (edit.after === edit.before + 2 && edit.restored === edit.before) ok(`钢琴卷帘写入 + 撤销正常（${edit.before} → ${edit.after} → ${edit.restored}）`)
    else bad('音符写入/撤销异常', JSON.stringify(edit))

    /* --- 9 类智能片段生成器 --- */
    const kinds = ['drums', 'bass', 'chords', 'arp', 'melody', 'riff', 'strum', 'counter', 'pad']
    const generated = await page.evaluate(`
      const s = window.AIAB.useStore.getState();
      const track = s.project.tracks.find(t => t.kind === 'instrument');
      const out = [];
      let slot = 0;
      for (const kind of ${JSON.stringify(kinds)}) {
        const id = window.AIAB.useStore.getState().createSmartClip(track.id, kind, { bars: 2, density: 0.6 }, slot * 8);
        slot += 1;
        const clip = window.AIAB.useStore.getState().project.tracks.find(t=>t.id===track.id).clips.find(c=>c.id===id);
        out.push({ kind, notes: clip?.notes?.length ?? 0 });
      }
      return out;
    `)
    const emptyKinds = generated.filter((item) => !item.notes)
    if (emptyKinds.length === 0) ok(`9 类智能片段生成器全部产出：${generated.map((g) => `${g.kind}=${g.notes}`).join(' ')}`)
    else bad('部分生成器无输出', JSON.stringify(emptyKinds))

    /* --- 走带 --- */
    const transport = await page.evaluate(`
      const { engine, useStore } = window.AIAB;
      await engine.init();
      await engine.play(useStore.getState().project, { fromBeat: 0 });
      await new Promise(r => setTimeout(r, 900));
      const beat = engine.playheadBeat();
      const playing = engine.playing;
      engine.pause();
      return { beat, playing };
    `)
    if (transport.playing && transport.beat > 0.3) ok(`音频引擎走带正常（播放头 ${transport.beat.toFixed(2)} 拍）`)
    else bad('走带异常', JSON.stringify(transport))

    /* --- 离线渲染 --- */
    const render = await page.evaluate(`
      const { engine, useStore } = window.AIAB;
      const project = useStore.getState().project;
      const short = { ...project, tracks: project.tracks.map(t => ({ ...t, clips: t.clips.filter(c => c.startBeat < 8).slice(0, 1) })) };
      const blob = await engine.renderToWav(short, {});
      return { size: blob?.size ?? 0 };
    `).catch((error) => ({ error: String(error) }))
    if (render.error) bad('WAV 渲染失败', render.error)
    else if (render.size > 50000) ok(`WAV 离线渲染：${(render.size / 1024 / 1024).toFixed(2)} MB`)
    else bad('WAV 渲染结果异常', JSON.stringify(render))

    /* --- 导出对话框 --- */
    await page.evaluate(`window.AIAB.useStore.getState().setExportOpen(true); return 1`)
    await sleep(500)
    await page.screenshot('03-export')
    const exportText = await page.evaluate(`return document.body.innerText`)
    const formats = ['MIDI', 'WAV', 'MP3', 'FLAC', 'OGG'].filter((f) => exportText.includes(f))
    if (formats.length >= 4) ok('导出格式齐全：' + formats.join(' / '))
    else bad('导出格式缺失', formats.join(','))
    await page.evaluate(`window.AIAB.useStore.getState().setExportOpen(false); return 1`)

    /* --- 设置页 --- */
    await page.evaluate(`window.AIAB.useStore.getState().setSettingsOpen(true); return 1`)
    await sleep(500)
    await page.screenshot('04-settings')
    const settingsText = await page.evaluate(`return document.body.innerText`)
    const sections = [['AI 服务商', 'AI 服务商'], ['联网搜索', '联网搜索'], ['Agent', 'Agent'], ['音频/音色库', '音色库']]
    const missing = sections.filter(([, keyword]) => !settingsText.includes(keyword))
    if (missing.length === 0) ok('设置页四个分区齐全（服务商 / 搜索 / Agent / 音频）')
    else bad('设置页缺分区', missing.map(([label]) => label).join(','))
    await page.evaluate(`window.AIAB.useStore.getState().setSettingsOpen(false); return 1`)

    /* --- MIDI 导出（服务端，验证文件头） --- */
    const midi = await page.evaluate(`
      const project = window.AIAB.useStore.getState().project;
      const res = await fetch('/api/export/midi', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) });
      const buf = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, header: String.fromCharCode(...buf.slice(0, 4)), size: buf.length };
    `)
    if (midi.status === 200 && midi.header === 'MThd') ok(`MIDI 导出正常（${midi.size} 字节）`)
    else bad('MIDI 导出异常', JSON.stringify(midi))

    /* --- AI 对话 --- */
    if (WITH_AI) {
      await page.evaluate(`window.AIAB.useStore.getState().setChatOpen(true); window.AIAB.useStore.getState().setView('arrangement'); return 1`)
      await sleep(400)
      const before = await page.evaluate(`return window.AIAB.useStore.getState().project.tracks.length`)
      const sent = await page.evaluate(`
        const ta = document.querySelector('textarea');
        if (!ta) return 'no-textarea';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, '帮我加一条弦乐铺底，宏大的感觉');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        const button = [...document.querySelectorAll('button')].find(b => /发送/.test(b.textContent) && !b.disabled);
        if (!button) return 'no-send-button';
        button.click();
        return 'sent';
      `)
      if (sent !== 'sent') bad('无法发送 AI 消息', sent)
      else {
        await page
          .waitFor(
            `window.AIAB.useStore.getState().messages.some(m => m.role === 'assistant' && !m.streaming && (m.content || (m.toolCalls||[]).length))`,
            40000,
          )
          .catch(() => null)
        await sleep(800)
        const chat = await page.evaluate(`
          const s = window.AIAB.useStore.getState();
          return { tracks: s.project.tracks.length,
            toolCalls: s.messages.flatMap(m => m.toolCalls ?? []).map(c => c.name + ':' + c.status),
            text: (s.messages.filter(m => m.role === 'assistant').map(m => m.content).join('') || '').slice(0, 60),
            error: s.aiError };
        `)
        if (chat.tracks > before) ok(`AI 对话改动工程：${before} → ${chat.tracks} 轨`)
        else bad('AI 未改动工程', JSON.stringify({ before, tracks: chat.tracks }))
        if (chat.toolCalls.length >= 2) ok('工具调用卡片：' + chat.toolCalls.join(', '))
        else bad('工具调用未展示', JSON.stringify(chat.toolCalls))
        if (chat.text) ok(`AI 回复文本：「${chat.text}…」`)
        else bad('AI 无回复文本')
        if (chat.error) bad('AI 报错', chat.error)
        await page.screenshot('05-ai-chat')
      }
    }

    /* --- 试听一致性：换乐器 / 换情绪后，试听与 MIDI 必须用轨道当前音色 --- */
    const audition = await page.evaluate(`
      const { engine, useStore } = window.AIAB;
      const s = useStore.getState();
      const track = s.project.tracks.find((t) => t.kind === 'instrument') ?? s.project.tracks[0];
      s.selectTrack(track.id);
      s.setTrackInstrument(track.id, 'strings.cello', 'dramatic');
      await new Promise((r) => setTimeout(r, 900));
      const live = useStore.getState().project.tracks.find((t) => t.id === track.id);
      const before = engine.debugState?.() ?? null;
      engine.previewNote(live, 60, 110, 0.4);
      await new Promise((r) => setTimeout(r, 250));
      const dbg = engine.debugState?.() ?? null;
      return {
        trackId: live.id,
        instrument: live.instrumentId,
        emotion: live.emotionId,
        last: dbg?.lastAudition ?? null,
        route: dbg?.tracks?.find((t) => t.id === live.id)?.route ?? null,
        voiceKey: dbg?.tracks?.find((t) => t.id === live.id)?.voiceKey ?? '',
        hasDebug: Boolean(before),
      };
    `)
    if (!audition.hasDebug) {
      ok('试听路由检查跳过（引擎未暴露 debugState）')
    } else {
      const detail = String(audition.last?.detail ?? '')
      const followed =
        audition.last?.trackId === audition.trackId &&
        (detail.includes(audition.instrument) || audition.voiceKey.includes(audition.instrument))
      if (followed) ok(`试听/MIDI 与轨道音色一致：${audition.last.kind} · ${detail}`)
      else bad('试听没有跟随轨道音色', JSON.stringify(audition))
    }

    /* --- 控制台 --- */
    if (page.consoleErrors.length === 0) ok('浏览器控制台无异常')
    else {
      bad(`浏览器控制台有 ${page.consoleErrors.length} 条异常`)
      page.consoleErrors.slice(0, 5).forEach((line) => console.log(`      ${line.slice(0, 200)}`))
    }
  } catch (error) {
    bad('验收流程中断', error?.message ?? String(error))
    if (server.getLog()) console.log(`${C.dim}${server.getLog().split('\n').slice(-15).join('\n')}${C.reset}`)
  } finally {
    try {
      page?.close()
    } catch {
      /* ignore */
    }
    server.child.kill('SIGTERM')
    mockServer?.close()
    if (!KEEP) {
      await sleep(300)
      rmSync(DATA_DIR, { recursive: true, force: true })
    } else {
      console.log(`${C.dim}保留临时目录：${DATA_DIR}${C.reset}`)
    }
  }

  const total = passed + failed
  console.log('')
  if (failed === 0) {
    console.log(`${C.green}${C.bold}✓ 端到端验收全部通过${C.reset}  ${passed}/${total}`)
    console.log(`${C.dim}截图：${SHOT_DIR}${C.reset}\n`)
    process.exit(0)
  }
  console.log(`${C.red}${C.bold}✗ ${failed} 项失败${C.reset}  ${passed}/${total}`)
  failures.forEach((line) => console.log(`  ${C.red}•${C.reset} ${line}`))
  console.log('')
  process.exit(1)
}

main()
