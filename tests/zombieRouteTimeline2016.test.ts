import assert from "node:assert/strict";
import test, { TestContext } from "node:test";

// Explicit in-memory source mode permits pre-build regression; default still
// exercises the compiled business modules used by the normal test workflow.
const sourceMode = process.env.ZOMBIE_ROUTE_TIMELINE_SOURCE === "true";
const { Npc } = require(sourceMode ? "../src/servers/ZoneServer2016/entities/npc.ts" : "../out/servers/ZoneServer2016/entities/npc");
const { AiManager } = require(sourceMode ? "../src/servers/ZoneServer2016/managers/aimanager.ts" : "../out/servers/ZoneServer2016/managers/aimanager");
const { ModelIds } = require(sourceMode ? "../src/servers/ZoneServer2016/models/enums.ts" : "../out/servers/ZoneServer2016/models/enums");
const utils = require(sourceMode ? "../src/utils/utils.ts" : "../out/utils/utils");
const { packPositionUpdateData, readPositionUpdateData } = require(sourceMode ? "../src/packets/ClientProtocol/ClientProtocol_1080/shared.ts" : "../out/packets/ClientProtocol/ClientProtocol_1080/shared");

const wireXZ = (p: ArrayLike<number>) => [Math.round(p[0] * 100) / 100, Math.round(p[2] * 100) / 100];

// Real packet/timeline methods, without starting a server or invoking Npc's
// live constructor. The clock is the same utility that those methods consume.
function setup(t: TestContext, initialSequence = 1000) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 });
  const log = t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  let sequence = initialSequence >>> 0;
  let failSend = false;
  // Source modules expose read-only export getters under tsx. Mock the real
  // wrapper method instead, shared by both source and compiled clock callers.
  const clock = t.mock.method(utils.TimeWrapper.prototype, "getTruncatedU32", () => sequence);
  const send = t.mock.fn((_dictionary: unknown, _id: string, _name: string, _data: any) => {
    if (failSend) throw new Error("synthetic sender failure");
    // A void return is only a no-throw attempt, not delivery/acceptance evidence.
  });
  const server = {
    _npcs: {} as Record<string, any>, _lastSpawnedNpcCharacterId: "zombie",
    _testZombieChaseAttackCharacterId: "player", navManager: { isReady: false },
    getDevHttpPort: () => 13371, sendDataToAllWithSpawnedEntity: send
  };
  const npc: any = Object.assign({}, {
    characterId: "zombie", transientId: 42, movementVersion: 7,
    actorModelId: ModelIds.ZOMBIE_MALE_WALKER, isAlive: true, behaviorState: 1,
    testChaseSpeedScale: 1, testServerDrivenMovement: true, clientDrivenSeek: false,
    lastPositionBroadcastTime: 0, lastMeleeAttackTime: 0, lastSeekTargetUpdateTime: 0,
    testPositionTraceCount: 0, testRouteStopped: false,
    state: { position: new Float32Array([0, 0, 6]), rotation: new Float32Array([0, 0, 0, 1]) },
    testRouteStep: t.mock.fn((from: Float32Array, _target: Float32Array, budget: number) =>
      new Float32Array([from[0], from[1], from[2] - budget])),
    sendAggroLevel: t.mock.fn(), clearMovementController: t.mock.fn(),
    setFacingToward: t.mock.fn(() => true), seekTarget: t.mock.fn(), seekTargetUpdate: t.mock.fn(),
    triggerMeleeAttack: t.mock.fn(), applyDamage: t.mock.fn(), server
  });
  Object.setPrototypeOf(npc, Npc.prototype);
  const player = { characterId: "player", isAlive: true, isRespawning: false,
    state: { position: new Float32Array([0, 0, 0]) }, getHealth: () => 10000, isGodMode: () => false };
  server._npcs.zombie = npc;
  const ai = new AiManager(server);
  ai.npcEntities.add(npc);
  ai.playerEntities.add(player);
  const advance = (ms: number) => { sequence = (sequence + ms) >>> 0; t.mock.timers.tick(ms); };
  const setSequence = (value: number) => { sequence = value >>> 0; };
  const payload = (index = send.mock.callCount() - 1) => send.mock.calls[index].arguments[3].positionUpdate;
  const traces = () => log.mock.calls.map(c => String(c.arguments[0]))
    .filter(s => s.startsWith('{"event":"test_npc_position"')).map(s => JSON.parse(s));
  return { npc, ai, player, send, clock, payload, traces, advance, setSequence,
    fail: (value: boolean) => { failSend = value; } };
}

