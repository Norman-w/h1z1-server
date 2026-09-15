## 2026-09-09 11:53 UTC 位置/速度双通道核对、真实时间间隔修正及 F/G 两轮实测

最新主线证据为 `tools/task-01a06a01/sequence-speed-root-events-20260909.json`。TS 仍仅是实验驱动；**整体 goalComplete=false，F/G 是两轮完成的诊断采集，不是两轮全目标验收通过。**

- 原生 `1417F3ED0` 普通分支分别插值位置与端点速度，`1417F3510` 外推使用端点位置加速度乘时间；没有由坐标差自动重算速度的普遍保证。完整五函数/2732B核对见 `proxy-speed-native-contract-0909.json`，特殊标志/坐标转换分支仍单列，未外推成所有动画路径的结论。
- D/E 固定历史日志显示，原 .1 秒分母与实际 sequenceTime 间隔不一致，量化后的时间加权声明/路径速度比分别为 1.1187664、1.0706562。新限定候选按相邻量化XZ和实际u32序列时间算速度，并处理首次prime、重复时间、回绕、停走、版本/位置跳变及发送异常；原移动预算、地形门、攻击450ms未改。
- Zone 构建通过。当前源码运行的198项回归：196通过、0失败、2真实障碍跳过；新增17项时间线测试全部通过。曾误用旧 flat tests_out 路径和随后 nested 路径失败的记录保留，不算有效回归；最终以编译检查及当前源码 tsx 运行结果为准。
- 11:40:48.605 UTC 安全加载候选到 Node22524/create1788954043.2396798、监督22292，日志 `C:/Users/WS/AppData/Local/Temp/h1z1-gitbash-01a06a01-soa9tg3y`。旧19420/12272退出及源码/构建/依赖pin均独立核对；旧日志保留。新游戏12816/create1788954262.3011808、session2141468983仅是本轮保存身份，不是持续在线声明。
- F `4254e9bf853b88d8`/50512，running 11:46:44.167、explicit_finish 11:47:10.234 UTC；G `4c16627f3bd010c3`/50513，running 11:49:28.435、explicit_finish 11:49:56.455 UTC。两轮各298样本/30秒有界完整采集，均保护撤销且cleanupError=null。F/G采集文件分别为 `observations/npc-locomotion-20260909T114627.342824Z-pid12816.jsonl` 与 `114910.651958Z-pid12816.jsonl`（后者亦以 npc-locomotion- 开头）。
- 根节点已独立重跑两份固定日志审计并与保存结果逐项相等：每轮24/24公式自洽，23/23相邻锚连续，路径与D/E完全一致。相邻段加权速度比 F=0.99958005、G=0.99485564，量化MAE=0.02715872/0.02842863。首段63/80ms导致声明速度3.65079/2.875，单列而非混入23邻接段；这不是统一降速。发送尝试记录在sender调用之前，**不证明无异常返回、实际送达或ACK**；改善只限输入自洽，不保证原生瞬时速度或无滑步。
- F原生同口径27移动间隔累计4.088654923 rawXZ/2.6997489 QPC秒；28端点为26组件/图Z均非零、1图Z未知、1均零。289份rawpose已知、9未知不填零；严格位置/速度停稳末段101行9.9499513秒，不代表这些行全为已知或完成的骨架帧。根已重跑固定F分析并与保存结果完全一致。
- G重新绑定骨名。原始stdout保存在 `sequence-speed-g-rig-raw-20260909.json`；`sequence-speed-g-rig-20260909.json` 是经JS解析的伴随文件，其中数字型大GUID有精度损失，**不能用其数字GUID做精确身份判断**。原始文件完整保留，不重新采样或向F嫁接名称。G命名分析及根独立重跑已一致：完整GUID5482677894974017731校验通过，289行同roots/parents/name匹配、9未知保留；27移动区间4.083262359 rawXZ/2.6997285秒，严格停稳91行9.0001077秒。移动端点左右踝分别25/23个有效相邻对有局部变化，右踝1个norm拒绝未放宽；不能把这些变化当接地、步频或无滑步。复跑入口 `root-rerun-sequence-audits-0909.sh` 和 `root-rerun-sequence-g-native-0909.sh` 均在同一tools目录；结果与保存工件逐字段相等。
- 画面只确认接近和近身姿态变化，草坡及玩家身体遮脚，未连续录像，不记无滑步/接触时刻通过。F保护期间15条检查均8900→8900；清理后角色资源扣血恢复，不能把聊天历史伤害行当保护期间命中。正常UI登出后，11:51:27 UTC API clients为空、last-test为空、回放finished/protection=false/cleanupError=null，游戏窗口消失；请求已恢复status/UNBOUND，采集进程已结束，服务保留。

下一闭环是活动clip/播放时钟与最终脚部矩阵的帧归属、脚接触/打滑量化，再核原生SwingContact/命中与实机障碍；不能由动画有变化直接断言动画和位移已同步。以下旧记录原样保留。

## 2026-09-08 16:52:28 重定向与起步复现、Smooth 原始输出已读；新近战刺激已部署但未验收

新增检查点 `retargetPrerollSmoothAndReload20260908_165228`；原 97 项与旧 README 原文逐字保留。TS 仍仅作实验刺激，整体 `goalComplete=false`。

- 后续实机更新（10:17 UTC）：09:44 部署的朝向/攻击冷却解耦版本（168 pass、2 skip、0 fail），已完成两轮离散近身侧移复测：299 / 298 样本，首次 C0 变化分别在命令后 66–166 / 45–145ms，净转 46.5882° / 35.2941°；旧版为 1133–1233ms。两轮命令后位置固定，确认后各覆盖 17.1000 / 17.2002 秒，均提前显式清理。主线程重跑两份独立审计及另行直接字段复算；不是同条件因果估计，也不是连续追人、无滑步或原生命中验收。
- 第一轮在侧移前另有约 0.1608 XZ 位移，第二轮全段未复现。源码确认此次解耦同时去掉了朝向不变时的周期完整位置重申；这只是待隔离变量，不是已证根因，未为此盲目重启。采样开头分别漏了 2.858 / 4.274 秒，不能把近身静止窗口称为全程没有移动。原生调用链也确认：自身挥击表现可以发生而目标 Flinch 调用被跳过，临时 450ms 定时器不代表实际命中。详见 `postDeploymentFollowup.decoupledTrials`。
- 滑步分析已继续到真实图输出的查找、复制和多通道布局，补读 332 / 378 / 416 / 170B 等固定客户端原始函数体；tag13 仅为必要类型门，提交计数不是复制完成标志，getter 索引不匹配时还会写缓存，不能在只读采样中调用。尚缺当前输出完成/帧归属及 Zombie001 的具体脚骨映射；没有把普通人物 ankle 编号套给僵尸，也没有新增不可靠活体读者。PyGhidra 旧入口会清锁，故未启动/删锁；本轮原生分析通过固定 EXE 有界解码继续推进，无需用户手动处理。
- 后补：485+118B 分配体确认两组 raw descriptor；1113B/8 chained 消费体确认逐项位图门，不证明完成帧。MRN parser 实跑 689 chunks/131 names、Lankle7/Rankle104，仍未绑定运行时脚骨。默认关闭的 raw 输出读者仅离线通过 sampler275/orientation23，尚未 live；具体 SHA、布局与非原子边界见 JSON。
- 10:50:58 UTC 主线程发现服务12892缺席；10:51:40 NF两次无13371监听、游戏18288仍在，退出原因未知、当时恢复未完成。音量 UI10.26/INI0.102625 已确认；应用卡顿具体根因仍未知，不归因本调查，也不代表游戏验收进展。
- 10:56 UTC 主线程独立验证新采样器8处固定 EXE 字节锚并重跑275+23项纯测试通过；10:54:47 Windows确认RDP会话2为Disc，截图/激活失败，已请求重新连接。没有盲操作、强杀或启动；正常退出客户端后才能复用现有fresh启动入口，服务恢复与新实测仍待完成。
- 11:13 UTC 离线补齐并构建：骨架层级读者14处原生字节锚验证、293 sampler/23 orientation检查通过；发送尝试追踪已编译，176项回归174通过/2真实障碍跳过，编译后近战保护8/8。追踪仅覆盖当前测试NPC的前64次goTo发送尝试，不等于送达；尚未部署。固定旧A/B采样在速度输入2.5的选定区间复算位移速度1.9993/2.0158，单位和因果未闭合，未据此改动画倍率。
- 用户报告起来后，11:12:19仍查到RDP会话2 Disc；重新绑定游戏窗口的一次恢复重试仍报CreateForMonitor0x80070057。11:13:51..52服务/监督进程与13371监听均缺席，游戏18288仍在；无盲输入/强杀/启动。下一步须先恢复RDP，才能正常退出旧游戏、复用安全启动并重新采样；不再重复无效截图，目标未完成。
- 14:48 UTC RDP已恢复；安全入口启动22468/20940，原快捷方式启动游戏2540。新A/B完整30秒捕获298/299样本并提前显式清理。原CNK精确复现32/32发送位置：三角形边界截短而速度字段仍2.5，实测发送位移均速2.1720/2.0989原始XZ单位；这是TS实验输入不一致，不等于原生滑步根因，角点安全门未删除。见 `resumeAndTracePair1450Utc`。
- 15:08 UTC独立静止诊断198样本确认唯一重复为q==r，22次/179B读取预算未增加，仍unknown；尚待原生构造回指核查。采样器295、桥接7、协调器24纯测通过，15:09显式清理且保护恢复。静止诊断不计追逐或脚接触通过；证据见 `pausedAlias1508Utc`。
- 15:27 UTC补齐：原EXE的121B/381B构造证明Q↔T回指，仅该别名例外已修正，353纯测通过；新静止捕获187/198 rawknown。游戏正常重连21020后又完成真实追逐A/B：298/299样本、287/291 rawknown，35/36移动端点读到raw、36/36速度CP非零，主线程独立复算。两轮均提前显式清理；T38全0、脚骨名称未绑定，不能把未命名存储变化当正确步态/脚接触。详细拒绝、末行discard、恢复过程与固定SHA见 `pausedAlias1508Utc.followup1527Utc`；下一直接分析链是同一运行时Rig的骨名表。

