// Character subtype 0x41, fixed 2016 client 1404EC650 / 140352740.
// This describes bytes, not a Spawn-ready contract. Index tokens belong to the
// client's intern table; MRN node/request IDs are NOT interchangeable with them.
export type AnimationRequestToken2016 = (
  | { kind: "name"; name: string }
  | { kind: "index"; index: number }
) & { flag13: boolean; extra?: number };

export type AnimationVector2016 = [number, number, number, number];

export interface AnimationRequest2016 {
  token: AnimationRequestToken2016;
  duration: number;
  vector30: AnimationVector2016;
  vector40: AnimationVector2016;
  unknownDword50: number;
  flags0: number;
  flags1: number;
  vector60?: AnimationVector2016;
  vector70?: AnimationVector2016;
}

function uint(value: number, max: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`Invalid AnimationRequest ${field}`);
  }
  return value;
}

function float(value: number, field: string): number {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
    throw new RangeError(`Invalid AnimationRequest ${field}`);
  }
  return value;
}

function vector(value: AnimationVector2016, field: string): void {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new TypeError(`Invalid AnimationRequest ${field}`);
  }
  for (const part of value) float(part, field);
}

function validate(data: AnimationRequest2016): void {
  if (!data || !data.token || typeof data.token.flag13 !== "boolean") {
    throw new TypeError("AnimationRequest requires an explicit token");
  }
  if (data.token.kind === "index") {
    uint(data.token.index, 0x1fff, "token index");
  } else if (data.token.kind === "name") {
    // Deliberately support only verified single-byte, NUL-free asset names.
    // Do not guess Unicode conversion or silently truncate the 13-bit length.
    if (
      typeof data.token.name !== "string" ||
      !/^[\x20-\x7e]{1,8191}$/.test(data.token.name)
    ) {
      throw new TypeError("AnimationRequest name must be 1..8191 ASCII bytes");
    }
  } else {
    throw new TypeError("Invalid AnimationRequest token kind");
  }
  if (data.token.extra !== undefined)
    uint(data.token.extra, 0xffffffff, "token extra");
  float(data.duration, "duration");
  if (Math.fround(data.duration) <= 0) {
    throw new RangeError("AnimationRequest duration must be positive");
  }
  vector(data.vector30, "vector30");
  vector(data.vector40, "vector40");
  uint(data.unknownDword50, 0xffffffff, "unknownDword50");
  uint(data.flags0, 0xff, "flags0");
  uint(data.flags1, 0xff, "flags1");
  for (const [flag, field] of [
    [0x40, "vector60"],
    [0x20, "vector70"]
  ] as const) {
    if (!!(data.flags0 & flag) !== (data[field] !== undefined)) {
      throw new TypeError(`AnimationRequest ${field} must agree with flags0`);
    }
    if (data[field] !== undefined) vector(data[field]!, field);
  }
}

/** Pack only the tail AFTER opcode + GUID; the normal schema owns that header. */
export function packAnimationRequest2016(data: AnimationRequest2016): Buffer {
  validate(data);
  const token = data.token;
  const name = token.kind === "name" ? Buffer.from(token.name, "ascii") : null;
  const length =
    2 +
    (name ? name.length + 1 : 0) +
    (token.extra === undefined ? 0 : 4) +
    42 +
    (data.vector60 ? 16 : 0) +
    (data.vector70 ? 16 : 0);
  const bytes = Buffer.alloc(length);
  const header =
    (token.flag13 ? 0x2000 : 0) |
    (token.extra === undefined ? 0 : 0x4000) |
    (token.kind === "index" ? 0x8000 | token.index : name!.length);
  bytes.writeUInt16LE(header, 0);
  let offset = 2;
  if (name) {
    name.copy(bytes, offset);
    offset += name.length + 1; // Buffer.alloc supplies the required NUL.
  }
  if (token.extra !== undefined) {
    bytes.writeUInt32LE(token.extra, offset);
    offset += 4;
  }
  bytes.writeFloatLE(data.duration, offset);
  offset += 4;
  const writeVector = (value: AnimationVector2016) => {
    for (const part of value) {
      bytes.writeFloatLE(part, offset);
      offset += 4;
    }
  };
  writeVector(data.vector30);
  writeVector(data.vector40);
  bytes.writeUInt32LE(data.unknownDword50, offset);
  offset += 4;
  bytes[offset++] = data.flags0;
  bytes[offset++] = data.flags1;
  if (data.vector60) writeVector(data.vector60);
  if (data.vector70) writeVector(data.vector70);
  return bytes;
}

/** Strict supported-subset decoder; does not emulate native unsafe overreads. */
export function readAnimationRequest2016(
  bytes: Buffer,
  start = 0
): {
  value: AnimationRequest2016;
  length: number;
} {
  uint(start, bytes.length, "offset");
  let offset = start;
  const need = (length: number) => {
    if (offset + length > bytes.length)
      throw new RangeError("Truncated AnimationRequest");
  };
  need(2);
  const header = bytes.readUInt16LE(offset);
  offset += 2;
  const flag13 = !!(header & 0x2000);
  let token: AnimationRequestToken2016;
  if (header & 0x8000) {
    token = { kind: "index", index: header & 0x1fff, flag13 };
  } else {
    const length = header & 0x1fff;
    need(length + 1);
    if (
      bytes[offset + length] !== 0 ||
      !bytes
        .subarray(offset, offset + length)
        .every((v) => v >= 0x20 && v <= 0x7e)
    ) {
      throw new TypeError("Invalid AnimationRequest name length/terminator");
    }
    token = {
      kind: "name",
      name: bytes.toString("ascii", offset, offset + length),
      flag13
    };
    offset += length + 1;
  }
  if (header & 0x4000) {
    need(4);
    token.extra = bytes.readUInt32LE(offset);
    offset += 4;
  }
  need(42);
  const duration = bytes.readFloatLE(offset);
  offset += 4;
  const readVector = (): AnimationVector2016 => {
    need(16);
    const result: AnimationVector2016 = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      result[i] = bytes.readFloatLE(offset);
      offset += 4;
    }
    return result;
  };
  const vector30 = readVector(),
    vector40 = readVector();
  const unknownDword50 = bytes.readUInt32LE(offset);
  offset += 4;
  const flags0 = bytes[offset++],
    flags1 = bytes[offset++];
  const value: AnimationRequest2016 = {
    token,
    duration,
    vector30,
    vector40,
    unknownDword50,
    flags0,
    flags1
  };
  if (flags0 & 0x40) value.vector60 = readVector();
  if (flags0 & 0x20) value.vector70 = readVector();
  if (offset !== bytes.length)
    throw new RangeError("Trailing AnimationRequest bytes");
  validate(value);
  return { value, length: offset - start };
}
