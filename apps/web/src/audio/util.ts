/**
 * 音频引擎内部使用的纯函数工具。
 *
 * 刻意不依赖 Tone.js / DOM，方便在离线渲染、单元自测、服务端同构脚本里复用。
 */

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return value < min ? min : value > max ? max : value
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1)
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

/** MIDI 音高 -> 科学音高记谱（C4 = 60），非法输入会被夹到 0..127 */
export function midiToNoteName(pitch: number): string {
  const p = Math.round(clamp(pitch, -12, 139))
  const pc = ((p % 12) + 12) % 12
  const octave = Math.floor(p / 12) - 1
  return `${NOTE_NAMES[pc]}${octave}`
}

/** MIDI 音高 -> 频率（Hz） */
export function midiToFrequency(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12)
}

/** 开方衰减：让包络曲线更接近真实乐器（指数型） */
export function expScale(value: number, power = 2): number {
  return Math.pow(clamp(value, 0, 1), power)
}

/**
 * 情绪参数「亮度」-> 滤波截止频率倍数。
 * 0 => 0.32x（很暗），0.5 => 1x，1 => 2.1x（很亮）。
 */
export function brightnessScale(brightness: number): number {
  return 0.32 + clamp(brightness, 0, 1) * 1.78
}

/** 情绪参数「温暖度」-> 低频搁架增益（dB） */
export function warmthGainDb(warmth: number): number {
  return (clamp(warmth, 0, 1) - 0.5) * 12
}

/**
 * 力度曲线映射。
 * curve > 0 = 更硬朗（弱奏更弱、强奏更强，动态反差大）
 * curve < 0 = 更柔和（弱奏被抬起来，动态被压缩）
 */
export function shapeVelocity(velocity: number, curve: number, sensitivity: number): number {
  const v = clamp(velocity, 0, 1)
  const power = clamp(1 + clamp(curve, -1, 1) * 0.7, 0.3, 2)
  const shaped = Math.pow(v, power)
  const sens = clamp(sensitivity, 0, 1)
  // 灵敏度 1 = 完整动态范围，0 = 恒定力度
  return clamp(1 - sens * (1 - shaped), 0.02, 1)
}

/** 节拍时长（拍）-> 秒 */
export function beatsToSeconds(beats: number, tempo: number): number {
  return (beats / Math.max(20, tempo)) * 60
}

/** 秒 -> 拍 */
export function secondsToBeats(seconds: number, tempo: number): number {
  return (seconds * Math.max(20, tempo)) / 60
}

/** 简单软限幅，用在离线导出混音上避免削波 */
export function softClip(sample: number): number {
  const x = clamp(sample, -3, 3)
  return Math.tanh(x * 0.92) * 0.98
}

/** 十六进制/rgb 无关的稳定字符串哈希，用于给轨道分配通道/声像微差 */
export function hashString(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}
