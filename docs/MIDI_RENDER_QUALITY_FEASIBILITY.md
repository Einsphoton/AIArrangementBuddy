# 从自建 MIDI 轨渲染「高质量音频」· 可行性研究

> 日期：2026-11-13 · 研究问题：「能否根据我先创建的一个 MIDI 轨道，渲染成高质量音频？」
> 方法：代码级审计（Lead + 只读审计员）+ 外部方案调研（含官方页面核对）+ 真实工程渲染实测（headless Chrome 驱动真实应用，工程 `p_rdew9m4a`「我的第一首编曲」）。
> 本文所有结论均可复现；实测原始数据见 `.runtime/research/render-poc-result.json`，详细审计/调研见 `.runtime/research/pipeline-audit.md`、`.runtime/research/options.md`。

---

## 0. 直接回答

**能，而且「忠实渲染」（每个音符都对应真实采样、时间轴可对齐）这条路现在就能走通；但「高质量」要分开看，当前应用离「唱片级」还有明确差距。**

| 你想要的「高质量」 | 现在能不能做到 | 结论 |
|---|---|---|
| **忠实还原**：我写的 MIDI 每个音符/力度/时间都原样变成音频 | ✅ 能（浏览器内 SoundFont 离线渲染，已实测 21.8s 工程 3.0s 出 WAV） | **但当前是「编曲小样级」**：40MB GM 音色库 + 16-bit/44.1k，且导出链路有 3 个明显缺陷（约 −10dB 偏小、混响空间不对、前导静音被吞） |
| **成品感**：听起来像一首做好的歌 | ✅ 有一个可用入口：AI「重编 cover」 | **它不是渲染，是「参考你的音频再创作」**：不保证逐音对齐（实测与源波形相关仅 0.406），不能替代「渲染」 |
| **专业级**：可发行/可交付 | ⚠️ 需外接音源 | 导出 MIDI 到 DAW + 专业音源，或后续做服务端 SFZ/VST3 渲染 |
| **AI 直接吃 MIDI 出高质量音频** | ❌ 截至 2026-11 没有可商用开源模型 | ACE-Step 不吃 MIDI；真正吃音符的只有研究级单乐器模型（DDSP 等，已归档），或非商用模型（MuLaCover） |

**一句话**：**「渲染」用采样引擎（确定、逐音、离线、许可干净）；「成品感」用 AI 再创作（会改细节）。** 现在该做的是把前者从「小样级」修到「专业 demo 级」，并补上「单轨 bounce」入口——这是最短路径。

> **✅ 状态（2026-11-13 晚）**：本文 §5 的 **P0a + P0b 已实现并通过验收**——时间轴错位、CC 双重应用、SF3 混响/合唱、16-bit/44.1k、音频片段缺失、单轨 bounce 都已修复/补齐；实测 48k/24-bit 导出、响度归一 -14 LUFS、对齐与电平均通过。实现与验收记录见 [RENDER_QUALITY_FIX_2026-11-13.md](RENDER_QUALITY_FIX_2026-11-13.md)。下文保留当时的「问题诊断」与「方案比较」，作为决策依据。

---

## 1. 现状：四条「MIDI → 音频」链路（代码级）

| # | 入口 | 渲染范围 | 声源 | 输出 | 落回工程 |
|---|---|---|---|---|---|
| 1 | 工具栏「导出」→ WAV | 整工程（可裁循环区间） | SoundFont 逐轨 + 内置合成器（无音色库/失败回退） | **16-bit PCM / 44.1k / 立体声**（`render.ts:44-83`、`:330`） | 仅下载 |
| 2 | 同对话框 → MP3/FLAC/OGG | 同上 | 先渲染 16-bit WAV，再服务端 ffmpeg 转码 | 同容器，源头仍是 16-bit | 仅下载（本机 `ffmpeg=false`，此路当前不可用） |
| 3 | AI 面板 `midi_to_audio`（聊天「导出/渲染音频」触发） | **整工程** | 同上 | 44.1k / 16-bit | 上传资产 → 新建一条音频轨（可按 ⌘Z 撤销） |
| 4 | AI 面板「AI 重编 cover」 | **整工程混音** | 同上（先渲染 WAV，再喂 ACE-Step） | AI 产物（turbo 8 步） | 新音频轨，不改原 MIDI |
| — | 实时播放 | 整工程（含音频片段） | 同上 + 音频片段 | 设备采样率 float32 | 无（**不可录制**：无 MediaRecorder/MediaStreamDestination） |

