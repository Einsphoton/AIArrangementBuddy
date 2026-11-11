#!/usr/bin/env node
/**
 * 冒烟测试：启动一个临时后端，把关键接口跑一遍。
 *
 *   node scripts/test.mjs           # 全量
 *   node scripts/test.mjs --keep    # 跑完不关服务（调试用）
 *
 * 不依赖任何测试框架，输出彩色 ✓ / ✗。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { IS_WINDOWS, spawnBin } from './lib/spawn-bin.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.AIAB_TEST_PORT || 8899)
const BASE = `http://127.0.0.1:${PORT}`
const keep = process.argv.includes('--keep')
const dataDir = mkdtempSync(path.join(tmpdir(), 'aiab-test-'))

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  gold: '\x1b[33m',
  bold: '\x1b[1m',
}

let passed = 0
let failed = 0
const failures = []

function ok(name, detail = '') {
  passed++
  console.log(`  ${c.green}✓${c.reset} ${name}${detail ? c.dim + '  ' + detail + c.reset : ''}`)
}

function bad(name, error) {
  failed++
  const message = error instanceof Error ? error.message : String(error)
  failures.push({ name, message })
  console.log(`  ${c.red}✗${c.reset} ${name}${c.dim}  ${message}${c.reset}`)
}

async function check(name, fn) {
  try {
    const detail = await fn()
    ok(name, typeof detail === 'string' ? detail : '')
  } catch (error) {
    bad(name, error)
  }
}

/* ------------------------------------------------------------------ */
/* 测试用的最小工程                                                     */
/* ------------------------------------------------------------------ */

function fixtureProject() {
  const now = Date.now()
  return {
    id: 'p_test1234',
    name: '冒烟测试工程',
    version: 1,
    tempo: 112,
    timeSignature: { numerator: 4, denominator: 4 },
    key: 'C',
    scale: 'major',
    swing: 0,
    masterVolume: 0.9,
    tracks: [
      {
        id: 't_1',
        name: '钢琴',
        color: '#f0b429',
        kind: 'instrument',
        instrumentId: 'piano.grand',
        emotionId: 'warm',
        gmProgram: 0,
        engine: 'auto',
        volume: 0.8,
        pan: 0,
        mute: false,
        solo: false,
        reverbSend: 0.2,
        delaySend: 0.05,
        octaveShift: 0,
        clips: [
          {
            id: 'c_1',
            trackId: 't_1',
            name: '钢琴',
            startBeat: 0,
            lengthBeats: 16,
            muted: false,
            notes: [
              { id: 'n_1', pitch: 60, start: 0, duration: 1, velocity: 96 },
              { id: 'n_2', pitch: 64, start: 1, duration: 1, velocity: 88 },
              { id: 'n_3', pitch: 67, start: 2, duration: 1, velocity: 92 },
            ],
          },
        ],
      },
    ],
    sections: [{ id: 's_1', name: '主歌', startBar: 0, bars: 4, energy: 0.5 }],
    chords: [{ root: 0, quality: 'maj', beats: 4 }],
    loop: { enabled: false, startBeat: 0, endBeat: 16 },
    createdAt: now,
    updatedAt: now,
  }
}

/* ------------------------------------------------------------------ */
/* 启动服务                                                            */
/* ------------------------------------------------------------------ */

