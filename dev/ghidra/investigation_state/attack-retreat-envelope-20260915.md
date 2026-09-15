# 近战后退复测：攻击包络与状态交接（2026-09-15）

## 运行证据

- 服务端运行日志：`C:\Users\WS\AppData\Local\Temp\h1z1-manual-reload-xwmowypg\stdout.log`
- ztest run：`2c3a7c4d-9d60-4f42-8d91-c806d6ce406d`
- 场景：`/ztest flat`，`movementMode=server`，测试角色 godMode 保持开启。
- 当前源码解析到 Machete item `83 → weapon 10 → fire group 10 → fire mode 13`：
  `RANGE=1.5`、`MELEE_DETECT_WIDTH=0.15`、`MELEE_DETECT_HEIGHT=0.1`。

## 与用户描述对应的时间线

用户描述：第一次后退后没有攻击，第二次后退后有攻击。

日志中与此最接近的一组回合是：

| 事件 | UTC | 服务端位置关系 | 结果 |
|---|---|---|---|
| 离开近战态 `2→1` | `00:47:34.815` | 距离 `1.723m`，`dy=-0.018m` | 停止攻击候选 |
| 回到近战态 `1→2` | `00:47:36.745` | 距离 `1.317m`，`dy=-0.100m` | 没有 `KnifeSlash` 请求 |
| 再次离开 `2→1` | `00:47:48.973` | 距离 `1.774m`，`dy=-0.120m` | 停止攻击候选 |
| 再次回到近战态 `1→2` | `00:47:50.171` | 距离 `1.495m`，`dy=-0.069m` | `KnifeSlash`，随后命中复核 |

后一次复核为 `distance=1.50`、`health=10000→10000`、`protectedTestReplay=true`、`damageFeedbackAttempted=true`。生命值不变是 godMode 保护的预期结果。

## 判定

这不是“第一次攻击请求丢失、第二次才补发”的证据。第一次回到 `behaviorState=2` 时，目标仍在 `RANGE` 内，但我们自己的服务端投影以玩家/NPC 网络原点高度差约 `0.100m` 为输入，最后一层 `abs(dy) <= 0.1` 没有通过；第二次回到近战态时高度差约 `0.069m`，该投影通过并发出挥击。

这里必须修正解释：`MELEE_DETECT_HEIGHT` 是武器数据字段，当前没有原生证据证明它等于“两个实体网络原点的世界高度差上限”。原生客户端另有 `SwingContact → FUN_14051B490` 的 contact-record/target-resolution 链，以及 `FUN_14050FD40` 一类攻击锚点/朝向求解；车顶和台阶上的可命中记忆正是反对“原点高度差硬门槛”解释的有效反例。因此本轮只能标记为 **server projection rejected**，不能标记为“原版在这个高度差下必定不攻击”。不能直接把 `0.1` 调大，也不能继续把它当作已恢复的碰撞胶囊语义。

补充数据检查：`ServerWeaponDefinitions.json` 共 126 个武器定义，其中 55 个使用同一组 `0.15/0.1`，71 个为 `0/0`；这更像通用武器检测字段，而不是按角色、车辆、台阶高度定制的世界空间垂直攻击范围。这个分布进一步降低了“原点 `dy` 直接比较”解释的可信度，但仍不能单独推出原生碰撞算法。

## 垂直命中反例（用户回忆，2026-09-15）

用户指出原版中以下场景仍可命中：玩家站在车顶、僵尸在地面且水平距离足够近；或僵尸站在台阶上、玩家在台阶下。该反例与当前服务端投影的两个假设都不相容：

- `getDistance(networkOrigin, networkOrigin) <= RANGE` 不是角色身体/武器锚点之间的命中距离；
- `abs(targetOriginY - attackerOriginY) <= MELEE_DETECT_HEIGHT` 不是原生的垂直命中规则。

因此，后续实现不能靠放大 `MELEE_DETECT_HEIGHT` 或把 `RANGE` 改成更大的常数来适配录像。应先取得原生 `SwingContact` 的 contact record、目标解析和攻击锚点（包括挂载/地形导致的姿态变换），再决定服务端只负责候选/状态，还是需要一个有明确骨骼/碰撞体来源的服务器复核。当前一次 `dy≈0.100m` 的拒绝只标记为 **server projection rejected**，不代表原版规则拒绝。

