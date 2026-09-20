# AnimalsPhysics 图与服务端职责审计（2026-09-19）

本轮只读检查了客户端解包的 `AnimalsPhysicsX64.mrn`、`AnimalsX64.mrn` 和
动物 ADR/MRN 资源，没有修改客户端资源。图 packet 的结构化入口位于
`AnimalsPhysicsX64.mrn` 的 type `0x0a` packet（本地资源版本 SHA 应以当前
解包文件为准）；图头部声明 209 个节点，节点名称按图节点索引可复核。

## 原生图给出的职责

共享图包含以下控制参数：

```text
State_Moving
State_Turning / TurnRate
VelocityLocalZ
State_Eating / State_Injured
Interest_Level
HeadLookTarget / HeadLookBlendWeight
NPC_AttackSpeed
```

图中的 locomotion 段包含 `Walk_Injured`、`Run_Injured`、`Speed0689`、
`Speed1..Speed8` 等速度/混合节点；type-`0x0d` 资源表同时列出 Wolf、Deer、
Bear、Rabbit 各自的 Walk/Run/Sprint 源 `.nsa`。因此客户端不是只播放一个
“服务器把模型往前推”的静态动作，客户端确实有按状态、速度和物种资源混合
步态的能力。

### 本轮对 `AnimalsPhysicsX64.mrn` 内部记录的复核

这次没有把可打印字符串本身当作语义结论，而是沿 type-`0x0a` 图资源的相对
表复核了参数名、公共事件表和接触记录：

- 图的字符串表是 238 项；其中 `ControlParameters|NPC_AttackSpeed`、
  `ControlParameters|VelocityLocalZ`、`ControlParameters|State_Moving` 等是
  图输入名，不能单凭名字推导服务端常量或网络回执。
- 同一份 `AnimalsPhysicsX64.mrn` 的原始字节字符串中没有
  `AttackRegion` 或 `MeleeDuration`。这两个名字来自通用/僵尸侧的 native
  参数边界，不能因为 `Character.PlayAnimation` 能携带一个通用时长字段，
  就推断动物图会消费这两个参数。动物侧目前能确认的攻击相关输入是
  `NPC_AttackSpeed`。客户端共享 writer 的静态常量值为 `1.0`；服务端现
  在动物 `KnifeSlash` 的 `animationType/unknownDword3` 参数对中显式携带
  这个已恢复的 baseline，确保它在离散攻击事件入图前已经写入。这个值和
  真实运行时 selector/播放倍率仍需 live 对齐；因此不直接向动物发送未经
  证明的 `AttackRegion`/`MeleeDuration` 替代包。
- 公共事件表包含 `Idle`、`KnifeSlash`、`StandUp`、`WolfHowl`、
  `MeleeFlinch` 等；`KnifeSlash` 是四个动物共用的入口，物种 leaf 由
  `animSetName`（Wolf001/Deer001/Bear001/Rabbit001）选择。
- 四条 `SwingContact` type-`0x03` 记录的浮点对分别是
  `0.259999..0.740001`（Wolf）、`0.300000..0.700000`（Deer）、
  `0.266667..0.733333`（Bear）和 `0.214286..0.785714`（Rabbit）。这些是
  动画归一化事件区间，不是武器范围、不是实体原点高度门槛，也不是服务端可
  直接发送给玩家的“命中确认”。
- 静态图资源没有暴露可安全移植到 TS 的动物武器接触胶囊；现有 `.apx` 只
  审计出身体骨骼胶囊/球体。因此不能把 APX 身体半径或 `NPC_AttackSpeed`
  名称硬套成攻击距离/攻击倍率。

### 2026-09-20：原生接触不是一个可移植的标量距离

对已确认的动物实体虚表 `0x1420c1de0` 做了有界反汇编：`+0x858` 指向
`FUN_14051b490`（接触候选/结果汇总），它在进入候选分支前会调用实体虚表
`+0x870`。该槽静态解析为 `FUN_14050e5b0`，其职责不是读取一个固定的
`ATTACK_RANGE`：

