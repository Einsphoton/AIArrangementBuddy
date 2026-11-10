# JRPG / J-Rock 风格学习与 LoRA 局部微调方案

> 日期：2026-11-08
> 目标：把"我偏好 JRPG 与 J-Rock"变成两条可执行的学习通道，并给出 LoRA 微调的启动步骤
> 关联：`docs/STUDIO_ARCHITECTURE.md`（架构）、`docs/MIDI_CORPUS_STYLE_LEARNING.md`（现有语料管线）、`music-gen/acestep-cpp/REPORT.md`（引擎实测）

---

## 0. 核心判断：**两条通道，别混用**

| | 符号通道（已具备） | 音频通道（新增 LoRA） |
|---|---|---|
| 学什么 | **作曲手法**：和弦进行、节奏型、配器分工、段落能量曲线 | **音色与制作质感**：失真吉他音色、鼓组混音、弦乐编制、空间感 |
| 数据 | MIDI 谱面（现成管线 `scripts/corpus/`） | 音频（每首 1.5–5 分钟） |
| 产出 | `StyleProfile` + `STYLE_ROLES` 等生成器参数 | `.safetensors` 适配器（几十 MB） |
| 可控性 | 完全可控、可解释、可编辑 | 黑盒，只能 A/B 听 |
| 版权风险 | 低（统计分析，不复刻音频） | 高（若用未授权商业录音） |

**关键结论**：想学"植松伸夫怎么配和弦、怎么起 battle 主题"，靠 LoRA 学不到——那要靠符号分析。LoRA 只解决"听起来像那个年代的唱片"。两条通道都要，但优先级是**先符号、后音频**。

---

## 1. LoRA 局部微调：怎么启动

### 1.1 分工（已验证可行）

```
训练：Python 版 ACE-Step（本机已装 music-gen/ace-step，24GB 显存够用）
   ↓ 产出 adapter（safetensors）
推理：C++ 引擎 ace-server --lora <path> --lora-scale 0.8
```

C++ 侧 `--lora` 明确支持 **PEFT 目录**或 **ComfyUI 单文件 safetensors**，加载时把 LoRA 增量合并进 DiT 投影层。所以产品形态可以是：
**用户在云端/本机训一次 → 得到几十 MB 适配器 → 分发给所有客户端 → C++ 运行时直接加载**，不需要用户装 Python。

### 1.2 硬件门槛（官方数据）

| 显存 | 结论 |
|---|---|
| 16 GB | 最低，长歌会 OOM |
| 20 GB+ | 推荐，训练时占用约 17 GB |
| 本机 5090 D v2 | **24.4 GB，满足推荐档** |

### 1.3 数据集规格（官方格式）

```
dataset/
├── track01.wav              # 音频：wav/flac/mp3/ogg/opus，建议 48k 立体声
├── track01.lyrics.txt       # 歌词；纯器乐写 [Instrumental]
├── track01.json             # 元数据：caption / bpm / keyscale / timesignature / language
├── track02.wav
└── ...
```

`track01.json` 示例：
```json
{
  "caption": "Epic JRPG boss battle theme, orchestral brass stabs, timpani, distorted guitar power chords, double kick, 168 BPM, D minor",
  "bpm": 168,
  "keyscale": "D minor",
  "timesignature": "4",
  "language": "unknown"
}
```

**数据量建议**：

| 首数 | 能学到 | 学不到 |
|---|---|---|
| 8–12 | 音色/制作/演奏质感（LoRA 的真实能力边界） | 具体作曲手法、曲式 |
| 20–40 | 风格更稳 | 边际收益递减，开始过拟合 |
| > 60 | 收益很小 | 不如直接换基座 |

> 每首 1.5–5 分钟最佳。至少用 2 个随机种子各训一次，确认不是偶然。

### 1.4 启动步骤（具体到命令）

