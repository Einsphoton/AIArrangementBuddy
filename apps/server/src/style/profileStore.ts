/**
 * 风格画像仓库：把 `data/corpus/profiles/*.json` 提供给生成器与 Agent 提示词。
 *
 * 职责边界：
 * - `packages/core` 只认 `StyleProfile` 数据结构，不碰文件；
 * - 这里负责读盘、缓存、把「工程风格 StyleId」映射到「语料画像名称」。
 *
 * 画像由 `pnpm corpus:profile <目录> --style <名字>` 产出。
 * 没有画像时所有函数返回 undefined，生成器行为与引入画像之前完全一致。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { coerceStyleProfile, describeProfile, type StyleId, type StyleProfile } from '@aiab/core'
import { dataDir } from '../config.js'

/** 语料画像目录（与 `scripts/corpus/profile.mjs` 的默认输出一致） */
export const profilesDir = path.join(dataDir, 'corpus', 'profiles')

const CACHE_TTL_MS = 5_000

let cache: { at: number; byName: Map<string, StyleProfile> } | null = null

function readProfiles(): Map<string, StyleProfile> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.byName

  const byName = new Map<string, StyleProfile>()
  if (existsSync(profilesDir)) {
    let entries: string[] = []
    try {
      entries = readdirSync(profilesDir).filter((name) => name.endsWith('.json'))
    } catch {
      entries = []
    }
    for (const name of entries) {
      const file = path.join(profilesDir, name)
      try {
        // 目录可能被外部脚本重写；按 mtime 简单跳过明显过旧的情况在这里不需要，TTL 足够
        if (!statSync(file).isFile()) continue
        const parsed = coerceStyleProfile(JSON.parse(readFileSync(file, 'utf8')))
        if (parsed) byName.set(parsed.style, parsed)
      } catch {
        // 单个坏文件不影响其它画像
      }
    }
  }

  cache = { at: now, byName }
  return byName
}

/** 已加载的画像（按 style 名字索引） */
export function listProfiles(): StyleProfile[] {
  return [...readProfiles().values()]
}

export function getProfile(styleName: string): StyleProfile | undefined {
  return readProfiles().get(styleName)
}

/**
 * 工程风格 → 语料画像的候选顺序。
 * 工程用的是 9 个内置 StyleId，而语料画像用的是用户自己的风格名（j-rock / jrpg …），
 * 这里做一层「最接近的内置风格」映射；找不到就返回 undefined（回落到内置常量）。
 */
const STYLE_CANDIDATES: Record<StyleId, string[]> = {
  rock: ['j-rock', 'post-hardcore', 'alt-rock', 'britpop', 'rock'],
  pop: ['britpop', 'j-pop', 'pop'],
  cinematic: ['jrpg', 'cinematic', 'orchestral'],
  classical: ['classical', 'jrpg'],
  jazz: ['jazz'],
  electronic: ['electronic', 'edm'],
  folk: ['folk', 'acoustic'],
  jrock: ['j-rock', 'jrock', 'post-hardcore', 'alt-rock', 'britpop', 'rock'],
  jrpg: ['jrpg', 'vgm', 'game-music', 'orchestral', 'cinematic'],
}

/** 按内置风格取画像（精确同名 > 候选列表） */
export function profileForStyle(style: StyleId): StyleProfile | undefined {
  const profiles = readProfiles()
  const exact = profiles.get(style)
  if (exact) return exact
  for (const candidate of STYLE_CANDIDATES[style] ?? []) {
    const found = profiles.get(candidate)
    if (found) return found
  }
  return undefined
}

/**
 * 注入系统提示的「风格卡」文本。
 * 只在有画像时返回内容；一次最多列 3 条，避免把提示词撑爆。
 */
export function styleCardsText(style: StyleId, limit = 3): string | undefined {
  const profile = profileForStyle(style)
  if (!profile) return undefined
  const others = listProfiles()
    .filter((item) => item.style !== profile.style)
    .slice(0, Math.max(0, limit - 1))
  const lines = [describeProfile(profile), ...others.map((item) => describeProfile(item))]
  return `以下是本地语料统计出的风格参考（来自真实 MIDI 语料的聚合统计，不是臆测）：\n${lines.join('\n')}\n生成时请让和弦变化频率、音符密度、音区与力度尽量贴近这些数值。`
}
