/**
 * 本机引擎安装器（P8 / P9 / P10）：运行时 + 模型 + 任务进度。
 *
 * 目录布局（放在数据目录下，随产品数据一起迁移）：
 *   <dataDir>/audio-engine/            ← 旧版名为 ace-step，首次读取时自动改名迁移
 *     ace-server(.exe) / dylibs / tools   ← 运行时（Windows = modern 逐文件下载；Mac/Linux = legacy 归档解压）
 *     models/*.gguf                        ← 模型（HF 下载，sha256 校验）
 *     .downloads/                          ← 断点续传缓存（含 CUDA redist zip）
 *     runtime.json                         ← 已安装运行时记录（含 api: legacy / modern）
 *
 * P9：Windows x64 改用上游 modern 运行时（逐文件 sha256 + CUDA 13 redist DLL），
 * 支持 XL 4B 模型；已装 legacy 的 Windows 用户再次安装时会自动升级（同名文件覆盖）。
 * P10：下载源/离线包/服务器助攻接线（见 sources.ts / enginePackage.ts）。
 *
 * 界面展示名统一走 @aiab/core 的 branding（modelDisplayName / AI_ENGINE_RUNTIME_NAME），
 * 磁盘文件名与下载地址保持真实值，避免破坏已有安装与校验。
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { modelDisplayName } from '@aiab/core'
import { readZipEntries } from '../sync/zip-read.js'
import { downloadFile, type DownloadProgress } from './downloader.js'
import { copyLocalArtifact, findLocalArtifact } from './enginePackage.js'
import {
  ADAPTER_ASSETS,
  CUDA_REDIST_ASSETS,
  DOWNLOAD_CACHE_DIR,
  ENGINE_RUNTIME_VERSION,
  LEGACY_PROVISION_DIR_NAME,
  MODEL_FILES,
  MODERN_RUNTIME_FILES,
  NVCUDART_HYBRID_DLL,
  PROVISION_DIR_NAME,
  RUNTIME_ASSETS,
  RUNTIME_BINARIES,
  RUNTIME_EXECUTABLES,
  RUNTIME_VERSION,
  adapterUrl,
  adaptersTotalBytes,
  modelUrl,
  modelsForProfiles,
  modernRuntimeUrl,
  resolvePlatform,
  runtimeApiForPlatform,
  runtimePlanBytes,
  runtimePlanVersion,
  runtimeUrl,
  type CudaRedistAsset,
  type ModelFile,
  type ProvisionPlatform,
  type ProvisionProfile,
  type RuntimeApi,
  type RuntimeFile,
} from './manifest.js'
import {
  artifactKey,
  fetchServerMirrorIndex,
  normalizeDownloadConfig,
  rankSources,
  sourcesForArtifact,
  type DownloadSource,
  type ProvisionArtifactKind,
  type ProvisionDownloadConfig,
  type ServerMirrorIndex,
} from './sources.js'
import { extractTarGzToDir, safeArchivePath } from './untar.js'

/**
 * 大文件下载的重试次数（downloader 默认 3 次）。
 *
 * 国内网络经代理下载 HuggingFace / GitHub 大文件时，连接常在中途被重置；下载器支持
 * 断点续传，失败只损失当前连接尚未落盘的一小段，因此多试几次的代价很小，却能避免
 * 「2.5GB 模型下到 30% 就整任务失败、只能反复手点下载」。
 */
const RUNTIME_DOWNLOAD_ATTEMPTS = 5
const MODEL_DOWNLOAD_ATTEMPTS = 8
const ADAPTER_DOWNLOAD_ATTEMPTS = 5

export interface ProvisionPaths {
  root: string
  downloads: string
  models: string
  binary: string
}

/**
 * 引擎根目录：新目录名优先；发现旧目录（ace-step）时自动改名迁移，界面此后只显示新名字。
 * 迁移失败（例如权限/占用）就退回旧目录，保证功能不中断。
 */
function resolveProvisionRoot(dataDir: string): string {
  const root = path.join(dataDir, PROVISION_DIR_NAME)
  if (existsSync(root)) return root
  const legacy = path.join(dataDir, LEGACY_PROVISION_DIR_NAME)
  if (!existsSync(legacy)) return root
  try {
    renameSync(legacy, root)
    return root
  } catch {
    return legacy
  }
}

export function provisionPaths(dataDir: string): ProvisionPaths {
  const root = resolveProvisionRoot(dataDir)
  return {
    root,
    downloads: path.join(root, DOWNLOAD_CACHE_DIR),
    models: path.join(root, 'models'),
    binary: '',
  }
}

/* ------------------------------------------------------------------ */
/* 下载源 / 本地离线包接线（P10）                                       */
/* ------------------------------------------------------------------ */

/** 一次安装流程的下载上下文：解析后的配置 +（可选）服务器镜像清单 */
export interface DownloadContext {
  dataDir: string
  config: ProvisionDownloadConfig
  serverIndex: ServerMirrorIndex | null
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  log?: (message: string) => void
}

/** 进度消息里的实时速度（UI 显示 MB/s；拿不到速度时为空串） */
export function speedText(speedBps: number | undefined): string {
  return speedBps && Number.isFinite(speedBps) ? ` · ${(speedBps / (1024 * 1024)).toFixed(1)}MB/s` : ''
}

