import assert from "node:assert/strict";
import test from "node:test";
import { createBear } from "../out/servers/ZoneServer2016/jsms/bear.jsm";
import { createDeer } from "../out/servers/ZoneServer2016/jsms/deer.jsm";
import { createExploder } from "../out/servers/ZoneServer2016/jsms/exploder.jsm";
import { createGasser } from "../out/servers/ZoneServer2016/jsms/gasser.jsm";
import { createRabbit } from "../out/servers/ZoneServer2016/jsms/rabbit.jsm";
import { createScreamer } from "../out/servers/ZoneServer2016/jsms/screamer.jsm";
import { createWolf } from "../out/servers/ZoneServer2016/jsms/wolf.jsm";
import { createZombie } from "../out/servers/ZoneServer2016/jsms/zombie.jsm";
import {
  Factions,
  isHostile
} from "../out/servers/ZoneServer2016/jsms/factions";

type Vec3 = Float32Array;

function vec(x: number, y = 0, z = 0): Vec3 {
  return new Float32Array([x, y, z, 0]);
}

function makeServer() {
  const server: any = {
    aiTargetSpatialMap: new Map<string, any[]>(),
    sounds: [],
    _characters: {},
    _npcs: {},
    navManager: {
      navMeshQuery: {
        findRandomPointAroundCircle(center: {
          x: number;
          y: number;
          z: number;
        }) {
          return {
            success: true,
            randomPoint: { x: center.x + 8, y: center.y, z: center.z + 8 }
          };
        }
      },
      getClosestNavPointVec3(position: Vec3) {
        return { x: position[0], y: position[1], z: position[2] };
      },
      raycast() {
        return { t: 1 };
      }
    },
    sendDataToAllWithSpawnedEntity() {},
    getClientByCharId() {
      return undefined;
    },
    getClientsInRange() {
      return [];
    },
    sendCompositeEffectToAllInRange() {},
    pushSound() {},
    applyMovementModifier() {},
    checkRespirator() {
      return false;
    }
  };
  return server;
}

function makeNpc(server: any, id: string, position: Vec3, faction: Factions) {
  const npc: any = {
    characterId: id,
    state: { position, yaw: 0 },
    faction,
    isAlive: true,
    npcMeleeDamage: 1,
    navAgent: {
      velocity: () => ({ x: 0, y: 0, z: 0 }),
      requestMoveTarget: (target: unknown) => npc.moveTargets.push(target)
    },
    moveTargets: [] as unknown[],
    stopCount: 0,
    animations: [] as string[],
    speeds: [] as number[],
    locomotionModes: [] as string[],
    combatAnimationModes: [] as boolean[],
    lookAtCalls: 0,
    damageCalls: [] as string[],
    npcDamageCalls: [] as unknown[],
    stopMovement() {
      npc.stopCount++;
      // Mirror the production Npc.stopMovement() contract: canceling a nav
      // target also publishes the zero-speed edge used by the attack graph.
      npc.speeds.push(0);
    },
    playAnimation(animation: string) {
      npc.animations.push(`play:${animation}`);
    },
    setAnimation(animation: string) {
      npc.animations.push(`set:${animation}`);
    },
    setSpeed(speed: number) {
      npc.speeds.push(speed);
    },
    setLocomotionMode(mode: string) {
      npc.locomotionModes.push(mode);
    },
    setCombatAnimationMode(enabled: boolean) {
      npc.combatAnimationModes.push(enabled);
    },
    lookAt() {
      npc.lookAtCalls++;
    },
    applyDamage(targetId: string) {
      npc.damageCalls.push(targetId);
    },
    damage(_server: unknown, info: unknown) {
      npc.npcDamageCalls.push(info);
    }
  };
  server._npcs[id] = npc;
  return npc;
}

function addPlayer(server: any, id: string, position: Vec3) {
  server._characters[id] = {
    characterId: id,
    isAlive: true,
    isVanished: false,
    isHidden: false,
    state: { position }
  };
  const key = `${Math.floor(position[0] / 50)},${Math.floor(position[2] / 50)}`;
  server.aiTargetSpatialMap.set(key, [
    ...(server.aiTargetSpatialMap.get(key) ?? []),
    { id, position, faction: Factions.HUMAN }
  ]);
  return server._characters[id];
}

function clearTargets(server: any) {
  server.aiTargetSpatialMap.clear();
}

test("animal faction contract separates predators from passive prey", () => {
  assert.equal(isHostile(Factions.BEAR, Factions.HUMAN), true);
  assert.equal(isHostile(Factions.BEAR, Factions.ZOMBIE), true);
  assert.equal(isHostile(Factions.BEAR, Factions.WOLF), false);
  assert.equal(isHostile(Factions.BEAR, Factions.PASSIVE), false);

  assert.equal(isHostile(Factions.WOLF, Factions.HUMAN), true);
  assert.equal(isHostile(Factions.WOLF, Factions.ZOMBIE), true);
  assert.equal(isHostile(Factions.WOLF, Factions.PASSIVE), true);
  assert.equal(isHostile(Factions.WOLF, Factions.BEAR), false);

  assert.equal(isHostile(Factions.PASSIVE, Factions.HUMAN), false);
  assert.equal(isHostile(Factions.PASSIVE, Factions.ZOMBIE), false);
  assert.equal(isHostile(Factions.PASSIVE, Factions.WOLF), false);
  assert.equal(isHostile(Factions.PASSIVE, Factions.BEAR), false);
});

