/**
 * P10 验收：下载加速内核（多源回退 / 分片并发 / 跨运行续传 / 测速 / 镜像 URL / 自动排序 / 安装器接线）。
 *
 * 全程离线、不访问外网：node:http 本地 Range 服务 + 本地端口 + 进程内 TS 加载器。
 * 运行：node scripts/verify-downloads.mjs
 *
 * 覆盖：
 * 1. 多源回退（源 A 500 → 源 B 成功；全部失败 → 中文可重试错误）；
 * 2. .part 前缀哈希续传（带 sha256 时不丢弃已有字节）；
 * 3. 服务端忽略 Range（200）时单连接从 0 重写；
 * 4. 分片并发正确拼接 + 整文件 sha256 + speedBps/segments/source 进度 + 状态清理；
 * 5. 分片跨运行续传（首轮中断保留状态 → 第二轮续传成功）；
 * 6. 分片路径遇到不支持 Range 的源 → 自动清理并回退单连接；
 * 7. Range 响应的 Content-Range 不匹配时必须拒绝（不能拼出坏文件）；
 * 8. 镜像 URL 生成（hf-mirror / ghfast / 自建运行时镜像 / 关闭镜像 / 服务器镜像候选顺序）；
 * 9. rankSources auto 按本地延迟排序（两端口不同延迟），非 auto 保持原序；
 * 10. installModels 注入自定义 MODEL 计划 + 本地 HTTP 源（分片）能装好，二次缓存命中；
 * 11. installModels 本机离线包（engine-package.json）优先、无网络也能装；
 * 12. installRuntime 经运行时镜像源 + 分片安装、二次缓存命中。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

/* ------------------------------------------------------------------ */
/* 进程内 TS 加载器：把 apps/server/src 的 .ts 转译成 ESM，并解析 .js→.ts */
/* ------------------------------------------------------------------ */

process.on('warning', (warning) => {
  if (warning?.name === 'ExperimentalWarning') return
  console.warn(warning?.stack ?? String(warning))
})

function installTsLoader() {
  const require = createRequire(import.meta.url)
  const ts = require('typescript')
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
        const base = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : process.cwd()
        const candidate = path.resolve(base, `${specifier.slice(0, -3)}.ts`)
        if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url.endsWith('.ts')) {
        const file = fileURLToPath(url)
        const source = readFileSync(file, 'utf8')
        const output = ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          fileName: file,
        }).outputText
        return { format: 'module', source: output, shortCircuit: true }
      }
      return nextLoad(url, context)
    },
  })
}

installTsLoader()

const { downloadFile, SEGMENTED_MIN_BYTES } = await import('../apps/server/src/provision/downloader.ts')
const sources = await import('../apps/server/src/provision/sources.ts')
const manifest = await import('../apps/server/src/provision/manifest.ts')
const installer = await import('../apps/server/src/provision/installer.ts')
const training = await import('../apps/server/src/provision/training.ts')

