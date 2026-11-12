#!/usr/bin/env node
/**
 * 音频任务卡「生成舞台」截图 + 几何/可访问性验收探针。
 *
 *   node scripts/verify-audio-stage.mjs
 *   STAGE_SKIP_BUILD=1 node scripts/verify-audio-stage.mjs          # 已构建过（Lead 会话里先跑 build）
 *   STAGE_WIDTHS=1440,1280 node scripts/verify-audio-stage.mjs
 *   STAGE_STATES=stems-running,blocked-companion node scripts/verify-audio-stage.mjs
 *   STAGE_OUT_DIR=.verify-ui-audio-stage STAGE_DATA_DIR=.cache/stage-data node scripts/verify-audio-stage.mjs
 *
 * 依赖：先构建（node scripts/build.mjs）——脚本默认自己构建，除非 STAGE_SKIP_BUILD=1。
 * 产物：
 *   .verify-ui-audio-stage/<state>-<width>.png          全页截图（视口）
 *   .verify-ui-audio-stage/<state>-<width>-card@2x.png  卡片裁图（CSS px 裁切，2x 像素）
 *   .verify-ui-audio-stage/<state>-card@2x.png          主宽度（1440）卡片裁图别名
 *   .verify-ui-audio-stage/report.json                  逐状态断言明细 + FAIL 清单
 *
 * 覆盖状态：
 *   stems-running       audio_with_stems 运行中（整曲完成 + 鼓组 62% + 其余等待）——主场景
 *   text-running        text_to_audio 单步 34%
 *   queued              排队中（queuePosition=2, etaSec=35）
 *   blocked-companion   blocked / start-companion（含 hint 启动命令）
 *   blocked-provision   blocked / provision（缺模型，data-audio-job-install）
 *   done                done（placed 3 条轨）
 *   failed              failed + retryable（error + 重试）
 *   midi-running        midi_to_audio 渲染中
 *   compact             视口 1440x760（不触发 compact 时自动降高）→ 卡片不挤压输入框
 *   auto-resume         blocked → mock 节点上线 → 任务自动续跑（mock fetch，不访问真实 Companion）
 *   stems-reduced-motion  prefers-reduced-motion 下无 JS 异常、卡片仍可读
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ROOT, sleep, startStaticServer, launchChrome, configurePlaceholderProvider } from './lib/browser-harness.mjs'

const OUT_DIR = process.env.STAGE_OUT_DIR ? path.resolve(ROOT, process.env.STAGE_OUT_DIR) : path.join(ROOT, '.verify-ui-audio-stage')
const DATA_DIR = process.env.STAGE_DATA_DIR
  ? path.resolve(ROOT, process.env.STAGE_DATA_DIR)
  : mkdtempSync(path.join(tmpdir(), 'aiab-stage-data-'))
const SKIP_BUILD = process.env.STAGE_SKIP_BUILD === '1'
const WIDTHS = (process.env.STAGE_WIDTHS || '1440,1280')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value >= 1000)
const ONLY = (process.env.STAGE_STATES || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', gold: '\x1b[33m', bold: '\x1b[1m' }
const HEIGHT_FOR_WIDTH = { 1680: 1000, 1440: 900, 1280: 800 }
const heightFor = (width) => HEIGHT_FOR_WIDTH[width] ?? 900
const wantState = (id) => ONLY.length === 0 || ONLY.includes(id)

/* ------------------------------------------------------------------ */
/* 状态注入                                                            */
/* ------------------------------------------------------------------ */

const STEMS_STEPS = `[
  { key: 'song', label: '生成整曲音频' },
  { key: 'stem:drums', label: '分轨 · 鼓组' },
  { key: 'stem:bass', label: '分轨 · 贝斯' },
  { key: 'stem:guitar', label: '分轨 · 吉他' },
  { key: 'stem:vocals', label: '分轨 · 人声' },
]`

