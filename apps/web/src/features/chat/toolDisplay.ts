import {
  Activity,
  ArrowUpDown,
  AudioWaveform,
  Brain,
  Clock,
  Copy,
  Drum,
  Eraser,
  Globe,
  Grid3x3,
  Guitar,
  Layers,
  ListMusic,
  Merge,
  MousePointerClick,
  Music2,
  Music4,
  Repeat,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  SquarePen,
  Trash2,
  Wand2,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

export type ToolCategory = 'project' | 'generate' | 'info' | 'web' | 'theory'

export interface ToolMeta {
  /** 中文展示名 */
  title: string
  icon: LucideIcon
  /** 图标色调 class */
  tone: string
}

const TOOL_META: Record<string, ToolMeta> = {
  get_project_summary: { title: '读取工程概览', icon: ListMusic, tone: 'text-cyan' },
  analyze_harmony: { title: '分析和声', icon: Activity, tone: 'text-violet' },
  create_track: { title: '创建轨道', icon: ListMusic, tone: 'text-accent' },
  update_track: { title: '更新轨道', icon: SquarePen, tone: 'text-accent' },
  delete_track: { title: '删除轨道', icon: Trash2, tone: 'text-danger' },
  set_instrument: { title: '更换乐器', icon: Music4, tone: 'text-accent' },
  create_clip: { title: '创建片段', icon: Guitar, tone: 'text-accent' },
  update_clip: { title: '更新片段', icon: SquarePen, tone: 'text-accent' },
  delete_clip: { title: '删除片段', icon: Trash2, tone: 'text-danger' },
  write_notes: { title: '写入音符', icon: Music4, tone: 'text-accent' },
  generate_smart_clip: { title: '生成智能片段', icon: Sparkles, tone: 'text-violet' },
  arrange_from_melody: { title: '旋律 → 自动编曲', icon: Sparkles, tone: 'text-violet' },
  melody_from_chords: { title: '和弦 → 填旋律', icon: Sparkles, tone: 'text-violet' },
  generate_audio: { title: '生成音频', icon: AudioWaveform, tone: 'text-accent' },
  set_tempo: { title: '设置速度', icon: SlidersHorizontal, tone: 'text-cyan' },
  set_key_scale: { title: '设置调式', icon: SlidersHorizontal, tone: 'text-cyan' },
  set_chords: { title: '设置和弦进行', icon: SlidersHorizontal, tone: 'text-cyan' },
  set_sections: { title: '设置段落结构', icon: ListMusic, tone: 'text-cyan' },
  set_master_volume: { title: '设置主音量', icon: SlidersHorizontal, tone: 'text-cyan' },
  music_theory: { title: '查询乐理', icon: Brain, tone: 'text-violet' },
  web_search: { title: '联网搜索', icon: Globe, tone: 'text-cyan' },
  fetch_url: { title: '抓取网页', icon: Globe, tone: 'text-cyan' },
  add_drum_groove: { title: '添加鼓组律动', icon: Drum, tone: 'text-accent' },

  /* ---- 编曲编辑（复用现有素材，而不是重新生成） ---- */
  copy_clip: { title: '复制片段', icon: Copy, tone: 'text-accent' },
  repeat_section: { title: '重复段落', icon: Repeat, tone: 'text-accent' },
  split_clip: { title: '拆分片段', icon: Scissors, tone: 'text-accent' },
  merge_clips: { title: '合并片段', icon: Merge, tone: 'text-accent' },
  transpose_clip: { title: '移调', icon: ArrowUpDown, tone: 'text-accent' },
  quantize_clip: { title: '量化', icon: Grid3x3, tone: 'text-accent' },
  humanize_clip: { title: '人性化', icon: Wand2, tone: 'text-violet' },
  scale_lock_clip: { title: '音阶锁定', icon: Music2, tone: 'text-accent' },
  velocity_curve: { title: '力度曲线', icon: AudioWaveform, tone: 'text-violet' },
  duplicate_track: { title: '复制轨道', icon: Layers, tone: 'text-accent' },
  clear_track: { title: '清空轨道', icon: Eraser, tone: 'text-danger' },

  /* ---- 工程级 ---- */
  set_swing: { title: '设置摇摆', icon: AudioWaveform, tone: 'text-cyan' },
  set_time_signature: { title: '拍号', icon: Clock, tone: 'text-cyan' },
  set_loop: { title: '循环区间', icon: Repeat, tone: 'text-cyan' },
  transpose_project: { title: '整体移调', icon: ArrowUpDown, tone: 'text-cyan' },

  /* ---- 界面 ---- */
  ui_action: { title: '界面操作', icon: MousePointerClick, tone: 'text-violet' },
}

const FALLBACK_META: ToolMeta = { title: '执行工具', icon: Wrench, tone: 'text-ink-2' }

export function toolMeta(name: string): ToolMeta {
  return TOOL_META[name] ?? { ...FALLBACK_META, title: humanizeToolName(name) }
}

/** 未知工具名做一次简单的可读化处理，避免直接暴露 snake_case */
function humanizeToolName(name: string): string {
  if (!name) return FALLBACK_META.title
  return name.replace(/[_-]+/g, ' ').trim()
}

const ARG_LABELS: Record<string, string> = {
  name: '名称',
  trackName: '轨道',
  trackId: '轨道',
  clipName: '片段',
  clipId: '片段',
  sectionName: '段落',
  instrumentId: '乐器',
  emotionId: '情绪',
  style: '风格',
  kind: '类型',
  tempo: 'BPM',
  key: '调',
  scale: '音阶',
  root: '根音',
  quality: '和弦',
  progression: '进行',
  bars: '小节',
  startBeat: '起点',
  lengthBeats: '长度',
  volume: '音量',
  pan: '声像',
  count: '数量',
  amount: '数量',
  query: '检索词',
  url: '链接',
  notes: '音符',
  seed: '种子',
  intent: '意图',
  range: '音域',
  beats: '拍数',
  beat: '拍',
  view: '视图',
  semitones: '半音',
  grid: '网格',
  swing: '摇摆',
  strength: '强度',
  fromBar: '起始小节',
  toBar: '目标小节',
  clipIds: '片段',
  timing: '时值抖动',
  velocity: '力度',
  mode: '方式',
  caption: '描述',
  stems: '分轨',
  durationSec: '时长',
  reason: '理由',
}

/** 从参数里提取一眼能看懂的摘要 */
export function summarizeArgs(args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== 'object') return '无参数'
  const parts: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined || value === '') continue
    const label = ARG_LABELS[key]
    if (!label) continue
    let text: string
    if (Array.isArray(value)) {
      if (key === 'notes') {
        text = `${value.length} 个音符`
      } else if (value.every((item) => typeof item === 'string' || typeof item === 'number')) {
        text = value.slice(0, 6).map(String).join('、') + (value.length > 6 ? '…' : '')
      } else {
        text = `${value.length} 项`
      }
    } else if (typeof value === 'object') {
      text = JSON.stringify(value).slice(0, 40)
    } else if (typeof value === 'boolean') {
      text = value ? '是' : '否'
    } else {
      text = String(value)
    }
    if (text.length > 42) text = `${text.slice(0, 42)}…`
    parts.push(`${label} ${text}`)
    if (parts.length >= 3) break
  }
  return parts.length ? parts.join(' · ') : '无参数'
}

