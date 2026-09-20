# 待解问题与优先级

## 最高优先级

1. **为何 UpdateCharacterState RAW 包无效果**
   - **已对齐（服务端仓库事实）**：DevHttp **`ucs-case9-*`** 发 **22B** = **`H1Z1Protocol.pack`** 的完整包（2B opcode + 8B characterId + 12B schema 尾）；**T0** = **`getTruncatedU32()`**；**characterId** = **`uint64string` 与 `sendData` 同源编码**（`devhttpserver.ts`）。
   - **解析器期望（逆向事实）**：`FUN_1404f1080` 从完整包首消费 **22B**（re-track / `FUN_1404f1080`）；旧的“characterId 后 22B”是对临时对齐探针的误读。
   - **已排除（re-track）**：「队列机制不存在」——case 9 链上 **`FUN_14053d4e0` 入队** → **`FUN_1404e1de0` → `FUN_14071b000`**；**`FUN_140526310`** 消费 **`0x1170`** 并写 **`0x35b`**。
   - **仍优先查（未闭合）**：**0x0f0a 收包后是否进入 `FUN_140511840` 的 `FUN_1404f1080` 分支**（上层传给 **`param_2` 须为 10**——`switch((int)param_2-1)` 下 decompile **`case 9:`** 对应 **`param_2==10`**，与 wire 首字节 **A0** 无必然相等）；**characterId 解析到的 entity 是否即所见僵尸**；**多连接时接收端是否选对**；**包顺序/其它使能**（与 #4 联动）。  
   - **注意**：「无可见效果」是**观测**，**不能**单独反证「未进解析器」或「未改内存」。

