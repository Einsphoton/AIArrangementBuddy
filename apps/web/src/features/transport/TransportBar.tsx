import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  ChevronLeft,
  CircleDot,
  Crosshair,
  Gauge,
  ListMusic,
  Mic2,
  Pause,
  Play,
  Repeat,
  Square,
  Timer,
  Volume2,
} from 'lucide-react'
import { KEYS, SCALES, TIME_SIGNATURES, type ScaleId } from '@aiab/core'
import { getAudioEngine } from '../../audio'
import { IconButton, Select, Slider } from '../../components/ui'
import { subscribeEditorCommand } from '../../lib/editorBus'
import { cn, formatClock } from '../../lib/format'
import { useUiStore } from '../../lib/uiStore'
import { useStore } from '../../store/store'
import { clamp, formatBarBeatTick } from '../arrangement/timeline'
import { gainToDbText, levelToDbText } from '../tracks/controls'
import {
  rewindTransport as rewind,
  stopAllTransport as stopAll,
  togglePlayTransport as togglePlay,
} from './transportActions'

/* 走带动作（播放/暂停/停止/跳转）统一在 transportActions.ts 实现：
   界面按钮与 AI 的 ui 事件共用同一条真实路径（音频引擎 + store）。 */

/* ------------------------------------------------------------------ */
/* 分组分隔线                                                          */
/* ------------------------------------------------------------------ */

function GroupDivider() {
  return <span className="vdivider my-2.5 shrink-0" />
}

/**
 * 当前视口宽度：窄屏（<1680）走带条改两行，避免隐藏横向溢出。
 * 用 rAF 节流 resize，只在宽度变化时触发一次重渲染。
 */
function useViewportWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1920 : window.innerWidth))
  useEffect(() => {
    let raf = 0
    const onResize = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setWidth(window.innerWidth))
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [])
  return width
}

/* ------------------------------------------------------------------ */
/* 录音（MIDI 录入）按钮                                               */
/* ------------------------------------------------------------------ */

