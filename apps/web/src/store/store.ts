import { create } from 'zustand'
import {
  beatsPerBar,
  composeProject,
  createClip,
  createEmptyProject,
  createNote,
  createTrack,
  deepClone,
  generateSmartClip,
  getInstrument,
  newId,
  projectEndBar,
  projectEndBeat,
  type ChordSpec,
  type Clip,
  type NoteEvent,
  type Project,
  type ScaleId,
  type Section,
  type SmartKind,
  type SmartParams,
  type TimeSignature,
  type Track,
} from '@aiab/core'
import type {
  ChatMessage,
  ProjectHistoryEntry,
  SaveStatus,
  SelectionState,
  ToastItem,
  ToolCallInfo,
  ViewTab,
} from './types'
import {
  clearSoloPatch,
  computeAudibleTrackIds as computeAudibleIds,
  muteAllPatch,
  nextMuteAllValue,
  soloTogglePatch,
  type FlagPatch,
} from '../lib/trackRules'

const MAX_HISTORY = 80

/* ------------------------------------------------------------------ */
/* 初始工程                                                            */
/* ------------------------------------------------------------------ */

/** 首次打开时的示例工程：8 小节流行编曲，方便立刻听到声音 */
export function createStarterProject(): Project {
  try {
    const project = composeProject({ style: 'pop', key: 'C', scale: 'major', tempo: 108, bars: 8, seed: 20482 })
    project.name = '我的第一首编曲'
    if (project.tracks.length === 0) return minimalProject()
    return project
  } catch (err) {
    console.warn('[store] 生成示例工程失败，回退为空工程', err)
    return minimalProject()
  }
}

function minimalProject(): Project {
  const project = createEmptyProject({ name: '未命名工程', style: 'pop' })
  const piano = createTrack({ instrumentId: 'piano.grand', emotionId: 'warm', name: '钢琴', color: '#f0b429' })
  piano.clips = [
    createClip({
      trackId: piano.id,
      name: '钢琴',
      startBeat: 0,
      lengthBeats: 16,
      notes: [
        createNote(60, 0, 1, 96),
        createNote(64, 1, 1, 88),
        createNote(67, 2, 1, 92),
        createNote(72, 3, 1, 84),
      ],
    }),
  ]
  project.tracks = [piano]
  project.sections = [{ id: newId('s'), name: '主歌', startBar: 0, bars: 4, energy: 0.5 }]
  return project
}

/* ------------------------------------------------------------------ */
/* 状态定义                                                            */
/* ------------------------------------------------------------------ */

export interface AppState {
  /* 工程 */
  project: Project
  past: Project[]
  future: Project[]
  /** AI 修改前的快照，用于「撤销 AI 的改动」 */
  aiUndoSnapshot: Project | null

  /* 选择 / 视图 */
  view: ViewTab
  selectedTrackId: string
  focusedTrackId: string
  selection: SelectionState
  /** 拍网格吸附：0 = 关闭，0.25 = 十六分音符 */
  snap: number
  zoomX: number
  zoomY: number
  /** 时间轴左端可见起点（拍） */
  scrollBeat: number
  showMixer: boolean
  chatOpen: boolean
  settingsOpen: boolean
  exportOpen: boolean
  helpOpen: boolean
  /** 智能片段编辑器聚焦的片段 */
  smartClipTarget: { trackId: string; clipId: string } | null
  /** 编曲视图的「滚进视野」请求（只用于 UI，不持久化） */
  revealRequest: { trackId: string; beat?: number; token: number } | null

  /* 走带 */
  isPlaying: boolean
  playhead: number
  loopEnabled: boolean
  metronome: boolean
  countIn: boolean
  masterLevel: number

  /* 持久化 */
  saveStatus: SaveStatus
  lastSavedAt: number
  projectListVersion: number

  /* AI 对话 */
  messages: ChatMessage[]
  aiBusy: boolean
  aiError: string | null
  activeRunId: string | null
  /** 用户偏好的一次性提示词 */
  pendingPrompt: string | null

  /* 其它 */
  toasts: ToastItem[]
  midiDevices: { id: string; name: string }[]
  midiActiveId: string | null
  midiLastPitch: number | null
  /** MIDI 键盘实时录入开关（钢琴卷帘中把弹奏写入当前片段） */
  midiRecord: boolean
  soundfontStatus: { loaded: boolean; name: string; loading: boolean; error: string | null }
  ready: boolean
}

export interface AppActions {
  /* 通用编辑 */
  mutate: (recipe: (draft: Project) => void, opts?: { history?: boolean }) => void
  pushHistory: () => void
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean
  setProject: (project: Project, opts?: { resetHistory?: boolean; dirty?: boolean }) => void
  patchProject: (partial: Partial<Project>, opts?: { history?: boolean }) => void

