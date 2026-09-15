import assert from "node:assert/strict";
import test from "node:test";
import { StaticTriangleScene, TriangleMesh } from "../src/utils/forgelightGeometry";
import { createForgelightTerrainFollowBinding } from "../src/utils/forgelightTerrainFollow";
import { createForgelightStaticGuard, ForgelightStaticGuardOptions } from "../src/utils/forgelightStaticGuard";

const pos = (x: number, y: number, z: number) => new Float32Array([x, y, z]);
const wall = (): TriangleMesh => ({
  positions: new Float32Array([-2, 0, 0, 2, 0, 0, 2, 3, 0, -2, 3, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3])
});
function fixture(blocked = false) {
  const mesh = wall();
  const scene = new StaticTriangleScene(blocked ? [{ id: "explicit-test-wall", mesh }] : []);
  const terrain = { spawnPosition: pos(0, 1, -1), npcOriginHeight: 1,
    testRouteStep: (from: Float32Array, target: Float32Array, _budget: number): Float32Array | undefined =>
      pos(target[0], from[1], target[2]) };
  const calls: { from: readonly number[]; to: readonly number[] }[] = [];
  const options: ForgelightStaticGuardOptions = { terrain, scene,
    bounds: { min: [-4, -1, -4], max: [4, 5, 4] },
    isSegmentCovered: (from, to) => { calls.push({ from, to }); return true; },
    npcOriginHeight: 1, targetOriginHeight: 2, contactHeight: 1,
    routeProbeHeights: [0.3, 1, 1.6] };
  const from = pos(0, 1, -1), target = pos(0, 2, 1);
  return { options, terrain, scene, mesh, calls, from, target };
}

test("explicit covered clear scene allows an owned finite route endpoint and melee", () => {
  const s = fixture(); const guard = createForgelightStaticGuard(s.options);
  const next = guard.testRouteStep(s.from, s.target, 2);
  assert.deepEqual(next, pos(0, 1, 1));
  assert.equal(guard.testMeleeReachability(s.from, s.target), true);
  assert.deepEqual(s.from, pos(0, 1, -1)); assert.deepEqual(s.target, pos(0, 2, 1));
  assert.deepEqual(s.calls[0], { from: [0, 0, -1], to: [0, 0, 1] });
  assert.deepEqual(s.calls[s.calls.length - 1], { from: [0, 1, -1], to: [0, 1, 1] });
  assert.ok(s.calls.every(c => Object.isFrozen(c.from) && Object.isFrozen(c.to)));
});

test("wall blocks both movement and melee independently of any godMode", () => {
  const s = fixture(true); const guard = createForgelightStaticGuard(s.options);
  assert.equal(guard.testRouteStep(s.from, s.target, 2), undefined);
  assert.equal(guard.testMeleeReachability(s.from, s.target), false);
  // No character/protection state is passed to or consulted by this utility.
  for (const godMode of [false, true]) {
    const character = { godMode, position: s.target };
    assert.equal(guard.testMeleeReachability(s.from, character.position), false);
  }
});

test("same melee closure rechecks an endpoint crossing behind a wall during a swing", () => {
  const s = fixture(true); const guard = createForgelightStaticGuard(s.options);
  const target = pos(0, 2, -0.5);
  assert.equal(guard.testMeleeReachability(s.from, target), true);
  target[2] = 1;
  assert.equal(guard.testMeleeReachability(s.from, target), false);
  target[2] = -0.5;
  assert.equal(guard.testMeleeReachability(s.from, target), true);
});

for (const value of [undefined, false, null, 1, "true"]) {
  test(`coverage ${String(value)} is not clearance`, () => {
    const s = fixture(); s.options.isSegmentCovered = () => value as any;
    const guard = createForgelightStaticGuard(s.options);
    assert.equal(guard.testRouteStep(s.from, s.target, 2), undefined);
    assert.equal(guard.testMeleeReachability(s.from, s.target), false);
  });
}

test("covered endpoints cannot authorize a segment crossing an unknown interior", () => {
  const s = fixture();
  s.options.isSegmentCovered = (a, b) => a[2] === b[2] ? true : undefined;
  const guard = createForgelightStaticGuard(s.options);
  assert.equal(guard.testRouteStep(s.from, s.target, 2), undefined);
  assert.equal(guard.testMeleeReachability(s.from, s.target), false);
});

test("melee demands complete terrain ground coverage even when contact segment is covered", () => {
  const s = fixture(); s.options.isSegmentCovered = (a, b) => a[1] > 0 && b[1] > 0;
  assert.equal(createForgelightStaticGuard(s.options).testMeleeReachability(s.from, s.target), false);
});

