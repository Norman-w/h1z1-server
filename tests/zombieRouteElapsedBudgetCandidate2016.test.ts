import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { createForgelightTerrainFollowBinding } from "../src/utils/forgelightTerrainFollow";
import { surfaceHeights, TriangleMesh } from "../src/utils/forgelightGeometry";

// Proposal-only arithmetic + the CURRENT real terrain helper on synthetic
// meshes. These tests do not claim AiManager implements elapsed integration,
// do not load a world asset, and do not prove native movement/foot contact.
const boundedBudget = (ms: number): number | undefined =>
  Number.isInteger(ms) && ms > 0 && ms < 0x80000000
    ? Math.min(0.25, 2.5 * ms / 1000) : undefined;
const wireXZ = (p: ArrayLike<number>) => [Math.round(p[0] * 100) / 100, Math.round(p[2] * 100) / 100];
const distance3 = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2]);
const wireSpeed = (a: ArrayLike<number>, b: ArrayLike<number>, ms: number) => {
  const x = wireXZ(a), y = wireXZ(b);
  return Math.hypot(y[0]-x[0], y[1]-x[1]) / (ms / 1000);
};
function strip(points: readonly (readonly [number, number])[]): TriangleMesh {
  const positions: number[] = [], indices: number[] = [];
  for (const [x,y] of points) positions.push(x,y,-1,x,y,1);
  for (let i=0;i<points.length-1;i++) {const a=i*2;indices.push(a,a+1,a+2,a+1,a+3,a+2);}
  return {positions:new Float32Array(positions),indices:new Uint32Array(indices)};
}
function binding(terrain: TriangleMesh | readonly TriangleMesh[], spawn=6, player=[0,0,0]) {
  const follow=createForgelightTerrainFollowBinding({terrain,standingPlayerPosition:player,spawnXZ:[spawn,0],npcVsPlayerOriginDelta:0});
  assert.ok(follow);return follow;
}
function proposedStep(follow: ReturnType<typeof binding>, from: Float32Array, target: Float32Array, ms: number) {
  const budget=boundedBudget(ms);
  return budget===undefined ? undefined : follow.testRouteStep(from,target,budget);
}

const frozenLog="C:/Users/WS/AppData/Local/Temp/h1z1-gitbash-01a06a01-soa9tg3y/stdout.log";
test("frozen F/G first attempt peaks accompany the unchanged 0.23 wire segment in 63/80ms", {
  skip: !existsSync(frozenLog)
}, () => {
  const filename=frozenLog;
  const bytes=Buffer.alloc(46144), fd=openSync(filename,"r");
  try {assert.ok(fstatSync(fd).size>=bytes.length);assert.equal(readSync(fd,bytes,0,bytes.length,0),bytes.length);}
  finally {closeSync(fd);}
  assert.equal(createHash("sha256").update(bytes).digest("hex"),"b54723e37a8c1688716cfa01a8049058822b44dcfdfac10b59f9f466ba4d4ba7");
  const lines=bytes.toString("utf8").split(/\r?\n/).filter(s=>s.startsWith('{"event":"test_npc_position"')).map(s=>JSON.parse(s));
  for (const [guid,ms,declared] of [
    ["0x4254e9bf853b88d8",63,3.6507936507939394],
    ["0x4c16627f3bd010c3",80,2.8750000000002274]
  ] as const) {
    const row=lines.find(r=>r.guid===guid&&r.traceIndex===1);assert.ok(row);
    assert.equal(row.phase,"send_attempt");assert.equal(row.speedBasis,"quantized_xz_sequence_interval");
    assert.equal(row.elapsedMs,ms);assert.equal(row.horizontalSpeed,declared);
    assert.equal((row.sequenceTime-row.previousSequenceTime)>>>0,ms);
    assert.equal(wireSpeed([row.previousWireXZ[0],0,row.previousWireXZ[1]],row.position,ms),declared);
    assert.ok(declared>2.5);assert.equal(boundedBudget(ms),2.5*ms/1000);
  }
});

for (const ms of [63,80]) test(`proposal ${ms}ms shrinks a full flat segment instead of merely enlarging declared speed`, () => {
  const follow=binding(strip([[0,0],[10,0]]));
  const from=follow.spawnPosition,target=new Float32Array([0,0,0]);
  const old=follow.testRouteStep(from,target,0.25)!;
  const next=proposedStep(follow,from,target,ms)!;assert.ok(next);
  assert.ok(distance3(from,next)<=boundedBudget(ms)!);
  assert.ok(distance3(from,next)<distance3(from,old));
  assert.ok(distance3(from,next)/(ms/1000)<=2.5);
  // Independent centimetre rounding of two endpoints can still raise wire speed.
  assert.ok(wireSpeed(from,next,ms)<=2.5+Math.SQRT2*0.01/(ms/1000)+1e-9);
});

test("proposal caps long intervals instead of accumulating route catch-up debt", () => {
  const follow=binding(strip([[0,0],[10,0]]));
  let from=follow.spawnPosition;
  for(const ms of [63,80,100,102,109,116,150,200,1000]) {
    const next=proposedStep(follow,from,new Float32Array([0,0,0]),ms)!;assert.ok(next);
    assert.ok(distance3(from,next)<=0.25);
    assert.ok(distance3(from,next)/(ms/1000)<=2.5);
    if(ms>100)assert.ok(distance3(from,next)<2.5*ms/1000,"cap deliberately does not recover all elapsed distance");
    from=next;
  }
});

