# 架构说明

本文说明「AI 编曲伴侣」的关键设计决策，方便后续维护与二次开发。

## 1. 总体形状

```
packages/core      纯 TS 音乐引擎（无浏览器/Node 依赖）
   ↑          ↑
apps/web    apps/server
(浏览器)     (Node)
```

- **`packages/core`** 是单一事实来源：数据模型、乐理、生成器、编曲器、乐器目录、MIDI 写出。
  前后端都直接以 TypeScript 源码引用（`workspace:*` + Vite/esbuild 直接编译），省掉一个构建步骤。
- **`apps/web`** 是权威状态所在：Zustand store 持有整个 `Project`，所有编辑立即生效。
- **`apps/server`** 是无状态的「计算 + 代理」层：AI 调用、联网、文件持久化、音频转码、MCP。

## 2. 为什么客户端持有权威状态

DAW 的交互是高频、低延迟的（拖动音符、播放头跟随）。如果状态在服务端，每次拖动都要往返，体验会很差。

因此：

1. 浏览器里 store 是唯一真相，编辑是纯本地操作（同步、可撤销）。
2. 与 AI 对话时，把**整个工程快照**随请求发给后端（JSON，通常几十 KB）。
3. 后端 Agent 在快照上调用工具（不可变更新），每改一次就通过 SSE 把**新的完整快照**推回来。
4. 前端用 `applyAgentProject()` 替换工程，并入撤销栈。

好处：
- 不需要实现 CRDT / OT 或双向同步；
- 「撤销 AI 的全部改动」只需保留一份快照；
- 刷新页面、多个标签页之间不会互相踩踏（各自持有快照，保存时后者覆盖）。

代价：大工程（数千音符）每次对话要传几百 KB —— 实际测试足够快，且 Agent 一次任务通常只发一次。

## 3. 可复现的音乐生成

所有生成器都是**纯函数**：

```ts
generateSmartClip({ kind, style, key, scale, tempo, timeSignature, bars, params, chords, seed })
  → NoteEvent[]
```

同样的输入一定得到同样的音符。这带来三个好处：

- 智能片段参数面板可以「实时重新生成」，而不用记录历史；
- AI 工具、界面预览、导出三者结果一致；
- 「换一个变奏」= 换 seed 的确定性映射（`createVariationSeed`）。

生成器不直接读写工程，只吃 `GenerateContext`，因此可以在服务端（Agent 工具、MCP）与浏览器里复用同一份代码。

## 4. 音乐数据结构

时间统一使用**拍（beat）**，1 拍 = 四分音符：

- `Project.tempo` / `timeSignature` 决定秒与拍、拍与小节的换算；
- `Clip.startBeat` 是绝对拍，`NoteEvent.start` 是相对片段的拍；
- MIDI 导出时统一换算为 tick（PPQ = 480）。

和弦用 `ChordSpec { root: 0..11, quality, beats }` 表示，而不是字符串，避免解析歧义；
用户输入的罗马数字（`bVII7`）由 `theory.parseRoman` 解析成 `ChordSpec`。

## 5. 音频引擎

`AudioEngine` 接口（`apps/web/src/audio/types.ts`）对 UI 屏蔽实现细节，内部有两套发声方案：

| 引擎 | 何时使用 | 实现 |
| --- | --- | --- |
| 合成器 | 默认；未安装音色库 | 按 `SynthPatch` 构建 Tone.js 图；`EmotionParams` 调整滤波/包络/效果/演奏法 |
| 采样器 | 已加载 SF2/SF3 | SpessaSynth 解析 SoundFont，按 GM 程序号与通道发声 |

两条路径共用 master bus（音量、限制器、电平表）与每轨的混响/延迟发送，因此切换引擎听感连续。

**试听（钢琴卷帘点音符 / 乐器面板试听 / MIDI 键盘）= 播放这条轨本身。**
早期实现给试听单独建了一套合成器音色并按轨道 id 缓存，结果换乐器/换情绪后试听仍是旧音色，
而且试听永远走合成器、绕过采样音源与轨道混音 —— 用户会听到「MIDI 弹出来和轨道不一样」。
现在 `auditionNote()` 直接复用轨道当前发声节点：

