# Studio 分布式架构设计（NAS 控制面 + 客户端数据面）

> 日期：2026-11-08
> 状态：**已拍板（2026-11-08）**，决策见 §0.5
> 关联：`docs/ARCHITECTURE.md`（现有单机形态）、`docs/MUSIC_GEN_MODEL_EVALUATION.md`（模型选型）、`docs/FUSION_ROADMAP.md`（符号域路线）

---

## 0. 结论摘要

1. **N100 NAS 跑不动音频生成，但能跑 Agent 和 MIDI 引擎**——所以拆成"控制面 / 数据面"是对的，不是妥协。
2. NAS 负责：身份、工程存储、Agent 运行时、配额与计费、模型清单签名、分享。
3. 客户端 Companion 负责：模型推理、混音渲染、VST 宿主（未来）、本地模型库。
4. **权重不打包进安装包**，只打包运行时（`ace-server` GGML 二进制，几十 MB）；权重首次使用时下载，**NAS 兼做局域网模型镜像**（关键优化）。
5. 编辑器从"纯 MIDI"升级为"MIDI + 音频双轨模型"：新增 `AudioClip` / `Take` / `Provenance`，`PROJECT_VERSION` 升到 2。
6. Agent 仍是唯一入口，但工具要**按成本分层**：L1 MIDI 工具廉价可随意调，L3 音频生成必须"先出预算、用户确认"。
7. **战略提醒**：如果 VST 是硬需求，浏览器承载不了，最终客户端必须是原生宿主（JUCE/Tauri + 原生音频）——这会影响现在要不要把音频引擎迁出 WebAudio。

---

## 0.5 决策记录（2026-11-08 拍板）

| # | 议题 | 决定 | 对设计的影响 |
|---|---|---|---|
| **D1** | 部署形态 | **先做形态 B（单机）**，形态 A（NAS 多设备）后置 | 首发不带 NAS 依赖：Companion 内嵌 server，浏览器打开 localhost。**但 Worker 协议仍按 A/B 通用设计**，先只接本地 worker——否则将来上 A 要重写 |
| **D2** | 资产驻留 | **local 默认 + 可选云自动同步** | `AssetRef.residency` 默认 `local`；云同步是账号级开关，后台增量分片上传；关网可用 |
| **D3** | 模型档位 | **按硬件检测推荐**（可覆盖） | 模型管理器探测 显存/内存/后端 → 推荐 Lite/Standard/HQ，并把检测结果下发给 UI（让用户知道为什么推荐这一档），同时参与后续 ETA 估算 |
| **D4** | Agent L3 确认 | **默认每次确认**；Pro/信任模式可关 | 默认流程输出 `AudioPlan` 预算卡片等用户确认；信任模式必须有单次/单日上限，不能无限制 |
| **D5** | VST | **排进路线（P3）** | P3 评估原生壳（Tauri/Electron）+ 原生音频引擎；另外 ACE 官方 VST3 可直连 `ace-server`，可做"外部 DAW 桥"复用现有能力 |

**D1 带来的三条硬约束（写设计时要守住）：**
1. 形态 B 下"客户端"就是本机：Companion 起本地 server + 本地 worker，UI 走 localhost。但**接口一律走 HTTP/WS，不调用进程内函数**，否则将来上 A 要重写。
2. 云同步必须**可选且增量**：默认不传；开启后按需上传（分片 + 断点 + 内容哈希去重）。
3. 硬件检测结果要落库（`deviceProfile`），既用于推荐档位，也用于"这个用户能不能跑 HQ"的售前判断。

---

## 1. 为什么必须拆：N100 的能力边界

