# Studio 形态：a–g 能力矩阵与路线

> 回答两个问题：**现在能用到什么程度**、**离「Studio 形态」还差哪些**。
> 实测依据：`music-gen/tools/e2e_api_probe.mjs`（对运行中的服务打 11 项能力探针）
> + `music-gen/tools/verify_studio_ui.mjs`（真 Chrome 11 项交互断言，含真实 .mid 导入、1024px 窄屏）。

---

## 0. 一句话结论

**a–g 七条里，六条已经能在产品里用到**（分轨生成、进行灵感、风格/用途生成、和弦标注、导出 MIDI、AI 混音-推子+EQ/压缩），
**一条仍是部分**：局部迭代已支持片段级（智能片段变奏 / 换进行 / AI 编辑工具）与音频级重绘（P2）；
还差：总线级处理链（侧链/母带）、多任务并发、分轨 stem 生成。
P1/P2 已打通"整段音频生成 → 入库 → 上轨播放 → 局部重绘"，**分轨音频（每个乐器一根 stem）仍没做**。

---

## 1. 实测矩阵

| 需求 | 现状 | 产品落点 | 实测证据 |
|---|---|---|---|
| **a. 分轨生成** | ✅ MIDI 分轨 + 音频 stem（P5） | MIDI：`composeProject` 一次 7–9 轨；音频：音频片段右键「生成分轨 Stem…」按乐器（guitar/bass/drums/strings/keys/synth/vocals）各生成一条独立音频轨（base 基座 lego） | 探针 `[a]`：jrpg 9 轨 / 996 音；`verify_p5_stem` 5/5（3 arm 质心 2432/1850/3532Hz，两两差 ≥582Hz）、`verify_p5_ui` 6/6 |
| **b. 带节奏型的和声进行（找灵感）** | ✅ 可用 | 智能片段面板「和弦进行 → 换一组进行」：5 条带标签/描述/节奏提示的进行，点击即写入工程和弦（可 ⌘Z 撤销） | 探针 `[b]`：`小调王道 i-VI-III-VII → Dmin A#maj Fmaj Cmaj`，patternHint「八分音符柱式 + 反拍切分」；UI 验收：5 条建议、和弦 16→4 |
| **c. 用户 MIDI → AI 编曲** | 🟡 部分 | `文件 → 导入 MIDI…` 解析 SMF（format 0/1、running status、多通道分轨、鼓轨单列）；导入后可一键 `arrange` 让 AI 配伴奏 | UI 验收：7 轨导出 → 导入 7 轨 / 240 音 / 108 BPM；探针 `[c]` roundtrip 一致 |
| **c. AI 混音** | ✅ 推子 + 每轨链 + 母线/母带链 | 混音器 →「AI 混音…」：按声部角色 × 风格 × 能量给出每轨音量/声像/发送 + 总线；可勾选「同时应用音频处理链」（每轨三段 EQ + 压缩 + 补偿增益）与「总线 / 母带处理」（总线 EQ + 母线压缩 + 限幅上限）；一次应用一步撤销，可分别清除 | 探针 `[j]`：9 轨推子 + 9 轨链 + 母线 -20.9dB 1.98:1；`verify_masterchain` 8/8；`verify_p3_2_ui` 8/8（真机电平 0.31→0.02→恢复） |
| **d. 特定风格 + 用途** | ✅ 可用 | `文件 → 新建工程…` 两步向导：9 个风格卡片 → 11 个用途场景（战斗/BOSS/地牢/城镇/世界地图/悲伤/片尾/日摇 OP/副歌/抒情/通用 BGM）；风格与用途会落盘到工程 | UI 验收：jrock + 日摇 OP → 176BPM E 小调 7 轨，`project.style='jrock'`、`project.scene='jrock_op'`；1024px 无溢出 |
| **e. 和弦标注 + 创作信息** | 🟡 部分（够用） | 时间轴上方和弦轨渲染和弦名；轨道头第三行显示「风格 · 用途 · 调式 · BPM · 段落」，i 按钮打开只读创作信息弹层（乐器、智能片段参数、seed、跟随和弦） | UI 验收：`日式摇滚 · 日摇 OP · E 自然小调 · 176 BPM · A 段`；探针 `[e]`：16 个和弦 |
| **e. 更细的创作备注落盘** | ⛔ 未做 | 目前只有 `project.style/scene` + 片段 `smart` 参数落盘，"为什么这么编"的自然语言备注还没有字段 | 数据模型待加（PROJECT_VERSION 3） |
| **f. 转 MIDI** | ✅ 可用 | `导出 → MIDI (.mid)`，支持全曲/循环区间；SMF format 1 | 探针 `[f]`：9039 字节、文件头 `MThd` |
| **g. 局部迭代修改** | 🟡 部分 | 片段级：智能片段「换一个变奏」、`variation` 接口按 seed 重生成、AI Agent 37 个编辑工具、快照撤销；音频级：无 | 探针 `[g]`：一次变奏命中 33 个智能片段；UI「换一组进行」也是一步可撤销 |
| **g. 音频局部重绘（repaint）** | ✅ 可用（P2） | 音频片段右键「局部重绘…」：选区间 + 描述 → sft 基座重绘，产物整段替换为新 take（原版本保留，「切换版本」可回退） | `verify_p2_repaint.mjs` 5/5（区间内差异 0.168 vs 区间外 0.012）；`verify_p2_ui.mjs` 6/6 |

