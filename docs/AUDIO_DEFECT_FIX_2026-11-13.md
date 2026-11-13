# J-ROCK 音频缺陷修复报告（2026-11-13）

> 用户反馈（工程 `p_w13cpxfw`，C minor / 178 BPM）：
> 1. 非常难听！几乎听不出来是音乐
> 2. 分轨生成的压根就不是同一首歌的各个乐器
> 3. 轨道的 R、M、S 按钮貌似都不好用
>
> 三个问题**全部确认是真实缺陷**，且根因与用户直觉一致。本文记录根因、修复、以及**客观测量证据**。
> 根因取证细节见 `.verify-audio/ROOT_CAUSE.md`。

---

## 0. 结论速览

| # | 用户感受 | 根因（已实测确认） | 修复后实测 |
|---|---|---|---|
| ① | 难听、不像音乐 | turbo DiT 被喂 `shift=1.0`（预设应为 **3.0**）；调性从未下传，一直按写死的 `C major` 生成（工程是 C minor） | 真实引擎 A/B：shift 3.0 → 峰值 0.996→0.958、质心 1793→1477 Hz、近静音 14.2%→18.6% |
| ② | 分轨不是同一首歌 | 发了引擎 schema 里不存在的 `{"lego": arm}` → `task_type` 回落 `text2music`，**等于按提示词重新生成一首 30s 新歌**；`keys` 不是合法轨道名；seed 每次随机 | 包络相关 **-0.106 → +0.673**，时长 30s（≠源）→ **与整曲完全一致** |
| ③ | R/M/S 不好用 | R 只写 `uiStore.armedTrackId`，而录入路径只读 `focusedTrackId`，两者从不同步；M/S 的 `channel.mute` 被紧随其后的 `volume.rampTo` 在 60ms 内**自己撤销** | 24 项纯逻辑测试锁定语义；已用 Tone.js 源码 + 数值复现证明 |

**额外发现（用户未提但同样严重）**：生成「整曲 + 4 分轨」后，**5 条轨全部默认可闻**，叠加实测峰值 **1.843**（整曲单独 1.000）→ 持续削顶。这也是"难听"的重要来源之一。已改为**分轨落轨时默认静音**。

---

## 1. 缺陷 ①：生成质量

### 根因 A — turbo 的 shift 预设用错
引擎 `/props` 的权威声明：

```json
"presets": {
  "turbo": { "inference_steps": 8,  "guidance_scale": 1.0, "shift": 3.0 },
  "sft":   { "inference_steps": 50, "guidance_scale": 1.0, "shift": 1.0 }
}
```

而 `scripts/companion.mjs` 的 `buildSynthPayload()` 写死 `steps 8 / guidance 1.0 / shift 1.0`；
`applyModelSelection()` 只对 `xl_turbo` 补 shift=3.0 → **默认 2B turbo 一直吃 shift=1.0**。

历史对照印证：仓库里"能听"的样本（`gen-jrpg.log`、`lora-test-17882.log`、`REPORT.md` 试听页）全是 `shift=3.0`。

### 根因 B — 调性从未下传
整条链路都在丢 key：

- `buildSynthPayload()`：`keyscale = params.keyscale ?? 'C major'`
- 前端 `runCompanionFlow()` 调 `createCompanionGenerateTask()` 时**不含 keyscale**（`GenerateAudioParams.keyscale` 字段一直存在但无人填）
- AI 工具 `generate_audio` 的 `AudioPlan` 也没有 key 字段

引擎日志实锤：`执行 generate_audio（快速生成模型，60s / 178 BPM / C major）` —— 用户要 C minor。

