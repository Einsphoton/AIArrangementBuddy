# 轨道 M / S / R 交互规范（落地版）

> 这份文档记录本产品**已经实现**的静音 / 独奏 / 录入预备行为，以及每条规则背后的原因。
> 外部 DAW 的横向对比与来源见 [DAW_MUTE_SOLO_ARM_RESEARCH.md](DAW_MUTE_SOLO_ARM_RESEARCH.md)；
> 本文只讲「我们怎么做、为什么」。

相关实现（都是同一份真相，改一处必须一起改）：

| 位置 | 职责 |
| --- | --- |
| [`apps/web/src/lib/trackRules.ts`](../apps/web/src/lib/trackRules.ts) | 纯逻辑：三态判定、汇总、总控批量补丁、录入目标解析 |
| [`apps/web/src/store/store.ts`](../apps/web/src/store/store.ts) | `toggleMute` / `toggleSolo` / `toggleMuteAll` / `clearAllSolos` 写入路径 |
| [`apps/web/src/features/tracks/MixMasterControls.tsx`](../apps/web/src/features/tracks/MixMasterControls.tsx) | 总控三件套（轨道列表 + 混音器共用） |
| [`apps/web/src/features/tracks/TrackRow.tsx`](../apps/web/src/features/tracks/TrackRow.tsx) | 轨道头 M / S / R |
| [`apps/web/src/features/tracks/MixerPanel.tsx`](../apps/web/src/features/tracks/MixerPanel.tsx) | 混音器通道条 M / S + 总控 |
| [`apps/web/src/features/arrangement/ArrangementView.tsx`](../apps/web/src/features/arrangement/ArrangementView.tsx) | 编曲车道按三态变暗 |
| [`apps/web/src/features/status/StatusBar.tsx`](../apps/web/src/features/status/StatusBar.tsx) | 状态栏常驻「M n / S n」计数 |

---

## 1. 三个标志位互相独立，永不互斥

工程里只存三个布尔量：`track.mute`、`track.solo`，以及 UI 层的 `armedTrackId`。

**不做的事**（这些都是被用户明确抱怨过的实现）：

- 点 S 不自动清 M；
- 点 M 不自动退出 S；
- solo 时**不**去点亮别人的 M 灯。

原因：M 和 S 表达的是两件不同的事——「这条轨我要不要它出声」和「我现在只想听这几条」。
把它们做成互斥状态机，用户按一圈之后就会发现自己的静音设置全乱了，而且「两个都关不掉」。

（Studio One / Cubase 用户社区里对「点 S 清 M」和「M/S 像解谜」的抱怨是长期存在的。）

## 2. 「按 S 要不要把其它轨 M 掉」——不要

这是本产品的明确答案，也是用户最初提的那个问题的答案。

正确的做法是**运行期派生**「隐式静音」，而不是把别人的 `mute` 写回工程：

```
soloActive      = 任意 track.solo
显式静音        = track.mute                      → 写回工程，可持久化
隐式静音        = soloActive && !track.solo      → 只计算，绝不写回
audible         = !track.mute && !隐式静音        → mute 优先于 solo
```

代码里就是 [`trackAudibility()`](../apps/web/src/lib/trackRules.ts) 返回的三态：
`'audible' | 'muted' | 'implicitly-muted'`。

判据（单测与真实浏览器验收都在验这条）：

- `soloTogglePatch()` 产出的补丁**只带 `solo`**，一条都不带 `mute`；
- 独奏前先给某轨显式静音，独奏 → 清空独奏之后，那条轨**仍然是静音**；
- 独奏之后全工程 `mute === true` 的轨道数**必须不变**。

如果我们真的去 M 掉别人，取消独奏时就必须「猜」哪些原本是静音的——FL Studio 为此专门
保留了一个 `Restore previous state after solo` 开关来修补这个坑，我们直接不踩。

## 3. 视觉上必须分得清「静音」和「被压住」

用户分不清这两者的直接后果是：「我什么都没动，怎么就一个轨有声？」→ 以为音频坏了。

