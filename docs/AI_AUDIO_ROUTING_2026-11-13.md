# Agent 音频路由：忠实渲染 vs AI 重编（2026-11-13）

> 触发问题：用户让 AI Agent 先做 MIDI 编曲，再说「用 AI 音频引擎渲染成高品质音乐」，
> 试了很多次，结果都只是把 MIDI 原封不动转成音频，完全没有 AI 歌曲生成的味道。
>
> 结论：**这不是引擎质量问题，是路由问题。** Agent 选中的 `midi_to_audio` 从来就不跑 AI
> 模型——它是浏览器里的 SoundFont 采样器；而真正能让 AI 参与再创作的 `cover` 只存在于
> 生成面板的手动按钮里，Agent 调不到。本轮把「渲染」和「创作」在工具、提示词、执行链路、
> UI 文案上彻底分开，并新增 Agent 可调用的 `ai_cover`。

---

## 1. 现场取证（用户最新生成记录）

| 时间（本地） | 记录 | 结论 |
|---|---|---|
| 21:22:37 / 21:24:10 / 21:25:12 / 21:26:10 | `generate_audio` 四次全部 `mode=midi_to_audio` | Agent 选的是渲染，不是 AI |
| 21:06:03 | Companion 最后一条任务 = `text_to_audio`（30s） | 这四次之后 **没有任何 AI 任务被创建** → 引擎从未启动 |
| 落轨音频 53.7s | 24 小节 @116 BPM = 49.66s + 离线渲染尾部 4s | 请求的是 50s；AI 引擎会输出 50.0s。53.7 只可能来自本地 `renderProjectToWav` |
| `data/audio-engine/models` | 只有 `base / sft / turbo` | 根本没有 XL 模型文件，但回执/对话里写着「XL 4B + 精修 50 步」 |

代码侧的对应关系：

1. `generate_audio` 对 `midi_to_audio` / `midi_then_audio` 明确 `needsCompanion = false`
   （`apps/server/src/tools/audio.ts`）。
2. 前端 `isRenderMode` 直接进 `runMidiRender` → `engine.renderToWav(project, {...})`
   （`apps/web/src/features/audio/audioIntent.ts`）。
3. `renderToWav` 最终是 `renderProjectToWav`：把工程导出成标准 MIDI，交给 spessasynth
   用 `OfflineAudioContext` 逐轨采样合成（`apps/web/src/audio/render.ts`、`engine.ts`）。
4. `runMidiRender` 只读 `sampleRate / bitDepth / loudnessTargetLufs`，**`plan.engine` 与
   `plan.quality` 连读都没读**。
5. 工具回执对渲染模式也拼了「引擎：XL 4B」（旧 `audio.ts`），模型因此理直气壮地告诉用户
   「已用 AI 引擎」。

所以用户听到的「和 MIDI 一模一样」是物理必然：它就是把 MIDI 逐音变成采样音频。

---

## 2. 语义契约（本轮定稿）

| mode | 跑 AI 模型？ | 输入 | 输出特征 | 适用说法 |
|---|---|---|---|---|
| `text_to_audio` | ✅ | 文本提示词 | 全新一首，不读工程音符 | 「从零生成一首」「按这段描述写歌」 |
| `midi_to_audio` | ❌ | 当前工程 MIDI | **逐音对应**，只有音色/混音 | 「导出 / 转 WAV / 听听现在这样 / 备份音频」 |
| `ai_cover` | ✅ | 当前工程渲染出的 WAV（参考） | **保结构换编制**，会改细节、不保证逐音对齐 | 「用 AI 做成成品 / 换编制 / 重新配器 / 让 AI 发挥」 |
| `audio_with_stems` | ✅ | 文本 | 整曲 + 多条 stem | 「生成并分轨 / 分开乐器」 |

硬约束：

- `midi_to_audio` **不接受** `engine` / `quality`。传了直接返回可操作的错误，并提示改用
  `ai_cover` 或删掉参数——不再静默忽略后再让模型吹牛。
- `ai_cover` 必须给英文 `caption`（目标风格/编制）；不支持 `quality` 精修（cover 固定
  8 步 turbo），要更高质量用 `engine:"xl"`；固定纯器乐（cover 的歌词条件恒为
  `[Instrumental]`），要人声请走 `text_to_audio`。
- `midi_then_audio` 已废弃：语义一直含糊（既像「先编曲再渲染」又像「AI 成品」），
  现统一为「要 AI 成品 → `ai_cover`；只要忠实导出 → `midi_to_audio`」。
- **XL 4B 仅 Windows 现代运行时可用**（macOS / Linux 官方运行时只有 2B）。非 Windows 平台且
  没有在线节点上报 `xl_turbo` 时，工具直接拒绝 `engine:"xl"` 并给出 2b 退路——旧版本正是在
  macOS 上让 Agent 反复承诺「XL 4B + 精修」，实际什么都没发生。

---

## 3. 改动清单

### 服务端