---

## 2. Studio 的目标形态（与现有产品的关系）

```
控制面：网页 DAW（已有：工程 / 轨道 / 时间轴 / 钢琴卷帘 / 混音器 / 导出）
   │  REST + WebSocket（已有 REST；WS 未做）
   ▼
数据面：Companion（未做）
   ├─ 本地 ACE-Step 1.5（已有独立部署 + LoRA 训练/推理脚本）
   ├─ 模型管理器（本轮已做：清单 + 兼容性校验 + /api/adapters）
   └─ 音频资产（数据模型 v2 已支持 AssetRef/AudioClip；播放链路未接）
```

- **现在**：所有 a–g 的"符号域"（MIDI/编曲/和声）能力都在浏览器 + 本地 Node 里跑，无需 GPU、无需联网。
- **下一步**：把 ACE-Step 音频生成接成"分轨/片段级资产"——这才是用户直觉里的 Studio（像 Suno Studio / ACE Studio）。
  `docs/STUDIO_ARCHITECTURE.md` 已有完整设计（Worker 协议、资产回传、编辑期融合），本轮补了它缺的两块地基：
  适配器管理 + 创作入口。

---

## 3. 路线（按"能立刻用"排序）

| 阶段 | 内容 | 依赖 | 预估 |
|---|---|---|---|
| **P0（已完成）** | 9 风格体系、风格/用途向导、和弦进行灵感、MIDI 导入、创作信息展示、模型管理器 + 适配器实测、**AI 混音（MIDI 域）** | 无 | — |
| **P1 音频进工程** | `AudioClip` 波形渲染 + 播放（Tone.js 双引擎）+ 导入音频切片；Companion 进程骨架 + `/api/companion/*` 任务信封；ACE-Step 生成 stem 写回工程 | 本机 GPU（已有 23.9GB） | 3–5 天 |
| **P2 音频域处理 + 局部重绘** | ✅ 局部重绘完成（sft + 区间 + take 版本）；❌ 音频域混音（EQ/压缩/总线链）未做；❌ 多任务并发/优先级未做 | 已完成部分无需新依赖 | — |
| **P3 分发与协作** | 云端训练（可选，适配器 20–44MB 比基座小两个数量级）、NAS 共享适配器目录、VST3 | 授权数据 | 2–3 周 |

> 关键取舍：MIDI 域 AI 混音（P0）解决"推子怎么摆"，音频域处理（P2）才解决"听起来像成品"；
> 没有 P1 的音频资产，EQ/压缩/侧链无从谈起。

---

## 4. 现在怎么验收（自己跑一遍）

```bash
# 1) 起产品（已构建好）
node scripts/start.mjs          # 打开 http://127.0.0.1:8787

# 2) 手工验收路径
#    文件 → 新建工程…（选 日式摇滚 → 日摇 OP → 生成工程）
#    看轨道头第三行：风格 · 用途 · 调式 · BPM · 段落
#    智能片段 → 和弦进行 → 换一组进行 → 点一条应用
#    文件 → 导入 MIDI… → 选一个 .mid
#    混音器 → AI 混音… → 预览方案 → 应用（⌘Z 撤销）
#    导出 → MIDI

# 3) 自动验收
node music-gen/tools/e2e_api_probe.mjs              # 12 项能力探针
node music-gen/tools/verify_studio_ui.mjs           # Studio UI 断言 + 截图
node music-gen/tools/verify_mix.mjs                 # AI 混音引擎 10 项
node scripts/verify-ui.mjs                          # 既有功能 30 项回归
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p apps/server/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit
```

---

## 4.5 P1 进展（2026-11-09 实测）

P1（音频进工程）分三段，本轮完成前两段的地基：

