import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ChevronRight,
  FilePlus2,
  FolderOpen,
  LoaderCircle,
  Music4,
  RefreshCw,
  Save,
  SaveAll,
  TriangleAlert,
} from 'lucide-react'
import { composeProject, createEmptyProject, newId, type StyleId } from '@aiab/core'
import { ApiError, getProject, listProjects, saveProject, type ProjectSummary } from '../../lib/api'
import { useStore } from '../../store/store'
import { cn, formatRelativeTime } from '../../lib/format'

type Panel = 'root' | 'open' | 'saveas'

interface ExampleItem {
  style: StyleId
  name: string
  description: string
  accent: string
}

const EXAMPLES: ExampleItem[] = [
  { style: 'classical', name: '古典 · 弦乐小品', description: '弦乐编制 · 92 BPM · 16 小节', accent: '#d4a95c' },
  { style: 'rock', name: '摇滚 · 强力推进', description: '电吉他 + 鼓组 · 124 BPM · 16 小节', accent: '#e0562a' },
  { style: 'electronic', name: '电子 · 合成器律动', description: '合成器层次 · 124 BPM · 16 小节', accent: '#3ddbd9' },
]

/** 文件菜单：新建 / 打开 / 保存 / 另存为 / 示例工程。 */
export function ProjectMenu({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const project = useStore((s) => s.project)
  const setProject = useStore((s) => s.setProject)
  const setSaveStatus = useStore((s) => s.setSaveStatus)
  const bumpProjectListVersion = useStore((s) => s.bumpProjectListVersion)
  const pushToast = useStore((s) => s.pushToast)

  const [panel, setPanel] = useState<Panel>('root')
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [saveAsName, setSaveAsName] = useState(`${project.name} 副本`)
  const [savingAs, setSavingAs] = useState(false)
  const [creating, setCreating] = useState<string | null>(null)

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', handler)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('mousedown', handler)
      window.removeEventListener('keydown', escape)
    }
  }, [onClose])

  const loadProjects = useCallback(async () => {
    setListLoading(true)
    setListError(null)
    try {
      const list = await listProjects()
      setProjects(list.sort((a, b) => b.updatedAt - a.updatedAt))
    } catch (error) {
      setProjects(null)
      const offline =
        (error instanceof ApiError && error.status >= 500) ||
        (error instanceof Error && /fetch|network|load failed|请求失败（5/i.test(error.message))
      setListError(
        offline
          ? '后端未连接，无法读取工程列表。请先运行 pnpm dev。'
          : (error as Error).message || '读取工程列表失败',
      )
    } finally {
      setListLoading(false)
    }
  }, [])

  const openPanel = (next: Panel) => {
    setPanel(next)
    if (next === 'open') void loadProjects()
    if (next === 'saveas') setSaveAsName(`${project.name} 副本`)
  }

  const newProject = () => {
    const fresh = createEmptyProject({ name: '未命名工程', style: 'pop', tempo: 110, key: 'C', scale: 'major' })
    setProject(fresh, { resetHistory: true })
    bumpProjectListVersion()
    pushToast('success', '已新建空白工程')
    onClose()
  }

  const openProject = async (id: string) => {
    setLoadingId(id)
    try {
      const remote = await getProject(id)
      if (!remote?.tracks) throw new Error('工程数据无效')
      setProject(remote, { resetHistory: true, dirty: false })
      setSaveStatus('saved')
      bumpProjectListVersion()
      pushToast('success', `已打开：${remote.name}`)
      onClose()
    } catch (error) {
      pushToast(
        'error',
        `打开失败：${error instanceof Error ? error.message : '未知错误'}`,
      )
    } finally {
      setLoadingId(null)
    }
  }

  const save = () => {
    window.dispatchEvent(new CustomEvent('aiab:save'))
    onClose()
  }

  const saveAs = async () => {
    const name = saveAsName.trim() || `${project.name} 副本`
    setSavingAs(true)
    try {
      const copy = { ...project, id: newId('p'), name, createdAt: Date.now(), updatedAt: Date.now() }
      await saveProject(copy)
      setProject(copy, { resetHistory: true, dirty: false })
      setSaveStatus('saved')
      bumpProjectListVersion()
      pushToast('success', `已另存为：${name}`)
      onClose()
    } catch (error) {
      pushToast('error', `另存失败：${error instanceof Error ? error.message : '请确认后端已启动'}`)
    } finally {
      setSavingAs(false)
    }
  }

  const loadExample = (example: ExampleItem) => {
    setCreating(example.style)
    try {
      const fresh = composeProject({
        style: example.style,
        bars: 16,
        name: example.name,
        seed: Math.floor(Math.random() * 100000),
      })
      setProject(fresh, { resetHistory: true })
      bumpProjectListVersion()
      pushToast('success', `已生成示例：${example.name}`)
      onClose()
    } catch (error) {
      console.warn('[project-menu] 生成示例工程失败', error)
      pushToast('error', '示例工程生成失败，请稍后重试')
    } finally {
      setCreating(null)
    }
  }

  return (
    <div
      ref={ref}
      className="absolute left-0 top-9 z-50 w-[292px] overflow-hidden rounded-xl border border-line-strong bg-surface-2 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.85)]"
      role="menu"
    >
      {panel === 'root' && (
        <div className="p-1">
          <MenuItem icon={<FilePlus2 size={12} />} label="新建空白工程" onClick={newProject} />
          <MenuItem
            icon={<FolderOpen size={12} />}
            label="打开工程…"
            trailing={<ChevronRight size={11} className="text-ink-4" />}
            onClick={() => openPanel('open')}
          />
          <MenuItem icon={<Save size={12} />} label="保存" hint="⌘S" onClick={save} />
          <MenuItem
            icon={<SaveAll size={12} />}
            label="另存为副本…"
            onClick={() => openPanel('saveas')}
          />

          <div className="my-1 h-px bg-line" />
          <div className="px-2 py-1 text-[9.5px] font-semibold tracking-[0.12em] text-ink-4">示例工程</div>
          {EXAMPLES.map((example) => (
            <button
              key={example.style}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-3 disabled:opacity-50"
              onClick={() => loadExample(example)}
              disabled={creating !== null}
              title={`生成示例：${example.name}`}
            >
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border"
                style={{
                  borderColor: `${example.accent}55`,
                  background: `${example.accent}18`,
                  color: example.accent,
                }}
              >
                {creating === example.style ? <LoaderCircle size={11} className="animate-spin" /> : <Music4 size={11} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11.5px] font-medium text-ink">{example.name}</span>
                <span className="block truncate text-[9.5px] text-ink-4">{example.description}</span>
              </span>
            </button>
          ))}

          <div className="mt-1 border-t border-line px-2 py-1.5 text-[9.5px] leading-relaxed text-ink-4">
            示例由本地生成器创建，可直接编辑或让 AI 继续加工。
          </div>
        </div>
      )}

      {panel === 'open' && (
        <div className="flex max-h-[420px] flex-col">
          <div className="flex items-center gap-1.5 border-b border-line px-2 py-1.5">
            <button
              className="btn btn-ghost btn-icon h-6 w-6"
              onClick={() => setPanel('root')}
              title="返回"
              aria-label="返回"
            >
              <ArrowLeft size={11} />
            </button>
            <span className="text-[11.5px] font-medium text-ink">打开工程</span>
            <button
              className="btn btn-ghost btn-icon ml-auto h-6 w-6"
              onClick={() => void loadProjects()}
              title="刷新列表"
              aria-label="刷新列表"
              disabled={listLoading}
            >
              <RefreshCw size={10} className={listLoading ? 'animate-spin' : undefined} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {listLoading && projects === null ? (
              <div className="flex items-center justify-center gap-2 py-8 text-[11px] text-ink-3">
                <LoaderCircle size={12} className="animate-spin" />
                正在读取工程列表…
              </div>
            ) : listError ? (
              <div className="px-2 py-4">
                <div className="flex items-start gap-1.5 rounded-lg border border-danger/35 bg-danger/8 px-2 py-1.5">
                  <TriangleAlert size={11} className="mt-[1px] shrink-0 text-danger" />
                  <div className="min-w-0 flex-1 text-[10.5px] leading-relaxed text-ink-2">{listError}</div>
                </div>
                <button className="btn mt-2 h-7 w-full text-[11px]" onClick={() => void loadProjects()}>
                  重试
                </button>
              </div>
            ) : !projects || projects.length === 0 ? (
              <div className="px-3 py-8 text-center text-[11px] leading-relaxed text-ink-3">
                还没有保存过的工程。
                <br />
                编辑后会自动保存到本机。
              </div>
            ) : (
              projects.map((item) => (
                <button
                  key={item.id}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-3 disabled:opacity-50"
                  onClick={() => void openProject(item.id)}
                  disabled={loadingId !== null}
                  title={item.name}
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line-strong bg-bg-soft text-ink-3">
                    {loadingId === item.id ? (
                      <LoaderCircle size={11} className="animate-spin" />
                    ) : (
                      <FolderOpen size={11} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11.5px] font-medium text-ink">{item.name}</span>
                    <span className="block truncate text-[9.5px] text-ink-4">
                      {item.trackCount} 轨 · {item.tempo} BPM · {formatRelativeTime(item.updatedAt)}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {panel === 'saveas' && (
        <div className="p-2">
          <div className="mb-1.5 flex items-center gap-1.5">
            <button
              className="btn btn-ghost btn-icon h-6 w-6"
              onClick={() => setPanel('root')}
              title="返回"
              aria-label="返回"
            >
              <ArrowLeft size={11} />
            </button>
            <span className="text-[11.5px] font-medium text-ink">另存为副本</span>
          </div>
          <input
            autoFocus
            className="field text-[12px]"
            value={saveAsName}
            onChange={(event) => setSaveAsName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void saveAs()
            }}
            placeholder="新工程名称"
            aria-label="新工程名称"
          />
          <p className="mt-1 text-[9.5px] leading-relaxed text-ink-4">
            会创建一个新工程并立即保存到本机，原工程保持不变。
          </p>
          <div className="mt-2 flex items-center gap-1.5">
            <button className="btn h-7 flex-1 text-[11px]" onClick={() => setPanel('root')} disabled={savingAs}>
              取消
            </button>
            <button
              className="btn btn-accent h-7 flex-1 text-[11px]"
              onClick={() => void saveAs()}
              disabled={savingAs}
            >
              {savingAs ? <LoaderCircle size={10} className="mr-1 animate-spin" /> : null}
              保存副本
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function MenuItem({
  icon,
  label,
  hint,
  trailing,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  hint?: string
  trailing?: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2 py-[7px] text-left text-[11.5px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink',
      )}
      onClick={onClick}
      role="menuitem"
    >
      <span className="shrink-0 text-ink-3">{icon}</span>
      <span className="flex-1">{label}</span>
      {hint && <span className="mono shrink-0 text-[9.5px] text-ink-4">{hint}</span>}
      {trailing}
    </button>
  )
}
