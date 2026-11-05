#!/usr/bin/env node
/**
 * 下载开源音色库（可选）。默认下载 MuseScore General（MIT 许可，约 40MB），
 * 下载后应用会自动启用 SoundFont 采样器，获得接近真实乐器的音质。
 *
 *   pnpm soundfonts              # 下载默认音色库
 *   pnpm soundfonts --list       # 查看所有可选音色库
 *   pnpm soundfonts --id=xxx     # 下载指定音色库
 */
import { createWriteStream, existsSync, mkdirSync, statSync, renameSync, unlinkSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const targetDir = process.env.AIAB_DATA_DIR
  ? path.join(process.env.AIAB_DATA_DIR, 'soundfonts')
  : path.join(root, 'data', 'soundfonts')

/**
 * 音色库源列表。
 * - MuseScore General: MIT，覆盖面最全的 GM 音色库（含管弦、摇滚、电子鼓组）
 * - GeneralUser GS: 体积小、声部平衡好（自由使用）
 * - Salamander Grand Piano: 单乐器高保真三角钢琴（CC-BY 3.0）
 */
const SOURCES = [
  {
    id: 'musescore-general',
    name: 'MuseScore_General.sf3',
    label: 'MuseScore General（MIT，全能 GM，推荐）',
    url: 'https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/MuseScore_General.sf3',
    size: 39_900_972,
    license: 'MIT',
    default: true,
  },
  {
    id: 'musescore-general-sf2',
    name: 'MuseScore_General.sf2',
    label: 'MuseScore General（SF2 未压缩版，兼容性最好）',
    url: 'https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/MuseScore_General.sf2',
    license: 'MIT',
  },
  {
    id: 'generaluser-gs',
    name: 'GeneralUser_GS.sf2',
    label: 'GeneralUser GS（轻量，音色均衡，体积约 30MB）',
    // 官方分发页：https://schristiancollins.com/generaluser.php
    // 若自动下载失效（第三方镜像变动），请手动下载后放入 data/soundfonts/
    url: 'https://github.com/FluidSynth/fluidsynth/wiki/SoundFont',
    license: 'GeneralUser GS License (free)',
    manualOnly: true,
  },
]

function fmtSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function listSources() {
  console.log('\n可选音色库：\n')
  for (const source of SOURCES) {
    const marker = source.default ? '\x1b[33m●\x1b[0m' : '○'
    console.log(`  ${marker} \x1b[1m${source.id}\x1b[0m  ${source.label}`)
    console.log(`     文件名 ${source.name}  ${source.size ? fmtSize(source.size) + '  ' : ''}许可 ${source.license}`)
    console.log(`     \x1b[2m${source.url}\x1b[0m\n`)
  }
  console.log(`  下载目录：${targetDir}\n`)
}

async function download(source) {
  mkdirSync(targetDir, { recursive: true })
  const destination = path.join(targetDir, source.name)
  if (existsSync(destination) && statSync(destination).size > 1024) {
    console.log(`\x1b[32m✓\x1b[0m 已存在：${destination}`)
    return
  }
  const temp = `${destination}.part`
  console.log(`\x1b[33m↓\x1b[0m 正在下载 ${source.label}\n  ${source.url}`)

  const response = await fetch(source.url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`下载失败 HTTP ${response.status}`)
  }
  const total = Number(response.headers.get('content-length') ?? source.size ?? 0)
  let received = 0
  let lastPrint = 0

  const counter = new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength
      const now = Date.now()
      if (now - lastPrint > 250) {
        lastPrint = now
        const ratio = total ? received / total : 0
        const bar = '█'.repeat(Math.round(ratio * 28)).padEnd(28, '░')
        process.stdout.write(`\r  ${bar} ${(ratio * 100).toFixed(0).padStart(3)}%  ${fmtSize(received)}`)
      }
      controller.enqueue(chunk)
    },
  })

  await pipeline(response.body.pipeThrough(counter), createWriteStream(temp))
  renameSync(temp, destination)
  process.stdout.write('\r' + ' '.repeat(70) + '\r')
  console.log(`\x1b[32m✓\x1b[0m 完成：${destination}（${fmtSize(statSync(destination).size)}）`)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--list') || args.includes('-l')) {
    listSources()
    return
  }
  const manual = SOURCES.filter((s) => s.manualOnly)
  if (manual.length) {
    console.log('\n\x1b[2m以下音色库需手动下载（第三方直链不稳定），放到 ' + targetDir + ' 即可：\x1b[0m')
    for (const source of manual) {
      console.log('  • ' + source.label)
      console.log('    \x1b[2m' + source.url + '\x1b[0m')
    }
    console.log('')
  }

  const idArg = args.find((a) => a.startsWith('--id='))
  if (idArg) {
    const id = idArg.split('=')[1]
    const source = SOURCES.find((s) => s.id === id)
    if (!source) {
      console.error(`未知音色库 id: ${id}`)
      listSources()
      process.exit(1)
    }
    try {
      await download(source)
    } catch (error) {
      try {
        unlinkSync(path.join(targetDir, `${source.name}.part`))
      } catch {
        /* ignore */
      }
      console.error(`\x1b[31m✗ ${error.message}\x1b[0m`)
      process.exit(1)
    }
    return
  }

  if (process.platform === 'win32') {
    console.log('\x1b[2m提示：Windows 下如需代理，请先设置 HTTPS_PROXY 环境变量。\x1b[0m')
  }
  for (const source of SOURCES.filter((s) => s.default)) {
    try {
      await download(source)
    } catch (error) {
      console.error(`\x1b[31m✗ ${error.message}\x1b[0m`)
      console.log('\x1b[2m可以手动下载后放到：' + targetDir + '\x1b[0m')
      process.exitCode = 1
    }
  }
}

main()
