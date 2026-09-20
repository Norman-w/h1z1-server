import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { H1Z1Protocol } from "../../h1z1-server";
import {
  ANIMAL_NATIVE_LOCOMOTION_PROFILE,
  Npc,
  ZOMBIE_NATIVE_ACTION_DURATION_MS
} from "../out/servers/ZoneServer2016/entities/npc";
import { Character2016 } from "../out/servers/ZoneServer2016/entities/character";
import { getCurrentServerTimeWrapper } from "../out/utils/utils";

function makeNpc() {
  const packets: any[] = [];
  const events: string[] = [];
  const expectedSpeeds: any[] = [];
  const animationPackets: any[] = [];
  const lookAtPackets: any[] = [];
  const nativeSeekPackets: any[] = [];
  const npc: any = Object.create(Npc.prototype);
  npc.characterId = "animal";
  npc.transientId = 1;
  npc.state = {
    position: new Float32Array([0, 0, 0, 1]),
    yaw: 0
  };
  npc.lookAtTarget = null;
  npc.navAgent = undefined;
  npc.server = {
    _npcs: {},
    sendDataToAllWithSpawnedEntity(
      _entities: unknown,
      _characterId: string,
      packetName: string,
      payload: any
    ) {
      events.push(packetName);
      if (packetName === "PlayerUpdatePosition") {
        packets.push(payload.positionUpdate);
      } else if (packetName === "Character.ExpectedSpeed") {
        expectedSpeeds.push(payload);
      } else if (packetName === "Character.PlayAnimation") {
        animationPackets.push(payload);
      } else if (packetName === "Character.SetLookAt") {
        lookAtPackets.push(payload);
      } else if (
        packetName === "Character.SeekTarget" ||
        packetName === "Character.SeekTargetUpdate" ||
        packetName === "Character.ClearMovementRail"
      ) {
        nativeSeekPackets.push({ packetName, payload });
      }
    }
  };
  return {
    npc,
    packets,
    events,
    expectedSpeeds,
    animationPackets,
    lookAtPackets,
    nativeSeekPackets
  };
}

test("native animal seek is edge-triggered, rate-limited, and cleared before actions", () => {
  const { npc, events, nativeSeekPackets } = makeNpc();
  npc.navAgent = {
    maxSpeed: 6.5,
    maxAcceleration: 13,
    velocity: () => ({ x: 0, y: 0, z: 1 })
  };
  npc.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
  npc.setSpeed(6.5);
  const startedAt = Date.now();

  assert.equal(
    npc.requestNativeSeekTarget(
      "player",
      new Float32Array([3, 0, 4, 1]),
      startedAt
    ),
    true
  );
  // The target intent is retained, but the native rail must not be installed
  // until the authoritative position stream has measured a moving gait.
  assert.deepEqual(nativeSeekPackets, []);
  assert.equal(npc.nativeGaitReady, false);
  assert.equal(npc.pendingLocomotionTargetSpeed, 6.5);
  assert.equal(npc.pendingNativeSeekTargetId, "player");
  npc.goTo(new Float32Array([0, 0, 1, 1]));
  assert.deepEqual(events.slice(0, 3), [
    "PlayerUpdatePosition",
    "Character.ExpectedSpeed",
    "Character.SeekTarget"
  ]);
  assert.equal(npc.nativeGaitReady, true);
  assert.equal(npc.pendingLocomotionTargetSpeed, null);
  assert.equal(npc.pendingNativeSeekTargetId, null);
  assert.equal(npc.nativeSeekTargetControllerSpeed, 6.5);
  // Repeating the same target within the refresh window must not reinstall
  // the controller or flood the reliable channel.
  npc.requestNativeSeekTarget(
    "player",
    new Float32Array([6, 0, 8, 1]),
    startedAt + 200
  );
  npc.requestNativeSeekTarget(
    "player",
    new Float32Array([6, 0, 8, 1]),
    startedAt + 401
  );
  npc.clearNativeSeekTarget();

  assert.deepEqual(
    nativeSeekPackets.map((packet) => packet.packetName),
    [
      "Character.SeekTarget",
      "Character.SeekTargetUpdate",
      "Character.ClearMovementRail"
    ]
  );
  assert.equal(nativeSeekPackets[0].payload.speed, 6.5);
  assert.equal(nativeSeekPackets[0].payload.acceleration, 19.5);
  assert.equal(nativeSeekPackets[0].payload.unknown8, 6);
  assert.deepEqual(
    Array.from(nativeSeekPackets[0].payload.rotation),
    Array.from(new Float32Array([Math.SQRT1_2, 0, Math.SQRT1_2, 0]))
  );
  assert.equal(npc.nativeSeekTarget, null);
  assert.equal(npc.nativeSeekTargetControllerSpeed, null);
});

test("native animal seek refreshes the full controller when the same target changes speed", () => {
  const { npc, nativeSeekPackets } = makeNpc();
  npc.navAgent = {
    maxSpeed: 5,
    maxAcceleration: 10,
    velocity: () => ({ x: 0, y: 0, z: 2 })
  };
  npc.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
  npc.setSpeed(5);
  npc.requestNativeSeekTarget(
    "player",
    new Float32Array([0, 0, 8, 1]),
    1000,
    5
  );
  // A late observer may replay the native rail only after an authoritative
  // moving position sample exists.  Use a real displacement here; a
  // stationary first crowd tick intentionally stays standing and is covered
  // by the dedicated start-slide regression.
  npc.goTo(new Float32Array([0, 0, 2, 1]));

  assert.deepEqual(
    nativeSeekPackets.map((packet) => packet.packetName),
    ["Character.SeekTarget"]
  );
  assert.equal(nativeSeekPackets[0].payload.speed, 5);

  // SeekTargetUpdate has no speed field.  A same-target transition must
  // therefore replace the full controller packet instead of leaving the
  // native rail on the old chase speed.
  npc.requestNativeSeekTarget(
    "player",
    new Float32Array([0, 0, 8, 1]),
    1100,
    6.5
  );

  assert.deepEqual(
    nativeSeekPackets.map((packet) => packet.packetName),
    ["Character.SeekTarget", "Character.SeekTarget"]
  );
  assert.equal(nativeSeekPackets.at(-1)?.payload.speed, 6.5);
  assert.equal(nativeSeekPackets.at(-1)?.payload.acceleration, 19.5);
  assert.equal(npc.nativeSeekTargetControllerSpeed, 6.5);
});

test("direct speed changes refresh an installed native seek rail", () => {
  const { npc, expectedSpeeds, nativeSeekPackets } = makeNpc();
  npc.navAgent = {
    maxSpeed: 5,
    maxAcceleration: 10,
    velocity: () => ({ x: 0, y: 0, z: 2 })
  };
  npc.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
  npc.setSpeed(5);
  npc.requestNativeSeekTarget(
    "player",
    new Float32Array([0, 0, 8, 1]),
    1000,
    5
  );
  npc.goTo(new Float32Array([0, 0, 1, 1]));

  npc.setSpeed(7);

  assert.deepEqual(
    nativeSeekPackets.map((packet) => packet.packetName),
    ["Character.SeekTarget", "Character.SeekTarget"]
  );
  assert.equal(nativeSeekPackets.at(-1)?.payload.speed, 7);
  assert.equal(nativeSeekPackets.at(-1)?.payload.acceleration, 21);
  assert.deepEqual(
    expectedSpeeds.map((packet) => packet.speed),
    [5, 7]
  );
});

test("native animal seek intent is canceled without a rail before first movement", () => {
  const { npc, nativeSeekPackets } = makeNpc();
  npc.navAgent = { maxSpeed: 6.5, maxAcceleration: 13 };
  npc.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
  npc.setSpeed(6.5);

  assert.equal(
    npc.requestNativeSeekTarget(
      "player",
      new Float32Array([3, 0, 4, 1]),
      Date.now()
    ),
    true
  );
  assert.equal(npc.clearNativeSeekTarget(), true);
  assert.deepEqual(nativeSeekPackets, []);
  assert.equal(npc.nativeSeekTarget, null);
});

test("zero speed clears an installed native seek rail even without stopMovement", () => {
  const { npc, nativeSeekPackets } = makeNpc();
  npc.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
  npc.navAgent = {
    maxSpeed: 0,
    maxAcceleration: 0,
    velocity: () => ({ x: 0, y: 0, z: 2 })
  };

  npc.setSpeed(6.5);
  npc.requestNativeSeekTarget(
    "player",
    new Float32Array([0, 0, 8, 1]),
    1000,
    6.5
  );
  npc.goTo(new Float32Array([0, 0, 1, 1]));
  assert.equal(npc.nativeSeekTarget, "player");

  npc.setSpeed(0);

  assert.equal(npc.nativeSeekTarget, null);
  assert.equal(nativeSeekPackets.at(-1)?.packetName, "Character.ClearMovementRail");
});