- 它先通过实体组件虚表 `+0x58` 取得碰撞/姿态相关对象，并读取实体
  `+0xe54` 的选择值；
- 随后调用 `FUN_141441a80`，把组件查询结果写入调用者提供的 16 字节输出；
- 它还从实体 `+0x20` 的组件链取向量，做归一化后写入另一个输出；
- `FUN_14051b490` 再把这些结果送入候选列表、过滤器和实体/场景对象分支，最后
  记录 `entity+0xe60` 的接触状态。

这条链证明零售客户端的动物接触是“碰撞组件/姿态 + broadphase 候选查询”，
不是服务端可以仅凭两个实体原点和一个数字复刻的命中盒。当前服务端诊断因
此把攻击动物的几何来源标为 `native-client-shape-query-unavailable`：
我们已经知道原生查询存在，但服务端没有这套客户端组件对象和运行时姿态。
`.apx` 中审计出的身体胶囊可以用于碰撞资产核对，不能直接冒充爪/嘴的攻击
接触形状，也不能据此继续“调一点距离”来宣称命中已闭合。

### 2026-09-20：SwingContact 回调边界已进一步确认

继续沿 `SwingContact` 的公共事件调用者反编译到 `FUN_140aa7450`、
`FUN_14092b8a0` 和 `FUN_14051a900`：回调会沿实体图 vtable 的 `+0x160`、
`+0x790` 以及本地接触/姿态链运行，并在满足内部资格时调用
`FUN_14051fb40`。这些函数构造的是客户端内部事件、姿态矩阵和碰撞候选；在
有界反汇编范围内没有 `C2S` 写包、SOE 发送入口或可供服务端消费的
`SwingContact` 确认字段。

因此当前服务端契约的含义是明确的：

- `AnimalsPhysics.SwingContact` 是客户端本地图事件，不是服务端收到的命中
  回执；
- Wolf/Bear 的伤害仍只能在同一归一化接触窗内，使用服务器追击包络和
  Recast 视线作为 `server-projection` 兜底；
- Deer/Rabbit 的原生攻击资源只保留用于受击/诊断，能力为 `passive`，不会
  进入攻击 FSM；
- `/ztest status` 现在额外报告 `nativeGaitReady`、`pendingExpectedSpeed` 和
  `pendingNativeSeekTargetId`，可直接观察“原生首个移动带是否已经产生”以及
  追击/速度边是否仍在等待，而不是把目标速度误认成已播放的步态。

这条边界不是把投影说成原生命中；它说明下一轮录像应同时记录玩家受击反馈、
`contactWindowActive`、`attackEnvelopeWasActive` 和上述 gait 字段。若客户端仍
没有回执，服务端无法仅靠 TypeScript 宣称爪/嘴的真实碰撞已经闭合。

### 2026-09-20：共享 graph writer 与被动逃跑分支

对客户端共享 writer `FUN_14053fde0` 的 vtable 入口继续下钻后，`entity
vtable+0x48` 已解析到 `FUN_140519680`。它检查实体的内部资格字节
`entity+0x8c8` 是否仍低于 `0x80`；这只是 writer 的原生资格门槛，不能把
它误命名成服务端的 `canAttack` 字段。门槛通过时，writer 会为动物统一提交
`State_Active` 和 `Interest_Level`；同一函数前面的 `entity+0x8cf` 位分支
才决定普通 idle/walk/run（状态索引 0/2/3）还是 combat idle/moving（6/7）。

这条链说明两件事：

1. Deer/Rabbit 的 flee/sprint 不需要发送 `Character.UpdateCharacterState`
   的 `inCombat/hidesHeat`，也不需要把被动动物切进战斗图；它们仍会经过共享
   writer 的正常 `State_Active`/`Interest_Level` 提交。
2. `Character.AggroLevel` 是一条独立的 graph-input 边。收包分发器
   `FUN_140511840` 的 `case 0x50` 进入 `FUN_140514780` →
   `FUN_140b6c6a0`，后者保存 float 并在可选标志下触发原生事件 `0x30`；这
不是客户端 `SwingContact` 命中回执。当前 TS 只在 Wolf/Bear 的战斗边沿
发送它，和被动 FSM 不发送的行为一致。

