import assert from "node:assert/strict";
import test from "node:test";
import { AnimalTestHarness } from "../out/servers/ZoneServer2016/managers/animaltestharness";

function vec(x: number, y = 0, z = 0): Float32Array {
  return new Float32Array([x, y, z, 1]);
}

test("animal test replacement keeps the old NPC when replication fails", () => {
  const npcs: Record<string, any> = {};
  const deleted: string[] = [];
  let nextId = 0;
  let replicationCount = 0;
  const client: any = {
    sessionId: "local-session",
    character: {
      isAlive: true,
      isRespawning: false,
      state: {
        position: vec(100, 20, 200),
        yaw: 0,
        lookAt: vec(0, 0, 1)
      }
    }
  };
  const server: any = {
    _soloMode: true,
    _clients: { "local-session": client },
    _npcs: npcs,
    _characters: {},
    aiTargetSpatialMap: new Map(),
    worldObjectManager: {
      createNpc() {
        const characterId = `test-${++nextId}`;
        const npc = {
          characterId,
          state: { position: vec(100, 20, 208) },
          npcMeleeDamage: 0,
          fsm: undefined,
          navAgent: undefined
        };
        npcs[characterId] = npc;
        return npc;
      }
    },
    spawnEntityForClient() {
      replicationCount++;
      if (replicationCount === 2) {
        throw new Error("simulated replication failure");
      }
    },
    deleteEntity(characterId: string, dictionary: Record<string, any>) {
      if (!dictionary[characterId]) return false;
      delete dictionary[characterId];
      deleted.push(characterId);
      return true;
    }
  };

  const harness = new AnimalTestHarness(server);
  const first = harness.spawn(client, "bear", 8, 0, false);
  assert.equal(first.characterId, "test-1");
  assert.ok(npcs[first.characterId]);

  assert.throws(
    () => harness.spawn(client, "wolf", 8, 0, false),
    /simulated replication failure/
  );
  assert.ok(npcs[first.characterId], "the old test NPC must remain visible");
  assert.deepEqual(deleted, ["test-2"]);
  assert.equal((harness.status() as any).lastNpcId, first.characterId);

  const replacement = harness.spawn(client, "deer", 8, 0, false);
  assert.equal(replacement.characterId, "test-3");
  assert.equal(npcs[first.characterId], undefined);
  assert.deepEqual(Object.keys(npcs), [replacement.characterId]);
  assert.equal((harness.status() as any).lastNpcId, replacement.characterId);
});

test("slope harness preserves the requested height after production spawn canonicalization", () => {
  const npcs: Record<string, any> = {};
  const client: any = {
    sessionId: "slope-session",
    character: {
      isAlive: true,
      isRespawning: false,
      state: {
        position: vec(100, 20, 200),
        yaw: 0,
        lookAt: vec(0, 0, 1)
      }
    }
  };
  const navPoint = { x: 100, y: 20, z: 208 };
  const server: any = {
    _soloMode: true,
    _clients: { "slope-session": client },
    _npcs: npcs,
    _characters: {},
    navManager: {
      navMeshQuery: {},
      getClosestNavPointVec3() {
        return navPoint;
      }
    },
    worldObjectManager: {
      createNpc() {
        // This is the state a production constructor leaves after its Recast
        // spawn canonicalization.  The harness must restore the explicit
        // slope request for a height-difference capture.
        const npc = {
          characterId: "slope-animal",
          state: { position: vec(navPoint.x, navPoint.y, navPoint.z) },
          navAgent: {
            teleport() {}
          },
          npcMeleeDamage: 0,
          fsm: undefined
        };
        npcs[npc.characterId] = npc;
        return npc;
      }
    },
    spawnEntityForClient() {},
    deleteEntity(characterId: string, dictionary: Record<string, any>) {
      if (!dictionary[characterId]) return false;
      delete dictionary[characterId];
      return true;
    },
    aiTargetSpatialMap: new Map()
  };

  const harness = new AnimalTestHarness(server);
  const result = harness.spawn(client, "bear", 8, 3, false);

  assert.equal(result.projectedToNav, false);
  assert.deepEqual(result.navPosition, [100, 20, 208, 0]);
  assert.deepEqual(result.requestedPosition, [100, 23, 208, 1]);
  assert.deepEqual(result.position, result.requestedPosition);
  assert.equal(result.navigationHeightOffset, 3);
  assert.equal(npcs[result.characterId].state.position[1], 23);
  assert.equal(npcs[result.characterId].testHarnessVerticalOffset, 3);
});