**关键事实**：
- **没有「单轨 bounce」入口**：渲染 API（`renderProjectToWav`）只接受整个 `Project`；轨道右键、导出对话框、命令面板都没有「只渲染选中轨」。
- **导出完全不含音频片段**：`render.ts` 全文没有 `audioClips` 引用（实时引擎有，`engine.ts:279/420`）。工程里一旦有 AI 音频/导入音频，导出的 WAV **会静默丢掉它们**。
- 渲染范围/时长由「本工程所有 clip 最远端」决定：`projectDurationSeconds = 末拍/ tempo*60 + 2`（`midi.ts:208-214`），`renderProjectToWav` 再加 `tailSeconds`（默认 2）→ 本工程 32 拍 @108BPM = 17.78s，最终 **21.78s**（4s 尾部）。
- SoundFont 离线渲染：`OfflineAudioContext` + `spessasynth_lib 4.4.3` 的 `startOfflineRender`（`soundfont.ts:570-622`），逐轨单独渲染后重建每轨 EQ/压缩/duck + 母线/母带链。`encodeWav` 是唯一的位深/采样率出口。

---

## 2. 实测：真实工程渲染（7 轨 / 486 音符 / 108 BPM / C 大调）

> 复跑命令：`node .runtime/research/render-poc.mjs`（需能启动 headless Chrome；本会话在 danger-full-access 下跑通）
> 产物：`.runtime/research/audio/*.wav`、`.runtime/research/render-poc-result.json`

| 变体 | 渲染耗时 | 文件 | 时长 | 峰值 | RMS | 备注 |
|---|---|---|---|---|---|---|
| 整工程 @44.1k | **3.0s** | 3.66 MB | 21.778s | **−12.72 dBFS** | −31.45 dBFS | 16-bit/44.1k/2ch，无削顶 |
| 整工程 @48k | 2.7s | 3.99 MB | 21.778s | −11.85 dBFS | −31.36 dBFS | 与 44.1k 峰值差 **0.87dB**（不是简单上采样） |
| 单轨（主旋律）@44.1k | **0.52s** | 3.66 MB | 21.778s | **−25.35 dBFS** | −42.23 dBFS | 调 1 次 SoundFont 渲染；**内容从 0.015s 开始，而该轨 clip 起点是第 8 拍 = 4.444s** |
| 强制合成器 @44.1k | **28.7s** | 3.66 MB | 21.778s | **0.0 dBFS** | −16.34 dBFS | **13 个削顶样本**；比 SoundFont 版峰值高 **12.72dB**、RMS 高 **15.11dB** |
| 单轨短片段（鼓组首 8 拍） | 0.27s | 1.49 MB | **8.444s** | −24.54 dBFS | −48.26 dBFS | 验证「时长由子工程自身 clip 末端决定」 |

