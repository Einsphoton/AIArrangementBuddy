#!/usr/bin/env node
/**
 * 轨道多选 / 框选 / 批量操作 / 轨道头布局验收（真实 Chrome + CDP）
 *
 *   node scripts/verify-track-ui.mjs                 # 全量：构建 + 启动服务 + 断言 + 截图
 *   TRACK_SKIP_BUILD=1 node scripts/verify-track-ui.mjs
 *   UI_SKIP_BUILD=1   node scripts/verify-track-ui.mjs
 *   TRACK_ONLY=select,panelmarquee node scripts/verify-track-ui.mjs
 *   TRACK_VERBOSE=1   node scripts/verify-track-ui.mjs   # 额外打印每行名称宽度等量化指标
 *   TRACK_KEEP=1      node scripts/verify-track-ui.mjs   # 保留临时 Chrome profile（排查用）
 *
 * 覆盖 docs/TRACK_SELECTION_SPEC.md 第 8 节的 9 条验收：
 *   1) Ctrl/⌘ 点击两条轨 → selectedTrackIds.length===2，两行 data-track-selected="true"
 *   2) Shift 点击第 5 条 → 连续 4 条选中
 *   3) 面板从第 1 行主体拖到第 4 行 → 4 条选中，过程中出现 data-track-marquee
 *   4) 面板从轨道列表底部空白向上拖 → 仍有选中（不再完全失效）
 *   5) 编曲视图从最后一条轨以下空白起拖 → 框选出现且选中数 > 0
 *   6) 多选 3 轨点 M → 3 轨 mute，Ctrl+Z 恢复；多选删除 → 一次撤销恢复条数
 *   7) 拖动面板右侧分隔条 → data-track-panel-width 变化 + localStorage 持久化，双击复位 288
 *   8) 1280/1440/1680 三个宽度：轨道行文字无裁切/重叠，名称可用宽度 ≥ 90px，R/M/S 不压名称，
 *      总控行无截断（轨道名省略号允许）
 *   9) 控制台 0 错误；截图存 .verify-track-ui/
 *
 * 产物：.verify-track-ui/*.png + report.json（PASS/FAIL 明细、失败 selector/期望/实际、截图路径）
 *
 * 注意（工作流）：UI 改造尚未落地时，多数行为/选择器断言会 FAIL —— 这是预期。
 * 本脚本先保证「框架能跑通、失败原因可定位」，待 Lead 通知 UI 落地后再跑全量并按失败明细修。
 *
 * 与 scripts/verify-ui.mjs 的分工：verify-ui 管既有界面回归；本脚本管本轮
 * 轨道多选 / 批选 / 框选 / 轨道头排版。不修改 apps/ 下源码。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import {
  ROOT,
  configurePlaceholderProvider,
  launchChrome,
  sleep,
  startStaticServer,
} from './lib/browser-harness.mjs'
import { pickFreePort } from './lib/ports.mjs'

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

const SHOT_DIR = path.join(ROOT, '.verify-track-ui')
const DATA_DIR = path.join(tmpdir(), `aiab-track-ui-${Date.now()}`)
const SKIP_BUILD = process.env.TRACK_SKIP_BUILD === '1' || process.env.UI_SKIP_BUILD === '1'
const ONLY = (process.env.TRACK_ONLY || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
const BASE_WIDTH = 1680
const VIEWPORT_HEIGHT = 1000
const LAYOUT_WIDTHS = [1280, 1440, 1680]

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  gold: '\x1b[33m',
  bold: '\x1b[1m',
}

/* ------------------------------------------------------------------ */
/* PASS / FAIL 收集                                                    */
/* ------------------------------------------------------------------ */

let passed = 0
let failed = 0
/** @type {{name: string, status: 'pass'|'fail', selector?: string, expected?: string, error?: string, shot?: string}[]} */
const checks = []
const failures = []
const screenshots = []
/** @type {any} */
let page = null

function groupEnabled(name) {
  return ONLY.length === 0 || ONLY.includes(name)
}

function ok(message) {
  passed++
  console.log(`  ${C.green}✓${C.reset} ${message}`)
}

function bad(message, error) {
  failed++
  failures.push(`${message}${error ? `: ${error}` : ''}`)
  console.log(`  ${C.red}✗${C.reset} ${message}${error ? `\n      ${C.dim}${error}${C.reset}` : ''}`)
}

