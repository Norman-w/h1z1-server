/**
 * Asset-derived geometry for experimental NPC collision/navigation queries.
 * Does not assign character origin offsets, collision masks, or native AI rules.
 * CNK input must already be decompressed; decompression is deliberately external.
 */
export interface TriangleMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface SceneSegmentHit extends SegmentHit {
  meshId: string;
}

/**
 * Immutable snapshot of explicitly supplied world-space collision meshes.
 * Bounds use referenced vertices, not placement origins. A missing hit only
 * means no supplied triangle blocks the segment: callers must separately
 * establish asset coverage, collision masks, dynamic state and body clearance.
 * Mesh-level broad phase, not a whole-world navigation system or triangle BVH.
 */
export class StaticTriangleScene {
  private readonly entries: {
    id: string;
    mesh: TriangleMesh;
    min: number[];
    max: number[];
    margin: number;
  }[] = [];

  constructor(meshes: Iterable<{ id: string; mesh: TriangleMesh }>) {
    const ids = new Set<string>();
    for (const { id, mesh } of meshes) {
      if (!id || ids.has(id))
        throw new Error("Scene mesh IDs must be unique and nonempty");
      ids.add(id);
      if (mesh.positions.length % 3 || mesh.indices.length % 3)
        throw new Error("Invalid scene mesh dimensions");
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (const index of mesh.indices) {
        if (index >= mesh.positions.length / 3)
          throw new Error("Scene triangle index out of bounds");
        for (let axis = 0; axis < 3; axis++) {
          const value = mesh.positions[index * 3 + axis];
          if (!Number.isFinite(value))
            throw new Error("Non-finite scene vertex");
          min[axis] = Math.min(min[axis], value);
          max[axis] = Math.max(max[axis], value);
        }
      }
      if (!mesh.indices.length) continue;
      this.entries.push({
        id,
        mesh: {
          positions: mesh.positions.slice(),
          indices: mesh.indices.slice()
        },
        min,
        max,
        // Conservatively include narrow-phase edge/plane tolerances.
        margin: 1e-6 + Math.max(...max.map((v, axis) => v - min[axis])) * 1e-7
      });
    }
  }

  /** Owned copies for offline navigation builds; cannot mutate this scene. */
  snapshotMeshes(): { id: string; mesh: TriangleMesh }[] {
    return this.entries.map(({ id, mesh }) => ({
      id,
      mesh: {
        positions: mesh.positions.slice(),
        indices: mesh.indices.slice()
      }
    }));
  }

  intersectSegment(
    start: ArrayLike<number>,
    end: ArrayLike<number>
  ): SceneSegmentHit | undefined {
    for (const point of [start, end]) {
      if (
        point.length < 3 ||
        ![point[0], point[1], point[2]].every(Number.isFinite)
      )
        throw new Error("Invalid scene segment coordinates");
    }
    let closest: SceneSegmentHit | undefined;
    for (const entry of this.entries) {
      if (
        [0, 1, 2].some(
          (axis) =>
            Math.max(start[axis], end[axis]) < entry.min[axis] - entry.margin ||
            Math.min(start[axis], end[axis]) > entry.max[axis] + entry.margin
        )
      )
        continue;
      const hit = intersectSegment(entry.mesh, start, end);
      if (hit && (!closest || hit.fraction < closest.fraction))
        closest = { ...hit, meshId: entry.id };
    }
    return closest;
  }
}

export interface ZonePlacement {
  actor: string;
  position: [number, number, number, number];
  /** Raw zone values, not a quaternion; actor-creation conversion is separate. */
  rotation: [number, number, number, number];
  scale: [number, number, number, number];
}

export type StaticActorGeometry =
  | { kind: "independent-static"; assetScale: number; meshes: TriangleMesh[] }
  | { kind: "unsupported"; reason: string };

