import assert from "node:assert/strict";
import test, { TestContext } from "node:test";

// Exercise the built server, as the packet tests do, without starting a zone.
const { AiManager, moveTowardTarget } = require("../out/servers/ZoneServer2016/managers/aimanager");
const { Npc } = require("../out/servers/ZoneServer2016/entities/npc");
const { ModelIds } = require("../out/servers/ZoneServer2016/models/enums");
const { armTestZombieOnFullData, recordTestZombieClockSample } = require("../out/servers/ZoneServer2016/test-zombie-in-front");

function readinessSetup(t: TestContext, noAi = false) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 });
  t.mock.method(console, "log", () => {});
  const client = { sessionId: 1, testZombieSpawned: true,
    testZombieClockReadyAt: undefined as number | undefined,
    testZombieClockDiagnostics: undefined as object | undefined,
    character: { characterId: "player", isAlive: true, isRespawning: false } };
  const npc = { characterId: "zombie", isAlive: true, testServerDrivenMovement: true,
    clearMovementController: t.mock.fn(), sendIdleStance: t.mock.fn(),
    sendLocomotionState: t.mock.fn(),
    pGetFull: () => ({}), onReadyCallback: undefined as undefined | ((client: unknown) => void) };
  const server = {
    _npcs: { zombie: npc } as Record<string, typeof npc>,
    _clients: { 1: client } as Record<number, typeof client>,
    sendData: t.mock.fn(),
    sendStandardFullNpcInit: t.mock.fn(),
    aiManager: { playerEntities: new Set(), addEntity: t.mock.fn() }
  };
  armTestZombieOnFullData(server, client, npc, { noAi, addAiDelayMs: 750 });
  const requestFull = () => Npc.prototype.OnFullCharacterDataRequest.call(npc, server, client);
  return { server, client, npc, requestFull };
}

test("test zombie waits for full-data request and arms only once", (t) => {
  const { server, client, npc, requestFull } = readinessSetup(t);
  t.mock.timers.tick(10000);
  assert.equal(server.aiManager.addEntity.mock.callCount(), 0);
  assert.equal(server.sendStandardFullNpcInit.mock.callCount(), 0);
  requestFull();
  requestFull();
  assert.equal(server.sendStandardFullNpcInit.mock.callCount(), 1);
  recordTestZombieClockSample(client, 20000, 20000);
  t.mock.timers.tick(749);
  assert.equal(server.aiManager.addEntity.mock.callCount(), 0);
  assert.equal(npc.clearMovementController.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.deepEqual(npc.clearMovementController.mock.calls.map(c => c.arguments), [[true]]);
  assert.equal(npc.sendIdleStance.mock.callCount(), 1);
  assert.deepEqual(server.aiManager.addEntity.mock.calls.map(c => c.arguments[0]), [client.character, npc]);
});

test("full NPC data alone does not start pursuit before the inbound clock is aligned", (t) => {
  const { server, client, npc, requestFull } = readinessSetup(t);
  requestFull();
  recordTestZombieClockSample(client, 914060269, 725143);
  t.mock.timers.tick(750);
  assert.equal(server.aiManager.addEntity.mock.callCount(), 0);
  assert.equal(npc.clearMovementController.mock.callCount(), 0);
  recordTestZombieClockSample(client, 726107, 726157);
  t.mock.timers.tick(100);
  assert.equal(npc.clearMovementController.mock.callCount(), 1);
  assert.equal(server.aiManager.addEntity.mock.callCount(), 2);
  t.mock.timers.tick(1000);
  assert.equal(server.aiManager.addEntity.mock.callCount(), 2);
});

test("late aligned clock recovers a timed-out encounter without starting early", (t) => {
  const { server, client, npc, requestFull } = readinessSetup(t);
  requestFull();
  t.mock.timers.tick(31000);
  assert.equal(server.aiManager.addEntity.mock.callCount(), 0);
  assert.equal(npc.clearMovementController.mock.callCount(), 0);
  recordTestZombieClockSample(client, 41000, 41000);
  t.mock.timers.tick(1000);
  assert.equal(server.aiManager.addEntity.mock.callCount(), 2);
  t.mock.timers.tick(5000);
  assert.equal(server.aiManager.addEntity.mock.callCount(), 2);
});

test("timed-out clock wait stops after player disconnects", (t) => {
  const { server, client, requestFull } = readinessSetup(t);
  requestFull();
  t.mock.timers.tick(31000);
  delete server._clients[1];
  recordTestZombieClockSample(client, 41000, 41000);
  t.mock.timers.tick(1000);
  assert.equal(server.aiManager.addEntity.mock.callCount(), 0);
});

test("clock samples reject invalid and stale values and accept uint32 wrap", (t) => {
  const { server, client, requestFull } = readinessSetup(t);
  for (const value of [undefined, NaN, -1, 1.5, 0x100000000, 914060269]) {
    recordTestZombieClockSample(client, value, 725143);
    assert.equal(client.testZombieClockReadyAt, undefined);
  }
  recordTestZombieClockSample(client, 0xfffffff0, 32);
  assert.equal(client.testZombieClockReadyAt, Date.now());
  t.mock.timers.tick(2000);
  requestFull();
  t.mock.timers.tick(750);
  assert.equal(server.aiManager.addEntity.mock.callCount(), 0);
});

test("removed test zombie cannot start after full-data request", (t) => {
  const { server, requestFull } = readinessSetup(t);
  requestFull();
  delete server._npcs.zombie;
  t.mock.timers.tick(750);
  assert.equal(server.aiManager.addEntity.mock.callCount(), 0);
});

test("clock diagnostics distinguish absent, stance-only, malformed and misaligned samples", (t) => {
  const { client } = readinessSetup(t);
  assert.equal(client.testZombieClockDiagnostics, undefined);
  recordTestZombieClockSample(client, 10000, 10000, 513);
  recordTestZombieClockSample(client, NaN, 10000, 2);
  recordTestZombieClockSample(client, 14000, 10000, 2);
  recordTestZombieClockSample(client, 10000, 10000, 2);
  assert.deepEqual(client.testZombieClockDiagnostics, {
    samples: 4, stanceRotationSamples: 1, invalid: 1, misaligned: 1, aligned: 2,
    lastReceivedAt: 10000, lastFlags: 2, lastSequenceTime: 10000,
    lastServerTime: 10000, lastDeltaMs: 0, lastResult: "aligned"
  });
});

test("stance-only clocks must align just like position clocks", (t) => {
  const { server, client, requestFull } = readinessSetup(t);
  requestFull();
  recordTestZombieClockSample(client, 12000, 10000, 513);
  t.mock.timers.tick(750);
  assert.equal(server.aiManager.addEntity.mock.callCount(), 0);
  recordTestZombieClockSample(client, 10750, 10750, 513);
  t.mock.timers.tick(100);
  assert.equal(server.aiManager.addEntity.mock.callCount(), 2);
});

test("disconnected player cannot arm a pending test encounter", (t) => {
  const { server, requestFull } = readinessSetup(t);
  requestFull();
  delete server._clients[1];
  t.mock.timers.tick(750);
  assert.equal(server.aiManager.addEntity.mock.callCount(), 0);
});

test("no-AI diagnostic mode still stays idle after full-data request", (t) => {
  const { server, requestFull } = readinessSetup(t, true);
  requestFull();
  t.mock.timers.tick(10000);
  assert.equal(server.aiManager.addEntity.mock.callCount(), 0);
});

test("zombie seek sends a normalized target direction instead of a quaternion", (t) => {
  const send = t.mock.fn();
  const npc = {
    characterId: "zombie", lastSeekTargetId: null, testChaseSpeedScale: 1,
    state: { position: new Float32Array([10, 20, 30]), rotation: new Float32Array([0, 0, 0, 1]) },
    server: { _npcs: {}, sendDataToAllWithSpawnedEntity: send }
  };
  const target = new Float32Array([13, 99, 26]);
  Npc.prototype.seekTarget.call(npc, "player", target);
  const [,, packet, data] = send.mock.calls[1].arguments;
  assert.equal(packet, "Character.SeekTarget");
  assert.equal(data.TargetCharacterId, "player");
  assert.deepEqual(Array.from(data.rotation), Array.from(new Float32Array([0.6, 0, -0.8, 0])));
  Npc.prototype.seekTarget.call(npc, "player", target);
  assert.equal(send.mock.callCount(), 2, "same target does not reinstall the controller");
});

test("zombie seek does not initialize an undefined horizontal direction", (t) => {
  const send = t.mock.fn();
  const npc = {
    characterId: "zombie", lastSeekTargetId: null, testChaseSpeedScale: 1,
    state: { position: new Float32Array([10, 20, 30]) },
    server: { _npcs: {}, sendDataToAllWithSpawnedEntity: send }
  };
  Npc.prototype.seekTarget.call(npc, "player", new Float32Array([10, 99, 30]));
  assert.equal(send.mock.callCount(), 0);
  assert.equal(npc.lastSeekTargetId, null);
});

test("spawn-controller reset sends clear even without a previous server seek", (t) => {
  const send = t.mock.fn();
  const npc = { characterId: "zombie", lastSeekTargetId: null, lastSeekTargetUpdateTime: 0,
    server: { _npcs: {}, sendDataToAllWithSpawnedEntity: send } };
  Npc.prototype.clearMovementController.call(npc);
  assert.equal(send.mock.callCount(), 0);
  Npc.prototype.clearMovementController.call(npc, true);
  assert.equal(send.mock.calls[0].arguments[2], "Character.ClearMovementRail");
});

test("NPC idle position carries the declared movement version", (t) => {
  const send = t.mock.fn();
  Npc.prototype.sendIdleStance.call({ characterId: "zombie", transientId: 42, movementVersion: 1,
    state: { position: new Float32Array([1, 2, 3]), rotation: new Float32Array([0, 0, 0, 1]) },
    server: { _npcs: {}, sendDataToAllWithSpawnedEntity: send } });
  assert.equal(send.mock.calls[0].arguments[3].positionUpdate.unknown3_int8, 1);
});

test("zombie melee emits the verified native event, not a rooted state pulse", (t) => {
  const send = t.mock.fn();
  const npcs = {};
  Npc.prototype.triggerMeleeAttack.call({
    characterId: "zombie",
    server: { _npcs: npcs, sendDataToAllWithSpawnedEntity: send }
  });
  assert.equal(send.mock.callCount(), 1);
  assert.deepEqual(send.mock.calls[0].arguments, [
    npcs, "zombie", "Character.PlayAnimation", {
      characterId: "zombie", animationName: "KnifeSlash", unm4: 0,
      unknownDword1: 0, unknownByte1: 0, unknownDword2: 1430,
      animationType: "", unknownByte1xda: 0, unknownDword3: 0
    }
  ]);
});

test("NPC melee profile follows the item, weapon, fire-group and fire-mode definitions", () => {
  const profile = Npc.prototype.getMeleeAttackProfile.call({
    meleeWeaponItemDefinitionId: 83,
    server: {
      getItemDefinition: () => ({ PARAM1: 10 }),
      getWeaponDefinition: () => ({
        MELEE_DETECT: { MELEE_DETECT_WIDTH: 0.15, MELEE_DETECT_HEIGHT: 0.1 },
        FIRE_GROUPS: [{ FIRE_GROUP_ID: 10 }]
      }),
      getFiregroupDefinition: () => ({ FIRE_MODES: [{ FIRE_MODE_ID: 13 }] }),
      getFiremodeDefinition: () => ({ RANGE: 1.5, FIRE_DURATION_MS: 850, REFIRE_TIME_MS: 125 })
    }
  } as any);
  assert.deepEqual(profile, {
    itemDefinitionId: 83, weaponDefinitionId: 10, fireGroupId: 10, fireModeId: 13,
    range: 1.5, detectWidth: 0.15, detectHeight: 0.1,
    fireDurationMs: 850, refireTimeMs: 125
  });
});

test("NPC damage report identifies the NPC source and its impact origin", (t) => {
  const onMeleeHit = t.mock.fn();
  const origin = new Float32Array([1, 2, 3]);
  Npc.prototype.applyDamage.call({
    characterId: "zombie", meleeWeaponItemDefinitionId: 83, npcMeleeDamage: 2000,
    state: { position: origin },
    server: {
      getClientByCharId: () => ({ character: { characterId: "player", OnMeleeHit: onMeleeHit } })
    }
  } as any, "player");
  const info = onMeleeHit.mock.calls[0].arguments[1] as any;
  assert.equal(info.hitReport.characterId, "zombie");
  assert.deepEqual(Array.from(info.hitReport.position), [1, 2, 3]);
  assert.equal(info.weapon, 83);
});

test("NPC protected melee feedback reuses the source/impact context without OnMeleeHit", (t) => {
  const sendDamageFeedback = t.mock.fn(() => true);
  const origin = new Float32Array([4, 5, 6]);
  const npc = {
    characterId: "zombie", meleeWeaponItemDefinitionId: 83, npcMeleeDamage: 2000,
    state: { position: origin },
    server: {
      getClientByCharId: () => ({ character: { sendDamageFeedback } })
    }
  };
  assert.equal(Npc.prototype.sendMeleeDamageFeedback.call(npc as any, "player"), true);
  assert.equal(sendDamageFeedback.mock.callCount(), 1);
  const [, info] = sendDamageFeedback.mock.calls[0].arguments;
  assert.equal(info.entity, "zombie");
  assert.equal(info.weapon, 83);
  assert.deepEqual(Array.from(info.hitReport.position), [4, 5, 6]);
});

function setup(t: TestContext, distance = 2) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 });
  const log = t.mock.method(console, "log", () => {});
  let health = 10000;
  const player = {
    characterId: "player",
    isAlive: true,
    isRespawning: false,
    state: { position: new Float32Array([0, 0, 0]) },
    getHealth: () => health,
    isGodMode: () => false
  };
  const npc = {
    characterId: "zombie",
    actorModelId: ModelIds.ZOMBIE_MALE_WALKER,
    isAlive: true,
    behaviorState: 0,
    lastMeleeAttackTime: 0,
    lastSeekTargetUpdateTime: 0,
    testChaseSpeedScale: 1,
    clientDrivenSeek: false,
    suppressServerPositionBroadcast: false,
    state: { position: new Float32Array([0, 0, distance]) },
    sendAggroLevel: t.mock.fn(),
    sendIdleStance: t.mock.fn(),
    sendLocomotionState: t.mock.fn(),
    clearMovementController: t.mock.fn(),
    setFacingToward: t.mock.fn(() => true),
    seekTarget: t.mock.fn(),
    seekTargetUpdate: t.mock.fn(),
    triggerMeleeAttack: t.mock.fn(),
    goTo: t.mock.fn(),
    // Test double for the authoritative machete item -> weapon -> fire mode
    // chain. Individual tests override RANGE/MELEE_DETECT when exercising the
    // contact gates; production resolves these values from ServerWeaponDefinitions.
    getMeleeAttackProfile: () => ({
      itemDefinitionId: 83, weaponDefinitionId: 10, fireGroupId: 10, fireModeId: 13,
      range: 2.5, detectWidth: 1, detectHeight: 1,
      fireDurationMs: 850, refireTimeMs: 125
    }),
    applyDamage: t.mock.fn((characterId: string) => {
      assert.equal(characterId, player.characterId);
      health -= 1000;
    })
  };
  const npcs: Record<string, typeof npc> = { [npc.characterId]: npc };
  const server = {
    navManager: { isReady: false },
    getDevHttpPort: () => 13371,
    _lastSpawnedNpcCharacterId: npc.characterId,
    _testZombieChaseAttackCharacterId: player.characterId,
    _npcs: npcs
  };
  const ai = new AiManager(server);
  ai.playerEntities.add(player);
  ai.npcEntities.add(npc);
  return { ai, npc, player, server, log };
}

