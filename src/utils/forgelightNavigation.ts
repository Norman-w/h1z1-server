import { init, NavMesh, NavMeshQuery, Vector3 } from "recast-navigation";
import { generateSoloNavMesh } from "recast-navigation/generators";
import {
  GeometryBounds,
  StaticTriangleScene,
  TriangleMesh
} from "./forgelightGeometry";

/** Experimental body envelope, not recovered native NPC capsule dimensions. */
const config = Object.freeze({
  cs: 0.15,
  ch: 0.1,
  walkableHeight: 18,
  walkableRadius: 3,
  walkableClimb: 3,
  walkableSlopeAngle: 45,
  minRegionArea: 0,
  mergeRegionArea: 0,
  maxSimplificationError: 0.5
});

/**
 * Local, supplied-geometry-only navigation. Build outside the AI tick.
 * No file loading, global nav replacement, NPC origin offset or dynamic-door
 * policy is implied. Callers must explicitly establish those independently.
 */
export class ForgelightNavigation {
  private readonly query: NavMeshQuery;
  private disposed = false;

  private constructor(
    private readonly navMesh: NavMesh,
    private readonly bounds: GeometryBounds,
    readonly scene: StaticTriangleScene
  ) {
    this.query = new NavMeshQuery(navMesh);
  }

  static async build(
    terrain: TriangleMesh,
    scene: StaticTriangleScene,
    requestedBounds: GeometryBounds
  ): Promise<ForgelightNavigation> {
    const bounds: GeometryBounds = {
      min: [...requestedBounds.min],
      max: [...requestedBounds.max]
    };
    for (let k = 0; k < 3; k++) {
      const extent = bounds.max[k] - bounds.min[k];
      if (
        !Number.isFinite(bounds.min[k]) ||
        !Number.isFinite(bounds.max[k]) ||
        extent <= 0 ||
        extent > 100
      )
        throw new Error("Invalid or excessive local navigation bounds");
    }
    // Validates and snapshots the terrain just as rigorously as static colliders.
    const ground = new StaticTriangleScene([
      { id: "terrain", mesh: terrain }
    ]).snapshotMeshes()[0]?.mesh;
    if (!ground) throw new Error("Navigation terrain is empty");
    const positions: number[] = [],
      indices: number[] = [];
    let terrainTriangles = 0;
    for (const mesh of [
      ground,
      ...scene.snapshotMeshes().map((entry) => entry.mesh)
    ]) {
      const p = mesh.positions;
      for (let i = 0; i < mesh.indices.length; i += 3) {
        const abc = Array.from(mesh.indices.slice(i, i + 3), (v) => v * 3);
        if (
          [0, 1, 2].some(
            (k) =>
              Math.max(...abc.map((a) => p[a + k])) < bounds.min[k] ||
              Math.min(...abc.map((a) => p[a + k])) > bounds.max[k]
          )
        )
          continue;
        if (mesh === ground) {
          const [a, b, c] = abc;
          const normalY =
            (p[b + 2] - p[a + 2]) * (p[c] - p[a]) -
            (p[b] - p[a]) * (p[c + 2] - p[a + 2]);
          if (normalY < 0) abc.reverse();
          if (normalY !== 0) terrainTriangles++;
        }
        if (indices.length / 3 >= 250000)
          throw new Error("Local navigation triangle budget exceeded");
        // Current generator uses indices.length as vertex count. Triangle soup
        // makes it correct without altering the installed dependency.
        for (const v of abc) {
          indices.push(indices.length);
          positions.push(p[v], p[v + 1], p[v + 2]);
        }
      }
    }
    if (!terrainTriangles) throw new Error("No terrain in navigation bounds");
    await init();
    const result = generateSoloNavMesh(positions, indices, {
      ...config,
      bounds: [bounds.min, bounds.max]
    });
    if (!result.success)
      throw new Error(`Local navigation build failed: ${result.error}`);
    try {
      return new ForgelightNavigation(result.navMesh, bounds, scene);
    } catch (error) {
      result.navMesh.destroy();
      throw error;
    }
  }

  private inBounds(point: Vector3): boolean {
    return [point.x, point.y, point.z].every(
      (v, k) =>
        Number.isFinite(v) && v >= this.bounds.min[k] && v <= this.bounds.max[k]
    );
  }

