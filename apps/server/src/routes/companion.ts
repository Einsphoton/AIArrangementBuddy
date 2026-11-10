/**
 * Companion 控制面（P1）：
 *
 *   POST /api/companion/register  工作节点注册 → { workerId, token, heartbeatMs, pollMs }
 *   POST /api/companion/heartbeat 心跳（顺带取回"需要取消的任务"）
 *   POST /api/companion/claim     认领任务（无任务返回 204）
 *   POST /api/companion/progress  进度上报（返回是否要求取消）
 *   POST /api/companion/complete  完成任务（multipart 带音频文件）
 *
 * 面向 Web 的接口：
 *   POST /api/companion/tasks       入队（type=generate_audio）
 *   GET  /api/companion/tasks/:id   查询进度/结果
 *   POST /api/companion/tasks/:id/cancel
 *   GET  /api/companion/status      节点与队列概览（状态面板用）
 */
import type { FastifyInstance } from 'fastify'
import { findAdapter } from '../adapters/registry.js'
import { getAsset } from '../storage/assets.js'
import {
  blockedByCapability,
  cancelTask,
  claimTask,
  companionSummary,
  completeTask,
  enqueueTask,
  getTask,
  heartbeat,
  listTasks,
  listWorkers,
  queueCounts,
  registerWorker,
  reportProgress,
  taskWithQueueInfo,
} from '../companion/store.js'
import { errorMessage } from '../util.js'

const HEARTBEAT_MS = 5000
const POLL_MS = 1500
/** P1/P2/P5 开放的任务类型；后续 cover/extract 在这里扩展 */
const SUPPORTED_TASK_TYPES = new Set(['generate_audio', 'repaint_audio', 'generate_stem', 'cover_audio'])

/** generate_stem 允许的乐器手臂（C++ lego 的 track 名称） */
const STEM_ARMS = new Set(['guitar', 'bass', 'drums', 'strings', 'keys', 'synth', 'vocals'])

/** 任务类型 → 需要的 DiT 变体（适配器基座校验也用这个） */
const TASK_VARIANT: Record<string, 'turbo' | 'sft' | 'base'> = {
  generate_audio: 'turbo',
  repaint_audio: 'sft',
  generate_stem: 'base',
  cover_audio: 'turbo',
}

