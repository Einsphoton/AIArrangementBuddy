/**
 * 命令注册表：命令面板（⌘K）、帮助页、工具栏、快捷键提示共用同一份定义。
 *
 * 为什么要有这一层？
 * - 成熟 DAW（Live / Logic / Bitwig / Studio One）都提供可搜索的命令入口，
 *   用户不需要先记住快捷键，就能发现「这个应用能做什么」；
 * - 快捷键说明、菜单文案、按钮行为只有一份来源，避免「帮助里写了但按不出来」。
 *
 * 约定：
 * - 命令本身只调用 store / uiStore / audio 的公开 API；
 * - 与当前视图强相关的编辑动作（删除、拆分、量化、缩放）通过 editorBus 广播，
 *   由当前视图自己实现，保证与鼠标操作共用同一套逻辑。
 */
import {
  ArrowDownWideNarrow,
  Bot,
  Boxes,
  Copy,
  Download,
  Gauge,
  Keyboard,
  ListMusic,
  Maximize2,
  Mic2,
  SlidersHorizontal,
  Music4,
  Pause,
  Piano,
  Play,
  Plus,
  Radio,
  Redo2,
  Repeat,
  Save,
  Scissors,
  Search,
  Settings2,
  Sparkles,
  Square,
  Timer,
  Trash2,
  Undo2,
  Volume2,
  Wand2,
  Zap,
  ZoomIn,
  ZoomOut,
  PanelRightClose,
  PanelLeft,
  FilePlus2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { getAudioEngine } from '../audio'
import { useStore } from '../store/store'
import { useUiStore } from './uiStore'
import { dispatchEditorCommand } from './editorBus'

export type CommandGroup = '走带' | '编辑' | '视图' | '轨道' | '工程' | 'AI' | '帮助'

export interface CommandDef {
  id: string
  title: string
  /** 面板里标题下面的一行说明 */
  subtitle?: string
  group: CommandGroup
  icon?: LucideIcon
  /** 组合键规格（见 lib/shortcuts.ts），可给多个等价键位 */
  keys?: string | string[]
  /** 额外搜索关键词（拼音/英文/别名） */
  keywords?: string
  run: () => void | Promise<void>
  enabled?: () => boolean
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function togglePlay(): void {
  const store = useStore.getState()
  if (store.isPlaying) {
    getAudioEngine().pause()
    store.setPlaying(false)
    return
  }
  void getAudioEngine()
    .play(store.project, {
      fromBeat: store.playhead,
      loop: store.loopEnabled ? store.project.loop : null,
      countIn: store.countIn,
    })
    .then(() => store.setPlaying(true))
    .catch(() => store.pushToast('error', '播放失败：音频引擎尚未就绪，请再点一次'))
}

function stopTransport(): void {
  try {
    getAudioEngine().stop()
  } catch {
    /* 引擎未就绪 */
  }
  useStore.getState().stopTransport()
}

function selectedTrack() {
  const store = useStore.getState()
  return store.project.tracks.find((track) => track.id === store.selectedTrackId) ?? null
}

function toggleChat(): void {
  const store = useStore.getState()
  store.setChatOpen(!store.chatOpen)
  if (!store.chatOpen) useUiStore.getState().setChatCollapsed(false)
}

function askAi(prompt: string): void {
  const store = useStore.getState()
  store.setChatOpen(true)
  useUiStore.getState().setChatCollapsed(false)
  store.setPendingPrompt(prompt)
}

/* ------------------------------------------------------------------ */
/* 命令表                                                              */
/* ------------------------------------------------------------------ */

export const COMMANDS: CommandDef[] = [
  /* ---------------- 走带 ---------------- */
  {
    id: 'transport.playPause',
    title: '播放 / 暂停',
    group: '走带',
    icon: Play,
    keys: 'Space',
    keywords: 'play pause 空格 走带',
    run: togglePlay,
  },
  {
    id: 'transport.stop',
    title: '停止',
    group: '走带',
    icon: Square,
    keywords: 'stop 停止',
    run: stopTransport,
  },
  {
    id: 'transport.rewind',
    title: '回到开头',
    group: '走带',
    icon: PanelLeft,
    keys: 'mod+enter',
    keywords: 'rewind home 开头',
    run: () => {
      try {
        getAudioEngine().seek(0)
      } catch {
        /* ignore */
      }
      useStore.getState().setPlayhead(0)
    },
  },
  {
    id: 'transport.loop',
    title: '循环开关',
    group: '走带',
    icon: Repeat,
    keys: 'l',
    keywords: 'loop 循环',
    run: () => {
      const store = useStore.getState()
      store.setLoopEnabled(!store.loopEnabled)
      store.setSaveStatus('dirty')
    },
  },
  {
    id: 'transport.metronome',
    title: '节拍器开关',
    group: '走带',
    icon: Timer,
    keys: 'm',
    keywords: 'metronome click 节拍',
    run: () => {
      const store = useStore.getState()
      store.setMetronome(!store.metronome)
    },
  },
  {
    id: 'transport.countIn',
    title: '预备拍（播放前 1 小节）',
    group: '走带',
    icon: ListMusic,
    keywords: 'count in 预备 倒数',
    run: () => {
      const store = useStore.getState()
      store.setCountIn(!store.countIn)
    },
  },
  {
    id: 'transport.record',
    title: 'MIDI 录入（录音预备）',
    subtitle: '在钢琴卷帘中把 MIDI 键盘弹奏写进当前片段',
    group: '走带',
    icon: Radio,
    keys: 'r',
    keywords: 'record 录音 midi',
    run: () => {
      const store = useStore.getState()
      const next = !store.midiRecord
      store.setMidiRecord(next)
      if (next) {
        store.setView('pianoroll')
        useStore
          .getState()
          .pushToast('info', store.selection.clipId ? 'MIDI 录入已开启：弹奏会写入当前片段' : 'MIDI 录入已开启：先在钢琴卷帘选中片段')
      }
    },
  },
  {
    id: 'transport.tapTempo',
    title: 'Tap Tempo（连续点击测速）',
    group: '走带',
    icon: Gauge,
    keywords: 'bpm tap 速度 测速',
    run: () => dispatchEditorCommand({ action: 'tap-tempo' }),
  },

  /* ---------------- 编辑 ---------------- */
  {
    id: 'edit.undo',
    title: '撤销',
    group: '编辑',
    icon: Undo2,
    keys: 'mod+z',
    keywords: 'undo 撤销 回退',
    run: () => useStore.getState().undo(),
    enabled: () => useStore.getState().past.length > 0,
  },
  {
    id: 'edit.redo',
    title: '重做',
    group: '编辑',
    icon: Redo2,
    keys: ['mod+shift+z', 'mod+y'],
    keywords: 'redo 重做',
    run: () => useStore.getState().redo(),
    enabled: () => useStore.getState().future.length > 0,
  },
  {
    id: 'edit.duplicate',
    title: '复制选中内容',
    subtitle: '编曲视图复制片段，钢琴卷帘复制音符',
    group: '编辑',
    icon: Copy,
    keys: 'mod+d',
    keywords: 'duplicate copy 复制 重复',
    run: () => dispatchEditorCommand({ action: 'duplicate' }),
  },
  {
    id: 'edit.split',
    title: '在播放头处拆分',
    group: '编辑',
    icon: Scissors,
    keys: 'mod+e',
    keywords: 'split razor 拆分 切',
    run: () => dispatchEditorCommand({ action: 'split' }),
  },
  {
    id: 'edit.quantize',
    title: '量化到吸附网格',
    group: '编辑',
    icon: ArrowDownWideNarrow,
    keys: 'q',
    keywords: 'quantize 量化 对齐',
    run: () => dispatchEditorCommand({ action: 'quantize' }),
  },
  {
    id: 'edit.delete',
    title: '删除选中内容',
    group: '编辑',
    icon: Trash2,
    keys: ['delete', 'backspace'],
    keywords: 'delete remove 删除',
    run: () => dispatchEditorCommand({ action: 'delete' }),
  },
  {
    id: 'edit.selectAll',
    title: '全选',
    group: '编辑',
    icon: Boxes,
    keys: 'mod+a',
    keywords: 'select all 全选',
    run: () => dispatchEditorCommand({ action: 'select-all' }),
  },
  {
    id: 'edit.transposeUp',
    title: '升高半音',
    group: '编辑',
    icon: ArrowDownWideNarrow,
    keys: 'shift+arrowup',
    keywords: 'transpose up 升调 移调',
    run: () => dispatchEditorCommand({ action: 'transpose', semitones: 1 }),
  },
  {
    id: 'edit.transposeDown',
    title: '降低半音',
    group: '编辑',
    icon: ArrowDownWideNarrow,
    keys: 'shift+arrowdown',
    keywords: 'transpose down 降调 移调',
    run: () => dispatchEditorCommand({ action: 'transpose', semitones: -1 }),
  },

  /* ---------------- 视图 ---------------- */
  {
    id: 'view.arrangement',
    title: '编曲视图',
    group: '视图',
    icon: Boxes,
    keys: '1',
    keywords: 'arrangement 编曲 时间轴',
    run: () => {
      useStore.getState().setView('arrangement')
    },
  },
  {
    id: 'view.pianoroll',
    title: '钢琴卷帘',
    group: '视图',
    icon: Piano,
    keys: '2',
    keywords: 'piano roll 卷帘 midi',
    run: () => {
      useStore.getState().setView('pianoroll')
    },
  },
  {
    id: 'view.smartclips',
    title: '智能片段',
    group: '视图',
    icon: Sparkles,
    keys: '3',
    keywords: 'smart clip generator 生成器',
    run: () => {
      useStore.getState().setView('smartclips')
    },
  },
  {
    id: 'view.toggleChat',
    title: 'AI 助手面板',
    group: '视图',
    icon: Bot,
    keys: 'mod+j',
    keywords: 'ai chat 助手 对话',
    run: toggleChat,
  },
  {
    id: 'view.toggleMixer',
    title: '混音器',
    group: '视图',
    icon: SlidersHorizontal,
    keys: 'mod+shift+m',
    keywords: 'mixer 混音 推子',
    run: () => {
      const store = useStore.getState()
      store.setShowMixer(!store.showMixer)
    },
  },
  {
    id: 'view.follow',
    title: '播放时跟随播放头',
    group: '视图',
    icon: Maximize2,
    keys: 'f',
    keywords: 'follow playhead 跟随 滚动',
    run: () => {
      useUiStore.getState().toggleFollowPlayhead()
    },
  },
  {
    id: 'view.zoomIn',
    title: '放大时间轴',
    group: '视图',
    icon: ZoomIn,
    keys: 'mod+=' ,
    keywords: 'zoom in 放大',
    run: () => dispatchEditorCommand({ action: 'zoom-in' }),
  },
  {
    id: 'view.zoomOut',
    title: '缩小时间轴',
    group: '视图',
    icon: ZoomOut,
    keys: 'mod+-',
    keywords: 'zoom out 缩小',
    run: () => dispatchEditorCommand({ action: 'zoom-out' }),
  },
  {
    id: 'view.zoomFit',
    title: '缩放至适合窗口',
    group: '视图',
    icon: Maximize2,
    keys: 'mod+0',
    keywords: 'zoom fit 适配 全部',
    run: () => dispatchEditorCommand({ action: 'zoom-fit' }),
  },
  {
    id: 'view.toggleChatRail',
    title: 'AI 面板收成侧边条',
    group: '视图',
    icon: PanelRightClose,
    run: () => {
      const ui = useUiStore.getState()
      useStore.getState().setChatOpen(true)
      ui.setChatCollapsed(!ui.chatCollapsed)
    },
  },

  /* ---------------- 轨道 ---------------- */
  {
    id: 'track.add',
    title: '添加轨道',
    group: '轨道',
    icon: Plus,
    keys: 'mod+shift+n',
    keywords: 'add track 新建 乐器',
    run: () => dispatchEditorCommand({ action: 'add-track' }),
  },
  {
    id: 'track.duplicate',
    title: '复制选中轨道',
    group: '轨道',
    icon: Copy,
    keywords: 'duplicate track 复制轨道',
    enabled: () => Boolean(selectedTrack()),
    run: () => {
      const track = selectedTrack()
      if (!track) return
      useStore.getState().duplicateTrack(track.id)
    },
  },
  {
    id: 'track.delete',
    title: '删除选中轨道',
    group: '轨道',
    icon: Trash2,
    keywords: 'delete track 删除轨道',
    enabled: () => Boolean(selectedTrack()),
    run: () => {
      const track = selectedTrack()
      if (!track) return
      useStore.getState().removeTrack(track.id)
      useStore.getState().pushToast('info', `已删除轨道「${track.name}」`)
    },
  },
  {
    id: 'track.mute',
    title: '静音 / 取消静音选中轨道',
    group: '轨道',
    icon: Volume2,
    keywords: 'mute 静音',
    enabled: () => Boolean(selectedTrack()),
    run: () => {
      const track = selectedTrack()
      if (track) useStore.getState().toggleMute(track.id)
    },
  },
  {
    id: 'track.solo',
    title: '独奏 / 取消独奏选中轨道',
    group: '轨道',
    icon: Music4,
    keywords: 'solo 独奏',
    enabled: () => Boolean(selectedTrack()),
    run: () => {
      const track = selectedTrack()
      if (track) useStore.getState().toggleSolo(track.id)
    },
  },
  {
    id: 'track.arm',
    title: '预备录入选中轨道',
    group: '轨道',
    icon: Mic2,
    keywords: 'arm record 预备 录音',
    enabled: () => Boolean(selectedTrack()),
    run: () => {
      const track = selectedTrack()
      if (!track) return
      const ui = useUiStore.getState()
      ui.setArmedTrackId(ui.armedTrackId === track.id ? null : track.id)
    },
  },

  /* ---------------- 工程 ---------------- */
  {
    id: 'project.new',
    title: '新建工程',
    group: '工程',
    icon: FilePlus2,
    keywords: 'new project 新建',
    run: () => {
      window.dispatchEvent(new CustomEvent('aiab:new-project'))
    },
  },
  {
    id: 'project.save',
    title: '保存工程',
    group: '工程',
    icon: Save,
    keys: 'mod+s',
    keywords: 'save 保存',
    run: () => {
      window.dispatchEvent(new CustomEvent('aiab:save'))
    },
  },
  {
    id: 'project.export',
    title: '导出音频 / MIDI',
    group: '工程',
    icon: Download,
    keys: 'mod+shift+e',
    keywords: 'export 导出 wav mp3 midi',
    run: () => useStore.getState().setExportOpen(true),
  },
  {
    id: 'project.settings',
    title: '设置',
    group: '工程',
    icon: Settings2,
    keys: 'mod+,',
    keywords: 'settings 设置 偏好 api',
    run: () => useStore.getState().setSettingsOpen(true),
  },

  /* ---------------- AI ---------------- */
  {
    id: 'ai.compose',
    title: '从零创作一首',
    subtitle: '让 AI 直接搭出完整编曲',
    group: 'AI',
    icon: Wand2,
    keywords: 'compose 创作 生成 编曲',
    run: () => askAi('从零创作一首 8 小节的 lo-fi 编曲：钢琴 / 鼓组 / 贝斯，温暖放松，速度 88 BPM。'),
  },
  {
    id: 'ai.optimize',
    title: '按当前编排优化',
    subtitle: '分析声部、和声与配器并提出改动',
    group: 'AI',
    icon: Zap,
    keywords: 'optimize 优化 分析 编排',
    run: () => askAi('分析并优化当前编排：检查声部平衡、和声连接与配器层次，直接改进工程。'),
  },
  {
    id: 'ai.arrangeMelody',
    title: '旋律 → 完整伴奏',
    group: 'AI',
    icon: Music4,
    keywords: 'arrange melody 旋律 伴奏',
    run: () => askAi('把当前主旋律编成完整伴奏：补上和弦、贝斯与鼓组，保持旋律不变。'),
  },
  {
    id: 'ai.melodyFromChords',
    title: '和弦 → 旋律',
    group: 'AI',
    icon: Music4,
    keywords: 'melody chord 和弦 旋律',
    run: () => askAi('根据当前和弦进行写一段旋律：自然大调、抒情、音域适中。'),
  },
  {
    id: 'ai.emotion',
    title: '换一个情绪',
    group: 'AI',
    icon: Sparkles,
    keywords: 'emotion 情绪 氛围',
    run: () => askAi('把整首编曲的情绪换成更宏大、温暖的版本，保持和声与节奏型不变。'),
  },

  /* ---------------- 帮助 ---------------- */
  {
    id: 'help.palette',
    title: '打开命令面板',
    group: '帮助',
    icon: Search,
    keys: 'mod+k',
    keywords: 'command palette 命令 搜索',
    run: () => {
      window.dispatchEvent(new CustomEvent('aiab:command-palette'))
    },
  },
  {
    id: 'help.shortcuts',
    title: '快捷键与操作指南',
    group: '帮助',
    icon: Keyboard,
    keys: '?',
    keywords: 'help shortcuts 帮助 快捷键',
    run: () => useStore.getState().setHelpOpen(true),
  },
  {
    id: 'help.help',
    title: 'AI 编曲伴侣是什么？',
    group: '帮助',
    icon: Music4,
    keywords: 'about welcome 关于 入门',
    run: () => {
      window.dispatchEvent(new CustomEvent('aiab:welcome'))
    },
  },
]

export const COMMAND_GROUP_ORDER: CommandGroup[] = ['走带', '编辑', '视图', '轨道', '工程', 'AI', '帮助']

/** 按 id 取命令 */
export function getCommand(id: string): CommandDef | undefined {
  return COMMANDS.find((command) => command.id === id)
}

/** 命令是否当前可用 */
export function isCommandEnabled(command: CommandDef): boolean {
  try {
    return command.enabled ? command.enabled() : true
  } catch {
    return true
  }
}

/** 主快捷键（用于界面提示）；没有则返回 undefined */
export function primaryShortcut(command: CommandDef): string | undefined {
  if (!command.keys) return undefined
  return Array.isArray(command.keys) ? command.keys[0] : command.keys
}

/**
 * 模糊搜索：标题/副标题/关键词/id 全字段包含匹配，
 * 并让标题前缀命中排在前面。空查询按分组顺序返回全部可用命令。
 */
export function searchCommands(query: string): CommandDef[] {
  const trimmed = query.trim().toLowerCase()
  const available = COMMANDS.filter(isCommandEnabled)
  if (!trimmed) {
    return [...available].sort(
      (a, b) => COMMAND_GROUP_ORDER.indexOf(a.group) - COMMAND_GROUP_ORDER.indexOf(b.group),
    )
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  const scored: { command: CommandDef; score: number }[] = []
  for (const command of available) {
    const title = command.title.toLowerCase()
    const haystack = [command.title, command.subtitle ?? '', command.keywords ?? '', command.id, command.group]
      .join(' ')
      .toLowerCase()
    if (!tokens.every((token) => haystack.includes(token))) continue
    let score = 0
    if (title.startsWith(trimmed)) score += 120
    if (title.includes(trimmed)) score += 60
    for (const token of tokens) {
      const index = title.indexOf(token)
      if (index === 0) score += 24
      else if (index > 0) score += 12
      if (command.keywords?.toLowerCase().includes(token)) score += 4
    }
    scored.push({ command, score })
  }
  return scored.sort((a, b) => b.score - a.score).map((item) => item.command)
}
