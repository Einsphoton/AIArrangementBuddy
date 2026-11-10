# Companion 工作节点（P5-A）

> 状态：P5-A（常驻引擎 + 真取消 + repaint + 真实能力上报/优先级 + generate_stem lego 分轨/base 变体）。Companion 是「数据面」进程：跑在用户自己的电脑/GPU 上，向服务端（NAS 控制面或本机服务）拉取音频生成任务并回传结果。
> 设计背景见 [STUDIO_ARCHITECTURE.md](./STUDIO_ARCHITECTURE.md) §4；P1 用「HTTP 轮询」落地 §4 的 Worker 协议（WSS 推到后续）。

## 1. 它做什么

```
Companion（本机）                               服务端（NAS / 本机 8787）
     │  POST /api/companion/register                │
     │  { name, version, capabilities } ──────────▶ │ 发 workerId + token + heartbeatMs/pollMs
     │                                              │
     │  POST /api/companion/heartbeat   （每 heartbeatMs）
     │  { workerId, token,
     │    status: { busy, currentTaskId,
     │              engine: { variant, pid, warm } } } ─▶ cancelTaskIds?（取消指令）
     │                                              │
     │  POST /api/companion/claim       （每 pollMs，无任务时 204）
     │  { workerId, token } ──────────────────────▶ │ { task: { id, type, params, projectId?,
     │                                              │           priority?, requiredVariant? } }
     │                                              │
     │  执行任务：mock / ACE-Step（常驻引擎复用）     │
     │   · generate_audio → turbo                    │
     │   · repaint_audio  → sft（下载源音频→multipart）│
     │   · generate_stem  → base（lego 分轨，multipart）│
     │  合成期间每 ~2s progress 0.3→0.9             │
     │                                              │
     │  GET /api/companion/status       （仅空闲，≤1 次/30s）
     │  → blockedByCapability: [{variant,count}]     │
     │    本机缺该变体 → 节流提示（不刷屏）           │
     │                                              │
     │  POST /api/companion/progress    （0..1）
     │  { workerId, token, taskId, progress, message } ─▶ { ok, cancel? }
     │   cancel:true → 中止 HTTP + 杀引擎进程         │
     │                                              │
     │  POST /api/companion/complete    （multipart）
     │  workerId/token/taskId/status[/error][/file(.wav)] ─▶ { ok, assetId? }
```

要点：

- 只保留一个在途任务（单任务串行；多 worker 由服务端调度）。**常驻引擎同一时刻只有一个**，跨任务复用。
- **能力上报（P4-A/P5-A）**：注册时 `capabilities.tasks` 上报 `generate_audio`/`repaint_audio`/`generate_stem`；`capabilities.models` 按 `music-gen/acestep-cpp/models/` 里**真实存在的 GGUF** 上报变体（`turbo`/`sft`/`base`）。`--mock` 固定上报 `['turbo','sft','base']`（三种任务都能伪造，便于 UI 联调）。服务端据此做任务能力匹配（models 为空的历史 worker 视为全收）。
- **优先级/排队（P4-A）**：claim 到的任务带 `priority`（0 普通 / 1 高 / 2 紧急）与 `requiredVariant`；旧服务端缺这两个字段时按 `0` / 从 `type` 推断（generate→turbo，repaint→sft，stem→base），不报错。认领日志会打印二者（stem 任务额外打印 `arm=`）。
- 空闲自检：claim 返回 204 时，每 **30s 至多一次** `GET /api/companion/status`，若 `blockedByCapability` 里有本机不支持的变体任务，节流提示「当前队列需要 sft，但本机只上报了 turbo」；有任务时不额外轮询 status。
- 引擎按 DiT 变体选择：`generate_audio → turbo`，`repaint_audio → sft`，`generate_stem → base`；同一「变体 + LoRA 适配器」身份跨任务复用，换变体或换适配器才重启（日志「切换模型」；切到 base 会提示冷启动慢）。
- 引擎生命周期：首次任务懒启动 → 健康检查 → 空闲 `--engine-idle` 秒后自动退出（默认 600）→ 崩溃后下一任务自动重启 → `SIGINT/SIGTERM` 时 finally 回收。
- 所有请求失败都按指数退避重试（500ms 起，翻倍，封顶 10s），服务端暂时不可达不会崩。
- 服务端重启会丢内存里的 worker 表：`heartbeat/claim` 收到 401/403/404 时自动重新注册。注意服务端在 worker 未知时 `claim` 可能仍返回 204（「无任务」），所以 **心跳的 401 是可靠失效信号**：心跳置位后，主循环在两次 claim 之间重新注册，不打断在途任务。
- 出错不静默：执行失败/取消都会 `complete(status=failed, error=中文原因)`；进程级致命错误才退出。