const STATES = [
  {
    id: 'stems-running',
    label: '分轨运行中（整曲完成 + 鼓组 62%）',
    expectStatus: 'running',
    requireAnimation: true,
    expectEta: true,
    maxHeight: 240,
    textIncludes: ['热血 J-ROCK 分轨'],
    setup: `
      const s = window.AIAB.useAudioJobStore.getState()
      s.start({
        mode: 'audio_with_stems',
        title: '热血 J-ROCK 分轨',
        caption: 'j-rock, 168 bpm',
        steps: ${STEMS_STEPS},
      })
      s.updateStep('song', { status: 'done', progress: 1, startedAt: Date.now() - 42000 })
      s.updateStep('stem:drums', { status: 'running', progress: 0.62, startedAt: Date.now() - 24000 })
      return true
    `,
  },
  {
    id: 'text-running',
    label: '单步文本生成 34%',
    expectStatus: 'running',
    requireAnimation: true,
    expectEta: true,
    textIncludes: ['Cinematic 氛围铺底'],
    softTextMatch: ['34%', '34 %', '34', '0:30', '30s'],
    setup: `
      const s = window.AIAB.useAudioJobStore.getState()
      s.start({
        mode: 'text_to_audio',
        title: 'Cinematic 氛围铺底',
        caption: 'warm cinematic piano, 72 bpm',
        steps: [{ key: 'song', label: '生成整曲音频' }],
      })
      s.updateStep('song', { status: 'running', progress: 0.34, startedAt: Date.now() - 30000 })
      s.update({ taskId: 'stage_demo_task_1' })
      return true
    `,
  },
  {
    id: 'queued',
    label: '排队中（服务端 0-based queuePosition=2 → 显示第 3 位，etaSec=35）',
    expectStatus: 'running',
    requireAnimation: true,
    expectEta: true,
    textIncludes: ['Lo-fi 清晨'],
    softTextIncludes: ['排队', '第 3 位', '预计 35 秒'],
    softTextMatch: ['排队', '队列', '等待', '35', '预计'],
    setup: `
      const s = window.AIAB.useAudioJobStore.getState()
      s.start({
        mode: 'text_to_audio',
        title: 'Lo-fi 清晨',
        caption: 'lo-fi hip hop, 84 bpm',
        steps: [{ key: 'song', label: '生成整曲音频' }],
      })
      s.updateStep('song', { status: 'running', progress: 0, queuePosition: 2, etaSec: 35 })
      return true
    `,
  },
  {
    id: 'blocked-companion',
    label: '阻塞 · Companion 未启动',
    expectStatus: 'blocked',
    requireAnimation: true,
    requireAnimationProbes: [['[data-gen-radar] .gen-radar-ring', '.gen-detect-dot']],
    textIncludes: ['Companion'],
    softTextIncludes: ['node scripts/companion.mjs'],
    softButtonTexts: ['复制'],
    setup: `
      const s = window.AIAB.useAudioJobStore.getState()
      s.start({
        mode: 'audio_with_stems',
        title: '热血 J-ROCK 分轨',
        caption: 'j-rock, 168 bpm',
        steps: ${STEMS_STEPS},
      })
      s.updateStep('song', { status: 'done', progress: 1 })
      s.finish('blocked', {
        blockReason: 'start-companion',
        error: '本机模型已安装，但生成节点（Companion）未启动。',
        hint: '没有在线 Companion：在跑 GPU 的机器上执行 node scripts/companion.mjs --server http://127.0.0.1:8787 --acestep',
        retryable: true,
      })
      return true
    `,
  },
  {
    id: 'blocked-provision',
    label: '阻塞 · 缺本机模型',
    expectStatus: 'blocked',
    requireAnimation: false,
    textIncludes: ['安装'],
    softTextIncludes: ['下载'],
    requiredSelectors: ['[data-audio-job-install]'],
    setup: `
      const s = window.AIAB.useAudioJobStore.getState()
      s.start({
        mode: 'audio_with_stems',
        title: '热血 J-ROCK 分轨',
        caption: 'j-rock, 168 bpm',
        steps: ${STEMS_STEPS},
      })
      s.finish('blocked', {
        blockReason: 'provision',
        error: '生成音频需要本机 AI 引擎与模型（约 3.0GB）。是否现在下载？',
        hint: '已为你打开「安装本机引擎」对话框，确认下载即可。',
        retryable: true,
      })
      return true
    `,
  },
  {
    id: 'done',
    label: '完成（placed 3 条轨）',
    expectStatus: 'done',
    requireAnimation: false,
    maxHeight: 240,
    textIncludes: ['分轨 · 鼓组', '分轨 · 贝斯', '分轨 · 人声'],
    setup: `
      const s = window.AIAB.useAudioJobStore.getState()
      s.start({
        mode: 'audio_with_stems',
        title: '热血 J-ROCK 分轨',
        caption: 'j-rock, 168 bpm',
        steps: ${STEMS_STEPS},
      })
      for (const key of ['song', 'stem:drums', 'stem:bass', 'stem:guitar', 'stem:vocals']) {
        s.updateStep(key, { status: 'done', progress: 1 })
      }
      s.finish('done', { placed: ['分轨 · 鼓组', '分轨 · 贝斯', '分轨 · 人声'] })
      return true
    `,
  },
  {
    id: 'failed',
    label: '失败（error + retryable）',
    expectStatus: 'failed',
    requireAnimation: false,
    textIncludes: ['断线'],
    softTextIncludes: ['重试'],
    setup: `
      const s = window.AIAB.useAudioJobStore.getState()
      s.start({
        mode: 'text_to_audio',
        title: '深夜爵士三重奏',
        caption: 'late night jazz trio, 96 bpm',
        steps: [{ key: 'song', label: '生成整曲音频' }],
      })
      s.updateStep('song', { status: 'running', progress: 0.5, startedAt: Date.now() - 18000 })
      s.finish('failed', {
        error: '生成节点在合成过程中断线（ECONNRESET）。',
        retryable: true,
      })
      return true
    `,
  },
  {
    id: 'midi-running',
    label: 'MIDI → 音频渲染中',
    expectStatus: 'running',
    requireAnimation: true,
    expectEta: true,
    textIncludes: ['编曲渲染为音频'],
    setup: `
      const s = window.AIAB.useAudioJobStore.getState()
      s.start({
        mode: 'midi_to_audio',
        title: '编曲渲染为音频',
        caption: '渲染 8 小节 · 44.1 kHz',
        steps: [{ key: 'render', label: '渲染整曲音频' }],
      })
      s.updateStep('render', { status: 'running', progress: 0.5, startedAt: Date.now() - 12000 })
      return true
    `,
  },
  {
    id: 'compact',
    label: 'compact 面板（1440x760，必要时自动降高）',
    expectStatus: 'running',
    requireAnimation: true,
    maxHeight: 130,
    compact: true,
    custom: 'compact',
    setup: `
      const s = window.AIAB.useAudioJobStore.getState()
      s.start({
        mode: 'audio_with_stems',
        title: '热血 J-ROCK 分轨',
        caption: 'j-rock, 168 bpm',
        steps: ${STEMS_STEPS},
      })
      s.updateStep('song', { status: 'done', progress: 1, startedAt: Date.now() - 42000 })
      s.updateStep('stem:drums', { status: 'running', progress: 0.62, startedAt: Date.now() - 24000 })
      return true
    `,
  },
  {
    id: 'auto-resume',
    label: '阻塞→节点上线自动续跑（mock 节点）',
    expectStatus: 'blocked',
    custom: 'auto-resume',
    viewports: [1440],
  },
  {
    id: 'stems-reduced-motion',
    label: 'prefers-reduced-motion 运行态',
    expectStatus: 'running',
    requireAnimation: false,
    reducedMotion: true,
    textIncludes: ['热血 J-ROCK 分轨'],
    setup: `
      const s = window.AIAB.useAudioJobStore.getState()
      s.start({
        mode: 'audio_with_stems',
        title: '热血 J-ROCK 分轨',
        caption: 'j-rock, 168 bpm',
        steps: ${STEMS_STEPS},
      })
      s.updateStep('song', { status: 'done', progress: 1 })
      s.updateStep('stem:drums', { status: 'running', progress: 0.62, startedAt: Date.now() - 24000 })
      return true
    `,
  },
]

/* ------------------------------------------------------------------ */
/* 页面内脚本                                                          */
/* ------------------------------------------------------------------ */

const RESET = `
  try {
    window.AIAB.useAudioJobStore.getState().clear()
    const store = window.AIAB.useStore.getState()
    store.setChatOpen(true)
    window.AIAB.useUiStore.getState().setChatCollapsed(false)
    store.setHelpOpen(false)
    store.setSettingsOpen(false)
    store.setExportOpen(false)
    store.setShowMixer(false)
    store.setView('arrangement')
    document
      .querySelectorAll('[data-provision-panel] button[aria-label^="关闭"],[data-generate-audio-panel] button[aria-label^="关闭"],[data-task-center] button[aria-label^="关闭"],[data-training-panel] button[aria-label^="关闭"]')
      .forEach((button) => button.click())
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  } catch (error) {
    return String((error && error.message) || error)
  }
  return true
`

