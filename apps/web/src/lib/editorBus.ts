/**
 * 编辑器命令总线。
 *
 * 键盘 / 命令面板 / 工具栏都需要触发「当前视图」的局部动作（缩放、拆分、量化……），
 * 但这些动作依赖各视图内部的滚动容器与画布几何，不适合放进全局 store。
 * 因此用一个很小的 window 事件总线：命令层广播意图，当前视图订阅并执行。
 *
 * 约定：同一时刻只有一个编辑视图挂载（编曲 / 钢琴卷帘 / 智能片段），
 * 所以不存在多个订阅者互相抢事件的问题。
 */

export type EditorAction =
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-fit'
  | 'duplicate'
  | 'copy'
  | 'paste'
  | 'split'
  | 'quantize'
  | 'delete'
  | 'select-all'
  | 'transpose'
  | 'nudge'
  | 'tap-tempo'
  | 'add-track'
  | 'rename-track'

export type EditorCommandPayload = {
  action: EditorAction
  /** 移调半音数 / 微移拍数 */
  semitones?: number
  beats?: number
  /** 是否直接操作选中轨道 */
  trackId?: string
}

const EDITOR_EVENT = 'aiab:editor-command'

export function dispatchEditorCommand(payload: EditorCommandPayload): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<EditorCommandPayload>(EDITOR_EVENT, { detail: payload }))
}

export function subscribeEditorCommand(
  handler: (payload: EditorCommandPayload) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<EditorCommandPayload>).detail
    if (detail) handler(detail)
  }
  window.addEventListener(EDITOR_EVENT, listener)
  return () => window.removeEventListener(EDITOR_EVENT, listener)
}
