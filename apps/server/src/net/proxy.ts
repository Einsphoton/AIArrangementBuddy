/**
 * 代理感知网络层（P8 修复）：解决 macOS（国内网络）下 Node 内置 fetch 不吃代理的问题。
 *
 * 背景：Node 22 的全局 fetch（undici）只有在**进程启动时**设置 NODE_USE_ENV_PROXY=1
 * 才会读取 HTTPS_PROXY / http_proxy 等变量；开发态用 `pnpm dev`（scripts/dev.mjs）
 * 启动的 server 继承不到这个变量，于是直连 github.com / huggingface.co 超时或被重置，
 * 最终只给用户一个无用的 TypeError("fetch failed")。
 *
 * 本模块提供：
 *   - parseProxyFromEnv / detectProxyForUrl：环境变量优先，macOS 回退 `scutil --proxy`
 *   - proxyAwareFetch：有代理时用 HTTP CONNECT 自建隧道（node:http + node:tls），
 *     零新依赖，返回真正的 Response；NODE_USE_ENV_PROXY 已开启时直接用全局 fetch，
 *     避免同一请求被代理两次。
 *   - proxyEnvSnapshot / clearProxyCache：诊断与测试辅助。
 *
 * 约束：只用 Node 内置模块（node:http / node:tls / node:net / node:stream / node:child_process），
 * 不引入 undici / http-proxy 等依赖。
 */
import { spawnSync } from 'node:child_process'
import http from 'node:http'
import type { ClientRequest, IncomingHttpHeaders } from 'node:http'
import net from 'node:net'
import type { Socket } from 'node:net'
import process from 'node:process'
import { Readable } from 'node:stream'
import tls from 'node:tls'
import type { TLSSocket } from 'node:tls'

export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000
const MAX_REDIRECTS = 5

/** 代理来源：环境变量 / macOS 系统代理 */
export interface ProxyConfig {
  protocol: 'http:'
  host: string
  port: number
  /** `user:password`（原始形式，仅用于构造 Basic 认证头；不要直接打日志） */
  auth?: string
  source: 'env' | 'system'
  /** 用于展示/日志的地址（不含密码） */
  url: string
}

export interface ProxyEnvSnapshot {
  /** 实际生效的代理环境变量（密码已脱敏） */
  vars: Record<string, string>
  noProxy: string[]
  nodeEnvProxy: boolean
}

/** 代理连接失败时用于提示的代理地址 */
export interface ProxyFailureInfo {
  host: string
  port: number
}

/** 可判别的网络错误：code 形如 ETIMEDOUT / ECONNRESET / UND_ERR_* / ERR_PROXY_CONNECT */
export class ProxyFetchError extends Error {
  readonly code: string
  readonly host: string
  readonly proxy?: ProxyFailureInfo

  constructor(
    message: string,
    options: { code: string; host: string; proxy?: ProxyFailureInfo; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ProxyFetchError'
    this.code = options.code
    this.host = options.host
    this.proxy = options.proxy
  }
}

/** proxyAwareFetch 的 init：在 RequestInit 基础上追加隧道/空闲超时（毫秒） */
export type ProxyAwareFetchInit = RequestInit & {
  connectTimeoutMs?: number
  idleTimeoutMs?: number
}

export interface NetworkFailure {
  code: string
  host?: string
  proxy?: ProxyFailureInfo
}

/** 代理相关环境变量（按优先级；大小写两种写法都认） */
const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const

/**
 * 目标协议对应的代理变量优先级：
 *   - https:// 目标：HTTPS_PROXY → http_proxy → ALL_PROXY（线上真实场景，全部走这条）
 *   - http:// 目标：HTTP_PROXY → ALL_PROXY → HTTPS_PROXY 兜底（本地自测常只设 HTTPS_PROXY）
 */
function proxyEnvOrder(url: URL): readonly string[] {
  if (url.protocol !== 'http:') return PROXY_ENV_KEYS
  return ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'HTTPS_PROXY', 'https_proxy']
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** 视为「网络类错误」的 Node/undici 错误码（downloader 据此决定是否重试） */
const NETWORK_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'EPROTO',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'EADDRNOTAVAIL',
])

