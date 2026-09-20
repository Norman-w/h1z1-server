import assert from "node:assert/strict";
import test from "node:test";
import { StaticTriangleScene, TriangleMesh } from "../src/utils/forgelightGeometry";
import { ForgelightNavigation } from "../src/utils/forgelightNavigation";
import { createForgelightTerrainFollowBinding } from "../src/utils/forgelightTerrainFollow";
import { createForgelightKnownObstacleRoute, ForgelightKnownObstacleRouteOptions } from "../src/utils/forgelightKnownObstacleRoute";

const pos = (x: number, y: number, z: number) => new Float32Array([x, y, z]);
const flat = (slope = 0): TriangleMesh => ({
  positions: new Float32Array([-8, -8 * slope, -8, 8, -8 * slope, -8, 8, 8 * slope, 8, -8, 8 * slope, 8]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3])
});
const wall = (x = 0): TriangleMesh => ({
  positions: new Float32Array([x - 1, 0, 0, x + 1, 0, 0, x + 1, 3, 0, x - 1, 3, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3])
});
function fixture(blocked = false, slope = 0) {
  const from = pos(0, -2 * slope - 0.05, -2), target = pos(0, 2 * slope - 0.05, 2);
  const terrain = createForgelightTerrainFollowBinding({ terrain: flat(slope), standingPlayerPosition: from,
    spawnXZ: [0, -2], npcVsPlayerOriginDelta: 0 })!;
  assert.ok(terrain);
  const scene = new StaticTriangleScene([{ id: "known-fixture-fence", mesh: wall(blocked ? 0 : 5) }]);
  let destroyed = 0;
  const calls: unknown[] = [];
  const navigation = { scene,
    findRoute(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
      calls.push([a, b]); return [a, b];
    }, destroy() { destroyed++; }
  };
  const options: ForgelightKnownObstacleRouteOptions = { navigation, terrain, scene,
    bounds: { min: [-8, -3, -8], max: [8, 6, 8] }, knownObstacleIds: ["known-fixture-fence"],
    scopeLabel: "Named synthetic fence only; all other collision unknown", npcOriginHeight: terrain.npcOriginHeight,
    targetOriginHeight: terrain.npcOriginHeight, contactHeight: 1, routeProbeHeights: [0.3, 1, 1.6],
    entityRadius: 0.3, maxPathPoints: 128, maxPathLength: 50 };
  return { options, from, target, terrain, navigation, scene, calls, destroyed: () => destroyed };
}

test("scope remains only-known-obstacles even on a successful clear query", () => {
  const s = fixture(), route = createForgelightKnownObstacleRoute(s.options);
  assert.equal(route.scope.mode, "only-known-obstacles"); assert.equal(route.scope.otherCollisionCoverage, "unknown");
  assert.equal(route.scope.entityRadius, 0.3); assert.ok(Object.isFrozen(route.scope.knownObstacleIds));
  assert.ok(route.testRouteStep(s.from, s.target, 0.2)); assert.equal(route.testMeleeReachability(s.from, s.target), true);
  assert.equal(route.scope.otherCollisionCoverage, "unknown"); route.dispose();
});

for (const slope of [0, 0.2]) for (const budget of [0.08, 0.1575, 0.2, 0.25]) {
  test(`CNK preserves its ${slope} slope and actual 3D ${budget} budget, not NAV Y`, () => {
    const s = fixture(false, slope); s.navigation.findRoute = (a, b) => [{ ...a, y: a.y + 0.1 }, { ...b, y: b.y + 0.1 }];
    const route = createForgelightKnownObstacleRoute(s.options), next = route.testRouteStep(s.from, s.target, budget)!;
    assert.ok(next); assert.ok(Math.hypot(...Array.from(next, (v, i) => v - s.from[i])) <= budget);
    assert.ok(Math.abs(next[1] - (next[2] * slope + s.terrain.npcOriginHeight)) < 0.001);
    assert.ok(next[2] > s.from[2]); route.dispose();
  });
}

