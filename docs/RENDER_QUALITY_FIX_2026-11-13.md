# MIDI 渲染质量修复（P0）· 2026-11-13

> 对应研究：[MIDI_RENDER_QUALITY_FEASIBILITY.md](MIDI_RENDER_QUALITY_FEASIBILITY.md)
> 目标：让「MIDI → 音频」成为**可信的忠实渲染**（时间轴正确、电平/空间与试听一致、不削顶、可 24-bit/48k 输出、可单轨 bounce），并把音频片段纳入导出。

---

## 1. 修了什么（按影响排序）

### 1.1 SoundFont 离线渲染丢失绝对时间轴（最严重）

- 现象：每个采样轨的离线渲染从「该轨第一个音符」开始，前导静音被裁掉；多轨工程里各轨前移量不同，节奏错乱。实测 `p_rdew9m4a` 的主旋律（第 8 拍起，4.444s）被整体提前 4.444s。
- 根因：`spessasynth_lib` 的离线渲染默认 `SequencerOptions.skipToFirstNoteOn = true`（`dist/index.js:277-279`），而 `soundfont.ts` 调 `startOfflineRender` 时没有传 `sequencerOptions`。
- 修复：`apps/web/src/audio/soundfont.ts` 的 `startOfflineRender` 传 `{ sequencerOptions: { skipToFirstNoteOn: false } }`；同时 render 侧 `tailSeconds=0`，buffer 长度精确等于目标时长。
- 验证：单轨渲染首个非静音样本从 **0.015s → 4.4s**（clip 起点 4.444s，±50ms）。

### 1.2 采样轨音量/声像被应用两次（约 −10dB + 声像偏移）

- 现象：MIDI 里写了 CC7=volume、CC10=pan，spessasynth 渲染时施加一次；渲染回来后又乘 `Tone.Gain(track.volume)` 并再走一次 `StereoPanner(track.pan)`。导出比实时小约 10dB，声像偏得更远，且丢失 `StereoWidener`。
- 修复：`projectToMidiBytes` 新增 `mixControls: 'mix' | 'neutral' | 'omit'`；离线渲染使用 `'neutral'`（CC7=127 / CC10=64 / CC91=0 / CC93=0 / CC74=64 / CC1=0），音量/声像/发送只由节点链负责，与实时 per-channel 路由一致（`soundfont.ts:applyChannelMix`）。
- 验证：整工程 RMS 从 **−31.45 dBFS → −22.25 dBFS**；SF 版与强制 synth 版 RMS 差从 15.1dB → **3.2dB**。

### 1.3 SF3 内建混响/合唱 vs 实时 Tone 空间不一致（含 CC93 语义错误）

- 现象：离线 MIDI 把 `delaySend` 写进 CC93，但 GM 的 CC93 是 **Chorus 深度**，不是延迟；`startOfflineRender` 未关效果 → 采样轨自带 GS 混响+合唱；实时则走 Tone 共享总线。导出 = 两个空间。
- 修复：
  - CC 中性化（上条）不再写 CC91/93，SF 轨干声输出；
  - `offlineChain.ts` 新增 native 共享效果总线：混响（Convolver + 2.6s/0.02s 预延迟 IR）、延迟（0.75 拍/0.3 feedback）、合唱（3.5ms/1.1Hz），每条轨从**链后**按 `reverbAmount/delayAmount/chorusAmount` 发送，与合成器轨同一套参数。
- 验证：导出中主旋律在 4.4s 处能量显著高于提前位置；WAV 有正常混响尾巴（尾部 4s 内无硬切）。

### 1.4 输出规格：24-bit / 48kHz / 响度归一