export interface GeometryBounds {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * Scan every placement, retaining only supported meshes whose WORLD bounds
 * overlap the requested box. Resource resolution is cached once per actor.
 * The resolver must establish independent static geometry/masks/asset scale;
 * this API does not infer that from an ADR name, visibility or absent CDT.
 * Unknown bounds cannot safely be discarded by origin distance, so unsupported
 * resources are reported globally. Successful parsing is not complete coverage.
 */
export function buildLocalStaticScene(
  zone: Buffer,
  bounds: GeometryBounds,
  resolveActor: (actor: string) => StaticActorGeometry,
  maxTriangles = 250000
): {
  scene: StaticTriangleScene;
  placementsScanned: number;
  placementsIncluded: number;
  trianglesIncluded: number;
  unsupported: { actor: string; reason: string; instances: number }[];
} {
  if (!Number.isSafeInteger(maxTriangles) || maxTriangles < 0)
    throw new Error("Invalid scene triangle budget");
  for (let axis = 0; axis < 3; axis++) {
    if (
      !Number.isFinite(bounds.min[axis]) ||
      !Number.isFinite(bounds.max[axis]) ||
      bounds.min[axis] > bounds.max[axis]
    )
      throw new Error("Invalid local scene bounds");
  }
  const cache = new Map<
    string,
    { source: StaticActorGeometry; boxes: TriangleMesh[] }
  >();
  const unsupported = new Map<
    string,
    { actor: string; reason: string; instances: number }
  >();
  const selected: { id: string; mesh: TriangleMesh }[] = [];
  let placementsScanned = 0,
    placementsIncluded = 0,
    trianglesIncluded = 0;
  const boxFor = (mesh: TriangleMesh): TriangleMesh => {
    if (mesh.positions.length % 3 || mesh.indices.length % 3)
      throw new Error("Invalid static resource mesh dimensions");
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (const index of mesh.indices) {
      if (index >= mesh.positions.length / 3)
        throw new Error("Static resource index out of bounds");
      for (let axis = 0; axis < 3; axis++) {
        const value = mesh.positions[index * 3 + axis];
        if (!Number.isFinite(value))
          throw new Error("Non-finite static resource vertex");
        min[axis] = Math.min(min[axis], value);
        max[axis] = Math.max(max[axis], value);
      }
    }
    if (!mesh.indices.length)
      return { positions: new Float32Array(), indices: new Uint32Array() };
    const corners = new Float32Array(24);
    for (let corner = 0; corner < 8; corner++)
      for (let axis = 0; axis < 3; axis++)
        corners[corner * 3 + axis] =
          corner & (1 << axis) ? max[axis] : min[axis];
    // Referencing all eight corners is enough for bounds transformation; these
    // synthetic triangles are NEVER inserted into the collision scene.
    return {
      positions: corners,
      indices: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 0])
    };
  };
  visitZonePlacementsV4(zone, (placement) => {
    const index = placementsScanned++;
    let cached = cache.get(placement.actor);
    if (!cached) {
      const source = resolveActor(placement.actor);
      if (
        source.kind === "independent-static" &&
        (!Number.isFinite(source.assetScale) ||
          source.assetScale <= 0 ||
          !source.meshes.length)
      )
        throw new Error(
          "Static resource requires geometry and positive asset scale"
        );
      cached = {
        source,
        boxes:
          source.kind === "independent-static" ? source.meshes.map(boxFor) : []
      };
      cache.set(placement.actor, cached);
    }
    if (cached.source.kind === "unsupported") {
      const item = unsupported.get(placement.actor) ?? {
        actor: placement.actor,
        reason: cached.source.reason,
        instances: 0
      };
      item.instances++;
      unsupported.set(placement.actor, item);
      return;
    }
    let included = false;
    for (let part = 0; part < cached.source.meshes.length; part++) {
      const box = cached.boxes[part];
      if (!box.indices.length) continue;
      const transformed = transformActorLocalMesh(
        box,
        placement,
        cached.source.assetScale
      ).positions;
      let overlaps = true;
      for (let axis = 0; axis < 3; axis++) {
        let min = Infinity,
          max = -Infinity;
        for (let i = axis; i < transformed.length; i += 3) {
          min = Math.min(min, transformed[i]);
          max = Math.max(max, transformed[i]);
        }
        const margin = 1e-6 + (max - min) * 1e-7;
        if (max < bounds.min[axis] - margin || min > bounds.max[axis] + margin)
          overlaps = false;
      }
      if (!overlaps) continue;
      const mesh = cached.source.meshes[part];
      trianglesIncluded += mesh.indices.length / 3;
      if (trianglesIncluded > maxTriangles)
        throw new Error("Local scene triangle budget exceeded");
      selected.push({
        id: `${index}:${part}:${placement.actor}`,
        mesh: transformActorLocalMesh(mesh, placement, cached.source.assetScale)
      });
      included = true;
    }
    if (included) placementsIncluded++;
  });
  return {
    scene: new StaticTriangleScene(selected),
    placementsScanned,
    placementsIncluded,
    trianglesIncluded,
    unsupported: [...unsupported.values()]
  };
}

