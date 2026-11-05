/**
 * 浏览器验收基础设施（供 UI 验收 / 布局审计脚本复用）。
 *
 * - startStaticServer：用已构建的 apps/server/dist 启动生产服务（SERVE_STATIC=1）
 * - launchChrome：headless Chrome + CDP 客户端（evaluate / 截图 / 键鼠 / 视口）
 *
 * 注意：这里不构建代码；调用方先跑 `node scripts/build.mjs`。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { pickFreePort } from './ports.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ */
/* 服务                                                                */
/* ------------------------------------------------------------------ */

export async function startStaticServer(options = {}) {
  const port = options.port ?? (await pickFreePort(options.preferredPort ?? 8950))
  const dataDir = options.dataDir ?? path.join(tmpdir(), `aiab-harness-${Date.now()}`)
  const entry = path.join(ROOT, 'apps/server/dist/server.mjs')
  if (!existsSync(entry)) throw new Error('未构建：请先运行 node scripts/build.mjs')
  const child = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      SERVE_STATIC: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (chunk) => (log += chunk))
  child.stderr.on('data', (chunk) => (log += chunk))

  const base = `http://127.0.0.1:${port}`
  const started = Date.now()
  while (Date.now() - started < 40000) {
    try {
      const response = await fetch(`${base}/api/health`)
      if (response.ok) {
        const health = await response.json()
        return { base, port, dataDir, child, health, getLog: () => log }
      }
    } catch {
      /* 继续等 */
    }
    await sleep(250)
  }
  child.kill('SIGKILL')
  throw new Error('后端启动超时')
}

/** 配置一个占位服务商，让 AI 面板显示「已就绪」（不会发起网络请求） */
export async function configurePlaceholderProvider(base) {
  try {
    const settings = await (await fetch(`${base}/api/settings`)).json()
    settings.providers = [
      {
        id: 'ui-harness',
        name: 'DeepSeek（界面示例）',
        kind: 'openai',
        baseUrl: 'http://127.0.0.1:65535/v1',
        apiKey: 'ui-harness-key',
        model: 'deepseek-chat',
        temperature: 0.7,
        maxTokens: 2048,
        parallelToolCalls: false,
        extraHeaders: {},
      },
    ]
    settings.activeProviderId = 'ui-harness'
    settings.agent = { ...settings.agent, backend: 'builtin', timeoutMs: 60000 }
    await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    })
  } catch {
    /* 忽略：界面上会显示未配置，不影响布局审计 */
  }
}

/* ------------------------------------------------------------------ */
/* Chrome                                                              */
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
  ].filter(Boolean)
  return candidates.find((file) => existsSync(file)) ?? null
}

export async function launchChrome(options = {}) {
  const chrome = findChrome()
  if (!chrome) throw new Error('未找到 Chrome/Chromium（可用 CHROME_PATH 指定）')
  const debugPort = options.debugPort ?? (await pickFreePort(8970))
  const profile = path.join(options.dataDir ?? tmpdir(), `chrome-profile-${Date.now()}`)
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
      `--window-size=${options.width ?? 1680},${(options.height ?? 1000) + 50}`,
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

  const page = {
    consoleErrors,
    send,
    async setViewport(width, height) {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      })
    },
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
    async pressKey(key, opts = {}) {
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key,
        code: opts.code ?? key,
        modifiers: opts.modifiers ?? 0,
      })
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code: opts.code ?? key,
        modifiers: opts.modifiers ?? 0,
      })
      await sleep(120)
    },
    async mouseClick(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      await sleep(180)
    },
    async screenshot(file) {
      await sleep(220)
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      mkdirSync(path.dirname(file), { recursive: true })
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
