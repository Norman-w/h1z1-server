import assert from "node:assert/strict";
import test from "node:test";
import {
  ANIMAL_NATIVE_LOCOMOTION_PROFILE,
  Npc
} from "../out/servers/ZoneServer2016/entities/npc";
import { createBear } from "../out/servers/ZoneServer2016/jsms/bear.jsm";
import { createDeer } from "../out/servers/ZoneServer2016/jsms/deer.jsm";
import { createExploder } from "../out/servers/ZoneServer2016/jsms/exploder.jsm";
import { createGasser } from "../out/servers/ZoneServer2016/jsms/gasser.jsm";
import { createRabbit } from "../out/servers/ZoneServer2016/jsms/rabbit.jsm";
import { createScreamer } from "../out/servers/ZoneServer2016/jsms/screamer.jsm";
import { createWolf } from "../out/servers/ZoneServer2016/jsms/wolf.jsm";
import { createZombie } from "../out/servers/ZoneServer2016/jsms/zombie.jsm";
import { Factions } from "../out/servers/ZoneServer2016/jsms/factions";
import { getCurrentServerTimeWrapper } from "../out/utils/utils";

type Vec3 = Float32Array;

function vec(x: number, y = 0, z = 0): Vec3 {
  return new Float32Array([x, y, z, 1]);
}

function createProductionNpcFixture(
  id: string,
  position: Vec3,
  faction = Factions.PASSIVE
) {
  const packets: Array<{ name: string; payload: any }> = [];
  const moveTargets: unknown[] = [];
  let navVelocity = { x: 0, y: 0, z: 0 };
  const server: any = {
    aiTargetSpatialMap: new Map<string, any[]>(),
    sounds: [],
    _characters: {},
    _npcs: {},
    getClientsInRange() {
      return [];
    },
    getClientByCharId() {
      return undefined;
    },
    applyMovementModifier() {},
    pushSound() {},
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
      getClosestNavPointVec3(point: Vec3) {
        return { x: point[0], y: point[1], z: point[2] };
      },
      raycast() {
        return { t: 1 };
      }
    },
    sendDataToAllWithSpawnedEntity(
      _entities: unknown,
      characterId: string,
      name: string,
      payload: unknown
    ) {
      packets.push({ name, payload: { characterId, ...(payload as any) } });
    }
  };

  const npc: any = Object.create(Npc.prototype);
  npc.characterId = id;
  npc.transientId = 1;
  npc.state = { position, yaw: 0 };
  npc.faction = faction;
  // Production animal constructors install the authored AnimalsPhysics
  // locomotion domain before their FSM is created.  Keep this lightweight
  // contract fixture aligned with that boundary; generic Zombie001 actors
  // intentionally remain profile-less and use the two-sample release gate.
  if (new Set(["bear", "wolf", "deer", "rabbit"]).has(id)) {
    npc.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
  }
  npc.deathTime = 0;
  npc.server = server;
  npc.navAgent = {
    maxSpeed: 0,
    maxAcceleration: 0,
    requestMoveTarget(target: unknown) {
      moveTargets.push(target);
    },
    resetMoveTarget() {},
    requestMoveVelocity() {},
    teleport() {},
    velocity() {
      return navVelocity;
    }
  };
  // Most FSM contract tests advance logical time without sleeping.  Treat the
  // lightweight fixture's one-shots as already settled; the dedicated
  // client-clock regression below explicitly reinstalls Npc.prototype's
  // implementation and controls only that actor's expiry timestamp.
  npc.isAnimationActive = () => false;
  server._npcs[id] = npc;

  return {
    npc,
    server,
    packets,
    moveTargets,
    setNavVelocity(speed: number) {
      navVelocity = { x: 0, y: 0, z: speed };
    }
  };
}

function addHuman(server: any, id: string, position: Vec3) {
  server._characters[id] = {
    characterId: id,
    isAlive: true,
    isVanished: false,
    isHidden: false,
    state: { position }
  };
  const key = `${Math.floor(position[0] / 50)},${Math.floor(position[2] / 50)}`;
  server.aiTargetSpatialMap.set(key, [
    { id, position, faction: Factions.HUMAN }
  ]);
}

function packetValues(
  packets: Array<{ name: string; payload: any }>,
  name: string
) {
  return packets
    .filter((packet) => packet.name === name)
    .map((packet) => packet.payload);
}

function configureProductionPredator(npc: any, damageCalls: string[]) {
  npc.getMeleeAttackRange = () => 1.5;
  npc.getMeleeAttackAnimationDuration = () => 1.43;
  npc.getMeleeContactWindow = () => ({
    startFraction: 0.25,
    endFraction: 0.75
  });
  npc.isMeleeTargetInEnvelope = () => true;
  npc.applyDamage = (characterId: string) => damageCalls.push(characterId);
}

function ageStopAnchorForPathTick(npc: any, elapsedMs = 150) {
  const now = getCurrentServerTimeWrapper().getTruncatedU32();
  const position = npc.state.position;
  npc.lastStoppedMotionSample = {
    sequenceTime: (now - elapsedMs) >>> 0,
    position: [position[0], position[1], position[2]]
  };
}

