/**
 * 本机引擎自动安装 API（P8）。
 *
 *   GET  /api/provision/status        平台/已装内容/缺多少/各 profile 是否就绪
 *   POST /api/provision/install       开始下载安装（body: { profiles?: ['essential'|'quality'|'stems'], force? }）
 *   GET  /api/provision/jobs/:id      查询进度
 *   POST /api/provision/jobs/:id/cancel
 *   GET  /api/provision/jobs          最近任务
 */
import type { FastifyInstance } from 'fastify'
import { dataDir } from '../config.js'
import {
  cancelProvisionJob,
  getProvisionJob,
  listProvisionJobs,
  provisionStatus,
  startProvision,
} from '../provision/installer.js'
import { modelsForProfiles, profileLabel, resolvePlatform, type ProvisionProfile } from '../provision/manifest.js'
import { errorMessage } from '../util.js'

type Json = Record<string, unknown>

const VALID_PROFILES: ProvisionProfile[] = ['essential', 'quality', 'stems']

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

export function registerProvisionRoutes(app: FastifyInstance): void {
  app.get('/api/provision/status', async () => {
    try {
      const platform = resolvePlatform()
      const status = provisionStatus({ dataDir, platform })
      const profiles = (['essential', 'quality', 'stems'] as ProvisionProfile[]).map((profile) => {
        const files = modelsForProfiles([profile])
        return {
          id: profile,
          label: profileLabel(profile),
          files: files.map((file) => file.name),
          downloadBytes: files.reduce((sum, file) => sum + file.size, 0),
          ready: status.profiles[profile],
        }
      })
      return { ...status, profiles: profiles, dataDir, jobs: listProvisionJobs().slice(0, 3) }
    } catch (error) {
      return { supported: false, platform: `${process.platform}/${process.arch}`, error: errorMessage(error) }
    }
  })

  app.post<{ Body: Json }>('/api/provision/install', async (request, reply) => {
    const body = request.body ?? {}
    try {
      const profiles = parseProfiles(body.profiles)
      const force = body.force === true
      const adapters = body.adapters !== false
      const job = startProvision({ dataDir, profiles, force, adapters })
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
}