/* ------------------------------------------------------------------ */
/* 基础小工具                                                          */
/* ------------------------------------------------------------------ */

function targetUrl(target: string | URL): URL {
  return typeof target === 'string' ? new URL(target) : target
}

function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '')
}

function defaultPort(protocol: string): number {
  return protocol === 'https:' ? 443 : 80
}

function truthyEnv(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function errorCodeOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

function hostOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as { hostname?: unknown; host?: unknown; address?: unknown }
  for (const key of ['hostname', 'host', 'address'] as const) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

function isNetworkErrorCode(code: string): boolean {
  return NETWORK_ERROR_CODES.has(code) || code.startsWith('UND_ERR_') || code.startsWith('ERR_SOCKET_')
}

function abortError(): Error {
  const error = new Error('请求已取消')
  error.name = 'AbortError'
  ;(error as Error & { code?: string }).code = 'ABORT_ERR'
  return error
}

function timeoutError(note: string): Error {
  const error = new Error(`请求超时（${note}）`)
  ;(error as Error & { code?: string }).code = 'ETIMEDOUT'
  return error
}

function onAbort(signal: AbortSignal | undefined, handler: () => void): () => void {
  if (!signal) return () => {}
  if (signal.aborted) {
    handler()
    return () => {}
  }
  signal.addEventListener('abort', handler, { once: true })
  return () => signal.removeEventListener('abort', handler)
}

/**
 * 把 undici / Node 网络栈的异常归一成可判别的失败信息；返回 null 表示不像网络错误
 * （例如 sha256 不符、HTTP 4xx、AbortError）。
 */
export function networkFailureOf(error: unknown): NetworkFailure | null {
  if (!error || typeof error !== 'object') return null
  if (error instanceof ProxyFetchError) {
    return { code: error.code, host: error.host, proxy: error.proxy }
  }
  const name = (error as { name?: unknown }).name
  if (name === 'AbortError') return null
  const directCode = errorCodeOf(error)
  if (directCode === 'ABORT_ERR') return null
  const cause = (error as { cause?: unknown }).cause
  const causeCode = errorCodeOf(cause)
  const code = directCode ?? causeCode
  if (code && isNetworkErrorCode(code)) {
    return { code, host: hostOf(cause) ?? hostOf(error) }
  }
  const message =
    typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : ''
  // undici 的 TypeError("fetch failed") 往往把真实原因藏在 cause 里；没有 code 时也当作网络错误
  if (/fetch failed|socket hang up|network error|timed? ?out/i.test(message)) {
    return { code: code ?? 'FETCH_FAILED', host: hostOf(cause) ?? hostOf(error) }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* no_proxy 匹配                                                       */
/* ------------------------------------------------------------------ */

export function parseNoProxy(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0)
}

function normalizeNoProxyHost(entry: string): { host: string; port: string | null } {
  let value = entry.trim().toLowerCase()
  let port: string | null = null
  if (value.startsWith('[')) {
    const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(value)
    if (match) {
      value = match[1]
      port = match[2] ?? null
    }
  } else {
    const colonCount = (value.match(/:/g) ?? []).length
    if (colonCount === 1) {
      const match = /^([^:]+):(\d+)$/.exec(value)
      if (match) {
        value = match[1]
        port = match[2]
      }
    }
  }
  value = stripBrackets(value)
  // `.example.com` / `*.example.com` 都按「example.com 及其子域」处理
  value = value.replace(/^\*\./, '').replace(/^\./, '')
  return { host: value, port }
}

function matchNoProxy(entry: string, host: string, port: number): boolean {
  if (entry === '*') return true
  const normalized = normalizeNoProxyHost(entry)
  if (!normalized.host) return false
  if (normalized.port && normalized.port !== String(port)) return false
  const target = stripBrackets(host.toLowerCase())
  if (target === normalized.host) return true
  return target.endsWith(`.${normalized.host}`)
}

/** 本机/回环地址永远直连（避免把本地开发服务绕进代理） */
function isLocalHost(hostname: string): boolean {
  const host = stripBrackets(hostname.toLowerCase())
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1'
}

/* ------------------------------------------------------------------ */
/* 环境变量 / macOS 系统代理检测                                        */
/* ------------------------------------------------------------------ */

function parseProxyUrl(raw: string, source: ProxyConfig['source']): ProxyConfig | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`)
  } catch {
    return null
  }
  // 目前只支持 HTTP(S) 代理；SOCKS-only 场景直接忽略（Node 内置也不支持 socks）
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = stripBrackets(parsed.hostname)
  if (!host) return null
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  if (!Number.isInteger(port) || port <= 0) return null
  const config: ProxyConfig = {
    protocol: 'http:',
    host,
    port,
    source,
    url: `http://${host}:${port}`,
  }
  if (parsed.username || parsed.password) {
    const user = decodeURIComponent(parsed.username)
    const password = decodeURIComponent(parsed.password)
    config.auth = password ? `${user}:${password}` : user
  }
  return config
}

