/**
 * 服务器离线包（P10-B）：把「运行时 + 模型 + 适配器 + 训练数据」打成一个可随应用分发的目录，
 * 让服务器首装直接使用本地文件（完全离线），并作为 `/api/provision/mirror/*` 的局域网共享镜像源。
 *
 * 目录布局（`buildEnginePackage` 产物）：
 *   <outDir>/engine-package.json                  ← 清单（schema=1）
 *   <outDir>/runtime/<文件名>                       ← Windows modern 运行时 24 个文件
 *   <outDir>/runtime-archive/<legacy 归档名>        ← Mac/Linux legacy 运行时归档
 *   <outDir>/cuda/<CUDA zip 名>                     ← NVIDIA CUDA 13 redist 压缩包
 *   <outDir>/models/<gguf 名>                       ← 模型
 *   <outDir>/adapters/<adapter tar.gz 名>           ← LoRA 适配器归档（下载缓存；缓存丢失时从已解压目录回打）
 *   <outDir>/training/code/<归档名>                 ← 训练代码包
 *   <outDir>/training/python/<归档名>               ← 独立 Python 归档
 *   <outDir>/training/datasets/<归档名>             ← 自生成训练数据集
 *   <outDir>/training/checkpoints/<dest>            ← 基座检查点
 *
 * 关键约定：
 * - 工件 key 规则与 `sources.ts` 的 `artifactKey()` 逐字一致（runtime/、cuda/、runtime-archive/、
 *   model/、adapter/、training/code、training/python、training/dataset/<id>、training/checkpoint/<dest>）；
 * - manifest 里的 size / sha256 一律用 `manifest.ts` / `trainingManifest.ts` 里钉死的值；
 *   唯一例外是 P11 从已解压目录回打的 LoRA 适配器归档（内容由本机实际文件决定，只能用生成文件的
 *   实际 size / sha256）；
 * - 构建时只校验 size（安装目录里的文件在下载阶段已经校验过 sha256，重复哈希几十 GB 代价太高），
 *   但 `copyLocalArtifact` 在「从离线包装到安装目录」时会严格校验 sha256，防止离线包被篡改/损坏；
 * - 训练数据体量大（约 2–6GB），只有显式 `includeTraining=true` 才打包，默认不随包分发。
 */
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { modelDisplayName } from '@aiab/core'
import {
  ADAPTER_ASSETS,
  CUDA_REDIST_ASSETS,
  DOWNLOAD_CACHE_DIR,
  MODEL_FILES,
  MODERN_RUNTIME_FILES,
  PROVISION_DIR_NAME,
  RUNTIME_ASSETS,
  modelsForProfiles,
  resolvePlatform,
  type ProvisionPlatform,
  type ProvisionProfile,
} from './manifest.js'
import {
  TRAINING_CHECKPOINTS,
  TRAINING_CODE,
  TRAINING_DATASETS,
  TRAINING_PYTHON,
  type TrainingPlatform,
} from './trainingManifest.js'
import { createTarGz } from './tarWriter.js'

/** 离线包清单文件名（固定） */
export const ENGINE_PACKAGE_MANIFEST = 'engine-package.json'

/** 清单里单个文件（`file` 是包内相对路径，用 `/` 分隔） */
export interface EnginePackageFile {
  /** 全项目统一的工件 key，如 `runtime/ace-server.exe`、`model/xxx.gguf` */
  key: string
  /** 工件类型：runtime / cuda / runtime-archive / model / adapter / training-* */
  kind: string
  /** 包内相对路径，如 `runtime/ace-server.exe`、`models/xxx.gguf` */
  file: string
  size: number
  /** manifest.ts / trainingManifest.ts 里钉死的哈希 */
  sha256?: string
}

export interface EnginePackageManifest {
  schema: 1
  createdAt: string
  platform?: string
  label?: string
  files: EnginePackageFile[]
}

export interface EnginePackage {
  dir: string
  manifest: EnginePackageManifest
}

/** 本地可用工件（离线包或已安装目录 / 下载缓存） */
export interface LocalArtifact {
  path: string
  size: number
  sha256?: string
  origin: 'package' | 'cache'
}

/** 服务器镜像可提供的文件元信息 */
export interface MirrorFile {
  key: string
  size: number
  sha256?: string
  origin: 'package' | 'cache'
}

export interface CopyLocalArtifactOptions {
  /** 覆盖 artifact.sha256（如调用方从清单拿到的钉死哈希） */
  sha256?: string
  signal?: AbortSignal
  log?: (message: string) => void
  /** 预留：并行拷贝多个大文件时的并发度（由调用方控制，本函数单文件） */
  concurrency?: number
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

function fileSizeSafe(target: string): number {
  try {
    return statSync(target).size
  } catch {
    return 0
  }
}

function statFile(target: string): Stats | null {
  try {
    const stats = statSync(target)
    return stats.isFile() ? stats : null
  } catch {
    return null
  }
}

function normalizeSha(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined
  const digest = value.trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(digest) ? digest : undefined
}

function abortError(): Error {
  const error = new Error('操作已取消')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /aborted|cancell?ed|已取消/i.test(error.message))
}

