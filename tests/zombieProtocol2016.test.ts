import assert from "node:assert/strict";
import test from "node:test";
import { H1Z1Protocol } from "../../h1z1-server";

const protocol = new H1Z1Protocol("ClientProtocol_1080");
const characterId = "0x0102030405060708";
const targetCharacterId = "0x1112131415161718";

test("stance-and-rotation position updates preserve their real clock header", () => {
  // uint16 flags, uint32 clock, uint8 version, packed stance and four packed rotations.
  const raw = Buffer.alloc(12);
  raw.writeUInt16LE(0x201, 0);
  raw.writeUInt32LE(0x12345678, 2);
  const parsed = protocol.parsePlayerUpdatePosition(raw, 0).result;
  assert.equal(parsed.flags, 513);
  assert.equal(parsed.sequenceTime, 0x12345678);
  assert.equal(parsed.stance, 0);
  assert.deepEqual(parsed.rotationRaw, [0, 0, 0, 0]);
  assert.equal(parsed.position, undefined);
  const routed = protocol.parse(raw, 2);
  assert.equal(routed?.name, "PlayerUpdatePosition");
  assert.equal((routed?.data as any).sequenceTime, 0x12345678);
});

test("truncated stance-and-rotation data cannot masquerade as a valid clock packet", (t) => {
  t.mock.method(console, "error", () => {});
  const raw = Buffer.alloc(7);
  raw.writeUInt16LE(0x201, 0);
  raw.writeUInt32LE(0x12345678, 2);
  const parsed = protocol.parsePlayerUpdatePosition(raw, 0).result;
  assert.equal(parsed.sequenceTime, 0);
  assert.equal(parsed.flags, 0);
  assert.equal(parsed.parseError, true);
});

test("stance-only channel packets acknowledge time without applying gameplay updates", (t) => {
  const { ZonePacketHandlers } = require("../out/servers/ZoneServer2016/zonepackethandlers");
  const { getCurrentServerTimeWrapper } = require("../out/utils/utils");
  const raw = Buffer.alloc(12);
  raw.writeUInt16LE(0x201, 0);
  raw.writeUInt32LE(getCurrentServerTimeWrapper().getTruncatedU32(), 2);
  const packet = protocol.parse(raw, 2);
  const client: any = { testZombieSpawned: true };
  // No server or character methods are supplied: stance-only gameplay stays excluded.
  ZonePacketHandlers.prototype.PlayerUpdatePosition({}, client, packet);
  assert.equal(client.testZombieClockDiagnostics.lastResult, "aligned");
  assert.equal(client.testZombieClockDiagnostics.stanceRotationSamples, 1);
  assert.equal(typeof client.testZombieClockReadyAt, "number");
  t.mock.method(console, "error", () => {});
  const malformed = protocol.parse(raw.subarray(0, 7), 2);
  const invalidClient: any = { testZombieSpawned: true };
  ZonePacketHandlers.prototype.PlayerUpdatePosition({}, invalidClient, malformed);
  assert.equal(invalidClient.testZombieClockReadyAt, undefined);
  assert.equal(invalidClient.testZombieClockDiagnostics.lastResult, "invalid");
});

test("clock status reports absence and rejection reasons without altering state", async (t) => {
  const { DevHttpServer } = require("../out/servers/ZoneServer2016/managers/devhttpserver");
  t.mock.timers.enable({ apis: ["Date"], now: 5000 });
  const client = { character: { characterId, isAlive: true, isRespawning: false },
    testZombieSpawned: true, isLoading: false, isSynced: true,
    testZombieClockReadyAt: undefined as number | undefined,
    testZombieClockDiagnostics: undefined as object | undefined };
  const api = new DevHttpServer({ _clients: { 1: client } }, 0);
  const reply = t.mock.method(api, "sendJson", () => {});
  api.handleApiNpcClockStatus({});
  assert.equal(reply.mock.calls[0].arguments[2].clients[0].samples, null);
  assert.equal(reply.mock.calls[0].arguments[2].clients[0].acceptedClockAgeMs, null);
  client.testZombieClockReadyAt = 4500;
  client.testZombieClockDiagnostics = { samples: 3, lastResult: "misaligned", lastDeltaMs: 900 };
  api.handleApiNpcClockStatus({});
  assert.equal(reply.mock.calls[1].arguments[2].clients[0].acceptedClockAgeMs, 500);
  assert.deepEqual(reply.mock.calls[1].arguments[2].clients[0].samples, client.testZombieClockDiagnostics);
  assert.equal(client.testZombieClockReadyAt, 4500);
});