test("a packet ends at the first XZ corner even with budget for later corners", () => {
  const s = fixture(); s.navigation.findRoute = (a, b) => [a, { x: 0.125, y: 0.3, z: a.z }, b];
  const route = createForgelightKnownObstacleRoute(s.options);
  assert.deepEqual(route.testRouteStep(s.from, s.target, 1), pos(0.125, s.from[1], -2)); route.dispose();
});

test("known fence blocks crossing and melee while same-side probes can pass with unknown other coverage", () => {
  const s = fixture(true), route = createForgelightKnownObstacleRoute(s.options);
  const a = pos(0, s.from[1], -0.1), b = pos(0, s.from[1], 0.1);
  assert.equal(route.testRouteStep(a, b, 0.25), undefined); assert.equal(route.testMeleeReachability(a, b), false);
  assert.equal(route.testMeleeReachability(pos(0, s.from[1], -1), pos(0, s.from[1], -2)), true);
  assert.equal(route.testMeleeReachability(a, b), false); route.dispose();
});

test("horizontal radius rejects a center line that narrowly misses the known fence end", () => {
  const s = fixture(true), route = createForgelightKnownObstacleRoute(s.options);
  const a = pos(1.2, s.from[1], -0.1), b = pos(1.2, s.from[1], 0.1);
  assert.equal(s.scene.intersectSegment([1.2, 1, -0.1], [1.2, 1, 0.1]), undefined);
  assert.equal(route.testRouteStep(a, b, 0.25), undefined);
  assert.equal(route.testMeleeReachability(a, b), false);
  const clearA = pos(1.4, s.from[1], -0.1), clearB = pos(1.4, s.from[1], 0.1);
  assert.ok(route.testRouteStep(clearA, clearB, 0.25)); route.dispose();
});

test("CNK missing terrain or an ambiguous layer is not replaced by the planner's height", () => {
  for (const kind of ["gap", "layer", "throw"]) {
    const s = fixture();
    if (kind === "throw") s.terrain.testRouteStep = () => { throw Error("terrain unavailable"); };
    else {
      const ground = flat();
      const raisedLayer = { positions: new Float32Array([-1, 1, -1, 1, 1, -1, 1, 1, 1, -1, 1, 1]),
        indices: ground.indices.slice() };
      if (kind === "gap") for (let i = 2; i < ground.positions.length; i += 3) ground.positions[i] /= 2;
      s.options.terrain = createForgelightTerrainFollowBinding({ terrain: kind === "gap" ? ground : [ground, raisedLayer],
        standingPlayerPosition: s.from, spawnXZ: [0, -2], npcVsPlayerOriginDelta: 0 })!;
      assert.ok(s.options.terrain);
      if (kind === "gap") s.target[2] = 6;
      else s.navigation.findRoute = (a, b) => [a, { x: 0, y: 0, z: 0 }, b];
    }
    const route = createForgelightKnownObstacleRoute(s.options);
    assert.equal(route.testRouteStep(s.from, s.target, 0.25), undefined, kind); route.dispose();
  }
});

test("body probe leaving the stated vertical bounds is refused even without a supplied triangle hit", () => {
  const s = fixture(); s.options.bounds.max[1] = 1.2;
  const route = createForgelightKnownObstacleRoute(s.options);
  assert.equal(route.testRouteStep(s.from, s.target, 0.25), undefined);
  route.dispose();
});