  /* 轨道 */
  addTrack: (track?: Partial<Track> & { instrumentId?: string; emotionId?: string }) => string
  removeTrack: (trackId: string) => void
  updateTrack: (trackId: string, partial: Partial<Track>, opts?: { history?: boolean }) => void
  duplicateTrack: (trackId: string) => void
  moveTrack: (trackId: string, direction: -1 | 1) => void
  setTrackInstrument: (trackId: string, instrumentId: string, emotionId?: string) => void
  toggleMute: (trackId: string) => void
  /** 显式设置静音（不被其它标志位连带修改） */
  setTrackMuted: (trackId: string, muted: boolean) => void
  /** 切换独奏；`exclusive` = Alt/Option 点击：清空其它独奏、只留这条 */
  toggleSolo: (trackId: string, opts?: { exclusive?: boolean }) => void
  setTrackSolo: (trackId: string, solo: boolean, opts?: { exclusive?: boolean }) => void
  /** 总控 M：任意静音 → 全部取消；否则全部静音。返回切换后的状态 */
  toggleMuteAll: () => boolean
  setAllMuted: (muted: boolean) => void
  /** 总控 S：清空全部独奏（不动任何 mute） */
  clearAllSolos: () => void

  /* 片段 */
  addClip: (trackId: string, partial?: Partial<Clip>) => string | null
  updateClip: (trackId: string, clipId: string, partial: Partial<Clip>, opts?: { history?: boolean }) => void
  removeClip: (trackId: string, clipId: string) => void
  duplicateClip: (trackId: string, clipId: string) => void
  splitClipAt: (trackId: string, clipId: string, beat: number) => void

  /* 音符 */
  addNotes: (trackId: string, clipId: string, notes: NoteEvent[], opts?: { history?: boolean }) => void
  updateNotes: (
    trackId: string,
    clipId: string,
    noteIds: string[],
    patch: Partial<NoteEvent>,
    opts?: { history?: boolean },
  ) => void
  removeNotes: (trackId: string, clipId: string, noteIds: string[], opts?: { history?: boolean }) => void
  replaceClipNotes: (trackId: string, clipId: string, notes: NoteEvent[], opts?: { history?: boolean }) => void
  quantizeClip: (trackId: string, clipId: string, grid: number) => void
  transposeNotes: (trackId: string, clipId: string, noteIds: string[], semitones: number) => void
  nudgeNotes: (trackId: string, clipId: string, noteIds: string[], beats: number, semitones: number) => void

  /* 智能片段 */
  regenerateSmartClip: (trackId: string, clipId: string, seedDelta?: number) => void
  createSmartClip: (trackId: string, kind: SmartKind, params?: Partial<SmartParams>, startBeat?: number) => string | null
  updateSmartParams: (trackId: string, clipId: string, params: Partial<SmartParams>, opts?: { history?: boolean }) => void
  setSmartClipTarget: (target: { trackId: string; clipId: string } | null) => void

  /* 工程级 */
  setTempo: (bpm: number) => void
  setTimeSignature: (ts: TimeSignature) => void
  setKeyScale: (key: string, scale: ScaleId) => void
  setSwing: (swing: number) => void
  setMasterVolume: (v: number) => void
  setProjectName: (name: string) => void
  setChords: (chords: ChordSpec[]) => void
  setSections: (sections: Section[]) => void
  addSection: (section: Section) => void
  removeSection: (sectionId: string) => void

  /* 选择 / 视图 */
  setView: (view: ViewTab) => void
  selectTrack: (trackId: string) => void
  /** 只切焦点（不改变当前片段选择）：录入预备要用它，避免把用户已选的片段顶掉 */
  focusTrack: (trackId: string) => void
  selectClip: (trackId: string, clipId: string) => void
  setSelectedNotes: (noteIds: string[]) => void
  toggleNoteSelection: (noteId: string) => void
  clearSelection: () => void
  setSnap: (snap: number) => void
  setZoom: (zoomX?: number, zoomY?: number) => void
  setScrollBeat: (beat: number) => void
  setShowMixer: (show: boolean) => void
  /** 请求编曲视图把某条轨 / 某个拍位置滚进视野（AI 落轨后自动定位） */
  requestReveal: (trackId: string, beat?: number) => void

  /* 走带 */
  setPlaying: (playing: boolean) => void
  setPlayhead: (beat: number) => void
  setLoopEnabled: (enabled: boolean) => void
  setLoopRange: (startBeat: number, endBeat: number) => void
  setMetronome: (on: boolean) => void
  setCountIn: (on: boolean) => void
  setMasterLevel: (level: number) => void
  stopTransport: () => void

  /* 面板开关 */
  setChatOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
  setExportOpen: (open: boolean) => void
  setHelpOpen: (open: boolean) => void

  /* 持久化 */
  setSaveStatus: (status: SaveStatus) => void
  bumpProjectListVersion: () => void

  /* AI */
  addMessage: (message: Omit<ChatMessage, 'id' | 'createdAt'> & { id?: string }) => string
  appendToMessage: (messageId: string, delta: string, field?: 'content' | 'reasoning') => void
  patchMessage: (messageId: string, patch: Partial<ChatMessage>) => void
  addToolCall: (messageId: string, call: ToolCallInfo) => void
  finishToolCall: (messageId: string, callId: string, ok: boolean, result?: string, error?: string) => void
  setAiBusy: (busy: boolean, runId?: string | null) => void
  setAiError: (error: string | null) => void
  clearMessages: () => void
  applyAgentProject: (project: Project, label: string) => void
  undoAiChanges: () => void
  setPendingPrompt: (prompt: string | null) => void