```bash
# 1) 进 Python 环境（已装好，torch 2.10+cu128）
cd music-gen/ace-step

# 2) 预处理：音频 → .pt 张量 + manifest.json（LoRA 与 LoKR 共用同一份预处理结果）
#    Gradio：Training 标签页 → Dataset → Preprocess
#    或 API：
#    POST /v1/training/preprocess  { "dataset_dir": "...", "output_dir": "..." }

# 3) 先跑 LoKR 试水（官方说 ~5 分钟 vs LoRA ~1 小时），验证数据与管线没问题
#    POST /v1/training/lokr/start

# 4) 再跑 LoRA（rank 16–32，batch 1，epochs 按数据量 200–500）
#    POST /v1/training/start
#    { "dataset_dir": "...", "output_dir": "...", "lora_rank": 16, "learning_rate": 1e-4, "epochs": 300 }

# 5) 导出并交给 C++ 引擎验证
ace-server.exe --lora models/lora_jrpg_v1 --lora-scale 0.8 \
  --embedding ... --dit acestep-v15-turbo-Q8_0.gguf --vae ...
```

**必须先确认的一件事**：LoRA 是注入到 **DiT** 的。所以
- 想在 **text2music / cover** 上用 → 在 `turbo`（或 `sft`）上训；
- 想在 **lego 加轨 / repaint** 上用 → 要在 `base`（lego）或 `sft`（repaint）上训。

一个适配器**不会**跨 DiT 变体通用。产品的模型清单里要把 `adapter × 基座 × 任务` 三者绑成一条记录。

### 1.5 验收标准（别只看"像不像"）

1. **A/B 盲听**：同 seed、同提示词，开/关 LoRA 各 3 首，随机顺序听，能听出差异才算有效。
2. **提示词遵循度**：换一个提示词（比如"钢琴独奏"），LoRA 不能把它也拽成摇滚——否则是过拟合。
3. **风格相似度**：用 CLAP / 音频 embedding 算与目标集的距离，前后对比。
4. **退化检查**：时长、响度、有无爆音/静音段、结尾是否被截断。

---

## 2. JRPG 语料：学谁、学什么

> 下面每个人名对应"可被编码成符号规则的特征"，不是"随便下载几首"。

| 作曲家 | 代表作 | 可学习的特征（→ 进 `StyleProfile` / 生成器） |
|---|---|---|
| **植松伸夫** Nobuo Uematsu | FF I–X | 管弦与摇滚混合编制；battle 用驱动式低音弦乐 + 铜管切分；大调主题与关系小调战斗曲对照；模进式 ostinato |
| **光田康典** Yasunori Mitsuda | Chrono Trigger/Cross、Xenogears | 民族乐器音色（凯尔特/中东）；6/8 与复合拍；Dorian/Phrygian 调式交替；室内乐小编制 |
| **下村阳子** Yoko Shimomura | Kingdom Hearts、Live A Live | 钢琴主导；华丽转调；抒情主题与快节奏切分战斗曲的反差 |
| **桜庭統** Motoi Sakuraba | Tales、Star Ocean | 前卫摇滚式战斗曲：奇数拍、Hammond organ、双踩、对位化 bass line |
| **崎元仁** Hitoshi Sakimoto | FFT、FF XII、放浪冒险谭 | 密集对位、非功能和声、铜管+弦乐的紧张织体、 deceptive cadence |
| **岡部啓一** Keiichi Okabe | NieR 系列 | 极简动机重复、无词咏唱人声、大小调模糊、大量留白 |
| **目黒将司** Shoji Meguro | Persona 3/4/5 | **J-Rock 与 JRPG 的交汇点**：acid jazz/funk 律动 + 摇滚编曲 + 女声；切分吉他 comping |
| **古代祐三** Yuzo Koshiro | Ys、怒之铁拳 | FM 合成音色；16 分快速 arpeggio；高速驱动 bass |
| **伊藤賢治** Kenji Ito | SaGa 系列 | 钢琴+弦乐战斗曲；激烈模进；半音上行推进 |

**推荐起步组合（覆盖三种典型 JRPG 场景）**：
1. **战斗曲**（植松/桜庭）：168–180 BPM，D/E 小调，铜管 stab + 低音弦乐 ostinato + 双踩
2. **城镇/野外**（光田/下村）：6/8 或 3/4，民谣乐器 + 木管，明亮大调
3. **剧情/悲伤**（岡部/下村）：慢速，钢琴动机重复，弦乐长音铺底

## 3. J-Rock 语料：按年代分层

