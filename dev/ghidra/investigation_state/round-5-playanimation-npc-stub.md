# 第五轮发现（2026-03-19，2026-09-20 复核）- PlayAnimation 与 NPC 虚表

> **旧结论已推翻**：PlayAnimation 对 NPC 无效（vtable 空桩）不成立。旧的动态探针没有看到画面效果，不能证明虚表实现为空；需要把调用约定和状态门槛一起还原。

## FUN_140352740 (Graph Param Handle Parser)

```
bit15=1 → simpleKey 模式，key 在 bits[0:12]
bit15=0 → 字符串名模式，从流读参数名，FUN_1402ee3a0 按名查找
bit14=1 → 额外 4 字节
```

字符串句柄格式：`[2B header, bit15=0, bits[0:12]=strlen][str][0x00]`

## FUN_140524380 (PlayAnimation MRN/状态入口)

1. `entity->+0x630(MeleeDuration, duration_s)`；`duration_s` 由网络字段转换为浮点图参数。
2. `entity->+0x620(trigger_handle)` 推送图触发。
3. 对 NPC vtable `0x14214dcb8`，`+0x630 = FUN_14091f1f0`，不是空桩。汇编确认它保留调用者的 `RCX/RDX/R8`，转调 `FUN_140532dc0(entity, RDX, R8B)`，成功后发出 0x2a/0x2b/0x2c 三个引擎事件。
4. `FUN_140532dc0` 会检查实体的 profile/stance 表，比较 `entity+0x90c`，然后更新该状态并再次调用 `+0x620/+0x630`；因此攻击动画是否显示取决于 profile、状态门槛和运行时资源，不是“+0x620/+0x630 为空”。
5. NPC `+0x620 = FUN_14053dc30` 也是非平凡实现（姿态/矩阵/图参数处理），不能按 stub 处理。

## 实验：字符串句柄测试（结果仍需按新调用链解释）

通过 `/api/npcs/play-animation-by-name` 发送：Death, Flinch, FlinchBreakout, FlinchOverride, Active, MeleeAttack, MELEE_ATTACK, Locomotion, Sprint → **全部无可见效果**。

simpleKey sweep 0-500 也无效果。

## 当前结论

静态链已经确认 `Character.PlayAnimation (0x0f04) → FUN_140524380 → NPC +0x630/+0x620 → FUN_140532dc0/FUN_14053dc30` 是真实的 NPC 动画/姿态入口之一。此前“空桩”结论删除。

这仍**不等于**已经证明所有动物的运行时动画、root motion、SwingContact 回调都正常：`FUN_140532dc0` 的 profile 表和动态资源句柄必须在客户端运行时命中，攻击伤害也仍需以真实 contact/ACK 证据闭环。`UpdateCharacterState` 是 locomotion/combat 状态的另一条入口，不应替代 PlayAnimation 结论。
