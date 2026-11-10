/**
 * Studio 形态的「创作入口」：用途场景预设 + 和弦进行灵感。
 *
 * 这两块解决 a–g 里的：
 *  - (d) 按用途生成：把"用途/场景"变成一等参数（战斗/BOSS/城镇/OP/副歌…），
 *        而不只是让用户自己从风格名里猜；
 *  - (b) 带节奏型的和声进行找灵感：给出可解释的进行方案（罗马数字 + 描述 + 节奏提示），
 *        而不是只把风格默认进行塞给用户。
 */
import { composeProject } from './arrange.js'
import { STYLES, type ScaleId, type StyleId } from './constants.js'
import type { ChordSpec } from './model.js'
import { parseRoman, progressionToChords } from './theory.js'

/* ------------------------------------------------------------------ */
/* 用途 / 场景预设                                                     */
/* ------------------------------------------------------------------ */

export interface ScenePreset {
  id: string
  name: string
  nameEn: string
  description: string
  styleId: StyleId
  tempo: number
  key: string
  scale: ScaleId
  bars: number
  /** 0-1，喂给生成器的能量参数 */
  energy: number
  /** 覆盖段落名（不填则用风格默认段落名） */
  sectionNames?: string[]
}

export const SCENES: ScenePreset[] = [
  {
    id: 'battle',
    name: '战斗',
    nameEn: 'Battle',
    description: '推进感强的战斗循环，管弦 + 失真吉他，适合作为关卡战斗 BGM',
    styleId: 'jrpg',
    tempo: 168,
    key: 'D',
    scale: 'minor',
    bars: 16,
    energy: 0.88,
    sectionNames: ['前奏', '主题', '高潮', '循环尾'],
  },
  {
    id: 'boss',
    name: 'BOSS 战',
    nameEn: 'Boss Battle',
    description: '高压、戏剧化的最终战，铜管与定音鼓重音，预留高潮段',
    styleId: 'jrpg',
    tempo: 180,
    key: 'C',
    scale: 'minor',
    bars: 16,
    energy: 0.96,
    sectionNames: ['前奏', '主题', '高潮', '循环尾'],
  },
  {
    id: 'dungeon',
    name: '地牢探索',
    nameEn: 'Dungeon',
    description: '稀疏、悬疑的探索氛围，低频弦乐与弱打击，留白多',
    styleId: 'jrpg',
    tempo: 84,
    key: 'A',
    scale: 'minor',
    bars: 16,
    energy: 0.32,
    sectionNames: ['环境', '推进', '悬念', '循环尾'],
  },
  {
    id: 'town',
    name: '城镇',
    nameEn: 'Town',
    description: '温暖怀旧的城镇主题，木吉他/长笛/钢片琴，适合作为休息点',
    styleId: 'jrpg',
    tempo: 96,
    key: 'G',
    scale: 'major',
    bars: 16,
    energy: 0.34,
    sectionNames: ['前奏', '主题', '展开', '循环尾'],
  },
  {
    id: 'field',
    name: '世界地图',
    nameEn: 'World Map',
    description: '辽阔的冒险感，弦乐铺底 + 法国号主题，适合大地图移动',
    styleId: 'jrpg',
    tempo: 128,
    key: 'C',
    scale: 'major',
    bars: 16,
    energy: 0.62,
    sectionNames: ['前奏', '主题', '展开', '循环尾'],
  },
  {
    id: 'sorrow',
    name: '剧情 · 悲伤',
    nameEn: 'Sorrow',
    description: '钢琴动机 + 弦乐对位，克制的悲伤场景，密度低',
    styleId: 'jrpg',
    tempo: 68,
    key: 'A',
    scale: 'minor',
    bars: 16,
    energy: 0.22,
    sectionNames: ['前奏', '主题', '发展', '收束'],
  },
  {
    id: 'ending',
    name: '片尾 / 结局',
    nameEn: 'Ending',
    description: '长度更长的收束曲，情绪从平静推到开阔再回落',
    styleId: 'jrpg',
    tempo: 108,
    key: 'F',
    scale: 'major',
    bars: 24,
    energy: 0.7,
    sectionNames: ['前奏', '主题', '高潮', '尾声'],
  },
  {
    id: 'jrock_op',
    name: '日摇 OP',
    nameEn: 'J-Rock OP',
    description: '动画/游戏主题曲式，双吉他 riff 开场，副歌抬高一个层次',
    styleId: 'jrock',
    tempo: 176,
    key: 'E',
    scale: 'minor',
    bars: 16,
    energy: 0.88,
    sectionNames: ['前奏', 'A 段', '副歌', '尾奏'],
  },
  {
    id: 'jrock_chorus',
    name: '日摇副歌',
    nameEn: 'J-Rock Chorus',
    description: '短促高能的副歌段落，适合单独循环或作为高潮素材',
    styleId: 'jrock',
    tempo: 172,
    key: 'A',
    scale: 'minor',
    bars: 8,
    energy: 0.92,
    sectionNames: ['前奏', '副歌', '副歌变奏', '尾奏'],
  },
  {
    id: 'jrock_ballad',
    name: '日摇抒情',
    nameEn: 'J-Rock Ballad',
    description: '干净的吉他与钢琴前奏，副歌才上失真，适合叙事段落',
    styleId: 'jrock',
    tempo: 74,
    key: 'D',
    scale: 'major',
    bars: 16,
    energy: 0.3,
    sectionNames: ['前奏', 'A 段', '副歌', '尾奏'],
  },
  {
    id: 'bgm_loop',
    name: '通用循环 BGM',
    nameEn: 'BGM Loop',
    description: '不抢戏的中性背景音乐，适合菜单/等待/对话底噪',
    styleId: 'cinematic',
    tempo: 110,
    key: 'D',
    scale: 'minor',
    bars: 16,
    energy: 0.42,
  },
]

