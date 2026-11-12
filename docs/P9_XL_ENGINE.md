# P9 · ACE-Step XL（4B）引擎与「引擎量级」选择

> 日期：2026-11-12 · 目标：把 ACE-Step 1.5 **XL（4B DiT）** 接进产品，并让用户在客户端自己选择「用哪一档引擎」。
>
> 前置调研与实测证据见 [ACE_STEP_XL_INTEGRATION.md](./ACE_STEP_XL_INTEGRATION.md)（含 GGUF 哈希、旧运行时崩溃证据、上游构建验证）。

---

## 1. 一句话架构

- **运行时**分两种形态，由安装器的 `runtime.json` 标记：
  - `modern`（Windows x64）：上游 `acestep.cpp` 2026-11-06 预编译 + NVIDIA CUDA 13 redist DLL。支持 XL 4B，CLI 为 `--models <dir>`，HTTP 为**异步 job**（`POST /lm|/synth` → `{id}`，`GET /job?id=N[&result=1]`）。
  - `legacy`（macOS arm64 / Linux x64，或旧安装）：官方 `acestep.vst3` v0.1.0 归档，`--dit/--lm` + 同步 API，**只支持 2B**。
- **模型档**：新增 provisioning profile `xl`（`xl-turbo` + `xl-sft` + `xl-base` + `LM 4B`，Q8_0 共 ≈20.4GB）。
- **引擎量级**：任务参数 `params.engine: '2b' | 'xl'`（缺省 `2b`）。客户端 AI 面板可选「标准 2B / XL 4B」；质量模式在 XL 档自动走 `xl_sft + LM 4B`。
- Companion 能力上报 `capabilities.models` 增加 `xl_turbo / xl_sft / xl_base`（仅 modern 且模型文件存在时上报），服务端按 `requiredVariant` 精确匹配派单。

---

## 2. 运行时

### 2.1 平台矩阵

| 平台 | 运行时 | XL 支持 | 来源 |
|---|---|---|---|
| Windows x64 | **modern** | ✅ | 上游 `acestep.cpp` 2026-11-06 预编译（`serveurperso.com/temp/acestep.cpp-win64/build/Release/`，24 个文件逐文件钉 size+sha256）+ NVIDIA CUDA 13 redist（cudart / libcublas，sha256 已钉） |
| macOS arm64 | legacy | ❌ | 官方 `acestep.vst3` v0.1.0 Metal 归档（不变） |
| Linux x64 | legacy | ❌ | 官方 `acestep.vst3` v0.1.0 归档（不变） |

modern 运行时下载 ≈ 600MB（24 个文件 ≈184MB + CUDA zip ≈403MB）。安装后目录布局为 `<dataDir>/audio-engine/`（旧 `ace-step` 目录首次读取时自动迁移），CUDA DLL 与 `nvcudart_hybrid64.dll`（从 NVIDIA 驱动 DriverStore 复制，缺失仅告警）放在可执行文件同目录。

### 2.2 风险声明（重要）

modern 运行时来自上游作者的**未版本化临时目录**，不是官方 GitHub Release；上游随时可能替换文件。产品侧已做：

1. `MODERN_RUNTIME_FILES` / `CUDA_REDIST_ASSETS` **逐文件钉死 size + sha256**，下载后校验，不符即报错并删除半包；
2. 版本号固定为 `acestep.cpp-20261106`，写入 `runtime.json.version`；上游文件变化导致哈希不符时用户会看到明确错误；
3. 升级路径：后续若上游发布官方 Release（或自建 CI 产物），只需替换 `manifest.ts` 里的运行时来源与哈希，Companion 的 `modern` API 适配可复用；
4. **macOS / Linux 不启用 modern**（无对应构建），XL 档在这两个平台禁用并提示。

### 2.3 安装 / 升级语义

