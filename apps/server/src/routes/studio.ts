/**
 * Studio 形态的创作入口：
 *
 *   GET  /api/studio/presets            风格 + 用途场景预设（前端向导用）
 *   POST /api/studio/new                按「风格 + 用途」直接生成工程
 *   POST /api/suggest/progressions      和弦进行灵感（带节奏提示）
 *
 * 这些接口都只依赖 @aiab/core 的纯函数，不需要 AI Key，离线可用。
 */
import type { FastifyInstance } from 'fastify'
import {
  SCENES,
  STYLES,
  composeSceneProject,
  getScene,
  progressionToChords,
  completeProgression,
  suggestProgressions,
  type ScaleId,
  type StyleId,
} from '@aiab/core'
import { errorMessage, toNumber } from '../util.js'

type Body = Record<string, unknown>

function pickStyle(value: unknown, fallback: StyleId = 'pop'): StyleId {
  return typeof value === 'string' && value in STYLES ? (value as StyleId) : fallback
}

export function registerStudioRoutes(app: FastifyInstance): void {
  app.get('/api/studio/presets', async () => ({
    styles: Object.values(STYLES).map((style) => ({
      id: style.id,
      name: style.name,
      nameEn: style.nameEn,
      description: style.description,
      bpm: style.defaultTempo,
      tempoRange: style.tempoRange,
      scale: style.defaultScale,
      accent: style.accent,
      recommendedInstruments: style.recommendedInstruments,
    })),
    scenes: SCENES.map((scene) => ({
      id: scene.id,
      name: scene.name,
      nameEn: scene.nameEn,
      description: scene.description,
      styleId: scene.styleId,
      bpm: scene.tempo,
      key: scene.key,
      scale: scene.scale,
      bars: scene.bars,
      energy: scene.energy,
      sectionNames: scene.sectionNames ?? [],
    })),
  }))

  app.post<{ Body: Body }>('/api/studio/new', async (request, reply) => {
    const body = request.body ?? {}
    const style = pickStyle(body.style)
    const sceneId = typeof body.scene === 'string' && body.scene ? body.scene : undefined
    if (sceneId && !getScene(sceneId)) {
      return reply.code(400).send({ error: `未知用途：${sceneId}（可用：${SCENES.map((s) => s.id).join(', ')}）` })
    }
    try {
      const { project, scene } = composeSceneProject({
        style,
        sceneId,
        bars: body.bars === undefined ? undefined : Math.max(4, Math.round(toNumber(body.bars, 16))),
        seed: body.seed === undefined ? undefined : Math.round(toNumber(body.seed, 1)),
        name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined,
      })
      const notes = project.tracks.reduce((sum, track) => sum + track.clips.reduce((n, clip) => n + clip.notes.length, 0), 0)
      const where = scene ? `${scene.name}（${scene.styleId}）` : `${style}`
      return reply.send({
        project,
        scene: scene?.id ?? null,
        summary: `已按「${where}」生成：${project.tempo} BPM / ${project.key} ${project.scale}，${project.tracks.length} 轨 ${notes} 个音符。`,
      })
    } catch (error) {
      return reply.code(500).send({ error: `生成失败：${errorMessage(error)}` })
    }
  })

  app.post<{ Body: Body }>('/api/suggest/complete-progression', async (request, reply) => {
    const body = request.body ?? {}
    const partial = Array.isArray(body.partial) ? body.partial.map((item) => String(item)) : []
    if (partial.length === 0) {
      return reply.code(400).send({ error: '请先给至少一个和弦（罗马数字，例如 I V vi IV）' })
    }
    const style = pickStyle(body.style)
    const scale = typeof body.scale === 'string' && body.scale ? (body.scale as ScaleId) : STYLES[style].defaultScale
    const key = typeof body.key === 'string' && body.key.trim() ? body.key.trim() : 'C'
    try {
      const result = completeProgression({
        key,
        scale,
        style,
        partial,
        targetLength: Math.round(toNumber(body.targetLength, 8)),
        beatsPerChord: Math.round(toNumber(body.beatsPerChord, 4)),
      })
      return reply.send({
        ...result,
        summary: `${STYLES[style].name} · ${key} ${scale}：补全 ${result.completion.length} 个和弦（${result.cadence}）`,
      })
    } catch (error) {
      // 用户输入问题（无法识别的罗马数字）→ 400；其余 500
      const message = errorMessage(error)
      const status = /无法识别|级数超出|请先给/.test(message) ? 400 : 500
      return reply.code(status).send({ error: message })
    }
  })

  app.post<{ Body: Body }>('/api/suggest/progressions', async (request, reply) => {
    const body = request.body ?? {}
    const style = pickStyle(body.style)
    const scale = typeof body.scale === 'string' && body.scale ? (body.scale as ScaleId) : undefined
    const key = typeof body.key === 'string' && body.key.trim() ? body.key.trim() : undefined
    try {
      const suggestions = suggestProgressions({
        style,
        key,
        scale,
        count: Math.round(toNumber(body.count, 4)),
        seed: body.seed === undefined ? 1 : Math.round(toNumber(body.seed, 1)),
      })
      // 附带一份"直接可写进工程"的完整进行（把建议串成 8 小节）
      const chained = suggestions[0]
        ? progressionToChords(
            [...suggestions[0].roman, ...suggestions[0].roman],
            key ?? 'C',
            scale ?? STYLES[style].defaultScale,
            4,
          )
        : []
      return reply.send({
        style,
        key: key ?? 'C',
        scale: scale ?? STYLES[style].defaultScale,
        suggestions: suggestions.map((idea) => ({
          id: idea.id,
          roman: idea.roman,
          chords: idea.chords,
          label: idea.label,
          description: idea.description,
          patternHint: idea.patternHint,
        })),
        chained,
        summary: `给出 ${suggestions.length} 条 ${STYLES[style].name} 可用的和弦进行。`,
      })
    } catch (error) {
      return reply.code(500).send({ error: `生成进行失败：${errorMessage(error)}` })
    }
  })
}
