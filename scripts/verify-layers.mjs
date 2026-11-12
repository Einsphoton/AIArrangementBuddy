#!/usr/bin/env node
/**
 * 层级 / 遮挡验收：顶栏「文件」菜单必须浮在内容层之上。
 *
 * 背景（2026-11-12 用户报障「UI 层级有问题」）：
 * 文件菜单原来直接渲染在顶栏里（顶栏 `relative z-30` 形成堆叠上下文，菜单 z-50 被关在里面），
 * 而主编辑区的时间轴工具条 / 播放头同样是 z-30、DOM 更靠后，于是画在了菜单上面。
 * 修复方式：菜单 portal 到 body、固定定位 + z-[60]（见 docs/UI_LAYERING.md）。
 *
 * 本脚本在真实浏览器里逐宽度打开菜单，用 elementsFromPoint 采样「菜单内部点最上层元素是否属于菜单」，
 * 并额外检查时间轴工具条、播放头是否穿透菜单，以及打开/返回/弹窗/Esc/窗口缩放行为。
 *
 *   node scripts/verify-layers.mjs                 # 构建 + 验收（1680/1440/1280/900/720/460）
 *   LAYER_SKIP_BUILD=1 node scripts/verify-layers.mjs
 *   LAYER_WIDTHS=1440,460 node scripts/verify-layers.mjs
 *
 * 产物：.verify-ui/layers/<width>-file-menu.png + 控制台 PASS/FAIL 报告。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ROOT, sleep, startStaticServer, launchChrome } from './lib/browser-harness.mjs'
import { pickFreePort } from './lib/ports.mjs'

const SHOT_DIR = path.join(ROOT, '.verify-ui', 'layers')
const SKIP_BUILD = process.env.LAYER_SKIP_BUILD === '1'
const WIDTHS = (process.env.LAYER_WIDTHS || '1680,1440,1280,900,720,460')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value >= 360)
const VIEWPORT_HEIGHT = Number(process.env.LAYER_HEIGHT || 900)

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', bold: '\x1b[1m' }
let passed = 0
let failed = 0
const failures = []

function ok(message) {
  passed++
  console.log(`  ${C.green}✓${C.reset} ${message}`)
}
function bad(message, detail) {
  failed++
  failures.push(`${message}${detail ? `：${detail}` : ''}`)
  console.log(`  ${C.red}✗${C.reset} ${message}${detail ? `${C.dim}  ${detail}${C.reset}` : ''}`)
}
function assert(condition, message, detail) {
  if (condition) ok(message)
  else bad(message, detail)
  return condition
}

/* ------------------------------------------------------------------ */
/* 构建 / 服务                                                          */
/* ------------------------------------------------------------------ */

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    child.stdout.on('data', (chunk) => (log += chunk))
    child.stderr.on('data', (chunk) => (log += chunk))
    child.on('close', (code) => (code === 0 ? resolve(log) : reject(new Error(log || `exit ${code}`))))
  })
}

/* ------------------------------------------------------------------ */
/* 页面内探针                                                           */
/* ------------------------------------------------------------------ */