## 角色/台阶碰撞资源证据

这条记忆现在有了资源层的独立支撑，而不只是行为推测：

- `ZombieMale_Skin_01.adr`、`ZombieFemale_Skin_01.adr` 和 `SurvivorMale_Skin_01.adr` 都把 `CollisionData` 指向 `SurvivorMale_CaucasianBase_FullBody_COL.apx`，并且 `useBoundingBox="0"`、`createAsKinematic="0"`。该 APX 是 17,564 字节的 APEX/PhysX 二进制，字符串表包含 `DynamicSystemCapsuleShapeParams`、`DynamicSystemSphereShapeParams` 以及 `L_hip`、`L_knee`、`spineUpper`、`head`、`L_ankle` 等骨骼名；它不是一个只含实体原点的半径字段。
- `Common_Structures_PlayerBuilt_StructureStairs.adr` 的 `CollisionData` 是 `Common_Structures_PlayerBuilt_StructureStairs.cdt`，`CollisionType="4119585228"`；台阶本身有独立的三角形碰撞网格。
- 仓库现有 `forgelightStaticAssets` 只解析受控静态 `.cdt`，明确不接受角色 `.apx`。因此当前 TS 的 `origin → origin` 投影没有复用游戏里的角色碰撞体，这正是车顶/台阶垂直命中不能由它表达的原因。

这不能单独证明每一次 NPC 伤害都由客户端 PhysX 直接结算，但足以否定“`MELEE_DETECT_HEIGHT` 就是网络原点 Y 上限”的解释；下一步应解出 APX 的骨骼绑定形状或继续闭合原生 `SwingContact`，而不是调高阈值。

## 原生 contact 几何的进一步闭合（固定 EXE，2026-09-15）

这次重新导出了 `FUN_14051B490` 全函数，并单独导出了它调用的 `FUN_1414E1860`：

- `FUN_14051B490` 先从图/姿态数据得到两个四分量向量（起点 `local_1f8` 与偏移后的终点 `local_168`），再调用 `FUN_1414E1860(query, start, end, DAT_142072834)`。固定镜像中的 `DAT_142072834` 是 `0x3DCCCCCD = 0.1`，但它是调用的第四实参，不是 `start.y - end.y` 的比较值。
- `FUN_1414E1860` 把两端向量完整写入 query record，并计算 `sqrt(dx² + dy² + dz²)` 保存到 record 的距离字段；这条 helper 本身没有只比较 Y 的分支。之后 `FUN_1414E1930` 对 query record 做排序/整理。
- 在候选细化路径中，`FUN_14051B490` 对四分量差向量逐分量平方求和，与 `DAT_1425BA090 = 1.0` 比较，再归一化并生成下一段查询；另一段查询使用 `DAT_1425BA044 = 0.01`。这些是完整向量运算，不能还原成服务端当前的 `abs(dy) <= 0.1`。
- 候选记录最终进入状态 `1/2/3` 分类；`FUN_14051A900` 的状态 1 路径会调用 `FUN_14051FB40` 写目标 Flinch 参数，并通过实体虚表 `+0x620` 发送 `MeleeHit` 图事件。该链仍未证明服务端生命值结算的权威来源，但已证明客户端 contact 不是“两个网络原点的高度差门”。

这条事件的下游也已经分清：实体 `+0x620/+0x630` 的包装函数最终把事件/参数交给动画网络对象的本地队列与参数缓存；现有证据没有发现它构造 C2S 包或向服务端回传命中 ACK。因此不能把客户端图事件当成服务端已经收到的“命中确认”，也不能用当前 TS 的 `450ms` 定时器冒充原生 `SwingContact` 时刻。真正能确认的是：客户端本地 contact/Flinch 具有独立的三维几何链，服务端目前只有实验性的候选与伤害代理。

因此，用户说的车顶/台阶命中与固定 EXE 的几何形态是一致的：命中资格应来自姿态/武器锚点与角色碰撞体的空间查询，垂直差只是向量中的一个分量，不应被单独截断。当前 TS `canMeleeImpact` 仍然只是实验代理，不能继续作为生产命中判定。

