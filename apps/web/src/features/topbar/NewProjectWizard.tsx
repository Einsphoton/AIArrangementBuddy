/**
 * 新建工程向导（ProjectMenu 的「新建工程…」面板）。
 *
 * 两步：选风格（9 个卡片）→ 选用途场景（可跳过）→ POST /api/studio/new。
 * 预设优先来自 GET /api/studio/presets；接口不可用（404 / 后端未启动）时
 * 直接使用 @aiab/core 的 STYLES / SCENES 本地预设，生成同样回退到
 * composeSceneProject（内部就是 composeProject），保证不白屏、可离线使用。
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, LoaderCircle, Music4, RefreshCw, Sparkles, Wand2 } from 'lucide-react'
import { SCENES, SCALES, STYLES, composeSceneProject, type ScaleId, type StyleId } from '@aiab/core'
import {
  ApiError,
  createStudioProject,
  getStudioPresets,
  type StudioScenePreset,
  type StudioStylePreset,
} from '../../lib/api'
import { cn } from '../../lib/format'
import { useStore } from '../../store/store'

/** 本地兜底预设：与 GET /api/studio/presets 的结构保持一致 */
const LOCAL_STYLES: StudioStylePreset[] = Object.values(STYLES).map((style) => ({
  id: style.id,
  name: style.name,
  nameEn: style.nameEn,
  description: style.description,
  bpm: style.defaultTempo,
  tempoRange: style.tempoRange,
  scale: style.defaultScale,
  accent: style.accent,
  recommendedInstruments: style.recommendedInstruments,
}))

const LOCAL_SCENES: StudioScenePreset[] = SCENES.map((scene) => ({
  id: scene.id,
  name: scene.name,
  nameEn: scene.nameEn,
  description: scene.description,
  styleId: scene.styleId,
  bpm: scene.tempo,
  key: scene.key,
  scale: scene.scale,
  bars: scene.bars,
  energy: scene.energy,
  sectionNames: scene.sectionNames,
}))

function scaleName(scale?: string): string {
  if (!scale) return ''
  return SCALES[scale as ScaleId]?.name ?? scale
}

function errorMessageOf(error: unknown): string {
  if (error instanceof ApiError) return error.detail || error.message
  return error instanceof Error ? error.message : '未知错误'
}

/** 404 / 405 / 网络错误 → 视为创作接口未就绪，走本地生成回退 */
function isStudioUnavailable(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 404 || error.status === 405 || error.status === 501
  return true
}

/**
 * 新建工程向导的弹窗宿主（portal 到 body）。
 *
 * - 统一 Esc 关闭 / 点遮罩关闭 / 初始焦点，避免两个入口（顶栏「新建」与「文件 → 新建工程…」）
 *   各写一套 modal 行为；
 * - 只负责外观与关闭语义，工程创建逻辑仍在 NewProjectWizard 内。
 */
export function NewProjectWizardDialog({
  open,
  onClose,
  onBack,
}: {
  open: boolean
  onClose: () => void
  /** 返回：向导内部第 2 步会先回第 1 步，第 1 步再调用它（默认 = 关闭） */
  onBack?: () => void
}) {
  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-black/65 p-4 pt-[7vh] backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="新建工程"
      data-new-project-dialog
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="mb-8 w-full max-w-[780px] overflow-hidden rounded-xl border border-line-strong bg-surface-2 shadow-[0_32px_80px_-24px_rgba(0,0,0,0.9)]"
        onClick={(event) => event.stopPropagation()}
      >
        <NewProjectWizard onDone={onClose} onBack={onBack ?? onClose} />
      </div>
    </div>,
    document.body,
  )
}