function attachRoutePacketMethods(t: TestContext, s: ReturnType<typeof setup>) {
  const send = t.mock.fn();
  const utils = require("../out/utils/utils");
  t.mock.method(utils, "getCurrentServerTimeWrapper", () => ({
    getTruncatedU32: () => Date.now() >>> 0
  }));
  Object.assign(s.server, { sendDataToAllWithSpawnedEntity: send });
  Object.setPrototypeOf(s.npc, Npc.prototype);
  Object.assign(s.npc, {
    server: s.server, transientId: 42, movementVersion: 7,
    lastPositionBroadcastTime: 0, testServerDrivenMovement: true,
    clientDrivenSeek: false, testPositionTraceCount: 0,
    state: { position: s.npc.state.position, rotation: new Float32Array([0, 0, 0, 1]) },
    beginTestRouteMotion: Npc.prototype.beginTestRouteMotion,
    setFacingToward: t.mock.fn(function(this: any, ...args: any[]) {
      return Npc.prototype.setFacingToward.apply(this, args as [Float32Array, number?]);
    }),
    sendIdleStance: t.mock.fn(function(this: any, prime = false) {
      return Npc.prototype.sendIdleStance.call(this, prime);
    }),
    goTo: t.mock.fn(function(this: any, ...args: any[]) {
      return Npc.prototype.goTo.apply(this, args);
    })
  });
  return send;
}

function meleePacketSetup(t: TestContext) {
  const s = setup(t);
  const packets: Array<{ name: string; data: any }> = [];
  const server = Object.assign(s.server, {
    sendDataToAllWithSpawnedEntity: (dictionary: unknown, id: string, name: string, data: any) => {
      assert.equal(dictionary, s.server._npcs);
      assert.equal(id, s.npc.characterId);
      packets.push({ name, data });
    }
  });
  Object.assign(s.npc, {
    server, transientId: 42, movementVersion: 7, npcRenderDistance: 100,
    testServerDrivenMovement: true,
    state: { position: s.npc.state.position, rotation: new Float32Array([0, 0, 0, 1]) },
    setFacingToward: Npc.prototype.setFacingToward,
    sendIdleStance: Npc.prototype.sendIdleStance,
    triggerMeleeAttack: Npc.prototype.triggerMeleeAttack
  });
  return { ...s, packets };
}

