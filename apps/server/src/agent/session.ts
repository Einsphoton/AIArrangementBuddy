/**
 * 外部 Agent（Codex / DSH）会话目录。
 *
 * 外部 Agent 本身没有我们的工程快照，所以每次运行创建一个会话目录：
 * - project.json：MCP server 读写的最新工程（外部 Agent 通过 MCP 工具修改它）
 * - workspace/：给 Codex -C 用的工作目录
 * 服务端轮询 project.json，一旦变化就向前端下发 project 事件。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { projectSchema, type Project } from '@aiab/core'
import { agentSessionsDir } from '../config.js'

export interface ExternalAgentSession {
  runId: string
  dir: string
  projectFile: string
  workspace: string
  /** 读取外部 Agent 写入的最新工程（校验失败返回 null） */
  readProject(): Project | null
  /** 开始轮询，回调只在实际变化时触发；返回停止函数 */
  watch(onProject: (project: Project) => void, intervalMs?: number): () => void
  /** 删除会话目录（默认保留，方便排查；AIAB_KEEP_SESSIONS=1 可保留） */
  cleanup(): void
}

export function createExternalSession(runId: string, initialProject: Project): ExternalAgentSession {
  const dir = path.join(agentSessionsDir, runId)
  const workspace = path.join(dir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const projectFile = path.join(dir, 'project.json')
  const initialSerialized = JSON.stringify(initialProject, null, 2)
  writeFileSync(projectFile, initialSerialized, 'utf8')
  let lastSerialized = initialSerialized

  const readProject = (): Project | null => {
    try {
      const raw = JSON.parse(readFileSync(projectFile, 'utf8')) as unknown
      const parsed = projectSchema.safeParse(raw)
      if (!parsed.success) return null
      return parsed.data as unknown as Project
    } catch {
      return null
    }
  }

  const watch = (onProject: (project: Project) => void, intervalMs = 400): (() => void) => {
    const timer = setInterval(() => {
      let serialized: string
      try {
        serialized = readFileSync(projectFile, 'utf8')
      } catch {
        return
      }
      if (serialized === lastSerialized) return
      lastSerialized = serialized
      const project = readProject()
      if (project) onProject(project)
    }, intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  const cleanup = (): void => {
    if (process.env.AIAB_KEEP_SESSIONS === '1') return
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  return { runId, dir, projectFile, workspace, readProject, watch, cleanup }
}
