#!/usr/bin/env node
/**
 * 布局 / 文字裁剪审计（真实浏览器）
 *
 *   node scripts/audit-layout.mjs                      # 默认 1680 / 1440 / 1280 三个宽度
 *   AUDIT_WIDTHS=1440,1280 node scripts/audit-layout.mjs
 *   AUDIT_ONLY=arrangement,mixer node scripts/audit-layout.mjs
 *   AUDIT_STATE=pianoroll AUDIT_WIDTH=1440 node scripts/audit-layout.mjs
 *
 * 每个 宽度 × 状态 组合会：
 *   1. 截一张图到 .audit/<width>/<state>.png
 *   2. 在页面内运行布局审计，检测：
 *      - clip-x / clip-y     自身文字被 overflow 裁剪（硬伤）
 *      - clipped-by-parent   被 overflow:hidden 祖先裁剪（硬伤；可滚动祖先不算）
 *      - offscreen           超出视口且不可滚动（硬伤）
 *      - occluded            文字被其它元素遮挡（硬伤）
 *      - overlap             可交互元素互相重叠（硬伤）
 *      - ellipsis            省略号截断（多数可接受，单独列出）
 *      - tiny-font           字号 < 9px（可读性提示）
 *
 * 当页面存在 aria-modal 弹层时，只审计弹层内部（背景被遮挡是预期行为）。
 *
 * 输出：.audit/report.json + 控制台摘要（按区域聚合，便于分派修复）。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { ROOT, sleep, startStaticServer, launchChrome, configurePlaceholderProvider } from './lib/browser-harness.mjs'

const OUT_DIR = path.join(ROOT, '.audit')
const SKIP_BUILD = process.env.AUDIT_SKIP_BUILD === '1'
const WIDTHS = (process.env.AUDIT_WIDTHS || '1680,1440,1280,1120')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value >= 900)
const ONLY_STATES = (process.env.AUDIT_ONLY || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const ONLY_WIDTH = process.env.AUDIT_WIDTH ? Number(process.env.AUDIT_WIDTH) : null
const ONLY_STATE = process.env.AUDIT_STATE || ''

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', gold: '\x1b[33m', bold: '\x1b[1m' }

/* ------------------------------------------------------------------ */
/* 页面内审计函数                                                       */
/* ------------------------------------------------------------------ */

