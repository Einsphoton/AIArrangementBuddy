import { Globe, ShieldCheck } from 'lucide-react'
import type { SearchProviderId } from '@aiab/core'
import { NumberField, Select, Slider } from '../../components/ui'
import { FieldGroup, Section } from './shared'
import type { SettingsSectionProps } from './shared'

const SEARCH_PROVIDERS: { id: SearchProviderId; name: string; hint: string; needsKey: boolean }[] = [
  { id: 'none', name: '关闭联网搜索', hint: 'AI 只能基于工程与内置乐理知识回答', needsKey: false },
  { id: 'duckduckgo', name: 'DuckDuckGo（免 Key）', hint: '默认选项，无需注册即可搜索', needsKey: false },
  { id: 'tavily', name: 'Tavily', hint: '面向 AI 的搜索 API，结果更干净', needsKey: true },
  { id: 'brave', name: 'Brave Search', hint: '独立索引，适合查资料与曲风参考', needsKey: true },
  { id: 'serper', name: 'Serper（Google）', hint: '基于 Google 结果，覆盖最广', needsKey: true },
]

export function SearchSection({ draft, update }: SettingsSectionProps) {
  const provider = draft.search.provider
  const meta = SEARCH_PROVIDERS.find((item) => item.id === provider) ?? SEARCH_PROVIDERS[1]
  const showKey = provider !== 'none' && provider !== 'duckduckgo'

  return (
    <div className="space-y-3">
      <Section
        title="联网搜索"
        description="AI 的 web_search / fetch_url 工具会使用这里的服务商去查曲风参考、乐器资料与和声案例。"
        icon={<Globe size={13} />}
      >
        <FieldGroup label="搜索服务商" hint={meta.hint}>
          <Select
            value={provider}
            ariaLabel="联网搜索服务商"
            options={SEARCH_PROVIDERS.map((item) => ({ value: item.id, label: item.name }))}
            onChange={(value) =>
              update((next) => {
                next.search.provider = value as SearchProviderId
              })
            }
          />
        </FieldGroup>

        <FieldGroup
          label="API Key"
          hint={
            provider === 'duckduckgo'
              ? 'DuckDuckGo 无需 Key，可直接使用。'
              : provider === 'none'
                ? '联网搜索已关闭，AI 不会主动联网。'
                : 'Key 只保存在本地 settings.json；保存后以脱敏形式回显。'
          }
        >
          <input
            className="field mono text-[11.5px] disabled:opacity-40"
            type="password"
            value={draft.search.apiKey}
            disabled={!showKey}
            placeholder={showKey ? '粘贴对应服务商的 API Key' : '无需填写'}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) =>
              update((next) => {
                next.search.apiKey = event.target.value
              })
            }
          />
        </FieldGroup>

        <FieldGroup label={`单次返回条数 · ${draft.search.maxResults} 条`} hint="条数越多上下文越长，建议 4–8 条">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <Slider
                value={draft.search.maxResults}
                min={1}
                max={20}
                step={1}
                ariaLabel="单次搜索返回条数"
                onChange={(value) =>
                  update((next) => {
                    next.search.maxResults = Math.round(value)
                  })
                }
              />
            </div>
            <NumberField
              value={draft.search.maxResults}
              min={1}
              max={20}
              step={1}
              width={54}
              onChange={(value) =>
                update((next) => {
                  next.search.maxResults = Math.round(value)
                })
              }
            />
          </div>
        </FieldGroup>

        <div className="flex items-start gap-1.5 rounded-lg border border-line bg-bg-soft/50 px-2.5 py-2">
          <ShieldCheck size={11} className="mt-[1px] shrink-0 text-success" />
          <p className="text-[10.5px] leading-relaxed text-ink-3">
            搜索请求由本地后端发出，不会把工程内容发送给搜索服务商；Critic 只拿到网页正文摘要。
            Codex / DeepSeek Harness 后端是否联网，由对应 Agent 的权限设置决定。
          </p>
        </div>
      </Section>
    </div>
  )
}