### 修复
- 新增唯一真相 `presetForVariant(variant)`（`scripts/companion.mjs`）：turbo/xl_turbo → 8/1.0/**3.0**；sft/base/xl_*_sft/xl_*_base → 50/1.0/1.0（复用既有 `QUALITY_*` 常量，不重复定义）。
- `buildSynthPayload()` 与 `applyModelSelection()` 都改走它；删除原先"只补 xl_turbo"的补丁 → shift 不再有两处写法。`applyModelSelection` 只对 `/synth` 形状生效，不会污染 `/lm` 请求体。
- 调性链路补齐：`generate_audio` 工具新增 `keyscale` 参数 + `normalizeKeyscale()` 归一化；`audioPlan` 带 keyscale/timesignature；前端 `parseAudioPlan()` → `runCompanionFlow()` → `createCompanionGenerateTask()` 全程透传；**模型没给时用工程 `key`/`scale` 兜底**，不再写死 C major。
- 顺带把写死的 `timesignature: '4'` 也改为从工程拍号派生。
- `cover_audio` 也提到 turbo 预设的 shift=3.0 —— 经核对 `music-gen/tools/test_modes.py:87-89` 与 `REPORT.md` 的合格样本，**3.0 才是 cover 的验证配置**，原 1.0 是同一个潜在 bug。

### 实测证据（真实引擎，同 caption/seed/时长，仅改 shift）
| 指标 | shift=1.0（原） | shift=3.0（修复） |
|---|---|---|
| RMS | -14.4 dBFS | -15.5 dBFS |
| 峰值 | **0.996**（贴顶） | **0.958** |
| 频谱质心 | 1793 Hz | 1477 Hz |
| 8–20kHz 占比 | 25.7% | 22.1% |
| 近静音比 | 14.2% | 18.6% |

方向明确：shift 3.0 不再顶满量程、高频不再刺耳、留出动态呼吸。

---

## 2. 缺陷 ②：分轨不是同一首歌

### 根因 A（主因）— 任务类型根本不对
现代运行时的 AceRequest schema 用的是 **`task_type` + `track`**（`/props` 的 `default` 里明确写着 `"task_type":"text2music"`、`"track":""`）。
但 `buildLegoRequest()` 发的是 `{ lego: arm, ... }` —— 一个引擎**不认识的键**，被忽略后 `task_type` 回落默认值 `text2music`：

> 结果不是"分离"，而是**按 caption 重新生成一首 30 秒的新歌**。

同一 60s 源音频的对照测量：

| 请求 | 输出时长 | 与源包络相关 | 引擎行为 |
|---|---|---|---|
| `{"lego":"guitar"}`（原产品） | **30.0s** | **-0.106**（≈无关） | 回落 text2music |
| `{"task_type":"extract","track":"guitar"}` | 60.0s | **+0.609** | `[Synth-Run] task=extract` |
| `{"task_type":"lego","track":"guitar"}` | 60.0s | +0.238 | `[Synth-Run] task=lego`（新生成叠加轨） |

**`lego` 是"在原曲上再生成一条新乐器"，`extract` 才是"从这段音频里分离出该乐器"。** 用户要的是后者。

### 根因 B — 非法轨道名
引擎白名单：`vocals, backing_vocals, drums, bass, guitar, keyboard, percussion, strings, synth, fx, brass, woodwinds`。
产品用 `keys` → 引擎日志 `[Extract] WARNING: 'keys' is not a standard track name`。

### 根因 C — 时长/对齐错位
分轨时长 30s、整曲 60s；工程里 stem `lengthBeats: 89` vs 整曲 `178`（时间轴上肉眼可见错位）。根源仍是上面的 text2music 回退用了 30s 默认值。

### 根因 D — seed 随机
`resolveSeed()` 每条分轨随机 → 每次都是"另一个版本"，加剧"不是同一首歌"。

### 根因 E — caption 描述的是整首歌
`validateStemParams()` 只在 caption 为空时用内置的隔离描述；而前端传的是 `${整曲caption} · ${arm} stem`，于是发给"分离某乐器"模型的提示词是**整支乐队的描述 + 一个 stem 后缀**。已从用户工程 `provenance.prompt` 逐条证实。

### 修复
- `buildExtractRequest()`：`task_type:'extract'` + `track:<引擎名>`，**无 `lego` 键**（`buildLegoRequest` 保留为兼容壳）。
- 新增 `ENGINE_TRACKS` 白名单与 `STEM_ARM_TRACKS` 映射（`keys→keyboard`）；**界面文案不变**，只在引擎边界翻译。
- seed 固定为 `STEM_SEED=777`，同一源音频可复现。
- caption 改为始终以「Isolated xxx stem: …」开头，整曲描述不再注入。
- 落轨时长改用 `peaks.durationSec` 真实测量值驱动，`lengthBeats` 一致派生 → 与整曲同起点、同时长。
- **分轨默认静音**（见 §4）。

### 修复后实测（真实引擎，走修复后的产品函数出请求）
```
整曲 : 30.00s  shift=3  keyscale=C minor
分轨 : 30.00s  task_type=extract  track=guitar
包络相关（分轨 vs 整曲）= +0.673     （修复前 -0.106）
```
分轨时长与整曲**完全一致**，且与整曲的包络显著正相关 —— 不再是"另一首歌"。

---

## 3. 缺陷 ③：R / M / S

### R（录入预备）— 两个独立 bug
1. `TrackRow.tsx` 只写 `uiStore.armedTrackId`；录入路径 `useMidiPerformance.ts` 只读 `store.focusedTrackId`，两者**从未同步** → R 只点亮红点。
2. 录入条件把**全工程**的 `selection.clipId` 当作"聚焦轨的片段"，聚焦 A 轨却选中 B 轨片段时静默失败且无提示。

修复：新增 `lib/trackRules.ts` 的 `resolveRecordTrackId`（预备 > 聚焦 > 选中，跳过失效 id）与 `resolveRecordClipId`（本轨已选片段，否则第一个未静音片段）；`useMidiPerformance`、`TransportBar.RecordButton`、`StatusBar`、`commands.ts` 全部共用同一解析；R 按钮预备时同步焦点；不可录时如实提示（缺录入开关 / 不在钢琴卷帘 / 无可录片段）。

### M / S — 两个叠加 bug
1. **顺序 bug（主因）**：`engine.ts` 里 `node.channel.mute = !audible` 紧跟 `node.channel.volume.rampTo(...)`。Tone 的 `Channel.mute` 只是把 `Volume` 设为 `-Infinity` 的语法糖，而 `rampTo → setRampPoint` 会把 `-Infinity` 换成 `_minOutput=1e-7` 再 ramp 回推子值 → **静音在 60ms 内被自己撤销**。
   已用 Tone.js 源码（`Param.setRampPoint` 的 `_minOutput` 替换）与数值复现确认：旧写法 100ms 后增益 0.5012（= 完全没静音）。
2. **取消静音丢音**：`rebuildNoteIndex(project, audible)` 把不可听轨道的音符从调度表里删掉 → 播放中取消静音要等下一个 look-ahead 窗口才恢复。
3. **send 漏音**：`attachVoice` 把合成器 voice **前置直连** send（混响/延迟/合唱），绕开干声链 → 只关通道静音时，静音轨仍从混响尾巴漏出。

修复：新增独立的 `TrackNode.muteGain`（位于 makeup 之后、send 抽头与 ducking 上游），`applyMix` 用 `muteGain.gain.rampTo(audible ? 1 : 0, 0.02)` 并显式 `channel.mute = false`；send 三路随可听性归零；`rebuildNoteIndex` 不再按轨道可听性过滤；`scheduledPosition` 改为只向前补排（避免每按一次 M/S 触发重音）。可听判定抽成 `computeAudibleTrackIds`，`engine.ts` 与离线导出 `render.ts` 共用 → **播放与导出一致**。
语义保持：**mute 压过 solo、多条 solo 共存**。

### 诚实记录：一处"怀疑但不是 bug"
`audioSignatureOf` 刻意排除 mute 的快速路径**不是** bug —— 它只负责片段增益，通道静音由 `applyMix` 独立完成。未做"修复"。

---

## 4. 额外修复：整曲 + 全部分轨同时可闻 → 削顶

生成的 5 条轨默认全部可闻":

```
叠加后 peak = 1.843   RMS = -11.6 dBFS   削顶样本 12874 (0.22%)
整曲单独   peak = 1.000
```

修复：分轨落轨时在**同一个 `mutate`** 内设 `track.mute = true`（轨道级静音，M 按钮/混音台都读它，且整批只有一个撤销点）；整曲轨保持可闻；toast 明确告知「分轨已默认静音，点 M/S 可单独试听」。
`audioIntent.ts` 与 `SongWorkflow.tsx` 两条入口都已改。

---

## 5. 验证

| 项目 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `node scripts/typecheck.mjs` | ✅ 3/3 包通过 |
| 构建 | `node scripts/build.mjs` | ✅ 通过 |
| 单元 / 冒烟 | `node scripts/test.mjs` | ✅ 36/36（含 24 项静音/独奏/预备纯逻辑） |
| AI 回归 | `node scripts/test-ai.mjs` | ✅ 28/28（含新增场景 26/27/28） |
| 生成参数专项 | `node scripts/test-audio-params.mjs` | ✅ 25/25 |
| 分轨专项 | `node .verify-audio/stem-scenario-verify.mjs` | ✅ 6/6 |
| 真实引擎 A/B（shift） | `.verify-audio/shift_ab.py` | ✅ 四项指标与基线逐位一致 |
| 真实引擎端到端 | `.verify-audio/final_e2e.py` | ✅ 分轨时长=整曲、包络相关 +0.673 |

> 注：沙箱内 `spawn` 带管道 stdio 会被拒（`EPERM`），故上述脚本需在正常环境运行；
> 本次已在放开限制的环境下全部实跑通过。

### 回归保护
- `scripts/test.mjs`：24 项静音/独奏/预备语义 + 7 项**源码级接线不变量**（防止"退回 channel.mute 静音""按可听性删音符""scheduledPosition 回拨""录入只看 focusedTrackId"等回归）。
- `scripts/test-ai.mjs`：场景 26（extract + track 映射 + 固定 seed）、27（turbo shift + keyscale）、28（modern applyModelSelection）。
- `scripts/test-audio-params.mjs`：生成参数链路专项（含真实前端 POST body 捕获）。

---

## 6. 未验证 / 待用户确认

1. **主观听感未经人耳确认**。本环境无法播放音频；上述全部是客观测量（时长、包络相关、频谱、峰值、引擎日志、Tone.js 源码语义）。**"现在是否好听"必须由用户实际试听**。
2. **浏览器交互未在真实浏览器验证**：沙箱内 Chrome 渲染进程无法启动，R/M/S 的点击行为未能加浏览器断言。建议在正常环境补跑 `node scripts/verify-ui.mjs`。
3. **`music-gen/tools/verify_companion.mjs` 的 21 项失败为既有失败**（EngineManager 心跳形状、`applyModelSelection` 的 `output_format`、`lmTierForTask` 的 stem 分支等断言与 HEAD 实现不同步），已逐条用 HEAD 版复现证明与本次改动无关；且 `music-gen/` 被 gitignore，不属产品代码。
4. **未开放新增分轨乐器**：`percussion/fx/brass/woodwinds/backing_vocals` 仅进入引擎白名单用于校验，未做成产品 arm（避免功能扩张）。如需开放是独立小改动。
5. **XL（4B）档未实测**：本次 A/B 与端到端用的是 2B turbo / base。XL 走同一套 `presetForVariant` 逻辑（xl_turbo → shift 3.0 已保留），但未在真机跑 XL。