服务端现在还把原生动物的近战能力显式分成 `attacker`、`passive` 和
`none`。Deer/Rabbit 仍保留 `Animals_*_Attack` 资源名和归一化接触窗口，因
为这些资源会参与受击/诊断链；但它们的 `meleeEnvelopeSource` 是
`not-applicable`，并且 `isMeleeTargetInEnvelope()` fail-closed，不会因为兼容
Machete 表或攻击 clip 元数据而意外进入攻击包络。只有 Bear/Wolf 明确声明
`attacker`，才使用当前标注为 `animal-engagement-projection` 的追击包络。

因此，“被动动物是否也应该发送 AggroLevel 才能跑起来”目前已有反证：共享
writer 的运动参数和 combat 分支是分开的。仍未闭合的是 graph 最终选中的
物种 leaf、root motion，以及 `SwingContact` 到玩家受击的 live 时序；这些不
能仅由上述静态 writer 证明。

这使当前实现的边界更明确：`Npc` 的 Machete 表仍只是兼容性数据，不能被称为
动物原生攻击定义。Wolf/Bear 的实际 FSM 包络现在使用各自显式的 AI 追击距离
作为 `animal-engagement-projection`；它不再取 Machete 的 `RANGE=1.5` 或
`MELEE_DETECT_WIDTH=0.15`，也不把 APX 身体胶囊冒充武器命中盒。真正要把
“玩家确实被动物击中”闭合，还需要同一实体上对齐客户端 leaf、播放倍率、
`SwingContact` 消费和受击反馈/网络结果。

攻击段以公共事件 `KnifeSlash` 进入图，图内有 `Attack`、
`Attack|Attack|Animals_Buck001_Attack1/2` 和 `Moving_NotMoving` 等节点；
type-`0x0d` 资源表又给出物种实际攻击资源：

| 物种 | 资源侧实际攻击 clip | 源时长（AnimalsX64.mrn） | 当前服务端状态 |
| --- | --- | ---: | --- |
| Wolf | `Animals_Wolf001_AttackB` | 1.667s | 追击/停步/KnifeSlash；包和 FSM 使用 1.667s，接触窗口仍是投影 |
| Bear | `Animals_Bear001_Attack01`（另有 Attack02 资源） | 1.000s（Attack02 2.133s） | 起身后追击/停步/KnifeSlash；物理图表只绑定 Attack01，包和 FSM 使用 1.000s |
| Deer/Buck | `Animals_Deer001_Attack` / BuckAttack | 2.667s | 被威胁后逃跑，不进入攻击状态 |
| Rabbit | `Animals_Rabbit001_Attack` | 2.333s | 被威胁后逃跑，不进入攻击状态 |

`WolfHowl` 和 `BearStandUp` 各只有一个明确公共 one-shot，服务端已经按
5.000s/5.333s 等待。当前 Wolf/Bear 的 `KnifeSlash` 包和 FSM 也使用表中
已绑定的源时长；这修正了所有动物共用 1430ms 的问题，但攻击 clip 的运行时
selector、图内 `SwingContact` 采样时刻和 root motion 尚未在同一 live 实体上
闭合。服务端现在会在动物 `KnifeSlash` 事件中显式写入静态恢复的
`NPC_AttackSpeed=1.0` baseline，但这仍不是 live 播放倍率或命中回执。

## 与当前 TS 的对照

1. Wolf/Bear 的巡逻和追击：服务端在巡逻使用 walk 意图，追击使用 sprint
   意图，并把 Recast 的实际位移速度写入 `PlayerUpdatePosition`；进入攻击
   前显式停止导航并发 standing 样本，避免把旧 sprint 速度泄漏进挥击。
2. Deer/Rabbit 的逃跑：服务端进入 flee 后使用 sprint 意图和更高的
   `ExpectedSpeed`，没有攻击 FSM；威胁消失或超时后停止旧路径，再回到 walk。
