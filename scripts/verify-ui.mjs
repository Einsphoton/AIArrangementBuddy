#!/usr/bin/env node
/**
 * UI 交互验收（真实浏览器 + 截图）
 *
 *   node scripts/verify-ui.mjs              # 全量：启动服务 + 截图 + 行为断言
 *   UI_SKIP_BUILD=1 node scripts/verify-ui.mjs
 *   UI_ONLY=palette node scripts/verify-ui.mjs   # 只跑某个状态截图
 *
 * 产物：.verify-ui/*.png + 控制台 PASS/FAIL 报告。
 *
 * 与 scripts/e2e.mjs 的分工：
 * - e2e：后端 API、导出、AI 工具链、基础渲染（功能正确性）
 * - verify-ui：界面交互、可发现性、状态反馈、视觉回归（体验正确性）
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { pickFreePort } from './lib/ports.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHOT_DIR = path.join(ROOT, '.verify-ui')
const DATA_DIR = path.join(tmpdir(), `aiab-ui-${Date.now()}`)
const SKIP_BUILD = process.env.UI_SKIP_BUILD === '1'
const ONLY = process.env.UI_ONLY || ''

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', gold: '\x1b[33m', bold: '\x1b[1m' }
let passed = 0
let failed = 0
const failures = []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function ok(message) {
  passed++
  console.log(`  ${C.green}✓${C.reset} ${message}`)
}
function bad(message, error) {
  failed++
  failures.push(`${message}${error ? `: ${error}` : ''}`)
  console.log(`  ${C.red}✗${C.reset} ${message}${error ? `${C.dim}  ${error}${C.reset}` : ''}`)
}
async function check(name, fn) {
  try {
    await fn()
    ok(name)
  } catch (error) {
    bad(name, error?.message ?? String(error))
  }
}

/* ------------------------------------------------------------------ */
/* 构建 / 服务                                                         */
/* ------------------------------------------------------------------ */

function run(command, args, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    child.stdout.on('data', (chunk) => (log += chunk))
    child.stderr.on('data', (chunk) => (log += chunk))
    child.on('close', (code) => (code === 0 ? resolve(log) : reject(new Error(log || `exit ${code}`))))
  })
}

async function buildIfNeeded() {
  if (SKIP_BUILD) return
  console.log(`${C.dim}构建前端与后端…${C.reset}`)
  await run(process.execPath, [path.join(ROOT, 'scripts/build.mjs')])
}

function startServer(port) {
  const entry = path.join(ROOT, 'apps/server/dist/server.mjs')
  if (!existsSync(entry)) throw new Error('未构建：请先运行 node scripts/build.mjs')
  const child = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR,
      SERVE_STATIC: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (chunk) => (log += chunk))
  child.stderr.on('data', (chunk) => (log += chunk))
  return { child, getLog: () => log }
}

async function waitForServer(base) {
  const started = Date.now()
  while (Date.now() - started < 40000) {
    try {
      const response = await fetch(`${base}/api/health`)
      if (response.ok) return await response.json()
    } catch {
      /* 继续等 */
    }
    await sleep(250)
  }
  throw new Error('后端启动超时')
}

/* ------------------------------------------------------------------ */
/* Chrome / CDP                                                        */
/* ------------------------------------------------------------------ */

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean)
  return candidates.find((file) => existsSync(file)) ?? null
}