test("test melee sends the new idle facing before its attack, preserving the initial stop", (t) => {
  const { ai, npc, packets } = meleePacketSetup(t);
  const position = npc.state.position.slice();
  ai.run();
  assert.deepEqual(packets.map(p => p.name), ["PlayerUpdatePosition", "PlayerUpdatePosition", "Character.PlayAnimation"]);
  assert.equal(packets[0].data.positionUpdate.orientation, 0, "existing transition stop is retained before facing changes");
  assert.ok(packets[1].data.positionUpdate.orientation > 3, "new facing points toward the player behind the NPC");
  for (const packet of packets.slice(0, 2)) {
    assert.equal(packet.data.transientId, 42);
    assert.deepEqual(packet.data.positionUpdate.position, Array.from(position));
    assert.equal(packet.data.positionUpdate.horizontalSpeed, 0);
    assert.equal(packet.data.positionUpdate.stance, 1024);
    assert.equal(packet.data.positionUpdate.unknown3_int8, 7);
  }
  assert.equal(packets[2].data.animationName, "KnifeSlash");
  assert.deepEqual(npc.state.position, position);
  assert.equal(npc.goTo.mock.callCount(), 0);
  assert.equal(npc.seekTarget.mock.callCount(), 0);
});

test("nearby lateral retarget publishes facing at the next AI tick without resetting attack cadence", (t) => {
  const { ai, npc, player, packets } = meleePacketSetup(t);
  ai.run();
  const oldOrientation = packets[1].data.positionUpdate.orientation;
  packets.length = 0;
  player.state.position = new Float32Array([1, 0, 0]); // sqrt(5) <= 2.5: no walking update can hide a missing facing packet.
  t.mock.timers.tick(100);
  ai.run();
  assert.deepEqual(packets.map(p => p.name), ["PlayerUpdatePosition"]);
  const update = packets[0].data.positionUpdate;
  const expected = Math.round(Math.atan2(1, -2) / (2 * Math.PI) * 255) / 255 * 2 * Math.PI;
  assert.ok(Math.abs(update.orientation - expected) < 1e-8, "existing server heading encoding, not a native turn-animation claim");
  assert.notEqual(update.orientation, oldOrientation);
  assert.deepEqual(update.position, [0, 0, 2]);
  assert.equal(update.horizontalSpeed, 0);
  assert.equal(update.unknown3_int8, 7);
  assert.equal(npc.lastMeleeAttackTime, 10000);
  ai.run();
  assert.equal(packets.length, 1, "unchanged heading cannot repeat idle");
  t.mock.timers.tick(1399);
  ai.run();
  assert.equal(packets.length, 1);
  t.mock.timers.tick(1);
  ai.run();
  assert.deepEqual(packets.map(p => p.name), ["PlayerUpdatePosition", "Character.PlayAnimation"]);
  assert.equal(npc.lastMeleeAttackTime, 11500);
  assert.equal(npc.goTo.mock.callCount(), 0);
});

test("failed test facing dispatch rolls back rotation and recovers once without consuming attack time", (t) => {
  const { ai, npc, server, packets } = meleePacketSetup(t);
  npc.behaviorState = 2; // Isolate the changed-facing dispatch from the existing transition stop.
  const previousRotation = (npc.state as any).rotation;
  const sender = (server as any).sendDataToAllWithSpawnedEntity;
  let fail = true;
  t.mock.method(console, "error", () => {});
  t.mock.method(server as any, "sendDataToAllWithSpawnedEntity", (...args: any[]) => {
    if (fail && args[2] === "PlayerUpdatePosition") throw new Error("synthetic send failure");
    sender(...args);
  });
  ai.run(); // The existing AI per-NPC error boundary catches the rethrow.
  assert.equal((npc.state as any).rotation, previousRotation);
  assert.equal(npc.lastMeleeAttackTime, 0);
  assert.equal(packets.length, 0);
  fail = false;
  t.mock.timers.tick(100);
  ai.run();
  assert.deepEqual(packets.map(p => p.name), ["PlayerUpdatePosition", "Character.PlayAnimation"]);
  assert.notEqual((npc.state as any).rotation, previousRotation);
  assert.equal(npc.lastMeleeAttackTime, 10100);
  ai.run();
  assert.equal(packets.length, 2, "recovery does not add a repeated idle or attack");
  assert.deepEqual(npc.state.position, new Float32Array([0, 0, 2]));
});

test("failed transition stop is retried before any melee attack on the next tick", (t) => {
  const { ai, npc, player, server, packets } = meleePacketSetup(t);
  npc.behaviorState = 1; // The chasing NPC has just entered melee range.
  Npc.prototype.setFacingToward.call(npc, player.state.position);
  const originalPosition = npc.state.position.slice();
  const sender = (server as any).sendDataToAllWithSpawnedEntity;
  const order: string[] = [];
  let failStop = true;
  t.mock.method(console, "error", () => {});
  t.mock.method(server as any, "sendDataToAllWithSpawnedEntity", (...args: any[]) => {
    if (args[2] === "PlayerUpdatePosition") {
      assert.equal(args[3].positionUpdate.horizontalSpeed, 0);
      if (failStop) {
        failStop = false;
        order.push("stop_send_failed");
        throw new Error("synthetic transition-stop failure");
      }
      // This inert sender's success is not a client delivery/acceptance ACK.
      sender(...args);
      order.push("stop_send_succeeded");
      return;
    }
    if (args[2] === "Character.PlayAnimation") order.push("attack");
    sender(...args);
  });
  ai.run();
  assert.deepEqual(order, ["stop_send_failed"]);
  assert.equal(packets.length, 0);
  assert.equal(npc.lastMeleeAttackTime, 0);
  t.mock.timers.tick(100);
  ai.run();
  assert.deepEqual(order, ["stop_send_failed", "stop_send_succeeded", "attack"],
    "recovery must publish its zero-speed stop before allowing an attack, even with unchanged facing");
  assert.deepEqual(packets.map(packet => packet.name), ["PlayerUpdatePosition", "Character.PlayAnimation"]);
  assert.deepEqual(npc.state.position, originalPosition);
});

test("failed transition aggro dispatch still requires next-tick stop before melee attack", (t) => {
  const { ai, npc, player, server, packets } = meleePacketSetup(t);
  npc.behaviorState = 1;
  Npc.prototype.setFacingToward.call(npc, player.state.position);
  Object.assign(npc, { sendAggroLevel: Npc.prototype.sendAggroLevel });
  const originalPosition = npc.state.position.slice();
  const sender = (server as any).sendDataToAllWithSpawnedEntity;
  const order: string[] = [];
  let failAggro = true;
  t.mock.method(console, "error", () => {});
  t.mock.method(server as any, "sendDataToAllWithSpawnedEntity", (...args: any[]) => {
    if (args[2] === "Character.AggroLevel" && failAggro) {
      failAggro = false;
      order.push("aggro_send_failed");
      throw new Error("synthetic transition-aggro failure");
    }
    if (args[2] === "PlayerUpdatePosition") {
      assert.equal(args[3].positionUpdate.horizontalSpeed, 0);
      sender(...args);
      order.push("stop_send_succeeded");
      return;
    }
    if (args[2] === "Character.PlayAnimation") order.push("attack");
    sender(...args);
  });
  ai.run();
  assert.deepEqual(order, ["aggro_send_failed"]);
  assert.equal(packets.length, 0);
  assert.equal(npc.lastMeleeAttackTime, 0);
  t.mock.timers.tick(100);
  ai.run();
  assert.deepEqual(order, ["aggro_send_failed", "stop_send_succeeded", "attack"],
    "failure before stop must not let the next tick skip stop, regardless of the aggro cache");
  assert.deepEqual(packets.map(packet => packet.name), ["PlayerUpdatePosition", "Character.PlayAnimation"]);
  assert.deepEqual(npc.state.position, originalPosition);
});

test("stationary test melee does not resend idle across repeated attacks", (t) => {
  const { ai, npc, packets } = meleePacketSetup(t);
  ai.run();
  const rotation = (npc.state as any).rotation;
  packets.length = 0;
  for (let i = 0; i < 30; i++) {
    t.mock.timers.tick(100);
    ai.run();
  }
  assert.deepEqual(packets.map(p => p.name), ["Character.PlayAnimation", "Character.PlayAnimation"]);
  assert.equal((npc.state as any).rotation, rotation);
  assert.equal(npc.lastMeleeAttackTime, 13000);
  assert.deepEqual(npc.state.position, new Float32Array([0, 0, 2]));
});

test("small target changes accumulate against the last published heading, not each AI tick", (t) => {
  const { ai, npc, player, packets } = meleePacketSetup(t);
  npc.behaviorState = 2;
  npc.lastMeleeAttackTime = Date.now();
  npc.state.position.fill(0);
  const originalRotation = (npc.state as any).rotation;
  const pointAt = (degrees: number) => new Float32Array([
    Math.sin(degrees * Math.PI / 180) * 2, 0, Math.cos(degrees * Math.PI / 180) * 2
  ]);
  for (const degrees of [0.5, 1, 1.5]) {
    player.state.position = pointAt(degrees);
    t.mock.timers.tick(100);
    ai.run();
    assert.equal(packets.length, 0);
    assert.equal((npc.state as any).rotation, originalRotation);
  }
  player.state.position = pointAt(2.1);
  t.mock.timers.tick(100);
  ai.run();
  assert.deepEqual(packets.map(p => p.name), ["PlayerUpdatePosition"]);
  assert.equal(packets[0].data.positionUpdate.horizontalSpeed, 0);
  assert.equal(packets[0].data.positionUpdate.unknown3_int8, 7);
  assert.deepEqual(packets[0].data.positionUpdate.position, [0, 0, 0]);
  assert.equal(npc.lastMeleeAttackTime, 10000);
  assert.notEqual((npc.state as any).rotation, originalRotation);
});

