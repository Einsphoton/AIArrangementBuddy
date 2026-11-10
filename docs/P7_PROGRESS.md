# P7 自动推进记录（质量模式 → MIDI 渲染 → 和弦补全 → 简谱 → 一键整曲）

> 用户授权：P7-A→E 自动推进、无需逐步确认；过程产物随时可试听：
> **http://127.0.0.1:8908/P7_PROGRESS.html**（预览服务：`node scripts/audio-preview-server.mjs --port 8908`）

## 阶段 A：质量模式（LM → sft 50 步）✅ 2026-11-10

**目标**：把用户认可的 `LM → sft 50 步` 质量档做成产品可选项（默认仍是快模式）。

### 实现
- **Companion**（`scripts/companion.mjs`）
  - 引擎支持 LM：`EngineManager` 增加 `lm` 维度（启动参数 `--lm acestep-5Hz-lm-1.7B-Q8_0.gguf`），同变体但 LM 不同会重启引擎；心跳上报 `engine.lm`。
  - `generate_audio` 支持 `params.quality: true`：`sft` 引擎 + `/lm` → `/synth` passthrough，固定 **50 步 / guidance 1.0 / shift 1.0**；`buildQualityLmRequest` / `buildQualitySynthRequest` 纯函数。
  - **关键发现（真机对照）**：把 `bpm/keyscale` 塞进 `/lm` 请求会让 LM 回显这些值并生成更暗的编曲（频宽截止 9205Hz）；改成只给 `caption + lyrics + duration`（让 LM 自己推断编曲参数）后频宽截止 **13482Hz**。产品按后者实现。
  - `requiredVariant` 推断识别 quality → `sft`（服务端派单与 Companion 校验一致）。
  - 质量模式与 turbo LoRA 适配器互斥（明确中文报错）。
  - 进度：引擎 0.15 → LM 0.3–0.4 → 合成 0.4–0.9 → 1；估算 20 + 时长×1.2s。
- **服务端**（`apps/server`）
  - `POST /api/companion/tasks`：`params.quality` 必须是布尔（否则 400）；quality 任务 `requiredVariant='sft'`（`variantOverride`）。
  - VST3 桥接同样支持。
- **前端**（`apps/web`）
  - 生成面板新增「质量模式（LM → sft 50 步）」开关（`data-quality-toggle`），勾选后清空并禁用 LoRA 适配器；提交 `params.quality=true`。

### 真机验收
| 项 | 结果 |
|---|---|
| Companion 自检 | **87/87**（新增 §13：LM 请求体/ passthrough 50 步 / 引擎 LM 决策 / `--lm` 启动） |
| 质量档真机（GPU） | **5/5**：任务 `requiredVariant=sft`、wall **21–24s**（LM 3.8–4.4s + 50 步 10–12s + 引擎 6–7s）、产物 19.2s、频宽截止 **13482Hz**、8–16k **5.0%** |
| 生成面板 UI | **4/4**（默认关；勾选后适配器禁用；提交质量任务；取消勾选恢复） |
| 回归 | 三包 tsc、Companion 自检、既有 UI 见各阶段 |

**边界**：质量模式比快模式慢（20s 音频约 15–25s，长曲更久）；显存要能同时装 LM(1.84GB)+sft(2.37GB)+VAE；与 LoRA 适配器互斥；LM 输出时长可能比请求短约 4%（19.2s vs 20s）。

## 阶段 B：MIDI → WAV → cover（AI 渲染成歌）✅ 2026-11-10

**目标**：用户给旋律/伴奏 MIDI（或任意工程）→ 离线渲染 WAV → cover（保结构换编制）→ 得到 AI 渲染的完整歌；可对成品继续 lego 加轨/repaint 迭代。

