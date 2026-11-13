/**
 * 轨道级纯逻辑规则（无 Tone / React / zustand 依赖，便于单测）。
 *
 * 这里集中「必须和界面 / 引擎 / 总控按钮共用一个真相」的判断：
 *
 * 1. `computeAudibleTrackIds` / `trackAudibility`：静音 / 独奏的可听判定。
 *    引擎按它决定每轨推子静音与音符索引，界面按它解释「为什么这条轨不出声」。
 * 2. 总控按钮的批量补丁：`soloTogglePatch` / `clearSoloPatch` / `muteAllPatch`。
 *    「按 S 要不要把别的轨 M 掉」的答案是**不要**：独奏只在运行期派生「隐式静音」，
 *    绝不把别人的 `mute` 写回工程（见 docs/TRACK_CONTROLS.md）。
 * 3. `resolveRecordTrackId` / `resolveRecordClipId`：MIDI 录入落到哪条轨、哪个片段。
 *    轨道头 R（录入预备）写的是 `armedTrackId`，录入路径必须优先用它，
 *    否则「预备了 A 轨、实际写进 B 轨」——这正是用户报的 R 不好用。
 */

/** 可听判定需要的最小轨道形状（静音 / 独奏） */
export interface AudibilityTrack {
  id: string
  mute?: boolean
  solo?: boolean
  /** 仅用于总控 tooltip / 提示文案，判定不依赖它 */
  name?: string
}

/**
 * 单条轨道当前的混音状态：
 *
 * - `audible`：正常出声；
 * - `muted`：用户显式按了 M（持久化在工程里）；
 * - `implicitly-muted`：别的轨道正在独奏，这条被「派生静音」。
 *   **它不是 mute**：工程里的 `mute` 仍然是 false，取消独奏后立刻恢复出声。
 */
export type TrackAudibility = 'audible' | 'muted' | 'implicitly-muted'

/** 工程里是否有任意一条轨道处于独奏（solo） */
export function hasAnySolo(tracks: readonly AudibilityTrack[]): boolean {
  return tracks.some((track) => Boolean(track.solo))
}

/**
 * 计算某条轨道当前的混音状态。
 *
 * 语义（与 Logic / Cubase / Studio One 一致）：
 * - 静音优先于独奏：被静音的轨道即使被独奏也不出声；
 * - 只要有任意一条轨道独奏，未独奏的轨道全部「隐式静音」；
 * - 允许多条轨道同时独奏（它们都出声）。
 */
export function trackAudibility(track: AudibilityTrack, anySolo: boolean): TrackAudibility {
  if (track.mute) return 'muted'
  if (anySolo && !track.solo) return 'implicitly-muted'
  return 'audible'
}

/** 这条轨道现在是否会出声（引擎 / 电平表 / 导出共用的判定） */
export function isTrackAudible(track: AudibilityTrack, anySolo: boolean): boolean {
  return trackAudibility(track, anySolo) === 'audible'
}

/**
 * 计算当前工程「能出声」的轨道集合。
 *
 * 语义（与 Logic / Cubase 一致）：
 * - 静音优先于独奏：被静音的轨道即使被独奏也不出声；
 * - 只要有任意一条轨道独奏，未独奏的轨道全部静音；
 * - 允许多条轨道同时独奏（它们都出声）；
 * - 没有任何独奏时，未静音的轨道全部出声。
 */
export function computeAudibleTrackIds(tracks: readonly AudibilityTrack[]): Set<string> {
  const anySolo = hasAnySolo(tracks)
  const audible = new Set<string>()
  for (const track of tracks) {
    if (isTrackAudible(track, anySolo)) audible.add(track.id)
  }
  return audible
}

/** 每轨混音状态的映射（界面一次性拿全：谁出声、谁被静音、谁被独奏压住） */
export function computeAudibilityMap(
  tracks: readonly AudibilityTrack[],
): Map<string, TrackAudibility> {
  const anySolo = hasAnySolo(tracks)
  const result = new Map<string, TrackAudibility>()
  for (const track of tracks) result.set(track.id, trackAudibility(track, anySolo))
  return result
}

/** 总控按钮 / 状态栏需要的汇总计数 */
export interface MixSummary {
  /** 显式静音（M）的轨道数 */
  mutedCount: number
  /** 正在独奏（S）的轨道数 */
  soloCount: number
  anySolo: boolean
}

export function summarizeMix(tracks: readonly AudibilityTrack[]): MixSummary {
  let mutedCount = 0
  let soloCount = 0
  for (const track of tracks) {
    if (track.mute) mutedCount++
    if (track.solo) soloCount++
  }
  return { mutedCount, soloCount, anySolo: soloCount > 0 }
}

