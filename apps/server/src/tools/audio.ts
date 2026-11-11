/**
 * 音频生成工具（P9）：让 AI 编曲助手按用户意图决定「MIDI / 音频 / 先 MIDI 再音频 / 分轨」。
 *
 * 实现要点（与 CONTRACTS §6 一致）：
 * - 工具本身**不执行**长时间任务，只把一份经过校验的 AudioPlan 放进 `data.audioPlan`；
 * - 内置 Agent 会把 `data` 随 tool_end 下发给前端，由前端（audioIntent.ts）提交
 *   Companion 任务或离线渲染，并把进度/落轨展示在 AI 面板；
 * - 这样 Codex / DSH 等外部 Agent 后端也能共用同一套执行逻辑；
 * - 参数校验失败时返回结构化的中文提示，让模型自己修正后重试。
 */
import type { ToolContext, ToolDef, ToolResult } from './schema.js'
import { arr, bool, enm, int, num, str, toolSchema } from './schema.js'

/** generate_stem 支持的乐器手臂（与 /api/companion/tasks 一致） */
const STEM_ARMS = ['guitar', 'bass', 'drums', 'strings', 'keys', 'synth', 'vocals'] as const
const STEM_LABEL: Record<string, string> = {
  guitar: '吉他',
  bass: '贝斯',
  drums: '鼓组',
  strings: '弦乐',
  keys: '键盘',
  synth: '合成器',
  vocals: '人声',
}

const MODES = ['text_to_audio', 'midi_to_audio', 'audio_with_stems', 'midi_then_audio'] as const

const MODE_LABEL: Record<string, string> = {
  text_to_audio: '文本 → 整首音频',
  midi_to_audio: '当前 MIDI 工程 → 音频',
  audio_with_stems: '文本 → 整曲音频 + 分轨',
  midi_then_audio: '先编 MIDI 再渲染音频',
}

const AUDIO_MODES: readonly string[] = MODES

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isAudioMode(value: string): value is (typeof MODES)[number] {
  return AUDIO_MODES.includes(value)
}

function normalizeStems(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    const value = String(item)
    if ((STEM_ARMS as readonly string[]).includes(value) && !out.includes(value)) out.push(value)
  }
  return out
}