test("test facing deadband wraps across the signed yaw boundary and rejects undefined heading", () => {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const quaternion = (degrees: number) => new Float32Array([0, Math.sin(radians(degrees) / 2), 0, Math.cos(radians(degrees) / 2)]);
  const pointAt = (degrees: number) => new Float32Array([Math.sin(radians(degrees)), 0, Math.cos(radians(degrees))]);
  const npc = { state: { position: new Float32Array([0, 0, 0]), rotation: quaternion(179.5) } };
  const original = npc.state.rotation;
  assert.equal(Npc.prototype.setFacingToward.call(npc, pointAt(-179.5), radians(2)), false);
  assert.equal(npc.state.rotation, original);
  assert.equal(Npc.prototype.setFacingToward.call(npc, pointAt(-177), radians(2)), true);
  for (const target of [new Float32Array([0, 1, 0]), new Float32Array([NaN, 0, 1])]) {
    const before = npc.state.rotation;
    assert.equal(Npc.prototype.setFacingToward.call(npc, target, radians(2)), false);
    assert.equal(npc.state.rotation, before);
  }
  for (const rotation of [new Float32Array([0, 0, 0, 0]), new Float32Array([0, NaN, 0, 1])]) {
    npc.state.rotation = rotation;
    assert.equal(Npc.prototype.setFacingToward.call(npc, pointAt(90), radians(2)), false);
    assert.equal(npc.state.rotation, rotation);
  }
});

for (const mode of ["non-test", "non-server-driven"] as const) {
  test(`melee facing stimulus does not change ${mode} NPC dispatch`, (t) => {
    const { ai, npc, player, server, packets } = meleePacketSetup(t);
    npc.behaviorState = 2; // Inspect attack dispatch independently of the pre-existing state-transition stop.
    if (mode === "non-test") {
      server._testZombieChaseAttackCharacterId = "";
      server.getDevHttpPort = () => 0;
    } else Object.assign(npc, { testServerDrivenMovement: false });
    ai.run();
    assert.deepEqual(packets.map(p => p.name), ["Character.PlayAnimation"]);
    const rotation = (npc.state as any).rotation;
    // Keep the retarget inside the fixture's MELEE_DETECT width; the test is
    // about dispatch mode, not about asserting a boundary hit at x=1.0.
    player.state.position[0] = 0.5;
    t.mock.timers.tick(100);
    ai.run();
    assert.equal((npc.state as any).rotation, rotation, "ordinary NPC still faces only on its attack window");
    assert.deepEqual(packets.map(p => p.name), ["Character.PlayAnimation"]);
    t.mock.timers.tick(350);
    assert.equal(npc.applyDamage.mock.callCount(), 1, "existing non-protected hit path remains unchanged");
  });
}

for (const mode of ["obstructed", "respawning", "nonfinite", "dead-npc", "dead-player"] as const) {
  test(`invalid ${mode} melee target cannot produce the new facing/attack stimulus`, (t) => {
    const { ai, npc, player, packets } = meleePacketSetup(t);
    if (mode === "obstructed") Object.assign(npc, { testMeleeReachability: () => false });
    if (mode === "respawning") player.isRespawning = true;
    if (mode === "nonfinite") player.state.position[0] = NaN;
    if (mode === "dead-npc") npc.isAlive = false;
    if (mode === "dead-player") player.isAlive = false;
    ai.run();
    assert.equal(packets.length, 0);
    t.mock.timers.tick(1500);
    assert.equal(npc.applyDamage.mock.callCount(), 0);
  });
}

test("protected test melee still sends facing and attack without entering delayed hit side effects", (t) => {
  const { ai, npc, player, packets } = meleePacketSetup(t);
  Object.assign(player, { godMode: true, isGodMode: () => true });
  npc.behaviorState = 2;
  ai.run();
  assert.deepEqual(packets.map(p => p.name), ["PlayerUpdatePosition", "Character.PlayAnimation"]);
  t.mock.timers.tick(449);
  assert.equal(npc.applyDamage.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(npc.applyDamage.mock.callCount(), 0);
  assert.equal(player.getHealth(), 10000);
});

test("test melee diagnostics correlate request and delayed check without changing timing", (t) => {
  const { ai, npc, log } = setup(t);
  ai.run();
  const messages = () => log.mock.calls.map(call => String(call.arguments[0]));
  assert.ok(messages().some(message => message.includes("请求 KnifeSlash") &&
    message.includes("requestedAt=10000, npc=zombie, target=player, experimentalHitDelayMs=450")));
  t.mock.timers.tick(449);
  assert.equal(npc.applyDamage.mock.callCount(), 0);
  assert.equal(messages().filter(message => message.includes("近战命中检查")).length, 0);
  t.mock.timers.tick(1);
  assert.equal(npc.applyDamage.mock.callCount(), 1);
  assert.ok(messages().some(message => message.includes("近战命中检查") &&
    message.includes("requestedAt=10000, checkedAt=10450, npc=zombie, target=player") &&
    message.includes("health=10000->9000")));
  t.mock.timers.tick(1050);
  ai.run();
  assert.equal(npc.triggerMeleeAttack.mock.callCount(), 2);
  assert.ok(messages().some(message => message.includes("requestedAt=11500") && message.includes("请求 KnifeSlash")));
});

test("automatic test spawn sends an existing zombie profile record, not type number11", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 });
  t.mock.method(console, "log", () => {});
  const { spawnTestZombieForClient, TEST_ZOMBIE_PROFILE_ID } = require("../out/servers/ZoneServer2016/test-zombie-in-front");
  const definitions = require("../data/2016/dataSources/ServerProfileDefinitions.json").profiles;
  const client = { sessionId: 1, spawnedEntities: new Set(), character: {
    characterId: "player", isAlive: true, isRespawning: false, state: { position: new Float32Array([0, 0, 0]),
      rotation: new Float32Array([0, 0, 0, 1]) }
  } };
  const server = { _modelsData: {}, charactersRenderDistance: 100, interactionDistance: 3,
    pushToGridCell: t.mock.fn(), removeTestZombie: t.mock.fn(),
    generateGuid: () => "0x0102030405060708", getTransientId: () => 42,
    aiManager: { addEntity: t.mock.fn(), removeEntity: t.mock.fn() },
    _npcs: {}, _clients: { 1: client }, addLightweightNpc: t.mock.fn(), sendStandardFullNpcInit: t.mock.fn() };
  assert.throws(() => spawnTestZombieForClient(server, client, { profileId: 11 }), /existing type11/);
  assert.equal(server.removeTestZombie.mock.callCount(), 0);
  spawnTestZombieForClient(server, client, { delayMs: 0, noAi: true });
  t.mock.timers.tick(1);
  assert.equal(server.addLightweightNpc.mock.callCount(), 1);
  const zombie = server.addLightweightNpc.mock.calls[0].arguments[1] as any;
  const payload = zombie.pGetLightweight();
  assert.equal(payload.profileId, TEST_ZOMBIE_PROFILE_ID);
  assert.equal(definitions.find((entry: any) => entry.ID === payload.profileId).profileData.unknownByte1, 11);
  assert.equal(payload.npcDefinitionId, 3); // separate identifier, not overwritten
});

test("test zombie chases outside melee range without dealing damage", (t) => {
  const { ai, npc, player } = setup(t, 6);
  ai.run();

  assert.equal(npc.behaviorState, 1);
  assert.equal(npc.seekTarget.mock.calls[0].arguments[0], player.characterId);
  assert.equal(npc.clientDrivenSeek, false);
  assert.equal(npc.goTo.mock.callCount(), 1,
    "ordinary chase keeps the native seek hint and one authoritative position update");
  assert.equal(npc.state.position[2], 5.75);
  assert.equal(npc.triggerMeleeAttack.mock.callCount(), 0);
  t.mock.timers.tick(1500);
  assert.equal(npc.applyDamage.mock.callCount(), 0);
});