test("animals do not advertise a moving gait before their first patrol target", () => {
  const cases = [
    { id: "bear", faction: Factions.BEAR, create: createBear },
    { id: "wolf", faction: Factions.WOLF, create: createWolf },
    { id: "deer", faction: Factions.PASSIVE, create: createDeer }
  ] as const;

  for (const testCase of cases) {
    const server = makeServer();
    const npc = makeNpc(server, testCase.id, vec(0), testCase.faction);
    const fsm: any = testCase.create(npc, server);

    assert.equal(
      npc.speeds.at(-1),
      0,
      `${testCase.id} must remain stationary until Recast accepts a patrol target`
    );
    fsm.tick(0.1);
    assert.ok((npc.speeds.at(-1) ?? 0) > 0);
    assert.ok(npc.moveTargets.length > 0);
  }
});

test("bear detects a hostile player, stands before chasing, and deals melee damage in range", () => {
  const server = makeServer();
  const bearNpc = makeNpc(server, "bear", vec(0), Factions.BEAR);
  const playerPosition = vec(0, 0, 10);
  addPlayer(server, "player", playerPosition);
  const bear: any = createBear(bearNpc, server);

  bear.tick(0.1);
  assert.equal(bear.state, "standingUp");
  assert.equal(bearNpc.stopCount, 1);

  bear.tick(0.1);
  assert.ok(
    bearNpc.animations.some((name: string) => name.endsWith(":StandUp"))
  );
  bear.tick(5.2);
  assert.equal(bear.state, "standingUp");
  bear.tick(0.2);
  assert.equal(bear.state, "chase");
  assert.ok(bearNpc.moveTargets.length > 0);
  assert.equal(bearNpc.speeds.at(-1), 5);
  assert.equal(bearNpc.locomotionModes.at(-1), "sprint");
  assert.equal(bearNpc.combatAnimationModes.at(-1), true);

  playerPosition[2] = 1.2;
  bear.tick(0.1);
  assert.equal(bear.state, "attack");
  assert.equal(bearNpc.locomotionModes.at(-1), "walk");
  bear.tick(0.1);
  assert.equal(bear.state, "attacking");
  assert.ok(bearNpc.stopCount >= 3);
  assert.deepEqual(bear.attackForward, [0, 1]);

  const lookAtCallsAtSwingStart = bearNpc.lookAtCalls;
  bear.tick(1);
  assert.equal(
    bearNpc.lookAtCalls,
    lookAtCallsAtSwingStart,
    "a started swing must keep its captured facing until the one-shot resolves"
  );
  assert.deepEqual(bearNpc.damageCalls, ["player"]);
  assert.equal(
    bearNpc.animations.at(-1),
    "set:Idle",
    "a completed Bear KnifeSlash must hand the native graph back to Idle"
  );
  assert.equal(bear.state, "attack");

  playerPosition[2] = 4;
  bear.tick(0.1);
  assert.equal(bear.state, "chase");
  assert.deepEqual(bearNpc.damageCalls, ["player"]);
  assert.equal(bearNpc.speeds.at(-1), 5);
  assert.equal(bearNpc.locomotionModes.at(-1), "sprint");
  assert.equal(bearNpc.speeds.at(-1), 5);
  assert.equal(bearNpc.locomotionModes.at(-1), "sprint");

  playerPosition[1] = 3;
  playerPosition[2] = 1.2;
  bear.tick(0.1);
  assert.equal(bear.state, "attack");
  bear.tick(0.1);
  assert.equal(bear.state, "chase");
  assert.deepEqual(bearNpc.damageCalls, ["player"]);
});

test("bear waits for the weapon strike envelope instead of swinging beside a target", () => {
  const server = makeServer();
  const bearNpc = makeNpc(server, "bear", vec(0), Factions.BEAR);
  const playerPosition = vec(0, 0, 1.2);
  addPlayer(server, "player", playerPosition);
  // This is the production Npc contract reduced to a deterministic test
  // double: RANGE contains the target, but the native lateral gate does not.
  bearNpc.isMeleeTargetInEnvelope = () => false;
  const bear: any = createBear(bearNpc, server);

  bear.tick(0.1);
  bear.tick(0.1);
  bear.tick(5.2);
  assert.equal(bear.state, "standingUp");
  bear.tick(0.2);
  assert.equal(bear.state, "chase");
  bear.tick(0.1);
  assert.equal(bear.state, "attack");
  bear.tick(0.1);

  assert.equal(bear.state, "attack");
  assert.equal(
    bearNpc.animations.some((name: string) => name.endsWith(":KnifeSlash")),
    false
  );
  assert.deepEqual(bearNpc.damageCalls, []);
});

test("predator damage begins at the native SwingContact phase and is one-shot", () => {
  const server = makeServer();
  const bearNpc = makeNpc(server, "bear", vec(0), Factions.BEAR);
  const playerPosition = vec(0, 0, 1.2);
  addPlayer(server, "player", playerPosition);
  // The production Bear supplies this normalized interval from
  // AnimalsPhysicsX64.mrn.  A test double keeps it explicit so the timing
  // contract is covered independently from the weapon-table resolver.
  bearNpc.getMeleeContactWindow = () => ({
    startFraction: 0.25,
    endFraction: 0.75
  });
  const bear: any = createBear(bearNpc, server);

  bear.tick(0.1);
  bear.tick(0.1);
  bear.tick(5.2);
  assert.equal(bear.state, "standingUp");
  bear.tick(0.2);
  bear.tick(0.1);
  assert.equal(bear.state, "attack");
  bear.tick(0.1);
  assert.equal(bear.state, "attacking");

  bear.tick(0.2);
  assert.deepEqual(
    bearNpc.damageCalls,
    [],
    "the hit must not occur before the contact window"
  );
  bear.tick(0.1);
  assert.deepEqual(bearNpc.damageCalls, ["player"]);
  bear.tick(0.7);
  assert.equal(bear.state, "attack");
  assert.deepEqual(
    bearNpc.damageCalls,
    ["player"],
    "one attack clip has one contact attempt"
  );
});

