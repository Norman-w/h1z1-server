import assert from "node:assert/strict";
import test from "node:test";
import { StaticTriangleScene, TriangleMesh } from "../src/utils/forgelightGeometry";
import { createForgelightTerrainFollowBinding } from "../src/utils/forgelightTerrainFollow";
import { createCalibratedTestZombieKnownFence, prepareTestZombieKnownFence } from "../src/servers/ZoneServer2016/test-zombie-known-fence";

function fixture() {
  const terrain: TriangleMesh = { positions: new Float32Array([184,22,-927,192,22,-927,192,22,-916,184,22,-916]),
    indices: new Uint32Array([0,1,2,0,2,3]) };
  const mesh: TriangleMesh = { positions: new Float32Array([187.6,22,-921,191.7,22,-921,191.7,24,-921,187.6,24,-921]),
    indices: new Uint32Array([0,1,2,0,2,3]) };
  const scene = new StaticTriangleScene([{ id: "192060:0:Common_Props_Fences_WoodPlanksGreyPosts1x2.adr", mesh }]);
  let destroys = 0;
  const navigation = { scene, destroy() { destroys++; },
    findRoute(a: {x:number;y:number;z:number}, b: {x:number;y:number;z:number}) { return [a,b]; } };
  const binding = (origin = 0.01) => createForgelightTerrainFollowBinding({ terrain,
    standingPlayerPosition: new Float32Array([189,22+origin,-925.22]), spawnXZ: [189,-919.22], npcVsPlayerOriginDelta: 0 })!;
  return { terrain, navigation, binding, destroys: () => destroys };
}

test("stable fence owner refuses all queries before grounded calibration and remains unknown outside its one mesh", () => {
  const s = fixture(), owner = createCalibratedTestZombieKnownFence(s.navigation), b = s.binding();
  assert.equal(owner.testRouteStep(b.spawnPosition, b.spawnPosition, 0.2), undefined);
  assert.equal(owner.testMeleeReachability(b.spawnPosition, b.spawnPosition), false);
  assert.equal(owner.scope.otherCollisionCoverage, "unknown");
  owner.calibrate(b);
  const target = b.spawnPosition.slice(); target[2] += 0.5;
  assert.ok(owner.testRouteStep(b.spawnPosition, target, 0.2));
  assert.throws(() => owner.calibrate(s.binding(0.02)), /closed/);
  owner.dispose(); owner.dispose(); assert.equal(s.destroys(), 1);
});

test("fresh pre-start ground calibration replaces only its query binding, then closes NAV once", () => {
  const s = fixture(), owner = createCalibratedTestZombieKnownFence(s.navigation);
  owner.calibrate(s.binding(0.01)); owner.calibrate(s.binding(0.02));
  assert.equal(s.destroys(), 0);
  const b = s.binding(0.02), target = b.spawnPosition.slice(); target[2] += 0.5;
  const next = owner.testRouteStep(b.spawnPosition, target, 0.2)!;
  assert.ok(next); assert.equal(next[1], b.spawnPosition[1]);
  owner.dispose(); assert.equal(s.destroys(), 1);
  assert.equal(owner.testMeleeReachability(next, target), false);
  assert.equal(owner.testRouteStep(next, target, 0.2), undefined);
});

test("a failed fresh calibration cannot leave the old query usable", () => {
  const s = fixture(), owner = createCalibratedTestZombieKnownFence(s.navigation), b = s.binding();
  owner.calibrate(b);
  assert.throws(() => owner.calibrate(s.binding(0.3)), /origin/);
  assert.equal(owner.testRouteStep(b.spawnPosition, b.spawnPosition, 0.2), undefined);
  owner.calibrate(b); owner.dispose(); assert.equal(s.destroys(), 1);
});

test("cancel before calibration releases NAV; even a failed native destroy cannot be attempted twice", () => {
  const s = fixture(); let destroys = 0;
  s.navigation.destroy = () => { destroys++; throw Error("native destroy"); };
  const owner = createCalibratedTestZombieKnownFence(s.navigation);
  assert.throws(() => owner.dispose(), /native destroy/);
  owner.dispose(); assert.equal(destroys, 1);
  assert.throws(() => owner.calibrate(s.binding()), /closed/);
});

for (const invalid of ["player", "spawn", "terrain", "nonfinite"] as const) test(`fixed fence ${invalid} mismatch fails before any asset I/O`, async () => {
  const s = fixture();
  const options = { assetRoot: "this-root-must-never-be-opened", terrain: [s.terrain],
    standingPlayerPosition: new Float32Array([189,22.01,-925.22]), spawnXZ: [189,-919.22] as [number,number] };
  if (invalid === "player") options.standingPlayerPosition[0] = 0;
  if (invalid === "spawn") options.spawnXZ[1] += 6;
  if (invalid === "terrain") options.terrain = [];
  if (invalid === "nonfinite") options.standingPlayerPosition[1] = NaN;
  await assert.rejects(prepareTestZombieKnownFence(options), /fixed \+Z6 scene/);
});
