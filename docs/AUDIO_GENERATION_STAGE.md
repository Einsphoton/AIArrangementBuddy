# AI 音频生成舞台（音频任务卡重做）

> 用户反馈：调用音频引擎生成音频时，AI 面板底部只有一张静态「等待」卡——步骤一排「等待」、
> 阻塞时整块红色报错、启动命令按钮被挤成两行，看不出 AI 在做什么，也没有等待的代入感。
> 本文记录这次把「音频任务卡」重做成动态「AI 生成舞台」的设计、实现与验收。

---

## 1. 问题（改造前）

- 运行态：一个通用进度条 + 一排小圆点，所有步骤都写「等待」；没有时间/ETA、没有阶段叙事。
- 阻塞态（模型已安装但生成节点 Companion 未启动）：大面积红色报错观感，`复制启动命令` 按钮在窄面板里换行，
  命令被截断成不可读的一行；节点启动后任务不会自动继续，用户要重新对 AI 说一遍。
- 完成/失败态：信息密度低，失败后只能关闭重来。
- 卡内文字小到 9px，与仓库「无 <10px 文本」的 UI 基线冲突。

## 2. 设计

### 2.1 运行态：让等待「像在生成音乐」

| 元素 | 作用 |
| --- | --- |
| 24px 生成光球（conic 渐变环旋转 + 呼吸光晕 + 模式图标） | 一眼看出「AI 正在进行」 |
| 实时叙事行（`aria-live`，文案随阶段切换并 fade-up） | 「正在唤醒音频引擎 / 正在合成整曲 / 正在生成「鼓组」分轨 / 正在写入轨道」——解释等待在做什么 |
| 44 柱动态频谱 | 底层 25% 幽灵波形（慢呼吸）、上层 cyan→violet→accent 渐变「已生成波形」按整体进度 `clip-path` 从左往右揭示（300ms 过渡），进度头部一根 2px 发光扫描线；排队时低振幅、运行中活跃、完成时收敛成 success 色 |
| 17px 等宽百分比 + 6px 渐变进度条 + 光点 | 大字进度 + 进度头部光点，可读性优先 |
| 已用时间 / 预计剩余 | 排队用服务端 `etaSec`；运行中按 `elapsed × (1-p)/p` 估算并取整到 5s |
| 横向分轨管道 | 每个 step 一枚 chip：乐器图标（鼓组/贝斯/吉他/人声/键盘/合成/弦乐）+ 短标签 + 状态；运行中 chip 带光边、迷你三柱均衡器与百分比，完成绿勾、失败红色感叹、等待低对比；chip 间细箭头体现流水线；当前 step 自动滚入视野 + 左右 mask 渐隐 |
| 底部 | 取消 + `已加入 N 条轨 · AI 自动执行中`（脉冲点） |

### 2.2 阻塞态：把「报错」变成「待接入」的等待

- 琥珀 + 紫罗兰待机观感（不再大面积红色），56px 雷达：中心 Bot/Download 图标 + 3 圈错峰扩散。
- 标题「等待生成节点接入」+ 一句人话解释：「模型已就绪，只差在你的 GPU 机器上启动生成节点；启动后这里会自动继续。」
- 启动命令做成一整行 mono 命令块（单行省略、可复制全文），下面是独立的全宽 accent 主按钮「复制启动命令」（永不换行）。
- **自动检测 + 自动续跑**：每 2.5s 轮询 `GET /api/companion/status`（页面隐藏时跳过），显示
  「正在自动检测节点… 已等待 Ns」；一旦 `online && workers > 0` 就调用 `retryAudioJob(job.id)`
  用上一份计划自动继续，并 toast「生成节点已上线，继续生成音频…」。同一阻塞任务只自动拉起一次。
- 缺模型（provision）阻塞：雷达换成下载图标，保留「打开下载面板」（`data-audio-job-install` + `aiab:provision-open` 事件，
  分轨模式预选 stems），另给「重试」。
- 两种阻塞态都提供 `重试`（`job.retryable`）与 `关闭`，不会伪造成功。

### 2.3 完成 / 失败 / compact

- 完成：success 色调 +「生成完成 · 已写入工程」+ 落轨轨道名 chips +「⌘Z 可撤销」。
- 失败：danger 错误原因（可换行）+「重试」（复用上一份计划）+「关闭」。
- compact（AI 面板高度 < 520px，ChatPanel 传入）：频谱 24px、隐藏分轨管道与模式 chip，改为
  「第 2/5 步 · 分轨 · 鼓组」摘要 + 进度，实测卡高 **110px**，不挤压输入框。

