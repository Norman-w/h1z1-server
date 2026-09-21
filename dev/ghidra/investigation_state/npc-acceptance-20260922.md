# NPC 动画、移动与接触验收记录 — 2026-09-22

本记录对应分支 `feature/z1-nav-resources`、提交 `1374ac6bb5fcb805d47d56fa8c4d4f0eb468ae1d`。
目标是把“服务端状态/位置/伤害”和“客户端动画图/运动插值”分开验证，而不是把
服务器状态字段当成客户端逐帧动画已经正确的证明。

## 自动化 gate

以下命令在当前提交上通过：

```text
node --import tsx --test \
  tests/animalAi2016.test.ts tests/animalLocomotion2016.test.ts \
  tests/npcLocomotion2016.test.ts tests/npcMotion2016.test.ts \
  tests/characterAnimationRequest2016.test.ts tests/animalEntityWiring2016.test.ts \
  tests/animalProfiles2016.test.ts tests/animalSpawn2016.test.ts \
  tests/animalTestHarness2016.test.ts tests/fullNpc2016.test.ts \
  tests/zombieNpcIngress2016.test.ts
```

结果：`165` tests、`165` pass、`0` fail。`npm run build-all`（`tsc -p ./tsconfig.json`）
退出码为 `0`。

`npm test` 仍不能作为本轮 gate：仓库现有 `tsconfigs/tsconfig-tests.json` 的
`rootDir`/module 编译约束会在测试启动前失败。另有一组旧的 `zombieAi2016` 测试
默认加载残留的 `out/servers/ZoneServer2016/managers/aimanager.js`；该文件不在当前
源树中，因而会产生 `beginTestRouteMotion is not a function` 等旧构建不一致错误。这些
不是本轮 focused NPC gate 的结果，不能混写成“全仓库测试通过”。

## 实机条件

- 客户端直接运行 `H1Z1.exe sessionid=0 server=localhost:1115`，没有依赖 h1emu
  作为客户端启动器。
- 服务端 Dev HTTP 在 `127.0.0.1:13371`，使用 `/api/animal-test` 生产实体和
  `/api/animal-test` 的 `status` 读取服务器状态。
- 进入世界后开启 god mode；平地、山坡和合成高度差场景都使用同一位置/导航投影
  流程。视觉截图先在白天取得，随后游戏默认时钟自然推进到夜间；夜间截图只用于
  确认实体存在和姿态，不把光照当成动画证据。
- 原生动态链现场证据见
  [`live-animation-dispatch-20260921.md`](live-animation-dispatch-20260921.md)：
  `AddMotionRecord → interpolation → output` 被真实客户端执行，
  `AnimalsPhysics.SwingContact` 也被真实客户端触发。

## 逐类型结果

`probe-all-npc-animation.cjs` 对下列 14 个 harness 类型逐个刷出、采样
`0..6000 ms`、最后清理；状态字段中的 `state`、`expectedSpeed`、
`activeAnimation`、接触窗口和伤害标志均来自同一个生产 NPC 实例。