| 段 | 内容 | 状态 |
|---|---|---|
| P1-a Companion 协议 | `scripts/companion.mjs`：register → heartbeat → claim → progress → complete；mock 与 ACE-Step 两种执行器；断线退避、token 失效自动重注册、子进程回收 | ✅ 端到端通过（`verify_p1_companion.mjs` 5/5） |
| P1-b 资产库 | `POST /api/assets/upload`（WAV → 峰值 + sha256 去重）、`GET /api/assets/:id/peaks`、`GET /api/assets/:id/file`；`data/assets/` 落盘 | ✅ `verify_p1_api.mjs` 9/9 |
| P1-c 真实生成 | Companion 调本地 ACE-Step C++（`ace-server`）→ 生成 WAV → 上传入库 | ✅ **真 GPU 实测**：20s 片段 48 秒完成（含引擎冷启动 36s），产物 20.00s / 48kHz / 立体声 / 882 个非零峰值 |
| P1-d 前端接入 | 导入音频（WAV）/ 波形轨道 / 随走带播放 /「AI 生成音频」面板（真实任务 → 自动上轨）/ Companion 在线徽标 | ✅ 真机验收 `verify_p1_ui.mjs` 5/5（含真实 GPU 生成 8s 音频上轨） |

**关键数字**：冷启动 ~36s（模型加载），20s 音频生成 ~12s；单次任务后引擎退出（P2 再做常驻/亲和性）。
协议文档见 `docs/COMPANION.md`。

---

## 4.6 P2 进展（2026-11-09 实测）

| 项 | 状态 | 证据 |
|---|---|---|
| 常驻引擎（跨任务复用 + 按变体切换 turbo/sft + 空闲退出 + 崩溃重启） | ✅ | 真机：任务 1（冷启动）15.2s → 任务 2（复用）**2.1s**；状态接口报 `engine.variant=turbo warm=true` |
| 真取消（中止 /synth + 杀引擎 + 下一任务重启） | ✅ | 40s 长任务运行中取消 → `failed 用户取消`，随后 4s 任务正常完成 |
| repaint 局部重绘（sft 基座，区间 + 描述） | ✅ | 12s 源音频 3–7s 重绘：时长不变、**区间内峰值差异 0.168 vs 区间外 0.012**（14 倍） |
| LoRA 接进生成路径 | ✅ | 任务参数 `adapterId` 经模型管理器校验（基座不匹配/审计失败直接 400），Companion 以 `--lora <path>` 启动引擎 |
| 前端：局部重绘对话框 + take 版本切换 | ✅ | 真机 `verify_p2_ui.mjs` **6/6**：真实 repaint → takes=2 → 切回原版本，全程一次撤销/步 |
| 服务端契约校验 | ✅ | 7 条校验用例：缺 sourceAssetId / 资产不存在 / 区间非法 / 区间超时长 / turbo-LoRA 用于 sft-repaint / LoKR 用于生成 → 400；合法任务无节点 → 503 |

**P2 边界**：repaint 产物是**整段替换**（区间外由模型重建保持连续），不是拼接；进度是耗时估算不是真实分段；
单任务串行（无优先级/并发）；音频域 EQ/压缩/总线处理仍未做。

---

## 4.7 P3 进展（2026-11-09 实测）

| 项 | 状态 | 证据 |
|---|---|---|
| 音频域处理链（三段 EQ + 压缩 + 补偿增益） | ✅ | 引擎每轨 `dry → lowShelf → peaking mid → highShelf → compressor → makeup → channel`；`verify_mixchain.mjs` 11/11 |
| AI 混音面板接入（勾选应用 / 逐轨摘要 / 清除） | ✅ | 真机 `verify_p3_ui.mjs` **7/7**：12 轨写入、引擎 `__debugChain` 节点真值逐轨一致（例：主旋律 mid 3000Hz +2dB、压缩 -15.88dB 3.41:1）、一步撤销、清除后 bypass、⌘Z 恢复、1024px 无溢出 |
| 处理链数据落盘 | ✅ | `Track.mixChain` 可选字段（老工程不受影响），随工程保存/读取 |

**P3 边界（已由 P3.1 修复）**：SoundFont 采样音源原本走独立通路（spessasynth → mixBus），不经过每轨处理链；
P3.1 已改为逐通道路由（见 §4.8），仅当采样轨 >16（通道冲突）时回退全局输出。

---

## 4.8 P3.1 进展（2026-11-09 实测）

**目标**：让 SoundFont（采样音源）也经过每轨处理链。**已打通**，过程中发现一个隐蔽的浏览器行为坑。