for (const kind of ["missing", "throw", "one", "foreign_start", "partial", "nonfinite", "outside", "many", "long"]) {
  test(`planner ${kind} rejects without direct movement fallback`, () => {
    const s = fixture();
    s.navigation.findRoute = ((a: any, b: any) => {
      if (kind === "missing") return undefined;
      if (kind === "throw") throw Error("planner failed");
      if (kind === "one") return [a];
      if (kind === "foreign_start") return [{ ...a, x: a.x + 0.01 }, b];
      if (kind === "partial") return [a, { ...b, z: b.z - 0.1 }];
      if (kind === "nonfinite") return [a, { ...b, z: NaN }];
      if (kind === "outside") return [a, { x: 7.8, y: 0, z: 0 }, b];
      if (kind === "many") return Array(129).fill(a).concat(b);
      return [a, ...Array.from({ length: 20 }, (_, i) => ({ x: i % 2 ? 6 : -6, y: 0, z: 0 })), b];
    }) as any;
    const route = createForgelightKnownObstacleRoute(s.options);
    assert.equal(route.testRouteStep(s.from, s.target, 0.25), undefined);
    assert.equal(route.testMeleeReachability(s.from, s.target), false); route.dispose();
  });
}

for (const next of [undefined, [0, -0.05, -1], [0.2, -0.05, -2], [0.1, -0.05, -1.9], [0, NaN, -1.9]]) {
  test(`missing or invalid CNK step ${JSON.stringify(next)} cannot skip corner or invent Y`, () => {
    const s = fixture(); s.navigation.findRoute = (a, b) => [a, { x: 0.125, y: 0, z: -2 }, b];
    s.terrain.testRouteStep = () => next ? new Float32Array(next) : undefined;
    const route = createForgelightKnownObstacleRoute(s.options);
    assert.equal(route.testRouteStep(s.from, s.target, 0.25), undefined); route.dispose();
  });
}

for (const budget of [0, -1, NaN, Infinity]) test(`invalid budget ${budget} calls no planner`, () => {
  const s = fixture(), route = createForgelightKnownObstacleRoute(s.options);
  assert.equal(route.testRouteStep(s.from, s.target, budget), undefined); assert.equal(s.calls.length, 0); route.dispose();
});

test("invalid, out-of-bounds and out-of-envelope positions are denied before planning", () => {
  const s = fixture(), route = createForgelightKnownObstacleRoute(s.options);
  for (const a of [undefined, new Float32Array([1, 2]), pos(NaN, 0, 0), pos(7.8, -0.05, -2), pos(0, -4, 0)]) {
    assert.equal(route.testRouteStep(a as Float32Array, s.target, 0.25), undefined);
    assert.equal(route.testMeleeReachability(a as Float32Array, s.target), false);
  }
  assert.equal(s.calls.length, 0); route.dispose();
});

test("provider, metadata and bounds mutation cannot widen an owned route", () => {
  const s = fixture(), route = createForgelightKnownObstacleRoute(s.options);
  s.navigation.findRoute = () => { throw Error("replacement"); }; s.terrain.testRouteStep = () => undefined;
  s.options.bounds.max[0] = 100; (s.options.knownObstacleIds as string[])[0] = "foreign";
  (s.options.routeProbeHeights as number[]).splice(0); s.options.entityRadius = 0;
  assert.ok(route.testRouteStep(s.from, s.target, 0.25));
  assert.equal(route.testRouteStep(pos(50, -0.05, -2), s.target, 0.25), undefined);
  assert.deepEqual([...route.scope.knownObstacleIds], ["known-fixture-fence"]); route.dispose();
});

test("construction failure leaves navigation with its caller", () => {
  const edits: ((s: ReturnType<typeof fixture>) => void)[] = [
    s => { s.options.scene = new StaticTriangleScene([]); }, s => { s.options.knownObstacleIds = []; },
    s => { s.options.knownObstacleIds = ["foreign"]; }, s => { s.options.knownObstacleIds = ["known-fixture-fence", "known-fixture-fence"]; },
    s => { s.options.scopeLabel = ""; }, s => { s.options.entityRadius = 0; }, s => { s.options.entityRadius = Infinity; },
    s => { s.options.maxPathPoints = 2049; }, s => { s.options.maxPathPoints = 1; }, s => { s.options.maxPathLength = Infinity; },
    s => { s.options.bounds.max[0] = 200; }, s => { s.options.bounds.max[0] = s.options.bounds.min[0]; },
    s => { s.options.routeProbeHeights = []; }, s => { s.options.routeProbeHeights = [NaN]; },
    s => { s.options.npcOriginHeight = 2; }, s => { s.options.contactHeight = -1; },
    s => { s.terrain.spawnPosition = pos(100, 0, 0); }
  ];
  for (const edit of edits) { const s = fixture(); edit(s); assert.throws(() => createForgelightKnownObstacleRoute(s.options)); assert.equal(s.destroyed(), 0); }
});

