/**
 * SoundFont 采样引擎（spessasynth_lib v4 / AudioWorklet）。
 *
 * 契约见 `./types.ts` 的 `SoundfontManager`。实现要点：
 *
 * - **懒加载**：只有 UI 真正调用 `load(url)` 时才创建 AudioWorklet 与合成器，
 *   没有音色库时引擎完全走内置合成器，不影响启动。
 * - **加载进度**：`onStatus` 的 status 对象带一个可选的 `progress`（0..1），
 *   来自 fetch 的 ReadableStream 读取进度；状态里同时给出 loading / error。
 * - **失败回退**：worklet 注册失败、音色库解析失败、网络失败都会把 `loaded` 置 false，
 *   引擎据此自动回退到合成器，绝不阻塞播放。
 * - **按轨分通道**：一个 WorkletSynthesizer 用 16 个 MIDI 通道承载多轨。
 *   P3.1 起支持**逐通道输出**（`connectChannel` / `disconnectChannel`）：
 *   引擎把每个通道接到该轨的 `sfIn`，让它和合成器/音频片段一样经过每轨
 *   EQ / 压缩 / 推子处理链；此时主输出会被关掉（避免双声），
 *   音量/声像/混响/合唱改由 Tone.Channel 与节点链的 send 负责，
 *   CC7/CC10/CC91/CC93 固定为中性值，仅保留 CC74 brightness / CC1 modulation。
 *   若通道不够（>16 条采样轨，出现通道共用）或运行时缺少 connectChannel，
 *   引擎会回退到旧的全局输出模式（主输出直连 destination，不经过每轨处理链）。
 *   限制：采样音源内部的混响/合唱是全局效果器；per-channel 模式下混响/合唱/延迟
 *   发送由该轨**处理链之后**的 send 抽头负责（postSend 门控），global 模式下 delaySend 仍不生效。
 * - **离线渲染**：`renderOffline()` 用 OfflineAudioContext + WorkletSynthesizer.startOfflineRender
 *   渲染 MIDI（由工程 MIDI 导出得到），比实时更接近原厂音色。
 *
 * 关于 Vite 打包：`spessasynth_processor.min.js` 必须由页面同源提供，这里用
 * `import ... ?url` 让 Vite 把它当静态资源产出（构建后是 /assets/xxx.js），
 * 再由 `audioWorklet.addModule(url)` 注册。若浏览器不支持 AudioWorklet，
 * 或者 addModule 失败，会抛错并被上层捕获回退。
 */
import { Sequencer, WorkletSynthesizer } from 'spessasynth_lib'
import processorUrl from 'spessasynth_lib/dist/spessasynth_processor.min.js?url'
import type { SoundfontManager } from './types'
import { clamp } from './util'

export interface SoundfontStatus {
  loaded: boolean
  name: string
  loading: boolean
  error: string | null
  progress?: number
}

export interface SoundfontChannelMix {
  volume: number
  pan: number
  /** 0..1，映射到 CC91 */
  reverb: number
  /** 0..1，映射到 CC93 */
  chorus: number
  /** 0..1，映射到 CC74 (brightness) */
  brightness: number
  /** 0..1，映射到 CC1 (modulation/wah) */
  modulation: number
  muted: boolean
}

/** 已注册 worklet 的上下文，避免重复 addModule */
const registeredContexts = new WeakSet<BaseAudioContext>()

async function readResponseWithProgress(
  response: Response,
  onProgress: (ratio: number) => void,
): Promise<ArrayBuffer> {
  const total = Number(response.headers.get('content-length') || 0)
  if (!response.body) {
    onProgress(0.5)
    return response.arrayBuffer()
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    received += value.byteLength
    // 没有 Content-Length 时用「已读字节数 / 估计 40MB」给出粗略进度，不假装精确
    const ratio = total > 0 ? received / total : clamp(received / (40 * 1024 * 1024), 0, 0.95)
    onProgress(clamp(ratio, 0, 0.98))
  }
  const merged = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  onProgress(1)
  return merged.buffer
}

