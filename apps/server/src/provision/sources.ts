/**
 * 下载源解析（P10）：国内镜像 + 多源回退 + 自动测速 + 服务器镜像。
 *
 * 背景：P8/P9 的引擎下载是「单源单连接」——
 *   - 运行时来自 serveurperso.com 的临时目录；
 *   - 模型来自 huggingface.co；
 *   - 适配器 / 训练代码 / 训练数据来自 GitHub Releases；
 * 国内网络下经常只有几百 KB/s 甚至超时，且单源失败就整体失败。
 *
 * 本模块只做「候选 URL 的生成与排序」，不关心下载细节（downloader.ts 负责）：
 *   1. 按策略（auto / mirror / direct）生成候选源；
 *   2. 镜像 URL 用路径/前缀映射，官方 URL 原样保留作回退；
 *   3. auto 模式对候选源做 Range 0-0 探测，按延迟排序（结果按 URL 缓存 5 分钟）；
 *   4. serverAssist：服务器已装/离线包里的文件通过 /api/provision/mirror/file 作为首选源。
 *
 * 安全：所有文件在 manifest.ts / trainingManifest.ts 里钉死了 size + sha256，
 * 镜像一律视为「不可信传输通道」，最终以哈希校验为准，见 downloader.ts。
 */
import process from 'node:process'
import type { AppSettings } from '@aiab/core'
import { MODERN_RUNTIME_BASE } from './manifest.js'

export type ProvisionSourceStrategy = 'auto' | 'mirror' | 'direct'

export type ProvisionArtifactKind =
  | 'model'
  | 'runtime'
  | 'runtime-archive'
  | 'cuda'
  | 'adapter'
  | 'training-code'
  | 'training-python'
  | 'training-dataset'
  | 'training-checkpoint'

/** 源类型：服务器镜像（局域网/本机）> 国产镜像 > 官方源 */
export type DownloadSourceKind = 'server' | 'mirror' | 'official'

export interface DownloadSource {
  url: string
  /** 中文标签，日志/进度/UI 里展示 */
  label: string
  kind: DownloadSourceKind
  /** 可选：服务器镜像对应的工件 key */
  key?: string
}

/** 内置默认镜像（用户可在 设置 → 引擎下载 里覆盖；填 'off' 关闭） */
export const DEFAULT_HF_MIRROR = 'https://hf-mirror.com'
export const DEFAULT_GITHUB_MIRROR = 'https://ghfast.top/'

/** 下载源的完整解析结果（安装器/训练器/路由共用） */
export interface ProvisionDownloadConfig {
  strategy: ProvisionSourceStrategy
  /** 已解析的 HF 镜像基础（'' = 关闭） */
  hfMirror: string
  /** 已解析的 GitHub 加速前缀（'' = 关闭；可能含 {url} 模板） */
  githubMirror: string
  /** 运行时 / CUDA 镜像基础（'' = 无自建镜像） */
  runtimeMirror: string
  /** 分片并发数：0/1 = 单连接 */
  concurrency: number
  serverAssist: boolean
  serverAssistUrl: string
  serverAssistToken: string
  useLocalPackage: boolean
  packageDir: string
  probeTimeoutMs: number
}

/** 不传设置时的兜底：与 P8/P9 行为一致（官方直连、单连接），避免破坏现有离线测试 */
export const DIRECT_DOWNLOAD_CONFIG: ProvisionDownloadConfig = {
  strategy: 'direct',
  hfMirror: '',
  githubMirror: '',
  runtimeMirror: '',
  concurrency: 0,
  serverAssist: false,
  serverAssistUrl: '',
  serverAssistToken: '',
  useLocalPackage: false,
  packageDir: '',
  probeTimeoutMs: 3000,
}

