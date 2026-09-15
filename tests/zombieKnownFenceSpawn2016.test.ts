import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test, { TestContext } from "node:test";
import ts from "typescript";
import { createForgelightTerrainFollowBinding } from "../src/utils/forgelightTerrainFollow";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const terrain = { positions: new Float32Array([-20,10,-20,20,10,-20,20,10,20,-20,10,20]),
  indices: new Uint32Array([0,1,2,0,2,3]) };

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 });
  let active = true, released = false, captured: any, paused = 0, started = 0, fullData = 0, failCalibration = false;
  let pendingTask = false, savedClaim: (() => void) | undefined, removeAttempts = 0, ownedDisposalFailed = false;
  const faults = new Set<string>(), events: string[] = [], constructed: any[] = [], failureSnapshots: any[] = [];
  let resolveResource!: (value: any) => void, rejectResource!: (error: Error) => void;
  const pending = new Promise((resolve, reject) => { resolveResource = resolve; rejectResource = reject; });
  const resource = { scope: { otherCollisionCoverage: "unknown" },
    calibrate: t.mock.fn((_binding: any) => { if (failCalibration) throw Error("bad calibration"); }),
    testRouteStep: t.mock.fn(() => undefined), testMeleeReachability: t.mock.fn(() => false),
    dispose: t.mock.fn(() => { events.push("dispose"); if (faults.has("dispose")) throw Error("native dispose failed"); }) };
  const prepare = t.mock.fn(() => pending), loadTerrain = t.mock.fn(async () => [terrain]);
  const errors: unknown[][] = [], ai = new Set<any>();
  const client: any = { sessionId: 1, testZombieSpawned: true, isLoading: false, isInAir: false,
    testZombieStance: 0x400, spawnedEntities: new Set(), vehicle: {},
    character: { characterId: "player", isAlive: true, isRespawning: false,
      state: { position: new Float32Array([0,10.01,0,1]), rotation: new Float32Array([0,0,0,1]) } } };
  const oldNpc = { characterId: "old" };
  const server: any = { _clients: { 1: client }, _npcs: { old: oldNpc }, _lastSpawnedNpcCharacterId: "old",
    _testZombieBySessionId: { 1: "old" },
    removeTestZombie: t.mock.fn(() => { delete server._npcs.old; server._lastSpawnedNpcCharacterId = null;
      delete server._testZombieBySessionId[1]; }), generateGuid: t.mock.fn(() => "npc"),
    getTransientId: () => 42,
    addLightweightNpc: t.mock.fn(() => { events.push("publish"); if (faults.has("publish")) throw Error("send failed"); }),
    sendStandardFullNpcInit: t.mock.fn(),
    deleteEntity: t.mock.fn((id: string, dictionary: any) => {
      events.push("delete-entity"); if (faults.has("delete-entity")) throw Error("delete failed");
      const entity = dictionary[id]; if (!entity) return false;
      client.spawnedEntities.delete(entity); ai.delete(entity); delete dictionary[id]; return true;
    }),
    aiManager: { playerEntities: new Set(), addEntity: t.mock.fn((e: any) => ai.add(e)),
      removeEntity: t.mock.fn((e: any) => { events.push("remove-ai"); removeAttempts++;
        if (faults.has("remove-ai") || (faults.has("initial-remove-ai") && removeAttempts === 1)) throw Error("AI removal failed");
        return ai.delete(e);
      }) } };
  class FakeNpc {
    isAlive = true; state: any; private readyCallback: any;
    get onReadyCallback() { return this.readyCallback; }
    set onReadyCallback(value: any) { if (faults.has("arm")) throw Error("arm failed"); this.readyCallback = value; }
    clearMovementController = t.mock.fn(); sendIdleStance = t.mock.fn();
    setFacingToward = t.mock.fn(() => { if (faults.has("facing")) throw Error("facing failed"); });
    constructor(public characterId: string, public transientId: number, _model: number, position: Float32Array, rotation: Float32Array) {
      this.state = { position, rotation }; ai.add(this); constructed.push(this);
    }
  }
  const lifecycle = {
    isCurrent: () => active,
    onSpawnTaskStarted: t.mock.fn(() => { events.push("task-started"); pendingTask = true;
      if (faults.has("start-hook")) throw Error("start hook failed"); }),
    onSpawnTaskSettled: t.mock.fn(() => { events.push("task-settled"); pendingTask = false; }),
    onUnpublishedCleanupFailure: t.mock.fn((_details: any) => { events.push("cleanup-failure");
      if (faults.has("cleanup-report")) throw Error("cleanup report failed"); }),
    onSpawned: t.mock.fn((npc: any, claimOwnership: () => void) => {
      savedClaim = claimOwnership;
      if (faults.has("before-claim")) throw Error("adoption failed before claim");
      if (faults.has("reject-claim")) return;
      captured = npc;
      if (options.knownObstacle) assert.equal(npc.testRouteResource, resource);
      claimOwnership(); events.push("claim");
      if (faults.has("after-claim")) throw Error("adoption failed after claim");
    }),
    onFullData: () => { fullData++; }, onPaused: () => { paused++; }, canStart: () => active && released,
    onStarted: () => { started++; }, onFailure: t.mock.fn(() => {
      events.push("failure");
      failureSnapshots.push({ ai: [...ai], registry: { ...server._npcs }, disposeCalls: resource.dispose.mock.callCount(),
        cleanupReports: lifecycle.onUnpublishedCleanupFailure.mock.callCount() });
      if (faults.has("failure-hook")) throw Error("failure hook failed");
      active = false;
      if (captured) {
        try { captured.testRouteResource?.dispose(); } catch { ownedDisposalFailed = true; }
        ai.delete(captured); client.spawnedEntities.delete(captured);
        if (server._npcs[captured.characterId] === captured) delete server._npcs[captured.characterId];
      }
    })
  };
  const module = { exports: {} as any };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync("src/servers/ZoneServer2016/test-zombie-in-front.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 }
  }).outputText, { module, exports: module.exports, __dirname: ".", process: { env: {} },
    console: { log() {}, error(...args: any[]) { errors.push(args); } },
    get Date() { return Date; }, get setTimeout() {
      if (faults.has("schedule")) return () => { throw Error("schedule failed"); };
      return setTimeout;
    },
    require(name: string) {
      if (name === "../../utils/utils") return { quat2heading: () => 0 };
      if (name === "./entities/npc") return { Npc: FakeNpc };
      if (name === "./models/enums") return { ModelIds: { ZOMBIE_MALE_WALKER: 9510 } };
      if (name === "../../utils/forgelightTerrainAssets") return { loadForgelightTerrainCorridor: loadTerrain };
      if (name === "../../utils/forgelightTerrainFollow") return { createForgelightTerrainFollowBinding };
      if (name === "./test-zombie-known-fence") return { prepareTestZombieKnownFence: prepare };
      if (name.endsWith("ServerProfileDefinitions.json")) return { profiles: [{ ID: 10, profileData: { unknownByte1: 11 } }] };
      if (name === "node:path") return require(name);
      throw Error("Unexpected source dependency: " + name);
    } });
  const options: any = { delayMs: 0, addAiDelayMs: 0, noAi: false, distance: 6,
    terrain: { assetRoot: "mock", decoderPath: "mock" }, knownObstacle: "fence-192060", lifecycle };
  const begin = async () => { module.exports.spawnTestZombieForClient(server, client, options); t.mock.timers.tick(1); await flush(); };
  const complete = async () => { resolveResource(resource); await flush(); };
  const fresh = () => module.exports.recordTestZombieClockSample(client, 5000, 5000, 8191, 1, 0x400);
  return { module, options, client, server, oldNpc, resource, prepare, loadTerrain, lifecycle, errors, ai, begin, complete, fresh,
    faults, events, constructed, failureSnapshots, get pendingTask() { return pendingTask; },
    get savedClaim() { return savedClaim; }, get ownedDisposalFailed() { return ownedDisposalFailed; },
    rejectResource, cancel: () => { active = false; }, release: () => { released = true; },
    failCalibration: () => { failCalibration = true; }, get npc() { return captured; },
    get paused() { return paused; }, get started() { return started; }, get fullData() { return fullData; } };
}