function commit(s: ReturnType<typeof setup>, motion: any, next?: Float32Array) {
  assert.ok(motion, "a movement requires a real primed stream interval");
  next ??= new Float32Array([s.npc.state.position[0], s.npc.state.position[1], s.npc.state.position[2] - 0.25]);
  const wire = wireXZ(next);
  const speed = Math.hypot(wire[0] - motion.previousPosition[0], wire[1] - motion.previousPosition[1]) / (motion.elapsedMs / 1000);
  assert.equal(s.npc.goTo(next, true, speed, motion), true);
  return s.payload();
}

test("a new route primes a stationary anchor; duplicate time neither moves nor reprimes", t => {
  const s = setup(t);
  const before = s.npc.state.position.slice();
  assert.equal(s.npc.beginTestRouteMotion(), undefined);
  assert.equal(s.send.mock.callCount(), 1);
  assert.equal(s.payload().sequenceTime, 1000);
  assert.equal(s.payload().horizontalSpeed, 0);
  assert.deepEqual(s.npc.state.position, before);
  assert.equal(s.npc.beginTestRouteMotion(), undefined);
  assert.equal(s.send.mock.callCount(), 1);
  s.advance(100);
  assert.deepEqual(s.npc.beginTestRouteMotion(), {
    sequenceTime: 1100, elapsedMs: 100, previousSequenceTime: 1000, previousPosition: [0, 6]
  });
  assert.deepEqual(s.npc.state.position, before);
});

test("nonpriming lookup never sends or mutates missing, stale, duplicate or unready anchors", t => {
  const s = setup(t);
  assert.equal(s.npc.beginTestRouteMotion(false), undefined);
  assert.equal(s.send.mock.callCount(), 0);
  assert.equal(s.npc.testRoutePacket, undefined);
  s.npc.beginTestRouteMotion();
  const anchor = s.npc.testRoutePacket;
  const position = s.npc.state.position;
  assert.equal(s.npc.beginTestRouteMotion(false), undefined);
  assert.equal(s.npc.testRoutePacket, anchor);
  s.advance(100);
  const valid = s.npc.beginTestRouteMotion(false);
  assert.equal(valid.elapsedMs, 100);
  valid.previousPosition[0] = 123; // Returned context cannot mutate the stored anchor.
  assert.deepEqual(s.npc.beginTestRouteMotion(false).previousPosition, [0, 6]);
  s.npc.movementVersion = 8;
  assert.equal(s.npc.beginTestRouteMotion(false), undefined);
  s.npc.movementVersion = 7;
  s.npc.state.position = new Float32Array([0.02, 0, 6]);
  assert.equal(s.npc.beginTestRouteMotion(false), undefined);
  s.npc.state.position = position;
  s.setSequence(900);
  assert.equal(s.npc.beginTestRouteMotion(false), undefined);
  assert.equal(s.npc.testRoutePacket, anchor);
  assert.equal(s.send.mock.callCount(), 1);
  s.setSequence(1100);
  s.npc.sendIdleStance();
  const idleAnchor = s.npc.testRoutePacket;
  s.advance(100);
  assert.equal(s.npc.beginTestRouteMotion(false), undefined);
  assert.equal(s.npc.testRoutePacket, idleAnchor);
  assert.equal(s.send.mock.callCount(), 2);
});

for (const elapsed of [63, 80]) {
  test(`AI ${elapsed}ms limits the queried raw step before quantized speed is formed`, t => {
    const s = setup(t);
    const before = s.npc.state.position.slice();
    s.ai.run();
    assert.equal(s.npc.testRouteStep.mock.callCount(), 1);
    assert.equal(s.npc.testRouteStep.mock.calls[0].arguments[2], 0.25);
    assert.deepEqual(s.npc.state.position, before, "first valid route only primes");
    s.advance(elapsed);
    s.ai.run();
    const budget = 2.5 * elapsed / 1000;
    assert.equal(s.npc.testRouteStep.mock.callCount(), 2, "one query per tick, not query then rescale/requery");
    assert.equal(s.npc.testRouteStep.mock.calls[1].arguments[2], budget);
    assert.equal(s.npc.state.position[2], Math.fround(6 - budget));
    const distance = Math.abs(s.npc.state.position[2] - before[2]);
    assert.ok(distance <= budget && distance < 0.25);
    const expected = Math.abs(wireXZ(s.npc.state.position)[1] - 6) / (elapsed / 1000);
    assert.equal(s.payload().horizontalSpeed, expected);
    assert.equal(s.payload().sequenceTime, 1000 + elapsed);
    assert.equal(s.traces()[0].elapsedMs, elapsed);
    assert.equal(s.npc.setFacingToward.mock.callCount(), 1);
    assert.deepEqual(s.npc.setFacingToward.mock.calls[0].arguments[0], s.npc.state.position);
  });
}

