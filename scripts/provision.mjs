#!/usr/bin/env node
/**
 * 本机引擎自动安装 / 下载加速 / 服务器离线包 CLI（P8 / P9 / P10）。
 *
 *   node scripts/provision.mjs status  [--server http://127.0.0.1:8787] [--json]
 *   node scripts/provision.mjs install --profile essential[,quality,stems,xl] [--no-adapters] [--server ...]
 *   node scripts/provision.mjs jobs    [--server ...]
 *   node scripts/provision.mjs sources [--probe] [--json] [--server ...]
 *   node scripts/provision.mjs package --profiles essential[,quality,stems,xl] [--training] [--out <dir>] [--server ...]
 *   node scripts/provision.mjs fetch   --from <server> --dest <dir> [--profile essential[,xl]] [--training] [--token <t>] [--concurrency 4]
 *
 * 说明：
 * - 安装由服务端执行（下载/校验/解压/落盘），CLI 只做触发与进度显示；先启动服务端：node scripts/start.mjs
 * - `sources --probe` 显示各下载源（官方 / 国内镜像 / 运行时镜像 / 服务器镜像）延迟，便于排障；
 * - `package` 让服务器把「已装的运行时 + 模型 + 适配器（可选训练数据）」打成离线包，默认输出到
 *   <DATA_DIR>/engine-package（或设置里的离线包目录 / AIAB_ENGINE_PACKAGE_DIR）；
 *   训练数据体量大（约 2–6GB），只有显式 `--training` 才会打进去；
 * - `fetch` 用纯 fetch 从另一台开启「服务器助攻」的机器拉离线包文件到本机目录（GPU / Companion 机器
 *   从 NAS 服务器拉引擎用），保持布局：runtime 文件放 <dest> 根目录、models/*.gguf 放 <dest>/models/、
 *   cuda|adapter|runtime-archive 归档放 <dest>/.downloads/、训练数据放 <dest>/training/；
 *   支持 .part 断点续传与 sha256 校验。
 *   拉到 modern 运行时文件后，若 <dest>/runtime.json 不存在会自动补写（api=modern + 服务端版本/平台），
 *   因此 `fetch --dest <dataDir>/ace-step` 后该目录可直接作为 Companion 的 AIAB_ACESTEP_DIR 使用；
 *   已有 runtime.json 不覆盖；只拉到 legacy 归档时不会写（需安装器解压归档）。
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import process from 'node:process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const command = args[0] ?? 'status'
const getArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const server = getArg('server', process.env.AIAB_SERVER || 'http://127.0.0.1:8787').replace(/\/$/, '')
const json = args.includes('--json')
const VALID_PROFILES = ['essential', 'quality', 'stems', 'xl']

async function api(pathname, init) {
  const res = await fetch(`${server}${pathname}`, init)
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body }
}

function parseProfilesArg(raw, fallback = []) {
  const list = String(raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (list.length === 0) return fallback
  for (const item of list) {
    if (!VALID_PROFILES.includes(item)) throw new Error(`未知 profile：${item}（可用：${VALID_PROFILES.join(' / ')}）`)
  }
  return list
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)}${units[unit]}`
}

function humanSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—'
  return `${(bytesPerSecond / 1e6).toFixed(1)}MB/s`
}

async function sha256File(target) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(target)) hash.update(chunk)
  return hash.digest('hex')
}

/* ------------------------------------------------------------------ */
/* 打印辅助                                                             */
/* ------------------------------------------------------------------ */