function slug(name) {
  return name
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * 跑一个断言项：失败时打印 selector / 期望 / 实际，并尽量留一张失败现场截图。
 * meta: { selector, expected }
 */
async function check(name, meta, fn) {
  const entry = { name, status: 'pass' }
  try {
    await fn(entry)
    passed++
    checks.push({ name, status: 'pass', ...meta, ...entry })
    console.log(`  ${C.green}✓${C.reset} ${name}`)
  } catch (error) {
    failed++
    const message = error?.message ?? String(error)
    checks.push({ name, status: 'fail', ...meta, error: message })
    failures.push(`${name}${meta?.selector ? ` [selector: ${meta.selector}]` : ''}${message ? ` → ${message}` : ''}`)
    console.log(`  ${C.red}✗${C.reset} ${name}`)
    console.log(`      ${C.dim}selector: ${meta?.selector ?? '-'}${C.reset}`)
    if (meta?.expected) console.log(`      ${C.dim}期望: ${meta.expected}${C.reset}`)
    console.log(`      ${C.dim}实际: ${message}${C.reset}`)
    // 失败现场截图（证据留存，便于 Lead 定位）
    if (page) {
      try {
        const file = path.join(SHOT_DIR, `fail-${slug(name)}.png`)
        await page.screenshot(file)
        screenshots.push(file)
        checks[checks.length - 1].shot = file
        console.log(`      ${C.dim}截图: ${file}${C.reset}`)
      } catch {
        /* 截图失败不影响统计 */
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 构建 / 服务                                                         */
/* ------------------------------------------------------------------ */

function run(command, args, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    child.stdout.on('data', (chunk) => {
      log += chunk
      process.stdout.write(`${C.dim}${chunk}${C.reset}`)
    })
    child.stderr.on('data', (chunk) => {
      log += chunk
      process.stderr.write(`${C.dim}${chunk}${C.reset}`)
    })
    child.on('close', (code) => (code === 0 ? resolve(log) : reject(new Error(log || `exit ${code}`))))
  })
}

async function buildIfNeeded() {
  if (SKIP_BUILD) return
  console.log(`${C.dim}构建前端与后端…（TRACK_SKIP_BUILD=1 可跳过）${C.reset}`)
  await run(process.execPath, [path.join(ROOT, 'scripts/build.mjs')])
}

/* ------------------------------------------------------------------ */
/* 页面内注入的调试助手（全部挂在 window.__VT 上，避免每次 eval 重复写） */
/* ------------------------------------------------------------------ */

const PAGE_HELPERS = String.raw`
window.__VT = (function () {
  var INTERACTIVE = 'button, input, select, textarea, a, [role="slider"], [draggable="true"], [role="separator"], [data-activity-meter]'

  function rect(el) {
    if (!el) return null
    var r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
  }
  function overlap(a, b) {
    return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5
  }
  function label(el) {
    if (!el) return '?'
    var text = ''
    try { text = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim() } catch (error) { text = '' }
    return (text || el.tagName || '?').slice(0, 24)
  }
  function panel() { return document.querySelector('[data-track-panel]') }
  function listEl() { return document.querySelector('[data-track-list]') }
  function arrangement() { return document.querySelector('[data-arrangement-view]') }
  function scroller() { return document.querySelector('[data-arrangement-view] [aria-label="编曲时间轴"]') }
  function panelRows() { var p = panel(); return p ? Array.prototype.slice.call(p.querySelectorAll('[data-track-row]')) : [] }
  function row(index) { return panelRows()[index] || null }
  function laneRows() { var a = arrangement(); return a ? Array.prototype.slice.call(a.querySelectorAll('[data-track-row]')) : [] }

  function store() { return window.AIAB.useStore.getState() }
  function uiStore() { return window.AIAB.useUiStore.getState() }
  function modifier() { return /Mac|iPhone|iPad/.test(navigator.platform || '') ? 4 : 2 }
  function selection() {
    var s = store()
    return {
      ids: (s.selectedTrackIds || []).slice(),
      primary: s.selectedTrackId,
      anchor: s.trackSelectionAnchorId,
      trackCount: s.project.tracks.length,
      tracks: s.project.tracks.map(function (t) { return { id: t.id, name: t.name, mute: !!t.mute, solo: !!t.solo } })
    }
  }
  function rowState() {
    return panelRows().map(function (el) {
      return { id: el.dataset.trackId, selected: el.dataset.trackSelected, primary: el.dataset.trackPrimary, index: el.dataset.trackIndex, kind: el.dataset.trackRow }
    })
  }
  function laneRowState() {
    return laneRows().map(function (el) {
      return { id: el.dataset.trackId, selected: el.dataset.trackSelected, primary: el.dataset.trackPrimary, index: el.dataset.trackIndex, kind: el.dataset.trackRow }
    })
  }
  function nameEl(rowEl) {
    if (!rowEl) return null
    var byAttr = rowEl.querySelector('[data-track-name]')
    if (byAttr) return byAttr
    var legacy = rowEl.getAttribute('data-track-name') || ''
    var candidates = Array.prototype.slice.call(rowEl.querySelectorAll('button, span'))
    for (var i = 0; i < candidates.length; i++) {
      if (legacy && (candidates[i].textContent || '').trim() === legacy) return candidates[i]
    }
    return null
  }
  function rmsButtons(rowEl) {
    if (!rowEl) return {}
    return {
      r: rowEl.querySelector('[data-arm]'),
      m: rowEl.querySelector('[data-track-mute]'),
      s: rowEl.querySelector('[data-track-solo]')
    }
  }
  function centerOf(el) { var r = rect(el); return r ? { x: r.cx, y: r.cy } : null }

  var SEARCH_X = [0.18, 0.3, 0.45, 0.6, 0.75, 0.88]
  function pointInRow(rowEl) {
    var r = rect(rowEl)
    if (!r || r.width < 10 || r.height < 8) return null
    for (var yi = 4; yi <= r.height - 5; yi += 4) {
      for (var xi = 0; xi < SEARCH_X.length; xi++) {
        var x = r.left + r.width * SEARCH_X[xi]
        var y = r.top + yi
        if (x < r.left + 2 || x > r.right - 2) continue
        var el = document.elementFromPoint(x, y)
        if (!el || !el.closest) continue
        if (el.closest(INTERACTIVE)) continue
        if (el.closest('[data-track-row]') !== rowEl) continue
        return { x: x, y: y }
      }
    }
    return null
  }
  /** 行内「非交互空白」点：框选必须能在主体上按下（规格 §5：按钮/滑块/draggable 内忽略） */
  function rowBlankPoint(index) { return pointInRow(row(index)) }
  /** 修饰键点击点：优先空白点，退化到名称（名称按钮本身也是行选择入口） */
  function rowClickPoint(index) {
    var rowEl = row(index)
    if (!rowEl) return null
    var blank = pointInRow(rowEl)
    if (blank) return blank
    var name = nameEl(rowEl)
    if (name) {
      var nr = rect(name)
      if (nr && nr.width > 4 && nr.height > 4) return { x: nr.left + Math.min(18, nr.width / 2), y: nr.cy }
    }
    return null
  }
  /** 轨道列表底部空白点（最后一行以下，非交互） */
  function listBlankPoint() {
    var list = listEl()
    if (!list) return null
    list.scrollTop = list.scrollHeight
    var lr = rect(list)
    var rows = panelRows()
    var last = rows.length ? rect(rows[rows.length - 1]) : null
    if (!lr || !last) return null
    var xs = [lr.left + 26, lr.left + lr.width * 0.45, lr.right - 26]
    var yStart = last.bottom + 3
    var yEnd = Math.min(lr.bottom - 2, innerHeight - 2)
    for (var y = yEnd; y > yStart; y -= 4) {
      for (var i = 0; i < xs.length; i++) {
        var x = xs[i]
        if (x < lr.left + 2 || x > lr.right - 2) continue
        var el = document.elementFromPoint(x, y)
        if (!el || !el.closest) continue
        if (el.closest(INTERACTIVE)) continue
        if (!(el === list || list.contains(el))) continue
        if (el.closest('[data-track-row]')) continue
        return { x: x, y: y, lastRowBottom: last.bottom, listBottom: lr.bottom }
      }
    }
    return null
  }
  /** 编曲视图：最后一条车道以下空白 → 车道行（框选起点），返回起止点 */
  function laneDragPoints() {
    var sc = scroller()
    if (!sc) return null
    sc.scrollTop = sc.scrollHeight
    var lanes = laneRows()
    if (lanes.length < 2) return null
    var first = rect(lanes[0])
    var last = rect(lanes[lanes.length - 1])
    var scr = rect(sc)
    if (!first || !last || !scr) return null
    var yMax = Math.min(scr.bottom - 8, innerHeight - 8)
    var yMin = Math.max(scr.top + 6, 6)
    var startY = last.bottom + 20
    if (startY > yMax) startY = yMax
    if (startY < last.bottom + 4) return null
    var startX = Math.max(scr.left + 80, Math.min(scr.right - 40, scr.left + scr.width * 0.66))
    var endX = Math.max(scr.left + 50, startX - Math.max(160, scr.width * 0.28))
    var endY = Math.max(yMin, first.top + Math.min(12, Math.max(3, first.height / 3)))
    return {
      start: { x: startX, y: startY },
      end: { x: endX, y: endY },
      laneCount: lanes.length,
      lastLaneBottom: last.bottom,
      scrollerTop: scr.top,
      scrollerBottom: scr.bottom
    }
  }
  function resetLaneScroll() {
    var sc = scroller()
    if (sc) sc.scrollTop = 0
    var list = listEl()
    if (list) list.scrollTop = 0
    return true
  }
  /** 把应用恢复到「干净的多选测试现场」 */
  function resetState() {
    var s = store()
    if (typeof s.setAllMuted === 'function') s.setAllMuted(false)
    if (typeof s.clearAllSolos === 'function') s.clearAllSolos()
    if (s.project.tracks[0]) {
      if (typeof s.selectTrack === 'function') s.selectTrack(s.project.tracks[0].id, { mode: 'replace' })
      else if (typeof s.selectTrack === 'function') s.selectTrack(s.project.tracks[0].id)
    }
    resetLaneScroll()
    return true
  }
  function selectionCountText() {
    var el = document.querySelector('[data-track-selection-count]')
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : null
  }
  function marqueeCount(scope) {
    var root = scope === 'lane' ? arrangement() : document
    if (!root) return 0
    return root.querySelectorAll('[data-track-marquee]').length
  }
  function marqueeRect(scope) {
    var root = scope === 'lane' ? arrangement() : document
    if (!root) return null
    var el = root.querySelector('[data-track-marquee]')
    return el ? rect(el) : null
  }

  /** 布局审计：返回 violations[]（selector + row + reason），空数组 = 通过 */
  function layoutAudit() {
    var out = { violations: [], rows: 0, master: null, viewport: { width: innerWidth, height: innerHeight }, selectionCount: selectionCountText() }
    var panelEl = panel()
    if (!panelEl) {
      out.violations.push({ selector: '[data-track-panel]', reason: '轨道面板缺失' })
      return out
    }
    var pRect = rect(panelEl)
    var rows = panelRows()
    out.rows = rows.length
    out.metrics = []
    if (rows.length === 0) out.violations.push({ selector: '[data-track-panel] [data-track-row]', reason: '面板里没有轨道行' })

    for (var i = 0; i < rows.length; i++) {
      var rowEl = rows[i]
      var rr = rect(rowEl)
      if (!rr || rr.width < 10 || rr.height < 8) continue
      /* 只审计当前可见的行（滚动出面板的行不参与，避免误判「在视口外」） */
      if (rr.bottom < Math.max(0, pRect.top) - 1 || rr.top > Math.min(innerHeight, pRect.bottom) + 1) continue

      var name = nameEl(rowEl)
      if (!name) {
        out.violations.push({ row: i, selector: '[data-track-panel] [data-track-row] [data-track-name]', reason: '名称元素缺失（无法测量名称可用宽度）' })
      } else {
        var nr = rect(name)
        if (nr && nr.width < 90) {
          out.violations.push({ row: i, selector: '[data-track-name]', reason: '名称可用宽度 ' + nr.width.toFixed(1) + 'px < 90px' })
        }
        var rms = rmsButtons(rowEl)
        var keys = ['r', 'm', 's']
        var missing = keys.filter(function (k) { return !rms[k] })
        if (missing.length > 0) {
          out.violations.push({ row: i, selector: '[data-arm],[data-track-mute],[data-track-solo]', reason: 'R/M/S 按钮缺失: ' + missing.join(',') })
        }
        keys.forEach(function (k) {
          var btn = rms[k]
          if (!btn) return
          var br = rect(btn)
          if (!br || br.width < 12 || br.height < 10) {
            out.violations.push({ row: i, selector: '[data-arm],[data-track-mute],[data-track-solo]', reason: k.toUpperCase() + ' 按钮过小 (' + (br ? br.width.toFixed(1) + 'x' + br.height.toFixed(1) : '不可见') + ')' })
            return
          }
          if (br.left < rr.left - 1 || br.right > rr.right + 1 || br.top < rr.top - 1 || br.bottom > rr.bottom + 1) {
            out.violations.push({ row: i, selector: '[data-arm],[data-track-mute],[data-track-solo]', reason: k.toUpperCase() + ' 按钮溢出轨道行' })
          }
          if (nr && overlap(br, nr)) {
            out.violations.push({ row: i, selector: '[data-track-name]', reason: '名称与 ' + k.toUpperCase() + ' 按钮重叠' })
          }
        })
      }

      /* 行内可见控件两两不重叠（绝对定位的色条/电平已从候选里排除） */
      var boxes = []
      var controls = Array.prototype.slice.call(rowEl.querySelectorAll('button, [role="slider"], [data-track-name], [data-creative-line]'))
      controls.forEach(function (el) {
        var b = rect(el)
        if (!b || b.width < 2 || b.height < 2) return
        if (b.bottom < rr.top + 1 || b.top > rr.bottom - 1) return
        boxes.push({ el: el, box: b, label: label(el) })
      })
      for (var a = 0; a < boxes.length; a++) {
        for (var bIdx = a + 1; bIdx < boxes.length; bIdx++) {
          var A = boxes[a]
          var B = boxes[bIdx]
          if (A.el.contains(B.el) || B.el.contains(A.el)) continue
          if (overlap(A.box, B.box)) {
            out.violations.push({ row: i, selector: '轨道行内控件', reason: '「' + A.label + '」与「' + B.label + '」重叠' })
          }
        }
      }

      /* 文本裁切：显式 truncate（省略号）允许；其余 leaf 文本不得 scrollWidth > clientWidth */
      var textEls = Array.prototype.slice.call(rowEl.querySelectorAll('span, div'))
      textEls.forEach(function (el) {
        if (el.children && el.children.length > 0) return
        var text = (el.textContent || '').trim()
        if (!text) return
        var b = rect(el)
        if (!b || b.width < 2 || b.height < 2) return
        if (b.bottom < rr.top + 1 || b.top > rr.bottom - 1) return
        var style = getComputedStyle(el)
        var className = typeof el.className === 'string' ? el.className : ''
        var ellipsis = className.indexOf('truncate') >= 0 || style.textOverflow === 'ellipsis'
        if (ellipsis) return
        if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2) {
          out.violations.push({ row: i, selector: '轨道行文本', reason: '文本被裁切「' + text.slice(0, 16) + '」 scrollWidth=' + el.scrollWidth + ' > clientWidth=' + el.clientWidth })
        }
      })

      /* 量化指标：给 report.json / TRACK_VERBOSE 留证据，避免「断言通过但没测到东西」 */
      var metricName = nameEl(rowEl)
      var metricRms = rmsButtons(rowEl)
      out.metrics.push({
        row: i,
        height: Math.round(rr.height),
        nameWidth: metricName ? Number(rect(metricName).width.toFixed(1)) : null,
        nameToMuteGap: metricName && metricRms.m ? Number((rect(metricRms.m).left - rect(metricName).right).toFixed(1)) : null,
        rmsVisible: ['r', 'm', 's'].filter(function (k) { return metricRms[k] && rect(metricRms[k]).width >= 12 }).length
      })
    }

    /* 总控行：无截断（轨道名省略号允许，但总控行自身文字/按钮不得被裁） */
    var master = document.querySelector('[data-track-master-row]')
    if (!master) {
      out.violations.push({ selector: '[data-track-master-row]', reason: '总控行缺失' })
    } else {
      var mr = rect(master)
      out.master = { width: mr ? mr.width : 0, text: (master.innerText || '').replace(/\s+/g, ' ').slice(0, 140) }
      var masterButtons = Array.prototype.slice.call(master.querySelectorAll('button'))
      masterButtons.forEach(function (el) {
        var b = rect(el)
        if (!b || b.width < 10 || b.height < 8) return
        if (mr && (b.left < mr.left - 1 || b.right > mr.right + 1)) {
          out.violations.push({ selector: '[data-track-master-row] button', reason: '总控按钮溢出/被裁切「' + label(el) + '」' })
        }
        if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2) {
          out.violations.push({ selector: '[data-track-master-row] button', reason: '总控按钮文字被裁切「' + label(el) + '」' })
        }
      })
      var masterTextEls = Array.prototype.slice.call(master.querySelectorAll('span, div'))
      masterTextEls.forEach(function (el) {
        if (el.children && el.children.length > 0) return
        var text = (el.textContent || '').trim()
        if (!text) return
        var b = rect(el)
        if (!b || b.width < 2 || b.height < 2) return
        var style = getComputedStyle(el)
        var className = typeof el.className === 'string' ? el.className : ''
        var ellipsis = className.indexOf('truncate') >= 0 || style.textOverflow === 'ellipsis'
        if (ellipsis) return
        if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2) {
          out.violations.push({ selector: '[data-track-master-row] 文本', reason: '总控行文字被裁切「' + text.slice(0, 16) + '」' })
        }
      })
      var masterText = master.innerText || ''
      if (!/BPM|♩/.test(masterText)) {
        out.violations.push({ selector: '[data-track-master-row]', reason: '总控行缺少项目级 BPM 信息（规格 §5：风格 · 调号 · BPM 上移）' })
      }
    }

    var countEl = document.querySelector('[data-track-selection-count]')
    if (!countEl) out.violations.push({ selector: '[data-track-selection-count]', reason: '已选数量徽标缺失' })
    else if (!(countEl.textContent || '').trim()) out.violations.push({ selector: '[data-track-selection-count]', reason: '已选数量徽标无文本' })

    return out
  }

  return {
    rect: rect,
    overlap: overlap,
    label: label,
    panel: panel,
    listEl: listEl,
    arrangement: arrangement,
    scroller: scroller,
    panelRows: panelRows,
    row: row,
    laneRows: laneRows,
    store: store,
    uiStore: uiStore,
    modifier: modifier,
    selection: selection,
    rowState: rowState,
    laneRowState: laneRowState,
    nameEl: nameEl,
    rmsButtons: rmsButtons,
    centerOf: centerOf,
    rowBlankPoint: rowBlankPoint,
    rowClickPoint: rowClickPoint,
    listBlankPoint: listBlankPoint,
    laneDragPoints: laneDragPoints,
    resetLaneScroll: resetLaneScroll,
    resetState: resetState,
    selectionCountText: selectionCountText,
    marqueeCount: marqueeCount,
    marqueeRect: marqueeRect,
    layoutAudit: layoutAudit
  }
})()
return true
`

/* ------------------------------------------------------------------ */
/* 鼠标 / 键盘（CDP 真实事件）                                          */
/* ------------------------------------------------------------------ */

async function mouseEvent(type, x, y, options = {}) {
  await page.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: options.button ?? 'none',
    buttons: options.buttons ?? 0,
    clickCount: options.clickCount ?? 0,
    modifiers: options.modifiers ?? 0,
  })
}

async function mouseMove(x, y, options = {}) {
  await mouseEvent('mouseMoved', x, y, {
    button: options.held ? 'left' : 'none',
    buttons: options.held ? 1 : 0,
    modifiers: options.modifiers ?? 0,
  })
  await sleep(options.delay ?? 28)
}

async function mousePress(x, y, options = {}) {
  await mouseEvent('mousePressed', x, y, {
    button: 'left',
    buttons: 1,
    clickCount: options.clickCount ?? 1,
    modifiers: options.modifiers ?? 0,
  })
  await sleep(options.delay ?? 35)
}

async function mouseRelease(x, y, options = {}) {
  await mouseEvent('mouseReleased', x, y, {
    button: 'left',
    buttons: 0,
    clickCount: options.clickCount ?? 1,
    modifiers: options.modifiers ?? 0,
  })
  await sleep(options.delay ?? 70)
}

async function clickAt(x, y, modifiers = 0) {
  await mouseMove(x, y)
  await mousePress(x, y, { modifiers })
  await mouseRelease(x, y, { modifiers })
  await sleep(150)
}

async function doubleClickAt(x, y) {
  await mouseMove(x, y)
  await mousePress(x, y)
  await mouseRelease(x, y)
  await sleep(45)
  await mousePress(x, y, { clickCount: 2 })
  await mouseRelease(x, y, { clickCount: 2 })
  await sleep(220)
}

/**
 * 按下 → 分步移动（每步可回调观察）→ 释放。释放放在 finally，避免断言抛错后鼠标卡在按下状态。
 * @returns {Promise<any[]>} 每次 mid 回调的返回值
 */
async function dragTo(x1, y1, x2, y2, options = {}) {
  const steps = options.steps ?? 8
  const mid = options.mid ?? null
  const modifiers = options.modifiers ?? 0
  await mouseMove(x1, y1)
  await mousePress(x1, y1, { modifiers })
  const observations = []
  try {
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps
      const x = x1 + (x2 - x1) * t
      const y = y1 + (y2 - y1) * t
      await mouseMove(x, y, { held: true, modifiers })
      await sleep(40)
      if (mid) observations.push(await mid({ x, y, step, steps }))
    }
  } finally {
    await mouseRelease(x2, y2, { modifiers })
    await sleep(240)
  }
  return observations
}

