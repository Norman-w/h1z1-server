import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ForgelightNavigation } from "../src/utils/forgelightNavigation";
import {
  parseStaticActorDefinition,
  createStaticActorResolver,
  createFileStaticActorResolver
} from "../src/utils/forgelightStaticAssets";
import {
  decodeCollisionTriangles,
  buildLocalStaticScene,
  decodeTerrainV2,
  intersectSegment,
  StaticTriangleScene,
  type TriangleMesh,
  transformActorLocalMesh,
  visitZonePlacementsV4,
  surfaceHeights
} from "../src/utils/forgelightGeometry";

function staticAdr(attributes = "", extra = "", type = "4119585228") {
  return `<ActorRuntime><AnimationNetwork fileName=""/><Invisible value="0"/><Usage actorUsage="0"/><ChildAttachSlotsEx/><CollisionType type="${type}"/><CollisionData fileName="fixture.cdt" ${attributes}/>${extra}</ActorRuntime>`;
}

test("local navigation rejects disconnected, outside, invalid and disposed routes", async () => {
  const ground: TriangleMesh = {
    positions: new Float32Array([
      -9, 0, -5, -3, 0, -5, -3, 0, 5, -9, 0, 5, 3, 0, -5, 9, 0, -5, 9, 0, 5, 3,
      0, 5
    ]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
  };
  const scene = new StaticTriangleScene([]);
  const bounds = {
    min: [-10, -1, -6] as [number, number, number],
    max: [10, 4, 6] as [number, number, number]
  };
  const nav = await ForgelightNavigation.build(ground, scene, bounds);
  try {
    const start = { x: -7, y: 0, z: 0 };
    assert.ok(nav.findRoute(start, { x: -5, y: 0, z: 0 }));
    assert.equal(nav.findRoute(start, { x: 6, y: 0, z: 0 }), undefined);
    assert.equal(nav.findRoute(start, { x: 0, y: 0, z: 0 }), undefined);
    assert.equal(nav.findRoute(start, { x: 30, y: 0, z: 0 }), undefined);
    assert.equal(nav.findRoute(start, { x: NaN, y: 0, z: 0 }), undefined);
    assert.equal(nav.findRoute(start, { x: -5, y: 3, z: 0 }), undefined);
    bounds.min[0] = 100; // built bounds are an owned snapshot
    ground.positions.fill(99);
    assert.ok(nav.findRoute(start, { x: -5, y: 0, z: 0 }));
  } finally {
    nav.destroy();
    nav.destroy();
  }
  assert.throws(
    () => nav.findRoute({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }),
    /disposed/
  );
  await assert.rejects(
    ForgelightNavigation.build(ground, scene, bounds),
    /bounds/
  );
});

test("scene mesh snapshots are owned copies", () => {
  const scene = new StaticTriangleScene([
    {
      id: "floor",
      mesh: {
        positions: new Float32Array([0, 2, 0, 4, 2, 0, 0, 2, 4]),
        indices: new Uint32Array([0, 1, 2])
      }
    }
  ]);
  const snapshot = scene.snapshotMeshes();
  snapshot[0].mesh.positions.fill(99);
  snapshot[0].mesh.indices.fill(0);
  snapshot[0].id = "changed";
  const hit = scene.intersectSegment([1, 3, 1], [1, 1, 1]);
  assert.equal(hit?.meshId, "floor");
  assert.deepEqual(hit?.position, [1, 2, 1]);
  assert.deepEqual(
    Array.from(scene.snapshotMeshes()[0].mesh.indices),
    [0, 1, 2]
  );
});

test(
  "real encounter local nav route goes around the fence, not through it",
  {
    skip:
      !process.env.FORGELIGHT_ASSETS ||
      !process.env.FORGELIGHT_TERRAIN_DECOMPRESSED
  },
  async () => {
    const { init, NavMeshQuery } = await import("recast-navigation");
    const { generateSoloNavMesh } =
      await import("recast-navigation/generators");
    const bounds: {
      min: [number, number, number];
      max: [number, number, number];
    } = {
      min: [180, 15, -940],
      max: [220, 32, -900]
    };
    const local = buildLocalStaticScene(
      readFileSync(join(process.env.FORGELIGHT_ASSETS!, "Z1.zone")),
      bounds,
      createFileStaticActorResolver(process.env.FORGELIGHT_ASSETS!)
    );
    const terrain = decodeTerrainV2(
      readFileSync(process.env.FORGELIGHT_TERRAIN_DECOMPRESSED!)
    );
    const navigation = await ForgelightNavigation.build(
      terrain,
      local.scene,
      bounds
    );
    try {
      const route = navigation.findRoute(
        { x: 198.51, y: 22.1, z: -919.22 },
        { x: 198.51, y: 22.1, z: -925.22 }
      );
      assert.ok(
        route && route.length > 2,
        "reusable API must retain the real fence detour"
      );
      assert.ok(Math.min(...route.map((point) => point.x)) < 188);
      assert.equal(
        navigation.findRoute(
          { x: 198.51, y: 22.1, z: -919.22 },
          { x: 240, y: 22.1, z: -925.22 }
        ),
        undefined
      );
    } finally {
      navigation.destroy();
    }
    const positions: number[] = [],
      indices: number[] = [];
    let downwardTerrain = 0;
    for (const mesh of [
      terrain,
      ...local.scene.snapshotMeshes().map((entry) => entry.mesh)
    ]) {
      const p = mesh.positions;
      for (let i = 0; i < mesh.indices.length; i += 3) {
        const abc = Array.from(mesh.indices.slice(i, i + 3), (v) => v * 3);
        // Retain intersecting triangles; Recast clips to the explicit build bounds.
        if (
          [0, 1, 2].some(
            (k) =>
              Math.max(...abc.map((a) => p[a + k])) < bounds.min[k] ||
              Math.min(...abc.map((a) => p[a + k])) > bounds.max[k]
          )
        )
          continue;
        if (mesh === terrain) {
          const [a, b, c] = abc;
          const normalY =
            (p[b + 2] - p[a + 2]) * (p[c] - p[a]) -
            (p[b] - p[a]) * (p[c + 2] - p[a + 2]);
          assert.ok(
            normalY < 0,
            "encounter CNK terrain has downward source winding"
          );
          downwardTerrain++;
          abc.reverse(); // Only terrain; do not turn collider undersides into floors.
        }
        // Installed generator uses indices.length for vertex count: triangle soup
        // keeps that value equal to the actual vertex count without patching the dependency.
        for (const v of abc) {
          indices.push(indices.length);
          positions.push(p[v], p[v + 1], p[v + 2]);
        }
      }
    }
    assert.ok(downwardTerrain > 0);
    await init();
    // Experimental envelope, NOT reverse-engineered native capsule dimensions.
    // Height/radius/climb are voxel counts: 1.8m / 0.45m / 0.3m respectively.
    const built = generateSoloNavMesh(positions, indices, {
      bounds: [bounds.min, bounds.max],
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
    assert.ok(built.success, built.success ? undefined : built.error);
    const query = new NavMeshQuery(built.navMesh);
    try {
      const start = { x: 198.51, y: 22.1, z: -919.22 };
      const end = { x: 198.51, y: 22.1, z: -925.22 };
      const halfExtents = { x: 0.5, y: 1, z: 0.5 };
      for (const endpoint of [start, end]) {
        const nearest = query.findClosestPoint(endpoint, { halfExtents });
        assert.ok(
          nearest.success && nearest.polyRef !== 0 && nearest.isPointOverPoly
        );
      }
      assert.ok(
        local.scene.intersectSegment([start.x, 23, start.z], [end.x, 23, end.z])
      );
      const result = query.computePath(start, end, { halfExtents });
      assert.ok(result.success);
      assert.ok(result.path.length > 2);
      const last = result.path[result.path.length - 1];
      assert.ok(
        Math.hypot(last.x - end.x, last.z - end.z) < 0.05,
        "a successful partial path must not be mistaken for arrival"
      );
      for (let i = 1; i < result.path.length; i++) {
        const a = result.path[i - 1],
          b = result.path[i];
        assert.ok(
          b.x > bounds.min[0] &&
            b.x < bounds.max[0] &&
            b.z > bounds.min[2] &&
            b.z < bounds.max[2]
        );
        for (const height of [0.3, 1, 1.6]) {
          assert.equal(
            local.scene.intersectSegment(
              [a.x, a.y + height, a.z],
              [b.x, b.y + height, b.z]
            ),
            undefined,
            "route centerline must not cross loaded static obstacles"
          );
        }
      }
      // This proves this local route only, not coverage of unresolved actors,
      // dynamic doors, capsule sweeps, native feet, or live NPC route following.
    } finally {
      query.destroy();
      built.navMesh.destroy();
    }
  }
);

test("ADR resolver classifies props/structures with native false flag defaults", () => {
  for (const type of ["4119585228", "3988807462"]) {
    const result = parseStaticActorDefinition(
      staticAdr('createAsKinematic="0" useBoundingBox="false"', "", type)
    );
    assert.deepEqual(result, {
      kind: "static",
      collisionFile: "fixture.cdt",
      assetScale: 1,
      collisionType: Number(type)
    });
  }
  assert.equal(parseStaticActorDefinition(staticAdr()).kind, "static");
  assert.equal(
    parseStaticActorDefinition(
      staticAdr().replace('actorUsage="0"', 'actorUsage="0" borrowSkeleton="1"')
    ).kind,
    "unsupported"
  );
  for (const value of ["1", "true", "True", "TRUE"])
    assert.equal(
      parseStaticActorDefinition(staticAdr(`createAsKinematic="${value}"`))
        .kind,
      "unsupported"
    );
  for (const attrs of [
    'useBoundingBox="1"',
    'simpleCollisionFileName="other.cdt"',
    'futureFlag="1"'
  ])
    assert.equal(
      parseStaticActorDefinition(staticAdr(attrs)).kind,
      "unsupported"
    );
  assert.equal(
    parseStaticActorDefinition(staticAdr("", "<Skeleton/> ")).kind,
    "unsupported"
  );
  assert.equal(
    parseStaticActorDefinition(staticAdr("", "", "3099813281")).kind,
    "unsupported"
  );
});

test("ADR resolver rejects malformed/unsafe XML and duplicate nodes", () => {
  assert.throws(
    () =>
      parseStaticActorDefinition(
        '<!DOCTYPE ActorRuntime [<!ENTITY x SYSTEM "file:///secret">]><ActorRuntime/>'
      ),
    /forbidden/
  );
  assert.throws(
    () =>
      parseStaticActorDefinition(
        "<ActorRuntime><CollisionData></ActorRuntime>"
      ),
    /Malformed/
  );
  assert.throws(
    () =>
      parseStaticActorDefinition(
        staticAdr("", '<CollisionData fileName="other.cdt"/>')
      ),
    /Duplicate/
  );
  assert.throws(
    () => parseStaticActorDefinition(" ".repeat(1024 * 1024 + 1)),
    /limit/
  );
  for (const name of [
    "../escape.cdt",
    "C:/escape.cdt",
    "https://host/a.cdt",
    "actor.apx"
  ]) {
    assert.equal(
      parseStaticActorDefinition(staticAdr().replace("fixture.cdt", name)).kind,
      "unsupported"
    );
  }
});

test("asset resolver caches reads, reports missing assets and propagates corrupt data", () => {
  const reads: string[] = [];
  const resolver = createStaticActorResolver((name) => {
    reads.push(name);
    return name.endsWith(".adr")
      ? Buffer.from(staticAdr())
      : collisionFixture().data;
  });
  assert.equal(resolver("fixture.adr").kind, "independent-static");
  resolver("fixture.adr");
  assert.deepEqual(reads, ["fixture.adr", "fixture.cdt"]);
  assert.equal(resolver("../fixture.adr").kind, "unsupported");
  assert.equal(reads.length, 2);
  const missing = createStaticActorResolver(() => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  });
  assert.deepEqual(missing("missing.adr"), {
    kind: "unsupported",
    reason: "missing local ADR/CDT resource"
  });
  const corrupt = createStaticActorResolver((name) =>
    Buffer.from(name.endsWith(".adr") ? staticAdr() : "broken")
  );
  assert.throws(() => corrupt("bad.adr"));
});

test(
  "real ADR classification reproduces ordinary fence, structure and dynamic exclusions",
  { skip: !process.env.FORGELIGHT_ASSETS },
  () => {
    const resolver = createFileStaticActorResolver(
      process.env.FORGELIGHT_ASSETS!
    );
    for (const actor of [
      "Common_Props_Fences_WoodPlanksGreyPosts1x2.adr",
      "Common_Structures_Houses_SmallHouse02A.adr"
    ])
      assert.equal(resolver(actor).kind, "independent-static");
    assert.equal(
      resolver("Common_Props_Doors_ResidentialFront01_Placer.adr").kind,
      "unsupported"
    );
    assert.equal(resolver("ZombieMale_Skin_01.adr").kind, "unsupported");
  }
);

test(
  "real visible doors remain unknown even though they have ordinary-prop CDT files",
  { skip: !process.env.FORGELIGHT_ASSETS },
  () => {
    const root = process.env.FORGELIGHT_ASSETS!;
    for (const stem of [
      "Common_Props_Doors_ResidentialDoor05",
      "Common_Props_Doors_ResidentialFront01"
    ]) {
      const reads: string[] = [];
      const resolver = createStaticActorResolver((name) => {
        reads.push(name);
        return readFileSync(join(root, name));
      });
      const actor = `${stem}.adr`;
      assert.deepEqual(resolver(actor), {
        kind: "unsupported",
        reason: "kinematic collision"
      });
      assert.deepEqual(
        reads,
        [actor],
        "do not freeze a door's CDT as static geometry"
      );
      assert.deepEqual(resolver(`${stem}_Placer.adr`), {
        kind: "unsupported",
        reason: "visibility/placer classification not established"
      });
      // These resource names do not prove a runtime placer-to-door mapping.
      // Both exclusions represent unknown coverage, never an empty doorway.
    }
  }
);

test("scene queries world bounds, closest mesh and immutable snapshots", () => {
  const mesh = {
    positions: new Float32Array([-1000, 0, 2, 1000, 0, 2, 0, 1000, 2]),
    indices: new Uint32Array([0, 1, 2])
  };
  const near = {
    positions: Float32Array.from(mesh.positions, (v, i) =>
      i % 3 === 2 ? 1 : v
    ),
    indices: mesh.indices
  };
  const scene = new StaticTriangleScene([
    { id: "far", mesh },
    { id: "near", mesh: near }
  ]);
  near.positions.fill(9999);
  mesh.indices.fill(9999);
  const hit = scene.intersectSegment([0, 1, 0], [0, 1, 3]);
  assert.equal(hit?.meshId, "near");
  assert.equal(hit?.fraction, 1 / 3);
  assert.equal(hit?.triangle, 0);
  assert.equal(scene.intersectSegment([0, 1, 0], [0, 1, 0.5]), undefined);
  assert.equal(scene.intersectSegment([0, 1, 1], [0, 1, 1])?.fraction, 0);
});

test("scene rejects bad inputs even when empty and cannot be partially published", () => {
  const empty = new StaticTriangleScene([]);
  assert.equal(empty.intersectSegment([0, 0, 0], [1, 1, 1]), undefined);
  assert.throws(
    () => empty.intersectSegment([NaN, 0, 0], [0, 0, 0]),
    /coordinates/
  );
  assert.throws(() => empty.intersectSegment([], [0, 0, 0]), /coordinates/);
  assert.throws(
    () => new StaticTriangleScene([{ id: "", mesh: actorTriangle() }]),
    /IDs/
  );
  assert.throws(
    () =>
      new StaticTriangleScene([
        { id: "same", mesh: actorTriangle() },
        { id: "same", mesh: actorTriangle() }
      ]),
    /IDs/
  );
  const invalid = actorTriangle();
  invalid.indices[0] = 9999;
  assert.throws(
    () => new StaticTriangleScene([{ id: "bad", mesh: invalid }]),
    /bounds/
  );
  invalid.indices[0] = 0;
  invalid.positions[0] = Infinity;
  assert.throws(
    () => new StaticTriangleScene([{ id: "bad", mesh: invalid }]),
    /vertex/
  );
});

test("scene broad phase agrees with brute force over deterministic rays and coplanar contacts", () => {
  const meshes = Array.from({ length: 20 }, (_, id) => {
    const p = actorPlacement();
    p.position = [id - 10, (id % 4) - 2, id % 7, 1];
    p.rotation = [id * 0.19, id * 0.11, id * 0.07, 0];
    return {
      id: String(id),
      mesh: transformActorLocalMesh(actorTriangle(), p, 1)
    };
  });
  const scene = new StaticTriangleScene(meshes);
  let seed = 123;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const rays: [number[], number[]][] = [];
  for (let i = 0; i < 200; i++)
    rays.push([
      Array.from({ length: 3 }, () => random() * 24 - 12),
      Array.from({ length: 3 }, () => random() * 24 - 12)
    ]);
  for (const { mesh } of meshes)
    rays.push([
      Array.from(mesh.positions.slice(0, 3)),
      Array.from(mesh.positions.slice(3, 6))
    ]);
  for (const [start, end] of rays) {
    let expected: ReturnType<StaticTriangleScene["intersectSegment"]>;
    for (const { id, mesh } of meshes) {
      const hit = intersectSegment(mesh, start, end);
      if (hit && (!expected || hit.fraction < expected.fraction))
        expected = { ...hit, meshId: id };
    }
    assert.deepEqual(scene.intersectSegment(start, end), expected);
  }
});

test(
  "real combined scene picks sidewalk above terrain and fence across pursuit",
  {
    skip:
      !process.env.FORGELIGHT_ASSETS ||
      !process.env.FORGELIGHT_TERRAIN_DECOMPRESSED
  },
  () => {
    const terrain = decodeTerrainV2(
      readFileSync(process.env.FORGELIGHT_TERRAIN_DECOMPRESSED!)
    );
    const entries: { id: string; mesh: TriangleMesh }[] = [
      { id: "terrain", mesh: terrain }
    ];
    const props = [
      {
        id: "sidewalk",
        name: "Common_Props_Sidewalks_Small01",
        position: [
          200.24424743652344, 21.893516540527344, -919.3801879882812, 1
        ],
        rotation: [3.141592264175415, 0, 0, 0],
        scale: [1, 1, 0.9600000381469727, 1]
      },
      {
        id: "fence",
        name: "Common_Props_Fences_WoodPlanksGreyPosts1x2",
        position: [197.66436767578125, 22, -921.009765625, 1],
        rotation: [7.989483492565341e-7, 0, 0, 0],
        scale: [1, 1, 1, 1]
      }
    ];
    for (const prop of props) {
      const p = actorPlacement();
      p.position = prop.position as typeof p.position;
      p.rotation = prop.rotation as typeof p.rotation;
      p.scale = prop.scale as typeof p.scale;
      const local = decodeCollisionTriangles(
        readFileSync(join(process.env.FORGELIGHT_ASSETS!, prop.name + ".cdt"))
      )[0];
      // Explicit independent-static-placement replay; no dynamic/world coverage claim.
      entries.push({
        id: prop.id,
        mesh: transformActorLocalMesh(local, p, 1)
      });
    }
    const scene = new StaticTriangleScene(entries);
    const ground = scene.intersectSegment(
      [198.51, 25, -919.22],
      [198.51, 20, -919.22]
    );
    assert.equal(ground?.meshId, "sidewalk");
    assert.ok(Math.abs(ground!.position[1] - 22.0720491211) < 1e-5);
    assert.equal(
      scene.intersectSegment([198.51, 23, -919.22], [198.51, 23, -925.22])
        ?.meshId,
      "fence"
    );
  }
);

const actorPlacement = () => ({
  position: [0, 0, 0, 1] as [number, number, number, number],
  rotation: [0, 0, 0, 0] as [number, number, number, number],
  scale: [1, 1, 1, 1] as [number, number, number, number]
});
const actorTriangle = () => ({
  positions: new Float32Array([1, 2, 3, 0, 0, 0, 1, 0, 0]),
  indices: new Uint32Array([0, 1, 2])
});
function closeVector(
  actual: ArrayLike<number>,
  expected: number[],
  epsilon = 1e-5
) {
  expected.forEach((v, i) =>
    assert.ok(
      Math.abs(actual[i] - v) < epsilon,
      `component ${i}: ${actual[i]} != ${v}`
    )
  );
}

test("actor rotations use native Y/X/Z components and positive row-vector signs", () => {
  const expected = [
    [3, 2, -1],
    [1, -3, 2],
    [-2, 1, 3]
  ];
  for (let axis = 0; axis < 3; axis++) {
    const p = actorPlacement();
    p.rotation[axis] = Math.PI / 2;
    closeVector(
      transformActorLocalMesh(actorTriangle(), p, 1).positions,
      expected[axis]
    );
  }
  const p = actorPlacement();
  p.rotation = [Math.PI / 2, Math.PI / 2, Math.PI / 2, 0];
  // Z: [1,2,3]->[-2,1,3]; X: [-2,-3,1]; Y: [1,-3,2].
  closeVector(
    transformActorLocalMesh(actorTriangle(), p, 1).positions,
    [1, -3, 2]
  );
});

test("actor scale is clamped before asset scale, rotated before translation, and inputs stay owned", () => {
  const p = actorPlacement(),
    mesh = actorTriangle();
  p.position = [10, 20, 30, 1];
  p.scale = [2, 3, 4, 1];
  p.rotation[0] = Math.PI / 2;
  const result = transformActorLocalMesh(mesh, p, 0.5);
  closeVector(result.positions, [16, 23, 29]);
  assert.deepEqual(Array.from(mesh.positions), [1, 2, 3, 0, 0, 0, 1, 0, 0]);
  result.indices[0] = 2;
  assert.equal(mesh.indices[0], 0);
  const clamped = actorPlacement();
  clamped.scale = [-1, 0, 0.005, 1];
  closeVector(
    transformActorLocalMesh(mesh, clamped, 2).positions,
    [0.02, 0.04, 0.06]
  );
});

test("actor transform rejects unverified scale, malformed mesh and non-finite results", () => {
  for (const value of [undefined, NaN, Infinity, 0, -1]) {
    assert.throws(
      () =>
        transformActorLocalMesh(
          actorTriangle(),
          actorPlacement(),
          value as number
        ),
      /asset scale/
    );
  }
  const p = actorPlacement();
  p.rotation[1] = NaN;
  assert.throws(
    () => transformActorLocalMesh(actorTriangle(), p, 1),
    /transform/
  );
  assert.throws(
    () =>
      transformActorLocalMesh(
        { positions: new Float32Array(2), indices: new Uint32Array() },
        actorPlacement(),
        1
      ),
    /dimensions/
  );
  const invalid = actorTriangle();
  invalid.indices[0] = 3;
  assert.throws(
    () => transformActorLocalMesh(invalid, actorPlacement(), 1),
    /index/
  );
  invalid.indices[0] = 0;
  invalid.positions[0] = NaN;
  assert.throws(
    () => transformActorLocalMesh(invalid, actorPlacement(), 1),
    /vertex/
  );
  assert.throws(
    () => transformActorLocalMesh(actorTriangle(), actorPlacement(), 1e100),
    /vertex/
  );
});

test(
  "real fence actor-local replay includes zone yaw, under explicit asset-scale assumption",
  { skip: !process.env.FORGELIGHT_ASSETS },
  () => {
    const p = actorPlacement();
    p.position = [197.66436767578125, 22, -921.009765625, 1];
    p.rotation = [7.989483492565341e-7, 0, 0, 0];
    const local = decodeCollisionTriangles(
      readFileSync(
        join(
          process.env.FORGELIGHT_ASSETS!,
          "Common_Props_Fences_WoodPlanksGreyPosts1x2.cdt"
        )
      )
    )[0];
    // Conditional replay, NOT proof of asset scalar/default or CDT-local binding.
    const world = transformActorLocalMesh(local, p, 1);
    const hit = intersectSegment(
      world,
      [198.51, 23, -919.22],
      [198.51, 23, -925.22]
    );
    assert.ok(hit);
    assert.equal(hit.triangle, 9);
    assert.ok(Math.abs(hit.fraction - 0.29476440429687045) < 1e-7);
    assert.equal(
      intersectSegment(world, [198.51, 25, -919.22], [198.51, 25, -925.22]),
      undefined
    );
  }
);

function zoneFixture() {
  const parts = [u32(1), Buffer.from("fixture.adr\0"), u32(0), u32(2)];
  const firstInstance = 76 + Buffer.concat(parts).length;
  for (let i = 0; i < 2; i++) {
    const transform = Buffer.alloc(48);
    [10 + i, 22, -900, 1, 0.5, 0.25, -0.125, 0, 1, 2, 3, 1].forEach((v, j) =>
      transform.writeFloatLE(v, j * 4)
    );
    parts.push(transform, Buffer.alloc(9));
    for (const width of [8, 8, 12, 20]) {
      parts.push(u32(i ? 0 : 1));
      if (!i) parts.push(Buffer.alloc(width, 1));
    }
    parts.push(u32(i ? 0 : 1));
    if (!i) parts.push(u32(123), u32(3), Buffer.from("abc"));
  }
  const body = Buffer.concat(parts),
    header = Buffer.alloc(76);
  header.write("ZONE");
  header.writeUInt32LE(4, 4);
  header.writeUInt32LE(7, 8);
  header.writeUInt32LE(76, 24);
  header.writeUInt32LE(76 + body.length, 28);
  return { data: Buffer.concat([header, body]), firstInstance };
}

test("local loader includes bounds-overlapping geometry despite distant placement origins", () => {
  const { data, firstInstance } = zoneFixture();
  // Keep variable tails intact, editing each transform at its existing offset.
  const secondInstance =
    firstInstance + 48 + 9 + 4 * 4 + 8 + 8 + 12 + 20 + 4 + 4 + 4 + 3;
  for (const [n, offset] of [firstInstance, secondInstance].entries()) {
    [1000 + n, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1].forEach((value, i) =>
      data.writeFloatLE(value, offset + i * 4)
    );
  }
  let calls = 0;
  const mesh = {
    positions: new Float32Array([-1000, 0, 0, -998, 0, 0, -999, 2, 0]),
    indices: new Uint32Array([0, 1, 2])
  };
  const result = buildLocalStaticScene(
    data,
    { min: [1.4, 0.4, -1], max: [1.6, 0.6, 1] },
    () => {
      calls++;
      return { kind: "independent-static", assetScale: 1, meshes: [mesh] };
    }
  );
  assert.equal(calls, 1);
  assert.equal(result.placementsScanned, 2);
  assert.equal(result.placementsIncluded, 2);
  assert.equal(result.trianglesIncluded, 2);
  assert.deepEqual(result.unsupported, []);
  assert.ok(result.scene.intersectSegment([1.5, 0.5, -1], [1.5, 0.5, 1]));
  assert.throws(
    () =>
      buildLocalStaticScene(
        data,
        { min: [1.4, 0.4, -1], max: [1.6, 0.6, 1] },
        () => ({ kind: "independent-static", assetScale: 1, meshes: [mesh] }),
        1
      ),
    /budget exceeded/
  );
});

test("local loader reports unknown geometry globally and fails without partial scene publication", () => {
  const bounds = {
    min: [-1, -1, -1] as [number, number, number],
    max: [1, 1, 1] as [number, number, number]
  };
  const data = zoneFixture().data;
  const resolver = () => ({
    kind: "unsupported" as const,
    reason: "dynamic door or missing collision resource"
  });
  const result = buildLocalStaticScene(data, bounds, resolver);
  assert.equal(result.placementsIncluded, 0);
  assert.deepEqual(result.unsupported, [
    {
      actor: "fixture.adr",
      reason: "dynamic door or missing collision resource",
      instances: 2
    }
  ]);
  assert.throws(
    () =>
      buildLocalStaticScene(
        data.subarray(0, data.length - 1),
        bounds,
        resolver
      ),
    /bounds|Truncated/
  );
  assert.throws(
    () =>
      buildLocalStaticScene(data, { min: [2, 0, 0], max: [1, 1, 1] }, resolver),
    /bounds/
  );
  assert.throws(
    () => buildLocalStaticScene(data, bounds, resolver, -1),
    /budget/
  );
  assert.throws(
    () =>
      buildLocalStaticScene(data, bounds, () => {
        throw new Error("resource I/O failure");
      }),
    /I\/O failure/
  );
});

test(
  "real local static loader finds fence and sidewalk while reporting unclassified actors",
  { skip: !process.env.FORGELIGHT_ASSETS },
  () => {
    const root = process.env.FORGELIGHT_ASSETS!;
    const allowed = new Set([
      "Common_Props_Fences_WoodPlanksGreyPosts1x2.adr",
      "Common_Props_Sidewalks_Small01.adr"
    ]);
    const result = buildLocalStaticScene(
      readFileSync(join(root, "Z1.zone")),
      { min: [195, 20, -926], max: [203, 26, -918] },
      (actor) => {
        // Two audited static resources; deliberately do not classify the rest as free.
        if (!allowed.has(actor))
          return {
            kind: "unsupported",
            reason: "not audited for this static replay"
          };
        return {
          kind: "independent-static",
          assetScale: 1,
          meshes: decodeCollisionTriangles(
            readFileSync(join(root, actor.replace(/\.adr$/, ".cdt")))
          )
        };
      }
    );
    assert.equal(result.placementsScanned, 305951);
    assert.ok(result.placementsIncluded > 2);
    assert.ok(result.unsupported.length > 0);
    assert.ok(
      result.scene
        .intersectSegment([198.51, 23, -919.22], [198.51, 23, -925.22])
        ?.meshId.endsWith("Common_Props_Fences_WoodPlanksGreyPosts1x2.adr")
    );
    const ground = result.scene.intersectSegment(
      [198.51, 25, -919.22],
      [198.51, 20, -919.22]
    );
    assert.ok(ground?.meshId.endsWith("Common_Props_Sidewalks_Small01.adr"));
    assert.ok(Math.abs(ground!.position[1] - 22.0720491211) < 1e-5);
  }
);

test("ZONE v4 handles nonempty variable-length instance tails without shifting transforms", () => {
  const rows: Parameters<Parameters<typeof visitZonePlacementsV4>[1]>[0][] = [];
  const stats = visitZonePlacementsV4(zoneFixture().data, (row) =>
    rows.push(row)
  );
  assert.deepEqual(stats, { groups: 1, instances: 2 });
  assert.deepEqual(
    rows.map((row) => row.position),
    [
      [10, 22, -900, 1],
      [11, 22, -900, 1]
    ]
  );
  assert.deepEqual(rows[1].rotation, [0.5, 0.25, -0.125, 0]);
  assert.deepEqual(rows[1].scale, [1, 2, 3, 1]);
});

test("ZONE reader rejects truncated sections, bad offsets, names and non-finite transforms", () => {
  const { data, firstInstance } = zoneFixture();
  for (let n = 0; n < data.length; n++)
    assert.throws(() => visitZonePlacementsV4(data.subarray(0, n), () => {}));
  const badOffset = Buffer.from(data);
  badOffset.writeUInt32LE(75, 24);
  assert.throws(() => visitZonePlacementsV4(badOffset, () => {}), /bounds/);
  const invalid = Buffer.from(data);
  invalid.writeFloatLE(Infinity, firstInstance);
  assert.throws(() => visitZonePlacementsV4(invalid, () => {}), /Non-finite/);
  const badName = Buffer.from(data);
  badName.fill(65, 80);
  assert.throws(() => visitZonePlacementsV4(badName, () => {}), /actor name/);
  const trailing = Buffer.concat([data, u32(0)]);
  trailing.writeUInt32LE(trailing.length, 28);
  assert.throws(
    () => visitZonePlacementsV4(trailing, () => {}),
    /lights offset/
  );
});

test(
  "real Z1 placement scan matches prior independent reader and fence coordinates",
  { skip: !process.env.FORGELIGHT_ASSETS },
  () => {
    let nearby = 0,
      fenceFound = false;
    const stats = visitZonePlacementsV4(
      readFileSync(join(process.env.FORGELIGHT_ASSETS!, "Z1.zone")),
      (p) => {
        if (
          (p.position[0] - 198.51) ** 2 + (p.position[2] + 922.22) ** 2 <=
          900
        )
          nearby++;
        if (
          p.actor === "Common_Props_Fences_WoodPlanksGreyPosts1x2.adr" &&
          Math.abs(p.position[0] - 197.66436767578125) < 1e-6 &&
          Math.abs(p.position[2] + 921.009765625) < 1e-6
        ) {
          fenceFound = true;
          assert.deepEqual(
            p.position,
            [197.66436767578125, 22, -921.009765625, 1]
          );
          assert.deepEqual(p.scale, [1, 1, 1, 1]);
        }
      }
    );
    assert.deepEqual(stats, { groups: 980, instances: 305951 });
    assert.equal(nearby, 735);
    assert.ok(fenceFound);
  }
);

test("segments hit both faces, stop at their endpoints and return the nearest surface", () => {
  const mesh = {
    positions: new Float32Array([
      0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0, 2, 4, 0, 2, 0, 4, 2
    ]),
    indices: new Uint32Array([3, 4, 5, 0, 1, 2])
  };
  assert.equal(intersectSegment(mesh, [1, 1, -1], [1, 1, 3])?.fraction, 0.25);
  assert.equal(intersectSegment(mesh, [1, 1, 3], [1, 1, -1])?.fraction, 0.25);
  assert.equal(intersectSegment(mesh, [1, 1, -1], [1, 1, -0.1]), undefined);
  assert.equal(intersectSegment(mesh, [1, 1, -1], [1, 1, 0])?.fraction, 1);
  assert.equal(intersectSegment(mesh, [1, 1, 0], [1, 1, -1])?.fraction, 0);
  assert.equal(intersectSegment(mesh, [4, 4, -1], [4, 4, 3]), undefined);
});

test("coplanar, edge, point and degenerate segment contacts are explicit", () => {
  const mesh = {
    positions: new Float32Array([0, 0, 0, 4, 0, 0, 0, 4, 0]),
    indices: new Uint32Array([0, 1, 2])
  };
  assert.equal(intersectSegment(mesh, [-1, 1, 0], [1, 1, 0])?.fraction, 0.5);
  assert.equal(intersectSegment(mesh, [-1, 0, 0], [1, 0, 0])?.fraction, 0.5);
  assert.equal(intersectSegment(mesh, [1, 1, 0], [1, 1, 0])?.fraction, 0);
  assert.equal(intersectSegment(mesh, [4, 4, 0], [5, 5, 0]), undefined);
  assert.equal(intersectSegment(mesh, [1, 1, 1], [1, 1, 1]), undefined);
  assert.throws(
    () => intersectSegment(mesh, [NaN, 0, 0], [0, 0, 0]),
    /Invalid/
  );
  assert.throws(() => intersectSegment(mesh, [], [0, 0, 0]), /Invalid/);
  const degenerate = { ...mesh, indices: new Uint32Array([0, 0, 1]) };
  assert.equal(intersectSegment(degenerate, [0, 0, -1], [0, 0, 1]), undefined);
  const reversed = { ...mesh, indices: new Uint32Array([2, 1, 0]) };
  assert.equal(
    intersectSegment(reversed, [-1, 1, 0], [1, 1, 0])?.fraction,
    0.5
  );
});

test("segment projection works on every dominant normal axis", () => {
  for (let axis = 0; axis < 3; axis++) {
    const rotate = (v: number[]) => [
      v[axis],
      v[(axis + 1) % 3],
      v[(axis + 2) % 3]
    ];
    const mesh = {
      positions: new Float32Array(
        [
          [0, 0, 0],
          [4, 0, 0],
          [0, 4, 0]
        ].flatMap(rotate)
      ),
      indices: new Uint32Array([0, 1, 2])
    };
    assert.equal(
      intersectSegment(mesh, rotate([1, 1, -1]), rotate([1, 1, 1]))?.fraction,
      0.5
    );
    assert.equal(
      intersectSegment(mesh, rotate([-1, 1, 0]), rotate([1, 1, 0]))?.fraction,
      0.5
    );
  }
});

test(
  "real fence blocks the previously observed pursuit segment",
  { skip: !process.env.FORGELIGHT_ASSETS },
  () => {
    const mesh = decodeCollisionTriangles(
      readFileSync(
        join(
          process.env.FORGELIGHT_ASSETS!,
          "Common_Props_Fences_WoodPlanksGreyPosts1x2.cdt"
        )
      )
    )[0];
    // Local-space replay of the independent native-mesh probe. The tiny zone
    // rotation is intentionally NOT treated as a verified world transform.
    const start = [198.51 - 197.66436767578125, 1, -919.22 + 921.009765625];
    const end = [start[0], 1, -925.22 + 921.009765625];
    const hit = intersectSegment(mesh, start, end);
    assert.ok(hit);
    assert.equal(hit.triangle, 9);
    assert.ok(Math.abs(hit.fraction - 0.2947675068) < 1e-8);
    assert.equal(
      intersectSegment(mesh, [start[0], 3, start[2]], [end[0], 3, end[2]]),
      undefined
    );
    assert.equal(intersectSegment(mesh, start, [start[0], 1, 0.5]), undefined);
  }
);

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}
function vertex(x: number, z: number, y: number): Buffer {
  const b = Buffer.alloc(16);
  b.writeInt16LE(x);
  b.writeInt16LE(z, 2);
  b.writeInt16LE(y * 32, 6);
  return b;
}
function terrainFixture() {
  const parts = [Buffer.from("CNK0"), u32(2), u32(2)];
  // Two tiles in file order, with and without an embedded image.
  for (let i = 0; i < 2; i++) {
    parts.push(u32(0), u32(i), u32(0), u32(0), u32(0), u32(i), u32(i ? 0 : 14));
    if (!i) parts.push(u32(4), u32(4), Buffer.from("DDS "));
    parts.push(u32(0));
  }
  parts.push(u32(0), u32(0), u32(9));
  const indexOffset = Buffer.concat(parts).length;
  const indices = Buffer.alloc(18);
  [0, 1, 2, 0, 1, 2, 0, 1, 2].forEach((v, i) =>
    indices.writeUInt16LE(v, i * 2)
  );
  parts.push(indices, u32(6));
  for (const y of [22, 24])
    parts.push(vertex(0, 0, y), vertex(8, 0, y), vertex(0, 8, y));
  parts.push(u32(3));
  const batchOffset = Buffer.concat(parts).length;
  // Multiple batches share the first tile, so batch ordinal cannot locate a tile.
  for (const values of [
    [1, 0, 3, 0, 3],
    [2, 3, 3, 0, 3],
    [1, 6, 3, 3, 3]
  ]) {
    parts.push(...values.map(u32));
  }
  parts.push(u32(0), u32(0), u32(0), u32(0), Buffer.from([0, 0, 128, 63]));
  return { data: Buffer.concat(parts), indexOffset, batchOffset };
}

function collisionFixture(version = 1) {
  const parts = [Buffer.from("CDTA"), u32(version), u32(0), u32(1), u32(0)];
  if (version === 2) parts.push(u32(123), u32(1));
  parts.push(u32(3));
  const vertexOffset = Buffer.concat(parts).length;
  const positions = Buffer.alloc(36);
  [0, 2, 0, 8, 2, 0, 0, 2, 8].forEach((v, i) =>
    positions.writeFloatLE(v, i * 4)
  );
  parts.push(positions, u32(1));
  const indexOffset = Buffer.concat(parts).length;
  parts.push(Buffer.from([0, 0, 1, 0, 2, 0]), u32(3), Buffer.from([1, 2, 3]));
  return { data: Buffer.concat(parts), vertexOffset, indexOffset };
}

test("CNK0 v2 respects shared tile vertex ranges and retains unknown suffix", () => {
  const { data } = terrainFixture();
  const mesh = decodeTerrainV2(data);
  assert.equal(mesh.tileCount, 2);
  assert.equal(mesh.batchCount, 3);
  assert.equal(mesh.positions.length, 18);
  assert.equal(mesh.indices.length, 9);
  assert.deepEqual(surfaceHeights(mesh, 1, 1), [22]);
  assert.deepEqual(surfaceHeights(mesh, 65, 1), [24]);
  assert.deepEqual(surfaceHeights(mesh, -1, 0), []);
  assert.deepEqual(mesh.trailingBytes, Buffer.from([0, 0, 128, 63]));
});

test("CNK0 rejects truncated, compressed-like, unsupported and impossible counts", () => {
  const { data } = terrainFixture();
  for (let n = 0; n < data.length - 4; n++) {
    assert.throws(() => decodeTerrainV2(data.subarray(0, n)), `prefix ${n}`);
  }
  const wrongVersion = Buffer.from(data);
  wrongVersion.writeUInt32LE(1, 4);
  assert.throws(() => decodeTerrainV2(wrongVersion), /v2/);
  const hugeCount = Buffer.from(data);
  hugeCount.writeUInt32LE(0xffffffff, 8);
  assert.throws(() => decodeTerrainV2(hugeCount), /count/);
});

test("CNK0 rejects invalid triangle indices, overlapping coverage and conflicting ranges", () => {
  const { data, indexOffset, batchOffset } = terrainFixture();
  const badIndex = Buffer.from(data);
  badIndex.writeUInt16LE(3, indexOffset);
  assert.throws(() => decodeTerrainV2(badIndex), /triangle index/);
  const overlap = Buffer.from(data);
  overlap.writeUInt32LE(0, batchOffset + 20 + 4);
  assert.throws(() => decodeTerrainV2(overlap), /index ranges/);
  const conflict = Buffer.from(data);
  conflict.writeUInt32LE(2, batchOffset + 20 + 16);
  assert.throws(() => decodeTerrainV2(conflict), /Conflicting/);
});

for (const version of [1, 2]) {
  test(`CDTA v${version} decodes the triangle section and skips cooked bytes`, () => {
    const { data } = collisionFixture(version);
    const meshes = decodeCollisionTriangles(data);
    assert.equal(meshes.length, 1);
    assert.deepEqual(surfaceHeights(meshes[0], 1, 1), [2]);
    assert.deepEqual(surfaceHeights(meshes[0], 9, 9), []);
    for (let n = 0; n < data.length; n++)
      assert.throws(() => decodeCollisionTriangles(data.subarray(0, n)));
  });
}

test("CDTA rejects unsupported shapes, non-finite vertices, bad indices and trailing bytes", () => {
  const { data, vertexOffset, indexOffset } = collisionFixture();
  const shape = Buffer.from(data);
  shape.writeUInt32LE(1, 16);
  assert.throws(() => decodeCollisionTriangles(shape), /shape/);
  const nonfinite = Buffer.from(data);
  nonfinite.writeFloatLE(NaN, vertexOffset);
  assert.throws(() => decodeCollisionTriangles(nonfinite), /Non-finite/);
  const badIndex = Buffer.from(data);
  badIndex.writeUInt16LE(3, indexOffset);
  assert.throws(() => decodeCollisionTriangles(badIndex), /triangle index/);
  assert.throws(
    () => decodeCollisionTriangles(Buffer.concat([data, u32(0)])),
    /trailing/
  );
});

test("vertical queries preserve stacked surfaces, boundaries and invalid inputs", () => {
  const mesh = {
    positions: new Float32Array([
      0, 1, 0, 4, 1, 0, 0, 1, 4, 0, 3, 0, 4, 3, 0, 0, 3, 4
    ]),
    indices: new Uint32Array([0, 1, 2, 3, 4, 5])
  };
  assert.deepEqual(surfaceHeights(mesh, 0, 0), [1, 3]);
  assert.deepEqual(surfaceHeights(mesh, 2, 2), [1, 3]);
  assert.throws(() => surfaceHeights(mesh, NaN, 0), /Invalid/);
});

// Opt-in local integration checks: copyrighted client assets are never committed.
test(
  "real Z1_-16_0 terrain reproduces the independently decoded encounter heights",
  {
    skip: !process.env.FORGELIGHT_TERRAIN_DECOMPRESSED
  },
  () => {
    const mesh = decodeTerrainV2(
      readFileSync(process.env.FORGELIGHT_TERRAIN_DECOMPRESSED!)
    );
    assert.equal(mesh.tileCount, 16);
    assert.equal(mesh.batchCount, 218);
    assert.equal(mesh.positions.length / 3, 17236);
    assert.equal(mesh.indices.length / 3, 30344);
    for (const z of [-919.22, -920, -921, -922, -922.83]) {
      assert.deepEqual(surfaceHeights(mesh, 198.51, z), [22]);
      const hit = intersectSegment(mesh, [198.51, 30, z], [198.51, 10, z]);
      assert.ok(hit);
      assert.ok(Math.abs(hit.position[1] - 22) < 1e-6);
    }
    assert.ok(
      Math.abs(surfaceHeights(mesh, 198.51, -925.22)[0] - 22.0078515625) < 1e-6
    );
    assert.deepEqual(surfaceHeights(mesh, -1, -919.22), []);
  }
);

test(
  "real local CDTA v1 and v2 assets parse without trailing data",
  {
    skip: !process.env.FORGELIGHT_ASSETS
  },
  () => {
    for (const [name, vertices, triangles] of [
      ["Common_Props_Fences_WoodPlanksGreyPosts1x2", 48, 24],
      ["Common_Props_ChainLinkFence1x1", 96, 48],
      ["Common_Props_ChainLinkFence1x2", 144, 72],
      ["Common_Props_Sidewalks_Small01", 34, 20]
    ] as const) {
      const meshes = decodeCollisionTriangles(
        readFileSync(join(process.env.FORGELIGHT_ASSETS!, name + ".cdt"))
      );
      assert.equal(meshes.length, 1);
      assert.equal(meshes[0].positions.length / 3, vertices);
      assert.equal(meshes[0].indices.length / 3, triangles);
    }
  }
);
