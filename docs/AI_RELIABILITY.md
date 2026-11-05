# AI 生成稳定性与质量保障（AI_RELIABILITY）

> 本文记录「AI 生成大量失败 / 生成质量差」的根因排查、修复方案与回归验证，供后续维护时对照。
> 相关代码：`apps/server/src/agent/`（Agent 循环 + 质量自检）、`apps/server/src/providers/`（服务商适配）、
> `apps/server/src/tools/`（工具层）、`apps/server/src/storage/aiLogs.ts`（运行日志）。
> 回归测试：`scripts/test-ai.mjs`（`pnpm test:ai`）；日志查看：`scripts/ai-logs.mjs`（`pnpm ai:logs`）。

---

## 一、现象

用户反馈：最近一次 AI 生成出现大量失败。真实复现（内置 Agent + DeepSeek 兼容网关，lo-fi 5 轨编曲任务）：

- 21 次工具调用中 2 次失败，失败信息都是 **「没有提供任何需要修改的字段」**；
- 失败发生在模型给轨道设置混响 / 延迟（`update_track` 只传 `reverbSend` / `delaySend`）时；
- 模型于是反复重试同样参数，最终要么耗尽轮数、要么丢失这部分改动，听感上就是「没混响/没空间感」。

除该主因外，代码审计还发现一批会让 AI **静默产出错误结果**（比报错更糟）的问题。

---

## 二、根因

### 1. 工具层：改了数据却报失败（已复现，主因）

`update_track` 对 `reverbSend` / `delaySend` 只写入了轨道对象，却没有记录到 `changes` 列表；
函数末尾用 `changes.length === 0` 判定「没有需要修改的字段」并返回 `ok:false`。
结果：**数据改了、但既不返回新工程快照（前端不刷新），又告诉模型失败**，模型只能反复重试。
> 修复：两个字段计入 `changes`；同时把「无任何可应用字段」的提示改成列出可接受字段。

### 2. 工具层：模型常见写法被静默忽略或解析错

| 模型写法 | 旧行为 | 影响 |
| --- | --- | --- |
| `volume: "0.7"`（数字字符串） | 被忽略，回落默认值 | 音量/参数悄悄不对 |
| `notes[].pitch: "C4"` | 解析为空 | `write_notes` **把片段清空成 0 个音符还报成功**（数据丢失） |
| 和弦 `"Am"`、`quality: "minor"` | quality 不识别 → 默认 `maj` | A 小三变成 A 大三（和声全错） |
| 和弦根音 `"Bb"` / `"Eb"` | 降号不识别 → 落到 C | 和弦根音错误 |
| 调性 `key: "a"`、`"Bb"` | 静默保留旧调性但报成功 | 调性没变，模型以为变了 |
| 段落 `{startBeat, lengthBeats}` | 只认 `startBar/bars`，缺字段补默认 0 | 段落全部堆在第 1 小节 |
| 非法 `instrumentId: "strings"` | 静默回退成三角钢琴 | 想要的弦乐变成钢琴 |
| `generate_smart_clip + replaceClipId` 不带 `startBeat` | 起点被重置为 0 | 重生成片段跑回开头 |
| 重复调用 `arrange_from_melody` | 每次追加一套同名伴奏轨 | 轨道重复、音符叠加 |
| 乐器/情绪/调式/查询类型等枚举拼写不一致 | 静默回退或报「未知」 | 失败或改错 |

### 3. Agent 循环：轮数上限与上下文

- 单轮最多 **12 次**工具调用；5 轨 lo-fi 这种正常任务就会顶满，最后一轮的工具还被跳过并显示为失败卡片。
- 历史消息、工程概览、工具结果没有整体预算：长对话 / 大工程可能把请求撑到上下文上限，网关直接 400。
- 工具参数 JSON 被 `max_tokens` 截断时（`_raw`），旧代码仍会拿去执行 → 必然失败。
- 模型只调工具、不回文字时，最终答复只有一句「已完成本次操作。」，用户看不出做了什么。

### 4. 服务商层：瞬时故障直接失败

