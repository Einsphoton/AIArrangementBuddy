# UI 层级（z-index / 堆叠上下文）约定与「文件菜单被内容层遮挡」修复

> 2026-11-12 用户报障：「UI 层级有问题」——截图里打开顶栏「文件」菜单后，时间轴工具条的
> 「选择 / 切片 / 磁铁 / 1/16」按钮和黄色播放头竖线直接画在了菜单上面。
> 本文记录根因、修复方式、全应用层级标尺，以及可复跑的验收脚本。

---

## 1. 现象

- 打开「文件」菜单后，菜单顶部两块内容被穿透：
  - 主编辑区最上方的**时间轴工具条**（吸附/工具切换按钮）压在菜单的第 3–4 行菜单项上；
  - **播放头**（1.5px 黄色竖线）从菜单顶部一直画到菜单底部，穿过「示例工程」列表和底部说明文字。
- 缩放窗口（宽 460px 左右）后同样复现，且因为菜单几乎盖满时间轴，观感更差。

## 2. 根因（堆叠上下文分析）

```
#root
├─ header      position: relative; z-index: 30      ← 创建堆叠上下文
│    └─ div（文件按钮 wrapper）position: relative
│         └─ ProjectMenu  position: absolute; z-index: 50   ← 被关在 header 上下文里
└─ div（主体）
     └─ main   position: relative; z-index: auto    ← 不创建堆叠上下文
          └─ TimelineToolbar  position: relative; z-index: 30
          └─ Playhead         position: absolute; z-index: 30
```

关键规则：**`z-index` 只在同一个堆叠上下文里比较**。

1. `ProjectMenu` 的 `z-50` 只作用于 header 内部，整个 header 在根上下文里仍只是一个 `z-30` 的参与者；
2. `main` 没有 `z-index`（`relative` 不自动创建堆叠上下文），所以工具条 / 播放头的 `z-30`
   直接参与根上下文；
3. 根上下文里两者 **z-index 同为 30，后出现的 DOM 胜出**——`main` 在 `header` 之后，
   于是工具条与播放头画在菜单上面。

headless Chrome 实测（1440×900）：

| 元素 | rect | z-index | 结果 |
| --- | --- | --- | --- |
| 文件菜单 | `[197,45,306,596]` | 50（但在 header z-30 上下文内） | 被盖 |
| 时间轴工具条 | `[264,169,780,38]` | 30（根上下文） | 盖住菜单 |
| 播放头 | `[264,207,0,530]` | 30（根上下文） | 盖住菜单 |

`document.elementsFromPoint` 在菜单内部采样，最上层元素是工具条的按钮 / 顶栏以外的内容层元素，
即菜单被内容层遮挡（修复前 `.verify-ui/layer-probe` 采样到 3–6 处 offender）。

## 3. 修复

**把「文件」菜单从顶栏里挪出来：portal 到 `document.body`，用 fixed 定位 + `z-45`。**

`apps/web/src/features/topbar/ProjectMenu.tsx`

- 新增 `anchorRef`（由 `TopBar` 的「文件」按钮提供），组件挂载时测量按钮 rect，
  定位为 `left = 按钮左边缘`、`top = 按钮下边缘 + 8px`；
- 左边缘按视口夹取（`max(8, min(left, innerWidth - 菜单宽 - 8))`），高度按
  `innerHeight - top - 8` 限制并可滚动，避免小窗口下越界；
- 菜单 DOM 通过 `createPortal(..., document.body)` 渲染，`position: fixed`、`z-[45]`；
- 窗口 `resize` 时重新测量，菜单继续贴住按钮。

`apps/web/src/features/topbar/TopBar.tsx`

- 给「文件」按钮加 `ref`，把锚点传给 `ProjectMenu`。