async function sha256File(target: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(target)) {
    throwIfAborted(signal)
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/** 当前平台的训练资产平台标识（与 trainingManifest.TRAINING_PYTHON 的 key 对齐） */
function currentTrainingPlatform(): TrainingPlatform {
  if (process.platform === 'darwin') return 'darwin-arm64'
  if (process.platform === 'win32') return 'win32-x64'
  return 'linux-x64'
}

/** 包内相对路径规范化：统一成 `/` 分隔，并拒绝绝对路径 / 目录穿越 / 盘符 */
function normalizePackageRelative(relative: string): string | null {
  if (typeof relative !== 'string' || !relative.trim()) return null
  const text = relative.replace(/\\/g, '/')
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text) || text.includes('\0')) return null
  const segments = text.split('/')
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return null
  }
  return segments.join('/')
}

/** 把包内相对路径解析成绝对路径，并保证不逃出包目录 */
function resolvePackagePath(dir: string, relative: string): string | null {
  const normalized = normalizePackageRelative(relative)
  if (!normalized) return null
  const base = path.resolve(dir)
  const target = path.resolve(base, ...normalized.split('/'))
  if (target === base || !target.startsWith(base + path.sep)) return null
  return target
}

/* ------------------------------------------------------------------ */
/* 工件 key 解析（只允许清单里的已知 key，天然防目录穿越）                 */
/* ------------------------------------------------------------------ */

export type EngineArtifactKey =
  | { kind: 'runtime'; name: string }
  | { kind: 'cuda'; name: string }
  | { kind: 'runtime-archive'; name: string }
  | { kind: 'model'; name: string }
  | { kind: 'adapter'; name: string }
  | { kind: 'training-code' }
  | { kind: 'training-python' }
  | { kind: 'training-dataset'; id: string }
  | { kind: 'training-checkpoint'; dest: string }

function isSafeKeySegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('/') &&
    !segment.includes('\\') &&
    !segment.includes('\0') &&
    !segment.includes(':')
  )
}

/**
 * 解析并校验工件 key（与 `sources.ts` 的 `artifactKey()` 对应）。
 * 返回 null 表示 key 非法 / 不在任何清单里 —— 镜像接口据此返回 404，绝不拼接用户输入路径。
 */
export function parseEngineKey(key: string): EngineArtifactKey | null {
  if (typeof key !== 'string' || !key || key.length > 512) return null
  if (key.startsWith('/') || key.includes('\\') || key.includes('\0') || key.includes(':')) return null
  const segments = key.split('/')
  if (segments.length < 2 || !segments.every(isSafeKeySegment)) return null
  const [head, second, ...rest] = segments
  if (head === 'runtime' && segments.length === 2) {
    return MODERN_RUNTIME_FILES.some((file) => file.name === second) ? { kind: 'runtime', name: second } : null
  }
  if (head === 'cuda' && segments.length === 2) {
    return CUDA_REDIST_ASSETS.some((asset) => asset.archive === second) ? { kind: 'cuda', name: second } : null
  }
  if (head === 'runtime-archive' && segments.length === 2) {
    return Object.values(RUNTIME_ASSETS).some((asset) => asset.archive === second)
      ? { kind: 'runtime-archive', name: second }
      : null
  }
  if (head === 'model' && segments.length === 2) {
    return MODEL_FILES.some((file) => file.name === second) ? { kind: 'model', name: second } : null
  }
  if (head === 'adapter' && segments.length === 2) {
    return ADAPTER_ASSETS.some((asset) => asset.file === second) ? { kind: 'adapter', name: second } : null
  }
  if (head === 'training' && second === 'code' && segments.length === 2) return { kind: 'training-code' }
  if (head === 'training' && second === 'python' && segments.length === 2) return { kind: 'training-python' }
  if (head === 'training' && second === 'dataset' && segments.length === 3) {
    return TRAINING_DATASETS.some((dataset) => dataset.id === rest[0])
      ? { kind: 'training-dataset', id: rest[0] as string }
      : null
  }
  if (head === 'training' && second === 'checkpoint' && segments.length >= 3) {
    const dest = rest.join('/')
    return TRAINING_CHECKPOINTS.some((file) => file.dest === dest) ? { kind: 'training-checkpoint', dest } : null
  }
  return null
}

