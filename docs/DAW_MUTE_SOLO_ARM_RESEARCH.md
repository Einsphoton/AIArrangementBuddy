# 轨道头 M / S / R 按钮交互约定研究

> 面向产品/前端工程师：设计轨道头（track header）上的 **Mute（M）/ Solo（S）/ Record-Arm（R）** 三个按钮时，
> 如何让 Logic Pro、Cubase/Nuendo、Ableton Live、Studio One、REAPER、Pro Tools、Bitwig、FL Studio 用户都"上手即用"。
> 本文只做知识梳理，不涉及本仓库代码。

**置信度标记**：`（已核）`= 有官方手册/官方帮助页原文支撑；`（社区）`= 多方用户/教程一致描述；`verify` = 记忆或推断，落地前需实测。
平台写法：`Win: Ctrl / Mac: Cmd`；修饰键统称 `Alt/Option`。

---

## 0. 核心模型：三个独立标志位，不是互斥状态机

```
muteFlag      用户显式静音（持久化，进工程文件，可被自动化）
soloFlag      用户显式独奏（持久化）
soloSafeFlag  免于被他人 solo 静音（持久化）
armed         录音就绪（持久化）

soloActive      = any(track.soloFlag)
implicitlyMuted = soloActive && !soloFlag && !soloSafeFlag    ← 运行时派生，绝不写回
audible         = !muteFlag && !implicitlyMuted              ← mute 优先于 solo
```

三条直接决定 UI 的推论：

1. **mute 优先于 solo**：既 Mute 又 Solo 的轨道应当**无声**。把 M/S 设计成互斥（点 S 自动取消 M）会在"只想让这条暂时闭嘴"时制造意外。
2. **`implicitlyMuted` 绝不能写回 `muteFlag`**（非破坏性）。FL Studio 专门提供 `Restore previous state after solo` 设置（已核），就是为了兼容老式"把别人的 M 灯真的点亮"的实现。
3. **Mute ≠ 停用轨道**。Bitwig 明确区分 `Mute`（静音，仍处理、仍走侧链）与 `Deactivated Track`（停用，不处理、可被视图开关隐藏）（已核）。若两者都要，绝不可共用一个按钮循环切换。

---

## 1. Mute 语义

### 1.1 各 DAW 的 Mute 控件形态

| DAW | 控件形态 | 命名 | 关键差异 |
|---|---|---|---|
| Logic Pro | 轨道头 `M` + Channel Strip `M` | Mute | 两处是同一状态（社区） |
| Cubase / Nuendo | Track List `M` + MixConsole `M` | Mute | 与 `S` 并列通道条顶部 |
| Ableton Live | 圆形 **Track Activator** 开关（不写字，显示轨道序号） | Track Activator | 语义是"输出激活"，实际承担 mute（已核）。可发现性差是历史槽点 |
| Studio One | 轨道头 `M` + Console 通道 `M` | Mute | **轨道 M ≠ 通道 M**：静音乐器*轨*会连乐器一起停，静音*通道*才是静音音频（社区，高频困惑点） |
| REAPER | TCP / MCP `M` | Mute | 另有 Mute Envelope 自动化包络 |
| Pro Tools | 通道条 `M` | Mute | SIP 模式下被 solo 顶掉的通道 mute 显"透明红"（社区） |
| Bitwig | 轨道头 / 通道条 `Mute` | Mute | 与 `Deactivate` 分离（已核） |
| FL Studio | Mixer Track 的 Mute LED | Mute | **没有独立 Solo 按钮**：右键 Mute = Solo（已核） |

**Mute × Solo 交互**：已 solo 的轨再点 M → 该轨静音、solo 标志保留、其它轨仍被隐式静音（少数实现会退出 solo 或让 M 失效 `verify`）；已 mute 的轨再点 S → 该轨仍无声但 S 灯亮（Cubase 用户报告过"M 和 S 同时亮而不是互相切换"的困惑，社区）；整组/总线被 solo → 组内成员按组传播，return/效果轨通常自动 solo-safe（Pro Tools 是反例，见 §2.3）。