  /** Ground positions, not network entity origins. Never returns a partial route. */
  findRoute(start: Vector3, end: Vector3): Vector3[] | undefined {
    if (this.disposed) throw new Error("Local navigation is disposed");
    if (!this.inBounds(start) || !this.inBounds(end)) return undefined;
    const nearest = [start, end].map((point) =>
      this.query.findClosestPoint(point, {
        halfExtents: { x: 0.5, y: 1, z: 0.5 }
      })
    );
    if (
      nearest.some(
        (r, i) =>
          !r.success ||
          !r.polyRef ||
          // Detour can report false exactly on a polygon edge while returning
          // the identical Float32 XZ. Allow only 1mm of horizontal roundoff,
          // never the ordinary 0.5m nearest-poly search distance.
          (!r.isPointOverPoly &&
            Math.hypot(
              r.point.x - [start, end][i].x,
              r.point.z - [start, end][i].z
            ) > 0.001) ||
          Math.abs(r.point.y - [start, end][i].y) > 1
      )
    )
      return undefined;
    const [a, b] = nearest;
    const corridor = this.query.findPath(
      a.polyRef,
      b.polyRef,
      a.point,
      b.point,
      {
        maxPathPolys: 2048
      }
    );
    try {
      // Detour success can include partial/truncated paths: require the end polygon.
      if (
        !corridor.success ||
        !corridor.polys.size ||
        corridor.polys.get(corridor.polys.size - 1) !== b.polyRef
      )
        return undefined;
      const straight = this.query.findStraightPath(
        a.point,
        b.point,
        corridor.polys,
        {
          maxStraightPathPoints: 2048,
          straightPathOptions: 2 // retain surface polygon crossings on sloping ground
        }
      );
      try {
        if (!straight.success || !straight.straightPathCount) return undefined;
        const points: Vector3[] = [];
        for (let i = 0; i < straight.straightPathCount; i++) {
          const point = {
            x: straight.straightPath.get(i * 3),
            y: straight.straightPath.get(i * 3 + 1),
            z: straight.straightPath.get(i * 3 + 2)
          };
          if (!this.inBounds(point)) return undefined;
          points.push(point);
        }
        const last = points[points.length - 1];
        if (
          Math.hypot(
            last.x - b.point.x,
            last.y - b.point.y,
            last.z - b.point.z
          ) > 0.05
        )
          return undefined;
        for (let i = 1; i < points.length; i++) {
          const from = points[i - 1],
            to = points[i];
          for (const height of [0.3, 1, 1.6]) {
            if (
              this.scene.intersectSegment(
                [from.x, from.y + height, from.z],
                [to.x, to.y + height, to.z]
              )
            )
              return undefined;
          }
        }
        return points;
      } finally {
        straight.straightPath.destroy();
        straight.straightPathFlags.destroy();
        straight.straightPathRefs.destroy();
      }
    } finally {
      corridor.polys.destroy();
    }
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.query.destroy();
    this.navMesh.destroy();
  }
}

/**
 * Bind explicit experimental NETWORK-origin offsets to one supplied navigation.
 * Caller owns nav lifetime and coverage. No default offsets: native character
 * feet/contact heights have not been recovered. No disk/world mutation here.
 */
export function createForgelightRouteBinding(
  navigation: ForgelightNavigation,
  npcOriginHeight: number,
  targetOriginHeight: number,
  contactHeight: number
) {
  if (
    ![npcOriginHeight, targetOriginHeight, contactHeight].every(
      (v) => Number.isFinite(v) && v >= 0 && v <= 3
    )
  )
    throw new Error("Explicit valid origin/contact heights required");
  const ground = (position: Float32Array, height: number): Vector3 => {
    if (
      position.length < 3 ||
      ![position[0], position[1], position[2]].every(Number.isFinite)
    )
      throw new Error("Invalid encounter position");
    return { x: position[0], y: position[1] - height, z: position[2] };
  };
  return {
    testServerDrivenMovement: true,
    clientDrivenSeek: false,
    skipNavAgent: true,
    testMeleeReachability(from: Float32Array, to: Float32Array): boolean {
      const a = ground(from, npcOriginHeight),
        b = ground(to, targetOriginHeight);
      // Requiring a valid local route prevents interpreting missing coverage as clear.
      if (!navigation.findRoute(a, b)) return false;
      return !navigation.scene.intersectSegment(
        [a.x, a.y + contactHeight, a.z],
        [b.x, b.y + contactHeight, b.z]
      );
    },
    testRouteStep(
      from: Float32Array,
      to: Float32Array,
      budget: number
    ): Float32Array | undefined {
      if (!Number.isFinite(budget) || budget <= 0) return undefined;
      const a = ground(from, npcOriginHeight),
        b = ground(to, targetOriginHeight);
      const path = navigation.findRoute(a, b);
      if (!path) return undefined;
      // Stop at the next corner/crossing even if budget remains. Sending only an
      // endpoint beyond a corner would make client interpolation cut the corner.
      const next = path.find(
        (p) => Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z) > 0.001
      );
      if (!next) return undefined;
      const length = Math.hypot(next.x - a.x, next.y - a.y, next.z - a.z);
      const fraction = Math.min(1, budget / length);
      const p = {
        x: a.x + (next.x - a.x) * fraction,
        y: a.y + (next.y - a.y) * fraction,
        z: a.z + (next.z - a.z) * fraction
      };
      for (const height of [0.3, 1, 1.6]) {
        if (
          navigation.scene.intersectSegment(
            [a.x, a.y + height, a.z],
            [p.x, p.y + height, p.z]
          )
        )
          return undefined;
      }
      return new Float32Array([p.x, p.y + npcOriginHeight, p.z]);
    }
  };
}
