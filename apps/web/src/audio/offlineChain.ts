/**
 * P6-A：离线导出用的处理链重建（native AudioNode，不依赖 Tone 全局上下文）。
 *
 * 导出时用与实时一致的处理链重建：
 * - 每轨：EQ(low shelf/peaking/high shelf) → Compressor → makeup（抵消浏览器自动补偿）→ duckGain（侧链）；
 * - 母线：bus EQ → 三段压缩（multiband，可 bypass）→ 整体 Compressor → makeup → masterVolume → limiter；
 * - 侧链 ducking 的包络由源轨 MIDI 音符包络离线计算（实时引擎用源轨输出分析器，两者近似一致）。
 *
 * 注意：浏览器 DynamicsCompressorNode 带非规范的固定自动补偿增益，
 * 这里用与实时引擎相同的标定算法（OfflineAudioContext 测 tone → 输出/输入差 − reduction）抵消。
 */
import { type Project, type Track } from '@aiab/core'
import { getMultiband, resolveDuckSource } from './advancedChain'

/* ------------------------------------------------------------------ */
/* 压缩器自动补偿标定（与实时引擎同算法）                                */
/* ------------------------------------------------------------------ */

const cache = new Map<string, number>()
const pending = new Map<string, Promise<number>>()

const calibrationKey = (thresholdDb: number, ratio: number, kneeDb: number): string =>
  `${thresholdDb.toFixed(2)}|${ratio.toFixed(2)}|${kneeDb.toFixed(2)}`

/** 同步读已标定的自动补偿增益（dB；未标定返回 0） */
export function autoMakeupFor(thresholdDb: number, ratio: number, kneeDb = 0): number {
  return cache.get(calibrationKey(thresholdDb, ratio, kneeDb)) ?? 0
}

/** 标定浏览器 DynamicsCompressor 的自动补偿增益（dB，>=0）；失败返回 0 */
export function calibrateCompressorAutoMakeup(
  thresholdDb: number,
  ratio: number,
  kneeDb = 0,
): Promise<number> {
  const key = calibrationKey(thresholdDb, ratio, kneeDb)
  const cached = cache.get(key)
  if (cached !== undefined) return Promise.resolve(cached)
  const running = pending.get(key)
  if (running) return running
  const run = (async () => {
    let makeup = 0
    try {
      const OfflineCtor = (globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext })
        .OfflineAudioContext
      if (!OfflineCtor) return 0
      const sampleRate = 44100
      const length = Math.floor(sampleRate * 0.25)
      const render = async (withCompressor: boolean) => {
        const offline = new OfflineCtor(1, length, sampleRate)
        const osc = offline.createOscillator()
        osc.type = 'sawtooth'
        osc.frequency.value = 220
        const gain = offline.createGain()
        gain.gain.value = 0.08
        osc.connect(gain)
        let tail: AudioNode = gain
        let comp: DynamicsCompressorNode | null = null
        if (withCompressor) {
          comp = offline.createDynamicsCompressor()
          comp.threshold.value = thresholdDb
          comp.ratio.value = ratio
          comp.knee.value = kneeDb
          comp.attack.value = 0.003
          comp.release.value = 0.1
          gain.connect(comp)
          tail = comp
        }
        tail.connect(offline.destination)
        osc.start(0)
        const buffer = await offline.startRendering()
        const data = buffer.getChannelData(0)
        const start = Math.floor(data.length * 0.4)
        let sum = 0
        for (let i = start; i < data.length; i += 1) sum += data[i] * data[i]
        return {
          rms: Math.sqrt(sum / Math.max(1, data.length - start)),
          reduction: comp ? comp.reduction : 0,
        }
      }
      const dry = await render(false)
      const wet = await render(true)
      if (!(dry.rms > 1e-8) || !(wet.rms > 1e-8)) return 0
      const reduction = Number.isFinite(wet.reduction) ? wet.reduction : 0
      const measured = 20 * Math.log10(wet.rms / dry.rms) - reduction
      makeup = Number.isFinite(measured) ? Math.min(48, Math.max(0, measured)) : 0
      return makeup
    } catch {
      return 0
    } finally {
      cache.set(key, makeup)
      pending.delete(key)
    }
  })()
  pending.set(key, run)
  return run
}