**实测结论**：
1. **性能没问题**：7 轨 21.8s 工程 3 秒渲完，单轨 0.5 秒；浏览器离线渲染可交互使用。
2. **现状导出的 WAV 明显偏小声**：峰值仅 −12.7 dBFS、RMS −31.5 dBFS（正常流媒体成品约 −14 LUFS / 近 0 dBFS 峰），且**采样轨比合成器轨系统性小约 10–13dB**——与代码审计的 CC7 双重衰减完全吻合（见 §3.1）。
3. **时间轴错位（比单轨更严重：整工程也中招）**：实测捕获到送入 spessasynth 的 MIDI 第一个音符是 **tick 3840（第 8 拍，4.444s）**，但渲染出的音频在 **0.0s 就出声**。原因是 `soundfont.ts:581` 用默认参数 `new Sequencer(liveSynth)`，而 spessasynth_lib 默认 `skipToFirstNoteOn: true`（`dist/index.js:277-279`）→ **离线渲染会把前导静音跳掉**。

   **这不只影响单轨**：对「主旋律」25 个音符做 Goertzel 定频能量探针（脚本 `.runtime/research/analyze-pitch-agg.mjs`），比较「正确位置 t」vs「提前 8 拍位置 t−4.444s」的平均能量：
   - `full-44k.wav`：正确位置 **−54.7dB** vs 提前位置 **−41.8dB（+12.8dB）**
   - `full-48k.wav`：−54.7 vs −42.0（+12.7dB）
   - `single-track-44k.wav`：−97.9 vs −42.0（+55.9dB）
   - 强制 synth 版相反：正确位置 **−42.2** vs 提前 −47.1（+4.9dB）→ **合成器路径对齐是正确的**

   也就是说，**每个 SoundFont 轨都被各自裁掉前导静音后从 0 开始混**：本工程「主旋律」被提前 4.444s，直接盖到前奏上；凡首音符不在 0 拍的轨道、或做单轨 bounce，都会错位。**这是当前导出「听起来不对」的首要原因之一**，也是 e2e 只测文件大小漏掉的回归。
4. **同一工程换成 `engine='synth'` 后电平完全不同**（峰值 0dB/削顶）——说明「导出≈试听」目前不成立，听感会随音源路线变化。

---

## 3. 质量瓶颈（按影响排序，均有代码/数据证据）

### 3.1 采样轨音量/声像被应用两次（影响最大，约 −10dB）

- 离线：单轨子工程 = 原 track（`render.ts:358`），`projectToMidiBytes` 把 `volume→CC7`、`pan→CC10`、`reverbSend→CC91`、`delaySend→CC93`（`packages/core/src/midi.ts:106-109`），spessasynth 渲染时会按 SoundFont 调制器施加这些 CC；
- 随后 `offlineChain.ts:376-379` 又乘一次 `track.volume` + `StereoPanner(track.pan)`。
- 实时 per-channel 明确把 CC7=127、CC10=64、CC91=0、CC93=0 中性化（`soundfont.ts:507-511`），音量/声像只由节点链负责（`engine.ts:1591-1604`）。
- 量化：volume=0.8 → CC7=80，按 SF2 mainVolume→initialAttenuation 曲线约 **−8.0dB**，再叠 `Tone.Gain(0.8)` **−1.9dB** → 采样轨比实时**小约 10dB**；声像被施加两次（偏得更远），且离线丢失 `StereoWidener`（实时 `engine.ts:1571`）。
- 这解释了实测「SF 版比 synth 版小 12.7dB」——**同一个工程，换引擎/换导出路径就换了一套电平**。

### 3.2 SF3 内建混响/合唱 vs 实时 Tone 混响（空间不一致）

- 离线写 CC91=reverbSend、CC93=delaySend（`midi.ts:108-109`），但 **CC93 在 GM 里是 Chorus 深度**，不是延迟；`startOfflineRender` 未关效果、未传 snapshot（`soundfont.ts:593-597`），SoundFont 轨自带 GS 混响+合唱。
- 实时 per-channel 把 CC91/93 归零，湿声走共享 Tone Reverb/Delay/Chorus（`engine.ts:668-673`）；离线合成器轨也用 Tone 混响（`render.ts:169-180`）。
- 结果：**导出 = 采样轨走 SF3 空间 + 合成器轨走 Tone 空间，两个空间**；且离线 Reverb decay 2.6 / 延迟 0.75 拍，实时 2.8 / 8 分音符（`render.ts:170-178` vs `engine.ts:668-672`）。听感上「糊/干/位置不对」都与此有关。

### 3.3 音源天花板：40MB GM 音色库本身

对 `data/soundfonts/MuseScore_General.sf3` 的解析结果（`spessasynth_core` 直接读文件）：