test("lethal NPC damage clears movement before the death graph takes over", async () => {
  const { npc, nativeSeekPackets, events } = makeNpc();
  const deathPackets: Array<{ name: string; payload: any }> = [];
  npc.flags = { knockedOut: 0 };
  npc.health = 100;
  npc.deathTime = 0;
  npc.effectTags = [];
  npc.addLoot = () => {};
  npc.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
  npc.navAgent = {
    maxSpeed: 0,
    maxAcceleration: 0,
    velocity: () => ({ x: 0, y: 0, z: 2 }),
    resetMoveTarget: () => {},
    requestMoveVelocity: () => {},
    teleport: () => {}
  };
  npc.setSpeed(5);
  npc.requestNativeSeekTarget(
    "player",
    new Float32Array([0, 0, 8, 1]),
    1000,
    5
  );
  npc.goTo(new Float32Array([0, 0, 1, 1]));
  assert.equal(npc.nativeSeekTarget, "player");

  npc.server._soloMode = true;
  npc.server.getClientByCharId = () => undefined;
  npc.server.getEntity = () => undefined;
  npc.server._entityObservers = new Map([
    [
      npc.characterId,
      new Set([{ isLoading: false, character: { characterId: "observer" } }])
    ]
  ]);
  npc.server.sendData = (_client: unknown, name: string, payload: any) => {
    deathPackets.push({ name, payload });
  };

  await npc.damage(npc.server, { entity: "player", damage: 100 });

  assert.equal(npc.isAlive, false);
  assert.equal(npc.nativeSeekTarget, null);
  assert.equal(nativeSeekPackets.at(-1)?.packetName, "Character.ClearMovementRail");
  assert.ok(events.includes("PlayerUpdatePosition"));
  assert.equal(
    deathPackets.find((packet) => packet.name === "Character.StartMultiStateDeath")
      ?.payload.data.characterId,
    npc.characterId
  );
});

test("NPC look-at target is edge-triggered and cleared for native animation context", () => {
  const { npc, lookAtPackets } = makeNpc();

  npc.setLookAtCharacter("player");
  npc.setLookAtCharacter("player");
  npc.setLookAtCharacter(null);
  npc.setLookAtCharacter(null);

  assert.deepEqual(
    lookAtPackets.map((packet) => packet.unknownQword2),
    ["player", "0"]
  );
  assert.equal(npc.lookAtCharacter, null);
});

test("NPC speed changes update the client movement controller once per value", () => {
  const { npc, expectedSpeeds } = makeNpc();
  npc.navAgent = {
    maxSpeed: 0,
    maxAcceleration: 0
  };

  npc.setSpeed(3);
  npc.setSpeed(3);
  npc.setSpeed(7);
  npc.setSpeed(Number.NaN);

  assert.deepEqual(
    expectedSpeeds.map((packet) => packet.speed),
    [3, 7, 0]
  );
  assert.equal(npc.navAgent.maxSpeed, 0);
  assert.equal(npc.navAgent.maxAcceleration, 0);
});

test("NPC locomotion diagnostics keep target speed separate from measured wire speed", () => {
  const { npc } = makeNpc();
  npc.navAgent = {
    maxSpeed: 0,
    maxAcceleration: 0,
    velocity() {
      return { x: 0, y: 0, z: 4.25 };
    }
  };

  npc.setLocomotionMode("sprint");
  npc.setSpeed(6.5);
  npc.goTo(new Float32Array([0, 0, 0.5, 1]));

  assert.equal(npc.locomotionTargetSpeed, 6.5);
  assert.equal(npc.locomotionIntent, "sprint");
  assert.equal(npc.isCombatAnimationMode, false);
  assert.equal(npc.lastWireMotion.horizontalSpeed, 4.25);
  assert.equal(
    npc.lastWireMotion.stance,
    1024,
    "the first generic-zombie displacement is an acceleration hand-off"
  );

  // A second adjacent displacement is the first evidence that the visible
  // body and locomotion stream have both started.  The sprint stance and
  // positive graph edge are released only at that boundary.
  npc.lastMotionSample = undefined;
  npc.goTo(new Float32Array([0, 0, 1, 1]));
  assert.equal(npc.lastWireMotion.stance, 66565);
});

test("animal locomotion keeps continuous authored speeds inside the native graph domain", () => {
  const { npc, expectedSpeeds } = makeNpc();
  npc.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
  npc.navAgent = {
    maxSpeed: 0,
    maxAcceleration: 0,
    velocity: () => ({ x: 0, y: 0, z: 6.5 })
  };

  npc.setSpeed(6.5);
  assert.deepEqual(
    expectedSpeeds,
    [],
    "a native animal must not enter a gait before its first moving sample"
  );
  npc.goTo(new Float32Array([0, 0, 1, 1]));
  npc.setSpeed(12);

  assert.equal(
    npc.getNativeLocomotionProfile().source,
    "AnimalsPhysicsX64.mrn:Idle_Locomotion|Locomotion|BlendN1"
  );
  assert.deepEqual(
    npc.getNativeLocomotionProfile().authoredSpeedBands,
    [0.689, 1, 1.442, 2, 3, 4, 5, 6, 7, 8]
  );
  assert.deepEqual(
    expectedSpeeds.map((packet) => packet.speed),
    [6.5, 8],
    "continuous speed remains supported, while an out-of-domain request saturates at the native blend maximum"
  );
  assert.equal(npc.navAgent.maxSpeed, 8);
});

test("late NPC observers receive the current speed and combat locomotion state", () => {
  const packets: any[] = [];
  const npc: any = Object.create(Npc.prototype);
  npc.characterId = "animal";
  npc.flags = { nonAttackable: 0, knockedOut: 0 };
  npc.server = {
    _npcs: {},
    sendDataToAllWithSpawnedEntity() {},
    sendData(
      _client: unknown,
      packetName: string,
      payload: unknown
    ) {
      packets.push({ packetName, payload });
    }
  };
  npc.navAgent = { maxSpeed: 0, maxAcceleration: 0 };
  npc.setSpeed(6.5);
  npc.setCombatAnimationMode(true);

  npc.sendInitialLocomotionState({} as any);

  assert.deepEqual(
    packets.map((packet) => packet.packetName),
    [
      "Character.ExpectedSpeed",
      "Character.AggroLevel",
      "Character.UpdateCharacterState"
    ]
  );
  assert.equal(packets[0].payload.speed, 6.5);
  assert.equal(packets[1].payload.unknownDword1, 1);
  assert.equal(packets[2].payload.states2.inCombat, 1);
  assert.equal(packets[2].payload.states6.hidesHeat, 1);
});

test("late native-animal observers receive motion before speed and seek context", () => {
  const packets: any[] = [];
  const npc: any = Object.create(Npc.prototype);
  npc.characterId = "animal";
  npc.transientId = 1;
  npc.flags = { nonAttackable: 0, knockedOut: 0 };
  npc.state = {
    position: new Float32Array([0, 0, 1, 1]),
    yaw: 0
  };
  npc.server = {
    _npcs: {},
    sendDataToAllWithSpawnedEntity() {},
    sendData(
      _client: unknown,
      packetName: string,
      payload: unknown
    ) {
      packets.push({ packetName, payload });
    }
  };
  npc.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
  npc.navAgent = {
    maxSpeed: 0,
    maxAcceleration: 0,
    velocity: () => ({ x: 0, y: 0, z: 2 })
  };

  npc.setSpeed(6.5);
  npc.requestNativeSeekTarget(
    "player",
    new Float32Array([0, 0, 8, 1]),
    1000,
    6.5
  );
  // A late observer may replay the native rail only after an authoritative
  // moving position sample exists.  Use a real displacement here; a
  // stationary first crowd tick intentionally stays standing and is covered
  // by the dedicated start-slide regression.
  npc.goTo(new Float32Array([0, 0, 2, 1]));
  packets.length = 0;

  npc.sendInitialLocomotionState({} as any);

  assert.deepEqual(
    packets.map((packet) => packet.packetName),
    ["PlayerUpdatePosition", "Character.ExpectedSpeed", "Character.SeekTarget"]
  );
  assert.equal(packets[1].payload.speed, 6.5);
  assert.equal(packets[2].payload.TargetCharacterId, "player");
  assert.equal(packets[2].payload.speed, 6.5);
});

test("late NPC observers receive the current native look-at target", () => {
  const packets: any[] = [];
  const npc: any = Object.create(Npc.prototype);
  npc.characterId = "animal";
  npc.flags = { nonAttackable: 0, knockedOut: 0 };
  npc.server = {
    _npcs: {},
    sendDataToAllWithSpawnedEntity() {},
    sendData(
      _client: unknown,
      packetName: string,
      payload: unknown
    ) {
      packets.push({ packetName, payload });
    }
  };
  npc.lookAtCharacterId = "player";

  npc.sendInitialLocomotionState({} as any);

  assert.deepEqual(packets, [
    {
      packetName: "Character.SetLookAt",
      payload: {
        characterId: "animal",
        unknownQword2: "player"
      }
    }
  ]);
});

