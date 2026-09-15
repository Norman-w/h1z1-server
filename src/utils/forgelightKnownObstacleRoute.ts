import { GeometryBounds, StaticTriangleScene } from "./forgelightGeometry";
import type { ForgelightNavigation } from "./forgelightNavigation";
import type { ForgelightTerrainFollowBinding } from "./forgelightTerrainFollow";

type Point3 = readonly [number, number, number];
type NavPoint = { x: number; y: number; z: number };
type NavigationSource = Pick<ForgelightNavigation, "scene" | "findRoute" | "destroy">;

export interface ForgelightKnownObstacleRouteOptions {
  navigation: NavigationSource;
  terrain: ForgelightTerrainFollowBinding;
  scene: StaticTriangleScene;
  bounds: GeometryBounds;
  /** Exactly the supplied scene's nonempty mesh IDs, never a world-coverage claim. */
  knownObstacleIds: readonly string[];
  scopeLabel: string;
  npcOriginHeight: number;
  targetOriginHeight: number;
  contactHeight: number;
  routeProbeHeights: readonly number[];
  /** Experimental horizontal envelope, NOT recovered native capsule dimensions. */
  entityRadius: number;
  maxPathPoints: number;
  maxPathLength: number;
  /** Default route ownership; caller mode closes this binding but leaves NAV to its explicit owner. */
  navigationOwnership?: "route" | "caller";
}

/**
 * Local experiment against ONLY explicitly named static triangles. Other
 * collision coverage stays unknown, even when a query returns a step/true.
 * NAV proposes XZ; CNK owns Y, actual 3D budget and ground continuity. No
 * isSegmentCovered shortcut, complete-world certificate or straight fallback.
 *
 * Radius screening conservatively expands each triangle's world AABB in X/Z
 * at explicit probe heights. It can over-block angled/concave geometry; it is
 * not a native capsule, full vertical sweep, collision-mask or door policy.
 * Successful construction owns navigation unless navigationOwnership is caller.
 * Caller ownership supports replacing pre-start terrain bindings inside one
 * encounter lifetime, without replacing or repeatedly destroying native NAV.
 * A construction failure leaves ownership with the caller. dispose closes once.
 */
