import assert from "node:assert/strict";
import test, { TestContext } from "node:test";

// Isolated protocol/gate tests against the same built modules as the demo.
// Native basis: 1403d0d40 -> 1417f2b60/1417f1c00 returns flags 0x1fff
// when record+0x148 differs. The request itself is never a clock acknowledgement.
const {
  armTestZombieOnFullData,
  recordTestZombieClockSample,
  requestTestZombieClockBaseline
} = require(process.env.ZOMBIE_CLOCK_RESYNC_SOURCE === "true"
  ? "../src/servers/ZoneServer2016/test-zombie-in-front.ts"
  : "../out/servers/ZoneServer2016/test-zombie-in-front");
const { H1Z1Protocol } = require("../out/protocols/h1z1protocol");
const {
  ZonePacketHandlers
} = require("../out/servers/ZoneServer2016/zonepackethandlers");
const { Npc } = require("../out/servers/ZoneServer2016/entities/npc");
const {
  packPositionUpdateData
} = require("../out/packets/ClientProtocol/ClientProtocol_1080/shared");
const { getCurrentServerTimeWrapper } = require("../out/utils/utils");

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 });
  t.mock.method(console, "log", () => {});
  const client: any = {
    sessionId: 1,
    testZombieSpawned: true,
    isLoading: false,
    isInAir: false,
    isSynced: true,
    vehicle: {},
    avgPing: 0,
    testZombieSynchronization: {
      count: 1,
      repliedAt: 9000,
      serverTimeU32: 5000
    },
    character: {
      characterId: "player",
      isAlive: true,
      isRespawning: false,
      isMoving: false,
      state: {
        position: new Float32Array([1630.24, 39.72, 1996.08, 1]),
        rotation: new Float32Array([0, 0, 0, 1])
      },
      checkCurrentInteractionGuid: t.mock.fn()
    }
  };
  recordTestZombieClockSample(client, 900000, 5000, 1, 0);
  client.testZombieClockDiagnostics.lastReceivedAt = 8000;
  const npc: any = {
    characterId: "zombie",
    isAlive: true,
    testServerDrivenMovement: true,
    clearMovementController: t.mock.fn(),
    sendIdleStance: t.mock.fn(),
    pGetFull: () => ({})
  };
  const server: any = {
    _clients: { 1: client },
    _npcs: { zombie: npc },
    sendData: t.mock.fn(),
    sendStandardFullNpcInit: t.mock.fn(),
    aiManager: { playerEntities: new Set(), addEntity: t.mock.fn() }
  };
  const request = () => requestTestZombieClockBaseline(server, client);
  const requestFull = () => {
    armTestZombieOnFullData(server, client, npc, {
      noAi: false,
      addAiDelayMs: 0
    });
    npc.onReadyCallback(client);
    t.mock.timers.tick(1);
  };
  return { client, npc, server, request, requestFull };
}

const refusals: [string, (state: ReturnType<typeof setup>) => void][] = [
  [
    "no actual Synchronization reply",
    ({ client }) => delete client.testZombieSynchronization
  ],
  [
    "zero actual Synchronization replies",
    ({ client }) => (client.testZombieSynchronization.count = 0)
  ],
  [
    "Synchronization reply too recent",
    ({ client }) => (client.testZombieSynchronization.repliedAt = 9900)
  ],
  [
    "Synchronization reply too old",
    ({ client }) => (client.testZombieSynchronization.repliedAt = -1)
  ],
  [
    "no observed movement version",
    ({ client }) => delete client.testZombieMovementVersion
  ],
  [
    "invalid movement version",
    ({ client }) => (client.testZombieMovementVersion = 256)
  ],
  [
    "no actual movement sample",
    ({ client }) => delete client.testZombieClockDiagnostics
  ],
  [
    "recent movement traffic",
    ({ client }) => (client.testZombieClockDiagnostics.lastReceivedAt = 9500)
  ],
  ["active movement", ({ client }) => (client.character.isMoving = true)],
  ["airborne player", ({ client }) => (client.isInAir = true)],
  [
    "mounted player",
    ({ client }) => (client.vehicle.mountedVehicle = "vehicle")
  ],
  ["loading player", ({ client }) => (client.isLoading = true)],
  ["dead player", ({ client }) => (client.character.isAlive = false)],
  ["respawning player", ({ client }) => (client.character.isRespawning = true)],
  ["disconnected player", ({ server }) => delete server._clients[1]],
  ["replaced session", ({ server }) => (server._clients[1] = {})],
  ["disabled experiment", ({ client }) => (client.testZombieSpawned = false)],
  [
    "nonfinite position",
    ({ client }) => (client.character.state.position[0] = NaN)
  ],
  [
    "nonfinite rotation",
    ({ client }) => (client.character.state.rotation[0] = Infinity)
  ]
];

