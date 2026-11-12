/**
 * P8：本机引擎自动安装入口（顶栏）。
 *
 * 首次启动（尤其 macOS）时运行时/模型缺失 → 显示「安装本机引擎」按钮；
 * 点开后可选 profile（基础 / 质量模式 / 分轨），服务端下载并实时显示进度。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, CheckCircle2, Copy, Download, HardDriveDownload, LoaderCircle, TriangleAlert, X } from 'lucide-react'
import { AI_ENGINE_RUNTIME_NAME } from '@aiab/core'
import {
  cancelProvisionJob,
  getProvisionJob,
  getProvisionStatus,
  startProvisionInstall,
  type ProvisionJob,
  type ProvisionJobStep,
  type ProvisionProfileId,
  type ProvisionStatus,
} from '../../lib/api'
import { useStore } from '../../store/store'
import { cn } from '../../lib/format'

const PROFILE_ORDER: ProvisionProfileId[] = ['essential', 'quality', 'stems', 'xl']
const POLL_MS = 1200

/** 步骤状态的中文文案（data-provision-step-status 仍保留原始英文值，自动化脚本依赖） */
const STEP_STATUS_LABELS: Record<ProvisionJobStep['status'], string> = {
  pending: '等待中',
  running: '进行中',
  done: '完成',
  failed: '失败',
  skipped: '跳过',
}

/**
 * 网络类错误关键词：命中时在红色错误框下面给「开代理 / 复制诊断命令」的可操作提示。
 * 服务端的报错文案（下载失败：网络错误（ETIMEDOUT，github.com）… / 代理 127.0.0.1:10808 连接失败…）
 * 与 undici 原始的 fetch failed 都会命中。
 */
const NETWORK_ERROR_RE =
  /fetch failed|网络错误|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|proxy|代理/i

function isNetworkError(message: string): boolean {
  return NETWORK_ERROR_RE.test(message)
}

/**
 * 给用户的诊断命令。前端与后端同源：生产模式两者同端口，开发模式 Vite 已把 /api
 * 代理到后端，因此统一用当前页面地址即可（无需猜后端端口）。
 */
function diagnosticCommand(): string {
  return `node scripts/provision.mjs jobs --server ${window.location.origin}`
}

/**
 * P9/P10：各档位兜底文案与体积（服务端未返回该 profile 时也能给用户足够预期）。
 * 文案统一使用品牌中性命名（见 packages/core/src/branding.ts），不暴露底层模型/权重名；
 * 增强版体积按契约 ≈23.8GB，显存要求 ≥12GB；仅在 Windows 现代运行时下可用。
 */
const PROFILE_META: Record<ProvisionProfileId, { title: string; note: string; approxBytes: number }> = {
  essential: {
    title: '基础档（快速模式）',
    note: '运行时 + 快速生成模型 + 语义编码器 + 音频编解码器',
    approxBytes: 3_400_000_000,
  },
  quality: {
    title: '质量档',
    note: '精修生成模型（50 步）+ 提示词增强模型',
    approxBytes: 4_500_000_000,
  },
  stems: {
    title: '分轨档',
    note: '分轨生成模型（lego 分轨基座）',
    approxBytes: 2_500_000_000,
  },
  xl: {
    title: '增强版（最佳质量）',
    note: '增强版快速 / 精修 / 分轨生成模型 + 提示词增强模型（增强版） · 约 23.8GB · 需 ≥12GB 显存 · 仅 Windows 现代运行时',
    approxBytes: 23_800_000_000,
  },
}

