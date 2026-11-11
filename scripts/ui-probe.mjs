#!/usr/bin/env node
/**
 * 深度 UI 探针：真实浏览器里逐个打开主要界面/弹窗，截图 + 采集表单控件几何信息 + 控制台错误。
 *
 *   node scripts/ui-probe.mjs                        # 1680/1440/1280 三个宽度跑全部状态
 *   PROBE_SKIP_BUILD=1 node scripts/ui-probe.mjs     # 跳过构建（已构建过）
 *   PROBE_ONLY=settings-ai,generate-audio node scripts/ui-probe.mjs
 *   PROBE_WIDTHS=1440 node scripts/ui-probe.mjs
 *   PROBE_OUT_DIR=.audit/probe-x PROBE_DATA_DIR=.cache/probe-data-x node scripts/ui-probe.mjs
 *   PROBE_REFRESH_DATA=1 node scripts/ui-probe.mjs   # 重新拷贝一份数据目录
 *
 * 产物：
 *   .audit/probe/<width>/<state>.png     截图
 *   .audit/probe/fields.json             表单控件几何 + 可疑项
 *   .audit/probe/console.json            控制台错误/异常
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { ROOT, sleep, startStaticServer, launchChrome, configurePlaceholderProvider } from './lib/browser-harness.mjs'

const OUT_DIR = process.env.PROBE_OUT_DIR ? path.resolve(ROOT, process.env.PROBE_OUT_DIR) : path.join(ROOT, '.audit', 'probe')
const DATA_DIR = process.env.PROBE_DATA_DIR ? path.resolve(ROOT, process.env.PROBE_DATA_DIR) : path.join(ROOT, '.cache', 'probe-data')
const SKIP_BUILD = process.env.PROBE_SKIP_BUILD === '1'
const REFRESH_DATA = process.env.PROBE_REFRESH_DATA === '1'
const WIDTHS = (process.env.PROBE_WIDTHS || '1680,1440,1280')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value >= 900)
const ONLY = (process.env.PROBE_ONLY || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', gold: '\x1b[33m', bold: '\x1b[1m' }

function prepareDataDir() {
  if (existsSync(DATA_DIR) && !REFRESH_DATA) return DATA_DIR
  if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true })
  mkdirSync(DATA_DIR, { recursive: true })
  const source = path.join(ROOT, 'data')
  if (!existsSync(source)) return DATA_DIR
  const copyDir = (from, to) => {
    if (!existsSync(from)) return
    cpSync(from, to, { recursive: true, force: true })
  }
  const settings = path.join(source, 'settings.json')
  if (existsSync(settings)) cpSync(settings, path.join(DATA_DIR, 'settings.json'))
  copyDir(path.join(source, 'projects'), path.join(DATA_DIR, 'projects'))
  copyDir(path.join(source, 'assets'), path.join(DATA_DIR, 'assets'))
  copyDir(path.join(source, 'soundfonts'), path.join(DATA_DIR, 'soundfonts'))
  copyDir(path.join(source, 'adapters'), path.join(DATA_DIR, 'adapters'))
  return DATA_DIR
}

const FIELDS_FN = String.raw`
(() => {
  const scope = document.querySelector('[aria-modal="true"]') || document.body
  const visible = (el) => {
    const s = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05
  }
  const pathOf = (el) => {
    const parts = []
    let node = el
    for (let i = 0; i < 4 && node && node.nodeType === 1 && node !== document.body; i++) {
      let tag = node.tagName.toLowerCase()
      const cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : ''
      if (cls) tag += '.' + cls
      parts.unshift(tag)
      node = node.parentElement
    }
    return parts.join(' > ')
  }
  const labelOf = (el) => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label')
    const id = el.id
    if (id) {
      const label = document.querySelector('label[for="' + CSS.escape(id) + '"]')
      if (label) return (label.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)
    }
    const parentLabel = el.closest('label')
    if (parentLabel) {
      const first = parentLabel.querySelector('span')
      const text = (first ? first.textContent : parentLabel.textContent) || ''
      return text.replace(/\s+/g, ' ').trim().slice(0, 60)
    }
    return ''
  }
  const fields = []
  for (const el of scope.querySelectorAll('input, textarea, select')) {
    if (!visible(el)) continue
    const s = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const parent = el.parentElement
    const pr = parent ? parent.getBoundingClientRect() : null
    const ps = parent ? getComputedStyle(parent) : null
    const tag = el.tagName.toLowerCase()
    const type = el.getAttribute('type') || (tag === 'input' ? 'text' : tag)
    const multiline = tag === 'textarea'
    const rows = multiline ? Number(el.getAttribute('rows') || 2) : 0
    const lineHeight = parseFloat(s.lineHeight) || 0
    const padTop = parseFloat(s.paddingTop) || 0
    const padBottom = parseFloat(s.paddingBottom) || 0
    const issues = []
    if (multiline) {
      const expected = rows * lineHeight + padTop + padBottom
      if (rows >= 2 && r.height < expected - 6) issues.push('textarea-too-short(' + Math.round(r.height) + '<' + Math.round(expected) + ')')
      if (s.overflowY === 'hidden' && el.scrollHeight > el.clientHeight + 2) issues.push('textarea-scroll-clipped')
    }
    if (s.overflowX === 'hidden' && el.scrollWidth > el.clientWidth + 2 && !multiline) issues.push('input-scroll-clipped')
    if (r.height < 22 && tag !== 'input') issues.push('too-short')
    if (tag !== 'select' && !labelOf(el) && !el.getAttribute('placeholder')) issues.push('no-label-or-placeholder')
    if (pr && ps && ps.display === 'flex' && ps.flexDirection !== 'column' && r.width + 8 < pr.width && !String(el.className).includes('w-') && !String(el.className).includes('flex-1')) {
      issues.push('narrow-in-flex')
    }
    fields.push({
      tag,
      type,
      path: pathOf(el),
      label: labelOf(el),
      placeholder: el.getAttribute('placeholder') || '',
      rows,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      parentRect: pr ? [Math.round(pr.left), Math.round(pr.top), Math.round(pr.width), Math.round(pr.height)] : null,
      parentDisplay: ps ? ps.display : '',
      parentFlex: ps ? ps.flexDirection : '',
      height: Math.round(r.height * 10) / 10,
      width: Math.round(r.width * 10) / 10,
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      minHeight: s.minHeight,
      maxHeight: s.maxHeight,
      overflowY: s.overflowY,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      valueLength: (el.value || '').length,
      disabled: Boolean(el.disabled),
      issues,
    })
  }
  return {
    state: document.body.getAttribute('data-probe-state') || '',
    viewport: [window.innerWidth, window.innerHeight],
    modal: Boolean(document.querySelector('[aria-modal="true"]')),
    bodyScrollWidth: document.documentElement.scrollWidth,
    bodyClientWidth: document.documentElement.clientWidth,
    fields,
  }
})()
`

const RESET = `
  const store = window.AIAB.useStore.getState()
  store.setHelpOpen(false)
  store.setSettingsOpen(false)
  store.setExportOpen(false)
  store.setShowMixer(false)
  store.setChatOpen(true)
  store.setView('arrangement')
  window.AIAB.useUiStore.getState().setChatCollapsed(false)
  document.querySelectorAll('[data-provision-panel],[data-training-panel],[data-generate-audio-panel],[data-task-center],[data-new-project-dialog]').forEach((node) => {
    const close = node.querySelector('button[aria-label^="关闭"]')
    if (close) close.click()
  })
  if (document.querySelector('[data-audio-engine-menu]')) {
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  }
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  document.body.removeAttribute('data-probe-state')
  return true
`

const STATES = [
  { id: 'arrangement', label: '编曲视图 + AI 面板', setup: `window.AIAB.useStore.getState().setView('arrangement'); return true` },
  {
    id: 'pianoroll',
    label: '钢琴卷帘',
    setup: `
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
    setup: `
      const store = window.AIAB.useStore.getState()
      const track = store.project.tracks.find((item) => item.clips.length > 0)
      if (track) { store.selectTrack(track.id); store.selectClip(track.id, track.clips[0].id) }
      store.setView('smartclips')
      return true
    `,
  },
  { id: 'mixer', label: '混音器', setup: `window.AIAB.useStore.getState().setShowMixer(true); return true` },
  { id: 'help', label: '帮助', setup: `window.AIAB.useStore.getState().setHelpOpen(true); return true` },
  { id: 'settings-ai', label: '设置 · AI 服务商', setup: `window.AIAB.useStore.getState().setSettingsOpen(true); return true`, waitFor: `document.querySelector('[aria-modal="true"]')` },
  {
    id: 'settings-search',
    label: '设置 · 联网搜索',
    setup: `
      window.AIAB.useStore.getState().setSettingsOpen(true)
      await new Promise((r) => setTimeout(r, 350))
      const btn = [...document.querySelectorAll('[aria-modal="true"] button')].find((b) => (b.textContent || '').includes('联网搜索'))
      btn?.click()
      return true
    `,
  },
  {
    id: 'settings-agent',
    label: '设置 · Agent 后端',
    setup: `
      window.AIAB.useStore.getState().setSettingsOpen(true)
      await new Promise((r) => setTimeout(r, 350))
      const btn = [...document.querySelectorAll('[aria-modal="true"] button')].find((b) => (b.textContent || '').includes('Agent 后端'))
      btn?.click()
      return true
    `,
  },
  {
    id: 'settings-audio',
    label: '设置 · 音频',
    setup: `
      window.AIAB.useStore.getState().setSettingsOpen(true)
      await new Promise((r) => setTimeout(r, 350))
      const btn = [...document.querySelectorAll('[aria-modal="true"] button')].find((b) => (b.textContent || '').trim().startsWith('音频'))
      btn?.click()
      return true
    `,
  },
  {
    id: 'settings-ui',
    label: '设置 · 界面',
    setup: `
      window.AIAB.useStore.getState().setSettingsOpen(true)
      await new Promise((r) => setTimeout(r, 350))
      const btn = [...document.querySelectorAll('[aria-modal="true"] button')].find((b) => (b.textContent || '').includes('界面'))
      btn?.click()
      return true
    `,
  },
  { id: 'export', label: '导出', setup: `window.AIAB.useStore.getState().setExportOpen(true); return true` },
  { id: 'palette', label: '命令面板', setup: `window.dispatchEvent(new CustomEvent('aiab:command-palette')); return true` },
  { id: 'welcome', label: '首次引导', setup: `window.dispatchEvent(new CustomEvent('aiab:welcome')); return true` },
  {
    id: 'new-project',
    label: '新建工程向导',
    setup: `window.dispatchEvent(new CustomEvent('aiab:open-new-project-wizard')); return true`,
    waitFor: `document.querySelector('[data-new-project-dialog]')`,
  },
  {
    id: 'project-menu',
    label: '文件菜单',
    setup: `
      const btn = [...document.querySelectorAll('header button')].find((b) => (b.textContent || '').includes('文件'))
      btn?.click()
      return true
    `,
  },
  {
    id: 'audio-engine-menu',
    label: 'AI 面板 · 音频引擎菜单',
    setup: `document.querySelector('[data-audio-engine-trigger]')?.click(); return true`,
    waitFor: `document.querySelector('[data-audio-engine-menu]')`,
  },
  {
    id: 'generate-audio',
    label: 'AI 生成音频高级面板',
    setup: `
      document.querySelector('[data-audio-engine-trigger]')?.click()
      await new Promise((r) => setTimeout(r, 300))
      document.querySelector('[data-audio-advanced-trigger]')?.click()
      return true
    `,
    waitFor: `document.querySelector('[data-generate-audio-panel]')`,
  },
  {
    id: 'task-center',
    label: '任务中心',
    setup: `
      document.querySelector('[data-audio-engine-trigger]')?.click()
      await new Promise((r) => setTimeout(r, 300))
      document.querySelector('[data-audio-tasks-trigger]')?.click()
      return true
    `,
    waitFor: `document.querySelector('[data-task-center]')`,
  },
  {
    id: 'provision',
    label: '安装本机引擎',
    setup: `
      document.querySelector('[data-audio-engine-trigger]')?.click()
      await new Promise((r) => setTimeout(r, 300))
      document.querySelector('[data-provision-trigger]')?.click()
      return true
    `,
    waitFor: `document.querySelector('[data-provision-panel]')`,
  },
  {
    id: 'training',
    label: '训练风格',
    setup: `
      document.querySelector('[data-audio-engine-trigger]')?.click()
      await new Promise((r) => setTimeout(r, 300))
      document.querySelector('[data-training-trigger]')?.click()
      return true
    `,
    waitFor: `document.querySelector('[data-training-panel]')`,
  },
  {
    id: 'audio-plan-needs-model',
    label: '音频意图 · 缺模型自动下载对话框',
    setup: `
      window.AIAB.audio.handleAudioPlanFromToolData({ audioPlan: { mode: 'text_to_audio', caption: 'warm cinematic piano with soft strings, 72 bpm', bpm: 72, durationSec: 20, reason: 'probe' } })
      return true
    `,
    waitFor: `document.querySelector('[data-provision-panel]')`,
    waitTimeout: 20000,
  },
  {
    id: 'audio-plan-render',
    label: '音频意图 · MIDI 渲染为音频',
    setup: `
      window.AIAB.audio.handleAudioPlanFromToolData({ audioPlan: { mode: 'midi_to_audio', reason: 'probe' } })
      return true
    `,
    waitFor: `document.querySelector('[data-audio-job-status="done"],[data-audio-job-status="failed"]')`,
    waitTimeout: 90000,
  },
  {
    id: 'chat-slash',
    label: 'AI 面板 · Slash 命令',
    setup: `
      await new Promise((r) => setTimeout(r, 200))
      const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').includes('Slash'))
      btn?.click()
      return true
    `,
    waitFor: `[...document.querySelectorAll('[role="listbox"]')].length > 0`,
  },
  {
    id: 'chat-multiline',
    label: 'AI 面板 · 多行输入',
    setup: `
      const area = document.querySelector('textarea[aria-label="给 AI 的指令"]')
      if (!area) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(area, '从零创作一首 92 BPM 的 cinematic 编曲：钢琴、弦乐、鼓组、贝斯，8 小节，\\n先给我 MIDI 编曲，然后把整首工程渲染成音频，最后再分轨生成 guitar / bass / drums。')
      area.dispatchEvent(new Event('input', { bubbles: true }))
      area.focus()
      return true
    `,
  },
  {
    id: 'chat-audio-intent',
    label: 'AI 面板 · 音频意图识别',
    setup: `
      const results = ['生成一首 30 秒 cinematic 音频', '把当前编曲渲染成音频并分轨', '加一条鼓组轨', '分轨生成 guitar 和 bass'].map((text) => [text, window.AIAB.audio.detectAudioIntent(text)])
      document.body.setAttribute('data-audio-intent-results', JSON.stringify(results))
      return true
    `,
  },
]

function runBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs')], { cwd: ROOT, stdio: 'ignore' })
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('build failed'))))
  })
}

async function main() {
  if (!SKIP_BUILD) {
    console.log(`${C.dim}构建前后端…${C.reset}`)
    await runBuild()
  }
  mkdirSync(OUT_DIR, { recursive: true })
  const dataDir = prepareDataDir()
  const states = STATES.filter((state) => (ONLY.length ? ONLY.includes(state.id) : true))

  const server = await startStaticServer({ preferredPort: 8940, dataDir })
  await configurePlaceholderProvider(server.base)
  const page = await launchChrome({ dataDir: server.dataDir })

  const fieldReport = []
  const consoleReport = []
  try {
    for (const width of WIDTHS) {
      const height = width >= 1680 ? 1000 : width >= 1440 ? 900 : 800
      await page.setViewport(width, height)
      const before = page.consoleErrors.length
      await page.goto(`${server.base}/?intro=0`)
      await page.waitFor('window.AIAB && document.querySelector("[data-track-row]")', 25000)
      await sleep(600)
      for (const state of states) {
        try {
          await page.evaluate(RESET)
          await sleep(120)
          const applied = await page.evaluate(`document.body.setAttribute('data-probe-state', ${JSON.stringify(state.id)}); ${state.setup}`)
          if (applied === false) {
            console.log(`${C.gold}${width}px${C.reset} ${state.id} — 跳过（前置条件不满足）`)
            continue
          }
          if (state.waitFor) {
            try {
              await page.waitFor(state.waitFor, state.waitTimeout ?? 5000)
            } catch {
              console.log(`${C.gold}${width}px${C.reset} ${state.id} — 等待目标超时`)
            }
          }
          await sleep(450)
          const fields = await page.evaluate(`return (${FIELDS_FN})`)
          const shot = path.join(OUT_DIR, String(width), `${state.id}.png`)
          await page.screenshot(shot)
          const suspicious = (fields.fields || []).filter((field) => field.issues && field.issues.length > 0)
          fieldReport.push({ width, height, state: state.id, label: state.label, screenshot: path.relative(ROOT, shot), ...fields })
          const overflow = fields.bodyScrollWidth - fields.bodyClientWidth
          const bad = suspicious.length + (overflow > 2 ? 1 : 0)
          console.log(
            `${C.gold}${width}px${C.reset} ${state.id} — 表单 ${fields.fields.length} 个，可疑 ${bad > 0 ? C.red : C.green}${bad}${C.reset}${
              overflow > 2 ? ` ${C.dim}横向溢出 ${overflow}px${C.reset}` : ''
            }`,
          )
          for (const field of suspicious) {
            console.log(
              `  ${C.red}${field.issues.join(',')}${C.reset} ${C.dim}${field.tag}${C.reset} ${field.label || field.placeholder || field.path} ` +
                `${field.rect[2]}x${field.rect[3]} parent=${field.parentRect ? field.parentRect[2] : '-'}x${field.parentRect ? field.parentRect[3] : '-'}`,
            )
          }
        } catch (error) {
          console.log(`${C.gold}${width}px${C.reset} ${state.id} — ${C.red}失败${C.reset}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      consoleReport.push({ width, errors: page.consoleErrors.slice(before) })
    }
  } finally {
    page.close()
    server.child.kill('SIGKILL')
    await sleep(150)
  }

  writeFileSync(path.join(OUT_DIR, 'fields.json'), JSON.stringify({ generatedAt: new Date().toISOString(), widthRuns: fieldReport }, null, 2))
  writeFileSync(path.join(OUT_DIR, 'console.json'), JSON.stringify({ generatedAt: new Date().toISOString(), runs: consoleReport }, null, 2))

  const allSuspicious = fieldReport.flatMap((run) =>
    (run.fields || []).filter((field) => field.issues?.length).map((field) => ({ width: run.width, state: run.state, ...field })),
  )
  console.log(`\n${C.bold}探针完成${C.reset}：${fieldReport.length} 个状态 × ${WIDTHS.length} 宽度，可疑表单 ${allSuspicious.length} 项`)
  for (const item of allSuspicious.slice(0, 40)) {
    console.log(`  ${C.red}${item.issues.join(',')}${C.reset} ${item.width}px ${item.state} · ${item.tag} · ${item.label || item.placeholder || item.path}`)
  }
  const errors = consoleReport.flatMap((run) => run.errors.map((text) => `[${run.width}px] ${text}`))
  if (errors.length) {
    console.log(`\n${C.bold}控制台错误（${errors.length}）${C.reset}`)
    for (const line of [...new Set(errors)].slice(0, 30)) console.log(`  ${C.dim}${line}${C.reset}`)
  }
  console.log(`${C.dim}截图：${path.relative(ROOT, OUT_DIR)}/<width>/<state>.png · 表单：${path.relative(ROOT, OUT_DIR)}/fields.json · 控制台：${path.relative(ROOT, OUT_DIR)}/console.json${C.reset}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