const READY = `window.AIAB && window.AIAB.useAudioJobStore && window.AIAB.audio && document.querySelector('[data-track-row]') && document.querySelector('[data-chat-composer]')`

const COMPACT_INFO = `(() => {
  const composer = document.querySelector('[data-chat-composer]')
  const aside = composer ? composer.closest('aside') : null
  const area = document.querySelector('textarea[aria-label="给 AI 的指令"]')
  const rect = aside ? aside.getBoundingClientRect() : null
  return {
    viewport: [window.innerWidth, window.innerHeight],
    panelHeight: rect ? Math.round(rect.height) : null,
    panelWidth: rect ? Math.round(rect.width) : null,
    compact: Boolean(area && area.style.minHeight === '56px'),
    textareaMinHeight: area ? area.style.minHeight : null,
  }
})()`

/** 卡片几何 + 可访问性测量（页面内执行）。返回字段全部进入 report.json。 */
const MEASURE = String.raw`(() => {
  const card = document.querySelector('[data-audio-job]')
  const visible = (el) => {
    const s = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05 && el.getClientRects().length > 0
  }
  const pathOf = (el) => {
    const parts = []
    let node = el
    for (let i = 0; i < 6 && node && node.nodeType === 1 && node !== document.body; i++) {
      let tag = node.tagName.toLowerCase()
      if (node.id) {
        parts.unshift(tag + '#' + node.id)
        break
      }
      const cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.') : ''
      const data = Array.from(node.attributes || [])
        .filter((a) => a.name.startsWith('data-'))
        .map((a) => '[' + a.name + '="' + a.value + '"]')
        .join('')
      parts.unshift(tag + (cls ? '.' + cls : '') + data)
      node = node.parentElement
    }
    return parts.join(' > ')
  }
  const aside = card ? card.closest('aside') : null
  const composer = document.querySelector('[data-chat-composer]')
  const composerRect = composer ? composer.getBoundingClientRect() : null
  const asideRect = aside ? aside.getBoundingClientRect() : null
  const base = {
    cardExists: Boolean(card),
    status: card ? card.getAttribute('data-audio-job-status') : null,
    viewport: [window.innerWidth, window.innerHeight],
    bodyOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    compact: false,
    composer: composerRect ? { top: Math.round(composerRect.top), height: Math.round(composerRect.height) } : null,
    aside: asideRect
      ? {
          top: Math.round(asideRect.top),
          bottom: Math.round(asideRect.bottom),
          left: Math.round(asideRect.left),
          right: Math.round(asideRect.right),
          width: Math.round(asideRect.width),
          height: Math.round(asideRect.height),
        }
      : null,
    cardCount: document.querySelectorAll('[data-audio-job]').length,
  }
  const areaEl = document.querySelector('textarea[aria-label="给 AI 的指令"]')
  base.compact = Boolean(areaEl && areaEl.style.minHeight === '56px')
  if (!card) return base

  const cardRect = card.getBoundingClientRect()
  const hooks = {
    close: Boolean(card.querySelector('button[aria-label="关闭音频任务卡"]')),
    cancel: Boolean(card.querySelector('[data-audio-job-cancel]')),
    install: Boolean(card.querySelector('[data-audio-job-install]')),
    retry: Array.from(card.querySelectorAll('button')).some((b) => (b.textContent || '').includes('重试')),
  }

  /* <10px 文本：遍历卡内直接文本节点，检查父元素 computed font-size */
  const fontUnder10 = []
  const textElements = new Map()
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => ((node.textContent || '').trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  })
  let textNode
  while ((textNode = walker.nextNode())) {
    const el = textNode.parentElement
    if (!el || textElements.has(el) || !visible(el)) continue
    textElements.set(el, true)
    const size = parseFloat(getComputedStyle(el).fontSize) || 0
    if (size > 0 && size < 10) {
      fontUnder10.push({
        text: (textNode.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        fontSize: Math.round(size * 10) / 10,
        selector: pathOf(el),
      })
    }
  }
  let minFontSize = null
  for (const el of textElements.keys()) {
    const size = parseFloat(getComputedStyle(el).fontSize) || 0
    if (size > 0 && (minFontSize === null || size < minFontSize)) minFontSize = Math.round(size * 10) / 10
  }

  /* 按钮：不换行 / 不横向溢出 / 高度合理 */
  const buttons = []
  for (const button of card.querySelectorAll('button')) {
    if (!visible(button)) continue
    const r = button.getBoundingClientRect()
    const s = getComputedStyle(button)
    const fontSize = parseFloat(s.fontSize) || 12
    let lineHeight = parseFloat(s.lineHeight)
    if (!Number.isFinite(lineHeight) || lineHeight <= 4) lineHeight = fontSize * (lineHeight > 0 ? lineHeight : 1.5)
    buttons.push({
      text: (button.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      selector: pathOf(button),
      width: Math.round(r.width),
      height: Math.round(r.height),
      scrollWidth: button.scrollWidth,
      clientWidth: button.clientWidth,
      whiteSpace: s.whiteSpace,
      lineHeight: Math.round(lineHeight * 10) / 10,
      wrapped: r.height > lineHeight * 2.2 + 8,
    })
  }

  /* 横向溢出：元素右/左边缘越出卡片且没有被祖先 overflow 裁剪（auto/scroll 属于刻意滚动，不算溢出） */
  const clippedByAncestor = (el) => {
    let ancestor = el.parentElement
    while (ancestor && ancestor !== card) {
      const as = getComputedStyle(ancestor)
      if (/(hidden|clip|auto|scroll)/.test(as.overflowX) || /(hidden|clip|auto|scroll)/.test(as.overflow)) return true
      ancestor = ancestor.parentElement
    }
    return false
  }
  const overflowElements = []
  for (const el of card.querySelectorAll('*')) {
    if (!visible(el)) continue
    if (clippedByAncestor(el)) continue
    const r = el.getBoundingClientRect()
    const overRight = r.right - cardRect.right
    const overLeft = cardRect.left - r.left
    if (overRight > 1 || overLeft > 1) {
      overflowElements.push({
        selector: pathOf(el),
        overRight: Math.round(overRight * 10) / 10,
        overLeft: Math.round(overLeft * 10) / 10,
      })
    }
  }

  /* 动画：可见元素上非 none 的 animation-name */
  const animations = []
  for (const el of [card, ...card.querySelectorAll('*')]) {
    if (!visible(el)) continue
    const s = getComputedStyle(el)
    const name = String(s.animationName || 'none')
    if (name === 'none' || name === '') continue
    animations.push({ name, duration: s.animationDuration, selector: pathOf(el) })
  }
  const animationNames = Array.from(new Set(animations.map((item) => item.name)))

  /* 指定动效探针（阻塞态雷达 / 频谱 / 光球），供断言「设计要求的动态确实挂上」 */
  const animationProbes = ['[data-gen-radar] .gen-radar-ring', '.gen-detect-dot', '[data-gen-spectrum] .gen-bar', '.gen-orb-ring', '.gen-scan'].map((selector) => {
    const el = card.querySelector(selector)
    return {
      selector,
      found: Boolean(el),
      visible: el ? visible(el) : false,
      animationName: el ? String(getComputedStyle(el).animationName || 'none') : null,
      animationDuration: el ? getComputedStyle(el).animationDuration : null,
    }
  })

  /* 横向分轨管道：内容比可视宽度多时（隐藏滚动条 + 无渐隐提示）记为软提示 */
  const pipelineEl = card.querySelector('[data-gen-pipeline]')
  const pipeline = pipelineEl
    ? {
        found: true,
        scrollWidth: pipelineEl.scrollWidth,
        clientWidth: pipelineEl.clientWidth,
        overflowX: pipelineEl.scrollWidth - pipelineEl.clientWidth,
        chips: pipelineEl.querySelectorAll('.gen-chip').length,
      }
    : { found: false }

  /* 阻塞态启动命令块是否被省略号截断（title 里仍有全文） */
  const commandEl = card.querySelector('.gen-command-text')
  const command = commandEl
    ? { found: true, truncated: commandEl.scrollWidth > commandEl.clientWidth + 1, scrollWidth: commandEl.scrollWidth, clientWidth: commandEl.clientWidth }
    : { found: false }

  return {
    ...base,
    cardExists: true,
    card: {
      x: Math.round(cardRect.left * 10) / 10,
      y: Math.round(cardRect.top * 10) / 10,
      width: Math.round(cardRect.width * 10) / 10,
      height: Math.round(cardRect.height * 10) / 10,
      scrollWidth: card.scrollWidth,
      clientWidth: card.clientWidth,
      scrollHeight: card.scrollHeight,
      clientHeight: card.clientHeight,
    },
    hooks,
    fontUnder10,
    minFontSize,
    buttons,
    overflowElements,
    animations: { count: animations.length, names: animationNames, items: animations.slice(0, 12) },
    animationProbes,
    pipeline,
    command,
    withinAside: asideRect
      ? {
          ok:
            cardRect.top >= asideRect.top - 1 &&
            cardRect.bottom <= asideRect.bottom + 1 &&
            cardRect.left >= asideRect.left - 1 &&
            cardRect.right <= asideRect.right + 1,
          cardBottom: Math.round(cardRect.bottom),
          asideBottom: Math.round(asideRect.bottom),
          cardRight: Math.round(cardRect.right),
          asideRight: Math.round(asideRect.right),
        }
      : null,
    innerText: String(card.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
  }
})()`

