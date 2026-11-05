/**
 * 走带时间轴映射（纯函数，无 Tone / DOM 依赖）。
 *
 * 音频引擎的走带不用 Tone.Transport 的事件表，而是维护一条「时间轴位置」：
 *
 * - `position`：从播放起点开始**单调递增**的拍坐标（循环时不会回绕）；
 * - `beat`：乐谱上的绝对拍（循环时会回绕到 loopStart）。
 *
 * 两者用 `startContextTime` / `startPosition` / `secPerBeat` 线性映射，
 * 再由 `loop` 决定回绕规则。把这段数学独立出来，方便测试和复用。
 */

export interface LoopRegion {
  startBeat: number
  endBeat: number
}

export interface TimelineMapping {
  /** `startPosition` 对应的 AudioContext 时间（秒） */
  startContextTime: number
  /** 播放起点在时间轴上的位置（拍） */
  startPosition: number
  /** 每拍秒数 */
  secPerBeat: number
  loop: LoopRegion | null
}

/** 时间轴位置区间对应的「乐谱拍区间」 */
export interface BeatSegment {
  beatFrom: number
  beatTo: number
  /** 该段在时间轴上的起点 */
  positionFrom: number
  /** 该段在时间轴上的终点 */
  positionTo: number
}

/** AudioContext 时间 -> 时间轴位置 */
export function positionAt(mapping: TimelineMapping, contextTime: number): number {
  if (mapping.secPerBeat <= 0) return mapping.startPosition
  return mapping.startPosition + (contextTime - mapping.startContextTime) / mapping.secPerBeat
}

/** 时间轴位置 -> AudioContext 时间 */
export function contextTimeAtPosition(mapping: TimelineMapping, position: number): number {
  return mapping.startContextTime + (position - mapping.startPosition) * mapping.secPerBeat
}

/** 时间轴位置 -> 乐谱绝对拍（循环区间内回绕） */
export function beatAtPosition(mapping: TimelineMapping, position: number): number {
  const loop = mapping.loop
  if (!loop) return position
  if (position <= loop.startBeat) return position
  const length = loop.endBeat - loop.startBeat
  if (length <= 0.001) return position
  return loop.startBeat + ((position - loop.startBeat) % length)
}

/**
 * 把一段「时间轴位置区间」切分成若干「乐谱拍区间」。
 *
 * - 无循环：一段就够了；
 * - 有循环：循环区间之前的部分直通，之后按 loop 长度反复回绕，
 *   每次回绕都是一个独立的拍区间（调度器据此按不同 pass 触发同一批音符）。
 */
export function beatSegments(mapping: TimelineMapping, from: number, to: number): BeatSegment[] {
  const segments: BeatSegment[] = []
  if (!(to > from)) return segments
  const loop = mapping.loop
  if (!loop) {
    segments.push({ beatFrom: from, beatTo: to, positionFrom: from, positionTo: to })
    return segments
  }
  let start = from
  if (start < loop.startBeat) {
    const end = Math.min(to, loop.startBeat)
    segments.push({ beatFrom: start, beatTo: end, positionFrom: start, positionTo: end })
    if (end >= to) return segments
    start = loop.startBeat
  }
  const length = loop.endBeat - loop.startBeat
  if (length <= 0.001) {
    segments.push({ beatFrom: loop.startBeat, beatTo: loop.endBeat, positionFrom: start, positionTo: to })
    return segments
  }
  let pass = Math.floor((start - loop.startBeat) / length)
  for (let guard = 0; guard < 4096; guard++) {
    const passStart = loop.startBeat + pass * length
    const passEnd = passStart + length
    const segFrom = Math.max(start, passStart)
    const segTo = Math.min(to, passEnd)
    if (segFrom < segTo) {
      const beatFrom = loop.startBeat + (segFrom - passStart)
      segments.push({
        beatFrom,
        beatTo: beatFrom + (segTo - segFrom),
        positionFrom: segFrom,
        positionTo: segTo,
      })
    }
    if (passEnd >= to) break
    pass += 1
  }
  return segments
}

/**
 * 归一化播放起点：若循环开启且起点超过循环终点，按常见 DAW 习惯跳回循环起点；
 * 否则夹到 [0, endBeat]。
 */
export function normalizeStartBeat(beat: number, loop: LoopRegion | null, endBeat: number): number {
  let start = Math.max(0, beat)
  if (loop && loop.endBeat > loop.startBeat && start >= loop.endBeat) start = loop.startBeat
  return Math.min(start, endBeat)
}

/** 生成「下一次循环区间」——给预听 / UI 预览用 */
export function loopRegionOf(project: { loop?: { startBeat: number; endBeat: number } }): LoopRegion | null {
  const loop = project.loop
  if (!loop || loop.endBeat <= loop.startBeat) return null
  return { startBeat: Math.max(0, loop.startBeat), endBeat: loop.endBeat }
}
