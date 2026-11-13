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
 *
 * 本机节点管理（P15，单机形态）：
 *   GET  /api/companion/node        本机生成节点进程状态（可用性 / 状态 / 日志尾部 / 启动命令）
 *   POST /api/companion/node/start  一键启动（拉起 scripts/companion.mjs 并等待注册）
 *   POST /api/companion/node/stop   停止由服务端拉起的节点
 *
 * 入队时若没有任何在线节点，会先尝试拉起本机节点（见 companion/supervisor.ts）：
 * 失败才返回 503，不再让用户对着「节点未连接」干等。
 */
import type { FastifyInstance } from 'fastify'
import { variantDisplayName } from '@aiab/core'
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
  parseEngineTier,
  queueCounts,
  registerWorker,
  reportProgress,
  taskWithQueueInfo,
  variantForTask,
} from '../companion/store.js'
import {
  companionNodeStatus,
  ensureCompanionOnline,
  startCompanionNode,
  stopCompanionNode,
} from '../companion/supervisor.js'
import { errorMessage } from '../util.js'

const HEARTBEAT_MS = 5000
const POLL_MS = 1500
/** P1/P2/P5 开放的任务类型；后续 cover/extract 在这里扩展 */
const SUPPORTED_TASK_TYPES = new Set(['generate_audio', 'repaint_audio', 'generate_stem', 'cover_audio'])

/**
 * generate_stem 允许的乐器手臂（**产品 arm 名**，与 companion.mjs 的 STEM_ARMS 保持一致）。
 * 注意：arm 不是引擎轨道名 —— 引擎只认 keyboard/bass/... 等标准名，`keys → keyboard`
 * 的翻译在 Companion 侧完成（引擎收到 `keys` 会打 WARNING 并当成未知轨道）。
 */
const STEM_ARMS = new Set(['guitar', 'bass', 'drums', 'strings', 'keys', 'synth', 'vocals'])

type Json = Record<string, unknown>

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** 百分比限定在 0–100（GPU/CPU 之外的比率字段用） */
function pct(value: unknown): number | undefined {
  const n = num(value)
  return n === undefined ? undefined : Math.round(Math.min(100, Math.max(0, n)) * 10) / 10
}

/** 非负数值，保留 1 位小数（CPU% 可 >100，所以单独于 pct） */
function nonNegative(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const n = num(value)
  if (n === undefined || n < 0) return undefined
  return Math.round(Math.min(max, n) * 10) / 10
}

function positiveInt(value: unknown, max = 100_000): number | undefined {
  const n = num(value)
  if (n === undefined || n < 0) return undefined
  return Math.min(max, Math.round(n))
}

