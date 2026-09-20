import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import ts from "typescript";
// Source transpilation keeps tests independent of out and does not pull server
// imports into the standalone test compiler's different baseUrl/target.
const replayModule = sourceModule("src/servers/ZoneServer2016/test-zombie-replay.ts", {});
const { TestZombieReplay, parseTestZombieReplayRequest } = replayModule;

// Source-only loading: no out build, sockets, NPC construction, asset decoder or server.
function sourceModule(relative: string, dependencies: Record<string, any>) {
  const filename = path.resolve(relative);
  const result = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    reportDiagnostics: true, fileName: filename
  });
  assert.deepEqual(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error), []);
  const module = { exports: {} };
  vm.runInNewContext(result.outputText, {
    module, exports: module.exports, __dirname: path.dirname(filename),
    require: (name: string) => {
      if (Object.prototype.hasOwnProperty.call(dependencies, name)) return dependencies[name];
      if (name.startsWith("node:")) return require(name);
      if (name.endsWith("ServerProfileDefinitions.json")) return { profiles: [{ ID: 10, profileData: { unknownByte1: 11 } }] };
      throw new Error(`Unexpected source dependency: ${name}`);
    },
    console: { log() {}, error() {} }, process, Buffer, Float32Array,
    get Date() { return Date; },
    get setTimeout() { return setTimeout; }, get clearTimeout() { return clearTimeout; },
    get setInterval() { return setInterval; }, get clearInterval() { return clearInterval; }
  }, { filename });
  return module.exports as any;
}

// Execute the actual NPC request method, while never constructing an NPC or
// importing its server/runtime dependencies. Its callback/owner logic is not a
// test-side copy, and the packet sends below remain inert mocks.
const { Npc: SourceNpc } = sourceModule("src/servers/ZoneServer2016/entities/npc.ts", {
  "./basefullcharacter": { BaseFullCharacter: class {} },
  "../../../utils/utils": {}, "../../../utils/enums": {}, "../models/enums": {},
  "../managers/challengemanager": {}, "./projectileentity": {}, "../entities/lootbag": {}
});

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function setup(t: TestContext, useSourceSpawn = false, monotonicNow?: () => number) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 10000 });
  const events: string[] = [];
  const client: any = {
    sessionId: 1, testZombieSpawned: true, isLoading: false, isInAir: false,
    testZombieStance: 0x400, vehicle: {}, spawnedEntities: new Set(),
    character: {
      characterId: "player", initialized: true, isAlive: true, isRespawning: false, godMode: false,
      state: { position: new Float32Array([0, 10.1, 0, 1]), rotation: new Float32Array([0, 0, 0, 1]) }
    }
  };
  const old: any = { characterId: "old", testFullDataOwner: client, isAlive: true };
  const activeAi = new Set<any>();
  const zone: any = {
    _soloMode: true, _clients: { 1: client }, _npcs: { old }, _lastSpawnedNpcCharacterId: "old",
    _testZombieBySessionId: { 1: "old" }, _testZombieChaseAttackCharacterId: "player",
    aiManager: {
      playerEntities: new Set(),
      addEntity: t.mock.fn((npc: any) => activeAi.add(npc)),
      removeEntity: t.mock.fn((npc: any) => { activeAi.delete(npc); events.push(`remove-ai:${npc.characterId}`); })
    },
    setGodMode: t.mock.fn((c: any, mode: boolean) => { c.character.godMode = mode; events.push(`god:${mode}`); }),
    respawnPlayer: t.mock.fn((c: any, pos: Float32Array, clear: boolean) => {
      assert.equal(clear, false);
      c.character.isAlive = true; c.character.isRespawning = false; c.isLoading = true; c.character.state.position = pos;
    }),
    deleteEntity: t.mock.fn((id: string, dictionary: any) => { events.push(`delete:${id}`); delete dictionary[id]; return true; }),
    removeTestZombie: t.mock.fn(() => {
      const id = zone._lastSpawnedNpcCharacterId;
      if (id) { delete zone._npcs[id]; delete zone._testZombieBySessionId[1]; }
      zone._lastSpawnedNpcCharacterId = null;
    }),
    generateGuid: t.mock.fn(() => "new"), getTransientId: () => 42,
    addLightweightNpc: t.mock.fn(), sendStandardFullNpcInit: t.mock.fn(), sendData: t.mock.fn()
  };
  let complete!: (terrain: any) => void;
  let rejectTerrain!: (error: Error) => void;
  const terrainPending = new Promise((resolve, reject) => { complete = resolve; rejectTerrain = reject; });
  class MockNpc {
    isAlive = true; transientId: number; state: any; characterId: string;
    clearMovementController = t.mock.fn(); sendIdleStance = t.mock.fn(); setFacingToward = t.mock.fn();
    pGetFull() { return { transientId: this.transientId, characterId: this.characterId }; }
    constructor(id: string, transient: number, _model: number, position: Float32Array, rotation: Float32Array) {
      this.characterId = id; this.transientId = transient; this.state = { position, rotation }; zone.aiManager.addEntity(this);
    }
  }
  const loadTerrain = t.mock.fn(() => terrainPending);
  let knownFencePreparation: () => Promise<any> = async () => {
    throw Error("known-fence resource not requested by terrain-only source fixture");
  };
  const helper = sourceModule("src/servers/ZoneServer2016/test-zombie-in-front.ts", {
    "../../utils/utils": { quat2heading: () => 0 }, "./entities/npc": { Npc: MockNpc },
    "./models/enums": { ModelIds: { ZOMBIE_MALE_WALKER: 1 } },
    "./test-zombie-known-fence": { prepareTestZombieKnownFence: () => knownFencePreparation() },
    "../../utils/forgelightTerrainAssets": { loadForgelightTerrainCorridor: loadTerrain },
    "../../utils/forgelightTerrainFollow": { createForgelightTerrainFollowBinding: ({ standingPlayerPosition, spawnXZ }: any) => ({
      npcOriginHeight: standingPlayerPosition[1] - 10,
      spawnPosition: new Float32Array([spawnXZ[0], standingPlayerPosition[1], spawnXZ[1]]),
      testRouteStep: () => ({})
    }) }
  });
  const captured: any[] = [];
  const spawn = t.mock.fn((s: any, c: any, options: any) => {
    captured.push(options);
    if (useSourceSpawn) helper.spawnTestZombieForClient(s, c, options);
  });
  const controller = new TestZombieReplay(zone, spawn, () => ({ assetRoot: "mock", decoderPath: "mock" }), monotonicNow);
  t.after(() => controller.dispose());
  const prepareBody = { action: "prepare", target: "1", requestId: "request1", expectedPlayerCharacterId: "player", expectedNpcCharacterId: "old" };
  const prepare = (extra: object = {}) => controller.handle({ ...prepareBody, ...extra }) as any;
  const status = () => controller.getStatus() as any;
  const control = (action: string, extra: object = {}) => controller.handle({ action, target: "1", replayId: status().replayId, expectedNpcCharacterId: status().npcCharacterId, ...extra }) as any;
  const emitSpawn = (extra: object = {}) => {
    const npc: any = new MockNpc("new", 42, 1, new Float32Array([0, 10.1, captured[0].distance]), new Float32Array([0, 0, 0, 1]));
    Object.assign(npc, extra);
    npc.testFullDataOwner = client;
    delete zone._npcs.old; zone._npcs.new = npc; zone._lastSpawnedNpcCharacterId = "new"; zone._testZombieBySessionId[1] = "new";
    captured[0].lifecycle.onSpawned(npc, () => {});
    return npc;
  };
  const ready = () => { captured[0].lifecycle.onFullData(); captured[0].lifecycle.onPaused(); };
  const sourceSpawn = async (extra: object = {}) => {
    prepare(extra); t.mock.timers.tick(1); complete([]); await flush();
    return zone._npcs.new;
  };
  const requestFull = (npc: any, requestingClient = client) =>
    SourceNpc.prototype.OnFullCharacterDataRequest.call(npc, zone, requestingClient);
  return { client, zone, old, activeAi, events, controller, prepare, prepareBody, status, control, helper,
    captured, emitSpawn, ready, complete, rejectTerrain, sourceSpawn, requestFull, loadTerrain,
    setKnownFencePreparation: (factory: () => Promise<any>) => { knownFencePreparation = factory; } };
}

function ingressSetup(t: TestContext, extra: object = { observeNpcIngress: true }, clock = () => Date.now()) {
  const s = setup(t, false, clock);
  s.zone._transientIds = { 42: "new" };
  s.prepare(extra);
  const npc = s.emitSpawn();
  const packet = (update: object = {}) => ({ transientId: 42, positionUpdate: {
    flags: 8191, sequenceTime: 1234, unknown3_int8: 7, position: [1, 2, 3, 1],
    horizontalSpeed: 2.5, verticalSpeed: 0, ...update
  } });
  const receive = (data: unknown = packet(), client = s.client) => s.controller.observeNpcIngress(client, data);
  return { ...s, npc, packet, receive, ingress: () => s.status().npcIngress };
}

function motionSetup(t: TestContext, extra: object = { observePlayerMotion: true }, clock = () => Date.now()) {
  const s = ingressSetup(t, extra, clock);
  return { ...s, motion: () => s.status().playerMotion,
    receiveMotion: (data: unknown = s.packet().positionUpdate, client = s.client) => s.controller.observePlayerMotionIngress(client, data),
    sendMotion: (name = "ClientUpdate.UpdateLocation", data: unknown = { position: [1, 2, 3, 1] }, raw?: Buffer, client = s.client) =>
      s.controller.observePlayerMotionSend(client, name, data, raw) };
}

test("player motion opt-in is independent, strict and disabled without clock or payload reads", t => {
  const body = { action: "prepare", target: "1", requestId: "r", expectedPlayerCharacterId: "p", expectedNpcCharacterId: null };
  assert.deepEqual(parseTestZombieReplayRequest({ ...body, observePlayerMotion: false }), parseTestZombieReplayRequest(body));
  for (const value of [undefined, null, 0, 1, "true", [], {}])
    assert.throws(() => parseTestZombieReplayRequest({ ...body, observePlayerMotion: value }), /observe_player_motion_must_be_boolean/);
  let reads = 0;
  const s = motionSetup(t, { observePlayerMotion: false }, () => { reads++; throw Error("clock"); });
  s.ready(); const data = { get position() { reads++; throw Error("payload"); } };
  assert.equal(s.receiveMotion(data), undefined); s.sendMotion(undefined, data); t.mock.timers.tick(100);
  assert.equal(reads, 0); assert.equal(s.motion(), undefined); assert.equal(s.ingress(), undefined);
  assert.throws(() => s.prepare({ observePlayerMotion: true }), /request_id_reused_with_different_identity/);
  assert.throws(() => s.control("start", { observePlayerMotion: true }), /unknown_or_missing_fields/);
});

test("player receipt snapshots before/after independently; early exits remain unassigned and detached", t => {
  const s = motionSetup(t); assert.equal(s.receiveMotion(), undefined); s.ready();
  const data = { flags: 8191, sequenceTime: 12, unknown3_int8: 1, stance: 1024, position: [0, 11.1, 0, 1] };
  const complete = s.receiveMotion(data); const old = Array.from(s.client.character.state.position);
  complete("before"); s.client.character.state.position = data.position; complete("after");
  const row = s.motion().inbound[0];
  assert.deepEqual(Array.from(row.positionAtReceipt), old); assert.deepEqual(Array.from(row.positionBefore), old);
  assert.deepEqual(Array.from(row.positionAfter), data.position); assert.equal(row.assigned, true); assert.equal(row.stance, 1024);
  assert.equal(row.assignmentOutsideWindow, false);
  data.position[1] = 99; row.positionAfter[1] = 999;
  assert.equal(s.motion().inbound[0].positionAfter[1], 11.1); assert.equal(s.motion().inbound[0].position[1], 11.1);
  for (const update of [{ flags: 0 }, { flags: 513, stance: 1024 }, { flags: 8191, parseError: true }, undefined]) s.receiveMotion(update);
  assert.ok(s.motion().inbound.slice(1).every((r: any) => r.assigned === false && r.positionBefore === null && r.positionAfter === null));
});

test("player motion starts once, keeps latest128 inbound and first32 outbound independently", t => {
  const s = motionSetup(t); s.ready(); const began = s.motion().startedMonotonicMs;
  for (let i = 0; i < 300; i++) s.receiveMotion({ sequenceTime: i });
  for (let i = 0; i < 40; i++) s.sendMotion();
  const m = s.motion(); assert.equal(m.inbound.length, 128); assert.equal(m.inbound[0].sequenceTime, 172);
  assert.equal(m.inbound.at(-1).sequenceTime, 299); assert.equal(m.droppedInbound, 172);
  assert.equal(m.outbound.length, 32); assert.equal(m.droppedOutbound, 8); assert.equal(m.truncated, true);
  t.mock.timers.tick(100); s.ready(); assert.equal(s.motion().startedMonotonicMs, began);
  t.mock.timers.tick(29900); s.sendMotion(); s.receiveMotion();
  assert.equal(s.motion().stoppedReason, "observation_window_elapsed");
  assert.equal(s.motion().inboundCount, 300); assert.equal(s.motion().outboundCount, 40);
});

test("assignment finishing across the window is explicit; old closures cannot mutate after finish/new lease", t => {
  let now = 10000; const s = motionSetup(t, undefined, () => now); s.ready();
  const complete = s.receiveMotion(); now += 29999; complete("before"); now += 1;
  s.client.character.state.position = [0, 11.1, 0, 1]; complete("after");
  assert.equal(s.motion().inbound[0].assigned, true); assert.equal(s.motion().inbound[0].assignmentOutsideWindow, true);
  s.receiveMotion(); assert.equal(s.motion().inboundCount, 1);
  s.control("finish"); const saved = JSON.stringify(s.motion()); complete("after"); assert.equal(JSON.stringify(s.motion()), saved);
  s.prepare({ requestId: "next", expectedNpcCharacterId: null, observePlayerMotion: true });
  complete("before"); complete("after"); assert.equal(s.motion().inbound.length, 0);
});