export function createForgelightKnownObstacleRoute(options: ForgelightKnownObstacleRouteOptions) {
  const { navigation, terrain, scene, npcOriginHeight, targetOriginHeight,
    contactHeight, entityRadius, maxPathPoints, maxPathLength } = options;
  const min = Array.from(options.bounds?.min ?? []), max = Array.from(options.bounds?.max ?? []);
  const heights = Array.from(options.routeProbeHeights ?? []);
  const ids = Array.from(options.knownObstacleIds ?? []);
  const ownsNavigation = options.navigationOwnership !== "caller";
  if (!(scene instanceof StaticTriangleScene) || navigation?.scene !== scene ||
      (options.navigationOwnership !== undefined && options.navigationOwnership !== "route" && options.navigationOwnership !== "caller") ||
      typeof navigation.findRoute !== "function" || typeof navigation.destroy !== "function" ||
      typeof terrain?.testRouteStep !== "function" ||
      typeof options.scopeLabel !== "string" || !options.scopeLabel.trim() || options.scopeLabel.length > 160 ||
      min.length !== 3 || max.length !== 3 || min.some((v, i) => !Number.isFinite(v) ||
        !Number.isFinite(max[i]) || max[i] <= v || max[i] - v > 100) ||
      ![npcOriginHeight, targetOriginHeight].every(v => Number.isFinite(v) && Math.abs(v) <= 3) ||
      terrain.npcOriginHeight !== npcOriginHeight || !Number.isFinite(contactHeight) || contactHeight < 0 || contactHeight > 3 ||
      !Number.isFinite(entityRadius) || entityRadius <= 0 || entityRadius > 1.5 ||
      [0, 2].some(i => max[i] - min[i] <= 2 * entityRadius) ||
      heights.length < 1 || heights.length > 16 || !heights.every(v => Number.isFinite(v) && v >= 0 && v <= 3) ||
      !Number.isInteger(maxPathPoints) || maxPathPoints < 2 || maxPathPoints > 2048 ||
      !Number.isFinite(maxPathLength) || maxPathLength <= 0 || maxPathLength > 500 ||
      ids.length < 1 || ids.length > 128 || new Set(ids).size !== ids.length ||
      !ids.every(id => typeof id === "string" && !!id.trim() && id.length <= 256))
    throw new Error("Explicit bounded known-obstacle navigation, identities, radius and probes required");

  const snapshots = scene.snapshotMeshes();
  if (snapshots.length !== ids.length || snapshots.some(entry => !ids.includes(entry.id)))
    throw new Error("Known obstacle IDs must exactly match the supplied scene");
  const boxes: { min: number[]; max: number[] }[] = [];
  let triangles = 0;
  for (const { mesh } of snapshots) {
    const p = mesh.positions;
    for (let i = 0; i < mesh.indices.length; i += 3) {
      if (++triangles > 250000) throw new Error("Known-obstacle triangle budget exceeded");
      const abc = Array.from(mesh.indices.subarray(i, i + 3), index => index * 3);
      const ab = [0, 1, 2].map(k => p[abc[1] + k] - p[abc[0] + k]);
      const ac = [0, 1, 2].map(k => p[abc[2] + k] - p[abc[0] + k]);
      if (Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0]) < 1e-12) continue;
      boxes.push({ min: [0, 1, 2].map(k => Math.min(...abc.map(a => p[a + k])) - (k === 1 ? 1e-6 : entityRadius + 1e-6)),
        max: [0, 1, 2].map(k => Math.max(...abc.map(a => p[a + k])) + (k === 1 ? 1e-6 : entityRadius + 1e-6)) });
    }
  }
  if (!boxes.length) throw new Error("Named obstacles contain no blocking triangles");
  const findRoute = navigation.findRoute.bind(navigation), destroy = navigation.destroy.bind(navigation);
  const terrainStep = terrain.testRouteStep.bind(terrain), intersect = scene.intersectSegment.bind(scene);
  let disposed = false;
  const inBounds = (p: Point3, radius = 0) => p.every((v, i) => Number.isFinite(v) &&
    v >= min[i] + (i === 1 ? 0 : radius) && v <= max[i] - (i === 1 ? 0 : radius));
  const point = (p: Float32Array): Point3 | undefined => {
    if (!p || (p.length !== 3 && p.length !== 4) || !Array.from(p).every(Number.isFinite)) return undefined;
    const wire = new Float32Array([p[0], p[1], p[2]]);
    const result: Point3 = [wire[0], wire[1], wire[2]];
    return inBounds(result, entityRadius) ? result : undefined;
  };
  const ground = (p: Point3, height: number): Point3 => [p[0], p[1] - height, p[2]];
  const raised = (p: Point3, height: number): Point3 => [p[0], p[1] + height, p[2]];
  const navPoint = (p: Point3): NavPoint => ({ x: p[0], y: p[1], z: p[2] });
  const intersectsBox = (a: Point3, b: Point3, box: { min: number[]; max: number[] }) => {
    let enter = 0, leave = 1;
    for (let i = 0; i < 3; i++) {
      const delta = b[i] - a[i];
      if (Math.abs(delta) < 1e-12) { if (a[i] < box.min[i] || a[i] > box.max[i]) return false; }
      else {
        const lo = (box.min[i] - a[i]) / delta, hi = (box.max[i] - a[i]) / delta;
        enter = Math.max(enter, Math.min(lo, hi)); leave = Math.min(leave, Math.max(lo, hi));
        if (enter > leave) return false;
      }
    }
    return true;
  };
  const knownClear = (a: Point3, b: Point3): boolean => !disposed &&
    inBounds(a, entityRadius) && inBounds(b, entityRadius) &&
    intersect(a, b) === undefined && !boxes.some(box => intersectsBox(a, b, box));
  const pathTo = (a: Point3, b: Point3): NavPoint[] | undefined => {
    if (disposed || !inBounds(a, entityRadius) || !inBounds(b, entityRadius)) return undefined;
    const result = findRoute(navPoint(a), navPoint(b));
    if (disposed || !Array.isArray(result) || result.length < 2 || result.length > maxPathPoints) return undefined;
    const path = result.map(p => ({ x: p?.x, y: p?.y, z: p?.z }));
    if (!path.every(p => inBounds([p.x, p.y, p.z], entityRadius))) return undefined;
    const first = path[0], last = path[path.length - 1];
    if (Math.hypot(first.x - a[0], first.z - a[2]) > 0.001 ||
        Math.hypot(last.x - b[0], last.z - b[2]) > 0.05) return undefined;
    let length = 0;
    for (let i = 1; i < path.length; i++) {
      length += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y, path[i].z - path[i - 1].z);
      if (!Number.isFinite(length) || length > maxPathLength) return undefined;
    }
    return path;
  };
  const spawn = point(terrain.spawnPosition);
  if (!spawn || !inBounds(ground(spawn, npcOriginHeight), entityRadius))
    throw new Error("CNK spawn lies outside the explicit experiment envelope");

  return {
    scope: Object.freeze({ mode: "only-known-obstacles" as const, label: options.scopeLabel,
      knownObstacleIds: Object.freeze([...ids]), otherCollisionCoverage: "unknown" as const,
      entityRadius, radiusModel: "horizontal inflated triangle AABBs at explicit probe heights; not native capsule",
      bounds: Object.freeze({ min: Object.freeze([...min]), max: Object.freeze([...max]) }),
      routeProbeHeights: Object.freeze([...heights]), contactHeight, maxPathPoints, maxPathLength }),
    testRouteStep(from: Float32Array, target: Float32Array, budget: number): Float32Array | undefined {
      try {
        if (disposed || !Number.isFinite(budget) || budget <= 0) return undefined;
        const a = point(from), b = point(target);
        if (!a || !b) return undefined;
        const aGround = ground(a, npcOriginHeight), bGround = ground(b, targetOriginHeight);
        const path = pathTo(aGround, bGround);
        if (!path) return undefined;
        const corner = path.find(p => Math.hypot(p.x - a[0], p.z - a[2]) > 0.001);
        if (!corner) return undefined;
        const waypoint = new Float32Array([corner.x, a[1], corner.z]);
        const next = terrainStep(new Float32Array(a), waypoint, budget);
        if (disposed || !next) return undefined;
        const c = point(next);
        if (!c || Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]) > budget) return undefined;
        const dx = waypoint[0] - a[0], dz = waypoint[2] - a[2], nx = c[0] - a[0], nz = c[2] - a[2];
        const squared = dx * dx + dz * dz;
        if (squared === 0 || Math.hypot(nx, nz) < 1e-7 || nx * dx + nz * dz < 0 ||
            nx * dx + nz * dz > squared + 1e-7 || Math.abs(nx * dz - nz * dx) > 0.001 * Math.sqrt(squared)) return undefined;
        const cGround = ground(c, npcOriginHeight);
        if (!inBounds(cGround, entityRadius)) return undefined;
        for (const height of heights) if (!knownClear(raised(aGround, height), raised(cGround, height))) return undefined;
        return disposed ? undefined : new Float32Array(c);
      } catch { return undefined; }
    },
    /** True means only that these named obstacles did not block this probe. */
    testMeleeReachability(from: Float32Array, target: Float32Array): boolean {
      try {
        if (disposed) return false;
        const a = point(from), b = point(target);
        if (!a || !b) return false;
        const aGround = ground(a, npcOriginHeight), bGround = ground(b, targetOriginHeight);
        if (!pathTo(aGround, bGround)) return false;
        return knownClear(raised(aGround, contactHeight), raised(bGround, contactHeight)) && !disposed;
      } catch { return false; }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (ownsNavigation) destroy();
    }
  };
}
