/** 联网工具：web_search（DuckDuckGo / Tavily / Brave / Serper）与 fetch_url（正文提取）。 */
import type { SearchConfig } from '@aiab/core'
import { fetchWithTimeout, readJsonSafe, truncate } from '../util.js'
import { int, str, toolSchema, type ToolDef, type ToolResult } from './schema.js'
import { readNumber, readString } from './project.js'

export interface SearchResultItem {
  title: string
  url: string
  snippet: string
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    copy: '©',
    reg: '®',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    ldquo: '“',
    rdquo: '”',
    lsquo: '‘',
    rsquo: '’',
  }
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (match, name: string) => named[name.toLowerCase()] ?? match)
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function normalizeUrl(href: string): string {
  let url = decodeEntities(href.trim())
  if (url.startsWith('//')) url = `https:${url}`
  // DuckDuckGo 跳转链接：/l/?uddg=<encoded>
  const match = url.match(/[?&]uddg=([^&]+)/)
  if (match) {
    try {
      return decodeURIComponent(match[1])
    } catch {
      /* ignore */
    }
  }
  return url
}

/* ------------------------------- DuckDuckGo ------------------------------- */

async function searchDuckDuckGo(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResultItem[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=wt-wt`
  const response = await fetchWithTimeout(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    signal,
    timeoutMs: 20_000,
  })
  if (!response.ok) throw new Error(`DuckDuckGo 返回 HTTP ${response.status}`)
  const html = await response.text()
  const results: SearchResultItem[] = []

  const anchorRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const snippetRegex = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  const snippets: string[] = []
  let snippetMatch: RegExpExecArray | null
  while ((snippetMatch = snippetRegex.exec(html))) snippets.push(stripTags(snippetMatch[1]))

  let anchorMatch: RegExpExecArray | null
  let index = 0
  while ((anchorMatch = anchorRegex.exec(html)) && results.length < maxResults) {
    const href = normalizeUrl(anchorMatch[1])
    const title = stripTags(anchorMatch[2])
    if (!href.startsWith('http') || !title) continue
    results.push({ title, url: href, snippet: snippets[index] ?? '' })
    index++
  }

  if (results.length === 0) {
    // lite 版兜底
    const lite = await fetchWithTimeout(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      signal,
      timeoutMs: 20_000,
    })
    const liteHtml = await lite.text()
    const liteRegex = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let liteMatch: RegExpExecArray | null
    while ((liteMatch = liteRegex.exec(liteHtml)) && results.length < maxResults) {
      const href = normalizeUrl(liteMatch[1])
      const title = stripTags(liteMatch[2])
      if (href.startsWith('http') && title) results.push({ title, url: href, snippet: '' })
    }
  }
  return results
}

/* --------------------------------- Tavily --------------------------------- */

async function searchTavily(query: string, config: SearchConfig, signal?: AbortSignal): Promise<SearchResultItem[]> {
  if (!config.apiKey) throw new Error('Tavily 需要配置 API Key')
  const response = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: config.apiKey, query, max_results: config.maxResults, search_depth: 'basic' }),
    signal,
    timeoutMs: 25_000,
  })
  const body = await readJsonSafe<{ results?: { title?: string; url?: string; content?: string }[]; detail?: string }>(response)
  if (!response.ok) throw new Error(body?.detail || `Tavily 返回 HTTP ${response.status}`)
  return (body?.results ?? []).map((item) => ({
    title: item.title ?? item.url ?? '',
    url: item.url ?? '',
    snippet: item.content ?? '',
  }))
}

/* --------------------------------- Brave ---------------------------------- */

async function searchBrave(query: string, config: SearchConfig, signal?: AbortSignal): Promise<SearchResultItem[]> {
  if (!config.apiKey) throw new Error('Brave Search 需要配置 API Key')
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${config.maxResults}`
  const response = await fetchWithTimeout(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': config.apiKey },
    signal,
    timeoutMs: 25_000,
  })
  const body = await readJsonSafe<{ web?: { results?: { title?: string; url?: string; description?: string }[] } }>(response)
  if (!response.ok) throw new Error(`Brave 返回 HTTP ${response.status}`)
  return (body?.web?.results ?? []).map((item) => ({
    title: item.title ?? '',
    url: item.url ?? '',
    snippet: item.description ?? '',
  }))
}

/* --------------------------------- Serper --------------------------------- */

async function searchSerper(query: string, config: SearchConfig, signal?: AbortSignal): Promise<SearchResultItem[]> {
  if (!config.apiKey) throw new Error('Serper 需要配置 API Key')
  const response = await fetchWithTimeout('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': config.apiKey },
    body: JSON.stringify({ q: query, num: config.maxResults }),
    signal,
    timeoutMs: 25_000,
  })
  const body = await readJsonSafe<{ organic?: { title?: string; link?: string; snippet?: string }[] }>(response)
  if (!response.ok) throw new Error(`Serper 返回 HTTP ${response.status}`)
  return (body?.organic ?? []).map((item) => ({
    title: item.title ?? '',
    url: item.link ?? '',
    snippet: item.snippet ?? '',
  }))
}

/* --------------------------------- 工具 ---------------------------------- */

