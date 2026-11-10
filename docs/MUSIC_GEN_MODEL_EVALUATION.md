# 音乐生成模型选型评估（面向 ArrangementBuddy Studio）

> 评估日期：2026-11-08
> 评估人：技术选型调研（基于本机实测 + 官方仓库/许可证核验）
> 关联文档：`docs/AI_MUSIC_ROADMAP.md`（符号域总纲）、`docs/FUSION_ROADMAP.md`（三线融合）、`docs/ARCHITECTURE.md`（现有栈）

---

## 0. 一句话结论

**音频域选 ACE-Step 1.5**（代码 MIT + 权重 MIT，Win/macOS/Linux 官方支持，支持分轨/局部重绘/LoRA，且有 C++/GGML 可嵌入实现）。
**不要选 YuE2**：权重是 **CC BY-NC 4.0**，公司商用必须单独签约，而且 macOS 官方未验收、无分轨、无 LoRA、无 MIDI。
但更重要的判断是——**你列的 8 条需求不是"一个模型"能覆盖的**，其中 (b) 和声进行/节奏型、(e) 和弦标注、(f) 转 MIDI 本质上属于**符号域/分析域**，应该由你已有的 `packages/core` 生成器 + 4 个宽松许可的小模型完成；ACE-Step 只负责"音色、成品感、局部重绘、风格化"这一层。

整体是**双域架构**，不是"选一个大模型"。

---

## 1. 先分清两个域（本评估的核心判断）

| 维度 | 符号域（MIDI/音符） | 音频域（波形） |
|---|---|---|
| 你现有资产 | ✅ `packages/core` 纯函数生成器、`NoteEvent`、MIDI 写出、风格画像、RAG 规划 | ❌ 只有浏览器内 Tone.js + 音源渲染 |
| 可编辑性 | 精确到音符，可无限改 | 只能整段替换/局部重绘 |
| 用户需求 (b)(e)(f) | ✅ 天然满足 | ❌ 需要额外转录，且有损 |
| 灵感/风格贴合 | 依赖 profile/检索/判别器，提升慢但可控 | 一次生成即"像成品"，但不可解释 |
| 学习特定风格 | MIDI LoRA（你规划的 L3） | 音频 LoRA（ACE-Step 官方支持） |
| 延迟/成本 | 毫秒级，CPU | 秒级，需 GPU |
| 版权风险 | 语料版权（你做得很谨慎） | 生成内容相似度 + 风格模仿 |

**结论**：ArrangementBuddy 的底座是符号域，这是优势不是包袱。音频模型的价值是给符号产物**"从 demo 到成品"**，以及在**没有 MIDI 素材时**快速给灵感。把音频模型当主路径会重演 `AI_MUSIC_ROADMAP §6` 里写的"训练三个月不如规则生成器"。

---

## 2. 候选横评（许可证是一票否决项）

| 模型 | 代码许可 | **权重许可（能否随安装包分发）** | Win | macOS ARM | 分轨 | 局部编辑 | LoRA | 时长 | 结论 |
|---|---|---|---|---|---|---|---|---|---|
| **ACE-Step 1.5** | MIT | **MIT ✅** | ✅ | ✅ MLX/Metal 官方脚本 | ✅ lego/extract（base 模型） | ✅ repaint/cover/complete | ✅ 官方一键 | 10s–600s | **✅ 唯一全中** |
| YuE2 | Apache-2.0 | **CC BY-NC 4.0 ❌** | 实验 | 实验（官方"未验收"） | ❌ | 谱面级 | 社区 | 数分钟 | ❌ 商用红线 |
| DiffRhythm | Apache-2.0 | **Apache-2.0 ✅** | ✅ | ✅ | ❌ | △ 续写 | △ 有 train/ | 285s | 备选（无分轨） |
| MusicGen | MIT | **CC BY-NC ❌** | ✅ | ✅ | ❌ | △ melody | ✅ | 30s | ❌ |
| Stable Audio Open | MIT | △ Community License（营收门槛） | ✅ | ✅ | ❌ | △ inpaint | ✅ | 47s | △ 有条件 |
| Tango 2 | — | **CC BY-NC-SA ❌** | ✅ | ✅ | ❌ | ❌ | ✅ | ~10s | ❌ |
| AudioX | **CC BY-NC ❌** | ❌ | ✅ | ✅ | ❌ | △ | △ | ~10s | ❌ |
| SongGen | Apache-2.0 | **无 license 声明 ❌** | 未核实 | ❌ | △ V/A 双轨 | ❌ | ✅ | 30s | ❌ |
| Seed-Music / Stable Audio 2.5 | — | **无本地权重 ❌** | — | — | — | — | — | — | ❌ |