test("production client-driven NPC uses native seek plus one position stream without nav crowd", (t) => {
  const { ai, npc, player, server } = setup(t, 6);
  const send = t.mock.fn();
  const createAgent = t.mock.fn(() => { throw new Error("production native seek must not create a nav agent"); });
  Object.assign(server, {
    _lastSpawnedNpcCharacterId: "another-npc",
    _testZombieChaseAttackCharacterId: null,
    getDevHttpPort: () => 0,
    navManager: { isReady: true, createAgent, updt: t.mock.fn() },
    sendDataToAllWithSpawnedEntity: send
  });
  Object.assign(npc, {
    server,
    transientId: 42,
    movementVersion: 7,
    npcRenderDistance: 100,
    testServerDrivenMovement: false,
    clientDrivenSeek: true,
    lastSeekTargetId: null,
    lastSeekTargetUpdateTime: 0,
    state: { position: new Float32Array([0, 0, 6]), rotation: new Float32Array([0, 0, 0, 1]) },
    seekTarget: t.mock.fn(function(this: any, ...args: any[]) {
      return Npc.prototype.seekTarget.apply(this, args);
    }),
    seekTargetUpdate: t.mock.fn(function(this: any, ...args: any[]) {
      return Npc.prototype.seekTargetUpdate.apply(this, args);
    }),
    goTo: t.mock.fn(function(this: any, ...args: any[]) {
      return Npc.prototype.goTo.apply(this, args);
    })
  });
  ai.run();

  assert.equal(npc.behaviorState, 1);
  assert.equal(npc.seekTarget.mock.callCount(), 1);
  assert.equal(npc.seekTargetUpdate.mock.callCount(), 1);
  assert.equal(createAgent.mock.callCount(), 0, "native-seek production actors stay out of the recast crowd");
  assert.equal(npc.goTo.mock.callCount(), 1, "server keeps one shadow simulation step for distance/attack authority");
  assert.deepEqual(send.mock.calls.map(call => call.arguments[2]),
    ["Character.ExpectedSpeed", "Character.SeekTarget", "Character.SeekTargetUpdate", "PlayerUpdatePosition"],
    "native target packets and the single visible motion stream are sent; recast stays out of the loop");
  assert.equal(send.mock.calls.filter(call => call.arguments[2] === "PlayerUpdatePosition").length, 1);
  assert.equal(player.isAlive, true);
});

test("production native-seek attack-to-chase emits a zero-speed anchor before the first shadow step", (t) => {
  const { ai, npc, player, server } = setup(t, 2);
  const send = t.mock.fn();
  const createAgent = t.mock.fn(() => { throw new Error("production native seek must not create a nav agent"); });
  Object.assign(server, {
    _lastSpawnedNpcCharacterId: "another-npc",
    _testZombieChaseAttackCharacterId: null,
    getDevHttpPort: () => 0,
    navManager: { isReady: true, createAgent, updt: t.mock.fn() },
    sendDataToAllWithSpawnedEntity: send
  });
  Object.assign(npc, {
    server,
    transientId: 42,
    movementVersion: 7,
    npcRenderDistance: 100,
    testServerDrivenMovement: false,
    clientDrivenSeek: true,
    productionMovementHandoffPending: false,
    lastSeekTargetId: null,
    lastSeekTargetUpdateTime: 0,
    seekTarget: t.mock.fn(function(this: any, ...args: any[]) {
      return Npc.prototype.seekTarget.apply(this, args);
    }),
    seekTargetUpdate: t.mock.fn(function(this: any, ...args: any[]) {
      return Npc.prototype.seekTargetUpdate.apply(this, args);
    }),
    goTo: t.mock.fn(function(this: any, ...args: any[]) {
      return Npc.prototype.goTo.apply(this, args);
    })
  });

  // Start in melee: attack entry remains stopped and does not advance the
  // production shadow position.
  ai.run();
  assert.equal(npc.behaviorState, 2);
  assert.equal(npc.triggerMeleeAttack.mock.callCount(), 1);
  const attackPosition = Array.from(npc.state.position);
  assert.equal(npc.goTo.mock.callCount(), 0);
  assert.equal(npc.sendIdleStance.mock.callCount(), 1);

  // Back out of melee. The 2→1 transition publishes a fresh zero-speed anchor
  // and consumes one movement tick before any new position sample is emitted.
  player.state.position = new Float32Array([0, 0, -1]);
  t.mock.timers.tick(100);
  ai.run();
  assert.equal(npc.behaviorState, 1);
  assert.deepEqual(Array.from(npc.state.position), attackPosition);
  assert.equal(npc.goTo.mock.callCount(), 0);
  assert.equal(npc.sendIdleStance.mock.callCount(), 2,
    "attack-to-chase emits a new zero-speed position boundary");
  assert.equal(npc.productionMovementHandoffPending, false,
    "the same AI tick consumes the handoff barrier without moving");

  // Only the following tick may advance the shadow position.
  t.mock.timers.tick(100);
  ai.run();
  assert.deepEqual(Array.from(npc.state.position), [0, 0, 1.75]);
  assert.equal(npc.goTo.mock.callCount(), 1);
  assert.equal(createAgent.mock.callCount(), 0);
});

test("shadow movement clamps a long step to the target and rejects invalid coordinates", () => {
  const start = new Float32Array([0, 1, 0]);
  const target = new Float32Array([0, 0, 1]);
  assert.deepEqual(
    Array.from(moveTowardTarget(start, target, 100, 0.1)),
    Array.from(target),
    "a large speed/dt budget must not cross the target"
  );
  const invalidTarget = new Float32Array([Number.NaN, 0, 1]);
  assert.deepEqual(
    Array.from(moveTowardTarget(start, invalidTarget, 2.5, 0.1)),
    Array.from(start),
    "invalid target coordinates must not publish a NaN position"
  );
});

test("route-bound zombie follows its waypoint even inside blocked melee range", (t) => {
  const s = setup(t, 2);
  const { ai, npc } = s;
  attachRoutePacketMethods(t, s);
  Object.assign(npc, {
    testServerDrivenMovement: true,
    testMeleeReachability: () => false,
    testRouteStep: (from: Float32Array, _to: Float32Array, budget: number) =>
      new Float32Array([from[0] + budget, from[1], from[2]])
  });
  ai.run();
  assert.deepEqual(Array.from(npc.state.position), [0, 0, 2], "first route tick only primes idle");
  assert.equal(npc.goTo.mock.callCount(), 0);
  t.mock.timers.tick(100);
  ai.run();
  assert.equal(npc.behaviorState, 1);
  assert.deepEqual(Array.from(npc.state.position), [0.25, 0, 2]);
  assert.equal(npc.triggerMeleeAttack.mock.callCount(), 0);
  assert.equal(npc.seekTarget.mock.callCount(), 0);
  assert.equal(npc.goTo.mock.calls[0].arguments[1], true);
});

test("attack-to-chase transition primes an in-range route before the first position advance", (t) => {
  const s = setup(t, 2);
  const { ai, npc, player } = s;
  attachRoutePacketMethods(t, s);
  Object.assign(npc, {
    testServerDrivenMovement: true,
    testMeleeReachability: () => true,
    testRouteStep: (from: Float32Array, _to: Float32Array, budget: number) =>
      new Float32Array([from[0] + budget, from[1], from[2]])
  });

  // Enter attack while already rendered/in melee. The idle packet is a local
  // baseline; this test does not treat it as a native animation ACK.
  ai.run();
  assert.equal(npc.behaviorState, 2);
  assert.equal(npc.triggerMeleeAttack.mock.callCount(), 1);
  const attackPosition = Array.from(npc.state.position);
  const goToCallsAfterAttack = npc.goTo.mock.callCount();

  // The player backs out of melee. The first restarted route tick only
  // re-primes its anchor, so the feet/pose handoff cannot be paired with a
  // new server position on that same tick.
  player.state.position = new Float32Array([0, 0, -1]);
  t.mock.timers.tick(100);
  ai.run();
  assert.equal(npc.behaviorState, 1);
  assert.deepEqual(Array.from(npc.state.position), attackPosition);
  assert.equal(npc.goTo.mock.callCount(), goToCallsAfterAttack);

  // Only the following tick has a validated route anchor and may advance.
  t.mock.timers.tick(100);
  ai.run();
  assert.deepEqual(Array.from(npc.state.position), [0.25, 0, 2]);
  assert.equal(npc.goTo.mock.callCount(), goToCallsAfterAttack + 1);
});

test("failed or invalid routes stop without straight-line fallback or idle spam", (t) => {
  const s = setup(t, 6);
  const { ai, npc } = s;
  attachRoutePacketMethods(t, s);
  Object.assign(npc, { testServerDrivenMovement: true, testRouteStep: () => undefined });
  ai.run();
  ai.run();
  assert.deepEqual(Array.from(npc.state.position), [0, 0, 6]);
  assert.equal(npc.goTo.mock.callCount(), 0);
  assert.equal(npc.sendIdleStance.mock.callCount(), 1);
  Object.assign(npc, { testRouteStep: () => { throw new Error("query failed"); } });
  assert.doesNotThrow(() => ai.run());
  for (const next of [new Float32Array([0, NaN, 5.9]), new Float32Array([0, 0, 1])]) {
    Object.assign(npc, { testRouteStep: () => next });
    ai.run();
    assert.equal(npc.goTo.mock.callCount(), 0);
  }
  Object.assign(npc, { testRouteStep: () => new Float32Array([0.25, 0, 6]) });
  ai.run();
  assert.deepEqual(Array.from(npc.state.position), [0, 0, 6], "a recovered route first reprimes");
  assert.equal(npc.goTo.mock.callCount(), 0);
  t.mock.timers.tick(100);
  ai.run();
  assert.deepEqual(Array.from(npc.state.position), [0.25, 0, 6]);
  assert.equal(npc.goTo.mock.callCount(), 1);
});

