import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadForgelightTerrainCorridor,
  terrainCorridorChunks
} from "../src/utils/forgelightTerrainAssets";
import { surfaceHeights } from "../src/utils/forgelightGeometry";

test("terrain candidate naming preserves recovered Z/X axes for known encounters", () => {
  assert.deepEqual(
    terrainCorridorChunks([968.89, 1635.78], [968.89, 1641.78]),
    [{ name: "Z1_24_12.cnk0", x: 3, z: 6 }]
  );
  assert.deepEqual(
    terrainCorridorChunks([198.51, -925.22], [198.51, -919.22]),
    [{ name: "Z1_-16_0.cnk0", x: 0, z: -4 }]
  );
  assert.deepEqual(
    terrainCorridorChunks([-3359.88, 81.75], [-3359.88, 87.75]),
    [{ name: "Z1_0_-56.cnk0", x: -14, z: 0 }]
  );
});

test("negative coordinates floor away from zero and exact boundaries use adjacent chunks", () => {
  assert.deepEqual(
    terrainCorridorChunks([-0.00001, -0.00001], [-0.00001, -0.00001], 0),
    [{ name: "Z1_-4_-4.cnk0", x: -1, z: -1 }]
  );
  assert.deepEqual(terrainCorridorChunks([-256, -256], [-256, -256], 0), [
    { name: "Z1_-4_-4.cnk0", x: -1, z: -1 }
  ]);
  assert.deepEqual(terrainCorridorChunks([255, 100], [256, 100], 0), [
    { name: "Z1_0_0.cnk0", x: 0, z: 0 },
    { name: "Z1_0_4.cnk0", x: 1, z: 0 }
  ]);
});

test("margin loads all four corner chunks without duplicate names", () => {
  const chunks = terrainCorridorChunks([0, 0], [0, 0]);
  assert.deepEqual(chunks, [
    { name: "Z1_-4_-4.cnk0", x: -1, z: -1 },
    { name: "Z1_0_-4.cnk0", x: -1, z: 0 },
    { name: "Z1_-4_0.cnk0", x: 0, z: -1 },
    { name: "Z1_0_0.cnk0", x: 0, z: 0 }
  ]);
  assert.equal(new Set(chunks.map((c) => c.name)).size, chunks.length);
  assert.deepEqual(
    terrainCorridorChunks([257, 100], [255, 100], 0),
    terrainCorridorChunks([255, 100], [257, 100], 0)
  );
});

test("corridor rejects excessive chunk counts, coordinates and margins", () => {
  assert.equal(terrainCorridorChunks([0, 0], [768, 0], 0).length, 4);
  for (const end of [
    [1024, 0],
    [512, 512],
    [33024, 0],
    [-33025, 0]
  ] as const)
    assert.throws(() => terrainCorridorChunks([0, 0], end, 0), /bounded/);
  for (const margin of [-1, 33, NaN, Infinity])
    assert.throws(
      () => terrainCorridorChunks([1, 1], [2, 2], margin),
      /Invalid/
    );
  for (const coordinate of [NaN, Infinity, -Infinity])
    assert.throws(
      () => terrainCorridorChunks([coordinate, 0], [0, 0]),
      /Invalid/
    );
});

test("runtime malformed coordinate tuples cannot silently produce an empty corridor", () => {
  for (const malformed of [[], [0], [0, 0, 0]]) {
    const tuple = malformed as unknown as readonly [number, number];
    assert.throws(() => terrainCorridorChunks(tuple, [0, 0]), /Invalid/);
    assert.throws(() => terrainCorridorChunks([0, 0], tuple), /Invalid/);
  }
});

test("loader rejects malformed compressed header before invoking a decoder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "h1z1-terrain-assets-test-"));
  const input = join(directory, "Z1_24_12.cnk0");
  try {
    for (const variant of [
      "magic",
      "version",
      "output-size",
      "compressed-size"
    ] as const) {
      const header = Buffer.alloc(16);
      header.write("CNK0", 0, "ascii");
      header.writeUInt32LE(2, 4);
      header.writeUInt32LE(8, 8);
      if (variant === "magic") header.write("WRNG");
      if (variant === "version") header.writeUInt32LE(1, 4);
      if (variant === "output-size") header.writeUInt32LE(16 * 1024 * 1024, 8);
      if (variant === "compressed-size") header.writeUInt32LE(1, 12);
      await writeFile(input, header);
      // Node is not a CNK decoder; seeing the header error proves it never ran.
      await assert.rejects(
        loadForgelightTerrainCorridor(
          directory,
          process.execPath,
          [968.89, 1635.78],
          [968.89, 1641.78]
        ),
        /compressed CNK0 v2 header/
      );
    }
  } finally {
    await unlink(input);
    await rmdir(directory);
  }
});

test(
  "real loader validates named chunk bounds, terrain heights and repeated calls",
  {
    skip:
      !process.env.FORGELIGHT_ASSETS || !process.env.FORGELIGHT_TERRAIN_DECODER
  },
  async () => {
    const root = process.env.FORGELIGHT_ASSETS!;
    const decoder = process.env.FORGELIGHT_TERRAIN_DECODER!;
    const source = join(root, "Z1_24_12.cnk0");
    const before = await stat(source);
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        loadForgelightTerrainCorridor(
          root,
          decoder,
          [968.89, 1635.78],
          [968.89, 1641.78]
        )
      )
    );
    for (const loaded of results) {
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].tileCount, 16);
      assert.equal(loaded[0].batchCount, 156);
      const heights = surfaceHeights(loaded[0], 968.89001465, 1641.7800293);
      assert.equal(heights.length, 1);
      assert.ok(Math.abs(heights[0] - 78.781883240625) < 1e-6);
      assert.deepEqual(surfaceHeights(loaded[0], 100, 100), []);
    }
    const after = await stat(source);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  }
);

test(
  "real loader resolves all four neighboring chunks across zero axes",
  {
    skip:
      !process.env.FORGELIGHT_ASSETS || !process.env.FORGELIGHT_TERRAIN_DECODER
  },
  async () => {
    const meshes = await loadForgelightTerrainCorridor(
      process.env.FORGELIGHT_ASSETS!,
      process.env.FORGELIGHT_TERRAIN_DECODER!,
      [-0.1, -0.1],
      [0.1, 0.1]
    );
    assert.equal(meshes.length, 4);
    const expected = terrainCorridorChunks([-0.1, -0.1], [0.1, 0.1]);
    meshes.forEach((mesh, i) => {
      const bounds = [Infinity, -Infinity, Infinity, -Infinity];
      for (const index of mesh.indices) {
        const x = mesh.positions[index * 3],
          z = mesh.positions[index * 3 + 2];
        bounds[0] = Math.min(bounds[0], x);
        bounds[1] = Math.max(bounds[1], x);
        bounds[2] = Math.min(bounds[2], z);
        bounds[3] = Math.max(bounds[3], z);
      }
      assert.deepEqual(bounds, [
        expected[i].x * 256,
        (expected[i].x + 1) * 256,
        expected[i].z * 256,
        (expected[i].z + 1) * 256
      ]);
    });
  }
);