function printStatus(status) {
  console.log(`平台：${status.platform}`)
  if (status.supported === false) {
    console.log(`⚠ 不支持：${status.error ?? ''}`)
    return
  }
  console.log(`安装目录：${status.root}`)
const runtime = status.runtime ?? {}
  const versionLabel = runtime.version ? `（${runtime.version}）` : ''
  console.log(`运行时：${runtime.installed ? `已装${versionLabel}` : `未安装${versionLabel}`}`)
  for (const profile of status.profiles ?? []) {
    console.log(`  [${profile.ready ? '✓' : ' '}] ${profile.id.padEnd(10)} ${profile.label} · 需下载 ${humanBytes(profile.downloadBytes)}`)
  }
  const missing = (status.models ?? []).filter((model) => !model.installed)
  const adapters = status.adapters ?? []
  if (adapters.length > 0) {
    const ready = adapters.filter((adapter) => adapter.installed).length
    console.log(`风格适配器：${ready}/${adapters.length} 就绪（自生成数据，共 ${humanBytes(adapters.reduce((sum, adapter) => sum + adapter.expectedBytes, 0))}）`)
    for (const adapter of adapters) console.log(`  [${adapter.installed ? '✓' : ' '}] ${adapter.id} · ${adapter.name}`)
  }
  if (missing.length > 0) {
    console.log(`缺失模型 ${missing.length} 个，约 ${humanBytes(status.missingBytes)}`)
    for (const model of missing) console.log(`  - ${model.displayName ?? model.name}（${humanBytes(model.expectedBytes)}）`)
  } else {
    console.log('模型：全部就绪')
  }
  printDownloadStatus(status.download)
  if (status.notes?.length) for (const note of status.notes) console.log(`• ${note}`)
}

function printDownloadStatus(download) {
  if (!download) return
  const strategyText = { auto: '自动（探测最快）', mirror: '国内镜像优先', direct: '只用官方源' }[download.strategy] ?? download.strategy
  console.log(`下载加速：${strategyText} · 并发 ${download.concurrency || 1} · 服务器助攻${download.serverAssist ? '开启' : '关闭'}`)
  const mirrors = [
    download.hfMirror ? `HF 镜像 ${download.hfMirror}` : 'HF 镜像 关闭',
    download.githubMirror ? `GitHub 加速 ${download.githubMirror}` : 'GitHub 加速 关闭',
    download.runtimeMirror ? `运行时镜像 ${download.runtimeMirror}` : '运行时镜像 未配置',
  ]
  console.log(`  ${mirrors.join(' · ')}`)
  if (download.serverAssist) {
    console.log(`  服务器地址：${download.serverAssistUrl || '未配置（只用本机离线包）'}`)
  }
  if (download.packagePresent) {
    console.log(
      `  离线包：${download.packageFiles} 个文件 / ${humanBytes(download.packageBytes)} · ${download.packagePath ?? download.packageDir ?? ''}`,
    )
  } else {
    console.log(`  离线包：未发现（目录 ${download.packagePath ?? download.packageDir ?? ''}）`)
  }
}

function printJob(job) {
  const icon = {
    pending: '·',
    running: '▶',
    done: '✓',
    failed: '✗',
    skipped: '-',
  }
  console.log(`任务 ${job.id} · ${job.status} · ${Math.round((job.progress ?? 0) * 100)}%`)
  for (const step of job.steps ?? []) {
    const pct = step.status === 'running' ? ` ${Math.round((step.progress ?? 0) * 100)}%` : ''
    console.log(`  ${icon[step.status] ?? '?'} ${step.label}${pct}${step.message ? ` · ${step.message}` : ''}`)
  }
  if (job.error) console.log(`错误：${job.error}`)
}

const SOURCE_KIND_ICON = { server: '服务器镜像', mirror: '镜像', official: '官方' }

function printSources(body) {
  const config = body?.config ?? {}
  const strategyText = { auto: 'auto（自动探测最快）', mirror: 'mirror（国内镜像优先）', direct: 'direct（只用官方源）' }[config.strategy] ?? config.strategy
  console.log(`下载源策略：${strategyText}`)
  console.log(`HuggingFace 镜像：${config.hfMirror || '关闭'}`)
  console.log(`GitHub 加速：${config.githubMirror || '关闭'}`)
  console.log(`运行时镜像：${config.runtimeMirror || '未配置'}`)
  console.log(`分片并发：${config.concurrency || 0}（0/1 = 单连接）`)
  console.log(`服务器助攻：${config.serverAssist ? '开启' : '关闭'}${config.serverAssist ? ` · ${config.serverAssistUrl || '未配置地址（只用本机离线包）'}` : ''}`)
  console.log(`使用本机离线包：${config.useLocalPackage ? '是' : '否'}`)
  console.log(`离线包目录：${config.packageDir || '（默认 <数据目录>/engine-package）'}`)
  const results = body?.results ?? []
  if (results.length > 0) {
    console.log('测速结果：')
    for (const item of results) {
      const icon = item.ok ? '✓' : '✗'
      const latency = item.latencyMs > 0 ? ` ${item.latencyMs}ms` : ''
      const error = item.ok ? '' : ` · ${item.error ?? '不可用'}`
      console.log(`  ${icon} ${String(item.label).padEnd(14)} ${SOURCE_KIND_ICON[item.kind] ?? item.kind ?? ''}${latency}${error}`)
    }
  } else {
    console.log('测速结果：未探测（加 --probe 触发）')
  }
  if (body?.error) console.log(`探测错误：${body.error}`)
}

