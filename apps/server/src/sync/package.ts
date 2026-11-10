/**
 * 同步包（`.aiabsync`）导出 / 导入。
 *
 * 包格式：标准 ZIP（复用 apps/server/src/zip.ts 的零依赖写入器；读取用 sync/zip-read.ts），
 * 目录结构：
 *
 *   manifest.json           同步清单（格式版本 / 生成时间 / 文件 sha256+大小 / 工程与资产元数据）
 *   projects/<id>.json      工程快照（与 data/projects/<id>.json 同构）
 *   assets/index.json       资产清单子集（人读 + 工具核对用）
 *   assets/<id>.wav         工程引用到的资产音频
 *
 * 冲突策略：
 * - 资产按 **sha256 内容去重**入库（复用 storage/assets.ts 的 saveAsset），工程里的 AssetRef
 *   会被重写成本机资产 id（跨设备后源 id 可能撞上不同内容，不能直接沿用）；
 * - 工程先按「规范化 JSON + sha256」做幂等判断：本机已有完全相同的工程 → skipped；
 * - 同 id 但内容不同 → 生成新 id，名称追加「（同步副本）」，保留原 createdAt / updatedAt。
 *
 * 其他约定见 docs/SYNC.md。
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { migrateProject, newId, type AssetRef, type Project } from '@aiab/core'
import { SERVER_VERSION, assetsDir, dataDir } from '../config.js'
import type { ZipEntry } from '../zip.js'
import { createZip } from '../zip.js'
import { getAsset, listAssets, saveAsset, type StoredAsset } from '../storage/assets.js'
import { listProjects, loadProject, projectExists, saveProject } from '../storage/projects.js'
import { errorMessage } from '../util.js'
import { readZipEntries } from './zip-read.js'

/* ------------------------------------------------------------------ */
/* 常量 / 类型                                                          */
/* ------------------------------------------------------------------ */

export const SYNC_FORMAT = 'aiab-sync'
export const SYNC_FORMAT_VERSION = 1
export const SYNC_PACKAGE_EXT = '.aiabsync'
export const SYNC_MANIFEST_FILE = 'manifest.json'
export const SYNC_ASSETS_INDEX_FILE = 'assets/index.json'

export interface SyncFileRecord {
  /** 包内路径，用 / 分隔 */
  name: string
  sha256: string
  bytes: number
}

export interface SyncProjectRecord {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  trackCount: number
  tempo: number
  file: string
  sha256: string
  bytes: number
}

export interface SyncAssetRecord {
  id: string
  sha256: string
  name: string
  file: string
  bytes: number
  mime: string
  durationSec: number
  sampleRate: number
  channels: number
  createdAt: number
}

/** assets/index.json 的条目（StoredAsset 去掉峰值） */
interface AssetIndexEntry {
  id: string
  sha256: string
  name: string
  filename: string
  mime: string
  bytes: number
  durationSec: number
  sampleRate: number
  channels: number
  createdAt: number
}

export interface SyncManifest {
  format: typeof SYNC_FORMAT
  formatVersion: number
  packageId: string
  createdAt: string
  generator: { app: string; serverVersion: string; platform: string }
  projectIds: string[]
  projects: SyncProjectRecord[]
  assets: SyncAssetRecord[]
  includeAssets: boolean
  files: SyncFileRecord[]
  warnings: string[]
}

export interface SyncExportOptions {
  /** 要导出的工程 id；省略则导出全部工程 */
  projectIds?: string[]
  /** 是否打包工程引用到的资产（默认 true） */
  includeAssets?: boolean
  /** 自定义包名（用于下载文件名 / data/sync 内文件名），不需要扩展名 */
  name?: string
  /** 写入 `<DATA_DIR>/sync/<name>.aiabsync` 并返回路径（NAS / 两机搬运用） */
  saveToDataDir?: boolean
}

export interface SyncExportResult {
  buffer: Buffer
  filename: string
  manifest: SyncManifest
  savedPath?: string
  summary: string
}

