# 云端 / NAS 同步（P6-B）

把「工程 + 音频资产」在设备之间搬运的轻量闭环。同步单位是一个单文件同步包 `.aiabsync`
（标准 ZIP），里面是工程 JSON、被引用到的 WAV 资产、资产索引和一份带 sha256 的 `manifest.json`。

- 服务端实现：[apps/server/src/sync/](../apps/server/src/sync/)、[apps/server/src/routes/sync.ts](../apps/server/src/routes/sync.ts)
- 命令行：[scripts/sync.mjs](../scripts/sync.mjs)
- 回归测试：[music-gen/tools/verify_sync.mjs](../music-gen/tools/verify_sync.mjs)

---

## 1. 三种拓扑

### 1.1 单机（本地数据面）

```
浏览器 ── HTTP ── 服务端(DATA_DIR=./data)
                       ├── projects/
                       ├── assets/
                       └── adapters/
```

默认形态，不需要同步。`GET /api/sync/status` 可以用来确认数据目录与占用。

### 1.2 NAS 模式（同一个数据面，多台机器访问）

把 `DATA_DIR` 指到 NAS 挂载点，**所有机器读写同一个数据面**：

```bash
# 例：macOS / Linux
DATA_DIR=/Volumes/Studio/aiab-data PORT=8787 pnpm start
# 例：Windows 网络盘（UNC）
$env:DATA_DIR = '\\NAS\Studio\aiab-data'; $env:PORT = '8787'; pnpm start
```

此时不需要同步包：工程/资产天然共享。推荐同时把适配器目录也放到 NAS：

```bash
AIAB_ADAPTERS_DIR=/Volumes/Studio/aiab-adapters
```

注意事项：

- 多个服务端实例同时写同一个 `data/` **没有分布式锁**：工程保存是「整文件覆盖」，适合
  单写多读；两台机器同时编辑同一个工程会互相覆盖（后写赢）。
- 数据库/缓存类文件目前都是 JSON 单文件，NAS 的锁语义差异可能导致极端情况下的写坏；
  如需强一致，请只在 NAS 上跑 **一个** 服务端，其它机器作为客户端连它。
- 用 `GET /api/sync/status` 确认 `writable=true`、`dataDir` 指向挂载点、`isUncPath` 符合预期。
  只读挂载会返回 `writable=false` 和 `writeError`。

### 1.3 两机模式（各自本地数据面 + 同步包搬运）

```
A 机服务(本地 data/) ──导出──▶ song.aiabsync ──拷贝(U盘/NAS共享目录/网盘)──▶ B 机服务(本地 data/) ──导入──▶ B 机工程+资产
```

适合「A 机做编曲、B 机跑 GPU 生成」或「公司 ↔ 家里」。用 CLI 或直接调 API：

```bash
# A 机
node scripts/sync.mjs export --server http://127.0.0.1:8787 --out ./song.aiabsync

# B 机
node scripts/sync.mjs import --server http://127.0.0.1:8787 --file ./song.aiabsync
```

---

## 2. HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/sync/export` | 导出同步包。JSON body：`{ projectIds?: string[], includeAssets?: boolean, save?: boolean, name?: string }` |
| POST | `/api/sync/import` | 导入同步包。`multipart/form-data` 字段 `file`，或 JSON `{ path }` 指向**服务端本机**的 `.aiabsync` 文件 / 解压后的目录 |
| GET | `/api/sync/status` | 数据面自检（NAS 模式确认挂载） |

### 2.1 导出

```bash
# 默认：直接返回 .aiabsync 文件流（application/zip）
curl -X POST http://127.0.0.1:8787/api/sync/export \
  -H 'Content-Type: application/json' \
  -d '{"projectIds":["p_xxx"],"includeAssets":true}' -o song.aiabsync

# save=true：写到 <DATA_DIR>/sync/<name>.aiabsync，返回路径（NAS / 两机搬运推荐）
curl -X POST http://127.0.0.1:8787/api/sync/export \
  -H 'Content-Type: application/json' \
  -d '{"save":true,"name":"song"}' | jq .
```