- 两次离散侧移不是连续追人验收：1603 的目标变近，298 样本全静止且 C0 不变，后覆盖 18.3999 秒；1620 的 299 样本记录 C0 转约 59.2941°、8 段移动 1.42730 XZ / 0.800157 秒，随后停稳 16.7995 秒。两次开头分别漏采 2.052 / 2.440 秒，第一移动对跨外部命令时间括号，UI 多离屏或裁切。
- 起步预采样 A/B 分别 299 / 298 样本，首样本早于实际 running 1.624 / 1.828 秒（不是用 POST 代替 running）。两轮各 19 段移动，路径 3.56789 / 3.57052 XZ，停稳后缀 26.000 / 25.700 秒。
- A 的 19 个非零 component 样本均有非零图 Z；B 为 18 个已知非零加 1 个未知，未知因顺序读取时 cache entry 改变，未补零。已知 cache/CP 对均无 mismatch，但 component 与 CP 的起停数值差、独立 E0 读取不一致仍保留；不声称同帧原子消费。
- 据主线程实际截图描述，B 的 11 帧 08:35:22.666..23.817 UTC 能见全身、脚及左右姿态变化；A 后段脚被裁切。本审计员未重看 UI；这不是定量无滑步、活动 clip 或接触时刻证明。
- 同一次已知 Smooth 读取绑定 Node 364 / type 142 / input 15:0，原始 `867a1d40` 解为 2.4606032371520996；362 次读取、5966 B、274.0662 ms。暂停态因 `graph_token_after` 变更拒绝，未知不是零；graph/row/slot 的 8849 相等不证明新鲜、活动节点或同帧消费。
- 四次采样均在原 120 秒 lease 前 explicit finish，child end 到 finish response 为 168 / 186 / 176 / 180 ms；Smooth 亦明确清理，保护 false、cleanup null。它们不构成新部署的近战验收。
- 主线程 08:48 正常退出旧客户端 17856；08:49 zone/tests 编译与 164 项回归（162 pass、2 skip、0 fail）完成。保存的 reload 证据确认 08:49:52.200475 UTC 新服务 17076 / 监管 20936 就绪，载入近战朝向刺激和自动登录 `noAi:true`；旧 8828 经身份核对单 PID 终止 exit15，监管 exit0，日志保留，未伪称全程正常退出。
- 08:52:28 主线程状态为 clients0/replayidle。保存的 Event 1000 记 08:51:37.761125 UTC 客户端 9620 启动 c0000005，模块 unknown、偏移 `000000028043a387` 未绑定已知 H1Z1 RVA；原因调查中，不归因服务、采样器或 ChatGPT。
- 后补主线程 08:57:18.475 UTC：同一正确快捷方式仅重试一次成功，客户端 8672/create1788857763.738706、session551709480，alive/loading true；未改配置或安全设置。恢复不抹去崩溃，也不等于加载后的近战验证通过。

- 16:00 UTC 后补：已修正临时TS路径短段仍固定发送2.5的速度不一致，15:41载入2372/25000；139项通过，另3项真实资产测试单独通过。新A/B各299样本，主线程重跑两份独立审计PASS，位置未变、32条段速公式全部正确；B停止173样本/17.2003秒，A仅0.8998秒，不是两轮无滑步验收。原生输出XYZ/四元数存储布局已核，脚名/当前完成帧仍未绑定。证据 `route-horizontal-speed-root-events-20260908.json`，JSON路径 `pausedAlias1508Utc.followup1527Utc.horizontalSpeed1600Utc`。原按键短按无移动回报，自动跑已证明可取消但距离过大，继续有界步行/追逐测试。
- 2026-09-09 新恢复/连续玩家实测：服务19420/12272、游戏18488；两轮各298样本，原生转向179.2941°/172.2352°后重新追随，末停稳11.8002/3.6003秒（B不足8秒）。主线程09:22 UTC重跑两独立审计PASS，提前显式清理、人物已停、临时步行配置磁盘已还原。不是两轮全目标验收；无滑步、脚名、原生命中、真实障碍仍未完成。新证据 `tools/task-01a06a01/reboot-moving-target-root-events-20260909.json`，SHA41c2dc22…e766e7；JSON同一horizontalSpeed项下`recoveredMovingTarget0909`，不沿用旧RDP断线状态。 后续09:44 UTC主线程复跑匿名骨架分析：移动段47/29对、停稳段114/36对均有>1°局部关节变化，不支持整套局部骨架近静止，但不是脚步/速率失配证明；原生141858070已核为特效提交而非命中确认。详细只读后续证据见 `tools/task-01a06a01/native-followup-root-events-20260909.json`。 10:21 UTC原生Rig名称链已闭合并独立审计5函数/2271B通过，名称按ID值查找而非表行号；新默认关闭读者45项纯测通过，尚未实机绑定。只读Ghidra恢复/owner链及本轮详见 `readonly-ghidra-recovery-root-events-20260909.json`、`native-owner-continuation-root-events-20260909.json`、`rig-name-native-chain-root-events-20260909.json`（均在同一tools目录），不再将旧Ghidra清锁入口当作唯一途径。 10:32:55 UTC单次paused实机已绑定131个名称（L_ankle7/R_ankle104），与同NPC姿态roots/parents跨读取匹配；名称69次/7086B/2.539ms，10:33:05 explicit finish保护已恢复。详见 `tools/task-01a06a01/rig-name-first-live-root-events-20260909.json`；不是原子完成帧/无滑步验收，也不追溯给旧A/B贴名。 10:50/10:53 UTC新增带骨名的独立D/E实采（新游戏3728/session1084315191），各299样本/30秒完整且提前explicit finish，保护false/cleanup null。每轮均重新读同实例131名称；首轮名称/姿态跨读成功不替代逐行匹配。移动28/27区间共4.08100/4.08136原始XZ；移动端点非零component中mapped Z为26/25已知非零、各2未知，没有已知零，非同帧消费/无滑步证明。根事件 `tools/task-01a06a01/rig-named-motion-d-root-events-20260909.json`、`rig-named-motion-e-root-events-20260909.json` 与 `rig-named-speed-input-root-run-20260909.json`；11:00 UTC主线程全文复核并复跑D/E生命周期/命名分析均PASS：287/286行同骨架roots/parents匹配，12/13未知保留；左右踝移动相邻有效对20/23与19/21均有局部角变化。最长独立严格静止段16.999727/16.994404秒；E最终后缀仅1.199782秒（to286间隔5.9096ms被原10ms门拒绝，不跨隙合并）。根复核 `tools/task-01a06a01/rig-named-motion-de-root-verified-20260909.json`；未改TS业务/写客户端内存。下一步绑定活动clip及播放时钟、T20/T28到最终脚部矩阵与帧归属，再验证原生SwingContact/真实障碍；整体仍未验收。
证据详见 JSON 中各固定 SHA summary 与 audit；保留校验入口：`tools/task-01a06a01/audit-retarget-preroll-checkpoint-independent.sh`。下一步重点是精确步态/脚接触、实际 SwingContact 消费与连续移动玩家、fail-closed 活体障碍验证；不把静态覆盖未知视作可通行。