for (const change of ["client", "character", "session", "npc", "owner", "route", "second-client", "dead"]) {
  test(`player observation rejects ${change} without lifecycle effects`, t => {
    const s = motionSetup(t); s.ready(); const complete = s.receiveMotion(); const events = s.events.slice();
    if (change === "client") s.zone._clients[1] = { ...s.client };
    if (change === "character") s.client.character = { ...s.client.character };
    if (change === "session") s.client.sessionId = 2;
    if (change === "npc") s.zone._npcs.new = { ...s.npc };
    if (change === "owner") s.npc.testFullDataOwner = {};
    if (change === "route") s.npc.testRouteResource = {};
    if (change === "second-client") s.zone._clients[2] = {};
    if (change === "dead") s.client.character.isAlive = false;
    complete("before"); complete("after"); s.receiveMotion(); s.sendMotion();
    assert.equal(s.motion().inbound.length, 1); assert.equal(s.motion().inbound[0].assigned, false);
    assert.equal(s.motion().outbound.length, 0); assert.equal(s.motion().stoppedReason, "observation_identity_changed");
    assert.deepEqual(s.events, events);
  });
}

test("player motion ignores unrelated clients and packets before reading payload", t => {
  const s = motionSetup(t); s.ready(); const poison = { get position() { throw Error("unrelated"); } };
  s.receiveMotion(poison, { ...s.client }); s.sendMotion("Other", poison); s.sendMotion(undefined, poison, undefined, { ...s.client });
  assert.equal(s.motion().inboundCount, 0); assert.equal(s.motion().outboundCount, 0); assert.equal(s.motion().stoppedReason, null);
});

test("raw sends use fixed schemas only, retain unknown layouts, and never claim delivery", t => {
  const s = motionSetup(t); s.ready(); let parses = 0;
  s.zone._protocol = { parse(raw: Buffer, flag: number) { parses++; assert.equal(flag, 0);
    return { name: raw.length === 38 ? "ClientUpdate.UpdateLocation" : "Character.Knockback",
      data: { position: [1, 2, 3, 1], unknownByte1: 7, unknownFloatVector1: [4, 5, 6, 0] } }; } };
  s.sendMotion(undefined, undefined, Buffer.alloc(38)); s.sendMotion("Character.Knockback", undefined, Buffer.alloc(42));
  s.sendMotion(undefined, undefined, Buffer.alloc(39)); s.sendMotion("Character.Knockback", undefined, Buffer.alloc(9999));
  const rows = s.motion().outbound;
  assert.equal(parses, 2); assert.equal(rows[0].layout, "parsed_fixed_wire"); assert.equal(rows[0].movementVersion, 7);
  assert.equal(rows[1].vector1[2], 6); assert.equal(rows[2].layout, "layout_unknown"); assert.equal(rows[2].position, null);
  assert.equal(rows[3].rawPrefix.length, 84);
  assert.ok(rows.every((r: any) => r.phase === "send_attempt" && r.transportOutcome === "not_observed"));
  s.zone._protocol.parse = () => { throw Error("parse"); }; s.sendMotion(undefined, undefined, Buffer.alloc(38));
  assert.equal(s.motion().outbound.at(-1).layout, "layout_unknown"); assert.equal(s.motion().stoppedReason, null);
  rows[0].position[0] = 999; assert.equal(s.motion().outbound[0].position[0], 1);
});

test("raw motion observer agrees with actual source protocol opcodes, lengths and decoded fields", t => {
  const s = motionSetup(t); s.ready();
  const { H1Z1Protocol } = require("../src/protocols/h1z1protocol");
  s.zone._protocol = new H1Z1Protocol("ClientProtocol_1080");
  for (const [name, expectedLength, hex, payload] of [
    ["ClientUpdate.UpdateLocation", 38, "110a00", { position: [1492, 47.52, -648, 1], unknownByte1: 4, triggerLoadingScreen: false }],
    ["Character.Knockback", 42, "0f02", { unknownFloatVector1: [1, 2, 3, 4], unknownFloatVector2: [5, 6, 7, 8], unknownDword1: 9, unknownDword2: 10 }]
  ] as const) {
    const raw = s.zone._protocol.pack(name, payload); assert.equal(raw.length, expectedLength);
    assert.equal(raw.subarray(0, hex.length / 2).toString("hex"), hex);
    s.sendMotion(name, undefined, raw); const row = s.motion().outbound.at(-1);
    assert.equal(row.layout, "parsed_fixed_wire");
    if (name === "ClientUpdate.UpdateLocation") {
      assert.ok(Math.abs(row.position[1] - 47.52) < 0.00001); assert.equal(row.movementVersion, 4);
    } else { assert.deepEqual(Array.from(row.vector2), [5, 6, 7, 8]); assert.equal(row.dword1, 9); }
  }
});

test("assignment observer clock failure stays diagnostic; a completed packet cannot be rewritten", t => {
  let now = 10000; const s = motionSetup(t, undefined, () => now); s.ready();
  const completed = s.receiveMotion(); completed("before"); completed("after");
  const initial = JSON.stringify(s.motion().inbound[0]);
  s.client.character.state.position = [0, 99, 0, 1]; completed("before"); completed("after");
  assert.equal(JSON.stringify(s.motion().inbound[0]), initial);
  const partial = s.receiveMotion(); partial("before"); now--;
  assert.doesNotThrow(() => partial("after")); assert.equal(s.motion().inbound[1].assigned, false);
  assert.equal(s.motion().stoppedReason, "observation_read_or_clock_failed");
});

for (const bad of [NaN, Infinity, -1, "throw"]) {
  test(`player observer clock ${bad} and property failures cannot close replay`, t => {
    let now: any = 10000; const s = motionSetup(t, undefined, () => { if (now === "throw") throw Error("clock"); return now; });
    s.ready(); const events = s.events.slice(); now = bad;
    assert.doesNotThrow(() => s.receiveMotion()); assert.equal(s.motion().inbound.length, 0);
    assert.equal(s.motion().stoppedReason, "observation_read_or_clock_failed"); assert.deepEqual(s.events, events);
  });
}

test("poison player payload stops only observer and finite allowlist bounds fields", t => {
  const s = motionSetup(t); s.ready();
  s.receiveMotion({ flags: -1, stance: NaN, sequenceTime: Infinity, unknown3_int8: 256,
    position: [1, NaN, 3], arbitrary: "x".repeat(999999) });
  const row = s.motion().inbound[0]; assert.equal(row.flags, null); assert.equal(row.stance, null);
  assert.equal(row.position, null); assert.equal("arbitrary" in row, false);
  const events = s.events.slice(); assert.doesNotThrow(() => s.receiveMotion({ get position() { throw Error("payload"); } }));
  assert.equal(s.motion().stoppedReason, "observation_read_failed"); assert.deepEqual(s.events, events);
});

test("full NPC plus player observation status stays below the existing256KiB response cap", t => {
  const s = motionSetup(t, { observeNpcIngress: true, observePlayerMotion: true }); s.ready();
  // JSON's longest finite numeric representations; all retained allowlisted vector slots populated.
  const value = -1.2345678901234567e-300, vector = [value, value, value, value];
  for (let i = 0; i < 256; i++) {
    s.receive(s.packet({ position: vector, horizontalSpeed: value, verticalSpeed: value, sequenceTime: 0xffffffff, flags: 65535, unknown3_int8: 255 }));
    const done = s.receiveMotion({ position: vector, stance: 0xffffffff, sequenceTime: 0xffffffff, flags: 65535, unknown3_int8: 255 });
    s.client.character.state.position = vector; done("before"); done("after");
  }
  s.zone._protocol = { parse() { return { name: "Character.Knockback", data: { position: vector,
    unknownFloatVector1: vector, unknownFloatVector2: vector, unknownDword1: 0xffffffff, unknownDword2: 0xffffffff } }; } };
  for (let i = 0; i < 32; i++) s.sendMotion("Character.Knockback", undefined, Buffer.alloc(42));
  const snapshot = s.status();
  // Include maximal finite clock strings too, without making the fixture clock invalid.
  for (const row of [...snapshot.npcIngress.records, ...snapshot.playerMotion.inbound, ...snapshot.playerMotion.outbound]) {
    row.utcMs = value; row.monotonicMs = value;
  }
  for (const row of snapshot.playerMotion.outbound) {
    row.packetName = "ClientUpdate.UpdateLocation"; row.triggerLoadingScreen = false; row.wireLength = Number.MAX_SAFE_INTEGER;
  }
  for (const key of ["requestId", "target", "playerCharacterId", "replacedNpcCharacterId", "npcCharacterId"])
    snapshot[key] = "x".repeat(80);
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  t.diagnostic(`combined worst-field observation status: ${bytes}B`);
  assert.ok(bytes < 240000, `combined observation status ${bytes}B leaves insufficient response envelope reserve`);
});

test("NPC ingress is strict opt-in; absent/false retain canonical schema and zero observation reads", t => {
  const valid = { action: "prepare", target: "1", requestId: "r", expectedPlayerCharacterId: "p", expectedNpcCharacterId: null };
  assert.deepEqual(parseTestZombieReplayRequest({ ...valid, observeNpcIngress: false }), parseTestZombieReplayRequest(valid));
  for (const value of [undefined, null, 0, 1, "true", [], {}]) {
    assert.throws(() => parseTestZombieReplayRequest({ ...valid, observeNpcIngress: value }), /observe_npc_ingress_must_be_boolean/);
  }
  let reads = 0;
  const s = ingressSetup(t, { observeNpcIngress: false }, () => { reads++; throw Error("must not read clock"); });
  s.ready();
  const data = { get transientId() { reads++; throw Error("must not read data"); } };
  s.receive(data); t.mock.timers.tick(100);
  assert.equal(reads, 0); assert.equal(s.ingress(), undefined);
  assert.throws(() => s.prepare({ observeNpcIngress: true }), /request_id_reused_with_different_identity/);
  assert.throws(() => s.control("start", { observeNpcIngress: true }), /unknown_or_missing_fields/);
});

test("NPC ingress starts once at pause, records flags0 and unknown fields without changing state", t => {
  const s = ingressSetup(t);
  s.receive(); assert.equal(s.ingress().records.length, 0); assert.equal(s.ingress().startedMonotonicMs, null);
  s.ready(); const start = s.ingress().startedMonotonicMs;
  const position = Array.from(s.npc.state.position), events = s.events.slice();
  const data = s.packet({ flags: 0, parseError: true }); s.receive(data);
  s.receive({ transientId: 42 });
  data.positionUpdate.position[0] = 999;
  const observed = s.ingress();
  assert.equal(observed.records.length, 2); assert.equal(observed.records[0].flags, 0);
  assert.deepEqual(Array.from(observed.records[0].position), [1, 2, 3, 1]);
  assert.equal(observed.records[1].flags, null); assert.equal(observed.records[1].position, null);
  assert.equal(observed.records[1].horizontalSpeed, null);
  assert.equal(observed.records[0].parseError, true); assert.equal(observed.records[1].parseError, null);
  assert.deepEqual(Array.from(s.npc.state.position), position); assert.deepEqual(s.events, events);
  assert.equal(s.npc.clearMovementController.mock.callCount(), 0); assert.equal(s.npc.sendIdleStance.mock.callCount(), 0);
  observed.records[0].position[0] = 777; observed.records.push({});
  assert.equal(s.ingress().records.length, 2); assert.equal(s.ingress().records[0].position[0], 1);
  t.mock.timers.tick(100); s.ready();
  assert.equal(s.ingress().startedMonotonicMs, start);
  assert.equal(s.ingress().deadlineMonotonicMs, start + 30000);
  assert.throws(() => s.prepare({ observeNpcIngress: false }), /request_id_reused_with_different_identity/);
});

test("NPC ingress ignores other clients/transients and does not require managed-object membership", t => {
  const s = ingressSetup(t); s.ready(); s.client.managedObjects = [];
  s.receive(s.packet(), { ...s.client });
  for (const transientId of [0, 41, 43, "42", undefined, null, NaN]) s.receive({ ...s.packet(), transientId });
  assert.equal(s.ingress().matchedPackets, 0);
  s.receive(); assert.equal(s.ingress().matchedPackets, 1); assert.deepEqual(s.client.managedObjects, []);
});

test("NPC ingress retains at most256 detached records and expires without GET renewal", t => {
  const s = ingressSetup(t); s.ready();
  for (let i = 0; i < 260; i++) s.receive(s.packet({ sequenceTime: i }));
  assert.equal(s.ingress().records.length, 256); assert.equal(s.ingress().matchedPackets, 260); assert.equal(s.ingress().truncated, true);
  const deadline = s.ingress().deadlineMonotonicMs;
  t.mock.timers.tick(29999); s.ingress();
  assert.equal(s.ingress().deadlineMonotonicMs, deadline);
  t.mock.timers.tick(1); s.receive();
  assert.equal(s.ingress().stoppedReason, "observation_window_elapsed"); assert.equal(s.ingress().matchedPackets, 260);
  assert.equal(s.status().state, "paused", "observation timeout does not end the replay");
});