/** 收集工程里所有 compressor 参数组合并预标定（导出前 await 一次） */
export async function preloadOfflineCalibration(project: Project): Promise<void> {
  const keys: { thresholdDb: number; ratio: number; kneeDb: number }[] = []
  const push = (thresholdDb: number, ratio: number, kneeDb: number) => {
    if (!keys.some((item) => item.thresholdDb === thresholdDb && item.ratio === ratio && item.kneeDb === kneeDb)) {
      keys.push({ thresholdDb, ratio, kneeDb })
    }
  }
  for (const track of project.tracks) {
    const chain = track.mixChain
    if (!chain || chain.enabled === false) continue
    push(chain.compressor.thresholdDb, chain.compressor.ratio, chain.compressor.kneeDb)
  }
  const master = project.masterChain
  if (master && master.enabled !== false) {
    push(master.compressor.thresholdDb, master.compressor.ratio, master.compressor.kneeDb)
    const mb = getMultiband(project)
    if (mb && mb.enabled !== false) {
      for (const band of [mb.low, mb.mid, mb.high]) push(band.thresholdDb, band.ratio, 0)
    }
  }
  await Promise.all(keys.map((item) => calibrateCompressorAutoMakeup(item.thresholdDb, item.ratio, item.kneeDb)))
}

/* ------------------------------------------------------------------ */
/* 侧链 ducking 的离线自动化（由源轨 MIDI 音符合成包络）                 */
/* ------------------------------------------------------------------ */

export interface DuckAutomation {
  times: Float32Array
  gains: Float32Array
}

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value))
const dbToGain = (db: number) => Math.pow(10, db / 20)

/** 根据源轨 MIDI 音符包络生成目标轨 duck gain 自动化（采样步长 20ms） */
export function buildDuckAutomation(
  project: Project,
  targetTrack: Track,
  durationSec: number,
  secPerBeat: number,
): DuckAutomation | null {
  const duck = targetTrack.mixChain?.duck
  if (!duck || duck.enabled === false || !targetTrack.mixChain || targetTrack.mixChain.enabled === false) return null
  const source = resolveDuckSource(project, duck, targetTrack.id)
  if (!source || source.clips.length === 0) return null
  const step = 0.02
  const count = Math.max(2, Math.ceil(durationSec / step) + 1)
  const envelope = new Float32Array(count)
  const decay = 0.14
  for (const clip of source.clips) {
    if (clip.muted) continue
    for (const note of clip.notes) {
      const onset = (clip.startBeat + note.start) * secPerBeat
      const velocity = clamp(note.velocity, 1, 127) / 127
      const from = Math.max(0, Math.floor(onset / step))
      const to = Math.min(count - 1, Math.ceil((onset + decay * 4) / step))
      for (let index = from; index <= to; index += 1) {
        const t = index * step
        if (t < onset - 1e-6) continue
        const value = velocity * Math.exp(-(t - onset) / decay)
        if (value > envelope[index]) envelope[index] = value
      }
    }
  }
  const amountDb = clamp(duck.amountDb, -24, 0)
  const times = new Float32Array(count)
  const gains = new Float32Array(count)
  let current = 1
  for (let index = 0; index < count; index += 1) {
    const target = envelope[index] > 0.18 ? dbToGain(amountDb) : 1
    const tau = target < current ? Math.max(0.001, duck.attackSec) : Math.max(0.01, duck.releaseSec)
    current += (target - current) * (1 - Math.exp(-step / tau))
    times[index] = index * step
    gains[index] = current
  }
  return { times, gains }
}

