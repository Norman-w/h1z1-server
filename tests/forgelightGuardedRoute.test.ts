import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StaticTriangleScene, TriangleMesh, visitZonePlacementsV4, transformActorLocalMesh, ZonePlacement } from "../src/utils/forgelightGeometry";
import { createFileStaticActorResolver } from "../src/utils/forgelightStaticAssets";
import { ForgelightNavigation } from "../src/utils/forgelightNavigation";
import { createForgelightTerrainFollowBinding } from "../src/utils/forgelightTerrainFollow";
import { createForgelightGuardedRoute, ForgelightGuardedRouteOptions } from "../src/utils/forgelightGuardedRoute";

const pos = (x: number, y: number, z: number) => new Float32Array([x, y, z]);
const flat = (min = -8, max = 8, y = 0): TriangleMesh => ({
  positions: new Float32Array([min, y, min, max, y, min, max, y, max, min, y, max]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3])
});
const wall = (): TriangleMesh => ({
  positions: new Float32Array([-1, 0, 0, 1, 0, 0, 1, 3, 0, -1, 3, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3])
});
const vector = (p: Float32Array, origin: number) => ({ x: p[0], y: p[1] - origin, z: p[2] });

function fixture(blocked = false) {
  const from = pos(0, -0.05, -2), target = pos(0, -0.05, 2);
  const terrain = createForgelightTerrainFollowBinding({ terrain: flat(), standingPlayerPosition: from,
    spawnXZ: [from[0], from[2]], npcVsPlayerOriginDelta: 0 })!;
  assert.ok(terrain);
  const scene = new StaticTriangleScene(blocked ? [{ id: "complete-synthetic-wall", mesh: wall() }] : []);
  const calls: unknown[] = [];
  let destroyed = 0;
  const navigation = { scene,
    findRoute(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
      calls.push([a, b]); return [a, b];
    },
    destroy() { destroyed++; }
  };
  const bounds = { min: [-8, -1, -8] as [number, number, number], max: [8, 5, 8] as [number, number, number] };
  const options: ForgelightGuardedRouteOptions = { navigation, terrain, scene, bounds,
    // This synthetic world is completely specified: one plane and the optional wall.
    // Unlike a Z1 subset, its finite box has no omitted actors or unknown collision.
    isSegmentCovered: (a, b) => [a, b].every(p => p.every((v, i) => Number.isFinite(v) && v >= bounds.min[i] && v <= bounds.max[i])),
    npcOriginHeight: terrain.npcOriginHeight, targetOriginHeight: terrain.npcOriginHeight,
    contactHeight: 1, routeProbeHeights: [0.3, 1, 1.6], scopeLabel: "Complete synthetic plane and optional wall only" };
  return { options, from, target, terrain, navigation, scene, calls, destroyed: () => destroyed };
}

for (const ms of [63, 80, 100, 150, 200]) test(`CNK preserves negative origin and supplied short-dt ${ms}ms budget`, () => {
  const s = fixture(), route = createForgelightGuardedRoute(s.options);
  const budget = Math.min(0.25, 2.5 * ms / 1000);
  const next = route.testRouteStep(s.from, s.target, budget)!;
  assert.ok(next); assert.equal(next[1], s.from[1]);
  assert.ok(Math.hypot(...Array.from(next, (v, i) => v - s.from[i])) <= budget);
  assert.ok(next[2] > s.from[2]); assert.equal(s.calls.length, 1);
  assert.equal(route.testMeleeReachability(s.from, s.target), true);
  route.dispose(); assert.equal(s.destroyed(), 1);
});

test("NAV chooses only the next XZ corner; its quantized Y cannot replace CNK or consume the next leg", () => {
  const s = fixture();
  s.navigation.findRoute = (a, b) => [{ ...a, y: 0.1 }, { x: 0.125, y: 2, z: a.z }, b];
  const route = createForgelightGuardedRoute(s.options);
  const next = route.testRouteStep(s.from, s.target, 1)!;
  assert.deepEqual(next, pos(0.125, s.from[1], s.from[2]));
  assert.equal(next[2], -2, "may not turn into second leg in this packet");
  assert.deepEqual(s.from, pos(0, -0.05, -2)); assert.deepEqual(s.target, pos(0, -0.05, 2));
  route.dispose();
});

test("static guard rejects a bad planner crossing the wall and rechecks melee", () => {
  const s = fixture(true), route = createForgelightGuardedRoute(s.options);
  const a = pos(0, s.from[1], -0.1), b = pos(0, s.from[1], 0.1);
  assert.equal(route.testRouteStep(a, b, 0.25), undefined);
  assert.equal(route.testMeleeReachability(a, b), false);
  assert.equal(route.testMeleeReachability(a, pos(0, s.from[1], -0.2)), true);
  assert.equal(route.testMeleeReachability(a, b), false);
  route.dispose();
});