test("uncapped dt budget alone does not remove long-tick dips: terrain horizontal sample cap remains 0.25", () => {
  const follow=binding(strip([[0,0],[10,0]]));
  const from=follow.spawnPosition;
  const next=follow.testRouteStep(from,new Float32Array([0,0,0]),2.5*0.2)!;
  assert.ok(next);assert.equal(distance3(from,next),0.25);
  assert.equal(distance3(from,next)/0.2,1.25,"a 0.5 budget does not make this flat helper move 0.5");
});

test("uncapped dt on a slope can enlarge the old 3D bound even while horizontal sampling stays capped", () => {
  const follow=binding(strip([[0,0],[10,10]]));
  const from=follow.spawnPosition,target=new Float32Array([0,0,0]);
  const uncapped=follow.testRouteStep(from,target,2.5*0.2)!;
  const capped=proposedStep(follow,from,target,200)!;
  assert.ok(uncapped&&capped);
  assert.ok(distance3(from,uncapped)>0.25,"blind budget=rate*dt changes the prior 3D safety envelope");
  assert.ok(distance3(from,capped)<=0.25);
  assert.ok(Math.abs(capped[1]-capped[0])<0.001);
});

test("variable-dt proposal preserves intermediate narrow-crest endpoints without spending leftover budget", () => {
  const mesh=strip([[0,0],[1,0],[1.1,0.08],[1.2,0],[3,0]]);
  const follow=binding(mesh,0.95);
  let from=follow.spawnPosition;
  const seen:Float32Array[]=[];
  const elapsed=[63,80,109,150,40,116];
  for(let i=0;i<30&&from[0]<1.3;i++) {
    const ms=elapsed[i%elapsed.length],next=proposedStep(follow,from,new Float32Array([2,0,0]),ms);
    assert.ok(next);assert.ok(distance3(from,next)<=boundedBudget(ms)!);
    for(let j=0;j<=8;j++){
      const q=Array.from(from,(v,k)=>v+(next[k]-v)*j/8);
      const heights=surfaceHeights(mesh,q[0],q[2]);assert.equal(heights.length,1);
      assert.ok(Math.abs(q[1]-heights[0]-follow.npcOriginHeight)<0.001);
    }
    seen.push(next);from=next;
  }
  assert.ok(seen.some(p=>Math.abs(p[0]-1.1)<1e-5&&Math.abs(p[1]-0.08)<1e-5));
  assert.ok(from[0]>=1.3);
});

test("smaller time budget still fails closed on gap, multilayer, steep target and missing target", () => {
  const gap=binding([strip([[0,0],[1,0]]),strip([[1.1,0],[3,0]])],1);
  const layered=binding([strip([[0,0],[3,0]]),strip([[1.1,1],[1.2,1]])],1);
  const steep=binding([strip([[0,0],[1,0]]),strip([[1,0],[2,2]])],0.9);
  const flat=binding(strip([[0,0],[3,0]]),1);
  for(const ms of [63,80,100,200]) {
    assert.equal(proposedStep(gap,gap.spawnPosition,new Float32Array([2,0,0]),ms),undefined);
    assert.equal(proposedStep(layered,layered.spawnPosition,new Float32Array([2,0,0]),ms),undefined);
    assert.equal(proposedStep(steep,steep.spawnPosition,new Float32Array([1.5,1,0]),ms),undefined);
    assert.equal(proposedStep(flat,flat.spawnPosition,new Float32Array([4,0,0]),ms),undefined);
  }
});

test("a reversed target uses the next queried segment; a near endpoint is not overshot", () => {
  const follow=binding(strip([[0,0],[10,0]]));
  const first=proposedStep(follow,follow.spawnPosition,new Float32Array([0,0,0]),63)!;
  const reverse=proposedStep(follow,first,new Float32Array([10,0,0]),80)!;
  assert.ok(first[0]<follow.spawnPosition[0]&&reverse[0]>first[0]);
  const target=new Float32Array([reverse[0]+0.03,0,0]);
  const near=proposedStep(follow,reverse,target,200)!;assert.ok(near);
  assert.ok(near[0]<=target[0]&&Math.abs(near[0]-target[0])<1e-6);
  assert.equal(proposedStep(follow,near,target,200),undefined);
});

test("unknown/duplicate/backward interval supplies no candidate route budget", () => {
  for(const ms of [0,-1,NaN,Infinity,-Infinity,0.5,0x80000000,0xffffffff])assert.equal(boundedBudget(ms),undefined);
  assert.equal(boundedBudget((84-0xfffffff0)>>>0),0.25,"short u32 wrap still uses a valid interval");
});

test("tiny positive dt can still have a wire-grid speed spike; integration cannot promise exact elimination", () => {
  const follow=binding(strip([[0,0],[10,0]]),1.004);
  const from=follow.spawnPosition,next=proposedStep(follow,from,new Float32Array([2,0,0]),1)!;
  assert.ok(next);assert.ok(distance3(from,next)<=0.0025);
  assert.ok(wireSpeed(from,next,1)>2.5,"centimetre endpoint quantization is not continuous integration");
});
