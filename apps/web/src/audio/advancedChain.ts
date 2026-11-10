/**
 * P6-A 音频进阶（多段母线压缩 + 侧链 ducking）的默认值与辅助函数。
 *
 * 类型直接来自 core：
 * - `Project.masterChain.multiband?: { enabled, low/mid/high, crossoverHz }`
 * - `Track.mixChain.duck?: { enabled, sourceTrackId?, amountDb, attackSec, releaseSec }`
 */
import { getInstrument, type Project, type Track } from '@aiab/core'

/* ------------------------------------------------------------------ */
/* 多段总线压缩（multiband）                                            */
/* ------------------------------------------------------------------ */

export type MultibandConfig = NonNullable<NonNullable<Project['masterChain']>['multiband']>
export type MultibandBandParams = MultibandConfig['low']

/** 默认分频点：低 <200Hz、中 200–3000Hz、高 >3kHz（与 core schema 默认一致） */
export const DEFAULT_CROSSOVER: [number, number] = [200, 3000]

/** 默认三段参数：越往高频越轻（高频压缩太狠会糊） */
export const DEFAULT_MULTIBAND: MultibandConfig = {
  enabled: true,
  low: { thresholdDb: -20, ratio: 3, attackSec: 0.02, releaseSec: 0.2 },
  mid: { thresholdDb: -18, ratio: 2.5, attackSec: 0.012, releaseSec: 0.16 },
  high: { thresholdDb: -16, ratio: 2, attackSec: 0.008, releaseSec: 0.12 },
  crossoverHz: DEFAULT_CROSSOVER,
}

/** 从工程读取 multiband（masterChain 不存在/禁用时视为没有） */
export function getMultiband(project: Project | null | undefined): MultibandConfig | null {
  const chain = project?.masterChain
  if (!chain || chain.enabled === false) return null
  return chain.multiband ?? null
}

/* ------------------------------------------------------------------ */
/* 侧链 ducking                                                        */
/* ------------------------------------------------------------------ */

export type DuckConfig = NonNullable<NonNullable<Track['mixChain']>['duck']>

/** 默认 duck 配置：源轨留空 = 引擎自动找鼓组；-6dB 轻微让位 */
export function defaultDuckConfig(sourceTrackId?: string): DuckConfig {
  return {
    enabled: true,
    ...(sourceTrackId ? { sourceTrackId } : {}),
    amountDb: -6,
    attackSec: 0.008,
    releaseSec: 0.18,
  }
}

/** 中性 mixChain（目标轨没有处理链时，为了挂 duck 而创建一条不改变音色的链） */
export function neutralMixChain(duck?: DuckConfig): NonNullable<Track['mixChain']> {
  return {
    enabled: true,
    eq: {
      lowShelf: { hz: 90, gainDb: 0 },
      mid: { hz: 1000, gainDb: 0, q: 0.9 },
      highShelf: { hz: 8000, gainDb: 0 },
    },
    compressor: { thresholdDb: 0, ratio: 1, attackSec: 0.01, releaseSec: 0.2, kneeDb: 0 },
    makeupDb: 0,
    ...(duck ? { duck } : {}),
  }
}

function isDrumTrack(track: Track): boolean {
  if (track.kind === 'drum') return true
  try {
    return getInstrument(track.instrumentId).isDrumKit
  } catch {
    return false
  }
}

/** 找 duck 触发源：显式 sourceTrackId 优先；否则第一个鼓组轨；再否则第一个有音符的其它轨 */
export function resolveDuckSource(
  project: Project,
  duck: DuckConfig | null | undefined,
  targetTrackId: string,
): Track | null {
  if (!duck || duck.enabled === false) return null
  if (duck.sourceTrackId) {
    const explicit = project.tracks.find((track) => track.id === duck.sourceTrackId)
    if (explicit) return explicit
  }
  const drum = project.tracks.find((track) => track.id !== targetTrackId && isDrumTrack(track))
  if (drum) return drum
  return project.tracks.find((track) => track.id !== targetTrackId && track.clips.length > 0) ?? null
}

/** 找默认 duck 目标（贝斯）：名字/乐器带 bass/贝斯优先，其次第一个非鼓、有音符的轨 */
export function findDuckTargetTrack(project: Project): Track | null {
  const candidates = project.tracks.filter((track) => !isDrumTrack(track) && track.clips.length > 0)
  const named = candidates.find((track) => /bass|贝斯/i.test(`${track.name} ${track.instrumentId}`))
  if (named) return named
  return candidates[0] ?? null
}