/* ------------------------------------------------------------------ */
/* 页面状态读取                                                        */
/* ------------------------------------------------------------------ */

async function readSelection() {
  return page.evaluate('return window.__VT.selection()')
}

async function readRows() {
  return page.evaluate('return window.__VT.rowState()')
}

async function readLaneRows() {
  return page.evaluate('return window.__VT.laneRowState()')
}

async function readPanelWidth() {
  return page.evaluate(`
    const panel = document.querySelector('[data-track-panel]')
    const ui = window.AIAB.useUiStore.getState()
    let persisted = null
    try {
      const raw = localStorage.getItem('aiab:ui-prefs:v1')
      persisted = raw ? JSON.parse(raw).state.trackPanelWidth : null
    } catch (error) { persisted = null }
    return {
      dataset: panel ? Number(panel.dataset.trackPanelWidth) : null,
      ui: ui.trackPanelWidth,
      persisted,
      panelRect: panel ? window.__VT.rect(panel) : null,
    }
  `)
}

async function ensureArrangementView() {
  await page.evaluate(`
    const store = window.AIAB.useStore.getState()
    if (store.view !== 'arrangement') store.setView('arrangement')
    store.setShowMixer(false)
    store.setChatOpen(false)
    return true
  `)
  await page.waitFor('document.querySelector("[data-arrangement-view] [data-track-row]")', 15000)
  await sleep(200)
}

