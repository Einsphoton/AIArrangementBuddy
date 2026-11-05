/**
 * Slash 命令：输入 `/` 打开命令面板，选中后补全命令，发送时把命令 + 参数
 * 展开成一段完整的中文提示词。
 *
 * 设计约束：
 * - 只做「提示词模板」，不新增后端协议；intent 仍是 CONTRACTS §5 里的合法值；
 * - /help 不消耗模型调用，直接在对话里插入一条本地说明；
 * - 命令定义集中在这里，ChatPanel 只负责展示与键盘导航。
 */
export interface SlashCommand {
  /** 命令名，含斜杠，如 `/compose` */
  name: string
  /** 列表里显示的中文名 */
  label: string
  /** 一句话说明 */
  description: string
  /** 参数提示（有参数时显示在命令名后面） */
  argsHint?: string
  /** 发送给后端的意图（必须是服务端白名单里的值） */
  intent?: 'compose' | 'arrange' | 'melody' | 'chords' | 'optimize'
  /** 展开成提示词；args 是用户在命令后输入的补充说明（可能为空） */
  build: (args: string) => string
  /** 本地命令：不请求 AI */
  local?: boolean
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: '/compose',
    label: '从零创作',
    description: '生成完整编曲并写入工程',
    argsHint: '风格 / 速度 / 情绪（可省略）',
    intent: 'compose',
    build: (args) =>
      args
        ? `从零创作一首完整编曲：${args}。要求 8 小节以上，包含和弦、贝斯、鼓组与主旋律，声部层次清晰，直接写入当前工程。`
        : '从零创作一首 88 BPM 的 lo-fi 编曲：钢琴、鼓组、贝斯，8 小节，氛围温暖放松，带一点黑胶颗粒感，直接写入当前工程。',
  },
  {
    name: '/optimize',
    label: '优化编排',
    description: '分析工程并落实具体改进',
    argsHint: '想优化的方向（可省略）',
    intent: 'optimize',
    build: (args) =>
      args
        ? `分析当前工程的和声、节奏与配器，重点优化：${args}。直接落实 3 条能明显提升编曲质量的改动，不要破坏已有旋律。`
        : '分析当前工程的调性、和弦进行、节奏密度与配器层次，直接落实 3 条能明显提升编曲质量的改动，不要破坏已有旋律。',
  },
  {
    name: '/melody',
    label: '写旋律',
    description: '为选中轨道补一段旋律',
    argsHint: '风格 / 音区 / 情绪（可省略）',
    intent: 'melody',
    build: (args) =>
      args
        ? `根据当前工程的和弦进行，为选中轨道写一段旋律：${args}。注意动机重复、乐句呼吸与起伏，直接写入。`
        : '根据当前工程的和弦进行，为选中轨道写一段好听的旋律，注意动机重复、乐句呼吸与起伏，直接写入。',
  },
  {
    name: '/chords',
    label: '配和弦',
    description: '生成或优化和弦进行',
    argsHint: '色彩 / 进行方向（可省略）',
    intent: 'chords',
    build: (args) =>
      args
        ? `为当前工程生成一段和弦进行：${args}。声部连接要平滑，避免平行五八度，直接写入选中轨道。`
        : '为当前工程生成一段和弦进行，声部连接平滑、有推动力，与当前调性和风格一致，直接写入选中轨道。',
  },
  {
    name: '/drums',
    label: '加鼓组',
    description: '新增鼓组轨道与律动',
    argsHint: '风格 / 密度（可省略）',
    intent: 'arrange',
    build: (args) =>
      args
        ? `给工程加一条鼓组轨道并生成律动：${args}。注意底鼓与贝斯的配合、军鼓与拍手的位置，音量与其他轨道平衡。`
        : '给工程加一条鼓组轨道，做一条与当前风格匹配的律动（底鼓、军鼓、踩镲、拍手），并保持与其他轨道的音量平衡。',
  },
  {
    name: '/emotion',
    label: '换情绪',
    description: '调整整体氛围而不改结构',
    argsHint: '目标情绪（可省略）',
    intent: 'optimize',
    build: (args) =>
      `把当前工程的整体情绪调整为${args || '更温暖、更有空间感'}：通过配器、音区与力度实现，不要改变和弦与节奏骨架。`,
  },
  {
    name: '/help',
    label: '命令帮助',
    description: '在对话里列出所有可用命令',
    local: true,
    build: () =>
      [
        '可用命令：',
        ...SLASH_COMMANDS.filter((command) => !command.local).map(
          (command) => `${command.name}　${command.label} — ${command.description}`,
        ),
        '',
        '用法：输入 / 选择命令，或直接输入 `/命令 补充说明` 后回车；不写补充说明时使用默认模板。',
      ].join('\n'),
  },
]

export interface SlashDraft {
  /** 当前是否应该弹出命令菜单 */
  menuOpen: boolean
  /** 命令名之后的过滤词（菜单里用于筛选） */
  query: string
  /** 完全匹配的命令（含参数） */
  command?: SlashCommand
  /** 命令后的补充参数 */
  args: string
  /** 菜单里展示的命令（已过滤） */
  matches: SlashCommand[]
}

const SLASH_RE = /^\/([a-zA-Z]*)(?:\s+([\s\S]*))?$/

/** 解析输入框内容，决定是否弹命令菜单、匹配到哪个命令 */
export function parseSlashDraft(draft: string): SlashDraft {
  const empty: SlashDraft = { menuOpen: false, query: '', args: '', matches: [] }
  const trimmed = draft.replace(/^\s+/, '')
  if (!trimmed.startsWith('/')) return empty

  const match = SLASH_RE.exec(trimmed)
  if (!match) {
    // 形如 `/compose 参数` 已经带空格，或包含非法字符：不再弹菜单
    return empty
  }

  const [, namePart = '', argsPart = ''] = match
  const query = namePart.toLowerCase()
  const matches = SLASH_COMMANDS.filter((command) => command.name.slice(1).startsWith(query))
  const exact = SLASH_COMMANDS.find((command) => command.name.slice(1) === query)

  // `/compose 参数`（命令后已出现空白）→ 进入参数输入，菜单收起
  const hasSeparator = trimmed.length > 1 + namePart.length
  if (hasSeparator) {
    return { menuOpen: false, query, command: exact, args: argsPart, matches }
  }
  // 只有 `/` 或 `/comp`：菜单展开
  return { menuOpen: matches.length > 0, query, args: '', matches }
}

export interface ResolvedSlashPrompt {
  text: string
  intent?: SlashCommand['intent']
  /** 本地命令（如 /help），不请求后端 */
  local: boolean
}

/** 发送前把 `/命令 参数` 展开成完整提示词；不是命令则返回 null */
export function resolveSlashPrompt(draft: string): ResolvedSlashPrompt | null {
  const trimmed = draft.replace(/^\s+/, '')
  if (!trimmed.startsWith('/')) return null
  const match = SLASH_RE.exec(trimmed)
  if (!match) return null
  const [, namePart = '', argsPart = ''] = match
  const command = SLASH_COMMANDS.find((item) => item.name.slice(1) === namePart.toLowerCase())
  if (!command) return null
  return {
    text: command.build(argsPart.trim()),
    intent: command.intent,
    local: Boolean(command.local),
  }
}
