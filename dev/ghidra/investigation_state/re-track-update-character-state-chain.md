# UpdateCharacterState (0x0f0a) — 逆向追踪工作纸（re-1～re-9，主链见 **re-9**；**`DAT_142b249a0`** 见 §re-9 §6 与 `dat_142b249a0_global_sentinel.json`）

> **2026-09-14 格式更正（以实机调用约定为准）**：`FUN_1404f1080` 的 `param_2` 在
> case 9 调用点指向**完整 0x0f0a 包首**，而不是 characterId 之后。它从包首消费
> 22B：`0f 0a`（A0/A1）+ 8B characterId（Q0）+ 8B states/placeholder（Q1）+
> 4B gameTime（T0）。因此 H1EMU `DataSchema.pack` 生成的 22B 已是生产 wire；
> 追加 10B 得到 32B 会因严格的“无剩余字节”检查失败。下文旧的“characterId 后
> 22B/32B bridge”措辞按此更正解释。

> 与 [packet-format-mismatch.md](./packet-format-mismatch.md)、[round-6](./round-6-npc-animation-state-machine.md) 配套；有新反编译结果时更新本文。

---

## 范围备忘：22B/12B 还要查吗？`521700` 和僵尸有关吗？

| 主题 | 建议 | 说明 |
|------|------|------|
| **UCS：客户端 22B vs H1EMU 12B** | **逆向侧已收尾** | Wire **22B** 断句与 case 9 消费见 **re-1 / re-9**；与 **12B** schema 的差异、服务端如何凑 **22B** 见 **`packet-format-mismatch.md`** 与本文 §「H1EMU 打包实测」。除非要做 **服务端 pack 对齐实机** 或深挖 **A0/A1/Q0** 语义，否则**不必**再与武器 thunk 混在同一叙事里查。 |
| **`FUN_140521700` + `DAT_143c08*`** | **独立武器/战斗物品链** | **已确认**与 **`FUN_140511840` / UCS 收包无 CODE 边**。字面量多为 **开火/换弹/枪膛/投掷** 等；**僵尸通常不开枪**，不要默认「驱动僵尸动画 = 走 FIRE_LOOP/RELOAD*」。僵尸相关更应盯 **UCS → `FUN_14053d4e0` / `FUN_140526310` / `+0x620` 图参**（`DAT_142b24*` 等）。本族里 **`MELEE_ATTACK`** 仍可能对**近战武器/挥击**有意义，但**不等于**把整表套到无武器僵尸上。详见 **`dat_143c08_weapon_action_registry.json` → `scopeNote`**。 |

---

## re-1 ✅ `FUN_1404f1080` — 完整包首起 22 字节

**来源**：`PyGhidraCli DumpDecompile 0x1404f1080`（日志见 `dev/ghidra/analysis/output/DumpDecompile__0x1404f1080__*.log`）。

**签名（反编译）**  
`ulonglong FUN_1404f1080(longlong param_1, undefined1 *param_2, int param_3, char param_4)`

- `param_1`：输出结构体基址（调用方栈上局部，见下 case 9）。
- `param_2`：**指向完整 0x0f0a 包首**。反编译从 **`param_2[0]`** 起读 A0，**无**内部 `+10` 跳过包头；对生产包 A0/A1 就是 `0f 0a`，Q0 就是 characterId。
- `param_3`：**完整包长度，应为 22**。`puVar7 = param_2 + param_3`；**`param_4 == 0`** 时末段要求 **读完 T0 后无剩余字节**。**传 32** 且 **`param_2` 为包首** 时，消费 22B 后仍 **剩 10B** → **返回失败（`RAX` 低位清 0）**。
- `param_4`：末段条件用；**case 9 调用处传入字面量 `0`**。

**读序（相对 `param_2`，小端）**

| 偏移 | 大小 | 写入 `param_1` 偏移 | 说明 |
|------|------|---------------------|------|
| 0 | 1 | +0x08 | `uint8` |
| 1 | 1 | +0x10 | 以 `(int)(char)` 形式存入（符号扩展字节） |
| 2 | 8 | +0x18 | `uint64` LE |
| 10 | 8 | +0x20 | `uint64` LE |
| 18 | 4 | +0x28 | `uint32` LE |

**合计**：22 字节。对 0x0f0a，完整包为 `[opcode 2B][charId 8B][states/placeholder/gameTime 12B]`；Q1 位于完整包偏移 10。
**注意**：中间为 **两个 QWORD**，Q1 对应 schema 尾的 states1..7 + placeholder；线上包无额外 padding。

**返回值**：末分支依赖 `param_4` 与 **剩余长度**（`param_4==0` 时须 **无尾巴**）；成功路径低位为 `1`，失败为清低位（调用方以 `cVar6 == '\0'` 判失败）。**`param_3=32` 且 `param_2` 为包首 → 必失败**（见 [ucs-4f1080-param-alignment-pyghidra.md](./ucs-4f1080-param-alignment-pyghidra.md) §3.2–3.3）。

---

## 22B 槽位模型：格式确定 vs 语义置信度

本节把 **「编排（多少字节一组）」** 与 **「每个槽在玩法/协议上的含义」** 拆开；前者来自反编译事实，后者用置信度标注，避免与 [packet-format-mismatch.md](./packet-format-mismatch.md) 中的 **RAW 测试编排** 混淆。

### 置信度图例

| 标记 | 含义 |
|------|------|
| **✅ 格式** | `FUN_1404f1080` 读法与长度无歧义 |
| **✅ 语义高** | 多源一致（反编译分支、入队侧、round-6 等）或业界常见尾字段模式 |
| **⚠️ 语义中** | 与队列参数个数/宽度吻合，但 **case 9 内实参传递未逐条跟完** |
| **❓ 语义低** | 仅长度已知；H1EMU 的 `states1..7` **无** 直接同名槽位，需抓包或跟栈 |

### 表 A — 客户端：完整包首起 22B（wire 编排 = ✅ 全确定）

| 槽位 | 偏移 | 长度 | 读法 | 写入解析输出 `param_1` |
|------|------|------|------|-------------------------|
| A0 | 0 | 1 | `uint8` | `+0x08` |
| A1 | 1 | 1 | 有符号扩展 `(int)(char)` | `+0x10` |
| Q0 | 2 | 8 | `uint64` LE | `+0x18` |
| Q1 | 10 | 8 | `uint64` LE | `+0x20` |
| T0 | 18 | 4 | `uint32` LE | `+0x28` |