let passed = 0
let failed = 0
let skipped = 0
const check = async (name, fn) => {
  try {
    const detail = await fn()
    passed++
    console.log(`  ✓ ${name}${detail ? `  (${detail})` : ''}`)
  } catch (e) {
    failed++
    console.log(`  ✗ ${name}  ${e.message}`)
  }
}
const skip = (name, reason) => {
  skipped++
  console.log(`  ⊘ ${name}  (跳过：${reason})`)
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
const assertEqual = (actual, expected, label) => {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(`${label}：期望 ${right}，实际 ${left}`)
}
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

const TMP = mkdtempSync(path.join(tmpdir(), 'aiab-download-test-'))
const KB = 1024
const MB = 1024 * 1024

/** 生成可复现的测试负载（不用随机数，便于比对） */
function makePayload(size) {
  const buffer = Buffer.alloc(size)
  let value = 7
  for (let i = 0; i < size; i++) {
    value = (value * 1103515245 + 12345) >>> 0
    buffer[i] = value >>> 24
  }
  return buffer
}

/* ------------------------------------------------------------------ */
/* 本地 HTTP 服务（Range / 可切换故障模式 / 路径路由）                    */
/* ------------------------------------------------------------------ */

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

/**
 * 本地文件服务：支持按路径返回负载、Range（206/Content-Range）、HEAD 语义、
 * 以及测试用故障模式：noRange（忽略 Range 回 200）、truncate（响应一半就断连接）、
 * badRange（Content-Range 故意错）、delayMs（延迟响应，用于测速排序）。
 */
async function startPayloadServer(payloadOrRoutes, options = {}) {
  const routes = payloadOrRoutes instanceof Map ? payloadOrRoutes : new Map([['*', payloadOrRoutes]])
  const state = { mode: options.mode ?? 'normal', requests: 0, rangeRequests: 0, requestsByPath: new Map() }
  const server = createServer((req, res) => {
    state.requests++
    const pathname = (() => {
      try {
        return new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      } catch {
        return '/'
      }
    })()
    state.requestsByPath.set(pathname, (state.requestsByPath.get(pathname) ?? 0) + 1)
    const respond = () => {
      const payload = routes.get(pathname) ?? routes.get('*')
      if (!payload) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('not found')
        return
      }
      const range = req.headers.range
      if (state.mode === 'noRange' || !range) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length })
        res.end(payload)
        return
      }
      state.rangeRequests++
      const match = /bytes=(\d+)-(\d*)/.exec(range)
      const start = match ? Math.max(0, Math.min(Number(match[1]), payload.length - 1)) : 0
      const endMax = match && match[2] ? Number(match[2]) : payload.length - 1
      const end = Math.max(start, Math.min(endMax, payload.length - 1))
      const length = end - start + 1
      if (state.mode === 'badResumeRange') {
        // 错误服务端：忽略请求起点，从 0 返回完整内容
        res.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': payload.length,
          'Content-Range': `bytes 0-${payload.length - 1}/${payload.length}`,
        })
        res.end(payload)
        return
      }
      if (state.mode === 'badResumeTotal') {
        // 错误服务端：起点正确但总大小报错
        res.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': payload.length - start,
          'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length + 1}`,
        })
        res.end(payload.subarray(start))
        return
      }
      let contentRange = `bytes ${start}-${end}/${payload.length}`
      if (state.mode === 'badRange') contentRange = `bytes ${Math.max(0, start - 1)}-${end}/${payload.length + 1}`
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': length,
        'Content-Range': contentRange,
        'Accept-Ranges': 'bytes',
      })
      if (state.mode === 'truncate') {
        // 只写 1/3 就掐断连接：模拟网络中断（用于验证跨运行续传）
        res.write(payload.subarray(start, start + Math.max(1, Math.floor(length / 3))))
        setImmediate(() => res.socket?.destroy())
        return
      }
      res.end(payload.subarray(start, end + 1))
    }
    if (options.delayMs) setTimeout(respond, options.delayMs)
    else respond()
  })
  const port = await listen(server)
  return {
    server,
    port,
    state,
    url: (pathname = '/f') => `http://127.0.0.1:${port}${pathname}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** 固定返回某个 HTTP 状态码的服务（多源回退测试里当「坏源」） */
async function startStatusServer(status) {
  const server = createServer((req, res) => {
    res.writeHead(status, { 'Content-Type': 'text/plain' })
    res.end(`status ${status}`)
  })
  const port = await listen(server)
  return {
    port,
    url: `http://127.0.0.1:${port}/x`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function withServers(servers, fn) {
  try {
    return await fn()
  } finally {
    for (const server of servers) {
      try {
        await server.close()
      } catch {
        /* ignore */
      }
    }
  }
}

/** 某个 dest 是否还有分片残留（.part / .part.<i> / .parts.json） */
function segmentedLeftovers(dest) {
  const directory = path.dirname(dest)
  if (!existsSync(directory)) return []
  const prefix = `${path.basename(dest)}.part`
  return readdirSync(directory).filter((name) => name === `${prefix}.parts.json` || name.startsWith(prefix))
}

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

console.log('\nP10 下载加速（多源 / 分片 / 续传 / 测速 / 离线包）验收\n')

const PROVISION_SETTINGS = {
  sourceStrategy: 'auto',
  hfMirror: '',
  githubMirror: '',
  runtimeMirror: '',
  concurrency: 4,
  serverAssist: true,
  serverAssistUrl: '',
  serverAssistToken: '',
  useLocalPackage: true,
  packageDir: '',
}

/* 1. 多源回退 ------------------------------------------------------- */
await check('多源回退：源 A 500 → 源 B 成功；全部失败给中文可重试错误', async () => {
  const payload = makePayload(300 * KB)
  const good = await startPayloadServer(payload)
  const bad = await startStatusServer(500)
  try {
    const dest = path.join(TMP, 'multi-source.bin')
    const logs = []
    const result = await downloadFile({
      sources: [
        { label: '源A', url: bad.url, kind: 'official' },
        { label: '源B', url: good.url('/b'), kind: 'official' },
      ],
      dest,
      sha256: sha256(payload),
      size: payload.length,
      log: (message) => logs.push(message),
    })
    assertEqual(result.status, 'downloaded', 'result.status')
    assert(readFileSync(dest).equals(payload), '内容不一致')
    assert(logs.some((message) => /源「源A」失败/.test(message)), `应记录源 A 失败日志：${logs.join(' | ')}`)

    const failDest = path.join(TMP, 'multi-source-fail.bin')
    let thrown = null
    try {
      await downloadFile({ sources: [{ label: '坏源', url: bad.url, kind: 'official' }], dest: failDest, size: 16 })
    } catch (error) {
      thrown = error
    }
    assert(thrown && /所有下载源均失败/.test(String(thrown.message)), '全部失败应报「所有下载源均失败」')
    assert(!existsSync(failDest), '失败不应留下目标文件')
    return 'A 500 → B 成功；全失败可重试'
  } finally {
    await good.close()
    await bad.close()
  }
})

