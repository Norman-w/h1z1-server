# 资源侧锚点

## 僵尸 Actor 定义

- `ZombieMale_Skin_01.adr` / `ZombieFemale_Skin_01.adr`
- `<AnimationNetwork fileName="ThirdPersonZombiePhysics.mrn" animSetName="Zombie001" />`
- `MaterialType="ZOMBIE"`

## 解包后实际文件名

- `ThirdPersonZombiePhysicsX64.mrn`
- `ThirdPersonZombie_AnimationX64.mrn`
- `ThirdPersonZombieAIX64.mrn`
- ADR 中 `ThirdPersonZombiePhysics.mrn` 为运行时逻辑名

## 攻击状态机词表（ThirdPersonZombiePhysicsX64.mrn）

`Attack_Grapple`、`AttackMove_Ping/Pong`、`AttackStand_Ping/Pong`、`Attack_Walker`、`Attack_Runner`、`Spit`、`GrappleLoop`、`Bite`、`LostTarget`、`StuckBehindFence*`

## 控制参数（MRN 资源）

- `InAttack`
- `Npc_AttackSpeed` / `NPC_AttackSpeed`
- `AttackRegion`
- `HeadLookTarget`
- `DeathType`
- `ControlParameters|...`

## 图层级状态名（ThirdPersonZombieAIX64.mrn）

`Idle_Locomotion`、`DeathOrDormant`、`Feeding`、`PushbackOrFalls`、`Flinch`、`Attacks`

## InAttack 的真相

> `InAttack` 不在二进制字符串表中。是 MRN 内部的 ControlParameter。不由 gameplay 通过 +0x630 直接写入，而是 MRN 图在收到攻击触发器后自动设置。

## 动物共享 AI

- `AnimalsPhysicsX64.mrn` 含 `InAttack`
- `Wolf001.adr` / `Deer001.adr` / `Rabbit_Tan.adr` / `Bear_Brown.adr` 指向同一 `AnimalsPhysics.mrn`
- profileId: Zombie=11, Deer=22, Wolf=23, Bear=24
- 鹿见人跑，狼/熊会追击玩家

### `Character.PlayAnimation` 事件名与图内部节点

资源末端的公共事件表包含 `Idle`、`KnifeSlash`、`StandUp`、`WolfHowl`、
`Eating`、`MeleeFlinch` 等名字。它们才是服务端 `Character.PlayAnimation`
应发送的事件名；`Attack` 和 `BearStandUp` 是 `AnimalsPhysics` 图内的节点/路径，
不能直接拿来替代公共网络事件。`StandUp` 会由 `Bear001` 图选择
`BearStandUp|Animals_Bear001_RearUp` 分支，`KnifeSlash` 会由物种图选择实际攻击
clip。这个区分已经由资源字节表和动物实体回归测试固定下来。

### `SwingContact` 接触窗口

对 `AnimalsPhysicsX64.mrn` 的结构化 `SwingContact` 记录按物种资源段归属得到：

- Wolf001：约 `0.259999–0.740001`
- Deer001：约 `0.300000–0.700000`
- Bear001：约 `0.266667–0.733333`
- Rabbit001：约 `0.214286–0.785714`

这些值是攻击片段内的归一化事件窗口，不是秒数，也没有被当作固定毫秒延迟；服务端在已审计的熊/狼攻击状态中只于该窗口内持续检查候选包络，目标在窗口中途进入才可命中，窗口外不会提前消费接触。绝对动画时钟、客户端实际 leaf 和 root motion 仍需实机对齐。

### `MeleeDuration` 的网络时钟边界

原生 `Character` case 3 解析器把 `Character.PlayAnimation` 的 `unknownDword2`
（解析结构 `+0x30`）传给 `FUN_140524380`，再乘以二进制中的
`DAT_142047918 = 0.001f` 写入 `MeleeDuration`。1430 因此对应 `1.430s`，但它
只是此前单一 `KnifeSlash` 网络探针/兼容值，不是所有动物共用的原生时长。当前
已把资源图中明确绑定的攻击 clip 时钟接到具体实体：Wolf=`1667ms`
(`Animals_Wolf001_AttackB`)，Bear=`1000ms` (`Animals_Bear001_Attack01`)；未
完成 clip 映射的兼容实体仍使用 `1430ms`。服务端攻击 FSM 与发送包使用同一
实体时钟，不能继续使用临时 Machete 表的 `850ms`。已有单一资源时长的
`WolfHowl` 与 `StandUp` 另携带 `5000`/`5333` 毫秒，以免服务器等待完整动作而
客户端提前结束。攻击分支仍不等于已验证客户端脚底帧、root motion 或真实
`SwingContact` 命中回执。

动物 `KnifeSlash` 还通过同一 `Character.PlayAnimation` 的可选图参数对写入
`NPC_AttackSpeed=1.0`。这是客户端共享 locomotion/graph writer 已恢复的
native baseline，不是把僵尸的 `AttackRegion` 或 `MeleeDuration` 伪装成动物
参数；真实攻击 selector、运行时倍率和 `SwingContact` 消费仍需实机对齐。

### `ExpectedSpeed` 与位置流速度单位

客户端注册表把 `Character.ExpectedSpeed` 定义为 `0x0f0b`、`float speed`。
原生包分发器中它对应 `param_2 - 1` 的 `case 0x0a`，解析后的浮点数写入
实体字节偏移 `+0xda8`；原生诊断也从同一字段显示 `Expected speed`，静态
代码中可见 `5.0f` 与 `8.0f` 的普通写入。Recast 的位置是服务端世界坐标，
所以 `PlayerUpdatePosition.horizontalSpeed/verticalSpeed` 必须与
`ExpectedSpeed` 使用同一套游戏速度单位。服务端不再在这两条流之间套用未经
证明的 `3.28084` 英尺换算，避免“期望速度 5、位置流速度约 16.4”这种
客户端步态输入不一致。这个修正只闭合了速度单位合同，不能单独证明每个
动画 clip、脚底接触或 root motion 已同步。
