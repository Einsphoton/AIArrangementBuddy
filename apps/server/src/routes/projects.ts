/** 工程 CRUD：/api/projects。 */
import type { FastifyInstance } from 'fastify'
import { projectSchema, type Project } from '@aiab/core'
import { deleteProject, listProjects, loadProject, saveProject } from '../storage/projects.js'
import { safeFileId } from '../util.js'

export function registerProjectRoutes(app: FastifyInstance): void {
  app.get('/api/projects', async () => listProjects())

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const id = safeFileId(request.params.id)
    if (!id) return reply.code(400).send({ error: '工程 id 非法' })
    const project = loadProject(id)
    if (!project) return reply.code(404).send({ error: '工程不存在' })
    return project
  })

  app.put<{ Params: { id: string }; Body: unknown }>('/api/projects/:id', async (request, reply) => {
    const id = safeFileId(request.params.id)
    if (!id) return reply.code(400).send({ error: '工程 id 非法' })
    const body = request.body as Partial<Project> | null
    if (!body || typeof body !== 'object') return reply.code(400).send({ error: '请求体必须是工程对象' })
    const candidate = { ...body, id } as Project
    const parsed = projectSchema.safeParse(candidate)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return reply.code(400).send({ error: `工程数据不合法：${issue ? `${issue.path.join('.')} ${issue.message}` : '未知错误'}` })
    }
    const result = saveProject(parsed.data as unknown as Project)
    if (!result.ok) return reply.code(500).send({ error: result.error })
    return { ok: true, savedAt: result.savedAt }
  })

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const id = safeFileId(request.params.id)
    if (!id) return reply.code(400).send({ error: '工程 id 非法' })
    const removed = deleteProject(id)
    if (!removed) return reply.code(404).send({ error: '工程不存在' })
    return { ok: true }
  })
}
