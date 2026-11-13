import React, { useEffect, useMemo, useState } from 'react'
import { Boxes, CircleHelp, Download, Mic2, Piano, Search, Settings2, Sparkles, Waves } from 'lucide-react'
import { getAudioEngine } from './audio'
import { useStore } from './store/store'
import { TransportBar } from './features/transport/TransportBar'
import { TrackPanel } from './features/tracks/TrackPanel'
import { ArrangementView } from './features/arrangement/ArrangementView'
import { PianoRollView } from './features/pianoroll/PianoRollView'
import { SmartClipPanel } from './features/smartclips/SmartClipPanel'
import { ChatPanel } from './features/chat/ChatPanel'
import { SettingsModal } from './features/settings/SettingsModal'
import { ExportDialog } from './features/export/ExportDialog'
import { HelpOverlay } from './features/help/HelpOverlay'
import { WelcomeOverlay, shouldAutoWelcome } from './features/help/WelcomeOverlay'
import { CommandPalette } from './features/command/CommandPalette'
import { StatusBar } from './features/status/StatusBar'
import { ToastHost } from './components/ToastHost'
import { TopBar } from './features/topbar/TopBar'
import { NewProjectWizardDialog } from './features/topbar/NewProjectWizard'
import { ProvisionButton } from './features/audio/ProvisionButton'
import { MixerPanel } from './features/tracks/MixerPanel'
import { cn } from './lib/format'
import { useProjectSession } from './lib/session'
import { useMidiPerformance } from './features/midi/useMidiPerformance'
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts'
import { useUiStore, CHAT_WIDTH_LIMITS } from './lib/uiStore'
import { detectAudioIntent, handleAudioPlanFromToolData, retryAudioJob, runAudioPlan } from './features/audio/audioIntent'
import { bounceTrackToAudio } from './features/audio/bounceTrack'
import { useAudioJobStore } from './features/audio/audioJobStore'

const VIEW_TABS = [
  { id: 'arrangement' as const, label: '编曲', icon: <Boxes size={13} />, shortcut: '1' },
  { id: 'pianoroll' as const, label: '钢琴卷帘', icon: <Piano size={13} />, shortcut: '2' },
  { id: 'smartclips' as const, label: '智能片段', icon: <Sparkles size={13} />, shortcut: '3' },
]