## 2. 前置条件

| 项 | 要求 |
|---|---|
| Node.js | ≥ 20.19（仓库要求）；本脚本按 Node 24 验证（内置 `fetch` / `FormData` / `Blob`） |
| 仓库 | 在仓库根目录执行；无需新增 npm 依赖 |
| mock 模式 | 无额外要求（无 GPU 也能跑通 generate/repaint 全链路） |
| ACE-Step 模式 | `music-gen/acestep-cpp/bin/ace-server.exe` + `models/` 下 `Qwen3-Embedding-0.6B-Q8_0.gguf`、`acestep-v15-turbo-Q8_0.gguf`、`acestep-v15-sft-Q8_0.gguf`、`vae-BF16.gguf`，NVIDIA GPU + CUDA 运行库 |

> `acestep-v15-base-Q8_0.gguf` 用于 `generate_stem`（lego 分轨），必须存在才会在 models 里上报 `base` 并接到分轨任务；缺 base 时只影响 stem，不影响 generate/repaint。
> P4-A 起 `capabilities.models` 按**实际存在的 GGUF** 上报：只装了 turbo 的机器不会接到 repaint 任务（见 §7.2）。

## 3. 快速开始（mock：无 GPU 自检全链路）

```bash
# 1) 启动服务端（默认 8787；换端口用 PORT）
pnpm build
node scripts/start.mjs
# 服务端必须包含 /api/companion/* 路由。改动服务端后需重启。

# 2) 另开一个终端，启动 mock companion
#    --once：处理一个任务就退出（成功 0 / 失败 1），便于验收
node scripts/companion.mjs --server http://127.0.0.1:8787 --name "本机 GPU" --mock --once
```

服务端入队 `generate_audio` 或 `repaint_audio` 任务后，终端应看到类似：

```
2026-11-09T03:00:00.000Z Companion 启动：executor=mock（无 GPU 自检） server=http://127.0.0.1:8787 name=本机 GPU once=true
2026-11-09T03:00:00.100Z 已注册：workerId=worker_ab12cd34 heartbeatMs=5000 pollMs=3000 版本=0.2.0
2026-11-09T03:00:00.200Z [task_001] 认领任务 task_001（repaint_audio）
2026-11-09T03:00:00.300Z [task_001] 进度 20% · 生成音频（mock）
...
2026-11-09T03:00:00.800Z [task_001] 任务完成，assetId=as_xxx
2026-11-09T03:00:00.900Z --once：已处理 1 个任务（成功），退出
```

产物：2 秒 440Hz 立体声 48kHz PCM16 WAV（左右声道同相，自己拼 44 字节 RIFF 头），经 `multipart/form-data` 的 `file` 字段上传，服务端落成音频资产。`--mock` 下三个任务类型都返回同样的 mock WAV，文件名分别为 `<taskId>.wav` / `repaint-<taskId>.wav` / `stem-<arm>-<taskId>.wav`。

## 4. 真实模式（本地 GPU + ACE-Step C++，常驻引擎）

```bash
node scripts/companion.mjs --server http://127.0.0.1:8787 --name "本机 GPU" --acestep --engine-idle 600
# 无 --once 时持续轮询；Ctrl+C 停止（会先 terminate ACE-Step 子进程再退出）
```