/**
 * Transform geometry ALREADY in actor-local space to absolute world space.
 * Native factory: 140793f30 -> 14144df40/14144ec60 -> 14046c5d0.
 * Row-vector order is S * Rz(rotation[2]) * Rx(rotation[1]) * Ry(rotation[0]).
 * Instance xyz scales are clamped before multiplying by the asset scalar.
 * The caller must resolve the asset scalar and any collision-local transform;
 * parented actors additionally require the full parent transform/scale chain
 * (14144da20 accumulates ancestor scales). This API takes one resolved placement.
 * this does not establish that arbitrary CDT vertices are actor-local, nor
 * reproduce the renderer's world-origin rebasing or an NPC foot offset.
 */
export function transformActorLocalMesh(
  mesh: TriangleMesh,
  placement: Pick<ZonePlacement, "position" | "rotation" | "scale">,
  assetScale: number
): TriangleMesh {
  if (!Number.isFinite(assetScale) || assetScale <= 0)
    throw new Error("A verified positive asset scale is required");
  if (mesh.positions.length % 3 || mesh.indices.length % 3)
    throw new Error("Invalid triangle mesh dimensions");
  for (const vector of [
    placement.position,
    placement.rotation,
    placement.scale
  ]) {
    if (![vector[0], vector[1], vector[2]].every(Number.isFinite))
      throw new Error("Non-finite actor transform");
  }
  for (const index of mesh.indices) {
    if (index >= mesh.positions.length / 3)
      throw new Error("Triangle index outside actor mesh");
  }
  const [yaw, pitch, roll] = placement.rotation;
  const cy = Math.cos(yaw),
    sy = Math.sin(yaw);
  const cx = Math.cos(pitch),
    sx = Math.sin(pitch);
  const cz = Math.cos(roll),
    sz = Math.sin(roll);
  const scale = placement.scale
    .slice(0, 3)
    .map((v) => Math.max(Math.fround(0.01), v) * assetScale);
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    let x = mesh.positions[i] * scale[0];
    let y = mesh.positions[i + 1] * scale[1];
    let z = mesh.positions[i + 2] * scale[2];
    [x, y] = [x * cz - y * sz, x * sz + y * cz];
    [y, z] = [y * cx - z * sx, y * sx + z * cx];
    [x, z] = [x * cy + z * sy, -x * sy + z * cy];
    positions[i] = x + placement.position[0];
    positions[i + 1] = y + placement.position[1];
    positions[i + 2] = z + placement.position[2];
    if (
      ![positions[i], positions[i + 1], positions[i + 2]].every(Number.isFinite)
    )
      throw new Error("Non-finite transformed actor vertex");
  }
  return { positions, indices: mesh.indices.slice() };
}

/**
 * Visit all ZONE v4 placements without retaining the entire world in memory.
 * Native 141e8e9f0 -> 1413f81a0/1413f7e40: instance tails are VARIABLE length.
 * Only the object section is parsed; its end must match the lights offset.
 */
export function visitZonePlacementsV4(
  data: Buffer,
  visit: (placement: ZonePlacement) => void
): { groups: number; instances: number } {
  const header = new Reader(data);
  header.magic("ZONE");
  if (header.u32() !== 4 || header.u32() !== 7) {
    throw new Error("Only ZONE v4 with seven section offsets is supported");
  }
  header.skip(12);
  const objects = header.u32(),
    lights = header.u32();
  if (objects < 76 || lights < objects || lights > data.length) {
    throw new Error("Invalid zone object section bounds");
  }
  const r = new Reader(data.subarray(objects, lights));
  const groups = r.count(9);
  let instances = 0;
  const vector = (): [number, number, number, number] => {
    const at = r.skip(16);
    const result: [number, number, number, number] = [
      r.data.readFloatLE(at),
      r.data.readFloatLE(at + 4),
      r.data.readFloatLE(at + 8),
      r.data.readFloatLE(at + 12)
    ];
    if (!result.every(Number.isFinite))
      throw new Error("Non-finite zone transform");
    return result;
  };
  for (let g = 0; g < groups; g++) {
    const end = r.data.indexOf(0, r.offset);
    if (end < r.offset || end - r.offset > 4096)
      throw new Error("Invalid zone actor name");
    const actor = r.data.toString("utf8", r.offset, end);
    r.skip(end - r.offset + 1);
    r.skip(4); // per-group float, not interpreted
    const count = r.count(77);
    for (let i = 0; i < count; i++) {
      const position = vector(),
        rotation = vector(),
        scale = vector();
      r.skip(9); // u32, flags byte, u32
      for (const width of [8, 8, 12, 20]) r.array(width);
      const strings = r.count(8);
      for (let s = 0; s < strings; s++) {
        r.skip(4); // parameter key
        r.array(1); // explicitly length-prefixed, not NUL-terminated
      }
      instances++;
      visit({ actor, position, rotation, scale });
    }
  }
  if (r.offset !== r.data.length)
    throw new Error("Zone object section does not end at lights offset");
  return { groups, instances };
}

