#!/usr/bin/env node
/**
 * 跨平台启动器（macOS / Windows / Linux 通用）。
 *
 * 职责：
 *  1. 检查 Node 版本（< 20.19 报错并给安装指引）
 *  2. 检查依赖是否已安装，没有就用 pnpm 自动安装（pnpm 缺失时通过 npx/corepack 兜底）
 *  3. 启动开发模式（前后端热更新）或生产模式（已构建则直接跑）
 *  4. 自动打开浏览器
 *
 * 用法：
 *   node scripts/launch.mjs                # 开发模式
 *   node scripts/launch.mjs --prod         # 生产模式（需先 pnpm build）
 *   node scripts/launch.mjs --no-open      # 不自动打开浏览器
 *   node scripts/launch.mjs --port=8888    # 指定端口
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { pickFreePort } from './lib/ports.mjs'
import { logProxyHint, proxyAwareChildEnv } from './lib/proxy-env.mjs'
import { spawnBinSync } from './lib/spawn-bin.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const wantProd = args.includes('--prod') || args.includes('--production')
const noOpen = args.includes('--no-open')
const portArg = args.find((a) => a.startsWith('--port='))
const isWin = process.platform === 'win32'

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  gold: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
}

function log(message) {
  console.log(message)
}

function fail(message, hint) {
  console.error(`\n${c.red}✗ ${message}${c.reset}`)
  if (hint) console.error(`${c.dim}${hint}${c.reset}`)
  console.error('')
  process.exit(1)
}

/* ------------------------------------------------------------------ */
/* 1. Node 版本                                                        */
/* ------------------------------------------------------------------ */

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 20 || (major === 20 && minor < 19)) {
  fail(
    `Node.js 版本过低：当前 v${process.versions.node}，需要 >= 20.19`,
    '请安装 LTS 版本：https://nodejs.org/zh-cn/download   （macOS 也可 brew install node）',
  )
}

/* ------------------------------------------------------------------ */
/* 2. 依赖                                                             */
/* ------------------------------------------------------------------ */

const needInstall =
  !existsSync(path.join(root, 'node_modules')) ||
  !existsSync(path.join(root, 'node_modules/.bin/tsc')) ||
  !existsSync(path.join(root, 'apps/web/node_modules/.bin/vite')) ||
  !existsSync(path.join(root, 'apps/server/node_modules/.bin/tsx'))

/** 找到可用的 pnpm 调用方式：本地 → PATH → npx */
function resolvePnpm() {
  const localPrefix = path.join(root, '.runtime')
  const candidates = [
    isWin ? path.join(localPrefix, 'pnpm.cmd') : path.join(localPrefix, 'bin/pnpm'),
    isWin ? path.join(root, 'node_modules/.bin/pnpm.cmd') : path.join(root, 'node_modules/.bin/pnpm'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { command: candidate, base: [] }
  }
  const probe = spawnSync(isWin ? 'where' : 'which', ['pnpm'], { stdio: 'ignore' })
  if (probe.status === 0) return { command: 'pnpm', base: [] }
  // 兜底：npx 拉一个 pnpm（不需要全局安装）
  return { command: isWin ? 'npx.cmd' : 'npx', base: ['--yes', 'pnpm@11.28.5'] }
}

function runPnpm(arguments_, options = {}) {
  const { command, base } = resolvePnpm()
  return spawnBinSync(command, [...base, ...arguments_], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, npm_config_cache: process.env.npm_config_cache || path.join(root, '.runtime/npm-cache') },
    ...options,
  })
}

if (needInstall) {
  log(`\n${c.gold}▶${c.reset} 首次运行，正在安装依赖（约 1-3 分钟，取决于网络）…\n`)
  const result = runPnpm(['install', '--config.confirmModulesPurge=false'])
  if (result.status !== 0) {
    fail(
      '依赖安装失败',
      '常见原因：网络问题。可设置国内镜像后重试：\n' +
        '  npm config set registry https://registry.npmmirror.com\n' +
        '或者在项目根目录的 .npmrc 里取消 registry 那一行的注释',
    )
  }
  log(`${c.green}✓${c.reset} 依赖安装完成\n`)
}