export function getScene(id: string): ScenePreset | undefined {
  return SCENES.find((scene) => scene.id === id)
}

/** 把场景名字写进段落（长度不匹配时按比例分配，宁可不覆盖也不报错） */
function applySceneSectionNames(project: ReturnType<typeof composeProject>, names: string[]): void {
  if (!names.length) return
  project.sections = project.sections.map((section, index) => ({
    ...section,
    name: names[Math.floor((index * names.length) / project.sections.length)] ?? section.name,
  }))
}

/* ------------------------------------------------------------------ */
/* 和弦进行灵感                                                        */
/* ------------------------------------------------------------------ */

export interface ProgressionIdea {
  id: string
  roman: string[]
  /** 已按调性/音阶解析好的和弦，可直接写进 Project.chords */
  chords: ChordSpec[]
  label: string
  description: string
  /** 节奏/织体提示：告诉用户"这条进行配什么型" */
  patternHint: string
}

interface IdeaSeed {
  id: string
  roman: string[]
  label: string
  description: string
  patternHint: string
}

/** 通用小调向进行（Jrpg / J-Rock / Rock 都能用） */
const MINOR_IDEAS: IdeaSeed[] = [
  {
    id: 'minor-anthem',
    roman: ['i', 'VI', 'III', 'VII'],
    label: '小调王道',
    description: '日系最常用的四和弦循环，副歌向 VI/III 借力，明快但有推力',
    patternHint: '八分音符柱式 + 反拍切分，吉他扫弦/弦乐断奏',
  },
  {
    id: 'minor-journey',
    roman: ['i', 'iv', 'VII', 'III'],
    label: '暗色旅程',
    description: '自然小调 iv 带来下行叹息感，适合探索/叙事段落',
    patternHint: '低音八分音符推动，上层长音铺底',
  },
  {
    id: 'minor-descent',
    roman: ['i', 'VII', 'VI', 'VII'],
    label: '下行级进',
    description: '音阶下行制造"逐步沉入"的听感，常用于战斗前奏',
    patternHint: '半音推进的贝斯 + 铜管长音渐强',
  },
  {
    id: 'minor-cadence',
    roman: ['i', 'VI', 'iv', 'V'],
    label: '半终止',
    description: '结尾停在 V，天然制造"还没结束"的悬念，适合循环 BGM',
    patternHint: 'V 前一小节加密节奏，鼓组加花',
  },
  {
    id: 'minor-borrow',
    roman: ['i', 'III', 'VI', 'V'],
    label: '明亮小调',
    description: '借 III 大三级让色彩更明亮，适合城镇/轻松场景',
    patternHint: '钢琴分解和弦，鼓组退半步',
  },
]