### 4.1 常驻引擎（EngineManager）

1. 预检 `ace-server.exe` 与 turbo/sft/embedding/vae 四个模型（缺失时任务 fast-fail 为中文 failed，而不是静默退出）；`generate_stem` 额外要求 base 模型，缺失时该任务在启动引擎前直接 failed。
2. 首次任务懒启动引擎；在 **17900–17999** 随机探测空闲端口（启动前 bind 探测）；`cwd = music-gen/acestep-cpp`，env `GGML_BACKEND=CUDA0`（可用同名环境变量覆盖），参数按变体：
   ```
   ace-server.exe --host 127.0.0.1 --port <随机端口> --sleep 300 \
     --embedding models/Qwen3-Embedding-0.6B-Q8_0.gguf \
     --dit models/acestep-v15-<turbo|sft|base>-Q8_0.gguf \
     --vae models/vae-BF16.gguf
   ```
   引擎 stdout/stderr 写到系统临时目录 `aiab-companion-ace-<pid>-<port>.log`（Windows 为 `%TEMP%`），失败时日志尾部会带进错误信息。
3. 轮询 `GET /health`（每 1.2s，最长 240s）。子进程提前退出或 spawn 失败会立即报可读原因。
4. **同变体跨任务复用**：复用前先做一次 `/health` 探活（2s 超时），失败则重启；日志显示「复用常驻引擎（turbo，pid=…）」。
5. **变体/适配器切换**：任务要求的 DiT 或 LoRA 适配器与当前不同 → 停旧起新，日志显示「切换模型：turbo → sft」「切换模型：turbo → base」「切换模型：turbo → turbo+LoRA(lora_a)」；切到 base 会额外提示冷启动较慢（真机 ≈35.9s）。
6. **LoRA 适配器**：服务端在 `task.params.adapterPath` 下发适配器目录时，启动引擎会追加 `--lora <adapterPath> --lora-scale 1.0`；`adapterId` 仅用于日志。LoRA 生成质量的真机验收由 Lead/后续任务负责。
7. **空闲回收**：任务结束（`release`）后空闲 `--engine-idle` 秒（默认 600，`0` 表示不自动退出）自动 terminate 引擎；下次任务冷启动。
8. **崩溃重启**：子进程意外退出会记录「引擎进程意外退出」，下一任务自动重启；进行中的任务按失败处理（会尝试 `complete(failed)`）。
9. **SIGINT/SIGTERM**：中止在途 HTTP、按取消处理任务、`finally` 里 terminate→（超时）SIGKILL，确保不残留 `ace-server.exe`。

心跳 status 会带上引擎信息（服务端忽略未知字段亦可）：`{ busy, currentTaskId, engine: { variant, pid, warm, adapter? } }`；没有引擎时省略 `engine`，`adapter` 仅在加载 LoRA 时出现。

### 4.2 generate_audio（turbo）

`task.params`：`{ caption, bpm?, keyscale?, durationSec?, seed? }`。

1. 进进度 0.15「引擎启动中（turbo）」（引擎冷启动时）；
2. `POST /synth?wav=1`（JSON，超时 900s）：

   ```json
   {
     "caption": "任务参数 caption",
     "lyrics": "[Instrumental]",
     "bpm": 120, "keyscale": "C major", "timesignature": "4",
     "vocal_language": "unknown", "seed": 0,
     "batch_size": 1, "inference_steps": 8, "guidance_scale": 1.0,
     "shift": 3.0, "use_cot_caption": false, "duration": 30
   }
   ```
   缺省值 `bpm=120`（夹到 30–300）、`keyscale="C major"`、`durationSec=30`（夹到 1–300）、`seed=0`（非负整数）。
3. 校验返回字节是 `RIFF....WAVE`，`complete` 上传，文件名 `<taskId>.wav`。

### 4.3 repaint_audio（sft）