export default function App() {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const chatOpen = useStore((s) => s.chatOpen)
  const showMixer = useStore((s) => s.showMixer)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setExportOpen = useStore((s) => s.setExportOpen)
  const setHelpOpen = useStore((s) => s.setHelpOpen)
  const project = useStore((s) => s.project)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const setPlaying = useStore((s) => s.setPlaying)
  const [needsAudio, setNeedsAudio] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [welcomeOpen, setWelcomeOpen] = useState(false)
  /** 顶栏/命令面板的「新建工程」统一打开向导（菜单关闭时也能用） */
  const [wizardOpen, setWizardOpen] = useState(false)
  const chatCollapsed = useUiStore((s) => s.chatCollapsed)
  const chatWidth = useUiStore((s) => s.chatWidth)
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1680 : window.innerWidth,
  )
  const setChatWidth = useUiStore((s) => s.setChatWidth)
  const engine = useMemo(() => getAudioEngine(), [])

  // 工程加载 / 自动保存 / 新建工程事件
  useProjectSession()

  // MIDI 键盘：实时演奏（MIDI Thru）+ 钢琴卷帘录入
  useMidiPerformance()

  // 全局快捷键（只接管跨视图命令，见 hooks/useGlobalShortcuts.ts）
  useGlobalShortcuts()

  /* 命令面板 / 首次引导 / 新建工程向导的全局入口：工具栏、帮助页、命令都通过事件唤起 */
  useEffect(() => {
    const openPalette = () => setPaletteOpen(true)
    const openWelcome = () => setWelcomeOpen(true)
    const openWizard = () => setWizardOpen(true)
    window.addEventListener('aiab:command-palette', openPalette)
    window.addEventListener('aiab:welcome', openWelcome)
    window.addEventListener('aiab:open-new-project-wizard', openWizard)
    return () => {
      window.removeEventListener('aiab:command-palette', openPalette)
      window.removeEventListener('aiab:welcome', openWelcome)
      window.removeEventListener('aiab:open-new-project-wizard', openWizard)
    }
  }, [])

  /* 首次使用引导：默认只在真实用户环境自动出现一次（自动化环境自动跳过） */
  useEffect(() => {
    if (!shouldAutoWelcome()) return
    const timer = setTimeout(() => setWelcomeOpen(true), 700)
    return () => clearTimeout(timer)
  }, [])

  /* 视口自适应：窄屏时收紧 AI 面板，保证编辑区至少 ~540px 可用 */
  useEffect(() => {
    let frame = 0
    const onResize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setViewportWidth(window.innerWidth))
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  const effectiveChatWidth = chatCollapsed
    ? 56
    : Math.max(300, Math.min(chatWidth, viewportWidth < 1200 ? 312 : viewportWidth < 1400 ? 344 : chatWidth))

  /* AI 面板宽度拖拽 */
  const startChatResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = chatWidth
    const onMove = (moveEvent: PointerEvent) => {
      const next = Math.min(
        CHAT_WIDTH_LIMITS.max,
        Math.max(CHAT_WIDTH_LIMITS.min, startWidth + (startX - moveEvent.clientX)),
      )
      setChatWidth(next)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // 调试/截图参数：?view=pianoroll|arrangement|smartclips&chat=0
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const viewParam = params.get('view')
    if (viewParam === 'pianoroll' || viewParam === 'smartclips' || viewParam === 'arrangement') {
      useStore.getState().setView(viewParam)
    }
    if (params.get('chat') === '0') useStore.getState().setChatOpen(false)
    if (params.get('mixer') === '1') useStore.getState().setShowMixer(true)
    const panel = params.get('panel')
    if (panel === 'settings') useStore.getState().setSettingsOpen(true)
    if (panel === 'export') useStore.getState().setExportOpen(true)
    if (panel === 'help') useStore.getState().setHelpOpen(true)
    if (panel === 'palette') setPaletteOpen(true)
    if (panel === 'welcome' || params.get('intro') === '1') setWelcomeOpen(true)
    if (panel === 'new-project' || panel === 'wizard') setWizardOpen(true)
  }, [])

  /* 调试句柄：window.AIAB（仅本机应用，方便排查问题与自动化验收） */
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).AIAB = {
      useStore,
      useUiStore,
      engine,
      /** 音频任务卡状态：自动化验收/截图用（可注入 running/blocked/done 等状态） */
      useAudioJobStore,
      audio: { detectAudioIntent, runAudioPlan, retryAudioJob, handleAudioPlanFromToolData, bounceTrack: bounceTrackToAudio },
    }
  }, [engine])

  /* 走带 -> store 同步 */
  useEffect(() => {
    const offPlayhead = engine.onPlayhead((beat) => setPlayhead(beat))
    return () => {
      offPlayhead()
    }
  }, [engine, setPlayhead])

  /* 工程变化时同步到引擎 */
  useEffect(() => {
    if (!engine.ready) return
    engine.applyProject(project)
    engine.setMasterVolume(project.masterVolume)
  }, [engine, project])

  /* 音频初始化：挂载即尝试（headless/已授权浏览器可直接就绪），失败则等用户手势 */
  useEffect(() => {
    let cancelled = false
    const init = async () => {
      try {
        await engine.init()
        // 初始化完成后再同步一次工程：引擎就绪前 applyProject 会被跳过，
        // 不同步的话轨道节点不存在，试听 / MIDI 只能走兜底音色（与轨道音色不一致）
        if (!cancelled) {
          const live = useStore.getState().project
          engine.applyProject(live)
          engine.setMasterVolume(live.masterVolume)
        }
        if (!cancelled) setNeedsAudio(false)
      } catch {
        if (!cancelled) setNeedsAudio(true)
      } finally {
        if (!cancelled) useStore.getState().setReady(true)
      }
    }
    void init()
    const onFirstGesture = () => {
      void init().then(() => setNeedsAudio(false))
      window.removeEventListener('pointerdown', onFirstGesture)
      window.removeEventListener('keydown', onFirstGesture)
    }
    window.addEventListener('pointerdown', onFirstGesture, { once: true })
    window.addEventListener('keydown', onFirstGesture, { once: true })
    return () => {
      cancelled = true
      window.removeEventListener('pointerdown', onFirstGesture)
      window.removeEventListener('keydown', onFirstGesture)
    }
  }, [engine])

  /* 全局快捷键 */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      const store = useStore.getState()
      const meta = event.metaKey || event.ctrlKey

      if (meta && event.key.toLowerCase() === 'z') {
        if (typing) return
        event.preventDefault()
        if (event.shiftKey) store.redo()
        else store.undo()
        return
      }
      if (meta && event.key.toLowerCase() === 's') {
        event.preventDefault()
        window.dispatchEvent(new CustomEvent('aiab:save'))
        return
      }
      if (typing) return
      if (event.code === 'Space') {
        event.preventDefault()
        if (store.isPlaying) {
          engine.pause()
          store.setPlaying(false)
        } else {
          void engine
            .play(store.project, { fromBeat: store.playhead, loop: store.loopEnabled ? store.project.loop : null })
            .then(() => store.setPlaying(true))
        }
        return
      }
      if (event.key === '1') store.setView('arrangement')
      if (event.key === '2') store.setView('pianoroll')
      if (event.key === '3') store.setView('smartclips')
      if (event.key === '?') store.setHelpOpen(true)
      if (event.key === 'Escape') {
        store.setHelpOpen(false)
        store.setSettingsOpen(false)
        store.setExportOpen(false)
        setPaletteOpen(false)
        setWelcomeOpen(false)
        setWizardOpen(false)
        store.clearSelection()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [engine])

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg text-ink">
      {/* 顶部：工程信息 + 工具栏 */}
      <TopBar />

      {/* 走带控制 */}
      <TransportBar />

      {/* 主体 */}
      <div className="flex min-h-0 flex-1">
        {/* 左：轨道 */}
        <TrackPanel />

        {/* 中：编辑区 */}
        <main className="relative flex min-w-0 flex-1 flex-col bg-bg-soft">
          <div className="flex h-[38px] min-w-0 shrink-0 items-center justify-between gap-2 border-b border-line px-2.5">
            <div className="flex min-w-0 items-center gap-0.5">
              {VIEW_TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setView(tab.id)}
                  className={cn(
                    'relative flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[12px] font-medium transition-colors',
                    view === tab.id
                      ? 'bg-surface-3 text-ink'
                      : 'text-ink-3 hover:bg-surface-2 hover:text-ink-2',
                  )}
                  title={`${tab.label}（${tab.shortcut}）`}
                  aria-pressed={view === tab.id}
                >
                  {tab.icon}
                  <span className="max-[1180px]:hidden">{tab.label}</span>
                  {view === tab.id && (
                    <span className="absolute inset-x-2 -bottom-[5px] h-[2px] rounded-full bg-accent/80" />
                  )}
                </button>
              ))}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                className={cn('btn btn-ghost btn-icon', showMixer && 'bg-surface-3 text-accent')}
                title="混音器（⌘⇧M）"
                aria-pressed={showMixer}
                onClick={() => useStore.getState().setShowMixer(!showMixer)}
              >
                <Waves size={14} />
              </button>
              <button className="btn btn-ghost btn-icon max-[1160px]:hidden" title="音频与 MIDI 设置" onClick={() => setSettingsOpen(true)}>
                <Mic2 size={14} />
              </button>
              <button className="btn btn-ghost btn-icon max-[1080px]:hidden" title="导出（⌘⇧E）" onClick={() => setExportOpen(true)}>
                <Download size={14} />
              </button>
              <button className="btn btn-ghost btn-icon" title="设置（⌘,）" onClick={() => setSettingsOpen(true)}>
                <Settings2 size={14} />
              </button>
              <button className="btn btn-ghost btn-icon max-[1000px]:hidden" title="命令面板（⌘K）" onClick={() => window.dispatchEvent(new CustomEvent('aiab:command-palette'))}>
                <Search size={14} />
              </button>
              <button className="btn btn-ghost btn-icon" title="快捷键与帮助（?）" onClick={() => setHelpOpen(true)}>
                <CircleHelp size={14} />
              </button>
            </div>
          </div>

          <div className="relative min-h-0 flex-1">
            {view === 'arrangement' && <ArrangementView />}
            {view === 'pianoroll' && <PianoRollView />}
            {view === 'smartclips' && <SmartClipPanel />}
          </div>

          {needsAudio && (
            <div className="pointer-events-none absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-full border border-accent/30 bg-surface-2/95 px-3.5 py-1.5 text-[11px] text-ink-2 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.9)] backdrop-blur">
              <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent align-middle" />
              点击任意位置以启用声音
            </div>
          )}
        </main>

        {/* 右：AI 助手（宽度可拖拽 / 可收成侧边条） */}
        {chatOpen && (
          <div
            className="relative flex shrink-0"
            style={{ width: effectiveChatWidth }}
          >
            {!chatCollapsed && (
              <div
                className="group absolute inset-y-0 -left-[2px] z-40 w-[4px] cursor-col-resize"
                onPointerDown={startChatResize}
                title="拖动调整 AI 面板宽度"
                role="separator"
                aria-orientation="vertical"
                aria-label="调整 AI 面板宽度"
              >
                <span className="absolute inset-y-0 left-[1px] w-[2px] rounded-full bg-transparent transition-colors group-hover:bg-accent/50" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <ChatPanel />
            </div>
          </div>
        )}
      </div>

      {/* 混音器：全宽底栏（与 Logic/Studio One 一致，横跨轨道/编辑/AI 面板） */}
      {showMixer && <MixerPanel />}

      <StatusBar />

      <SettingsModal />
      <ExportDialog />
      <HelpOverlay />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <WelcomeOverlay
        open={welcomeOpen}
        onClose={() => setWelcomeOpen(false)}
        onOpenHelp={() => useStore.getState().setHelpOpen(true)}
      />
      {/* 新建工程向导：顶栏/命令面板统一入口（ProjectMenu 内部仍可独立打开同一个组件） */}
      <NewProjectWizardDialog open={wizardOpen} onClose={() => setWizardOpen(false)} />
      {/* 全局下载对话框宿主：AI 音频意图缺模型时通过 aiab:provision-open 自动唤起 */}
      <ProvisionButton mode="global" />
      <ToastHost />
    </div>
  )
}