### 实现
- **服务端**：新任务类型 `cover_audio`；校验 `sourceAssetId` 存在、`caption` 必填、`audioCoverStrength` 0–1；`requiredVariant='turbo'`（cover 用 turbo）；`sourceDurationSec` 自动补。
- **Companion**：`validateCoverParams` / `buildCoverRequest` 纯函数；执行器 `runCover` 下载源 → turbo 引擎 → multipart（`audio_cover_strength` + 8 步 / guidance 1.0 / shift 1.0）→ 产物 `cover-*.wav`；mock 也支持；启动前拦截参数错误。
- **前端**：生成面板新增「AI 重编（cover）」：**离线渲染当前工程**（`engine.renderToWav`，含每轨链/母线链）→ 上传资产 → 提交 cover 任务（带「贴近原结构」0–1 滑杆，默认 0.7）→ 完成后按现有 done 流程自动落新音频轨，**不改动原 MIDI**。

### 真机验收
| 项 | 结果 |
|---|---|
| Companion 自检 | **90/90**（新增 §14：validateCoverParams / buildCoverRequest 字段 / 变体 turbo / mock 能力 / 耗时估算） |
| 服务端 API | **4/4**（4 组非法参数 400、turbo 派单、完成入库、sft-only worker 被跳过） |
| 真机 cover（GPU） | **5/5**：wall **17–21s**、产物 19.2s 与源一致、与源波形相关 **0.406**（确实重编）、频宽截止 **15756Hz**、源资产 sha256 未变 |
| 前端 | **4/4**（入口存在、strength 默认 0.7、上传渲染 WAV + 提交任务、完成后自动落轨） |

**边界**：cover 是 turbo 8 步（快模式），质量档 cover 未开放（sft cover 需另行验证）；strength 越高越贴近原结构、越低越自由；"迭代加轨"目前可通过生成 Stem（lego）或对成品再跑 cover/repaint 组合；导出渲染时长与轨数相关（逐轨离线渲染）。

### 过程产物
- 真实 GPU cover 样音：`music-gen/lora-data/quality-matrix/p7b_cover_demo.wav`（进度页可直接听）
## 阶段 C：和弦进行补全 ✅ 2026-11-10

**目标**：用户给不完整和声进行，AI 补全后半段（可解释、确定性），并能写回工程和弦、联动"跟随和弦"的智能片段。

### 实现
- **core**（`packages/core/src/studio.ts`）：`completeProgression({ key, scale, partial, style, targetLength, beatsPerChord })`
  - 按"用户给的最后和弦的功能"（主/下属/属/下中音/中音/导音）挑接续模板；
  - 风格偏好：古典偏 V–I 正格、爵士偏 ii–V–I 且自动加七和弦、J-Rock/JRPG 偏 IV–V–I 拱形；
  - 不足目标长度用循环模板延长，去尾部重复并**保证收束在 V–I**；
  - 输出 `full`（罗马数字）、`chords`（已按调性解析）、`cadence`（正格/变格/阻碍/半终止）、`reasons`（可解释）。
- **服务端**：`POST /api/suggest/complete-progression`（缺 partial / 非法罗马数字 → 400 中文）。
- **前端**：智能片段面板「补全进行」：输入罗马数字前缀（默认 `I V vi`）、目标长度 4/8/16 → 展示整段进行 + 终止式 + 原因 → 「写入工程和弦」（一次撤销，跟随和弦的智能片段自动重算）。

### 真机验收
| 项 | 结果 |
|---|---|
| core + API | **6/6**：目标长度/前缀保留/确定性/风格差异/边界/接口 400 |
| 智能片段面板 UI | **5/5**：选中片段、补全结果（`I · V · vi · IV · V · I · V · I`）、写入 8 和弦、1024px、无 console |
| 回归 | 三包 tsc、studio core 14/14、Studio UI 12/12、既有 UI 30/30、API 探针 12/12 |

**边界**：补全是"规则 + 风格倾向"的确定性算法（不是模型生成）；只处理调内罗马数字（`bVII` 等可解析但补全模板以调内为主）；目标长度最多 32 个和弦；终止式默认收 V–I（需要半终止可手动改末尾）。