| 任务 | 能不能在 N100 上跑 | 依据 |
|---|---|---|
| Fastify 服务 / Agent 循环 / SSE | ✅ 轻松 | 纯网络 IO + 轻 CPU |
| MIDI 生成（`packages/core` 纯函数） | ✅ 毫秒级 | 无模型，纯计算 |
| 工程存储 / SQLite / 静态资源 | ✅ | — |
| 和弦/拍点分析（模型法） | ⚠️ 勉强（CPU 秒级，占核） | BTC/beat_this CPU 可跑但吃满 4 核 |
| **ACE-Step 音频生成** | ❌ | 需 4–20GB VRAM + 高带宽显存；N100 iGPU 共享 DDR5 内存 |
| **VAE 解码 / 分轨 / LoRA 训练** | ❌ | 同上，且训练需 16–20GB |
| VST 插件宿主 | ❌ | 需要原生音频栈 + 低延迟驱动 |

实测参考（本机 RTX 5090 24GB）：ACE-Step XL-SFT 单首 100–150s 曲目耗时 42–61 秒、峰值 9.83–10.08GB 显存。**显存带宽差 30–50 倍**，N100 即便勉强跑 2B 量化模型也是"几十分钟一首"，产品体验不成立。

**所以不是"N100 跑不动所以退而求其次"，而是产品本来就该是"服务端编排 + 端侧推理"**——这也正好是商业化（账号、配额、订阅）需要的位置。

---

## 2. 目标拓扑：三种部署形态

```
形态 A（默认 / 商业化）
┌──────────── NAS (Docker, N100) ────────────┐        ┌──── 用户客户端 (Win/Mac) ────┐
│ Web App (静态) · Fastify API · SQLite      │  WSS   │ Companion 守护进程            │
│ Agent 运行时 · LLM 代理 · 配额计费          │◄──────►│  · ace-server (GGML: Metal/  │
│ 工程库 · 资产元数据 · 模型清单(签名)        │  HTTPS │    CUDA/Vulkan/CPU)          │
│ 局域网模型镜像                             │        │  · 模型库 · 混音渲染          │
└────────────────────────────────────────────┘        │  · VST 宿主（未来）           │
              ▲                                       └──────────────────────────────┘
              │ 浏览器 / 桌面壳
        ┌─────┴─────┐
        │  DAW UI   │
        └───────────┘

形态 B（单机 / 不想用 NAS）：Companion 内嵌同一套 server，localhost 访问，功能等价。
形态 C（降级）：纯浏览器、无 Companion → 只有 MIDI 域功能 + 云渲染（付费排队）。
```

| | **形态 B（首发）** | 形态 A（后续） | 形态 C（降级） |
|---|---|---|---|
| Agent 运行位置 | 本机 server（Companion 内嵌） | NAS | NAS |
| 推理位置 | 同一台机器（本地 GPU/CPU） | 客户端 GPU | 云端 GPU |
| 工程存储 | 本地磁盘 + 可选云同步 | NAS | NAS |
| 适用 | **首发：单机完整体验** | 多设备/团队/纯浏览器入口 | 弱设备/试用 |

三种形态**共用同一套协议**（HTTP + WSS job），只是 worker 的实现位置不同——这是设计上的关键收益。

> 首发（D1）只依赖形态 B：`Companion = 本地 server + 本地 worker`，浏览器打开 `http://127.0.0.1:<port>`。
> 因为接口全部走 HTTP/WS，将来接 NAS 只是把 server 换个部署位置，前端与 worker 代码不动。

---

## 3. 职责划分

### NAS（控制面，权威）
- 身份与设备：账号、设备配对、设备能力表、在线状态
- 工程：`Project` JSON 权威存储、版本历史、分享链接
- Agent：会话、快照、工具编排、LLM 调用代理（API key 不下发到客户端）
- 资产：`AssetRef` 元数据（hash/size/时长/residency），可选的 blob 存储
- 模型：签名 manifest、版本与回滚、许可证快照
- 商业：配额/credits、订阅状态、任务审计

