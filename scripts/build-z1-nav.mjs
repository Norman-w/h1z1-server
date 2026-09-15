/**
 * Build z1.bin from merged geometry binary (from h1z1-nav-extract merge_obj.py).
 * Usage: node scripts/build-z1-nav.mjs [path/to/merged_geometry.bin] [path/to/z1.bin]
 * Default: ../h1z1-nav-extract/out/merged_geometry.bin -> data/2016/navData/z1.bin
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { init, exportNavMesh } from "recast-navigation";
import { generateSoloNavMesh, generateTiledNavMesh, generateSoloNavMeshData } from "recast-navigation/generators";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const defaultInput = resolve(root, "../h1z1-nav-extract/out/merged_geometry.bin");
const defaultOutput = resolve(root, "data/2016/navData/z1.bin");

const args = process.argv.slice(2);
const testMode = args.includes("--test");
const debugMode = args.includes("--debug");
const maxTrisArg = args.find((a) => a.startsWith("--max-tris="));
const maxTris = maxTrisArg ? parseInt(maxTrisArg.split("=")[1], 10) : 0;
const nonOpt = args.filter((a) => !a.startsWith("-"));
const inputPath = testMode ? defaultInput : (nonOpt[0] || defaultInput);
const outputPath = testMode ? (nonOpt[0] || defaultOutput) : (nonOpt[1] || defaultOutput);

let positions, indices;
if (testMode) {
  // Recast Y-up: quad in XZ plane. Library uses numVertices=indices.length (bug), so pass 6 verts for 2 tris.
  console.log("Using built-in test quad (32x32 at y=0)");
  // 6 vertices = 2 tris * 3 verts (tri0: 0,1,2  tri1: 3,4,5)
  positions = new Float32Array([
    0, 0, 0, 32, 0, 0, 32, 0, 32,   // tri0
    0, 0, 32, 0, 0, 0, 32, 0, 0     // tri1
  ]);
  indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
} else {
  console.log("Loading geometry from", inputPath);
  const buf = readFileSync(inputPath);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  const nVerts = dv.getUint32(o, true);
  o += 4;
  const nIndices = dv.getUint32(o, true);
  o += 4;
  positions = new Float32Array(nVerts * 3);
  for (let i = 0; i < positions.length; i++) {
    positions[i] = dv.getFloat32(o + i * 4, true);
  }
  o += nVerts * 4 * 3;
  indices = new Uint32Array(nIndices);
  for (let i = 0; i < nIndices; i++) {
    indices[i] = dv.getUint32(o + i * 4, true);
  }
  let nIdx = nIndices;
  if (maxTris > 0 && nIndices / 3 > maxTris) {
    nIdx = maxTris * 3;
    indices = new Uint32Array(indices.buffer, indices.byteOffset, nIdx);
    indices = new Uint32Array(indices);
    console.log("Capped to", maxTris, "triangles");
  }
  // Generator expects "triangle soup": positions length = indices.length*3, indices = [0,1,2,...,nIndices-1]
  const expanded = new Float32Array(nIdx * 3);
  for (let i = 0; i < nIdx; i++) {
    const j = indices[i] * 3;
    expanded[i * 3] = positions[j];
    expanded[i * 3 + 1] = positions[j + 1];
    expanded[i * 3 + 2] = positions[j + 2];
  }
  positions = expanded;
  indices = new Uint32Array(nIdx);
  for (let i = 0; i < nIdx; i++) indices[i] = i;
  console.log("Positions (expanded):", positions.length / 3, "| Triangles:", nIdx / 3);
}

console.log("Initializing Recast...");
await init();

console.log("Building NavMesh (this may take a while)...");
const genConfig = testMode ? {
  cs: 0.5,
  ch: 0.5,
  walkableHeight: 2,
  walkableRadius: 0.5,
  walkableClimb: 0.5,
  walkableSlopeAngle: 45,
  buildBvTree: false,
} : {
  cs: 1,
  ch: 0.5,
  walkableHeight: 2,
  walkableRadius: 0.5,
  walkableClimb: 0.5,
  walkableSlopeAngle: 45,
  tileSize: 32,
  buildBvTree: false,
};
const numTris = indices.length / 3;
const useTiledFirst = !testMode && numTris > 5000; // Solo can hit WASM OOB on larger meshes
let navMesh;
let result;
if (useTiledFirst) {
  console.log("Using Tiled (mesh too large for Solo)...");
  result = generateTiledNavMesh(positions, indices, genConfig);
} else {
  result = generateSoloNavMesh(positions, indices, genConfig);
  if (!result.success) {
    if (debugMode) {
      const dataResult = generateSoloNavMeshData(positions, indices, genConfig, true);
      if (dataResult.intermediates?.polyMesh) {
        const pm = dataResult.intermediates.polyMesh;
        console.error("Debug: polyMesh npolys=" + pm.npolys() + " nverts=" + pm.nverts());
      }
    }
    console.warn("Solo failed:", result.error, "- trying Tiled...");
    result = generateTiledNavMesh(positions, indices, genConfig);
  }
}
if (!result.success) {
  console.error("NavMesh generation failed:", result.error);
  process.exit(1);
}
navMesh = result.navMesh;

console.log("Exporting to binary...");
const bin = exportNavMesh(navMesh);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, bin);
console.log("Wrote", outputPath, "| size:", bin.length, "bytes");
process.exit(0);
