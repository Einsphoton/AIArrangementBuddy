# Agent 集成指南（Codex / DeepSeek Harness / 任意 MCP 客户端）

「AI 编曲伴侣」的 AI 能力分成三层，可以单独使用，也可以叠加：

```
① 内置 Agent（builtin）      应用自带的多轮 function-calling 循环 —— 默认，开箱即用
② 外部 Agent 驱动（codex/dsh）把整个编曲任务交给本机 Codex CLI / DSH CLI
③ MCP Server                 把 DAW 能力暴露成标准 MCP 工具，任何 MCP 客户端都能调用
```

三者的工具集合是同一套（`apps/server/src/tools/`），因此行为一致。

---

## 一、内置 Agent（默认）

设置 → Agent 后端 → **内置 Agent**。

- 需要一个可用的 AI 服务商（设置 → AI 服务商，填 API Key）
- 工作方式：`messages` → 模型 → `tool_calls` → 本地执行工具 → 结果回填 → 继续，最多 32 轮
- 支持流式文本、推理内容（`reasoning_content` / Anthropic thinking）、并行工具调用
- 每次改工程后立即把新工程快照推给前端，界面实时刷新
- 超时 / 取消：前端「停止」按钮会 abort 当前 run，同时终止下游请求
- AI 可操作的能力（37 个工具，见 `docs/CONTRACTS.md` §6）：
  - 编曲核心：旋律→整套伴奏、和弦→旋律、9 类智能片段生成器、和声分析
  - 编辑类（新增，鼓励 AI **复用已有片段**而不是反复重新生成）：`copy_clip`（复制/重复/移调/跨轨）、`repeat_section`（整段重复）、`split_clip`、`merge_clips`、`transpose_clip`、`transpose_project`、`quantize_clip`、`humanize_clip`、`scale_lock_clip`、`velocity_curve`、`duplicate_track`、`clear_track`
  - 工程类：速度/调性/拍号/摇摆/循环/和弦/段落/主音量
  - 界面类：`ui_action`（播放、停止、跳转、切视图、选中片段、打开导出/设置、撤销/重做、循环、节拍器）——通过 SSE `ui` 事件驱动前端，不修改工程
  - 工具名别名：模型偶尔「自创」工具名（如 `add_drum_groove`）会被自动映射到真实工具并在 message 里注明
  - 情绪词兜底：如给爵士鼓传 `swing` 会自动落到相近情绪 `brush` 并明确提示，而不是直接失败
- 稳定性与生成质量保障（细节见 `docs/AI_RELIABILITY.md`）：
  - 工具参数统一归一化 + 必填校验：数字字符串、音名音高（C4）、和弦别名（Am / min7）、调性降号、段落 startBeat/lengthBeats 等模型常见写法都会被正确解析；非法参数返回可操作提示，绝不半执行
  - 网关 429 / 5xx 自动重试（仅在本轮尚未输出文本时，避免重复内容）
  - 推理模型把 `max_tokens` 花在思考上导致截断时，自动临时加倍预算重试同一轮（上限 32768）；自愈耗尽才提示拆小任务
  - 生成结束做工程质量自检（片段重叠 / 音符超长 / 空轨 / 叠音 / 跑调等），只对**本次新引入**的高优先级问题自动修复一次，并在对话里提示「质量自检」
  - 每次生成都写运行日志到 `data/logs/ai-runs-<日期>.jsonl`：`pnpm ai:logs [-- --failed]` 查看，或 `GET /api/ai/logs?failed=1`；日志包含工具失败原因、服务商重试、token 用量、截断与质量自检结果（14 天自动清理，不记录 API Key）
  - 历史消息与工程概览按预算裁剪，避免长对话 / 大工程撑爆上下文
  - `scripts/test-ai.mjs`（`pnpm test:ai`）用 mock 服务商覆盖生成链路回归场景（含日志 / 截断自愈 / 质量自检 / 新编辑工具 / 别名 / ui 事件）

支持的模型：任何 OpenAI 兼容 `POST /v1/chat/completions`（含 function calling）或 Anthropic Messages API。
DeepSeek、OpenAI、Claude、Kimi、Qwen、GLM、SiliconFlow、OpenRouter、Ollama、vLLM、LM Studio 都可以。

**OpenCode 网关的两个细节已自动处理**（无需手动配置）：

| 网关 | Base URL | 我们做的适配 |
| --- | --- | --- |
| OpenCode Zen | `https://opencode.ai/zen/v1` | 标准 OpenAI 兼容；`/models` 公开可读（80 个模型，含免费模型） |
| OpenCode Go | `https://opencode.ai/inference/go/openai/v1` | 推理地址与模型列表地址不同（列表在 `/inference/go/v1/models`，已用 `modelsUrl` 覆盖）；请求自动带 `x-opencode-session` 会话标识与自定义 User-Agent（否则会被拒绝路由） |

---

## 二、Codex CLI（把编曲当成编程任务）

### 为什么用它

Codex 是「有手有脚」的 Agent：能读文件、跑命令、查资料，再回来改你的工程。
适合这类任务：

- 「参考某个开源项目的和声写法，把它用到我的副歌里」
- 「分析我这个 MIDI 片段的节奏问题，并给出三种改法」
- 「帮我写一个脚本，把我收藏的 20 个和声进行批量灌进工程」

### 前置条件

```bash
npm i -g @openai/codex     # 或 brew install codex
codex login                # 或配置 ~/.codex/config.toml 指向你的模型服务
codex exec --json "hello"  # 确认能跑通
```

### 在应用里启用

设置 → Agent 后端 → **Codex CLI**：