test("clock status copies current server pose without claiming a native measurement", (t) => {
  const { DevHttpServer } = require("../out/servers/ZoneServer2016/managers/devhttpserver");
  t.mock.timers.enable({ apis: ["Date"], now: 5000 });
  const state = { position: new Float32Array([1, 2, 3, 1]), rotation: new Float32Array([0, 0, 0, 1]) };
  const client = { character: { characterId, state }, testZombieClockReadyAt: 4500 };
  const api = new DevHttpServer({ _clients: { 1: client } }, 0);
  const reply = t.mock.method(api, "sendJson", () => {});
  api.handleApiNpcClockStatus({});
  const first = reply.mock.calls[0].arguments[2];
  assert.equal(first.observedAt, 5000);
  assert.equal(first.clients[0].poseSource, "server_character_state_not_native_measurement");
  assert.deepEqual(first.clients[0].serverPosition, [1, 2, 3, 1]);
  assert.deepEqual(first.clients[0].serverRotation, [0, 0, 0, 1]);
  first.clients[0].serverRotation[3] = 2;
  assert.equal(state.rotation[3], 1);
  state.position[0] = 7;
  api.handleApiNpcClockStatus({});
  assert.deepEqual(first.clients[0].serverPosition, [1, 2, 3, 1]);
  assert.deepEqual(reply.mock.calls[1].arguments[2].clients[0].serverPosition, [7, 2, 3, 1]);
  assert.equal(client.testZombieClockReadyAt, 4500);
});

test("clock status represents absent or invalid server pose as unknown, not zero", (t) => {
  const { DevHttpServer } = require("../out/servers/ZoneServer2016/managers/devhttpserver");
  const client: any = { character: { characterId } };
  const api = new DevHttpServer({ _clients: { 1: client } }, 0);
  const reply = t.mock.method(api, "sendJson", () => {});
  for (const state of [undefined, {},
    { position: new Float32Array([1, 2]), rotation: new Float32Array([0, 0, 1]) },
    { position: new Float32Array([1, NaN, 3, 1]), rotation: new Float32Array([0, Infinity, 0, 1]) },
    { position: new Float32Array([1, 2, 3, NaN]), rotation: new Float32Array([0, 0, 0, 1, 2]) }]) {
    client.character.state = state;
    api.handleApiNpcClockStatus({});
    const result = reply.mock.calls[reply.mock.calls.length - 1].arguments[2].clients[0];
    assert.equal(result.serverPosition, null);
    assert.equal(result.serverRotation, null);
  }
  client.character.state = { position: new Float32Array([1, 2, 3]) };
  api.handleApiNpcClockStatus({});
  assert.deepEqual(reply.mock.calls[reply.mock.calls.length - 1].arguments[2].clients[0].serverPosition, [1, 2, 3]);
});

test("zone channel ingress counts malformed clocks without broadcasting them", (t) => {
  const { ZoneServer2016 } = require("../out/servers/ZoneServer2016/zoneserver");
  const { ZonePacketHandlers } = require("../out/servers/ZoneServer2016/zonepackethandlers");
  const { getCurrentServerTimeWrapper } = require("../out/utils/utils");
  const broadcast = t.mock.fn();
  const handler = t.mock.fn((server: any, client: any, packet: any) =>
    ZonePacketHandlers.prototype.PlayerUpdatePosition(server, client, packet));
  const server = { _characters: {}, _packetHandlers: { processPacket: handler },
    sendRawToAllOthersWithSpawnedCharacter: broadcast };
  const client: any = { testZombieSpawned: true, character: { characterId } };
  t.mock.method(console, "error", () => {});
  const malformed = Buffer.alloc(7);
  malformed.writeUInt16LE(513, 0);
  const brokenPacket = protocol.parse(malformed, 2);
  ZoneServer2016.prototype.onZoneDataEvent.call(server, client, brokenPacket);
  assert.equal(client.testZombieClockDiagnostics.invalid, 1);
  assert.equal(client.testZombieClockReadyAt, undefined);
  const empty = Buffer.alloc(7);
  empty.writeUInt32LE(getCurrentServerTimeWrapper().getTruncatedU32(), 2);
  ZoneServer2016.prototype.onZoneDataEvent.call(server, client, protocol.parse(empty, 2));
  assert.equal(client.testZombieClockDiagnostics.aligned, 1);
  assert.equal(handler.mock.callCount(), 2);
  assert.equal(broadcast.mock.callCount(), 0);
});