for (const [reason, mutate] of refusals) {
  test(`clock baseline refresh refuses ${reason}`, (t) => {
    const state = setup(t);
    mutate(state);
    assert.equal(state.request(), false);
    assert.equal(state.server.sendData.mock.callCount(), 0);
    assert.equal(state.client.testZombieClockResync, undefined);
    assert.equal(state.client.testZombieClockReadyAt, undefined);
  });
}

test("clock baseline refresh preserves pose and sends horizontal direction, wraps version255 without acknowledging time", (t) => {
  const { client, server, request } = setup(t);
  client.testZombieMovementVersion = 255;
  const position = client.character.state.position;
  const rotation = client.character.state.rotation;
  const originalPosition = Array.from(position);
  const originalRotation = Array.from(rotation);
  const originalDiagnostics = { ...client.testZombieClockDiagnostics };
  assert.equal(request(), true);
  assert.equal(server.sendData.mock.callCount(), 1);
  const [recipient, packetName, payload] =
    server.sendData.mock.calls[0].arguments;
  assert.equal(recipient, client);
  assert.equal(packetName, "ClientUpdate.UpdateLocation");
  assert.deepEqual(Array.from(payload.position), originalPosition);
  assert.deepEqual(Array.from(payload.rotation), [0, 0, 1, 0]);
  assert.notEqual(payload.position, position);
  assert.notEqual(payload.rotation, rotation);
  assert.equal(payload.unknownBoolean1, true);
  assert.equal(payload.unknownByte1, 0);
  assert.equal(payload.triggerLoadingScreen, false);
  assert.equal(client.character.state.position, position);
  assert.equal(client.character.state.rotation, rotation);
  assert.deepEqual(Array.from(client.character.state.rotation), originalRotation);
  assert.equal(client.testZombieMovementVersion, 255);
  assert.equal(client.testZombieClockReadyAt, undefined);
  assert.deepEqual(client.testZombieClockDiagnostics, originalDiagnostics);
  assert.deepEqual(client.testZombieClockResync, {
    count: 1,
    requestedAt: 10000,
    requestedVersion: 0
  });
  const wire = new H1Z1Protocol("ClientProtocol_1080").pack(
    packetName,
    payload
  );
  assert.equal(wire.length, 38);
});

test("clock baseline refresh does not advance an unacknowledged version", (t) => {
  const { client, request, server } = setup(t);
  assert.equal(request(), true);
  t.mock.timers.tick(2500);
  client.testZombieSynchronization.repliedAt = Date.now() - 1000;
  assert.equal(request(), false);
  assert.equal(server.sendData.mock.callCount(), 1);
  assert.equal(client.testZombieMovementVersion, 0);
});

test("a reordered older version cannot authorize the next refresh", (t) => {
  const { client, request, server } = setup(t);
  assert.equal(request(), true); // waiting for version 1
  recordTestZombieClockSample(client, 900000, 5000, 1, 255);
  t.mock.timers.tick(2500);
  client.testZombieSynchronization.repliedAt = Date.now() - 1000;
  assert.equal(
    request(),
    false,
    "version255 is not an echo of the pending version1"
  );
  assert.equal(server.sendData.mock.callCount(), 1);
});

test("echoed but misaligned responses permit cooldown-limited retries, at most three", (t) => {
  const { client, request, server } = setup(t);
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(request(), true);
    assert.equal(client.testZombieClockResync.count, attempt);
    assert.equal(client.testZombieClockResync.requestedVersion, attempt);
    recordTestZombieClockSample(client, 900000, 5000, 8191, attempt);
    assert.equal(client.testZombieClockReadyAt, undefined);
    assert.equal(request(), false, "cannot retry immediately after an echo");
    t.mock.timers.tick(1999);
    assert.equal(request(), false, "minimum request interval is 2000ms");
    t.mock.timers.tick(1);
    client.testZombieSynchronization.repliedAt = Date.now() - 1000;
  }
  assert.equal(request(), false);
  assert.equal(server.sendData.mock.callCount(), 3);
  assert.equal(client.testZombieClockResync.count, 3);
  assert.equal(client.testZombieClockReadyAt, undefined);
});