| 类型 | 服务端状态/动画证据 | 客户端画面证据 | 结论 |
| --- | --- | --- | --- |
| `zombie` | `wander → chase → attacking`；`KnifeSlash` 停止移动；接触窗口内 `attackDamageApplied=true` | 近距离直立、攻击姿态和受击红屏 | 通过 |
| `zombie_female` | 同一普通僵尸 FSM、动态追击速度和 `KnifeSlash` | 本轮未单独保存截图 | 状态通过 |
| `screamer` | `ScreamerReset → rising → Screaming → chase`，有 `ScreamerRise`/`Scream` 时钟 | 真实 Banshee’s Call 后恢复为可见追击实体 | 通过 |
| `gasser` | 追击先保持速度，进入动作包络后停步；`GasConvulse`/`Stagger_Light` 不落入近战伤害分支 | 黄色气云和动作姿态 | 通过 |
| `exploder` | 近战包络/动作后实体被移除；状态样本确认爆炸完成 | 爆炸前直立攻击姿态；随后实体消失 | 通过 |
| `prototype_assault` | 生产 prototype FSM，追击→停步→`KnifeSlash` | 本轮未单独保存截图 | 状态通过 |
| `prototype_hunter` | 同上，使用其 profile/动画时钟 | 本轮未单独保存截图 | 状态通过 |
| `prototype_sniper` | 同上，使用其 profile/动画时钟 | 本轮未单独保存截图 | 状态通过 |
| `bear` | `standingUp` 完成后追击；native engagement `2.5 m`；SwingContact 投影命中 | 直立熊、张口攻击姿态 | 通过 |
| `wolf` | `howling → chase → attacking`；native engagement `2 m`；接触窗口内伤害标志 | 本轮实体跑出当前第三人称视野 | 状态通过 |
| `deer` | 看到玩家进入 flee sprint，脱离威胁后回 `wander`；速度由位移样本得出 | 可见鹿向坡下逃跑 | 通过 |
| `deer_buck` | flee sprint、`nativeGaitReady=true`，测得水平速度约 `2.50 m/s` | 本轮逃出当前视野 | 状态通过 |
| `rabbit` | 被目标驱离后位置从出生点远离约 50 m，随后回 `idle`；没有攻击分支/伤害 | 本轮截图时已逃出当前视野 | 状态通过 |
| `basic` | harness 的通用 fallback，状态为空/Idle | 不是生产动物 profile | 仅作兼容回归，不列入 NPC 可玩类型 |

## 高度差与攻击接触

1. 合成 `/api/animal-test {command:"slope",type:"bear",distance:6,height:3}`：
   熊最终以水平距离约 `2.15 m`、垂直差约 `3.36 m` 进入 `attack`，
   `meleeInEnvelope=true`、`attackDamageApplied=true`。这验证了原生动物使用
   已审计的水平 engagement projection，而不是用网络实体原点 Y 错误拒绝车顶/台阶目标。
2. 普通僵尸仍使用武器表的 `RANGE=1.5 m` 和完整 3-D 距离/方向投影；高度差增加到
   约 `1.2 m` 时，3-D 距离约 `1.75 m`，状态保持追击而不提前挥空。这是接触几何
   的失败关闭行为，不是把攻击距离调大来“适配”画面。
3. 所有近战 FSM 都在动作边沿先 `stopMovement()`，伤害只在武器/原生动作的接触窗口
   且仍在包络、未被导航遮挡时应用；玩家存活时会发送对应的 `Flinch`/方向反应。

## 仍明确保留的边界

- `AnimalsPhysics.SwingContact` 是客户端本地动画图回调；当前现场没有发现可证明的
  C2S/SOE contact ACK。因此 `liveVerified=false` 是有意的，服务端以自己的投影/武器表
  授权伤害，不把客户端回调伪装成权威确认。
- 真实客户端的 motion record 入队、插值和输出已经命中，但尚未证明攻击 clip 的
  root-motion delta 会替代服务器位置流；`rootMotionVerified=false` 仍然正确。
- `/api/animal-test` 是确定性验收 harness，不是生态刷怪系统；热区密度、气味/声音
  传播和远处视野外缓冲刷怪不在本轮 NPC 动画 gate 内。
- 复杂真实障碍物（车辆、可破坏门、动态建筑）需要在有可复现地图坐标后再做一次
  视频验收；当前已覆盖 Recast 直线遮挡和合成高度差。

## 验收结论

当前提交达到“服务端 NPC 状态、位置、动画边沿、伤害/受击反馈和特殊技能均可回归，
并有客户端实机证据”的验收线。上面列出的客户端本地接触确认、root-motion 归属、
生态刷怪和少数类型未单独截图是已知架构/证据边界，不应被宣称为已经完成。
