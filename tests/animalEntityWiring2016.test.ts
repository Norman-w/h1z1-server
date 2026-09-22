import assert from "node:assert/strict";
import test from "node:test";
import { NavManager } from "../out/utils/recast";
import { ZoneServer2016 } from "../out/servers/ZoneServer2016/zoneserver";
import { WorldObjectManager } from "../out/servers/ZoneServer2016/managers/worldobjectmanager";
import { Bear } from "../out/servers/ZoneServer2016/entities/bear";
import { BasicNpc } from "../out/servers/ZoneServer2016/entities/basicnpc";
import { Deer } from "../out/servers/ZoneServer2016/entities/deer";
import { Exploder } from "../out/servers/ZoneServer2016/entities/exploder";
import { Gasser } from "../out/servers/ZoneServer2016/entities/gasser";
import { Rabbit } from "../out/servers/ZoneServer2016/entities/rabbit";
import { Wolf } from "../out/servers/ZoneServer2016/entities/wolf";
import { PrototypeZombie } from "../out/servers/ZoneServer2016/entities/prototypezombie";
import { ZombieScreamer } from "../out/servers/ZoneServer2016/entities/zombiescreamer";
import { ZombieWalker } from "../out/servers/ZoneServer2016/entities/zombiewalker";
import { Factions } from "../out/servers/ZoneServer2016/jsms/factions";
import { ModelIds, NpcIds } from "../out/servers/ZoneServer2016/models/enums";
import { ANIMAL_PROFILE_IDS } from "../out/servers/ZoneServer2016/entities/animalprofiles";

function vec(x: number, y: number, z: number): Float32Array {
  return new Float32Array([x, y, z, 1]);
}

