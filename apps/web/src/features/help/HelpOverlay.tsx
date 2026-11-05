/**
 * 快捷键与帮助。
 *
 * 与旧版相比的关键变化：快捷键表不再手写，而是从 lib/commands.ts 的命令注册表生成，
 * 因此「帮助里写了的键」和「真正能按出来的键」不会漂移；同时支持搜索，
 * 用户可以直接搜「量化」「混音」找到对应命令与键位。
 */
import { useMemo, useState } from 'react'
import { BookOpen, Command, Keyboard, MousePointerClick, Music4, Search, Sparkles } from 'lucide-react'
import { Modal } from '../../components/ui'
import { Kbd } from '../../components/ui/menu'
import { COMMANDS, COMMAND_GROUP_ORDER, primaryShortcut } from '../../lib/commands'
import { formatCombo, isMacPlatform } from '../../lib/shortcuts'
import { cn } from '../../lib/format'
import { useStore } from '../../store/store'

type Tab = 'start' | 'keys' | 'about'

const MOUSE_TIPS: { label: string; detail: string }[] = [
  { label: '双击时间轴空白', detail: '新建 2 小节片段' },
  { label: '双击片段', detail: '进入钢琴卷帘编辑音符' },
  { label: '拖动片段左右边缘', detail: '调整起点 / 长度' },
  { label: '框选空白处', detail: '多选片段；Shift 点击加选' },
  { label: '右键片段 / 轨道 / 音符', detail: '打开上下文菜单' },
  { label: '⌘ / Ctrl + 滚轮', detail: '横向缩放时间轴' },
  { label: 'Shift + 滚轮', detail: '纵向缩放轨道 / 音符行高' },
  { label: '拖动标尺', detail: '移动播放头；在循环条拖动创建循环区' },
]

const MIDI_TIPS: { label: string; detail: string }[] = [
  { label: 'USB MIDI 键盘', detail: '插上后自动识别，可直接用当前音色演奏' },
  { label: 'R 键 / 走带录音', detail: '开启 MIDI 录入，在钢琴卷帘中把弹奏写进片段' },
  { label: '轨道头 R', detail: '预备某条轨道接收录入（同时只预备一条）' },
  { label: 'CC1 / CC11', detail: '调制轮与表情踏板会映射到音色表现' },
]

const START_STEPS = [
  {
    title: '在时间轴写下第一个片段',
    detail: '在编曲视图的时间轴空白处双击，会创建一个 2 小节片段；双击片段进入钢琴卷帘。',
    hint: '也可以按 ⌘K 搜「添加轨道」',
  },
  {
    title: '用智能片段快速铺底',
    detail: '切到「智能片段」，选节奏 / 低音 / 和弦 / 旋律，参数实时重算，随时换一个变奏。',
    hint: '快捷键 3',
  },
  {
    title: '让 AI 接手编曲',
    detail: '右侧 AI 助手用一句话描述想要的效果，它会读取工程、调用工具、把改动直接写回时间轴。',
    hint: '快捷键 ⌘J',
  },
  {
    title: '导出或继续精修',
    detail: '导出 MIDI / WAV / MP3 / FLAC / OGG；所有 AI 改动都可以一键撤销，放心试。',
    hint: '⌘⇧E 导出',
  },
]