| 层 | 代表 | 可学习特征 |
|---|---|---|
| 90s 王道 | B'z、L'Arc~en~Ciel、GLAY、X JAPAN | 双吉他 harmony、快速 alternate picking、bass 走句、副歌大转调 |
| 00s | Asian Kung-Fu Generation、ELLEGARDEN、BUMP OF CHICKEN | 清音 arpeggio 与失真 riff 的对比；流行旋律压失真伴奏 |
| 10s–20s | ONE OK ROCK、RADWIMPS、凛として時雨、BAND-MAID | 左右声道双吉他分工；post-hardcore 高音 vocal 与不协和；production 主导的音墙 |
| 制作向 | 米津玄師 | 编程鼓组 + 真实吉他的混合；副歌密度突变 |

**共同特征（可直接写进 generator）**：4/4 为主、160–200 BPM 常见（追逐/战斗场景）、bass 16 分推进、副歌 modal shift、鼓组 backbeat + 军鼓重音。

---

## 4. 版权：三档策略（必须选一档，不能含糊）

| 档 | 用途 | 能否用商业录音训练 | 约束 |
|---|---|---|---|
| **A 个人实验** | 自己听、本地不发布 | 事实上会做，但仍有风险 | 产物不外发、权重不外传、不商用 |
| **B 内部研发** | 评估模型能力、内部 A/B | 可用（内部研究） | 训练数据与权重不得分发；不发布含原曲特征的成品 |
| **C 商业内置** | 打包进产品给用户用 | **不可以** | 必须自有/授权/CC/合成数据，且保留数据来源与许可快照 |

**推荐的合规主路径（也是产品该走的路）**：
1. **符号通道**：用 MIDI 谱面做统计分析 → 得到 `StyleProfile`（学手法，不复刻任何音频）→ 风险最低，且可解释、可编辑。
2. **音频通道**：先用**自有录音**或 **CC 授权**音频训练；或者
3. **合成数据训练**：用现有 MIDI corpus + 高质量 soundfont 渲染成音频 → 训练 LoRA。**权利链完全干净**，缺点是音色不如真实唱片。
4. 真实商业唱片只用于**内部评估**（档 B），不进入产品数据。

> 注：`Provenance` 里已预留 `license` / `licenseSnapshotAt` / `adapterIds`，就是为了这条链可追溯。

---

## 5. 执行顺序（建议）

| 步 | 内容 | 产出 | 预估 |
|---|---|---|---|
| **L1** | 新增 `jrock` / `jrpg` 两个 StyleId（7 处 `Record<StyleId,…>` 表要一起填）：角色分工、和弦进行、段落命名、默认调、旋律乐器、BPM 区间 | 生成器能直接产出这两种风格 | 0.5–1 天 |
| **L2** | MIDI 语料扩到 JRPG/J-Rock（自有/公开 MIDI），跑 `scripts/corpus/profile.mjs` 出 profile | 可用的 `StyleProfile` | 1–2 天 |
| **L3** | 搭 LoRA 数据集（自有录音 8–12 首）→ LoKR 试水 → LoRA 正式训练 | 一个 `lora_jrock_v1` 适配器 | 1 天 + 训练 1–2 小时 |
| **L4** | C++ 引擎 `--lora` 加载 + A/B 验收 | 有/无 LoRA 对比样例 | 半天 |
| **L5** | 接进模型管理器：`adapter × 基座 × 任务` 三元组、下载清单、许可快照 | 用户可一键下载风格包 | 1–2 天 |

**L1 先行**的理由：它是纯符号域、零版权风险、马上能听见效果（不用等训练），而且 LoRA 的效果要建立在正确的基座风格之上——基座风格不对，LoRA 也救不回来。

---

## 6. 已知未知（要在 L3 前验证）

1. 训练出来的 adapter 能否被 C++ 引擎正确加载（格式：PEFT 目录 vs ComfyUI 单文件）——**最先验**。
2. LoRA 在 `turbo` 上训练后，`cover` 模式是否同样生效（cover 走同一 DiT）。
3. 训练数据里 48kHz vs 44.1kHz 是否影响（引擎输出固定 48kHz）。
4. 一个 LoRA 融合多少训练数据会开始"污染"提示词遵循度（建议 rank 16 起，别一上来 rank 64）。

