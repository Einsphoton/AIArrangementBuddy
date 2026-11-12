# P11 · Docker 内置 AI 引擎包（模型 + LoRA 预置镜像）

> 面向：把 AI 编曲伴侣部署到 **NAS / 内网服务器** 的用户 —— 希望 **镜像里已经带好 AI 引擎运行时 + 模型 + LoRA 适配器（可选训练数据）**，部署后安装引擎直接本地命中、**不再从 HuggingFace / GitHub 下载**；同时让局域网里其它 GPU 机器从这台服务器拉取引擎文件（不占公网）。
>
> 相关：[DOWNLOAD_ACCELERATION.md](./DOWNLOAD_ACCELERATION.md)（下载加速 / 离线包 / 镜像 API）、[COMPANION.md](./COMPANION.md)（NAS 控制面 + GPU 机器架构）、[P9_XL_ENGINE.md](./P9_XL_ENGINE.md)（XL 档位）。
>
> 一键脚本：`node scripts/build-docker-bundle.mjs`（P11 新增）。代码：`scripts/build-docker-bundle.mjs`、`apps/server/src/provision/tarWriter.ts`、`apps/server/src/provision/enginePackage.ts`。

---

## 1. 为什么需要它

安装「本机 AI 引擎」通常要下载三类文件（见 [DOWNLOAD_ACCELERATION.md](./DOWNLOAD_ACCELERATION.md) §1）：

| 内容 | 上游 | 体积（essential） |
|---|---|---|
| 引擎运行时（Windows modern 24 个文件） | `serveurperso.com` 临时目录 | ~0.19GB |
| NVIDIA CUDA 13 redist（zip，安装时解压） | `serveurperso.com` 临时目录 | ~0.40GB |
| 模型（GGUF：turbo / 文本编码器 / VAE） | HuggingFace | ~3.67GB |
| LoRA 风格适配器（3 个） | GitHub Releases（或本机回打） | ~0.09GB |
| （可选）训练代码 / Python / 数据集 / 检查点 | GitHub + HuggingFace | 7GB+ |

在服务器上现场下载既慢又不稳定（运行时上游随时可能被替换、HF 国内直连经常断）。P10 已经有「服务器离线包 + 局域网镜像」机制，但需要用户**手工**把离线包拷进数据卷（`docker cp`）。P11 把这件事前置到 **`docker build`**：

- 构建镜像前，在一台**已装好引擎**的机器上生成离线包到 `docker/engine-package/`；
- `Dockerfile` 把该目录 `COPY` 进镜像的 `/app/engine-package`，并设置 `AIAB_ENGINE_PACKAGE_DIR`；
- 部署后容器内安装引擎时**优先命中镜像内离线包**（硬链接/复制 + 逐文件 sha256 校验），零网络下载；
- 服务器开启「服务器助攻」（`serverAssist`，默认开）后，局域网其它机器用
  `node scripts/provision.mjs fetch --from http://<nas>:8787` 从镜像拉取，同样不占公网。

同时修掉一个关键缺口：**LoRA 适配器只剩已解压目录时离线包会缺 LoRA**。
真实机器上 `.downloads` 里的适配器归档常被清理，只剩 `<dataDir>/adapters/<id>/`（`adapter.json` + `adapter_model.safetensors`）；P11 起 `buildEnginePackage` 会用纯 Node 把这些目录**回打成 `adapters/<归档名>.tar.gz`**（`tarWriter.ts`），manifest 里的 `size/sha256` 用生成文件的实际值。

---

## 2. 目录结构