/** 大调向进行（Pop / Folk / J-Rock 副歌） */
const MAJOR_IDEAS: IdeaSeed[] = [
  {
    id: 'major-canon',
    roman: ['I', 'V', 'vi', 'IV'],
    label: '卡农循环',
    description: '全球通用的"不会错"进行，适合主歌与副歌互借',
    patternHint: '八分音符柱式，副歌加反拍',
  },
  {
    id: 'major-royal',
    roman: ['IV', 'V', 'iii', 'vi'],
    label: '王道进行',
    description: 'J-Pop/J-Rock 的招牌进行，副歌冲向 IV 再回落，情绪饱满',
    patternHint: '八分扫弦 + 踏板音，鼓组 16 分踩镲',
  },
  {
    id: 'major-loop',
    roman: ['vi', 'IV', 'I', 'V'],
    label: '循环叙事',
    description: '从小调起手再回大调，铺陈感强，适合抒情段落',
    patternHint: '钢琴琶音 + 弦乐长音',
  },
  {
    id: 'major-plain',
    roman: ['I', 'IV', 'V', 'I'],
    label: '直接明亮',
    description: '最直白的大调进行，适合片尾/胜利/标题画面',
    patternHint: '全音符柱式 + 定音鼓重音',
  },
]

/**
 * 按音阶选池子：小调只给小调向进行，大调只给大调向进行。
 * 混着给会出现"小调调性里塞 IV-V-iii-vi"这种被 romanToChord 的大小写规则弄歪的结果。
 */
function ideasForScale(scale: ScaleId): IdeaSeed[] {
  return scale === 'major' ? [...MAJOR_IDEAS] : [...MINOR_IDEAS]
}

/** 确定性洗牌：同 seed 出同一组建议 */
function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = [...items]
  let state = Math.abs(Math.floor(seed)) % 2147483647 || 1
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 48271) % 2147483647
    const j = state % (i + 1)
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

/**
 * 给出 count 条可用进行。每条都已在目标调性上解析好和弦，
 * 前端点击即可直接写入 Project.chords（可撤销）。
 */
export function suggestProgressions(opts: {
  style: StyleId
  key?: string
  scale?: ScaleId
  count?: number
  seed?: number
  beatsPerChord?: number
}): ProgressionIdea[] {
  const style = opts.style
  const meta = STYLES[style]
  const key = opts.key ?? 'C'
  const scale = opts.scale ?? meta.defaultScale
  const beats = opts.beatsPerChord ?? 4
  const count = Math.max(1, Math.min(8, Math.round(opts.count ?? 4)))
  const pool = seededShuffle(ideasForScale(scale), opts.seed ?? 1)

  return pool.slice(0, count).map((idea) => ({
    id: idea.id,
    roman: idea.roman,
    chords: progressionToChords(idea.roman, key, scale, beats),
    label: idea.label,
    description: idea.description,
    patternHint: idea.patternHint,
  }))
}

/* ------------------------------------------------------------------ */
/* 和弦进行补全（P7-C）                                                */
/* ------------------------------------------------------------------ */

export interface CompletedProgression {
  id: string
  key: string
  scale: ScaleId
  style: StyleId
  /** 用户给的部分进行（规范化后的罗马数字） */
  partial: string[]
  /** AI 补全的部分 */
  completion: string[]
  /** partial + completion */
  full: string[]
  /** 已按调性解析、可直接写入工程的整段和弦 */
  chords: ChordSpec[]
  beatsPerChord: number
  /** 终止式说明（正格/变格/阻碍/半终止/开放） */
  cadence: string
  /** 可解释的原因（给 UI 展示） */
  reasons: string[]
  targetLength: number
}

type HarmonicFunction = 'tonic' | 'predominant' | 'dominant' | 'submediant' | 'mediant' | 'leading'