test("late NPC observers receive the last authoritative motion tuple", () => {
  const packets: any[] = [];
  const npc: any = Object.create(Npc.prototype);
  npc.characterId = "animal";
  npc.transientId = 17;
  npc.state = {
    position: new Float32Array([4, 5, 6, 1]),
    yaw: 1.25
  };
  npc.server = {
    _npcs: {},
    sendDataToAllWithSpawnedEntity() {},
    sendData(
      _client: unknown,
      packetName: string,
      payload: unknown
    ) {
      packets.push({ packetName, payload });
    }
  };
  npc.lastWireMotion = {
    sequenceTime: 1234,
    stance: 66565,
    horizontalSpeed: 4.25,
    verticalSpeed: 0.5,
    orientation: 1.25
  };

  npc.sendInitialLocomotionState({} as any);

  assert.deepEqual(packets, [
    {
      packetName: "PlayerUpdatePosition",
      payload: {
        transientId: 17,
        positionUpdate: {
          sequenceTime: 1234,
          unknown3_int8: 0,
          stance: 66565,
          position: [4, 5, 6],
          engineRPM: 0,
          orientation: 1.25,
          frontTilt: 0,
          sideTilt: 0,
          angleChange: 0,
          verticalSpeed: 0.5,
          horizontalSpeed: 4.25
        }
      }
    }
  ]);
});

test("NPC locomotion stance distinguishes walking from sprinting", () => {
  const { npc, packets } = makeNpc();
  npc.navAgent = {
    velocity: () => ({ x: 0, y: 0, z: 1 })
  };

  npc.setLocomotionMode("walk");
  npc.goTo(new Float32Array([0, 0, 1, 1]));
  assert.equal(packets.at(-1).stance, 1024);

  npc.goTo(new Float32Array([0, 0, 2, 1]));
  assert.equal(packets.at(-1).stance, 66560);

  // Start a fresh measured sample so the sprint assertion does not depend on
  // wall-clock spacing between adjacent test calls.
  npc.lastMotionSample = undefined;
  npc.navAgent.velocity = () => ({ x: 0, y: 0, z: 5 });
  npc.setLocomotionMode("sprint");
  npc.goTo(new Float32Array([0, 0, 3, 1]));
  assert.equal(packets.at(-1).stance, 66565);
  assert.notEqual(packets.at(-2).stance, packets.at(-1).stance);
});

test("NPC does not advertise a sprint stance before measured movement starts", () => {
  const { npc, packets } = makeNpc();
  npc.navAgent = {
    velocity: () => ({ x: 0, y: 0, z: 0 })
  };

  npc.setLocomotionMode("sprint");
  npc.goTo(new Float32Array([0, 0, 1, 1]));

  assert.equal(packets.at(-1).stance, 1024);
  assert.equal(packets.at(-1).horizontalSpeed, 0);
  assert.equal(packets.at(-1).verticalSpeed, 0);
});

test("NPC ignores a desired nav velocity until the first position displacement", () => {
  const { npc, packets } = makeNpc();
  npc.navAgent = {
    // Recast can expose a chase-sized desired velocity before its first
    // interpolated position sample has moved.  That sample must remain
    // standing for zombies and generic NPCs too; otherwise the client starts
    // a run cycle in place and slides when the real displacement arrives.
    velocity: () => ({ x: 0, y: 0, z: 5 })
  };

  npc.setLocomotionMode("sprint");
  npc.goTo(new Float32Array([0, 0, 0, 1]));

  assert.equal(packets.at(-1).stance, 1024);
  assert.equal(packets.at(-1).horizontalSpeed, 0);
  assert.equal(packets.at(-1).verticalSpeed, 0);
});

test("facing packets do not starve generic locomotion release", () => {
  const { npc, packets } = makeNpc();
  npc.navAgent = {
    maxSpeed: 0,
    maxAcceleration: 0,
    velocity: () => ({ x: 0, y: 0, z: 2 })
  };
  npc.movementAuthority = "server-position";
  npc.setLocomotionMode("sprint");
  npc.setSpeed(2);

  // First displacement is deliberately held in a standing stance.
  npc.goTo(new Float32Array([0, 0, 0.2, 1]));
  assert.equal(packets.at(-1).stance, 1024);

  // Attack states publish a facing-only packet before deciding that the
  // target is still outside strike range.  That packet must not erase the
  // first moving sample, or every subsequent tick would remain standing.
  npc.lookAt(new Float32Array([1, 0, 2, 1]), 0.1);
  npc.lastStoppedMotionSample.sequenceTime =
    (getCurrentServerTimeWrapper().getTruncatedU32() - 100) >>> 0;
  npc.goTo(new Float32Array([0, 0, 0.4, 1]));
  assert.equal(packets.at(-1).stance, 66565);
});

test("server-position NPCs defer ExpectedSpeed until the first moving sample", () => {
  const { npc, packets, expectedSpeeds, events } = makeNpc();
  npc.movementAuthority = "server-position";
  npc.navAgent = {
    maxSpeed: 0,
    maxAcceleration: 0,
    velocity: () => ({ x: 0, y: 0, z: 2.5 })
  };

  npc.setSpeed(2.5);
  assert.deepEqual(
    expectedSpeeds,
    [],
    "the positive graph edge must wait for an authoritative displacement"
  );
  npc.goTo(new Float32Array([0, 0, 0, 1]));
  assert.deepEqual(
    expectedSpeeds,
    [],
    "a desired Recast velocity without displacement is still standing"
  );

  npc.goTo(new Float32Array([0, 0, 0.25, 1]));
  assert.deepEqual(
    expectedSpeeds,
    [],
    "the first displacement only proves acceleration has started"
  );
  npc.goTo(new Float32Array([0, 0, 0.5, 1]));
  assert.deepEqual(expectedSpeeds.map((packet) => packet.speed), [2.5]);
  assert.deepEqual(
    events.slice(-2),
    ["PlayerUpdatePosition", "Character.ExpectedSpeed"],
    "position must precede the positive graph edge"
  );
  assert.ok(packets.at(-1).horizontalSpeed > 0);
});

test("native animal locomotion waits for the first authored moving band", () => {
  const { npc, packets, expectedSpeeds } = makeNpc();
  npc.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
  npc.navAgent = {
    velocity: () => ({ x: 0, y: 0, z: 0.5 })
  };

  npc.setLocomotionMode("sprint");
  npc.setSpeed(6.5);
  npc.goTo(new Float32Array([0, 0, 0.1, 1]));

  assert.equal(packets.at(-1).stance, 1024);
  assert.equal(packets.at(-1).horizontalSpeed, 0.5);
  assert.deepEqual(expectedSpeeds, []);

  // Once the measured velocity reaches the first native moving band, the
  // sprint stance is allowed through.  Reset the sample to avoid relying on
  // the wall-clock millisecond between test calls.
  npc.lastMotionSample = undefined;
  npc.navAgent.velocity = () => ({ x: 0, y: 0, z: 0.689 });
  npc.goTo(new Float32Array([0, 0, 0.2, 1]));
  assert.equal(packets.at(-1).stance, 66565);
  assert.deepEqual(expectedSpeeds.map((packet) => packet.speed), [6.5]);
});

test("NPC stop clears the advertised expected speed before an action", () => {
  const { npc, expectedSpeeds } = makeNpc();

  npc.setSpeed(6.5);
  npc.goTo(new Float32Array([0, 0, 1, 1]));
  npc.stopMovement();

  assert.deepEqual(
    expectedSpeeds.map((packet) => packet.speed),
    [6.5, 0]
  );
  assert.equal(npc.lastWireMotion.stance, 1024);
  assert.equal(npc.lastWireMotion.horizontalSpeed, 0);
});

test("NPC stop publishes an idle handoff when motion history was already cleared", () => {
  const { npc, packets, expectedSpeeds } = makeNpc();

  npc.setLocomotionMode("sprint");
  npc.setSpeed(6.5);
  npc.goTo(new Float32Array([0, 0, 1, 1]));

  // A facing-only transition is allowed to clear the displacement sample.
  // The last wire packet is still a moving stance, so stopping must not rely
  // only on lastMotionSample being present.
  npc.lastMotionSample = undefined;
  npc.stopMovement();

  assert.deepEqual(
    expectedSpeeds.map((packet) => packet.speed),
    [6.5, 0]
  );
  assert.equal(packets.at(-1).stance, 1024);
  assert.equal(packets.at(-1).horizontalSpeed, 0);
});

test("NPC resume measures its first displacement from the stop anchor", () => {
  const { npc, packets } = makeNpc();
  npc.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
  npc.navAgent = {
    velocity: () => ({ x: 0, y: 0, z: 6 })
  };

  // Simulate a short first acceleration step after an attack stop.  Recast's
  // velocity is already sprint-sized, but the authoritative displacement is
  // only 0.1 units over the preceding 150 ms path tick.
  const now = getCurrentServerTimeWrapper().getTruncatedU32();
  npc.lastMotionSample = undefined;
  npc.lastStoppedMotionSample = {
    sequenceTime: (now - 150) >>> 0,
    position: [0, 0, 0]
  };
  npc.setLocomotionMode("sprint");
  npc.goTo(new Float32Array([0, 0, 0.1, 1]));

  const motion = packets.at(-1);
  assert.ok(motion.horizontalSpeed < ANIMAL_NATIVE_LOCOMOTION_PROFILE.minimumMovingSpeed);
  assert.equal(motion.stance, 1024);
  assert.equal(npc.lastStoppedMotionSample, undefined);
});

