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
import { listWorkers } from '../companion/store.js'
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

/** 引擎量级（P9）：2B 标准（缺省，快）/ XL 4B（最高质量，需现代运行时 + xl 模型档） */
const ENGINE_TIERS = ['2b', 'xl'] as const
const ENGINE_LABEL: Record<string, string> = {
  '2b': '标准 2B',
  xl: 'XL 4B',
}

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

/** 调式 id → 引擎 keyscale 里用的英文调式名（引擎只认自由字符串，这里给常见叫法） */
const SCALE_LABEL: Record<string, string> = {
  major: 'major',
  minor: 'minor',
  harmonicMinor: 'harmonic minor',
  melodicMinor: 'melodic minor',
  dorian: 'dorian',
  phrygian: 'phrygian',
  lydian: 'lydian',
  mixolydian: 'mixolydian',
  locrian: 'locrian',
  pentatonicMajor: 'major pentatonic',
  pentatonicMinor: 'minor pentatonic',
  blues: 'blues',
  wholeTone: 'whole tone',
  chromatic: 'chromatic',
}

/**
 * 调性字符串轻量归一化（纯函数）：`"c minor"` → `"C minor"`、`"C#minor"` → `"C# minor"`。
 * 只认「主音 + 调式」形状（调式允许 1–2 个词）；乱码 / 过长一律返回 undefined，
 * 由调用方回落到工程调性 —— 宁可用工程的 C minor，也不要喂一个引擎读不懂的字符串。
 */
