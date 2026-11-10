# P8 自动本地化记录（Mac 开箱即用）

> 目标：在 macOS 上「跑起来就自动装好」——运行时/模型、LoRA 适配器、按需训练数据。过程产物与验收数字记录在此。

## 阶段 A：运行时 + 模型自动下载 ✅ 2026-11-10

### 交付
- **安装内核**（`apps/server/src/provision/`）
  - `manifest.ts`：钉死版本与哈希
    - 运行时：官方 GitHub `ace-step/acestep.vst3@v0.1.0` 的 windows-x64.zip（131MB, sha256 已钉）、macos-arm64-metal.tar.gz（2.5MB, sha256 已钉）、linux-x64.tar.gz（135MB，暂时按 size 校验）
    - 模型：公开 HF `Serveurperso/ACE-Step-1.5-GGUF`，6 个 GGUF（embedding/vae/turbo/sft/lm-1.7B/base），每个带 LFS sha256 与精确大小
    - profile：`essential`（3 个文件 ≈3.4GB）/ `quality`（+sft+lm ≈7.6GB）/ `stems`（+base ≈10.2GB）
  - `downloader.ts`：流式下载、`.part` 断点续传（Range）、大小+sha256 校验、坏包自动删除、进度回调
  - `untar.ts`：零依赖 tar.gz 解压（官方 macOS/Linux 包）；zip 复用 `sync/zip-read.ts`
  - `installer.ts`：状态检测（缺多少/哪个 profile 就绪）、安装任务（进度、步骤、取消），目录 `<数据目录>/ace-step/{models,.downloads,runtime.json}`
- **API**：`GET /api/provision/status`、`POST /api/provision/install`、`GET /api/provision/jobs/:id`、`POST .../cancel`
- **CLI**：`scripts/provision.mjs status|install|jobs`
- **产品 UI**：顶栏「安装本机引擎」→ 选 profile → 实时进度/步骤/取消；完成后自动隐藏（`features/audio/ProvisionButton.tsx`）
- **Companion 跨平台**：运行时搜索顺序 `AIAB_ACESTEP_DIR` > `<数据目录>/ace-step` > 旧 `music-gen/acestep-cpp`；二进制 `ace-server(.exe)`（含 bin/ 兼容）；计算后端 macOS 默认 `METAL`、其它默认 `CUDA0`；缺引擎时错误消息直接给自动安装命令

### 验收
| 项 | 结果 |
|---|---|
| 安装内核（tsx 直跑源码） | **7/7**：平台映射（Intel Mac 明确报错）、manifest/profile 完整性、下载器 sha256/缓存/坏哈希/断点续传、tar.gz 解压、状态检测、**真实下载解压 macOS 运行时** |
| 安装 UI | **5/5**：入口/平台与缺失大小、3 profile 面板、install 调用与进度到完成、1024px、无 console（fetch 拦截模拟，不真下 10GB） |
| Companion 回归 | **90/90**（跨平台路径与 preflight 提示） |
| CLI 真机 | `provision.mjs status` 返回平台/安装目录/各 profile 需下载大小/缺失模型清单 |

**关键证据**：`verify_provision.mjs` 里真实拉取 `acestep-macos-arm64-metal.tar.gz`（sha256 `8c94952e…`）→ 解压 → 发现 `ace-server`（2.0MB）→ 写 `runtime.json` → 二次安装命中缓存。

### 文档
`docs/SETUP_MAC.md`（环境、两种安装方式、Companion 启动、代理、验收命令、边界）

## 阶段 B：LoRA 适配器自动下载 ✅ 2026-11-10

### 交付
- **发布**：自生成数据的 3 个适配器已打包上传到本仓库 GitHub Releases `adapters-v1`：
  - `adapter-jrpg_v1.tar.gz`（17.1MB, sha256 `f07c710c…`）
  - `adapter-jrpg_v2.tar.gz`（34.1MB, sha256 `42116497…`）
  - `adapter-jrock_v1.tar.gz`（34.1MB, sha256 `14859aaf…`）
  - 包内是 `adapter.json` + `adapter_config.json` + `adapter_model.safetensors` + `verified.json`；**真实数据内部研究版不在发布清单中**
- **清单**：`ADAPTER_ASSETS`（id/名称/风格/license/大小/sha256/URL）随安装器下发，传未知 id 直接报错
- **安装器**：`installAdapters()` 下载 tar.gz → sha256 校验 → 解压到 `<数据目录>/adapters/<id>/`；已存在则跳过（缓存）
- **进安装任务**：`POST /api/provision/install` 支持 `adapters`（默认 true），任务里多一步「LoRA 适配器」并显示进度；`--no-adapters` 可跳过
- **状态/CLI**：`/api/provision/status` 与 `provision.mjs status` 显示每个适配器是否就绪、总大小；产品顶栏安装面板列出适配器勾选行
- **自检**：`node scripts/self-check.mjs` 显示适配器数量

### 验收
| 项 | 结果 |
|---|---|
| 安装内核（tsx 直跑） | **10/10**：原 7 项 + 适配器清单（无 real_*、sha256/URL/license）+ 状态检测 + **真实从 GitHub Releases 下载安装 3 个适配器并二次命中缓存** |
| 安装 UI | **5/5**：安装请求带 `adapters:true`、适配器选项行可见、进度到完成、1024px、无 console |
| CLI 真机 | `provision.mjs status` 显示 `LoRA 适配器：3/3 就绪（自生成数据，共 81MB）` |
| 安全边界 | 发布清单只有自生成数据版本；真实录音研究版只在本机 `data/adapters`，未进入 release |