test("legacy seekTarget cannot re-enable a second mover in server-position mode", () => {
  const fixture = createProductionNpcFixture("server-authoritative", vec(0));
  fixture.npc.movementAuthority = "server-position";

  assert.equal(
    fixture.npc.seekTarget("player", vec(0, 0, 5)),
    false,
    "the compatibility rail must fail closed when server position is authoritative"
  );
  assert.equal(
    packetValues(fixture.packets, "Character.ExpectedSpeed").length,
    0,
    "rejecting the native rail must not publish a stray ExpectedSpeed edge"
  );
});

test("native animals do not advertise gait from a stationary first crowd tick", () => {
  const fixture = createProductionNpcFixture("bear", vec(0));
  fixture.npc.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
  fixture.npc.locomotionMode = "sprint";
  fixture.setNavVelocity(6.5);

  // Recast has already acquired a sprint-sized velocity, but no authoritative
  // position sample has arrived yet.  The first packet must stay standing.
  fixture.npc.goTo(vec(0));
  const firstSample = packetValues(
    fixture.packets,
    "PlayerUpdatePosition"
  ).at(-1).positionUpdate;
  assert.equal(firstSample.stance, 1024);
  assert.equal(firstSample.horizontalSpeed, 0);

  // Once the server publishes a real displacement, the same nav velocity is a
  // valid first-sample fallback and the sprint stance may be selected.
  fixture.npc.goTo(vec(0, 0, 1));
  const movingSample = packetValues(
    fixture.packets,
    "PlayerUpdatePosition"
  ).at(-1).positionUpdate;
  assert.equal(movingSample.stance, 66565);
  assert.ok(
    movingSample.horizontalSpeed >=
      ANIMAL_NATIVE_LOCOMOTION_PROFILE.minimumMovingSpeed
  );
});

test("deer production Npc contract changes walk to sprint and clears it before resuming", () => {
  const fixture = createProductionNpcFixture("deer", vec(0));
  const deer: any = createDeer(fixture.npc, fixture.server);

  fixture.setNavVelocity(3);
  deer.tick(0.1);
  fixture.npc.goTo(vec(0, 0, 1));

  addHuman(fixture.server, "player", vec(0, 0, 5));
  fixture.setNavVelocity(7);
  deer.tick(0.1);
  ageStopAnchorForPathTick(fixture.npc);
  fixture.npc.goTo(vec(0, 0, 2));

  assert.deepEqual(
    packetValues(fixture.packets, "Character.ExpectedSpeed").map(
      (packet) => packet.speed
    ),
    [0, 3, 0, 7]
  );
  assert.equal(
    packetValues(fixture.packets, "PlayerUpdatePosition")[0].positionUpdate
      .stance,
    66560
  );
  assert.ok(
    packetValues(fixture.packets, "PlayerUpdatePosition").some(
      (packet) => packet.positionUpdate.stance === 66565
    ),
    "deer flee must publish a sprint stance after clearing the old path"
  );
  assert.equal(fixture.moveTargets.length >= 2, true);

  fixture.server.aiTargetSpatialMap.clear();
  deer.tick(0.1);

  assert.deepEqual(
    packetValues(fixture.packets, "Character.ExpectedSpeed").map(
      (packet) => packet.speed
    ),
    [0, 3, 0, 7, 0]
  );
  assert.equal(
    fixture.npc.pendingLocomotionTargetSpeed,
    3,
    "deer may resume patrol intent, but its walk edge waits for an authoritative sample"
  );
  assert.equal(
    packetValues(fixture.packets, "PlayerUpdatePosition").at(-1).positionUpdate
      .horizontalSpeed,
    0
  );
  assert.equal(
    packetValues(fixture.packets, "Character.PlayAnimation").length,
    0,
    "passive deer must not enter an attack animation path"
  );
});

test("rabbit production Npc contract uses sprint only while fleeing and never attacks", () => {
  const fixture = createProductionNpcFixture("rabbit", vec(0));
  const rabbit: any = createRabbit(fixture.npc, fixture.server);
  rabbit.idleDuration = 0;

  fixture.setNavVelocity(1.75);
  rabbit.tick(0.1);
  fixture.npc.goTo(vec(0, 0, 1));

  addHuman(fixture.server, "player", vec(0, 0, 5));
  fixture.setNavVelocity(5);
  rabbit.tick(0.1);
  ageStopAnchorForPathTick(fixture.npc);
  fixture.npc.goTo(vec(0, 0, 2));

  assert.deepEqual(
    packetValues(fixture.packets, "Character.ExpectedSpeed").map(
      (packet) => packet.speed
    ),
    [0, 1.75, 0, 5]
  );
  assert.equal(
    packetValues(fixture.packets, "PlayerUpdatePosition")[0].positionUpdate
      .stance,
    66560
  );
  assert.ok(
    packetValues(fixture.packets, "PlayerUpdatePosition").some(
      (packet) => packet.positionUpdate.stance === 66565
    ),
    "rabbit flee must publish a sprint stance after clearing the old path"
  );
  assert.equal(
    packetValues(fixture.packets, "Character.PlayAnimation").length,
    0,
    "passive rabbit must never request an attack one-shot"
  );
});

