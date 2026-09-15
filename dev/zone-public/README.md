# Zone 开发工具（本机 HTTP）

Zone 启动时可开启**仅监听 127.0.0.1** 的 HTTP 服务，用于：

- **静态文件**：提供 `zone-public/` 下的页面（如 `index.html`）
- **API**：客户端列表、代发包等

## 端口与开关

- 使用 **scripts/demo** 启动时，默认端口为 **13371**（可通过 `DEV_HTTP_PORT=0` 关闭，或 `DEV_HTTP_PORT=端口` 指定其它端口）。
- 直接 `new ZoneServer2016(..., devHttpPort)` 时，传入大于 0 的端口即可；或设置环境变量 `DEV_HTTP_PORT=端口`。

## 访问

浏览器打开：**http://127.0.0.1:13371/**（端口以实际为准）

- 会加载仓库内 **`dev/zone-public/index.html`**（相对项目根），可刷新客户端列表、对指定目标发送 `Chat.ChatText`。

## API

- **GET /api/clients**  
  返回当前在线客户端列表：`{ clients: [ { sessionId, soeClientId, characterId, name } ] }`

- **POST /api/send**  
  Body: `{ "target": "角色名|characterId|sessionId", "packet": "Chat.ChatText", "data": { "message": "..." } }`  
  服务端会按 `target` 查找客户端并代发该包。后续可扩展更多 packet 类型。

- **GET /api/npcs/set-state-raw-hex**  
  返回 **`H1Z1Protocol.pack("Character.UpdateCharacterState", …)`** 的 hex（**charId 后 12B** schema）。**不是**客户端 `FUN_1404f1080` 的 **22B** wire；JSON 内另有 **`case9Bridge`**（**32B** 桥接 hex，供 `/api/send-raw`）。

- **GET /api/npcs/ucs-case9-from-h1emu**
  按 **H1EMU states 语义**（query：`hidesHeat`、`nearDeath`、`visible`、`knockedOut`、`placeholder`、`gameTime` 等）生成 **32B** case9 形全包；**Q1** = pack 尾部 **states1..7+placeholder** 共 8B。用于与 **`set-state-raw-hex`** 对照、或对僵尸发 raw 试 **states6**。

- **GET /api/npcs/ucs-case9-raw-hex**  
  生成 **32B** 全包：**前 10B** = 与 `sendData` 相同的 **opcode + `uint64string` characterId**（由 `pack` 截取）；**后 22B** = re-track 体（A0/A1/Q0/Q1/T0）。  
  **T0（gameTime）**：固定为 **`getCurrentServerTimeWrapper().getTruncatedU32()`**，**不接受** query 覆盖。  
  **逆向（客户端）**：实机要走到 `FUN_1404f1080`，需在 `FUN_140511840` 上以 **`param_2 = 10`** 进入（`switch((int)param_2-1)` 的 decompile `case 9:`）；与 **22B 首字节 A0** 无必然相同 — 见 `dev/ghidra/investigation_state/packet-format-mismatch.md`。  
  查询参数（可选）：`characterId`（缺省或 `test`＝最近测试 NPC）、`q1`、`q0`、`a0`、`a1`。  
  返回：`{ ok, hex, bytes, characterId, lengthBreakdown, gameTime, … }`。

- **POST /api/npcs/ucs-case9-sweep**  
  对接收端连续发 **Q1 = 1<<bit**。**gameTime** 由服务端在 sweep 开始时取 **`getTruncatedU32()`**，可 `incrementGameTime` 逐包递增；**忽略** `gameTimeBase`。  
  Body 示例：`{ "target": "sessionId", "characterId": "test", "bitStart": 0, "bitEnd": 31, "delayMs": 120, "incrementGameTime": true }`  
  仅一个在线客户端时可省略 `target`。

**下一步**：可接 Swagger/OpenAPI，把各 packet 定义为实体/ schema，在网页上按结构填参并调用 `/api/send`。