/* ------------------------------------------------------------------ */
/* 断言                                                                */
/* ------------------------------------------------------------------ */

const NOISE_RE =
  /AudioContext|autoplay|MIDI|favicon|Web MIDI|Max polyphony|polyphony|Note dropped|SoundFont|AudioWorkletNode|addModule|Failed to load resource|net::ERR|NotAllowedError|ResizeObserver loop/i

function assertRun(state, run) {
  const m = run.metrics
  const checks = []
  const add = (name, ok, detail = '', hard = true) => checks.push({ name, ok, detail, hard })

  add('data-audio-job 存在', m.cardExists, m.cardExists ? '' : '未找到卡片（可能未渲染或注入失败）')
  if (m.cardExists) {
    add('data-audio-job-status 正确', m.status === state.expectStatus, `期望 ${state.expectStatus}，实测 ${m.status}`)
    add('关闭钩子 aria-label="关闭音频任务卡"', m.hooks.close, m.hooks.close ? '' : '缺失（硬约束）')
    if (state.expectStatus === 'running') {
      add('运行态取消钩子 data-audio-job-cancel', m.hooks.cancel, m.hooks.cancel ? '' : '缺失（硬约束）')
    }
    if ((state.requiredSelectors || []).includes('[data-audio-job-install]')) {
      add('阻塞态安装钩子 data-audio-job-install', m.hooks.install, m.hooks.install ? '' : '缺失（硬约束）')
    }
    add(
      '卡片完整位于 AI 面板 aside 内',
      Boolean(m.withinAside && m.withinAside.ok),
      m.withinAside
        ? `卡 top=${m.card.y} bottom=${m.withinAside.cardBottom} / aside top=${m.aside.top} bottom=${m.withinAside.asideBottom}`
        : '找不到 aside',
    )
    add('卡片无横向溢出', m.card.scrollWidth <= m.card.clientWidth + 1, `scrollWidth=${m.card.scrollWidth} clientWidth=${m.card.clientWidth}`)
    add(
      '内部元素无未裁剪横向溢出',
      m.overflowElements.length === 0,
      m.overflowElements.length
        ? m.overflowElements.slice(0, 3).map((item) => `${item.selector} right+${item.overRight}px`).join(' | ')
        : '',
    )
    add('页面无横向滚动', m.bodyOverflowX <= 1, `documentElement scrollWidth-clientWidth=${m.bodyOverflowX}`)
    add(
      '卡内 <10px 文本节点 = 0',
      m.fontUnder10.length === 0,
      m.fontUnder10.length
        ? `${m.fontUnder10.length} 个：${m.fontUnder10.slice(0, 4).map((f) => `${f.fontSize}px「${f.text}」@${f.selector}`).join(' | ')}`
        : `最小 ${m.minFontSize}px`,
    )
    const badButtons = m.buttons.filter((b) => b.scrollWidth > b.clientWidth + 1)
    add(
      '按钮文字不横向溢出',
      badButtons.length === 0,
      badButtons.length
        ? badButtons.slice(0, 3).map((b) => `「${b.text}」scrollWidth=${b.scrollWidth}/clientWidth=${b.clientWidth}`).join(' | ')
        : `${m.buttons.length} 个按钮`,
    )
    const tallButtons = m.buttons.filter((b) => b.height > 44 || b.wrapped)
    add(
      '按钮高度合理/不换行',
      tallButtons.length === 0,
      tallButtons.length
        ? tallButtons.slice(0, 3).map((b) => `「${b.text}」h=${b.height}px lineHeight=${b.lineHeight} wrapped=${b.wrapped}`).join(' | ')
        : '',
    )
    add('卡内文字可读（非空）', m.innerText.length >= 8, `innerText ${m.innerText.length} 字符`)
    for (const keyword of state.textIncludes || []) {
      add(`文字包含「${keyword}」`, m.innerText.includes(keyword), m.innerText.slice(0, 140))
    }
    if (state.requireAnimation) {
      add(
        '运行态 CSS 动画已挂上',
        m.animations.count > 0,
        m.animations.count ? `animation-name: ${m.animations.names.slice(0, 4).join(', ')}` : '卡内没有 animation-name != none 的可见元素',
      )
    }
    if (state.requireAnimationProbes) {
      const probes = m.animationProbes || []
      for (const group of state.requireAnimationProbes) {
        const matched = probes.filter((probe) => group.includes(probe.selector))
        const animating = matched.filter((probe) => probe.animationName && probe.animationName !== 'none')
        add(
          `指定动效已挂上（${group.join(' / ')}）`,
          animating.length > 0,
          `探针 ${matched.map((probe) => `${probe.selector}={found:${probe.found},name:${probe.animationName},dur:${probe.animationDuration}}`).join(' ; ')}`,
        )
      }
    }
    if (state.expectEta) {
      const eta = /预计\s*(\d{1,3}):(\d{2})/.exec(m.innerText)
      const nonzero = Boolean(eta) && (Number(eta[1]) > 0 || Number(eta[2]) > 0)
      add(
        '运行态 ETA 已计算（非 00:00）',
        nonzero,
        eta ? `实测「${eta[0]}」` : `未找到「预计 mm:ss」文本；innerText=${m.innerText.slice(0, 100)}`,
      )
    }
    if (state.maxHeight) {
      add(`卡片高度 <= ${state.maxHeight}px`, m.card.height <= state.maxHeight, `实测 ${m.card.height}px`)
    }
    if (state.compact) {
      add('已触发 compact 模式', m.compact, m.compact ? '' : `textarea minHeight 非 56px，panelHeight=${m.aside ? m.aside.height : '?'}`)
      add(
        '卡片位于输入框上方',
        Boolean(m.composer) && m.card.y + m.card.height <= m.composer.top + 1,
        m.composer ? `卡 bottom=${Math.round(m.card.y + m.card.height)} / composer top=${m.composer.top}` : '找不到输入框',
      )
      add('输入框可见且未被挤出视口', Boolean(m.composer) && m.composer.height > 0, m.composer ? `composer h=${m.composer.height}` : '')
    }
  }
  add('console error = 0', run.consoleErrors.length === 0, run.consoleErrors.slice(0, 3).join(' | '))

  const warnings = []
  const soft = (name, ok, detail = '') => {
    if (!ok) warnings.push({ name, detail })
  }
  if (m.cardExists) {
    for (const keyword of state.softTextIncludes || []) {
      soft(`建议文字包含「${keyword}」`, m.innerText.includes(keyword), m.innerText.slice(0, 160))
    }
    if (state.softTextMatch) {
      soft(`建议文字包含 ${state.softTextMatch.join('/')} 之一`, state.softTextMatch.some((token) => m.innerText.includes(token)))
    }
    if (state.softButtonTexts) {
      const buttonTexts = m.buttons.map((b) => b.text).join(' | ')
      for (const keyword of state.softButtonTexts) soft(`建议有按钮「${keyword}」`, buttonTexts.includes(keyword))
    }
    if (m.pipeline && m.pipeline.found && m.pipeline.overflowX > 1) {
      soft('分轨管道横向滚动（无滚动条提示，内容被裁切）', false, `${m.pipeline.overflowX}px 不可见（${m.pipeline.chips} 个 chip）`)
    }
    if (m.command && m.command.found && m.command.truncated) {
      soft('启动命令单行省略号截断（可复制全文）', false, `scrollWidth=${m.command.scrollWidth}/clientWidth=${m.command.clientWidth}`)
    }
    if (state.expectStatus === 'failed') soft('失败态建议有「重试」按钮', m.hooks.retry)
    if (state.expectStatus === 'blocked' && state.id === 'blocked-companion') soft('阻塞态建议有重试/自动继续', m.hooks.retry)
  }

  run.checks = checks
  run.warnings = warnings
  run.failures = checks.filter((check) => check.hard && !check.ok)
  run.pass = run.failures.length === 0
  return run
}