test("NPC positive speed resumes pathfinding after an action stop", () => {
  const { npc } = makeNpc();
  let teleports = 0;
  npc.navAgent = {
    maxSpeed: 0,
    maxAcceleration: 0,
    resetMoveTarget() {},
    requestMoveVelocity() {},
    teleport() {
      teleports++;
    },
    velocity() {
      return { x: 0, y: 0, z: 0 };
    }
  };

  npc.setSpeed(3);
  npc.goTo(new Float32Array([0, 0, 1, 1]));
  npc.stopMovement();
  assert.equal(npc.isPathfindingMovementSuppressed, true);
  assert.equal(teleports, 1);

  // The value is intentionally the same as the previous locomotion intent;
  // resuming must be driven by positive movement intent, not by a speed
  // packet edge.
  npc.expectedSpeed = 3;
  npc.setSpeed(3);
  assert.equal(npc.isPathfindingMovementSuppressed, false);
});

test("NPC locomotion reports the measured velocity instead of a fixed speed", () => {
  const { npc, packets } = makeNpc();
  npc.navAgent = {
    velocity: () => ({ x: 0, y: 0, z: 4 })
  };

  npc.setLocomotionMode("sprint");
  npc.goTo(new Float32Array([0, 0, 1, 1]));
  // A new nav sample is intentionally used here: the measured velocity is
  // the only valid source when two updates share the same wire millisecond.
  npc.lastMotionSample = undefined;
  npc.goTo(new Float32Array([0, 0, 3, 1]));

  const motion = packets.at(-1);
  assert.equal(motion.stance, 66565);
  assert.ok(motion.horizontalSpeed > 0);
  assert.equal(motion.verticalSpeed, 0);
  assert.notEqual(motion.horizontalSpeed, 5);
  assert.equal(npc.lastWireMotion.horizontalSpeed, motion.horizontalSpeed);
  assert.equal(npc.lastWireMotion.stance, motion.stance);
});

test("NPC combat locomotion uses the native character-state graph", () => {
  const packets: any[] = [];
  const aggroPackets: any[] = [];
  const npc: any = Object.create(Npc.prototype);
  npc.characterId = "animal";
  npc.flags = { nonAttackable: 1, knockedOut: 0 };
  npc.server = {
    _npcs: {},
    sendDataToAllWithSpawnedEntity(
      _entities: unknown,
      _characterId: string,
      packetName: string,
      payload: unknown
    ) {
      if (packetName === "Character.UpdateCharacterState")
        packets.push(payload);
      if (packetName === "Character.AggroLevel") aggroPackets.push(payload);
    }
  };

  npc.setCombatAnimationMode(true);
  npc.setCombatAnimationMode(true);
  npc.setCombatAnimationMode(false);

  assert.equal(packets.length, 2, "combat state changes are edge-triggered");
  assert.equal(packets[0].states2.inCombat, 1);
  assert.equal(packets[0].states6.hidesHeat, 1);
  assert.equal(packets[1].states2.inCombat, 0);
  assert.equal(packets[1].states6.hidesHeat, 0);
  assert.equal(packets[0].states1.visible, 1);
  assert.equal(packets[0].states2.nonAttackable, 1);
  assert.deepEqual(
    aggroPackets.map((packet) => packet.unknownDword1),
    [1, 0],
    "combat state edges must update the native Interest_Level input"
  );
});

test("NPC combat state uses the client 22-byte bitflag layout", () => {
  const protocol = new H1Z1Protocol("ClientProtocol_1080");
  const packets: any[] = [];
  const npc: any = Object.create(Npc.prototype);
  npc.characterId = "animal";
  npc.flags = { nonAttackable: 1, knockedOut: 0 };
  npc.server = {
    _npcs: {},
    sendDataToAllWithSpawnedEntity(
      _entities: unknown,
      _characterId: string,
      packetName: string,
      payload: unknown
    ) {
      if (packetName === "Character.UpdateCharacterState") packets.push(payload);
    }
  };

  npc.setCombatAnimationMode(true);
  const packed = protocol.pack("Character.UpdateCharacterState", packets[0]);

  assert.ok(packed);
  assert.equal(packed.length, 22);
  // The first byte after opcode + characterId is states1.visible.  The
  // second is states2: nonAttackable(bit0) + inCombat(bit4).  states6 is the
  // sixth state byte, where hidesHeat is bit2 and selects combat locomotion.
  assert.equal(packed.readUInt8(10), 0x01);
  assert.equal(packed.readUInt8(11), 0x11);
  assert.equal(packed.readUInt8(15), 0x04);
});

test("NPC one-shot animations use the verified native event payload", () => {
  const { npc, animationPackets } = makeNpc();

  npc.setAnimation("Idle");
  assert.deepEqual(animationPackets, [{
    characterId: "animal",
    animationName: "Idle",
    unm4: 0,
    unknownDword1: 0,
    unknownByte1: 0,
    unknownDword2: 1430,
    animationType: "",
    unknownByte1xda: 0,
    unknownDword3: 0
  }]);
  assert.deepEqual(npc.getCurrentAnimationPacket(), animationPackets[0]);
  animationPackets.length = 0;
  npc.playAnimation("KnifeSlash");

  assert.equal(npc.currentAnimation, "");
  assert.deepEqual(animationPackets, [{
    characterId: "animal",
    animationName: "KnifeSlash",
    unm4: 0,
    unknownDword1: 0,
    unknownByte1: 0,
    unknownDword2: 1430,
    animationType: "",
    unknownByte1xda: 0,
    unknownDword3: 0
  }]);
});

test("Zombie001 recovery events use their authored clocks across every zombie subtype", () => {
  const { npc, animationPackets } = makeNpc();

  // These events are shared by ZombieWalker, PrototypeZombie, Gasser,
  // Exploder, and the screamer compatibility graph.  They previously used
  // the generic 1430 ms fallback even though the packed Zombie001 resource
  // keeps the actor in a turn/recovery pose for longer.
  const authored = [
    ["TurnLeft90", 2333],
    ["TurnRight90", 2333],
    ["TurnLeft180", 2500],
    ["TurnRight180", 2500],
    ["LostTarget", 6000],
    ["GrappleTell", 667]
  ] as const;

  for (const [animationName, durationMs] of authored) {
    assert.equal(ZOMBIE_NATIVE_ACTION_DURATION_MS[animationName], durationMs);
    assert.equal(npc.getAnimationDurationMs(animationName), durationMs);
    npc.playAnimation(animationName);
  }

  assert.deepEqual(
    animationPackets.map((packet) => [packet.animationName, packet.unknownDword2]),
    authored
  );
});

test("re-entering a live one-shot preserves its native clock", () => {
  const { npc, animationPackets } = makeNpc();
  const realNow = Date.now;
  let now = 1_500_000;
  Date.now = () => now;
  try {
    npc.initializeAnimation("Idle");
    npc.playAnimation("KnifeSlash");
    now += 250;

    // A duplicate FSM edge must not restart the client graph at frame zero.
    npc.playAnimation("KnifeSlash");

    assert.equal(animationPackets.length, 1);
    assert.equal(
      npc.getAnimationRuntimeState().activeAnimationRemainingMs,
      1180
    );
    assert.equal(npc.isAnimationActive("KnifeSlash"), true);
  } finally {
    Date.now = realNow;
  }
});

test("a replacement one-shot cancels the old action for shared FSM gates", () => {
  const { npc, animationPackets } = makeNpc();
  const realNow = Date.now;
  let now = 1_600_000;
  Date.now = () => now;
  try {
    npc.initializeAnimation("Idle");
    npc.playAnimation("KnifeSlash");
    now += 200;
    npc.playAnimation("MeleeFlinch");

    assert.deepEqual(
      animationPackets.map((packet) => packet.animationName),
      ["KnifeSlash", "MeleeFlinch"]
    );
    assert.equal(npc.isAnimationActive("KnifeSlash"), false);
    assert.equal(npc.isAnimationActive("MeleeFlinch"), true);
  } finally {
    Date.now = realNow;
  }
});

test("late observers receive the active one-shot before its native clock expires", () => {
  const { npc } = makeNpc();
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    npc.initializeAnimation("Idle");
    npc.playAnimation("KnifeSlash");

    assert.equal(npc.currentAnimation, "");
    assert.equal(npc.getCurrentAnimationPacket()?.animationName, "KnifeSlash");

    // The compatibility packet uses the same 1430 ms clock that the client
    // consumes. Once it expires, a newly relevant observer must receive the
    // persistent reset clip instead of the stale one-shot or no animation.
    now += 1430;
    assert.equal(npc.getCurrentAnimationPacket()?.animationName, "Idle");
    assert.equal(npc.currentAnimation, "Idle");
  } finally {
    Date.now = realNow;
  }
});