test("forced route position broadcasts preserve corners inside the normal throttle", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 10000 });
  const send = t.mock.fn();
  const npc = { characterId: "zombie", transientId: 42, movementVersion: 1,
    behaviorState: 1, testChaseSpeedScale: 1, lastPositionBroadcastTime: 10000,
    state: { position: new Float32Array([1, 2, 3]), rotation: new Float32Array([0, 0, 0, 1]) },
    server: { _npcs: {}, sendDataToAllWithSpawnedEntity: send } };
  Npc.prototype.goTo.call(npc, new Float32Array([1, 2, 3]));
  assert.equal(send.mock.callCount(), 0);
  Npc.prototype.goTo.call(npc, new Float32Array([1, 2, 3]), true);
  assert.equal(send.mock.callCount(), 1);
});

function positionTraceSetup(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: 10000 });
  const log = t.mock.method(console, "log", () => {});
  t.mock.method(performance, "now", () => 1234.5);
  const send = t.mock.fn();
  const server = { _npcs: {} as Record<string, unknown>,
    _lastSpawnedNpcCharacterId: "zombie" as string | null,
    _testZombieChaseAttackCharacterId: "player" as string | null,
    sendDataToAllWithSpawnedEntity: send };
  const npc = { characterId: "zombie", transientId: 42, movementVersion: 7,
    behaviorState: 1, testChaseSpeedScale: 1, lastPositionBroadcastTime: 0,
    testServerDrivenMovement: true, clientDrivenSeek: false, testPositionTraceCount: 0,
    state: { position: new Float32Array([1, 2, 3]), rotation: new Float32Array([0, 0, 0, 1]) }, server };
  server._npcs.zombie = npc;
  return { npc, server, send, log };
}

test("position trace excludes ordinary, non-chase and stale experimental NPCs", (t) => {
  const { npc, server, send, log } = positionTraceSetup(t);
  const invoke = () => Npc.prototype.goTo.call(npc, new Float32Array([1, 2, 3]), true);
  npc.testServerDrivenMovement = false;
  invoke();
  npc.testServerDrivenMovement = true;
  server._testZombieChaseAttackCharacterId = null;
  invoke();
  server._testZombieChaseAttackCharacterId = "player";
  server._lastSpawnedNpcCharacterId = "other";
  invoke();
  server._lastSpawnedNpcCharacterId = "zombie";
  server._npcs.zombie = {};
  invoke();
  server._npcs.zombie = npc;
  npc.behaviorState = 0;
  invoke();
  assert.equal(send.mock.callCount(), 5, "trace gates do not change existing sends");
  assert.equal(log.mock.callCount(), 0);
  assert.equal(npc.testPositionTraceCount, 0);
});

test("position trace is a send attempt with the exact outgoing payload and two clocks", (t) => {
  const { npc, send, log } = positionTraceSetup(t);
  const position = new Float32Array([12.345, 67.89, -2.125]);
  Npc.prototype.goTo.call(npc, position, true);
  assert.equal(send.mock.callCount(), 1);
  assert.equal(log.mock.callCount(), 1);
  const payload = send.mock.calls[0].arguments[3].positionUpdate;
  const trace = JSON.parse(log.mock.calls[0].arguments[0]);
  assert.deepEqual(trace, {
    event: "test_npc_position", phase: "send_attempt", traceIndex: 1,
    scope: "Npc.goTo only; excludes sendIdleStance and other packets",
    guid: "zombie", transientId: 42, utcMs: 10000, monotonicMs: 1234.5,
    sequenceTime: payload.sequenceTime, position: payload.position,
    horizontalSpeed: payload.horizontalSpeed, forceBroadcast: true,
    movementVersion: payload.unknown3_int8
  });
  assert.equal(payload.horizontalSpeed, 2.5);
  assert.equal(payload.unknown3_int8, 7);
  assert.deepEqual(payload.position, Array.from(position));
  assert.equal(npc.state.position, position, "existing position reference semantics unchanged");
  position[0] = 99;
  assert.notEqual(trace.position[0], 99, "JSON records values at the attempt, not later mutation");
});

test("position trace caps each experimental NPC at64 without capping sends", (t) => {
  const { npc, server, send, log } = positionTraceSetup(t);
  for (let i = 0; i < 70; i++) Npc.prototype.goTo.call(npc, new Float32Array([i, 2, 3]), true);
  assert.equal(log.mock.callCount(), 64);
  assert.equal(send.mock.callCount(), 70);
  assert.equal(npc.testPositionTraceCount, 64);
  assert.deepEqual(log.mock.calls.map(c => JSON.parse(c.arguments[0]).traceIndex), Array.from({ length: 64 }, (_, i) => i + 1));
  const second = { ...npc, characterId: "second", testPositionTraceCount: 0 };
  server._lastSpawnedNpcCharacterId = "second";
  server._npcs.second = second;
  Npc.prototype.goTo.call(second, new Float32Array([1, 2, 3]), true);
  assert.equal(log.mock.callCount(), 65);
  assert.equal(send.mock.callCount(), 71);
  assert.equal(JSON.parse(log.mock.calls[64].arguments[0]).traceIndex, 1);
});

test("position trace preserves throttle and client-driven early return", (t) => {
  const { npc, send, log } = positionTraceSetup(t);
  npc.lastPositionBroadcastTime = 10000;
  Npc.prototype.goTo.call(npc, new Float32Array([1, 2, 3]));
  t.mock.timers.tick(149);
  Npc.prototype.goTo.call(npc, new Float32Array([1, 2, 3]));
  assert.equal(send.mock.callCount(), 0);
  assert.equal(log.mock.callCount(), 0);
  t.mock.timers.tick(1);
  Npc.prototype.goTo.call(npc, new Float32Array([1, 2, 3]));
  assert.equal(send.mock.callCount(), 1);
  assert.equal(JSON.parse(log.mock.calls[0].arguments[0]).forceBroadcast, false);
  npc.clientDrivenSeek = true;
  npc.suppressServerPositionBroadcast = true;
  Npc.prototype.goTo.call(npc, new Float32Array([4, 5, 6]), true);
  assert.equal(send.mock.callCount(), 1);
  assert.equal(log.mock.callCount(), 1);
});

test("failed position sender never produces a success or acknowledgment trace", (t) => {
  const { npc, server, log } = positionTraceSetup(t);
  const errors = t.mock.method(console, "error", () => {});
  let fail = true;
  server.sendDataToAllWithSpawnedEntity = t.mock.fn(() => { if (fail) throw new Error("synthetic sender failure"); });
  Npc.prototype.goTo.call(npc, new Float32Array([1, 2, 3]), true);
  assert.equal(errors.mock.callCount(), 1, "existing goTo error handling retained");
  fail = false;
  Npc.prototype.goTo.call(npc, new Float32Array([1, 2, 3]), true);
  assert.equal(server.sendDataToAllWithSpawnedEntity.mock.callCount(), 2);
  assert.equal(log.mock.callCount(), 2);
  assert.deepEqual(log.mock.calls.map(c => JSON.parse(c.arguments[0]).phase), ["send_attempt", "send_attempt"]);
  assert.ok(log.mock.calls.every(c => {
    const trace = JSON.parse(c.arguments[0]);
    return !Object.prototype.hasOwnProperty.call(trace, "acknowledged") &&
      !Object.prototype.hasOwnProperty.call(trace, "success");
  }));
  fail = true;
  for (let i = 0; i < 70; i++) Npc.prototype.goTo.call(npc, new Float32Array([1, 2, 3]), true);
  assert.equal(server.sendDataToAllWithSpawnedEntity.mock.callCount(), 72);
  assert.equal(log.mock.callCount(), 64, "sender throws cannot restart the trace budget");
  assert.equal(npc.testPositionTraceCount, 64);
});

test("diagnostic logger failure does not suppress position transmission", (t) => {
  const { npc, send } = positionTraceSetup(t);
  const brokenLog = t.mock.method(console, "log", () => { throw new Error("synthetic logger failure"); });
  const errors = t.mock.method(console, "error", () => {});
  Npc.prototype.goTo.call(npc, new Float32Array([1, 2, 3]), true);
  assert.equal(send.mock.callCount(), 1);
  assert.equal(errors.mock.callCount(), 0);
  assert.equal(npc.testPositionTraceCount, 1, "failed diagnostic attempts also consume the bounded budget");
  for (let i = 0; i < 70; i++) Npc.prototype.goTo.call(npc, new Float32Array([1, 2, 3]), true);
  assert.equal(brokenLog.mock.callCount(), 64, "logger throws cannot cause unbounded retries");
  assert.equal(send.mock.callCount(), 71);
  assert.equal(errors.mock.callCount(), 0);
  assert.equal(npc.testPositionTraceCount, 64);
});

function routeSpeedPacketSetup(t: TestContext, route: (from: Float32Array, target: Float32Array, budget: number) => Float32Array | undefined) {
  const s = setup(t, 6);
  const send = attachRoutePacketMethods(t, s);
  Object.assign(s.npc, { testRouteStep: route });
  return { ...s, send };
}

