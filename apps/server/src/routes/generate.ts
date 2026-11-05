/**
 * 本地生成路由：POST /api/generate（不需要 AI Key，直接复用 @aiab/core 的生成器）。
 * 供前端「智能片段 / 快捷创作」在未配置模型时也能用。
 */
import type { FastifyInstance } from 'fastify'
import { profileForStyle } from '../style/profileStore.js'
import {
  STYLE_PROGRESSIONS,
  STYLES,
  arrangeFromMelody,
  beatsPerBar,
  buildAccompaniment,
  buildSections,
  composeProject,
  createVariationSeed,
  deepClone,
  generateSmartClip,
  projectSchema,
  progressionToChords,
  type Project,
  type ScaleId,
  type SmartClipConfig,
  type StyleId,
} from '@aiab/core'
import { loadSettings } from '../storage/settings.js'
import { executeTool } from '../tools/index.js'
import type { ToolContext } from '../tools/schema.js'
import { errorMessage, toNumber } from '../util.js'

type GenerateIntent = 'compose' | 'arrange' | 'melody' | 'chords' | 'variation'

interface GenerateBody {
  intent?: unknown
  project?: unknown
  options?: unknown
}

function pickStyle(value: unknown, fallback: StyleId = 'pop'): StyleId {
  return typeof value === 'string' && value in STYLES ? (value as StyleId) : fallback
}

function pickScale(value: unknown, fallback: ScaleId): ScaleId {
  return typeof value === 'string' && value ? (value as ScaleId) : fallback
}

