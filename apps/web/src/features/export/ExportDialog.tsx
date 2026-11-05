import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AudioLines,
  CircleCheck,
  Download,
  FileAudio,
  FileMusic,
  Film,
  LoaderCircle,
  RotateCcw,
  Square,
  TriangleAlert,
  Waves,
} from 'lucide-react'
import {
  beatsPerBar,
  deepClone,
  projectDurationSeconds,
  projectToMidiBlob,
  type Clip,
  type Project,
} from '@aiab/core'
import { ApiError, convertAudio, getHealth, type HealthInfo } from '../../lib/api'
import { getAudioEngine } from '../../audio'
import { Button, Modal, Select, Switch } from '../../components/ui'
import { useStore } from '../../store/store'
import { cn, downloadBlob, formatBytes, formatClock } from '../../lib/format'

type ExportFormat = 'mid' | 'wav' | 'mp3' | 'flac' | 'ogg'

interface FormatOption {
  id: ExportFormat
  name: string
  ext: string
  description: string
  icon: typeof FileMusic
  badge: string
  /** 需要服务端 ffmpeg 转码 */
  needsFfmpeg: boolean
  tone: string
}

const FORMATS: FormatOption[] = [
  {
    id: 'mid',
    name: 'MIDI',
    ext: '.mid',
    description: '保留音符、轨道与速度，可在任意 DAW 继续编辑',
    icon: FileMusic,
    badge: '可编辑',
    needsFfmpeg: false,
    tone: 'text-accent',
  },
  {
    id: 'wav',
    name: 'WAV',
    ext: '.wav',
    description: '44.1kHz 无损音频，浏览器本地离线渲染，无需后端',
    icon: Waves,
    badge: '无损',
    needsFfmpeg: false,
    tone: 'text-cyan',
  },
  {
    id: 'mp3',
    name: 'MP3',
    ext: '.mp3',
    description: '通用有损格式，体积小，适合分享与试听',
    icon: AudioLines,
    badge: '有损',
    needsFfmpeg: true,
    tone: 'text-violet',
  },
  {
    id: 'flac',
    name: 'FLAC',
    ext: '.flac',
    description: '无损压缩，适合归档与发行',
    icon: FileAudio,
    badge: '无损',
    needsFfmpeg: true,
    tone: 'text-success',
  },
  {
    id: 'ogg',
    name: 'OGG',
    ext: '.ogg',
    description: '开放的压缩格式，体积明显小于 WAV',
    icon: Film,
    badge: '压缩',
    needsFfmpeg: true,
    tone: 'text-pink',
  },
]

type JobStatus = 'idle' | 'rendering' | 'uploading' | 'done' | 'error'

interface ExportJob {
  status: JobStatus
  progress: number
  message?: string
  filename?: string
  size?: number
  /** 音频时长（秒） */
  duration?: number
}

const IDLE_JOB: ExportJob = { status: 'idle', progress: 0 }