/** 菜单内部采样：最上层元素必须属于菜单；同时量菜单贴边与视口内情况 */
const SAMPLE_FN = `
(() => {
  const menu = document.querySelector('[data-project-menu]')
  const btn = [...document.querySelectorAll('header button')].find((b) => (b.textContent || '').includes('文件'))
  if (!menu || !btn) return { error: menu ? 'no-trigger' : 'no-menu' }
  const mr = menu.getBoundingClientRect()
  const br = btn.getBoundingClientRect()
  const style = getComputedStyle(menu)
  const owned = (el) => menu.contains(el)
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    cls: String(el.className || '').slice(0, 80),
    z: getComputedStyle(el).zIndex,
    pos: getComputedStyle(el).position,
  })
  const offenders = []
  const radius = parseFloat(style.borderTopLeftRadius) || 0
  /** 圆角菜单的四个角不在菜单的绘制/命中区域里，采样时跳过，避免把「角外」误判成遮挡 */
  const inRoundedRect = (x, y) => {
    if (x < mr.left || x > mr.right || y < mr.top || y > mr.bottom) return false
    if (!radius) return true
    const cx = x < mr.left + radius ? mr.left + radius : x > mr.right - radius ? mr.right - radius : x
    const cy = y < mr.top + radius ? mr.top + radius : y > mr.bottom - radius ? mr.bottom - radius : y
    return Math.hypot(x - cx, y - cy) <= radius + 1e-6
  }
  const stepX = Math.max(6, mr.width / 16)
  const stepY = Math.max(6, mr.height / 32)
  for (let x = mr.left + 2; x < mr.right - 2; x += stepX) {
    for (let y = mr.top + 2; y < mr.bottom - 2; y += stepY) {
      if (!inRoundedRect(x, y)) continue
      const stack = document.elementsFromPoint(x, y)
      if (!stack.length) continue
      if (!owned(stack[0])) offenders.push({ at: [Math.round(x), Math.round(y)], top: describe(stack[0]) })
    }
  }
  const rectOf = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const overlaps = (a, b) => a && b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  // 时间轴工具条（主编辑区最上方的常驻工具条）
  const toolbar = document.querySelector('[role="toolbar"]')
  const toolbarRect = rectOf(toolbar)
  let toolbarProbe = null
  if (toolbar && overlaps(toolbarRect, rectOf(menu))) {
    const cx = Math.max(mr.left + 4, Math.min(toolbarRect.x + toolbarRect.w / 2, mr.right - 4))
    const cy = Math.max(mr.top + 4, Math.min(toolbarRect.y + toolbarRect.h / 2, mr.bottom - 4))
    const stack = document.elementsFromPoint(cx, cy)
    toolbarProbe = { at: [Math.round(cx), Math.round(cy)], coveredByMenu: stack.length > 0 && owned(stack[0]), top: stack[0] ? describe(stack[0]) : null }
  }
  // 播放头（1.5px 竖线）：若穿过菜单范围，检查菜单是否盖住它
  const playheadLine = document.querySelector('div[class*="w-[1.5px]"]')
  const playheadRect = rectOf(playheadLine)
  let playheadProbe = null
  if (playheadRect && playheadRect.w <= 4 && overlaps(playheadRect, rectOf(menu))) {
    const px = playheadRect.x + playheadRect.w / 2
    const py = mr.top + mr.height / 2
    const stack = document.elementsFromPoint(px, py)
    playheadProbe = { at: [Math.round(px), Math.round(py)], coveredByMenu: stack.length > 0 && owned(stack[0]), top: stack[0] ? describe(stack[0]) : null }
  }
  return {
    menu: rectOf(menu),
    trigger: rectOf(btn),
    position: style.position,
    zIndex: style.zIndex,
    portalToBody: menu.parentElement === document.body,
    viewport: [innerWidth, innerHeight],
    offenders,
    toolbarProbe,
    playheadProbe,
    text: (menu.textContent || '').replace(/\s+/g, ' ').slice(0, 120),
  }
})()
`

const openMenu = async (page, width) => {
  await page.setViewport(width, VIEWPORT_HEIGHT)
  await page.goto(`${page.base}/?intro=0`)
  await page.waitFor('window.AIAB && document.querySelector("header")')
  await sleep(350)
  const opened = await page.evaluate(`
    const btn = [...document.querySelectorAll('header button')].find((b) => (b.textContent || '').includes('文件'))
    if (!btn) return false
    btn.click()
    await new Promise((r) => setTimeout(r, 450))
    return !!document.querySelector('[data-project-menu]')
  `)
  return opened
}

const clickMenuItem = (page, label) =>
  page.evaluate(`
    const menu = document.querySelector('[data-project-menu]')
    const item = [...menu.querySelectorAll('button')].find((b) => (b.textContent || '').includes(${JSON.stringify(label)}))
    if (!item) return false
    item.click()
    await new Promise((r) => setTimeout(r, 450))
    return true
  `)

const menuGone = (page) => page.evaluate(`return !document.querySelector('[data-project-menu]')`)
const menuVisible = (page) =>
  page.evaluate(`
    const menu = document.querySelector('[data-project-menu]')
    if (!menu) return false
    const r = menu.getBoundingClientRect()
    const s = getComputedStyle(menu)
    return r.width > 100 && r.height > 100 && s.display !== 'none' && s.visibility !== 'hidden'
  `)

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