**合计** `1+1+8+8+4=22`。对 0x0f0a，A0/A1 就是 opcode 两字节，Q0 就是 characterId；完整包为 `[opcode 2B][charId 8B][states/gameTime 12B]`。
**注**：`param_1` 在 case 9 为 **`&local_11a0`**；`+8/+10/…` 落到 **`local_11a8`、`local_11b0`…** 等具体栈槽，见 **re-9 §1**。线上 payload **无** 额外 padding。

### 表 B — H1EMU：`characterId` **之后** 12B（schema = ✅ 全确定）

| 槽位 | 长度 | 协议名（ClientProtocol_1080） |
|------|------|--------------------------------|
| S1…S7 | 7×1 | `states1` … `states7`（各 `bitflags` → 1B） |
| P0 | 1 | `placeholder` |
| GT | 4 | `gameTime` |

**与表 A 的关系**：表 B 位于完整包偏移 10～21，正好构成 Q1/T0；不存在 10B 缺口。

### 表 C — 语义映射（待钉）：表 A 各槽 ↔ 玩法 / H1EMU / 入队

| 表 A 槽 | 语义置信度 | 说明 |
|---------|------------|------|
| **T0**（末 4B） | **✅ 高** | **case 9 Listing**：`MOV EAX,[RBP+0x460]` → **`param_2` 指向的 DWORD** = **gameTime**（再经 `FUN_14053d4e0` 可修正）。 |
| **Q0** | **⚠️ 低** | 解析写入 **`[RBP+0x450]`**。**`FindMemoryRefsByOffset 0x450 load` 在整 `FUN_140511840` 内 0 命中**（re-9 §7）→ 对本分发器 **无读回**；实机可暂 **置 0**。 |
| **Q1** | **✅ 高（掩码侧）** | **case 9 Listing**：**`LEA R8,[RBP+0x458]`** = **&Q1** → 节点 **SET**；**`~Q1`** 入 **`[RBP+0xd8]`** → **CLEAR**；与 **`FUN_140526310`** 公式一致（re-9 §2）。 |
| **A0 / A1** | **⚠️ 低** | 解析写入 **`[RBP+0x440]`**、**`[RBP+0x448]`**。**`FindMemoryRefsByOffset 0x440/0x448 load`** 仅命中 **`[RAX+…]`**（entity），**无 `[RBP+…]` 读**（re-9 §8）→ 本路径 **无读回**；RAW 可 **`00 00`**。 |

### 表 D — RAW 测试编排（❓ 假设，非官方字段名）

与 [packet-format-mismatch.md](./packet-format-mismatch.md) 一致，便于服务端 `sendRawDataReliable` 实验：

```
[00][00]           ← 对应 A0/A1 的占位假设
[8B]               ← Q0，实验中常填 0
[7×state + 1 pad]  ← Q1 内嵌 H1EMU 式 states1..7 + 对齐字节（共 8B）
[4B gameTime LE]   ← T0
```

**说明**：仅保证 **总长度与表 A 分组一致**；**Q1 内 7+1 的排布** 为工程猜测，需实机或反编译 case 9 完整数据流验证。

### 其他 AI 解读对比（22B = [1B][1B][8B][8B][4B]）

有解读将 **整段 22B** 拆成：**1B OpCode**、**1B State Type/Flag**、**8B Entity ID (Zombie)**、**8B Target ID (Player)**、**4B float Movement Speed**。以下按 **re-1 / re-9 与 Listing** 逐项对照。

| 该解读字段 | 与本仓库结论 | 说明 |
|------------|--------------|------|
| **1B OpCode / Message ID** | **⚠️ 需按完整包解释** | 对本实机调用点，`param_2` 指向 0x0f0a 完整包首；A0/A1 读到的就是 `0f 0a`。不要把这两个字节再解释成独立的实体/目标字段。 |
| **1B State Type / Flag** | **⚠️ 可能** | 可与 **A1** 或 **A0** 对应，属「状态/模式」类；当前无直接证据，不排除。 |
| **8B Entity ID (Zombie)** | **❌ 不符** | **Entity 已在调用前由 characterId 确定**（`FUN_140511840` 的 **param_1 = entity**）；22B 前的 **8B characterId** 即用于找僵尸。22B 内 **第一个 8B（Q0）** 在 **case 9 汇编中未被读入 `FUN_14053d4e0`**（re-9 §2）；若当「Entity ID」会与「上游已用 characterId 定 entity」重复。 |
| **8B Target ID (Player)** | **❌ 不符** | **第二个 8B（Q1）** 在 case 9 中 **用作 bitmask**：**`MOV RAX,[RBP+0x458]` → NOT → CLEAR 槽**，**`LEA R8,[RBP+0x458]`** 作 **SET** 进队列，**`FUN_140526310`** 用 **`(old\|SET) & ~CLEAR`** 更新 **`entity+0x35b`**。整段是 **状态位掩码**，不是「目标玩家 ID」。 |
| **4B float Movement Speed** | **❌ 不符** | 末 4B（表 A **T0**）在 Listing 中为 **`MOV EAX,dword ptr [RBP+0x460]`**（**uint32**），写入 **param_2** 指向的 DWORD，供 **`FUN_14053d4e0`** 的 **gameTime 相关修正** 与入队首 DWORD。**未见 float 读/写**，语义偏向 **gameTime** 而非「移动速度倍率」。 |

**小结**：**格式 [1B][1B][8B][8B][4B] 一致**，但 **语义** 上：**两段 8B 在 case 9 为状态掩码（Q1 驱动 0x35b）**，**末 4B 为 uint32 gameTime**；**Entity/Target ID、float 速度** 在本次逆向链中 **无依据**，更像通用协议猜测。**Q0 与 A0/A1** 仍可保留为「状态/模式」类待查，但不建议把 22B 整段当「Entity+Target+float」用。

### 下一步（为把 ⚠️/❓ 抬成 ✅）

1. **线上/日志**：RAW 0x0f0a 对照 **Q1→0x35b** 与 **T0→首 DWORD**；A0/A1 是完整包的 opcode，Q0 是 characterId。
2. **服务端**：22B wire 直接由 schema 构造：`[opcode 2B][charId 8B][states1..7 7B][placeholder 1B][gameTime 4B]`。

---

## re-2 ✅ case 9 分发与 `param_3` 含义

**来源**：`DumpDecompile 0x140511840` 全函数（Range 1-1863）、`DumpDecompile 0x1404e4520`。

**已确认**：