function hasProxyEnv(env: NodeJS.ProcessEnv): boolean {
  return PROXY_ENV_KEYS.some((key) => typeof env[key] === 'string' && (env[key] as string).trim().length > 0)
}

/**
 * 从环境变量解析目标 URL 应使用的代理（无代理返回 null）。
 * 顺序：HTTPS_PROXY → https_proxy → HTTP_PROXY → http_proxy → ALL_PROXY → all_proxy；
 * no_proxy/no_proxy 命中的目标直连。
 */
export function parseProxyFromEnv(env: NodeJS.ProcessEnv, target: string | URL): ProxyConfig | null {
  const url = targetUrl(target)
  const candidates: ProxyConfig[] = []
  for (const key of proxyEnvOrder(url)) {
    const raw = env[key]
    if (typeof raw !== 'string' || raw.trim().length === 0) continue
    const config = parseProxyUrl(raw, 'env')
    if (config) candidates.push(config)
  }
  if (candidates.length === 0) return null
  if (matchesNoProxy(env, url)) return null
  return candidates[0]
}

function matchesNoProxy(env: NodeJS.ProcessEnv, url: URL): boolean {
  const host = stripBrackets(url.hostname.toLowerCase())
  if (isLocalHost(host)) return true
  const entries = parseNoProxy(env.no_proxy ?? env.NO_PROXY)
  const port = url.port ? Number(url.port) : defaultPort(url.protocol)
  return entries.some((entry) => matchNoProxy(entry, host, port))
}

interface SystemProxyResult {
  http?: ProxyConfig
  https?: ProxyConfig
}

let systemProxyCache: { loaded: boolean; value: SystemProxyResult | null } = { loaded: false, value: null }

/** macOS 系统代理缓存（scutil 调用较慢，进程内只读一次；测试可 clear） */
function detectSystemProxy(): SystemProxyResult | null {
  if (systemProxyCache.loaded) return systemProxyCache.value
  systemProxyCache = { loaded: true, value: readSystemProxy() }
  return systemProxyCache.value
}

function readSystemProxy(): SystemProxyResult | null {
  if (process.platform !== 'darwin') return null
  let stdout = ''
  try {
    const result = spawnSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 2000 })
    if (result.error || result.status !== 0) return null
    stdout = String(result.stdout ?? '')
  } catch {
    return null
  }
  if (!stdout) return null
  const readValue = (key: string): string | undefined => {
    const match = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'm').exec(stdout)
    return match?.[1]
  }
  const readEnabled = (key: string): boolean => readValue(key) === '1'
  const parse = (enableKey: string, proxyKey: string, portKey: string): ProxyConfig | null => {
    if (!readEnabled(enableKey)) return null
    const proxy = readValue(proxyKey)
    const port = readValue(portKey)
    if (!proxy || !port) return null
    return parseProxyUrl(`${proxy}:${port}`, 'system')
  }
  const httpProxy = parse('HTTPEnable', 'HTTPProxy', 'HTTPPort')
  const httpsProxy = parse('HTTPSEnable', 'HTTPSProxy', 'HTTPSPort')
  // 只有 SOCKS 时（HTTP/HTTPS 都未启用）视为无可用代理
  if (!httpProxy && !httpsProxy) return null
  return { http: httpProxy ?? undefined, https: httpsProxy ?? undefined }
}