> 证据：ACE-Step `LICENSE`=MIT，`pyproject.toml` license=MIT，README 明确 Win/macOS/Linux + MPS/ROCm/XPU/CPU，HuggingFace 权重仓 `license: mit`；YuE2 README 的 License 表写明"Model weights: CC BY-NC 4.0 with additional creator permission / Commercial use by companies → contact us"。

---

## 3. 本机实测数据（RTX 5090 24GB，2026-11-08）

同一组 6 条提示词（3 首 JRPG BGM + 3 首 J-Rock 日语人声）分别用两个模型生成：

| 指标 | ACE-Step 1.5（xl-sft 4B） | YuE2（3B） |
|---|---|---|
| 显存峰值 | 9.8–10.1 GB | 7.7–8.3 GB |
| 单首生成 | 42–61 秒 | 46–93 秒（一次 651s，WDDM 抖动） |
| 冷加载 | 9 分 49 秒（19GB fp32 权重） | 5.3 秒 |
| 输出 | 48kHz/2ch WAV | 48kHz/2ch FLAC |
| 长曲支持 | 600s | 受 semantic token 上限约束，需裁剪 |
| 分轨/编辑/LoRA | ✅ / ✅ / ✅ | ❌ / 部分 / ❌ |

**这套数据说明**：在 24GB 消费卡上两者都能跑，但 ACE-Step 的功能面比 YuE2 宽一个量级，且许可证可用。ACE-Step 的硬件门槛也更低——官方分级表最低 **≤4GB 显存**就能出 4–6 分钟音频（2B + INT8，关闭 LM）。

---

## 4. 逐条需求落地方案（a–h）