export function normalizeKeyscale(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const compact = value.trim().replace(/\s+/g, ' ')
  if (!compact || compact.length > 24) return undefined
  const matched = /^([A-Ga-g])([#b♯♭]?)\s*([A-Za-z]{2,12}(?:\s+[A-Za-z]{2,12})?)$/.exec(compact)
  if (!matched) return undefined
  const accidental = matched[2].replace('♯', '#').replace('♭', 'b')
  return `${matched[1].toUpperCase()}${accidental} ${matched[3].toLowerCase()}`
}

/** 工程 key/scale → 引擎 keyscale（纯函数）。工程是唯一事实来源，缺字段时给 undefined */
export function keyscaleFromProject(project?: { key?: string; scale?: string }): string | undefined {
  const key = typeof project?.key === 'string' ? project.key.trim() : ''
  const scale = typeof project?.scale === 'string' ? project.scale.trim() : ''
  if (!key) return undefined
  const scaleLabel = SCALE_LABEL[scale] ?? (scale || 'major')
  return normalizeKeyscale(`${key} ${scaleLabel}`)
}

/**
 * 演唱语言归一化（纯函数）：`"JA"` / `" ja "` → `"ja"`。
 *
 * 引擎的 `vocal_language` 是 BCP-47 代码（`ja`/`en`/`zh`），但 freetext 推断出来的
 * 值经常带大写或地区后缀（`JA`、`ja-JP`、`Japanese`）。这里只做归一化，**不判断
 * 合法性**——不认识的代码照样原样下发，由 Companion 决定是否回落。返回 undefined
 * 表示「用户没指定」，Companion 会用 caption 线索推断语言。
 */
export function normalizeVocalLanguage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const compact = value.trim().toLowerCase().replace(/_/g, '-')
  if (!compact || compact.length > 20) return undefined
  if (compact === 'unknown' || compact === 'instrumental') return undefined
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(compact) ? compact : undefined
}

/** 工程拍号 → 引擎 timesignature（分子字符串，如 "4"；引擎不认 "4/4"） */
export function timesignatureFromProject(project?: { timeSignature?: { numerator?: number } }): string | undefined {
  const numerator = Number(project?.timeSignature?.numerator)
  if (!Number.isInteger(numerator) || numerator < 1 || numerator > 16) return undefined
  return String(numerator)
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
      'caption 必须是由用户描述提炼的英文提示词（风格/乐器/情绪/BPM）；用户没提音频时不要调用本工具。' +
      '用户说明了调性（如「C 小调」「D 大调」）就填 keyscale（如 "C minor" / "D major"）；省略时按工程当前调性生成。',
    parameters: toolSchema(
      {
        mode: enm('执行方式。按用户意图选择；不确定时：已有编曲 → midi_to_audio，从零要成品 → text_to_audio', MODES),
        caption: str(
          '英文音频提示词：风格、主要乐器、情绪、BPM。例如 "warm cinematic piano with soft strings, slow, emotional, 72 bpm"。text_to_audio / audio_with_stems 必填；midi_to_audio 可选（作为渲染说明）',
        ),
        bpm: num('速度（20–320）；省略时用工程当前 BPM', { minimum: 20, maximum: 320 }),
        keyscale: str(
          '调性（主音 + 调式，如 "C minor"、"C# minor"、"F# major"）。用户说明了调性就填；省略时用工程当前调性。不要写成 "Cm" / "C" 这种简写',
        ),
        durationSec: num('音频时长（秒，5–300）；省略时默认 30（分轨模式默认 45）', { minimum: 5, maximum: 300 }),
        style: str('风格标签（可选，如 cinematic / lofi / pop）'),
        stems: arr('分轨乐器（仅 audio_with_stems 使用；省略默认 guitar/bass/drums）', enm('乐器', STEM_ARMS)),
        instrumental: bool(
          '是否纯乐器（无人声），缺省 true。用户要求「要人声 / 带唱 / 主唱 / vocals」时必须显式传 false：' +
            '引擎的歌词条件由它决定（true 会明确禁止人声）。若要人声分轨，整曲必须 instrumental=false，否则人声轨只能拆出噪声',
        ),
        vocalLanguage: str(
          '演唱语言（BCP-47，如 ja / en / zh）。仅 instrumental=false 时有效；用户说了语言就填（日语=ja），' +
            '省略时 Companion 按 caption 里的「Japanese/anime/J-ROCK」等线索推断，再不行给 en',
        ),
        startBeat: num('音频落轨起点（拍，≥0）；省略时落在播放头', { minimum: 0 }),
        trackName: str('可选的轨道/片段名（中文即可）'),
        quality: bool('质量模式：精修 50 步，更慢但更完整（与风格适配器互斥）'),
        engine: enm(
          '引擎量级：2b=标准 2B（快，缺省）；xl=XL 4B（最高质量，需 ≥12GB 显存且已安装 XL 模型档）。用户明确要「最高质量/最好效果/XL」时选 xl',
          ENGINE_TIERS,
        ),
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
      // 引擎量级（P9）：校验后只透传显式选择的值；缺省不写进计划（任务 params 不带 engine = 2b，保持旧默认）
      const engineRaw = typeof args.engine === 'string' ? args.engine.trim() : ''
      if (engineRaw && !(ENGINE_TIERS as readonly string[]).includes(engineRaw)) {
        return {
          ok: false,
          message: `engine 只能是 '2b'（${ENGINE_LABEL['2b']}）或 'xl'（${ENGINE_LABEL.xl}，最高质量）；不确定时省略该参数`,
        }
      }
      const engine = engineRaw === 'xl' ? ('xl' as const) : engineRaw === '2b' ? ('2b' as const) : undefined
      // 是否纯乐器（本轮修复）：缺省 true 保持旧行为（今天所有生成都是 [Instrumental]）；
      // 用户要人声时必须显式 false，否则「要人声的 caption + 禁止人声的歌词条件」互相打架，
      // 成品没有人声，后续人声分轨只能抽到噪声。
      const instrumental = args.instrumental === false ? false : true
      const wantsVocal = instrumental === false
      // 分词取人声但整曲是纯乐器 = 必然拆出噪声，计划里就把人声臂去掉（不留空轨）
      const stemsWithoutVocals = wantsVocal ? stems : stems.filter((arm) => arm !== 'vocals')
      const skippedVocalsStem = stems.length !== stemsWithoutVocals.length
      // 调性：模型给的优先（归一化后仍不合形状就当没给），否则按工程 key/scale 兜底。
      // 这一条是「用户要 C minor 的 J-ROCK，结果按 C major 生成」的修复点：调性必须进计划。
      const keyscale = normalizeKeyscale(args.keyscale) ?? keyscaleFromProject(project)
      const timesignature = timesignatureFromProject(project)
      const audioPlan = {
        mode,
        caption: caption || undefined,
        bpm,
        keyscale,
        timesignature,
        durationSec,
        style: typeof args.style === 'string' && args.style.trim() ? args.style.trim().slice(0, 80) : undefined,
        stems: stemsWithoutVocals.length ? stemsWithoutVocals : undefined,
        instrumental,
        // 演唱语言（可选）：只在要人声时有意义；规范化成小写 BCP-47，非法值丢弃由 Companion 兜底推断
        vocalLanguage: normalizeVocalLanguage(args.vocalLanguage),
        startBeat,
        trackName: typeof args.trackName === 'string' && args.trackName.trim() ? args.trackName.trim().slice(0, 60) : undefined,
        quality: args.quality === true || undefined,
        engine: engine ?? undefined,
        priority,
        reason: typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim().slice(0, 200) : undefined,
      }
      const stemText = stemsWithoutVocals.length
        ? `，分轨：${stemsWithoutVocals.map((arm) => STEM_LABEL[arm] ?? arm).join(' / ')}`
        : ''
      const engineText = engine ? `，引擎：${ENGINE_LABEL[engine]}` : ''
      const keyscaleText = keyscale ? `，调性 ${keyscale}` : ''
      const vocalText = wantsVocal ? '，含人声' : ''
      const skippedText = skippedVocalsStem
        ? '（注意：整曲是纯乐器、不含人声，已从分轨里去掉「人声」；要人声分轨请让整曲带人声后重试）'
        : ''
      // 工具只安排计划，真正执行在前端；先看一眼节点是否在线，避免 AI 回复「已生成」误导用户。
      // 离线不是错误：计划照常下发，界面会先建好占位轨并在节点上线后自动继续。
      const needsCompanion = mode !== 'midi_to_audio' && mode !== 'midi_then_audio'
      const workerOnline = !needsCompanion || listWorkers().length > 0
      const offlineHint = workerOnline
        ? ''
        : '注意：当前没有在线的生成节点（Companion），任务会先在界面中建好轨道并等待节点接入，启动后自动继续。' +
          '请如实告诉用户「任务已安排、正在等待生成节点」，不要声称已经生成完成。'
      return {
        ok: true,
        message:
          `已安排音频任务：${MODE_LABEL[mode]}（BPM ${bpm}${keyscaleText}${mode === 'midi_to_audio' ? '' : `，约 ${durationSec}s`}${vocalText}${stemText}${engineText}）。` +
          skippedText +
          '生成在界面中异步执行，完成后自动加入音频轨；你不需要轮询，用一两句话告诉用户选择了哪种模式即可。' +
          offlineHint,
        data: { audioPlan, workerOnline },
      }
    },
  },
]