function envFlag(value: string | undefined): boolean | null {
  if (value === undefined || value.trim() === '') return null
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 解析镜像配置：
 * - `''` / 未填 → 用内置默认；
 * - `off` / `none` / `false` → 关闭（返回 ''）；
 * - 非 http(s) 的脏值 → 用内置默认，避免把错字变成所有下载失败。
 */
function resolveMirrorValue(raw: string | undefined, fallback: string): string {
  const value = (raw ?? '').trim()
  if (!value) return fallback
  const lower = value.toLowerCase()
  if (lower === 'off' || lower === 'none' || lower === 'false' || lower === 'disabled') return ''
  if (value.includes('{url}')) return value
  if (!isHttpUrl(value)) return fallback
  return stripTrailingSlash(value)
}

/** GitHub 加速前缀需要以 `/` 结尾（代理风格：前缀 + 完整 github URL） */
function resolveGithubMirror(raw: string | undefined, fallback: string): string {
  const value = resolveMirrorValue(raw, fallback)
  if (!value) return ''
  if (value.includes('{url}')) return value
  return value.endsWith('/') ? value : `${value}/`
}

function clampConcurrency(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(16, Math.round(value)))
}

/**
 * 把设置 + 环境变量解析成下载配置。
 *
 * - 传 settings（产品运行时）：用用户在 设置 → 引擎下载 里配置的镜像/策略/并发（默认 auto + 4 并发 + 服务器助攻）。
 * - 不传 settings（直接调用安装器/旧测试）：保持官方直连、单连接，行为与 P9 一致。
 * - 环境变量始终优先（便于 Docker/NAS 部署与排障），见 docs/DOWNLOAD_ACCELERATION.md。
 */
export function resolveDownloadConfig(
  settings?: AppSettings | null,
  env: NodeJS.ProcessEnv = process.env,
): ProvisionDownloadConfig {
  const provision = settings?.provision
  const fromSettings = Boolean(provision)
  const strategyEnv = (env.AIAB_DOWNLOAD_STRATEGY ?? '').trim().toLowerCase()
  const strategy: ProvisionSourceStrategy =
    strategyEnv === 'auto' || strategyEnv === 'mirror' || strategyEnv === 'direct'
      ? strategyEnv
      : fromSettings
        ? (provision?.sourceStrategy ?? 'auto')
        : 'direct'
  const hfMirror = resolveMirrorValue(env.AIAB_HF_MIRROR ?? provision?.hfMirror, DEFAULT_HF_MIRROR)
  const githubMirror = resolveGithubMirror(env.AIAB_GITHUB_MIRROR ?? provision?.githubMirror, DEFAULT_GITHUB_MIRROR)
  const runtimeMirror = resolveMirrorValue(env.AIAB_RUNTIME_MIRROR ?? provision?.runtimeMirror, '')
  const concurrency = clampConcurrency(
    env.AIAB_DOWNLOAD_CONCURRENCY !== undefined && env.AIAB_DOWNLOAD_CONCURRENCY.trim() !== ''
      ? Number(env.AIAB_DOWNLOAD_CONCURRENCY)
      : provision?.concurrency,
    fromSettings ? 4 : 0,
  )
  const assistEnv = envFlag(env.AIAB_SERVER_ASSIST)
  const serverAssist = assistEnv ?? (fromSettings ? (provision?.serverAssist ?? true) : false)
  const serverAssistUrl = stripTrailingSlash(
    (env.AIAB_SERVER_ASSIST_URL ?? provision?.serverAssistUrl ?? '').trim(),
  )
  const useLocalPackage = serverAssist ? (fromSettings ? (provision?.useLocalPackage ?? true) : false) : false
  const packageDir = (env.AIAB_ENGINE_PACKAGE_DIR ?? provision?.packageDir ?? '').trim()
  const timeoutEnv = Number(env.AIAB_SOURCE_PROBE_TIMEOUT_MS)
  return {
    strategy,
    hfMirror,
    githubMirror,
    runtimeMirror,
    concurrency,
    serverAssist,
    serverAssistUrl,
    serverAssistToken: (env.AIAB_MIRROR_TOKEN ?? provision?.serverAssistToken ?? '').trim(),
    useLocalPackage,
    packageDir,
    probeTimeoutMs: Number.isFinite(timeoutEnv) && timeoutEnv > 0 ? Math.min(timeoutEnv, 15000) : 3000,
  }
}