/* ------------------------------------------------------------------ */
/* fetch：从服务器镜像拉离线包文件                                        */
/* ------------------------------------------------------------------ */

/** key → 本地落盘路径（布局见文件头注释；返回 null 表示未知 key） */
function localPathFor(dest, key) {
  const segments = String(key ?? '').split('/')
  const safe = (name) => Boolean(name) && name !== '.' && name !== '..' && !name.includes('\\') && !name.includes(':')
  if (!segments.length || !segments.every(safe)) return null
  const base = resolve(dest)
  let target
  if (segments[0] === 'runtime' && segments.length === 2) target = join(base, segments[1])
  else if (segments[0] === 'model' && segments.length === 2) target = join(base, 'models', segments[1])
  else if (['cuda', 'adapter', 'runtime-archive'].includes(segments[0]) && segments.length === 2) target = join(base, '.downloads', segments[1])
  else if (key === 'training/code') target = join(base, 'training', 'code.tar.gz')
  else if (key === 'training/python') target = join(base, 'training', 'python.tar.gz')
  else if (segments[0] === 'training' && segments[1] === 'dataset' && segments.length === 3) {
    target = join(base, 'training', 'datasets', `${segments[2]}.tar.gz`)
  } else if (segments[0] === 'training' && segments[1] === 'checkpoint' && segments.length >= 3) {
    target = join(base, 'training', 'checkpoints', ...segments.slice(2))
  } else {
    return null
  }
  const baseWithSep = base.endsWith(sep) ? base : `${base}${sep}`
  if (!target.startsWith(baseWithSep)) return null
  return target
}

/**
 * 本机平台三元组（与 manifest.ts 的 ProvisionPlatform 命名一致；未知平台退化为 `platform-arch`）
 */
function localPlatformTriple() {
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64'
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64'
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64'
  return `${process.platform}-${process.arch}`
}

/**
 * 生成 `fetch` 落盘后的 runtime.json 记录（纯函数，便于离线验收）。
 * 只有本次真的拉到 `runtime/` 开头（modern 逐文件运行时）时才返回记录；legacy 归档（runtime-archive）返回 null。
 *
 * @param {{ runtime?: { api?: string, version?: string, platform?: string } | null, files?: string[], source?: string, now?: Date }} options
 */
export function buildFetchedRuntimeRecord({ runtime, files, source, now = new Date() } = {}) {
  const runtimeKeys = Array.isArray(files) ? files.filter((key) => typeof key === 'string' && key.startsWith('runtime/')) : []
  if (runtimeKeys.length === 0) return null
  return {
    // 有 runtime/ 文件即 modern（legacy 平台只有 runtime-archive/<归档>，走不到这里）
    api: 'modern',
    version: typeof runtime?.version === 'string' && runtime.version ? runtime.version : 'fetched-from-server',
    platform: typeof runtime?.platform === 'string' && runtime.platform ? runtime.platform : localPlatformTriple(),
    files: runtimeKeys.length,
    installedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    source: typeof source === 'string' ? source : '',
  }
}

/**
 * fetch 完成后按需补写 `<dest>/runtime.json`（P9 契约：Companion 只读 api 判断 legacy/modern）。
 * - dest 已有 runtime.json → 不覆盖（避免把已装环境改坏），返回 { written:false, reason:'existing' }；
 * - 拉到了 modern 运行时文件 → 写入 { api:'modern', version, platform, files, installedAt, source }；
 * - 只拉到 legacy 归档 / 没有运行时文件 → 不写，返回 reason 'legacy-archive' / 'no-runtime'。
 * @param {string} dest
 * @param {{ runtime?: object, files?: string[], source?: string }} options
 */