test("unknown target terrain point rejects route despite a clear next step", () => {
  const s = fixture(); s.options.isSegmentCovered = (a, b) => !(a[2] === 1 && b[2] === 1);
  assert.equal(createForgelightStaticGuard(s.options).testRouteStep(s.from, s.target, 2), undefined);
});

for (const stage of ["terrain", "coverage", "scene"] as const) {
  test(`${stage} exception fails closed`, () => {
    const s = fixture();
    if (stage === "terrain") s.terrain.testRouteStep = () => { throw Error("unknown terrain"); };
    if (stage === "coverage") s.options.isSegmentCovered = () => { throw Error("missing assets"); };
    if (stage === "scene") s.scene.intersectSegment = () => { throw Error("invalid scene"); };
    const guard = createForgelightStaticGuard(s.options);
    assert.equal(guard.testRouteStep(s.from, s.target, 2), undefined);
    if (stage !== "terrain") assert.equal(guard.testMeleeReachability(s.from, s.target), false);
  });
}

test("terrain undefined rejects rather than falling back to a straight route", () => {
  const s = fixture(); s.terrain.testRouteStep = () => undefined;
  const guard = createForgelightStaticGuard(s.options);
  assert.equal(guard.testRouteStep(s.from, s.target, 2), undefined);
  assert.equal(s.calls.length, 0);
});

for (const which of ["from", "target", "next"] as const) {
  for (const value of [NaN, Infinity, -Infinity, 5]) {
    test(`${which} invalid or outside bounds ${String(value)} rejects`, () => {
      const s = fixture();
      if (which === "from") s.from[0] = value;
      if (which === "target") s.target[0] = value;
      if (which === "next") s.terrain.testRouteStep = () => pos(value, 1, 1);
      const guard = createForgelightStaticGuard(s.options);
      assert.equal(guard.testRouteStep(s.from, s.target, 10), undefined);
      if (which !== "next") assert.equal(guard.testMeleeReachability(s.from, s.target), false);
    });
  }
}

test("a raw coordinate outside bounds cannot round inward to bypass bounds", () => {
  const s = fixture(); const guard = createForgelightStaticGuard(s.options);
  const outside = [4 + 1e-8, 1, -1] as any;
  assert.equal(guard.testRouteStep(outside, s.target, 10), undefined);
  assert.equal(guard.testMeleeReachability(outside, s.target), false);
});

test("origin/contact/probe conversion remains bounded even if network origins are inside", () => {
  for (const mode of ["ground", "contact", "probe"]) {
    const s = fixture();
    if (mode === "ground") s.options.bounds.min[1] = 0.5;
    if (mode === "contact") { s.options.bounds.max[1] = 2.5; s.options.contactHeight = 3; }
    if (mode === "probe") { s.options.bounds.max[1] = 2.5; s.options.routeProbeHeights = [3]; }
    const guard = createForgelightStaticGuard(s.options);
    if (mode !== "contact") assert.equal(guard.testRouteStep(s.from, s.target, 2), undefined);
    if (mode !== "probe") assert.equal(guard.testMeleeReachability(s.from, s.target), false);
  }
});

test("wall contact at either endpoint is blocked", () => {
  const s = fixture(true); const guard = createForgelightStaticGuard(s.options);
  for (const [a, b] of [[pos(0, 1, -1), pos(0, 2, 0)], [pos(0, 1, 0), pos(0, 2, 1)]]) {
    assert.equal(guard.testRouteStep(a, b, 2), undefined);
    assert.equal(guard.testMeleeReachability(a, b), false);
  }
});

test("probe heights are explicit: a low wall blocks a low probe, not an invented capsule", () => {
  const s = fixture(); const mesh = wall();
  for (let i = 1; i < mesh.positions.length; i += 3) mesh.positions[i] *= 0.2;
  s.options.scene = new StaticTriangleScene([{ id: "low-wall", mesh }]);
  s.options.routeProbeHeights = [1.6];
  assert.deepEqual(createForgelightStaticGuard(s.options).testRouteStep(s.from, s.target, 2), pos(0, 1, 1));
  s.options.routeProbeHeights = [0.3, 1.6];
  assert.equal(createForgelightStaticGuard(s.options).testRouteStep(s.from, s.target, 2), undefined);
});

for (const budget of [0, -1, NaN, Infinity, 1.999]) test(`invalid/insufficient budget ${budget} rejects`, () => {
  const s = fixture(); assert.equal(createForgelightStaticGuard(s.options).testRouteStep(s.from, s.target, budget), undefined);
});