test("predator does not lose SwingContact when one AI tick crosses the window", () => {
  const server = makeServer();
  const bearNpc = makeNpc(server, "bear", vec(0), Factions.BEAR);
  addPlayer(server, "player", vec(0, 0, 1.2));
  bearNpc.getMeleeContactWindow = () => ({
    startFraction: 0.25,
    endFraction: 0.75
  });
  const bear: any = createBear(bearNpc, server);

  bear.tick(0.1);
  bear.tick(0.1);
  bear.tick(5.2);
  bear.tick(0.2);
  bear.tick(0.1);
  assert.equal(bear.state, "attack");
  bear.tick(0.1);
  assert.equal(bear.state, "attacking");

  // A single 800ms tick moves from before 25% to after 75% of this 1s
  // action. The crossed interval is still one valid contact opportunity.
  bear.tick(0.8);
  assert.deepEqual(
    bearNpc.damageCalls,
    ["player"],
    "crossing the native contact interval must not drop the swing hit"
  );
  bear.tick(0.2);
  assert.deepEqual(bearNpc.damageCalls, ["player"]);
});

test("predator samples the whole SwingContact window before consuming a hit", () => {
  const server = makeServer();
  const bearNpc = makeNpc(server, "bear", vec(0), Factions.BEAR);
  const playerPosition = vec(0, 0, 1.2);
  addPlayer(server, "player", playerPosition);
  bearNpc.getMeleeContactWindow = () => ({
    startFraction: 0.25,
    endFraction: 0.75
  });
  let inStrikeEnvelope = false;
  bearNpc.isMeleeTargetInEnvelope = () => inStrikeEnvelope;
  const bear: any = createBear(bearNpc, server);

  bear.tick(0.1);
  bear.tick(0.1);
  bear.tick(5.2);
  assert.equal(bear.state, "standingUp");
  bear.tick(0.2);
  bear.tick(0.1);
  assert.equal(bear.state, "attack");
  // The attack state uses the envelope to decide whether to start the
  // one-shot.  Let that transition happen, then move the target out for the
  // first part of the native contact interval.
  inStrikeEnvelope = true;
  bear.tick(0.1);
  assert.equal(bear.state, "attacking");

  // The first tick after the native start is still outside the candidate
  // envelope.  It must not consume the only attack contact opportunity.
  inStrikeEnvelope = false;
  bear.tick(0.2);
  assert.deepEqual(bearNpc.damageCalls, []);

  // Entering the envelope during the same native interval must now produce
  // exactly one hit; the old start-only implementation missed this case.
  inStrikeEnvelope = true;
  bear.tick(0.1);
  assert.deepEqual(bearNpc.damageCalls, ["player"]);
  bear.tick(0.1);
  assert.deepEqual(bearNpc.damageCalls, ["player"]);

  // A target that only enters after the native interval has closed must not
  // receive a late server-side hit.
  const lateServer = makeServer();
  const lateBearNpc = makeNpc(
    lateServer,
    "late-bear",
    vec(0),
    Factions.BEAR
  );
  addPlayer(lateServer, "player", vec(0, 0, 1.2));
  lateBearNpc.getMeleeContactWindow = () => ({
    startFraction: 0.25,
    endFraction: 0.75
  });
  let lateInStrikeEnvelope = true;
  lateBearNpc.isMeleeTargetInEnvelope = () => lateInStrikeEnvelope;
  const lateBear: any = createBear(lateBearNpc, lateServer);
  lateBear.tick(0.1);
  lateBear.tick(0.1);
  lateBear.tick(5.2);
  lateBear.tick(0.2);
  lateBear.tick(0.1);
  assert.equal(lateBear.state, "attack");
  lateBear.tick(0.1);
  assert.equal(lateBear.state, "attacking");
  lateInStrikeEnvelope = false;
  lateBear.tick(0.7);
  lateInStrikeEnvelope = true;
  lateBear.tick(0.1);
  assert.deepEqual(
    lateBearNpc.damageCalls,
    [],
    "entering the envelope after SwingContact must not create a late hit"
  );
});

test("predator swing does not hit a player who dies before SwingContact", () => {
  const server = makeServer();
  const bearNpc = makeNpc(server, "bear", vec(0), Factions.BEAR);
  const playerPosition = vec(0, 0, 1.2);
  const player = addPlayer(server, "player", playerPosition);
  bearNpc.getMeleeContactWindow = () => ({
    startFraction: 0.25,
    endFraction: 0.75
  });
  const bear: any = createBear(bearNpc, server);

  bear.tick(0.1);
  bear.tick(0.1);
  bear.tick(5.2);
  assert.equal(bear.state, "standingUp");
  bear.tick(0.2);
  bear.tick(0.1);
  assert.equal(bear.state, "attack");
  bear.tick(0.1);
  assert.equal(bear.state, "attacking");

  player.isAlive = false;
  bear.tick(0.4);
  assert.deepEqual(
    bearNpc.damageCalls,
    [],
    "a dead target must not receive damage at the swing contact window"
  );
  bear.tick(1.1);
  assert.deepEqual(bearNpc.damageCalls, []);
});

test("bear ignores a non-hostile passive target", () => {
  const server = makeServer();
  const bearNpc = makeNpc(server, "bear", vec(0), Factions.BEAR);
  makeNpc(server, "deer", vec(0, 0, 5), Factions.PASSIVE);
  server.aiTargetSpatialMap.set("0,0", [
    { id: "deer", position: vec(0, 0, 5), faction: Factions.PASSIVE }
  ]);
  const bear: any = createBear(bearNpc, server);

  bear.tick(0.1);
  assert.equal(bear.state, "wander");
  assert.equal(bear.targetCharacterId, null);
});