/* ------------------------------------------------------------------ */
/* 3. 启动                                                             */
/* ------------------------------------------------------------------ */

function openBrowser(url) {
  if (noOpen) return
  const command = isWin ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const browserArgs = isWin ? ['/c', 'start', '', url] : [url]
  try {
    spawn(command, browserArgs, { detached: true, stdio: 'ignore', shell: isWin }).unref()
  } catch {
    /* 打不开就算了，用户可以手动访问 */
  }
}

// 检测到 HTTPS_PROXY 等代理变量时，下面启动的子进程会补 NODE_USE_ENV_PROXY=1；
// 这里只提示变量名，不打印地址（避免泄露代理账号密码）。
logProxyHint(process.env)

if (wantProd) {
  const serverBundle = path.join(root, 'apps/server/dist/server.mjs')
  const webIndex = path.join(root, 'apps/web/dist/index.html')
  if (!existsSync(serverBundle) || !existsSync(webIndex)) {
    log(`${c.dim}尚未构建，正在构建生产版本…${c.reset}\n`)
    const buildResult = spawnSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { cwd: root, stdio: 'inherit' })
    if (buildResult.status !== 0) fail('构建失败')
  }
  const explicitPort = portArg ? portArg.split('=')[1] : process.env.PORT
  const port = explicitPort || String(await pickFreePort(8787))
  if (!explicitPort && port !== '8787') {
    log(`${c.dim}提示：默认端口 8787 被占用，已自动使用 ${port}${c.reset}`)
  }
  const url = `http://127.0.0.1:${port}`
  log(`\n${c.gold}♪ AI 编曲伴侣${c.reset} ${c.dim}(生产模式)${c.reset}`)
  log(`${c.cyan}${url}${c.reset}\n`)
  setTimeout(() => openBrowser(url), 1500)
  const child = spawn(process.execPath, [path.join(root, 'scripts/start.mjs')], {
    cwd: root,
    stdio: 'inherit',
    env: proxyAwareChildEnv({ ...process.env, PORT: port }),
  })
  child.on('exit', (code) => process.exit(code ?? 0))
  process.on('SIGINT', () => child.kill('SIGINT'))
  process.on('SIGTERM', () => child.kill('SIGTERM'))
} else {
  const apiPort = await pickFreePort(8787)
  const webPort = await pickFreePort(5183)
  const webUrl = `http://127.0.0.1:${webPort}`
  if (webPort !== 5183) log(`${c.dim}提示：5183 被占用，前端改用 ${webPort}${c.reset}`)
  if (apiPort !== 8787) log(`${c.dim}提示：8787 被占用，后端改用 ${apiPort}${c.reset}`)
  log(`\n${c.gold}♪ AI 编曲伴侣${c.reset} ${c.dim}(开发模式：改代码即时生效)${c.reset}`)
  log(`${c.cyan}${webUrl}${c.reset}  ${c.dim}前端${c.reset}`)
  log(`${c.dim}http://127.0.0.1:${apiPort}  API${c.reset}\n`)
  setTimeout(() => openBrowser(webUrl), 4500)
  const child = spawn(process.execPath, [path.join(root, 'scripts/dev.mjs')], {
    cwd: root,
    stdio: 'inherit',
    env: proxyAwareChildEnv({ ...process.env, AIAB_API_PORT: String(apiPort), AIAB_WEB_PORT: String(webPort) }),
  })
  child.on('exit', (code) => process.exit(code ?? 0))
  process.on('SIGINT', () => child.kill('SIGINT'))
  process.on('SIGTERM', () => child.kill('SIGTERM'))
}
