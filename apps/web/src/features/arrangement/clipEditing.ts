/**
 * 编曲视图的片段级编辑操作（多选整体生效）。
 *
 * 为什么单独一层？
 * - 拖动 / 快捷键 / 命令面板 / 右键菜单必须共享同一套「移动哪些片段、撤销点在哪」的规则；
 * - 所有编辑都走 store.mutate：一次手势只产生一个撤销点，拖动过程中 history:false 避免撤销栈爆炸；
 * - 这里不碰 React，纯数据操作，方便被 ArrangementView 与后续的 DOM 验收脚本复用。
 */
import { deepClone, newId, type Clip, type Project } from '@aiab/core'
import { useStore } from '../../store/store'

/** 一个被选中的片段在工程里的位置（父级轨道 + 绝对起点） */
export interface ClipLocation {
  trackId: string
  clipId: string
  startBeat: number
  lengthBeats: number
  name: string
}

/** 复制到剪贴板的条目：偏移量相对「选区最早起点」，粘贴时对齐到播放头 */
export interface ClipboardEntry {
  trackId: string
  offsetBeats: number
  clip: Clip
}

const store = () => useStore.getState()

const tidy = (value: number) => Math.round(value * 1000) / 1000

/** 手势开始：压一个撤销点并标记工程已修改（后续批量更新用 history:false） */
export function beginEdit(): void {
  const state = store()
  state.pushHistory()
  state.setSaveStatus('dirty')
}

/** 按工程当前顺序定位片段（保持轨道/片段的自然顺序，便于复制粘贴后的层叠顺序稳定） */
export function locateClips(ids: string[], project: Project = store().project): ClipLocation[] {
  if (ids.length === 0) return []
  const wanted = new Set(ids)
  const out: ClipLocation[] = []
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (!wanted.has(clip.id)) continue
      out.push({
        trackId: track.id,
        clipId: clip.id,
        startBeat: clip.startBeat,
        lengthBeats: clip.lengthBeats,
        name: clip.name,
      })
    }
  }
  return out
}

/** 把选中的片段复制成剪贴板数据（相对选区最早起点归一化） */
export function copySelection(ids: string[]): ClipboardEntry[] {
  const locations = locateClips(ids)
  if (locations.length === 0) return []
  const project = store().project
  const minStart = Math.min(...locations.map((location) => location.startBeat))
  const entries: ClipboardEntry[] = []
  for (const location of locations) {
    const clip = project.tracks
      .find((track) => track.id === location.trackId)
      ?.clips.find((item) => item.id === location.clipId)
    if (!clip) continue
    entries.push({
      trackId: location.trackId,
      offsetBeats: tidy(location.startBeat - minStart),
      clip: deepClone(clip),
    })
  }
  return entries
}

/** 删除全部选中片段，返回删除数量（一个撤销点） */
export function deleteClips(ids: string[]): number {
  if (ids.length === 0) return 0
  const idSet = new Set(ids)
  let count = 0
  beginEdit()
  store().mutate(
    (draft) => {
      for (const track of draft.tracks) {
        const before = track.clips.length
        track.clips = track.clips.filter((clip) => !idSet.has(clip.id))
        count += before - track.clips.length
      }
    },
    { history: false },
  )
  return count
}

/** 复制选中片段到各自片段之后（⌘D 的语义），返回新片段 id */
export function duplicateClipsAfter(ids: string[]): string[] {
  const locations = locateClips(ids)
  if (locations.length === 0) return []
  beginEdit()
  const newIds: string[] = []
  store().mutate(
    (draft) => {
      for (const location of locations) {
        const track = draft.tracks.find((item) => item.id === location.trackId)
        const clip = track?.clips.find((item) => item.id === location.clipId)
        if (!track || !clip) continue
        const copy = deepClone(clip)
        copy.id = newId('c')
        copy.startBeat = tidy(clip.startBeat + clip.lengthBeats)
        copy.notes = copy.notes.map((note) => ({ ...note, id: newId('n') }))
        track.clips.push(copy)
        newIds.push(copy.id)
      }
    },
    { history: false },
  )
  return newIds
}

/**
 * Alt+拖拽：在原位复制一份并返回「原 id → 新 id」的映射。
 * 调用方负责先 beginEdit()；拖动过程中的移动只作用在新副本上。
 */
export function duplicateClipsInPlace(ids: string[]): { newIds: string[]; originalToNew: Map<string, string> } {
  const locations = locateClips(ids)
  const originalToNew = new Map<string, string>()
  if (locations.length === 0) return { newIds: [], originalToNew }
  store().mutate(
    (draft) => {
      for (const location of locations) {
        const track = draft.tracks.find((item) => item.id === location.trackId)
        const clip = track?.clips.find((item) => item.id === location.clipId)
        if (!track || !clip) continue
        const copy = deepClone(clip)
        copy.id = newId('c')
        copy.startBeat = clip.startBeat
        copy.notes = copy.notes.map((note) => ({ ...note, id: newId('n') }))
        track.clips.push(copy)
        originalToNew.set(clip.id, copy.id)
      }
    },
    { history: false },
  )
  const newIds = ids.map((id) => originalToNew.get(id)).filter((id): id is string => Boolean(id))
  return { newIds, originalToNew }
}

/** 拖动过程中把一批片段移动 deltaBeats（不产生撤销点，调用方已负责） */
export function moveClipsBy(ids: string[], deltaBeats: number): void {
  if (ids.length === 0 || !Number.isFinite(deltaBeats) || deltaBeats === 0) return
  const idSet = new Set(ids)
  store().mutate(
    (draft) => {
      for (const track of draft.tracks) {
        for (const clip of track.clips) {
          if (!idSet.has(clip.id)) continue
          clip.startBeat = tidy(Math.max(0, clip.startBeat + deltaBeats))
        }
      }
    },
    { history: false },
  )
}