网关偶发 429 / 500 / 502 / 503 / 504 / 529 或网络抖动时，整轮 AI 直接以 error 事件结束，已完成的改动与对话全部中断。

### 5. 推理模型把 `max_tokens` 预算花光 → 正文被截断（第二次排查发现）

deepseek-v4.1-flash 等 reasoning 模型会先输出 `reasoning_content`，而 `max_tokens` 限制的是**包含思考在内的总输出**。
用户配置里 `maxTokens=4096`，复杂任务单轮思考就能到 1.3 万字符（≈5k+ token）：

- 真实复现（arrange 任务）：第 4 轮 `reasoningChars≈13777`、`textChars=0`、`finish_reason=length`，
  最终正文只剩 75 字 + 系统「被截断」提示 —— 用户看到的就是「AI 生成不成功」。
- 更隐蔽的影响：工具参数 JSON 写到一半被截断（`args._raw`），工具必然失败，模型再重试。

### 6. 生成质量：AI 会「静默地做坏」工程

工具调用全部成功 ≠ 生成结果质量好。历史工程里已出现：

- **片段时间重叠**（同一轨道上两段 music 同时播放 → 音符叠加、音量翻倍、发糊）；
- 音符超出片段长度（尾部被截断）、完全重复的叠音、AI 留下的空轨道 / 空片段、同配置重复轨道、较多跑调音。

这些不会报错，但听感直接变差；旧版本没有任何自检。

---

## 三、修复

### 工具层（`apps/server/src/tools/`）

- 新增 `validate.ts`：在 `executeTool` 调用 handler 之前统一做 **参数归一化 + 必填/枚举校验**：
  - 数字/布尔字符串、枚举大小写与常见别名、`notes.pitch` 音名（C4 / F#3 / Bb2）、
    和弦根音降号与 quality 别名（`Am`→min、`F#m7`→min7、`Bb`→10）、`chords` 整串（`"Am F C G"`）、
    调性降号（Bb→A#）、段落 `startBeat/lengthBeats`→`startBar/bars`、未知属性丢弃。
  - 校验失败返回 **可操作的中文提示**（哪个参数、期望什么、可用值），且 **绝不半执行**。
- `project.ts`：`update_track` 修复 reverb/delay（主因）；`write_notes` 在「提供了 notes 但解析出 0 个音符」时拒绝执行，
  不再清空片段；非法乐器/情绪硬失败并给出相近建议；`set_key_scale` / `set_chords` / `set_sections` 严格化；
  `generate_smart_clip` 保留 `replaceClipId` 的原起点、同 kind 重叠时复用替换、其他重叠给出警告；
  `analyze_harmony` 增加「轨道内片段重叠」自检建议。
- `arrange.ts`：`arrange_from_melody` append 模式不再重复堆同名伴奏轨、旋律按来源片段起点对齐；`melody_from_chords` 补 `beats`。
- `theory.ts`：`music_theory` 查询别名（`scale_notes`→`scale`、`instruments`→`list_instruments`）与 quality 别名。

### Agent 循环（`apps/server/src/agent/`）

- `MAX_ROUNDS` 12 → 24；最后一轮工具照常执行后收尾，不再产生「未执行该调用」失败卡片。
- 参数 JSON 非法（`_raw`）时拒绝执行并明确提示「参数不是合法 JSON（可能被截断），请拆小重试」。
- 历史消息只发 system + 最近 12 条、单条 ≤6000 字符；系统提示里的工程概览 >4000 字符时压缩（保留前 12 轨 + 「其余略」）。
- `max_tokens` 截断（`truncated`）时提示拆小任务；模型只调工具时生成「已完成 N 项改动：…」总结。
- `prompt.ts` 增加参数硬约束（数字用 JSON number、乐器 id 来源、和弦枚举、段落字段、重生成用 replaceClipId、
  失败不要原样重试、可并行调用互不依赖工具）。