### 客户端 Companion（数据面）
- 推理：`ace-server`（GGML，MIT），Metal/CUDA/Vulkan/CPU 自动选择
- 模型库：下载、校验、解压、按显存档位管理
- 渲染：把 MIDI 轨离线渲染成 WAV（供 lego/repaint 做 `src_audio`）
- 分析：beat/chord/MIDI 转录（可选，就近跑更快）
- VST 宿主（未来）：原生插件桥

---

## 4. Worker 协议（核心设计）

### 4.1 配对与注册
```
NAS: 用户点"连接我的电脑" → 生成 8 位配对码（5 分钟有效）
客户端: 输入配对码 → POST /api/devices/pair { code, deviceInfo }
NAS:  返回长期 device token（JWT，绑定 deviceId，最小权限）
客户端: POST /api/devices/capabilities 上报：
  { os, arch, cpu, ramGB,
    gpu: { name, vramGB, backend: 'metal'|'cuda'|'vulkan'|'cpu' },
    models: [{ id: 'acestep-2b-turbo', quant: 'Q8_0', version: '1.0.3' }],
    bench: { secPer100sSong: 38 },   // 自测，用于调度与 ETA
    diskFreeGB }
NASH: 维护 worker 表；每 15s 心跳刷新 online/lastSeen
```

### 4.2 任务信封
```jsonc
// NAS → Worker (WSS /api/worker)
{
  "jobId": "job_8f3a…",           // 幂等键，重派复用
  "type": "audio.generate",       // audio.generate | audio.lego | audio.repaint
                                  // audio.cover | audio.stems | audio.extract
                                  // chords.analyze | midi.transcribe | lora.train
  "model": { "id": "acestep-2b-turbo", "quant": "Q8_0" },
  "params": { "caption": "...", "lyrics": "", "duration": 96,
              "bpm": 112, "keyscale": "G major", "timesignature": "4/4",
              "seed": 103, "lego": null, "repaintingStart": null, "repaintingEnd": null,
              "audioCoverStrength": null },
  "inputs": [{ "assetId": "as_…", "sha256": "…", "url": "https://nas/…/mix.wav" }],
  "deadlineMs": 600000,
  "budget": { "credits": 20 }
}

// Worker → NAS（同一连接的事件流）
{ "jobId": "...", "event": "accepted", "etaMs": 45000 }
{ "jobId": "...", "event": "progress", "stage": "lm"|"dit"|"vae", "pct": 0.42 }
{ "jobId": "...", "event": "done",
  "asset": { "sha256": "…", "bytes": 18432000, "sr": 48000, "channels": 2,
             "durationMs": 96000, "name": "ai-take-1.wav" } }
{ "jobId": "...", "event": "error", "code": "OOM|MODEL_MISSING|CANCELLED", "retryable": true }
```

设计要点：
- **幂等**：worker 按 jobId 去重，NAS 断线重连后可查询/重派
- **亲和性**：同一会话优先派给同一设备（模型已加载，省 5–10 分钟冷加载）
- **取消**：NAS `POST /jobs/{id}/cancel` → WSS 下发 `cancel` → worker 终止
- **进度**：LM/DiT/VAE 三段进度，前端可显示"规划中/生成中/解码中"
- **预算**：任务创建时预扣 credits，`done` 确认，`error/cancel` 退还
- **调度**：能力匹配（模型已装 + 显存够）→ 在线 → 空闲 → 排队；无可用设备时提示"连接电脑"或转云

### 4.3 资产回传策略（三选一，按用户设置）
| 策略 | 行为 | 适用 |
|---|---|---|
| `local`（默认） | 音频留在生成设备，NAS 只存 `AssetRef` 元数据 | 省 NAS 空间与上行带宽 |
| `upload` | 完成后分片上传 NAS，跨设备可用 | 多设备/协作/云端备份 |
| `preview` | 回传 128k mp3 预览，无损留本地 | 弱网 |

---

## 5. 资产模型：`AssetRef` 与 residency