test("bear and wolf production Npc contracts publish chase sprint, stopped attack, and KnifeSlash", () => {
  const cases = [
    {
      id: "bear",
      faction: Factions.BEAR,
      create: createBear,
      wake: (fsm: any) => {
        fsm.tick(0.1);
        assert.equal(fsm.state, "standingUp");
        fsm.tick(0.1);
        fsm.tick(5.2);
        assert.equal(fsm.state, "standingUp");
        fsm.tick(0.2);
      },
      chaseSpeed: 5
    },
    {
      id: "wolf",
      faction: Factions.WOLF,
      create: createWolf,
      wake: (fsm: any) => {
        fsm.tick(0.1);
        assert.equal(fsm.state, "howling");
        fsm.tick(0.1);
        fsm.tick(4.9);
        assert.equal(fsm.state, "howling");
        fsm.tick(0.1);
      },
      chaseSpeed: 6.5
    }
  ] as const;

  for (const testCase of cases) {
    const fixture = createProductionNpcFixture(
      testCase.id,
      vec(0),
      testCase.faction
    );
    const damageCalls: string[] = [];
    configureProductionPredator(fixture.npc, damageCalls);
    const playerPosition = vec(0, 0, 8);
    addHuman(fixture.server, "player", playerPosition);
    const fsm: any = testCase.create(fixture.npc, fixture.server);

    testCase.wake(fsm);
    assert.equal(fsm.state, "chase");
    fixture.setNavVelocity(testCase.chaseSpeed);
    fixture.npc.goTo(vec(0, 0, 0.5));

    playerPosition[2] = 1.2;
    fsm.tick(0.1);
    assert.equal(fsm.state, "attack");
    fsm.tick(0.1);
    assert.equal(
      fsm.state,
      "attacking",
      `${testCase.id} must enter its action state after the envelope check`
    );

    assert.deepEqual(
      packetValues(fixture.packets, "Character.ExpectedSpeed").map(
      (packet) => packet.speed
    ),
      [0, testCase.chaseSpeed, 0],
      testCase.id + " must stop the nav stream before KnifeSlash"
    );
    assert.ok(
      packetValues(fixture.packets, "PlayerUpdatePosition").some(
        (packet) => packet.positionUpdate.stance === 66565
      ),
      testCase.id + " chase must use sprint stance"
    );
    assert.equal(
      packetValues(fixture.packets, "PlayerUpdatePosition").at(-1)
        .positionUpdate.stance,
      1024,
      testCase.id + " attack must publish standing stance"
    );
    assert.equal(
      packetValues(fixture.packets, "Character.UpdateCharacterState").at(-1)
        .states2.inCombat,
      1
    );
    assert.ok(
      packetValues(fixture.packets, "Character.PlayAnimation").some(
        (packet) => packet.animationName === "KnifeSlash"
      ),
      testCase.id + " must use the public AnimalsPhysics KnifeSlash event"
    );
    assert.ok(
      packetValues(fixture.packets, "Character.SeekTarget").some(
        (packet) => packet.TargetCharacterId === "player"
      ),
      testCase.id + " chase must install the native target controller"
    );
    assert.ok(
      packetValues(fixture.packets, "Character.ClearMovementRail").length > 0,
      testCase.id + " attack entry must clear the native chase controller"
    );
    assert.deepEqual(damageCalls, []);
  }
});

test("predator wake one-shots finish on the client clock before chase resumes", () => {
  const cases = [
    {
      id: "bear",
      faction: Factions.BEAR,
      create: createBear,
      durationMs: 5333,
      expectedAnimation: "StandUp"
    },
    {
      id: "wolf",
      faction: Factions.WOLF,
      create: createWolf,
      durationMs: 5000,
      expectedAnimation: "WolfHowl"
    }
  ] as const;

  for (const testCase of cases) {
    const fixture = createProductionNpcFixture(
      testCase.id,
      vec(0),
      testCase.faction
    );
    fixture.npc.isAnimationActive = Npc.prototype.isAnimationActive;
    addHuman(fixture.server, "player", vec(0, 0, 8));
    const fsm: any = testCase.create(fixture.npc, fixture.server);

    // Detect the target, then start the public wake-up one-shot.
    fsm.tick(0.1);
    fsm.tick(0.1);
    assert.equal(fsm.state, testCase.id === "bear" ? "standingUp" : "howling");
    assert.equal(
      packetValues(fixture.packets, "Character.PlayAnimation").at(-1)
        ?.animationName,
      testCase.expectedAnimation
    );

    // Move only this actor's native one-shot deadline into the future.  This
    // simulates the client still rendering the final frame without changing
    // Date.now globally (the test runner executes files in parallel).
    const activeAnimation = (fixture.npc as any).activeAnimation;
    assert.ok(activeAnimation);
    activeAnimation.expiresAt = Date.now() + 1000;
    fsm.tick(testCase.durationMs + 0.1);
    assert.equal(
      fsm.state,
      testCase.id === "bear" ? "standingUp" : "howling",
      `${testCase.id} must wait for the native one-shot to expire`
    );
    assert.equal(
      packetValues(fixture.packets, "Character.PlayAnimation").at(-1)
        ?.animationName,
      testCase.expectedAnimation,
      `${testCase.id} must not reset the wake-up pose early`
    );

    activeAnimation.expiresAt = Date.now() - 1;
    fsm.tick(0.01);
    assert.equal(fsm.state, "chase");
    assert.equal(
      packetValues(fixture.packets, "Character.PlayAnimation").at(-1)
        ?.animationName,
      "Idle",
      `${testCase.id} must reset only after the native clip clock`
    );
  }
});