```text
仓库（构建镜像前，在有模型的机器上）
  docker/
    engine-package/                    ← 离线包输出目录（仓库只带占位 README.md）
      engine-package.json              ← 清单（schema=1，files[] 含 key/file/size/sha256）
      runtime/                         ← Windows modern 运行时 24 个文件（或 runtime-archive/ legacy 归档）
      cuda/                            ← NVIDIA CUDA redist zip
      models/*.gguf                    ← 模型
      adapters/*.tar.gz                ← LoRA 归档（缓存丢失时由 data/adapters/<id>/ 回打）
      training/                        ← 仅 --training 时存在：code/ python/ datasets/ checkpoints/

镜像内
  /app/engine-package/                 ← 上面整个目录（Dockerfile COPY，环境变量 AIAB_ENGINE_PACKAGE_DIR）
  /data/                               ← 数据卷：工程、settings.json、音色库、安装的引擎

容器内安装引擎之后
  /data/audio-engine/                  ← 运行时文件 + models/ + .downloads/（安装目录）
  /data/adapters/<id>/                 ← LoRA：从离线包归档解压（每个归档内是 <id>/adapter.json 等）
```

包内文件 key 规则与全项目一致：`runtime/<文件名>`、`cuda/<zip 名>`、`runtime-archive/<legacy 归档>`、`model/<gguf 名>`、`adapter/<归档名>`、`training/code|python|dataset/<id>|checkpoint/<dest>`。
镜像端点只服务这些白名单 key（防目录穿越）。

> **平台注意**：离线包是按「生成它的机器平台」打的（`engine-package.json` 的 `platform` 字段，如 `win32-x64`），运行时/CUDA 与平台绑定、模型跨平台通用。
> 常见用法是：Windows 工作站上打包 → 镜像部署到 NAS（Linux 容器）→ NAS 作为**引擎镜像源**给局域网里 Windows/macOS 的 GPU 机器分发。
> 如果目标就是给 Linux 服务器本机装引擎，请先在那台 Linux 上装好引擎再生成包。

---

## 3. 构建步骤

### 3.1 准备（一台已装好引擎的机器）

1. 安装引擎（设置 →「引擎下载」，或 `node scripts/provision.mjs install --profile essential`，XL 再加 `,xl`）；
2. 启动应用（打包由运行中的服务端执行）：`node scripts/start.mjs`（开发时也可 `pnpm dev`）；
3. 确认状态：`node scripts/provision.mjs status`（模型/运行时/适配器是否就绪）。

### 3.2 生成离线包

```powershell
# 基础档（运行时 + turbo 模型 + 文本编码器 + VAE + 3 个 LoRA 适配器，实测约 4.35GB）
node scripts/build-docker-bundle.mjs

# XL 档（额外约 20.4GB，合计约 24.7GB）
node scripts/build-docker-bundle.mjs --profiles essential,xl

# 连训练数据一起（代码 / Python / 数据集 / 检查点，体积可到 30GB+）
node scripts/build-docker-bundle.mjs --profiles essential,xl --training

# 只生成包，不 docker build（适合先在打包机跑包、再在别的机器构建镜像）
node scripts/build-docker-bundle.mjs --profiles essential --no-build

# 输出到别的目录（Dockerfile 用 --build-arg ENGINE_PACKAGE_DIR=... 指定）
node scripts/build-docker-bundle.mjs --out docker/engine-package-xl --tag ai-arrangement-buddy:xl

# 换档位/重新打包时清掉旧档位残留（保留占位 README.md）
node scripts/build-docker-bundle.mjs --profiles essential --clean
```

脚本行为：

1. 调运行中的服务端 `POST /api/provision/package/build`（`outDir` 传绝对路径），轮询 `/api/provision/package/jobs/:id` 显示进度；
2. 校验输出目录里的 `engine-package.json`，打印**文件数 / 实际体积 / 包含的能力 / 被跳过的文件**；
3. 默认继续执行 `docker build -t ai-arrangement-buddy:bundled .` 并透传退出码；`--no-build` 只生成包。

> 服务端没启动时会给出中文提示：先 `node scripts/start.mjs`，或用
> `node scripts/provision.mjs package --out docker/engine-package` 生成后重试。
> 打包机上的 LoRA 只要 `data/adapters/<id>/` 还在（`.downloads` 归档被清了也没关系，P11 会自动回打）。

### 3.3 构建镜像

```bash
# 手动
docker build -t ai-arrangement-buddy:bundled .

# 推荐：compose（会自动读取 docker/engine-package）
docker compose up -d --build
```