for (const mutation of ["disconnect", "session_replaced", "session_id", "player_replaced", "player_guid", "npc_replaced", "npc_guid", "npc_transient", "transient_map", "owner", "by_session", "last_npc", "dead_npc", "dead_player", "second_client"] as const) {
  test(`NPC ingress stops on ${mutation} without triggering lifecycle cleanup`, t => {
    const s = ingressSetup(t); s.ready(); s.receive(); const events = s.events.slice();
    if (mutation === "disconnect") delete s.zone._clients[1];
    if (mutation === "session_replaced") s.zone._clients[1] = { ...s.client };
    if (mutation === "session_id") { delete s.zone._clients[1]; s.client.sessionId = 2; s.zone._clients[2] = s.client; }
    if (mutation === "player_replaced") s.client.character = { ...s.client.character };
    if (mutation === "player_guid") s.client.character.characterId = "replacement";
    if (mutation === "npc_replaced") s.zone._npcs.new = { ...s.npc };
    if (mutation === "npc_guid") s.npc.characterId = "replacement";
    if (mutation === "npc_transient") s.npc.transientId = 43;
    if (mutation === "transient_map") s.zone._transientIds[42] = "replacement";
    if (mutation === "owner") s.npc.testFullDataOwner = { ...s.client };
    if (mutation === "by_session") s.zone._testZombieBySessionId[1] = "replacement";
    if (mutation === "last_npc") s.zone._lastSpawnedNpcCharacterId = "replacement";
    if (mutation === "dead_npc") s.npc.isAlive = false;
    if (mutation === "dead_player") s.client.character.isAlive = false;
    if (mutation === "second_client") s.zone._clients[2] = {};
    s.receive();
    assert.equal(s.ingress().records.length, 1); assert.equal(s.ingress().stoppedReason, "observation_identity_changed");
    assert.deepEqual(s.events, events); assert.equal(s.status().state, "paused");
  });
}

test("NPC ingress cannot append after finish or mix delayed old transient into a new run", t => {
  const s = ingressSetup(t); s.ready(); s.receive(); const first = s.ingress();
  s.control("finish"); s.receive();
  assert.equal(s.ingress().records.length, 1); assert.equal(s.ingress().stoppedReason, "lease_explicit_finish");
  s.prepare({ requestId: "next", expectedNpcCharacterId: null, observeNpcIngress: true });
  const next: any = { characterId: "nextnpc", transientId: 43, isAlive: true, testFullDataOwner: s.client };
  s.zone._npcs.nextnpc = next; s.zone._lastSpawnedNpcCharacterId = "nextnpc";
  s.zone._testZombieBySessionId[1] = "nextnpc"; s.zone._transientIds[43] = "nextnpc";
  const hooks = s.captured[1].lifecycle; hooks.onSpawned(next, () => {}); hooks.onFullData(); hooks.onPaused();
  s.receive(); assert.equal(s.ingress().records.length, 0);
  s.receive({ ...s.packet(), transientId: 43 });
  assert.equal(s.ingress().records.length, 1); assert.notEqual(s.ingress().replayId, first.replayId);
  assert.equal(s.ingress().npcCharacterId, "nextnpc"); assert.equal(first.records.length, 1);
});

test("NPC ingress finite-field allowlist never serializes arbitrary packet properties", t => {
  const s = ingressSetup(t); s.ready();
  const extra = { get arbitrary() { throw Error("must not read"); } };
  const data = s.packet({ flags: -1, sequenceTime: 2 ** 32, unknown3_int8: 256,
    position: [1, Infinity, 3], horizontalSpeed: NaN, verticalSpeed: "2", extra });
  s.receive(data);
  const record = s.ingress().records[0];
  for (const key of ["flags", "sequenceTime", "movementVersion", "position", "horizontalSpeed", "verticalSpeed"]) assert.equal(record[key], null);
  assert.equal("extra" in record, false);
  for (const position of [[1, 2], [1, 2, 3, 4, 5], "1,2,3", { length: 3 }, new Uint8Array([1, 2, 3])]) s.receive(s.packet({ position }));
  assert.ok(s.ingress().records.slice(1).every((row: any) => row.position === null));
  s.receive(s.packet({ position: new Float32Array([1, 2, 3]), flags: 65535, sequenceTime: 0xffffffff, unknown3_int8: 255 }));
  assert.deepEqual(Array.from(s.ingress().records.at(-1).position), [1, 2, 3]);
});

for (const invalid of [NaN, Infinity, -1, 9999]) {
  test(`NPC ingress clock ${invalid} fails closed without closing the lease`, t => {
    let now = 10000; const s = ingressSetup(t, { observeNpcIngress: true }, () => now); s.ready(); s.receive();
    now = invalid; s.receive(); now = 10001; s.receive();
    assert.equal(s.ingress().records.length, 1); assert.equal(s.ingress().stoppedReason, "observation_clock_invalid");
    assert.equal(s.status().state, "paused");
  });
}

test("NPC ingress observer exceptions do not escape or clean the lease", t => {
  const s = ingressSetup(t); s.ready(); const events = s.events.slice();
  s.receive({ transientId: 42, get positionUpdate() { throw Error("bad read"); } });
  assert.equal(s.ingress().stoppedReason, "observation_read_failed"); assert.equal(s.ingress().records.length, 0);
  assert.equal(s.status().state, "paused"); assert.deepEqual(s.events, events);
});

test("NPC ingress refuses transient reuse across run boundaries because the wire has no run nonce", t => {
  const s = ingressSetup(t); s.ready(); s.receive(); s.control("finish");
  s.prepare({ requestId: "next", expectedNpcCharacterId: null, observeNpcIngress: true });
  const next: any = { characterId: "nextnpc", transientId: 42, isAlive: true, testFullDataOwner: s.client };
  s.zone._npcs.nextnpc = next; s.zone._lastSpawnedNpcCharacterId = "nextnpc";
  s.zone._testZombieBySessionId[1] = "nextnpc"; s.zone._transientIds[42] = "nextnpc";
  const hooks = s.captured[1].lifecycle; hooks.onSpawned(next, () => {}); hooks.onFullData(); hooks.onPaused();
  s.receive(); assert.equal(s.ingress().stoppedReason, "observation_transient_reused");
  assert.equal(s.ingress().records.length, 0); assert.equal(s.status().state, "paused");
});

test("NPC ingress arm-clock failure stays diagnostic-only and dispose prevents further receipts", t => {
  const s = ingressSetup(t, { observeNpcIngress: true }, () => { throw Error("clock unavailable"); });
  s.ready(); s.receive();
  assert.equal(s.ingress().stoppedReason, "observation_clock_invalid"); assert.equal(s.status().state, "paused");
  s.controller.dispose(); s.receive();
  assert.equal(s.ingress().records.length, 0); assert.equal(s.status().state, "finished");
});

test("NPC ingress rejects elapsed lease immediately even before its cleanup timer runs", t => {
  const s = ingressSetup(t); s.ready(); s.receive(); const events = s.events.slice();
  t.mock.timers.setTime(s.status().expiresAt);
  s.receive();
  assert.equal(s.ingress().stoppedReason, "observation_lease_expired"); assert.equal(s.ingress().records.length, 1);
  assert.deepEqual(s.events, events); assert.equal(s.status().state, "paused");
});

test("cancelling a scheduled source spawn retains protection and blocks replacement until that task settles", async t => {
  const s = setup(t, true); s.prepare();
  assert.equal(s.status().spawnTaskPending, true);
  const cancelled = s.control("finish");
  assert.match(cancelled.cleanupError, /spawn_task_pending/);
  assert.equal(cancelled.protectionApplied, true);
  assert.throws(() => s.prepare({ requestId: "next" }), /previous_cleanup_incomplete/);
  s.control("finish");
  assert.equal(s.client.character.godMode, true);
  t.mock.timers.tick(1); await flush();
  assert.equal(s.status().spawnTaskPending, false);
  assert.equal(s.status().cleanupError, null);
  assert.equal(s.client.character.godMode, false);
  assert.equal(s.zone._npcs.old, s.old);
  assert.equal(s.loadTerrain.mock.callCount(), 0);
  s.prepare({ requestId: "next" });
});

test("pending terrain cancellation cannot be overwritten by a new lease or lose its terminal cleanup", async t => {
  const s = setup(t, true); s.prepare(); t.mock.timers.tick(1);
  const first = s.status().replayId, hooks = s.captured[0].lifecycle;
  s.control("finish");
  assert.throws(() => s.prepare({ requestId: "next" }), /previous_cleanup_incomplete/);
  assert.equal(s.status().replayId, first);
  assert.equal(s.status().spawnTaskPending, true);
  s.complete([]); await flush();
  assert.equal(s.status().spawnTaskPending, false);
  assert.equal(s.status().cleanupError, null);
  assert.equal(s.zone._npcs.old, s.old);
  s.prepare({ requestId: "next" });
  const second = s.status().replayId;
  hooks.onSpawnTaskStarted(); hooks.onSpawnTaskSettled();
  hooks.onUnpublishedCleanupFailure({ npcCleanupFailed: false, routeDisposalAttempted: true, routeDisposalFailed: true });
  assert.equal(s.status().replayId, second);
  assert.equal(s.status().state, "preparing");
  assert.equal(s.status().routeDisposalFailed, false);
  assert.equal(s.client.character.godMode, true);
});

for (const ending of ["finish", "timeout", "disconnect", "http_stop"]) {
  test(`late unpublished NAV disposal failure after ${ending} stays on its original lease and is never retried`, async t => {
    const s = setup(t, true);
    let resolveResource!: (resource: any) => void, disposals = 0;
    s.setKnownFencePreparation(() => new Promise(resolve => { resolveResource = resolve; }));
    s.prepare({ knownObstacle: "fence-192060" }); t.mock.timers.tick(1);
    s.complete([]); await flush();
    const replayId = s.status().replayId;
    if (ending === "finish") s.control("finish");
    if (ending === "timeout") t.mock.timers.tick(120000);
    if (ending === "disconnect") { delete s.zone._clients[1]; t.mock.timers.tick(100); }
    if (ending === "http_stop") s.controller.dispose();
    assert.equal(s.status().spawnTaskPending, true);
    assert.equal(s.client.character.godMode, true);
    resolveResource({ dispose() { disposals++; throw Error("partial native disposal"); } }); await flush();
    assert.equal(s.status().replayId, replayId);
    assert.equal(s.status().spawnTaskPending, false);
    assert.equal(s.status().state, "failed");
    assert.match(s.status().cleanupError, /route_resource_disposal_failed_not_retried/);
    assert.equal(s.status().routeDisposalFailed, true);
    assert.equal(s.status().protectionApplied, false);
    assert.equal(s.client.character.godMode, false);
    assert.equal(s.zone.generateGuid.mock.callCount(), 0);
    assert.equal(s.zone._npcs.old, s.old);
    assert.equal(disposals, 1);
    assert.throws(() => s.prepare({ requestId: "next" }));
    if (ending !== "http_stop") s.control("finish");
    s.controller.dispose(); assert.equal(disposals, 1);
  });
}

test("failed unpublished NPC cleanup remains protected and can retry only that exact NPC", async t => {
  const s = setup(t, true);
  const failure = t.mock.method(s.zone.aiManager, "removeEntity", () => { throw Error("remove unavailable"); });
  s.prepare(); t.mock.timers.tick(1); s.complete([]); await flush();
  const npc = [...s.activeAi][0];
  assert.ok(npc);
  assert.equal(s.status().npcCharacterId, npc.characterId);
  assert.equal(s.status().spawnTaskPending, false);
  assert.equal(s.status().state, "failed");
  assert.match(s.status().cleanupError, /owned_npc_cleanup_incomplete/);
  assert.equal(s.client.character.godMode, true);
  assert.equal(s.zone.addLightweightNpc.mock.callCount(), 0);
  assert.throws(() => s.prepare({ requestId: "next", expectedNpcCharacterId: null }), /previous_cleanup_incomplete/);
  const replacement = { characterId: npc.characterId, isAlive: true };
  s.zone._npcs[npc.characterId] = replacement; s.activeAi.add(replacement);
  failure.mock.restore(); s.control("finish");
  assert.equal(s.activeAi.has(npc), false);
  assert.equal(s.activeAi.has(replacement), true);
  assert.equal(s.zone._npcs[npc.characterId], replacement);
  assert.equal(s.status().cleanupError, null);
  assert.equal(s.client.character.godMode, false);
});

test("source publication failure after explicit adoption releases its route once through the lease", async t => {
  const s = setup(t, true); let disposals = 0;
  s.setKnownFencePreparation(async () => ({ dispose() { disposals++; }, testRouteStep() {}, testMeleeReachability() {} }));
  t.mock.method(s.zone, "addLightweightNpc", () => { throw Error("publication unavailable"); });
  s.prepare({ knownObstacle: "fence-192060" }); t.mock.timers.tick(1); s.complete([]); await flush();
  assert.equal(s.status().state, "failed");
  assert.equal(s.status().spawnTaskPending, false);
  assert.equal(s.status().cleanupError, null);
  assert.equal(s.zone._npcs.new, undefined);
  assert.equal(s.activeAi.size, 0);
  assert.equal(s.client.character.godMode, false);
  assert.equal(disposals, 1);
  s.control("finish"); s.controller.dispose(); assert.equal(disposals, 1);
});

test("unpublished NPC retry cannot erase or repeat a failed native destructor", async t => {
  const s = setup(t, true); let disposals = 0;
  s.setKnownFencePreparation(async () => ({ dispose() { disposals++; throw Error("partial disposal"); } }));
  const failure = t.mock.method(s.zone.aiManager, "removeEntity", () => { throw Error("remove unavailable"); });
  s.prepare({ knownObstacle: "fence-192060" }); t.mock.timers.tick(1); s.complete([]); await flush();
  assert.equal(s.status().spawnTaskPending, false);
  assert.match(s.status().cleanupError, /owned_npc_cleanup_incomplete/);
  assert.equal(s.status().routeDisposalFailed, true);
  assert.equal(s.client.character.godMode, true);
  assert.equal(disposals, 1);
  failure.mock.restore(); s.control("finish");
  assert.match(s.status().cleanupError, /route_resource_disposal_failed_not_retried/);
  assert.equal(s.client.character.godMode, false);
  assert.equal(s.activeAi.size, 0);
  assert.equal(disposals, 1);
  assert.throws(() => s.prepare({ requestId: "next", expectedNpcCharacterId: null }), /previous_cleanup_incomplete/);
  s.control("finish"); assert.equal(disposals, 1);
});

