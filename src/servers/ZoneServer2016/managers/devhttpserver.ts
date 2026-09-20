// ======================================================================
// 本机 HTTP 服务：静态文件 + 开发用 API（客户端列表、代发包等）
// 仅监听 127.0.0.1，端口由 Zone 构造时传入或 DEV_HTTP_PORT 环境变量
// ======================================================================

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import DataSchema from "h1z1-dataschema";
import { ZoneServer2016 } from "../zoneserver";
import { ZoneClient2016 as Client } from "../classes/zoneclient";
import { writePacketType } from "../../../packets/ClientProtocol/ClientProtocol_1080/shared";
import { getCurrentServerTimeWrapper } from "../../../utils/utils";
import { TestZombieReplay, TestZombieReplayError } from "../test-zombie-replay";
import { TestZombieScenario } from "../test-zombie-scenario";
import { configuredZombieRecorder } from "../test-zombie-recording";
import { ZOMBIE_TEST_SCENES } from "../test-zombie-scenes";
import { spawnTestZombieForClient, getTestZombieTerrainOptions } from "../test-zombie-in-front";
import {
  expandH1emuUpdateCharacterStatePackToClient1080,
  extractUcsCase9Q1AndGameTimeFromH1emuPackedFullBuffer,
  H1EMU_UCS_SCHEMA_TAIL_BYTES
} from "../../../utils/characterUpdateCharacterStateWire2016";

const DEV_TOOLS_DIR = "dev/zone-public";
const ACTIVATE_PROFILE_OPCODE = 0x0f31;

function parseDevUInt64Param(s: string | null): bigint {
  if (s == null || s === "") return 0n;
  const t = s.trim();
  if (/^0x[0-9a-f]+$/i.test(t)) return BigInt(t);
  return BigInt(t);
}

function devDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ActivateProfile (0x0f31) 二进制格式构造器
 *
 * 根据反编译 FUN_1404ec420 确认的字节级格式：
 *   [1B pose]
 *   [4B actionCount]
 *   FOR EACH action: 4 × len-prefixed blob, 5 × uint32, key-set, 1B bool
 *   [4B field48] [4B stateCheck] [4B selector] [4B mode]
 *   [len-prefixed blob ×2] [4B statCount] FOR EACH stat …
 */
function buildActivateProfileBody(opts: {
  pose?: number;
  selector: number;
  mode?: number;
  stateCheck?: number;
  field48?: number;
  actions?: Array<{
    blobs?: Buffer[];
    uint32s?: number[];
    keys?: number[];
    boolFlag?: boolean;
  }>;
  stateBlob1?: Buffer;
  stateBlob2?: Buffer;
  stats?: Array<{ statId: number; kind: number; val1?: number; val2?: number }>;
}): Buffer {
  const parts: Buffer[] = [];

  const w8 = (v: number) => {
    const b = Buffer.alloc(1);
    b.writeUInt8(v);
    parts.push(b);
  };
  const w32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    parts.push(b);
  };
  const wBlob = (data?: Buffer) => {
    const d = data ?? Buffer.alloc(0);
    w32(d.length);
    if (d.length > 0) parts.push(d);
  };

  w8(opts.pose ?? 0);

  const actions = opts.actions ?? [];
  w32(actions.length);
  for (const act of actions) {
    const blobs = act.blobs ?? [];
    for (let i = 0; i < 4; i++) wBlob(blobs[i]);
    const u32s = act.uint32s ?? [0, 0, 0, 0, 0];
    for (let i = 0; i < 5; i++) w32(u32s[i] ?? 0);
    const keys = act.keys ?? [];
    w32(keys.length);
    for (const k of keys) w32(k);
    w8(act.boolFlag ? 1 : 0);
  }

  w32(opts.field48 ?? 0);
  w32(opts.stateCheck ?? 0);
  w32(opts.selector);
  w32(opts.mode ?? 0);

  wBlob(opts.stateBlob1);
  wBlob(opts.stateBlob2);

  const stats = opts.stats ?? [];
  w32(stats.length);
  for (const st of stats) {
    w32(st.statId);
    w8(st.kind);
    if (st.kind === 0 || st.kind === 1) {
      w32(st.val1 ?? 0);
      w32(st.val2 ?? 0);
    }
  }

  return Buffer.concat(parts);
}

const RAW_BUFFER_PACKER = (value: Buffer | Uint8Array | number[] | undefined) =>
  Buffer.isBuffer(value) ? value : Buffer.from(value ?? []);
const RAW_ANIMATION_REQUEST_SCHEMA = {
  fields: [
    { name: "characterId", type: "uint64string", defaultValue: "0" },
    { name: "payload", type: "custom", packer: RAW_BUFFER_PACKER }
  ]
};

export class DevHttpServer {
  private server: http.Server | null = null;
  private port: number;
  private zone: ZoneServer2016;
  private staticRoot: string;
  private readonly testReplay: TestZombieReplay;
  private readonly testScenario: TestZombieScenario;

  constructor(zone: ZoneServer2016, port: number) {
    this.zone = zone;
    this.port = port;
    this.staticRoot = path.join(process.cwd(), DEV_TOOLS_DIR);
    this.testReplay = new TestZombieReplay(zone, spawnTestZombieForClient, getTestZombieTerrainOptions);
    this.testScenario = new TestZombieScenario(zone, this.testReplay, ZOMBIE_TEST_SCENES,
      undefined, undefined, undefined, configuredZombieRecorder());
  }

  handleTestZombieCommand(client: Client, args: string[]): void {
    this.testScenario.handle(client, args);
  }

  observeTestNpcIngress(client: Client, packetData: unknown): void {
    this.testReplay.observeNpcIngress(client, packetData);
  }

  observeTestPlayerMotionIngress(client: Client, packetData: unknown) {
    return this.testReplay.observePlayerMotionIngress(client, packetData);
  }