export class SoundfontEngine implements SoundfontManager {
  loaded = false
  name = ''
  loading = false
  error: string | null = null

  private progress = 0
  private context: BaseAudioContext | null = null
  private destination: AudioNode | null = null
  private synth: WorkletSynthesizer | null = null
  private synthPromise: Promise<WorkletSynthesizer> | null = null
  /** addSoundBank 会把 buffer transfer 掉，这里保留一份副本给离线渲染 */
  private bankBuffer: ArrayBuffer | null = null
  private pendingUrl: string | null = null
  private autoLoadAttempted = false
  private currentUrl = ''
  private autoLoadPromise: Promise<boolean> | null = null
  private readonly statusHandlers = new Set<(status: SoundfontStatus) => void>()
  private readonly channels = new Map<string, number>()
  private readonly channelOwners = new Map<number, string>()
  /** 主输出（synth → 引擎总线）是否启用；逐通道路由时关掉，避免与抽头双声 */
  private mainOutputEnabled = true
  private mainOutputConnected = false

  /** 引擎初始化后注入音频上下文与总线（SoundFont 的主输出会接到这个节点） */
  configure(context: BaseAudioContext, destination: AudioNode): void {
    const changed = this.context !== context
    this.context = context
    this.destination = destination
    if (changed && this.synth) {
      // 上下文变了（极少见，例如整个音频引擎重建）：旧合成器作废
      this.destroySynth()
    }
    if (this.pendingUrl) {
      const url = this.pendingUrl
      this.pendingUrl = null
      this.loading = false
      void this.load(url)
    }
  }

  /** 音色库是否可用于实时播放 */
  get usable(): boolean {
    return this.loaded && !!this.synth && !!this.bankBuffer
  }

  get soundBankBuffer(): ArrayBuffer | null {
    return this.bankBuffer ? this.bankBuffer.slice(0) : null
  }

  get synthesizer(): WorkletSynthesizer | null {
    return this.synth
  }

  get processorUrl(): string {
    return processorUrl
  }

  private emit(extra: Partial<SoundfontStatus> = {}): void {
    const status: SoundfontStatus = {
      loaded: this.loaded,
      name: this.name,
      loading: this.loading,
      error: this.error,
      progress: this.progress,
      ...extra,
    }
    this.statusHandlers.forEach((handler) => {
      try {
        handler(status)
      } catch {
        /* 订阅者异常不影响引擎 */
      }
    })
  }

  async available(): Promise<{ name: string; url: string; size: number; license?: string }[]> {
    try {
      const response = await fetch('/api/soundfonts')
      if (!response.ok) return []
      const body = (await response.json()) as {
        files?: { name: string; url: string; size: number; license?: string }[]
      }
      return Array.isArray(body.files) ? body.files : []
    } catch {
      return []
    }
  }

  private async ensureWorklet(context: BaseAudioContext): Promise<void> {
    if (registeredContexts.has(context)) return
    const worklet = (context as AudioContext).audioWorklet
    if (!worklet || typeof worklet.addModule !== 'function') {
      throw new Error('当前浏览器不支持 AudioWorklet，采样音源不可用')
    }
    await worklet.addModule(processorUrl)
    registeredContexts.add(context)
  }

  private async ensureSynth(): Promise<WorkletSynthesizer> {
    if (this.synth) return this.synth
    if (!this.context || !this.destination) throw new Error('音频引擎尚未初始化')
    if (!this.synthPromise) {
      const context = this.context
      const destination = this.destination
      this.synthPromise = (async () => {
        await this.ensureWorklet(context)
        const synth = new WorkletSynthesizer(context)
        // 先登记并建立主输出，保证「加载完成前」也走旧行为；引擎随后会按路由模式调整
        this.synth = synth
        this.mainOutputConnected = false
        this.syncMainOutput(destination)
        await synth.isReady
        return synth
      })().catch((error: unknown) => {
        // 初始化失败：不要留下半成品 synth，否则下次 ensureSynth 会拿到坏实例
        this.synth = null
        this.mainOutputConnected = false
        this.synthPromise = null
        throw error
      })
    }
    return this.synthPromise
  }

