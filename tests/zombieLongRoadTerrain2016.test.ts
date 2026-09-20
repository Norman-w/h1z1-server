import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadForgelightTerrainCorridor, terrainCorridorChunks } from "../src/utils/forgelightTerrainAssets";
import { createForgelightTerrainFollowBinding } from "../src/utils/forgelightTerrainFollow";
import { surfaceHeights } from "../src/utils/forgelightGeometry";

// Preparation evidence only: the fixed H2/I server position is converted to
// Float32 as in spawn. This does not simulate the client, static obstacles,
// world-foot contacts, AI attacks, network acceptance, or native origin units.
const assets = process.env.FORGELIGHT_LONG_ROAD_ASSETS;
const decoder = process.env.FORGELIGHT_LONG_ROAD_DECODER;
const player = new Float32Array([1352.76, 41.8, -715.98]);
const chunkName = "Z1_-12_20.cnk0";
const chunkSha = "6e77987789e31d860aad29ab1274fbf3b2f6199da927a0b5564d6b1883330a8d";
const xyzDistance = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
const wireXZ = (p: ArrayLike<number>) => [Math.round(p[0] * 100) / 100, Math.round(p[2] * 100) / 100];

test("fixed H2/I road supports both 6m and 12m terrain-only approaches with bounded variable-dt steps", {
  skip: !(assets && decoder)
}, async () => {
  assert.equal(createHash("sha256").update(readFileSync(resolve(assets!, chunkName))).digest("hex"), chunkSha);
  const records: { distance: number; steps: number; pathXZ: number; elapsedMs: number; [key: string]: unknown }[] = [];
  for (const distance of [6, 12]) {
    // Recorded rotation [0,0,0,1] is forward +Z in the current spawn helper.
    const spawnXZ = new Float32Array([player[0], player[2] + distance]);
    assert.deepEqual(terrainCorridorChunks([player[0], player[2]], [spawnXZ[0], spawnXZ[1]]).map(c => c.name), [chunkName]);
    const terrain = await loadForgelightTerrainCorridor(assets!, decoder!, [player[0], player[2]], [spawnXZ[0], spawnXZ[1]]);
    const binding = createForgelightTerrainFollowBinding({
      terrain, standingPlayerPosition: player, spawnXZ: [spawnXZ[0], spawnXZ[1]], npcVsPlayerOriginDelta: 0
    });
    assert.ok(binding, `unambiguous ${distance}m player and spawn terrain`);
    assert.ok(Math.abs(binding.npcOriginHeight) <= 0.15, "same experimental grounded readiness threshold");
    let from = binding.spawnPosition;
    let steps = 0, pathXZ = 0, elapsedMs = 0, minimumY = from[1], maximumY = from[1];
    const intervals = [72, 100, 99, 106, 115, 103];
    while (xyzDistance(from, player) > 2.4 && steps < 100) {
      const dt = intervals[steps % intervals.length];
      const budget = Math.min(0.25, 2.5 * dt / 1000);
      const next = binding.testRouteStep(from, player, budget);
      assert.ok(next, `${distance}m route stopped at step ${steps}: ${Array.from(from)}`);
      assert.ok(xyzDistance(from, next) <= budget, "raw 3D bound is unchanged");
      assert.ok(xyzDistance(next, player) < xyzDistance(from, player), "approach makes progress");
      for (let j = 0; j <= 4; j++) {
        const p = Array.from(from, (value, axis) => value + (next[axis] - value) * j / 4);
        const heights = terrain.flatMap(mesh => surfaceHeights(mesh, p[0], p[2]));
        assert.ok(heights.length > 0);
        assert.ok(heights.every(y => Math.abs(p[1] - y - binding.npcOriginHeight) < 0.001), "segment follows the decoded terrain");
      }
      const previousWire = wireXZ(from), nextWire = wireXZ(next);
      const wireSpeed = Math.hypot(nextWire[0] - previousWire[0], nextWire[1] - previousWire[1]) / (dt / 1000);
      assert.ok(wireSpeed <= 2.5 + Math.SQRT2 * 0.01 / (dt / 1000) + 1e-8, "include endpoint-grid rounding, not exact speed equality");
      pathXZ += Math.hypot(next[0] - from[0], next[2] - from[2]);
      minimumY = Math.min(minimumY, next[1]); maximumY = Math.max(maximumY, next[1]);
      from = next; steps++; elapsedMs += dt;
    }
    assert.ok(xyzDistance(from, player) <= 2.4, "the bounded approach reaches the geometric stopping distance");
    records.push({ distance, spawn: Array.from(binding.spawnPosition), npcOriginHeight: binding.npcOriginHeight,
      steps, pathXZ, elapsedMs, minimumY, maximumY, endpoint: Array.from(from), endpointDistance: xyzDistance(from, player) });
  }
  assert.equal(records.length, 2);
  assert.ok(records[1].steps > records[0].steps, "12m adds terrain steps available for observation");
  assert.ok(records[1].elapsedMs > records[0].elapsedMs, "12m extends this prescribed-dt simulation only");
  assert.ok(Math.abs(records[1].pathXZ - records[0].pathXZ - 6) < 0.01, "longer route adds the expected XZ distance");
  console.log(JSON.stringify({ event: "long_road_terrain_preparation", scope: "offline fixed terrain only; not an actual game trial", chunkName, chunkSha, player: Array.from(player), records }));
});
