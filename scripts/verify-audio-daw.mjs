#!/usr/bin/env node
/**
 * DAW「生成中轨道 + 自动落轨」验收（真实 headless Chrome + 真实静态服务）。
 *
 *   node scripts/verify-audio-daw.mjs
 *   DAW_SKIP_BUILD=1 node scripts/verify-audio-daw.mjs
 *   DAW_STATES=running,blocked,placed DAW_OUT_DIR=.verify-audio-daw node scripts/verify-audio-daw.mjs
 *
 * 覆盖用户反馈的两个问题：
 *   1. 生成一开始就必须在 DAW 里看到「音频轨 + 炫酷生成特效」，
 *      阻塞 / 失败时占位轨也要给出对应状态；
 *   2. 生成完成后分轨必须真正落成可播放的音频轨，并且自动定位到新轨；
 *      同时验证占位轨不会污染工程 / 不留下空轨。
 *
 * 落轨流程用 mock fetch 模拟 Companion（任务 / 遥测 / 峰值），不依赖真实 GPU。
 *
 * 产物：
 *   .verify-audio-daw/running-1440.png
 *   .verify-audio-daw/blocked-1440.png
 *   .verify-audio-daw/failed-1440.png
 *   .verify-audio-daw/placed-1440.png
 *   .verify-audio-daw/report.json
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { ROOT, sleep, startStaticServer, launchChrome, configurePlaceholderProvider } from './lib/browser-harness.mjs'

const OUT_DIR = path.join(ROOT, process.env.DAW_OUT_DIR || '.verify-audio-daw')
const SKIP_BUILD = process.env.DAW_SKIP_BUILD === '1'
const ONLY = (process.env.DAW_STATES || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const want = (id) => ONLY.length === 0 || ONLY.includes(id)

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

function runBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs')], { cwd: ROOT, stdio: 'ignore' })
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('build failed'))))
  })
}

const PNG = (name) => path.join(OUT_DIR, name)

/* ------------------------------------------------------------------ */
/* 页面内脚本                                                          */
/* ------------------------------------------------------------------ */

const SLOTS_SCRIPT = `
  const slots = [
    { key: 'song', name: '生成 · 热血 J-ROCK', label: '整曲', role: 'song', color: '#3ddbd9', startBeat: 4, durationSec: 24 },
    { key: 'stem:drums', name: 'Stem · 鼓组', label: '鼓组', role: 'stem', color: '#f472b6', startBeat: 4, durationSec: 24 },
    { key: 'stem:bass', name: 'Stem · 贝斯', label: '贝斯', role: 'stem', color: '#8b7bff', startBeat: 4, durationSec: 24 },
    { key: 'stem:guitar', name: 'Stem · 吉他', label: '吉他', role: 'stem', color: '#a3e635', startBeat: 4, durationSec: 24 },
    { key: 'stem:vocals', name: 'Stem · 人声', label: '人声', role: 'stem', color: '#f0b429', startBeat: 4, durationSec: 24 },
  ]
  const steps = [
    { key: 'song', label: '生成整曲音频' },
    { key: 'stem:drums', label: '分轨 · 鼓组' },
    { key: 'stem:bass', label: '分轨 · 贝斯' },
    { key: 'stem:guitar', label: '分轨 · 吉他' },
    { key: 'stem:vocals', label: '分轨 · 人声' },
  ]
  const store = window.AIAB.useAudioJobStore.getState()
  store.clear()
  store.start({
    mode: 'audio_with_stems',
    title: '热血 J-ROCK 分轨',
    caption: 'j-rock, 170 bpm',
    steps,
    slots,
  })
  store.updateStep('song', { status: 'done', progress: 1, startedAt: Date.now() - 22000 })
  store.removeSlot('song')
  store.updateStep('stem:drums', { status: 'running', progress: 0.62, startedAt: Date.now() - 9000 })
  store.update({
    taskId: 'daw_demo_task',
    telemetry: {
      phase: 'sampling', phaseLabel: '扩散采样', step: 31, stepTotal: 50, speed: 2.4, estimated: true,
      cpuPct: 132, rssMb: 2410, gpuName: 'NVIDIA GeForce RTX 4090', gpuUtilPct: 86,
      vramUsedMb: 7108, vramTotalMb: 24564, gpuTempC: 67,
      engine: { state: 'busy', variant: 'turbo', device: 'CUDA0', warm: true, pid: 4213 },
    },
  })
  return true
`