test("predator wake one-shots re-arm after a target is lost", () => {
  const cases = [
    {
      id: "bear",
      faction: Factions.BEAR,
      create: createBear,
      wakeAnimation: "StandUp",
      wakeDuration: 5.4
    },
    {
      id: "wolf",
      faction: Factions.WOLF,
      create: createWolf,
      wakeAnimation: "WolfHowl",
      wakeDuration: 5.1
    }
  ] as const;

  for (const testCase of cases) {
    const fixture = createProductionNpcFixture(
      testCase.id,
      vec(0),
      testCase.faction
    );
    const player = {
      characterId: "player",
      isAlive: true,
      isVanished: false,
      isHidden: false,
      state: { position: vec(0, 0, 8) }
    };
    fixture.server._characters.player = player;
    fixture.server.aiTargetSpatialMap.set("0,0", [
      { id: "player", position: player.state.position, faction: Factions.HUMAN }
    ]);
    const fsm: any = testCase.create(fixture.npc, fixture.server);

    // First encounter completes its wake clip and reaches chase.
    fsm.tick(0.1);
    fsm.tick(0.1);
    fsm.tick(testCase.wakeDuration);
    assert.equal(fsm.state, "chase");
    assert.equal(
      packetValues(fixture.packets, "Character.PlayAnimation").filter(
        (packet) => packet.animationName === testCase.wakeAnimation
      ).length,
      1
    );

    // Losing the target must reset the wake phase before returning to wander.
    player.isAlive = false;
    fsm.tick(0.1);
    assert.equal(fsm.state, "wander");

    // A later target acquisition must emit the public wake event again rather
    // than inheriting the completed first encounter's boolean/timer state.
    player.isAlive = true;
    fsm.tick(0.1);
    assert.equal(fsm.state, testCase.id === "bear" ? "standingUp" : "howling");
    fsm.tick(0.1);
    assert.equal(
      packetValues(fixture.packets, "Character.PlayAnimation").filter(
        (packet) => packet.animationName === testCase.wakeAnimation
      ).length,
      2,
      `${testCase.id} must replay its wake one-shot on the next encounter`
    );
  }
});

test("native predator FSM keeps an elevated target inside its horizontal melee projection", () => {
  const cases = [
    {
      id: "bear",
      faction: Factions.BEAR,
      create: createBear,
      wake: (fsm: any) => {
        fsm.tick(0.1);
        assert.equal(fsm.state, "standingUp");
        fsm.tick(0.1);
        fsm.tick(5.2);
        assert.equal(fsm.state, "standingUp");
        fsm.tick(0.2);
      },
      chaseSpeed: 5,
      source: "Animals_Bear001_Attack01",
      attackDurationMs: 1000
    },
    {
      id: "wolf",
      faction: Factions.WOLF,
      create: createWolf,
      wake: (fsm: any) => {
        fsm.tick(0.1);
        assert.equal(fsm.state, "howling");
        fsm.tick(0.1);
        fsm.tick(4.9);
        assert.equal(fsm.state, "howling");
        fsm.tick(0.1);
      },
      chaseSpeed: 6.5,
      source: "Animals_Wolf001_AttackB",
      attackDurationMs: 1667
    }
  ] as const;

  for (const testCase of cases) {
    const fixture = createProductionNpcFixture(
      testCase.id,
      vec(0),
      testCase.faction
    );
    // Keep the real Npc envelope method installed.  The existing contract
    // test above deliberately overrides it to isolate FSM packet handoffs;
    // this regression exercises the production native projection itself.
    fixture.npc.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
    fixture.npc.meleeProfileSource = "compatibility-proxy";
    fixture.npc.nativeMeleeAnimationSource = testCase.source;
    fixture.npc.nativeMeleeAnimationDurationMs = testCase.attackDurationMs;
    fixture.npc.getMeleeContactWindow = () => ({
      startFraction: 0.25,
      endFraction: 0.75
    });
    fixture.npc.applyDamage = () => {};

    // A player on a vehicle/step can have a large origin-Y delta while the
    // native actor/weapon graph still evaluates horizontal engagement.
    const playerPosition = vec(0, 3, 8);
    addHuman(fixture.server, "player", playerPosition);
    const fsm: any = testCase.create(fixture.npc, fixture.server);

    testCase.wake(fsm);
    assert.equal(fsm.state, "chase");
    fixture.setNavVelocity(testCase.chaseSpeed);
    fixture.npc.goTo(vec(0, 0, 0.5));

    playerPosition[2] = 1.2;
    fsm.tick(0.1);
    assert.equal(
      fsm.state,
      "attack",
      `${testCase.id} must enter attack for an elevated target in horizontal range`
    );
    fsm.tick(0.1);
    assert.equal(
      fsm.state,
      "attacking",
      `${testCase.id} must start the native action instead of rejecting the target by origin Y`
    );
  }
});

