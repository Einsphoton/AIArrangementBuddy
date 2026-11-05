#!/usr/bin/env bash
# =============================================================================
#  AI 编曲伴侣 —— macOS 一键启动（双击即可，不需要 Docker）
#
#  首次运行会自动做这些事（全部不需要管理员权限）：
#    1. 检测 Node.js，缺失则下载官方 LTS 到 .runtime/node 目录
#    2. 检测依赖，缺失则自动 pnpm install
#    3. 启动前后端并打开浏览器
#
#  想跑生产模式：  ./start-macos.command --prod
#  不想自动开浏览器：./start-macos.command --no-open
# =============================================================================
set -u
cd "$(dirname "$0")" || exit 1

GOLD='\033[33m'; GREEN='\033[32m'; RED='\033[31m'; DIM='\033[2m'; RESET='\033[0m'

pause_on_error() {
  echo ""
  echo -e "${RED}启动失败${RESET}。把上面的报错发给我，或者手动试试："
  echo -e "  ${DIM}cd \"$(pwd)\" && node scripts/launch.mjs${RESET}"
  echo ""
  read -n 1 -s -r -p "按任意键关闭窗口…"
  exit 1
}

echo ""
echo -e "${GOLD}  ♪  AI 编曲伴侣 · AI Arrangement Buddy${RESET}"
echo -e "${DIM}  ─────────────────────────────────────────${RESET}"

# ---------- 1. Node.js ----------
export PATH="$PWD/.runtime/node/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo -e "${GOLD}▶${RESET} 未检测到 Node.js，正在自动安装到项目目录（约 30MB）…"
  bash scripts/bootstrap-node.sh || pause_on_error
  export PATH="$PWD/.runtime/node/bin:$PATH"
fi

NODE_VERSION="$(node --version 2>/dev/null || echo none)"
echo -e "${GREEN}✓${RESET} Node.js ${NODE_VERSION}"

# ---------- 2. 启动 ----------
echo ""
node scripts/launch.mjs "$@"
STATUS=$?
if [ $STATUS -ne 0 ]; then
  pause_on_error
fi