- Windows 旧用户（已装 legacy v0.1.0）：再次安装时检测 `runtime.json.api !== 'modern'`，**自动升级**（逐文件下载覆盖；旧文件保留同名覆盖）。
- 已装 modern 且 `version === acestep.cpp-20261106`、24 个文件与 CUDA DLL 齐全 → 缓存命中，秒过。
- 运行时状态（`GET /api/provision/status`）新增 `runtime.api` 与 `runtime.version`；`profiles` 增加 `xl`，只有「运行时 + essential 三件 + 4 个 XL 模型」全部就绪才为 `true`。

### 2.4 下载加速（国内网络）

XL 档模型体积大（≈20.4GB），国内直连 HuggingFace / 上游运行时目录很慢。P10 起安装器支持国内镜像（`hf-mirror.com` / `ghfast.top` / 自建 runtime 镜像）、多源分片并发下载与服务器离线包分发：在 **设置 →「引擎下载」** 切换策略与并发，安装面板的步骤行会显示当前下载源与实时速度（MB/s）。原理、配置项与排障见 [DOWNLOAD_ACCELERATION.md](./DOWNLOAD_ACCELERATION.md)。

---

## 3. 模型档（profile `xl`）

| 文件 | 大小 | 说明 |
|---|---:|---|
| `acestep-v15-xl-turbo-Q8_0.gguf` | 5.31GB | XL 快速（8 步），快模式选 XL 时用 |
| `acestep-v15-xl-sft-Q8_0.gguf` | 5.31GB | XL 质量（50 步），质量模式选 XL 时用 |
| `acestep-v15-xl-base-Q8_0.gguf` | 5.31GB | XL 分轨（lego） |
| `acestep-5Hz-lm-4B-Q8_0.gguf` | 4.46GB | XL 质量模式/分轨用的 4B LM |
| 合计（+essential 3.4GB） | ≈23.8GB | 需 ≥12GB 显存（20GB+ 更稳） |

模型来自 HF `Serveurperso/ACE-Step-1.5-GGUF`，逐文件钉 size + LFS sha256（与调研文档一致）。

---

## 4. 引擎量级契约（Companion ↔ Server 逐字一致）

### 4.1 参数与映射

任务参数：`engine?: '2b' | 'xl'`（缺省 `2b`），`quality?: boolean` 保留原语义（仅 `generate_audio`）。

| 任务 | `engine=2b` | `engine=xl` |
|---|---|---|
| `generate_audio`（快） | `turbo` | `xl_turbo` |
| `generate_audio`（`quality=true`） | `sft` + LM 1.7B | `xl_sft` + LM 4B |
| `cover_audio` | `turbo` | `xl_turbo` |
| `repaint_audio` | `sft` | `xl_sft` |
| `generate_stem` | `base` | `xl_base` |

服务端映射唯一实现：`apps/server/src/companion/store.ts` 的 `variantForTask(type, params)`；Companion 侧同规则实现于 `scripts/companion.mjs` 的 `inferRequiredVariant/variantForTask`。两端变体 id 必须逐字一致（`xl_turbo` 等用下划线）。

### 4.2 能力上报 / 派单

- Companion `capabilities.models`：`turbo/sft/base`（文件存在）+ `xl_turbo/xl_sft/xl_base`（**仅 modern 运行时**且文件存在）。
- 服务端按任务 `requiredVariant` 与 worker `models` 精确匹配派单；缺能力时任务进入 `blockedByCapability`，Companion 日志节流提示。
- 引擎心跳新增 `engine.lm`（`''`/`'1.7B'`/`'4B'`/`null`）与 `engine.api`（`legacy`/`modern`），任务中心/状态面板可见。

### 4.3 Companion 内部

- **modern**：一个常驻引擎进程（`--models <modelsDir>`），模型由请求体的 `synth_model`/`lm_model` 选择；**切换变体不重启**（只有 LoRA 适配器目录变化才重启）。`/lm`、`/synth` 走异步 job 轮询，结果 multipart 解析出 WAV；取消优先 `POST /job?id=N&cancel=1`（失败则杀引擎兜底）。
- **legacy**：保持原有行为（按变体启动 `--dit/--lm`，切变体重启，同步 API）。
- 质量档在 modern 下不再需要启动时 `--lm`，而是请求里带 `lm_model`；CoT/提示词增强流程不变。
- 新增日志：启动时打印「运行时形态：modern/legacy」「模型按请求按需加载（XL 首次约 30–60s）」；执行日志带 `engineLabel`（如 `xl_sft+LM(4B)`）。

