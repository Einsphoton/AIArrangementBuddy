/**
 * 服务端运行配置（路径 / 端口 / 外部工具探测缓存）。
 *
 * 所有路径都从「仓库根目录」推导，方便开发时用 tsx 直接跑，也方便生产打包后运行。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const SERVER_VERSION = '0.1.0'

/** 仓库根目录：apps/server/src/config.ts -> ../../../ */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** 数据目录：工程、设置、音色库、Agent 会话都放这里 */
export const dataDir = process.env.DATA_DIR || process.env.AIAB_DATA_DIR || path.join(repoRoot, 'data')

export const projectsDir = path.join(dataDir, 'projects')
export const soundfontsDir = path.join(dataDir, 'soundfonts')
export const agentSessionsDir = path.join(dataDir, 'agent-sessions')
/** AI 运行日志（JSONL，每次 /api/ai/chat 一条），便于事后抓取失败原因 */
export const aiLogsDir = path.join(dataDir, 'logs')
export const settingsFile = path.join(dataDir, 'settings.json')
export const webDistDir = path.join(repoRoot, 'apps', 'web', 'dist')
export const mcpDistEntry = path.join(repoRoot, 'apps', 'server', 'dist', 'mcp.mjs')
export const mcpSrcEntry = path.join(repoRoot, 'apps', 'server', 'src', 'mcp', 'server.ts')
/** tsx 可执行文件（开发态启动 MCP server 用） */
export const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx')

export const port = Number(process.env.PORT || 8787)
export const host = process.env.HOST || '127.0.0.1'
export const serveStatic = process.env.SERVE_STATIC === '1'
export const logLevel = process.env.LOG_LEVEL || 'info'

export function ensureDataDirs(): void {
  for (const dir of [dataDir, projectsDir, soundfontsDir, agentSessionsDir, aiLogsDir]) {
    mkdirSync(dir, { recursive: true })
  }
}

/** MCP server 的启动方式：生产用打包产物，开发态回退到 tsx + 源码 */
export function resolveMcpLaunch(): { command: string; args: string[] } {
  if (existsSync(mcpDistEntry)) return { command: process.execPath, args: [mcpDistEntry] }
  if (existsSync(tsxBin)) return { command: tsxBin, args: [mcpSrcEntry] }
  // 极端兜底：node --import tsx（要求 tsx 能被 node 解析到）
  return { command: process.execPath, args: ['--import', 'tsx', mcpSrcEntry] }
}

/** ffmpeg 可用性（结果缓存，避免每次 /api/health 都 spawn） */
let ffmpegCache: { checkedAt: number; available: boolean; version?: string } | null = null

export function detectFfmpeg(): { available: boolean; version?: string } {
  const now = Date.now()
  if (ffmpegCache && now - ffmpegCache.checkedAt < 30_000) {
    return { available: ffmpegCache.available, version: ffmpegCache.version }
  }
  let available = false
  let version: string | undefined
  try {
    const result = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { encoding: 'utf8', timeout: 5000 })
    if (result.status === 0 && result.stdout) {
      available = true
      version = result.stdout.split('\n')[0]?.trim()
    }
  } catch {
    available = false
  }
  ffmpegCache = { checkedAt: now, available, version }
  return { available, version }
}

/** 在 PATH 中查找可执行文件（macOS/Linux 用 which，Windows 用 where） */
export function whichCommand(command: string): string | null {
  if (!command) return null
  if (command.includes('/') || command.includes('\\')) {
    return existsSync(command) ? command : null
  }
  try {
    const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], {
      encoding: 'utf8',
      timeout: 5000,
    })
    if (result.status === 0 && result.stdout) {
      const first = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
      return first ?? null
    }
  } catch {
    /* ignore */
  }
  return null
}

/** 执行 `--version` 之类的探测命令，失败返回 undefined */
export function probeVersion(binPath: string, args: string[] = ['--version'], timeoutMs = 8000): string | undefined {
  try {
    const result = spawnSync(binPath, args, { encoding: 'utf8', timeout: timeoutMs })
    if (result.status === 0) {
      const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
      const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
      return line || undefined
    }
  } catch {
    /* ignore */
  }
  return undefined
}