const MOCK_FETCH = `
  window.__mock = { seq: 0, tasks: {} }
  const realFetch = window.fetch.bind(window)
  const sendJson = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    const method = ((init && init.method) || (typeof input === 'string' ? 'GET' : input.method) || 'GET').toUpperCase()
    if (url.includes('/api/companion/status')) {
      return sendJson({
        summary: { workers: 1, queued: 0, running: 1, done: 3, failed: 0 },
        online: true,
        workers: [{
          id: 'mock-worker', name: 'Mock GPU', busy: true,
          status: { busy: true, engine: { state: 'busy', variant: 'turbo', device: 'CUDA0', warm: true, pid: 9001 } },
        }],
        tasks: [],
      })
    }
    if (url.endsWith('/api/companion/tasks') && method === 'POST') {
      const body = JSON.parse(init.body)
      const id = 'mock_task_' + (++window.__mock.seq)
      window.__mock.tasks[id] = { type: body.type, params: body.params || {}, polls: 0 }
      return sendJson({ taskId: id, status: 'queued', summary: 'mock task' })
    }
    const taskMatch = url.match(/\\/api\\/companion\\/tasks\\/([^/]+)$/)
    if (taskMatch) {
      const id = decodeURIComponent(taskMatch[1])
      const task = window.__mock.tasks[id]
      if (!task) return sendJson({ error: 'unknown mock task' }, 404)
      task.polls += 1
      if (task.polls < 2) {
        return sendJson({
          task: {
            id, status: 'running', progress: 0.42, phase: 'sampling', phaseLabel: '扩散采样',
            step: 21, stepTotal: 50, speed: 2.1, estimated: true,
            worker: { name: 'Mock GPU', status: { engine: { state: 'busy', variant: 'turbo', device: 'CUDA0', warm: true } } },
            telemetry: { cpuPct: 118, rssMb: 2200, gpuUtilPct: 91, vramUsedMb: 7600, vramTotalMb: 24564, gpuTempC: 70 },
          },
        })
      }
      return sendJson({
        task: { id, status: 'done', progress: 1, assetId: 'mock_asset_' + id, message: '生成完成' },
      })
    }
    const peakMatch = url.match(/\\/api\\/assets\\/([^/]+)\\/peaks/)
    if (peakMatch) {
      const id = decodeURIComponent(peakMatch[1])
      const peaks = Array.from({ length: 1024 }, (_, index) => {
        const envelope = 0.28 + 0.72 * Math.abs(Math.sin(index / 23))
        return (index % 2 === 0 ? -1 : 1) * envelope
      })
      return sendJson({ id, durationSec: 20, sampleRate: 44100, channels: 2, peaks })
    }
    return realFetch(input, init)
  }
  return true
`

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  if (!SKIP_BUILD) {
    console.log(`${C.dim}构建前后端…${C.reset}`)
    await runBuild()
  }
  mkdirSync(OUT_DIR, { recursive: true })

  const server = await startStaticServer({ preferredPort: 8965 })
  await configurePlaceholderProvider(server.base)
  const page = await launchChrome({ dataDir: server.dataDir })
  try {
    await page.setViewport(1440, 900)
    await page.goto(`${server.base}/?intro=0`)
    await page.waitFor('window.AIAB && document.querySelector("[data-track-row]")', 30000)
    await sleep(600)

    const baseline = await page.evaluate(`
      return {
        tracks: window.AIAB.useStore.getState().project.tracks.length,
        audioTracks: window.AIAB.useStore.getState().project.tracks.filter((t) => t.kind === 'audio').length,
      }
    `)

    /* ---------------- 1. 运行中：占位轨 + 特效 ---------------- */
    if (want('running')) {
      await page.evaluate(`${SLOTS_SCRIPT}; ${MOCK_FETCH}`)
      await sleep(900)
      await page.screenshot(PNG('running-1440.png'))

      await check('生成开始时 DAW 立刻出现占位音频轨（车道 + 轨道头）', async () => {
        const state = await page.evaluate(`
          const lanes = [...document.querySelectorAll('[data-gen-track-lane]')]
          const heads = [...document.querySelectorAll('[data-gen-track-header]')]
          const clips = [...document.querySelectorAll('[data-gen-track-clip]')]
          return {
            lanes: lanes.length,
            heads: heads.length,
            clips: clips.length,
            projectTracks: window.AIAB.useStore.getState().project.tracks.length,
            names: heads.map((el) => el.textContent.replace(/\\s+/g, ' ').trim()),
          }
        `)
        if (state.lanes !== 4) throw new Error(`占位车道 ${state.lanes} 条（期望 4）`)
        if (state.heads !== 4) throw new Error(`占位轨道头 ${state.heads} 条（期望 4）`)
        if (state.clips !== 4) throw new Error(`占位片段 ${state.clips} 个（期望 4）`)
        if (state.projectTracks !== baseline.tracks) throw new Error('占位轨被写进了工程（不应该）')
        return `4 条占位轨，工程轨道数保持 ${state.projectTracks}`
      })

      await check('占位轨左右两侧严格对齐', async () => {
        const rows = await page.evaluate(`
          const lanes = [...document.querySelectorAll('[data-gen-track-lane]')]
          const heads = [...document.querySelectorAll('[data-gen-track-header]')]
          return lanes.map((lane, index) => ({
            lane: lane.getBoundingClientRect().top,
            head: heads[index] ? heads[index].getBoundingClientRect().top : null,
          }))
        `)
        const misaligned = rows.filter((row) => row.head == null || Math.abs(row.lane - row.head) > 1)
        if (misaligned.length) throw new Error(JSON.stringify(misaligned))
        return `4/4 行 top 完全对齐（±1px）`
      })

      await check('占位片段按开始拍 / 时长落在时间轴上', async () => {
        const geometry = await page.evaluate(`
          const clip = document.querySelector('[data-gen-track-clip]')
          const lane = clip?.parentElement
          const project = window.AIAB.useStore.getState().project
          const width = clip ? clip.getBoundingClientRect().width : 0
          const lengthBeats = (24 / 60) * project.tempo
          return {
            left: clip ? clip.getBoundingClientRect().left - lane.getBoundingClientRect().left : -1,
            width,
            startBeat: 4,
            durationSec: 24,
            tempo: project.tempo,
            pxPerBeat: width / lengthBeats,
          }
        `)
        const expectedLeft = geometry.startBeat * geometry.pxPerBeat
        if (geometry.left < expectedLeft - 3 || geometry.left > expectedLeft + 8) {
          throw new Error(`片段 left=${geometry.left}，期望约 ${expectedLeft}`)
        }
        if (geometry.width < 30) throw new Error(`片段宽 ${geometry.width}，不可见`)
        return `left=${Math.round(geometry.left)}px · width=${Math.round(geometry.width)}px`
      })

      await check('生成特效在运行：扫描光带 / 波形 / 轨道头频谱都有动画', async () => {
        const animations = await page.evaluate(`
          const pick = (selector) => {
            const el = document.querySelector(selector)
            return el ? getComputedStyle(el).animationName : null
          }
          return {
            sweep: pick('.genlane-sweep'),
            bar: pick('.genlane-bar'),
            aurora: pick('.genlane-aurora'),
            headerEq: pick('.genhead-eq span'),
            hud: Boolean(document.querySelector('[data-gen-track-clip] .genlane-pct')),
          }
        `)
        for (const [key, value] of Object.entries(animations)) {
          if (key === 'hud') continue
          if (!value || value === 'none') throw new Error(`${key} 没有动画（${value}）`)
        }
        if (!animations.hud) throw new Error('占位片段缺少百分比 HUD')
        return 'sweep / bars / aurora / header eq 全部在动'
      })

      await check('轨道面板显示 AI 徽标与生成进度', async () => {
        const text = await page.evaluate(`
          const head = document.querySelector('[data-gen-track-header]')
          return head ? head.textContent.replace(/\\s+/g, ' ').trim() : ''
        `)
        if (!text.includes('AI')) throw new Error(`缺少 AI 徽标：${text}`)
        if (!text.includes('62%')) throw new Error(`缺少进度：${text}`)
        if (!text.includes('Stem · 鼓组')) throw new Error(`缺少轨道名：${text}`)
        return text.slice(0, 60)
      })

      await check('占位轨可见（自动滚入视野）', async () => {
        const visible = await page.evaluate(`
          const lanes = [...document.querySelectorAll('[data-gen-track-lane]')]
          const view = document.querySelector('[data-arrangement-view]')?.getBoundingClientRect()
          return lanes.map((lane) => {
            const rect = lane.getBoundingClientRect()
            return view ? rect.bottom > view.top && rect.top < view.bottom : false
          })
        `)
        if (!visible.every(Boolean)) throw new Error(JSON.stringify(visible))
        return '4/4 条占位车道在视口内'
      })

      await check('reduced-motion 下生成轨保留静态信息（不依赖动画）', async () => {
        await page.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        })
        await sleep(250)
        const state = await page.evaluate(`
          const pick = (selector) => {
            const el = document.querySelector(selector)
            return el ? getComputedStyle(el).animationName : null
          }
          return {
            sweep: pick('.genlane-sweep'),
            bar: pick('.genlane-bar'),
            aurora: pick('.genlane-aurora'),
            headEq: pick('.genhead-eq span'),
            title: document.querySelector('.genlane-title')?.textContent || '',
            percent: Boolean(document.querySelector('.genhead-pct')),
          }
        `)
        await page.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
        })
        for (const key of ['sweep', 'bar', 'aurora', 'headEq']) {
          if (state[key] && state[key] !== 'none') throw new Error(`${key} 仍在动画：${state[key]}`)
        }
        if (!state.title.includes('AI 正在生成')) throw new Error('静态态标题丢失')
        if (!state.percent) throw new Error('静态态百分比丢失')
        return '动画关闭 · 标题 / 百分比仍在'
      })

      await check('收起任务卡不会中断生成，轨道头可恢复任务卡', async () => {
        await page.evaluate(`
          document.querySelector('[data-audio-job] button[aria-label="关闭音频任务卡"]')?.click()
          return true
        `)
        await sleep(250)
        const hiddenState = await page.evaluate(`
          return {
            card: Boolean(document.querySelector('[data-audio-job]')),
            lanes: document.querySelectorAll('[data-gen-track-lane]').length,
            jobStatus: window.AIAB.useAudioJobStore.getState().job?.status,
            hidden: window.AIAB.useAudioJobStore.getState().hidden,
            restore: Boolean(document.querySelector('[data-gen-track-header] .genhead-focus')),
          }
        `)
        if (hiddenState.card) throw new Error('任务卡没有收起')
        if (hiddenState.lanes !== 4) throw new Error('收起任务卡后占位轨消失了')
        if (hiddenState.jobStatus !== 'running') throw new Error(`任务被中断：${hiddenState.jobStatus}`)
        if (!hiddenState.hidden) throw new Error('hidden 标记未写入')
        if (!hiddenState.restore) throw new Error('轨道头没有恢复入口')
        await page.evaluate(`
          document.querySelector('[data-gen-track-header] .genhead-focus')?.click()
          return true
        `)
        await sleep(250)
        const restored = await page.evaluate(`return Boolean(document.querySelector('[data-audio-job]'))`)
        if (!restored) throw new Error('任务卡没有恢复')
        return '收起 / 恢复均不打断任务'
      })
    }

    /* ---------------- 1b. 紧凑行高 ---------------- */
    if (want('compact')) {
      await page.evaluate(`${SLOTS_SCRIPT}; ${MOCK_FETCH}`)
      await page.evaluate(`
        window.AIAB.useStore.getState().setZoom(undefined, 9)
        return true
      `)
      await sleep(500)
      await page.screenshot(PNG('compact-1440.png'))
      await check('折叠行高下占位轨仍完整可读（无裁切 / 无溢出）', async () => {
        const state = await page.evaluate(`
          const lane = document.querySelector('[data-gen-track-lane]')
          const clip = lane?.querySelector('[data-gen-track-clip]')
          const title = clip?.querySelector('.genlane-title')
          const head = document.querySelector('[data-gen-track-header]')
          const panel = document.querySelector('[data-track-panel]')
          return {
            laneHeight: lane ? lane.getBoundingClientRect().height : 0,
            clipHeight: clip ? clip.getBoundingClientRect().height : 0,
            title: title ? title.textContent.trim() : '',
            titleOverflow: title ? title.scrollWidth - title.clientWidth : 999,
            headHeight: head ? head.getBoundingClientRect().height : 0,
            metaVisible: Boolean(head?.querySelector('.genhead-meta')),
            panelOverflow: panel ? panel.scrollWidth - panel.clientWidth : 999,
          }
        `)
        if (state.laneHeight > 40) throw new Error(`折叠行高 ${state.laneHeight}`)
        if (state.clipHeight < 24) throw new Error(`片段高度 ${state.clipHeight}`)
        if (!state.title.includes('AI 正在生成')) throw new Error(`标题被裁：${state.title}`)
        if (state.titleOverflow > 1) throw new Error(`标题溢出 ${state.titleOverflow}px`)
        if (state.metaVisible) throw new Error('折叠时仍渲染副文案')
        if (state.panelOverflow > 1) throw new Error(`轨道面板横向溢出 ${state.panelOverflow}px`)
        return `行高 ${state.laneHeight} · 片段 ${state.clipHeight} · 标题无溢出`
      })
      await page.evaluate(`
        window.AIAB.useStore.getState().setZoom(undefined, 16)
        return true
      `)
    }

    /* ---------------- 2. 阻塞 ---------------- */
    if (want('blocked')) {
      await page.evaluate(`${SLOTS_SCRIPT}; ${MOCK_FETCH}`)
      await page.evaluate(`
        const store = window.AIAB.useAudioJobStore.getState()
        store.finish('blocked', {
          blockReason: 'start-companion',
          error: '本机模型已安装，但生成节点（Companion）未启动。',
          hint: 'node scripts/companion.mjs --server http://127.0.0.1:8787 --acestep',
          retryable: true,
        })
        return true
      `)
      await sleep(500)
      await page.screenshot(PNG('blocked-1440.png'))
      await check('阻塞时占位轨保留并显示「等待生成节点」', async () => {
        const state = await page.evaluate(`
          return {
            lanes: document.querySelectorAll('[data-gen-track-lane]').length,
            blocked: document.querySelectorAll('[data-gen-slot-status="blocked"]').length,
            text: document.querySelector('[data-gen-track-clip]')?.textContent.replace(/\\s+/g, ' ').trim() || '',
            projectTracks: window.AIAB.useStore.getState().project.tracks.length,
          }
        `)
        if (state.lanes !== 4) throw new Error(`占位车道 ${state.lanes}`)
        if (state.blocked < 4) throw new Error(`blocked 状态 ${state.blocked}`)
        if (!state.text.includes('等待生成节点')) throw new Error(`文案：${state.text}`)
        if (state.projectTracks !== baseline.tracks) throw new Error('占位轨污染工程')
        return '4 条占位轨保持等待态'
      })
    }

    /* ---------------- 3. 失败 ---------------- */
    if (want('failed')) {
      await page.evaluate(`${SLOTS_SCRIPT}; ${MOCK_FETCH}`)
      await page.evaluate(`
        window.AIAB.useAudioJobStore.getState().finish('failed', { error: '引擎采样中断（CUDA out of memory）', retryable: true })
        return true
      `)
      await sleep(400)
      await page.screenshot(PNG('failed-1440.png'))
      await check('失败时占位轨就地显示失败态，不消失', async () => {
        const state = await page.evaluate(`
          return {
            lanes: document.querySelectorAll('[data-gen-track-lane]').length,
            failed: document.querySelectorAll('[data-gen-slot-status="failed"]').length,
            canceled: document.querySelectorAll('[data-gen-slot-status="canceled"]').length,
            text: document.querySelector('[data-gen-track-clip]')?.textContent.replace(/\\s+/g, ' ').trim() || '',
          }
        `)
        if (state.lanes !== 4) throw new Error(`占位车道 ${state.lanes}`)
        if (state.failed < 1) throw new Error('没有 failed 状态')
        if (!state.text.includes('生成中断')) throw new Error(`文案：${state.text}`)
        return `failed=${state.failed} · canceled=${state.canceled}`
      })
    }

    /* ---------------- 4. 分轨生成完成 → 自动落轨 ---------------- */
    if (want('placed')) {
      await page.evaluate(`
        window.AIAB.useAudioJobStore.getState().clear()
        return true
      `)
      await page.evaluate(MOCK_FETCH)
      await page.evaluate(`
        window.__dawFlow = { done: false, error: null }
        window.AIAB.audio.runAudioPlan({
          mode: 'audio_with_stems',
          caption: 'mock j-rock, driving guitars, tight drums',
          bpm: 170,
          durationSec: 20,
          stems: ['drums', 'bass', 'guitar'],
          startBeat: 0,
        }).then(() => { window.__dawFlow.done = true }).catch((error) => {
          window.__dawFlow.error = String(error && error.message || error)
          window.__dawFlow.done = true
        })
        return true
      `)

      await page.waitFor('document.querySelectorAll("[data-gen-track-lane]").length >= 4', 15000)
      await sleep(500)
      await page.screenshot(PNG('placed-running-1440.png'))
      await check('真实生成流程中：占位轨先出现，工程此时还没有音频轨', async () => {
        const state = await page.evaluate(`
          const project = window.AIAB.useStore.getState().project
          return {
            lanes: document.querySelectorAll('[data-gen-track-lane]').length,
            audioTracks: project.tracks.filter((t) => t.kind === 'audio').length,
            jobStatus: document.querySelector('[data-audio-job]')?.getAttribute('data-audio-job-status'),
          }
        `)
        if (state.lanes < 4) throw new Error(`占位轨 ${state.lanes}`)
        if (state.audioTracks > baseline.audioTracks) throw new Error('占位阶段不应已有真实音频轨')
        return `4 条占位轨 · 任务 ${state.jobStatus}`
      })

      await page.waitFor('window.__dawFlow.done === true', 60000)
      const flow = await page.evaluate(`return window.__dawFlow`)
      if (flow.error) throw new Error(`音频流程失败：${flow.error}`)
      await sleep(900)
      await page.screenshot(PNG('placed-1440.png'))

      await check('生成完成后：整曲 + 3 条分轨全部落成真实音频轨', async () => {
        const state = await page.evaluate(`
          const project = window.AIAB.useStore.getState().project
          const tracks = project.tracks.slice(-4).map((track) => ({
            name: track.name,
            kind: track.kind,
            clips: track.audioClips.length,
            assetIds: track.audioClips.map((clip) => clip.assetId),
            color: track.color,
            durationSec: track.audioClips[0]?.durationSec ?? 0,
          }))
          return {
            total: project.tracks.length,
            assets: project.assets.length,
            lanes: document.querySelectorAll('[data-gen-track-lane]').length,
            placed: window.AIAB.useAudioJobStore.getState().job?.placed || [],
            tracks,
            jobStatus: window.AIAB.useAudioJobStore.getState().job?.status,
          }
        `)
        if (state.total !== baseline.tracks + 4) throw new Error(`轨道数 ${state.total}（期望 ${baseline.tracks + 4}）`)
        if (state.assets < 4) throw new Error(`资产登记 ${state.assets}（期望 ≥4）`)
        if (state.lanes !== 0) throw new Error(`占位轨未退场：还剩 ${state.lanes}`)
        if (state.tracks.some((track) => track.kind !== 'audio' || track.clips !== 1)) {
          throw new Error(`音频轨不完整：${JSON.stringify(state.tracks)}`)
        }
        const names = state.tracks.map((track) => track.name)
        if (!names.includes('生成 · mock j-rock, driving')) throw new Error(`缺少整曲轨：${names.join(' / ')}`)
        for (const label of ['鼓组', '贝斯', '吉他']) {
          if (!names.includes(`Stem · ${label}`)) throw new Error(`缺少分轨 ${label}：${names.join(' / ')}`)
        }
        if (new Set(state.tracks.map((track) => track.color)).size < 3) throw new Error('轨道配色没有区分度')
        if (state.jobStatus !== 'done') throw new Error(`任务状态 ${state.jobStatus}`)
        return `${state.total} 轨 · 4 条音频轨各有 1 个片段 · 资产 ${state.assets}`
      })

      await check('落轨后自动定位：新音频轨在视野内且被选中', async () => {
        const state = await page.evaluate(`
          const store = window.AIAB.useStore.getState()
          const selected = store.selectedTrackId
          const track = store.project.tracks.find((t) => t.id === selected)
          const row = [...document.querySelectorAll('[data-track-row]')].find((el) => el.getAttribute('data-track-id') === selected)
          const view = document.querySelector('[data-arrangement-view]')?.getBoundingClientRect()
          const rect = row?.getBoundingClientRect()
          return {
            selected,
            selectedName: track?.name || '',
            visible: Boolean(rect && view && rect.bottom > view.top && rect.top < view.bottom),
            revealToken: store.revealRequest?.token ?? 0,
            scrollTop: document.querySelector('[data-arrangement-view] .overflow-auto')?.scrollTop ?? -1,
          }
        `)
        if (!state.selectedName.startsWith('Stem ·')) throw new Error(`选中的不是最后落轨的分轨：${state.selectedName}`)
        if (!state.visible) throw new Error('新轨道不在视野内')
        if (state.revealToken < 1) throw new Error('没有发出 reveal 请求')
        return `${state.selectedName} · reveal#${state.revealToken}`
      })

      await check('工程已自动保存（音频轨 / 资产会持久化）', async () => {
        const state = await page.evaluate(`
          await new Promise((resolve) => setTimeout(resolve, 2200))
          const store = window.AIAB.useStore.getState()
          const response = await fetch('/api/projects/' + store.project.id)
          const saved = await response.json()
          return {
            saveStatus: store.saveStatus,
            savedTracks: saved.tracks?.length ?? 0,
            savedAssets: saved.assets?.length ?? 0,
            savedAudioClips: (saved.tracks || []).reduce((sum, track) => sum + (track.audioClips?.length || 0), 0),
          }
        `)
        if (state.saveStatus === 'error') throw new Error('保存失败')
        if (state.savedAudioClips < 1) throw new Error(`服务端没有音频片段：${JSON.stringify(state)}`)
        return `savedTracks=${state.savedTracks} · audioClips=${state.savedAudioClips} · assets=${state.savedAssets}`
      })
    }

    await check('控制台无未预期错误', async () => {
      const errors = page.consoleErrors.filter(
        (text) => !/AudioContext|autoplay|MIDI|favicon|Web MIDI|polyphony|SoundFont|AudioWorkletNode/i.test(text),
      )
      if (errors.length) throw new Error(errors.slice(0, 3).join(' | '))
      return '0 条错误'
    })
  } finally {
    page.close()
    server.child.kill('SIGKILL')
    await sleep(200)
  }

  writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), passed, failed, failures }, null, 2),
  )
  console.log(`\n${C.bold}DAW 生成轨验收${C.reset}：通过 ${C.green}${passed}${C.reset}，失败 ${C.red}${failed}${C.reset}`)
  console.log(`${C.dim}截图：${path.relative(ROOT, OUT_DIR)}/*.png${C.reset}`)
  if (failed > 0) {
    for (const failure of failures) console.log(`  ${C.red}${failure}${C.reset}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
