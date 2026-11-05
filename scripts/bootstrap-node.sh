#!/usr/bin/env bash
# =============================================================================
#  自动安装 Node.js LTS 到项目内的 .runtime/node（无需管理员权限，不污染系统）
#  同时准备了 pnpm 的本地安装路径。
# =============================================================================
set -eu
cd "$(dirname "$0")/.." || exit 1

RUNTIME_DIR=".runtime"
NODE_DIR="$RUNTIME_DIR/node"
mkdir -p "$RUNTIME_DIR"

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) NODE_ARCH="darwin-arm64" ;;
  x86_64) NODE_ARCH="darwin-x64" ;;
  *) echo "不支持的架构：$ARCH"; exit 1 ;;
esac

echo "  架构：$NODE_ARCH"

# 查询官方 dist 索引，取最新 LTS 版本号
VERSION="$(curl -fsSL --max-time 30 https://nodejs.org/dist/index.json 2>/dev/null \
  | tr '}' '\n' | grep '"lts":"' | grep -v '"lts":false' | head -1 \
  | sed -E 's/.*"version":"([^"]+)".*/\1/')"

if [ -z "${VERSION:-}" ]; then
  # 兜底：直连 GitHub 的可用版本
  VERSION="v22.22.0"
  echo "  无法查询最新版本，使用 ${VERSION}"
fi

TARBALL="node-${VERSION}-${NODE_ARCH}.tar.gz"
URL="https://nodejs.org/dist/${VERSION}/${TARBALL}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "  下载 ${URL}"
if ! curl -fL --retry 2 --max-time 300 -o "$TMP_DIR/$TARBALL" "$URL"; then
  echo ""
  echo "  下载失败。可以先检查网络，或手动安装 Node.js："
  echo "    - 官网：https://nodejs.org/zh-cn/download"
  echo "    - Homebrew：brew install node"
  echo "  装好后再双击 start-macos.command。"
  exit 1
fi

echo "  解压到 ${NODE_DIR}"
rm -rf "$NODE_DIR"
mkdir -p "$NODE_DIR"
tar -xzf "$TMP_DIR/$TARBALL" -C "$TMP_DIR"
cp -R "$TMP_DIR/node-${VERSION}-${NODE_ARCH}/." "$NODE_DIR/"

# 去掉 macOS 隔离属性，避免首次运行时被 Gatekeeper 拦
xattr -dr com.apple.quarantine "$NODE_DIR" 2>/dev/null || true

if [ ! -x "$NODE_DIR/bin/node" ]; then
  echo "  解压后未找到 node 可执行文件，安装失败"
  exit 1
fi

echo "  完成：$("$NODE_DIR/bin/node" --version)"