/* 2. .part 前缀哈希续传 --------------------------------------------- */
await check('.part 前缀哈希续传：带 sha256 时不丢弃已有字节', async () => {
  const payload = makePayload(200 * KB)
  const server = await startPayloadServer(payload)
  try {
    const dest = path.join(TMP, 'resume-hash.bin')
    const partPath = `${dest}.part`
    writeFileSync(partPath, payload.subarray(0, 64 * KB))
    const logs = []
    const progress = []
    const result = await downloadFile({
      url: server.url(),
      dest,
      sha256: sha256(payload),
      size: payload.length,
      log: (message) => logs.push(message),
      onProgress: (item) => progress.push(item),
    })
    assertEqual(result.status, 'downloaded', 'result.status')
    assert(readFileSync(dest).equals(payload), '续传后内容不一致')
    assert(logs.some((message) => /前缀哈希/.test(message)), `应记录前缀哈希：${logs.join(' | ')}`)
    assertEqual(progress.at(-1)?.received, payload.length, '最终进度 received')
    return '64KB 前缀 → 200KB'
  } finally {
    await server.close()
  }
})

/* 3. 服务端不支持 Range：从 0 重写 -------------------------------- */
await check('单连接：服务端忽略 Range（200）时从 0 重写，旧 .part 不污染结果', async () => {
  const payload = makePayload(200 * KB)
  const server = await startPayloadServer(payload, { mode: 'noRange' })
  try {
    const dest = path.join(TMP, 'no-range-single.bin')
    writeFileSync(`${dest}.part`, makePayload(64 * KB)) // 内容与真实前缀不同
    const logs = []
    const result = await downloadFile({
      url: server.url(),
      dest,
      sha256: sha256(payload),
      size: payload.length,
      log: (message) => logs.push(message),
    })
    assertEqual(result.status, 'downloaded', 'result.status')
    assert(readFileSync(dest).equals(payload), '应从头重写为正确内容')
    assert(logs.some((message) => /不支持 Range/.test(message)), '应提示不支持 Range')
    return '200 → 从头重写'
  } finally {
    await server.close()
  }
})

/* 3b. 单连接续传响应校验（Content-Range 不符必须丢弃 .part） -------- */
await check('单连接续传：206 Content-Range 起点/总大小不符时丢弃 .part 从头重下（无 sha256 也不落坏文件）', async () => {
  const payload = makePayload(200 * KB)
  const server = await startPayloadServer(payload, { mode: 'badResumeRange' })
  try {
    // 场景 A：服务端 206 但从 0 开始（请求的是 bytes=65536-），且调用方不传 sha256/size
    const dest = path.join(TMP, 'bad-resume-range.bin')
    writeFileSync(`${dest}.part`, makePayload(64 * KB))
    const logs = []
    const result = await downloadFile({ url: server.url(), dest, log: (message) => logs.push(message) })
    assertEqual(result.status, 'downloaded', '起点不符 result.status')
    assert(readFileSync(dest).equals(payload), '起点不符时应从 0 重下为正确内容（不能 append 出坏文件）')
    assert(logs.some((message) => /续传响应不符/.test(message)), `应记录续传响应不符：${logs.join(' | ')}`)

    // 场景 B：206 起点正确但总大小错误（传了 size）
    server.state.mode = 'badResumeTotal'
    const dest2 = path.join(TMP, 'bad-resume-total.bin')
    writeFileSync(`${dest2}.part`, payload.subarray(0, 64 * KB))
    const logs2 = []
    const result2 = await downloadFile({
      url: server.url(),
      dest: dest2,
      size: payload.length,
      log: (message) => logs2.push(message),
    })
    assertEqual(result2.status, 'downloaded', '总大小不符 result.status')
    assert(readFileSync(dest2).equals(payload), '总大小不符时应从 0 重下为正确内容')
    assert(logs2.some((message) => /续传响应不符/.test(message)), `应记录续传响应不符：${logs2.join(' | ')}`)
    return '起点不符 / 总大小不符 → 均从头重下'
  } finally {
    await server.close()
  }
})