| 项 | 结果 |
|---|---|
| 逐通道路由 | ✅ `mode=per-channel`，7 轨 / 7 唯一通道 / 主输出关闭；>16 条采样轨因通道共用回退 `global` |
| 处理链作用到采样轨 | ✅ 极端 EQ/压缩（三段 -18dB + 20:1）后 master **0.51 → 0.00**；清除后回到 0.51 |
| 推子/静音 | ✅ 推子 0.002 → 0.51 → 0.31；全静音 → 0.00 |
| 回归 | `verify_p3_1_ui` 6/6；`verify_p3_ui` 7/7；`verify-ui` 30/30；`verify_studio_ui` 12/12；三包 tsc 全绿 |

**根因（值得记住）**：Chrome/Edge 的 `DynamicsCompressorNode` 有**非规范的自动补偿增益**（与输入电平无关）：
- `threshold=-50 / ratio=20` → 约 **+28.9dB**
- `-18dB / 4:1` → 约 +8.6dB；`-24 / 12` → 约 +13.6dB

EQ 在压缩之前时，-18dB 的 EQ 衰减会被这 +29dB 补回来 → 节点值全对、听感却没变化。
修法：用 `OfflineAudioContext` 现场标定该浏览器的补偿量（按 threshold/ratio/knee 缓存），在 `makeup` 节点上抵消，
使 core 的 MixChain 按「标准无补偿压缩 + 显式 makeupDb」语义工作；标定失败则按 0 处理（安全 no-op）。
同时把采样轨的 send 抽头从「链前」改为「链后」（`postSend` 门控），避免未处理信号混入。

**行为变化**：抵消自动增益后，启用压缩的轨会比浏览器「自动拉响」的版本**安静**（这是标准压缩语义；
若产品要保留自动增益，需要 core 的 MixChain 增加显式 `outputMakeup` 参数）。

---

## 4.9 P3.2 进展（2026-11-09 实测）

**目标**：总线 / 母带处理链（总线 EQ + 母线压缩 + 限幅上限），让整首"粘合、响而不糊"。

| 项 | 结果 |
|---|---|
| 引擎总线图 | ✅ `mixBus → busEqLow → busEqMid → busEqHigh → busComp → busMakeup → masterGain → limiter → destination`（合成器/音频片段/SoundFont 全部经过） |
| 浏览器自动补偿 | ✅ 复用 P3.1 的 `DynamicsCompressorNode` 自动增益标定（同缓存），母线压缩同样抵消 |
| 限幅上限 | ✅ `limiterCeilingDb` 写入 limiter（默认 -1dBFS） |
| UI | ✅ AI 混音面板第三块「总线 / 母带处理」：开关默认勾选、逐行摘要、一次 mutate 同时写推子+每轨链+母带链、可单独清除 |
| 真机验收 | ✅ `verify_p3_2_ui` **8/8**：节点真值一致（阈值 -20.9dB / 1.98:1 / 限幅 -1dBFS / 自动补偿 9.8dB）；极端母线链 master **0.31 → 0.02**，清除后 0.27 回到基线；1024px 无溢出 |
| 回归 | P3.1 6/6、P3 7/7、Studio 12/12、既有 UI 30/30、引擎 10 套全绿、API 探针 12/12、三包 tsc |

**边界**：母线压缩同样抵消浏览器自动增益，因此启用后整体电平比"浏览器自动拉响"的版本低（标准压缩语义）；
节拍器直连 masterGain，不经过母线链（避免点击声被 EQ/压缩改变）；侧链压缩、多段动态、真母带渲染仍未做。

---

## 4.10 P4 进展（2026-11-09 实测）

**目标**：任务队列的优先级、排队可见性、多 worker 能力匹配（"哪台机器能跑什么"）。

| 项 | 结果 |
|---|---|
| 优先级 | ✅ 任务 `priority` 0 普通 / 1 高 / 2 紧急；派单按「优先级降序 → 入队时间」；非法值 400 |
| 排队位置与 ETA | ✅ `GET /tasks/:id` 与 `/status` 返回 `queuePosition`、`estimatedWaitSec`（按最近同类任务平均耗时估算，跑完记录 `durationMs`） |
| 能力匹配 | ✅ 任务带 `requiredVariant`（generate→turbo / repaint→sft）；worker 注册上报真实 GGUF 变体（mock 上报 turbo+sft）；不匹配的任务不会被派单，`blockedByCapability` 会告诉 Companion 缺哪个变体 |
| Companion | ✅ 真实能力扫描 + 认领日志带 priority/requiredVariant；空闲时 30s 节流查询队列缺口并中文提示 |
| 任务中心 UI | ✅ TopBar「任务中心」：队列概览（普通/高/紧急）、每行状态/优先级徽标/排队位置/ETA/取消、产物定位、离线/空态、2s 轮询；生成/重绘面板加优先级下拉 |
| 真机验收 | ✅ `verify_p4_api` **7/7**（优先级排序 pos 0/1/2/3、能力匹配 sft worker 只领 repaint、turbo worker 按 紧急→高→普通、durationMs）；`verify_p4_companion` **5/5**（能力上报 turbo+sft、完成顺序 urgent≤high≤normal）；`verify_p4_ui` **6/6**（队列概览/取消/完成刷新/1024px/优先级提交=2） |
| 回归 | Studio 12/12、既有 UI 30/30、引擎 12 套全绿、API 探针 12/12、三包 tsc |