2. **states6.bit2 / bit3 到「看得见」动画的剩余缺口**
   - **已确认**：**`FUN_14053fde0`** 读 **`0x8cf` bit2/bit3**（及 **`0x8ca`**）驱动 **`iVar13`**
   - **已确认**：**`FUN_1404ff870`** 根据 **`entity+0xa3`** 写 **`0x8cf` bit2/bit3**
   - **已确认**：**`FUN_140526310`** 队列消费主写 **`0x35b`**，**不**直接写 **`0x8cf`**
   - **已进一步闭合（2026-09-13）**：`entity+0xa3` 的“直接 `MOV [base+0x518]` writer”仍为负，但已沿已知 NPC 主帧找到间接边：`FUN_1405254f0` 的 `entity+0x400` 记录经 v170→`FUN_1404DE900` 调 `FUN_1403B4410`，后者复制记录 `+0x118`，即写入同一实体的 `+0x518`。同时，运动组件虚表 `+0x58` 的 `FUN_1404DCFF0` 已确认是带时间戳样本的 `AddMotionRecord` 入队边界（队列 `+0x1a8/+0x1ac/+0x170`，记录 stride `0x1a0`）。详见 `native-v178-record-writer-chain-0913-audit.json`。因此本条不再把 writer 视为完全未知；仍待的是队列样本上游、运行时调用时序及虚表槽0实际调用者。
   - **下一轮 CLI（补 0xa3 写）**：**`FindListingPattern +0xa3 0x140400000 0x140600000`**（必要时拆段）；筛 **`MOV`** / **`dword`** 且基址 **非 RSP/RBP`**；vtable 指针：**`ScanMemoryPattern both 1420c1f58 block=rdata`**（脚本见 `ScanMemoryPattern.py`）。
   - **接收链已独立闭合（2026-09-13）**：固定 EXE 的 channel2 → `FUN_1403717d0` 记录解析 → `FUN_1404193a0` 实体查找/版本检查 → `FUN_1404e1d30` 提交 → motion component `v+0x58=FUN_1404dcff0` 环形队列 → `FUN_1404de900` 选择/插值 → `FUN_1403b4410` 输出记录 已通过 `native-motion-receive-chain-0913-audit` 23 项审计。该链证明客户端存在时间戳队列与插值边界，但仍未证明 `+0x118` 每个物种/每个追击 tick 的语义或 `record.v40` 在实测滑步时通过。
   - **状态消费位进一步对齐（2026-09-13）**：已确认 `FUN_1404FF870` 将别名 `entity+0x518`（decompiler `param_1+0xa3`）的 bit1/bit12 分别映射到 `entity+0x8cf` bit3/bit2；`FUN_14053FDE0` 再结合 `FUN_140519410` 移动谓词选择状态索引并在变化时触发 `+0x7e8`。这闭合了数据流，不给这些位强行命名为具体动画 clip。
   - **物种范围（2026-09-13）**：服务端 `WorldObjectManager.createNpc` 对 Zombie/Deer/Wolf/Bear 统一实例化 `Npc`，因此共享服务端运动入口无需按物种复制。客户端 ADR/MRN/vtable 仍可能不同；先完成僵尸共享契约，再做一只动物的最小类/图对照。
   - **record v40 资格边界（2026-09-13）**：NPC 帧调用的 `record.vtable+0x40` 固定为 `FUN_1417F43E0`（表 `0x1420B9848`）。在 `record+0x160==0` 分支，固定审计要求 `+0x118` bit0 与若干 float4/标量均为有限值；零或负速度、零 `engineRPM` 不会被此谓词拒绝。仍待用同一实体的 live 样本确认 `record+0x160!=0` opaque 分支以及 attack→chase 的实际资格结果，不能把 `+0x40` 当作 TS 数据字段。
   - **bit0 生产规则（2026-09-13）**：`FUN_1403717d0` 每包先清零 `+0x118`，解码完字段后调用 `FUN_1417f4570`；该 helper 只验证五组 float4 与 `+0x140/+0x144` 为有限数，成功才 `+0x118 |= 1`。`native-motion-record-validity-0913-audit` 已通过 16 项固定检查/72 个语义用例。仍待 live 对齐是哪一字段/后续步骤导致 bit0 未置上或被替换，勿把它当 stance/攻击/正速度位。
   - **bridge helper 副作用（2026-09-13）**：`FUN_1405340F0` 切换 `entity+0x8cf` bit1，并在变化时通知 `+0x5b8` 组件后进入清理/重置链；`FUN_140534040` 切换 `entity+0x8d1` bit1，并在开启时进入 `FUN_1404e1de0 → FUN_14071b000` 排队通知。当前 `0x400/0x10400` 的直接 bridge 结果相同，bit16 未在这些映射中直接消费；速度谓词 `FUN_140519410` 另行参与。`native-stance-bridge-helpers-0913-audit` 已通过 26 项固定检查。仍待同一实体 live 对齐，不得把这些 helper 误命名为具体动画 clip。
   - **攻击图参数分层（2026-09-13）**：固定 graph-writer 证据把 `FUN_14051A870` 收窄为 `MeleeDuration/AttackRegion/State_InFrontOfTree` 的 `+0x630` 攻击侧 writer，而 `FUN_14053FDE0` 是包含 `Npc_AttackSpeed/State_Walking/State_Moving` 与移动轴的 locomotion/posture 批量 writer。Zombie MRN 的 `InAttack`/`AttackStand_Ping`/`Attack_Walker`/`Attack_Runner`/`SwingContact` 不能直接反推为 stance 位；仍待 live 把 `+0x620` 离散攻击事件与 movement-state pack 的时序对齐。
   - **服务端/客户端运动权威分路（2026-09-14）**：`server-ai-ownership-boundary-0913-audit` 已通过源码检查。生产 Zombie male/female、Screamer 与 Bear 的工厂明确设置 `clientDrivenSeek=true`；严格 0/1/3 秒 production native-only 复测再次出现空中漂移/仅姿态切换，故它不能承担可见连续运动。普通生产追击改为发送 `ExpectedSpeed + SeekTarget/SeekTargetUpdate` 作为 native 目标/加速度提示，同时由 `runOneNpcMove → Npc.goTo → PlayerUpdatePosition` 提供唯一可见位置流。此前 `runOneNpc` 把这些 NPC 放进 recast crowd，玩家进入时可一次激活数百条 path request，造成事件循环饥饿；现已在 seek/target 更新后提前返回，保留便宜的 shadow step，实测 API 保持响应、CPU 从约 92% 降为 idle，并出现 `[npc-production-seek]`。`/ztest flat | slope | fence` 仍是纯服务端位置流，`/ztest mixed` 现在与生产保持同一“seek 提示 + 单一位置流”组合，`/ztest seek` 通过 `suppressServerPositionBroadcast=true` 保留负对照。攻击进入时先 `ClearMovementRail`，生产 native-seek 与测试 server-driven 都发一次当前 shadow 的零速边界，再发 locomotion attack/`KnifeSlash`。仍待同一实体 live 对齐原生攻击图的返回追击时序。
   - **现场动态闭合增量（2026-09-21）**：在真实客户端 PID `48652` 上以 CIP 过滤命中 `FUN_140aa7450`（`SwingContact` 注册回调）与 NPC 接触消费者 `FUN_14051a900`；同一客户端还命中 `FUN_1404de900` → `FUN_1403b4410` 的 motion 插值/输出链。第二个新鲜客户端 PID `47724` 又命中 `FUN_1404dcff0`（`AddMotionRecord` 入队边界），补上了入队运行时证据。证据详见 [`live-animation-dispatch-20260921.md`](./live-animation-dispatch-20260921.md)、`dev/x64dbg-bridge/logs/daemon-20260921-031440.jsonl` 及同一会话后续 daemon 日志。这证明客户端本地图确实执行接触分发和完整 motion queue 入队/插值/输出，但没有捕获可证明的动物 C2S ACK，`liveVerified`、`rootMotionVerified` 仍不可置真；入队记录还要与同一 NPC 的 graph leaf、`VelocityLocalZ` 和脚底接触逐帧对齐。
   - **同一实体 motion 记录动态对齐（2026-09-21，PID `42072`）**：在客户端完整进世界、开启 god mode 后，`/api/animal-test` 刷出约 15m Wolf；随后短时断点现场命中 `FUN_1404dcff0`。`rdx+0x10=(-3340.44995,11.54,2366.75,1)` 与服务端 spawn 首样本 `(-3340.4199,11.50699,2366.82,1)` 一致，记录中同时存在时间原始字节与 `+0x148=0x100` 版本字段；同一 PID 又命中 `FUN_1404de900`、`FUN_1403b4410`。这把“位置流进入客户端 motion queue 并被插值/输出”闭合到同一运行阶段，但仍未证明攻击 clip 的 root delta 可以独立写世界坐标，故 `rootMotionVerified` 保持 `false`。完整现场值和日志见 `live-animation-dispatch-20260921.md` 与 `daemon-20260921-035742.jsonl`。
   - **SwingContact 本地图队列现场命中（2026-09-21，PID `49136`）**：按静态链依次命中 `FUN_1405243f0`（事件句柄）、`FUN_14139a9f0`（队列入队）、`FUN_14139a730`（队列 drain/映射）和 `FUN_14195fd20`（对象 `+0x918` 侧本地提交）。各点均未进入 Gateway/SOE 发送路径，第一站 `rdx` 为小整数事件句柄，后续才是本地记录/消息指针；这把“SwingContact 触发了本地动画图”闭合，但没有构成服务端 ACK，因此 `nativeContactContract.liveVerified` 仍必须为 `false`。

## 已闭合的现场问题（2026-09-14）

- **生产 AI 没有目标**：2016 客户端常走首载超时 fallback，旧路径只结束 loading，没有把玩家加入 `AiManager.playerEntities`。现在 fallback 与 `ClientFinishedLoading(characterReleased)` 都调用 `ensurePlayerAiRegistration`；生产探针日志实测 `playerEntities=1`、`target=0x1fcf3e5a58baa950`，不再依赖 `/ztest` 的显式注册。
- **原生 seek 包发不出来/服务端卡死**：玩家首次进入后，747 个可见 NPC 同时申请 recast crowd 会饿死事件循环。生产 native-seek NPC 现不创建 nav agent，服务端采用 shadow position 供距离/近战使用；重启后 API 正常，健康检查 `cpu_percent=0.0`（空闲采样），同一生产探针出现 `[npc-production-seek]`，约 3 秒后出现一次零速近战边界包。
- **证据文件**：`dev/ghidra/investigation_state/production-native-seek-live-20260914.md`（本轮新增）记录日志路径、探针 ID 和边界；它不把服务端日志误称为客户端 ACK。

## 中优先级

### 物种职责边界（2026-09-14）

统一的 `Npc`/轻量与完整 NPC/位置包/客户端 motion queue 已有证据；物种行为策略、profile 与 ADR/MRN animSet 仍需分别证明。当前 `isZombie()` 只覆盖三个僵尸模型和历史实验加入的 Bear，Deer/Wolf 不进入这段 AI；不要把它扩成通用动物逻辑。bundled profile 行号与源码 `Npc.profileId` 不一致（ID19/20 才显示 type22/23，ID22/23 为 type9，ID24 为 type11），在 live 接收记录闭合前不要自行重映射。详见 `species-boundary-20260914.md`。
`/spawnnpcvisible` 已在 Wolf/Bear/Deer 三种模型上完成服务端创建与初始化发送回执，未出现序列化/发送异常；这只闭合了可见 NPC 的服务端路径。`/movetestnpcvisible` 也已完成位置流对照：Wolf 的裸位置流虽成功送达却未在画面连续靠近，因此不能把“位置包已发出”当成客户端运动接受证明；`/seektestnpcvisible` 的成功只说明共用 native seek 入口，不等于动物生产 AI 已完成。

**live 结果更新（2026-09-14）**：上述“下一步”已完成并得到反例。Wolf 的位置探针命中唯一 `spawnedEntities` 客户端且成功打包，但画面没有随服务端约 9 米坐标推进而连续靠近；这不再支持“只是没广播”的主假设。相同初始化链下，Wolf 与 Deer 的 `/seektestnpcvisible 8` 都能从约 12 米进入近身；当前 `/ztest seek` 也能从约 12 米进入 `distance=2.03` 后请求 `KnifeSlash`。严格 production native-only 负对照会悬空并只切姿态，故普通生产追击采用 `SeekTarget` 作为 native 目标/加速度提示，同时保留单一 `Npc.goTo → PlayerUpdatePosition` 位置流；两者不是两条独立服务端 mover。起身、脚底接触和攻击接触帧仍需现场时间线回归。

3. **ActivateProfile：合法载荷 vs 当前默认探测体**
   - 哈希表在 BSS 动态填充；sweep 仅扫键，不代替「合法载荷」。
   - **已对照（2026-03-19）**：`characterId=self` 与 `test` 僵尸、**同一默认体** → **同类破坏**（附件错误、头消失；人物另有着装回退）。见 [round-3-4 Empirical](./round-3-4-character-packets.md#empirical-activateprofile-via-devhttp-0x0f31)。
   - **仍待做**：用**官服/抓包**的 selector 与完整 record（含 blob/stat）重放，区分「设计内武器/profile」与「错误 selector 的通用破坏」。

4. **完整行为序列时序**
   - SeekTarget + MemberStatus + UpdateCharacterState 的组合与顺序
   - **已固定服务端输入顺序（2026-09-14）**：进入 `state=2` 时源码为
     `clearMovementController` →（server-driven 与 production native-seek 都）
     `sendIdleStance` → locomotion attack state → `KnifeSlash`；普通 chase 重新走
     `SeekTarget/SeekTargetUpdate`，并由 `runOneNpcMove → Npc.goTo` 发布唯一位置流。
     `state=2→1` 的原生图返回/脚底接触帧仍需同一实体 live native capture，不能用
     服务端事件时间替代客户端接受证据。
   - **已固定 wire 形状（2026-09-13）**：1080 NPC 位置包 flags 为 `0x13`（无朝向）或
     `0x33`（有朝向），字段来自属性存在性；`direction/engineRPM` 未发，movementVersion=1。
     详见 `tools/task-01a06a01/server-npc-position-wire-contract-0913-audit.json`。
   - **测试路线已实测对齐（2026-09-14）**：运行 `2d959dc6-0aa7-47b4-91e7-266b0b8e7f3c`
     在 `state=2→1` 后，首个 tick 保持原位置，后续 tick 以约 `0.25m/100ms` 连续发送，
     `state=1→2` 时没有回跳；抽帧同时看到追击步态和攻击姿态。该结论只关闭
   `/ztest flat` 的 server-driven handoff，不关闭普通生产路径的 `SeekTarget + goTo`
   混合权威问题。详见 `server-driven-backoff-20260914.md`。
   - **普通形状混合臂已做一次现场 A/B（2026-09-14）**：运行
     `29909319-3408-46db-b4f4-84d65d59fe3e` 的 `/ztest mixed` 同时保留
     `SeekTarget` 与普通 `Npc.goTo → PlayerUpdatePosition`。413 个服务端样本中
     相邻 NPC 位移最大 `0.2501m`、没有超过 `0.5m` 的跳点；首次
     `state=1→2` 在 `4269.4ms/2.2501m`，过渡前后位置连续，抽帧在可见区间看到
     追击步态与攻击姿态。它支持「SeekTarget 是 native controller/目标提示，
     位置流是服务端运动数据」这一分层，但没有原生内存捕获，不能单凭一次录像
     把所有生产物种都判定为已闭合。详见 `mixed-seek-position-20260914.md`。
   - **生产 2→1 交接屏障已落地（2026-09-14）**：仅对
     `clientDrivenSeek && !testServerDrivenMovement` 的生产分支，攻击切回追击时
     先发当前 shadow position 的零速锚点，消费同一 AI tick，不推进新的位置样本；
     下一 tick 才恢复 `Npc.goTo → PlayerUpdatePosition`。源码回归已覆盖这一顺序，
     但尚未拿到同一实体的客户端 ACK、原生节点或脚底接触逐帧证据，仍不能宣称
     “客户端已接受且完全无滑步”。

5. **entity+0x1170 队列处理（已基本落地，本条收窄为「0x8cf 前传」）**
   - **消费者**：**`FUN_140526310`**（mask 合并到 **`0x35b`**）；**`FUN_14091ee40`** 为 tick 薄包装（**`QueryXref to 0x140526310`**：**1×CALL** @ `14091ee6d` + **4×DATA**；**`QueryXref to 0x14091ee40`**：**仅 3×DATA**），见 **`fun_140526310_91ee40_tick_chain.json`**
   - **通知链**：**`FUN_1404e1de0` → `FUN_14071b000`**（全局链表，非当场 drain）
   - **仍待**：**`0x8cf` bit2/bit3** 经 **`FUN_1404ff870` + `entity+0xa3`**（已确认）；**`0x8ca`** 击倒字节等 **另有写入端**，未与 UCS 队列单一路径等同；与 **#2** 重复处以便检索

## 低优先级

6. record.+0x58 / +0x70 的真实消费者
7. InAttack 的 code-side writer（若仍走 ActivateProfile）
8. entry 字段区分：追击 / 近战起手 / 挥击 / 命中恢复
