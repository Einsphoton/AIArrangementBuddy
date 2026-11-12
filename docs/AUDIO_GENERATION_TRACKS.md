# 生成中的音频轨 + 自动落轨（DAW 反馈）

> 用户反馈：调用音频引擎生成后，AI 面板里的任务卡「看起来生成完了」，但 DAW 里完全看不到结果；
> 生成期间也没有任何轨道出现，不知道 AI 到底在做什么。
> 本文记录这次把「等待」做进 DAW：**任务一开始就建好音频轨**，在轨道上盖一层动效，
> 生成完成后原地换成真实音频片段，并自动定位到新轨。

---

## 1. 问题

- 生成期间：编曲视图没有任何变化，只有右侧任务卡在动；分轨任务要等好几分钟，用户以为卡住了。
- 生成完成：`placeAudioClip` 会新增真实音频轨，但如果任务卡被收起 / 关闭、或用户视线不在底部，
  新轨看起来「凭空出现」甚至完全看不到；关闭任务卡还会让前端轮询中断，生成结果不再落轨。
- 工程为空时尤其明显：没有轨道作为参照，生成结果无处可看。

## 2. 设计：先建轨，再生成，最后原地替换

### 2.1 占位轨（AudioJobTrackSlot）

任务开始时按计划一次性创建 **UI 占位轨**，同时出现在：

- 编曲视图车道（轨道行 + 生成中片段）；
- 左侧轨道面板（AI 轨道头 + 进度 + 迷你频谱）；
- 轨道数量徽标旁（`AI +N` 脉冲徽标）。

占位轨**不写进工程**（不参与保存 / 撤销 / 混音器），只是「这条轨已经为生成预留」的承诺。
这样：取消 / 失败 / 刷新都不会在工程里留下空音频轨；生成完成后由 `audioIntent` 落成真实轨，
再 `removeSlot` 让占位轨退场。真实轨的 id、名称、颜色、起点与占位轨一一对应。

### 2.2 生成中片段：动效层

编曲车道上是一条按预估时长画出的「生成中片段」：

| 层 | 实现 | 作用 |
| --- | --- | --- |
| 极光底 | 两团 radial-gradient 缓慢呼吸 | 让轨道有「正在被注入能量」的感觉 |
| 细网格 | repeating-linear-gradient + 上下渐隐 | 暗示时间轴 / 数据写入 |
| 扫描光带 | 100% 宽的斜向高光循环扫过（只动 transform） | 一眼看出「正在工作」 |
| 镜像波形 | 按槽位 id 生成的确定性柱形，上排向上 / 下排向下 | 像一段正在被填满的音频 |
| 进度填充 | `transform: scaleX(进度)` + 底部发光边 | 进度与任务卡 / 服务端采样同步 |
| 进度头 | 跟随百分比移动的 2px 白色光柱 | 当前写入位置 |
| 漂浮粒子 | 少量白点，transform 上浮 | 增加生命感 |
| 文案 | 标题 + 当前阶段 / 排队位 / ETA | 不依赖动画也能读懂状态 |

状态色：排队紫、运行金 / 青、写入绿、阻塞琥珀虚线、失败红、取消灰。
`prefers-reduced-motion: reduce` 下所有动画停止，保留静态波形 / 进度 / 文案。

### 2.3 轨道头：AI 正在生成

左侧轨道头与真实 TrackRow 同高（共用 `resolveTrackHeight`）：
色条位置换成 4 柱迷你频谱，`AI` 徽标 + 轨道名 + 百分比；默认行高下再显示
「扩散采样 · 第 31/50 步 · 2.4 步/s · 预计 6s」与时长；折叠到 38px 时只保留
「AI 徽标 + 名称 + 百分比」，不裁切、不横向溢出。

### 2.4 生命周期

| 任务状态 | 占位轨行为 |
| --- | --- |
| 开始 / 排队 | 立即出现，显示「已建轨 · 等待生成」/「排队中」 |
| 运行 | 进度、阶段、采样步数、ETA 实时更新 |
| 阻塞（缺模型 / 节点未启动） | 保留，显示「等待安装模型 / 等待生成节点」，节点上线自动续跑 |
| 失败 | 就地红态「生成中断」，任务卡可重试；关闭任务卡 / 重试时移除 |
| 取消 | 立即退场，工程无残留 |
| 完成 | 每条真实轨落成后移除对应占位轨，真实片段在原位置出现 |

### 2.5 落轨与自动定位

`placeGeneratedAsset` / `runMidiRender` 在生成完成后：

1. 占位轨切到「写入」态（99%）；
2. 拉峰值 → 一次 `store.mutate` 新增 `kind:'audio'` 轨道 + `AudioClip` + 登记 `AssetRef`；
3. 移除占位轨；
4. 选中真实轨，`requestReveal(trackId, startBeat)` 让编曲视图把新轨与新片段滚进视野。

真实轨名称 / 颜色直接沿用占位轨（配色会避开工程里已有的颜色），所以视觉上就是
「占位轨原地变成了真实音频轨」，不是另起一条。

### 2.6 收起任务卡 ≠ 中断生成