function harmonicFunctionOf(roman: string): HarmonicFunction | null {
  const parsed = parseRoman(roman)
  if (!parsed) return null
  // parseRoman.degree 是 0 基索引：0=I, 1=II, 2=III, 3=IV, 4=V, 5=VI, 6=VII
  switch (parsed.degree) {
    case 0:
      return 'tonic'
    case 1:
    case 3:
      return 'predominant'
    case 4:
      return 'dominant'
    case 5:
      return 'submediant'
    case 2:
      return 'mediant'
    case 6:
      return 'leading'
    default:
      return null
  }
}

/** 大调补全候选（按"最后和弦的功能"给后续） */
const MAJOR_CONTINUATIONS: Record<HarmonicFunction, string[][]> = {
  tonic: [['IV', 'V', 'I'], ['vi', 'IV', 'V', 'I'], ['IV', 'I', 'V', 'I'], ['V', 'vi', 'IV', 'V']],
  predominant: [['V', 'I'], ['V', 'vi', 'IV', 'V', 'I'], ['ii', 'V', 'I']],
  dominant: [['I'], ['I', 'IV', 'V', 'I'], ['I', 'vi', 'IV', 'V']],
  submediant: [['IV', 'V', 'I'], ['ii', 'V', 'I'], ['IV', 'I', 'V']],
  mediant: [['vi', 'IV', 'V', 'I'], ['IV', 'V', 'I']],
  leading: [['I'], ['I', 'V', 'I']],
}

/** 小调补全候选（自然/和声小调混用，romanToChord 会按大小写解析） */
const MINOR_CONTINUATIONS: Record<HarmonicFunction, string[][]> = {
  tonic: [['VI', 'III', 'VII'], ['iv', 'V', 'i'], ['VI', 'iv', 'V', 'i'], ['III', 'VII', 'i']],
  predominant: [['V', 'i'], ['V', 'VI', 'III', 'VII', 'i'], ['iv', 'V', 'i']],
  dominant: [['i'], ['i', 'VI', 'III', 'VII'], ['i', 'iv', 'V']],
  submediant: [['III', 'VII'], ['iv', 'V', 'i'], ['VII', 'III']],
  mediant: [['VII', 'i'], ['VI', 'iv', 'V', 'i']],
  leading: [['i'], ['III', 'VI', 'VII', 'i']],
}

/** 延长到目标长度时用的循环模板 */
const MAJOR_LOOP = ['I', 'V', 'vi', 'IV']
const MINOR_LOOP = ['i', 'VI', 'III', 'VII']

/** 风格 → 终止/推进偏好（返回候选排序权重，数值越小越优先） */
function styleRank(style: StyleId, candidate: string[], _scale: ScaleId): number {
  const degrees = candidate.map((roman) => parseRoman(roman)?.degree ?? 0)
  const lastDegree = degrees[degrees.length - 1] ?? 0
  const endsTonic = lastDegree === 0
  const hasDominant = degrees.includes(4)
  switch (style) {
    case 'classical':
      return (hasDominant ? 0 : 2) + (candidate.length <= 2 ? 0 : 1)
    case 'jazz':
      return (degrees.includes(1) ? 0 : 1) + (hasDominant ? 0 : 1)
    case 'jrock':
    case 'jrpg':
    case 'rock':
    case 'electronic':
    case 'cinematic':
      return (endsTonic ? 0 : 2) + (candidate.length >= 3 ? 0 : 1)
    default:
      return endsTonic ? 0 : 1
  }
}

/** 简单确定性哈希（同输入同结果） */
function hashString(input: string): number {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash)
}

/** 按需把罗马数字改成七和弦（jazz 味） */
function seventhize(roman: string, scale: ScaleId): string {
  const parsed = parseRoman(roman)
  if (!parsed) return roman
  if (parsed.seventh) return roman
  const lower = roman === roman.toLowerCase()
  if (parsed.degree === 4) return `${roman}7`
  if (parsed.degree === 0) return scale === 'major' ? `${roman.toUpperCase()}maj7` : `${roman}maj7`
  if (parsed.degree === 3) return scale === 'major' ? `${roman.toUpperCase()}maj7` : `${roman}maj7`
  if (lower) return `${roman}7`
  return `${roman}7`
}