class Reader {
  offset = 0;
  constructor(readonly data: Buffer) {
    if (data.length > 64 * 1024 * 1024)
      throw new Error("Geometry exceeds 64 MiB limit");
  }
  skip(bytes: number): number {
    const start = this.offset;
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > this.data.length - start
    ) {
      throw new Error(
        `Truncated geometry at ${start}, requested ${bytes} bytes`
      );
    }
    this.offset += bytes;
    return start;
  }
  u32(): number {
    return this.data.readUInt32LE(this.skip(4));
  }
  i32(): number {
    return this.data.readInt32LE(this.skip(4));
  }
  count(minBytes: number): number {
    const count = this.u32();
    if (count > (this.data.length - this.offset) / minBytes) {
      throw new Error(`Invalid geometry count ${count} at ${this.offset - 4}`);
    }
    return count;
  }
  array(bytes: number): void {
    this.skip(this.count(bytes) * bytes);
  }
  magic(expected: string): void {
    if (this.data.toString("ascii", this.skip(4), this.offset) !== expected) {
      throw new Error(`Expected ${expected} geometry`);
    }
  }
}

export interface TerrainGeometry extends TriangleMesh {
  tileCount: number;
  batchCount: number;
  /** Uninterpreted suffix: observed Z1 CNK0 v2 has four bytes, float 1. */
  trailingBytes: Buffer;
}

/**
 * Observed Z1 CNK0 v2 layout. Tile coordinates and vertices are in game axes:
 * world X = tile.y*64 + vertex.x; world Z = tile.x*64 + vertex.y.
 * Batches share vertex ranges; a batch ordinal is NOT a tile ordinal.
 */
