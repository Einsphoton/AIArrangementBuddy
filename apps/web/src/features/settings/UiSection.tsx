import { Grid3x3, Languages, Map, Moon, Palette, Sparkles } from 'lucide-react'
import type { UiSettings } from '@aiab/core'
import { NumberField, Segmented, Select, Slider, Switch } from '../../components/ui'
import { FieldGroup, Section, StatusLine } from './shared'
import type { SettingsSectionProps } from './shared'

export function UiSection({ draft, update }: SettingsSectionProps) {
  const ui = draft.ui
  const patch = (partial: Partial<UiSettings>) =>
    update((next) => {
      Object.assign(next.ui, partial)
    })

  return (
    <div className="space-y-3">
      <Section
        title="外观"
        description="深色录音棚风格；主题与语言会随下次启动应用。"
        icon={<Palette size={13} />}
      >
        <FieldGroup label="主题" hint="两种主题都是深色系，midnight 对比度更低、更适合夜间长时间编曲。">
          <div className="flex w-fit">
            <Segmented
              value={ui.theme}
              options={[
                { value: 'dark', label: '录音棚 Dark', icon: <Moon size={11} /> },
                { value: 'midnight', label: '午夜 Midnight', icon: <Sparkles size={11} /> },
              ]}
              onChange={(value) => patch({ theme: value })}
            />
          </div>
        </FieldGroup>

        <FieldGroup label="界面语言" hint="当前版本的界面文案为简体中文；英文界面在后续版本提供。">
          <Select
            value={ui.language}
            ariaLabel="界面语言"
            options={[
              { value: 'zh', label: '简体中文' },
              { value: 'en', label: 'English（即将提供）' },
            ]}
            onChange={(value) => patch({ language: value as UiSettings['language'] })}
          />
        </FieldGroup>
      </Section>

      <Section title="编曲视图" description="控制网格、缩略图与音阶提示，只在编辑区生效。" icon={<Grid3x3 size={13} />}>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-soft/50 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <Grid3x3 size={11} className="text-ink-3" />
            <div>
              <div className="text-[12px] text-ink-2">显示网格</div>
              <div className="mt-0.5 text-[10px] text-ink-4">时间轴与钢琴卷帘的小节 / 拍线</div>
            </div>
          </div>
          <Switch checked={ui.showGrid} label="显示网格" onChange={(value) => patch({ showGrid: value })} />
        </div>

        <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-soft/50 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <Map size={11} className="text-ink-3" />
            <div>
              <div className="text-[12px] text-ink-2">显示缩略图</div>
              <div className="mt-0.5 text-[10px] text-ink-4">编曲视图底部的小地图概览</div>
            </div>
          </div>
          <Switch checked={ui.showMinimap} label="显示缩略图" onChange={(value) => patch({ showMinimap: value })} />
        </div>

        <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-soft/50 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <Sparkles size={11} className="text-ink-3" />
            <div>
              <div className="text-[12px] text-ink-2">音阶高亮</div>
              <div className="mt-0.5 text-[10px] text-ink-4">钢琴卷帘中标出当前调式的音级</div>
            </div>
          </div>
          <Switch
            checked={ui.scaleHighlight}
            label="音阶高亮"
            onChange={(value) => patch({ scaleHighlight: value })}
          />
        </div>

        <FieldGroup label={`默认力度 · ${ui.defaultVelocity}`} hint="在钢琴卷帘里绘制新音符时使用的力度（1–127）。">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <Slider
                value={ui.defaultVelocity}
                min={1}
                max={127}
                step={1}
                ariaLabel="默认力度"
                onChange={(value) => patch({ defaultVelocity: Math.round(value) })}
              />
            </div>
            <NumberField
              value={ui.defaultVelocity}
              min={1}
              max={127}
              step={1}
              width={58}
              onChange={(value) => patch({ defaultVelocity: Math.round(value) })}
            />
          </div>
        </FieldGroup>
      </Section>

      <Section title="关于界面偏好" description="更多布局选项会随版本迭代补充。" icon={<Languages size={13} />}>
        <StatusLine tone="neutral">
          所有偏好保存在本机 data/settings.json；恢复默认只会重置设置，不会删除你的工程与导出文件。
        </StatusLine>
      </Section>
    </div>
  )
}