/**
 * 检测目标 URL 应使用的代理：环境变量优先；没有代理环境变量时 macOS 回退系统代理。
 * 本机地址（localhost/127.0.0.1/::1）与 no_proxy 命中的目标永远直连。
 */
export function detectProxyForUrl(target: string | URL): ProxyConfig | null {
  const url = targetUrl(target)
  if (hasProxyEnv(process.env)) return parseProxyFromEnv(process.env, url)
  if (isLocalHost(url.hostname)) return null
  // NO_PROXY=* 表示完全禁用代理（包括系统代理），便于测试/排障
  const noProxy = parseNoProxy(process.env.no_proxy ?? process.env.NO_PROXY)
  if (noProxy.includes('*')) return null
  const system = detectSystemProxy()
  if (!system) return null
  return url.protocol === 'https:' ? (system.https ?? system.http ?? null) : (system.http ?? system.https ?? null)
}

/** 测试/排障：清掉进程级系统代理缓存 */
export function clearProxyCache(): void {
  systemProxyCache = { loaded: false, value: null }
}

/** 给用户看的环境快照（代理密码脱敏） */
export function proxyEnvSnapshot(): ProxyEnvSnapshot {
  const vars: Record<string, string> = {}
  for (const key of PROXY_ENV_KEYS) {
    const raw = process.env[key]
    if (typeof raw !== 'string' || raw.trim().length === 0) continue
    vars[key] = maskProxyAuth(raw.trim())
  }
  return {
    vars,
    noProxy: parseNoProxy(process.env.no_proxy ?? process.env.NO_PROXY),
    nodeEnvProxy: truthyEnv(process.env.NODE_USE_ENV_PROXY),
  }
}

