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
