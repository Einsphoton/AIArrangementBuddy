import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowRight,
  AudioWaveform,
  Check,
  ChevronDown,
  CircleAlert,
  Command,
  CornerDownLeft,
  Globe,
  KeyRound,
  Layers,
  ListMusic,
  LoaderCircle,
  MessageSquarePlus,
  Music4,
  PanelRightClose,
  PanelRightOpen,
  PlugZap,
  RotateCcw,
  Send,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
  WandSparkles,
  X,
} from 'lucide-react'
import { beatsPerBar } from '@aiab/core'
import { useStore } from '../../store/store'
import { getHealth, getSettings } from '../../lib/api'
import { cn } from '../../lib/format'
import { useUiStore } from '../../lib/uiStore'
import { Button, Spinner } from '../../components/ui'
import { MessageItem } from './MessageItem'
import { useChatStream } from './useChatStream'
import { clearMessageMetrics } from './chatMetrics'
import { parseSlashDraft, resolveSlashPrompt, type SlashCommand } from './slashCommands'
import { AudioEngineMenu } from '../audio/AudioEngineMenu'
import { AudioJobCard } from '../audio/AudioJobCard'
import { GenerateAudioPanel } from '../audio/GenerateAudioPanel'
import { TaskCenterPanel } from '../audio/TaskCenterPanel'
import { useAudioJobStore } from '../audio/audioJobStore'
import { detectAudioIntent } from '../audio/audioIntent'

const BACKEND_LABEL: Record<string, string> = {
  builtin: '内置 Agent',
  codex: 'Codex CLI',
  dsh: 'DeepSeek Harness',
}

/** 输入框最多 8 行（与 textarea 的 leading-relaxed 13px 匹配） */
const MAX_INPUT_HEIGHT = 240
/** 输入框默认高度：至少 3 行，避免看起来像搜索框 */
const MIN_INPUT_HEIGHT = 88
/** 面板高度不足（例如混音器打开、笔记本小屏）时的紧凑输入框高度 */
const COMPACT_INPUT_HEIGHT = 56
/** 高度低于此值时进入紧凑模式：隐藏快捷动作、压缩输入区，保证输入框永远在可视区 */
const COMPACT_PANEL_HEIGHT = 520

interface BackendInfo {
  backend: string
  backendAvailable: boolean
  providerName: string
  model: string
  configured: boolean
}

interface SamplePrompt {
  title: string
  description: string
  prompt: string
  intent?: string
}

const SAMPLE_PROMPTS: SamplePrompt[] = [
  {
    title: '从零创作一首 lo-fi',
    description: '88 BPM · 钢琴 / 鼓组 / 贝斯 · 温暖放松',
    prompt: '从零创作一首 88 BPM 的 lo-fi 编曲：钢琴、鼓组、贝斯，8 小节，氛围温暖放松，带一点黑胶颗粒感。',
    intent: 'compose',
  },
  {
    title: '直接生成一首音频',
    description: '文本 → 成品音频 · 可直接播放',
    prompt: '用音频生成模型做一首 30 秒的温暖 cinematic 成品（钢琴 + 弦乐 + 轻鼓，72 BPM），直接产出可播放音频并加入工程。',
    intent: 'audio',
  },
  {
    title: '把旋律编成完整伴奏',
    description: '旋律 → 和弦 + 贝斯 + 鼓',
    prompt: '把第 1 轨已有的旋律自动编出完整伴奏：补上和弦进行、贝斯与鼓组，风格与当前工程保持一致。',
    intent: 'arrange',
  },
]

const QUICK_ACTIONS: SamplePrompt[] = [
  {
    title: '从零创作',
    description: '',
    prompt: '从零帮我创作一首完整的编曲，风格根据当前工程来定，先给我 8 小节。',
    intent: 'compose',
  },
  {
    title: '按当前编排优化',
    description: '',
    prompt: '分析当前工程并直接优化：让和弦更顺、节奏更有推动力、配器层次更清晰，不要破坏已有旋律。',
    intent: 'optimize',
  },
  {
    title: '旋律 → 自动编曲',
    description: '',
    prompt: '把选中的旋律片段自动编曲：生成和弦进行和整套伴奏，风格与当前工程一致。',
    intent: 'arrange',
  },
  {
    title: '和弦 → 填旋律',
    description: '',
    prompt: '根据工程里的和弦进行，为选中轨道填写一段好听的旋律，注意动机重复与起伏。',
    intent: 'melody',
  },
  {
    title: '加鼓组律动',
    description: '',
    prompt: '给工程加一条鼓组轨道，做一条与当前风格匹配的律动，并保持与其他轨道的音量平衡。',
  },
  {
    title: '换个情绪',
    description: '',
    prompt: '把当前工程的整体情绪换一种：更温暖、更有空间感，但不要改变和弦与节奏。',
    intent: 'optimize',
  },
  {
    title: '生成整首音频',
    description: '',
    prompt: '用音频生成模型做一首成品：温暖 cinematic，钢琴 + 弦乐 + 轻鼓，72 BPM，30 秒，直接产出音频并加入工程。',
    intent: 'audio',
  },
  {
    title: 'MIDI → 音频',
    description: '',
    prompt: '把当前工程按现有编配渲染成音频并加入工程；如果工程还是空的，先补一段完整编曲再渲染。',
    intent: 'audio',
  },
  {
    title: '生成分轨',
    description: '',
    prompt: '生成一首成品音频并分轨：流行乐队编制，先出整曲，再分别生成吉他、贝斯、鼓组分轨，各自成轨。',
    intent: 'audio',
  },
]