`task.params`：`{ caption(必填), sourceAssetId(必填), startSec, endSec, seed?, style?, adapterId?, adapterPath? }`（服务端入队时会补 `sourceDurationSec` 用于前置校验；有 `adapterId` 时校验并下发 `adapterPath`）。

1. **启动引擎前**先校验 `caption` / `sourceAssetId` / `startSec`（≥0）/ `endSec`（> startSec）；服务端若已下发 `sourceDurationSec`，同时校验 `endSec` 不越界，非法立即 `complete(failed)` 中文原因。
2. 从 `{server}/api/assets/{sourceAssetId}/file` 下载源 WAV 到系统临时文件；校验是有效 WAV。
3. 解析源 WAV 时长，再以实际时长校验 `endSec <= 源时长`（越界同样在启动引擎前失败，给自己 0.05s 容差）。临时文件在 `finally` 删除。
4. 启动/复用 **sft** 引擎（有 `adapterPath` 时带 `--lora`），`POST /synth?wav=1`（**multipart**，与 `music-gen/tools/test_modes.py` 实测形状一致）：
   - 字段 `request`（JSON 字符串，`Content-Type: application/json`）：
     ```json
     {"caption":"...","lyrics":"[Instrumental]","seed":201,"batch_size":1,
      "repainting_start":6.0,"repainting_end":12.0,
      "inference_steps":50,"guidance_scale":1.0,"shift":1.0}
     ```
     `seed` 缺省随机（0–999999）；`style` 仅记录日志。
   - 文件字段 `audio`（`Content-Type: audio/wav`，filename 为源临时文件名）。
5. 校验返回 WAV，`complete` 上传，文件名 `repaint-<taskId>.wav`。

> 实测参考：sft 冷启动 ≈18.3s；20s 源音频重绘 6–12s 区间 ≈14.3s，输出保持 20.00s / 48k / 2ch。
> LoRA（`adapterId` + `adapterPath`）已接入引擎启动参数，真机效果验收由 Lead 的后续联调负责。

### 4.4 generate_stem（lego 分轨，base）

`task.params`：`{ sourceAssetId(必填), arm(必填), caption?, seed? }`；`arm` 合法值：`guitar` / `bass` / `drums` / `strings` / `keys` / `synth` / `vocals`。

1. **启动引擎前**校验 `sourceAssetId` 与 `arm`（非法 arm 立即 `complete(failed)`，中文原因列出合法值）；`base` 模型缺失也会在此阶段失败。
2. 从 `{server}/api/assets/{sourceAssetId}/file` 下载源 WAV 到临时文件（复用 repaint 的下载逻辑），`finally` 删除。
3. 启动/复用 **base** 引擎（必须 base；turbo/sft 会报错）。**base 冷启动明显更慢**（真机实测 ≈35.9s），日志会明确提示「冷启动较慢」；之后同变体任务复用引擎，单条 stem 约 1.7–14.5s。
4. `POST /synth?wav=1`（**multipart**：`request` JSON 字符串 + `audio` 源 WAV，形状与 `test_modes.py` lego 一致）：
   - `request`（caption 缺省时按 arm 用内置英文描述；`lyrics` 固定 `[Instrumental]`）：
     ```json
     {"caption":"Isolated electric guitar stem: …","lyrics":"[Instrumental]","seed":201,
      "batch_size":1,"lego":"guitar","inference_steps":50,"guidance_scale":1.0,"shift":1.0}
     ```
   - 文件字段 `audio`（`Content-Type: audio/wav`）。
5. 校验返回 WAV，`complete` 上传，文件名 `stem-<arm>-<taskId>.wav`；日志打印耗时与产物大小。
6. 进度与 generate_audio 一致：引擎启动 0.15 → 合成 0.3–0.9 估算 → 1。