## 2026-09-08 15:12:39 明亮 A/B 实跑：原生运动、朝向与主动清理复现，目标仍未完成

最新条目为 `daylightPairedMotionAndStaticClosure20260908_151239`；原96条（含95条历史）与旧 README 原字节保留。独立复核入口 `tools/task-01a06a01/audit-daylight-ab-independent.sh`，主线程全文复核并重跑 PASS；单份 `daylight-ab-independent-summary-20260908.json` SHA 为 `1d65c3bff716f7dca8d2e2af19ca539fa01e065e5f3fc8fc4f80feabec6bc310`。

A `065002`、B `065218` 均为198样本/exit0/完整20秒捕获；移动区间分别14/15个，累计2.782696784/2.838275212原始XZ单位、1.4004072/1.5005333 QPC秒。两轮各16个组件非零样本的图Z全部已知非零，cache/CP差异均0，全部header1131、前后8D4=9/6E0=0。小变化各4个另计，未知不填零。

两轮各198份C0与已审SSE公式完全一致、scaleZ=1；移动端点C0与相邻位移均同向，最大夹角3.111061°/5.164435°。停稳后179/178样本覆盖17.8366043/17.7425792秒，位置恒定、组件/图Z为零。**这是站立玩家追近停稳，不是移动玩家转向/停步验收。** 独立组件E0与稍后朝向E0有11/10次顺序读差异，保留非原子边界，不当同帧消费证据。

实际running分别06:50:02.292/06:52:17.880 UTC；第一原生样本晚486/467ms，漏采开头未补齐。协调器采完后主动 exact finish，服务端06:50:22.742/06:52:38.334结束，均explicit_finish、protection=false、cleanupError=null；childend→finish response175/171ms为UTC标签差，非另测原子/单调清理延迟。旧9936的199行“未实际start但清理成功”控制不混作运动通过；lease120秒、fresh-clock300ms等预算不放宽。

画面均引述主线程，CP没有亲自观看：A14帧06:50:02.375–08.875、B16帧06:52:17.728–21.626 UTC，可见交替膝/脚接近后停步挥击；近处脚部分遮挡或出画，B开头含stance镜头过渡。**不是连续录像，不证明精确no-slip、实际活跃clip/播放速率或原生命中时机。** 两轮保存实验参数相同，但不能独立归因为某一次修复。

14:42重绑的PID9184/create1788849661.442166、API session1936149118及服务8828/12796是A/B保存身份，原生capture session仍为null；不是持续在线声明。主线程07:12:39 UTC API无client、UI inactivity断开。后续root报告07:15:37/45重连后玩家已被自动NPC击杀，07:15:59.951保护准备/复活处理中；不作为新验收，也不推定当前原生位置/存活状态。

9936崩溃原文记录c0000005/RVA32CFB2，固定EXE显示此处为写入空地址的fatal路径；**触发该路径的原因未知**。精确事件1000/1001 UTC06:29:43.4035613/45.8193045来自root的XMLSystemTime报告，格式化原文14:29带Z不当UTC。见 `game-crash-1430-root-events-20260908.json` 与 `game-crash-native-20260908.log`；不能因发生在主动清理后就归因采样器、包修复或应用更新。

静态闭合见 `smooth-init-contract-20260908.json`：Smooth initializer→float构造→pin0的tag3/P+10=0已证，35锚/11合成通过；初始tokenFFFFFFFE不是帧完成证明，runtime node364/活跃消费未绑定、未新增采样。另 `contact-f50-independent-contract-20260908.json` 的26锚/521算术通过：F50来源为QPC毫秒，**不是事件generation、UTC或成功接触时刻**；reset默认、live时钟绑定及同毫秒重复/非原子边界仍保留。两合同SHA见台账。

**goalComplete=false。** 仍缺精确脚底接触/打滑、移动玩家转向与停步后原生覆盖、真正SwingContact/命中时机，以及fail-closed实机障碍。临时TS只驱动实验，未知碰撞覆盖不能当可通行；以下历史原文不变。

## 2026-09-08 14:14 原生朝向与站立玩家追近停稳采样补充

先读顶部检查点内 `orientationSupplement20260908_1414`；旧正文保留。新增默认关闭的只读朝向采样：审计getter、dirty位、双读payload、原有身份门及预算不变，helper23/集成sampler225检查通过，仍为非原子观测。

`060124`：**197样本/exit0**，根全文审读并独立重跑 `audit-orientation-capture-060124.sh`。18移动间隔共3.598826798XZ/1.8003076QPC秒；停稳后176样本XYZ恒定且速度/图Z为0。197份q/C0公式一致但朝向始终恒定；196对cache/CP相等，另1未知原样保留。画面见公路上交替迈腿、追近、停住和挥击；**不能升级为无滑步、转向或实际命中通过**。

根操作保存于 `tools/task-01a06a01/orientation-sync-root-events-20260908.json`，独立汇总 `orientation-capture-060124-summary.json`。并行fresh-clock+C在178.577ms下成功启动；采样正常完成后42.773秒租约才超时。晚到finish只确认protectionfalse/cleanupnull；采样20.292秒与之后278.954秒外部调度空档分开，不能归因ChatGPT更新。本地采完即清理脚本仍在审查，未宣称实测通过。

此前 `055644` 的208行全部静止且未启动，exit1，独立审计通过不等于追击成功。当前新增站立玩家到达证据不补为移动玩家停步/转向；脚底滑移、原生接触时机和实机障碍仍缺。临时TS不作原版权威。

## 2026-09-08 13:35:47 原生轨迹反向与服务端重追上已留证；停步后原生验收仍缺

最新检查点为 `movingReacquireAndPostStopGap20260908_133547`；旧95项及下文原字节保留。CP复算封闭采样并读既有工件；部署、API、日志提取与画面事实引述主线程/原生审计员，不是CP本次操作活体。

主线程13:15经已审阅reload把8324/11692换为 **server8828 / supervisor12796**，game **18828**（create1788844524.6248224），session **1240536793**，日志 `h1z1-gitbash-01a06a01-ro73ulrg`。攻击request/check时间戳和只读server pose诊断已部署，不能再沿用上一节“未载入8324”；构建通过，总回归 **179：177通过、2跳过、0失败**，fresh-clock1315 helper60通过，reload49+50+29通过。源码/编译诊断SHA见台账；450ms、保护、packet及预算未放宽。

`052227` 原生捕获 **298样本/exit0**，独立 `audit-postfix-052227-independent.sh` 复算一致，结果 `postfix-052227-independent-evidence.json`。30移动区间共 **5.685424969777811 XZ / 2.9875734000015655 QPC秒**；19段先负Z、11段后正Z。**05:22:56.813 UTC** 首次同时见组件速度及位移转正Z，只证明轨迹反向；未采原生旋转，server quaternion不补为原生朝向证据。30个组件非零样本对应28图Z非零、1未知、1已知零；297个cache/CP已知对中1次非原子差异。全部header1131/门字段已知，8D4全9；末行6E0=10且图Z0仍只作同次顺序读关系。

