# 模型管理器：适配器（LoRA）生命周期

> 本文覆盖「训练 → 注册 → 实测 → API → 前端」全链路，以及**为什么必须校验 `mergedPairs`**。
> 相关：`docs/LORA_FINETUNING_PLAN.md`（训练方案）、`music-gen/lora-data/ab/jrpg_v1/REPORT.md`（首轮实测数据）。

---

## 0. 一句话架构

```
Python 训练（研究侧，慢但灵活）
   └─ final/adapter_model.safetensors + adapter_config.json（PEFT 目录）
        └─ register_adapter.py  →  data/adapters/<id>/（+ adapter.json 旁注）
             └─ C++ 实测加载         →  verified.json（mergedPairs > 0）
                  └─ GET /api/adapters → 前端只展示 audit.ok 的适配器
                       └─ ace-server --lora <dir> --lora-scale <s>  在推理时合并
```

**核心设计**：训练和推理是**两套运行时**，它们的适配器格式不通用。模型管理器存在的意义就是把
这个差异收敛在一个地方，而不是让每个调用点自己猜。

---

## 1. 目录与文件约定

```
data/adapters/<id>/
├── adapter_model.safetensors   # PEFT 权重（必需）
├── adapter_config.json         # PEFT 配置：r / lora_alpha（必需，用于读 rank/alpha）
├── adapter.json                # 我们自己的旁注（非 PEFT 标准）
└── verified.json               # C++ 侧实测记录（可选，但产品分发前必须有）
```

`adapter.json`：
```json
{
  "id": "jrpg_v2",
  "name": "JRPG v2",
  "styleId": "jrpg",
  "baseModel": "turbo",
  "tasks": ["text2music", "cover"],
  "license": "self-generated (ACE-Step 1.5 MIT weights); no third-party rights",
  "datasetNote": "ace-step-self-generated: 30 clips x 45s",
  "scale": 0.8,
  "training": { "steps": 4500, "epochs": 150, "finalLoss": 0.29, "bestLoss": 0.24, "seconds": 1140, "peakVramGb": 6.4 }
}
```

`verified.json`：
```json
{ "runtime": "native-cpp", "mergedPairs": 192, "at": 1762531200000 }
```

`adapter_config.json` 存在但 `adapter_model.safetensors` 不在时，扫描会**拒绝**该目录（防止只放了配置）。

---

## 2. 兼容性规则（写在 `packages/core/src/adapters.ts`）

| 规则 | 违反后果 | 校验方式 |
|---|---|---|
| C++ 运行时只支持 `lora-peft` / `lora-comfyui` | LoKR 被**静默跳过**，生成的是基线音频（不报错） | `checkAdapterCompatibility({runtime:'native-cpp'})` |
| 适配器绑死基座变体 | 换基座后效果错乱或无效 | `baseModel` 必须匹配 |
| `lego`（加轨）只能用 `base` 基座 | 加载失败或输出无意义 | `TASK_REQUIRED_BASE.lego` |
| `repaint` 只能用 `sft` 基座 | 同上 | `TASK_REQUIRED_BASE.repaint` |
| C++ 侧必须 `mergedPairs > 0` | **唯一的"静默失效"可检测信号** | `verified.json` |
| 未声明许可 | 商业分发合规风险 | `license` 字段 |

实测数据支撑（2026-11-08）：
- LoKR 单文件：载入 816 张量 → `[LoRA] Merged 0 pairs (skipped 0)` → 输出与基线不同但**不含适配器影响**
- LoRA PEFT 目录：`[LoRA] Merged 192 pairs (skipped 0)` → 生效

---

## 3. 服务端 API

```
GET /api/adapters
{
  "root": "...\\data\\adapters",
  "count": 1,
  "adapters": [{
    "id": "jrpg_v1", "name": "JRPG v1 (dry-run)", "styleId": "jrpg",
    "format": "lora-peft", "baseModel": "turbo",
    "tasks": ["text2music","cover"], "rank": 16, "alpha": 128, "bytes": 22071538,
    "verified": { "runtime": "native-cpp", "mergedPairs": 192, "at": ... },
    "audit": { "ok": true, "errors": [], "warnings": [] }
  }],
  "broken": [],
  "nativeReady": ["jrpg_v1"]
}

GET /api/adapters/:id      → 详情（含文件清单 / sha256 / scale）
```

前端只应把 `audit.ok === true` 的适配器标成"可用于产品"；`errors` 要展示给用户（而不是静默忽略）。

数据目录可用 `AIAB_ADAPTERS_DIR` 覆盖（NAS 部署时指向共享盘）。

---

## 4. 完整操作流程（明早可直接跑）

```bash
cd "D:/AI Project/AIArrangementBuddy"

# 1) 数据：放一批合法音频，规范化成训练集（强制写许可清单）
python music-gen/tools/ingest_audio.py \
  --src "D:/audio/my_jrpg_tracks" --out music-gen/lora-data/jrpg_v3 \
  --style jrpg --license "CC0-1.0" --source "OpenGameArt: <链接>"

# 2) 体检（烧 GPU 前先查数据问题）
python music-gen/tools/audit_dataset.py --dataset music-gen/lora-data/jrpg_v3

# 3) 训练（LoRA，C++ 可用的格式）
python music-gen/tools/train_lora.py --stage lora --dataset music-gen/lora-data/jrpg_v3 \
  --tag jrpg_v3 --epochs 300 --rank 32

# 4) 注册 + C++ 实测（mergedPairs>0 才会写 verified.json）
python music-gen/tools/register_adapter.py \
  --src music-gen/lora-data/out/jrpg_v3_lora/final \
  --id jrpg_v3 --name "JRPG v3" --style jrpg \
  --license "CC0-1.0" --dataset-note "ingest: N clips" --verify

# 5) 起服务看清单
node scripts/build.mjs && node scripts/start.mjs
curl http://127.0.0.1:8787/api/adapters

# 6) A/B 试听
python music-gen/tools/ab_lora.py --lora data/adapters/jrpg_v3 --tag jrpg_v3
```

---

## 5. 待办（后续）

1. **前端适配器面板**：列表 + 许可徽标 + `audit.errors` 红字 + 一键试听。
2. **云端分发**：适配器（20–40MB）比基座（2.4GB×3）小得多，适合走"云训一次、客户端拉取"。
3. **多适配器叠加**：C++ 目前 `--lora` 单路径，多风格叠加需要引擎侧支持或服务端预合并。
4. **`--lora-scale` 调参**：建议默认 0.6–0.8，1.0 容易过拟合到训练集音色。
