/**
 * AI 面板顶部的「音频生成 / 引擎状态」入口（P9）。
 *
 * 音频不再是顶栏一个孤立窗口：入口收进 AI 编曲面板，聊天里说一句话就能生成；
 * 这个菜单只负责「引擎状态 + 高级参数 + 任务中心 + 本机安装/训练」这些低频操作。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AudioLines,
  ClipboardList,
  Copy,
  HardDriveDownload,
  LoaderCircle,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
} from 'lucide-react'
import { getCompanionStatus, getProvisionStatus, type CompanionStatus, type ProvisionProfileId, type ProvisionStatus } from '../../lib/api'
import { useStore } from '../../store/store'
import { cn } from '../../lib/format'
import { COMPANION_START_HINT } from './CompanionBadge'
import { TrainingButton } from './TrainingButton'

const POLL_MS = 30_000

interface AudioEngineMenuProps {
  /** 打开旧版「AI 生成音频」高级表单 */
  onOpenAdvanced: () => void
  /** 打开任务中心 */
  onOpenTasks: () => void
}

function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)}${units[unit]}`
}

export function AudioEngineMenu({ onOpenAdvanced, onOpenTasks }: AudioEngineMenuProps) {
  const pushToast = useStore((s) => s.pushToast)
  const [open, setOpen] = useState(false)
  const [companion, setCompanion] = useState<CompanionStatus | null>(null)
  const [provision, setProvision] = useState<ProvisionStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [companionStatus, provisionStatus] = await Promise.all([
        getCompanionStatus().catch(() => null),
        getProvisionStatus().catch(() => null),
      ])
      setCompanion(companionStatus)
      setProvision(provisionStatus)
      setFailed(!companionStatus && !provisionStatus)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    if (!open) return
    void refresh()
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, refresh])

  const online = companion?.online === true && (companion.summary?.workers ?? 0) > 0
  const essential = provision?.profiles?.find((profile) => profile.id === 'essential')
  const modelsReady = Boolean(provision?.runtime?.installed) && essential?.ready === true
  const missingBytes = provision?.missingBytes ?? 0
  const hint = companion?.hint ?? COMPANION_START_HINT

  const copyHint = async () => {
    try {
      await navigator.clipboard?.writeText(hint)
      pushToast('success', '启动命令已复制')
    } catch {
      pushToast('info', hint)
    }
  }

  const statusLabel = online ? '生成节点在线' : modelsReady ? '模型已就绪 · 节点未启动' : '需要下载音频模型'

  /* P9：档位概览（基础档就绪后入口仍然保留，方便加装 XL 4B / 质量 / 分轨档） */
  const profiles = provision?.profiles ?? []
  const readyProfiles = profiles.filter((profile) => profile.ready)
  const profileTotal = profiles.length || 4
  const xlReady = profiles.some((profile) => profile.id === 'xl' && profile.ready)
  const profileSummary = modelsReady ? `已就绪 ${readyProfiles.length}/${profileTotal} 档` : `缺 ${humanBytes(missingBytes)}`
  /** 打开安装面板：profiles = [] 表示不预选（让用户自己勾档位） */
  const openProvision = (detail: { reason: string; title?: string; profiles: ProvisionProfileId[] }) => {
    window.dispatchEvent(new CustomEvent('aiab:provision-open', { detail }))
  }

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <button
        type="button"
        data-audio-engine-trigger
        className={cn(
          'btn btn-ghost btn-icon relative h-7 w-7',
          open && 'bg-surface-3 text-accent',
          online ? 'text-success' : modelsReady ? 'text-accent-soft' : 'text-ink-3',
        )}
        title={`音频生成：${statusLabel}（点击查看引擎状态与高级设置）`}
        aria-label={`音频生成：${statusLabel}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <AudioLines size={14} />
        <span
          className={cn(
            'absolute right-[3px] top-[3px] h-1.5 w-1.5 rounded-full ring-2 ring-surface',
            online ? 'bg-success' : modelsReady ? 'bg-accent' : 'bg-ink-4',
          )}
          style={online ? { animation: 'pulse-dot 2.4s ease-in-out infinite' } : undefined}
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="音频生成与引擎状态"
          data-audio-engine-menu
          className="absolute right-0 top-full z-40 mt-1 w-[286px] overflow-hidden rounded-xl border border-line-strong bg-surface shadow-[0_28px_70px_-22px_rgba(0,0,0,0.95)] animate-scale-in"
        >
          <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
            <AudioLines size={13} className="shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-semibold">音频生成</div>
              <div className="text-[9.5px] text-ink-4">在下面直接对 AI 说想要什么，自动决定模式</div>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-icon h-6 w-6"
              onClick={() => void refresh()}
              title="刷新引擎状态"
              aria-label="刷新引擎状态"
            >
              {loading ? <LoaderCircle size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            </button>
          </div>

          <div className="space-y-2 px-3 py-2.5">
            <div className="rounded-lg border border-line bg-bg-soft px-2.5 py-2">
              <div className="flex items-center gap-1.5 text-[10.5px]">
                <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', online ? 'bg-success' : 'bg-ink-4')} />
                <span className="font-medium text-ink-2">{online ? '生成节点在线' : '生成节点未启动'}</span>
                {online && (
                  <span className="ml-auto text-[9.5px] text-ink-4">
                    {companion?.summary?.workers ?? 0} 节点 · 运行 {companion?.summary?.running ?? 0} / 排队{' '}
                    {companion?.summary?.queued ?? 0}
                  </span>
                )}
              </div>
              {!online && (
                <>
                  <p className="mt-1 text-[9.5px] leading-relaxed text-ink-4">
                    {modelsReady ? '模型已安装，只差启动 Companion（在跑 GPU 的机器上执行）。' : '首次使用需要先下载本机模型与运行时。'}
                  </p>
                  <button
                    type="button"
                    className="mt-1.5 flex h-6 items-center gap-1 rounded-md border border-line bg-surface-2 px-1.5 text-[9.5px] text-ink-3 hover:text-ink"
                    onClick={() => void copyHint()}
                    title={hint}
                  >
                    <Copy size={9} />
                    复制启动命令
                  </button>
                </>
              )}
            </div>

            <div className="rounded-lg border border-line bg-bg-soft px-2.5 py-2">
              <div className="flex items-center gap-1.5 text-[10.5px]">
                <HardDriveDownload size={11} className="shrink-0 text-accent" />
                <span className="font-medium text-ink-2">本机引擎 / 模型档位</span>
                <span className="ml-auto shrink-0 text-[9.5px] text-ink-4">
                  {provision?.supported === false ? '当前平台不支持自动安装' : profileSummary}
                </span>
              </div>
              <p className="mt-1 text-[9.5px] leading-relaxed text-ink-4">
                {provision?.supported === false
                  ? '当前平台不支持自动安装；请手动部署本机引擎。'
                  : modelsReady
                    ? xlReady
                      ? '基础档与 XL 4B 档已安装；可加装质量 / 分轨档，或查看安装状态。'
                      : '基础档已就绪；可加装 XL 4B 档（约 23.8GB，需 ≥12GB 显存）、质量档或分轨档。'
                    : '首次使用需要先下载本机模型与运行时（基础档约 3.4GB）。'}
              </p>
              <button
                type="button"
                data-provision-trigger
                className="mt-1.5 flex h-7 w-full items-center justify-center gap-1 rounded-md border border-accent/40 bg-accent/10 text-[10px] text-accent-soft hover:bg-accent/16 disabled:opacity-40"
                disabled={provision?.supported === false}
                title={`本机 AI 引擎：平台 ${provision?.platform ?? '检测中'}，${profileSummary}${
                  xlReady ? '，XL 4B 已安装' : modelsReady ? '，可加装 XL 4B' : ''
                }`}
                onClick={() =>
                  openProvision({
                    title: modelsReady ? '管理本机模型档位' : undefined,
                    reason: modelsReady
                      ? '已安装的档位不会重复下载；勾选需要的档位（如 XL 4B）后开始下载即可。'
                      : '安装本机 AI 引擎与模型后，才能在 AI 编曲助手里直接生成音频与分轨。',
                    /* 基础档就绪时不预选任何档位，避免误下 23.8GB 的 XL 档 */
                    profiles: modelsReady ? [] : ['essential'],
                  })
                }
              >
                <HardDriveDownload size={10} />
                {modelsReady ? '模型档位（含 XL 4B）' : '安装本机引擎'}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                data-audio-advanced-trigger
                className="flex h-8 items-center justify-center gap-1 rounded-lg border border-line-strong bg-surface-2 text-[10.5px] text-ink-2 hover:bg-surface-3 hover:text-ink"
                onClick={() => {
                  setOpen(false)
                  onOpenAdvanced()
                }}
              >
                <SlidersHorizontal size={11} />
                高级参数
              </button>
              <button
                type="button"
                data-audio-tasks-trigger
                className="flex h-8 items-center justify-center gap-1 rounded-lg border border-line-strong bg-surface-2 text-[10.5px] text-ink-2 hover:bg-surface-3 hover:text-ink"
                onClick={() => {
                  setOpen(false)
                  onOpenTasks()
                }}
              >
                <ClipboardList size={11} />
                任务中心
              </button>
            </div>

            <div className="rounded-lg border border-line/70 bg-bg-soft/60 px-2.5 py-1.5">
              <div className="flex items-center gap-1 text-[9.5px] text-ink-4">
                <Settings2 size={9} />
                风格适配器训练
              </div>
              <div className="mt-1">
                <TrainingButton />
              </div>
            </div>

            {failed && (
              <p className="text-[9.5px] leading-relaxed text-danger">
                无法读取生成引擎状态：请确认本地服务已启动（pnpm dev / pnpm start）。
              </p>
            )}
          </div>

          <div className="border-t border-line bg-bg-soft/60 px-3 py-2 text-[9px] leading-relaxed text-ink-4">
            试试在下面说：「生成一首 30 秒 cinematic 音频」「把这首编曲渲染成音频」「生成整曲并分轨」。
          </div>
        </div>
      )}
    </div>
  )
}
