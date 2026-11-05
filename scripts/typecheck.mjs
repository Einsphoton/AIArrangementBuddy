#!/usr/bin/env node
/** 全量类型检查：依次检查三个包，不依赖 pnpm。 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const tsc = path.join(root, 'node_modules', '.bin', isWin ? 'tsc.cmd' : 'tsc')

if (!existsSync(tsc)) {
  console.error('✗ 未找到 tsc，请先安装依赖（node scripts/launch.mjs）')
  process.exit(1)
}

const targets = [
  ['packages/core', 'packages/core/tsconfig.json'],
  ['apps/server', 'apps/server/tsconfig.json'],
  ['apps/web', 'apps/web/tsconfig.json'],
]

let failed = 0
for (const [name, config] of targets) {
  process.stdout.write(`\x1b[2m检查 ${name} …\x1b[0m `)
  const result = spawnSync(tsc, ['-p', config, '--noEmit'], { cwd: root, encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    .split('\n')
    .filter((line) => line.includes('error TS'))
    .join('\n')
  if (result.status === 0) {
    console.log('\x1b[32m✓\x1b[0m')
  } else {
    failed++
    console.log('\x1b[31m✗\x1b[0m')
    if (output) console.log(output)
  }
}

console.log('')
if (failed === 0) console.log('\x1b[32m✓ 类型检查全部通过\x1b[0m\n')
else console.log(`\x1b[31m✗ ${failed} 个包存在类型错误\x1b[0m\n`)
process.exit(failed === 0 ? 0 : 1)