/** 把一批片段在各自轨道内逐条拆分（在播放头处拆分命令用），返回拆分数量（一个撤销点） */
export function splitClipsAtBeat(ids: string[], beat: number): number {
  const locations = locateClips(ids).filter(
    (location) => beat > location.startBeat + 1e-6 && beat < location.startBeat + location.lengthBeats - 1e-6,
  )
  if (locations.length === 0) return 0
  beginEdit()
  store().mutate(
    (draft) => {
      for (const location of locations) {
        const track = draft.tracks.find((item) => item.id === location.trackId)
        if (!track) continue
        const index = track.clips.findIndex((item) => item.id === location.clipId)
        const clip = index >= 0 ? track.clips[index] : null
        if (!clip) continue
        const relative = tidy(beat - clip.startBeat)
        if (relative <= 0 || relative >= clip.lengthBeats) continue
        const left = deepClone(clip)
        const right = deepClone(clip)
        left.lengthBeats = relative
        left.notes = left.notes
          .filter((note) => note.start < relative)
          .map((note) => ({ ...note, duration: Math.min(note.duration, relative - note.start) }))
        right.id = newId('c')
        right.startBeat = tidy(beat)
        right.lengthBeats = tidy(clip.lengthBeats - relative)
        right.notes = right.notes
          .filter((note) => note.start + note.duration > relative)
          .map((note) => ({ ...note, id: newId('n'), start: tidy(Math.max(0, note.start - relative)) }))
        track.clips.splice(index, 1, left, right)
      }
    },
    { history: false },
  )
  return locations.length
}

/** 切片工具：在点击位置拆分单个片段（一个撤销点），返回是否成功 */
export function splitClipAtPoint(trackId: string, clipId: string, beat: number): boolean {
  const project = store().project
  const clip = project.tracks.find((track) => track.id === trackId)?.clips.find((item) => item.id === clipId)
  if (!clip) return false
  const relative = beat - clip.startBeat
  if (relative <= 1e-4 || relative >= clip.lengthBeats - 1e-4) return false
  beginEdit()
  store().mutate(
    (draft) => {
      const track = draft.tracks.find((item) => item.id === trackId)
      if (!track) return
      const index = track.clips.findIndex((item) => item.id === clipId)
      const target = index >= 0 ? track.clips[index] : null
      if (!target) return
      const rel = tidy(beat - target.startBeat)
      const left = deepClone(target)
      const right = deepClone(target)
      left.lengthBeats = rel
      left.notes = left.notes
        .filter((note) => note.start < rel)
        .map((note) => ({ ...note, duration: Math.min(note.duration, rel - note.start) }))
      right.id = newId('c')
      right.startBeat = tidy(beat)
      right.lengthBeats = tidy(target.lengthBeats - rel)
      right.notes = right.notes
        .filter((note) => note.start + note.duration > rel)
        .map((note) => ({ ...note, id: newId('n'), start: tidy(Math.max(0, note.start - rel)) }))
      track.clips.splice(index, 1, left, right)
    },
    { history: false },
  )
  return true
}

/** 量化选中片段的全部音符到网格（一个撤销点），返回处理音符数 */
export function quantizeClips(ids: string[], grid: number): number {
  if (ids.length === 0 || !(grid > 0)) return 0
  const idSet = new Set(ids)
  let count = 0
  beginEdit()
  store().mutate(
    (draft) => {
      for (const track of draft.tracks) {
        for (const clip of track.clips) {
          if (!idSet.has(clip.id)) continue
          for (const note of clip.notes) {
            note.start = tidy(Math.round(note.start / grid) * grid)
            note.duration = Math.max(grid, tidy(Math.round(note.duration / grid) * grid))
            count += 1
          }
        }
      }
    },
    { history: false },
  )
  return count
}

/** 移调选中片段（编曲视图的 transpose 命令），返回处理音符数 */
export function transposeClips(ids: string[], semitones: number): number {
  if (ids.length === 0 || !semitones) return 0
  const idSet = new Set(ids)
  let count = 0
  beginEdit()
  store().mutate(
    (draft) => {
      for (const track of draft.tracks) {
        for (const clip of track.clips) {
          if (!idSet.has(clip.id)) continue
          for (const note of clip.notes) {
            note.pitch = Math.max(0, Math.min(127, note.pitch + semitones))
            count += 1
          }
        }
      }
    },
    { history: false },
  )
  return count
}

/** 方向键微移选中片段（每次按键一个撤销点） */
export function nudgeClips(ids: string[], beats: number): void {
  if (ids.length === 0 || !beats) return
  beginEdit()
  moveClipsBy(ids, beats)
}

/** 粘贴到指定位置（播放头），返回新片段 id；必要时会落到第一条轨道 */
export function pasteClipboard(entries: ClipboardEntry[], atBeat: number): string[] {
  if (entries.length === 0) return []
  const project = store().project
  if (project.tracks.length === 0) return []
  beginEdit()
  const newIds: string[] = []
  store().mutate(
    (draft) => {
      for (const entry of entries) {
        const track = draft.tracks.find((item) => item.id === entry.trackId) ?? draft.tracks[0]
        if (!track) continue
        const copy = deepClone(entry.clip)
        copy.id = newId('c')
        copy.trackId = track.id
        copy.startBeat = tidy(Math.max(0, atBeat + entry.offsetBeats))
        copy.notes = copy.notes.map((note) => ({ ...note, id: newId('n') }))
        track.clips.push(copy)
        newIds.push(copy.id)
      }
    },
    { history: false },
  )
  return newIds
}