---

## 7. 数据来源：合法路径清单

> 前提：**购买 OST 不等于获得训练权**；商业订阅曲库（Epidemic Sound / Artlist 等）
> 的条款普遍禁止"用于训练 AI 模型"。以下按许可分档。

| 来源 | 许可 | 商业产品可用 | 说明 |
|---|---|---|---|
| **OpenGameArt.org** | CC0 / CC-BY | ✅（CC0）/ 需署名（BY） | 大量 JRPG 风格 chiptune、orchestral、战斗曲，最适合起步 |
| **itch.io 免费 OST 包** | 逐包看 LICENSE | 视许可 | 独立游戏 OST 常带 CC 授权，质量不差 |
| **Free Music Archive** | CC0 / CC-BY / CC-BY-NC | ❌ NC 档 | 按许可筛选 |
| **Jamendo** | CC 系列 | 视许可 | 需逐曲确认 |
| **Musopen** | 公版（古典） | ✅ | 管弦乐录音，可补"管弦质感" |
| **Internet Archive** | 混合 | 需逐个确认 | 有 PD 老录音 |
| **YouTube Audio Library** | 免版税 | ⚠️ 条款仅授权"用于创作"，训练归属未明 | 不建议作为产品数据 |
| **Bandcamp CC 专辑** | CC | 视许可 | 搜索页可按授权筛 |
| **商业 OST（购买/抓取）** | 保留所有权利 | ❌ | 内部研究风险自担；**不得进入产品** |
| **Touhou 同人** | ZUN 二次创作规约 | ❌ 明确禁止商用 | 训练归属不明确，不建议 |
| **自己作曲 / 自己演奏** | 自有 | ✅ | 最干净 |
| **ACE-Step 自生成** | 权重 MIT，产物无第三方权利 | ✅ | 见 §8 self-distillation |

---

## 8. 关键法律事实：**风格不受版权保护**

版权保护的是**具体表达**（旋律、具体和声编排、某次录音），不保护"风格 / 体裁 / 配器套路"。
所以"做一首 JRPG 战斗曲"和"复制植松伸夫的某首曲子"在法律上是两件事。

**因此最干净的路径是：用风格描述 + 自有/CC 素材合成训练集。**

实操三步（成本极低，已在本机验证过速度）：

1. **批量自生成**：用 ACE-Step 以强 JRPG 提示词生成 200–500 段
   （实测约 1 分钟 10 段 40s，12 段 ≈ 40 秒生成时间）
2. **人工筛选**：挑出最像目标风格的 30–50 段作为风格锚点集
3. **在这批自生成数据上训 LoRA** → 法学上叫 **self-distillation**，权利干净可商用

局限要说清：音色上限被基座模型锁死（学不到真实唱片的质感），
但**编配习惯、段落结构、配器组合**能学到——而这恰恰是"听起来像 JRPG"的主要成分。

另一条同源路径：**MIDI → 渲染 → 训练**。用现有 MIDI corpus（自有/PD 谱面）+
高质量 soundfont 渲染出音频，权利链同样干净，且编配信息更可控。

---

## 9. 本次实际跑了什么（pipeline validation）

目的是先验证「预处理 → 训练 → 导出 → C++ 加载」四段链路，**不是**学风格。

| 项 | 结果 |
|---|---|
| 数据集 | 12 段 ACE-Step 自生成 JRPG 音频（战斗 6 / 城镇 3 / 悲情 3），40s / 48kHz 立体声 |
| 预处理 | ✅ 12/12 成功，82 秒（单卡 5090 D v2） |
| 训练 | LoKR，rank 64，lr 0.03，500 epochs |
| 产物 | `music-gen/lora-data/out/jrpg_v1_lokr/` |
| 数据目录 | `music-gen/lora-data/jrpg_v1/`（音频 + `.json` + `.lyrics.txt` 三件套） |

**换成真实合法数据只需替换音频目录后重跑同一命令**，训练参数不用改。

### Windows 上踩到的两个坑（已修）

