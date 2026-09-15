# 第三/四轮发现 - Character 包注册与 ActivateProfile

> ActivateProfile (0x0f31) = case 0x30，驱动武器/战斗动作。**对 NPC**：逆向上无与玩家同款的 **case 30 专用战斗/MRN 主线**，不宜再指望它驱动僵尸追砍动画；**不等于**「收包后客户端完全当空气」——见下文实机观察与推理。

## Character 包 ID 注册表 (FUN_140ac86a0)

格式：`FUN_140ad4db0(0xNN000f00, "cPacketIdCharacterBase", "cCharacterPacketIdXxx", ...)`

| sub-op | 包名 | case |
|--------|------|------|
| 0x04 | PlayAnimation | 3 |
| 0x0a | UpdateCharacterState | 9 |
| 0x26 | SeekTarget | 25 |
| 0x31 | ActivateProfile | 30 |
| 0x4f | StartMultiStateDeath | 4e |

## FUN_1405113e0 record 布局

```
record+0x20 → pose
record+0x28 → action 链表 → FUN_14053d9b0
record+0x4c → stateCheck
record+0x50 → IPToStateMapEntry selector (哈希键)
record+0x54 → mode
record+0x58/0x70 → state blob 1/2 → +0x4b0
record+0x90 → stat 链表 → +0x770(each) + +0x778
```

## ActivateProfile 二进制格式 (FUN_1404ec420)

```
[0x0f, 0x31][characterId:8B]
[1B pose][4B actionCount][action entries...]
[4B][4B stateCheck][4B selector][4B mode]
[4B len + data] state blob 1
[4B len + data] state blob 2
[4B statCount][stat entries...]
```

length-prefixed blob：`[4B length][length B data]`

## Empirical: ActivateProfile via DevHttp (`0x0f31`)

> 中文摘要：默认 `buildActivateProfileBody` + 任意小 `selector`（或 sweep）在 **僵尸** 与 **玩家自己** 上均可触发同一类附件失败与模型破坏；**非 NPC 独有**。

### A. 测试僵尸（`characterId`=`test`）

**场景**：`POST /api/npcs/activate-profile`。

- **现象**：`selector: 0` 或 `sweep 1~49`（默认体）→ 弹窗 **Failed to load attachment / Please verify Game Assets**；**头部模型消失**。
- **复现细节**：**首次**发包易见弹窗；**再次**发包常**不再弹窗**，但头仍缺（状态已坏、未恢复）。

### B. 玩家自己（`characterId`=`self`，2026-03-19 对照）

**场景**：同一 API、同一默认体，`characterId: "self"`。

- **现象**：与僵尸**同型**：弹窗 **Failed to load attachment**；**角色头部消失**；**着装被换掉**（例如由双色上衣变为**默认白 T** 等），属附件/外观链被打乱后的表现。
- **结论（对此测试载荷）**：破坏**不依赖「是不是僵尸」**——说明至少**玩家实体路径也在消费该包**（或消费解析后的 record），而非「仅 NPC 误触」。与「官方设计主要面向玩家/武器 profile」不矛盾：**错误 selector + 极简体** 在人物上同样是**未定义/错误资源**行为，而非「人物完全免疫」。

**截图**：测试记录中有对比图——发包前（有头、原上衣）→ 弹窗后（无头、默认白 T 等）；另有一张为同场景下**玩家与远处僵尸均无头**。

## 调查推理（待验证，与「主线排除」并存）

1. **若对 NPC「完全没用」**，则难以解释**稳定、可重复的可见破坏**；更合理的表述是：**没有我们想要的、文档化的 NPC 攻击动画链**，而非「没有任何处理」。
2. **人身对照（已做，默认体）**：对 **`characterId=self`** 与 **`test` 僵尸** 发**同一套**默认 `buildActivateProfileBody`，**现象一致**（附件错误、头消失；人物另有着装回退）。因此：**「只有僵尸会坏」不成立**；仍待 **官服/抓包得到的合法 selector + 完整载荷** 才能观察「设计内」人物表现（武器/战斗 profile），与当前**破坏性探测**区分开。
3. **目的论**：客户端不太可能仅为「制造一次附件错误」而保留整条收包与解析壳；**更可信**的是存在**设计内用途**（武器/状态机），在错误实体或错误 selector 上表现为**副作用**。结论应用**证据层级**表述：静态「无 NPC 专用 handler」≠ 动态「无行为」。

## NPC 虚表 +0x848

- 主虚表：空桩
- **NPC 0x14214dcb8**：`FUN_14053aea0` — 近战处理，经 `entity[0x61]->+0x60` 与 MRN 交互
- 玩家 0x142150f88：`FUN_14092cba0` — 武器系统

## 重要排除

- `DAT_142b195d8` 哈希表在 BSS，运行时填充，静态无法获 selector
- Ghidra 的 `IPToStateMapEntry` 多为 MSVC 异常展开表，非游戏哈希