function maskProxyAuth(raw: string): string {
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`)
    if (url.username || url.password) {
      url.username = url.username
      url.password = '***'
      return url.toString()
    }
    return raw
  } catch {
    return raw.replace(/(\/\/[^/@\s:]+):[^@\s/]+@/, '$1:***@')
  }
}

/* ------------------------------------------------------------------ */
/* 代理请求实现                                                        */
/* ------------------------------------------------------------------ */

interface RawResponse {
  status: number
  statusText: string
  headers: Headers
  stream: Readable | null
  destroy: () => void
}

interface RequestContext {
  url: URL
  method: string
  headers: Headers
  body: BodyInit | null | undefined
  signal?: AbortSignal
  connectTimeoutMs: number
  idleTimeoutMs: number
}

function proxyFailureInfo(proxy: ProxyConfig): ProxyFailureInfo {
  return { host: proxy.host, port: proxy.port }
}

function basicAuthHeader(auth: string): string {
  return `Basic ${Buffer.from(auth, 'utf8').toString('base64')}`
}

function toHeaderRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    record[key] = value
  })
  return record
}

function removeSensitiveHeaders(headers: Headers): Headers {
  const next = new Headers(headers)
  next.delete('authorization')
  next.delete('cookie')
  return next
}

function removeBodyHeaders(headers: Headers): Headers {
  const next = new Headers(headers)
  next.delete('content-length')
  next.delete('content-type')
  return next
}

async function bodyToBuffer(body: BodyInit | null | undefined, host: string): Promise<Buffer | null> {
  if (body === null || body === undefined) return null
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8')
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  if (typeof Blob !== 'undefined' && body instanceof Blob) return Buffer.from(await body.arrayBuffer())
  throw new ProxyFetchError(`暂不支持的请求体类型（代理请求目前用于下载 GET）：${host}`, {
    code: 'ERR_UNSUPPORTED_BODY',
    host,
  })
}

function incomingHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers()
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) result.append(key, item)
    } else {
      result.set(key, String(value))
    }
  }
  return result
}

function statusTextOf(status: number, message: string | undefined): string {
  if (message && message.length > 0) return message
  return http.STATUS_CODES[status] ?? ''
}

/** 在已建立的隧道（TLS）上发送请求 */
function sendOverTunnel(socket: TLSSocket, ctx: RequestContext, proxy: ProxyConfig): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const host = stripBrackets(ctx.url.hostname)
    const port = ctx.url.port ? Number(ctx.url.port) : 443
    let settled = false
    let removeAbort = onAbort(ctx.signal, () => {
      socket.destroy(abortError())
    })
    const finishError = (error: unknown): void => {
      if (settled) return
      settled = true
      removeAbort()
      socket.destroy()
      reject(error)
    }
    void (async () => {
      try {
        const body = await bodyToBuffer(ctx.body, host)
        const headers = toHeaderRecord(ctx.headers)
        headers.host = ctx.url.host
        if (body && headers['content-length'] === undefined) headers['content-length'] = String(body.length)
        // 复用已握手完成的 TLS socket：http.request 只负责说 HTTP，不再自己建连接
        const agent = new http.Agent({ keepAlive: false })
        ;(agent as unknown as { createConnection: () => Socket }).createConnection = () => socket
        const request = http.request({
          host,
          port,
          method: ctx.method,
          path: `${ctx.url.pathname}${ctx.url.search}`,
          headers,
          agent,
        })
        socket.setTimeout(ctx.idleTimeoutMs, () => {
          socket.destroy(timeoutError(`等待 ${host} 响应数据超时`))
        })
        request.once('error', (error) => {
          finishError(
            new ProxyFetchError(`网络请求失败（${errorCodeOf(error) ?? 'UNKNOWN'}）：${host}`, {
              code: errorCodeOf(error) ?? 'UNKNOWN',
              host,
              proxy: proxyFailureInfo(proxy),
              cause: error,
            }),
          )
        })
        request.once('response', (response) => {
          settled = true
          const status = response.statusCode ?? 0
          const result: RawResponse = {
            status,
            statusText: statusTextOf(status, response.statusMessage),
            headers: incomingHeaders(response.headers),
            stream: response,
            destroy: () => {
              response.destroy()
              socket.destroy()
            },
          }
          response.once('close', () => {
            removeAbort()
          })
          resolve(result)
        })
        request.end(body ?? undefined)
      } catch (error) {
        finishError(error)
      }
    })()
  })
}

/** 通过 HTTP 代理的绝对 URL 形式发送请求（主要供 http:// 目标与自测使用） */
function sendViaProxyAbsolute(
  ctx: RequestContext,
  proxy: ProxyConfig,
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const host = stripBrackets(ctx.url.hostname)
    let settled = false
    let connectTimer: NodeJS.Timeout | null = null
    let request: ClientRequest | null = null
    const cleanup = (): void => {
      if (connectTimer) {
        clearTimeout(connectTimer)
        connectTimer = null
      }
    }
    const removeAbort = onAbort(ctx.signal, () => {
      request?.destroy(abortError())
    })
    const finishError = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      removeAbort()
      request?.destroy()
      reject(error)
    }
    void (async () => {
      try {
        const body = await bodyToBuffer(ctx.body, host)
        const headers = toHeaderRecord(ctx.headers)
        headers.host = ctx.url.host
        if (proxy.auth) headers['proxy-authorization'] = basicAuthHeader(proxy.auth)
        if (body && headers['content-length'] === undefined) headers['content-length'] = String(body.length)
        const absoluteTarget = `${ctx.url.protocol}//${ctx.url.host}${ctx.url.pathname}${ctx.url.search}`
        request = http.request({
          host: proxy.host,
          port: proxy.port,
          method: ctx.method,
          path: absoluteTarget,
          headers,
        })
        connectTimer = setTimeout(() => {
          request?.destroy(timeoutError(`连接代理 ${proxy.host}:${proxy.port} 超时`))
        }, ctx.connectTimeoutMs)
        request.once('error', (error) => {
          const code = errorCodeOf(error) ?? 'UNKNOWN'
          finishError(
            new ProxyFetchError(`网络请求失败（${code}）：${host}`, {
              code,
              host,
              proxy: proxyFailureInfo(proxy),
              cause: error,
            }),
          )
        })
        request.once('response', (response) => {
          settled = true
          cleanup()
          const status = response.statusCode ?? 0
          const socket = response.socket
          socket.setTimeout(ctx.idleTimeoutMs, () => {
            socket.destroy(timeoutError(`等待 ${host} 响应数据超时`))
          })
          const result: RawResponse = {
            status,
            statusText: statusTextOf(status, response.statusMessage),
            headers: incomingHeaders(response.headers),
            stream: response,
            destroy: () => {
              response.destroy()
              socket.destroy()
            },
          }
          response.once('close', () => {
            removeAbort()
          })
          resolve(result)
        })
        request.end(body ?? undefined)
      } catch (error) {
        finishError(error)
      }
    })()
  })
}