### 1.2 全局 mute all / unmute all

| DAW | 命令（近似名） | 触发 | 置信度 |
|---|---|---|---|
| Logic Pro | `Mute off for all` | `⌃⌥⌘M` | 社区，按键 `verify` |
| Cubase | MixConsole `Functions` 菜单里的 Mute/Deactivate 类命令 | 菜单 / Key Commands | 命令名 `verify` |
| Ableton Live | 无内置 mute-all；`F1…F8` 逐个切前 8 轨 Track Activator | 按键或 Key Map | 已核（F1–F8 行为） |
| Studio One | `Mute Clear`（M）按钮，轨道列表左下角 | 鼠标 / `Global Mute` | 社区 |
| REAPER | Action `Track: Mute all tracks` 一类 | Actions List 自行绑定 | 社区 |
| Pro Tools | 无 `Mute All` 语义；靠 Group 或自定义 | — | `verify` |
| Bitwig | 无全局 mute-all 命令 | — | `verify` |
| FL Studio | `Ctrl+右键` Mute 图标 = **Unmute All** | 鼠标 | 已核 |

### 1.3 Arrange 视图 vs Mixer 视图

- 共识：**同一条轨道的 mute 是单一状态**，Arrangement 轨道头与 Mixer 通道条只是两个入口（Logic 用户明确描述两者等价，社区）。
- 必须避免：只在 Mixer 显示 solo / 被抑制状态，Arrange 轨道头完全看不出——这是"为什么没声音"的第一大来源（见 §6）。
- Ableton 的 Arrangement 视图在轨道头之外另有 `Track Controls` 折叠区（已核），用户易误判"混音器开关和编曲区开关不是一回事"——不该模仿这种双入口。

---

## 2. Solo 语义

### 2.1 累加 vs 独占：默认值本身就是分歧点

| DAW | 默认 | 独占（exclusive）方式 | 累加（additive）方式 |
|---|---|---|---|
| Logic Pro | 累加 | `Option`+click Solo | 直接点下一条（默认即累加） |
| Cubase / Nuendo | 累加 | `Ctrl`(Win)/`Cmd`(Mac)+click Solo（已核） | 默认 |
| Ableton Live | **独占**（Exclusive Solo 默认开） | 默认行为 | `Ctrl`/`Cmd`+click，或关掉 Exclusive Solo（已核） |
| Studio One | 累加 | `Alt`/`Option`+click Solo（社区）；或 `Solo Mode`: `Radio solo` / `Solo Follows Selection` | 默认 |
| REAPER | 累加（solo in place） | `Ctrl+Alt`+click Solo（社区） | 默认 |
| Pro Tools | 累加，模式可切 | 非修饰键，而是 `Options > Solo Mode` 里的 `X-OR` / `Latch` 等（模式名已核） | SIP 下多选并点 |
| Bitwig | 累加 | Settings › Behavior › `Exclusive Solo`（已核） | 关掉该选项；`Shift`+click 强制"相反行为"（已核） |
| FL Studio | 累加 | `Ctrl`+click 或 `Alt`+click Mute 图标（已核；但手册同时把 `Alt+左键` 描述为"solo 连同其上下游路由"，**文档自相矛盾，需实测**） | 逐条修饰键点击 |

**结论**：没有跨 DAW 一致的"独占"修饰键——`Alt/Option` 与 `Ctrl/Cmd` 各占一半。
最优解：普通点击 = 切换累加；`Alt/Option`+click = 独占（清空其它）；另给设置项 `Exclusive Solo`（Ableton/Bitwig 风格），打开后修饰键语义反转——这正是 Bitwig 用 `Shift` 做"反向"的原因（已核）。

### 2.2 Solo clear / clear all solos

