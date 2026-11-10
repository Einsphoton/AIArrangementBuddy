/**
 * AI 混音预览面板（混音器头部「AI 混音…」的只读结果弹层）。
 *
 * 数据来自 POST /api/mix/suggest；本组件只负责展示 + 应用：
 * - 每轨一行展示 音量(dB + Δ) / 声像 / 混响 / 延迟，reasons 作为次要说明；
 * - P3：服务端返回 `chains` 时增加「音频处理链（EQ/压缩）」一节，
 *   可勾选是否随混音一起写入 `track.mixChain`（默认勾选），也可一键清除；
 * - 「应用混音」用一次 store.mutate（默认 history=true）写入全部轨道 + 总线
 *   （以及勾选时的处理链），所以 ⌘Z 一步即可整批撤销；
 * - portal 到 body + z-[200]，避免被时间轴工具条等层叠上下文遮挡。
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Sparkles, Trash2, Waves, X } from 'lucide-react'
import { clearMixChains, describeChain, describeMasterChain, STYLES } from '@aiab/core'
import type { MixSuggestResult } from '../../lib/api'
import {
  DEFAULT_MULTIBAND,
  defaultDuckConfig,
  findDuckTargetTrack,
  neutralMixChain,
  resolveDuckSource,
} from '../../audio/advancedChain'
import { cn } from '../../lib/format'
import { useStore } from '../../store/store'
import { clamp, trackColor } from '../arrangement/timeline'
import { gainToDbText } from './controls'

/** 参数差异小于该值时视为「不变」（方案里的数值已四舍五入到 0.01） */
const EPSILON = 0.005

const ROLE_LABEL: Record<string, string> = {
  drums: '鼓组',
  bass: '贝斯',
  harmony: '和声',
  pad: '铺底',
  lead: '主旋律',
  counter: '对位',
  arp: '琶音',
  other: '其他',
}

/** 列宽：轨道/角色、音量、声像、混响、延迟 */
const GRID_COLS = 'grid-cols-[minmax(0,1fr)_92px_58px_56px_56px]'

