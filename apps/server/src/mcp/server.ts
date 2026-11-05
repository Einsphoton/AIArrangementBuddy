#!/usr/bin/env node
/**
 * MCP stdio server：把 DAW 工具暴露给 Codex / DSH / Claude Desktop 等外部 Agent。
 *
 * 独立启动：
 *   ./apps/server/node_modules/.bin/tsx apps/server/src/mcp/server.ts
 *   node apps/server/dist/mcp.mjs
 *
 * 工程从 AIAB_PROJECT_FILE 指向的 JSON 文件读取，工具修改后原子写回；
 * 服务端（Codex 后端）轮询该文件并把变化转成前端的 project 事件。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  beatsPerBar,
  createEmptyProject,
  projectSchema,
  type AppSettings,
  type Project,
} from '@aiab/core'
import { dataDir, ensureDataDirs } from '../config.js'
import { loadSettings } from '../storage/settings.js'
import { mostRecentProject } from '../storage/projects.js'
import { executeTool, toolsForContext } from '../tools/index.js'
import type { ToolContext } from '../tools/schema.js'
import { errorMessage } from '../util.js'

/* ------------------------------- 工程持久化 ------------------------------- */

function resolveProjectFile(): string {
  if (process.env.AIAB_PROJECT_FILE) return process.env.AIAB_PROJECT_FILE
  ensureDataDirs()
  const workspace = path.join(dataDir, 'mcp-workspace')
  mkdirSync(workspace, { recursive: true })
  return path.join(workspace, 'project.json')
}

const projectFile = resolveProjectFile()
// 显式指定 AIAB_PROJECT_FILE 时父目录可能不存在，这里统一兜底
mkdirSync(path.dirname(projectFile), { recursive: true })

function readProjectFile(): Project | null {
  if (!existsSync(projectFile)) return null
  try {
    const raw = JSON.parse(readFileSync(projectFile, 'utf8')) as unknown
    const parsed = projectSchema.safeParse(raw)
    return parsed.success ? (parsed.data as unknown as Project) : null
  } catch {
    return null
  }
}

function writeProjectFile(project: Project): void {
  const serialized = JSON.stringify(project, null, 2)
  const temp = `${projectFile}.tmp`
  writeFileSync(temp, serialized, 'utf8')
  renameSync(temp, projectFile)
}

/** 首次加载：显式文件 -> 最近工程 -> 空工程 */
function loadInitialProject(): Project {
  const existing = readProjectFile()
  if (existing) return existing
  if (process.env.AIAB_PROJECT_ID) {
    const recent = mostRecentProject()
    if (recent && recent.id === process.env.AIAB_PROJECT_ID) {
      writeProjectFile(recent)
      return recent
    }
  }
  const project = process.env.AIAB_PROJECT_ID
    ? mostRecentProject() ?? createEmptyProject({ name: 'MCP 工作工程' })
    : mostRecentProject() ?? createEmptyProject({ name: 'MCP 工作工程' })
  writeProjectFile(project)
  return project
}

let currentProject: Project = loadInitialProject()

function allowFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name]
  if (value === undefined) return fallback
  return value !== '0' && value.toLowerCase() !== 'false'
}

const allowProjectEdits = allowFlag('AIAB_ALLOW_PROJECT_EDITS', true)
const allowWebSearch = allowFlag('AIAB_ALLOW_WEB_SEARCH', true)
const settings: AppSettings = loadSettings()
settings.agent.allowProjectEdits = allowProjectEdits
settings.agent.allowWebSearch = allowWebSearch

/* --------------------------------- 工具桥 -------------------------------- */

type ZodShape = Record<string, z.ZodTypeAny>

function zodFromJsonSchema(schema: Record<string, unknown>): z.ZodTypeAny {
  const description = typeof schema.description === 'string' ? schema.description : undefined
  const type = schema.type
  let result: z.ZodTypeAny
  if (type === 'string') {
    const enumValues = Array.isArray(schema.enum) ? schema.enum.filter((item): item is string => typeof item === 'string') : []
    result = enumValues.length ? z.enum(enumValues as [string, ...string[]]) : z.string()
  } else if (type === 'number') {
    result = z.number()
  } else if (type === 'integer') {
    result = z.number().int()
  } else if (type === 'boolean') {
    result = z.boolean()
  } else if (type === 'array') {
    const items = schema.items && typeof schema.items === 'object' ? (schema.items as Record<string, unknown>) : null
    result = z.array(items ? zodFromJsonSchema(items) : z.unknown())
  } else if (type === 'object') {
    result = z.record(z.string(), z.unknown())
  } else {
    result = z.unknown()
  }
  return description ? result.describe(description) : result
}

function buildZodShape(tool: { parameters: { properties: Record<string, unknown>; required?: string[] } }): ZodShape {
  const required = new Set(tool.parameters.required ?? [])
  const shape: ZodShape = {}
  for (const [key, value] of Object.entries(tool.parameters.properties ?? {})) {
    const propertySchema = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
    let zodType = zodFromJsonSchema(propertySchema)
    if (!required.has(key)) zodType = zodType.optional()
    shape[key] = zodType
  }
  return shape
}

function textResult(payload: unknown, isError = false) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  return { content: [{ type: 'text' as const, text }], isError }
}

const server = new McpServer(
  { name: 'aiab-daw', version: '0.1.0' },
  { capabilities: { tools: {}, resources: {} } },
)

const availableTools = toolsForContext({ allowProjectEdits, allowWebSearch })

for (const tool of availableTools) {
  const shape = buildZodShape(tool)
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: shape,
      annotations: { readOnlyHint: !!tool.readOnly, openWorldHint: !!tool.web },
    },
    // 参数已由 zod 校验；这里用宽松类型接收，实际字段由 executeTool 自己再归一化
    async (args: Record<string, unknown>, extra: { signal?: AbortSignal }) => {
      const ctx: ToolContext = {
        project: currentProject,
        settings,
        signal: extra?.signal,
        workdir: process.cwd(),
        allowProjectEdits,
        allowWebSearch,
      }
      const result = await executeTool(tool.name, args ?? {}, ctx)
      if (result.project) {
        currentProject = result.project
        try {
          writeProjectFile(currentProject)
        } catch (error) {
          return textResult({ ok: false, message: `工程已修改但写盘失败：${errorMessage(error)}` }, true)
        }
      }
      return textResult({ ok: result.ok, message: result.message, data: result.data })
    },
  )
}

/* -------------------------------- 资源：工程 ------------------------------- */

server.registerResource(
  'current-project',
  'aiab://project/current',
  { title: '当前工程', description: 'AI 编曲伴侣当前工程的完整 JSON 快照', mimeType: 'application/json' },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(currentProject, null, 2) }],
  }),
)

/* --------------------------------- 启动 --------------------------------- */

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // 注意：stdout 是 MCP 协议通道，日志只能写 stderr
  process.stderr.write(
    `[aiab-mcp] ready · project=${projectFile} · tools=${availableTools.length} · edits=${allowProjectEdits} · web=${allowWebSearch}\n`,
  )
  const projectBar = beatsPerBar(currentProject.timeSignature)
  process.stderr.write(`[aiab-mcp] project="${currentProject.name}" tracks=${currentProject.tracks.length} barBeats=${projectBar}\n`)
}

process.on('SIGINT', () => {
  void server.close().finally(() => process.exit(0))
})
process.on('SIGTERM', () => {
  void server.close().finally(() => process.exit(0))
})

main().catch((error: unknown) => {
  process.stderr.write(`[aiab-mcp] fatal: ${errorMessage(error)}\n`)
  process.exit(1)
})
