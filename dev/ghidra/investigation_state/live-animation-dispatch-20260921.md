# Live native animation dispatch capture — 2026-09-21

本轮先把一个正在运行的普通客户端（PID `48652`），随后把一个新鲜客户端
（PID `47724`）附加到 x64dbg bridge，
没有写入客户端内存，也没有改客户端二进制。服务端仍是当前工作树的本地
2016 server，客户端进入世界后由 `/api/animal-test {command:flat,type:wolf,
distance:8,height:0}` 刷出一只 Wolf。

## 已经现场命中的原生函数

所有地址均以 `h1z1.exe` 基址 `0x140000000` 加 Ghidra RVA 计算；bridge
在命中时用 `expect_h1_rva` 校验了 CIP，避免把其它断点/异常当成目标函数。

| 目的 | RVA / 运行时 CIP | 结果 | 现场寄存器/内存 |
| --- | --- | --- | --- |
| `AnimalsPhysics.SwingContact` 注册回调 | `0xaa7450` / `0x140aa7450` | 命中两次，`debugee_pid=48652` | `rcx=0x1350...` owner/context，`rdx=0x7ed...` event context |
| NPC 接触消费者 (`NPC vtable + 0x790`) | `0x51a900` / `0x14051a900` | 命中；过滤器先丢弃 1 个非目标停止后命中 | `rcx=0x975d5e00`，其首指针为 NPC vtable `0x1420c1de0`；捕获了 entity 与 contact/context 两段内存 |
| 原生 motion 插值器 | `0x4de900` / `0x1404de900` | 命中；过滤器无误报 | `rcx=0x1006a6c40`，`rdx=0x322fce8`；可读到相邻 motion-record/队列相关数据 |
| motion record 入队 (`AddMotionRecord`) | `0x4dcff0` / `0x1404dcff0` | 在第二个新鲜客户端上命中；`expect_h1_rva` 过滤通过 | `rcx=0x8b...` motion component，`rdx=0x10a...` record；读到记录头、时间/版本相关字段和有限的姿态/速度数据 |
| motion record 输出 | `0x3b4410` / `0x1403b4410` | 命中；过滤器丢弃 1 个非目标停止后命中 | `rcx/rdx` 指向输出记录与目标组件，读到 position/orientation/速度字段 |

对应 bridge 日志为：

```text
dev/x64dbg-bridge/logs/daemon-20260921-031440.jsonl
dev/x64dbg-bridge/logs/daemon-20260921-032856.jsonl
```

日志中 `wait_capture_resume` 的 `snapshot.cip` 与上表逐项相等，且每次都
记录了对应的 `debugee_pid`（`48652` / `47724`）。这证明了两件事：

1. 客户端实际运行时会分发 `SwingContact`，并进入 NPC 的接触消费函数；
2. 客户端确实有时间戳 motion queue 的入队、插值和输出链，且这条链在
   两个真实进程阶段被执行，不能再把“客户端完全不动”解释为服务端没有发包。

## 没有被误报为已完成的部分

- `0x14051a900` 的现场调用没有产生一个可识别的 SOE/C2S 命中 ACK；静态
  路径也没有找到可证明的“动物 `SwingContact` → 服务端受击确认”包。因而
  `Npc.getNativeContactContract().liveVerified` 仍必须是 `false`，服务器继续
  以自己的接触投影授权伤害，不能把本地 callback 当成权威伤害。
- 第二个新鲜客户端（PID `47724`）上已命中 `0x1404dcff0`（AddMotionRecord 入队边界），
  因而“服务端位置样本是否进入客户端 motion queue”这一层已被现场闭合；
  但入队记录本身仍需和同一 NPC 的动画 graph leaf/`VelocityLocalZ`、脚底
  接触逐帧对齐。`0x1404de900 → 0x1403b4410` 只证明插值/输出，不证明
  动画 clip 的 root motion 已取代服务器位置流。
- 因此源码中的 `clockVerified`、`contactEventVerified` 和
  `rootMotionVerified` 保持 `false` 是有意的边界，不是漏改的“成功”标志。

## 同一链条的新鲜动态样本（PID `42072`）

为避免加载期断点影响登录，本次先让客户端完整进入世界并开启 god mode，
再由 `/api/animal-test` 在约 15m 处刷出 Wolf，然后只在运动发生后短时设置
断点。客户端在 `0x1404dcff0`（`AddMotionRecord`）现场命中：

```text
rcx = 0x391c3440   motion component
rdx = 0x00109fd0   motion record
r8  = 0x1420b9900  component/vtable-side context
```

记录 `rdx+0x10` 的四个 float 为 `(-3340.44995, 11.54, 2366.75, 1.0)`，与
服务端该 Wolf 的 spawn/首个位置样本
`(-3340.4199, 11.50699, 2366.82, 1)` 在厘米级范围内一致；记录的
`+0x110..+0x117` 原始时间字段为 `1fff 0000 d1853900`（小端），
`+0x148` 原始版本 dword 为 `0x100`。这不是动画 clip 自己推导出的位移，
而是带时间/版本的网络 motion record 进入客户端组件的现场证据。

同一 PID 随后在两个下游点命中：