test("late full-data handoff settles an expired one-shot for existing observers", () => {
  const { npc, animationPackets, expectedSpeeds } = makeNpc();
  const realNow = Date.now;
  let now = 1_250_000;
  Date.now = () => now;
  try {
    npc.initializeAnimation("Idle");
    // Simulate a chase that was suspended by the action.  The expiry path
    // must restore this intent when a late full-data request races the timer.
    npc.deathTime = 0;
    npc.expectedSpeed = 3;
    npc.playAnimation("KnifeSlash");
    assert.deepEqual(
      animationPackets.map((packet) => packet.animationName),
      ["KnifeSlash"]
    );

    now += 1430;
    assert.equal(npc.getCurrentAnimationPacket()?.animationName, "Idle");
    assert.deepEqual(
      animationPackets.map((packet) => packet.animationName),
      ["KnifeSlash", "Idle"],
      "expiry must broadcast the persistent reset, not just change private state"
    );
    assert.equal(expectedSpeeds.at(-1)?.speed, 3);

    // The late observer request and the timer callback must be idempotent.
    assert.equal(npc.getCurrentAnimationPacket()?.animationName, "Idle");
    assert.deepEqual(
      animationPackets.map((packet) => packet.animationName),
      ["KnifeSlash", "Idle"]
    );
  } finally {
    Date.now = realNow;
  }
});

test("animation diagnostics expose the active one-shot clock and settle it", () => {
  const { npc } = makeNpc();
  const realNow = Date.now;
  let now = 2_000_000;
  Date.now = () => now;
  try {
    npc.initializeAnimation("Idle");
    npc.playAnimation("KnifeSlash");

    assert.deepEqual(npc.getAnimationRuntimeState(), {
      persistentAnimation: "Idle",
      activeAnimation: "KnifeSlash",
      activeAnimationRemainingMs: 1430,
      lastAnimationEvent: "KnifeSlash"
    });

    now += 1430;
    assert.deepEqual(npc.getAnimationRuntimeState(), {
      persistentAnimation: "Idle",
      activeAnimation: null,
      activeAnimationRemainingMs: null,
      lastAnimationEvent: "KnifeSlash"
    });
    assert.equal(npc.currentAnimation, "Idle");
  } finally {
    Date.now = realNow;
  }
});

test("action FSMs can wait for the native one-shot boundary", () => {
  const { npc } = makeNpc();
  const realNow = Date.now;
  let now = 2_500_000;
  Date.now = () => now;
  try {
    npc.nativeMeleeAnimationDurationMs = 1000;
    npc.initializeAnimation("Idle");
    npc.playAnimation("KnifeSlash");

    assert.equal(npc.isAnimationActive("KnifeSlash"), true);
    // The server FSM may reach its logical duration on a busy tick while the
    // client still has part of the packet's native clock left.
    now += 999;
    assert.equal(npc.isAnimationActive("KnifeSlash"), true);
    now += 1;
    assert.equal(npc.isAnimationActive("KnifeSlash"), false);
  } finally {
    Date.now = realNow;
  }
});

test("a live animal reaction is not cut short by a persistent Idle reset", () => {
  const { npc, animationPackets } = makeNpc();
  const realNow = Date.now;
  let now = 3_000_000;
  Date.now = () => now;
  try {
    npc.initializeAnimation("Idle");
    npc.nativeMeleeFlinchAnimationDurationMs = 1667;
    npc.playAnimation("MeleeFlinch");
    animationPackets.length = 0;

    // The predator FSM may finish its attack while the longer reaction clip
    // is still active. The reset becomes the persistent fallback, but must
    // not be broadcast early to an observer that is still seeing Flinch.
    npc.setAnimation("Idle");
    assert.deepEqual(animationPackets, []);
    assert.deepEqual(npc.getAnimationRuntimeState(), {
      persistentAnimation: "Idle",
      activeAnimation: "MeleeFlinch",
      activeAnimationRemainingMs: 1667,
      lastAnimationEvent: "MeleeFlinch"
    });

    now += 1667;
    assert.equal(npc.getCurrentAnimationPacket()?.animationName, "Idle");
    assert.equal(npc.currentAnimation, "Idle");
  } finally {
    Date.now = realNow;
  }
});

test("animal MeleeFlinch packets use the actor reaction clip clock", () => {
  const { npc, animationPackets } = makeNpc();
  npc.nativeMeleeFlinchAnimationDurationMs = 1667;

  npc.playAnimation("MeleeFlinch");

  assert.equal(animationPackets.at(-1).animationName, "MeleeFlinch");
  assert.equal(animationPackets.at(-1).unknownDword2, 1667);
});

test("NPC can prime a persistent animation before observers exist", () => {
  const { npc, animationPackets } = makeNpc();

  npc.initializeAnimation("Idle");

  assert.equal(npc.currentAnimation, "Idle");
  assert.equal(npc.lastAnimationEvent, "Idle");
  assert.equal(animationPackets.length, 0);
  assert.equal(npc.getCurrentAnimationPacket().animationName, "Idle");
});

test("animal stand-up and howl packets use their audited source clocks", () => {
  const { npc, animationPackets } = makeNpc();

  // AnimalsX64.mrn contains one WolfHowl (150 frames at 30 FPS) and one
  // Bear RearUp/StandUp clip (160 frames at 30 FPS).  These are not the
  // unresolved species attack clock, so the public event packet can carry
  // the same duration the production FSM waits before resuming locomotion.
  npc.playAnimation("WolfHowl");
  npc.playAnimation("StandUp");

  assert.deepEqual(
    animationPackets.map((packet) => [packet.animationName, packet.unknownDword2]),
    [
      ["WolfHowl", 5000],
      ["StandUp", 5333]
    ]
  );
});

test("NPC locomotion faces the measured nav displacement instead of a stale target", () => {
  const { npc, packets } = makeNpc();
  npc.lookAtTarget = new Float32Array([10, 0, 0]);

  // The target is due east, but the nav sample moved due north.  The wire
  // orientation must follow the displacement or the client blends a forward
  // run with a sideways slide around navmesh corners.
  npc.goTo(new Float32Array([0, 0, 1, 1]));
  assert.ok(Math.abs(packets.at(-1).orientation) < 1e-6);
});

test("NPC height-only nav samples preserve heading and use actual ground tilt", () => {
  const { npc, packets } = makeNpc();
  npc.state.yaw = Math.PI / 2;
  npc.lookAtTarget = new Float32Array([10, 7, 0]);

  // A stair/navmesh link changes only Y.  The nearby target is higher too,
  // but it must not turn the NPC or replace the actual ground delta used for
  // the locomotion tilt.
  npc.goTo(new Float32Array([0, 1, 0, 1]));

  const motion = packets.at(-1);
  assert.ok(Math.abs(motion.orientation - Math.PI / 2) < 1e-6);
  assert.ok(Math.abs(motion.angleChange) < 1e-6);
  assert.ok(Math.abs(motion.frontTilt - Math.PI / 2) < 1e-6);
});

test("NPC melee range resolves from the authoritative Machete fire mode", () => {
  const { npc } = makeNpc();
  // This fixture is exercising the checked-in weapon table itself.  Production
  // animals remain on the compatibility proxy until a native animal weapon
  // definition is recovered, so they must not inherit this 850ms timer.
  npc.meleeProfileSource = "server-weapon-table";
  npc.meleeWeaponItemDefinitionId = 83;
  npc.server = {
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
      REFIRE_TIME_MS: 125
    })
  };

  assert.equal(npc.getMeleeAttackRange(2.5), 1.5);
  assert.equal(npc.getMeleeAttackProfile().detectWidth, 0.15);
  assert.equal(npc.getMeleeAttackAnimationDuration(1), 0.85);
});

test("animal melee FSM clock matches the native PlayAnimation duration field", () => {
  const { npc } = makeNpc();
  npc.meleeProfileSource = "compatibility-proxy";
  npc.server = {
    getItemDefinition: () => ({ PARAM1: 10 }),
    getWeaponDefinition: () => ({
      MELEE_DETECT: { MELEE_DETECT_WIDTH: 0.15, MELEE_DETECT_HEIGHT: 0.1 },
      FIRE_GROUPS: [{ FIRE_GROUP_ID: 10 }]
    }),
    getFiregroupDefinition: () => ({ FIRE_MODES: [{ FIRE_MODE_ID: 13 }] }),
    getFiremodeDefinition: () => ({
      RANGE: 1.5,
      FIRE_DURATION_MS: 850,
      FIRE_ANIM_DURATION_MS: 850,
      REFIRE_TIME_MS: 125
    })
  };

  // The packet carries unknownDword2=1430; native case 3 scales it by 0.001
  // into MeleeDuration=1.43s.  The temporary Machete table must not shorten
  // the FSM and re-enable chase before that client action has finished.
  assert.equal(npc.getMeleeAttackAnimationDuration(1), 1.43);
});