- 默认读取 `docker/engine-package/`；换目录：`docker build --build-arg ENGINE_PACKAGE_DIR=docker/engine-package-xl -t ai-arrangement-buddy:xl .`
- 占位 `docker/engine-package/README.md` 保证「还没生成离线包」时 `COPY` 也不会失败（此时镜像里包为空，安装会自动回退网络下载）。
- **不要**把 `docker/` 加进 `.dockerignore`（`.dockerignore` 里已注明）；否则包不会进构建上下文。

### 3.4 部署到 NAS

```bash
# 方式一：在构建机导出镜像，传到 NAS 再导入（无需 NAS 上有源码/模型）
docker save ai-arrangement-buddy:bundled | gzip > aiab-bundled.tar.gz
# NAS 上：
gunzip -c aiab-bundled.tar.gz | docker load
docker run -d --name aiab -p 8787:8787 -v aiab-data:/data ai-arrangement-buddy:bundled

# 方式二：NAS 上直接 docker compose up -d --build（需要仓库 + docker/engine-package）
```

数据卷 `aiab-data`（挂到 `/data`）保存工程 / 设置 / 音色库，容器重建不丢；离线包在**镜像内**（`/app/engine-package`），不随卷丢失，但也不会被卷覆盖。

### 3.5 体积与耗时

| 档位 | 离线包体积（≈镜像层增量） | 说明 |
|---|---|---|
| `--profiles essential` | **约 4.35GB** 实测（运行时 0.19GB + CUDA 0.40GB + 模型 3.67GB + LoRA 0.09GB） | 日常推荐 |
| `--profiles essential,xl` | 约 24.7GB（XL 模型 +20.37GB） | 需 ≥12GB 显存 |
| `+ --training` | 30GB+（训练数据/检查点约 6.9GB，XL 合计约 31.7GB） | 训练代码/Python/数据集/检查点 |

- 体积主要来自模型 GGUF，`docker build` 的上下文发送 + 镜像层都会占对应磁盘（`docker save` 的 tar 也差不多大）。
- 打包/构建耗时主要在写镜像层（几分钟级，取决于磁盘）；生成离线包本身主要靠硬链接，通常几十秒内完成。
- 空间不够时的替代方案：把离线包放到数据卷（`-v /host/path/engine-package:/data/engine-package`）并设 `AIAB_ENGINE_PACKAGE_DIR=/data/engine-package`，镜像更小但需要单独分发这个目录。
- 以上体积按 `engine-package.json` 清单逐文件累加（实测）；[DOWNLOAD_ACCELERATION.md](./DOWNLOAD_ACCELERATION.md) 里的「约 3.4GB 起」是早期粗略估算，以实际清单为准。

---

## 4. 容器内为什么零下载

`Dockerfile` 的 runtime 阶段：

```dockerfile
ARG ENGINE_PACKAGE_DIR=docker/engine-package
COPY ${ENGINE_PACKAGE_DIR}/ ./engine-package/
ENV AIAB_ENGINE_PACKAGE_DIR=/app/engine-package
```

安装/下载单个工件时的顺序（`installer.ts` / `sources.ts` / `enginePackage.ts`）：

1. **本机离线包**（`useLocalPackage`，默认开）：`findLocalArtifact()` 按 key 在离线包清单里找文件 → `copyLocalArtifact()` 硬链接/复制并校验 sha256 → 命中即返回 `local`，**不发网络请求**；
2. 离线包没有/校验失败 → 服务器镜像（`AIAB_SERVER_ASSIST_URL`）→ 国内镜像（hf-mirror / ghfast）→ 官方源。

离线包目录解析优先级（`enginePackageDir()`）：**设置里的「离线包目录」(`settings.provision.packageDir`) > 环境变量 `AIAB_ENGINE_PACKAGE_DIR` > `<dataDir>/engine-package`**。
Docker 默认只设了环境变量，所以设置页留空时用镜像内的 `/app/engine-package`。

配套设置（设置 →「引擎下载」，默认值即目标状态）：