> **产品语义提醒**：ACE-Step 输出的是「该 arm 独立生成的 stem」，**不是源音频+stem 混音**，也不保证与原音频逐样本对齐（真机实测 guitar stem 质心 2035Hz、低频占比 0.012，与源曲 1036Hz/0.35 明显不同）。UI/文案需要注明。
> `--mock` 下 `generate_stem` 同样返回 2s mock WAV（文件名 `stem-<arm>-<taskId>.wav`），便于 UI 联调。

### 4.5 真取消（生成期间）

- 合成请求进行中，每 **~2s** 调一次 `progress`（进度为 0.3→0.9 的按耗时估算值）；`/synth` 是阻塞调用，没有真实分段进度。
- 若 `progress` 响应 `cancel:true`（或心跳返回的 `cancelTaskIds` 命中当前任务）：
  1. `AbortController.abort()` 中止 `/synth` HTTP 请求；
  2. **杀掉当前引擎进程**（推理无法安全中断，杀进程最可靠；日志会说明）；
  3. `complete(status=failed, error=用户取消)`；
  4. 下一任务重新冷启动引擎。
- 排队阶段取消（服务端把 queued 直接置 canceled）无需 Companion 处理；claim 后才可能看到 cancel。
- `--mock` 生成很快，取消通常发生在第一/第二次 progress（同样会走 complete(failed, error=用户取消)）。

### 4.6 进度

| 阶段 | progress | message 示例 |
|---|---|---|
| 引擎启动（冷启动） | ≈0.15 | `引擎启动中（turbo）` / `引擎启动中（sft）` |
| 引擎复用/就绪 | 0.3 | `复用常驻引擎（turbo）` |
| 合成中（每 ~2s 估算，封顶 0.9） | 0.3→0.9 | `生成中 47%（估算）` / `重绘中 61%（估算）` |
| 完成 | 1 | `完成` |

## 5. CLI 参考

```
node scripts/companion.mjs --server http://127.0.0.1:8899 --name "本机 GPU" [--mock|--acestep] [--once] [--engine-idle 秒]
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--server <url>` | `http://127.0.0.1:8787` | 服务端地址；必须是 `http(s)://`，可带子路径 |
| `--name <名字>` | 主机名 | 服务端 worker 列表里的显示名 |
| `--mock` | 关 | 无 GPU 自检执行器（generate/repaint/stem 都返回 2s 440Hz WAV） |
| `--acestep` | 开（默认） | 生产执行器：本地 ACE-Step C++ 常驻引擎 |
| `--engine-idle <秒>` | `600` | 引擎空闲多少秒后自动退出；`0` = 不自动退出 |
| `--once` | 关 | 处理完一个任务（成功或失败）后退出，退出码 0/1 |
| `--help`, `-h` | — | 帮助 |

环境变量：

| 变量 | 说明 |
|---|---|
| `GGML_BACKEND` | ACE-Step 后端，默认 `CUDA0`；同时作为注册能力里的 `gpu` 上报 |
| `TEMP` / `TMP` | ACE-Step 引擎日志、repaint/stem 源音频临时文件目录（系统临时目录） |

心跳/轮询周期不由 CLI 指定：以 `register` 响应里的 `heartbeatMs`（1000–60000，默认 5000）和 `pollMs`（500–30000，默认 3000）为准，并做上下界保护。

## 6. 指向 NAS（跨机器）

服务端跑在 NAS 上时，把 `--server` 换成 NAS 地址即可（同一局域网）：

```bash
node scripts/companion.mjs --server http://192.168.1.10:8787 --name "书房 5090" --acestep
```

- 确保 NAS 的 8787 端口对局域网开放；反向代理/防火墙要允许 `multipart/form-data` 上传与 `GET /api/assets/:id/file` 下载（音频可能几十 MB，body 上限调大）。
- 跨公网时建议套 HTTPS + 后续的配对/长期 device token（当前 `workerId + token` 在 register 时下发，只存内存；服务端重启后自动重新注册）。
- 本机开发时服务端 `PORT` 不是 8787（被占用自动切换），按 `node scripts/start.mjs` 打印的实际端口传 `--server`。

