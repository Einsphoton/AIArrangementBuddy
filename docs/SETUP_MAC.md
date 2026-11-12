# macOS 自动安装与验收（P8-A）

本文档对应「本机 AI 引擎自动安装」：在 macOS（Apple Silicon）上跑产品时，自动下载 ACE-Step 运行时与模型（sha256 校验、断点续传），装好后 Companion 自动识别并可用于生成音频。

> 现状：P8-A 已交付并验收（运行时+模型自动安装）。LoRA 适配器自动下载与「按需训练」是 P8-B/C，尚未完成，见 `docs/P8_PROGRESS.md`。
>
> **P9（2026-11）更新**：Windows 侧运行时已升级为上游 `acestep.cpp` modern 构建（支持 XL 4B），并新增 `xl` 模型档；**macOS / Linux 仍使用官方 legacy 运行时（v0.1.0），不支持 XL**，安装面板里的 XL 档在这些平台会显示「当前平台不支持」。详见 [P9_XL_ENGINE.md](./P9_XL_ENGINE.md)。

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

1. 点开 → 选择能力（基础 / 质量模式 / 分轨）+ 默认勾选「LoRA 适配器（风格包，约 81MB）」；
2. 点「开始下载」，面板里显示每个文件的进度与总体百分比；
3. 安装完成后按钮消失（引擎就绪）；若中途关闭页面，后端任务继续跑，重新打开可继续看进度（`GET /api/provision/jobs`）。

### 方式 B：命令行

```bash
node scripts/provision.mjs status --server http://127.0.0.1:8787
node scripts/provision.mjs install --profile essential,quality,stems --server http://127.0.0.1:8787
```

安装内容落到 `<数据目录>/ace-step/`，适配器落到 `<数据目录>/adapters/`（默认仓库下 `data/`，可用 `AIAB_DATA_DIR` 指定）：

```
data/ace-step/
  ace-server             # macOS Metal 版运行时（另含 dylib / ace-lm / ace-synth 等）
  models/*.gguf          # 模型（HF Serveurperso/ACE-Step-1.5-GGUF）
  .downloads/            # 断点续传缓存（.part）
  runtime.json           # 已安装运行时版本/平台/sha256

data/adapters/           # LoRA 适配器（自生成数据，GitHub Releases adapters-v1）
  jrpg_v1/ jrpg_v2/ jrock_v1/   # 每个含 adapter.json/config/权重
```

## 3. 启动 GPU 工作节点（Companion）

```bash
node scripts/companion.mjs --server http://127.0.0.1:8787 --name "MacBook" --acestep --engine-idle 600
```

Companion 的路径解析顺序：
`AIAB_ACESTEP_DIR` > `<数据目录>/ace-step`（自动安装的位置）> `music-gen/acestep-cpp`（旧开发布局）；
计算后端默认 macOS 用 `MTL0`（ggml 的 Metal 后端名；可用 `GGML_BACKEND` 覆盖，填 `METAL` 会启动失败）。

可用性自检：

```bash
node scripts/self-check.mjs --server http://127.0.0.1:8787   # 平台/运行时/模型/Companion/适配器 一览
node scripts/provision.mjs status --server http://127.0.0.1:8787
curl -s http://127.0.0.1:8787/api/companion/status | head
curl -s http://127.0.0.1:8787/api/adapters | head
```

在网页「生成音频」里用快模式生成一段 10–20s，任务中心显示完成即表示全链路 OK；需要更好音质勾选「质量模式（LM → sft 50 步）」。

## 4. 网络受限时（代理）

自动安装使用 Node 内置 fetch：ACE-Step 运行时来自 GitHub Releases，模型来自 HuggingFace（`huggingface.co`）。新版下载链路会**自动识别代理**，国内网络通常不用手动配置：