这份完整30秒数据只覆盖自动走开启后刷新时刻的 **5.094秒**，在关闭刷新前 **7.190秒** 结束，**关闭后0样本**；不能算完整移动玩家—停步验收。该回放05:23:28.616 UTC以lease_timeout清理，晚到finish不是主动成功结束。UI时间均是action+refresh，不是精确keydown/up。

服务端 `moving-reacquire-melee-summary-20260908.json` / `moving-reacquire-melee-selected-20260908.json` 保存46行、**23对请求/检查（18+5），450–463ms**；全部health10000→10000、godMode/protectedTestReplay=true。最大请求空档 **25.591秒（05:22:56.327→05:23:21.918 UTC）**，后5次在距离2.45再请求；仅证明服务端行为恢复。后5次均落在原生采样末尾之后，不补为原生追上、SwingContact、ACK、正常伤害或接触时机验收。

专门停步后尝试 `417d5d4e-298f-446d-8a63-2e3e62d2c83d` 的lease在 **05:30:53.036 UTC** 已超时，早于关闭刷新05:31:08.935。`053531` 捕获 **0样本/exit1/api_transient_id_invalid**；05:35:47.258 exact finish只确认failed/lease_timeout、protectionfalse、cleanupnull。见 `post-stop-failed-root-events-20260908.json`，不得记为验收成功，也不凭时间间隙归因网络或ChatGPT更新。

OldCan增量 `oldcan-entry-gate-contract-20260908.json`：descriptor+3D9 bit0→14143F160→actor+48B bit20→创建门已闭，主线程41静态+512合成通过；**实际OldCan descriptor/实例仍未绑定**，12本地实例及局部coverage仍unknown，新static guard没有接入或实机通过。以上工件均在 `tools/task-01a06a01/`。

最后server pose读时刻为 **05:35:45.599 UTC**，值[1352.79,41.8,-715.95,1]，但lastReceived仅05:31:08.368；这不是持续有效位置或原生测量。当前原生玩家位置未知；服务/游戏身份亦须下一次操作前重绑。**整体目标未完成**：停步后原生追上、朝向/脚接触、实际命中时机和实机障碍仍缺，不能放宽lease/预算或把unknown当clear。


## 2026-09-08 12:56 失败前缀已复核；静态保护未接入，围栏覆盖仍未知

最新检查点为 `staticCoverageAndFailedPrefix20260908_1256`。本节仅补充既有两轮可见配对之后的分析；全部旧记录保留。实机状态、构建和全量回归由主线程提供，CP本次只读文件并更新检查点。

`043958` 捕获为 **225样本、exit1、npc_class_not_audited，完整采样失败**；独立入口 `tools/task-01a06a01/audit-prefix-043958-independent.sh`。有效数据止于 **04:40:21.029 UTC**，仅覆盖自动走开启后 **1.581秒**，关闭后无样本；这17个开启后样本的NPC位置/速度静止，不能称移动玩家转向通过，更不计第三轮成功配对。前段20个移动区间3.770265149836699 XZ / 1.9992238000013458 QPC秒；20个组件非零样本中18个图Z非零、2个未知。223个已知cache/CP对有 **4个顺序非原子差异**，不作为原子损坏或同帧消费证据。04:40:21.088为lease_timeout清理，晚到finish不是主动结束；失败记录未保留实际坏vtable，不能断言具体析构/复用原因。

原生 `swing-target-dispatch-contract-20260908.json` 已把 **signed LE16 subtype12 → 1409E3280 → GUID/NPC v350 → F60/F68** 接上；**外层family byte仍未知**，不得把构造默认0x0C当已验证的0C0C00发包合同或命中回执。

攻击日志新增 `requestedAt/checkedAt` 仅关联服务端请求与延迟检查，**450ms/1500ms、保护与packet均未改**；checkedAt在服务端伤害/血量观察之后，不是原生命中或ACK。主线程已编译，但当前 **PID8324尚未载入这项改动**。

新 `forgelightStaticGuard.ts` 独立源码测试 **43/43**、只读审查无阻塞；主线程双构建成功，总回归 **177：175通过、2跳过、0失败**，真实围栏测试1通过。后者是旧AI测试，**新guard尚未spawn接线、未实机部署**；整个ground/contact/probe段必须显式覆盖，未知拒绝。离散高度射线不是原生胶囊或动态门碰撞证明。

离线 `fence-local-coverage-20260908.json` 保留 **47个mesh / 4964个三角形**，另有 **58个附近unsupported原点实例**（`fence-local-unsupported-origins-20260908.json`）。已有三角形命中可证明对应几何阻挡，**无hit不代表可通行**；原点名单不能排除未知几何范围。局部coverage仍unknown。工具工件均位于 `tools/task-01a06a01/`。

`oldcan-no-cdt-contract-20260908.json`：OldCan01的12个本地实例仍unknown；没有直接CDT不等于没有碰撞。通用141449120存在备用resource/factory几何路径，OldCan实际门位及v60/v68值尚未绑定，未改resolver、未重分类为无碰撞。

主线程12:56报告 **server8324 / supervisor11692 / game18204 / session1197702258稳定，无回放运行；当前玩家位置未知**。整体目标未完成：精确脚接触/滑步、移动玩家转向、原生命中时机与实机障碍仍待验证；下一步先闭合围栏完整覆盖，不能放宽预算或把unknown当clear。


## 2026-09-08 12:40:40 方向修正后两轮可见配对；第三轮转向尝试未通过，整体目标未完成

最新先读台账 `postDirectionPairedObservations20260908_123636`。方向修正已在此前12:19部署版本上完成两轮新的完整20秒采样：每轮199样本、exit0，主线程画面均保持N，并可见接近与交替屈膝。**这是两轮可见画面／原生数据配对，不是精确脚底接触、无打滑或完整交互验收通过。** 所有画面、输入和API事实均引述主线程；CP只独立分析封闭文件、更新本文，没有直接观看这批截图或操作活体。

独立入口为 `tools/task-01a06a01/audit-postfix-042323-independent.sh` 与 `audit-postfix-043115-independent.sh`；各自绑定原始捕获SHA、同一严格比较器SHA `c24cbefc67d0d63a20960b038a56d5304dd65cd5cbda4790153d2f97b4b12929`。主线程已全文读两脚本和 `postfix-042323-independent-evidence.json`／`postfix-043115-independent-evidence.json`，并独立重跑exit0。仍按相邻已知位置、QPC间隔10–300ms、XZ位移>1e-6且速度>0.1原始单位/秒统计；小变化另计，未知不补零、不跨越未知位置。

第一轮 `042323`：NPC `f387ad755bee2326`／replay `d82bf290-0e7d-48de-86cd-e5625bc1b935`，捕获SHA `b38692342900f80bad45f26e9b8d805c79bd6193cd68c82a4e517cbf2b243af0`。20个移动区间在 **04:23:34.630–36.629 UTC** 累计 **3.7769480137343034 XZ / 1.9992027999996935 QPC秒**；21个移动端点113–133的组件速度与图Z全部已知且非零。全199样本中，21个组件非零样本均有非零图Z，另178样本两者为零；199对cache/CP无差异。4个低速小变化另计0.0068781158265322755 XZ。主线程10帧 **04:23:33.894–37.455 UTC** 全部落在采样内：早中段可见左右膝变化和逼近，草遮部分脚，最近处身体超出底边。实际running为 **04:23:34.589 UTC**，**04:23:44.120 UTC主动explicit_finish**；结束原因来自API，不由采样exit0推断。

第二轮 `043115`：NPC `c8d0aad61d67a988`／replay `5d54d37d-d237-4a32-85c1-62e77b33e79c`，SHA `a0c37cce67995662e5c70975d6ca44dd01574e5fe96578b773d44107c110449f`。20个移动区间在 **04:31:25.746–27.746 UTC** 累计 **3.776742565917233 XZ / 2.0002927000005 QPC秒**；21个端点105–125组件均非零，但图Z是 **20个已知非零＋1个未知**，不能写成21/21已知。index114（04:31:26.646）cache因 `parameter_entry_changed_during_read` 拒绝，CP因 `runtime_cp_requires_known_scalar_cache_mapping` 未进行派生指针读取；整行跨度2.2376ms、raw跨度0.3936ms。不得填零、拿cache替代或把模板unknown字段当作其他198行也无有效图索引。全捕获198对有效cache/CP无差异，另178个已知Z为零；4个小变化另计0.008602943212302192 XZ。

