/**
 * 轨道总控三件套：M（全部静音）/ S（清空全部独奏）/ R（取消全部录入预备）。
 *
 * 为什么需要它（来自成熟 DAW 的直接证据）：
 * - Studio One 把 `Mute Clear` / `Solo Clear` 放在轨道列表左下角，被用户当成
 *   「混音救星」——「怎么点都没声音」时先来这里一键清空；
 * - Logic 有同名命令但只在菜单 / 快捷键里，用户长期抱怨「忘了还开着 solo」；
 * - Ableton 完全没有，用户只能装第三方设备补 `Unsolo all`。
 *
 * 设计约定：
 * - **常驻可见**，不是藏在菜单里；
 * - 徽标上**永远显示数量**（深色主题下只有颜色会漏看）；
 * - 单击 = 一键清除该状态（M 是「已静音 → 全取消 / 否则全静音」），
 *   不提供「全部独奏」这种现实中没人要的批量操作；
 * - 悬停列出受影响的轨道名，避免「点下去不知道发生了什么」。
 *
 * `variant`：
 * - `panel`：轨道列表底部的常驻条（跟随列表，不随滚动消失）；
 * - `inline`：混音器标题栏里的紧凑版（只放图标 + 数字）。
 */
import { Volume2, VolumeX, Music4, Mic2, Eraser } from 'lucide-react'
import { cn } from '../../lib/format'
import { useStore } from '../../store/store'
import { useUiStore } from '../../lib/uiStore'
import { summarizeMix } from '../../lib/trackRules'

/** 轨道名列表 → 悬浮提示里的「、」连接文本（过长截断） */
function namesOf(tracks: { name: string }[], limit = 6): string {
  if (tracks.length === 0) return '无'
  const names = tracks.slice(0, limit).map((track) => track.name)
  return tracks.length > limit ? `${names.join('、')} 等 ${tracks.length} 条` : names.join('、')
}

function MasterButton({
  label,
  count,
  active,
  tone,
  title,
  disabled,
  onClick,
  children,
  testId,
}: {
  label: string
  count: number
  active: boolean
  tone: 'danger' | 'accent' | 'arm'
  title: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
  testId?: string
}) {
  const toneClass =
    tone === 'danger'
      ? 'border-danger/60 bg-danger/22 text-danger'
      : tone === 'accent'
        ? 'border-accent/60 bg-accent/22 text-accent'
        : 'border-danger/50 bg-danger/16 text-danger'
  return (
    <button
      type="button"
      data-mix-master-button={label}
      data-active={active ? 'true' : 'false'}
      data-count={count}
      data-testid={testId}
      title={title}
      aria-label={`${label}：${title}`}
      aria-pressed={active}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={cn(
        'flex h-[22px] shrink-0 items-center gap-1 rounded-[6px] border px-1.5 text-[10.5px] font-semibold transition-colors',
        active ? toneClass : 'border-line-strong bg-surface-2 text-ink-4 hover:text-ink-2',
        disabled && 'cursor-not-allowed opacity-45 hover:text-ink-4',
      )}
    >
      {children}
      <span className="leading-none">{label}</span>
      <span
        className={cn('mono leading-none tabular-nums', active ? 'opacity-100' : 'text-ink-4/80')}
        aria-hidden={count === 0}
      >
        {count}
      </span>
    </button>
  )
}