/* ------------------------------------------------------------------ */
/* 运行器                                                              */
/* ------------------------------------------------------------------ */

function runBuild() {
  return new Promise((resolve, reject) => {
    console.log(`${C.dim}构建前后端…（node scripts/build.mjs）${C.reset}`)
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs')], { cwd: ROOT, stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`构建失败（code=${code}）`))))
  })
}

const pngPath = (name) => path.join(OUT_DIR, name)

async function captureCard(page, card, file) {
  const pad = 10
  const viewport = await page.evaluate('return [innerWidth, innerHeight]')
  const vw = viewport[0]
  const vh = viewport[1]
  const x = Math.max(0, Math.min(vw - 1, card.x - pad))
  const y = Math.max(0, Math.min(vh - 1, card.y - pad))
  const width = Math.max(1, Math.min(vw - x, card.width + pad * 2))
  const height = Math.max(1, Math.min(vh - y, card.height + pad * 2))
  const result = await page.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x, y, width, height, scale: 2 },
    captureBeyondViewport: false,
  })
  writeFileSync(file, Buffer.from(result.data, 'base64'))
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height), scale: 2 }
}

async function waitForJobStatus(page, status, timeoutMs = 8000) {
  const started = Date.now()
  let current = null
  while (Date.now() - started < timeoutMs) {
    current = await page.evaluate(`return document.querySelector('[data-audio-job]')?.getAttribute('data-audio-job-status') ?? null`)
    if (current === status) return true
    await sleep(120)
  }
  return false
}

/**
 * 动效偏好：headless Chrome 在本机默认上报 prefers-reduced-motion: reduce，
 * 会让 `@media (prefers-reduced-motion: reduce)` 的静态回退生效，动画类断言失去意义。
 * 常规状态强制 no-preference；只有 stems-reduced-motion 显式设 reduce。
 */
async function setMotion(page, value) {
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] })
}

async function loadAt(page, baseUrl, width, height) {
  await page.setViewport(width, height)
  await page.goto(`${baseUrl}/?intro=0`)
  await page.waitFor(READY, 30000)
  await sleep(700)
  await setMotion(page, 'no-preference')
  await sleep(120)
}

