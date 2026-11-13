# 轨道多选与轨道头信息重排 — 施工规格（内部）

> 本文件是这一轮 UI 改造的**施工契约**：Lead、arrangement、verifier 三方按同一份 API /
> 选择器 / 交互语义施工，避免各写一套导致行为漂移。完成后会并入 `docs/UI_UX_UPGRADE.md`。

## 0. 用户反馈（原文要点）

1. 与成熟 DAW 相比 UI / 交互差距大，**轨道多选编辑**缺失；
2. **轨道信息排版拥挤**、内容快显示不开（截图：264px 轨道头里塞了 名称 + R/M/S + 试听 + 信息 + 折叠 六个按钮，三行文字）；
3. 鼠标**拖选多选**很难用：鼠标起始点一旦落在轨道外（列表空白 / 时间轴空白）就无法框选。

## 1. 设计目标

- 轨道头：**R/M/S 改为右侧竖排控制轨**（Logic / Cubase 的既有范式），把横向空间还给名称；
  第二行放乐器 / 情绪 / 音量 / 声像；第三行只保留**轨道自身**的创作信息（段落 / 智能片段），
  项目级信息（风格 / 调号 / BPM）上移到轨道面板总控行，不再每行重复。
- 轨道面板宽度**可拖拽**（240–460px，默认 288px，持久化），窄宽度自动降级（隐藏次要按钮）。
- 轨道多选：Ctrl/⌘ 切换、Shift 连选、**在轨道列表任意位置按下拖动都能量选**（含列表底部空白）、
  自动滚动；批量 M/S/删除/复制/改色/音量/声像/拖动排序。
- 编曲视图：选中轨道在车道上同步高亮；点击空白车道支持修饰键；**框选可在轨道行之外的空白处起拖**
  （框选矩形覆盖到的轨道行进入多选）。
- 保持「一次手势一个撤销点」与现有 R/M/S 派生语义（solo 不写回 mute）。

## 2. Store API（`apps/web/src/store/store.ts`）

### 2.1 新增 state

```ts
/** 多选轨道 id（按工程顺序；空数组 = 无选中） */
selectedTrackIds: string[]
/** Shift 连选的锚点（= 最后一次普通/切换点击的轨道） */
trackSelectionAnchorId: string | null
```

`selectedTrackId` **保留**，语义 = 主轨（焦点轨）= anchor，且必须 ∈ `selectedTrackIds`；
`focusedTrackId` 同步。所有既有调用方（钢琴卷帘 / AI 面板 / 状态栏 / 混音器）行为不变。

### 2.2 新增 actions

```ts
selectTrack: (trackId: string, opts?: { mode?: 'replace' | 'toggle' | 'range'; keepClip?: boolean }) => void
selectTracks: (ids: string[], anchorId?: string | null) => void
selectAllTracks: () => void
clearTrackSelection: () => void
removeTracks: (ids: string[]) => void          // 一次 mutate / 一个撤销点
duplicateTracks: (ids: string[]) => string[]   // 复制多条，返回新 id
setTracksMuted: (ids: string[], muted: boolean) => void   // 一次 mutate
setTracksSolo: (ids: string[], solo: boolean) => void     // 一次 mutate；exclusive 仍走 setTrackSolo
```

语义：

- `replace`（默认）：`ids=[id]`，anchor/focused/selectedTrackId=id，`selection.clipId` = 该轨第一个片段。
- `toggle`（Ctrl/⌘ 点击）：在集合里则移除，否则加入；anchor=id；移除后若集合为空，
  `selectedTrackId` 回退为工程第一条轨；若被移除的是唯一选中，`selection.clipId=null`。
- `range`（Shift 点击）：以 `trackSelectionAnchorId`（无效则当前主轨）为锚，按 `project.tracks` 顺序取闭区间；
  替换集合；anchor 不变。
- `selectTracks`：直接替换集合（框选用），anchor 取第二参数或集合第一项。
- 批量删除后：集合过滤为仍存在的轨道；若 anchor 被删，anchor = 集合最后一项或工程第一条。
- 所有会改变轨道列表的入口（`mutate` / `undo` / `redo` / `setProject` / `removeTrack` / `removeTracks` /
  AI `setProject`）都要对 `selectedTrackIds` 做幂等对账（过滤不存在 id；空则回退第一条轨）。
  **不要**在每次普通 mutate（改音量等）重置选择。
