import { useEffect, useRef } from 'react'
import { snapToScale, type Track } from '@aiab/core'
import { getAudioEngine } from '../../audio'
import { useStore } from '../../store/store'
import { useUiStore } from '../../lib/uiStore'
import { resolveRecordClipId, resolveRecordTrackId } from '../../lib/trackRules'

/**
 * 解析「这次按键该落到哪条轨道 / 哪个片段」。
 *
 * 顺序：录入预备（轨道头 R）> 聚焦轨道 > 选中轨道。
 * 之前这里只读 `focusedTrackId`，而 R 按钮写的是 `armedTrackId`，两者从不同步，
 * 于是「预备了 A 轨、实际录进 B 轨」甚至完全不录（聚焦轨没有选中片段）——用户报的 R 不好用。
 * 现在两边共用 lib/trackRules 的同一套解析。
 */
function resolveTargetTrack(state: ReturnType<typeof useStore.getState>): Track | null {
  const trackId = resolveRecordTrackId(
    {
      armedTrackId: useUiStore.getState().armedTrackId,
      focusedTrackId: state.focusedTrackId,
      selectedTrackId: state.selectedTrackId,
    },
    state.project.tracks,
  )
  return trackId ? (state.project.tracks.find((track) => track.id === trackId) ?? null) : null
}

/**
 * MIDI 键盘演奏 / 实时录入。
 *
 * - 始终「MIDI Thru」：插上键盘弹奏会立刻用当前轨道音色发声
 * - 打开录入开关（状态栏 MIDI 按钮 / 走带条录音键）且处于钢琴卷帘、目标轨道有可用片段时：
 *   按下的音会在播放头位置写入音符，松键确定时值（按吸附网格量化）
 *
 * 目标轨道优先取「录入预备」（轨道头 R），其次聚焦轨道、选中轨道；
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

        const track = resolveTargetTrack(state)
        if (track) {
          // MIDI Thru：走「轨道真实发声链」（同一乐器 / 情绪 / 采样音源），按住持续、松手释放
          if (engine.midiNoteOn) engine.midiNoteOn(track, event.pitch, event.velocity)
          else engine.previewNote(track, event.pitch, event.velocity, 0.6)
        }

        /* 录入只要求「目标轨道有可用片段」，不再要求选中片段恰好属于聚焦轨道 */
        const shouldRecord = state.midiRecord && state.view === 'pianoroll' && Boolean(track)
        if (!shouldRecord || !track) return

        const clipId = resolveRecordClipId(track, state.selection.clipId)
        if (!clipId) return
        const clip = track.clips.find((c) => c.id === clipId)
        if (!clip) return
        const relative = Math.max(0, state.playhead - clip.startBeat)
        pending.current.set(event.pitch, { startBeat: relative, velocity: event.velocity })
      })

      offNoteOff = midi.onNoteOff((event) => {
        const liveState = useStore.getState()
        const liveTrack = resolveTargetTrack(liveState)
        if (liveTrack) {
          if (engine.midiNoteOff) engine.midiNoteOff(liveTrack, event.pitch)
          else engine.stopPreview()
        }
        const start = pending.current.get(event.pitch)
        pending.current.delete(event.pitch)
        if (!start) return

        const state = useStore.getState()
        const track = resolveTargetTrack(state)
        if (!track) return
        const clipId = resolveRecordClipId(track, state.selection.clipId)
        if (!clipId) return
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