- 新增 `apps/web/src/audio/wav.ts`：`encodeWavBuffer/encodeWavBlob/estimateWavBytes`，支持 16/24-bit PCM、TPDF dither、可注入 seed；24-bit 3 字节 LE signed。
- 新增 `apps/web/src/audio/loudness.ts`：ITU-R BS.1770-4 积分响度、truePeak（4x 插值）、`normalizeLoudness`（目标 LUFS + lookahead 限峰，不硬削波）。
- `RenderOptions`（`apps/web/src/audio/types.ts`）新增：`bitDepth`、`dither`、`loudnessTargetLufs`、`trackIds`、`durationSec`、`includeAudioClips`。
- 导出对话框（`ExportDialog.tsx`）新增「音频质量」面板：采样率 44.1/48k、位深 16/24、响度归一 -14 LUFS；WAV 与转码源 WAV 都使用新参数。
- 最终峰值保护：母带后若峰值 > −1dBFS，整体缩放（不硬削）→ 任何配置都不削顶。

### 1.5 离线渲染纳入音频片段

- 修复：`render.ts` 现在会收集选中轨的 `audioClips`，通过 `/api/assets/:id/file` 解码，在 `offlineChain.ts` 的 native 离线图里按 `startBeat/offsetSec/durationSec/gainDb/fadeIn/fadeOut` 排期，走同一条轨道处理链/推子/声像（音频片段不参与发送，与实时一致）。
- 循环区间导出（`ExportDialog.buildExportProject`）也同步裁剪/平移音频片段。

### 1.6 单轨 Bounce（bounce in place）

- 新增 `apps/web/src/features/audio/bounceTrack.ts`：轨道右键「渲染为音频（Bounce）」→ 只渲染该轨、整工程时间轴对齐 0 拍、48kHz/24-bit、**不做响度归一**（保持原轨自然电平）→ 上传资产 → 一次 mutate 落一条音频轨 + 静音原轨（单撤销点）。
- `window.AIAB.audio.bounceTrack(trackId)` 暴露给自动化验收。

### 1.7 落轨位置修正

- `midi_to_audio`：渲染整工程（从 0 拍）却按播放头落轨 → 改为 0 拍。
- AI cover：源音频是整工程从 0 拍渲染 → 落轨改为 0 拍（普通生成仍按播放头）。
- `projectDurationSeconds` 现在把 `audioClips` 计入工程时长，避免纯音频工程/尾部音频被截断。

---

## 2. 改动文件

| 文件 | 说明 |
|---|---|
| `apps/web/src/audio/render.ts` | trackIds/位深/音频片段/响度/峰值保护；neutral CC；采样轨 native 混音 |
| `apps/web/src/audio/offlineChain.ts` | 共享混响/延迟/合唱总线；音频片段排期；多轨/发送参数 |
| `apps/web/src/audio/soundfont.ts` | `skipToFirstNoteOn:false` |
| `apps/web/src/audio/types.ts` | RenderOptions 扩展 |
| `apps/web/src/audio/wav.ts`（新） | 16/24-bit WAV 编码 + dither |
| `apps/web/src/audio/loudness.ts`（新） | BS.1770-4 响度 + 归一/限峰 |
| `packages/core/src/midi.ts` | `mixControls`；工程时长含音频片段 |
| `apps/web/src/features/export/ExportDialog.tsx` | 质量选项、循环区间音频片段、体积估算 |
| `apps/web/src/features/audio/bounceTrack.ts`（新） | 单轨 bounce 流程 |
| `apps/web/src/features/tracks/trackMenu.tsx` / `TrackRow.tsx` / `App.tsx` | Bounce 菜单/行内提示/调试句柄 |
| `apps/web/src/features/audio/audioIntent.ts` | MIDI→音频落轨 0 拍 + 48k/24/-14 |
| `apps/web/src/features/audio/GenerateAudioPanel.tsx` | cover 源 48k/24/-14；cover 落轨 0 拍 |
| `scripts/test-render-units.mjs`（新） | WAV/LUFS/MIDI CC 单元测试 |
| `scripts/verify-render-quality.mjs`（新） | 真实浏览器端到端渲染质量验收 |

---

## 3. 验证

### 3.1 单元测试

