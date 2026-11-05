import { useCallback, useEffect, useState } from 'react'
import {
  AudioLines,
  Check,
  Download,
  FolderDown,
  Gauge,
  HardDrive,
  KeyRound,
  LoaderCircle,
  Music4,
  PlugZap,
  RefreshCw,
  Timer,
  Usb,
  Volume2,
  Waves,
} from 'lucide-react'
import { getAudioEngine } from '../../audio'
import { downloadSoundfont, listSoundfonts, type SoundfontInfo } from '../../lib/api'
import { Badge, Button, NumberField, Select, Slider, Switch } from '../../components/ui'
import { useStore } from '../../store/store'
import { cn, formatBytes } from '../../lib/format'
import { FieldGroup, Section, StatusLine } from './shared'
import type { SettingsSectionProps } from './shared'
import { describeRequestError } from './shared'

const MUSESCORE_HINTS = ['musescore', 'general', 'ms-general']

export function AudioSection({ draft, update }: SettingsSectionProps) {
  const engine = getAudioEngine()
  const ready = useStore((s) => s.ready)
  const soundfontStatus = useStore((s) => s.soundfontStatus)
  const midiDevices = useStore((s) => s.midiDevices)
  const midiActiveId = useStore((s) => s.midiActiveId)
  const setMidiDevices = useStore((s) => s.setMidiDevices)
  const setMidiActiveId = useStore((s) => s.setMidiActiveId)
  const pushToast = useStore((s) => s.pushToast)

  const [soundfonts, setSoundfonts] = useState<SoundfontInfo[]>([])
  const [bundled, setBundled] = useState(false)
  const [loadingFonts, setLoadingFonts] = useState(false)
  const [fontError, setFontError] = useState('')
  const [downloading, setDownloading] = useState<string | null>(null)
  const [downloadMessage, setDownloadMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [applyingFont, setApplyingFont] = useState(false)
  const [midiRefreshing, setMidiRefreshing] = useState(false)
  const [midiError, setMidiError] = useState('')

  const loadFonts = useCallback(async () => {
    setLoadingFonts(true)
    setFontError('')
    try {
      const result = await listSoundfonts()
      setSoundfonts(result.files ?? [])
      setBundled(Boolean(result.bundled))
    } catch (error) {
      setFontError(describeRequestError(error))
      setSoundfonts([])
    } finally {
      setLoadingFonts(false)
    }
  }, [])

  useEffect(() => {
    void loadFonts()
  }, [loadFonts])

  const museFile = soundfonts.find((file) =>
    MUSESCORE_HINTS.some((hint) => file.name.toLowerCase().includes(hint)),
  )

  const download = async (id: string) => {
    setDownloading(id)
    setDownloadMessage(null)
    try {
      const result = await downloadSoundfont(id)
      setDownloadMessage({ ok: Boolean(result.ok), text: result.message || (result.ok ? '下载完成' : '下载失败') })
      if (result.ok) {
        pushToast('success', result.message || '音色库下载完成')
        await loadFonts()
        if (result.url) {
          update((next) => {
            next.audio.soundfontUrl = result.url ?? ''
          })
        }
      } else {
        pushToast('error', result.message || '音色库下载失败')
      }
    } catch (error) {
      const text = describeRequestError(error)
      setDownloadMessage({ ok: false, text })
      pushToast('error', text)
    } finally {
      setDownloading(null)
    }
  }

  const applySoundfont = async (url: string) => {
    if (!url) {
      pushToast('error', '请先选择一个音色库文件')
      return
    }
    setApplyingFont(true)
    try {
      await engine.soundfont.load(url)
      pushToast('success', '音色库已加载')
    } catch (error) {
      pushToast('error', `音色库加载失败：${describeRequestError(error)}`)
    } finally {
      setApplyingFont(false)
    }
  }

  const refreshMidi = async () => {
    setMidiRefreshing(true)
    setMidiError('')
    try {
      if (!engine.midi.supported) {
        setMidiError('当前浏览器不支持 Web MIDI。请使用 Chrome / Edge，或在 Safari 中允许 MIDI 访问。')
        return
      }
      const devices = await engine.midi.refresh()
      setMidiDevices(
        devices.map((device) => ({ id: device.id, name: device.name })),
        engine.midi.activeId,
      )
      if (devices.length === 0) setMidiError('未检测到 MIDI 设备，请连接后重试。')
    } catch (error) {
      setMidiError(describeRequestError(error))
    } finally {
      setMidiRefreshing(false)
    }
  }

  const selectMidi = (id: string) => {
    try {
      engine.midi.select(id || null)
    } catch {
      /* ignore */
    }
    setMidiActiveId(id || null)
    update((next) => {
      next.audio.midiInputId = id
    })
  }

  return (
    <div className="space-y-3">
      <Section
        title="音频输出"
        description="设置应用主音量与音频引擎状态；工程内每轨音量在混音器里单独调节。"
        icon={<Volume2 size={13} />}
        badge={
          ready ? <Badge tone="success">引擎已就绪</Badge> : <Badge tone="neutral">等待用户手势</Badge>
        }
      >
        <FieldGroup
          label={`主音量 · ${Math.round(draft.audio.masterVolume * 100)}%`}
          hint="仅影响本机监听，不写入导出文件。首次点击页面后音频引擎才会启动。"
        >
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <Slider
                value={draft.audio.masterVolume}
                min={0}
                max={1.5}
                step={0.01}
                ariaLabel="主音量"
                onChange={(value) =>
                  update((next) => {
                    next.audio.masterVolume = value
                  })
                }
                onCommit={(value) => {
                  try {
                    engine.setMasterVolume(value)
                  } catch {
                    /* 引擎未初始化时忽略 */
                  }
                }}
              />
            </div>
            <NumberField
              value={Math.round(draft.audio.masterVolume * 100)}
              min={0}
              max={150}
              step={1}
              width={60}
              suffix="%"
              onChange={(value) =>
                update((next) => {
                  next.audio.masterVolume = value / 100
                })
              }
            />
          </div>
        </FieldGroup>

        <div className="flex items-center gap-2 text-[10.5px] text-ink-3">
          <Waves size={11} className="text-cyan" />
          {soundfontStatus.loaded ? (
            <span>
              采样音源：<span className="text-cyan">{soundfontStatus.name || '已加载'}</span>
            </span>
          ) : soundfontStatus.loading ? (
            <span>音色库加载中…</span>
          ) : (
            <span>当前使用内置合成器（未加载采样音源）</span>
          )}
        </div>
      </Section>

      <Section
        title="音色库（SoundFont）"
        description="加载 .sf2 采样音源可以明显提升钢琴、弦乐等乐器的真实感。"
        icon={<Music4 size={13} />}
        badge={bundled ? <Badge tone="success">服务端已内置</Badge> : null}
      >
        <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-soft/50 px-2.5 py-2">
          <div>
            <div className="text-[12px] text-ink-2">优先使用采样音源</div>
            <div className="mt-0.5 text-[10px] text-ink-4">关闭后强制使用内置合成器，启动更快</div>
          </div>
          <Switch
            checked={draft.audio.preferSoundfont}
            label="优先使用采样音源"
            onChange={(value) =>
              update((next) => {
                next.audio.preferSoundfont = value
              })
            }
          />
        </div>

        <div className="rounded-lg border border-line bg-bg-soft/50 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-line-strong bg-surface-2 text-accent">
              <HardDrive size={13} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium text-ink">MuseScore General</div>
              <div className="mt-0.5 text-[10px] text-ink-4">
                {museFile
                  ? `${museFile.name} · ${formatBytes(museFile.size)}${museFile.license ? ` · ${museFile.license}` : ''}`
                  : '通用 GM 音色库，覆盖绝大多数乐器'}
              </div>
            </div>
            <Button
              size="sm"
              variant="accent"
              onClick={() => void download('musescore-general')}
              disabled={downloading !== null}
              icon={downloading ? <LoaderCircle size={11} className="animate-spin" /> : <Download size={11} />}
            >
              {downloading ? '下载中…' : museFile ? '重新下载' : '一键下载'}
            </Button>
            {museFile && (
              <Button
                size="sm"
                variant="default"
                onClick={() => {
                  update((next) => {
                    next.audio.soundfontUrl = museFile.url
                  })
                  void applySoundfont(museFile.url)
                }}
                disabled={applyingFont}
                icon={applyingFont ? <LoaderCircle size={11} className="animate-spin" /> : <Check size={11} />}
              >
                加载
              </Button>
            )}
          </div>
          {downloadMessage && (
            <div className="mt-1.5">
              <StatusLine tone={downloadMessage.ok ? 'success' : 'danger'}>
                {downloadMessage.text}
              </StatusLine>
            </div>
          )}
        </div>

        <FieldGroup label="当前音色库文件" hint="加载后新音符将使用采样音源；已播放的轨道会在下一次触发时生效。">
          <div className="flex items-center gap-1.5">
            <Select
              value={draft.audio.soundfontUrl}
              ariaLabel="音色库文件"
              options={[
                { value: '', label: loadingFonts ? '读取中…' : soundfonts.length ? '选择音色库文件' : '暂无可用文件' },
                ...soundfonts.map((file) => ({
                  value: file.url,
                  label: `${file.name}（${formatBytes(file.size)}）`,
                })),
              ]}
              onChange={(value) =>
                update((next) => {
                  next.audio.soundfontUrl = value
                })
              }
            />
            <button
              className="btn h-8 shrink-0 px-2 text-[11px]"
              onClick={() => void applySoundfont(draft.audio.soundfontUrl)}
              disabled={applyingFont || !draft.audio.soundfontUrl}
              title="加载选中的音色库"
            >
              {applyingFont ? <LoaderCircle size={11} className="animate-spin" /> : <FolderDown size={11} />}
            </button>
            <button
              className="btn h-8 shrink-0 px-2 text-[11px]"
              onClick={() => void loadFonts()}
              title="刷新服务端音色库列表"
            >
              <RefreshCw size={11} />
            </button>
          </div>
        </FieldGroup>

        {fontError ? (
          <StatusLine tone="danger" icon={<PlugZap size={10} />}>
            {fontError}
          </StatusLine>
        ) : soundfonts.length > 0 ? (
          <div className="space-y-1">
            {soundfonts.map((file) => (
              <div
                key={file.url}
                className={cn(
                  'flex items-center gap-2 rounded-md border px-2 py-1.5',
                  draft.audio.soundfontUrl === file.url
                    ? 'border-accent/35 bg-accent/8'
                    : 'border-line/70 bg-bg-soft/40',
                )}
              >
                <AudioLines size={11} className="shrink-0 text-cyan" />
                <span className="min-w-0 flex-1 truncate text-[11px] text-ink-2">{file.name}</span>
                <span className="mono shrink-0 text-[9.5px] text-ink-4">{formatBytes(file.size)}</span>
                {file.license && <Badge tone="neutral">{file.license}</Badge>}
                <button
                  className="btn h-6 shrink-0 px-1.5 text-[10px]"
                  onClick={() => {
                    update((next) => {
                      next.audio.soundfontUrl = file.url
                    })
                    void applySoundfont(file.url)
                  }}
                  title="加载该音色库"
                >
                  加载
                </button>
                <button
                  className="btn h-6 shrink-0 px-1.5 text-[10px]"
                  disabled={downloading !== null}
                  onClick={() => void download(soundfontDownloadId(file))}
                  title="重新下载该音色库"
                >
                  {downloading === soundfontDownloadId(file) ? <LoaderCircle size={9} className="animate-spin" /> : <Download size={9} />}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <span className="text-[10.5px] text-ink-4">
            {loadingFonts ? '正在读取服务端音色库…' : '服务端未提供音色库文件，可先一键下载 MuseScore General。'}
          </span>
        )}
      </Section>

      <Section
        title="MIDI 输入"
        description="连接 MIDI 键盘后可直接弹奏并录入音符，设备列表来自浏览器 Web MIDI。"
        icon={<Usb size={13} />}
        badge={
          midiDevices.length ? <Badge tone="success">{midiDevices.length} 个设备</Badge> : <Badge tone="neutral">未检测</Badge>
        }
      >
        <FieldGroup label="输入设备" hint={midiError || '在 Chrome / Edge 中支持最好；首次使用需允许 MIDI 权限。'}>
          <div className="flex items-center gap-1.5">
            <Select
              value={midiActiveId ?? ''}
              ariaLabel="MIDI 输入设备"
              options={[
                { value: '', label: midiDevices.length ? '不启用 MIDI 输入' : '未检测到设备' },
                ...midiDevices.map((device) => ({ value: device.id, label: device.name })),
              ]}
              onChange={selectMidi}
            />
            <button
              className="btn h-8 shrink-0 px-2 text-[11px]"
              onClick={() => void refreshMidi()}
              disabled={midiRefreshing}
              title="刷新 MIDI 设备"
            >
              {midiRefreshing ? <LoaderCircle size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            </button>
          </div>
        </FieldGroup>

        <FieldGroup label={`延迟补偿 · ${draft.audio.midiLatencyMs > 0 ? '+' : ''}${draft.audio.midiLatencyMs} ms`} hint="如果录音比实际弹奏偏早，适当增大；偏晚则减小。">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <Slider
                value={draft.audio.midiLatencyMs}
                min={-200}
                max={400}
                step={5}
                ariaLabel="MIDI 延迟补偿"
                onChange={(value) =>
                  update((next) => {
                    next.audio.midiLatencyMs = Math.round(value / 5) * 5
                  })
                }
              />
            </div>
            <NumberField
              value={draft.audio.midiLatencyMs}
              min={-200}
              max={400}
              step={5}
              width={66}
              suffix="ms"
              onChange={(value) =>
                update((next) => {
                  next.audio.midiLatencyMs = Math.round(value)
                })
              }
            />
          </div>
        </FieldGroup>

        <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-soft/50 px-2.5 py-2">
          <div>
            <div className="flex items-center gap-1.5 text-[12px] text-ink-2">
              <Timer size={11} className="text-ink-3" />
              MIDI Thru（监听直出）
            </div>
            <div className="mt-0.5 text-[10px] text-ink-4">弹奏时立即发声，方便试听音色</div>
          </div>
          <Switch
            checked={draft.audio.midiThru}
            label="MIDI Thru"
            onChange={(value) =>
              update((next) => {
                next.audio.midiThru = value
              })
            }
          />
        </div>

        {midiError && (
          <StatusLine tone="danger" icon={<KeyRound size={10} />}>
            {midiError}
          </StatusLine>
        )}
      </Section>

      <Section title="引擎信息" description="用于排查音频问题。" icon={<Gauge size={13} />}>
        <div className="grid grid-cols-2 gap-2 text-[10.5px] text-ink-3">
          <div className="rounded-lg border border-line bg-bg-soft/40 px-2.5 py-1.5">
            <div className="text-ink-4">引擎状态</div>
            <div className={ready ? 'text-success' : 'text-ink-2'}>{ready ? '运行中' : '等待初始化'}</div>
          </div>
          <div className="rounded-lg border border-line bg-bg-soft/40 px-2.5 py-1.5">
            <div className="text-ink-4">采样音源</div>
            <div className={soundfontStatus.loaded ? 'text-cyan' : 'text-ink-2'}>
              {soundfontStatus.loaded ? soundfontStatus.name || '已加载' : '合成器'}
            </div>
          </div>
        </div>
      </Section>
    </div>
  )
}

/** 服务端下载接口使用固定 id，而不是文件名 */
function soundfontDownloadId(file: SoundfontInfo): string {
  const name = file.name.toLowerCase()
  if (name.includes('generaluser')) return 'generaluser-gs'
  if (name.endsWith('.sf2')) return 'musescore-general-sf2'
  return 'musescore-general'
}