## 7. 多 worker 与任务优先级

### 7.1 优先级（priority）

| priority | 语义 | 典型任务 |
|---|---|---|
| `0` | 普通 | 批量生成、后台整理 |
| `1` | 高 | 用户正在等待的编辑操作 |
| `2` | 紧急 | 试听/预览等交互式生成 |

- 服务端队列排序：**priority 高的先派，同优先级按入队时间**；Companion 只消费队列、不决定优先级。
- claim 到的任务带 `priority` 与 `requiredVariant`；认领日志会打印，例如：
  `认领任务 task_ab12（generate_audio，priority=2，requiredVariant=turbo）`。
- 旧服务端不带这两个字段时：priority 按 `0`、requiredVariant 按 `type` 推断（generate_audio→turbo，repaint_audio→sft，generate_stem→base），不报错。

### 7.2 能力匹配（capabilities.models）

- 注册时 `capabilities.models` 是**变体集合**：扫描 `music-gen/acestep-cpp/models/`，存在 `acestep-v15-turbo-Q8_0.gguf` 上报 `turbo`、存在 sft 上报 `sft`、存在 base 上报 `base`；`--mock` 固定上报 `['turbo','sft','base']`（三种任务都能伪造，便于 UI 联调）。`capabilities.tasks` 固定上报 `generate_audio/repaint_audio/generate_stem`。
- 任务有 `requiredVariant`（generate_audio→turbo，repaint_audio→sft，generate_stem→base）；只有 worker 的 models 包含该变体（或 models 为空=兼容全收）才会被派单。
- 本机只装 turbo 时不会接到 repaint：空闲（claim 204）时 Companion **每 30s 至多一次** 调 `GET /api/companion/status`，若返回的 `blockedByCapability` 里有本机缺失的变体，节流输出一条提示（默认 30s 一条，不刷屏）：
  ```
  ⚠ 当前队列有2 个任务需要 sft，但本机只上报了 turbo；服务端不会派单——安装对应模型，或用 --mock 自检
  ```
- 正常有任务时**不会**额外轮询 status；只靠 claim 轮询。
- 变体/适配器切换仍会使常驻引擎重启（见 §4.1）；能力匹配只看变体，不看 LoRA。

### 7.3 两台机器并行

```
NAS:8787 ── worker A（台式机 5090，models=[turbo,sft,base]）── generate + repaint + stem
        └─ worker B（笔记本 3060，models=[turbo]）──────────── 只接 generate
```

- 两台机器各自用不同的 `--name` 注册；服务端按「能力匹配 → 在线 → 空闲 → 排队」调度。
- 引擎不共享：每台机器各自常驻自己的 ace-server；同变体任务在本机复用，换变体才重启。
- 排队信息：`GET /api/companion/tasks/:id` 返回 `queuePosition`（前面排队任务数，0=下一个）与 `estimatedWaitSec`（按最近同类任务平均耗时估算）；`GET /api/companion/status` 的 tasks 也带 `priority/queuePosition`。
- 单机仍是「单任务串行」；要并行跑多个生成就再起一台机器/再挂一个 worker。

### 7.4 常见排队排查

| 现象 | 原因 / 处理 |
|---|---|
| 任务一直 `queued`，`/api/companion/status` 看不到在线 worker | Companion 没启动/注册失败/网络不通；先看 Companion 日志与 `curl <server>/api/health` |
| 有 worker 在线，但 repaint 一直不派单 | 该 worker 的 models 不含 sft；看启动日志「能力上报：models=[...]」或 `/status` 的 workers |
| 有 worker 在线，但 generate_stem 一直不派单 | 该 worker 的 models 不含 base（base 模型文件缺失或未重启）；看「能力上报」日志 |
| 两台机器只有一台在跑 | 另一台可能心跳超时掉线、models 不匹配，或正忙（单机串行） |
| 日志反复出现「当前队列任务需要…」 | 每 30s 至多一次属于正常节流；持续出现说明能力确实不匹配，装模型或换 worker |
| 想知道还要等多久 | `GET /api/companion/tasks/:id` 看 `queuePosition` / `estimatedWaitSec` |

