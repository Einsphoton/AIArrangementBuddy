# MIDI 语料管线（`scripts/corpus/`）

把「一堆同风格 MIDI」变成「一份生成器能消费的风格画像」的离线工具链。
零依赖、纯 Node、不进产物、不影响 `packages/core` 的纯函数约束。

> 设计说明与路线图见 [docs/MIDI_CORPUS_STYLE_LEARNING.md](../docs/MIDI_CORPUS_STYLE_LEARNING.md)。

## 目录约定

```
data/corpus/                     ← 本地语料，data/ 已被 .gitignore 忽略
  jrpg/
    nes-mdb/                     ← 来源目录（便于按来源分别统计/剔除）
      *.mid
    fan-transcription/
  j-rock/
  britpop/
  post-hardcore/
  profiles/                      ← 产物
    jrpg.json
```

**原始 MIDI 永远不进 git、不进 Docker 镜像、不随产品分发。**
画像里只有分布与分位数，没有原始音符。

## 三个命令

```bash
# 1) 自检：不需要网络和语料，合成一段 MIDI 跑通全链路
pnpm corpus:selftest

# 2) 看单个文件抽出了什么特征
pnpm corpus:inspect data/corpus/jrpg/nes-mdb/foo.mid

# 3) 构建一份风格画像
pnpm corpus:profile data/corpus/jrpg --style jrpg --out data/corpus/profiles/jrpg.json
```

`--strict` 会把带 `overQuantized` / `robotVelocity` 标签的文件也一并丢弃（默认只记录标签、保留文件）。

## 质量闸门与标签

**直接丢弃**（`reasons`）：

| 原因 | 阈值 |
| --- | --- |
| 音符太少 | < 16 |
| 长度不足 | < 8 小节 |
| 长度异常 | > 400 小节 |
| 音高越界 | >2% 音符落在 21–108 之外 |
| 解析失败 | — |

**保留但打标签**（`tags`），用于后续按用途分层取样：

| 标签 | 含义 | 影响 |
| --- | --- | --- |
| `robotVelocity` | 所有声部内部力度恒定（音源导出/记谱软件生成） | **不能用于学习演奏层**（力度、重音、人性化），但可用于和声/织体统计 |
| `overQuantized` | 全部音符严格落在 1/16 网格 | 同上 |
| `noDrums` | 音符数 > 200 却没有鼓轨 | 多半是钢琴改编，不适合学编曲 |
| `ghostTracks:N` | 有 N 条音符数 < 4 的空轨 | 建议在预处理时合并/删除 |
| `gmDrumOutOfRange` | 鼓轨用了 GM 之外音高 | 打击乐语汇不可信 |

> 经验：网上扒带的 JRPG MIDI 里 `noDrums` 和 `robotVelocity` 的比例会非常高（大量是钢琴独奏改编）。
> **先看这两个标签的分布，再决定这批语料值不值得进管线**，能省掉几周的无效清洗。

## 画像里有什么

`profiles/<style>.json`（`schema: aiab.style-profile.v1`）按音乐层组织：

- `tempo` / `timeSignature` / `key`：速度、拍号、大小调比例、主音分布
- `rhythm`：每小节音符密度、反拍率（`offbeatRate` / `offbeat8thRate`）、
  网格偏离（`gridDeviation16`，0 = 完全量化）、swing 比例（`swingRatio`，1.0 = 平直）、时值分布
- `harmony`：每小节和弦变化率、调内和弦比例、和弦性质分布、**最常见功能进行**（罗马数字 bigram）
- `intervals`：主旋律线的音程分布、级进率 / 跳进率 / 同音重复率
- `texture`：层数、角色占比（bass/guitar/keys/strings/…）、**每个角色的音区、密度、复调度、力度方差**
- `dynamics` / `articulation`：力度均值方差、重音位置、连奏比例、断奏比例
- `repetition`：小节级重复率、4 小节乐句重复率（曲式感）

每项数值都是分位数摘要：`{ n, p10, p25, median, p75, p90, mean }`。

## 数据来源（已核实，2026-11）