export const AUDIO_TOOLS: ToolDef[] = [
  {
    name: 'generate_audio',
    title: '生成音频',
    description:
      '把用户的「音频/成品/分轨」需求交给应用执行。先根据用户原话判断模式，再调用：' +
      'text_to_audio=在没有可用 MIDI 或用户只想要成品音频时，用文本提示词生成整首音频；' +
      'midi_to_audio=工程里已有编曲，用户想「导出/渲染/听成品」时，把当前 MIDI 工程离线渲染成音频轨；' +
      'audio_with_stems=用户要「生成音频并分轨/分开乐器」时，先生成整曲再逐条生成 stem；' +
      'midi_then_audio=用户要「先编曲再出音频」时，先用 MIDI 工具完成编曲，再调用本工具渲染。' +
      'caption 必须是由用户描述提炼的英文提示词（风格/乐器/情绪/BPM）；用户没提音频时不要调用本工具。',
    parameters: toolSchema(
      {
        mode: enm('执行方式。按用户意图选择；不确定时：已有编曲 → midi_to_audio，从零要成品 → text_to_audio', MODES),
        caption: str(
          '英文音频提示词：风格、主要乐器、情绪、BPM。例如 "warm cinematic piano with soft strings, slow, emotional, 72 bpm"。text_to_audio / audio_with_stems 必填；midi_to_audio 可选（作为渲染说明）',
        ),
        bpm: num('速度（20–320）；省略时用工程当前 BPM', { minimum: 20, maximum: 320 }),
        durationSec: num('音频时长（秒，5–300）；省略时默认 30（分轨模式默认 45）', { minimum: 5, maximum: 300 }),
        style: str('风格标签（可选，如 cinematic / lofi / pop）'),
        stems: arr('分轨乐器（仅 audio_with_stems 使用；省略默认 guitar/bass/drums）', enm('乐器', STEM_ARMS)),
        startBeat: num('音频落轨起点（拍，≥0）；省略时落在播放头', { minimum: 0 }),
        trackName: str('可选的轨道/片段名（中文即可）'),
        quality: bool('质量模式：LM → sft 50 步，更慢但更完整（与适配器互斥）'),
        priority: int('任务优先级：0 普通 / 1 高 / 2 紧急', { minimum: 0, maximum: 2 }),
        reason: str('用一句中文说明为什么选这个模式，会展示给用户'),
      },
      ['mode'],
    ),
    handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
      const mode = String(args.mode ?? '')
      if (!isAudioMode(mode)) {
        return {
          ok: false,
          message: `mode 必须是 ${MODES.join(' / ')} 之一；请先判断用户要「直接音频 / MIDI 渲染 / 分轨 / 先编曲再渲染」`,
        }
      }
      const project = ctx.project
      const caption = typeof args.caption === 'string' ? args.caption.trim() : ''
      const needsCaption = mode === 'text_to_audio' || mode === 'audio_with_stems'
      if (needsCaption && !caption) {
        return {
          ok: false,
          message: `mode=${mode} 需要 caption：请把用户的描述提炼成英文提示词（风格/乐器/情绪/BPM）。例如 "warm cinematic piano with soft strings, slow, emotional, 72 bpm"`,
        }
      }
      if (mode === 'midi_to_audio' || mode === 'midi_then_audio') {
        const hasContent = project.tracks.some((track) => track.clips.length > 0 || track.audioClips.length > 0)
        if (!hasContent) {
          return {
            ok: false,
            message:
              '当前工程还是空的，无法直接把 MIDI 渲染成音频。请先用 create_track / generate_smart_clip / arrange_from_melody 等工具完成编曲，再调用 generate_audio(mode: "midi_to_audio")。',
          }
        }
      }
      const bpm = Number.isFinite(Number(args.bpm)) ? Math.round(clamp(Number(args.bpm), 20, 320)) : Math.round(project.tempo)
      const durationRaw = Number(args.durationSec)
      const durationSec = Number.isFinite(durationRaw)
        ? Math.round(clamp(durationRaw, 5, 300))
        : mode === 'audio_with_stems'
          ? 45
          : 30
      const stemList = normalizeStems(args.stems)
      const stems = mode === 'audio_with_stems' ? (stemList.length ? stemList : ['guitar', 'bass', 'drums']) : []
      const priority = Number.isFinite(Number(args.priority)) ? clamp(Math.round(Number(args.priority)), 0, 2) : 0
      const startBeat = Number.isFinite(Number(args.startBeat)) ? Math.max(0, Number(args.startBeat)) : undefined
      const audioPlan = {
        mode,
        caption: caption || undefined,
        bpm,
        durationSec,
        style: typeof args.style === 'string' && args.style.trim() ? args.style.trim().slice(0, 80) : undefined,
        stems: stems.length ? stems : undefined,
        startBeat,
        trackName: typeof args.trackName === 'string' && args.trackName.trim() ? args.trackName.trim().slice(0, 60) : undefined,
        quality: args.quality === true || undefined,
        priority,
        reason: typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim().slice(0, 200) : undefined,
      }
      const stemText = stems.length ? `，分轨：${stems.map((arm) => STEM_LABEL[arm] ?? arm).join(' / ')}` : ''
      return {
        ok: true,
        message:
          `已安排音频任务：${MODE_LABEL[mode]}（BPM ${bpm}${mode === 'midi_to_audio' ? '' : `，约 ${durationSec}s`}${stemText}）。` +
          '生成在界面中异步执行，完成后自动加入音频轨；你不需要轮询，用一两句话告诉用户选择了哪种模式即可。',
        data: { audioPlan },
      }
    },
  },
]