test("predators do not start or land a melee swing through a NavMesh obstruction", () => {
  const cases = [
    {
      id: "bear",
      faction: Factions.BEAR,
      create: createBear,
      wake: (fsm: any) => {
        fsm.tick(0.1);
        assert.equal(fsm.state, "standingUp");
        fsm.tick(0.1);
        fsm.tick(5.2);
        assert.equal(fsm.state, "standingUp");
        fsm.tick(0.2);
      },
      chaseSpeed: 5
    },
    {
      id: "wolf",
      faction: Factions.WOLF,
      create: createWolf,
      wake: (fsm: any) => {
        fsm.tick(0.1);
        assert.equal(fsm.state, "howling");
        fsm.tick(0.1);
        fsm.tick(4.9);
        assert.equal(fsm.state, "howling");
        fsm.tick(0.1);
      },
      chaseSpeed: 6.5
    }
  ] as const;

  for (const testCase of cases) {
    const fixture = createProductionNpcFixture(
      testCase.id,
      vec(0),
      testCase.faction
    );
    const damageCalls: string[] = [];
    configureProductionPredator(fixture.npc, damageCalls);
    const playerPosition = vec(0, 0, 8);
    addHuman(fixture.server, "player", playerPosition);
    const fsm: any = testCase.create(fixture.npc, fixture.server);

    testCase.wake(fsm);
    assert.equal(fsm.state, "chase");
    fixture.setNavVelocity(testCase.chaseSpeed);
    fixture.npc.goTo(vec(0, 0, 0.5));
    playerPosition[2] = 1.2;

    // The target is inside the horizontal native engagement envelope, but a
    // solid NavMesh hit between the actor and target must block both the
    // attack transition and the later damage projection.
    fixture.server.navManager.raycast = () => ({
      // A failed Recast query must not be treated as clear merely because its
      // stale result happens to contain t=1.
      success: false,
      t: 1
    });
    fsm.tick(0.1);
    assert.equal(fsm.state, "attack");
    fsm.tick(0.1);
    assert.equal(
      fsm.state,
      "attack",
      `${testCase.id} must not start KnifeSlash through an obstruction`
    );
    assert.equal(
      packetValues(fixture.packets, "Character.PlayAnimation").some(
        (packet) => packet.animationName === "KnifeSlash"
      ),
      false,
      `${testCase.id} must not publish an attack animation through an obstruction`
    );

    fixture.server.navManager.raycast = () => ({ t: 1 });
    fsm.tick(0.1);
    assert.equal(fsm.state, "attacking");
    assert.ok(
      packetValues(fixture.packets, "Character.PlayAnimation").some(
        (packet) => packet.animationName === "KnifeSlash"
      ),
      `${testCase.id} may start only after the obstruction clears`
    );
    assert.deepEqual(
      damageCalls,
      [],
      `${testCase.id} must wait for the native SwingContact interval`
    );
  }
});

