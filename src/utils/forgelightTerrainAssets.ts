/** Local, bounded terrain preparation for the experimental single-NPC encounter. */
import { execFile } from "node:child_process";
import { mkdtemp, open, readFile, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { decodeTerrainV2, TerrainGeometry } from "./forgelightGeometry";

const runFile = promisify(execFile);
const MAX_BYTES = 16 * 1024 * 1024;
const cache = new Map<string, Promise<TerrainGeometry>>();

/** Candidate names only: decoded coordinate coverage is validated after loading. */
export function terrainCorridorChunks(
  start: readonly [number, number], end: readonly [number, number], margin = 8
): { name: string; x: number; z: number }[] {
  if (start.length !== 2 || end.length !== 2 ||
      ![...start, ...end, margin].every(Number.isFinite) || margin < 0 || margin > 32)
    throw new Error("Invalid terrain corridor");
  const minX = Math.floor((Math.min(start[0], end[0]) - margin) / 256);
  const maxX = Math.floor((Math.max(start[0], end[0]) + margin) / 256);
  const minZ = Math.floor((Math.min(start[1], end[1]) - margin) / 256);
  const maxZ = Math.floor((Math.max(start[1], end[1]) + margin) / 256);
  if ((maxX - minX + 1) * (maxZ - minZ + 1) > 4 ||
      [minX, maxX, minZ, maxZ].some(value => Math.abs(value) > 128))
    throw new Error("Terrain corridor exceeds bounded encounter area");
  const chunks: { name: string; x: number; z: number }[] = [];
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) chunks.push({ name: `Z1_${z * 4}_${x * 4}.cnk0`, x, z });
  }
  return chunks;
}

async function decodeLocalChunk(
  root: string, decoder: string, chunk: { name: string; x: number; z: number }
): Promise<TerrainGeometry> {
  const input = await realpath(resolve(root, chunk.name));
  const child = relative(root, input);
  if (!child || child.startsWith("..") || isAbsolute(child))
    throw new Error("Terrain asset path escapes configured root");
  const inputStat = await stat(input);
  if (!inputStat.isFile() || inputStat.size < 16 || inputStat.size > MAX_BYTES)
    throw new Error("Terrain compressed asset exceeds size bounds");
  const key = `${decoder}|${input}|${inputStat.mtimeMs}|${inputStat.size}`;
  const prior = cache.get(key);
  if (prior) {
    cache.delete(key);
    cache.set(key, prior);
    return prior;
  }
  const pending = (async () => {
    const header = Buffer.alloc(16);
    const file = await open(input, "r");
    try {
      if ((await file.read(header, 0, 16, 0)).bytesRead !== 16)
        throw new Error("Truncated compressed CNK header");
    } finally { await file.close(); }
    const expectedBytes = header.readUInt32LE(8) + 8;
    if (header.toString("ascii", 0, 4) !== "CNK0" || header.readUInt32LE(4) !== 2 ||
        expectedBytes < 16 || expectedBytes > MAX_BYTES ||
        header.readUInt32LE(12) + 16 !== inputStat.size)
      throw new Error("Invalid or unsupported compressed CNK0 v2 header");
    const temporary = await mkdtemp(join(tmpdir(), "h1z1-terrain-"));
    const output = join(temporary, "decoded.cnk0");
    try {
      // Existing local decoder; no shell, no visible helper window, no source overwrite.
      await runFile(decoder, ["d", input, output], {
        windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024
      });
      if ((await stat(output)).size !== expectedBytes)
        throw new Error("Decompressed terrain size does not match its header");
      const bytes = await readFile(output);
      if (bytes.length !== expectedBytes) throw new Error("Terrain output size changed");
      const result = decodeTerrainV2(bytes);
      const bounds = [Infinity, -Infinity, Infinity, -Infinity];
      for (const index of result.indices) {
        bounds[0] = Math.min(bounds[0], result.positions[index * 3]);
        bounds[1] = Math.max(bounds[1], result.positions[index * 3]);
        bounds[2] = Math.min(bounds[2], result.positions[index * 3 + 2]);
        bounds[3] = Math.max(bounds[3], result.positions[index * 3 + 2]);
      }
      const expected = [chunk.x * 256, (chunk.x + 1) * 256, chunk.z * 256, (chunk.z + 1) * 256];
      if (bounds.some((value, axis) => Math.abs(value - expected[axis]) > 0.001))
        throw new Error("Decoded terrain does not cover the named chunk");
      return result;
    } finally {
      // Only our fixed output and unique empty temp directory; never recursive removal.
      await unlink(output).catch(error => { if (error.code !== "ENOENT") throw error; });
      await rmdir(temporary);
    }
  })();
  cache.set(key, pending);
  while (cache.size > 8) cache.delete(cache.keys().next().value!);
  try { return await pending; }
  catch (error) { if (cache.get(key) === pending) cache.delete(key); throw error; }
}

export async function loadForgelightTerrainCorridor(
  assetRoot: string, decoderPath: string,
  start: readonly [number, number], end: readonly [number, number]
): Promise<TerrainGeometry[]> {
  const [root, decoder] = await Promise.all([realpath(assetRoot), realpath(decoderPath)]);
  const chunks = terrainCorridorChunks(start, end);
  // At most four decodes; all preparation finishes before an NPC enters its AI tick.
  return Promise.all(chunks.map(chunk => decodeLocalChunk(root, decoder, chunk)));
}