**边界**：单 worker 仍是"领一个跑一个"（并发靠多台机器＝多 worker，不是一个 worker 内并行）；ETA 是估算不是精确调度；
任务历史只保留最近 200 条 / UI 展示 20 条；没有任务持久优先级抢占（运行中任务不会被更高优先级打断）。

---

## 4.11 P5 进展（2026-11-09 实测）：分轨 Stem（lego/base）

**目标**：补上 a 的最后一块——音频分轨（每个乐器一条音频轨）。

| 项 | 结果 |
|---|---|
| 引擎可行性 spike | ✅ C++ `lego` 必须用 **base** 基座；20s 源、base 冷启动 **35.9s**、单 arm 1.7–14.5s；输出 20.00s/48k/2ch |
| 输出语义（重要） | **是该 arm 独立生成的 stem，不是"源+stem"混音**：guitar stem 质心 2035Hz/低频 0.012，源曲 1036Hz/0.35；**不保证与源逐样本对齐或相加还原** |
| 服务端 | 新任务类型 `generate_stem`（`requiredVariant=base`）；arm 白名单 7 个；非法参数 400；适配器基座校验沿用（turbo LoRA 不能用于 base 任务） |
| Companion | 能力上报 `generate_stem` + models 含 base；EngineManager 支持 base 变体（换变体重启、冷启动提示）；执行器 lego multipart + 源资产下载；`--mock` 返回 mock WAV |
| 前端 | 音频片段右键「生成分轨 Stem…」：7 个 arm 多选、每 arm 可选描述/seed、优先级；每个任务完成 → **新建独立音频轨**（对齐源片段 startBeat、命名 `${源} · ${arm}`、provenance 记 arm/sourceAssetId）；对话框明确标注"独立生成、不保证逐样本对齐/相加还原" |
| 真机验收 | ✅ `verify_p5_api` 5/5（校验/入队/base 派单/完成入库/能力跳过）；`verify_p5_stem` **5/5**（真实 GPU：3 arm 全部完成，时长与源一致，质心 2432/1850/3532Hz 两两差 ≥582Hz）；`verify_p5_ui` **6/6**（对话框/红线文案/3 轨自动落轨/1024px） |
| 回归 | Companion 自检 **83/83**、引擎 13 套全绿、API 探针 12/12、Studio 12/12、既有 UI 30/30、三包 tsc |

**边界（产品文案已写入 UI，不夸大）**：lego 生成的是"按原曲上下文独立生成的 stem"，**不是分离音轨**；
不保证与源音频样本级对齐，也不保证多条 stem 相加还原原混音；base 冷启动慢（约 36s，之后热复用 2–20s/条）；
stem 落轨只在对话框打开期间自动完成，关闭后任务在服务端继续。

---

## 4.12 P6 进展（2026-11-09 实测）：同步 / VST3 / 音频进阶 / 真实数据

### ① 云端 / NAS 同步（✅ 完成）
- `POST /api/sync/export`（下载或 `save` 到 `<DATA_DIR>/sync`）、`POST /api/sync/import`（multipart 或 `{path}` 目录/包）、`GET /api/sync/status`（DATA_DIR/UNC、可写性、工程/资产/适配器占用）。
- 包格式：真 ZIP `.aiabsync`（`manifest.json` + `projects/` + `assets/`，逐文件 sha256 校验），零新增依赖（复用仓库零依赖 zip 写 + 新写 zip 读）。
- 冲突策略：资产按 sha256 去重 + 工程内 AssetRef 全部重写；工程规范化哈希幂等；同 id 内容不同 → 新 id +「同步副本」，绝不覆盖；导入台账保证重复导入幂等。
- 验收：`verify_sync.mjs` **17/17**；真实 8899 导出 10 轨工程 + 1.5MB 资产 → 临时数据面导入一致、重复导入幂等。
- 文档：`docs/SYNC.md`（单机/NAS/两机拓扑、包格式、冲突、CLI、安全）。

