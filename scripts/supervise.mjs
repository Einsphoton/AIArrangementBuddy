#!/usr/bin/env node
/**
 * 守护进程：独立运行「产品服务端 + Companion」，子进程退出后自动重启。
 *
 * 用途：会话级后台任务在部分环境下会被外部清理；这个脚本由 Start-Process 独立启动，
 * 不挂在任何终端/会话上，适合本机长期验收。
 *
 *   node scripts/supervise.mjs                 # 默认 8910
 *   node scripts/supervise.mjs --port=8899
 *
 * 日志：data/logs/supervise.log（服务端 stdout/stderr 也写这里）
 * 停止：taskkill /PID <supervise pid> /T /F
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const portArg = args.find((a) => a.startsWith('--port='))
const port = portArg ? portArg.split('=')[1] : process.env.PORT || '8910'
const logDir = path.join(root, 'data', 'logs')
mkdirSync(logDir, { recursive: true })
const logFile = path.join(logDir, 'supervise.log')

function log(message) {
  const line = `${new Date().toISOString()} ${message}`
  console.log(line)
  try {
    appendFileSync(logFile, line + '\n')
  } catch {
    /* ignore */
  }
}

let stopping = false
let serverChild = null
let companionChild = null

function startServer() {
  log(`启动服务端（端口 ${port}）…`)
  serverChild = spawn(process.execPath, [path.join(root, 'scripts', 'start.mjs')], {
    cwd: root,
    env: { ...process.env, PORT: port, SERVE_STATIC: '1', LOG_LEVEL: process.env.LOG_LEVEL || 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverChild.stdout.on('data', (chunk) => appendFileSync(logFile, chunk))
  serverChild.stderr.on('data', (chunk) => appendFileSync(logFile, chunk))
  serverChild.on('exit', (code, signal) => {
    log(`服务端退出（code=${code} signal=${signal}），2s 后重启…`)
    serverChild = null
    if (!stopping) setTimeout(startServer, 2000)
  })
}

function startCompanion() {
  log('启动 Companion（GPU 工作节点）…')
  companionChild = spawn(
    process.execPath,
    [
      path.join(root, 'scripts', 'companion.mjs'),
      '--server', `http://127.0.0.1:${port}`,
      '--name', process.env.AIAB_COMPANION_NAME || '本机 GPU (5090)',
      '--acestep',
      '--engine-idle', '600',
    ],
    { cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  companionChild.stdout.on('data', (chunk) => appendFileSync(logFile, chunk))
  companionChild.stderr.on('data', (chunk) => appendFileSync(logFile, chunk))
  companionChild.on('exit', (code, signal) => {
    log(`Companion 退出（code=${code} signal=${signal}），5s 后重启…`)
    companionChild = null
    if (!stopping) setTimeout(startCompanion, 5000)
  })
}

async function waitHealthy(timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (response.ok) return true
    } catch {
      /* 等 */
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

function shutdown() {
  stopping = true
  log('收到停止信号，关闭子进程…')
  serverChild?.kill()
  companionChild?.kill()
  setTimeout(() => process.exit(0), 800)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGHUP', shutdown)

log(`守护启动：端口 ${port}，日志 ${logFile}`)
startServer()
const healthy = await waitHealthy()
log(healthy ? '服务端健康检查通过' : '服务端健康检查超时（仍会继续守护）')
startCompanion()
