/**
 * 底部状态栏。
 *
 * 状态栏在成熟 DAW 里不只是「显示信息」，而是「最常用的状态开关」：
 * 保存状态、输入设备、录入、吸附、选中对象、工具、撤销层数都应当可点、可验证。
 * 这里把原本的一排纯文本改成「可操作状态项 + 明确 tooltip」，并保持 26px 高度不喧宾夺主。
 */
import { useEffect, useState } from 'react'
import { CircleDot, Cpu, Gauge, Grid3x3, Keyboard, Magnet, Radio, Redo2, Search, Undo2, Usb, MousePointer2 } from 'lucide-react'
import { useStore } from '../../store/store'
import { getHealth, type HealthInfo } from '../../lib/api'
import { useUiStore } from '../../lib/uiStore'
import { cn } from '../../lib/format'
import { Kbd } from '../../components/ui/menu'
import { modSymbol } from '../../lib/shortcuts'

const SNAP_LABELS: Record<string, string> = {
  '4': '1/1',
  '2': '1/2',
  '1': '1/4',
  '0.5': '1/8',
  '0.25': '1/16',
  '0.125': '1/32',
  '0.666667': '1/4三连',
  '0.333333': '1/8三连',
  '0.166667': '1/16三连',
}

const SNAP_CYCLE = [0.25, 0.5, 1, 2, 4, 0.125]

function snapLabel(snap: number): string {
  const rounded = String(Math.round(snap * 1e6) / 1e6)
  return SNAP_LABELS[rounded] ?? `1/${Math.round(1 / snap)}`
}