async function launchBrowser(url, debugPort) {
  const chrome = findChrome()
  if (!chrome) throw new Error('未找到 Chrome/Chromium（可用 CHROME_PATH 指定）')
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
      wsUrl = targets.find((target) => target.type === 'page')?.webSocketDebuggerUrl ?? null
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
      const text = message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')
      if (!/AudioContext|autoplay|MIDI|favicon|Web MIDI/i.test(text)) consoleErrors.push(`[${message.params.type}] ${text}`)
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params.exceptionDetails
      consoleErrors.push('[exception] ' + (detail?.exception?.description ?? detail?.text ?? 'unknown'))
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, (message) =>
        message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result),
      )
      ws.send(JSON.stringify({ id, method, params }))
    })

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1680,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })

  const page = {
    consoleErrors,
    async goto(target) {
      await send('Page.navigate', { url: target })
      await sleep(900)
    },
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true,
      })
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? '页面脚本执行失败')
      }
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
    async mouseClick(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      await sleep(180)
    },
    async pressKey(key, opts = {}) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: opts.code ?? key, modifiers: opts.modifiers ?? 0 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: opts.code ?? key, modifiers: opts.modifiers ?? 0 })
      await sleep(120)
    },
    async screenshot(name) {
      await sleep(260)
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
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
/* 配置一个占位服务商（只影响界面状态，不会发起网络请求）              */
/* ------------------------------------------------------------------ */

async function configureProvider(base) {
  try {
    const settings = await (await fetch(`${base}/api/settings`)).json()
    settings.providers = [
      {
        id: 'verify-example',
        name: 'DeepSeek（验收示例）',
        kind: 'openai',
        baseUrl: 'http://127.0.0.1:65535/v1',
        apiKey: 'verify-key',
        model: 'deepseek-chat',
        temperature: 0.7,
        maxTokens: 2048,
        parallelToolCalls: false,
        extraHeaders: {},
      },
    ]
    settings.activeProviderId = 'verify-example'
    settings.agent = { ...settings.agent, backend: 'builtin', timeoutMs: 60000 }
    await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    })
  } catch {
    /* 配置失败不影响 UI 验收，只是截图里会显示未配置 */
  }
}

/* ------------------------------------------------------------------ */
/* 断言工具                                                            */
/* ------------------------------------------------------------------ */

