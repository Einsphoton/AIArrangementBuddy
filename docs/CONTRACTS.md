# 开发契约（CONTRACTS）

> 所有并行开发的同学请先读完本文件。它定义了模块边界、API 形状与代码规范。
> **一旦本文件与代码冲突，以本文件为准；如需变更接口，先通知 Lead。**

## 1. 技术栈与命令

| 目标 | 命令 |
| --- | --- |
| 安装依赖（仅 Lead 执行） | `pnpm install` |
| 开发（后端 8787 + 前端 5183） | `pnpm dev` |
| 类型检查（单包） | `pnpm --filter @aiab/<pkg> typecheck` |
| 构建 | `pnpm build` |
| 生产启动 | `pnpm start` |

- **禁止**执行 `pnpm install` / `pnpm add`（会与其他人冲突）。需要新依赖请告诉 Lead。
- **禁止**使用 `git`（本机 git 因 Xcode 许可不可用）。
- 文件改动只允许落在自己负责的目录内。
- 每完成一块就运行 `pnpm --filter <你的包> typecheck`，保持 0 错误。

## 2. 目录与归属

```
packages/core/                  共享音乐引擎（前后端共用，纯 TS，无浏览器依赖）
  src/model.ts            [Lead] 数据模型 + zod schema
  src/constants.ts        [Lead] 音名/音阶/和弦/风格/GM 鼓映射
  src/settings.ts         [Lead] 设置结构（AI/搜索/Agent/音频/UI）
  src/theory.ts           [core-engine] 乐理工具
  src/generators/index.ts [core-engine] 智能片段生成器
  src/arrange.ts          [core-engine] 编曲器（旋律→编曲、和弦→旋律）
  src/instruments/*       [core-engine] 乐器目录 + 情绪预设
  src/midi.ts             [Lead] MIDI 导出

apps/server/              后端（Fastify + AI Agent）       [server-api]
  src/index.ts            服务入口 + 路由注册
  src/routes/*.ts         各路由
  src/agent/*.ts          Agent 运行时（builtin / codex / dsh）
  src/tools/*.ts          Agent 工具（改工程、搜索、乐理）
  src/providers/*.ts      AI 服务商适配（OpenAI 兼容 / Anthropic）
  src/mcp/*.ts            MCP server（把 DAW 工具暴露给 Codex / DSH）
  src/storage/*.ts        工程与设置持久化

apps/web/src/
  store/*                 [Lead] zustand 状态（已实现，直接使用）
  audio/*                 [web-audio] 音频引擎（接口见 audio/types.ts，已冻结）
  lib/api.ts              [Lead] HTTP 客户端（已实现）
  lib/session.ts          [web-audio? 否] 归 shell
  lib/format.ts           [Lead] 工具函数
  components/ui/index.tsx [Lead] UI 原子组件（Button/Modal/Select/Slider/...）
  components/ToastHost.tsx[Lead]
  features/transport/*    [web-editor] 走带控制条
  features/tracks/*       [web-editor] 轨道列表 + 混音器
  features/arrangement/*  [web-editor] 编曲时间轴
  features/pianoroll/*    [web-editor] 钢琴卷帘
  features/smartclips/*   [web-editor] 智能片段面板
  features/chat/*         [web-shell] AI 对话面板
  features/settings/*     [web-shell] 设置页
  features/export/*       [web-shell] 导出对话框
  features/topbar/*       [web-shell] 顶部栏 + 文件菜单
  features/onboarding/*   [web-shell] 首次引导
  features/status/*       [Lead]
  features/help/*         [Lead]
  App.tsx                 [Lead] 布局骨架（已固定，勿改结构；需要挂载点请找 Lead）
```

## 3. 数据模型（`@aiab/core`）

时间统一用**拍（beat）**；`Track.clips[].startBeat` 是绝对拍，`NoteEvent.start` 是相对片段的拍。

```ts
Project { id, name, tempo, timeSignature{numerator,denominator}, key, scale, swing,
          masterVolume, tracks: Track[], sections: Section[], chords: ChordSpec[],
          loop{enabled,startBeat,endBeat}, createdAt, updatedAt }

Track   { id, name, color, kind:'instrument'|'drum', instrumentId, emotionId, gmProgram,
          engine:'auto'|'synth'|'soundfont', volume(0..1.5), pan(-1..1), mute, solo,
          reverbSend, delaySend, octaveShift, clips: Clip[] }

Clip    { id, trackId, name, startBeat, lengthBeats, notes: NoteEvent[], muted,
          smart?: { kind, style, seed, params: SmartParams, key?, scale?, progression? } }

NoteEvent { id, pitch(0..127), start(相对片段), duration, velocity(1..127) }

ChordSpec { root(0..11), quality: ChordQualityId, beats }
```

工厂函数（务必使用，保证 id 与默认值一致）：`createNote / createClip / createTrack /
createSection / createChord / createEmptyProject / newId / deepClone / beatsPerBar`。

## 4. HTTP API（后端必须实现，前端已按此调用）

