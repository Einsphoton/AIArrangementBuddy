/**
 * 全局快捷键。
 *
 * 原则：只接管「跨视图」的命令键，视图内的编辑键（Delete / ⌘A / ⌘C / Q / 方向键…）
 * 仍由各视图自己处理，避免同一按键触发两次。
 *
 * 这里负责的键与 `lib/commands.ts` 一一对应：
 *   ⌘K 命令面板 · ⌘J AI 面板 · F 跟随 · R MIDI 录入 · ⌘⇧M 混音器
 *   M 静音选中轨 · S 独奏选中轨 · C 节拍器
 *   ⌘, 设置 · ⌘⇧E 导出 · ⌘⇧N 添加轨道 · ⌘0 / ⌘= / ⌘- 缩放 · ⌘D 复制 · ⌘E 拆分
 *
 * 注意：节拍器用 C 而不是 M —— M/S 必须留给轨道静音/独奏（Logic / Cubase / Studio One 惯例），
 * 否则用户想静音一条轨却打开了节拍器。
 */
import { useEffect } from 'react'
import { getCommand } from '../lib/commands'
import { matchesCombo } from '../lib/shortcuts'
import { useStore } from '../store/store'

const KEY_MAP: { combo: string; commandId: string }[] = [
  { combo: 'mod+k', commandId: 'help.palette' },
  { combo: 'mod+j', commandId: 'view.toggleChat' },
  { combo: 'f', commandId: 'view.follow' },
  { combo: 'r', commandId: 'transport.record' },
  { combo: 'm', commandId: 'track.mute' },
  { combo: 's', commandId: 'track.solo' },
  { combo: 'c', commandId: 'transport.metronome' },
  { combo: 'mod+shift+m', commandId: 'view.toggleMixer' },
  { combo: 'mod+,', commandId: 'project.settings' },
  { combo: 'mod+shift+e', commandId: 'project.export' },
  { combo: 'mod+shift+n', commandId: 'track.add' },
  { combo: 'mod+=', commandId: 'view.zoomIn' },
  { combo: 'mod+-', commandId: 'view.zoomOut' },
  { combo: 'mod+0', commandId: 'view.zoomFit' },
  { combo: 'mod+d', commandId: 'edit.duplicate' },
  { combo: 'mod+e', commandId: 'edit.split' },
]

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const store = useStore.getState()
      if (store.settingsOpen || store.helpOpen || store.exportOpen) return

      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      ) {
        return
      }
      if (event.defaultPrevented) return
      // 已经有其它处理者（例如画布拖动逻辑）消费过的按键不重复执行
      if (event.repeat) return

      for (const entry of KEY_MAP) {
        if (!matchesCombo(event, entry.combo)) continue
        const command = getCommand(entry.commandId)
        if (!command) return
        event.preventDefault()
        void command.run()
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
}
