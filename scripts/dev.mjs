#!/usr/bin/env node
/**
 * 开发环境：同时启动后端（tsx watch）+ 前端（vite），带彩色前缀与优雅退出。
 *
 * - 直接使用各包 node_modules/.bin 下的可执行文件，不依赖全局 pnpm
 * - 端口被占用时自动顺延（8787 → 8788 …，5183 → 5184 …），并把实际地址打印出来
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { pickFreePort } from './lib/ports.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'

const COLORS = {
  server: '\x1b[38;5;214m',
  web: '\x1b[38;5;45m',
  gold: '\x1b[33m',
  reset: '\x1b[0m',
  dim: '\x1b[2m',
}

function resolveBin(pkgDir, name) {
  const binDir = path.join(root, pkgDir, 'node_modules', '.bin')
  const candidates = isWin ? [`${name}.cmd`, `${name}.exe`, name] : [name]
  for (const file of candidates) {
    const full = path.join(binDir, file)
    if (existsSync(full)) return full
  }
  return null
}

const children = []
let shuttingDown = false

function run(name, command, args, cwd, env = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, FORCE_COLOR: '1', NODE_ENV: 'development', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWin,
  })
  const prefix = `${COLORS[name]}[${name}]${COLORS.reset} `
  const pipe = (stream, target) => {
    let buffer = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) target.write(`${prefix}${line}\n`)
    })
  }
  pipe(child.stdout, process.stdout)
  pipe(child.stderr, process.stderr)
  child.on('error', (error) => {
    console.error(`${prefix}启动失败：${error.message}`)
    shutdown(1)
  })
  child.on('exit', (code) => {
    if (!shuttingDown && code !== 0) {
      console.error(`${prefix}进程退出（code=${code}）`)
      shutdown(code ?? 1)
    }
  })
  children.push(child)
  return child
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  setTimeout(() => process.exit(code), 400)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

/* ------------------------------------------------------------------ */

const tsxBin = resolveBin('apps/server', 'tsx') ?? resolveBin('.', 'tsx')
const viteBin = resolveBin('apps/web', 'vite')

if (!tsxBin || !viteBin) {
  console.error('\x1b[31m✗ 找不到 tsx / vite，请先运行启动脚本安装依赖：node scripts/launch.mjs\x1b[0m')
  process.exit(1)
}

const apiPort = Number(process.env.AIAB_API_PORT) || (await pickFreePort(8787))
const webPort = Number(process.env.AIAB_WEB_PORT) || (await pickFreePort(5183))

const apiUrl = `http://127.0.0.1:${apiPort}`
const webUrl = `http://127.0.0.1:${webPort}`

console.log(`${COLORS.gold}♪ AI 编曲伴侣${COLORS.reset} ${COLORS.dim}开发模式启动中…${COLORS.reset}`)
console.log(`${COLORS.dim}   前端 ${webUrl}   后端 ${apiUrl}${COLORS.reset}\n`)

// 把实际端口告诉调用方（launch.mjs 用它打开浏览器）
console.log(`AIAB_DEV_URL=${webUrl}`)

run('server', tsxBin, ['watch', path.join(root, 'apps/server/src/index.ts')], root, {
  PORT: String(apiPort),
  HOST: '127.0.0.1',
  SERVE_STATIC: '0',
})

setTimeout(() => {
  run('web', viteBin, [], path.join(root, 'apps/web'), {
    AIAB_API_URL: apiUrl,
    AIAB_WEB_PORT: String(webPort),
  })
}, 1200)