test("bear selects a hostile zombie but ignores a wolf", () => {
  const server = makeServer();
  const bearNpc = makeNpc(server, "bear", vec(0), Factions.BEAR);
  const wolfPosition = vec(0, 0, 5);
  const zombiePosition = vec(0, 0, 6);
  makeNpc(server, "wolf", wolfPosition, Factions.WOLF);
  makeNpc(server, "zombie", zombiePosition, Factions.ZOMBIE);
  server.aiTargetSpatialMap.set("0,0", [
    { id: "wolf", position: wolfPosition, faction: Factions.WOLF },
    { id: "zombie", position: zombiePosition, faction: Factions.ZOMBIE }
  ]);
  const bear: any = createBear(bearNpc, server);

  bear.tick(0.1);
  assert.equal(bear.state, "standingUp");
  assert.equal(bear.targetCharacterId, "zombie");
});

test("predators and passive prey choose the nearest eligible target", () => {
  const server = makeServer();
  const bearNpc = makeNpc(server, "bear", vec(0), Factions.BEAR);
  const player = addPlayer(server, "player", vec(0, 0, 5));
  server._npcs.zombie = {
    characterId: "zombie",
    faction: Factions.ZOMBIE,
    isAlive: true,
    state: { position: vec(0, 0, 20) }
  };
  const targets = server.aiTargetSpatialMap.get("0,0")!;
  server.aiTargetSpatialMap.set("0,0", [
    {
      id: "zombie",
      position: server._npcs.zombie.state.position,
      faction: Factions.ZOMBIE
    },
    ...targets
  ]);
  const bear: any = createBear(bearNpc, server);
  bear.tick(0.1);
  assert.equal(bear.targetCharacterId, player.characterId);

  const deerServer = makeServer();
  const deerNpc = makeNpc(deerServer, "deer", vec(0), Factions.PASSIVE);
  deerServer.aiTargetSpatialMap.set("0,0", [
    { id: "far", position: vec(0, 0, 18), faction: Factions.HUMAN },
    { id: "near", position: vec(0, 0, 4), faction: Factions.HUMAN }
  ]);
  const deer: any = createDeer(deerNpc, deerServer);
  deer.tick(0.1);
  assert.deepEqual(Array.from(deer.threatPos), [0, 0, 4, 0]);
});

test("bear abandons a dead target and returns to wandering", () => {
  const server = makeServer();
  const bearNpc = makeNpc(server, "bear", vec(0), Factions.BEAR);
  const player = addPlayer(server, "player", vec(0, 0, 10));
  const bear: any = createBear(bearNpc, server);

  bear.tick(0.1);
  bear.tick(0.1);
  bear.tick(5.2);
  assert.equal(bear.state, "standingUp");
  bear.tick(0.2);
  assert.equal(bear.state, "chase");

  player.isAlive = false;
  bear.tick(0.1);
  assert.equal(bear.state, "wander");
  assert.equal(bear.targetCharacterId, null);
});

test("wolf howls, alerts a nearby wolf, then attacks a hostile player", () => {
  const server = makeServer();
  const wolfNpc = makeNpc(server, "wolf", vec(0), Factions.WOLF);
  const packNpc = makeNpc(server, "pack-wolf", vec(0, 0, 20), Factions.WOLF);
  const playerPosition = vec(0, 0, 10);
  addPlayer(server, "player", playerPosition);
  server.aiTargetSpatialMap.get("0,0").push(
    { id: "wolf", position: wolfNpc.state.position, faction: Factions.WOLF },
    {
      id: "pack-wolf",
      position: packNpc.state.position,
      faction: Factions.WOLF
    }
  );
  const wolf: any = createWolf(wolfNpc, server);
  const packWolf: any = createWolf(packNpc, server);
  wolfNpc.fsm = wolf;
  packNpc.fsm = packWolf;

  wolf.tick(0.1);
  assert.equal(wolf.state, "howling");
  assert.equal(packWolf.state, "chase");
  assert.equal(packWolf.targetCharacterId, "player");

  wolf.tick(0.1);
  assert.ok(
    wolfNpc.animations.some((name: string) => name.endsWith(":WolfHowl"))
  );
  wolf.tick(4.9);
  assert.equal(wolf.state, "howling");
  wolf.tick(0.1);
  assert.equal(wolf.state, "chase");
  assert.equal(wolfNpc.speeds.at(-1), 6.5);
  assert.equal(wolfNpc.locomotionModes.at(-1), "sprint");
  assert.equal(wolfNpc.combatAnimationModes.at(-1), true);

  playerPosition[2] = 1.2;
  wolf.tick(0.1);
  assert.equal(wolf.state, "attack");
  assert.equal(wolfNpc.locomotionModes.at(-1), "walk");
  wolf.tick(0.1);
  assert.equal(wolf.state, "attacking");
  assert.deepEqual(wolf.attackForward, [0, 1]);
  const lookAtCallsAtSwingStart = wolfNpc.lookAtCalls;
  wolf.tick(1);
  assert.equal(wolfNpc.lookAtCalls, lookAtCallsAtSwingStart);
  assert.deepEqual(wolfNpc.damageCalls, ["player"]);
  assert.equal(
    wolfNpc.animations.at(-1),
    "set:Idle",
    "a completed Wolf KnifeSlash must hand the native graph back to Idle"
  );
  assert.equal(wolf.state, "attack");

  // Detection is 2D, but the actual melee envelope is 3D: a target that is
  // horizontally close but well above the wolf must not receive a hit.
  playerPosition[1] = 3;
  wolf.tick(0.1);
  assert.equal(wolf.state, "chase");
  assert.deepEqual(wolfNpc.damageCalls, ["player"]);
  assert.equal(wolfNpc.speeds.at(-1), 6.5);
  assert.equal(wolfNpc.locomotionModes.at(-1), "sprint");
});