async function resetState() {
  await page.evaluate('return window.__VT.resetState()')
  await sleep(220)
}

async function takeShot(name) {
  const file = path.join(SHOT_DIR, name)
  await page.screenshot(file)
  screenshots.push(file)
  return file
}

/* ------------------------------------------------------------------ */
/* 验收：选择器 / 数据属性契约                                         */
/* ------------------------------------------------------------------ */

async function runContractChecks() {
  console.log(`\n${C.bold}选择器契约（docs/TRACK_SELECTION_SPEC.md §4）${C.reset}`)

  await check(
    '契约：轨道面板 / 列表 / 分隔条 / data-track-panel-width 齐全',
    {
      selector: '[data-track-panel] [data-track-list] [data-track-panel-splitter] [data-track-panel-width]',
      expected: '面板带 data-track-panel-width、列表带 data-track-list、右侧分隔条 role=separator',
    },
    async () => {
      const info = await page.evaluate(`
        const panel = document.querySelector('[data-track-panel]')
        const list = document.querySelector('[data-track-list]')
        const splitter = document.querySelector('[data-track-panel-splitter]')
        let persisted = null
        try {
          const raw = localStorage.getItem('aiab:ui-prefs:v1')
          persisted = raw ? JSON.parse(raw).state.trackPanelWidth : null
        } catch (error) { persisted = null }
        return {
          panel: !!panel,
          widthAttr: panel ? panel.dataset.trackPanelWidth : null,
          list: !!list,
          splitter: !!splitter,
          splitterRole: splitter ? splitter.getAttribute('role') : null,
          splitterCursor: splitter ? getComputedStyle(splitter).cursor : null,
          splitterWidth: splitter ? window.__VT.rect(splitter).width : 0,
          persisted,
        }
      `)
      const missing = []
      if (!info.panel) missing.push('[data-track-panel]')
      if (!info.list) missing.push('[data-track-list]')
      if (!info.splitter) missing.push('[data-track-panel-splitter]')
      if (!info.widthAttr) missing.push('[data-track-panel-width]')
      assert(missing.length === 0, `缺少选择器：${missing.join(' / ')}`)
      assert(Number(info.widthAttr) >= 240, `data-track-panel-width=${info.widthAttr} 不是合法像素宽度`)
      /* 全新 profile（无 localStorage）时必须是默认 288（规格 §3） */
      if (info.persisted == null) {
        assert(Number(info.widthAttr) === 288, `默认面板宽=${info.widthAttr}（期望 288）`)
      }
      assert(info.splitterRole === 'separator', `分隔条 role=${info.splitterRole}（期望 separator）`)
      assert(info.splitterCursor === 'col-resize', `分隔条 cursor=${info.splitterCursor}（期望 col-resize）`)
    },
  )

  await check(
    '契约：面板 / 车道轨道行带 data-track-row + id/index/selected/primary',
    {
      selector: '[data-track-panel] [data-track-row], [data-arrangement-view] [data-track-row]',
      expected: 'data-track-row="panel"/"lane"，且每行有 data-track-id / data-track-index / data-track-selected / data-track-primary',
    },
    async () => {
      const info = await page.evaluate(`
        const panel = document.querySelector('[data-track-panel]')
        const lane = document.querySelector('[data-arrangement-view]')
        const pick = (root) => root ? Array.prototype.slice.call(root.querySelectorAll('[data-track-row]')) : []
        const describe = (rows) => rows.slice(0, 2).map((el) => ({
          kind: el.dataset.trackRow,
          id: el.dataset.trackId,
          index: el.dataset.trackIndex,
          selected: el.dataset.trackSelected,
          primary: el.dataset.trackPrimary,
        }))
        const panelRows = pick(panel)
        const laneRows = pick(lane)
        return {
          panelCount: panelRows.length,
          laneCount: laneRows.length,
          panelSample: describe(panelRows),
          laneSample: describe(laneRows),
          selectionCount: !!document.querySelector('[data-track-selection-count]'),
          selectionCountText: window.__VT.selectionCountText(),
        }
      `)
      assert(info.panelCount > 0, '轨道面板里没有 [data-track-row]')
      assert(info.laneCount > 0, '编曲视图里没有 [data-track-row]')
      const first = info.panelSample[0] ?? {}
      assert(first.kind === 'panel', `面板行 data-track-row="${first.kind}"（期望 "panel"）`)
      assert(Boolean(first.id), '面板行缺少 data-track-id')
      assert(first.index !== undefined && first.index !== null && first.index !== '', '面板行缺少 data-track-index')
      assert(first.selected === 'true' || first.selected === 'false', `面板行 data-track-selected="${first.selected}"（期望 true/false）`)
      assert(first.primary === 'true' || first.primary === 'false', `面板行 data-track-primary="${first.primary}"（期望 true/false）`)
      const firstLane = info.laneSample[0] ?? {}
      assert(firstLane.kind === 'lane', `车道行 data-track-row="${firstLane.kind}"（期望 "lane"）`)
      assert(Boolean(firstLane.id), '车道行缺少 data-track-id')
      assert(firstLane.selected === 'true' || firstLane.selected === 'false', `车道行 data-track-selected="${firstLane.selected}"（期望 true/false）`)
      assert(firstLane.primary === 'true' || firstLane.primary === 'false', `车道行 data-track-primary="${firstLane.primary}"（期望 true/false）`)
      assert(info.selectionCount, '缺少已选数量徽标 [data-track-selection-count]')
      assert(Boolean(info.selectionCountText), '[data-track-selection-count] 没有文本')
    },
  )
}

