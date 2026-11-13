#!/usr/bin/env node
/**
 * AI 音频意图验收（P9）：真实浏览器 + 真实静态服务。
 *
 *   node scripts/verify-audio-intent.mjs
 *   AUDIO_VERIFY_SKIP_BUILD=1 node scripts/verify-audio-intent.mjs
 *
 * 覆盖：
 *   1. 音频意图识别（正例 / 负例）
 *   2. AI 面板输入框：高度 >= 3 行、宽度撑满容器（用户反馈的 Textfield 问题）
 *   3. 顶栏不再有「生成音频」孤立入口；音频入口在 AI 面板的音频引擎菜单里
 *   4. 缺本机模型时：自动弹出「安装本机引擎」对话框并展示原因；分轨模式预选 stems
 *   5. MIDI -> 音频：浏览器离线渲染当前工程 -> 上传 -> 自动新增一条音频轨
 *
 * 产物：.verify-audio/*.png
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { ROOT, sleep, startStaticServer, launchChrome, configurePlaceholderProvider } from './lib/browser-harness.mjs'

const OUT_DIR = path.join(ROOT, '.verify-audio')
const DATA_DIR = path.join(ROOT, '.cache', 'audio-verify-data')
const SKIP_BUILD = process.env.AUDIO_VERIFY_SKIP_BUILD === '1'

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

function prepareDataDir() {
  if (!existsSync(path.join(DATA_DIR, 'projects'))) {
    if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true })
    mkdirSync(DATA_DIR, { recursive: true })
    const source = path.join(ROOT, 'data')
    const copyDir = (from, to) => {
      if (existsSync(from)) cpSync(from, to, { recursive: true, force: true })
    }
    const settings = path.join(source, 'settings.json')
    if (existsSync(settings)) cpSync(settings, path.join(DATA_DIR, 'settings.json'))
    copyDir(path.join(source, 'projects'), path.join(DATA_DIR, 'projects'))
    copyDir(path.join(source, 'assets'), path.join(DATA_DIR, 'assets'))
    copyDir(path.join(source, 'soundfonts'), path.join(DATA_DIR, 'soundfonts'))
  }
  return DATA_DIR
}

const PNG = (name) => path.join(OUT_DIR, name)

async function main() {
  if (!SKIP_BUILD) {
    console.log(`${C.dim}构建前后端…${C.reset}`)
    await runBuild()
  }
  mkdirSync(OUT_DIR, { recursive: true })
  const dataDir = prepareDataDir()

  const server = await startStaticServer({ preferredPort: 8960, dataDir })
  await configurePlaceholderProvider(server.base)
  const page = await launchChrome({ dataDir: server.dataDir })
  try {
    await page.setViewport(1440, 900)
    await page.goto(`${server.base}/?intro=0`)
    await page.waitFor('window.AIAB && window.AIAB.audio && document.querySelector("[data-track-row]")', 30000)
    await sleep(700)

    await check('音频意图识别：正例命中、负例不误判', async () => {
      const result = await page.evaluate(`
        const cases = [
          ['生成一首 30 秒 cinematic 音频', true],
          ['把当前编曲渲染成音频并分轨', true],
          ['导出成 wav 给我', true],
          ['生成整曲然后分轨', true],
          ['用 AI 引擎把这个编曲渲染成高品质成品', true],
          ['别只是把 MIDI 转成音频，用 AI 重编成摇滚版', true],
          ['帮我换编制，做成管弦乐版', true],
          ['加一条鼓组轨道', false],
          ['优化一下和弦进行', false],
          ['打开音频设置', false],
        ]
        return cases.map(([text, expect]) => ({ text, expect, got: window.AIAB.audio.detectAudioIntent(text) }))
      `)
      const wrong = result.filter((item) => item.got !== item.expect)
      if (wrong.length) throw new Error(`误判：${JSON.stringify(wrong)}`)
      return `${result.length} 条样例全部符合预期`
    })

    await check('AI 输入框：>= 3 行高度且横向撑满面板', async () => {
      const metrics = await page.evaluate(`
        const area = document.querySelector('textarea[aria-label="给 AI 的指令"]')
        const composer = document.querySelector('[data-chat-composer]')
        if (!area || !composer) return null
        const ar = area.getBoundingClientRect()
        const cr = composer.getBoundingClientRect()
        return { h: ar.height, w: ar.width, cw: cr.width }
      `)
      if (!metrics) throw new Error('找不到输入框')
      if (metrics.h < 80) throw new Error(`输入框太矮：${Math.round(metrics.h)}px`)
      if (metrics.w < metrics.cw - 24) throw new Error(`输入框没有撑满：${Math.round(metrics.w)} / ${Math.round(metrics.cw)}`)
      return `高度 ${Math.round(metrics.h)}px，宽度 ${Math.round(metrics.w)}px / 容器 ${Math.round(metrics.cw)}px`
    })

    await check('音频入口在 AI 面板（顶栏不再有孤立「生成音频」按钮）', async () => {
      const state = await page.evaluate(`
        return {
          topbarLegacy: Boolean(document.querySelector('header [data-generate-audio-trigger]')),
          aiEngineTrigger: Boolean(document.querySelector('aside [data-audio-engine-trigger]')),
        }
      `)
      if (state.topbarLegacy) throw new Error('顶栏仍然存在 data-generate-audio-trigger')
      if (!state.aiEngineTrigger) throw new Error('AI 面板缺少音频引擎入口')
      return 'AI 面板入口存在，顶栏旧入口已移除'
    })

    await check('缺少本机模型：自动弹出下载对话框并显示原因', async () => {
      await page.evaluate(`
        window.AIAB.audio.handleAudioPlanFromToolData({ audioPlan: {
          mode: 'text_to_audio', caption: 'warm cinematic piano with soft strings, 72 bpm', bpm: 72, durationSec: 20, reason: 'verify'
        } })
        return true
      `)
      await page.waitFor('document.querySelector("[data-provision-panel]")', 15000)
      await page.screenshot(PNG('01-needs-model-dialog.png'))
      const state = await page.evaluate(`
        return {
          reason: Boolean(document.querySelector('[data-provision-reason]')),
          reasonText: document.querySelector('[data-provision-reason]')?.textContent ?? '',
          jobStatus: document.querySelector('[data-audio-job]')?.getAttribute('data-audio-job-status'),
          essentialChecked: Boolean(document.querySelector('[data-provision-profile="essential"] input')?.checked),
        }
      `)
      if (!state.reason) throw new Error('下载对话框没有显示原因')
      if (state.jobStatus !== 'blocked') throw new Error(`任务卡应为 blocked，实际 ${state.jobStatus}`)
      if (!state.essentialChecked) throw new Error('基础模型未默认勾选')
      return `原因横幅 + blocked 任务卡；${state.reasonText.replace(/\s+/g, ' ').slice(0, 40)}…`
    })

    await check('分轨模式缺模型时预选「分轨 Stem」能力', async () => {
      await page.evaluate(`
        document.querySelector('[data-provision-panel] button[aria-label="关闭安装面板"]')?.click()
        document.querySelector('[data-audio-job] button[aria-label="关闭音频任务卡"]')?.click()
        return true
      `)
      await sleep(150)
      await page.evaluate(`
        window.AIAB.audio.handleAudioPlanFromToolData({ audioPlan: {
          mode: 'audio_with_stems', caption: 'pop band, guitar bass drums, 110 bpm', stems: ['guitar','bass','drums'], reason: 'verify'
        } })
        return true
      `)
      await page.waitFor('document.querySelector("[data-provision-panel]")', 15000)
      const stemsChecked = await page.evaluate(`return Boolean(document.querySelector('[data-provision-profile="stems"] input')?.checked)`)
      await page.evaluate(`
        document.querySelector('[data-provision-panel] button[aria-label="关闭安装面板"]')?.click()
        document.querySelector('[data-audio-job] button[aria-label="关闭音频任务卡"]')?.click()
        return true
      `)
      if (!stemsChecked) throw new Error('分轨模式未预选 stems')
      return 'stems profile 已预选'
    })

    await check('MIDI -> 音频：离线渲染后自动新增音频轨', async () => {
      const before = await page.evaluate(`return { tracks: window.AIAB.useStore.getState().project.tracks.length }`)
      await page.evaluate(`
        window.AIAB.audio.handleAudioPlanFromToolData({ audioPlan: { mode: 'midi_to_audio', reason: 'verify' } })
        return true
      `)
      await page.waitFor('document.querySelector("[data-audio-job]")', 15000)
      await page.waitFor('document.querySelector("[data-audio-job-status=done],[data-audio-job-status=failed]")', 120000)
      await page.screenshot(PNG('02-midi-rendered-audio-track.png'))
      const after = await page.evaluate(`
        const project = window.AIAB.useStore.getState().project
        const audioTracks = project.tracks.filter((track) => track.kind === 'audio' && track.audioClips.length > 0)
        return {
          tracks: project.tracks.length,
          audioTracks: audioTracks.length,
          jobStatus: document.querySelector('[data-audio-job]')?.getAttribute('data-audio-job-status'),
          saveStatus: window.AIAB.useStore.getState().saveStatus,
        }
      `)
      if (after.jobStatus !== 'done') throw new Error(`任务状态 ${after.jobStatus}`)
      if (after.tracks <= before.tracks) throw new Error(`轨道数没有增加：${before.tracks} -> ${after.tracks}`)
      if (after.audioTracks < 1) throw new Error('没有生成音频轨')
      return `轨道 ${before.tracks} -> ${after.tracks}，音频轨 ${after.audioTracks} 条，保存状态 ${after.saveStatus}`
    })

    await check('AI 重编（ai_cover）走模型链路：无引擎时 blocked，且不会偷偷本地渲染', async () => {
      const before = await page.evaluate(`
        return {
          audioTracks: window.AIAB.useStore.getState().project.tracks.filter(
            (track) => track.kind === 'audio' && track.audioClips.length > 0,
          ).length,
        }
      `)
      await page.evaluate(`
        window.AIAB.audio.handleAudioPlanFromToolData({ audioPlan: {
          mode: 'ai_cover',
          caption: 'epic orchestral rock with distorted guitars and live drums, 116 bpm',
          coverStrength: 0.7,
          reason: 'verify'
        } })
        return true
      `)
      await page.waitFor('document.querySelector("[data-audio-job]")', 15000)
      await page.waitFor(
        'document.querySelector("[data-audio-job-status=blocked],[data-audio-job-status=failed],[data-audio-job-status=done]")',
        20000,
      )
      await page.screenshot(PNG('03-ai-cover-blocked.png'))
      const after = await page.evaluate(`
        const job = document.querySelector('[data-audio-job]')
        return {
          status: job?.getAttribute('data-audio-job-status'),
          audioTracks: window.AIAB.useStore.getState().project.tracks.filter(
            (track) => track.kind === 'audio' && track.audioClips.length > 0,
          ).length,
          provisionOpen: Boolean(document.querySelector('[data-provision-panel]')),
        }
      `)
      // 测试环境没有模型/节点：cover 必须停在 blocked（或直接 failed），绝不能像渲染那样直接落音频轨
      if (after.status !== 'blocked' && after.status !== 'failed') {
        throw new Error(`ai_cover 在没有引擎时应 blocked/failed，实际 ${after.status}`)
      }
      if (after.audioTracks !== before.audioTracks) {
        throw new Error(`ai_cover 不该在模型未运行时落音频轨（${before.audioTracks} → ${after.audioTracks}）`)
      }
      return `状态 ${after.status}，音频轨 ${after.audioTracks} 条（未增加）${after.provisionOpen ? '，安装对话框已打开' : ''}`
    })

    await check('AI 重编全链路（mock 节点）：渲染参考 → cover_audio 参数 → 落 0 拍新轨', async () => {
      // 关掉上一个 blocked 任务卡/安装面板，避免状态互相干扰
      await page.evaluate(`
        document.querySelector('[data-provision-panel] button[aria-label="关闭安装面板"]')?.click()
        document.querySelector('[data-audio-job] button[aria-label="关闭音频任务卡"]')?.click()
        return true
      `)
      await sleep(150)
      // 只 mock Companion 的三个接口：节点在线、任务提交、任务完成。
      // 渲染 / 上传 / peaks 仍走真实链路，验证 runCoverFlow 的接线。
      await page.evaluate(`
        window.__coverCalls = []
        window.__coverSourceId = null
        const original = window.fetch
        window.__coverRestore = () => { window.fetch = original }
        const json = (value) => new Response(JSON.stringify(value), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
        window.fetch = async (url, init) => {
          const target = String(url)
          if (target.includes('/api/companion/status')) {
            return json({ online: true, summary: { workers: 1 }, workers: [], tasks: [] })
          }
          if (target.includes('/api/companion/tasks') && init?.method === 'POST') {
            const body = JSON.parse(String(init.body ?? '{}'))
            window.__coverCalls.push(body)
            window.__coverSourceId = body?.params?.sourceAssetId ?? null
            return json({ taskId: 'task_cover_mock', status: 'queued', summary: 'mock cover' })
          }
          if (target.includes('/api/companion/tasks/task_cover_mock')) {
            return json({ task: { id: 'task_cover_mock', status: 'done', progress: 1, assetId: window.__coverSourceId } })
          }
          return original(url, init)
        }
        return true
      `)
      const before = await page.evaluate(`
        return window.AIAB.useStore.getState().project.tracks.length
      `)
      await page.evaluate(`
        window.AIAB.audio.handleAudioPlanFromToolData({ audioPlan: {
          mode: 'ai_cover',
          caption: 'epic orchestral rock with distorted guitars and live drums, 116 bpm',
          coverStrength: 0.7,
          reason: 'verify'
        } })
        return true
      `)
      await page.waitFor('document.querySelector("[data-audio-job]")', 15000)
      await page.waitFor(
        'document.querySelector("[data-audio-job-status=done],[data-audio-job-status=failed]")',
        120000,
      )
      const result = await page.evaluate(`
        const state = window.AIAB.useStore.getState()
        const project = state.project
        const coverTrack = project.tracks.find((track) => track.name.includes('AI 重编'))
        const clip = coverTrack?.audioClips?.[0]
        const calls = window.__coverCalls ?? []
        const post = calls[0] ?? null
        return {
          status: document.querySelector('[data-audio-job]')?.getAttribute('data-audio-job-status'),
          error: document.querySelector('[data-audio-job]')?.getAttribute('data-audio-job-error'),
          tracks: project.tracks.length,
          coverTrack: coverTrack?.name ?? null,
          startBeat: clip?.startBeat ?? null,
          type: post?.type ?? null,
          caption: post?.params?.caption ?? null,
          strength: post?.params?.audioCoverStrength ?? null,
          sourceAssetId: post?.params?.sourceAssetId ?? null,
          jobMode: window.AIAB.useAudioJobStore.getState().job?.mode ?? null,
        }
      `)
      await page.evaluate(`window.__coverRestore?.(); return true`)
      await page.screenshot(PNG('04-ai-cover-done.png'))
      if (result.status !== 'done') throw new Error(`任务状态 ${result.status}${result.error ? `：${result.error}` : ''}`)
      if (result.jobMode !== 'ai_cover') throw new Error(`任务模式应为 ai_cover，实际 ${result.jobMode}`)
      if (result.tracks <= before) throw new Error(`没有新增 AI 重编轨：${before} → ${result.tracks}`)
      if (!result.coverTrack) throw new Error('找不到「AI 重编」音频轨')
      if (result.type !== 'cover_audio') throw new Error(`提交的任务类型应为 cover_audio，实际 ${result.type}`)
      if (!String(result.caption).includes('orchestral rock')) throw new Error(`caption 没有透传：${result.caption}`)
      if (Number(result.strength) !== 0.7) throw new Error(`coverStrength 没有透传：${result.strength}`)
      if (!result.sourceAssetId) throw new Error('cover_audio 缺少 sourceAssetId（参考音频没有上传）')
      if (Number(result.startBeat) !== 0) throw new Error(`AI 重编产物应落 0 拍，实际 ${result.startBeat}`)
      return `cover_audio · strength=${result.strength} · 参考 ${result.sourceAssetId.slice(0, 12)}… · 落轨 0 拍`
    })

    await check('顶栏「新建」打开新建工程向导', async () => {
      const opened = await page.evaluate(`
        const btn = [...document.querySelectorAll('header button')].find((b) => (b.textContent || '').includes('新建'))
        if (!btn) return false
        btn.click()
        await new Promise((r) => setTimeout(r, 500))
        return Boolean(document.querySelector('[data-new-project-dialog]'))
      `)
      await page.screenshot(PNG('05-new-project-wizard.png'))
      await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true`)
      if (!opened) throw new Error('向导没有打开')
      return '向导已打开'
    })

    await check('控制台无未预期错误', async () => {
      const errors = page.consoleErrors.filter(
        (text) =>
          !/AudioContext|autoplay|MIDI|favicon|Web MIDI|Max polyphony|polyphony|Note dropped|SoundFont|AudioWorkletNode|addModule/i.test(
            text,
          ),
      )
      if (errors.length) throw new Error(errors.slice(0, 3).join(' | '))
      return '0 条错误'
    })
  } finally {
    page.close()
    server.child.kill('SIGKILL')
    await sleep(200)
  }

  writeFileSync(path.join(OUT_DIR, 'result.json'), JSON.stringify({ generatedAt: new Date().toISOString(), passed, failed, failures }, null, 2))
  console.log(`\n${C.bold}音频意图验收${C.reset}：通过 ${C.green}${passed}${C.reset}，失败 ${C.red}${failed}${C.reset}`)
  console.log(`${C.dim}截图：.verify-audio/*.png${C.reset}`)
  if (failed > 0) {
    for (const failure of failures) console.log(`  ${C.red}${failure}${C.reset}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