/** 终止式判定（看最后两个和弦的功能） */
function cadenceOfLast(full: string[]): string {
  if (full.length < 2) return '未构成终止'
  const prev = harmonicFunctionOf(full[full.length - 2]!)
  const last = harmonicFunctionOf(full[full.length - 1]!)
  if (prev === 'dominant' && last === 'tonic') return '正格终止（V → I/i）'
  if (prev === 'predominant' && last === 'tonic') return '变格终止（IV → I/i）'
  if (last === 'dominant') return '半终止（停在 V，留悬念）'
  if (prev === 'dominant' && last === 'submediant') return '阻碍终止（V → vi/VI）'
  return '开放式（继续推进）'
}

/**
 * 补全不完整和弦进行。
 * - 用户给 roman 片段（如 ['I','V','vi']），AI 按"最后和弦的功能"接续；
 * - 按风格偏好排序候选（古典偏 V-I、爵士偏 ii-V-I、J-Rock/JRPG 偏 IV-V-I 拱形）；
 * - 目标长度不足时用循环模板延长，并尽量落回主和弦；
 * - 输出和弦已按调性解析，可直接 setChords。
 */
export function completeProgression(opts: {
  key: string
  scale: ScaleId
  partial: string[]
  style?: StyleId
  targetLength?: number
  beatsPerChord?: number
}): CompletedProgression {
  const style = opts.style ?? 'pop'
  const key = opts.key || 'C'
  const scale = opts.scale
  const beats = opts.beatsPerChord ?? 4
  const targetLength = Math.max(2, Math.min(32, Math.round(opts.targetLength ?? 8)))

  const rawPartial = (opts.partial ?? [])
    .map((token) => String(token).trim())
    .filter(Boolean)
  if (rawPartial.length === 0) throw new Error('请先给至少一个和弦（罗马数字，例如 I V vi IV）')
  const partial: string[] = []
  for (const token of rawPartial) {
    const parsed = parseRoman(token)
    if (!parsed) throw new Error(`无法识别的和弦「${token}」（请用罗马数字，如 I / IV / V / vi / bVII）`)
    if (parsed.degree < 0 || parsed.degree > 6) throw new Error(`和弦「${token}」的级数超出范围`)
    partial.push(token)
  }

  if (partial.length >= targetLength) {
    return {
      id: `complete-${key}-${scale}-${hashString(partial.join(' ')).toString(36)}`,
      key,
      scale,
      style,
      partial,
      completion: [],
      full: partial,
      chords: progressionToChords(partial, key, scale, beats),
      beatsPerChord: beats,
      cadence: cadenceOfLast(partial),
      reasons: [`你给的部分已经达到目标长度 ${targetLength}，无需补全`],
      targetLength,
    }
  }

  const lastFn = harmonicFunctionOf(partial[partial.length - 1]!)
  const table = scale === 'major' ? MAJOR_CONTINUATIONS : MINOR_CONTINUATIONS
  const candidates = [...(lastFn ? table[lastFn] : MAJOR_CONTINUATIONS.tonic)]

  // jazz：优先 ii-V-I；并统一加七和弦
  const ranked = candidates
    .map((candidate) => ({ candidate, rank: styleRank(style, candidate, scale) }))
    .sort((a, b) => a.rank - b.rank)
  const remaining = targetLength - partial.length
  const fitting = ranked.filter((item) => item.candidate.length <= remaining)
  const pool = fitting.length > 0 ? fitting : ranked
  const picked = pool[hashString(`${style}|${key}|${scale}|${partial.join(' ')}`) % pool.length]!
  let completion = [...picked.candidate]
  if (style === 'jazz') completion = completion.map((roman) => seventhize(roman, scale))

  // 长度不足：用循环模板延长，并让最后一个和弦落回主和弦
  const tonicRoman = scale === 'major' ? 'I' : 'i'
  const loop = scale === 'major' ? MAJOR_LOOP : MINOR_LOOP
  let guard = 0
  while (partial.length + completion.length < targetLength && guard < 16) {
    const need = targetLength - partial.length - completion.length
    const slice = loop.slice(0, Math.min(loop.length, need))
    completion.push(...(style === 'jazz' ? slice.map((roman) => seventhize(roman, scale)) : slice))
    guard += 1
  }
  completion = completion.slice(0, Math.max(0, targetLength - partial.length))
  if (completion.length > 0) {
    const last = completion[completion.length - 1]!
    const fn = harmonicFunctionOf(last)
    if (fn !== 'tonic' && completion.length >= 2) completion[completion.length - 1] = tonicRoman
    else if (fn !== 'tonic' && completion.length === 1) completion[0] = tonicRoman
  }

  // 去掉补全末尾的相邻重复（常见于循环模板接在 i/VI 后面）；并保证收束在 V–I 正格终止
  const deduped: string[] = []
  for (const roman of completion) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== roman) deduped.push(roman)
  }
  while (deduped.length > 0 && partial.length + deduped.length < targetLength) {
    deduped.splice(Math.max(0, deduped.length - 1), 0, tonicRoman)
  }
  completion = deduped.slice(0, Math.max(0, targetLength - partial.length))
  if (completion.length >= 2) {
    const dominantRoman = 'V'
    const lastFn = harmonicFunctionOf(completion[completion.length - 1]!)
    const penultimateFn = harmonicFunctionOf(completion[completion.length - 2]!)
    if (lastFn === 'tonic' && penultimateFn !== 'dominant') {
      completion[completion.length - 2] = dominantRoman
    }
  }

  const full = [...partial, ...completion]
  const reasons: string[] = []
  if (lastFn) {
    const fnLabel: Record<HarmonicFunction, string> = {
      tonic: '主功能（稳定）',
      predominant: '下属功能（准备）',
      dominant: '属功能（张力）',
      submediant: '下中音（色彩/转折）',
      mediant: '中音（色彩）',
      leading: '导音（强烈倾向）',
    }
    reasons.push(`你给的最后和弦是 ${partial[partial.length - 1]}（${fnLabel[lastFn]}），所以从这里接续`)
  }
  const styleHint: Partial<Record<StyleId, string>> = {
    classical: '古典倾向：用 V–I 正格终止收束',
    jazz: '爵士倾向：用 ii–V–I 并加七和弦',
    jrock: 'J-Rock 倾向：用 IV–V–I 拱形把副歌推上去',
    jrpg: 'JRPG 倾向：用 IV–V–I 或 VI–III–VII 保持叙事感',
    rock: '摇滚倾向：强属功能到主和弦，收得干脆',
    electronic: '电子倾向：四和弦循环 + 落回主和弦',
    cinematic: '影视倾向：先铺后收，落回主和弦',
  }
  if (styleHint[style]) reasons.push(styleHint[style]!)
  reasons.push(`目标长度 ${targetLength}：已补 ${completion.length} 个和弦，终止式 = ${cadenceOfLast(full)}`)

  return {
    id: `complete-${key}-${scale}-${hashString(full.join(' ')).toString(36)}`,
    key,
    scale,
    style,
    partial,
    completion,
    full,
    chords: progressionToChords(full, key, scale, beats),
    beatsPerChord: beats,
    cadence: cadenceOfLast(full),
    reasons,
    targetLength,
  }
}

/* ------------------------------------------------------------------ */
/* 按场景新建工程                                                      */
/* ------------------------------------------------------------------ */

export function composeSceneProject(opts: {
  style: StyleId
  sceneId?: string
  bars?: number
  seed?: number
  name?: string
}): { project: ReturnType<typeof composeProject>; scene?: ScenePreset } {
  const scene = opts.sceneId ? getScene(opts.sceneId) : undefined
  const style = scene?.styleId ?? opts.style
  const project = composeProject({
    style,
    key: scene?.key,
    scale: scene?.scale,
    tempo: scene?.tempo,
    bars: Math.max(4, Math.round(opts.bars ?? scene?.bars ?? 16)),
    energy: scene?.energy,
    seed: opts.seed ?? Math.floor(Math.random() * 100000),
    name: opts.name,
  })
  if (scene?.sectionNames) applySceneSectionNames(project, scene.sectionNames)
  // 把"创作意图"落盘，供轨道头/工程信息展示与二次生成使用
  project.style = style
  if (scene) project.scene = scene.id
  return { project, scene }
}