| 来源 | 规模 | 能否按目标风格筛 | 备注 |
| --- | --- | --- | --- |
| [GigaMIDI](https://github.com/Metacreation-Lab/GigaMIDI-Dataset) | > 100 万 MIDI | ✅ 有 Discogs / Tagtraum / Last.fm 三套标签 | 目前唯一有希望筛出日系、游戏、Britpop、Post-Hardcore 的大库 |
| [MetaMIDI](https://github.com/Metacreation-Lab/MetaMIDI-Dataset) | 436,631 | ⚠️ genre 仅覆盖 33% | 弱标签，需人工抽检 |
| [Lakh MIDI](https://colinraffel.com/projects/lmd/) | 176,581（45,129 对齐 MSD） | ⚠️ 只有 MSD 粗标签 | 无 J-rock/Britpop 细分 |
| [NES-MDB](https://github.com/chrisdonahue/nesmdb) | 5,278 首 / 397 款 NES 游戏 | ✅ 按游戏/厂商 | chiptune 符号化，**不是管弦乐 JRPG 配乐**，但 FF/DQ 早期曲目在里面 |
| [VGMIDI](https://github.com/lucasnfe/vgmidi) | vgmusic 钢琴改编 | ✅ 按游戏 | 只有钢琴编配 |
| [GMD](https://magenta.withgoogle.com/datasets/groove) | 13.6 小时鼓 | ⚠️ 18 种鼓风格 | 学律动/人性化的最佳来源 |

**未找到**：公开的 J-rock / J-pop 多轨 MIDI 数据集；JRPG OST 多轨 MIDI 数据集。这两类只能用「弱标签粗筛 + 人工听检 + 自建转录」补。

## 音频转录（补缺口用，只作草稿）

| 工具 | 许可 | 适用 |
| --- | --- | --- |
| [basic-pitch](https://huggingface.co/spotify/basic-pitch) | Apache-2.0 | 单乐器最优；不分轨、不处理鼓、输出单一 MIDI 流 |
| MT3 / MR-MT3 | Apache-2.0 | 多轨，但已知 instrument leakage（乐器串轨） |
| YourMT3+ | 开源 | 十数据集表现有竞争力；论文自承商业流行混音仍有局限 |

结论：对完整商业混音做多轨转录，2026 年仍只能产出**草稿级**结果（鼓、贝斯较可辨，键盘与吉他和弦不可信）。
可以用它补「和弦 / 节奏 / 段落」层面的统计，**不要**用它学配器与声部进行。

## 法律边界（务必读）

- 本项目只做**本地研究/学习**用途；原始文件与派生语料不随产品分发。
- **日本**：著作権法第 30 条之 4 对「情報解析」目的的使用相对友好，但附有「不得不当损害权利人利益」的但书，且纯粹「欣赏表达」不在其内。文化庁 2024-03-15《AI と著作権に関する考え方について》为官方解释。
- **中国**：《著作权法》第 24 条合理使用不含机器学习专门条款；《生成式人工智能服务管理暂行办法》第 7 条要求训练数据来源合法。本地研究风险低，商业化则没有明确豁免。
- 抓取来的 MIDI 多为他人对版权作品的转录：**个人分析可以，再分发不行**。保留采集台账（来源 URL、许可、抓取时间）。

## 画像被谁消费

画像写进 `data/corpus/profiles/<风格>.json` 后，**服务端会自动加载**（`apps/server/src/style/profileStore.ts`，5 秒缓存），用在三个地方：

| 消费方 | 用法 |
| --- | --- |
| 生成器（`packages/core/src/generators`） | 和弦进行从语料 bigram 采样；密度按角色音符数缩放；力度按语料均值校准；用户没设 swing 时用语料的律动比例 |
| 演奏层人性化（`style/humanize.ts`） | 用**语料的力度方差与网格偏离**去抖动生成结果，而不是固定随机量 |
| Agent 提示词（`agent/prompt.ts`） | 注入一张「风格卡」（速度 / 和弦变化率 / 密度 / 高频进行…），让模型有数据锚点 |

**没有画像时所有采样回退到中性值，行为与引入画像之前完全一致** —— `pnpm test:style` 用「中性画像 == 不传画像」的断言锁死。

内置风格（`rock` / `pop` / `cinematic` …）到语料画像名的映射写在 `profileStore.ts` 的 `STYLE_CANDIDATES`：

- `rock → j-rock / post-hardcore / britpop`
- `cinematic → jrpg`
- `pop → britpop`

**所以给画像起名时建议直接用 `j-rock`、`britpop`、`post-hardcore`、`jrpg`**，会被自动对应到内置风格。