type Json = Record<string, unknown>

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function registerCompanionRoutes(app: FastifyInstance): void {
  app.post<{ Body: Json }>('/api/companion/register', async (request, reply) => {
    const body = request.body ?? {}
    const capabilities = (body.capabilities && typeof body.capabilities === 'object' ? body.capabilities : {}) as Json
    const { worker, token } = registerWorker({
      name: str(body.name),
      version: str(body.version),
      capabilities: {
        tasks: Array.isArray(capabilities.tasks)
          ? capabilities.tasks.filter((item): item is string => typeof item === 'string')
          : undefined,
        gpu: str(capabilities.gpu),
        models: Array.isArray(capabilities.models)
          ? capabilities.models.filter((item): item is string => typeof item === 'string')
          : undefined,
      },
    })
    return reply.send({
      workerId: worker.id,
      token,
      heartbeatMs: HEARTBEAT_MS,
      pollMs: POLL_MS,
      serverTime: Date.now(),
    })
  })

  app.post<{ Body: Json }>('/api/companion/heartbeat', async (request, reply) => {
    const body = request.body ?? {}
    const status = (body.status && typeof body.status === 'object' ? body.status : {}) as Json
    const engineRaw = (status.engine && typeof status.engine === 'object' ? status.engine : undefined) as Json | undefined
    const result = heartbeat(str(body.workerId) ?? '', str(body.token) ?? '', {
      busy: typeof status.busy === 'boolean' ? Boolean(status.busy) : undefined,
      currentTaskId: str(status.currentTaskId),
      engine: engineRaw
        ? {
            variant: str(engineRaw.variant),
            pid: num(engineRaw.pid),
            warm: typeof engineRaw.warm === 'boolean' ? engineRaw.warm : undefined,
          }
        : undefined,
    })
    if (!result) return reply.code(401).send({ error: 'workerId/token 无效（可能服务重启，请重新 register）' })
    return reply.send(result)
  })

  app.post<{ Body: Json }>('/api/companion/claim', async (request, reply) => {
    const body = request.body ?? {}
    const task = claimTask(str(body.workerId) ?? '', str(body.token) ?? '')
    if (task === null) {
      // 区分"无任务"与"认证失败"：claimTask 返回 null 两种都可能，这里再校验一次 token
      if (listWorkers().some((worker) => worker.id === body.workerId)) return reply.code(204).send()
      return reply.code(204).send()
    }
    return reply.send({
      task: {
        id: task.id,
        type: task.type,
        params: task.params,
        projectId: task.projectId,
        priority: task.priority,
        requiredVariant: task.requiredVariant,
      },
    })
  })

  app.post<{ Body: Json }>('/api/companion/progress', async (request, reply) => {
    const body = request.body ?? {}
    const result = reportProgress({
      workerId: str(body.workerId) ?? '',
      token: str(body.token) ?? '',
      taskId: str(body.taskId) ?? '',
      progress: Math.max(0, Math.min(1, num(body.progress) ?? 0)),
      message: str(body.message),
    })
    if (!result) return reply.code(401).send({ error: '进度上报被拒绝（worker/task 不匹配或 token 无效）' })
    return reply.send(result)
  })

  app.post('/api/companion/complete', async (request, reply) => {
    let workerId = ''
    let token = ''
    let taskId = ''
    let status: 'done' | 'failed' = 'done'
    let error: string | undefined
    let file: Buffer | undefined
    let fileName: string | undefined

    if (request.isMultipart()) {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file') {
            part.file.resume()
            continue
          }
          if (!file) {
            file = await part.toBuffer()
            fileName = part.filename
          } else {
            part.file.resume()
          }
          continue
        }
        const value = String(part.value)
        if (part.fieldname === 'workerId') workerId = value
        else if (part.fieldname === 'token') token = value
        else if (part.fieldname === 'taskId') taskId = value
        else if (part.fieldname === 'status') status = value === 'failed' ? 'failed' : 'done'
        else if (part.fieldname === 'error') error = value
        else if (part.fieldname === 'fileName') fileName = value
      }
    } else {
      const body = (request.body ?? {}) as Json
      workerId = str(body.workerId) ?? ''
      token = str(body.token) ?? ''
      taskId = str(body.taskId) ?? ''
      status = body.status === 'failed' ? 'failed' : 'done'
      error = str(body.error)
    }

    if (!workerId || !token || !taskId) {
      return reply.code(400).send({ error: 'complete 需要 workerId / token / taskId' })
    }
    try {
      const result = completeTask({ workerId, token, taskId, status, error, file, fileName })
      if (!result) return reply.code(401).send({ error: '工作节点认证失败' })
      if (!result.ok && result.error) return reply.code(400).send({ error: result.error })
      return reply.send({ ok: true, assetId: result.assetId, task: result.task })
    } catch (e) {
      return reply.code(500).send({ error: `完成任务失败：${errorMessage(e)}` })
    }
  })

  /* ---------------- Web 侧接口 ---------------- */

  app.post<{ Body: Json }>('/api/companion/tasks', async (request, reply) => {
    const body = request.body ?? {}
    const type = str(body.type) ?? 'generate_audio'
    if (!SUPPORTED_TASK_TYPES.has(type)) {
      return reply.code(400).send({ error: `暂不支持的任务类型：${type}（当前支持：${[...SUPPORTED_TASK_TYPES].join(', ')}）` })
    }
    const params = (body.params && typeof body.params === 'object' ? body.params : {}) as Json

    if (type === 'generate_audio' && !str(params.caption)) {
      return reply.code(400).send({ error: 'generate_audio 需要 params.caption（英文提示词，含风格/乐器/情绪/速度）' })
    }

    // repaint_audio：校验源资产与重绘区间（区间必须落在源音频时长内）
    if (type === 'repaint_audio') {
      const sourceAssetId = str(params.sourceAssetId)
      if (!sourceAssetId) {
        return reply.code(400).send({ error: 'repaint_audio 需要 params.sourceAssetId（要重绘的音频资产）' })
      }
      const asset = getAsset(sourceAssetId)
      if (!asset) {
        return reply.code(400).send({ error: `源音频资产不存在：${sourceAssetId}` })
      }
      if (!str(params.caption)) {
        return reply.code(400).send({ error: 'repaint_audio 需要 params.caption（描述想改成什么样）' })
      }
      const start = num(params.startSec)
      const end = num(params.endSec)
      if (start === undefined || end === undefined || start < 0 || end <= start) {
        return reply.code(400).send({ error: 'repaint_audio 需要合法区间：0 ≤ startSec < endSec' })
      }
      if (end > asset.durationSec + 0.02) {
        return reply
          .code(400)
          .send({ error: `重绘区间超出音频时长：endSec=${end} > ${asset.durationSec.toFixed(2)}s` })
      }
      params.sourceDurationSec = asset.durationSec
    }

    // generate_stem（lego 分轨）：需要源资产 + 合法乐器手臂（base 基座由派单能力保证）
    if (type === 'generate_stem') {
      const sourceAssetId = str(params.sourceAssetId)
      if (!sourceAssetId) {
        return reply.code(400).send({ error: 'generate_stem 需要 params.sourceAssetId（要分轨的音频资产）' })
      }
      const asset = getAsset(sourceAssetId)
      if (!asset) {
        return reply.code(400).send({ error: `源音频资产不存在：${sourceAssetId}` })
      }
      const arm = str(params.arm)
      if (!arm) {
        return reply.code(400).send({ error: 'generate_stem 需要 params.arm（乐器：guitar/bass/drums/strings/keys/synth/vocals）' })
      }
      if (!STEM_ARMS.has(arm)) {
        return reply
          .code(400)
          .send({ error: `不支持的乐器 arm：${arm}（可用：${[...STEM_ARMS].join(', ')}）` })
      }
      params.sourceDurationSec = asset.durationSec
    }

    // cover_audio（P7-B）：把用户渲染的 MIDI/音频整体"保结构换编制"
    if (type === 'cover_audio') {
      const sourceAssetId = str(params.sourceAssetId)
      if (!sourceAssetId) {
        return reply.code(400).send({ error: 'cover_audio 需要 params.sourceAssetId（要重编的音频）' })
      }
      const asset = getAsset(sourceAssetId)
      if (!asset) {
        return reply.code(400).send({ error: `源音频资产不存在：${sourceAssetId}` })
      }
      if (!str(params.caption)) {
        return reply.code(400).send({ error: 'cover_audio 需要 params.caption（希望变成什么编制/风格）' })
      }
      const strengthRaw = num(params.audioCoverStrength)
      if (strengthRaw !== undefined && (strengthRaw < 0 || strengthRaw > 1)) {
        return reply.code(400).send({ error: 'params.audioCoverStrength 必须在 0–1 之间（越大越贴近原结构）' })
      }
      params.sourceDurationSec = asset.durationSec
    }

    // 适配器校验：模型管理器真正接进生成路径（基座不匹配就不让它"看起来加载了"）
    const adapterId = str(params.adapterId)
    if (adapterId) {
      const entry = findAdapter(adapterId)
      if (!entry?.manifest) {
        return reply.code(400).send({ error: `适配器不存在：${adapterId}` })
      }
      if (!entry.audit?.ok) {
        return reply.code(400).send({
          error: `适配器不可用：${entry.audit?.errors?.[0] ?? '未通过审计'}`,
        })
      }
      const requiredBase = TASK_VARIANT[type] ?? 'turbo'
      if (entry.manifest.baseModel !== requiredBase) {
        return reply.code(400).send({
          error: `适配器 ${adapterId} 基于 ${entry.manifest.baseModel}，而 ${type} 需要 ${requiredBase} 基座（LoRA 与基座变体绑死）`,
        })
      }
      params.adapterPath = entry.dir
    }

    if (listWorkers().length === 0) {
      return reply.code(503).send({
        error: '没有在线 Companion：先启动本地工作节点（node scripts/companion.mjs --server <本服务地址>），再提交生成任务',
      })
    }

    // 优先级：0 普通 / 1 高 / 2 紧急（缺省 0；非法值直接拒绝，避免"看起来排了队其实没排"）
    let priority: 0 | 1 | 2 = 0
    if (body.priority !== undefined) {
      const raw = num(body.priority)
      if (raw !== 0 && raw !== 1 && raw !== 2) {
        return reply.code(400).send({ error: 'priority 只能是 0（普通）/ 1（高）/ 2（紧急）' })
      }
      priority = raw
    }

    // 质量模式（P7-A）：布尔校验；任务实际走 sft+LM，派单需要 sft worker
    let quality = false
    if (params.quality !== undefined) {
      if (typeof params.quality !== 'boolean') {
        return reply.code(400).send({ error: 'params.quality 必须是布尔值' })
      }
      quality = params.quality
    }
    const variantOverride = quality && type === 'generate_audio' ? 'sft' : undefined

    const task = enqueueTask({ type, params, projectId: str(body.projectId), priority, variantOverride })
    const info = taskWithQueueInfo(task)
    return reply.send({
      taskId: task.id,
      status: task.status,
      priority: task.priority,
      requiredVariant: task.requiredVariant,
      queuePosition: info.queuePosition,
      estimatedWaitSec: info.estimatedWaitSec,
      summary: `任务已入队：${task.id}（${type}${task.priority > 0 ? `，优先级${task.priority === 2 ? '紧急' : '高'}` : ''}）`,
    })
  })

  app.get<{ Params: { id: string } }>('/api/companion/tasks/:id', async (request, reply) => {
    const task = getTask(request.params.id)
    if (!task) return reply.code(404).send({ error: '任务不存在' })
    return reply.send({ task: taskWithQueueInfo(task) })
  })

  app.post<{ Params: { id: string } }>('/api/companion/tasks/:id/cancel', async (request, reply) => {
    const task = getTask(request.params.id)
    if (!task) return reply.code(404).send({ error: '任务不存在' })
    const ok = cancelTask(request.params.id)
    if (!ok) return reply.code(409).send({ error: `任务当前状态 ${task.status}，无法取消` })
    return reply.send({ ok: true, task: getTask(request.params.id) })
  })

  app.get('/api/companion/status', async () => {
    const summary = companionSummary()
    const queue = queueCounts()
    return {
      summary,
      queue,
      blockedByCapability: blockedByCapability(),
      online: summary.workers > 0,
      workers: listWorkers(),
      tasks: listTasks(20),
      hint:
        summary.workers === 0
          ? '没有在线 Companion：在跑 GPU 的机器上执行 node scripts/companion.mjs --server <本服务地址> --acestep'
          : undefined,
    }
  })
}