| 指标 | 实测 |
|---|---|
| 文件/预设/采样 | 39.9MB / **309 presets** / 204 instruments / **1246 samples** |
| 采样率分布 | 44.1k: 768、32k: 203、22.05k: **142**、48k: 62、其余 10.5k–42k 零散 |
| 立体声 | 仅 **2** 个 stereo-linked sample（几乎全单声道；靠 pan/混响做空间） |
| 46 个 GM 预设的力度层 | 钢琴 2 层（MF/FF，144 个采样，键区每 2–3 半音）、其余绝大多数 **1 层** |
| 用户工程用到的音色 | 钢琴：44.1k/2 力度层（相对最好）；木吉他：10 键区/1 力度层；贝斯：**22.05k**（带宽≈11k）；铺底 Pad：**32k**；鼓组：8 键区/60 采样/1 力度层 |

另外 **演奏表情没有进入 MIDI**：`projectToMidiBytes` 只写 program + CC7/10/91/93 + note on/off（`midi.ts:102-122`），**没有 CC1 颤音、CC11 表情、CC64 延音、弯音、keyswitch/技法切换、round-robin、连奏**。工程里的「情绪/演奏法」只对内置合成器有效（`synth.ts`），对 SoundFont 轨完全丢失。**这意味着：即使换更大的 GM 库，弦乐/吉他也不会「像真人」——这是 GM 音源的结构性上限，不是 bug。**

### 3.4 输出规格与母带

- 固定 **16-bit / 44.1k**，无 dither，硬 clamp；UI 没有采样率/位深选项（`render.ts:44-83`、`ExportDialog.tsx:504-508`）。16-bit 理论动态 ~96dB，低电平段有量化噪声；无 true-peak 保护。
- 限幅器是 `DynamicsCompressor`（threshold=−1dB、ratio=20，`offlineChain.ts:336-342`），**不是砖墙/true-peak limiter**；实测 synth 版仍出现 0dBFS 削顶样本。
- 没有响度目标（LUFS）：实测整曲 −31.5 dBFS RMS，离流媒体平台标准差距很大。

### 3.5 其他已确认缺陷

- **前导静音被吞（整工程/单轨都中招，见 §2）**：`Sequencer` 默认 `skipToFirstNoteOn=true`，`startOfflineRender` 又未传 `sequencerOptions`（`soundfont.ts:581/593-597`）→ 每轨从「自己的第一个音符」开始渲染，前导静音被裁掉；多轨工程因此**各轨前移量不同**，节奏错乱。修复：构造 Sequencer 时传 `{ skipToFirstNoteOn: false }`，或在 `startOfflineRender` 传 `sequencerOptions: { skipToFirstNoteOn: false }`；并补「对齐」回归断言（不是只看文件大小）。
- **导出不含音频片段**（§1）：有 AI 音频轨/导入音频的工程，WAV 导出会少东西。
- **落轨位置错位**：`runMidiRender` 从 0 拍渲染整工程，却把音频片段落在 `playhead`（`audioIntent.ts:669/886`）；cover 落轨也用播放头（`GenerateAudioPanel.tsx:239`）→ 播放头≠0 时整体后移。
- **AI 链路只能整工程/已有音频**：cover 输入是整工程混音（`GenerateAudioPanel.tsx:343`），stem 输入必须是音频资产（`companion.ts:331-359`）→「只对一条 MIDI 轨做 AI 精修」必须先有单轨 bounce。**且 cover 的源 WAV 就是同一条 `renderToWav` 链路 → 上面的时间轴错位/电平偏差会一并传给 AI 重编**；修渲染器会同时改善 AI 源质量。

---

## 4. 方案空间（外部调研摘要）

