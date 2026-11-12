# P10 · AI 引擎下载加速（国内镜像 / 多源分片 / 服务器离线包）

> 面向：在**国内网络**下安装 ACE-Step 运行时与模型（或给局域网多台机器分发）的用户。
> 相关：安装流程见 [P8_PROGRESS.md](./P8_PROGRESS.md)、XL 档位见 [P9_XL_ENGINE.md](./P9_XL_ENGINE.md)；界面入口在 **设置 → 引擎下载**。

---

## 1. 问题：为什么「安装本机引擎」经常很慢

「安装本机引擎」要下载三类文件（合计约 3.4GB 起、XL 档约 23.8GB）：

| 文件 | 上游 | 国内常见情况 |
|---|---|---|
| 运行时（Windows modern 24 个文件 + NVIDIA CUDA 13 组件） | 上游作者 `serveurperso.com` 临时目录 | 无 CDN、单连接，几十 KB/s～几百 KB/s，且随时可能被上游替换 |
| 模型（GGUF：turbo / sft / base / xl / LM） | HuggingFace `Serveurperso/ACE-Step-1.5-GGUF` | `huggingface.co` 国内直连不稳定，20GB 级文件经常断 |
| 训练代码 / 数据集 / 适配器 | GitHub Releases + HuggingFace | `github.com`、`objects.githubusercontent.com` 时通时断 |

原实现是**单源、单连接、无镜像、无回退**：一旦某个 CDN 慢或断开，整个安装就卡住/失败；重复安装还会丢掉已下载的部分。

P10 针对这三点做了三件事：**国内镜像源**、**多源分片并发下载 + 断点续传 + 自动回退**、**服务器离线包 + 局域网镜像分发**。

---

## 2. 方案总览

### 2.1 镜像源

| 源 | 作用 | 默认值 | 说明 |
|---|---|---|---|
| HuggingFace 镜像 | 模型 GGUF、HF 上的训练数据集/检查点 | `https://hf-mirror.com` | 把 `huggingface.co` 前缀替换为镜像域名；**留空用内置，填 `off` 关闭** |
| GitHub 加速前缀 | 运行时归档、LoRA 适配器（GitHub Releases） | `https://ghfast.top/` | 形如 `https://ghfast.top/https://github.com/...`；**留空用内置，填 `off` 关闭** |
| 运行时 / CUDA 镜像 | `serveurperso.com` 上的现代运行时 24 个文件 + CUDA redist | 空（官方） | 自建静态镜像时填基础 URL；**留空 = 官方 + 服务器离线包** |
| 服务器镜像 | 局域网内另一台已安装/已打包的机器 | 空（只用本机离线包） | 形如 `http://nas:8787`，走 `/api/provision/mirror/file?key=...` |
| 本机离线包 | 已安装目录 / `<dataDir>/engine-package` | 开启 | 硬链接或复制，**完全离线**，不再走网络 |

所有源都只是「传输通道」：文件的 `size` 与 `sha256` 在 manifest 里**逐文件钉死**，内容不符会删除并自动换下一个源（见 §5）。

### 2.2 三种下载源策略

在 **设置 → 引擎下载 → 下载源策略** 选择（也可用 `AIAB_DOWNLOAD_STRATEGY` 覆盖）：

| 策略 | 行为 | 适用 |
|---|---|---|
| `auto`（默认） | 下载前探测官方源与镜像的延迟，按快慢排序后依次尝试 | 绝大多数网络；不确定时选它 |
| `mirror` | 国内镜像优先，失败/校验不符时自动回落到官方源 | 国内直连上游明显慢 |
| `direct` | 只用官方源；**不会请求 hf-mirror / ghfast / runtime 镜像等任何第三方镜像 URL**（自己的服务器离线包仍可用，见下） | 海外网络，或出于安全考虑不想用第三方代理 |

