/**
 * P10：引擎下载加速设置。
 *
 * 引擎运行时（GitHub Releases / 上游目录）与模型（公共模型托管站）在国内直连很慢，
 * 这里把「镜像 / 多源分片 / 服务器离线包」暴露成配置，并展示只读状态：
 *   - 本机离线包概况（GET /api/provision/status 的 download 段）
 *   - 各下载源实际探测延迟（GET /api/provision/sources?probe=1）
 *   - 生成服务器离线包（POST /api/provision/package/build + 轮询 job）
 *
 * 服务端字段全部按可选处理：旧服务端 / 接口未就绪时只提示，不阻塞渲染。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CheckCircle2,
  Download,
  FolderDown,
  Gauge,
  HardDriveDownload,
  LoaderCircle,
  Package,
  RefreshCw,
  Server,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react'
import type { ProvisionSourceStrategy } from '@aiab/core'
import {
  ApiError,
  buildProvisionPackage,
  getProvisionPackageJob,
  getProvisionSources,
  getProvisionStatus,
  type ProvisionDownloadInfo,
  type ProvisionPackageJob,
  type ProvisionSourceProbe,
} from '../../lib/api'
import { Badge, Button, NumberField, Select, Switch } from '../../components/ui'
import { useStore } from '../../store/store'
import { cn, formatBytes } from '../../lib/format'
import { describeRequestError, FieldGroup, Section, StatusLine } from './shared'
import type { SettingsSectionProps } from './shared'

const POLL_MS = 1200

const STRATEGY_META: Record<ProvisionSourceStrategy, { label: string; hint: string }> = {
  auto: {
    label: '自动（探测最快）',
    hint: '下载前先对官方源与镜像做一次测速，按延迟排序依次尝试；国内网络建议保持这个选项。',
  },
  mirror: {
    label: '国内镜像优先（失败回落官方）',
    hint: '优先走 hf-mirror.com / ghfast.top 等国内镜像，镜像失败或校验不符时自动回落到官方源。',
  },
  direct: {
    label: '只用官方源',
    hint: '不经过 hf-mirror / ghfast 等任何第三方镜像；自己的服务器离线包（服务器助攻）仍可用。',
  },
}

/** 分片并发数 → 一句人话 */
function concurrencyHint(value: number): string {
  if (value <= 1) return '0 / 1 = 单连接。大文件（运行时、大模型文件）多连接通常明显更快，默认 4。'
  return `大文件切成 ${value} 段并发下载（HTTP Range），几 MB 的小文件仍走单连接；默认 4。`
}

/** 探测结果右侧的状态文案 */
function probeStatus(source: ProvisionSourceProbe): { text: string; tone: 'success' | 'danger' | 'neutral' } {
  if (source.ok === false) return { text: '失败', tone: 'danger' }
  if (typeof source.latencyMs === 'number') return { text: `${Math.round(source.latencyMs)} ms`, tone: 'success' }
  return { text: '未探测', tone: 'neutral' }
}

/**
 * 服务端探测结果里的源名称可能带底层模型托管站/内部简称；
 * 界面统一成中性说法（镜像域名本身属于基础设施，可以展示）。
 */
const SOURCE_LABEL_NEUTRAL: Readonly<Record<string, string>> = {
  'HuggingFace 官方源': '模型官方源',
  'HuggingFace 镜像': '模型镜像',
  '国内 HF 镜像': '国内模型镜像',
  'HF 镜像': '模型镜像',
}

function neutralSourceLabel(label: string): string {
  return SOURCE_LABEL_NEUTRAL[label] ?? label.replace(/HuggingFace/gi, '模型托管站').replace(/\bHF\b/g, '模型镜像')
}

/** 404 = 服务端还是 P9 版本（P10 接口未就绪）：给一句更好懂的提示 */
function describeProvisionError(error: unknown, unsupportedText: string): string {
  if (error instanceof ApiError && error.status === 404) return unsupportedText
  return describeRequestError(error)
}