| DAW | 命令 | 说明 |
|---|---|---|
| Logic Pro | `Solo off for all`（`⌃⌥⌘S`）、`Clear/Recall Solo`（可恢复上次组合） | 帮助页：`Option`+click 任一已激活 Solo 会取消所有通道 solo（已核） |
| Cubase | `Deactivate All Solo` 类命令（MixConsole Functions / Key Commands） | 命名 `verify` |
| Ableton Live | 无专用命令；再按 `S` 或自建 Key Map | 已核（快捷键表无此项） |
| Studio One | **`Solo Clear`** 按钮（轨道列表左下，紧邻 `Mute Clear`）；`Global Solo` = `Cmd/Ctrl+Shift+S`，会记住上次 solo 组合（社区） | 最佳实践参考 |
| REAPER | `Track: Unsolo all tracks` 等 Action | 社区 |
| Pro Tools | `Clear Solos`（可指派到软键） | 社区 |
| Bitwig | 无专用命令 | `verify` |
| FL Studio | 再点一次已 solo 的轨；`Ctrl+右键` Unmute All（不解除 solo） | 已核，不完全等价 |

### 2.3 Solo-safe / Solo defeat（"solo 也打不哑我"）

| DAW | 术语 | 手势 | 视觉 |
|---|---|---|---|
| Logic Pro | **Solo Safe** | `Control`+click 未激活的 Solo | Solo 按钮上出现**红色斜杠**（已核） |
| Cubase | **Solo Defeat** | `Alt/Option`+click Solo，或长按 Solo（已核） | Solo 按钮异色 |
| Pro Tools | **Solo Safe** | `Cmd`(Mac)/`Ctrl`(Win)+click；`Shift+Cmd/Ctrl`+click = 对所选全部（已核） | Solo 按钮变暗 |
| REAPER | **Solo Defeat** | 每轨标志位 + 鼠标修饰键/右键菜单 | 社区 |
| Studio One | 总线/输出上的"保护"solo | 右键 Solo | `verify` |
| Ableton Live | **无 solo-safe 概念**；替代品是 `Solo in Place` 选项与 Cue 模式 | — | 已核（手册只给这两个机制） |
| Bitwig | `Solo as Cue`（solo 变成耳机试听） | 右键 Solo | 已核 |
| FL Studio | `Shift`+click Mute = `Lock/Unlock State`（锁定不被 solo 影响） | 已核 | |

> **产品建议**：return / aux 与 master 总线**默认应当 solo-safe**。否则新手 solo 一条人声就"整首只剩干声、混响消失"，会误判混响坏了。Pro Tools 的 Aux solo 问题是被抱怨最多的实现（见 §6 第 6 条）。

### 2.4 隐式静音：**不翻转别人的 M 灯**（共识）

FL 的 `Restore previous state after solo` 就是为兼容旧式翻转行为而存在（已核）。各家非破坏性表达：

- **Logic / Cubase / Studio One / Bitwig**：通道整体变暗、失焦，M 灯保持原状（样式细节 `verify`）。
- **Ableton**：轨道变灰；**组轨内含被 solo 成员时组 Solo 呈半填色**（已核，层次化 solo 的漂亮解法）。
- **Pro Tools**：SIP 下其它通道 Mute 呈**透明红**（社区）——"像被 mute，其实是 solo 派生"，是反面教材。
- **REAPER**：通道变暗；可选 `Solo in front`（见 2.5）。

### 2.5 Solo in place vs Solo bus（SIP / AFL / PFL）与 dim solo

- **Solo in place (SIP)**：把其它轨"就地"静音，监听仍走原路由（含发送与总线处理）。最常见、最符合直觉。
- **Solo bus / AFL / PFL**：被 solo 的信号送到独立 solo 总线监听，**不动其它轨**。Pro Tools 三种全给（已核），适合"不想改变乐手听到的混音"。
- **Cue**（Ableton / Bitwig）：solo 变耳机试听，需额外物理输出（Live 需 ≥4 路输出，已核）。
- **Solo in front / dim solo**（REAPER）：不静音，只把其它轨压低固定 dB（社区）。唯一"非二值"的 solo。
- Ableton 细节：`Solo in Place` 是 Solo 右键菜单选项，开启后 solo 一条 clip 轨不会压掉返回轨（已核）。