/** 与 HTTP 代理建立 CONNECT 隧道，并在其上完成 TLS 握手 */
function openTunnel(
  proxy: ProxyConfig,
  url: URL,
  connectTimeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    const host = stripBrackets(url.hostname)
    const port = url.port ? Number(url.port) : 443
    const authority = `${url.hostname}:${port}`
    let settled = false
    let request: ClientRequest | null = null
    let removeAbort: () => void = () => {}
    let timer: NodeJS.Timeout | null = null
    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      removeAbort()
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      request?.destroy()
      reject(error)
    }
    removeAbort = onAbort(signal, () => {
      request?.destroy(abortError())
    })
    const headers: Record<string, string> = { host: authority }
    if (proxy.auth) headers['proxy-authorization'] = basicAuthHeader(proxy.auth)
    request = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: authority,
      headers,
    })
    timer = setTimeout(() => {
      request?.destroy(timeoutError(`连接代理 ${proxy.host}:${proxy.port} 超时`))
    }, connectTimeoutMs)
    request.once('error', (error) => {
      fail(
        new ProxyFetchError(`网络请求失败（${errorCodeOf(error) ?? 'UNKNOWN'}）：${host}`, {
          code: errorCodeOf(error) ?? 'UNKNOWN',
          host,
          proxy: proxyFailureInfo(proxy),
          cause: error,
        }),
      )
    })
    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        fail(
          new ProxyFetchError(`代理 CONNECT 失败（HTTP ${response.statusCode ?? 0}）：${host}`, {
            code: 'ERR_PROXY_CONNECT',
            host,
            proxy: proxyFailureInfo(proxy),
          }),
        )
        return
      }
      if (head && head.length > 0) socket.unshift(head)
      const tlsSocket = tls.connect({
        socket,
        servername: net.isIP(host) ? undefined : host,
      })
      tlsSocket.once('secureConnect', () => {
        if (settled) {
          tlsSocket.destroy()
          return
        }
        settled = true
        cleanup()
        resolve(tlsSocket)
      })
      tlsSocket.once('error', (error) => {
        socket.destroy()
        fail(
          new ProxyFetchError(`网络请求失败（${errorCodeOf(error) ?? 'ERR_TLS'}）：${host}`, {
            code: errorCodeOf(error) ?? 'ERR_TLS',
            host,
            proxy: proxyFailureInfo(proxy),
            cause: error,
          }),
        )
      })
    })
    request.end()
  })
}

async function requestOnce(ctx: RequestContext, proxy: ProxyConfig): Promise<RawResponse> {
  if (ctx.url.protocol === 'http:') return sendViaProxyAbsolute(ctx, proxy)
  const tunnel = await openTunnel(proxy, ctx.url, ctx.connectTimeoutMs, ctx.signal)
  // 隧道已建立：把握手阶段的超时换成读取阶段的空闲超时
  tunnel.setTimeout(ctx.idleTimeoutMs)
  try {
    return await sendOverTunnel(tunnel, ctx, proxy)
  } catch (error) {
    tunnel.destroy()
    throw error
  }
}

function toWebResponse(raw: RawResponse): Response {
  const nullBody = raw.status === 204 || raw.status === 205 || raw.status === 304
  const body =
    nullBody || !raw.stream
      ? null
      : (Readable.toWeb(raw.stream) as unknown as ReadableStream<Uint8Array>)
  return new Response(body, {
    status: raw.status,
    statusText: raw.statusText,
    headers: raw.headers,
  })
}