---

## 5. 客户端

- AI 面板「音频引擎」菜单 →「高级参数」→ **引擎量级**：`标准 2B（快）` / `XL 4B（最佳质量）`，默认 2B，选择随任务提交为 `params.engine`；XL 与 LoRA 适配器互斥（基座不同）。
- 安装入口：「音频引擎」菜单 →「模型档位」卡片**常驻**（essential 就绪后不再隐藏），安装面板 4 行（基础 / 质量 / 分轨 / XL）；XL 行显示 ≈23.8GB、≥12GB 显存、仅 Windows 现代运行时。
- 可用性判断：`/api/provision/status` 的 `profiles.xl` 与 `/api/companion/status` 的 worker `capabilities.models` 双条件；不满足时 XL 选项禁用并给中文原因与入口指引；状态读取失败时不禁用、仅提示（不阻塞渲染）。
- 任务中心/阻塞提示用中文变体标签（XL 快速/质量/分轨）。

---

## 6. 验证

### 6.1 本次已完成的真机验证（RTX 5090 D v2 24GB，Windows）

| 项 | 方法 | 结果 |
|---|---|---|
| 旧运行时 + XL | `ace-server v0.1.0` 加载 `xl-turbo-Q4_K_M` | ❌ 日志按 `24L/H=2048` 误读，`/synth` 触发 `GGML_ASSERT(ggml_can_repeat)` 崩溃 |
| 上游 modern 运行时 + XL | 2026-11-06 预编译 + `xl-turbo-Q4_K_M` + LM 4B，直连 HTTP | ✅ `/props` 列出 XL，`[Load] DiT: 32 layers, H=2560`，输出 48k/立体声 WAV |
| Companion modern 2B 快模式 | 注入 env 指向 modern 运行时/模型目录，`executor.run(generate_audio)` | ✅ 引擎 1.3s 就绪，异步 job 出 WAV（6s 音频，受显存压力约 36s） |
| Companion modern XL 快模式 | `engine='xl'` → `xl_turbo` | ✅ 出 WAV（6s 音频约 56.5s；显存被其它进程占用约 18.8GB，仅功能验证） |
| **服务端 + Companion 全链路（P9 e2e）** | 临时数据目录（modern runtime + XL 模型）→ `apps/server/dist/server.mjs` + `scripts/companion.mjs --acestep` → 通过 `POST /api/companion/tasks` 提交 2B / XL 任务 | ✅ Companion 上报 `models=[turbo,sft,base,xl_turbo,xl_sft,xl_base]`；2B 任务 `requiredVariant=turbo` 44.2s、XL 任务 `requiredVariant=xl_turbo` 24.1s（同一常驻引擎，切变体不重启），产物均 **48000Hz / 2ch / 6.00s / 1,152,044B**；非法 `engine=4b` 返回 **400** |
| 服务端/UI 回归 | `node scripts/test.mjs`、`node scripts/test-ai.mjs` | ✅ 12/12、24/24 |
| 安装/引擎档 UI | `node music-gen/tools/verify_p8_provision_ui.mjs http://127.0.0.1:8899`（已构建产物 + headless Chrome） | ✅ 9/9：顶栏入口、4 档面板（XL 不默认勾选/23.8GB/12GB）、安装进度、模型档位入口常驻、XL 未装时禁用并解释、XL 就绪且节点上报 `xl_turbo` 时可选并提交 `params.engine=xl`、非 Windows 平台 XL 禁用、1024px 无溢出 |
| 安装内核/状态 | `node music-gen/tools/verify_provision.mjs` | ✅ 16/16（2 个真实网络下载用例默认跳过）：modern 24 文件 + CUDA 清单哈希、modern 离线安装/缓存/升级、XL 档就绪判定、legacy 兼容 |
| Companion 逻辑 | `node music-gen/tools/verify_companion.mjs` | ✅ 103/103：modern 启动参数/异步 job/变体映射/XL capabilities/legacy 拒绝 XL 等 |