/** 以「官方直连」为底，合并调用方显式传入的覆盖项（安装器 options.download） */
export function normalizeDownloadConfig(partial?: Partial<ProvisionDownloadConfig> | null): ProvisionDownloadConfig {
  if (!partial) return { ...DIRECT_DOWNLOAD_CONFIG }
  return {
    ...DIRECT_DOWNLOAD_CONFIG,
    ...partial,
    concurrency: clampConcurrency(partial.concurrency, DIRECT_DOWNLOAD_CONFIG.concurrency),
  }
}

/** 配置的对外摘要（/api/provision/status 与 CLI 用；镜像显示解析后的实际值） */
export function downloadConfigSummary(config: ProvisionDownloadConfig): {
  strategy: ProvisionSourceStrategy
  hfMirror: string
  githubMirror: string
  runtimeMirror: string
  concurrency: number
  serverAssist: boolean
  serverAssistUrl: string
  useLocalPackage: boolean
  packageDir: string
} {
  return {
    strategy: config.strategy,
    hfMirror: config.hfMirror,
    githubMirror: config.githubMirror,
    runtimeMirror: config.runtimeMirror,
    concurrency: config.concurrency,
    serverAssist: config.serverAssist,
    serverAssistUrl: config.serverAssistUrl,
    useLocalPackage: config.useLocalPackage,
    packageDir: config.packageDir,
  }
}

/* ------------------------------------------------------------------ */
/* 镜像 URL 映射                                                        */
/* ------------------------------------------------------------------ */

const HF_ORIGIN = 'https://huggingface.co'

/** 把 huggingface.co 官方 URL 映射到 HF 镜像（hf-mirror.com 为路径兼容镜像） */
export function hfMirrorUrl(officialUrl: string, config: ProvisionDownloadConfig): string | null {
  if (!config.hfMirror) return null
  if (!officialUrl.startsWith(`${HF_ORIGIN}/`)) return null
  return `${stripTrailingSlash(config.hfMirror)}${officialUrl.slice(HF_ORIGIN.length)}`
}

/**
 * 把 GitHub 官方 URL 映射到加速前缀。
 * 支持两种配置：`https://ghfast.top/`（前缀 + 完整 URL）或 `https://x/{url}`（模板）。
 */