test("production animal entities wire faction, FSM, damage and Recast agents", async () => {
  const navManager = new NavManager();
  await navManager.loadNav();

  const sentPackets: Array<{ command: string; payload: any }> = [];
  const meleeHits: any[] = [];
  const playerPosition = vec(481.47, 109.86, 2858.61);
  const fakeClient: any = {
    isLoading: false,
    vehicle: { mountedVehicle: 0 },
    character: {
      characterId: "player",
      state: { position: playerPosition },
      meleeHit: { abilityHitLocation: "BODY" },
      OnMeleeHit(_server: unknown, damageInfo: unknown) {
        meleeHits.push(damageInfo);
      }
    }
  };
  const server: any = {
    aiEnabled: true,
    navManager,
    _modelsData: {},
    _characters: {},
    _npcs: {},
    _vehicles: {},
    aiTargetSpatialMap: new Map<string, unknown[]>(),
    charactersRenderDistance: 350,
    interactionDistance: 3,
    // Keep the production entity test's weapon resolver on the same
    // authoritative path as a live zone.  The test only needs the checked-in
    // Machete profile's reach/width; it must not exercise the old guessed
    // distance fallback when the target enters attack range.
    getItemDefinition: () => ({ PARAM1: 10 }),
    getWeaponDefinition: () => ({
      MELEE_DETECT: {
        MELEE_DETECT_WIDTH: 0.15,
        MELEE_DETECT_HEIGHT: 0.1
      },
      FIRE_GROUPS: [{ FIRE_GROUP_ID: 10 }]
    }),
    getFiregroupDefinition: () => ({ FIRE_MODES: [{ FIRE_MODE_ID: 13 }] }),
    getFiremodeDefinition: () => ({
      RANGE: 1.5,
      FIRE_DURATION_MS: 850,
      FIRE_ANIM_DURATION_MS: 850,
      REFIRE_TIME_MS: 125
    }),
    // Prototype zombies load their production loadout in the constructor;
    // returning no item keeps this wiring fixture focused on the factory and
    // animation graph without requiring the full inventory database.
    generateItem: () => undefined,
    pushToGridCell() {},
    explosiveManager: { addEntity() {} },
    sendDataToAllWithSpawnedEntity(...args: any[]) {
      sentPackets.push({ command: args[2], payload: args[3] });
    },
    getTransientId() {
      return 100;
    },
    getClientByCharId(characterId: string) {
      return characterId === "player" ? fakeClient : undefined;
    }
  };
  const rotation = vec(0, 0, 0);
  const origin = vec(481.47, 109.86, 2848.61);
  const passiveOrigin = vec(481.47, 109.86, 2869.61);

  const bear = new Bear("bear", 1, origin, rotation, server);
  const wolf = new Wolf("wolf", 2, origin, rotation, server);
  const deer = new Deer(
    "deer",
    3,
    ModelIds.DEER,
    passiveOrigin,
    rotation,
    server
  );
  const deerBuck = new Deer(
    "deer-buck",
    5,
    ModelIds.DEER_BUCK,
    passiveOrigin,
    rotation,
    server
  );
  const rabbit = new Rabbit(
    "rabbit",
    4,
    ModelIds.RABBIT,
    passiveOrigin,
    rotation,
    server
  );

  // Verify the production model factory selects the same AI entity classes
  // used by the direct constructor checks below, including the deer-buck
  // model variant.
  const worldObjectManager = new WorldObjectManager();
  const factoryCases = [
    [ModelIds.BEAR, Bear],
    [ModelIds.WOLF, Wolf],
    [ModelIds.DEER, Deer],
    [ModelIds.DEER_BUCK, Deer],
    [ModelIds.RABBIT, Rabbit]
  ] as const;
  for (const [modelId, entityClass] of factoryCases) {
    const factoryNpc = worldObjectManager.createNpc(
      server,
      modelId,
      origin,
      rotation
    );
    assert.ok(factoryNpc instanceof entityClass);
    assert.ok(factoryNpc.fsm);
    delete server._npcs[factoryNpc.characterId];
  }

  // Every production full-NPC route must install a persistent graph reset
  // before it can be observed.  This is deliberately checked through the
  // same factory used by world spawning, not only through direct constructors:
  // a wrong model/npcId branch can otherwise silently downgrade a special
  // zombie to the generic class while still looking healthy in type-level
  // tests.
  const fullNpcAnimationCases = [
    {
      modelId: ModelIds.ZOMBIE_MALE_WALKER,
      npcId: undefined,
      entityClass: ZombieWalker,
      resetClip: "Idle"
    },
    {
      modelId: ModelIds.ZOMBIE_FEMALE_WALKER,
      npcId: undefined,
      entityClass: ZombieWalker,
      resetClip: "Idle"
    },
    {
      modelId: ModelIds.ZOMBIE_MALE_WALKER,
      npcId: NpcIds.GASSER,
      entityClass: Gasser,
      resetClip: "Idle"
    },
    {
      modelId: ModelIds.ZOMBIE_MALE_WALKER,
      npcId: NpcIds.EXPLODER,
      entityClass: Exploder,
      resetClip: "Idle"
    },
    {
      modelId: ModelIds.ZOMBIE_SCREAMER,
      npcId: undefined,
      entityClass: ZombieScreamer,
      resetClip: "ScreamerReset"
    },
    {
      modelId: ModelIds.DEER,
      npcId: undefined,
      entityClass: Deer,
      resetClip: "Idle"
    },
    {
      modelId: ModelIds.DEER_BUCK,
      npcId: undefined,
      entityClass: Deer,
      resetClip: "Idle"
    },
    {
      modelId: ModelIds.RABBIT,
      npcId: undefined,
      entityClass: Rabbit,
      resetClip: "Idle"
    },
    {
      modelId: ModelIds.WOLF,
      npcId: undefined,
      entityClass: Wolf,
      resetClip: "Idle"
    },
    {
      modelId: ModelIds.BEAR,
      npcId: undefined,
      entityClass: Bear,
      resetClip: "Idle"
    }
  ] as const;
  for (const testCase of fullNpcAnimationCases) {
    const factoryNpc = worldObjectManager.createNpc(
      server,
      testCase.modelId,
      origin,
      rotation,
      0,
      testCase.npcId
    );
    assert.ok(factoryNpc instanceof testCase.entityClass);
    assert.ok(factoryNpc.fsm, `${testCase.resetClip} NPC must have an FSM`);
    assert.equal(
      factoryNpc.nativeTurnReady,
      true,
      `${testCase.entityClass.name} must expose the client-native turn contract`
    );
    assert.equal(factoryNpc.currentAnimation, testCase.resetClip);
    assert.equal(
      factoryNpc.getCurrentAnimationPacket()?.animationName,
      testCase.resetClip,
      `${testCase.entityClass.name} late observers must receive its reset clip`
    );
    delete server._npcs[factoryNpc.characterId];
  }

  // Prototype zombies are not a fourth animation graph.  They must still
  // route through PrototypeZombie so their loadout/NPC identity does not
  // silently downgrade to ZombieWalker when the normal factory is used.
  for (const prototypeNpcId of [
    NpcIds.PROTOTYPE_ASSAULT_ZOMBIE,
    NpcIds.PROTOTYPE_HUNTER_ZOMBIE,
    NpcIds.PROTOTYPE_SNIPER_ZOMBIE
  ]) {
    const factoryNpc = worldObjectManager.createNpc(
      server,
      ModelIds.ZOMBIE_MALE_WALKER,
      origin,
      rotation,
      0,
      prototypeNpcId
    );
    assert.ok(factoryNpc instanceof PrototypeZombie);
    assert.equal(factoryNpc.npcId, prototypeNpcId);
    assert.ok(factoryNpc.fsm);
    assert.equal(factoryNpc.nativeTurnReady, true);
    assert.equal(factoryNpc.currentAnimation, "Idle");
    delete server._npcs[factoryNpc.characterId];
  }

  // Unknown/full-character model ids still use the same animation handoff;
  // they must not enter the world with an empty graph just because they have
  // no AI FSM or species-specific JSM.
  const fallbackNpc = worldObjectManager.createNpc(
    server,
    0x7ffffffe,
    origin,
    rotation
  );
  assert.ok(fallbackNpc instanceof BasicNpc);
  assert.equal(fallbackNpc.fsm, undefined);
  assert.equal(fallbackNpc.currentAnimation, "Idle");
  assert.equal(fallbackNpc.getCurrentAnimationPacket()?.animationName, "Idle");
  assert.equal(
    fallbackNpc.isPathfindingMovementSuppressed,
    true,
    "an inert fallback NPC must not drift with an unowned crowd agent"
  );
  delete server._npcs[fallbackNpc.characterId];

  // Raven is also inert in the current server, but its client-side bird graph
  // exposes native continuous TurnLeft/TurnRight transitions. It must not be
  // classified as an unknown model and lose that native turn contract.
  const ravenNpc = worldObjectManager.createNpc(
    server,
    ModelIds.RAVEN,
    origin,
    rotation
  );
  assert.ok(ravenNpc instanceof BasicNpc);
  assert.equal(ravenNpc.nativeTurnReady, true);
  assert.equal(ravenNpc.getNativeTurnProfile()?.turnMode, "continuous-graph");
  assert.equal(
    ravenNpc.getNativeTurnProfile()?.inputParameter,
    "State_Turning/TurnRate"
  );
  delete server._npcs[ravenNpc.characterId];

  assert.equal(bear.faction, Factions.BEAR);
  assert.equal(wolf.faction, Factions.WOLF);
  assert.equal(deer.faction, Factions.PASSIVE);
  assert.equal(deerBuck.faction, Factions.PASSIVE);
  assert.equal(rabbit.faction, Factions.PASSIVE);
  assert.equal(bear.npcMeleeDamage, 4000);
  assert.equal(wolf.npcMeleeDamage, 2000);
  assert.equal(bear.profileId, ANIMAL_PROFILE_IDS.BEAR);
  assert.equal(wolf.profileId, ANIMAL_PROFILE_IDS.WOLF);
  assert.equal(deer.profileId, ANIMAL_PROFILE_IDS.DEER);
  assert.equal(deerBuck.profileId, ANIMAL_PROFILE_IDS.DEER);
  assert.equal(rabbit.profileId, ANIMAL_PROFILE_IDS.RABBIT);
  const rabbitLightweight = rabbit.pGetLightweight();
  assert.equal(
    rabbitLightweight.npcDefinitionId,
    NpcIds.RABBIT,
    "Rabbit must provide its native NPC definition for lightweight rendering"
  );
  assert.equal(
    rabbitLightweight.useCollision,
    1,
    "Rabbit lightweight spawns must opt into the native collision/render path"
  );
  assert.equal(bear.nativeMeleeEngagementRange, 2.5);
  assert.equal(wolf.nativeMeleeEngagementRange, 2);
  assert.equal(deer.npcMeleeDamage, 0);
  assert.equal(deerBuck.npcMeleeDamage, 0);
  assert.equal(rabbit.npcMeleeDamage, 0);
  assert.equal(bear.nativeMeleeCapability, "attacker");
  assert.equal(wolf.nativeMeleeCapability, "attacker");
  assert.equal(deer.nativeMeleeCapability, "passive");
  assert.equal(deerBuck.nativeMeleeCapability, "passive");
  assert.equal(rabbit.nativeMeleeCapability, "passive");
  for (const animal of [bear, wolf, deer, deerBuck, rabbit]) {
    assert.equal(
      animal.getNativeLocomotionProfile()?.inputParameter,
      "VelocityLocalZ"
    );
    assert.equal(animal.getNativeLocomotionProfile()?.maximumSpeed, 8);
  }
  // These are the per-species normalized SwingContact intervals recovered
  // from AnimalsPhysicsX64.mrn.  They are deliberately not collapsed into a
  // single fixed hit delay: the attack FSM scales each interval by its own
  // action clock, while passive animals retain the data for diagnostics only.
  assert.deepEqual(bear.getMeleeContactWindow(), {
    startFraction: 0.266667,
    endFraction: 0.733333
  });
  assert.deepEqual(wolf.getMeleeContactWindow(), {
    startFraction: 0.259999,
    endFraction: 0.740001
  });
  assert.deepEqual(deer.getMeleeContactWindow(), {
    startFraction: 0.3,
    endFraction: 0.7
  });
  assert.deepEqual(rabbit.getMeleeContactWindow(), {
    startFraction: 0.214286,
    endFraction: 0.785714
  });
  assert.equal(bear.nativeMeleeFlinchAnimationDurationMs, 1667);
  assert.equal(wolf.nativeMeleeFlinchAnimationDurationMs, 1000);
  assert.equal(deer.nativeMeleeFlinchAnimationDurationMs, 1000);
  assert.equal(rabbit.nativeMeleeFlinchAnimationDurationMs, 1300);
  assert.equal(bear.getMeleeAttackProfileSource(), "compatibility-proxy");
  assert.equal(wolf.getMeleeAttackProfileSource(), "compatibility-proxy");
  assert.equal(
    bear.getMeleeAttackEnvelopeSource(),
    "animal-engagement-projection"
  );
  assert.equal(
    wolf.getMeleeAttackEnvelopeSource(),
    "animal-engagement-projection"
  );
  assert.equal(deer.getMeleeAttackEnvelopeSource(), "not-applicable");
  assert.equal(deerBuck.getMeleeAttackEnvelopeSource(), "not-applicable");
  assert.equal(rabbit.getMeleeAttackEnvelopeSource(), "not-applicable");
  assert.equal(
    deer.isMeleeTargetInEnvelope(new Float32Array([0, 0, 1, 1])),
    false
  );
  assert.equal(
    rabbit.isMeleeTargetInEnvelope(new Float32Array([0, 0, 1, 1])),
    false
  );

  // The shared AnimalsPhysics graph has attack resources for passive species,
  // but a legacy caller must not be able to bypass the passive FSM and enter
  // KnifeSlash through Npc.triggerMeleeAttack().
  sentPackets.length = 0;
  deer.triggerMeleeAttack();
  rabbit.triggerMeleeAttack();
  deer.playAnimation("KnifeSlash");
  rabbit.setAnimation("KnifeSlash");
  assert.equal(
    sentPackets.some(
      ({ command, payload }) =>
        command === "Character.PlayAnimation" &&
        payload?.animationName === "KnifeSlash"
    ),
    false
  );

  assert.deepEqual(deer.getNativeContactContract(), {
    signal: "AnimalsPhysics.SwingContact",
    clientAuthority: "client-local-graph",
    serverDamageAuthority: "unavailable",
    geometrySource: "unavailable",
    liveVerified: false
  });
  assert.ok(bear.fsm);
  assert.ok(wolf.fsm);
  assert.ok(deer.fsm);
  assert.ok(deerBuck.fsm);
  assert.ok(rabbit.fsm);
  for (const animal of [bear, wolf, deer, deerBuck, rabbit]) {
    assert.equal(
      animal.currentAnimation,
      "Idle",
      `${animal.characterId} must expose a persistent Idle clip at spawn`
    );
    assert.equal(
      animal.getCurrentAnimationPacket()?.animationName,
      "Idle",
      `${animal.characterId} late observers must receive the initial Idle clip`
    );
  }
  assert.ok(bear.navAgent);
  assert.ok(wolf.navAgent);
  assert.ok(deer.navAgent);
  assert.ok(deerBuck.navAgent);
  assert.ok(rabbit.navAgent);

  server._npcs.bear = bear;
  server._npcs.wolf = wolf;
  server._npcs.deer = deer;
  server._npcs.deerBuck = deerBuck;
  server._npcs.rabbit = rabbit;
  server._characters.player = {
    characterId: "player",
    isAlive: true,
    isVanished: false,
    isHidden: false,
    state: { position: playerPosition }
  };
  Object.setPrototypeOf(server, ZoneServer2016.prototype);
  server.lastFsmTick = Date.now();
  (rabbit.fsm as any).idleDuration = 0;
  const tickServerAi = (dt: number) => {
    // The production loop advances Recast's crowd on a separate interval.
    // Advance that interval here as well; otherwise movement states that wait
    // for nav-agent velocity to reach zero (for example wolf howling) never
    // observe the same state they would in a live server.
    server.navManager.lastTimeCall = Date.now() - dt * 1000;
    server.navManager.updt();
    server.lastFsmTick = Date.now() - dt * 1000;
    server.tickAi();
  };

  tickServerAi(0.1);
  assert.equal((bear.fsm as any).state, "standingUp");
  assert.equal((wolf.fsm as any).state, "howling");
  assert.equal((wolf.fsm as any).targetCharacterId, "player");
  assert.equal((deer.fsm as any).state, "flee");
  assert.equal((deerBuck.fsm as any).state, "flee");
  assert.equal((rabbit.fsm as any).state, "wander");

  // Bear RearUp is 160 frames (5.333 s) and wolf Howl is 150 frames (5 s)
  // in AnimalsX64.mrn; keep the production tick running past both native
  // action clips before asserting the chase handoff.
  for (let i = 0; i < 55; i++) {
    tickServerAi(0.1);
    // This integration fixture advances the FSM's logical clock without
    // waiting five real seconds for Character.PlayAnimation to expire.  Move
    // the two action deadlines to the same logical boundary before the next
    // AI tick; production keeps the real client-clock guard enabled.
    if (i === 0) {
      (bear as any).activeAnimation.expiresAt = Date.now() - 1;
      (wolf as any).activeAnimation.expiresAt = Date.now() - 1;
    }
  }
  assert.equal((bear.fsm as any).state, "chase");
  assert.equal((wolf.fsm as any).state, "chase");
  assert.equal((deer.fsm as any).state, "flee");
  assert.equal((deerBuck.fsm as any).state, "flee");
  assert.equal((rabbit.fsm as any).state, "flee");

  // Put the human inside the actual 3D attack envelope. Both predators must
  // enter their attack animation state before the hit callback is emitted.
  playerPosition[2] = 2850.0;
  tickServerAi(0.1);
  assert.equal((bear.fsm as any).state, "attack");
  assert.equal((wolf.fsm as any).state, "attack");

  tickServerAi(0.1);
  assert.equal((bear.fsm as any).state, "attacking");
  assert.equal((wolf.fsm as any).state, "attacking");
  const attackAnimations = sentPackets.filter(
    ({ command, payload }) =>
      command === "Character.PlayAnimation" &&
      payload?.animationName === "KnifeSlash"
  );
  assert.ok(
    attackAnimations.some(({ payload }) => payload.characterId === "bear")
  );
  assert.ok(
    attackAnimations.some(({ payload }) => payload.characterId === "wolf")
  );
  assert.equal(
    attackAnimations.find(({ payload }) => payload.characterId === "bear")
      ?.payload?.unknownDword2,
    1000,
    "bear KnifeSlash must use the loaded Bear001 Attack01 clip clock"
  );
  assert.equal(
    attackAnimations.find(({ payload }) => payload.characterId === "wolf")
      ?.payload?.unknownDword2,
    1667,
    "wolf KnifeSlash must use the loaded Wolf001 AttackB clip clock"
  );
  for (const predatorId of ["bear", "wolf"]) {
    const attackPacket = attackAnimations.find(
      ({ payload }) => payload.characterId === predatorId
    )?.payload;
    assert.equal(
      attackPacket?.animationType,
      "NPC_AttackSpeed",
      `${predatorId} KnifeSlash must bind the AnimalsPhysics attack-speed input`
    );
    assert.equal(
      attackPacket?.unknownDword3,
      1,
      `${predatorId} KnifeSlash must use the native attack-speed baseline`
    );
  }

  for (let i = 0; i < 11; i++) tickServerAi(0.1);
  assert.ok(
    meleeHits.some((damageInfo) => damageInfo.damage === bear.npcMeleeDamage)
  );
  assert.ok(
    meleeHits.some((damageInfo) => damageInfo.damage === wolf.npcMeleeDamage)
  );
  assert.equal(
    attackAnimations.some(({ payload }) =>
      ["deer", "rabbit"].includes(payload.characterId)
    ),
    false
  );
});