### ② VST3 插件（🟡 设计 + 服务端桥接完成，插件本体未编译）
- 服务端桥接已实现并验收：`GET /api/vst3/hello`、`POST /api/vst3/generate`、`GET /api/vst3/tasks/:id`（只下发插件字段）、cancel、`/assets/:id`（WAV + `?peaks=1`）；`verify_vst3_bridge.mjs` **6/6**。
- 插件：`plugin/`（CMake + JUCE 8 + Processor/Editor + BridgeClient 脚手架），**本机无 cmake/MSVC/JUCE，未编译**；设计与构建说明见 `docs/VST3_PLUGIN.md`。
- 形态决策：瘦客户端（HTTP → 本地服务 → Companion GPU），不把模型塞进 DAW。

### ③ 音频域进阶（✅ 完成）
- 三段总线压缩：`busEqHigh → mbInput → {LP200 | HP200→LP3000 | HP3000} → 各段压缩+自动补偿 → mbSum → busComp`，常驻旁路 0/1 交叉切换；参数 `masterChain.multiband`。
- 侧链 ducking：每轨 `makeup → duckGain → channel`，源轨包络驱动 attack/release；参数 `mixChain.duck`。
- 导出：`render.ts` 离线重建每轨链 + 母线链（含 multiband/duck/limiter），导出与实时一致。
- 验收：`verify_p6_audio.mjs` **4/4**：极端三段压缩 master **0.43 → 0.05**、关闭回 0.32；duck -24dB 实际 gain **0.063–1.000**、master 0.447→0.410；AI 混音面板两个开关一次撤销。

### ④ 真实数据 LoRA（✅ 2026-11-10 完成）
- 用户本地库（`D:\AI Project\MusicGen`，只读）：`real_jrpg_v1` = 40 曲 × 2 段（40 个不同游戏 / 17 位作曲家），`real_jrock_v1` = 40 曲 × 2 段（14 支乐队，含 STRAIGHTENER / ONE OK ROCK 等）；各 80×60s、48k/2ch、audit 0 错；numpy 自实现 BPM/调性估计，caption 按年代/作曲家/乐队生成。
- **训练**：两套各 100 epoch / rank 32 / 8000 步（rank 32，alpha 128）；final loss **0.8033**（jrpg）/ **0.9028**（jrock），各 42.1MB。
- **C++ 实测**：两个适配器均 384 tensors、`Merged 192 pairs (skipped 0)` → `verified.json` 写入；`GET /api/adapters` nativeReady 含 `real_jrpg_v1` / `real_jrock_v1`（6 个适配器 / 5 个可上运行时）。
- **A/B 客观指标**（同 seed 开/关适配器，30s×3 场景）：

| 数据集 | 场景 | 波形相关 | 频谱距离 | 质心 Hz | RMS dBFS | 峰均比 |
|---|---|---|---|---|---|---|
| real_jrpg_v1 | battle | 0.334 | 0.518 | 1203→1416 | -21.3→-16.4 | 18.6→14.8 |
| real_jrpg_v1 | sad | 0.453 | 0.607 | 628→866 | -20.7→-14.1 | 17.5→12.6 |
| real_jrpg_v1 | town | 0.391 | 0.488 | 849→1252 | -19.0→-16.7 | 16.9→15.8 |
| real_jrock_v1 | wado90 | 0.344 | 0.376 | 2553→2928 | -15.7→-13.0 | 14.8→11.8 |
| real_jrock_v1 | posthard | 0.162 | 0.604 | 2317→2482 | -19.1→-16.3 | 16.8→15.9 |
| real_jrock_v1 | animeop | 0.300 | 0.505 | 1692→1907 | -20.2→-15.1 | 18.8→13.7 |

  （corr 0.16–0.45 = 保留结构但改变音色/编配；质心上升 = 更亮；RMS 上升/峰均比下降 = 更响更压。**听感需人耳**，对比页在 `music-gen/lora-data/ab/<tag>/listen.html`。）
- **权利**：`user-provided commercial recordings; internal research only — DO NOT DISTRIBUTE`，`native_ready_allowed: false`；**不得进入产品分发**。
- 已知数据问题：JROCK 片段含人声但标 `[Instrumental]`（可能学成"人声当器乐"）；BPM 为自相关估计（置信度记入 manifest）；7 支乐队目录当前无音频，补全后可重跑 `build_real_dataset.py`。

---

## 4.13 P6.1 进展（2026-11-10 实测）：生成音频"闷"的根因修复

**现象（用户真机听感）**：生成的音频中高频被削弱、像低码率压缩过。

