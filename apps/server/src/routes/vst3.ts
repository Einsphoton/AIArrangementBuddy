/**
 * VST3 插件桥接接口（P6-D 服务端侧）。
 *
 * 设计目标：让 DAW 里的 VST3 插件只依赖一组稳定、窄接口的 HTTP 端点，
 * 不直接碰内部任务/资产路径。插件侧只需要：
 *   1. hello 探活 + 能力协商；
 *   2. 提交生成/重绘/分轨任务（复用 Companion 队列，天然获得优先级/排队/取消）；
 *   3. 轮询任务，拿到 assetId；
 *   4. 下载 WAV 直接送进插件输出。
 *
 * 这些端点与 `/api/companion/*`、`/api/assets/*` 是同一份实现，只是做了面向插件的收窄与
 * 显式的能力描述，避免插件随内部接口演进而碎。
 */
import { createReadStream } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { enrichTask } from '../vst3/bridge.js'
import { assetFilePath, getAsset } from '../storage/assets.js'
import { cancelTask, enqueueTask, getTask, listWorkers } from '../companion/store.js'
import { errorMessage } from '../util.js'

type Json = Record<string, unknown>

const SUPPORTED = new Set(['generate_audio', 'repaint_audio', 'generate_stem'])
const VARIANT: Record<string, 'turbo' | 'sft' | 'base'> = {
  generate_audio: 'turbo',
  repaint_audio: 'sft',
  generate_stem: 'base',
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function registerVst3Routes(app: FastifyInstance): void {
  app.get('/api/vst3/hello', async () => ({
    app: 'ArrangementBuddy',
    bridge: 'vst3-v1',
    features: {
      generate: true,
      repaint: true,
      stem: true,
      priority: true,
      cancel: true,
      assets: 'audio/wav',
    },
    taskTypes: [...SUPPORTED],
    variants: VARIANT,
    onlineWorkers: listWorkers().length,
    hint:
      listWorkers().length === 0
        ? '没有在线 Companion：先在 GPU 机器上启动 scripts/companion.mjs --server <地址> --engine'
        : undefined,
  }))

  app.post<{ Body: Json }>('/api/vst3/generate', async (request, reply) => {
    const body = request.body ?? {}
    const type = str(body.type) ?? 'generate_audio'
    if (!SUPPORTED.has(type)) {
      return reply.code(400).send({ error: `不支持的任务类型：${type}（可用：${[...SUPPORTED].join(', ')}）` })
    }
    const params = (body.params && typeof body.params === 'object' ? body.params : {}) as Json

    // 最小校验：插件端参数错误要立刻得到可读中文，而不是排队后失败
    if (type === 'generate_audio' && !str(params.caption)) {
      return reply.code(400).send({ error: 'generate_audio 需要 params.caption' })
    }
    if (type === 'repaint_audio' || type === 'generate_stem') {
      const sourceAssetId = str(params.sourceAssetId)
      if (!sourceAssetId) return reply.code(400).send({ error: `${type} 需要 params.sourceAssetId` })
      const asset = getAsset(sourceAssetId)
      if (!asset) return reply.code(400).send({ error: `源资产不存在：${sourceAssetId}` })
      if (type === 'repaint_audio') {
        const start = num(params.startSec)
        const end = num(params.endSec)
        if (start === undefined || end === undefined || start < 0 || end <= start) {
          return reply.code(400).send({ error: 'repaint_audio 需要 0 ≤ startSec < endSec' })
        }
        if (end > asset.durationSec + 0.02) {
          return reply.code(400).send({ error: `重绘区间超出音频时长（${asset.durationSec.toFixed(2)}s）` })
        }
        params.sourceDurationSec = asset.durationSec
      }
      if (type === 'generate_stem') {
        const arm = str(params.arm)
        const arms = ['guitar', 'bass', 'drums', 'strings', 'keys', 'synth', 'vocals']
        if (!arm || !arms.includes(arm)) {
          return reply.code(400).send({ error: `generate_stem 需要合法 arm（${arms.join('/')}）` })
        }
        params.sourceDurationSec = asset.durationSec
      }
    }

    if (listWorkers().length === 0) {
      return reply.code(503).send({ error: '没有在线 Companion，无法执行生成任务' })
    }

    let priority: 0 | 1 | 2 = 0
    if (body.priority !== undefined) {
      const raw = num(body.priority)
      if (raw !== 0 && raw !== 1 && raw !== 2) {
        return reply.code(400).send({ error: 'priority 只能是 0/1/2' })
      }
      priority = raw
    }

    try {
      const quality = params.quality === true
      const variantOverride = quality && type === 'generate_audio' ? 'sft' : undefined
      const task = enqueueTask({ type, params, priority, projectId: str(body.projectId), variantOverride })
      return reply.send({
        ...enrichTask(task),
        taskId: task.id,
        status: task.status,
        requiredVariant: VARIANT[type],
        priority: task.priority,
        pollMs: 800,
      })
    } catch (error) {
      return reply.code(500).send({ error: `提交失败：${errorMessage(error)}` })
    }
  })

  app.get<{ Params: { id: string } }>('/api/vst3/tasks/:id', async (request, reply) => {
    const task = getTask(request.params.id)
    if (!task) return reply.code(404).send({ error: '任务不存在' })
    // 只下发插件需要的字段，避免泄露 workerId/params 等内部实现
    return reply.send({
      task: {
        id: task.id,
        type: task.type,
        projectId: task.projectId,
        createdAt: task.createdAt,
        ...enrichTask(task),
      },
    })
  })

  app.post<{ Params: { id: string } }>('/api/vst3/tasks/:id/cancel', async (request, reply) => {
    const task = getTask(request.params.id)
    if (!task) return reply.code(404).send({ error: '任务不存在' })
    const ok = cancelTask(request.params.id)
    if (!ok) return reply.code(409).send({ error: `当前状态 ${task.status} 无法取消` })
    return reply.send({ ok: true })
  })

  app.get<{ Params: { id: string }; Querystring: { peaks?: string } }>(
    '/api/vst3/assets/:id',
    async (request, reply) => {
      const asset = getAsset(request.params.id)
      if (!asset) return reply.code(404).send({ error: '资产不存在' })
      if (request.query?.peaks === '1') {
        return reply.send({
          id: asset.id,
          durationSec: asset.durationSec,
          sampleRate: asset.sampleRate,
          channels: asset.channels,
          peaks: asset.peaks,
        })
      }
      const file = assetFilePath(asset.id)
      if (!file) return reply.code(404).send({ error: '资产文件不存在' })
      reply.header('Content-Type', 'audio/wav')
      reply.header('X-Asset-Duration-Sec', String(asset.durationSec))
      reply.header('X-Asset-Sample-Rate', String(asset.sampleRate))
      return reply.send(createReadStream(file))
    },
  )
}