- **`FUN_140511840(longlong *param_1, undefined8 param_2, longlong param_3, int param_4)`**：`param_1`=entity，`param_2`=case（`switch((int)param_2 - 1)`，故 decompile 标签 **`case 9:`**（`FUN_1404f1080`）→ **`param_2 == 10`**，**不是 9**），**param_3=buffer 指针，param_4=长度**，**原样传入**该分支并交给 `FUN_1404f1080(&local_11a0, param_3, param_4, 0)`。
- **`FUN_1404e4520`**：仅处理 case 0x18/0x1c/0x21/0x37/0x56/0x5f，**不处理 case 9**（走 default 返回 0）。故 case 9 时 **param_3/param_4 未被改写**，来自 **FUN_140511840 的调用方**。
- 进入 switch 条件：`FUN_1404e4520` 返回 0 且 **`DAT_142b19b38 != 0`**（全局非空才进 switch）。
- **调用 FUN_140511840 的引用**：均为 **DATA**（143e46630、14261ce50、1420c2000、1420eb2c0、14214e198、142151468），即通过 **vtable/跳表** 间接调用；**characterId→entity 的解析在更上层**，调用前已确定 param_1，但 x64dbg 调用点记录显示传给 case 9 的 `RBX/RDX` 是完整 0x0f0a 包首。
- **反向调用 `FUN_1404f1080`**：`QueryXref to 0x1404f1080`（`dev/ghidra/analysis/output/QueryXref__to__0x1404f1080__20260319_205357_642.log`）→ **唯一 CODE 边** **`0x1405141a0` → `FUN_1404f1080`（UNCONDITIONAL_CALL）**，落在 **`FUN_140511840` 体内**（与 case 9 的 `CALL` 一致）；其余为 DATA。**续查**：对 **各 `FUN_140511840` DATA 槽** 做「谁读此地址」或 Ghidra *References from*，追到 **以 `RDX=10`（或等价）** 发起间接调用的上层收包/分发例程。

**结论**：case 9 的 buffer/length 即上层传入 `511840` 的第三、四参并 **原样** 经 **`RBX`/`ESI` → `FUN_1404f1080` 的 `RDX`/`R8d`**。在调用点以包首传入时，长度必须是 **22**；32B 会因 parser 的无剩余检查失败。服务端因此应保持 schema 原生 22B，不做 bridge。

---

## re-521700 ✅ `FUN_140521700` 反向引用与 UCS / case 9 的关系

**来源**：`dev/ghidra/analysis/output/QueryXref__to__0x140521700__20260319_105139_881.log`、`SearchDecompile__0x140521700__FUN_140511840__15__20260319_225559_730.log`、`SearchDecompile__0x140521700__0x0f0a__15__20260319_225533_233.log`。

**已确认**：

- **`QueryXref to 0x140521700`**：共 **36** 引用 — **2 DATA**（`143e46ed0`、`14261c650`）+ **34** `UNCONDITIONAL_CALL`；**所有 CALL** 地址均在 **`0x140b5eb70 .. 0x140b5fe92`**，对应 Ghidra 命名的 **多个相邻** `FUN_140b5e*` / `FUN_140b5f*`（combat thunk 簇），**不是** `FUN_140511840` 单函数体。
- **`FUN_140511840` / `0x140514xxx` 收包区** 对 `521700` **无 CODE 调用** → **与 UpdateCharacterState（0x0f0a / decompile case 9）无直接 CALL 边**。
- **`SearchDecompile 0x140521700`**：子串 **`FUN_140511840`**、**`0x0f0a`** 均为 **Hits: 0**。

**结论**：`521700` 是 **武器/战斗离散标签 → `+0x620` / `+0x848` 等** 的共享译码层；**`FUN_140b5eb40`** 仅其中 **1** 路（**`&DAT_143c08b78` = CHAMBER_INTERRUPT**）。其余 **33** 处 `CALL` 由各兄弟 thunk 传入 **不同** `param_2` handle。详见 `chain_case30_dispatcher.json`（`recordsOverview` + `FUN_140b5eb40`）与 `chain_graph_param_writers.json`（`FUN_140521700` / `FUN_140b5eb40`）。**全量 `DAT_143c08*` 字面量与 init**：`dat_143c08_weapon_action_registry.json`（索引见 `index.json`）。

### re-521700-thunks：CALL 位点 → 包含函数（symbols 边界）

**机器可读表**：`fun_521700_caller_thunks.json`（34 行 `callSites` + 28 个入口 + **`thunkSummaryByFunc`**：每 thunk 的 `param_2` / 语义标签）。

**结构要点**：

- 同一函数体内 **多次** `CALL FUN_140521700`：**`FUN_140b5f2b0`（3）**、**`FUN_140b5ef40` / `FUN_140b5f0d0` / `FUN_140b5f230` / `FUN_140b5f4d0`（各 2）**；其余入口各 1 次。
- **✅ 已跑完**：对各入口 **`PyGhidraCli DumpDecompile`** + 对静态 `DAT_143c08*` **`QueryXref to`** → 注册写点均在 **`FUN_1401d8090`～`1401d8bb0`**；**`143c089b8`** 对应 **`FIRE_SLASH`**（`FUN_1402ee3a0(&DAT_1420bba9c)`，邻域间隙 + `DescribeAddress` 首字节 `F` 推断，见 registry `literalNote`）。**分支 thunk**：`FUN_140b5f800` / `FUN_140b5f900`（`char` 选两枚 DAT）、`FUN_140b5fe60`（透传调用方指针）见 **`dat_143c08_weapon_action_registry.json` → `branchingThunks`**。

---

## re-3 ✅ `FUN_14053d4e0` — `entity+0x1170` 入队

**来源**：`DumpDecompile 0x14053d4e0`、`DumpDecompile 0x1404eb0f0`。

**已确认**：

- **`FUN_14053d4e0(param_1, param_2, param_3, param_4, param_5)`**：先做 gameTime 相关修正（`DAT_142b19780`、`FUN_14032fd30`），再 **`FUN_1404eb0f0(param_1 + 0x1170, param_2, param_3, param_4, param_5)`** 入队，最后 **`FUN_1404e1de0(param_1)`** 通知。
- **`FUN_1404eb0f0`**（入队）：`(**(code **)(*param_1 + 0x10))()` 分配节点；将 **param_2（4B）、param_3/param_4（各 8B）、param_5（8B）** 写入节点（`*puVar2 = *param_2`，`*(puVar2+2)=*param_3`，`*(puVar2+4)=*param_4`，`*(puVar2+6)=*param_5`）；链表挂在 **param_1**（即 entity+0x1170），**param_1[3]** 计数 +1。  
  节点布局与消费者公式见 **re-9**；case 9 里 **反编译显示的 `local_1180`/`local_1178` 与解析落槽的对应关系以 re-9 + Listing 为准**。

---