test("NPC melee profile follows the checked-in 2016 weapon tables", () => {
  const { npc } = makeNpc();
  npc.meleeWeaponItemDefinitionId = 83;
  const itemDefinitions = JSON.parse(
    fs.readFileSync(
      path.resolve(
        process.cwd(),
        "data/2016/dataSources/ServerItemDefinitions.json"
      ),
      "utf8"
    )
  );
  const weaponDefinitions = JSON.parse(
    fs.readFileSync(
      path.resolve(
        process.cwd(),
        "data/2016/dataSources/ServerWeaponDefinitions.json"
      ),
      "utf8"
    )
  );
  npc.server = {
    getItemDefinition: (id: number) => itemDefinitions[String(id)],
    getWeaponDefinition: (id: number) =>
      weaponDefinitions.WEAPON_DEFINITIONS[String(id)]?.DATA,
    getFiregroupDefinition: (id: number) =>
      weaponDefinitions.FIRE_GROUP_DEFINITIONS[String(id)]?.DATA,
    getFiremodeDefinition: (id: number) =>
      weaponDefinitions.FIRE_MODE_DEFINITIONS[String(id)]?.DATA?.DATA
  };

  const profile = npc.getMeleeAttackProfile();
  assert.ok(profile);
  assert.deepEqual(
    {
      item: profile.itemDefinitionId,
      weapon: profile.weaponDefinitionId,
      fireGroup: profile.fireGroupId,
      fireMode: profile.fireModeId,
      range: profile.range,
      width: profile.detectWidth,
      height: profile.detectHeight,
      animationMs: profile.fireAnimDurationMs
    },
    {
      item: 83,
      weapon: 10,
      fireGroup: 10,
      fireMode: 13,
      range: 1.5,
      width: 0.15,
      height: 0.1,
      animationMs: 850
    }
  );
});

test("NPC melee diagnostics distinguish the animal compatibility profile from native timing", () => {
  const { npc, animationPackets } = makeNpc();
  npc.meleeProfileSource = "compatibility-proxy";

  assert.equal(npc.getMeleeAttackProfileSource(), "compatibility-proxy");
  npc.playAnimation("KnifeSlash");
  assert.equal(npc.lastAnimationEvent, "KnifeSlash");
  assert.deepEqual(npc.getAnimationVerification(npc.lastAnimationEvent), {
    eventName: "KnifeSlash",
    clockVerified: false,
    contactEventVerified: false,
    rootMotionVerified: false
  });
  assert.equal(animationPackets.at(-1).animationName, "KnifeSlash");
});

test("NPC native contact diagnostics keep client signal separate from server projection", () => {
  const { npc } = makeNpc();
  npc.meleeProfileSource = "compatibility-proxy";
  npc.nativeMeleeAnimationSource = "Animals_Bear001_Attack01";

  assert.deepEqual(npc.getNativeContactContract(), {
    signal: "AnimalsPhysics.SwingContact",
    clientAuthority: "client-local-graph",
    serverDamageAuthority: "server-projection",
    geometrySource: "native-client-shape-query-unavailable",
    liveVerified: false
  });
});

test("NPC melee envelope uses table reach and lateral width", () => {
  const { npc } = makeNpc();
  npc.meleeWeaponItemDefinitionId = 83;
  const itemDefinitions = JSON.parse(
    fs.readFileSync(
      path.resolve(
        process.cwd(),
        "data/2016/dataSources/ServerItemDefinitions.json"
      ),
      "utf8"
    )
  );
  const weaponDefinitions = JSON.parse(
    fs.readFileSync(
      path.resolve(
        process.cwd(),
        "data/2016/dataSources/ServerWeaponDefinitions.json"
      ),
      "utf8"
    )
  );
  npc.server = {
    getItemDefinition: (id: number) => itemDefinitions[String(id)],
    getWeaponDefinition: (id: number) =>
      weaponDefinitions.WEAPON_DEFINITIONS[String(id)]?.DATA,
    getFiregroupDefinition: (id: number) =>
      weaponDefinitions.FIRE_GROUP_DEFINITIONS[String(id)]?.DATA,
    getFiremodeDefinition: (id: number) =>
      weaponDefinitions.FIRE_MODE_DEFINITIONS[String(id)]?.DATA?.DATA
  };

  // makeNpc starts with yaw=0, whose horizontal forward is +Z.
  assert.equal(
    npc.isMeleeTargetInEnvelope(new Float32Array([0, 0, 1.4, 1])),
    true
  );
  // A small step-height difference is still inside the full 3-D range.
  assert.equal(
    npc.isMeleeTargetInEnvelope(new Float32Array([0, 0.3, 1.4, 1])),
    true
  );
  // The native reach is 1.5 m; RANGE is not replaced by the old FSM's 2.5 m.
  assert.equal(
    npc.isMeleeTargetInEnvelope(new Float32Array([0, 0, 1.6, 1])),
    false
  );
  // The target is in RANGE but outside the authoritative 0.15 m lateral gate.
  assert.equal(
    npc.isMeleeTargetInEnvelope(new Float32Array([0.2, 0, 1.2, 1])),
    false
  );
  // A target behind the NPC cannot be reached by this forward swing.
  assert.equal(
    npc.isMeleeTargetInEnvelope(new Float32Array([0, 0, -1, 1])),
    false
  );
});

test("native animal melee projection does not inherit the Machete reach or width", () => {
  const { npc } = makeNpc();
  npc.meleeProfileSource = "compatibility-proxy";
  npc.nativeMeleeAnimationSource = "Animals_Wolf001_AttackB";
  npc.nativeMeleeEngagementRange = 2;
  npc.meleeWeaponItemDefinitionId = 83;
  npc.server = {
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
      REFIRE_TIME_MS: 125
    })
  };

  // Wolf's 2m value is the explicit AI engagement projection.  The checked-in
  // Machete RANGE=1.5 is not allowed to shorten it.
  assert.equal(npc.getMeleeAttackRange(2.5), 2);
  assert.equal(
    npc.isMeleeTargetInEnvelope(
      new Float32Array([0, 0, 1.6, 1]),
      npc.state.position,
      [0, 1],
      2
    ),
    true
  );
  // Native contact is not gated by the two network-origin Y values.  A target
  // on a vehicle/step remains an attack candidate when its horizontal
  // engagement distance is valid; the client graph owns the actual 3-D shape
  // query.  This must not inherit the compatibility Machete's height field.
  assert.ok(
    Math.abs(
      npc.getMeleeTargetDistance(
        new Float32Array([0, 3, 1.6, 1]),
        npc.state.position
      ) - 1.6
    ) < 1e-5
  );
  assert.equal(
    npc.isMeleeTargetInEnvelope(
      new Float32Array([0, 3, 1.6, 1]),
      npc.state.position,
      [0, 1],
      2
    ),
    true
  );
  // Native animal contact geometry is not the Machete's 0.15m lateral gate.
  assert.equal(
    npc.isMeleeTargetInEnvelope(
      new Float32Array([0.8, 0, 1.2, 1]),
      npc.state.position,
      [0, 1],
      2
    ),
    true
  );
  assert.equal(
    npc.isMeleeTargetInEnvelope(
      new Float32Array([0, 0, 2.1, 1]),
      npc.state.position,
      [0, 1],
      2
    ),
    false
  );
  // Omitting the explicit animal engagement range fails closed rather than
  // silently reverting to the unrelated table value.
  assert.equal(
    npc.isMeleeTargetInEnvelope(
      new Float32Array([0, 0, 1.4, 1]),
      npc.state.position,
      [0, 1]
    ),
    false
  );
});

test("native animal engagement does not depend on the compatibility weapon table", () => {
  const { npc } = makeNpc();
  npc.meleeProfileSource = "compatibility-proxy";
  npc.nativeMeleeAnimationSource = "Animals_Wolf001_AttackB";
  npc.server = {
    getItemDefinition() {
      throw new Error("weapon definitions are not loaded");
    },
    getWeaponDefinition() {
      throw new Error("weapon definitions are not loaded");
    },
    getFiregroupDefinition() {
      throw new Error("weapon definitions are not loaded");
    },
    getFiremodeDefinition() {
      throw new Error("weapon definitions are not loaded");
    }
  };

  assert.equal(
    npc.isMeleeTargetInEnvelope(
      new Float32Array([0, 0, 1.8, 1]),
      npc.state.position,
      [0, 1],
      2
    ),
    true
  );
  assert.equal(
    npc.isMeleeTargetInEnvelope(
      new Float32Array([0, 0, 1.8, 1]),
      npc.state.position,
      [0, 1]
    ),
    false,
    "an animal still needs an explicit engagement range"
  );
});

test("NPC melee envelope fails closed when weapon tables are unavailable", () => {
  const { npc } = makeNpc();
  npc.meleeWeaponItemDefinitionId = 83;
  npc.server = {
    getItemDefinition() {
      throw new Error("definition tables not initialized");
    },
    getWeaponDefinition() {
      return undefined;
    },
    getFiregroupDefinition() {
      return undefined;
    },
    getFiremodeDefinition() {
      return undefined;
    }
  };

  assert.equal(
    npc.isMeleeTargetInEnvelope(new Float32Array([0, 0, 1, 1])),
    false
  );
});

