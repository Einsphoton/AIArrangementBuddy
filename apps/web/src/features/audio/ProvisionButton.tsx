/**
 * P8：本机引擎自动安装入口（顶栏）。
 *
 * 首次启动（尤其 macOS）时运行时/模型缺失 → 显示「安装本机引擎」按钮；
 * 点开后可选 profile（基础 / 质量模式 / 分轨），服务端下载并实时显示进度。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, Download, HardDriveDownload, LoaderCircle, TriangleAlert, X } from 'lucide-react'
import {
  cancelProvisionJob,
  getProvisionJob,
  getProvisionStatus,
  startProvisionInstall,
  type ProvisionJob,
  type ProvisionProfileId,
  type ProvisionStatus,
} from '../../lib/api'
import { useStore } from '../../store/store'
import { cn } from '../../lib/format'

const PROFILE_ORDER: ProvisionProfileId[] = ['essential', 'quality', 'stems']
const POLL_MS = 1200

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

/**
 * @param mode 'trigger' = 渲染按钮（默认）；'global' = 不渲染按钮，只作为全局下载对话框的宿主，
 *             供 AI 音频意图在缺少模型时自动唤起（App 里挂一个）。
 */
export function ProvisionButton({ mode = 'trigger' }: { mode?: 'trigger' | 'global' } = {}) {
  const pushToast = useStore((s) => s.pushToast)
  const [status, setStatus] = useState<ProvisionStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<ProvisionProfileId[]>(['essential'])
  /** P8-B：是否同时下载 LoRA 适配器（自生成数据，默认勾选） */
  const [withAdapters, setWithAdapters] = useState(true)
  const [job, setJob] = useState<ProvisionJob | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 由 AI 音频意图自动唤起时展示的说明（为什么需要下载） */
  const [reason, setReason] = useState<string | null>(null)
  /** AI 指定要安装的 profile（不被「建议选择」覆盖） */
  const [requestedProfiles, setRequestedProfiles] = useState<ProvisionProfileId[] | null>(null)
  const pollTimer = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await getProvisionStatus()
      setStatus(next)
      return next
    } catch {
      setStatus(null)
      return null
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    return () => {
      if (pollTimer.current) window.clearTimeout(pollTimer.current)
    }
  }, [])

  /** 建议选择：缺什么就默认勾什么（质量/分轨只在基础就绪时推荐；AI 指定时优先） */
  useEffect(() => {
    if (!status) return
    if (requestedProfiles?.length) return
    const next: ProvisionProfileId[] = ['essential']
    if (!status.profiles.some((item) => item.id === 'quality' && item.ready) && status.profiles.find((item) => item.id === 'essential')?.ready) {
      next.push('quality')
    }
    setSelected(next)
  }, [status, requestedProfiles])

  /**
   * 全局唤起：AI 音频意图检测到本机缺模型时自动打开下载对话框。
   * detail: { reason?: string; profiles?: ProvisionProfileId[]; source?: string }
   */
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: string; profiles?: ProvisionProfileId[] }>).detail ?? {}
      const request = (detail.profiles ?? ['essential']).filter((id): id is ProvisionProfileId => PROFILE_ORDER.includes(id))
      const profiles = request.length ? request : (['essential'] as ProvisionProfileId[])
      setReason(detail.reason?.trim() || '音频生成需要本机 AI 引擎与模型。是否现在下载？')
      setRequestedProfiles(profiles)
      setSelected(profiles)
      setOpen(true)
      void refresh()
    }
    window.addEventListener('aiab:provision-open', handler)
    return () => window.removeEventListener('aiab:provision-open', handler)
  }, [refresh])

  const start = async () => {
    if (starting) return
    setStarting(true)
    setError(null)
    try {
      const result = await startProvisionInstall(selected, { adapters: withAdapters })
      setJob(result.job)
      const tick = async () => {
        try {
          const { job: latest } = await getProvisionJob(result.jobId)
          setJob(latest)
          if (latest.status === 'running') {
            pollTimer.current = window.setTimeout(() => void tick(), POLL_MS)
            return
          }
          if (latest.status === 'done') {
            pushToast('success', '本机引擎安装完成，可以开始生成音频了')
            setReason(null)
            void refresh()
            window.dispatchEvent(new CustomEvent('aiab:provision-done', { detail: { jobId: latest.id, profiles: selected } }))
          } else {
            setError(latest.error ?? (latest.status === 'canceled' ? '已取消安装' : '安装失败'))
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : '查询安装进度失败')
        }
      }
      pollTimer.current = window.setTimeout(() => void tick(), POLL_MS)
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动安装失败')
    } finally {
      setStarting(false)
    }
  }

  const cancel = async () => {
    if (!job || job.status !== 'running') return
    try {
      await cancelProvisionJob(job.id)
    } catch {
      /* 服务端会自己收尾 */
    }
  }

  /* 已就绪且没有未完成安装时不显示（避免打扰）；被 AI 自动唤起时即使隐藏也要渲染对话框 */
  const essentialReady = status?.profiles?.find((item) => item.id === 'essential')?.ready === true
  const adapters = status?.adapters ?? []
  const missingAdapters = adapters.filter((adapter) => !adapter.installed).length
  const hidden = !status || (essentialReady && status.runtime.installed && missingAdapters === 0) || !status.supported
  if (hidden && !open) return null

  const running = job?.status === 'running'
  const profiles = status?.profiles ?? PROFILE_ORDER.map((id) => ({
    id,
    label: id,
    files: [],
    downloadBytes: 0,
    ready: false,
  }))

  return (
    <>
      {mode === 'trigger' && (
        <button
          type="button"
          data-provision-trigger
          className="btn btn-ghost h-8 shrink-0 gap-1.5 px-2 text-[11px]"
          title={`本机 AI 引擎未安装：点击自动下载（平台 ${status?.platform ?? '检测中'}，缺 ${humanBytes(status?.missingBytes ?? 0)}）`}
          onClick={() => setOpen(true)}
        >
          <HardDriveDownload size={13} className="text-warning" />
          <span className="hidden min-[1280px]:inline">安装本机引擎</span>
        </button>
      )}

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[210] flex items-start justify-center overflow-y-auto bg-black/65 p-4 pt-[8vh]"
            role="dialog"
            aria-modal="true"
            aria-label="安装本机引擎"
            onClick={() => (running ? undefined : setOpen(false))}
          >
            <div
              data-provision-panel
              className="w-full max-w-[560px] overflow-hidden rounded-xl border border-line-strong bg-surface-2 shadow-[0_32px_80px_-24px_rgba(0,0,0,0.9)]"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
                <div className="min-w-0">
                  <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                    <HardDriveDownload size={14} className="text-accent" />
                    安装本机 AI 引擎
                  </h2>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-ink-4">
                    自动下载 ACE-Step 运行时与模型并校验 sha256；下载后可断点续传。平台：
                    <code>{status?.platform ?? '检测中'}</code> · 安装到{' '}
                    <code className="break-all">{status?.root ?? '数据目录'}</code>
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon h-6 w-6 shrink-0"
                  aria-label="关闭安装面板"
                  onClick={() => (running ? undefined : setOpen(false))}
                  disabled={running}
                >
                  <X size={13} />
                </button>
              </div>

              {reason && (
                <div data-provision-reason className="border-b border-accent/25 bg-accent/8 px-4 py-2.5">
                  <div className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-ink-2">
                    <TriangleAlert size={12} className="mt-[1px] shrink-0 text-accent" />
                    <div className="min-w-0">
                      <span className="font-medium text-accent-soft">AI 想生成音频，但本机缺少生成环境。</span>
                      <p className="mt-0.5 text-ink-3">{reason}</p>
                      <p className="mt-0.5 text-[9.5px] text-ink-4">
                        下载完成后还需要在跑 GPU 的机器上启动生成节点（Companion），详情见「音频引擎」菜单里的启动命令。
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="px-4 py-3">
                <div className="mb-1 text-[10px] font-medium text-ink-3">选择要安装的能力</div>
                <div className="space-y-1.5">
                  {PROFILE_ORDER.map((id) => {
                    const info = profiles.find((item) => item.id === id)
                    const checked = selected.includes(id)
                    const ready = info?.ready === true
                    return (
                      <label
                        key={id}
                        data-provision-profile={id}
                        className={cn(
                          'flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-[10.5px]',
                          checked ? 'border-accent/45 bg-accent/8' : 'border-line bg-bg-soft',
                          running && 'pointer-events-none opacity-70',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={running || ready}
                          onChange={(event) => {
                            setSelected((prev) =>
                              event.target.checked ? [...new Set([...prev, id])] : prev.filter((item) => item !== id),
                            )
                          }}
                          className="mt-[2px] h-3.5 w-3.5 shrink-0 accent-[var(--accent,#4fd1c5)]"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="font-medium text-ink-2">{info?.label ?? id}</span>
                            {ready && <span className="text-success text-[9px]">已就绪</span>}
                            <span className="ml-auto shrink-0 text-[9px] text-ink-4">
                              下载 ~{humanBytes(info?.downloadBytes ?? 0)}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate text-[9px] text-ink-4">
                            {(info?.files ?? []).join(' · ')}
                          </span>
                        </span>
                      </label>
                    )
                  })}
                </div>

                {missingAdapters > 0 && (
                  <label
                    data-provision-adapters
                    className={cn(
                      'mt-1.5 flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-[10.5px]',
                      withAdapters ? 'border-accent/45 bg-accent/8' : 'border-line bg-bg-soft',
                      running && 'pointer-events-none opacity-70',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={withAdapters}
                      disabled={running}
                      onChange={(event) => setWithAdapters(event.target.checked)}
                      className="mt-[2px] h-3.5 w-3.5 shrink-0 accent-[var(--accent,#4fd1c5)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="font-medium text-ink-2">LoRA 适配器（风格包）</span>
                        <span className="ml-auto shrink-0 text-[9px] text-ink-4">
                          已就绪 {adapters.length - missingAdapters}/{adapters.length}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-[9px] text-ink-4">
                        {adapters.map((adapter) => `${adapter.id}${adapter.installed ? '✓' : ''}`).join(' · ')}（自生成数据，可安全分发）
                      </span>
                    </span>
                  </label>
                )}

                {error && (
                  <p className="mt-2 flex items-start gap-1 rounded border border-danger/30 bg-danger/8 px-2 py-1 text-[10px] text-danger">
                    <TriangleAlert size={11} className="mt-[2px] shrink-0" />
                    <span className="min-w-0 break-words">{error}</span>
                  </p>
                )}

                {job && (
                  <div className="mt-2.5 rounded-lg border border-line bg-bg-soft px-2.5 py-2">
                    <div className="flex items-center gap-2 text-[10px]">
                      <span className="text-ink-2">
                        {job.status === 'done' ? '安装完成' : job.status === 'failed' ? '安装失败' : job.status === 'canceled' ? '已取消' : '安装中'}
                      </span>
                      <span className="ml-auto font-mono text-ink-4" data-provision-progress={Math.round(job.progress * 100)}>
                        {Math.round(job.progress * 100)}%
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
                      <div
                        className={cn('h-full rounded-full transition-[width] duration-300', job.status === 'failed' ? 'bg-danger' : 'bg-accent')}
                        style={{ width: `${Math.round(job.progress * 100)}%` }}
                      />
                    </div>
                    <div className="mt-1.5 space-y-0.5">
                      {job.steps.map((step) => (
                        <div key={step.key} data-provision-step data-provision-step-status={step.status} className="flex items-center gap-1.5 text-[9px]">
                          <span
                            className={cn(
                              'h-1.5 w-1.5 shrink-0 rounded-full',
                              step.status === 'done'
                                ? 'bg-success'
                                : step.status === 'failed'
                                  ? 'bg-danger'
                                  : step.status === 'running'
                                    ? 'animate-pulse bg-accent'
                                    : 'bg-surface-3',
                            )}
                          />
                          <span className="min-w-0 flex-1 truncate text-ink-3">{step.label}</span>
                          <span className="mono shrink-0 text-ink-4">
                            {step.status === 'running' ? `${Math.round(step.progress * 100)}%` : step.status === 'done' ? '完成' : step.status}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-3 flex items-center justify-end gap-1.5">
                  {running ? (
                    <button type="button" data-provision-cancel className="btn btn-ghost h-7 px-2.5 text-[11px]" onClick={() => void cancel()}>
                      取消安装
                    </button>
                  ) : (
                    <button type="button" className="btn btn-ghost h-7 px-2.5 text-[11px]" onClick={() => setOpen(false)}>
                      关闭
                    </button>
                  )}
                  <button
                    type="button"
                    data-provision-install
                    className="btn btn-primary h-7 px-3 text-[11px]"
                    disabled={starting || running || selected.length === 0}
                    onClick={() => void start()}
                  >
                    {starting ? <LoaderCircle size={11} className="mr-1 animate-spin" /> : <Download size={11} className="mr-1" />}
                    {running ? '下载中…' : '开始下载'}
                  </button>
                </div>
                {status?.notes && status.notes.length > 0 && (
                  <p className="mt-1.5 flex items-start gap-1 text-[9px] leading-relaxed text-ink-4">
                    <CheckCircle2 size={10} className="mt-[2px] shrink-0 text-success/70" />
                    <span className="min-w-0">{status.notes.join('；')}</span>
                  </p>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}