/**
 * 本机引擎安装器（P8）：运行时 + 模型 + 任务进度。
 *
 * 目录布局（放在数据目录下，随产品数据一起迁移）：
 *   <dataDir>/ace-step/
 *     ace-server(.exe) / dylibs / tools   ← 运行时（官方 release 解压）
 *     models/*.gguf                        ← 模型（HF 下载，sha256 校验）
 *     .downloads/                          ← 断点续传缓存
 *     runtime.json                         ← 已安装运行时版本记录
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { readZipEntries } from '../sync/zip-read.js'
import { downloadFile } from './downloader.js'
import {
  ADAPTER_ASSETS,
  DOWNLOAD_CACHE_DIR,
  MODEL_FILES,
  PROVISION_DIR_NAME,
  RUNTIME_ASSETS,
  RUNTIME_BINARIES,
  RUNTIME_EXECUTABLES,
  adapterUrl,
  adaptersTotalBytes,
  modelUrl,
  modelsForProfiles,
  resolvePlatform,
  runtimeUrl,
  type ModelFile,
  type ProvisionPlatform,
  type ProvisionProfile,
} from './manifest.js'
import { extractTarGzToDir, safeArchivePath } from './untar.js'

export interface ProvisionPaths {
  root: string
  downloads: string
  models: string
  binary: string
}

export function provisionPaths(dataDir: string): ProvisionPaths {
  const root = path.join(dataDir, PROVISION_DIR_NAME)
  return {
    root,
    downloads: path.join(root, DOWNLOAD_CACHE_DIR),
    models: path.join(root, 'models'),
    binary: '',
  }
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
  installed: boolean
  path: string | null
  sizeBytes: number
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

export interface AdapterPaths {
  dir: string
  downloads: string
}

export function adapterPaths(dataDir: string, adaptersDir?: string): AdapterPaths {
  return {
    dir: adaptersDir || path.join(dataDir, 'adapters'),
    downloads: path.join(dataDir, PROVISION_DIR_NAME, DOWNLOAD_CACHE_DIR),
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
  let version: string | undefined
  try {
    version = (JSON.parse(readFileSync(path.join(paths.root, 'runtime.json'), 'utf8')) as { version?: string }).version
  } catch {
    version = undefined
  }
  const models: ModelStatus[] = MODEL_FILES.map((file) => {
    const target = path.join(paths.models, file.name)
    const sizeBytes = fileSizeSafe(target)
    return {
      name: file.name,
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
  }
  const notes: string[] = []
  if (!binary) notes.push('运行时未安装：需要下载 ACE-Step 可执行文件（约 3–135MB，视平台）')
  const missingModels = models.filter((model) => !model.installed)
  if (missingModels.length > 0) {
    notes.push(`模型缺 ${missingModels.length} 个，共约 ${(missingModels.reduce((sum, model) => sum + model.expectedBytes, 0) / 1e9).toFixed(1)}GB`)
  }
  if (binary && essential) notes.push('基础能力已就绪（快模式可直接生成）')
  const missingAdapters = adapters.filter((adapter) => !adapter.installed)
  if (missingAdapters.length > 0) {
    notes.push(`LoRA 适配器缺 ${missingAdapters.length} 个（共 ${(adaptersTotalBytes() / 1e6).toFixed(0)}MB，自生成数据、可安全分发）`)
  } else {
    notes.push('LoRA 适配器已就绪（jrpg_v1 / jrpg_v2 / jrock_v1）')
  }
  return {
    platform,
    supported: true,
    root: paths.root,
    runtime: { installed: Boolean(binary), path: binary, sizeBytes: runtimeSize, version },
    models,
    adapters,
    profiles,
    missingBytes:
      (binary ? 0 : RUNTIME_ASSETS[platform].size) +
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
}

export async function installRuntime(options: InstallRuntimeOptions): Promise<{ binary: string; cached: boolean }> {
  const platform = options.platform ?? resolvePlatform()
  const asset = RUNTIME_ASSETS[platform]
  const paths = provisionPaths(options.dataDir)
  mkdirSync(paths.root, { recursive: true })
  mkdirSync(paths.downloads, { recursive: true })
  mkdirSync(paths.models, { recursive: true })
  const existing = findRuntimeBinary(paths.root, platform)
  if (existing && !options.force) {
    options.onProgress?.(1, '运行时已安装，跳过下载')
    return { binary: existing, cached: true }
  }

  const archivePath = path.join(paths.downloads, asset.archive)
  options.log?.(`下载 ACE-Step 运行时：${asset.archive}（${(asset.size / 1e6).toFixed(0)}MB）`)
  await downloadFile({
    url: runtimeUrl(platform),
    dest: archivePath,
    sha256: asset.sha256,
    size: asset.size,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    log: options.log,
    onProgress: ({ received, total }) => {
      const ratio = total > 0 ? received / total : 0
      options.onProgress?.(ratio * 0.7, `下载运行时 ${(received / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)}MB`)
    },
  })

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
      { platform, version: RUNTIME_ASSETS[platform].archive, archive: asset.archive, sha256: asset.sha256, files: written, symlinks, installedAt: new Date().toISOString() },
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
}

export async function installModels(options: InstallModelsOptions): Promise<{ installed: number; cached: number; bytes: number }> {
  const platform = options.platform ?? resolvePlatform()
  void platform
  const paths = provisionPaths(options.dataDir)
  mkdirSync(paths.models, { recursive: true })
  mkdirSync(paths.downloads, { recursive: true })
  const files = modelsForProfiles(options.profiles)
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  let doneBytes = 0
  let installed = 0
  let cached = 0
  for (const file of files) {
    const target = path.join(paths.models, file.name)
    const result = await downloadFile({
      url: modelUrl(file),
      dest: target,
      sha256: file.sha256,
      size: file.size,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
      log: options.log,
      onProgress: ({ received }) => {
        const ratio = totalBytes > 0 ? (doneBytes + received) / totalBytes : 0
        options.onProgress?.(
          ratio,
          `下载 ${file.name}（${((doneBytes + received) / 1e9).toFixed(2)}/${(totalBytes / 1e9).toFixed(2)}GB）`,
        )
      },
    })
    if (result.status === 'downloaded') installed += 1
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
  const totalBytes = assets.reduce((sum, asset) => sum + asset.size, 0)
  let doneBytes = 0
  let installed = 0
  let cached = 0
  for (const asset of assets) {
    const archivePath = path.join(paths.downloads, asset.file)
    const result = await downloadFile({
      url: adapterUrl(asset),
      dest: archivePath,
      sha256: asset.sha256,
      size: asset.size,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
      log: options.log,
      onProgress: ({ received }) => {
        const ratio = totalBytes > 0 ? (doneBytes + received) / totalBytes : 0
        options.onProgress?.(ratio, `下载适配器 ${asset.id}（${((doneBytes + received) / 1e6).toFixed(1)}/${(totalBytes / 1e6).toFixed(1)}MB）`)
      },
    })
    extractTarGzToDir(readFileSync(archivePath), paths.dir, { log: options.log })
    const status = adapterStatus({ dataDir: options.dataDir, adaptersDir: options.adaptersDir }).find((item) => item.id === asset.id)
    if (!status?.installed) throw new Error(`适配器解压后未找到文件：${asset.id}`)
    if (result.status === 'downloaded') installed += 1
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

export interface StartProvisionOptions {
  dataDir: string
  profiles: ProvisionProfile[]
  platform?: ProvisionPlatform
  force?: boolean
  /** 是否安装 LoRA 适配器（默认 true；P8-B） */
  adapters?: boolean
  /** 指定适配器 id（默认清单全部） */
  adapterIds?: string[]
}