```ts
interface AssetRef {
  id: string            // as_xxx
  sha256: string
  kind: 'audio' | 'waveform' | 'midi' | 'analysis'
  durationMs?: number
  sampleRate?: number
  channels?: number
  bytes: number
  residency: 'nas' | 'client'
  deviceId?: string     // residency=client 时，哪台机器上有
  localPath?: string    // 仅客户端可见
  previewUrl?: string
}
```

铁律：**`Project` 里不存音频二进制**，只存 `assetId`。理由：
- 工程 JSON 要能秒级同步（几十 KB）
- 音频是 MB 级，塞进项目文件会毁掉版本历史与协作
- 将来换存储后端（对象存储）不动数据模型

跨设备打开缺资产时：显示"该片段由 *书房台式机* 生成（未上传）"，提供"请求上传 / 重新生成 / 仅占位"三选项。

---

## 6. 编辑器改造（Suno Studio / ACE Studio 形态）

### 6.1 数据模型变更（`PROJECT_VERSION` 1 → 2）

```ts
// 1) 轨道类型扩展
kind: 'instrument' | 'drum' | 'audio'      // 新增 audio

// 2) 音频片段（与现有 Clip 平行，避免破坏 MIDI 片段逻辑）
interface AudioClip {
  id: string
  trackId: string
  assetId: string
  startBeat: number        // 时间轴位置（拍）——与项目网格对齐
  offsetSec: number        // 从音频文件第几秒开始截取
  durationSec: number
  gainDb: number
  fadeInBeats: number
  fadeOutBeats: number
  /** 变速比：音频原始 BPM 与工程 BPM 不一致时用（1 = 不变） */
  stretchRatio: number
  muted: boolean
  color?: string
}

// 3) Take：同一轨的多个生成版本
interface Take {
  id: string
  trackId: string
  clipId: string
  label: string            // "Take 1 · jrpg_battle"
  provenance: Provenance
  createdAt: number
}

// 4) 溯源（产品功能 + 合规要求）
interface Provenance {
  modelId: string          // acestep-2b-turbo
  checkpoint: string       // acestep-v15-turbo
  seed: number
  prompt: string
  params: Record<string, unknown>
  loraIds: string[]
  sourceAssetIds: string[] // lego/repaint 的输入
  deviceId: string
  license: string          // 'MIT'
  licenseSnapshotAt: string
  createdAt: number
}

// 5) 分析结果（供和弦车道 / 对齐使用）
interface BeatAnchor { beat: number; sec: number }
interface AnalysisRecord {
  assetId: string
  bpm?: number
  key?: string
  timeSignature?: string
  beatAnchors?: BeatAnchor[]
  chords?: { startBeat: number; endBeat: number; symbol: string; confidence: number }[]
  source: 'acestep-understand' | 'beat_this' | 'btc' | 'manual'
}
```

迁移策略：v1 工程加载时补默认值（`kind:'instrument'`、无 audio 轨），**不重写文件**，保存时才升版本。

### 6.2 视图与交互

- 轨道头：类型徽标（🎹 MIDI / 🎧 AI 音频 / 📁 导入）
- 音频片段：波形 + 拉伸手柄 + 淡入淡出 + 对齐模式（小节/拍/自由）
- **区域框选 → 右键菜单**：AI 重绘（repaint）/ 换风格（cover）/ 转 MIDI / 分离音轨（extract）/ 分析（bpm+和弦）
- **「AI 加轨」**：选乐器 → 自动计算 mixdown（排除目标轨）→ `lego` → 新音频轨；可选"立刻转 MIDI 变成可编辑音符"
- **和弦车道**：铺在时间轴顶部，显示分析出的和弦 + 置信度，一键"写入工程和弦"（作为 MIDI 生成的和声依据）
- **Take 切换器**：轨内 A/B 试听、设为当前、"同 seed 重生成"、"换 seed 再抽一张"
- **生成中**：ghost 片段占位 + 进度条（LM/DIT/VAE）+ 可取消，不阻塞编辑