第二轮主线程画面共11帧：**04:31:26.374** 单帧及 **26.812、27.192、27.605、28.030、28.406、28.780、29.154、29.529、29.935、30.311 UTC**。C使玩家蹲下、视点降低，方向全程N；早期可见左右膝交替逼近，28.030后站定，随后抬臂、挥击、收臂、待机及第二次挥击。草仍遮脚，28.030仅部分脚掌可见；攻击姿势不是实际命中时机证明。实际running **04:31:25.696 UTC**，**04:31:35.977 UTC主动explicit_finish**，protection=false、cleanupError=null。11帧均在该完整采样内，不能由此扩大为全脚接触合格。

两轮12个raw字段均199行已知，前后 `E8D4=9`／bit20清、`E6E0=0`。第一轮 `E6E4=0/E628=198`，第二轮 `E6E4=97/E628=70`，`E8CC`均0；这些是字段读数，不是实际执行分支。第一轮M1940在index165前后7→15；第二轮M1940与E5E0在98/137/152/188前后变化，原值见小工件。整行跨度第一轮约2.22–14.27ms、第二轮约2.24–10.41ms。**顺序读取不是同帧原子观测，也未证明图在该帧真正消费Z、逐样组件速度等于图Z或动画根运动匹配。** request-gate修正后的更早捕获已有非零移动图Z；不能把这次方向修正单独归因为之前已经出现的输入改善。

时钟与版本没有放宽。第一成功回放于 **04:22:22.822 prepare、23.110 fullData、24.081 paused**；准备baseline版本1于23.875发送、23.882收到；启动POST在 **04:23:33.376→33.411**，随后baseline版本2于33.469发送、33.491收到flags8191。主线程04:28:36 GET保留count2/movementVersion2。第二回放 **04:29:58.918 prepare、59.277 fullData、04:30:00.233 paused**；准备baseline版本3在00.040发送、00.050收到。之后真实C输入 **04:31:25.331**，fresh-clock启动器只提交一次POST **25.523→25.552**，再于25.696实际running，未发送第四个baseline或增加三次预算。**C不是0x201旋转回执**：第二轮保留lastFlags=1、stance=2098243；方向N来自画面，不能由此标志或Z读数推定。

失败准备单列：`a6747df1` 在 **04:21:55.189 prepare、56.811 fullData、56.871 failed**，原因 `player_moved_before_start`，没有采样，不能混入上述两轮成功捕获。主线程 **04:36:36 UTC GET** 确认当前游戏18204／session1197702258仍alive、synced；无loadedNpc，回放finished，protection=false、cleanupError=null。该状态有时间界限；以下所有旧身份、失败和部署检查点原文保留，不代表当前状态。

后续第三轮移动玩家转向尝试**未通过，不能覆盖或升级前两轮证据**：replay `0ee1ed85-eaae-4e8a-96f9-fc8e645f36ae`／NPC `41d409c96190dac7` 于 **04:38:21.080 prepare、21.440 fullData**；时钟过期且baseline预算已3，仍等待ready。真实C站立输入 **04:39:08.502** 后08.750 paused；再次C **04:40:08.663**，helper POST **08.842→08.844**，09.039 running，但距原租约截止 **04:40:21.080** 仅12.041秒，主线程排程过晚。`=`自动行走在 **04:40:19.448** 启用，因中间工具／推理延迟，到 **39.496** 才停止；期间 **21.088已lease_timeout清理NPC**。迟到的 **40.510 finish** 保留failed、protection=false、cleanupError=null，不能改记主动结束。主线程报告 `043958.448204Z-pid18204` 捕获225样本、exit1 `npc_class_not_audited`，本检查点尚未独立分析，不能当完整capture或转向pass；租约移除后指针／类型验证失败只是待核假设。玩家现已停止，N朝向第三人称、更北草坡，无持续按键；**API保留的旧playerPosition不是移动后的实时终点**。04:36:36 GET只代表其当时时点。

命中链的新增边界见 `tools/task-01a06a01/swing-target-writer-contract-20260908.json`：主线程已全文读合同和三个原生log，并通过27＋29检查；CP为此次文档读取完整合同。已识别 `entity+F60/F68` 的网络指定／grapple目标写入和对称清除，但 `51B490` 在无可用指定目标时仍有空间查询回退，**不能把grapple目标当作普通追逐／近战缺一不可的前提**，更不能发送猜测的grapple包代替缺失逻辑。实际live F60、完整查询资格、上游消息身份和权威伤害路径仍未证明。

**整体goal未完成。** 仍缺精确脚底接触／打滑量化、移动玩家时转向、实际命中时机与实机障碍阻挡。当前实验是terrain-only，缺静态障碍移动门和近战遮挡门；此前真实围栏资产离线用例通过不等于实机碰撞通过。下一步先闭合围栏／静态障碍阻挡与对应近战门，不把未知几何当空地，也不扩展猜测的TS语义。以下全部历史正文逐字节保留。

---

# 僵尸追人攻击驱动链条 - 调查文档索引

**目的**：记录 H1Z1 客户端中「僵尸追人并攻击（带动画）」的网络包类型、函数链、已确认/猜想结论。按需加载，避免单次读取过大导致上下文超限。

**工作方式（与 AI 协作）**：**优先用 `PyGhidraCli`**（`DumpDecompile` / `QueryXref` / `SearchDecompile` / `FindMemoryRefsByOffset` / **`FindListingPattern`**（Listing 子串补漏）/ **`DumpListingWindow`**（CALL 点前后 Listing）/ **`ScanMemoryPattern`**（内存搜指针）等，结果进 `dev/ghidra/analysis/output/*.log`）；**仅当** CLI 无法实现或需 Ghidra GUI **Reference Manager / 手动画 xref** 时再请操作员开 **CodeBrowser**。

---

## 2026-09-08 12:19:45 baseline 方向修正已部署，尚未重载后实机验证

当前先读台账 `baselineForwardReload20260908_121945`。原生合同已由主线程和 CP 独立复核，`audit-update-location-direction.sh` 的24项检查通过：UpdateLocation 的原始 rotation float4 经 `535390 → 533550`，后者以 `[1,1,1,0]` 丢弃 W、归一化 XYZ，再以 `[0,1,0,0]` 叉积组成朝向矩阵，**不是四元数转矩阵**。之前将 yaw-only 四元数原样发送，会得到竖直方向（identity 时为零）与退化横轴；这是已证的非法 baseline 朝向机制，不能据此推定具体 N/W 回退角或独立 free-look 镜头语义。完整依据为 `tools/task-01a06a01/update-location-direction-contract-20260908.json`。

本次只改实验 `requestTestZombieClockBaseline`：规范化保存的 `[x,y,z,w]`，取本地 +Z 的水平 forward，发送 `[fx,0,fz,0]`。非有限、零范数、水平投影退化均失败不发包、不消耗预算；原 position、布尔、版本、时钟/租约门限与三次上限不变，不修改通用 UpdateLocation 调用或玩家原 rotation/yaw/lookAt。源码 SHA 为 `bbafe8fa4874e8988d96e0e5beb0d97e2362d1b61e6ad7ae8f68efe977d8c941`，编译 SHA 为 `d98444ece9b929eaf25d206d43c886b9e24f10374509c499217b6e40fa4db3b5`。来源测试74/74通过，主线程双 tsc 与扩展回归176项中的174通过、2项资产条件跳过、0失败；另于12:18单独运行 `test-real-fence-main.sh`，实际资产围栏用例1通过、0跳过。该单项实景资产测试不把前述两项跳过改记为通过，也不等于实机障碍碰撞验收。

