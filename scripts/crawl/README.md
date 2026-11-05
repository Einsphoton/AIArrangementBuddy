# MIDI 语料爬虫（`scripts/crawl/`）

按种子清单抓取 MIDI，**抓到就立刻过质量闸门**，产出直接接上 [语料管线](../corpus/README.md)。

> 只做本地研究用。文件落在 `data/`（已 gitignore），不进仓库、不进镜像、不分发。
> **先读 [SOURCES.md](SOURCES.md)**：哪些站能爬、哪些被 robots 明确禁止、哪些要走别的路，全是实测结论。
> 目标与上限的实测分析见 [docs/MIDI_CORPUS_STYLE_LEARNING.md](../../docs/MIDI_CORPUS_STYLE_LEARNING.md) 的 §4.0。

**一句话现状（2026-11 实测）**：你给的四条线索里，只有 **VGMusic 能直接爬**；
MidiShrine 明确 `Disallow: /`、Songsterr 拒绝机器人、Ultimate Guitar 是 ToS + 登录墙 + **Guitar Pro 格式**。
UG 那条路改走 `convert-gp.mjs`（你自己下载的 GP 文件 → 本地转 MIDI，已用真实 `.gpx` 验证通过）。

## 两条入口

```bash
# A. 爬站（VGMusic 等允许的站点）
pnpm crawl:run --seed scripts/crawl/seeds.json --style jrpg --limit 500

# B. 转换你已有的 Guitar Pro 收藏（.gp3/.gp4/.gp5/.gpx/.gp7 → MIDI）
pnpm add -D @coderline/alphatab        # 只需装一次
pnpm crawl:gp ~/Downloads/gp-tabs --out data/corpus/j-rock/gp
```


## 用法

```bash
# 1) 复制种子模板，填入你自己的站点
cp scripts/crawl/seeds.example.json scripts/crawl/seeds.json

# 2) 先干跑，只看链接不下载
pnpm crawl:run --seed scripts/crawl/seeds.json --style jrpg --limit 30 --dry-run

# 3) 正式抓
pnpm crawl:run --seed scripts/crawl/seeds.json --style jrpg --limit 200

# 4) 构建风格画像
pnpm corpus:profile data/corpus/jrpg --style jrpg
```

参数：

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `--seed` | 种子文件路径 | `scripts/crawl/seeds.example.json` |
| `--style` | 画像名，决定 `data/corpus/<style>/` 目录 | 种子里的 `style` |
| `--limit` | 最多下载多少个文件（对 dry-run 同样生效） | 不限 |
| `--max-pages` | 最多抓多少个 HTML 页面 | 200 |
| `--delay` | 同站点两次请求的最小间隔（毫秒） | 1500 |
| `--dry-run` | 只列链接，不下载 | — |
| `--verbose` | 打印每页的链接数量 | — |

## 种子文件格式

```jsonc
{
  "style": "jrpg",
  "sources": [
    {
      "name": "vgmusic-snes",                         // 来源名，决定子目录
      "startUrls": ["https://…/snes/"],               // 入口页（可以是多个）
      "follow": {
        "pattern": "^https://…/snes/",                // 正则：只在这个范围翻页
        "maxDepth": 2,
        "maxPages": 40
      }
    }
  ]
}
```

## 行为保证

| 行为 | 实现 |
| --- | --- |
| **遵守 robots.txt** | 每个 host 抓取前读 `robots.txt`，缓存 24 小时；被禁止的 URL 直接跳过并计数 |
| **限速** | 同 host 串行 + 最小间隔（默认 1.5s），自动合并 `Crawl-delay` |
| **重试** | 429/5xx 指数退避重试 3 次 |
| **断点续跑** | `data/crawl/state.json` 记录已访问页面与已下载 URL；中断后重跑自动跳过 |
| **URL 去重** | 归一化后进 Set |
| **内容去重** | 文件 sha1 去重（同一首歌的不同扒带不会被误删，只删完全相同文件） |
| **垃圾过滤** | 文件头必须是 `MThd`（或 RIFF `RMID`），HTML 错误页不会被存成 `.mid` |
| **质量前置** | 下载后立即跑 `qualityGate`：不合格的也存下来（便于事后复查），但记 `rejected` 和原因 |
| **可追溯** | 每行 `data/crawl/ledger.jsonl` 包含 `url / sha1 / 抓取时间 / 来源 / 质量判定 / 标签 / 小节数 / 调性` |

## 输出

```
data/
  corpus/jrpg/vgmusic-snes/<sha1前10位>-<原文件名>.mid
  corpus/jrpg/vgmusic-nes/…
  crawl/ledger.jsonl      # 台账：每个文件的来源与判定
  crawl/state.json        # 断点续跑状态
  crawl/.cache/           # HTTP 缓存（重跑不重复请求）
```

## 抓完先看台账，再决定要不要建画像

```bash
# 通过率
node -e "const L=require('fs').readFileSync('data/crawl/ledger.jsonl','utf8').trim().split('\n').map(JSON.parse);const ok=L.filter(x=>x.status==='accepted').length;console.log(ok+'/'+L.length, (100*ok/L.length).toFixed(0)+'%')"

# 标签分布（判断这批语料能不能用来学演奏层/配器）
node -e "const L=require('fs').readFileSync('data/crawl/ledger.jsonl','utf8').trim().split('\n').map(JSON.parse);const c={};for(const x of L)for(const t of x.tags||[])c[t]=(c[t]||0)+1;console.log(c)"
```

如果 `noDrums` 占比超过一半，说明这批基本上是**钢琴改编**，学不到配器 —— 换来源，别硬训。