/* ------------------------------------------------------------------ */
/* 批量补丁（纯函数）                                                    */
/*                                                                     */
/* store 只负责把补丁写回 draft：先算「应该变成什么」，再一次性 mutate，   */
/* 保证撤销栈只记一条、且这些规则可以被单测直接覆盖。                     */
/* ------------------------------------------------------------------ */

export interface FlagPatch {
  id: string
  mute?: boolean
  solo?: boolean
}

/**
 * 独奏按钮的补丁。
 *
 * - 普通点击：只切换自己（累加式，Logic / Cubase / Studio One 默认）；
 * - `exclusive`（按住 Alt/Option）：**自己独奏、清空其它所有独奏**。
 *   不会解掉自己的 M：静音优先于独奏是共识。
 */
export function soloTogglePatch(
  tracks: readonly AudibilityTrack[],
  trackId: string,
  options: { exclusive?: boolean } = {},
): FlagPatch[] {
  const target = tracks.find((track) => track.id === trackId)
  if (!target) return []
  if (options.exclusive) {
    /* 独占点一条「当前唯一在独奏」的轨：与 Logic 的 Option+click 一致——清空全部独奏 */
    if (target.solo && tracks.filter((track) => track.solo).length === 1) return clearSoloPatch(tracks)
    return tracks
      .filter((track) => Boolean(track.solo) !== (track.id === trackId))
      .map((track) => ({ id: track.id, solo: track.id === trackId }))
  }
  return [{ id: trackId, solo: !target.solo }]
}

/** 清除全部独奏（总控 S / 快捷键） */
export function clearSoloPatch(tracks: readonly AudibilityTrack[]): FlagPatch[] {
  return tracks.filter((track) => track.solo).map((track) => ({ id: track.id, solo: false }))
}

/** 全部静音 / 全部取消静音（总控 M） */
export function muteAllPatch(tracks: readonly AudibilityTrack[], muted: boolean): FlagPatch[] {
  return tracks.filter((track) => Boolean(track.mute) !== muted).map((track) => ({ id: track.id, mute: muted }))
}

/**
 * 总控 M 的点击语义：已有任意静音 → 全部取消静音；否则全部静音。
 * 返回 `muted` 目标值，方便调用方给出准确的提示文案。
 */
export function nextMuteAllValue(tracks: readonly AudibilityTrack[]): boolean {
  return !tracks.some((track) => Boolean(track.mute))
}

/* ------------------------------------------------------------------ */
/* 录入目标解析                                                          */
/* ------------------------------------------------------------------ */

/** 录入目标解析需要的「谁被选中 / 聚焦 / 预备」三态 */
export interface RecordArmState {
  /** 轨道头 R 预备的轨道（录入路径优先使用它） */
  armedTrackId?: string | null
  /** 当前聚焦轨道（钢琴卷帘 / MIDI Thru 跟随） */
  focusedTrackId?: string | null
  /** 当前选中轨道 */
  selectedTrackId?: string | null
}

/** 只取 id 的最小轨道形状 */
export interface TrackIdLike {
  id: string
}

/**
 * 解析 MIDI 录入 / 试听应该落在哪条轨道。
 *
 * 优先级：录入预备（R）> 聚焦轨道 > 选中轨道。
 * 已被删除的 id 会被跳过，避免指到不存在的轨道上静默失败。
 */
export function resolveRecordTrackId(
  state: RecordArmState,
  tracks: readonly TrackIdLike[],
): string | null {
  const exists = (id: string | null | undefined): id is string =>
    typeof id === 'string' && id.length > 0 && tracks.some((track) => track.id === id)
  if (exists(state.armedTrackId)) return state.armedTrackId
  if (exists(state.focusedTrackId)) return state.focusedTrackId
  if (exists(state.selectedTrackId)) return state.selectedTrackId
  return null
}

/** 录入目标片段需要的最小片段形状 */
export interface RecordClipLike {
  id: string
  muted?: boolean
}

/**
 * 解析录入应该写进哪条片段。
 *
 * - 已选片段属于目标轨道 → 写进它（尊重用户选择）；
 * - 否则退回到目标轨道上第一个未静音的片段（预备某轨后按键就能录，不必再选片段）；
 * - 轨道没有片段 → null（调用方应提示「先建片段」，而不是假装录进去了）。
 */
export function resolveRecordClipId(
  track: { clips: readonly RecordClipLike[] } | null | undefined,
  selectedClipId: string | null | undefined,
): string | null {
  if (!track) return null
  const clips = track.clips ?? []
  if (selectedClipId) {
    const selected = clips.find((clip) => clip.id === selectedClipId)
    if (selected) return selected.id
  }
  const usable = clips.find((clip) => !clip.muted)
  return usable ? usable.id : null
}
