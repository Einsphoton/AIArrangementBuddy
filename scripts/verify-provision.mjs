#!/usr/bin/env node
/**
 * 代理感知下载层验收（P8 回归）：apps/server/src/net/proxy.ts + provision/downloader.ts。
 *
 *   node --import tsx scripts/verify-provision.mjs
 *
 * 覆盖：
 *   1. parseProxyFromEnv：大小写 / ALL_PROXY 兜底 / auth / 无效值忽略 / no_proxy 各种匹配
 *   2. detectProxyForUrl / clearProxyCache / proxyEnvSnapshot（env 优先、缓存可清、auth 脱敏）
 *   3. proxyAwareFetch：本地 http origin + 本地 http 代理（绝对 URL 转发），
 *      200/404 透传、Range 透传、302 跟随、abort、代理不可达可诊断、本机默认直连、CONNECT 502
 *   4. downloadFile：缓存命中、sha256 正确/不符、断点续传（只请求剩余字节 + 增量 hash）、
 *      服务器忽略 Range、attempts=3 重试、网络错误文案（主机名 + 代理提示）
 *
 * 约束：全部 loopback / fake fetchImpl，不访问公网；不新增依赖；跑完关闭所有本地 server。
 * 用法：失败时非 0 退出，输出 ✓/✗ 与失败原因。
 */
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROXY_TS = path.join(ROOT, 'apps', 'server', 'src', 'net', 'proxy.ts')
const DOWNLOADER_TS = path.join(ROOT, 'apps', 'server', 'src', 'provision', 'downloader.ts')

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', bold: '\x1b[1m' }
let passed = 0
let failed = 0
const failures = []
const startedAt = Date.now()

function ok(message, detail = '') {
  passed++
  console.log(`  ${C.green}✓${C.reset} ${message}${detail ? `${C.dim}  ${detail}${C.reset}` : ''}`)
}
function bad(message, error) {
  failed++
  const text = error instanceof Error ? error.message : String(error)
  failures.push(`${message}: ${text}`)
  console.log(`  ${C.red}✗${C.reset} ${message}${C.dim}  ${text}${C.reset}`)
}
async function check(name, fn) {
  try {
    const detail = await fn()
    ok(name, typeof detail === 'string' ? detail : '')
  } catch (error) {
    bad(name, error)
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}
function exists(file) {
  return existsSync(file)
}
function fileSize(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}
async function captureRejection(fn, label) {
  try {
    await fn()
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error(`${label}：预期抛错，但没有抛`)
}

/* ------------------------------------------------------------------ */
/* 本地确定性网络：origin + 绝对 URL 形式的 http 代理                   */
/* ------------------------------------------------------------------ */

const SMALL_BODY = Buffer.from('provision-verify-payload-0123456789')
const RANGE_BODY = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37 + 11) % 256))
const RESUME_AT = 1234