| # | 需求 | 由谁实现 | 具体方案 | 备注/风险 |
|---|---|---|---|---|
| **a** | 分轨生成 | ACE-Step `lego` + 你现有生成器 | lego 支持 12 类音轨：vocals / backing_vocals / drums / bass / guitar / keyboard / percussion / strings / synth / fx / brass / woodwinds，**需 base 模型**（xl-base 质量更高）。Studio 里"AI 加轨"生成到独立 audio track，再可 `extract` 反向校验 | 音频分轨≠可编辑音符；想要可编辑就先用符号域生成 |
| **b** | 带节奏型的和声进行给灵感 | **符号域**（现有 ④⑤ + profile/RAG） | 现有生成器直接输出 MIDI 和弦+节奏型，用户可改；模型层只作候选源（MIDI-GPT/AMT）。**不要用音频模型做这件事**——它输出波形，改不动，也没有和弦语义 | 真实缺口是"动机/段落"，不是模型能力（见 AI_MUSIC_ROADMAP §2） |
| **c** | 按用户 MIDI 做 AI 编曲 | 符号域 + ACE-Step `cover` | ① MIDI 用现有 `OfflineAudioContext` 渲染成 WAV（你已有导出能力）→ ② ACE-Step `cover`（`audio_cover_strength≈0.8`）保旋律换编制/音色 → ③ 回填 audio track。或纯符号：按和弦做"加轨"用生成器 | 这是**最实用的一条链路**，且完全基于你已有的两个能力 |
| **c'** | 混音 | **没有可商用模型** | 用 DSP：LUFS 归一（BS.1770）、总线压缩、参考曲 EQ 匹配、分轨 gain staging；"AI 混音"作为探索项，不要在产品里承诺 | 现有多轨音量/声像/效果器 + 一条"一键对齐参考曲响度"就能覆盖 80% 需求 |
| **d** | 特定风格/用途生成 | ACE-Step `text2music` | caption + BPM/key/拍号/时长 + 参考音频 + LoRA；用途可做成 preset（BGM loop / 战斗 / 过场 / 人声 demo） | 覆盖最完整的一条，直接可用 |
| **e** | 生成后标注和弦 & 创作信息 | 分析域小模型 + ACE `understand_music` | 音频路径：BTC（MIT）和弦 + `beat_this`（MIT）拍点/小节 + ACE 的 BPM/key/拍号/caption + LRC 歌词时间戳。MIDI 路径：直接从音符算和弦（精确、免费） | 展示层用你已有的"拍"坐标系画 chord lane 即可 |
| **f** | 转 MIDI | `basic-pitch`（Apache-2.0） | 旋律/贝斯转录工业级，自带 CoreML/ONNX/TFLite。**鼓是缺口**：用 demucs(MIT) 鼓轨 + onset + GM 映射规则，或自研小模型 | 音频→MIDI 必然有损，产品话术应是"转成可编辑草稿" |
| **g** | 生成后局部迭代 | ACE-Step `repaint` | 时间区间重绘（`repainting_start/end`），最适合 Studio 的"框选一段重生成"；配 `cover`（整轨风格化）和 `lego`（单轨重做）。统一抽象成 **Take/版本栈** | 这是 ACE-Step 相对其他开源模型的**决定性优势** |
| **h** | LoRA 学特定风格/作品 | ACE-Step 官方 LoRA | Gradio 一键标注+训练，**16–20GB 显存**，8 首歌约 1 小时（3090 12GB 可跑）；仓库还有 `/v1/training/start` REST 接口 | ⚠️ 学"特定作品"有侵权风险，产品必须做"学风格不复制"的护栏 + 用户协议 |

> 红线：生态里 **ACE-Step-DAW 是 AGPL-3.0-or-later**（因为捆绑 Strudel），只能当架构参考，**不能复制代码**进闭源产品。但它的设计值得抄思路（不抄代码）：React 19 + Tone.js 15 + TypeScript，与你现有栈几乎同构，正是"LEGO 逐层生成进浏览器 DAW"的参考实现。

---

## 5. 推荐架构

```
apps/web (Tone.js DAW, AudioClip + NoteEvent 双轨数据模型)
   │  用户动作：AI 加轨 / 框选重绘 / 生成音频轨 / 转 MIDI
   ▼
apps/server (Fastify：任务队列 · SSE 进度 · 资产库 · 模型管理 · 许可证快照)
   │  本地 HTTP（127.0.0.1:随机端口）
   ▼
推理 sidecar（二选一，MIT）
   A. ace-server（acestep.cpp / C++17 + GGML）  ← 推荐 GA 路径
   B. ACE-Step Python 包（官方仓库）             ← 推荐 alpha/内部路径
   ▼
本地模型目录（GGUF 或 safetensors，按显存档位下载）
```

### 路径 A：C++/GGML（推荐用于正式发布）
- 仓库 `ServeurpersoCom/acestep.cpp`（MIT，456★）+ `ace-step/acestep.vst3`（MIT，78★，JUCE8 VST3 + 同一套 C++ 引擎）
- **不需要 Python、不需要 torch**：单可执行文件 + GGUF 权重
- 后端：CPU / CUDA / ROCm / **Metal** / Vulkan（Mac 上 Metal 自动开）
- 已验证支持全部任务类型：`text2music / cover / repaint / lego / extract / complete`，还有 LoRA 加载
- 暴露 HTTP：`/props` `/lm` `/synth` `/understand`，另有 CLI `ace-lm` / `ace-synth` / `ace-understand`
- 体积：Q8_0 全套约 **7.7GB**（LM 4B 4.2GB + 文本编码器 748MB + DiT turbo 2.4GB + VAE 322MB）；lego 需另下 base 变体
- 代价：功能面略窄于 Python 官方包（训练/评分等），需实测量化后音质

