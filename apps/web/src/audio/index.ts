/**
 * 音频引擎公共入口。
 *
 * UI 只依赖：
 * - `getAudioEngine()`：全局唯一 `AudioEngine`（接口见 ./types.ts）
 * - `encodeWav()`：Float32 PCM -> WAV Blob（导出 / 转码用）
 *
 * 其余实现（synth / soundfont / render / midi）都是内部细节。
 */
export * from './types'
export { createAudioEngine, encodeWav, getAudioEngine } from './engine'
export { audibleTracks, renderProjectToWav, routeTracks, trackUsesSoundfont } from './render'
export { installAudioStoreBridge } from './storeBridge'

import { getAudioEngine } from './engine'
import { installAudioStoreBridge } from './storeBridge'

// 音频引擎与 zustand store 的可选桥接：
// MIDI 设备热插拔 / 音色库加载状态需要同步到 UI 状态（StatusBar、设置页）。
// 这里自动安装一次，避免依赖某个组件恰好挂载了 hooks；
// 组件里仍然可以用 `hooks/useMidiInput.ts` 做试听 / 录入。
installAudioStoreBridge(getAudioEngine())
