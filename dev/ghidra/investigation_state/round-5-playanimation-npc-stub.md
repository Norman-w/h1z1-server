# 第五轮发现（2026-03-19）- PlayAnimation 与 NPC 虚表

> **已推翻**：PlayAnimation 对 NPC 无效（vtable 空桩）。保留以防水续接时再次尝试。

## FUN_140352740 (Graph Param Handle Parser)

```
bit15=1 → simpleKey 模式，key 在 bits[0:12]
bit15=0 → 字符串名模式，从流读参数名，FUN_1402ee3a0 按名查找
bit14=1 → 额外 4 字节
```

字符串句柄格式：`[2B header, bit15=0, bits[0:12]=strlen][str][0x00]`

## FUN_140524380 (PlayAnimation MRN 写入)

1. `entity->+0x630(MeleeDuration, duration_s)`
2. `entity->+0x620(trigger_handle)` 推送图触发

## 实验：字符串句柄测试

通过 `/api/npcs/play-animation-by-name` 发送：Death, Flinch, FlinchBreakout, FlinchOverride, Active, MeleeAttack, MELEE_ATTACK, Locomotion, Sprint → **全部无可见效果**。

simpleKey sweep 0-500 也无效果。

## 假说（已证实）

**NPC 虚表 +0x620 / +0x630 为空桩**。PlayAnimation case 3 虽会解析并调用，但 NPC 的实现忽略参数，故对 NPC 无效。

正确路径应为 ActivateProfile（对玩家/武器实体）或 **UpdateCharacterState**（对 NPC entity flags，见 round-6）。