**为什么是 45**：它要盖住内容层（时间轴工具条 / 播放头 / 框选都是 30，AI 面板内浮层 40），
但必须**低于模态外壳的 50**——否则「菜单开着按 ⌘, 打开设置」时，菜单会盖在设置弹窗上面，
反而制造新的层级倒置（`verify-layers.mjs` 有一条用例专门守这个边界）。
因此选 45 而不是 120：120 会要求把模态(50)、模态内下拉(80)、右键菜单(80) 等一起重排，
属于更大范围的层级标尺改造，见 §6 的「完整标尺」。

为什么不用「把顶栏 z-index 调到更高」：顶栏若高过内容层，也会一并盖住 `z-50` 的设置/导出等模态；
而 portal 出去后菜单只受自己的 z-index 控制，**未来内容层再怎么加 z-index 也不会再穿透菜单**。
这也是本仓库既有做法（新建向导弹窗、简谱导入弹窗早就因为同样原因 portal 到 body）。

## 4. 层级标尺（新增浮层请照此选值）

| 层级 | z-index | 典型元素 | 渲染位置 |
| --- | --- | --- | --- |
| 内容局部 | 0–20 | 片段选中/拖拽高亮、轨道行、混音器、AI 面板内部浮层 | 组件内 absolute |
| 编辑器常驻浮层 | 30 | 标尺、时间轴工具条、播放头、顶栏 `header` | 组件内 relative/absolute |
| 内容内弹层 | 40–50 | AI 音频引擎菜单、乐器选择、颜色选择 | 组件内 absolute |
| **顶栏菜单（App chrome 浮层）** | **45** | **文件菜单** | **portal 到 body + fixed** |
| 模态对话框 | 50 | 设置、导出、帮助（`components/ui/index.tsx` 的 `Modal`） | 根节点 fixed |
| 拖拽位置 tooltip | 70 | 片段拖动时跟随光标 | 根节点 fixed |
| 内容右键菜单 | 80 | 片段 / 轨道右键菜单、音频面板 popover | portal 到 body + fixed |
| 首次引导 | 85 | `WelcomeOverlay` | 根节点 fixed |
| 命令面板 | 90 | `CommandPalette` | portal 到 body + fixed |
| 业务模态 | 200 / 210 | 新建向导、简谱导入、AI 混音、生成音频、分轨、任务中心、安装引擎、训练 | portal 到 body + fixed |
| Toast | 300 | `ToastHost` | 根节点 fixed |

两条规则：

1. **可能跨区域覆盖的浮层**（顶栏菜单、下拉、对话框）一律 portal 到 body，并按上表取 z；
   只有「永远被自己区域裁剪」的小浮层才用局部 z-index。
2. 不要依赖「同 z-index 不同 DOM 顺序」抢层——那正是本次 bug 的成因。

## 5. 验收

新增 `scripts/verify-layers.mjs`（`pnpm verify:layers`），真实浏览器 + CDP：

- 视口：1680 / 1440 / 1280 / 900 / 720 / 460 × 900；
- 每个视口断言：
  - 菜单确实挂在 `document.body`、`position: fixed`、`z-index >= 60`；
  - 菜单贴在「文件」按钮下方 8px，且整体在视口内（含窗口缩放后重新贴合）；
  - **菜单内部网格采样（`elementsFromPoint`）的最上层元素都属于菜单**——圆角外的点自动跳过；
  - 时间轴工具条与播放头与菜单重叠时，都被菜单正确遮挡；
  - 交互：打开工程 → 返回；新建工程向导弹窗（菜单收起）；导入简谱弹窗（Esc 关闭后菜单不被误关）；Esc 关闭菜单；
  - 控制台无错误；
- 产物：`.verify-ui/layers/<width>-file-menu.png`、`.verify-ui/layers/report.json`（隐式由检查输出）。

本轮结果：

| 验收 | 结果 |
| --- | --- |
| `node scripts/verify-layers.mjs` | **109/109 通过**（6 个宽度 × 900 高）；用户报障的 460×707 视口单跑 **19/19 通过** |
| `node scripts/typecheck.mjs` | 通过（core / server / web） |
| `node scripts/build.mjs` | 通过 |