function normalizeRequest(input: RequestInfo | URL, init: ProxyAwareFetchInit): RequestContext {
  let url: string
  let method = init.method ?? 'GET'
  let headers = new Headers(init.headers ?? undefined)
  let body: BodyInit | null | undefined = init.body
  let signal = init.signal ?? undefined
  if (typeof input === 'string') {
    url = input
  } else if (input instanceof URL) {
    url = input.toString()
  } else {
    url = input.url
    if (init.method === undefined) method = input.method
    if (init.headers === undefined) headers = new Headers(input.headers)
    if (init.body === undefined) body = input.body
    if (init.signal === undefined) signal = input.signal
  }
  return {
    url: new URL(url),
    method: method.toUpperCase(),
    headers,
    body,
    signal,
    connectTimeoutMs: init.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    idleTimeoutMs: init.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
  }
}

/**
 * 代理感知的 fetch：无代理或 NODE_USE_ENV_PROXY 已开启时直接用全局 fetch；
 * 否则经代理自建隧道请求，返回真正的 Response（body 为 web ReadableStream）。
 *
 * 支持 init.signal 中止、connectTimeoutMs（默认 15s）、idleTimeoutMs（默认 60s）、
 * 手动跟随最多 5 次重定向（303 降级为 GET）。失败时抛 ProxyFetchError，
 * message 形如 `网络请求失败（ETIMEDOUT）：github.com`，并带可判别的 code。
 */
export async function proxyAwareFetch(
  input: RequestInfo | URL,
  init: ProxyAwareFetchInit = {},
): Promise<Response> {
  const { connectTimeoutMs, idleTimeoutMs, ...requestInit } = init
  const ctx = normalizeRequest(input, { ...requestInit, connectTimeoutMs, idleTimeoutMs })
  if (ctx.signal?.aborted) throw abortError()
  // 进程已启用 Node 内置的环境代理（undici EnvHttpProxyAgent）时不要重复代理
  if (truthyEnv(process.env.NODE_USE_ENV_PROXY)) {
    return fetch(input, requestInit)
  }
  const proxy = detectProxyForUrl(ctx.url)
  if (!proxy) return fetch(input, requestInit)

  let currentUrl = ctx.url
  let method = ctx.method
  let headers = ctx.headers
  let body = ctx.body
  let redirects = 0
  const originalHost = ctx.url.hostname
  for (;;) {
    const currentCtx: RequestContext = { ...ctx, url: currentUrl, method, headers, body }
    let raw: RawResponse
    try {
      raw = await requestOnce(currentCtx, proxy)
    } catch (error) {
      if (ctx.signal?.aborted) throw abortError()
      if (error instanceof ProxyFetchError) throw error
      const code = errorCodeOf(error) ?? (error instanceof Error ? error.name : 'UNKNOWN')
      throw new ProxyFetchError(`网络请求失败（${code}）：${stripBrackets(currentUrl.hostname)}`, {
        code,
        host: stripBrackets(currentUrl.hostname),
        proxy: proxyFailureInfo(proxy),
        cause: error,
      })
    }
    if (!REDIRECT_STATUSES.has(raw.status)) return toWebResponse(raw)
    const location = raw.headers.get('location')
    if (!location) return toWebResponse(raw)
    if (redirects >= MAX_REDIRECTS) {
      raw.destroy()
      throw new ProxyFetchError(`重定向次数过多（>${MAX_REDIRECTS}）：${originalHost}`, {
        code: 'ERR_TOO_MANY_REDIRECTS',
        host: stripBrackets(currentUrl.hostname),
        proxy: proxyFailureInfo(proxy),
      })
    }
    let nextUrl: URL
    try {
      nextUrl = new URL(location, currentUrl)
    } catch {
      raw.destroy()
      throw new ProxyFetchError(`重定向地址无法解析：${location}`, {
        code: 'ERR_INVALID_REDIRECT',
        host: stripBrackets(currentUrl.hostname),
        proxy: proxyFailureInfo(proxy),
      })
    }
    raw.destroy()
    redirects += 1
    // 303 一定降级 GET；301/302 对非 GET/HEAD 也按浏览器习惯降级
    if (raw.status === 303 || ((raw.status === 301 || raw.status === 302) && method !== 'GET' && method !== 'HEAD')) {
      method = 'GET'
      body = null
      headers = removeBodyHeaders(headers)
    }
    if (nextUrl.host !== currentUrl.host) headers = removeSensitiveHeaders(headers)
    currentUrl = nextUrl
  }
}