test("malformed data cannot echo the pending version or unlock a retry", (t) => {
  const { client, request } = setup(t);
  assert.equal(request(), true);
  recordTestZombieClockSample(client, NaN, 5000, 8191, 1);
  assert.equal(client.testZombieMovementVersion, 0);
  t.mock.timers.tick(2500);
  client.testZombieSynchronization.repliedAt = Date.now() - 1000;
  assert.equal(request(), false);
  assert.equal(client.testZombieClockReadyAt, undefined);
});

test("owned clock budgets each allow three real requests without resetting global history", t => {
  const { client, server } = setup(t);
  const budgets = [{ count: 0, isCurrent: () => true }, { count: 0, isCurrent: () => true }];
  for (let lease = 0; lease < 2; lease++) {
    const budget = budgets[lease];
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.equal(requestTestZombieClockBaseline(server, client, budget), true);
      assert.equal(budget.count, attempt);
      assert.equal(client.testZombieClockResync.count, lease * 3 + attempt);
      recordTestZombieClockSample(client, 900000, 5000, 8191, lease * 3 + attempt);
      t.mock.timers.tick(2000);
      client.testZombieSynchronization.repliedAt = Date.now() - 1000;
    }
    assert.equal(requestTestZombieClockBaseline(server, client, budget), false);
    assert.equal(budget.count, 3);
  }
  assert.equal(server.sendData.mock.callCount(), 6);
  assert.ok((console.log as any).mock.calls.some((call: any) =>
    String(call.arguments[0]).includes("attempt=4, scope=owned, ownedAttempt=1")),
    "diagnostic separates cumulative history from this lease's request count");
  assert.equal(client.testZombieClockReadyAt, undefined, "outbound requests never create a valid clock");
  assert.equal(requestTestZombieClockBaseline(server, client), false, "unleased legacy retains global cap");
});

test("new owned budget cannot bypass old unacknowledged version, reordered echo or global cooldown", t => {
  const { client, server, request } = setup(t);
  assert.equal(request(), true);
  const pending = client.testZombieClockResync;
  const budget = { count: 0, isCurrent: () => true };
  t.mock.timers.tick(2000);
  client.testZombieSynchronization.repliedAt = Date.now() - 1000;
  assert.equal(requestTestZombieClockBaseline(server, client, budget), false);
  assert.equal(client.testZombieClockResync, pending); assert.equal(budget.count, 0);
  recordTestZombieClockSample(client, 900000, 5000, 8191, 255);
  t.mock.timers.tick(2000);
  assert.equal(requestTestZombieClockBaseline(server, client, budget), false);
  recordTestZombieClockSample(client, 900000, 5000, 8191, 1);
  t.mock.timers.tick(1000);
  assert.equal(requestTestZombieClockBaseline(server, client, budget), true);
  assert.equal(budget.count, 1);
  recordTestZombieClockSample(client, 900000, 5000, 8191, 2);
  t.mock.timers.tick(1999);
  assert.equal(requestTestZombieClockBaseline(server, client, budget), false);
  t.mock.timers.tick(1);
  client.testZombieSynchronization.repliedAt = Date.now() - 1000;
  assert.equal(requestTestZombieClockBaseline(server, client, budget), true);
  assert.equal(server.sendData.mock.callCount(), 3);
});

test("cancelled and malformed owned budgets never send or alter pending global history", t => {
  const { client, server, request } = setup(t); assert.equal(request(), true);
  const pending = client.testZombieClockResync;
  for (const budget of [{ count: 0, isCurrent: () => false },
    ...[-1, 3, 4, NaN, Infinity, 0.5, true].map(count => ({ count, isCurrent: () => true }))]) {
    assert.equal(requestTestZombieClockBaseline(server, client, budget), false);
    assert.equal(client.testZombieClockResync, pending);
  }
  assert.equal(server.sendData.mock.callCount(), 1);
});

test("a throwing baseline sender consumes neither owned budget nor global pending request", t => {
  const { client, server } = setup(t);
  const previous = client.testZombieClockResync = { count: 3, requestedAt: 7000, requestedVersion: 0 };
  const budget = { count: 0, isCurrent: () => true };
  const failed = t.mock.method(server, "sendData", () => { throw Error("synthetic send failure"); });
  assert.throws(() => requestTestZombieClockBaseline(server, client, budget), /synthetic send failure/);
  assert.equal(budget.count, 0); assert.equal(client.testZombieClockResync, previous);
  assert.equal(client.testZombieClockReadyAt, undefined); assert.equal(failed.mock.callCount(), 1);
  failed.mock.restore();
  assert.equal(requestTestZombieClockBaseline(server, client, budget), true);
  assert.equal(budget.count, 1); assert.equal(client.testZombieClockResync.count, 4);
});

