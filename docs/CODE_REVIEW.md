# 全量代码审查报告（2026-11-05）

> 审查对象：AI 编曲伴侣（packages/core + apps/server + apps/web + 构建/部署脚本 + 文档）
> 审查方式：4 个专职 reviewer 分区逐行通读 + Lead 跨模块/安全/部署复核；关键结论均用临时服务、真实 HTTP 请求、`tsx` 脚本或浏览器端到端实跑验证。
> 结果规模：**83 条**（严重 2 / 高 12 / 中 40 / 低 29），完整索引见 [附录 A](#附录-a全部发现索引)。

---

## 0. 结论摘要

工程质量整体不差：类型检查全绿、冒烟 12/12、真实浏览器端到端 17/17，架构分层清晰（core / server / web，生成器纯函数、SSE 快照回传的设计也自洽）。**但存在 4 类必须优先处理的问题**：

1. **本机后端等于「无鉴权的任意人可调用 API」**：`/api/*` 完全没有鉴权，CORS 又是 `origin:true`，且不校验 `Host`。任意网页（甚至 DNS rebinding）都能读写/删除工程、改设置。进一步串联出两条**已实测的利用链**：
   - **真实 API Key 外泄**（严重）：脱敏值回传即复用真实 Key + 任意 `baseUrl` → 实测捕获 `Authorization: Bearer sk-REAL-...`；
   - **任意可执行文件被 spawn**（严重）：无鉴权写 `agent.executablePath` + `/api/ai/chat`。
2. **数据可靠性**：工程与设置不是原子写（与架构文档承诺相反），文件一旦写坏/截断，工程会**静默从列表消失**、API Key 会**静默回默认**；自动保存还有一类竞态会让新编辑**不落盘且无提示**；「撤销 AI 改动」会不可逆丢弃其后的手动编辑，跨工程时甚至覆盖旧工程文件。
3. **功能正确性有硬伤**：播放到结尾后播放按钮失效；播放中任何编辑会造成音符重复触发（叠音）；静音/独奏不影响混响延迟发送；编曲器给非首段配错和声；rock 默认进行整体跑调；≥10 条旋律轨时 MIDI 通道互相覆盖。
4. **边界与契约缺口**：`projectSchema` 不校验 `quality/scale` 枚举、`keyToPitchClass` 不认降号调，AI 或导入数据一旦带非常规写法就会崩溃或静默降级。

> **重要前提（务必先读）**：本次审查期间该工作区**被另一个进程并发修改**（新增 `apps/server/src/tools/validate.ts`、`providers/retry.ts`、`scripts/test-ai.mjs`，并改写了 App/MixerPanel/StatusBar/agent/providers/tools 共 15 个文件、重建了 dist）。本报告是**某一时点的快照**；已知 SRV-12（降号和弦名）已被新加的 `validate.ts` 修复。另外本仓库**没有 git**（`.git` 不存在，本机 git 又因 Xcode 许可不可用），无法 diff/回滚——这本身是高风险项（LEAD-12）。

---

## 1. 安全（P0：先修）

### 1.1 🔴 SRV-01 + LEAD-01（实测）：任意网页可把你保存的 API Key 骗到它的服务器

**利用链（3 步，全部无需用户确认）：**

```
① GET  /api/settings                      → 返回脱敏 Key（sk-R••••6789）和当前 baseUrl
② PUT  /api/settings                      → 把 baseUrl 改成攻击者服务器，apiKey 原样回传脱敏值
   （storage/settings.ts isMaskedOf() 里 `maskedValue.includes('••')` 兜底会把真实 Key 补回去）
③ POST /api/settings/test-provider 或 /api/ai/chat
   → 服务端用真实 Key 请求攻击者 baseUrl，Authorization: Bearer sk-REAL... 原样送出
```

**实测记录**（本机 mock 攻击者服务捕获）：

```
GET /v1/models
  authorization: Bearer sk-REAL-SECRET-DO-NOT-LEAK-0123456789
KEY LEAKED TO ATTACKER SERVER: true
```

根因在 [storage/settings.ts:58](../apps/server/src/storage/settings.ts) 的宽松判断，以及 [routes/settings.ts:39](../apps/server/src/routes/settings.ts) 允许请求体同时携带 `baseUrl + 脱敏 secret`。修法：

```ts
// 1) 只接受精确匹配，删掉 includes('••') 兜底
if (maskedValue === maskSecret(realValue)) return true
// 2) baseUrl 变化时必须重新输入 Key，绝不能复用旧 Key
// 3) test-provider / models 优先用服务端已存配置，只允许覆盖 model 等非敏感字段
```

### 1.2 🔴 SRV-03：无鉴权写 `agent.executablePath` → 服务端直接 spawn 任意本地可执行文件

`PUT /api/settings` 无鉴权 → `agent.executablePath` 可写 → [agent/probe.ts](../apps/server/src/agent/probe.ts) 的 `resolveCodexPath` 只做 `existsSync` → [agent/codex.ts:150](../apps/server/src/agent/codex.ts) `spawn(codexPath, args)`。实测把 executablePath 指向 `/tmp/.../fakecodex.sh` 后，`POST /api/ai/chat` 成功让它以 `exec --json ... <完整提示词>` 执行。

补充说明（避免过度解读）：远程网页攻击者无法凭空创建可执行文件，因此「纯远程任意代码执行」需要预置文件；但**若用户本机装了 codex/dsh，攻击者可直接改用 codex 后端 + prompt 让 Agent 执行 shell 命令**，效果等同本机命令执行。修法：executablePath 不接受远程写入（只从服务端环境变量/白名单解析），或在设置页加显式二次确认；根本上是补鉴权（见 1.3）。

### 1.3 🟠 SRV-02 + LEAD-10：零鉴权 + CORS 反射，且无 Host 校验（DNS rebinding 也绕过）

[index.ts:34](../apps/server/src/index.ts) `cors({ origin: true, ... })`，所有 `/api/*` 无 token。实测：

```
OPTIONS /api/settings (Origin: https://evil.example) → access-control-allow-origin: https://evil.example
PUT     /api/settings (Origin: https://evil.example) → 200
GET     /api/projects (Host: evil.example:8823)      → 200   ← 无 Host 校验，DNS rebinding 可同源访问
POST    /api/ai/cancel (Origin: https://evil.example) → 200  ← 简单请求，连 CORS 白名单都拦不住
```

修法（按顺序）：

1. **前端本来就同源**（`lib/api.ts` 里 `BASE = ''`，开发态走 Vite proxy / 生产同源），因此 **直接关闭 CORS**（`origin: false`）即可，不需要任何白名单；
2. 校验 `Host`/`Origin`/`Sec-Fetch-Site`（只允许 `127.0.0.1`/`localhost` 与同源）；
3. 引入本地 token：启动时生成随机 token，注入前端（HTML 或启动日志），所有 `/api` 请求带 header、SSE 用 query token；`HOST=0.0.0.0` 时强制开启并打印警告；
4. Docker 场景（`docker-compose.yml` 映射端口 + `HOST=0.0.0.0`）在没有 token 前不要对外暴露。

### 1.4 🟠 SRV-04 / SRV-13：SSRF

- [routes/settings.ts:49](../apps/server/src/routes/settings.ts) `/api/settings/models`、`test-provider` 接受任意 `baseUrl`，且把上游响应体（截断）回显进错误信息 → 可探测/读取内网与本机服务（实测读到 mock 服务的 `INTERNAL-SECRET-TOKEN`）。
- [tools/web.ts:256](../apps/server/src/tools/web.ts) `fetch_url` 只校验协议是 http(s)，不限制回环/私网地址，Agent 可读本机任意 HTTP 服务。

修法：解析目标地址后拒绝私有网段/回环（除非显式开启「允许本地服务」，例如 Ollama 场景需要白名单端口）；上游错误只回传状态码与脱敏摘要。

### 1.5 🟠 SRV-05：设置里「关闭联网」实际没关

[tools/web.ts:195](../apps/server/src/tools/web.ts)：`provider === 'none'` 会落到 `else` 分支仍然请求 DuckDuckGo（实测 `search.provider='none'` 仍返回 6 条真实结果），`fetch_url` 也只检查 `allowWebSearch`。UI 文案是「关闭联网搜索」，属于隐私承诺与实现不符。修法：`none` 直接返回 `ok:false`，`fetch_url` 同样判断。

### 1.6 其余安全项

- LEAD-02：`GET /api/settings` 只脱敏 `apiKey`，**`extraHeaders` 里的密钥明文返回**（很多网关把 Key 放自定义头）。
- LEAD-03：`data/settings.json` 以 `0644` 落盘且含明文 Key（实测 `-rw-r--r--`），同机其他用户可读；建议 `0o600` + Docker 里 `chmod 700 /data`。
- LEAD-04：`/api/health` 无鉴权泄漏 `dataDir`、codex 路径、ffmpeg 版本。
- SRV-06：`/api/generate` 的 `bars` 无上限，实测 `bars=1000000` 可把事件循环卡死 >18s（未鉴权 + 可跨站触发 = 远程打挂）。

---

## 2. 数据可靠性（P1）

### 2.1 🟡 SRV-10 + SRV-11 + LEAD-09：非原子写，坏文件静默消失

[storage/projects.ts:53](../apps/server/src/storage/projects.ts) 和 [storage/settings.ts:39](../apps/server/src/storage/settings.ts) 都是直接 `writeFileSync`，而 [ARCHITECTURE.md §7](./ARCHITECTURE.md) 明确承诺「先写 .tmp 再 rename 的原子替换」，MCP server 里反而做对了。后果：写入过程崩溃/断电 → 文件截断 → `loadProject` 静默返回 `null`（工程从列表消失、无任何提示）；settings 解析失败静默回默认 → **所有 API Key 与配置一起「消失」**。

修法（两份存储统一）：

```ts
const temp = `${file}.tmp`
writeFileSync(temp, payload, { mode: 0o600 })
renameSync(temp, file)          // 同目录 rename 才是原子的
```

### 2.2 🟠 WS-08：自动保存在途时的新编辑被静默丢弃

[lib/session.ts:52](../apps/web/src/lib/session.ts)：P1 保存请求在途 → 用户编辑出 P2（置 dirty，排新防抖 timer）→ P1 返回后无条件 `setSaveStatus('saved')`，effect cleanup 顺手清掉 P2 的 timer → **P2 既不保存、也没有 dirty 提示**，刷新即丢。修法：保存成功时比较 `JSON.stringify(当前 project) === serialized`，不一致则保持 dirty 并重新调度；或改成串行保存队列 + 版本号。

### 2.3 🟠 WS-04：撤销 AI 改动会丢手动编辑，跨工程还会覆盖旧工程文件

[store.ts:896](../apps/web/src/store/store.ts)：`undoAiChanges` 直接 `set({ project: snapshot })`，不压 history、不清 future、不重算 selection；`aiUndoSnapshot` 在 `setProject`/`clearMessages` 都不清。后果：AI 之后的所有手动编辑不可逆丢失；打开工程 B 后旧消息里的「撤销」会把当前工程换成工程 A 的旧快照，并按 A 的 id 自动保存 → **覆盖 A 较新的已保存内容**。修法：应用快照前校验 `snapshot.id === project.id`，并 `past: [...past, clone(current)]`；切换工程时清空 `aiUndoSnapshot`。

### 2.4 🟡 SRV-07 / SRV-08：两个会静默丢编排的 `/api/generate` 分支

- `intent=variation`（[generate.ts:216](../apps/server/src/routes/generate.ts)）：把每个智能片段重新生成后 `startBeat` 归 0 —— 实测 8 拍位置的片段被搬回第 0 拍，编排位置丢失。
- `intent=arrange` 未指定旋律时（[generate.ts:137](../apps/server/src/routes/generate.ts)）：`project.tracks = tracks` 直接替换全部轨道，用户已有轨道被静默丢弃（接口无任何提示）。

修法：variation 保留原 `startBeat/lengthBeats`；arrange 改为「新增伴奏轨」或要求显式 `replaceExisting:true`。

---

## 3. 功能正确性（P1）

### 3.1 音频引擎（4 条高）

| 现象 | 位置 | 说明 |
| --- | --- | --- |
| 🟠 播放到结尾后播放按钮失效 | [engine.ts:657](../apps/web/src/audio/engine.ts) | `finishPlayback` 只改内部 `isPlaying`，不通知 store；`store.isPlaying` 卡在 true，再点播放走 pause 分支，第二次从结尾立即结束。示例工程 8 小节约 18s 必现。 |
| 🟠 播放中编辑 → 音符重复触发 | [engine.ts:530](../apps/web/src/audio/engine.ts) | `applyProject` 把 `scheduledPosition` 拨回当前位置，但已排给 Tone 的音符不会取消；look-ahead 窗口内的音符被再次排期 → 叠音/爆音。调音量、拖音符即可触发。 |
| 🟠 静音/独奏/推子不影响混响延迟 | [engine.ts:375](../apps/web/src/audio/engine.ts) | send 从 `voice.output` 直接接到效果总线，绕过 `Tone.Channel`（mute/volume/pan 都在 Channel 上）；离线渲染却会剔除 mute 轨 → 导出与实时不一致。 |
| 🟡 播放中切 loop 无效 | [engine.ts:890](../apps/web/src/audio/engine.ts) | `scheduler.loop` 只在 `play()` 设置；按 L / 拖循环带后必须 stop→play 才生效。 |

修法要点：`finishPlayback` 里回调 `onEnded` → `store.setPlaying(false)`；`applyProject` 改为「播放中只做混音参数热更新，不重置排期」，或维护已排期事件集合并先取消再重排；send 改为从 `channel` 之后分叉。

### 3.2 乐理 / 编曲（core，3 条高）

- 🟠 **ARR-01** [arrange.ts:445](../packages/core/src/arrange.ts)：`buildAccompaniment` 按段落切了时间轴，却没把 `chords` 按段落切片，`generateSmartClip` 内又从片段局部 0 拍铺整首进行。实测 pop 16 小节：第 3 小节 `project.chords = Am`，但 bass 弹 C、和弦轨是 C-E-G。**「一键创作」的非首段和声都是错的**。修法：循环内复用已有的 `chordsForBarRange()` 切片。
- 🟠 **THR-01** [theory.ts:326](../packages/core/src/theory.ts)：`romanToChord` 在自然/和声小调与调式里对 `bVII/bVI/bIII` 二次降半音。实测 `progressionToChords(['i','bVII','bVI','bVII'],'A','minor')` → `Am F# E F#`（应为 `Am G F G`）；`rock` 风格默认进行就是这个，所以 `composeProject('rock')` 整首跑调。
- 🟡 **CONST-01** [constants.ts:304](../packages/core/src/constants.ts)：`keyToPitchClass` 只认升号名且**静默回退 C**（实测 `Bb/Db/Eb/Ab -> 0`），而 `generators` 内又有一份认识降号的 `keyToPc`；AI 说「降 B 大调」就会得到 C 调的和弦与 MIDI 调号。
- 🟡 **MODEL-01** [model.ts:80](../packages/core/src/model.ts)：`chord.quality`、`project.scale` 在 zod 里只是 `z.string()`（违反 [CONTRACTS §3](./CONTRACTS.md)），`quality:'M7'`、`scale:'Dorian'` 能通过所有 HTTP/存储校验，随后 `chordLabel`/`scalePitches` 抛 TypeError，生成器则静默产出空片段。
- 🟡 **GEN-01** [generators/index.ts:953](../packages/core/src/generators/index.ts)：琶音生成器奇数和弦槽沿用上一个和弦音池。实测 I-V-vi-IV：第 2 小节应当是 G 大三和弦，实际发出 `C-E-G`；第 4 小节应是 F，实际是 `A-C-E`（每两小节一次不协和，很明显）。
- 🟡 **GEN-02**：`chordSlots` 硬编码 1024 槽上限，64 小节 12/8 + 0.25 拍和弦只排到 2/3 长度，后半段静默空白。

### 3.3 MIDI 导出（3 条）

- 🟠 **MID-01** [midi.ts:85](../packages/core/src/midi.ts)：通道游标跳过鼓通道后未按「实际分配结果」推进——`nextChannel(9)=10` 但游标只到 10，下一条仍是 10。实测第 10、11 条旋律轨共用 ch10，program change 与同音高 note-off 互串。任何 ≥10 条旋律轨的工程导出即可触发，且无警告。
- 🟡 **MID-02**：调号 meta 只区分大小调，`jazz` 默认 D dorian 导出 `sf=2`（应为 0），五声/布鲁斯同样错。
- ⚪ **MID-03/04**：`normalizeStart`、`separateTracks` 两个公开选项都是空操作（两个分支代码完全相同），调用方预期落空。

### 3.4 交互（web，5 条）

- 🟠 **WEB-01** [ArrangementView.tsx:1067](../apps/web/src/features/arrangement/ArrangementView.tsx)：拖片段左边缘只改 `startBeat/lengthBeats`，**不动 notes**。音符是相对片段起点，于是内容整体右移、开头不裁剪；`note.start >= lengthBeats` 的音符仍在数组里，而 `engine.rebuildNoteIndex` 不看 `lengthBeats` → **被裁掉的音符仍在发声**。
- 🟡 **WEB-02/06**：多选片段/音符向左拖过 0 拍时，逐个 `Math.max(0, ...)` 各自贴边，选区/和弦被压扁（拖拽路径有全局 `minStart` 兜底，键盘路径没有）。
- 🟡 **WEB-04 + WS-05/WS-12**：循环状态有 `loopEnabled` 与 `project.loop.enabled` 两份来源，`setProject` 不同步；循环区间编辑绕过 `mutate`/撤销栈，撤销别的编辑后二者失步（LOOP 条变灰但仍在循环）。
- 🟡 **WEB-07**：⌘K 命令面板的全局 keydown 未判断 IME 组合状态（ChatPanel 有判断），中文输入法按 Enter 选词会直接执行高亮命令（可能是删除类）。
- 🟡 **WEB-09**：走带「循环小节」输入框用 ↑/↓ 改 store，draft 不刷新，失焦/回车再用旧 draft 提交 → 修改被悄悄还原。
- 🟡 **WEB-13**：设置/导出/帮助等弹窗打开时，App 全局快捷键仍生效（Space 播放、1/2/3 切视图）。
- 🟡 **WEB-03**：「缩放至适合窗口」硬编码每小节 4 拍，3/4、6/8、5/4 下适配错误。
- 🟡 **WEB-05/WS-18**：钢琴卷帘 ⇧↑/↓ 实际移调 ±12，帮助与右键菜单却标 ±1（编曲视图又是 +1），同一键位两视图语义相反。
- 🟡 **WS-11 / WS-20 / WS-17**：MIDI 选「不使用」后仍接收所有设备；MIDI Thru 用 0.6s 一次性 preview 导致长按断音/松键不停；空格播放路径漏传 `countIn`。

### 3.5 AI / Agent 后端

- 🟡 **SRV-09** [agent/codex.ts:269](../apps/server/src/agent/codex.ts)：`if (!child.killed) child.kill('SIGKILL')` —— `child.killed` 在发出 SIGTERM 后即为 true，**SIGKILL 兜底永远不会执行**。实测 cancel 后忽略 SIGTERM 的子进程仍存活，SSE 请求永久挂起（dsh 后端同样）。
- 🟡 **SRV-12**（审查中已被并发修复）：`set_chords` 的降号音名 `Bb/Eb` 曾被静默丢弃/变 C；新加的 `tools/validate.ts` 已用 `normalizeRoot` 修好，**建议回归测试保留该用例**。
- 🟡 **SRV-15**：`/api/agents` 用 `spawnSync` 同步探测外部 Agent，`probeVersion` 超时不保证终止 → 可阻塞事件循环。
- ⚪ **SRV-17**：MCP server 的 `AIAB_PROJECT_ID` 被忽略（三元两支相同），会把工具改动写到「最近工程」而不是指定工程。

---

## 4. 性能（P2）

| 问题 | 位置 | 说明 |
| --- | --- | --- |
| 🟡 每次编辑 `structuredClone` 整个工程 | [store.ts:329](../apps/web/src/store/store.ts)、[clipEditing.ts:156](../apps/web/src/features/arrangement/clipEditing.ts) | 撤销栈 80 份完整快照。实测 8k 音符 4.1ms/份、25k 音符 13.1ms/份；60fps 拖拽时单帧额外 4–25ms，栈常驻 45–150MB。 |
| 🟡 聊天流式每 token 全量重渲染 | [ChatPanel.tsx:714](../apps/web/src/features/chat/ChatPanel.tsx) | 每收到一个 delta 就重建 messages 数组、重渲染全部历史消息、全文重解析 Markdown，长对话明显掉帧。 |
| 🟡 导出 WAV 主音量应用两次 | [render.ts:154](../apps/web/src/audio/render.ts) + [render.ts:330](../apps/web/src/audio/render.ts) | 合成器组内 `Tone.Gain(masterVolume)` 一次，最终 PCM 再乘一次 → 合成器轨实际是 `masterVolume²`，而 SoundFont 轨只乘一次，混合导出相对音量失衡。 |
| 🟡 音频导出整块读内存 | [export.ts:187](../apps/server/src/routes/export.ts) | 上传上限 300MB，`readFileSync` 把上传文件和转码结果整块读入，峰值内存可达数倍。 |
| ⚪ 单 chunk 1.58MB | [vite.config.ts](../apps/web/vite.config.ts) | gzip 477KB，无按视图拆分/懒加载（LEAD-07）。 |

补充：`hooks/useMidiInput.ts`（170 行）全仓无挂载，其录音逻辑与 `features/midi/useMidiPerformance` 重复，属死代码（LEAD-08）。

---

## 5. 一致性与可维护性（P3）

- **LEAD-09（文档与实现不符）**：ARCHITECTURE §7 承诺原子写，实现不是（见 2.1）；README 的「数据与隐私」在无鉴权 + CORS 下也不成立。
- **LEAD-01**：音源表有 **3 份副本**（`storage/soundfonts.ts` 下载表、`routes/soundfonts.ts` 展示表、`scripts/fetch-soundfonts.mjs`），且已分歧：服务端 `generaluser-gs` 的下载 URL **实测 404**，该下载端点必然失败；脚本 `--id=generaluser-gs` 会把 **147KB HTML** 存成 `GeneralUser_GS.sf2`（已复现），且因「文件已存在」无法重试。建议抽唯一数据源 + 校验文件魔数。
- **LEAD-05**：`SERVE_STATIC=1` 时未知路径（含 `/data/settings.json`、`/assets/`）统一返回 200 `index.html`，掩盖 404、影响排障与缓存语义（实测无路径穿越泄漏）。
- **LEAD-06**：Dockerfile 用 corepack（无 `packageManager` 字段），launch.mjs 写死 `pnpm@11.28.5`，两条安装路径可能解析到不同 pnpm 大版本；建议固定 `packageManager`。
- **LEAD-11**：`/api/generate` 默认 seed 用 `Math.random()` 且不回传，结果不可复现，违背 ARCHITECTURE §3 的「可复现」原则（e2e 两次生成结果因此不同）。
- 其它：`SRV-16` 非法 `scale` 直接 500 并回显内部 TypeError；`SRV-18` 统一错误处理器把内部错误原文（含绝对路径）返回给调用方；`SRV-19` 保存时把客户端 `updatedAt` 原样落盘、却返回服务端 `savedAt`，列表排序会被旧时钟带偏；`MODEL-02` 段落乱序时 `projectEndBeat` 低估工程长度；`GEN-03` riff/strum 同音高重叠导致 MIDI note-off 互切；`GEN-04` `generateSmartClip` 吞掉所有生成器异常返回空片段；`THR-02` 和声小调 vii°7 写成 m7b5；`GEN-05/06` 扫弦装饰音偏移与鼓 pattern 标签问题。
- **环境/流程风险**：本仓库没有 git（`.git` 不存在 + 本机 git 被 Xcode 许可阻断），且本次审查期间有并发写入（LEAD-12）——建议优先恢复版本控制，否则任何修复都不可追溯、不可回滚。

---

## 6. 建议修复顺序

**第 0 批（当天，安全止血）**
1. `origin:false`（前端同源，无需 CORS）+ 校验 `Host`/`Origin`/`Sec-Fetch-Site`；
2. `isMaskedOf` 精确匹配 + baseUrl 变更强制重填 Key（SRV-01）；
3. `extraHeaders` 脱敏、settings 文件 0600（LEAD-02/03）；
4. `/api/generate` 的 `bars` 加上限、`search.provider='none'` 真正断网（SRV-05/06）。

**第 1 批（本周，数据可靠性）**
5. 工程/设置改为 tmp+rename 原子写（SRV-10/11、LEAD-09）；
6. 修自动保存竞态（WS-08）；修 `undoAiChanges` 的历史与跨工程校验（WS-04）；
7. 修 `variation` 的 startBeat 与 `arrange` 的全量替换（SRV-07/08）。

**第 2 批（本周，功能正确性）**
8. 播放结束通知 / 播放中重排 / send 路由（WS-01/02/03）；
9. 编曲器按段落切和弦（ARR-01）；小调 b 级数（THR-01）；`keyToPitchClass` 支持降号（CONST-01）；schema 枚举收紧（MODEL-01）；
10. MIDI 通道分配与调号（MID-01/02）；
11. 片段左边缘 trim 与越界音符（WEB-01）、循环双源统一（WEB-04/WS-12）、IME/弹窗快捷键（WEB-07/13）。

**第 3 批（下个迭代，质量）**
12. 性能：手势期间不 clone、聊天增量渲染、导出主音量只乘一次（WS-13、WEB-08、WS-06）；
13. 清理死代码与失效选项（LEAD-08、MID-03/04）、音源表统一（LEAD-01）、补仓库 git 与鉴权 token（LEAD-10/12）。

---

## 附录 A：全部发现索引

> 由 `.review/findings-all.json` 自动生成；每条均含 evidence / why / fix / confidence 字段。
> 「严重」= 数据丢失/主流程崩溃/RCE/密钥泄漏；「高」= 常见操作下功能错误、数据风险、可被利用的越权；「中」= 边界条件错误、性能隐患、与契约不符；「低」= 局部瑕疵、可维护性、文档不一致。

### 🔴 严重（2 条）

| ID | 类别 | 位置 | 摘要 |
| --- | --- | --- | --- |
| SRV-03 | 安全 | `apps/server/src/routes/settings.ts:26` | settings.agent.executablePath 可远程写入并被直接 spawn：未授权任意可执行文件执行（RCE） |
| SRV-01 | 安全 | `apps/server/src/storage/settings.ts:58` | 脱敏 Key 合并逻辑可被利用：把已存真实 API Key 发送到攻击者指定的 baseUrl |

### 🟠 高（12 条）

| ID | 类别 | 位置 | 摘要 |
| --- | --- | --- | --- |
| SRV-02 | 安全 | `apps/server/src/index.ts:34` | 无任何鉴权 + CORS origin:true，任意网页可读写/删除本地工程、修改设置、触发 AI 请求 |
| SRV-06 | 性能 | `apps/server/src/routes/generate.ts:87` | /api/generate 的 compose 分支对 bars 无上限，单个未鉴权请求即阻塞事件循环（可打挂整个后端） |
| SRV-04 | 安全 | `apps/server/src/routes/settings.ts:49` | settings/models 与 test-provider 接受任意 baseUrl：SSRF + 把上游响应体回显给调用方（可读内网/本机服务） |
| SRV-05 | 功能 bug | `apps/server/src/tools/web.ts:195` | 设置里关闭联网（search.provider='none'）后 web_search 仍然访问 DuckDuckGo，fetch_url 也可用 |
| WS-01 | 功能 bug | `apps/web/src/audio/engine.ts:657` | 播放到工程末尾后引擎静默停止，但 store.isPlaying 仍为 true，导致「播放」按钮失效、无法再次播放 |
| WS-02 | 功能 bug | `apps/web/src/audio/engine.ts:530` | 播放中任何工程编辑（调音量/拖音符）都会让 applyProject 重置排期指针，已排期的音符被重复触发，出现叠音/爆音 |
| WS-03 | 功能 bug | `apps/web/src/audio/engine.ts:375` | 每轨混响/延迟/合唱 send 接在 Tone.Channel 之前，静音、独奏、音量推子都不影响这些发送，静音轨仍有混响回声 |
| WEB-01 | 功能 bug | `apps/web/src/features/arrangement/ArrangementView.tsx:1067` | 拖动片段左边缘改起点时，片段内音符整体后移且不会被裁剪；越界音符仍会发声 |
| WS-04 | 数据丢失 | `apps/web/src/store/store.ts:896` | 「撤销 AI 改动」丢弃 AI 之后的手动编辑且不可重做；切换工程后旧工程的快照仍可被应用，覆盖当前工程并写回旧工程文件 |
| ARR-01 | 功能 bug | `packages/core/src/arrange.ts:445` | 编曲器每个段落都从第 0 拍重新铺和弦，非首段和声与工程和弦/主旋律错位 |
| MID-01 | 功能 bug | `packages/core/src/midi.ts:85` | MIDI 导出从第 10 条旋律轨起通道号重复，program change/音符互相覆盖 |
| THR-01 | 功能 bug | `packages/core/src/theory.ts:326` | romanToChord 对 b 级数在小调/调式里重复降半音，rock 风格默认进行跑出调外和弦 |

### 🟡 中（40 条）

| ID | 类别 | 位置 | 摘要 |
| --- | --- | --- | --- |
| SRV-09 | 资源泄漏 | `apps/server/src/agent/codex.ts:269` | codex/dsh 子进程 SIGKILL 兜底因 child.killed 判断失效；取消/超时后子进程残留、SSE 请求永不结束 |
| SRV-15 | 性能 | `apps/server/src/agent/probe.ts:110` | /api/agents 用 spawnSync 同步探测外部 Agent，且 probeVersion 超时不保证终止：可让整个事件循环卡死 |
| LEAD-10 | 安全 | `apps/server/src/routes/ai.ts:178` | CORS 白名单即便加上，不带 body 的简单请求（如 POST /api/ai/cancel）仍可被跨站 CSRF 触发 |
| SRV-07 | 功能 bug | `apps/server/src/routes/generate.ts:216` | intent=variation 会把所有智能片段搬回第 0 拍并改写长度（丢编排位置） |
| SRV-08 | 数据丢失 | `apps/server/src/routes/generate.ts:137` | intent=arrange 未指定旋律时直接 project.tracks = 新伴奏，静默丢掉用户全部既有轨道 |
| SRV-14 | 竞态 | `apps/server/src/soundfonts.ts:102` | 音色库并发下载共用固定 .part 临时文件且无超时/中止：可写坏文件、客户端断开后下载继续 |
| LEAD-01 | 功能 bug | `apps/server/src/soundfonts.ts:48` | 音色库源表三份副本不一致：generaluser-gs 服务端下载链接 404（实测）；命令行脚本还会把 HTML 页面存成 .sf2 |
| SRV-10 | 数据丢失 | `apps/server/src/storage/projects.ts:53` | 工程保存不是原子写（直接 writeFileSync），截断后 loadProject 静默返回 null，工程从列表消失且无提示 |
| SRV-11 | 数据丢失 | `apps/server/src/storage/settings.ts:40` | settings.json 非原子写 + 解析失败静默回默认：一次写坏/截断会让所有 API Key 与配置“消失” |
| LEAD-02 | 安全 | `apps/server/src/storage/settings.ts:58` | GET /api/settings 只脱敏 apiKey，extraHeaders 里的密钥（如 x-api-key / Authorization）原样返回 |
| LEAD-03 | 安全 | `apps/server/src/storage/settings.ts:39` | settings.json 以 0644 权限落盘且含明文 API Key，同机其他用户可读 |
| SRV-12 | 功能 bug | `apps/server/src/tools/project.ts:175` | set_chords 的 toChordSpec 不处理降号音名：Bb/Eb 被静默丢弃，"Bb7" 会变成 C 大三和弦 |
| LEAD-12 | 功能 bug | `apps/server/src/tools/validate.ts:1` | 审查期间工作区被并发修改（无效发现风险）：另有进程在改写源码并重建 dist |
| SRV-13 | 安全 | `apps/server/src/tools/web.ts:256` | fetch_url 工具无内网/回环地址限制：Agent 可读取本机任意 HTTP 服务（SSRF） |
| WEB-13 | 交互 | `apps/web/src/App.tsx:171` | 设置/导出/帮助等弹窗打开时，App 的全局走带快捷键仍然生效（Space 播放、1/2/3 切视图）；SELECT 焦点也没排除 |
| WS-05 | 功能 bug | `apps/web/src/audio/engine.ts:890` | 播放中切换循环开关/拖循环区间不生效：scheduler.loop 只在 play() 时设置，applyProject 热更新从不更新它 |
| WS-07 | 功能 bug | `apps/web/src/audio/engine.ts:748` | 试听/MIDI Thru 的 previewVoices 缓存按 trackId 永不失效：换乐器或换情绪后试听仍是旧音色 |
| WS-14 | 竞态 | `apps/web/src/audio/engine.ts:1095` | 导出渲染期间没有互斥保护：全局 Tone 上下文被切到 OfflineAudioContext，此时按空格/预览会污染导出或产生幽灵播放 |
| WS-11 | 功能 bug | `apps/web/src/audio/midi.ts:94` | MIDI 设备选「不使用 MIDI」后仍然接收所有设备输入，且热插拔会把它自动改回第一个设备 |
| WS-06 | 功能 bug | `apps/web/src/audio/render.ts:154` | 导出 WAV 时合成器轨的主音量被应用两次（音量平方），与 SoundFont 轨相对音量失衡 |
| WEB-04 | 一致性 | `apps/web/src/features/arrangement/ArrangementView.tsx:164` | 循环区间的编辑绕过撤销栈；loopEnabled 与 project.loop.enabled 两份状态会在撤销后失步 |
| WEB-02 | 功能 bug | `apps/web/src/features/arrangement/clipEditing.ts:161` | 多选片段用方向键微移时，越过 0 拍的片段各自贴边，选区间距被压缩 |
| WEB-10 | 性能 | `apps/web/src/features/arrangement/clipEditing.ts:156` | 拖拽片段/缩放/BPM 拖动时每个 pointermove 都 structuredClone 整个工程并触发全局重渲染 |
| WEB-03 | 功能 bug | `apps/web/src/features/arrangement/timeline.ts:288` | “缩放至适合窗口”把每小节硬编码为 4 拍，3/4、6/8、5/4 等拍号下适配错误 |
| WEB-08 | 性能 | `apps/web/src/features/chat/ChatPanel.tsx:714` | 流式每收到一个 token 都重建 messages 并重渲染/重解析全部历史消息，长对话明显掉帧 |
| WEB-07 | 功能 bug | `apps/web/src/features/command/CommandPalette.tsx:139` | 命令面板键盘监听未判断输入法组合状态：中文输入法按 Enter 选词会直接执行高亮命令 |
| WEB-05 | 一致性 | `apps/web/src/features/pianoroll/PianoRollView.tsx:1252` | 钢琴卷帘里 Shift+↑/↓ 实际移调一个八度，而帮助/右键菜单标注为 1 半音 |
| WEB-06 | 功能 bug | `apps/web/src/features/pianoroll/PianoRollView.tsx:803` | 多选音符向左拖过 0 拍时，每个音符各自贴到 0 拍，和弦/节奏被压扁 |
| WEB-09 | 功能 bug | `apps/web/src/features/transport/TransportBar.tsx:582` | 循环小节输入框用 ↑/↓ 调整后，失焦/回车会用旧草案覆盖，修改被悄悄还原 |
| WS-08 | 数据丢失 | `apps/web/src/lib/session.ts:52` | 自动保存在请求进行中发生的新编辑会被静默丢弃：then 无条件置 saved 并清掉新排的防抖 timer |
| WS-09 | 功能 bug | `apps/web/src/store/store.ts:344` | store 不把 history:false 的编辑标记为 dirty，漏掉的调用方（命令面板静音/独奏、L 键切循环）编辑不会被自动保存 |
| WS-10 | 交互 | `apps/web/src/store/store.ts:872` | 服务端每个 project 事件都压一条撤销历史并弹一次 toast：一次 AI 编排可产生 10+ 个撤销点、占满 80 步栈并连弹提示 |
| WS-12 | 功能 bug | `apps/web/src/store/store.ts:379` | loop 状态有两个来源（store.loopEnabled 与 project.loop.enabled）但 setProject 不同步，打开工程后循环开关与实际状态不符 |
| WS-13 | 性能 | `apps/web/src/store/store.ts:329` | 每次编辑都 structuredClone 整个工程，撤销栈存 80 份完整快照：大工程拖拽掉帧、内存占用可达数百 MB |
| LEAD-09 | 一致性 | `docs/ARCHITECTURE.md:118` | 文档承诺与实现不符：ARCHITECTURE §7 称工程/settings 写入是「先写 .tmp 再 rename 的原子替换」，实际是直接 writeFileSync |
| CONST-01 | 功能 bug | `packages/core/src/constants.ts:304` | keyToPitchClass 不认降号调名，静默回退到 C，降号调工程全部按 C 调生成 |
| GEN-01 | 功能 bug | `packages/core/src/generators/index.ts:953` | 琶音生成器奇数和弦槽沿用上一个和弦的音池，产生非和弦外音 |
| GEN-02 | 功能 bug | `packages/core/src/generators/index.ts:196` | chordSlots / fitChords 的硬编码遍历上限会静默截断和弦，超长工程片段后半段没有音符 |
| MID-02 | 功能 bug | `packages/core/src/midi.ts:169` | MIDI 调号只区分大小调，调式/五声/布鲁斯工程写出错误调号 |
| MODEL-01 | 功能 bug | `packages/core/src/model.ts:80` | zod schema 未把 chord.quality / project.scale 限定为枚举，非法值通过校验后令乐理函数崩溃或生成器静默出空片段 |

### ⚪ 低（29 条）

| ID | 类别 | 位置 | 摘要 |
| --- | --- | --- | --- |
| SRV-18 | 安全 | `apps/server/src/index.ts:88` | 统一错误处理器把内部错误原文（含绝对路径）直接返回给调用方 |
| LEAD-05 | 一致性 | `apps/server/src/index.ts:76` | SERVE_STATIC=1 时任意未知路径都返回 200 index.html（包括 /data/settings.json、/assets/、favicon） |
| SRV-17 | 功能 bug | `apps/server/src/mcp/server.ts:75` | MCP server 的 AIAB_PROJECT_ID 实际被忽略（三元两支相同），会把工具改动写到错误工程 |
| SRV-20 | 性能 | `apps/server/src/routes/export.ts:187` | 音频导出把上传文件和转码结果整块 readFileSync 进内存（上传上限 300MB），峰值内存可达数倍 |
| SRV-16 | 功能 bug | `apps/server/src/routes/generate.ts:41` | /api/generate 的 pickScale 未校验调式名：非法 scale 直接 500 并回显内部 TypeError |
| LEAD-11 | 一致性 | `apps/server/src/routes/generate.ts:88` | /api/generate 的默认 seed 用 Math.random 生成且不回传，结果无法复现，违背「生成器可复现」的设计原则 |
| LEAD-04 | 安全 | `apps/server/src/routes/meta.ts:14` | /api/health 无鉴权泄漏数据目录绝对路径、外部 Agent 可执行文件路径与 ffmpeg 版本 |
| SRV-19 | 一致性 | `apps/server/src/storage/projects.ts:50` | 工程保存把客户端 updatedAt 原样落盘、却返回服务端 savedAt：列表排序会被旧时钟/旧快照带偏 |
| WS-17 | 一致性 | `apps/web/src/App.tsx:194` | 同一「播放」有 3 份实现，App 的空格路径漏传 countIn：打开预备拍后按空格没有倒数 |
| WS-15 | 竞态 | `apps/web/src/audio/engine.ts:871` | engine.play() 无重入/纪元保护：首次 init 期间连点播放/停止会并发播放，stop 之后旧的 play 仍会开播并把 UI 置回「播放中」 |
| WS-16 | 功能 bug | `apps/web/src/audio/synth.ts:758` | 鼓组共用 MetalSynth 的频率是立即写入而非按触发时间写入，同一 look-ahead 窗口内的镲片会互串音高 |
| WEB-14 | 交互 | `apps/web/src/components/ui/index.tsx:192` | Modal 打开后没有焦点陷阱/初始焦点，dialog 也没有可访问名称 |
| WS-20 | 功能 bug | `apps/web/src/features/midi/useMidiPerformance.ts:42` | MIDI Thru 用一次性 previewNote（固定 0.6s）而不是 engine.midiNoteOn/midiNoteOff，长按断音、松键不停音 |
| WEB-11 | 功能 bug | `apps/web/src/features/pianoroll/PianoRollView.tsx:458` | 缩放到较小时短音符整块都是“右边缘”，只能改时值无法拖动 |
| LEAD-08 | 可维护性 | `apps/web/src/hooks/useMidiInput.ts:51` | 死代码与失效 API：hooks/useMidiInput.ts 从未挂载、generate 路由有未使用导入、MIDI 导出两个选项是空操作 |
| WS-19 | 功能 bug | `apps/web/src/lib/api.ts:241` | SSE 解析在 EOF 时丢弃未以空行结尾的最后一个事件（已用真实 stream 分块实测） |
| WS-18 | 一致性 | `apps/web/src/lib/commands.ts:299` | 命令表把「升高半音」快捷键标为 shift+↑，实际钢琴卷帘里 shift+↑ = 移调 12 半音（八度） |
| WEB-12 | 一致性 | `apps/web/src/lib/commands.ts:426` | 命令注册表里登记的快捷键只有部分视图接得住：Q 量化在编曲视图无效，⌘⇧N 添加轨道在钢琴卷帘/智能片段无效 |
| LEAD-07 | 性能 | `apps/web/vite.config.ts:26` | 前端产物是单 chunk 1.58MB（gzip 477KB），无按视图/按需拆分 |
| LEAD-06 | 一致性 | `Dockerfile:22` | 构建工具链版本不确定：Dockerfile 依赖 corepack 的隐式 pnpm 版本，launch.mjs 却写死 pnpm@11.28.5，package.json 无 packageManager 字段 |
| GEN-03 | 功能 bug | `packages/core/src/generators/index.ts:1238` | riff/strum 生成同音高重叠音符，MIDI 导出时前一个 note-off 会切断后一个音 |
| GEN-04 | 功能 bug | `packages/core/src/generators/index.ts:1478` | generateSmartClip 用 try/catch 吞掉所有生成器异常，失败时静默返回空片段 |
| GEN-05 | 功能 bug | `packages/core/src/generators/index.ts:1405` | 扫弦装饰音起点把 hit.off 重复缩放，6/8 拍下落在非网格位置 |
| GEN-06 | 一致性 | `packages/core/src/generators/index.ts:1515` | 鼓 patternOptions 把 basic 标成「某风格基础律动」，实际永远是 pop basic 律动 |
| MID-03 | 功能 bug | `packages/core/src/midi.ts:102` | MIDI 导出的 normalizeStart 选项是空操作（三元两支完全相同） |
| MID-04 | 功能 bug | `packages/core/src/midi.ts:116` | separateTracks=false 没有合并轨道，输出与 true 完全相同（永远是 format 1 每轨一个 MTrk） |
| MID-05 | 功能 bug | `packages/core/src/midi.ts:85` | 多条鼓轨全部导出到通道 10 且不发 program change，不同鼓组音色与音符互串 |
| MODEL-02 | 功能 bug | `packages/core/src/model.ts:357` | projectEndBeat 只取 sections 最后一个元素，段落乱序时工程长度被低估 |
| THR-02 | 功能 bug | `packages/core/src/theory.ts:275` | 和声小调的 vii°7 被构造为半减七（m7b5）而不是减七（dim7） |

> 共 83 条。JSON 原文：`.review/findings-all.json`（合并自 `findings-core/server/webstate/webui/lead.json`）。

---

## 附录 B：审查方法与验证记录

### 分工

| 范围 | Reviewer | 覆盖 |
| --- | --- | --- |
| `packages/core` 全量（6242 行） | core-review | 乐理数值、9 种生成器 × 7 风格 × 6 拍号扫描、7 风格 composeProject、手工解析 MIDI 字节、schema 非法输入 |
| `apps/server/src` 全量（6199 行） | server-review | 临时服务 + mock 攻击者服务实测 CORS/SSRF/Key 外泄/executablePath/RCE 链、存储原子性、Provider 流解析、Agent 取消 |
| `apps/web` store/lib/hooks/audio（6335 行） | webstate-review | 逐行读 + SSE 分块 8 场景实跑、timeline 循环边界实跑、structuredClone 成本 benchmark |
| `apps/web` UI/交互（约 8k 行） | webui-review | ArrangementView/PianoRollView 逐行、指针拖拽坐标、命令面板/走带/弹窗行为 |
| 跨模块 / 安全 / 部署 / 文档 | Lead | 端到端复现 Key 外泄与 DNS rebinding、Host 校验、静态服务边界、音色库下载实测、文档与实现比对、构建与 Dockerfile 审查 |

### 基线（修复前必须保持的全绿状态）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `node scripts/typecheck.mjs` | ✅ 3/3 包通过 |
| 冒烟测试 | `node scripts/test.mjs` | ✅ 12/12 |
| 端到端（真实 Chrome） | `node scripts/e2e.mjs` | ✅ 17/17（含 AI 工具调用、导出、撤销） |
| 生产构建 | `node scripts/build.mjs` | ✅ web 1.58MB + server bundle |

说明：以上结果在**审查进行中（含并发修改后）**各复跑过一次，均保持全绿——即本报告的多数问题都是「测试覆盖不到的语义/安全/边界问题」，也说明修复时应为每条补回归用例（尤其 SRV-01/02/03、WS-01/02/04/08、ARR-01、THR-01、MID-01、WEB-01）。

### 未能覆盖/存疑

- 未在 Docker 容器内实际构建运行（本机 Docker 可用但构建需拉取依赖，耗时且非本次重点）；Dockerfile 相关结论基于静态审查。
- Safari/Firefox 行为、真实音频设备（ASIO/CoreAudio 延迟）、超大型工程（>5 万音符）未做真机验证。
- 并发修改导致部分文件在本报告成稿时可能已变化；修复前请以当前代码复核 `file:line`。