1. `torchaudio 2.10` 导入阶段就 `import torchcodec` 探测后端，而本机缺 FFmpeg 共享库
   → `OSError(WinError 127)`，连 `backend="soundfile"` 都救不回来（它只捕获 ImportError）。
   修法：`sitecustomize.py` 垫片把 `torchaudio.load` 整体换成 soundfile 实现
   （`music-gen/tools/pyshim/sitecustomize.py`，通过 PYTHONPATH 注入）。
2. matplotlib / HF / torch 缓存默认写到用户目录被沙箱拦 → 统一重定向到
   `music-gen/.cache/{mpl,hf,torch,triton,uv}`。

---

## 10. 首轮实验结果（2026-11-08 实测）

| 项 | LoKR | LoRA（PEFT） |
|---|---|---|
| 用时 | 28m 12s | **10m 00s** |
| 步数 | 6000 | 2400 |
| loss | 1.47 → 0.81 | 0.49 → 0.33（best 0.26） |
| 峰值显存 | 4.8 GiB | 4.7 GiB |
| 权重 | 2.8 MB | 21.1 MB |
| C++ 加载 | ❌ Merged 0 pairs | ✅ Merged 192 pairs |

**格式边界（产品必读）**：C++ 引擎只认 PEFT 目录（`adapter_config.json` +
`adapter_model.safetensors`）；LoKR 无论单个文件还是目录都会被**静默跳过**（分别表现为
`Merged 0 pairs` 和找不到 `adapter_model.safetensors` 后继续生成基线音频）。
→ 模型管理器必须校验 `Merged pairs > 0`，否则会出现"加载了但没生效"的假象。

**A/B 客观指标**（同 seed、30s）：波形相关 0.46–0.57，频谱距离 0.79–0.96 → 适配器确实生效，
输出被显著改变；频谱质心整体下移（更暗更重），符合训练集方向。

细节与复现命令见 `music-gen/lora-data/ab/jrpg_v1/REPORT.md`。

> 注意：本轮数据集是 ACE-Step **自生成**的 12 段（战斗/城镇/悲情），用于验证管线，
> 不用于风格学习。换成合法音频后重跑同一命令即可。

---

## 11. 第二轮：30 段跨场景数据 + 双风格（2026-11-08 夜）

数据：`gen_style_datasets.py` 生成两套 30 段 / 22.5 分钟数据集，每套 6 个子类型
（jrpg: battle/boss/dungeon/town/field/sorrow；jrock: 90s/pop-punk/modern/post-hardcore/funk/anime OP），
BPM 与调性逐段变化。`audit_dataset.py` 体检 **0 错误 0 警告**。

| 适配器 | rank | 步数 | 用时 | loss | 峰值显存 | 权重 | C++ 实测 |
|---|---|---|---|---|---|---|---|
| `jrpg_v2` | 32 | 4500 | 18m53s | 1.07 → 0.54（best 0.286） | 4.8 GiB | 42.1 MiB | ✅ Merged 192 pairs |
| `jrock_v1` | 32 | 4500 | 19m27s | 1.11 → 0.61（best 0.382） | 4.8 GiB | 42.1 MiB | ✅ Merged 192 pairs |

**结论**：
1. 单步成本不变（30 段 × 150 epoch ≈ 4500 步，约 0.25s/步），数据从 12→30 段只线性增加时间。
2. loss 起点更高（1.07/1.11 vs 0.49）是数据多样性带来的正常现象；best loss 0.29/0.38 说明仍有拟合空间
   （下一轮建议：60 段以上 + 300 epoch）。
3. 适配器 rank 32 的体积是 42.1 MiB，rank 16 是 21.1 MiB —— 分发成本很低，适合"云训一次、客户端拉取"。

**A/B（`ab_metrics.py`，同 seed 30s）**：波形相关 jrpg 0.40–0.61 / jrock 0.35–0.51；
频谱质心变化 jrpg ±110Hz、jrock ±600Hz。jrock 改动更大，方向符合训练集
（王道曲变厚变暗、post-hardcore 变亮变冲）。响度普遍 +1.4–3.3dB、峰均比下降，
说明适配器吸收了训练集的响度特征 → **产品默认 `--lora-scale` 建议 0.6–0.8**。