test("wolf howl alert does not publish sprint for a stale target", () => {
  const server = makeServer();
  const wolfNpc = makeNpc(server, "wolf", vec(0), Factions.WOLF);
  const wolf: any = createWolf(wolfNpc, server);

  wolf.targetCharacterId = "missing-player";
  wolf.threatPos = vec(0, 0, 8);
  wolf.event("alertedByHowl");

  assert.equal(wolf.state, "wander");
  assert.equal(wolf.targetCharacterId, null);
  assert.ok(
    !wolfNpc.speeds.includes(6.5),
    "a stale howl alert must not leave a sprint speed behind"
  );
  assert.equal(wolfNpc.locomotionModes.at(-1), "walk");
});

test("wolf treats a passive deer as hostile wildlife", () => {
  const server = makeServer();
  const wolfNpc = makeNpc(server, "wolf", vec(0), Factions.WOLF);
  const deerPosition = vec(0, 0, 10);
  makeNpc(server, "deer", deerPosition, Factions.PASSIVE);
  server.aiTargetSpatialMap.set("0,0", [
    { id: "deer", position: deerPosition, faction: Factions.PASSIVE }
  ]);
  const wolf: any = createWolf(wolfNpc, server);

  wolf.tick(0.1);
  assert.equal(wolf.state, "howling");
  assert.equal(wolf.targetCharacterId, "deer");
});

test("wolf applies its NPC damage path to a passive deer in melee range", () => {
  const server = makeServer();
  const wolfNpc = makeNpc(server, "wolf", vec(0), Factions.WOLF);
  const deerPosition = vec(0, 0, 10);
  const deerNpc = makeNpc(server, "deer", deerPosition, Factions.PASSIVE);
  server.aiTargetSpatialMap.set("0,0", [
    { id: "deer", position: deerPosition, faction: Factions.PASSIVE }
  ]);
  const wolf: any = createWolf(wolfNpc, server);

  wolf.tick(0.1);
  assert.equal(wolf.state, "howling");
  wolf.tick(0.1);
  wolf.tick(4.9);
  assert.equal(wolf.state, "howling");
  wolf.tick(0.1);
  assert.equal(wolf.state, "chase");

  deerPosition[2] = 1.2;
  wolf.tick(0.1);
  assert.equal(wolf.state, "attack");
  wolf.tick(0.1);
  assert.equal(wolf.state, "attacking");
  wolf.tick(1);

  assert.equal(deerNpc.npcDamageCalls.length, 1);
  assert.deepEqual(deerNpc.npcDamageCalls[0], {
    entity: "wolf",
    damage: 1
  });
});

test("gasser's ranged action does not fall through to melee damage", () => {
  const server = makeServer();
  const gasserNpc = makeNpc(server, "gasser", vec(0), Factions.ZOMBIE);
  const playerPosition = vec(0, 0, 1.2);
  addPlayer(server, "player", playerPosition);
  const gasser: any = createGasser(gasserNpc, server);

  // The production Gasser FSM shares one Attacking state for KnifeSlash,
  // Spit, and GasConvulse. Force the Spit transition and let the shared state
  // finish; only KnifeSlash is allowed to call applyDamageToTarget().
  gasser.ChargeGas = 0;
  gasser.tick(0.1);
  assert.equal(gasser.state, "chase");
  gasser.tick(0.1);
  assert.equal(gasser.state, "attack");
  gasser.event("spit");
  assert.equal(gasser.state, "attacking");
  assert.equal(gasserNpc.speeds.at(-1), 0);
  gasser.tick(1.1);

  assert.equal(gasserNpc.damageCalls.length, 0);
  assert.ok(
    gasserNpc.animations.some((name: string) => name.endsWith(":Spit"))
  );
});

test("gasser keeps closing between its gas envelope and melee range", () => {
  const server = makeServer();
  const gasserNpc = makeNpc(server, "gasser", vec(0), Factions.ZOMBIE);
  const playerPosition = vec(0, 0, 5);
  addPlayer(server, "player", playerPosition);
  const gasser: any = createGasser(gasserNpc, server);

  gasser.tick(0.1);
  assert.equal(gasser.state, "chase");
  gasser.tick(0.1);
  assert.equal(gasser.state, "attack");
  gasser.tick(0.1);
  assert.equal(gasserNpc.locomotionModes.at(-1), "sprint");
  assert.ok(gasserNpc.moveTargets.length > 0);
  assert.equal(gasserNpc.stopCount, 1);
});

test("hostile zombie variants publish their initial agitation speed before patrol", () => {
  const cases = [
    { name: "zombie", create: createZombie, expected: 2.5 },
    { name: "gasser", create: createGasser, expected: 2 },
    { name: "exploder", create: createExploder, expected: 3.5 }
  ] as const;

  for (const testCase of cases) {
    const server = makeServer();
    const npc = makeNpc(server, testCase.name, vec(0), Factions.ZOMBIE);
    testCase.create(npc, server);
    assert.equal(
      npc.speeds[0],
      testCase.expected,
      `${testCase.name} must configure its walk speed before the first nav step`
    );
  }
});

test("zombie patrol speed follows agitation instead of a fixed chase constant", () => {
  const server = makeServer();
  const npc = makeNpc(server, "zombie", vec(0), Factions.ZOMBIE);
  const zombie: any = createZombie(npc, server);

  zombie.agitation = 100;
  zombie.tick(0.1);
  assert.equal(npc.speeds.at(-1), 1 + (zombie.agitation / 100) * 3);

  zombie.agitation = 1;
  zombie.tick(0.1);
  assert.equal(npc.speeds.at(-1), 1 + (zombie.agitation / 100) * 3);
});

