import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createForgelightTerrainFollowBinding } from "../src/utils/forgelightTerrainFollow";
import {
  decodeTerrainV2,
  surfaceHeights
} from "../src/utils/forgelightGeometry";
import type { TriangleMesh } from "../src/utils/forgelightGeometry";

function strip(
  points: readonly (readonly [number, number])[],
  z = 1
): TriangleMesh {
  const positions: number[] = [],
    indices: number[] = [];
  for (const [x, y] of points) positions.push(x, y, -z, x, y, z);
  for (let i = 0; i < points.length - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices)
  };
}

function binding(
  terrain: TriangleMesh | readonly TriangleMesh[],
  spawnXZ: readonly [number, number] = [6, 0],
  player = [0, 0, 0],
  extra = {}
) {
  return createForgelightTerrainFollowBinding({
    terrain,
    standingPlayerPosition: player,
    spawnXZ,
    npcVsPlayerOriginDelta: 0,
    ...extra
  });
}

test("terrain spawn and sequential uphill/downhill steps retain fixed origin and 3D budget", () => {
  const mesh = strip([
    [0, 20],
    [10, 25]
  ]);
  const follow = binding(mesh, [6, 0], [0, 20.3, 0], {
    npcVsPlayerOriginDelta: 0.2
  })!;
  assert.ok(follow);
  assert.ok(Math.abs(follow.npcOriginHeight - 0.5) < 1e-6);
  assert.deepEqual(Array.from(follow.spawnPosition), [6, 23.5, 0]);
  for (const destination of [0.2, 8]) {
    let from =
      destination === 0.2
        ? follow.spawnPosition
        : new Float32Array([0.2, 20.6, 0]);
    for (let i = 0; i < 100 && Math.abs(from[0] - destination) > 0.001; i++) {
      const next = follow.testRouteStep(
        from,
        new Float32Array([destination, 9999, 0]),
        0.25
      );
      assert.ok(next, `stopped at ${Array.from(from)}`);
      assert.ok(Math.hypot(...Array.from(next, (v, k) => v - from[k])) <= 0.25);
      assert.ok(Math.abs(next[1] - (20.5 + next[0] * 0.5)) < 1e-5);
      from = next;
    }
    assert.ok(Math.abs(from[0] - destination) < 0.001);
  }
});

test("target jumping and later standing sample mutation cannot change NPC ground offset", () => {
  const player = [0, 0.4, 0];
  const follow = binding(
    strip([
      [0, 0],
      [10, 0]
    ]),
    [6, 0],
    player
  )!;
  const from = follow.spawnPosition;
  const standing = follow.testRouteStep(
    from,
    new Float32Array([0, 0.4, 0]),
    0.2
  );
  player[1] = 12;
  const jumping = follow.testRouteStep(from, new Float32Array([0, 12, 0]), 0.2);
  assert.deepEqual(jumping, standing);
  assert.ok(Math.abs(jumping![1] - 0.4) < 1e-6);
});

test("missing, layered and steep spawn surfaces are rejected without guessed height", () => {
  const flat = strip([
    [0, 0],
    [10, 0]
  ]);
  assert.equal(binding(flat, [11, 0]), undefined);
  assert.equal(binding(flat, [6, 0], [-1, 0, 0]), undefined);
  assert.equal(
    binding([
      flat,
      strip([
        [0, 2],
        [10, 2]
      ])
    ]),
    undefined
  );
  assert.equal(
    binding(
      strip([
        [0, 0],
        [10, 20]
      ])
    ),
    undefined
  );
  assert.ok(binding([flat, flat]), "same-height duplicate seam is one surface");
});

test("gap, multilayer, steep approach and unavailable target stop without fallback", () => {
  const gap = binding(
    [
      strip([
        [0, 0],
        [1, 0]
      ]),
      strip([
        [1.1, 0],
        [3, 0]
      ])
    ],
    [1, 0]
  )!;
  assert.equal(
    gap.testRouteStep(gap.spawnPosition, new Float32Array([2, 0, 0]), 0.25),
    undefined
  );
  const flat = strip([
    [0, 0],
    [3, 0]
  ]);
  const layered = binding(
    [
      flat,
      strip([
        [1.1, 1],
        [1.2, 1]
      ])
    ],
    [1, 0]
  )!;
  assert.equal(
    layered.testRouteStep(
      layered.spawnPosition,
      new Float32Array([2, 0, 0]),
      0.25
    ),
    undefined
  );
  const steep = binding(
    [
      strip([
        [0, 0],
        [1, 0]
      ]),
      strip([
        [1, 0],
        [2, 2]
      ])
    ],
    [0.9, 0]
  )!;
  assert.equal(
    steep.testRouteStep(
      steep.spawnPosition,
      new Float32Array([1.5, 1, 0]),
      0.25
    ),
    undefined
  );
  const follow = binding(flat, [1, 0])!;
  assert.equal(
    follow.testRouteStep(
      follow.spawnPosition,
      new Float32Array([4, 0, 0]),
      0.25
    ),
    undefined
  );
});