主线程仅执行一次安全重载，**12:19:45.713921（UTC+08:00）** ready：Node `8324` / 创建时间 `1788841181.9951248`，supervisor `11692` / 创建时间 `1788841181.8719056`；日志 `h1z1-gitbash-01a06a01-x3405s87`，审计 `h1z1-reload-01a06a01-ku68x_v2/reload.json`。旧 Node `15048` 在 CTRL_C 后8秒仍运行，再次精确身份核验后仅终止该PID，退出码15；supervisor `10088` 退出码0，旧日志及退出证据保留。新适配器50项、历史50项、fresh29项 mock 经主线程及 CP 复核；三份编译指纹和完整路径在台账中记录。

重载前的12:05尝试单列：replay `d1fdcbd9-d15f-4f37-91fe-69299659381c` / NPC `0xe49c0b2e5013c0ab` 于04:05:21.165 UTC prepare、21.424 fullData、22.380 paused，baseline version2 在22.181；主线程画面报告 NPC 离屏，**没有 start、没有采样**。04:06:51.870 UTC `explicit_finish`，protection=false、cleanupError=null；04:13:18 UTC clients=[]。不算新的追逐或失败采样，更不能与旧捕获拼成成功配对。

主线程正常 UI 启动新游戏 `18204` / 创建时间 `1788841214.7204669`，窗口 `60360784`；12:20:14启动后仍在 LocalServer 选择页，尚无新 session。**截至本部署检查点，方向修正没有重载后 live 验证**；之前的一轮明亮可见配对和所有失败/离屏记录原文保留，整体目标未完成。新只读入口 `read-runtime-status-1220.sh` 固定8324/11692、两个GET、前后身份/端口核验与16KiB/30行日志上限；18项 mock 和 shell语法通过。此文档/工具作者没有调用新状态入口、API、UI、内存或任何进程动作，部署、回放和游戏状态均引述主线程证据。

## 2026-09-08 11:57:23 新旋转版本两轮观测：一轮可见配对，镜头问题仍在

最新先读台账 `postRotationPairedObservations20260908_115723`。CP 独立复跑同一离线比较器，主线程已核对数字；以下画面和 API 描述均**引述主线程记录，不是 CP 亲自观看或操作**。初始 prepare `73bcb46f` 因 `player_moved_before_start` 失败，不计作成功验证。

第一轮 `034853` / NPC `b821217017138b1c`：298 样本、exit 0，SHA `9f6a8d95840539c19d756ebfbef01a306cf597d12a59295ef547025482945e12`。20 个移动区间累计 **3.62290 原始 XZ 单位 / 1.93097 QPC 秒**；全捕获 21 个组件非零样本，其图 Z 全部已知且非零，298 对 cache/CP 无差异。主线程于 **03:49:04.751 UTC** running，明亮第一人称 **7 帧 03:49:04.952–03:49:06.809 UTC** 的 NPC 持续在前方接近，可见交替迈步和屈膝；早中段脚部完整，最近处脚部超出画面底边，不能说七帧均全身可见。七帧均落在完整原生采样内；**03:49:24.401 UTC 主动 `explicit_finish`**。这是可用的画面/原生数据配对，不代表精确脚底打滑已消失；加减速时组件速度模与图 Z 仍非逐样相等。

第二轮 `035110` / NPC `73dd3bb92cb1ba06`：299 样本、exit 0，SHA `452410c93a4061334ca71a3ebb3de14f292e2ff89df0d2395f3387672665410b`。20 个移动区间累计 **3.61999 XZ / 1.99991 QPC 秒**；20 个组件非零样本中，19 个图 Z 已知且非零，尾端 index148 因 `runtime_cp_payload_changed_during_read` 拒绝为 unknown，不能填零或拿 cache 替代，不能写成 20/20 通过。21 个移动端点另外含一个起始组件/Z 均为零的端点；298 对已知 cache/CP 无差异。主线程 **03:51:23.367 UTC** running，但 **8 帧 03:51:22.412–03:51:24.818 UTC** 镜头由 N 转 W、NPC 全离屏，不能算第二轮可见配对。实际清理为 **03:52:17.227 UTC `lease_timeout`**；迟到的 **03:56:13.104 UTC** finish 不改变这个结束原因。

两轮 12 个 raw 字段均已知，前后 `E8D4=9`、bit20 清、`E6E0=0`；第二轮 `E6E4` 有变化但不推断其执行语义。顺序读取非原子：第一轮跨度约 2.26–16.76 ms，第二轮约 2.22–8.82 ms；第二轮失效端点的整行跨度为 2.5102 ms，保留其 unknown。两轮各有 3 个低速小变化另行统计，精确数值见台账。

主线程 **03:57:23.353 UTC** GET 所见保留时钟诊断为 baseline `count=1`、`requestedAt=1788839482159`、version `1`；`lastReceivedAt=1788839482178`、flags `8191`。对应次序是 **start POST 03:51:22.047 → baseline 22.159 → 入站状态时间 22.178**，之后 22.412 起画面离屏。已部署的 0x201 窄修正没有解决所有镜头场景，但“是否仅由该时序导致”仍待原生调查核对，不能提前宣布唯一根因或新修复。

当前只有这一轮新增可用明亮配对，**尚不能宣称已完成至少两次完整配对、精确脚底滑移验收或整体目标**。以下历史检查点原文保留。

## 2026-09-08 11:45:13 旋转状态修正已部署，等待新的配对验证

当前先读台账顶部 `stanceRotationReload20260908_114513`。主线程已执行一次安全重载，**11:45:13.198226（UTC+08:00）** ready：Node `15048` / 创建时间 `1788839109.4790003`，supervisor `10088` / 创建时间 `1788839109.359062`；日志 `h1z1-gitbash-01a06a01-zmf859oz`，审计 `h1z1-reload-01a06a01-osi8q_95/reload.json`。旧 Node `288` 在 CTRL_C 后8秒仍运行，经再次核验身份后仅终止该PID，退出码15；旧 supervisor `9532` 正常退出码0。三份已审编译SHA与精确路径见新台账条目，历史适配器没有修改。

新进程已加载有限值0x201朝向保存修正，baseline布尔/版本/预算及出血逻辑不变。主线程通过正常UI启动游戏 `9260` / 创建时间 `1788839131.9041264`；**此部署检查点尚未取得旋转修正后的可见脚步与完整原生采样配对验证**，不能把旧画面、旧采样或源码回归当作新进程的步态验收。11:42:33的 `firstPersonPrefixTimeoutAndRotationBuild20260908_114233` 原文保留，尤其109行静止失败前缀不能与之后七帧迈腿画面拼接。

新只读入口为 `tools/task-01a06a01/read-runtime-status-1145.sh`：固定上述身份，沿用两个GET端点、禁止跳转、前后身份/端口核验及16KiB/30行日志上限。18项mock与shell语法检查通过；文档更新者仅准备和测试入口，**未实际调用新状态入口或执行任何live操作**。部署和游戏启动事实来自主线程记录。

## 2026-09-08 11:42 第一人称画面与采样失败边界

先读台账 `firstPersonPrefixTimeoutAndRotationBuild20260908_114233`。第一人称七帧（03:36:26.624–28.327 UTC）确有可见交替迈腿和接近，但夜间画面不足以精确量化脚底打滑。对应 `033615` 采样在 running 前停止：109 行全部静止、exit1 `timed out`，没有一行与迈腿画面重叠，不能拼成同步输入证据。失败 SHA、主动 finish（03:36:29.375）、保护撤销及复核入口均已记录。超时落在每秒本地状态 GET 的200ms超时路径附近，具体连接/读取子阶段和服务端原因未证；未放宽采样器检查或超时。

0x201 旧朝向修正已经源码审查、双 tsc、22项协议测试、55项来源测试及135项回归通过（另2项实景障碍跳过，不算通过）。它仅保存合法朝向后保留 gameplay early return，不改 baseline 限额或布尔语义。11:42检查点尚未重载：游戏已正常退出、无在线玩家或活动回放，安全适配器的mock及只读preflight通过。仍须完成新的可见脚步与完整采样配对验证，不能宣称整体目标完成。

## 2026-09-08 11:34:20 首次第三人称可见追逐：输入改善复现，脚底仍未验收

最新条目为 `thirdPersonVisibleChase20260908_113420`。CP 独立运行 `compare-postfix-033326.sh`，捕获 `npc-locomotion-20260908T033326.810010Z-pid19320.jsonl` 的 SHA 为 `06a34c0c8c7f2ee5900fe87834721712a54d912b859c3f6a4f58d9846b7fd51e`，299 样本、exit 0。12 个 raw 字段全部已知，前后 `E8D4=9`、bit20 清、`E6E0=0`。