test("predator attack completion does not cut off a live animal hit reaction", () => {
  const cases = [
    {
      id: "bear",
      faction: Factions.BEAR,
      create: createBear,
      attackDuration: 1,
      flinchDurationMs: 1667,
      chaseSpeed: 5,
      source: "Animals_Bear001_Attack01"
    },
    {
      id: "wolf",
      faction: Factions.WOLF,
      create: createWolf,
      attackDuration: 1.667,
      flinchDurationMs: 1000,
      chaseSpeed: 6.5,
      source: "Animals_Wolf001_AttackB"
    }
  ] as const;

  const realNow = Date.now;
  let now = 10_000_000;
  Date.now = () => now;
  try {
    for (const testCase of cases) {
      const fixture = createProductionNpcFixture(
        testCase.id,
        vec(0),
        testCase.faction
      );
      configureProductionPredator(fixture.npc, []);
      // The lightweight fixture is created with Object.create(Npc.prototype),
      // so install the same native profile/source that the production Bear and
      // Wolf constructors provide before exercising the real hit hook.
      fixture.npc.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
      fixture.npc.meleeProfileSource = "compatibility-proxy";
      fixture.npc.nativeMeleeAnimationSource = testCase.source;
      fixture.npc.nativeMeleeAnimationDurationMs =
        testCase.attackDuration * 1000;
      fixture.npc.nativeMeleeFlinchAnimationDurationMs =
        testCase.flinchDurationMs;
      fixture.npc.getMeleeAttackAnimationDuration = () =>
        testCase.attackDuration;
      fixture.npc.damage = () => Promise.resolve();

      const playerPosition = vec(0, 0, 8);
      addHuman(fixture.server, "player", playerPosition);
      const fsm: any = testCase.create(fixture.npc, fixture.server);

      // Reach the same attacking state as the production contract test.
      fsm.tick(0.1);
      fsm.tick(0.1);
      fsm.tick(testCase.id === "bear" ? 5.2 : 4.9);
      fsm.tick(testCase.id === "bear" ? 0.2 : 0.1);
      assert.equal(fsm.state, "chase");
      fixture.setNavVelocity(testCase.chaseSpeed);
      fixture.npc.goTo(vec(0, 0, 0.5));
      playerPosition[2] = 1.2;
      fsm.tick(0.1);
      fsm.tick(0.1);
      assert.equal(fsm.state, "attacking");

      fixture.packets.length = 0;
      // Hit the predator late enough that even Wolf's shorter Flinch clip is
      // still active when its longer attack clock reaches DoneAttacking.
      fsm.tick(0.9);
      now += 900;
      fixture.npc.OnMeleeHit(fixture.server, {
        entity: "player",
        damage: 1
      });
      assert.deepEqual(
        packetValues(fixture.packets, "Character.PlayAnimation").map(
          (packet) => packet.animationName
        ),
        ["MeleeFlinch"],
        `${testCase.id} must publish the native reaction event`
      );

      now += Math.round((testCase.attackDuration - 0.9) * 1000);
      fsm.tick(testCase.attackDuration - 0.9);
      assert.equal(fsm.state, "attack");
      assert.deepEqual(
        packetValues(fixture.packets, "Character.PlayAnimation").map(
          (packet) => packet.animationName
        ),
        ["MeleeFlinch"],
        `${testCase.id} attack completion must not reset an active reaction to Idle`
      );
      assert.equal(
        fixture.npc.getAnimationRuntimeState(now).activeAnimation,
        "MeleeFlinch",
        `${testCase.id} reaction clock must remain authoritative past attack completion`
      );
    }
  } finally {
    Date.now = realNow;
  }
});

test("predators fail closed when a chase path cannot be installed", () => {
  const cases = [
    {
      id: "bear",
      faction: Factions.BEAR,
      create: createBear,
      wake(fsm: any, npc: any) {
        fsm.tick(0.1);
        assert.equal(fsm.state, "standingUp");
        fsm.tick(0.1);
        fsm.tick(5.2);
        npc.navAgent = undefined;
        fsm.tick(0.2);
      }
    },
    {
      id: "wolf",
      faction: Factions.WOLF,
      create: createWolf,
      wake(fsm: any, npc: any) {
        fsm.tick(0.1);
        assert.equal(fsm.state, "howling");
        fsm.tick(0.1);
        fsm.tick(4.9);
        npc.navAgent = undefined;
        fsm.tick(0.1);
      }
    }
  ] as const;

  for (const testCase of cases) {
    const fixture = createProductionNpcFixture(
      testCase.id,
      vec(0),
      testCase.faction
    );
    addHuman(fixture.server, "player", vec(0, 0, 8));
    const fsm: any = testCase.create(fixture.npc, fixture.server);

    testCase.wake(fsm, fixture.npc);

    assert.equal(
      fsm.state,
      "wander",
      `${testCase.id} must leave chase when no nav path is accepted`
    );
    assert.deepEqual(
      packetValues(fixture.packets, "Character.ExpectedSpeed").filter(
        (packet) => packet.speed > 0
      ),
      [],
      `${testCase.id} must not publish sprint speed without a move target`
    );
    assert.equal(
      packetValues(fixture.packets, "PlayerUpdatePosition").some(
        (packet) => packet.positionUpdate.stance === 66565
      ),
      false,
      `${testCase.id} must not advertise sprint while stationary`
    );
  }
});