- `prompt.ts` 增加「版权与用途判定」策略块（`CONTENT_POLICY`，内置 / Codex / DSH 三条链路共用同一份系统提示）：
  - 明确本应用是本地私人编曲工具，用户提「最终幻想 / 植松伸夫风格」应理解为风格、情绪、配器参照，
    **直接产出原创编曲**，不要因为出现曲名就整段拒答或先念一遍免责声明；
  - 列出正当用途：风格参照、学习分析（和声 / 曲式 / 配器 / 律动）、用户自备素材（自己扒的 MIDI / 手弹旋律）的编曲、
    个人练习范围内的翻奏 cover 编曲；
  - 只保留两条收窄条件：「逐音逐句精确还原已发行作品并公开发布 / 商用」、「整段输出歌词原文」；
  - 措辞要求：涉及参考作品时用「XX 风格 / 受 XX 启发的原创编曲」表述，不宣称产物是原曲。
  - 已知边界：这是提示词层的软约束，能显著降低误拒，但无法覆盖服务商侧独立的安全分类器；
    若上游硬性拦截，属于服务商策略，改提示词无效。

### 服务商层（`apps/server/src/providers/`）

- 新增 `retry.ts`：429/5xx/网络错误自动重试（最多 2 次，0.8s/1.6s 退避，Retry-After 优先并封顶 10s，Abort 立即生效）；
  **仅在本轮流尚未输出任何文本/推理时重试**，避免 UI 重复内容。OpenAI 兼容与 Anthropic 适配器共用。
- 识别 `finish_reason: "length"` / `stop_reason: "max_tokens"` → `truncated` 标记，交给 Agent 层处理。

### 推理预算自愈（`builtin.ts`）

- 某轮被截断、且**本轮还没有可见正文**（思考把预算吃光）或**工具参数被截断（`_raw`）**时，
  自动把该轮 `max_tokens` 加倍（4096 → 8192 → 16384，上限 32768，最多 2 次）并**重试同一轮**；
  只有自愈耗尽仍截断才向前端发「被截断，建议拆小」提示（避免误报）。
- 每次请求的实际预算与是否发生自愈写入运行日志的 `providerCalls[].maxTokens / escalated`。

### 生成质量自检 + 自动修复（`agent/quality.ts` + `builtin.ts`）

- 新增工程质量体检：片段时间重叠（high）、音符超出片段长度（high）、重复叠音（medium）、空轨道 / 空片段（medium）、
  重复轨道、跑调比例、段落未覆盖全曲、缺和弦（low）。
- 模型认为完成时，如果本次改动**新引入**了 high 级问题，注入一条修复指令让模型用工具修（每次运行最多一次，
  只修新引入的问题、不动用户原有内容），并在对话里显示「质量自检…正在自动修复 / 已自动修复」。
- 自检结果与修复状态写入运行日志的 `quality` / `qualityRepair` 字段。

### 运行日志（`storage/aiLogs.ts` + `routes/ai.ts` + `scripts/ai-logs.mjs`）

- 每次 `/api/ai/chat` 落一条 JSONL 到 `data/logs/ai-runs-<date>.jsonl`（保留 14 天、单文件 8MB 滚动），
  记录：runId / backend / model / intent / outcome、每次工具调用（名字 / 参数摘要 / 耗时 / ok / 失败原因）、
  每轮服务商调用（耗时 / 输出量 / 截断 / maxTokens / escalated）、自动重试、usage、最终工程统计、质量自检。
- 新增 `GET /api/ai/logs?limit=&failed=1&runId=`；新增 `pnpm ai:logs`（`--failed` / `--limit` / `--run` / `--json`）。

> SSE 事件协议（`docs/CONTRACTS.md` §5）与工具返回结构 `{ ok, message, project?, data? }` 保持不变；未引入新依赖。

---

## 四、验证

### 真实模型回归（同一 prompt，修复前后）

| | 工具调用 | 失败 | 结果 |
| --- | --- | --- | --- |
| 第一轮修复前 | 21 | 2（均为 `update_track` 的 reverb/delay 假失败） | 混响/延迟修改丢失 |
| 第一轮修复后 | 19 | **0** | 5 轨、reverb/delay 全部正确写入 |