## 阶段 C：训练按需下载与续接训练 🟡 进行中（2026-11-10 已交付基础设施）

### 已完成
- **训练代码包** `training-code-v1.tar.gz`（323KB，sha256 `92912e91…`）已发布到本仓库 Releases：
  - `acestep/{training,training_v2,models}` 最小子集 + `pyshim`（torchaudio→soundfile）+ `training/runner.py` + `requirements.txt` + MIT LICENSE（ACE-Step / Side-Step）
- **自生成训练数据集** `training-data-v1` 已发布（真实录音研究版不在其中）：
  - `dataset-jrpg_v1.tar.gz` 77,248,630B sha256 `61135a17…`
  - `dataset-jrpg_v2.tar.gz` 217,126,315B sha256 `ea9063af…`
  - `dataset-jrock_v1.tar.gz` 219,057,663B sha256 `3d0b1df3…`
- **检查点清单**：`apps/server/src/provision/trainingManifest.ts` 从 HF `ACE-Step/Ace-Step1.5` 钉死 16 个文件（turbo 4.57GB + VAE + Qwen3-Embedding，共 **6.34GB**），带 LFS sha256；另有独立 Python（python-build-standalone 3.12，macOS arm64 25.2MB sha256 `fbf4afef…`）
- **跨平台 runner**（`training/runner.py`）：环境变量驱动（`AIAB_TRAINING_CODE/CKPT/WORK/CACHE/SHIM`），支持 `--device auto|cuda|mps|cpu`、`--precision auto|bf16|fp16|fp32`；子进程 UTF-8、日志落盘、失败给 `TRAINING_FAILED reason=`、成功给 `TRAINING_DONE output= files= bytes=` 供服务端解析
- **真机验证**（Windows + CUDA 作为快速路径）：用新 runner 对 `jrpg_v1` 数据集跑 `preprocess + 3 epoch LoRA`：
  - 预处理 **12/12** 张量（93.7s）
  - 训练 36 步、loss 0.4244→0.3477、峰值 VRAM 4.7GiB（26s）
  - 产物 `final/adapter_model.safetensors` **21.1MB**；输出 `TRAINING_DONE output=… files=1 bytes=22069696`

### 后续交付（同日完成）✅
- **服务端** `apps/server/src/provision/training.ts`
  - `trainingStatus`：代码 / 数据集 / 独立 Python / 检查点 / venv 五阶段就绪与缺失字节
  - `setupTraining`：按需下载（代码包 323KB → 数据集 513MB → PBS Python 25MB → HF 检查点 6.34GB）→ 解压 → venv + pip 依赖（流式日志）
  - `startTraining`：spawn 训练 runner（cwd 公共根满足路径安全检查、UTF-8、日志），解析 `TRAINING_DONE` → 复制 final 权重 → 写 `adapter.json`（id/name/style/base/tasks/license/datasetNote/training 元数据）到 `data/adapters/<tag>/`
  - 任务模型：步骤进度 / 取消（终止子进程）/ 日志尾部；`AIAB_TRAINING_ALLOW_OVERRIDES=1` 时支持 sources 覆盖（真机验收/高级用户）
- **API**：`GET /api/training/status`、`POST /api/training/setup`、`POST /api/training/train`、`GET /api/training/jobs/:id`、`POST .../cancel`
- **CLI**：`scripts/training.mjs status|setup|train|jobs|cancel`
- **产品 UI**：顶栏「训练风格」→ 五阶段状态 → 「下载并准备环境」（显示约 6.9GB）→ 数据集/tag/风格/epochs/device/precision 表单 → 训练进度与日志 → 完成提示「已注册适配器 xxx」
- **真机验收**
  | 项 | 结果 |
  |---|---|
  | 训练 API 全链路（临时数据目录、真实 2 epoch） | **5/5**：status 结构/缺 6.9GB；train 启动；**73s 完成**；`/api/adapters` 出现新适配器 `p8c_api_*`（权重+adapter.json 落盘）；jobs 可查 |
  | 训练 UI（fetch 模拟） | **5/5**：入口；5 阶段与 6.9GB 提示；setup 调用→就绪→表单出现；train 参数（tag=ui_smoke, epochs=60）→完成→「已注册适配器」；1024px 无溢出、0 console |
  | 训练 runner（真实 GPU） | 预处理 12/12 + 2–3 epoch，`TRAINING_DONE output=… files=1 bytes=22069696` |

### 边界
- macOS MPS 路径：代码按 Side-Step 的 MPS/fp32 支持实现，runner 支持 `--device mps --precision fp32`；本轮无 Mac 硬件，仅平台模拟与文档验收（Mac 建议先小数据集、epochs 60–100）。
- 自动安装的 venv 依赖体积大（PyTorch 等约 2–4GB，仅首次训练时下载）；若用户已有 Python/torch 可用 sources 覆盖跳过。
- 真实数据内部研究版仍只在本机，不参与任何发布/训练数据下载清单。