## 8. 自检与验收

```bash
# 纯函数 / 形状自检（不依赖服务端、不依赖 GPU）
node music-gen/tools/verify_companion.mjs
```

当前覆盖 83 项：CLI 解析（含 `--engine-idle`）、注册/心跳/claim/complete 协议形状、mock WAV 字节级校验、`readWavInfo`、generate `/synth` 请求体、repaint 参数校验/request JSON/multipart 字节结构、complete 表单、进度估算、cancel 判定、**EngineManager 假子进程**（冷启动/同变体复用/切变体（含 base）/崩溃重启/取消杀进程/空闲退出/`/health` 探活失败重启/LoRA `--lora` 启动与适配器切换/心跳 engine 字段）、**P4-A 能力上报与优先级**（GGUF 变体检测、models 上报、priority/requiredVariant 兼容、30s 节流、能力缺口检测与中文提示）、**P5-A generate_stem**（7 个合法 arm、arm 校验与默认 caption、lego request JSON、base 变体选择/`--dit` 模型/冷启动提示、mock stem WAV 与文件名）、指数退避、terminate→kill、随机端口。

端到端验收（需要服务端已加载 `/api/companion/*`；真 GPU 联调见 Lead 的 `verify_p2_repaint.mjs`）：

1. `--mock --once` 处理 `generate_audio` → 服务端任务 `done` 且产出音频资产；
2. `--mock --once` 处理 `repaint_audio` → `done`，文件名为 `repaint-<taskId>.wav`；
3. 连续两个 `generate_audio`（不带 `--once`，或用服务端状态接口观察）→ 第二次日志出现「复用常驻引擎」，不再冷启动；
4. 先 `generate_audio` 再 `repaint_audio` → 日志出现「切换模型：turbo → sft」；
5. 生成中途取消（`progress` 返回 `{cancel:true}`）→ 任务 `failed` 且 `error=用户取消`，`tasklist | findstr ace-server` 无残留、下一任务冷启动；
6. 观察心跳/状态面板：`engine.variant/pid/warm` 随任务变化；
7. 空闲超过 `--engine-idle` 秒 → 日志「引擎空闲 …s，自动退出」，`tasklist` 无 `ace-server.exe`；
8. 停掉服务端再启动 → Companion 自动重注册后继续 claim；Ctrl+C → 引擎被回收；
9. 启动日志出现「能力上报：tasks=[…] models=[…]」，与 `/api/companion/status` 的 workers 一致；认领日志含 `priority`/`requiredVariant`；
10. 队列里放入本机不支持变体的任务（如只装了 turbo 却有 repaint）→ 空闲 30s 内出现一次能力不匹配提示，且不刷屏；
11. `--mock --once` 处理 `generate_stem` → `done`，文件名为 `stem-<arm>-<taskId>.wav`，认领日志含 `arm=`；
12. 真机：先 `generate_audio` 再 `generate_stem` → 日志出现「切换模型：turbo → base」与 base「冷启动较慢」提示；首次约 36s，之后单条 stem 复用引擎；输出 20s/48k/2ch；非法 arm 的任务在启动引擎前直接 failed。

