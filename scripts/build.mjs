#!/usr/bin/env node
/** 生产构建：前端（Vite） + 后端（esbuild 单文件打包）。不依赖全局 pnpm。 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'

function resolveBin(pkgDir, name) {
  const binDir = path.join(root, pkgDir, 'node_modules', '.bin')
  const candidates = isWin ? [`${name}.cmd`, `${name}.exe`, name] : [name]
  for (const file of candidates) {
    const full = path.join(binDir, file)
    if (existsSync(full)) return full
  }
  return null
}

function step(name, command, args, cwd) {
  return new Promise((resolve, reject) => {
    console.log(`\x1b[33m▶\x1b[0m ${name}`)
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: isWin })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${name} 失败（code=${code}）`))))
  })
}

try {
  const vite = resolveBin('apps/web', 'vite')
  if (!vite) throw new Error('未找到 vite，请先安装依赖（node scripts/launch.mjs）')
  await step('构建前端 (web)', vite, ['build'], path.join(root, 'apps/web'))
  await step('打包后端 (server)', process.execPath, [path.join(root, 'scripts/build-server.mjs')], root)
  console.log(
    '\n\x1b[32m✓ 构建完成\x1b[0m  运行 \x1b[1mpnpm start\x1b[0m 或 \x1b[1mnode scripts/start.mjs\x1b[0m（默认 http://127.0.0.1:8787）\n',
  )
} catch (error) {
  console.error(`\n\x1b[31m✗ ${error.message}\x1b[0m\n`)
  process.exit(1)
}
