# 服务端包 → MRN 驱动链路（最新结论）

> 快速参考。按需加载详细分块见 [README.md](./README.md)。

## 当前主线（2026-03-19 第六轮 + re-track 校正）

**Character.UpdateCharacterState (0x0f0a)** 是控制 NPC 动画状态的正确包。

- **处理路径（客户端，已串链）**：case 9 → `FUN_1404f1080`（charId 后 **22B**：1+1+8+8+4）→ `FUN_14053d4e0` → 入队 **`entity+0x1170`** → `FUN_1404e1de0` → **`FUN_14071b000`**（全局工作链表 `DAT_142b19b38`）；**出队**在 **`FUN_140526310`**：把节点 mask **合并进 `entity+0x35b`**（字节偏移 **0x1ad8**），并 **`0x8cd |= 4`**。tick 入口之一：**`FUN_14091ee40` → `FUN_140526310`**。
- **与 0x8cf 的关系**：**不是**队列直接写 `0x8cf`。**`FUN_1404ff870`** 读 **`entity+0xa3`（uint 位域）** 写 **`0x8cf` bit2/bit3** 等；**`0xa3` 谁填、何时虚调 `FUN_1404ff870`** 仍待闭合。另：**`FUN_14053d580`** 读 **`0x35b` bit12** + **`0x8c9`** 等，走音效/回调侧链（与 0x8cf 并行）。
- **动画驱动**：**`FUN_14053fde0`** 每 tick 读 **`0x8ca` / `0x8cf`** 等算 **`iVar13`** → 虚调用 **`+0x7e8`**（MRN 相关状态）
- **关键位（语义）**：round-6 将 **`states6.bit2`/bit3** 与 **`0x8cf` bit2/bit3**、**`FUN_14053fde0`** 的 **iVar13** 分支对齐；**`FUN_1404ff870`** 用 **`0xa3`** 写 **`0x8cf` bit2/bit3**。**未全证**：H1EMU **`states6` 单字节**如何进入客户端 **`0xa3` 各 bit** 的逐位打包（与 #1 格式问题相关）

详见 [re-track-update-character-state-chain.md](./re-track-update-character-state-chain.md)（re-1～re-8）。

## 事实：H1EMU schema 与客户端解析器长度不一致

- **H1EMU `DataSchema.pack`（Character.UpdateCharacterState）**：`opcode` + `characterId`（`uint64string` 8B）+ **12B**（7×`bitflags` + `placeholder` + `gameTime`）→ 与 **`FUN_1404f1080`** 所需的 **`characterId` 后 22B** 不符；**`sendData` 走 pack 时长度/布局不满足解析器**（见 [packet-format-mismatch.md](./packet-format-mismatch.md)）。
- **客户端 `FUN_1404f1080`（事实）**：`characterId` 之后 **22B** = **A0(1)+A1(1)+Q0(8)+Q1(8)+T0(4)**；case 9 路径上 **Q1** 参与 **`0x35b`** 掩码入队（re-track re-9 Listing）。

## 事实：服务端 DevHttp 直接发 schema 原生 22B

- **实现**：`src/servers/ZoneServer2016/managers/devhttpserver.ts` — `packUcsCase9FullPacket`：前 **10B** = 与 **`sendData` 相同的 opcode + `uint64string`**；后 **22B** = re-track 体；**T0** = **`getCurrentServerTimeWrapper().getTruncatedU32()`**。
- **隧道**：`sendRawDataReliable` → `GatewayServer.sendTunnelData`（Reliable），与 **`_sendData`** 同出口类路径。

## 观测（非逆向结论）

- 旧版 **32B + bridge** 会在 parser 的无剩余检查处失败；改回 schema 原生 **22B** 后，需重新观察 **客户端 dispatch / `0x35b`→动画链 / MRN** 是否闭合，见 [open-questions.md](./open-questions.md)。

## 已排除（勿再走）

| 包/路径 | 原因 |
|--------|------|
| Character.PlayAnimation | NPC vtable +0x620/+0x630 为空桩 |
| Character.ActivateProfile | **僵尸攻击主线排除**；实机默认体对 **僵尸与玩家自己** 均可触发附件失败+头/外观破坏（非 NPC 独有），见 [round-3-4 Empirical](./round-3-4-character-packets.md#empirical-activateprofile-via-devhttp-0x0f31) |

> `Character.SeekTarget` 不属于攻击状态主线，但也不能再写成“无对应 case”：
> `FUN_140511840` case `0x25` 与实机断点已证明它会安装 native seek controller。
> `/ztest seek` 的录像显示该 controller 在当前客户端上会出现漂移/缺少可信步态，
> 所以它仍是待验证的移动输入，不是可直接替代服务端位置流的修复。

## 相关文件

- [re-track-update-character-state-chain.md](./re-track-update-character-state-chain.md) — 0x0f0a 链逐段工作纸（re-1～re-8）
- [round-6-npc-animation-state-machine.md](./round-6-npc-animation-state-machine.md) — 完整逆向与 iVar13 状态表
- [packet-format-mismatch.md](./packet-format-mismatch.md) — UpdateCharacterState 格式差异
- [open-questions.md](./open-questions.md) — 未解问题与优先级