/** 启动安装任务（异步执行；返回立即返回 job）。 */
export function startProvision(options: StartProvisionOptions): ProvisionJob {
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
    steps.push({ key: 'runtime', label: 'ACE-Step 运行时', status: 'pending', progress: 0, totalBytes: RUNTIME_ASSETS[platform].size })
  }
  for (const file of modelsForProfiles(options.profiles)) {
    const target = path.join(paths.models, file.name)
    const installed = existsSync(target) && fileSizeSafe(target) === file.size
    if (!installed || options.force) {
      steps.push({ key: `model:${file.name}`, label: file.name, status: 'pending', progress: 0, totalBytes: file.size })
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
      label: `LoRA 适配器（${missingAdapters.map((adapter) => adapter.id).join(', ')}）`,
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
          await downloadFile({
            url: modelUrl(file),
            dest: path.join(paths.models, file.name),
            sha256: file.sha256,
            size: file.size,
            signal,
            onProgress: ({ received, total }) => {
              const jobNow = jobs.get(id)
              if (!jobNow) return
              updateJob(id, {
                steps: jobNow.steps.map((item) =>
                  item.key === step.key
                    ? { ...item, progress: total > 0 ? received / total : 0, bytes: received, message: `${(received / 1e9).toFixed(2)}GB` }
                    : item,
                ),
              })
            },
          })
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