/* 4. 分片并发：拼接 + sha256 + 进度 + 清理 ------------------------- */
await check('分片并发：4 段 Range 正确拼接、sha256 通过、进度带速度/段数、状态清理', async () => {
  const payload = makePayload(9 * MB)
  const server = await startPayloadServer(payload)
  try {
    const dest = path.join(TMP, 'segmented.bin')
    const logs = []
    const progress = []
    const result = await downloadFile({
      url: server.url(),
      dest,
      sha256: sha256(payload),
      size: payload.length,
      concurrency: 4,
      log: (message) => logs.push(message),
      onProgress: (item) => progress.push(item),
    })
    assertEqual(result.status, 'downloaded', 'result.status')
    assert(readFileSync(dest).equals(payload), '分片拼接内容不一致')
    assert(progress.length > 0, '应有进度回调')
    assert(
      progress.every((item) => typeof item.speedBps === 'number' && Number.isFinite(item.speedBps)),
      '每次进度都应带 speedBps',
    )
    const final = progress.at(-1)
    assertEqual(final.received, payload.length, '最终 received')
    assertEqual(final.segments, 4, '最终 segments')
    assert(final.source && final.source.length > 0, '进度应带 source')
    assert(logs.some((message) => /MB\/s/.test(message)), `日志应含速度：${logs.join(' | ')}`)
    assert(server.state.rangeRequests >= 4, `应发出多个 Range 请求（实际 ${server.state.rangeRequests}）`)
    assertEqual(segmentedLeftovers(dest), [], '成功后不应有分片残留')
    return `${progress.length} 次进度 / ${server.state.rangeRequests} 个 Range 请求`
  } finally {
    await server.close()
  }
})

/* 5. 分片跨运行续传 ------------------------------------------------- */
await check('分片跨运行续传：首轮断流保留状态，第二轮续传后 sha256 正确', async () => {
  const payload = makePayload(9 * MB)
  const server = await startPayloadServer(payload, { mode: 'truncate' })
  try {
    const dest = path.join(TMP, 'segmented-resume.bin')
    let thrown = null
    try {
      await downloadFile({ url: server.url(), dest, sha256: sha256(payload), size: payload.length, concurrency: 2 })
    } catch (error) {
      thrown = error
    }
    assert(thrown, '首轮应在断流后失败')
    assert(existsSync(`${dest}.parts.json`), '失败后应保留分片状态文件以便续传')
    assert(!existsSync(dest), '失败后不应有目标文件')
    assert(
      segmentedLeftovers(dest).some((name) => name.endsWith('.parts.json') || /\.part\.\d+$/.test(name)),
      '失败后应保留分片状态/分片文件',
    )

    server.state.mode = 'normal'
    const logs = []
    const result = await downloadFile({
      url: server.url(),
      dest,
      sha256: sha256(payload),
      size: payload.length,
      concurrency: 2,
      log: (message) => logs.push(message),
    })
    assertEqual(result.status, 'downloaded', '第二轮 result.status')
    assert(readFileSync(dest).equals(payload), '续传后整文件 sha256 内容不一致')
    assert(logs.some((message) => /分片续传/.test(message)), `应走「分片续传」路径：${logs.join(' | ')}`)
    assertEqual(segmentedLeftovers(dest), [], '成功后不应有分片残留')
    return '断流 → 状态保留 → 续传成功'
  } finally {
    await server.close()
  }
})

/* 6. 分片 → 不支持 Range → 回退单连接 ------------------------------ */
await check('分片回退：源全都不支持 Range（200）时清理分片并自动回退单连接', async () => {
  const payload = makePayload(9 * MB)
  const server = await startPayloadServer(payload, { mode: 'noRange' })
  try {
    const dest = path.join(TMP, 'segment-fallback.bin')
    const logs = []
    const result = await downloadFile({
      url: server.url(),
      dest,
      sha256: sha256(payload),
      size: payload.length,
      concurrency: 4,
      log: (message) => logs.push(message),
    })
    assertEqual(result.status, 'downloaded', 'result.status')
    assert(readFileSync(dest).equals(payload), '回退单连接后内容不一致')
    assert(logs.some((message) => /回退单连接/.test(message)), `应提示回退单连接：${logs.join(' | ')}`)
    assertEqual(segmentedLeftovers(dest), [], '回退后应清理分片状态')
    return '200 → 清理分片 → 单连接成功'
  } finally {
    await server.close()
  }
})

/* 7. Content-Range 不匹配必须拒绝 ---------------------------------- */
await check('Range 校验：Content-Range 起点/总大小错误时必须拒绝，不能拼出坏文件', async () => {
  const payload = makePayload(Math.round(8.5 * MB))
  const server = await startPayloadServer(payload, { mode: 'badRange' })
  try {
    const dest = path.join(TMP, 'bad-range.bin')
    let thrown = null
    try {
      await downloadFile({ url: server.url(), dest, sha256: sha256(payload), size: payload.length, concurrency: 2 })
    } catch (error) {
      thrown = error
    }
    assert(thrown, '错误 Content-Range 应导致下载失败')
    assert(/Content-Range/.test(String(thrown.message)), `错误信息应包含 Content-Range：${thrown.message}`)
    assert(!existsSync(dest), '绝不能留下坏的目标文件')
    return '拒绝错误 Content-Range'
  } finally {
    await server.close()
  }
})