/** 是否 Windows 平台（增强版只随现代运行时提供，macOS/Linux 走 legacy 运行时） */
function isWindowsPlatform(platform: string | undefined): boolean {
  return (platform ?? '').startsWith('win32')
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

/**
 * @param mode 'trigger' = 渲染按钮（默认）；'global' = 不渲染按钮，只作为全局下载对话框的宿主，
 *             供 AI 音频意图在缺少模型时自动唤起（App 里挂一个）。
 */
export function ProvisionButton({ mode = 'trigger' }: { mode?: 'trigger' | 'global' } = {}) {
  const pushToast = useStore((s) => s.pushToast)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const [status, setStatus] = useState<ProvisionStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<ProvisionProfileId[]>(['essential'])
  /** P8-B：是否同时下载风格适配器（自生成数据，默认勾选） */
  const [withAdapters, setWithAdapters] = useState(true)
  const [job, setJob] = useState<ProvisionJob | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 「复制诊断命令」按钮的短暂反馈（1.6s 后恢复） */
  const [copied, setCopied] = useState(false)
  /** 由 AI 音频意图自动唤起时展示的说明（为什么需要下载） */
  const [reason, setReason] = useState<string | null>(null)
  /** 唤起横幅标题（AI 缺模型 / 用户主动管理档位时文案不同） */
  const [reasonTitle, setReasonTitle] = useState<string | null>(null)
  /** AI 指定要安装的 profile（不被「建议选择」覆盖；空数组 = 明确不预选） */
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

  /** 建议选择：缺什么就默认勾什么（质量/分轨只在基础就绪时推荐；AI 指定时优先；增强版绝不自动勾选） */
  useEffect(() => {
    if (!status) return
    /* 显式指定过（含空数组 = 用户自己勾）就不再覆盖 */
    if (requestedProfiles !== null) return
    const next: ProvisionProfileId[] = ['essential']
    if (!status.profiles.some((item) => item.id === 'quality' && item.ready) && status.profiles.find((item) => item.id === 'essential')?.ready) {
      next.push('quality')
    }
    setSelected(next)
  }, [status, requestedProfiles])

  /**
   * 全局唤起：AI 音频意图检测到本机缺模型时自动打开下载对话框；
   * 顶栏「模型档位」入口也用它打开（detail.profiles = [] 表示不预选，让用户自己勾）。
   * detail: { reason?: string; title?: string; profiles?: ProvisionProfileId[]; source?: string }
   */
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (
        event as CustomEvent<{ reason?: string; title?: string; profiles?: ProvisionProfileId[] }>
      ).detail ?? {}
      const request = Array.isArray(detail.profiles)
        ? detail.profiles.filter((id): id is ProvisionProfileId => PROFILE_ORDER.includes(id))
        : (['essential'] as ProvisionProfileId[])
      setReason(detail.reason?.trim() || '音频生成需要本机 AI 引擎与模型。是否现在下载？')
      setReasonTitle(detail.title?.trim() || null)
      setRequestedProfiles(request)
      setSelected(request)
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
            setReasonTitle(null)
            setRequestedProfiles(null)
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

  /** 复制诊断命令：剪贴板不可用（非安全上下文 / 权限被拒）时静默失败，不打断下载面板 */
  const copyDiagnostic = async () => {
    try {
      await navigator.clipboard.writeText(diagnosticCommand())
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* 静默失败 */
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
                    自动下载 {AI_ENGINE_RUNTIME_NAME} 与模型并校验 sha256；下载后可断点续传。平台：
                    <code>{status?.platform ?? '检测中'}</code> · 安装到{' '}
                    <code className="break-all">{status?.root ?? '数据目录'}</code>
                  </p>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-ink-4">
                    增强版为最佳质量档（约 23.8GB，需 ≥12GB 显存，仅 Windows 现代运行时）；已装基础档后可随时回来加装。
                  </p>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-ink-4">
                    国内网络下载慢？可在{' '}
                    <button
                      type="button"
                      className="text-accent-soft underline decoration-dotted underline-offset-2 hover:text-accent disabled:opacity-50"
                      data-provision-open-download-settings
                      onClick={() => {
                        if (running) return
                        setOpen(false)
                        setSettingsOpen(true)
                      }}
                      disabled={running}
                      title="打开设置 → 引擎下载：切换国内镜像 / 多源分片加速 / 服务器离线包"
                    >
                      设置 → 引擎下载
                    </button>{' '}
                    切换国内镜像 / 多源加速，或使用服务器离线包。
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
                      <span className="font-medium text-accent-soft">
                        {reasonTitle ?? 'AI 想生成音频，但本机缺少生成环境。'}
                      </span>
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
                    const meta = PROFILE_META[id]
                    const checked = selected.includes(id)
                    const ready = info?.ready === true
                    /* 增强版档只随现代运行时提供（Windows）；其它平台禁用并说明，不静默隐藏 */
                    const platformBlocked = id === 'xl' && Boolean(status) && !isWindowsPlatform(status?.platform)
                    const sizeBytes = info && info.downloadBytes > 0 ? info.downloadBytes : meta.approxBytes
                    return (
                      <label
                        key={id}
                        data-provision-profile={id}
                        data-provision-profile-blocked={platformBlocked ? 'platform' : undefined}
                        title={
                          platformBlocked
                            ? '增强版档只在 Windows（现代运行时）下可用；当前平台请使用基础档位'
                            : id === 'xl' && !ready
                              ? '增强版：体积大（约 23.8GB）且需 ≥12GB 显存，默认不勾选'
                              : undefined
                        }
                        className={cn(
                          'flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-[10.5px]',
                          checked ? 'border-accent/45 bg-accent/8' : 'border-line bg-bg-soft',
                          (running || platformBlocked) && 'pointer-events-none opacity-70',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={running || ready || platformBlocked}
                          onChange={(event) => {
                            setSelected((prev) =>
                              event.target.checked ? [...new Set([...prev, id])] : prev.filter((item) => item !== id),
                            )
                          }}
                          className="mt-[2px] h-3.5 w-3.5 shrink-0 accent-[var(--accent,#4fd1c5)]"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="font-medium text-ink-2">{info?.label ?? meta.title}</span>
                            {ready && <span className="text-success text-[9px]">已就绪</span>}
                            {platformBlocked && <span className="text-[9px] text-ink-4">当前平台不支持</span>}
                            <span className="ml-auto shrink-0 text-[9px] text-ink-4">
                              下载 ~{humanBytes(sizeBytes)}
                            </span>
                          </span>
                          <span className="mt-0.5 block text-[9px] leading-relaxed text-ink-4">{meta.note}</span>
                          {(info?.files ?? []).length > 0 && (
                            <span className="mt-0.5 block truncate text-[9px] text-ink-4">
                              {(info?.files ?? []).join(' · ')}
                            </span>
                          )}
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
                        <span className="font-medium text-ink-2">风格适配器（风格包）</span>
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

                {error && isNetworkError(error) && (
                  <div data-provision-network-tip className="mt-1.5 rounded-lg border border-accent/25 bg-accent/8 px-2.5 py-2">
                    <div className="flex items-start gap-1.5 text-[9.5px] leading-relaxed text-ink-3">
                      <TriangleAlert size={11} className="mt-[2px] shrink-0 text-accent" />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-accent-soft">国内网络访问模型下载源（GitHub / HuggingFace）通常需要代理</p>
                        <p className="mt-0.5">
                          应用已自动识别 <code className="text-ink-2">HTTPS_PROXY</code> 与 macOS 系统代理；若仍失败，请先打开代理软件，
                          或在终端执行{' '}
                          <code className="break-all text-ink-2">export HTTPS_PROXY=http://127.0.0.1:10808</code>
                          （端口换成你的代理端口）后重启应用。
                        </p>
                        <p className="mt-1 text-[8.5px] text-ink-4">在当前工程目录执行以下命令可查看安装任务详情：</p>
                        <code className="mt-0.5 block break-all rounded bg-bg-soft px-1.5 py-1 font-mono text-[8.5px] text-ink-2">
                          {diagnosticCommand()}
                        </code>
                        <button
                          type="button"
                          data-provision-copy-diag
                          className="btn btn-ghost mt-1 h-6 px-2 text-[10px]"
                          onClick={() => void copyDiagnostic()}
                        >
                          {copied ? (
                            <Check size={10} className="mr-1 text-success" />
                          ) : (
                            <Copy size={10} className="mr-1" />
                          )}
                          {copied ? '已复制' : '复制诊断命令'}
                        </button>
                      </div>
                    </div>
                  </div>
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
                        <div key={step.key} data-provision-step data-provision-step-status={step.status} className="flex items-start gap-1.5 text-[9px]">
                          <span
                            className={cn(
                              'mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full',
                              step.status === 'done'
                                ? 'bg-success'
                                : step.status === 'failed'
                                  ? 'bg-danger'
                                  : step.status === 'running'
                                    ? 'animate-pulse bg-accent'
                                    : 'bg-surface-3',
                            )}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="min-w-0 flex-1 truncate text-ink-3">{step.label}</span>
                              <span className="mono shrink-0 text-ink-4">
                                {step.status === 'running' ? `${Math.round(step.progress * 100)}%` : STEP_STATUS_LABELS[step.status]}
                              </span>
                            </span>
                            {/* 失败步骤补出 message（截断展示，title 看全文）：运行时/下载的具体报错原来完全看不到 */}
                            {/* P10：installer 的 message 还带「下载源 / 实时 MB/s」；失败时用红色突出，两套 data-* 都保留 */}
                            {step.message && (
                              <span
                                data-provision-step-message
                                className={cn(
                                  'mt-0.5 block truncate',
                                  step.status === 'failed' ? 'text-danger/90' : 'text-ink-4/90',
                                )}
                                title={step.message}
                              >
                                {step.message}
                              </span>
                            )}
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