export function decodeTerrainV2(data: Buffer): TerrainGeometry {
  const r = new Reader(data);
  r.magic("CNK0");
  if (r.u32() !== 2) throw new Error("Only CNK0 v2 is supported");
  const tileCount = r.count(32);
  if (!tileCount || tileCount > 256)
    throw new Error("Invalid terrain tile count");
  const tiles: { x: number; z: number }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < tileCount; i++) {
    const z = r.i32(),
      x = r.i32();
    const key = `${x},${z}`;
    if (seen.has(key)) throw new Error("Duplicate terrain tile coordinates");
    seen.add(key);
    tiles.push({ x, z });
    r.skip(8);
    const ecosystems = r.count(8);
    for (let j = 0; j < ecosystems; j++) {
      r.skip(4);
      const floras = r.count(4);
      for (let k = 0; k < floras; k++) r.array(8);
    }
    r.skip(4); // tile index
    const imageId = r.u32();
    if (imageId) {
      r.skip(4); // v2 field before the length-prefixed image; semantics unknown
      r.array(1);
    }
    r.array(1); // layer textures
  }
  r.skip(4);
  r.array(4); // height-map entries, not the rendered triangle vertices
  const indexCount = r.count(2);
  const indexOffset = r.skip(indexCount * 2);
  const vertexCount = r.count(16);
  const vertexOffset = r.skip(vertexCount * 16);
  const batchCount = r.count(20);
  const batches: { io: number; ic: number; vo: number; vc: number }[] = [];
  const ranges = new Map<number, number>();
  let outputIndexCount = 0;
  for (let i = 0; i < batchCount; i++) {
    r.skip(4); // observed additional batch field, not interpreted
    const io = r.u32(),
      ic = r.u32(),
      vo = r.u32(),
      vc = r.u32();
    if (ic % 3 || io + ic > indexCount || vo + vc > vertexCount || !vc) {
      throw new Error("Invalid terrain batch bounds");
    }
    if (ranges.has(vo) && ranges.get(vo) !== vc)
      throw new Error("Conflicting vertex ranges");
    ranges.set(vo, vc);
    outputIndexCount += ic;
    // Prevent malicious repeated ranges from causing unbounded allocation.
    if (outputIndexCount > indexCount)
      throw new Error("Repeated terrain index coverage");
    batches.push({ io, ic, vo, vc });
  }
  const ordered = [...ranges].sort((a, b) => a[0] - b[0]);
  if (ordered.length !== tileCount)
    throw new Error("Terrain tile/vertex range mismatch");
  let covered = 0;
  const positions = new Float32Array(vertexCount * 3);
  ordered.forEach(([vo, vc], tile) => {
    if (vo !== covered) throw new Error("Non-contiguous terrain vertex ranges");
    covered += vc;
    for (let j = vo; j < vo + vc; j++) {
      const at = vertexOffset + j * 16;
      positions[j * 3] = tiles[tile].x * 64 + data.readInt16LE(at);
      positions[j * 3 + 1] = data.readInt16LE(at + 6) / 32;
      positions[j * 3 + 2] = tiles[tile].z * 64 + data.readInt16LE(at + 2);
    }
  });
  if (covered !== vertexCount) throw new Error("Unmapped terrain vertices");
  const indices = new Uint32Array(outputIndexCount);
  let out = 0,
    nextIndex = 0;
  for (const { io, ic, vo, vc } of [...batches].sort((a, b) => a.io - b.io)) {
    if (io !== nextIndex)
      throw new Error("Non-contiguous terrain index ranges");
    nextIndex += ic;
    for (let j = io; j < io + ic; j++) {
      const index = data.readUInt16LE(indexOffset + j * 2);
      if (index >= vc)
        throw new Error("Terrain triangle index outside vertex range");
      indices[out++] = vo + index;
    }
  }
  if (nextIndex !== indexCount) throw new Error("Unmapped terrain indices");
  for (const width of [320, 2, 12, 64]) r.array(width);
  return {
    positions,
    indices,
    tileCount,
    batchCount,
    trailingBytes: Buffer.from(data.subarray(r.offset))
  };
}

/** CDTA v1/v2 triangle shapes, confirmed against native reader 0x1414e3460. */
export function decodeCollisionTriangles(data: Buffer): TriangleMesh[] {
  const r = new Reader(data);
  r.magic("CDTA");
  const version = r.u32();
  if (version !== 1 && version !== 2)
    throw new Error("Unsupported CDTA version");
  r.skip(4);
  const count = r.count(4);
  const meshes: TriangleMesh[] = [];
  for (let i = 0; i < count; i++) {
    if (r.u32() !== 0) throw new Error("Unsupported CDTA shape type");
    if (version === 2) r.skip(8);
    const vertices = r.count(12);
    if (vertices > 65535)
      throw new Error("CDTA vertex count exceeds uint16 indices");
    const positions = new Float32Array(vertices * 3);
    for (let j = 0; j < positions.length; j++) {
      const value = data.readFloatLE(r.skip(4));
      if (!Number.isFinite(value))
        throw new Error("Non-finite collision vertex");
      positions[j] = value;
    }
    const triangles = r.count(6);
    const indices = new Uint32Array(triangles * 3);
    for (let j = 0; j < indices.length; j++) {
      const index = data.readUInt16LE(r.skip(2));
      if (index >= vertices)
        throw new Error("Collision triangle index outside vertex range");
      indices[j] = index;
    }
    r.array(1); // opaque cooked physics mesh
    meshes.push({ positions, indices });
  }
  if (r.offset !== data.length)
    throw new Error("Unexpected CDTA trailing data");
  return meshes;
}

/** All vertical triangle intersections; no hit is an empty array, never a guessed Y=0. */
export function surfaceHeights(
  mesh: TriangleMesh,
  x: number,
  z: number
): number[] {
  if (!Number.isFinite(x) || !Number.isFinite(z))
    throw new Error("Invalid query coordinates");
  const { positions: p, indices } = mesh;
  const heights: number[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3,
      b = indices[i + 1] * 3,
      c = indices[i + 2] * 3;
    const den =
      (p[b + 2] - p[c + 2]) * (p[a] - p[c]) +
      (p[c] - p[b]) * (p[a + 2] - p[c + 2]);
    if (Math.abs(den) < 1e-9) continue;
    const s =
      ((p[b + 2] - p[c + 2]) * (x - p[c]) + (p[c] - p[b]) * (z - p[c + 2])) /
      den;
    const t =
      ((p[c + 2] - p[a + 2]) * (x - p[c]) + (p[a] - p[c]) * (z - p[c + 2])) /
      den;
    if (Math.min(s, t, 1 - s - t) < -1e-8) continue;
    const y = s * p[a + 1] + t * p[b + 1] + (1 - s - t) * p[c + 1];
    if (!heights.some((v) => Math.abs(v - y) < 1e-6)) heights.push(y);
  }
  return heights.sort((a, b) => a - b);
}

