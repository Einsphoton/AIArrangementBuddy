/**
 * Web MIDI 输入 -> React / store 桥接。
 *
 * 用法（任意组件里挂一次即可）：
 * ```tsx
 * useMidiInput({ audition: true, record: true })
 * ```
 *
 * 它做四件事：
 * 1. 初始化 `engine.midi` 并把设备列表 / 当前设备同步到 store
 *    （store.midiDevices / midiActiveId，状态栏与设置页直接读取）；
 * 2. 设备热插拔时自动刷新；
 * 3. 按下 / 抬起键时更新 `store.midiLastPitch`，并可实时试听当前聚焦轨道；
 * 4. 可选「录入」：走带播放中把按下的键写成聚焦轨道当前片段里的音符
 *    （record=true 时；时长按松键时的播放头计算，精度受 UI 播放头刷新率限制）。
 */
import { useEffect, useMemo, useRef } from 'react'
import { createNote, type NoteEvent } from '@aiab/core'
import { getAudioEngine } from '../audio'
import type { MidiCCEvent, MidiNoteEvent } from '../audio/types'
import { useStore } from '../store/store'

export interface MidiInputOptions {
  /** 是否启用（默认 true） */
  enabled?: boolean
  /** 按键是否发声试听（默认 true） */
  audition?: boolean
  /** 试听使用的轨道 id；缺省用当前聚焦轨道 */
  trackId?: string
  /** 是否把按键录进聚焦轨道（默认 false，需要走带正在播放） */
  record?: boolean
  onNoteOn?: (event: MidiNoteEvent) => void
  onNoteOff?: (event: MidiNoteEvent) => void
  onCC?: (event: MidiCCEvent) => void
}

export interface MidiInputState {
  supported: boolean
  devices: { id: string; name: string }[]
  activeId: string | null
}

interface RecordingNote {
  trackId: string
  clipId: string
  noteId: string
  startBeat: number
}

/** 返回 MIDI 输入状态，并在组件存活期间维护设备列表 / 试听 / 录入 */
export function useMidiInput(options: MidiInputOptions = {}): MidiInputState {
  const engine = useMemo(() => getAudioEngine(), [])
  const optionsRef = useRef(options)
  optionsRef.current = options
  const recordingRef = useRef(new Map<number, RecordingNote>())

  const devices = useStore((state) => state.midiDevices)
  const activeId = useStore((state) => state.midiActiveId)

  /* 设备枚举 + 热插拔 */
  useEffect(() => {
    if (options.enabled === false) return
    const sync = (list: { id: string; name: string }[]) => {
      useStore.getState().setMidiDevices(list, engine.midi.activeId)
    }
    void engine.midi
      .refresh()
      .then((list) => sync(list.map((device) => ({ id: device.id, name: device.name }))))
      .catch(() => undefined)
    const offDevices = engine.midi.onDevicesChanged((list) => {
      sync(list.map((device) => ({ id: device.id, name: device.name })))
    })
    return () => {
      offDevices()
    }
  }, [engine, options.enabled])

  /* Note On / Note Off / CC */
  useEffect(() => {
    if (options.enabled === false) return
    const store = useStore.getState()

    const resolveTrack = () => {
      const state = useStore.getState()
      const trackId = optionsRef.current.trackId ?? state.focusedTrackId ?? state.selectedTrackId
      return state.project.tracks.find((track) => track.id === trackId)
    }

    const offNoteOn = engine.midi.onNoteOn((event) => {
      useStore.getState().setMidiLastPitch(event.pitch)
      optionsRef.current.onNoteOn?.(event)

      const track = resolveTrack()
      if (track) {
        if (optionsRef.current.audition !== false) {
          if (engine.midiNoteOn) engine.midiNoteOn(track, event.pitch, event.velocity)
          else engine.previewNote(track, event.pitch, event.velocity)
        }
        if (optionsRef.current.record) startRecording(track.id, event)
      }
    })

    const offNoteOff = engine.midi.onNoteOff((event) => {
      optionsRef.current.onNoteOff?.(event)
      const track = resolveTrack()
      if (track) engine.midiNoteOff?.(track, event.pitch)
      if (optionsRef.current.record) finishRecording(event.pitch)
    })

    const offCC = engine.midi.onCC((event) => {
      optionsRef.current.onCC?.(event)
    })

    /** 在聚焦轨道的当前片段里写一个音符（start 为相对片段的拍） */
    function startRecording(trackId: string, event: MidiNoteEvent): void {
      const state = useStore.getState()
      if (!state.isPlaying) return
      const track = state.project.tracks.find((item) => item.id === trackId)
      if (!track) return
      const playhead = state.playhead
      const clip = track.clips.find(
        (item) => !item.muted && playhead >= item.startBeat && playhead < item.startBeat + item.lengthBeats,
      )
      if (!clip) return
      const note = createNote(
        event.pitch,
        Math.max(0, playhead - clip.startBeat),
        0.25,
        Math.max(1, Math.min(127, event.velocity)),
      )
      useStore.getState().addNotes(track.id, clip.id, [note], { history: false })
      recordingRef.current.set(event.pitch, {
        trackId: track.id,
        clipId: clip.id,
        noteId: note.id,
        startBeat: playhead,
      })
    }

    function finishRecording(pitch: number): void {
      const record = recordingRef.current.get(pitch)
      if (!record) return
      recordingRef.current.delete(pitch)
      const state = useStore.getState()
      const duration = Math.max(0.08, state.playhead - record.startBeat)
      const patch: Partial<NoteEvent> = { duration }
      useStore.getState().updateNotes(record.trackId, record.clipId, [record.noteId], patch, { history: false })
    }

    return () => {
      offNoteOn()
      offNoteOff()
      offCC()
      const pending = recordingRef.current
      pending.clear()
    }
    // store 实例是稳定的（zustand），这里只需要引擎与开关
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, options.enabled])

  return {
    supported: engine.midi.supported,
    devices,
    activeId,
  }
}

export default useMidiInput