| 状态 | 轨道头 M 灯 | 轨道名 | 编曲车道 | 状态栏 |
| --- | --- | --- | --- | --- |
| 正常出声 | 无 | 正常 | 正常 | `M 0 · S 0` |
| 显式静音 | **实心红**（danger/25 填充） | 变灰 + 删除线 | `opacity .45` + 去饱和 | `M n` 高亮，可点 |
| 被独奏压住 | **描边红**（只描边不填色） | 只变灰，**不划掉** | `opacity .60` + 轻度去饱和 | `S n` 高亮，可点 |

编曲车道用 `data-mix-state` 暴露状态，`data-implicit-mute` / `data-track-mute`
分别标记两种 M 显示，自动化可以直接断言「派生静音没有把 M 灯实心点亮」。

## 4. 总控三件套（用户提的第 1 条需求）

常驻在**轨道列表顶部**（与标尺同高那一行）和**混音器标题栏**，同一组件两处挂载：

| 控件 | 常态 | 有活动状态 | 单击 | 无障碍标签 |
| --- | --- | --- | --- | --- |
| **M** | 灰 + `0` | 红 + `M n` | 已全静音 → 全部取消；否则全部静音 | `M：全部静音…` |
| **S** | 灰 + `0`，禁用 | 金 + `S n`（**永远带数字**） | 清空全部独奏（不动任何 mute） | `S：清空全部独奏…` |
| **R** | 灰 + `0`，禁用 | 红 + `1` | 取消录入预备 | `R：取消录入预备…` |
| **复位** | 灰 | — | 静音 / 独奏 / 录入预备一起清零 | `复位全部静音与独奏状态` |

设计要点：

1. **必须先有数量**：深色主题下只有一个颜色点非常容易漏看；`data-count` 也便于自动化。
2. **S 不做「全部独奏」**：现实中没人需要一键独奏全部轨道，这只会增加误触面。
3. **一次撤销**：总控批量写入走 `applyFlagPatches()`——先 `pushHistory()` 再 `history:false` 写入
   再标脏，所以撤销栈里是**一条**「全部静音」，而不是 24 条单轨记录。
4. **必须标脏**：`history:false` 的写入不会自动标脏，历史遗留 bug 就是「静音后不会被自动保存」；
   `applyFlagPatches` 统一补了 `setSaveStatus('dirty')`。
5. **状态栏常驻计数**：`S n` / `M n` 在底部始终可见，点一下就是一键清空——这是「以为音频坏了」
   最便宜的解法。

## 5. 独占独奏：`Alt/Option` + 点击 S

- **普通点击** = 累加（可以多条同时独奏）。这是 Logic / Cubase / Studio One / REAPER / Pro Tools 的默认。
- **`Alt/Option` + 点击 S** = 独占：清空其它独奏，只留这条。
- 对「当前唯一在独奏的那条」再 `Alt` 点击 = 退出独奏（Logic 的 `Option` 语义）。

**语义必须写进 tooltip。** 没有任何一个修饰键在各大 DAW 里语义一致：
`Alt+click Solo` 在 Logic / Studio One 是「独占」，在 Cubase 是「Solo Defeat」。
所以我们不赌用户的心智模型，直接写出来。轨道头、混音器通道条两处行为完全一致。

右键菜单和命令面板也提供「独占独奏」「清空全部独奏」，键盘党与鼠标党都能到达。

## 6. R：录入预备

- 同时只预备一条（`uiStore.armedTrackId`），因为 MIDI 键盘只有一个输入路由，
  「弹一个键到底该落到哪条轨」必须是唯一的。
- R 只负责「预备」；真正开始写入由 MIDI 录入开关（`R` 快捷键 / 走带录音键）控制——
  两段式，与 Logic / Cubase / Studio One 一致。
- 预备时同步 `focusedTrackId`：否则会出现「预备了 A 轨、钢琴卷帘盯着 B 轨」。
- 预备了但**录不进去**的情况必须如实说：没开录入 / 不在钢琴卷帘 / 轨道没有可录片段。
- **`armed + 静音 / 被压住` 是经典陷阱**（音符录进去了但监听听不到，用户以为没录上）：
  轨道头为此专门给一行 `⚠ 已预备但静音 · 录进去也听不到`，预备时也会 push 一条提示。