3. 速度“动态”：位置包里的 horizontal/vertical speed 是按相邻样本或
   Recast velocity 实测的，因而不是每 tick 都写死同一个位置速度；但
   `ExpectedSpeed` 的目标值仍是各状态的固定配置（Wolf 3.75/6.5、Bear
   3.25/5、Deer 3/7、Rabbit 1.75/5），不是已经恢复的原生连续速度曲线。
4. “所有动画正常”：目前不能确认。走、逃跑、嚎叫、起身的状态链路已有
   代码和测试覆盖；Wolf/Bear 攻击已经按各自已绑定的源 clip 时钟发送，
   但物种 selector、graph 播放倍率、脚底/root motion 和真实
   `SwingContact -> 命中/受击` 时序仍缺 live 对齐。未映射实体仍保留
   1430ms 兼容值并在诊断中标出来源。

## 2026-09-19：动物攻击包络的来源分离

`/ztest status` 现在同时输出 `meleeProfileSource` 和
`meleeEnvelopeSource`。对 Wolf/Bear，前者仍会显示兼容 Machete 表仅用于
旧 harness 的数据来源，后者显示 `animal-engagement-projection`；这两个字段
不能合并解读为“服务器已经拥有动物武器 hitbox”。服务端仍在原生
`SwingContact` 归一化时间窗内才尝试一次伤害，接触几何和客户端受击回执尚未
得到 live 验证。

## 2026-09-19：连续 locomotion 输入已接入实体契约

继续解包 `AnimalsPhysicsX64.mrn` 后，`Idle_Locomotion|Locomotion|BlendN1`
节点的输入确认是 `ControlParameters|VelocityLocalZ`，其 authored blend
points 为 `0.689, 1, 1.442, 2, 3, 4, 5, 6, 7, 8`。Wolf/Bear/Deer/Rabbit
实体现在携带这个只读 native profile；`Npc.setSpeed()` 保留区间内的连续
速度（不会把 3.75/6.5 等值量化为 walk/run 两档），但在 profile 存在时将
`ExpectedSpeed` 饱和到 native graph 的 8.0 上限。`/ztest status` 同时输出
profile 来源和 authored bands，便于把状态目标速度与实际位置包速度区分开。

这闭合了“客户端 locomotion 输入域”而不是“每个物种的真实根位移”。
`PlayerUpdatePosition` 仍以 Recast/相邻位置样本测量实际速度；攻击 selector、
根位移和 SwingContact 的 live 回执仍不能仅凭这个静态 blend 节点宣称已验证。

## 结论边界

可以确认“可攻击动物会进入 walk/chase/attack 状态、不可攻击动物会进入
flee/sprint 状态，位置流速度是测量值”；不能确认“所有攻击动画已经按原生
物种时钟、脚底接触和命中回执完全正确”。下一步仍应是同一连接实体上采样
攻击图实际选中的 leaf、运行时 `NPC_AttackSpeed`、`SwingContact` 和玩家受击时刻，
而不是继续调整一个统一距离或毫秒常数。

## 2026-09-20：当前生产链路回归结果

本轮又闭合了两个会让“看起来会跑”与实际状态脱节的服务端边界：

1. 动物已经追击后，晚进入相关范围的客户端现在按
   `PlayerUpdatePosition → Character.ExpectedSpeed → Character.SeekTarget`
   的因果顺序重放当前运动上下文；不会只收到位置/速度而缺少原生目标控制边。
2. 任意生产分支把速度置零时，`Npc.setSpeed(0)` 会同时清掉已安装的
   `Character.SeekTarget` rail。这样巡逻失败、攻击停步或逃跑结束不会继续沿旧
   目标滑动。

相关回归覆盖 Bear/Wolf 的追击、停步攻击、原生时钟和接触窗，以及 Deer/Rabbit
的逃跑、速度切换和失败闭合；当前相关测试为 **114 pass / 0 fail**。这证明服务
端状态与发送顺序已自洽，但仍不等于客户端原生 root motion 或
`SwingContact` 命中回执已经 live 验证。

## 2026-09-20：死亡边界先撤销移动控制器

