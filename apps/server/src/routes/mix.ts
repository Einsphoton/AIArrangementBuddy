/**
 * AI 混音（MIDI 域版）：
 *
 *   POST /api/mix/suggest   给工程出一份混音方案（音量/声像/发送/总线）+ 可读差异
 *
 * 只返回方案，不落库；应用由前端走 store（一步可撤销）。
 */
import type { FastifyInstance } from 'fastify'
import {
  STYLES,
  describeMasterChain,
  masterChainReasons,
  projectSchema,
  suggestMasterChain,
  suggestMix,
  suggestMixChains,
  summarizeMixChains,
  summarizeMixPlan,
  type StyleId,
} from '@aiab/core'
import { errorMessage, toNumber } from '../util.js'

type Body = { project?: unknown; style?: unknown; energy?: unknown }

function pickStyle(value: unknown, fallback?: StyleId): StyleId | undefined {
  return typeof value === 'string' && value in STYLES ? (value as StyleId) : fallback
}

export function registerMixRoutes(app: FastifyInstance): void {
  app.post<{ Body: Body }>('/api/mix/suggest', async (request, reply) => {
    const body = request.body ?? {}
    const parsed = projectSchema.safeParse(body.project)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return reply.code(400).send({ error: `project 不合法：${issue ? `${issue.path.join('.')} ${issue.message}` : '未知错误'}` })
    }
    if (parsed.data.tracks.length === 0) {
      return reply.code(400).send({ error: '工程还没有轨道，先加几轨再混音' })
    }
    try {
      const project = parsed.data as unknown as Parameters<typeof suggestMix>[0]
      const plan = suggestMix(project, {
        style: pickStyle(body.style, project.style as StyleId | undefined),
        energy: body.energy === undefined ? undefined : toNumber(body.energy, 0.6),
      })
      const preview = summarizeMixPlan(project, plan)
      // 音频域处理链（EQ + 压缩）：与推子方案独立，前端按用户勾选决定是否一起应用
      const chainPlan = suggestMixChains(project, {
        style: pickStyle(body.style, project.style as StyleId | undefined),
        energy: body.energy === undefined ? undefined : toNumber(body.energy, 0.6),
      })
      const chainPreview = summarizeMixChains(chainPlan)
      // 总线 / 母带处理链（P3.2）：同样独立开关，一次 mutate 一起应用
      const targetStyle: StyleId = pickStyle(body.style, project.style as StyleId | undefined) ?? 'pop'
      const energy = body.energy === undefined ? chainPlan.energy : toNumber(body.energy, 0.6)
      const masterChain = suggestMasterChain(targetStyle, energy, project.tracks.length)
      return reply.send({
        plan,
        preview,
        chains: chainPlan.tracks,
        chainNotes: chainPlan.notes,
        chainPreview,
        masterChain,
        masterPreview: [describeMasterChain(masterChain), ...masterChainReasons(targetStyle, energy)],
        masterNotes: [
          `${STYLES[targetStyle]?.name ?? targetStyle} · 能量 ${Math.round(energy * 100)}%`,
          '总线 EQ + 母线压缩 + 限幅上限（-1dBFS）',
        ],
        summary: `已生成 ${plan.tracks.length} 轨混音方案 + ${chainPlan.tracks.length} 轨处理链 + 母线处理：${plan.notes[0] ?? ''}`,
      })
    } catch (error) {
      return reply.code(500).send({ error: `混音方案生成失败：${errorMessage(error)}` })
    }
  })
}
