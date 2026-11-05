#!/usr/bin/env node
/**
 * Guitar Pro → MIDI 批量转换（本地研究用）。
 *
 *   node scripts/crawl/convert-gp.mjs <目录或文件…> [--out data/corpus/j-rock/gp] [--limit 50]
 *
 * 为什么需要它：
 *   Ultimate Guitar / Songsterr / 各种 tab 站的素材是 **Guitar Pro（.gp3/.gp4/.gp5/.gpx/.gp7）**，
 *   不是 MIDI。而这些谱子恰好是「吉他 + 贝斯 + 鼓」的完整乐队编制 —— 正是日摇 / 英伦 / Hardcore
 *   最对口的学习材料。把它们转成 MIDI 就能直接进语料管线。
 *
 * 合规提醒：
 *   - 本脚本**只转换你自己合法拥有的文件**（自己的谱、购买/订阅下载的谱、公有领域谱）；
 *   - 不内置任何下载逻辑，不做站点抓取。
 *
 * 依赖（可选安装，不装也能跑其他工具）：
 *   pnpm add -D @coderline/alphatab
 * 或用环境变量指向任意已安装位置：
 *   ALPHATAB_MODULE=/path/to/node_modules/@coderline/alphatab/dist/alphaTab.mjs node scripts/crawl/convert-gp.mjs …
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseMidi, summarize } from '../corpus/midi-read.mjs'
import { extractFeatures, qualityGate } from '../corpus/features.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const GP_EXTENSIONS = new Set(['.gp', '.gp3', '.gp4', '.gp5', '.gpx', '.gp7'])
const MIDI_EVENT_TYPE_NOTE_BEND = 96 // MIDI 2.0 per-note bend，SMF 1.0 无法表达

/* ------------------------------------------------------------------ */
/* 模块解析                                                            */
/* ------------------------------------------------------------------ */

async function loadAlphaTab() {
  const candidates = [
    process.env.ALPHATAB_MODULE,
    path.join(ROOT, 'node_modules/@coderline/alphatab/dist/alphaTab.mjs'),
    '@coderline/alphatab',
  ].filter(Boolean)

  const errors = []
  for (const candidate of candidates) {
    try {
      const module = await import(candidate.startsWith('/') || candidate.startsWith('.') ? candidate : candidate)
      return module.default ?? module
    } catch (error) {
      errors.push(`${candidate}: ${error.code ?? error.message}`)
    }
  }
  throw new Error(
    `找不到 @coderline/alphatab。\n  安装：pnpm add -D @coderline/alphatab\n  或用环境变量指定：ALPHATAB_MODULE=/abs/path/to/dist/alphaTab.mjs\n  尝试过的位置：\n    ${errors.join('\n    ')}`,
  )
}

/* ------------------------------------------------------------------ */
/* 转换                                                                */
/* ------------------------------------------------------------------ */

/**
 * 把一个 Guitar Pro 文件转换成 SMF 1.0 字节。
 * @returns {{ bytes: Uint8Array, trackCount: number, strippedBends: number }}
 */
export function convertGuitarPro(alphaTab, fileBytes) {
  const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(fileBytes))
  const midiFile = new alphaTab.midi.MidiFile()
  midiFile.format = 1
  const handler = new alphaTab.midi.AlphaSynthMidiFileHandler(midiFile)
  const generator = new alphaTab.midi.MidiFileGenerator(score, new alphaTab.Settings(), handler)
  generator.generate()

  // 谱面里的推弦（MIDI 2.0 per-note bend）无法写进 SMF 1.0；
  // 对编曲分析来说丢掉推弦不影响和声/节奏/织体统计，直接剔除。
  let strippedBends = 0
  for (const track of midiFile.tracks) {
    const before = track.events.length
    track.events = track.events.filter((event) => event.type !== MIDI_EVENT_TYPE_NOTE_BEND)
    strippedBends += before - track.events.length
  }

  const bytes = midiFile.toBinary()
  return { bytes: new Uint8Array(bytes), trackCount: midiFile.tracks.length, strippedBends }
}

/* ------------------------------------------------------------------ */
/* 文件发现                                                            */
/* ------------------------------------------------------------------ */

function walkGp(inputs) {
  const out = []
  const stack = [...inputs]
  while (stack.length) {
    const current = stack.pop()
    if (!existsSync(current)) continue
    const stat = statSync(current)
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) stack.push(full)
        else if (GP_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(full)
      }
    } else if (GP_EXTENSIONS.has(path.extname(current).toLowerCase())) {
      out.push(current)
    }
  }
  return out.sort()
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { inputs: [], out: path.join(ROOT, 'data/corpus/_gp'), limit: 0, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out') args.out = path.resolve(argv[++i])
    else if (arg === '--limit') args.limit = Number(argv[++i]) || 0
    else if (arg === '--verbose') args.verbose = true
    else if (arg.startsWith('--')) throw new Error(`未知参数 ${arg}`)
    else args.inputs.push(path.resolve(arg))
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.inputs.length) {
    console.log(`用法：
  node scripts/crawl/convert-gp.mjs <目录或 .gp 文件…> [--out <输出目录>] [--limit N]

示例：
  node scripts/crawl/convert-gp.mjs ~/Downloads/gp-tabs --out data/corpus/j-rock/gp
`)
    return
  }

  const alphaTab = await loadAlphaTab()
  const files = walkGp(args.inputs)
  if (!files.length) throw new Error('输入里没有 Guitar Pro 文件（.gp/.gp3/.gp4/.gp5/.gpx/.gp7）')

  mkdirSync(args.out, { recursive: true })
  // 工作区内的路径显示成相对路径，工作区外保持绝对路径（不要把 /tmp 显示成 ../../../..）
  const display = (target) => {
    const relative = path.relative(ROOT, target)
    return relative && !relative.startsWith('..') ? relative : target
  }
  console.log(`\nGuitar Pro → MIDI`)
  console.log(`  输入 ${files.length} 个文件 → ${display(args.out)}/\n`)

  let converted = 0
  let accepted = 0
  let failed = 0
  for (const file of files) {
    if (args.limit && converted >= args.limit) break
    const name = path.basename(file, path.extname(file))
    const target = path.join(args.out, `${name}.mid`)
    try {
      const { bytes, trackCount, strippedBends } = convertGuitarPro(alphaTab, readFileSync(file))
      writeFileSync(target, bytes)

      const parsed = parseMidi(bytes)
      const summary = summarize(parsed)
      const features = extractFeatures(parsed, { bars: summary.bars })
      const gate = qualityGate(parsed, features)
      converted++
      if (gate.ok) accepted++

      const mark = gate.ok ? '✓' : '✗'
      console.log(
        `  ${mark} ${name}  ${trackCount} 轨 / ${summary.noteCount} 音 / ${Math.round(summary.bars)} 小节` +
          (gate.tags.length ? `  [${gate.tags.join(',')}]` : '') +
          (gate.reasons.length ? `  ${gate.reasons.join(';')}` : '') +
          (args.verbose && strippedBends ? `  (剔除 ${strippedBends} 个推弦事件)` : ''),
      )
    } catch (error) {
      failed++
      console.log(`  ✗ ${name}  转换失败：${error.message}`)
    }
  }

  console.log(`\n转换 ${converted} 个，通过质量闸门 ${accepted} 个，失败 ${failed} 个`)
  console.log(`下一步：pnpm corpus:profile ${display(args.out)} --style <风格>\n`)
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}\n`)
  process.exit(1)
})
