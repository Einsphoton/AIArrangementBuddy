import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  Upload,
  Wand2,
  Waves,
} from 'lucide-react'
import { composeProject, createEmptyProject, jianpuToProject, newId, type StyleId } from '@aiab/core'
import {
  ApiError,
  getProject,
  importMidiFile,
  listProjects,
  saveProject,
  uploadAudioAsset,
  type ProjectSummary,
} from '../../lib/api'
import { useStore } from '../../store/store'
import { cn, formatRelativeTime } from '../../lib/format'
import { audioFileBaseName, placeAudioClip } from '../audio/audioTrack'
import { primeAssetPeaks } from '../audio/peaks'
import { tidy } from '../arrangement/timeline'
import { NewProjectWizard } from './NewProjectWizard'

type Panel = 'root' | 'open' | 'saveas' | 'new'

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
  { style: 'jrock', name: '日摇 · 双吉他推进', description: '双吉他 + 16 分贝斯 · 172 BPM · 16 小节', accent: '#ff2e63' },
  { style: 'jrpg', name: 'JRPG · 战斗配乐', description: '管弦 + 失真吉他 · 144 BPM · 16 小节', accent: '#c9a227' },
]

/** 文件菜单：新建 / 打开 / 保存 / 另存为 / 示例工程。 */
export function ProjectMenu({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)
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
  /* P7-D：导入简谱 */
  const [jianpuOpen, setJianpuOpen] = useState(false)
  const [jianpuText, setJianpuText] = useState('')
  const [jianpuError, setJianpuError] = useState<string | null>(null)
  const [importingMidi, setImportingMidi] = useState(false)
  const [importingAudio, setImportingAudio] = useState(false)

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

  /** P7-D：导入简谱文本 → 单条旋律轨工程（客户端解析，替换当前工程） */
  const importJianpu = () => {
    setJianpuError(null)
    const text = jianpuText.trim()
    if (!text) {
      setJianpuError('先粘贴简谱文本（例如 1 1 5 5 | 6 6 5 -）')
      return
    }
    try {
      const result = jianpuToProject(text)
      setProject(result.project, { resetHistory: true })
      bumpProjectListVersion()
      setJianpuOpen(false)
      setJianpuText('')
      pushToast('success', result.summary)
      if (result.parse.warnings.length > 0) {
        pushToast('info', `简谱有 ${result.parse.warnings.length} 条警告：${result.parse.warnings[0]}`)
      }
      onClose()
    } catch (error) {
      setJianpuError(error instanceof Error ? error.message : '简谱解析失败')
    }
  }

  /** 导入 MIDI：读 ArrayBuffer 后按 octet-stream 上传，成功用后端解析出的工程替换当前工程 */
  const importMidi = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // 清空 value，允许连续选择同一个文件
    event.target.value = ''
    if (!file) return
    if (!/\.(mid|midi)$/i.test(file.name)) {
      pushToast('error', '请选择 .mid 或 .midi 文件')
      return
    }
    setImportingMidi(true)
    try {
      const buffer = await file.arrayBuffer()
      const result = await importMidiFile(buffer)
      const imported = result?.project
      if (!imported || !Array.isArray(imported.tracks) || imported.tracks.length === 0) {
        throw new Error('解析结果里没有轨道')
      }
      setProject(imported, { resetHistory: true })
      bumpProjectListVersion()
      pushToast('success', result.summary || `已导入 MIDI：${imported.name}`)
      onClose()
    } catch (error) {
      const detail =
        error instanceof ApiError
          ? error.status === 404
            ? '导入接口未就绪（404），请确认后端已更新并重启'
            : error.detail || error.message
          : error instanceof Error
            ? error.message
            : '未知错误'
      pushToast('error', `MIDI 导入失败：${detail}`)
    } finally {
      setImportingMidi(false)
    }
  }

  /**
   * 导入音频（WAV）：上传 → 服务端算峰值 → **一次 mutate** 落一条音频轨 + 一个 AudioClip。
   * 片段落在播放头所在拍；拍长按当前工程 BPM 换算（一期 stretchRatio 固定 1）。
   */
  const importAudio = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!/\.wav$/i.test(file.name)) {
      pushToast('error', '请选择 .wav 音频文件（当前只支持 WAV）')
      return
    }
    setImportingAudio(true)
    try {
      const result = await uploadAudioAsset(file)
      if (!result?.asset?.id) throw new Error('上传结果里没有资产信息')
      /* 上传接口已带回 peaks：直接预热缓存，波形不用二次请求 */
      primeAssetPeaks(result.asset.id, {
        id: result.asset.id,
        durationSec: result.durationSec,
        sampleRate: result.sampleRate,
        channels: result.channels,
        peaks: result.peaks,
      })
      const name = audioFileBaseName(file.name)
      const store = useStore.getState()
      const startBeat = tidy(Math.max(0, store.playhead))
      const placedRef: { value: { trackId: string; clipId: string } | null } = { value: null }
      store.mutate((draft) => {
        placedRef.value = placeAudioClip(draft, {
          asset: result.asset,
          durationSec: result.durationSec,
          name,
          startBeat,
          trackName: `音频 · ${name}`,
        })
      })
      const placed = placedRef.value
      if (placed) {
        store.selectTrack(placed.trackId)
        store.setView('arrangement')
      }
      pushToast(
        'success',
        result.summary
          ? `已导入音频：${result.summary}（⌘Z 可撤销）`
          : `已导入音频「${name}」：${result.durationSec.toFixed(2)}s（⌘Z 可撤销）`,
      )
      onClose()
    } catch (error) {
      const detail =
        error instanceof ApiError
          ? error.status === 404
            ? '上传接口未就绪（404），请确认后端已更新并重启'
            : error.detail || error.message
          : error instanceof Error
            ? error.message
            : '未知错误'
      pushToast('error', `音频导入失败：${detail}`)
    } finally {
      setImportingAudio(false)
    }
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
    <>
      {/* 新建向导：portal 到 body 的独立模态框。
          放在顶栏里会被主编辑区的层叠上下文（时间轴工具条）盖住，且 292px 下拉宽度装不下 9 个风格。 */}
      {panel === 'new' &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-black/65 p-4 pt-[7vh]"
            role="dialog"
            aria-modal="true"
            aria-label="新建工程"
            onClick={onClose}
          >
            <div
              className="w-full max-w-[760px] overflow-hidden rounded-xl border border-line-strong bg-surface-2 shadow-[0_32px_80px_-24px_rgba(0,0,0,0.9)]"
              onClick={(event) => event.stopPropagation()}
            >
              <NewProjectWizard onDone={onClose} onBack={() => setPanel('root')} />
            </div>
          </div>,
          document.body,
        )}

      {jianpuOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-black/65 p-4 pt-[8vh]"
            role="dialog"
            aria-modal="true"
            aria-label="导入简谱"
            onClick={() => setJianpuOpen(false)}
          >
            <div
              data-jianpu-panel
              className="w-full max-w-[560px] overflow-hidden rounded-xl border border-line-strong bg-surface-2 shadow-[0_32px_80px_-24px_rgba(0,0,0,0.9)]"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
                <div>
                  <h2 className="text-[13px] font-semibold">导入简谱</h2>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-ink-4">
                    支持 <code>1=C</code> / <code>4/4</code> / <code>♩=120</code> 头信息；音符 1–7（0 休止），
                    <code>'</code>/<code>,</code> 八度，<code>/</code> 减半（<code>1/</code> 八分），
                    <code>.</code> 附点，<code>-</code> 延长，<code>~</code> 连音，<code>|</code> 小节线。
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon h-6 w-6"
                  aria-label="关闭简谱导入"
                  onClick={() => setJianpuOpen(false)}
                >
                  ×
                </button>
              </div>
              <div className="px-4 py-3">
                <textarea
                  aria-label="简谱文本"
                  data-jianpu-text
                  value={jianpuText}
                  onChange={(event) => setJianpuText(event.target.value)}
                  rows={7}
                  spellCheck={false}
                  placeholder={'1=C\n4/4\n♩=120\n1 1 5 5 | 6 6 5 - | 4 4 3 3 | 2 2 1 - |'}
                  className="field w-full resize-y font-mono text-[11px] leading-relaxed"
                />
                {jianpuError && (
                  <p className="mt-1.5 rounded border border-danger/30 bg-danger/8 px-2 py-1 text-[10px] text-danger">{jianpuError}</p>
                )}
                <div className="mt-2 flex items-center justify-end gap-1.5">
                  <button type="button" className="btn btn-ghost h-7 px-2.5 text-[11px]" data-jianpu-cancel onClick={() => setJianpuOpen(false)}>
                    取消
                  </button>
                  <button type="button" className="btn btn-primary h-7 px-3 text-[11px]" data-jianpu-submit onClick={() => importJianpu()}>
                    导入并替换工程
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}

      <div
        ref={ref}
        className={cn(
          'absolute left-0 top-9 z-50 w-[292px] overflow-hidden rounded-xl border border-line-strong bg-surface-2 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.85)]',
          panel === 'new' && 'hidden',
        )}
        role="menu"
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".mid,.midi"
          className="hidden"
          aria-hidden
          tabIndex={-1}
          onChange={(event) => void importMidi(event)}
        />
        <input
          ref={audioInputRef}
          type="file"
          accept=".wav,audio/wav,audio/x-wav"
          className="hidden"
          aria-hidden
          tabIndex={-1}
          onChange={(event) => void importAudio(event)}
        />

        {panel === 'root' && (
        <div className="p-1">
          <MenuItem
            icon={<Wand2 size={12} />}
            label="新建工程…"
            hint="风格 / 用途"
            trailing={<ChevronRight size={11} className="text-ink-4" />}
            onClick={() => openPanel('new')}
          />
          <MenuItem icon={<FilePlus2 size={12} />} label="新建空白工程" onClick={newProject} />
          <MenuItem
            icon={importingMidi ? <LoaderCircle size={12} className="animate-spin" /> : <Upload size={12} />}
            label={importingMidi ? '正在导入 MIDI…' : '导入 MIDI…'}
            disabled={importingMidi}
            onClick={() => fileInputRef.current?.click()}
          />
          <MenuItem
            icon={importingAudio ? <LoaderCircle size={12} className="animate-spin" /> : <Waves size={12} />}
            label={importingAudio ? '正在导入音频…' : '导入音频…'}
            hint="WAV"
            disabled={importingAudio}
            dataImportAudio
            onClick={() => audioInputRef.current?.click()}
          />
          <MenuItem
            icon={<Music4 size={12} />}
            label="导入简谱…"
            hint="123"
            dataImportJianpu
            onClick={() => {
              setJianpuError(null)
              setJianpuOpen(true)
            }}
          />
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
    </>
  )
}

function MenuItem({
  icon,
  label,
  hint,
  trailing,
  disabled,
  dataImportAudio,
  dataImportJianpu,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  hint?: string
  trailing?: React.ReactNode
  disabled?: boolean
  /** 验收标记：文件菜单里的「导入音频…」入口 */
  dataImportAudio?: boolean
  /** 验收标记：文件菜单里的「导入简谱…」入口 */
  dataImportJianpu?: boolean
  onClick: () => void
}) {
  return (
    <button
      data-import-audio={dataImportAudio ? '' : undefined}
      data-import-jianpu={dataImportJianpu ? '' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2 py-[7px] text-left text-[11.5px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink',
        disabled && 'pointer-events-none opacity-50',
      )}
      onClick={onClick}
      role="menuitem"
      disabled={disabled}
    >
      <span className="shrink-0 text-ink-3">{icon}</span>
      <span className="flex-1">{label}</span>
      {hint && <span className="mono shrink-0 text-[9.5px] text-ink-4">{hint}</span>}
      {trailing}
    </button>
  )
}
