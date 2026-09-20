# 包格式不匹配

## Character.UpdateCharacterState (0x0f0a)

**槽位与置信度（展开版）**：[re-track-update-character-state-chain.md](./re-track-update-character-state-chain.md) 内 **「22B 槽位模型」**（表 A～D：格式确定 / 语义待钉 / RAW 假设）。本文的 22B 均指包含 opcode 的完整包。

### H1EMU schema 输出

- 格式：`[opcode 2B][characterId 8B][states1-7 7×1B][placeholder 1B][gameTime 4B]`
- 总长：**22 字节**（`0x0f0a` 变长 opcode 占 **2B** + DataSchema 正文 **20B**）
- **`h1z1-dataschema`**：`bitflags` 与 `boolean`/`uint8` 一样各写 **`writeUInt8` 1 字节**（非位压缩到单字节）

#### 服务端实测（`tsx` + `DataSchema.pack`）

- 包体（无 opcode）：**20B**；完整包（含 2B opcode）：**22B**。
- `characterId` 之后的 schema 尾仍是 **12B**（7×`bitflags` + `placeholder` + `gameTime`），但它与
  opcode、characterId 一起正好组成原生 parser 的完整读取范围。

### 客户端解析器期望（FUN_1404f1080）

- `param_2` 指向**完整包首**（包含 2B opcode），从该地址读取
  `[1B][1B][8B qword][8B qword][4B uint32]`（小端）。因此 0x0f0a 的完整输入正好是 **22B**。
- 调用需满足长度检查，且 case 9 路径传入解析器第 4 参数为 **`0`**（见 [re-track-update-character-state-chain.md](./re-track-update-character-state-chain.md)）。

### 客户端分发器 `FUN_140511840`（事实：第二实参 ≠ wire A0）

- 反编译对第二实参做 **`switch((int)param_2 - 1)`**；进入 **`FUN_1404f1080`** 的路径对应 Ghidra 标签 **`case 9:`**，要求 **`param_2 == 10`（十进制）**，**不是 9**。
- **不要**把 **22B 首字节 A0** 与 **`param_2`** 混为一谈：前者是 `FUN_1404f1080` 从完整包首读到的第一个字节（对 0x0f0a 即 opcode 高字节）；后者是 **调用 `FUN_140511840` 时的分支选择**，由更上层传入。
- 依据：`DumpDecompile 0x140511840`（`switch((int)param_2 - 1)` + `case 9:` → `FUN_1404f1080`）；详述见 [re-track §re-2](./re-track-update-character-state-chain.md)。

### 结果

- H1EMU 的完整 schema 包是 **22B**，与 `FUN_1404f1080` 以包首为基址的消费范围一致。
- **不应追加 10B 或重排成 32B**；`sendData` 生成的 22B 即为原生 case9 wire。

### 与 `FUN_1404f1080` 对齐的 wire 编排（事实：读序与长度）

相对 `FUN_1404f1080` 的 `param_2`（完整包首），**22B**（小端）在反编译中的读法为：

| 偏移 | 大小 | 表记 |
|------|------|------|
| 0 | 1 | A0 |
| 1 | 1 | A1（有符号扩展） |
| 2 | 8 | Q0 |
| 10 | 8 | Q1 |
| 18 | 4 | T0（uint32，re-9 Listing 与入队首 DWORD 一致） |

**re-9 Listing（事实）**：case 9 路径上入队 **`0x35b`** 的 SET/CLEAR 来自 **wire Q1** 与 **`~Q1`**；**T0** 作 gameTime 相关首 DWORD；**Q0**（在完整包中就是 characterId）不进入 `FUN_14053d4e0`。H1EMU schema 尾的 8B states/placeholder 位于完整包偏移 10，正是 Q1 的位置。

### 全包长度（opcode + 正文）

- **`H1Z1Protocol.pack`**（`src/protocols/h1z1protocol.ts`）：`getPacketTypeBytes(opcode)` + DataSchema 正文；对 **0x0f0a** opcode 占 **2 字节**（`0x0f`、`0x0a`）。
- 完整包长度：**2 + 8 + 12 = 22 字节**。

### 服务端 DevHttp 构造（仓库可核对事实）

**文件**：`src/servers/ZoneServer2016/managers/devhttpserver.ts`（`DevHttpServer`）。

1. **`pack("Character.UpdateCharacterState", { characterId, states…, placeholder, gameTime:0 })`** 直接得到与 **`sendData`** 相同的 **22B 原生 case9 完整包**；不丢弃 schema 尾，也不追加 payload。
2. **`characterId`**：经 `normalizeCharacterIdForPack` 转为 **`0x` + 16 位 hex** 再 `pack`，与 **`h1z1-dataschema`** 对 `uint64string` 的编码一致（避免手写 `writeBigUInt64LE` 与 pack 不一致）。
3. **T0（gameTime）**：**不再由页面/query 提供**；`GET ucs-case9-raw-hex` / `POST ucs-case9-sweep` 使用 **`getCurrentServerTimeWrapper().getTruncatedU32()`**（与 `entities/npc.ts`、`zoneserver.ts` 等同源）。

### 实测（观测事实，非「客户端未执行」的证明）

- x64dbg 对原生调用点的记录显示：`param_2=包首、长度=32` 时 parser 返回失败；把同一缓冲临时改为 `param_2+0x0a、长度=22` 能返回成功。结合 parser 的严格“无剩余字节”检查，生产线上应发送**包首起始的 22B schema 包**，而不是 32B。
- 采用 32B 发送的上一轮录像因此不能证明状态链无效；修正为 22B 后仍需用同一 NPC 录像验证 `0x35b → 0x8cf` 的后续链。
- **re-track 已确认（逆向）**：`0x1170` 出队消费 **`FUN_140526310`** 主写 **`0x35b`**，**不**直接写 **`0x8cf`**；**`0x8cf` bit2/bit3** 多由 **`FUN_1404ff870`**（**`entity+0xa3`**）写入。