/** 已安装目录 / 下载缓存里某个工件的落盘位置（配合清单里钉死的 size/sha256） */
function cacheArtifact(dataDir: string, parsed: EngineArtifactKey): { path: string; size: number; sha256?: string } | null {
  const root = path.join(dataDir, PROVISION_DIR_NAME)
  const downloads = path.join(root, DOWNLOAD_CACHE_DIR)
  switch (parsed.kind) {
    case 'runtime': {
      const file = MODERN_RUNTIME_FILES.find((item) => item.name === parsed.name)
      return file ? { path: path.join(root, file.name), size: file.size, sha256: file.sha256 } : null
    }
    case 'cuda': {
      const asset = CUDA_REDIST_ASSETS.find((item) => item.archive === parsed.name)
      return asset ? { path: path.join(downloads, asset.archive), size: asset.size, sha256: asset.sha256 } : null
    }
    case 'runtime-archive': {
      const asset = Object.values(RUNTIME_ASSETS).find((item) => item.archive === parsed.name)
      return asset ? { path: path.join(downloads, asset.archive), size: asset.size, sha256: asset.sha256 } : null
    }
    case 'model': {
      const file = MODEL_FILES.find((item) => item.name === parsed.name)
      return file ? { path: path.join(root, 'models', file.name), size: file.size, sha256: file.sha256 } : null
    }
    case 'adapter': {
      const asset = ADAPTER_ASSETS.find((item) => item.file === parsed.name)
      return asset ? { path: path.join(downloads, asset.file), size: asset.size, sha256: asset.sha256 } : null
    }
    case 'training-code':
      return { path: path.join(dataDir, 'training', '.downloads', TRAINING_CODE.file), size: TRAINING_CODE.size, sha256: TRAINING_CODE.sha256 }
    case 'training-python': {
      const asset = TRAINING_PYTHON[currentTrainingPlatform()]
      return { path: path.join(dataDir, 'training', '.downloads', asset.file), size: asset.size, sha256: asset.sha256 }
    }
    case 'training-dataset': {
      const dataset = TRAINING_DATASETS.find((item) => item.id === parsed.id)
      return dataset ? { path: path.join(dataDir, 'training', '.downloads', dataset.file), size: dataset.size, sha256: dataset.sha256 } : null
    }
    case 'training-checkpoint': {
      const file = TRAINING_CHECKPOINTS.find((item) => item.dest === parsed.dest)
      return file
        ? { path: path.join(dataDir, 'training', 'checkpoints', ...file.dest.split('/')), size: file.size, sha256: file.sha256 }
        : null
    }
    default:
      return null
  }
}

/** 已知工件 key 列表（镜像清单枚举缓存用） */
function knownArtifactKeys(includeTraining: boolean): Array<{ key: string; size: number; sha256?: string }> {
  const keys: Array<{ key: string; size: number; sha256?: string }> = []
  for (const file of MODERN_RUNTIME_FILES) keys.push({ key: `runtime/${file.name}`, size: file.size, sha256: file.sha256 })
  for (const asset of CUDA_REDIST_ASSETS) keys.push({ key: `cuda/${asset.archive}`, size: asset.size, sha256: asset.sha256 })
  for (const asset of Object.values(RUNTIME_ASSETS)) keys.push({ key: `runtime-archive/${asset.archive}`, size: asset.size, sha256: asset.sha256 })
  for (const file of MODEL_FILES) keys.push({ key: `model/${file.name}`, size: file.size, sha256: file.sha256 })
  for (const asset of ADAPTER_ASSETS) keys.push({ key: `adapter/${asset.file}`, size: asset.size, sha256: asset.sha256 })
  if (!includeTraining) return keys
  keys.push({ key: 'training/code', size: TRAINING_CODE.size, sha256: TRAINING_CODE.sha256 })
  const python = TRAINING_PYTHON[currentTrainingPlatform()]
  keys.push({ key: 'training/python', size: python.size, sha256: python.sha256 })
  for (const dataset of TRAINING_DATASETS) keys.push({ key: `training/dataset/${dataset.id}`, size: dataset.size, sha256: dataset.sha256 })
  for (const file of TRAINING_CHECKPOINTS) keys.push({ key: `training/checkpoint/${file.dest}`, size: file.size, sha256: file.sha256 })
  return keys
}

function isTrainingKey(key: string): boolean {
  return key.startsWith('training/')
}

/* ------------------------------------------------------------------ */
/* 离线包目录 / 清单读取                                                 */
/* ------------------------------------------------------------------ */

/**
 * 离线包目录：显式 overrideDir > 环境变量 AIAB_ENGINE_PACKAGE_DIR > `<dataDir>/engine-package`。
 * 空字符串视为未配置（与 sources.ts 的优先级保持一致）。
 */
export function enginePackageDir(dataDir: string, overrideDir?: string): string {
  const override = (overrideDir || process.env.AIAB_ENGINE_PACKAGE_DIR || '').trim()
  if (override) return path.resolve(override)
  return path.join(dataDir, 'engine-package')
}