### 6.3 播放引擎改造（`AudioEngine` 契约扩展）

```ts
interface AudioEngine {
  // 新增：音频片段装载缓存
  loadAudioAsset(assetId: string, url: string): Promise<void>
  // 新增：应用时把 AudioClip 排期到 transport
  // 现有 applyProject(project) 内部处理：音频轨用 AudioBufferSourceNode +
  //   playbackRate = 1/stretchRatio、gain 包络做淡入淡出、
  //   起点 = startBeat * secPerBeat - offsetSec
  // 现有 renderToWav 扩展：OfflineAudioContext 里同时渲染 MIDI 音源与音频片段
}
```

三个坑要在设计阶段就定死：
1. **对齐**：音频起点必须按"拍→秒"换算，且工程改 BPM 时要么接受变速（`stretchRatio`）要么提示"音频不跟随 BPM"
2. **拉伸**：`playbackRate` 变速会变调；要保音高得用 phase vocoder（WebAudio 做不到，需 WASM/原生），**一期建议只支持"不变速或整段变速（允许变调）"**
3. **循环/跳转**：现有 scheduler 会重排 MIDI，音频 source 必须同步 stop/restart，否则叠音

### 6.4 与快照/撤销的融合

生成任务是"长事务"：任务创建时记录 `baseVersion` → 完成后**一次性**提交一个 project patch（含 `AudioClip` + `Take` + `Provenance`）→ 用户一次撤销即整体回滚。生成中的中间状态只存在于 UI 层（ghost），**不进 project**，避免污染版本历史。

---

## 7. Agent 设计：以工程为上下文驱动双域生成

### 7.1 工具按成本分层（这是整套设计的关键）

| 层 | 工具 | 执行位置 | 延迟 | 是否需要用户确认 |
|---|---|---|---|---|
| **L0 查询/理论** | `get_project` / `analyze_progression` / `theory.*` | NAS | 毫秒 | 否 |
| **L1 MIDI 生成** | `generate_smart_clip` / `arrange_section` / `write_chords` | NAS（core 纯函数） | 毫秒 | 否 |
| **L2 轻分析** | `analyze_audio`（bpm/和弦，短片段）/ `transcribe_midi`（小段） | 客户端 | 秒 | 否 |
| **L3 音频生成** | `audio_generate` / `audio_add_layer` / `audio_repaint` / `audio_cover` / `audio_separate` | 客户端 GPU | 10s–10min | **是**（预算确认） |
| **L4 训练** | `lora_train` | 客户端 GPU | 小时 | **是** + 显存校验 |

> ⚠️ **实测警告（2026-11-08）**：**不要用 `ace-server` 的 `/understand` 当分析层**。实测它把 168 BPM 的 JRPG 战斗曲判成 79（恰好半速）、调性判成 G minor（真实 D minor）、拍号判成 2（真实 4），生成的文字描述也是错的（把战斗曲写成"顽皮的音乐盒"）。节拍用 `beat_this`、和弦用 `BTC`、BPM 用自相关 + 人工确认；`/understand` 只适合产出一段"风格描述"当提示词素材，不能进 `AnalysisRecord` 的可信字段。

现有 `apps/server/src/tools/*`（`edit.ts` / `arrange.ts` / `project.ts` / `theory.ts` / `validate.ts`）全部属于 L0/L1，**不用改**；只需新增 `tools/audio.ts` 作为 L3 的门面（内部调 worker 协议）。

### 7.2 Agent 决策策略（写进 system prompt）

1. **MIDI 优先**：凡是能用音符表达的需求（和弦、节奏型、动机、配器骨架），先走 L1；L1 能解决的不要动 L3。
2. **L3 前必须产出 `AudioPlan`**：
   ```jsonc
   { "goal": "给这段副歌加一轨失真吉他",
     "target": { "trackKind": "audio", "instrument": "guitar", "bars": [17, 24] },
     "context": { "srcAudio": "mixdown_excluding_guitar", "bpm": 172, "key": "E minor" },
     "params": { "caption": "distorted power chord riff, double tracked", "seed": 201 },
     "budget": { "credits": 15, "etaSec": 60 } }
   ```
   展示给用户确认（可开"信任模式"跳过确认，但仍有单次/单日上限）。
