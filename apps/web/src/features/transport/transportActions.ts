/**
 * 走带真实动作：播放 / 暂停 / 停止 / 跳转。
 *
 * TransportBar 的按钮与 AI 的 `ui` 事件都走这一套实现，保证「用户点击」和「AI 请求」
 * 走的是同一条真实路径（音频引擎 + store），而不是只改 UI flag 不出声。
 */
import { getAudioEngine } from '../../audio'
import { useStore } from '../../store/store'

const PLAY_FAILED = '播放失败：音频引擎尚未就绪，请再点一次'

/** 暂停：保留当前播放头 */
export function pauseTransport(): void {
  try {
    getAudioEngine().pause()
  } catch (error) {
    console.warn('[transport] 暂停失败', error)
  }
  useStore.getState().setPlaying(false)
}

/** 播放：已在播放则忽略；从当前播放头开始，带上循环 / 预备拍设置 */
export async function playTransport(): Promise<void> {
  const store = useStore.getState()
  if (store.isPlaying) return
  const engine = getAudioEngine()
  try {
    if (!engine.ready) await engine.init()
    const latest = useStore.getState()
    await engine.play(latest.project, {
      fromBeat: latest.playhead,
      loop: latest.loopEnabled ? latest.project.loop : null,
      countIn: latest.countIn,
    })
    useStore.getState().setPlaying(true)
  } catch (error) {
    console.warn('[transport] 播放失败', error)
    useStore.getState().pushToast('error', PLAY_FAILED)
  }
}

/** 播放 / 暂停切换（走带播放按钮的语义） */
export async function togglePlayTransport(): Promise<void> {
  if (useStore.getState().isPlaying) {
    pauseTransport()
    return
  }
  await playTransport()
}

/** 停止：停止发声并把播放头归零（走带停止按钮的语义） */
export function stopAllTransport(): void {
  try {
    getAudioEngine().stop()
  } catch (error) {
    console.warn('[transport] 停止失败', error)
  }
  useStore.getState().stopTransport()
}

/** 跳转到指定拍：更新播放头；播放中由引擎实时重排（seek 内部 releaseAllVoices + 重定起点） */
export function seekTransport(beat: number): void {
  if (!Number.isFinite(beat) || beat < 0) return
  try {
    getAudioEngine().seek(beat)
  } catch {
    /* 引擎未就绪时仅更新 UI */
  }
  useStore.getState().setPlayhead(beat)
}

/** 回到开头 */
export function rewindTransport(): void {
  seekTransport(0)
}