| 轨道路由 | 试听怎么做 |
| --- | --- |
| 合成器 | 直接对该轨道正在发声的 `InstrumentVoice` 触发（情绪/滤波/效果发送完全一致） |
| 采样音源 | 直接对该轨道的 SoundFont 通道 `noteOn`（GM program 已按轨道设置） |

只有轨道节点还没建立（页面刚打开、引擎尚未 applyProject）时才用同乐器同情绪的兜底音色，
并且兜底音色按「乐器+情绪」签名缓存，音色一变就重建。另外音频初始化完成会立刻同步一次工程，
避免「首帧没有轨道节点」导致的兜底音色。
`engine.debugState()` 可查看每轨实际路由、voiceKey、音色库通道与最近一次试听用的链路，排查声音问题很有用。

乐器「情绪」不是营销词：它把一组归一化参数（brightness/warmth/attack/release/vibrato/drive/
articulation…）映射到具体的合成参数或 MIDI 控制器（CC1 调制、CC11 表情、CC74 亮度），
所以「弦乐 → 紧张」真的会变成高把位、快颤音、弓压更重的听感。

## 6. AI Agent

```
用户输入 ──► Agent 运行时 ──► Provider（OpenAI 兼容 / Anthropic）
                  │                    │
                  │◄──── tool calls ───┘
                  ▼
             工具执行（纯函数，作用于 Project 快照）
                  │
                  ├── 文本增量 ──► SSE text
                  ├── 工具状态 ──► SSE tool_start / tool_end
                  └── 新工程快照 ──► SSE project
```

三种后端：

- **builtin**：自己的多轮 function-calling 循环，最可控，开箱即用；
- **codex**：把任务交给本机 `codex exec --json`，并让 Codex 通过 MCP 调用我们的 DAW 工具。
  Codex 额外具备读文件、跑命令的能力，可以把「参考某个开源项目的和声写法」这类任务真正做完；
- **dsh**：接入 DeepSeek Harness，探测不到就诚实回退。

SSE 事件协议见 `docs/CONTRACTS.md` §5，前端在 `store/types.ts` 里用 `AgentStreamEvent` 联合类型收口，
所以新增事件类型时 TypeScript 会强制前端处理。

## 7. 持久化

```
DATA_DIR/
  settings.json           # AI/搜索/Agent/音频/UI 设置（API Key 明文存储，仅本机）
  projects/<id>.json      # 每个工程一个文件
  soundfonts/*.sf2|sf3    # 音色库
  agent-workspace/        # Codex 等外部 Agent 的工作目录
```

选择文件而不是数据库：单机单用户场景，文件足够快，且可直接备份/版本管理（放进 Dropbox 也能用）。
工程写入是「原子替换」（先写 `.tmp` 再 rename），避免断电损坏。

## 8. 导出

- **MIDI**：`packages/core/src/midi.ts` 零依赖实现 SMF format 1 写入，
  包含 tempo / 拍号 / 调号 / 段落标记 / program change / CC7 / CC10 / CC91 / CC93。
  鼓轨强制到通道 10（索引 9）。
- **WAV**：浏览器端离线渲染（`OfflineAudioContext`），采样级精度。
- **MP3 / FLAC / OGG**：把 WAV 上传到后端，用 ffmpeg 转码（Docker 镜像内置 ffmpeg）。

## 9. 扩展点

| 想加什么 | 改哪里 |
| --- | --- |
| 新乐器 / 新情绪 | `packages/core/src/instruments/catalog.ts` + helpers |
| 新智能片段类型 | `packages/core/src/generators/index.ts` 的 `GENERATORS` 表 + `model.ts` 的 `SMART_KINDS` |
| 新 AI 服务商 | `apps/server/src/providers/` + `core/src/settings.ts` 的预设 |
| 新 Agent 工具 | `apps/server/src/tools/`（同时会被 MCP server 复用） |
| 新的音频后端（如 VST 桥） | 实现 `apps/web/src/audio/types.ts` 的 `AudioEngine` |
