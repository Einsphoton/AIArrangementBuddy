#!/usr/bin/env node
/**
 * P15 验收：服务端拉起本机生成节点（Companion）。
 *
 * 两种模式：
 *   node scripts/verify-companion-node.mjs                 # 自己起一个临时后端（临时 DATA_DIR）
 *   node scripts/verify-companion-node.mjs --server URL    # 打已在跑的后端（不动它的数据目录）
 *
 * 覆盖：
 *  A. 接口契约：GET /api/companion/node 字段、/status 带 node、初始 state
 *  B. 一键启动：POST /node/start → online=true、worker 注册、state=running
 *  C. 幂等：再次 start 复用同一进程（pid 不变、worker 数不增）
 *  D. 提交任务：有节点时正常入队（不是 503）
 *  E. 停止：POST /node/stop → state=stopped，且 worker 记录立即失效（不等 60s TTL）
 *  F. 自动拉起：无节点时提交任务 → 服务端自动启动并成功入队
 *  G. AIAB_COMPANION_AUTOSTART=0 → 不自动拉起、任务 503 且带 node 原因（仅自起模式）
 *  H. 部署形态无脚本 → available=false（仅自起模式，用 AIAB_COMPANION_SCRIPT 模拟 Docker）
 *
 * 环境限制：自起模式需要 spawn tsx（内部走 esbuild 子进程）。某些受限沙箱禁止
 * 子进程管道，会以 EPERM 失败——此时脚本会明确报告「环境不支持自起」并退出码 2
 * （跳过，不算通过也不算失败），请改用 `--server` 模式打已在跑的后端。
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IS_WINDOWS = process.platform === 'win32'
const args = process.argv.slice(2)
const serverArgIndex = args.indexOf('--server')
const externalServer = serverArgIndex >= 0 ? args[serverArgIndex + 1] : null
const PORT = Number(process.env.AIAB_TEST_PORT || 8897)
const BASE = externalServer ? externalServer.replace(/\/$/, '') : `http://127.0.0.1:${PORT}`
const dataDir = externalServer ? null : mkdtempSync(path.join(tmpdir(), 'aiab-node-'))
const shimPath = dataDir ? path.join(dataDir, 'companion-mock-shim.mjs') : null
const realCompanion = path.join(root, 'scripts', 'companion.mjs')

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  gold: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
}

let passed = 0
let failed = 0
let skipped = 0
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

function skip(name, why) {
  skipped++
  console.log(`  ${c.cyan}–${c.reset} ${name}${c.dim}  （跳过：${why}）${c.reset}`)
}

async function check(name, fn) {
  try {
    const detail = await fn()
    ok(name, typeof detail === 'string' ? detail : '')
  } catch (error) {
    bad(name, error)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function api(pathname, init) {
  const response = await fetch(`${BASE}${pathname}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: response.status, ok: response.ok, body }
}

async function waitForHealth(timeoutMs = 90_000) {
  const started = Date.now()
  let last = 'timeout'
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${BASE}/api/health`)
      if (response.ok) return await response.json()
      last = `HTTP ${response.status}`
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await sleep(300)
  }
  throw new Error(`服务未在 ${timeoutMs}ms 内就绪：${last}`)
}

/* ------------------------------------------------------------------ */
/* 自起模式：临时后端                                                  */
/* ------------------------------------------------------------------ */

let server = null
let serverLogFile = null

/** 生成 mock 壳：透传真 companion.mjs，但强制 --mock（无 GPU 也能注册接单） */
function writeShim() {
  const shim = `#!/usr/bin/env node
// 验收用 mock 壳：把服务端下发的 --engine 换成 --mock，其余参数照旧透传。
import { pathToFileURL } from 'node:url'
import process from 'node:process'

const real = ${JSON.stringify(realCompanion)}
const mod = await import(pathToFileURL(real).href)
const argv = process.argv.slice(2).filter((arg) => arg !== '--engine' && arg !== '--acestep')
if (!argv.includes('--mock')) argv.push('--mock')
process.exitCode = await mod.main(argv)
`
  writeFileSync(shimPath, shim, 'utf8')
}

