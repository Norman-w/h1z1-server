# NPC 全类型客户端画面确认 — 2026-09-22

本记录把 `/api/animal-test` 的服务端时间线和真实 `H1Z1.exe` 画面逐项对齐。
目标是确认“实体确实被客户端渲染、移动/动作边沿可见、攻击/逃跑/特殊效果在画面中出现”，
而不是把服务端的 `state` 字段误当成客户端已经播放成功。共检查 14 个 harness 类型；
`PASS` 表示画面确认成功，`NEGATIVE` 表示已经确认到客户端没有可见模型（不是未测试）。

## 测试条件

- 客户端：`H1Z1 v0.195.4.147586`，直接运行 `H1Z1.exe sessionid=0 server=localhost:1115`。
- 服务端：`127.0.0.1:13371` Dev HTTP；每次先清理旧实体，再用 flat spawn，距离通常为 8 m，
  兔/basic 追加 4 m 近距离复核。god mode 只用于保证连续取证，不把“玩家未掉血”当成受击动画通过条件。
- 录制器：`ZTestRecorder.exe`。录制器子进程改为 `windowsHide:false`，并支持
  `ANIMAL_TEST_DISTANCE`，以便 RDP 桌面和近距离实体都能稳定取证；改动在
  [`scripts/run-animal-test-capture.cjs`](../../../scripts/run-animal-test-capture.cjs)。
- 证据目录中的 MP4/PNG/JSONL 是本机取证产物，体积较大，保持未跟踪；本文件只提交可复核的
  文件名、帧数和状态摘要。

## 逐类型画面结果

| 类型 | 画面证据（本机文件） | 画面中确认到的内容 | 时间线交叉证据 | 结论 |
| --- | --- | --- | --- | --- |
| `zombie` | `zombie-daylight.mp4`（47 帧），`zombie-daylight-middle.png` | 实体从远处进入镜头，接近后停步并出现挥击姿态/接触叠加 | `chase → attacking`，`KnifeSlash`；接触 5 次、伤害标志 10 次 | **PASS** |
| `zombie_female` | `zombie_female-daylight.mp4`（46 帧），`zombie_female-daylight-mid.png` | 女性僵尸模型可见，接近、近战姿态可见 | `chase → attack/attacking`，`KnifeSlash`；接触 3 次 | **PASS** |
| `screamer` | `screamer-daylight.mp4`（29 帧），`screamer-daylight-mid.png` | 尖叫者实体、尖叫后的幽影/画面效果可见（HUD 显示 Banshee's Call） | `rising → Screaming → chase`；`ScreamerRise`、`Scream` | **PASS** |
| `gasser` | `gasser-daylight.mp4`（36 帧），`gasser-daylight-mid.png` | 人形模型和绿色毒雾同时可见，释放后姿态改变 | `attack/attacking`；`GasConvulse`；毒雾分支不落入近战伤害 | **PASS** |
| `exploder` | `exploder-daylight.mp4`（42 帧），`exploder-daylight-mid.png` | 爆炸者模型、膨胀/爆炸前效果可见，随后实体消失 | `chase → attacking`；`ExplodeExpand`、`ExplodeContract` | **PASS** |
| `prototype_assault` | `prototype_assault-daylight.mp4`（42 帧），`prototype_assault-daylight-mid.png` | 橙褐色装甲原型模型接近并进入近战姿态 | `chase → attacking`，`KnifeSlash`；接触 6 次 | **PASS** |
| `prototype_hunter` | `prototype_hunter-daylight.mp4`（44 帧），`prototype_hunter-daylight-mid.png` | 白色装甲原型模型清晰可见，接近/挥击姿态可见 | `chase → attacking`，`KnifeSlash`；接触 2 次 | **PASS** |
| `prototype_sniper` | `prototype_sniper-daylight.mp4`（43 帧），`prototype_sniper-daylight-mid.png` | 白色战术原型模型清晰可见并进入近距离动作 | `chase → attacking`，`KnifeSlash`；接触 5 次 | **PASS** |
| `bear` | `bear-clean.mp4`（53 帧），`bear-clean-contact.jpg` | 熊从镜头外进入，站起、靠近并在玩家旁出现攻击姿态 | `standingUp → chase → attacking`；`StandUp`/`KnifeSlash`；接触 4 次 | **PASS** |
| `wolf` | `wolf-daylight.mp4`（30 帧），`wolf-daylight-crop-14.png`、`wolf-daylight-crop-20.png` | 狼在亮场中从远处进入镜头并持续改变位置；近战阶段由时间线与画面实体对应 | `howling → chase → attacking`；`WolfHowl`/`KnifeSlash`；接触 4 次 | **PASS** |
| `deer` | `deer-clean.mp4`（47 帧），`deer-clean-contact.jpg` | 小鹿在树林/坡地下方可见并向外逃跑 | `wander → flee`；sprint，速度样本 3–7 | **PASS** |
| `deer_buck` | `deer_buck-clean.mp4`（57 帧），`deer_buck-clean-contact.jpg` | 公鹿模型在亮场中可见并持续逃离镜头 | `wander → flee`；sprint，速度样本 3–7 | **PASS** |
| `rabbit` | `rabbit-clean.mp4`（66 帧）；另做 4 m 直接刷出截图复核 | 服务端 actor 存在，但整段有效视频和近距离直接画面均没有任何兔子模型/动作像素 | actorModelId `9212`、profile `85`，状态 `idle/flee`；客户端没有可见渲染结果 | **NEGATIVE：客户端模型缺失/未绑定** |
| `basic` | `basic-clean.mp4`（66 帧）；另做 4 m 直接刷出截图复核 | 服务端生成后画面仍只有场景和玩家，没有可见 NPC 模型 | actorModelId `9230`、profile `0`，状态为空/`Idle`，无 native locomotion/melee profile | **NEGATIVE：仅兼容 fallback，不是可玩 NPC** |

## 结论与边界

- 已完成 14/14 类型的真实客户端画面检查：12 类通过可见实体/动作或特殊效果确认，2 类明确确认
  为客户端没有可见模型。因而“画面确认”没有未完成项，但 `rabbit` 和 `basic` 不能宣称已经具备可玩性。
- 服务器时间线中的 `attackDamageApplied`、接触窗口和动画事件仅证明服务端投影/状态机边沿；本轮
  god mode 下不把玩家伤害数值当成客户端受击动画证明。`AnimalsPhysics.SwingContact`、root-motion
  所有权以及玩家 flinch 仍按既有架构边界单独记录。
- 录制视频和 JSONL 保留在本机取证目录，未将大量媒体文件提交到仓库；需要复核时直接打开表中同名文件即可。