所有响应 JSON；错误返回 `{ error: string }` 且状态码 4xx/5xx。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | `{ ok, version, node, uptimeSec, dataDir, soundfonts[], ffmpeg, agents[] }` |
| GET | `/api/projects` | `ProjectSummary[]` = `{id,name,updatedAt,createdAt,trackCount,tempo}` |
| GET | `/api/projects/:id` | `Project` |
| PUT | `/api/projects/:id` | body: `Project`，返回 `{ ok:true, savedAt }` |
| DELETE | `/api/projects/:id` | `{ ok:true }` |
| GET | `/api/settings` | `AppSettings`（API Key 返回脱敏值，见下） |
| PUT | `/api/settings` | body: `AppSettings`，返回 `{ ok:true }` |
| POST | `/api/settings/test-provider` | body `{ providerId, settings }` → `{ ok, message, latencyMs, models? }` |
| POST | `/api/settings/models` | body `{ settings }` → `{ models: string[] }` |
| POST | `/api/ai/chat` | 见 §5，SSE 流 |
| POST | `/api/ai/cancel` | 中止当前 run |
| GET | `/api/ai/logs` | 最近 AI 运行日志 `{ ok, count, files[], logs[] }`；query：`limit`(1..500) / `failed=1` / `runId`。每次 run 同时落盘 `data/logs/ai-runs-<date>.jsonl`（见 docs/AI_RELIABILITY.md） |
| POST | `/api/generate` | body `{ intent:'compose'\|'arrange'\|'melody'\|'chords'\|'variation', project, options }` → `{ project, summary }` |
| POST | `/api/export/midi` | body `{ project }` → `audio/midi` 二进制 |
| POST | `/api/export/audio` | multipart：`file`(wav) + `format`(mp3/flac/ogg) → 音频二进制；无 ffmpeg 时 501 |
| GET | `/api/soundfonts` | `{ files: {name,url,size,license?}[], bundled }` |
| POST | `/api/soundfonts/:id/download` | `{ ok, message, url? }` |
| GET | `/api/agents` | `{ backend, available, version?, path? }[]` |
| GET | `/soundfonts/*` | 静态音色库文件 |

静态托管：当 `SERVE_STATIC=1` 时托管 `apps/web/dist`（生产模式）。

## 5. AI 对话协议（SSE）

请求 `POST /api/ai/chat`：

```ts
{
  messages: { role:'user'|'assistant'|'system', content: string }[],
  project: Project,            // 客户端权威快照；服务端在此快照上执行工具
  intent?: 'compose'|'arrange'|'melody'|'chords'|'optimize',
  attachments?: { melodyTrackId?: string; referenceClipId?: string }
}
```

响应 `Content-Type: text/event-stream`，每条消息格式：

```
event: <type>
data: <json>

```

事件类型（与 `apps/web/src/store/types.ts` 的 `AgentStreamEvent` 完全一致）：

| event | data |
| --- | --- |
| `start` | `{ runId, backend, model? }` |
| `text` | `{ delta: string }` |
| `reasoning` | `{ delta: string }` |
| `tool_start` | `{ id, name, args, title? }` |
| `tool_end` | `{ id, ok, result?, error? }` |
| `project` | `{ project: Project, label: string }` |
| `ui` | `{ action, beat?, view?, clipId? }` — AI 通过 `ui_action` 工具请求前端执行界面动作（play/stop/seek/set_view/select_clip/open_export/open_settings/undo/redo/toggle_loop/toggle_metronome），前端忽略未知 action，旧前端忽略未知事件 |
| `done` | `{ runId, usage?, elapsedMs? }` |
| `error` | `{ message: string }` |

**关键约定**：工具修改工程后，必须立即下发一次 `project` 事件（完整工程快照），
前端据此实时刷新界面。前端以最后一次 `project` 事件为准，可一键撤销。

## 6. Agent 工具（服务端）

工具名 → 用途（参数用 JSON Schema 描述，返回对象必须可 JSON 序列化）：