/** 进度消息里的并发线程数 / 预计剩余时间（体积大、用户最关心「还要多久」） */
export function etaText(speedBps: number | undefined, remainingBytes: number, segments?: number): string {
  const threads = segments && segments > 1 ? ` · ${segments} 线程` : ''
  if (!speedBps || !Number.isFinite(speedBps) || speedBps <= 0 || remainingBytes <= 0) return threads
  const seconds = remainingBytes / speedBps
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 24 * 3600) return threads
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes >= 60) return `${threads} · 预计剩余 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
  return `${threads} · 预计剩余 ${minutes} 分钟`
}

/**
 * 创建下载上下文：
 * - 不传 download（旧调用/离线测试）→ DIRECT 配置：纯官方 URL + 单连接，行为与 P9 一致；
 * - 传了 download（路由从 settings 解析）→ 镜像/多源/并发/离线包/服务器助攻全部启用。
 */
export async function createDownloadContext(options: {
  dataDir: string
  download?: Partial<ProvisionDownloadConfig>
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  log?: (message: string) => void
}): Promise<DownloadContext> {
  const config = normalizeDownloadConfig(options.download)
  let serverIndex: ServerMirrorIndex | null = null
  if (config.serverAssist && config.serverAssistUrl) {
    try {
      serverIndex = await fetchServerMirrorIndex(config, {
        fetchImpl: options.fetchImpl,
        signal: options.signal,
        log: options.log,
      })
    } catch {
      serverIndex = null
    }
  }
  return {
    dataDir: options.dataDir,
    config,
    serverIndex,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    log: options.log,
  }
}

export interface ArtifactSpec {
  kind: ProvisionArtifactKind
  /** manifest.ts / trainingManifest.ts 里钉死的官方 URL */
  url: string
  /** 文件名 / dataset id / checkpoint dest（与 sources.artifactKey 一致） */
  name: string
  sha256?: string
  size?: number
}

/** 生成候选下载源并排序（auto 策略会做一次 Range 0-0 延迟探测）。 */
export async function artifactSources(context: DownloadContext, spec: ArtifactSpec): Promise<DownloadSource[]> {
  const unranked = sourcesForArtifact({
    kind: spec.kind,
    officialUrl: spec.url,
    name: spec.name,
    config: context.config,
    serverIndex: context.serverIndex,
  })
  return rankSources(unranked, {
    config: context.config,
    fetchImpl: context.fetchImpl,
    signal: context.signal,
    log: context.log,
  })
}

/**
 * 取单个工件到 dest：本机离线包（useLocalPackage）优先 → 服务器镜像 → 国内镜像 → 官方源。
 * 本地拷贝失败自动回退网络；网络下载失败抛中文错误（分片/续传状态保留）。
 */
export async function fetchArtifact(
  context: DownloadContext,
  spec: ArtifactSpec,
  dest: string,
  hooks: { onProgress?: (progress: DownloadProgress) => void; force?: boolean; attempts?: number; log?: (message: string) => void } = {},
): Promise<'downloaded' | 'cached' | 'local'> {
  const log = context.log
  // force：先删目标文件，离线包/网络都重新落盘
  if (hooks.force) rmSync(dest, { force: true })
  // 1) 本机离线包优先（B 的 enginePackage：硬链接/复制 + size/sha256 校验）
  if (context.config.useLocalPackage) {
    const key = artifactKey(spec.kind, spec.name)
    const local = findLocalArtifact(context.dataDir, key, context.config.packageDir || undefined)
    if (local && path.resolve(local.path) !== path.resolve(dest)) {
      log?.(`使用本地离线包：${key}（${(local.size / 1e6).toFixed(1)}MB）`)
      const copied = await copyLocalArtifact(local, dest, { sha256: spec.sha256, signal: context.signal, log })
      if (copied) {
        hooks.onProgress?.({
          received: spec.size ?? local.size,
          total: spec.size ?? local.size,
          speedBps: 0,
          source: '本地离线包',
          segments: 1,
        })
        return 'local'
      }
      log?.(`本地离线包校验失败（${key}），改用网络下载`)
    }
  }
  // 2) 网络多源下载（sources.ts 已按策略/测速排好序）
  const sources = await artifactSources(context, spec)
  if (sources.length > 1) log?.(`下载 ${spec.name}：候选源 ${sources.map((source) => source.label).join(' → ')}`)
  const result = await downloadFile({
    sources,
    dest,
    sha256: spec.sha256,
    size: spec.size,
    concurrency: context.config.concurrency,
    attempts: hooks.attempts,
    signal: context.signal,
    fetchImpl: context.fetchImpl,
    log: hooks.log ?? log,
    onProgress: hooks.onProgress,
  })
  return result.status
}

function binaryCandidates(root: string, platform: ProvisionPlatform): string[] {
  const names =
    platform === 'win32-x64'
      ? RUNTIME_BINARIES.win32
      : platform === 'darwin-arm64'
        ? RUNTIME_BINARIES.darwin
        : RUNTIME_BINARIES.linux
  return names.map((name) => path.join(root, name))
}

export function findRuntimeBinary(root: string, platform: ProvisionPlatform): string | null {
  for (const candidate of binaryCandidates(root, platform)) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export interface RuntimeStatus {
  /** 当前安装计划的运行时是否已完整就绪（Windows 需 modern + 24 个文件 + CUDA DLL 齐全） */
  installed: boolean
  path: string | null
  sizeBytes: number
  /** 已装/计划使用的运行时 API；legacy 表示旧版 v0.1.0 归档（Windows 上会触发自动升级） */
  api: RuntimeApi
  /** 安装计划版本：modern = acestep.cpp-20261106；legacy = 官方归档名 */
  version?: string
}

export interface AdapterStatus {
  id: string
  name: string
  installed: boolean
  bytes: number
  expectedBytes: number
  style?: string
  license: string
}

export interface ModelStatus {
  name: string
  /** 界面展示名（不暴露真实权重文件名） */
  displayName: string
  installed: boolean
  sizeBytes: number
  expectedBytes: number
  profiles: ProvisionProfile[]
}

export interface ProvisionStatus {
  platform: ProvisionPlatform
  supported: boolean
  root: string
  runtime: RuntimeStatus
  models: ModelStatus[]
  adapters: AdapterStatus[]
  profiles: Record<ProvisionProfile, boolean>
  missingBytes: number
  notes: string[]
}

function fileSizeSafe(target: string): number {
  try {
    return statSync(target).size
  } catch {
    return 0
  }
}

/** runtime.json 的结构（旧版本没有 api 字段 → 视为 legacy） */
interface RuntimeRecord {
  api?: string
  version?: string
  platform?: string
  archive?: string
  sha256?: string
  files?: number
  installedAt?: string
}

function readRuntimeRecord(root: string): RuntimeRecord | null {
  try {
    return JSON.parse(readFileSync(path.join(root, 'runtime.json'), 'utf8')) as RuntimeRecord
  } catch {
    return null
  }
}

/** 统计 modern 运行时缺哪些文件 / CUDA DLL（按精确 size 判断；sha256 在安装下载时校验） */
function modernRuntimeGaps(
  root: string,
  runtimeFiles: RuntimeFile[] = MODERN_RUNTIME_FILES,
  cudaAssets: CudaRedistAsset[] = CUDA_REDIST_ASSETS,
): { missingFiles: RuntimeFile[]; missingCuda: CudaRedistAsset[] } {
  return {
    missingFiles: runtimeFiles.filter((file) => fileSizeSafe(path.join(root, file.name)) !== file.size),
    missingCuda: cudaAssets.filter((asset) => asset.dllNames.some((name) => !existsSync(path.join(root, name)))),
  }
}

/**
 * 扫描 DriverStore 找 NVIDIA 驱动自带的 nvcudart_hybrid64.dll（不随 CUDA redist 分发）。
 * 取“最近更新”的那份驱动目录；找不到返回 null（安装仅告警，不阻断）。
 */
function findDriverStoreHybridDll(): string | null {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const repository = path.join(systemRoot, 'System32', 'DriverStore', 'FileRepository')
  let names: string[]
  try {
    names = readdirSync(repository)
  } catch {
    return null
  }
  const candidates: { file: string; mtime: number }[] = []
  for (const name of names) {
    if (!/^nv.*\.inf_amd64_/i.test(name)) continue
    const candidate = path.join(repository, name, NVCUDART_HYBRID_DLL)
    if (!existsSync(candidate)) continue
    let mtime = 0
    try {
      mtime = statSync(candidate).mtimeMs
    } catch {
      /* ignore */
    }
    candidates.push({ file: candidate, mtime })
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0]?.file ?? null
}

/** 从 CUDA redist zip 里按 DLL 文件名（前缀匹配 basename）提取并写到运行时根目录 */
function extractCudaDlls(archivePath: string, asset: CudaRedistAsset, root: string, log: (message: string) => void): number {
  const entries = readZipEntries(readFileSync(archivePath))
  let written = 0
  for (const dllName of asset.dllNames) {
    let payload: Buffer | null = null
    for (const [entryName, data] of entries) {
      const baseName = entryName.replace(/\\/g, '/').split('/').pop() ?? ''
      if (baseName.startsWith(dllName)) {
        payload = data
        break
      }
    }
    if (!payload) throw new Error(`CUDA 组件 ${asset.archive} 里找不到 ${dllName}（上游包结构可能已变化）`)
    writeFileSync(path.join(root, dllName), payload)
    written += 1
  }
  log(`已从 ${asset.archive} 提取 ${asset.dllNames.join(' / ')}`)
  return written
}

export interface AdapterPaths {
  dir: string
  downloads: string
}

export function adapterPaths(dataDir: string, adaptersDir?: string): AdapterPaths {
  return {
    dir: adaptersDir || path.join(dataDir, 'adapters'),
    downloads: provisionPaths(dataDir).downloads,
  }
}

export function adapterStatus(options: { dataDir: string; adaptersDir?: string }): AdapterStatus[] {
  const dir = adapterPaths(options.dataDir, options.adaptersDir).dir
  return ADAPTER_ASSETS.map((asset) => {
    const base = path.join(dir, asset.id)
    const config = path.join(base, 'adapter.json')
    const weights = path.join(base, 'adapter_model.safetensors')
    const custom = path.join(base, 'lokr_weights.safetensors')
    const bytes = fileSizeSafe(weights) || fileSizeSafe(custom)
    return {
      id: asset.id,
      name: asset.name,
      style: asset.style,
      license: asset.license,
      installed: existsSync(config) && bytes > 0,
      bytes,
      expectedBytes: asset.size,
    }
  })
}

export function provisionStatus(options: { dataDir: string; platform?: ProvisionPlatform }): ProvisionStatus {
  const platform = options.platform ?? resolvePlatform()
  const paths = provisionPaths(options.dataDir)
  const binary = findRuntimeBinary(paths.root, platform)
  const runtimeSize = binary ? fileSizeSafe(binary) : 0
  const record = readRuntimeRecord(paths.root)
  const planApi = runtimeApiForPlatform(platform)
  /** 已装记录的 api（旧 runtime.json 没有 api 字段 → legacy） */
  const installedApi: RuntimeApi = record?.api === 'modern' ? 'modern' : 'legacy'
  const api: RuntimeApi = binary ? installedApi : planApi
  /**
   * 对外展示版本（P10 / branding）：内部打包名（acestep.cpp-20261106、归档名）不暴露给用户。
   * 已是语义化版本号（旧版 installer 写过的数字版本）就直接展示，否则统一展示 ENGINE_RUNTIME_VERSION。
   */
  const rawVersion = record?.version
  const displayVersion = rawVersion && /^\d+(\.\d+){1,3}$/.test(rawVersion) ? rawVersion : ENGINE_RUNTIME_VERSION
  const version = platform === 'win32-x64' ? ENGINE_RUNTIME_VERSION : rawVersion ? displayVersion : undefined
  const gaps = platform === 'win32-x64' ? modernRuntimeGaps(paths.root) : { missingFiles: [], missingCuda: [] }
  const runtimeInstalled =
    platform === 'win32-x64'
      ? Boolean(binary) &&
        installedApi === 'modern' &&
        record?.version === RUNTIME_VERSION &&
        gaps.missingFiles.length === 0 &&
        gaps.missingCuda.length === 0
      : Boolean(binary)
  const runtimeMissingBytes =
    platform === 'win32-x64'
      ? gaps.missingFiles.reduce((sum, file) => sum + file.size, 0) + gaps.missingCuda.reduce((sum, asset) => sum + asset.size, 0)
      : binary
        ? 0
        : RUNTIME_ASSETS[platform].size
  const models: ModelStatus[] = MODEL_FILES.map((file) => {
    const target = path.join(paths.models, file.name)
    const sizeBytes = fileSizeSafe(target)
    return {
      name: file.name,
      displayName: modelDisplayName(file.name),
      installed: sizeBytes === file.size,
      sizeBytes,
      expectedBytes: file.size,
      profiles: file.profiles,
    }
  })
  const adapters = adapterStatus({ dataDir: options.dataDir })
  const installedByName = new Map(models.map((model) => [model.name, model.installed]))
  const satisfied = (profile: ProvisionProfile): boolean => {
    if (!binary) return false
    return modelsForProfiles([profile]).every((file) => installedByName.get(file.name) === true)
  }
  const essential = satisfied('essential')
  const profiles: Record<ProvisionProfile, boolean> = {
    essential,
    quality: satisfied('quality'),
    stems: satisfied('stems'),
    xl: satisfied('xl'),
  }
  const notes: string[] = []
  if (!binary) {
    notes.push(
      platform === 'win32-x64'
        ? '运行时未安装：需要下载现代运行时（24 个文件 + NVIDIA CUDA 13 组件，约 600MB）'
        : '运行时未安装：需要下载 AI 音频生成引擎运行时（约 2–135MB，视平台）',
    )
  } else if (platform === 'win32-x64' && api !== 'modern') {
    notes.push(`检测到旧版运行时：Windows 上将自动升级为现代运行时（${ENGINE_RUNTIME_VERSION}，支持增强版模型）`)
  } else if (platform === 'win32-x64' && !runtimeInstalled) {
    notes.push('现代运行时文件不完整：再次安装会自动补齐缺失文件')
  } else if (platform === 'win32-x64') {
    notes.push(`现代运行时已就绪（${ENGINE_RUNTIME_VERSION}）`)
  }
  const missingModels = models.filter((model) => !model.installed)
  if (missingModels.length > 0) {
    notes.push(`模型缺 ${missingModels.length} 个，共约 ${(missingModels.reduce((sum, model) => sum + model.expectedBytes, 0) / 1e9).toFixed(1)}GB`)
  }
  if (binary && essential) notes.push('基础能力已就绪（快速生成模式可直接使用）')
  if (profiles.xl) notes.push('增强版模型已就绪（需 ≥12GB 显存，仅现代运行时支持）')
  const missingAdapters = adapters.filter((adapter) => !adapter.installed)
  if (missingAdapters.length > 0) {
    notes.push(`风格适配器缺 ${missingAdapters.length} 个（共 ${(adaptersTotalBytes() / 1e6).toFixed(0)}MB，自生成数据、可安全分发）`)
  } else {
    notes.push('风格适配器已就绪（jrpg_v1 / jrpg_v2 / jrock_v1）')
  }
  return {
    platform,
    supported: true,
    root: paths.root,
    runtime: { installed: runtimeInstalled, path: binary, sizeBytes: runtimeSize, api, version },
    models,
    adapters,
    profiles,
    missingBytes:
      runtimeMissingBytes +
      missingModels.reduce((sum, model) => sum + model.expectedBytes, 0) +
      missingAdapters.reduce((sum, adapter) => sum + adapter.expectedBytes, 0),
    notes,
  }
}

export interface InstallRuntimeOptions {
  dataDir: string
  platform?: ProvisionPlatform
  signal?: AbortSignal
  onProgress?: (progress: number, message: string) => void
  force?: boolean
  fetchImpl?: typeof fetch
  log?: (message: string) => void
  /** 诊断/离线验证用：注入自定义 modern 下载计划（默认用清单里的完整 24 个文件） */
  runtimeFiles?: RuntimeFile[]
  /** 诊断/离线验证用：注入自定义 CUDA redist 计划（默认用清单里的 2 个 zip） */
  cudaAssets?: CudaRedistAsset[]
  /** 诊断/离线验证用：指定 nvcudart_hybrid64.dll 源文件（默认自动扫描 DriverStore） */
  hybridDllPath?: string
  /** 下载加速配置（P10）：不传 = 官方直连 + 单连接（与 P9 行为一致） */
  download?: Partial<ProvisionDownloadConfig>
}

/**
 * 安装运行时：Windows x64 走 modern 流程（逐文件 + CUDA redist）；
 * Mac/Linux 走 legacy 归档流程。已装 legacy 的 Windows 用户会在这里自动升级。
 */
export async function installRuntime(options: InstallRuntimeOptions): Promise<{ binary: string; cached: boolean }> {
  const platform = options.platform ?? resolvePlatform()
  const paths = provisionPaths(options.dataDir)
  mkdirSync(paths.root, { recursive: true })
  mkdirSync(paths.downloads, { recursive: true })
  mkdirSync(paths.models, { recursive: true })
  if (platform === 'win32-x64') return installModernRuntime(options, platform, paths)
  return installLegacyRuntime(options, platform, paths)
}

/** modern Windows 运行时：逐文件下载（sha256）→ 解出 CUDA DLL → 复制驱动 hybrid DLL → 写 runtime.json */
async function installModernRuntime(
  options: InstallRuntimeOptions,
  platform: ProvisionPlatform,
  paths: ProvisionPaths,
): Promise<{ binary: string; cached: boolean }> {
  const runtimeFiles = options.runtimeFiles ?? MODERN_RUNTIME_FILES
  const cudaAssets = options.cudaAssets ?? CUDA_REDIST_ASSETS
  const download = await createDownloadContext(options)
  const record = readRuntimeRecord(paths.root)
  const existing = findRuntimeBinary(paths.root, platform)
  const gaps = modernRuntimeGaps(paths.root, runtimeFiles, cudaAssets)
  // 已装 modern 且版本一致、文件齐全 → 缓存命中
  const cacheHit =
    !options.force &&
    record?.api === 'modern' &&
    record.version === RUNTIME_VERSION &&
    Boolean(existing) &&
    gaps.missingFiles.length === 0 &&
    gaps.missingCuda.length === 0
  if (cacheHit) {
    options.onProgress?.(1, '运行时已安装，跳过下载')
    return { binary: existing as string, cached: true }
  }

  // 旧版 legacy 安装 / 版本变化 / force → 全部重新下载（downloadFile 会按 sha256 命中缓存，代价可控）
  const refreshAll =
    options.force === true ||
    (record !== null && record.api !== 'modern') ||
    (record?.api === 'modern' && record.version !== RUNTIME_VERSION)
  const filesToFetch = refreshAll ? runtimeFiles : gaps.missingFiles
  const cudaToFetch = refreshAll ? cudaAssets : gaps.missingCuda
  const downloadBytes =
    filesToFetch.reduce((sum, file) => sum + file.size, 0) + cudaToFetch.reduce((sum, asset) => sum + asset.size, 0)
  let doneBytes = 0
  const reportProgress = (received: number, message: string): void => {
    const ratio = downloadBytes > 0 ? doneBytes + received : 0
    options.onProgress?.(downloadBytes > 0 ? (ratio / downloadBytes) * 0.85 : 0, message)
  }

  options.onProgress?.(
    0,
    `准备下载现代运行时（${filesToFetch.length} 个文件${cudaToFetch.length > 0 ? ` + ${cudaToFetch.length} 个 CUDA 组件` : ''}，共 ${(downloadBytes / 1e6).toFixed(0)}MB）`,
  )
  for (const file of filesToFetch) {
    const target = path.join(paths.root, file.name)
    options.log?.(`下载运行时文件：${file.name}（${(file.size / 1e6).toFixed(1)}MB）`)
    await fetchArtifact(
      download,
      { kind: 'runtime', url: modernRuntimeUrl(file), name: file.name, sha256: file.sha256, size: file.size },
      target,
      {
        force: options.force,
        attempts: RUNTIME_DOWNLOAD_ATTEMPTS,
        onProgress: ({ received, speedBps, segments }) => {
          reportProgress(
            received,
            `下载 ${file.name}（${(received / 1e6).toFixed(1)}/${(file.size / 1e6).toFixed(1)}MB${speedText(speedBps)}${etaText(speedBps, Math.max(0, file.size - received), segments)}）`,
          )
        },
      },
    )
    doneBytes += file.size
    options.onProgress?.(
      downloadBytes > 0 ? (doneBytes / downloadBytes) * 0.85 : 0,
      `${file.name} 就绪（${filesToFetch.length} 个文件中的第 ${filesToFetch.indexOf(file) + 1} 个）`,
    )
  }
  for (const asset of cudaToFetch) {
    const archivePath = path.join(paths.downloads, asset.archive)
    options.log?.(`下载 CUDA 组件：${asset.archive}（${(asset.size / 1e6).toFixed(0)}MB）`)
    await fetchArtifact(
      download,
      { kind: 'cuda', url: asset.url, name: asset.archive, sha256: asset.sha256, size: asset.size },
      archivePath,
      {
        force: options.force,
        attempts: RUNTIME_DOWNLOAD_ATTEMPTS,
        onProgress: ({ received, speedBps, segments }) => {
          reportProgress(
            received,
            `下载 CUDA 组件 ${asset.archive}（${(received / 1e6).toFixed(0)}/${(asset.size / 1e6).toFixed(0)}MB${speedText(speedBps)}${etaText(speedBps, Math.max(0, asset.size - received), segments)}）`,
          )
        },
      },
    )
    doneBytes += asset.size
    options.onProgress?.(downloadBytes > 0 ? (doneBytes / downloadBytes) * 0.85 : 0, `${asset.archive} 就绪`)
  }

  // CUDA zip 已下载（或命中缓存）后，按 DLL 缺失情况解压到运行时根目录
  const cudaToExtract = cudaAssets.filter((asset) => asset.dllNames.some((name) => !existsSync(path.join(paths.root, name))))
  let extracted = 0
  for (let index = 0; index < cudaToExtract.length; index++) {
    const asset = cudaToExtract[index]
    options.onProgress?.(0.85 + 0.05 * (index / Math.max(1, cudaToExtract.length)), `解压 CUDA 组件：${asset.archive}…`)
    extracted += extractCudaDlls(path.join(paths.downloads, asset.archive), asset, paths.root, options.log ?? (() => {}))
  }

  // 复制 NVIDIA 驱动自带的 hybrid CUDA runtime（redist 里没有；缺失仅告警）
  options.onProgress?.(0.92, '检查 NVIDIA 驱动组件…')
  let hybridCopied = false
  const hybridSource = options.hybridDllPath ?? findDriverStoreHybridDll()
  if (hybridSource) {
    try {
      copyFileSync(hybridSource, path.join(paths.root, NVCUDART_HYBRID_DLL))
      hybridCopied = true
      options.log?.(`已复制驱动组件 ${NVCUDART_HYBRID_DLL}`)
    } catch (error) {
      options.log?.(
        `警告：复制 ${NVCUDART_HYBRID_DLL} 失败（${error instanceof Error ? error.message : String(error)}）；若模型加载报缺 DLL，请更新 NVIDIA 驱动`,
      )
    }
  } else {
    options.log?.(
      `警告：DriverStore 里没找到 ${NVCUDART_HYBRID_DLL}（NVIDIA 驱动缺失或过旧）；若模型加载报缺 DLL，请更新显卡驱动`,
    )
  }

  options.onProgress?.(0.96, '写入运行时清单…')
  // files 统计：运行时文件 + 从 CUDA zip 取出的 DLL + 复制的驱动 DLL
  const filesWritten = runtimeFiles.length + extracted + (hybridCopied ? 1 : 0)
  writeFileSync(
    path.join(paths.root, 'runtime.json'),
    JSON.stringify(
      {
        api: 'modern',
        version: RUNTIME_VERSION,
        platform,
        files: filesWritten,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  )
  const binary = findRuntimeBinary(paths.root, platform)
  if (!binary) throw new Error('运行时文件已下载，但没找到 ace-server.exe；请检查数据目录权限或文件是否被安全软件拦截')
  options.onProgress?.(1, `运行时已安装：${path.relative(paths.root, binary)}`)
  return { binary, cached: false }
}

/** legacy 运行时（Mac/Linux）：沿用官方 v0.1.0 归档（zip / tar.gz）解压 */
async function installLegacyRuntime(
  options: InstallRuntimeOptions,
  platform: ProvisionPlatform,
  paths: ProvisionPaths,
): Promise<{ binary: string; cached: boolean }> {
  const asset = RUNTIME_ASSETS[platform]
  const existing = findRuntimeBinary(paths.root, platform)
  if (existing && !options.force) {
    options.onProgress?.(1, '运行时已安装，跳过下载')
    return { binary: existing, cached: true }
  }

  const archivePath = path.join(paths.downloads, asset.archive)
  const download = await createDownloadContext(options)
  options.log?.(`下载 AI 音频生成引擎运行时：${asset.archive}（${(asset.size / 1e6).toFixed(0)}MB）`)
  await fetchArtifact(
    download,
    { kind: 'runtime-archive', url: runtimeUrl(platform), name: asset.archive, sha256: asset.sha256, size: asset.size },
    archivePath,
    {
      force: options.force,
      attempts: RUNTIME_DOWNLOAD_ATTEMPTS,
      onProgress: ({ received, total, speedBps, segments }) => {
        const ratio = total > 0 ? received / total : 0
        options.onProgress?.(
          ratio * 0.7,
          `下载运行时 ${(received / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)}MB${speedText(speedBps)}${etaText(speedBps, Math.max(0, total - received), segments)}`,
        )
      },
    },
  )

  options.onProgress?.(0.75, '解压运行时…')
  let written = 0
  let symlinks = 0
  if (asset.format === 'zip') {
    const entries = readZipEntries(readFileSync(archivePath))
    for (const [name, data] of entries) {
      const safeName = safeArchivePath(name)
      if (!safeName) continue
      const target = path.join(paths.root, safeName)
      if (!target.startsWith(paths.root)) continue
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, data)
      written += 1
    }
  } else {
    // macOS/Linux 运行时包内有相对软链（dylib/so），必须按软链落盘，否则 dyld 找不到库
    const extracted = extractTarGzToDir(readFileSync(archivePath), paths.root, { log: options.log })
    written = extracted.files
    symlinks = extracted.symlinks + extracted.copies
  }
  if (platform !== 'win32-x64') {
    for (const name of RUNTIME_EXECUTABLES) {
      const candidate = path.join(paths.root, name)
      if (existsSync(candidate)) {
        try {
          chmodSync(candidate, 0o755)
        } catch {
          /* ignore */
        }
      }
    }
  }
  writeFileSync(
    path.join(paths.root, 'runtime.json'),
    JSON.stringify(
      {
        api: 'legacy',
        platform,
        version: ENGINE_RUNTIME_VERSION,
        archive: asset.archive,
        sha256: asset.sha256,
        files: written,
        symlinks,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  )
  const binary = findRuntimeBinary(paths.root, platform)
  if (!binary) throw new Error(`解压完成但找不到可执行文件（${asset.archive}）；请检查平台包结构`)
  options.onProgress?.(1, `运行时已安装：${path.relative(paths.root, binary)}`)
  return { binary, cached: false }
}

export interface InstallModelsOptions {
  dataDir: string
  profiles: ProvisionProfile[]
  platform?: ProvisionPlatform
  signal?: AbortSignal
  onProgress?: (progress: number, message: string) => void
  fetchImpl?: typeof fetch
  log?: (message: string) => void
  /** 下载加速配置（P10）：不传 = 官方直连 + 单连接 */
  download?: Partial<ProvisionDownloadConfig>
  /** 诊断/离线验证用：注入自定义模型下载计划（默认按 profile 从清单取） */
  models?: ModelFile[]
  /** 诊断/离线验证用：覆盖模型下载基础 URL（默认 HuggingFace） */
  modelBaseUrl?: string
}

export async function installModels(options: InstallModelsOptions): Promise<{ installed: number; cached: number; bytes: number }> {
  const platform = options.platform ?? resolvePlatform()
  void platform
  const paths = provisionPaths(options.dataDir)
  mkdirSync(paths.models, { recursive: true })
  mkdirSync(paths.downloads, { recursive: true })
  const download = await createDownloadContext(options)
  const files = options.models ?? modelsForProfiles(options.profiles)
  const sourceOf = (file: ModelFile): string =>
    options.modelBaseUrl ? `${options.modelBaseUrl.replace(/\/+$/, '')}/${file.path}` : modelUrl(file)
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  let doneBytes = 0
  let installed = 0
  let cached = 0
  for (const file of files) {
    const target = path.join(paths.models, file.name)
    const status = await fetchArtifact(
      download,
      { kind: 'model', url: sourceOf(file), name: file.name, sha256: file.sha256, size: file.size },
      target,
      {
        attempts: MODEL_DOWNLOAD_ATTEMPTS,
        onProgress: ({ received, speedBps, segments }) => {
          const ratio = totalBytes > 0 ? (doneBytes + received) / totalBytes : 0
          options.onProgress?.(
            ratio,
            `下载 ${file.name}（${((doneBytes + received) / 1e9).toFixed(2)}/${(totalBytes / 1e9).toFixed(2)}GB${speedText(speedBps)}${etaText(speedBps, Math.max(0, totalBytes - doneBytes - received), segments)}）`,
          )
        },
      },
    )
    if (status !== 'cached') installed += 1
    else cached += 1
    doneBytes += file.size
    options.onProgress?.(totalBytes > 0 ? doneBytes / totalBytes : 1, `${file.name} 就绪`)
  }
  return { installed, cached, bytes: doneBytes }
}

export interface InstallAdaptersOptions {
  dataDir: string
  adaptersDir?: string
  ids?: string[]
  signal?: AbortSignal
  onProgress?: (progress: number, message: string) => void
  fetchImpl?: typeof fetch
  log?: (message: string) => void
  /** 下载加速配置（P10）：不传 = 官方直连 + 单连接 */
  download?: Partial<ProvisionDownloadConfig>
}

/**
 * 下载并安装 LoRA 适配器（tar.gz → data/adapters/<id>/）。
 * 只允许清单里的自生成适配器；真实数据内部研究版不在清单中，传错 id 直接报错。
 */
export async function installAdapters(options: InstallAdaptersOptions): Promise<{ installed: number; cached: number }> {
  const selected = options.ids && options.ids.length > 0 ? options.ids : ADAPTER_ASSETS.map((asset) => asset.id)
  const unknown = selected.filter((id) => !ADAPTER_ASSETS.some((asset) => asset.id === id))
  if (unknown.length > 0) throw new Error(`不认识的适配器：${unknown.join(', ')}（可用：${ADAPTER_ASSETS.map((a) => a.id).join(' / ')}）`)
  const assets = ADAPTER_ASSETS.filter((asset) => selected.includes(asset.id))
  const paths = adapterPaths(options.dataDir, options.adaptersDir)
  mkdirSync(paths.dir, { recursive: true })
  mkdirSync(paths.downloads, { recursive: true })
  const download = await createDownloadContext(options)
  const totalBytes = assets.reduce((sum, asset) => sum + asset.size, 0)
  let doneBytes = 0
  let installed = 0
  let cached = 0
  for (const asset of assets) {
    const archivePath = path.join(paths.downloads, asset.file)
    const result = await fetchArtifact(
      download,
      { kind: 'adapter', url: adapterUrl(asset), name: asset.file, sha256: asset.sha256, size: asset.size },
      archivePath,
      {
        attempts: ADAPTER_DOWNLOAD_ATTEMPTS,
        onProgress: ({ received, speedBps, segments }) => {
          const ratio = totalBytes > 0 ? (doneBytes + received) / totalBytes : 0
          options.onProgress?.(
            ratio,
            `下载适配器 ${asset.id}（${((doneBytes + received) / 1e6).toFixed(1)}/${(totalBytes / 1e6).toFixed(1)}MB${speedText(speedBps)}${etaText(speedBps, Math.max(0, totalBytes - doneBytes - received), segments)}）`,
          )
        },
      },
    )
    extractTarGzToDir(readFileSync(archivePath), paths.dir, { log: options.log })
    const status = adapterStatus({ dataDir: options.dataDir, adaptersDir: options.adaptersDir }).find((item) => item.id === asset.id)
    if (!status?.installed) throw new Error(`适配器解压后未找到文件：${asset.id}`)
    if (result !== 'cached') installed += 1
    else cached += 1
    doneBytes += asset.size
    options.onProgress?.(totalBytes > 0 ? doneBytes / totalBytes : 1, `适配器 ${asset.id} 就绪`)
  }
  return { installed, cached }
}

/* ------------------------------------------------------------------ */
/* 安装任务（内存态，带进度；同一时刻只跑一个）                          */
/* ------------------------------------------------------------------ */

export type ProvisionJobStep = {
  key: string
  label: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  progress: number
  bytes?: number
  totalBytes?: number
  message?: string
}

export interface ProvisionJob {
  id: string
  status: 'running' | 'done' | 'failed' | 'canceled'
  profiles: ProvisionProfile[]
  steps: ProvisionJobStep[]
  progress: number
  startedAt: number
  updatedAt: number
  error?: string
}

const jobs = new Map<string, ProvisionJob>()
let activeJobId: string | null = null
let activeAbort: AbortController | null = null

/** 压缩错误文本为面板可展示的一行摘要（严格 ≤ max 字符，含省略号） */
function summarizeError(text: string, max: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= max) return compact
  return `${compact.slice(0, Math.max(0, max - 1))}…`
}

function updateJob(id: string, patch: Partial<ProvisionJob>): void {
  const job = jobs.get(id)
  if (!job) return
  Object.assign(job, patch, { updatedAt: Date.now() })
  const stepsTotal = job.steps.length
  if (stepsTotal > 0) {
    const sum = job.steps.reduce((total, step) => {
      if (step.status === 'done' || step.status === 'skipped') return total + 1
      if (step.status === 'running') return total + Math.max(0, Math.min(1, step.progress))
      return total
    }, 0)
    job.progress = Math.round((sum / stepsTotal) * 1000) / 1000
  }
  schedulePersistJobs()
}

export function getProvisionJob(id: string): ProvisionJob | null {
  return jobs.get(id) ?? null
}

export function listProvisionJobs(): ProvisionJob[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt)
}

export function cancelProvisionJob(id: string): boolean {
  if (id !== activeJobId || !activeAbort) return false
  activeAbort.abort()
  return true
}

/** 当前正在运行的安装任务（前端再次点下载 / 重开面板时用它接管） */
export function getActiveProvisionJob(): ProvisionJob | null {
  if (!activeJobId) return null
  const job = jobs.get(activeJobId)
  return job && job.status === 'running' ? job : null
}

/* ------------------------------------------------------------------ */
/* 任务持久化：服务端重启 / 页面刷新后仍能看到最近任务                   */
/* ------------------------------------------------------------------ */

const MAX_PERSISTED_JOBS = 10
let persistDataDir: string | null = null
let persistTimer: ReturnType<typeof setTimeout> | null = null

function jobsRecordPath(dataDir: string): string {
  return path.join(dataDir, 'logs', 'provision-jobs.json')
}

function persistJobsNow(): void {
  if (!persistDataDir) return
  persistTimer = null
  try {
    const target = jobsRecordPath(persistDataDir)
    mkdirSync(path.dirname(target), { recursive: true })
    const records = listProvisionJobs().slice(0, MAX_PERSISTED_JOBS)
    writeFileSync(target, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), jobs: records }, null, 2), 'utf8')
  } catch {
    /* 持久化失败不影响安装 */
  }
}

function schedulePersistJobs(): void {
  if (!persistDataDir || persistTimer) return
  persistTimer = setTimeout(() => persistJobsNow(), 800)
  persistTimer.unref?.()
}

/**
 * 启动时恢复最近安装任务（用于服务端重启后前端仍能看到结果 / 断点续传提示）。
 * 上次进程里 running 的任务已随进程终止，这里标记为 failed 并提示重新下载会续传。
 * 返回恢复的任务数；已有内存任务时不再覆盖。
 */
export function restoreProvisionJobs(dataDir: string): number {
  persistDataDir = dataDir
  if (jobs.size > 0) return 0
  try {
    const raw = JSON.parse(readFileSync(jobsRecordPath(dataDir), 'utf8')) as { version?: number; jobs?: unknown }
    if (raw?.version !== 1 || !Array.isArray(raw.jobs)) return 0
    let restored = 0
    let changed = false
    for (const item of raw.jobs) {
      const job = item as ProvisionJob
      if (!job || typeof job.id !== 'string' || !Array.isArray(job.steps)) continue
      const copy: ProvisionJob = { ...job, steps: job.steps.map((step) => ({ ...step })) }
      if (copy.status === 'running') {
        copy.status = 'failed'
        copy.error = '服务端已重启，任务已中断；重新点击「开始下载」会从断点续传，无需重下已完成部分'
        copy.steps = copy.steps.map((step) =>
          step.status === 'running' ? { ...step, status: 'failed', message: '服务端重启，任务中断（可重新下载续传）' } : step,
        )
        changed = true
      }
      jobs.set(copy.id, copy)
      restored += 1
    }
    if (changed) schedulePersistJobs()
    return restored
  } catch {
    return 0
  }
}

export interface StartProvisionOptions {
  dataDir: string
  profiles: ProvisionProfile[]
  platform?: ProvisionPlatform
  force?: boolean
  /** 是否安装 LoRA 适配器（默认 true；P8-B） */
  adapters?: boolean
  /** 指定适配器 id（默认清单全部） */
  adapterIds?: string[]
  /** 下载加速配置（P10）：路由从 settings 解析后传入；不传 = 官方直连 + 单连接 */
  download?: Partial<ProvisionDownloadConfig>
}

/** 启动安装任务（异步执行；返回立即返回 job）。 */
export function startProvision(options: StartProvisionOptions): ProvisionJob {
  persistDataDir = options.dataDir
  if (activeJobId) {
    const running = jobs.get(activeJobId)
    if (running && running.status === 'running') throw new Error('已有安装任务在进行中，请等待完成或先取消')
  }
  const platform = options.platform ?? resolvePlatform()
  const paths = provisionPaths(options.dataDir)
  const status = provisionStatus({ dataDir: options.dataDir, platform })
  const id = `prov_${Date.now().toString(36)}`
  const steps: ProvisionJobStep[] = []
  if (!status.runtime.installed || options.force) {
    steps.push({
      key: 'runtime',
      label: platform === 'win32-x64' ? 'AI 音频生成引擎运行时（含 CUDA 13 组件）' : 'AI 音频生成引擎运行时',
      status: 'pending',
      progress: 0,
      totalBytes: runtimePlanBytes(platform),
    })
  }
  for (const file of modelsForProfiles(options.profiles)) {
    const target = path.join(paths.models, file.name)
    const installed = existsSync(target) && fileSizeSafe(target) === file.size
    if (!installed || options.force) {
      steps.push({ key: `model:${file.name}`, label: modelDisplayName(file.name), status: 'pending', progress: 0, totalBytes: file.size })
    }
  }
  const wantAdapters = options.adapters !== false
  const adapterIds = options.adapterIds && options.adapterIds.length > 0 ? options.adapterIds : ADAPTER_ASSETS.map((asset) => asset.id)
  const missingAdapters = adapterStatus({ dataDir: options.dataDir }).filter(
    (adapter) => adapterIds.includes(adapter.id) && (!adapter.installed || options.force),
  )
  if (wantAdapters && missingAdapters.length > 0) {
    steps.push({
      key: 'adapters',
      label: `风格适配器（${missingAdapters.map((adapter) => adapter.id).join(', ')}）`,
      status: 'pending',
      progress: 0,
      totalBytes: missingAdapters.reduce((sum, adapter) => sum + adapter.expectedBytes, 0),
    })
  }
  const job: ProvisionJob = {
    id,
    status: 'running',
    profiles: options.profiles,
    steps,
    progress: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }
  jobs.set(id, job)
  activeJobId = id
  activeAbort = new AbortController()
  if (steps.length === 0) {
    updateJob(id, { status: 'done', progress: 1 })
    activeJobId = null
    activeAbort = null
    return job
  }

  const run = async (): Promise<void> => {
    const signal = activeAbort?.signal
    try {
      let stepIndex = 0
      for (const step of steps) {
        const current = jobs.get(id)
        if (!current || current.status === 'canceled') throw new Error('任务已取消')
        updateJob(id, { steps: current.steps.map((item) => (item.key === step.key ? { ...item, status: 'running', progress: 0 } : item)) })
        if (step.key === 'runtime') {
          await installRuntime({
            dataDir: options.dataDir,
            platform,
            signal,
            force: options.force,
            download: options.download,
            onProgress: (progress, message) => {
              const jobNow = jobs.get(id)
              if (!jobNow) return
              updateJob(id, {
                steps: jobNow.steps.map((item) => (item.key === step.key ? { ...item, progress, message } : item)),
              })
            },
            log: (message) => {
              const jobNow = jobs.get(id)
              if (!jobNow) return
              updateJob(id, { steps: jobNow.steps.map((item) => (item.key === step.key ? { ...item, message } : item)) })
            },
          })
        } else if (step.key === 'adapters') {
          await installAdapters({
            dataDir: options.dataDir,
            ids: adapterIds,
            signal,
            download: options.download,
            onProgress: (progress, message) => {
              const jobNow = jobs.get(id)
              if (!jobNow) return
              updateJob(id, { steps: jobNow.steps.map((item) => (item.key === step.key ? { ...item, progress, message } : item)) })
            },
            log: (message) => {
              const jobNow = jobs.get(id)
              if (!jobNow) return
              updateJob(id, { steps: jobNow.steps.map((item) => (item.key === step.key ? { ...item, message } : item)) })
            },
          })
        } else {
          const fileName = step.key.replace(/^model:/, '')
          const file = MODEL_FILES.find((item) => item.name === fileName)
          if (!file) throw new Error(`未知模型：${fileName}`)
          const modelDownload = await createDownloadContext({
            dataDir: options.dataDir,
            download: options.download,
            signal,
            log: (message) => {
              const jobNow = jobs.get(id)
              if (!jobNow) return
              updateJob(id, { steps: jobNow.steps.map((item) => (item.key === step.key ? { ...item, message } : item)) })
            },
          })
          await fetchArtifact(
            modelDownload,
            { kind: 'model', url: modelUrl(file), name: file.name, sha256: file.sha256, size: file.size },
            path.join(paths.models, file.name),
            {
              attempts: MODEL_DOWNLOAD_ATTEMPTS,
              // 把重试日志写进步骤消息：网络抖动时面板能看到「第 n/8 次尝试」，而不是只报最后一句失败
              log: (message) => {
                const jobNow = jobs.get(id)
                if (!jobNow) return
                updateJob(id, { steps: jobNow.steps.map((item) => (item.key === step.key ? { ...item, message } : item)) })
              },
              onProgress: ({ received, total, speedBps, attempt, segments }) => {
                const jobNow = jobs.get(id)
                if (!jobNow) return
                const attemptNote = attempt && attempt > 1 ? ` · 第 ${attempt}/${MODEL_DOWNLOAD_ATTEMPTS} 次尝试` : ''
                updateJob(id, {
                  steps: jobNow.steps.map((item) =>
                    item.key === step.key
                      ? {
                          ...item,
                          progress: total > 0 ? received / total : 0,
                          bytes: received,
                          message: `${(received / 1e9).toFixed(2)}GB${speedText(speedBps)}${etaText(speedBps, Math.max(0, total - received), segments)}${attemptNote}`,
                        }
                      : item,
                  ),
                })
              },
            },
          )
        }
        const finished = jobs.get(id)
        if (!finished) return
        updateJob(id, { steps: finished.steps.map((item) => (item.key === step.key ? { ...item, status: 'done', progress: 1 } : item)) })
        stepIndex += 1
      }
      updateJob(id, { status: 'done', progress: 1 })
    } catch (error) {
      const aborted = signal?.aborted
      const message = aborted ? '已取消' : error instanceof Error ? error.message : String(error)
      const summary = summarizeError(message, 160)
      // 失败步骤逐行展示摘要，job.error 保留完整错误（≤400 字符）方便排查
      let summaryWritten = false
      const steps = (jobs.get(id)?.steps ?? []).map((item) => {
        if (item.status !== 'running') return item
        const next: ProvisionJobStep = { ...item, status: 'failed' }
        if (!summaryWritten) {
          next.message = summary
          summaryWritten = true
        }
        return next
      })
      updateJob(id, {
        status: aborted ? 'canceled' : 'failed',
        error: summarizeError(message, 400),
        steps,
      })
    } finally {
      if (activeJobId === id) {
        activeJobId = null
        activeAbort = null
      }
    }
  }
  void run()
  return job
}