/**
 * Web MIDI 输入。
 *
 * 能力：
 * - 设备枚举 / 热插拔（`onstatechange` 自动重新扫描并通知订阅者）
 * - 选择某个输入设备（未选择时默认第一个可用设备）
 * - Note On / Note Off（velocity 0 的 Note On 按 Note Off 处理）/ CC
 * - 事件时间戳使用 MIDI 事件的 `timeStamp`，比 `performance.now()` 更贴近真实按键时刻
 *
 * 这个类不依赖 React / store，`hooks/useMidiInput.ts` 负责把事件桥接进 UI 状态。
 */
import type { MidiCCEvent, MidiInput, MidiNoteEvent } from './types'

export interface MidiDevice {
  id: string
  name: string
  manufacturer?: string
}

export type MidiDeviceHandler = (devices: MidiDevice[]) => void

export class WebMidiInput implements MidiInput {
  readonly supported: boolean
  devices: MidiDevice[] = []
  activeId: string | null = null

  private access: MIDIAccess | null = null
  private initializing: Promise<void> | null = null
  private readonly noteOnHandlers = new Set<(event: MidiNoteEvent) => void>()
  private readonly noteOffHandlers = new Set<(event: MidiNoteEvent) => void>()
  private readonly ccHandlers = new Set<(event: MidiCCEvent) => void>()
  private readonly deviceHandlers = new Set<MidiDeviceHandler>()

  constructor() {
    this.supported = typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator
  }

  async init(): Promise<void> {
    if (!this.supported || this.access) {
      if (this.access) this.syncDevices()
      return
    }
    if (this.initializing) return this.initializing
    this.initializing = this.requestAccess()
    try {
      await this.initializing
    } finally {
      this.initializing = null
    }
  }

  private async requestAccess(): Promise<void> {
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false })
      this.access = access
      access.onstatechange = () => this.syncDevices()
      this.syncDevices()
    } catch (error) {
      // 浏览器弹窗被拒绝 / 非安全上下文：保持「无设备」状态，不阻塞音频引擎初始化。
      // 只打 dev 日志，绝不 toast 打扰用户（真实 Chrome 里用户授权后即可正常使用）。
      if (import.meta.env.DEV) console.warn('[midi] 无法获取 MIDI 访问权限', error)
      this.devices = []
      this.emitDevices()
    }
  }

  private syncDevices(): void {
    const access = this.access
    if (!access) return
    const next: MidiDevice[] = []
    access.inputs.forEach((input) => {
      next.push({
        id: input.id,
        name: input.name || input.manufacturer || 'MIDI 输入',
        manufacturer: input.manufacturer || undefined,
      })
    })
    const changed =
      next.length !== this.devices.length ||
      next.some((device, index) => device.id !== this.devices[index]?.id || device.name !== this.devices[index]?.name)
    this.devices = next
    if (this.activeId && !next.some((device) => device.id === this.activeId)) this.activeId = null
    if (!this.activeId && next.length > 0) this.activeId = next[0].id
    this.bindInputs()
    if (changed) this.emitDevices()
  }

  /** 只给「当前选中」的设备挂回调，避免多设备重复触发；回调里再判断 id 以防竞态 */
  private bindInputs(): void {
    const access = this.access
    if (!access) return
    access.inputs.forEach((input) => {
      input.onmidimessage = (event: MIDIMessageEvent) => {
        if (this.activeId && input.id !== this.activeId) return
        this.handleMessage(event)
      }
    })
  }

  private handleMessage(event: MIDIMessageEvent): void {
    const data = event.data
    if (!data || data.length < 2) return
    const status = data[0]
    const command = status & 0xf0
    const channel = (status & 0x0f) + 1
    const timestamp = typeof event.timeStamp === 'number' && event.timeStamp > 0 ? event.timeStamp : performance.now()
    const data1 = data[1]
    const data2 = data.length > 2 ? data[2] : 0

    if (command === 0x90 && data2 > 0) {
      const note: MidiNoteEvent = { pitch: data1, velocity: data2, channel, timestamp }
      this.noteOnHandlers.forEach((handler) => handler(note))
      return
    }
    if (command === 0x80 || (command === 0x90 && data2 === 0)) {
      const note: MidiNoteEvent = { pitch: data1, velocity: 0, channel, timestamp }
      this.noteOffHandlers.forEach((handler) => handler(note))
      return
    }
    if (command === 0xb0) {
      this.ccHandlers.forEach((handler) => handler({ controller: data1, value: data2, channel, timestamp }))
      return
    }
    // 14-bit pitch bend 等暂不消费；接入时在这里扩展即可
  }

  private emitDevices(): void {
    const snapshot = this.devices.map((device) => ({ ...device }))
    this.deviceHandlers.forEach((handler) => handler(snapshot))
  }

  async refresh(): Promise<MidiDevice[]> {
    await this.init()
    this.syncDevices()
    return this.devices.map((device) => ({ ...device }))
  }

  select(id: string | null): void {
    this.activeId = id
    this.bindInputs()
  }

  onNoteOn(handler: (event: MidiNoteEvent) => void): () => void {
    this.noteOnHandlers.add(handler)
    return () => this.noteOnHandlers.delete(handler)
  }

  onNoteOff(handler: (event: MidiNoteEvent) => void): () => void {
    this.noteOffHandlers.add(handler)
    return () => this.noteOffHandlers.delete(handler)
  }

  onCC(handler: (event: MidiCCEvent) => void): () => void {
    this.ccHandlers.add(handler)
    return () => this.ccHandlers.delete(handler)
  }

  onDevicesChanged(handler: MidiDeviceHandler): () => void {
    this.deviceHandlers.add(handler)
    return () => this.deviceHandlers.delete(handler)
  }

  /** 引擎销毁时解绑所有设备回调（接口之外的补充方法） */
  dispose(): void {
    if (this.access) {
      this.access.inputs.forEach((input) => {
        input.onmidimessage = null
      })
      this.access.onstatechange = null
    }
    this.noteOnHandlers.clear()
    this.noteOffHandlers.clear()
    this.ccHandlers.clear()
    this.deviceHandlers.clear()
    this.access = null
    this.devices = []
    this.activeId = null
  }
}
