/**
 * 适配器注册表：扫描 `<DATA_DIR>/adapters/*` 并产出清单 + 兼容性审计。
 *
 * 目录约定（一个适配器一个子目录）：
 *   data/adapters/<id>/
 *     adapter_model.safetensors   # PEFT 权重（C++ 与 Python 都能用）
 *     adapter_config.json         # PEFT 配置（r / lora_alpha）
 *     adapter.json                # 我们的旁注：styleId/baseModel/tasks/license/training
 *     verified.json               # 实测记录：{"runtime":"native-cpp","mergedPairs":192,"at":...}
 *
 * 扫描逻辑放在 @aiab/core（纯函数、可单测），这里只提供 Node fs。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  auditAdapter,
  buildAdapterManifest,
  type AdapterCompatibility,
  type AdapterFsReader,
  type AdapterManifest,
} from '@aiab/core'
import { adaptersDir } from '../config.js'

const nodeFs: AdapterFsReader = {
  listFiles(dir) {
    try {
      return readdirSync(dir)
        .filter((name) => {
          try {
            return statSync(path.join(dir, name)).isFile()
          } catch {
            return false
          }
        })
        .map((name) => ({ path: name, bytes: statSync(path.join(dir, name)).size }))
    } catch {
      return []
    }
  },
  readJson<T = unknown>(file: string): T | null {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as T
    } catch {
      return null
    }
  },
}

export interface AdapterEntry {
  dir: string
  ok: boolean
  manifest?: AdapterManifest
  audit?: AdapterCompatibility
  error?: string
}

export function adaptersRoot(): string {
  return adaptersDir
}

/** 扫描所有适配器目录 */
export function scanAdapters(): AdapterEntry[] {
  if (!existsSync(adaptersDir)) return []
  const entries: AdapterEntry[] = []
  for (const name of readdirSync(adaptersDir)) {
    const dir = path.join(adaptersDir, name)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const result = buildAdapterManifest(dir, nodeFs)
    if (!result.ok) {
      entries.push({ dir, ok: false, error: result.error })
      continue
    }
    entries.push({ dir, ok: true, manifest: result.manifest, audit: auditAdapter(result.manifest) })
  }
  return entries.sort((a, b) => (a.manifest?.name ?? a.dir).localeCompare(b.manifest?.name ?? b.dir))
}

/** 按 id 取单个适配器；id 不匹配目录名时也能命中（旁注里可自定义 id） */
export function findAdapter(id: string): AdapterEntry | null {
  return scanAdapters().find((entry) => entry.manifest?.id === id || path.basename(entry.dir) === id) ?? null
}