/* 8. 镜像 URL / 候选源顺序 ----------------------------------------- */
await check('镜像 URL：hf-mirror / ghfast / 自建运行时镜像 / off 关闭 / 服务器镜像候选顺序', async () => {
  const config = sources.resolveDownloadConfig({ provision: PROVISION_SETTINGS }, {})
  assertEqual(config.strategy, 'auto', 'strategy')
  assertEqual(config.hfMirror, 'https://hf-mirror.com', '默认 HF 镜像')
  assertEqual(config.githubMirror, 'https://ghfast.top/', '默认 GitHub 加速')
  assertEqual(config.concurrency, 4, '默认并发')

  const hfOfficial = 'https://huggingface.co/Serveurperso/ACE-Step-1.5-GGUF/resolve/main/vae-BF16.gguf'
  assertEqual(
    sources.hfMirrorUrl(hfOfficial, config),
    'https://hf-mirror.com/Serveurperso/ACE-Step-1.5-GGUF/resolve/main/vae-BF16.gguf',
    'HF 镜像 URL',
  )
  const githubOfficial = 'https://github.com/Einsphoton/AIArrangementBuddy/releases/download/adapters-v1/adapter-jrpg_v1.tar.gz'
  assertEqual(sources.githubMirrorUrl(githubOfficial, config), `https://ghfast.top/${githubOfficial}`, 'GitHub 加速 URL')

  const runtimeConfig = { ...config, runtimeMirror: 'http://mirror.local/runtime' }
  assertEqual(
    sources.runtimeMirrorUrl(`${'https://www.serveurperso.com/temp/acestep.cpp-win64/build/Release/'}ace-server.exe`, runtimeConfig),
    'http://mirror.local/runtime/ace-server.exe',
    '运行时镜像 URL',
  )

  const offConfig = sources.resolveDownloadConfig(
    { provision: { ...PROVISION_SETTINGS, hfMirror: 'off', githubMirror: 'off' } },
    {},
  )
  assertEqual(offConfig.hfMirror, '', 'off 关闭 HF 镜像')
  assertEqual(offConfig.githubMirror, '', 'off 关闭 GitHub 加速')

  const directSources = sources.sourcesForArtifact({
    kind: 'model',
    officialUrl: hfOfficial,
    name: 'vae-BF16.gguf',
    config: { ...config, strategy: 'direct' },
  })
  assertEqual(
    directSources.map((item) => item.kind),
    ['official'],
    'direct 策略只保留官方源（不生成镜像候选）',
  )

  const artifact = sources.sourcesForArtifact({
    kind: 'model',
    officialUrl: hfOfficial,
    name: 'vae-BF16.gguf',
    config: { ...config, serverAssist: true, serverAssistUrl: 'http://nas:8787', serverAssistToken: 't0k' },
    serverIndex: { url: 'fake', keys: new Set(['model/vae-BF16.gguf']), files: new Map() },
  })
  assertEqual(
    artifact.map((item) => item.kind),
    ['server', 'mirror', 'official'],
    '候选源顺序：服务器镜像 → 国内镜像 → 官方',
  )
  assert(artifact[0].url.includes('key=model%2Fvae-BF16.gguf'), `服务器镜像 URL 应带 key：${artifact[0].url}`)
  assert(artifact[0].url.includes('token=t0k'), `服务器镜像 URL 应带 token：${artifact[0].url}`)
  assertEqual(sources.artifactKey('training-code', 'x'), 'training/code', 'training/code key')
  assertEqual(sources.artifactKey('training-python', 'x'), 'training/python', 'training/python key')
  assertEqual(sources.artifactKey('training-dataset', 'jrpg_v1'), 'training/dataset/jrpg_v1', 'dataset key')
  assertEqual(sources.artifactKey('runtime', 'ace-server.exe'), 'runtime/ace-server.exe', 'runtime key')
  return 'hf / github / runtime / off / server 顺序'
})