### 路径 B：Python 官方包（推荐用于快速验证）
- 功能最全：6 种任务、LoRA 训练、质量评分、LRC、understand、REST（`/v1/audio` `/v1/init` `/v1/models` `/v1/stats` `/v1/training/start`）
- 体积大（torch cu128 ≈ 2.5GB+，XL 权重 19GB），Mac 需 MPS/MLX 依赖
- 已在本机完整验证过（见 §3），可作为产品验收的"黄金参考"

### 必须改的数据模型（容易低估）
你现在是纯音符模型（`Project` / `Clip.startBeat` / `NoteEvent`）。要接音频生成，需要新增：
1. `AudioClip`（assetId、startBeat、offsetBeat、gain、fadeIn/Out、stretchFactor）
2. `Take`（同一轨的多次生成版本，可试听切换）
3. **provenance**（模型名/checkpoint/seed/prompt/参数/许可证版本）——既是产品功能（可追溯、可复现），也是合规要求
4. 波形渲染与"音频对齐到网格"：用 `beat_this` 拿到 BPM/小节后做变速对齐（`stretchFactor`）

---

## 6. 跨平台策略

| | Windows | macOS (Apple Silicon) |
|---|---|---|
| 推理后端 | CUDA（GGML-CUDA）或 Vulkan，无独显走 CPU | **Metal**（GGML 路径自动开）；Python 路径用 MPS + `mlx` LM 后端 |
| 显存档位 | 官方 8 档自适应（≤4GB 起） | 统一内存，按可用内存降级 |
| 推荐默认模型 | 8–12GB：2B turbo + 1.7B LM；≥20GB：XL 4B + 4B LM | 16GB 内存：2B turbo + 0.6/1.7B LM |
| 权重来源 | 国内必须走 ModelScope 镜像（本机实测 25–50MB/s；huggingface.co 直连不可用） | 同上 |

**关键**：模型体积是产品问题（几 GB 到 20GB）。建议：
- 首次安装只带 **2B turbo + VAE + 文本编码器**（~5GB），"高质量 XL" 与 "base（分轨用）" 按需下载
- 下载器必须支持断点续传 + sha256 + 多源（ModelScope 主、HF 备）
- 许可证快照写入 `models/manifest.json`（含 HF revision 与 license 字段），避免上游改许可后失去可追溯性

---

## 7. 风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| YuE2/MusicGen/Tango2/AudioX 权重非商用 | 🔴 高 | 已排除；CI 里加 license 白名单校验 |
| 参考 ACE-Step-DAW（AGPL）代码污染闭源 | 🔴 高 | 只读思路不抄代码；引入代码走 `ace-step/` 官方 MIT 仓与 `acestep.cpp`(MIT) |
| AI 混音无成熟模型 | 🟠 中 | 用 DSP 覆盖；不要在产品文案承诺"AI 混音大师" |
| 音频→MIDI 质量天花板（尤其鼓） | 🟠 中 | 定位为"草稿"；鼓用规则法；鼓励用户从 MIDI 出发 |
| macOS 路径未在本机验证 | 🟠 中 | P0 用任意 M 系列 Mac 做 2 天 spike；官方有 mac 便携包与 `start_*_macos.sh` |
| 音频与工程网格不对齐（BPM 漂移） | 🟠 中 | `beat_this` 定 BPM/拍点 + 变速对齐 + 手动微调 |
| 风格 LoRA 的版权风险（学特定作品） | 🟠 中 | 用户协议 + "风格而非复制"护栏 + 生成内容元数据 |
| 生成延迟与显存分级导致体验不一致 | 🟡 低 | 分级模型 + 进度条 + 失败降级到 2B turbo |
| 模型下载体积/更新 | 🟡 低 | 增量下载、镜像、校验、后台更新 |

---

## 8. 分期路线