| 路线 | 音质上限 | 逐音保真 | 硬件/离线 | 许可 | 工程量（对本项目） |
|---|---|---|---|---|---|
| **A. 现有浏览器 SoundFont（升级）** | 3/5（GM 决定） | **5/5 精确** | 任意浏览器，完全离线 | 引擎 Apache-2.0；库 MIT/自由 | **P0：1–3 人日** |
| **A+. 换更高质 GM 库**（MS Basic 48.9MB MIT / GeneralUser GS 29.8MB 许可 v2.0 / FluidR3Mono 22.6MB MIT） | 3.3/5 | 5/5 | 同上 | 干净（GeneralUser 部分采样来源作者声明无法 100% 追溯） | 0.5–1 人日/库 |
| **B. 服务端 SFZ 渲染**（VSCO 2 CE CC0 2.2GB、VPO 603MB 混合 CC、Sonatina 1.26GB CC Sampling Plus 1.0、Salamander 钢琴 714MB CC-BY 3.0） | **4.2/5** | **5/5** | CPU 即可，复用 Companion | sfizz BSD-2（上游已归档，需锁版本） | P1：**3–8 人日** |
| **C. AI 重渲染**（现有 ACE-Step cover；lego/extract） | 4/5「成品感」 | **1–2/5，不保证对齐** | GPU（2B ≤6GB；XL ≥12GB 起） | 代码 MIT；权重许可待复核；生成内容版权风险 | 已有；补参数/话术 1–2 人日 |
| **D. 导出 MIDI → DAW/VST 音源** | **5/5** | 5/5 | 用户桌面 | 商业 EULA（可做音乐，不可再分发采样） | 导出/指引 1 人日；用户门槛高 |
| **D+. 服务端 VST3 host** | 5/5 | 5/5 | CPU/GPU；Linux headless 兼容成本 | host GPL-3.0（pedalboard/DawDreamer）或 JUCE AGPL/商业 | 2–6 人周 + 法务 |
| **E. AI「MIDI→音频」开源模型** | — | — | — | — | **不存在**；最近的是研究级单乐器模型（MIDI-DDSP/DDSP-Piano，Apache-2.0，已停更）与非商用 MuLaCover |

**关键外部事实**：
- ACE-Step 1.5 **不吃 MIDI**（输入只有文本/元数据/音频；任务 text2music/cover/repaint/extract/lego/complete/retake/edit）。cover 是「参考音频→语义码→重新生成」，`audio_cover_strength` 只控制结构贴近度，不保证逐音对齐。
- 本项目真实 cover 实测：wall 17–21s（19.2s 产物）、与源波形相关 **0.406**、频宽截止 15756Hz → 确实「重编」，不是「渲染」。
- 现有 stem 是**独立重合成**，不是分离：实测单条 stem 在 500–2000Hz 只有原曲同频段 0.04–0.55 倍、相关性 0.006–0.088，不能加回原曲（`docs/AUDIO_DEFECT_FIX_ROUND2_2026-11-13.md`）。
- 浏览器端没有成熟 SFZ 引擎（sfizz 无 WASM 版且上游已归档）；服务端 `pysfizz` 有 Win/macOS/Linux wheel，是可行路径。

---

## 5. 推荐路线（三档产品化）

> 原则：**「渲染」和「创作」分开命名、分开承诺、分开计费。** 不把 AI cover 包装成「高质量渲染」。

### 档 1：快速渲染（忠实、可编辑、离线）—— 先修正确性，再加规格

**P0a（1–2 人日，收益最大）**
1. 采样轨 CC 中性化：给 `projectToMidiBytes` 加 `mixControls:false`，或在 `render.ts:358` 克隆子工程轨道时置 `volume=1 / pan=0 / reverbSend=0 / delaySend=0`。**直接消除 ~10dB 偏差与双重声像**，让导出≈试听。
2. SoundFont 轨 FX 对齐实时：`startOfflineRender` 关内建效果/传 snapshot，湿声改走与合成器相同的 Tone 共享 send；CC93 不再当 delay 用（它是 chorus）。
3. 修前导静音/时间轴：`new Sequencer(synth, { skipToFirstNoteOn: false })`，并给 `startOfflineRender` 传 `sequencerOptions: { skipToFirstNoteOn: false }`（`soundfont.ts:581/593-597`）；`renderOffline` 返回后按 MIDI 首个音符 tick 校验/补静音；同时补「渲染起点/终点」参数。**验收：`full-44k.wav` 里第 8 拍音符必须在 4.444s±20ms 处出现能量峰（用 `.runtime/research/analyze-pitch-agg.mjs` 复测），SYNTH 版与 SF 版逐音位置一致。**
4. 修落轨错位：渲染起点与落轨 `startBeat` 用同一个值（不要用 playhead 冒充素材起点）。