for (const coverage of [undefined, false, null, 1, "true"]) test(`coverage ${String(coverage)} remains unknown/denied`, () => {
  const s = fixture(); s.options.isSegmentCovered = () => coverage as any;
  const route = createForgelightGuardedRoute(s.options);
  assert.equal(route.testRouteStep(s.from, s.target, 0.25), undefined);
  assert.equal(route.testMeleeReachability(s.from, s.target), false);
  route.dispose();
});

for (const kind of ["missing", "throw", "short", "partial", "foreign-start", "nonfinite", "outside", "excessive"] as const)
  test(`planner ${kind} fails closed, without straight-line fallback`, () => {
    const s = fixture();
    s.navigation.findRoute = ((a: any, b: any) => {
      if (kind === "missing") return undefined;
      if (kind === "throw") throw Error("planner unavailable");
      if (kind === "short") return [a];
      if (kind === "partial") return [a, { ...b, z: b.z - 0.1 }];
      if (kind === "foreign-start") return [{ ...a, x: a.x + 0.01 }, b];
      if (kind === "nonfinite") return [a, { ...b, x: NaN }];
      if (kind === "outside") return [a, { ...b, y: 6 }, b];
      return Array(2049).fill(a).concat([b]);
    }) as any;
    const route = createForgelightGuardedRoute(s.options);
    assert.equal(route.testRouteStep(s.from, s.target, 0.25), undefined);
    route.dispose();
  });

test("CNK rejection, unknown layer and known terrain gap are not replaced with NAV Y", () => {
  for (const kind of ["undefined", "throw", "gap", "layer"]) {
    const s = fixture();
    if (kind === "undefined") s.terrain.testRouteStep = () => undefined;
    if (kind === "throw") s.terrain.testRouteStep = () => { throw Error("terrain unknown"); };
    if (kind === "gap") s.target[2] = 7; // Planner bounds are wider than this replacement CNK.
    if (kind === "gap" || kind === "layer") {
      const meshes = kind === "gap" ? [flat(-3, 3)] : [flat(), flat(-1, 1, 1)];
      s.options.terrain = createForgelightTerrainFollowBinding({ terrain: meshes, standingPlayerPosition: s.from,
        spawnXZ: [0, -2], npcVsPlayerOriginDelta: 0 })!;
      if (kind === "layer") s.navigation.findRoute = (a, b) => [a, { x: 0, y: 0, z: 0 }, b];
    }
    const route = createForgelightGuardedRoute(s.options);
    assert.equal(route.testRouteStep(s.from, s.target, 0.25), undefined, kind);
    route.dispose();
  }
});

test("invalid budget, over-budget CNK or corner-cut endpoint is rejected", () => {
  for (const budget of [0, -1, NaN, Infinity]) {
    const s = fixture(), route = createForgelightGuardedRoute(s.options);
    assert.equal(route.testRouteStep(s.from, s.target, budget), undefined);
    assert.equal(s.calls.length, 0); route.dispose();
  }
  for (const next of [pos(0, -0.05, -1), pos(0.25, -0.05, -2), pos(0.1, -0.05, -1.9)]) {
    const s = fixture(); s.navigation.findRoute = (a, b) => [a, { x: 0.125, y: 0, z: -2 }, b];
    s.terrain.testRouteStep = () => next;
    const route = createForgelightGuardedRoute(s.options);
    assert.equal(route.testRouteStep(s.from, s.target, 0.25), undefined); route.dispose();
  }
});

test("captured providers and owned endpoint are not loosened by caller mutation", () => {
  const s = fixture(), route = createForgelightGuardedRoute(s.options);
  s.navigation.findRoute = () => { throw Error("replacement"); };
  s.terrain.testRouteStep = () => undefined;
  s.options.bounds.max[0] = 100; s.options.targetOriginHeight = 3;
  assert.ok(route.testRouteStep(s.from, s.target, 0.25));
  assert.equal(route.testRouteStep(pos(50, -0.05, -2), s.target, 0.25), undefined);
  route.dispose();
});

test("dispose closes queries once, including synchronous disposal or destroy failure", () => {
  const s = fixture(), route = createForgelightGuardedRoute(s.options);
  route.dispose(); route.dispose(); assert.equal(s.destroyed(), 1);
  assert.equal(route.testRouteStep(s.from, s.target, 0.25), undefined);
  assert.equal(route.testMeleeReachability(s.from, s.target), false); assert.equal(s.calls.length, 0);
  const q = fixture(); let attempts = 0;
  q.navigation.destroy = () => { attempts++; throw Error("destroy failed"); };
  const failing = createForgelightGuardedRoute(q.options);
  assert.throws(() => failing.dispose()); failing.dispose(); assert.equal(attempts, 1);
  assert.equal(failing.testMeleeReachability(q.from, q.target), false);
  const r = fixture(); let during: ReturnType<typeof createForgelightGuardedRoute>;
  r.options.isSegmentCovered = () => { during.dispose(); return true; };
  during = createForgelightGuardedRoute(r.options);
  assert.equal(during.testRouteStep(r.from, r.target, 0.25), undefined);
});