/** 工具返回值的单行说明 */
export function summarizeToolResult(result: unknown): string {
  if (result === null || result === undefined) return ''
  let value = result
  if (typeof result === 'string') {
    const raw = result.trim()
    if (!raw) return ''
    try {
      value = JSON.parse(raw)
    } catch {
      return trimText(raw, 480)
    }
  }
  if (typeof value === 'string') return trimText(value, 480)
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const message = typeof obj.message === 'string' ? obj.message : ''
    if (message) return trimText(message, 480)
    const keys = Object.keys(obj)
    if (keys.length === 0) return '完成'
    return `返回 ${keys.length} 个字段：${keys.slice(0, 6).join('、')}${keys.length > 6 ? '…' : ''}`
  }
  return String(value)
}

/** 完整结果的展示文本（JSON 美化，限制长度） */
export function prettyToolResult(result: unknown): string {
  if (result === null || result === undefined) return ''
  if (typeof result === 'string') {
    const raw = result.trim()
    if (!raw) return ''
    try {
      return trimText(JSON.stringify(JSON.parse(raw), null, 2), 6000)
    } catch {
      return trimText(raw, 6000)
    }
  }
  try {
    return trimText(JSON.stringify(result, null, 2), 6000)
  } catch {
    return String(result)
  }
}

function trimText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