/** 常规状态：reset → 注入 → 等状态 → 测量 → 截图 → 断言。 */
async function runState(page, baseUrl, state, width, height) {
  const run = {
    state: state.id,
    label: state.label,
    width,
    height,
    expectedStatus: state.expectStatus,
    status: null,
    screenshot: null,
    cardScreenshot: null,
    cardClip: null,
    metrics: null,
    checks: [],
    warnings: [],
    failures: [],
    pass: false,
    consoleErrors: [],
    durationMs: 0,
  }
  const startedAt = Date.now()
  const consoleStart = page.consoleErrors.length
  try {
    const resetResult = await page.evaluate(RESET)
    if (resetResult !== true) throw new Error(`reset 失败：${resetResult}`)
    await setMotion(page, state.reducedMotion ? 'reduce' : 'no-preference')
    await sleep(120)

    if (state.custom === 'compact') {
      // 1440x760 是验收期望场景；若不触发 compact，再按候选视口降高，报告中如实记录实际视口
      const candidates = [760, 640, 600, 560]
      await loadAt(page, baseUrl, 1440, candidates[0])
      const firstInfo = await page.evaluate(`return ${COMPACT_INFO}`)
      if (!firstInfo.compact) {
        for (const candidate of candidates.slice(1)) {
          await loadAt(page, baseUrl, 1440, candidate)
          const info = await page.evaluate(`return ${COMPACT_INFO}`)
          if (info.compact) {
            run.compactFallback = {
              from: [1440, candidates[0]],
              to: [1440, candidate],
              reason: `1440x760 未进入 compact（panelHeight=${firstInfo.panelHeight}）`,
            }
            break
          }
        }
        if (!run.compactFallback) {
          await loadAt(page, baseUrl, 1440, candidates[0])
          run.compactFallback = { from: [1440, 760], to: [1440, 760], reason: '所有候选视口均未触发 compact' }
        }
      }
      await page.evaluate(RESET)
      await sleep(120)
      run.width = await page.evaluate('return innerWidth')
      run.height = await page.evaluate('return innerHeight')
      run.compactInfo = await page.evaluate(`return ${COMPACT_INFO}`)
    }

    const injected = await page.evaluate(state.setup)
    if (injected !== true) throw new Error(`注入失败：${injected}`)

    const reached = await waitForJobStatus(page, state.expectStatus)
    if (!reached) {
      const current = await page.evaluate(`return document.querySelector('[data-audio-job]')?.getAttribute('data-audio-job-status') ?? null`)
      throw new Error(`等待状态 ${state.expectStatus} 超时（当前 ${current}）`)
    }
    await sleep(550)
    if (state.custom === 'compact') run.compactInfo = await page.evaluate(`return ${COMPACT_INFO}`)

    run.metrics = await page.evaluate(`return ${MEASURE}`)
    run.status = run.metrics.status

    const fullFile = pngPath(`${state.id}-${width}.png`)
    await page.screenshot(fullFile)
    run.screenshot = path.relative(ROOT, fullFile)

    if (run.metrics.cardExists) {
      const cardFile = pngPath(`${state.id}-${width}-card@2x.png`)
      try {
        run.cardClip = await captureCard(page, run.metrics.card, cardFile)
        run.cardScreenshot = path.relative(ROOT, cardFile)
        if (width === 1440) {
          const aliasFile = pngPath(`${state.id}-card@2x.png`)
          copyFileSync(cardFile, aliasFile)
          run.cardScreenshotAlias = path.relative(ROOT, aliasFile)
        }
      } catch (error) {
        run.warnings.push({ name: '卡片裁图失败', detail: error instanceof Error ? error.message : String(error) })
      }
    }
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error)
    try {
      const fullFile = pngPath(`${state.id}-${width}.png`)
      await page.screenshot(fullFile)
      run.screenshot = path.relative(ROOT, fullFile)
    } catch {
      /* ignore */
    }
  } finally {
    if (state.reducedMotion) {
      try {
        await setMotion(page, 'no-preference')
      } catch {
        /* ignore */
      }
    }
    run.consoleErrors = page.consoleErrors.slice(consoleStart).filter((text) => !NOISE_RE.test(text))
    run.durationMs = Date.now() - startedAt
  }

  if (run.error) {
    run.metrics = run.metrics || { cardExists: false }
    run.checks = [{ name: '状态注入/等待', ok: false, detail: run.error, hard: true }]
    run.failures = run.checks
    run.pass = false
    return run
  }
  return assertRun(state, run)
}

/**
 * 阻塞 → 节点上线自动续跑：
 * mock `/api/companion/status`（先 offline，后 online）与 `/api/provision/status`（已安装），
 * 用真实 runAudioPlan 走到 blocked/start-companion，再翻线上标志，断言任务卡自行恢复 running。
 */