还有一个服务端侧的直接风险：`mountVehicle()` 只设置 `client.vehicle.mountedVehicle`、座位和 managed-object/occupy 包，没有从座位/车辆变换推导玩家的身体锚点；`state.position` 是否随后更新取决于客户端的位置包。因此挂载状态下，服务端保存的玩家网络原点不保证等于画面中的玩家碰撞体；这使当前 origin-to-origin 近战投影在车上场景中从数据来源上就不成立。

另外，攻击请求间隔约 `1.52s`，来自当前测试用的 `1500ms` 实验冷却；资料仍明确把它标为未由原生接触时序证明的临时值。本轮没有改变该冷却，也没有把这次现象归因于冷却；能确认的只有第一次没有通过当前代理几何门，不能把该代理门升级成原版规则。

## 本轮代码修正（2026-09-15）

已移除 `src/servers/ZoneServer2016/managers/aimanager.ts` 中把
`abs(target.state.position[1] - attackOrigin[1])` 与
`MELEE_DETECT_HEIGHT` 比较的逻辑。该比较是服务端自己增加的“网络原点 Y 门槛”，与原生角色/武器碰撞体的语义不一致，正是车顶/台阶记忆会被错误拒绝的原因。

现在的临时服务端候选规则是：

- 仍由火模式 `RANGE` 做完整三维的候选距离上限；
- 仍按攻击朝向检查 XZ 的 `MELEE_DETECT_WIDTH`；
- 不再把 `MELEE_DETECT_HEIGHT` 当作两个网络原点的世界 Y 差上限；
- 延迟复核继续重复上述候选检查，未把 `450ms` 伪装成原生 `SwingContact` 回执。

新增回归覆盖了两件互相独立的事实：目标原点 Y 偏移 `0.3m`（大于武器表中的 `0.1m`）仍能进入攻击/伤害路径；当三维距离确实超过 `RANGE=1.5m` 时，即使 XZ 很近也不会攻击。这样改动不是放大任何常数，而是删除了没有原生依据的坐标投影门槛。

这还不是完整的车顶/高台命中实现：如果网络原点的三维距离已经超过火模式 `RANGE`，当前服务端仍会保守拒绝，因为服务器还没有角色 APX 胶囊、武器骨骼锚点和挂载座位变换。要覆盖“车顶高度很大但身体/手部仍在攻击范围内”的情况，下一步必须把这些原生形状/姿态数据接入候选查询，不能继续调大 `RANGE`。

车辆位置链也存在同一个缺口（`src/servers/ZoneServer2016/handlers/zonepackethandlers.ts`）：
`PlayerUpdateManagedPosition` 目前把 managed packet 的位置直接复制给每个乘客的
`state.position`，只对载具自身再减去一个类型相关的显示偏移；`mountVehicle` 保存了
`vehicleId/seatId`，但没有把座位局部变换、角色胶囊或车顶碰撞面解析到乘客状态。因此“人在车顶”不能用当前乘客网络原点代表，必须先补 seat/world transform，再接 APX 胶囊查询。

## 下一步证据门槛

1. 在同一实体 live capture 中对齐原生 `AttackRegion`/`MeleeDuration`/`SwingContact` 与 target Flinch/MeleeHit 的时序；
2. 在不修改 `MELEE_DETECT_HEIGHT` 的前提下，做同一平面、台阶/坡面和车顶高度差 A/B；同时记录网络原点、候选 contact record、朝向和客户端画面；
3. 只有拿到原生接触/受击时序后，才决定服务端是否应改用骨骼/碰撞体锚点，或只保留 `RANGE` 作为候选门。当前不做经验性放宽。

## 录像说明

当前这次 run 的服务端日志没有对应的 `recording_starting` 事件；仓库中最近的可用录像是
`tools/task-01a06a01/recordings/29909319-3408-46db-b4f4-84d65d59fe3e/game.mp4`，其抽帧显示同一类“离开后追上、随后进入攻击姿态”的可见过程，但不是本次 `2c3a7c4d...` run 的逐帧录制，不能把它当成同一轮的时间戳证明。
