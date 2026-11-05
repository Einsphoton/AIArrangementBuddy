#!/usr/bin/env node
/**
 * MIDI 语料爬虫（本地研究用）。
 *
 *   node scripts/crawl/run.mjs --seed scripts/crawl/seeds.example.json --style jrpg --limit 20
 *
 * 设计原则：
 * 1. **合规**：robots.txt 遵从、单站限速、可随时 Ctrl-C（队列落盘）；
 * 2. **可追溯**：每个文件都写进 ledger（来源 URL / sha1 / 抓取时间 / 质量判定）；
 * 3. **质量前置**：抓到就立刻跑语料管线的质量闸门，不等到最后才发现八成是垃圾；
 * 4. **只存本地**：文件落在 `data/`（已 gitignore），不进仓库、不进镜像。
 *
 * 抓到的文件会进入：data/corpus/<style>/<source>/
 * 索引台账：        data/crawl/ledger.jsonl
 * 断点续跑：        data/crawl/state.json（已完成的 URL）
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createFetcher, DEFAULT_USER_AGENT } from './lib/polite.mjs'
import { extractLinks, isMidiUrl, looksLikeMidi, normalizeUrl, safeFileName } from './lib/extract.mjs'
import { parseMidi, summarize } from '../corpus/midi-read.mjs'
import { extractFeatures, qualityGate } from '../corpus/features.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')

/* ------------------------------------------------------------------ */
/* 参数与状态                                                          */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { seed: 'scripts/crawl/seeds.example.json', limit: 0, dryRun: false, delayMs: 1500, maxPages: 200, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    const next = () => argv[++i]
    if (key === '--seed') args.seed = next()
    else if (key === '--style') args.style = next()
    else if (key === '--limit') args.limit = Number(next()) || 0
    else if (key === '--max-pages') args.maxPages = Number(next()) || 200
    else if (key === '--delay') args.delayMs = Number(next()) || 1500
    else if (key === '--dry-run') args.dryRun = true
    else if (key === '--verbose') args.verbose = true
    else if (key.startsWith('--')) throw new Error(`未知参数 ${key}`)
  }
  return args
}

function loadState(file) {
  if (!existsSync(file)) return { pages: [], midi: [], files: [], updatedAt: 0 }
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { pages: [], midi: [], files: [], updatedAt: 0 }
  }
}

function saveState(file, state) {
  state.updatedAt = Date.now()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(state))
}