> `direct` 的「不经过第三方镜像」是硬保证：解析候选源时不会生成第三方镜像 URL，排序阶段也会兜底过滤掉任何第三方镜像条目。唯一的例外是 **serverAssist 的服务器镜像 / 本机离线包**——那是你自己的机器或局域网服务器，不属于第三方代理。
> 直连偏远地区的官方源也可能很慢，所以 `direct` 下建议同时开启服务器助攻（`serverAssist` + `serverAssistUrl`），让局域网服务器承担分发。

### 2.3 多源分片并发下载

大文件（≥8MB，例如运行时、GGUF 模型）开启 **HTTP Range 分片并发**：切成 N 段同时下载，段文件落在 `<dest>.part.<i>` + `<dest>.parts.json`，可跨进程/重启续传；某一片失败会换下一个候选源重试；服务器不支持 Range（返回 200）时自动回退单连接并清理分片状态。全部完成后按序拼接 → 校验 size + sha256 → rename 成正式文件。

```
候选源（auto 排序后）: [服务器离线包] → [本机离线包] → [hf-mirror] → [hf.co 官方]
                                   │
                    文件 A (GB 级) ─┴─ 分 N 段并发（Range），每段记录进度
                                   │
                          拼接 → size/sha256 校验 → 安装目录
```

分片数由 **设置 → 引擎下载 → 分片并发**（`concurrency`，0–16，默认 4）控制：`0/1` = 单连接。国内实测：单连接几十 KB/s 的线路，4 路并发通常能到 1–5MB/s（取决于线路与镜像）。

P11 起下载器还会做「**源健康度**」管理（无需配置）：

1. **分片只在健康源之间轮换**：某个源返回 429 限流 / 5xx / 连接失败时，会按 `Retry-After`（没有则指数退避）冷却 —— 连续失败 3 次冷却 60s、5 次冷却 120s；冷却期内新分片**全部走健康源**，不会再往不可用源上白发请求等超时。404/403 表示「这个镜像没有该文件」，只对该文件跳过该源，不影响其它文件的源选择。
2. **单连接路径同样跳过冷却中的源**，且同一安装过程内**所有文件共享源健康度**（前一个文件被限流，后一个文件会直接避开该源一段时间）。
3. **进度消息**新增「N 线程 · 预计剩余 M 分钟」（运行时 / 模型 / 适配器 / 训练资产都有），方便判断还要等多久。
4. **并发建议**：国内网络默认 4 线程通常就能跑满常见百兆宽带；链路更好可调到 6–8。如果镜像持续 429，说明触发了镜像限流 —— 降低线程数，或改用 **Docker 内置离线包**（[DOCKER_ENGINE_BUNDLE.md](./DOCKER_ENGINE_BUNDLE.md)）彻底不下载。

### 2.4 服务器离线包 + 镜像分发

- **生成**：任意一台已装好引擎的机器，在 设置 → 引擎下载 里点「生成服务器离线包」，或命令行 `node scripts/provision.mjs package`。
- **随应用部署**：把输出目录（默认 `<dataDir>/engine-package`，含 `engine-package.json` + `runtime/ models/ …`）拷到服务器的数据目录。
- **首装直接用**：服务器上的应用安装引擎时优先命中本机离线包，硬链接/复制并校验 sha256，**零网络下载**。
- **局域网分发**：其它机器（如跑 GPU 的 Companion 机器）执行 `node scripts/provision.mjs fetch --from http://nas:8787 --dest <数据目录>`，从服务器镜像端点并发拉取，同样支持断点续传与 sha256 校验。

离线包文件 key 规则（全项目统一）：`runtime/<文件名>`、`cuda/<CUDA zip 名>`、`runtime-archive/<legacy 归档名>`、`model/<gguf 名>`、`adapter/<adapter 归档名>`、`training/code`、`training/python`、`training/dataset/<id>`、`training/checkpoint/<dest>`。

