import assert from "node:assert/strict";
import test, { TestContext } from "node:test";

// Use the compiled demo modules, but never load files or launch a decoder.
const terrainAssets = require("../out/utils/forgelightTerrainAssets");
const {
  spawnTestZombieForClient,
  recordTestZombieClockSample
} = require("../out/servers/ZoneServer2016/test-zombie-in-front");
const { Npc } = require("../out/servers/ZoneServer2016/entities/npc");

function surface(slope = 0) {
  return {
    positions: new Float32Array([
      -20,
      10 - 20 * slope,
      -20,
      20,
      10 - 20 * slope,
      -20,
      -20,
      10 + 20 * slope,
      20,
      20,
      10 + 20 * slope,
      20
    ]),
    indices: new Uint32Array([0, 2, 1, 1, 2, 3])
  };
}

const flushAsync = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(t: TestContext, slope = 0, playerHeight = 10.1) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 });
  t.mock.method(console, "log", () => {});
  const errors = t.mock.method(console, "error", () => {});
  let complete!: (value: any[]) => void;
  let fail!: (error: Error) => void;
  const pending = new Promise<any[]>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  const loader = t.mock.method(
    terrainAssets,
    "loadForgelightTerrainCorridor",
    () => pending
  );
  const client: any = {
    sessionId: 1,
    testZombieSpawned: true,
    isLoading: false,
    isInAir: false,
    testZombieStance: 0x400,
    vehicle: {},
    spawnedEntities: new Set(),
    character: {
      characterId: "player",
      isAlive: true,
      isRespawning: false,
      isMoving: false,
      state: {
        position: new Float32Array([0, playerHeight, 0, 1]),
        rotation: new Float32Array([0, 0, 0, 1])
      }
    }
  };
  const existingNpc = { characterId: "existing-zombie" };
  const activeAi = new Set<any>();
  const server: any = {
    _modelsData: {},
    charactersRenderDistance: 100,
    interactionDistance: 3,
    _clients: { 1: client },
    _npcs: { "existing-zombie": existingNpc },
    _lastSpawnedNpcCharacterId: "existing-zombie",
    pushToGridCell: t.mock.fn(),
    removeTestZombie: t.mock.fn(() => {
      delete server._npcs["existing-zombie"];
    }),
    generateGuid: t.mock.fn(() => "0x0102030405060708"),
    getTransientId: () => 42,
    aiManager: {
      playerEntities: new Set(),
      addEntity: t.mock.fn((entity: any) => activeAi.add(entity)),
      removeEntity: t.mock.fn((entity: any) => activeAi.delete(entity))
    },
    sendData: t.mock.fn(),
    addLightweightNpc: t.mock.fn(),
    sendStandardFullNpcInit: t.mock.fn()
  };
  const options = {
    delayMs: 0,
    addAiDelayMs: 0,
    noAi: false,
    distance: 6,
    terrain: { assetRoot: "mock-terrain-root", decoderPath: "mock-decoder" }
  };
  const begin = () => {
    spawnTestZombieForClient(server, client, options);
    t.mock.timers.tick(1);
    assert.equal(loader.mock.callCount(), 1);
    assert.equal(server.generateGuid.mock.callCount(), 0);
    assert.equal(server.removeTestZombie.mock.callCount(), 0);
  };
  const finish = async () => {
    complete([surface(slope)]);
    await flushAsync();
    assert.equal(server.addLightweightNpc.mock.callCount(), 1);
    const npc = server.addLightweightNpc.mock.calls[0].arguments[1];
    t.mock.method(npc, "pGetFull", () => ({}));
    t.mock.method(npc, "clearMovementController", () => {});
    t.mock.method(npc, "sendIdleStance", () => {});
    return npc;
  };
  const full = (npc: any) => {
    Npc.prototype.OnFullCharacterDataRequest.call(npc, server, client);
    t.mock.timers.tick(1);
  };
  const fresh = (stance = 0x400) =>
    recordTestZombieClockSample(client, 5000, 5000, 8191, 1, stance);
  return {
    client,
    server,
    activeAi,
    existingNpc,
    begin,
    finish,
    full,
    fresh,
    complete,
    fail,
    loader,
    errors
  };
}

