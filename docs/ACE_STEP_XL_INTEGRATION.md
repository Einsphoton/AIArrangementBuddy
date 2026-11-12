# ACE-Step 新模型（XL 4B）集成评估

> 评估日期：2026-11-12 · 机器：Windows 11 / RTX 5090 D v2（24GB）
>
> **状态更新（2026-11-12 晚）**：本评估之后的 **P9 集成已完成**（方案 B1：Windows 现代运行时 + `xl` 模型档 + 客户端「引擎量级」选择）；产品实现与验证见 [P9_XL_ENGINE.md](./P9_XL_ENGINE.md)。本文保留为调研/证据记录（哈希、旧运行时崩溃证据、上游构建验证）。
>
> 结论先行：**ACE-Step 确实发布了新模型（ACE-Step 1.5 XL，4B DiT，2026-04-02）**，GGUF 权重 2026-04-07/08 已齐备。但本产品钉死的官方 C++ 运行时（`acestep.vst3` v0.1.0/v0.1.1，2026-03）**不支持 XL**，且官方 Windows 运行时没有后续版本 —— 所以「零成本快速接上 XL」不成立，需要先解决运行时来源，再做 CLI/HTTP API 适配（约 1–2 人日）。
>
> 本机已用上游 2026-11-06 预编译运行时 + `xl-turbo-Q4_K_M` + LM 4B 成功生成 48kHz 立体声 WAV，并用旧运行时复现了 XL 加载崩溃；两条路径都已有可复现证据。

---

## 0. 一页结论

| 问题 | 结论 |
|---|---|
| 有新模型吗？ | **有**：ACE-Step 1.5 **XL（4B DiT）** `xl-turbo / xl-sft / xl-base / xl-sftturbo50`，2026-04-02 发布；**没有** 1.6 / 2.0。 |
| GGUF 权重有吗？ | **有**：HF `Serveurperso/ACE-Step-1.5-GGUF`，XL 4 变体 × 5 量化（Q4_K_M / Q5_K_M / Q6_K / Q8_0 / BF16），Q8_0 ≈ 5.31GB/个；sha256 已核（见 §1.2、附录 B）。 |
| 现有产品能跑吗？ | **不能**：v0.1.0 把 XL 误读成 24L/H=2048 的 2B DiT，`/synth` 时 `GGML_ASSERT(ggml_can_repeat(...)) failed` 直接崩（本机实测，§3.1）。 |
| 上游 C++ 能跑吗？ | **能**：acestep.cpp 自 2026-04-07 支持 XL；本机用上游 2026-11-06 预编译 + `xl-turbo-Q4_K_M` + LM 4B 成功出音频（§3.2）。但新 CLI/HTTP API 是 **breaking change**。 |
| 能快速集成吗？ | XL **不能快速**（需要新运行时 + 双 API 适配 + 变体协议 + ≥5.3GB 模型下载）。零运行时改动的只有 LM 4B / 2B 新变体——那**不是**这次的新模型。 |
| 官方何时支持？ | **未知**：`ace-step/acestep.vst3` master 停在 2026-03-26，v0.1.1 无 Windows 包且与 v0.1.0 **零源码差异**；上游 acestep.cpp 无 Release、无版本化二进制。 |

---

## 1. 新模型事实

### 1.1 XL 4B DiT（2026-04-02）

- 官方发布：<https://github.com/ace-step/ACE-Step-1.5/releases/tag/v0.1.6>
  - 4B 参数 DiT（32 层，H=2560），11 项 benchmark 全胜；bf16 ≈9GB，**显存 ≥12GB（带 offload）起步，20GB+ 推荐**。
  - LM 全兼容（0.6B / 1.7B / 4B）。
- 模型卡（Model Zoo / GPU 分级）：<https://github.com/ace-step/ACE-Step-1.5#-model-zoo>
- GGUF 上传时间（HF API commits）：2026-04-07T11:48Z 上传 `xl-turbo/xl-sft/xl-base`；2026-04-08T18:57Z 上传 `xl-sftturbo50`。
- 直接实测证据（C++ 侧）：上游 `acestep.cpp` 加载日志 `[Load] DiT: 32 layers, H=2560, Nh=32/8, D=128`，见 §3.2。

### 1.2 XL GGUF 关键文件（HF `Serveurperso/ACE-Step-1.5-GGUF`）

来源：HF 官方 API `https://huggingface.co/api/models/Serveurperso/ACE-Step-1.5-GGUF/tree/main?recursive=true`（本次通过 Python 直连官方 API 获取；下载后的实际文件 sha256 与 LFS oid 一致，见附录 B）。