  /* 工具 */
  pushToast: (kind: ToastItem['kind'], message: string) => void
  dismissToast: (id: string) => void
  setMidiDevices: (devices: { id: string; name: string }[], activeId: string | null) => void
  setMidiActiveId: (id: string | null) => void
  setMidiLastPitch: (pitch: number | null) => void
  setMidiRecord: (record: boolean) => void
  setSoundfontStatus: (status: Partial<AppState['soundfontStatus']>) => void
  setReady: (ready: boolean) => void
}

export type Store = AppState & AppActions

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

function findTrack(project: Project, trackId: string): Track | undefined {
  return project.tracks.find((t) => t.id === trackId)
}

function findClip(project: Project, trackId: string, clipId: string): Clip | undefined {
  return findTrack(project, trackId)?.clips.find((c) => c.id === clipId)
}

function clone<T>(value: T): T {
  return deepClone(value)
}

/**
 * 批量写回静音 / 独奏标志位。
 *
 * 单独抽出来是为了三件事共用同一条写入路径：
 * 单轨 M / S、总控 M（全部静音）、总控 S（清空独奏）。
 *
 * - **一条撤销记录**：先 pushHistory 再 history:false 写入，避免总控操作把
 *   撤销栈刷成几十条单轨记录（Studio One / Logic 的总控都是一次可撤销）；
 * - **dirty**：`mutate` 在 `history:false` 时不会把工程标脏，这里补上，
 *   否则 M/S 改动可能不会被自动保存（历史遗留 bug：命令面板静音不入盘）。
 * - 空补丁直接返回：没有任何变化时不产生撤销点。
 */
function applyFlagPatches(project: Project, patches: readonly FlagPatch[]): void {
  if (patches.length === 0) return
  const store = useStore.getState()
  store.pushHistory()
  store.mutate(
    (draft) => {
      for (const patch of patches) {
        const track = draft.tracks.find((item) => item.id === patch.id)
        if (!track) continue
        if (typeof patch.mute === 'boolean') track.mute = patch.mute
        if (typeof patch.solo === 'boolean') track.solo = patch.solo
      }
    },
    { history: false },
  )
  useStore.getState().setSaveStatus('dirty')
}

