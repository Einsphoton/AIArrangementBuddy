import { useEffect, useRef } from 'react'
import { snapToScale } from '@aiab/core'
import { getAudioEngine } from '../../audio'
import { useStore } from '../../store/store'
import { useUiStore } from '../../lib/uiStore'

/**
 * MIDI 键盘演奏 / 实时录入。
 *
 * - 始终「MIDI Thru」：插上键盘弹奏会立刻用当前轨道音色发声
 * - 打开录入开关（状态栏 MIDI 按钮）且处于钢琴卷帘、已选中片段时：
 *   按下的音会在播放头位置写入音符，松键确定时值（按吸附网格量化）
 *
 * 没有 MIDI 设备时静默跳过，不影响其它功能。
 */
export function useMidiPerformance(): void {
  const engine = getAudioEngine()
  const pending = useRef(new Map<number, { startBeat: number; velocity: number }>())

  useEffect(() => {
    let disposed = false
    let offNoteOn: (() => void) | null = null
    let offNoteOff: (() => void) | null = null

    const setup = async () => {
      try {
        await engine.init()
      } catch {
        return
      }
      if (disposed) return
      const midi = engine.midi
      if (!midi) return

      offNoteOn = midi.onNoteOn((event) => {
        const state = useStore.getState()
        state.setMidiLastPitch(event.pitch)

        const track = state.project.tracks.find((t) => t.id === state.focusedTrackId)
        if (track) {
          // MIDI Thru：走「轨道真实发声链」（同一乐器 / 情绪 / 采样音源），按住持续、松手释放
          if (engine.midiNoteOn) engine.midiNoteOn(track, event.pitch, event.velocity)
          else engine.previewNote(track, event.pitch, event.velocity, 0.6)
        }

        const clipId = state.selection.clipId
        const shouldRecord = state.midiRecord && state.view === 'pianoroll' && Boolean(clipId) && Boolean(track)
        if (!shouldRecord || !track || !clipId) return

        const clip = track.clips.find((c) => c.id === clipId)
        if (!clip) return
        const relative = Math.max(0, state.playhead - clip.startBeat)
        pending.current.set(event.pitch, { startBeat: relative, velocity: event.velocity })
      })

      offNoteOff = midi.onNoteOff((event) => {
        const liveTrack = useStore.getState().project.tracks.find((t) => t.id === useStore.getState().focusedTrackId)
        if (liveTrack) {
          if (engine.midiNoteOff) engine.midiNoteOff(liveTrack, event.pitch)
          else engine.stopPreview()
        }
        const start = pending.current.get(event.pitch)
        pending.current.delete(event.pitch)
        if (!start) return

        const state = useStore.getState()
        const track = state.project.tracks.find((t) => t.id === state.focusedTrackId)
        const clipId = state.selection.clipId
        if (!track || !clipId) return
        const clip = track.clips.find((c) => c.id === clipId)
        if (!clip) return

        const snap = state.snap > 0 ? state.snap : 0.25
        const startBeat = Math.max(0, Math.round(start.startBeat / snap) * snap)
        const endBeat = Math.max(startBeat + snap, Math.round((state.playhead - clip.startBeat) / snap) * snap)
        const duration = Math.max(snap, Math.min(endBeat - startBeat, 8))
        // 音阶锁定开启时，录入的音高也吸附到调内音级，与钢琴卷帘里画音符保持一致
        // （鼓组轨道的音高是鼓件映射，不参与吸附）
        const locked = useUiStore.getState().scaleLock && track.kind !== 'drum'
        const pitch = locked ? snapToScale(event.pitch, state.project.key, state.project.scale) : event.pitch

        state.addNotes(track.id, clipId, [
          {
            id: `midi_${Date.now().toString(36)}_${event.pitch}`,
            pitch,
            start: startBeat,
            duration,
            velocity: Math.min(127, Math.max(1, Math.round(event.velocity || 96))),
          },
        ])
      })
    }

    void setup()
    return () => {
      disposed = true
      offNoteOn?.()
      offNoteOff?.()
      pending.current.clear()
    }
  }, [engine])
}