- `projectIds` 省略 → 导出**全部**工程。
- `includeAssets` 默认 `true`；设 `false` 只导工程（目标机器上资产引用会保留但缺文件）。
- 响应头：`X-Sync-Projects` / `X-Sync-Assets` / `X-Sync-Bytes` / `X-Sync-Warnings` / `X-Sync-Package-Id`。
- 引用到的资产文件缺失或 sha256 与资产索引不一致时**不会阻塞导出**，会写进
  `manifest.warnings` 并在响应头 `X-Sync-Warnings` 里计数。

### 2.2 导入

```bash
# multipart
curl -X POST http://127.0.0.1:8787/api/sync/import -F 'file=@song.aiabsync'

# 服务端本机路径（.aiabsync 文件，或解压后的目录）
curl -X POST http://127.0.0.1:8787/api/sync/import \
  -H 'Content-Type: application/json' -d '{"path":"D:\\\\sync\\\\song.aiabsync"}'
```

返回报告：

```jsonc
{
  "projects": [
    { "id": "p_new", "originalId": "p_old", "name": "我的歌（同步副本）", "action": "renamed", "updatedAt": 1794…, "trackCount": 6 }
  ],
  "assets": { "added": 2, "reused": 3, "total": 5 },
  "conflicts": [
    { "type": "project-id-conflict", "originalId": "p_old", "newId": "p_new", "reason": "…" }
  ],
  "warnings": ["…"],
  "manifest": { "format": "aiab-sync", "formatVersion": 1, "packageId": "…", "createdAt": "…", "projectCount": 1, "assetCount": 5, "fileCount": 6 },
  "summary": "同步包导入完成：工程 1 个（新建 1 / 副本 0 / 跳过 0），资产 新增 2 / 复用 3"
}
```

导入失败（不是同步包 / sha256 校验失败 / 资产不是合法 WAV / 工程结构不合法）返回 **400 + `{ error }`**，
错误信息为中文且尽量说明具体文件。

---

## 3. 同步包格式

`.aiabsync` 是**标准 ZIP**（store / deflate 均可），目录结构：

```
song.aiabsync
├── manifest.json           # 清单：版本 / 时间 / 每个文件的 sha256 + 字节数 / 工程与资产元数据
├── projects/
│   ├── p_aaa.json          # 工程快照（与 data/projects/<id>.json 同构）
│   └── p_bbb.json
└── assets/
    ├── index.json          # 资产索引子集（人读 + 工具核对）
    ├── asset_1234.wav
    └── asset_5678.wav
```

`manifest.json` 关键字段：

```jsonc
{
  "format": "aiab-sync",
  "formatVersion": 1,
  "packageId": "8 字节随机 hex",
  "createdAt": "ISO 时间",
  "generator": { "app": "ai-arrangement-buddy", "serverVersion": "0.1.0", "platform": "win32/x64" },
  "projectIds": ["p_aaa"],
  "projects": [{ "id": "p_aaa", "name": "…", "createdAt": 0, "updatedAt": 0, "trackCount": 6, "tempo": 120,
                 "file": "projects/p_aaa.json", "sha256": "…", "bytes": 1234 }],
  "assets":   [{ "id": "asset_1234", "sha256": "…", "name": "guitar.wav", "file": "assets/asset_1234.wav",
                 "bytes": 384044, "mime": "audio/wav", "durationSec": 2, "sampleRate": 48000, "channels": 2, "createdAt": 0 }],
  "includeAssets": true,
  "files": [{ "name": "projects/p_aaa.json", "sha256": "…", "bytes": 1234 }], // 除 manifest 自身外的全部文件
  "warnings": []
}
```

导入时会逐条校验 `files`：文件必须存在、字节数一致、sha256 一致，任何一项不过直接拒绝（不会写半套数据到
工程/资产目录——资产入库是幂等的，工程在全部校验通过后才落盘）。

### 3.1 「目录式同步包」

把 `.aiabsync` 解压成目录后，`POST /api/sync/import {"path": "<目录>"}` 同样可用（`manifest.json` 为入口）。
适合 NAS 上直接以共享文件夹形式同步的团队工作流。

