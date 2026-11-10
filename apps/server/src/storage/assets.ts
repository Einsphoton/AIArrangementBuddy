/**
 * 音频资产存储（data/assets/）。
 *
 * 设计约束（对应 core/audio.ts 的 AssetRef）：
 * - 工程里只存 AssetRef，音频文件落在资产库，用 sha256 去重；
 * - 每个资产附带 waveform 峰值（画波形用，避免前端解析音频）；
 * - residency=local 时记录持有设备，云同步阶段再补上传。
 *
 * 目录：
 *   data/assets/<id>.wav     音频文件（P1 只收 WAV，ACE-Step 输出即 WAV）
 *   data/assets/index.json   资产清单（id → 元数据 + 峰值）
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { assetsDir } from '../config.js'
import { parseWav } from './wav.js'

export interface StoredAsset {
  id: string
  sha256: string
  name: string
  filename: string
  mime: string
  bytes: number
  durationSec: number
  sampleRate: number
  channels: number
  /** [min,max] 交错 */
  peaks: number[]
  createdAt: number
}

type AssetIndex = Record<string, Omit<StoredAsset, 'peaks'> & { peaksFile?: string }>

const indexFile = () => path.join(assetsDir, 'index.json')

function readIndex(): AssetIndex {
  try {
    return JSON.parse(readFileSync(indexFile(), 'utf8')) as AssetIndex
  } catch {
    return {}
  }
}

function writeIndex(index: AssetIndex): void {
  mkdirSync(assetsDir, { recursive: true })
  writeFileSync(indexFile(), JSON.stringify(index, null, 2), 'utf8')
}

function peaksPath(id: string): string {
  return path.join(assetsDir, `${id}.peaks.json`)
}

/** 幂等：同 sha256 直接复用已有资产 */
export function saveAsset(buffer: Buffer, meta: { name?: string; mime?: string } = {}): StoredAsset {
  mkdirSync(assetsDir, { recursive: true })
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const index = readIndex()

  for (const existing of Object.values(index)) {
    if (existing.sha256 !== sha256) continue
    const peaks = readPeaks(existing.id)
    return {
      ...existing,
      peaks: peaks?.peaks ?? [],
    }
  }

  if (meta.mime && !/wav|wave/i.test(meta.mime) && !/\.wav$/i.test(meta.name ?? '')) {
    throw new Error('P1 只支持 WAV 音频（ACE-Step 输出即 WAV）；其它格式请先转成 WAV PCM16')
  }

  const info = parseWav(buffer)
  const id = `asset_${sha256.slice(0, 16)}`
  const filename = `${id}.wav`
  writeFileSync(path.join(assetsDir, filename), buffer)
  writeFileSync(peaksPath(id), JSON.stringify({ peaks: info.peaks }), 'utf8')

  const record = {
    id,
    sha256,
    name: meta.name ?? filename,
    filename,
    mime: meta.mime ?? 'audio/wav',
    bytes: buffer.length,
    durationSec: Math.round(info.durationSec * 1000) / 1000,
    sampleRate: info.sampleRate,
    channels: info.channels,
    createdAt: Date.now(),
  }
  index[id] = record
  writeIndex(index)
  return { ...record, peaks: info.peaks }
}

export function readPeaks(id: string): { peaks: number[] } | null {
  try {
    return JSON.parse(readFileSync(peaksPath(id), 'utf8')) as { peaks: number[] }
  } catch {
    return null
  }
}

export function getAsset(id: string): StoredAsset | null {
  const index = readIndex()
  const record = index[id]
  if (!record) return null
  return { ...record, peaks: readPeaks(id)?.peaks ?? [] }
}

export function assetFilePath(id: string): string | null {
  const asset = getAsset(id)
  if (!asset) return null
  const file = path.join(assetsDir, asset.filename)
  return existsSync(file) ? file : null
}

export function listAssets(): StoredAsset[] {
  const index = readIndex()
  return Object.values(index)
    .map((record) => ({ ...record, peaks: readPeaks(record.id)?.peaks ?? [] }))
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** 资产文件名列表（启动自检用） */
export function assetFileCount(): number {
  try {
    return readdirSync(assetsDir).filter((f) => f.endsWith('.wav')).length
  } catch {
    return 0
  }
}