/** 读取离线包清单；目录/清单不存在或损坏时返回 null（安装流程静默回退网络） */
export function readEnginePackage(dataDir: string, overrideDir?: string): EnginePackage | null {
  const dir = enginePackageDir(dataDir, overrideDir)
  let raw: string
  try {
    raw = readFileSync(path.join(dir, ENGINE_PACKAGE_MANIFEST), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<EnginePackageManifest> | null
    if (!parsed || parsed.schema !== 1 || !Array.isArray(parsed.files)) return null
    const files: EnginePackageFile[] = []
    for (const item of parsed.files) {
      if (!item || typeof item.key !== 'string' || typeof item.file !== 'string') continue
      const file = normalizePackageRelative(item.file)
      if (!file) continue
      const size = Number(item.size)
      if (!Number.isFinite(size) || size < 0) continue
      files.push({
        key: item.key,
        kind: typeof item.kind === 'string' && item.kind ? item.kind : 'file',
        file,
        size,
        sha256: normalizeSha(item.sha256),
      })
    }
    return {
      dir,
      manifest: {
        schema: 1,
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date(0).toISOString(),
        platform: typeof parsed.platform === 'string' ? parsed.platform : undefined,
        label: typeof parsed.label === 'string' ? parsed.label : undefined,
        files,
      },
    }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 本地工件查找 / 拷贝                                                   */
/* ------------------------------------------------------------------ */

/**
 * 查找本地可用工件：**离线包优先，已安装目录/下载缓存兜底**。
 * 返回 null 表示本地没有（调用方回退网络）。
 */
export function findLocalArtifact(dataDir: string, key: string, overrideDir?: string): LocalArtifact | null {
  const parsed = parseEngineKey(key)
  if (!parsed) return null
  const pkg = readEnginePackage(dataDir, overrideDir)
  if (pkg) {
    const entry = pkg.manifest.files.find((file) => file.key === key)
    if (entry) {
      const target = resolvePackagePath(pkg.dir, entry.file)
      if (target) {
        const stats = statFile(target)
        if (stats && (entry.size <= 0 || stats.size === entry.size)) {
          return { path: target, size: entry.size || stats.size, sha256: entry.sha256, origin: 'package' }
        }
      }
    }
  }
  const cache = cacheArtifact(dataDir, parsed)
  if (cache) {
    const stats = statFile(cache.path)
    if (stats && (cache.size <= 0 || stats.size === cache.size)) {
      return { path: cache.path, size: cache.size || stats.size, sha256: cache.sha256, origin: 'cache' }
    }
  }
  return null
}

type CopyOutcome = 'linked' | 'copied' | 'existing' | 'failed'

interface CopyArtifactPlan {
  /** 是否校验 sha256（构建离线包时关闭；安装/分发时开启） */
  verifySha: boolean
  sha256?: string
  signal?: AbortSignal
  log?: (message: string) => void
}

/**
 * 拷贝单个工件到 dest：优先硬链接（同盘秒完成）→ 退回复制；
 * 拷贝后校验 size（+ sha256），不符删除 dest 并返回失败。
 */
async function copyArtifact(artifact: LocalArtifact, dest: string, plan: CopyArtifactPlan): Promise<CopyOutcome> {
  throwIfAborted(plan.signal)
  const expectedSize = artifact.size > 0 ? artifact.size : 0
  const expectedSha = plan.verifySha ? normalizeSha(plan.sha256 ?? artifact.sha256) : undefined
  const sourceStats = statFile(artifact.path)
  if (!sourceStats) {
    plan.log?.(`本地工件不存在：${artifact.path}`)
    return 'failed'
  }
  if (expectedSize > 0 && sourceStats.size !== expectedSize) {
    plan.log?.(`本地工件大小不符：${artifact.path}（期望 ${expectedSize}，实际 ${sourceStats.size}）`)
    return 'failed'
  }
  try {
    mkdirSync(path.dirname(dest), { recursive: true })
  } catch {
    return 'failed'
  }
  const existing = statFile(dest)
  if (existing) {
    const sizeOk = expectedSize === 0 || existing.size === expectedSize
    if (sizeOk) {
      if (!expectedSha) return 'existing'
      try {
        if ((await sha256File(dest, plan.signal)) === expectedSha) return 'existing'
      } catch (error) {
        if (isAbortError(error)) {
          throw abortError()
        }
      }
    }
    rmSync(dest, { force: true })
  }

  let outcome: CopyOutcome
  try {
    // 硬链接：同盘（数据目录与离线包目录通常同盘）几乎零成本
    linkSync(artifact.path, dest)
    outcome = 'linked'
  } catch {
    throwIfAborted(plan.signal)
    try {
      await copyFile(artifact.path, dest)
      outcome = 'copied'
    } catch (error) {
      rmSync(dest, { force: true })
      plan.log?.(`复制失败：${artifact.path} → ${dest}（${error instanceof Error ? error.message : String(error)}）`)
      return 'failed'
    }
  }

  try {
    const copied = statFile(dest)
    if (!copied) {
      rmSync(dest, { force: true })
      return 'failed'
    }
    if (expectedSize > 0 && copied.size !== expectedSize) {
      rmSync(dest, { force: true })
      plan.log?.(`拷贝后大小校验失败：${dest}（期望 ${expectedSize}，实际 ${copied.size}）`)
      return 'failed'
    }
    if (expectedSha) {
      const actual = await sha256File(dest, plan.signal)
      if (actual !== expectedSha) {
        rmSync(dest, { force: true })
        plan.log?.(`拷贝后 sha256 校验失败：${path.basename(dest)}（已删除，可回退网络重试）`)
        return 'failed'
      }
    }
  } catch (error) {
    rmSync(dest, { force: true })
    if (isAbortError(error) || plan.signal?.aborted) throw abortError()
    plan.log?.(`校验失败：${error instanceof Error ? error.message : String(error)}`)
    return 'failed'
  }
  return outcome
}

/**
 * 把本地工件（离线包 / 已安装目录）拷贝到 dest，供 installer / training 直接落盘。
 * 优先硬链接 → 复制；默认用 artifact.sha256 校验（可用 opts.sha256 覆盖）。
 * 返回 false 表示本地文件不可用（调用方应回退网络下载）。
 */
export async function copyLocalArtifact(
  artifact: LocalArtifact,
  dest: string,
  opts: CopyLocalArtifactOptions = {},
): Promise<boolean> {
  void opts.concurrency
  try {
    const outcome = await copyArtifact(artifact, dest, {
      verifySha: true,
      sha256: opts.sha256,
      signal: opts.signal,
      log: opts.log,
    })
    return outcome !== 'failed'
  } catch (error) {
    // 取消要向上抛，其余错误按「本地不可用」处理，交给网络回退
    if (isAbortError(error)) throw error
    opts.log?.(`本地拷贝失败：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/* ------------------------------------------------------------------ */
/* 服务器镜像：可服务文件列表 / 单文件解析                                */
/* ------------------------------------------------------------------ */

/**
 * 列出服务器镜像可提供的文件（离线包清单 + 已安装目录/下载缓存）。
 * `training: false` 时不暴露训练数据（体量大，默认不共享）。
 */
export function listMirrorFiles(
  dataDir: string,
  opts: { packageDir?: string; training?: boolean } = {},
): MirrorFile[] {
  const includeTraining = opts.training !== false
  const found = new Map<string, MirrorFile>()
  const pkg = readEnginePackage(dataDir, opts.packageDir)
  if (pkg) {
    for (const file of pkg.manifest.files) {
      if (!includeTraining && isTrainingKey(file.key)) continue
      const target = resolvePackagePath(pkg.dir, file.file)
      if (!target) continue
      const stats = statFile(target)
      if (!stats || (file.size > 0 && stats.size !== file.size)) continue
      found.set(file.key, {
        key: file.key,
        size: file.size || stats.size,
        sha256: file.sha256,
        origin: 'package',
      })
    }
  }
  for (const known of knownArtifactKeys(includeTraining)) {
    if (found.has(known.key)) continue
    const parsed = parseEngineKey(known.key)
    if (!parsed) continue
    const cache = cacheArtifact(dataDir, parsed)
    if (!cache) continue
    const stats = statFile(cache.path)
    if (!stats || (cache.size > 0 && stats.size !== cache.size)) continue
    found.set(known.key, {
      key: known.key,
      size: cache.size || stats.size,
      sha256: cache.sha256,
      origin: 'cache',
    })
  }
  return [...found.values()]
}

/**
 * 解析镜像请求的单个文件：只允许清单里的已知 key（`parseEngineKey` 白名单），
 * 并校验解析后的绝对路径确实位于离线包目录内，杜绝目录穿越。
 */
export function resolveMirrorFile(
  dataDir: string,
  key: string,
  opts: { packageDir?: string } = {},
): { path: string; size: number } | null {
  const parsed = parseEngineKey(key)
  if (!parsed) return null
  const pkg = readEnginePackage(dataDir, opts.packageDir)
  if (pkg) {
    const entry = pkg.manifest.files.find((file) => file.key === key)
    if (entry) {
      const target = resolvePackagePath(pkg.dir, entry.file)
      if (target) {
        const stats = statFile(target)
        if (stats && (entry.size <= 0 || stats.size === entry.size)) return { path: target, size: stats.size }
      }
    }
  }
  const cache = cacheArtifact(dataDir, parsed)
  if (cache) {
    const stats = statFile(cache.path)
    if (stats && (cache.size <= 0 || stats.size === cache.size)) return { path: cache.path, size: stats.size }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* 构建离线包                                                           */
/* ------------------------------------------------------------------ */

export interface BuildEnginePackageOptions {
  dataDir: string
  /** 输出目录；默认 enginePackageDir(dataDir)（含 AIAB_ENGINE_PACKAGE_DIR 环境变量） */
  outDir?: string
  profiles: ProvisionProfile[]
  /** 是否把训练代码/Python/数据集/检查点一起打包（体量大，默认 false） */
  includeTraining?: boolean
  /** 是否打包 LoRA 适配器归档（默认 true） */
  adapters?: boolean
  onProgress?: (progress: number, message: string) => void
  signal?: AbortSignal
  log?: (message: string) => void
}

export interface BuildEnginePackageResult {
  dir: string
  manifest: EnginePackageManifest
  /** 成功打包的文件数 */
  copied: number
  /** 其中硬链接的数量（同盘时几乎为全部） */
  linked: number
  /** 打包的总字节数 */
  bytes: number
  /** 缺失/校验失败被跳过的工件（中文，便于 UI/CLI 展示） */
  warnings: string[]
}

interface BuildCandidate {
  key: string
  kind: string
  /** 包内相对路径（`/` 分隔） */
  file: string
  /** 已安装目录 / 下载缓存里的源文件 */
  source: string
  size: number
  sha256?: string
}

/* ------------------------------------------------------------------ */
/* LoRA 适配器：从已解压目录回打归档（P11）                              */
/* ------------------------------------------------------------------ */

/** 适配器解压安装目录名（installer 把归档解压到 `<dataDir>/adapters/<id>/`） */
const ADAPTERS_DIR_NAME = 'adapters'
/** 回打归档的 staging 临时目录前缀（建在系统临时目录，不污染输出包目录） */
const GENERATED_STAGE_PREFIX = 'aiab-engine-package-stage-'

/** staging 出来的归档（size/sha256 都是生成文件的实际值） */
interface GeneratedArtifact {
  path: string
  size: number
  sha256: string
}

interface AdapterStaging {
  /** key（`adapter/<file>`）→ 生成的归档；构建时替换 `packageCandidates` 里的 adapter 源文件 */
  overrides: Map<string, GeneratedArtifact>
  /** 清理临时目录（幂等、不抛错） */
  cleanup: () => void
}

function emptyStaging(): AdapterStaging {
  return { overrides: new Map(), cleanup: () => {} }
}

function statDirectory(target: string): Stats | null {
  try {
    const stats = statSync(target)
    return stats.isDirectory() ? stats : null
  } catch {
    return null
  }
}

/**
 * 递归列出目录下的普通文件（相对路径用 `/`）；跳过子目录以外的条目（软链/特殊文件）与隐藏的
 * 下载临时文件（`.part` / `.parts.json` 等），并按键名排序保证 tar 输出稳定。
 */
function collectDirectoryFiles(root: string, prefix = ''): Array<{ relative: string; absolute: string }> {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const files: Array<{ relative: string; absolute: string }> = []
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    // 忽略下载中断残留，避免把不完整文件打回归档（离线包是被安装器整包信任并解压的）
    if (entry.name.includes('.part.') || entry.name.endsWith('.parts.json') || entry.name.endsWith('.tmp')) continue
    const absolute = path.join(root, entry.name)
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...collectDirectoryFiles(absolute, relative))
    else if (entry.isFile()) files.push({ relative, absolute })
  }
  return files
}

/**
 * 为「已解压安装但归档缓存丢失」的 LoRA 适配器回打 tar.gz。
 *
 * 真实机器上安装完成后 `.downloads` 里的适配器归档常被清理，只剩 `<dataDir>/adapters/<id>/`
 * （adapter.json + adapter_model.safetensors）。这里在 buildEnginePackage 主循环**之前**先做 staging：
 * 用 `createTarGz` 把 `<id>/` 目录回打成 `adapters/<asset.file>`（包内条目前缀 `<id>/`，与官方归档
 * 布局一致，安装器解压后仍是 `<dataDir>/adapters/<id>/adapter.json`）。
 *
 * 规则（与 task 规格一致）：
 * - 归档缓存存在 → 保持原行为（用缓存归档 + 清单钉死值），**不回打**；
 * - 归档不存在但已解压目录存在 → 回打归档，manifest 用生成文件的实际 size/sha256；
 * - 两者都不存在 → 不处理，交给调用方保持「跳过 + warning」的现有行为；
 * - 回打失败（路径异常/读失败）→ 记日志后跳过，不中断整个构建。
 */
async function stageAdapterArchives(options: {
  dataDir: string
  signal?: AbortSignal
  log?: (message: string) => void
}): Promise<AdapterStaging> {
  const downloads = path.join(options.dataDir, PROVISION_DIR_NAME, DOWNLOAD_CACHE_DIR)
  const adaptersRoot = path.join(options.dataDir, ADAPTERS_DIR_NAME)
  const pending = ADAPTER_ASSETS.filter((asset) => {
    if (statFile(path.join(downloads, asset.file))) return false
    return Boolean(statDirectory(path.join(adaptersRoot, asset.id)))
  })
  if (pending.length === 0) return emptyStaging()

  let stageDir: string | null = null
  const cleanup = (): void => {
    if (!stageDir) return
    try {
      rmSync(stageDir, { recursive: true, force: true })
    } catch {
      /* 临时目录清理失败不影响构建结果 */
    }
    stageDir = null
  }

  const overrides = new Map<string, GeneratedArtifact>()
  for (const asset of pending) {
    throwIfAborted(options.signal)
    const sourceDir = path.join(adaptersRoot, asset.id)
    try {
      const files = collectDirectoryFiles(sourceDir)
      if (files.length === 0) {
        options.log?.('风格适配器目录为空，跳过回打归档')
        continue
      }
      const entries = new Map<string, Buffer>()
      for (const file of files) {
        // 包内条目前缀 `<id>/`（与官方归档一致：安装器解压到 data/adapters 后得到 data/adapters/<id>/）
        entries.set(`${asset.id}/${file.relative}`, readFileSync(file.absolute))
      }
      const archive = createTarGz(entries)
      stageDir ??= mkdtempSync(path.join(tmpdir(), GENERATED_STAGE_PREFIX))
      const target = path.join(stageDir, asset.file)
      writeFileSync(target, archive)
      overrides.set(`adapter/${asset.file}`, {
        path: target,
        size: archive.length,
        sha256: createHash('sha256').update(archive).digest('hex'),
      })
      options.log?.(`风格适配器：已从已解压目录回打归档（${(archive.length / 1e6).toFixed(1)}MB）`)
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) {
        cleanup()
        throw abortError()
      }
      options.log?.(`风格适配器回打归档失败，已跳过（${error instanceof Error ? error.message : String(error)}）`)
    }
  }
  if (overrides.size === 0) cleanup()
  return { overrides, cleanup }
}

function packageCandidates(opts: {
  dataDir: string
  platform: ProvisionPlatform
  profiles: ProvisionProfile[]
  includeTraining: boolean
  adapters: boolean
  /** 回打归档的覆盖项（key = `adapter/<file>`）；未命中时仍用下载缓存 */
  generated?: Map<string, GeneratedArtifact>
}): BuildCandidate[] {
  const { dataDir, platform, profiles, includeTraining, adapters, generated } = opts
  const root = path.join(dataDir, PROVISION_DIR_NAME)
  const downloads = path.join(root, DOWNLOAD_CACHE_DIR)
  const candidates: BuildCandidate[] = []

  // 1) 运行时：Windows modern（逐文件 + CUDA zip）；其它平台 legacy 归档
  if (platform === 'win32-x64') {
    for (const file of MODERN_RUNTIME_FILES) {
      candidates.push({
        key: `runtime/${file.name}`,
        kind: 'runtime',
        file: `runtime/${file.name}`,
        source: path.join(root, file.name),
        size: file.size,
        sha256: file.sha256,
      })
    }
    for (const asset of CUDA_REDIST_ASSETS) {
      candidates.push({
        key: `cuda/${asset.archive}`,
        kind: 'cuda',
        file: `cuda/${asset.archive}`,
        source: path.join(downloads, asset.archive),
        size: asset.size,
        sha256: asset.sha256,
      })
    }
  } else {
    const asset = RUNTIME_ASSETS[platform]
    candidates.push({
      key: `runtime-archive/${asset.archive}`,
      kind: 'runtime-archive',
      file: `runtime-archive/${asset.archive}`,
      source: path.join(downloads, asset.archive),
      size: asset.size,
      sha256: asset.sha256,
    })
  }

  // 2) 模型：按 profile 组合（essential 自动包含）
  for (const file of modelsForProfiles(profiles)) {
    candidates.push({
      key: `model/${file.name}`,
      kind: 'model',
      file: `models/${file.name}`,
      source: path.join(root, 'models', file.name),
      size: file.size,
      sha256: file.sha256,
    })
  }

  // 3) LoRA 适配器归档（安装时解压到 data/adapters/<id>/）：
  //    优先用下载缓存里的归档；缓存丢失时用 buildEnginePackage 提前回打好的归档（size/sha256 用实际值）
  if (adapters) {
    for (const asset of ADAPTER_ASSETS) {
      const key = `adapter/${asset.file}`
      const regenerated = generated?.get(key)
      candidates.push({
        key,
        kind: 'adapter',
        file: `adapters/${asset.file}`,
        source: regenerated?.path ?? path.join(downloads, asset.file),
        size: regenerated?.size ?? asset.size,
        sha256: regenerated?.sha256 ?? asset.sha256,
      })
    }
  }

  // 4) 训练数据：默认不打包（体量大），includeTraining=true 才收集
  if (includeTraining) {
    const trainingRoot = path.join(dataDir, 'training')
    const trainingDownloads = path.join(trainingRoot, '.downloads')
    candidates.push({
      key: 'training/code',
      kind: 'training-code',
      file: `training/code/${TRAINING_CODE.file}`,
      source: path.join(trainingDownloads, TRAINING_CODE.file),
      size: TRAINING_CODE.size,
      sha256: TRAINING_CODE.sha256,
    })
    const python = TRAINING_PYTHON[currentTrainingPlatform()]
    candidates.push({
      key: 'training/python',
      kind: 'training-python',
      file: `training/python/${python.file}`,
      source: path.join(trainingDownloads, python.file),
      size: python.size,
      sha256: python.sha256,
    })
    for (const dataset of TRAINING_DATASETS) {
      candidates.push({
        key: `training/dataset/${dataset.id}`,
        kind: 'training-dataset',
        file: `training/datasets/${dataset.file}`,
        source: path.join(trainingDownloads, dataset.file),
        size: dataset.size,
        sha256: dataset.sha256,
      })
    }
    for (const file of TRAINING_CHECKPOINTS) {
      candidates.push({
        key: `training/checkpoint/${file.dest}`,
        kind: 'training-checkpoint',
        file: `training/checkpoints/${file.dest}`,
        source: path.join(trainingRoot, 'checkpoints', ...file.dest.split('/')),
        size: file.size,
        sha256: file.sha256,
      })
    }
  }

  return candidates
}

/** 日志/进度/warnings 里的展示名：不暴露真实权重文件名（离线包构建详情会显示在设置页） */
function displayCandidateLabel(candidate: { kind: string; key: string; file: string }): string {
  switch (candidate.kind) {
    case 'model':
      return modelDisplayName(candidate.file.split('/').pop() ?? candidate.key)
    case 'adapter':
      return '风格适配器'
    case 'runtime':
      return '引擎运行时文件'
    case 'cuda':
      return 'CUDA 组件'
    case 'runtime-archive':
      return '引擎运行时归档'
    case 'training-code':
      return '训练代码'
    case 'training-python':
      return '训练 Python 运行时'
    case 'training-dataset':
      return '训练数据集'
    case 'training-checkpoint':
      return '基座检查点'
    default:
      return '模型文件'
  }
}

/**
 * 从「已安装目录 + 下载缓存」构建服务器离线包。
 *
 * - 找不到 / 大小不符的文件跳过，并汇总到 `warnings`（不中断构建，尽量产出可用包）；
 * - manifest 里的 sha256 用清单钉死值；构建阶段只校验 size（下载阶段已校验过 hash）；
 *   例外：从已解压目录回打的 LoRA 适配器归档用生成文件的实际 size/sha256；
 * - 输出 `<outDir>/engine-package.json`；已有同名文件会被覆盖（stale 文件不会进 manifest）。
 */
export async function buildEnginePackage(options: BuildEnginePackageOptions): Promise<BuildEnginePackageResult> {
  const platform = resolvePlatform()
  const outDir = enginePackageDir(options.dataDir, options.outDir)
  const includeTraining = options.includeTraining === true
  const includeAdapters = options.adapters !== false
  const log = options.log ?? (() => {})
  const warnings: string[] = []
  // 先做 staging：真实机器上适配器往往只剩「已解压目录」，主循环开始前先回打成 tar.gz，
  // 这样 packageCandidates 里有可用的 source（临时目录在构建结束/失败后统一清理）。
  const staging = includeAdapters
    ? await stageAdapterArchives({ dataDir: options.dataDir, signal: options.signal, log })
    : emptyStaging()
  try {
    const candidates = packageCandidates({
      dataDir: options.dataDir,
      platform,
      profiles: options.profiles,
      includeTraining,
      adapters: includeAdapters,
      generated: staging.overrides,
    })
    mkdirSync(outDir, { recursive: true })
    options.onProgress?.(0, `准备打包 ${candidates.length} 个文件（平台 ${platform}${includeTraining ? ' + 训练数据' : ''}）`)

    const files: EnginePackageFile[] = []
    let copied = 0
    let linked = 0
    let bytes = 0
    let index = 0
    for (const candidate of candidates) {
      throwIfAborted(options.signal)
      index += 1
      const label = displayCandidateLabel(candidate)
      const sourceStats = statFile(candidate.source)
      if (!sourceStats) {
        warnings.push(`缺文件：${label}（${candidate.source}）`)
        log(`跳过（缺失）：${label}`)
        options.onProgress?.(index / candidates.length, `${index}/${candidates.length} · 跳过 ${label}（缺失）`)
        continue
      }
      if (candidate.size > 0 && sourceStats.size !== candidate.size) {
        warnings.push(`大小不符：${label}（期望 ${candidate.size}，实际 ${sourceStats.size}）`)
        log(`跳过（大小不符）：${label}`)
        options.onProgress?.(index / candidates.length, `${index}/${candidates.length} · 跳过 ${label}（大小不符）`)
        continue
      }
      const dest = path.join(outDir, ...candidate.file.split('/'))
      const outcome = await copyArtifact(
        { path: candidate.source, size: candidate.size, sha256: candidate.sha256, origin: 'cache' },
        dest,
        { verifySha: false, signal: options.signal, log },
      )
      if (outcome === 'failed') {
        warnings.push(`复制失败：${label}`)
        options.onProgress?.(index / candidates.length, `${index}/${candidates.length} · 失败 ${label}`)
        continue
      }
      if (outcome === 'linked') linked += 1
      else copied += 1
      bytes += candidate.size
      files.push({ key: candidate.key, kind: candidate.kind, file: candidate.file, size: candidate.size, sha256: candidate.sha256 })
      options.onProgress?.(
        index / candidates.length,
        `${index}/${candidates.length} · ${label}（${(candidate.size / 1e6).toFixed(1)}MB）`,
      )
    }

    throwIfAborted(options.signal)
    const manifest: EnginePackageManifest = {
      schema: 1,
      createdAt: new Date().toISOString(),
      platform,
      label: `${platform} · ${options.profiles.join(',')}${includeTraining ? ' · training' : ''}`,
      files,
    }
    const manifestPath = path.join(outDir, ENGINE_PACKAGE_MANIFEST)
    const tempPath = `${manifestPath}.tmp`
    writeFileSync(tempPath, JSON.stringify(manifest, null, 2), 'utf8')
    renameSync(tempPath, manifestPath)
    const warningText = warnings.length > 0 ? `，${warnings.length} 个文件被跳过` : ''
    log(`离线包已生成：${manifestPath}（${files.length} 个文件，${(bytes / 1e9).toFixed(2)}GB${warningText}）`)
    options.onProgress?.(1, `完成：${files.length} 个文件 / ${(bytes / 1e9).toFixed(2)}GB${warningText}`)
    return { dir: outDir, manifest, copied, linked, bytes, warnings }
  } finally {
    staging.cleanup()
  }
}

/** 判断文件是否存在于某个目录下（供 UI/CLI 快速展示；内部工具） */
export function enginePackageFileExists(dataDir: string, key: string, overrideDir?: string): boolean {
  const artifact = findLocalArtifact(dataDir, key, overrideDir)
  if (!artifact) return false
  if (!existsSync(artifact.path)) return false
  return fileSizeSafe(artifact.path) === artifact.size
}