test("automatic login wrapper initializes its NPC but never rearms AI, even with no-AI env disabled", async t => {
  const previous = process.env.TEST_ZOMBIE_NO_AI;
  let s: ReturnType<typeof setup>;
  try {
    process.env.TEST_ZOMBIE_NO_AI = "false";
    s = setup(t, true); // Evaluate the actual source with the global no-AI switch off.
  } finally {
    if (previous === undefined) delete process.env.TEST_ZOMBIE_NO_AI;
    else process.env.TEST_ZOMBIE_NO_AI = previous;
  }
  delete s.zone._testZombieChaseAttackCharacterId;
  s.helper.testZombieInFrontOnSpawn(s.zone, s.client);
  t.mock.timers.tick(499);
  assert.equal(s.zone.generateGuid.mock.callCount(), 0);
  t.mock.timers.tick(1); s.complete([]); await flush();
  const npc = s.zone._npcs.new;
  assert.ok(npc);
  assert.equal(s.zone.addLightweightNpc.mock.callCount(), 1);
  assert.equal(s.zone.sendStandardFullNpcInit.mock.callCount(), 0);
  assert.equal(s.activeAi.has(npc), false, "constructor registration is removed");
  assert.equal(s.client.testZombieSpawned, true);
  const callback = npc.onReadyCallback;
  s.requestFull(npc, { ...s.client });
  assert.equal(npc.onReadyCallback, callback);
  assert.equal(s.zone.sendStandardFullNpcInit.mock.callCount(), 0);
  s.helper.recordTestZombieClockSample(s.client, 5000, 5000, 513, 1, 0x400);
  s.requestFull(npc);
  assert.equal(npc.onReadyCallback, undefined);
  assert.equal(s.zone.sendStandardFullNpcInit.mock.callCount(), 1);
  for (let i = 0; i < 31; i++) {
    s.helper.recordTestZombieClockSample(s.client, 6000 + i, 6000 + i, 513, 1, 0x400);
    t.mock.timers.tick(1000);
  }
  assert.equal(s.client.testZombieClockDiagnostics.aligned, 32, "real clock samples remain observable");
  assert.equal(s.client.testZombieClockResync, undefined);
  assert.equal(s.activeAi.size, 0);
  assert.equal(s.zone.aiManager.addEntity.mock.callCount(), 1, "only the removed constructor registration");
  assert.equal(s.zone._testZombieChaseAttackCharacterId, undefined);
  assert.equal(npc.clearMovementController.mock.callCount(), 0);
  assert.equal(npc.sendIdleStance.mock.callCount(), 0);
  assert.equal(s.zone.setGodMode.mock.callCount(), 0);
  s.requestFull(npc);
  assert.equal(s.zone.sendStandardFullNpcInit.mock.callCount(), 1, "duplicate full request cannot rearm");
  assert.equal(s.zone.aiManager.addEntity.mock.callCount(), 1);
});

test("closed schema rejects unknown fields, absent identities and noncanonical target", () => {
  const valid = { action: "prepare", target: "1", requestId: "r", expectedPlayerCharacterId: "p", expectedNpcCharacterId: null };
  for (const body of [null, [], {}, { ...valid, speedScale: 1 }, { ...valid, target: 1 }, { ...valid, target: "01" }, { ...valid, action: ["prepare"] }, { ...valid, expectedNpcCharacterId: undefined }]) {
    assert.throws(() => parseTestZombieReplayRequest(body));
  }
  assert.equal(parseTestZombieReplayRequest(valid).action, "prepare");
});

test("prepare distance accepts only finite numeric 6..12 and defaults to 6", t => {
  const s = setup(t);
  assert.equal(s.status().distance, 6);
  assert.equal(parseTestZombieReplayRequest(s.prepareBody).distance, 6);
  for (const distance of [6, 6.25, 9, 12]) {
    assert.equal(parseTestZombieReplayRequest({ ...s.prepareBody, distance }).distance, distance);
  }
  for (const distance of [NaN, Infinity, -Infinity, "12", null, undefined, true, [], {}, 5.999, 12.001]) {
    assert.throws(() => s.prepare({ distance }), /distance_must_be_finite_6_to_12/);
  }
  for (const action of ["start", "finish"]) {
    assert.throws(() => parseTestZombieReplayRequest({ action, target: "1", replayId: "r", expectedNpcCharacterId: null, distance: 12 }), /unknown_or_missing_fields/);
  }
  assert.equal(s.events.length, 0); assert.equal(s.captured.length, 0);
});

test("omitted and explicit default distance share one lease; different distance cannot reuse it", t => {
  const s = setup(t); const first = s.prepare();
  assert.deepEqual(s.prepare({ distance: 6 }), first);
  assert.throws(() => s.prepare({ distance: 12 }), /request_id_reused_with_different_identity/);
  assert.equal(s.captured.length, 1); assert.equal(s.status().distance, 6);
});

test("known obstacle schema accepts only the named six-metre fence and preserves old canonical requests", t => {
  const s = setup(t), old = parseTestZombieReplayRequest(s.prepareBody);
  assert.equal(JSON.stringify(old), JSON.stringify({ ...s.prepareBody, distance: 6 }));
  assert.equal(Object.hasOwn(old, "knownObstacle"), false);
  const fence = parseTestZombieReplayRequest({ ...s.prepareBody, knownObstacle: "fence-192060" });
  assert.equal(fence.distance, 6); assert.equal(fence.knownObstacle, "fence-192060");
  assert.equal(JSON.stringify(fence), JSON.stringify(parseTestZombieReplayRequest({ ...s.prepareBody, distance: 6, knownObstacle: "fence-192060" })));
  for (const knownObstacle of [undefined, null, true, 192060, "", "fence-192179", "FENCE-192060", [], {}])
    assert.throws(() => s.prepare({ knownObstacle }), /invalid_known_obstacle/);
  for (const distance of [6.00001, 6.25, 9, 12])
    assert.throws(() => s.prepare({ knownObstacle: "fence-192060", distance }), /known_obstacle_distance_must_be_6/);
  for (const action of ["start", "finish"])
    assert.throws(() => parseTestZombieReplayRequest({ action, target: "1", replayId: "r", expectedNpcCharacterId: null,
      knownObstacle: "fence-192060" }), /unknown_or_missing_fields/);
  assert.equal(s.captured.length, 0); assert.equal(s.events.length, 0);
});

test("fence selection is immutable in lease/status/spawn and cannot be removed from the same request ID", t => {
  const s = setup(t); const body = { ...s.prepareBody, knownObstacle: "fence-192060" };
  const first = s.controller.handle(body); body.knownObstacle = "foreign";
  assert.equal(s.status().knownObstacle, "fence-192060"); assert.equal(s.status().otherCollisionCoverage, "unknown");
  assert.equal(s.status().distance, 6); assert.equal(s.captured[0].knownObstacle, "fence-192060");
  assert.equal(s.captured[0].distance, 6); assert.equal(s.captured[0].profileId, 10);
  assert.deepEqual(s.prepare({ knownObstacle: "fence-192060", distance: 6 }), first);
  assert.throws(() => s.prepare(), /request_id_reused_with_different_identity/);
  assert.equal(s.captured.length, 1);
  s.control("finish");
  const plain = s.prepare({ requestId: "plain-again", distance: 6 });
  assert.equal(Object.hasOwn(plain, "knownObstacle"), false);
  assert.equal(Object.hasOwn(s.captured[1], "knownObstacle"), false);
});

test("a terrain-only request ID cannot be changed into a named-fence request", t => {
  const s = setup(t); s.prepare();
  assert.throws(() => s.prepare({ knownObstacle: "fence-192060" }), /request_id_reused_with_different_identity/);
  assert.equal(s.captured.length, 1); assert.equal(Object.hasOwn(s.status(), "knownObstacle"), false);
});

test("known-fence selection does not bypass real readiness gates", t => {
  const s = setup(t); s.prepare({ knownObstacle: "fence-192060" });
  let disposals = 0;
  s.emitSpawn({ testRouteResource: { dispose() { disposals++; } } });
  assert.throws(() => s.control("start"), /not_paused_ready/);
  s.captured[0].lifecycle.onFullData(); assert.throws(() => s.control("start"), /not_paused_ready/);
  s.captured[0].lifecycle.onPaused(); s.control("start");
  assert.equal(s.status().state, "start_requested");
  assert.equal(s.status().knownObstacle, "fence-192060"); s.control("finish"); assert.equal(disposals, 1);
});

for (const ending of ["finish", "timeout", "disconnect", "failure", "server_stop"]) {
  test(`known fence stable route resource is released once on ${ending}`, t => {
    const s = setup(t); let disposals = 0;
    s.prepare({ knownObstacle: "fence-192060" });
    s.emitSpawn({ testRouteResource: { dispose() { disposals++; } } });
    if (ending === "finish") s.control("finish");
    if (ending === "timeout") t.mock.timers.tick(120000);
    if (ending === "disconnect") { delete s.zone._clients[1]; t.mock.timers.tick(100); }
    if (ending === "failure") s.captured[0].lifecycle.onFailure(Error("known route not ready"));
    if (ending === "server_stop") s.controller.dispose();
    assert.equal(disposals, 1); assert.equal(s.status().protectionApplied, false);
    assert.equal(s.zone._npcs.new, undefined); assert.equal(s.status().cleanupError, null);
    assert.equal(s.status().knownObstacle, "fence-192060"); assert.equal(s.status().otherCollisionCoverage, "unknown");
    s.controller.dispose(); assert.equal(disposals, 1);
    assert.equal(s.captured[0].lifecycle.isCurrent(), false); assert.equal(s.captured[0].lifecycle.canStart(), false);
  });
}

test("selected distance is copied into its lease, status and spawn without other recipe changes", t => {
  const s = setup(t); const body = { ...s.prepareBody, distance: 9.5 };
  const first = s.controller.handle(body); body.distance = 12;
  assert.equal(first.distance, 9.5); assert.equal(s.status().distance, 9.5);
  assert.equal(s.captured[0].distance, 9.5); assert.equal(s.captured[0].profileId, 10);
  assert.equal(s.captured[0].noAi, false); assert.equal(s.captured[0].addAiDelayMs, 750);
  assert.equal(s.status().speedScale, 1); assert.equal(first.expiresAt - first.createdAt, 120000);
  assert.throws(() => s.prepare({ requestId: "other", distance: 12 }), /concurrent_replay/);
  s.emitSpawn(); s.ready();
  assert.equal(s.control("finish").distance, 9.5);
  const second = s.prepare({ requestId: "second", expectedNpcCharacterId: null, distance: 12 });
  assert.equal(second.distance, 12); assert.equal(s.captured[1].distance, 12);
  assert.notEqual(second.replayId, first.replayId);
});

test("12-unit source spawn uses the selected corridor endpoint and preserves clock/ground start gates", async t => {
  const s = setup(t, true); const before = Array.from(s.client.character.state.position);
  const npc = await s.sourceSpawn({ distance: 12 });
  const args = s.loadTerrain.mock.calls[0].arguments as any[];
  assert.equal(s.loadTerrain.mock.callCount(), 1);
  assert.deepEqual(Array.from(args[2]), [0, 0]); assert.deepEqual(Array.from(args[3]), [0, 12]);
  assert.equal(npc.state.position[0], 0); assert.equal(npc.state.position[2], 12);
  assert.equal(npc.testChaseSpeedScale, 1); assert.deepEqual(Array.from(s.client.character.state.position), before);
  assert.throws(() => s.control("start"), /not_paused_ready/);
  s.client.testZombieClockReadyAt = Date.now(); s.requestFull(npc); t.mock.timers.tick(750);
  assert.equal(s.status().state, "paused");
  t.mock.timers.tick(1100); s.control("start"); t.mock.timers.tick(100);
  assert.equal(s.status().state, "start_requested"); assert.equal(s.activeAi.has(npc), false);
  s.client.testZombieClockReadyAt = Date.now(); s.client.isInAir = true; t.mock.timers.tick(100);
  assert.equal(s.activeAi.has(npc), false);
  s.client.isInAir = false; t.mock.timers.tick(100);
  assert.equal(s.status().state, "running"); assert.equal(s.activeAi.has(npc), true);
  assert.equal(s.status().distance, 12);
});

test("12-unit paused replay still fails closed when its player backs away before start", t => {
  const s = setup(t); s.prepare({ distance: 12 }); s.emitSpawn(); s.ready();
  s.client.character.state.position[2] -= 0.06;
  assert.throws(() => s.control("start"), /replay_not_current/);
  assert.equal(s.status().reason, "player_moved_before_start"); assert.equal(s.status().distance, 12);
  assert.equal(s.client.character.godMode, false); assert.equal(s.zone._npcs.new, undefined);
  const detail = s.status().prestartPositionFailure;
  assert.equal(detail.observedAt, Date.now()); assert.equal(detail.prepared[2], 0);
  assert.ok(detail.deltaXZ > 0.05 && detail.deltaXZ < 0.061);
  assert.equal(detail.current[2], s.client.character.state.position[2]);
  assert.equal(detail.receipt, null, "no receipt is not replaced by cached data");
});

test("prestart failure records the actual latest receipt without serializing its character reference", t => {
  const s = setup(t); s.prepare({ distance: 12 }); s.emitSpawn(); s.ready();
  s.client.character.state.position[2] -= 0.06;
  s.client.testZombiePositionReceipt = { count: 7, character: s.client.character, playerCharacterId: "player",
    flags: 8191, movementVersion: 4, sequenceTime: 5000, receivedAt: Date.now(),
    position: Object.freeze(Array.from(s.client.character.state.position)), rotation: null, clockAligned: true };
  s.client.character.cycleForTest = s.client.character;
  assert.throws(() => s.control("start"), /replay_not_current/);
  const detail = s.status().prestartPositionFailure;
  assert.equal(detail.receipt.count, 7); assert.equal(detail.receipt.flags, 8191);
  assert.equal(detail.receipt.movementVersion, 4); assert.equal(detail.receipt.sequenceTime, 5000);
  assert.equal(detail.receipt.sameCharacter, true);
  assert.equal(Object.hasOwn(detail.receipt, "character"), false);
  assert.doesNotThrow(() => JSON.stringify(s.status()));
});