**根因**：产品 Companion 的 `generate_audio` 请求里 `shift: 3.0`（repaint/stem 用的是 1.0）。`shift` 控制噪声调度，
`3.0` 在 8 步 turbo 下导致高频几乎不被还原：
- J-Rock 输出最高能量频率只有 **7048Hz**，8–16kHz 能量 **0.6%**；
- 对照真实音乐片段：**15046Hz / 9.9%**。

**修复**：`scripts/companion.mjs` 的 `generate_audio` shift 改为 **1.0**（与 repaint/stem 一致）。
产品真实链路验证：最高能量频率 **7048Hz → 15503Hz**，8–16kHz 能量 **0.6% → 6.8%**（J-Rock seed 6101 对照）。

**对比页**：`music-gen/lora-data/quality-matrix/fixed.html`（旧 shift3 / 新 shift1 / LM+sft50 质量档 / 真实片段）；
A/B 脚本与质量矩阵脚本也已同步修正 shift（之前它们也用 3.0，导致所有对比音频都闷）。

**遗留**：若 shift=1.0 仍达不到听感要求，下一步把 `LM → sft 50 步` 做成产品质量档，并在混音链上做高频补偿（而不是继续改模型参数）。

---

## 4.14 P7-A 进展（2026-11-10 实测）：质量模式（LM → sft 50 步）进产品

**背景**：用户真机确认 `LM → sft 50 步` 质量档符合需求；产品之前只有 turbo 8 步快模式。

| 项 | 结果 |
|---|---|
| Companion | ✅ `EngineManager` 支持 `--lm`（引擎身份含 LM，切换重启）；`generate_audio` 支持 `params.quality=true` → `/lm` → `/synth`（固定 50 步 / guidance 1.0 / shift 1.0）；与 turbo LoRA 适配器互斥 |
| 关键参数发现 | ✅ `/lm` 请求只给 `caption+lyrics+duration`（让 LM 推断编曲参数）；带上 bpm/keyscale 会回显并生成更暗的编曲（频宽 9205Hz vs 13482Hz） |
| 服务端 | ✅ `quality` 布尔校验；quality 任务 `requiredVariant='sft'` |
| 前端 | ✅ 生成面板「质量模式（LM → sft 50 步）」开关（`data-quality-toggle`），勾选后禁用适配器 |
| 真机验收 | ✅ Companion 自检 **87/87**；质量档真机 **5/5**（wall 21–24s，频宽截止 **13482Hz**，8–16k **5.0%**）；UI **4/4** |
| 代价 | 20s 音频约 15–25s（快模式 2–10s）；显存需同时容纳 LM(1.84GB)+sft(2.37GB)+VAE |
| 过程产物 | `music-gen/lora-data/P7_PROGRESS.html`（随时试听）+ `docs/P7_PROGRESS.md`（阶段记录） |

---

## 4.15 P7-B 进展（2026-11-10 实测）：MIDI/工程 → cover（AI 渲染成歌）

| 项 | 结果 |
|---|---|
| 服务端 | ✅ 新任务类型 `cover_audio`（源资产 + caption + `audioCoverStrength` 0–1）；`requiredVariant=turbo`；非法参数 400 |
| Companion | ✅ `validateCoverParams` / `buildCoverRequest`；执行器下载源（只读）→ turbo → multipart（cover strength + 8 步 / guidance 1.0 / shift 1.0）；产物 `cover-*.wav`；mock 支持 |
| 前端 | ✅ 生成面板「AI 重编（cover）」：`engine.renderToWav` 离线渲染当前工程 → 上传资产 → cover 任务 → 新音频轨（不改原 MIDI）；「贴近原结构」0–1 滑杆默认 0.7 |
| 真机验收 | ✅ Companion 自检 **90/90**；API **4/4**；真机 GPU **5/5**（wall 17–21s、时长一致、corr 0.406、频宽 15756Hz、源 sha 未变）；UI **4/4** |
| 产物 | `music-gen/lora-data/quality-matrix/p7b_cover_demo.wav`；进度页 http://127.0.0.1:8908/P7_PROGRESS.html |

**边界**：cover 走 turbo 快模式（8 步），质量档 cover 未开放；strength 越高越贴近原结构；"迭代加轨"= 对成品再跑 lego stem / repaint / cover 组合。

---

## 4.16 P7-C 进展（2026-11-10 实测）：和弦进行补全