function RecordButton() {
  const midiRecord = useStore((s) => s.midiRecord)
  const view = useStore((s) => s.view)
  const armedTrackId = useUiStore((s) => s.armedTrackId)
  const armedName = useStore((s) =>
    armedTrackId ? (s.project.tracks.find((track) => track.id === armedTrackId)?.name ?? null) : null,
  )
  const prevView = useRef(view)

  /* 从录音状态切走视图：录入状态保持，但明确提示 */
  useEffect(() => {
    if (midiRecord && view !== 'pianoroll' && prevView.current === 'pianoroll') {
      useStore.getState().pushToast('info', 'MIDI 录入仍在开启：切回钢琴卷帘并选中片段后才会写入音符')
    }
    prevView.current = view
  }, [view, midiRecord])

  const toggle = () => {
    const store = useStore.getState()
    const next = !store.midiRecord
    store.setMidiRecord(next)
    if (!next) {
      store.pushToast('info', 'MIDI 录入已关闭')
      return
    }
    if (store.view !== 'pianoroll') {
      store.pushToast('info', 'MIDI 录入已开启（不是音频录音）：切到钢琴卷帘并选中片段后生效')
    } else if (!store.selection.clipId) {
      store.pushToast('info', 'MIDI 录入已开启：请先在钢琴卷帘选中一个片段')
    } else {
      store.pushToast('success', `MIDI 录入已开启${armedName ? `：已预备「${armedName}」` : ''}`)
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        onClick={toggle}
        aria-pressed={midiRecord}
        aria-label={midiRecord ? '关闭 MIDI 录入' : '开启 MIDI 录入'}
        data-midi-record={midiRecord ? 'on' : 'off'}
        title={
          midiRecord
            ? 'MIDI 录入（R）：开启中——这不是音频录音。在钢琴卷帘中把 MIDI 键盘弹奏写进当前片段'
            : 'MIDI 录入（R）：在钢琴卷帘中把 MIDI 键盘弹奏写进当前片段（不是音频录音）'
        }
        className={cn(
          'relative flex h-[34px] w-[42px] items-center justify-center rounded-[9px] border transition-all',
          midiRecord
            ? 'border-danger/70 bg-danger/20 shadow-[0_0_18px_-8px_rgba(240,86,59,0.95)]'
            : 'border-line-strong bg-surface-2 hover:border-danger/45 hover:bg-surface-3',
        )}
      >
        <span
          className={cn(
            'h-[11px] w-[11px] rounded-full transition-all',
            midiRecord ? 'animate-pulse bg-danger shadow-[0_0_10px_rgba(240,86,59,0.95)]' : 'bg-danger/55',
          )}
        />
      </button>
      {midiRecord && (
        <span className="hidden shrink-0 items-center gap-1.5 min-[1440px]:flex" aria-live="polite">
          <span className="rounded-[4px] border border-danger/40 bg-danger/10 px-1.5 py-[2px] text-[9.5px] font-semibold text-danger">
            MIDI 录入
          </span>
          {armedName && (
            <span className="max-w-[92px] truncate text-[9.5px] text-ink-3" title={`已预备轨道：${armedName}`}>
              预备：{armedName}
            </span>
          )}
          {view !== 'pianoroll' && <span className="text-[9.5px] text-accent/85">需在钢琴卷帘生效</span>}
        </span>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Tap Tempo                                                           */
/* ------------------------------------------------------------------ */

function TapTempoButton() {
  const patchProject = useStore((s) => s.patchProject)
  const pushHistory = useStore((s) => s.pushHistory)
  const [active, setActive] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const tapsRef = useRef<number[]>([])
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionHistory = useRef(false)

  const showHint = (text: string | null) => {
    setHint(text)
    if (hintTimer.current) clearTimeout(hintTimer.current)
    if (text) hintTimer.current = setTimeout(() => setHint(null), 1800)
  }

  const tap = useCallback(() => {
    const now = performance.now()
    const taps = tapsRef.current
    const last = taps[taps.length - 1]

    setActive(true)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setActive(false), 150)

    // 间隔过短：双击 / 误触 => 重置
    if (last != null && now - last < 250) {
      tapsRef.current = []
      sessionHistory.current = false
      showHint('已重置')
      return
    }
    // 间隔过长：上一轮已结束，重新开始
    if (last != null && now - last > 2000) {
      tapsRef.current = []
      sessionHistory.current = false
    }
    tapsRef.current.push(now)
    if (tapsRef.current.length > 9) tapsRef.current.shift()

    if (tapsRef.current.length < 2) {
      showHint('继续点击')
      return
    }
    const list = tapsRef.current
    let sum = 0
    for (let i = 1; i < list.length; i += 1) sum += list[i] - list[i - 1]
    const average = sum / (list.length - 1)
    const bpm = clamp(Math.round(60000 / average), 20, 320)
    if (!sessionHistory.current) {
      pushHistory()
      sessionHistory.current = true
    }
    patchProject({ tempo: bpm }, { history: false })
    useStore.getState().setSaveStatus('dirty')
    showHint(`${bpm} BPM`)
  }, [patchProject, pushHistory])

  const reset = () => {
    tapsRef.current = []
    sessionHistory.current = false
    showHint('已重置')
  }

  /* 命令面板 / 命令注册表触发的 tap-tempo 走同一条逻辑 */
  useEffect(
    () =>
      subscribeEditorCommand((payload) => {
        if (payload.action === 'tap-tempo') tap()
      }),
    [tap],
  )

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current)
      if (hintTimer.current) clearTimeout(hintTimer.current)
    },
    [],
  )

  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={tap}
        onDoubleClick={(event) => {
          event.preventDefault()
          reset()
        }}
        aria-label="Tap Tempo 测速"
        data-tap-tempo=""
        title="Tap Tempo：连续点击 2 次以上测速（间隔 250–2000ms）；间隔过短或双击 = 重置"
        className={cn(
          'mono flex h-[34px] shrink-0 items-center gap-1 rounded-[9px] border px-2 text-[10px] font-semibold tracking-[0.08em] transition-all',
          active
            ? 'scale-[0.97] border-accent/70 bg-accent/25 text-accent-soft'
            : 'border-line-strong bg-bg-soft text-ink-3 hover:border-accent/40 hover:text-ink',
        )}
      >
        <Activity size={12} className={active ? 'text-accent' : 'text-ink-3'} />
        TAP
      </button>
      {hint && (
        <span className="mono shrink-0 whitespace-nowrap text-[9.5px] tabular-nums text-accent" aria-live="polite">
          {hint}
        </span>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 时间码（独立订阅播放头，避免整条走带每帧重渲染）                     */
/* ------------------------------------------------------------------ */

function Timecode() {
  const playhead = useStore((s) => s.playhead)
  const playing = useStore((s) => s.isPlaying)
  const tempo = useStore((s) => s.project.tempo)
  const timeSignature = useStore((s) => s.project.timeSignature)
  const [mode, setMode] = useState<'bars' | 'time'>('bars')
  const seconds = (playhead / Math.max(1, tempo)) * 60
  const bars = formatBarBeatTick(playhead, timeSignature)
  const clock = formatClock(seconds)

  return (
    <button
      type="button"
      onClick={() => setMode((current) => (current === 'bars' ? 'time' : 'bars'))}
      aria-label="时间显示：点击切换 小节·拍·嗒 / 分:秒"
      data-time-mode={mode}
      title={
        mode === 'bars'
          ? '当前位置：小节 · 拍 · 嗒（点击切换为分:秒）'
          : '当前位置：分:秒（点击切换为小节 · 拍 · 嗒）'
      }
      className="flex h-[34px] shrink-0 items-center gap-1.5 rounded-[9px] border border-line-strong bg-bg-soft px-2 transition-colors hover:border-[#3b4557]"
    >
      <CircleDot
        size={11}
        className={cn('shrink-0 transition-colors', playing ? 'animate-pulse text-accent' : 'text-ink-4')}
      />
      <span className="mono w-[114px] shrink-0 whitespace-nowrap text-left text-[13.5px] font-medium text-ink tabular-nums">
        {mode === 'bars' ? bars : clock}
      </span>
      <span className="mono hidden w-[88px] whitespace-nowrap text-left text-[9.5px] tabular-nums text-ink-3 min-[1740px]:inline">
        {mode === 'bars' ? clock : bars}
      </span>
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* 主电平表                                                            */
/* ------------------------------------------------------------------ */

const METER_SEGMENTS = 22

function MasterMeter() {
  const fillRef = useRef<HTMLDivElement>(null)
  const peakRef = useRef<HTMLDivElement>(null)
  const dbRef = useRef<HTMLSpanElement>(null)
  const levelRef = useRef(0)
  const displayRef = useRef(0)
  const peakValueRef = useRef(0)
  const peakHoldRef = useRef(0)

  useEffect(() => {
    const engine = getAudioEngine()
    let offLevel: (() => void) | undefined
    try {
      offLevel = engine.onLevel((level) => {
        if (Number.isFinite(level)) levelRef.current = Math.max(levelRef.current, clamp(level, 0, 1))
      })
    } catch {
      /* 引擎未就绪时退化为轮询 */
    }

    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(64, now - last)
      last = now
      let level = levelRef.current
      levelRef.current = 0
      if (level <= 0) {
        try {
          level = engine.getMeterLevel() || 0
        } catch {
          level = 0
        }
      }
      const target = clamp(level, 0, 1)
      // 上升快、回落慢，接近真实 VU 表手感
      displayRef.current = target > displayRef.current ? target : Math.max(target, displayRef.current - dt * 0.0016)
      const shown = displayRef.current
      if (shown >= peakValueRef.current) {
        peakValueRef.current = shown
        peakHoldRef.current = now
      } else if (now - peakHoldRef.current > 900) {
        peakValueRef.current = Math.max(shown, peakValueRef.current - dt * 0.0009)
      }
      if (fillRef.current) fillRef.current.style.width = `${(shown * 100).toFixed(1)}%`
      if (peakRef.current) {
        peakRef.current.style.left = `${Math.min(99.5, peakValueRef.current * 100).toFixed(1)}%`
        peakRef.current.style.opacity = peakValueRef.current > 0.01 ? '1' : '0'
      }
      if (dbRef.current) dbRef.current.textContent = levelToDbText(shown, 0)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      offLevel?.()
    }
  }, [])

  const resetPeak = () => {
    peakValueRef.current = 0
    peakHoldRef.current = performance.now()
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={resetPeak}
        aria-label="主输出电平表（点击重置峰值）"
        title="主输出电平（峰值保持）；点击重置峰值"
        className="relative h-[9px] w-[72px] overflow-hidden rounded-[3px] border border-line bg-bg"
      >
        <div
          ref={fillRef}
          className="absolute inset-y-0 left-0 w-0 rounded-[2px]"
          style={{
            background: 'linear-gradient(90deg, #34d399 0%, #a3e635 52%, #f0b429 78%, #f0563b 100%)',
            boxShadow: '0 0 10px -2px rgba(240,180,41,0.7)',
          }}
        />
        <div ref={peakRef} className="absolute inset-y-0 w-[1.5px] bg-white/85 opacity-0" style={{ left: '0%' }} />
        <div className="pointer-events-none absolute inset-0 flex justify-between px-[1px]">
          {Array.from({ length: METER_SEGMENTS }).map((_, index) => (
            <span key={index} className="h-full w-px bg-black/45" />
          ))}
        </div>
      </button>
      <span
        ref={dbRef}
        data-master-db=""
        aria-label="主输出电平（dB）"
        className="mono w-[28px] text-right text-[9.5px] tabular-nums text-ink-3"
        title="主输出电平读数（dB，-60…0 dB；limiter 上限 -1 dB）"
      >
        -∞
      </span>
      <span className="hidden text-[9px] text-ink-4 xl:block">OUT</span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 速度控制（拖拽 / 双击输入）                                          */
/* ------------------------------------------------------------------ */

function TempoControl() {
  const tempo = useStore((s) => s.project.tempo)
  const patchProject = useStore((s) => s.patchProject)
  const pushHistory = useStore((s) => s.pushHistory)
  const setSaveStatus = useStore((s) => s.setSaveStatus)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(tempo))
  const dragRef = useRef<{ y: number; value: number; dragging: boolean } | null>(null)

  useEffect(() => {
    const parsed = Number(draft)
    if (!editing && parsed !== tempo) setDraft(String(tempo))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tempo, editing])

  const apply = (value: number) => {
    const next = clamp(Math.round(value), 20, 320)
    setDraft(String(next))
    if (next !== useStore.getState().project.tempo) patchProject({ tempo: next }, { history: false })
  }

  const commitDraft = () => {
    setEditing(false)
    const parsed = Number(draft)
    if (Number.isFinite(parsed)) apply(parsed)
    else setDraft(String(tempo))
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (editing || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { y: event.clientY, value: tempo, dragging: false }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const deltaY = drag.y - event.clientY
    if (!drag.dragging) {
      if (Math.abs(deltaY) < 2) return
      drag.dragging = true
      pushHistory()
      setSaveStatus('dirty')
    }
    const step = event.shiftKey ? 8 : 2
    apply(drag.value + deltaY / step)
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    dragRef.current = null
  }

  return (
    <div
      className={cn(
        'flex h-[34px] min-w-[96px] shrink-0 cursor-ns-resize items-center gap-1.5 rounded-[9px] border border-line-strong bg-bg-soft px-2 transition-colors hover:border-[#3b4557]',
        editing && 'border-accent/60',
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => {
        setDraft(String(tempo))
        setEditing(true)
      }}
      title="上下拖动调整速度，双击直接输入（Shift 精调）"
    >
      <Gauge size={12} className="shrink-0 text-ink-3" />
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitDraft()
            if (event.key === 'Escape') {
              setEditing(false)
              setDraft(String(tempo))
            }
          }}
          className="mono w-[38px] bg-transparent text-[13.5px] outline-none"
          aria-label="速度 BPM"
        />
      ) : (
        <span className="mono w-[38px] text-[13.5px] tabular-nums">{tempo}</span>
      )}
      <span className="text-[9px] font-semibold tracking-wider text-ink-4">BPM</span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 循环区间                                                            */
/* ------------------------------------------------------------------ */

function LoopRange() {
  const loop = useStore((s) => s.project.loop)
  const setLoopRange = useStore((s) => s.setLoopRange)
  const loopEnabled = useStore((s) => s.loopEnabled)
  const timeSignature = useStore((s) => s.project.timeSignature)
  const barBeats = (timeSignature.numerator * 4) / timeSignature.denominator
  const startBar = Math.floor(loop.startBeat / barBeats) + 1
  const endBar = Math.max(startBar + 1, Math.ceil(loop.endBeat / barBeats))

  const commit = (start: number, end: number) => {
    const safeStart = clamp(start, 1, 998)
    const safeEnd = clamp(end, safeStart + 1, 999)
    setLoopRange((safeStart - 1) * barBeats, safeEnd * barBeats)
    useStore.getState().setSaveStatus('dirty')
  }

  return (
    <div
      className={cn(
        'flex h-[34px] shrink-0 items-center gap-1 rounded-[9px] border bg-bg-soft px-2 transition-colors',
        loopEnabled ? 'border-accent/45' : 'border-line-strong',
      )}
      title="循环区间（单位：小节）"
    >
      <Repeat size={12} className={loopEnabled ? 'text-accent' : 'text-ink-3'} />
      <BarInput value={startBar} onChange={(value) => commit(value, endBar)} label="循环起始小节" />
      <span className="text-[10px] text-ink-4">–</span>
      <BarInput value={endBar} onChange={(value) => commit(startBar, value)} label="循环结束小节" />
      <span className="text-[9px] text-ink-4">小节</span>
    </div>
  )
}

function BarInput({ value, onChange, label }: { value: number; onChange: (value: number) => void; label: string }) {
  const [draft, setDraft] = useState(String(value))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(String(value))
  }, [value])
  return (
    <input
      aria-label={label}
      value={draft}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false
        const parsed = Number(draft)
        if (Number.isFinite(parsed) && parsed > 0) onChange(parsed)
        else setDraft(String(value))
      }}
      onChange={(event) => setDraft(event.target.value.replace(/[^\d]/g, ''))}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
        if (event.key === 'ArrowUp') onChange(value + 1)
        if (event.key === 'ArrowDown') onChange(Math.max(1, value - 1))
      }}
      className="mono w-[26px] rounded bg-transparent px-0.5 text-center text-[12px] tabular-nums outline-none hover:bg-surface-2 focus:bg-surface-2"
    />
  )
}