/** 引擎资源遥测白名单（P13）：只接受数值/短字符串，避免把任意对象写进任务状态 */
function parseTelemetry(raw: unknown) {
  if (!raw || typeof raw !== 'object') return undefined
  const source = raw as Json
  const gpuName = str(source.gpuName)
  const sampledAt = num(source.sampledAt)
  const telemetry = {
    cpuPct: nonNegative(source.cpuPct, 100_000),
    rssMb: nonNegative(source.rssMb, 10_000_000),
    gpuName: gpuName && gpuName.length <= 80 ? gpuName : undefined,
    gpuUtilPct: pct(source.gpuUtilPct),
    vramUsedMb: nonNegative(source.vramUsedMb, 1_000_000),
    vramTotalMb: nonNegative(source.vramTotalMb, 1_000_000),
    gpuTempC: nonNegative(source.gpuTempC, 200),
    sampledAt: sampledAt && sampledAt > 0 ? Math.round(sampledAt) : undefined,
  }
  return Object.values(telemetry).some((value) => value !== undefined) ? telemetry : undefined
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
            // LM 档位：'' / '1.7B' / '4B'；旧 Companion 的布尔 true 按 legacy 1.7B 兼容
            lm:
              engineRaw.lm === null
                ? null
                : typeof engineRaw.lm === 'string'
                  ? engineRaw.lm.trim()
                  : engineRaw.lm === true
                    ? '1.7B'
                    : undefined,
            // 运行时形态：只透传合法值，旧客户端不带该字段则保持 undefined
            api: engineRaw.api === 'legacy' || engineRaw.api === 'modern' ? engineRaw.api : undefined,
            // P13：实时引擎状态 + 阶段 + 资源遥测（旧 Companion 不带这些字段）
            state:
              typeof engineRaw.state === 'string' &&
              ['stopped', 'starting', 'ready', 'busy', 'error'].includes(engineRaw.state)
                ? (engineRaw.state as 'stopped' | 'starting' | 'ready' | 'busy' | 'error')
                : undefined,
            device: str(engineRaw.device),
            phase: str(engineRaw.phase),
            phaseLabel: str(engineRaw.phaseLabel),
            step: positiveInt(engineRaw.step, 100_000),
            stepTotal: positiveInt(engineRaw.stepTotal, 100_000),
            speed: nonNegative(engineRaw.speed, 100_000),
            estimated: bool(engineRaw.estimated),
            ...(parseTelemetry(engineRaw.telemetry ?? engineRaw) ?? {}),
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
    const telemetry = parseTelemetry(body.telemetry)
    const result = reportProgress({
      workerId: str(body.workerId) ?? '',
      token: str(body.token) ?? '',
      taskId: str(body.taskId) ?? '',
      progress: Math.max(0, Math.min(1, num(body.progress) ?? 0)),
      message: str(body.message),
      phase: str(body.phase),
      phaseLabel: str(body.phaseLabel),
      step: positiveInt(body.step, 100_000),
      stepTotal: positiveInt(body.stepTotal, 100_000),
      speed: nonNegative(body.speed, 100_000),
      estimated: bool(body.estimated),
      telemetry,
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

    // 引擎量级（P9）：只接受 '2b' | 'xl'；缺省（旧前端/旧插件不带）按 2b 处理
    const engine = parseEngineTier(params.engine)
    if (!engine) {
      return reply.code(400).send({
        error: `params.engine 只能是 '2b'（标准 2B，快）或 'xl'（XL 4B，最高质量），收到：${String(params.engine)}`,
      })
    }

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

    // generate_stem（extract 分轨）：需要源资产 + 合法乐器手臂（base 基座由派单能力保证）
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
      // seed 必须是整数：分轨用固定 seed 才可复现（缺省由 Companion 兜底，这里只挡非法值）
      if (params.seed !== undefined && params.seed !== null) {
        const seedValue = Number(params.seed)
        if (!Number.isInteger(seedValue) || seedValue < 0) {
          return reply
            .code(400)
            .send({ error: `params.seed 必须是非负整数（收到 ${String(params.seed)}）；分轨用固定 seed 才能复现` })
        }
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
      // 适配器基座校验：按任务族的基座变体（不受 quality 覆盖影响，与旧行为一致），
      // 变体映射复用 variantForTask，仅跟随引擎量级（xl 用 xl_* 基座）
      const requiredBase = variantForTask(type, { engine }) ?? 'turbo'
      if (entry.manifest.baseModel !== requiredBase) {
        return reply.code(400).send({
          error: `适配器 ${adapterId} 基于${variantDisplayName(entry.manifest.baseModel)}，而当前任务需要${variantDisplayName(requiredBase)}基座（风格适配器与基座版本绑定）`,
        })
      }
      params.adapterPath = entry.dir
    }

    // 没有在线节点：单机形态下服务端自己就能把它拉起来（P15），不要直接 503 让用户干等。
    // 拉起失败（未装引擎 / 部署形态不支持 / 已禁用自动启动）才回 503，并带上可执行的原因。
    if (listWorkers().length === 0) {
      await ensureCompanionOnline()
    }
    if (listWorkers().length === 0) {
      const node = companionNodeStatus()
      const nodeHint = node.state === 'failed' && node.reason ? `（${node.reason}）` : ''
      return reply.code(503).send({
        error:
          `没有在线 Companion${nodeHint}：在跑 GPU 的机器上执行 node scripts/companion.mjs --server <本服务地址> --engine，` +
          '或在界面点「启动生成节点」由本机服务自动拉起',
        node,
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

    // 质量模式（P7-A）：布尔校验（语义不变：仅 generate_audio 生效、与 LoRA 互斥）；
    // 派单变体由 variantForTask 从 params 推导（2B→sft，XL→xl_sft），不再单独传 variantOverride
    if (params.quality !== undefined && typeof params.quality !== 'boolean') {
      return reply.code(400).send({ error: 'params.quality 必须是布尔值' })
    }

    // 是否纯乐器（本轮）：只做类型校验，值原样透传给 Companion（它决定 lyrics/vocal_language）。
    // 缺省（旧前端不带）= true，保持旧行为：今天所有生成都是 [Instrumental]。
    if (params.instrumental !== undefined && typeof params.instrumental !== 'boolean') {
      return reply.code(400).send({ error: 'params.instrumental 必须是布尔值（true=纯乐器，false=要人声）' })
    }
    // 分轨源的「是否含人声」同样只能是布尔；缺省不传 = 未知，Companion 不拦
    if (params.sourceInstrumental !== undefined && typeof params.sourceInstrumental !== 'boolean') {
      return reply.code(400).send({ error: 'params.sourceInstrumental 必须是布尔值' })
    }

    const task = enqueueTask({ type, params, projectId: str(body.projectId), priority })
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
    // P13：附带执行节点快照（引擎状态 + 资源遥测），让前端无需再单独轮询 /status。
    // 只暴露展示所需字段，绝不带 token。
    const workers = listWorkers()
    const worker = workers.find((item) => item.id === task.workerId) ?? workers.find((item) => item.status.currentTaskId === task.id)
    const workerInfo = worker
      ? {
          id: worker.id,
          name: worker.name,
          version: worker.version,
          capabilities: worker.capabilities,
          lastHeartbeatAt: worker.lastHeartbeatAt,
          status: {
            busy: worker.status.busy,
            currentTaskId: worker.status.currentTaskId,
            lastMessage: worker.status.lastMessage,
            engine: worker.status.engine,
          },
        }
      : undefined
    return reply.send({ task: { ...taskWithQueueInfo(task), worker: workerInfo } })
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
    const node = companionNodeStatus()
    return {
      summary,
      queue,
      blockedByCapability: blockedByCapability(),
      online: summary.workers > 0,
      workers: listWorkers(),
      tasks: listTasks(20),
      // P15：本机生成节点进程状态（单机形态下可一键/自动拉起）；旧前端忽略该字段
      node,
      hint:
        summary.workers === 0
          ? node.state === 'failed' && node.reason
            ? `没有在线 Companion：${node.reason}`
            : '没有在线 Companion：在跑 GPU 的机器上执行 node scripts/companion.mjs --server <本服务地址> --engine，或在界面点「启动生成节点」'
          : undefined,
    }
  })

  /* ---------------- P15：本机生成节点进程管理 ---------------- */

  app.get('/api/companion/node', async () => {
    // 拉一次摘要：worker 在线时子进程状态应显示 running（用户手动启动的节点也算在线）
    const node = companionNodeStatus()
    if (listWorkers().length > 0 && node.state === 'stopped') {
      return { ...node, state: 'running' as const }
    }
    return node
  })

  app.post<{ Body: Json }>('/api/companion/node/start', async (request) => {
    const body = request.body ?? {}
    const waitMsRaw = num(body.waitMs)
    const waitMs = waitMsRaw === undefined ? undefined : Math.min(30_000, Math.max(0, waitMsRaw))
    // 用户显式点「启动」时允许覆盖 AIAB_COMPANION_AUTOSTART=0（那是给「不想让服务端碰进程」的场景）
    const result = await startCompanionNode({ waitMs, force: body.force === true })
    return result
  })

  app.post('/api/companion/node/stop', async () => {
    return stopCompanionNode()
  })
}