## re-9 ✅ case 9：`FUN_1404f1080` 落栈、`FUN_14053d4e0` 实参、队列节点与 `0x35b` 公式

**来源**（已入库日志）：  
`DumpDecompile__0x140511840__20260319_185744_164.log`（case 9）、`DumpDecompile__0x1404f1080__20260319_184633_658.log`、`DumpDecompile__0x14053d4e0__20260319_185309_026.log`、`DumpDecompile__0x1404eb0f0__20260319_185342_888.log`、`DumpDecompile__0x140526310__20260319_190623_812.log`。

**Listing 核对（PyGhidraCli，✅）**  
- `QueryXref to 0x1404f1080` → 唯一代码调用 **`1405141a0`**。  
- `DescribeAddress 0x1405141b0` / `0x1405141dc` → **`CALL 0x1404f1080` 后紧跟 `CALL 0x14053d4e0`（`1405141f7`）** 的完整实参准备。  
- `QueryXref to 0x14053d4e0` → 另有一处 **`1405142a5`**，对应 **`FUN_1404f1170`（case 0x3f）** 路径，**不是** case 9。

### 1) `FUN_1404f1080` 的 `param_1` 与栈槽（`param_1 = &local_11a0`）

在 **`FUN_140511840`** 的变量块中，栈符号按偏移递增可排成：`… local_1180(0x1180) … local_11a0(0x11a0) … local_11b8 … local_11c0 … local_11c8 …`。  
由 **`0x11a0 + 位移 = 目标槽`** 可得解析结果落点（与 re-1 的 `+8/+10/+18/+20/+28` 一致）：

| `param_1+` | Ghidra 槽（典型） | Wire 表 A |
|------------|-------------------|-----------|
| `+8` | `local_11a8` | **A0**（1B） |
| `+0x10` | `local_11b0` 区域（`int` 写 4B） | **A1**（符号扩展字节） |
| `+0x18` | `local_11b8`（反编译常标成 `undefined **`，实为 8B 被覆写） | **Q0** |
| `+0x20` | `local_11c0` | **Q1** |
| `+0x28` | `local_11c8` | **T0**（`uint32`） |

### 2) case 9：汇编实参（`param_1 = RBP+0x438` 调 `FUN_1404f1080`，与 Ghidra `local_11a0` 同块）

**地址**：`140514199` `LEA RCX,[RBP + 0x438]` → `1405141a0` `CALL FUN_1404f1080` → … → `1405141f7` `CALL FUN_14053d4e0`。

**解析结果相对 `RCX`（= `param_1`）**（与 `FUN_1404f1080` 一致）：`+0x18`→**wire Q0**，`+0x20`→**wire Q1**，`+0x28`→**wire T0**（`uint32`）。  
即 **`[RBP+0x450]=Q0`**，**`[RBP+0x458]=Q1`**，**`[RBP+0x460]=T0`**。

**`CALL FUN_14053d4e0` 前序指令（摘录）**：

| 指令 | 含义 |
|------|------|
| `MOV RAX,qword ptr [RBP+0x458]` | 取 **wire Q1** |
| `NOT RAX` / `MOV [RBP+0xd8],RAX` | **`~Q1` 写入临时槽**（供 param_4） |
| `MOV RAX,[0x142b249a0]` / `MOV [RBP+0xd0],RAX` | 全局指针写入 **`[RBP+0xd0]`**（param_5 目标内容） |
| `MOV EAX,dword ptr [RBP+0x460]` / `MOV [RBP-0x58],EAX` | **`T0`（gameTime）→ param_2 指向的 DWORD** |
| `LEA RAX,[RBP+0xd0]` / `MOV [RSP+0x20],RAX` | **第 5 参**：栈上传 **`&[RBP+0xd0]`** |
| `LEA R9,[RBP+0xd8]` | **第 4 参**：**`&(~Q1)`** |
| `LEA R8,[RBP+0x458]` | **第 3 参**：**`&Q1`** |
| `LEA RDX,[RBP-0x58]` | **第 2 参**：**`&gameTime`**（初值为 T0） |
| `MOV RCX,R14` | **第 1 参**：entity |

→ **入队 SET = wire Q1**，**CLEAR 内存值为 ~Q1**；**首 DWORD = T0**（再经 `FUN_14053d4e0` 内可能修正）。**wire Q0 在本段汇编中未被读入 `FUN_14053d4e0`**（用途另查：A0/A1/Q0 或仅解析侧链）。

**反编译**仍常写 `local_1500=~local_1180`、`local_1630=local_1178` — 与 **Listing 上「458/460/d8」** 一致的是上表，**不以未验证的 `local_1180` 名为准**。

### 3) `FUN_1404eb0f0` 节点内存（`puVar2` 为 `undefined4 *`）

| 字节偏移 | 来源 | 含义（相对 0x1170 队列节点） |
|----------|------|--------------------------------|
| 0–3 | `*param_2` | 首 DWORD（经 `FUN_14053d4e0` 可能被改写） |
| 8–15 | `*param_3` | **SET** QWORD → 消费者 **`piVar11+2`**（`int *` 下标 ⇒ **+8 字节**） |
| 16–23 | `*param_4` | **CLEAR** QWORD → 消费者 **`piVar11+4`**（**+16 字节**） |
| 24–31 | `*param_5` | 第四 QWORD；case 9 上 **`*param_5` = `DAT_142b249a0` 当前值**（写入 **`[RBP+0xd0]`** 再取址传入） |

### 4) `FUN_140526310` 合并进 `entity+0x35b`（已核对行号）

```text
local_108 = (param_1[0x35b] | *(ulonglong *)(piVar11 + 2)) & ~*(ulonglong *)(piVar11 + 4);
param_1[0x35b] = local_108;
```

→ **语义**：`新 0x35b = (旧 0x35b | SET) & ~CLEAR`；与 **3)** 中节点布局 **逐字节对齐**。

### 5) 反编译 vs Listing（已消解）

| 原反编译表象 | Listing 结论 |
|--------------|----------------|
| `param_3=&local_1180`，SET 像 Q0 | **R8=`LEA [RBP+0x458]`** → **&Q1**（第二 QWORD） |
| `local_1500=~local_1180`，CLEAR | **R9=`LEA [RBP+0xd8]`**，槽内为 **`NOT qword [RBP+0x458]`** → **~Q1** |
| `local_1630=local_1178`，首 DWORD | **`MOV EAX,[RBP+0x460]`** → **T0（gameTime）** |
| Q0 未出现在调用前 | **wire Q0** 仍由解析器写入 **`[RBP+0x450]`**，**本路径不送入 `FUN_14053d4e0`** |