**P0b（2–4 人日，用户能直接感知）**
5. `RenderOptions` 增加 `trackIds / startBeat / endBeat / durationSec / bitDepth`；`encodeWav` 增加 **24-bit（TPDF dither）/ 32-bit float**；导出对话框加「采样率 44.1k/48k」「位深 16/24」下拉。
6. **单轨 bounce**：轨道右键「渲染此轨为音频」→ 只渲染该轨、按完整工程时长对齐、落到新音频轨（可选静音原轨），一次 mutate 一步撤销；复用 `placeAudioClip`（`audioTrack.ts:184-217`）。
7. **音频分轨导出**：按轨渲染 WAV/ZIP（复用服务端 `createZip`；同时补上「导出包含音频片段」）。
8. 响度：导出前做 −14 LUFS（可配置）响度归一 + true-peak 限幅，替代单纯 compressor limiter。

**验收指标**：导出 vs 实时（对齐后）残差 < −30dB；峰值 ≤ −1dBFS；单轨 bounce 对齐误差 < 5ms；同工程 SF/synth 电平差 < 1dB；24-bit/48k 文件头正确；渲染 4 分钟工程 ≤ 3× 实时。

### 档 2：高保真（服务端 SFZ，CPU 即可）

- Companion 增加 `sfizz/pysfizz` 渲染器：接收「单轨/整工程 MIDI + 乐器→SFZ 映射」，回传 **48k/24-bit** WAV，浏览器作为 AudioClip 落轨。
- 首批库：VSCO 2 CE（CC0，2.2GB）、VPO（603MB，混合 CC，做音乐无限制）、Sonatina（1.26GB，CC Sampling Plus 1.0）、Salamander 钢琴（714MB，CC-BY 3.0）——**许可快照 + 署名页**，VPO 不得再分发/售卖。
- 低端设备可只加载单件乐器（钢琴/弦乐组先做），先做「单轨高质量」最小闭环。
- 验收：同一 MIDI 的浏览器 SF2 版与 Companion SFZ 版 A/B；3 分钟工程 < 1 分钟；断网可用。

### 档 3：AI 再创作（已有，补护栏）

- cover/lego 只定位为「**AI 重新编曲/换编制（参考你的 MIDI 音频）**」，UI 文案明确「不是渲染、会改细节、不保证逐音对齐」。
- 暴露 `audio_cover_strength` 0.6/0.8/1.0 三档 A/B，并**始终保留原 SF2 渲染版**作对照/回退；生成结果作为新音频轨，不自动回填原轨。
- 若要做「单轨 AI 加轨」，先做单轨 bounce，再用 `lego`（base 模型）加轨；不承诺可加回原曲。

### 档 4（视需求）：专业出口

- 导出分轨 MIDI + 音色/CC 映射说明，推荐免费音源（VSCO2/VPO/Sonatina）或商业音源（Kontakt/BBCSO）。
- 服务端 VST3 host（pedalboard/DawDreamer，GPL-3.0）仅在「明确要接商业音源」时立项；现有 `plugin/` JUCE 瘦客户端是「生成入口」，不是渲染引擎。

---

## 6. 风险与合规

| 风险 | 说明 | 对策 |
|---|---|---|
| **采样库许可** | MuseScore_General MIT、MS Basic/FluidR3Mono MIT、GeneralUser GS 许可 v2.0（部分采样来源作者声明无法追溯）、VSCO2 CC0、VPO/Sonatina 混合/CC Sampling Plus、Salamander CC-BY | 随包附许可快照 + 署名页；VPO 不得再分发；不内置来源不明库（ToH/SGM） |
| **AI 生成版权** | ACE-Step 代码 MIT、权重许可需复核；生成音频的商用/署名政策 | 上线前做许可快照；默认「个人创作」并提示风险 |
| **质量承诺** | 把 AI cover 说成「渲染」会立刻失信 | 文案分档：「渲染（忠实）」/「AI 再创作（会改）」 |
| **硬件/体积** | SFZ 库 0.6–2.2GB；XL 4B 显存 ≥12GB；浏览器内存 | 按需下载、按乐器加载、失败降级到 SF2 |
| **兼容性** | spessasynth 参数/内部行为随版本变化（如 `skipToFirstNoteOn` 默认值） | 锁版本 + 回归测试覆盖「前导静音/对齐/电平」 |
| **过度优化** | 当前「难听」有一部分是音源本身，不是混音 | 先 A/B 确认瓶颈，再决定投入 SFZ/VST |