for (const elapsed of [100, 150, 200]) {
  test(`AI keeps the 0.25 route budget but declares wire displacement / ${elapsed}ms`, t => {
    const s = setup(t);
    s.ai.run();
    assert.equal(s.payload().horizontalSpeed, 0);
    s.advance(elapsed);
    s.ai.run();
    assert.deepEqual(Array.from(s.npc.state.position), [0, 0, 5.75]);
    assert.equal(s.npc.testRouteStep.mock.callCount(), 2);
    for (const call of s.npc.testRouteStep.mock.calls) assert.equal(call.arguments[2], 0.25);
    const p = s.payload();
    assert.equal(p.sequenceTime, 1000 + elapsed);
    assert.equal(p.horizontalSpeed, 0.25 / (elapsed / 1000));
    const decoded = readPositionUpdateData(packPositionUpdateData(p), 0).value;
    assert.deepEqual(decoded.position.slice(0, 3), [0, 0, 5.75]);
    assert.equal(decoded.horizontalSpeed, Math.round(p.horizontalSpeed * 10) / 10);
    assert.ok(Math.abs(decoded.horizontalSpeed - p.horizontalSpeed) <= 0.05 + 1e-12);
    assert.equal(s.traces()[0].elapsedMs, elapsed);
    assert.equal(s.traces()[0].phase, "send_attempt");
    assert.equal(s.npc.triggerMeleeAttack.mock.callCount(), 0);
  });
}

test("AI duplicate sequence time cannot consume another segment, even with forced broadcasts", t => {
  const s = setup(t);
  s.ai.run();
  s.advance(100);
  s.ai.run();
  const before = s.npc.state.position.slice();
  for (let i = 0; i < 3; i++) s.ai.run();
  assert.deepEqual(s.npc.state.position, before);
  assert.equal(s.send.mock.callCount(), 2);
  s.advance(100);
  s.ai.run();
  assert.equal(s.send.mock.callCount(), 3);
  assert.equal(s.payload().horizontalSpeed, 2.5);
});

test("goTo carries the captured sequenceTime unchanged and commits only its no-throw attempt", t => {
  const s = setup(t);
  s.npc.beginTestRouteMotion();
  s.advance(100);
  const motion = s.npc.beginTestRouteMotion();
  const calls = s.clock.mock.callCount();
  s.setSequence(1127);
  const p = commit(s, motion);
  assert.equal(p.sequenceTime, 1100, "do not take a later clock sample inside goTo");
  assert.equal(s.clock.mock.callCount(), calls);
  assert.deepEqual(s.npc.beginTestRouteMotion(), {
    sequenceTime: 1127, elapsedMs: 27, previousSequenceTime: 1100, previousPosition: [0, 5.75]
  });
  const trace = s.traces()[0];
  assert.equal(trace.speedBasis, "quantized_xz_sequence_interval");
  assert.equal(trace.previousSequenceTime, 1000);
  assert.deepEqual(trace.previousWireXZ, [0, 6]);
  assert.equal("acknowledged" in trace, false);
  assert.equal("success" in trace, false);
});

test("u32 wrap is a positive short interval, not a restart", t => {
  const s = setup(t, 0xfffffff0);
  s.npc.beginTestRouteMotion();
  s.advance(100);
  const motion = s.npc.beginTestRouteMotion();
  assert.equal(motion.sequenceTime, 84);
  assert.equal(motion.previousSequenceTime, 0xfffffff0);
  assert.equal(motion.elapsedMs, 100);
  assert.equal(commit(s, motion).sequenceTime, 84);
  assert.equal(s.send.mock.callCount(), 2);
});