### 6) 小结（给服务端/协议）

- **确定（Listing）**：case 9 → **`0x35b` 掩码来自 `| Q1` 与 `& ~(~Q1)`**（等价于 **按 Q1 与 ~Q1 做 OR/AND 语义**，与 `FUN_140526310` 公式一致）；**节点首 DWORD 初值 = T0**。  
- **确定**：**第 4 QWORD = `DAT_142b249a0`**（经 **`[RBP+0xd0]`** 传递）。  
- **✅ 2026-03-19 钉死 `DAT_142b249a0`（PyGhidraCli）**：**`DescribeAddress 0x142b249a0`** → 该地址 **定义为 QWORD，值为 `0`**（**全局空 / 哨兵指针槽**）。**`QueryXref to 0x142b249a0`**：**132** 引用，**几乎全 READ**，覆盖 **`FUN_140511840` 区**（如 `1405118dc`）及大量状态逻辑。→ case 9 路径下 **`FUN_14053d4e0` 的 `param_5` 解引用内容 = 0**，入队节点 **最后一 QWORD 为 0**，语义为 **「无附加句柄 / 空 IString 类槽位」**，**不是** wire 里可填的「第四个 8B ID」。日志：`DescribeAddress__0x142b249a0__*.log`、`QueryXref__to__0x142b249a0__*.log`。机器可读摘要：**`dat_142b249a0_global_sentinel.json`**。  
- **待查**：**A0/A1** 语义；**wire Q0** 见 **§7**。

### 7) Q0 栈槽 `+0x450`：`FindMemoryRefsByOffset`（PyGhidraCli ✅）

**范围**：`FUN_140511840` 体 **`0x140511840` … `0x1405147f0`**（下一函数 `FUN_1405147f0` 入口前）。

| 命令 | 结果 |
|------|------|
| `PyGhidraCli FindMemoryRefsByOffset 0x450 store 0x140511840 0x1405147f0` | **1 命中**：`14051416c` **`MOV qword ptr [RBP + 0x450],RAX`**（**写 Q0**，出自 **`CALL FUN_1404f1080`** 链）。日志：`FindMemoryRefsByOffset__0x450__store__0x140511840__0x1405147f0__*.log`。 |
| `PyGhidraCli FindMemoryRefsByOffset 0x450 load 0x140511840 0x1405147f0` | **0 命中**：整函数内 **无** 操作数显式位移 **`+0x450` 的 load**。日志：`FindMemoryRefsByOffset__0x450__load__0x140511840__0x1405147f0__20260319_210731_039.log`。 |

**推论**：在本二进制里，**case 9 写入的 wire Q0（`[RBP+0x450]`）在 `FUN_140511840` 内没有任何 `...+0x450` 形式的读回**；与 **Listing 上 case 9 不读 Q0** 一致。若仍存在消费，只可能是 **别种寻址**（未见于位移扫描）或 **其它进程/版本** — 当前工程下可视为 **对本分发器路径无效字段 / 预留**。

**勿与 entity+0x450 混淆**：宽域扫描 `0x140511840..0x140520000` 曾命中 **`14051853b`** **`CALL qword ptr [R8 + 0x450]`**（**entity 成员偏移**，非栈上 Q0）。

### 8) A0 / A1 栈槽（`+0x440` / `+0x448`）：同范围扫描（PyGhidraCli ✅）

**范围**：同上 **`0x140511840` … `0x1405147f0`**。

| 位移 | store | load |
|------|-------|------|
| **0x440**（A0，`param_1+8`） | **1**：`140514151` **`MOV dword ptr [RBP+0x440],0xf`**（case 9 初值），随后 **`CALL FUN_1404f1080`** 写 **1B** 覆写该槽。 | **1**：`1405139a8` **`CALL qword ptr [RAX+0x440]`** — 基址 **RAX**（entity），**非 RBP** → **非** 栈上 A0。 |
| **0x448**（A1，`param_1+0x10`） | **1**：`14051415b` **`MOV dword ptr [RBP+0x448],0xa`**（case 9 初值），解析器再写 **4B**。 | **1**：`1405139b0` **`CALL qword ptr [RAX+0x448]`** — 同上，**RAX** = entity，**非** 栈上 A1。 |

**推论**：**栈上 A0/A1**（`[RBP+0x440]`、`[RBP+0x448]`）在 **`FUN_140511840` 内无任何以 RBP 为基址的 load**；仅 **entity+0x440/0x448** 有读（vtable/虚调用）。与 **Q0** 一致：**22B 前两字节（A0/A1）在本分发器路径无读回**，实机可填 0 或保留初值。

---

## re-4 ✅ `0x1170` 队列消费者（`0x35b`）与 **`0x8cf` 写入源（分述）**

**已做**：

- **写 entity+0x8cf 的代码**（`FindMemoryRefsByOffset 0x8cf store`）：  
  **`FUN_1404ff870`** 根据 **param_1+0xa3** 的位域，用 OR/AND 写 **entity+0x8cf**：  
  - `(param_1+0xa3)>>1 & 1` → 0x8cf 的 **bit3**（0x08，nearDeath）；  
  - `(param_1+0xa3)>>0xc & 1` → 0x8cf 的 **bit2**（0x04，hidesHeat）。  
  与 round-6 的 states6.bit2/bit3 一致。同文件中还写 0x8d1/0x8d2/0x8d6 等。**param_1+0xa3** 的来源仍需从「谁填 0xa3」或「谁调 FUN_1404ff870」上溯（可能与 0x1170 出队后经 `param_1[0x35b]` 等路径间接影响）。
- **引用 entity+0x1170 的代码**（`FindMemoryRefsByOffset 0x1170 any`）— **DumpDecompile 核对后**：  
  - **FUN_14053d4e0**：入队（`FUN_1404eb0f0(entity+0x1170,…)`）。  
  - **`FUN_140526310`**：**主消费者**。`param_1` 为 `longlong *` entity；**`param_1[0x22e]` 的字节偏移 = 0x22e×8 = 0x1170**（队列根/子结构）；循环从 **`param_1[0x22f]`** 取当前节点 `piVar11`，对节点执行：  
    `local_108 = (entity[0x35b] | *(ulonglong *)(piVar11+2)) & ~*(ulonglong *)(piVar11+4);`  
    再 **`param_1[0x35b] = local_108`**，并 **`*(byte *)(entity+0x8cd) |= 4`**；末尾按链表字段 **+8/+0x10/+0x20/+0x28** 出链，**`*(int *)(param_1+0x231) -= 1`**，与 `FUN_1404eb0f0` 节点布局一致。多处调用 **`FUN_14053d580`**（状态刷新/同步）。  
    **本函数反编译中未见直接写 0x8ca/0x8cf**；0x8cf 仍主要由 **`FUN_1404ff870`** 从 **0xa3** 驱动。  
  - **`FUN_1404f37e0`**：**实体构造/初始化**（大量 vtable、子对象、`FUN_1404f1b40(param_1+0x22e)` 等），**不是** 0x1170 出队逻辑；LEA+0x1170 对应初始化该偏移处结构。  
  - **`FUN_1404f7b30`**：**析构/清理**（排空 `param_1[0x8e9]` 等链表、`param_1[0x724]=0`），**不是** 每帧消费 0x1170 的工作循环。