export interface SyncImportOptions {
  /** 同步包字节（zip） */
  buffer?: Buffer
  /** 本机文件 / 目录路径。目录 = 解压后的同步包（目录式同步文件夹） */
  path?: string
}

export interface SyncImportProjectReport {
  id: string
  originalId: string
  name: string
  action: 'created' | 'renamed' | 'skipped'
  /** action=skipped 时命中的本机工程 id */
  matchedId?: string
  updatedAt: number
  trackCount: number
}

export interface SyncImportConflict {
  type: 'project-id-conflict'
  originalId: string
  newId: string
  reason: string
}

export interface SyncImportReport {
  projects: SyncImportProjectReport[]
  assets: { added: number; reused: number; total: number }
  conflicts: SyncImportConflict[]
  warnings: string[]
  manifest: {
    format: string
    formatVersion: number
    packageId: string
    createdAt: string
    projectCount: number
    assetCount: number
    fileCount: number
  }
  summary: string
}

interface ResolvedAsset {
  id: string
  sha256: string
  bytes: number
}

/**
 * 导入台账（`<DATA_DIR>/sync/imports.json`）：
 * 记录「包内工程内容哈希 → 本机工程 id / 导入后内容哈希」，用于幂等判断。
 *
 * 为什么需要：id 冲突时导入会生成新 id 和「同步副本」名称，落盘后的工程内容哈希
 * 与包内内容不再相同；只靠本机内容哈希扫描无法识别“这个包已经导入过”。
 */
interface ImportLedgerEntry {
  projectId: string
  /** 导入并保存后的工程内容哈希（用户改过本地副本后不再匹配） */
  savedHash: string
  packageId: string
  importedAt: number
}

type ImportLedger = Record<string, ImportLedgerEntry>

/** 台账最多保留的条目数（超出按 importedAt 淘汰最旧） */
const MAX_LEDGER_ENTRIES = 1000

function importLedgerPath(): string {
  return path.join(dataDir, 'sync', 'imports.json')
}

function readImportLedger(): ImportLedger {
  try {
    const parsed = JSON.parse(readFileSync(importLedgerPath(), 'utf8')) as ImportLedger
    if (!parsed || typeof parsed !== 'object') return {}
    const cleaned: ImportLedger = {}
    for (const [hash, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry.projectId !== 'string' || typeof entry.savedHash !== 'string') continue
      if (!projectExists(entry.projectId)) continue // 工程被删了，台账条目随之失效
      cleaned[hash] = entry
    }
    return cleaned
  } catch {
    return {}
  }
}

function writeImportLedger(ledger: ImportLedger): void {
  const entries = Object.entries(ledger)
  if (entries.length > MAX_LEDGER_ENTRIES) {
    entries.sort((a, b) => (b[1].importedAt ?? 0) - (a[1].importedAt ?? 0))
    entries.length = MAX_LEDGER_ENTRIES
  }
  const dir = path.join(dataDir, 'sync')
  mkdirSync(dir, { recursive: true })
  writeFileSync(importLedgerPath(), JSON.stringify(Object.fromEntries(entries), null, 2), 'utf8')
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

function sha256Of(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 递归按键名排序，保证跨机器/跨版本比较工程内容时结果稳定 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item))
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key])
    return out
  }
  return value
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function projectHash(project: Project): string {
  return sha256Of(canonicalJson(project))
}

/** 包名清洗：只留文件名安全字符 */
function sanitizePackageName(name: string | undefined): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15)
  const base = (name ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\.aiabsync$/i, '')
    .slice(0, 80)
  return `${base || `aiab-sync-${stamp}`}${SYNC_PACKAGE_EXT}`
}

/** 工程 id 冲突时的新名称：去掉已有副本后缀再追加一次 */
function copyName(name: string): string {
  const base = (name || '未命名工程').replace(/（同步副本(\s\d+)?）$/, '').trim() || '未命名工程'
  return `${base}（同步副本）`
}