- `focusTrack(trackId)`：把 trackId 并入 `selectedTrackIds`（不改其它选中），anchor=id，其余同现状。
- `selectClip(trackId, clipId)` / `selectAudioClip`：把 trackId 设为 anchor 并**保留**多选集合，
  仅当 trackId 不在集合中时替换为单轨（保证「点片段」时轨道高亮同步，但不破坏多选）。
- `removeTrack(trackId)` 保持旧签名行为，内部委托 `removeTracks([trackId])`。

## 3. uiStore（`apps/web/src/lib/uiStore.ts`）

```ts
trackPanelWidth: number            // 默认 288，夹取 240..460，持久化
setTrackPanelWidth: (width: number) => void
TRACK_PANEL_WIDTH_LIMITS = { min: 240, max: 460, default: 288 }
```

## 4. 数据属性 / 选择器契约（自动化验收依赖，禁止改名）

轨道面板与车道共用的行元素：

| 属性 | 位置 | 值 |
| --- | --- | --- |
| `data-track-panel` | `<aside>` | — |
| `data-track-panel-splitter` | 右侧拖拽条 | `role="separator"` |
| `data-track-panel-width` | `<aside>` | 当前像素宽度 |
| `data-track-list` | 轨道列表滚动容器 | — |
| `data-track-row` | 每条轨道行 | 面板 + 车道都有 |
| `data-track-row="panel"` / `"lane"` | 同上 | 区分左右 |
| `data-track-id` / `data-track-index` | 行 | 轨道 id / 序号 |
| `data-track-selected` | 行 | `"true"` / `"false"` |
| `data-track-primary` | 行 | `"true"` / `"false"`（anchor 主轨） |
| `data-track-selection-count` | 面板表头 / 总控行 | 已选数量文本 |
| `data-track-marquee` | 框选矩形 | 面板/车道 |
| `data-track-mute` / `data-track-solo` / `data-arm` | 既有 R/M/S 按钮 | 保持现有值 |
| `data-track-name` | 名称按钮/文本 | 轨道名 |

## 5. TrackPanel 交互（Lead）

- 面板宽度：右侧 4px 拖拽条（`col-resize`），拖动实时 setTrackPanelWidth，双击复位 288。
- 行点击：
  - 普通点击 = `selectTrack(id, { mode: 'replace' })`；
  - Ctrl/⌘ = `toggle`；Shift = `range`（阻止默认文本选择）。
- 列表容器框选（任意起点，含底部空白）：
  - 在 `[data-track-list]` 上 pointerdown；若目标在 `button / input / [role=slider] / [draggable=true]` 内则忽略；
  - 记录锚点行（指针所在行；指针在最后一行以下时锚点=最后一行）；
  - 移动 > 4px 判定为拖选：显示 `data-track-marquee` 覆盖层；
  - 每次移动：按当前指针行计算 [anchor, current] 区间；未按 Shift 时替换选择，按 Shift 时并集；
  - 指针靠近列表上下边缘 24px 时自动滚动（rAF，8–14px/帧），并持续更新区间；
  - pointerup：结束；若发生过拖动，抑制随后的 click（避免又复位成单选）。
- 表头：已选数量徽标（`data-track-selection-count`）、复制/删除作用到整个选中集合，tooltip 带数量。
- 总控行（54px）：第一行 = `N 片段 · N 音符` + 项目级 `风格 · 调号 · BPM`（替代每行重复）；
  右侧窄屏隐藏「拖色条排序」提示（保留 title）；第二行 MixMasterControls。
- 拖动排序：拖动色条时若该轨属于多选（>1），整体移动选中块（保持相对顺序）。

## 6. TrackRow 信息重排（Lead）

- 行高基线 `TRACK_ROW_BASE` 56 → **60**（`rowHeightForZoom(16)=60`，两侧视图同一公式，仍然严格对齐）。
- 结构（左→右）：
  1. 色条 14px（拖排序 / 点击换色）— 保留；
  2. 主列（flex-1，`px-2 py-1 gap-[3px]`）：
     - 行1（20px）：序号 + **名称（flex-1，优先占用宽度）** + [试听（宽面板才显示）] + [创作信息 ⓘ] + [折叠 ⌄]；
     - 行2（18px）：音频轨 = `音频 · N 片段`；MIDI = 乐器图标 + 名称 + 情绪 chip（窄面板只留圆点）+
       右对齐 音量 MiniHSlider(36) + 声像 MiniKnob(15)；
     - 行3（11px，行高 ≥ 58 时才显示）：**仅轨道自身**的创作信息（段落 / 智能片段摘要），去掉项目级重复；
  3. 右侧竖排控制轨 20px：R / M / S 三个 17×15 按钮竖排（保留 data-track-* 与 pulse/派生静音样式）；
  4. 行尾 3px 实时电平条（保留）；底部 4px 行高拖拽热区（保留）。
