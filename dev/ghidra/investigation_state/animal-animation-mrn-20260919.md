# 动物动画源时长审计（2026-09-19）

`tools/audit-animal-animation-mrn.py` 对客户端解包的
`AnimalsX64.mrn` 做只读解析。该资源有 117 个 packet，其中 59 个动画
packet 和一个文件名表；动画 packet 的共同头部直接给出源 clip 的采样率和
时长，文件名表把索引关联到 `.nsa`/`.xmd` 资源。

审计结果（时长均为源 clip 时长，30 FPS）：

| 物种 | 走路 clip | 跑/冲刺 clip | 攻击 clip | 备注 |
| --- | --- | --- | --- | --- |
| Wolf | `WalkB` 2.000s | `RunB` 1.333s / `Sprint` 1.000s | `AttackB` 1.667s | 当前 Wolf 实体把该资源时长带入 `KnifeSlash` 时钟；仍需实机确认 selector |
| Deer | `WalkB` 2.000s | `RunB` 1.333s / `SprintB` 2.000s | `BuckAttack` 2.667s | 当前服务端是被威胁后逃跑，不应进入攻击事件 |
| Bear | `WalkB` 1.500s | `Run` 1.400s / `Sprint` 1.067s | `Attack01` 1.000s / `Attack02` 2.133s | 当前物理图文件名表只绑定 `Attack01`，服务端按 1.000s；`Attack02` 仍未选用 |
| Rabbit | `Walk` 1.533s | `Run` 1.467s / `Sprint` 1.067s | `Attack` 2.333s | 当前服务端是被威胁后逃跑，不应进入攻击事件 |

另外，非攻击动作也有独立源时长：Bear `RearUp=5.333s`，Wolf
`Howl=5.000s`。FSM 已按这两个原生 clip 时长等待动作结束，再恢复追击；这
避免服务端提前发 sprint 位置流把起身/嚎叫动作截断。

这项证据能确认：

1. 原生走、跑、冲刺和攻击不是一个统一时长，且不同物种不同；不能用一个
   `1s` 或临时 Machete 的 `850ms` 解释全部动作。
2. 当前服务端的动物 FSM 已把 `walk`/`sprint` 意图和 Recast 实际速度分开，
   攻击状态也会先停导航再发公共 `KnifeSlash` 事件。
3. 这仍不能宣称“所有动画正常”：当前 Wolf/Bear 的
   `Character.PlayAnimation.unknownDword2` 和 FSM 等待已切到资源侧的
   `AttackB=1.667s` / `Attack01=1.000s`，不再共用临时 Machete 的 1430ms；
   但同一实体上的实际 selector、graph 速度修正、root motion 和
   `SwingContact` 消费仍没有 live 对齐证据。1430ms 只保留给没有原生 clip
   映射的兼容实体/测试桩。

因此本审计把已绑定的源时长用于动作包/FSM 的“动作结束时钟”，但不把它
冒充成客户端命中回执，也不直接决定伤害；真正的接触仍由当前候选包络在
归一化窗口内持续投影检查，直到 live `SwingContact` 闭环完成。

复现（Git Bash）：

```bash
python3 tools/audit-animal-animation-mrn.py \
  --output /tmp/animal-animation-mrn-20260919.json
```