/* ------------------------------------------------------------------ */
/* 验收 1 / 2：修饰键多选                                              */
/* ------------------------------------------------------------------ */

async function runSelectChecks() {
  if (!groupEnabled('select')) return
  console.log(`\n${C.bold}多选：Ctrl/⌘ 切换 + Shift 连选${C.reset}`)
  await ensureArrangementView()
  await resetState()

  await check(
    '多选：Ctrl/⌘ 点击两条轨 → selectedTrackIds.length===2 且两行 data-track-selected="true"',
    {
      selector: '[data-track-panel] [data-track-row] + [data-track-mute] + store.selectedTrackIds',
      expected: 'selectedTrackIds.length===2，前两行 data-track-selected="true"，主轨为最后点击的轨道',
    },
    async (entry) => {
      const mod = await page.evaluate('return window.__VT.modifier()')
      const p0 = await page.evaluate('return window.__VT.rowClickPoint(0)')
      const p1 = await page.evaluate('return window.__VT.rowClickPoint(1)')
      assert(p0 && p1, '找不到轨道行的可点击点（rowClickPoint 返回 null）')
      await clickAt(p0.x, p0.y) // 普通点击 = replace
      await clickAt(p1.x, p1.y, mod) // Ctrl/⌘ = toggle
      await takeShot('track-multi-select.png')
      const state = await readSelection()
      const rows = await readRows()
      assert(state.ids.length === 2, `selectedTrackIds.length=${state.ids.length}（期望 2：${state.ids.join(',')}）`)
      assert(state.tracks.length >= 2, `工程轨道数 ${state.tracks.length} < 2，无法测试多选`)
      assert(rows.length >= 2, `面板行数 ${rows.length} < 2`)
      assert(rows[0].selected === 'true', `第 1 行 data-track-selected="${rows[0].selected}"（期望 "true"）`)
      assert(rows[1].selected === 'true', `第 2 行 data-track-selected="${rows[1].selected}"（期望 "true"）`)
      assert(rows[2]?.selected === 'false', `第 3 行 data-track-selected="${rows[2]?.selected}"（期望 "false"，Ctrl 点击不应连带选中）`)
      assert(state.primary === state.tracks[1].id, `主轨=${state.primary}（期望最后 Ctrl 点击的第 2 条 ${state.tracks[1].id}）`)
      entry.selector = '[data-track-panel] [data-track-row]'
    },
  )

  await check(
    '多选：表头已选数量徽标跟随多选（data-track-selection-count）',
    { selector: '[data-track-selection-count]', expected: '选中 2 轨时徽标文本含 "2"' },
    async () => {
      const text = await page.evaluate('return window.__VT.selectionCountText()')
      assert(text !== null, '[data-track-selection-count] 缺失')
      assert(/2/.test(text), `徽标文本「${text}」不含 2（期望反映 2 条已选）`)
    },
  )

  await check(
    '多选：Shift 点击第 5 条 → 连续 4 条选中',
    { selector: '[data-track-panel] [data-track-row]', expected: 'anchor=第 2 条，Shift 点第 5 条 → 第 2..5 行 4 条 data-track-selected="true"（第 1 行 false）' },
    async () => {
      const p1 = await page.evaluate('return window.__VT.rowClickPoint(1)')
      const p4 = await page.evaluate('return window.__VT.rowClickPoint(4)')
      assert(p1 && p4, '找不到轨道行点击点（轨道数不足 5 或行不可见）')
      await clickAt(p1.x, p1.y) // 普通点击第 2 条 = anchor
      await clickAt(p4.x, p4.y, 8) // Shift = range
      const state = await readSelection()
      const rows = await readRows()
      assert(state.tracks.length >= 5, `工程轨道数 ${state.tracks.length} < 5，无法测试 Shift 连选第 5 条`)
      assert(state.ids.length === 4, `selectedTrackIds.length=${state.ids.length}（期望 4）`)
      const expectIds = state.tracks.slice(1, 5).map((track) => track.id)
      assert(
        expectIds.every((id) => state.ids.includes(id)),
        `选中集合 [${state.ids.join(',')}] 不是第 2..5 条 [${expectIds.join(',')}]`,
      )
      for (let index = 1; index <= 4; index += 1) {
        assert(rows[index]?.selected === 'true', `第 ${index + 1} 行 data-track-selected="${rows[index]?.selected}"（期望 "true"）`)
      }
      assert(rows[0]?.selected === 'false', `第 1 行 data-track-selected="${rows[0]?.selected}"（期望 "false"）`)
      assert(state.anchor === state.tracks[1].id, `Shift 连选后 anchor=${state.anchor}（期望第 2 条 ${state.tracks[1].id}）`)
    },
  )
}

/* ------------------------------------------------------------------ */
/* 验收 3 / 4：轨道面板框选                                            */
/* ------------------------------------------------------------------ */

async function marqueeObserver(scope, options = {}) {
  let shotTaken = false
  const seen = { count: 0, rect: null, shot: null }
  const shotStep = options.shotStep ?? 6
  return {
    seen,
    async mid(progress = {}) {
      const info = await page.evaluate(`
        return { count: window.__VT.marqueeCount('${scope}'), rect: window.__VT.marqueeRect('${scope}') }
      `)
      if (info.count > 0) {
        seen.count = Math.max(seen.count, info.count)
        seen.rect = info.rect ?? seen.rect
        /* 截图放在拖动后段：矩形已经足够大，能直观看出「框住了哪几条轨」 */
        if (!shotTaken && options.shotName && progress.step >= shotStep) {
          shotTaken = true
          seen.shot = await takeShot(options.shotName)
        }
      }
      return info
    },
  }
}