3. **生成后自动收尾**：调 L2 分析 → 回写 `chords`/`BeatMap`/`Provenance` → 提示"已作为 Take 1 放入第 3 轨"。
4. **失败降级链**：设备离线 → 提示连接或排队；显存不足 → 自动降档（XL → 2B turbo）；OOM → 缩时长/降 batch 重试一次，仍失败则明确报错。
5. **可复现**：`regenerate_take(takeId)` 用原 seed + 原参数重跑；`variation_take(takeId)` 换 seed。

### 7.3 上下文构造

- 现有：整份 `Project` 快照（几十 KB）随请求发给 agent —— 保持。
- 新增 `project_digest`：轨道清单、每轨类型/片段范围、和弦、段落、已有音频 Take 的元数据（**不含波形**），让 agent 知道"哪些是 MIDI、哪些已是音频、哪些已被分析过"。
- 只有需要"听"的时候才渲染：`render_reference(barRange, excludeTrackIds)` → 返回 `assetId` 交给 L3 当 `src_audio`。

### 7.4 并发与预算

- 单用户同 GPU 串行（队列），前端显示排队位次与 ETA
- Agent 单轮内最多 2 次 L3（默认），超出必须用户确认
- credits 预扣/退还；失败不扣费

---

## 8. 模型分发（回答：要不要打包进应用）

**不打包权重，打包运行时。**

| 内容 | 是否进安装包 | 理由 |
|---|---|---|
| `ace-server` + ggml 各后端 DLL | ✅ 约 235MB（含 Vulkan/CPU 变体） | 跨平台、无 Python、无 torch |
| CUDA 13 运行时（cuBLAS 等） | ✅ 约 505MB（仅 NVIDIA 版） | Windows/Linux CUDA 后端必需；缺失会静默掉到 Vulkan，而 Vulkan 的 VAE 慢 183 倍 |
| Companion 守护进程 + 模型管理器 | ✅ | 配对、下载、校验、起停 |
| **模型权重（GGUF）** | ❌ | 5–25GB；量化档位不同；更新频繁；多平台共用但需按显存档位选择 |
| Python 版 ACE-Step | ❌（可选"开发者模式"） | torch+cu128 打包 >3GB，Mac 还要另配 MPS/MLX |

### 首次使用流程
```
1. Companion 检测硬件 → 上报能力
2. NAS 返回推荐档位：
   - Lite     : turbo + embed + VAE + LM 0.6B             = 4.18 GB   （≥8GB 显存，text2music/cover）
   - Standard : + base(加轨) + sft(重绘) + LM 1.7B         = 10.24 GB  （≥12GB 显存，六种任务全开）★推荐
   - HQ       : XL turbo+base+sft + LM 4B + 其余           ≈ 24 GB     （≥24GB 显存）
3. 下载（断点续传 + sha256 校验 + 解压），显示进度与剩余磁盘检查
4. 自测跑一首 10s → 上报 bench 数据 → 参与调度
```

### 实测基线（2026-11-08，RTX 5090 D v2 / CUDA 13 / Q8_0）

| 指标 | 实测值 |
|---|---|
| 100 秒曲目生成 | **10.8 秒**（turbo 8 步：DiT 6.4s + VAE 2.9s） |
| 30 秒音频 | 11.4 秒 |
| cover（100s→100s） | 14.3 秒，结构包络相关 0.935（换编制不换结构） |
| lego 加一轨（base 50 步） | 14.9 秒，**输出是独立分轨**（低频 −12.8dB / 高频 +10.5dB） |
| repaint 12 秒区间（sft 50 步） | 14.8 秒，区域外相关 0.98、区域内 ≈0 |
| LLM 规划 500 音频码 | 22.3 秒（1.7B，111 tok/s） |
| 冷启动加载 | 4.1–5.6 秒；`--sleep 300` 空闲卸载后回载同量级 |
| 模型体积 | Lite 4.18GB / Standard 10.24GB / HQ ≈24GB |