test("12-unit lease still expires at 120 seconds without GET renewal", t => {
  const s = setup(t); const first = s.prepare({ distance: 12 }); s.emitSpawn(); s.ready();
  t.mock.timers.tick(119999); assert.equal(s.status().state, "paused");
  assert.equal(s.status().expiresAt, first.createdAt + 120000);
  t.mock.timers.tick(1); assert.equal(s.status().reason, "lease_timeout");
  assert.equal(s.status().distance, 12); assert.equal(s.client.character.godMode, false);
  assert.equal(s.zone._npcs.new, undefined);
});

test("12-unit terrain failure still restores protection and does not replace the old NPC", async t => {
  const s = setup(t, true); s.prepare({ distance: 12 }); t.mock.timers.tick(1);
  s.rejectTerrain(new Error("mock uncovered terrain")); await flush();
  assert.equal(s.status().state, "failed"); assert.equal(s.status().distance, 12);
  assert.equal(s.status().reason, "spawn_or_readiness_failed");
  assert.equal(s.client.character.godMode, false); assert.equal(s.zone._npcs.old, s.old);
  assert.equal(s.zone._npcs.new, undefined); assert.equal(s.zone.addLightweightNpc.mock.callCount(), 0);
});

for (const reason of ["multi", "remote", "stale", "owner", "loading", "uninitialized", "spawnflag", "dead_without_respawn", "mounted"]) {
  test(`prepare refuses ${reason} without mutations`, t => {
    const s = setup(t);
    if (reason === "multi") s.zone._clients[2] = {};
    if (reason === "remote") s.zone._soloMode = false;
    if (reason === "stale") s.zone._lastSpawnedNpcCharacterId = "other";
    if (reason === "owner") s.old.testFullDataOwner = {};
    if (reason === "loading") s.client.isLoading = true;
    if (reason === "uninitialized") s.client.character.initialized = false;
    if (reason === "spawnflag") s.client.testZombieSpawned = false;
    if (reason === "dead_without_respawn") s.client.character.isAlive = false;
    if (reason === "mounted") s.client.vehicle.mountedVehicle = "vehicle";
    assert.throws(s.prepare);
    assert.equal(s.events.length, 0); assert.equal(s.captured.length, 0);
  });
}

test("same-position normal respawn(false) verifies outcome and retains loading/spawn flag", t => {
  const s = setup(t); s.client.character.isAlive = false; s.client.character.isRespawning = true;
  const before = Array.from(s.client.character.state.position);
  const status = s.prepare();
  assert.equal(status.state, "preparing"); assert.equal(s.zone.respawnPlayer.mock.callCount(), 1);
  assert.deepEqual(Array.from(s.client.character.state.position), before);
  assert.equal(s.client.isLoading, true); assert.equal(s.client.testZombieSpawned, true);
  assert.equal(s.client.character.godMode, true);
  assert.equal(s.captured[0].distance, 6); assert.equal(s.captured[0].profileId, 10); assert.equal(s.captured[0].noAi, false);
  s.control("finish"); assert.equal(s.client.character.godMode, false); assert.equal(s.zone._npcs.old, s.old);
});

for (const failure of ["veto", "throw", "position", "setter"]) {
  test(`partial prepare ${failure} restores protection and never schedules spawn`, t => {
    const s = setup(t); s.client.character.isAlive = false; s.client.character.isRespawning = true;
    if (failure === "veto") t.mock.method(s.zone, "respawnPlayer", () => {});
    if (failure === "throw") t.mock.method(s.zone, "respawnPlayer", () => { throw new Error("mock failure"); });
    if (failure === "position") t.mock.method(s.zone, "respawnPlayer", () => { s.client.character.isAlive = true; s.client.character.isRespawning = false; s.client.character.state.position[0] = 5; });
    if (failure === "setter") t.mock.method(s.zone, "setGodMode", (_c: any, mode: boolean) => { s.client.character.godMode = mode; if (mode) throw new Error("mock failure"); });
    assert.throws(s.prepare); assert.equal(s.client.character.godMode, false);
    assert.equal(s.captured.length, 0); assert.equal(s.status().state, "failed"); assert.equal(s.zone._npcs.old, s.old);
  });
}

test("duplicate prepare is idempotent; overlapping lease and stale start are rejected", t => {
  const s = setup(t); const first = s.prepare();
  assert.deepEqual(s.controller.handle(Object.fromEntries(Object.entries(s.prepareBody).reverse())), first);
  assert.equal(s.captured.length, 1);
  assert.throws(() => s.controller.handle({ ...s.prepareBody, requestId: "r2" }));
  assert.throws(() => s.control("start"));
  s.emitSpawn(); s.ready();
  assert.throws(() => s.control("start", { expectedNpcCharacterId: "old" }));
  assert.equal(s.control("start").state, "start_requested");
  assert.equal(s.control("start").state, "start_requested");
});

for (const original of [false, true]) {
  test(`finish clears only owned NPC before restoring raw godMode=${original}`, t => {
    const s = setup(t); s.client.character.godMode = original; s.client.character.tempGodMode = true;
    s.prepare(); const npc = s.emitSpawn(); s.ready(); s.control("finish");
    assert.equal(s.zone._npcs.new, undefined); assert.equal(s.activeAi.has(npc), false);
    assert.equal(s.client.character.godMode, original); assert.equal(s.client.character.tempGodMode, true);
    assert.ok(s.events.indexOf("delete:new") < s.events.lastIndexOf(`god:${original}`));
    const count = s.events.length; s.control("finish"); assert.equal(s.events.length, count);
  });
}

for (const change of ["disconnect", "character", "npc", "multi", "death", "move", "timeout"]) {
  test(`lease ends on ${change}; zero-client cleanup still removes owned AI`, t => {
    const s = setup(t); const originalCharacter = s.client.character; s.prepare(); const npc = s.emitSpawn();
    if (change === "disconnect") delete s.zone._clients[1];
    if (change === "character") s.client.character = { ...originalCharacter, godMode: true, characterId: "replacement" };
    if (change === "npc") { s.zone._lastSpawnedNpcCharacterId = "newer"; s.zone._npcs.newer = { characterId: "newer" }; s.zone._testZombieBySessionId[1] = "newer"; }
    if (change === "multi") s.zone._clients[2] = {};
    if (change === "death") originalCharacter.isAlive = false;
    if (change === "move") originalCharacter.state.position[0] = 1;
    t.mock.timers.tick(change === "timeout" ? 120001 : 101);
    assert.equal(s.status().state, "failed"); assert.equal(originalCharacter.godMode, false);
    assert.equal(s.activeAi.has(npc), false); assert.equal(s.zone._npcs.new, undefined);
    if (change === "npc") { assert.equal(s.zone._npcs.newer.characterId, "newer"); assert.equal(s.zone._lastSpawnedNpcCharacterId, "newer"); assert.equal(s.zone._testZombieBySessionId[1], "newer"); }
    if (change === "character") assert.equal(s.client.character.godMode, true);
  });
}

test("GET is a snapshot, and stale callbacks cannot mutate a subsequent lease", t => {
  const s = setup(t); s.prepare(); s.emitSpawn(); s.ready();
  const oldHooks = s.captured[0].lifecycle; const oldId = s.status().replayId; const expires = s.status().expiresAt;
  t.mock.timers.tick(200); assert.equal(s.status().expiresAt, expires);
  s.control("finish");
  s.controller.handle({ ...s.prepareBody, requestId: "second", expectedNpcCharacterId: null });
  assert.equal(oldHooks.isCurrent(), false); oldHooks.onFailure(new Error("late")); oldHooks.onStarted();
  assert.notEqual(s.status().replayId, oldId); assert.equal(s.status().state, "preparing"); assert.equal(s.client.character.godMode, true);
});

test("lease remains protected at 60 seconds but expires by 120 seconds, without GET renewal", t => {
  const s = setup(t); s.prepare(); s.emitSpawn(); s.ready();
  const expires = s.status().expiresAt;
  assert.equal(expires - s.status().createdAt, 120000);
  t.mock.timers.tick(60001); assert.equal(s.status().state, "paused"); assert.equal(s.client.character.godMode, true);
  assert.equal(s.status().expiresAt, expires);
  t.mock.timers.tick(60000); assert.equal(s.status().state, "failed"); assert.equal(s.status().reason, "lease_timeout");
  assert.equal(s.client.character.godMode, false);
});

test("registry replacement still removes captured AI without deleting the replacement", t => {
  const s = setup(t); s.prepare(); const owned = s.emitSpawn();
  const replacement = { characterId: "new", isAlive: true };
  s.zone._npcs.new = replacement; s.activeAi.add(replacement);
  t.mock.timers.tick(101);
  assert.equal(s.activeAi.has(owned), false); assert.equal(s.activeAi.has(replacement), true);
  assert.equal(s.zone._npcs.new, replacement); assert.equal(s.zone.deleteEntity.mock.callCount(), 0);
  assert.equal(s.client.character.godMode, false);
});

for (const failure of ["remove_ai", "delete", "silent_delete"]) {
  test(`cleanup ${failure} failure retains protection, blocks new replay and allows exact finish retry`, t => {
    const s = setup(t); s.prepare(); const npc = s.emitSpawn();
    const failed = failure === "remove_ai"
      ? t.mock.method(s.zone.aiManager, "removeEntity", () => { throw new Error("mock removal"); })
      : t.mock.method(s.zone, "deleteEntity", () => { if (failure === "delete") throw new Error("mock deletion"); return false; });
    const result = s.control("finish");
    assert.equal(result.state, "failed"); assert.match(result.cleanupError, /protection_retained/);
    assert.equal(result.protectionApplied, true); assert.equal(s.client.character.godMode, true);
    assert.throws(() => s.controller.handle({ ...s.prepareBody, requestId: "second" }));
    failed.mock.restore();
    const retry = s.control("finish");
    assert.equal(retry.cleanupError, null); assert.equal(retry.protectionApplied, false);
    assert.equal(s.client.character.godMode, false); assert.equal(s.zone._npcs.new, undefined); assert.equal(s.activeAi.has(npc), false);
  });
}

for (const cancellation of ["finish", "timeout", "disconnect", "new_npc"]) {
  test(`source terrain completion after ${cancellation} cannot create or replace NPC`, async t => {
    const s = setup(t, true); s.prepare(); t.mock.timers.tick(1);
    if (cancellation === "finish") s.control("finish");
    if (cancellation === "timeout") t.mock.timers.tick(120001);
    if (cancellation === "disconnect") delete s.zone._clients[1];
    if (cancellation === "new_npc") { s.zone._lastSpawnedNpcCharacterId = "newer"; s.zone._npcs.newer = {}; }
    s.complete([]); await flush();
    assert.equal(s.zone.generateGuid.mock.callCount(), 0); assert.equal(s.zone.removeTestZombie.mock.callCount(), 0);
    assert.equal(s.zone.addLightweightNpc.mock.callCount(), 0); assert.equal(s.zone._npcs.old, s.old);
  });
}

test("source lightweight-only spawn never arms without a real request, even past clock timeout", async t => {
  const s = setup(t, true); const npc = await s.sourceSpawn();
  assert.equal(s.zone.addLightweightNpc.mock.callCount(), 1);
  assert.equal(s.zone.sendStandardFullNpcInit.mock.callCount(), 0);
  assert.equal(s.zone.sendData.mock.callCount(), 0);
  for (let i = 0; i < 60; i++) {
    s.client.testZombieClockReadyAt = Date.now();
    t.mock.timers.tick(1000);
  }
  assert.equal(s.status().state, "waiting_full_data");
  assert.equal(s.status().fullDataAt, null); assert.equal(s.status().pausedAt, null);
  assert.equal(s.zone.sendStandardFullNpcInit.mock.callCount(), 0);
  assert.equal(npc.clearMovementController.mock.callCount(), 0);
  assert.equal(s.activeAi.has(npc), false);
  assert.throws(() => s.control("start"), /not_paused_ready/);
  t.mock.timers.tick(60000);
  assert.equal(s.status().state, "failed"); assert.equal(s.status().reason, "lease_timeout");
  assert.equal(s.status().fullDataAt, null); assert.equal(s.client.character.godMode, false);
  assert.equal(s.activeAi.has(npc), false);
});

test("real NPC request sends its reply before one owner-only initialization and readiness arm", async t => {
  const s = setup(t, true); const npc = await s.sourceSpawn();
  assert.equal(s.captured[0].noAi, false, "protected replay is not the idle login preview");
  assert.equal(s.client.character.godMode, true);
  const callback = npc.onReadyCallback;
  const other = { ...s.client }; // Even an equal session number is not the owner object.
  s.requestFull(npc, other);
  assert.equal(s.zone.sendData.mock.calls[0].arguments[0], other);
  assert.equal(s.zone.sendData.mock.calls[0].arguments[1], "LightweightToFullNpc");
  assert.equal(npc.onReadyCallback, callback);
  assert.equal(s.zone.sendStandardFullNpcInit.mock.callCount(), 0);
  assert.equal(s.status().fullDataAt, null);
  const order: string[] = [];
  t.mock.method(s.zone, "sendData", (client: any, name: string) => {
    assert.equal(client, s.client); assert.equal(name, "LightweightToFullNpc");
    assert.equal(s.status().fullDataAt, null); order.push("request-reply");
  });
  t.mock.method(s.zone, "sendStandardFullNpcInit", (client: any, entity: any) => {
    assert.equal(client, s.client); assert.equal(entity, npc);
    assert.equal(s.status().state, "waiting_full_data");
    assert.equal(npc.clearMovementController.mock.callCount(), 0);
    order.push("standard-init");
  });
  s.client.testZombieClockReadyAt = Date.now();
  s.requestFull(npc);
  assert.deepEqual(order, ["request-reply", "standard-init"]);
  assert.equal(npc.onReadyCallback, undefined);
  assert.equal(s.status().state, "waiting_ready");
  const fullDataAt = s.status().fullDataAt;
  t.mock.timers.tick(749); assert.equal(npc.clearMovementController.mock.callCount(), 0);
  t.mock.timers.tick(1); assert.equal(s.status().state, "paused");
  t.mock.method(s.zone, "sendData", () => order.push("duplicate-request-reply"));
  s.requestFull(npc);
  assert.deepEqual(order, ["request-reply", "standard-init", "duplicate-request-reply"]);
  assert.equal(s.zone.sendStandardFullNpcInit.mock.callCount(), 1);
  assert.equal(s.status().fullDataAt, fullDataAt);
  assert.equal(npc.clearMovementController.mock.callCount(), 0);
  assert.equal(npc.sendIdleStance.mock.callCount(), 0);
  assert.equal(s.status().state, "paused");
  assert.equal(s.status().startedAt, null);
  assert.equal(s.activeAi.has(npc), false, "full data and fresh clock do not replace explicit start");
  s.control("start"); t.mock.timers.tick(100);
  assert.equal(s.status().state, "running");
  assert.equal(s.client.character.godMode, true);
  assert.equal(s.activeAi.has(npc), true);
  assert.equal(npc.clearMovementController.mock.callCount(), 1);
  assert.equal(npc.sendIdleStance.mock.callCount(), 1);
  assert.equal(s.zone.aiManager.addEntity.mock.calls.filter((call: any) => call.arguments[0] === npc).length, 2,
    "one constructor registration plus one readiness arm, despite duplicate request");
});