for (const [name, slope] of [
  ["flat", 0],
  ["sloped", 0.2]
] as const) {
  test(`async ${name} terrain spawn starts at ground origin0 and calibrates only after full data plus fresh grounded clock`, async (t) => {
    const state = setup(t, slope);
    const { client, server, activeAi, begin, finish, full, fresh, loader } =
      state;
    begin();
    assert.equal(activeAi.size, 0);
    const npc = await finish();
    assert.equal(server.removeTestZombie.mock.callCount(), 1);
    assert.equal(server.sendStandardFullNpcInit.mock.callCount(), 0);
    assert.equal(client.spawnedEntities.has(npc), true);
    assert.equal(
      activeAi.has(npc),
      false,
      "constructor registration must be removed before client readiness"
    );
    assert.equal(npc.testRouteStep, undefined);
    const ground = (position: ArrayLike<number>) => 10 + slope * position[2];
    assert.ok(
      Math.abs(npc.state.position[1] - ground(npc.state.position)) < 1e-5,
      "initial spawn cannot inherit the player's uncalibrated Y offset or the old +0.7 guess"
    );
    const [, , start, end] = loader.mock.calls[0].arguments;
    assert.deepEqual(start, [0, 0]);
    assert.ok(
      Math.abs(Math.hypot(end[0] - start[0], end[1] - start[1]) - 6) < 1e-5
    );
    full(npc);
    assert.equal(server.sendStandardFullNpcInit.mock.callCount(), 1);
    assert.equal(
      activeAi.has(npc),
      false,
      "full data without an inbound clock is insufficient"
    );
    assert.equal(npc.testRouteStep, undefined);
    const origin =
      client.character.state.position[1] -
      ground(client.character.state.position);
    fresh();
    t.mock.timers.tick(100);
    assert.equal(activeAi.has(npc), true);
    assert.equal(activeAi.has(client.character), true);
    assert.equal(typeof npc.testRouteStep, "function");
    assert.ok(
      Math.abs(npc.state.position[1] - ground(npc.state.position) - origin) <
        1e-5
    );
    assert.equal(npc.clearMovementController.mock.callCount(), 1);
    assert.equal(npc.sendIdleStance.mock.callCount(), 1);
    const from = npc.state.position.slice();
    const next = npc.testRouteStep(from, client.character.state.position, 0.25);
    assert.ok(next, "the bound route must be usable on the supplied terrain");
    assert.ok(
      Math.hypot(next[0] - from[0], next[1] - from[1], next[2] - from[2]) <=
        0.250001
    );
    assert.ok(Math.abs(next[1] - ground(next) - origin) < 1e-5);
    client.character.state.position[1] += 2;
    const afterTargetJump = npc.testRouteStep(
      from,
      client.character.state.position,
      0.25
    );
    assert.deepEqual(
      afterTargetJump,
      next,
      "later target Y cannot recalibrate the NPC origin"
    );
    assert.equal(state.errors.mock.callCount(), 0);
  });
}

test("airborne grounded-height sample cannot arm terrain AI; a fresh standing sample recovers", async (t) => {
  const { client, activeAi, begin, finish, full, fresh } = setup(t);
  begin();
  const npc = await finish();
  client.isInAir = true;
  fresh();
  full(npc);
  assert.equal(activeAi.has(npc), false);
  assert.equal(npc.testRouteStep, undefined);
  t.mock.timers.tick(1500);
  client.isInAir = false;
  t.mock.timers.tick(100);
  assert.equal(
    activeAi.has(npc),
    false,
    "the old airborne clock sample is now stale"
  );
  fresh();
  t.mock.timers.tick(100);
  assert.equal(activeAi.has(npc), true);
  assert.equal(typeof npc.testRouteStep, "function");
});