export function EngineDownloadSection({ draft, update }: SettingsSectionProps) {
  const pushToast = useStore((s) => s.pushToast)
  const provision = draft.provision
  const strategyMeta = STRATEGY_META[provision.sourceStrategy]

  const patch = (partial: Partial<typeof provision>) =>
    update((next) => {
      Object.assign(next.provision, partial)
    })

  const [download, setDownload] = useState<ProvisionDownloadInfo | null>(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const [statusError, setStatusError] = useState('')

  const [sources, setSources] = useState<ProvisionSourceProbe[]>([])
  const [sourcesLoading, setSourcesLoading] = useState(false)
  const [sourcesError, setSourcesError] = useState('')
  const [probedAt, setProbedAt] = useState<number | null>(null)

  const [packageJob, setPackageJob] = useState<ProvisionPackageJob | null>(null)
  const [building, setBuilding] = useState(false)
  const [packageError, setPackageError] = useState('')
  const pollTimer = useRef<number | null>(null)

  const loadStatus = useCallback(async () => {
    setStatusLoading(true)
    setStatusError('')
    try {
      const status = await getProvisionStatus()
      /* 旧服务端没有 download 段：保持 null，UI 显示「未发现离线包」而不是报错 */
      setDownload(status.download ?? null)
    } catch (error) {
      setStatusError(describeRequestError(error))
    } finally {
      setStatusLoading(false)
    }
  }, [])

  const probeSources = useCallback(async () => {
    setSourcesLoading(true)
    setSourcesError('')
    try {
      const result = await getProvisionSources({ probe: true })
      setSources(result.sources)
      setProbedAt(result.probedAt ?? Date.now())
      /* 服务端可能 200 + error 返回「探测整体失败」，不抛异常 */
      if (result.sources.length === 0 && result.error) setSourcesError(result.error)
    } catch (error) {
      setSourcesError(describeProvisionError(error, '服务端暂不支持「下载源探测」（需 P10 版本服务端）'))
      setSources([])
    } finally {
      setSourcesLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
    void probeSources()
  }, [loadStatus, probeSources])

  useEffect(() => {
    return () => {
      if (pollTimer.current) window.clearTimeout(pollTimer.current)
    }
  }, [])

  /** 轮询离线包构建任务；完成后刷新离线包状态 */
  const pollPackageJob = useCallback(
    (jobId: string) => {
      const tick = async () => {
        try {
          const { job } = await getProvisionPackageJob(jobId)
          setPackageJob(job)
          if (job.status === 'running') {
            pollTimer.current = window.setTimeout(() => void tick(), POLL_MS)
            return
          }
          setBuilding(false)
          if (job.status === 'done') {
            pushToast('success', `服务器离线包已生成${job.result?.dir ? `：${job.result.dir}` : ''}`)
            await loadStatus()
          } else if (job.status === 'failed') {
            const text = job.error || '生成服务器离线包失败'
            setPackageError(text)
            pushToast('error', text)
          } else {
            setPackageError('离线包生成已取消')
          }
        } catch (error) {
          setBuilding(false)
          const text = describeRequestError(error)
          setPackageError(text)
          pushToast('error', `查询离线包进度失败：${text}`)
        }
      }
      if (pollTimer.current) window.clearTimeout(pollTimer.current)
      pollTimer.current = window.setTimeout(() => void tick(), POLL_MS)
    },
    [loadStatus, pushToast],
  )

  const buildPackage = async () => {
    if (building) return
    setBuilding(true)
    setPackageError('')
    try {
      /* 默认只打包基础档（essential），训练数据体量大、默认不随包分发 */
      const { jobId, job } = await buildProvisionPackage({ profiles: ['essential'], includeTraining: false })
      setPackageJob(job)
      pollPackageJob(jobId)
    } catch (error) {
      setBuilding(false)
      const text = describeProvisionError(error, '服务端暂不支持「生成离线包」（需 P10 版本服务端）')
      setPackageError(text)
      pushToast('error', `生成服务器离线包失败：${text}`)
    }
  }

  const packagePresent = download?.packagePresent === true
  const packageFiles = download?.packageFiles ?? 0
  const packageBytes = download?.packageBytes ?? 0
  const packageDir =
    download?.packagePath || download?.packageDir || provision.packageDir || '数据目录/engine-package'
  const packagePlatform = download?.packagePlatform
  const jobRunning = packageJob?.status === 'running'
  const jobProgress = Math.round((packageJob?.progress ?? 0) * 100)

  return (
    <div className="space-y-3">
      <Section
        title="下载源策略"
        description="引擎运行时与模型来自公共下载站（模型镜像 / GitHub Releases / 上游目录），国内直连经常只有几十 KB/s；这里决定下载时优先走哪条线路。"
        icon={<Download size={13} />}
        badge={
          provision.sourceStrategy === 'mirror' ? (
            <Badge tone="accent">国内镜像优先</Badge>
          ) : provision.sourceStrategy === 'direct' ? (
            <Badge tone="neutral">仅官方源</Badge>
          ) : (
            <Badge tone="success">自动探测</Badge>
          )
        }
      >
        <FieldGroup label="下载源策略" hint={strategyMeta.hint}>
          <Select
            value={provision.sourceStrategy}
            ariaLabel="下载源策略"
            options={[
              { value: 'auto', label: STRATEGY_META.auto.label },
              { value: 'mirror', label: STRATEGY_META.mirror.label },
              { value: 'direct', label: STRATEGY_META.direct.label },
            ]}
            onChange={(value) => patch({ sourceStrategy: value as ProvisionSourceStrategy })}
          />
        </FieldGroup>

        <FieldGroup
          label="模型镜像地址"
          hint="模型文件优先从这里取。留空使用内置镜像 https://hf-mirror.com；填 off 关闭（只用官方源）。"
        >
          <input
            className="field mono text-[11.5px]"
            value={provision.hfMirror}
            placeholder="https://hf-mirror.com（留空用内置；off = 关闭）"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => patch({ hfMirror: event.target.value })}
          />
        </FieldGroup>

        <FieldGroup
          label="GitHub 加速前缀"
          hint="运行时 / 适配器从 GitHub Releases 下载时套用的前缀。留空使用内置 https://ghfast.top/；填 off 关闭。"
        >
          <input
            className="field mono text-[11.5px]"
            value={provision.githubMirror}
            placeholder="https://ghfast.top/（留空用内置；off = 关闭）"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => patch({ githubMirror: event.target.value })}
          />
        </FieldGroup>

        <FieldGroup
          label="运行时 / CUDA 镜像基础 URL"
          hint="自建镜像时填写（例如把官方运行时与 CUDA 组件同步到自己的静态服务器）。留空 = 官方 + 服务器离线包。"
        >
          <input
            className="field mono text-[11.5px]"
            value={provision.runtimeMirror}
            placeholder="https://你的镜像站/acestep-runtime（留空 = 官方 + 离线包）"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => patch({ runtimeMirror: event.target.value })}
          />
        </FieldGroup>

        <FieldGroup label={`分片并发 · ${provision.concurrency} 路`} hint={concurrencyHint(provision.concurrency)}>
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                <div
                  className="h-full rounded-full bg-accent/70 transition-[width] duration-300"
                  style={{ width: `${Math.min(100, (provision.concurrency / 16) * 100)}%` }}
                />
              </div>
            </div>
            <NumberField
              value={provision.concurrency}
              min={0}
              max={16}
              step={1}
              width={72}
              suffix="路"
              onChange={(value) => patch({ concurrency: Math.round(value) })}
            />
          </div>
        </FieldGroup>
      </Section>

      <Section
        title="服务器助攻与离线包"
        description="已装好的机器可以把运行时/模型打成离线包放到服务器；首装直接本地复制（完全离线），局域网其它机器从服务器镜像拉取。"
        icon={<Server size={13} />}
        badge={
          provision.serverAssist ? <Badge tone="success">助攻已开</Badge> : <Badge tone="neutral">已关闭</Badge>
        }
      >
        <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-soft/50 px-2.5 py-2">
          <div>
            <div className="flex items-center gap-1.5 text-[12px] text-ink-2">
              <Server size={11} className="text-ink-3" />
              服务器助攻
            </div>
            <div className="mt-0.5 text-[10.5px] text-ink-4">
              优先使用本机/服务器离线包，并把本机已装文件提供给局域网内其它机器
            </div>
          </div>
          <Switch
            checked={provision.serverAssist}
            label="服务器助攻"
            onChange={(value) => patch({ serverAssist: value })}
          />
        </div>

        <FieldGroup
          label="服务器镜像地址"
          hint="留空 = 只用本机离线包（单机完全离线）；填 http://nas:8787 可从他机/服务器拉取已装好的引擎文件。"
        >
          <input
            className="field mono text-[11.5px]"
            value={provision.serverAssistUrl}
            placeholder="http://nas:8787（留空 = 只用本机离线包）"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => patch({ serverAssistUrl: event.target.value })}
          />
        </FieldGroup>

        <FieldGroup
          label="服务器镜像令牌"
          hint="服务器开启 token 校验时填写（可选）：随请求发送 x-aiab-mirror-token。只保存在本机 settings.json。"
        >
          <input
            className="field mono text-[11.5px]"
            type="password"
            value={provision.serverAssistToken}
            placeholder="服务端开启 token 校验时填写（可选）"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => patch({ serverAssistToken: event.target.value })}
          />
        </FieldGroup>

        <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-soft/50 px-2.5 py-2">
          <div>
            <div className="flex items-center gap-1.5 text-[12px] text-ink-2">
              <HardDriveDownload size={11} className="text-ink-3" />
              使用本机离线包
            </div>
            <div className="mt-0.5 text-[10.5px] text-ink-4">发现离线包时直接复制并校验 sha256，不再走网络</div>
          </div>
          <Switch
            checked={provision.useLocalPackage}
            label="使用本机离线包"
            onChange={(value) => patch({ useLocalPackage: value })}
          />
        </div>

        <FieldGroup
          label="离线包目录"
          hint="留空 = 数据目录下 engine-package（可用环境变量 AIAB_ENGINE_PACKAGE_DIR 覆盖）。"
        >
          <input
            className="field mono text-[11.5px]"
            value={provision.packageDir}
            placeholder="数据目录/engine-package（留空用默认）"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => patch({ packageDir: event.target.value })}
          />
        </FieldGroup>
      </Section>

      <Section
        title="离线包与源探测"
        description="只读状态：本机离线包概况、各下载源实际延迟（带探测时间）。所有文件都按 size + sha256 校验，镜像不可信也不会装坏。"
        icon={<Gauge size={13} />}
        badge={packagePresent ? <Badge tone="success">离线包就绪</Badge> : <Badge tone="neutral">未发现离线包</Badge>}
      >
        <div
          data-engine-package
          data-engine-package-present={packagePresent ? 'true' : 'false'}
          className="rounded-lg border border-line bg-bg-soft/50 px-2.5 py-2"
        >
          <div className="flex items-center gap-2">
            <Package size={11} className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1 text-[12px] text-ink-2" data-engine-package-summary>
              {statusLoading
                ? '读取离线包状态…'
                : packagePresent
                  ? `离线包：${packageFiles} 个文件 / ${formatBytes(packageBytes)}`
                  : '未发现离线包'}
            </span>
            <button
              type="button"
              className="btn h-6 shrink-0 px-1.5 text-[10.5px]"
              onClick={() => void loadStatus()}
              disabled={statusLoading || building}
              title="重新读取服务端离线包状态"
            >
              {statusLoading ? <LoaderCircle size={10} className="animate-spin" /> : <RefreshCw size={10} />}
            </button>
            <span data-engine-package-build className="shrink-0">
              <Button
                size="sm"
                variant="accent"
                onClick={() => void buildPackage()}
                disabled={building}
                icon={building ? <LoaderCircle size={11} className="animate-spin" /> : <FolderDown size={11} />}
                title="把已安装的运行时与模型打包到离线包目录（默认只含基础档）"
              >
                {building ? '生成中…' : '生成服务器离线包'}
              </Button>
            </span>
          </div>

          <p className="mt-1 text-[10.5px] leading-relaxed text-ink-4">
            {packagePresent ? (
              <>
                目录：<code className="mono break-all">{packageDir}</code>
                {packagePlatform ? ` · 平台 ${packagePlatform}` : ''}
              </>
            ) : (
              <>
                没找到离线包：安装好引擎后可在这里一键生成，或在命令行执行{' '}
                <code className="mono rounded bg-black/30 px-1 text-[10.5px] text-accent-soft">
                  node scripts/provision.mjs package
                </code>
                ；生成后可随应用部署到服务器，首装直接本地复制。
              </>
            )}
          </p>

          {packageJob && (
            <div data-engine-package-job={packageJob.status} className="mt-2">
              <div className="flex items-center gap-2 text-[10px]">
                <span className="text-ink-2">
                  {jobRunning
                    ? '正在生成离线包'
                    : packageJob.status === 'done'
                      ? '离线包生成完成'
                      : packageJob.status === 'canceled'
                        ? '已取消'
                        : '生成失败'}
                </span>
                <span className="ml-auto mono text-ink-4" data-engine-package-progress={jobProgress}>
                  {jobProgress}%
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
                <div
                  className={cn(
                    'h-full rounded-full transition-[width] duration-300',
                    packageJob.status === 'failed' ? 'bg-danger' : 'bg-accent',
                  )}
                  style={{ width: `${jobProgress}%` }}
                />
              </div>
              {packageJob.message && (
                <p className="mt-1 truncate text-[10px] text-ink-4" title={packageJob.message}>
                  {packageJob.message}
                </p>
              )}
              {packageJob.status === 'done' && packageJob.result?.dir && (
                <p className="mt-1 break-all text-[10px] text-ink-4">
                  输出目录：<code className="mono">{packageJob.result.dir}</code>
                  {typeof packageJob.result.bytes === 'number' ? ` · ${formatBytes(packageJob.result.bytes)}` : ''}
                </p>
              )}
            </div>
          )}

          {packageError && (
            <p className="mt-1.5 flex items-start gap-1 rounded border border-danger/30 bg-danger/8 px-2 py-1 text-[10px] text-danger">
              <TriangleAlert size={11} className="mt-[2px] shrink-0" />
              <span className="min-w-0 break-words">{packageError}</span>
            </p>
          )}
          {statusError && (
            <div className="mt-1.5">
              <StatusLine tone="neutral" icon={<TriangleAlert size={10} />}>
                读取下载状态失败（不影响保存设置）：{statusError}
              </StatusLine>
            </div>
          )}
        </div>

        <div data-engine-sources className="rounded-lg border border-line bg-bg-soft/50 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <Gauge size={11} className="shrink-0 text-ink-3" />
            <span className="text-[12px] text-ink-2">下载源探测</span>
            {probedAt && !sourcesLoading && (
              <span className="text-[10px] text-ink-4">
                {new Date(probedAt).toLocaleTimeString('zh-CN', { hour12: false })}
              </span>
            )}
            <button
              type="button"
              data-engine-sources-refresh
              className="btn ml-auto h-6 shrink-0 px-1.5 text-[10.5px]"
              onClick={() => void probeSources()}
              disabled={sourcesLoading}
              title="重新探测各下载源延迟"
            >
              {sourcesLoading ? <LoaderCircle size={10} className="animate-spin" /> : <RefreshCw size={10} />}
              <span className="ml-1">测速</span>
            </button>
          </div>

          {sourcesLoading && sources.length === 0 ? (
            <p className="mt-1.5 text-[10.5px] text-ink-4">正在探测官方源与镜像…</p>
          ) : sources.length === 0 ? (
            <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-4">
              {sourcesError
                ? `探测失败：${sourcesError}（下载时仍会自动尝试官方源）`
                : '暂无探测结果，点「测速」重新探测。'}
            </p>
          ) : (
            <div className="mt-1.5 space-y-1">
              {sources.map((source, index) => {
                const status = probeStatus(source)
                return (
                  <div
                    key={`${source.label}-${index}`}
                    data-engine-source-probe
                    data-engine-source-ok={source.ok === false ? 'false' : 'true'}
                    className="flex items-center gap-2 rounded-md border border-line/70 bg-bg-soft/40 px-2 py-1"
                  >
                    <span
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        status.tone === 'success' ? 'bg-success' : status.tone === 'danger' ? 'bg-danger' : 'bg-surface-3',
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] text-ink-2">{neutralSourceLabel(source.label)}</span>
                      {source.url && (
                        <span className="mono block truncate text-[9.5px] text-ink-4" title={source.url}>
                          {source.url}
                        </span>
                      )}
                      {source.error || source.detail ? (
                        <span
                          className="block truncate text-[9.5px] text-ink-4"
                          title={source.error ?? source.detail}
                        >
                          {source.error ?? source.detail}
                        </span>
                      ) : null}
                    </span>
                    <Badge tone={status.tone}>{status.text}</Badge>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex items-start gap-1.5 rounded-lg border border-line bg-bg-soft/50 px-2.5 py-2">
          <ShieldCheck size={11} className="mt-[1px] shrink-0 text-success" />
          <p className="text-[10.5px] leading-relaxed text-ink-3">
            所有下载文件在 manifest 里钉死 size + sha256：镜像只当作「传输通道」，内容不符会自动换源重试；
            第三方 GitHub 代理属于不可信中间人，介意的话把对应镜像填 off。
          </p>
        </div>

        <div className="flex items-center gap-1.5 text-[10.5px] text-ink-4">
          <CheckCircle2 size={10} className="shrink-0 text-success/70" />
          下载过程中「安装本机引擎」面板会显示当前源与实时速度（MB/s）。
        </div>
      </Section>
    </div>
  )
}