| 阶段 | RVA / CIP | 关键现场 |
| --- | --- | --- |
| motion 插值 | `0x4de900` / `0x1404de900` | `rcx=0x391c3440`，`rdx=0x040efce8`，`r8=0xf97a4460` |
| motion 输出 | `0x3b4410` / `0x1403b4410` | `rcx=0x044efa50`，`rdx=0x044ef5f0`，读到输出对象的姿态/位置缓冲 |

因此可以把 Root Motion 的职责边界再收窄：真实客户端确实执行
`AddMotionRecord → Interpolation → Output`，并且入队记录的位置和服务端
位置样本相符；本轮没有发现“攻击动画 root delta 另行写回实体世界坐标、
绕过 motion record”的运行时证据。为了避免把“未发现”说成“已证明不存在”，
`rootMotionVerified` 仍保持 `false`；当前可确认的是服务器位置流是客户端
可见连续运动的输入，动画图只消费其速度/姿态状态。

本次追加日志：

```text
dev/x64dbg-bridge/logs/daemon-20260921-035742.jsonl
```

## SwingContact 后的动画图队列（PID `49136`）

在另一个完整连接的 Wolf（约 8m）窗口中，按静态调用链逐点换装断点并用
`expect_h1_rva` 过滤，实际命中下面四个函数：

| 阶段 | RVA / CIP | 关键现场 |
| --- | --- | --- |
| NPC 动画事件转发 | `0x5243f0` / `0x1405243f0` | `rcx=0x7c8...` entity/graph object；`rdx` 出现 `805`、`8120` 等事件句柄值 |
| graph queue 入队 | `0x139a9f0` / `0x14139a9f0` | `rcx=0xfe2bf640`；`rdx=8120`；可读到对象队列区域 |
| graph queue drain/映射 | `0x139a730` / `0x14139a730` | `rcx=0xfe2bf640`；`rdx=0x0363f560` 事件记录；`r10=3` |
| 本地图提交 | `0x195fd20` / `0x14195fd20` | `rcx=0x113a04000`（对象 `+0x918` 侧）；`rdx=0x04a3f168` message |

四个命中之间没有跳进 Gateway/SOE 发送函数，也没有出现服务端可消费的
`SwingContact` ACK 字段；`rdx` 在第一站是小整数事件句柄，后两站才变为本地
事件记录/消息指针。这与静态 `14139a9f0 → 14139a730 → 14195fd20` 链一致：
它是客户端本地动画图队列，不是“客户端把命中回传给服务端”的网络确认。
因此服务端伤害仍由自己的接触投影和目标状态决定，`liveVerified` 继续保持
`false`；这次动态证据只是把“事件确实进入本地 graph queue”从静态推断提升
为现场命中。

## 下一步边界

要把 Root Motion 真正闭合，需要在一个新鲜连接的同一 NPC 上同时抓到
`0x1404dcff0` 的入队记录、其 `+0x118`/版本字段和动画 graph 的实际
`VelocityLocalZ`/选中 leaf，再与服务器的 `PlayerUpdatePosition` 时间线
对齐。要把 ACK 闭合，需要继续沿 `0x14051a900` 的目标 vtable descendants
追到网络出口，或在同一命中窗口抓到实际 C2S 包；目前不能用固定距离/固定
延迟代替这两个证据。

## SwingContact 同一客户端的再次现场闭合（PID `51872`）

本次让普通客户端完整进入世界后，在服务端以 4m 水平距离刷出 Wolf，随后
仅在接触链函数短暂停顿。断点均用 `expect_h1_rva` 校验，避免把登录/渲染
线程的其它停止误判为目标事件。客户端现场依次命中：

| 阶段 | RVA / 运行时地址 | 现场关键值 | 结论 |
| --- | --- | --- | --- |
| `AnimalsPhysics.SwingContact` 回调 | `0xaa7450` / `0x140aa7450` | `rcx=0x11d...`、`rdx=0xf8...` | 动物接触回调确实由客户端碰撞/姿态链触发 |
| NPC 接触消费者 | `0x51a900` / `0x14051a900` | `rcx` 指向 NPC 对象，`rdx` 为接触上下文 | 回调进入 NPC 自身的接触处理入口 |
| 本地事件转发/入队 | `0x5243f0` / `0x1405243f0` | `rdx=808`（事件句柄） | 事件被转成动画图事件，而不是伤害网络包 |
| graph queue 入队 | `0x139a9f0` / `0x14139a9f0` | `rdx=719`/`808`，`rcx` 为队列对象 | 事件进入本地动画图队列 |
| graph queue drain | `0x139a730` / `0x14139a730` | `rdx` 指向事件记录，`r10=3` | 本地队列被排空并映射为图消息 |
| 本地图提交 | `0x195fd20` / `0x14195fd20` | `r8=808`，`rcx` 为 `network+0x918` 侧对象 | 最终提交仍在客户端动画图内部 |

本次日志为：

```text
dev/x64dbg-bridge/logs/daemon-20260921-045156.jsonl
```

从回调到本地图提交的完整窗口内没有 Gateway/SOE/C2S 出口，也没有可供服务端
消费的 `SwingContact` ACK 字段。因而这次现场证据把职责边界进一步固定为：

* 客户端负责动画图、碰撞/姿态接触回调和本地受击表现；
* 服务端继续用自己的导航、接触包络和目标状态判定是否授权伤害；
* `clockVerified`、`contactEventVerified`、`rootMotionVerified` 和
  `nativeContactContract.liveVerified` 不能因为命中本地回调而改成 `true`。