export function githubMirrorUrl(officialUrl: string, config: ProvisionDownloadConfig): string | null {
  if (!config.githubMirror) return null
  if (!/^https:\/\/(github\.com|objects\.githubusercontent\.com|raw\.githubusercontent\.com)\//.test(officialUrl)) return null
  if (config.githubMirror.includes('{url}')) return config.githubMirror.replace('{url}', officialUrl)
  return `${config.githubMirror}${officialUrl}`
}

/** 运行时 / CUDA 自建镜像：扁平目录，文件名与官方一致 */
export function runtimeMirrorUrl(officialUrl: string, config: ProvisionDownloadConfig): string | null {
  if (!config.runtimeMirror) return null
  try {
    const name = new URL(officialUrl).pathname.split('/').filter(Boolean).pop()
    if (!name) return null
    return `${stripTrailingSlash(config.runtimeMirror)}/${name}`
  } catch {
    return null
  }
}

/** 按工件类型生成镜像 URL（没有可用镜像时返回 null） */
export function mirrorUrlFor(
  kind: ProvisionArtifactKind,
  officialUrl: string,
  config: ProvisionDownloadConfig,
): string | null {
  switch (kind) {
    case 'model':
    case 'training-checkpoint':
      return hfMirrorUrl(officialUrl, config)
    case 'adapter':
    case 'training-code':
    case 'training-python':
    case 'training-dataset':
      return githubMirrorUrl(officialUrl, config)
    case 'runtime':
    case 'runtime-archive':
    case 'cuda':
      return runtimeMirrorUrl(officialUrl, config)
    default:
      return null
  }
}

/* ------------------------------------------------------------------ */
/* 工件 key（离线包 / 服务器镜像的稳定标识）                             */
/* ------------------------------------------------------------------ */

/**
 * 工件 key 规则（全项目统一，enginePackage.ts 与之逐字一致）：
 *   runtime/<文件名>、cuda/<zip 名>、runtime-archive/<legacy 归档名>、
 *   model/<gguf 名>、adapter/<tar.gz 名>、training/code、training/python、
 *   training/dataset/<id>、training/checkpoint/<dest>
 */
export function artifactKey(kind: ProvisionArtifactKind, name: string): string {
  switch (kind) {
    case 'runtime':
      return `runtime/${name}`
    case 'cuda':
      return `cuda/${name}`
    case 'runtime-archive':
      return `runtime-archive/${name}`
    case 'model':
      return `model/${name}`
    case 'adapter':
      return `adapter/${name}`
    case 'training-code':
      return 'training/code'
    case 'training-python':
      return 'training/python'
    case 'training-dataset':
      return `training/dataset/${name}`
    case 'training-checkpoint':
      return `training/checkpoint/${name}`
    default:
      return name
  }
}

/* ------------------------------------------------------------------ */
/* 服务器镜像（serverAssist）                                           */
/* ------------------------------------------------------------------ */

export function serverMirrorRepoUrl(config: ProvisionDownloadConfig): string | null {
  if (!config.serverAssist || !config.serverAssistUrl) return null
  return `${config.serverAssistUrl.replace(/\/+$/, '')}/api/provision/mirror`
}

export function serverMirrorManifestUrl(config: ProvisionDownloadConfig): string | null {
  const repo = serverMirrorRepoUrl(config)
  return repo ? `${repo}/manifest` : null
}

/** 服务器镜像单文件 URL（key 走 query，天然避免路径穿越） */
export function serverMirrorFileUrl(config: ProvisionDownloadConfig, key: string): string | null {
  const repo = serverMirrorRepoUrl(config)
  if (!repo) return null
  const token = config.serverAssistToken ? `&token=${encodeURIComponent(config.serverAssistToken)}` : ''
  return `${repo}/file?key=${encodeURIComponent(key)}${token}`
}

export interface ServerMirrorIndex {
  url: string
  /** 服务器上可用的工件 key */
  keys: Set<string>
  /** key → 文件元信息（用于本地/远程对比） */
  files: Map<string, { size: number; sha256?: string }>
}

interface MirrorIndexCacheEntry {
  at: number
  value: ServerMirrorIndex | null
}

const mirrorIndexCache = new Map<string, MirrorIndexCacheEntry>()
const MIRROR_INDEX_TTL_MS = 60_000
const MIRROR_INDEX_FAIL_TTL_MS = 15_000

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const list = signals.filter((signal): signal is AbortSignal => Boolean(signal))
  if (list.length === 1) return list[0] as AbortSignal
  return AbortSignal.any(list)
}

/**
 * 拉取服务器镜像清单（serverAssistUrl 配置了才生效）。
 * 失败返回 null（调用方静默回退到镜像/官方源），并做短 TTL 负缓存避免每个文件都超时一次。
 */