test("AI short-dt budget survives u32 wrap and does not advance a duplicate wrapped timestamp", t => {
  const s = setup(t, 0xfffffff0);
  s.ai.run();
  s.advance(63);
  s.ai.run();
  assert.equal(s.npc.testRouteStep.mock.calls[1].arguments[2], 0.1575);
  assert.equal(s.payload().sequenceTime, 47);
  assert.equal(s.traces()[0].elapsedMs, 63);
  const before = s.npc.state.position.slice(), anchor = s.npc.testRoutePacket;
  s.ai.run();
  assert.deepEqual(s.npc.state.position, before);
  assert.equal(s.send.mock.callCount(), 2);
  assert.equal(s.npc.testRoutePacket, anchor);
});

test("clock rollback and the unsigned half-range reanchor instead of inventing a huge interval", t => {
  const s = setup(t);
  s.npc.beginTestRouteMotion();
  s.setSequence(900);
  assert.equal(s.npc.beginTestRouteMotion(), undefined);
  assert.equal(s.payload().sequenceTime, 900);
  assert.equal(s.payload().horizontalSpeed, 0);
  s.advance(100);
  assert.equal(s.npc.beginTestRouteMotion().elapsedMs, 100);
  s.setSequence((900 + 0x80000000) >>> 0);
  assert.equal(s.npc.beginTestRouteMotion(), undefined);
  assert.equal(s.send.mock.callCount(), 3);
  assert.deepEqual(Array.from(s.npc.state.position), [0, 0, 6]);
});

test("ordinary idle and a long stopped pause cannot become the next moving interval", t => {
  const s = setup(t);
  s.npc.beginTestRouteMotion();
  s.advance(100);
  commit(s, s.npc.beginTestRouteMotion());
  s.advance(50);
  s.npc.sendIdleStance();
  const stopped = s.npc.state.position.slice();
  s.advance(5000);
  assert.equal(s.npc.beginTestRouteMotion(), undefined, "restart emits a new stationary anchor");
  assert.equal(s.payload().sequenceTime, 6150);
  assert.equal(s.payload().horizontalSpeed, 0);
  assert.deepEqual(s.npc.state.position, stopped);
  s.advance(100);
  const motion = s.npc.beginTestRouteMotion();
  assert.equal(motion.previousSequenceTime, 6150);
  assert.equal(motion.elapsedMs, 100);
  assert.equal(commit(s, motion).horizontalSpeed, 2.5);
});

test("movement version or externally changed wire endpoint requires a fresh idle anchor", t => {
  const s = setup(t);
  s.npc.beginTestRouteMotion();
  s.advance(100);
  s.npc.movementVersion = 8;
  assert.equal(s.npc.beginTestRouteMotion(), undefined);
  assert.equal(s.payload().unknown3_int8, 8);
  s.advance(100);
  assert.equal(s.npc.beginTestRouteMotion().elapsedMs, 100);
  s.npc.state.position = new Float32Array([0.02, 0, 6]);
  assert.equal(s.npc.beginTestRouteMotion(), undefined);
  assert.deepEqual(wireXZ(s.payload().position), [0.02, 6]);
  s.advance(100);
  assert.deepEqual(s.npc.beginTestRouteMotion().previousPosition, [0.02, 6]);
});

test("wire-grid endpoints, not unquantized Float32 differences, determine route speed", t => {
  const s = setup(t);
  s.npc.state.position = new Float32Array([1.004, 2, -3.004]);
  s.npc.beginTestRouteMotion();
  const first = readPositionUpdateData(packPositionUpdateData(s.payload()), 0).value;
  s.advance(150);
  const motion = s.npc.beginTestRouteMotion();
  assert.deepEqual(motion.previousPosition, [1, -3]);
  const next = new Float32Array([1.006, 2.2, -3.206]);
  const p = commit(s, motion, next);
  const last = readPositionUpdateData(packPositionUpdateData(p), 0).value;
  const expected = Math.hypot(last.position[0] - first.position[0], last.position[2] - first.position[2]) / 0.15;
  assert.equal(p.horizontalSpeed, expected);
  assert.notEqual(p.horizontalSpeed, Math.hypot(next[0] - Math.fround(1.004), next[2] - Math.fround(-3.004)) / 0.15);
  assert.equal(last.horizontalSpeed, Math.round(expected * 10) / 10);
});