export function NewProjectWizard({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const setProject = useStore((s) => s.setProject)
  const bumpProjectListVersion = useStore((s) => s.bumpProjectListVersion)
  const pushToast = useStore((s) => s.pushToast)
  const saveStatus = useStore((s) => s.saveStatus)

  const [step, setStep] = useState<'style' | 'scene'>('style')
  const [styles, setStyles] = useState<StudioStylePreset[]>(LOCAL_STYLES)
  const [scenes, setScenes] = useState<StudioScenePreset[]>(LOCAL_SCENES)
  const [presetStatus, setPresetStatus] = useState<'loading' | 'ready' | 'offline'>('loading')
  const [selectedStyle, setSelectedStyle] = useState<StyleId | null>(null)
  const [selectedScene, setSelectedScene] = useState<string | null>(null)
  const [showOtherScenes, setShowOtherScenes] = useState(false)
  const [creating, setCreating] = useState(false)

  /* 读取服务端预设；失败则保持本地预设（不打扰用户，只在底部提示） */
  useEffect(() => {
    let cancelled = false
    getStudioPresets()
      .then((presets) => {
        if (cancelled) return
        const remoteStyles = (presets?.styles ?? []).filter(
          (style): style is StudioStylePreset => Boolean(style && typeof style.id === 'string' && style.id in STYLES),
        )
        const remoteScenes = (presets?.scenes ?? []).filter(
          (scene): scene is StudioScenePreset => Boolean(scene && typeof scene.id === 'string'),
        )
        if (remoteStyles.length > 0) setStyles(remoteStyles)
        if (remoteScenes.length > 0) setScenes(remoteScenes)
        setPresetStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setPresetStatus('offline')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const styleOfSelected = useMemo(
    () => styles.find((style) => style.id === selectedStyle) ?? null,
    [styles, selectedStyle],
  )

  const compatibleScenes = useMemo(() => {
    if (!selectedStyle) return []
    return scenes.filter((scene) => !scene.styleId || scene.styleId === selectedStyle)
  }, [scenes, selectedStyle])

  const otherStyleScenes = useMemo(() => {
    if (!selectedStyle) return []
    return scenes.filter((scene) => scene.styleId && scene.styleId !== selectedStyle)
  }, [scenes, selectedStyle])

  const pickStyle = (styleId: StyleId) => {
    setSelectedStyle(styleId)
    setSelectedScene(null)
    setShowOtherScenes(false)
    setStep('scene')
  }

  const back = () => {
    if (step === 'scene') {
      setStep('style')
      return
    }
    onBack()
  }

  const generate = async (sceneId: string | null) => {
    if (!selectedStyle || creating) return
    const styleId = selectedStyle
    const styleMeta = STYLES[styleId]
    const scene = sceneId ? (scenes.find((item) => item.id === sceneId) ?? null) : null
    const name = `${scene ? `${scene.name} · ` : ''}${styleMeta.name} · 新工程`
    const seed = Math.floor(Math.random() * 100000)

    setCreating(true)
    try {
      const result = await createStudioProject({
        style: styleId,
        scene: sceneId ?? undefined,
        bars: scene?.bars,
        seed,
        name,
      })
      const project = result?.project
      if (!project || !Array.isArray(project.tracks) || project.tracks.length === 0) {
        throw new Error('后端返回的工程数据为空')
      }
      setProject(project, { resetHistory: true })
      bumpProjectListVersion()
      pushToast('success', result.summary || `已新建工程：${project.name}`)
      onDone()
    } catch (error) {
      if (!isStudioUnavailable(error)) {
        pushToast('error', `新建工程失败：${errorMessageOf(error)}`)
        setCreating(false)
        return
      }
      /* 404 / 后端未就绪：优雅回退到本地生成器，绝不白屏 */
      try {
        const local = composeSceneProject({
          style: styleId,
          sceneId: sceneId ?? undefined,
          bars: scene?.bars,
          seed,
          name,
        })
        setProject(local.project, { resetHistory: true })
        bumpProjectListVersion()
        pushToast('success', `创作接口未启用，已用本地生成器创建：${local.project.name}`)
        onDone()
      } catch (fallbackError) {
        pushToast('error', `本地生成失败：${errorMessageOf(fallbackError)}`)
        setCreating(false)
      }
    }
  }

  const styleAccent = styleOfSelected?.accent ?? '#f0b429'
  const styleBpm = styleOfSelected?.bpm ?? 0

  return (
    <div className="flex max-h-[82vh] w-full flex-col" data-new-project-wizard>
      {/* 头部：返回 + 步骤 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2.5 py-2">
        <button
          className="btn btn-ghost btn-icon h-7 w-7"
          onClick={back}
          title="返回"
          aria-label="返回"
          disabled={creating}
        >
          <ArrowLeft size={12} />
        </button>
        <span className="text-[12.5px] font-semibold text-ink">新建工程</span>
        <span className="mono ml-auto shrink-0 text-[10px] text-ink-4">第 {step === 'style' ? 1 : 2} / 2 步</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {step === 'style' ? (
          <>
            <p className="mb-2.5 text-[10.5px] leading-relaxed text-ink-3">
              选一个风格：决定和声、节奏与编制。下一步可以按用途挑场景，也可以跳过。
            </p>
            <div className="grid grid-cols-3 gap-1.5">
              {styles.map((style, index) => {
                const active = style.id === selectedStyle
                return (
                  <button
                    key={style.id}
                    type="button"
                    autoFocus={index === 0}
                    onClick={() => pickStyle(style.id as StyleId)}
                    title={`${style.name}：${style.description}`}
                    aria-pressed={active}
                    data-style-id={style.id}
                    className={cn(
                      'flex h-[68px] flex-col items-start justify-center gap-1 rounded-lg border px-2 text-left transition-colors outline-offset-1',
                      active
                        ? 'border-accent/60 bg-accent/12'
                        : 'border-line bg-surface-2/60 hover:border-line-strong hover:bg-surface-3',
                    )}
                  >
                    <span className="flex w-full min-w-0 items-center gap-1.5">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: style.accent }} />
                      <span className="truncate text-[12px] font-medium text-ink">{style.name}</span>
                    </span>
                    <span className="mono text-[10px] leading-none text-ink-3">{style.bpm} BPM</span>
                    <span className="w-full truncate text-[9.5px] leading-none text-ink-4">{scaleName(style.scale)}</span>
                  </button>
                )
              })}
            </div>
            <p className="mt-2.5 flex items-center gap-1 text-[10px] leading-relaxed text-ink-4">
              <Sparkles size={10} className="shrink-0 text-accent/70" />
              点风格立即进入下一步；用途场景可跳过。
            </p>
          </>
        ) : (
          <>
            {/* 已选风格摘要 */}
            <div className="mb-2.5 flex items-center gap-2 rounded-lg border border-line bg-surface-2/50 px-2.5 py-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: styleAccent }} />
              <span className="truncate text-[12px] font-medium text-ink">{styleOfSelected?.name ?? '未选择风格'}</span>
              <span className="mono ml-auto shrink-0 text-[10px] text-ink-4">
                {styleBpm} BPM · {scaleName(styleOfSelected?.scale)}
              </span>
            </div>

            <p className="mb-2 text-[10.5px] leading-relaxed text-ink-3">
              选用途场景：会带自己的调性、速度与段落结构。不需要用途就直接「跳过场景」。
            </p>

            {compatibleScenes.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {compatibleScenes.map((scene) => {
                  const active = selectedScene === scene.id
                  return (
                    <SceneChip
                      key={scene.id}
                      scene={scene}
                      active={active}
                      onClick={() => setSelectedScene(active ? null : scene.id)}
                    />
                  )
                })}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-line-strong px-2.5 py-2.5 text-[10.5px] leading-relaxed text-ink-4">
                当前风格没有绑定的场景预设，可直接生成；也可以从下面的跨风格场景里挑一个（会使用场景自带的风格）。
              </div>
            )}

            {otherStyleScenes.length > 0 && (
              <div className="mt-2">
                {compatibleScenes.length > 0 && (
                  <button
                    type="button"
                    className="mb-1.5 flex items-center gap-1 text-[10px] text-ink-4 transition-colors hover:text-ink-2"
                    onClick={() => setShowOtherScenes((value) => !value)}
                    aria-expanded={showOtherScenes}
                  >
                    <RefreshCw size={9} className={cn('shrink-0', showOtherScenes && 'rotate-180')} />
                    其他风格场景（{otherStyleScenes.length}）
                  </button>
                )}
                {(compatibleScenes.length === 0 || showOtherScenes) && (
                  <div className="flex flex-wrap gap-1.5">
                    {otherStyleScenes.map((scene) => {
                      const active = selectedScene === scene.id
                      const sceneStyleName = STYLES[scene.styleId as StyleId]?.name ?? scene.styleId
                      return (
                        <SceneChip
                          key={scene.id}
                          scene={scene}
                          active={active}
                          styleName={sceneStyleName}
                          hint={`会改用「${sceneStyleName}」风格`}
                          onClick={() => setSelectedScene(active ? null : scene.id)}
                        />
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            <p className="mt-2.5 flex items-center gap-1 text-[10px] leading-relaxed text-ink-4">
              <Music4 size={10} className="shrink-0 text-cyan/70" />
              场景自带 16 小节编曲骨架，生成后可直接编辑。
            </p>
          </>
        )}
      </div>

      {/* 底部操作：风格步只展示提示，场景步提供跳过 / 生成 */}
      <div className="shrink-0 border-t border-line p-2.5">
        {saveStatus === 'dirty' && (
          <p className="mb-1.5 rounded border border-accent/25 bg-accent/8 px-2 py-1.5 text-[10px] leading-relaxed text-accent-soft">
            当前工程还有未保存改动：新建会切换工程（撤销历史会清空）。建议先按 ⌘S 保存。
          </p>
        )}
        {presetStatus === 'offline' && (
          <p className="mb-1.5 text-[10px] leading-relaxed text-ink-4">
            后端创作接口未连接：将使用内置预设与本地生成器（能力一致）。
          </p>
        )}
        {step === 'style' ? (
          <p className="text-[10px] leading-relaxed text-ink-4">选择风格后进入第 2 步；随时可以返回上一步。</p>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn h-8 flex-1 px-2 text-[11.5px]"
              onClick={() => void generate(null)}
              disabled={creating}
              title="不指定用途，直接按所选风格生成"
            >
              跳过场景
            </button>
            <button
              type="button"
              className="btn btn-accent h-8 flex-1 px-2 text-[11.5px]"
              onClick={() => void generate(selectedScene)}
              disabled={creating}
              title={selectedScene ? '按所选风格 + 用途生成工程' : '未选场景：按风格直接生成'}
            >
              {creating ? <LoaderCircle size={11} className="animate-spin" /> : <Wand2 size={11} />}
              {selectedScene ? '用场景生成' : '生成工程'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function SceneChip({
  scene,
  active,
  hint,
  styleName,
  onClick,
}: {
  scene: StudioScenePreset
  active: boolean
  hint?: string
  /** 跨风格场景：显示它实际会采用的风格名 */
  styleName?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-scene-id={scene.id}
      title={`${scene.name}：${scene.description}${hint ? `（${hint}）` : ''}`}
      className={cn(
        'flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors',
        active
          ? 'border-accent/60 bg-accent/12 text-accent-soft'
          : 'border-line bg-surface-2/60 text-ink-2 hover:border-line-strong hover:bg-surface-3 hover:text-ink',
      )}
    >
      <span className="max-w-[140px] truncate">{scene.name}</span>
      {styleName && <span className="max-w-[76px] shrink-0 truncate text-[9.5px] text-ink-4">{styleName}</span>}
      <span className="mono shrink-0 text-[10px] text-ink-4">{scene.bpm}</span>
    </button>
  )
}