test("constructor rejects foreign scene, missing coverage and missing evidence scope", () => {
  for (const edit of [
    (s: ReturnType<typeof fixture>) => { s.options.scene = new StaticTriangleScene([]); },
    (s: ReturnType<typeof fixture>) => { (s.options as any).isSegmentCovered = undefined; },
    (s: ReturnType<typeof fixture>) => { s.options.scopeLabel = ""; }
  ]) { const s = fixture(); edit(s); assert.throws(() => createForgelightGuardedRoute(s.options)); assert.equal(s.destroyed(), 0); }
});

test("actual local NAV plus CNK routes around a completely specified synthetic wall", async () => {
  const s = fixture(true);
  const navigation = await ForgelightNavigation.build(flat(), s.scene, s.options.bounds);
  const route = createForgelightGuardedRoute({ ...s.options, navigation });
  try {
    let at: Float32Array = s.from.slice();
    let farthestX = 0, steps = 0;
    while (Math.hypot(at[0] - s.target[0], at[2] - s.target[2]) > 0.3 && steps < 120) {
      const budget = Math.min(0.25, 2.5 * [63, 80, 100, 150, 200][steps % 5] / 1000);
      const next = route.testRouteStep(at, s.target, budget);
      assert.ok(next, JSON.stringify({ at: [...at], steps, path: navigation.findRoute(vector(at, s.terrain.npcOriginHeight), vector(s.target, s.terrain.npcOriginHeight)) }));
      assert.ok(Math.hypot(...Array.from(next, (v, i) => v - at[i])) <= budget);
      assert.equal(next[1], s.from[1]);
      for (const h of [0.3, 1, 1.6]) assert.equal(s.scene.intersectSegment([at[0], h, at[2]], [next[0], h, next[2]]), undefined);
      at = next; farthestX = Math.max(farthestX, Math.abs(at[0])); steps++;
    }
    assert.ok(steps < 120); assert.ok(farthestX > 1.3);
    assert.equal(route.testMeleeReachability(at, s.target), true);
  } finally { route.dispose(); }
});

test("fixed real Z1 fence proves a positive obstacle only; omitted world coverage still denies", {
  skip: !process.env.FORGELIGHT_ASSETS
}, () => {
  const root = process.env.FORGELIGHT_ASSETS!;
  const actor = "Common_Props_Fences_WoodPlanksGreyPosts1x2.adr";
  const fixedRead = (name: string, hash: string) => {
    const bytes = readFileSync(join(root, name)); assert.equal(createHash("sha256").update(bytes).digest("hex"), hash); return bytes;
  };
  const zone = fixedRead("Z1.zone", "7382b92d38374f05a64d47a3837ca18dac3315249b327fd609d797827deac08d");
  fixedRead(actor, "21610d278e3a052bd281f6f6a888a19053f3db00065cc2f00277cc7da9398aa8");
  fixedRead(actor.replace(/\.adr$/, ".cdt"), "7a1fe152264744b9a7320ff1c7f02d60b2704a711066d89c1b232b7701835223");
  let index = 0, placement: ZonePlacement | undefined;
  visitZonePlacementsV4(zone, p => { if (index++ === 192179) placement = p; });
  assert.ok(placement); assert.equal(placement.actor, actor);
  const resource = createFileStaticActorResolver(root)(actor);
  assert.equal(resource.kind, "independent-static"); if (resource.kind !== "independent-static") return;
  const scene = new StaticTriangleScene(resource.meshes.map((mesh, i) => ({ id: `192179:${i}:${actor}`, mesh: transformActorLocalMesh(mesh, placement!, resource.assetScale) })));
  const a = pos(198.51, 23, -920.3), b = pos(198.51, 23, -922);
  const hit = scene.intersectSegment(a, b); assert.ok(hit); assert.equal(hit.meshId, `192179:0:${actor}`);
  assert.ok(Math.abs(hit.position[2] + 920.9885864257812) < 0.001);
  const s = fixture();
  s.options.bounds = { min: [195, 20, -926], max: [203, 26, -918] };
  s.options.scene = scene; s.options.navigation = { scene, findRoute: (x, y) => [x, y], destroy() {} };
  s.options.terrain = { spawnPosition: a, npcOriginHeight: 0, testRouteStep: () => a.slice() };
  s.options.npcOriginHeight = 0; s.options.targetOriginHeight = 0;
  s.options.scopeLabel = "Z1 placement192179 fence CDT only; terrain and other actor coverage UNKNOWN";
  s.options.isSegmentCovered = () => undefined;
  const route = createForgelightGuardedRoute(s.options);
  assert.equal(route.testRouteStep(a, b, 0.25), undefined);
  assert.equal(route.testMeleeReachability(a, b), false);
  assert.equal(route.testMeleeReachability(a, pos(198.51, 23, -919)), false, "same-side no hit is not a whole-world clear certificate");
  route.dispose();
});