## 3. 实现

- `apps/web/src/features/audio/AudioJobCard.tsx`：重写任务卡外壳（状态、计时、节点轮询、动作）。
- `apps/web/src/features/audio/AudioGenerationStage.tsx`（新建）：纯展示零件——`GenerationOrb`、
  `GenerationSpectrum`、`TrackPipeline`、`BlockedRadar`、`stepMeta`/`pipelineSummary`/`MODE_SHORT`。
- `apps/web/src/styles/index.css`：末尾 `gen-*` section（约 660 行）——所有动画只动 `transform`/`opacity`
  （进度揭示用 `clip-path`，规格要求），`prefers-reduced-motion: reduce` 下有静态回退（波形保留渐变层次、
  雷达保留同心静态圈，信息不依赖动画）。
- `apps/web/src/features/audio/audioJobStore.ts`：步骤新增 `queuePosition` / `etaSec` / `startedAt`，
  任务新增 `retryable`；第一次进入 running 自动记录开始时间（调用方显式传入时优先）。
- `apps/web/src/features/audio/audioIntent.ts`：任务轮询写入排队位置/ETA；保留最近一份计划，
  导出 `retryAudioJob(expectedJobId?)` 供任务卡重试与节点上线自动续跑；失败/阻塞任务标记 `retryable`。
- `apps/web/src/App.tsx`：调试句柄 `window.AIAB` 暴露 `useAudioJobStore` 与 `retryAudioJob`（自动化验收注入状态用）。
- `apps/web/src/features/chat/ChatPanel.tsx`：`<AudioJobCard compact={compact} />`。
- `scripts/verify-audio-stage.mjs`（新建）：浏览器级截图 + 几何验收探针（见 §4）。

### 3.1 顺手修复：安装对话框叠层（P11 回归）

`TopBar`（`mode="trigger"`）与 `App`（`mode="global"`）各挂了一个 `ProvisionButton`，两个实例都监听
`aiab:provision-open` 且都渲染 `[data-provision-panel]`——AI 缺模型自动唤起时会叠出两层一样的对话框，
点一次关闭只关掉一层，导致「关闭后仍能查到面板」以及 `verify-audio-intent` 的分轨预选断言失败。
修复：只有 `mode="global"` 宿主响应事件并渲染对话框；TopBar 按钮点击改为派发同一事件。

## 4. 验收

```bash
node scripts/build.mjs                                  # 前端/后端构建
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit
STAGE_SKIP_BUILD=1 node scripts/verify-audio-stage.mjs  # 19 状态×宽度组合
node scripts/verify-audio-intent.mjs                    # 音频意图回归
```

结果（2026-11-12，真实 headless Chrome + 静态服务）：

| 验收 | 结果 |
| --- | --- |
| `verify-audio-stage.mjs` | **19/19 PASS**：stems-running / text-running / queued / blocked-companion / blocked-provision / done / failed / midi-running × 1440/1280，compact（1440x640）、reduced-motion、auto-resume（真实 `runAudioPlan` → blocked → mock 节点上线 → 2.1s 内自动 running） |
| `verify-audio-intent.mjs` | **8/8 PASS**（含分轨模式预选 stems、MIDI→音频落轨） |
| tsc / build | 通过（core / server / web） |

实测尺寸：运行态分轨卡 371×204（1440）/ 319×204（1280）；阻塞（节点未启动）371×185；
完成 371×168；失败 371×111；compact 371×110；卡内 <10px 文本 0、无横向溢出、按钮不换行、
卡片完整落在 AI 面板内。

产物：`.verify-ui-audio-stage/<state>-<width>.png`、`<state>-card@2x.png`、`report.json`。

## 5. 已知边界

- 阻塞态命令块是单行省略（`scrollWidth 572 / clientWidth 331`），点击「复制启动命令」复制完整命令。
- 1280 宽度下面板 319px 时 5 步管道有 ~5px 内部横向滚动（无滚动条，当前 step 自动滚入视野），卡本身无溢出。
- compact 目标 110px 针对运行/完成态；compact 阻塞态（雷达 + 命令块 + 两行说明 + 按钮）约 150px，
  未强行压到 110px。
- 运行中 ETA 是「按当前进度的线性外推」，只是体验参考；排队 ETA 来自服务端历史均值。
- 节点上线自动续跑依赖 `/api/companion/status` 变为 `online && workers > 0`；若后端本身不可达，
  卡片保持「正在自动检测」并给出本地服务提示，不会伪造成功。