async function waitForHealth(timeoutMs = 60000) {
  const started = Date.now()
  let lastError = 'timeout'
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${BASE}/api/health`)
      if (response.ok) return await response.json()
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error.message
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error(`服务未在 ${timeoutMs}ms 内就绪：${lastError}`)
}

async function main() {
  console.log(`\n${c.gold}${c.bold}AI 编曲伴侣 · 冒烟测试${c.reset}`)
  console.log(`${c.dim}数据目录 ${dataDir}${c.reset}\n`)

  const serverEntry = path.join(root, 'apps/server/src/index.ts')
  const tsxBin = path.join(root, 'node_modules', '.bin', IS_WINDOWS ? 'tsx.cmd' : 'tsx')
  const child = spawnBin(tsxBin, [serverEntry], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      SERVE_STATIC: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let serverLog = ''
  child.stdout.on('data', (chunk) => (serverLog += chunk))
  child.stderr.on('data', (chunk) => (serverLog += chunk))

  const cleanup = () => {
    if (!keep) {
      // Windows 下 tsx 是 .cmd shim：child.kill 只杀掉 cmd.exe，真正监听端口的 node 子进程会变孤儿，
      // 占住 8899 端口，导致随后跑的 e2e（Chrome 调试端口也是 PORT+2）连不上。这里按进程树杀。
      if (IS_WINDOWS) {
        try {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        } catch {
          child.kill('SIGTERM')
        }
      } else {
        child.kill('SIGTERM')
      }
      setTimeout(() => rmSync(dataDir, { recursive: true, force: true }), 500)
    }
  }
  process.on('exit', cleanup)

  try {
    const health = await waitForHealth()
    ok('服务启动 /api/health', `v${health.version} · node ${health.node}`)

    /* ---------------- 基础接口 ---------------- */
    await check('GET /api/projects 返回数组', async () => {
      const response = await fetch(`${BASE}/api/projects`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      if (!Array.isArray(body)) throw new Error('不是数组')
      return `${body.length} 个工程`
    })

    await check('GET /api/settings 返回默认设置', async () => {
      const response = await fetch(`${BASE}/api/settings`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      if (!body.providers || !body.agent || !body.audio) throw new Error('结构不完整')
      return `providers=${body.providers.length} backend=${body.agent.backend}`
    })

    await check('GET /api/agents 返回后端探测结果', async () => {
      const response = await fetch(`${BASE}/api/agents`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      if (!Array.isArray(body)) throw new Error('不是数组')
      return body.map((item) => `${item.backend}:${item.available ? '✓' : '✗'}`).join(' ')
    })

    /* ---------------- 工程读写 ---------------- */
    const project = fixtureProject()
    await check('PUT /api/projects/:id 保存工程', async () => {
      const response = await fetch(`${BASE}/api/projects/${project.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(project),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status} ${await response.text()}`)
      const body = await response.json()
      if (!body.ok) throw new Error('ok 不为 true')
      return 'savedAt=' + new Date(body.savedAt).toISOString().slice(11, 19)
    })

    await check('GET /api/projects/:id 读回工程且一致', async () => {
      const response = await fetch(`${BASE}/api/projects/${project.id}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      if (body.name !== project.name) throw new Error('工程名不一致')
      if (body.tracks?.[0]?.clips?.[0]?.notes?.length !== 3) throw new Error('音符数量不一致')
      return `${body.tracks.length} 轨 / ${body.tracks[0].clips[0].notes.length} 音`
    })

    await check('GET /api/projects 列表包含刚保存的工程', async () => {
      const response = await fetch(`${BASE}/api/projects`)
      const body = await response.json()
      if (!body.some((item) => item.id === project.id)) throw new Error('列表里没有该工程')
      return body.map((item) => item.name).join(', ')
    })

    /* ---------------- 生成能力（不依赖 AI Key） ---------------- */
    await check('POST /api/generate (compose) 生成完整工程', async () => {
      const response = await fetch(`${BASE}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: 'compose', project, options: { style: 'rock', bars: 8, key: 'A', scale: 'minor' } }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status} ${await response.text()}`)
      const body = await response.json()
      if (!body.project?.tracks?.length) throw new Error('没有生成轨道')
      const notes = body.project.tracks.reduce(
        (sum, track) => sum + track.clips.reduce((n, clip) => n + clip.notes.length, 0),
        0,
      )
      if (notes < 20) throw new Error(`音符太少（${notes}）`)
      return `${body.project.tracks.length} 轨 / ${notes} 音`
    })

    await check('POST /api/generate (melody) 由和弦生成旋律', async () => {
      const response = await fetch(`${BASE}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: 'melody', project, options: { bars: 4 } }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status} ${await response.text()}`)
      const body = await response.json()
      const tracks = body.project?.tracks ?? []
      const notes = tracks.reduce((sum, track) => sum + track.clips.length, 0)
      if (!notes) throw new Error('没有旋律片段')
      return `${notes} 个片段`
    })

    /* ---------------- 导出 ---------------- */
    await check('POST /api/export/midi 返回合法 MIDI', async () => {
      const response = await fetch(`${BASE}/api/export/midi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length < 32) throw new Error('文件过小')
      if (buffer.subarray(0, 4).toString('ascii') !== 'MThd') throw new Error('缺少 MThd 头')
      return `${buffer.length} 字节`
    })

    /* ---------------- 未配置 Key 的 AI 接口应优雅失败 ---------------- */
    await check('POST /api/ai/chat 未配置 Key 时结构化报错', async () => {
      const response = await fetch(`${BASE}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: '写一段钢琴' }],
          project,
        }),
      })
      // 允许 4xx / 200+error 事件；不允许 5xx 崩溃
      if (response.status >= 500) throw new Error(`服务崩溃 HTTP ${response.status}`)
      const text = await response.text()
      if (response.ok && !text.includes('error')) throw new Error('既没报错也没返回 error 事件')
      return `HTTP ${response.status}`
    })

    /* ---------------- 删除 ---------------- */
    await check('DELETE /api/projects/:id 删除工程', async () => {
      const response = await fetch(`${BASE}/api/projects/${project.id}`, { method: 'DELETE' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const list = await (await fetch(`${BASE}/api/projects`)).json()
      if (list.some((item) => item.id === project.id)) throw new Error('删除后仍在列表里')
      return 'ok'
    })
  } catch (error) {
    bad('测试流程中断', error)
    if (serverLog) {
      console.log(`\n${c.dim}—— 服务端日志（尾部）——${c.reset}`)
      console.log(serverLog.split('\n').slice(-30).join('\n'))
    }
  }

  console.log('')
  const total = passed + failed
  if (failed === 0) {
    console.log(`${c.green}${c.bold}✓ 全部通过${c.reset}  ${passed}/${total}\n`)
    cleanup()
    process.exit(0)
  } else {
    console.log(`${c.red}${c.bold}✗ ${failed} 项失败${c.reset}  ${passed}/${total} 通过\n`)
    for (const item of failures) console.log(`  ${c.red}•${c.reset} ${item.name}: ${c.dim}${item.message}${c.reset}`)
    console.log('')
    cleanup()
    process.exit(1)
  }
}

main()