function formatPan(pan: number): string {
  if (Math.abs(pan) < 0.03) return 'C'
  return `${pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(pan) * 100)}`
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/** 音量差（dB）：相对当前轨道，用于展示与判断「会被改动」 */
function volumeDeltaDb(nextVolume: number, currentVolume: number): number {
  if (nextVolume <= 0.0005) return 0
  if (currentVolume <= 0.0005) return Number.POSITIVE_INFINITY
  return 20 * Math.log10(nextVolume / currentVolume)
}

function formatVolumeDelta(deltaDb: number, changed: boolean): string {
  if (!changed) return 'Δ 不变'
  if (!Number.isFinite(deltaDb)) return 'Δ 从静音'
  return `Δ ${deltaDb > 0 ? '+' : ''}${deltaDb.toFixed(1)} dB`
}

export function AiMixDialog({ result, onClose }: { result: MixSuggestResult; onClose: () => void }) {
  const tracks = useStore((s) => s.project.tracks)
  const projectMasterChain = useStore((s) => s.project.masterChain)
  const plan = result.plan
  /** P3：服务端扩展后才有的逐轨处理链建议 */
  const chains = result.chains ?? []
  const hasChains = chains.length > 0
  /** 是否随混音一起应用处理链（默认勾选） */
  const [applyChains, setApplyChains] = useState(true)
  /** 工程里当前是否已有处理链（决定「清除处理链」是否可用） */
  const hasAnyChain = useMemo(() => tracks.some((track) => Boolean(track.mixChain)), [tracks])

  /** P3.2：总线 / 母带处理链建议（服务端扩展后才有；没有 masterPreview 时用 core describe 兜底） */
  const masterChain = result.masterChain ?? null
  const hasMasterChain = Boolean(masterChain)
  const masterPreview = result.masterPreview ?? (masterChain ? [describeMasterChain(masterChain)] : [])
  const masterNotes = result.masterNotes ?? []
  /** 是否随混音一起应用总线/母带链（默认勾选） */
  const [applyMaster, setApplyMaster] = useState(true)
  const hasAnyMasterChain = Boolean(projectMasterChain)

  /* P6-A：进阶处理（默认不勾选，避免自动改变既有混音结果） */
  const [applyMultiband, setApplyMultiband] = useState(false)
  const [applyDuck, setApplyDuck] = useState(false)
  const project = useStore((s) => s.project)
  /** 自动挑 duck 目标（贝斯）与触发源（鼓组） */
  const duckPlan = useMemo(() => {
    const target = findDuckTargetTrack(project)
    if (!target) return null
    const source = resolveDuckSource(project, { enabled: true, amountDb: -6, attackSec: 0.008, releaseSec: 0.18 }, target.id)
    return {
      targetTrackId: target.id,
      targetName: target.name,
      sourceTrackId: source?.id,
      sourceName: source?.name ?? '（未找到鼓组）',
    }
  }, [project])
  const hasAnyMultiband = Boolean(projectMasterChain?.multiband?.enabled)
  const hasAnyDuck = useMemo(() => tracks.some((track) => Boolean(track.mixChain?.duck?.enabled)), [tracks])
  /** 三段压缩挂在 masterChain 上：需要本次同时应用母带链 */
  const canApplyMultiband = applyMaster && hasMasterChain

  /* Esc 关闭（沿用现有模态框的窗口级监听） */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const trackById = useMemo(() => new Map(tracks.map((track) => [track.id, track])), [tracks])

  const rows = useMemo(
    () =>
      plan.tracks.map((item) => {
        const current = trackById.get(item.trackId)
        const volumeDelta = item.volume - (current?.volume ?? 0)
        const panDelta = item.pan - (current?.pan ?? 0)
        const reverbDelta = item.reverbSend - (current?.reverbSend ?? 0)
        const delayDelta = item.delaySend - (current?.delaySend ?? 0)
        const changed =
          current !== undefined &&
          [volumeDelta, panDelta, reverbDelta, delayDelta].some((delta) => Math.abs(delta) > EPSILON)
        return {
          item,
          current,
          changed,
          deltaDb: volumeDeltaDb(item.volume, current?.volume ?? 0),
        }
      }),
    [plan.tracks, trackById],
  )

  const changedCount = rows.filter((row) => row.changed).length
  const styleLabel = STYLES[plan.style]?.name ?? String(plan.style)

  /* 应用：一次 mutate = 一条撤销记录（默认 history），⌘Z 整批回退。
     勾选「同时应用音频处理链 / 总线链」时，把 chains / masterChain 一并写入（同一撤销点）。 */
  const apply = () => {
    const byId = new Map(plan.tracks.map((item) => [item.trackId, item]))
    const chainById = new Map(chains.map((item) => [item.trackId, item.chain]))
    const writeChains = applyChains && hasChains
    const masterToApply = applyMaster && hasMasterChain ? masterChain : null
    const multibandToApply = applyMultiband ? DEFAULT_MULTIBAND : null
    const duckToApply =
      applyDuck && duckPlan ? defaultDuckConfig(duckPlan.sourceTrackId) : null
    let appliedChains = 0
    useStore.getState().mutate((draft) => {
      for (const track of draft.tracks) {
        const item = byId.get(track.id)
        if (!item) continue
        track.volume = clamp(item.volume, 0, 1.5)
        track.pan = clamp(item.pan, -1, 1)
        track.reverbSend = clamp(item.reverbSend, 0, 1)
        track.delaySend = clamp(item.delaySend, 0, 1)
        if (writeChains) {
          const chain = chainById.get(track.id)
          if (chain) {
            track.mixChain = chain
            appliedChains += 1
          }
        }
      }
      if (multibandToApply) {
        const base = masterToApply ?? draft.masterChain
        if (base) draft.masterChain = { ...base, multiband: multibandToApply }
      } else if (masterToApply) {
        draft.masterChain = masterToApply
      }
      /* P6-A：侧链 ducking 挂在目标轨（默认贝斯）的混音链上；没有链时建一条中性的 */
      if (duckToApply && duckPlan) {
        const target = draft.tracks.find((track) => track.id === duckPlan.targetTrackId)
        if (target) {
          const baseChain = target.mixChain ?? neutralMixChain()
          target.mixChain = { ...baseChain, duck: duckToApply }
        }
      }
      draft.masterVolume = clamp(plan.masterVolume, 0, 1.5)
    })
    const extras: string[] = []
    if (appliedChains > 0) extras.push(`${appliedChains} 轨音频处理链`)
    if (masterToApply) extras.push('总线/母带链')
    if (multibandToApply) extras.push('三段总线压缩')
    if (duckToApply && duckPlan) extras.push(`侧链 ducking（${duckPlan.sourceName} → ${duckPlan.targetName}）`)
    useStore
      .getState()
      .pushToast(
        'success',
        `已应用 AI 混音：${plan.tracks.length} 轨 + 总线${
          extras.length > 0 ? ` + ${extras.join(' + ')}` : ''
        }，⌘Z 一步撤销`,
      )
    onClose()
  }

  /** 清除所有轨道的音频处理链（一次 mutate，可撤销） */
  const clearChains = () => {
    useStore.getState().mutate((draft) => {
      // core 提供纯函数语义：clearMixChains 会深拷贝并去掉所有 mixChain，只取回 tracks
      draft.tracks = clearMixChains(draft).tracks
    })
    useStore.getState().pushToast('success', '已清除所有轨道的音频处理链（⌘Z 可撤销）')
  }

  /** 清除总线 / 母带处理链（一次 mutate，可撤销；语义同 core clearMasterChain） */
  const clearMasterChain = () => {
    useStore.getState().mutate((draft) => {
      delete draft.masterChain
    })
    useStore.getState().pushToast('success', '已清除总线 / 母带处理链（⌘Z 可撤销）')
  }

  return createPortal(
    <div
      data-ai-mix-panel=""
      role="dialog"
      aria-modal="true"
      aria-label="AI 混音方案预览"
      className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-black/65 p-4 pt-[6vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[86vh] w-full max-w-[760px] flex-col overflow-hidden rounded-xl border border-line-strong bg-surface-2 shadow-[0_32px_80px_-24px_rgba(0,0,0,0.9)]"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 顶部：summary + 风格/能量/总线 */}
        <header className="shrink-0 border-b border-line px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
                <Sparkles size={14} className="shrink-0 text-accent" />
                AI 混音方案
                <span className="rounded-full border border-line bg-bg-soft px-1.5 text-[9.5px] font-normal text-ink-4">
                  只读预览
                </span>
              </h2>
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-2" data-ai-mix-summary="">
                {result.summary}
              </p>
            </div>
            <button
              className="btn btn-ghost btn-icon -mr-1 -mt-1 h-7 w-7 shrink-0"
              onClick={onClose}
              aria-label="关闭 AI 混音面板"
              title="关闭（Esc）"
            >
              <X size={14} />
            </button>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <span className="chip cursor-default" title="混音风格">
              风格 {styleLabel}
            </span>
            <span className="chip cursor-default" title="混音能量（来自段落平均能量）">
              能量 {formatPercent(plan.energy)}
            </span>
            <span className="chip cursor-default" title={`总线 masterVolume（${formatPercent(plan.masterVolume)}）`}>
              总线 {gainToDbText(plan.masterVolume)} dB
            </span>
            <span className={cn('chip cursor-default', changedCount > 0 && 'border-accent/50 text-accent')}>
              {changedCount > 0 ? `将改动 ${changedCount}/${plan.tracks.length} 轨` : '与当前混音一致'}
            </span>
            {hasChains && (
              <span className="chip cursor-default" title="本次方案包含逐轨 EQ / 压缩处理链">
                处理链 {chains.length} 轨
              </span>
            )}
            {hasMasterChain && (
              <span className="chip cursor-default" title="本次方案包含总线 / 母带处理链（EQ + 母线压缩 + 限幅）">
                母带链
              </span>
            )}
          </div>

          {/* P3：处理链开关（默认勾选）。旧服务端不返回 chains 时禁用并说明 */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label
              className={cn(
                'flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[10.5px] transition-colors',
                applyChains && hasChains
                  ? 'border-cyan/45 bg-cyan/10 text-ink-2'
                  : 'border-line bg-bg-soft text-ink-3',
                !hasChains && 'cursor-not-allowed opacity-60',
              )}
              title={
                hasChains
                  ? '应用混音时同时写入每轨 EQ / 压缩处理链（与混音参数同一条撤销记录）'
                  : '本次方案没有处理链（服务端未返回 chains 或没有可处理轨道）'
              }
            >
              <input
                type="checkbox"
                data-mix-chain-toggle
                checked={applyChains && hasChains}
                onChange={(event) => setApplyChains(event.target.checked)}
                disabled={!hasChains}
                aria-label="同时应用音频处理链（EQ/压缩）"
                className="h-3 w-3 shrink-0 accent-[#3ddbd9]"
              />
              <Waves size={11} className={cn('shrink-0', applyChains && hasChains ? 'text-cyan' : 'text-ink-4')} />
              同时应用音频处理链（EQ/压缩）
            </label>
            {!hasChains && <span className="text-[9.5px] text-ink-4">本次方案未包含处理链</span>}
            {/* P3.2：总线 / 母带链开关（默认勾选） */}
            <label
              className={cn(
                'flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[10.5px] transition-colors',
                applyMaster && hasMasterChain
                  ? 'border-accent/45 bg-accent/10 text-ink-2'
                  : 'border-line bg-bg-soft text-ink-3',
                !hasMasterChain && 'cursor-not-allowed opacity-60',
              )}
              title={
                hasMasterChain
                  ? '应用混音时同时写入总线 EQ / 母线压缩 / 限幅上限（与混音参数同一条撤销记录）'
                  : '本次方案没有总线/母带链（服务端未返回 masterChain）'
              }
            >
              <input
                type="checkbox"
                data-master-chain-toggle
                checked={applyMaster && hasMasterChain}
                onChange={(event) => setApplyMaster(event.target.checked)}
                disabled={!hasMasterChain}
                aria-label="同时应用总线/母带处理链（EQ/压缩/限幅）"
                className="h-3 w-3 shrink-0 accent-[#f0b429]"
              />
              <Sparkles size={11} className={cn('shrink-0', applyMaster && hasMasterChain ? 'text-accent' : 'text-ink-4')} />
              同时应用总线/母带链
            </label>
            {!hasMasterChain && <span className="text-[9.5px] text-ink-4">本次方案未包含母带链</span>}
          </div>

          {/* P6-A：进阶处理（多段总线压缩 / 侧链 ducking），默认关闭 */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label
              className={cn(
                'flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[10.5px] transition-colors',
                applyMultiband ? 'border-accent/50 bg-accent/10 text-ink-2' : 'border-line bg-bg-soft text-ink-3',
              )}
              title="三段总线压缩：低(<200Hz)/中(200-3k)/高(>3k) 各自压缩后再合并（与整体母线压缩串联）"
            >
              <input
                type="checkbox"
                data-multiband-toggle
                checked={applyMultiband}
                onChange={(event) => setApplyMultiband(event.target.checked)}
                disabled={!canApplyMultiband}
                aria-label="启用三段总线压缩（multiband）"
                className="h-3 w-3 shrink-0 accent-[#d4a95c]"
              />
              <Waves size={11} className={cn('shrink-0', applyMultiband ? 'text-accent' : 'text-ink-4')} />
              三段总线压缩
              {hasAnyMultiband && <span className="text-[9px] text-success">已启用</span>}
            </label>
            <label
              className={cn(
                'flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[10.5px] transition-colors',
                applyDuck ? 'border-cyan/50 bg-cyan/10 text-ink-2' : 'border-line bg-bg-soft text-ink-3',
                !duckPlan && 'cursor-not-allowed opacity-60',
              )}
              title={
                duckPlan
                  ? `侧链 ducking：用「${duckPlan.sourceName}」的包络压低「${duckPlan.targetName}」（-6dB，attack 8ms / release 180ms）`
                  : '工程里没有可用的 duck 目标/触发源（需要贝斯类轨 + 鼓组轨）'
              }
            >
              <input
                type="checkbox"
                data-duck-toggle
                checked={applyDuck && Boolean(duckPlan)}
                onChange={(event) => setApplyDuck(event.target.checked)}
                disabled={!duckPlan}
                aria-label="启用侧链 ducking（鼓组 → 贝斯）"
                className="h-3 w-3 shrink-0 accent-[#3ddbd9]"
              />
              <Waves size={11} className={cn('shrink-0', applyDuck && duckPlan ? 'text-cyan' : 'text-ink-4')} />
              侧链 ducking{duckPlan ? `（${duckPlan.sourceName} → ${duckPlan.targetName}）` : ''}
              {hasAnyDuck && <span className="text-[9px] text-success">已启用</span>}
            </label>
          </div>
        </header>

        {/* 逐轨预览 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div
            className={cn(
              'sticky top-0 z-10 grid items-center gap-2 border-b border-line bg-surface-2/95 px-4 py-1.5 text-[9.5px] font-semibold tracking-wide text-ink-4 backdrop-blur',
              GRID_COLS,
            )}
          >
            <span>轨道 · 角色</span>
            <span className="text-right">音量</span>
            <span className="text-right">声像</span>
            <span className="text-right">混响</span>
            <span className="text-right">延迟</span>
          </div>

          {rows.map(({ item, current, changed, deltaDb }) => (
            <div
              key={item.trackId}
              data-ai-mix-row=""
              data-ai-mix-changed={changed ? '' : undefined}
              data-track-id={item.trackId}
              className={cn(
                'grid items-center gap-2 border-b border-line/60 border-l-2 px-4 py-2 transition-colors',
                GRID_COLS,
                changed ? 'border-l-accent/70 bg-accent/[0.06]' : 'border-l-transparent',
              )}
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: current ? trackColor(current.color) : 'rgb(100 116 139)' }}
                  />
                  <span className="truncate text-[11.5px] font-medium text-ink" title={item.name}>
                    {item.name}
                  </span>
                  <span className="shrink-0 rounded border border-line bg-bg-soft px-1 text-[9px] text-ink-3">
                    {ROLE_LABEL[item.role] ?? item.role}
                  </span>
                  {changed && (
                    <span className="shrink-0 text-[9px] font-semibold text-accent" title="该轨会被改动">
                      ●
                    </span>
                  )}
                </div>
                {item.reasons.length > 0 && (
                  <p className="mt-0.5 truncate text-[9.5px] text-ink-4" title={item.reasons.join('；')}>
                    {item.reasons.join(' · ')}
                  </p>
                )}
              </div>

              <div className="text-right">
                <div className="mono text-[10.5px] tabular-nums text-ink-2" title={`目标音量 ${formatPercent(item.volume)}`}>
                  {gainToDbText(item.volume)} dB
                </div>
                <div
                  className={cn(
                    'mono text-[9px] tabular-nums',
                    changed ? 'text-accent-soft' : 'text-ink-4',
                  )}
                  title={`当前 ${current ? `${gainToDbText(current.volume)} dB` : '轨道已不存在'}`}
                >
                  {formatVolumeDelta(deltaDb, changed)}
                </div>
              </div>

              <div
                className="mono text-right text-[10.5px] tabular-nums text-ink-2"
                title={`目标声像 ${item.pan.toFixed(2)}`}
              >
                {formatPan(item.pan)}
              </div>
              <div
                className="mono text-right text-[10.5px] tabular-nums text-ink-2"
                title={`目标混响发送 ${formatPercent(item.reverbSend)}`}
              >
                {formatPercent(item.reverbSend)}
              </div>
              <div
                className="mono text-right text-[10.5px] tabular-nums text-ink-2"
                title={`目标延迟发送 ${formatPercent(item.delaySend)}`}
              >
                {formatPercent(item.delaySend)}
              </div>
            </div>
          ))}

          {/* P3：音频处理链（EQ / 压缩）逐轨摘要；服务端返回 chains 时才有 */}
          {hasChains && (
            <section className="border-t border-line/70 bg-bg-soft/40" data-ai-mix-chain-section="">
              <div className="flex items-center gap-2 px-4 py-2">
                <Waves size={12} className="shrink-0 text-cyan/80" />
                <span className="text-[11px] font-medium text-ink-2">音频处理链（EQ / 压缩）</span>
                <span className="min-w-0 flex-1 truncate text-[9.5px] text-ink-4">
                  {chains.length} 轨 · {applyChains ? '应用混音时一起写入（同一条撤销记录）' : '本次不写入'}
                </span>
              </div>
              {chains.map((item) => {
                const current = trackById.get(item.trackId)
                const summary = describeChain(item.chain)
                return (
                  <div
                    key={item.trackId}
                    data-mix-chain-row=""
                    data-track-id={item.trackId}
                    className="border-t border-line/40 px-4 py-1.5"
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: current ? trackColor(current.color) : 'rgb(100 116 139)' }}
                      />
                      <span className="shrink-0 text-[10.5px] font-medium text-ink" title={item.name}>
                        {item.name}
                      </span>
                      <span className="shrink-0 rounded border border-line bg-bg-soft px-1 text-[9px] text-ink-3">
                        {ROLE_LABEL[item.role] ?? item.role}
                      </span>
                      {!item.chain.enabled && <span className="shrink-0 text-[9px] text-ink-4">（未启用）</span>}
                    </div>
                    <p className="mono mt-0.5 truncate text-[9.5px] text-ink-3" title={summary}>
                      {summary}
                    </p>
                    {item.reasons.length > 0 && (
                      <p className="truncate text-[9px] text-ink-4" title={item.reasons.join('；')}>
                        {item.reasons.join(' · ')}
                      </p>
                    )}
                  </div>
                )
              })}
              {result.chainNotes && result.chainNotes.length > 0 && (
                <p className="border-t border-line/40 px-4 py-1.5 text-[9.5px] leading-relaxed text-ink-4">
                  {result.chainNotes.join(' · ')}
                </p>
              )}
            </section>
          )}

          {/* P3.2：总线 / 母带处理链（EQ + 母线压缩 + 限幅上限）摘要 */}
          {hasMasterChain && (
            <section className="border-t border-line/70 bg-bg-soft/40" data-master-chain-section="">
              <div className="flex items-center gap-2 px-4 py-2">
                <Sparkles size={12} className="shrink-0 text-accent/80" />
                <span className="text-[11px] font-medium text-ink-2">总线 / 母带处理</span>
                <span className="min-w-0 flex-1 truncate text-[9.5px] text-ink-4">
                  {applyMaster ? '应用混音时一起写入（同一条撤销记录）' : '本次不写入'}
                </span>
              </div>
              {masterPreview.map((line, index) => (
                <div
                  key={`${index}-${line}`}
                  data-master-chain-row=""
                  className="border-t border-line/40 px-4 py-1.5"
                >
                  <p className="mono truncate text-[9.5px] text-ink-3" title={line}>
                    {line}
                  </p>
                </div>
              ))}
              {masterNotes.length > 0 && (
                <p className="border-t border-line/40 px-4 py-1.5 text-[9.5px] leading-relaxed text-ink-4">
                  {masterNotes.join(' · ')}
                </p>
              )}
            </section>
          )}

          {/* 服务端差异文本 + 方案说明（次要信息，默认折叠） */}
          {(result.preview.length > 0 || plan.notes.length > 0) && (
            <details className="px-4 py-2.5 text-[10px] text-ink-4">
              <summary className="cursor-pointer select-none text-[10.5px] text-ink-3 hover:text-ink-2">
                差异明细 / 方案说明
              </summary>
              {result.preview.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {result.preview.map((line, index) => (
                    <li key={`${index}-${line}`} className="mono text-[10px] leading-relaxed">
                      {line}
                    </li>
                  ))}
                </ul>
              )}
              {plan.notes.length > 0 && (
                <p className="mt-2 leading-relaxed">{plan.notes.join(' · ')}</p>
              )}
            </details>
          )}

          {rows.length === 0 && (
            <div className="px-4 py-8 text-center text-[11.5px] text-ink-3">方案里没有可应用的轨道</div>
          )}
        </div>

        {/* 底部操作 */}
        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-5 py-3">
          <span className="text-[10px] leading-tight text-ink-4">
            应用后记为一条撤销记录，⌘Z 可整批回退
          </span>
          <div className="flex-1" />
          <button
            type="button"
            data-mix-chain-clear=""
            className="btn btn-ghost h-8 px-2.5 text-[11.5px]"
            onClick={clearChains}
            disabled={!hasAnyChain}
            aria-label="清除所有轨道的音频处理链"
            title={
              hasAnyChain
                ? '清除工程里所有轨道的 EQ / 压缩处理链（一次撤销记录）'
                : '工程里当前没有处理链可清除'
            }
          >
            <Trash2 size={12} className="mr-1" />
            清除处理链
          </button>
          <button
            type="button"
            data-master-chain-clear=""
            className="btn btn-ghost h-8 px-2.5 text-[11.5px]"
            onClick={clearMasterChain}
            disabled={!hasAnyMasterChain}
            aria-label="清除总线/母带处理链"
            title={
              hasAnyMasterChain
                ? '清除工程的总线 EQ / 母线压缩 / 限幅上限（一次撤销记录）'
                : '工程里当前没有母带处理链可清除'
            }
          >
            <Trash2 size={12} className="mr-1" />
            清除母带链
          </button>
          <button className="btn btn-ghost h-8 px-3 text-[12px]" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            data-ai-mix-apply=""
            className="btn btn-accent h-8 px-3 text-[12px]"
            onClick={apply}
            aria-label="应用 AI 混音方案"
            title={
              (applyChains && hasChains) || (applyMaster && hasMasterChain)
                ? '应用全部轨道与总线 + 处理链（可一步撤销）'
                : '应用全部轨道与总线（可一步撤销）'
            }
          >
            应用混音
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