**结论**：**0x1170 队列的出队与 bitmask 应用**在 **`FUN_140526310`**（合并到 **`entity+0x35b`** 大状态字，并置 **0x8cd bit2**）。**0x8cf** 的 **bit2/bit3** 仍归 **`FUN_1404ff870`**（读 **`*(uint *)(param_1+0xa3)`** 多 bit 驱动 0x8cf/0x8d1 等）。

**0xa3 写入者（FindMemoryRefsByOffset 0xa3 store，范围 0x1404–0x1406）**：仅得 **3 处**，且均为 **栈上 [RSP+0xa3]** 的 **单字节写**（MOV byte [RSP+0xa3], AL/CL）：  
- **FUN_14050c220** @ 14050c312  
- **FUN_140524f60** @ 140524ff6  
- **FUN_14053b5c0** @ 14053b682  

**DumpDecompile 核对**：三函数均为 **从 entity 读** 0x8ca/0x8cf/0x8d0/0x8d1/0x8d2 等，打包进 **栈上 buffer**（含偏移 0xa3 的字节），再传给 **FUN_1417f22e0** / **FUN_1403b4410**，属于 **entity → 序列化/发送** 路径，**不是**「谁填 entity+0xa3」的路径。  

`FUN_1404ff870` 读的是 **uint**（4 字节）@ param_1+0xa3；**entity+0xa3 的写入端**仍未在 0x1404–0x1406 段内命中，可能为：**0x35b 与 0xa3 同属一大结构**（不同偏移）、或 **0x35b 在别处被拷贝到 0xa3**、或写 0xa3 的代码在其它地址段。**✅ PyGhidra `QueryXref to 0x1404ff870`**：**0** 处 **UNCONDITIONAL_CALL**；**6** 处 **DATA**。**✅ 2026-03-20 细分**：**`143e4591c`** 落在 **RUNTIME_FUNCTION/.pdata** 区（**非**角色虚表）；**`142620320`**（**`IPToStateMapEntry_ARRAY_*`**）为 **C++ EH IP-to-State** 映射首字，**语义上也不是游戏「槽0 虚调用」证据**；**`1420c1f58` / `1420eb218` / `14214e0f0` / `1421513c0`** 为 **同源 vtable 四副本**（槽0=`FUN_1404ff870`）。示例：**`FUN_140520e20` → `FUN_1404e57d0` → `JMP [vptr+0x100]`** → **`LAB_14050bb20`**（槽32，**非**槽0）。**`142620320`**：`QueryXref to` → 仅 **`1420bec08` DATA**；**`1420bec08`**：`QueryXref to` 仍为 **0**。机器可读：**`fun_1404ff870_dataref_breakdown_20260320.json`** + **`fun_1404ff870_vtable_anchors.json`**。  
**仍待**：谁 **写 `entity+0xa3`**、谁在运行时 **经上述槽位** 调起本函数（需 Listing 跟 *References* 或 virtual 偏移）。

---

## re-5 ✅ `FUN_14053fde0` — `0x8ca` / `0x8cf` 与 `iVar13`（动画状态索引）

**来源**：`DumpDecompile 0x14053fde0`（`DumpDecompile__0x14053fde0__20260319_190623_193.log`，共 226 行）。

**语义**：每 tick 根据 **击倒字节 `entity+0x8ca`**、**战斗标志 `entity+0x8cf` 的 bit3(8)/bit2(4)**、**移动探测 `FUN_140519410`**、**高位 `param_1+0x11a`（与 `*(byte *)(param_1+0x11a)<0x80`）** 等，计算 **`iVar13`**；若与 **`param_1[0x11c]`** 不同则 **`param_1[0x11c]=iVar13`** 并虚调用 **`(*param_1+0x7e8)`**（驱动 NPC 动画/MRN 相关状态机，与 round-6 一致）。

**分支表（与 round-6 对照）**

| 条件（简化） | `iVar13` |
|--------------|----------|
| 外层 guard 不满足（`param_1[0x724]` / vtable 等） | 保持 0（随后被 `FUN_140519410` 等覆盖前的初值） |
| `*(byte *)(entity+0x8ca) >= 0x80`（击倒） | **4** |
| 否则 `(0x8cf & 8)==0` 且 `(0x8cf & 4)==0`，且 `FUN_140519410` 真 | **3** 若 `*(byte *)(param_1+0x11a)<0x80`，否则 **2** |
| 否则 `(0x8cf & 8)==0` 且 **(0x8cf & 4)!=0**，且 `FUN_140519410` 真 | **7**（`(cVar8!='\0')+6`） |
| 否则 **(0x8cf & 8)!=0**（nearDeath），`FUN_140519410` 假/真 | **1** / **5** |

**说明**：开头条块里另有一个 **`iVar13`** 用于 **shared_ptr 引用计数**（lines 49–63），与后面 **line 72 起** 的动画 **`iVar13` 重算** 是 **同名不同用途**；最终以 **line 184–186** 与 **`param_1[0x11c]`** 比较为准。

---

## re-7 ✅ `FUN_14053d580` — 队列合并后的 **0x35b** 侧链（非 0x8cf）

**来源**：`DumpDecompile 0x14053d580`（仅 33 行，全函数短）。

**要点**：`FUN_14053d580(longlong param_1)` 中 **`param_1` 为 entity 基址**；条件里出现 **`*(uint *)(param_1 + 0x1ad8) >> 0xc & 1`**。  
**`0x1ad8 = 0x35b × 8`**，即与 **`FUN_140526310`** 里 **`param_1[0x35b]`** 为 **同一 QWORD**（只是反编译用「基址 + 字节偏移」写法）。

**语义（简化）**：当 **`0x8c9` bit2** 置位 **且** 上述 **0x35b 字 bit12** 为 1 **且** `(*(entity+800)+0xa8)()` 为假时，走 **`FUN_1407d7530`** 分支并 **`0x8d5 |= 0x20`**；否则若 **`0x8d5` 已有 0x20**，则 **`FUN_1407d7db0`** 并清 **`0x8d5` 的 0x20**。