同口径 18 个移动区间累计 **3.66180 原始 XZ 单位 / 1.79991 QPC 秒**；19 个移动端点的图 Z 全部非零，端点内 18 个组件速度非零样本也均有非零图 Z。299 对 cache/CP 无读数差异。必须保留例外：全捕获有 19 个组件非零样本，其中起步 index109（03:33:37.974 UTC，约 0.1）图 Z 为零，但不属于上述移动端点；停止端点 index128 组件已为零、图 Z 仍约 0.15625。另 3 个低速小变化累计 0.00744629，单独统计。顺序非原子读取跨度约 2.30–10.87 ms，不能写成逐样速度完全一致或同帧动画消费已证。

主线程记录 replay `ef2bae15-2c2c-4a1d-9d78-406914f71529` / NPC `3d87bfefeea22c3c` 于 **03:33:37.905 UTC** running。第三人称 12 帧 **03:33:38.150–03:33:42.039 UTC** 可见 NPC 接近、停住、攻击，但后半段脚部受玩家角色遮挡，**仍不能确认精确脚底打滑消失或正确交替步态通过**。实际清理是 **03:34:20.524 UTC `lease_timeout`**，主线程 finish 发晚，不能改记为 explicit finish；采样在 03:33:56.810 UTC 已结束，清理属于另行 API 证据。

这是第二份移动输入改善的数据，不是两次步态验收通过。本条不新增 0x201 旋转修复的部署声明；后续 `033615` 捕获由另一调查处理，未分析、未混入本轮。以下所有历史检查点保留不变。

## 2026-09-08 11:28:43 首轮 request-first 追逐数据与后续未启动尝试

最新先读台账顶部 `requestGateFirstMovingLive20260908_112843`；下面的重载、静止采样和旧调查记录保留为历史。主线程与 CP 独立审查均复跑现有只读比较器，首轮捕获 `npc-locomotion-20260908T031919.497243Z-pid19320.jsonl` 的 SHA 为 `29277963d32187cb9b2be1e30fa305de68db1789dafc111a63c18e783953054f`，299 样本、exit 0。

这轮确有位移：18 个相邻移动区间累计 **3.68279 原始 XZ 单位 / 1.79941 QPC 秒**，另 3 个低速小变化单列、不混入该统计。12 个原始字段全程已知，前后 `E8D4=9 (0x09)`、bit20 已清、`E6E0=0`。19 个移动端点中只有起始端点的图 Z 为零；**18 个组件 XYZ 速度非零的样本，其图内 Z 全部非零**，旧基线同口径为 18 个中 16 个图 Z 仍为零。299 对 cache/图内 CP 没有读数差异。这是动画输入读数明显改善，不等于同帧动画图已消费、正确交替脚步或滑步修复；减速端点的组件速度模与图 Z 也不是逐样完全相等，顺序读取跨度为约 2.25–20.52 ms。

主线程记录的首轮 replay 前缀 `f6f98a9f` 于 **03:19:32.192 UTC** 开始运行，但九帧 **03:19:31.273–03:19:34.043 UTC** 的 NPC 全部在画面外，不能作为可见步态证据。按 C 后、baseline version 1→2 期间镜头由 E 翻到 W。首轮实际结束是主线程 API 所见 **03:20:24.472 UTC `lease_timeout` 自动清理**；finish 请求晚了约 9 秒，不能改记为主动 finish。采样在 03:19:49.498 UTC 已独立结束，它本身不证明后续清理。

后续两次不能计作新的追逐验证：`edde0656` 于 **03:22:14.148 UTC** prepare、**03:24:14.148 UTC** 租约超时，`startedAt=null`、无采样；`3b03d891` / NPC `e315918de681a90f` 于 **03:27:23.630 UTC** 仍在 `waiting_ready`，**03:28:43.279 UTC** 主动 finish，protection=false、cleanupError=null，未 start、无采样。上述 API/UI 时间来自主线程，独立审查员只读取已关闭文件，没有操作活体。

**0x201 旧 rotation 问题仍在独立调查处理，本检查点不声称已修复或已部署。** 下一步仍需正常准备后获得 NPC 全身与脚部可见的受控追逐，并重复原生输入观测；当前不能把数值改善当作动画或交互验收通过。临时 TS 继续只作实验驱动，不作为原版语义依据。

## 2026-09-08 11:15:25 准备流程重载后的当前检查点

当前先读台账顶部 `requestGateReload20260908_111525`；以下首轮实测和较早部署记录均保留，不将其中的旧运行状态当作当前身份。主线程已完整复核新适配器与测试，49 项纯 mock、实际只读 preflight 均通过；CP 独立审查报告 48 项检查通过、无阻塞。随后只执行一次安全重载，新 request-first 测试准备流程已在服务端加载。

北京时间 **11:15:25** ready：Node PID `288` / 创建时间 `1788837322.3992589`，supervisor PID `9532` / 创建时间 `1788837322.280063`；日志 `h1z1-gitbash-01a06a01-hqmm71w_`，审计 `h1z1-reload-01a06a01-pxj0cb2_/reload.json`。旧 Node `5620` 在 `CTRL_C` 后 8 秒未退出，经身份复核后仅终止该 PID，退出码 `15`；旧 supervisor `12256` 退出码 `0`。两份编译 SHA 与完整身份记录见台账新条目。

本检查点的新游戏 PID `19320` / 创建时间 `1788837406.679994` 正在正常 UI 启动。**新准备流程重载后尚未进行追逐验证，不能宣称滑步已经修复**；之前 bit20 清除的 299 行采样全程静止，仍不算追逐或步态成功。主线程稍后补充正常请求链、只读原生数据与可见步态的实机验证；本次只更新文档，没有进程或游戏操作。

## 2026-09-08 11:06 首轮修复后实机结果

当前先读台账顶部 `fullNpcFirstLive20260908_110605`。新客户端18892成功入服，30秒只读采样299行完整结束：`E8D4`前后全部为1（旧基线为41），等待完整数据的bit20已清除；但全程静止，不能计作追逐或步态验证通过。主线程已复核完整离线比较器并复跑。原始文件与SHA、会话、NPC、正常清理时间均保存在该条目中。

已定位临时测试流程的新卡点：刷怪主动发送完整DB后，又只等真实客户端完整数据请求才启动准备循环；修复后的主动DB使这个补发请求不再出现。现已窄改为先发轻量NPC、收到真实owner请求后完成标准初始化，时钟/落地/租约检查保持不变。11:12编译与22项协议/schema测试通过；扩充回归135通过、2跳过、0失败（跳过的实景障碍用例不算通过）。11:10检查时Node5620/监督12256仍运行，游戏已正常退出，API无在线玩家，无活动采样或回放；新准备流程尚未重载。首次游戏启动退出的原因仍未知，正常重试后成功，不归因于本次NPC补丁。

## 2026-09-08 10:59:58 重载后的续接入口（历史检查点）

先读 [chain_graph_param_writers.json](chain_graph_param_writers.json) 顶部 `fullNpcNativePrefixAndReload20260908_105958`。以下 9 月 7 日入口和较早台账保留为历史，不代表本次重载后的当前状态。

客户端原生 DB 解析器的裸 Walker 空分支已独立闭合：从包首读取到六个尾部长度块的边界为 **183 字节**，不再依赖 TS schema 分段。主线程已全文复核并复跑 [总审计](../../../tools/task-01a06a01/audit-db-parser-empty-prefix-tail.sh)：5 个 `.pdata` 范围、4 个闭合叶函数、28 个字节锚点通过。从真实旧包 byte0 开始的独立空分支模型确认，旧 231 字节包在最终必需 DWORD 处越界；补入缺失的空 `remoteWeapons` 长度 DWORD 后，235 字节包恰好完整消费。235 个逐字节截断及负长度、超长、非空可选 tag、尾随字节 4 个负例均被拒绝。此处是静态合同与离线模型，不是客户端已接收的证明；非空子结构和 opaque blob 语义尚未全面恢复。