修复前后对比：修复前工具条按钮叠在「导入 MIDI / 导入音频」行上、播放头竖线穿过菜单；
修复后菜单完整浮在最上层，播放头从菜单下边缘以下才开始显示。当前回归截图在
`.verify-ui/layers/<width>-file-menu.png`。

## 6. 同轮只读审计发现的其它层级问题（未改，留作后续）

排查全仓库浮层时还确认了 3 个**与文件菜单无关**的真 bug；本次只修用户报的文件菜单，
下面按优先级记录，改动都很小但对应用户路径不同，建议单独一轮修：

1. **命令面板被 200/210 档对话框盖住（P1）**
   `CommandPalette.tsx:156` 是 `z-[90]`，而生成音频/任务中心/安装引擎等是
   `z-[200]/[210]`；`useGlobalShortcuts.ts:36` 的 ⌘K 守卫只拦 `settingsOpen/helpOpen/exportOpen`，
   不拦这些面板 → 用户在这些面板上按 ⌘K 时，命令面板会在下面打开且抢走 capture 阶段按键，
   表现为「键盘突然失灵」（Esc 可恢复）。
   修法二选一：命令面板提到 `z-[240]`；或给 ⌘K 增加「任何对话框打开时禁用」的守卫。
2. **首次引导盖住设置弹窗（P1）**
   `WelcomeOverlay.tsx:127` 是 `z-[85]`，`Modal`（设置/帮助/导出）是 `z-50` →
   首次启动 700ms 内按 ⌘, 打开设置，设置弹在引导遮罩下面，看似「没反应」。
   修法：`WelcomeOverlay` 提到模态之上（如 `z-[95]`），或引导打开时禁用 ⌘,。
3. **AI 面板「音频引擎」菜单被横向裁切（P1，属裁剪而非遮挡）**
   `ChatPanel.tsx:590` 的 aside 有 `overflow-hidden`，而 `AudioEngineMenu.tsx:151`
   是未 portal 的 `absolute right-0 w-[286px]`：视口 <1400px 时 AI 面板被压到 344/312px，
   菜单左侧被裁 44–88px（标签/文案缺字）。修法：菜单 portal 到 body（沿用本文 §4 规则）。

另外两个「结构脆弱但当前不报错」的点：

- `InstrumentPicker` / `EmotionPicker`（`z-50`，未 portal）和文件菜单**完全同构**：只靠
  `main` / `TrackPanel` 恰好不创建堆叠上下文才没退化。将来谁给这些容器加 `z-*`/`transform`/`isolate`，
  它会立刻变成「被 30 档盖住」。
- `TimelineToolbar` 自身是堆叠上下文且 `overflow-hidden`：以后往里放下拉/气泡会被同时困住和裁切。

### 完整层级标尺（建议后续单独改造）

如果要把层级彻底理顺（而不是像本次这样只动菜单），建议一次性重排：

| 层级 | 目标 z | 现状 |
| --- | --- | --- |
| app chrome | 30 | 30 |
| 顶栏下拉（portal + fixed） | 120 | 45 |
| 模态外壳（设置/帮助/导出） | 130 | 50 |
| 模态内浮层（模型选择、右键菜单） | 140 | 80 |
| 业务对话框 | 200 / 210 | 200 / 210 |
| 首次引导 | 220 | 85 |
| 命令面板 | 240 | 90 |
| Toast | 300 | 300 |

注意这 7 处要**一起改**：只把菜单提到 120 而不动模态/模态内下拉，会制造 3 个新的倒置。
等真正做的时候，建议同时把 z 提升为 CSS 变量（`--z-chrome` / `--z-popover` / `--z-modal`），
并让菜单/弹层统一走同一套 portal + 定位 hook。

## 7. 其它已知边界

- 菜单仍是「点外面关闭 + Esc」语义；portal 后它在 DOM 末尾，纯键盘 Tab 顺序会跟着改变
  （菜单本身没有 roving tabindex，这是既有行为，本次未改）。
- 本标尺是「约定」不是机制：新浮层若在内容区里用 `z-100` 之类的值，仍可能盖住其他区域。
