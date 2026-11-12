/**
 * 本机引擎自动安装 API（P8 / P9 / P10）。
 *
 *   GET  /api/provision/status             平台/已装内容/缺多少/各 profile 是否就绪 + 下载加速配置
 *   GET  /api/provision/sources            当前下载源配置（?probe=1 时做一次代表性探测）
 *   POST /api/provision/install            开始下载安装（body: { profiles?, force?, adapters? }）
 *   GET  /api/provision/jobs/:id           查询安装进度
 *   POST /api/provision/jobs/:id/cancel
 *   GET  /api/provision/jobs               最近安装任务
 *
 *   P10-B 服务器离线包 / 局域网镜像分发：
 *   GET  /api/provision/mirror/manifest    本机可提供的镜像文件清单（serverAssist 开启时）
 *   GET  /api/provision/mirror/file?key=…  按 key 流式返回文件（支持 Range / HEAD / 令牌）
 *   POST /api/provision/package/build      从已安装目录构建服务器离线包（异步任务）
 *   GET  /api/provision/package/jobs/:id   查询离线包构建进度
 *
 * 安全约定：镜像接口只服务 enginePackage 白名单里的 key；离线包文件路径必须落在包目录内；
 * 配置了 serverAssistToken（或环境变量 AIAB_MIRROR_TOKEN）时校验 header `x-aiab-mirror-token` 或 query `token`。
 */
import { createReadStream, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { dataDir } from '../config.js'
import { modelDisplayName } from '@aiab/core'
import {
  buildEnginePackage,
  enginePackageDir,
  listMirrorFiles,
  readEnginePackage,
  resolveMirrorFile,
} from '../provision/enginePackage.js'
import {
  cancelProvisionJob,
  getProvisionJob,
  listProvisionJobs,
  provisionPaths,
  provisionStatus,
  startProvision,
} from '../provision/installer.js'
import {
  ENGINE_RUNTIME_VERSION,
  MODEL_FILES,
  modelsForProfiles,
  profileLabel,
  resolvePlatform,
  type ProvisionProfile,
} from '../provision/manifest.js'
import {
  downloadConfigSummary,
  probeDownloadSources,
  resolveDownloadConfig,
  type ProvisionDownloadConfig,
} from '../provision/sources.js'
import { loadSettings } from '../storage/settings.js'
import { errorMessage } from '../util.js'

type Json = Record<string, unknown>

const VALID_PROFILES: ProvisionProfile[] = ['essential', 'quality', 'stems', 'xl']

function parseProfiles(raw: unknown): ProvisionProfile[] {
  if (raw === undefined || raw === null) return ['essential']
  if (!Array.isArray(raw)) throw new Error('profiles 必须是数组')
  const out: ProvisionProfile[] = []
  for (const item of raw) {
    const value = String(item)
    if (!VALID_PROFILES.includes(value as ProvisionProfile)) {
      throw new Error(`未知 profile：${value}（可用：${VALID_PROFILES.join(' / ')}）`)
    }
    if (!out.includes(value as ProvisionProfile)) out.push(value as ProvisionProfile)
  }
  if (out.length === 0) throw new Error('至少选择一个 profile')
  return out
}

/** 当前下载配置（settings + 环境变量，见 provision/sources.ts） */
function currentDownloadConfig(): ProvisionDownloadConfig {
  return resolveDownloadConfig(loadSettings())
}

/**
 * 服务端运行时摘要（mirror manifest 附带）：
 * 优先读 `<dataDir>/audio-engine/runtime.json`（P9 契约：Companion 只读 api 字段判断 legacy/modern；
 * 旧目录 ace-step 会被安装器/状态读取时自动迁移），读不到时退回 provisionStatus 的计划值；
 * 版本号按 branding 口径返回（内部打包名不暴露），任何异常都返回 null 字段，绝不 500。
 */
function serverRuntimeSummary(): { api: 'modern' | 'legacy' | null; version: string | null; platform: string | null } {
  try {
    const raw = JSON.parse(readFileSync(path.join(provisionPaths(dataDir).root, 'runtime.json'), 'utf8')) as {
      api?: unknown
      version?: unknown
      platform?: unknown
    }
    const api = raw.api === 'modern' ? 'modern' : raw.api === 'legacy' ? 'legacy' : null
    const rawVersion = typeof raw.version === 'string' && raw.version ? raw.version : null
    return {
      api,
      version: rawVersion && /^\d+(\.\d+){1,3}$/.test(rawVersion) ? rawVersion : ENGINE_RUNTIME_VERSION,
      platform: typeof raw.platform === 'string' && raw.platform ? raw.platform : null,
    }
  } catch {
    /* 没有 runtime.json：回退到安装计划 */
  }
  try {
    const runtime = provisionStatus({ dataDir }).runtime
    return { api: runtime.api, version: runtime.version ?? null, platform: resolvePlatform() }
  } catch {
    return { api: null, version: null, platform: null }
  }
}

/* ------------------------------------------------------------------ */
/* 服务器镜像令牌                                                       */
/* ------------------------------------------------------------------ */

function presentedMirrorToken(request: FastifyRequest<{ Querystring?: { token?: unknown } }>): string {
  const header = request.headers['x-aiab-mirror-token']
  if (typeof header === 'string' && header) return header
  if (Array.isArray(header) && header[0]) return String(header[0])
  const token = request.query?.token
  if (typeof token === 'string') return token
  if (Array.isArray(token) && token[0] !== undefined) return String(token[0])
  return ''
}

/** 定长比较，避免按前缀泄露令牌 */
function mirrorTokenMatches(expected: string, presented: string): boolean {
  if (!expected) return true
  const left = `${expected}`
  const right = `${presented}`
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index++) diff |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return diff === 0
}

