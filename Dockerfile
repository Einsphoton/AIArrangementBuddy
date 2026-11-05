# =============================================================================
# AI 编曲伴侣 —— 单容器镜像（多阶段构建）
#
#   docker compose up -d                      # 推荐
#   docker build -t ai-arrangement-buddy .    # 手动构建
#   docker run -d --name aiab -p 8787:8787 -v aiab-data:/data ai-arrangement-buddy
#
# 说明：
# - builder 阶段安装依赖并构建前端 + 后端；
# - runtime 阶段只保留构建产物与生产依赖，并用 ffmpeg 支持 mp3/flac/ogg 导出；
# - 以非 root 的 node 用户运行，数据卷 /data 需要可写（内含工程、设置、音色库）。
# =============================================================================

# ----------------------------- 构建阶段 -----------------------------
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable

# 先复制依赖清单，最大化利用构建缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/core/package.json ./packages/core/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/server/package.json ./apps/server/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts

# 复制源码并构建
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile --ignore-scripts \
 && node scripts/build.mjs

# 产出自包含的服务端部署目录（含 dist + 生产依赖），避免 workspace 符号链接问题
RUN pnpm --filter @aiab/server deploy --prod --legacy /out/server

# ----------------------------- 运行阶段 -----------------------------
FROM node:22-alpine AS runtime

# ffmpeg: mp3/flac/ogg 转码；tini: 正确转发信号（Ctrl-C 能停容器）
RUN apk add --no-cache ffmpeg tini tzdata \
 && ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
 && echo "Asia/Shanghai" > /etc/timezone

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    SERVE_STATIC=1 \
    DATA_DIR=/data \
    TZ=Asia/Shanghai

WORKDIR /app

# 服务端（自包含：node_modules + dist）
COPY --from=builder /out/server/node_modules ./node_modules
COPY --from=builder /out/server/dist ./apps/server/dist
COPY --from=builder /out/server/package.json ./apps/server/package.json
COPY --from=builder /out/server/src ./apps/server/src
# 前端静态资源 + 音色库下载脚本
COPY --from=builder /app/apps/web/dist ./apps/web/dist
COPY --from=builder /app/scripts/fetch-soundfonts.mjs ./scripts/fetch-soundfonts.mjs

RUN mkdir -p /data/soundfonts /data/projects /data/agent-workspace \
 && chown -R node:node /app /data

USER node
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/server/dist/server.mjs"]