const AUDIT_FN = String.raw`
(() => {
  const issues = []
  const vw = window.innerWidth
  const vh = window.innerHeight
  const styleCache = new Map()
  const cs = (el) => {
    let s = styleCache.get(el)
    if (!s) { s = getComputedStyle(el); styleCache.set(el, s) }
    return s
  }
  const shortCls = (el) => {
    const raw = typeof el.className === 'string' ? el.className : ''
    return raw.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.')
  }
  const pathOf = (el) => {
    const parts = []
    let node = el
    for (let i = 0; i < 4 && node && node.nodeType === 1 && node !== document.body; i++) {
      let tag = node.tagName.toLowerCase()
      const cls = shortCls(node)
      if (cls) tag += '.' + cls
      parts.unshift(tag)
      node = node.parentElement
    }
    return parts.join(' > ')
  }
  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100)
  const directText = (el) =>
    Array.from(el.childNodes).some((node) => node.nodeType === 3 && node.textContent.trim().length > 0)
  const visible = (el, r, s) =>
    r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05
  const inViewport = (r) => r.bottom > 2 && r.top < vh - 2 && r.right > 2 && r.left < vw - 2

  /* 元素是否在某个可滚动祖先里（内容可到达，不算被裁剪） */
  const hasScrollableAncestor = (el, stopAt) => {
    let p = el.parentElement
    let guard = 0
    while (p && p !== document.body && p !== stopAt && guard < 10) {
      const ps = cs(p)
      if (/auto|scroll/.test(ps.overflowX) || /auto|scroll/.test(ps.overflowY)) return true
      p = p.parentElement
      guard++
    }
    return false
  }

  /* 元素是否被最近的裁剪/滚动祖先裁掉一半以上（折叠面板里的隐藏内容属于正常布局） */
  const isGeometricallyClipped = (el, stopAtEl) => {
    const rect = el.getBoundingClientRect()
    let pEl = el.parentElement
    let guard = 0
    while (pEl && pEl !== document.body && pEl !== stopAtEl && guard < 10) {
      const ps = cs(pEl)
      const clips = /hidden|clip/.test(ps.overflowX + ps.overflowY)
      const scrolls = /auto|scroll/.test(ps.overflowX) || /auto|scroll/.test(ps.overflowY)
      if (clips || scrolls) {
        const pr = pEl.getBoundingClientRect()
        const w = Math.max(0, Math.min(rect.right, pr.right) - Math.max(rect.left, pr.left))
        const h = Math.max(0, Math.min(rect.bottom, pr.bottom) - Math.max(rect.top, pr.top))
        const area = w * h
        const selfArea = Math.max(1, rect.width * rect.height)
        return area < selfArea * 0.5
      }
      pEl = pEl.parentElement
      guard++
    }
    return false
  }

  /* 当前弹层：有 aria-modal 时只审计弹层内部 */
  const modal = document.querySelector('[aria-modal="true"]')
  const scope = modal || document.body
  const stopAt = modal || document.body

  const add = (kind, el, extra, severity) => {
    if (issues.length >= 400) return
    const r = el.getBoundingClientRect()
    issues.push({
      kind,
      severity: severity || 'error',
      path: pathOf(el),
      text: textOf(el),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      ...extra,
    })
  }
  const related = (a, b) => a === b || a.contains(b) || b.contains(a)

  const candidates = Array.from(scope.querySelectorAll('*')).filter((el) => {
    const s = cs(el)
    const r = el.getBoundingClientRect()
    if (!visible(el, r, s)) return false
    if (el.closest('[data-audit-ignore]')) return false
    // 关闭的 <details> 内容在 Chrome 里仍有布局盒，但用户不可见，属于正常折叠
    if (el.closest('details:not([open])')) return false
    const interactive = /^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(el.tagName) || el.getAttribute('role') === 'menuitem'
    return directText(el) || interactive
  })

  for (const el of candidates) {
    const s = cs(el)
    const r = el.getBoundingClientRect()
    const textEl = directText(el)
    const scrollable = hasScrollableAncestor(el, stopAt)

    /* A. 自身文字被 overflow 裁剪 */
    if (textEl && inViewport(r)) {
      const overX = el.scrollWidth - el.clientWidth
      const overY = el.scrollHeight - el.clientHeight
      const clipsX = /hidden|clip/.test(s.overflowX)
      const clipsY = /hidden|clip/.test(s.overflowY)
      const ellipsis = s.textOverflow === 'ellipsis'
      if (!scrollable && clipsX && overX > 2) add(ellipsis ? 'ellipsis' : 'clip-x', el, { overX }, ellipsis ? 'truncate' : 'error')
      if (!scrollable && clipsY && overY > 2) add('clip-y', el, { overY })
      // 固定宽度 + nowrap 时，文字会直接画出边框（例如时间码数字超框）；overflow visible 也要抓
      if (!scrollable && !clipsX && !clipsY && overX > 2 && s.whiteSpace === 'nowrap' && !ellipsis) {
        add('text-overflow', el, { overX })
      }
    }

    if (!inViewport(r)) continue
    const clippedOut = isGeometricallyClipped(el, stopAt)
    if (clippedOut) continue

    /* B. 被 overflow:hidden 祖先几何裁剪（可滚动祖先不算） */
    if (textEl) {
      let p = el.parentElement
      let guard = 0
      while (p && p !== document.body && p !== stopAt && guard < 10) {
        const ps = cs(p)
        if (/auto|scroll/.test(ps.overflowX) || /auto|scroll/.test(ps.overflowY)) break
        if (/hidden|clip/.test(ps.overflowX + ps.overflowY)) {
          const pr = p.getBoundingClientRect()
          const dx = Math.max(0, pr.left - r.left, r.right - pr.right)
          const dy = Math.max(0, pr.top - r.top, r.bottom - pr.bottom)
          if (dx > 2 || dy > 2) add('clipped-by-parent', el, { dx: Math.round(dx), dy: Math.round(dy), parent: pathOf(p) })
          break
        }
        p = p.parentElement
        guard++
      }
    }

    /* C. 超出视口（不在可滚动容器里才算） */
    if (!scrollable && (r.right > vw + 2 || r.bottom > vh + 2)) {
      add('offscreen', el, { overRight: Math.round(r.right - vw), overBottom: Math.round(r.bottom - vh) })
    }

    /* D. 文字被其它元素遮挡（在元素内部取样，找最上层元素） */
    if (textEl && !scrollable && r.width > 8 && r.height > 8) {
      const samples = [
        [r.left + r.width * 0.5, r.top + r.height * 0.5],
        [r.left + Math.min(12, r.width * 0.2), r.top + r.height * 0.5],
        [r.left + r.width * 0.8, r.top + r.height * 0.5],
      ]
      for (const [x, y] of samples) {
        if (x < 0 || y < 0 || x > vw - 1 || y > vh - 1) continue
        const top = document.elementFromPoint(x, y)
        if (!top || related(el, top)) continue
        const topStyle = cs(top)
        if (topStyle.pointerEvents === 'none') continue
        if (topStyle.position === 'sticky' || topStyle.position === 'fixed') continue
        if (top.closest('[role="tooltip"]')) continue
        add('occluded', el, { by: pathOf(top), byText: textOf(top).slice(0, 40) })
        break
      }
    }
  }

  /* E. 可交互元素互相重叠 */
  const controls = candidates.filter((el) => {
    const r = el.getBoundingClientRect()
    return inViewport(r) && !el.disabled && /^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(el.tagName)
  })
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i]
      const b = controls[j]
      if (related(a, b)) continue
      if (hasScrollableAncestor(a, stopAt) || hasScrollableAncestor(b, stopAt)) continue
      const ra = a.getBoundingClientRect()
      const rb = b.getBoundingClientRect()
      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
      if (ox > 4 && oy > 4) {
        const area = ox * oy
        const smaller = Math.min(ra.width * ra.height, rb.width * rb.height)
        if (area / smaller > 0.18) add('overlap', a, { with: textOf(b).slice(0, 40), area: Math.round(area) })
      }
    }
  }

  /* F. 字号过小（提示级） */
  for (const el of candidates) {
    if (!directText(el)) continue
    const r = el.getBoundingClientRect()
    if (!inViewport(r)) continue
    const size = parseFloat(cs(el).fontSize)
    if (size > 0 && size < 9) add('tiny-font', el, { fontSize: cs(el).fontSize }, 'info')
    if (issues.length >= 400) break
  }

  /* G. 横向滚动容器内容溢出：若滚动条被隐藏，用户根本看不到被裁掉的内容 → 硬伤 */
  const scrollHosts = Array.from(scope.querySelectorAll('*')).filter((el) => {
    const s = cs(el)
    if (!/auto|scroll/.test(s.overflowX)) return false
    return el.scrollWidth - el.clientWidth > 2
  })
  for (const el of scrollHosts) {
    const s = cs(el)
    const r = el.getBoundingClientRect()
    if (!visible(el, r, s) || r.width <= 0) continue
    // 只把「显式隐藏滚动条」的容器算硬伤：时间轴等正经滚动区不算
    if (!el.classList.contains('no-scrollbar')) continue
    const behind = el.scrollWidth - el.clientWidth
    add('hidden-overflow-x', el, { overX: behind }, 'error')
  }

  return issues
})()
`

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

