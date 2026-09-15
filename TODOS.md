# 客户端逆向：下一步（言简意赅）

- 验证 **0x04 (PlayAnimation)** 整链：收包→解析→68bfa0→handler→效果；跑 `VerifyPlayAnimationPath.py` 看 68bfa0 内对 1420633d0 的引用与 0x04 常量、62dcc0 传参。
- 若 68bfa0 未读 buffer 首字节，追踪 **65aff0→65a970→65aa40** 谁先解析 opcode。
- 勿仅靠服务端多发/改动画名试；包有效性须在客户端整链验证（见 CHRONICLE 调查方法）。

---

# ⚠️ 僵尸刷怪与驱动：以客户端为准（当前均为实验性）

**当前服务端所有僵尸相关逻辑（刷怪方式、AddSimpleNpc、SeekTarget、MemberStatus、PlayerUpdatePosition、动画等）均为实验性。** 能看到僵尸模型只说明部分包被客户端接受，**不表示刷新/移动/碰撞的流程正确**。正确行为应以**客户端实现**为准，通过以下方式确认：

- **Ghidra 逆向**：见 `scripts/ghidra/`，分析 H1Z1 客户端对 AddSimpleNpc、SeekTarget、0x0fxx 等的处理与期望的包序。
- **Ghidra 逆向**：从客户端二进制确认刷怪/移动包序列与字段（官服已停运，无法抓包）。

在未以客户端为准确认前，请勿把现有实现当作“正确形态”依赖。

---

# ✅ 调查刷僵尸出来往人物那移动卡死的原因
是因为 recast 第一次为该僵尸 createAgent 时阻塞，整个后端挂掉。测试僵尸用 skipNavAgent 绕过。

# 僵尸移动：服务器权威 + 状态/通知（未完成）
共识：不是「服务端循环刷位置+动画」，而是**服务器权威逻辑**；客户端可能依赖**状态切换**和**行为通知**才会正确播转向/行走/攻击。

建议实现顺序：

1. **吸引力/寻敌**（已有基础）
   - 保留/整理：getNearestPlayerInRange、距离与视野判断，作为「是否进入 Chase」的输入。

2. **显式状态机 Idle → Chase → Attack**
   - 在 NPC 上维护状态：`idle` / `chase` / `attack`。
   - 逻辑：无目标或超距 → idle；有目标且不在近战范围 → chase；在近战范围 → attack（并打近战）。
   - 状态**变化时**才发通知包，而不是每 tick 都发位置。

3. **状态变化时发的协议**
   - **Character.MemberStatus** (0x0f26)：`characterId` + `unknownByte1`。推测可用于「当前行为状态」（如 0=idle, 1=chase, 2=attack），需 Ghidra 逆向确认含义。
   - **Character.SeekTarget**：进入 Chase 时发（目标变化时已有），表示「正在追这个目标」。
   - **Character.PlayAnimation**：进入 Attack 时发攻击动画（近战已在用）；Chase 时可尝试发行走动画或依赖客户端根据 MemberStatus/SeekTarget 自播。

4. **ActionRequest / Notify 等**
   - 协议里已有 `Character.MemberStatus`，暂无 `ActionRequest` 等名字；若客户端有「请求/确认」流程，需在 Ghidra 逆向中再查。
   - 实现完 2+3 后，若仍不转身/不走路，再查是否有其它 Notify 或 Command 包需在状态切换时发送。

当前：DISABLE_NAV 默认、僵尸能**转向**，但仍**漂移**无走路、无攻击姿势；且玩家能**穿僵尸模型**、远距离被判定掉血。

**发现**：僵尸与门/物品一样只发了 **AddLightweightNpc**，客户端可能当“轻量物品”处理（无碰撞、无角色动画）。农作物“动画”是 **Character.ReplaceBaseModel** 换阶段模型 + 施肥用 **Character.PlayWorldCompositeEffect**，不是 PlayAnimation。BaseFullCharacter 已 isLightweight=false，且生成后已立即发 **LightweightToFullNpc**，仍**漂移+穿模**。

**结论**：穿模/漂移大概率客户端行为。服务端已加：生成 Npc 后发 **Character.SetCollidable**(unknownByte1:1)；Chase 发 SeekTarget 时顺带 **Character.ExpectedSpeed**(speed:90)。若仍穿模/漂移再靠 Ghidra 逆向查协议。

---

# 僵尸漂移/不走路：刷怪方式调查（CLI + 代码结论）

- **导出与 CLI**：用 `analysis/client/export/` 的 symbols、data_strings、data_scalars、refs 与 `query.mjs` / `query-analysis.mjs` 查客户端对包名的引用；服务端 opcode 见 `analysis/server/character_opcodes.json`。
- **当前刷怪路径**：僵尸 (Npc) 继承 BaseFullCharacter → BaseLightweightCharacter，`useSimpleStruct` 默认 false，走的是 **AddLightweightNpc → LightweightToFullNpc → SetCollidable**。客户端里三种包名并存：`cPacketIdAddLightweightNpc`、`cPacketIdAddSimpleNpc`、`cPacketIdLightweightToFullNpc`；若客户端按「先收到 AddLightweightNpc 就当轻量/物品」处理，则即便后发 LightweightToFullNpc 仍可能不走路、漂移、穿模。
- **试验结果**：曾改为 Npc 用 **AddSimpleNpc** 刷出（`useSimpleStruct = true`），结果僵尸**连走都不走、仍穿模**，已回退。当前恢复为 **AddLightweightNpc → LightweightToFullNpc → SetCollidable**（至少之前有漂移说明有在动）。下一步需用 **Ghidra 反编译** 核对 **SeekTarget / MemberStatus / ExpectedSpeed** 的包序与字段（官服已停运，无法抓包）。

---

# 待办：Ghidra 导出 + CLI 工作流（先 JSON 后按需 PyGhidra）

- **思路**：分析已在 GUI 里完成，导出 symbols/strings/scalars（及 refs）到 JSON 后，日常用 **CLI 查 JSON**（query.mjs）即可；需要更深入时再**按需**用 PyGhidra 做**少量、有针对性的**调查（例如对某地址查 xref、对某符号反编译等），而不是每次全量导出。
- **refs.json 当前为临时不全量**：导出时受 MAX_REFS_EXPORT（如 50 万）上限，并非正好这么多引用，实际更多。依赖 refs 的 xref-to / xref-from / opcode 结果可能不全。**待办**：制作「按需动态查 Ghidra 工程」的脚本，用 **PyGhidra** 驱动（工具链、环境与 run_export_pyghidra.py 一致），给定 address 返回 getReferencesTo/From，供 CLI 与后续 AI 做更完善、更精准的 xref 查询。