**结论**：**UpdateCharacterState → 入队 → `FUN_140526310` 改 `0x35b`** 之后，**`FUN_14053d580` 是紧贴 0x35b 的消费侧之一**（音效/回调类，与 **0x8cf / `FUN_1404ff870`** 并行，不是同一条子链）。

**工具备忘**：`FindMemoryRefsByOffset 0xa3 load` 在 **`FUN_1404ff870` 体内为 0 命中**——反编译里的 **`*(uint *)(param_1+0xa3)`** 在汇编里可能被拆成 **LEA+[reg+小位移]**，位移不总是字面 **0xa3**；**实体字节偏移仍应按反编译的 0xa3 / 0x8cf 理解**，不能单靠「位移=0xa3」扫描覆盖 `FUN_1404ff870` 全部读。  
**等价手段**：对本函数用 **`PyGhidraCli DumpDecompile 0x1404ff870 resolve`**（**795 行全文**）或 **`SearchDecompile … 0xa3 …`** 枚举读点；IDE 侧 `agent-transcripts` 若搜不到字符串，以本文 + **`fun_1404ff870_vtable_anchors.json` → `equivalentInvestigation0xa3`** 为准。  
**扩大扫描（2026-03-20）**：`FindMemoryRefsByOffset 0xa3 store 0x140000000 0x140800000` 仍 **仅 3** 条 **`[RSP+0xa3]`**（与旧结论同），日志：`FindMemoryRefsByOffset__0xa3__store__0x140000000__0x140800000__*.log`。  
**`mode=any` 两段补扫**：`140400000..140600000` → **7** 命中（多为 **`[RSP+0xa3]`** + 一条 **`MOV R8D,0xa3`** 立即数）；`140600000..140800000` → **1** 命中（**`MOV ECX,0xa3`**）；**仍无** `entity+base+0xa3` 字面位移 —— **`entity+0xa3` 写入者** 不能靠位移 grep 闭合，需 Listing/`SearchDecompile`/虚表跟读。日志见 **`fun_140526310_91ee40_tick_chain.json` → appendix**。  
**全函数新知**：入口若 **`param_1[0x724]` 有效且 `!= DAT_142b249a0`** 且 **`(entity+0x35b & 1)==0`** → **直接 return**；即 **`FUN_1404ff870` 与 UCS 队列写的 `0x35b` bit0 存在门控关系**（非「只读 0xa3」一条线）。详见 **`DumpDecompile__0x1404ff870__resolve__20260320_083035_502.log`** 行 115–117（反编译行号）。

---

## re-8 ✅ 入队通知 → 全局队列 → **tick 上 `FUN_140526310`**

**`FUN_1404e1de0(entity)`**（re-3）：`FUN_14071b000(DAT_142b19b38, entity)`；第二个参数为 **entity**，第一个为 **全局 `DAT_142b19b38`**。

**`FUN_14071b000`**（`DumpDecompile`，34 行）：  
- `FUN_14032f270(global + 0x10b0)` / `FUN_14032f360`：**对 `global+0x10b0` 加锁/解锁**。  
- `(*(entity+0x20)+0xe0)()`：若返回 **0**，则：  
  - 若 **`entity+0x398` 非空** 或 **`global+0x1110 == entity`**：调用 **`FUN_140723cf0(global+0x1110, entity)`**（从 **`entity+0x398` / `+0x3a0`** 链表摘除；**`*(int *)(头结点 + 0x10)`** 计数 **-1**，反编译为 **`param_1+2`** 因 **`param_1` 为 `undefined8*`**）。  
  - 若 **`entity+0x378` 为空** 且 **`global+0x10f8 != entity`**：把 **entity** 挂到 **`global+0x10f8`～`+0x1100`～`+0x1108`** 的双向工作链表尾，**计数 +1**。  
→ 语义：**入队后向全局注册「待处理 entity」**（或先摘旧链再挂新链），供别处遍历。

**`FUN_140723cf0`**（22 行）：仅操作 **`param_2+0x398` / `+0x3a0`** 与 **`param_1` 头结点**，**摘除**并递减计数；**不**直接调 `FUN_140526310`。

**`FUN_14091ee40(entity)`**（`DumpDecompile` 12 行，`DumpDecompile__0x14091ee40__1__80__20260320_085830_839.log`）：若 **`*(char *)(entity+0x4b64) != 0`** 则 **`FUN_14046ab00(DAT_142b19780)`** 并 **`*(entity+0x4b64)=0`**；随后 **`FUN_140526310(entity)`**。  
→ **`QueryXref to 0x140526310`**：**5** 条 — **`14091ee6d` UNCONDITIONAL_CALL**（唯一直接 **CODE** 边，即本包装器体内）+ **4×DATA**（虚表）；详情见 **`fun_140526310_91ee40_tick_chain.json`**。  
→ **`QueryXref to 0x14091ee40`**：**仅 3×DATA**（`143e89710` / `14214e6f8` / `1421519c8`），**无** 直接 CALL 入边 → **tick/虚表** 调度的薄封装；仍可视为 **每帧 drain `0x1170` → 合并 `0x35b`** 的路径之一。

**`FUN_14053d9b0`**：与 **`FUN_14053d4e0` 无直接调用**；在子列表循环里若 **`bVar5`** 为真则 **`entity+0x8d5 |= 0x10`** 并 **`FUN_1404e1de0(param_1)`** —— **另一条** 触发全局通知的路径（批量子项处理），与 **case 9 → `FUN_14053d4e0` → `FUN_1404e1de0`** 并列。

**调用关系速记**：  
`FUN_14053d4e0` / `FUN_14053d9b0` 等 → **`FUN_1404e1de0`** → **`FUN_14071b000`**（全局链表）；**`FUN_14091ee40`** → **`FUN_140526310`**（出队改 **0x35b**，并间接触发 **`FUN_14053d580`** 等）。

---

## H1EMU 打包实测（与客户端 22B 对照）

- **`h1z1-dataschema`**（`node_modules/h1z1-dataschema/src/dataschema.js`）：`bitflags` 打包为 **1 字节**（按 `field.flags` 逐位 OR，**非**把多组 flags 压成一个字节以外的布局）。
- **`DataSchema.pack(ClientProtocol_1080 … Character.UpdateCharacterState)`**（默认对象、全 false）：正文 **20B**；**`characterId`（8B）之后** **12B**（states1–7 + placeholder + gameTime）。
- 客户端 **`FUN_1404f1080`**：从完整包首读取 **`1+1+8+8+4 = 22B`**；其中前 10B 正是 opcode + characterId，后 12B 与 schema 尾一致。