第二轮（推理截断 / 质量自检）真实模型多流程批量复测（compose / optimize / arrange / melody / 加鼓 / 重生成 /
多轮续写 / 重叠诱导，共 13 次运行）：

- 工具调用失败 **0**、运行级 error **0**；此前 arrange 出现的「正文被截断、只剩 75 字」不再复现（正文 748 字、无截断提示）；
- 重叠诱导场景命中质量自检：自动注入修复后，模型删除冲突片段，最终工程重叠 **0**，日志 `qualityRepair.triggered=true / repaired=true`；
- 每次运行结束的工程质量自检（`quality`）均无 high/medium 问题。

### 自动化验证

| 命令 | 结果 |
| --- | --- |
| `node scripts/typecheck.mjs` | core / server / web 全绿 |
| `node scripts/test.mjs` | 12/12 通过 |
| `node scripts/test-ai.mjs`（mock 服务商 SSE 全链路，16 场景） | 16/16 通过（第二轮修复前基线 11/11，新增日志 / 截断自愈 / 质量自检 / 自愈耗尽场景） |
| `node scripts/e2e.mjs`（真实浏览器 + mock AI） | 18/18 通过 |

`scripts/test-ai.mjs` 覆盖：`update_track` reverb/delay 生效、和弦别名、音名音高不清空片段、数字字符串、
非法乐器提示+重试、段落别名换算、`replaceClipId` 保留起点、429/500 自动重试、24 轮上限收尾、
完整 compose 流程、`finish_reason=length` 截断提示、**运行日志落盘与查询、推理截断自动加倍 max_tokens、
质量自检发现重叠自动修复、自愈耗尽才提示、系统提示的版权误拒消解策略锚点**。

---

## 五、行为变化（升级注意）

- 非法 `instrumentId` / `emotionId` / `key` / `scale` / 和弦 quality **不再静默回退**，而是返回 `ok:false` + 可用值提示；
  模型会据此在下一轮修正（这是质量保障的一部分）。情绪词现在会先做相近匹配（如 `swing`→`brush`）并明确说明，只有完全无解才失败。
- `write_notes` 的 `replace` 不再允许「传了 notes 但全部解析失败」清空片段；确需清空请显式传空数组或使用 `delete` 模式。
- 单轮工具轮数上限 **32**；模型输出被 `max_tokens` 截断时会提示拆小任务。
- 推理模型截断时服务端会自动临时提高 `max_tokens` 重试（不改你的设置，只影响该轮请求）。
- 每次 AI 生成会在 `data/logs/` 留日志（14 天自动清理，含回复/思考片段预览）；生成结束会做工程质量自检，并对**本次新引入的**
  高优先级问题自动修复一次（对话里会出现「质量自检」提示）。
- SSE 新增 `ui` 事件（AI 请求前端播放/跳转/切视图等），旧前端会忽略，向后兼容。
- **升级后需重启应用**（`pnpm start` / Docker 重启）才会用上新的服务端逻辑。

---

## 六、能力扩充：让 AI 想做的大多数操作真的能执行（第三轮）

### 现象与证据

用户观察 Agent 思考过程后反馈：AI 经常「想做某个操作」但应用没有对应工具，只能绕路或失败。
抓取真实运行日志（`data/logs/ai-runs-2026-11-05.jsonl`）验证：

- 一次复杂编曲任务 51 次工具调用里 **45 次是 `generate_smart_clip`**、22 次 `update_clip` 改名——
  因为缺少「复制/重复/量化/移调」工具，AI 只能把同一段音乐反复重新生成，既慢又难保证一致性；
- `set_instrument` 传 `emotionId:"swing"` 失败（爵士鼓只有 brush/ride/bop/soft）——一个词不匹配就让整步失败；
- 长任务达到轮数上限（24）后被迫停下。

### 修复

**新增 16 个工具（工具总数 21 → 37）**，定义在 `apps/server/src/tools/edit.ts` / `ui.ts`：