> 指标口径说明：`ab_metrics.py` 的 `spec_dist` 用归一化平均频谱的 L1 距离，
> 与 §10 里旧脚本的数（0.79–0.96）不可直接比较，只看同口径下的相对变化。

**新增数据工具链**（见 `docs/MODEL_MANAGER.md` §4）：
`ingest_audio.py`（任意音频 → 训练集，强制许可清单）→ `audit_dataset.py`（训练前体检）
→ `train_lora.py` → `register_adapter.py --verify`（注册 + C++ 实测）。
真实数据到手后，**不需要改任何代码**，只换 `--src` 目录。

---

## 12. 真实数据（用户本地库，内部研究 — 2026-11-09）

数据来自用户自有本地音乐库（**只读**，未改动源目录），构建脚本 `music-gen/tools/build_real_dataset.py`，
详细报告见 `music-gen/lora-data/REAL_DATA_REPORT.md`。

### 12.1 数据源与规格

| 数据集 | 来源 | 曲目 | 样本 | 时长 |
| --- | --- | --- | --- | --- |
| `real_jrpg_v1` | `D:\AI Project\MusicGen\JRPG-OST\`（1990s/2000s/2010s/2020s 四个年代，2593 首 mp3） | 40 | 80（2 段/曲） | 80 分钟 |
| `real_jrock_v1` | `D:\AI Project\MusicGen\JROCK-专辑\`（快照时 14 个乐队目录有音频，479 首 mp3） | 40 | 80（2 段/曲） | 80 分钟 |

- 切片：每曲 2 段 × 60 s，取时长 30% / 62% 位置（避开前奏）；48 kHz 立体声 PCM16、峰值 -1 dBFS、去直流、15 ms 淡入淡出。
- 抽样：固定 seed `20261109`，JRPG 每年代 10 首且尽量不同游戏/作曲家；JROCK 按乐队 priority 轮转（STRAIGHTENER / ONE OK ROCK 等优先，再补第 2、3 首）。
- 标注：BPM 用 numpy 谱通量 onset 包络自相关（60–190 BPM，低置信回退 120）；调性用对数频率 chroma + Krumhansl 模板；caption 英文（JRPG 按年代+作曲家风格+场景+能量；JROCK 按乐队风格+专辑年份+能量）。
- 体检：`audit_dataset.py` 两套均 **0 错误 0 警告**。

### 12.2 权利与分发边界（必须遵守）

> **licence: user-provided commercial recordings; internal research only — DO NOT DISTRIBUTE**

- 这些是**商业录音**，仅限本地内部研究 / 风格学习；**不得随产品分发、不得上传、不得进入 nativeReady**。
- 每个数据集目录内有 `_dataset_license.json`，`_manifest.json` 逐样本带 `license` 字段且 `native_ready_allowed: false`。
- 适配器注册（`register_adapter.py`）时必须携带同样的 license 标记，`nativeReady=false`；产品分发目录不得包含由这批数据训出的适配器。
- 训练日志/报告中引用本数据时同样标注该 licence 文本。

### 12.3 已知风险（训练前决策）

1. JROCK 片段含人声，但按规格标 `[Instrumental]` + caption 不提人声 → 可能引入“人声当器乐”偏差，建议降权/筛纯器乐段。
2. BPM 自相关存在半速/2:3 层级歧义（置信度已逐样本记录），建议抽查低置信样本。
3. 调性只输出升号（`A# minor` 等），未做等号降号归一。
4. JROCK 仍有 7 个乐队目录只有 `专辑清单.md`（无音频），且用户库正在实时补充；补全后重跑 `build_real_dataset.py` 刷新。
5. 标签为自动估计，未逐段人工试听核对；本轮未跑训练（GPU 由 Lead 统一调度）。

### 12.4 复现

```powershell
$py = "music-gen/.lead-env/Scripts/python.exe"
& $py music-gen/tools/build_real_dataset.py --style both
& $py music-gen/tools/audit_dataset.py --dataset music-gen/lora-data/real_jrpg_v1 --json music-gen/lora-data/real_jrpg_v1/_audit.json
& $py music-gen/tools/audit_dataset.py --dataset music-gen/lora-data/real_jrock_v1 --json music-gen/lora-data/real_jrock_v1/_audit.json
```
