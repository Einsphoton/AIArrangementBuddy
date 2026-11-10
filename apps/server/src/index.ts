/**
 * AI 编曲伴侣 —— 后端入口。
 *
 *   ./apps/server/node_modules/.bin/tsx apps/server/src/index.ts
 *   DATA_DIR=/tmp/aiab-test-data PORT=8899 ...
 *
 * 默认监听 127.0.0.1:8787；SERVE_STATIC=1 时同时托管 apps/web/dist。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { SERVER_VERSION, dataDir, ensureDataDirs, host, logLevel, port, serveStatic, soundfontsDir, webDistDir } from './config.js'
import { registerMetaRoutes } from './routes/meta.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerSettingsRoutes } from './routes/settings.js'
import { registerAiRoutes, cancelActiveAiRun } from './routes/ai.js'
import { registerGenerateRoutes } from './routes/generate.js'
import { registerExportRoutes } from './routes/export.js'
import { registerSoundfontRoutes } from './routes/soundfonts.js'
import { registerAdapterRoutes } from './routes/adapters.js'
import { registerStudioRoutes } from './routes/studio.js'
import { registerImportRoutes } from './routes/import.js'
import { registerMixRoutes } from './routes/mix.js'
import { registerAssetRoutes } from './routes/assets.js'
import { registerCompanionRoutes } from './routes/companion.js'
import { registerSyncRoutes } from './routes/sync.js'
import { registerVst3Routes } from './routes/vst3.js'
import { registerProvisionRoutes } from './routes/provision.js'
import { registerTrainingRoutes } from './routes/training.js'

export async function buildServer(): Promise<FastifyInstance> {
  ensureDataDirs()
  const app = Fastify({
    logger: { level: logLevel },
    bodyLimit: 64 * 1024 * 1024,
    // 前端会用大工程快照（几千个音符）PUT，64MB 足够
  })

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    credentials: false,
  })

  await app.register(multipart, {
    limits: {
      fileSize: 300 * 1024 * 1024,
      files: 2,
      fields: 10,
    },
  })

  // 音色库静态文件（/soundfonts/<file>）
  await app.register(fastifyStatic, {
    root: soundfontsDir,
    prefix: '/soundfonts/',
    decorateReply: false,
    cacheControl: true,
    maxAge: '7d',
  })

  registerMetaRoutes(app)
  registerProjectRoutes(app)
  registerSettingsRoutes(app)
  registerAiRoutes(app)
  registerGenerateRoutes(app)
  registerExportRoutes(app)
  registerSoundfontRoutes(app)
  registerAdapterRoutes(app)
  registerStudioRoutes(app)
  registerImportRoutes(app)
  registerMixRoutes(app)
  registerAssetRoutes(app)
  registerCompanionRoutes(app)
  registerSyncRoutes(app)
  registerVst3Routes(app)
  registerProvisionRoutes(app)
  registerTrainingRoutes(app)

  // 生产模式：托管前端构建产物，并为 SPA 兜底
  if (serveStatic) {
    if (existsSync(path.join(webDistDir, 'index.html'))) {
      await app.register(fastifyStatic, { root: webDistDir, prefix: '/' })
    } else {
      app.log.warn(`SERVE_STATIC=1 但未找到前端构建产物：${webDistDir}（请先构建 apps/web）`)
    }
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: `接口不存在：${request.method} ${request.url}` })
    }
    if (serveStatic && existsSync(path.join(webDistDir, 'index.html'))) {
      return reply.sendFile('index.html')
    }
    return reply.code(404).send({ error: `未找到：${request.url}` })
  })

  app.setErrorHandler((error: unknown, request, reply) => {
    const err = error as { statusCode?: number; message?: string; stack?: string }
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500
    request.log.error({ err: error, url: request.url }, 'request failed')
    reply.code(status).send({ error: err.message || '服务器内部错误' })
  })

  return app
}

async function main(): Promise<void> {
  const app = await buildServer()
  try {
    await app.listen({ port, host })
  } catch (error) {
    app.log.error(error)
    process.exit(1)
  }

  const address = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`
  process.stdout.write(
    [
      '',
      `  ♪ AI 编曲伴侣 后端 v${SERVER_VERSION}`,
      `    地址      ${address}`,
      `    数据目录  ${dataDir}`,
      `    静态前端  ${serveStatic ? (existsSync(path.join(webDistDir, 'index.html')) ? '已启用' : '未构建（跳过）') : '关闭（开发模式走 Vite）'}`,
      `    健康检查  ${address}/api/health`,
      '',
    ].join('\n') + '\n',
  )

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    process.stdout.write(`\n收到 ${signal}，正在关闭服务…\n`)
    cancelActiveAiRun()
    try {
      await app.close()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href
  } catch {
    return true
  }
})()

if (isMain) {
  main().catch((error: unknown) => {
    process.stderr.write(`启动失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(1)
  })
}
