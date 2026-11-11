import { useEffect, useState } from 'react'
import {
  ChevronDown,
  FolderOpen,
  Save,
  Undo2,
  Redo2,
  Bot,
  PanelRightClose,
  PanelRightOpen,
  Search,
  FilePlus2,
  Music4,
  Sparkles,
} from 'lucide-react'
import { useStore } from '../../store/store'
import { cn } from '../../lib/format'
import { getHealth } from '../../lib/api'
import { ProjectMenu } from './ProjectMenu'
import { Kbd } from '../../components/ui/menu'
import { modSymbol } from '../../lib/shortcuts'

export function TopBar() {
  const project = useStore((s) => s.project)
  const setProjectName = useStore((s) => s.setProjectName)
  const saveStatus = useStore((s) => s.saveStatus)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  const canUndo = useStore((s) => s.past.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  const chatOpen = useStore((s) => s.chatOpen)
  const setChatOpen = useStore((s) => s.setChatOpen)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const aiBusy = useStore((s) => s.aiBusy)
  const [menuOpen, setMenuOpen] = useState(false)
  const [aiOnline, setAiOnline] = useState<boolean | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(project.name)

  useEffect(() => {
    getHealth()
      .then((info) => setAiOnline(Boolean(info.ok)))
      .catch(() => setAiOnline(false))
  }, [])

  useEffect(() => setDraft(project.name), [project.name])

  const commitName = () => {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== project.name) setProjectName(trimmed)
    else setDraft(project.name)
  }

  const saveLabel =
    saveStatus === 'saving' ? '保存中…' : saveStatus === 'dirty' ? '未保存' : saveStatus === 'error' ? '保存失败' : '已保存'

  return (
    <header className="relative z-30 flex h-[46px] shrink-0 items-center gap-2.5 border-b border-line bg-surface px-3">
      {/* Logo */}
      <div className="flex shrink-0 items-center gap-2.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-[9px] border border-accent/35 bg-gradient-to-b from-accent/25 to-accent/5">
          <Music4 size={14} className="text-accent" />
        </div>
        <div className="hidden leading-none sm:block">
          <div className="text-[12.5px] font-semibold tracking-tight">AI 编曲伴侣</div>
          <div className="mt-0.5 text-[9.5px] tracking-[0.16em] text-ink-4">ARRANGEMENT BUDDY</div>
        </div>
      </div>

      <span className="h-5 w-px shrink-0 bg-line" />

      {/* 工程菜单 */}
      <div className="relative shrink-0">
        <button
          className="btn btn-ghost h-7 px-2 text-[12px]"
          onClick={() => setMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <FolderOpen size={13} />
          文件
          <ChevronDown size={12} className={cn('text-ink-3 transition-transform', menuOpen && 'rotate-180')} />
        </button>
        {menuOpen && <ProjectMenu onClose={() => setMenuOpen(false)} />}
      </div>

      <button className="btn btn-ghost btn-icon shrink-0" title="撤销（⌘Z）" disabled={!canUndo} onClick={undo}>
        <Undo2 size={13} />
      </button>
      <button className="btn btn-ghost btn-icon shrink-0" title="重做（⌘⇧Z）" disabled={!canRedo} onClick={redo}>
        <Redo2 size={13} />
      </button>

      <span className="h-5 w-px shrink-0 bg-line" />

      {/* 工程名 + 保存状态 */}
      <div className="flex min-w-0 shrink items-center gap-2">
        {editing ? (
          <input
            autoFocus
            className="field h-7 w-52 text-[12.5px]"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitName()
              if (event.key === 'Escape') {
                setDraft(project.name)
                setEditing(false)
              }
            }}
            aria-label="工程名称"
          />
        ) : (
          <button
            className="max-w-[220px] truncate rounded-md px-1.5 py-1 text-[12.5px] font-medium hover:bg-surface-2"
            onDoubleClick={() => setEditing(true)}
            onClick={() => setEditing(true)}
            title="点击重命名工程"
          >
            {project.name}
          </button>
        )}
        <span
          className={cn(
            'hidden shrink-0 items-center gap-1 text-[10px] md:flex',
            saveStatus === 'error' ? 'text-danger' : saveStatus === 'dirty' ? 'text-accent/80' : 'text-ink-4',
          )}
          title={saveLabel}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              saveStatus === 'error'
                ? 'bg-danger'
                : saveStatus === 'dirty'
                  ? 'bg-accent'
                  : saveStatus === 'saving'
                    ? 'bg-ink-3 animate-pulse'
                    : 'bg-success/70',
            )}
          />
          {saveLabel}
        </span>
      </div>

      {/* 命令面板入口：把「能做什么」变成可搜索的一等入口 */}
      <button
        className="ml-2 hidden h-7 w-[230px] shrink-0 items-center gap-2 rounded-lg border border-line bg-bg-soft px-2 text-[11.5px] text-ink-4 transition-colors hover:border-line-strong hover:bg-surface-2 hover:text-ink-2 min-[1180px]:flex"
        onClick={() => window.dispatchEvent(new CustomEvent('aiab:command-palette'))}
        title="搜索并执行所有命令"
      >
        <Search size={12} className="shrink-0" />
        <span className="flex-1 text-left">搜索命令…</span>
        <span className="flex items-center gap-0.5">
          <Kbd>{modSymbol()}</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      <div className="flex-1" />

      {/* 新建 / 保存 */}
      <button
        className="btn btn-ghost h-7 shrink-0 gap-1.5 px-2 text-[11.5px]"
        onClick={() => window.dispatchEvent(new CustomEvent('aiab:open-new-project-wizard'))}
        title="新建工程（打开新建向导）"
      >
        <FilePlus2 size={13} />
        <span className="hidden xl:inline">新建</span>
      </button>
      <button
        className="btn h-7 shrink-0 gap-1.5 px-2.5 text-[11.5px]"
        onClick={() => window.dispatchEvent(new CustomEvent('aiab:save'))}
        title="保存工程（⌘S）"
      >
        <Save size={13} />
        <span className="hidden sm:inline">保存</span>
      </button>

      <span className="h-5 w-px shrink-0 bg-line" />

      {/* AI 对话面板开关 */}
      <button
        className={cn(
          'btn btn-ghost h-7 shrink-0 gap-1.5 px-2 text-[11.5px]',
          chatOpen && 'border-accent/40 bg-accent/10 text-accent-soft',
        )}
        onClick={() => setChatOpen(!chatOpen)}
        title={chatOpen ? '收起 AI 对话面板（⌘J）' : '展开 AI 对话面板（⌘J）'}
        aria-pressed={chatOpen}
      >
        {chatOpen ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />}
        AI 助手
      </button>

      {/* AI 后端状态 */}
      <button
        className={cn(
          'flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-[10.5px]',
          aiOnline === false
            ? 'border-danger/40 bg-danger/8 text-danger'
            : 'border-line-strong bg-surface-2 text-ink-2',
        )}
        title={
          aiOnline === false
            ? '后端未连接，点击查看设置与启动方式'
            : aiOnline === null
              ? '正在检查后端连接…'
              : '后端已连接，点击打开 AI 对话面板'
        }
        onClick={() => {
          if (aiOnline === false) setSettingsOpen(true)
          else setChatOpen(true)
        }}
      >
        {aiBusy ? <Sparkles size={12} className="animate-pulse text-accent" /> : <Bot size={12} />}
        <span className="hidden sm:inline">{aiOnline === false ? 'AI 离线' : aiBusy ? 'AI 工作中' : 'AI 就绪'}</span>
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            aiOnline === false ? 'bg-danger' : aiOnline === null ? 'bg-ink-4' : 'bg-success',
          )}
          style={{ animation: 'pulse-dot 2.4s ease-in-out infinite' }}
        />
      </button>
    </header>
  )
}