export function writeFetchedRuntimeManifest(dest, { runtime, files, source } = {}) {
  const target = join(resolve(dest), 'runtime.json')
  if (existsSync(target)) {
    let existing = null
    try {
      existing = JSON.parse(readFileSync(target, 'utf8'))
    } catch {
      existing = null
    }
    return { written: false, reason: 'existing', existing, path: target }
  }
  const record = buildFetchedRuntimeRecord({ runtime, files, source })
  if (!record) {
    const hasLegacy = Array.isArray(files) && files.some((key) => typeof key === 'string' && key.startsWith('runtime-archive/'))
    return { written: false, reason: hasLegacy ? 'legacy-archive' : 'no-runtime', path: target }
  }
  mkdirSync(resolve(dest), { recursive: true })
  writeFileSync(target, JSON.stringify(record, null, 2), 'utf8')
  return { written: true, record, path: target }
}

/**
 * 下载单个镜像文件到本地（.part 续传 + sha256 校验）。
 * 返回 { status: 'cached' | 'downloaded', path, bytes }。
 */
async function fetchMirrorFile(baseUrl, dest, file, options = {}) {
  const target = localPathFor(dest, file.key)
  if (!target) throw new Error(`不认识的镜像 key：${file.key}`)
  mkdirSync(dirname(target), { recursive: true })
  const part = `${target}.part`
  const expectedSize = Number(file.size) > 0 ? Number(file.size) : 0
  const rawSha = typeof file.sha256 === 'string' ? file.sha256.trim().toLowerCase() : ''
  const expectedSha = /^[0-9a-f]{64}$/.test(rawSha) ? rawSha : ''

  // 已完整下载 → 直接跳过（有 sha 时校验）
  if (existsSync(target)) {
    const size = statSync(target).size
    if ((!expectedSize || size === expectedSize) && (!expectedSha || (await sha256File(target)) === expectedSha)) {
      return { status: 'cached', path: target, bytes: size }
    }
    rmSync(target, { force: true })
  }

  let start = existsSync(part) ? statSync(part).size : 0
  if (expectedSize && start > expectedSize) {
    rmSync(part, { force: true })
    start = 0
  }
  // .part 已完整（上次中断在重命名前）
  if (expectedSize && start === expectedSize) {
    if (!expectedSha || (await sha256File(part)) === expectedSha) {
      renameSync(part, target)
      return { status: 'downloaded', path: target, bytes: start }
    }
    rmSync(part, { force: true })
    start = 0
  }

  const headers = { 'User-Agent': 'aiab-provision-fetch/1' }
  if (options.token) headers['x-aiab-mirror-token'] = options.token
  if (start > 0) headers.Range = `bytes=${start}-`
  const url = `${baseUrl}/api/provision/mirror/file?key=${encodeURIComponent(file.key)}`
  const response = await fetch(url, { headers, signal: options.signal })
  if (response.status === 401) {
    throw new Error('服务器镜像需要令牌（401）：请用 --token 传入正确令牌')
  }
  if (!response.ok && response.status !== 206) {
    throw new Error(`下载失败（HTTP ${response.status}）：${file.key}`)
  }
  if (!response.body) throw new Error(`响应没有 body：${file.key}`)

  const resumed = response.status === 206 && start > 0
  if (!resumed) start = 0
  const hash = expectedSha ? createHash('sha256') : null
  if (hash && resumed && start > 0) {
    for await (const chunk of createReadStream(part)) hash.update(chunk)
  }
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  const total = expectedSize || (resumed ? start + contentLength : contentLength)
  let received = start
  let lastReport = 0
  const startedAt = Date.now()
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      if (hash) hash.update(chunk)
      const now = Date.now()
      if (options.onProgress && now - lastReport >= 500) {
        lastReport = now
        options.onProgress(received, total)
      }
      callback(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(part, { flags: resumed ? 'a' : 'w' }))
  } catch (error) {
    throw new Error(`下载中断：${file.key}（${error instanceof Error ? error.message : String(error)}；可重试续传）`)
  }
  options.onProgress?.(received, total, Date.now() - startedAt)

  if (expectedSize && received !== expectedSize) {
    rmSync(part, { force: true })
    throw new Error(`下载大小不符：${file.key} 期望 ${expectedSize}，实际 ${received}（已清理，可重试）`)
  }
  if (hash && expectedSha) {
    const actual = hash.digest('hex')
    if (actual !== expectedSha) {
      rmSync(part, { force: true })
      throw new Error(`sha256 校验失败：${file.key}（已删除损坏文件，可重试）`)
    }
  }
  renameSync(part, target)
  return { status: 'downloaded', path: target, bytes: received }
}

