/**
 * UI 偏好（与工程数据解耦）
 *
 * 这里只放「界面怎么显示」的状态：
 * 跟随播放头、编辑工具、每条轨道的高度、录音预备、钢琴卷帘辅助显示、
 * 以及可拖拽面板的尺寸。它们不进入工程文件、不产生撤销点，只持久化在本机浏览器里。
 *
 * 设计约定：
 * - 工程数据仍然只存在 `store.ts`；这里不复制任何音乐数据。
 * - 允许被任意组件读写；写入尽量走 action，方便以后做撤销/同步。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** 编曲视图的编辑工具 */
export type EditorTool = 'select' | 'split' | 'draw'

/** 每条轨道高度（px）。未记录的轨道回退到「随纵向缩放自动计算」的默认高度。 */
export type TrackHeights = Record<string, number>

export interface UiPrefsState {
  /** 播放时编曲视图自动跟随播放头 */
  followPlayhead: boolean
  /** 编曲视图当前工具 */
  toolMode: EditorTool
  /** 每条轨道的自定义高度 */
  trackHeights: TrackHeights
  /** 已预备录入的轨道（轨道头 R 按钮） */
  armedTrackId: string | null
  /** 钢琴卷帘：显示其它轨道的幽灵音符 */
  showGhostNotes: boolean
  /** 钢琴卷帘：音阶锁定（画音符时吸附到调内音级） */
  scaleLock: boolean
  /** 钢琴卷帘：显示力度条 */
  velocityLane: boolean
  /** 混音器高度（px） */
  mixerHeight: number
  /** AI 面板宽度（px） */
  chatWidth: number
  /** AI 面板是否收成窄条 */
  chatCollapsed: boolean
}

export interface UiPrefsActions {
  setFollowPlayhead: (value: boolean) => void
  toggleFollowPlayhead: () => void
  setToolMode: (tool: EditorTool) => void
  setTrackHeight: (trackId: string, height: number | null) => void
  resetTrackHeights: () => void
  setArmedTrackId: (trackId: string | null) => void
  setShowGhostNotes: (value: boolean) => void
  setScaleLock: (value: boolean) => void
  setVelocityLane: (value: boolean) => void
  setMixerHeight: (value: number) => void
  setChatWidth: (value: number) => void
  setChatCollapsed: (value: boolean) => void
}

export type UiPrefsStore = UiPrefsState & UiPrefsActions

/** 轨道高度夹取范围：折叠条 / 最小 / 最大 */
export const TRACK_HEIGHT_LIMITS = { min: 38, max: 240, collapsed: 26 } as const
export const MIXER_HEIGHT_LIMITS = { min: 200, max: 620 } as const
export const CHAT_WIDTH_LIMITS = { min: 300, max: 620 } as const

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export const useUiStore = create<UiPrefsStore>()(
  persist(
    (set, get) => ({
      followPlayhead: true,
      toolMode: 'select',
      trackHeights: {},
      armedTrackId: null,
      showGhostNotes: true,
      scaleLock: false,
      velocityLane: true,
      mixerHeight: 318,
      chatWidth: 396,
      chatCollapsed: false,

      setFollowPlayhead: (followPlayhead) => set({ followPlayhead }),
      toggleFollowPlayhead: () => set({ followPlayhead: !get().followPlayhead }),
      setToolMode: (toolMode) => set({ toolMode }),
      setTrackHeight: (trackId, height) =>
        set((state) => {
          const next = { ...state.trackHeights }
          if (height == null) delete next[trackId]
          else next[trackId] = Math.round(clamp(height, TRACK_HEIGHT_LIMITS.collapsed, TRACK_HEIGHT_LIMITS.max))
          return { trackHeights: next }
        }),
      resetTrackHeights: () => set({ trackHeights: {} }),
      setArmedTrackId: (armedTrackId) => set({ armedTrackId }),
      setShowGhostNotes: (showGhostNotes) => set({ showGhostNotes }),
      setScaleLock: (scaleLock) => set({ scaleLock }),
      setVelocityLane: (velocityLane) => set({ velocityLane }),
      setMixerHeight: (value) => set({ mixerHeight: Math.round(clamp(value, MIXER_HEIGHT_LIMITS.min, MIXER_HEIGHT_LIMITS.max)) }),
      setChatWidth: (value) => set({ chatWidth: Math.round(clamp(value, CHAT_WIDTH_LIMITS.min, CHAT_WIDTH_LIMITS.max)) }),
      setChatCollapsed: (chatCollapsed) => set({ chatCollapsed }),
    }),
    {
      name: 'aiab:ui-prefs:v1',
      version: 1,
      partialize: (state) => ({
        followPlayhead: state.followPlayhead,
        toolMode: state.toolMode,
        trackHeights: state.trackHeights,
        showGhostNotes: state.showGhostNotes,
        scaleLock: state.scaleLock,
        velocityLane: state.velocityLane,
        mixerHeight: state.mixerHeight,
        chatWidth: state.chatWidth,
        chatCollapsed: state.chatCollapsed,
      }),
    },
  ),
)

/** 取某条轨道当前应用的高度：自定义优先，否则用传入的默认高度。 */
export function resolveTrackHeight(
  trackHeights: TrackHeights,
  trackId: string,
  fallback: number,
): number {
  const custom = trackHeights[trackId]
  return typeof custom === 'number' && Number.isFinite(custom) ? custom : fallback
}