test("prepared hold releases controller, idle and AI exactly once in that order", async t => {
  const s = setup(t, true); const npc = await s.sourceSpawn();
  const order: string[] = [];
  t.mock.method(npc, "clearMovementController", (force: boolean) => { assert.equal(force, true); order.push("clear"); });
  t.mock.method(npc, "sendIdleStance", (prime?: boolean) => { assert.equal(prime, undefined); order.push("idle-unprimed"); });
  t.mock.method(s.zone.aiManager, "addEntity", (entity: any) => { s.activeAi.add(entity); if (entity === npc) order.push("add-ai"); });
  s.client.testZombieClockReadyAt = Date.now(); s.requestFull(npc); t.mock.timers.tick(750);
  assert.equal(s.status().state, "paused"); assert.deepEqual(order, []); assert.equal(s.activeAi.has(npc), false);
  s.control("start"); s.control("start"); t.mock.timers.tick(100);
  assert.equal(s.status().state, "running"); assert.deepEqual(order, ["clear", "idle-unprimed", "add-ai"]);
  s.control("start"); t.mock.timers.tick(1000);
  assert.deepEqual(order, ["clear", "idle-unprimed", "add-ai"]);
});

for (const ending of ["finish", "released-finish", "timeout", "disconnect", "death", "replace-npc"] as const) {
  test(`prepared hold ${ending} never clears the controller or starts AI`, async t => {
    const s = setup(t, true); const npc = await s.sourceSpawn();
    s.client.testZombieClockReadyAt = Date.now(); s.requestFull(npc); t.mock.timers.tick(750);
    assert.equal(s.status().state, "paused");
    const identity = { replayId: s.status().replayId, expectedNpcCharacterId: npc.characterId };
    if (ending === "finish") s.control("finish");
    else if (ending === "released-finish") { s.control("start"); s.control("finish"); }
    else if (ending === "disconnect") delete s.zone._clients[1];
    else if (ending === "death") s.client.character.isAlive = false;
    else if (ending === "replace-npc") s.zone._npcs.new = { characterId: "new", isAlive: true };
    t.mock.timers.tick(ending === "timeout" ? 120000 : 1000);
    assert.equal(npc.clearMovementController.mock.callCount(), 0);
    assert.equal(npc.sendIdleStance.mock.callCount(), 0); assert.equal(s.activeAi.has(npc), false);
    assert.throws(() => s.control("start", identity));
    t.mock.timers.tick(1000);
    assert.equal(npc.clearMovementController.mock.callCount(), 0); assert.equal(npc.sendIdleStance.mock.callCount(), 0);
  });
}

test("unleased legacy full-data arm still hands off without an explicit hold release", t => {
  const s = setup(t);
  const npc: any = { characterId: "legacy", isAlive: true, testServerDrivenMovement: true,
    clearMovementController: t.mock.fn(), sendIdleStance: t.mock.fn() };
  s.zone._npcs.legacy = npc;
  s.helper.armTestZombieOnFullData(s.zone, s.client, npc, { noAi: false, addAiDelayMs: 750, prepareReady: () => true });
  s.client.testZombieClockReadyAt = Date.now(); npc.onReadyCallback(s.client);
  t.mock.timers.tick(749); assert.equal(npc.clearMovementController.mock.callCount(), 0);
  t.mock.timers.tick(1); assert.equal(npc.clearMovementController.mock.callCount(), 1);
  assert.equal(npc.sendIdleStance.mock.callCount(), 1); assert.equal(s.activeAi.has(npc), true);
});

test("saved owner callback from a finished lease cannot send standard initialization", async t => {
  const s = setup(t, true); const npc = await s.sourceSpawn();
  const callback = npc.onReadyCallback;
  s.control("finish"); callback(s.client); t.mock.timers.tick(1000);
  assert.equal(s.zone.sendStandardFullNpcInit.mock.callCount(), 0);
  assert.equal(s.status().fullDataAt, null);
  assert.equal(s.activeAi.has(npc), false);
});

test("source owner/full-data, loading, fresh clock and grounded terrain remain mandatory before pause", async t => {
  const s = setup(t, true); const npc = await s.sourceSpawn();
  assert.equal(s.status().state, "waiting_full_data"); assert.equal(s.activeAi.has(npc), false);
  npc.onReadyCallback({}); t.mock.timers.tick(750); assert.equal(s.status().fullDataAt, null);
  npc.onReadyCallback(s.client); t.mock.timers.tick(750);
  assert.equal(s.status().state, "waiting_ready"); assert.equal(npc.clearMovementController.mock.callCount(), 0);
  s.client.testZombieClockReadyAt = Date.now(); s.client.isLoading = true; t.mock.timers.tick(100);
  assert.equal(npc.clearMovementController.mock.callCount(), 0);
  s.client.isLoading = false; s.client.isInAir = true; t.mock.timers.tick(100);
  assert.equal(npc.clearMovementController.mock.callCount(), 0);
  s.client.isInAir = false; s.client.character.state.position[1] = 10.4; s.client.testZombieClockReadyAt = Date.now(); t.mock.timers.tick(100);
  assert.equal(npc.clearMovementController.mock.callCount(), 0);
  s.client.character.state.position[1] = 10.1; s.client.testZombieClockReadyAt = Date.now(); t.mock.timers.tick(100);
  assert.equal(s.status().state, "paused"); assert.equal(s.status().rendered, "not_observed_by_this_api");
  t.mock.timers.tick(200); assert.equal(npc.clearMovementController.mock.callCount(), 0); assert.equal(npc.sendIdleStance.mock.callCount(), 0);
  assert.equal(s.activeAi.has(npc), false);
  s.control("start"); t.mock.timers.tick(100);
  assert.equal(s.status().state, "running"); assert.equal(s.activeAi.has(npc), true);
  const additions = s.zone.aiManager.addEntity.mock.callCount(); s.control("start"); t.mock.timers.tick(100);
  assert.equal(s.zone.aiManager.addEntity.mock.callCount(), additions);
  assert.equal(npc.clearMovementController.mock.callCount(), 1);
});

test("start release never bypasses a stale clock or newly airborne owner", async t => {
  const s = setup(t, true); const npc = await s.sourceSpawn();
  s.client.testZombieClockReadyAt = Date.now(); npc.onReadyCallback(s.client); t.mock.timers.tick(750);
  assert.equal(s.status().state, "paused");
  t.mock.timers.tick(300); s.control("start"); t.mock.timers.tick(100);
  assert.equal(s.status().state, "start_requested"); assert.equal(s.activeAi.has(npc), false);
  assert.equal(npc.clearMovementController.mock.callCount(), 0); assert.equal(npc.sendIdleStance.mock.callCount(), 0);
  s.client.testZombieClockReadyAt = Date.now(); s.client.isInAir = true; t.mock.timers.tick(100);
  assert.equal(s.activeAi.has(npc), false);
  assert.equal(npc.clearMovementController.mock.callCount(), 0); assert.equal(npc.sendIdleStance.mock.callCount(), 0);
  s.client.isInAir = false; t.mock.timers.tick(100);
  assert.equal(s.status().state, "running"); assert.equal(npc.clearMovementController.mock.callCount(), 1);
});

test("a long prepared pause neither refreshes baseline nor consumes the three-request budget", async t => {
  const s = setup(t, true);
  s.client.testZombieClockResync = { count: 1, requestedAt: 0, requestedVersion: 1 };
  s.client.testZombieMovementVersion = 1;
  s.client.testZombieSynchronization = { count: 1, repliedAt: Date.now() - 600 };
  const originalResync = { ...s.client.testZombieClockResync };
  const npc = await s.sourceSpawn();
  s.helper.recordTestZombieClockSample(s.client, 5000, 5000, 513, 1, 0x400);
  const acceptedAt = s.client.testZombieClockReadyAt;
  npc.onReadyCallback(s.client); t.mock.timers.tick(750);
  assert.equal(s.status().state, "paused");
  const sends = s.zone.sendData.mock.callCount();
  // Longer than the original 30-second clock-warning threshold, below lease bound.
  for (let i = 0; i < 60; i++) {
    // Normal synchronization continues while the player stays still. This makes
    // a refresh eligible, so the test cannot pass merely due to stale sync data.
    s.client.testZombieSynchronization.repliedAt = Date.now() - 600;
    t.mock.timers.tick(1000);
  }
  assert.equal(s.status().state, "paused"); assert.equal(s.activeAi.has(npc), false);
  assert.equal(s.zone.sendData.mock.callCount(), sends);
  assert.deepEqual(s.client.testZombieClockResync, originalResync);
  assert.equal(s.client.testZombieClockReadyAt, acceptedAt, "pause must not synthesize a new clock");
  assert.equal(npc.clearMovementController.mock.callCount(), 0); assert.equal(npc.sendIdleStance.mock.callCount(), 0);
  s.control("start"); t.mock.timers.tick(100);
  assert.equal(s.status().state, "start_requested"); assert.equal(s.activeAi.has(npc), false);
  assert.equal(s.client.testZombieClockResync.count, 2, "explicit release may request the real next baseline");
  assert.equal(s.client.testZombieClockReadyAt, acceptedAt);
  s.helper.recordTestZombieClockSample(s.client, 6000, 6000, 513, 2, 0x400);
  // The unchanged slow clock-wait branch can poll at 1000ms after a long pause.
  t.mock.timers.tick(1000);
  assert.equal(s.status().state, "running"); assert.equal(s.activeAi.has(npc), true);
});

test("two consecutive direct replays each refresh prepare and release without resetting global history", async t => {
  const s = setup(t, true);
  const sync = () => { s.client.testZombieSynchronization = { count: 1, repliedAt: Date.now() - 600 }; };
  const ack = () => s.helper.recordTestZombieClockSample(s.client, 5000, 5000, 8191,
    s.client.testZombieClockResync.requestedVersion, 0x400);
  s.helper.recordTestZombieClockSample(s.client, 900000, 5000, 8191, 0, 0x400);
  t.mock.timers.tick(2000); sync();
  let previousNpc: any;
  let previousCallback: any;
  for (let lease = 0; lease < 2; lease++) {
    const npc = await s.sourceSpawn(lease ? { requestId: "request2", expectedNpcCharacterId: null } : {});
    assert.notEqual(npc, previousNpc);
    const callback = npc.onReadyCallback;
    if (previousCallback) previousCallback(s.client);
    s.requestFull(npc); t.mock.timers.tick(750);
    assert.equal(s.status().state, "waiting_ready");
    assert.equal(s.client.testZombieClockResync.count, lease * 2 + 1, "prepare has this lease's own allowance");
    const pending = s.client.testZombieClockResync;
    callback(s.client); t.mock.timers.tick(100);
    assert.equal(s.client.testZombieClockResync, pending, "duplicate callback cannot send around pending echo");
    ack(); t.mock.timers.tick(100);
    assert.equal(s.status().state, "paused");
    const accepted = s.client.testZombieClockReadyAt;
    t.mock.timers.tick(2100); sync();
    callback(s.client); t.mock.timers.tick(100);
    assert.equal(s.client.testZombieClockResync, pending, "duplicate callback cannot start a second waiter while held");
    s.control("start"); s.control("start"); t.mock.timers.tick(100);
    assert.equal(s.status().state, "start_requested");
    assert.equal(s.client.testZombieClockResync.count, lease * 2 + 2);
    assert.equal(s.client.testZombieClockReadyAt, accepted, "request is not fabricated clock evidence");
    const releasedPending = s.client.testZombieClockResync;
    s.control("start"); callback(s.client); t.mock.timers.tick(100);
    assert.equal(s.client.testZombieClockResync, releasedPending);
    ack(); t.mock.timers.tick(100);
    assert.equal(s.status().state, "running");
    assert.equal(npc.clearMovementController.mock.callCount(), 1);
    assert.equal(npc.sendIdleStance.mock.callCount(), 1);
    assert.equal(s.zone.sendStandardFullNpcInit.mock.callCount(), lease + 1);
    previousNpc = npc; previousCallback = callback;
    s.control("finish"); t.mock.timers.tick(2100); sync();
    previousCallback(s.client);
    assert.equal(s.client.testZombieClockResync, releasedPending, "finished owner cannot request on behalf of the next lease");
  }
  assert.equal(s.client.testZombieClockResync.count, 4);
  assert.equal(s.zone.sendData.mock.calls.filter((c: any) => c.arguments[1] === "ClientUpdate.UpdateLocation").length, 4);
});

