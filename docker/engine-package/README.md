# 离线引擎包占位目录

这个目录是给 Dockerfile 的 `COPY ${ENGINE_PACKAGE_DIR}/ ./engine-package/` 用的**占位**：
仓库里必须有一个已存在的 `docker/engine-package/`，否则构建上下文里没有这个目录时 `docker build` 会失败。

真正构建「内置 AI 引擎」的镜像前，请在一台**已经装好引擎**的机器上执行：

```bash
# 基础档（运行时 + turbo 模型 + 文本编码器 + VAE + 3 个 LoRA 适配器，约 3.4GB）
node scripts/build-docker-bundle.mjs --profiles essential --no-build

# XL 档 + 训练数据（约 30GB+）
node scripts/build-docker-bundle.mjs --profiles essential,xl --training --no-build
```

脚本会通过运行中的应用（`node scripts/start.mjs`）调用
`POST /api/provision/package/build`，把 `engine-package.json` + `runtime/ models/ adapters/ …`
生成到这个目录（同名覆盖）。生成完成后：

```bash
docker build -t ai-arrangement-buddy:bundled .
# 或
docker compose up -d --build
```

容器内安装引擎时会优先命中镜像里的 `/app/engine-package`（环境变量 `AIAB_ENGINE_PACKAGE_DIR`），
**完全零下载**。

> 生成物（`engine-package.json` / `runtime/` / `models/` / `adapters/` / `training/`）体积大，**不要提交到 git**
> （提交历史会膨胀到数十 GB）。建议在 `.gitignore` 里加一条忽略规则、只保留本 README：
> `docker/engine-package/*` + `!docker/engine-package/README.md`。
>
> 完整说明（体积、局域网分发、排障）见 [docs/DOCKER_ENGINE_BUNDLE.md](../../docs/DOCKER_ENGINE_BUNDLE.md)。