| 项 | 结果 |
|---|---|
| core | ✅ `completeProgression`：按最后和弦功能接续；古典 V–I / 爵士 ii–V–I+七和弦 / J-Rock·JRPG IV–V–I 拱形；不足目标长度用循环延长并保证收 V–I；输出终止式+可解释原因 |
| 服务端 | ✅ `POST /api/suggest/complete-progression`（缺 partial/非法罗马数字 → 400 中文） |
| 前端 | ✅ 智能片段面板「补全进行」：前缀输入 + 长度 4/8/16 → 结果展示 → 「写入工程和弦」（一次撤销，跟随和弦片段自动重算） |
| 验收 | ✅ core+API **6/6**（长度/前缀/确定性/风格差异/边界/400）；UI **5/5**（示例 `I V vi IV` → `I · V · vi · IV · V · I · V · I`，写入 8 和弦，1024px 无溢出） |

**边界**：规则 + 风格倾向的确定性补全（非模型生成）；调内罗马数字为主；目标长度 ≤32；默认收 V–I（需要半终止可手动改末尾）。

---

## 4.17 P7-D 进展（2026-11-10 实测）：简谱导入 → MIDI

| 项 | 结果 |
|---|---|
| core | ✅ `parseJianpu`：头信息（1=C / 4/4 / ♩=120 / T:标题）、1–7 音符（0 休止）、`'`/`,` 八度、`#`/`b` 升降、`/` 减半、`.` 附点、`-` 延长、`~` 连音、`|` 小节线；warning 不中断；`jianpuToProject` 生成单旋律轨工程 |
| 前端 | ✅ 文件菜单「导入简谱…」→ 弹窗粘贴 → 导入并替换工程（空文本不替换；成功 toast 摘要+警告） |
| 验收 | ✅ core **10/10**（音高/八度/升降/时值/连音/休止/小调/警告/工程/错误/确定性）；UI **4/4** |
| 端到端 | ✅ 简谱《小星星》→ 旋律轨 → 渲染 → cover 成歌：`quality-matrix/p7d_jianpu_cover_demo.wav`（进度页可试听） |

**边界**：只生成单旋律轨（配器走场景编曲或 cover）；`1=` 支持大调（minor 用 scale 选项）；三连音/自由延长等复杂记谱不支持（warning 跳过）。

---

## 4.18 P7-E 进展（2026-11-10 实测）：一键「整曲 + 分轨 Stem」工作流

| 项 | 结果 |
|---|---|
| 前端 | ✅ 生成面板「一键整曲 + 分轨 Stem」：选乐器（7 种/默认 3）+ 质量模式复用 + 优先级；先 `generate_audio` 落整曲轨，再以整曲为源逐条 `generate_stem`（base/lego）落独立 Stem 轨；面板显示每步状态/进度；每步落轨独立撤销 |
| 服务端/Companion | ✅ 复用既有任务类型与队列（优先级/取消/能力匹配），无新协议 |
| 验收 | ✅ 工作流 UI **4/4**（mock：先整曲后 3 分轨、sourceAssetId 正确、自动 1+3 轨、无 console）；真实 GPU 端到端：质量整曲 **29s** + 吉他/鼓 stem 各 **29s**，频宽 18–19kHz，全部自动落轨 |
| 产物 | `quality-matrix/p7e_song.wav`、`p7e_stem_guitar.wav`、`p7e_stem_drums.wav` |

**边界**：整曲时长用 Companion 默认（30s，工作流暂未接时长字段）；stem 是 lego 独立生成非分离；整曲→分轨触发引擎切换（sft+LM → base 冷启动 30–40s）。

---

## 5. 已知限制

1. **MIDI 导入**：SMPTE 时间码、format 2 不支持（明确报中文错误）；工程只保留单 BPM（首个 tempo 事件），后续变速忽略。
2. **AI 混音**：推子 + 每轨 EQ/压缩（合成器、音频片段、SoundFont 采样全覆盖）+ 总线/母带链（总线 EQ + 母线压缩 + 限幅）已做；**侧链压缩、多段动态、真母带渲染**仍未做；采样轨 >16 条时回退全局输出（不经每轨链）。
3. **音频迭代**：局部重绘已可用（整段替换 + take 版本），但不支持"只拼接区间"；重绘区间外由模型重建。
4. **任务调度**：单任务串行，无优先级/并发；进度是耗时估算，不是引擎真实分段回调。
5. **音频格式**：资产库 P1 只收 WAV（ACE-Step 输出即 WAV）；MP3/FLAC 需先转码。
6. **变速**：`stretchRatio` 字段已就位但固定为 1；保音高变速需要 phase vocoder（一期不做）。
7. **页面级验收**：headless Chrome 覆盖 1440 / 1024 两档；更细的视觉回归（125% 缩放、超宽屏）仍未做。
8. **风格上限**：声学风格仍然受限于基座模型 + 自生成数据（见 `docs/LORA_FINETUNING_PLAN.md` §11），换成合法真实音频后需重训。