/** 记录每次请求的 method/url/headers/status/bytesSent，供断言使用。 */
function serveBytes(req, res, body, { ignoreRange = false } = {}) {
  const record = {
    method: req.method,
    url: req.url,
    path: new URL(req.url ?? '/', 'http://127.0.0.1').pathname,
    headers: { ...req.headers },
  }
  const rangeHeader = req.headers.range
  let status = 200
  let slice = body
  let start = 0
  let end = body.length - 1
  if (!ignoreRange && typeof rangeHeader === 'string') {
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim())
    if (match) {
      start = Number(match[1])
      if (match[2]) end = Math.min(Number(match[2]), body.length - 1)
      if (start >= body.length) {
        record.status = 416
        record.bytesSent = 0
        res.writeHead(416, { 'content-range': `bytes */${body.length}` })
        res.end()
        return record
      }
      status = 206
      slice = body.subarray(start, end + 1)
    }
  }
  const headers = {
    'content-type': 'application/octet-stream',
    'content-length': String(slice.length),
    'accept-ranges': 'bytes',
  }
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${body.length}`
  record.status = status
  record.bytesSent = slice.length
  record.range = typeof rangeHeader === 'string' ? rangeHeader : null
  res.writeHead(status, headers)
  res.end(slice)
  return record
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function closeServer(server) {
  if (!server || !server.listening) return
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(() => resolve()))
}

async function startOrigin() {
  const requests = []
  let flakyCount = 0
  let mismatchRangeHits = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname
    const record = (extra) => {
      const entry = { method: req.method, url: req.url, headers: { ...req.headers }, path: pathname, ...extra }
      requests.push(entry)
      return entry
    }
    if (pathname === '/ok') {
      record({ status: 200, bytesSent: SMALL_BODY.length })
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(SMALL_BODY.length) })
      res.end(SMALL_BODY)
      return
    }
    if (pathname === '/missing') {
      record({ status: 404, bytesSent: 0 })
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not-found')
      return
    }
    if (pathname === '/redirect') {
      record({ status: 302, bytesSent: 0 })
      res.writeHead(302, { location: '/ok' })
      res.end()
      return
    }
    if (pathname === '/range') {
      const entry = serveBytes(req, res, RANGE_BODY)
      requests.push(entry)
      return
    }
    if (pathname === '/ignore-range') {
      const entry = serveBytes(req, res, RANGE_BODY, { ignoreRange: true })
      requests.push(entry)
      return
    }
    if (pathname === '/mismatch-range') {
      // 第一次故意回一个「206 但 content-range.start 与客户端 .part 偏移不符」的坏响应：
      // 声称从 0 开始，实际只发 .part 之后的尾巴（模拟代理/镜像服务器错标区间）。
      // 之后的请求恢复成 200 + 完整文件，供「丢弃分片后从头下载」走通。
      mismatchRangeHits += 1
      const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : null
      if (mismatchRangeHits === 1) {
        const tail = RANGE_BODY.subarray(RESUME_AT)
        requests.push({
          method: req.method,
          url: req.url,
          path: pathname,
          headers: { ...req.headers },
          range: rangeHeader,
          status: 206,
          bytesSent: tail.length,
          contentRange: `bytes 0-${RANGE_BODY.length - 1}/${RANGE_BODY.length}`,
        })
        res.writeHead(206, {
          'content-type': 'application/octet-stream',
          'content-length': String(tail.length),
          'content-range': `bytes 0-${RANGE_BODY.length - 1}/${RANGE_BODY.length}`,
          'accept-ranges': 'bytes',
        })
        res.end(tail)
        return
      }
      requests.push({
        method: req.method,
        url: req.url,
        path: pathname,
        headers: { ...req.headers },
        range: rangeHeader,
        status: 200,
        bytesSent: RANGE_BODY.length,
      })
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(RANGE_BODY.length),
        'accept-ranges': 'bytes',
      })
      res.end(RANGE_BODY)
      return
    }
    if (pathname === '/asset') {
      record({ status: 200, bytesSent: SMALL_BODY.length })
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(SMALL_BODY.length) })
      res.end(SMALL_BODY)
      return
    }
    if (pathname === '/flaky') {
      flakyCount += 1
      if (flakyCount <= 2) {
        record({ status: 500, bytesSent: 0 })
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('boom')
        return
      }
      record({ status: 200, bytesSent: SMALL_BODY.length })
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(SMALL_BODY.length) })
      res.end(SMALL_BODY)
      return
    }
    if (pathname === '/slow') {
      // 先挂起不发响应头，客户端 abort 时请求仍处于 pending，才能验证 promise reject。
      const entry = record({ status: 0, bytesSent: 0 })
      const timer = setTimeout(() => {
        entry.status = 200
        entry.bytesSent = 11
        try {
          res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '11' })
          res.end('0123456789')
        } catch {
          /* 连接已被 abort */
        }
      }, 800)
      const clear = () => clearTimeout(timer)
      req.on('close', clear)
      res.on('close', clear)
      return
    }
    record({ status: 404, bytesSent: 0 })
    res.writeHead(404)
    res.end()
  })
  const port = await listen(server)
  return { server, port, requests, close: () => closeServer(server) }
}

/**
 * 极简正向代理：只支持绝对 URL 形式的明文 http 转发（CONNECT 返回 502）。
 * 把 origin.test:<port> 重写到真实 origin（127.0.0.1:<originPort>）。
 */
async function startProxy(originPort) {
  const requests = []
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers } })
    if (typeof req.url !== 'string' || !/^https?:\/\//i.test(req.url)) {
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('test-proxy: absolute URL required')
      return
    }
    let target
    try {
      target = new URL(req.url)
    } catch {
      res.writeHead(400)
      res.end('test-proxy: bad url')
      return
    }
    const headers = { ...req.headers }
    delete headers['proxy-connection']
    delete headers['proxy-authorization']
    headers.host = `127.0.0.1:${originPort}`
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: originPort,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      },
    )
    upstream.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`test-proxy upstream error: ${error.message}`)
    })
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  })
  // CONNECT 由 server 的 'connect' 事件处理（http.Server 不会把 CONNECT 派发到 'request'）。
  // 这里统一回 502，用于验证「代理拒绝 CONNECT」时的错误可诊断性。
  server.on('connect', (req, clientSocket, head) => {
    requests.push({ method: 'CONNECT', url: req.url, headers: { ...req.headers } })
    if (head?.length) clientSocket.unshift(head)
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  })
  const port = await listen(server)
  return { server, port, requests, close: () => closeServer(server) }
}

/** 拿一个「当前空闲、随后关闭」的端口，用于制造 ECONNREFUSED。 */
async function closedPort() {
  const probe = createServer()
  const port = await listen(probe)
  await closeServer(probe)
  return port
}

/* ------------------------------------------------------------------ */
/* 产品源码动态导入 + 代理环境变量隔离                                  */
/* ------------------------------------------------------------------ */

let proxyMod = null
let downloaderMod = null

async function importProduct() {
  assert(existsSync(PROXY_TS), `缺少 ${path.relative(ROOT, PROXY_TS)}（等待 proxy-net 完成 task-1）`)
  assert(existsSync(DOWNLOADER_TS), `缺少 ${path.relative(ROOT, DOWNLOADER_TS)}`)
  proxyMod = await import(pathToFileURL(PROXY_TS).href)
  downloaderMod = await import(pathToFileURL(DOWNLOADER_TS).href)
  for (const name of ['parseProxyFromEnv', 'detectProxyForUrl', 'proxyEnvSnapshot', 'clearProxyCache', 'proxyAwareFetch']) {
    assert(typeof proxyMod[name] === 'function', `proxy.ts 未导出函数 ${name}`)
  }
  assert(typeof downloaderMod.downloadFile === 'function', 'downloader.ts 未导出 downloadFile')
}

const MANAGED_ENV = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
]
const ORIGINAL_ENV = {}
for (const key of MANAGED_ENV) ORIGINAL_ENV[key] = process.env[key]

function applyEnv(vars) {
  for (const key of MANAGED_ENV) delete process.env[key]
  for (const [key, value] of Object.entries(vars)) process.env[key] = value
  proxyMod?.clearProxyCache?.()
}

function restoreOriginalEnv() {
  for (const key of MANAGED_ENV) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key]
    else process.env[key] = ORIGINAL_ENV[key]
  }
  proxyMod?.clearProxyCache?.()
}

/** 在隔离的代理 env 下执行 fn；结束时恢复成「全部清空」的基线。 */
async function withProxyEnv(vars, fn) {
  applyEnv(vars)
  try {
    return await fn()
  } finally {
    applyEnv({})
  }
}

/* ------------------------------------------------------------------ */
/* 1. parseProxyFromEnv（纯函数）                                       */
/* ------------------------------------------------------------------ */

async function testParseProxyFromEnv() {
  const parse = proxyMod.parseProxyFromEnv
  const HTTP_TARGET = 'http://example.com/asset.bin'
  const HTTPS_TARGET = 'https://github.com/asset.bin'

  await check('HTTPS_PROXY（大写）→ https 目标解析出 host/port/protocol/source', () => {
    const config = parse({ HTTPS_PROXY: 'http://127.0.0.1:10808' }, HTTPS_TARGET)
    assert(config, '应解析出代理配置')
    eq(config.host, '127.0.0.1', 'host')
    eq(config.port, 10808, 'port')
    eq(config.source, 'env', 'source')
    eq(config.protocol, 'http:', 'protocol')
    assert(typeof config.url === 'string' && config.url.includes('10808'), 'url 应包含端口')
    return `${config.host}:${config.port}`
  })

  await check('https_proxy（小写）→ http 目标也能解析', () => {
    const config = parse({ https_proxy: 'http://127.0.0.1:10809' }, HTTP_TARGET)
    assert(config, '应解析出代理配置')
    eq(config.port, 10809, 'port')
  })

  await check('仅 HTTP_PROXY → http 目标生效', () => {
    const config = parse({ HTTP_PROXY: 'http://127.0.0.1:10810' }, HTTP_TARGET)
    assert(config, '应解析出代理配置')
    eq(config.port, 10810, 'port')
  })

  await check('ALL_PROXY 兜底（无 HTTPS_PROXY/HTTP_PROXY）', () => {
    const config = parse({ ALL_PROXY: 'http://127.0.0.1:10811' }, HTTPS_TARGET)
    assert(config, 'ALL_PROXY 应作为兜底')
    eq(config.port, 10811, 'port')
  })

  await check('优先级：https 目标优先 HTTPS_PROXY，http 目标优先 HTTP_PROXY', () => {
    const env = {
      HTTPS_PROXY: 'http://127.0.0.1:10812',
      HTTP_PROXY: 'http://127.0.0.1:10813',
      ALL_PROXY: 'http://127.0.0.1:10814',
    }
    const httpsConfig = parse(env, 'https://github.com/asset.bin')
    assert(httpsConfig, 'https 目标应解析出代理配置')
    eq(httpsConfig.port, 10812, 'https 目标应优先 HTTPS_PROXY')
    const httpConfig = parse(env, 'http://example.com/asset.bin')
    assert(httpConfig, 'http 目标应解析出代理配置')
    eq(httpConfig.port, 10813, 'http 目标应优先 HTTP_PROXY')
  })

  await check('user:pass@ → auth 字段', () => {
    const config = parse({ HTTPS_PROXY: 'http://alice:s3cret@127.0.0.1:10815' }, HTTPS_TARGET)
    assert(config, '应解析出代理配置')
    assert(config.auth, '应解析出 auth')
    const decoded = /^[A-Za-z0-9+/=]+$/.test(config.auth) ? Buffer.from(config.auth, 'base64').toString('utf8') : config.auth
    assert(decoded.includes('alice') && decoded.includes('s3cret'), `auth 应包含用户名与密码（实际 ${config.auth}）`)
    return 'auth 已解析'
  })

  await check('无效代理值忽略（非 URL / 空串 / 缺 host / ftp 协议）', () => {
    const invalid = ['not a url', '', 'http://', 'ftp://127.0.0.1:21']
    for (const value of invalid) {
      eq(parse({ HTTPS_PROXY: value }, HTTPS_TARGET), null, `HTTPS_PROXY=${JSON.stringify(value)}`)
    }
    eq(parse({}, HTTPS_TARGET), null, '空 env')
  })

  await check('不支持的 socks5:// 代理值忽略（不会返回不可用配置）', () => {
    eq(parse({ ALL_PROXY: 'socks5://127.0.0.1:1080' }, HTTPS_TARGET), null, 'ALL_PROXY=socks5')
    eq(parse({ HTTPS_PROXY: 'socks5h://127.0.0.1:1080' }, HTTPS_TARGET), null, 'HTTPS_PROXY=socks5h')
  })

  await check('no_proxy=* → http/https 目标都绕过', () => {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:10816', NO_PROXY: '*' }
    eq(parse(env, HTTP_TARGET), null, 'http 目标')
    eq(parse(env, HTTPS_TARGET), null, 'https 目标')
  })

  await check('no_proxy=localhost → localhost 目标绕过', () => {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:10817', NO_PROXY: 'localhost' }
    eq(parse(env, 'http://localhost:3000/x'), null, 'localhost')
    assert(parse(env, 'http://localhost.example.com/x'), 'localhost.example.com 不应被 localhost 匹配')
  })

  await check('无 no_proxy 时默认绕过 127.0.0.1 / [::1]', () => {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:10818' }
    eq(parse(env, 'http://127.0.0.1:3000/x'), null, '127.0.0.1')
    eq(parse(env, 'http://[::1]:3000/x'), null, '::1')
  })

  await check('no_proxy=.example.com → 子域绕过、其它域仍走代理', () => {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:10819', NO_PROXY: '.example.com' }
    eq(parse(env, 'https://api.example.com/x'), null, 'api.example.com')
    const other = parse(env, 'https://other.test/x')
    assert(other, 'other.test 应仍走代理')
  })

  await check('no_proxy=example.com:8080 → 仅该端口绕过，其它端口仍走代理', () => {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:10820', NO_PROXY: 'example.com:8080' }
    eq(parse(env, 'http://example.com:8080/x'), null, 'example.com:8080')
    const other = parse(env, 'http://example.com:9090/x')
    assert(other, 'example.com:9090 应仍走代理')
  })

  await check('no_proxy 大小写不敏感 + 逗号分隔', () => {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:10821', NO_PROXY: 'Foo.COM, .example.com' }
    eq(parse(env, 'http://foo.com/x'), null, 'Foo.COM 应匹配 foo.com')
    eq(parse(env, 'http://api.example.com/x'), null, '逗号分隔的第二项')
  })
}

/* ------------------------------------------------------------------ */
/* 2. detectProxyForUrl / clearProxyCache / proxyEnvSnapshot            */
/* ------------------------------------------------------------------ */

async function testDetectAndSnapshot() {
  await check('detectProxyForUrl 读取 env 代理（source=env）', async () => {
    await withProxyEnv({ HTTPS_PROXY: 'http://127.0.0.1:10830' }, async () => {
      const config = proxyMod.detectProxyForUrl('https://github.com/asset.bin')
      assert(config, '应检测到代理')
      eq(config.port, 10830, 'port')
      eq(config.source, 'env', 'source')
      return `env ${config.host}:${config.port}`
    })
  })

  await check('clearProxyCache 后能读到新的 env 代理', async () => {
    await withProxyEnv({ HTTPS_PROXY: 'http://127.0.0.1:10831' }, async () => {
      const first = proxyMod.detectProxyForUrl('https://github.com/asset.bin')
      assert(first, '首次应检测到代理')
      eq(first.port, 10831, '首次 port')
      process.env.HTTPS_PROXY = 'http://127.0.0.1:10832'
      proxyMod.clearProxyCache()
      const second = proxyMod.detectProxyForUrl('https://github.com/asset.bin')
      assert(second, '清缓存后应检测到代理')
      eq(second.port, 10832, '清缓存后 port')
    })
  })

  await check('detectProxyForUrl 默认绕过本机地址', async () => {
    await withProxyEnv({ HTTPS_PROXY: 'http://127.0.0.1:10833' }, async () => {
      eq(proxyMod.detectProxyForUrl('http://127.0.0.1:3000/x'), null, '127.0.0.1')
      eq(proxyMod.detectProxyForUrl('http://localhost:3000/x'), null, 'localhost')
    })
  })

  await check('proxyEnvSnapshot：auth 脱敏 + noProxy 数组 + nodeEnvProxy 布尔', async () => {
    await withProxyEnv(
      {
        HTTPS_PROXY: 'http://alice:s3cret@127.0.0.1:10834',
        NO_PROXY: 'localhost, .example.com',
        NODE_USE_ENV_PROXY: '1',
      },
      async () => {
        const snapshot = proxyMod.proxyEnvSnapshot()
        assert(snapshot && typeof snapshot === 'object', '应返回对象')
        const serialized = JSON.stringify(snapshot)
        assert(!serialized.includes('s3cret'), 'snapshot 不应泄露代理密码')
        const varValues = Object.values(snapshot.vars ?? {}).join(' ')
        assert(varValues.includes('10834'), 'vars 应包含代理端口')
        assert(Array.isArray(snapshot.noProxy), 'noProxy 应是数组')
        assert(snapshot.noProxy.includes('localhost'), `noProxy 应包含 localhost（实际 ${JSON.stringify(snapshot.noProxy)}）`)
        eq(snapshot.nodeEnvProxy, true, 'nodeEnvProxy')
        return `vars=${Object.keys(snapshot.vars ?? {}).length} noProxy=${snapshot.noProxy.length}`
      },
    )
  })
}

/* ------------------------------------------------------------------ */
/* 3. proxyAwareFetch（本地 http origin + 本地 http 代理）              */
/* ------------------------------------------------------------------ */

async function testProxyAwareFetch(origin, proxyServer) {
  const fetchProxy = proxyMod.proxyAwareFetch
  const targetHost = 'origin.test'
  const originUrl = (pathname) => `http://${targetHost}:${origin.port}${pathname}`

  await check('代理转发 200：状态与 body 透传（绝对 URL 形式）', async () => {
    await withProxyEnv({ HTTPS_PROXY: `http://127.0.0.1:${proxyServer.port}` }, async () => {
      const before = proxyServer.requests.length
      const response = await fetchProxy(originUrl('/ok'))
      eq(response.status, 200, 'status')
      const text = await response.text()
      eq(text, SMALL_BODY.toString(), 'body')
      assert(proxyServer.requests.length > before, '请求应经过本地代理')
      const forwarded = proxyServer.requests.at(-1)
      assert(/^http:\/\/origin\.test:\d+\/ok$/.test(forwarded.url), `代理应收到绝对 URL（实际 ${forwarded.url}）`)
      return `proxy 请求 ${forwarded.url}`
    })
  })

  await check('代理转发 404：状态码透传且 ok=false', async () => {
    await withProxyEnv({ HTTPS_PROXY: `http://127.0.0.1:${proxyServer.port}` }, async () => {
      const response = await fetchProxy(originUrl('/missing'))
      eq(response.status, 404, 'status')
      eq(response.ok, false, 'ok')
      const text = await response.text()
      eq(text, 'not-found', 'body')
    })
  })

  await check('Range 请求头透传 → 206 + content-range + 部分 body', async () => {
    await withProxyEnv({ HTTPS_PROXY: `http://127.0.0.1:${proxyServer.port}` }, async () => {
      origin.requests.length = 0
      const response = await fetchProxy(originUrl('/range'), { headers: { Range: 'bytes=10-19' } })
      eq(response.status, 206, 'status')
      eq(response.headers.get('content-range'), `bytes 10-19/${RANGE_BODY.length}`, 'content-range')
      const body = Buffer.from(await response.arrayBuffer())
      assert(body.equals(RANGE_BODY.subarray(10, 20)), 'body 应为第 10-19 字节')
      const seen = origin.requests.find((item) => item.path === '/range')
      assert(seen, 'origin 应收到请求')
      eq(seen.headers.range, 'bytes=10-19', 'origin 收到的 Range')
      return 'Range 已透传'
    })
  })

  await check('302 跟随：先 /redirect 再 /ok，最终 200', async () => {
    await withProxyEnv({ HTTPS_PROXY: `http://127.0.0.1:${proxyServer.port}` }, async () => {
      origin.requests.length = 0
      const response = await fetchProxy(originUrl('/redirect'))
      eq(response.status, 200, '最终 status')
      const text = await response.text()
      eq(text, SMALL_BODY.toString(), '最终 body')
      const paths = origin.requests.map((item) => item.path)
      assert(paths.includes('/redirect') && paths.includes('/ok'), `应跟随 302（实际 ${JSON.stringify(paths)}）`)
      return '跟随 1 跳'
    })
  })

  await check('abort：signal 中止后请求 reject（错误可判别为中止）', async () => {
    await withProxyEnv({ HTTPS_PROXY: `http://127.0.0.1:${proxyServer.port}` }, async () => {
      const controller = new AbortController()
      const pending = fetchProxy(originUrl('/slow'), { signal: controller.signal })
      setTimeout(() => controller.abort(), 120)
      const error = await captureRejection(() => pending, 'abort')
      const signature = `${error.name} ${error.code ?? ''} ${error.message}`
      assert(/abort|中止/i.test(signature), `错误应可判别为中止（实际 ${signature}）`)
      return signature.slice(0, 60)
    })
  })

  await check('代理不可达：错误含主机与错误码（可诊断）', async () => {
    const port = await closedPort()
    await withProxyEnv({ HTTPS_PROXY: `http://127.0.0.1:${port}` }, async () => {
      const error = await captureRejection(() => fetchProxy(originUrl('/ok')), '代理不可达')
      const message = String(error.message ?? '')
      const combined = `${message} ${error.code ?? ''} ${error.cause?.code ?? ''}`
      assert(/127\.0\.0\.1|origin\.test/.test(combined), `错误应含主机名（实际 ${combined.slice(0, 120)}）`)
      assert(
        Boolean(error.code) || /(ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR)/i.test(combined),
        `错误应含错误码（实际 ${combined.slice(0, 120)}）`,
      )
      return combined.trim().slice(0, 80)
    })
  })

  await check('本机 127.0.0.1 默认直连：不经过代理', async () => {
    await withProxyEnv({ HTTPS_PROXY: `http://127.0.0.1:${proxyServer.port}` }, async () => {
      const before = proxyServer.requests.length
      const response = await fetchProxy(`http://127.0.0.1:${origin.port}/ok`)
      eq(response.status, 200, 'status')
      eq(await response.text(), SMALL_BODY.toString(), 'body')
      eq(proxyServer.requests.length, before, '不应经过代理')
      return '直连'
    })
  })

  await check('CONNECT 502：https 目标经代理失败时可诊断', async () => {
    await withProxyEnv({ HTTPS_PROXY: `http://127.0.0.1:${proxyServer.port}` }, async () => {
      const error = await captureRejection(() => fetchProxy('https://origin.test/ok'), 'CONNECT 502')
      const combined = `${error.message} ${error.code ?? ''}`
      assert(/502|CONNECT|代理|proxy/i.test(combined), `错误应可诊断（实际 ${combined.slice(0, 120)}）`)
      return combined.trim().slice(0, 70)
    })
  })
}

