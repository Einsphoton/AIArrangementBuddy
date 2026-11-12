/**
 * P8-C：按需训练入口（顶栏「训练风格」）。
 *
 * 只有用户点「下载并准备训练环境」/「开始训练」才会下载代码、数据集、独立 Python、
 * 基座检查点并创建 venv；训练完成后自动注册到 data/adapters/。
 *
 * 交互约定与其他 Companion 面板一致：Esc / 右上角 × / 点击遮罩都能关闭；
 * 关闭只停止前端轮询，服务端训练任务继续跑（面板内会说明）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BrainCircuit, Download, LoaderCircle, Sparkles, TriangleAlert, X } from 'lucide-react'
import {
  cancelTrainingJob,
  getTrainingJob,
  getTrainingStatus,
  startTrainingJob,
  startTrainingSetup,
  type TrainingJob,
  type TrainingStatus,
} from '../../lib/api'
import { useStore } from '../../store/store'
import { cn } from '../../lib/format'

const POLL_MS = 1500
const DEVICES = ['auto', 'mps', 'cuda', 'cpu']
const PRECISIONS = ['auto', 'fp32', 'bf16', 'fp16']

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

const PHASE_LABEL: Record<string, string> = {
  code: '训练代码',
  datasets: '数据集',
  python: '独立 Python',
  checkpoints: '基座检查点',
  env: '训练环境',
}

const FIELD_CLASS = 'field mt-1 h-8 w-full text-[12px]'

export function TrainingButton() {
  const pushToast = useStore((s) => s.pushToast)
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<TrainingStatus | null>(null)
  const [job, setJob] = useState<TrainingJob | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dataset, setDataset] = useState('jrpg_v2')
  const [tag, setTag] = useState('')
  const [style, setStyle] = useState('jrpg')
  const [epochs, setEpochs] = useState(120)
  const [device, setDevice] = useState('auto')
  const [precision, setPrecision] = useState('auto')
  const timer = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await getTrainingStatus()
      setStatus(next)
      return next
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open, refresh])
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
    },
    [],
  )

  /* Esc 关闭：与其他面板一致（不再因为「训练中」把用户锁在面板里） */
  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [open])

  const poll = (jobId: string) => {
    timer.current = window.setTimeout(async () => {
      try {
        const { job: latest } = await getTrainingJob(jobId)
        setJob(latest)
        if (latest.status === 'running') {
          poll(jobId)
          return
        }
        if (latest.status === 'done') {
          if (latest.adapterId) pushToast('success', `训练完成：适配器 ${latest.adapterId} 已加入模型管理器`)
          else pushToast('success', '训练环境准备完成')
          await refresh()
        } else {
          setError(latest.error ?? (latest.status === 'canceled' ? '已取消' : '任务失败'))
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '查询任务失败')
      }
    }, POLL_MS)
  }

  const runSetup = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await startTrainingSetup()
      setJob(result.job)
      poll(result.jobId)
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动失败')
    } finally {
      setBusy(false)
    }
  }

  const runTrain = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const finalTag = tag.trim() || `style_${Date.now().toString(36).slice(-6)}`
      const result = await startTrainingJob({ datasetId: dataset, tag: finalTag, styleId: style.trim() || undefined, epochs, device, precision })
      setJob(result.job)
      poll(result.jobId)
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动训练失败')
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    if (!job || job.status !== 'running') return
    try {
      await cancelTrainingJob(job.id)
      pushToast('info', '已请求取消训练任务')
    } catch {
      /* ignore */
    }
  }

  const missing = status ? Object.entries(status.phases).some(([, ready]) => !ready) : true
  const missingDownload = status?.missingBytes ?? 0
  const running = job?.status === 'running'

  return (
    <>
      <button
        type="button"
        data-training-trigger
        className="btn btn-ghost h-8 shrink-0 gap-1.5 px-2 text-[11px]"
        title="用自生成数据继续训练风格（按需下载训练代码/数据/检查点，不训练不下载）"
        onClick={() => setOpen(true)}
      >
        <BrainCircuit size={13} className="text-accent" />
        <span className="hidden min-[1360px]:inline">训练风格</span>
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[210] flex items-start justify-center overflow-y-auto bg-black/65 p-4 pt-[6vh]"
            role="dialog"
            aria-modal="true"
            aria-label="训练风格"
            onClick={() => setOpen(false)}
          >
            <div
              data-training-panel
              className="flex max-h-[88vh] w-full max-w-[620px] flex-col overflow-hidden rounded-xl border border-line-strong bg-surface-2 shadow-[0_32px_80px_-24px_rgba(0,0,0,0.9)]"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3">
                <div className="min-w-0">
                  <h2 className="flex items-center gap-1.5 text-[13.5px] font-semibold">
                    <BrainCircuit size={14} className="text-accent" />
                    训练风格适配器
                  </h2>
                  <p className="mt-1 text-[10.5px] leading-relaxed text-ink-4">
                    只在点击时下载训练代码/自生成数据集/基座检查点，并创建独立 Python 环境；训练完成后自动加入模型管理器。
                    {status && (
                      <span className="mt-0.5 block">
                        平台 <code>{status.platform}</code>
                      </span>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon -mr-1 -mt-1 h-7 w-7 shrink-0"
                  aria-label="关闭训练面板"
                  title="关闭（Esc）· 不会停止服务端训练"
                  onClick={() => setOpen(false)}
                >
                  <X size={13} />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {/* 阶段状态 */}
                <div className="mb-2.5 flex flex-wrap gap-1.5">
                  {status &&
                    Object.entries(status.phases).map(([phase, ready]) => (
                      <span
                        key={phase}
                        data-training-phase={phase}
                        className={cn(
                          'rounded border px-1.5 py-0.5 text-[10px]',
                          ready ? 'border-success/35 bg-success/8 text-success' : 'border-line bg-bg-soft text-ink-4',
                        )}
                      >
                        {ready ? '✓' : '○'} {PHASE_LABEL[phase] ?? phase}
                      </span>
                    ))}
                </div>

                {status && missing && (
                  <div className="rounded-lg border border-line bg-bg-soft px-2.5 py-2.5 text-[10.5px] text-ink-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0">
                        训练环境未就绪，需要下载约 <b className="text-ink-2">{humanBytes(missingDownload)}</b>
                        <span className="text-ink-4">
                          （检查点 {humanBytes(status.checkpointBytes)} / 数据集 {humanBytes(status.datasetBytes)} / Python）
                        </span>
                      </span>
                      <button
                        type="button"
                        data-training-setup
                        className="btn btn-accent h-7 shrink-0 px-2.5 text-[11px]"
                        disabled={busy || running}
                        onClick={() => void runSetup()}
                      >
                        {busy ? <LoaderCircle size={11} className="mr-1 animate-spin" /> : <Download size={11} className="mr-1" />}
                        下载并准备环境
                      </button>
                    </div>
                    <p className="mt-1.5 text-[10px] leading-relaxed text-ink-4">
                      macOS 建议 device=mps、precision=fp32，epochs 60–100 起步；Windows/Linux CUDA 用 cuda + bf16。
                    </p>
                  </div>
                )}

                {!missing && (
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <label className="block text-[11px] text-ink-3">
                      数据集
                      <select data-training-dataset className={FIELD_CLASS} value={dataset} onChange={(e) => setDataset(e.target.value)} disabled={running}>
                        <option value="jrpg_v1">jrpg_v1（12 段，小）</option>
                        <option value="jrpg_v2">jrpg_v2（30 段，推荐）</option>
                        <option value="jrock_v1">jrock_v1（30 段）</option>
                      </select>
                    </label>
                    <label className="block text-[11px] text-ink-3">
                      适配器名（tag）
                      <input data-training-tag className={cn(FIELD_CLASS, 'font-mono')} placeholder="my_jrpg_v1" value={tag} onChange={(e) => setTag(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))} disabled={running} />
                    </label>
                    <label className="block text-[11px] text-ink-3">
                      风格 ID（可选）
                      <input data-training-style className={cn(FIELD_CLASS, 'font-mono')} value={style} onChange={(e) => setStyle(e.target.value.toLowerCase())} disabled={running} />
                    </label>
                    <label className="block text-[11px] text-ink-3">
                      Epochs <span className="text-ink-4">（1–2000）</span>
                      <input data-training-epochs type="number" min={1} max={2000} className={FIELD_CLASS} value={epochs} onChange={(e) => setEpochs(Number(e.target.value) || 120)} disabled={running} />
                    </label>
                    <label className="block text-[11px] text-ink-3">
                      设备
                      <select data-training-device className={FIELD_CLASS} value={device} onChange={(e) => setDevice(e.target.value)} disabled={running}>
                        {DEVICES.map((item) => (
                          <option key={item} value={item}>{item}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-[11px] text-ink-3">
                      精度
                      <select data-training-precision className={FIELD_CLASS} value={precision} onChange={(e) => setPrecision(e.target.value)} disabled={running}>
                        {PRECISIONS.map((item) => (
                          <option key={item} value={item}>{item}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}

                {error && (
                  <p className="mt-2.5 flex items-start gap-1 rounded border border-danger/30 bg-danger/8 px-2 py-1.5 text-[10.5px] leading-relaxed text-danger">
                    <TriangleAlert size={11} className="mt-[2px] shrink-0" />
                    <span className="min-w-0 break-words">{error}</span>
                  </p>
                )}

                {job && (
                  <div className="mt-3 rounded-lg border border-line bg-bg-soft px-2.5 py-2">
                    <div className="flex items-center gap-2 text-[10.5px]">
                      <span className="min-w-0 truncate text-ink-2">
                        {job.kind === 'setup' ? '准备训练环境' : `训练 ${job.tag ?? ''}`} ·{' '}
                        {job.status === 'done' ? '完成' : job.status === 'failed' ? '失败' : job.status === 'canceled' ? '已取消' : '进行中'}
                      </span>
                      <span className="ml-auto shrink-0 font-mono text-ink-4" data-training-progress={Math.round(job.progress * 100)}>
                        {Math.round(job.progress * 100)}%
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
                      <div className={cn('h-full rounded-full transition-[width] duration-300', job.status === 'failed' ? 'bg-danger' : 'bg-accent')} style={{ width: `${Math.round(job.progress * 100)}%` }} />
                    </div>
                    <div className="mt-1.5 space-y-0.5">
                      {job.steps.map((step) => (
                        <div key={step.key} data-training-step data-training-step-status={step.status} className="flex items-center gap-1.5 text-[10px]">
                          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', step.status === 'done' ? 'bg-success' : step.status === 'failed' ? 'bg-danger' : step.status === 'running' ? 'animate-pulse bg-accent' : 'bg-surface-3')} />
                          <span className="min-w-0 flex-1 truncate text-ink-3">{step.label}</span>
                          <span className="mono shrink-0 text-ink-4">{step.status === 'running' ? `${Math.round(step.progress * 100)}%` : step.status === 'done' ? '完成' : step.status}</span>
                        </div>
                      ))}
                    </div>
                    {job.adapterId && job.status === 'done' && (
                      <p className="mt-1 flex items-center gap-1 text-[10px] text-success">
                        <Sparkles size={10} /> 已注册适配器 <code>{job.adapterId}</code>（模型管理器可用）
                      </p>
                    )}
                  </div>
                )}

                {running && (
                  <p className="mt-2 text-[10px] leading-relaxed text-ink-4">
                    关闭面板只会停止这里的进度刷新，服务端训练会继续；下次打开面板可再次查看状态。
                  </p>
                )}
              </div>

              <div className="flex shrink-0 items-center justify-end gap-1.5 border-t border-line px-4 py-2.5">
                {running ? (
                  <button type="button" data-training-cancel className="btn btn-ghost h-7 px-2.5 text-[11px]" onClick={() => void cancel()}>
                    取消训练
                  </button>
                ) : (
                  <button type="button" className="btn btn-ghost h-7 px-2.5 text-[11px]" onClick={() => setOpen(false)}>
                    关闭
                  </button>
                )}
                <button
                  type="button"
                  data-training-start
                  className="btn btn-accent h-7 px-3 text-[11px]"
                  disabled={busy || running || missing}
                  onClick={() => void runTrain()}
                  title={missing ? '先下载并准备训练环境' : '开始训练风格适配器'}
                >
                  {busy ? <LoaderCircle size={11} className="mr-1 animate-spin" /> : <Sparkles size={11} className="mr-1" />}
                  {running ? '训练中…' : '开始训练'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