interface ContextChip {
  id: string
  kind: 'track' | 'clip'
  label: string
  hint: string
  /** 发送时写进提示词的上下文行 */
  contextLine: string
}

export function ChatPanel() {
  const messages = useStore((s) => s.messages)
  const aiBusy = useStore((s) => s.aiBusy)
  const aiError = useStore((s) => s.aiError)
  const pendingPrompt = useStore((s) => s.pendingPrompt)
  const setPendingPrompt = useStore((s) => s.setPendingPrompt)
  const setChatOpen = useStore((s) => s.setChatOpen)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const clearMessages = useStore((s) => s.clearMessages)
  const setAiError = useStore((s) => s.setAiError)
  const pushToast = useStore((s) => s.pushToast)
  const addMessage = useStore((s) => s.addMessage)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const project = useStore((s) => s.project)
  const selectedTrackId = useStore((s) => s.selectedTrackId)
  const selectedClipId = useStore((s) => s.selection.clipId)

  const chatCollapsed = useUiStore((s) => s.chatCollapsed)
  const setChatCollapsed = useUiStore((s) => s.setChatCollapsed)

  const { send, stop, retry, regenerate, interrupted, dismissInterrupted } = useChatStream()

  const [draft, setDraft] = useState('')
  const [backendState, setBackendState] = useState<'checking' | 'online' | 'offline'>('checking')
  const [backendInfo, setBackendInfo] = useState<BackendInfo | null>(null)
  const [errorBannerDismissed, setErrorBannerDismissed] = useState(false)
  const [dismissedChips, setDismissedChips] = useState<string[]>([])
  const [showJump, setShowJump] = useState(false)
  const [menuSuppressed, setMenuSuppressed] = useState(false)
  const [highlight, setHighlight] = useState(0)
  /** 旧版高级生成表单 / Companion 任务中心：收进音频引擎菜单，不再占用顶栏 */
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [taskCenterOpen, setTaskCenterOpen] = useState(false)
  /** 面板实际宽度（由 App 外壳决定）；窄于 360px 时收敛次要文案，避免文字被裁切 */
  const [panelWidth, setPanelWidth] = useState(0)
  /** 面板实际高度：高度不足时进入紧凑模式（混音器打开 / 小屏 / 窄高窗口） */
  const [panelHeight, setPanelHeight] = useState(0)
  const rootRef = useRef<HTMLElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  /** 窄面板：隐藏次要文字，只保留关键信息 */
  const narrow = panelWidth > 0 && panelWidth < 360
  /** 高度不足：收起快捷动作、压缩输入区，避免内容被混音器/底栏盖住 */
  const compact = panelHeight > 0 && panelHeight < COMPACT_PANEL_HEIGHT

  /* ------------------------------ 后端状态 ------------------------------ */
  const refreshBackend = useCallback(async () => {
    setBackendState('checking')
    try {
      const [health, settings] = await Promise.all([getHealth(), getSettings()])
      const backend = settings.agent?.backend ?? 'builtin'
      const provider =
        settings.providers.find((item) => item.id === settings.activeProviderId) ?? settings.providers[0]
      const agentProbe = health.agents?.find((agent) => agent.backend === backend)
      const configured = backend === 'builtin' ? Boolean(provider?.apiKey) : agentProbe?.available !== false
      setBackendInfo({
        backend,
        backendAvailable: backend === 'builtin' ? health.ok : agentProbe?.available !== false,
        providerName: provider?.name ?? '未配置服务商',
        model: provider?.model ?? '',
        configured,
      })
      setBackendState('online')
    } catch {
      setBackendState('offline')
      setBackendInfo(null)
    }
  }, [])

  useEffect(() => {
    void refreshBackend()
  }, [refreshBackend])

  useEffect(() => {
    if (settingsOpen) return
    void refreshBackend()
  }, [settingsOpen, refreshBackend])

  useEffect(() => {
    const handler = () => void refreshBackend()
    window.addEventListener('aiab:settings-saved', handler)
    return () => window.removeEventListener('aiab:settings-saved', handler)
  }, [refreshBackend])

  /* ------------------------------ 外部提示词 ----------------------------- */
  useEffect(() => {
    if (!pendingPrompt) return
    setDraft(pendingPrompt)
    setPendingPrompt(null)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [pendingPrompt, setPendingPrompt])

  /* ------------------------------ 滚动跟随 ------------------------------ */
  useEffect(() => {
    const element = scrollRef.current
    if (!element || !stickToBottomRef.current) return
    element.scrollTop = element.scrollHeight
  }, [messages])

  const handleScroll = () => {
    const element = scrollRef.current
    if (!element) return
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 56
    stickToBottomRef.current = nearBottom
    setShowJump(!nearBottom)
  }

  const jumpToBottom = () => {
    const element = scrollRef.current
    if (!element) return
    stickToBottomRef.current = true
    setShowJump(false)
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
  }

  /* ------------------------------ 输入框自适应 --------------------------- */
  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    const min = compact ? COMPACT_INPUT_HEIGHT : MIN_INPUT_HEIGHT
    const max = compact ? 120 : MAX_INPUT_HEIGHT
    element.style.minHeight = `${min}px`
    element.style.maxHeight = `${max}px`
    const next = Math.min(max, Math.max(min, element.scrollHeight + 2))
    element.style.height = `${next}px`
  }, [draft, panelWidth, panelHeight, compact])

  /* ------------------------------ 面板尺寸 ------------------------------ */
  useEffect(() => {
    const element = rootRef.current
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      setPanelWidth(Math.round(rect.width))
      setPanelHeight(Math.round(rect.height))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      setPanelWidth(Math.round(rect?.width ?? element.getBoundingClientRect().width))
      setPanelHeight(Math.round(rect?.height ?? element.getBoundingClientRect().height))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [chatCollapsed])

  /* ------------------------------ 上下文 chip ---------------------------- */
  const contextChips = useMemo<ContextChip[]>(() => {
    const chips: ContextChip[] = []
    const track = project.tracks.find((item) => item.id === selectedTrackId)
    if (track) {
      const index = project.tracks.indexOf(track)
      chips.push({
        id: `track:${track.id}`,
        kind: 'track',
        label: `轨道 · ${track.name}`,
        hint: `第 ${index + 1} 轨 · ${track.clips.length} 个片段`,
        contextLine: `选中轨道：${track.name}（第 ${index + 1} 轨）`,
      })
    }
    if (selectedClipId) {
      for (const [index, item] of project.tracks.entries()) {
        const clip = item.clips.find((candidate) => candidate.id === selectedClipId)
        if (!clip) continue
        const barBeats = beatsPerBar(project.timeSignature)
        const startBar = Math.floor(clip.startBeat / barBeats) + 1
        const endBar = Math.max(startBar, Math.ceil((clip.startBeat + clip.lengthBeats) / barBeats))
        chips.push({
          id: `clip:${clip.id}`,
          kind: 'clip',
          label: `片段 · ${clip.name}`,
          hint: `第 ${index + 1} 轨 ${item.name} · 第 ${startBar}–${endBar} 小节 · ${clip.notes.length} 个音符`,
          contextLine: `选中片段：${clip.name}（轨道 ${item.name}，第 ${startBar}–${endBar} 小节）`,
        })
        break
      }
    }
    return chips.filter((chip) => !dismissedChips.includes(chip.id))
  }, [project, selectedTrackId, selectedClipId, dismissedChips])

  const contextPrefix = useMemo(() => {
    if (!contextChips.length) return ''
    return `【当前上下文】\n${contextChips.map((chip) => `- ${chip.contextLine}`).join('\n')}`
  }, [contextChips])

  /** 结构化上下文：只有未被移除的 chip 才作为 attachments 传给后端 */
  const attachments = useMemo(() => {
    const ids = new Set(contextChips.map((chip) => chip.id))
    const next: { melodyTrackId?: string; referenceClipId?: string } = {}
    if (selectedTrackId && ids.has(`track:${selectedTrackId}`)) next.melodyTrackId = selectedTrackId
    if (selectedClipId && ids.has(`clip:${selectedClipId}`)) next.referenceClipId = selectedClipId
    return Object.keys(next).length > 0 ? next : undefined
  }, [contextChips, selectedTrackId, selectedClipId])

  /* ------------------------------ 发送 ------------------------------ */
  const canChat =
    backendState === 'online' && (backendInfo ? backendInfo.configured : true) && backendInfo?.backendAvailable !== false

  const guardSend = useCallback(
    (text: string): boolean => {
      if (aiBusy) {
        pushToast('info', 'AI 正在生成，请稍候或先停止')
        return false
      }
      if (backendState === 'offline') {
        pushToast('error', '本地服务未连接，无法发送。请先运行 pnpm dev')
        return false
      }
      if (backendInfo && !backendInfo.configured) {
        pushToast('error', '请先在设置里配置 AI 服务商')
        setSettingsOpen(true)
        return false
      }
      if (backendInfo && !backendInfo.backendAvailable) {
        pushToast('error', `Agent 后端不可用：${BACKEND_LABEL[backendInfo.backend] ?? backendInfo.backend}`)
        return false
      }
      if (!text.trim()) return false
      return true
    },
    [aiBusy, backendInfo, backendState, pushToast, setSettingsOpen],
  )

  const handleSend = useCallback(
    (text: string, intent?: string) => {
      const resolved = resolveSlashPrompt(text)
      // /help 这类本地命令：不请求后端，直接在对话里给出说明
      if (resolved?.local) {
        addMessage({ role: 'system', content: resolved.text })
        setDraft('')
        setMenuSuppressed(true)
        return
      }
      const body = (resolved ? resolved.text : text).trim()
      if (!body) return
      const finalText = contextPrefix ? `${contextPrefix}\n\n${body}` : body
      if (!guardSend(finalText)) return
      // 意图：命令/快捷动作显式指定 > 用户措辞里的音频意图（让 Agent 直接按 AUDIO_GUIDE 决策）
      const detectedIntent = resolved?.intent ?? intent ?? (detectAudioIntent(body) ? 'audio' : undefined)
      send(finalText, { intent: detectedIntent, attachments })
      setDraft('')
      setMenuSuppressed(true)
      stickToBottomRef.current = true
      setShowJump(false)
      setErrorBannerDismissed(false)
    },
    [addMessage, attachments, contextPrefix, guardSend, send],
  )

  const handleQuickAction = (action: SamplePrompt) => {
    if (!canChat || aiBusy) {
      setDraft(action.prompt)
      pushToast('info', '已填入输入框，请先检查 AI 设置')
      requestAnimationFrame(() => textareaRef.current?.focus())
      return
    }
    handleSend(action.prompt, action.intent)
  }

  const handleNewChat = () => {
    if (aiBusy) stop()
    clearMessages()
    clearMessageMetrics()
    dismissInterrupted()
    setErrorBannerDismissed(false)
    setDraft('')
    const audioJob = useAudioJobStore.getState().job
    if (!audioJob || audioJob.status !== 'running') useAudioJobStore.getState().clear()
    pushToast('info', '已开始新对话')
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const handleClear = () => {
    if (messages.length === 0) return
    if (aiBusy) stop()
    clearMessages()
    clearMessageMetrics()
    dismissInterrupted()
    pushToast('info', '对话已清空')
  }

  /* ------------------------------ Slash 命令 ---------------------------- */
  const slash = useMemo(() => parseSlashDraft(draft), [draft])
  const menuOpen = slash.menuOpen && !menuSuppressed && slash.matches.length > 0

  useEffect(() => {
    setMenuSuppressed(false)
    setHighlight(0)
  }, [draft])

  const selectCommand = (command: SlashCommand) => {
    if (command.local) {
      addMessage({ role: 'system', content: command.build('') })
      setDraft('')
      setMenuSuppressed(true)
      return
    }
    setDraft(`${command.name} `)
    setMenuSuppressed(true)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return

    if (menuOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlight((value) => (value + 1) % slash.matches.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlight((value) => (value - 1 + slash.matches.length) % slash.matches.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const command = slash.matches[highlight] ?? slash.matches[0]
        if (command) selectCommand(command)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMenuSuppressed(true)
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (aiBusy) {
        pushToast('info', 'AI 正在生成，可先点击停止')
        return
      }
      handleSend(draft)
    }
  }

  const lastAssistantId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'assistant') return messages[index].id
    }
    return null
  }, [messages])

  const hasInlineError = messages.some((message) => Boolean(message.error))
  const showErrorBanner = Boolean(aiError) && !aiBusy && !errorBannerDismissed && !hasInlineError
  const keyIssue = aiError ? /key|密钥|鉴权|401|403|unauthor|配置|服务商|api[\s-]?key/i.test(aiError) : false

  /* ------------------------------ 收起态（窄条 rail） -------------------- */
  const statusLabel =
    backendState === 'checking'
      ? '正在连接后端…'
      : backendState === 'offline'
        ? '后端未连接'
        : !backendInfo?.configured
          ? '未配置 AI 服务商'
          : backendInfo?.backendAvailable === false
            ? 'Agent 后端不可用'
            : `${BACKEND_LABEL[backendInfo?.backend ?? 'builtin'] ?? '内置 Agent'} 已就绪`

  const statusDot =
    backendState === 'checking'
      ? 'bg-accent animate-pulse'
      : backendState === 'offline'
        ? 'bg-danger'
        : !backendInfo?.configured || backendInfo?.backendAvailable === false
          ? 'bg-accent'
          : 'bg-success'

  if (chatCollapsed) {
    return (
      <aside
        ref={rootRef}
        className="flex h-full w-full flex-col items-center gap-1 border-l border-line bg-surface py-2"
        aria-label="AI 编曲助手（已收起）"
      >
        <button
          className="btn btn-ghost btn-icon h-8 w-8"
          title="展开 AI 面板"
          aria-label="展开 AI 面板"
          onClick={() => setChatCollapsed(false)}
        >
          <PanelRightOpen size={15} />
        </button>
        <div className="flex flex-col items-center gap-1 py-1" title={statusLabel}>
          <span className={cn('h-1.5 w-1.5 rounded-full', statusDot)} />
          <span className="text-[9px] font-semibold tracking-wide text-ink-4">AI</span>
        </div>
        <button
          className="btn btn-ghost btn-icon h-8 w-8"
          title="新对话"
          aria-label="新对话"
          onClick={handleNewChat}
        >
          <MessageSquarePlus size={14} />
        </button>
        <button
          className="btn btn-ghost btn-icon h-8 w-8"
          title="打开设置"
          aria-label="打开设置"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings2 size={14} />
        </button>
        <button
          className="btn btn-ghost btn-icon h-8 w-8"
          title="关闭 AI 面板"
          aria-label="关闭 AI 面板"
          onClick={() => setChatOpen(false)}
        >
          <X size={14} />
        </button>
        <div className="mt-auto flex flex-col items-center gap-2 pb-1">
          <span className="text-[9.5px] tracking-[0.28em] text-ink-4 [writing-mode:vertical-rl]">AI 编曲助手</span>
        </div>
      </aside>
    )
  }

  return (
    <aside ref={rootRef} className="flex h-full w-full min-w-0 flex-col overflow-hidden border-l border-line bg-surface">
      {/* 顶部 */}
      <header className="flex h-[46px] shrink-0 items-center gap-2 border-b border-line px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] border border-accent/35 bg-gradient-to-b from-accent/22 to-accent/5">
            <Sparkles size={12} className="text-accent" />
          </div>
          <div className="min-w-0 flex-1 overflow-hidden leading-tight">
            <div className="truncate text-[12.5px] font-semibold tracking-tight">AI 编曲助手</div>
            <button
              type="button"
              className="mt-0.5 flex w-full min-w-0 items-center gap-1 overflow-hidden text-left text-[9.5px] text-ink-4 hover:text-ink-2"
              title={`${statusLabel}${backendInfo?.providerName ? ` · ${backendInfo.providerName}` : ''}（点击打开设置）`}
              aria-label={`${statusLabel}，点击打开设置`}
              onClick={() => setSettingsOpen(true)}
            >
              {backendState === 'checking' ? (
                <>
                  <Spinner size={8} />
                  <span className="min-w-0 truncate">正在连接…</span>
                </>
              ) : backendState === 'offline' ? (
                <>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
                  <span className="min-w-0 truncate">后端未连接</span>
                </>
              ) : (
                <>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                  <span className="min-w-0 truncate">{BACKEND_LABEL[backendInfo?.backend ?? 'builtin'] ?? '内置 Agent'}</span>
                  {backendInfo?.model && !narrow ? (
                    <>
                      <span className="shrink-0 text-ink-4/60">·</span>
                      <span className="mono min-w-0 truncate" title={backendInfo.model}>
                        {backendInfo.model}
                      </span>
                    </>
                  ) : null}
                </>
              )}
            </button>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <AudioEngineMenu onOpenAdvanced={() => setAdvancedOpen(true)} onOpenTasks={() => setTaskCenterOpen(true)} />
          <button className="btn btn-ghost btn-icon h-7 w-7" title="新对话" aria-label="新对话" onClick={handleNewChat}>
            <MessageSquarePlus size={13} />
          </button>
          <button
            className="btn btn-ghost btn-icon h-7 w-7"
            title="清空对话"
            aria-label="清空对话"
            onClick={handleClear}
            disabled={messages.length === 0}
          >
            <Trash2 size={12} />
          </button>
          <button
            className="btn btn-ghost btn-icon h-7 w-7"
            title="收起为窄条"
            aria-label="收起为窄条"
            onClick={() => setChatCollapsed(true)}
          >
            <PanelRightClose size={13} />
          </button>
        </div>
      </header>

      {/* 提示区 */}
      <div className="shrink-0 space-y-1.5 px-3 pt-2 empty:hidden">
        {backendState === 'offline' && (
          <Notice
            tone="danger"
            icon={<PlugZap size={12} />}
            title="本地服务未连接"
            description={
              <>
                AI 功能需要本地后端（127.0.0.1:8787）。在项目根目录运行{' '}
                <code className="mono rounded bg-black/30 px-1 py-[1px] text-[10.5px] text-accent-soft">pnpm dev</code>{' '}
                后点击重试。
              </>
            }
            actions={
              <button
                className="flex h-6 items-center gap-1 rounded-md border border-line-strong bg-surface-2 px-2 text-[10.5px] text-ink-2 hover:text-ink"
                onClick={() => void refreshBackend()}
              >
                <RotateCcw size={9} />
                重试
              </button>
            }
          />
        )}

        {backendState === 'online' && backendInfo && !backendInfo.configured && (
          <Notice
            tone="accent"
            icon={<KeyRound size={12} />}
            title="尚未配置 AI 服务商"
            description="内置 Agent 需要 AI API Key；也可以切换到 Codex / DeepSeek Harness 后端复用本机登录。"
            actions={
              <button
                className="flex h-6 items-center gap-1 rounded-md border border-accent/45 bg-accent/12 px-2 text-[10.5px] text-accent-soft hover:bg-accent/20"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings2 size={9} />
                去设置
              </button>
            }
          />
        )}

        {backendState === 'online' && backendInfo && !backendInfo.backendAvailable && (
          <Notice
            tone="danger"
            icon={<TriangleAlert size={12} />}
            title={`Agent 后端不可用：${BACKEND_LABEL[backendInfo.backend] ?? backendInfo.backend}`}
            description="请在「设置 → Agent 后端」里检查可执行文件路径，或改用「内置 Agent」。"
            actions={
              <button
                className="flex h-6 items-center gap-1 rounded-md border border-line-strong bg-surface-2 px-2 text-[10.5px] text-ink-2 hover:text-ink"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings2 size={9} />
                打开设置
              </button>
            }
          />
        )}

        {showErrorBanner && aiError && (
          <Notice
            tone="danger"
            icon={<CircleAlert size={12} />}
            title="请求失败"
            description={aiError}
            actions={
              <>
                {keyIssue && (
                  <button
                    className="flex h-6 items-center gap-1 rounded-md border border-accent/45 bg-accent/12 px-2 text-[10.5px] text-accent-soft"
                    onClick={() => setSettingsOpen(true)}
                  >
                    <Settings2 size={9} />
                    去设置
                  </button>
                )}
                <button
                  className="flex h-6 items-center gap-1 rounded-md border border-line-strong bg-surface-2 px-2 text-[10.5px] text-ink-2 hover:text-ink"
                  onClick={() => {
                    setAiError(null)
                    setErrorBannerDismissed(true)
                  }}
                >
                  <X size={9} />
                  关闭
                </button>
              </>
            }
          />
        )}

        {interrupted && (
          <Notice
            tone="accent"
            icon={<TriangleAlert size={12} />}
            title="连接中断"
            description="回答可能不完整。可以重试，或继续输入补充说明。"
            actions={
              <>
                <button
                  className="flex h-6 items-center gap-1 rounded-md border border-accent/45 bg-accent/12 px-2 text-[10.5px] text-accent-soft"
                  onClick={() => {
                    dismissInterrupted()
                    retry()
                  }}
                >
                  <RotateCcw size={9} />
                  重试
                </button>
                <button
                  className="flex h-6 items-center gap-1 rounded-md border border-line-strong bg-surface-2 px-2 text-[10.5px] text-ink-2 hover:text-ink"
                  onClick={dismissInterrupted}
                >
                  <X size={9} />
                  关闭
                </button>
              </>
            }
          />
        )}
      </div>

      {/* 消息流 */}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto px-3 py-3">
          {messages.length === 0 ? (
            <EmptyState
              backendState={backendState}
              backendInfo={backendInfo}
              statusLabel={statusLabel}
              onSample={(sample) => handleQuickAction(sample)}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          ) : (
            <div className="space-y-4">
              {messages.map((message) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  isLast={message.id === lastAssistantId}
                  busy={aiBusy}
                  onRetry={() => retry()}
                  onRegenerate={() => regenerate()}
                  onOpenSettings={() => setSettingsOpen(true)}
                />
              ))}
              <div className="h-1" />
            </div>
          )}
        </div>

        {showJump && messages.length > 0 && (
          <button
            className="absolute bottom-3 right-3 z-10 flex h-7 items-center gap-1 rounded-full border border-line-strong bg-surface-2/95 px-2.5 text-[10.5px] text-ink-2 shadow-[0_10px_24px_-12px_rgba(0,0,0,0.9)] backdrop-blur hover:text-ink"
            title="滚动到最新消息"
            aria-label="滚动到最新消息"
            onClick={jumpToBottom}
          >
            <ArrowDown size={11} />
            最新
          </button>
        )}
      </div>

      {/* AI 自动执行的音频任务：进度 / 取消 / 失败后的下一步 */}
      <div className="shrink-0 px-3 pt-2 empty:hidden">
        <AudioJobCard compact={compact} />
      </div>

      {/* 快捷动作（面板高度不足时隐藏，优先保证消息区与输入框可用） */}
      {!compact && (
        <div className="shrink-0 border-t border-line/70 px-3 pb-1 pt-2">
          <div className="mb-1.5 flex items-center gap-1 text-[10px] text-ink-4">
            <WandSparkles size={10} className="text-accent/70" />
            快捷动作
            <span className="ml-auto truncate pl-2">点击直接发送</span>
          </div>
          <div className="flex flex-wrap gap-1.5 pb-0.5">
            {QUICK_ACTIONS.map((action) => {
              const audio = action.intent === 'audio'
              return (
                <button
                  key={action.title}
                  className={cn(
                    'chip shrink-0',
                    audio && 'border-accent/40 text-accent-soft hover:border-accent/70 hover:bg-accent/10',
                    aiBusy && 'pointer-events-none opacity-45',
                  )}
                  title={action.prompt}
                  onClick={() => handleQuickAction(action)}
                >
                  {audio ? <AudioWaveform size={10} className="shrink-0" /> : null}
                  {action.title}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* 输入区 */}
      <div className="shrink-0 px-3 pb-3 pt-2">
        {/* 上下文 chip */}
        {contextChips.length > 0 && (
          <div className="mb-1.5 flex flex-wrap items-center gap-1">
            <span className="text-[9.5px] text-ink-4">上下文</span>
            {contextChips.map((chip) => (
              <span
                key={chip.id}
                className="group/chip flex h-[22px] max-w-full items-center gap-1 rounded-md border border-accent/25 bg-accent/8 pl-1.5 pr-0.5 text-[10px] text-accent-soft"
                title={chip.hint}
              >
                {chip.kind === 'track' ? <ListMusic size={9} className="shrink-0" /> : <Music4 size={9} className="shrink-0" />}
                <span className="truncate">{chip.label}</span>
                <button
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-ink-4 hover:bg-accent/15 hover:text-ink"
                  title={`移除上下文：${chip.label}`}
                  aria-label={`移除上下文：${chip.label}`}
                  onClick={() => setDismissedChips((prev) => [...prev, chip.id])}
                >
                  <X size={8} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="relative">
          {/* Slash 命令菜单 */}
          {menuOpen && (
            <div
              className="absolute bottom-full left-0 right-0 z-30 mb-1.5 max-h-[300px] overflow-y-auto rounded-xl border border-line-strong bg-surface py-1 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.95)] animate-fade-up"
              role="listbox"
              aria-label="Slash 命令"
            >
              <div className="flex items-center gap-1 px-2.5 pb-1 pt-1 text-[9.5px] text-ink-4">
                <Command size={9} />
                命令
                <span className="ml-auto">↑↓ 选择 · Enter 补全 · Esc 关闭</span>
              </div>
              {slash.matches.map((command, index) => (
                <button
                  key={command.name}
                  role="option"
                  aria-selected={index === highlight}
                  className={cn(
                    'flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors',
                    index === highlight ? 'bg-accent/10' : 'hover:bg-surface-3',
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => selectCommand(command)}
                >
                  <span
                    className={cn(
                      'mono shrink-0 rounded border px-1 py-[1px] text-[10px]',
                      index === highlight
                        ? 'border-accent/40 bg-accent/12 text-accent-soft'
                        : 'border-line bg-bg-soft text-ink-3',
                    )}
                  >
                    {command.name}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11.5px] text-ink">{command.label}</span>
                    <span
                      className="block truncate text-[10px] text-ink-4"
                      title={command.argsHint ? `${command.description} · ${command.argsHint}` : command.description}
                    >
                      {command.argsHint ? `${command.description} · ${command.argsHint}` : command.description}
                    </span>
                  </span>
                  {index === highlight && <CornerDownLeft size={10} className="shrink-0 text-accent/70" />}
                </button>
              ))}
            </div>
          )}

          <div
            data-chat-composer
            className="rounded-xl border border-line-strong bg-bg-soft transition-colors focus-within:border-accent/55 focus-within:shadow-[0_0_0_3px_rgba(240,180,41,0.08)]"
          >
            <textarea
              ref={textareaRef}
              rows={3}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                canChat
                  ? '描述你想要的编曲或音频…例如「把这首编曲渲染成音频」「生成一首 cinematic 音频并分轨」'
                  : 'AI 暂不可用，先检查设置或启动后端'
              }
              className="block w-full resize-none overflow-y-auto bg-transparent px-3 pb-1 pt-3 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-4"
              style={{ minHeight: compact ? COMPACT_INPUT_HEIGHT : MIN_INPUT_HEIGHT, maxHeight: compact ? 120 : MAX_INPUT_HEIGHT }}
              aria-label="给 AI 的指令"
              spellCheck={false}
            />
            <div className="flex items-center gap-1 px-2 pb-2">
              <button
                className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[10px] text-ink-4 hover:bg-surface-3 hover:text-ink-2"
                title="插入 Slash 命令（/）：/audio 生成音频、/render MIDI→音频、/stems 分轨"
                aria-label="插入 Slash 命令"
                onClick={() => {
                  setDraft('/')
                  requestAnimationFrame(() => textareaRef.current?.focus())
                }}
              >
                <Command size={10} />
                {!narrow && <span>命令</span>}
              </button>
              <span className="min-w-0 truncate text-[10px] text-ink-4" title="Enter 发送 · Shift+Enter 换行">
                {narrow ? 'Enter 发送' : 'Enter 发送 · Shift+Enter 换行'}
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {aiBusy ? (
                  <>
                    <Button variant="danger" size="sm" onClick={stop} title="停止生成" aria-label="停止生成">
                      <Square size={10} className="mr-1 fill-current" />
                      停止
                    </Button>
                    <Button variant="accent" size="sm" disabled title="正在生成…" aria-label="正在生成">
                      <LoaderCircle size={10} className="mr-1 animate-spin" />
                      发送
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="accent"
                    size="sm"
                    onClick={() => handleSend(draft)}
                    disabled={!draft.trim() || backendState === 'offline'}
                    title="发送（Enter）"
                  >
                    <Send size={10} className="mr-1" />
                    发送
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 低频入口：旧版高级生成表单 / Companion 任务中心（从音频引擎菜单打开） */}
      {advancedOpen && <GenerateAudioPanel onClose={() => setAdvancedOpen(false)} />}
      {taskCenterOpen && <TaskCenterPanel onClose={() => setTaskCenterOpen(false)} />}
    </aside>
  )
}

/* ------------------------------------------------------------------ */
/* 空状态 / 提示条                                                      */
/* ------------------------------------------------------------------ */

function EmptyState({
  backendState,
  backendInfo,
  statusLabel,
  onSample,
  onOpenSettings,
}: {
  backendState: 'checking' | 'online' | 'offline'
  backendInfo: BackendInfo | null
  statusLabel: string
  onSample: (sample: SamplePrompt) => void
  onOpenSettings: () => void
}) {
  const ready = backendState === 'online' && Boolean(backendInfo?.configured) && backendInfo?.backendAvailable !== false
  return (
    <div className="flex flex-col items-center px-1 pb-4 pt-5 text-center">
      <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-accent/35 bg-gradient-to-b from-accent/22 to-accent/5 shadow-[0_18px_40px_-22px_rgba(240,180,41,0.75)]">
        <Sparkles size={22} className="text-accent" />
        <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border border-line bg-surface-2">
          <Music4 size={8} className="text-cyan" />
        </span>
      </div>
      <h2 className="mt-3 text-[14px] font-semibold tracking-tight">你的 AI 编曲搭档</h2>
      <p className="mt-1 max-w-[280px] text-[11.5px] leading-relaxed text-ink-3">
        直接用自然语言描述想要的效果。AI 会读取当前工程、调用编曲工具，把结果实时写回编辑器。
      </p>

      {/* 后端就绪状态 */}
      <button
        className={cn(
          'mt-3 flex max-w-full flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 rounded-full border px-2.5 py-1 text-[10.5px] transition-colors',
          ready
            ? 'border-success/30 bg-success/8 text-success hover:bg-success/12'
            : backendState === 'offline'
              ? 'border-danger/35 bg-danger/8 text-danger hover:bg-danger/12'
              : 'border-accent/35 bg-accent/8 text-accent-soft hover:bg-accent/14',
        )}
        onClick={onOpenSettings}
        title={ready ? 'AI 已就绪，点击查看设置' : '点击打开设置检查 AI 配置'}
      >
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            ready ? 'bg-success' : backendState === 'offline' ? 'bg-danger' : 'bg-accent',
          )}
        />
        <span className="whitespace-normal break-words text-center">{statusLabel}</span>
        {!ready && (
          <>
            <span className="h-2 w-px shrink-0 bg-current opacity-30" />
            <span className="shrink-0 underline decoration-dotted">去设置</span>
          </>
        )}
      </button>

      <div className="mt-4 w-full space-y-1.5 text-left">
        {SAMPLE_PROMPTS.map((sample) => (
          <button
            key={sample.title}
            className="group flex w-full items-center gap-2.5 rounded-xl border border-line bg-surface-2/60 px-2.5 py-2 text-left transition-colors hover:border-accent/40 hover:bg-surface-3"
            onClick={() => onSample(sample)}
            title={sample.prompt}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-bg-soft text-accent/80">
              {sample.intent === 'compose' ? (
                <Sparkles size={12} />
              ) : sample.intent === 'arrange' ? (
                <ListMusic size={12} />
              ) : sample.intent === 'audio' ? (
                <AudioWaveform size={12} />
              ) : (
                <Globe size={12} />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium text-ink">{sample.title}</span>
              <span className="mt-0.5 block truncate text-[10.5px] text-ink-4">{sample.description}</span>
            </span>
            <ArrowRight
              size={12}
              className="shrink-0 text-ink-4 transition-transform group-hover:translate-x-0.5 group-hover:text-accent"
            />
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap justify-center gap-1.5">
        {['读写工程', '生成音频', 'MIDI→音频', '分轨生成', '流式回答'].map((tag) => (
          <span key={tag} className="rounded-full border border-line bg-surface-2/60 px-2 py-[2px] text-[9.5px] text-ink-3">
            {tag}
          </span>
        ))}
      </div>
    </div>
  )
}

function Notice({
  tone,
  icon,
  title,
  description,
  actions,
}: {
  tone: 'accent' | 'danger'
  icon: React.ReactNode
  title: string
  description: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'rounded-lg border px-2.5 py-2',
        tone === 'danger' ? 'border-danger/35 bg-danger/8' : 'border-accent/30 bg-accent/8',
      )}
    >
      <div className="flex items-start gap-1.5">
        <span className={cn('mt-[1px] shrink-0', tone === 'danger' ? 'text-danger' : 'text-accent')}>{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[11.5px] font-medium text-ink">{title}</div>
          <div className="mt-0.5 text-[10.5px] leading-relaxed text-ink-3">{description}</div>
        </div>
      </div>
      {actions ? <div className="mt-1.5 flex items-center gap-1.5 pl-[18px]">{actions}</div> : null}
    </div>
  )
}