  /** 按 `mainOutputEnabled` 连接/断开 synth → destination（幂等） */
  private syncMainOutput(destination: AudioNode | null = this.destination): void {
    const synth = this.synth
    if (!synth || !destination) return
    const want = this.mainOutputEnabled
    if (want === this.mainOutputConnected) return
    try {
      if (want) synth.connect(destination)
      else synth.disconnect(destination)
      this.mainOutputConnected = want
    } catch (error) {
      console.warn('[soundfont] 切换主输出失败', error)
    }
  }

  /**
   * 开关主输出（P3.1）。
   * 逐通道路由模式下必须关闭，否则同一路声音会同时从主输出和 `sfIn` 抽头出来（双声）。
   */
  setMainOutput(enabled: boolean): void {
    this.mainOutputEnabled = enabled
    this.syncMainOutput()
  }

  /** 主输出当前是否真的连着（调试 / 自检用） */
  get mainOutputActive(): boolean {
    return this.mainOutputConnected
  }

  /** 当前 spessasynth 是否支持逐通道输出抽头 */
  supportsPerChannelRouting(): boolean {
    const synth = this.synth as unknown as
      | { connectChannel?: unknown; disconnectChannel?: unknown }
      | null
    return Boolean(
      synth &&
        typeof synth.connectChannel === 'function' &&
        typeof synth.disconnectChannel === 'function',
    )
  }

  /** 把某个 MIDI 通道的输出接到目标节点（逐通道路由用）；失败返回 false */
  routeChannelTo(target: AudioNode, channel: number): boolean {
    const synth = this.synth
    if (!synth || !this.supportsPerChannelRouting()) return false
    try {
      synth.connectChannel(target, channel)
      return true
    } catch (error) {
      console.warn('[soundfont] 逐通道路由失败', channel, error)
      return false
    }
  }

  /** 断开某个 MIDI 通道到目标节点的连接（不影响该通道的其它抽头，例如电平表） */
  unrouteChannelFrom(target: AudioNode, channel: number): void {
    const synth = this.synth
    if (!synth || !this.supportsPerChannelRouting()) return
    try {
      synth.disconnectChannel(target, channel)
    } catch (error) {
      console.warn('[soundfont] 逐通道断开失败', channel, error)
    }
  }

  async load(url: string): Promise<void> {
    // 加载/下载中时忽略重复请求（自动加载与设置页手动点击可能撞车）；
    // 已经加载过的同一个 URL 直接跳过，但允许换成另一个音色库（热切换）
    if (this.loading) return
    if (this.loaded && this.currentUrl === url) return
    if (!url) {
      this.error = '音色库地址为空'
      this.emit()
      return
    }
    if (!this.context || !this.destination) {
      // 还没有用户手势创建 AudioContext：先记下来，引擎 init 后自动继续
      this.pendingUrl = url
      this.loading = true
      this.error = null
      this.progress = 0
      this.emit()
      return
    }

    this.loading = true
    this.error = null
    this.progress = 0
    this.loaded = false
    this.emit()

    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`下载音色库失败：HTTP ${response.status}`)
      const buffer = await readResponseWithProgress(response, (ratio) => {
        this.progress = ratio * 0.92
        this.emit()
      })
      this.progress = 0.94
      this.emit()

      const synth = await this.ensureSynth()
      // 保留副本给离线渲染，transfer 原件给合成器
      this.bankBuffer = buffer.slice(0)
      await synth.soundBankManager.addSoundBank(buffer, 'aiab-main')
      await synth.isReady