export async function fetchServerMirrorIndex(
  config: ProvisionDownloadConfig,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal; log?: (message: string) => void; force?: boolean } = {},
): Promise<ServerMirrorIndex | null> {
  const url = serverMirrorManifestUrl(config)
  if (!url) return null
  const cacheKey = `${url}|${config.serverAssistToken}`
  const cached = mirrorIndexCache.get(cacheKey)
  if (!options.force && cached && Date.now() - cached.at < (cached.value ? MIRROR_INDEX_TTL_MS : MIRROR_INDEX_FAIL_TTL_MS)) {
    return cached.value
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(8000)
  try {
    const response = await fetchImpl(url, {
      headers: config.serverAssistToken ? { 'x-aiab-mirror-token': config.serverAssistToken } : {},
      signal: combineSignals(options.signal, timeout),
    })
    if (response.status === 401) {
      options.log?.('服务器镜像需要令牌（401）：请在设置里填写「服务器镜像令牌」')
      mirrorIndexCache.set(cacheKey, { at: Date.now(), value: null })
      return null
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = (await response.json()) as {
      enabled?: boolean
      files?: Array<{ key?: string; size?: number; sha256?: string }>
    }
    if (body.enabled === false) {
      mirrorIndexCache.set(cacheKey, { at: Date.now(), value: null })
      return null
    }
    const index: ServerMirrorIndex = { url, keys: new Set(), files: new Map() }
    for (const file of body.files ?? []) {
      if (typeof file.key !== 'string' || !file.key) continue
      index.keys.add(file.key)
      index.files.set(file.key, {
        size: typeof file.size === 'number' ? file.size : 0,
        sha256: typeof file.sha256 === 'string' && file.sha256 ? file.sha256 : undefined,
      })
    }
    mirrorIndexCache.set(cacheKey, { at: Date.now(), value: index })
    options.log?.(`服务器镜像可用：${index.keys.size} 个文件（${config.serverAssistUrl}）`)
    return index
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    options.log?.(`服务器镜像不可用（${reason}），改用镜像/官方源`)
    mirrorIndexCache.set(cacheKey, { at: Date.now(), value: null })
    return null
  }
}

/** 测试用：清空服务器清单缓存 */
export function clearServerMirrorIndexCache(): void {
  mirrorIndexCache.clear()
}

/* ------------------------------------------------------------------ */
/* 候选源生成 + 自动测速排序                                            */
/* ------------------------------------------------------------------ */

export interface ArtifactSourceRequest {
  kind: ProvisionArtifactKind
  /** 官方 URL（镜像映射与回退都用它） */
  officialUrl: string
  /** 工件名（生成服务器镜像 key 用），如文件名 / dataset id / checkpoint dest */
  name: string
  config: ProvisionDownloadConfig
  /** 服务器镜像清单；null/缺省 = 本次不使用服务器源 */
  serverIndex?: ServerMirrorIndex | null
}

/**
 * 生成某个工件的候选下载源（未排序，顺序即策略顺序）：
 * 服务器镜像（有则最前）→ 国内镜像（仅 auto/mirror 策略）→ 官方源（始终保留作回退）。
 *
 * 注意：`direct` = 只用官方源（不经第三方镜像），因此不生成 mirror 候选；
 * 服务器镜像属于用户自己的机器（局域网/离线包），由 serverAssist 独立控制，不受 direct 影响。
 */
export function sourcesForArtifact(request: ArtifactSourceRequest): DownloadSource[] {
  const { kind, officialUrl, name, config, serverIndex } = request
  const sources: DownloadSource[] = []
  const key = artifactKey(kind, name)
  if (serverIndex?.keys.has(key)) {
    const url = serverMirrorFileUrl(config, key)
    if (url) sources.push({ url, label: '服务器镜像', kind: 'server', key })
  }
  const mirrorUrl = config.strategy === 'direct' ? null : mirrorUrlFor(kind, officialUrl, config)
  if (mirrorUrl && mirrorUrl !== officialUrl) {
    sources.push({ url: mirrorUrl, label: mirrorLabel(kind), kind: 'mirror' })
  }
  sources.push({ url: officialUrl, label: officialLabel(kind), kind: 'official' })
  return dedupeSources(sources)
}

function mirrorLabel(kind: ProvisionArtifactKind): string {
  if (kind === 'model' || kind === 'training-checkpoint') return '国内 HF 镜像'
  if (kind === 'runtime' || kind === 'runtime-archive' || kind === 'cuda') return '运行时镜像'
  return 'GitHub 加速'
}

function officialLabel(kind: ProvisionArtifactKind): string {
  if (kind === 'model' || kind === 'training-checkpoint') return 'HuggingFace 官方源'
  if (kind === 'runtime' || kind === 'runtime-archive' || kind === 'cuda') return '运行时官方源'
  return 'GitHub 官方源'
}

function dedupeSources(sources: DownloadSource[]): DownloadSource[] {
  const seen = new Set<string>()
  return sources.filter((source) => {
    if (seen.has(source.url)) return false
    seen.add(source.url)
    return true
  })
}

interface ProbeCacheEntry {
  at: number
  ok: boolean
  latencyMs: number
  error?: string
}

const probeCache = new Map<string, ProbeCacheEntry>()
const PROBE_CACHE_TTL_MS = 5 * 60_000

/**
 * 探测缓存键：按「源站」（protocol + host + port）缓存，而不是按完整文件 URL。
 * 同一个镜像上的多个文件延迟高度相关，按源站缓存可以避免 modern 运行时 24 个文件、
 * 10 个模型逐个探测带来的额外前置耗时（每个源站一次探测，其余直接复用结果）。
 * 若某源站可达但个别文件 404，downloader 的多源回退会继续尝试官方源，不会误判成坏文件。
 */
function probeCacheKey(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

export interface ProbeResult {
  url: string
  ok: boolean
  latencyMs: number
  error?: string
}

/**
 * 探测单个 URL：`Range: bytes=0-0` 只取 1 字节，测 TTFB。
 * 接受 200/206/416（416 = 源支持 Range 但请求范围无效，不影响可用性判断）。
 */
export async function probeUrl(
  url: string,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; cache?: boolean } = {},
): Promise<ProbeResult> {
  const useCache = options.cache !== false
  const cacheKey = probeCacheKey(url)
  if (useCache) {
    const cached = probeCache.get(cacheKey)
    if (cached && Date.now() - cached.at < PROBE_CACHE_TTL_MS) {
      return { url, ok: cached.ok, latencyMs: cached.latencyMs, error: cached.error }
    }
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 3000
  const started = Date.now()
  const timeout = AbortSignal.timeout(timeoutMs)
  let result: ProbeResult
  try {
    const response = await fetchImpl(url, {
      headers: { Range: 'bytes=0-0', 'User-Agent': 'aiab-provision-probe/1' },
      signal: combineSignals(options.signal, timeout),
      redirect: 'follow',
      cache: 'no-store',
    })
    const latencyMs = Date.now() - started
    const ok = response.status === 200 || response.status === 206 || response.status === 416
    try {
      await response.body?.cancel()
    } catch {
      /* ignore */
    }
    result = { url, ok, latencyMs, error: ok ? undefined : `HTTP ${response.status}` }
  } catch (error) {
    result = { url, ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
  }
  if (useCache) probeCache.set(cacheKey, { at: Date.now(), ...result })
  return result
}

/** 测试用：清空探测缓存 */
export function clearProbeCache(): void {
  probeCache.clear()
}

/**
 * auto 策略：并发探测所有候选源，按延迟从快到慢排序；探测失败的排最后（仍重试一次，避免误杀）。
 * mirror 策略保持原顺序（服务器 → 镜像 → 官方）；direct 策略额外过滤掉第三方镜像（防御性兜底，
 * 即使调用方手工传入了 mirror 源也不会被请求）。
 */
export async function rankSources(
  sources: DownloadSource[],
  options: { config?: ProvisionDownloadConfig; fetchImpl?: typeof fetch; signal?: AbortSignal; log?: (message: string) => void } = {},
): Promise<DownloadSource[]> {
  const config = options.config
  if (config?.strategy === 'direct') {
    return sources.filter((source) => source.kind !== 'mirror')
  }
  if (!config || config.strategy !== 'auto') return sources
  if (sources.length <= 1) return sources
  const results = await Promise.all(
    sources.map(async (source) => ({
      source,
      probe: await probeUrl(source.url, {
        fetchImpl: options.fetchImpl,
        signal: options.signal,
        timeoutMs: config?.probeTimeoutMs ?? 3000,
      }),
    })),
  )
  const reachable = results.filter((item) => item.probe.ok).sort((a, b) => a.probe.latencyMs - b.probe.latencyMs)
  const unreachable = results.filter((item) => !item.probe.ok).map((item) => item.source)
  for (const item of reachable) {
    options.log?.(`源测速：${item.source.label} ${item.probe.latencyMs}ms（优先）`)
  }
  for (const item of results.filter((entry) => !entry.probe.ok)) {
    options.log?.(`源测速：${item.source.label} 不可达（${item.probe.error ?? '超时'}），排到最后`)
  }
  return [...reachable.map((item) => item.source), ...unreachable]
}

/* ------------------------------------------------------------------ */
/* 用户可见的「测速」：代表性 URL 探测（不下载大文件）                   */
/* ------------------------------------------------------------------ */

export interface SourceProbeEntry {
  label: string
  kind: DownloadSourceKind | 'mirror'
  url: string
  ok: boolean
  latencyMs: number
  error?: string
}

/**
 * 对「HF 官方 / HF 镜像 / GitHub 官方 / GitHub 加速 / 运行时官方 / 运行时镜像 / 服务器镜像」
 * 做一次代表性探测，供设置页「测速」按钮与 CLI `provision.mjs sources --probe` 使用。
 * 全部失败也不抛错，返回结果列表即可。
 */
export async function probeDownloadSources(
  config: ProvisionDownloadConfig,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; log?: (message: string) => void } = {},
): Promise<{ config: ReturnType<typeof downloadConfigSummary>; results: SourceProbeEntry[] }> {
  const hfSample = `${HF_ORIGIN}/Serveurperso/ACE-Step-1.5-GGUF/resolve/main/vae-BF16.gguf`
  const githubSample = 'https://github.com/Einsphoton/AIArrangementBuddy/releases/download/adapters-v1/adapter-jrpg_v1.tar.gz'
  const runtimeSample = `${MODERN_RUNTIME_BASE}ace-server.exe`
  const targets: Array<{ label: string; kind: SourceProbeEntry['kind']; url: string }> = []
  const push = (label: string, kind: SourceProbeEntry['kind'], url: string | null): void => {
    if (url) targets.push({ label, kind, url })
  }
  push('HuggingFace 官方源', 'official', hfSample)
  push('国内 HF 镜像', 'mirror', hfMirrorUrl(hfSample, config))
  push('GitHub 官方源', 'official', githubSample)
  push('GitHub 加速', 'mirror', githubMirrorUrl(githubSample, config))
  push('运行时官方源', 'official', runtimeSample)
  push('运行时镜像', 'mirror', runtimeMirrorUrl(runtimeSample, config))
  const manifestUrl = serverMirrorManifestUrl(config)
  if (manifestUrl) targets.push({ label: '服务器镜像', kind: 'server', url: manifestUrl })
  const timeoutMs = options.timeoutMs ?? 5000
  const results = await Promise.all(
    targets.map(async (target) => {
      if (target.kind === 'server') {
        const index = await fetchServerMirrorIndex(config, { fetchImpl: options.fetchImpl, force: true })
        return {
          label: target.label,
          kind: target.kind,
          url: target.url,
          ok: index !== null,
          latencyMs: 0,
          error: index === null ? '清单不可用' : undefined,
        } satisfies SourceProbeEntry
      }
      const probe = await probeUrl(target.url, { fetchImpl: options.fetchImpl, timeoutMs, cache: false })
      return { label: target.label, kind: target.kind, url: target.url, ok: probe.ok, latencyMs: probe.latencyMs, error: probe.error }
    }),
  )
  options.log?.(`源探测：${results.filter((item) => item.ok).length}/${results.length} 个源可用`)
  return { config: downloadConfigSummary(config), results }
}