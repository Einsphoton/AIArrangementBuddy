# AIAB MCP Server（把 DAW 工具暴露给外部 Agent）

本目录的 `server.ts` 是一个 **MCP stdio server**，复用后端全部 DAW 工具（`src/tools/`）：
读工程、建删轨道/片段、写音符、生成智能片段、旋律→编曲、和弦→旋律、乐理查询、联网搜索、抓网页。

- 协议：Model Context Protocol（stdio transport）
- 工具数量：按权限 19~21 个（默认全开 21 个）
- 工程来源：环境变量 `AIAB_PROJECT_FILE` 指向的 JSON 文件（工具修改后原子写回）

## 启动方式

开发态（tsx，推荐本机直接用）：

```bash
cd /Users/einsphoton/Documents/AI Project/AIArrangementBuddy
./apps/server/node_modules/.bin/tsx apps/server/src/mcp/server.ts
```

生产态（先打一个单文件 bundle，无需 tsx）：

```bash
# 只打 MCP server
node apps/server/build-mcp.mjs
# 或者：pnpm --filter @aiab/server build:mcp
node apps/server/dist/mcp.mjs
```

> 注：根目录 `pnpm build` 只打包后端主服务（`dist/server.mjs`），不含 MCP server；
> `build:mcp` 是独立脚本，产物同样在 `apps/server/dist/`。

> stdout 是 MCP 协议通道，日志全部走 stderr。启动成功会看到：
> `[aiab-mcp] ready · project=... · tools=21 · edits=true · web=true`

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AIAB_PROJECT_FILE` | `$DATA_DIR/mcp-workspace/project.json` | 工程 JSON 文件路径（写回目标） |
| `AIAB_PROJECT_ID` | 空 | 未指定文件时，按 id 从 `data/projects/` 载入工程 |
| `DATA_DIR` / `AIAB_DATA_DIR` | `<repo>/data` | 数据目录（设置、工程、音色库） |
| `AIAB_ALLOW_PROJECT_EDITS` | `true` | `false` 时只暴露只读工具 |
| `AIAB_ALLOW_WEB_SEARCH` | `true` | `false` 时不暴露 web_search / fetch_url |

## 在 Codex CLI 里配置

**方式 A：写进 `~/.codex/config.toml`（推荐）**

```toml
[mcp_servers.aiab]
command = "/Users/einsphoton/Documents/AI Project/AIArrangementBuddy/apps/server/node_modules/.bin/tsx"
args = ["/Users/einsphoton/Documents/AI Project/AIArrangementBuddy/apps/server/src/mcp/server.ts"]
env = { AIAB_PROJECT_FILE = "/Users/einsphoton/Documents/AI Project/AIArrangementBuddy/data/mcp-workspace/project.json" }
```

生产构建后更简单：

```toml
[mcp_servers.aiab]
command = "node"
args = ["/Users/einsphoton/Documents/AI Project/AIArrangementBuddy/apps/server/dist/mcp.mjs"]
```

**方式 B：后端自动注入（本项目 Codex 后端已内置）**

选择「设置 → Agent → Codex CLI」后，后端在 spawn 时会自动追加：

```
-c mcp_servers.aiab.command="<node 或 tsx>"
-c mcp_servers.aiab.args=["<mcp.mjs 或 server.ts>"]
-c mcp_servers.aiab.env={ AIAB_PROJECT_FILE = "<会话目录>/project.json", ... }
```

所以无需手动配置；服务端会轮询该工程文件，把 Codex 的修改实时以 `project` 事件推给前端。

**方式 C：命令行验证**

```bash
codex mcp add aiab -- node /绝对路径/apps/server/dist/mcp.mjs
codex mcp list
```

## 在 DeepSeek Harness（DSH）里配置

DSH 的 CLI/配置格式随版本变化，本项目只做「探测 + 诚实回退」：

- 若 DSH 支持 MCP 配置，把上面的 stdio server 配置指向本服务（命令 / 参数同上）；
- 后端运行 DSH 时会设置 `AIAB_PROJECT_FILE` / `AIAB_SESSION_DIR` 等环境变量，DSH 侧可通过
  `AIAB_DSH_ARGS` 指定命令行模板（支持 `{prompt}` 占位符）：
  ```bash
  AIAB_DSH_ARGS='exec --json "{prompt}"' ./apps/server/node_modules/.bin/tsx apps/server/src/index.ts
  ```
- 探测不到 `dsh` 时，后端会先把原因作为 `error` 事件下发，再自动回退到内置 Agent（不会假装成功）。

## 在 Claude Desktop / 其他 MCP 客户端里配置

```json
{
  "mcpServers": {
    "aiab": {
      "command": "node",
      "args": ["/绝对路径/apps/server/dist/mcp.mjs"],
      "env": {
        "AIAB_PROJECT_FILE": "/绝对路径/data/mcp-workspace/project.json"
      }
    }
  }
}
```

## 工具列表

`get_project_summary`、`analyze_harmony`、`create_track`、`update_track`、`set_instrument`、
`delete_track`、`create_clip`、`update_clip`、`delete_clip`、`write_notes`、`generate_smart_clip`、
`arrange_from_melody`、`melody_from_chords`、`set_tempo`、`set_key_scale`、`set_chords`、
`set_sections`、`set_master_volume`、`music_theory`、`web_search`、`fetch_url`

工具返回值统一为 `{ ok, message, data?, project? }`，修改工程的工具会把完整工程写回
`AIAB_PROJECT_FILE`，并作为文本结果返回给外部 Agent。

## 手工冒烟测试（不依赖任何模型）

MCP 是换行分隔的 JSON-RPC，可以直接用管道喂初始化请求：

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
 | AIAB_PROJECT_FILE=/tmp/aiab-test-data/mcp-workspace/project.json \
   ./apps/server/node_modules/.bin/tsx apps/server/src/mcp/server.ts
```