又补上一个会把“死亡动作”和“残留移动”混在一起的确定性边界：`Npc.damage()`
在第一次进入死亡态后，现在先调用 `stopMovement()`，再发送
`Character.StartMultiStateDeath`。这会同时清掉 Recast 目标、`ExpectedSpeed` 和
已安装的 `Character.SeekTarget` rail，并发送必要的零速位置样本；此前击杀发生
在追击/攻击切换窗口时，客户端可能在死亡图接管前继续沿旧目标滑动。

新增回归覆盖“已安装 native seek rail 的 NPC 被致死时必须先发
`Character.ClearMovementRail`，再进入死亡包”的顺序。相关动物/NPC 回归现为
**117 pass / 0 fail**。这修复的是服务端死亡交接，不把死亡 leaf、ragdoll
或 root motion 的客户端实际渲染误报为已 live 验证。

## 2026-09-20：攻击后首次恢复移动使用真实位移样本

继续沿“起步滑步”边界检查时发现，`goTo()` 在没有相邻运动样本时会回退读取
Recast 当前速度。攻击停止后 Recast 可能已经恢复到 sprint 目标速度，但第一条
恢复位置包仍只是很短的加速位移；直接把目标速度写进该包会让客户端先切入跑步
图，再等待脚下位移跟上。

现在零速 `PlayerUpdatePosition` 会保存一个仅用于下一次恢复的停止锚点。恢复后的
第一条位置包优先用“停止锚点→当前位移”的真实时间/位移计算速度；同一时间戳
没有可测速率时保持 standing，不再用 Recast 的 sprint 目标速度冒充实际位移。
随后样本仍回到普通相邻位置速率。新增回归覆盖“Recast=6、首个 150ms 位移仅
0.1 时不进入 sprint 图”，相关 NPC locomotion 回归现为 **117 pass / 0 fail**
（完整动物/NPC 集合在下一次服务重载前再跑一遍）。这修复的是服务端位置包的
首帧速度来源，不把它当成客户端 root motion 已经 live 验证。

## 2026-09-20：排除 `0x8322` 作为动物接触回执

对固定客户端 `FUN_14092b880` 做了完整反编译。该函数在
`param_1 + 0xe60 != 0` 时构造 `local_40=0x83`、`local_38=0x22`，并把
`param_1 + 0xec4` 写入 payload 后交给 `FUN_140921a80`；仓库的 1080 协议表把
这个 opcode 明确命名为 `Weapon.MeleeHitMaterial`，字段只有
`materialType:uint32`。因此它是客户端武器近战材质上报/提示路径，不能据此把
它接到动物 `AnimalsPhysics.SwingContact` 或当作服务器收到的动物命中确认。

该函数的 Ghidra `xref-from` 目前为 0（经由间接回调/虚表进入），所以不能仅凭
调用位置把它重新解释成动物专用包。当前 TS 继续保持 `Weapon.MeleeHitMaterial`
处理为空、动物伤害使用服务端投影并显式标注 `liveVerified=false`，避免把一个
通用玩家武器包误接入动物伤害权威链。

## 2026-09-20：同目标速度变化同步到原生 SeekTarget

又发现一个与“速度动态”直接相关的服务端缺口：`Character.SeekTargetUpdate`
只携带目标 GUID，不携带 `speed` 或 `acceleration`。此前同一动物持续追击同一
目标时，服务端虽会更新 Recast 的 `maxSpeed` 和 `Character.ExpectedSpeed`，但
原生 seek rail 会继续保留第一次安装时的速度。现在 `Npc` 记录已安装 rail 的
速度；同一目标发生真实速度变化时重发完整 `Character.SeekTarget`（包含新的
加速度、速度和方向），相同速度仍保持原有 400ms 的 GUID 更新限流。这样
ExpectedSpeed、Recast 和原生 seek controller 不会分叉。

新增回归覆盖了 5→6.5 的同目标速度切换，以及不经过 AI target 刷新的直接
`setSpeed()` 速度修正；相关动物/NPC 测试现为 **116 pass / 0 fail**。这只闭合
服务端速度意图同步，不把客户端最终 root motion 或步态脚底对齐误报为已验证。