/* 9. rankSources auto 排序 ----------------------------------------- */
await check('rankSources：auto 按本地延迟排序（两端口不同延迟），非 auto 保持原序且不探测', async () => {
  const probePayload = makePayload(1024)
  const fast = await startPayloadServer(probePayload)
  const slow = await startPayloadServer(probePayload, { delayMs: 150 })
  try {
    sources.clearProbeCache()
    const autoConfig = { ...sources.DIRECT_DOWNLOAD_CONFIG, strategy: 'auto', probeTimeoutMs: 2000 }
    const candidates = [
      { label: '慢源', url: slow.url('/s'), kind: 'official' },
      { label: '快源', url: fast.url('/f'), kind: 'official' },
    ]
    const ranked = await sources.rankSources(candidates, { config: autoConfig })
    assertEqual(ranked.map((item) => item.label), ['快源', '慢源'], 'auto 应按延迟排序')

    sources.clearProbeCache()
    const requestsBefore = fast.state.requests + slow.state.requests
    const directConfig = { ...sources.DIRECT_DOWNLOAD_CONFIG, strategy: 'direct' }
    const directCandidates = [...candidates, { label: '镜像', url: 'http://127.0.0.1:1/m', kind: 'mirror' }]
    const kept = await sources.rankSources(directCandidates, { config: directConfig })
    assertEqual(kept.map((item) => item.label), ['慢源', '快源'], 'direct 应过滤镜像并保持原序')
    assertEqual(fast.state.requests + slow.state.requests, requestsBefore, '非 auto 不应探测')
    return 'fast 优先 / direct 过滤镜像 + 原序'
  } finally {
    await withServers([fast, slow], async () => {})
  }
})

/* 10. installModels：自定义 MODEL 计划 + 本地 HTTP 源 --------------- */
await check('installModels：注入自定义 MODEL 计划 + 本地 HTTP 源（含分片）能装好，二次缓存命中', async () => {
  const dataDir = path.join(TMP, 'install-models')
  const small = makePayload(256 * KB)
  const big = makePayload(9 * MB)
  const server = await startPayloadServer(
    new Map([
      ['/custom-a.gguf', small],
      ['/sub/custom-b.gguf', big],
    ]),
  )
  try {
    const models = [
      { name: 'custom-a.gguf', path: 'custom-a.gguf', size: small.length, sha256: sha256(small), profiles: ['essential'] },
      { name: 'custom-b.gguf', path: 'sub/custom-b.gguf', size: big.length, sha256: sha256(big), profiles: ['essential'] },
    ]
    const options = {
      dataDir,
      profiles: ['essential'],
      models,
      modelBaseUrl: `http://127.0.0.1:${server.port}`,
      download: { strategy: 'direct', concurrency: 2, serverAssist: false, useLocalPackage: false },
    }
    const logs = []
    const first = await installer.installModels({ ...options, log: (message) => logs.push(message) })
    assertEqual(first.installed, 2, '首次 installed')
    assertEqual(first.cached, 0, '首次 cached')
    const modelDir = path.join(dataDir, manifest.PROVISION_DIR_NAME, 'models')
    assert(readFileSync(path.join(modelDir, 'custom-a.gguf')).equals(small), 'custom-a 内容')
    assert(readFileSync(path.join(modelDir, 'custom-b.gguf')).equals(big), 'custom-b 内容')
    assert(logs.some((message) => /MB\/s/.test(message)), `安装日志应含速度：${logs.join(' | ')}`)

    const requestsAfterFirst = server.state.requests
    const second = await installer.installModels({ ...options })
    assertEqual(second.cached, 2, '二次 cached')
    assertEqual(second.installed, 0, '二次 installed')
    assertEqual(server.state.requests, requestsAfterFirst, '缓存命中不应再发请求')
    return `2 个模型 / ${requestsAfterFirst} 次请求`
  } finally {
    await server.close()
  }
})

/* 11. installModels：本机离线包优先（无网络） ---------------------- */
await check('installModels：本机离线包（engine-package.json）优先，完全无网络也能装', async () => {
  const payload = makePayload(128 * KB)
  // 用清单里钉死的模型名（enginePackage 的 key 解析只认已知工件，防止任意路径）
  const name = 'vae-BF16.gguf'
  const packageDir = path.join(TMP, 'engine-package')
  mkdirSync(path.join(packageDir, 'models'), { recursive: true })
  writeFileSync(path.join(packageDir, 'models', name), payload)
  writeFileSync(
    path.join(packageDir, 'engine-package.json'),
    JSON.stringify({
      schema: 1,
      createdAt: new Date().toISOString(),
      platform: 'win32-x64',
      files: [{ key: `model/${name}`, kind: 'model', file: `models/${name}`, size: payload.length, sha256: sha256(payload) }],
    }),
    'utf8',
  )
  const dataDir = path.join(TMP, 'install-models-offline')
  const logs = []
  const result = await installer.installModels({
    dataDir,
    profiles: ['essential'],
    models: [{ name, path: name, size: payload.length, sha256: sha256(payload), profiles: ['essential'] }],
    // 故意给一个连不上的地址：如果走了网络就会失败
    modelBaseUrl: 'http://127.0.0.1:9',
    download: { strategy: 'direct', useLocalPackage: true, packageDir, serverAssist: false, concurrency: 0 },
    log: (message) => logs.push(message),
  })
  assertEqual(result.installed, 1, '离线包 installed')
  const target = path.join(dataDir, manifest.PROVISION_DIR_NAME, 'models', name)
  assert(readFileSync(target).equals(payload), '离线包拷贝内容')
  assert(logs.some((message) => /本地离线包/.test(message)), `应提示使用本地离线包：${logs.join(' | ')}`)
  return '离线包安装成功'
})