test("zombie feeding clears movement speed after reaching a corpse", () => {
  const server = makeServer() as any;
  const npc = makeNpc(server, "zombie", vec(0), Factions.ZOMBIE);
  const corpsePosition = vec(0, 0, 5);
  server._characters.corpse = {
    characterId: "corpse",
    isAlive: false,
    state: { position: corpsePosition }
  };
  server.getClientsInRange = () => [
    { character: { characterId: "corpse", isAlive: false } }
  ];
  const zombie: any = createZombie(npc, server);
  zombie.hunger = 80;

  zombie.tick(0.1);
  assert.equal(zombie.state, "feed");
  zombie.tick(0.1);
  assert.ok(npc.moveTargets.length > 0);
  assert.equal(npc.speeds.at(-1), 2.5);

  corpsePosition[2] = 1;
  zombie.tick(0.1);
  assert.equal(zombie.isEatingCorpse, true);
  assert.equal(
    npc.speeds.at(-1),
    0,
    "reaching a corpse must clear the previous patrol speed"
  );

  zombie.tick(0.1);
  assert.equal(
    npc.speeds.at(-1),
    0,
    "eating must keep ExpectedSpeed at zero"
  );
});

test("special zombie feeders keep the eating pose stationary", () => {
  const cases = [
    { name: "gasser", create: createGasser },
    { name: "exploder", create: createExploder }
  ] as const;

  for (const testCase of cases) {
    const server = makeServer() as any;
    const npc = makeNpc(server, testCase.name, vec(0), Factions.ZOMBIE);
    const corpsePosition = vec(0, 0, 5);
    server._characters.corpse = {
      characterId: "corpse",
      isAlive: false,
      state: { position: corpsePosition }
    };
    server.getClientsInRange = () => [
      { character: { characterId: "corpse", isAlive: false } }
    ];
    const fsm: any = testCase.create(npc, server);
    fsm.hunger = 80;

    fsm.tick(0.1);
    assert.equal(fsm.state, "feed", `${testCase.name} should smell the corpse`);
    fsm.tick(0.1);
    assert.ok(npc.moveTargets.length > 0);
    assert.ok((npc.speeds.at(-1) ?? 0) > 0);

    corpsePosition[2] = 1;
    fsm.tick(0.1);
    assert.equal(fsm.isEatingCorpse, true);
    assert.equal(npc.speeds.at(-1), 0);
    fsm.tick(0.1);
    assert.equal(
      npc.speeds.at(-1),
      0,
      `${testCase.name} must keep ExpectedSpeed at zero while eating`
    );
  }
});

test("all hostile zombie variants stop sprinting before their attack action", () => {
  const cases = [
    {
      name: "zombie",
      create: createZombie,
      position: 8,
      attackPosition: 1.2
    },
    {
      name: "exploder",
      create: createExploder,
      position: 8,
      attackPosition: 1.2
    }
  ] as const;

  for (const testCase of cases) {
    const server = makeServer();
    const npc = makeNpc(server, testCase.name, vec(0), Factions.ZOMBIE);
    const playerPosition = vec(0, 0, testCase.position);
    addPlayer(server, "player", playerPosition);
    const fsm: any = testCase.create(npc, server);

    fsm.tick(0.1);
    assert.equal(fsm.state, "chase", `${testCase.name} should chase`);
    fsm.tick(0.1);
    assert.equal(npc.locomotionModes.at(-1), "sprint");
    assert.ok((npc.speeds.at(-1) ?? 0) > 0);

    playerPosition[2] = testCase.attackPosition;
    fsm.tick(0.1);
    assert.equal(fsm.state, "attack", `${testCase.name} should stage attack`);
    assert.equal(npc.locomotionModes.at(-1), "walk");
    assert.ok(npc.stopCount > 0);

    // The attack state must not leave a sprint command queued while its
    // wind-up timer is waiting for the one-shot animation to finish.
    fsm.tick(0.1);
    assert.equal(npc.locomotionModes.at(-1), "walk");
    assert.ok(!npc.locomotionModes.slice(-2).includes("sprint"));
    assert.equal(
      npc.speeds.at(-1),
      0,
      `${testCase.name} must keep ExpectedSpeed at zero during attack staging`
    );
  }
});

test("hostile NPCs fail closed when Recast rejects their chase target", () => {
  const cases = [
    { id: "zombie", create: createZombie },
    { id: "gasser", create: createGasser },
    { id: "exploder", create: createExploder }
  ] as const;

  for (const testCase of cases) {
    const server = makeServer();
    const npc = makeNpc(server, testCase.id, vec(0), Factions.ZOMBIE);
    npc.navAgent.requestMoveTarget = () => false;
    addPlayer(server, "player", vec(0, 0, 8));
    const fsm: any = testCase.create(npc, server);

    fsm.tick(0.1);

    assert.equal(fsm.state, "chase");
    assert.equal(
      npc.speeds.at(-1),
      0,
      `${testCase.id} must not leave agitation speed advertised after a rejected chase target`
    );
    assert.equal(
      npc.locomotionModes.at(-1),
      "walk",
      `${testCase.id} must not leave sprint intent advertised after a rejected chase target`
    );
  }
});

test("screamer fails closed when its patrol/chase target is rejected", () => {
  const server = makeServer();
  const npc = makeNpc(server, "screamer", vec(0), Factions.ZOMBIE);
  npc.navAgent.requestMoveTarget = () => false;
  addPlayer(server, "player", vec(0, 0, 8));
  const screamer: any = createScreamer(npc, server);

  screamer.tick(0.1);
  assert.equal(screamer.state, "rising");
  screamer.tick(1.5);
  assert.equal(screamer.state, "Screaming");
  screamer.tick(10 / 3);
  assert.equal(screamer.state, "chase");
  screamer.armsFreed = true;
  screamer.tick(0.1);

  assert.equal(npc.speeds.at(-1), 0);
  assert.equal(npc.locomotionModes.at(-1), "walk");
});