const STATES = [
  {
    id: 'arrangement',
    label: '编曲视图（AI 面板打开）',
    apply: `window.AIAB.useStore.getState().setView('arrangement'); window.AIAB.useStore.getState().setShowMixer(false); window.AIAB.useStore.getState().setChatOpen(true); return true`,
  },
  {
    id: 'arrangement-wide',
    label: '编曲视图（AI 面板关闭）',
    apply: `window.AIAB.useStore.getState().setView('arrangement'); window.AIAB.useStore.getState().setChatOpen(false); return true`,
  },
  {
    id: 'pianoroll',
    label: '钢琴卷帘',
    apply: `
      const store = window.AIAB.useStore.getState()
      const track = store.project.tracks.find((item) => item.clips.length > 0)
      if (track) { store.selectTrack(track.id); store.selectClip(track.id, track.clips[0].id) }
      store.setView('pianoroll')
      return true
    `,
  },
  {
    id: 'smartclips',
    label: '智能片段',
    apply: `
      const store = window.AIAB.useStore.getState()
      const track = store.project.tracks.find((item) => item.clips.length > 0)
      if (track) { store.selectTrack(track.id); store.selectClip(track.id, track.clips[0].id); store.setSmartClipTarget({ trackId: track.id, clipId: track.clips[0].id }) }
      store.setView('smartclips')
      return true
    `,
  },
  {
    id: 'mixer',
    label: '混音器',
    apply: `window.AIAB.useStore.getState().setView('arrangement'); window.AIAB.useStore.getState().setShowMixer(true); return true`,
  },
  { id: 'help', label: '帮助', apply: `window.AIAB.useStore.getState().setHelpOpen(true); return true` },
  { id: 'settings', label: '设置', apply: `window.AIAB.useStore.getState().setSettingsOpen(true); return true` },
  { id: 'export', label: '导出', apply: `window.AIAB.useStore.getState().setExportOpen(true); return true` },
  {
    id: 'palette',
    label: '命令面板',
    apply: `window.dispatchEvent(new CustomEvent('aiab:command-palette')); return true`,
  },
  {
    id: 'welcome',
    label: '首次引导',
    apply: `window.dispatchEvent(new CustomEvent('aiab:welcome')); return true`,
  },
  {
    id: 'chat-collapsed',
    label: 'AI 面板窄条',
    apply: `window.AIAB.useUiStore.getState().setChatCollapsed(true); window.AIAB.useStore.getState().setChatOpen(true); window.AIAB.useStore.getState().setView('arrangement'); return true`,
  },
]

