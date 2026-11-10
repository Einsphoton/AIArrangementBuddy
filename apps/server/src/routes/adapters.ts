/**
 * 适配器（LoRA）管理接口。
 *
 *   GET  /api/adapters        列出所有适配器 + 兼容性审计
 *   GET  /api/adapters/:id    单个适配器详情（含文件清单）
 *
 * 审计规则来自 core 的 checkAdapterCompatibility：LoKR 在 C++ 运行时会被静默跳过、
 * 适配器绑死基座、lego 需要 base 基座等，全部在这里暴露给前端。
 */
import type { FastifyInstance } from 'fastify'
import { adaptersRoot, findAdapter, scanAdapters } from '../adapters/registry.js'

interface AdapterRow {
  id: string
  name: string
  styleId?: string
  format: string
  baseModel: string
  tasks: string[]
  rank?: number
  alpha?: number
  bytes: number
  license?: string
  datasetNote?: string
  verified?: { runtime: string; mergedPairs: number; at: number }
  training?: unknown
  audit: { ok: boolean; errors: string[]; warnings: string[] }
  dir: string
}

function toRow(entry: ReturnType<typeof scanAdapters>[number]): AdapterRow | null {
  if (!entry.manifest) return null
  const m = entry.manifest
  return {
    id: m.id,
    name: m.name,
    styleId: m.styleId,
    format: m.format,
    baseModel: m.baseModel,
    tasks: m.tasks,
    rank: m.rank,
    alpha: m.alpha,
    bytes: m.bytes,
    license: m.license,
    datasetNote: m.datasetNote,
    verified: m.verified,
    training: m.training,
    audit: entry.audit ?? { ok: false, errors: ['未审计'], warnings: [] },
    dir: entry.dir,
  }
}

export function registerAdapterRoutes(app: FastifyInstance): void {
  app.get('/api/adapters', async () => {
    const entries = scanAdapters()
    const adapters: AdapterRow[] = []
    const broken: { dir: string; error: string }[] = []
    for (const entry of entries) {
      const row = toRow(entry)
      if (row) adapters.push(row)
      else broken.push({ dir: entry.dir, error: entry.error ?? '未知问题' })
    }
    return {
      root: adaptersRoot(),
      count: adapters.length,
      adapters,
      broken,
      // C++ 运行时依赖：只有 PEFT 格式且实测 mergedPairs > 0 的才能上产品
      nativeReady: adapters.filter((a) => a.audit.ok).map((a) => a.id),
    }
  })

  app.get<{ Params: { id: string } }>('/api/adapters/:id', async (request, reply) => {
    const entry = findAdapter(request.params.id)
    if (!entry || !entry.manifest) {
      return reply.code(404).send({ error: '适配器不存在', id: request.params.id })
    }
    return {
      ...toRow(entry),
      files: entry.manifest.files,
      sha256: entry.manifest.sha256,
      scale: entry.manifest.scale,
    }
  })
}
