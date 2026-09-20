import { GeometryBounds, StaticTriangleScene } from "./forgelightGeometry";
import type { ForgelightTerrainFollowBinding } from "./forgelightTerrainFollow";

type Point3 = readonly [number, number, number];

export interface ForgelightStaticGuardOptions {
  terrain: ForgelightTerrainFollowBinding;
  scene: StaticTriangleScene;
  bounds: GeometryBounds;
  /**
   * Caller must independently establish complete TERRAIN AND STATIC coverage
   * for the entire closed segment, not just its endpoints. There is no default
   * true: missing/unsupported assets cannot be silently treated as clear space.
   */
  isSegmentCovered: (from: Point3, to: Point3) => boolean | undefined;
  /** Explicit experimental network-origin offsets, not native body dimensions. */
  npcOriginHeight: number;
  targetOriginHeight: number;
  contactHeight: number;
  /** Explicit heights above terrain; segment probes are not a capsule sweep. */
  routeProbeHeights: readonly number[];
}

/**
 * Stop-only guard for one explicitly covered immutable local static snapshot.
 * No NAV, detours, dynamic doors, native collision masks or godMode semantics.
 * The caller owns coverage; a terrain step is never proof of a complete segment.
 * Not wired into live spawning: global unsupported-scene coverage is unresolved.
 */
export function createForgelightStaticGuard(options: ForgelightStaticGuardOptions) {
  const { terrain, scene, isSegmentCovered, npcOriginHeight,
    targetOriginHeight, contactHeight } = options;
  const min = Array.from(options.bounds?.min ?? []);
  const max = Array.from(options.bounds?.max ?? []);
  const heights = Array.from(options.routeProbeHeights ?? []);
  if (!(scene instanceof StaticTriangleScene) ||
      typeof terrain?.testRouteStep !== "function" ||
      typeof isSegmentCovered !== "function" ||
      min.length !== 3 || max.length !== 3 ||
      min.some((value, i) => !Number.isFinite(value) || !Number.isFinite(max[i]) || value >= max[i]) ||
      ![npcOriginHeight, targetOriginHeight].every(value => Number.isFinite(value) && Math.abs(value) <= 3) ||
      terrain.npcOriginHeight !== npcOriginHeight ||
      !Number.isFinite(contactHeight) || contactHeight < 0 || contactHeight > 3 ||
      heights.length < 1 || heights.length > 16 ||
      !heights.every(value => Number.isFinite(value) && value >= 0 && value <= 3))
    throw new Error("Explicit valid static-guard bounds, coverage and heights required");
  const terrainStep = terrain.testRouteStep;
  const intersect = scene.intersectSegment.bind(scene);
  const inBounds = (point: Point3): boolean => point.every((value, i) =>
    Number.isFinite(value) && value >= min[i] && value <= max[i]);
  const point = (value: Float32Array): Point3 | undefined => {
    if (!value || (value.length !== 3 && value.length !== 4) ||
        !Array.from(value).every(Number.isFinite)) return undefined;
    if (!inBounds([value[0], value[1], value[2]])) return undefined;
    // Validate the actual network-coordinate precision before scene queries.
    const wire = new Float32Array([value[0], value[1], value[2]]);
    const result: Point3 = [wire[0], wire[1], wire[2]];
    return inBounds(result) ? result : undefined;
  };
  const ground = (value: Point3, originHeight: number): Point3 =>
    [value[0], value[1] - originHeight, value[2]];
  const raised = (value: Point3, height: number): Point3 =>
    [value[0], value[1] + height, value[2]];
  const covered = (from: Point3, to: Point3): boolean =>
    inBounds(from) && inBounds(to) &&
    isSegmentCovered(Object.freeze([...from]) as Point3, Object.freeze([...to]) as Point3) === true;
  const clear = (from: Point3, to: Point3): boolean =>
    covered(from, to) && intersect(from, to) === undefined;

  return {
    testRouteStep(from: Float32Array, target: Float32Array, budget: number): Float32Array | undefined {
      try {
        if (!Number.isFinite(budget) || budget <= 0) return undefined;
        const a = point(from), b = point(target);
        if (!a || !b) return undefined;
        const next = terrainStep(new Float32Array(a), new Float32Array(b), budget);
        if (!next) return undefined;
        const c = point(next);
        if (!c || Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]) > budget)
          return undefined;
        const aGround = ground(a, npcOriginHeight), cGround = ground(c, npcOriginHeight);
        const bGround = ground(b, targetOriginHeight);
        if (!covered(aGround, cGround) || !covered(bGround, bGround)) return undefined;
        for (const height of heights)
          if (!clear(raised(aGround, height), raised(cGround, height))) return undefined;
        return new Float32Array(c);
      } catch { return undefined; }
    },

    testMeleeReachability(from: Float32Array, target: Float32Array): boolean {
      try {
        const a = point(from), b = point(target);
        if (!a || !b) return false;
        const aGround = ground(a, npcOriginHeight), bGround = ground(b, targetOriginHeight);
        // Complete ground/contact coverage is separate from terrainStep. The
        // same closure is usable at attack start and again at delayed hit time.
        return covered(aGround, bGround) &&
          clear(raised(aGround, contactHeight), raised(bGround, contactHeight));
      } catch { return false; }
    }
  };
}