| 文件 | 字节 | sha256（LFS oid） |
|---|---:|---|
| `acestep-v15-xl-turbo-Q8_0.gguf` | 5,305,828,736 | `4f1044fb646374fb5730e10f64325766883eb2fc02a643c1b403f2d61f39dc19` |
| `acestep-v15-xl-turbo-Q4_K_M.gguf` | 2,989,922,688 | `475e60e8644b1f91eebc0cd25f24c060bed06e64a862b4e60ffafe634c740478` |
| `acestep-v15-xl-sft-Q8_0.gguf` | 5,305,828,704 | `d7b06fadab214375ef5ebcfa44bf4a10489ea364b119f5b9ecbcd870408bdab9` |
| `acestep-v15-xl-sft-Q4_K_M.gguf` | 2,989,922,656 | `fa144d3ea8a892a11a43753070e40bb2105c5bfddb57c99d542fda22297bb1b5` |
| `acestep-v15-xl-base-Q8_0.gguf` | 5,305,828,704 | `45d05b88ccbfa0ea27208ea618d7f0749b2be040b457cfa661d37646ea39f207` |
| `acestep-v15-xl-base-Q4_K_M.gguf` | 2,989,922,656 | `13b08ac84e0cdca8ac770d6bc12842046113c9479ddcedd2672ac87ac458ff78` |
| `acestep-v15-xl-sftturbo50-Q8_0.gguf` | 5,305,828,768 | `ec6bef50f2aec3176aafa4836401394913f567ceb7a4d53a459948a8b5294e51` |

### 1.3 其他新 / 可选权重（同仓库）

- **2B `sftturbo50`**（2026-04-08，SFT/Turbo 融合，50 步用）：`acestep-v15-sftturbo50-Q8_0.gguf` 2,549,527,936 B / `3fab14cf0d8efa249edf49b6fd0392bac54f1a80514567a5ae4164853339ecb3`。
- **2B `turbo-shift1` / `turbo-shift3` / `turbo-continuous`**：采样 shift 专用变体，Q8_0 ≈ 2.55GB/个。
- **LM 4B**（2026-01 已有，**不是本次新模型**）：`acestep-5Hz-lm-4B-Q8_0.gguf` 4,457,323,648 B / `972f91147a167f0c041f1b158d67985a82c0f6a852e68cdf70e46030cf08b1bc`。
- Text encoder / VAE 与现有相同（`Qwen3-Embedding-0.6B-Q8_0.gguf`、`vae-BF16.gguf`）。

### 1.4 没有更新的基座

- ACE-Step-1.5 最新 release 仍是 **v0.1.8（2026-05-18，Docker / Retake / Flow-Edit，无新权重）**；无 1.6 / 2.0；HF ACE-Step org 2026-04 之后只有 XL 的 diffusers 转换与工具更新。
- 结论：**「新模型」= XL 4B 系列**，不存在更晚的基座模型。

---

## 2. 运行时现状（为什么现在接不了 XL）

### 2.1 产品钉死的官方运行时（`apps/server/src/provision/manifest.ts`）

- `v0.1.0`（2026-03-24）：Windows 包 `acestep-windows-x64.zip` 137,805,556 B / `636f1d9bb7b8966f0a0c35dfad0f19edb122cb6e79f7d9a00232f4b51e7b4108`（产品当前使用）。
- `v0.1.1`（2026-03-25）：**只有 linux / macos 资产，无 Windows 包**；与 v0.1.0 相比仅 2 个 commit、只改 `.github/workflows/release.yml` / `README.md` / `docs/model-conversion.md`，**零源码差异** → 升级 v0.1.1 不会带来任何模型能力。
- 该运行时 CLI：`--lm / --embedding / --dit / --vae / --lora / --sleep`；HTTP：同步 `/lm`、`/synth?wav=1`、`/understand`、`/health`、`/props`；**无 `/job`**。
- 仓库存档证据：`ace-step/acestep.vst3` master 最后一次提交 **2026-03-26**，此后未跟进上游。

### 2.2 上游 `acestep.cpp`（XL 支持来源）

