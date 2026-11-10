/**
 * 训练（P8-C）HTTP API。
 *
 *   GET  /api/training/status
 *   POST /api/training/setup      按需下载 代码/数据集/Python/检查点 + venv
 *   POST /api/training/train      开始训练（环境须已就绪）
 *   GET  /api/training/jobs/:id   查询进度/日志尾部
 *   POST /api/training/jobs/:id/cancel
 *   GET  /api/training/jobs
 *
 * 测试/高级用法：环境变量 AIAB_TRAINING_ALLOW_OVERRIDES=1 时接受 sources 覆盖路径。
 */
import type { FastifyInstance } from 'fastify'
import { dataDir } from '../config.js'
import {
  cancelTrainingJob,
  getTrainingJob,
  listTrainingJobs,
  startTraining,
  startTrainingSetup,
  trainingStatus,
} from '../provision/training.js'
import { errorMessage } from '../util.js'

type Json = Record<string, unknown>

const TAG_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/
const DATASETS = new Set(['jrpg_v1', 'jrpg_v2', 'jrock_v1'])

function parseOverrides(raw: unknown): { codeDir?: string; checkpointsDir?: string; pythonPath?: string; workDir?: string; datasetDir?: string; shimPath?: string; runnerPath?: string } | undefined {
  if (process.env.AIAB_TRAINING_ALLOW_OVERRIDES !== '1') return undefined
  if (!raw || typeof raw !== 'object') return undefined
  const source = raw as Json
  const pick = (name: string): string | undefined => (typeof source[name] === 'string' && String(source[name]).trim() ? String(source[name]).trim() : undefined)
  return {
    codeDir: pick('codeDir'),
    checkpointsDir: pick('checkpointsDir'),
    pythonPath: pick('pythonPath'),
    workDir: pick('workDir'),
    datasetDir: pick('datasetDir'),
    shimPath: pick('shimPath'),
    runnerPath: pick('runnerPath'),
  }
}

export function registerTrainingRoutes(app: FastifyInstance): void {
  app.get('/api/training/status', async () => trainingStatus({ dataDir }))

  app.post<{ Body: Json }>('/api/training/setup', async (request, reply) => {
    try {
      const overrides = parseOverrides(request.body?.sources)
      const job = startTrainingSetup({ dataDir, overrides })
      return reply.send({ jobId: job.id, job })
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }
  })

  app.post<{ Body: Json }>('/api/training/train', async (request, reply) => {
    const body = request.body ?? {}
    const datasetId = typeof body.datasetId === 'string' ? body.datasetId.trim() : ''
    const tag = typeof body.tag === 'string' ? body.tag.trim() : ''
    if (!DATASETS.has(datasetId)) return reply.code(400).send({ error: `datasetId 必须是 ${[...DATASETS].join(' / ')}` })
    if (!TAG_RE.test(tag)) return reply.code(400).send({ error: 'tag 只能是小写字母/数字/下划线/中划线，2–40 个字符' })
    try {
      const job = startTraining({
        dataDir,
        datasetId,
        tag,
        styleId: typeof body.styleId === 'string' ? body.styleId : undefined,
        name: typeof body.name === 'string' ? body.name : undefined,
        epochs: typeof body.epochs === 'number' ? body.epochs : undefined,
        rank: typeof body.rank === 'number' ? body.rank : undefined,
        device: typeof body.device === 'string' ? body.device : undefined,
        precision: typeof body.precision === 'string' ? body.precision : undefined,
        overrides: parseOverrides(body.sources),
      })
      return reply.send({ jobId: job.id, job })
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }
  })

  app.get<{ Params: { id: string } }>('/api/training/jobs/:id', async (request, reply) => {
    const job = getTrainingJob(request.params.id)
    if (!job) return reply.code(404).send({ error: '训练任务不存在' })
    return reply.send({ job })
  })

  app.get('/api/training/jobs', async () => ({ jobs: listTrainingJobs().slice(0, 10) }))

  app.post<{ Params: { id: string } }>('/api/training/jobs/:id/cancel', async (request, reply) => {
    const ok = cancelTrainingJob(request.params.id)
    if (!ok) return reply.code(409).send({ error: '任务未在运行（或已结束）' })
    return reply.send({ ok: true })
  })
}
