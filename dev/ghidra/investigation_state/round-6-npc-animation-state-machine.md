# 第六轮重大突破（2026-03-19，2026-09-20 复核）- NPC 动画状态机

> 当前最可靠的 NPC 动画驱动结论。**但**：游戏中测试 states6.bit2 无可见效果，怀疑 H1EMU schema 与客户端解析器格式不匹配。

## 核心发现

NPC 的持续 locomotion（待机/走/跑/战斗移动）主要由 **entity state flags** 驱动；`Character.PlayAnimation` 仍是已确认的 one-shot/姿态入口，不能把它当成持续 locomotion 的唯一控制器。

### 不能直接作为 NPC locomotion 状态的包

| 包名 | opcode | NPC handler | 结果 |
|------|--------|-------------|------|
| Character.PlayAnimation | 0x0f04 | case 3 | vtable+0x630/+0x620 → `FUN_14091f1f0`/`FUN_14053dc30`；`+0x630` 先进入 `FUN_140532dc0` 状态门槛，不是空桩 |
| Character.SeekTarget | 0x0f26 | case 0x25（实机确认） | 安装 native seek controller；**不是** MRN 状态选择器，且当前 A/B 有漂移 |
| Character.ActivateProfile | 0x0f31 | 无玩家同款 case 30 链 | **不宜**作 NPC 攻击主路径；默认探测体对 **玩家与 NPC** 均可破坏附件/头模 → [round-3-4 Empirical](./round-3-4-character-packets.md#empirical-activateprofile-via-devhttp-0x0f31) |

- NPC vtable+0x620 → `FUN_14053dc30`：非平凡的姿态/矩阵/图参数处理
- NPC vtable+0x630 → `FUN_14091f1f0`：保留 `RCX/RDX/R8` 调用约定并转调 `FUN_140532dc0(entity, RDX, R8B)`；成功后触发 0x2a/0x2b/0x2c 事件，旧“忽略参数”结论已推翻
- NPC vtable+0x7e8 → `0x140530da0`：单条 RET，纯空桩

> 上表中的 `SeekTarget` 是移动控制器输入，不应与 `UpdateCharacterState` 的
> locomotion/战斗状态位混称。旧版“SeekTarget 走 default”结论已被 `case 0x25`
> 与实机安装/追踪证据取代；本轮只证明 server-driven 路线不依赖它。

### 真正的驱动函数：FUN_14053fde0

每 tick 对每个 NPC 执行，读取 `entity+0x8ca`(states1)、`entity+0x8cf`(states6) 决定动画状态：

```c
if (entity+0x8ca < 0x80) {           // knockedOut=0
    if ((entity+0x8cf & 0x08) == 0) { // nearDeath=0
        if ((entity+0x8cf & 0x04) == 0) { // hidesHeat=0
            if (isMoving()) iVar13 = 3 or 2; else iVar13 = 0;  // 正常
        } else {
            if (isMoving()) iVar13 = 7; else iVar13 = 6;       // 战斗模式
        }
    } else {
        if (isMoving()) iVar13 = 5; else iVar13 = 1;           // 濒死
    }
} else {
    iVar13 = 4;  // 击倒
}
```

**iVar13 状态表**：0=待机, 1=濒死待机, 2=走, 3=跑, 4=击倒, 5=濒死移动, **6=战斗待机**, **7=追击移动**

MRN 参数通过 `FUN_14050ba50` 直接写入，绕过 vtable。

### 控制包：Character.UpdateCharacterState (0x0f0a)

- 路径：case 9 → `FUN_14053d4e0` → 入队 `entity+0x1170` → 写入 entity flags
- states1 → entity+0x8ca，states6 → entity+0x8cf（bit2=hidesHeat=战斗模式，bit3=nearDeath=濒死）

### 关键 states6 位

| bit | schema 名 | 逆向含义 |
|-----|-----------|---------|
| bit2 (0x04) | hidesHeat | **战斗/攻击模式** |
| bit3 (0x08) | nearDeath | **濒死模式** |

## 测试现状

- **`states6` → case9 wire（服务端仓库 ✅ 2026-09-14）**：完整 22B 包中偏移 **10..17** 的 **states1..7+placeholder** 即客户端 **Q1**；偏移 **18..21** 的 **gameTime** 即 **T0**。opcode/characterId 占前 10B；不再追加 10B bridge。见 `fun_140526310_91ee40_tick_chain.json`、`tools/verify-states6-pack.ts`、`GET /api/npcs/ucs-case9-from-h1emu`、`GET /api/npcs/set-state-raw-hex` 的兼容字段 **`case9Bridge`**。
- `/api/npcs/set-state` 已实现，支持 states6Bits、allBitsRaw、sweep
- 发送 raw 22-byte 格式与单纯 H1EMU 短包**曾**无可见效果
- 疑点：22B schema 已与 parser 的完整读取范围对齐；若仍无效，优先查 **`511840`/`param_2==10`**、**characterId 路由**、**`0x35b` → `0x8cf`/`0xa3`/`4ff870` 前传**（`open-questions.md` #2）。