**P0 · 可行性验证（1–2 周，不改产品）**
- 用 `acestep.cpp` 在 Win 跑通 `text2music / lego / repaint` 三条链路
- 用浏览器渲染的 WAV 做 `cover`（`audio_cover_strength` 0.6/0.8/1.0 三档），验证"保旋律换编制"
- 在任意 Mac 上验证 Metal 路径能出声
- 验收：3 个可听 demo（加轨 / 重绘 / 保旋律换风格）+ 一份跨平台性能表

**P1 · Studio MVP（4–6 周）**
- `apps/server` 增加推理 sidecar 管理 + 任务队列 + SSE 进度 + 模型管理器
- UI：AI 加轨、框选重绘、生成音频轨、Take 切换、provenance 面板
- 分析域接入：`beat_this`（BPM/小节）+ `BTC`（和弦）+ 时间轴 chord lane
- 验收：从空白工程 10 分钟内做出一段 8 小节乐队化 demo

**P2 · 生产化（8–12 周）**
- Win/macOS 双平台打包（GGML 路径统一 Metal/CUDA）
- 分级模型下载器 + 国内镜像 + 许可证快照
- MIDI 转录（`basic-pitch`）、鼓转录规则法
- 混音 DSP（LUFS 对齐、参考曲匹配）
- LoRA 训练入口（可选，标注"需 ≥16GB 显存"）
- 合规：生成内容署名/元数据、用户协议、风格学习护栏

**P3 · 探索**
- 符号 LoRA / MIDI-GPT 候选源（对齐 `FUSION_ROADMAP` 线 C）
- AI 混音研究、VST3 内嵌（`acestep.vst3` 已有 VST3 成品，可做"导出到 DAW"桥）
- 云端可选（同一套 HTTP 协议，把 sidecar 换成远端服务）

---

## 9. 需要你拍板的 5 件事

1. **产品定位**：主力是"可编辑 MIDI 编曲"，还是"出成品音频"？决定双域权重（我建议 70% 符号 / 30% 音频）。
2. **首发是否必须支持 Mac**：是 → 直接走 GGML/Metal 路径，别背 Python 分发包袱。
3. **模型内置 vs 首次下载**：内置 2B（~5GB）体验最好，但安装包合规与体积要评估。
4. **生成内容版权条款**：商用范围、是否需要 C2PA 元数据、用户作品归属。
5. **是否开放 LoRA 用户自训练**：开放=强差异化，但要承担 UGC 侵权风险与算力支持成本。

---

## 附录 · 证据链接

- ACE-Step 1.5：https://github.com/ace-step/ACE-Step-1.5 （MIT，14.5k★，README Features/Model Zoo/GPU Compatibility）
- ACE-Step 权重：https://huggingface.co/ACE-Step/Ace-Step1.5 （license: mit）
- acestep.cpp（GGML，MIT）：https://github.com/ServeurpersoCom/acestep.cpp
- acestep.vst3（JUCE8 VST3，MIT）：https://github.com/ace-step/acestep.vst3
- ACE-Step-DAW（**AGPL-3.0，仅参考**）：https://github.com/ace-step/ACE-Step-DAW
- YuE2 许可证红线：https://github.com/multimodal-art-projection/YuE （README License 表；`MODEL_LICENSE`）
- YuE2 硬件/平台说明：https://github.com/multimodal-art-projection/YuE/blob/main/docs/hardware.md
- DiffRhythm（Apache-2.0 备选）：https://github.com/ASLP-lab/DiffRhythm
- basic-pitch（Apache-2.0，CoreML/ONNX）：https://github.com/spotify/basic-pitch
- beat_this（MIT，含权重）：https://github.com/CPJKU/beat_this
- Demucs（MIT）：https://github.com/facebookresearch/demucs
- BTC 和弦识别（MIT）：https://github.com/jayg996/BTC-ISMIR19
- 不可用/注意：YourMT3(GPL-3.0)、Chordino(GPL-2.0)、Essentia(AGPL-3.0)、madmom 权重(CC BY-NC-SA)、MusicGen 权重(CC BY-NC)
