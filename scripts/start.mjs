#!/usr/bin/env node
/**
 * 生产启动：运行已构建的服务器（同时托管前端静态文件）。
 * 若尚未构建，自动回退到开发模式并给出提示。
 */
import { existsSync } from 'node:fs'
import { pickFreePort } from './lib/ports.mjs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverBundle = path.join(root, 'apps/server/dist/server.mjs')
const webIndex = path.join(root, 'apps/web/dist/index.html')

if (!existsSync(serverBundle) || !existsSync(webIndex)) {
  console.error('\x1b[31m✗ 尚未构建\x1b[0m，请先运行： pnpm build')
  process.exit(1)
}

const explicitPort = process.env.PORT
const port = explicitPort ? String(explicitPort) : String(await pickFreePort(8787))
const host = process.env.HOST || '127.0.0.1'

if (!explicitPort && port !== '8787') {
  console.log('\x1b[2m(默认端口 8787 被占用，已自动切换到 ' + port + ')\x1b[0m')
}
console.log(`\x1b[33m♪ AI 编曲伴侣\x1b[0m \x1b[2mhttp://${host}:${port}\x1b[0m`)

const child = spawn(process.execPath, [serverBundle], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production', PORT: port, HOST: host, SERVE_STATIC: '1' },
})

child.on('exit', (code) => process.exit(code ?? 0))
process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
