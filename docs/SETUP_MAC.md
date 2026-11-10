# macOS 自动安装与验收（P8-A）

本文档对应「本机 AI 引擎自动安装」：在 macOS（Apple Silicon）上跑产品时，自动下载 ACE-Step 运行时与模型（sha256 校验、断点续传），装好后 Companion 自动识别并可用于生成音频。

> 现状：P8-A 已交付并验收（运行时+模型自动安装）。LoRA 适配器自动下载与「按需训练」是 P8-B/C，尚未完成，见 `docs/P8_PROGRESS.md`。

## 1. 环境要求

- macOS Apple Silicon（arm64；Intel Mac 目前会明确提示不支持自动安装）
- Node.js **>= 20.19**（推荐 24）
- pnpm（仓库是 pnpm workspace）
- 磁盘：基础 profile ≈ **3.4GB**；再加质量模式 ≈ **7.6GB**；再加分轨 ≈ **10.2GB**（另需少量临时下载空间）

## 2. 首次运行（两种方式任选）

### 方式 A：产品界面（推荐）

```bash
git clone https://github.com/Einsphoton/AIArrangementBuddy.git
cd AIArrangementBuddy
pnpm install
node scripts/build.mjs
node scripts/start.mjs        # 打开 http://127.0.0.1:8787
```

打开页面后，顶栏会出现 **「安装本机引擎」** 按钮：

1. 点开 → 选择能力（基础 / 质量模式 / 分轨）；
2. 点「开始下载」，面板里显示每个文件的进度与总体百分比；
3. 安装完成后按钮消失（引擎就绪）；若中途关闭页面，后端任务继续跑，重新打开可继续看进度（`GET /api/provision/jobs`）。

### 方式 B：命令行

```bash
node scripts/provision.mjs status --server http://127.0.0.1:8787
node scripts/provision.mjs install --profile essential,quality,stems --server http://127.0.0.1:8787
```

安装内容落到 `<数据目录>/ace-step/`（默认仓库下 `data/ace-step/`，可用 `AIAB_DATA_DIR` 指定）：

```
data/ace-step/
  ace-server             # macOS Metal 版运行时（另含 dylib / ace-lm / ace-synth 等）
  models/*.gguf          # 模型（HF Serveurperso/ACE-Step-1.5-GGUF）
  .downloads/            # 断点续传缓存（.part）
  runtime.json           # 已安装运行时版本/平台/sha256
```

## 3. 启动 GPU 工作节点（Companion）

```bash
node scripts/companion.mjs --server http://127.0.0.1:8787 --name "MacBook" --acestep --engine-idle 600
```

Companion 的路径解析顺序：
`AIAB_ACESTEP_DIR` > `<数据目录>/ace-step`（自动安装的位置）> `music-gen/acestep-cpp`（旧开发布局）；
计算后端默认 macOS 用 `METAL`（可用 `GGML_BACKEND` 覆盖）。

可用性自检：

```bash
node scripts/self-check.mjs --server http://127.0.0.1:8787   # 平台/运行时/模型/Companion/适配器 一览
node scripts/provision.mjs status --server http://127.0.0.1:8787
curl -s http://127.0.0.1:8787/api/companion/status | head
curl -s http://127.0.0.1:8787/api/adapters | head
```

在网页「生成音频」里用快模式生成一段 10–20s，任务中心显示完成即表示全链路 OK；需要更好音质勾选「质量模式（LM → sft 50 步）」。

## 4. 网络受限时（代理）

自动安装使用 Node 内置 fetch。Node 24 支持通过环境变量走代理：

```bash
export NODE_USE_ENV_PROXY=1
export HTTPS_PROXY=http://127.0.0.1:10808
export HTTP_PROXY=http://127.0.0.1:10808
node scripts/start.mjs
```

下载器支持断点续传：中断后重新点安装会从 `.part` 继续（需要 sha256 校验的场景会从头重下以保证正确性）。

## 5. 已验收证据（P8-A）

- `node --import tsx music-gen/tools/verify_provision.mjs`：**7/7**
  - 平台映射（win32-x64 / darwin-arm64 / linux-x64，Intel Mac 明确报错）
  - manifest profile/sha256 完整性
  - 下载器：sha256 校验、缓存命中、坏哈希删除重试、断点续传
  - tar.gz 解压（多文件/非 512 对齐）
  - 状态检测（空/部分/就绪）
  - **真实下载并解压 macOS 运行时**（官方 GitHub release，2.5MB，sha256 校验通过，`ace-server` 可执行权限）
- `node music-gen/tools/verify_p8_provision_ui.mjs`：**5/5**（拦截模拟下载，不真下 10GB）
  - 顶栏入口与平台/缺失大小；面板 3 个 profile；install 调用与进度到 100%；1024px 无溢出；无 console
- `node music-gen/tools/verify_companion.mjs`：**90/90**（跨平台路径/预检提示回归）

## 6. 边界与已知限制

- 模型下载源是公开 HuggingFace 仓库（`Serveurperso/ACE-Step-1.5-GGUF`），需要能访问 `huggingface.co`（受限网络请走代理）；运行时来自 GitHub Releases。
- Linux x64 运行时目前没有钉死 sha256（只有大小校验）；Windows/macOS 已钉死。
- **真实数据训练的适配器（real_jrpg_v1 / real_jrock_v1）不会分发**，只在你本机 Windows 上；P8-B 只发布自生成数据的适配器。
- P8-C「按需训练」尚未实现；现在 `music-gen/` 训练管线仍只在开发机存在。