两条硬性工程约束（来自实测，必须写进 Worker 实现）：

1. **必须固定 CUDA 后端**：`GGML_BACKEND=CUDA0` + CUDA 13 运行时 DLL 放在 exe 同目录。默认会掉到 Vulkan，那里 VAE 解码慢 **183 倍**（30 秒音频 421 秒 vs 2.3 秒），用户会以为软件卡死。检测不到 CUDA 时，要么明确提示降级，要么禁用音频生成——**不能静默跑 Vulkan**。
2. **模型与任务必须预检**：repaint 只认 sft、lego 只认 base，喂错直接进程 FATAL 退出。Worker 必须在派单前做能力匹配（`capabilities.models` × 任务类型矩阵）。

### NAS 兼做局域网模型镜像（强烈建议）
- NAS 首次从 ModelScope 拉一次权重（实测 25–50MB/s），落盘到 Docker volume
- 客户端优先从 NAS 下载（千兆 LAN ≈ 100MB/s），失败回落公网镜像
- 收益：① 用户不用每个设备下 8GB；② 国内网络稳定性；③ 企业内网可完全离线部署

### 版本与合规
- NAS 下发**签名 manifest**：`{ modelId, version, quant, size, sha256, license: 'MIT', mirrors[] }`
- 客户端只接受 manifest 白名单内的模型，拒绝任意 URL（防 SSRF/恶意权重）
- 记录 `licenseSnapshotAt` 到 `Provenance`；上游改许可时可追溯

---

## 9. 商业化挂点

| 挂点 | 实现位置 | 说明 |
|---|---|---|
| Credits 计费 | NAS（权威）| 按生成时长/步数预扣，失败退还；客户端不可信 |
| 订阅分层 | NAS | 免费版只给 Lite + 限次；Pro 给 HQ + 更长时长 + 更多设备 |
| 云渲染兜底 | NAS → 云 GPU worker | 弱设备用户；同一 job 协议，worker 换位置 |
| LoRA 训练配额 | NAS | 按显存/时长计费 |
| 分享/导出 | NAS | 生成内容带署名与 provenance 元数据 |

---

## 10. 分期落地

| 阶段 | 周期 | 交付 | 验收 |
|---|---|---|---|
| **P0 链路验证** | 1–2 周 | `ace-server`（GGML 预编译）在本机跑通；一条 `audio.generate` 链路（浏览器渲染 WAV → cover 保旋律换编制）；一条 `repaint` | 生成 1 首并回填到工程；8 秒局部重绘可听出差别 |
| **P1 单机 Studio MVP** | 4 周 | Companion（本地 server + worker 进程管理）+ 硬件检测推荐档位 + 模型管理器（下载/校验/镜像）+ `AudioClip`/`Take` 数据模型 + 波形/淡变/对齐 + 播放与导出 | 从空白工程做出 8 小节乐队化 demo；撤销可整体回滚 |
| **P2 Studio 能力** | 4 周 | `lego` / `repaint` / `extract` + 和弦与拍点分析 + Agent L3 工具与 `AudioPlan` 预算确认 + **可选云同步** | 框选 8 秒重绘；给 MIDI 加一轨贝斯；和弦车道可用；换机可拉回成品 |
| **P3 平台化** | 6–8 周 | 跨平台打包（Win/Mac）、形态 A（NAS）接入、云渲染兜底、MIDI 转录、LoRA 入口、计费上线、**原生壳 + 音频引擎评估** | 灰度用户可用；Windows/macOS 同功能 |
| **P4 VST** | — | VST 宿主 / `acestep.vst3` 外部 DAW 桥 / 原生音频引擎 | 单独立项 |