/** 返回 401 响应体；令牌校验通过返回 null */
function mirrorAuthError(
  config: ProvisionDownloadConfig,
  request: FastifyRequest<{ Querystring?: { token?: unknown } }>,
): { error: string } | null {
  if (mirrorTokenMatches(config.serverAssistToken, presentedMirrorToken(request))) return null
  return { error: '服务器镜像令牌无效：请使用 header x-aiab-mirror-token 或 query token（见设置 → 引擎下载）' }
}

/* ------------------------------------------------------------------ */
/* 离线包构建任务（内存态；同一时刻只跑一个）                            */
/* ------------------------------------------------------------------ */

interface PackageBuildJobResult {
  dir: string
  files: number
  bytes: number
  copied: number
  linked: number
  warnings: string[]
}

interface PackageBuildJob {
  id: string
  status: 'running' | 'done' | 'failed' | 'canceled'
  progress: number
  message: string
  startedAt: number
  updatedAt: number
  error?: string
  result?: PackageBuildJobResult
}

const packageJobs = new Map<string, PackageBuildJob>()
let activePackageJobId: string | null = null
let activePackageAbort: AbortController | null = null
const MAX_PACKAGE_JOBS = 20

function trimPackageJobs(): void {
  if (packageJobs.size <= MAX_PACKAGE_JOBS) return
  const finished = [...packageJobs.values()]
    .filter((job) => job.status !== 'running')
    .sort((left, right) => left.startedAt - right.startedAt)
  for (const job of finished) {
    if (packageJobs.size <= MAX_PACKAGE_JOBS) break
    packageJobs.delete(job.id)
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 路由                                                            */
/* ------------------------------------------------------------------ */

export function registerProvisionRoutes(app: FastifyInstance): void {
  /* ---------------- 状态 ---------------- */

  app.get('/api/provision/status', async () => {
    try {
      const platform = resolvePlatform()
      const status = provisionStatus({ dataDir, platform })
      const profiles = (['essential', 'quality', 'stems', 'xl'] as ProvisionProfile[]).map((profile) => {
        const files = modelsForProfiles([profile])
        return {
          id: profile,
          label: profileLabel(profile),
          // 只暴露展示名：真实权重文件名属于实现细节，界面上不出现
          files: files.map((file) => modelDisplayName(file.name)),
          downloadBytes: files.reduce((sum, file) => sum + file.size, 0),
          ready: status.profiles[profile],
        }
      })
      const config = currentDownloadConfig()
      const pkg = readEnginePackage(dataDir, config.packageDir || undefined)
      const resolvedPackageDir = pkg?.dir ?? enginePackageDir(dataDir, config.packageDir || undefined)
      const download = {
        ...downloadConfigSummary(config),
        // 已解析的离线包目录（settings.packageDir 为空时是 <dataDir>/engine-package）
        packagePath: resolvedPackageDir,
        packagePresent: Boolean(pkg),
        packageFiles: pkg?.manifest.files.length ?? 0,
        packageBytes: pkg ? pkg.manifest.files.reduce((sum, file) => sum + file.size, 0) : 0,
        packagePlatform: pkg?.manifest.platform,
      }
      // 接口层也不回传真实权重文件名 / 可执行文件路径（只保留展示名 + 安装状态），避免绕过界面泄露
      const runtime = {
        installed: status.runtime.installed,
        sizeBytes: status.runtime.sizeBytes,
        version: status.runtime.version,
      }
      const adapters = status.adapters.map((adapter) => ({
        ...adapter,
        // 适配器许可属于上游权重信息，界面/接口统一用产品口径
        license: '自生成数据，可安全分发',
      }))
      const models = status.models.map((model) => ({
        displayName: model.displayName,
        installed: model.installed,
        sizeBytes: model.sizeBytes,
        expectedBytes: model.expectedBytes,
        profiles: model.profiles,
      }))
      return { ...status, runtime, models, adapters, profiles, dataDir, download, jobs: listProvisionJobs().slice(0, 3) }
    } catch (error) {
      return { supported: false, platform: `${process.platform}/${process.arch}`, error: errorMessage(error) }
    }
  })

  /* ---------------- 下载源配置 / 测速 ---------------- */

  app.get<{ Querystring: { probe?: unknown } }>('/api/provision/sources', async (request) => {
    const config = currentDownloadConfig()
    const rawProbe = request.query?.probe
    const probe = rawProbe === '1' || rawProbe === 1 || rawProbe === true
    if (!probe) return { config: downloadConfigSummary(config), results: [] }
    try {
      const timeoutMs = config.probeTimeoutMs > 0 ? Math.min(config.probeTimeoutMs, 5000) : 5000
      return await probeDownloadSources(config, { timeoutMs })
    } catch (error) {
      // 探测失败不 500：返回配置 + 空结果 + 错误说明
      return { config: downloadConfigSummary(config), results: [], error: errorMessage(error) }
    }
  })

  /* ---------------- 安装 ---------------- */

  app.post<{ Body: Json }>('/api/provision/install', async (request, reply) => {
    const body = request.body ?? {}
    try {
      const profiles = parseProfiles(body.profiles)
      const force = body.force === true
      const adapters = body.adapters !== false
      // 对象变量传递（而不是内联字面量）：A 给 startProvision 加 download 参数后自然生效
      const installOptions = {
        dataDir,
        profiles,
        force,
        adapters,
        download: currentDownloadConfig(),
      }
      const job = startProvision(installOptions)
      return reply.send({ jobId: job.id, job })
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }
  })

  app.get<{ Params: { id: string } }>('/api/provision/jobs/:id', async (request, reply) => {
    const job = getProvisionJob(request.params.id)
    if (!job) return reply.code(404).send({ error: '安装任务不存在' })
    return reply.send({ job })
  })

  app.get('/api/provision/jobs', async () => ({ jobs: listProvisionJobs().slice(0, 10) }))

  app.post<{ Params: { id: string } }>('/api/provision/jobs/:id/cancel', async (request, reply) => {
    const ok = cancelProvisionJob(request.params.id)
    if (!ok) return reply.code(409).send({ error: '任务未在运行（或已结束）' })
    return reply.send({ ok: true })
  })

  /* ---------------- 服务器镜像（局域网共享） ---------------- */

  app.get<{ Querystring: { token?: unknown } }>('/api/provision/mirror/manifest', async (request, reply) => {
    const config = currentDownloadConfig()
    // 运行时摘要：供 `provision.mjs fetch` 在目标目录写 runtime.json（api/version/platform）
    const runtime = serverRuntimeSummary()
    if (!config.serverAssist) return reply.send({ enabled: false, package: null, files: [], runtime })
    const authError = mirrorAuthError(config, request)
    if (authError) return reply.code(401).send(authError)
    const pkg = readEnginePackage(dataDir, config.packageDir || undefined)
    const files = listMirrorFiles(dataDir, { packageDir: config.packageDir || undefined }).map((file) => {
      // 模型的 profile 归属附带给 CLI（fetch --profile 过滤用），不影响既有字段
      const model = file.key.startsWith('model/') ? MODEL_FILES.find((item) => `model/${item.name}` === file.key) : undefined
      return model ? { ...file, profiles: model.profiles } : file
    })
    return reply.send({ enabled: true, package: pkg?.manifest ?? null, files, packageDir: pkg?.dir ?? null, runtime })
  })

  app.route<{ Querystring: { key?: unknown; token?: unknown }; Params: Record<string, never> }>({
    method: ['GET', 'HEAD'],
    url: '/api/provision/mirror/file',
    async handler(request, reply) {
      const config = currentDownloadConfig()
      if (!config.serverAssist) {
        return reply.code(404).send({ error: '服务器助攻未开启（settings.provision.serverAssist=false），没有可共享的镜像文件' })
      }
      const authError = mirrorAuthError(config, request)
      if (authError) return reply.code(401).send(authError)
      const rawKey = request.query?.key
      const key = typeof rawKey === 'string' ? rawKey : ''
      if (!key) return reply.code(400).send({ error: '缺少 key 参数（如 key=runtime/ace-server.exe）' })
      const file = resolveMirrorFile(dataDir, key, { packageDir: config.packageDir || undefined })
      if (!file) return reply.code(404).send({ error: `镜像里没有该文件：${key}（离线包/下载缓存中不存在或 key 不合法）` })
      const size = file.size
      const range = parseByteRange(request.headers.range, size)
      if (range === 'invalid') {
        return reply
          .code(416)
          .headers({ 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${size}` })
          .send({ error: `Range 请求不合法（文件大小 ${size}）` })
      }
      const headers: Record<string, string> = {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file.path))}`,
        'Cache-Control': 'no-store',
      }
      if (range) {
        const length = range.end - range.start + 1
        headers['Content-Length'] = String(length)
        headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`
        if (request.method === 'HEAD') return reply.code(206).headers(headers).send()
        return reply.code(206).headers(headers).send(createReadStream(file.path, { start: range.start, end: range.end }))
      }
      headers['Content-Length'] = String(size)
      if (request.method === 'HEAD') return reply.code(200).headers(headers).send()
      if (size === 0) return reply.code(200).headers(headers).send()
      return reply.code(200).headers(headers).send(createReadStream(file.path))
    },
  })

  /* ---------------- 离线包构建 ---------------- */

  app.post<{ Body: Json }>('/api/provision/package/build', async (request, reply) => {
    const body = request.body ?? {}
    try {
      const profiles = parseProfiles(body.profiles)
      const includeTraining = body.includeTraining === true
      const adapters = body.adapters !== false
      const config = currentDownloadConfig()
      const rawOutDir = typeof body.outDir === 'string' ? body.outDir.trim() : ''
      const outDir = rawOutDir ? path.resolve(rawOutDir) : config.packageDir || undefined
      if (activePackageJobId) {
        const running = packageJobs.get(activePackageJobId)
        if (running && running.status === 'running') {
          return reply.code(409).send({ error: '已有离线包构建任务在进行中，请等待完成', jobId: running.id })
        }
      }
      const id = `pkg_${Date.now().toString(36)}`
      const job: PackageBuildJob = {
        id,
        status: 'running',
        progress: 0,
        message: '准备构建离线包…',
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }
      packageJobs.set(id, job)
      activePackageJobId = id
      const abort = new AbortController()
      activePackageAbort = abort
      void (async () => {
        try {
          const result = await buildEnginePackage({
            dataDir,
            outDir,
            profiles,
            includeTraining,
            adapters,
            signal: abort.signal,
            onProgress: (progress, message) => {
              job.progress = Math.max(0, Math.min(1, progress))
              job.message = message
              job.updatedAt = Date.now()
            },
            log: (message) => {
              job.message = message
              job.updatedAt = Date.now()
            },
          })
          job.status = 'done'
          job.progress = 1
          job.result = {
            dir: result.dir,
            files: result.manifest.files.length,
            bytes: result.bytes,
            copied: result.copied,
            linked: result.linked,
            warnings: result.warnings,
          }
          job.message =
            `离线包已生成：${result.manifest.files.length} 个文件 / ${(result.bytes / 1e9).toFixed(2)}GB` +
            (result.warnings.length > 0 ? `（${result.warnings.length} 个文件被跳过）` : '')
        } catch (error) {
          job.status = abort.signal.aborted ? 'canceled' : 'failed'
          job.error = abort.signal.aborted ? '已取消' : errorMessage(error)
          job.message = job.error
        } finally {
          job.updatedAt = Date.now()
          if (activePackageJobId === id) {
            activePackageJobId = null
            activePackageAbort = null
          }
          trimPackageJobs()
        }
      })()
      return reply.send({ jobId: job.id, job: { ...job } })
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }
  })

  app.get<{ Params: { id: string } }>('/api/provision/package/jobs/:id', async (request, reply) => {
    const job = packageJobs.get(request.params.id)
    if (!job) return reply.code(404).send({ error: '离线包构建任务不存在' })
    return reply.send({ job: { ...job } })
  })

  app.post<{ Params: { id: string } }>('/api/provision/package/jobs/:id/cancel', async (request, reply) => {
    if (request.params.id !== activePackageJobId || !activePackageAbort) {
      return reply.code(409).send({ error: '离线包构建任务未在运行（或已结束）' })
    }
    activePackageAbort.abort()
    return reply.send({ ok: true })
  })
}

/* ------------------------------------------------------------------ */
/* HTTP Range 解析                                                      */
/* ------------------------------------------------------------------ */

/**
 * 解析单段 Range 请求（视频/大文件续传常用）：
 * - `bytes=start-end` / `bytes=start-` / `bytes=-suffix`；
 * - 没有 Range → null（整文件）；
 * - 不合法 → 'invalid'（调用方返回 416）。
 */
function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'invalid'
  const startRaw = match[1] ?? ''
  const endRaw = match[2] ?? ''
  if (!startRaw && !endRaw) return 'invalid'
  if (size <= 0) return 'invalid'
  if (!startRaw) {
    const suffix = Number(endRaw)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    const start = Math.max(0, size - suffix)
    return { start, end: size - 1 }
  }
  const start = Number(startRaw)
  if (!Number.isFinite(start) || start >= size || start < 0) return 'invalid'
  const end = endRaw ? Math.min(Number(endRaw), size - 1) : size - 1
  if (!Number.isFinite(end) || end < start) return 'invalid'
  return { start, end }
}

/** 供测试/CLI 使用的 Range 解析导出（不参与路由注册） */
export { parseByteRange }
