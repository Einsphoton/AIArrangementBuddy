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
  DOWNLOAD_CACHE_DIR,
  MODEL_FILES,
  PROVISION_DIR_NAME,
  RUNTIME_ASSETS,
  RUNTIME_BINARIES,
  RUNTIME_EXECUTABLES,
  modelUrl,
  modelsForProfiles,
  resolvePlatform,
  runtimeUrl,
  type ModelFile,
  type ProvisionPlatform,
  type ProvisionProfile,
} from './manifest.js'
import { extractTarGz } from './untar.js'

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
  return {
    platform,
    supported: true,
    root: paths.root,
    runtime: { installed: Boolean(binary), path: binary, sizeBytes: runtimeSize, version },
    models,
    profiles,
    missingBytes:
      (binary ? 0 : RUNTIME_ASSETS[platform].size) +
      missingModels.reduce((sum, model) => sum + model.expectedBytes, 0),
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
  const archiveBuffer = readFileSync(archivePath)
  const entries =
    asset.format === 'zip' ? readZipEntries(archiveBuffer) : extractTarGz(archiveBuffer)
  let written = 0
  for (const [name, data] of entries) {
    const safeName = name.replace(/\\/g, '/').replace(/^\.?\//, '')
    if (!safeName || safeName.startsWith('..') || path.isAbsolute(safeName)) continue
    const target = path.join(paths.root, safeName)
    if (!target.startsWith(paths.root)) continue
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, data)
    written += 1
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
      { platform, version: RUNTIME_ASSETS[platform].archive, archive: asset.archive, sha256: asset.sha256, files: written, installedAt: new Date().toISOString() },
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
      updateJob(id, {
        status: aborted ? 'canceled' : 'failed',
        error: aborted ? '已取消' : error instanceof Error ? error.message : String(error),
        steps: (jobs.get(id)?.steps ?? []).map((item) => (item.status === 'running' ? { ...item, status: 'failed', error: undefined } : item)),
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