test("surface corners are emitted instead of interpolating through a narrow crest", () => {
  const follow = binding(
    strip([
      [0, 0],
      [1, 0],
      [1.1, 0.08],
      [1.2, 0],
      [3, 0]
    ]),
    [0.95, 0]
  )!;
  let from = follow.spawnPosition;
  const seen: Float32Array[] = [];
  for (let i = 0; i < 25 && from[0] < 1.3; i++) {
    const next = follow.testRouteStep(from, new Float32Array([2, 0, 0]), 0.25);
    assert.ok(next, `stopped at crest ${Array.from(from)}`);
    assert.ok(Math.hypot(...Array.from(next, (v, k) => v - from[k])) <= 0.25);
    seen.push(next);
    from = next;
  }
  assert.ok(
    seen.some(
      (p) => Math.abs(p[0] - 1.1) < 1e-5 && Math.abs(p[1] - 0.08) < 1e-5
    )
  );
  assert.ok(from[0] >= 1.3);
});

test("seam crossing, owned geometry, tiny budgets and invalid inputs remain bounded", () => {
  const first = strip([
      [-1, 0],
      [0, 0]
    ]),
    second = strip([
      [0, 0],
      [1, 0]
    ]);
  const follow = binding([first, second], [-0.1, 0], [-0.5, 0, 0])!;
  first.positions.fill(100);
  second.indices.fill(0);
  let from = follow.spawnPosition;
  for (let i = 0; i < 5 && from[0] < 0.4; i++) {
    const next = follow.testRouteStep(
      from,
      new Float32Array([0.5, 0, 0]),
      0.25
    );
    assert.ok(next);
    from = next;
  }
  assert.ok(from[0] >= 0.4);
  for (const budget of [0, -1, NaN, Infinity, 1e-20])
    assert.equal(
      follow.testRouteStep(from, new Float32Array([0, 0, 0]), budget),
      undefined
    );
  assert.equal(
    follow.testRouteStep(
      new Float32Array([0, 1, 0]),
      new Float32Array([0.5, 0, 0]),
      0.25
    ),
    undefined
  );
  assert.throws(() => binding(first, [0, 0], [0, NaN, 0]), /Invalid/);
  assert.throws(
    () => binding(first, [0, 0], [0, 0, 0], { maxSampleDistance: 10 }),
    /Invalid/
  );
});

test("coplanar seams do not consume a tick as a short route step", () => {
  const mesh = strip([
    [0, 0],
    [0.1, 0],
    [0.2, 0],
    [0.3, 0],
    [1, 0]
  ]);
  const follow = binding([mesh, mesh], [0.075, 0])!;
  const next = follow.testRouteStep(
    follow.spawnPosition,
    new Float32Array([0.8, 0, 0]),
    0.25
  );
  assert.ok(next);
  const distance = next[0] - follow.spawnPosition[0];
  assert.ok(distance > 0.249, `seam consumed the tick: ${distance}`);
  assert.ok(distance <= 0.25);
});

test("centimetre-identical seam endpoints do not emit a false zero-speed route step", () => {
  for (const seamZ of [-642, 642]) {
    for (const direction of [-1, 1]) {
      const mesh = strip([
        [seamZ - 2, 46.38],
        [seamZ, 46.38],
        [seamZ + 2, 46.38]
      ]);
      // Turn the strip into the observed world-axis layout, without a live asset.
      for (let i = 0; i < mesh.positions.length; i += 3) {
        const z = mesh.positions[i];
        mesh.positions[i] = 1492 + mesh.positions[i + 2];
        mesh.positions[i + 2] = z;
      }
      const follow = binding(
        mesh,
        [1492, seamZ - direction * 0.0014],
        [1492, 46.38, seamZ - 1]
      )!;
      const from = follow.spawnPosition;
      assert.equal(Math.round(from[2] * 100), Math.round(seamZ * 100));
      const next = follow.testRouteStep(
        from,
        new Float32Array([1492, 46.38, seamZ + direction]),
        0.25
      );
      assert.ok(next);
      const wireDistance =
        (direction * (Math.round(next[2] * 100) - Math.round(from[2] * 100))) /
        100;
      assert.ok(
        wireDistance >= 0.24,
        `false short/zero wire step at ${seamZ}: ${wireDistance}`
      );
      assert.ok(Math.hypot(...Array.from(next, (v, k) => v - from[k])) <= 0.25);
    }
  }
});