test("known route loads before NPC publication and waits for actual full-data and grounded clock before binding", async t => {
  const s = setup(t); await s.begin();
  assert.equal(s.prepare.mock.callCount(), 1); assert.equal(s.server.removeTestZombie.mock.callCount(), 0);
  assert.equal(s.lifecycle.onSpawnTaskStarted.mock.callCount(), 1);
  assert.equal(s.lifecycle.onSpawnTaskSettled.mock.callCount(), 0); assert.equal(s.pendingTask, true);
  await s.complete();
  assert.equal(s.lifecycle.onSpawnTaskSettled.mock.callCount(), 1); assert.equal(s.pendingTask, false);
  assert.ok(s.npc); assert.equal(s.npc.testRouteStep, s.resource.testRouteStep);
  assert.equal(s.npc.testMeleeReachability, s.resource.testMeleeReachability);
  assert.equal(s.resource.calibrate.mock.callCount(), 0); assert.equal(s.ai.has(s.npc), false);
  s.npc.onReadyCallback(s.client); t.mock.timers.tick(1);
  assert.equal(s.fullData, 1); assert.equal(s.resource.calibrate.mock.callCount(), 0);
  s.fresh(); t.mock.timers.tick(100);
  assert.equal(s.paused, 1); assert.equal(s.started, 0); assert.equal(s.resource.calibrate.mock.callCount(), 1);
  assert.equal(s.npc.testRouteResource, s.resource); assert.equal(s.ai.has(s.npc), false);
  t.mock.timers.tick(1); s.client.character.state.position[1] += 0.01; s.fresh(); s.release(); t.mock.timers.tick(100);
  assert.equal(s.started, 1); assert.equal(s.resource.calibrate.mock.callCount(), 2);
  assert.equal(s.ai.has(s.npc), true); assert.equal(s.npc.testRouteResource, s.resource);
  assert.equal(s.resource.dispose.mock.callCount(), 0); assert.equal(s.errors.length, 0);
  assert.throws(() => s.savedClaim!(), /claimed synchronously/);
});