| 设置 | 默认 | 作用 |
|---|---|---|
| `useLocalPackage` | `true` | 使用本机离线包（**关掉就不会用镜像里的包**） |
| `serverAssist` | `true` | 服务器助攻总开关（也影响本机离线包的使用，见排障） |
| `packageDir` | `''` | 空 = 用环境变量/数据目录下的默认位置 |

验证是否生效：

```bash
# 容器内
docker exec aiab node -e "fetch('http://127.0.0.1:8787/api/provision/status').then(r=>r.json()).then(s=>console.log(s.download))"
# 期望：packagePresent: true, packagePath: "/app/engine-package", packageFiles: 32, ...
```

安装时日志会显示「使用本地离线包：model/…」；「设置 → 引擎下载」的离线包卡片也会显示 `32 个文件 / 4.35GB`。

---

## 5. 让局域网其它 GPU 机器复用这台服务器

服务器镜像内已有离线包 + `serverAssist` 开启时，其它机器（Companion / GPU 工作站）不必各自从公网下载：

```powershell
# NAS 服务端：http://nas:8787
# 拉到本机数据目录下的 audio-engine（布局与安装器一致：运行时在根、models/、.downloads/）
node scripts/provision.mjs fetch --from http://nas:8787 --dest D:\aiab-data\audio-engine --profile essential

# 只拉 XL 档 / 连训练数据一起（按服务器 manifest 的 profiles 过滤）
node scripts/provision.mjs fetch --from http://nas:8787 --dest D:\aiab-data\audio-engine --profile essential,xl --training

# 服务器配置了镜像令牌时
node scripts/provision.mjs fetch --from http://nas:8787 --dest D:\aiab-data\audio-engine --token <token>
```

- 走 `/api/provision/mirror/manifest` + `/api/provision/mirror/file?key=...`（支持 Range 断点续传、逐文件 sha256 校验），只在内网传输；
- 服务端可用 `AIAB_MIRROR_TOKEN` / 设置里的「服务器镜像令牌」加访问控制；
- 也可以把服务器配成目标机「设置 → 引擎下载 → 服务器镜像地址」，安装器会优先从 NAS 拉。

---

## 6. LoRA「从已解压目录回打归档」（P11）

**问题**：`buildEnginePackage` 原来只从 `<dataDir>/audio-engine/.downloads/<adapter 归档>.tar.gz` 拷贝 LoRA；但真实机器上适配器装好后 `.downloads` 常被清理，只剩 `<dataDir>/adapters/<id>/` → 打出的离线包缺 LoRA，其它机器拉到包里没有风格适配器。

**修复**（`enginePackage.ts` + `tarWriter.ts`）：

1. `buildEnginePackage` 在主循环**之前**做 staging：对每个 `ADAPTER_ASSETS`，
   - 归档缓存存在 → 保持原逻辑（用缓存归档 + 清单钉死 `size/sha256`）；
   - 归档不存在、但 `<dataDir>/adapters/<id>/` 存在 → 用纯 Node 的 `createTarGz()` 把目录回打成 `adapters/<asset.file>`（包内条目前缀 `<id>/`，与官方归档布局一致），manifest 用**生成文件的实际** `size/sha256`；
   - 两者都不存在 → 跳过 + `warnings`（与原来行为一致）；
2. staging 目录建在系统临时目录，构建结束/失败/取消后自动清理；
3. 安装器解压语义不变：归档 → `data/adapters/<id>/adapter.json` + `adapter_model.safetensors`，`adapterStatus()` 识别为已安装。

> 由此打出的 LoRA 归档与 GitHub Releases 的官方归档**内容等价、字节不同**（gzip 参数/时间戳不同），manifest 与镜像分发链路以生成的 `size/sha256` 为准自洽；从服务器 `fetch` 时会按服务端 manifest 校验。

---

## 7. 排障

