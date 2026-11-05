/**
 * AI `ui` 事件 -> 前端真实动作。
 *
 * 服务端 SSE：`event: ui`，data 形如
 *   { action: 'play' }
 *   { action: 'seek', beat: 16 }
 *   { action: 'set_view', view: 'mixer' }
 *   { action: 'select_clip', clipId: 'c_xxx' }
 *   { action: 'open_export' } / { action: 'undo' } …
 *
 * 原则：
 * - 复用界面已有的真实路径（播放/停止走 audio engine，视图/弹窗/撤销走 store action），
 *   不做「只改 flag」的假动作；
 * - 参数非法 / 动作未知时静默忽略，绝不抛错影响 AI 对话流。
 */
import { useStore } from '../../store/store'
import type { ViewTab } from '../../store/types'
import { pauseTransport, playTransport, seekTransport, stopAllTransport } from '../transport/transportActions'

const VIEW_TABS: readonly ViewTab[] = ['arrangement', 'pianoroll', 'smartclips']

/** 把一条 uiAction 映射到现有 store / 音频引擎动作；无效输入直接忽略 */
export function applyAgentUiAction(raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const data = raw as { action?: unknown; beat?: unknown; view?: unknown; clipId?: unknown }
  const action = typeof data.action === 'string' ? data.action.trim().toLowerCase() : ''
  if (!action) return
  try {
    switch (action) {
      case 'play': {
        // 可选 beat：先跳转再播放（等价于用户拖播放头后按空格）
        if (typeof data.beat === 'number' && Number.isFinite(data.beat) && data.beat >= 0) {
          seekTransport(data.beat)
        }
        void playTransport()
        break
      }
      case 'pause':
        pauseTransport()
        break
      case 'stop':
        stopAllTransport()
        break
      case 'seek': {
        if (typeof data.beat === 'number' && Number.isFinite(data.beat) && data.beat >= 0) {
          seekTransport(data.beat)
        }
        break
      }
      case 'set_view': {
        const view = typeof data.view === 'string' ? data.view : ''
        if (view === 'mixer') {
          useStore.getState().setShowMixer(true)
        } else if ((VIEW_TABS as readonly string[]).includes(view)) {
          useStore.getState().setView(view as ViewTab)
        }
        break
      }
      case 'select_clip': {
        const clipId = typeof data.clipId === 'string' ? data.clipId : ''
        if (!clipId) break
        const state = useStore.getState()
        // clipId 是全局 id：先找到它所属的轨道，再走界面同一套 selectClip
        const track = state.project.tracks.find((item) => item.clips.some((clip) => clip.id === clipId))
        if (!track) break
        state.selectClip(track.id, clipId)
        break
      }
      case 'open_export':
        useStore.getState().setExportOpen(true)
        break
      case 'open_settings':
        useStore.getState().setSettingsOpen(true)
        break
      case 'undo':
        useStore.getState().undo()
        break
      case 'redo':
        useStore.getState().redo()
        break
      case 'toggle_loop': {
        const state = useStore.getState()
        state.setLoopEnabled(!state.loopEnabled)
        state.setSaveStatus('dirty')
        break
      }
      case 'toggle_metronome':
        useStore.getState().setMetronome(!useStore.getState().metronome)
        break
      default:
        break
    }
  } catch {
    /* 界面动作失败不能影响对话流 */
  }
}