export function ExportDialog() {
  const open = useStore((s) => s.exportOpen)
  const setOpen = useStore((s) => s.setExportOpen)
  const project = useStore((s) => s.project)
  const pushToast = useStore((s) => s.pushToast)

  const [format, setFormat] = useState<ExportFormat>('mid')
  const [filename, setFilename] = useState('')
  const [includeMuted, setIncludeMuted] = useState(false)
  const [loopOnly, setLoopOnly] = useState(false)
  const [bitrate, setBitrate] = useState('320k')
  const [job, setJob] = useState<ExportJob>(IDLE_JOB)
  const [health, setHealth] = useState<HealthInfo | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [healthLoading, setHealthLoading] = useState(false)

  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  /** 导出成功后的文件：用于「下载文件」按钮（浏览器下载被拦截时可手动重试） */
  const resultRef = useRef<{ blob: Blob; filename: string } | null>(null)
  const busy = job.status === 'rendering' || job.status === 'uploading'

  const loadHealth = useCallback(async () => {
    setHealthLoading(true)
    setHealthError(null)
    try {
      const info = await getHealth()
      setHealth(info)
    } catch (error) {
      setHealth(null)
      setHealthError(
        error instanceof Error && /fetch|network|load failed/i.test(error.message)
          ? '无法连接本地服务（127.0.0.1:8787）'
          : (error as Error).message || '无法读取后端状态',
      )
    } finally {
      setHealthLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setJob(IDLE_JOB)
    resultRef.current = null
    setFilename(project.name || '未命名工程')
    setLoopOnly(false)
    setIncludeMuted(false)
    void loadHealth()
  }, [open, project.name, loadHealth])

  useEffect(() => {
    return () => {
      if (tickerRef.current) clearInterval(tickerRef.current)
    }
  }, [])

  const ffmpegAvailable = health?.ffmpeg === true
  const backendOnline = Boolean(health) && !healthError
  const barBeats = beatsPerBar(project.timeSignature)
  const loopStartBar = Math.floor(project.loop.startBeat / barBeats) + 1
  const loopEndBar = Math.max(loopStartBar, Math.ceil(project.loop.endBeat / barBeats))
  const loopValid = project.loop.endBeat > project.loop.startBeat

  const activeFormat = FORMATS.find((item) => item.id === format) ?? FORMATS[0]
  const formatAvailable = !activeFormat.needsFfmpeg || ffmpegAvailable

  const exportProject = useMemo(
    () => buildExportProject(project, { includeMuted, loopOnly: loopOnly && loopValid }),
    [project, includeMuted, loopOnly, loopValid],
  )

  const duration = format === 'mid' ? 0 : projectDurationSeconds(exportProject)
  const estimatedSize = estimateBytes(format, duration, bitrate)

  const startTicker = () => {
    if (tickerRef.current) clearInterval(tickerRef.current)
    tickerRef.current = setInterval(() => {
      setJob((prev) =>
        prev.status === 'rendering'
          ? { ...prev, progress: Math.min(0.88, prev.progress + (0.9 - prev.progress) * 0.09) }
          : prev,
      )
    }, 220)
  }

  const stopTicker = () => {
    if (tickerRef.current) {
      clearInterval(tickerRef.current)
      tickerRef.current = null
    }
  }

  const rememberResult = (blob: Blob, name: string) => {
    resultRef.current = { blob, filename: name }
  }

  const handleDownloadAgain = () => {
    const result = resultRef.current
    if (!result) return
    downloadBlob(result.blob, result.filename)
    pushToast('success', '已重新下载文件')
  }

  const handleExport = async () => {
    if (busy) return
    if (!formatAvailable) {
      setJob({ status: 'error', progress: 0, message: '该格式需要服务端 ffmpeg，请先安装 ffmpeg 并重启后端。' })
      return
    }
    const finalBase = sanitizeFilename(filename || exportProject.name || '未命名工程')
    resultRef.current = null

    if (format === 'mid') {
      setJob({ status: 'rendering', progress: 0.35 })
      try {
        const blob = projectToMidiBlob(exportProject)
        downloadBlob(blob, `${finalBase}.mid`)
        rememberResult(blob, `${finalBase}.mid`)
        setJob({
          status: 'done',
          progress: 1,
          filename: `${finalBase}.mid`,
          size: blob.size,
          message: 'MIDI 已导出到下载目录',
        })
        pushToast('success', 'MIDI 导出完成')
      } catch (error) {
        const message = `MIDI 导出失败：${describeExportError(error)}`
        setJob({ status: 'error', progress: 0, message })
        pushToast('error', message)
      }
      return
    }

    /* WAV：浏览器本地离线渲染；MP3/FLAC/OGG：渲染后上传服务端转码 */
    setJob({ status: 'rendering', progress: 0.04 })
    startTicker()
    try {
      const engine = getAudioEngine()
      const wavBlob = await engine.renderToWav(exportProject)

      if (format === 'wav') {
        stopTicker()
        downloadBlob(wavBlob, `${finalBase}.wav`)
        rememberResult(wavBlob, `${finalBase}.wav`)
        setJob({
          status: 'done',
          progress: 1,
          filename: `${finalBase}.wav`,
          size: wavBlob.size,
          duration,
          message: 'WAV 已在本地渲染并导出',
        })
        pushToast('success', 'WAV 导出完成')
        return
      }

      stopTicker()
      setJob({ status: 'uploading', progress: 0.92, message: '上传到服务端转码…' })
      const converted = await convertAudio(wavBlob, format as 'mp3' | 'flac' | 'ogg', {
        bitrate: format === 'mp3' ? bitrate : undefined,
        projectName: finalBase,
      })
      downloadBlob(converted, `${finalBase}.${format}`)
      rememberResult(converted, `${finalBase}.${format}`)
      setJob({
        status: 'done',
        progress: 1,
        filename: `${finalBase}.${format}`,
        size: converted.size,
        duration,
        message: `${format.toUpperCase()} 已转码并导出`,
      })
      pushToast('success', `${format.toUpperCase()} 导出完成`)
    } catch (error) {
      stopTicker()
      const message = describeExportError(error)
      setJob({ status: 'error', progress: 0, message })
      pushToast('error', `导出失败：${message}`)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (busy) return
        setOpen(false)
      }}
      title="导出"
      subtitle="MIDI 可在任意 DAW 继续编辑；WAV 在浏览器本地渲染；MP3 / FLAC / OGG 由服务端 ffmpeg 转码。"
      width="lg"
      footer={
        <div className="flex w-full items-center gap-2">
          <div className="mr-auto flex min-w-0 flex-wrap items-center gap-2 text-[10.5px] text-ink-3">
            <span className="tabular-nums">
              {project.tracks.length} 轨 · {project.tempo} BPM
              {duration > 0 ? ` · 约 ${formatClock(duration)}` : ''}
              {estimatedSize > 0 ? ` · 预计 ${formatBytes(estimatedSize)}` : ''}
            </span>
            {!formatAvailable && <span className="text-danger">该格式需要服务端 ffmpeg</span>}
          </div>
          <Button size="sm" onClick={() => setOpen(false)} disabled={busy}>
            取消
          </Button>
          <Button
            variant="accent"
            size="sm"
            onClick={() => void handleExport()}
            disabled={busy || !formatAvailable}
            icon={
              busy ? (
                <LoaderCircle size={11} className="animate-spin" />
              ) : job.status === 'done' ? (
                <RotateCcw size={11} />
              ) : (
                <Download size={11} />
              )
            }
            title={formatAvailable ? `导出 ${activeFormat.name}` : '该格式需要服务端 ffmpeg'}
          >
            {busy ? (job.status === 'uploading' ? '转码中…' : '渲染中…') : job.status === 'done' ? '再次导出' : '开始导出'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3.5">
        {/* 后端状态 */}
        {healthError && (
          <div className="flex items-start gap-2 rounded-lg border border-danger/35 bg-danger/8 px-3 py-2">
            <TriangleAlert size={12} className="mt-[1px] shrink-0 text-danger" />
            <div className="min-w-0 flex-1 text-[11px] leading-relaxed text-ink-2">
              <div className="font-medium text-danger">后端未连接</div>
              <div className="mt-0.5 text-ink-3">
                {healthError}。WAV / MIDI 仍可正常导出；MP3 / FLAC / OGG 需要后端 ffmpeg。
              </div>
            </div>
            <button className="btn h-7 shrink-0 px-2 text-[10.5px]" onClick={() => void loadHealth()} disabled={healthLoading}>
              {healthLoading ? <LoaderCircle size={10} className="animate-spin" /> : '重试'}
            </button>
          </div>
        )}

        {/* 格式选择 */}
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="label">导出格式</span>
            {healthLoading && <LoaderCircle size={10} className="animate-spin text-ink-4" />}
            {!healthLoading && ffmpegAvailable && (
              <span className="text-[10px] text-success">服务端 ffmpeg 可用</span>
            )}
            {!healthLoading && !ffmpegAvailable && !healthError && backendOnline && (
              <span className="text-[10px] text-ink-4">服务端未检测到 ffmpeg</span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {FORMATS.map((item) => {
              const Icon = item.icon
              const active = format === item.id
              const unavailable = item.needsFfmpeg && !ffmpegAvailable
              return (
                <button
                  key={item.id}
                  onClick={() => setFormat(item.id)}
                  disabled={busy}
                  title={unavailable ? `${item.name} 需要服务端安装 ffmpeg` : item.description}
                  className={cn(
                    'relative flex flex-col rounded-xl border px-2.5 py-2 text-left transition-colors',
                    active
                      ? 'border-accent/50 bg-accent/10'
                      : 'border-line bg-surface-2/50 hover:border-line-strong hover:bg-surface-3/60',
                    unavailable && 'opacity-55',
                    busy && 'cursor-not-allowed',
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <span className={cn(active ? item.tone : 'text-ink-3')}>
                      <Icon size={13} />
                    </span>
                    <span className={cn('text-[12px] font-semibold', active ? 'text-ink' : 'text-ink-2')}>{item.name}</span>
                    {active && <CircleCheck size={11} className="text-accent" />}
                    <span className="ml-auto rounded border border-line-strong bg-bg-soft px-1 text-[9px] text-ink-3">
                      {item.badge}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 break-words text-[10px] leading-relaxed text-ink-4" title={item.description}>
                    {item.description}
                  </p>
                  <p className="mt-1 text-[9.5px] text-ink-4">{item.ext}</p>
                  {unavailable && <span className="mt-1 text-[9.5px] text-danger">需要服务端 ffmpeg</span>}
                </button>
              )
            })}
          </div>
        </div>

        {/* 选项 */}
        <div className="rounded-xl border border-line bg-surface-2/40 px-3 py-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-[10.5px] font-semibold tracking-wide text-ink-3">文件名</span>
              <div className="flex items-center gap-1.5">
                <input
                  className="field text-[12px]"
                  value={filename}
                  onChange={(event) => setFilename(event.target.value)}
                  placeholder="导出文件名"
                  disabled={busy}
                  aria-label="导出文件名"
                />
                <span className="mono shrink-0 text-[11px] text-ink-4">{activeFormat.ext}</span>
              </div>
            </label>

            {/* 导出范围：全曲 / 循环区间 */}
            <div className="sm:col-span-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-[10.5px] font-semibold tracking-wide text-ink-3">导出范围</span>
                <span className="text-[10px] text-ink-4">
                  {loopOnly && loopValid
                    ? `第 ${loopStartBar}–${loopEndBar} 小节 · 约 ${formatClock(duration)}`
                    : `全曲 · 约 ${formatClock(projectDurationSeconds(exportProject))}`}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="导出范围">
                <button
                  className={cn(
                    'flex h-8 items-center justify-center gap-1.5 rounded-lg border text-[11.5px] transition-colors',
                    !loopOnly
                      ? 'border-accent/50 bg-accent/10 text-ink'
                      : 'border-line bg-bg-soft/50 text-ink-3 hover:text-ink-2',
                  )}
                  onClick={() => setLoopOnly(false)}
                  disabled={busy}
                  aria-pressed={!loopOnly}
                >
                  <Square size={9} />
                  全曲
                </button>
                <button
                  className={cn(
                    'flex h-8 items-center justify-center gap-1.5 rounded-lg border text-[11.5px] transition-colors',
                    loopOnly && loopValid
                      ? 'border-accent/50 bg-accent/10 text-ink'
                      : 'border-line bg-bg-soft/50 text-ink-3 hover:text-ink-2',
                    !loopValid && 'cursor-not-allowed opacity-50',
                  )}
                  onClick={() => setLoopOnly(true)}
                  disabled={busy || !loopValid}
                  aria-pressed={loopOnly && loopValid}
                  title={loopValid ? `只导出第 ${loopStartBar}–${loopEndBar} 小节` : '循环区间无效（起止相同）'}
                >
                  <RotateCcw size={9} />
                  循环区间
                  {!loopValid && <span className="text-[9.5px] text-ink-4">（未设置）</span>}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-soft/50 px-2.5 py-2">
              <div>
                <div className="text-[11.5px] text-ink-2">包含静音轨</div>
                <div className="mt-0.5 text-[10px] text-ink-4">勾选后会忽略轨道的静音 / 独奏状态</div>
              </div>
              <Switch checked={includeMuted} label="包含静音轨" onChange={setIncludeMuted} />
            </div>

            {format === 'mp3' ? (
              <label className="block">
                <span className="mb-1 block text-[10.5px] font-semibold tracking-wide text-ink-3">MP3 码率</span>
                <Select
                  value={bitrate}
                  ariaLabel="MP3 码率"
                  options={[
                    { value: '128k', label: '128 kbps · 体积最小' },
                    { value: '192k', label: '192 kbps' },
                    { value: '256k', label: '256 kbps' },
                    { value: '320k', label: '320 kbps · 最高' },
                  ]}
                  onChange={setBitrate}
                />
              </label>
            ) : (
              <div className="flex items-center gap-2 rounded-lg border border-line bg-bg-soft/50 px-2.5 py-2 text-[10px] leading-relaxed text-ink-4">
                {format === 'mid'
                  ? 'MIDI 在浏览器本地生成，不需要后端与音频引擎。'
                  : format === 'wav'
                    ? 'WAV 在浏览器离线渲染（44.1kHz / 立体声），文件体积较大。'
                    : `${activeFormat.name} 由服务端 ffmpeg 转码，需要后端已安装 ffmpeg。`}
              </div>
            )}
          </div>
        </div>

        {/* 进度 / 结果 */}
        {job.status !== 'idle' && (
          <div
            className={cn(
              'rounded-xl border px-3 py-2.5',
              job.status === 'error'
                ? 'border-danger/35 bg-danger/8'
                : job.status === 'done'
                  ? 'border-success/30 bg-success/8'
                  : 'border-accent/30 bg-accent/8',
            )}
          >
            <div className="flex items-center gap-2">
              {job.status === 'error' ? (
                <TriangleAlert size={12} className="shrink-0 text-danger" />
              ) : job.status === 'done' ? (
                <CircleCheck size={12} className="shrink-0 text-success" />
              ) : (
                <LoaderCircle size={12} className="shrink-0 animate-spin text-accent" />
              )}
              <span className="text-[11.5px] font-medium text-ink">
                {job.status === 'rendering'
                  ? '正在渲染音频…'
                  : job.status === 'uploading'
                    ? '正在服务端转码…'
                    : job.status === 'done'
                      ? '导出完成'
                      : '导出失败'}
              </span>
              {job.status === 'done' && job.filename && (
                <span className="mono ml-auto truncate text-[10.5px] text-ink-3">
                  {job.filename}
                  {job.size ? ` · ${formatBytes(job.size)}` : ''}
                  {job.duration ? ` · ${formatClock(job.duration)}` : ''}
                </span>
              )}
            </div>

            {busy && (
              <div className="mt-2">
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-accent-dim to-accent transition-all duration-200"
                    style={{ width: `${Math.round(Math.min(1, job.progress) * 100)}%` }}
                  />
                </div>
                <div className="mt-1 flex items-center justify-between text-[10px] text-ink-4">
                  <span>
                    {job.message ?? (job.status === 'uploading' ? '上传 WAV 到服务端…' : '离线渲染中，工程越大耗时越久')}
                  </span>
                  <span className="mono tabular-nums">{Math.round(Math.min(1, job.progress) * 100)}%</span>
                </div>
              </div>
            )}

            {job.status === 'error' && (
              <div className="mt-1.5 flex items-start gap-2">
                <p className="min-w-0 flex-1 text-[10.5px] leading-relaxed text-ink-3">{job.message}</p>
                <button
                  className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-line-strong bg-surface-2 px-2 text-[10.5px] text-ink-2 hover:text-ink"
                  onClick={() => void handleExport()}
                  title="按当前选项重新导出"
                >
                  <RotateCcw size={9} />
                  重试
                </button>
              </div>
            )}

            {job.status === 'done' && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 text-[10.5px] text-ink-3">
                  {job.message ?? '文件已保存到浏览器的下载目录'} · 如果没有开始下载，可点击右侧按钮重新下载。
                </p>
                <button
                  className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-success/40 bg-success/10 px-2 text-[10.5px] text-success hover:bg-success/16"
                  onClick={handleDownloadAgain}
                  title="重新下载刚导出的文件"
                >
                  <Download size={9} />
                  下载文件
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function sanitizeFilename(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|\n\r\t]/g, '_').trim()
  return cleaned || '未命名工程'
}

/** 粗估文件大小（仅用于给用户一个数量级，实际以导出结果为准） */
function estimateBytes(format: ExportFormat, duration: number, bitrate: string): number {
  if (duration <= 0 || format === 'mid') return 0
  const wavBytes = duration * 44100 * 2 * 2
  switch (format) {
    case 'wav':
      return wavBytes
    case 'mp3': {
      const kbps = Number.parseInt(bitrate, 10) || 320
      return (kbps * 1000 * duration) / 8
    }
    case 'flac':
      return wavBytes * 0.58
    case 'ogg':
      return wavBytes * 0.11
    default:
      return 0
  }
}

function buildExportProject(
  project: Project,
  options: { includeMuted: boolean; loopOnly: boolean },
): Project {
  const cloned = deepClone(project)
  if (options.includeMuted) {
    cloned.tracks = cloned.tracks.map((track) => ({ ...track, mute: false, solo: false }))
  }
  if (!options.loopOnly) return cloned

  const start = Math.max(0, Math.min(project.loop.startBeat, project.loop.endBeat - 0.01))
  const end = Math.max(start + 0.01, project.loop.endBeat)
  cloned.tracks = cloned.tracks.map((track) => {
    const clips = track.clips
      .map((clip) => cropClip(clip, start, end))
      .filter((clip): clip is Clip => clip !== null)
    return { ...track, clips }
  })
  cloned.loop = { enabled: false, startBeat: 0, endBeat: end - start }
  const barBeats = beatsPerBar(project.timeSignature)
  const startBar = Math.floor(start / barBeats)
  cloned.sections = project.sections.map((section) => ({
    ...section,
    startBar: Math.max(0, section.startBar - startBar),
  }))
  return cloned
}

function cropClip(clip: Clip, start: number, end: number): Clip | null {
  const clipStart = clip.startBeat
  const clipEnd = clip.startBeat + clip.lengthBeats
  const visibleStart = Math.max(clipStart, start)
  const visibleEnd = Math.min(clipEnd, end)
  if (visibleEnd <= visibleStart) return null
  const offset = visibleStart - clipStart
  const length = visibleEnd - visibleStart
  const notes = clip.notes
    .map((note) => {
      const noteStart = note.start - offset
      const noteEnd = noteStart + note.duration
      if (noteEnd <= 0 || noteStart >= length) return null
      const clampedStart = Math.max(0, noteStart)
      const clampedEnd = Math.min(length, noteEnd)
      return { ...note, start: clampedStart, duration: Math.max(0.02, clampedEnd - clampedStart) }
    })
    .filter((note): note is NonNullable<typeof note> => note !== null)
  return { ...clip, startBeat: visibleStart - start, lengthBeats: length, notes }
}

function describeExportError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 501) return '服务端未安装 ffmpeg，无法导出该格式。可改用 WAV 或安装 ffmpeg 后重启后端。'
    if (error.status === 413) return '渲染文件过大，请尝试缩短循环区段后再导出。'
    return error.message
  }
  if (error instanceof Error) {
    if (/fetch|network|load failed/i.test(error.message)) {
      return '无法连接本地服务（127.0.0.1:8787）。WAV / MIDI 可离线导出，其他格式请先启动后端。'
    }
    return error.message
  }
  return '未知错误，请重试。'
}