/** 收集工程引用到的全部资产 id（含资产登记表 / 音频片段 / take / 分析结果） */
function collectAssetIds(project: Project): string[] {
  const ids = new Set<string>()
  for (const ref of project.assets ?? []) ids.add(ref.id)
  for (const track of project.tracks) {
    for (const clip of track.audioClips ?? []) {
      ids.add(clip.assetId)
      for (const take of clip.takes ?? []) ids.add(take.assetId)
      for (const provenance of [clip.provenance, ...(clip.takes ?? []).map((take) => take.provenance)]) {
        for (const assetId of provenance?.sourceAssetIds ?? []) ids.add(assetId)
      }
    }
  }
  for (const analysis of project.analyses ?? []) ids.add(analysis.assetId)
  return [...ids]
}

/* ------------------------------------------------------------------ */
/* 导出                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 生成同步包（内存中的 ZIP Buffer）。
 * 资产文件缺失或 sha256 不一致时跳过并在 manifest.warnings 里记录（不阻塞工程导出）。
 */
export function createSyncPackage(options: SyncExportOptions = {}): SyncExportResult {
  const includeAssets = options.includeAssets !== false
  const requested = Array.isArray(options.projectIds) && options.projectIds.length > 0 ? [...new Set(options.projectIds)] : null

  const projectIds = requested ?? listProjects().map((summary) => summary.id)
  if (projectIds.length === 0) throw new Error('没有可导出的工程（本地工程列表为空）')

  const warnings: string[] = []
  const entries: ZipEntry[] = []
  const projectRecords: SyncProjectRecord[] = []
  const assetRecords: SyncAssetRecord[] = []
  const assetIds = new Set<string>()

  // 1) 工程快照
  for (const id of projectIds) {
    const project = loadProject(id)
    if (!project) throw new Error(`工程不存在或已损坏：${id}`)
    const file = `projects/${project.id}.json`
    const data = Buffer.from(JSON.stringify(project, null, 2), 'utf8')
    entries.push({ name: file, data })
    projectRecords.push({
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      trackCount: project.tracks.length,
      tempo: project.tempo,
      file,
      sha256: sha256Of(data),
      bytes: data.length,
    })
    for (const assetId of collectAssetIds(project)) assetIds.add(assetId)
  }

  // 2) 引用到的资产
  if (includeAssets) {
    for (const assetId of [...assetIds].sort()) {
      const asset = getAsset(assetId)
      if (!asset) {
        warnings.push(`资产 ${assetId} 不在本机资产库中，已跳过（工程里的引用会保留）`)
        continue
      }
      const file = path.join(assetsDir, asset.filename)
      if (!existsSync(file)) {
        warnings.push(`资产 ${assetId} 的文件不存在（${asset.filename}），已跳过`)
        continue
      }
      let data: Buffer
      try {
        data = readFileSync(file)
      } catch (error) {
        warnings.push(`资产 ${assetId} 读取失败：${errorMessage(error)}，已跳过`)
        continue
      }
      const digest = sha256Of(data)
      if (digest !== asset.sha256) {
        warnings.push(`资产 ${assetId} 文件 sha256 与索引不一致，已跳过`)
        continue
      }
      const name = `assets/${asset.filename}`
      entries.push({ name, data })
      assetRecords.push({
        id: asset.id,
        sha256: asset.sha256,
        name: asset.name,
        file: name,
        bytes: data.length,
        mime: asset.mime,
        durationSec: asset.durationSec,
        sampleRate: asset.sampleRate,
        channels: asset.channels,
        createdAt: asset.createdAt,
      })
    }

    const index: Record<string, AssetIndexEntry> = {}
    for (const record of assetRecords) {
      index[record.id] = {
        id: record.id,
        sha256: record.sha256,
        name: record.name,
        filename: path.basename(record.file),
        mime: record.mime,
        bytes: record.bytes,
        durationSec: record.durationSec,
        sampleRate: record.sampleRate,
        channels: record.channels,
        createdAt: record.createdAt,
      }
    }
    entries.push({ name: SYNC_ASSETS_INDEX_FILE, data: Buffer.from(JSON.stringify(index, null, 2), 'utf8') })
  }

  // 3) manifest（files 覆盖除 manifest 自身以外的全部文件）
  const manifest: SyncManifest = {
    format: SYNC_FORMAT,
    formatVersion: SYNC_FORMAT_VERSION,
    packageId: randomBytes(8).toString('hex'),
    createdAt: new Date().toISOString(),
    generator: { app: 'ai-arrangement-buddy', serverVersion: SERVER_VERSION, platform: `${process.platform}/${process.arch}` },
    projectIds: projectRecords.map((record) => record.id),
    projects: projectRecords,
    assets: assetRecords,
    includeAssets,
    files: entries.map((entry) => ({ name: entry.name, sha256: sha256Of(entry.data), bytes: entry.data.length })),
    warnings,
  }
  entries.unshift({ name: SYNC_MANIFEST_FILE, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') })

  const buffer = createZip(entries)
  const filename = sanitizePackageName(options.name)
  let savedPath: string | undefined
  if (options.saveToDataDir) {
    const syncDir = path.join(dataDir, 'sync')
    mkdirSync(syncDir, { recursive: true })
    savedPath = path.join(syncDir, filename)
    writeFileSync(savedPath, buffer)
  }

  const summary =
    `已生成同步包：${projectRecords.length} 个工程 / ${assetRecords.length} 个资产 / ` +
    `${buffer.length} 字节${warnings.length ? `（${warnings.length} 条警告）` : ''}`
  return { buffer, filename, manifest, savedPath, summary }
}

/* ------------------------------------------------------------------ */
/* 导入                                                                 */
/* ------------------------------------------------------------------ */

/** 从「解压后的目录」读取同步包条目（目录式同步文件夹） */
function readDirectoryEntries(dir: string): Map<string, Buffer> {
  const root = path.resolve(dir)
  const manifestPath = path.join(root, SYNC_MANIFEST_FILE)
  if (!existsSync(manifestPath)) throw new Error(`目录不是同步包：缺少 ${SYNC_MANIFEST_FILE}`)
  const manifestBytes = readFileSync(manifestPath)
  const entries = new Map<string, Buffer>([[SYNC_MANIFEST_FILE, manifestBytes]])

  let files: unknown = []
  try {
    files = (JSON.parse(manifestBytes.toString('utf8')) as { files?: unknown }).files
  } catch {
    // manifest 本身不合法：交给后面的 manifest 校验报错
    return entries
  }
  for (const file of Array.isArray(files) ? files : []) {
    const name = (file as { name?: unknown })?.name
    if (typeof name !== 'string' || !name) continue
    const absolute = path.resolve(root, name)
    if (!absolute.startsWith(root + path.sep)) {
      throw new Error(`同步包内包含非法路径：${name}`)
    }
    if (!existsSync(absolute)) continue
    entries.set(name, readFileSync(absolute))
  }
  return entries
}

function loadPackageEntries(options: SyncImportOptions): Map<string, Buffer> {
  if (options.buffer && options.buffer.length > 0) return readZipEntries(options.buffer)
  if (options.path) {
    const target = path.resolve(options.path)
    if (!existsSync(target)) throw new Error(`同步包路径不存在：${options.path}`)
    const stat = statSync(target)
    if (stat.isDirectory()) return readDirectoryEntries(target)
    if (!stat.isFile()) throw new Error(`同步包路径既不是文件也不是目录：${options.path}`)
    return readZipEntries(readFileSync(target))
  }
  throw new Error('没有提供同步包内容')
}

function parseManifest(entries: Map<string, Buffer>): SyncManifest {
  const raw = entries.get(SYNC_MANIFEST_FILE)
  if (!raw) throw new Error(`同步包缺少 ${SYNC_MANIFEST_FILE}`)
  let parsed: SyncManifest
  try {
    parsed = JSON.parse(raw.toString('utf8')) as SyncManifest
  } catch (error) {
    throw new Error(`同步包 ${SYNC_MANIFEST_FILE} 不是合法 JSON：${errorMessage(error)}`)
  }
  if (!parsed || typeof parsed !== 'object') throw new Error(`同步包 ${SYNC_MANIFEST_FILE} 结构不合法`)
  if (parsed.format !== SYNC_FORMAT) throw new Error(`不是 AI 编曲伴侣同步包（format=${String(parsed.format)}）`)
  if (!Number.isInteger(parsed.formatVersion) || parsed.formatVersion < 1) {
    throw new Error(`同步包格式版本不合法：${String(parsed.formatVersion)}`)
  }
  if (parsed.formatVersion > SYNC_FORMAT_VERSION) {
    throw new Error(
      `同步包版本过新（formatVersion=${parsed.formatVersion}，本机最高支持 ${SYNC_FORMAT_VERSION}），请升级服务端`,
    )
  }
  if (!Array.isArray(parsed.files) || !Array.isArray(parsed.projects) || !Array.isArray(parsed.assets)) {
    throw new Error('同步包 manifest 不完整（缺少 files / projects / assets）')
  }
  return parsed
}

/** 校验 manifest 里记录的文件：存在、大小、sha256 三方一致 */
function validateManifestFiles(manifest: SyncManifest, entries: Map<string, Buffer>): void {
  const problems: string[] = []
  const filesByName = new Map<string, { name: string; sha256: string; bytes: number }>()
  for (const file of manifest.files) {
    if (!file || typeof file.name !== 'string' || typeof file.sha256 !== 'string' || typeof file.bytes !== 'number') {
      problems.push('manifest.files 里有不完整的记录')
      continue
    }
    if (file.name === SYNC_MANIFEST_FILE) {
      problems.push('manifest.files 不应包含 manifest.json 自身')
      continue
    }
    if (filesByName.has(file.name)) {
      problems.push(`manifest.files 里重复记录：${file.name}`)
      continue
    }
    filesByName.set(file.name, file)
  }

  for (const record of manifest.projects) {
    if (!record || typeof record.file !== 'string') {
      problems.push('manifest.projects 里有不完整的记录')
      continue
    }
    const file = filesByName.get(record.file)
    if (!file) problems.push(`manifest.files 缺少工程文件：${record.file}`)
    else if (file.sha256 !== record.sha256) problems.push(`工程文件 sha256 记录不一致：${record.file}`)
  }
  for (const record of manifest.assets) {
    if (!record || typeof record.file !== 'string') {
      problems.push('manifest.assets 里有不完整的记录')
      continue
    }
    const file = filesByName.get(record.file)
    if (!file) problems.push(`manifest.files 缺少资产文件：${record.file}`)
    else if (file.sha256 !== record.sha256) problems.push(`资产文件 sha256 记录不一致：${record.file}`)
  }

  for (const file of filesByName.values()) {
    const data = entries.get(file.name)
    if (!data) {
      problems.push(`同步包缺少文件：${file.name}`)
      continue
    }
    if (data.length !== file.bytes) problems.push(`文件大小不符：${file.name}（${data.length} ≠ ${file.bytes}）`)
    else if (sha256Of(data) !== file.sha256) problems.push(`文件 sha256 校验失败：${file.name}`)
    if (problems.length > 12) break
  }

  if (problems.length > 0) {
    const shown = problems.slice(0, 8).join('；')
    const more = problems.length > 8 ? `…（共 ${problems.length} 条问题）` : ''
    throw new Error(`同步包校验失败：${shown}${more}`)
  }
}

/** 把工程里的 AssetRef / assetId 重写成本机资产 id（跨设备后源 id 不可信） */
function rewriteAssetRefs(project: Project, resolved: Map<string, ResolvedAsset>): { missing: string[] } {
  const missing = new Set<string>()

  if (Array.isArray(project.assets)) {
    project.assets = project.assets.map((ref: AssetRef) => {
      const target = resolved.get(ref.id)
      if (!target) {
        missing.add(ref.id)
        return ref
      }
      const next: AssetRef = { ...ref, id: target.id, sha256: target.sha256, bytes: target.bytes, residency: 'local' }
      delete next.localPath
      delete next.deviceId
      return next
    })
  }

  for (const track of project.tracks) {
    for (const clip of track.audioClips ?? []) {
      const mapped = resolved.get(clip.assetId)
      if (mapped) clip.assetId = mapped.id
      else missing.add(clip.assetId)

      for (const take of clip.takes ?? []) {
        const takeMapped = resolved.get(take.assetId)
        if (takeMapped) take.assetId = takeMapped.id
        else missing.add(take.assetId)
      }

      const provenances = [clip.provenance, ...(clip.takes ?? []).map((take) => take.provenance)]
      for (const provenance of provenances) {
        if (!provenance || !Array.isArray(provenance.sourceAssetIds)) continue
        provenance.sourceAssetIds = provenance.sourceAssetIds.map((assetId) => {
          const sourceMapped = resolved.get(assetId)
          if (sourceMapped) return sourceMapped.id
          missing.add(assetId)
          return assetId
        })
      }
    }
  }

  for (const analysis of project.analyses ?? []) {
    const mapped = resolved.get(analysis.assetId)
    if (mapped) analysis.assetId = mapped.id
    else missing.add(analysis.assetId)
  }

  return { missing: [...missing] }
}

function uniqueNames(ids: Set<string>): string[] {
  return [...ids]
}

/**
 * 导入同步包：校验 sha256 → 资产按内容去重入库 → 工程合并（冲突时生成新 id）。
 * @throws 校验失败 / 资产或工程无法写入时抛可读中文 Error
 */
export function importSyncPackage(options: SyncImportOptions): SyncImportReport {
  const entries = loadPackageEntries(options)
  const manifest = parseManifest(entries)
  validateManifestFiles(manifest, entries)

  const warnings: string[] = Array.isArray(manifest.warnings) ? [...manifest.warnings] : []
  const conflicts: SyncImportConflict[] = []

  // 1) 资产：按 sha256 去重入库
  const existingBySha = new Map<string, StoredAsset>()
  for (const asset of listAssets()) existingBySha.set(asset.sha256, asset)
  const resolved = new Map<string, ResolvedAsset>()
  let addedAssets = 0
  let reusedAssets = 0

  for (const record of manifest.assets) {
    const data = entries.get(record.file)
    if (!data) throw new Error(`同步包缺少资产文件：${record.file}`)
    const digest = sha256Of(data)
    if (digest !== record.sha256) throw new Error(`资产 ${record.id} 内容校验失败（sha256 不匹配）`)

    const existing = existingBySha.get(record.sha256)
    if (existing) {
      reusedAssets++
      resolved.set(record.id, { id: existing.id, sha256: existing.sha256, bytes: existing.bytes })
      continue
    }

    let saved: StoredAsset
    try {
      saved = saveAsset(data, { name: record.name || record.file, mime: record.mime })
    } catch (error) {
      throw new Error(`资产 ${record.id} 入库失败：${errorMessage(error)}`)
    }
    addedAssets++
    existingBySha.set(saved.sha256, saved)
    resolved.set(record.id, { id: saved.id, sha256: saved.sha256, bytes: saved.bytes })
  }

  // 2) 工程：本机内容去重 → 导入台账幂等 → id 冲突生成新 id
  const localByHash = new Map<string, string>()
  for (const summary of listProjects()) {
    const local = loadProject(summary.id)
    if (local) localByHash.set(projectHash(local), local.id)
  }
  const ledger = readImportLedger()
  let ledgerDirty = false

  const projectReports: SyncImportProjectReport[] = []
  for (const record of manifest.projects) {
    const data = entries.get(record.file)
    if (!data) throw new Error(`同步包缺少工程文件：${record.file}`)

    let imported: Project
    try {
      imported = migrateProject(JSON.parse(data.toString('utf8')) as unknown)
    } catch (error) {
      throw new Error(`工程 ${record.id} 数据结构不合法：${errorMessage(error)}`)
    }

    const { missing } = rewriteAssetRefs(imported, resolved)
    if (missing.length > 0) {
      warnings.push(`工程「${imported.name}」引用了未包含在包内的资产：${uniqueNames(new Set(missing)).join(', ')}`)
    }

    const hash = projectHash(imported)

    // 2.1 本机已有内容完全相同的工程（未改过的副本 / 同一工程另存过）
    const matched = localByHash.get(hash)
    if (matched) {
      projectReports.push({
        id: matched,
        originalId: record.id,
        name: imported.name,
        action: 'skipped',
        matchedId: matched,
        updatedAt: imported.updatedAt,
        trackCount: imported.tracks.length,
      })
      continue
    }

    // 2.2 导入台账：这个包在本机导入过（可能因 id 冲突被改成了新 id / 新名称）
    const ledgerEntry = ledger[hash]
    if (ledgerEntry) {
      const existing = loadProject(ledgerEntry.projectId)
      if (existing && projectHash(existing) === ledgerEntry.savedHash) {
        projectReports.push({
          id: ledgerEntry.projectId,
          originalId: record.id,
          name: existing.name,
          action: 'skipped',
          matchedId: ledgerEntry.projectId,
          updatedAt: existing.updatedAt,
          trackCount: existing.tracks.length,
        })
        continue
      }
    }

    // 2.3 id 冲突：生成新 id + 同步副本名称，保留原时间戳
    const originalId = imported.id
    let finalId = originalId
    if (projectExists(finalId)) {
      finalId = newId('p')
      conflicts.push({
        type: 'project-id-conflict',
        originalId,
        newId: finalId,
        reason: `本机已存在 id=${originalId} 的工程且内容不同，已生成新 id 并保留原时间戳`,
      })
      imported.id = finalId
      imported.name = copyName(imported.name)
    }
    if (!Number.isFinite(imported.updatedAt)) imported.updatedAt = record.updatedAt ?? Date.now()

    const saved = saveProject(imported)
    if (!saved.ok) throw new Error(`工程 ${record.id} 保存失败：${saved.error}`)

    localByHash.set(hash, finalId)
    ledger[hash] = {
      projectId: finalId,
      savedHash: projectHash(imported),
      packageId: manifest.packageId,
      importedAt: Date.now(),
    }
    ledgerDirty = true
    projectReports.push({
      id: finalId,
      originalId,
      name: imported.name,
      action: finalId === originalId ? 'created' : 'renamed',
      updatedAt: imported.updatedAt,
      trackCount: imported.tracks.length,
    })
  }
  if (ledgerDirty) writeImportLedger(ledger)

  const created = projectReports.filter((item) => item.action === 'created').length
  const renamed = projectReports.filter((item) => item.action === 'renamed').length
  const skipped = projectReports.filter((item) => item.action === 'skipped').length
  const summary =
    `同步包导入完成：工程 ${projectReports.length} 个（新建 ${created} / 副本 ${renamed} / 跳过 ${skipped}），` +
    `资产 新增 ${addedAssets} / 复用 ${reusedAssets}${warnings.length ? `，${warnings.length} 条警告` : ''}`

  return {
    projects: projectReports,
    assets: { added: addedAssets, reused: reusedAssets, total: manifest.assets.length },
    conflicts,
    warnings,
    manifest: {
      format: manifest.format,
      formatVersion: manifest.formatVersion,
      packageId: manifest.packageId,
      createdAt: manifest.createdAt,
      projectCount: manifest.projects.length,
      assetCount: manifest.assets.length,
      fileCount: manifest.files.length,
    },
    summary,
  }
}

/** 列出 `<DATA_DIR>/sync` 下已生成的同步包（status 用） */
export function listSavedSyncPackages(): { dir: string; count: number; bytes: number } {
  const dir = path.join(dataDir, 'sync')
  let count = 0
  let bytes = 0
  try {
    for (const name of readdirSync(dir)) {
      if (!name.toLowerCase().endsWith(SYNC_PACKAGE_EXT)) continue
      try {
        const stat = statSync(path.join(dir, name))
        if (!stat.isFile()) continue
        count++
        bytes += stat.size
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* 目录不存在 = 0 个包 */
  }
  return { dir, count, bytes }
}
