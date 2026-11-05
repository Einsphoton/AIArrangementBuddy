#!/usr/bin/env node
/**
 * 安装后提示（不阻塞安装，失败也不报错）。
 * 首次安装时提示用户去下载音色库（可选，不下载也能出声）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function main() {
  const soundfontDir = path.join(root, 'data', 'soundfonts')
  const hasSoundfont =
    fs.existsSync(soundfontDir) &&
    fs.readdirSync(soundfontDir).some((file) => /\.(sf2|sf3|dls|sfogg)$/i.test(file))

  const c = {
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    gold: (s) => `\x1b[33m${s}\x1b[0m`,
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
  }

  console.log('')
  console.log(c.gold('  ♪  AI 编曲伴侣 · AI Arrangement Buddy'))
  console.log(c.dim('  ────────────────────────────────────────────'))
  console.log(`  ${c.green('✓')} 依赖安装完成`)
  console.log(`  ${c.bold('启动开发环境：')} pnpm dev`)
  console.log(`  ${c.bold('生产构建：')}     pnpm build && pnpm start`)
  if (hasSoundfont) {
    console.log(`  ${c.green('✓')} 已检测到音色库（SoundFont），将获得采样级音质`)
  } else {
    console.log(`  ${c.dim('提示：')} 可选下载 40MB 开源音色库（MuseScore General, MIT）获得更真实的音色：`)
    console.log(`        ${c.gold('pnpm soundfonts')}`)
    console.log(`  ${c.dim('不下载也能正常使用——内置合成器随时可出声。')}`)
  }
  console.log('')
}

try {
  main()
} catch {
  /* postinstall 永不失败 */
}