test("height offset above0.15 waits and cannot recalibrate from changed pose without a new clock sample", async (t) => {
  const { client, activeAi, begin, finish, full, fresh } = setup(t, 0.2, 10.3);
  begin();
  const npc = await finish();
  fresh();
  full(npc);
  assert.equal(activeAi.has(npc), false);
  assert.equal(npc.testRouteStep, undefined);
  assert.ok(
    Math.abs(npc.state.position[1] - (10 + 0.2 * npc.state.position[2])) < 1e-5
  );
  client.character.state.position[1] = 10.05;
  t.mock.timers.tick(100);
  assert.equal(
    activeAi.has(npc),
    false,
    "a corrected pose alone is not a fresh standing sample"
  );
  assert.equal(npc.testRouteStep, undefined);
  fresh();
  t.mock.timers.tick(100);
  assert.equal(activeAi.has(npc), true);
  assert.ok(
    Math.abs(
      npc.state.position[1] - (10 + 0.2 * npc.state.position[2]) - 0.05
    ) < 1e-5
  );
});

test("fresh grounded clock without the owner's full-data request cannot arm terrain AI", async (t) => {
  const { activeAi, begin, finish, fresh } = setup(t);
  begin();
  const npc = await finish();
  fresh();
  t.mock.timers.tick(100);
  assert.equal(activeAi.has(npc), false);
  assert.equal(npc.testRouteStep, undefined);
});

for (const [reason, stance] of [
  ["unknown", undefined],
  ["not on ground", 0],
  ["floating", 0x410],
  ["jumping", 0x420]
] as const) {
  test(`terrain calibration refuses ${reason} stance until a new actual grounded sample`, async (t) => {
    const { client, activeAi, begin, finish, full, fresh } = setup(t);
    begin();
    const npc = await finish();
    delete client.testZombieStance;
    recordTestZombieClockSample(client, 5000, 5000, 8191, 1, stance);
    full(npc);
    assert.equal(activeAi.has(npc), false);
    assert.equal(npc.testRouteStep, undefined);
    t.mock.timers.tick(100);
    fresh();
    t.mock.timers.tick(100);
    assert.equal(activeAi.has(npc), true);
    assert.equal(typeof npc.testRouteStep, "function");
  });
}

for (const [reason, invalidate] of [
  ["disconnect", ({ server }: any) => delete server._clients[1]],
  ["session replacement", ({ server }: any) => (server._clients[1] = {})],
  ["death", ({ client }: any) => (client.character.isAlive = false)],
  ["respawn", ({ client }: any) => (client.character.isRespawning = true)]
] as const) {
  test(`async terrain completion after ${reason} preserves the old NPC and creates no replacement`, async (t) => {
    const state = setup(t);
    state.begin();
    invalidate(state);
    state.complete([surface()]);
    await flushAsync();
    assert.equal(state.server._npcs["existing-zombie"], state.existingNpc);
    assert.equal(state.server._lastSpawnedNpcCharacterId, "existing-zombie");
    assert.equal(state.server.removeTestZombie.mock.callCount(), 0);
    assert.equal(state.server.generateGuid.mock.callCount(), 0);
    assert.equal(state.server.addLightweightNpc.mock.callCount(), 0);
    assert.equal(state.server.aiManager.addEntity.mock.callCount(), 0);
  });
}

test("terrain loader failure preserves the old NPC without guessed-height fallback", async (t) => {
  const state = setup(t);
  state.begin();
  state.fail(new Error("controlled terrain decoder failure"));
  await flushAsync();
  assert.equal(state.server._npcs["existing-zombie"], state.existingNpc);
  assert.equal(state.server._lastSpawnedNpcCharacterId, "existing-zombie");
  assert.equal(state.server.removeTestZombie.mock.callCount(), 0);
  assert.equal(state.server.generateGuid.mock.callCount(), 0);
  assert.equal(state.server.addLightweightNpc.mock.callCount(), 0);
  assert.equal(state.server.aiManager.addEntity.mock.callCount(), 0);
  assert.equal(state.errors.mock.callCount(), 1);
});

test("decoded terrain without spawn coverage does not remove the existing NPC", async (t) => {
  const state = setup(t);
  state.begin();
  state.complete([]);
  await flushAsync();
  assert.equal(state.server._npcs["existing-zombie"], state.existingNpc);
  assert.equal(state.server.removeTestZombie.mock.callCount(), 0);
  assert.equal(state.server.generateGuid.mock.callCount(), 0);
  assert.equal(state.server.addLightweightNpc.mock.callCount(), 0);
  assert.equal(state.errors.mock.callCount(), 1);
});