---

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| 客户端不在线 → 任务无法执行 | 明确 UX（"你的电脑未连接"），支持排队 + 到线自动执行 + 云兜底 |
| 音频回传占用上行带宽 | 默认 `local` residency；预览用小码率 mp3 |
| 模型版本漂移（客户端旧 manifest） | 服务端校验版本，不匹配拒绝并提示升级 |
| 音频与工程网格不对齐 | 生成时锁定 BPM/拍号；分析后用 `BeatAnchor` + `stretchRatio` 校正；UI 明确提示 |
| WebAudio 无法做保音高变速 | 一期只支持不变速/变调变速；后续用 WASM phase vocoder 或原生引擎 |
| **VST 需求与浏览器架构冲突** | 见 §12，这是需要提前拍板的战略问题 |
| 安全：worker 被诱导执行任意模型 | manifest 白名单 + 权重签名校验 + 最小权限 token |
| N100 上 Agent + 大工程快照吃 CPU | 快照压缩 + 增量 patch；压测 100 轨工程 |

---

## 12. 已决定：VST 进路线，原生壳放在 P3（D5）

你的长期需求里有两件事浏览器架构做不到：

1. **VST 插件宿主**：VST3 是原生动态库，WebAudio 无法加载。要做就得有原生进程（JUCE 宿主）并把它和浏览器 UI 桥接（IPC + 音频流）。
2. **低延迟专业音频**：WebAudio 约 5–20ms 缓冲够用，但专业宿主可到 1–3ms；且多轨大工程下 WebAudio 的调度抖动明显。

因此建议明确一条演进路径：

```
现在：浏览器 UI + WebAudio（快速迭代，产品验证）
      ↓ 当 VST / 低延迟成为卖点
中期：原生壳（Tauri/Electron）+ 原生音频引擎（JUCE 或 Rust）+ Web UI 复用
      ↓
长期：音频引擎与 AI 推理都在客户端进程；NAS 只做协作与商业
```

**决定（D5）**：VST 排进路线，但不进 P1/P2——先用浏览器把 Studio 形态跑通，P3 再评估原生壳。理由：VST 宿主会把客户端变成原生进程（JUCE/原生音频），是一次架构升级，过早做会拖慢核心体验验证。

**现在要做的准备**（成本很低，且与 VST 决定无关地都值得做）：
- 把音频播放/导出继续收敛在 `AudioEngine` 接口后面（你已经这么做了，保持住）
- 音频片段、Take、Provenance 的数据模型**不要依赖 WebAudio 特有概念**（比如不要存 `AudioBuffer`，只存 `AssetRef`）
- Worker 协议设计成"语言无关的 HTTP/WS"，将来换成原生宿主也复用

---

## 13. 决策状态

**已拍板（2026-11-08）**：D1 形态 B 首发 / D2 local + 可选云同步 / D3 硬件检测推荐档位 / D4 L3 默认确认 / D5 VST 进 P3。

**仍需在 P0/P1 阶段确定的实施细节（不阻塞开工）：**
1. Companion 的进程形态：独立托盘程序（Tauri/Electron）还是 Node 子进程由启动器拉起？——建议 P0 先用「Node 子进程」，P1 再包壳。
2. 本地 server 端口策略：固定 17860 还是随机 + 端口文件？——建议随机端口 + `~/.aiab/port` 文件，避免冲突。
3. 模型存放路径：`%LOCALAPPDATA%/aiab/models`（Win）/ `~/Library/Application Support/aiab/models`（mac）？——建议遵循 OS 惯例。
4. 云同步的粒度：整个工程（含音频）还是仅工程 JSON + 勾选上传音频？——建议后者，默认只同步 JSON。
5. 生成任务的并发：单机串行（1 个 GPU 任务）还是允许 2 个排队？——建议串行 + 队列可见。