async function runPanelMarqueeChecks() {
  if (!groupEnabled('panelmarquee')) return
  console.log(`\n${C.bold}轨道面板框选（含列表底部空白）${C.reset}`)
  await ensureArrangementView()
  await resetState()

  await check(
    '面板框选：第 1 行主体拖到第 4 行 → 4 条选中，过程中出现 data-track-marquee',
    {
      selector: '[data-track-list] [data-track-marquee]',
      expected: '拖动中出现 [data-track-marquee]；释放后 selectedTrackIds.length===4 且第 1..4 行 data-track-selected="true"',
    },
    async () => {
      const start = await page.evaluate('return window.__VT.rowBlankPoint(0)')
      const geometry = await page.evaluate(`
        const top = window.__VT.rect(window.__VT.row(0))
        const bottom = window.__VT.rect(window.__VT.row(3))
        const list = window.__VT.rect(window.__VT.listEl())
        return top && bottom ? { firstRow: top, fourthRow: bottom, list: list } : null
      `)
      assert(start, '第 1 行找不到「非交互空白点」（按钮/滑块/draggable 之外的主体区域）')
      assert(geometry, '第 4 行不可见（轨道数不足或列表未滚动到顶）')
      const observer = await marqueeObserver('panel', { shotName: 'track-marquee.png', shotStep: 7 })
      await dragTo(start.x, start.y, start.x, geometry.fourthRow.cy, { steps: 9, mid: (progress) => observer.mid(progress) })
      const state = await readSelection()
      const rows = await readRows()
      assert(observer.seen.count > 0, '拖动过程中未出现 [data-track-marquee]（框选覆盖层缺失）')
      const band = observer.seen.rect
      assert(band && band.width > 4, `[data-track-marquee] 尺寸异常（${band ? `${band.width.toFixed(1)}x${band.height.toFixed(1)}` : '无 rect'}）`)
      /* 覆盖层几何：必须真的盖住拖选区间（起点行 ~ 终点行），而不只是「元素存在」 */
      assert(band.height >= 40, `[data-track-marquee] 高度仅 ${band.height.toFixed(1)}px（拖过 3 行时应覆盖整个区间）`)
      assert(band.top >= geometry.firstRow.top - 8, `[data-track-marquee] 顶部 ${band.top.toFixed(1)} 高于第 1 行顶部 ${geometry.firstRow.top.toFixed(1)}（覆盖层相对列表视口错位）`)
      assert(band.bottom <= geometry.fourthRow.bottom + 8, `[data-track-marquee] 底部 ${band.bottom.toFixed(1)} 超出第 4 行底部 ${geometry.fourthRow.bottom.toFixed(1)}（覆盖层比拖选区间更长）`)
      assert(band.top <= geometry.firstRow.bottom && band.bottom >= geometry.fourthRow.top, '[data-track-marquee] 没有覆盖到第 4 行（框选区间与覆盖层不一致）')
      assert(state.ids.length === 4, `拖选后 selectedTrackIds.length=${state.ids.length}（期望 4）`)
      for (let index = 0; index < 4; index += 1) {
        assert(rows[index]?.selected === 'true', `第 ${index + 1} 行 data-track-selected="${rows[index]?.selected}"（期望 "true"）`)
      }
    },
  )

  await check(
    '面板框选：从轨道列表底部空白按下向上拖 → 仍有选中（不再完全失效）',
    {
      selector: '[data-track-list] 底部空白 + [data-track-marquee]',
      expected: '起点在最后一条轨道行以下的列表空白处，向上拖后 selectedTrackIds.length>0 且拖动中出现 [data-track-marquee]',
    },
    async () => {
      await resetState()
      const start = await page.evaluate('return window.__VT.listBlankPoint()')
      const target = await page.evaluate(`
        const row = window.__VT.row(2)
        return row ? window.__VT.rect(row).cy : null
      `)
      assert(start, '找不到轨道列表底部空白起点（最后一行以下、列表容器内、非交互）')
      assert(target !== null, '第 3 行不可见，无法向上拖')
      const observer = await marqueeObserver('panel')
      await dragTo(start.x, start.y, start.x, target, { steps: 9, mid: () => observer.mid() })
      const state = await readSelection()
      assert(observer.seen.count > 0, '从列表底部空白拖动时未出现 [data-track-marquee]（规格 §5：任意起点都能量选）')
      assert(state.ids.length > 0, '从列表底部空白向上拖之后 selectedTrackIds 为空（拖选完全失效）')
    },
  )
}

/* ------------------------------------------------------------------ */
/* 验收 6：批量操作 + 一次撤销                                          */
/* ------------------------------------------------------------------ */

async function selectThreeTracks(mod) {
  const points = []
  for (let index = 0; index < 3; index += 1) {
    const point = await page.evaluate(`return window.__VT.rowClickPoint(${index})`)
    assert(point, `找不到第 ${index + 1} 行的可点击点`)
    points.push(point)
  }
  await clickAt(points[0].x, points[0].y)
  await clickAt(points[1].x, points[1].y, mod)
  await clickAt(points[2].x, points[2].y, mod)
  const state = await readSelection()
  assert(state.ids.length === 3, `Ctrl/⌘ 选择 3 条失败：selectedTrackIds.length=${state.ids.length}（期望 3）`)
  return state
}

async function runBatchChecks() {
  if (!groupEnabled('batch')) return
  console.log(`\n${C.bold}批量操作：多选 M / 多选删除 + 一次撤销${C.reset}`)
  await ensureArrangementView()

  await check(
    '批量操作：多选 3 轨点 M → 3 轨静音，Ctrl+Z 一次恢复',
    {
      selector: '[data-track-panel] [data-track-row] [data-track-mute] + Ctrl+Z',
      expected: '点某选中行的 M → 3 条选中轨 mute=true（其余不变）；Ctrl+Z 后恢复为 0 条静音',
    },
    async () => {
      const mod = await page.evaluate('return window.__VT.modifier()')
      await resetState()
      const before = await selectThreeTracks(mod)
      const mutePoint = await page.evaluate(`
        const rows = window.__VT.panelRows()
        const target = rows[1] && rows[1].querySelector('[data-track-mute]')
        return target ? window.__VT.centerOf(target) : null
      `)
      assert(mutePoint, '第 2 行找不到 M 按钮 [data-track-mute]')
      await clickAt(mutePoint.x, mutePoint.y)
      await sleep(320)
      const after = await readSelection()
      const selectedSet = new Set(before.ids)
      const mutedSelected = after.tracks.filter((track) => selectedSet.has(track.id) && track.mute).length
      const mutedTotal = after.tracks.filter((track) => track.mute).length
      assert(mutedSelected === 3, `点 M 后选中轨静音数=${mutedSelected}（期望 3；多选 M 必须作用于整个选中集合）`)
      assert(mutedTotal === 3, `全工程静音数=${mutedTotal}（期望 3，不应误伤未选中轨）`)
      await page.pressKey('z', { code: 'KeyZ', modifiers: mod })
      await sleep(420)
      const undone = await readSelection()
      const mutedAfterUndo = undone.tracks.filter((track) => track.mute).length
      assert(mutedAfterUndo === 0, `Ctrl+Z 后仍有 ${mutedAfterUndo} 条静音（期望 0：批量 M 必须是一个撤销点）`)
    },
  )

  await check(
    '批量操作：多选删除 → 一次撤销恢复条数',
    {
      selector: '[data-track-panel] 删除按钮（删除选中轨道） + Ctrl+Z',
      expected: '多选 3 条删除后轨道数 -3；Ctrl+Z 一次恢复原轨道数',
    },
    async () => {
      const mod = await page.evaluate('return window.__VT.modifier()')
      await resetState()
      const before = await selectThreeTracks(mod)
      const deletePoint = await page.evaluate(`
        const buttons = Array.prototype.slice.call(document.querySelectorAll('[data-track-panel] button'))
        const labelOf = (el) => ((el.getAttribute('title') || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.textContent || ''))
        const target = buttons.find((el) => /删除/.test(labelOf(el)) && !el.disabled)
        return target ? window.__VT.centerOf(target) : null
      `)
      assert(deletePoint, '轨道面板表头找不到可用的「删除选中轨道」按钮')
      await clickAt(deletePoint.x, deletePoint.y)
      await sleep(360)
      const after = await readSelection()
      assert(
        after.trackCount === before.trackCount - 3,
        `多选删除后轨道数=${after.trackCount}（期望 ${before.trackCount - 3}，一次删除整个选中集合）`,
      )
      assert(after.ids.length > 0, '删除后 selectedTrackIds 为空（应回退到剩余轨道）')
      const alive = new Set(after.tracks.map((track) => track.id))
      assert(after.ids.every((id) => alive.has(id)), '删除后 selectedTrackIds 里残留了已不存在的轨道 id')
      await page.pressKey('z', { code: 'KeyZ', modifiers: mod })
      await sleep(480)
      const undone = await readSelection()
      assert(
        undone.trackCount === before.trackCount,
        `Ctrl+Z 后轨道数=${undone.trackCount}（期望 ${before.trackCount}：批量删除必须是一个撤销点）`,
      )
    },
  )
}

