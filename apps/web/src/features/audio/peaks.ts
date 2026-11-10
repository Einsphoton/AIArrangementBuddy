/**
 * 音频波形峰值缓存 + SVG 折线工具。
 *
 * 约定（与后端契约一致）：
 * - 峰值由**服务端**算好：512 桶，`[min, max]` 交错，取值 -1..1；
 * - 前端同一 asset 只请求一次并缓存（`GET /api/assets/:id/peaks`），
 *   上传 / 生成时若已带上 peaks，用 `primeAssetPeaks` 直接预热，避免二次请求；
 * - 画波形是纯计算 + SVG `<polygon>`，不碰 canvas / 主线程 IO；
 * - `peaksPolygonPoints` 的字符串按 (assetId, offset, duration, 尺寸) 缓存，
 *   缩放 / 拖动时命中缓存，不会反复拼 1000+ 点的字符串。
 *
 * 说明：一期 `stretchRatio` 固定 1，波形按「秒 → 桶」线性映射，不做变速拉伸。
 */
import { useEffect, useState } from 'react'
import { getAssetPeaks, type AssetPeaksResult } from '../../lib/api'

export interface AssetPeaks {
  durationSec: number
  sampleRate: number
  channels: number
  /** [min, max] 交错，-1..1 */
  peaks: number[]
}

const entries = new Map<string, AssetPeaks>()
const pending = new Map<string, Promise<AssetPeaks | null>>()
const listeners = new Map<string, Set<() => void>>()
const polygonCache = new Map<string, string>()

const MAX_POLYGON_CACHE = 320

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function notify(assetId: string): void {
  const set = listeners.get(assetId)
  if (!set) return
  for (const listener of set) {
    try {
      listener()
    } catch {
      /* ignore */
    }
  }
}

/** 直接写入缓存（上传 / 生成接口已返回 peaks 时用） */
export function primeAssetPeaks(assetId: string, data: AssetPeaksResult | AssetPeaks): void {
  if (!data || !Array.isArray(data.peaks) || data.peaks.length === 0) return
  entries.set(assetId, {
    durationSec: Math.max(0, data.durationSec ?? 0),
    sampleRate: data.sampleRate ?? 0,
    channels: data.channels ?? 0,
    peaks: data.peaks,
  })
  // 数据变了，旧的折线缓存全部失效（按 assetId 前缀删除）
  for (const key of [...polygonCache.keys()]) {
    if (key.startsWith(`${assetId}|`)) polygonCache.delete(key)
  }
  notify(assetId)
}

/** 同步读缓存（没加载过返回 null） */
export function getAssetPeaksSync(assetId: string): AssetPeaks | null {
  return entries.get(assetId) ?? null
}

/** 拉取峰值（带缓存 + 并发去重）。失败返回 null，不抛错，波形退化为占位线。 */
export function loadAssetPeaks(assetId: string): Promise<AssetPeaks | null> {
  const cached = entries.get(assetId)
  if (cached) return Promise.resolve(cached)
  const running = pending.get(assetId)
  if (running) return running
  const promise = getAssetPeaks(assetId)
    .then((result) => {
      if (!result || !Array.isArray(result.peaks) || result.peaks.length === 0) return null
      const data: AssetPeaks = {
        durationSec: Math.max(0, result.durationSec ?? 0),
        sampleRate: result.sampleRate ?? 0,
        channels: result.channels ?? 0,
        peaks: result.peaks,
      }
      entries.set(assetId, data)
      notify(assetId)
      return data
    })
    .catch((error) => {
      console.warn('[audio] 拉取波形峰值失败', assetId, error)
      return null
    })
    .finally(() => {
      pending.delete(assetId)
    })
  pending.set(assetId, promise)
  return promise
}

export function subscribeAssetPeaks(assetId: string, listener: () => void): () => void {
  const set = listeners.get(assetId) ?? new Set<() => void>()
  set.add(listener)
  listeners.set(assetId, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(assetId)
  }
}

/**
 * React hook：读某个资产的峰值（首次自动加载，加载完成自动重渲染）。
 *
 * 注意：这里**直接读模块缓存**而不是把数据存进 state —— 切换 take / 片段换 assetId 时，
 * 必须保证「返回的 peaks 一定属于当前 assetId」，否则会有一帧把旧资产的峰值
 * 以新 assetId 作为缓存键算进波形（导致切换版本后波形不刷新）。
 */
export function useAssetPeaks(assetId: string): AssetPeaks | null {
  const [, forceRender] = useState(0)

  useEffect(() => {
    const unsubscribe = subscribeAssetPeaks(assetId, () => forceRender((count) => count + 1))
    void loadAssetPeaks(assetId)
    return unsubscribe
  }, [assetId])

  return entries.get(assetId) ?? null
}

/**
 * 把峰值转成 SVG `<polygon points>` 字符串：上行沿 max、下行沿 min，
 * 根据片段的 `offsetSec / durationSec` 只取资产里的对应区间。
 */
export function peaksPolygonPoints(
  data: AssetPeaks,
  offsetSec: number,
  durationSec: number,
  width: number,
  height: number,
  assetId = '',
): string {
  const w = Math.max(2, Math.round(width))
  const h = Math.max(4, Math.round(height))
  if (assetId) {
    const key = `${assetId}|${offsetSec.toFixed(3)}|${durationSec.toFixed(3)}|${w}|${h}`
    const cached = polygonCache.get(key)
    if (cached !== undefined) return cached
    const points = buildPolygon(data, offsetSec, durationSec, w, h)
    if (polygonCache.size >= MAX_POLYGON_CACHE) {
      const oldest = polygonCache.keys().next().value
      if (oldest !== undefined) polygonCache.delete(oldest)
    }
    polygonCache.set(key, points)
    return points
  }
  return buildPolygon(data, offsetSec, durationSec, w, h)
}

function buildPolygon(data: AssetPeaks, offsetSec: number, durationSec: number, width: number, height: number): string {
  const peaks = data.peaks
  const buckets = Math.floor(peaks.length / 2)
  const total = Math.max(0.0001, data.durationSec)
  if (buckets <= 0) return ''
  const startSec = clamp(offsetSec, 0, total)
  const endSec = clamp(offsetSec + Math.max(0.01, durationSec), startSec, total)
  const startBucket = clamp(Math.floor((startSec / total) * buckets), 0, buckets - 1)
  const endBucket = clamp(Math.max(startBucket + 1, Math.ceil((endSec / total) * buckets)), startBucket + 1, buckets)
  const count = endBucket - startBucket
  /* 每 2px 一个采样点足够；最多 360 个点，避免超宽片段生成巨大字符串 */
  const stride = Math.max(1, Math.ceil(count / Math.min(360, Math.max(32, Math.round(width / 2)))))
  const center = height / 2
  const half = Math.max(1, height / 2 - 1)
  const upper: string[] = []
  const lower: string[] = []
  for (let index = 0; index < count; index += stride) {
    const bucket = startBucket + index
    const min = clamp(peaks[bucket * 2] ?? 0, -1, 1)
    const max = clamp(peaks[bucket * 2 + 1] ?? 0, -1, 1)
    const x = ((index / Math.max(1, count - 1)) * width).toFixed(2)
    upper.push(`${x},${(center - max * half).toFixed(2)}`)
    lower.push(`${x},${(center - min * half).toFixed(2)}`)
  }
  if (upper.length === 0) return ''
  return [...upper, ...lower.reverse()].join(' ')
}

/** 秒 → `12.3s` / `1:05.2` 的紧凑时长文案 */
export function formatAudioDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0.0s'
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds - minutes * 60
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`
}