## 阶段 D：简谱导入 → MIDI ✅ 2026-11-10

**目标**：用户粘贴旋律简谱 → 生成可编辑的旋律 MIDI 轨 → 可直接接 P7-B 渲染成歌。

### 实现
- **core**（`packages/core/src/jianpu.ts`）：
  - `parseJianpu(text, opts)`：支持 `1=C`/`4/4`/`♩=120`/`T: 标题` 头信息；音符 1–7（0 休止）、`'`/`，` 八度、`#`/`b` 升降、`/` 减半（八分/十六分）、`.` 附点、`-` 延长、`~` 连音、`|` 小节线；无法识别 token 记 warning 不中断；无音符抛中文错误。
  - `jianpuToProject(text, opts)`：生成单条「简谱旋律」轨（钢琴 clear）+ 一个片段 + 段落 + loop，直接可加载编辑。
- **前端**：文件菜单新增「导入简谱…」→ 弹窗粘贴文本（含占位示例）→「导入并替换工程」→ 成功 toast 摘要 + 警告提示；空文本不替换工程。
- **端到端演示**：简谱《小星星》→ 导入 → 渲染当前工程 → cover 成歌 → `music-gen/lora-data/quality-matrix/p7d_jianpu_cover_demo.wav`（真实 GPU）。

### 真机验收
| 项 | 结果 |
|---|---|
| core 解析 | **10/10**（音高 C/D/Bb、八度/升降、时值 0.5/1.5/2、连音、休止、小调、warning、工程生成、空文本错误、确定性） |
| 文件菜单 UI | **4/4**（入口、导入替换成 14 音旋律轨、空文本不替换、无 console） |
| 端到端演示 | ✅ 简谱 → 旋律轨 → 渲染 → cover 产物 12s（进度页可试听） |

**边界**：只做"简谱 → 单旋律轨"；配器/编曲需再走场景编曲或 P7-B cover；`1=` 只支持大调（minor 用 `scale` 选项）；八度点仅支持 `'`/`,` 文本写法；复杂节奏（三连音/自由延长记号）不支持，会忽略并 warning。

## 阶段 E：一键「整曲 + 分轨 Stem」工作流 ✅ 2026-11-10

**目标**：一条操作完成"生成整曲 → 自动按乐器生成分轨 → 全部落轨"，不需要逐个提交/搬资产。

### 实现
- **前端**（`apps/web/src/features/audio/SongWorkflow.tsx`，挂在生成面板）：
  - 选乐器（7 种，默认吉他/贝斯/鼓）+ 复用质量模式开关 + 优先级；
  - 流程：`generate_audio`（可 quality）→ 完成后取 peaks 落「整曲」音频轨 → 以整曲 assetId 为源依次 `generate_stem`（base/lego）→ 每条落独立「Stem · 乐器」轨；
  - 面板内显示每步状态/进度；任一步失败给可读原因并标记失败步骤；每条落轨独立撤销。
- 复用既有服务端/Companion 任务类型（无新协议），自动继承优先级、排队、取消、能力匹配。

### 真机验收
| 项 | 结果 |
|---|---|
| 工作流 UI（mock Companion） | **4/4**：区块与默认 3 乐器、先整曲后 3 条分轨且 sourceAssetId 正确、全部完成后 1+3 条音频轨、无 console |
| 真实 GPU 端到端 | ✅ 质量模式整曲 29s + 吉他/鼓 stem 各 29s，全部完成并自动落轨 |
| 产物 | `quality-matrix/p7e_song.wav`、`p7e_stem_guitar.wav`、`p7e_stem_drums.wav`（进度页可听） |

**边界**：整曲时长当前用 Companion 默认（30s；UI 时长字段暂未接入工作流）；分轨是 lego 独立生成（不是分离），质量取决于 base 模型与提示词；整曲→分轨会触发引擎切换（sft+LM → base，base 冷启动约 30–40s）。