const sha1 = (buffer) => createHash('sha1').update(buffer).digest('hex')

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const seedPath = path.resolve(args.seed)
  if (!existsSync(seedPath)) throw new Error(`找不到种子文件 ${seedPath}`)
  const seed = JSON.parse(readFileSync(seedPath, 'utf8'))
  const style = args.style ?? seed.style
  if (!style) throw new Error('缺少 --style（或在种子文件里写 style）')

  const dataDir = path.join(ROOT, 'data/crawl')
  const statePath = path.join(dataDir, 'state.json')
  const ledgerPath = path.join(dataDir, 'ledger.jsonl')
  const state = loadState(statePath)
  const seenPages = new Set(state.pages)
  const seenUrls = new Set(state.midi)
  const seenHashes = new Set(state.files)

  const fetcher = createFetcher({ delayMs: args.delayMs })
  console.log(`\nMIDI 语料爬虫`)
  console.log(`  style   ${style}`)
  console.log(`  种子    ${seedPath}`)
  console.log(`  限速    ${args.delayMs}ms/请求（同一站点）`)
  console.log(`  上限    ${args.limit ? `${args.limit} 个文件` : '不限'}`)
  console.log(`  状态    ${existsSync(statePath) ? '续跑' : '首次运行'}\n`)

  let downloaded = 0
  let accepted = 0
  let rejected = 0
  let duplicates = 0
  let pagesFetched = 0
  const report = []

  for (const source of seed.sources ?? []) {
    if (args.limit && downloaded >= args.limit) break
    const type = source.type ?? 'midi-links'
    if (type !== 'midi-links') {
      console.log(`▶ 来源 ${source.name}  跳过：type=${type} 需要专用适配器（见 SOURCES.md）`)
      continue
    }
    const sourceDir = path.join(ROOT, 'data/corpus', style, source.name)
    mkdirSync(sourceDir, { recursive: true })
    console.log(`▶ 来源 ${source.name}`)

    const followPattern = source.follow?.pattern ? new RegExp(source.follow.pattern) : null
    const queue = [...(source.startUrls ?? [])].map((url) => ({ url: normalizeUrl(url), depth: 0 }))
    const visited = new Set()

    while (queue.length) {
      if (args.limit && downloaded >= args.limit) break
      if (pagesFetched >= args.maxPages) {
        console.log(`  ⏸ 达到 maxPages=${args.maxPages}，停止翻页`)
        break
      }
      const { url, depth } = queue.shift()
      if (visited.has(url)) continue
      visited.add(url)
      if (seenPages.has(url)) continue

      let page
      try {
        page = await fetcher.fetchText(url)
      } catch (error) {
        console.log(`  ✗ 页面失败 ${url}  ${error.message}`)
        continue
      }
      pagesFetched++
      if (page.blocked) {
        console.log(`  ⛔ robots 禁止 ${url}`)
        continue
      }
      if (!page.text) continue
      seenPages.add(url)
      state.pages.push(url)

      const links = extractLinks(page.text, url)
      const midiLinks = links.filter(isMidiUrl)
      if (args.verbose) console.log(`  · ${url}  ${midiLinks.length} 个 MIDI 链接`)

      for (const midiUrl of midiLinks) {
        if (args.limit && downloaded >= args.limit) break
        const normalized = normalizeUrl(midiUrl)
        if (seenUrls.has(normalized)) {
          duplicates++
          continue
        }
        seenUrls.add(normalized)
        state.midi.push(normalized)

        if (args.dryRun) {
          console.log(`    [dry-run] ${normalized}`)
          downloaded++
          continue
        }

        let file
        try {
          file = await fetcher.fetchBinary(normalized)
        } catch (error) {
          console.log(`    ✗ 下载失败 ${normalized}  ${error.message}`)
          continue
        }
        if (file.blocked || !file.body?.length) continue
        if (!looksLikeMidi(file.body)) {
          console.log(`    ⊘ 不是 MIDI（多半是 HTML 错误页） ${normalized}`)
          continue
        }
        const hash = sha1(file.body)
        if (seenHashes.has(hash)) {
          duplicates++
          continue
        }
        seenHashes.add(hash)
        state.files.push(hash)

        const target = path.join(sourceDir, `${hash.slice(0, 10)}-${safeFileName(normalized)}`)
        writeFileSync(target, file.body)
        downloaded++

        // 立刻跑质量闸门，把结果写进台账
        let verdict = { status: 'unparsed' }
        try {
          const parsed = parseMidi(file.body)
          const summary = summarize(parsed)
          const features = extractFeatures(parsed, { bars: summary.bars })
          const gate = qualityGate(parsed, features)
          verdict = {
            status: gate.ok ? 'accepted' : 'rejected',
            reasons: gate.reasons,
            tags: gate.tags,
            bars: Math.round(summary.bars * 10) / 10,
            notes: summary.noteCount,
            tracks: summary.trackCount,
            bpm: summary.bpm,
            key: `${features.key.tonic}/${features.key.mode}`,
          }
          if (gate.ok) accepted++
          else rejected++
        } catch (error) {
          verdict = { status: 'unparsed', reasons: [error.message] }
          rejected++
        }

        report.push({ source: source.name, url: normalized, file: path.relative(ROOT, target), ...verdict })
        appendFileSync(
          ledgerPath,
          `${JSON.stringify({ ts: new Date().toISOString(), style, source: source.name, url: normalized, sha1: hash, bytes: file.body.length, ...verdict })}\n`,
        )

        const mark = verdict.status === 'accepted' ? '✓' : '✗'
        console.log(
          `    ${mark} ${path.basename(target)}  ${verdict.status}` +
            (verdict.tags?.length ? ` [${verdict.tags.join(',')}]` : '') +
            (verdict.reasons?.length ? ` ${verdict.reasons.join(';')}` : ''),
        )
      }

      // 翻页/目录遍历
      if (followPattern && depth < (source.follow?.maxDepth ?? 3)) {
        for (const link of links) {
          if (!followPattern.test(link)) continue
          if (visited.has(normalizeUrl(link))) continue
          if (queue.length > 5000) break
          queue.push({ url: normalizeUrl(link), depth: depth + 1 })
        }
      }
    }
    console.log(`  来源完成：${source.name}\n`)
  }

  saveState(statePath, state)

  console.log('─'.repeat(60))
  if (args.dryRun) {
    console.log(`[dry-run] 发现 ${downloaded} 个候选文件，去重 ${duplicates} 次（未下载）`)
    console.log(`请求统计：${fetcher.stats.requests} 次网络请求`)
    return
  }
  console.log(`下载 ${downloaded} 个文件，去重 ${duplicates} 次`)
  console.log(`质量闸门：通过 ${accepted}，丢弃 ${rejected}`)
  console.log(`请求统计：${fetcher.stats.requests} 次网络请求，${fetcher.stats.cacheHits} 次命中缓存，${fetcher.stats.blocked} 次被 robots 拦截`)
  console.log(`语料目录：data/corpus/${style}/`)
  console.log(`台账：    ${path.relative(ROOT, ledgerPath)}`)
  console.log(`\n下一步：pnpm corpus:profile data/corpus/${style} --style ${style}\n`)
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}\n`)
  process.exit(1)
})
