import type { ForgelightNavigation } from "./forgelightNavigation";
import { createForgelightStaticGuard, ForgelightStaticGuardOptions } from "./forgelightStaticGuard";

type NavigationSource = Pick<ForgelightNavigation, "scene" | "findRoute" | "destroy">;

export interface ForgelightGuardedRouteOptions extends ForgelightStaticGuardOptions {
  navigation: NavigationSource;
  /** Caller-supplied evidence label, never a substitute for isSegmentCovered. */
  scopeLabel: string;
}

/**
 * Composition only: NAV suggests the next XZ corner; CNK owns actual ground and
 * step length; the existing guard checks the submitted step and melee segment.
 * No default coverage, direct-route fallback, native capsule or world-clearance
 * claim. NAV Y is not a replacement for CNK height (Recast quantizes its surface).
 * Unknown coverage remains denied even when a supplied scene has no hit.
 * Successful construction transfers ownership of this per-encounter navigation;
 * on construction failure the caller retains it. No files, builds or timers here.
 */
export function createForgelightGuardedRoute(options: ForgelightGuardedRouteOptions) {
  const { navigation, terrain, npcOriginHeight, targetOriginHeight } = options;
  if (!navigation || navigation.scene !== options.scene ||
      typeof navigation.findRoute !== "function" || typeof navigation.destroy !== "function" ||
      typeof options.scopeLabel !== "string" || !options.scopeLabel.trim() || options.scopeLabel.length > 160)
    throw new Error("Same-scene navigation and explicit evidence scope required");
  const findRoute = navigation.findRoute.bind(navigation);
  const destroyNavigation = navigation.destroy.bind(navigation);
  const terrainStep = terrain?.testRouteStep;
  if (typeof terrainStep !== "function") throw new Error("CNK route binding required");
  const min = [...options.bounds.min], max = [...options.bounds.max];
  const inBounds = (p: { x: number; y: number; z: number }) =>
    [p.x, p.y, p.z].every((v, i) => Number.isFinite(v) && v >= min[i] && v <= max[i]);
  let disposed = false;
  const routedTerrain = {
    spawnPosition: terrain.spawnPosition.slice(), npcOriginHeight: terrain.npcOriginHeight,
    testRouteStep(from: Float32Array, target: Float32Array, budget: number): Float32Array | undefined {
      if (disposed) return undefined;
      const a = { x: from[0], y: from[1] - npcOriginHeight, z: from[2] };
      const b = { x: target[0], y: target[1] - targetOriginHeight, z: target[2] };
      if (!inBounds(a) || !inBounds(b)) return undefined;
      // The planner gets disposable copies; neither it nor its returned array owns inputs.
      const path = findRoute({ ...a }, { ...b });
      if (!path || path.length < 2 || path.length > 2048 || !path.every(inBounds)) return undefined;
      const first = path[0], last = path[path.length - 1];
      if (Math.hypot(first.x - a.x, first.z - a.z) > 0.001 ||
          Math.hypot(last.x - b.x, last.z - b.z) > 0.05) return undefined;
      // Ignore the planner's vertical rasterization offset at the same XZ.
      const corner = path.find(p => Math.hypot(p.x - a.x, p.z - a.z) > 0.001);
      if (!corner) return undefined;
      const waypoint = new Float32Array([corner.x, from[1], corner.z]);
      const next = terrainStep(from.slice(), waypoint, budget);
      if (!next || next.length < 3 || ![next[0], next[1], next[2]].every(Number.isFinite)) return undefined;
      const dx = waypoint[0] - from[0], dz = waypoint[2] - from[2];
      const nx = next[0] - from[0], nz = next[2] - from[2];
      const distanceSquared = dx * dx + dz * dz;
      // CNK may stop before a surface crossing; it may not cut past the NAV corner.
      if (nx * dx + nz * dz < 0 || nx * dx + nz * dz > distanceSquared + 1e-7 ||
          Math.abs(nx * dz - nz * dx) > 0.001 * Math.sqrt(distanceSquared)) return undefined;
      return next;
    }
  };
  const guard = createForgelightStaticGuard({ ...options, terrain: routedTerrain });
  return {
    scope: Object.freeze({ label: options.scopeLabel, coverage: "caller-certified segments only; not complete-world evidence" }),
    testRouteStep(from: Float32Array, target: Float32Array, budget: number): Float32Array | undefined {
      if (disposed) return undefined;
      const next = guard.testRouteStep(from, target, budget);
      return disposed ? undefined : next;
    },
    testMeleeReachability(from: Float32Array, target: Float32Array): boolean {
      if (disposed) return false;
      const reachable = guard.testMeleeReachability(from, target);
      return !disposed && reachable;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true; // Close queries even if native allocation disposal throws.
      destroyNavigation();
    }
  };
}