- **环境变量代理**：终端里设置过 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`（大小写均可）即可。
  启动脚本 `launch.mjs` / `dev.mjs` / `start.mjs` / `supervise.mjs` 检测到后会为服务端子进程自动补
  `NODE_USE_ENV_PROXY=1`，并打印一行 dim 提示：`[proxy] 检测到 HTTPS_PROXY，已为服务端子进程启用 NODE_USE_ENV_PROXY=1`。
- **macOS 系统代理**：系统设置 → 网络 → 代理（Clash / Surge 等软件的「系统代理」模式）开启后，
  下载层会读取 `scutil --proxy`，即使没有环境变量也能走代理。

`NODE_USE_ENV_PROXY=1` 的作用：Node 内置 fetch（undici）默认**不读**代理环境变量，只有**进程启动时**
带上该变量才会启用 `EnvHttpProxyAgent`。所以：

1. 启动脚本会自动补，一般无需手动设置；如果你自己在终端显式设置（包括设为 `0` 关闭），启动脚本不会覆盖；
2. **改完代理设置或环境变量后必须重启应用**（`NODE_USE_ENV_PROXY` 只在启动时生效）：
   `Ctrl+C` 停掉后重新执行 `node scripts/launch.mjs`（或 `pnpm dev` / `pnpm start`）；
3. 该变量同时让服务端其它 fetch（AI 服务商、联网搜索等）走代理。

手动指定代理（端口换成你代理软件的 HTTP 端口，常见 7890 / 10808 / 10809）：

```bash
export HTTPS_PROXY=http://127.0.0.1:10808
export HTTP_PROXY=http://127.0.0.1:10808
export ALL_PROXY=http://127.0.0.1:10808
node scripts/launch.mjs
```

> 说明：Node 内置 fetch 仅支持 HTTP(S) 代理（CONNECT 隧道），不支持 `socks5://`；请填代理软件提供的 HTTP 端口。
> 面板里下载失败时，错误框下方会给出「开启代理 / 复制诊断命令」的可操作提示。

### 故障排查

| 现象（面板或日志） | 可能原因 | 处理 |
| --- | --- | --- |
| `fetch failed` | Node 进程没有可用代理或网络不可达 | 确认代理软件已开启并能访问 <https://github.com>；重启应用让 `NODE_USE_ENV_PROXY=1` 生效；或在终端 `curl -I https://github.com` 验证 |
| `网络错误（ETIMEDOUT，github.com/…）` | 直连超时（国内网络常见） | 开启代理后重启应用；用面板里的「复制诊断命令」查看任务详情 |
| `ECONNRESET` / `ECONNREFUSED` | 代理端口写错/代理未启动，或代理线路在大文件传输中途被重置（国内网络常见，长连接可能每几分钟被掐断一次） | 换一个代理节点；核对 `HTTPS_PROXY` 的端口与代理软件一致；模型/适配器下载已支持自动多次重试 + 断点续传，面板会显示「第 n/N 次尝试」，通常能自己跑完；若仍失败，重新点「开始下载」即可从断点继续 |
| `HTTP 404` | 资产地址或版本已变更（Release 被删、HF 文件名改了） | 升级到最新版本再试；或到 GitHub Releases / HuggingFace 确认文件名 |
| `HTTP 416` | 断点续传偏移与服务端不一致（`.part` 大小对不上） | 新版会自动丢弃偏移并重下；仍失败则删掉 `data/ace-step/.downloads/` 下对应 `.part` 后重试 |
| `sha256 校验失败` | 缓存损坏，或代理做了内容劫持/MITM | 删除对应缓存（`.downloads/*.part` 或已下载文件）后重下；检查代理是否开启 HTTPS 解密 |

**断点续传**：下载器支持 `.part` 缓存，中途取消或断网后重新点「开始下载」会从断点继续（发 `Range: bytes=<已下载>-`）；
带 sha256 校验的资产续传时会把已有 `.part` 字节补进同一个哈希再继续追加，**不会**因为要校验而从头重下 2.5GB 模型；
若服务器返回的区间起点与本地 `.part` 对不上，会自动丢弃分片、从头重下（不会拼出坏文件）。
大文件下载会自动重试：运行时 5 次、模型 8 次、风格适配器 5 次（downloader 默认 3 次），每次重试都复用已有 `.part`，
面板的步骤消息会显示「第 n/N 次尝试」；即使任务最终报失败，重新点下载也会从断点继续，不会白下。
手动清理缓存：删除 `<数据目录>/ace-step/.downloads/` 下对应的 `.part` 文件即可（数据目录默认是仓库下 `data/`）。