test("failed moving send rolls AI position back; recovery primes before another segment", t => {
  const s = setup(t);
  s.ai.run();
  s.advance(100);
  s.fail(true);
  const before = s.npc.state.position.slice();
  assert.doesNotThrow(() => s.ai.run());
  assert.deepEqual(s.npc.state.position, before);
  assert.equal(s.traces().length, 1, "failure still has only send_attempt evidence");
  assert.equal(s.traces()[0].phase, "send_attempt");
  s.fail(false);
  s.advance(100);
  s.ai.run();
  assert.deepEqual(s.npc.state.position, before);
  assert.equal(s.payload().horizontalSpeed, 0);
  s.advance(100);
  s.ai.run();
  assert.equal(s.npc.state.position[2], 5.75);
  assert.equal(s.payload().horizontalSpeed, 2.5);
  assert.equal(s.traces()[1].elapsedMs, 100, "failed interval must not remain the baseline");
});

test("failed short-dt send rolls back without saving its distance as catch-up debt", t => {
  const s = setup(t);
  s.ai.run();
  s.advance(63);
  s.fail(true);
  s.ai.run();
  assert.equal(s.npc.state.position[2], 6);
  assert.equal(s.npc.testRoutePacket, undefined);
  assert.equal(s.traces()[0].elapsedMs, 63);
  s.fail(false);
  s.advance(500);
  s.ai.run();
  assert.equal(s.npc.state.position[2], 6, "recovery only primes at the current location");
  s.advance(80);
  s.ai.run();
  assert.equal(s.npc.testRouteStep.mock.calls[3].arguments[2], 0.2);
  assert.equal(s.npc.state.position[2], Math.fround(5.8));
  assert.equal(s.traces()[1].elapsedMs, 80);
});

test("failed prime sender never marks the stream ready", t => {
  const s = setup(t);
  s.fail(true);
  assert.throws(() => s.npc.beginTestRouteMotion(), /synthetic sender failure/);
  s.fail(false);
  s.advance(100);
  assert.equal(s.npc.beginTestRouteMotion(), undefined);
  assert.equal(s.payload().horizontalSpeed, 0);
  s.advance(100);
  assert.equal(s.npc.beginTestRouteMotion().elapsedMs, 100);
  assert.deepEqual(Array.from(s.npc.state.position), [0, 0, 6]);
});

test("a legacy no-context route send keeps its speed and invalidates the timeline", t => {
  const s = setup(t);
  s.npc.beginTestRouteMotion();
  s.advance(100);
  assert.equal(s.npc.goTo(new Float32Array([0, 0, 5.9]), true, 0.75), true);
  assert.equal(s.payload().horizontalSpeed, 0.75);
  s.advance(100);
  assert.equal(s.npc.beginTestRouteMotion(), undefined);
  assert.equal(s.payload().horizontalSpeed, 0);
  s.advance(100);
  assert.equal(s.npc.beginTestRouteMotion().elapsedMs, 100);
});

test("ordinary NPC and non-route movement retain the old packet speed and throttle", t => {
  const s = setup(t);
  s.npc.testServerDrivenMovement = false;
  assert.equal(s.npc.beginTestRouteMotion(), undefined);
  assert.equal(s.send.mock.callCount(), 0);
  s.npc.goTo(new Float32Array([0, 0, 5.75]), true, 0.2);
  assert.equal(s.payload().horizontalSpeed, 2.5);
  s.npc.goTo(new Float32Array([0, 0, 5.5]));
  assert.equal(s.send.mock.callCount(), 1);
  s.npc.testServerDrivenMovement = true;
  s.npc.testRouteStep = undefined;
  assert.equal(s.npc.beginTestRouteMotion(), undefined);
  s.npc.goTo(new Float32Array([0, 0, 5.25]), true, 0.2);
  assert.equal(s.payload().horizontalSpeed, 2.5);
  assert.equal(s.send.mock.callCount(), 2);
});

test("non-server-driven AI route keeps nominal budgeting without priming", t => {
  const s = setup(t);
  s.npc.testServerDrivenMovement = false;
  const peek = t.mock.method(s.npc, "beginTestRouteMotion");
  s.ai.run();
  assert.equal(s.npc.state.position[2], 5.75);
  assert.equal(s.send.mock.callCount(), 1);
  s.advance(63);
  s.ai.run();
  assert.equal(s.npc.state.position[2], 5.5);
  assert.equal(s.npc.testRouteStep.mock.callCount(), 2);
  for (const call of s.npc.testRouteStep.mock.calls) assert.equal(call.arguments[2], 0.25);
  assert.equal(peek.mock.callCount(), 0);
  assert.equal(s.payload().horizontalSpeed, 2.5);
});

