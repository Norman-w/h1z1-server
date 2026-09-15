import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { recordTestZombiePositionReceipt } from "../src/servers/ZoneServer2016/test-zombie-position-receipt";

// The changed handler and clock/baseline helpers execute directly from source.
// Only the unchanged packet codec is loaded from out; no server is constructed.
const { H1Z1Protocol } = require("../out/protocols/h1z1protocol");
const { packPositionUpdateData } = require("../out/packets/ClientProtocol/ClientProtocol_1080/shared");
const protocol = new H1Z1Protocol("ClientProtocol_1080");

function sourceFile(relative: string) {
  const filename = path.resolve(relative);
  return ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
}

function executeSource(code: string, bindings: Record<string, any>) {
  const result = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true
  });
  assert.deepEqual(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error), []);
  const module = { exports: {} };
  vm.runInNewContext(result.outputText, { module, exports: module.exports, Float32Array,
    console: { log() {} }, get Date() { return Date; }, ...bindings });
  return module.exports as any;
}

const helperFile = sourceFile("src/servers/ZoneServer2016/test-zombie-in-front.ts");
const helperNames = ["recordTestZombieClockSample", "requestTestZombieClockBaseline"];
const helperNodes = helperFile.statements.filter(node => ts.isFunctionDeclaration(node) &&
  node.name && helperNames.includes(node.name.text));
assert.equal(helperNodes.length, 2);
const helpers = executeSource(helperNodes.map(node => node.getText(helperFile)).join("\n"), {});
const handlerFile = sourceFile("src/servers/ZoneServer2016/zonepackethandlers.ts");
const handlerClass = handlerFile.statements.find(node => ts.isClassDeclaration(node) &&
  node.name?.text === "ZonePacketHandlers") as ts.ClassDeclaration;
assert.ok(handlerClass);
const handlerMethod = handlerClass.members.find(node => ts.isMethodDeclaration(node) &&
  node.name.getText(handlerFile) === "PlayerUpdatePosition");
assert.ok(handlerMethod);
const { Subject } = executeSource(`export class Subject { ${handlerMethod.getText(handlerFile)} }`, {
  recordTestZombieClockSample: helpers.recordTestZombieClockSample,
  recordTestZombiePositionReceipt,
  _: { size: (value: any) => value == null ? 0 : Array.isArray(value) ? value.length : Object.keys(value).length },
  getCurrentServerTimeWrapper: () => ({ getTruncatedU32: () => 5000 })
});

function fixture() {
  const oldRotation = new Float32Array([0, -Math.SQRT1_2, 0, Math.SQRT1_2]);
  const position = new Float32Array([10, 20, 30, 1]);
  const client: any = { sessionId: 1, testZombieSpawned: true, isLoading: false,
    isInAir: false, vehicle: {}, blockedPositionUpdates: 7,
    character: { isAlive: true, isRespawning: false, isMoving: false, tempGodMode: true,
      resourceHudIndicators: ["unchanged"], state: { position, rotation: oldRotation,
        lookAt: oldRotation, yaw: -Math.PI / 2 } } };
  const raw = packPositionUpdateData({ sequenceTime: 5000, unknown3_int8: 1,
    stance: 0x400, rotationRaw: [Math.PI / 2, 0, 0, 0] });
  const packet = protocol.parse(raw, 2);
  assert.equal(packet.data.flags, 513);
  const server = new Proxy({}, { get(_target, name) {
    throw new Error(`stance-only path entered gameplay server access: ${String(name)}`);
  } });
  const receive = (data = packet.data) => Subject.prototype.PlayerUpdatePosition.call({}, server, client, { data });
  const assertNoGameplay = () => {
    assert.equal(client.character.tempGodMode, true);
    assert.equal(client.character.state.position, position);
    assert.equal(client.character.positionUpdate, undefined);
    assert.equal(client.blockedPositionUpdates, 7);
    assert.deepEqual(client.character.resourceHudIndicators, ["unchanged"]);
  };
  return { client, packet, receive, oldRotation, assertNoGameplay };
}

test("source flags0x201 saves the parsed facing and clock without gameplay side effects", () => {
  const s = fixture(); s.receive();
  assert.equal(s.client.testZombieClockDiagnostics.lastResult, "aligned");
  assert.equal(s.client.testZombieMovementVersion, 1);
  assert.equal(s.client.character.state.rotation, s.packet.data.rotation);
  assert.equal(s.client.character.state.lookAt, s.packet.data.lookAt);
  assert.equal(s.client.character.state.yaw, s.packet.data.rotationRaw[0]);
  assert.notDeepEqual(Array.from(s.client.character.state.rotation), Array.from(s.oldRotation));
  s.assertNoGameplay();
});