  observeTestPlayerMotionSend(client: Client, packetName: string, payload: unknown, raw?: Buffer): void {
    this.testReplay.observePlayerMotionSend(client, packetName, payload, raw);
  }

  start(): void {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.server.listen(this.port, "127.0.0.1", () => {
      console.log(
        `[DevHttp] listening on http://127.0.0.1:${this.port} (static: ${this.staticRoot})`
      );
      console.log("[ztest] command suite v2 loaded: /ztest flat | seek | mixed | slope | fence | stop | status (seek: client-seek-only A/B; mixed: production-style dual-input diagnostic; fence: only known obstacle; other collision unknown)");
    });
  }

  stop(): void {
    this.testScenario.dispose();
    this.testReplay.dispose();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private setCors(res: http.ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  private sendJson(
    res: http.ServerResponse,
    status: number,
    body: unknown
  ): void {
    this.setCors(res);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.writeHead(status);
    res.end(JSON.stringify(body));
  }

  private async readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
    let body = "";
    for await (const chunk of req) body += chunk;
    return JSON.parse(body || "{}") as T;
  }

  private resolveTargetClient(target?: string | null): {
    client: Client | null;
    error?: string;
  } {
    const clients = (this.zone as unknown as { _clients: Record<string, Client> })
      ._clients;
    const keys = Object.keys(clients);
    if (target && String(target).trim()) {
      const client = this.findClient(String(target).trim());
      return client
        ? { client }
        : {
            client: null,
            error: "Client not found"
          };
    }
    if (keys.length === 1) {
      return { client: clients[keys[0]] };
    }
    return {
      client: null,
      error: "No client or multiple clients; specify target"
    };
  }

  private findClient(target: string): Client | null {
    const t = String(target).trim();
    if (!t) return null;
    const clients = (this.zone as unknown as { _clients: Record<string, Client> })
      ._clients;
    if (clients[t]) return clients[t];
    for (const key of Object.keys(clients)) {
      const c = clients[key];
      if (
        c.character?.characterId === t ||
        c.character?.name?.toLowerCase() === t.toLowerCase()
      ) {
        return c;
      }
    }
    return null;
  }

  private getLastSpawnedNpcCharacterId(): string | null {
    const zone = this.zone as unknown as { _lastSpawnedNpcCharacterId?: string | null };
    return zone._lastSpawnedNpcCharacterId ?? null;
  }

  private resolveAnimationCharacterId(
    client: Client,
    requested: unknown
  ): string {
    const raw = typeof requested === "string" ? requested.trim() : "";
    if (!raw || raw === "self") {
      return client.character.characterId;
    }
    if (raw === "test") {
      return this.getLastSpawnedNpcCharacterId() ?? "0";
    }
    return String(requested);
  }

  private async handleApiClients(res: http.ServerResponse): Promise<void> {
    const clients = (this.zone as unknown as { _clients: Record<string, Client> })
      ._clients;
    const list = Object.keys(clients).map((sessionId) => {
      const c = clients[sessionId];
      return {
        sessionId: String(sessionId),
        soeClientId: c.soeClientId,
        characterId: c.character?.characterId ?? "",
        name: c.character?.name ?? ""
      };
    });
    this.sendJson(res, 200, { clients: list });
  }

  private handleApiNpcClockStatus(res: http.ServerResponse): void {
    const now = Date.now();
    const copyPoseVector = (value: Float32Array | undefined, lengths: number[]) => {
      if (!value || !lengths.includes(value.length)) return null;
      const copy = Array.from(value);
      return copy.every(Number.isFinite) ? copy : null;
    };
    const clients = Object.values(this.zone._clients).map((client) => ({
      characterId: client.character?.characterId ?? null,
      // Read-time server state only: neither an inbound packet timestamp nor a
      // native transform measurement. Never reuse the replay's prepare snapshot.
      poseSource: "server_character_state_not_native_measurement",
      serverPosition: copyPoseVector(client.character?.state?.position, [3, 4]),
      serverRotation: copyPoseVector(client.character?.state?.rotation, [4]),
      testZombieSpawned: client.testZombieSpawned,
      isLoading: client.isLoading,
      isSynced: client.isSynced,
      isAlive: client.character?.isAlive ?? null,
      isRespawning: client.character?.isRespawning ?? null,
      acceptedClockAgeMs: client.testZombieClockReadyAt === undefined
        ? null : now - client.testZombieClockReadyAt,
      samples: client.testZombieClockDiagnostics ?? null,
      movementVersion: client.testZombieMovementVersion ?? null,
      stance: client.testZombieStance ?? null,
      baselineRefresh: client.testZombieClockResync ?? null,
      synchronization: client.testZombieSynchronization ?? null
    }));
    this.sendJson(res, 200, { observedAt: now, clients });
  }

  /** 仅返回测试命令刷出的僵尸 ID，不拉全量 NPC 列表 */
  private async handleApiNpcsLastTest(res: http.ServerResponse): Promise<void> {
    const zone = this.zone as unknown as { _lastSpawnedNpcCharacterId?: string | null };
    const characterId = zone._lastSpawnedNpcCharacterId ?? null;
    const npc = characterId ? this.zone._npcs[characterId] : undefined;
    this.sendJson(res, 200, {
      lastSpawnedCharacterId: characterId,
      transientId: npc?.transientId ?? null,
      // Diagnostic server state, not a measurement of the client's transform.
      serverPosition: npc ? Array.from(npc.state.position) : null,
      serverRotation: npc ? Array.from(npc.state.rotation) : null
    });
  }

  /** 返回 UpdateCharacterState（最近测试 NPC）的原生 22B raw hex（用于测试 set-state） */
  private handleApiNpcsSetStateRawHex(res: http.ServerResponse): void {
    console.log("[DevApi] set-state-raw-hex 请求已收到");
    const zone = this.zone as unknown as {
      _lastSpawnedNpcCharacterId?: string | null;
      _protocol?: {
        pack: (
          name: string,
          obj: unknown,
          opt?: { h1emuUcsSchemaPackOnly?: boolean }
        ) => Buffer | null;
      };
    };
    const characterId = zone._lastSpawnedNpcCharacterId ?? "0";
    if (!characterId || characterId === "0") {
      this.sendJson(res, 400, { error: "无测试僵尸，请先用 spawnzombie 等命令刷一只" });
      return;
    }
    if (!zone._protocol) {
      this.sendJson(res, 500, { error: "服务端 protocol 未就绪" });
      return;
    }
    try {
      const data = zone._protocol.pack(
        "Character.UpdateCharacterState",
        {
          characterId,
          states1: { visible: 1 },
          states2: {},
          states3: {},
          states4: {},
          states5: {},
          states6: { hidesHeat: true },
          states7: {}
        },
        { h1emuUcsSchemaPackOnly: true }
      );
      if (data && Buffer.isBuffer(data)) {
        const extracted = extractUcsCase9Q1AndGameTimeFromH1emuPackedFullBuffer(data);
        const wire22 = expandH1emuUpdateCharacterStatePackToClient1080(data);
        this.sendJson(res, 200, {
          hex: data.toString("hex"),
          bytes: data.length,
          hexWire22: wire22?.toString("hex") ?? null,
          bytesWire22: wire22?.length ?? null,
          characterId,
          schemaTailBytesAfterCharId: H1EMU_UCS_SCHEMA_TAIL_BYTES,
          note:
            "hex 即客户端 case9 解析器收到的完整 22B（opcode + characterId + states + gameTime）。",
          case9Bridge:
            extracted != null && wire22 != null
              ? {
                  hex22: wire22.toString("hex"),
                  bytes: wire22.length,
                  q1: extracted.q1.toString(),
                  q1Hex16: extracted.q1.toString(16),
                  gameTime: extracted.gameTime,
                  states6ByteAtOffset15: data.length > 15 ? data.readUInt8(15) : null
                }
              : null
        });
      } else {
        this.sendJson(res, 500, { error: "pack 返回空，请查看服务端控制台日志" });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[DevApi] set-state-raw-hex pack error:", msg);
      this.sendJson(res, 500, { error: "pack 异常: " + msg });
    }
  }

  /** 返回 Chat.ChatText 验证消息的 raw hex（用于测试 raw 转发） */
  private handleApiChatTextRawHex(res: http.ServerResponse): void {
    const msg = "[Dev] 若你看到此句说明客户端在收包并处理";
    const zone = this.zone as { _protocol?: { pack: (name: string, obj: unknown) => Buffer | null } };
    const data = zone._protocol?.pack("Chat.ChatText", {
      message: msg,
      unknownDword1: 0,
      color: [255, 255, 255, 0],
      unknownDword2: 13951728,
      unknownBoolean1: false,
      unknownBoolean2: true
    });
    if (data) {
      this.sendJson(res, 200, { hex: data.toString("hex"), bytes: data.length, message: msg });
    } else {
      this.sendJson(res, 500, { error: "pack failed" });
    }
  }

  /**
   * 解析 UCS 目标 characterId：空 / test → 最近测试 NPC；self → 需传入 client。
   */
  private resolveUcsCharacterIdString(
    client: Client | null,
    requested: string | null | undefined
  ): { characterId: string | null; error?: string } {
    const r = (requested != null ? String(requested) : "").trim();
    if (!r || r === "test") {
      const id = this.getLastSpawnedNpcCharacterId();
      if (!id || id === "0") {
        return {
          characterId: null,
          error:
            "无测试僵尸：请先 spawnzombie，或在查询参数 characterId 中填具体 NPC 的 characterId"
        };
      }
      return { characterId: id };
    }
    if (r === "self") {
      if (!client) {
        return {
          characterId: null,
          error: "characterId=self 需要 POST 且能解析 target 客户端，或改用具体数字 ID"
        };
      }
      return { characterId: client.character.characterId };
    }
    return { characterId: r };
  }

  /**
   * h1z1-dataschema 的 uint64string 按 0x + 16 位十六进制编码；与 sendData 一致须先规范化。
   */
  private normalizeCharacterIdForPack(characterId: string): string {
    const t = String(characterId).trim();
    if (t.startsWith("0x") || t.startsWith("0X")) {
      const hex = t.slice(2).toLowerCase().replace(/[^0-9a-f]/g, "");
      const tail = hex.length > 16 ? hex.slice(-16) : hex.padStart(16, "0");
      return "0x" + tail;
    }
    try {
      return "0x" + BigInt(t).toString(16).padStart(16, "0").slice(-16);
    } catch {
      return "0x0000000000000000";
    }
  }

  /** 生成原生 case9 完整 22B 包；字段覆盖 schema 尾中的 Q1/gameTime。 */
  private packUcsCase9FullPacket(
    characterId: string,
    fields: {
      q1?: bigint;
      gameTime?: number;
    }
  ): Buffer | null {
    const zone = this.zone as unknown as {
      _protocol?: {
        pack: (
          n: string,
          o: unknown,
          opt?: { h1emuUcsSchemaPackOnly?: boolean }
        ) => Buffer | null;
      };
    };
    if (!zone._protocol) return null;
    const cidHex = this.normalizeCharacterIdForPack(characterId);
    const packed = zone._protocol.pack(
      "Character.UpdateCharacterState",
      {
        characterId: cidHex,
        states1: {},
        states2: {},
        states3: {},
        states4: {},
        states5: {},
        states6: {},
        states7: {},
        placeholder: 0,
        gameTime: 0
      },
      { h1emuUcsSchemaPackOnly: true }
    );
    if (!packed || packed.length !== 22) {
      console.error("[DevUcs] pack head failed", {
        characterId: cidHex,
        gotLen: packed?.length
      });
      return null;
    }
    const full22 = Buffer.from(packed);
    full22.writeBigUInt64LE(fields.q1 ?? 0n, 10);
    full22.writeUInt32LE((fields.gameTime ?? 1) >>> 0, 18);
    return expandH1emuUpdateCharacterStatePackToClient1080(full22);
  }

  /** H1EMU DataSchema 生成客户端 `FUN_1404f1080` 直接消费的完整 22B。 */
  private packUcsCase9FullPacketFromH1emuSchema(
    characterId: string,
    ucs: Record<string, unknown>
  ): Buffer | null {
    const zone = this.zone as unknown as {
      _protocol?: {
        pack: (
          n: string,
          o: unknown,
          opt?: { h1emuUcsSchemaPackOnly?: boolean }
        ) => Buffer | null;
      };
    };
    if (!zone._protocol) return null;
    const cidHex = this.normalizeCharacterIdForPack(characterId);
    const packed = zone._protocol.pack(
      "Character.UpdateCharacterState",
      {
        ...ucs,
        characterId: cidHex
      },
      { h1emuUcsSchemaPackOnly: true }
    );
    if (!packed || packed.length < 10 + H1EMU_UCS_SCHEMA_TAIL_BYTES) {
      console.error("[DevUcs] packFromH1emu: pack missing or short", {
        characterId: cidHex,
        len: packed?.length
      });
      return null;
    }
    return expandH1emuUpdateCharacterStatePackToClient1080(packed);
  }

  /** GET：按 H1EMU states 语义生成完整 22B case9 包。 */
  private handleApiUcsCase9FromH1emuGet(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const host = req.headers.host ?? "127.0.0.1";
    let sp: URLSearchParams;
    try {
      sp = new URL(req.url ?? "/", `http://${host}`).searchParams;
    } catch {
      this.sendJson(res, 400, { error: "Invalid URL" });
      return;
    }
    const { characterId, error } = this.resolveUcsCharacterIdString(
      null,
      sp.get("characterId")
    );
    if (!characterId) {
      this.sendJson(res, 400, { error: error ?? "characterId 无效" });
      return;
    }
    const truthy = (v: string | null): boolean =>
      v === "1" || v?.toLowerCase() === "true" || v === "yes";
    const states1: Record<string, boolean> = {};
    if (truthy(sp.get("visible"))) states1.visible = true;
    if (truthy(sp.get("knockedOut"))) states1.knockedOut = true;
    const states6: Record<string, boolean> = {};
    if (truthy(sp.get("hidesHeat"))) states6.hidesHeat = true;
    if (truthy(sp.get("nearDeath"))) states6.nearDeath = true;
    const placeholder = Number.parseInt(sp.get("placeholder") ?? "0", 10);
    const gameTimeRaw = sp.get("gameTime");
    const gameTime =
      gameTimeRaw != null && gameTimeRaw !== ""
        ? Number.parseInt(gameTimeRaw, 10)
        : getCurrentServerTimeWrapper().getTruncatedU32();
    const ucs: Record<string, unknown> = {
      states1: Object.keys(states1).length ? states1 : { visible: true },
      states2: {},
      states3: {},
      states4: {},
      states5: {},
      states6: Object.keys(states6).length ? states6 : {},
      states7: {},
      placeholder: Number.isFinite(placeholder) ? placeholder : 0,
      gameTime: Number.isFinite(gameTime) ? gameTime >>> 0 : 1
    };
    const zone = this.zone as unknown as {
      _protocol?: {
        pack: (
          n: string,
          o: unknown,
          opt?: { h1emuUcsSchemaPackOnly?: boolean }
        ) => Buffer | null;
      };
    };
    const schemaOnly = zone._protocol?.pack(
      "Character.UpdateCharacterState",
      {
        characterId: this.normalizeCharacterIdForPack(characterId),
        ...ucs
      },
      { h1emuUcsSchemaPackOnly: true }
    );
    const full22 = this.packUcsCase9FullPacketFromH1emuSchema(characterId, ucs);
    if (!full22 || !schemaOnly) {
      this.sendJson(res, 500, { error: "pack / case9 校验失败" });
      return;
    }
    const ext = extractUcsCase9Q1AndGameTimeFromH1emuPackedFullBuffer(schemaOnly);
    this.sendJson(res, 200, {
      ok: true,
      hex22: full22.toString("hex"),
      bytes22: full22.length,
      schemaPackHex: schemaOnly.toString("hex"),
      schemaPackBytes: schemaOnly.length,
      characterId,
      bridge: ext
        ? {
            q1: ext.q1.toString(),
            q1Hex: ext.q1.toString(16),
            gameTime: ext.gameTime,
            states6ByteOffsetFromPack0: schemaOnly.length > 15 ? schemaOnly.readUInt8(15) : null
          }
        : null,
      ucsQueryEcho: ucs,
      note:
        "states6.byte（完整包偏移 15）在 hidesHeat 时应为 0x04；nearDeath 为 0x08；可 POST /api/send-raw 发送 hex22 实机验证。"
    });
  }

  /** GET：生成 UpdateCharacterState case9 22B 全包 hex，供「发送 raw」手动测 */
  private handleApiUcsCase9RawHexGet(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const host = req.headers.host ?? "127.0.0.1";
    let sp: URLSearchParams;
    try {
      sp = new URL(req.url ?? "/", `http://${host}`).searchParams;
    } catch {
      this.sendJson(res, 400, { error: "Invalid URL" });
      return;
    }
    const { characterId, error } = this.resolveUcsCharacterIdString(
      null,
      sp.get("characterId")
    );
    if (!characterId) {
      this.sendJson(res, 400, { error: error ?? "characterId 无效" });
      return;
    }
    let q1: bigint;
    try {
      q1 = parseDevUInt64Param(sp.get("q1") ?? "1");
    } catch {
      this.sendJson(res, 400, { error: "q1 解析失败（用十进制或 0x 十六进制）" });
      return;
    }
    const gameTime = getCurrentServerTimeWrapper().getTruncatedU32();
    const buf = this.packUcsCase9FullPacket(characterId, {
      q1,
      gameTime
    });
    if (!buf) {
      this.sendJson(res, 500, {
        error: "无法 pack characterId 包头（检查 protocol / characterId 格式）"
      });
      return;
    }
    this.sendJson(res, 200, {
      ok: true,
      hex: buf.toString("hex"),
      bytes: buf.length,
      characterId,
      characterIdPackedHex: this.normalizeCharacterIdForPack(characterId),
      lengthBreakdown: {
        opcode: 2,
        characterIdWire: 8,
        states: 8,
        gameTime: 4,
        total: 22
      },
      q1: q1.toString(),
      gameTime,
      note:
        "22B 与 sendData 相同：2B opcode + 8B characterId + 12B states/gameTime。"
    });
  }

  /** POST：对 target 客户端连续发送 Q1=1<<bit 的包，用于扫位 */
  private async handleApiUcsCase9Sweep(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    try {
      let body: {
        target?: string;
        characterId?: string;
        bitStart?: number;
        bitEnd?: number;
        delayMs?: number;
        gameTimeBase?: number;
        incrementGameTime?: boolean;
      };
      try {
        body = await this.readJsonBody(req);
      } catch {
        this.sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
        return;
      }
      const { client, error } = this.resolveTargetClient(body.target);
      if (!client) {
        this.sendJson(res, 404, { ok: false, error });
        return;
      }
      const { characterId, error: cidErr } = this.resolveUcsCharacterIdString(
        client,
        body.characterId
      );
      if (!characterId) {
        this.sendJson(res, 400, { ok: false, error: cidErr ?? "characterId 无效" });
        return;
      }
      const bitStart = Math.max(0, Math.min(63, Number(body.bitStart ?? 0)));
      const bitEnd = Math.max(0, Math.min(63, Number(body.bitEnd ?? 31)));
      const lo = Math.min(bitStart, bitEnd);
      const hi = Math.max(bitStart, bitEnd);
      const delayMs = Math.max(0, Math.min(5000, Number(body.delayMs ?? 120)));
      const incrementGameTime = Boolean(body.incrementGameTime);
      let gameTimeBase = getCurrentServerTimeWrapper().getTruncatedU32();

      const sent: Array<{ bit: number; hex: string }> = [];
      for (let b = lo; b <= hi; b++) {
        const q1 = 1n << BigInt(b);
        const gt = incrementGameTime ? (gameTimeBase + (b - lo)) >>> 0 : gameTimeBase >>> 0;
        const packet = this.packUcsCase9FullPacket(characterId, {
          q1,
          gameTime: gt
        });
        if (!packet) {
          this.sendJson(res, 500, {
            ok: false,
            error: "packUcsCase9FullPacket 失败（characterId / protocol）"
          });
          return;
        }
        this.zone.sendRawDataReliable(client, packet);
        sent.push({ bit: b, hex: packet.toString("hex") });
        console.log(
          `[DevUcsSweep] bit=${b} q1=${q1.toString()} gameTime=${gt} → ${characterId} (${packet.length}B)`
        );
        if (b < hi && delayMs > 0) await devDelay(delayMs);
      }
      this.sendJson(res, 200, {
        ok: true,
        characterId,
        range: { from: lo, to: hi },
        count: sent.length,
        delayMs,
        lastHex: sent.length ? sent[sent.length - 1].hex : ""
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[DevApi] ucs-case9-sweep:", e);
      if (!res.headersSent) {
        this.sendJson(res, 500, { ok: false, error: msg });
      }
    }
  }

  /** 发送原始十六进制包（绕过协议序列化） */
  private async handleApiSendRaw(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    let body: { target?: string; rawHex?: string };
    try {
      body = await this.readJsonBody(req);
    } catch {
      this.sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
      return;
    }
    const { client, error } = this.resolveTargetClient(body.target);
    if (!client) {
      this.sendJson(res, 404, { ok: false, error });
      return;
    }
    const hex = typeof body.rawHex === "string" ? body.rawHex.replace(/\s/g, "") : "";
    if (!hex || !/^[0-9a-fA-F]+$/.test(hex)) {
      this.sendJson(res, 400, { ok: false, error: "rawHex 必须为非空十六进制字符串" });
      return;
    }
    const buf = Buffer.from(hex, "hex");
    this.zone.sendRawDataReliable(client, buf);
    console.log(`[DevSendRaw] ${buf.length}B hex=${hex.slice(0, 64)}${hex.length > 64 ? "..." : ""}`);
    this.sendJson(res, 200, { ok: true, bytes: buf.length });
  }

  private async handleApiSend(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    let payload: { target?: string; packet?: string; data?: Record<string, unknown>; positionChannel?: boolean };
    try {
      payload = await this.readJsonBody(req);
    } catch {
      this.sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
      return;
    }
    const { target, packet, data } = payload;
    if (!packet) {
      this.sendJson(res, 400, {
        ok: false,
        error: "Missing packet"
      });
      return;
    }
    const { client, error } = this.resolveTargetClient(target);
    if (!client) {
      this.sendJson(res, 404, {
        ok: false,
        error
      });
      return;
    }
    const packetName = String(packet);
    if (payload.positionChannel && packetName !== "PlayerUpdatePosition") {
      this.sendJson(res, 400, { ok: false, error: "positionChannel requires PlayerUpdatePosition" });
      return;
    }
    let dataObj: Record<string, unknown> =
      data && typeof data === "object" ? { ...data } : {};
    if (packetName === "Chat.ChatText") {
      dataObj = {
        message: dataObj.message ?? "",
        unknownDword1: dataObj.unknownDword1 ?? 0,
        color: Array.isArray(dataObj.color) ? dataObj.color : [255, 255, 255, 0],
        unknownDword2: dataObj.unknownDword2 ?? 13951728,
        unknownBoolean1: dataObj.unknownBoolean1 ?? false,
        unknownBoolean2: dataObj.unknownBoolean2 ?? true
      };
      console.log(`[DevSend] Chat.ChatText → message="${String(dataObj.message).slice(0, 60)}..."`);
    } else if (packetName === "ClientUpdate.TextAlert") {
      dataObj = {
        message: dataObj.message ?? "[Dev] 若你看到此句说明客户端在收包并处理"
      };
      console.log(`[DevSend] ClientUpdate.TextAlert → message="${String(dataObj.message).slice(0, 60)}..."`);
    } else if (packetName === "Character.PlayAnimation") {
      let characterId = dataObj.characterId ?? "0";
      if (
        characterId === "self" ||
        (typeof characterId === "string" && characterId.trim() === "")
      ) {
        characterId = client.character.characterId;
      }
      dataObj = {
        characterId,
        animationName: dataObj.animationName ?? "IdleAnim",
        unm4: dataObj.unm4 ?? 0,
        unknownDword1: dataObj.unknownDword1 ?? 1430,
        unknownByte1: dataObj.unknownByte1 ?? 0,
        unknownDword2: dataObj.unknownDword2 ?? 1430,
        animationType: dataObj.animationType ?? "",
        unknownByte1xda: dataObj.unknownByte1xda ?? 0,
        unknownDword3: dataObj.unknownDword3 ?? 1430
      };
      console.log(
        `[DevSend] Character.PlayAnimation → characterId=${characterId} animationName=${dataObj.animationName} animationType=${dataObj.animationType}`
      );
    } else if (packetName === "Character.MemberStatus") {
      let memberCharacterId = dataObj.characterId ?? "0";
      if (
        memberCharacterId === "self" ||
        (typeof memberCharacterId === "string" && memberCharacterId.trim() === "")
      ) {
        memberCharacterId = client.character.characterId;
      }
      dataObj = {
        characterId: memberCharacterId,
        unknownByte1: dataObj.unknownByte1 ?? 0
      };
    } else if (packetName === "Character.ManagedObject") {
      let objectCharacterId = dataObj.objectCharacterId ?? "0";
      let managerCharacterId = dataObj.characterId ?? "self";
      if (objectCharacterId === "test") {
        const zone = this.zone as unknown as { _lastSpawnedNpcCharacterId?: string | null };
        objectCharacterId = zone._lastSpawnedNpcCharacterId ?? "0";
      }
      if (
        managerCharacterId === "self" ||
        (typeof managerCharacterId === "string" && managerCharacterId.trim() === "")
      ) {
        managerCharacterId = client.character.characterId;
      }
      dataObj = {
        objectCharacterId,
        characterId: managerCharacterId
      };
      try {
        this.zone.sendData(client, "ClientUpdate.ManagedObjectResponseControl" as never, {
          control: true,
          objectCharacterId
        } as never);
      } catch { /* ignore */ }
      console.log(
        `[DevSend] Character.ManagedObject + ResponseControl → objectCharacterId=${objectCharacterId} managerCharacterId=${managerCharacterId}`
      );
    }
    try {
      // sendData silently drops a failed pack. A diagnostic must not report
      // success unless an actual buffer was handed to the reliable tunnel.
      const packed = this.zone._protocol.pack(packetName as never, dataObj);
      if (!packed) {
        this.sendJson(res, 400, { ok: false, error: `Could not pack ${packetName}` });
        return;
      }
      if (payload.positionChannel) {
        // FUN_14063de90 channel2 consumes transient id + movement data without opcode79.
        const movementData = packed.subarray(1);
        this.zone.sendRawDataReliable(client, movementData, 2);
        this.sendJson(res, 200, { ok: true, bytes: movementData.length, gatewayChannel: 2 });
      } else {
        this.zone.sendRawDataReliable(client, packed);
        this.sendJson(res, 200, { ok: true, bytes: packed.length });
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      this.sendJson(res, 500, { ok: false, error: err });
    }
  }

  /**
   * 诊断：发送 Character.ActivateProfile (0x0f31) 原始二进制包
   *
   * POST body JSON:
   *   target?        — 客户端 sessionId（省略则用唯一客户端）
   *   characterId?   — "test" | "self" | 具体 hex string（默认 "test"，即上次刷出的 NPC）
   *   selector       — uint32 哈希表 key（必须，用于确定哪个 ActionDispatcher）
   *   pose?          — uint8（默认 0）
   *   mode?          — uint32（默认 0）
   *   stateCheck?    — uint32（默认 0）
   *   field48?       — uint32（默认 0）
   *   actions?       — 动作条目数组（默认空数组）
   *     每项: { blobs?: hex[], uint32s?: number[], keys?: number[], boolFlag?: bool }
   *   sweep?         — { from: number, to: number }  批量扫描 selector 值（例如 1~49）
   *   sweepDelay?    — 扫描间隔 ms（默认 200）
   */
  private async handleApiActivateProfile(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await this.readJsonBody(req);
    } catch {
      this.sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
      return;
    }

    const { client, error } = this.resolveTargetClient(
      (body.target as string) ?? null
    );
    if (!client) {
      this.sendJson(res, 404, { ok: false, error });
      return;
    }

    const characterId = this.resolveAnimationCharacterId(
      client,
      body.characterId ?? "test"
    );
    if (!characterId || characterId === "0") {
      this.sendJson(res, 400, {
        ok: false,
        error: "无法解析 characterId（请先刷出测试 NPC）"
      });
      return;
    }

    const sweep = body.sweep as { from: number; to: number } | undefined;
    if (sweep && typeof sweep.from === "number" && typeof sweep.to === "number") {
      const sweepDelay = Number(body.sweepDelay) || 200;
      const results: Array<{ selector: number; hex: string }> = [];
      for (let sel = sweep.from; sel <= sweep.to; sel++) {
        const recordBody = buildActivateProfileBody({
          pose: Number(body.pose) || 0,
          selector: sel,
          mode: Number(body.mode) || 0,
          stateCheck: Number(body.stateCheck) || 0,
          field48: Number(body.field48) || 0
        });
        const packetBody = DataSchema.pack(RAW_ANIMATION_REQUEST_SCHEMA.fields, {
          characterId,
          payload: recordBody
        }).data;
        const packet = Buffer.concat([
          writePacketType(ACTIVATE_PROFILE_OPCODE),
          packetBody
        ]);
        this.zone.sendRawDataReliable(client, packet);
        results.push({ selector: sel, hex: packet.toString("hex") });
        console.log(
          `[ActivateProfile/sweep] selector=${sel} → ${characterId} (${packet.length}B)`
        );
        if (sel < sweep.to) {
          await new Promise((r) => setTimeout(r, sweepDelay));
        }
      }
      this.sendJson(res, 200, { ok: true, characterId, sweep: results });
      return;
    }

    const selector = Number(body.selector);
    if (!Number.isFinite(selector)) {
      this.sendJson(res, 400, {
        ok: false,
        error: "缺少 selector（uint32）参数"
      });
      return;
    }

    const actionInputs = Array.isArray(body.actions)
      ? (body.actions as Array<Record<string, unknown>>)
      : [];
    const actions = actionInputs.map((a) => ({
      blobs: Array.isArray(a.blobs)
        ? (a.blobs as string[]).map((h) =>
            Buffer.from(String(h).replace(/0x/gi, ""), "hex")
          )
        : undefined,
      uint32s: Array.isArray(a.uint32s) ? (a.uint32s as number[]) : undefined,
      keys: Array.isArray(a.keys) ? (a.keys as number[]) : undefined,
      boolFlag: !!a.boolFlag
    }));

    const recordBody = buildActivateProfileBody({
      pose: Number(body.pose) || 0,
      selector,
      mode: Number(body.mode) || 0,
      stateCheck: Number(body.stateCheck) || 0,
      field48: Number(body.field48) || 0,
      actions
    });

    const packetBody = DataSchema.pack(RAW_ANIMATION_REQUEST_SCHEMA.fields, {
      characterId,
      payload: recordBody
    }).data;
    const packet = Buffer.concat([
      writePacketType(ACTIVATE_PROFILE_OPCODE),
      packetBody
    ]);

    this.zone.sendRawDataReliable(client, packet);

    console.log(
      `[ActivateProfile] selector=${selector} → ${characterId} (${packet.length}B) hex=${packet.toString("hex")}`
    );

    this.sendJson(res, 200, {
      ok: true,
      opcode: `0x${ACTIVATE_PROFILE_OPCODE.toString(16)}`,
      characterId,
      selector,
      packetLength: packet.length,
      packetHex: packet.toString("hex"),
      recordBodyHex: recordBody.toString("hex")
    });
  }

  /**
   * POST JSON：对 NPC 走 Zone 正常 pack + sendDataToAllWithSpawnedEntity（22B UCS）。
   * body.characterId 可省略或 "test" → 使用最近测试僵尸；body.states 可省略 → 默认 visible+inCombat+hidesHeat；
   * preset:"minimal" 且未传 states → 仅 visible。
   * body.characterId === "self" → 对解析到的客户端单播同名包（玩家 characterId），wire 与 NPC 版一致；
   * 多连接时需 body.target（与其它 Dev API 相同）。
   */
  private async handleApiNpcsSendUpdateCharacterState(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    let body: {
      characterId?: string;
      states?: Record<string, unknown>;
      preset?: string;
      target?: string;
    } = {};
    try {
      body = await this.readJsonBody(req);
    } catch {
      // 允许空 body
    }
    const cidRaw =
      typeof body.characterId === "string" ? body.characterId.trim() : "";
    if (cidRaw.toLowerCase() === "self") {
      const { client, error } = this.resolveTargetClient(
        typeof body.target === "string" ? body.target : null
      );
      if (!client) {
        this.sendJson(res, 404, { ok: false, error });
        return;
      }
      const preset = typeof body.preset === "string" ? body.preset.trim() : "";
      let states: Record<string, unknown>;
      if (body.states != null && typeof body.states === "object") {
        states = body.states;
      } else if (preset === "minimal") {
        states = { visible: true };
      } else {
        states = { visible: true, inCombat: true, hidesHeat: true };
      }
      this.zone.sendDevPlayerUpdateCharacterStateReliable(client, states);
      this.sendJson(res, 200, {
        ok: true,
        characterId: client.character.characterId,
        mode: "self-sendData",
        preset:
          body.states != null && typeof body.states === "object"
            ? "custom"
            : preset === "minimal"
              ? "minimal"
              : "default-chase",
        note:
          "经 sendData 单播至 target 客户端；characterId 为该客户端角色，与僵尸广播路径对照用。"
      });
      return;
    }
    let cid = cidRaw;
    if (cid === "test" || cid === "") {
      const last = this.getLastSpawnedNpcCharacterId();
      if (!last) {
        this.sendJson(res, 400, {
          ok: false,
          error:
            cid === "test"
              ? "characterId=test 但当前无最近测试僵尸 ID"
              : "请刷测试僵尸或在 JSON 中传 characterId"
        });
        return;
      }
      cid = last;
    }
    const preset = typeof body.preset === "string" ? body.preset.trim() : "";
    let states: Record<string, unknown>;
    if (body.states != null && typeof body.states === "object") {
      states = body.states;
    } else if (preset === "minimal") {
      states = { visible: true };
    } else {
      states = { visible: true, inCombat: true, hidesHeat: true };
    }
    const ok = this.zone.sendNpcUpdateCharacterStateBroadcast(cid, states);
    if (!ok) {
      this.sendJson(res, 404, {
        ok: false,
        error: `Zone._npcs 中不存在 characterId=${cid}`
      });
      return;
    }
    this.sendJson(res, 200, {
      ok: true,
      characterId: cid,
      preset:
        body.states != null && typeof body.states === "object"
          ? "custom"
          : preset === "minimal"
            ? "minimal"
            : "default-chase",
      note:
        "经 sendDataToAllWithSpawnedEntity(_npcs)：仅 spawnedEntities 含该 Npc 引用的客户端会收到；测试僵尸已对刷怪客户端 add。多玩家时其他客户端若未持有同引用则收不到。"
    });
  }

  private async handleApiTestReplay(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const host = req.headers.host;
    const origin = req.headers.origin;
    // This state-changing experiment is not part of the permissive raw-packet API.
    // Exact loopback Host/Origin checks also exclude DNS-rebinding browser calls.
    if ((host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) ||
        (origin !== undefined && origin !== `http://${host}`)) {
      reply(403, { error: "local_same_origin_required" });
      return;
    }
    if (req.url !== "/api/npcs/test-replay") {
      reply(400, { error: "query_parameters_not_supported" });
      return;
    }
    if (req.method === "GET") {
      reply(200, { ...this.testReplay.getStatus(),
        slashScenario: { version: 2, scenes: Object.keys(ZOMBIE_TEST_SCENES), status: this.testScenario.status() } });
      return;
    }
    if (req.method !== "POST") { reply(405, { error: "get_or_post_required" }); return; }
    if (this.testScenario.isActive()) {
      req.resume();
      reply(409, { error: "slash_scenario_active_use_ztest_stop" });
      return;
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "") || req.headers["content-encoding"]) {
      reply(415, { error: "uncompressed_json_required" });
      return;
    }
    try {
      const body = await new Promise<unknown>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const done = (error?: Error, value?: unknown) => {
          clearTimeout(timer);
          req.off("data", data); req.off("end", end); req.off("error", failed); req.off("aborted", aborted);
          if (error) { req.resume(); reject(error); } else resolve(value);
        };
        const data = (chunk: Buffer) => {
          size += chunk.length;
          if (size > 4096) { done(new TestZombieReplayError(413, "body_too_large")); return; }
          chunks.push(chunk);
        };
        const end = () => {
          try { done(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { done(new TestZombieReplayError(400, "invalid_json")); }
        };
        const failed = () => done(new TestZombieReplayError(400, "body_read_failed"));
        const aborted = () => done(new TestZombieReplayError(400, "body_aborted"));
        const timer = setTimeout(() => done(new TestZombieReplayError(408, "body_timeout")), 5000);
        req.on("data", data); req.once("end", end); req.once("error", failed); req.once("aborted", aborted);
      });
      // A slash scenario may acquire ownership while the body is still arriving.
      if (this.testScenario.isActive()) {
        reply(409, { error: "slash_scenario_active_use_ztest_stop" });
        return;
      }
      reply(200, this.testReplay.handle(body));
    } catch (error) {
      reply(error instanceof TestZombieReplayError ? error.status : 500,
        { error: error instanceof TestZombieReplayError ? error.message : "replay_failed" });
    }
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    if ((req.url ?? "").split("?")[0] === "/api/npcs/test-replay") {
      await this.handleApiTestReplay(req, res);
      return;
    }
    if (req.method === "OPTIONS") {
      this.setCors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? "/";
    const pathname = url.split("?")[0];

    if (pathname === "/api/clients") {
      await this.handleApiClients(res);
      return;
    }
    if (pathname === "/api/npcs/last-test") {
      await this.handleApiNpcsLastTest(res);
      return;
    }
    if (pathname === "/api/npcs/clock-status" && req.method === "GET") {
      this.handleApiNpcClockStatus(res);
      return;
    }
    if (pathname === "/api/npcs/set-state-raw-hex") {
      try {
        this.handleApiNpcsSetStateRawHex(res);
      } catch (e) {
        console.error("[DevApi] set-state-raw-hex unhandled:", e);
        this.sendJson(res, 500, { error: "内部异常: " + (e instanceof Error ? e.message : String(e)) });
      }
      return;
    }
    if (pathname === "/api/npcs/ucs-case9-from-h1emu" && req.method === "GET") {
      this.handleApiUcsCase9FromH1emuGet(req, res);
      return;
    }
    if (pathname === "/api/npcs/ucs-case9-raw-hex" && req.method === "GET") {
      this.handleApiUcsCase9RawHexGet(req, res);
      return;
    }
    if (pathname === "/api/npcs/ucs-case9-sweep" && req.method === "POST") {
      void this.handleApiUcsCase9Sweep(req, res);
      return;
    }
    if (pathname === "/api/chat-text-raw-hex") {
      this.handleApiChatTextRawHex(res);
      return;
    }
    if (pathname === "/api/send" && req.method === "POST") {
      await this.handleApiSend(req, res);
      return;
    }
    if (pathname === "/api/send-raw" && req.method === "POST") {
      await this.handleApiSendRaw(req, res);
      return;
    }
    if (pathname === "/api/npcs/activate-profile" && req.method === "POST") {
      await this.handleApiActivateProfile(req, res);
      return;
    }
    if (pathname === "/api/npcs/send-update-character-state" && req.method === "POST") {
      await this.handleApiNpcsSendUpdateCharacterState(req, res);
      return;
    }

    let filePath = path.join(this.staticRoot, pathname === "/" ? "index.html" : pathname);
    if (!path.resolve(filePath).startsWith(path.resolve(this.staticRoot))) {
      filePath = path.join(this.staticRoot, "index.html");
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      filePath = path.join(this.staticRoot, "index.html");
    }
    if (!fs.existsSync(filePath)) {
      this.setCors(res);
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".ico": "image/x-icon"
    };
    this.setCors(res);
    res.setHeader("Content-Type", types[ext] ?? "application/octet-stream");
    res.writeHead(200);
    fs.createReadStream(filePath).pipe(res);
  }
}