---

## 服务端 DevHttp（仓库可核对事实，2026-03）

以下**不是** Ghidra 结论，而是 **h1z1-server** 源码行为，便于与「无效果」实机现象对照：

| 项 | 事实 |
|----|------|
| 文件 | `src/servers/ZoneServer2016/managers/devhttpserver.ts`（`DevHttpServer`） |
| **GET `/api/npcs/ucs-case9-raw-hex`** | `pack("Character.UpdateCharacterState", …)` 直接得到 **22B**；**T0** = `getCurrentServerTimeWrapper().getTruncatedU32()`；**无**页面/query 覆盖 gameTime |
| **POST `/api/npcs/ucs-case9-sweep`** | 同上包体；**gameTime** 起算同上，可选逐包 `+1`（`incrementGameTime`） |
| **GET `/api/npcs/set-state-raw-hex`** | 整包 `pack` 即 **22B 原生 wire**，响应中的旧 `case9Bridge` 字段只保留兼容命名 |
| **POST `/api/send-raw`** | 原样字节 → `sendRawDataReliable`（与 `sendData` 同隧道） |
| 页面 | `dev/zone-public/index.html`：UCS 控件在 **「临时僵尸驱动测试」**；仅 **Q1** 可手填；僵尸 **characterId** 来自 **`/api/npcs/last-test`** 或 API 默认 `test` |

---

## 快速命令备忘

```bash
cd dev/ghidra
# case 9：Listing 核对 FUN_14053d4e0 实参（re-9）
PyGhidraCli QueryXref to 0x1404f1080            # → CALL @ 1405141a0
PyGhidraCli DescribeAddress 0x1405141b0         # CALL 4f1080 后 ~Q1 / T0 / 备参
PyGhidraCli DescribeAddress 0x1405141dc         # CALL 53d4e0 @ 1405141f7
PyGhidraCli QueryXref to 0x14053d4e0            # 另一处 1405142a5 = case 0x3f（4f1170）
PyGhidraCli SearchDecompile 0x140511840 FUN_14053d4e0 15
PyGhidraCli FindMemoryRefsByOffset 0x450 load 0x140511840 0x1405147f0   # Q0：整函数内无读
PyGhidraCli FindMemoryRefsByOffset 0x450 store 0x140511840 0x1405147f0  # Q0：仅写 51416c
PyGhidraCli FindMemoryRefsByOffset 0x440 load 0x140511840 0x1405147f0  # A0：仅 [RAX+0x440]
PyGhidraCli FindMemoryRefsByOffset 0x448 load 0x140511840 0x1405147f0  # A1：仅 [RAX+0x448]
PyGhidraCli DumpDecompile 0x1404f1080
PyGhidraCli DumpDecompile 0x140511840          # 全函数 2000 行
PyGhidraCli DumpDecompile 0x1404e4520
PyGhidraCli DumpDecompile 0x14053d4e0
PyGhidraCli DumpDecompile 0x1404eb0f0
PyGhidraCli DumpDecompile 0x1404e1de0
PyGhidraCli DumpDecompile 0x14071b000
PyGhidraCli QueryXref to 0x140521700            # 34 CALL @ 140b5eb70..140b5fe92；无 511840 区
# 批量读出各 thunk 的 param_2（见 fun_521700_caller_thunks.json → uniqueFuncEntriesForDumpDecompile）
# for a in 0x140b5eb40 0x140b5ec00 0x140b5ec60 ...; do PyGhidraCli DumpDecompile $a 1 80; done
PyGhidraCli SearchDecompile 0x140521700 FUN_140511840 15
PyGhidraCli SearchDecompile 0x140521700 0x0f0a 15
PyGhidraCli QueryXref to 0x140511840
PyGhidraCli DumpDecompile 0x140526310   # 0x1170 队列消费者
PyGhidraCli DumpDecompile 0x14053fde0   # iVar13 / 0x8ca / 0x8cf
PyGhidraCli QueryXref to 0x1404ff870    # 6×DATA 拆分见 fun_1404ff870_dataref_breakdown_20260320.json
PyGhidraCli ReadPointers 0x1420c1f58 40
PyGhidraCli DumpDecompile 0x140520e20 1 100
PyGhidraCli DumpDecompile 0x1404e57d0 1 200
PyGhidraCli FindMemoryRefsByOffset 0xa3 store 0x140400000 0x140600000
# 0xa3 写入者：FUN_14050c220 / FUN_140524f60 / FUN_14053b5c0（均为 [RSP+0xa3]）
PyGhidraCli DumpDecompile 0x14053d580          # 读 0x1ad8 (=0x35b*8)，re-7
PyGhidraCli DumpDecompile 0x14071b000          # re-8 全局注册
PyGhidraCli DescribeAddress 0x14091ee6d        # re-8 tick → FUN_140526310
PyGhidraCli QueryXref to 0x140526310
PyGhidraCli QueryXref to 0x14091ee40
PyGhidraCli DumpDecompile 0x14091ee40 1 80
PyGhidraCli FindMemoryRefsByOffset 0xa3 any 0x140400000 0x140600000
PyGhidraCli FindMemoryRefsByOffset 0xa3 any 0x140600000 0x140800000
# FindIndirectCallsByOffset：disp=0 已排除 [RSP+-0x8]、纯 [0xABS]、并解析尾项 +位移
PyGhidraCli FindIndirectCallsByOffset 0 0x1404e0000 0x140530000
PyGhidraCli FindIndirectCallsByOffset 0 0x140530000 0x140580000
PyGhidraCli FindIndirectCallsByOffset 0 0x140580000 0x1405d0000
PyGhidraCli FindIndirectCallsByOffset 0 0x1405d0000 0x140620000
PyGhidraCli FindIndirectCallsByOffset 0 0x140620000 0x140670000
PyGhidraCli FindIndirectCallsByOffset 0 0x140670000 0x1406c0000
PyGhidraCli DescribeAddress 0x1406ad9c7
PyGhidraCli FindIndirectCallsByOffset 0 0x1406c0000 0x140710000
PyGhidraCli DescribeAddress 0x1406c0682
PyGhidraCli SearchDecompile 0x1406bf040 FUN_1404ff870 3
PyGhidraCli FindIndirectCallsByOffset 0 0x140710000 0x140760000
PyGhidraCli DescribeAddress 0x14071af55
PyGhidraCli SearchDecompile 0x14071af10 FUN_1404ff870 5
PyGhidraCli DumpDecompile 0x14053dba0 1 80
```