> 训练数据（代码 / Python / 数据集 / 检查点）体量大，**默认不打进离线包**；需要时加 `--training`。
>
> 想让离线包**直接随镜像分发**（部署后安装零下载、镜像内即带模型 + LoRA）？
> 见 [DOCKER_ENGINE_BUNDLE.md](./DOCKER_ENGINE_BUNDLE.md)：`node scripts/build-docker-bundle.mjs` 一键生成
> `docker/engine-package` 再 `docker build`，省掉手工 `docker cp`；也修掉了「LoRA 归档缓存被清理 → 离线包缺适配器」的缺口（从 `data/adapters/<id>/` 回打 tar.gz）。

---

## 3. 配置项

设置保存在本机 `data/settings.json` 的 `provision` 段；环境变量优先级高于设置文件（便于 Docker / 服务器部署）。

| 设置字段 | 默认值 | 含义 | 环境变量覆盖 |
|---|---|---|---|
| `sourceStrategy` | `auto` | 下载源策略：`auto` / `mirror` / `direct` | `AIAB_DOWNLOAD_STRATEGY` |
| `hfMirror` | `''` | HuggingFace 镜像；空 = 内置 `https://hf-mirror.com`，`off` = 关闭 | `AIAB_HF_MIRROR` |
| `githubMirror` | `''` | GitHub 加速前缀；空 = 内置 `https://ghfast.top/`，`off` = 关闭 | `AIAB_GITHUB_MIRROR` |
| `runtimeMirror` | `''` | 运行时 / CUDA 镜像基础 URL；空 = 官方 + 服务器离线包 | `AIAB_RUNTIME_MIRROR` |
| `concurrency` | `4` | 分片并发数 0–16；0/1 = 单连接 | `AIAB_DOWNLOAD_CONCURRENCY` |
| `serverAssist` | `true` | 服务器助攻总开关（离线包 + 局域网镜像） | `AIAB_SERVER_ASSIST`（`1/0`） |
| `serverAssistUrl` | `''` | 服务器镜像地址，如 `http://nas:8787`；空 = 只用本机离线包 | `AIAB_SERVER_ASSIST_URL` |
| `serverAssistToken` | `''` | 服务器镜像令牌（可选）：随请求发送 header `x-aiab-mirror-token` **或** query `token`（安装器/manifest 用 header，`provision.mjs fetch` 两种皆可；服务端两种都接受） | `AIAB_MIRROR_TOKEN`（客户端令牌与服务端校验共用） |
| `useLocalPackage` | `true` | 自动使用本机离线包（`<dataDir>/engine-package` 或自定义目录） | —（用设置/UI 切换） |
| `packageDir` | `''` | 离线包目录；空 = 数据目录下 `engine-package` | `AIAB_ENGINE_PACKAGE_DIR` |
| —（仅环境变量） | `3000` | 源探测超时毫秒数（最大 15000），用于 `auto` 排序 | `AIAB_SOURCE_PROBE_TIMEOUT_MS` |

补充说明：

- `hfMirror` / `githubMirror` 填 `off` 即等价于「该源关闭」，回到官方域名。
- `serverAssist` 关闭时，服务端镜像端点不可用（`/manifest` 返回 `enabled:false`，`/file` 返回 404），安装也不会尝试服务器镜像。
- 数据目录默认是仓库下 `data/`，可用 `AIAB_DATA_DIR` 改到别处（离线包、安装结果都跟着走）。

---

## 4. 离线包工作流（推荐给 NAS / 多机部署）

### 4.1 生成

先在一台**已装好引擎**的机器上打包（需要服务端在跑：`pnpm dev` 或 `node scripts/start.mjs`）：

```powershell
# 只打基础档（运行时 + turbo 2B + 文本编码器 + VAE）
node scripts/provision.mjs package --profiles essential

# 连 XL 档一起打（约 23.8GB，需要已安装 / 已下载 XL 模型）
node scripts/provision.mjs package --profiles essential,xl

# 指定输出目录（默认 <dataDir>/engine-package）
node scripts/provision.mjs package --profiles essential,xl --out D:\aiab-package

# 连同训练代码 / 数据集 / 检查点一起打（体量大，默认不打）
node scripts/provision.mjs package --profiles essential --training
```

也可以直接在 UI 里点：**设置 → 引擎下载 → 生成服务器离线包**（默认只含基础档），面板会显示进度。