```pwsh
node --import tsx scripts/test-render-units.mjs
```

覆盖：WAV 头/位深/样本回读/dither 可复现；BS.1770 校准（1kHz 0.1 幅度 → −19.99 LUFS；−23 dBFS 峰值 → −23 LUFS）；静音/NaN 安全；归一 + lookahead 限峰（高 crest / 密集瞬态 / 正弦+脉冲 / 真实工程口径）；`mixControls` 三模式。**26/26 通过**。

### 3.2 真实工程渲染（修复后实测）

| 变体 | 规格 | 时长 | 峰值 | RMS | 削顶 |
|---|---|---|---|---|---|
| 整工程 legacy | 44.1k/16-bit | 21.778s | −1.00 dBFS | −22.26 | 0 |
| 整工程 raw | 48k/24-bit | 21.778s | −2.67 dBFS | −22.25 | 0 |
| 整工程 归一 | 48k/24-bit / −14 LUFS | 21.778s | −1.00 dBFS | −17.24 | 0 |
| 强制 synth | 48k/24-bit | 21.778s | −1.00 dBFS | −17.89 | 0 |
| 单轨主旋律 | 48k/24-bit | 21.778s | −18.27 dBFS | −34.65 | 0；首个非静音 **4.459s**（目标 4.444s） |
| 纯音频片段工程 | 48k/24-bit | 21.778s | −2.28 dBFS | −24.70 | 0 |

### 3.3 端到端验收（真实浏览器 + 临时服务）

```pwsh
pnpm verify:render        # = node scripts/verify-render-quality.mjs（会先 build，再起临时服务 + headless Chrome）
```

**结果：39/39 通过**（2026-11-13 晚）：

- 48k/24-bit 头字段/时长/data 自洽；峰值 −1.00 dBFS，`|x|≥0.999` 样本 **0**。
- 对齐：单轨首个非静音 **4.459s**（4.444s +15ms）；第 8 拍 pitch 64/65/67 的 Goertzel 正确位置 vs 提前 4.444s 平均差 **101.3dB**。
- 电平：SF −22.04 dBFS / synth −18.01 dBFS，差 **4.03dB ≤ 5dB**（修复前 15.1dB），两者均无削顶；SF 版 `renderOffline` 调用 7 次（未静默回退）。
- 16/24-bit：头字段正确、帧数一致、24-bit 数据量 1.500×；BS.1770：raw **−18.86** → 归一 **−14.05 LUFS**（偏差 0.05dB）。
- 单轨 bounce：7→8 轨、新增 audio 轨 1 个 audioClip、`startBeat=0`、原轨 mute、资产已上传可下载。
- 导出对话框：默认 48kHz / 24-bit / 响度归一开启，摘要「48kHz / 24-bit / -14 LUFS · 无损 WAV」。
- 安全：无工程写回、浏览器 console 无异常、用户工程 `data/projects/p_rdew9m4a.json` sha256 前后一致。

---

## 4. 仍有的上限 / 未做

1. **音源本身没换**：仍是 40MB MuseScore_General GM 库（单力度层/近单声道/部分 22–32kHz 采样）。本次是「把渲染做对」，不是「把音源换成专业采样」；后者见研究文档 P1（服务端 SFZ / 更大 GM 库）。
2. **AI cover/lego 仍是「再创作」**：不保证逐音对齐；本次只修正了它的源 WAV 质量与落轨位置。
3. **真峰值是近似（4x 线性插值）+ 样本峰值保护**，不是 oversampled true-peak limiter；对普通编曲足够，母带级交付仍建议 DAW。
4. **音频片段变速固定 1**（与实时一致）：`stretchRatio` 仍未启用。
5. **Bounce 片段含渲染侧默认 2s 尾音**（时长略长于工程末拍），不影响起点对齐。
6. **ffmpeg 未安装时**仍只能导出 WAV/MIDI（本机 `ffmpeg=false`）。
