/** 元信息路由：/api/health、/api/agents。 */
import type { FastifyInstance } from 'fastify'
import { SERVER_VERSION, dataDir, detectFfmpeg } from '../config.js'
import { probeAgents } from '../agent/probe.js'
import { loadSettings } from '../storage/settings.js'
import { listSoundfontFiles } from '../soundfonts.js'

const startedAt = Date.now()

export function registerMetaRoutes(app: FastifyInstance): void {
  app.get('/api/health', async () => {
    const settings = loadSettings()
    const ffmpeg = detectFfmpeg()
    const agents = probeAgents(settings)
    return {
      ok: true,
      version: SERVER_VERSION,
      node: process.version,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      dataDir,
      soundfonts: listSoundfontFiles().map((file) => ({ name: file.name, url: file.url, size: file.size })),
      ffmpeg: ffmpeg.available,
      ffmpegVersion: ffmpeg.version,
      agents: agents.map((agent) => ({
        backend: agent.backend,
        available: agent.available,
        version: agent.version,
        path: agent.path,
      })),
    }
  })

  app.get('/api/agents', async (_request, reply) => {
    const settings = loadSettings()
    return reply.send(
      probeAgents(settings, true).map((agent) => ({
        backend: agent.backend,
        available: agent.available,
        version: agent.version,
        path: agent.path,
        note: agent.note,
      })),
    )
  })
}