/* 12. installModels：serverAssist 服务器镜像优先 / 关闭后不访问镜像端点 -- */
await check('installModels：serverAssist 服务器镜像优先下载；关闭 serverAssist 后不访问镜像端点', async () => {
  const payload = makePayload(512 * KB)
  const name = 'custom-served.gguf'
  const manifestBuffer = Buffer.from(
    JSON.stringify({ enabled: true, files: [{ key: `model/${name}`, size: payload.length, sha256: sha256(payload) }] }),
  )
  const mirror = await startPayloadServer(
    new Map([
      ['/api/provision/mirror/manifest', manifestBuffer],
      ['/api/provision/mirror/file', payload],
    ]),
  )
  try {
    sources.clearServerMirrorIndexCache()
    const models = [{ name, path: name, size: payload.length, sha256: sha256(payload), profiles: ['essential'] }]
    const dataDir = path.join(TMP, 'install-models-server')
    const result = await installer.installModels({
      dataDir,
      profiles: ['essential'],
      models,
      modelBaseUrl: 'http://127.0.0.1:9', // 官方源故意不可达：只能靠服务器镜像
      download: {
        strategy: 'direct',
        concurrency: 0,
        serverAssist: true,
        serverAssistUrl: `http://127.0.0.1:${mirror.port}`,
        serverAssistToken: 't0k',
        useLocalPackage: false,
      },
    })
    assertEqual(result.installed, 1, 'serverAssist installed')
    assert(readFileSync(path.join(dataDir, manifest.PROVISION_DIR_NAME, 'models', name)).equals(payload), '服务器镜像内容')
    assertEqual(
      mirror.state.requestsByPath.get('/api/provision/mirror/manifest') ?? 0,
      1,
      '应拉取一次服务器镜像清单',
    )
    assert((mirror.state.requestsByPath.get('/api/provision/mirror/file') ?? 0) >= 1, '应从服务器镜像下载文件')

    // 关闭 serverAssist：不得访问镜像端点（即使 serverAssistUrl 已填），回退官方（故意不可达）失败
    sources.clearServerMirrorIndexCache()
    const requestsBefore = mirror.state.requests
    let thrown = null
    try {
      await installer.installModels({
        dataDir: path.join(TMP, 'install-models-server-off'),
        profiles: ['essential'],
        models,
        modelBaseUrl: 'http://127.0.0.1:9',
        download: {
          strategy: 'direct',
          concurrency: 0,
          serverAssist: false,
          serverAssistUrl: `http://127.0.0.1:${mirror.port}`,
          serverAssistToken: 't0k',
          useLocalPackage: false,
        },
      })
    } catch (error) {
      thrown = error
    }
    assert(thrown, '关闭 serverAssist 且官方不可达时应失败')
    assertEqual(mirror.state.requests, requestsBefore, 'serverAssist 关闭后不应访问镜像端点')
    return '服务器镜像优先 / 关闭后不访问'
  } finally {
    await mirror.close()
  }
})

/* 12b. installRuntime：运行时镜像源 + 分片安装 ---------------------- */
await check('installRuntime：运行时镜像源 + 分片逐文件安装，二次缓存命中', async () => {
  const dataDir = path.join(TMP, 'install-runtime-mirror')
  const binaryPayload = makePayload(300 * KB)
  const dllPayload = makePayload(9 * MB)
  const server = await startPayloadServer(
    new Map([
      ['/ace-server.exe', binaryPayload],
      ['/ggml.dll', dllPayload],
    ]),
  )
  try {
    const runtimeFiles = [
      { name: 'ace-server.exe', size: binaryPayload.length, sha256: sha256(binaryPayload) },
      { name: 'ggml.dll', size: dllPayload.length, sha256: sha256(dllPayload) },
    ]
    const hybridPath = path.join(TMP, 'nvcudart_hybrid64.dll')
    writeFileSync(hybridPath, 'fake hybrid dll')
    const options = {
      dataDir,
      platform: 'win32-x64',
      runtimeFiles,
      cudaAssets: [],
      hybridDllPath: hybridPath,
      download: {
        strategy: 'mirror',
        runtimeMirror: `http://127.0.0.1:${server.port}`,
        concurrency: 3,
        serverAssist: false,
        useLocalPackage: false,
      },
    }
    const result = await installer.installRuntime(options)
    assertEqual(result.cached, false, '首次 cached')
    const root = path.join(dataDir, manifest.PROVISION_DIR_NAME)
    assert(readFileSync(path.join(root, 'ace-server.exe')).equals(binaryPayload), 'ace-server.exe 内容')
    assert(readFileSync(path.join(root, 'ggml.dll')).equals(dllPayload), 'ggml.dll 内容')
    const runtimeJson = JSON.parse(readFileSync(path.join(root, 'runtime.json'), 'utf8'))
    assertEqual(runtimeJson.api, 'modern', 'runtime.json api')
    assert(server.state.rangeRequests >= 3, `大的运行时文件应走分片 Range（实际 ${server.state.rangeRequests} 个）`)

    const requestsAfterFirst = server.state.requests
    const second = await installer.installRuntime(options)
    assertEqual(second.cached, true, '二次 cached')
    assertEqual(server.state.requests, requestsAfterFirst, '缓存命中不应再发请求')
    return `镜像安装 / ${server.state.rangeRequests} 个 Range 请求`
  } finally {
    await server.close()
  }
})