const main = async () => {
  mkdirSync(SHOT_DIR, { recursive: true })
  if (!SKIP_BUILD) {
    console.log(`${C.dim}构建前端与后端…${C.reset}`)
    await run(process.execPath, [path.join(ROOT, 'scripts/build.mjs')])
  }
  const server = await startStaticServer({ dataDir: path.join(tmpdir(), `aiab-layers-${Date.now()}`) })
  const port = await pickFreePort(8970, '127.0.0.1', 40)
  const page = await launchChrome({ width: 1680, height: VIEWPORT_HEIGHT, debugPort: port, dataDir: SHOT_DIR })
  page.base = server.base

  try {
    for (const width of WIDTHS) {
      console.log(`\n${C.cyan}${C.bold}[${width}×${VIEWPORT_HEIGHT}]${C.reset} 文件菜单层级`)
      const opened = await openMenu(page, width)
      if (!assert(opened, '菜单已打开（portal 到 body）')) continue

      const raw = await page.evaluate(`return JSON.stringify(${SAMPLE_FN})`)
      const data = JSON.parse(raw)

      assert(data.portalToBody, '菜单挂在 document.body 上', `parent=${data.portalToBody}`)
      assert(data.position === 'fixed', '菜单使用 fixed 定位（不受内容层堆叠影响）', `position=${data.position}`)
      assert(Number(data.zIndex) >= 45 && Number(data.zIndex) < 50, '菜单层级高于内容层、低于模态（z=45）', `z-index=${data.zIndex}`)
      assert(
        Math.abs(data.menu.x - data.trigger.x) <= 1 && Math.abs(data.menu.y - (data.trigger.y + data.trigger.h + 8)) <= 1,
        '菜单贴在「文件」按钮下方',
        `menu=${JSON.stringify(data.menu)} trigger=${JSON.stringify(data.trigger)}`,
      )
      assert(
        data.menu.x >= 0 && data.menu.y >= 0 && data.menu.x + data.menu.w <= data.viewport[0] - 4 && data.menu.y + data.menu.h <= data.viewport[1] - 4,
        '菜单整体在视口内',
        JSON.stringify(data.menu),
      )
      assert(
        data.offenders.length === 0,
        '菜单内部采样点最上层均为菜单内容（无内容层遮挡）',
        data.offenders.length ? `${data.offenders.length} 处，例如 ${JSON.stringify(data.offenders[0])}` : '',
      )
      if (data.toolbarProbe) {
        assert(data.toolbarProbe.coveredByMenu, '时间轴工具条被菜单正确遮挡', JSON.stringify(data.toolbarProbe))
      }
      if (data.playheadProbe) {
        assert(data.playheadProbe.coveredByMenu, '播放头没有画到菜单上', JSON.stringify(data.playheadProbe))
      }
      await page.screenshot(path.join(SHOT_DIR, `${width}-file-menu.png`))

      /* 交互：打开工程 → 返回；新建向导；导入简谱；Esc;窗口缩放 */
      if (await clickMenuItem(page, '打开工程')) {
        const openPanel = await page.evaluate(
          `return !!document.querySelector('[data-project-menu] button[aria-label="刷新列表"]')`,
        )
        assert(openPanel, '「打开工程…」进入工程列表面板')
        await page.evaluate(`
          const back = document.querySelector('[data-project-menu] button[aria-label="返回"]')
          back?.click()
          await new Promise((r) => setTimeout(r, 250))
          return true
        `)
      } else {
        bad('「打开工程…」菜单项存在')
      }

      if (await clickMenuItem(page, '新建工程')) {
        const wizard = await page.evaluate(`
          const dialog = document.querySelector('[data-new-project-dialog]')
          const menu = document.querySelector('[data-project-menu]')
          return JSON.stringify({ dialog: !!dialog, menuHidden: !menu || getComputedStyle(menu).display === 'none' })
        `)
        const state = JSON.parse(wizard)
        assert(state.dialog, '「新建工程…」打开新建向导弹窗')
        assert(state.menuHidden, '向导打开时文件菜单收起')
        await page.pressKey('Escape')
        await sleep(300)
        assert(await menuGone(page), '向导 Esc 后菜单关闭')
        if (await menuGone(page)) await openMenu(page, width)
      } else {
        bad('「新建工程…」菜单项存在')
      }

      if (await clickMenuItem(page, '导入简谱')) {
        const panel = await page.evaluate(`return !!document.querySelector('[data-jianpu-panel]')`)
        assert(panel, '「导入简谱…」打开简谱弹窗（portal z-200）')
        await page.pressKey('Escape')
        await sleep(250)
        const state = await page.evaluate(`
          return JSON.stringify({ panelGone: !document.querySelector('[data-jianpu-panel]'), menuOpen: !!document.querySelector('[data-project-menu]') })
        `)
        const after = JSON.parse(state)
        assert(after.panelGone, '简谱弹窗 Esc 关闭')
        assert(after.menuOpen, '关闭简谱弹窗后文件菜单仍在（不被误关）')
      } else {
        bad('「导入简谱…」菜单项存在')
      }

      /* 窗口缩放：菜单重新贴合按钮且不越界 */
      await page.setViewport(Math.max(360, width - 120), VIEWPORT_HEIGHT)
      await sleep(350)
      const resized = JSON.parse(
        await page.evaluate(`
          const menu = document.querySelector('[data-project-menu]')
          const btn = [...document.querySelectorAll('header button')].find((b) => (b.textContent || '').includes('文件'))
          if (!menu || !btn) return JSON.stringify({ error: 'missing' })
          const mr = menu.getBoundingClientRect()
          const br = btn.getBoundingClientRect()
          return JSON.stringify({ menu: [Math.round(mr.x), Math.round(mr.y), Math.round(mr.width), Math.round(mr.height)], trigger: [Math.round(br.x), Math.round(br.y), Math.round(br.width), Math.round(br.height)], viewport: [innerWidth, innerHeight] })
        `),
      )
      const expectedLeft = Math.max(8, Math.min(resized.trigger[0], resized.viewport[0] - resized.menu[2] - 8))
      const anchored = Math.abs(resized.menu[0] - expectedLeft) <= 1
      const inside = resized.menu[0] >= 0 && resized.menu[0] + resized.menu[2] <= resized.viewport[0] - 4
      assert(anchored && inside, '窗口缩放后菜单重新贴合按钮且在视口内', JSON.stringify(resized))

      /* 菜单开着时用快捷键打开设置：模态（z-50）必须盖住菜单（z=45），不能反过来 */
      await page.evaluate(`
        window.AIAB.useStore.getState().setSettingsOpen(true)
        await new Promise((r) => setTimeout(r, 500))
        return true
      `)
      const modalState = JSON.parse(
        await page.evaluate(`
          const menu = document.querySelector('[data-project-menu]')
          const modal = document.querySelector('[aria-modal="true"]')
          if (!menu || !modal) return JSON.stringify({ error: !modal ? 'no-modal' : 'no-menu' })
          const mr = menu.getBoundingClientRect()
          const stack = document.elementsFromPoint(mr.left + mr.width / 2, mr.top + 40)
          const top = stack[0]
          return JSON.stringify({ above: !!top && (top === modal || modal.contains(top)), tag: top && top.tagName, cls: top && String(top.className).slice(0, 60) })
        `),
      )
      assert(modalState.above, '菜单开着时设置模态盖在菜单之上（菜单须低于模态 z-50）', JSON.stringify(modalState))
      await page.evaluate(`
        window.AIAB.useStore.getState().setSettingsOpen(false)
        await new Promise((r) => setTimeout(r, 350))
        return true
      `)

      await page.pressKey('Escape')
      await sleep(200)
      assert(await menuGone(page), 'Esc 关闭文件菜单')
    }

    const errors = page.consoleErrors.filter((entry) => !/AudioContext|autoplay|MIDI|favicon|Web MIDI|SoundFont/i.test(entry))
    assert(errors.length === 0, '控制台无错误', errors.slice(0, 2).join(' | '))
  } finally {
    page.close()
    server.child.kill('SIGKILL')
  }
}

main()
  .then(() => {
    console.log(`\n${C.bold}结果：${C.green}${passed} 通过${C.reset}${failed ? `，${C.red}${failed} 失败${C.reset}` : ''}`)
    if (failures.length) {
      console.log(`${C.red}失败项：${C.reset}`)
      for (const item of failures) console.log(`  - ${item}`)
    }
    console.log(`${C.dim}截图目录：${SHOT_DIR}${C.reset}`)
    process.exit(failed ? 1 : 0)
  })
  .catch((error) => {
    console.error(`${C.red}验收脚本异常：${C.reset}`, error)
    process.exit(1)
  })