- 删除轨道会把 `armedTrackId` 一并清掉（`done` 在 store 的 `removeTrack` 之外由总控 R 兜底），
  避免「幽灵预备」导致按录音时凭空多出空轨。

## 7. 快捷键

| 键 | 作用 | 说明 |
| --- | --- | --- |
| `M` | 静音 / 取消静音**选中**轨道 | 命令面板 `track.mute` |
| `S` | 独奏 / 取消独奏**选中**轨道 | 命令面板 `track.solo`；`Alt+S` 独占 |
| `R` | 开 / 关 MIDI 录入 | 走带层面的录音开关，不是 arm |
| `C` | 节拍器 | **从 `M` 改到 `C`** |
| `L` | 循环 | |

**节拍器为什么要从 `M` 挪走**：`M` / `S` / `R` 是轨道头三件套的通用字母键
（Logic 用 `M`/`S`，Cubase 与 Studio One 同样），如果 `M` 还兼节拍器，用户想静音一条轨
结果打开了节拍器——这是纯粹的自伤。Cubase / Studio One 的节拍器是 `C`，覆盖专业编曲主力人群。

所有单键命令在文本输入框获得焦点时都不触发（否则给轨道改名会顺手静音）。

## 8. 导出与引擎

- 引擎（[`engine.ts`](../apps/web/src/audio/engine.ts)）、离线渲染（[`render.ts`](../apps/web/src/audio/render.ts)）、
  电平表（轨道列表 / 混音器）、MIDI 导出、编曲视图，**全部**调用 `computeAudibleTrackIds()`
  或 `trackAudibility()`——不允许出现第二份 `anySolo` 内联实现。
- 混音层的静音走独立的 `muteGain`（0.02s 过渡），并且 send 随可听性归零，
  否则静音轨的混响 / 延迟尾巴会漏出来。
- 导出对话框的「包含静音轨」勾选会把 `mute/solo` 一起清掉再渲染（用户显式要求绕过混音状态）。

## 9. 明确不做的事（以及为什么）

| 不做 | 原因 |
| --- | --- |
| solo 时改写其它轨的 `mute` | 破坏性，取消独奏后无法还原用户原本的静音意图 |
| M / S 互斥 | 用户会迷失在「两个都关不掉」的状态里 |
| 「全部独奏」按钮 | 没有现实使用场景，只增加误触面 |
| 全局 `solo-safe` 标志位 | 当前没有 return / aux 总线，master 不是 `Track`，暂无需要；等引入总线再加 |
| dim solo（只压低 -12dB 而非静音） | 二值 solo 已覆盖主流工作流，留作后续设置项 |
| 录音时自动解除 mute | 破坏性，改为在轨道头给出 `armed but muted` 警告 |

---

## 10. 验收清单

自动化（`node scripts/test.mjs --unit-only`、`UI_SKIP_BUILD=1 node scripts/verify-ui.mjs`）覆盖：

- [x] 三态判定：`muted` / `implicitly-muted` / `audible`，mute 优先于 solo
- [x] `soloTogglePatch` 只产 `solo` 补丁，绝不带 `mute`
- [x] Alt 独占独奏只留一条；对唯一独奏轨 Alt 点击 = 退出
- [x] 清空独奏 / 全部静音补丁幂等
- [x] 真实浏览器：按 S 后其它轨的 `mute` 数量不变，清空独奏后原有静音恢复
- [x] 真实浏览器：总控 M 一键全静音、再点全部取消，计数同步
- [x] 真实浏览器：总控 S 清空独奏且不改 `mute`，有独奏时不再禁用
- [x] 真实浏览器：被压住的车道 `data-mix-state="implicitly-muted"` 且 opacity < 0.95
- [x] 真实浏览器：被压住的轨 M 灯是描边（`data-implicit-mute`），不是实心（`data-track-mute`）
- [x] 源码级不变量：节拍器 = `C`，`M`/`S` = 静音/独奏；总控两处共用同一组件
