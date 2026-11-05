/**
 * 礼貌抓取：robots.txt 遵从 + 单站点限速 + 重试退避 + 磁盘缓存。
 *
 * 这一层的存在不是为了"技术炫技"，而是为了让爬虫**能长期跑下去**：
 * 被目标站封 IP / 拖黑，比爬得慢严重得多。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const DEFAULT_USER_AGENT = 'AIArrangementBuddy-corpus/0.1 (personal research; +local only)'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ */
/* robots.txt                                                          */
/* ------------------------------------------------------------------ */

const ROBOTS_CACHE = new Map()

function parseRobots(text, userAgent) {
  const token = userAgent.toLowerCase()
  const groups = []
  let current = null
  let inAgentList = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const field = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()

    if (field === 'user-agent') {
      if (!inAgentList) {
        current = { agents: [], rules: [], crawlDelay: null }
        groups.push(current)
        inAgentList = true
      }
      current.agents.push(value.toLowerCase())
    } else if (field === 'disallow' || field === 'allow') {
      inAgentList = false
      if (!current) continue
      current.rules.push({ allow: field === 'allow', path: value })
    } else if (field === 'crawl-delay') {
      inAgentList = false
      if (current && Number.isFinite(Number(value))) current.crawlDelay = Number(value)
    }
    // sitemap / host 等字段忽略
  }

  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a.replace('*', ''))))
  const wildcard = groups.filter((g) => g.agents.includes('*'))
  const group = specific.length ? specific[0] : wildcard[0]
  return {
    rules: group?.rules ?? [],
    crawlDelay: group?.crawlDelay ?? null,
  }
}

function matchesRule(pathname, rulePath) {
  if (!rulePath) return false
  if (rulePath === '/') return true
  const pattern = rulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')
  return new RegExp(`^${pattern}`).test(pathname)
}

/**
 * 取某个 origin 的 robots 规则（带内存 + 磁盘缓存）。
 * robots.txt 返回 404 / 5xx 时按「无限制」处理（常见且被接受的解释）。
 */
export async function getRobots(origin, options = {}) {
  const cached = ROBOTS_CACHE.get(origin)
  if (cached) return cached

  const cacheDir = options.cacheDir ?? path.join(process.cwd(), 'data/crawl/.robots')
  const cacheFile = path.join(cacheDir, `${createHash('sha1').update(origin).digest('hex')}.txt`)

  if (existsSync(cacheFile)) {
    const ageMs = Date.now() - Number(readFileSync(`${cacheFile}.time`, 'utf8') || 0)
    if (ageMs < 24 * 3600 * 1000) {
      const parsed = parseRobots(readFileSync(cacheFile, 'utf8'), options.userAgent ?? DEFAULT_USER_AGENT)
      ROBOTS_CACHE.set(origin, parsed)
      return parsed
    }
  }

  let text = ''
  try {
    const response = await fetch(`${origin}/robots.txt`, {
      headers: { 'user-agent': options.userAgent ?? DEFAULT_USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    })
    if (response.ok) text = await response.text()
  } catch {
    text = ''
  }

  try {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(cacheFile, text)
    writeFileSync(`${cacheFile}.time`, String(Date.now()))
  } catch {
    // 缓存写失败不影响抓取
  }

  const parsed = parseRobots(text, options.userAgent ?? DEFAULT_USER_AGENT)
  ROBOTS_CACHE.set(origin, parsed)
  return parsed
}

export async function isAllowed(url, options = {}) {
  const target = new URL(url)
  const robots = await getRobots(target.origin, options)
  if (!robots.rules.length) return true
  const pathname = target.pathname + target.search
  let allowed = true
  let bestLen = -1
  for (const rule of robots.rules) {
    if (!matchesRule(pathname, rule.path)) continue
    const len = rule.path.length
    if (len > bestLen) {
      bestLen = len
      allowed = rule.allow
    }
  }
  return allowed
}

export async function crawlDelayFor(url, options = {}) {
  const target = new URL(url)
  const robots = await getRobots(target.origin, options)
  return robots.crawlDelay
}

/* ------------------------------------------------------------------ */
/* 限速抓取                                                            */
/* ------------------------------------------------------------------ */

const LAST_HIT = new Map()

export function createFetcher(options = {}) {
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT
  const defaultDelayMs = options.delayMs ?? 1500
  const timeoutMs = options.timeoutMs ?? 30_000
  const cacheDir = options.cacheDir ?? path.join(process.cwd(), 'data/crawl/.cache')
  const useCache = options.cache !== false
  const stats = { requests: 0, cacheHits: 0, blocked: 0, errors: 0 }

  async function waitTurn(origin, extraDelayMs = 0) {
    const last = LAST_HIT.get(origin) ?? 0
    const delay = Math.max(defaultDelayMs, extraDelayMs * 1000)
    const wait = last + delay - Date.now()
    if (wait > 0) await sleep(wait)
    LAST_HIT.set(origin, Date.now())
  }

  function cachePath(url) {
    const hash = createHash('sha1').update(url).digest('hex')
    return { file: path.join(cacheDir, `${hash}.body`), meta: path.join(cacheDir, `${hash}.json`) }
  }

  async function readCache(url) {
    if (!useCache) return null
    const { file, meta } = cachePath(url)
    if (!existsSync(file) || !existsSync(meta)) return null
    const info = JSON.parse(readFileSync(meta, 'utf8'))
    const body = readFileSync(file)
    return { ...info, body }
  }

  function writeCache(url, info, body) {
    if (!useCache) return
    try {
      const { file, meta } = cachePath(url)
      mkdirSync(cacheDir, { recursive: true })
      writeFileSync(file, body)
      writeFileSync(meta, JSON.stringify(info))
    } catch {
      // 忽略缓存失败
    }
  }

  /**
   * 抓一个 URL（二进制）。返回 { status, contentType, body:Buffer, url }。
   * 被 robots 禁止返回 { blocked: true }。
   */
  async function fetchBinary(url) {
    const cached = await readCache(url)
    if (cached) {
      stats.cacheHits++
      return { ...cached, url, fromCache: true }
    }
    if (!(await isAllowed(url, { userAgent }))) {
      stats.blocked++
      return { blocked: true, url }
    }

    const target = new URL(url)
    const crawlDelay = await crawlDelayFor(url, { userAgent })
    let lastError = null
    for (let attempt = 0; attempt < 3; attempt++) {
      await waitTurn(target.origin, crawlDelay ?? 0)
      try {
        const response = await fetch(url, {
          headers: { 'user-agent': userAgent, accept: '*/*' },
          redirect: 'follow',
          signal: AbortSignal.timeout(timeoutMs),
        })
        stats.requests++
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`HTTP ${response.status}`)
          await sleep(1000 * 2 ** attempt)
          continue
        }
        if (!response.ok) {
          stats.errors++
          return { status: response.status, url, body: Buffer.alloc(0), contentType: response.headers.get('content-type') ?? '' }
        }
        const body = Buffer.from(await response.arrayBuffer())
        const info = { status: response.status, contentType: response.headers.get('content-type') ?? '', fetchedAt: Date.now() }
        writeCache(url, info, body)
        return { ...info, url, body }
      } catch (error) {
        lastError = error
        await sleep(800 * 2 ** attempt)
      }
    }
    stats.errors++
    throw new Error(`抓取失败 ${url}: ${lastError?.message ?? '未知错误'}`)
  }

  async function fetchText(url) {
    const result = await fetchBinary(url)
    if (result.blocked) return result
    return { ...result, text: result.body.toString('utf8') }
  }

  return { fetchBinary, fetchText, stats, userAgent }
}