export function StatusBar() {
  const project = useStore((s) => s.project)
  const saveStatus = useStore((s) => s.saveStatus)
  const lastSavedAt = useStore((s) => s.lastSavedAt)
  const midiDevices = useStore((s) => s.midiDevices)
  const midiActiveId = useStore((s) => s.midiActiveId)
  const midiRecord = useStore((s) => s.midiRecord)
  const setMidiRecord = useStore((s) => s.setMidiRecord)
  const view = useStore((s) => s.view)
  const selection = useStore((s) => s.selection)
  const snap = useStore((s) => s.snap)
  const setSnap = useStore((s) => s.setSnap)
  const soundfontStatus = useStore((s) => s.soundfontStatus)
  const aiBusy = useStore((s) => s.aiBusy)
  const pastLength = useStore((s) => s.past.length)
  const futureLength = useStore((s) => s.future.length)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const armedTrackId = useUiStore((s) => s.armedTrackId)
  const toolMode = useUiStore((s) => s.toolMode)
  const [health, setHealth] = useState<HealthInfo | null>(null)

  useEffect(() => {
    let alive = true
    getHealth()
      .then((info) => alive && setHealth(info))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const trackCount = project.tracks.length
  const noteCount = project.tracks.reduce(
    (sum, track) => sum + track.clips.reduce((n, clip) => n + clip.notes.length, 0),
    0,
  )
  const activeMidi = midiDevices.find((d) => d.id === midiActiveId)
  const armedTrack = project.tracks.find((track) => track.id === armedTrackId) ?? null
  const selectionTrack = project.tracks.find((track) => track.clips.some((clip) => clip.id === selection.clipId)) ?? null

  const saveLabel =
    saveStatus === 'saving'
      ? '保存中…'
      : saveStatus === 'error'
        ? '保存失败'
        : saveStatus === 'dirty'
          ? '未保存'
          : lastSavedAt
            ? `已保存 ${new Date(lastSavedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
            : '就绪'

  const cycleSnap = () => {
    const index = SNAP_CYCLE.findIndex((value) => Math.abs(value - snap) < 1e-6)
    const next = SNAP_CYCLE[(index + 1 + SNAP_CYCLE.length) % SNAP_CYCLE.length]
    setSnap(next)
    useStore.getState().pushToast('info', `吸附网格：${snapLabel(next)}`)
  }

  return (
    <footer className="flex h-[26px] shrink-0 items-center gap-2.5 overflow-hidden border-t border-line bg-surface px-3 text-[10px] text-ink-3">
      {/* 保存状态 */}
      <span
        className="flex items-center gap-1 whitespace-nowrap"
        title={saveStatus === 'dirty' ? '有未保存的修改（⌘S 保存）' : '自动保存已开启'}
      >
        <CircleDot
          size={9}
          className={cn(
            saveStatus === 'error' ? 'text-danger' : saveStatus === 'dirty' ? 'text-accent' : 'text-success',
          )}
        />
        {saveLabel}
      </span>

      <Divider />

      {/* 工程基础信息（点击打开设置） */}
      <button
        className="flex items-center gap-1 whitespace-nowrap rounded px-1 py-0.5 transition-colors hover:bg-surface-2 hover:text-ink-2"
        onClick={() => setSettingsOpen(true)}
        title="工程速度 / 拍号 / 调性（点击打开设置）"
      >
        <Gauge size={10} />
        <span className="shrink-0">{project.tempo} BPM</span>
        <span className="shrink-0">
          {' '}
          · {project.timeSignature.numerator}/{project.timeSignature.denominator}
        </span>
        <span className="hidden min-[1200px]:inline">
          {' '}
          · {project.key} {project.scale}
        </span>
      </button>

      <Divider />

      <span className="hidden shrink-0 items-center gap-1 whitespace-nowrap min-[1500px]:flex" title="工程规模">
        {trackCount} 轨 · {noteCount} 音
      </span>

      <Divider />

      {/* 输入设备 / 录入 */}
      <button
        className={cn(
          'flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1 py-0.5 transition-colors hover:bg-surface-2',
          activeMidi ? 'text-cyan' : 'text-ink-3',
        )}
        onClick={() => setSettingsOpen(true)}
        title={activeMidi ? `MIDI 输入：${activeMidi.name}` : '未选择 MIDI 输入设备（点击打开音频设置）'}
      >
        <Usb size={10} />
        <span className="hidden min-[1300px]:inline">{activeMidi ? activeMidi.name : midiDevices.length ? 'MIDI 未选择' : '无 MIDI 设备'}</span>
        <span className="sm:hidden">MIDI</span>
      </button>

      <button
        onClick={() => setMidiRecord(!midiRecord)}
        title={
          midiRecord
            ? 'MIDI 录入已开启：在钢琴卷帘中弹奏会写入当前片段（点击关闭）'
            : 'MIDI 录入：在钢琴卷帘中把弹奏写入当前片段'
        }
        aria-pressed={midiRecord}
        className={cn(
          'flex h-[17px] shrink-0 items-center gap-1 rounded-[5px] border px-1.5 text-[10px] transition-colors',
          midiRecord
            ? 'border-danger/50 bg-danger/15 text-danger'
            : 'border-line-strong bg-surface-2 text-ink-3 hover:text-ink-2',
        )}
      >
        <Radio size={9} className={midiRecord && view === 'pianoroll' ? 'animate-pulse' : undefined} />
        录入{midiRecord ? '开' : '关'}
      </button>

      {midiRecord && armedTrack && <span className="hidden text-ink-4 min-[1400px]:inline">→ {armedTrack.name}</span>}
      {midiRecord && view !== 'pianoroll' && <span className="hidden text-ink-4 lg:inline">（切到钢琴卷帘）</span>}
      {midiRecord && view === 'pianoroll' && !selection.clipId && (
        <span className="hidden text-ink-4 lg:inline">（选一个片段）</span>
      )}

      <Divider />

      {/* 吸附 / 工具 / 选中 */}
      <button
        className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1 py-0.5 transition-colors hover:bg-surface-2 hover:text-ink-2"
        onClick={cycleSnap}
        title="点击循环切换吸附网格"
      >
        <Magnet size={10} className={snap > 0 ? 'text-accent/80' : undefined} />
        吸附 {snap > 0 ? snapLabel(snap) : '关闭'}
      </button>

      <span className="hidden shrink-0 items-center gap-1 whitespace-nowrap text-ink-4 min-[1240px]:flex" title="当前编辑工具">
        <MousePointer2 size={10} />
        {toolMode === 'select' ? '选择' : toolMode === 'split' ? '切片' : '绘制'}
      </span>

      <span className="hidden shrink-0 items-center gap-1 whitespace-nowrap text-ink-4 min-[1240px]:flex" title="当前选中">
        <Grid3x3 size={10} />
        {selection.noteIds.length > 0
          ? `${selection.noteIds.length} 音符`
          : selection.clipId
            ? `${selectionTrack?.clips.find((clip) => clip.id === selection.clipId)?.name ?? '片段'}`
            : '未选中'}
      </span>

      <div className="flex-1" />

      {/* 撤销栈 */}
      <button
        className="hidden shrink-0 items-center gap-1 whitespace-nowrap rounded px-1 py-0.5 text-ink-4 transition-colors hover:bg-surface-2 hover:text-ink-2 min-[1180px]:flex"
        onClick={() => useStore.getState().undo()}
        disabled={pastLength === 0}
        title="撤销（⌘Z）"
      >
        <Undo2 size={10} />
        {pastLength}
      </button>
      <button
        className="hidden shrink-0 items-center gap-1 whitespace-nowrap rounded px-1 py-0.5 text-ink-4 transition-colors hover:bg-surface-2 hover:text-ink-2 min-[1180px]:flex"
        onClick={() => useStore.getState().redo()}
        disabled={futureLength === 0}
        title="重做（⌘⇧Z）"
      >
        <Redo2 size={10} />
        {futureLength}
      </button>

      {aiBusy && (
        <span className="flex shrink-0 items-center gap-1 text-accent">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          AI 正在工作…
        </span>
      )}

      <button
        className="hidden shrink-0 items-center gap-1 whitespace-nowrap rounded px-1 py-0.5 transition-colors hover:bg-surface-2 hover:text-ink-2 min-[1180px]:flex"
        onClick={() => setSettingsOpen(true)}
        title={soundfontStatus.loaded ? `采样音源：${soundfontStatus.name}` : '当前使用内置合成器'}
      >
        <Cpu size={10} className={soundfontStatus.loaded ? 'text-cyan' : undefined} />
        {soundfontStatus.loaded ? '采样音源' : '合成器'}
      </button>

      <button
        className="hidden shrink-0 items-center gap-1 whitespace-nowrap text-ink-4 transition-colors hover:text-ink-2 min-[1360px]:flex"
        onClick={() => window.dispatchEvent(new CustomEvent('aiab:command-palette'))}
        title="打开命令面板"
      >
        <Search size={10} />
        <Kbd>{modSymbol()}</Kbd>
        <Kbd>K</Kbd>
      </button>

      <span className="hidden text-ink-4 min-[1440px]:inline">v{health?.version ?? '0.1.0'}</span>

      <button
        className="flex shrink-0 items-center gap-1 text-ink-4 transition-colors hover:text-ink-2"
        onClick={() => useStore.getState().setHelpOpen(true)}
        title="快捷键与帮助（?）"
      >
        <Keyboard size={10} />
      </button>
    </footer>
  )
}

function Divider() {
  return <span className="h-3 w-px shrink-0 bg-line" />
}