- XL 支持落地：**2026-04-07**（commit `0308fa50` 等：XL decoder H=2560、cond-encoder 2048 维度桥接、timbre CLS token）；仓库最新 commit 2026-11-06。
- **CLI breaking**：模型选择改为 `--models <dir>`，旧 `--lm/--embedding/--dit/--vae/--lora/--sleep/--mp3-bitrate` 全部删除；模型选择移到请求 JSON 的 `lm_model` / `synth_model` / `adapter`。
- **HTTP breaking**：`POST /lm|/synth|/understand|/vae` 改为异步 job（返回 `{"id":"N"}`，`GET /job?id=N[&result=1]` 取结果，`POST /job?id=N&cancel=1` 取消）；`/props` 结构改为 `models.{lm,embedding,dit,vae}` + `cli` + `default`；`--vae-chunk` 默认 256 → 1024。
- **无 GitHub Release、无版本化二进制**：Windows 预编译只在 README 指向的 <https://www.serveurperso.com/temp/acestep.cpp-win64/>（未版本化、无校验清单）。本次实际拉到的是 **2026-11-06 12:16** 的 `build/Release/` 构建（含 `ace-server.exe` + 7 个工具 + ggml DLL，共 ~184MB）。

---

## 3. 本机 spike（2026-11-12）

> **环境注意（影响耗时，不影响功能结论）**：测试期间本机桌面有其它进程占用约 **18.8GB 显存**（`nvidia-smi`：used 18777 MiB / 24555 MiB，util 0%），可用显存仅 ~5GB；下面 LM 4B / XL 的耗时被 WDDM 换页显著放大，**只作功能性证据**，不代表干净机器性能。旧运行时 + 1.7B LM 的 2B 链路在同一环境下仍是 6.7s + 13.9s（20s 音频、sft 50 步），说明 2B 链路本身正常。

### 3.1 旧运行时（v0.1.0）+ XL 权重 → **失败（决定性证据）**

- 加载时日志：`[Load] DiT: 24 layers, H=2048, Nh=16/8, D=128` —— XL 实际是 32L/H=2560，被按 2B 结构误读。
- `/health` 返回 200（服务能起），`POST /synth` 推理中崩溃：
  `D:\a\acestep.vst3\acestep.vst3\ggml\src\ggml.c:2004: GGML_ASSERT(ggml_can_repeat(b, a)) failed`
- 结论：**旧运行时不能运行 XL**；把 XL GGUF 放进 `models/` 也只会在推理时崩，不能靠改文件名/参数绕过。

### 3.2 上游 2026-11-06 预编译 + `xl-turbo-Q4_K_M` + LM 4B → **成功**

- `/props`：`{"lm":["acestep-5Hz-lm-4B-Q8_0.gguf"],"embedding":["Qwen3-Embedding-0.6B-Q8_0.gguf"],"dit":["acestep-v15-xl-turbo-Q4_K_M.gguf"],"vae":["vae-BF16.gguf"]}`
- 加载日志：`[Registry] ...`、`[Load] DiT: 32 layers, H=2560, Nh=32/8, D=128`、`[Store] Load DiT: 54710 ms`
- `/lm` → `bpm=83, key=D minor, codes=513 字符`；`/synth`（`output_format=wav16`，8 步 / shift 3.0）→ **3,456,044 字节 WAV**
- 音频校验（soundfile）：**48000 Hz / 2ch / 18.0s / RMS 0.230 / peak 1.000**（真实音乐信号，非静音）
- 耗时（显存受压）：LM 73.6s，synth 117.2s
- 证据文件：`.cache/acestep-hq/out/xl-turbo-q4_lm4b.wav`、`engine-xl.log`（本地缓存，未入库）

### 3.3 旧运行时 + LM 4B（质量档现状可行性）

- `/lm` 73.4s / `/synth` 153.8s（同环境 1.7B 对照 6.7s / 13.9s；差异主要来自显存换页与 4B LM 权重/KV 占用）。
- 结论：LM 4B 在旧运行时**可用**（属可选质量档升级，不是本次新模型）。

---

## 4. 集成方案与工作量

### 方案 A：零运行时改动（可立即做，但**不是 XL**）

**A1. LM 4B 可选质量档（推荐作为顺手项，约 1 人日）**