export function MixMasterControls({ variant = 'panel' }: { variant?: 'panel' | 'inline' }) {
  const tracks = useStore((s) => s.project.tracks)
  const toggleMuteAll = useStore((s) => s.toggleMuteAll)
  const clearAllSolos = useStore((s) => s.clearAllSolos)
  const pushToast = useStore((s) => s.pushToast)
  const armedTrackId = useUiStore((s) => s.armedTrackId)
  const setArmedTrackId = useUiStore((s) => s.setArmedTrackId)

  const summary = summarizeMix(tracks)
  const mutedTracks = tracks.filter((track) => track.mute)
  const soloTracks = tracks.filter((track) => track.solo)
  const armedTrack = armedTrackId ? tracks.find((track) => track.id === armedTrackId) : undefined
  const armedCount = armedTrack ? 1 : 0

  /* 独奏压住了谁：总控 S 的 tooltip 里直接说明「清空后这些轨会恢复出声」 */
  const suppressed = summary.anySolo ? tracks.filter((track) => !track.solo && !track.mute).length : 0

  const soloTitle = summary.anySolo
    ? `清空全部独奏（当前独奏：${namesOf(soloTracks)}${suppressed > 0 ? `；另有 ${suppressed} 条轨被独奏压住` : ''}）。单击立即恢复其它轨道出声`
    : '当前没有独奏。任意轨道点亮 S 后，这里可一键清空'

  const muteTitle = mutedTracks.length > 0
    ? `全部取消静音（当前静音：${namesOf(mutedTracks)}）`
    : '全部静音（一次静音所有轨道；再点一次全部取消）'

  const armTitle = armedTrack
    ? `取消录入预备（当前预备：${armedTrack.name}）`
    : '当前没有轨道处于录入预备'

  return (
    <div
      data-mix-master={variant}
      role="group"
      aria-label="轨道总控：静音 / 独奏 / 录入预备"
      className={cn(
        'flex items-center gap-1',
        variant === 'panel' ? 'w-full' : 'shrink-0',
      )}
    >
      <MasterButton
        label="M"
        count={summary.mutedCount}
        active={summary.mutedCount > 0}
        tone="danger"
        title={muteTitle}
        testId="mix-master-mute"
        onClick={() => {
          const muted = toggleMuteAll()
          if (tracks.length === 0) return
          pushToast('info', muted ? `已静音全部 ${tracks.length} 条轨道（总控 M 可再点一次取消）` : '已取消全部静音')
        }}
      >
        {summary.mutedCount > 0 ? <VolumeX size={11} /> : <Volume2 size={11} />}
      </MasterButton>

      <MasterButton
        label="S"
        count={summary.soloCount}
        active={summary.anySolo}
        tone="accent"
        title={soloTitle}
        disabled={!summary.anySolo}
        testId="mix-master-solo"
        onClick={() => {
          clearAllSolos()
          pushToast('info', `已退出独奏：${namesOf(soloTracks)} 恢复正常混音`)
        }}
      >
        <Music4 size={11} />
      </MasterButton>

      <MasterButton
        label="R"
        count={armedCount}
        active={armedCount > 0}
        tone="arm"
        title={armTitle}
        disabled={armedCount === 0}
        testId="mix-master-arm"
        onClick={() => {
          setArmedTrackId(null)
          pushToast('info', `已取消录入预备${armedTrack ? `「${armedTrack.name}」` : ''}`)
        }}
      >
        <Mic2 size={11} />
      </MasterButton>

      {variant === 'panel' && (
        <>
          <span className="mx-0.5 h-4 w-px shrink-0 bg-line" aria-hidden />
          <button
            type="button"
            data-mix-master-reset=""
            title="一键复位混音状态：取消全部静音、清空独奏、取消录入预备（不改音量 / 声像）"
            aria-label="复位全部静音与独奏状态"
            onClick={() => {
              if (summary.mutedCount === 0 && !summary.anySolo && armedCount === 0) {
                pushToast('info', '当前没有静音 / 独奏 / 录入预备，无需复位')
                return
              }
              useStore.getState().setAllMuted(false)
              useStore.getState().clearAllSolos()
              setArmedTrackId(null)
              pushToast('success', '已复位：静音 / 独奏 / 录入预备全部清除')
            }}
            className="flex h-[22px] shrink-0 items-center gap-1 rounded-[6px] border border-line-strong bg-surface-2 px-1.5 text-[10.5px] text-ink-4 transition-colors hover:text-ink-2"
          >
            <Eraser size={11} />
            <span className="leading-none">复位</span>
          </button>
          <span className="ml-auto shrink-0 truncate text-[10px] text-ink-4/80" title="独奏只影响「现在听得到什么」，不会改写其它轨道的静音开关">
            {summary.anySolo ? `${suppressed} 条轨被独奏压住` : mutedTracks.length > 0 ? `${mutedTracks.length} 条轨静音` : ''}
          </span>
        </>
      )}
    </div>
  )
}