for (const reason of ["cancel", "disconnect", "death", "respawn"] as const) test(`async fence completion after ${reason} disposes once and preserves the previous NPC`, async t => {
  const s = setup(t); await s.begin();
  if (reason === "cancel") s.cancel();
  if (reason === "disconnect") delete s.server._clients[1];
  if (reason === "death") s.client.character.isAlive = false;
  if (reason === "respawn") s.client.character.isRespawning = true;
  await s.complete();
  assert.equal(s.resource.dispose.mock.callCount(), 1);
  assert.equal(s.server._npcs.old, s.oldNpc); assert.equal(s.server.removeTestZombie.mock.callCount(), 0);
  assert.equal(s.server.generateGuid.mock.callCount(), 0); assert.equal(s.server.addLightweightNpc.mock.callCount(), 0);
  assert.equal(s.lifecycle.onSpawnTaskSettled.mock.callCount(), 1); assert.equal(s.pendingTask, false);
});

test("failed known resource loading never falls back to a terrain-only chase", async t => {
  const s = setup(t); await s.begin(); s.rejectResource(Error("known asset mismatch")); await flush();
  assert.equal(s.lifecycle.onFailure.mock.callCount(), 1); assert.equal(s.server._npcs.old, s.oldNpc);
  assert.equal(s.server.generateGuid.mock.callCount(), 0); assert.equal(s.resource.dispose.mock.callCount(), 0);
});

test("ground calibration failure closes the owned replay instead of arming unguarded movement", async t => {
  const s = setup(t); await s.begin(); await s.complete(); s.failCalibration();
  s.fresh(); s.npc.onReadyCallback(s.client); t.mock.timers.tick(1);
  assert.equal(s.lifecycle.onFailure.mock.callCount(), 1); assert.equal(s.resource.dispose.mock.callCount(), 1);
  assert.equal(s.started, 0); assert.equal(s.ai.has(s.npc), false);
});

