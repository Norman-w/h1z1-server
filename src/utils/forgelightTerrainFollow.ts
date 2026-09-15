import {
  StaticTriangleScene,
  surfaceHeights,
  TriangleMesh
} from "./forgelightGeometry";

export interface ForgelightTerrainFollowOptions {
  terrain: TriangleMesh | readonly TriangleMesh[];
  standingPlayerPosition: ArrayLike<number>;
  spawnXZ: readonly [number, number];
  /** Explicit experimental difference, not a recovered native origin offset. */
  npcVsPlayerOriginDelta: number;
  maxSlopeDegrees?: number;
  maxSampleDistance?: number;
}

export interface ForgelightTerrainFollowBinding {
  spawnPosition: Float32Array;
  npcOriginHeight: number;
  testRouteStep(
    from: Float32Array,
    target: Float32Array,
    budget: number
  ): Float32Array | undefined;
}

type Point = readonly [number, number];
interface Triangle {
  mesh: TriangleMesh;
  corners: Point[];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  slope: number;
}

// Network positions are Float32. Permit submillimetre edge/origin rounding,
// never an ordinary navigation search radius or a guessed replacement surface.
const HEIGHT_EPSILON = 0.001;
const EDGE_EPSILON = 0.001;
// Bound only the new full-chord optimization; denser geometry keeps the old step.
const MAX_MERGED_CROSSINGS = 64;
const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0];

/**
 * Terrain-only experimental following of explicitly supplied decoded meshes.
 * No static/dynamic obstruction, pathfinding, asset loading or native origin
 * claim. Caller must supply a standing player sample and own coverage policy.
 * The owned mesh snapshot and origin calibration never follow later player Y.
 */