test("explicit caller ownership closes the binding without destroying the encounter's shared NAV", () => {
  const s = fixture();
  const first = createForgelightKnownObstacleRoute({ ...s.options, navigationOwnership: "caller" });
  first.dispose(); first.dispose();
  assert.equal(s.destroyed(), 0);
  assert.equal(first.testRouteStep(s.from, s.target, 0.25), undefined);
  assert.equal(first.testMeleeReachability(s.from, s.target), false);
  const second = createForgelightKnownObstacleRoute({ ...s.options, navigationOwnership: "caller" });
  assert.ok(second.testRouteStep(s.from, s.target, 0.25)); second.dispose();
  assert.equal(s.destroyed(), 0);
  s.navigation.destroy(); assert.equal(s.destroyed(), 1);
});

test("invalid navigation ownership cannot silently change native resource ownership", () => {
  const s = fixture();
  assert.throws(() => createForgelightKnownObstacleRoute({ ...s.options, navigationOwnership: "unknown" as any }));
  assert.equal(s.destroyed(), 0);
});

test("dispose closes all queries and attempts destroy exactly once even after native failure", () => {
  const s = fixture(); let attempts = 0;
  s.navigation.destroy = () => { attempts++; throw Error("destroy failed"); };
  const route = createForgelightKnownObstacleRoute(s.options);
  assert.throws(() => route.dispose()); route.dispose(); assert.equal(attempts, 1);
  assert.equal(route.testRouteStep(s.from, s.target, 0.25), undefined);
  assert.equal(route.testMeleeReachability(s.from, s.target), false); assert.equal(s.calls.length, 0);
});

test("synchronous disposal inside planner or terrain cannot leak a step", () => {
  for (const provider of ["nav", "terrain"]) {
    const s = fixture(); let route: ReturnType<typeof createForgelightKnownObstacleRoute>;
    if (provider === "nav") s.navigation.findRoute = (a, b) => { route.dispose(); return [a, b]; };
    else s.terrain.testRouteStep = () => { route.dispose(); return pos(0, -0.05, -1.9); };
    route = createForgelightKnownObstacleRoute(s.options);
    assert.equal(route.testRouteStep(s.from, s.target, 0.25), undefined); assert.equal(s.destroyed(), 1);
    route.dispose(); assert.equal(s.destroyed(), 1);
  }
});

test("actual local Recast plus CNK can go around the named synthetic fence with radius screening", async () => {
  const s = fixture(true), navigation = await ForgelightNavigation.build(flat(), s.scene, s.options.bounds);
  const route = createForgelightKnownObstacleRoute({ ...s.options, navigation });
  try {
    let at: Float32Array = s.from.slice(), steps = 0, farthestX = 0;
    while (Math.hypot(at[0] - s.target[0], at[2] - s.target[2]) > 0.3 && steps < 140) {
      const next = route.testRouteStep(at, s.target, 0.2);
      assert.ok(next, JSON.stringify({ at: [...at], steps }));
      assert.ok(Math.hypot(...Array.from(next, (v, i) => v - at[i])) <= 0.2);
      assert.equal(next[1], s.from[1]); at = next; steps++; farthestX = Math.max(farthestX, Math.abs(at[0]));
    }
    assert.ok(steps < 140); assert.ok(farthestX > 1.3);
    assert.equal(route.testMeleeReachability(at, s.target), true);
    assert.equal(route.scope.otherCollisionCoverage, "unknown");
  } finally { route.dispose(); }
});
