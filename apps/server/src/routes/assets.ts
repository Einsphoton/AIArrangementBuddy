/**
 * 音频资产库接口（P1）：
 *
 *   POST /api/assets/upload      上传 WAV（multipart file 或 octet-stream），入库并算波形峰值
 *   GET  /api/assets             资产列表（不含峰值）
 *   GET  /api/assets/:id/peaks   波形峰值（前端画波形用）
 *   GET  /api/assets/:id/file    原始 WAV（播放用，支持 Range 由 fastify-static 之外自行处理）
 *
 * 资产只存引用：工程里拿 AssetRef（core/audio.ts），不内联二进制。
 */
import { createReadStream } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { assetFileCount, assetFilePath, getAsset, listAssets, readPeaks, saveAsset } from '../storage/assets.js'
import { errorMessage } from '../util.js'

type UploadBody = unknown

function toAssetRef(asset: NonNullable<ReturnType<typeof getAsset>>) {
  return {
    id: asset.id,
    sha256: asset.sha256,
    kind: 'audio' as const,
    bytes: asset.bytes,
    durationMs: Math.round(asset.durationSec * 1000),
    sampleRate: asset.sampleRate,
    channels: asset.channels,
    residency: 'local' as const,
    name: asset.name,
    createdAt: asset.createdAt,
  }
}

export function registerAssetRoutes(app: FastifyInstance): void {
  for (const contentType of ['application/octet-stream', 'audio/wav', 'audio/wave', 'audio/x-wav']) {
    if (!app.hasContentTypeParser(contentType)) {
      app.addContentTypeParser(contentType, { parseAs: 'buffer' }, (_request, body, done) => done(null, body))
    }
  }

  app.post<{ Body: UploadBody; Querystring: { name?: string } }>('/api/assets/upload', async (request, reply) => {
    let buffer: Buffer | null = null
    let name = typeof request.query?.name === 'string' ? request.query.name : undefined
    let mime: string | undefined

    try {
      if (request.isMultipart()) {
        for await (const part of request.parts()) {
          if (part.type === 'file') {
            if (part.fieldname !== 'file') {
              part.file.resume()
              continue
            }
            if (!buffer) {
              buffer = await part.toBuffer()
              name = name ?? part.filename
              mime = part.mimetype
            } else {
              part.file.resume()
            }
          } else if (part.fieldname === 'name') {
            name = String(part.value)
          }
        }
      } else if (Buffer.isBuffer(request.body)) {
        buffer = request.body
      }
    } catch (error) {
      return reply.code(400).send({ error: `读取上传音频失败：${errorMessage(error)}` })
    }

    if (!buffer || buffer.length === 0) {
      return reply.code(400).send({ error: '缺少音频文件：请用 multipart/form-data 上传（字段名 file）或 application/octet-stream' })
    }

    try {
      const asset = saveAsset(buffer, { name, mime })
      return reply.send({
        asset: toAssetRef(asset),
        durationSec: asset.durationSec,
        sampleRate: asset.sampleRate,
        channels: asset.channels,
        peaks: asset.peaks,
        summary: `已入库 ${asset.name}：${asset.durationSec.toFixed(2)}s / ${asset.sampleRate}Hz / ${asset.channels} 声道`,
      })
    } catch (error) {
      return reply.code(400).send({ error: `音频入库失败：${errorMessage(error)}` })
    }
  })

  app.get('/api/assets', async () => ({
    count: assetFileCount(),
    assets: listAssets().map((asset) => ({ ...toAssetRef(asset), sha256: undefined })),
  }))

  app.get<{ Params: { id: string } }>('/api/assets/:id/peaks', async (request, reply) => {
    const asset = getAsset(request.params.id)
    if (!asset) return reply.code(404).send({ error: '资产不存在' })
    const peaks = readPeaks(asset.id)
    return reply.send({
      id: asset.id,
      durationSec: asset.durationSec,
      sampleRate: asset.sampleRate,
      channels: asset.channels,
      peaks: peaks?.peaks ?? asset.peaks,
    })
  })

  app.get<{ Params: { id: string } }>('/api/assets/:id/file', async (request, reply) => {
    const file = assetFilePath(request.params.id)
    if (!file) return reply.code(404).send({ error: '资产文件不存在' })
    reply.header('Cache-Control', 'public, max-age=31536000, immutable')
    return reply.type('audio/wav').send(createReadStream(file))
  })
}