async function runAutoResume(page, baseUrl) {
  const run = {
    state: 'auto-resume',
    label: '阻塞→节点上线自动续跑（mock 节点）',
    width: 1440,
    height: 900,
    expectedStatus: 'blocked',
    status: null,
    blockedStatus: null,
    resumedStatus: null,
    screenshot: null,
    cardScreenshot: null,
    checks: [],
    warnings: [],
    failures: [],
    pass: false,
    consoleErrors: [],
    durationMs: 0,
    mock: true,
  }
  const startedAt = Date.now()
  const consoleStart = page.consoleErrors.length
  try {
    await loadAt(page, baseUrl, 1440, 900)
    await page.evaluate(RESET)
    await sleep(120)

    await page.evaluate(`
      // headless 下卡片按「页面可见」轮询节点状态；显式保证可见，避免被 document.hidden 短路
      try {
        if (document.hidden) {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
        }
      } catch {}
      window.__stageOrigFetch = window.fetch.bind(window)
      window.__stageMock = { companionOnline: false }
      window.fetch = async (input, init) => {
        const rawUrl = typeof input === 'string' ? input : (input && input.url) || ''
        let pathname = rawUrl
        try { pathname = new URL(rawUrl, location.href).pathname } catch {}
        const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase()
        const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
        if (pathname === '/api/companion/status') {
          return json(window.__stageMock.companionOnline
            ? { online: true, summary: { workers: 1, busy: 0, queued: 0, tasks: [] } }
            : { online: false, summary: null })
        }
        if (pathname === '/api/provision/status') {
          return json({ supported: true, runtime: { installed: true }, profiles: [
            { id: 'essential', label: '基础', ready: true, installed: true, downloadBytes: 0 },
            { id: 'stems', label: '分轨', ready: true, installed: true, downloadBytes: 0 },
          ] })
        }
        if (pathname === '/api/companion/tasks' && method === 'POST') {
          return json({ taskId: 'stage_mock_task', status: 'queued', summary: '排队中' })
        }
        if (pathname.startsWith('/api/companion/tasks/')) {
          return json({ task: { id: 'stage_mock_task', status: 'running', progress: 0.4, queuePosition: 1, estimatedWaitSec: 5, createdAt: Date.now(), updatedAt: Date.now() } })
        }
        return window.__stageOrigFetch(input, init)
      }
      return true
    `)

    await page.evaluate(`
      window.AIAB.audio.runAudioPlan({ mode: 'text_to_audio', caption: 'warm cinematic piano, 72 bpm', durationSec: 6 })
      return true
    `)
    const blockedReached = await waitForJobStatus(page, 'blocked', 12000)
    run.blockedStatus = await page.evaluate(`return document.querySelector('[data-audio-job]')?.getAttribute('data-audio-job-status') ?? null`)
    const blockedInfo = await page.evaluate(`
      const card = document.querySelector('[data-audio-job]')
      return {
        jobId: window.AIAB.useAudioJobStore.getState().job?.id ?? null,
        text: card ? String(card.innerText || '').replace(/\\s+/g, ' ').trim() : '',
        reason: window.AIAB.useAudioJobStore.getState().job?.blockReason ?? null,
      }
    `)
    run.blockedJobId = blockedInfo.jobId
    run.blockedReason = blockedInfo.reason
    run.blockedText = blockedInfo.text.slice(0, 300)
    const blockedShot = pngPath('auto-resume-blocked-1440.png')
    await page.screenshot(blockedShot)
    run.screenshotBlocked = path.relative(ROOT, blockedShot)

    run.checks.push({
      name: '真实 runAudioPlan 进入 blocked/start-companion',
      ok: blockedReached && run.blockedStatus === 'blocked' && blockedInfo.reason === 'start-companion',
      detail: `status=${run.blockedStatus} blockReason=${blockedInfo.reason}`,
      hard: true,
    })

    // 节点上线：任务卡应轮询到并自动续跑
    await page.evaluate('window.__stageMock.companionOnline = true; return true')
    const resumeStarted = Date.now()
    let resumed = false
    let resumedStatus = null
    let resumedJobId = null
    while (Date.now() - resumeStarted < 12000) {
      const snapshot = await page.evaluate(`
        const job = window.AIAB.useAudioJobStore.getState().job
        return { status: document.querySelector('[data-audio-job]')?.getAttribute('data-audio-job-status') ?? null, jobId: job?.id ?? null, storeStatus: job?.status ?? null }
      `)
      resumedStatus = snapshot.status
      resumedJobId = snapshot.jobId
      if (snapshot.status === 'running' && snapshot.storeStatus === 'running') {
        resumed = true
        break
      }
      await sleep(250)
    }
    run.resumedStatus = resumedStatus
    run.resumedJobId = resumedJobId
    run.resumeMs = Date.now() - resumeStarted
    await sleep(500)

    run.metrics = await page.evaluate(`return ${MEASURE}`)
    run.status = run.metrics.status
    const fullFile = pngPath('auto-resume-1440.png')
    await page.screenshot(fullFile)
    run.screenshot = path.relative(ROOT, fullFile)
    if (run.metrics.cardExists) {
      const cardFile = pngPath('auto-resume-1440-card@2x.png')
      try {
        run.cardClip = await captureCard(page, run.metrics.card, cardFile)
        run.cardScreenshot = path.relative(ROOT, cardFile)
        copyFileSync(cardFile, pngPath('auto-resume-card@2x.png'))
        run.cardScreenshotAlias = path.relative(ROOT, pngPath('auto-resume-card@2x.png'))
      } catch (error) {
        run.warnings.push({ name: '卡片裁图失败', detail: error instanceof Error ? error.message : String(error) })
      }
    }

    run.checks.push({
      name: '节点上线后自动续跑（status → running）',
      ok: resumed,
      detail: resumed
        ? `新任务 ${resumedJobId}，${run.resumeMs}ms 内恢复 running`
        : `12s 内未自动恢复（blocked 任务 ${blockedInfo.jobId} 未重试；当前 status=${resumedStatus}）`,
      hard: true,
    })
    const manualChecks = run.checks.slice()
    assertRun(resumed ? { id: 'auto-resume', expectStatus: 'running', textIncludes: [] } : { id: 'auto-resume', expectStatus: 'blocked', textIncludes: [] }, run)
    run.checks = [...manualChecks, ...run.checks]
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error)
    run.checks.push({ name: 'auto-resume 执行', ok: false, detail: run.error, hard: true })
    run.failures = run.checks.filter((check) => check.hard && !check.ok)
    run.pass = false
  } finally {
    try {
      await page.evaluate(`
        if (window.__stageOrigFetch) {
          window.fetch = window.__stageOrigFetch
          delete window.__stageOrigFetch
        }
        delete window.__stageMock
        window.AIAB.useAudioJobStore.getState().clear()
        return true
      `)
    } catch {
      /* ignore */
    }
    run.consoleErrors = page.consoleErrors.slice(consoleStart).filter((text) => !NOISE_RE.test(text))
    run.durationMs = Date.now() - startedAt
  }

  if (!run.error) {
    run.failures = run.checks.filter((check) => check.hard && !check.ok)
    run.pass = run.failures.length === 0
  }
  return run
}

/* ------------------------------------------------------------------ */
/* dry-run：不启动浏览器，仅校验注入脚本语法并打印状态/注入片段摘要     */
/* ------------------------------------------------------------------ */