for (const missing of ["terrain", "lifecycle", "distance", "mode"] as const) test(`invalid known-fence ${missing} is rejected before any asynchronous work`, async t => {
  const s = setup(t);
  if (missing === "terrain") delete s.options.terrain;
  if (missing === "lifecycle") delete s.options.lifecycle;
  if (missing === "distance") s.options.distance = 12;
  if (missing === "mode") s.options.knownObstacle = "unknown";
  assert.throws(() => s.module.exports.spawnTestZombieForClient(s.server, s.client, s.options), /owned terrain replay/);
  assert.equal(s.prepare.mock.callCount(), 0); assert.equal(s.loadTerrain.mock.callCount(), 0);
  assert.equal(s.lifecycle.onSpawnTaskStarted.mock.callCount(), 0);
  assert.equal(s.lifecycle.onSpawnTaskSettled.mock.callCount(), 0);
});

test("task gate starts synchronously before the timer and settles a pre-timer cancellation once", async t => {
  const s = setup(t); s.options.delayMs = 100;
  s.module.exports.spawnTestZombieForClient(s.server, s.client, s.options);
  assert.deepEqual(s.events, ["task-started"]); assert.equal(s.pendingTask, true);
  assert.equal(s.loadTerrain.mock.callCount(), 0); s.cancel();
  t.mock.timers.tick(100); await flush();
  assert.equal(s.lifecycle.onSpawnTaskSettled.mock.callCount(), 1); assert.equal(s.pendingTask, false);
  assert.equal(s.loadTerrain.mock.callCount(), 0); assert.equal(s.resource.dispose.mock.callCount(), 0);
  assert.equal(s.server._npcs.old, s.oldNpc);
});

test("terrain load remains pending through cancellation until its own asynchronous completion", async t => {
  const s = setup(t); let resolveTerrain!: (value: typeof terrain[]) => void;
  const pendingTerrain = new Promise<typeof terrain[]>(resolve => { resolveTerrain = resolve; });
  s.loadTerrain.mock.mockImplementation(() => pendingTerrain);
  await s.begin(); s.cancel();
  assert.equal(s.pendingTask, true); assert.equal(s.lifecycle.onSpawnTaskSettled.mock.callCount(), 0);
  resolveTerrain([terrain]); await flush();
  assert.equal(s.pendingTask, false); assert.equal(s.lifecycle.onSpawnTaskSettled.mock.callCount(), 1);
  assert.equal(s.prepare.mock.callCount(), 0); assert.equal(s.server._npcs.old, s.oldNpc);
});

for (const fault of ["facing", "initial-remove-ai", "arm", "before-claim", "reject-claim"] as const)
test(`creator cleans exact unadopted NPC and route before onFailure when ${fault} fails`, async t => {
  const s = setup(t); s.faults.add(fault); await s.begin(); await s.complete();
  assert.equal(s.constructed.length, 1); assert.equal(s.npc, undefined);
  assert.equal(s.ai.size, 0); assert.equal(s.server._npcs.npc, undefined);
  assert.equal(s.server._lastSpawnedNpcCharacterId, null); assert.equal(s.server._testZombieBySessionId[1], undefined);
  assert.equal(s.server.addLightweightNpc.mock.callCount(), 0); assert.equal(s.resource.dispose.mock.callCount(), 1);
  assert.equal(s.lifecycle.onUnpublishedCleanupFailure.mock.callCount(), 0);
  assert.equal(s.lifecycle.onFailure.mock.callCount(), 1);
  assert.equal(s.failureSnapshots[0].ai.length, 0); assert.equal(s.failureSnapshots[0].registry.npc, undefined);
  assert.equal(s.failureSnapshots[0].disposeCalls, 1);
  assert.equal(s.lifecycle.onSpawnTaskSettled.mock.callCount(), 1); assert.equal(s.pendingTask, false);
  assert.ok(s.events.indexOf("dispose") < s.events.indexOf("failure"));
  assert.equal(s.events.at(-1), "task-settled");
  if (s.savedClaim) assert.throws(() => s.savedClaim!(), /claimed synchronously/);
  assert.equal(s.resource.dispose.mock.callCount(), 1);
});