test("one owned full-data arm has three requests total despite repeated saved callbacks", async t => {
  const s = setup(t, true);
  s.helper.recordTestZombieClockSample(s.client, 900000, 5000, 8191, 0, 0x400);
  t.mock.timers.tick(2000);
  s.client.testZombieSynchronization = { count: 1, repliedAt: Date.now() - 600 };
  const npc = await s.sourceSpawn(); const callback = npc.onReadyCallback;
  callback(s.client); t.mock.timers.tick(750);
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(s.client.testZombieClockResync.count, attempt);
    s.helper.recordTestZombieClockSample(s.client, 900000, 5000, 8191, attempt, 0x400);
    callback(s.client); callback(s.client);
    s.client.testZombieSynchronization.repliedAt = Date.now() - 600;
    t.mock.timers.tick(2000);
  }
  const pending = s.client.testZombieClockResync;
  callback(s.client); t.mock.timers.tick(2000);
  assert.equal(s.client.testZombieClockResync, pending);
  assert.equal(s.zone.sendData.mock.callCount(), 3);
  assert.equal(s.zone.sendStandardFullNpcInit.mock.callCount(), 1);
  assert.equal(s.status().state, "waiting_ready"); assert.equal(s.activeAi.has(npc), false);
});

test("new direct replay preserves a previous unacknowledged request before using its own allowance", async t => {
  const s = setup(t, true);
  s.helper.recordTestZombieClockSample(s.client, 900000, 5000, 8191, 2, 0x400);
  t.mock.timers.tick(2000);
  const pending = s.client.testZombieClockResync = { count: 3, requestedAt: Date.now() - 1000, requestedVersion: 3 };
  s.client.testZombieSynchronization = { count: 1, repliedAt: Date.now() - 600 };
  const npc = await s.sourceSpawn(); s.requestFull(npc); t.mock.timers.tick(750);
  t.mock.timers.tick(2500);
  const baselines = () => s.zone.sendData.mock.calls.filter((c: any) => c.arguments[1] === "ClientUpdate.UpdateLocation");
  assert.equal(baselines().length, 0, "a new lease cannot skip the previous version even after cooldown");
  assert.equal(s.client.testZombieClockResync, pending);
  assert.equal(s.status().state, "waiting_ready"); assert.equal(s.activeAi.has(npc), false);
  // This real version echo is deliberately misaligned, so it frees the old
  // pending version but is not itself a readiness acknowledgement.
  s.helper.recordTestZombieClockSample(s.client, 900000, 5000, 8191, 3, 0x400);
  t.mock.timers.tick(999); assert.equal(baselines().length, 0);
  t.mock.timers.tick(101);
  assert.equal(baselines().length, 1);
  assert.equal(s.client.testZombieClockResync.count, 4);
  assert.equal(s.client.testZombieClockResync.requestedVersion, 4);
  assert.equal(s.client.testZombieClockReadyAt, undefined);
  assert.equal(s.status().state, "waiting_ready");
  s.helper.recordTestZombieClockSample(s.client, 5000, 5000, 8191, 4, 0x400);
  t.mock.timers.tick(100); assert.equal(s.status().state, "paused");
  s.control("start"); t.mock.timers.tick(100);
  assert.equal(s.status().state, "running"); assert.equal(s.activeAi.has(npc), true);
  assert.equal(baselines().length, 1);
});

test("owned baseline send failure fails the lease once without spending history or retrying", async t => {
  const s = setup(t, true);
  s.helper.recordTestZombieClockSample(s.client, 900000, 5000, 8191, 0, 0x400);
  t.mock.timers.tick(2000);
  s.client.testZombieSynchronization = { count: 1, repliedAt: Date.now() - 600 };
  const npc = await s.sourceSpawn(); const callback = npc.onReadyCallback;
  t.mock.method(s.zone, "sendData", () => { throw Error("baseline transport failed"); });
  callback(s.client); t.mock.timers.tick(750);
  assert.equal(s.status().state, "failed");
  assert.equal(s.client.testZombieClockResync, undefined);
  assert.equal(s.client.testZombieClockReadyAt, undefined);
  assert.equal(s.client.character.godMode, false);
  callback(s.client); t.mock.timers.tick(5000);
  assert.equal(s.zone.sendData.mock.callCount(), 1);
  assert.equal(s.zone.sendStandardFullNpcInit.mock.callCount(), 1);
  assert.equal(s.activeAi.has(npc), false);
});

test("release after a long hold resets the route anchor and its first AI tick only primes", async t => {
  const s = setup(t, true); const npc = await s.sourceSpawn();
  let sequence = 1000;
  const distance = (a: Float32Array, b: Float32Array) => Math.hypot(...[0, 1, 2].map(i => a[i] - b[i]));
  const routeUtils = { getDistance: distance,
    getCurrentServerTimeWrapper: () => ({ getTruncatedU32: () => sequence }),
    // Packet serialization is outside this test; run the real anchor/AI logic.
    createNpcPositionUpdate: (position: Float32Array, sequenceTime: number, _rotation: Float32Array, _chase: boolean, horizontalSpeed: number) =>
      ({ position: Array.from(position), sequenceTime, horizontalSpeed }) };
  const { Npc: RouteNpc } = sourceModule("src/servers/ZoneServer2016/entities/npc.ts", {
    "./basefullcharacter": { BaseFullCharacter: class {} }, "../../../utils/utils": routeUtils,
    "../../../utils/enums": {}, "../models/enums": {}, "../managers/challengemanager": {}, "./projectileentity": {}, "../entities/lootbag": {}
  });
  const { AiManager: RouteAi } = sourceModule("src/servers/ZoneServer2016/managers/aimanager.ts", {
    "../../../utils/utils": routeUtils, "../entities/character": {}, "../entities/explosiveentity": {},
    "../entities/npc": {}, "../entities/trapentity": {}, "../models/enums": { ModelIds: { ZOMBIE_MALE_WALKER: 1 } },
    "../../../utils/recast": {}
  });
  Object.assign(npc, { server: s.zone, actorModelId: 1, movementVersion: 1, behaviorState: 1,
    lastPositionBroadcastTime: 0, testPositionTraceCount: 0 });
  for (const name of ["beginTestRouteMotion", "invalidateTestRouteMotion", "goTo"]) npc[name] = RouteNpc.prototype[name];
  t.mock.method(npc, "sendIdleStance", RouteNpc.prototype.sendIdleStance.bind(npc));
  const send = s.zone.sendDataToAllWithSpawnedEntity = t.mock.fn();
  s.zone.getDevHttpPort = () => 13371;
  s.client.testZombieClockReadyAt = Date.now(); s.requestFull(npc); t.mock.timers.tick(750);
  assert.equal(s.status().state, "paused");
  // A stale anchor must not survive the eventual handoff, even if one existed.
  npc.testRoutePacket = { sequenceTime: sequence, position: [0, 6], movementVersion: 1, ready: true };
  for (let i = 0; i < 60; i++) { sequence += 1000; t.mock.timers.tick(1000); }
  assert.equal(send.mock.callCount(), 0); assert.equal(s.activeAi.has(npc), false);
  s.client.testZombieClockReadyAt = Date.now(); s.control("start"); t.mock.timers.tick(100);
  assert.equal(s.status().state, "running"); assert.equal(send.mock.callCount(), 1);
  assert.equal(npc.testRoutePacket.sequenceTime, sequence); assert.equal(npc.testRoutePacket.ready, false);
  npc.testRouteStep = t.mock.fn((from: Float32Array, _target: Float32Array, budget: number) => new Float32Array([from[0], from[1], from[2] - budget]));
  const position = npc.state.position.slice();
  const move = () => RouteAi.prototype.runOneNpcMove.call({ server: s.zone, getPlayerByCharacterId: () => s.client.character }, npc, false, {});
  move(); assert.deepEqual(npc.state.position, position); assert.equal(send.mock.callCount(), 2);
  assert.equal(npc.testRoutePacket.ready, true); assert.equal(npc.testRoutePacket.sequenceTime, sequence);
  sequence += 100; t.mock.timers.tick(100); move();
  assert.equal(npc.testRouteStep.mock.calls[1].arguments[2], 0.25);
  assert.ok(distance(position, npc.state.position) <= 0.25);
  assert.ok(distance(position, npc.state.position) > 0);
  assert.equal(send.mock.callCount(), 3); assert.equal(npc.testRoutePacket.sequenceTime, sequence);
});

for (const clock of ["fresh", "stale"] as const) {
  test(`global history=3 permits prepare but ${clock} inbound clock alone decides readiness without synchronization evidence`, async t => {
    const s = setup(t, true);
    s.client.testZombieClockResync = { count: 3, requestedAt: 0, requestedVersion: 3 };
    s.client.testZombieMovementVersion = 3;
    const originalResync = { ...s.client.testZombieClockResync };
    const npc = await s.sourceSpawn();
    s.helper.recordTestZombieClockSample(s.client, 5000, 5000, 513, 3, 0x400);
    if (clock === "stale") t.mock.timers.tick(1001);
    npc.onReadyCallback(s.client); t.mock.timers.tick(750);
    if (clock === "fresh") {
      assert.equal(s.status().state, "paused");
      s.control("start"); t.mock.timers.tick(100);
      assert.equal(s.status().state, "running"); assert.equal(s.activeAi.has(npc), true);
    } else {
      assert.equal(s.status().state, "waiting_ready"); assert.equal(s.activeAi.has(npc), false);
      assert.throws(() => s.control("start"), /not_paused_ready/);
      assert.equal(npc.clearMovementController.mock.callCount(), 0);
      for (let i = 0; i < 10; i++) t.mock.timers.tick(1000);
      assert.equal(s.status().state, "waiting_ready"); assert.equal(s.activeAi.has(npc), false);
      assert.equal(s.zone.sendData.mock.callCount(), 0, "missing synchronization evidence still prohibits any baseline request");
      s.helper.recordTestZombieClockSample(s.client, 7000, 7000, 513, 3, 0x400);
      t.mock.timers.tick(100); assert.equal(s.status().state, "paused");
      s.control("start"); t.mock.timers.tick(100);
      assert.equal(s.status().state, "running"); assert.equal(s.activeAi.has(npc), true);
    }
    assert.deepEqual(s.client.testZombieClockResync, originalResync, "never reset global request history when no new request was sent");
  });
}

test("budget=3 and a clock expiring after pause still cannot start until a new valid inbound sample", async t => {
  const s = setup(t, true);
  s.client.testZombieClockResync = { count: 3, requestedAt: 0, requestedVersion: 3 };
  const originalResync = { ...s.client.testZombieClockResync };
  const npc = await s.sourceSpawn();
  s.helper.recordTestZombieClockSample(s.client, 5000, 5000, 513, 3, 0x400);
  npc.onReadyCallback(s.client); t.mock.timers.tick(750);
  assert.equal(s.status().state, "paused");
  t.mock.timers.tick(1100); s.control("start"); t.mock.timers.tick(100);
  assert.equal(s.status().state, "start_requested"); assert.equal(s.activeAi.has(npc), false);
  assert.equal(s.zone.sendData.mock.callCount(), 0);
  // Even a fresh timestamp may not bypass the existing loading/ground gates.
  s.client.isLoading = true;
  s.helper.recordTestZombieClockSample(s.client, 6000, 6000, 513, 3, 0x400);
  t.mock.timers.tick(100); assert.equal(s.activeAi.has(npc), false);
  s.client.isLoading = false; s.client.isInAir = true;
  t.mock.timers.tick(100); assert.equal(s.activeAi.has(npc), false);
  s.client.isInAir = false; t.mock.timers.tick(100);
  assert.equal(s.status().state, "running"); assert.equal(s.activeAi.has(npc), true);
  assert.deepEqual(s.client.testZombieClockResync, originalResync);
});

for (const failure of ["terrain", "send", "clear", "idle"]) {
  test(`source ${failure} failure cancels the lease and restores protection`, async t => {
    const s = setup(t, true);
    if (failure === "send") t.mock.method(s.zone, "sendStandardFullNpcInit", () => { throw new Error("mock send"); });
    s.prepare(); t.mock.timers.tick(1);
    if (failure === "terrain") s.rejectTerrain(new Error("mock decoder failure")); else s.complete([]);
    await flush();
    if (failure === "send") {
      assert.equal(s.status().state, "waiting_full_data");
      assert.equal(s.zone.sendStandardFullNpcInit.mock.callCount(), 0);
      s.requestFull(s.zone._npcs.new);
      assert.equal(s.status().fullDataAt, null);
    }
    if (failure === "clear" || failure === "idle") {
      const npc = s.zone._npcs.new;
      t.mock.method(npc, failure === "clear" ? "clearMovementController" : "sendIdleStance", () => { throw new Error("mock handoff"); });
      s.client.testZombieClockReadyAt = Date.now(); npc.onReadyCallback(s.client); t.mock.timers.tick(750);
      assert.equal(s.status().state, "paused"); assert.equal(s.activeAi.has(npc), false);
      s.control("start"); t.mock.timers.tick(100);
    }
    assert.equal(s.status().state, "failed"); assert.equal(s.client.character.godMode, false); assert.equal(s.zone._npcs.new, undefined);
    if (failure === "terrain") assert.equal(s.zone._npcs.old, s.old);
  });
}

function runningRoute(t: TestContext, resource?: { dispose(): void }) {
  const clock = { now: 1000 };
  const s = setup(t, false, () => clock.now);
  s.prepare();
  const npc = s.emitSpawn({ testServerDrivenMovement: true, behaviorState: 1,
    testRouteStep: () => undefined, testRouteResource: resource });
  s.ready(); s.control("start"); s.captured[0].lifecycle.onStarted();
  assert.equal(s.status().state, "running");
  const tick = (ms: number) => { clock.now += ms; t.mock.timers.tick(ms); };
  return { ...s, npc, clock, tick };
}

