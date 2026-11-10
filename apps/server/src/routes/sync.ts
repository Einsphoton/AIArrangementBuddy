/**
 * 云端 / NAS 同步路由（P6-B）：
 *
 *   POST /api/sync/export   body { projectIds?, includeAssets?, save?, name? }
 *        → 默认直接返回 `.aiabsync` 文件流（ZIP）；save=true 时写到 <DATA_DIR>/sync/ 并返回路径
 *   POST /api/sync/import   multipart（字段 file）或 { path } 指向本机 .aiabsync / 解压后的目录
 *        → 校验 sha256 → 资产去重入库 → 工程合并（id 冲突生成新 id）→ 返回报告
 *   GET  /api/sync/status   数据面自检（DATA_DIR / 工程数 / 资产数/占用 / adapters / 可写性）
 *
 * 说明：同步包读写都在 apps/server/src/sync/ 里，路由只做参数校验与 I/O 编组。
 */
import type { FastifyInstance } from 'fastify'
import { errorMessage } from '../util.js'
import { createSyncPackage, importSyncPackage, type SyncExportOptions } from '../sync/package.js'
import { dataPlaneStatus } from '../sync/status.js'

interface SyncExportBody {
  projectIds?: unknown
  includeAssets?: unknown
  save?: unknown
  name?: unknown
}

interface SyncImportBody {
  path?: unknown
}

/** 原始同步包（zip）上传时可以接受的 Content-Type */
const SYNC_BINARY_CONTENT_TYPES = ['application/zip', 'application/x-aiabsync', 'application/octet-stream']

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function registerSyncRoutes(app: FastifyInstance): void {
  // 支持把 .aiabsync 直接以二进制上传（multipart 之外的第二条路径）；已注册过则跳过
  for (const contentType of SYNC_BINARY_CONTENT_TYPES) {
    if (!app.hasContentTypeParser(contentType)) {
      app.addContentTypeParser(contentType, { parseAs: 'buffer' }, (_request, body, done) => {
        done(null, body)
      })
    }
  }

  app.post<{ Body: SyncExportBody; Querystring: { save?: string } }>('/api/sync/export', async (request, reply) => {
    const body = (request.body && typeof request.body === 'object' ? request.body : {}) as SyncExportBody

    let projectIds: string[] | undefined
    if (body.projectIds !== undefined) {
      if (!Array.isArray(body.projectIds) || body.projectIds.some((id) => typeof id !== 'string')) {
        return reply.code(400).send({ error: 'projectIds 必须是工程 id 字符串数组（省略则导出全部工程）' })
      }
      projectIds = body.projectIds as string[]
    }

    const includeAssets = body.includeAssets !== false
    const save = body.save === true || request.query?.save === '1' || request.query?.save === 'true'
    const name = asString(body.name)

    try {
      const options: SyncExportOptions = { projectIds, includeAssets, name, saveToDataDir: save }
      const result = createSyncPackage(options)
      const { manifest } = result

      if (save) {
        return reply.send({
          ok: true,
          savedPath: result.savedPath,
          filename: result.filename,
          bytes: result.buffer.length,
          projectCount: manifest.projects.length,
          assetCount: manifest.assets.length,
          fileCount: manifest.files.length,
          warnings: manifest.warnings,
          manifest,
          summary: result.summary,
        })
      }

      return reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', `attachment; filename="${result.filename}"`)
        .header('X-Sync-Package-Id', manifest.packageId)
        .header('X-Sync-Projects', String(manifest.projects.length))
        .header('X-Sync-Assets', String(manifest.assets.length))
        .header('X-Sync-Bytes', String(result.buffer.length))
        .header('X-Sync-Warnings', String(manifest.warnings.length))
        .send(result.buffer)
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }
  })

  app.post<{ Body: SyncImportBody }>('/api/sync/import', async (request, reply) => {
    let buffer: Buffer | undefined
    let localPath: string | undefined

    try {
      if (request.isMultipart()) {
        for await (const part of request.parts()) {
          if (part.type === 'file') {
            if (part.fieldname !== 'file') {
              part.file.resume()
              continue
            }
            if (!buffer) buffer = await part.toBuffer()
            else part.file.resume()
          } else if (part.fieldname === 'path') {
            localPath = asString(part.value) ?? localPath
          }
        }
      } else if (Buffer.isBuffer(request.body)) {
        buffer = request.body
      } else if (request.body && typeof request.body === 'object') {
        localPath = asString((request.body as SyncImportBody).path) ?? localPath
      }
    } catch (error) {
      return reply.code(400).send({ error: `读取同步包失败：${errorMessage(error)}` })
    }

    if (!buffer && !localPath) {
      return reply
        .code(400)
        .send({ error: '缺少同步包：请用 multipart/form-data 上传（字段名 file），或传 JSON {"path": "..."}' })
    }

    try {
      const report = importSyncPackage({ buffer, path: localPath })
      return reply.send(report)
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }
  })

  app.get('/api/sync/status', async () => dataPlaneStatus())
}
