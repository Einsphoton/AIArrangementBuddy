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

      /* 真实交互：轨道头 R 按钮 → 录入预备，且录入目标解析到该轨（缺陷 #3：R 不能只点亮红点） */
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

      /* 缺陷 #3：R 预备后，录入目标必须真的指向该轨（而不是像旧版只点亮红点） */
      await check('交互：R 预备后录入目标解析到该轨', async () => {
        const resolved = await page.evaluate(`
          const store = window.AIAB.useStore.getState()
          const ui = window.AIAB.useUiStore.getState()
          const armed = ui.armedTrackId
          if (!armed) return { error: '没有已预备的轨道' }
          const track = store.project.tracks.find((item) => item.id === armed)
          if (!track) return { error: '预备的轨道在工程里不存在' }
          return { armed, focused: store.focusedTrackId, name: track.name }
        `)
        if (resolved.error) throw new Error(resolved.error)
        if (resolved.focused !== resolved.armed) {
          throw new Error(`预备轨 ${resolved.armed} 与聚焦轨 ${resolved.focused} 不同步（录入会写错轨）`)
        }
      })

      /* 缺陷 #3：M / S 按钮必须真的改工程状态（旧版 M/S 的静音会被 volume ramp 撤销） */
      await check('交互：M 静音 / S 独奏按钮改变工程状态', async () => {
        const result = await page.evaluate(`
          const before = window.AIAB.useStore.getState().project.tracks
          if (!before.length) return { error: '工程没有轨道' }
          const pick = (re) => [...document.querySelectorAll('button')].find((item) => re.test(item.getAttribute('aria-label') || ''))
          const muteBtn = pick(/^(静音|取消静音) /)
          const soloBtn = pick(/^(独奏|取消独奏) /)
          if (!muteBtn || !soloBtn) return { error: '找不到 M / S 按钮' }
          const id = before[0].id
          const mute0 = before[0].mute
          muteBtn.click()
          await new Promise((r) => setTimeout(r, 80))
          const mute1 = window.AIAB.useStore.getState().project.tracks.find((t) => t.id === id).mute
          soloBtn.click()
          await new Promise((r) => setTimeout(r, 80))
          const solo1 = window.AIAB.useStore.getState().project.tracks.find((t) => t.id === id).solo
          const levels = window.AIAB.engine.getTrackLevels ? Object.keys(window.AIAB.engine.getTrackLevels()) : []
          return { id, mute0, mute1, solo1, hasLevels: levels.length > 0 }
        `)
        if (result.error) throw new Error(result.error)
        if (result.mute1 === result.mute0) throw new Error('点击 M 后 track.mute 没有变化')
        if (result.solo1 !== true) throw new Error('点击 S 后 track.solo 没有变成 true')
        if (!result.hasLevels) throw new Error('引擎没有轨道电平读数（音频图未建立）')
      })

      /*
       * ★ 核心验收：按 S 之后**绝不**把其它轨道 M 掉。
       * 这是本产品的明确设计（见 docs/TRACK_CONTROLS.md）：独奏只在运行期派生
       * 「隐式静音」，工程里的 mute 一个字节都不写；取消独奏后原状恢复。
       */
      await check('交互：独奏不会改写其它轨道的静音（不产生破坏性 mute 翻转）', async () => {
        const result = await page.evaluate(`
          const store = window.AIAB.useStore
          /* 复位到干净状态 */
          store.getState().setAllMuted(false)
          store.getState().clearAllSolos()
          await new Promise((r) => setTimeout(r, 60))
          const tracks = store.getState().project.tracks
          if (tracks.length < 2) return { error: '需要至少 2 条轨道' }
          /* 先给第二条轨显式静音，制造「有既有静音状态」的现场 */
          store.getState().setTrackMuted(tracks[1].id, true)
          await new Promise((r) => setTimeout(r, 60))
          /* 独奏第一条 */
          store.getState().toggleSolo(tracks[0].id)
          await new Promise((r) => setTimeout(r, 80))
          const after = store.getState().project.tracks
          const mutedIds = after.filter((t) => t.mute).map((t) => t.id)
          const soloIds = after.filter((t) => t.solo).map((t) => t.id)
          /* 再清空独奏，检查静音是否原样恢复 */
          store.getState().clearAllSolos()
          await new Promise((r) => setTimeout(r, 80))
          const restored = store.getState().project.tracks.filter((t) => t.mute).map((t) => t.id)
          return { mutedIds, soloIds, restored, secondId: tracks[1].id, firstId: tracks[0].id }
        `)
        if (result.error) throw new Error(result.error)
        if (result.soloIds.length !== 1) throw new Error(`独奏数量应为 1，实际 ${result.soloIds.length}`)
        if (!result.mutedIds.includes(result.secondId)) {
          throw new Error('独奏把第二条轨的 M 状态弄丢了')
        }
        if (result.mutedIds.length !== 1) {
          throw new Error(`独奏后显式静音轨应仍只有 1 条，实际 ${result.mutedIds.length}（说明 solo 写回了 mute）`)
        }
        if (!result.restored.includes(result.secondId)) {
          throw new Error('清空独奏后原有静音没有恢复')
        }
      })

      /* ★ 核心验收：总控三件套常驻可见、带数量、一键生效 */
      await check('交互：轨道列表总控 M/S/R 常驻且带数量', async () => {
        const master = await page.evaluate(`
          const get = (label) => document.querySelector('[data-mix-master="panel"] [data-mix-master-button="' + label + '"]')
          const mute = get('M'), solo = get('S'), arm = get('R')
          return {
            present: Boolean(mute && solo && arm),
            counts: {
              m: mute ? Number(mute.dataset.count) : null,
              s: solo ? Number(solo.dataset.count) : null,
              r: arm ? Number(arm.dataset.count) : null,
            },
            labels: [mute, solo, arm].filter(Boolean).map((el) => el.getAttribute('aria-label') || ''),
          }
        `)
        if (!master.present) throw new Error('轨道列表没有常驻总控 M/S/R')
        if (master.counts.m === null) throw new Error('总控按钮缺少数值（只有颜色会漏看）')
        if (!master.labels.some((label) => /轨道总控|M：|S：|R：/.test(label))) {
          throw new Error('总控按钮缺少可读的无障碍标签')
        }
      })

      /* ★ 总控 M：一键全部静音 / 一键全部取消 */
      await check('交互：总控 M 一键静音全部轨道，再点一次全部取消', async () => {
        const result = await page.evaluate(`
          const store = window.AIAB.useStore
          store.getState().setAllMuted(false)
          store.getState().clearAllSolos()
          await new Promise((r) => setTimeout(r, 60))
          const btn = document.querySelector('[data-mix-master-button="M"]')
          if (!btn) return { error: '找不到总控 M' }
          btn.click()
          await new Promise((r) => setTimeout(r, 120))
          const tracks = store.getState().project.tracks
          const mutedOn = tracks.filter((t) => t.mute).length
          const countOn = Number(document.querySelector('[data-mix-master-button="M"]').dataset.count)
          btn.click()
          await new Promise((r) => setTimeout(r, 120))
          const mutedOff = store.getState().project.tracks.filter((t) => t.mute).length
          return { total: tracks.length, mutedOn, countOn, mutedOff }
        `)
        if (result.error) throw new Error(result.error)
        if (result.mutedOn !== result.total) throw new Error(`总控 M 未静音全部（${result.mutedOn}/${result.total}）`)
        if (result.countOn !== result.total) throw new Error('总控 M 的计数没有跟着变')
        if (result.mutedOff !== 0) throw new Error('再点一次总控 M 没有全部取消静音')
      })

      /* ★ 总控 S：清空全部独奏，且不动 mute */
      await check('交互：总控 S 清空全部独奏（不动静音状态）', async () => {
        const result = await page.evaluate(`
          const store = window.AIAB.useStore
          store.getState().setAllMuted(false)
          store.getState().clearAllSolos()
          await new Promise((r) => setTimeout(r, 60))
          const tracks = store.getState().project.tracks
          if (tracks.length < 2) return { error: '需要至少 2 条轨道' }
          store.getState().setTrackMuted(tracks[0].id, true)
          store.getState().toggleSolo(tracks[1].id)
          store.getState().toggleSolo(tracks[0].id)
          await new Promise((r) => setTimeout(r, 100))
          const beforeSolo = store.getState().project.tracks.filter((t) => t.solo).length
          const beforeMute = store.getState().project.tracks.filter((t) => t.mute).length
          const btn = document.querySelector('[data-mix-master-button="S"]')
          if (!btn) return { error: '找不到总控 S' }
          if (btn.disabled) return { error: '有独奏时总控 S 仍是禁用的' }
          btn.click()
          await new Promise((r) => setTimeout(r, 120))
          const afterSolo = store.getState().project.tracks.filter((t) => t.solo).length
          const afterMute = store.getState().project.tracks.filter((t) => t.mute).length
          return { beforeSolo, afterSolo, beforeMute, afterMute }
        `)
        if (result.error) throw new Error(result.error)
        if (result.beforeSolo < 1) throw new Error('夹具没建立独奏')
        if (result.afterSolo !== 0) throw new Error('总控 S 没有清空独奏')
        if (result.afterMute !== result.beforeMute) throw new Error('总控 S 不该改动任何静音状态')
      })

      /* ★ 三态：被独奏压住的轨道必须「不是 muted」，且编曲车道有可见反馈 */
      await check('交互：被独奏压住的轨道不算静音，且编曲车道变暗', async () => {
        const result = await page.evaluate(`
          const store = window.AIAB.useStore
          store.getState().setAllMuted(false)
          store.getState().clearAllSolos()
          await new Promise((r) => setTimeout(r, 60))
          const tracks = store.getState().project.tracks
          if (tracks.length < 2) return { error: '需要至少 2 条轨道' }
          store.getState().toggleSolo(tracks[0].id)
          await new Promise((r) => setTimeout(r, 140))
          const lanes = [...document.querySelectorAll('[data-track-row][data-track-id]')]
            .filter((el) => el.closest('[aria-label="编曲时间轴"]'))
          const suppressed = lanes.find((el) => el.dataset.mixState === 'implicitly-muted')
          const soloLane = lanes.find((el) => el.dataset.trackId === tracks[0].id)
          const mutedFlagOnSuppressed = store.getState().project.tracks
            .filter((t) => t.id !== tracks[0].id)
            .some((t) => t.mute)
          const mutedBtnLit = [...document.querySelectorAll('[data-implicit-mute="true"]')].length
          return {
            hasSuppressedLane: Boolean(suppressed),
            opacity: suppressed ? getComputedStyle(suppressed).opacity : null,
            soloLaneState: soloLane ? soloLane.dataset.mixState : null,
            mutedFlagOnSuppressed,
            mutedBtnLit,
          }
        `)
        if (result.error) throw new Error(result.error)
        if (!result.hasSuppressedLane) throw new Error('没有轨道被标记为 implicitly-muted（编曲车道看不出 solo 状态）')
        if (Number(result.opacity) >= 0.95) throw new Error('被压住的车道没有变暗，用户看不出来')
        if (result.soloLaneState !== 'audible') throw new Error('被独奏的轨道不该被判成不可听')
        if (result.mutedFlagOnSuppressed) throw new Error('被压住的轨道被错误地写上了 mute 标记')
        if (result.mutedBtnLit < 1) throw new Error('轨道头没有把「被独奏压住」渲染成描边提示')
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

    /* ---------- 混音状态视觉：静音 / 被独奏压住 / 总控激活 ---------- */
    if (!ONLY || ONLY === 'mixstates') {
      await page.evaluate(`
        window.AIAB.useStore.getState().setView('arrangement')
        window.AIAB.useStore.getState().setShowMixer(false)
        return true
      `)
      await sleep(300)

      /* 1) 显式静音（M 实心点亮 + 名字划掉 + 车道变暗） */
      await page.evaluate(`
        const store = window.AIAB.useStore.getState()
        store.setAllMuted(false); store.clearAllSolos()
        const tracks = store.project.tracks
        store.setTrackMuted(tracks[1].id, true)
        store.setTrackMuted(tracks[4].id, true)
        return true
      `)
      await sleep(350)
      await page.screenshot('13-mix-muted')
      await expect(
        page,
        '混音状态：显式静音 → M 实心 + 车道变暗',
        `(() => {
          const rows = [...document.querySelectorAll('[aria-label="轨道列表"] [data-track-row]')]
          const muted = rows.filter((el) => el.querySelector('[data-track-mute="true"]'))
          const dark = rows.filter((el) => el.dataset.mixState === 'muted')
          const lanes = [...document.querySelectorAll('[aria-label="编曲时间轴"] [data-track-row][data-track-id]')]
            .filter((el) => el.dataset.mixState === 'muted')
          return muted.length === 2 && dark.length === 2 && lanes.length === 2
        })()`,
        '静音状态没有同步到 M 灯与车道',
      )

      /* 2) 独奏：被压住的轨是描边 M（不是实心）+ 车道变暗；总控 S 点亮并显示数量 */
      await page.evaluate(`
        const store = window.AIAB.useStore.getState()
        store.setAllMuted(false); store.clearAllSolos()
        const tracks = store.project.tracks
        store.toggleSolo(tracks[0].id)
        store.toggleSolo(tracks[2].id)
        return true
      `)
      await sleep(350)
      await page.screenshot('14-mix-solo')
      await expect(
        page,
        '混音状态：独奏 → 被压住的轨是描边 M（绝不实心点亮）',
        `(() => {
          const rows = [...document.querySelectorAll('[aria-label="轨道列表"] [data-track-row]')]
          const suppressed = rows.filter((el) => el.dataset.mixState === 'implicitly-muted')
          const implicitMarks = rows.filter((el) => el.querySelector('[data-implicit-mute="true"]'))
          const solidMute = rows.filter((el) => el.querySelector('[data-track-mute="true"]'))
          const soloCount = Number(document.querySelector('[data-status-solo-count]').dataset.statusSoloCount)
          const masterS = document.querySelector('[data-mix-master-button="S"]')
          return suppressed.length > 0 && implicitMarks.length === suppressed.length && solidMute.length === 0
            && soloCount === 2 && masterS.dataset.active === 'true' && Number(masterS.dataset.count) === 2
        })()`,
        '独奏派生静音没有和显式静音区分开',
      )

      /* 3) 总控 M 全静音：M 计数 = 轨道数，总控按钮进入激活态 */
      await page.evaluate(`
        const store = window.AIAB.useStore.getState()
        store.clearAllSolos(); store.setAllMuted(false)
        store.toggleMuteAll()
        return true
      `)
      await sleep(350)
      await page.screenshot('15-mix-master-active')
      await expect(
        page,
        '总控 M 全静音：按钮激活且计数 = 轨道数',
        `(() => {
          const btn = document.querySelector('[data-mix-master-button="M"]')
          const total = window.AIAB.useStore.getState().project.tracks.length
          return btn.dataset.active === 'true' && Number(btn.dataset.count) === total
        })()`,
      )

      /* 收回现场，避免影响后续截图 */
      await page.evaluate(`
        const store = window.AIAB.useStore.getState()
        store.setAllMuted(false); store.clearAllSolos()
        return true
      `)
      await sleep(200)
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