/* ------------------------------------------------------------------ */
/* 4. downloadFile（本地 origin / fake fetchImpl）                      */
/* ------------------------------------------------------------------ */

function makeResponse(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.length), ...extraHeaders },
  })
}

/** 可编程 fake fetch：handler(index, url, init) 决定第 n 次请求的结果。 */
function scriptedFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    const index = calls.length
    calls.push({ url: String(url), init })
    return handler(index, url, init)
  }
  impl.calls = calls
  return impl
}

function networkError(code) {
  const error = new TypeError('fetch failed')
  error.code = code
  error.cause = Object.assign(new Error(code === 'ECONNRESET' ? 'socket hang up' : 'connect timeout'), { code })
  return error
}

async function testDownloadFile(origin, tempDir) {
  const downloadFile = downloaderMod.downloadFile
  const assetUrl = `http://127.0.0.1:${origin.port}/asset`
  const rangeUrl = `http://127.0.0.1:${origin.port}/range`
  const ignoreRangeUrl = `http://127.0.0.1:${origin.port}/ignore-range`
  const mismatchRangeUrl = `http://127.0.0.1:${origin.port}/mismatch-range`
  let counter = 0
  const freshDest = (name) => path.join(tempDir, `${name}-${++counter}`, 'asset.bin')

  await check('缓存命中：文件已存在且 size/sha256 匹配 → cached 且不发起请求', async () => {
    const dest = freshDest('cached')
    mkdirSync(path.dirname(dest), { recursive: true })
    writeFileSync(dest, SMALL_BODY)
    origin.requests.length = 0
    const result = await downloadFile({ url: assetUrl, dest, size: SMALL_BODY.length, sha256: sha256(SMALL_BODY) })
    eq(result.status, 'cached', 'status')
    eq(result.bytes, SMALL_BODY.length, 'bytes')
    eq(origin.requests.length, 0, '不应发起请求')
    return '0 请求'
  })

  await check('sha256 正确：下载落盘、字节数与哈希匹配', async () => {
    const dest = freshDest('sha-ok')
    origin.requests.length = 0
    const result = await downloadFile({
      url: assetUrl,
      dest,
      size: SMALL_BODY.length,
      sha256: sha256(SMALL_BODY).toUpperCase(),
      attempts: 1,
    })
    eq(result.status, 'downloaded', 'status')
    eq(result.bytes, SMALL_BODY.length, 'bytes')
    assert(exists(dest), '目标文件应存在')
    eq(sha256(readFileSync(dest)), sha256(SMALL_BODY), '落盘 sha256')
    eq(origin.requests.length, 1, '请求次数')
    return '1 请求'
  })

  await check('sha256 不符：抛错并删除损坏文件（dest/.part 均不存在）', async () => {
    const dest = freshDest('sha-bad')
    origin.requests.length = 0
    const error = await captureRejection(
      () =>
        downloadFile({
          url: assetUrl,
          dest,
          size: SMALL_BODY.length,
          sha256: sha256(Buffer.from('totally-different-content')),
          attempts: 1,
        }),
      'sha256 不符',
    )
    assert(/sha256|哈希|校验/i.test(error.message), `错误应提到哈希校验（实际 ${error.message}）`)
    assert(!exists(dest), 'dest 应被删除')
    assert(!exists(`${dest}.part`), '.part 应被删除')
    return error.message.slice(0, 60)
  })

  await check('断点续传：预置 .part 前 N 字节 → 只请求剩余字节且最终 hash 正确（本次修复点）', async () => {
    const dest = freshDest('resume')
    mkdirSync(path.dirname(dest), { recursive: true })
    writeFileSync(`${dest}.part`, RANGE_BODY.subarray(0, RESUME_AT))
    origin.requests.length = 0
    const result = await downloadFile({
      url: rangeUrl,
      dest,
      size: RANGE_BODY.length,
      sha256: sha256(RANGE_BODY),
      attempts: 1,
    })
    eq(result.status, 'downloaded', 'status')
    eq(result.bytes, RANGE_BODY.length, 'bytes')
    const rangeRequests = origin.requests.filter((item) => item.path === '/range')
    eq(rangeRequests.length, 1, '续传请求次数')
    eq(rangeRequests[0].headers.range, `bytes=${RESUME_AT}-`, '请求 Range 起点')
    eq(rangeRequests[0].bytesSent, RANGE_BODY.length - RESUME_AT, '应只返回剩余字节')
    assert(exists(dest), '目标文件应存在')
    const actual = readFileSync(dest)
    assert(actual.equals(RANGE_BODY), '落盘内容应与完整文件一致')
    eq(sha256(actual), sha256(RANGE_BODY), '落盘 sha256')
    assert(!exists(`${dest}.part`), '.part 应已重命名')
    return `Range bytes=${RESUME_AT}-，仅 ${RANGE_BODY.length - RESUME_AT} 字节`
  })

  await check('服务器忽略 Range（200）：从头重下且 hash 正确', async () => {
    const dest = freshDest('ignore-range')
    mkdirSync(path.dirname(dest), { recursive: true })
    writeFileSync(`${dest}.part`, RANGE_BODY.subarray(0, 500))
    origin.requests.length = 0
    const result = await downloadFile({
      url: ignoreRangeUrl,
      dest,
      size: RANGE_BODY.length,
      sha256: sha256(RANGE_BODY),
      attempts: 1,
    })
    eq(result.status, 'downloaded', 'status')
    eq(result.bytes, RANGE_BODY.length, 'bytes')
    const requests = origin.requests.filter((item) => item.path === '/ignore-range')
    eq(requests.length, 1, '请求次数')
    eq(requests[0].headers.range, 'bytes=500-', '应发送 Range 试探')
    eq(requests[0].bytesSent, RANGE_BODY.length, '服务器返回了完整 body')
    eq(sha256(readFileSync(dest)), sha256(RANGE_BODY), '落盘 sha256')
    return '已从头重下'
  })

  await check('206 的 content-range.start 与 .part 偏移不符：丢弃分片、重试后从头下载成功', async () => {
    const dest = freshDest('mismatch-range')
    mkdirSync(path.dirname(dest), { recursive: true })
    writeFileSync(`${dest}.part`, RANGE_BODY.subarray(0, RESUME_AT))
    origin.requests.length = 0
    const result = await downloadFile({
      url: mismatchRangeUrl,
      dest,
      size: RANGE_BODY.length,
      sha256: sha256(RANGE_BODY),
      attempts: 3,
    })
    eq(result.status, 'downloaded', 'status')
    eq(result.bytes, RANGE_BODY.length, 'bytes')
    const requests = origin.requests.filter((item) => item.path === '/mismatch-range')
    assert(requests.length >= 2, `应发生重新请求（实际 ${requests.length} 次）`)
    eq(requests[0].headers.range, `bytes=${RESUME_AT}-`, '第一次应带续传 Range')
    const last = requests.at(-1)
    assert(
      last.bytesSent === RANGE_BODY.length,
      `最终应从头下载完整文件（最后一次仅收到 ${last.bytesSent}/${RANGE_BODY.length} 字节，Range=${last.headers.range}）`,
    )
    assert(exists(dest), '目标文件应存在')
    const actual = readFileSync(dest)
    assert(actual.equals(RANGE_BODY), '落盘内容应为完整文件（不能是半截坏文件）')
    eq(sha256(actual), sha256(RANGE_BODY), '落盘 sha256')
    assert(!exists(`${dest}.part`), '.part 应已清理')
    return `${requests.length} 次请求后从头下载成功`
  })

  await check('默认 attempts=3：前两次 HTTP 500、第三次成功', async () => {
    const dest = freshDest('retry-http')
    const fake = scriptedFetch((index) => {
      if (index < 2) return makeResponse(Buffer.from('boom'), 500)
      return makeResponse(SMALL_BODY)
    })
    const result = await downloadFile({
      url: 'http://fake.test/asset.bin',
      dest,
      size: SMALL_BODY.length,
      sha256: sha256(SMALL_BODY),
      fetchImpl: fake,
    })
    eq(result.status, 'downloaded', 'status')
    eq(fake.calls.length, 3, '请求次数（默认重试 3 次）')
    eq(sha256(readFileSync(dest)), sha256(SMALL_BODY), '落盘 sha256')
    return '3 次请求后成功'
  })

  await check('网络错误重试：前两次 ECONNRESET、第三次成功（fake fetchImpl）', async () => {
    const dest = freshDest('retry-net')
    const fake = scriptedFetch((index) => {
      if (index < 2) throw networkError('ECONNRESET')
      return makeResponse(SMALL_BODY)
    })
    const result = await downloadFile({
      url: 'http://fake.test/asset.bin',
      dest,
      size: SMALL_BODY.length,
      sha256: sha256(SMALL_BODY),
      attempts: 3,
      fetchImpl: fake,
    })
    eq(result.status, 'downloaded', 'status')
    eq(fake.calls.length, 3, '请求次数')
    eq(sha256(readFileSync(dest)), sha256(SMALL_BODY), '落盘 sha256')
    return '3 次请求后成功'
  })

  await check('网络错误文案：含主机名与「代理」提示（fake fetchImpl 持续失败）', async () => {
    const dest = freshDest('net-error')
    const fake = scriptedFetch(() => {
      throw networkError('ETIMEDOUT')
    })
    const error = await captureRejection(
      () =>
        downloadFile({
          url: 'http://github.test/asset.bin',
          dest,
          attempts: 1,
          fetchImpl: fake,
        }),
      '网络错误',
    )
    const message = String(error.message)
    assert(message !== 'fetch failed', `错误不应只是 "fetch failed"（实际 ${message}）`)
    assert(/github\.test/.test(message), `错误文案应含主机名 github.test（实际 ${message}）`)
    assert(/代理/.test(message), `错误文案应含「代理」提示（实际 ${message}）`)
    assert(/ETIMEDOUT/.test(message), `错误文案应含错误码 ETIMEDOUT（实际 ${message}）`)
    assert(!exists(`${dest}.part`), '失败后 .part 应被清理')
    return message.slice(0, 80)
  })

  await check('默认 fetchImpl 走代理：代理不可达时提示代理地址（非 "fetch failed"）', async () => {
    const port = await closedPort()
    const dest = freshDest('default-proxy')
    await withProxyEnv({ HTTPS_PROXY: `http://127.0.0.1:${port}` }, async () => {
      const error = await captureRejection(
        () => downloadFile({ url: 'http://origin.test/asset.bin', dest, attempts: 1 }),
        '默认 fetchImpl',
      )
      const message = String(error.message)
      assert(/代理/.test(message), `错误文案应提示代理（实际 ${message}）`)
      assert(
        message.includes(String(port)) || /127\.0\.0\.1/.test(message) || /origin\.test/.test(message),
        `错误文案应含代理地址或主机名（实际 ${message}）`,
      )
      return message.slice(0, 80)
    })
  })
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  console.log(`${C.bold}代理感知下载层验收${C.reset}${C.dim}（node --import tsx scripts/verify-provision.mjs）${C.reset}\n`)
  const cleanups = []
  const runCleanup = async () => {
    for (const fn of cleanups.reverse()) {
      try {
        await fn()
      } catch {
        /* 忽略清理错误 */
      }
    }
    cleanups.length = 0
  }

  try {
    await importProduct()
    // 基线：清掉宿主 shell 里的真实代理变量，保证本地确定性；结束后恢复。
    applyEnv({})
    cleanups.push(restoreOriginalEnv)

    const tempDir = mkdtempSync(path.join(tmpdir(), 'aiab-verify-provision-'))
    cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }))

    const origin = await startOrigin()
    cleanups.push(() => origin.close())
    const proxyServer = await startProxy(origin.port)
    cleanups.push(() => proxyServer.close())

    console.log(`${C.dim}origin 127.0.0.1:${origin.port} · proxy 127.0.0.1:${proxyServer.port} · tmp ${tempDir}${C.reset}\n`)

    console.log(`${C.bold}1) parseProxyFromEnv${C.reset}`)
    await testParseProxyFromEnv()
    console.log(`\n${C.bold}2) detectProxyForUrl / proxyEnvSnapshot${C.reset}`)
    await testDetectAndSnapshot()
    console.log(`\n${C.bold}3) proxyAwareFetch（本地代理）${C.reset}`)
    await testProxyAwareFetch(origin, proxyServer)
    console.log(`\n${C.bold}4) downloadFile（缓存 / 续传 / 重试 / 错误文案）${C.reset}`)
    await testDownloadFile(origin, tempDir)

    const total = passed + failed
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log('')
    if (failed === 0) {
      console.log(`${C.green}${C.bold}✓ 全部通过${C.reset}  ${passed}/${total} 项  ${C.dim}${seconds}s${C.reset}\n`)
      process.exitCode = 0
    } else {
      console.log(`${C.red}${C.bold}✗ ${failed} 项失败${C.reset}  ${passed}/${total} 通过  ${C.dim}${seconds}s${C.reset}`)
      for (const failure of failures) console.log(`  ${C.red}•${C.reset} ${failure}`)
      console.log('')
      process.exitCode = 1
    }
  } finally {
    await runCleanup()
  }
}

main()
  .then(() => {
    // 本地 server / 定时器 / keep-alive socket 都已在 finally 里清理；显式退出避免残留进程。
    process.exit(process.exitCode ?? 0)
  })
  .catch(async (error) => {
    console.error(`\n${C.red}验收脚本异常中断${C.reset}：${error instanceof Error ? error.message : String(error)}`)
    if (error instanceof Error && error.stack) console.error(`${C.dim}${error.stack}${C.reset}`)
    process.exit(1)
  })