| 分类 | 工具 |
| --- | --- |
| 片段/段落复用 | `copy_clip`（复制/重复/移调/跨轨）、`repeat_section`（整段复制） |
| 剪辑 | `split_clip`、`merge_clips`、`transpose_clip`、`transpose_project` |
| 节奏/力度 | `quantize_clip`、`humanize_clip`、`scale_lock_clip`、`velocity_curve` |
| 轨道 | `duplicate_track`、`clear_track` |
| 工程设置 | `set_swing`、`set_time_signature`、`set_loop` |
| 界面驱动 | `ui_action`（播放/停止/跳转/切视图/选中片段/打开导出/撤销/重做/循环/节拍器）→ 新 SSE `ui` 事件 |

**另外三处「不限制 AI」的改动：**

1. **工具名别名**（`tools/index.ts`）：模型自创的工具名自动映射到真实工具，如
   `add_drum_groove`→`generate_smart_clip{kind:'drums'}`、`add_bass_line`、`rename_track`、`duplicate_clip`、`transpose_notes`……
   执行结果里注明「（已将 X 按 Y 执行）」，模型和用户都能看到发生了什么。
2. **情绪词兜底**（`tools/validate.ts`）：精确 id/中文名/英文名 → 中英同义词 → 包含/编辑距离匹配；
   命中相近情绪就使用并明确提示「情绪「swing」不精确，已使用「brush」」，完全无解才报错。
3. **放宽 Agent**：`MAX_ROUNDS` 24→32；提示词改为鼓励「已有片段优先复用（copy_clip/repeat_section）」「编辑类工具优先」
   「想操作界面用 ui_action」「小范围修改允许 write_notes」「失败按 message 修正、不要原样重试」；
   Agent 在 `tool_start` 前用 `resolveToolAlias` 展示真实工具名（前端卡片图标/标题正确）。

### 验证（真实模型）

6 个针对新能力的真实生成任务（复制+移调 / 量化+swing+降八度 / 界面动作 / 整体移调+循环 / 拆分+删除+合并 / 爵士鼓 swing 情绪）：

| 场景 | 实际使用的工具 | 结果 |
| --- | --- | --- |
| 复制片段到第 7 小节 ×2 并升 2 个半音 | split_clip / copy_clip / update_clip | 0 失败，44s |
| 量化 1/16 + swing 0.3 + 降八度 | quantize_clip / set_swing / update_track | 0 失败，13s |
| 播放 → 切混音器 → 打开导出 | ui_action ×3 | 0 失败，**SSE 收到 3 个 `ui` 事件**，6s |
| 整曲升 2 个半调 + 循环区间 2–10 小节 | transpose_project / set_loop / ui_action | 0 失败，9s |
| 片段第 12 拍拆分、删后半、合并剩余 | split_clip / delete_clip / merge_clips | 0 失败，53s |
| 爵士鼓 + swing 情绪 | set_instrument（自动落到 brush）等 8 个工具 | 0 失败，26s |

全部 6 次运行：工具失败 **0**、运行级 error **0**、终态工程质量自检 high/medium **0**；
对比此前同类任务「45 次重新生成 / 160–200s」，新工具让 AI 用少量编辑操作快速完成（5–53s）。

浏览器级（`ui_action` 端到端）另由脚本验证 17/17：播放真的开始发声、播放中 seek 立即生效、
视图切换 / 导出与设置对话框 / 循环 / 节拍器 / 选中片段全部作用于真实界面，非法参数不打断对话。

### 回归测试

`scripts/test-ai.mjs` 扩展到 **24 个场景**（原 16 + 新 8）：copy_clip、repeat_section、quantize+humanize（含 seed 可复现）、
set_swing/time_signature/loop/transpose_project、split→merge、工具别名、情绪兜底、`ui` 事件；
场景 9 按 `MAX_ROUNDS=32` 更新（mock 准备 40 轮 → 恰好执行 32 轮且无失败卡片）。
`node scripts/test-ai.mjs` **24/24 全绿**，`node scripts/test.mjs` 12/12，`node scripts/e2e.mjs` 18/18。