for (const condition of ["dead", "respawning", "missing_character"] as const) {
  test(`source flags0x201 does not save facing for ${condition}`, () => {
    const s = fixture(); const character = s.client.character;
    if (condition === "dead") character.isAlive = false;
    if (condition === "respawning") character.isRespawning = true;
    if (condition === "missing_character") delete s.client.character;
    s.receive();
    assert.equal(character.state.rotation, s.oldRotation);
    assert.equal(character.state.lookAt, s.oldRotation);
    assert.equal(character.state.yaw, -Math.PI / 2);
  });
}

test("source invalid or incomplete rotation triplet cannot partially overwrite facing", () => {
  const invalid = [undefined, null, {}, { 0: 0, 1: 0, 2: 0, 3: 1, length: 4 },
    [0, 0, 0], [0, 0, 0, 1, 0], [0, 0, NaN, 1], [0, Infinity, 0, 1],
    [0, -Infinity, 0, 1], ["0", 0, 0, 1], new Array(4),
    new Float32Array([0, 0, NaN, 1])];
  for (const field of ["rotation", "lookAt", "rotationRaw"]) {
    for (const value of invalid) {
      const s = fixture(); s.receive({ ...s.packet.data, [field]: value });
      assert.equal(s.client.character.state.rotation, s.oldRotation, field);
      assert.equal(s.client.character.state.lookAt, s.oldRotation, field);
      assert.equal(s.client.character.state.yaw, -Math.PI / 2, field);
      s.assertNoGameplay();
    }
  }
});

test("source parse-error, zero flags and absent packet data still reject facing updates", () => {
  for (const variant of ["parse_error", "zero_flags", "null", "undefined"] as const) {
    const s = fixture();
    if (variant === "parse_error") s.receive({ ...s.packet.data, parseError: "bad packet" });
    if (variant === "zero_flags") s.receive({ ...s.packet.data, flags: 0 });
    if (variant === "null") s.receive(null);
    if (variant === "undefined") Subject.prototype.PlayerUpdatePosition.call({}, {}, s.client, { data: undefined });
    assert.equal(s.client.character.state.rotation, s.oldRotation);
    assert.equal(s.client.character.state.lookAt, s.oldRotation);
    assert.equal(s.client.character.state.yaw, -Math.PI / 2);
    s.assertNoGameplay();
  }
});

test("source baseline converts latest stance quaternion to horizontal direction, retaining version and request limits", t => {
  t.mock.timers.enable({ apis: ["Date"], now: 10000 });
  const s = fixture(); s.receive();
  s.client.testZombieSynchronization = { count: 1, repliedAt: 9000 };
  const sends: any[] = [];
  const server = { _clients: { 1: s.client }, sendData: (...args: any[]) => sends.push(args) };
  assert.equal(helpers.requestTestZombieClockBaseline(server, s.client), false, "recent traffic is still gated");
  t.mock.timers.tick(2000);
  assert.equal(helpers.requestTestZombieClockBaseline(server, s.client), true);
  assert.equal(sends.length, 1);
  const [, name, payload] = sends[0];
  assert.equal(name, "ClientUpdate.UpdateLocation");
  const expectedDirection = new Float32Array([
    Math.sin(s.packet.data.rotationRaw[0]), 0, Math.cos(s.packet.data.rotationRaw[0]), 0
  ]);
  Array.from(payload.rotation as Float32Array).forEach((value, i) =>
    assert.ok(Math.abs(value - expectedDirection[i]) < 2e-6));
  assert.notDeepEqual(Array.from(payload.rotation), Array.from(s.packet.data.rotation));
  assert.equal(payload.unknownBoolean1, true);
  assert.equal(payload.unknownByte1, 2);
  assert.equal(payload.triggerLoadingScreen, false);
  const wire = protocol.pack(name, payload);
  assert.equal(wire.length, 38);
  assert.deepEqual([0, 1, 2, 3].map(i => wire.readFloatLE(19 + i * 4)), Array.from(payload.rotation));
  assert.equal(wire.readFloatLE(23), 0);
  assert.equal(wire.readFloatLE(31), 0);
  assert.equal(helpers.requestTestZombieClockBaseline(server, s.client), false, "no duplicate unacknowledged version");
  assert.equal(s.client.testZombieClockResync.count, 1);
  assert.equal(s.client.testZombieClockReadyAt, 10000, "outbound request is never clock evidence");
  s.assertNoGameplay();
});