| 选项 | 说明 |
| --- | --- |
| 可执行文件路径 | 留空则用 PATH 里的 `codex` |
| 工作目录 | 留空则用 `data/agent-workspace/`；Codex 会在这个目录里读写 |
| 模型 | 可选，覆盖 Codex 默认模型 |
| 超时 | 单轮最长执行时间，默认 180s |

应用会这样调用：

```bash
codex exec --json --skip-git-repo-check -C <workdir> \
  -c mcp_servers.aiab.command=<node/tsx> \
  -c mcp_servers.aiab.args='[".../apps/server/src/mcp/server.ts"]' \
  -c mcp_servers.aiab.env.AIAB_PROJECT_FILE=<workdir>/project.json \
  "<你的编曲需求 + 当前工程摘要>"
```

- Codex 的 JSONL 事件被翻译成本应用的 SSE 事件（`item.completed` → `text`，`command_execution` / `mcp_tool_call` → `tool_start`/`tool_end`）
- Codex 通过 MCP 调用 DAW 工具写工程文件，后端每 400ms 轮询一次，把变化推给前端
- Codex 自身的输出（命令行执行、文件读写）也会以工具卡片形式展示

> **注意**：Codex 在自己的沙箱里跑命令，改动的是 `workdir` 里的 `project.json`，不会直接动你浏览器的内存工程。
> 浏览器里的工程是权威副本，所以最终结果总是以推送给前端的快照为准。

### 常见问题

- **Codex 直接退出（code 1）**：多半是 `~/.codex/config.toml` 配置错误。可以先用干净的配置验证：
  ```bash
  AIAB_CODEX_HOME=/tmp/clean-codex-home pnpm dev
  ```
  （应用会把 `CODEX_HOME` 传给子进程）
- **401 / 无凭据**：`codex login` 或配置 provider；应用会如实把错误显示在对话里，不会假装成功。

---

## 三、DeepSeek Harness

「DSH」是本机可用的 DeepSeek Harness CLI。应用会依次探测：

1. 设置里填写的可执行文件路径
2. `PATH` 中的 `dsh` / `deepseek-harness` / `dsh-cli`
3. `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin` 等常见位置

找不到时：**明确提示并自动回退到内置 Agent**（不会静默失败，也不会假装在用 DSH）。
可通过环境变量 `AIAB_DSH_ARGS` 覆盖命令行模板（`{prompt}` 为占位符）以适配不同版本。

---

## 四、MCP Server（让外部 Agent 驱动本应用）

### 启动

```bash
# 开发模式（源码）
./apps/server/node_modules/.bin/tsx apps/server/src/mcp/server.ts

# 生产模式（构建后）
node apps/server/dist/mcp.mjs
```

stdio 传输，默认工程文件 `data/mcp-workspace/project.json`，可用 `AIAB_PROJECT_FILE` 指定。

### 能力

- **21 个工具**：轨道增删改、乐器/情绪、片段与音符写入、智能片段生成、旋律→编曲、
  和弦→旋律、乐理查询、联网搜索、网页抓取、工程级设置
- **只读模式**：`AIAB_ALLOW_PROJECT_EDITS=0` 时只暴露 3 个只读工具（查询类）
- **资源**：`aiab://project/current` 可读取完整工程 JSON

### 在 Codex 里注册

```bash
codex mcp add aiab -- node /absolute/path/apps/server/dist/mcp.mjs
# 或手写 ~/.codex/config.toml：
```

```toml
[mcp_servers.aiab]
command = "node"
args = ["/absolute/path/apps/server/dist/mcp.mjs"]
env = { AIAB_PROJECT_FILE = "/absolute/path/data/mcp-workspace/project.json" }
```

### 在 Claude Code / Cursor / 其它 MCP 客户端里注册

```json
{
  "mcpServers": {
    "aiab": {
      "command": "node",
      "args": ["/absolute/path/apps/server/dist/mcp.mjs"],
      "env": { "AIAB_PROJECT_FILE": "/absolute/path/data/mcp-workspace/project.json" }
    }
  }
}
```

配置好后，在客户端里说「用 aiab 工具给我写一段 C 小调的弦乐铺底」，
Agent 就会直接调用 DAW 工具，工程文件随之变化 —— 在应用里打开这个工程文件即可继续编辑。

> 详细工具清单与参数见 [`apps/server/src/mcp/README.md`](../apps/server/src/mcp/README.md)。

---

## 五、工具清单（三种后端共用）

| 类别 | 工具 |
| --- | --- |
| 读取 | `get_project_summary`、`analyze_harmony`、`music_theory` |
| 轨道 | `create_track`、`update_track`、`delete_track`、`set_instrument` |
| 片段 | `create_clip`、`update_clip`、`delete_clip`、`write_notes` |
| 生成 | `generate_smart_clip`、`arrange_from_melody`、`melody_from_chords` |
| 工程 | `set_tempo`、`set_key_scale`、`set_chords`、`set_sections`、`set_master_volume` |
| 联网 | `web_search`、`fetch_url` |

所有工具都接受/返回纯 JSON，不依赖浏览器，因此同一份工具代码同时服务三种后端 + MCP。

---

## 六、安全边界

- Agent 只能通过工具改「工程数据」，没有任意代码执行能力（Codex 后端除外 —— 它本身就能跑命令，
  请自行评估是否在你的机器上启用）
- `allowProjectEdits` / `allowWebSearch` 两个开关可以关掉对应能力
- API Key 只存在本机 `data/settings.json`，前端读取时脱敏
- MCP server 通过 stdio 与宿主进程通信，不监听网络端口