function startServer(env = {}) {
  const tsxBin = path.join(root, 'node_modules', '.bin', IS_WINDOWS ? 'tsx.cmd' : 'tsx')
  const entry = path.join(root, 'apps/server/src/index.ts')
  const logFile = path.join(dataDir, `server-${Date.now()}.log`)
  mkdirSync(dataDir, { recursive: true })
  const fd = openSync(logFile, 'a')
  // stdout/stderr 重定向到文件（不是 pipe 采集）：受限环境不允许对子进程做管道捕获
  const child = IS_WINDOWS
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${tsxBin}" "${entry}""`], {
        cwd: root,
        env: { ...process.env, ...env },
        stdio: ['ignore', fd, fd],
        windowsVerbatimArguments: true,
      })
    : spawn(tsxBin, [entry], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', fd, fd] })
  try {
    closeSync(fd)
  } catch {
    /* ignore */
  }
  serverLogFile = logFile
  return child
}

function readServerLog(lines = 25) {
  try {
    const text = readFileSync(serverLogFile, 'utf8')
    return text.split('\n').filter(Boolean).slice(-lines).join('\n')
  } catch {
    return ''
  }
}

function baseEnv(env = {}) {
  return {
    NODE_ENV: 'test',
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    SERVE_STATIC: '0',
    LOG_LEVEL: 'warn',
    AIAB_COMPANION_SCRIPT: shimPath,
    ...env,
  }
}

async function stopServer(child) {
  if (!child) return
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
  await sleep(700)
}

/** 清理本脚本拉起的 node 进程（按命令行里的 mock 壳路径匹配，不误杀用户节点） */
function killStrayShimProcesses() {
  if (!shimPath) return
  try {
    if (!IS_WINDOWS) return
    const list = spawnSync(
      'wmic',
      ['process', 'where', `name='node.exe' and CommandLine like '%companion-mock-shim%'`, 'get', 'ProcessId'],
      { encoding: 'utf8', timeout: 10_000 },
    )
    for (const match of `${list.stdout ?? ''}`.matchAll(/\b(\d{2,7})\b/g)) {
      spawnSync('taskkill', ['/pid', match[1], '/T', '/F'], { stdio: 'ignore' })
    }
  } catch {
    /* 清理失败不影响结论 */
  }
}

/**
 * 启动一个临时后端并跑 fn。
 * 返回 'ok' / 'sandbox'（环境不允许启子进程）/ 'failed'。
 */
async function withServer(env, fn) {
  server = startServer(baseEnv(env))
  try {
    await waitForHealth()
    await fn()
    return 'ok'
  } catch (error) {
    const tail = readServerLog(25)
    const sandboxBlocked = /spawn EPERM/i.test(tail)
    if (sandboxBlocked) {
      console.log(`  ${c.cyan}–${c.reset} 当前环境禁止启动子进程（tsx/esbuild 报 spawn EPERM）${c.dim}  ${c.reset}`)
      return 'sandbox'
    }
    bad('临时后端启动/调用失败', error)
    if (tail) {
      console.log(`\n${c.dim}—— 服务端日志（尾部）——${c.reset}`)
      console.log(tail)
    }
    return 'failed'
  } finally {
    await stopServer(server)
    server = null
    killStrayShimProcesses()
  }
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

async function contractChecks(label) {
  await check(`${label}GET /api/companion/node 字段完整`, async () => {
    const response = await api('/api/companion/node')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const node = response.body
    for (const key of ['available', 'autostart', 'controllable', 'state', 'command']) {
      if (!(key in node)) throw new Error(`缺少字段 ${key}`)
    }
    if (!['stopped', 'starting', 'running', 'failed'].includes(node.state)) {
      throw new Error(`state 取值非法：${node.state}`)
    }
    if (!node.command.includes('companion.mjs')) throw new Error('启动命令不含 companion.mjs')
    return `state=${node.state} available=${node.available}`
  })

  await check(`${label}GET /api/companion/status 带 node 字段`, async () => {
    const response = await api('/api/companion/status')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (!response.body.node) throw new Error('status 缺 node 字段')
    const online = response.body.online === true
    if (online !== (response.body.summary?.workers ?? 0) > 0) throw new Error('online 与 workers 数不一致')
    return `online=${online} workers=${response.body.summary?.workers ?? 0}`
  })
}

async function startStopChecks(label) {
  let firstPid
  await check(`${label}POST /node/start → 拉起并注册`, async () => {
    const response = await api('/api/companion/node/start', {
      method: 'POST',
      body: JSON.stringify({ waitMs: 20_000 }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${JSON.stringify(response.body)}`)
    if (response.body.online !== true) throw new Error(`未上线：${JSON.stringify(response.body.node)}`)
    if (response.body.node?.state !== 'running') throw new Error(`state 应为 running，实际 ${response.body.node?.state}`)
    firstPid = response.body.node.pid
    const summary = (await api('/api/companion/status')).body.summary
    if (summary.workers < 1) throw new Error('worker 表没有节点')
    return `pid=${firstPid} workers=${summary.workers}`
  })

  await check(`${label}再次 start 复用同一节点（不重复拉起）`, async () => {
    const before = (await api('/api/companion/status')).body.summary.workers
    const again = await api('/api/companion/node/start', {
      method: 'POST',
      body: JSON.stringify({ waitMs: 5000 }),
    })
    if (again.body.online !== true) throw new Error('第二次启动后不在线')
    const after = (await api('/api/companion/status')).body.summary.workers
    if (after > before) throw new Error(`worker 数变多了（${before} → ${after}），可能拉起了第二个节点`)
    const node = (await api('/api/companion/node')).body
    if (firstPid && node.pid && node.pid !== firstPid) throw new Error(`pid 变了（${firstPid} → ${node.pid}）`)
    return `workers=${after} pid=${node.pid}（复用）`
  })

  await check(`${label}有节点时提交任务正常入队（不是 503）`, async () => {
    const response = await api('/api/companion/tasks', {
      method: 'POST',
      body: JSON.stringify({
        type: 'generate_audio',
        params: { caption: 'verify companion node', durationSec: 5, bpm: 100 },
        projectId: 'verify-node',
      }),
    })
    if (response.status !== 200) throw new Error(`HTTP ${response.status} ${JSON.stringify(response.body)}`)
    if (!response.body.taskId) throw new Error('缺少 taskId')
    return `taskId=${response.body.taskId} variant=${response.body.requiredVariant}`
  })

  await check(`${label}POST /node/stop → 停止且 worker 记录立即失效`, async () => {
    const response = await api('/api/companion/node/stop', { method: 'POST', body: '{}' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (response.body.ok !== true) throw new Error('stop 未生效（节点可能不是服务端拉起的）')
    if (response.body.node?.state !== 'stopped') throw new Error(`state 应为 stopped，实际 ${response.body.node?.state}`)
    // 关键回归：进程被杀后 worker 记录不能还「在线」60s，否则提交任务会干等
    const workers = (await api('/api/companion/status')).body.summary.workers
    if (workers !== 0) throw new Error(`停止后 worker 数应为 0，实际 ${workers}（记录没清，任务会干等）`)
    return 'state=stopped · workers=0'
  })
}

async function autostartCheck(label) {
  await check(`${label}无节点时提交任务 → 服务端自动拉起并入队`, async () => {
    const before = await api('/api/companion/node')
    if (before.body.state === 'running' && (await api('/api/companion/status')).body.summary.workers > 0) {
      // 外部模式可能已有用户在跑的节点：先停掉自己可控的那个，保证走自动拉起分支
      await api('/api/companion/node/stop', { method: 'POST', body: '{}' })
      await sleep(500)
    }
    const workersBefore = (await api('/api/companion/status')).body.summary.workers
    if (workersBefore > 0) throw new Error(`前置条件不满足：仍有 ${workersBefore} 个在线节点`)
    const response = await api('/api/companion/tasks', {
      method: 'POST',
      body: JSON.stringify({
        type: 'generate_audio',
        params: { caption: 'autostart probe', durationSec: 5, bpm: 100 },
        projectId: 'verify-autostart',
      }),
    })
    if (response.status !== 200) throw new Error(`HTTP ${response.status} ${JSON.stringify(response.body)}`)
    if (!response.body.taskId) throw new Error('缺少 taskId')
    const node = (await api('/api/companion/node')).body
    const workersAfter = (await api('/api/companion/status')).body.summary.workers
    if (workersAfter < 1) throw new Error('自动拉起后 worker 表仍为空')
    return `taskId=${response.body.taskId} node.state=${node.state} workers=${workersAfter}`
  })
}

async function disabledChecks() {
  await check('AIAB_COMPANION_AUTOSTART=0：不自动拉起，任务 503 + node 原因', async () => {
    const node = (await api('/api/companion/node')).body
    if (node.autostart !== false) throw new Error('autostart 应为 false')
    if (node.controllable !== false) throw new Error('controllable 应为 false')
    const response = await api('/api/companion/tasks', {
      method: 'POST',
      body: JSON.stringify({ type: 'generate_audio', params: { caption: 'disabled probe', durationSec: 5 } }),
    })
    if (response.status !== 503) throw new Error(`应返回 503，实际 ${response.status}`)
    if (!String(response.body?.error ?? '').includes('Companion')) throw new Error('错误信息不含 Companion')
    if (!response.body?.node) throw new Error('503 响应应带 node（界面据此展示原因）')
    return `503 · reason=${String(response.body.node.reason ?? '').slice(0, 28)}…`
  })
}

async function missingScriptChecks() {
  await check('无节点脚本（Docker/跨机形态）→ available=false，任务 503', async () => {
    const node = (await api('/api/companion/node')).body
    if (node.available !== false) throw new Error('available 应为 false')
    if (node.controllable !== false) throw new Error('controllable 应为 false')
    const response = await api('/api/companion/tasks', {
      method: 'POST',
      body: JSON.stringify({ type: 'generate_audio', params: { caption: 'no script', durationSec: 5 } }),
    })
    if (response.status !== 503) throw new Error(`应返回 503，实际 ${response.status}`)
    if (!String(response.body?.error ?? '').includes('Companion')) throw new Error('错误信息不含 Companion')
    return '503 · available=false（需到 GPU 机器手动启动）'
  })
}

function cleanup() {
  killStrayShimProcesses()
  if (dataDir) {
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  console.log(`\n${c.gold}${c.bold}生成节点（Companion）自动启动 · 验收${c.reset}`)
  console.log(
    externalServer
      ? `${c.dim}目标后端 ${BASE}（外部模式：不启动/不破坏其数据目录）${c.reset}\n`
      : `${c.dim}临时数据目录 ${dataDir}${c.reset}\n`,
  )

  if (!existsSync(realCompanion)) {
    console.error(`${c.red}✗ 找不到 ${realCompanion}${c.reset}\n`)
    process.exit(1)
  }

  try {
    if (externalServer) {
      /* ---------------- 外部模式：打已在跑的后端 ---------------- */
      await waitForHealth(15_000)
      await contractChecks('')
      await startStopChecks('')
      await autostartCheck('')
      // 收尾：把本脚本拉起的节点停掉，别给用户留后台进程
      await api('/api/companion/node/stop', { method: 'POST', body: '{}' })
      skip('AIAB_COMPANION_AUTOSTART=0 分支', '外部模式改不了对方环境变量')
      skip('无节点脚本（Docker）分支', '外部模式改不了 AIAB_COMPANION_SCRIPT')
    } else {
      /* ---------------- 自起模式 ---------------- */
      writeShim()
      const a = await withServer({}, async () => {
        await contractChecks('')
        await startStopChecks('')
      })
      if (a === 'sandbox') {
        console.log(
          `\n${c.cyan}当前环境不能启动子进程，自起模式的用例全部跳过。${c.reset}\n` +
            `${c.dim}请在普通终端里跑本脚本，或用 --server 指向已在跑的后端。${c.reset}\n`,
        )
        process.exitCode = 2
        return
      }
      const b = await withServer({}, async () => {
        await autostartCheck('')
      })
      if (b !== 'ok') process.exitCode = 1
      const d = await withServer({ AIAB_COMPANION_AUTOSTART: '0' }, async () => {
        await disabledChecks()
      })
      if (d !== 'ok') process.exitCode = 1
      const e = await withServer({ AIAB_COMPANION_SCRIPT: path.join(dataDir, 'nope.mjs') }, async () => {
        await missingScriptChecks()
      })
      if (e !== 'ok') process.exitCode = 1
    }
  } finally {
    if (server) await stopServer(server)
    cleanup()
  }

  console.log('')
  const total = passed + failed
  if (failed === 0) {
    console.log(
      `${c.green}${c.bold}✓ 全部通过${c.reset}  ${passed}/${total}${skipped ? c.dim + `（跳过 ${skipped} 项）` + c.reset : ''}\n`,
    )
    process.exit(process.exitCode ?? 0)
  }
  console.log(`${c.red}${c.bold}✗ ${failed} 项失败${c.reset}  ${passed}/${total} 通过\n`)
  for (const item of failures) console.log(`  ${c.red}•${c.reset} ${item.name}: ${c.dim}${item.message}${c.reset}`)
  console.log('')
  process.exit(1)
}

main().catch((error) => {
  console.error(`\n${c.red}验收脚本异常：${error instanceof Error ? error.stack : String(error)}${c.reset}\n`)
  cleanup()
  process.exit(1)
})
