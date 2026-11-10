# VST3 插件形态（P6-D）

> 状态：**设计 + 服务端桥接已实现并验收；插件本体是脚手架，未在本机编译**（本机没有 cmake / MSVC / JUCE）。
> 服务端侧已完成并通过真机验收：`/api/vst3/*` 桥接（`verify_vst3_bridge.mjs` 6/6）。

---

## 1. 为什么是"瘦客户端"而不是把模型塞进插件

| 方案 | 问题 |
|---|---|
| 把 acestep.cpp 直接编进 VST3 | 插件体积 2–8GB；模型加载占满 DAW 的内存/显存；DAW 崩溃会拖垮生成；每台机器都要装模型 |
| 插件内置 Python 推理 | 同上，且 DAW 里起进程不可控 |
| **瘦客户端 + 本地 Companion（本方案）** | 插件只做 HTTP + 音频输出；模型在 Companion/GPU 机器上；同一套模型被 DAW 和网页端共享；DAW 卡顿不影响生成 |

产品里已有 Companion（`scripts/companion.mjs`）与任务队列（优先级/取消/ETA），插件直接复用——**不新增第二套生成基础设施**。

```
DAW ──VST3──► BridgeClient(HTTP) ──► ArrangementBuddy server :8787 ──► Companion(GPU) ──► ACE-Step
  ▲                                                                        │
  └────────────── WAV（assetId 下载）◄─────────────────────────────────────┘
```

---

## 2. 服务端桥接接口（已实现）

| 端点 | 说明 |
|---|---|
| `GET /api/vst3/hello` | 能力协商：`bridge=vst3-v1`、支持的任务类型/变体、在线 worker 数 |
| `POST /api/vst3/generate` | 提交任务：`{ type: generate_audio \| repaint_audio \| generate_stem, params, priority }` → `{ taskId, requiredVariant, queuePosition, estimatedWaitSec, pollMs }` |
| `GET /api/vst3/tasks/:id` | 轮询：`{ id, type, status, progress, terminal, queuePosition, estimatedWaitSec, assetId?, error? }`（**只下发插件需要的字段**） |
| `POST /api/vst3/tasks/:id/cancel` | 取消排队/运行中任务（运行中由 Companion 杀引擎） |
| `GET /api/vst3/assets/:id` | 下载 WAV（响应头带 `X-Asset-Duration-Sec` / `X-Asset-Sample-Rate`）；`?peaks=1` 返回波形峰值 JSON |

参数（生成）：
```json
{ "caption": "epic JRPG battle theme, brass, timpani, distorted guitar, 168 bpm, D minor",
  "bpm": 168, "keyscale": "D minor", "durationSec": 20, "seed": 424242,
  "style": "jrpg", "adapterId": "jrpg_v2" }
```
`adapterId` 会经模型管理器校验（基座/审计不通过直接 400，不会"看起来加载了"）。

---

## 3. 插件设计

**形态**：VST3 **Instrument**（有 MIDI 输入但不必须），输出立体声。
**核心状态机**：

```
Idle → Submitting（POST generate）→ Queued（轮询，显示排队位/ETA）→ Running（进度）
     → Downloading（GET assets/:id，写入内存 AudioBuffer）→ Ready（可试听/导出）
     → Error（可读中文错误 + 重试）
```

- **参数**（DAW 自动化友好）：`prompt`（文本，非自动化）、`bpm`、`duration`、`priority`、`stem arm`（枚举）。
- **生成按钮**：点击后异步任务；不阻塞 DAW 音频线程。
- **音频输出**：`Ready` 后按工程 BPM 播放/对齐到小节；支持"拖到 DAW 轨道"（插件内导出 WAV 到用户指定路径，DAW 再导入；VST3 无法直接把音频塞进宿主轨道）。
- **状态持久化**：插件 state 存 `{ prompt, params, lastAssetId }`，工程重开可恢复提示词与参数（资产在服务端，assetId 可再下载）。
- **安全**：只允许连 `127.0.0.1`/局域网地址（可配置）；不做公网自动发现。

**为什么不做"实时流式生成"**：ACE-Step 是离线扩散，冷启动 + 生成秒级到分钟级；实时流式会把 DAW 音频线程拖死，也没有产品意义。

---

## 4. 构建前提与命令（本机未验证）

前提：
- JUCE 8（CMake FetchContent 拉取）
- CMake ≥ 3.22
- Windows: Visual Studio 2022（MSVC x64）；macOS: Xcode；Linux: gcc/clang
- **本机环境缺口**：无 cmake / cl / MSBuild / JUCE，因此本轮只交付脚手架与设计，不宣称可编译。

```bash
# 1) 配置（自动 FetchContent JUCE 8）
cmake -S plugin -B build/plugin -DCMAKE_BUILD_TYPE=Release

# 2) 构建 VST3 + Standalone
cmake --build build/plugin --config Release -j

# 产物：build/plugin/ArrangementBuddyVST3_artefacts/VST3/ArrangementBuddy.vst3
```

---

## 5. 文件

| 文件 | 作用 |
|---|---|
| `plugin/CMakeLists.txt` | JUCE 8 FetchContent + VST3/Standalone target |
| `plugin/Source/BridgeClient.h` | 零依赖 HTTP 客户端（JUCE `URL`/`WebInputStream` + JSON 解析） |
| `plugin/Source/PluginProcessor.h/.cpp` | AudioProcessor：参数、状态、任务轮询定时器、AudioBuffer 输出 |
| `plugin/Source/PluginEditor.h/.cpp` | 极简 UI：提示词、BPM、时长、优先级、生成/取消、状态与进度 |
| `apps/server/src/routes/vst3.ts` | 服务端桥接（已实现，已验收） |
| `docs/VST3_PLUGIN.md` | 本文档 |

---

## 6. 后续

1. 在装有 VS2022 + CMake 的机器上编译并跑 DAW 冒烟（Reaper/Ableton）；
2. 插件内 "生成到 DAW 轨道" 走导出 WAV + 用户拖入（或做 ARA/侧链回传，工作量大）；
3. 鉴权：局域网场景下加 shared-secret（当前服务无鉴权，已写入安全提示）；
4. 多实例并发：同一台机器多个插件实例共用服务端队列（已有优先级/ETA），不需要额外改造。