test("NPC melee reports use the NPC as the PvE damage source", () => {
  const { npc } = makeNpc();
  const hitReports: any[] = [];
  npc.npcMeleeDamage = 2000;
  npc.meleeWeaponItemDefinitionId = 83;
  npc.server = {
    getClientByCharId: () => ({
      isLoading: false,
      vehicle: { mountedVehicle: null },
      character: {
        characterId: "player",
        state: { position: new Float32Array([10, 0, 10, 0]) },
        meleeHit: { abilityHitLocation: "TORSO" },
        OnMeleeHit: (_server: unknown, info: unknown) => hitReports.push(info)
      }
    }),
    isSurvival: () => false,
    infectionEnabled: false,
    _vehicles: {}
  };

  npc.applyDamage("player");
  assert.equal(hitReports.length, 1);
  assert.equal(hitReports[0].hitReport.characterId, "animal");
  assert.deepEqual(Array.from(hitReports[0].hitReport.position), [0, 0, 0, 1]);
  assert.equal(hitReports[0].weapon, 83);
});

test("live AnimalsPhysics actors emit MeleeFlinch after a player melee hit", () => {
  const { npc, animationPackets } = makeNpc();
  npc.deathTime = 0;
  npc.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
  npc.nativeMeleeAnimationSource = "Animals_Wolf001_AttackB";
  npc.damage = () => {
    // Keep the test target alive so the accepted hit can publish its reaction.
    npc.deathTime = 0;
  };
  npc.server.getClientByCharId = () => ({
    character: { getEquippedWeapon: () => undefined }
  });

  npc.OnMeleeHit(npc.server, { entity: "player", damage: 150 });

  assert.deepEqual(
    animationPackets.map((packet) => packet.animationName),
    ["MeleeFlinch"]
  );

  // Zombie001/compatibility NPC graphs use Flinch for a surviving melee hit;
  // the helper must not send the AnimalsPhysics-only MeleeFlinch event.
  const nonAnimal = makeNpc();
  nonAnimal.npc.deathTime = 0;
  nonAnimal.npc.damage = () => {
    nonAnimal.npc.deathTime = 0;
  };
  nonAnimal.npc.server.getClientByCharId = () => ({
    character: { getEquippedWeapon: () => undefined }
  });
  nonAnimal.npc.OnMeleeHit(nonAnimal.npc.server, {
    entity: "player",
    damage: 150
  });
  assert.deepEqual(
    nonAnimal.animationPackets.map((packet: any) => packet.animationName),
    ["Flinch"]
  );
});

test("Zombie001 NPC hit reactions carry the native directional selector", () => {
  const { npc, animationPackets } = makeNpc();
  npc.deathTime = 0;
  npc.state.yaw = 0;
  npc.damage = () => {
    npc.deathTime = 0;
  };
  const source = {
    characterId: "player",
    state: {
      position: new Float32Array([0, 0, 3, 1]),
      yaw: 0
    }
  };
  npc.server.getEntity = (entityId: string) =>
    entityId === source.characterId ? source : undefined;
  npc.server.getClientByCharId = () => ({
    character: { getEquippedWeapon: () => undefined }
  });

  npc.OnMeleeHit(npc.server, { entity: source.characterId, damage: 150 });

  assert.equal(animationPackets.length, 1);
  assert.equal(animationPackets[0].animationName, "Flinch");
  assert.equal(animationPackets[0].animationType, "FlinchDirection");
  // The same (targetYaw - sourceYaw) - 135° conversion used by the player
  // graph produces the rear sector for two actors facing north.
  assert.equal(animationPackets[0].unknownDword3, 2);
});

test("live AnimalsPhysics actors emit Flinch after a projectile hit", () => {
  const { npc, animationPackets } = makeNpc();
  npc.deathTime = 0;
  npc.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
  npc.nativeMeleeAnimationSource = "Animals_Deer001_RecoilB";
  npc.damage = () => {
    // Keep the test target alive so the accepted hit can publish its reaction.
    npc.deathTime = 0;
  };
  npc.server.getClientByCharId = () => undefined;

  npc.OnProjectileHit(npc.server, {
    entity: "player",
    damage: 25,
    hitReport: { hitLocation: "TORSO" }
  });

  assert.deepEqual(
    animationPackets.map((packet) => packet.animationName),
    ["Flinch"]
  );

  const nonAnimal = makeNpc();
  nonAnimal.npc.deathTime = 0;
  nonAnimal.npc.damage = () => {
    nonAnimal.npc.deathTime = 0;
  };
  nonAnimal.npc.server.getClientByCharId = () => undefined;
  nonAnimal.npc.OnProjectileHit(nonAnimal.npc.server, {
    entity: "player",
    damage: 25,
    hitReport: { hitLocation: "TORSO" }
  });
  assert.deepEqual(
    nonAnimal.animationPackets.map((packet: any) => packet.animationName),
    ["Flinch"]
  );
});

test("NPC-origin melee hits also emit animal MeleeFlinch when the victim survives", () => {
  const { npc, animationPackets } = makeNpc();
  npc.deathTime = 0;
  npc.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
  npc.nativeMeleeAnimationSource = "Animals_Deer001_RecoilB";
  npc.damage = () => {
    // Keep the target alive so the presentation edge is valid.
    npc.deathTime = 0;
  };

  npc.applyNpcMeleeHit(npc.server, {
    entity: "wolf",
    damage: 2000
  });

  assert.deepEqual(
    animationPackets.map((packet) => packet.animationName),
    ["MeleeFlinch"]
  );

  const dead = makeNpc();
  dead.npc.deathTime = Date.now();
  dead.npc.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
  dead.npc.nativeMeleeAnimationSource = "Animals_Deer001_RecoilB";
  dead.npc.applyNpcMeleeHit(dead.npc.server, {
    entity: "wolf",
    damage: 2000
  });
  assert.deepEqual(dead.animationPackets, []);
});

test("live AnimalsPhysics actors emit Flinch after a surviving explosive hit", () => {
  const { npc, animationPackets } = makeNpc();
  npc.deathTime = 0;
  npc.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
  npc.nativeMeleeAnimationSource = "Animals_Bear001_Attack01";
  npc.state.position = new Float32Array([0, 0, 0, 1]);
  npc.damage = () => {
    npc.deathTime = 0;
  };

  npc.OnExplosiveHit(npc.server, {
    characterId: "explosive",
    state: { position: new Float32Array([0, 0, 0, 1]) }
  });

  assert.deepEqual(
    animationPackets.map((packet) => packet.animationName),
    ["Flinch"]
  );

  const nonAnimal = makeNpc();
  nonAnimal.npc.deathTime = 0;
  nonAnimal.npc.state.position = new Float32Array([0, 0, 0, 1]);
  nonAnimal.npc.damage = () => {
    nonAnimal.npc.deathTime = 0;
  };
  nonAnimal.npc.OnExplosiveHit(nonAnimal.npc.server, {
    characterId: "explosive",
    state: { position: new Float32Array([0, 0, 0, 1]) }
  });
  assert.deepEqual(
    nonAnimal.animationPackets.map((packet: any) => packet.animationName),
    ["Flinch"]
  );
});

test("lethal animal hits do not publish a reaction after the death edge", () => {
  const configureLethalAnimal = () => {
    const fixture = makeNpc();
    const { npc } = fixture;
    npc.deathTime = 0;
    npc.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
    npc.nativeMeleeAnimationSource = "Animals_Wolf001_AttackB";
    npc.server.getClientByCharId = () => undefined;
    npc.damage = () => {
      // Npc.damage() sets deathTime before its promise is returned. Mirror
      // that synchronous state edge without running the full server death
      // side effects in this focused presentation test.
      npc.deathTime = Date.now();
    };
    return fixture;
  };

  const npcHit = configureLethalAnimal();
  npcHit.npc.applyNpcMeleeHit(npcHit.npc.server, {
    entity: "wolf",
    damage: 2000
  });
  assert.deepEqual(npcHit.animationPackets, []);

  const meleeHit = configureLethalAnimal();
  meleeHit.npc.OnMeleeHit(meleeHit.npc.server, {
    entity: "player",
    damage: 2000
  });
  assert.deepEqual(meleeHit.animationPackets, []);

  const projectileHit = configureLethalAnimal();
  projectileHit.npc.OnProjectileHit(projectileHit.npc.server, {
    entity: "player",
    damage: 2000,
    hitReport: { hitLocation: "TORSO" }
  });
  assert.deepEqual(projectileHit.animationPackets, []);

  const explosiveHit = configureLethalAnimal();
  explosiveHit.npc.OnExplosiveHit(explosiveHit.npc.server, {
    characterId: "explosive",
    state: { position: new Float32Array([0, 0, 0, 1]) }
  });
  assert.deepEqual(explosiveHit.animationPackets, []);
});