- `apps/server/src/provision/manifest.ts`：`MODEL_FILES` 加 LM 4B（size/sha256 见 §1.3）；`ProvisionProfile` 加 `'hq'`；`profileLabel` 加分支。
- `apps/server/src/provision/installer.ts:171-180`：`profiles` 记录加 `'hq'`；`apps/server/src/routes/provision.ts:24,46-55`：`VALID_PROFILES` / status 列表同步。
- `apps/web/src/lib/api.ts:675`、`features/audio/ProvisionButton.tsx`（`PROFILE_ORDER`、面板行、入口发现性）。
- `scripts/companion.mjs:99-104,1236-1242`：`MODEL_AUX.lm` 改为“4B 优先、1.7B 回退”（或环境变量 `AIAB_ACESTEP_LM` 覆盖）；注意 `EngineManager` 的 `lm` 目前是 boolean（`engineDecision`），多档必须先升级引擎身份。
- 验收：`node music-gen/tools/verify_companion.mjs`（现基线 90/90）、`verify_provision.mjs`、`verify_p8_provision_ui.mjs` 断言同步（新增独立 profile 不会触发 `essential=3/quality=5/stems=4` 断言，但 `rows===3` 需改）。
- 代价：+4.46GB 下载；LM 阶段显存/时间上升（12GB 卡偏紧）；收益：质量档提示词/歌词/编码更强。

**A2. 2B 新变体（`sftturbo50` / `shift*`，约 0.5–1 人日）**

- 同结构加 manifest/companion 变体映射；需先做听感 A/B（本机有 `music-gen/tools/hf_sweep.py` 的频谱统计可复用）。风险：变体命名/默认步数语义需确认，收益不确定。

### 方案 B：XL 预览（真正集成新模型，约 1–2 人日）

前提是先拍板运行时来源：

- **B1 用上游未版本化预编译**（本次已下载并验证可跑）：最快，但来源是个人站点、无版本/校验清单 → 产品层面供应链风险，需自行钉 sha256（附录 B 已给出本次构建的哈希）。
- **B2 自建 CI / 本机构建**（正式版建议）：Windows 需 VS Build Tools + CUDA 13 + Ninja；Linux/mac 需对应工具链；产物作为本仓库 Release 发布并钉哈希（当前本机无 cmake/MSVC/nvcc，需先装工具链）。

改动面（来自只读审计）：运行时清单替换 → Companion 启动参数改 `--models` + HTTP 客户端改异步 job（`/lm`、`/synth`、取消、进度、multipart 结果解析）→ 变体协议扩展（`ENGINE_VARIANTS` 加 `xl_turbo/xl_sft/xl_base`；`apps/server/src/companion/store.ts`、`routes/companion.ts`、`routes/vst3.ts` 联合类型与能力匹配同步）→ 新 `xl` profile + UI 入口发现性 + 显存提示 → 验收脚本与文档同步。**v1 建议只做 XL 快模式**：不动 `quality` 语义（仍 2B sft+LM 1.7B）、不动 LoRA/训练（现有适配器绑 2B，XL LoRA 需 19GB 检查点，单独立项）。

### 方案 C：等官方

- 官方 `acestep.vst3` 已约 7.5 个月未跟进上游、无排期；不建议等。

---

## 5. 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 运行时供应链 | B1 来源无版本、随时可能变；B2 需搭构建/发布链 | 优先 B2；B1 仅内部预览且钉 sha256 |
| 显存 | XL Q8 权重 5.3GB + 文本/条件编码 + VAE；6GB 卡 VAE decode OOM（上游 #103），12GB 可跑（#51），20GB+ 舒适（#105） | profile 标注 ≥12GB；失败降档 2B |
| API 兼容 | 新旧运行时 CLI/HTTP 完全不兼容 | engine version 探测 + 双端同步发版；旧客户端连新引擎明确报错 |
| LoRA | 现有 3 个适配器是 2B，XL 不可复用（core `adapters.ts` 已预留 `xl_*` 基座字段） | 文档明确；XL LoRA 单独立项 |
| 性能/ETA | XL 每步更重、冷启动更慢，现有 ETA 按 2B 系数 | 重估 `estimateGenerationSeconds` 与服务端平均耗时 |
| 验证缺口 | `verify_companion/mjs`、`verify_provision.mjs` 等不在 `package.json scripts`，改动不会被 `pnpm verify` 覆盖 | 加 `verify:provision` 入口并更新断言 |

---

## 6. 建议（需要拍板）

1. **如果只想“快速拿到收益”**：做 A1（LM 4B 可选档），1 人日；XL 先不动。
2. **如果目标是“真正用上新模型 XL”**：按 B 立项，先定运行时来源。建议 **B1 做内部预览（本机前置已就绪，今天就能开始）**，**B2 作为正式版路径**；v1 只做 XL 快模式，不碰质量模式/LoRA/训练。
3. 不建议等官方（无排期）。

---

## 附录 A：关键 URL