test("profile definition cache sends the actual records instead of an empty table", () => {
  const { ZoneServer2016 } = require("../out/servers/ZoneServer2016/zoneserver");
  const definitions = require("../data/2016/dataSources/ServerProfileDefinitions.json");
  const server = { _protocol: protocol, profileDefinitionsCache: undefined as Buffer | undefined };
  ZoneServer2016.prototype.packProfileDefinitions.call(server);
  const packet = server.profileDefinitionsCache;
  assert.ok(packet);
  assert.equal(packet.subarray(0, 2).toString("hex"), "1703");
  assert.equal(packet.readUInt32LE(2), definitions.profiles.length);
  assert.ok(definitions.profiles.length > 0);
  const parsed = protocol.parse(packet, 0);
  assert.equal(parsed?.name, "ReferenceData.ProfileDefinitions");
  // The mixed source JSON has an extra unknownDword20 in some records.
  // Native140998e30 ends after unknownDword19; do not add a wire field for it.
  const expected = { profiles: definitions.profiles.map((entry: any) => {
    const { unknownDword20: _sourceOnly, ...profileData } = entry.profileData;
    return { ID: entry.ID, profileData };
  }) };
  assert.deepEqual(parsed?.data, expected);
  // Native140998e30 sign-extends the byte after three dwords into record+0xc;
  // that value, not the profile record ID, is tested for type11/22..24.
  const firstCapsuleProfile = definitions.profiles.find((entry: any) => entry.profileData.unknownByte1 === 11);
  assert.ok(firstCapsuleProfile);
  assert.notEqual(firstCapsuleProfile.ID, 11);
});

test("last-test diagnostics identify the transient id and label positions as server state", async (t) => {
  const { DevHttpServer } = require("../out/servers/ZoneServer2016/managers/devhttpserver");
  const npc = { transientId: 123, state: {
    position: new Float32Array([1, 2, 3]),
    rotation: new Float32Array([0, 0, 0, 1])
  } };
  const api = new DevHttpServer({ _lastSpawnedNpcCharacterId: characterId, _npcs: { [characterId]: npc } }, 0);
  const reply = t.mock.method(api, "sendJson", () => {});
  await api.handleApiNpcsLastTest({});
  assert.deepEqual(reply.mock.calls[0].arguments[2], {
    lastSpawnedCharacterId: characterId, transientId: 123,
    serverPosition: [1, 2, 3], serverRotation: [0, 0, 0, 1]
  });
});

test("last-test diagnostics handle an already removed NPC", async (t) => {
  const { DevHttpServer } = require("../out/servers/ZoneServer2016/managers/devhttpserver");
  const api = new DevHttpServer({ _lastSpawnedNpcCharacterId: characterId, _npcs: {} }, 0);
  const reply = t.mock.method(api, "sendJson", () => {});
  await api.handleApiNpcsLastTest({});
  assert.deepEqual(reply.mock.calls[0].arguments[2], {
    lastSpawnedCharacterId: characterId, transientId: null,
    serverPosition: null, serverRotation: null
  });
});

test("dev packet probes reject failed packing instead of claiming transmission", async (t) => {
  const { DevHttpServer } = require("../out/servers/ZoneServer2016/managers/devhttpserver");
  const client = {};
  const send = t.mock.fn();
  const api = new DevHttpServer({ _protocol: protocol, sendRawDataReliable: send }, 0);
  t.mock.method(api, "resolveTargetClient", () => ({ client }));
  t.mock.method(api, "readJsonBody", async () => ({
    packet: "Character.UpdateCharacterState",
    data: { characterId, states1: { visible: true } }
  }));
  t.mock.method(console, "error", () => {});
  const reply = t.mock.method(api, "sendJson", () => {});
  await api.handleApiSend({}, {});
  assert.equal(send.mock.callCount(), 0);
  assert.equal(reply.mock.calls[0].arguments[1], 400);
  assert.equal((reply.mock.calls[0].arguments[2] as { ok: boolean }).ok, false);
});