function deliverFullMovement(client: any) {
  const time = getCurrentServerTimeWrapper().getTruncatedU32();
  const raw = packPositionUpdateData({
    sequenceTime: time,
    unknown3_int8: 1,
    stance: 0,
    position: [1630.24, 39.72, 1996.08],
    orientation: 0,
    frontTilt: 0,
    sideTilt: 0,
    angleChange: 0,
    verticalSpeed: 0,
    horizontalSpeed: 0,
    unknown12_float: [0, 0, 0],
    rotationRaw: [0, 0, 0, 0],
    direction: 0,
    engineRPM: 0,
    PosAndRot: [0, 0, 0, 0, 0, 0, 0, 0]
  });
  assert.equal(raw.readUInt16LE(0), 8191);
  const packet = new H1Z1Protocol("ClientProtocol_1080").parse(raw, 2);
  assert.equal(packet.name, "PlayerUpdatePosition");
  assert.equal(packet.data.parseError, undefined);
  ZonePacketHandlers.prototype.PlayerUpdatePosition({}, client, packet);
  return packet;
}

test("full NPC data and an outbound refresh cannot arm AI; actual fresh Channel2 flags8191 can", (t) => {
  const { client, server, npc, requestFull } = setup(t);
  requestFull();
  assert.equal(server.sendData.mock.callCount(), 1);
  assert.equal(server.aiManager.addEntity.mock.callCount(), 0);
  assert.equal(client.testZombieClockReadyAt, undefined);
  t.mock.timers.tick(1000);
  assert.equal(server.aiManager.addEntity.mock.callCount(), 0);
  deliverFullMovement(client);
  assert.equal(client.testZombieClockDiagnostics.lastFlags, 8191);
  assert.equal(client.testZombieClockDiagnostics.lastResult, "aligned");
  assert.equal(client.testZombieMovementVersion, 1);
  assert.equal(client.testZombieClockReadyAt, Date.now());
  t.mock.timers.tick(100);
  assert.deepEqual(
    server.aiManager.addEntity.mock.calls.map((call: any) => call.arguments[0]),
    [client.character, npc]
  );
  assert.equal(npc.clearMovementController.mock.callCount(), 1);
  t.mock.timers.tick(5000);
  assert.equal(server.aiManager.addEntity.mock.callCount(), 2);
});

test("a stale aligned sample still requires a fresh acknowledgement", (t) => {
  const { client, server, requestFull } = setup(t);
  recordTestZombieClockSample(client, 5000, 5000, 8191, 0);
  t.mock.timers.tick(1001);
  requestFull();
  assert.equal(server.aiManager.addEntity.mock.callCount(), 0);
  assert.equal(
    client.testZombieClockReadyAt,
    10000,
    "sending a refresh must not update accepted time"
  );
});

test("fresh clock data cannot start AI while the owner is loading", (t) => {
  const { client, server, requestFull } = setup(t);
  client.isLoading = true;
  recordTestZombieClockSample(client, 5000, 5000, 8191, 1);
  requestFull();
  assert.equal(server.aiManager.addEntity.mock.callCount(), 0);
  assert.equal(server.sendData.mock.callCount(), 0);
});

test("a non-owner full-data request cannot consume the owner's pending callback", (t) => {
  const { client, server, npc } = setup(t);
  armTestZombieOnFullData(server, client, npc, {
    noAi: false,
    addAiDelayMs: 0
  });
  const callback = npc.onReadyCallback;
  const otherClient = { sessionId: 2, character: { characterId: "other" } };
  Npc.prototype.OnFullCharacterDataRequest.call(npc, server, otherClient);
  assert.equal(npc.onReadyCallback, callback);
  assert.equal(server.sendData.mock.calls[0].arguments[0], otherClient);
  t.mock.timers.tick(1);
  assert.equal(server.aiManager.addEntity.mock.callCount(), 0);
  assert.equal(client.testZombieClockResync, undefined);
  recordTestZombieClockSample(client, 5000, 5000, 8191, 1);
  Npc.prototype.OnFullCharacterDataRequest.call(npc, server, client);
  assert.equal(npc.onReadyCallback, undefined);
  t.mock.timers.tick(1);
  assert.equal(server.aiManager.addEntity.mock.callCount(), 2);
});