- 官方发布 v0.1.6（XL）：<https://github.com/ace-step/ACE-Step-1.5/releases/tag/v0.1.6>
- 官方模型卡（Model Zoo / GPU 分级）：<https://github.com/ace-step/ACE-Step-1.5#-model-zoo>
- GGUF 仓库文件树（HF 官方 API）：<https://huggingface.co/api/models/Serveurperso/ACE-Step-1.5-GGUF/tree/main>
- 上游 C++ 文档（XL 规格 / 新 CLI / 新 API）：<https://raw.githubusercontent.com/ServeurpersoCom/acestep.cpp/master/docs/ARCHITECTURE.md>
- 官方运行时 releases（v0.1.0/v0.1.1）：<https://github.com/ace-step/acestep.vst3/releases>
- 运行时仓库最后提交：<https://github.com/ace-step/acestep.vst3/commits>
- 上游预编译 Windows 构建（未版本化）：<https://www.serveurperso.com/temp/acestep.cpp-win64/>

## 附录 B：本次实测文件哈希

模型（下载后本地 sha256 与 HF LFS oid 一致）：

- `acestep-5Hz-lm-4B-Q8_0.gguf`：4,457,323,648 B，`972f9114…b1bc`（完整值见 §1.3）
- `acestep-v15-xl-turbo-Q4_K_M.gguf`：2,989,922,688 B，`475e60e8…0478`（完整值见 §1.2）

上游 2026-11-06 预编译运行时（`serveurperso.com/temp/acestep.cpp-win64/build/Release/`，供 B1 钉哈希用）：

| 文件 | 字节 | sha256 |
|---|---:|---|
| `ace-server.exe` | 1,431,552 | `b05ed4e8dd7efeb08640bae505e919a3c9cab4357b76af306d2993460bb0806d` |
| `ace-lm.exe` | 422,912 | `009ac2d8f8b39a75a4114951f86198ec97746cfc9f1ee1349345d63078772e89` |
| `ace-synth.exe` | 645,632 | `3cea88b5704fdb893d8e473856d93f79567f628ccf68f188eb902166b4e4200b` |
| `ace-understand.exe` | 442,368 | `31e2f0ab67554401c3254880d0528e8c4a7a59d12080d1ac6e40a81779892532` |
| `ggml-cuda.dll` | 137,519,104 | `6d138427fd8676a5ad8eba33d1001ae402a457e3a33bfd174590f6199878249a` |
| `ggml-vulkan.dll` | 41,986,048 | `cd88ab17d7ab5d104a6e38f4feb06a8fd0eff3b8ff01ac41c859074de1dec9bd` |
| `ggml.dll` | 61,440 | `34ef1d8b3f0dc891b85c397653a722af0ba844921d25a7721d5c81eb0f157b05` |

> 注意：该目录**未版本化**，上游可能随时替换文件；B1 必须同时固化哈希并在下载时校验，且明确告知用户这是预览源。

## 附录 C：本机复现步骤

基线（项目现有运行时，v0.1.0）：

```powershell
# 旧运行时 + XL 权重：应复现 24L 误读 + GGML_ASSERT 崩溃
music-gen/acestep-cpp/bin/ace-server.exe --host 127.0.0.1 --port 17993 `
  --embedding music-gen/acestep-cpp/models/Qwen3-Embedding-0.6B-Q8_0.gguf `
  --dit .cache/acestep-hq/models/acestep-v15-xl-turbo-Q4_K_M.gguf `
  --vae music-gen/acestep-cpp/models/vae-BF16.gguf
# 日志看 [Load] DiT: 24 layers；再 POST /synth?wav=1 触发 ggml_can_repeat 断言
```

上游新运行时 + XL（本次成功路径）：

```powershell
# .cache/acestep-hq/runtime = 2026-11-06 预编译；.cache/acestep-hq/xlmodels = 硬链接的 4 个模型
.cache/acestep-hq/runtime/ace-server.exe --models .cache/acestep-hq/xlmodels `
  --host 127.0.0.1 --port 17991
# POST /lm {"caption":"...","lyrics":"[Instrumental]","duration":20,"lm_model":"acestep-5Hz-lm-4B-Q8_0.gguf"}
# 轮询 GET /job?id=N → GET /job?id=N&result=1 取 JSON
# POST /synth （JSON 含 synth_model + output_format:"wav16"）→ 轮询 → multipart 取 audio 段
```

> 本次验证脚本在 `.cache/`（已被 `.gitignore` 忽略）；如需长期保留，建议后续在 `music-gen/tools/` 增加 `spike_acestep_xl.py` 并接入验收流程。