test("dev packet probes send a packed buffer and report its byte count", async (t) => {
  const { DevHttpServer } = require("../out/servers/ZoneServer2016/managers/devhttpserver");
  const client = {};
  const send = t.mock.fn();
  const api = new DevHttpServer({ _protocol: protocol, sendRawDataReliable: send }, 0);
  t.mock.method(api, "resolveTargetClient", () => ({ client }));
  t.mock.method(api, "readJsonBody", async () => ({
    packet: "Character.ExpectedSpeed", data: { characterId, speed: 2.5 }
  }));
  const reply = t.mock.method(api, "sendJson", () => {});
  await api.handleApiSend({}, {});
  assert.equal(send.mock.callCount(), 1);
  assert.equal(send.mock.calls[0].arguments[0], client);
  const sent = send.mock.calls[0].arguments[1] as Buffer;
  assert.equal(sent.readFloatLE(10), 2.5);
  assert.equal(reply.mock.calls[0].arguments[1], 200);
  assert.deepEqual(reply.mock.calls[0].arguments[2], { ok: true, bytes: sent.length });
});

function pack(name: string, data: object): Buffer {
  const result = protocol.pack(name, data);
  assert.ok(result, `${name} should pack`);
  return result;
}

test("position-channel probe strips opcode and selects gateway channel two", async (t) => {
  const { DevHttpServer } = require("../out/servers/ZoneServer2016/managers/devhttpserver");
  const send = t.mock.fn();
  const api = new DevHttpServer({ _protocol: protocol, sendRawDataReliable: send }, 0);
  const client = {};
  const data = { transientId: 45708, positionUpdate: {
    sequenceTime: 1000, unknown3_int8: 0, position: [1, 2, 3]
  } };
  t.mock.method(api, "resolveTargetClient", () => ({ client }));
  t.mock.method(api, "readJsonBody", async () => ({ packet: "PlayerUpdatePosition", data, positionChannel: true }));
  t.mock.method(api, "sendJson", () => {});
  await api.handleApiSend({}, {});
  assert.deepEqual(send.mock.calls[0].arguments, [client, pack("PlayerUpdatePosition", data).subarray(1), 2]);
});

test("position-channel probe rejects unrelated packet types", async (t) => {
  const { DevHttpServer } = require("../out/servers/ZoneServer2016/managers/devhttpserver");
  const send = t.mock.fn();
  const api = new DevHttpServer({ _protocol: protocol, sendRawDataReliable: send }, 0);
  t.mock.method(api, "resolveTargetClient", () => ({ client: {} }));
  t.mock.method(api, "readJsonBody", async () => ({ packet: "Character.ExpectedSpeed", data: { characterId, speed: 2.5 }, positionChannel: true }));
  const reply = t.mock.method(api, "sendJson", () => {});
  await api.handleApiSend({}, {});
  assert.equal(send.mock.callCount(), 0);
  assert.equal(reply.mock.calls[0].arguments[1], 400);
});

test("2016 zombie state packets use the client wire layout", () => {
  const attackRise = pack("Character.UpdateCharacterState", {
    characterId,
    states1: { visible: true, rooted: true },
    states2: {},
    states3: {},
    states4: {},
    states5: {},
    states6: {},
    states7: {},
    placeholder: 0,
    gameTime: 0x12345678
  });

  assert.equal(attackRise.length, 22);
  assert.equal(attackRise.readUInt8(10), 0x21);
  assert.equal(attackRise.readUInt32LE(18), 0x12345678);
});

test("2016 zombie scalar packets encode floats", () => {
  const expectedSpeed = pack("Character.ExpectedSpeed", {
    characterId,
    speed: 2.5
  });
  const aggro = pack("Character.AggroLevel", {
    characterId,
    unknownDword1: 1
  });

  assert.equal(expectedSpeed.length, 14);
  assert.equal(expectedSpeed.readFloatLE(10), 2.5);
  assert.equal(aggro.length, 14);
  assert.equal(aggro.readFloatLE(10), 1);
});

test("2016 SeekTarget installs a target-steering controller", () => {
  const seek = pack("Character.SeekTarget", {
    characterId,
    TargetCharacterId: targetCharacterId,
    initSpeed: 0,
    acceleration: 7.5,
    speed: 2.5,
    unknown8: 6,
    yRot: 0,
    rotation: new Float32Array([0.6, 0, -0.8, 0])
  });

  assert.equal(seek.length, 54);
  assert.deepEqual(
    [18, 22, 26, 30, 34].map((offset) => seek.readFloatLE(offset)),
    [0, 7.5, 2.5, 6, 0]
  );
  assert.deepEqual(
    [38, 42, 46, 50].map((offset) => seek.readFloatLE(offset)),
    Array.from(new Float32Array([0.6, 0, -0.8, 0]))
  );
});