export function createForgelightTerrainFollowBinding(
  options: ForgelightTerrainFollowOptions
): ForgelightTerrainFollowBinding | undefined {
  const {
    standingPlayerPosition: player,
    spawnXZ,
    npcVsPlayerOriginDelta
  } = options;
  const maxSlopeDegrees = options.maxSlopeDegrees ?? 45;
  const maxSampleDistance = options.maxSampleDistance ?? 0.25;
  if (
    player.length < 3 ||
    ![player[0], player[1], player[2], ...spawnXZ].every(Number.isFinite) ||
    spawnXZ.length !== 2 ||
    !Number.isFinite(npcVsPlayerOriginDelta) ||
    Math.abs(npcVsPlayerOriginDelta) > 3 ||
    !Number.isFinite(maxSlopeDegrees) ||
    maxSlopeDegrees <= 0 ||
    maxSlopeDegrees >= 90 ||
    !Number.isFinite(maxSampleDistance) ||
    maxSampleDistance <= 0 ||
    maxSampleDistance > 1
  )
    throw new Error("Invalid explicit terrain-follow parameters");
  const input = Array.isArray(options.terrain)
    ? options.terrain
    : [options.terrain as TriangleMesh];
  if (
    input.reduce((count, mesh) => count + mesh.indices.length / 3, 0) > 250000
  )
    throw new Error("Terrain-follow triangle budget exceeded");
  const meshes = new StaticTriangleScene(
    input.map((mesh, i) => ({ id: String(i), mesh }))
  ).snapshotMeshes();
  const triangles: Triangle[] = [];
  for (const { mesh } of meshes) {
    const p = mesh.positions;
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const [a, b, c] = Array.from(
        mesh.indices.subarray(i, i + 3),
        (v) => v * 3
      );
      const ab = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
      const ac = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
      const normal = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0]
      ];
      const corners: Point[] = [a, b, c].map((v) => [p[v], p[v + 2]] as const);
      triangles.push({
        mesh: { positions: p, indices: mesh.indices.subarray(i, i + 3) },
        corners,
        minX: Math.min(...corners.map((v) => v[0])),
        maxX: Math.max(...corners.map((v) => v[0])),
        minZ: Math.min(...corners.map((v) => v[1])),
        maxZ: Math.max(...corners.map((v) => v[1])),
        slope: Math.hypot(normal[0], normal[2]) / Math.abs(normal[1])
      });
    }
  }
  const maxSlope = Math.tan((maxSlopeDegrees * Math.PI) / 180);
  const heightAt = (x: number, z: number): number | undefined => {
    let result: number | undefined;
    for (const triangle of triangles) {
      if (
        x < triangle.minX - 1e-8 ||
        x > triangle.maxX + 1e-8 ||
        z < triangle.minZ - 1e-8 ||
        z > triangle.maxZ + 1e-8
      )
        continue;
      const heights = surfaceHeights(triangle.mesh, x, z);
      for (const height of heights) {
        if (triangle.slope > maxSlope + 1e-8 || !Number.isFinite(height))
          return undefined;
        // Duplicate seam triangles are one surface; distinct layers are unknown.
        if (result !== undefined && Math.abs(height - result) > 1e-6)
          return undefined;
        result = height;
      }
    }
    return result;
  };
  const playerGround = heightAt(player[0], player[2]);
  const wireSpawnXZ = new Float32Array(spawnXZ);
  const spawnGround = heightAt(wireSpawnXZ[0], wireSpawnXZ[1]);
  if (playerGround === undefined || spawnGround === undefined) return undefined;
  const npcOriginHeight = player[1] - playerGround + npcVsPlayerOriginDelta;
  if (!Number.isFinite(npcOriginHeight) || Math.abs(npcOriginHeight) > 3)
    return undefined;
  const spawnPosition = new Float32Array([
    wireSpawnXZ[0],
    spawnGround + npcOriginHeight,
    wireSpawnXZ[1]
  ]);

  return {
    spawnPosition,
    npcOriginHeight,
    testRouteStep(from, target, budget) {
      if (
        from.length < 3 ||
        target.length < 3 ||
        ![
          from[0],
          from[1],
          from[2],
          target[0],
          target[1],
          target[2],
          budget
        ].every(Number.isFinite) ||
        budget <= 0
      )
        return undefined;
      const startGround = heightAt(from[0], from[2]);
      // Do not teleport a stale/foreign origin back onto this terrain binding.
      if (
        startGround === undefined ||
        Math.abs(from[1] - startGround - npcOriginHeight) > HEIGHT_EPSILON
      )
        return undefined;
      if (heightAt(target[0], target[2]) === undefined) return undefined;
      const dx = target[0] - from[0],
        dz = target[2] - from[2];
      const distance = Math.hypot(dx, dz);
      if (distance < 1e-7) return undefined;
      const horizontal = Math.min(distance, budget, maxSampleDistance);
      const direction: Point = [
        (dx / distance) * horizontal,
        (dz / distance) * horizontal
      ];
      const start: Point = [from[0], from[2]];
      const crossings = [0, 1];
      for (const triangle of triangles) {
        if (
          Math.max(start[0], start[0] + direction[0]) < triangle.minX ||
          Math.min(start[0], start[0] + direction[0]) > triangle.maxX ||
          Math.max(start[1], start[1] + direction[1]) < triangle.minZ ||
          Math.min(start[1], start[1] + direction[1]) > triangle.maxZ
        )
          continue;
        for (let i = 0; i < 3; i++) {
          const a = triangle.corners[i],
            b = triangle.corners[(i + 1) % 3];
          const edge: Point = [b[0] - a[0], b[1] - a[1]],
            offset: Point = [a[0] - start[0], a[1] - start[1]];
          const denominator = cross(direction, edge);
          if (Math.abs(denominator) > 1e-12) {
            const t = cross(offset, edge) / denominator,
              u = cross(offset, direction) / denominator;
            if (t > 0 && t < 1 && u >= -1e-8 && u <= 1 + 1e-8)
              crossings.push(t);
          } else if (Math.abs(cross(offset, direction)) < 1e-10) {
            for (const corner of [a, b]) {
              const t =
                ((corner[0] - start[0]) * direction[0] +
                  (corner[1] - start[1]) * direction[1]) /
                (horizontal * horizontal);
              if (t > 0 && t < 1) crossings.push(t);
            }
          }
        }
      }
      crossings.sort((a, b) => a - b);
      const firstEnd =
        crossings.find((t) => t * horizontal > EDGE_EPSILON) ?? 1;
      const groundAlongChord = (end: number): number | undefined => {
        const endGround = heightAt(
          start[0] + direction[0] * end,
          start[1] + direction[1] * end
        );
        if (endGround === undefined) return undefined;
        const checkpoints = [
          0,
          ...crossings.filter((t) => t > 0 && t < end),
          end
        ];
        for (let i = 1; i < checkpoints.length; i++) {
          for (const t of [
            checkpoints[i],
            (checkpoints[i - 1] + checkpoints[i]) / 2
          ]) {
            const y = heightAt(
              start[0] + direction[0] * t,
              start[1] + direction[1] * t
            );
            if (
              y === undefined ||
              Math.abs(
                y - (startGround + ((endGround - startGround) * t) / end)
              ) > HEIGHT_EPSILON
            )
              return undefined;
          }
        }
        return endGround;
      };
      // Triangle boundaries alone must not consume a movement tick. Cross them
      // only after the entire proposed chord passes the same surface checks.
      // A bend/unknown interval retains the original first-crossing fallback;
      // Limit the added height queries even for densely overlapping triangles;
      // at most two profiles are checked, never a candidate-search loop.
      let end = crossings.length <= MAX_MERGED_CROSSINGS ? 1 : firstEnd;
      let endGround = groundAlongChord(end);
      if (endGround === undefined && end !== firstEnd) {
        end = firstEnd;
        endGround = groundAlongChord(end);
      }
      if (endGround === undefined) return undefined;
      const dy = endGround + npcOriginHeight - from[1];
      const length = Math.hypot(horizontal * end, dy);
      let fraction = Math.min(1, budget / length);
      // Quantizing to the actual wire coordinate type can slightly increase a
      // step. Shorten a few ulps instead of claiming an over-budget endpoint.
      for (let attempt = 0; attempt < 8; attempt++) {
        const next = new Float32Array([
          start[0] + direction[0] * end * fraction,
          from[1] + dy * fraction,
          start[1] + direction[1] * end * fraction
        ]);
        const actual = Math.hypot(
          next[0] - from[0],
          next[1] - from[1],
          next[2] - from[2]
        );
        if (actual <= budget) {
          const ground = heightAt(next[0], next[2]);
          if (
            actual < 1e-7 ||
            ground === undefined ||
            Math.abs(next[1] - ground - npcOriginHeight) > HEIGHT_EPSILON
          )
            return undefined;
          return next;
        }
        fraction *= (budget / actual) * (1 - 1e-5 * (attempt + 1));
      }
      return undefined;
    }
  };
}