for (const [label, delta] of [
  ["full", [0, 0, -0.25]],
  ["partial", [0, 0, -0.05]],
  ["slope", [0.15, 0.2, 0]]
] as const) {
  test(`route ${label} packet uses quantized XZ segment and elapsed stream time`, (t) => {
    const { ai, npc, send, log } = routeSpeedPacketSetup(t, (from, _target, budget) => {
      assert.equal(budget, 0.25);
      return new Float32Array(from.map((value, i) => value + delta[i]));
    });
    const before = npc.state.position.slice();
    ai.run();
    assert.equal(send.mock.callCount(), 1);
    assert.deepEqual(npc.state.position, before);
    const prime = send.mock.calls[0].arguments[3].positionUpdate;
    assert.equal(prime.horizontalSpeed, 0);
    t.mock.timers.tick(100);
    ai.run();
    assert.equal(send.mock.callCount(), 2);
    const payload = send.mock.calls[1].arguments[3].positionUpdate;
    const after = npc.state.position;
    const wire = (v: number) => Math.round(v * 100) / 100;
    const expected = Math.hypot(wire(after[0]) - wire(before[0]), wire(after[2]) - wire(before[2])) / 0.1;
    assert.equal(payload.horizontalSpeed, expected);
    assert.equal((payload.sequenceTime - prime.sequenceTime) >>> 0, 100);
    assert.ok(expected > 0, "caller must measure before committing state.position");
    assert.deepEqual(payload.position, Array.from(after));
    assert.equal(payload.unknown3_int8, 7);
    if (label === "full") assert.equal(expected, 2.5);
    else assert.ok(expected < 2.5);
    if (label === "slope") assert.notEqual(expected, Math.hypot(...Array.from(after, (v, i) => v - before[i])) / 0.1);
    const traces = log.mock.calls.map(c => String(c.arguments[0])).filter(s => s.startsWith('{"event":"test_npc_position"')).map(s => JSON.parse(s));
    assert.equal(traces.length, 1);
    assert.equal(traces[0].phase, "send_attempt");
    assert.equal(traces[0].horizontalSpeed, payload.horizontalSpeed);
    assert.deepEqual(traces[0].position, payload.position);
    assert.equal(traces[0].forceBroadcast, true);
    assert.equal(traces[0].sequenceTime, payload.sequenceTime);
    assert.equal(traces[0].elapsedMs, 100);
    assert.equal(traces[0].speedBasis, "quantized_xz_sequence_interval");
    assert.equal(traces[0].previousSequenceTime, prime.sequenceTime);
    assert.deepEqual(traces[0].previousWireXZ, [wire(before[0]), wire(before[2])]);
    const committed = npc.state.position.slice();
    ai.run(); // A forced corner cannot consume the same stream timestamp twice.
    assert.equal(send.mock.callCount(), 2);
    assert.deepEqual(npc.state.position, committed);
    t.mock.timers.tick(100);
    ai.run(); // A new timestamp still bypasses the ordinary 150ms throttle.
    assert.equal(send.mock.callCount(), 3);
  });
}

test("zero and invalid route results still stop with one idle and no movement or fallback", (t) => {
  let result: Float32Array | undefined;
  const { ai, npc, send } = routeSpeedPacketSetup(t, () => result);
  const before = npc.state.position.slice();
  for (result of [undefined, before.slice(), new Float32Array([0, NaN, 6]), new Float32Array([0, 0, 5])]) {
    ai.run();
    assert.equal(send.mock.callCount(), 1);
    assert.equal(send.mock.calls[0].arguments[3].positionUpdate.horizontalSpeed, 0);
    assert.deepEqual(npc.state.position, before);
  }
  assert.equal(npc.sendIdleStance.mock.callCount(), 1);
  assert.equal(npc.triggerMeleeAttack.mock.callCount(), 0);
});

test("route speed override is scoped and absent override preserves the nominal packet", (t) => {
  const { npc, send } = positionTraceSetup(t);
  const routeNpc = Object.assign(npc, { testRouteStep: undefined as undefined | (() => undefined) });
  const invoke = (speed?: number) => {
    Npc.prototype.goTo.call(routeNpc, new Float32Array([1, 2, 3]), true, speed);
    return send.mock.calls[send.mock.callCount() - 1].arguments[3].positionUpdate.horizontalSpeed;
  };
  assert.equal(invoke(0.5), 2.5, "no route keeps the old speed");
  routeNpc.testRouteStep = () => undefined;
  routeNpc.testServerDrivenMovement = false;
  assert.equal(invoke(0.5), 2.5, "ordinary/client-driven scope is unchanged");
  routeNpc.testServerDrivenMovement = true;
  assert.equal(invoke(), 2.5, "raw/legacy route calls need not supply a measured segment");
  assert.equal(invoke(0.5), 0.5);
  assert.equal(invoke(0), 0, "zero is not an absent override");
  routeNpc.behaviorState = 0;
  assert.equal(invoke(0.5), 0, "idle cannot acquire movement speed");
});

test("nonfinite or negative route speed override retains the existing nominal fallback", (t) => {
  const { npc, send } = positionTraceSetup(t);
  Object.assign(npc, { testRouteStep: () => undefined });
  for (const speed of [NaN, Infinity, -Infinity, -0.1]) {
    Npc.prototype.goTo.call(npc, new Float32Array([1, 2, 3]), true, speed);
    assert.equal(send.mock.calls[send.mock.callCount() - 1].arguments[3].positionUpdate.horizontalSpeed, 2.5);
  }
});

