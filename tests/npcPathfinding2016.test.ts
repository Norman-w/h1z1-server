import assert from "node:assert/strict";
import test from "node:test";
import { ZoneServer2016 } from "../out/servers/ZoneServer2016/zoneserver";
import { NavManager } from "../out/utils/recast";

function makeServer(npc: any) {
  const server: any = Object.create(ZoneServer2016.prototype);
  server._npcs = { npc };
  server._characters = {};
  server._vehicles = {};
  return server;
}

test("NavManager preserves an NPC spawn point when requested", () => {
  const manager: any = Object.create(NavManager.prototype);
  const navPosition = { x: 10, y: 4, z: 20 };
  const randomPosition = { x: 10.4, y: 4, z: 20.4 };
  const agentPositions: any[] = [];
  manager.getClosestNavPointVec3 = () => navPosition;
  manager.navMeshQuery = {
    findRandomPointAroundCircle: () => ({
      success: true,
      randomPoint: randomPosition,
      status: 0
    })
  };
  manager.crowd = {
    addAgent(position: unknown) {
      agentPositions.push(position);
      return { agentIndex: agentPositions.length };
    }
  };

  manager.createAgent(new Float32Array([10, 4, 20, 1]), {
    preserveSpawn: true
  });
  manager.createAgent(new Float32Array([10, 4, 20, 1]), {
    preserveSpawn: false
  });

  assert.deepEqual(agentPositions, [navPosition, randomPosition]);
});

test("NPC pathfinding publishes a pure navmesh height change", () => {
  const calls: Float32Array[] = [];
  const npc: any = {
    state: { position: new Float32Array([10, 4, 20, 0]) },
    navAgent: {
      interpolatedPosition: { x: 10, y: 4.75, z: 20 }
    },
    goTo(position: Float32Array) {
      calls.push(position);
    }
  };

  makeServer(npc).updatePathfindingPositions();

  assert.equal(calls.length, 1);
  assert.deepEqual(Array.from(calls[0]), [10, 4.75, 20, 0]);
});

test("NPC pathfinding ignores interpolation noise below the movement gate", () => {
  const calls: Float32Array[] = [];
  const npc: any = {
    state: { position: new Float32Array([10, 4, 20, 0]) },
    navAgent: {
      interpolatedPosition: { x: 10, y: 4.00005, z: 20 }
    },
    goTo(position: Float32Array) {
      calls.push(position);
    }
  };

  makeServer(npc).updatePathfindingPositions();

  assert.equal(calls.length, 0);
});

test("NPC pathfinding does not publish residual crowd motion after a stop", () => {
  const calls: Float32Array[] = [];
  const npc: any = {
    state: { position: new Float32Array([10, 4, 20, 0]) },
    isPathfindingMovementSuppressed: true,
    navAgent: {
      interpolatedPosition: { x: 12, y: 4, z: 20 }
    },
    goTo(position: Float32Array) {
      calls.push(position);
    }
  };

  makeServer(npc).updatePathfindingPositions();

  assert.equal(calls.length, 0);
});

test("NPC pathfinding preserves an explicit animal-test height offset", () => {
  const calls: Float32Array[] = [];
  const npc: any = {
    state: { position: new Float32Array([10, 7, 20, 0]) },
    testHarnessVerticalOffset: 3,
    navAgent: {
      interpolatedPosition: { x: 10, y: 4, z: 20 }
    },
    goTo(position: Float32Array) {
      calls.push(position);
    }
  };

  makeServer(npc).updatePathfindingPositions();

  assert.equal(calls.length, 0);
  // The ground sample itself is unchanged; the test-only height offset is
  // re-applied before the replicated state comparison.
  npc.state.position[1] = 4;
  makeServer(npc).updatePathfindingPositions();
  assert.equal(calls.length, 1);
  assert.deepEqual(Array.from(calls[0]), [10, 7, 20, 0]);
});