function compileSnippet(label, source) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(source)
    return { label, ok: true }
  } catch (error) {
    return { label, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function dryRun() {
  console.log(`${C.bold}dry-run：校验注入脚本语法 + 状态清单${C.reset}`)
  const checks = [
    compileSnippet('RESET', RESET),
    compileSnippet('COMPACT_INFO', `return ${COMPACT_INFO}`),
    compileSnippet('MEASURE', `return ${MEASURE}`),
  ]
  for (const state of STATES) {
    if (state.setup) checks.push(compileSnippet(`setup:${state.id}`, state.setup))
  }
  let bad = 0
  for (const item of checks) {
    if (item.ok) {
      console.log(`  ${C.green}✓${C.reset} ${item.label}`)
    } else {
      bad++
      console.log(`  ${C.red}✗${C.reset} ${item.label} — ${item.error}`)
    }
  }
  console.log('')
  console.log(`${C.bold}状态清单（${STATES.length}）${C.reset}`)
  for (const state of STATES) {
    const viewports = state.viewports ? state.viewports.join('/') : WIDTHS.join('/')
    console.log(
      `  ${state.id.padEnd(22)} ${String(state.expectStatus).padEnd(8)} 宽度 ${viewports}${state.custom ? ` · custom=${state.custom}` : ''}${state.reducedMotion ? ' · reduced-motion' : ''}`,
    )
  }
  console.log('')
  console.log(`${C.bold}注入片段（页面内执行）${C.reset}`)
  for (const state of STATES) {
    if (!state.setup) continue
    console.log(`\n${C.gold}--- ${state.id}（期望 status=${state.expectStatus}）---${C.reset}`)
    console.log(state.setup.trim())
  }
  console.log(`\n${bad ? C.red : C.green}dry-run ${bad ? `失败 ${bad} 项` : '全部通过'}${C.reset}`)
  if (bad) process.exitCode = 1
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function printRun(run) {
  const head = `[${run.state}] ${run.width}x${run.height}`
  const card = run.metrics && run.metrics.card ? `卡 ${run.metrics.card.width}x${run.metrics.card.height} @(${run.metrics.card.x},${run.metrics.card.y})` : '无卡片'
  const tag = run.pass ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`
  const failCount = run.failures ? run.failures.length : 0
  console.log(`${tag} ${head} ${C.dim}${card} · 断言 ${run.checks.length} · FAIL ${failCount}${C.reset}`)
  for (const check of run.checks) {
    if (!check.ok && check.hard) console.log(`   ${C.red}✗ ${check.name}${C.reset}${check.detail ? ` ${C.dim}${check.detail}${C.reset}` : ''}`)
  }
  for (const warning of run.warnings || []) {
    console.log(`   ${C.gold}! ${warning.name}${C.reset}${warning.detail ? ` ${C.dim}${warning.detail}${C.reset}` : ''}`)
  }
}

async function main() {
  if (process.env.STAGE_DRY_RUN === '1') {
    dryRun()
    return
  }
  if (!SKIP_BUILD) await runBuild()
  mkdirSync(OUT_DIR, { recursive: true })
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

  const startedAll = Date.now()
  console.log(`${C.dim}静态服务端口 8945 · dataDir=${DATA_DIR} · outDir=${OUT_DIR}${C.reset}`)
  const server = await startStaticServer({ preferredPort: 8945, dataDir: DATA_DIR })
  console.log(`${C.dim}服务已启动：${server.base}${C.reset}`)
  await configurePlaceholderProvider(server.base)
  const page = await launchChrome({ dataDir: server.dataDir })

  const runs = []
  try {
    const runnable = STATES.filter((state) => wantState(state.id))

    /* 1) 常规状态 × 宽度 */
    for (const width of WIDTHS) {
      const height = heightFor(width)
      await loadAt(page, server.base, width, height)
      for (const state of runnable) {
        if (state.custom === 'compact' || state.custom === 'auto-resume' || state.reducedMotion) continue
        if (state.viewports && !state.viewports.includes(width)) continue
        const run = await runState(page, server.base, state, width, height)
        runs.push(run)
        printRun(run)
      }
    }

    /* 2) compact 面板 */
    const compactState = runnable.find((state) => state.custom === 'compact')
    if (compactState) {
      const run = await runState(page, server.base, compactState, 1440, 760)
      runs.push(run)
      printRun(run)
      if (run.compactFallback) console.log(`   ${C.gold}! compact 在 1440x760 未触发${C.reset} ${C.dim}${run.compactFallback.reason}；已改用 ${run.compactFallback.to.join('x')}${C.reset}`)
    }

    /* 3) reduced-motion */
    const reducedState = runnable.find((state) => state.reducedMotion)
    if (reducedState) {
      await loadAt(page, server.base, 1440, 900)
      const run = await runState(page, server.base, reducedState, 1440, 900)
      runs.push(run)
      printRun(run)
    }

    /* 4) auto-resume */
    const autoState = runnable.find((state) => state.custom === 'auto-resume')
    if (autoState) {
      const run = await runAutoResume(page, server.base)
      runs.push(run)
      printRun(run)
    }
  } finally {
    page.close()
    server.child.kill('SIGKILL')
    await sleep(250)
  }

  /* 汇总 */
  const failures = runs.flatMap((run) =>
    (run.failures || []).map((failure) => ({
      state: run.state,
      width: run.width,
      height: run.height,
      check: failure.name,
      detail: failure.detail,
    })),
  )
  const warnings = runs.flatMap((run) =>
    (run.warnings || []).map((warning) => ({
      state: run.state,
      width: run.width,
      height: run.height,
      check: warning.name,
      detail: warning.detail,
    })),
  )
  const report = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAll,
    base: server.base,
    dataDir: DATA_DIR,
    outDir: path.relative(ROOT, OUT_DIR),
    widths: WIDTHS,
    states: runs.map((run) => run.state),
    summary: {
      total: runs.length,
      passed: runs.filter((run) => run.pass).length,
      failed: runs.filter((run) => !run.pass).length,
      failures,
      warnings,
    },
    runs,
  }
  writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2))

  console.log('')
  console.log(
    `${C.bold}音频生成舞台验收${C.reset}：${runs.length} 个状态 × 宽度组合，通过 ${C.green}${report.summary.passed}${C.reset}，失败 ${C.red}${report.summary.failed}${C.reset}`,
  )
  if (failures.length) {
    console.log(`${C.bold}FAIL 清单（${failures.length}）${C.reset}`)
    for (const failure of failures) {
      console.log(`  ${C.red}✗ [${failure.state}] ${failure.width}x${failure.height} · ${failure.check}${C.reset}${failure.detail ? ` ${C.dim}${failure.detail}${C.reset}` : ''}`)
    }
  }
  if (warnings.length) {
    console.log(`${C.bold}软检查提示（${warnings.length}，不计 FAIL）${C.reset}`)
    for (const warning of warnings.slice(0, 20)) {
      console.log(`  ${C.gold}! [${warning.state}] ${warning.width}px · ${warning.check}${warning.detail ? ` ${C.dim}${warning.detail}${C.reset}` : ''}`)
    }
  }
  console.log(`${C.dim}截图：${path.relative(ROOT, OUT_DIR)}/<state>-<width>.png 与 <state>-<width>-card@2x.png · 报告：${path.relative(ROOT, OUT_DIR)}/report.json${C.reset}`)
  if (report.summary.failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
