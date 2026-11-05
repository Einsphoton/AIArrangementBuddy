/**
 * 工程持久化：<DATA_DIR>/projects/<id>.json，一个工程一个文件。
 * 客户端是权威状态，服务端只负责可靠落盘 / 列表 / 删除。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { projectSchema, type Project } from '@aiab/core'
import { projectsDir } from '../config.js'
import { safeFileId } from '../util.js'

export interface ProjectSummary {
  id: string
  name: string
  updatedAt: number
  createdAt: number
  trackCount: number
  tempo: number
}

function projectPath(id: string): string | null {
  const safe = safeFileId(id)
  if (!safe) return null
  return path.join(projectsDir, `${safe}.json`)
}

/** 读取工程；不存在或损坏返回 null */
export function loadProject(id: string): Project | null {
  const file = projectPath(id)
  if (!file || !existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    const parsed = projectSchema.safeParse(raw)
    if (!parsed.success) return null
    return parsed.data as unknown as Project
  } catch {
    return null
  }
}

/** 保存工程（写前做 schema 校验，返回错误信息而不是抛异常） */
export function saveProject(project: Project): { ok: true; savedAt: number } | { ok: false; error: string } {
  const file = projectPath(project.id)
  if (!file) return { ok: false, error: '工程 id 非法' }
  const parsed = projectSchema.safeParse(project)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, error: `工程数据校验失败：${issue ? `${issue.path.join('.')} ${issue.message}` : '未知字段'}` }
  }
  const savedAt = Date.now()
  const payload = { ...(parsed.data as unknown as Project), updatedAt: project.updatedAt ?? savedAt }
  try {
    if (!existsSync(projectsDir)) mkdirSync(projectsDir, { recursive: true })
    writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
    return { ok: true, savedAt }
  } catch (error) {
    return { ok: false, error: `写入失败：${(error as Error).message}` }
  }
}

export function deleteProject(id: string): boolean {
  const file = projectPath(id)
  if (!file || !existsSync(file)) return false
  rmSync(file, { force: true })
  return true
}

export function projectExists(id: string): boolean {
  const file = projectPath(id)
  return !!file && existsSync(file)
}

/** 列出所有工程（按更新时间倒序） */
export function listProjects(): ProjectSummary[] {
  if (!existsSync(projectsDir)) return []
  const files = readdirSync(projectsDir).filter((name) => name.endsWith('.json'))
  const summaries: ProjectSummary[] = []
  for (const name of files) {
    const id = name.slice(0, -'.json'.length)
    const project = loadProject(id)
    if (!project) continue
    let updatedAt = project.updatedAt
    if (!Number.isFinite(updatedAt)) {
      try {
        updatedAt = statSync(path.join(projectsDir, name)).mtimeMs
      } catch {
        updatedAt = Date.now()
      }
    }
    summaries.push({
      id: project.id,
      name: project.name,
      updatedAt,
      createdAt: project.createdAt,
      trackCount: project.tracks.length,
      tempo: project.tempo,
    })
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt)
  return summaries
}

/** 最近修改的工程（MCP server 没有显式指定工程时使用） */
export function mostRecentProject(): Project | null {
  const list = listProjects()
  if (list.length === 0) return null
  return loadProject(list[0].id)
}