async function commandFetch() {
  const from = (getArg('from', process.env.AIAB_MIRROR_URL || '') || '').replace(/\/$/, '')
  const dest = getArg('dest', '')
  const token = getArg('token', process.env.AIAB_MIRROR_TOKEN || '')
  const includeTraining = args.includes('--training')
  const concurrencyArg = Number(getArg('concurrency', '4'))
  const concurrency = Number.isFinite(concurrencyArg) ? Math.max(1, Math.min(8, Math.trunc(concurrencyArg))) : 4
  if (!from) throw new Error('缺少 --from <server>（例：--from http://192.168.1.10:8787）')
  if (!dest) throw new Error('缺少 --dest <dir>（例：--dest D:\\AIAB\\engine）')
  const profiles = parseProfilesArg(getArg('profile', getArg('profiles', '')), [])

  const headers = { 'User-Agent': 'aiab-provision-fetch/1' }
  if (token) headers['x-aiab-mirror-token'] = token
  const manifestRes = await fetch(`${from}/api/provision/mirror/manifest`, { headers })
  if (manifestRes.status === 401) throw new Error('服务器镜像需要令牌（401）：请用 --token 传入正确令牌')
  if (!manifestRes.ok) throw new Error(`获取镜像清单失败（HTTP ${manifestRes.status}）`)
  const manifest = await manifestRes.json()
  if (manifest?.enabled === false) {
    throw new Error('目标服务器没有开启「服务器助攻」：请在那台机器的 设置 → 引擎下载 里开启，或改用 package 构建离线包')
  }
  let files = Array.isArray(manifest?.files) ? manifest.files.filter((file) => file && typeof file.key === 'string') : []
  files = files.filter((file) => includeTraining || !file.key.startsWith('training/'))
  if (profiles.length > 0) {
    const wanted = new Set(profiles.includes('essential') ? profiles : ['essential', ...profiles])
    files = files.filter((file) => {
      if (!file.key.startsWith('model/')) return true
      if (!Array.isArray(file.profiles) || file.profiles.length === 0) return true
      return file.profiles.some((profile) => wanted.has(profile))
    })
  }
  if (files.length === 0) {
    console.error('镜像清单里没有可拉取的文件（服务器离线包为空？或 --profile 过滤过严）')
    process.exitCode = 1
    return
  }
  const totalBytes = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0)
  console.log(
    `从 ${from} 拉取 ${files.length} 个文件（${humanBytes(totalBytes)}）到 ${resolve(dest)}` +
      `${profiles.length > 0 ? ` · profile=${profiles.join(',')}` : ''}${includeTraining ? ' · 含训练数据' : ''}`,
  )

  let nextIndex = 0
  let done = 0
  let downloadedBytes = 0
  const failures = []
  /** 本次成功落盘（新下载或已就绪）的 key，用于决定是否补写 runtime.json */
  const fetchedKeys = []
  const startedAt = Date.now()
  const worker = async () => {
    for (;;) {
      const index = nextIndex++
      if (index >= files.length) return
      const file = files[index]
      const label = `[${index + 1}/${files.length}] ${file.key}`
      if (!localPathFor(dest, file.key)) {
        failures.push(`${file.key}：不认识的 key，已跳过`)
        continue
      }
      try {
        const result = await fetchMirrorFile(from, dest, file, {
          token,
          onProgress: (received, total) => {
            if (!process.stdout.isTTY || !total) return
            const percent = Math.min(100, Math.round((received / total) * 100))
            process.stdout.write(`\r  ${label}  ${percent}%  ${humanSpeed(received / Math.max(0.001, (Date.now() - startedAt) / 1000))}   `)
          },
        })
        done += 1
        downloadedBytes += result.bytes
        fetchedKeys.push(file.key)
        if (process.stdout.isTTY) process.stdout.write('\r')
        const speed = result.status === 'downloaded' ? ` · ${humanSpeed(result.bytes / Math.max(0.001, (Date.now() - startedAt) / 1000))}` : ''
        const icon = result.status === 'cached' ? '=' : '✓'
        console.log(`${icon} ${label} · ${result.status === 'cached' ? '已就绪' : humanBytes(result.bytes)}${speed}`)
      } catch (error) {
        if (process.stdout.isTTY) process.stdout.write('\r')
        const message = error instanceof Error ? error.message : String(error)
        failures.push(`${file.key}：${message}`)
        console.error(`✗ ${label} · ${message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()))
  const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000)
  console.log(
    `\n完成：${done}/${files.length} 个文件，${humanBytes(downloadedBytes)}，用时 ${elapsed.toFixed(1)}s（平均 ${humanSpeed(downloadedBytes / elapsed)}）`,
  )

  // P9 契约：modern 运行时逐文件下载后补写 runtime.json，目录才能直接作为 Companion 的 AIAB_ACESTEP_DIR；
  // legacy 平台只有 runtime-archive 归档，需安装器解压，不写 runtime.json。
  const runtimeKeys = files.filter((file) => file.key.startsWith('runtime/')).map((file) => file.key)
  const fetchedRuntimeKeys = runtimeKeys.filter((key) => fetchedKeys.includes(key))
  if (runtimeKeys.length > 0 && fetchedRuntimeKeys.length !== runtimeKeys.length) {
    console.warn(
      `提示：有 ${runtimeKeys.length - fetchedRuntimeKeys.length} 个运行时文件未下载成功，本次不写 runtime.json（重新运行 fetch 补齐后会自动写）`,
    )
  } else {
    const written = writeFetchedRuntimeManifest(dest, { runtime: manifest?.runtime, files: fetchedKeys, source: from })
    if (written.written) {
      const record = written.record
      console.log(
        `✓ 已写入 ${written.path}（api=${record.api} · version=${record.version} · platform=${record.platform} · ${record.files} 个运行时文件）`,
      )
      console.log(`  该目录可直接作为 Companion 的 AIAB_ACESTEP_DIR：${resolve(dest)}`)
    } else if (written.reason === 'existing') {
      console.log(`runtime.json 已存在（${written.existing?.api ?? '未知'}），保留原文件不覆盖：${written.path}`)
    } else if (written.reason === 'legacy-archive') {
      console.log('提示：只拉取了 legacy 运行时归档（runtime-archive），需先由安装器解压才能使用；本次未写 runtime.json')
    } else {
      console.log('提示：本次没有拉取 modern 运行时文件，未写 runtime.json')
    }
  }
  if (failures.length > 0) {
    console.error(`失败 ${failures.length} 个：`)
    for (const item of failures) console.error(`  - ${item}`)
    process.exitCode = 1
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  if (command === 'status') {
    const { status, body } = await api('/api/provision/status')
    if (status !== 200) {
      console.error(`请求失败（HTTP ${status}）：${JSON.stringify(body)}`)
      process.exitCode = 1
      return
    }
    if (json) console.log(JSON.stringify(body, null, 2))
    else printStatus(body)
    return
  }

  if (command === 'jobs') {
    const { body } = await api('/api/provision/jobs')
    for (const job of body?.jobs ?? []) printJob(job)
    return
  }

  if (command === 'sources') {
    const probe = args.includes('--probe')
    const { status, body } = await api(`/api/provision/sources?probe=${probe ? '1' : '0'}`)
    if (status !== 200) {
      console.error(`请求失败（HTTP ${status}）：${JSON.stringify(body)}`)
      process.exitCode = 1
      return
    }
    if (json) console.log(JSON.stringify(body, null, 2))
    else printSources(body)
    return
  }

  if (command === 'install') {
    const profiles = parseProfilesArg(getArg('profile', getArg('profiles', 'essential')), ['essential'])
    const { status, body } = await api('/api/provision/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profiles, adapters: !args.includes('--no-adapters') }),
    })
    if (status !== 200) {
      console.error(`启动安装失败（HTTP ${status}）：${body?.error ?? JSON.stringify(body)}`)
      process.exitCode = 1
      return
    }
    const jobId = body.jobId
    console.log(`安装任务已启动：${jobId}（profiles=${profiles.join(',')}）`)
    console.log('提示：下载进度会显示来源（服务器镜像 / 国内镜像 / 官方源）与速度；可在 设置 → 引擎下载 调整加速策略')
    let last = ''
    for (;;) {
      const res = await api(`/api/provision/jobs/${jobId}`)
      if (res.status !== 200) {
        console.error(`查询失败（HTTP ${res.status}）`)
        process.exitCode = 1
        return
      }
      const job = res.body.job
      const line = `${Math.round((job.progress ?? 0) * 100)}%`
      if (line !== last) {
        const running = (job.steps ?? []).find((step) => step.status === 'running')
        console.log(`进度 ${line}${running ? ` · ${running.label}${running.message ? ` · ${running.message}` : ''}` : ''}`)
        last = line
      }
      if (job.status !== 'running') {
        printJob(job)
        process.exitCode = job.status === 'done' ? 0 : 1
        return
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500))
    }
  }

  if (command === 'package') {
    const profiles = parseProfilesArg(getArg('profiles', getArg('profile', 'essential')), ['essential'])
    const includeTraining = args.includes('--training')
    const outDir = getArg('out', '')
    const payload = { profiles, includeTraining }
    if (outDir) payload.outDir = outDir
    const { status, body } = await api('/api/provision/package/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (status !== 200) {
      console.error(`启动离线包构建失败（HTTP ${status}）：${body?.error ?? JSON.stringify(body)}`)
      process.exitCode = 1
      return
    }
    const jobId = body.jobId
    console.log(
      `离线包构建任务已启动：${jobId}（profiles=${profiles.join(',')}${includeTraining ? '，含训练数据' : '，不含训练数据'}）`,
    )
    let lastProgress = -1
    let lastMessage = ''
    for (;;) {
      const res = await api(`/api/provision/package/jobs/${jobId}`)
      if (res.status !== 200) {
        console.error(`查询构建进度失败（HTTP ${res.status}）`)
        process.exitCode = 1
        return
      }
      const job = res.body.job
      const progress = Math.round((job.progress ?? 0) * 100)
      if (progress !== lastProgress || job.message !== lastMessage) {
        console.log(`进度 ${progress}% · ${job.message ?? ''}`)
        lastProgress = progress
        lastMessage = job.message ?? ''
      }
      if (job.status !== 'running') {
        if (job.status === 'done') {
          const result = job.result ?? {}
          console.log(`\n✓ 离线包已生成：${result.dir}`)
          console.log(`  ${result.files ?? 0} 个文件 / ${humanBytes(result.bytes ?? 0)}（硬链接 ${result.linked ?? 0}，复制 ${result.copied ?? 0}）`)
          if (result.warnings?.length) {
            console.log(`  ⚠ ${result.warnings.length} 个文件被跳过：`)
            for (const warning of result.warnings.slice(0, 10)) console.log(`    - ${warning}`)
          }
          console.log('  服务器安装时会优先使用该离线包；其它机器可用 `provision.mjs fetch --from <本机地址> --dest <目录>` 拉取')
          process.exitCode = 0
        } else {
          console.error(`\n✗ 离线包构建${job.status === 'canceled' ? '已取消' : '失败'}：${job.error ?? job.message ?? ''}`)
          process.exitCode = 1
        }
        return
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 800))
    }
  }

  if (command === 'fetch') {
    await commandFetch()
    return
  }

  console.error(`未知命令：${command}（可用：status / install / jobs / sources / package / fetch）`)
  process.exitCode = 1
}

/** 只有直接 `node scripts/provision.mjs …` 才执行；被验收脚本 import（测纯函数）时不跑 CLI */
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return true
  }
})()

if (isMain) {
  main().catch((error) => {
    console.error('provision 失败：', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