/* ------------------------------------------------------------------ */
/* 验收 7：面板宽度拖拽 / 持久化 / 双击复位                            */
/* ------------------------------------------------------------------ */

async function runSplitterChecks() {
  if (!groupEnabled('splitter')) return
  console.log(`\n${C.bold}轨道面板宽度：拖拽 / 持久化 / 双击复位${C.reset}`)
  await ensureArrangementView()
  await page.evaluate('window.AIAB.useUiStore.getState().setTrackPanelWidth(288); return true')
  await sleep(280)

  await check(
    '面板宽度：拖动分隔条 → data-track-panel-width 变化并写入 localStorage',
    {
      selector: '[data-track-panel-splitter] + [data-track-panel][data-track-panel-width] + localStorage["aiab:ui-prefs:v1"]',
      expected: '拖动 +64px 后 data-track-panel-width > 288，等于 uiStore.trackPanelWidth，且 localStorage 持久化同值',
    },
    async () => {
      const splitter = await page.evaluate(`
        const el = document.querySelector('[data-track-panel-splitter]')
        if (!el) return null
        const r = window.__VT.rect(el)
        return { center: window.__VT.centerOf(el), role: el.getAttribute('role'), cursor: getComputedStyle(el).cursor, width: r.width }
      `)
      assert(splitter, '未找到 [data-track-panel-splitter]（规格 §4/§5）')
      assert(splitter.width >= 3 && splitter.width <= 10, `分隔条宽度=${splitter.width}px（期望约 4px 细拖拽条）`)
      const before = await readPanelWidth()
      assert(Number(before.dataset) === 288 || before.ui === 288, `复位后面板宽度=${before.ui}（期望 288）`)
      await dragTo(splitter.center.x, splitter.center.y, splitter.center.x + 64, splitter.center.y, { steps: 6 })
      await sleep(320)
      const after = await readPanelWidth()
      assert(Number(after.dataset) > 288, `拖动后 data-track-panel-width=${after.dataset}（期望 >288）`)
      assert(after.ui === Number(after.dataset), `uiStore.trackPanelWidth=${after.ui} 与 data-track-panel-width=${after.dataset} 不一致`)
      assert(after.persisted === Number(after.dataset), `localStorage 持久化值=${after.persisted}（期望 ${after.dataset}）`)
      assert(after.panelRect && after.panelRect.width > 288, `面板实际宽度=${after.panelRect?.width}（期望 >288）`)
      await takeShot('track-panel-wide.png')
    },
  )

  await check(
    '面板宽度：双击分隔条复位 288',
    {
      selector: '[data-track-panel-splitter] 双击',
      expected: '双击后 uiStore / data-track-panel-width / localStorage 全部回到 288',
    },
    async () => {
      const center = await page.evaluate('return window.__VT.centerOf(document.querySelector("[data-track-panel-splitter]"))')
      assert(center, '未找到 [data-track-panel-splitter]，无法双击复位')
      await doubleClickAt(center.x, center.y)
      await sleep(320)
      const info = await readPanelWidth()
      assert(info.ui === 288, `双击后 uiStore.trackPanelWidth=${info.ui}（期望 288）`)
      assert(Number(info.dataset) === 288, `双击后 data-track-panel-width=${info.dataset}（期望 288）`)
      assert(info.persisted === 288, `双击后 localStorage=${info.persisted}（期望 288）`)
    },
  )
}

/* ------------------------------------------------------------------ */
/* 验收 5：编曲视图框选（最后一条轨以下空白起拖）                      */
/* ------------------------------------------------------------------ */

async function runLaneMarqueeCheck() {
  if (!groupEnabled('lane')) return
  console.log(`\n${C.bold}编曲视图框选（最后一条轨以下空白起拖）${C.reset}`)
  await ensureArrangementView()
  await resetState()

  await check(
    '编曲视图：从最后一条轨以下空白起拖 → 出现框选且选中数 > 0',
    {
      selector: '[data-arrangement-view] [data-track-marquee] + [data-arrangement-view] [data-track-row][data-track-selected]',
      expected: '拖动中出现 [data-track-marquee]；释放后 selectedTrackIds.length>0 且至少一条车道 data-track-selected="true"',
    },
    async () => {
      const points = await page.evaluate('return window.__VT.laneDragPoints()')
      assert(points, '找不到编曲视图「最后一条车道以下空白」起点（车道不足或没有底部留白）')
      const laneGeometry = await page.evaluate(`
        const lanes = window.__VT.laneRows()
        return lanes.length > 0 ? { first: window.__VT.rect(lanes[0]), last: window.__VT.rect(lanes[lanes.length - 1]) } : null
      `)
      const observer = await marqueeObserver('lane', { shotName: 'lane-marquee.png', shotStep: 7 })
      await dragTo(points.start.x, points.start.y, points.end.x, points.end.y, { steps: 10, mid: (progress) => observer.mid(progress) })
      await takeShot('lane-multi-select.png')
      const state = await readSelection()
      const lanes = await readLaneRows()
      await page.evaluate('window.__VT.resetLaneScroll(); return true')
      assert(observer.seen.count > 0, '编曲视图拖动过程中未出现 [data-track-marquee]（框选覆盖层缺失）')
      const band = observer.seen.rect
      assert(band && band.height >= 40 && band.width >= 40, `[data-arrangement-view] [data-track-marquee] 尺寸异常（${band ? `${band.width.toFixed(1)}x${band.height.toFixed(1)}` : '无 rect'}）`)
      if (laneGeometry) {
        const overlapsLane = band.bottom > laneGeometry.first.top + 2 && band.top < laneGeometry.last.bottom - 2
        assert(overlapsLane, '[data-arrangement-view] [data-track-marquee] 没有覆盖任何车道行（矩形与车道区域不相交）')
      }
      assert(state.ids.length > 0, `编曲视图框选后 selectedTrackIds.length=0（车道框选未生效；起拖点应在最后一条轨以下空白）`)
      const selectedLanes = lanes.filter((item) => item.selected === 'true').length
      assert(selectedLanes > 0, `车道行没有 data-track-selected="true"（选中 ${state.ids.length} 条轨道但车道未高亮）`)
    },
  )
}

/* ------------------------------------------------------------------ */
/* 验收 8：三宽度布局断言                                              */
/* ------------------------------------------------------------------ */