test("route resource transfers once, closes before protection restore and cannot be redisposed", t => {
  const s = setup(t); let calls = 0;
  const resource = { dispose() { calls++; s.events.push("dispose-route"); } };
  s.prepare(); s.emitSpawn({ testRouteResource: resource }); s.ready();
  resource.dispose = () => { throw new Error("later method replacement must not be used"); };
  const result = s.control("finish");
  assert.equal(result.cleanupError, null); assert.equal(calls, 1);
  assert.ok(s.events.indexOf("remove-ai:new") < s.events.indexOf("dispose-route"));
  assert.ok(s.events.indexOf("dispose-route") < s.events.lastIndexOf("god:false"));
  s.control("finish"); s.controller.dispose(); assert.equal(calls, 1);
});

for (const ending of ["timeout", "disconnect", "failure", "http_stop"]) {
  test(`route resource is released on ${ending} without changing the lease limit`, t => {
    const s = setup(t); let calls = 0;
    s.prepare(); s.emitSpawn({ testRouteResource: { dispose() { calls++; } } }); s.ready();
    if (ending === "timeout") t.mock.timers.tick(120000);
    if (ending === "disconnect") { delete s.zone._clients[1]; t.mock.timers.tick(100); }
    if (ending === "failure") s.captured[0].lifecycle.onFailure(Error("readiness failed"));
    if (ending === "http_stop") s.controller.dispose();
    assert.equal(calls, 1); assert.equal(s.status().cleanupError, null);
    assert.equal(s.status().protectionApplied, false); assert.equal(s.zone._npcs.new, undefined);
    assert.equal(s.status().expiresAt - s.status().createdAt, 120000);
  });
}

test("resource disposal throw stays failed across finish retries but does not retain unnecessary protection", t => {
  const s = setup(t); let calls = 0;
  s.prepare(); s.emitSpawn({ testRouteResource: { dispose() { calls++; throw Error("partial destructor"); } } });
  const result = s.control("finish");
  assert.equal(result.state, "failed"); assert.match(result.cleanupError, /route_resource_disposal_failed/);
  assert.equal(result.protectionApplied, false); assert.equal(s.client.character.godMode, false);
  assert.equal(s.zone._npcs.new, undefined); assert.equal(calls, 1);
  assert.match(s.control("finish").cleanupError, /route_resource_disposal_failed/); assert.equal(calls, 1);
  assert.throws(() => s.prepare({ requestId: "second", expectedNpcCharacterId: null }), /previous_cleanup_incomplete/);
});

test("NPC removal retry cannot erase an earlier route destructor failure", t => {
  const s = setup(t); let calls = 0;
  s.prepare(); s.emitSpawn({ testRouteResource: { dispose() { calls++; throw Error("partial destructor"); } } });
  const failure = t.mock.method(s.zone, "deleteEntity", () => { throw Error("removal failed"); });
  assert.equal(s.control("finish").protectionApplied, true); assert.equal(calls, 1);
  failure.mock.restore(); const result = s.control("finish");
  assert.equal(result.protectionApplied, false); assert.equal(s.zone._npcs.new, undefined);
  assert.match(result.cleanupError, /route_resource_disposal_failed/); assert.equal(calls, 1);
});

for (const malformed of [null, {}, { get dispose() { throw Error("unreadable disposer"); } }]) {
  test("malformed route ownership cannot be reported as clean", t => {
    const s = setup(t); s.prepare(); s.emitSpawn({ testRouteResource: malformed });
    assert.equal(s.status().reason, "route_resource_invalid");
    assert.match(s.status().cleanupError, /route_resource_disposal_failed/);
    assert.equal(s.zone._npcs.new, undefined); assert.equal(s.status().protectionApplied, false);
    assert.throws(() => s.prepare({ requestId: "second", expectedNpcCharacterId: null }), /previous_cleanup_incomplete/);
  });
}

test("registry and route-resource replacements never transfer foreign disposal ownership", t => {
  const s = setup(t); let owned = 0, foreign = 0;
  s.prepare(); const npc = s.emitSpawn({ testRouteResource: { dispose() { owned++; } } });
  const replacement = { characterId: "new", isAlive: true, testRouteResource: { dispose() { foreign++; } } };
  s.zone._npcs.new = replacement; t.mock.timers.tick(100);
  assert.equal(owned, 1); assert.equal(foreign, 0); assert.equal(s.zone._npcs.new, replacement);
  assert.equal(s.activeAi.has(npc), false);
});

test("changing the resource on the same owned NPC closes and releases only its captured resource", t => {
  const s = setup(t); let owned = 0, foreign = 0;
  s.prepare(); const npc = s.emitSpawn({ testRouteResource: { dispose() { owned++; } } });
  npc.testRouteResource = { dispose() { foreign++; } }; t.mock.timers.tick(100);
  assert.equal(s.status().reason, "route_resource_changed"); assert.equal(owned, 1); assert.equal(foreign, 0);
});

test("blocked running chase closes at three monotonic seconds, removes AI, releases resource and restores protection", t => {
  let disposals = 0;
  const s = runningRoute(t, { dispose() { disposals++; } });
  s.tick(2999); assert.equal(s.status().state, "running");
  s.tick(1); assert.equal(s.status().state, "failed"); assert.equal(s.status().reason, "route_no_progress");
  assert.equal(s.status().cleanupError, null); assert.equal(disposals, 1);
  assert.equal(s.activeAi.has(s.npc), false); assert.equal(s.zone._npcs.new, undefined);
  assert.equal(s.client.character.godMode, false);
});

test("target movement and repeated status GETs cannot reset a stalled chase", t => {
  const s = runningRoute(t);
  for (let i = 0; i < 29; i++) {
    s.client.character.state.position[0] += 0.2; s.status(); s.status(); s.tick(100);
    assert.equal(s.status().state, "running");
  }
  s.client.character.state.position[2] += 4; s.tick(100);
  assert.equal(s.status().reason, "route_no_progress");
});

test("sub-threshold oscillation is not accumulated into fictitious progress", t => {
  const s = runningRoute(t);
  for (let i = 0; i < 30; i++) { s.npc.state.position[0] = i % 2 ? 0.02 : -0.02; s.tick(100); }
  assert.equal(s.status().reason, "route_no_progress");
});

test("real net progress including a detour away from the player keeps the chase active", t => {
  const s = runningRoute(t);
  for (let i = 0; i < 80; i++) {
    // Move sideways/away, not toward the target: target-distance monotonicity is not required.
    s.npc.state.position[0] += 0.02; s.npc.state.position[2] += 0.01; s.tick(100);
    assert.equal(s.status().state, "running");
  }
  assert.equal(s.status().cleanupError, null);
});

test("paused, attack and idle time do not count; resumed chase gets a fresh progress window", t => {
  const clock = { now: 0 }; const s = setup(t, false, () => clock.now);
  s.prepare(); const npc = s.emitSpawn({ testServerDrivenMovement: true, behaviorState: 1, testRouteStep: () => undefined });
  s.ready(); clock.now += 10000; t.mock.timers.tick(10000); assert.equal(s.status().state, "paused");
  s.control("start"); s.captured[0].lifecycle.onStarted();
  clock.now += 2000; t.mock.timers.tick(2000); assert.equal(s.status().state, "running");
  for (const state of [2, 0]) {
    npc.behaviorState = state; clock.now += 10000; t.mock.timers.tick(10000); assert.equal(s.status().state, "running");
  }
  npc.behaviorState = 1; clock.now += 100; t.mock.timers.tick(100);
  clock.now += 2900; t.mock.timers.tick(2900); assert.equal(s.status().state, "running");
  clock.now += 100; t.mock.timers.tick(100); assert.equal(s.status().reason, "route_no_progress");
});

for (const missing of ["server_driven", "route"]) test(`no progress gate does not apply without ${missing}`, t => {
  const s = runningRoute(t);
  if (missing === "server_driven") s.npc.testServerDrivenMovement = false;
  if (missing === "route") s.npc.testRouteStep = undefined;
  s.tick(10000); assert.equal(s.status().state, "running");
});

test("wall-clock correction does not advance the injected monotonic no-progress budget", t => {
  const s = runningRoute(t);
  const wall = Date.now(); t.mock.method(Date, "now", () => wall - 5000);
  t.mock.timers.tick(1000); // Only wall time moves; the scheduled timer queue does not.
  assert.equal(s.status().state, "running");
  s.clock.now += 2999; t.mock.timers.tick(100); assert.equal(s.status().state, "running");
  s.clock.now += 1; t.mock.timers.tick(100); assert.equal(s.status().reason, "route_no_progress");
});

for (const invalid of ["backwards", "nan", "position"]) test(`invalid ${invalid} observation fails closed`, t => {
  const s = runningRoute(t);
  if (invalid === "backwards") s.clock.now -= 1;
  if (invalid === "nan") s.clock.now = NaN;
  if (invalid === "position") s.npc.state.position[0] = NaN;
  t.mock.timers.tick(100);
  assert.equal(s.status().reason, invalid === "position" ? "route_progress_position_invalid" : "route_progress_clock_invalid");
  assert.equal(s.zone._npcs.new, undefined); assert.equal(s.status().protectionApplied, false);
});

test("throwing monotonic clock closes instead of escaping the replay interval", t => {
  const s = setup(t, false, () => { throw Error("clock unavailable"); });
  s.prepare(); s.emitSpawn({ testServerDrivenMovement: true, behaviorState: 1, testRouteStep: () => undefined });
  s.ready(); s.control("start");
  assert.doesNotThrow(() => s.captured[0].lifecycle.onStarted());
  assert.equal(s.status().reason, "route_progress_clock_invalid");
  assert.equal(s.zone._npcs.new, undefined); assert.equal(s.status().protectionApplied, false);
});

function httpSetup(recorder?: object) {
  const calls: any[] = [];
  let scenarioArguments: any[] = [];
  let scenarioActive = false;
  const module = sourceModule("src/servers/ZoneServer2016/managers/devhttpserver.ts", {
    "../test-zombie-scenario": { TestZombieScenario: class {
      constructor(...args: any[]) { scenarioArguments = args; }
      handle() {} isActive() { return scenarioActive; } status() { return { state: "idle" }; } dispose() {}
    } },
    "../test-zombie-recording": { configuredZombieRecorder: () => recorder },
    "../test-zombie-scenes": { ZOMBIE_TEST_SCENES: {} },
    "h1z1-dataschema": {}, "../../../packets/ClientProtocol/ClientProtocol_1080/shared": {},
    "../../../utils/utils": {}, "../../../utils/characterUpdateCharacterStateWire2016": {},
    "../test-zombie-replay": { ...replayModule, TestZombieReplay: class {
      handle(body: any) { calls.push(body); return { state: "preparing" }; }
      getStatus() { return { state: "paused" }; } dispose() { calls.push("dispose"); }
    } },
    "../test-zombie-in-front": {}
  });
  const server = new module.DevHttpServer({}, 13371);
  const request = async (options: any = {}) => {
    const req: any = Object.assign(new EventEmitter(), { method: "POST", url: "/api/npcs/test-replay", headers: { host: "127.0.0.1:13371", "content-type": "application/json" }, resume() {} }, options);
    const result: any = { headers: {} };
    const res: any = { writeHead(status: number, headers: any) { result.status = status; result.headers = headers; }, end(body: string) { result.body = JSON.parse(body); } };
    const pending = server.handleRequest(req, res);
    queueMicrotask(() => { options.beforeBody?.(); req.emit("data", Buffer.from(options.body ?? "{}")); req.emit("end"); });
    await pending;
    return result;
  };
  return { server, calls, request, scenarioArguments, activateScenario: () => { scenarioActive = true; } };
}

test("HTTP test controller passes the explicitly configured recorder without starting it", () => {
  const recorder = { start() { throw Error("must not record at server startup"); } };
  const s = httpSetup(recorder);
  assert.equal(s.scenarioArguments[6], recorder);
  assert.deepEqual(s.scenarioArguments.slice(3, 6), [undefined, undefined, undefined]);
  s.server.stop();
});

test("HTTP cannot start another replay while a slash-command scenario owns the setup", async () => {
  const s = httpSetup(); s.activateScenario();
  const response = await s.request({ body: JSON.stringify({ action: "prepare" }) });
  assert.equal(response.status, 409); assert.equal(response.body.error, "slash_scenario_active_use_ztest_stop");
  assert.equal(s.calls.length, 0);
  assert.equal((await s.request({ method: "GET" })).status, 200);
  s.server.stop();
});

test("a delayed HTTP body cannot steal ownership acquired by a slash command", async () => {
  const s = httpSetup();
  const response = await s.request({ body: JSON.stringify({ action: "prepare" }), beforeBody: s.activateScenario });
  assert.equal(response.status, 409);
  assert.equal(response.body.error, "slash_scenario_active_use_ztest_stop");
  assert.equal(s.calls.length, 0); s.server.stop();
});

test("HTTP replay route is exact, bounded, same-origin and independent of permissive raw API", async () => {
  const s = httpSetup();
  for (const [options, expected] of [
    [{ headers: { host: "evil.example:13371", "content-type": "application/json" } }, 403],
    [{ headers: { host: "127.0.0.1:13371", origin: "https://evil.example", "content-type": "application/json" } }, 403],
    [{ headers: { host: "127.0.0.1:13371", "content-type": "text/plain" } }, 415],
    [{ method: "OPTIONS" }, 405], [{ url: "/api/npcs/test-replay?unknown=1" }, 400],
    [{ body: "x" }, 400], [{ body: "a".repeat(4097) }, 413]
  ] as const) assert.equal((await s.request(options)).status, expected);
  assert.equal(s.calls.length, 0);
  const get = await s.request({ method: "GET" }); assert.equal(get.body.state, "paused"); assert.equal(s.calls.length, 0);
  assert.equal(get.headers["Access-Control-Allow-Origin"], undefined);
  assert.equal((await s.request({ body: JSON.stringify({ action: "prepare" }) })).status, 200);
  assert.equal(JSON.stringify(s.calls), JSON.stringify([{ action: "prepare" }])); s.server.stop(); assert.equal(s.calls[1], "dispose");
});