test("production animal spawn state is canonicalized to the Recast spawn point", () => {
  const navPoint = { x: 12.5, y: 4.25, z: -7.75 };
  const agent: any = { maxSpeed: 0, maxAcceleration: 0 };
  let createAgentPosition: Float32Array | undefined;
  let createAgentOptions: unknown;
  const server: any = {
    aiEnabled: true,
    charactersRenderDistance: 350,
    interactionDistance: 3,
    _modelsData: {},
    _npcs: {},
    navManager: {
      getClosestNavPointVec3() {
        return navPoint;
      },
      createAgent(position: Float32Array, options: unknown) {
        createAgentPosition = position;
        createAgentOptions = options;
        return agent;
      }
    },
    pushToGridCell() {},
    explosiveManager: { addEntity() {} },
    sendDataToAllWithSpawnedEntity() {}
  };

  const npc = new Bear(
    "spawn-canonical",
    1,
    vec(100, 99, 100),
    vec(0, 0, 0),
    server
  );

  assert.deepEqual(Array.from(npc.state.position), [12.5, 4.25, -7.75, 1]);
  assert.deepEqual(Array.from(createAgentPosition ?? []), [12.5, 4.25, -7.75, 1]);
  assert.deepEqual(createAgentOptions, { preserveSpawn: true });
});