> 建议：MVP 只做 SIP 二值 solo，但把 `dim solo`（如 -12 dB）作为设置项预留——它是"以为音频坏了"类抱怨的低成本解药。solo 状态须在**三处同时可见**：① 轨道头 S 点亮 + 非 solo 轨明显变暗（不要只改 1px 边框）；② 全局聚合 `S` 徽标带 **solo 数量**，hover 列出轨道名；③ 母带输出区持续提示（如 `2 tracks soloed · Clear`）。

---

## 3. Record-Arm 语义

### 3.1 单一 vs 多轨

| DAW | 默认 | 独占方式 | 备注 |
|---|---|---|---|
| Logic Pro | 多轨可同时 armed | 无统一独占修饰键 | `R` 同时是走带录音键，易混 |
| Cubase | 多轨 | 存在 "exclusive record enable" 类偏好 `verify` | 录音键在走带区（数字键盘 `*` `verify`） |
| Ableton Live | **独占**（Exclusive Arm 默认开） | 默认 | `Ctrl`/`Cmd`+click 可多选；关掉 Exclusive Arm 后自由多选（已核） |
| Studio One | 多轨 | 右键/偏好 `verify` | `R` 也可用于 record |
| REAPER | 多轨 | — | 手册有 `Auto arming tracks` 章节（已核存在） |
| Pro Tools | 多轨（无独占概念） | — | 惯用 Shift 范围选择后统一 arm |
| Bitwig | 多轨 | — | Settings › Recording 可设"选中即 Auto-Arm 的轨道类型"（已核） |
| FL Studio | Mixer Track 各自 arm | — | 右键 arm = 带文件命名选项的 arm（已核） |

**Ableton 的隐式联动**：开启 Exclusive Arm 时，向新建/空 MIDI 轨插入乐器会自动 arm 该轨（已核）。这类隐式 arm 必须可关，否则用户会在没准备时录进东西。

### 3.2 Arm 与 Mute 的交互

- 主流允许"**armed + muted**"共存：录音仍写入（arm = 允许录，mute = 不监听/不回放），但用户听不到，极易以为没录上。→ armed 且 muted 时轨道头应给明确组合提示（R 亮 + M 亮 + 一行 `armed but muted` 微文案）。
- `verify`：少数 DAW 在 arm 时自动解除 mute——不要默认采用，破坏性太大。

### 3.3 删除轨道 / 状态残留

- 轨道删除后其 arm 必须随之消失；**不得**留下"幽灵 arm"导致按录音时凭空多出空轨。常见 bug 源：轨道删了但 Mixer 通道还在（FL 的 Playlist 轨与 Mixer Track 本就不绑定，已核）。
- 建议提供 `Disarm All` / `Arm None` 显式命令。REAPER 有 `ClearAllRecArmed` API（已核其存在），但多数 DAW 并无对应 UI 命令。

### 3.4 Arm 与全局录音键：标准两段式

**先 arm 轨道，再按走带录音。**

| DAW | 走带录音键 | Arm 键 |
|---|---|---|
| Logic Pro | `R`（transport） | 点轨道头 `R` |
| Ableton Live | `F9`；`Shift+F9`（Arrangement）；`Ctrl/Cmd+Shift+F9`（Session）（已核） | `C` = Arm Selected Tracks（已核） |
| Cubase | 数字键盘 `*` `verify` | 点 `R` |
| Studio One | `R` / 数字键盘 | 点 `R` |
| REAPER | `Ctrl+R` `verify` | `verify` |
| Pro Tools | `Cmd+Space` / `F12` `verify` | 点 `R` |
| Bitwig | `Ctrl/Cmd+R` `verify` | 点 `R` |
| FL Studio | `R` `verify` | Mixer 上的 arm 开关（已核） |