const RESET = `
  const store = window.AIAB.useStore.getState()
  store.setHelpOpen(false)
  store.setSettingsOpen(false)
  store.setExportOpen(false)
  store.setShowMixer(false)
  store.setChatOpen(true)
  store.setView('arrangement')
  window.AIAB.useUiStore.getState().setChatCollapsed(false)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  return true
`

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function runBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/build.mjs')], { cwd: ROOT, stdio: 'ignore' })
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('构建失败'))))
  })
}

function stateGroup(issue) {
  const p = issue.path
  if (/arrangement|TimelineToolbar|TrackRow|TrackPanel|track-row/i.test(p)) return '编曲/轨道'
  if (/pianoroll|canvas|piano/i.test(p)) return '钢琴卷帘'
  if (/smartclips|SmartClip/i.test(p)) return '智能片段'
  if (/transport|Transport/i.test(p)) return '走带'
  if (/mixer|Mixer|channel-strip/i.test(p)) return '混音器'
  if (/chat|Chat|message|Message/i.test(p)) return 'AI 面板'
  if (/settings|Settings/i.test(p)) return '设置'
  if (/export|Export/i.test(p)) return '导出'
  if (/help|Help|welcome|Welcome/i.test(p)) return '帮助/引导'
  if (/palette|command|Command/i.test(p)) return '命令面板'
  if (/topbar|TopBar/i.test(p)) return '顶栏'
  if (/statusbar|StatusBar/i.test(p)) return '状态栏'
  return '其它'
}

