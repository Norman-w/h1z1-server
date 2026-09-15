# 已排除/降级的侧链

> 调查时切勿将这些链误判为主线。保留以防重蹈覆辙。

## 完全排除（对 NPC 无效）

| 包/机制 | 说明 |
|---------|------|
| Character.PlayAnimation (0x0f04) | NPC vtable+0x620/+0x630 为**空桩**，调用无效果 |
| Character.ActivateProfile (0x0f31) | **无 NPC 与玩家同款的 case 30 战斗/MRN 主线**（不宜作僵尸攻击主链）。**非**「收包后零副作用」：实机对测试 NPC 可触发 *Failed to load attachment* 与头部模型丢失，见 [round-3-4 Empirical](./round-3-4-character-packets.md#empirical-activateprofile-via-devhttp-0x0f31)（含对 `self` 与僵尸同型破坏） |

> `Character.SeekTarget (0x0f26)` 不再列为“完全排除”：旧稿的“无 case、default 丢弃”已被
> `FUN_140511840` 的 case `0x25`、实机 `FUN_140534a10` 安装断点以及后续 seek tick 观测推翻。
> 它是客户端 native movement controller 的输入，不是直接选择行走/攻击 clip 的包；本地 A/B
> 仍出现漂移，因此不能把“能安装 controller”当作“追击表现正确”。

## 降级（非僵尸主攻击链）

| 函数/链 | 说明 |
|---------|------|
| FUN_1404eccf0 / FUN_1404ec650 | case 3 / case 0x40 解析器，非 case 0x30 主线 |
| Character.SeekTarget / SeekTargetUpdate | **移动控制器侧链**：可安装/更新 native seek rail，但不直接决定 MRN locomotion/attack 状态；生产路线是否与 `PlayerUpdatePosition` 混用仍未定 |
| PTR_FUN_1420c2b80 / PTR_FUN_1420633d0 | 通用字符串/缓冲容器与析构外壳 |
| FUN_14052cd10 | 失败回滚/析构辅助，清 SoeUtil::IString 链表 |
| FUN_1404fbd30 | 恢复虚表后 free 的析构壳 |
| FUN_14053dba0 | State_Grappling、entity+0xf60/+0xf68 grapple 锁存 |
| FUN_14053ca80 | State_Weapon/Vehicle/WeightClass/SeatType/State_CanFire |
| FUN_14053c700 | IronSightsDuration/Active/State_Ironsights/AmmoCount |
| FUN_14051fdf0 | HudHandler:OnVehicleEntered 清 State_Falling |
| FUN_14051fb40 | Flinch* / MeleeHit — 命中后受击，非主动攻击 |
| entity+0x5f0 | effect/decal/composite-effect 共享子系统 |
| +0x638 / +0x728 | 运行时模型/表现监听器链 |
| FUN_1406c6a20 | 观察点/挂点/附属节点同步层 |

## 附着/挂点链（非主 locomotion/attack）

- FUN_14054a820
- FUN_14054b620
- FUN_140b683a0
- FUN_140b5e930
- FUN_140b5df70
- FUN_140b5e860
- FUN_140b5e940（含 muzzle 字符串循环）

## 共享接口（非僵尸专属）

- +0x248 / +0x250 / +0x6d0 — 共享 late-hook / refresh
- +0x3b8 — 共享状态/标志位锁存
- FUN_1414458b0 — 共享 gate
- FUN_140535700 — 写 entity+0x1ae8、+0x8cd bit 0x80