test("animal status reports both horizontal and 3-D target separation", () => {
  const npcs: Record<string, any> = {};
  const client: any = {
    sessionId: "status-session",
    character: {
      isAlive: true,
      isRespawning: false,
      state: {
        position: vec(100, 20, 200),
        yaw: 0,
        lookAt: vec(0, 0, 1)
      }
    }
  };
  const target = {
    characterId: "player",
    isAlive: true,
    state: { position: vec(100, 23, 209) }
  };
  const server: any = {
    _soloMode: true,
    _clients: { "status-session": client },
    _npcs: npcs,
    _characters: { player: target },
    aiTargetSpatialMap: new Map(),
    navManager: {
      navMeshQuery: {},
      getClosestNavPointVec3(position: Float32Array) {
        return { x: position[0], y: position[1], z: position[2] };
      }
    },
    worldObjectManager: {
      createNpc() {
        const npc = {
          characterId: "status-animal",
          state: { position: vec(100, 20, 208) },
          navAgent: { velocity: () => ({ x: 0, y: 0, z: 0 }) },
          npcMeleeDamage: 4000,
          nativeMeleeEngagementRange: 2,
          getMeleeAttackProfile: () => ({ range: 1.5 }),
          getMeleeAttackProfileSource: () => "compatibility-proxy",
          getMeleeAttackEnvelopeSource: () =>
            "animal-engagement-projection",
          getMeleeAttackAnimationDuration: () => 1,
          getMeleeContactWindow: () => ({
            startFraction: 0.25,
            endFraction: 0.75
          }),
          getAnimationVerification: () => ({
            eventName: null,
            clockVerified: false,
            contactEventVerified: false,
            rootMotionVerified: false
          }),
          getAnimationRuntimeState: () => ({
            persistentAnimation: "Idle",
            activeAnimation: null,
            activeAnimationRemainingMs: null,
            lastAnimationEvent: null
          }),
          getNativeContactContract: () => ({
            signal: "AnimalsPhysics.SwingContact",
            clientAuthority: "client-local-graph",
            serverDamageAuthority: "server-projection",
            geometrySource: "native-client-shape-query-unavailable",
            liveVerified: false
          }),
          nativeGaitReady: false,
          pendingLocomotionTargetSpeed: 5,
          pendingNativeSeekTargetId: "player",
          isMeleeTargetInEnvelope(
            targetPosition: Float32Array,
            origin: Float32Array,
            _forward?: [number, number],
            range?: number
          ) {
            return Math.hypot(
              targetPosition[0] - origin[0],
              targetPosition[2] - origin[2]
            ) <= (range ?? 0);
          },
          isAlive: true,
          faction: "bear",
          fsm: undefined
        };
        npcs[npc.characterId] = npc;
        return npc;
      }
    },
    spawnEntityForClient() {},
    deleteEntity(characterId: string, dictionary: Record<string, any>) {
      if (!dictionary[characterId]) return false;
      delete dictionary[characterId];
      return true;
    }
  };

  const harness = new AnimalTestHarness(server);
  const result = harness.spawn(client, "bear", 8, 0, false);
  npcs[result.characterId].fsm = {
    state: "attack",
    targetCharacterId: "player",
    stateTimer: 0
  };

  const animal = (harness.status() as any).animals[0];
  assert.equal(animal.targetDistance2d, 1);
  assert.equal(animal.targetHeightDelta, 3);
  assert.equal(animal.targetDistance3d, Math.sqrt(10));
  assert.equal(animal.meleeEnvelopeSource, "animal-engagement-projection");
  assert.equal(animal.meleeInEnvelope, true);
  assert.equal(animal.nativeGaitReady, false);
  assert.equal(animal.pendingExpectedSpeed, 5);
  assert.equal(animal.pendingNativeSeekTargetId, "player");
  assert.equal(animal.targetPositionSource, "character-state");
  assert.equal(animal.targetMountedVehicleId, null);
  assert.equal(animal.targetMountedSeatId, null);
  assert.equal(animal.targetVehiclePosition, null);
});