### 6.2 命令

```powershell
# 类型检查（DSH 沙箱里 scripts/typecheck.mjs 会假失败，用直连 tsc）
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p apps/server/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit

# Companion 纯逻辑（离线）
node music-gen/tools/verify_companion.mjs

# 构建（沙箱内可能 spawn EPERM，需普通终端）
node scripts/build.mjs

# 本机引擎安装（真实网络，~600MB 运行时 + 模型按档）
$env:AIAB_DATA_DIR="D:\tmp\aiab-p9"; node scripts/provision.mjs install --profile xl
node scripts/provision.mjs status

# 真机全链路：先起服务端，再起 Companion（用安装好的数据目录）
$env:AIAB_DATA_DIR="D:\tmp\aiab-p9"; node scripts/start.mjs
$env:AIAB_DATA_DIR="D:\tmp\aiab-p9"; node scripts/companion.mjs --server http://127.0.0.1:8787 --acestep
```

> 测试期间本机 GPU 有其它进程占用约 18.8GB 显存，XL 相关耗时被 WDDM 换页放大；干净机器上 XL Q8 生成 20s 音频预期明显更快（上游 issue #51：12GB 卡可跑、#105：24GB 舒适）。

### 6.3 尚未覆盖 / 后续项

- modern 运行时下 `cover_audio` / `repaint_audio` / `generate_stem` 的**真机**验收（代码路径已按新 API 适配，但依赖请求字段/调度细节，建议 P9.1 用真实数据逐条回归）。
- macOS/Linux 的 XL（无 modern 构建，档位禁用）。
- XL LoRA / XL 训练（现有适配器绑定 2B；XL LoRA 需 19GB 检查点，单独立项）。
- 上游正式 Release 出现后，应把运行时来源从临时目录换成官方发布并更新哈希。

---

## 7. 回退

- 模型档全可选：`xl` profile 不改变 2B 的 `essential/quality/stems` 语义；不装 XL 的用户行为与 P8 一致。
- 运行时：可用 `AIAB_ENGINE_DIR`（兼容旧 `AIAB_ACESTEP_DIR`）指向旧 v0.1.0 目录 + `AIAB_ACESTEP_API=legacy` 强制 legacy（Companion 自动按 legacy 行为工作）；`runtime.json` 是唯一判定依据（env 可覆盖）。
- 代码回退：删除 `xl` profile / XL MODEL_FILES / `engine` 参数及相关 UI 即可，不涉及数据迁移（已装 XL 文件按 size 自然显示为未就绪）。

---

## 8. 文件改动一览

| 区域 | 文件 |
|---|---|
| 运行时/模型安装 | `apps/server/src/provision/manifest.ts`、`installer.ts`、`apps/server/src/routes/provision.ts`、`scripts/provision.mjs` |
| Companion | `scripts/companion.mjs`（dual runtime、modern job 客户端、XL 变体/引擎档位、capabilities/heartbeat） |
| 服务端协议 | `apps/server/src/companion/store.ts`、`apps/server/src/routes/companion.ts`、`apps/server/src/routes/vst3.ts`、`apps/server/src/tools/audio.ts` |
| 客户端 | `apps/web/src/lib/api.ts`、`features/audio/{GenerateAudioPanel,SongWorkflow,ProvisionButton,AudioEngineMenu,TaskCenterPanel,audioIntent}.tsx/ts` |
| 验收 | `music-gen/tools/verify_companion.mjs`、`verify_provision.mjs`、`verify_p8_provision_ui.mjs` |
| 文档 | 本文件、`README.md`、`docs/COMPANION.md`、`docs/SETUP_MAC.md`、`docs/ACE_STEP_XL_INTEGRATION.md`（状态更新） |