> 设计要点：全局 Record 在**没有任何 armed 轨**时应禁用、或点击后提示"先 arm 一条轨"；按下后要有明确"正在录第 N 轨"的反馈。

### 3.5 MIDI vs Audio arm，以及与 monitoring 的关系

- **MIDI arm 语义更强**：它同时决定"键盘 MIDI 输入路由到哪条轨"，所以多数 DAW 倾向单轨独占（用户弹一个键盘，声音必须能确定落在一条轨上）。**Audio arm** 更多是"这条通道的输入会写入文件"，多轨同时 arm 是常态（鼓组多麦）。
- 所以"arm 独占"更适合作为 **MIDI 轨默认 / Audio 轨可选**，而非全轨统一。
- **arm ≠ monitoring**：Ableton 每轨有独立的 `In / Auto / Off` 监听选择器（已核）。UI 上必须把 R（arm）与喇叭（monitor）分成两个控件，否则用户无法排查"有信号但听不到"。

---

## 4. 全局 / 母带区的 M-S-R 聚合控件（强烈建议实现）

这是最能一次性消灭"以为音频坏了"的设计。建议固定在轨道列表底部或顶栏：

| 控件 | 常态 | 有活动状态 | 单击 | 修饰键 / 右键 |
|---|---|---|---|---|
| **M**（Mute All） | 灰 | 高亮 + `N muted` | 全部静音 | 再点 = 全部解除；右键 = 列出已静音轨 |
| **S**（Solo Clear） | 灰 | 高亮 + **solo 数量**（如 `S 2`），hover 列出轨道名 | 清空全部 solo（不做别的） | `Alt/Option`+click = 只保留本轨（创新点，无现成先例） |
| **R**（Arm Clear） | 灰 | 红色 + `N armed` | 全部解除 arm | 右键 = 列表 |

先例与教训：Studio One 把 `Mute Clear` / `Solo Clear` 做成轨道列表左下角两个小按钮（社区），被用户当作"混音救星"（"mute/solo 关不掉 → 点左下角全局按钮"）；Logic 有对应全局命令但**藏在菜单/快捷键里**、无常驻按钮，是其最常踩的坑之一；Ableton 完全没有，用户只能靠第三方 Max for Live 设备（如 `futility`，社区）补 `Add to Solo` / `Unsolo all`。

**显示规则**：聚合 S 的"点亮"由 `soloCount > 0` 驱动，**并且至少显示数字**。只有颜色没有数字时，深色主题下极易漏看。

---

## 5. 键盘与修饰键映射表

### 5.1 单键命令（默认值）

| DAW | Mute | Solo | Record-Arm | Metronome / Click | Record（走带） |
|---|---|---|---|---|---|
| Logic Pro | `M` | `S` | 点轨道头 `R` | **`K`**（`Shift+K` = Count In） | `R` |
| Cubase | `M` | `S` | 点 `R` | **`C`** `verify` | 数字键盘 `*` `verify` |
| Ableton Live | `0`（deactivate 选中）/ `F1–F8`（前 8 轨） | `S` | `C` | **`O`** | `F9` |
| Studio One | `M` | `S` | 点 `R` | **`C`** | `R` |
| REAPER | `M`（对选中轨） | `S` | Actions 内绑定 `verify` | 无单键默认 `verify` | `Ctrl+R` `verify` |
| Pro Tools | 无单键默认 `verify` | 同上 | 同上 | 无单键默认 `verify` | `Cmd+Space` / `F12` `verify` |
| Bitwig | 以自定义为主 `verify` | `verify` | `verify` | `verify` | `Ctrl/Cmd+R` `verify` |
| FL Studio | 点 LED，无单键默认 | 右键 Mute LED | 点 arm | 无单键默认 | `R` `verify` |

### 5.2 修饰键手势（同一按钮上的语义扩展）