test("coplanar sloped seams retain the full bounded 3D step", () => {
  const mesh = strip([
    [0, 0],
    [0.1, 0.02],
    [0.2, 0.04],
    [1, 0.2]
  ]);
  const follow = binding(mesh, [0.075, 0])!;
  const from = follow.spawnPosition;
  const next = follow.testRouteStep(
    from,
    new Float32Array([0.8, 999, 0]),
    0.25
  );
  assert.ok(next);
  const distance = Math.hypot(...Array.from(next, (v, k) => v - from[k]));
  assert.ok(distance > 0.249, `sloped seam consumed the tick: ${distance}`);
  assert.ok(distance <= 0.25);
  assert.ok(Math.abs(next[1] - next[0] * 0.2) < 0.001);
});

test("a later hidden gap, layer or steep interval cannot be crossed by a merged chord", () => {
  const left = strip([
    [0, 0],
    [1, 0]
  ]);
  const middle = strip([
    [1, 0],
    [1.04, 0]
  ]);
  const right = strip([
    [1.06, 0],
    [2, 0]
  ]);
  const flat = strip([
    [0, 0],
    [1, 0],
    [2, 0]
  ]);
  const cases = [
    { name: "gap", meshes: [left, middle, right] },
    {
      name: "layer",
      meshes: [
        flat,
        strip([
          [1.04, 0.1],
          [1.06, 0.1]
        ])
      ]
    },
    {
      name: "steep",
      meshes: [
        strip([
          [0, 0],
          [1, 0],
          [1.04, 0],
          [1.05, 0.04],
          [1.06, 0],
          [2, 0]
        ])
      ]
    }
  ];
  for (const { name, meshes } of cases) {
    const follow = binding(meshes, [0.95, 0])!;
    const next = follow.testRouteStep(
      follow.spawnPosition,
      new Float32Array([1.5, 0, 0]),
      0.25
    );
    // Both candidate endpoints are safe and flat. The intervening bad interval
    // must still block merging; only the original safe prefix may be returned.
    assert.ok(next, `${name}: original known prefix should remain usable`);
    assert.ok(next[0] <= 1, `${name}: crossed an unverified interval`);
    assert.ok(Math.abs(next[1]) < 1e-6);
  }
});

test("same-height chord endpoints do not hide a gentle interior crest", () => {
  const mesh = strip([
    [0, 0],
    [1, 0],
    [1.04, 0],
    [1.06, 0.01],
    [1.08, 0],
    [2, 0]
  ]);
  const follow = binding(mesh, [0.95, 0])!;
  const next = follow.testRouteStep(
    follow.spawnPosition,
    new Float32Array([1.5, 0, 0]),
    0.25
  );
  assert.ok(next);
  assert.ok(
    next[0] <= 1,
    "cannot replace the interior crest with a flat chord"
  );
});

test("dense crossing lists retain the original safe prefix instead of an unbounded merge", () => {
  const mesh = strip(
    Array.from({ length: 301 }, (_, i) => [i * 0.001, 0] as const)
  );
  const follow = binding(mesh, [0, 0])!;
  const next = follow.testRouteStep(
    follow.spawnPosition,
    new Float32Array([0.28, 0, 0]),
    0.25
  );
  assert.ok(next);
  assert.ok(next[0] > 0 && next[0] < 0.002);
  assert.equal(next[1], 0);
});