### 3.2 为什么是自研 ZIP

Node 没有内置 zip，本仓库也**不新增 npm 依赖**。仓库里已有零依赖 ZIP 写入器
（[apps/server/src/zip.ts](../apps/server/src/zip.ts)，用于分轨 MIDI 导出），本项目在其基础上补了
只读解析器 [apps/server/src/sync/zip-read.ts](../apps/server/src/sync/zip-read.ts)（基于 `node:zlib` 的
`inflateRawSync`）。支持 store / deflate，拒绝 ZIP64 / 加密条目 / 重名条目 / 解压后 >512MB。
后续如需更高压缩率或流式处理，可把这两个文件替换成 `fflate`/`yazl` 等库，包格式无需变化。

---

## 4. 冲突策略

### 4.1 资产（按内容去重）

- `AssetRef.sha256` 是内容哈希；导入时先查本机资产索引，**sha256 命中即复用**，不重复写文件。
- 工程里的 `AssetRef.id` / `audioClips[].assetId` / `takes[].assetId` / `provenance.sourceAssetIds` /
  `analyses[].assetId` 会被重写成本机资产 id（跨设备后源 id 可能指向不同内容，不能直接沿用）。
- 导入会清掉 `AssetRef.localPath` / `deviceId`（本机路径不参与同步），`residency` 重置为 `local`。
- 包内未包含的资产引用会保留原 id 并写入 `warnings`。

### 4.2 工程（内容幂等 + id 冲突副本）

判定顺序：

1. 用「规范化 JSON（递归 key 排序）+ sha256」算导入工程的内容哈希；
2. 本机已有**内容完全相同**的工程 → `action: "skipped"`，返回命中的 `matchedId`（重复导入同一包不会产生副本）；
3. id 不存在 → 直接沿用原 id 保存，`action: "created"`；
4. id 已存在但内容不同 → 生成新 id（`p_xxx`），名称追加 `（同步副本）`，保留原 `createdAt` / `updatedAt`，
   `action: "renamed"`，并在 `conflicts` 里记录。**不会覆盖**本机工程。

> 因此「重复导入」是幂等的：资产 0 新增、工程 skipped；两台机器各自改过同一工程时，第二次导入的版本
> 会以「同步副本」的形式并存，由用户在 UI 里决定保留哪个。

---

## 5. CLI

```bash
node scripts/sync.mjs status [--server <url>] [--json]
node scripts/sync.mjs export [--server <url>] --out <file.aiabsync> [--project <id1,id2>] [--no-assets] [--name <包名>]
node scripts/sync.mjs import [--server <url>] --file <file.aiabsync> [--json]
```

- `--server` 默认 `http://127.0.0.1:8787`，也可用环境变量 `AIAB_SERVER`。
- CLI 只走 HTTP，不直接碰 `DATA_DIR`，所以可以对**另一台机器**执行（注意内网安全，见 §7）。
- `export` 默认把包写到本地；`import` 读本地文件后用 multipart 上传给服务端。

---

## 6. NAS / status 自检

`GET /api/sync/status` 返回：

```jsonc
{
  "ok": true,
  "serverVersion": "0.1.0",
  "dataDir": "\\\\NAS\\Studio\\aiab-data",
  "dataDirSource": "env",          // env = 由 DATA_DIR/AIAB_DATA_DIR 显式指定；default = 仓库内 data/
  "dataDirEnvVar": "DATA_DIR",
  "isUncPath": true,
  "writable": true,
  "writeError": "…",               // 仅 writable=false 时出现
  "platform": "win32/x64",
  "node": "v24.x",
  "projects": { "dir": "…", "count": 12, "bytes": 1234567 },
  "assets":   { "dir": "…", "count": 8, "files": 8, "bytes": 12345678 },
  "adapters": { "dir": "…", "shared": true, "count": 3, "bytes": 999 },
  "sync":     { "dir": "…", "count": 2, "bytes": 45678 },
  "generatedAt": "ISO 时间"
}
```