| 手势 | 统一建议语义 | 各 DAW 先例 |
|---|---|---|
| 单击 | 切换本轨标志位（累加） | 全部 DAW |
| `Alt/Option`+click | **独占**：M/S 只留这条；R 只 arm 这条 | Logic(Option+S)、Studio One(Alt+S)、Cubase(Alt+S = **Solo Defeat**，语义不同！) |
| `Ctrl/Cmd`+click | 独占（Win 主流）或多选叠加 | Cubase(Ctrl+S = exclusive)、Pro Tools(Ctrl+S = **Solo Safe**)、Ableton(Ctrl/Cmd = 叠加) |
| `Shift`+click | 反向行为 / 锁定 / 范围选择 | Bitwig(Shift = 相反 solo 行为，已核)、FL(Shift+Mute = 锁定状态，已核) |
| 右键 | 上下文菜单（Solo Mode、Solo Safe、命名 arm） | Studio One、Bitwig、FL、Pro Tools |
| 双击 | 复位 / 清除该轨 | 无统一先例 |

> **重要冲突**：`Alt+click Solo` 在 Logic/Studio One 是"独占"，在 Cubase 是"Solo Defeat"，在 FL 手册里写作"连路由一起 solo"。**没有任何修饰键在全部 DAW 里语义一致**。因此：
> - 必须在按钮 hover tooltip 里写清本产品的修饰键语义；
> - 首次使用时给一次"多选叠加 / 独占 / solo-safe"可视化引导；
> - 不要把破坏性语义挂在修饰键上（例如 Alt+click 直接清空所有 mute）。

### 5.3 与 transport 键的冲突规避

真实冲突：`M`/`S`/`R` 已被 Logic 占为 mute/solo/record，所以**节拍器必须挪开**——Logic 用 `K`，Cubase/Studio One 用 `C`，Ableton 用 `O`。

推荐（web DAW 语境）：

1. `M` / `S` / `R` 保留给 mute / solo / arm（最广泛、最直觉）。
2. **节拍器用 `C`**（Cubase、Studio One 同为 `C`，覆盖专业编曲主力人群）；避免 `K`（Logic 专属，联想弱）。
3. **轨道头 R = arm，transport 红圆 = 录音**，两者视觉必须不同（轨道头小方块/字母，transport 大红圆），不要让 `R` 抢走带键。Logic 让一个 `R` 兼任 arm 与 record、靠焦点位置区分，是它的已知混乱源，不建议复制。
4. 所有单键命令在"文本输入框获得焦点"时必须失效（避免给轨道命名时触发 mute）。

---

## 6. 反模式与用户常见抱怨（按出现频率排序）