- `apps/server/src/tools/audio.ts`
  - `MODES` 改为 `text_to_audio / midi_to_audio / ai_cover / audio_with_stems`；
    `midi_then_audio` 返回迁移提示。
  - 新增 `coverStrength`（0–1，缺省 0.7）。
  - 渲染模式拒绝 `engine/quality`；`ai_cover` 拒绝 `quality` 与 `instrumental:false`。
  - 回执按模式分写：
    - 渲染：「浏览器采样器逐音渲染，不启动 AI 模型……不要说用了 AI 引擎」；
    - 重编：「先渲染参考音频，再保结构换编制……会改细节，不是逐音渲染」。
  - 渲染/重编的 `durationSec` / `startBeat` 不再写进计划（跟随工程长度、固定 0 拍），避免又一次「50s / 从播放头」误导。
  - 节点能力校验：在线节点上报了 models 但不含 `xl_turbo` 时，回执直接提示「XL 很可能失败」，
    让 Agent 在回复里如实转述，而不是等用户白等一次报错。
- `apps/server/src/agent/prompt.ts`
  - `audio` 意图指令、`TOOL_GUIDE`、`AUDIO_GUIDE`、MCP 指南全部改为四模式，并明确
    「用户抱怨只是 MIDI 转音频时，改用 ai_cover」。
- `apps/server/src/tools/index.ts`
  - 别名：`ai_cover / cover_audio / ai_rearrange / rearrange_audio / remix_audio`
    → `generate_audio(mode:"ai_cover")`；`render_audio` 等仍映射忠实渲染。

### 前端

- `AudioJobMode` / `AudioMode`：加入 `ai_cover`，移除 `midi_then_audio`。
- `parseAudioPlan`：解析并 clamp `coverStrength`。
- `runAudioPlan`：
  - 渲染模式若被外部塞入 `engine/quality`，剥离并 toast「已忽略」，绝不假装生效；
  - `ai_cover`：先把当前工程离线渲染成参考 WAV → 上传资产 →
    `cover_audio`（`audioCoverStrength`）→ 产物固定落 **0 拍** → 新音频轨；
  - 进度按「渲染 0–15% / 模型 15–100%」加权，任务卡不会一开始就跳到 50%；
  - 参考音频源是整工程，占位轨也从 0 拍开始（旧渲染占位轨会跟播放头，已一并修正）；
  - `ai_cover` 若被外部塞入 `quality`，同样剥离并提示（cover 固定 8 步，不假装精修）。
- 生成舞台：`ai_cover` 专属阶段「渲染参考 → 排队 → 载入模型 → 重编 → 封装 → 写入」，
  `MODE_SHORT` 显示「AI 重编」；任务卡/槽位角色新增 `cover`。
- 快捷动作新增「AI 重编成成品」，并把「MIDI → 音频」改写成「忠实渲染（只要导出，不要 AI 重编）」。
- 兜底意图（外部 Agent 没调工具时）：
  - 「用 AI 渲染 / AI 重编 / 换编制 / 重新配器 / 别只是 MIDI 转音频」→ `ai_cover`；
  - 「把当前编曲渲染成音频 / 导出 wav」→ `midi_to_audio`（保持忠实）。

---

## 4. 验证

| 验证 | 结果 |
|---|---|
| `node scripts/test-audio-params.mjs` | 61/61。新增 10 条：渲染拒绝 engine/quality、回执不含「引擎：」、ai_cover 参数/缺省 strength/非法组合、`midi_then_audio` 迁移提示、parse clamp、启发式与意图判定 |
| `AUDIO_VERIFY_SKIP_BUILD=1 node scripts/verify-audio-intent.mjs` | 10/10。新增「ai_cover 无引擎时 blocked 且不偷偷渲染」「mock 节点下全链路：渲染参考 → `cover_audio`（strength/caption/sourceAssetId）→ 落 0 拍新轨」 |
| `AUDIO_AGENT_SKIP_BUILD=1 node scripts/verify-audio-agent.mjs` | 4/4。新增断言：系统提示含 ai_cover + 忠实渲染说明；工具 schema 暴露 ai_cover、不再暴露 midi_then_audio |
| `node scripts/verify-audio-stage.mjs` | 23/23。AI 重编场景（1440 / 1280）阶段轨、遥测、窄宽不溢出；顺带把 auto-resume 的「一键启动节点」也 mock 掉，避免验收进程真的 spawn companion |
| `node scripts/test.mjs` | 57/57 |
| `node scripts/test-ai.mjs` | 31/31 |
| `node scripts/typecheck.mjs` | 通过 |

---

## 5. 边界与后续

- **ACE-Step 不吃 MIDI**：`ai_cover` 的「参考」只能是渲染出来的 WAV，因此是「保结构再创作」
  （实测与源波形相关 ≈0.406），不是逐音还原。UI/文案必须继续分开承诺。
- **参考源是当前混音**：工程里已有的音频片段（含上一次的渲染轨）会被混进参考。
  若出现「重复叠加」，先把旧的渲染轨静音再重编；后续可在 cover 面板加「仅 MIDI / 当前混音」开关。
- **cover 质量档**：当前只有 8 步 turbo；sft cover 尚未开放，XL 又只支持 Windows。
  macOS 上「最高质量」的实际上限就是 2B turbo cover。
- 生成面板的「AI 重编（cover）」按钮与 Agent 的 `ai_cover` 走同一套任务类型，后续可合并
  成同一份执行函数（目前面板走组件内流程，Agent 走 `runCoverFlow`）。