test("a context invalidated by ordinary idle cannot commit as moving", t => {
  const s = setup(t);
  s.npc.beginTestRouteMotion();
  s.advance(100);
  const motion = s.npc.beginTestRouteMotion();
  s.npc.sendIdleStance();
  const count = s.send.mock.callCount();
  assert.equal(s.npc.goTo(new Float32Array([0, 0, 5.75]), true, 2.5, motion), false);
  assert.equal(s.send.mock.callCount(), count);
  s.advance(100);
  assert.equal(s.npc.beginTestRouteMotion(), undefined);
  assert.equal(s.payload().horizontalSpeed, 0);
});

test("unknown/invalid route stays stopped; valid recovery reprimes without weakening the route guard", t => {
  const s = setup(t);
  let result: Float32Array | undefined;
  s.npc.testRouteStep = () => result;
  for (result of [undefined, new Float32Array([0, NaN, 6]), new Float32Array([0, 0, 5])]) {
    s.ai.run();
    assert.deepEqual(Array.from(s.npc.state.position), [0, 0, 6]);
    assert.equal(s.send.mock.callCount(), 1);
    assert.equal(s.payload().horizontalSpeed, 0);
  }
  result = new Float32Array([0, 0, 5.75]);
  s.advance(100);
  s.ai.run();
  assert.equal(s.send.mock.callCount(), 2);
  assert.deepEqual(Array.from(s.npc.state.position), [0, 0, 6]);
  s.advance(100);
  s.ai.run();
  assert.equal(s.payload().horizontalSpeed, 2.5);
  assert.equal(s.npc.state.position[2], 5.75);
});

test("persistent unknown routes do not prime or repeat idle; recovery primes then takes one short step", t => {
  const s = setup(t);
  let valid = false;
  s.npc.testRouteStep = t.mock.fn((from: Float32Array, _target: Float32Array, budget: number) =>
    valid ? new Float32Array([from[0], from[1], from[2] - budget]) : undefined);
  for (let i = 0; i < 8; i++) { s.ai.run(); s.advance(100); }
  assert.equal(s.send.mock.callCount(), 1);
  assert.equal(s.npc.testRouteStep.mock.callCount(), 8);
  assert.equal(s.npc.testRoutePacket, undefined);
  assert.equal(s.npc.state.position[2], 6);
  valid = true;
  s.ai.run();
  assert.equal(s.send.mock.callCount(), 2);
  assert.equal(s.payload().horizontalSpeed, 0);
  assert.equal(s.npc.state.position[2], 6);
  s.advance(63);
  s.ai.run();
  assert.equal(s.npc.testRouteStep.mock.callCount(), 10);
  assert.equal(s.npc.testRouteStep.mock.calls[9].arguments[2], 0.1575);
  assert.equal(s.traces()[0].elapsedMs, 63, "stopped time is not the movement interval");
});

test("a route lost just after recovery-prime discards that anchor even when already stopped", t => {
  const s = setup(t);
  let valid = false;
  s.npc.testRouteStep = (from: Float32Array, _target: Float32Array, budget: number) =>
    valid ? new Float32Array([from[0], from[1], from[2] - budget]) : undefined;
  s.ai.run();
  valid = true;
  s.advance(100);
  s.ai.run();
  assert.equal(s.npc.testRouteStopped, true);
  assert.equal(s.npc.testRoutePacket.ready, true);
  assert.equal(s.send.mock.callCount(), 2);
  valid = false;
  s.advance(63);
  s.ai.run();
  assert.equal(s.npc.testRoutePacket, undefined);
  assert.equal(s.send.mock.callCount(), 2, "do not repeat idle while the route is still stopped");
  s.advance(200);
  s.ai.run();
  assert.equal(s.send.mock.callCount(), 2);
  valid = true;
  s.advance(100);
  s.ai.run();
  assert.equal(s.send.mock.callCount(), 3);
  assert.equal(s.npc.state.position[2], 6);
  s.advance(80);
  s.ai.run();
  assert.equal(s.npc.state.position[2], Math.fround(5.8));
  assert.equal(s.traces()[0].elapsedMs, 80);
});
