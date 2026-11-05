import {
  Check,
  CircleHelp,
  Cpu,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  Terminal,
  TriangleAlert,
} from 'lucide-react'
import type { AgentBackendId } from '@aiab/core'
import { Badge, NumberField, Switch } from '../../components/ui'
import { cn } from '../../lib/format'
import { Code, Details, FieldGroup, Section, StatusLine } from './shared'
import type { SettingsSectionProps } from './shared'

export interface AgentProbeInfo {
  backend: string
  available: boolean
  version?: string
  path?: string
}

interface AgentSectionProps extends SettingsSectionProps {
  agents: AgentProbeInfo[] | null
  probing: boolean
  probeError: string | null
  probedAt: number | null
  onProbe: () => void
}

const BACKENDS: {
  id: AgentBackendId
  name: string
  description: string
  icon: typeof Cpu
  needsPath: boolean
  tone: string
}[] = [
  {
    id: 'builtin',
    name: '内置 Agent',
    description: '服务端自带的工具调用循环，配好 AI 服务商即可使用，最省心。',
    icon: Cpu,
    needsPath: false,
    tone: 'text-cyan',
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    description: '复用本机 codex 登录与沙箱，适合已有 OpenAI 订阅的用户。',
    icon: Terminal,
    needsPath: true,
    tone: 'text-violet',
  },
  {
    id: 'dsh',
    name: 'DeepSeek Harness',
    description: '通过 MCP 把编曲工具暴露给本机 DSH 会话，适合重度 AI 用户。',
    icon: Sparkles,
    needsPath: true,
    tone: 'text-accent',
  },
]