打包只会**复制已安装目录里存在的文件**，缺失项跳过并汇总 warnings；`engine-package.json` 里记录每个文件的 `key / file / size / sha256`。
LoRA 适配器如果下载缓存（`audio-engine/.downloads/*.tar.gz`）已被清理、只剩 `data/adapters/<id>/` 解压目录，P11 起会**自动回打成归档**再打进包（`size/sha256` 用生成文件的实际值），离线包不会因为缓存被清理而缺风格适配器。

### 4.2 部署

把输出目录整体拷到服务器的数据目录下，命名为 `engine-package`：

```text
<dataDir>/
  engine-package/
    engine-package.json
    runtime/…
    models/*.gguf
    training/…        # 仅 --training 时存在
```

Docker 部署时挂到命名卷里（默认 `/data`）：

```bash
docker cp D:\aiab-package\. aiab:/data/engine-package/
```

> 更推荐把离线包**打进镜像**（一键生成 + `docker build`，部署后安装零下载，不用手工 `docker cp`）：
> 见 [DOCKER_ENGINE_BUNDLE.md](./DOCKER_ENGINE_BUNDLE.md)。

之后服务器上的应用安装引擎时：只要 `useLocalPackage` 开启（默认）且文件 sha256 匹配，就直接本地硬链接/复制，**不产生下载流量**。

### 4.3 局域网其它机器拉取

跑 GPU 的 Companion 机器通常只需要引擎文件，不需要自己再下一次：

```powershell
# 服务端在 NAS 上：http://nas:8787
# --dest 指向数据目录下的 audio-engine（运行时文件在根、models/、.downloads/，与安装器布局一致；旧目录 ace-step 会自动迁移）
node scripts/provision.mjs fetch --from http://nas:8787 --dest D:\aiab-data\audio-engine

# 只拉基础档 / 指定档位（按服务器 manifest 过滤）
node scripts/provision.mjs fetch --from http://nas:8787 --dest D:\aiab-data\audio-engine --profile essential
node scripts/provision.mjs fetch --from http://nas:8787 --dest D:\aiab-data\audio-engine --profile essential,xl

# 服务器开了 token 校验时
node scripts/provision.mjs fetch --from http://nas:8787 --dest D:\aiab-data\audio-engine --token <token>
```

> `--from` 也可以提前用环境变量 `AIAB_MIRROR_URL` 预设；`--concurrency`（默认 4，上限 8）控制并发文件数。
> 训练文件默认不拉，需要时加 `--training`。

`fetch` 保持相对路径布局（runtime 文件放根、模型放 `models/`、CUDA/适配器归档放 `.downloads/`、训练文件放 `training/`），支持 `.part` 断点续传与逐文件 sha256 校验，中断后重跑即可继续。

fetch 到 `<数据目录>/audio-engine` 后可直接作为 Companion / GPU 机器的 `AIAB_ENGINE_DIR`（兼容旧 `AIAB_ACESTEP_DIR`）：目录布局（运行时文件在根、`models/`、`.downloads/`）与安装器一致，`fetch` 会自动补写 `runtime.json`（modern / legacy 自动识别，modern 需运行时文件拉齐才写）；若目标目录已有 `runtime.json` 则不会覆盖。

---

## 5. 安全与完整性

