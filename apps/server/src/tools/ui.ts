/**
 * 界面操作工具（只读，不修改工程数据）。
 *
 * 约定（与 Agent/前端桥接方）：成功时 data 里必须原样带
 * `{ uiAction: { action, beat?, view?, clipId? } }`，
 * Agent 层会把 data.uiAction 作为新的 SSE `ui` 事件转发给前端执行。
 */
import { CLIP_ID, enm, num, toolSchema, type ToolDef } from './schema.js'
import { failResult, okResult, readNumber, readString } from './project.js'

export const UI_ACTIONS = [
  'play',
  'stop',
  'seek',
  'set_view',
  'select_clip',
  'open_export',
  'open_settings',
  'undo',
  'redo',
  'toggle_loop',
  'toggle_metronome',
] as const

export const UI_VIEWS = ['arrangement', 'pianoroll', 'mixer', 'smartclips'] as const

const VIEW_LABELS: Record<string, string> = {
  arrangement: '编曲',
  pianoroll: '钢琴卷帘',
  mixer: '混音器',
  smartclips: '智能片段',
}

export interface UiActionPayload {
  action: string
  beat?: number
  view?: string
  clipId?: string
}

export const uiActionTool: ToolDef = {
  name: 'ui_action',
  title: '界面操作',
  readOnly: true,
  description:
    '操作应用界面（不修改工程数据）：播放 play / 停止 stop / 跳转 seek（需 beat，单位拍）/ 切换视图 set_view（arrangement 编曲、pianoroll 钢琴卷帘、mixer 混音器、smartclips 智能片段）/ 选中片段 select_clip（需 clipId）/ 打开导出 open_export / 打开设置 open_settings / 撤销 undo / 重做 redo / 开关循环 toggle_loop / 开关节拍器 toggle_metronome。当用户说「播放一下」「停」「跳到第 8 拍」「打开混音器」时使用。',
  parameters: toolSchema(
    {
      action: enm('界面动作', UI_ACTIONS),
      beat: num('跳转位置（拍），仅 seek 使用；缺省跳到 0', { minimum: 0 }),
      view: enm('目标视图，仅 set_view 使用；缺省 arrangement', UI_VIEWS),
      clipId: CLIP_ID,
    },
    ['action'],
  ),
  async handler(args, _ctx) {
    const rawAction = readString(args, 'action')
    const action = rawAction?.toLowerCase()
    if (!action || !(UI_ACTIONS as readonly string[]).includes(action)) {
      return failResult(`未知界面动作「${rawAction ?? ''}」，可用：${UI_ACTIONS.join(' / ')}`)
    }
    const uiAction: UiActionPayload = { action }
    let message: string

    switch (action) {
      case 'seek': {
        const beat = readNumber(args, 'beat', 0, 100000) ?? 0
        uiAction.beat = Math.round(beat * 1000) / 1000
        message = `已请求播放头跳转到 ${uiAction.beat} 拍`
        break
      }
      case 'set_view': {
        const rawView = readString(args, 'view') ?? 'arrangement'
        const view = (UI_VIEWS as readonly string[]).includes(rawView) ? rawView : 'arrangement'
        uiAction.view = view
        message = `已请求切换到「${VIEW_LABELS[view] ?? view}」视图`
        break
      }
      case 'select_clip': {
        const clipId = readString(args, 'clipId')
        if (!clipId) return failResult('select_clip 需要提供 clipId（片段 id，可从 get_project_summary 获取）')
        uiAction.clipId = clipId
        message = `已请求选中片段 ${clipId}`
        break
      }
      case 'play':
        message = '已请求开始播放'
        break
      case 'stop':
        message = '已请求停止播放'
        break
      case 'open_export':
        message = '已请求打开导出面板'
        break
      case 'open_settings':
        message = '已请求打开设置'
        break
      case 'undo':
        message = '已请求撤销上一步操作'
        break
      case 'redo':
        message = '已请求重做'
        break
      case 'toggle_loop':
        message = '已请求切换循环开关'
        break
      case 'toggle_metronome':
        message = '已请求切换节拍器'
        break
      default:
        message = `已请求执行界面动作 ${action}`
        break
    }
    return okResult(message, { uiAction })
  },
}

/** 界面操作类工具集合 */
export const UI_TOOLS: ToolDef[] = [uiActionTool]