      this.name = decodeURIComponent(url.split('/').filter(Boolean).pop() || 'SoundFont')
      this.currentUrl = url
      this.loaded = true
      this.error = null
      this.progress = 1
      this.loading = false
      // 加载完成后重置通道分配，让引擎重新按新音色库分配 program
      this.channels.clear()
      this.channelOwners.clear()
      this.emit()
    } catch (error) {
      this.loaded = false
      this.bankBuffer = null
      this.loading = false
      this.progress = 0
      this.error = error instanceof Error ? error.message : '音色库加载失败'
      console.warn('[soundfont] 加载失败，回退到内置合成器', error)
      this.emit()
    }
  }

  /**
   * 开箱即用：自动探测并加载音色库。
   *
   * - 优先读 `/api/settings` 的 `audio.soundfontUrl`（用户在设置里指定的库）；
   * - 没有指定就取 `GET /api/soundfonts` 返回的第一个文件；
   * - `audio.preferSoundfont === false` 时直接跳过（用户显式关闭采样引擎）；
   * - 后端没启动 / 404 / 解析失败都静默回退到内置合成器，不影响播放。
   *
   * 只会自动尝试一次（用户手动 unload 后不会被悄悄重新加载）。
   */
  async autoLoad(): Promise<boolean> {
    if (this.loaded) return true
    if (this.autoLoadPromise) return this.autoLoadPromise
    // 注意：失败后要清掉缓存的 promise，否则后端晚就绪时永远重试不了
    this.autoLoadPromise = this.runAutoLoad().finally(() => {
      this.autoLoadPromise = null
    })
    return this.autoLoadPromise
  }

  private async runAutoLoad(): Promise<boolean> {
    if (this.autoLoadAttempted) return this.loaded
    this.autoLoadAttempted = true
    try {
      let preferSoundfont = true
      let configuredUrl = ''
      try {
        const response = await fetch('/api/settings')
        if (response.ok) {
          const body = (await response.json()) as { audio?: { preferSoundfont?: boolean; soundfontUrl?: string } }
          if (body?.audio) {
            preferSoundfont = body.audio.preferSoundfont !== false
            configuredUrl = typeof body.audio.soundfontUrl === 'string' ? body.audio.soundfontUrl.trim() : ''
          }
        }
      } catch {
        // 后端未启动：仍然尝试 /api/soundfonts（多数情况也会失败），失败即回退
      }
      if (!preferSoundfont) return false

      let url = configuredUrl
      if (!url) {
        const files = await this.available()
        if (files.length === 0) {
          // 后端可能刚启动 / 用户还没下载音色库：允许之后再次 autoLoad（不缓存失败）
          this.autoLoadAttempted = false
          return false
        }
        // 优先 sf3（体积更小），没有就取第一个
        const first = files.find((file) => /\.sf3$/i.test(file.name)) ?? files[0]
        url = first.url || `/soundfonts/${encodeURIComponent(first.name)}`
      }
      await this.load(url)
      return this.loaded
    } catch (error) {
      this.loading = false
      this.error = error instanceof Error ? error.message : '音色库自动加载失败'
      console.warn('[soundfont] 自动加载失败，回退到内置合成器', error)
      this.emit()
      return false
    }
  }

  unload(): void {
    this.destroySynth()
    this.currentUrl = ''
    this.loaded = false
    this.name = ''
    this.error = null
    this.loading = false
    this.progress = 0
    this.channels.clear()
    this.channelOwners.clear()
    this.emit()
  }

  onStatus(handler: (status: SoundfontStatus) => void): () => void {
    this.statusHandlers.add(handler)
    return () => this.statusHandlers.delete(handler)
  }

  /* ---------------------------------------------------------------- */
  /* 多轨通道管理                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * 为一条轨道分配 MIDI 通道。
   * 鼓轨优先使用通道 9（GM 鼓通道），其余轨道顺序占用空闲通道。
   */
  assignChannel(trackId: string, isDrum: boolean): number | null {
    if (!this.synth) return null
    const existing = this.channels.get(trackId)
    if (existing !== undefined) return existing

    const channelCount = Math.max(16, this.synth.midiChannels?.length ?? 16)
    const order: number[] = []
    if (isDrum) order.push(9)
    for (let i = 0; i < channelCount; i++) {
      if (i === 9) continue
      order.push(i)
    }
    if (!isDrum) order.push(9)

    let chosen = order.find((channel) => !this.channelOwners.has(channel))
    if (chosen === undefined) {
      // 通道用尽：按轨道 id 哈希复用（会与其他轨道共享通道，属于已知限制）
      let hash = 0
      for (let i = 0; i < trackId.length; i++) hash = (hash * 31 + trackId.charCodeAt(i)) >>> 0
      chosen = hash % channelCount
    }
    this.channels.set(trackId, chosen)
    this.channelOwners.set(chosen, trackId)
    try {
      this.synth.midiChannels[chosen]?.setDrums(isDrum)
    } catch (error) {
      console.warn('[soundfont] 设置鼓通道失败', error)
    }
    return chosen
  }

  releaseChannel(trackId: string): void {
    const channel = this.channels.get(trackId)
    if (channel === undefined) return
    this.channels.delete(trackId)
    if (this.channelOwners.get(channel) === trackId) this.channelOwners.delete(channel)
    // 只解除映射，不做 stopAll：其他轨道可能正在用采样器发声
    // （挂起的音符由 engine 的 releaseAllVoices / noteOff 负责收尾）
  }

  channelFor(trackId: string): number | null {
    return this.channels.get(trackId) ?? null
  }

  /** 设置音色（GM program）。鼓轨忽略 program（鼓组由 bank 决定） */
  setProgram(trackId: string, program: number, isDrum: boolean): void {
    const channel = this.channels.get(trackId)
    if (channel === undefined || !this.synth || isDrum) return
    try {
      this.synth.programChange(channel, clamp(Math.round(program), 0, 127))
    } catch {
      /* ignore */
    }
  }

  /**
   * 用 MIDI CC 实现逐轨混音。
   *
   * `perChannelRouting=true`（P3.1 逐通道路由）时，声音已经走每轨 Tone.Channel +
   * EQ/压缩链，因此音量/声像/混响/合唱的 CC 全部设成中性值（CC7=127、CC10=64、
   * CC91=0、CC93=0），避免「引擎推子 + 采样器 CC 音量」压两次；
   * 只保留 CC74 brightness / CC1 modulation 这类音色型 CC。
   */
  applyChannelMix(
    trackId: string,
    mix: SoundfontChannelMix,
    options: { perChannelRouting?: boolean } = {},
  ): void {
    const channel = this.channels.get(trackId)
    const synth = this.synth
    if (channel === undefined || !synth) return
    const perChannel = options.perChannelRouting === true
    try {
      if (perChannel) {
        synth.controllerChange(channel, 7, 127)
        synth.controllerChange(channel, 10, 64)
        synth.controllerChange(channel, 91, 0)
        synth.controllerChange(channel, 93, 0)
      } else {
        synth.controllerChange(channel, 7, mix.muted ? 0 : clamp(Math.round(mix.volume * 100), 0, 127))
        synth.controllerChange(channel, 10, clamp(Math.round((mix.pan + 1) * 63.5), 0, 127))
        synth.controllerChange(channel, 91, clamp(Math.round(mix.reverb * 127), 0, 127))
        synth.controllerChange(channel, 93, clamp(Math.round(mix.chorus * 127), 0, 127))
      }
      synth.controllerChange(channel, 74, clamp(Math.round(mix.brightness * 127), 0, 127))
      synth.controllerChange(channel, 1, clamp(Math.round(mix.modulation * 127), 0, 127))
    } catch {
      /* ignore */
    }
  }

  noteOn(trackId: string, pitch: number, velocity: number, time: number): boolean {
    const channel = this.channels.get(trackId)
    if (channel === undefined || !this.synth) return false
    try {
      this.synth.noteOn(channel, clamp(Math.round(pitch), 0, 127), clamp(Math.round(velocity), 1, 127), { time })
      return true
    } catch (error) {
      console.warn('[soundfont] noteOn 失败', error)
      return false
    }
  }

  noteOff(trackId: string, pitch: number, time: number): void {
    const channel = this.channels.get(trackId)
    if (channel === undefined || !this.synth) return
    try {
      this.synth.noteOff(channel, clamp(Math.round(pitch), 0, 127), { time })
    } catch {
      /* ignore */
    }
  }

  /** 全部音符立即释放（停止播放 / 拖动播放头） */
  panic(): void {
    try {
      this.synth?.stopAll()
    } catch {
      /* ignore */
    }
  }

  /* ---------------------------------------------------------------- */
  /* 离线渲染                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * 用 SoundFont 离线渲染一段 MIDI 字节（标准 MIDI 文件）。
   *
   * 实现方式：借用一个实时合成器的 `Sequencer.getMIDI()` 把 SMF 解析成
   * spessasynth_core 的 BasicMIDI 实例，再交给 OfflineAudioContext 里的
   * WorkletSynthesizer.startOfflineRender 渲染。
   *
   * 已知限制：Chromium 下 OfflineAudioContext 的 worklet 消息处理有坑，
   * 因此必须在创建合成器后立刻调用 startOfflineRender（官方示例的顺序）。
   */
  async renderOffline(
    midiBytes: ArrayBuffer,
    durationSec: number,
    sampleRate: number,
    onProgress?: (ratio: number) => void,
    tailSeconds = 2,
  ): Promise<AudioBuffer> {
    if (!this.bankBuffer) throw new Error('未加载音色库')
    const liveSynth = await this.ensureSynth()

    // 1) 用实时合成器解析 MIDI（Sequencer.getMIDI 返回主线程可用的 BasicMIDI 实例）
    const sequencer = new Sequencer(liveSynth)
    sequencer.loadNewSongList([{ binary: midiBytes, fileName: 'aiab-render.mid' }])
    const parsed = await sequencer.getMIDI()

    // 2) 离线上下文中创建合成器并开始渲染
    const length = Math.max(1, Math.ceil((durationSec + tailSeconds) * sampleRate))
    const OfflineCtor = window.OfflineAudioContext
    const offline = new OfflineCtor(2, length, sampleRate)
    await this.ensureWorklet(offline)
    const synth = new WorkletSynthesizer(offline, { eventsEnabled: false })
    synth.connect(offline.destination)
    onProgress?.(0.05)
    await synth.startOfflineRender({
      soundBankList: [{ bankOffset: 0, soundBankBuffer: this.bankBuffer.slice(0) }],
      midiSequence: parsed,
      loopCount: 0,
      /* 关键：默认 Sequencer 会「跳到第一个音符」，把轨道前导静音裁掉。
         这会让每个采样轨从各自首个音符开始混，凡首个音符不在 0 拍的工程都会整体错位
         （实测 p_rdew9m4a 主旋律从第 8 拍前移到 0 秒）。离线渲染必须保留绝对时间轴。 */
      sequencerOptions: { skipToFirstNoteOn: false },
    })
    await synth.isReady
    onProgress?.(0.12)

    let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
      try {
        const ratio = clamp(synth.currentTime / Math.max(0.1, durationSec), 0.12, 0.95)
        onProgress?.(ratio)
      } catch {
        /* ignore */
      }
    }, 250)
    try {
      const buffer = await offline.startRendering()
      onProgress?.(1)
      return buffer
    } finally {
      if (timer) clearInterval(timer)
      timer = null
      try {
        synth.destroy()
      } catch {
        /* ignore */
      }
    }
  }

  private destroySynth(): void {
    try {
      this.synth?.destroy()
    } catch {
      /* ignore */
    }
    this.synth = null
    this.synthPromise = null
    // 合成器已销毁：主输出/逐通道路由都随之失效，交由引擎重新建立
    this.mainOutputConnected = false
  }

  destroy(): void {
    this.destroySynth()
    // 注意：不要清空 statusHandlers —— store 桥接是一次性安装的，
    // dispose 后重新 init 时仍然需要收到加载状态。
    this.channels.clear()
    this.channelOwners.clear()
    this.bankBuffer = null
    this.context = null
    this.destination = null
  }
}