export const webSearchTool: ToolDef = {
  name: 'web_search',
  title: '联网搜索',
  web: true,
  readOnly: true,
  description:
    '联网搜索资料（编曲参考、乐器音色说明、和弦进行、歌曲信息等）。默认 DuckDuckGo（免 Key）；也可在设置里配 Tavily / Brave / Serper。',
  parameters: toolSchema(
    {
      query: str('搜索关键词'),
      maxResults: int('返回条数 1..10', { minimum: 1, maximum: 10 }),
    },
    ['query'],
  ),
  async handler(args, ctx): Promise<ToolResult> {
    if (!ctx.allowWebSearch) return { ok: false, message: '设置中已禁用联网搜索（allowWebSearch=false）' }
    const query = readString(args, 'query')
    if (!query) return { ok: false, message: '请提供搜索关键词 query' }
    const config: SearchConfig = { ...ctx.settings.search }
    const maxResults = Math.max(1, Math.min(10, Math.round(readNumber(args, 'maxResults', 1, 10) ?? config.maxResults ?? 6)))
    config.maxResults = maxResults
    const provider = config.provider
    try {
      let results: SearchResultItem[] = []
      if (provider === 'tavily') results = await searchTavily(query, config, ctx.signal)
      else if (provider === 'brave') results = await searchBrave(query, config, ctx.signal)
      else if (provider === 'serper') results = await searchSerper(query, config, ctx.signal)
      else results = await searchDuckDuckGo(query, maxResults, ctx.signal)
      results = results.slice(0, maxResults)
      if (results.length === 0) return { ok: false, message: `没有搜到「${query}」的结果（provider=${provider}）` }
      const message = results
        .map((item, index) => `${index + 1}. ${item.title}\n   ${item.url}\n   ${truncate(item.snippet, 220)}`)
        .join('\n')
      return {
        ok: true,
        message: `「${query}」共 ${results.length} 条结果（${provider}）：\n${message}`,
        data: { provider, query, results },
      }
    } catch (error) {
      return {
        ok: false,
        message: `联网搜索失败（${provider}）：${(error as Error).message}。可改用 duckduckgo（免 Key）或检查设置里的搜索 Key。`,
        data: { provider, query },
      }
    }
  },
}

/** 从 HTML 中抽取正文（够用即可：去脚本/样式/标签 + 解码实体 + 合并空行） */
export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? stripTags(titleMatch[1]) : ''
  let body = html
  body = body.replace(/<!--[\s\S]*?-->/g, ' ')
  body = body.replace(/<(script|style|noscript|svg|head|iframe|template)[\s\S]*?<\/\1>/gi, ' ')
  body = body.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n')
  body = body.replace(/<[^>]+>/g, ' ')
  body = decodeEntities(body)
  const lines = body
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line, index, array) => line.length > 0 || (index > 0 && array[index - 1]?.length > 0))
  return { title, text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() }
}

export const fetchUrlTool: ToolDef = {
  name: 'fetch_url',
  title: '抓取网页',
  web: true,
  readOnly: true,
  description: '抓取指定网页 URL 的正文（去掉 HTML 标签，截断到约 8000 字符），用于查阅教程 / 文档 / 歌曲资料。',
  parameters: toolSchema(
    {
      url: str('要抓取的 http(s) 地址'),
      maxChars: int('最多返回多少字符（默认 8000）', { minimum: 500, maximum: 20000 }),
    },
    ['url'],
  ),
  async handler(args, ctx): Promise<ToolResult> {
    if (!ctx.allowWebSearch) return { ok: false, message: '设置中已禁用联网（allowWebSearch=false）' }
    const rawUrl = readString(args, 'url')
    if (!rawUrl) return { ok: false, message: '请提供 url' }
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return { ok: false, message: `URL 不合法：${rawUrl}` }
    }
    if (!/^https?:$/.test(parsed.protocol)) return { ok: false, message: '只支持 http/https 地址' }
    const maxChars = Math.round(readNumber(args, 'maxChars', 500, 20000) ?? 8000)
    try {
      const response = await fetchWithTimeout(parsed.toString(), {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain' },
        signal: ctx.signal,
        timeoutMs: 25_000,
      })
      if (!response.ok) return { ok: false, message: `抓取失败：HTTP ${response.status}`, data: { url: parsed.toString() } }
      const contentType = response.headers.get('content-type') ?? ''
      const raw = await response.text()
      let title = ''
      let text = ''
      if (/json/i.test(contentType)) {
        text = raw
      } else if (/xml|rss/i.test(contentType)) {
        text = htmlToText(raw).text
      } else if (/html|xml|text/i.test(contentType) || raw.trimStart().startsWith('<')) {
        const extracted = htmlToText(raw)
        title = extracted.title
        text = extracted.text
      } else {
        return { ok: false, message: `不支持的内容类型：${contentType || '未知'}` }
      }
      const clipped = truncate(text, maxChars)
      return {
        ok: true,
        message: `${title ? `《${title}》\n` : ''}${clipped}`,
        data: { url: parsed.toString(), title, chars: text.length, truncated: text.length > maxChars },
      }
    } catch (error) {
      return { ok: false, message: `抓取失败：${(error as Error).message}`, data: { url: parsed.toString() } }
    }
  },
}

export const WEB_TOOLS: ToolDef[] = [webSearchTool, fetchUrlTool]