function baselineFixture(t: TestContext, rotation: any) {
  t.mock.timers.enable({ apis: ["Date"], now: 10000 });
  const s = fixture(); s.receive();
  s.client.testZombieSynchronization = { count: 1, repliedAt: 9000 };
  t.mock.timers.tick(2000);
  s.client.character.state.rotation = rotation;
  const state = s.client.character.state;
  const snapshot = { position: Array.from(state.position), rotation: rotation == null ? rotation : Array.from(rotation),
    lookAt: Array.from(state.lookAt), yaw: state.yaw };
  const diagnostics = { ...s.client.testZombieClockDiagnostics };
  const sends: any[] = [];
  const server = { _clients: { 1: s.client }, sendData: (...args: any[]) => sends.push(args) };
  const request = () => helpers.requestTestZombieClockBaseline(server, s.client);
  const unchanged = () => {
    assert.equal(s.client.character.state, state);
    assert.equal(state.rotation, rotation);
    assert.deepEqual(Array.from(state.position), snapshot.position);
    assert.deepEqual(rotation == null ? rotation : Array.from(rotation), snapshot.rotation);
    assert.deepEqual(Array.from(state.lookAt), snapshot.lookAt);
    assert.equal(state.yaw, snapshot.yaw);
    assert.deepEqual({ ...s.client.testZombieClockDiagnostics }, diagnostics);
    assert.equal(s.client.testZombieClockReadyAt, 10000);
    assert.equal(s.client.testZombieMovementVersion, 1);
    s.assertNoGameplay();
  };
  return { ...s, sends, request, unchanged };
}

for (const [name, quaternion, expected] of [
  ["+Z", [0, 0, 0, 1], [0, 0, 1, 0]],
  ["+X", [0, Math.SQRT1_2, 0, Math.SQRT1_2], [1, 0, 0, 0]],
  ["-Z", [0, 1, 0, 0], [0, 0, -1, 0]],
  ["-X", [0, -Math.SQRT1_2, 0, Math.SQRT1_2], [-1, 0, 0, 0]],
  ["nonunit", [0, 7, 0, 7], [1, 0, 0, 0]],
  ["negative quaternion", [0, -7, 0, -7], [1, 0, 0, 0]],
  ["tiny nonzero quaternion", [0, 1e-30, 0, 1e-30], [1, 0, 0, 0]],
  ["large finite quaternion", [0, 1e30, 0, 1e30], [1, 0, 0, 0]],
  ["pitched +X", [0.2705980500730985, 0.6532814824381882, -0.2705980500730985, 0.6532814824381882], [1, 0, 0, 0]]
] as const) {
  test(`source baseline wire forward ${name} preserves quaternion state and 38-byte packet`, t => {
    const s = baselineFixture(t, new Float32Array(quaternion));
    assert.equal(s.request(), true); assert.equal(s.sends.length, 1);
    const [, packetName, payload] = s.sends[0];
    const direction = Array.from(payload.rotation as Float32Array);
    direction.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 2e-6));
    assert.equal(direction[1], 0); assert.equal(direction[3], 0);
    assert.ok(Math.abs(Math.hypot(direction[0], direction[2]) - 1) < 2e-6);
    assert.equal(payload.unknownBoolean1, true); assert.equal(payload.unknownByte1, 2);
    assert.equal(payload.triggerLoadingScreen, false);
    const wire = protocol.pack(packetName, payload);
    assert.equal(wire.length, 38);
    assert.equal(wire.subarray(0, 3).toString("hex"), "110a00");
    assert.deepEqual([0, 1, 2, 3].map(i => wire.readFloatLE(19 + i * 4)), direction);
    assert.deepEqual([0, 1, 2, 3].map(i => wire.readFloatLE(3 + i * 4)), Array.from(s.client.character.state.position));
    assert.deepEqual(Array.from(wire.subarray(35)), [1, 2, 0]);
    assert.equal(s.client.testZombieClockResync.count, 1);
    assert.equal(s.request(), false); assert.equal(s.sends.length, 1);
    s.unchanged();
  });
}

function positionPacket(sequenceTime: number, movementVersion: number, position = [10, 20, 30]) {
  const raw = packPositionUpdateData({ sequenceTime, unknown3_int8: movementVersion,
    stance: 0, position, orientation: 0, frontTilt: 0, sideTilt: 0, angleChange: 0,
    verticalSpeed: 0, horizontalSpeed: 0, unknown12_float: [0, 0, 0], rotationRaw: [0, 0, 0, 0],
    direction: 0, engineRPM: 0, PosAndRot: [0, 0, 0, 0, 0, 0, 0, 0] });
  const packet = protocol.parse(raw, 2);
  assert.equal(packet.name, "PlayerUpdatePosition"); assert.equal(packet.data.flags, 8191);
  assert.equal(packet.data.parseError, undefined);
  return packet;
}