1. **哈希钉死**：运行时 24 个文件、CUDA 组件、每个 GGUF 模型、LoRA 适配器、训练代码/数据集/检查点在 `apps/server/src/provision/manifest.ts` 与 `trainingManifest.ts` 中逐文件记录 `size` + `sha256`。下载完成必须同时匹配两者才会落盘为正式文件，否则删除并换源重试。
2. **镜像视为不可信**：镜像/加速前缀只是传输通道，不参与校验逻辑；即使镜像返回了错误内容，sha256 校验也会拒绝。分片并发允许「不同段来自不同源」，最终整文件 sha256 兜底保证拼接正确。
3. **第三方 GitHub 代理风险**：`ghfast.top` 这类公共服务属于第三方中间人（能看到流量、可返回伪造内容但会被哈希拒绝；仍可能带来可用性与隐私风险）。不接受的话把 `githubMirror` 填 `off`，或改用 `direct` 策略（`direct` 不会请求任何第三方镜像 URL，只保留官方源与自己的服务器离线包）。
4. **镜像端点保护**：服务器镜像端点 `/api/provision/mirror/*` 在 `serverAssist` 开启时可用（关闭时 `/manifest` 返回 `enabled:false`、`/file` 返回 404）。配置了 `serverAssistToken`（或服务端 `AIAB_MIRROR_TOKEN`）后，请求需带 header `x-aiab-mirror-token` 或 query `token`（服务端两种都接受），否则返回 401；端点只允许清单内已知 key，拒绝目录穿越。
5. **断点续传的安全**：续传前会先校验已下载部分的哈希前缀/分片状态，服务端不支持 Range（200）时从 0 重写，避免拼出「半新半旧」的坏文件。

---

## 6. 排障

| 现象 | 处理 |
|---|---|
| 不知道哪个源快 | **设置 → 引擎下载 → 下载源探测 → 测速**；或 `node scripts/provision.mjs sources --probe` 查看各源 `latencyMs` / 失败原因 |
| 下载很慢 | 把「分片并发」调到 4–8（0/1 是单连接）；确认策略是 `auto` 或 `mirror`；确认镜像没被填成 `off` |
| 安装卡在某个文件 | 安装面板该步骤的 message 会显示当前源与速度；换源最直接的方式是下载源策略切 `mirror`/`auto` 后重试（已下载部分会续传） |
| 国内镜像 404 / 文件不存在 | 镜像可能未同步该文件，服务端会自动回落到官方源；持续失败改为 `direct` 并把情况反馈给镜像维护方 |
| 校验失败（sha256 不符） | 服务端会删除损坏文件/分片状态并自动换源；反复失败通常是上游文件被替换（见 [P9_XL_ENGINE.md](./P9_XL_ENGINE.md) §2.2 风险声明）或代理返回了错误页面 |
| 完全离线安装 | 先在有网机器装好并 `provision.mjs package`，把离线包目录放到目标机数据目录（或指 `AIAB_ENGINE_PACKAGE_DIR`），安装时自动本地复制；`fetch` 只用于从服务器镜像拉 |
| 服务器镜像 401 | 在目标机 设置 → 引擎下载 填「服务器镜像令牌」，或给 `fetch` 加 `--token`；确认服务器端 token 配置一致 |
| 服务端没有 `/api/provision/mirror` | 升级到 P10 版本；或确认服务端 `serverAssist` 没被关掉 |
| 想核对本机离线包状态 | `node scripts/provision.mjs status`（含体积/就绪信息），或 设置 → 引擎下载 的离线包卡片 |

常用命令速查：

```powershell
# 下载源配置与测速（--json 便于脚本解析）
node scripts/provision.mjs sources
node scripts/provision.mjs sources --probe --json

# 正常安装（服务端执行，CLI 只触发与显示进度；步骤 message 含源/速度）
node scripts/provision.mjs install --profile essential
node scripts/provision.mjs install --profile essential,xl

# 查看安装状态 / 最近任务
node scripts/provision.mjs status
node scripts/provision.mjs jobs

# 离线包：生成 / 局域网拉取
node scripts/provision.mjs package --profiles essential,xl
node scripts/provision.mjs fetch --from http://nas:8787 --dest D:\aiab-data\audio-engine --profile essential

# 离线验收（不联网）：下载内核（多源/分片/续传/测速）
node scripts/verify-downloads.mjs
# 离线验收（不联网）：离线包 + 镜像 API + CLI
node scripts/verify-engine-package.mjs
# 一条命令跑上面两个
pnpm verify:downloads
```

> 提示：所有命令默认连本机 `http://127.0.0.1:8787`，可用 `--server http://host:port` 或 `AIAB_SERVER` 指向别的服务端。