async function runLayoutChecks() {
  if (!groupEnabled('layout')) return
  console.log(`\n${C.bold}布局断言：1280 / 1440 / 1680${C.reset}`)
  for (const width of LAYOUT_WIDTHS) {
    await check(
      `布局 ${width}：轨道行文字无裁切/重叠，名称可用宽度≥90px，R/M/S 不压名称，总控行无截断`,
      {
        selector: '[data-track-panel] [data-track-row] / [data-track-name] / [data-track-master-row]',
        expected: '每行名称宽≥90px、名称与 R/M/S 无重叠、行内控件互不重叠、非省略号文本不裁切、总控行文字与按钮完整',
      },
      async (entry) => {
        await page.setViewport(width, VIEWPORT_HEIGHT)
        await sleep(420)
        await page.evaluate(`
          const ui = window.AIAB.useUiStore.getState()
          if (ui.trackPanelWidth !== 288) ui.setTrackPanelWidth(288)
          const store = window.AIAB.useStore.getState()
          if (store.view !== 'arrangement') store.setView('arrangement')
          if (store.chatOpen) store.setChatOpen(false)
          if (store.showMixer) store.setShowMixer(false)
          return true
        `)
        await sleep(320)
        const audit = await page.evaluate('return window.__VT.layoutAudit()')
        if (audit.rows === 0) throw new Error('面板里没有轨道行')
        entry.detail = {
          viewport: audit.viewport,
          rows: audit.rows,
          master: audit.master,
          metrics: audit.metrics,
          violations: audit.violations,
        }
        if (process.env.TRACK_VERBOSE === '1') {
          const nameWidths = (audit.metrics ?? [])
            .map((item) => `第${item.row + 1}行 名称${item.nameWidth}px/行高${item.height}px/名称→M间隙${item.nameToMuteGap}px/RMS可见${item.rmsVisible}`)
            .join('；')
          console.log(`      ${C.dim}量化：${nameWidths}${C.reset}`)
          console.log(`      ${C.dim}总控行：${audit.master?.width ?? '-'}px「${audit.master?.text ?? ''}」${C.reset}`)
        }
        if (!audit.violations || audit.violations.length === 0) return
        const detail = audit.violations
          .slice(0, 8)
          .map((item) => `[${item.selector}${item.row != null ? ` 第${item.row + 1}行` : ''}] ${item.reason}`)
          .join(' ｜ ')
        const more = audit.violations.length > 8 ? ` …共 ${audit.violations.length} 处` : ''
        throw new Error(`${detail}${more}`)
      },
    )
  }
  /* 布局跑完恢复基准视口，避免影响后续控制台/截图 */
  await page.setViewport(BASE_WIDTH, VIEWPORT_HEIGHT)
  await sleep(240)
}

/* ------------------------------------------------------------------ */
/* 验收 9：控制台 0 错误                                               */
/* ------------------------------------------------------------------ */

async function runConsoleCheck() {
  if (!groupEnabled('console')) return
  console.log(`\n${C.bold}控制台${C.reset}`)
  await check(
    '全流程控制台 0 错误（error / exception）',
    { selector: 'console', expected: 'page.consoleErrors.length === 0' },
    async () => {
      const errors = page.consoleErrors.slice()
      assert(errors.length === 0, `${errors.length} 条：${errors.slice(0, 5).join(' | ')}`)
    },
  )
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true })
  await buildIfNeeded()

  const preferredPort = await pickFreePort(8980)
  const debugPort = await pickFreePort(9000)
  console.log(`${C.gold}${C.bold}AI 编曲伴侣 · 轨道多选 / 框选 / 布局验收${C.reset}`)
  console.log(`${C.dim}截图与报告目录：.verify-track-ui${C.reset}`)
  if (ONLY.length > 0) console.log(`${C.dim}只跑分组：${ONLY.join(', ')}${C.reset}`)

  const server = await startStaticServer({ dataDir: DATA_DIR, preferredPort })
  const base = server.base
  console.log(`${C.dim}${base} · 后端就绪 v${server.health.version}${C.reset}\n`)
  let fatal = null
  try {
    await configurePlaceholderProvider(base)
    page = await launchChrome({ dataDir: DATA_DIR, width: BASE_WIDTH, height: VIEWPORT_HEIGHT + 50, debugPort })
    await page.setViewport(BASE_WIDTH, VIEWPORT_HEIGHT)
    await page.goto(`${base}/?intro=0&chat=0`)
    await page.waitFor('window.AIAB && document.querySelector("[data-track-row]")', 30000)
    await page.pressKey('Escape') // 兜底关闭欢迎引导弹层
    await page.evaluate(`
      const api = window.AIAB
      const store = api.useStore.getState()
      store.setView('arrangement')
      store.setChatOpen(false)
      store.setShowMixer(false)
      store.setHelpOpen(false)
      store.setSettingsOpen(false)
      store.setExportOpen(false)
      api.useStore.setState({ toasts: [] })
      return true
    `)
    await page.evaluate(PAGE_HELPERS)
    await page.waitFor('window.__VT && window.__VT.panelRows().length > 0', 15000)
    ok('应用启动并渲染轨道面板（window.__VT 助手已注入）')
    await sleep(300)

    await runContractChecks()
    await runSelectChecks()
    await runPanelMarqueeChecks()
    await runBatchChecks()
    await runSplitterChecks()
    await runLaneMarqueeCheck()
    await runLayoutChecks()
    await runConsoleCheck()

    /* 收尾：清提示条，避免脏截图 */
    await page.evaluate('window.AIAB.useStore.setState({ toasts: [] }); return true')
  } catch (error) {
    fatal = error
    console.error(`\n${C.red}验收框架执行失败：${error?.stack ?? error}${C.reset}`)
  } finally {
    page?.close()
    try {
      server.child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    await sleep(200)
  }

  /* ---------- 汇总报告 ---------- */
  const report = {
    generatedAt: new Date().toISOString(),
    script: 'scripts/verify-track-ui.mjs',
    spec: 'docs/TRACK_SELECTION_SPEC.md#8',
    pass: passed,
    fail: failed,
    total: passed + failed,
    checks,
    consoleErrors: page ? page.consoleErrors.slice() : [],
    screenshots: [...new Set(screenshots)],
    fatal: fatal ? String(fatal?.stack ?? fatal) : null,
    note:
      'UI 改造未落地时行为/选择器断言 FAIL 属预期；本报告用于把「selector + 期望/实际 + 截图」回传 Lead。',
  }
  try {
    writeFileSync(path.join(SHOT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
  } catch (error) {
    console.error(`${C.red}写 report.json 失败：${error?.message ?? error}${C.reset}`)
  }

  console.log(
    `\n${C.bold}${
      fatal
        ? `${C.red}✗ 验收框架异常，断言未完整执行`
        : failed === 0
          ? `${C.green}✓ 轨道多选验收全部通过`
          : `${C.red}✗ 存在失败项`
    }${C.reset}  ${passed}/${passed + failed}`,
  )
  if (failures.length > 0) {
    console.log(`\n${C.bold}失败明细：${C.reset}`)
    for (const failure of failures) console.log(`  ${C.red}✗${C.reset} ${failure}`)
  }
  console.log(`\n${C.dim}报告：${path.join(SHOT_DIR, 'report.json')}${C.reset}`)
  if (screenshots.length > 0) console.log(`${C.dim}截图：${[...new Set(screenshots)].join('  ')}${C.reset}`)
  if (fatal) console.log(`${C.red}框架异常导致部分断言未执行，见上方堆栈${C.reset}`)

  if (!process.env.TRACK_KEEP) {
    try {
      rmSync(path.join(DATA_DIR, 'chrome-profile'), { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  process.exitCode = failed === 0 && !fatal ? 0 : 1
  // 等 stdout 刷干净，避免最后一行丢失
  await new Promise((resolve) => process.stdout.write('', resolve))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
