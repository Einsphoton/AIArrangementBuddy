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

const MODES = ['text_to_audio', 'midi_to_audio', 'ai_cover', 'audio_with_stems'] as const

/** 引擎量级（P9）：2B 标准（缺省，快）/ XL 4B（最高质量，需现代运行时 + xl 模型档） */
const ENGINE_TIERS = ['2b', 'xl'] as const
const ENGINE_LABEL: Record<string, string> = {
  '2b': '标准 2B',
  xl: 'XL 4B',
}

const MODE_LABEL: Record<string, string> = {
  text_to_audio: '文本 → 整首音频',
  midi_to_audio: '忠实渲染（当前 MIDI 工程 → 音频）',
  ai_cover: 'AI 重编（保留编曲骨架，AI 重新配器/换音色）',
  audio_with_stems: '文本 → 整曲音频 + 分轨',
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
      '把用户的「音频/成品/分轨」需求交给应用执行。先判断用户要的是「忠实导出」还是「AI 成品」，再调用：' +
      'text_to_audio=从零用文本生成整首（不读取工程 MIDI；没有可用编曲或用户只想要一首新歌时用）；' +
      'midi_to_audio=忠实渲染：用浏览器采样器把当前 MIDI 工程逐音渲染成音频（不启动 AI 模型，结果与 MIDI 一一对应）；' +
      'ai_cover=AI 重编：先把当前工程渲染成参考音频，再交给 AI 引擎保结构换编制/换音色（会改细节、不保证逐音对齐；' +
      '用户说「用 AI 渲染 / 用 AI 做成成品 / 换编制 / 重新配器 / 让它更好听」时用这个）；' +
      'audio_with_stems=先生成整曲再分离分轨。' +
      '重要：midi_to_audio 不接受 engine/quality，也不要把它的结果说成「AI 引擎生成」；只有 text_to_audio / ai_cover / audio_with_stems 会启动 AI 模型。' +
      'caption 必须是由用户描述提炼的英文提示词（风格/乐器/情绪/BPM）；用户没提音频时不要调用本工具。' +
      '用户说明了调性（如「C 小调」「D 大调」）就填 keyscale（如 "C minor" / "D major"）；省略时按工程当前调性生成。',
    parameters: toolSchema(
      {
        mode: enm(
          '执行方式：要「导出/转 WAV/忠实渲染」→ midi_to_audio；要「AI 成品/AI 重编/换音色/别只是 MIDI 转音频」→ ai_cover；从零生成 → text_to_audio；要分轨 → audio_with_stems',
          MODES,
        ),
        caption: str(
          '英文音频提示词：风格、主要乐器、情绪、BPM。例如 "warm cinematic piano with soft strings, slow, emotional, 72 bpm"。text_to_audio / audio_with_stems / ai_cover 必填（ai_cover 用它说明希望重编成什么风格/编制）；midi_to_audio 不需要',
        ),
        coverStrength: num(
          'AI 重编的贴近度（仅 ai_cover，0–1）：越大越贴近原编曲结构（默认 0.7）；越小 AI 改动越自由',
          { minimum: 0, maximum: 1 },
        ),
        bpm: num('速度（20–320）；省略时用工程当前 BPM', { minimum: 20, maximum: 320 }),
        keyscale: str(
          '调性（主音 + 调式，如 "C minor"、"C# minor"、"F# major"）。用户说明了调性就填；省略时用工程当前调性。不要写成 "Cm" / "C" 这种简写',
        ),
        durationSec: num(
          '音频时长（秒，5–300；仅 text_to_audio / audio_with_stems；ai_cover 跟随工程长度，midi_to_audio 跟随工程长度）',
          { minimum: 5, maximum: 300 },
        ),
        style: str('风格标签（可选，如 cinematic / lofi / pop）'),
        stems: arr('分轨乐器（仅 audio_with_stems 使用；省略默认 guitar/bass/drums）', enm('乐器', STEM_ARMS)),
        instrumental: bool(
          '是否纯乐器（无人声），缺省 true。用户要求「要人声 / 带唱 / 主唱 / vocals」时必须显式传 false：' +
            '引擎的歌词条件由它决定（true 会明确禁止人声）。若要人声分轨，整曲必须 instrumental=false，否则人声轨只能拆出噪声。' +
            'ai_cover 固定为纯器乐（cover 的歌词条件恒为 [Instrumental]），不支持人声',
        ),
        vocalLanguage: str(
          '演唱语言（BCP-47，如 ja / en / zh）。仅 instrumental=false 时有效；用户说了语言就填（日语=ja），' +
            '省略时 Companion 按 caption 里的「Japanese/anime/J-ROCK」等线索推断，再不行给 en',
        ),
        startBeat: num(
          '音频落轨起点（拍，≥0）；省略时落在播放头。ai_cover 的参考音频是整工程，固定从第 0 拍落轨',
          { minimum: 0 },
        ),
        trackName: str('可选的轨道/片段名（中文即可）'),
        quality: bool(
          '精修 50 步（仅 text_to_audio / audio_with_stems）。midi_to_audio（采样器渲染）与 ai_cover（cover 固定 8 步快模式）不接受',
        ),
        engine: enm(
          '引擎量级（仅 AI 模式 text_to_audio / ai_cover / audio_with_stems）：2b=标准 2B（快，缺省）；xl=XL 4B（最高质量，仅 Windows 现代运行时且需 ≥12GB 显存；macOS/Linux 不可用）。midi_to_audio 不接受该参数',
          ENGINE_TIERS,
        ),
        priority: int('任务优先级：0 普通 / 1 高 / 2 紧急', { minimum: 0, maximum: 2 }),
        reason: str('用一句中文说明为什么选这个模式，会展示给用户'),
      },
      ['mode'],
    ),
    handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
      const mode = String(args.mode ?? '')
      // 旧 mode 的语义一直含糊（既像"先编曲再渲染"，又像"AI 成品"），已合并：
      // 要保留编曲让 AI 重做 → ai_cover；只要忠实导出 → midi_to_audio。
      if (mode === 'midi_then_audio') {
        return {
          ok: false,
          message:
            'midi_then_audio 已废弃：要「保留编曲、让 AI 做成成品」请用 mode:"ai_cover"（需要 caption）；只想忠实导出请用 mode:"midi_to_audio"。',
        }
      }
      if (!isAudioMode(mode)) {
        return {
          ok: false,
          message: `mode 必须是 ${MODES.join(' / ')} 之一；请先判断用户要的是「忠实渲染 / AI 成品 / 从零生成 / 分轨」`,
        }
      }
      const project = ctx.project
      const caption = typeof args.caption === 'string' ? args.caption.trim() : ''
      const needsCaption = mode === 'text_to_audio' || mode === 'audio_with_stems' || mode === 'ai_cover'
      if (needsCaption && !caption) {
        return {
          ok: false,
          message:
            mode === 'ai_cover'
              ? 'mode=ai_cover 需要 caption：用英文写清「希望重编成什么风格/编制」，例如 "epic orchestral rock with distorted guitars and live drums, 128 bpm"。用户没指定风格时，从工程现有配器与风格提炼，不要留空'
              : `mode=${mode} 需要 caption：请把用户的描述提炼成英文提示词（风格/乐器/情绪/BPM）。例如 "warm cinematic piano with soft strings, slow, emotional, 72 bpm"`,
        }
      }
      // 引擎量级（P9）：校验后只透传显式选择的值；缺省不写进计划（任务 params 不带 engine = 2b，保持旧默认）
      const engineRaw = typeof args.engine === 'string' ? args.engine.trim() : ''
      if (engineRaw && !(ENGINE_TIERS as readonly string[]).includes(engineRaw)) {
        return {
          ok: false,
          message: `engine 只能是 '2b'（${ENGINE_LABEL['2b']}）或 'xl'（${ENGINE_LABEL.xl}，最高质量）；不确定时省略该参数`,
        }
      }
      const engine = engineRaw === 'xl' ? ('xl' as const) : engineRaw === '2b' ? ('2b' as const) : undefined
      // 「渲染」和「创作」必须分开承诺：采样器渲染不跑模型，传引擎/精修参数一律拒绝，
      // 避免再次出现「说用了 XL 4B，实际是浏览器 SoundFont」的误导。
      if (mode === 'midi_to_audio' && (engine || args.quality === true)) {
        return {
          ok: false,
          message:
            'midi_to_audio 是「忠实渲染」：浏览器采样器逐音还原 MIDI，不启动 AI 引擎，engine / quality 不适用。' +
            '想要 AI 成品请改用 mode:"ai_cover"（可带 engine 与 coverStrength）；只想导出就删掉这两个参数。',
        }
      }
      // XL 4B 只有 Windows 现代运行时支持（macOS / Linux 官方运行时仅 2B）。
      // 平台不支持、且没有在线节点上报 xl_turbo 时，直接拒绝并说明原因——
      // 之前正是这条缺失，让 Agent 在 macOS 上反复声称「已用 XL 4B + 精修」。
      const workers = listWorkers()
      const reportedModels = new Set(workers.flatMap((worker) => worker.capabilities.models ?? []))
      const xlSupported = process.platform === 'win32' || reportedModels.has('xl_turbo')
      if (engine === 'xl' && !xlSupported) {
        return {
          ok: false,
          message:
            'XL 4B 只在 Windows 现代运行时可用（macOS / Linux 官方运行时仅支持标准 2B），当前平台与在线节点都不支持 XL。' +
            '请省略 engine（默认 2b）或显式传 engine:"2b"；如果用户坚持要 XL，如实说明这台机器跑不了，不要承诺。',
        }
      }
      if (mode === 'ai_cover' && args.quality === true) {
        return {
          ok: false,
          message:
            'ai_cover 走 cover 的 8 步快模式，不支持 quality 精修；要更高质量请传 engine:"xl"（XL 4B，仅 Windows 现代运行时）。',
        }
      }
      if (mode === 'ai_cover' && args.instrumental === false) {
        return {
          ok: false,
          message:
            'ai_cover 目前只做纯器乐重编（cover 的歌词条件固定为 [Instrumental]），不支持带人声；要人声请用 mode:"text_to_audio" + instrumental:false。',
        }
      }
      const renderMode = mode === 'midi_to_audio'
      const coverMode = mode === 'ai_cover'
      if (renderMode || coverMode) {
        const hasContent = project.tracks.some((track) => track.clips.length > 0 || track.audioClips.length > 0)
        if (!hasContent) {
          return {
            ok: false,
            message:
              '当前工程还是空的，无法渲染 / 重编。请先用 create_track / generate_smart_clip / arrange_from_melody 等工具完成编曲，' +
              `再调用 generate_audio(mode: "${mode}")。`,
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
      // AI 重编贴近度：0–1，越大越贴近原结构；缺省 0.7（生成面板同款默认）。
      const coverStrength = coverMode
        ? Number.isFinite(Number(args.coverStrength))
          ? clamp(Number(args.coverStrength), 0, 1)
          : 0.7
        : undefined
      const audioPlan = {
        mode,
        caption: caption || undefined,
        bpm,
        keyscale,
        timesignature,
        // 渲染 / 重编的时长由工程与源音频决定，不吃 durationSec；落点固定第 0 拍（参考音频是整工程）
        durationSec: renderMode || coverMode ? undefined : durationSec,
        style: typeof args.style === 'string' && args.style.trim() ? args.style.trim().slice(0, 80) : undefined,
        stems: stemsWithoutVocals.length ? stemsWithoutVocals : undefined,
        instrumental,
        // 演唱语言（可选）：只在要人声时有意义；规范化成小写 BCP-47，非法值丢弃由 Companion 兜底推断
        vocalLanguage: normalizeVocalLanguage(args.vocalLanguage),
        startBeat: renderMode || coverMode ? undefined : startBeat,
        trackName: typeof args.trackName === 'string' && args.trackName.trim() ? args.trackName.trim().slice(0, 60) : undefined,
        quality: args.quality === true || undefined,
        coverStrength,
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
      const needsCompanion = !renderMode
      const workerOnline = !needsCompanion || workers.length > 0
      const offlineHint = workerOnline
        ? ''
        : '注意：当前没有在线的生成节点（Companion），任务会先在界面中建好轨道并等待节点接入，启动后自动继续。' +
          '请如实告诉用户「任务已安排、正在等待生成节点」，不要声称已经生成完成。'
      // 引擎能力校验：Windows 节点上报了 models 但不含 xl_turbo 时，XL 任务必然失败。
      // 与其让用户等一次报错，不如在计划回执里就说清楚（模型会在回复里转述）。
      const xlMissing = engine === 'xl' && workers.length > 0 && reportedModels.size > 0 && !reportedModels.has('xl_turbo')
      const capabilityHint = xlMissing
        ? '注意：当前在线节点没有上报 xl_turbo（XL 模型档未安装/未加载），XL 任务很可能失败；' +
          '请如实告诉用户，并建议先用标准 2B（省略 engine）或先安装 XL 档。'
        : ''
      let summary: string
      if (renderMode) {
        summary =
          `已安排忠实渲染：当前 MIDI 工程 → 音频（BPM ${bpm}${keyscaleText}；浏览器采样器逐音渲染，不启动 AI 模型，结果与 MIDI 一一对应；不适用引擎/精修参数）。` +
          '完成后自动加入音频轨。请如实告诉用户这是「忠实导出」，不要说用了 AI 引擎或精修模型。'
      } else if (coverMode) {
        summary =
          `已安排 AI 重编（cover）：先渲染当前工程作为参考，再由 AI 引擎保结构换编制（BPM ${bpm}${keyscaleText}` +
          `，贴近度 ${coverStrength?.toFixed(2)}${engineText}）。会改细节、不保证逐音对齐；原 MIDI 不变，完成后新增一条音频轨。` +
          '请告诉用户这是「AI 再创作」，不是逐音渲染。'
      } else {
        summary =
          `已安排音频任务：${MODE_LABEL[mode]}（BPM ${bpm}${keyscaleText}，约 ${durationSec}s${vocalText}${stemText}${engineText}）。` +
          skippedText
      }
      return {
        ok: true,
        message: `${summary}生成在界面中异步执行，完成后自动加入音频轨；你不需要轮询，用一两句话告诉用户选择了哪种模式即可。${offlineHint}${capabilityHint}`,
        data: { audioPlan, workerOnline },
      }
    },
  },
]