test("zombie and gasser lock their facing for the full melee one-shot", () => {
  for (const testCase of [
    { name: "zombie", create: createZombie },
    { name: "gasser", create: createGasser }
  ] as const) {
    const server = makeServer();
    const npc = makeNpc(server, testCase.name, vec(0), Factions.ZOMBIE);
    const playerPosition = vec(0, 0, 1.2);
    addPlayer(server, "player", playerPosition);
    const fsm: any = testCase.create(npc, server);
    if (testCase.name === "gasser") fsm.ChargeGas = 0;

    fsm.tick(0.1);
    fsm.tick(0.1);
    assert.equal(fsm.state, "attack");
    fsm.tick(0.1);
    assert.equal(fsm.state, "attacking");
    assert.deepEqual(fsm.attackForward, [0, 1]);

    const lookAtCallsAtSwingStart = npc.lookAtCalls;
    playerPosition[0] = 2;
    playerPosition[2] = 0;
    fsm.tick(1);
    assert.equal(
      npc.lookAtCalls,
      lookAtCallsAtSwingStart,
      `${testCase.name} must not track a moving target after KnifeSlash starts`
    );
  }
});

test("exploder uses the configured melee envelope for chase and detonation", () => {
  const server = makeServer();
  const exploderNpc = makeNpc(server, "exploder", vec(0), Factions.ZOMBIE);
  exploderNpc.getMeleeAttackRange = () => 1.5;
  const playerPosition = vec(0, 0, 8);
  addPlayer(server, "player", playerPosition);
  const exploder: any = createExploder(exploderNpc, server);

  exploder.tick(0.1);
  assert.equal(exploder.state, "chase");

  // 1.7m is inside the old hard-coded 2m gate but outside the weapon table
  // range.  It must continue sprinting instead of staging an explosion.
  playerPosition[2] = 1.7;
  exploder.tick(0.1);
  assert.equal(exploder.state, "chase");
  assert.equal(exploderNpc.locomotionModes.at(-1), "sprint");

  playerPosition[2] = 1.2;
  exploder.tick(0.1);
  assert.equal(exploder.state, "attack");
  assert.equal(exploderNpc.locomotionModes.at(-1), "walk");
});

test("screamer switches from sprint chase to a stopped melee wind-up", () => {
  const server = makeServer();
  const screamerNpc = makeNpc(server, "screamer", vec(0), Factions.ZOMBIE);
  const playerPosition = vec(0, 0, 8);
  addPlayer(server, "player", playerPosition);
  const screamer: any = createScreamer(screamerNpc, server);

  // Sleep -> Rising -> Screaming -> Chase is the normal screamer activation
  // chain. Free the arms after the scream so the melee phase is reachable.
  screamer.tick(0.1);
  assert.equal(screamer.state, "rising");
  // ScreamerRise is a one-shot and must finish before the vocal event can
  // replace it.  The lightweight fixture reports the public clip as settled,
  // so advance the server phase clock explicitly.
  screamer.tick(1.5);
  assert.equal(screamer.state, "Screaming");
  // Scream is the 100-frame (3.333 s) source clip, not a three-second
  // approximation.  Keep the fixture aligned with the production fallback
  // clock so the FSM cannot hand control back to chase early.
  screamer.tick(10 / 3);
  assert.equal(screamer.state, "chase");
  screamer.armsFreed = true;
  assert.equal(screamerNpc.locomotionModes.at(-1), "sprint");

  playerPosition[2] = 1.2;
  screamer.tick(0.1);
  assert.equal(screamer.state, "attack");
  assert.equal(screamerNpc.locomotionModes.at(-1), "walk");
  screamer.tick(0.1);
  assert.equal(screamer.state, "attacking");
  assert.equal(screamerNpc.locomotionModes.at(-1), "walk");
  assert.equal(screamerNpc.speeds.at(-1), 0);
  assert.ok(screamerNpc.stopCount > 0);
  assert.deepEqual(screamer.attackForward, [0, 1]);
  const lookAtCallsAtSwingStart = screamerNpc.lookAtCalls;
  playerPosition[0] = 2;
  playerPosition[2] = 0;
  screamer.tick(1);
  assert.equal(screamerNpc.lookAtCalls, lookAtCallsAtSwingStart);
});

test("deer wanders, flees a nearby player, and calms when the threat leaves", () => {
  const server = makeServer();
  const deerNpc = makeNpc(server, "deer", vec(0), Factions.PASSIVE);
  const deer: any = createDeer(deerNpc, server);

  deer.tick(0.1);
  assert.equal(deer.state, "wander");
  assert.ok(deerNpc.moveTargets.length > 0);
  assert.equal(deerNpc.speeds.at(-1), 3);
  assert.equal(deerNpc.locomotionModes.at(-1), "walk");
  assert.equal(deerNpc.combatAnimationModes.length, 0);

  const playerPosition = vec(0, 0, 10);
  addPlayer(server, "player", playerPosition);
  deer.tick(0.1);
  assert.equal(deer.state, "flee");
  assert.ok(deer.threatPos);
  assert.ok(deerNpc.moveTargets.length > 1);
  assert.equal(deerNpc.speeds.at(-1), 7);
  assert.equal(deerNpc.locomotionModes.at(-1), "sprint");
  assert.equal(deerNpc.combatAnimationModes.length, 0);

  const stopsBeforeCalm = deerNpc.stopCount;
  clearTargets(server);
  deer.tick(0.1);
  assert.equal(deer.state, "wander");
  assert.equal(deer.threatPos, null);
  assert.ok(
    deerNpc.stopCount > stopsBeforeCalm,
    "calming must cancel the flee nav request before walk resumes"
  );
  assert.equal(deerNpc.damageCalls.length, 0);
});

test("passive deer flees an aggressive wolf instead of attacking it", () => {
  const server = makeServer();
  const deerNpc = makeNpc(server, "deer", vec(0), Factions.PASSIVE);
  const wolfPosition = vec(0, 0, 10);
  makeNpc(server, "wolf", wolfPosition, Factions.WOLF);
  server.aiTargetSpatialMap.set("0,0", [
    { id: "wolf", position: wolfPosition, faction: Factions.WOLF }
  ]);
  const deer: any = createDeer(deerNpc, server);

  deer.tick(0.1);
  assert.equal(deer.state, "flee");
  assert.equal(deerNpc.damageCalls.length, 0);
});