- 多选行为：
  - 行处于多选中时点 M = 对全部选中轨 `setTracksMuted(ids, next)`；S 同理；R 仍独占单轨；
  - 音量 / 声像拖动 = 相对同步作用于全部选中轨（一次 pushHistory，history:false 批量更新）；
  - 换色 = 应用到全部选中轨；右键菜单删除/复制显示数量并作用于选中集合；新增「试听音色」菜单项（承接原试听按钮）。
- 视觉：多选行背景 tint + 左侧 2px 色条；主轨（anchor）更亮并带 accent 描边；行高/折叠/电平/对齐不回退。

## 7. ArrangementView（teammate: arrangement）

- 车道行高亮：`selectedTrackIds` 中所有行都 tint，anchor 行更亮；保留 `data-track-row` 并补
  `data-track-row="lane"`、`data-track-selected`、`data-track-primary`。
- 空白车道单击：普通 = 替换选中该轨 + 定位播放头；Shift = 轨道 range（不移动播放头）；
  Ctrl/⌘ = toggle（不移动播放头）。
- 框选：
  - 把手势从「轨道行容器」上移到**时间轴内容层**（`contentRef`），使鼠标在**轨道行之外的空白**
    （最后一行以下、底部留白区）按下也能框选；
  - 框选矩形覆盖到的车道行 → `selectTracks(ids)`（多选轨道），并保留现有片段框选逻辑；
  - 框选拖拽靠近视口上/下/左/右边缘时自动滚动；
  - Shift 框选 = 与既有选择并集。
- 不要改变标尺点击定位播放头、片段拖拽/右键、生成占位轨等既有行为。

## 8. 验收（teammate: verifier）

新脚本 `scripts/verify-track-ui.mjs`（复用 `scripts/lib/browser-harness.mjs`，真实 Chrome + CDP）：

1. Ctrl/⌘ 点击两条轨 → `selectedTrackIds.length===2`，两行 `data-track-selected="true"`；
2. Shift 点击第 5 条 → 连续 4 条选中；
3. 面板框选：从第 1 行主体拖到第 4 行 → 4 条选中，`data-track-marquee` 出现过；
4. 面板框选从列表底部空白按下向上拖 → 仍有选中（不再完全失效）；
5. 编曲视图从最后一条轨以下空白处起拖 → 框选矩形出现且选中数 > 0；
6. 多选 3 轨点 M → 3 轨 mute；Ctrl+Z → 恢复；多选删除 → 一次撤销恢复；
7. 面板宽度拖拽 → `data-track-panel-width` 变化并写入 localStorage；双击复位；
8. 布局断言：1280/1440/1680 三个宽度下，轨道行内文字无 clip/overlap，名称可用宽度 ≥ 90px，
   R/M/S 不与名称重叠；总控行无截断（允许名称省略号）；
9. 控制台 0 错误；截图存 `.verify-track-ui/`。

回归：`node scripts/typecheck.mjs`、`node scripts/test.mjs`、`node scripts/e2e.mjs`、
`node scripts/verify-ui.mjs`、`node scripts/audit-layout.mjs` 全绿。

> 环境提示：本机 Chrome 需要 danger-full-access（默认 workspace-write 沙箱下 mojo 命名管道被拒）。
> 构建：`node scripts/build.mjs`（全权限下可用）。

## 9. 文件所有权（写权限互斥）

| 单元 | 文件 |
| --- | --- |
| Lead | `apps/web/src/store/store.ts`、`lib/uiStore.ts`、`features/tracks/TrackRow.tsx`、`TrackPanel.tsx`、`trackMenu.tsx`、`features/tracks/MixMasterControls.tsx`、`docs/*` |
| arrangement | `apps/web/src/features/arrangement/ArrangementView.tsx`、`usePointerDrag.ts` |
| verifier | `scripts/verify-track-ui.mjs`、`.verify-track-ui/` |
