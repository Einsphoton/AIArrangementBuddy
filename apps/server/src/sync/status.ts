/**
 * 数据面（NAS / 本地）状态自检：`GET /api/sync/status`。
 *
 * P6-B 的 NAS 模式本质是「把 DATA_DIR 指到挂载盘」：工程、资产、适配器、同步包都在数据面里。
 * 这个接口把数据面摊开给用户/脚本看，用来确认挂载是否正确、是否可写、占用了多少空间。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { SERVER_VERSION, adaptersDir, assetsDir, dataDir, projectsDir } from '../config.js'
import { assetFileCount, listAssets } from '../storage/assets.js'
import { listProjects } from '../storage/projects.js'
import { errorMessage } from '../util.js'
import { listSavedSyncPackages } from './package.js'

export interface SyncDataPlaneStatus {
  ok: true
  serverVersion: string
  dataDir: string
  /** 数据目录来源：env = 显式配置（NAS / 自定义盘），default = 仓库内 data/ */
  dataDirSource: 'env' | 'default'
  dataDirEnvVar?: 'DATA_DIR' | 'AIAB_DATA_DIR'
  /** 形如 \\NAS\share 的 UNC 路径（Windows 网络盘） */
  isUncPath: boolean
  writable: boolean
  writeError?: string
  platform: string
  node: string
  projects: { dir: string; count: number; bytes: number }
  assets: { dir: string; count: number; files: number; bytes: number }
  adapters: { dir: string; shared: boolean; count: number; bytes: number }
  sync: { dir: string; count: number; bytes: number }
  generatedAt: string
}

function safeDirStats(dir: string, filter?: (name: string) => boolean): { count: number; bytes: number } {
  let count = 0
  let bytes = 0
  try {
    for (const name of readdirSync(dir)) {
      if (filter && !filter(name)) continue
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
    /* 目录不存在或不可读 */
  }
  return { count, bytes }
}

function countSubdirectories(dir: string): number {
  try {
    let count = 0
    for (const name of readdirSync(dir)) {
      try {
        if (statSync(path.join(dir, name)).isDirectory()) count++
      } catch {
        /* ignore */
      }
    }
    return count
  } catch {
    return 0
  }
}

export function dataPlaneStatus(): SyncDataPlaneStatus {
  const envVar: 'DATA_DIR' | 'AIAB_DATA_DIR' | undefined = process.env.DATA_DIR
    ? 'DATA_DIR'
    : process.env.AIAB_DATA_DIR
      ? 'AIAB_DATA_DIR'
      : undefined

  // 可写性探测：在数据目录写一个临时文件再删掉（NAS 只读挂载 / 权限不足会失败）
  let writable = false
  let writeError: string | undefined
  try {
    mkdirSync(dataDir, { recursive: true })
    const probe = path.join(dataDir, `.aiab-write-test-${process.pid}.tmp`)
    writeFileSync(probe, `probe ${Date.now()}`)
    rmSync(probe, { force: true })
    writable = true
  } catch (error) {
    writeError = errorMessage(error)
  }

  const assets = listAssets()
  const assetBytes = assets.reduce((sum, asset) => sum + (Number.isFinite(asset.bytes) ? asset.bytes : 0), 0)
  const projectFiles = safeDirStats(projectsDir, (name) => name.endsWith('.json'))
  const projectCount = listProjects().length
  const savedPackages = listSavedSyncPackages()

  // 适配器：一个子目录一个适配器，大小按各子目录内文件累加
  let adaptersBytes = 0
  try {
    for (const name of readdirSync(adaptersDir)) {
      const dir = path.join(adaptersDir, name)
      try {
        if (statSync(dir).isDirectory()) adaptersBytes += safeDirStats(dir).bytes
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* 目录不存在 */
  }

  return {
    ok: true,
    serverVersion: SERVER_VERSION,
    dataDir,
    dataDirSource: envVar ? 'env' : 'default',
    dataDirEnvVar: envVar,
    isUncPath: /^[\\/]{2}/.test(dataDir),
    writable,
    writeError,
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    projects: { dir: projectsDir, count: projectCount, bytes: projectFiles.bytes },
    assets: { dir: assetsDir, count: assets.length, files: assetFileCount(), bytes: assetBytes },
    adapters: {
      dir: adaptersDir,
      shared: path.resolve(adaptersDir) !== path.resolve(dataDir, 'adapters'),
      count: countSubdirectories(adaptersDir),
      bytes: adaptersBytes,
    },
    sync: { dir: savedPackages.dir, count: savedPackages.count, bytes: savedPackages.bytes },
    generatedAt: new Date().toISOString(),
  }
}