test("route speed override trace records the outgoing attempt, not an acknowledgment", (t) => {
  const { npc, send, log } = positionTraceSetup(t);
  Object.assign(npc, { testRouteStep: () => undefined });
  Npc.prototype.goTo.call(npc, new Float32Array([1.05, 2, 3]), true, 0.5224609375);
  const payload = send.mock.calls[0].arguments[3].positionUpdate;
  const trace = JSON.parse(log.mock.calls[0].arguments[0]);
  assert.equal(payload.horizontalSpeed, 0.5224609375);
  assert.equal(trace.horizontalSpeed, payload.horizontalSpeed);
  assert.deepEqual(trace.position, payload.position);
  assert.equal(trace.sequenceTime, payload.sequenceTime);
  assert.equal(trace.movementVersion, payload.unknown3_int8);
  assert.equal(trace.phase, "send_attempt");
  assert.equal(Object.prototype.hasOwnProperty.call(trace, "acknowledged"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(trace, "success"), false);
});

test("real local route drives AI around the fence into unobstructed melee", {
  skip: !process.env.FORGELIGHT_ASSETS || !process.env.FORGELIGHT_TERRAIN_DECOMPRESSED
}, async (t) => {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { buildLocalStaticScene, decodeTerrainV2 } = require("../out/utils/forgelightGeometry");
  const { createFileStaticActorResolver } = require("../out/utils/forgelightStaticAssets");
  const { ForgelightNavigation, createForgelightRouteBinding } = require("../out/utils/forgelightNavigation");
  const root = process.env.FORGELIGHT_ASSETS!;
  const bounds = { min: [180, 15, -940], max: [220, 32, -900] };
  const { scene } = buildLocalStaticScene(readFileSync(join(root, "Z1.zone")), bounds,
    createFileStaticActorResolver(root));
  const terrain = decodeTerrainV2(readFileSync(process.env.FORGELIGHT_TERRAIN_DECOMPRESSED!));
  const navigation = await ForgelightNavigation.build(terrain, scene, bounds);
  try {
    const s = setup(t);
    const { ai, npc, player } = s;
    attachRoutePacketMethods(t, s);
    // Explicit synthetic origins 1m above the nav surface, not native offset evidence.
    Object.assign(npc, createForgelightRouteBinding(navigation, 1, 1, 1));
    npc.state.position = new Float32Array([198.51, 23.1, -919.22]);
    player.state.position = new Float32Array([198.51, 23.1, -925.22]);
    let minX = npc.state.position[0];
    for (let i = 0; i < 400 && !npc.triggerMeleeAttack.mock.callCount(); i++) {
      const before = npc.state.position.slice();
      ai.run();
      const after = npc.state.position;
      assert.ok(Math.hypot(...Array.from(after, (v, k) => v - before[k])) <= 0.251);
      if (Math.hypot(...Array.from(after, (v, k) => v - before[k])) > 0.0001)
        assert.equal(scene.intersectSegment(before, after), undefined);
      minX = Math.min(minX, after[0]);
      t.mock.timers.tick(100);
    }
    assert.ok(minX < 188, "must actually go around the fence end");
    assert.equal(npc.triggerMeleeAttack.mock.callCount(), 1, "must reach melee, not silently stop en route");
    t.mock.timers.tick(450);
    assert.equal(npc.applyDamage.mock.callCount(), 1);
    assert.equal(npc.seekTarget.mock.callCount(), 0);
  } finally { navigation.destroy(); }
});

test("server-driven encounter does not reinstall seek and emits an idle stop", (t) => {
  const { ai, npc } = setup(t, 6);
  Object.assign(npc, { testServerDrivenMovement: true });
  ai.run();
  assert.equal(npc.goTo.mock.callCount(), 1);
  assert.equal(npc.seekTarget.mock.callCount(), 0);
  assert.equal(npc.seekTargetUpdate.mock.callCount(), 0);
  npc.state.position[2] = 2;
  ai.run();
  assert.equal(npc.sendIdleStance.mock.callCount(), 2, "one existing stop and one updated-facing stimulus before attack");
  assert.equal(npc.triggerMeleeAttack.mock.callCount(), 1);
});

test("test zombie delays a melee hit and respects the attack cooldown", (t) => {
  const { ai, npc, player } = setup(t);
  ai.run();

  assert.equal(npc.behaviorState, 2);
  assert.equal(npc.clearMovementController.mock.callCount(), 1);
  assert.equal(npc.triggerMeleeAttack.mock.callCount(), 1);
  assert.equal(player.getHealth(), 10000);
  t.mock.timers.tick(449);
  assert.equal(npc.applyDamage.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(player.getHealth(), 9000);
  ai.run();
  assert.equal(npc.triggerMeleeAttack.mock.callCount(), 1);
  t.mock.timers.tick(1050);
  ai.run();
  assert.equal(npc.triggerMeleeAttack.mock.callCount(), 2);
});

test("melee does not start outside the weapon fire-mode RANGE", (t) => {
  const { ai, npc, player } = setup(t, 2);
  Object.assign(npc, {
    getMeleeAttackProfile: () => ({
      itemDefinitionId: 83, weaponDefinitionId: 10, fireGroupId: 10, fireModeId: 13,
      range: 1.5, detectWidth: 0.15, detectHeight: 0.1,
      fireDurationMs: 850, refireTimeMs: 125
    })
  });
  ai.run();
  assert.equal(npc.triggerMeleeAttack.mock.callCount(), 0);
  assert.equal(npc.behaviorState, 1);
  assert.equal(player.getHealth(), 10000);
});

test("melee does not use MELEE_DETECT_HEIGHT as a network-origin Y gate", (t) => {
  const { ai, npc, player } = setup(t, 1);
  Object.assign(npc, {
    getMeleeAttackProfile: () => ({
      itemDefinitionId: 83, weaponDefinitionId: 10, fireGroupId: 10, fireModeId: 13,
      range: 1.5, detectWidth: 0.15, detectHeight: 0.1,
      fireDurationMs: 850, refireTimeMs: 125
    })
  });
  // A body/weapon contact query can still hit over a non-zero origin-height
  // difference (for example, a player on a low vehicle roof or a stair step).
  // The server has no native capsule transform, so this value must not be
  // rejected solely because it exceeds the weapon data's local height field.
  player.state.position[1] = 0.3;
  ai.run();
  assert.equal(npc.triggerMeleeAttack.mock.callCount(), 1);
  t.mock.timers.tick(450);
  assert.equal(npc.applyDamage.mock.callCount(), 1);
  assert.equal(player.getHealth(), 9000);
});

test("melee still respects full 3D fire-mode RANGE for vertical separation", (t) => {
  const { ai, npc, player } = setup(t, 1);
  Object.assign(npc, {
    getMeleeAttackProfile: () => ({
      itemDefinitionId: 83, weaponDefinitionId: 10, fireGroupId: 10, fireModeId: 13,
      range: 1.5, detectWidth: 0.15, detectHeight: 0.1,
      fireDurationMs: 850, refireTimeMs: 125
    })
  });
  // This is outside the actual fire-mode reach in 3D; removing the incorrect
  // origin-Y gate must not turn RANGE into an unlimited vertical allowance.
  player.state.position[1] = 2;
  ai.run();
  assert.equal(npc.triggerMeleeAttack.mock.callCount(), 0);
  assert.equal(player.getHealth(), 10000);
});

test("delayed melee damage requires the weapon MELEE_DETECT envelope", (t) => {
  const { ai, npc, player } = setup(t, 1);
  Object.assign(npc, {
    getMeleeAttackProfile: () => ({
      itemDefinitionId: 83, weaponDefinitionId: 10, fireGroupId: 10, fireModeId: 13,
      range: 1.5, detectWidth: 0.15, detectHeight: 0.1,
      fireDurationMs: 850, refireTimeMs: 125
    })
  });
  ai.run();
  assert.equal(npc.triggerMeleeAttack.mock.callCount(), 1);
  // The target remains within RANGE but leaves the narrow strike width.
  player.state.position[0] = 0.3;
  t.mock.timers.tick(450);
  assert.equal(npc.applyDamage.mock.callCount(), 0);
  assert.equal(player.getHealth(), 10000);
});

test("test zombie misses when its target leaves range during the swing", (t) => {
  const { ai, npc, player } = setup(t);
  ai.run();
  player.state.position[2] = -6;
  t.mock.timers.tick(450);

  assert.equal(npc.applyDamage.mock.callCount(), 0);
  assert.equal(player.getHealth(), 10000);
});

test("test zombie does not start melee through a supplied obstacle", (t) => {
  const { ai, npc, player } = setup(t);
  const reachability = t.mock.fn((_from: Float32Array, _to: Float32Array) => false);
  Object.assign(npc, { testMeleeReachability: reachability });
  ai.run();
  assert.equal(npc.behaviorState, 0);
  assert.equal(npc.triggerMeleeAttack.mock.callCount(), 0);
  assert.equal(npc.goTo.mock.callCount(), 0);
  assert.equal(reachability.mock.calls[0].arguments[0], npc.state.position);
  assert.equal(reachability.mock.calls[0].arguments[1], player.state.position);
  t.mock.timers.tick(1500);
  assert.equal(npc.applyDamage.mock.callCount(), 0);
});

test("test zombie rechecks current obstruction at delayed hit time", (t) => {
  const { ai, npc, player } = setup(t);
  let clear = true;
  Object.assign(npc, { testMeleeReachability: () => clear });
  ai.run();
  assert.equal(npc.triggerMeleeAttack.mock.callCount(), 1);
  clear = false;
  t.mock.timers.tick(450);
  assert.equal(npc.applyDamage.mock.callCount(), 0);
  assert.equal(player.getHealth(), 10000);
  clear = true;
  t.mock.timers.tick(1050);
  ai.run();
  t.mock.timers.tick(450);
  assert.equal(npc.applyDamage.mock.callCount(), 1);
});

test("melee geometry query failure cancels a pending hit without throwing", (t) => {
  const { ai, npc } = setup(t);
  Object.assign(npc, { testMeleeReachability: () => true });
  ai.run();
  Object.assign(npc, { testMeleeReachability: () => { throw new Error("unavailable geometry"); } });
  assert.doesNotThrow(() => t.mock.timers.tick(450));
  assert.equal(npc.applyDamage.mock.callCount(), 0);
});

test("real fence collision gates AI attack start and delayed damage", {
  skip: !process.env.FORGELIGHT_ASSETS
}, (t) => {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { buildLocalStaticScene } = require("../out/utils/forgelightGeometry");
  const { createFileStaticActorResolver } = require("../out/utils/forgelightStaticAssets");
  const root = process.env.FORGELIGHT_ASSETS!;
  const { scene } = buildLocalStaticScene(readFileSync(join(root, "Z1.zone")),
    { min: [195, 20, -926], max: [203, 26, -918] }, createFileStaticActorResolver(root));
  const { ai, npc, player } = setup(t);
  npc.state.position = new Float32Array([198.51, 23, -920.3]);
  player.state.position = new Float32Array([198.51, 23, -922]);
  // Explicit world-space test contact height; not a claimed network-origin/hand mapping.
  Object.assign(npc, {
    testMeleeReachability: (from: Float32Array, to: Float32Array) => !scene.intersectSegment(from, to)
  });
  ai.run();
  assert.equal(npc.triggerMeleeAttack.mock.callCount(), 0);
  player.state.position[2] = -919;
  ai.run();
  assert.equal(npc.triggerMeleeAttack.mock.callCount(), 1);
  player.state.position[2] = -922; // step behind the fence during the swing
  t.mock.timers.tick(450);
  assert.equal(npc.applyDamage.mock.callCount(), 0);
  player.state.position[2] = -919;
  t.mock.timers.tick(1050);
  ai.run();
  t.mock.timers.tick(450);
  assert.equal(npc.applyDamage.mock.callCount(), 1);
});

test("nonfinite target positions and respawn cancel pending melee damage", (t) => {
  const { ai, npc, player } = setup(t);
  ai.run();
  player.state.position[0] = NaN;
  t.mock.timers.tick(450);
  assert.equal(npc.applyDamage.mock.callCount(), 0);
  player.state.position[0] = 0;
  t.mock.timers.tick(1050);
  ai.run();
  player.isRespawning = true;
  t.mock.timers.tick(450);
  assert.equal(npc.applyDamage.mock.callCount(), 0);
});

test("removing a test zombie cancels its pending melee damage", (t) => {
  const { ai, npc, server } = setup(t);
  ai.run();
  delete server._npcs[npc.characterId];
  t.mock.timers.tick(450);

  assert.equal(npc.applyDamage.mock.callCount(), 0);
});

test("a departed target cannot receive a pending zombie melee hit", (t) => {
  const { ai, npc, player } = setup(t);
  ai.run();
  ai.playerEntities.delete(player);
  t.mock.timers.tick(450);

  assert.equal(npc.applyDamage.mock.callCount(), 0);
});