| 现象 | 原因 / 处理 |
|---|---|
| `/api/provision/status` 里 `packagePresent: false` | 镜像里没有 `engine-package.json`。① 构建前忘了跑 `node scripts/build-docker-bundle.mjs`（镜像里只有占位 README）；② 设置里 `packageDir` 填了别的路径覆盖了环境变量；③ 用了错误的 `--build-arg ENGINE_PACKAGE_DIR`。`docker exec aiab ls -la /app/engine-package` 确认。 |
| 安装时仍然在下载 | ① 设置 → 引擎下载 里 `useLocalPackage` 被关掉；② 保存过的 `settings.json` 里 `serverAssist: false`（`useLocalPackage` 依赖它，重新打开即可）；③ 镜像内离线包缺对应文件（`warnings` 里的「缺文件」），安装自动回退网络；④ 服务器镜像/官方源覆盖了缺失档位。 |
| 镜像里明明有包，容器却用了卷里的旧包 | 卷/设置覆盖：`/data` 卷里已有 `<dataDir>/engine-package` 或 `settings.json` 里 `packageDir` 有值。删掉卷里的包/清空设置字段，或反过来把包放在卷里统一管理。 |
| 硬链接失效、安装变慢/占两份空间 | 镜像内 `/app/engine-package` 在容器 overlay 层，安装目标是 `/data` 卷 → 不同文件系统，`linkSync` 失败自动退化为 **复制**（正确但更慢、且镜像层 + 卷各占一份）。想省空间就改用数据卷挂载离线包。 |
| 卷里的旧包不随新镜像更新 | 镜像更新只替换 `/app/engine-package`；卷里的离线包不会自动更新（`/data` 卷独立于镜像）。`docker compose up -d --build` 重建容器后 /app 里的包才是新的；卷里的需要自己替换。 |
| 提示「离线包里没有 LoRA 适配器」 | 本机既没有 `.downloads` 归档也没有 `data/adapters/<id>/`。先在 设置 →「引擎下载」安装适配器，或手动放好解压目录后重新打包。 |
| 换档位后镜像里还有旧模型 | `buildEnginePackage` 只覆盖/新增文件，不清理旧档位残留。用 `--clean` 或在 `docker/engine-package` 里手动删掉旧档位文件后重新打包。 |
| `docker build` 上下文巨大 / 很慢 | 离线包（几 GB～几十 GB）会作为构建上下文发送。可把包放到仓库外并用 `--build-arg ENGINE_PACKAGE_DIR=...`（需在该路径下），或临时移除大档位。 |
| 打包报「连不上运行中的应用」 | 先 `node scripts/start.mjs`；或 `node scripts/provision.mjs package --out docker/engine-package` 生成后重试（`--no-build`）。 |
| 打包后想只验证体积/能力 | 读 `docker/engine-package/engine-package.json`，或 `node scripts/provision.mjs status` 看 `download.packageFiles/packageBytes`。 |
| NAS 上 docker 端口冲突 | `AIAB_PORT=9000 docker compose up -d`。 |

离线自测（不需要 Docker、不联网）：

```bash
node scripts/verify-engine-package.mjs   # 24 项：离线包 + 镜像 API + LoRA 回打 + CLI
```

---

## 8. 相关文件

| 文件 | 作用 |
|---|---|
| `Dockerfile` | runtime 阶段 `COPY ${ENGINE_PACKAGE_DIR}/ ./engine-package/` + `ENV AIAB_ENGINE_PACKAGE_DIR=/app/engine-package` |
| `docker-compose.yml` | `AIAB_ENGINE_PACKAGE_DIR`（默认 `/app/engine-package`，可被环境变量覆盖）+ 镜像/令牌示例 |
| `docker/engine-package/README.md` | 占位目录（保证 `COPY` 不失败），构建前用脚本替换为真实离线包 |
| `scripts/build-docker-bundle.mjs` | 一键：生成离线包（调服务端异步任务）→ （可选）`docker build` |
| `apps/server/src/provision/enginePackage.ts` | 离线包构建 / 读取 / 本地工件查找 / 镜像枚举；LoRA 回打 staging |
| `apps/server/src/provision/tarWriter.ts` | 极简 ustar + gzip 写入（纯 Node，无新依赖），把已解压目录回打成 tar.gz |
| `.dockerignore` | 不能忽略 `docker/`，否则离线包进不了构建上下文 |
| `docs/DOWNLOAD_ACCELERATION.md` | 下载加速 / 离线包 CLI / 镜像 API / 安全约定 |