for (const fault of ["after-claim", "publish"] as const)
test(`failure ${fault} is lease-owned and never disposed again by the creator`, async t => {
  const s = setup(t); s.faults.add(fault); s.faults.add("dispose"); await s.begin(); await s.complete();
  assert.equal(s.npc, s.constructed[0]); assert.equal(s.lifecycle.onFailure.mock.callCount(), 1);
  assert.equal(s.failureSnapshots[0].disposeCalls, 0); assert.equal(s.resource.dispose.mock.callCount(), 1);
  assert.equal(s.ownedDisposalFailed, true); assert.equal(s.server.deleteEntity.mock.callCount(), 0);
  assert.equal(s.lifecycle.onUnpublishedCleanupFailure.mock.callCount(), 0);
  assert.equal(s.ai.has(s.npc), false); assert.equal(s.server._npcs.npc, undefined);
  assert.equal(s.client.spawnedEntities.has(s.npc), false);
  assert.equal(s.lifecycle.onSpawnTaskSettled.mock.callCount(), 1); assert.equal(s.pendingTask, false);
  assert.throws(() => s.savedClaim!(), /claimed synchronously/);
  assert.equal(s.resource.dispose.mock.callCount(), 1);
});

for (const fault of ["remove-ai", "delete-entity"] as const)
test(`failed creator ${fault} cleanup reports the captured NPC before failure and settlement`, async t => {
  const s = setup(t); s.faults.add("facing"); s.faults.add(fault); await s.begin(); await s.complete();
  const details = s.lifecycle.onUnpublishedCleanupFailure.mock.calls[0].arguments[0];
  assert.equal(details.npc, s.constructed[0]); assert.equal(details.npcCleanupFailed, true);
  assert.equal(details.routeResource, s.resource); assert.equal(details.routeDisposalAttempted, true);
  assert.equal(details.routeDisposalFailed, false); assert.equal(s.resource.dispose.mock.callCount(), 1);
  assert.equal(s.failureSnapshots[0].cleanupReports, 1);
  assert.ok(s.events.indexOf("cleanup-failure") < s.events.indexOf("failure"));
  assert.equal(s.events.at(-1), "task-settled");
  if (fault === "delete-entity") assert.equal(s.server._npcs.npc, s.constructed[0]);
});

test("creator reports both failures without retrying an attempted native destructor", async t => {
  const s = setup(t); for (const fault of ["facing", "delete-entity", "dispose"]) s.faults.add(fault);
  await s.begin(); await s.complete();
  const details = s.lifecycle.onUnpublishedCleanupFailure.mock.calls[0].arguments[0];
  assert.equal(details.npc, s.constructed[0]); assert.equal(details.npcCleanupFailed, true);
  assert.equal(details.routeDisposalAttempted, true); assert.equal(details.routeDisposalFailed, true);
  assert.equal(s.resource.dispose.mock.callCount(), 1); assert.equal(s.lifecycle.onSpawnTaskSettled.mock.callCount(), 1);
  t.mock.timers.tick(1000); await flush(); assert.equal(s.resource.dispose.mock.callCount(), 1);
});

for (const reason of ["cancel", "disconnect", "death", "respawn"] as const)
test(`late async ${reason} disposal failure reports its original lifetime before settling`, async t => {
  const s = setup(t); await s.begin(); s.faults.add("dispose");
  if (reason === "cancel") s.cancel();
  if (reason === "disconnect") delete s.server._clients[1];
  if (reason === "death") s.client.character.isAlive = false;
  if (reason === "respawn") s.client.character.isRespawning = true;
  assert.equal(s.pendingTask, true); await s.complete();
  assert.equal(s.lifecycle.onUnpublishedCleanupFailure.mock.callCount(), 1);
  const details = s.lifecycle.onUnpublishedCleanupFailure.mock.calls[0].arguments[0];
  assert.equal(details.npc, undefined); assert.equal(details.npcCleanupFailed, false);
  assert.equal(details.routeResource, s.resource); assert.equal(details.routeDisposalAttempted, true);
  assert.equal(details.routeDisposalFailed, true); assert.equal(s.resource.dispose.mock.callCount(), 1);
  assert.equal(s.failureSnapshots[0].cleanupReports, 1);
  assert.equal(s.lifecycle.onSpawnTaskSettled.mock.callCount(), 1); assert.equal(s.pendingTask, false);
  assert.equal(s.server._npcs.old, s.oldNpc); assert.equal(s.constructed.length, 0);
  assert.equal(s.events.at(-1), "task-settled");
});