export interface SegmentHit {
  fraction: number;
  triangle: number;
  position: [number, number, number];
}

/**
 * Closest two-sided hit on a CLOSED segment, including coplanar contact.
 * Mesh and endpoints must be in the same coordinate space. A ray is not a
 * character capsule sweep: this alone cannot prove a route has body clearance.
 * Intended for meshes returned by the validated readers above.
 */
export function intersectSegment(
  mesh: TriangleMesh,
  start: ArrayLike<number>,
  end: ArrayLike<number>
): SegmentHit | undefined {
  for (const point of [start, end]) {
    if (
      point.length < 3 ||
      ![point[0], point[1], point[2]].every(Number.isFinite)
    ) {
      throw new Error("Invalid segment coordinates");
    }
  }
  const { positions: p, indices } = mesh;
  let result: SegmentHit | undefined;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3,
      b = indices[i + 1] * 3,
      c = indices[i + 2] * 3;
    const ab = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const ac = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const n = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0]
    ];
    const norm = Math.hypot(...n);
    if (norm < 1e-12) continue; // zero-area triangles have no blocking surface
    const distance = (v: ArrayLike<number>) =>
      (n[0] * (v[0] - p[a]) +
        n[1] * (v[1] - p[a + 1]) +
        n[2] * (v[2] - p[a + 2])) /
      norm;
    const d0 = distance(start),
      d1 = distance(end);
    if ((d0 > 1e-7 && d1 > 1e-7) || (d0 < -1e-7 && d1 < -1e-7)) continue;
    const drop =
      Math.abs(n[0]) > Math.abs(n[1])
        ? Math.abs(n[0]) > Math.abs(n[2])
          ? 0
          : 2
        : Math.abs(n[1]) > Math.abs(n[2])
          ? 1
          : 2;
    const x = (drop + 1) % 3,
      y = (drop + 2) % 3;
    const area =
      (p[b + x] - p[a + x]) * (p[c + y] - p[a + y]) -
      (p[b + y] - p[a + y]) * (p[c + x] - p[a + x]);
    const sign = Math.sign(area);
    const tolerance = Math.abs(area) * 1e-8;
    const edges = [
      [a, b],
      [b, c],
      [c, a]
    ];
    const edge = (v: ArrayLike<number>, from: number, to: number) =>
      sign *
      ((p[to + x] - p[from + x]) * (v[y] - p[from + y]) -
        (p[to + y] - p[from + y]) * (v[x] - p[from + x]));
    let fraction: number;
    if (Math.abs(d0) <= 1e-7 && Math.abs(d1) <= 1e-7) {
      // Clip a coplanar segment to the triangle's three half-planes.
      let enter = 0,
        leave = 1;
      for (const [from, to] of edges) {
        const f0 = edge(start, from, to),
          f1 = edge(end, from, to);
        if (f0 < -tolerance && f1 < -tolerance) {
          enter = 2;
          break;
        }
        if (f0 < 0 && f1 >= 0) enter = Math.max(enter, f0 / (f0 - f1));
        if (f0 >= 0 && f1 < 0) leave = Math.min(leave, f0 / (f0 - f1));
      }
      if (enter > leave) continue;
      fraction = enter;
    } else {
      fraction = d0 / (d0 - d1);
      if (fraction < 0 || fraction > 1) continue;
      const point = [0, 1, 2].map(
        (k) => start[k] + fraction * (end[k] - start[k])
      );
      if (edges.some(([from, to]) => edge(point, from, to) < -tolerance))
        continue;
    }
    if (!result || fraction < result.fraction) {
      result = {
        fraction,
        triangle: i / 3,
        position: [
          start[0] + fraction * (end[0] - start[0]),
          start[1] + fraction * (end[1] - start[1]),
          start[2] + fraction * (end[2] - start[2])
        ]
      };
    }
  }
  return result;
}