function fullPositionFixture() {
  const s = fixture();
  s.client.isSynced = true; s.client.avgPing = 0;
  s.client.character.characterId = "player"; s.client.character.tempGodMode = false;
  s.client.character.checkCurrentInteractionGuid = () => {};
  const receivePacket = (packet: any) => Subject.prototype.PlayerUpdatePosition.call({}, {}, s.client, packet);
  return { ...s, receivePacket };
}

test("real full-position wire reaches source handler and records the newly applied packet without retaining arrays", t => {
  t.mock.timers.enable({ apis: ["Date"], now: 10000 });
  const s = fullPositionFixture(), packet = positionPacket(5000, 2, [1.23, 4.56, 7.89]);
  s.receivePacket(packet);
  const receipt = s.client.testZombiePositionReceipt;
  assert.ok(receipt); assert.equal(receipt.character, s.client.character);
  assert.equal(receipt.movementVersion, 2); assert.equal(receipt.flags, 8191);
  assert.equal(receipt.receivedAt, 10000); assert.equal(receipt.count, 1);
  assert.deepEqual(receipt.position, packet.data.position);
  assert.deepEqual(receipt.rotation, Array.from(packet.data.rotation));
  assert.equal(s.client.character.state.position, packet.data.position);
  const saved = [...receipt.position]; packet.data.position[0] = 999;
  assert.deepEqual(receipt.position, saved);
});

test("real stance/rotation and unrelated delta packets cannot reuse merged position as a new receipt", () => {
  const s = fullPositionFixture(); s.receivePacket(positionPacket(5000, 2));
  const receipt = s.client.testZombiePositionReceipt;
  for (const data of [
    { sequenceTime: 5001, unknown3_int8: 2, stance: 0x400, rotationRaw: [0.1, 0, 0, 0] },
    { sequenceTime: 5002, unknown3_int8: 2, direction: 0.2 }
  ]) {
    const packet = protocol.parse(packPositionUpdateData(data), 2);
    assert.equal(packet.data.position, undefined);
    s.receivePacket(packet);
    assert.equal(s.client.testZombiePositionReceipt, receipt);
  }
  assert.deepEqual(s.client.character.positionUpdate.position, [...receipt.position], "merged cache still has old position, intentionally not used");
});

test("source handler does not claim a stale, duplicate or misaligned position as a new receipt", () => {
  const s = fullPositionFixture(); s.receivePacket(positionPacket(5000, 2));
  const receipt = s.client.testZombiePositionReceipt;
  for (const sequence of [4999, 5000, 9000]) {
    s.receivePacket(positionPacket(sequence, 2, [11, 20, 30]));
    assert.equal(s.client.testZombiePositionReceipt, receipt);
  }
  assert.deepEqual(s.client.character.state.position, [11, 20, 30, 1],
    "existing gameplay code may apply a packet; observer never promotes it to fresh evidence");
});

test("real parse failure and no-position packets cannot create a first receipt", () => {
  const s = fullPositionFixture();
  s.receivePacket({ data: { flags: 8191, sequenceTime: 5000, unknown3_int8: 2,
    position: [1, 2, 3, 1], parseError: "truncated" } });
  assert.equal(s.client.testZombiePositionReceipt, undefined);
  s.receivePacket(s.packet);
  assert.equal(s.client.testZombiePositionReceipt, undefined);
});

for (const [name, rotation] of [
  ["zero norm", [0, 0, 0, 0]], ["NaN", [NaN, 0, 0, 1]],
  ["Infinity", [0, Infinity, 0, 1]], ["negative Infinity", [0, 0, -Infinity, 1]],
  ["missing", undefined], ["null", null], ["short", [0, 0, 1]],
  ["vertical +Y", [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]],
  ["vertical -Y", [Math.SQRT1_2, 0, 0, Math.SQRT1_2]],
  ["near-vertical unstable projection", [Math.sin((Math.PI / 2 - 1e-8) / 2), 0, 0, Math.cos((Math.PI / 2 - 1e-8) / 2)]]
] as const) {
  test(`source baseline refuses ${name} without sending or consuming budget`, t => {
    const s = baselineFixture(t, rotation == null ? rotation : new Float32Array(rotation));
    assert.equal(s.request(), false); assert.equal(s.request(), false);
    assert.equal(s.sends.length, 0); assert.equal(s.client.testZombieClockResync, undefined);
    s.unchanged();
  });
}
