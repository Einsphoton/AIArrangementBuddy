/**
 * MIDI 导入路由：把用户上传的 .mid 文件解析成工程快照。
 *
 *   POST /api/import/midi?name=<工程名>
 *     - Content-Type: application/octet-stream（或 audio/midi）时，请求体就是文件原始字节
 *     - Content-Type: multipart/form-data 时，取字段名 file，可选字段 name 覆盖工程名
 *   返回 { project, summary }；MIDI 非法时返回 400 + { error }
 *
 * 注意：路由注册放到 index.ts 由上层统一完成，这里只负责接口本身。
 */
import type { FastifyInstance } from 'fastify'
import { readMidiBytes } from '@aiab/core'
import { errorMessage } from '../util.js'

/** 以原始字节上传 MIDI 时可以接受的 Content-Type（重复注册会被跳过） */
const MIDI_BINARY_CONTENT_TYPES = ['application/octet-stream', 'audio/midi', 'audio/x-midi', 'application/x-midi']

interface ImportMidiQuery {
  name?: string
}

function cleanName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** 把 Fastify 解析出来的请求体统一成字节数组 */
function bodyToBytes(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) return body
  if (typeof body === 'string') return new Uint8Array(Buffer.from(body, 'binary'))
  // 兜底：JSON 序列化过的 Buffer（{ type: 'Buffer', data: [...] }）
  if (body && typeof body === 'object') {
    const maybe = body as { type?: unknown; data?: unknown }
    if (maybe.type === 'Buffer' && Array.isArray(maybe.data)) return Uint8Array.from(maybe.data as number[])
  }
  return new Uint8Array(0)
}

export function registerImportRoutes(app: FastifyInstance): void {
  // 路由层自己注册二进制解析器：index.ts 不一定为 application/octet-stream 配过解析器，
  // 已注册过（hasContentTypeParser）时不重复注册，避免 FST_ERR_CTP_ALREADY_PRESENT。
  for (const contentType of MIDI_BINARY_CONTENT_TYPES) {
    if (!app.hasContentTypeParser(contentType)) {
      app.addContentTypeParser(contentType, { parseAs: 'buffer' }, (_request, body, done) => {
        done(null, body)
      })
    }
  }

  app.post<{ Querystring: ImportMidiQuery }>('/api/import/midi', async (request, reply) => {
    let name = cleanName(request.query?.name)
    let bytes: Uint8Array = new Uint8Array(0)

    try {
      if (request.isMultipart()) {
        let fileBytes: Uint8Array | null = null
        for await (const part of request.parts()) {
          if (part.type === 'file') {
            if (part.fieldname !== 'file') {
              part.file.resume()
              continue
            }
            if (!fileBytes) fileBytes = await part.toBuffer()
            else part.file.resume()
          } else if (part.fieldname === 'name') {
            name = cleanName(part.value) ?? name
          }
        }
        if (!fileBytes) {
          return reply.code(400).send({ error: '缺少 MIDI 文件：请用 multipart/form-data 上传，字段名 file' })
        }
        bytes = fileBytes
      } else {
        bytes = bodyToBytes(request.body)
      }
    } catch (error) {
      return reply.code(400).send({ error: `读取上传的 MIDI 内容失败：${errorMessage(error)}` })
    }

    if (bytes.byteLength === 0) {
      return reply.code(400).send({
        error: 'MIDI 内容为空：请上传 .mid 文件（application/octet-stream 原始字节，或 multipart 字段 file）',
      })
    }

    try {
      const { project, summary } = readMidiBytes(bytes, { name })
      return reply.send({
        project,
        summary:
          `已导入 ${summary.tracks} 条轨道 / ${summary.notes} 个音符 · ${summary.tempo} BPM · ` +
          `${summary.key} ${summary.scale}（SMF format ${summary.format}）`,
      })
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }
  })
}