function optionString(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function defaultChords(project: Project, style: StyleId) {
  const barBeats = beatsPerBar(project.timeSignature)
  const romans = STYLE_PROGRESSIONS[style] ?? STYLE_PROGRESSIONS.pop
  return progressionToChords(romans, project.key, project.scale, barBeats)
}

function makeContext(project: Project): ToolContext {
  const settings = loadSettings()
  return {
    project,
    settings,
    allowProjectEdits: true,
    allowWebSearch: false,
  }
}

export function registerGenerateRoutes(app: FastifyInstance): void {
  app.post<{ Body: GenerateBody }>('/api/generate', async (request, reply) => {
    const body = request.body ?? {}
    const parsedProject = projectSchema.safeParse(body.project)
    if (!parsedProject.success) {
      const issue = parsedProject.error.issues[0]
      return reply.code(400).send({ error: `project 不合法：${issue ? `${issue.path.join('.')} ${issue.message}` : '未知错误'}` })
    }
    let project = parsedProject.data as unknown as Project
    const intent = (typeof body.intent === 'string' ? body.intent : 'compose') as GenerateIntent
    const options = (body.options && typeof body.options === 'object' ? body.options : {}) as Record<string, unknown>
    const style = pickStyle(options.style)
    const barBeats = beatsPerBar(project.timeSignature)

    try {
      if (intent === 'compose') {
        const composed = composeProject({
          style,
          key: optionString(options, 'key') ?? project.key,
          scale: pickScale(options.scale, project.scale),
          tempo: toNumber(options.tempo, project.tempo),
          bars: Math.max(1, Math.round(toNumber(options.bars, 16))),
          seed: Math.round(toNumber(options.seed, Math.floor(Math.random() * 100000))),
          energy: toNumber(options.energy, 0.62),
          name: optionString(options, 'name') ?? project.name,
          profile: profileForStyle(style),
        })
        return reply.send({
          project: composed,
          summary: `已生成「${composed.name}」：${style} 风格，${composed.tracks.length} 条轨道、${composed.tracks.reduce((sum, track) => sum + track.clips.reduce((n, clip) => n + clip.notes.length, 0), 0)} 个音符。`,
        })
      }

      if (intent === 'arrange') {
        const melodyTrackId = optionString(options, 'melodyTrackId') ?? optionString(options, 'trackId')
        const melodyClipId = optionString(options, 'melodyClipId') ?? optionString(options, 'clipId')
        const ctx = makeContext(project)
        if (melodyTrackId || melodyClipId) {
          const result = await executeTool(
            'arrange_from_melody',
            {
              melodyTrackId,
              melodyClipId,
              style,
              key: optionString(options, 'key'),
              scale: optionString(options, 'scale'),
              bars: options.bars,
              energy: options.energy,
              seed: options.seed,
              mode: optionString(options, 'mode') ?? 'append',
            },
            ctx,
          )
          if (result.ok && result.project) {
            return reply.send({ project: result.project, summary: result.message })
          }
        }
        // 没有旋律：直接按风格 + 和弦铺伴奏
        const chords = project.chords.length ? project.chords : defaultChords(project, style)
        const bars = Math.max(1, Math.round(toNumber(options.bars, Math.max(4, Math.ceil(project.chords.reduce((s, c) => s + c.beats, 0) / barBeats) || 8))))
        const tracks = buildAccompaniment({
          style,
          key: project.key,
          scale: project.scale,
          tempo: project.tempo,
          bars,
          chords,
          energy: toNumber(options.energy, 0.62),
          seed: Math.round(toNumber(options.seed, Math.floor(Math.random() * 100000))),
          timeSignature: project.timeSignature,
          profile: profileForStyle(style),
        })
        project = deepClone(project)
        project.tracks = tracks
        project.chords = chords
        project.sections = buildSections(bars, style)
        project.updatedAt = Date.now()
        return reply.send({
          project,
          summary: `已按 ${style} 风格生成 ${tracks.length} 条伴奏轨道（${bars} 小节）。`,
        })
      }

      if (intent === 'melody') {
        const ctx = makeContext(project)
        const result = await executeTool(
          'melody_from_chords',
          {
            style,
            key: optionString(options, 'key'),
            scale: optionString(options, 'scale'),
            bars: options.bars,
            octave: options.octave,
            density: options.density,
            complexity: options.complexity,
            energy: options.energy,
            seed: options.seed,
            instrumentId: optionString(options, 'instrumentId'),
            trackId: optionString(options, 'trackId'),
            startBeat: options.startBeat,
          },
          ctx,
        )
        if (!result.ok || !result.project) return reply.code(400).send({ error: result.message })
        return reply.send({ project: result.project, summary: result.message })
      }

      if (intent === 'chords') {
        const romans = Array.isArray(options.romans)
          ? options.romans.filter((item): item is string => typeof item === 'string')
          : (STYLE_PROGRESSIONS[style] ?? STYLE_PROGRESSIONS.pop)
        const chords = progressionToChords(romans, project.key, project.scale, barBeats)
        project = deepClone(project)
        project.chords = chords
        if (options.sections !== false) {
          const bars = Math.max(4, Math.ceil(chords.reduce((sum, chord) => sum + chord.beats, 0) / barBeats))
          project.sections = buildSections(bars, style)
        }
        project.updatedAt = Date.now()
        return reply.send({
          project,
          summary: `已生成和弦进行：${romans.join(' - ')}（${project.key} ${project.scale}）。`,
        })
      }

      if (intent === 'variation') {
        const clipId = optionString(options, 'clipId')
        const trackId = optionString(options, 'trackId')
        const seedInput = Math.round(toNumber(options.seed, Math.floor(Math.random() * 100000)))
        project = deepClone(project)
        let changed = 0
        const ctx = makeContext(project)
        const targets: { trackId: string; clipId: string; smart: SmartClipConfig }[] = []
        for (const track of project.tracks) {
          for (const clip of track.clips) {
            if (!clip.smart) continue
            if (clipId && clip.id !== clipId) continue
            if (trackId && track.id !== trackId) continue
            targets.push({ trackId: track.id, clipId: clip.id, smart: clip.smart })
          }
        }
        if (targets.length === 0) {
          return reply.code(400).send({ error: '没有可变奏的智能片段（请先生成智能片段，或指定 clipId）' })
        }
        for (const target of targets) {
          const params = target.smart.params
          const nextSeed = createVariationSeed(target.smart.seed, (seedInput % 97) + 1)
          const result = await executeTool(
            'generate_smart_clip',
            {
              kind: target.smart.kind,
              trackId: target.trackId,
              replaceClipId: target.clipId,
              style: target.smart.style ?? style,
              bars: params.bars,
              seed: nextSeed,
              density: params.density,
              complexity: params.complexity,
              energy: params.energy,
              octave: params.octave,
              swing: params.swing,
              humanize: params.humanize,
              gate: params.gate,
              patternId: params.patternId,
            },
            ctx,
          )
          if (result.ok && result.project) {
            changed++
            // 后续工具在最新快照上执行
            ctx.project = result.project
          }
        }
        if (changed === 0) return reply.code(400).send({ error: '变奏生成失败：没有片段被更新' })
        project = ctx.project
        project.updatedAt = Date.now()
        return reply.send({ project, summary: `已为 ${changed} 个智能片段生成新的变奏。` })
      }

      return reply.code(400).send({ error: `未知 intent：${String(intent)}（可选 compose/arrange/melody/chords/variation）` })
    } catch (error) {
      return reply.code(500).send({ error: `生成失败：${errorMessage(error)}` })
    }
  })
}
