/** 导出路由：MIDI 文件（服务端生成）+ WAV -> mp3/flac/ogg（ffmpeg 转码）。 */
import { createWriteStream, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance } from 'fastify'
import { projectSchema, projectToMidiBytes, type Project } from '@aiab/core'
import { detectFfmpeg } from '../config.js'
import { errorMessage, truncate } from '../util.js'
import { createZip } from '../zip.js'

const AUDIO_FORMATS = ['mp3', 'flac', 'ogg'] as const
type AudioFormat = (typeof AUDIO_FORMATS)[number]

const CONTENT_TYPES: Record<AudioFormat, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
}

function sanitizeFilename(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || fallback
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

function runFfmpeg(args: string[], timeoutMs = 300_000): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000)
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ ok: false, stderr: `${stderr}\nffmpeg 执行超时（>${Math.round(timeoutMs / 1000)} 秒）` })
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, stderr: error.message })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, stderr })
    })
  })
}

export function registerExportRoutes(app: FastifyInstance): void {
  app.post<{ Body: { project?: unknown; split?: unknown }; Querystring: { split?: string } }>(
    '/api/export/midi',
    async (request, reply) => {
      const parsed = projectSchema.safeParse(request.body?.project)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        return reply.code(400).send({ error: `project 不合法：${issue ? `${issue.path.join('.')} ${issue.message}` : '未知错误'}` })
      }
      const project = parsed.data as unknown as Project
      // split=true（body 或 ?split=1）时导出分轨 ZIP：每轨一个 .mid + manifest.json
      const split =
        request.body?.split === true ||
        request.body?.split === 'true' ||
        request.query?.split === '1' ||
        request.query?.split === 'true'
      try {
        if (!split) {
          const bytes = projectToMidiBytes(project)
          const filename = sanitizeFilename(`${project.name || 'project'}.mid`, 'project.mid')
          return reply
            .header('Content-Type', 'audio/midi')
            .header('Content-Disposition', contentDisposition(filename))
            .send(Buffer.from(bytes))
        }

        // 有音符的轨道都导出（静音轨也导出，方便当分轨素材）
        const tracks = project.tracks.filter((track) => track.clips.some((clip) => clip.notes.length > 0))
        if (tracks.length === 0) return reply.code(400).send({ error: '工程没有可导出的轨道（所有轨道都没有音符）' })
        const entries: { name: string; data: Buffer }[] = []
        const manifestTracks: Record<string, unknown>[] = []
        tracks.forEach((track, index) => {
          const single = {
            ...project,
            tracks: [{ ...track, mute: false, solo: false }],
          }
          const bytes = projectToMidiBytes(single)
          const prefix = String(index + 1).padStart(2, '0')
          // 压缩包内文件名保持 ASCII（乐器 id），中文轨道名写进 manifest.json：
          // macOS 自带 unzip 对 UTF-8 文件名支持不佳，中文名会导致解压报 Illegal byte sequence
          const asciiName = (track.instrumentId || track.id).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 48) || 'track'
          const filename = `${prefix}_${asciiName}.mid`
          entries.push({ name: filename, data: Buffer.from(bytes) })
          manifestTracks.push({
            file: filename,
            id: track.id,
            name: track.name,
            instrumentId: track.instrumentId,
            gmProgram: track.gmProgram,
            notes: track.clips.reduce((sum, clip) => sum + clip.notes.length, 0),
          })
        })
        entries.push({
          name: 'manifest.json',
          data: Buffer.from(
            JSON.stringify(
              {
                project: { id: project.id, name: project.name, tempo: project.tempo, key: project.key, scale: project.scale },
                trackCount: tracks.length,
                tracks: manifestTracks,
                generatedAt: new Date().toISOString(),
              },
              null,
              2,
            ),
            'utf8',
          ),
        })
        const zip = createZip(entries)
        const zipName = sanitizeFilename(`${project.name || 'project'}-分轨.zip`, 'stems.zip')
        return reply
          .header('Content-Type', 'application/zip')
          .header('Content-Disposition', contentDisposition(zipName))
          .header('X-Track-Count', String(tracks.length))
          .send(zip)
      } catch (error) {
        return reply.code(500).send({ error: `MIDI 生成失败：${errorMessage(error)}` })
      }
    },
  )

  app.post('/api/export/audio', async (request, reply) => {
    const ffmpeg = detectFfmpeg()
    if (!ffmpeg.available) {
      return reply.code(501).send({
        error:
          '服务端未检测到 ffmpeg，无法转码 mp3/flac/ogg。请安装 ffmpeg（macOS: brew install ffmpeg），或直接导出 WAV。',
      })
    }
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: '请用 multipart/form-data 上传 wav 文件（字段名 file）' })
    }

    const workDir = mkdtempSync(path.join(tmpdir(), 'aiab-export-'))
    let wavPath = ''
    let format = ''
    let bitrate = ''
    let projectName = 'render'
    let uploadBytes = 0

    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file') {
            part.file.resume()
            continue
          }
          const ext = path.extname(part.filename || '').toLowerCase() || '.wav'
          wavPath = path.join(workDir, `input${ext === '.wav' ? '.wav' : ext}`)
          await pipeline(part.file, createWriteStream(wavPath))
        } else {
          const value = typeof part.value === 'string' ? part.value : String(part.value)
          if (part.fieldname === 'format') format = value.toLowerCase()
          else if (part.fieldname === 'bitrate') bitrate = value
          else if (part.fieldname === 'name') projectName = value
        }
      }
    } catch (error) {
      rmSync(workDir, { recursive: true, force: true })
      return reply.code(400).send({ error: `读取上传文件失败：${errorMessage(error)}` })
    }

    try {
      if (!wavPath) return reply.code(400).send({ error: '缺少 WAV 文件（字段名 file）' })
      if (!(AUDIO_FORMATS as readonly string[]).includes(format)) {
        return reply.code(400).send({ error: `不支持的格式：${format || '未指定'}（可选 mp3 / flac / ogg）` })
      }
      const audioFormat = format as AudioFormat
      try {
        uploadBytes = readFileSync(wavPath).byteLength
      } catch {
        uploadBytes = 0
      }
      if (uploadBytes < 44) return reply.code(400).send({ error: '上传的 WAV 文件为空或损坏' })

      const outputPath = path.join(workDir, `output.${audioFormat}`)
      // 不同 ffmpeg 构建带的编码器不同：ogg 优先 libvorbis，缺失时回退 libopus（Opus-in-Ogg）
      const encoderAttempts: string[][] =
        audioFormat === 'mp3'
          ? [['-codec:a', 'libmp3lame', '-b:a', bitrate || '192k']]
          : audioFormat === 'flac'
            ? [['-codec:a', 'flac', '-compression_level', '5']]
            : [
                ['-codec:a', 'libvorbis', '-q:a', '5'],
                ['-codec:a', 'libopus', '-b:a', '160k'],
              ]
      let lastError = ''
      let encoded = false
      for (const encoderArgs of encoderAttempts) {
        const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', wavPath, ...encoderArgs, outputPath]
        const result = await runFfmpeg(args)
        if (result.ok) {
          encoded = true
          break
        }
        lastError = result.stderr
      }
      if (!encoded) {
        return reply.code(500).send({ error: `ffmpeg 转码失败：${truncate(lastError.trim(), 800)}` })
      }
      let output: Buffer
      try {
        output = readFileSync(outputPath)
      } catch {
        return reply.code(500).send({ error: 'ffmpeg 未生成输出文件' })
      }
      const filename = sanitizeFilename(`${projectName}.${audioFormat}`, `render.${audioFormat}`)
      return reply
        .header('Content-Type', CONTENT_TYPES[audioFormat])
        .header('Content-Disposition', contentDisposition(filename))
        .header('X-Original-Bytes', String(uploadBytes))
        .send(output)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })
}
