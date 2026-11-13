# 轨道多选与轨道头信息重排（第三轮 UI 升级）

> 用户反馈：与成熟 DAW 相比，编辑器 UI / 交互差距仍大；**轨道多选编辑缺失**；
> **轨道信息排版拥挤、内容快显示不开**；**鼠标拖选多选很难用——起点落在轨道外就完全失效**。
>
> 本轮只改界面 / 交互 / 选择模型，不动乐理生成、音频合成与 AI 工具协议。
> 施工契约（API / 选择器 / 交互语义）见 `docs/TRACK_SELECTION_SPEC.md`。

---

## 1. 现状审计（施工前）

### 1.1 轨道头为什么「挤」

| # | 根因 | 证据 |
| --- | --- | --- |
| R1 | **第一行塞了 6 个控件**：序号 + 名称 + R + M + S + 试听 + 创作信息 + 折叠 | 264px 面板下名称只剩约 80–130px，长轨名（`生成一 J-ROCK 电吉他`、`Stem· 吉他`）几乎全被截断 |
| R2 | **项目级信息在每行重复**：`流行 · C 自然大调 · 108 BPM · 主歌` 是整首工程共用的，却在每条轨道第三行重复 | 12 轨时同一串文字重复 12 次，纯粹挤占信息密度，还让人误以为是轨道属性 |
| R3 | **面板宽度固定 264px**，信息密度高时没有退路 | 无法按屏幕 / 习惯加宽，挤压永远存在 |
| R4 | 行高 56px 硬塞三行文字 + 一行按钮 | 三行只有 8px 间隙，视觉上「快显示不开」 |

### 1.2 为什么拖选多选不可用

| # | 根因 | 证据 |
| --- | --- | --- |
| D1 | **没有多选模型**：store 只有 `selectedTrackId` 单选 | 轨道选择、批量 M/S、批量删除 / 复制都无从谈起 |
| D2 | 只有单击选中，没有 Ctrl/⌘ 切换、Shift 连选 | 与 Logic / Cubase / Studio One 的肌肉记忆不符 |
| D3 | **框选只能从轨道行内起拖**（轨道列表没有框选手势；编曲视图的框选绑定在「轨道行容器」上） | 鼠标起点落在最后一条轨道以下 / 列表空白 / 时间轴下方空白时，框选完全无反应——用户原话「一旦鼠标起始点在轨道外，就无法执行多选操作」 |

---

## 2. 设计决策

### 2.1 轨道头：把 R/M/S 竖排到右侧控制轨（Cubase / Logic 范式）

- 第一行只留 **序号 + 名称 + 试听 / 创作信息 / 折叠**，名称优先占满宽度；
- 第二行：乐器（音频轨为片段数）· 情绪 chip + 音量 / 声像；
- 第三行：**只属于这条轨道**的信息（段落 / 智能片段类型），项目级 `风格 · 调号 · BPM` 上移到总控行；
- 右侧 20px 竖排控制轨：R / M / S 竖排，行高不足时自动收紧 / 隐藏（右键菜单仍可操作）；
- 行高基线 56 → **60px**（轨道头三层信息能同时容纳的最小值，且接近 Logic `/` Cubase 的默认尺度）。

### 2.2 轨道面板宽度可拖拽

- `uiStore.trackPanelWidth`（240–460，默认 **288**，localStorage 持久化）；
- 右侧 4px 分隔条拖动实时改宽，双击复位 288；
- 窄宽度自动降级：情绪 chip 只留圆点、总控行隐藏片段/音符统计、试听按钮收进右键菜单。

### 2.3 多选模型（不破坏既有单轨语义）

- `selectedTrackIds: string[]`（按工程顺序）+ `trackSelectionAnchorId`；
- `selectedTrackId` 保留为「主轨 / anchor」，既有调用方（钢琴卷帘 / AI 上下文 / 状态栏 / MIDI 录入）零改动；
- `selectTrack(id, { mode: 'replace' | 'toggle' | 'range' })`、`selectTracks`、`selectAllTracks`、`clearTrackSelection`；
- 批量 action：`removeTracks` / `duplicateTracks` / `setTracksMuted` / `setTracksSolo`，全部**一次 mutate = 一个撤销点**；
- `mutate / undo / redo / setProject / AI 整轮替换` 统一做**幂等对账**（过滤已删除 id、修正 anchor），
  消除「删轨后选择指向幽灵轨道」这类问题。

### 2.4 交互

| 手势 | 行为 |
| --- | --- |
| 单击轨道 | 单选（主轨 = anchor） |
| Ctrl/⌘ + 点击 | 切换该轨的选中状态 |
| Shift + 点击 | 从 anchor 连选到该轨 |
| 列表任意位置按下拖动（**含最后一条轨以下空白**） | 框选轨道，实时高亮，靠近上下边缘自动滚动 |
| 多选状态点 M / S | 静音 / 独奏作用于全部选中轨（Alt 仍为独占独奏） |
| 多选状态拖音量 / 声像 | 相对同步（保持选中轨之间的相对差） |
| 多选状态换色 / 删除 / 复制 / 行高 | 作用于全部选中轨，右键菜单写明数量 |
| 拖动色条排序 | 若该轨在多选集合内，整体移动选中块 |
| 编曲视图框选 | 矩形覆盖到的车道行进入多选；**可在最后一条轨以下空白处起拖** |

---

## 3. 实现清单