任务卡右上角在运行 / 阻塞时是「收起」而不是「关闭」：只隐藏卡片，任务继续轮询和落轨；
轨道头的「查看」按钮可以恢复任务卡。完成时任务卡会自动重新出现，给一个明确的收尾确认。
这样就不会再出现「手滑关掉卡片 → 生成完了却没有结果」。

## 3. 实现

- `apps/web/src/features/audio/audioJobStore.ts`
  - 新增 `slots: AudioJobTrackSlot[]`、`updateSlot`、`removeSlot`、`setHidden`；
  - `start` 接收 `slots`，`updateStep` 同步槽位状态 / 进度 / 排队位；
  - `finish`：done / canceled 清空槽位，failed 保留红态，blocked 保留等待态。
- `apps/web/src/features/audio/GenerationTrack.tsx`（新建）
  - `GenerationTrackClip`（编曲车道动效片段）、`GenerationTrackHeader`（轨道头）；
  - `resolveSlotVisual`：把任务 / 槽位状态翻译成标题、副文案、百分比、色调。
- `apps/web/src/features/arrangement/ArrangementView.tsx`
  - 渲染占位车道，行高 / 内容宽度 / 播放头高度纳入槽位；
  - 任务开始时自动滚到「AI 生成轨」；落轨后按 `revealRequest` 定位新轨与新片段。
- `apps/web/src/features/tracks/TrackPanel.tsx`
  - 渲染占位轨道头；`AI +N` 徽标；与编曲车道共用行高、同步滚动。
- `apps/web/src/features/audio/audioIntent.ts`
  - 计划开始即生成槽位（整曲 + 各分轨 / MIDI 渲染）；
  - 落轨写入槽位名称、颜色，完成后移除并 `requestReveal`；
  - 修正 `midi_then_audio` 的步骤定义使其与渲染路径一致。
- `apps/web/src/store/store.ts`
  - 新增一次性 `revealRequest`（trackId + beat + token），不持久化。
- `apps/web/src/features/audio/AudioJobCard.tsx`
  - 运行 / 阻塞时关闭改为收起；底部显示「DAW 已建 N 条轨」。
- `apps/web/src/styles/index.css`
  - 新增 `genlane-*` / `genhead*` 约 600 行；动画只动 transform / opacity；
  - 失败 / 阻塞 / 排队 / 折叠 / reduced-motion 均有独立回退。

## 4. 验收

```bash
node scripts/build.mjs
node scripts/typecheck.mjs
DAW_SKIP_BUILD=1 node scripts/verify-audio-daw.mjs
AUDIO_VERIFY_SKIP_BUILD=1 node scripts/verify-audio-intent.mjs
STAGE_SKIP_BUILD=1 node scripts/verify-audio-stage.mjs
```

`verify-audio-daw.mjs` 用真实 headless Chrome + mock Companion（任务 / 遥测 / 峰值）覆盖：

- 生成开始：4 条占位车道 + 4 条轨道头 + 4 个片段；工程轨道数不变（不污染工程）；
- 左右行 top 严格对齐（±1px）；
- 片段按开始拍 / 时长落位；
- 扫描光带 / 镜像波形 / 极光 / 轨道头频谱均有动画；
- 轨道头显示 AI 徽标 + 62% + 阶段文案；
- 收起任务卡后占位轨保留、任务不中断，轨道头可恢复任务卡；
- 阻塞 / 失败时占位轨保留并就地换色；
- 真实分轨流程：先出现占位轨（此时工程还没有音频轨）→ 整曲 + 3 条分轨全部落成
  `kind:'audio'` 轨道（每条 1 个 AudioClip）、资产登记、占位轨全部退场；
- 落轨后自动定位到新轨（选中且在视野内）；
- 自动保存后服务端工程里包含音频片段与资产；
- 折叠行高（38px）下标题无溢出、无横向溢出；
- 控制台 0 条未预期错误。

产物：`.verify-audio-daw/{running,blocked,failed,compact,placed-running,placed}-1440.png`、`report.json`。

另外用**真实服务端 + `node scripts/companion.mjs --mock`**（不是 fetch mock）跑通过一次完整链路：
注册节点 → `generate_audio` → 轮询任务 → 资产落盘 → 前端落轨。结果：工程 7 → 8 轨、
新增 1 条 `kind:'audio'` 轨道（1 个 AudioClip、2s mock WAV）、`project.assets` +1、占位轨 0 条、
任务 `done`。说明「生成完看不到结果」不是落轨链路缺失，而是当时本机 Companion 不在线。

## 5. 已知边界

- 占位轨是 UI 状态，不写进工程：混音器里生成期间不会出现临时通道（避免取消后留下空轨）；
  生成完成后真实轨会正常出现在混音器。
- 刷新页面会丢失占位轨（前端任务状态不持久化），但已落成的真实音频轨会随工程保存。
- 分轨任务按顺序串行；后续可以并行化，但当前 UI 已能显示每条分轨各自的排队 / 运行状态。
- 阻塞后自动续跑仍复用原计划（从头开始），若在部分分轨完成后断线，重试会重新生成整曲；
  这是既有重试语义，本次未改动。
