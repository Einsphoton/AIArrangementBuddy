/**
 * 首次使用引导。
 *
 * 参考 Studio One / FL Studio 的首次进入体验：不塞长教程，只告诉用户
 * 「这是什么、先做什么、快捷键在哪」，并且随时可以跳过 / 从帮助里再打开。
 *
 * 自动弹出的条件：
 * - 本机从未点过「开始编曲」（localStorage 标记）；
 * - 不是自动化环境（navigator.webdriver），避免影响 e2e 截图与验收；
 * - URL 没有 `?intro=0`；`?intro=1` 可强制打开。
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Boxes, Keyboard, Music4, Sparkles, Wand2, X } from 'lucide-react'
import { useStore } from '../../store/store'
import { getHealth } from '../../lib/api'
import { cn } from '../../lib/format'
import { Kbd } from '../../components/ui/menu'

const SEEN_KEY = 'aiab:onboarded:v1'

interface StartCard {
  title: string
  description: string
  prompt: string
  icon: React.ReactNode
  tone: 'accent' | 'violet' | 'cyan'
}

const START_CARDS: StartCard[] = [
  {
    title: '一句话从零编曲',
    description: '描述风格、情绪、乐器，AI 直接搭出完整编曲',
    prompt: '从零创作一首 8 小节的 lo-fi 编曲：钢琴、鼓组、贝斯，88 BPM，温暖放松。',
    icon: <Wand2 size={15} />,
    tone: 'accent',
  },
  {
    title: '把我写的旋律编成伴奏',
    description: '识别调性与和弦，补齐弦乐、贝斯、鼓组',
    prompt: '把第 1 轨的旋律编成完整伴奏：识别调性、配和弦、补贝斯与鼓组。',
    icon: <Music4 size={15} />,
    tone: 'violet',
  },
  {
    title: '先手动写两小节',
    description: '双击时间轴创建片段，进入钢琴卷帘开始写',
    prompt: '',
    icon: <Boxes size={15} />,
    tone: 'cyan',
  },
]

export function WelcomeOverlay({
  open,
  onClose,
  onOpenHelp,
}: {
  open: boolean
  onClose: () => void
  onOpenHelp: () => void
}) {
  const [backendLabel, setBackendLabel] = useState<string>('内置 Agent')
  const setChatOpen = useStore((s) => s.setChatOpen)
  const setPendingPrompt = useStore((s) => s.setPendingPrompt)
  const setView = useStore((s) => s.setView)
  const pushToast = useStore((s) => s.pushToast)

  useEffect(() => {
    if (!open) return
    getHealth()
      .then((info) => {
        if (info.ok) setBackendLabel('本地服务已连接')
        else setBackendLabel('本地服务未连接')
      })
      .catch(() => setBackendLabel('本地服务未连接'))
  }, [open])

  const finish = () => {
    try {
      localStorage.setItem(SEEN_KEY, '1')
    } catch {
      /* ignore */
    }
    onClose()
  }

  const startWithPrompt = (card: StartCard) => {
    if (!card.prompt) {
      finish()
      setView('arrangement')
      pushToast('info', '在时间轴空白处双击即可创建片段，双击片段进入钢琴卷帘')
      return
    }
    finish()
    setChatOpen(true)
    setPendingPrompt(card.prompt)
  }

  const toneClass = useMemo(
    () => ({
      accent: 'border-accent/35 bg-accent/10 text-accent',
      violet: 'border-violet/35 bg-violet/10 text-violet',
      cyan: 'border-cyan/35 bg-cyan/10 text-cyan',
    }),
    [],
  )

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-black/62 px-4 backdrop-blur-[3px]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) finish()
      }}
      role="dialog"
      aria-modal="true"
      aria-label="欢迎使用 AI 编曲伴侣"
    >
      <div className="w-full max-w-[760px] overflow-hidden rounded-[18px] border border-line-strong bg-surface shadow-[0_50px_140px_-30px_rgba(0,0,0,1)] animate-fade-up">
        <div className="relative border-b border-line bg-[radial-gradient(120%_180%_at_18%_0%,rgba(240,180,41,0.16),transparent_58%)] px-6 py-6">
          <button
            className="absolute right-4 top-4 rounded-md p-1 text-ink-4 transition-colors hover:bg-surface-3 hover:text-ink-2"
            onClick={finish}
            aria-label="跳过引导"
          >
            <X size={15} />
          </button>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-[12px] border border-accent/35 bg-gradient-to-b from-accent/25 to-accent/5">
              <Music4 size={18} className="text-accent" />
            </div>
            <div>
              <div className="text-[17px] font-semibold tracking-tight">欢迎来到 AI 编曲伴侣</div>
              <div className="mt-1 text-[11.5px] text-ink-3">
                浏览器里的多轨 DAW + 会真正动手改工程 AI Agent · {backendLabel}
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-2.5 px-6 py-5 sm:grid-cols-3">
          {START_CARDS.map((card) => (
            <button
              key={card.title}
              onClick={() => startWithPrompt(card)}
              className="group flex flex-col items-start gap-2 rounded-[12px] border border-line bg-surface-2/50 p-3.5 text-left transition-all hover:-translate-y-0.5 hover:border-line-strong hover:bg-surface-2"
            >
              <span className={cn('flex h-8 w-8 items-center justify-center rounded-[9px] border', toneClass[card.tone])}>
                {card.icon}
              </span>
              <span className="text-[12.5px] font-medium text-ink">{card.title}</span>
              <span className="text-[10.5px] leading-relaxed text-ink-3">{card.description}</span>
              <span className="mt-1 flex items-center gap-1 text-[10px] text-accent opacity-0 transition-opacity group-hover:opacity-100">
                开始
                <ArrowRight size={10} />
              </span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line px-6 py-3.5 text-[10.5px] text-ink-4">
          <span className="flex items-center gap-1.5">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
            搜索全部命令
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>空格</Kbd>
            播放 / 暂停
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>1</Kbd>
            <Kbd>2</Kbd>
            <Kbd>3</Kbd>
            切换视图
          </span>
          <button
            className="ml-auto flex items-center gap-1 text-ink-2 transition-colors hover:text-accent"
            onClick={() => {
              finish()
              onOpenHelp()
            }}
          >
            <Keyboard size={11} />
            全部快捷键
          </button>
        </div>
      </div>
    </div>
  )
}

/** 是否应该自动展示首次引导 */
export function shouldAutoWelcome(): boolean {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  if (params.get('intro') === '1') return true
  if (params.get('intro') === '0') return false
  if (typeof navigator !== 'undefined' && navigator.webdriver) return false
  try {
    return !localStorage.getItem(SEEN_KEY)
  } catch {
    return false
  }
}