| # | 反模式 / 抱怨 | 真实表现 | 对策 |
|---|---|---|---|
| 1 | **"我以为音频坏了"——忘记 solo 还开着** | 播放没声音或只剩一条轨。大量求助帖（Logic "Solo not working anymore"、Studio One "Mute/Solo Function Not Working"） | 全局 S 徽标常驻 + 数量 + 一键清空 + 非 solo 轨变暗 |
| 2 | **Solo 状态只在 Mixer 可见** | Arrangement 视图完全看不出，用户在两个视图间反复找 | 两视图共享同一状态并都渲染，不留"只在一个视图能看出"的中间态 |
| 3 | **Solo-safe 设了忘记，"solo 好像没生效"** | Logic 用户报告"所有软件乐器轨 solo 图标都在闪，solo 任何一条都变成 solo 全部"，根因是 solo-safe（社区） | 显著持久标记（Logic 红斜杠是好设计）+ "清除所有 solo-safe"命令 |
| 4 | **破坏性 mute 翻转** | solo 时把别人 M 灯真的点亮，取消后静音状态全乱 | `implicitlyMuted` 只做渲染，绝不写回；提供 dim solo 替代 |
| 5 | **M / S 互斥式实现** | 点 S 自动清 M、点 M 自动清 S。Cubase 用户报告不确定感；Studio One 用户形容"通道在 mute/solo 之间来回跳，两个都关不掉，像解谜"（社区） | 三个独立布尔量 + 全局 Clear 保底 |
| 6 | **组 / 总线 solo 语义错乱** | Pro Tools：solo 一个 Aux 把它上游全静音（SIP），必须手动 solo-safe → "多少年了还是没有简单的 Aux solo"；Cubase：老用户报告"solo 一条轨不再 solo 它的所有 send" | 明确"组 solo = 组内全部 solo"；return/效果轨默认 solo-safe |
| 7 | **轨道 M 与通道 M 语义分裂（Studio One）** | 静音乐器*轨*会停掉整个乐器（多输出通道一起哑），静音*通道*才只哑这一路；"尤其有隐藏通道时会非常乱" | 若产品有双层，UI 文案必须区分（`Mute Track` vs `Mute Channel`），或只留一层 |
| 8 | **Ableton 的 Track Activator 不叫 Mute** | 新手找不到静音按钮，且它与 Solo 视觉重量相同 | 字母 `M` 直书，或用"喇叭划掉"图标 + 文案 |
| 9 | **孤儿 arm / 无 disarm-all** | 不知道还有几条轨 arm，一按录音就多出空轨 | 全局 R 徽标显示数量 + `Disarm All` |
| 10 | **armed + muted 静默陷阱** | 录了但听不到，以为没录上 | 组合状态提示；arm 时若已静音给出警告 |

---

## 7. 推荐语义

### 7.1 共识行为（照做即可"熟悉"）

1. 三标志位独立：`muteFlag` / `soloFlag` / `armed`，可同时为真，**mute 优先于 solo**。
2. **S 默认累加**；**独占走修饰键**（推荐 `Alt/Option`+click，与 Logic/Studio One 一致）。
3. **隐式静音不写回 M**；非 solo 轨用"变暗 + 全局徽标"表达。
4. **全局三件套**：Mute All / Solo Clear / Disarm All，常驻可见，S 显示数量。
5. **solo-safe** 是独立标志，带显著视觉（红斜杠式），默认施加到 return/master。
6. **arm 可累加多选**；MIDI 轨可选 exclusive arm；不做"选中即隐式 arm"（除非用户显式开启）。
7. **arm ≠ monitor**：R 与输入监听是两个控件。
8. **arm 与 transport record 分离**：轨道头 R 只 arm；无 armed 轨时禁用 Record。
9. **删除轨道即清除其 arm**；提供 `Disarm All`。
10. **修饰键语义必须写进 tooltip**（跨 DAW 完全不统一）。

### 7.2 分歧清单（产品必须二选一或给设置项）

| 议题 | 阵营 A | 阵营 B | 建议 |
|---|---|---|---|
| solo 默认累加 or 独占 | 累加：Logic、Cubase、Studio One、REAPER、Pro Tools、Bitwig、FL | 独占：Ableton | 默认**累加** + 提供 `Exclusive Solo` 开关 |
| 独占修饰键 | `Alt/Option`：Logic、Studio One | `Ctrl/Cmd`：Cubase、Ableton | 两者都接受，`Alt/Option` 为主 |
| arm 默认累加 or 独占 | 累加：Pro Tools、Logic、REAPER | 独占：Ableton | 音频轨累加；MIDI 轨可选独占 |
| solo-safe 手势 | `Control`+click：Logic、REAPER | `Alt`+click：Cubase；`Cmd`+click：Pro Tools | 用 `Ctrl/Cmd`+click（与 Pro Tools 一致，无歧义） |
| solo 视觉 | 整轨变暗 | 透明红 M 灯（Pro Tools SIP） | 变暗 + 徽标；不要"假点亮"M |
| 是否有 dim solo | 有：REAPER（Solo in front） | 无：其余 | MVP 不做，留设置项 |
| 节拍器键 | `K`：Logic | `C`：Cubase、Studio One；`O`：Ableton | `C` |
| 是否有全局聚合按钮 | 有：Studio One、FL（Mute All） | 无：Logic、Ableton、Bitwig | **必须有** |