async function main() {
  if (!SKIP_BUILD) {
    console.log(`${C.dim}构建前端与后端…${C.reset}`)
    await runBuild()
  }
  mkdirSync(OUT_DIR, { recursive: true })
  const widths = ONLY_WIDTH ? [ONLY_WIDTH] : WIDTHS
  const states = STATES.filter((state) => {
    if (ONLY_STATE) return state.id === ONLY_STATE
    if (ONLY_STATES.length) return ONLY_STATES.includes(state.id)
    return true
  })

  const server = await startStaticServer({ preferredPort: 8930 })
  await configurePlaceholderProvider(server.base)
  const page = await launchChrome({ dataDir: server.dataDir })

  const report = []
  const allIssues = []
  try {
    for (const width of widths) {
      const height = width === 1680 ? 1000 : width === 1440 ? 900 : 800
      await page.setViewport(width, height)
      await page.goto(`${server.base}/?intro=0`)
      await page.waitFor('window.AIAB && document.querySelector("[data-track-row]")', 25000)
      for (const state of states) {
        await page.evaluate(RESET)
        await page.evaluate(state.apply)
        await sleep(450)
        const issues = await page.evaluate(`return (${AUDIT_FN.trim()})`)
        const shot = path.join(OUT_DIR, String(width), `${state.id}.png`)
        await page.screenshot(shot)
        const normalized = (issues || []).map((issue) => ({ ...issue, width, height, state: state.id, stateLabel: state.label }))
        allIssues.push(...normalized)
        report.push({ width, height, state: state.id, label: state.label, screenshot: path.relative(ROOT, shot), issueCount: normalized.length })
        const hard = normalized.filter((issue) => issue.severity === 'error').length
        console.log(`${C.gold}${width}px${C.reset} ${state.id} — ${normalized.length} 项（硬伤 ${hard}）`)
      }
    }
  } finally {
    page.close()
    server.child.kill('SIGKILL')
    await sleep(150)
  }

  writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), report, issues: allIssues }, null, 2))

  const hard = allIssues.filter((issue) => issue.severity === 'error')
  const truncate = allIssues.filter((issue) => issue.severity === 'truncate')
  const info = allIssues.filter((issue) => issue.severity === 'info')

  console.log(`\n${C.bold}审计完成${C.reset}  硬伤 ${C.red}${hard.length}${C.reset} · 省略号截断 ${truncate.length} · 小字号 ${info.length}`)
  console.log(`${C.dim}报告：.audit/report.json · 截图：.audit/<width>/<state>.png${C.reset}\n`)

  const byGroup = new Map()
  for (const issue of hard) {
    const group = stateGroup(issue)
    if (!byGroup.has(group)) byGroup.set(group, [])
    byGroup.get(group).push(issue)
  }
  for (const [group, list] of [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${C.bold}${group}${C.reset}（${list.length}）`)
    const seen = new Set()
    for (const issue of list) {
      const key = issue.kind + '|' + issue.path + '|' + issue.text.slice(0, 24)
      if (seen.has(key)) continue
      seen.add(key)
      const extra =
        (issue.overX ? ` overX=${issue.overX}` : '') +
        (issue.overY ? ` overY=${issue.overY}` : '') +
        (issue.dx != null ? ` dx=${issue.dx} dy=${issue.dy}` : '') +
        (issue.overRight != null ? ` right+=${issue.overRight} bottom+=${issue.overBottom}` : '') +
        (issue.by ? ` by=${issue.by}` : '')
      console.log(`  ${C.red}${issue.kind}${C.reset} ${C.dim}${issue.width}px ${issue.state}${C.reset} ${issue.path}${issue.text ? `  「${issue.text.slice(0, 50)}」` : ''}${extra}`)
      if (seen.size >= 22) {
        console.log(`${C.dim}  … 该区域还有 ${list.length - seen.size} 项（见 report.json）${C.reset}`)
        break
      }
    }
    console.log('')
  }

  const truncGroups = new Map()
  for (const issue of truncate) {
    const key = issue.path
    truncGroups.set(key, (truncGroups.get(key) || 0) + 1)
  }
  if (truncGroups.size) {
    console.log(`${C.bold}省略号截断最多的元素${C.reset}（多数是有意截断；关键文案被截断需要改成换行/tooltip）`)
    for (const [key, count] of [...truncGroups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      const sample = truncate.find((issue) => issue.path === key)
      console.log(`  ${count}× ${key}  「${sample.text.slice(0, 50)}」`)
    }
  }

  process.exitCode = hard.length > 0 ? 1 : 0
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