export function HelpOverlay() {
  const open = useStore((s) => s.helpOpen)
  const setOpen = useStore((s) => s.setHelpOpen)
  const setChatOpen = useStore((s) => s.setChatOpen)
  const [tab, setTab] = useState<Tab>('start')
  const [query, setQuery] = useState('')

  const shortcutGroups = useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    return COMMAND_GROUP_ORDER.map((group) => {
      const rows = COMMANDS.filter((command) => command.group === group && primaryShortcut(command)).filter((command) => {
        if (!trimmed) return true
        const keys = Array.isArray(command.keys) ? command.keys : command.keys ? [command.keys] : []
        const haystack = [command.title, command.subtitle ?? '', command.keywords ?? '', ...keys].join(' ').toLowerCase()
        return haystack.includes(trimmed)
      })
      return { group, rows }
    }).filter((section) => section.rows.length > 0)
  }, [query])

  const close = () => setOpen(false)

  return (
    <Modal
      open={open}
      onClose={close}
      title="快捷键与操作指南"
      subtitle={`${isMacPlatform() ? 'macOS 键位（⌘ = Command）' : 'Windows / Linux 键位（Ctrl）'} · 所有键位与命令面板同源 · 按 ? 随时打开`}
      width="lg"
    >
      {/* 标签页 */}
      <div className="mb-4 flex items-center gap-1 border-b border-line pb-2">
        {(
          [
            { id: 'start' as const, label: '快速开始', icon: <BookOpen size={12} /> },
            { id: 'keys' as const, label: '快捷键', icon: <Keyboard size={12} /> },
            { id: 'about' as const, label: '关于', icon: <Sparkles size={12} /> },
          ]
        ).map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] font-medium transition-colors',
              tab === item.id ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:bg-surface-2 hover:text-ink-2',
            )}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
        {tab === 'keys' && (
          <div className="ml-auto flex h-7 w-[190px] items-center gap-1.5 rounded-lg border border-line bg-bg-soft px-2">
            <Search size={11} className="shrink-0 text-ink-4" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索命令…"
              className="min-w-0 flex-1 bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-4"
              aria-label="搜索快捷键"
            />
          </div>
        )}
      </div>

      {tab === 'start' && (
        <div className="space-y-4">
          <div className="grid gap-2.5 sm:grid-cols-2">
            {START_STEPS.map((step, index) => (
              <div key={step.title} className="rounded-xl border border-line bg-surface-2/40 p-3.5">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border border-accent/40 bg-accent/12 text-[10px] font-semibold text-accent">
                    {index + 1}
                  </span>
                  <span className="text-[12px] font-medium text-ink">{step.title}</span>
                </div>
                <p className="text-[11px] leading-relaxed text-ink-3">{step.detail}</p>
                <div className="mt-2 flex items-center gap-1 text-[9.5px] text-ink-4">
                  <Command size={9} />
                  {step.hint}
                </div>
              </div>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <section className="rounded-xl border border-line bg-surface-2/40 p-3.5">
              <h3 className="mb-2 flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-2">
                <MousePointerClick size={12} />
                鼠标操作
              </h3>
              <ul className="space-y-1.5">
                {MOUSE_TIPS.map((tip) => (
                  <li key={tip.label} className="flex items-baseline justify-between gap-3 text-[11px]">
                    <span className="shrink-0 text-ink-2">{tip.label}</span>
                    <span className="text-right text-ink-4">{tip.detail}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section className="rounded-xl border border-line bg-surface-2/40 p-3.5">
              <h3 className="mb-2 flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-2">
                <Music4 size={12} />
                MIDI 键盘
              </h3>
              <ul className="space-y-1.5">
                {MIDI_TIPS.map((tip) => (
                  <li key={tip.label} className="flex items-baseline justify-between gap-3 text-[11px]">
                    <span className="shrink-0 text-ink-2">{tip.label}</span>
                    <span className="text-right text-ink-4">{tip.detail}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <button
            className="btn btn-accent h-8 w-full text-[12px]"
            onClick={() => {
              close()
              setChatOpen(true)
            }}
          >
            <Sparkles size={12} />
            打开 AI 助手，开始第一首编曲
          </button>
        </div>
      )}

      {tab === 'keys' && (
        <div className="space-y-5">
          {shortcutGroups.length === 0 && (
            <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-[11.5px] text-ink-4">
              没有匹配的快捷键，试试「量化」「混音」「导出」
            </div>
          )}
          {shortcutGroups.map((section) => (
            <section key={section.group}>
              <h3 className="label mb-2">{section.group}</h3>
              <ul className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
                {section.rows.map((command) => {
                  const shortcut = primaryShortcut(command)
                  if (!shortcut) return null
                  return (
                    <li
                      key={command.id}
                      className="flex items-center justify-between gap-3 border-b border-line/40 py-1 text-[11.5px]"
                    >
                      <span className="min-w-0 truncate text-ink-2">{command.title}</span>
                      <span className="flex shrink-0 items-center gap-0.5">
                        {formatCombo(shortcut).map((key) => (
                          <Kbd key={key}>{key}</Kbd>
                        ))}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
          <div className="rounded-xl border border-line bg-surface-2/50 p-3 text-[10.5px] leading-relaxed text-ink-3">
            提示：⌘K 命令面板可以搜索并执行上面所有命令；视图内的编辑键（删除、全选、复制粘贴、方向键微调）根据当前所处视图自动生效。
          </div>
        </div>
      )}

      {tab === 'about' && (
        <div className="space-y-4 text-[12px] leading-relaxed text-ink-2">
          <div className="rounded-xl border border-line bg-surface-2/40 p-4">
            <h3 className="mb-1.5 text-[13px] font-semibold text-ink">这是什么？</h3>
            <p className="text-[11.5px] text-ink-3">
              「AI 编曲伴侣」是跑在你自己电脑上的多轨编曲工作站：钢琴卷帘、智能片段、MIDI 键盘、真实乐器与情绪，
              加一个能读取并直接修改你工程的 AI Agent。它不替代你的审美，只是把「把想法变成一个能听的完整编排」
              这段最耗时的过程变成可撤销、可微调、可协作的循环。
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-line bg-surface-2/40 p-4">
              <h3 className="mb-1.5 text-[12px] font-semibold text-ink">本地优先</h3>
              <p className="text-[11px] text-ink-3">
                工程与设置只保存在本机（DATA_DIR），API Key 明文存储在本机设置里，不上传任何服务器。
              </p>
            </div>
            <div className="rounded-xl border border-line bg-surface-2/40 p-4">
              <h3 className="mb-1.5 text-[12px] font-semibold text-ink">可回退</h3>
              <p className="text-[11px] text-ink-3">
                所有编辑进撤销栈；AI 的每次工程改动都保留快照，可一键撤销整轮 AI 修改。
              </p>
            </div>
          </div>
          <p className="text-[10.5px] text-ink-4">
            快捷键设计参考 Ableton Live / Logic Pro / Bitwig / Cubase / Studio One / REAPER 的通用惯例；
            完整架构见 docs/ARCHITECTURE.md，本次交互优化见 docs/UI_UX_UPGRADE.md。
          </p>
        </div>
      )}
    </Modal>
  )
}