/* ------------------------------------------------------------------ */
/* MIDI 输入                                                           */
/* ------------------------------------------------------------------ */

function MidiInputControl() {
  const midiDevices = useStore((s) => s.midiDevices)
  const midiActiveId = useStore((s) => s.midiActiveId)
  const setMidiDevices = useStore((s) => s.setMidiDevices)
  const setMidiActiveId = useStore((s) => s.setMidiActiveId)
  const [detecting, setDetecting] = useState(false)

  useEffect(() => {
    const engine = getAudioEngine()
    try {
      const midi = engine.midi
      if (!midi?.supported) return undefined
      const off = midi.onDevicesChanged((devices) => {
        useStore.getState().setMidiDevices(
          devices.map((device) => ({ id: device.id, name: device.name })),
          midi.activeId,
        )
      })
      if (midi.devices.length > 0) {
        setMidiDevices(
          midi.devices.map((device) => ({ id: device.id, name: device.name })),
          midi.activeId,
        )
      }
      return off
    } catch {
      return undefined
    }
  }, [setMidiDevices])

  const detect = async () => {
    const engine = getAudioEngine()
    setDetecting(true)
    try {
      await engine.init()
      const devices = await engine.midi.refresh()
      setMidiDevices(devices.map((device) => ({ id: device.id, name: device.name })), engine.midi.activeId)
      useStore
        .getState()
        .pushToast(
          devices.length ? 'success' : 'info',
          devices.length ? `已连接 ${devices.length} 个 MIDI 设备` : '没有检测到 MIDI 设备',
        )
    } catch (error) {
      console.warn('[transport] MIDI 检测失败', error)
      useStore.getState().pushToast('error', 'MIDI 检测失败：浏览器未授权或设备未连接')
    } finally {
      setDetecting(false)
    }
  }

  const select = (id: string) => {
    try {
      getAudioEngine().midi.select(id || null)
    } catch {
      /* ignore */
    }
    setMidiActiveId(id || null)
  }

  if (midiDevices.length === 0) {
    return (
      <button
        className="btn btn-ghost h-[30px] shrink-0 gap-1.5 px-2 text-[11.5px]"
        onClick={() => void detect()}
        disabled={detecting}
        title="检测 Web MIDI 输入设备（USB 键盘）"
      >
        <Mic2 size={13} className={detecting ? 'animate-pulse text-accent' : 'text-ink-3'} />
        <span className="hidden xl:inline">{detecting ? '检测中…' : 'MIDI 输入'}</span>
      </button>
    )
  }

  const active = midiDevices.find((device) => device.id === midiActiveId)
  return (
    <div className="flex shrink-0 items-center gap-1" title={active ? `MIDI 输入：${active.name}` : '选择 MIDI 输入设备'}>
      <Mic2 size={13} className={active ? 'text-cyan' : 'text-ink-3'} />
      <Select
        ariaLabel="MIDI 输入设备"
        value={midiActiveId ?? ''}
        onChange={select}
        className="h-[30px] w-[126px] shrink-0 text-[11.5px]"
        options={[
          { value: '', label: '不使用 MIDI' },
          ...midiDevices.map((device) => ({ value: device.id, label: device.name })),
        ]}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 跟随播放头                                                          */
/* ------------------------------------------------------------------ */

function FollowToggle() {
  const followPlayhead = useUiStore((s) => s.followPlayhead)
  const toggleFollowPlayhead = useUiStore((s) => s.toggleFollowPlayhead)

  return (
    <button
      type="button"
      onClick={toggleFollowPlayhead}
      aria-pressed={followPlayhead}
      aria-label={followPlayhead ? '关闭跟随播放头' : '开启跟随播放头'}
      data-follow={followPlayhead ? 'on' : 'off'}
      title={`跟随播放头（F）：${followPlayhead ? '开' : '关'}——编曲与钢琴卷帘共用同一状态`}
      className={cn(
        'flex h-[34px] shrink-0 items-center gap-1.5 rounded-[9px] border px-2 text-[10.5px] font-medium transition-colors',
        followPlayhead
          ? 'border-accent/55 bg-accent/12 text-accent-soft'
          : 'border-line-strong bg-bg-soft text-ink-3 hover:text-ink',
      )}
    >
      <Crosshair size={13} />
      <span>跟随</span>
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full transition-colors',
          followPlayhead ? 'bg-accent shadow-[0_0_8px_rgba(240,180,41,0.9)]' : 'bg-ink-4/60',
        )}
      />
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* 主输出                                                              */
/* ------------------------------------------------------------------ */

function MasterSection() {
  const masterVolume = useStore((s) => s.project.masterVolume)
  const setMasterVolume = useStore((s) => s.setMasterVolume)

  return (
    <div className="flex shrink-0 items-center gap-2" role="group" aria-label="主输出">
      <Volume2 size={14} className="shrink-0 text-ink-3" />
      <Slider
        ariaLabel="主音量"
        value={masterVolume}
        min={0}
        max={1.5}
        step={0.01}
        onChange={(value) => setMasterVolume(value)}
        onCommit={() => useStore.getState().setSaveStatus('dirty')}
        className="w-[78px]"
      />
      <span
        className="mono w-[42px] shrink-0 text-right text-[10.5px] tabular-nums text-ink-2"
        title="主音量增益（dB）"
      >
        {gainToDbText(masterVolume)}
        <span className="ml-0.5 text-[8.5px] text-ink-4">dB</span>
      </span>
      <MasterMeter />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 走带控制条                                                          */
/* ------------------------------------------------------------------ */

export function TransportBar() {
  const isPlaying = useStore((s) => s.isPlaying)
  const loopEnabled = useStore((s) => s.loopEnabled)
  const metronome = useStore((s) => s.metronome)
  const countIn = useStore((s) => s.countIn)
  const project = useStore((s) => s.project)
  const setLoopEnabled = useStore((s) => s.setLoopEnabled)
  const setMetronome = useStore((s) => s.setMetronome)
  const setCountIn = useStore((s) => s.setCountIn)
  const setKeyScale = useStore((s) => s.setKeyScale)
  const setTimeSignature = useStore((s) => s.setTimeSignature)
  const engine = useMemo(() => getAudioEngine(), [])

  /* 节拍器开关同步到引擎 */
  useEffect(() => {
    try {
      engine.setMetronome(metronome)
    } catch {
      /* 引擎未就绪时忽略 */
    }
  }, [engine, metronome])

  /* 走带快捷键：L 循环 / M 节拍器 / ⌘⏎ 回到开头。
     录音(R)、跟随(F) 等全局快捷键由 lib/commands + shortcuts 统一接管，这里不重复绑定。 */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const store = useStore.getState()
      const target = event.target as HTMLElement | null
      const typing = Boolean(
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable),
      )
      if (typing) return
      if (store.settingsOpen || store.helpOpen || store.exportOpen) return
      const meta = event.metaKey || event.ctrlKey
      if (meta && event.key === 'Enter') {
        event.preventDefault()
        rewind()
        return
      }
      if (meta) return
      if (event.key === 'l' || event.key === 'L') {
        event.preventDefault()
        store.setLoopEnabled(!store.loopEnabled)
      } else if (event.key === 'm' || event.key === 'M') {
        event.preventDefault()
        store.setMetronome(!store.metronome)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const timeSignatureOptions = TIME_SIGNATURES.map((id) => ({ value: id, label: id.replace('/', ' / ') }))
  const currentTimeSignature = `${project.timeSignature.numerator}/${project.timeSignature.denominator}`
  const keyOptions = KEYS.map((key) => ({ value: key, label: key }))
  const scaleOptions = Object.values(SCALES).map((scale) => ({ value: scale.id, label: scale.name }))
  const viewportWidth = useViewportWidth()
  const compact = viewportWidth < 1680

  /* 窄屏（<1680）改两行：第一行保留全部关键项，第二行放次要设置 */
  const transportGroup = (
    <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="播放控制">
      <IconButton title="回到开头（⌘⏎）" onClick={rewind}>
        <ChevronLeft size={16} />
      </IconButton>
      <button
        onClick={() => void togglePlay()}
        className={cn(
          'flex h-[34px] w-[42px] items-center justify-center rounded-[9px] border transition-all',
          isPlaying
            ? 'border-accent/60 bg-accent/18 text-accent shadow-[0_0_18px_-8px_rgba(240,180,41,0.9)]'
            : 'border-line-strong bg-surface-2 text-ink hover:border-accent/40 hover:bg-surface-3',
        )}
        title={isPlaying ? '暂停（空格）' : '播放（空格）'}
        aria-label={isPlaying ? '暂停' : '播放'}
        aria-pressed={isPlaying}
      >
        {isPlaying ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
      </button>
      <IconButton title="停止" onClick={stopAll}>
        <Square size={13} />
      </IconButton>
      <RecordButton />
    </div>
  )

  const loopGroup = (
    <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="循环与节拍">
      <ToggleButton
        active={loopEnabled}
        title="循环开关（L）"
        onClick={() => {
          setLoopEnabled(!loopEnabled)
          useStore.getState().setSaveStatus('dirty')
        }}
      >
        <Repeat size={14} />
      </ToggleButton>
      <ToggleButton active={metronome} title="节拍器（M）" onClick={() => setMetronome(!metronome)}>
        <Timer size={14} />
      </ToggleButton>
      <ToggleButton
        active={countIn}
        title="预备拍：播放前 1 小节（可在 ⌘K 命令面板切换）"
        onClick={() => setCountIn(!countIn)}
      >
        <ListMusic size={14} />
      </ToggleButton>
    </div>
  )

  const signatureGroup = (
    <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label="拍号与调性">
      <Select
        ariaLabel="拍号"
        value={currentTimeSignature}
        onChange={(value) => {
          const [numerator, denominator] = value.split('/').map((part) => Number(part))
          setTimeSignature({ numerator: numerator || 4, denominator: denominator || 4 })
        }}
        className="h-[30px] w-[68px] shrink-0 text-[11.5px]"
        options={timeSignatureOptions}
      />
      <Select
        ariaLabel="调性"
        value={project.key}
        onChange={(value) => setKeyScale(value, project.scale as ScaleId)}
        className="h-[30px] w-[62px] shrink-0 text-[11.5px]"
        options={[
          ...KEYS.map((key) => ({ value: key, label: `${key} 调` })),
          ...((KEYS as readonly string[]).includes(project.key)
            ? []
            : [{ value: project.key, label: `${project.key} 调` }]),
        ]}
      />
      <Select
        ariaLabel="调式"
        value={project.scale}
        onChange={(value) => setKeyScale(project.key, value as ScaleId)}
        className="h-[30px] w-[96px] shrink-0 text-[11.5px]"
        options={scaleOptions}
      />
    </div>
  )

  if (compact) {
    return (
      <div
        className="flex shrink-0 flex-col border-b border-line bg-bg-soft"
        role="toolbar"
        aria-label="走带控制"
        data-transport-layout="compact"
      >
        {/* 第一行：走带 / 循环·节拍 / 时间码 / BPM / 跟随 / 主输出 —— 关键项始终可见 */}
        <div className="flex h-[46px] min-w-0 items-center gap-1.5 px-3" data-transport-row="primary">
          {transportGroup}
          <GroupDivider />
          {loopGroup}
          <GroupDivider />
          <Timecode />
          <TempoControl />
          <TapTempoButton />
          <div className="flex-1" />
          <FollowToggle />
          <GroupDivider />
          <MasterSection />
        </div>

        {/* 第二行：拍号·调性 / 循环区间 / MIDI 输入 */}
        <div
          className="flex h-[38px] min-w-0 items-center gap-1.5 border-t border-line/70 px-3"
          data-transport-row="secondary"
        >
          {signatureGroup}
          <GroupDivider />
          <LoopRange />
          <div className="flex-1" />
          <MidiInputControl />
        </div>
      </div>
    )
  }

  return (
    <div
      className="flex h-[54px] shrink-0 flex-nowrap items-center gap-1.5 overflow-x-auto border-b border-line bg-bg-soft px-3"
      role="toolbar"
      aria-label="走带控制"
      data-transport-layout="wide"
    >
      {/* 1. 走带 */}
      {transportGroup}

      <GroupDivider />

      {/* 2. 循环 / 节拍器 / 预备拍 */}
      {loopGroup}

      <GroupDivider />

      {/* 3. 时间码 */}
      <Timecode />

      {/* 4. 速度 / Tap Tempo */}
      <TempoControl />
      <TapTempoButton />

      {/* 5. 拍号 / 调性 */}
      {signatureGroup}

      <GroupDivider />

      {/* 6. 循环区间 */}
      <LoopRange />

      <div className="flex-1" />

      {/* 7. MIDI 输入 */}
      <MidiInputControl />
      <GroupDivider />

      {/* 8. 跟随播放头（与编曲 / 钢琴卷帘共用 uiStore 状态） */}
      <FollowToggle />
      <GroupDivider />

      {/* 9. 主输出 */}
      <MasterSection />
    </div>
  )
}

function ToggleButton({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        'btn btn-icon h-[30px] w-[30px]',
        active
          ? 'border-accent/50 bg-accent/12 text-accent hover:bg-accent/18'
          : 'border-line-strong/50 bg-surface-2/40 text-ink-2 hover:bg-surface-3 hover:text-ink',
      )}
    >
      {children}
    </button>
  )
}