test("Float32 endpoint is checked against actual distance, never rounding past budget", () => {
  const s = fixture(); s.terrain.testRouteStep = () => pos(0.1, 1, 0);
  const guard = createForgelightStaticGuard(s.options);
  assert.equal(guard.testRouteStep(pos(0, 1, 0), pos(1, 2, 0), 0.1), undefined);
  const result = guard.testRouteStep(pos(0, 1, 0), pos(1, 2, 0), 0.101);
  assert.deepEqual(result, pos(0.1, 1, 0));
});

test("terrain gets owned Float32 copies; its returned endpoint is also copied", () => {
  const s = fixture(); const endpoint = pos(0, 1, 1);
  s.terrain.testRouteStep = (a, b) => { a[0] = 3; b[0] = 3; return endpoint; };
  const result = createForgelightStaticGuard(s.options).testRouteStep(s.from, s.target, 2);
  assert.deepEqual(result, endpoint); assert.notEqual(result, endpoint);
  assert.deepEqual(s.from, pos(0, 1, -1)); assert.deepEqual(s.target, pos(0, 2, 1));
  endpoint[0] = 3; assert.equal(result![0], 0);
});

test("mutating mesh, scene options, bounds, heights or methods cannot loosen the owned guard", () => {
  const s = fixture(true); const guard = createForgelightStaticGuard(s.options);
  s.mesh.positions.fill(100); s.scene.snapshotMeshes()[0].mesh.positions.fill(100);
  s.options.scene = new StaticTriangleScene([]);
  s.scene.intersectSegment = () => undefined;
  s.options.bounds.min.fill(-100); s.options.bounds.max.fill(100);
  (s.options.routeProbeHeights as number[]).fill(3);
  s.options.contactHeight = 3; s.options.npcOriginHeight = 0; s.options.targetOriginHeight = 0;
  s.options.isSegmentCovered = () => true;
  s.terrain.testRouteStep = () => pos(3, 1, 1);
  assert.equal(guard.testRouteStep(s.from, s.target, 2), undefined);
  assert.equal(guard.testMeleeReachability(s.from, s.target), false);
  assert.equal(guard.testMeleeReachability(pos(50, 1, -1), s.target), false);
});

test("replacing an unknown coverage callback cannot enable an already created guard", () => {
  const s = fixture(); s.options.isSegmentCovered = () => undefined;
  const guard = createForgelightStaticGuard(s.options);
  s.options.isSegmentCovered = () => true;
  assert.equal(guard.testRouteStep(s.from, s.target, 2), undefined);
  assert.equal(guard.testMeleeReachability(s.from, s.target), false);
});

test("coverage callback cannot rewrite the checked segment", () => {
  const s = fixture(true); s.options.isSegmentCovered = (a, b) => {
    (a as any)[0] = 3; (b as any)[0] = 3; return true;
  };
  const guard = createForgelightStaticGuard(s.options);
  assert.equal(guard.testRouteStep(s.from, s.target, 2), undefined);
  assert.equal(guard.testMeleeReachability(s.from, s.target), false);
});

test("invalid construction options cannot silently default to clear coverage", () => {
  const changes = [
    (o: any) => delete o.isSegmentCovered, (o: any) => o.isSegmentCovered = true,
    (o: any) => o.bounds.min[0] = NaN, (o: any) => o.bounds.max[0] = Infinity,
    (o: any) => o.bounds.max[0] = o.bounds.min[0], (o: any) => o.bounds.min.pop(),
    (o: any) => o.routeProbeHeights = [], (o: any) => o.routeProbeHeights = [NaN],
    (o: any) => o.routeProbeHeights = [4], (o: any) => o.routeProbeHeights = Array(17).fill(1),
    (o: any) => o.npcOriginHeight = 2, (o: any) => o.targetOriginHeight = NaN,
    (o: any) => o.contactHeight = -1, (o: any) => o.scene = {},
    (o: any) => o.terrain.testRouteStep = undefined
  ];
  for (const change of changes) { const s = fixture(); change(s.options); assert.throws(() => createForgelightStaticGuard(s.options)); }
});

test("real terrain binding may stop on unknown terrain without a geometry fallback", () => {
  const flat: TriangleMesh = { positions: new Float32Array([-2, 0, -2, 2, 0, -2, 2, 0, 2, -2, 0, 2]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]) };
  const terrain = createForgelightTerrainFollowBinding({ terrain: flat,
    standingPlayerPosition: pos(0, 1, -1), spawnXZ: [0, -1], npcVsPlayerOriginDelta: 0 });
  assert.ok(terrain);
  const s = fixture(); s.options.terrain = terrain;
  const guard = createForgelightStaticGuard(s.options);
  assert.ok(guard.testRouteStep(s.from, s.target, 0.25));
  assert.equal(guard.testRouteStep(s.from, pos(0, 2, 3), 0.25), undefined);
});