### 7.3 实现规格（可直接落需求）

```ts
// 状态（每轨）
type TrackState = { muted: boolean; soloed: boolean; armed: boolean; soloSafe: boolean };

// 派生
const soloActive      = tracks.some(t => t.soloed);
const implicitlyMuted = (t) => soloActive && !t.soloed && !t.soloSafe;
const audible         = (t) => !t.muted && !implicitlyMuted(t);   // mute 优先于 solo

// 交互
click M/S/R              → 切换自身标志（radio 语义仅在 exclusive 模式开启时生效）
Alt/Option + click S     → 清空其它 solo，仅保留本轨
Ctrl/Cmd  + click S      → 切换本轨 soloSafe（显示红斜杠）
双击 S                   → 仅清除本轨 solo（避免误清全局）

// 显示
轨道头 S 点亮；非 solo 轨整行 opacity 0.45
全局徽标 "S n / M n / R n"（n = 计数），click = 清空对应全局状态
soloActive 时播放区常驻提示条

// 守卫
armed && muted        → 轨道头提示 "armed but muted"
Record 按钮在 armedCount === 0 时禁用

// 持久化
muted / soloed / armed / soloSafe 全部进工程文件；implicitlyMuted 绝不持久化
```

---

## 8. 参考与验证状态

**已核来源（官方手册 / 官方帮助页）**

- **Ableton Live 12 Manual** — *Mixing*（Track Activator、Solo/Arm 修饰键、Solo in Place、Cue、组轨 Solo 半填色）；*Live Keyboard Shortcuts*（`S`/`C`/`O`/`F9`/`F1–F8`/`0`）。
- **Cubase Pro Help** — *Using Solo and Mute*：`Ctrl/Cmd`+click = exclusive solo；`Alt/Opt`-click（或长按）= Solo Defeat。
- **Bitwig User Guide** — *Arrange View and Tracks* / *Mix View*（三按钮、Exclusive Solo、Solo as Cue）；*Dashboard › Behavior*（`Shift` 取反）、*Recording*（Auto-Arm）。
- **FL Studio Manual** — *Mixer*（左键 Mute / 右键 solo / `Ctrl+右键` Unmute All / `Shift+左键` Lock / `Restore previous state after solo` / arm）。
- **Logic Pro User Guide** — *Mute and solo channel strips*（`Option`+click 取消全部 solo；`Control`+click = solo-safe 红斜杠）。
- **REAPER** — ReaScript API（`ClearAllRecArmed`、`AnyTrackSolo`、`SoloAllTracks` 存在性）；REAPER 7 What's New（`m` mute 选中轨、`s` solo）。

**社区来源**（仅用于行为描述与抱怨归类，不作按键权威）：KVR、Gearspace、VI-CONTROL、Steinberg / Logic Pro Help / Reddit、Sound On Sound。

**需实测确认（`verify`）**

1. Cubase 的 `Click`（节拍器）默认键是否为 `C`；`Mute All` / `Deactivate All Solo` 的正式命令名。
2. Logic 的 `Mute off for all` / `Solo off for all` 默认组合键（`⌃⌥⌘M` / `⌃⌥⌘S`）是否仍为当前默认。
3. REAPER 的 record-arm 与 metronome 是否有出厂单键；`Solo Defeat` 的鼠标修饰键组合。
4. Pro Tools 的 `Clear Solos` 菜单位置；各版本 Solo Mode 全列表（SIP/AFL/PFL/Latch/X-OR/Momentary）。
5. Studio One 的 `Solo Mode`（Radio / Solo Follows Selection）菜单路径与 `Global Solo` 记忆行为细节。
6. FL 手册中 `Alt+左键` 的双重定义（solo vs solo-with-routing）——同一文档自相矛盾，需在软件内实测。
7. Bitwig / Studio One 的默认单键命令（两者以自定义为主，不宜断言出厂键位）。