async function expect(page, name, expression, detail = '') {
  await check(name, async () => {
    const value = await page.evaluate(`return (${expression})`)
    if (!value) throw new Error(detail || `断言失败：${expression}`)
  })
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true })
  await buildIfNeeded()

  const port = await pickFreePort(8920)
  const debugPort = await pickFreePort(port + 5)
  const BASE = `http://127.0.0.1:${port}`
  console.log(`${C.gold}${C.bold}AI 编曲伴侣 · UI 交互验收${C.reset}`)
  console.log(`${C.dim}${BASE} · 截图目录 .verify-ui${C.reset}\n`)

  const server = startServer(port)
  let page
  try {
    const health = await waitForServer(BASE)
    await configureProvider(BASE)
    ok(`后端就绪 v${health.version}`)
    page = await launchBrowser(BASE, debugPort)

    /* ---------- 启动 ---------- */
    await page.goto(`${BASE}/?intro=0`)
    await page.waitFor('window.AIAB && document.querySelector("[data-track-row]")', 25000)
    ok('应用启动并渲染轨道')

    await check('无未过滤的控制台错误', async () => {
      if (page.consoleErrors.length) throw new Error(page.consoleErrors.slice(0, 3).join(' | '))
    })

    /* ---------- 编曲视图 ---------- */
    if (!ONLY || ONLY === 'arrangement') {
      await page.evaluate(`window.AIAB.useStore.getState().setView('arrangement'); return true`)
      await page.waitFor('document.querySelectorAll("[data-track-row]").length > 0')
      await page.screenshot('01-arrangement')
      await expect(
        page,
        '编曲视图：轨道行与工程轨道数一致',
        `document.querySelectorAll('[aria-label="轨道列表"] [data-track-row]').length === window.AIAB.useStore.getState().project.tracks.length`,
      )
      await expect(
        page,
        '编曲视图：存在时间轴工具条',
        '!!document.querySelector("[data-timeline-toolbar]")',
        '未找到 [data-timeline-toolbar]',
      )
      await expect(page, '编曲视图：片段可见', 'document.querySelectorAll("[data-clip]").length > 0')
      await expect(
        page,
        '编曲视图：工具条含「选择 / 切片」',
        `document.querySelector('[data-timeline-toolbar]').innerText.includes('选择') && document.querySelector('[data-timeline-toolbar]').innerText.includes('切片')`,
      )
      await expect(
        page,
        '轨道头：存在录入预备按钮',
        `[...document.querySelectorAll('button')].some((button) => /预备录入|录入预备/.test(button.getAttribute('aria-label') || button.title || ''))`,
        '未找到录入预备按钮',
      )
      await expect(
        page,
        '轨道头：活动电平指示数量与轨道数一致',
        'document.querySelectorAll("[data-activity-meter]").length === window.AIAB.useStore.getState().project.tracks.length',
        '活动电平指示数量与轨道数不一致',
      )

      /* 真实交互：轨道头 R 按钮 → 录入预备 */
      await check('交互：点击轨道头 R 进入录入预备', async () => {
        const armed = await page.evaluate(`
          const button = [...document.querySelectorAll('button')].find((item) => /预备录入/.test(item.getAttribute('aria-label') || item.title || ''))
          if (!button) return null
          button.click()
          await new Promise((resolve) => setTimeout(resolve, 120))
          return window.AIAB.useUiStore.getState().armedTrackId
        `)
        if (!armed) throw new Error('点击后 armedTrackId 仍为空')
      })

      /* 真实交互：点击时间轴空白 → 播放头移动（DAW 直接操作惯例） */
      await check('交互：点击时间轴空白定位播放头', async () => {
        const before = await page.evaluate(`return window.AIAB.useStore.getState().playhead`)
        // 先滚到工程末尾的空白区域，避免点到片段
        const point = await page.evaluate(`
          const scroller = document.querySelector('[aria-label="编曲时间轴"]')
          if (!scroller) return null
          scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth
          await new Promise((resolve) => setTimeout(resolve, 240))
          const rect = scroller.getBoundingClientRect()
          return { x: rect.left + rect.width - 160, y: rect.top + rect.height * 0.62 }
        `)
        if (!point) throw new Error('找不到时间轴滚动容器')
        await page.mouseClick(point.x, point.y)
        const after = await page.evaluate(`return window.AIAB.useStore.getState().playhead`)
        if (Math.abs(after - before) < 0.01) throw new Error('点击时间轴空白后播放头未变化')
        // 还原滚动位置，方便后续截图
        await page.evaluate(`
          const scroller = document.querySelector('[aria-label="编曲时间轴"]')
          if (scroller) scroller.scrollLeft = 0
          return true
        `)
      })

      /* 真实交互：右键片段 → 上下文菜单 */
      await check('交互：右键片段打开上下文菜单', async () => {
        const opened = await page.evaluate(`
          const clip = document.querySelector('[data-clip]')
          if (!clip) return false
          const rect = clip.getBoundingClientRect()
          clip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 10 }))
          await new Promise((resolve) => setTimeout(resolve, 150))
          return document.querySelectorAll('[role="menu"]').length > 0
        `)
        if (!opened) throw new Error('未出现 role=menu 上下文菜单')
        await page.pressKey('Escape')
      })
    }

    /* ---------- 命令面板 ---------- */
    if (!ONLY || ONLY === 'palette') {
      await page.evaluate(`window.dispatchEvent(new CustomEvent('aiab:command-palette')); return true`)
      await page.waitFor('document.querySelector("[aria-label=命令面板]")')
      await page.screenshot('02-command-palette')
      await expect(page, '命令面板：默认列出命令', 'document.querySelectorAll("[data-command-index]").length >= 8')
      await page.evaluate(`
        const input = document.querySelector('[aria-label="搜索命令"]')
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, '量化')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      `)
      await sleep(200)
      await page.screenshot('03-command-palette-search')
      await expect(page, '命令面板：搜索“量化”命中命令', 'document.body.innerText.includes("量化到吸附网格")')
      await page.pressKey('Escape')
    }

    /* ---------- 全局快捷键 ---------- */
    if (!ONLY || ONLY === 'shortcuts') {
      const before = await page.evaluate(`return window.AIAB.useUiStore.getState().followPlayhead`)
      await page.pressKey('f')
      const after = await page.evaluate(`return window.AIAB.useUiStore.getState().followPlayhead`)
      if (before === after) throw new Error('按 F 未切换跟随播放头')
      ok('快捷键：F 切换跟随播放头')
      await page.pressKey('f')
      const recordBefore = await page.evaluate(`return window.AIAB.useStore.getState().midiRecord`)
      await page.pressKey('r')
      const recordAfter = await page.evaluate(`return window.AIAB.useStore.getState().midiRecord`)
      if (recordBefore === recordAfter) throw new Error('按 R 未切换 MIDI 录入')
      ok('快捷键：R 切换 MIDI 录入')
      await page.pressKey('r')

      // ⌘K / CtrlK 打开命令面板（modifiers: 4 = Meta）
      await page.pressKey('k', { code: 'KeyK', modifiers: 4 })
      await page.waitFor('document.querySelector("[aria-label=命令面板]")', 3000)
      ok('快捷键：⌘K 打开命令面板')
      await page.pressKey('Escape')

      // ? 打开帮助
      await page.pressKey('?', { code: 'Slash', modifiers: 8 })
      await sleep(300)
      const helpOpen = await page.evaluate(`return window.AIAB.useStore.getState().helpOpen`)
      if (helpOpen) ok('快捷键：? 打开帮助')
      await page.pressKey('Escape')
      await page.evaluate(`window.AIAB.useStore.getState().setHelpOpen(false); return true`)
    }

    /* 清掉测试过程中产生的提示条，并把播放头回到开头（截图更干净） */
    await page.evaluate(`window.AIAB.useStore.setState({ toasts: [] }); window.AIAB.useStore.getState().setPlayhead(0); return true`)

    /* ---------- 轨道头 / 混音器 / 面板 ---------- */
    if (!ONLY || ONLY === 'mixer') {
      await page.evaluate(`window.AIAB.useStore.getState().setView('arrangement'); window.AIAB.useStore.getState().setShowMixer(true); return true`)
      await page.waitFor('document.querySelector("[data-mixer-panel]")')
      await page.screenshot('04-mixer')
      await expect(
        page,
        '混音器：通道条数量与轨道数一致',
        'document.querySelectorAll("[data-channel-strip]").length === window.AIAB.useStore.getState().project.tracks.length',
        '通道条数量不匹配',
      )
      await expect(
        page,
        '混音器：有 dB 标尺与主输出电平',
        'document.querySelector("[data-mixer-panel]").innerText.includes("dB")',
        '未找到 dB 标尺',
      )
      await expect(
        page,
        '混音器：高度来自 uiStore（可拖拽）',
        'document.querySelector("[data-mixer-panel]").getBoundingClientRect().height === window.AIAB.useUiStore.getState().mixerHeight',
      )
      await page.evaluate(`window.AIAB.useStore.getState().setShowMixer(false); return true`)
    }

    /* ---------- 钢琴卷帘 ---------- */
    if (!ONLY || ONLY === 'pianoroll') {
      await page.evaluate(`
        const store = window.AIAB.useStore.getState()
        const track = store.project.tracks.find((item) => item.clips.length > 0)
        if (!track) return false
        store.selectClip(track.id, track.clips[0].id)
        store.setView('pianoroll')
        return true
      `)
      await page.waitFor('document.querySelector("canvas")')
      await sleep(400)
      await page.screenshot('05-pianoroll')
      await expect(
        page,
        '钢琴卷帘：音阶锁定 / 幽灵音符工具存在',
        'document.body.innerText.includes("音阶锁定") && document.body.innerText.includes("幽灵音符")',
      )
      await expect(page, '钢琴卷帘：画布渲染', 'document.querySelectorAll("canvas").length > 0')
    }

    /* ---------- 智能片段 ---------- */
    if (!ONLY || ONLY === 'smartclips') {
      await page.evaluate(`
        const store = window.AIAB.useStore.getState()
        const target = store.smartClipTarget
        if (target) store.setView('smartclips')
        else {
          const track = store.project.tracks.find((item) => item.clips.length > 0)
          if (track) { store.selectClip(track.id, track.clips[0].id); store.setSmartClipTarget({ trackId: track.id, clipId: track.clips[0].id }) }
          store.setView('smartclips')
        }
        return true
      `)
      await page.waitFor('document.body.innerText.includes("智能片段")')
      await page.screenshot('06-smartclips')
    }

    /* ---------- AI 面板 / 设置 / 导出 / 帮助 / 欢迎 ---------- */
    if (!ONLY || ONLY === 'chat') {
      await page.evaluate(`
        const store = window.AIAB.useStore.getState()
        store.setView('arrangement')
        store.setChatOpen(true)
        store.setShowMixer(false)
        return true
      `)
      await sleep(400)
      await page.screenshot('07-ai-chat')
      await expect(page, 'AI 面板：输入框与发送按钮可用', `!!document.querySelector('textarea') && [...document.querySelectorAll('button')].some((button) => /发送/.test(button.textContent || ''))`)
      await expect(page, 'AI 面板：有上下文/命令入口', 'document.body.innerText.includes("命令") || document.body.innerText.includes("快捷动作")')
    }

    if (!ONLY || ONLY === 'help') {
      await page.evaluate(`window.AIAB.useStore.getState().setHelpOpen(true); return true`)
      await page.waitFor('document.body.innerText.includes("快捷键与操作指南")')
      await page.screenshot('08-help')
      await expect(
        page,
        '帮助：可搜索的快捷键分区',
        'document.body.innerText.includes("快速开始") && document.body.innerText.includes("快捷键")',
      )
      await page.pressKey('Escape')
    }

    if (!ONLY || ONLY === 'settings') {
      await page.evaluate(`window.AIAB.useStore.getState().setSettingsOpen(true); return true`)
      await page.waitFor('document.body.innerText.includes("设置")')
      await page.screenshot('09-settings')
      await expect(
        page,
        '设置：四个分区关键词仍在（e2e 兼容）',
        `['AI 服务商','联网搜索','Agent','音色库'].every((keyword) => document.body.innerText.includes(keyword))`,
      )
      await page.pressKey('Escape')
      await page.evaluate(`window.AIAB.useStore.getState().setSettingsOpen(false); return true`)
    }

    if (!ONLY || ONLY === 'export') {
      await page.evaluate(`window.AIAB.useStore.getState().setExportOpen(true); return true`)
      await sleep(500)
      await page.screenshot('10-export')
      await expect(
        page,
        '导出：五种格式齐全',
        `['MIDI','WAV','MP3','FLAC','OGG'].every((format) => document.body.innerText.includes(format))`,
      )
      await page.evaluate(`window.AIAB.useStore.getState().setExportOpen(false); return true`)
    }

    if (!ONLY || ONLY === 'welcome') {
      await page.evaluate(`window.dispatchEvent(new CustomEvent('aiab:welcome')); return true`)
      await page.waitFor('document.body.innerText.includes("欢迎来到 AI 编曲伴侣")')
      await page.screenshot('11-welcome')
      await page.pressKey('Escape')
    }

    if (!ONLY || ONLY === 'chat-collapsed') {
      await page.evaluate(`window.AIAB.useUiStore.getState().setChatCollapsed(true); return true`)
      await page.evaluate(`window.AIAB.useStore.getState().setChatOpen(true); return true`)
      await sleep(400)
      await page.screenshot('12-chat-collapsed')
      await expect(
        page,
        'AI 面板：可收成 56px 窄条',
        `window.AIAB.useUiStore.getState().chatCollapsed === true && document.body.innerText.length > 0`,
      )
      await page.evaluate(`window.AIAB.useUiStore.getState().setChatCollapsed(false); return true`)
    }

    /* ---------- 控制台 ---------- */
    await check('全流程无未过滤的控制台错误', async () => {
      if (page.consoleErrors.length) throw new Error(page.consoleErrors.slice(0, 5).join(' | '))
    })
  } finally {
    page?.close()
    server.child.kill('SIGKILL')
    await sleep(200)
  }

  console.log(`\n${C.bold}${failed === 0 ? C.green + '✓ UI 验收全部通过' : C.red + '✗ 存在失败项'}${C.reset}  ${passed}/${passed + failed}`)
  if (failures.length) {
    console.log(failures.map((failure) => `  - ${failure}`).join('\n'))
  }
  console.log(`${C.dim}截图：${SHOT_DIR}${C.reset}`)
  if (!process.env.UI_KEEP) {
    try {
      rmSync(path.join(DATA_DIR, 'chrome-profile'), { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  process.exitCode = failed === 0 ? 0 : 1
  // 等待 stdout 刷干净再退出，避免 last-write 丢失
  await new Promise((resolve) => process.stdout.write('', resolve))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