/** 假的 fetch：记录请求并统一抛错，用于验证「接线走了谁」而不真的联网 */
function makeFakeFetch(handler) {
  const requests = []
  return {
    requests,
    impl: async (url) => {
      requests.push(String(url))
      return handler(String(url))
    },
  }
}

/* 13. 兼容性：不传 sources/concurrency 的老用法仍走单连接 ---------------- */
await check('兼容性：只传 url（P8 老用法）→ 单连接、缓存命中、无分片状态', async () => {
  const payload = makePayload(SEGMENTED_MIN_BYTES + 1024)
  const server = await startPayloadServer(payload)
  try {
    const dest = path.join(TMP, 'legacy-url.bin')
    const progress = []
    const first = await downloadFile({
      url: server.url(),
      dest,
      sha256: sha256(payload),
      size: payload.length,
      onProgress: (item) => progress.push(item),
    })
    assertEqual(first.status, 'downloaded', '首次 status')
    assertEqual(progress.at(-1)?.segments, 1, '老用法应为单连接（segments=1）')
    assertEqual(server.state.rangeRequests, 0, '老用法不应发 Range 请求')
    assertEqual(segmentedLeftovers(dest), [], '老用法不应产生分片状态')
    const second = await downloadFile({ url: server.url(), dest, sha256: sha256(payload), size: payload.length })
    assertEqual(second.status, 'cached', '二次 status')
    return '单连接 / 缓存命中'
  } finally {
    await server.close()
  }
})

/* 14. training 接线：数据集等下载改走多源（源标签来自 sources.ts） ---------- */
await check('training 接线：setupTraining 的数据集下载走多源候选（GitHub 官方源标签、中文可重试错误）', async () => {
  const dataDir = path.join(TMP, 'training-wiring')
  const codeDir = path.join(TMP, 'training-code-override')
  mkdirSync(path.join(codeDir, 'training'), { recursive: true })
  writeFileSync(path.join(codeDir, 'training', 'runner.py'), '')
  mkdirSync(path.join(codeDir, 'acestep', 'training_v2'), { recursive: true })
  const checkpointsDir = path.join(TMP, 'training-ckpt-override')
  mkdirSync(checkpointsDir, { recursive: true })
  const fake = makeFakeFetch(() => {
    throw new Error('offline-test')
  })
  let thrown = null
  try {
    await training.setupTraining({
      dataDir,
      platform: 'win32-x64',
      overrides: { codeDir, checkpointsDir, pythonPath: path.join(codeDir, 'python.exe') },
      fetchImpl: fake.impl,
      download: { strategy: 'direct', concurrency: 0, serverAssist: false, useLocalPackage: false },
    })
  } catch (error) {
    thrown = error
  }
  assert(thrown, '离线 fake fetch 应导致失败')
  assert(
    fake.requests.some((url) => /dataset-jrpg_v1\.tar\.gz$/.test(url)),
    `数据集下载 URL 应走 GitHub Releases：${fake.requests.join(' | ')}`,
  )
  assert(/所有下载源均失败/.test(String(thrown.message)), `错误应为多源失败：${thrown.message}`)
  assert(/GitHub 官方源/.test(String(thrown.message)), `错误应带源标签：${thrown.message}`)
  return '数据集 → GitHub 官方源候选'
})

skip('真实外网下载（HF / GitHub / hf-mirror）', '本脚本按契约离线运行；真实网络验证由人工或 AIAB_VERIFY_NETWORK 流程执行')

console.log(`\n${failed === 0 ? '✓ 全部通过' : '✗ 存在失败'}  ${passed}/${passed + failed}${skipped ? `（跳过 ${skipped}）` : ''}\n`)
process.exitCode = failed === 0 ? 0 : 1

try {
  rmSync(TMP, { recursive: true, force: true, maxRetries: 3 })
} catch {
  /* ignore */
}