| 文件 | 改动 |
| --- | --- |
| `store/store.ts` | 多选 state + 7 个 action + 批量操作 + 全链路选择对账 |
| `lib/uiStore.ts` | `trackPanelWidth` + 夹取 + 持久化 |
| `features/tracks/TrackRow.tsx` | 轨道头信息层级重排、竖排 R/M/S、批量 M/S、音量/声像相对多选、换色多选、窄面板降级 |
| `features/tracks/TrackPanel.tsx` | 面板宽度拖拽、列表框选（任意起点 + 自动滚动）、修饰键点击、批量工具栏、总控行项目信息 |
| `features/tracks/trackMenu.tsx` | 右键菜单批量作用域 + 数量、试听、全选/仅选此条、行高批量 |
| `features/tracks/trackCreativeInfo.tsx` | 新增 `trackSummary`（只保留轨道自身信息） |
| `features/arrangement/timeline.ts` | 行高基线 56 → 60（两侧视图同一公式，仍严格对齐） |
| `features/arrangement/ArrangementView.tsx` | 车道多选高亮、空白点击修饰键、框选迁到内容层（可在轨道外起拖）+ 自动滚动 |
| `features/status/StatusBar.tsx` | 状态栏常驻「已选 N 轨」 |
| `scripts/verify-track-ui.mjs` | 新增真实 Chrome 验收（多选 / 框选 / 批量 / 面板宽度 / 布局） |
| `scripts/lib/browser-harness.mjs` | 静态服务日志改落盘（受限执行环境下 `spawn(stdio:'pipe')` 会被拒，属验收基础设施修复） |

---

## 4. 验收

### 4.1 自动化结果

| 检查 | 结果 |
| --- | --- |
| `node scripts/typecheck.mjs` | ✓ 三包（core / server / web）全部通过 |
| `node scripts/build.mjs` | ✓ web + server 构建通过 |
| `node scripts/test.mjs` | ✓ 57/57（含轨道头 R/M/S、三态、总控等源码级契约） |
| `node scripts/e2e.mjs` | ✓ 18/18 |
| `node scripts/verify-ui.mjs` | ✓ 40/40（既有界面交互无回归） |
| `scripts/verify-track-ui.mjs`（本轮新增） | ✓ 17/17 |
| `node scripts/audit-layout.mjs` | ✓ 1680 / 1440 / 1280 / 1120 × 11 状态：硬伤 0 · 省略号截断 0 · 小字号 0 |

`scripts/verify-track-ui.mjs` 覆盖的行为（真实 Chrome + CDP）：

1. Ctrl/⌘ 点击两轨 → `selectedTrackIds=2`，两行 `data-track-selected="true"`，主轨 = 最后点击轨；
2. Shift 点击第 5 条 → 第 2–5 条连续 4 条选中；
3. 轨道面板第 1 行主体拖到第 4 行 → 4 条选中，拖动中 `data-track-marquee` 出现且几何覆盖拖选区间；
4. **从轨道列表底部空白向上拖** → 框选出现 + 选中数 > 0（旧实现完全失效的场景）；
5. **编曲视图从最后一条车道以下空白起拖** → 框选出现、矩形与车道相交、选中数 > 0、车道行高亮；
6. 多选 3 轨点 M → 恰好 3 轨 mute，Ctrl+Z 一次恢复；多选删除 → 轨道数 -3，Ctrl+Z 一次恢复；
7. 拖动分隔条 → `data-track-panel-width` 变化、与 `uiStore` 一致、写入 `localStorage`，双击复位 288；
8. 1280 / 1440 / 1680 三宽度布局断言：名称可用宽度 ≥ 90px、名称与 R/M/S 不重叠、行内控件不重叠、
   非省略号文本不裁切、总控行完整可见；
9. 控制台 0 error / 0 exception，截图与 `report.json` 落 `.verify-track-ui/`。

量化证据（1680 × 1000，面板默认 288px）：

- 行高 60px；每行名称可用宽度 **179px**（旧布局约 80–130px），名称与 M 按钮间隙 48px；
- 总控行 287px 内完整显示「工程 流行 · C 自然大调 · 108 BPM｜已选 N 轨｜M 0 S 0 R 0｜复位」；
- 面板 240px（最窄）下仍可读；460px（最宽）时试听按钮等次级操作出现；
- 折叠 26px / 紧凑 44px / 舒展 84px 三档行高均无文字裁切。

### 4.2 截图

| 文件 | 内容 |
| --- | --- |
| `screenshots/01-arrangement.png` | 全新界面总览（多选 2 轨、折叠一条、AI 面板展开） |
| `.verify-track-ui/track-multi-select.png` | 面板多选（已选 2 轨，主轨描边） |
| `.verify-track-ui/track-marquee.png` | 轨道列表拖选过程（琥珀色框选带） |
| `.verify-track-ui/track-panel-wide.png` | 面板加宽到 360px 后的信息层级 |
| `.verify-track-ui/lane-multi-select.png` | 编曲车道多选高亮（已选 7 轨） |
| `.verify-track-ui/lane-marquee.png` | 从最后一条车道以下空白起拖的框选 |
| `.verify-track-ui/arrangement-0*.png` | 空白点击 / Shift 连选 / 框选 / 片段框选 / 多选终态 |

### 4.3 已知限制

- 多选目前覆盖「轨道」维度；混音器通道条仍是单选（点击通道 = 选中该轨）；
- 框选同时会命中矩形内的片段（保留既有片段框选行为），即「框选多选轨道」时可能同时选中片段；
- 未引入轨道组 / bus（仍按轨道独立操作）；
- 轨道多选状态不进入工程文件（属于会话内 UI 状态，与既有 `selectedTrackId` 一致）。