| 工具 | 说明 |
| --- | --- |
| `get_project_summary` | 工程概览（轨道、乐器、片段、和弦、段落） |
| `analyze_harmony` | 分析调性/和弦/节奏密度，给出建议 |
| `create_track` / `update_track` / `delete_track` | 轨道增删改（乐器、情绪、音量、声像、静音） |
| `set_instrument` | 换乐器 + 情绪预设 |
| `create_clip` / `update_clip` / `delete_clip` | 片段增删改 |
| `write_notes` | 写入音符（replace / add / update / delete） |
| `generate_smart_clip` | 用内置生成器产出节奏/旋律/和弦/琶音/动机等片段（可指定 name / replaceClipId） |
| `arrange_from_melody` | **需求 8a**：根据旋律自动编曲（生成和弦 + 整套伴奏） |
| `melody_from_chords` | **需求 8b**：根据和弦填写旋律 |
| `set_tempo` / `set_key_scale` / `set_chords` / `set_sections` / `set_master_volume` | 工程级设置 |
| **编辑类** `copy_clip` / `repeat_section` | 复制片段（可重复/移调/跨轨）与整段重复，AI 复用已有编配而不是反复重新生成 |
| `split_clip` / `merge_clips` | 在指定拍拆片段、合并同轨相邻片段 |
| `transpose_clip` / `transpose_project` | 片段 / 整曲移调（后者可同步调性标记与和弦根音） |
| `quantize_clip` | 量化（grid + strength + swing） |
| `humanize_clip` | 时值/力度人性化（seed 可复现） |
| `scale_lock_clip` | 把音符吸附到调内音阶 |
| `velocity_curve` | 力度曲线（accent / crescendo / decrescendo / flat） |
| `duplicate_track` / `clear_track` | 复制 / 清空轨道 |
| `set_swing` / `set_time_signature` / `set_loop` | 工程摇摆、拍号、循环区间 |
| `ui_action` | 请求前端执行界面动作（播放/停止/跳转/切视图/选中片段/打开导出/撤销/重做/循环/节拍器），以 SSE `ui` 事件下发，不修改工程 |
| `music_theory` | 查询音阶/和弦/进行/转位（不修改工程） |
| `web_search` | 联网搜索（按设置里的 provider，缺省 DuckDuckGo） |
| `fetch_url` | 抓取网页正文（截断到 ~8k 字符） |

工具名别名：模型偶尔会「自创」工具名（如 `add_drum_groove`、`add_bass_line`、`rename_track`），
`executeTool` 会按别名表映射到真实工具并补默认参数，返回 message 里注明「（已将 X 按 Y 执行）」。

工具返回值统一：`{ ok: boolean, message: string, project?: Project, data?: unknown }`（`ui_action` 的 data 为 `{ uiAction }`）。

## 7. 音频引擎契约（已冻结）

`apps/web/src/audio/types.ts` 中的 `AudioEngine` / `MidiInput` / `SoundfontManager` 接口不可更改签名。
`apps/web/src/audio/index.ts` 必须导出 `getAudioEngine(): AudioEngine` 以及 `encodeWav`。

UI 侧只调用 `getAudioEngine()`，不直接引用 `engine.ts` 内部实现。

## 8. 前端状态（`apps/web/src/store/store.ts`，已实现）

常用 action：`mutate(fn,{history})`、`pushHistory()`、`undo/redo`、`addTrack`、`updateTrack`、
`setTrackInstrument`、`addClip`、`updateClip`、`addNotes/updateNotes/removeNotes`、`replaceClipNotes`、
`quantizeClip`、`transposeNotes`、`regenerateSmartClip`、`createSmartClip`、`updateSmartParams`、
`setTempo/setKeyScale/setChords/setSections`、`selectTrack/selectClip/setSelectedNotes`、
`setView/setSnap/setZoom`、`setPlaying/setPlayhead`、`applyAgentProject`、`undoAiChanges`、
`pushToast`、`addMessage/appendToMessage/patchMessage/addToolCall/finishToolCall`。

选择器：`useSelectedTrack()`、`useFocusedTrack()`、`useSelectedClip()`、`useProjectEndBar()`、`useBarBeats()`。

**拖拽类高频操作**：手势开始时 `pushHistory()` 一次，后续更新用 `{ history: false }`。

## 9. 设计系统

- 深色录音棚风格；颜色只能用 `src/styles/index.css` 中 `@theme` 定义的语义色：
  `bg / bg-soft / surface / surface-2 / surface-3 / surface-4 / line / line-strong /
   ink / ink-2 / ink-3 / ink-4 / accent(琥珀金) / violet / cyan / pink / danger / success`
  （Tailwind 中写作 `bg-surface-2`、`text-ink-2`、`border-line` 等）。
- 组件类：`.panel` `.btn` `.btn-accent` `.btn-ghost` `.btn-icon` `.field` `.chip` `.label` `.divider` `.mono` `.glass`
- 圆角：面板 14px，控件 9px，徽标 6px。字号：正文 12–12.5px，标题 13–15px，标签 10.5px。
- 图标统一用 `lucide-react`。
- 文案：**简体中文**，专业但不啰嗦；数值用 tabular-nums。
- 所有可交互元素要有 `title` 或 `aria-label`。

## 9.1 调试句柄

浏览器控制台里可以直接用 `window.AIAB`：

```js
AIAB.useStore.getState()        // 当前工程 / UI 状态
AIAB.engine.debugState()        // 音频上下文、每轨路由与 voiceKey、最近一次试听的音色
AIAB.engine.getTrackLevels()    // 逐轨实时电平
```

## 10. 完成标准（每个人交付前自检）

1. `pnpm --filter <包名> typecheck` 0 错误；
2. 不再有 `TODO`/占位文案（你负责的目录内）；
3. 导入的 API 与本文档一致；
4. 空状态、加载态、错误态都有处理；
5. 在自己的任务卡里写清楚「做了什么 + 怎么验证」。
