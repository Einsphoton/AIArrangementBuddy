/**
 * 音频引擎 ↔ zustand store 的可选桥接。
 *
 * 为什么需要它：
 * - MIDI 设备热插拔是异步事件，UI（状态栏 / 设置页 / 走带条）只能从 store 读设备列表；
 * - SoundFont 的加载状态（加载中 / 已加载 / 失败）同样要显示在状态栏。
 *
 * 这里做的是「只读同步 + 一个选择指令」：
 * - engine.midi.onDevicesChanged  -> store.setMidiDevices
 * - engine.soundfont.onStatus     -> store.setSoundfontStatus
 * - store.midiActiveId 变化        -> engine.midi.select
 *
 * 它不依赖 React，重复安装是幂等的；组件里更推荐用 `hooks/useMidiInput.ts`
 * （在桥接之上再加试听 / 录入逻辑）。
 */
import { useStore } from '../store/store'
import type { AudioEngine } from './types'

let installed = false
let engineRef: AudioEngine | null = null

function syncDevices(engine: AudioEngine): void {
  const devices = engine.midi.devices.map((device) => ({ id: device.id, name: device.name }))
  const store = useStore.getState()
  const activeId = engine.midi.activeId ?? store.midiActiveId
  store.setMidiDevices(devices, activeId)
}

export function installAudioStoreBridge(engine: AudioEngine): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  engineRef = engine

  engine.midi.onDevicesChanged(() => syncDevices(engine))

  engine.soundfont.onStatus((status) => {
    useStore.getState().setSoundfontStatus({
      loaded: status.loaded,
      name: status.name,
      loading: status.loading,
      error: status.error,
    })
  })

  // store -> engine：用户在走带条 / 设置页切换 MIDI 设备
  let lastActiveId = useStore.getState().midiActiveId
  useStore.subscribe((state) => {
    if (state.midiActiveId === lastActiveId) return
    lastActiveId = state.midiActiveId
    engineRef?.midi.select(lastActiveId)
  })

  // 初始化后补一次同步（引擎 init 是用户手势之后才发生的）
  if (engine.ready) syncDevices(engine)
  else {
    const timer = setInterval(() => {
      if (!engine.ready) return
      clearInterval(timer)
      syncDevices(engine)
    }, 300)
    // 10 秒后放弃轮询（用户可能一直没交互）
    setTimeout(() => clearInterval(timer), 10_000)
  }
}