## 5. 已验收证据（P8-A）

- `node --import tsx scripts/verify-provision.mjs`（或 `pnpm verify:provision`）：**38/38**
  - 代理环境解析（大小写 / `ALL_PROXY` 兜底 / `user:pass` / `no_proxy` 通配与端口）
  - 本地假代理（绝对 URL + CONNECT）下的 `proxyAwareFetch`：200/404、`Range` 透传、302 跟随、中止、代理不可达错误码
  - 下载器：缓存命中 0 请求、sha256 正误、**续传只请求剩余字节**、服务器忽略 `Range` 时从头下、206 区间起点不符时丢弃分片重试、网络错误/429/5xx 重试（默认 3 次）、可诊断错误文案
  - 全部 loopback 随机端口 + 注入 `fetchImpl`，不需要公网
- 真实网络（Lead 验收，本机 Apple Silicon + 代理）：经代理下载运行时 2.5MB（sha256 与 manifest 一致）→ 解压出 **10 个 dylib 软链** → `ace-server --help` 退出码 0；HF 模型 1MB Range 返回 206（`content-range: bytes 0-1048575/337420928`）；URL 级 API 走完「启动安装 → 运行时完成 → 取消 → `/api/provision/status` 显示已安装」
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

## 6. 在 Mac 上继续训练（P8-C，进行中）

训练所需的代码/数据集/检查点/Python 都是**按需下载**（只在点「开始训练」时），当前已发布：
- 训练代码包：GitHub Releases `training-code-v1`（323KB，含 runner + ACE-Step/Side-Step 快照）
- 自生成数据集：`training-data-v1`（jrpg_v1 74MB / jrpg_v2 207MB / jrock_v1 209MB）
- 基座检查点：HF `ACE-Step/Ace-Step1.5`（turbo+VAE+文本编码器，共 6.34GB，LFS sha256）
- 独立 Python：python-build-standalone 3.12 macOS arm64（25MB）

产品内使用（推荐）：
1. 顶栏「训练风格」→ 显示五个阶段状态；
2. 点「下载并准备环境」（仅此时下载 ≈6.9GB：训练代码 + 数据集 + 独立 Python + 基座检查点，随后创建 venv 安装依赖；可随时取消，重试会续传）；
3. 填数据集（jrpg_v1 小 / jrpg_v2 推荐 / jrock_v1）、tag、风格、epochs、device、precision；
4. 点「开始训练」，面板显示 预处理 → LoRA 训练 → 注册适配器 的进度与日志尾部；完成后提示「已注册适配器 xxx」，模型管理器即可选用。

macOS 建议：`device=mps`、`precision=fp32`、epochs 60–100 起步，先用 jrpg_v1 小数据集验证（MPS 明显慢于 CUDA）。CLI：`node scripts/training.mjs status|setup|train`。手动 runner 用法见 `training/README.md`。

## 7. 边界与已知限制

- 模型下载源是公开 HuggingFace 仓库（`Serveurperso/ACE-Step-1.5-GGUF`），需要能访问 `huggingface.co`（受限网络请走代理）；运行时来自 GitHub Releases。
- Linux x64 运行时目前没有钉死 sha256（只有大小校验）；Windows/macOS 已钉死。
- **真实数据训练的适配器（real_jrpg_v1 / real_jrock_v1）不会分发**，只在本机；自动安装只发布自生成数据的适配器（jrpg_v1 / jrpg_v2 / jrock_v1，见 GitHub Releases `adapters-v1`）。
- P8-C「按需训练」尚未实现；现在 `music-gen/` 训练管线仍只在开发机存在。