export function AgentSection({
  draft,
  update,
  agents,
  probing,
  probeError,
  probedAt,
  onProbe,
}: AgentSectionProps) {
  const backend = draft.agent.backend
  const selected = BACKENDS.find((item) => item.id === backend) ?? BACKENDS[0]
  const probe = (id: string) => agents?.find((item) => item.backend === id) ?? null

  return (
    <div className="space-y-3">
      <Section
        title="Agent 运行时"
        description="决定 AI 对话由谁来执行：内置循环最稳，外部 CLI 能力更强但需要本机安装。"
        icon={<Terminal size={13} />}
        badge={<Badge tone={backend === 'builtin' ? 'success' : 'violet'}>{selected.name}</Badge>}
      >
        <div className="space-y-1.5">
          {BACKENDS.map((item) => {
            const Icon = item.icon
            const active = item.id === backend
            const info = probe(item.id)
            return (
              <button
                key={item.id}
                className={cn(
                  'flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors',
                  active
                    ? 'border-accent/45 bg-accent/10'
                    : 'border-line bg-bg-soft/50 hover:border-line-strong hover:bg-surface-3/60',
                )}
                onClick={() =>
                  update((next) => {
                    next.agent.backend = item.id
                  })
                }
                title={`切换到 ${item.name}`}
              >
                <span
                  className={cn(
                    'mt-[1px] flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border',
                    active ? 'border-accent/45 bg-accent/15' : 'border-line-strong bg-surface-2',
                    item.tone,
                  )}
                >
                  <Icon size={13} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-[12px] font-medium text-ink">{item.name}</span>
                    {active && <Badge tone="accent">当前</Badge>}
                    {info ? (
                      info.available ? (
                        <Badge tone="success">可用{info.version ? ` · ${info.version}` : ''}</Badge>
                      ) : (
                        <Badge tone="danger">不可用</Badge>
                      )
                    ) : probing ? (
                      <Badge tone="neutral">探测中…</Badge>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-[10.5px] leading-relaxed text-ink-3">{item.description}</span>
                  {info?.path && (
                    <span className="mono mt-0.5 block truncate text-[9.5px] text-ink-4">{info.path}</span>
                  )}
                </span>
              </button>
            )
          })}
        </div>

        <div className="flex items-center gap-2 rounded-lg border border-line bg-bg-soft/50 px-2.5 py-2">
          <button
            className="btn h-7 px-2 text-[11px]"
            onClick={onProbe}
            disabled={probing}
            title="重新探测 Agent 后端可用性"
          >
            {probing ? <LoaderCircle size={11} className="mr-1 animate-spin" /> : <RefreshCw size={11} className="mr-1" />}
            {probing ? '探测中…' : '重新探测'}
          </button>
          {probeError ? (
            <StatusLine tone="danger" icon={<TriangleAlert size={10} />}>
              {probeError}
            </StatusLine>
          ) : probedAt ? (
            <StatusLine tone="neutral" icon={<Check size={10} />}>
              探测完成 · {new Date(probedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
            </StatusLine>
          ) : (
            <span className="text-[10px] text-ink-4">探测结果来自 /api/agents，与后端启动环境有关</span>
          )}
        </div>
      </Section>

      <Section
        title="运行参数"
        description="外部 Agent 需要可执行文件路径与工作目录；留空时后端会尝试从 PATH 查找。"
        icon={<Cpu size={13} />}
      >
        <FieldGroup
          label="可执行文件路径"
          hint={
            backend === 'builtin'
              ? '内置 Agent 不需要可执行文件。'
              : '例如 /usr/local/bin/codex 或 dsh 的绝对路径；留空则走 PATH。'
          }
        >
          <input
            className="field mono text-[11.5px] disabled:opacity-40"
            value={draft.agent.executablePath}
            disabled={backend === 'builtin'}
            placeholder={backend === 'builtin' ? '不需要' : '留空自动查找'}
            onChange={(event) =>
              update((next) => {
                next.agent.executablePath = event.target.value
              })
            }
          />
        </FieldGroup>

        <FieldGroup label="工作目录" hint="外部 Agent 的读写沙箱目录；留空使用 data/agent-workspace。">
          <input
            className="field mono text-[11.5px] disabled:opacity-40"
            value={draft.agent.workdir}
            disabled={backend === 'builtin'}
            placeholder="留空使用默认目录"
            onChange={(event) =>
              update((next) => {
                next.agent.workdir = event.target.value
              })
            }
          />
        </FieldGroup>

        <div className="grid gap-2.5 sm:grid-cols-2">
          <FieldGroup label="模型覆盖" hint="仅 Codex / DSH 生效；留空用后端默认。">
            <input
              className="field mono text-[11.5px] disabled:opacity-40"
              value={draft.agent.model}
              disabled={backend === 'builtin'}
              placeholder={backend === 'builtin' ? '使用 AI 服务商模型' : '例如 gpt-5-codex'}
              onChange={(event) =>
                update((next) => {
                  next.agent.model = event.target.value
                })
              }
            />
          </FieldGroup>

          <FieldGroup label="单轮超时" hint="Agent 单次任务最长执行时间">
            <div className="flex items-center gap-2">
              <NumberField
                value={Math.round(draft.agent.timeoutMs / 1000)}
                min={5}
                max={600}
                step={5}
                width={84}
                suffix="秒"
                onChange={(value) =>
                  update((next) => {
                    next.agent.timeoutMs = Math.round(value * 1000)
                  })
                }
              />
            </div>
          </FieldGroup>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-soft/50 px-2.5 py-2">
            <div>
              <div className="text-[12px] text-ink-2">允许联网搜索</div>
              <div className="mt-0.5 text-[10px] text-ink-4">关闭后 AI 无法调用 web_search / fetch_url</div>
            </div>
            <Switch
              checked={draft.agent.allowWebSearch}
              label="允许联网搜索"
              onChange={(value) =>
                update((next) => {
                  next.agent.allowWebSearch = value
                })
              }
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-soft/50 px-2.5 py-2">
            <div>
              <div className="text-[12px] text-ink-2">允许修改工程</div>
              <div className="mt-0.5 text-[10px] text-ink-4">关闭后 AI 只能分析与回答问题，不会改动音符</div>
            </div>
            <Switch
              checked={draft.agent.allowProjectEdits}
              label="允许修改工程"
              onChange={(value) =>
                update((next) => {
                  next.agent.allowProjectEdits = value
                })
              }
            />
          </div>
        </div>
      </Section>

      <Section title="如何安装外部 Agent" description="可选：不安装也可以只用内置 Agent。" icon={<CircleHelp size={13} />}>
        <div className="space-y-1.5">
          <Details summary="Codex CLI 安装与登录" tone="accent">
            <p>1. 安装（需要 Node.js 20+）：</p>
            <Code>npm i -g @openai/codex</Code>
            <p>2. 登录 OpenAI 账号（浏览器授权）：</p>
            <Code>codex login</Code>
            <p>3. 在上方把「Agent 运行时」切到 Codex CLI，可执行文件路径留空即可走 PATH。</p>
            <p>4. 工作目录建议留空，让后端使用 data/agent-workspace 隔离读写。</p>
          </Details>
          <Details summary="DeepSeek Harness（DSH）配置">
            <p>1. 安装 DeepSeek Harness，确认命令行可执行文件名为 dsh。</p>
            <p>2. 配置模型凭据（二选一）：</p>
            <Code>DEEPSEEK_API_KEY=sk-…</Code>
            <p>3. 后端会把编曲工具通过 MCP 暴露给 DSH；DSH 运行时优先级高于内置循环。</p>
            <p>4. 若使用自定义安装路径，请在上方填写 dsh 可执行文件的绝对路径。</p>
          </Details>
          <Details summary="这些配置存在哪里？">
            <p>所有设置保存在本机 data/settings.json，由服务端读写；API Key 在接口返回时会被脱敏。</p>
            <p>关闭后端时，设置页仍可编辑，但无法保存——请先启动 `pnpm dev`。</p>
          </Details>
        </div>
      </Section>
    </div>
  )
}