test("passive deer ignores neutral and passive spatial entries", () => {
  const server = makeServer();
  const deerNpc = makeNpc(server, "deer", vec(0), Factions.PASSIVE);
  const deerPosition = vec(0, 0, 5);
  server.aiTargetSpatialMap.set("0,0", [
    { id: "unknown", position: deerPosition, faction: Factions.None },
    { id: "other-deer", position: deerPosition, faction: Factions.PASSIVE }
  ]);
  const deer: any = createDeer(deerNpc, server);

  deer.tick(0.1);
  assert.equal(deer.state, "wander");
  assert.equal(deer.threatPos, null);
  assert.equal(deerNpc.speeds.at(-1), 3);
});

test("rabbit idles, wanders, flees a nearby player, and never enters an attack state", () => {
  const server = makeServer();
  const rabbitNpc = makeNpc(server, "rabbit", vec(0), Factions.PASSIVE);
  const rabbit: any = createRabbit(rabbitNpc, server);

  rabbit.tick(rabbit.idleDuration + 0.1);
  assert.equal(rabbit.state, "wander");
  assert.ok(rabbitNpc.moveTargets.length > 0);
  assert.equal(rabbitNpc.speeds.at(-1), 1.75);
  assert.equal(rabbitNpc.locomotionModes.at(-1), "walk");
  assert.equal(rabbitNpc.combatAnimationModes.length, 0);

  const playerPosition = vec(0, 0, 15);
  addPlayer(server, "player", playerPosition);
  rabbit.tick(0.1);
  assert.equal(rabbit.state, "flee");
  assert.ok(rabbit.threatPos);
  assert.equal(rabbitNpc.damageCalls.length, 0);
  assert.equal(rabbitNpc.speeds.at(-1), 5);
  assert.equal(rabbitNpc.locomotionModes.at(-1), "sprint");
  assert.equal(rabbitNpc.combatAnimationModes.length, 0);

  clearTargets(server);
  rabbit.tick(0.1);
  assert.equal(rabbit.state, "idle");
  assert.equal(rabbitNpc.damageCalls.length, 0);
  assert.equal(
    rabbitNpc.speeds.at(-1),
    0,
    "an idle rabbit must not keep advertising its previous wander speed"
  );
  assert.ok(!["attack", "attacking", "chase"].includes(rabbit.state));
});

test("passive rabbit flees a bear and never emits damage", () => {
  const server = makeServer();
  const rabbitNpc = makeNpc(server, "rabbit", vec(0), Factions.PASSIVE);
  const bearPosition = vec(0, 0, 5);
  makeNpc(server, "bear", bearPosition, Factions.BEAR);
  server.aiTargetSpatialMap.set("0,0", [
    { id: "bear", position: bearPosition, faction: Factions.BEAR }
  ]);
  const rabbit: any = createRabbit(rabbitNpc, server);

  rabbit.tick(0.1);
  assert.equal(rabbit.state, "flee");
  assert.equal(rabbitNpc.damageCalls.length, 0);
  assert.ok(!["attack", "attacking", "chase"].includes(rabbit.state));
});

test("passive rabbit ignores neutral and passive spatial entries", () => {
  const server = makeServer();
  const rabbitNpc = makeNpc(server, "rabbit", vec(0), Factions.PASSIVE);
  const rabbitPosition = vec(0, 0, 5);
  server.aiTargetSpatialMap.set("0,0", [
    { id: "unknown", position: rabbitPosition, faction: Factions.None },
    { id: "other-rabbit", position: rabbitPosition, faction: Factions.PASSIVE }
  ]);
  const rabbit: any = createRabbit(rabbitNpc, server);

  rabbit.tick(rabbit.idleDuration + 0.1);
  assert.equal(rabbit.state, "wander");
  assert.equal(rabbit.threatPos, null);
  assert.equal(rabbitNpc.speeds.at(-1), 1.75);
});

test("rabbit does not advertise walk when its patrol query returns no target", () => {
  const server = makeServer();
  server.navManager.navMeshQuery.findRandomPointAroundCircle = () => ({
    success: false,
    randomPoint: { x: 0, y: 0, z: 0 }
  });
  const rabbitNpc = makeNpc(server, "rabbit", vec(0), Factions.PASSIVE);
  const rabbit: any = createRabbit(rabbitNpc, server);
  rabbit.idleDuration = 0;

  rabbit.tick(0.1);
  assert.equal(rabbit.state, "wander");
  assert.equal(rabbit.targetPos, null);
  assert.equal(rabbitNpc.speeds.at(-1), 0);

  rabbit.tick(0.1);
  assert.equal(rabbit.state, "idle");
  assert.ok(
    rabbitNpc.speeds.every((speed: number) => speed === 0),
    "a missing patrol target must never create a stationary walk/slide packet"
  );
});

test("passive animals do not advertise flee speed without an accepted nav path", () => {
  for (const [id, create] of [
    ["deer", createDeer],
    ["rabbit", createRabbit]
  ] as const) {
    const server = makeServer();
    const npc = makeNpc(server, id, vec(0), Factions.PASSIVE);
    // Simulate the transient missing-agent condition during nav attachment.
    npc.navAgent = undefined;
    addPlayer(server, "player", vec(0, 0, 5));
    const fsm: any = create(npc, server);

    fsm.tick(0.1);
    assert.equal(fsm.state, "flee");
    assert.equal(npc.speeds.at(-1), 0, `${id} must not run in place`);
    assert.equal(npc.locomotionModes.at(-1), "walk");
  }
});