test("NPC melee still reaches a mounted player's character on PvE", () => {
  const vehicleHits: any[] = [];
  const characterHits: any[] = [];
  const { npc } = makeNpc();
  npc.npcMeleeDamage = 2000;
  npc.server = {
    isPvE: true,
    getClientByCharId: () => ({
      isLoading: false,
      vehicle: { mountedVehicle: "vehicle" },
      character: {
        characterId: "player",
        isAlive: true,
        isRespawning: false,
        meleeHit: { abilityHitLocation: "TORSO" },
        OnMeleeHit: (_server: unknown, info: unknown) =>
          characterHits.push(info)
      }
    }),
    isSurvival: () => false,
    infectionEnabled: false,
    _vehicles: {
      vehicle: {
        OnMeleeHit: (_server: unknown, info: unknown) => vehicleHits.push(info)
      }
    }
  };

  npc.applyDamage("player");

  assert.equal(vehicleHits.length, 1);
  assert.equal(characterHits.length, 1);
  assert.equal(characterHits[0].entity, "animal");
});

test("NPC melee feedback is independent from protected player health", () => {
  const feedback: any[] = [];
  const { npc } = makeNpc();
  npc.npcMeleeDamage = 2000;
  npc.meleeWeaponItemDefinitionId = 83;
  npc.server = {
    getClientByCharId: () => ({
      isLoading: false,
      character: {
        characterId: "player",
        isAlive: true,
        isRespawning: false,
        meleeHit: { abilityHitLocation: "TORSO" },
        sendDamageFeedback: (_server: unknown, info: unknown) => {
          feedback.push(info);
          return true;
        }
      }
    })
  };

  assert.equal(npc.sendMeleeDamageFeedback("player"), true);
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].entity, "animal");
  assert.equal(feedback[0].hitReport.characterId, "animal");
  assert.equal(feedback[0].hitReport.hitLocation, "TORSO");
});

test("NPC melee contact emits the native player Flinch event", () => {
  const packets: any[] = [];
  const character: any = Object.create(Character2016.prototype);
  character.characterId = "player";
  character.characterStates = { knockedOut: false };
  character.isRespawning = false;
  const client: any = { isLoading: false, character };
  const server: any = {
    getClientByCharId: () => client,
    sendData: (_client: unknown, packetName: string, payload: unknown) => {
      packets.push({ packetName, payload });
    }
  };

  assert.equal(
    character.sendNpcMeleeFlinch(server, { entity: "animal", damage: 1 }),
    true
  );
  assert.deepEqual(packets, [
    {
      packetName: "Character.PlayAnimation",
      payload: {
        characterId: "player",
        animationName: "Flinch",
        unm4: 0,
        unknownDword1: 0,
        unknownByte1: 0,
        unknownDword2: 0,
        animationType: "",
        unknownByte1xda: 0,
        unknownDword3: 0
      }
    }
  ]);
});

test("NPC melee Flinch carries the native relative heading sector", () => {
  const packets: any[] = [];
  const character: any = Object.create(Character2016.prototype);
  character.characterId = "player";
  character.characterStates = { knockedOut: false };
  character.isRespawning = false;
  character.state = {
    position: new Float32Array([0, 0, 0, 1]),
    yaw: 0
  };
  const source = {
    characterId: "animal",
    state: {
      position: new Float32Array([0, 0, 3, 1]),
      yaw: 0
    }
  };
  const client: any = { isLoading: false, character };
  const server: any = {
    getClientByCharId: () => client,
    getEntity: (entityId: string) => (entityId === "animal" ? source : undefined),
    sendData: (_client: unknown, packetName: string, payload: unknown) => {
      packets.push({ packetName, payload });
    }
  };

  assert.equal(
    character.sendNpcMeleeFlinch(server, { entity: "animal", damage: 1 }),
    true
  );
  assert.equal(packets.length, 1);
  assert.equal(packets[0].payload.animationName, "Flinch");
  assert.equal(packets[0].payload.animationType, "FlinchDirection");
  // (targetYaw - sourceYaw) - 135 degrees = 225 degrees => sector 2.
  assert.equal(packets[0].payload.unknownDword3, 2);
});

test("NPC melee Flinch mirrors the native negative-scale sector boundaries", () => {
  const cases = [
    // The native path uses (relative * -1/90) truncated toward zero, then
    // wraps negative values by four.  Interior points avoid making the test
    // depend on whether a particular compiler rounds an exact boundary one
    // ULP below it; the negative scale remains observable as 0, 3, 2, 1
    // instead of 0, 1, 2, 3.
    { targetYaw: 0, sourceYaw: (-195 * Math.PI) / 180, expected: 0 }, // relative 60°
    { targetYaw: 0, sourceYaw: (-285 * Math.PI) / 180, expected: 3 }, // relative 150°
    { targetYaw: 0, sourceYaw: (-375 * Math.PI) / 180, expected: 2 }, // relative 240°
    { targetYaw: 0, sourceYaw: (-465 * Math.PI) / 180, expected: 1 } // relative 330°
  ];

  for (const entry of cases) {
    const packets: any[] = [];
    const character: any = Object.create(Character2016.prototype);
    character.characterId = "player";
    character.characterStates = { knockedOut: false };
    character.isRespawning = false;
    character.state = { yaw: entry.targetYaw };
    const source = {
      characterId: "animal",
      state: { yaw: entry.sourceYaw }
    };
    const client: any = { isLoading: false, character };
    const server: any = {
      getClientByCharId: () => client,
      getEntity: () => source,
      sendData: (_client: unknown, packetName: string, payload: unknown) => {
        packets.push({ packetName, payload });
      }
    };

    assert.equal(
      character.sendNpcMeleeFlinch(server, { entity: "animal", damage: 1 }),
      true
    );
    assert.equal(packets[0].payload.animationType, "FlinchDirection");
    assert.equal(packets[0].payload.unknownDword3, entry.expected);
  }
});

test("NPC melee Flinch is broadcast to the victim's spawned observers", () => {
  const broadcasts: any[] = [];
  const character: any = Object.create(Character2016.prototype);
  character.characterId = "player";
  character.characterStates = { knockedOut: false };
  character.isRespawning = false;
  const client: any = { isLoading: false, character };
  const server: any = {
    _characters: { player: character },
    getClientByCharId: () => client,
    sendDataToAllWithSpawnedEntity: (
      dictionary: unknown,
      characterId: string,
      packetName: string,
      payload: unknown
    ) => {
      broadcasts.push({ dictionary, characterId, packetName, payload });
    },
    sendData: () => {
      throw new Error("the broadcast path must be used when available");
    }
  };

  assert.equal(
    character.sendNpcMeleeFlinch(server, { entity: "animal", damage: 1 }),
    true
  );
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].dictionary, server._characters);
  assert.equal(broadcasts[0].characterId, "player");
  assert.equal(broadcasts[0].packetName, "Character.PlayAnimation");
  assert.equal(broadcasts[0].payload.animationName, "Flinch");
});

test("NPC melee protected replay sends feedback without bleed or infection side effects", () => {
  const feedback: any[] = [];
  const vehicleHits: any[] = [];
  let meleeHitCalls = 0;
  const { npc } = makeNpc();
  npc.npcMeleeDamage = 2000;
  const character: any = {
    characterId: "player",
    isAlive: true,
    isRespawning: false,
    isGodMode: () => true,
    meleeHit: { abilityHitLocation: "TORSO" },
    sendDamageFeedback: (_server: unknown, info: unknown) => {
      feedback.push(info);
      return true;
    },
    OnMeleeHit: () => {
      meleeHitCalls++;
    }
  };
  npc.server = {
    getClientByCharId: () => ({
      isLoading: false,
      vehicle: { mountedVehicle: "vehicle" },
      character
    }),
    isSurvival: () => true,
    infectionEnabled: true,
    _vehicles: {
      vehicle: {
        OnMeleeHit: (_server: unknown, info: unknown) => vehicleHits.push(info)
      }
    }
  };

  npc.applyDamage("player");

  assert.equal(feedback.length, 1);
  assert.equal(meleeHitCalls, 0);
  assert.equal(vehicleHits.length, 0);
});

test("NPC melee does not duplicate normal player hit feedback", () => {
  const feedback: any[] = [];
  const { npc } = makeNpc();
  npc.npcMeleeDamage = 2000;
  npc.meleeWeaponItemDefinitionId = 83;
  const character: any = {
    characterId: "player",
    isAlive: true,
    isRespawning: false,
    isGodMode: () => false,
    meleeHit: { abilityHitLocation: "TORSO" },
    sendDamageFeedback: (_server: unknown, info: unknown) => {
      feedback.push(info);
      return true;
    },
    // A real Character.OnMeleeHit reaches Character.damage(), which emits
    // the single normal feedback packet.  Model that successful path here.
    OnMeleeHit: (server: any, info: any) => {
      character.sendDamageFeedback(server, info);
    }
  };
  npc.server = {
    getClientByCharId: () => ({
      isLoading: false,
      vehicle: { mountedVehicle: null },
      character
    }),
    isSurvival: () => false,
    infectionEnabled: false,
    _vehicles: {}
  };

  npc.applyDamage("player");

  assert.equal(feedback.length, 1);
});