test("all animal FSMs fail closed when Recast rejects a move target", () => {
  const predatorCases = [
    {
      id: "bear",
      faction: Factions.BEAR,
      create: createBear,
      wake(fsm: any, npc: any) {
        fsm.tick(0.1);
        assert.equal(fsm.state, "standingUp");
        fsm.tick(0.1);
        fsm.tick(5.2);
        npc.navAgent.requestMoveTarget = () => false;
        fsm.tick(0.2);
      }
    },
    {
      id: "wolf",
      faction: Factions.WOLF,
      create: createWolf,
      wake(fsm: any, npc: any) {
        fsm.tick(0.1);
        assert.equal(fsm.state, "howling");
        fsm.tick(0.1);
        fsm.tick(4.9);
        npc.navAgent.requestMoveTarget = () => false;
        fsm.tick(0.1);
      }
    }
  ] as const;

  for (const testCase of predatorCases) {
    const fixture = createProductionNpcFixture(
      testCase.id,
      vec(0),
      testCase.faction
    );
    addHuman(fixture.server, "player", vec(0, 0, 8));
    const fsm: any = testCase.create(fixture.npc, fixture.server);
    testCase.wake(fsm, fixture.npc);
    assert.equal(fsm.state, "wander");
    assert.deepEqual(
      packetValues(fixture.packets, "Character.ExpectedSpeed").filter(
        (packet) => packet.speed > 0
      ),
      [],
      `${testCase.id} must not publish sprint after Recast rejects the target`
    );
  }

  for (const [id, create] of [
    ["deer", createDeer],
    ["rabbit", createRabbit]
  ] as const) {
    const fixture = createProductionNpcFixture(id, vec(0));
    fixture.npc.navAgent.requestMoveTarget = () => false;
    addHuman(fixture.server, "player", vec(0, 0, 5));
    const fsm: any = create(fixture.npc, fixture.server);
    fsm.tick(0.1);
    assert.equal(fsm.state, "flee");
    assert.deepEqual(
      packetValues(fixture.packets, "Character.ExpectedSpeed").filter(
        (packet) => packet.speed > 0
      ),
      [],
      `${id} must not publish flee speed after Recast rejects the target`
    );
    assert.equal(fixture.npc.locomotionIntent, "walk");
  }
});

test("all animal FSMs fail closed when NavMesh target projection throws", () => {
  const predatorCases = [
    {
      id: "bear",
      faction: Factions.BEAR,
      create: createBear,
      wake(fsm: any, npc: any) {
        fsm.tick(0.1);
        assert.equal(fsm.state, "standingUp");
        fsm.tick(0.1);
        fsm.tick(5.2);
        npc.server.navManager.getClosestNavPointVec3 = () => {
          throw new Error("target projection unavailable");
        };
        fsm.tick(0.2);
      }
    },
    {
      id: "wolf",
      faction: Factions.WOLF,
      create: createWolf,
      wake(fsm: any, npc: any) {
        fsm.tick(0.1);
        assert.equal(fsm.state, "howling");
        fsm.tick(0.1);
        fsm.tick(4.9);
        npc.server.navManager.getClosestNavPointVec3 = () => {
          throw new Error("target projection unavailable");
        };
        fsm.tick(0.1);
      }
    }
  ] as const;

  for (const testCase of predatorCases) {
    const fixture = createProductionNpcFixture(
      testCase.id,
      vec(0),
      testCase.faction
    );
    addHuman(fixture.server, "player", vec(0, 0, 8));
    const fsm: any = testCase.create(fixture.npc, fixture.server);
    testCase.wake(fsm, fixture.npc);

    assert.equal(
      fsm.state,
      "wander",
      `${testCase.id} must leave chase when target projection throws`
    );
    assert.deepEqual(
      packetValues(fixture.packets, "Character.ExpectedSpeed").filter(
        (packet) => packet.speed > 0
      ),
      [],
      `${testCase.id} must not publish sprint after projection failure`
    );
  }

  for (const [id, create] of [
    ["deer", createDeer],
    ["rabbit", createRabbit]
  ] as const) {
    const fixture = createProductionNpcFixture(id, vec(0));
    const fsm: any = create(fixture.npc, fixture.server);
    if (id === "rabbit") fsm.idleDuration = 0;
    fsm.tick(0.1);
    addHuman(fixture.server, "player", vec(0, 0, 5));
    fixture.server.navManager.getClosestNavPointVec3 = () => {
      throw new Error("target projection unavailable");
    };
    const speedPacketCountBeforeFailure = packetValues(
      fixture.packets,
      "Character.ExpectedSpeed"
    ).length;
    fsm.tick(0.1);

    assert.equal(fsm.state, "flee");
    assert.deepEqual(
      packetValues(fixture.packets, "Character.ExpectedSpeed")
        .slice(speedPacketCountBeforeFailure)
        .filter((packet) => packet.speed > 0),
      [],
      `${id} must not publish flee speed after projection failure`
    );
    assert.equal(fixture.npc.locomotionIntent, "walk");
  }
});