test("merged diagonal and boundary-touching chords retain target, sample and small-budget limits", () => {
  const mesh = strip(
    Array.from({ length: 21 }, (_, i) => [i * 0.05, 0] as const)
  );
  for (const [spawn, target, budget, expected] of [
    [[0.075, -0.1], [0.8, 0, 0.35], 0.25, 0.25],
    [[0, 0], [0.25, 0, 0], 0.25, 0.25], // contacts at both t=0 and t=1
    [[0.09995, 0], [0.8, 0, 0], 0.0001, 0.0001],
    [[0.075, 0], [0.09, 0, 0], 0.25, 0.015]
  ] as const) {
    const follow = binding(mesh, spawn)!;
    const from = follow.spawnPosition;
    const next = follow.testRouteStep(from, new Float32Array(target), budget);
    assert.ok(next);
    const distance = Math.hypot(...Array.from(next, (v, k) => v - from[k]));
    assert.ok(distance <= budget);
    assert.ok(Math.abs(distance - expected) < 1e-5);
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const x: number = from[0] + (next[0] - from[0]) * t;
      const z: number = from[2] + (next[2] - from[2]) * t;
      assert.deepEqual(surfaceHeights(mesh, x, z), [0]);
    }
  }
  const follow = binding(mesh, [0.075, 0], [0, 0, 0], {
    maxSampleDistance: 0.1
  })!;
  const next = follow.testRouteStep(
    follow.spawnPosition,
    new Float32Array([0.8, 0, 0]),
    0.25
  )!;
  assert.ok(next[0] - follow.spawnPosition[0] <= 0.1);
  assert.ok(next[0] - follow.spawnPosition[0] > 0.099);
});

test("large world Float32 coordinates do not exceed exact movement budget", () => {
  const follow = binding(
    strip([
      [968, 76],
      [975, 78]
    ]),
    [974, 0],
    [968, 76, 0]
  )!;
  let from = follow.spawnPosition;
  for (let i = 0; i < 20; i++) {
    const next = follow.testRouteStep(
      from,
      new Float32Array([968, 999, 0]),
      0.25
    );
    assert.ok(next);
    assert.ok(Math.hypot(...Array.from(next, (v, k) => v - from[k])) <= 0.25);
    from = next;
  }
});

test("many rounded triangle seams do not stall at positive or negative world coordinates", () => {
  for (const startX of [0, 968, 6000, -3359.88]) {
    const mesh = strip(
      Array.from(
        { length: 41 },
        (_, i) => [startX + i * 0.2, 80 + Math.sin(i) * 0.07] as const
      )
    );
    const origin = mesh.positions[0];
    const follow = binding(mesh, [origin, 0], [origin, 80, 0])!;
    let from = follow.spawnPosition;
    const target = new Float32Array([
      mesh.positions[mesh.positions.length - 6],
      999,
      0
    ]);
    for (let i = 0; i < 200 && Math.abs(from[0] - target[0]) > 0.001; i++) {
      const next = follow.testRouteStep(from, target, 0.25);
      assert.ok(next, `rounded seam at ${Array.from(from)}`);
      assert.ok(Math.hypot(...Array.from(next, (v, k) => v - from[k])) <= 0.25);
      for (let j = 0; j <= 5; j++) {
        const t = j / 5;
        const p = Array.from(from, (v, k) => v + (next[k] - v) * t);
        const heights = surfaceHeights(mesh, p[0], p[2]);
        assert.equal(heights.length, 1);
        assert.ok(Math.abs(p[1] - heights[0] - follow.npcOriginHeight) < 0.001);
      }
      from = next;
    }
    assert.ok(Math.abs(from[0] - target[0]) <= 0.001);
  }
});

test(
  "real Z1_24_12 slope reproduces ground-corrected spawn and continuous approach",
  {
    skip: !process.env.FORGELIGHT_SLOPE_TERRAIN_DECOMPRESSED
  },
  () => {
    const mesh = decodeTerrainV2(
      readFileSync(process.env.FORGELIGHT_SLOPE_TERRAIN_DECOMPRESSED!)
    );
    const follow = binding(
      mesh,
      [968.89001465, 1641.7800293],
      [968.89001465, 76.95, 1635.78]
    )!;
    assert.ok(follow);
    assert.ok(Math.abs(follow.spawnPosition[1] - 78.7781829834) < 1e-5);
    let from = follow.spawnPosition;
    const target = new Float32Array([968.89001465, 1000, 1635.78]);
    for (let i = 0; i < 100 && Math.abs(from[2] - target[2]) > 2.4; i++) {
      const next = follow.testRouteStep(from, target, 0.25);
      assert.ok(next);
      assert.ok(Math.hypot(...Array.from(next, (v, k) => v - from[k])) <= 0.25);
      for (let j = 0; j <= 10; j++) {
        const t = j / 10;
        const p = Array.from(from, (v, k) => v + (next[k] - v) * t);
        const heights = surfaceHeights(mesh, p[0], p[2]);
        assert.equal(heights.length, 1);
        assert.ok(Math.abs(p[1] - heights[0] - follow.npcOriginHeight) < 0.001);
      }
      from = next;
    }
    assert.ok(Math.abs(from[2] - target[2]) <= 2.4);
  }
);