test("creator removes only its captured AI object when registry identity was replaced", async t => {
  const s = setup(t); const replacement = { characterId: "npc" };
  s.lifecycle.onSpawned.mock.mockImplementation(() => {
    s.server._npcs.npc = replacement; s.ai.add(replacement); throw Error("registry was replaced");
  });
  await s.begin(); await s.complete();
  assert.equal(s.ai.has(s.constructed[0]), false); assert.equal(s.ai.has(replacement), true);
  assert.equal(s.server._npcs.npc, replacement); assert.equal(s.server.deleteEntity.mock.callCount(), 0);
  assert.equal(s.server._lastSpawnedNpcCharacterId, "npc"); assert.equal(s.server._testZombieBySessionId[1], "npc");
  assert.equal(s.resource.dispose.mock.callCount(), 1); assert.equal(s.lifecycle.onSpawnTaskSettled.mock.callCount(), 1);
});

for (const fault of ["start-hook", "schedule"] as const)
test(`synchronous ${fault} failure settles its started gate without creating a task`, t => {
  const s = setup(t); s.faults.add(fault);
  assert.throws(() => s.module.exports.spawnTestZombieForClient(s.server, s.client, s.options), /failed/);
  assert.equal(s.lifecycle.onSpawnTaskStarted.mock.callCount(), 1);
  assert.equal(s.lifecycle.onSpawnTaskSettled.mock.callCount(), 1); assert.equal(s.pendingTask, false);
  assert.equal(s.loadTerrain.mock.callCount(), 0); assert.equal(s.resource.dispose.mock.callCount(), 0);
  assert.equal(s.lifecycle.onFailure.mock.callCount(), 1);
});

test("failed cleanup reporting retains the pending gate instead of claiming a clean settlement", async t => {
  const s = setup(t); await s.begin(); s.cancel(); s.faults.add("dispose"); s.faults.add("cleanup-report");
  await s.complete();
  assert.equal(s.resource.dispose.mock.callCount(), 1); assert.equal(s.lifecycle.onUnpublishedCleanupFailure.mock.callCount(), 1);
  assert.equal(s.lifecycle.onFailure.mock.callCount(), 1);
  assert.equal(s.lifecycle.onSpawnTaskSettled.mock.callCount(), 0); assert.equal(s.pendingTask, true);
  assert.ok(s.errors.some(args => String(args[0]).includes("保留创建中保护门")));
});

test("failed failure reporting still cleans the creator resources and retains its pending gate", async t => {
  const s = setup(t); s.faults.add("facing"); s.faults.add("failure-hook"); await s.begin(); await s.complete();
  assert.equal(s.ai.size, 0); assert.equal(s.server._npcs.npc, undefined); assert.equal(s.resource.dispose.mock.callCount(), 1);
  assert.equal(s.lifecycle.onSpawnTaskSettled.mock.callCount(), 0); assert.equal(s.pendingTask, true);
});

for (const sendFails of [false, true])
test(`unleased terrain preview ${sendFails ? "cleans a failed send" : "remains registry-owned after successful publication"}`, async t => {
  const s = setup(t); delete s.options.knownObstacle; delete s.options.lifecycle;
  if (sendFails) s.faults.add("publish"); await s.begin();
  assert.equal(s.constructed.length, 1); assert.equal(s.prepare.mock.callCount(), 0);
  assert.equal(s.ai.has(s.constructed[0]), false);
  assert.equal(s.server._npcs.npc, sendFails ? undefined : s.constructed[0]);
  assert.equal(s.server.deleteEntity.mock.callCount(), sendFails ? 1 : 0);
  assert.equal(s.lifecycle.onSpawnTaskStarted.mock.callCount(), 0);
  assert.equal(s.lifecycle.onSpawnTaskSettled.mock.callCount(), 0);
});