- `writable=false` 通常表示 NAS 只读挂载或权限不足，看 `writeError`。
- `adapters.shared=true` 表示 `AIAB_ADAPTERS_DIR` 指到了别处（例如共享盘）。
- `sync.count` 是 `<DATA_DIR>/sync` 下用 `save=true` 导出的同步包数量。

---

## 7. 安全注意（重要）

当前服务端按「本机 / 可信内网」设计：

- **没有鉴权**：任何能访问端口的人都能读写工程、上传资产、导出/导入同步包。
- 默认监听 `127.0.0.1`（只允许本机）。跨机器使用时必须显式 `HOST=0.0.0.0` 或内网 IP：
  - 只在**可信内网 / VPN**里开放，不要暴露到公网；
  - 用防火墙限制对 8787 端口的访问来源；
  - 不要把 `DATA_DIR` 指到公共网盘。
- `/api/sync/import` 的 `{ path }` 模式会让**服务端**读取它本机的任意文件路径（然后按 ZIP/同步包解析）。
  只对可信用户开放；如果以后暴露到半可信网络，应加路径白名单或只保留 multipart 上传。
- 同步包内文件只以 sha256 校验完整性，**没有签名**：能改包的人也能同时改 manifest。跨不可信介质
  （公网网盘）传输时请额外校验包本身的 sha256（CLI export 会打印）。
- 导入会执行 WAV 解析（`parseWav`）与 JSON schema 校验；单个同步包解压上限 512MB、
  multipart 上传上限 300MB（见 `apps/server/src/index.ts`）。

---

## 8. 回归测试

```bash
# 1) 构建服务端（同步路由在 dist 里）
node scripts/build-server.mjs
# 2) core 编译到 dist（测试脚本用 core 工厂函数造工程）
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --noEmit false --outDir packages/core/dist --declaration false
# 3) 起两个临时数据面跑闭环
node music-gen/tools/verify_sync.mjs
```

测试内容（`music-gen/tools/verify_sync.mjs`）：

1. 两个临时 `DATA_DIR` + 随机端口起服务，`/api/sync/status` 基线（可写、空数据面）；
2. 源数据面上传 WAV → 建引用该资产的工程；
3. 导出（下载流 + `save=true` 落数据面），校验 ZIP 头 / 计数 / 路径；
4. 目标数据面 multipart 导入 → 工程可读、AssetRef 重写、资产 sha256 与源一致；
5. 重复导入 → 资产 0 新增 / 工程 `skipped`（幂等）；
6. 目标侧改同 id 工程内容 → 再导入生成「同步副本」（新 id、时间戳保留）；
7. 再导入 → 幂等 skipped；
8. `{path}` 导入（服务器本机文件）+ 目录式同步包导入；
9. 非法包 / 篡改包 → 400 + 可读中文错误；
10. 目标 / 源 `/api/sync/status` 字段核对（工程数、资产数/占用、adapters、sync 包计数、可写性）。

清理：脚本会杀掉两个子进程并删除 `%TEMP%/aiab-sync-verify-*`。

---

## 9. 故障排查

| 现象 | 处理 |
| --- | --- |
| `GET /api/sync/status` 404 | 服务端未重启 / 未重新构建，确认 `registerSyncRoutes` 在 `index.ts` 里注册 |
| `dataDir` 不是 NAS 路径 | 检查启动时的 `DATA_DIR` / `AIAB_DATA_DIR` 环境变量（status 会显示来源） |
| `writable=false` | NAS 只读挂载、配额满、权限不足（看 `writeError`） |
| 导入报「sha256 校验失败」 | 包在传输中被改坏（网盘/杀软/文本模式传输）；重新导出或用 CLI 校验包 sha256 |
| 导入报「资产入库失败：P1 只支持 WAV」 | 包内资产不是 PCM/float WAV；先转 WAV |
| 导入后资产缺失 | 导出时 `includeAssets=false`，或源数据面资产文件缺失（看导出 `warnings`） |
| 重复导入产生很多工程 | 只会在「同 id 且内容不同」时产生副本；确认不是每次都在改工程 `updatedAt` 后再导出 |