---

## 7. 需要你拍板的事

1. **优先要哪种**：「忠实渲染」还是「AI 成品感」？（建议先做档 1，因为它是所有后续能力的地基）
2. **能否接受安装更大音色库**：20–50MB GM 档（低成本）还是 0.6–2.2GB SFZ 档（高质量）？
3. **单轨 bounce 的交互**：右键「渲染此轨为音频」+ 自动静音原轨，是否接受？
4. **是否要我先落 P0a**（4 个正确性修复 + 验收脚枪），大约 1–2 人日？这是投入产出比最高的一步。

---

## 附录 A · 关键代码引用

- 渲染主入口：`apps/web/src/audio/render.ts:325-423`（时长 `:331-332`、采样轨子工程 `:351-369`、混音 `:372-379`、合成器 `:385-395`、母线 `:397-418`、编码 `:422`）
- WAV 编码：`apps/web/src/audio/render.ts:44-83`（16-bit、无 dither、硬 clamp）
- 采样引擎：`apps/web/src/audio/soundfont.ts:570-622`（`startOfflineRender`；`Sequencer` 默认 `skipToFirstNoteOn` 见 `spessasynth_lib/dist/index.js:277-279`）
- CC 双重应用：`packages/core/src/midi.ts:102-122` + `offlineChain.ts:369-384` vs 实时 `soundfont.ts:507-511`
- 导出/实时链路差异：实时音频片段 `engine.ts:279/420`；离线无 `audioClips`
- 落轨错位：`features/audio/audioIntent.ts:669/886`、`GenerateAudioPanel.tsx:239`
- 单轨落轨可复用：`features/audio/audioTrack.ts:184-217`

## 附录 B · 实测产物与复现

```pwsh
# 前提：应用 API 在 8787、UI 在 5183；Chrome 可启动（DSH 沙箱内不行，需 danger-full-access 或本机终端）
node .runtime/research/render-poc.mjs
# 产物：
#   .runtime/research/audio/{full-44k,full-48k,single-track-44k,synth-44k,single-track-short-44k}.wav
#   .runtime/research/render-poc-result.json   （全部耗时/大小/峰值/RMS/削顶/对齐数据）
```

## 附录 C · 外部资料（已核对）

- spessasynth：<https://github.com/spessasus/spessasynth_lib>（Apache-2.0；SF2/SF3/DLS；OfflineAudioContext）
- ACE-Step 1.5：<https://github.com/ace-step/ACE-Step-1.5>（MIT；text2music/cover/repaint/lego；**无 MIDI 输入**）
- MuseScore 音色库与许可：<https://github.com/musescore/MuseScore/tree/main/share/sound>
- GeneralUser GS：<https://github.com/mrbumpy409/GeneralUser-GS>（License v2.0）
- VSCO 2 CE：<https://github.com/sgossner/VSCO-2-CE>（CC0-1.0）
- VPO：<https://virtualplaying.com/virtual-playing-orchestra/>（混合 CC，做音乐无限制）
- Sonatina：<https://github.com/peastman/sso>（CC Sampling Plus 1.0）
- Salamander Grand Piano：<https://github.com/sfzinstruments/SalamanderGrandPiano>（CC-BY 3.0）
- sfizz/pysfizz：<https://sfz.tools/sfizz/> · <https://pypi.org/project/pysfizz/>（BSD-2；上游仓库已归档，需锁版本）

> 更完整的方案横评/证据等级见 `.runtime/research/options.md`，管线逐行审计见 `.runtime/research/pipeline-audit.md`，实测明细见 `.runtime/research/poc.md`。