## 9. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 注册失败，提示「服务端没有 Companion 协议路由（HTTP 404）」 | 服务端版本未包含协议路由或未重启；确认 `--server` 端口正确 |
| 一直「无法连接服务端：ECONNREFUSED」并指数退避 | 服务端没起、端口不对、防火墙拦截；`curl <server>/api/health` 验证 |
| `--acestep` 任务立即 failed：`ACE-Step 引擎文件缺失…` | 未下载 C++ 引擎/模型；先跑 `python music-gen/tools/fetch_acestep_cpp.py` 等准备步骤 |
| ACE-Step 240s 未就绪 | 冷启动慢或模型加载失败；看 `%TEMP%\aiab-companion-ace-*.log` |
| 每次任务都冷启动（日志无「复用常驻引擎」） | 引擎在任务间崩溃或被空闲回收（`--engine-idle` 太小）；看引擎日志尾部 |
| repaint 立即 failed：`repaint_audio 需要 params.caption/sourceAssetId`、`startSec 必须小于 endSec`、`endSec 超过源音频时长` | 服务端入队参数不合法；修正 params（区间单位是秒，end 必须 ≤ 源时长） |
| repaint 失败：`下载源音频失败（HTTP 404）` | `sourceAssetId` 不存在或服务端没存该资产；先确认 `/api/assets/:id/file` 可访问 |
| 取消后下一任务明显变慢 | 预期行为：取消会杀引擎（推理无法安全中断），下一任务重新冷启动 |
| 引擎频繁「意外退出」 | 显存不足/驱动崩溃；看引擎日志与 `nvidia-smi`；先用 `--mock` 排除协议问题 |
| 带 LoRA 的任务引擎启动失败 | `adapterPath` 目录不存在/不完整或与基座不匹配（服务端已校验基座）；看 `%TEMP%\aiab-companion-ace-*.log`；先用无 `adapterId` 任务验证链路 |
| 换 `adapterId` 后首个任务变慢 | 预期行为：引擎身份含适配器，换适配器要重启引擎（日志「切换模型：… → …+LoRA(…)」） |
| `generate_stem` 立即 failed：`arm 非法` | arm 必须是 guitar/bass/drums/strings/keys/synth/vocals 之一（大小写不敏感）；服务端入队时也应校验 |
| `generate_stem` failed：`需要 base 模型，但文件不存在` | `models/acestep-v15-base-Q8_0.gguf` 缺失；补齐后重启 Companion（models 上报也会含 base） |
| 第一次 stem 任务等很久（约 30–40s） | base 变体冷启动慢（真机 ≈35.9s）；后续同变体任务复用引擎，单条 stem ≈1.7–14.5s |
| stem 听起来不像源曲里的该乐器 | 预期行为：输出是该 arm **独立生成**的 stem，不是源+stem 混音，也不保证逐样本对齐；产品文案需注明 |
| 心跳里没有 `engine` 字段 | mock 模式没有引擎；acestep 模式引擎未启动/已空闲退出/已崩溃时会省略 |
| 服务端重启后 Companion 报会话失效 | 已自动重新注册（以心跳 401 为信号，claim 204 不代表失效）；若持续失败检查服务端 register 路由 |
| 任务已入队但本机 Companion 空闲不认领 | 能力不匹配（models 不含 requiredVariant）或被更高优先级任务占位；看 §7.2/§7.4 与 `/api/companion/status` |
| Windows 上 Ctrl+C 后仍有 `ace-server.exe` | 应不会发生（finally terminate→kill）；若有残留说明父进程被强杀，手动 `taskkill /IM ace-server.exe /F` 并反馈 |
| 上传失败 / 413 | 反向代理 body 上限太小；调大 NAS 反代上限（音频可能几十 MB） |

## 10. 约束与后续

- 只改 `scripts/companion.mjs`、`music-gen/tools/verify_companion.mjs`、`docs/COMPANION.md`；不改 core/server/web。
- 不新增 npm 依赖；Companion 只用 Node 内置模块。
- P2-A/P5-A 遗留（P2-B+）：cover（turbo 变体已有，cover 请求未接）、LoRA 真机质量验收、任务并发（目前单任务）、`/synth` 真实分段进度（LM/DiT/VAE）、WebSocket 推送、设备配对码与长期 token。
- P4-A 已完成：真实模型能力上报、任务优先级/变体匹配适配、空闲能力缺口自检（30s 节流）。
- P5-A 已完成：`generate_stem`（lego 分轨，base 变体，multipart request+audio）与 base 冷启动提示；后续调度策略（亲和性、预算、按账号配额）在服务端迭代。