const initialProject = createStarterProject()

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export const useStore = create<Store>((set, get) => ({
  /* ---------------- 初始状态 ---------------- */
  project: initialProject,
  past: [],
  future: [],
  aiUndoSnapshot: null,

  view: 'arrangement',
  selectedTrackId: initialProject.tracks[0]?.id ?? '',
  focusedTrackId: initialProject.tracks[0]?.id ?? '',
  selection: { clipId: initialProject.tracks[0]?.clips[0]?.id ?? null, noteIds: [] },
  snap: 0.25,
  zoomX: 64,
  zoomY: 16,
  scrollBeat: 0,
  showMixer: false,
  chatOpen: true,
  settingsOpen: false,
  exportOpen: false,
  helpOpen: false,
  smartClipTarget: null,
  revealRequest: null,

  isPlaying: false,
  playhead: 0,
  loopEnabled: false,
  metronome: false,
  countIn: false,
  masterLevel: 0,

  saveStatus: 'idle',
  lastSavedAt: 0,
  projectListVersion: 0,

  messages: [],
  aiBusy: false,
  aiError: null,
  activeRunId: null,
  pendingPrompt: null,

  toasts: [],
  midiDevices: [],
  midiActiveId: null,
  midiLastPitch: null,
  midiRecord: false,
  soundfontStatus: { loaded: false, name: '', loading: false, error: null },
  ready: false,

  /* ---------------- 通用编辑 ---------------- */
  mutate: (recipe, opts) => {
    const state = get()
    const before = state.project
    const draft = clone(before)
    recipe(draft)
    draft.updatedAt = Date.now()
    const recordHistory = opts?.history !== false
    set({
      project: draft,
      past: recordHistory ? [...state.past, before].slice(-MAX_HISTORY) : state.past,
      future: recordHistory ? [] : state.future,
      saveStatus: recordHistory ? 'dirty' : state.saveStatus,
    })
  },

  pushHistory: () => {
    const state = get()
    set({ past: [...state.past, clone(state.project)].slice(-MAX_HISTORY), future: [] })
  },

  undo: () => {
    const { past, project, future } = get()
    if (past.length === 0) return
    const previous = past[past.length - 1]
    set({
      project: previous,
      past: past.slice(0, -1),
      future: [project, ...future].slice(0, MAX_HISTORY),
      saveStatus: 'dirty',
      selectedTrackId: previous.tracks.some((t) => t.id === get().selectedTrackId)
        ? get().selectedTrackId
        : (previous.tracks[0]?.id ?? ''),
    })
  },

  redo: () => {
    const { past, project, future } = get()
    if (future.length === 0) return
    const next = future[0]
    set({
      project: next,
      past: [...past, project].slice(-MAX_HISTORY),
      future: future.slice(1),
      saveStatus: 'dirty',
    })
  },

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  setProject: (project, opts) => {
    set({
      project,
      past: opts?.resetHistory === false ? get().past : [],
      future: [],
      selectedTrackId: project.tracks[0]?.id ?? '',
      focusedTrackId: project.tracks[0]?.id ?? '',
      selection: { clipId: project.tracks[0]?.clips[0]?.id ?? null, noteIds: [] },
      playhead: 0,
      saveStatus: opts?.dirty === false ? 'saved' : 'dirty',
    })
  },

  patchProject: (partial, opts) => {
    get().mutate((draft) => {
      Object.assign(draft, partial)
    }, opts)
  },

  /* ---------------- 轨道 ---------------- */
  addTrack: (input) => {
    const instrumentId = input?.instrumentId ?? 'piano.grand'
    const inst = getInstrument(instrumentId)
    const emotionId =
      input?.emotionId && inst.emotions.some((e) => e.id === input.emotionId) ? input.emotionId : inst.emotions[0].id
    const track = createTrack({
      instrumentId: inst.id,
      emotionId,
      name: input?.name ?? inst.name,
      color: input?.color ?? inst.emotions[0].color,
      kind: inst.isDrumKit ? 'drum' : 'instrument',
      gmProgram: inst.gmProgram,
      ...input,
    })
    get().mutate((draft) => {
      draft.tracks.push(track)
    })
    set({ selectedTrackId: track.id, focusedTrackId: track.id })
    return track.id
  },

  removeTrack: (trackId) => {
    get().mutate((draft) => {
      draft.tracks = draft.tracks.filter((t) => t.id !== trackId)
    })
    const state = get()
    if (state.selectedTrackId === trackId) {
      const next = state.project.tracks[0]?.id ?? ''
      set({ selectedTrackId: next, focusedTrackId: next, selection: { clipId: null, noteIds: [] } })
    }
  },

  updateTrack: (trackId, partial, opts) => {
    get().mutate((draft) => {
      const track = findTrack(draft, trackId)
      if (track) Object.assign(track, partial)
    }, opts)
  },

  duplicateTrack: (trackId) => {
    const source = findTrack(get().project, trackId)
    if (!source) return
    const copy = clone(source)
    copy.id = newId('t')
    copy.name = `${source.name} 2`
    copy.clips = copy.clips.map((c) => ({ ...c, id: newId('c'), trackId: copy.id, notes: c.notes.map((n) => ({ ...n, id: newId('n') })) }))
    /* 音频片段同样要换 id + 指向新轨道（否则会和原轨道共用 Player，播放时互相打断） */
    copy.audioClips = (copy.audioClips ?? []).map((clip) => ({ ...clip, id: newId('ac'), trackId: copy.id }))
    get().mutate((draft) => {
      const index = draft.tracks.findIndex((t) => t.id === trackId)
      draft.tracks.splice(index + 1, 0, copy)
    })
    set({ selectedTrackId: copy.id, focusedTrackId: copy.id })
  },

  moveTrack: (trackId, direction) => {
    get().mutate((draft) => {
      const index = draft.tracks.findIndex((t) => t.id === trackId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= draft.tracks.length) return
      const [track] = draft.tracks.splice(index, 1)
      draft.tracks.splice(target, 0, track)
    })
  },

  setTrackInstrument: (trackId, instrumentId, emotionId) => {
    const inst = getInstrument(instrumentId)
    const resolvedEmotion =
      emotionId && inst.emotions.some((e) => e.id === emotionId) ? emotionId : inst.emotions[0].id
    get().mutate((draft) => {
      const track = findTrack(draft, trackId)
      if (!track) return
      track.instrumentId = instrumentId
      track.emotionId = resolvedEmotion
      track.gmProgram = inst.gmProgram
      track.kind = inst.isDrumKit ? 'drum' : 'instrument'
    })
    // 改哪条轨的音色，就把焦点移到哪条轨：MIDI 键盘试听 / 录入都应跟着这条轨走
    if (get().focusedTrackId !== trackId) {
      set((state) => ({
        selectedTrackId: trackId,
        focusedTrackId: trackId,
        selection: {
          clipId: findTrack(state.project, trackId)?.clips[0]?.id ?? state.selection.clipId,
          noteIds: [],
        },
      }))
    }
  },

  /*
   * 静音 / 独奏：显式标志位，互不吞并。
   *
   * 「按 S 之后要不要把其它轨道都 M 掉」——不。独奏只在运行期派生「隐式静音」
   * （见 lib/trackRules.trackAudibility），别人的 `mute` 一个字节都不写回工程；
   * 取消独奏后原来的静音状态原样恢复。这条规则和 Logic / Cubase / Studio One 一致，
   * 也避免了「solo 一圈之后静音全乱」的经典抱怨。
   *
   * 批量版本（总控 M → 全部静音 / 总控 S → 清空独奏）走同一个 applyFlagPatches：
   * 一次 mutate 只产生**一个**撤销点，不会在历史里堆出一串单轨操作。
   */
  toggleMute: (trackId) => {
    const state = get()
    const track = findTrack(state.project, trackId)
    if (!track) return
    applyFlagPatches(state.project, [{ id: trackId, mute: !track.mute }])
  },

  setTrackMuted: (trackId, muted) => {
    const state = get()
    const track = findTrack(state.project, trackId)
    if (!track || Boolean(track.mute) === muted) return
    applyFlagPatches(state.project, [{ id: trackId, mute: muted }])
  },

  toggleSolo: (trackId, opts) => {
    const state = get()
    applyFlagPatches(state.project, soloTogglePatch(state.project.tracks, trackId, opts))
  },

  setTrackSolo: (trackId, solo, opts) => {
    const state = get()
    const track = findTrack(state.project, trackId)
    if (!track) return
    if (opts?.exclusive && solo) {
      applyFlagPatches(state.project, soloTogglePatch(state.project.tracks, trackId, { exclusive: true }))
      return
    }
    if (Boolean(track.solo) === solo) return
    applyFlagPatches(state.project, [{ id: trackId, solo }])
  },

  /* 总控 M：一次切换全工程的显式静音（已全部静音 → 全部取消） */
  toggleMuteAll: () => {
    const state = get()
    const tracks = state.project.tracks
    if (tracks.length === 0) return false
    const muted = nextMuteAllValue(tracks)
    applyFlagPatches(state.project, muteAllPatch(tracks, muted))
    return muted
  },

  setAllMuted: (muted) => {
    const state = get()
    applyFlagPatches(state.project, muteAllPatch(state.project.tracks, muted))
  },

  /* 总控 S：清空全部独奏（Studio One 的 Solo Clear；不会动任何 mute） */
  clearAllSolos: () => {
    const state = get()
    applyFlagPatches(state.project, clearSoloPatch(state.project.tracks))
  },

  /* ---------------- 片段 ---------------- */
  addClip: (trackId, partial) => {
    const track = findTrack(get().project, trackId)
    if (!track) return null
    const barBeats = beatsPerBar(get().project.timeSignature)
    const clip = createClip({
      trackId,
      name: partial?.name ?? '新片段',
      startBeat: partial?.startBeat ?? 0,
      lengthBeats: partial?.lengthBeats ?? barBeats * 2,
      notes: partial?.notes ?? [],
      smart: partial?.smart,
      muted: partial?.muted,
      color: partial?.color,
      id: partial?.id,
    })
    get().mutate((draft) => {
      const target = findTrack(draft, trackId)
      target?.clips.push(clip)
    })
    set({ selection: { clipId: clip.id, noteIds: [] } })
    return clip.id
  },

  updateClip: (trackId, clipId, partial, opts) => {
    get().mutate((draft) => {
      const clip = findClip(draft, trackId, clipId)
      if (clip) Object.assign(clip, partial)
    }, opts)
  },

  removeClip: (trackId, clipId) => {
    get().mutate((draft) => {
      const track = findTrack(draft, trackId)
      if (track) track.clips = track.clips.filter((c) => c.id !== clipId)
    })
    if (get().selection.clipId === clipId) set({ selection: { clipId: null, noteIds: [] } })
  },

  duplicateClip: (trackId, clipId) => {
    const clip = findClip(get().project, trackId, clipId)
    if (!clip) return
    const copy = clone(clip)
    copy.id = newId('c')
    copy.startBeat = clip.startBeat + clip.lengthBeats
    copy.notes = copy.notes.map((n) => ({ ...n, id: newId('n') }))
    get().mutate((draft) => {
      findTrack(draft, trackId)?.clips.push(copy)
    })
    set({ selection: { clipId: copy.id, noteIds: [] } })
  },

  splitClipAt: (trackId, clipId, beat) => {
    const clip = findClip(get().project, trackId, clipId)
    if (!clip) return
    const relative = beat - clip.startBeat
    if (relative <= 0 || relative >= clip.lengthBeats) return
    const left = clone(clip)
    const right = clone(clip)
    left.lengthBeats = relative
    left.notes = left.notes.filter((n) => n.start < relative).map((n) => ({ ...n, duration: Math.min(n.duration, relative - n.start) }))
    right.id = newId('c')
    right.startBeat = beat
    right.lengthBeats = clip.lengthBeats - relative
    right.notes = right.notes
      .filter((n) => n.start + n.duration > relative)
      .map((n) => ({ ...n, id: newId('n'), start: Math.max(0, n.start - relative) }))
    get().mutate((draft) => {
      const track = findTrack(draft, trackId)
      if (!track) return
      const index = track.clips.findIndex((c) => c.id === clipId)
      if (index < 0) return
      track.clips.splice(index, 1, left, right)
    })
  },

  /* ---------------- 音符 ---------------- */
  addNotes: (trackId, clipId, notes, opts) => {
    get().mutate((draft) => {
      const clip = findClip(draft, trackId, clipId)
      if (!clip) return
      clip.notes.push(...notes)
    }, opts)
  },

  updateNotes: (trackId, clipId, noteIds, patch, opts) => {
    const idSet = new Set(noteIds)
    get().mutate((draft) => {
      const clip = findClip(draft, trackId, clipId)
      if (!clip) return
      for (const note of clip.notes) {
        if (idSet.has(note.id)) Object.assign(note, patch)
      }
    }, opts)
  },

  removeNotes: (trackId, clipId, noteIds, opts) => {
    const idSet = new Set(noteIds)
    get().mutate((draft) => {
      const clip = findClip(draft, trackId, clipId)
      if (!clip) return
      clip.notes = clip.notes.filter((n) => !idSet.has(n.id))
    }, opts)
    set((state) => ({ selection: { ...state.selection, noteIds: state.selection.noteIds.filter((id) => !idSet.has(id)) } }))
  },

  replaceClipNotes: (trackId, clipId, notes, opts) => {
    get().mutate((draft) => {
      const clip = findClip(draft, trackId, clipId)
      if (clip) clip.notes = notes
    }, opts)
  },

  quantizeClip: (trackId, clipId, grid) => {
    if (grid <= 0) return
    get().mutate((draft) => {
      const clip = findClip(draft, trackId, clipId)
      if (!clip) return
      for (const note of clip.notes) {
        note.start = Math.round(note.start / grid) * grid
        note.duration = Math.max(grid, Math.round(note.duration / grid) * grid)
      }
    })
  },

  transposeNotes: (trackId, clipId, noteIds, semitones) => {
    const idSet = new Set(noteIds)
    get().mutate((draft) => {
      const clip = findClip(draft, trackId, clipId)
      if (!clip) return
      for (const note of clip.notes) {
        if (idSet.has(note.id)) note.pitch = Math.max(0, Math.min(127, note.pitch + semitones))
      }
    })
  },

  nudgeNotes: (trackId, clipId, noteIds, beats, semitones) => {
    const idSet = new Set(noteIds)
    get().mutate((draft) => {
      const clip = findClip(draft, trackId, clipId)
      if (!clip) return
      for (const note of clip.notes) {
        if (!idSet.has(note.id)) continue
        note.start = Math.max(0, note.start + beats)
        note.pitch = Math.max(0, Math.min(127, note.pitch + semitones))
      }
    }, { history: false })
  },

  /* ---------------- 智能片段 ---------------- */
  regenerateSmartClip: (trackId, clipId, seedDelta = 1) => {
    const { project } = get()
    const clip = findClip(project, trackId, clipId)
    const track = findTrack(project, trackId)
    if (!clip?.smart || !track) return
    const seed = (clip.smart.seed + seedDelta * 0x9e3779b9) >>> 0
    const barBeats = beatsPerBar(project.timeSignature)
    const bars = Math.max(1, Math.round(clip.lengthBeats / barBeats))
    const notes = generateSmartClip({
      kind: clip.smart.kind,
      style: clip.smart.style,
      key: clip.smart.key ?? project.key,
      scale: clip.smart.scale ?? project.scale,
      tempo: project.tempo,
      timeSignature: project.timeSignature,
      bars,
      params: { ...clip.smart.params, bars },
      chords: project.chords,
      seed,
      reference: undefined,
      range: getInstrument(track.instrumentId).range,
    })
    get().mutate((draft) => {
      const target = findClip(draft, trackId, clipId)
      if (!target?.smart) return
      target.smart.seed = seed
      target.notes = notes
    })
  },

  createSmartClip: (trackId, kind, params, startBeat = 0) => {
    const { project } = get()
    const track = findTrack(project, trackId)
    if (!track) return null
    const barBeats = beatsPerBar(project.timeSignature)
    const merged: SmartParams = {
      bars: params?.bars ?? 4,
      density: params?.density ?? 0.55,
      complexity: params?.complexity ?? 0.5,
      energy: params?.energy ?? 0.6,
      octave: params?.octave ?? 4,
      swing: params?.swing ?? (project.swing > 0 ? project.swing : 0),
      humanize: params?.humanize ?? 0.22,
      gate: params?.gate ?? 0.85,
      patternId: params?.patternId,
      followChords: params?.followChords ?? true,
    }
    const seed = Math.floor(Math.random() * 0xffffffff)
    const notes = generateSmartClip({
      kind,
      style: 'pop',
      key: project.key,
      scale: project.scale,
      tempo: project.tempo,
      timeSignature: project.timeSignature,
      bars: merged.bars,
      params: merged,
      chords: project.chords,
      seed,
      range: getInstrument(track.instrumentId).range,
    })
    const clip = createClip({
      trackId,
      name: `智能${kind}`,
      startBeat,
      lengthBeats: merged.bars * barBeats,
      notes,
      smart: { kind, style: 'pop', seed, params: merged, key: project.key, scale: project.scale },
    })
    get().mutate((draft) => {
      findTrack(draft, trackId)?.clips.push(clip)
    })
    set({ selection: { clipId: clip.id, noteIds: [] } })
    return clip.id
  },

  updateSmartParams: (trackId, clipId, params, opts) => {
    const { project } = get()
    const clip = findClip(project, trackId, clipId)
    if (!clip?.smart) return
    const seed = clip.smart.seed
    const merged = { ...clip.smart.params, ...params }
    const barBeats = beatsPerBar(project.timeSignature)
    const bars = Math.max(1, Math.round(clip.lengthBeats / barBeats))
    const track = findTrack(project, trackId)
    const notes = generateSmartClip({
      kind: clip.smart.kind,
      style: clip.smart.style,
      key: clip.smart.key ?? project.key,
      scale: clip.smart.scale ?? project.scale,
      tempo: project.tempo,
      timeSignature: project.timeSignature,
      bars,
      params: { ...merged, bars },
      chords: project.chords,
      seed,
      range: track ? getInstrument(track.instrumentId).range : undefined,
    })
    get().mutate((draft) => {
      const target = findClip(draft, trackId, clipId)
      if (!target?.smart) return
      target.smart.params = merged
      target.notes = notes
    }, opts)
  },

  setSmartClipTarget: (target) => set({ smartClipTarget: target }),

  /* ---------------- 工程级 ---------------- */
  setTempo: (bpm) => get().mutate((draft) => { draft.tempo = Math.max(20, Math.min(320, bpm)) }),
  setTimeSignature: (ts) => get().mutate((draft) => { draft.timeSignature = ts }),
  setKeyScale: (key, scale) => get().mutate((draft) => { draft.key = key; draft.scale = scale }),
  setSwing: (swing) => get().mutate((draft) => { draft.swing = Math.max(0, Math.min(1, swing)) }, { history: false }),
  setMasterVolume: (v) => get().mutate((draft) => { draft.masterVolume = Math.max(0, Math.min(1.5, v)) }, { history: false }),
  setProjectName: (name) => get().mutate((draft) => { draft.name = name }),
  setChords: (chords) => get().mutate((draft) => { draft.chords = chords }),
  setSections: (sections) => get().mutate((draft) => { draft.sections = sections }),
  addSection: (section) => get().mutate((draft) => { draft.sections.push(section) }),
  removeSection: (sectionId) =>
    get().mutate((draft) => {
      draft.sections = draft.sections.filter((s) => s.id !== sectionId)
    }),

  /* ---------------- 选择 / 视图 ---------------- */
  setView: (view) => set({ view }),
  selectTrack: (trackId) => {
    const track = findTrack(get().project, trackId)
    set({
      selectedTrackId: trackId,
      focusedTrackId: trackId,
      selection: { clipId: track?.clips[0]?.id ?? null, noteIds: [] },
    })
  },
  selectClip: (trackId, clipId) => set({ selectedTrackId: trackId, focusedTrackId: trackId, selection: { clipId, noteIds: [] } }),
  /* 只同步焦点 / 选中轨道（录入预备切换轨道用）。
   * 若当前选中的片段不属于目标轨道，就切到目标轨道自己的第一个未静音片段——
   * 保证「预备了哪条轨」与「钢琴卷帘显示哪条轨」一致，不会再出现录 A 轨却盯着 B 轨片段。 */
  focusTrack: (trackId) =>
    set((state) => {
      const target = state.project.tracks.find((track) => track.id === trackId)
      const selectedClipId = state.selection.clipId
      const keepsSelection = Boolean(
        selectedClipId && target?.clips.some((clip) => clip.id === selectedClipId),
      )
      return {
        selectedTrackId: trackId,
        focusedTrackId: trackId,
        selection: {
          clipId: keepsSelection
            ? selectedClipId
            : (target?.clips.find((clip) => !clip.muted)?.id ?? target?.clips[0]?.id ?? null),
          noteIds: [],
        },
      }
    }),
  setSelectedNotes: (noteIds) => set((state) => ({ selection: { ...state.selection, noteIds } })),
  toggleNoteSelection: (noteId) =>
    set((state) => {
      const exists = state.selection.noteIds.includes(noteId)
      return {
        selection: {
          ...state.selection,
          noteIds: exists ? state.selection.noteIds.filter((id) => id !== noteId) : [...state.selection.noteIds, noteId],
        },
      }
    }),
  clearSelection: () => set((state) => ({ selection: { ...state.selection, noteIds: [] } })),
  setSnap: (snap) => set({ snap }),
  setZoom: (zoomX, zoomY) => set((state) => ({ zoomX: zoomX ?? state.zoomX, zoomY: zoomY ?? state.zoomY })),
  setScrollBeat: (beat) => set({ scrollBeat: Math.max(0, beat) }),
  setShowMixer: (show) => set({ showMixer: show }),
  requestReveal: (trackId, beat) =>
    set((state) => ({
      revealRequest: { trackId, beat, token: (state.revealRequest?.token ?? 0) + 1 },
    })),

  /* ---------------- 走带 ---------------- */
  setPlaying: (isPlaying) => set({ isPlaying }),
  setPlayhead: (beat) => set({ playhead: Math.max(0, beat) }),
  setLoopEnabled: (loopEnabled) => {
    const state = get()
    set({
      loopEnabled,
      project: { ...state.project, loop: { ...state.project.loop, enabled: loopEnabled } },
    })
  },
  setLoopRange: (startBeat, endBeat) => {
    const state = get()
    set({
      project: {
        ...state.project,
        loop: { ...state.project.loop, startBeat: Math.min(startBeat, endBeat), endBeat: Math.max(startBeat, endBeat) },
      },
    })
  },
  setMetronome: (metronome) => set({ metronome }),
  setCountIn: (countIn) => set({ countIn }),
  setMasterLevel: (masterLevel) => set({ masterLevel: Math.max(0, Math.min(1, masterLevel)) }),
  stopTransport: () => set({ isPlaying: false, playhead: 0, masterLevel: 0 }),

  /* ---------------- 面板 ---------------- */
  setChatOpen: (chatOpen) => set({ chatOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setExportOpen: (exportOpen) => set({ exportOpen }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),

  /* ---------------- 持久化 ---------------- */
  setSaveStatus: (saveStatus) => set({ saveStatus, lastSavedAt: saveStatus === 'saved' ? Date.now() : get().lastSavedAt }),
  bumpProjectListVersion: () => set((state) => ({ projectListVersion: state.projectListVersion + 1 })),

  /* ---------------- AI ---------------- */
  addMessage: (message) => {
    const id = message.id ?? newId('m')
    const full: ChatMessage = { id, createdAt: Date.now(), ...message } as ChatMessage
    set((state) => ({ messages: [...state.messages, full] }))
    return id
  },

  appendToMessage: (messageId, delta, field = 'content') =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId ? { ...m, [field]: (m[field] ?? '') + delta } : m,
      ),
    })),

  patchMessage: (messageId, patch) =>
    set((state) => ({
      messages: state.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)),
    })),

  addToolCall: (messageId, call) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId ? { ...m, toolCalls: [...(m.toolCalls ?? []), call] } : m,
      ),
    })),

  finishToolCall: (messageId, callId, ok, result, error) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId
          ? {
              ...m,
              toolCalls: (m.toolCalls ?? []).map((c) =>
                c.id === callId
                  ? { ...c, status: ok ? 'ok' : 'error', result, error, endedAt: Date.now() }
                  : c,
              ),
            }
          : m,
      ),
    })),

  setAiBusy: (aiBusy, runId) => set({ aiBusy, activeRunId: runId ?? (aiBusy ? get().activeRunId : null) }),
  setAiError: (aiError) => set({ aiError }),
  clearMessages: () => set({ messages: [], aiError: null }),

  applyAgentProject: (project, label) => {
    const state = get()
    const before = state.aiUndoSnapshot ?? clone(state.project)
    project.updatedAt = Date.now()
    set({
      project,
      past: [...state.past, clone(state.project)].slice(-MAX_HISTORY),
      future: [],
      aiUndoSnapshot: before,
      saveStatus: 'dirty',
      selection: {
        clipId:
          project.tracks.find((t) => t.id === state.selectedTrackId)?.clips[0]?.id ??
          project.tracks[0]?.clips[0]?.id ??
          null,
        noteIds: [],
      },
      selectedTrackId: project.tracks.some((t) => t.id === state.selectedTrackId)
        ? state.selectedTrackId
        : (project.tracks[0]?.id ?? ''),
    })
    get().pushToast('success', `AI 已更新工程：${label}`)
  },

  undoAiChanges: () => {
    const snapshot = get().aiUndoSnapshot
    if (!snapshot) return
    set({ project: snapshot, aiUndoSnapshot: null, saveStatus: 'dirty' })
    get().pushToast('info', '已撤销 AI 的全部改动')
  },

  setPendingPrompt: (pendingPrompt) => set({ pendingPrompt }),

  /* ---------------- 工具 ---------------- */
  pushToast: (kind, message) => {
    const id = newId('toast')
    set((state) => ({ toasts: [...state.toasts.slice(-3), { id, kind, message }] }))
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
    }, 4200)
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  setMidiDevices: (devices, activeId) => set({ midiDevices: devices, midiActiveId: activeId }),
  setMidiActiveId: (midiActiveId) => set({ midiActiveId }),
  setMidiLastPitch: (midiLastPitch) => set({ midiLastPitch }),
  setMidiRecord: (midiRecord) => set({ midiRecord }),
  setSoundfontStatus: (status) => set((state) => ({ soundfontStatus: { ...state.soundfontStatus, ...status } })),
  setReady: (ready) => set({ ready }),
}))

/* ------------------------------------------------------------------ */
/* 选择器                                                              */
/* ------------------------------------------------------------------ */

export function useSelectedTrack(): Track | undefined {
  return useStore((s) => s.project.tracks.find((t) => t.id === s.selectedTrackId))
}

export function useFocusedTrack(): Track | undefined {
  return useStore((s) => s.project.tracks.find((t) => t.id === s.focusedTrackId))
}

export function useSelectedClip(): Clip | undefined {
  return useStore((s) => {
    const track = s.project.tracks.find((t) => t.id === s.selectedTrackId)
    return track?.clips.find((c) => c.id === s.selection.clipId)
  })
}

export function useProjectEndBar(): number {
  return useStore((s) => projectEndBar(s.project))
}

export function useProjectEndBeat(): number {
  return useStore((s) => projectEndBeat(s.project))
}

export function useBarBeats(): number {
  return useStore((s) => beatsPerBar(s.project.timeSignature))
}

/** 哪些轨道实际发声（考虑 mute / solo）——与引擎 / 导出共用 lib/trackRules 的同一份判定 */
export function audibleTrackIds(project: Project): Set<string> {
  return computeAudibleIds(project.tracks)
}

export { findClip, findTrack }