test("zombie production FSM publishes agitation speed, chase sprint, and stopped KnifeSlash", () => {
  const fixture = createProductionNpcFixture("zombie", vec(0), Factions.ZOMBIE);
  const damageCalls: string[] = [];
  configureProductionPredator(fixture.npc, damageCalls);
  const playerPosition = vec(0, 0, 8);
  addHuman(fixture.server, "player", playerPosition);
  const zombie: any = createZombie(fixture.npc, fixture.server);

  // AGITATION_INITIAL=50 maps BASE_SPEED=1..MAX_SPEED=4 to 2.5 game units.
  fixture.setNavVelocity(2.5);
  zombie.tick(0.1);
  assert.equal(zombie.state, "chase");
  fixture.npc.goTo(vec(0, 0, 0.5));
  // Zombie001 has no recovered authored lower blend point.  Its first
  // displacement is the acceleration hand-off; publish a second adjacent
  // sample before asserting the sprint stance.
  fixture.npc.goTo(vec(0, 0, 0.75));

  // Enter the outer range, then let the attack state turn/validate the actual
  // strike envelope before starting the one-shot event.
  playerPosition[2] = 1.2;
  zombie.tick(0.1);
  assert.equal(zombie.state, "attack");
  zombie.tick(0.1);
  assert.equal(zombie.state, "attacking");

  assert.deepEqual(
    packetValues(fixture.packets, "Character.ExpectedSpeed").map(
      (packet) => packet.speed
    ),
    [2.5, 0],
    "zombie attack staging must clear its agitation-derived movement speed"
  );
  assert.ok(
    packetValues(fixture.packets, "PlayerUpdatePosition").some(
      (packet) => packet.positionUpdate.stance === 66565
    ),
    "zombie chase must publish sprint after adjacent movement samples"
  );
  assert.equal(
    packetValues(fixture.packets, "PlayerUpdatePosition").at(-1).positionUpdate
      .stance,
    1024,
    "zombie attack staging must publish a stationary stance"
  );
  assert.equal(
    packetValues(fixture.packets, "Character.UpdateCharacterState").at(-1)
      .states2.inCombat,
    1
  );
  assert.ok(
    packetValues(fixture.packets, "Character.PlayAnimation").some(
      (packet) => packet.animationName === "KnifeSlash"
    )
  );
  assert.deepEqual(
    damageCalls,
    [],
    "contact must not be applied at swing start"
  );
});

test("special hostile production FSMs publish dynamic chase and action handoffs", () => {
  const cases = [
    {
      id: "gasser",
      create: createGasser,
      prepare: (fsm: any) => {
        // Keep this production path on the melee branch; otherwise the
        // gasser may deliberately choose Spit/GasConvulse at the same range.
        fsm.ChargeGas = 0;
      },
      wake: (fsm: any) => {
        fsm.tick(0.1);
        assert.equal(fsm.state, "chase");
        fsm.tick(0.1);
        assert.equal(fsm.state, "attack");
      },
      action: "KnifeSlash",
      expectedInitialSpeed: 2
    },
    {
      id: "exploder",
      create: createExploder,
      prepare: () => {},
      wake: (fsm: any) => {
        fsm.tick(0.1);
        assert.equal(fsm.state, "chase");
        fsm.tick(0.1);
        assert.equal(fsm.state, "attack");
      },
      action: "ExplodeContract",
      expectedInitialSpeed: 3.5
    },
    {
      id: "screamer",
      create: createScreamer,
      prepare: (fsm: any) => {
        fsm.tick(0.1);
        assert.equal(fsm.state, "rising");
        // Do not replace ScreamerRise with Scream on the next AI tick.  The
        // rise phase owns its full 1.5s public one-shot.
        fsm.tick(1.5);
        assert.equal(fsm.state, "Screaming");
        // The authored Scream leaf is 100 frames at 30 FPS.
        fsm.tick(10 / 3);
        assert.equal(fsm.state, "chase");
        fsm.armsFreed = true;
      },
      wake: (fsm: any) => {
        fsm.tick(0.1);
        assert.equal(fsm.state, "attack");
      },
      action: "KnifeSlash",
      expectedInitialSpeed: null
    }
  ] as const;

  for (const testCase of cases) {
    const fixture = createProductionNpcFixture(
      testCase.id,
      vec(0),
      Factions.ZOMBIE
    );
    const playerPosition = vec(0, 0, 8);
    addHuman(fixture.server, "player", playerPosition);
    const fsm: any = testCase.create(fixture.npc, fixture.server);
    fixture.setNavVelocity(2);
    fixture.npc.goTo(vec(0, 0, 0.5));
    if (testCase.id !== "exploder") {
      configureProductionPredator(fixture.npc, []);
    }
    testCase.prepare(fsm);

    if (testCase.expectedInitialSpeed !== null) {
      assert.equal(
        packetValues(fixture.packets, "Character.ExpectedSpeed")[0].speed,
        testCase.expectedInitialSpeed,
        `${testCase.id} must publish its agitation-derived initial speed`
      );
    }

    playerPosition[2] = 1.2;
    testCase.wake(fsm);
    fsm.tick(0.1);
    assert.equal(
      fsm.state,
      "attacking",
      `${testCase.id} must enter its action state after the envelope check`
    );

    const expectedSpeeds = packetValues(
      fixture.packets,
      "Character.ExpectedSpeed"
    ).map((packet) => packet.speed);
    assert.equal(
      expectedSpeeds.at(-1),
      0,
      `${testCase.id} must stop the movement stream before its action`
    );
    assert.equal(
      packetValues(fixture.packets, "PlayerUpdatePosition").at(-1)
        .positionUpdate.stance,
      1024,
      `${testCase.id} action must publish a stationary stance`
    );
    assert.ok(
      packetValues(fixture.packets, "Character.PlayAnimation").some(
        (packet) => packet.animationName === testCase.action
      ),
      `${testCase.id} must publish its public action animation`
    );
  }
});