function scheduleDuckGain(param: AudioParam, automation: DuckAutomation): void {
  try {
    param.cancelScheduledValues(0)
    param.setValueAtTime(automation.gains[0] ?? 1, 0)
    for (let i = 1; i < automation.times.length; i += 1) {
      param.linearRampToValueAtTime(automation.gains[i], automation.times[i])
    }
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 每轨处理链（native）                                                 */
/* ------------------------------------------------------------------ */

const NEUTRAL_EQ = {
  lowShelf: { hz: 90, gainDb: 0 },
  mid: { hz: 1000, gainDb: 0, q: 0.9 },
  highShelf: { hz: 8000, gainDb: 0 },
} as const

const NEUTRAL_COMP = { thresholdDb: 0, ratio: 1, attackSec: 0.01, releaseSec: 0.2 } as const

/**
 * 把一条轨的 mixChain（EQ/压缩/makeup/duck）接在 input 之后，返回链尾节点。
 * 链禁用时直接返回 input（不做任何处理）。
 */
export function connectTrackChainNative(
  ctx: BaseAudioContext,
  input: AudioNode,
  track: Track,
  automation: DuckAutomation | null,
): AudioNode {
  const chain = track.mixChain
  if (!chain || chain.enabled === false) return input
  const eq = chain.eq
  const comp = chain.compressor
  const low = ctx.createBiquadFilter()
  low.type = 'lowshelf'
  low.frequency.value = eq.lowShelf.hz
  low.gain.value = eq.lowShelf.gainDb
  const mid = ctx.createBiquadFilter()
  mid.type = 'peaking'
  mid.frequency.value = eq.mid.hz
  mid.gain.value = eq.mid.gainDb
  mid.Q.value = eq.mid.q ?? 0.9
  const high = ctx.createBiquadFilter()
  high.type = 'highshelf'
  high.frequency.value = eq.highShelf.hz
  high.gain.value = eq.highShelf.gainDb
  const compressor = ctx.createDynamicsCompressor()
  compressor.threshold.value = comp.thresholdDb
  compressor.ratio.value = comp.ratio
  compressor.attack.value = comp.attackSec
  compressor.release.value = comp.releaseSec
  compressor.knee.value = comp.kneeDb
  const makeup = ctx.createGain()
  makeup.gain.value = dbToGain(chain.makeupDb - autoMakeupFor(comp.thresholdDb, comp.ratio, comp.kneeDb))
  const duckGain = ctx.createGain()
  duckGain.gain.value = 1
  if (automation) scheduleDuckGain(duckGain.gain, automation)
  input.connect(low)
  low.connect(mid)
  mid.connect(high)
  high.connect(compressor)
  compressor.connect(makeup)
  makeup.connect(duckGain)
  return duckGain
}

/* ------------------------------------------------------------------ */
/* 母线处理链（native）                                                 */
/* ------------------------------------------------------------------ */

const MASTER_NEUTRAL_EQ = {
  lowShelf: { hz: 100, gainDb: 0 },
  mid: { hz: 420, gainDb: 0, q: 0.9 },
  highShelf: { hz: 10000, gainDb: 0 },
} as const

const MASTER_NEUTRAL_COMP = { thresholdDb: 0, ratio: 1, attackSec: 0.02, releaseSec: 0.22, kneeDb: 0 } as const

/** 把母线/母带链接在 input 之后，返回 limiter 输出（已含 masterVolume） */
export function connectMasterChainNative(ctx: BaseAudioContext, input: AudioNode, project: Project): AudioNode {
  const chain = project.masterChain
  const enabled = Boolean(chain && chain.enabled !== false)
  const eq = enabled && chain ? chain.eq : MASTER_NEUTRAL_EQ
  const comp = enabled && chain ? chain.compressor : MASTER_NEUTRAL_COMP
  const busLow = ctx.createBiquadFilter()
  busLow.type = 'lowshelf'
  busLow.frequency.value = eq.lowShelf.hz
  busLow.gain.value = eq.lowShelf.gainDb
  const busMid = ctx.createBiquadFilter()
  busMid.type = 'peaking'
  busMid.frequency.value = eq.mid.hz
  busMid.gain.value = eq.mid.gainDb
  busMid.Q.value = eq.mid.q ?? 0.9
  const busHigh = ctx.createBiquadFilter()
  busHigh.type = 'highshelf'
  busHigh.frequency.value = eq.highShelf.hz
  busHigh.gain.value = eq.highShelf.gainDb
  input.connect(busLow)
  busLow.connect(busMid)
  busMid.connect(busHigh)

  /* 三段压缩：enabled 时 build 3 路，否则直通 */
  let stageInput: AudioNode = busHigh
  const multiband = enabled ? getMultiband(project) : null
  const mb = multiband && multiband.enabled !== false ? multiband : null
  if (mb) {
    const [crossLow, crossHigh] = mb.crossoverHz
    const sum = ctx.createGain()
    const buildBand = (
      band: { thresholdDb: number; ratio: number; attackSec: number; releaseSec: number },
      filters: { type: BiquadFilterType; frequency: number }[],
    ) => {
      let tail: AudioNode = stageInput
      for (const filter of filters) {
        const node = ctx.createBiquadFilter()
        node.type = filter.type
        node.frequency.value = filter.frequency
        tail.connect(node)
        tail = node
      }
      const bandComp = ctx.createDynamicsCompressor()
      bandComp.threshold.value = band.thresholdDb
      bandComp.ratio.value = band.ratio
      bandComp.attack.value = band.attackSec
      bandComp.release.value = band.releaseSec
      bandComp.knee.value = 0
      const bandMakeup = ctx.createGain()
      bandMakeup.gain.value = dbToGain(-autoMakeupFor(band.thresholdDb, band.ratio, 0))
      tail.connect(bandComp)
      bandComp.connect(bandMakeup)
      bandMakeup.connect(sum)
    }
    buildBand(mb.low, [{ type: 'lowpass', frequency: crossLow }])
    buildBand(mb.mid, [
      { type: 'highpass', frequency: crossLow },
      { type: 'lowpass', frequency: crossHigh },
    ])
    buildBand(mb.high, [{ type: 'highpass', frequency: crossHigh }])
    stageInput = sum
  }

  const busComp = ctx.createDynamicsCompressor()
  busComp.threshold.value = comp.thresholdDb
  busComp.ratio.value = comp.ratio
  busComp.attack.value = comp.attackSec
  busComp.release.value = comp.releaseSec
  busComp.knee.value = comp.kneeDb
  const busMakeup = ctx.createGain()
  const chainMakeup = enabled && chain ? chain.makeupDb : 0
  busMakeup.gain.value = dbToGain(chainMakeup - autoMakeupFor(comp.thresholdDb, comp.ratio, comp.kneeDb))
  const volume = ctx.createGain()
  volume.gain.value = clamp(project.masterVolume, 0, 1.5)
  const limiter = ctx.createDynamicsCompressor()
  const ceiling = enabled && chain ? clamp(chain.limiterCeilingDb, -6, 0) : -1
  limiter.threshold.value = ceiling
  limiter.ratio.value = 20
  limiter.attack.value = 0.003
  limiter.release.value = 0.25
  limiter.knee.value = 0
  stageInput.connect(busComp)
  busComp.connect(busMakeup)
  busMakeup.connect(volume)
  volume.connect(limiter)
  return limiter
}

/* ------------------------------------------------------------------ */
/* 离线渲染整段                                                         */
/* ------------------------------------------------------------------ */

/** 把每条采样轨的原始 buffer 经过各自处理链 + 音量/声像后混合成一条立体声 buffer */
export async function renderTracksWithChainsOffline(
  project: Project,
  buffers: Map<string, AudioBuffer>,
  duration: number,
  sampleRate: number,
): Promise<AudioBuffer | null> {
  if (buffers.size === 0) return null
  const secPerBeat = 60 / Math.max(20, project.tempo)
  const length = Math.max(1, Math.ceil(duration * sampleRate))
  const OfflineCtor = window.OfflineAudioContext
  const offline = new OfflineCtor(2, length, sampleRate)
  const out = offline.createGain()
  out.gain.value = 1
  out.connect(offline.destination)
  for (const track of project.tracks) {
    const buffer = buffers.get(track.id)
    if (!buffer) continue
    const source = offline.createBufferSource()
    source.buffer = buffer
    const automation = buildDuckAutomation(project, track, duration, secPerBeat)
    const chainOut = connectTrackChainNative(offline, source, track, automation)
    const volume = offline.createGain()
    volume.gain.value = clamp(track.volume, 0, 1.5)
    const panner = offline.createStereoPanner()
    panner.pan.value = clamp(track.pan, -1, 1)
    chainOut.connect(volume)
    volume.connect(panner)
    panner.connect(out)
    source.start(0)
  }
  return offline.startRendering()
}

/** 把混好的 PCM 再过一遍母线/母带链（bus EQ + multiband + comp + makeup + masterVolume + limiter） */
export async function applyMasterChainOffline(
  project: Project,
  mixBuffer: AudioBuffer,
  sampleRate: number,
): Promise<AudioBuffer> {
  const OfflineCtor = window.OfflineAudioContext
  const offline = new OfflineCtor(2, mixBuffer.length, sampleRate)
  const source = offline.createBufferSource()
  source.buffer = mixBuffer
  const out = connectMasterChainNative(offline, source, project)
  out.connect(offline.destination)
  source.start(0)
  return offline.startRendering()
}