/** 外部 Agent（Codex CLI / DeepSeek Harness）可用性探测。 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import type { AppSettings } from '@aiab/core'
import { probeVersion, whichCommand } from '../config.js'
import { getActiveProvider, providerReady } from '../storage/settings.js'
import type { AgentBackendId } from './types.js'

export interface AgentProbe {
  backend: AgentBackendId
  available: boolean
  version?: string
  path?: string
  /** 补充说明（配置问题 / 为什么不可用） */
  note?: string
}

interface CacheEntry {
  at: number
  value: AgentProbe[]
}

let cache: CacheEntry | null = null

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || ''
}

const DSH_CANDIDATES = (): string[] => {
  const home = homeDir()
  const candidates: string[] = []
  if (process.env.AIAB_DSH_BIN) candidates.push(process.env.AIAB_DSH_BIN)
  candidates.push('dsh', 'deepseek-harness', 'dsh-cli')
  if (home) {
    candidates.push(path.join(home, '.local', 'bin', 'dsh'))
    candidates.push(path.join(home, '.cargo', 'bin', 'dsh'))
    candidates.push(path.join(home, 'bin', 'dsh'))
  }
  candidates.push('/usr/local/bin/dsh', '/opt/homebrew/bin/dsh')
  return candidates
}

/** 解析 codex 可执行文件路径（设置优先，其次 PATH） */
export function resolveCodexPath(settings: AppSettings): string | null {
  const configured = settings.agent.executablePath?.trim()
  if (configured) {
    if (existsSync(configured)) return configured
    const found = whichCommand(configured)
    if (found) return found
  }
  return whichCommand(process.env.AIAB_CODEX_BIN || 'codex')
}

/** 解析 dsh 可执行文件路径（设置优先，其次候选列表） */
export function resolveDshPath(settings: AppSettings): string | null {
  const configured = settings.agent.executablePath?.trim()
  if (configured && existsSync(configured)) return configured
  for (const candidate of DSH_CANDIDATES()) {
    const found = whichCommand(candidate)
    if (found) return found
  }
  return null
}

export function probeCodex(settings: AppSettings): AgentProbe {
  const codexPath = resolveCodexPath(settings)
  if (!codexPath) {
    return {
      backend: 'codex',
      available: false,
      note: '未找到 codex 命令。安装：npm i -g @openai/codex，或在设置里填写可执行文件路径。',
    }
  }
  const version = probeVersion(codexPath, ['--version'])
  return { backend: 'codex', available: true, path: codexPath, version, note: version ? undefined : 'codex 存在但 --version 执行失败' }
}

export function probeDsh(settings: AppSettings): AgentProbe {
  const dshPath = resolveDshPath(settings)
  if (!dshPath) {
    return {
      backend: 'dsh',
      available: false,
      note: '未检测到 DSH（DeepSeek Harness）CLI。可在设置里填写可执行文件路径，或使用内置 Agent。',
    }
  }
  const version = probeVersion(dshPath, ['--version'])
  return { backend: 'dsh', available: true, path: dshPath, version }
}

/** 内置 Agent 是否可用（取决于是否配置了可用的服务商） */
export function probeBuiltin(settings: AppSettings): AgentProbe {
  const provider = getActiveProvider(settings)
  if (!provider) return { backend: 'builtin', available: false, note: '尚未配置 AI 服务商' }
  const ready = providerReady(provider)
  return {
    backend: 'builtin',
    available: ready.ready,
    version: provider.model || undefined,
    path: provider.baseUrl || undefined,
    note: ready.ready ? `${provider.name} · ${provider.model}` : ready.reason,
  }
}

/** 探测三种后端（缓存 15 秒，避免健康检查频繁 spawn） */
export function probeAgents(settings: AppSettings, force = false): AgentProbe[] {
  const now = Date.now()
  if (!force && cache && now - cache.at < 15_000) return cache.value
  const value = [probeBuiltin(settings), probeCodex(settings), probeDsh(settings)]
  cache = { at: now, value }
  return value
}

export function invalidateAgentProbe(): void {
  cache = null
}