主线程已于北京时间 **2026-09-08 10:59:58** 成功重载：新 Node PID `5620` / 创建时间 `1788836394.550098`，新 supervisor PID `12256` / 创建时间 `1788836394.4308667`，日志目录尾缀 `tq375v3g`，重载审计 `h1z1-reload-01a06a01-7lstyryl/reload.json`。旧 Node `3920` 收到 `CTRL_C` 请求后 8 秒仍未退出，主线程再次核验单一 PID 身份后终止，退出码 `15`；旧 supervisor `21112` 退出码 `0`。

本记录时新游戏 PID `10808` / 创建时间 `1788836483.034378` 正在 UI 载入，**尚无修复后采样，不能宣称滑步已经解决**。下一步是在正常加载后，通过只读 `entity+8D4` 的 bit20、速度/Z CP 与可见步态，验证客户端完整化是否真正接受，以及修复对追逐动画的实际影响。临时 TS 仍仅作实验驱动，不作为原版语义依据。

---

## 2026-09-07 续接入口（历史）

先读 [chain_graph_param_writers.json](chain_graph_param_writers.json) 顶部的新记录。9 月 6 日已经两次实机验证“无需人物移动，自动生成僵尸并贴地追近攻击”；这不代表原生命中时机、静态/动态障碍、人物碰撞和脚底契约已经完整恢复。临时 TS 只作为实验驱动，不作为原版行为依据。

本轮只读 PE 分析已连接 `SwingContact` 注册回调 `140aa7450` 与 NPC `virtual+0x790 = 14051a900`。该函数不能再仅作为无关反馈旁支排除；应优先重新反编译其状态/目标检查及可能回包。此路径的 float 参数来自事件 userdata，不是已证明的角度或伤害值。可用 `tools/h1z1_sampled_event_offline_audit.ps1` 复现原始字节证据，尚未实测接触时刻或客户端命中上报。

应用更新后旧游戏服务和 PyGhidra 已退出，普通恢复启动被工具策略拒绝；当前没有运行中的实机验证。新增 `scripts/start-zombie-test.ps1` 用于没有旧 PID 的手动冷启动准备，但仅完成语法/代码检查，不能宣称已经启动。具体恢复限制、真实围栏回归和可见门碰撞发现见上述台账，避免重复走旧 PID 或把未知几何当作空地。

---

## 阅读顺序建议

| 优先级 | 文件 | 用途 |
|--------|------|------|
| 1 | [main-latest-server-packet-driving-mrn-func-chain-guess.md](main-latest-server-packet-driving-mrn-func-chain-guess.md) | 当前最新结论与待办（精简版） |
| 2 | [round-6-npc-animation-state-machine.md](round-6-npc-animation-state-machine.md) | **第六轮突破**：FUN_14053fde0、UpdateCharacterState、entity 状态位 |
| 3 | [packet-format-mismatch.md](packet-format-mismatch.md) | H1EMU schema 与客户端解析器格式差异（22B vs 12B）；**`FUN_140511840` 须 `param_2=10`** 才进 `FUN_1404f1080` |
| 4 | [open-questions.md](open-questions.md) | 未解问题与下一步调查方向 |
| 5 | [re-track-update-character-state-chain.md](re-track-update-character-state-chain.md) | **re-9**：case9→`53d4e0`（**Q1/T0**）；**`DAT_142b249a0`=全局 0**，param_5 槽为 **空句柄**（见 [dat_142b249a0_global_sentinel.json](dat_142b249a0_global_sentinel.json)）；Q0 栈槽仍待查 |
| 6 | [ucs-4f1080-param-alignment-pyghidra.md](ucs-4f1080-param-alignment-pyghidra.md) | **CALL `5141A0`**：`RDX`/包首 vs **`+10`**、**长度 32 vs 22**；PyGhidraCli 命令表；与 x64dbg 对齐 |
| 7 | [ucs-5141a0-align-probe-al01.md](ucs-5141a0-align-probe-al01.md) | **实机探针实锤**：同一 CALL 点两次命中，`AL` 从 **0 -> 1**（改 `RDX+=0xA, R8D=22`）；含 **玩家 self + zone-public 按钮 + `--phase1-charid-le-hex`** |

---

## 分块文档列表

### 核心结论（按轮次）

| 文件 | 内容概要 | 状态 |
|------|----------|------|
| [round-6-npc-animation-state-machine.md](round-6-npc-animation-state-machine.md) | NPC 动画由 entity state flags 驱动；FUN_14053fde0；UpdateCharacterState；states6.bit2=战斗模式 | ✅ 当前主线 |
| [round-5-playanimation-npc-stub.md](round-5-playanimation-npc-stub.md) | PlayAnimation 对 NPC 无效；NPC vtable +0x620/+0x630 为空桩 | ⚠️ 已推翻 PlayAnimation 路径 |
| [round-3-4-character-packets.md](round-3-4-character-packets.md) | Character 包表；ActivateProfile=case 0x30；record 布局；IPToStateMapEntry | 📌 玩家/武器链参考，NPC 可能不同 |

### 参考与排除项

| 文件 | 内容概要 |
|------|----------|
| [excluded-side-chains.md](excluded-side-chains.md) | 已排除/降级的侧链（避免重复调查） |
| [resource-mrn-anchors.md](resource-mrn-anchors.md) | 僵尸/动物 MRN 资源、ControlParameters 名称 |

### 协议与格式

| 文件 | 内容概要 |
|------|----------|
| [packet-format-mismatch.md](packet-format-mismatch.md) | 原生 parser 以完整包首消费 22B；H1EMU 12B 尾与 opcode/characterId 合计正好 22B；观测与后续状态链分栏 |
| [ucs-5141a0-align-probe-al01.md](ucs-5141a0-align-probe-al01.md) | `ucs_entity_chain_align_probe.py` 探针流程、`AL 0->1` 实测、判断与下一步 |
| [open-questions.md](open-questions.md) | 未解问题、下一步优先级 |

---

## 快速锚点

- **NPC 动画驱动**：`FUN_14053fde0` 读取 `entity+0x8ca`/`entity+0x8cf` 决定 iVar13；**`0x8cf` bit2/bit3** 主要由 **`FUN_1404ff870`**（读 **`entity+0xa3`**）写入
- **控制包**：0x0f0a → case 9 → **`FUN_1404f1080`**（22B）→ **`FUN_14053d4e0`** 入队 **`0x1170`** → **`FUN_1404e1de0` → `FUN_14071b000`**（全局注册）→（tick）**`FUN_140526310`** 合并 **`0x35b`**（详见 [main-latest](./main-latest-server-packet-driving-mrn-func-chain-guess.md)）
- **states6.bit2**：hidesHeat = 战斗/攻击模式（iVar13=6/7）（见 round-6，语义与 wire Q1 各位**未逐位钉死**）
- **DevHttp 测试（仓库事实，非逆向）**：见 `src/servers/ZoneServer2016/managers/devhttpserver.ts` + `dev/zone-public/index.html`
  - **`GET /api/npcs/set-state-raw-hex`**：`H1Z1Protocol.pack("Character.UpdateCharacterState", …)` 直接得到客户端 `FUN_1404f1080` 消费的 **22B**；响应保留 `case9Bridge` 字段名以兼容旧脚本，但不再追加字节。
  - **`GET /api/npcs/ucs-case9-from-h1emu`**：按 query（如 `hidesHeat=1`）用 **H1EMU states 语义** 生成 **22B** 原生完整包。
  - **`GET /api/npcs/ucs-case9-raw-hex`**：总长 **22B** = opcode **2B** + `uint64string` characterId **8B** + schema 尾 **12B**；**T0** = `getCurrentServerTimeWrapper().getTruncatedU32()`（与 Zone 内其它封包同源）。
  - **`POST /api/npcs/ucs-case9-sweep`**：同上构造，逐 bit 发 Q1；**gameTime** 起算同上 API，可 `incrementGameTime`。
  - **`POST /api/send-raw`**：任意 hex → `ZoneServer2016.sendRawDataReliable`，与 `sendData` 同隧道路径（`GatewayServer.sendTunnelData`，Reliable）。
