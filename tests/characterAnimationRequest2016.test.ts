import assert from "node:assert/strict";
import test from "node:test";
import DataSchema from "h1z1-dataschema";
import { GatewayChannels } from "h1emu-core";
import { H1Z1Protocol } from "../src/protocols/h1z1protocol";
import { characterPackets } from "../src/packets/ClientProtocol/ClientProtocol_1080/character";
import {
  packAnimationRequest2016 as pack,
  readAnimationRequest2016 as read,
  type AnimationRequest2016,
  type AnimationRequestToken2016
} from "../src/utils/characterAnimationRequestWire2016";

// Literal IEEE754/LE fixtures from the audited layout, not encoder output.
// These token examples test serialization only; they are NOT verified Spawn
// intern IDs, message-to-animation mappings, or native receipt evidence.
const DURATION = "00002040"; // 2.5f
const VECTOR30 = "0000803f000000c00000604000000080"; // [1,-2,3.5,-0]
const VECTOR40 = "000080400000003f000080bf00000000"; // [4,.5,-1,0]
const DWORD50 = "12345678";
const VECTOR60 = "000020410000a0410000f0410000803f";
const VECTOR70 = "000080c00000a0c00000c0c000000000";
const GUID = "0x1122334455667788";
const GUID_BYTES = "8877665544332211";
const BASE_BODY = DURATION + VECTOR30 + VECTOR40 + DWORD50;
const BASE = Buffer.from("2381" + BASE_BODY + "0880", "hex");

function value(
  token: AnimationRequestToken2016 = {
    kind: "index",
    index: 0x123,
    flag13: false
  },
  mask = 0
): AnimationRequest2016 {
  return {
    token,
    duration: 2.5,
    vector30: [1, -2, 3.5, -0],
    vector40: [4, 0.5, -1, 0],
    unknownDword50: 0x78563412,
    flags0: 8 | mask,
    flags1: 0x80,
    ...(mask & 0x40
      ? { vector60: [10, 20, 30, 1] as [number, number, number, number] }
      : {}),
    ...(mask & 0x20
      ? { vector70: [-4, -5, -6, 0] as [number, number, number, number] }
      : {})
  };
}

// Independent full-wire oracle: normal opcode/GUID prefix then the native
// token/duration/vector/flag order. It never invokes the production codec.
function nativeOracle(wire: Buffer) {
  let at = 0;
  const take = (n: number) => {
    assert.ok(at + n <= wire.length, "oracle short input");
    const p = at;
    at += n;
    return p;
  };
  assert.equal(wire.readUInt8(take(1)), 0x0f);
  assert.equal(wire.readUInt8(take(1)), 0x41);
  const characterId = "0x" + wire.readBigUInt64LE(take(8)).toString(16);
  const h = wire.readUInt16LE(take(2));
  let token: AnimationRequestToken2016;
  if (h & 0x8000) {
    token = { kind: "index", index: h & 0x1fff, flag13: !!(h & 0x2000) };
  } else {
    const size = h & 0x1fff,
      begin = take(size + 1);
    assert.equal(wire[begin + size], 0);
    token = {
      kind: "name",
      name: wire.toString("ascii", begin, begin + size),
      flag13: !!(h & 0x2000)
    };
  }
  if (h & 0x4000) token.extra = wire.readUInt32LE(take(4));
  const duration = wire.readFloatLE(take(4));
  const vec = () => [0, 1, 2, 3].map(() => wire.readFloatLE(take(4)));
  const vector30 = vec(),
    vector40 = vec();
  const unknownDword50 = wire.readUInt32LE(take(4));
  const flags0 = wire.readUInt8(take(1)),
    flags1 = wire.readUInt8(take(1));
  const result: any = {
    token,
    duration,
    vector30,
    vector40,
    unknownDword50,
    flags0,
    flags1
  };
  if (flags0 & 0x40) result.vector60 = vec();
  if (flags0 & 0x20) result.vector70 = vec();
  assert.equal(at, wire.length, "oracle trailing input");
  return { characterId, animation: result, consumed: at };
}

const whole = (tail: Buffer) =>
  Buffer.concat([Buffer.from("0f41" + GUID_BYTES, "hex"), tail]);
const entry = characterPackets.find(
  ([name]) => name === "Character.AnimationRequest"
)!;
const schema = entry[2].fields!;
const protocol = new H1Z1Protocol("ClientProtocol_1080");

test("index fixture matches literal bytes, field offsets and signed zero", () => {
  assert.equal(BASE.length, 44);
  assert.deepEqual(pack(value()), BASE);
  assert.deepEqual(read(BASE), { value: value(), length: 44 });
  assert.equal(BASE.readFloatLE(2), 2.5);
  assert.ok(Object.is(BASE.readFloatLE(18), -0));
  assert.equal(BASE.readUInt32LE(38), 0x78563412);
  assert.deepEqual([...BASE.subarray(42)], [8, 0x80]);
  assert.deepEqual(nativeOracle(whole(BASE)), {
    characterId: GUID,
    animation: value(),
    consumed: 54
  });
});

for (const [flag13, extra, header] of [
  [false, undefined, "2381"],
  [true, undefined, "23a1"],
  [false, 0x89abcdef, "23c1"],
  [true, 0x89abcdef, "23e1"]
] as const) {
  test(`index literal header ${header} preserves independent bits13/14`, () => {
    const token: AnimationRequestToken2016 = {
      kind: "index",
      index: 0x123,
      flag13,
      ...(extra === undefined ? {} : { extra })
    };
    const expected = Buffer.from(
      header + (extra === undefined ? "" : "efcdab89") + BASE_BODY + "0880",
      "hex"
    );
    assert.deepEqual(pack(value(token)), expected);
    assert.deepEqual(read(expected).value, value(token));
    assert.deepEqual(nativeOracle(whole(expected)).animation, value(token));
  });
}

for (const [flag13, extra, header] of [
  [false, undefined, "0500"],
  [true, undefined, "0520"],
  [false, 0, "0540"],
  [true, 0xffffffff, "0560"]
] as const) {
  test(`name literal header ${header} contains exact length, NUL and optional u32`, () => {
    const token: AnimationRequestToken2016 = {
      kind: "name",
      name: "Spawn",
      flag13,
      ...(extra === undefined ? {} : { extra })
    };
    const extension =
      extra === undefined ? "" : extra === 0 ? "00000000" : "ffffffff";
    const expected = Buffer.from(
      header + "537061776e00" + extension + BASE_BODY + "0880",
      "hex"
    );
    assert.deepEqual(pack(value(token)), expected);
    assert.deepEqual(read(expected).value, value(token));
    assert.deepEqual(nativeOracle(whole(expected)).animation, value(token));
  });
}

for (const mask of [0, 0x20, 0x40, 0x60]) {
  test(`optional vector mask0x${mask.toString(16)} follows60 then70 with no padding`, () => {
    const flags = (8 | mask).toString(16).padStart(2, "0") + "80";
    const expected = Buffer.from(
      "2381" +
        BASE_BODY +
        flags +
        (mask & 0x40 ? VECTOR60 : "") +
        (mask & 0x20 ? VECTOR70 : ""),
      "hex"
    );
    assert.deepEqual(pack(value(undefined, mask)), expected);
    assert.deepEqual(read(expected).value, value(undefined, mask));
    assert.deepEqual(
      nativeOracle(whole(expected)).animation,
      value(undefined, mask)
    );
  });
}

test("index and ASCII name supported boundaries have independently specified headers", () => {
  for (const [index, hex] of [
    [0, "0080"],
    [8191, "ff9f"]
  ] as const) {
    const token: AnimationRequestToken2016 = {
      kind: "index",
      index,
      flag13: false
    };
    const expected = Buffer.from(hex + BASE_BODY + "0880", "hex");
    assert.deepEqual(pack(value(token)), expected);
    assert.deepEqual(read(expected).value.token, token);
  }
  for (const name of [" ", "~", "A".repeat(8191)]) {
    const token: AnimationRequestToken2016 = {
      kind: "name",
      name,
      flag13: false
    };
    const expectedHeader = Buffer.from(
      name.length === 8191 ? "ff1f" : "0100",
      "hex"
    );
    const expected = Buffer.concat([
      expectedHeader,
      Buffer.from(name, "ascii"),
      Buffer.from([0]),
      Buffer.from(BASE_BODY + "0880", "hex")
    ]);
    assert.deepEqual(pack(value(token)), expected);
    assert.deepEqual(read(expected).value.token, token);
  }
});

test("every truncation of indexed/name/extra/optional fixtures fails closed", () => {
  const fixtures = [
    BASE,
    Buffer.from(
      "0560537061776e00efcdab89" + BASE_BODY + "6880" + VECTOR60 + VECTOR70,
      "hex"
    ),
    Buffer.from("23e1efcdab89" + BASE_BODY + "2880" + VECTOR70, "hex")
  ];
  for (const bytes of fixtures) {
    for (let size = 0; size < bytes.length; size++) {
      assert.throws(
        () => read(bytes.subarray(0, size)),
        `accepted truncation ${size}/${bytes.length}`
      );
    }
    assert.doesNotThrow(() => read(bytes));
  }
});

test("tail bytes and malformed name length/ASCII/NUL are not silently ignored", () => {
  for (const tail of [
    Buffer.from([0]),
    Buffer.from([1, 2]),
    Buffer.alloc(16)
  ]) {
    assert.throws(() => read(Buffer.concat([BASE, tail])));
  }
  for (const hex of [
    "0000",
    "01004101",
    "01000000",
    "01007f00",
    "01008000",
    "02004100",
    "ff1f4100"
  ]) {
    assert.throws(
      () => read(Buffer.from(hex + BASE_BODY + "0880", "hex")),
      hex
    );
  }
});

test("start offset is relative to original buffer and returned length excludes prefix", () => {
  const bytes = whole(BASE),
    before = Buffer.from(bytes);
  assert.deepEqual(read(bytes, 10), { value: value(), length: 44 });
  assert.deepEqual(bytes, before);
  for (const offset of [
    -1,
    0.5,
    NaN,
    Infinity,
    -Infinity,
    bytes.length,
    bytes.length + 1,
    "10",
    null,
    true
  ]) {
    assert.throws(() => read(bytes, offset as number), String(offset));
  }
  assert.throws(() => read(Buffer.concat([bytes, Buffer.from([0])]), 10));
});

test("old uint32/two-vector/u32 tail is rejected instead of receiving defaults", () => {
  const oldTail = Buffer.from(
    "23810000" + VECTOR30 + VECTOR40 + DWORD50,
    "hex"
  );
  assert.equal(oldTail.length, 40);
  assert.throws(() => read(oldTail));
  assert.throws(() =>
    pack({
      unknownDword1: 0,
      unknownFloatVector1: [0, 0, 0, 0],
      unknownFloatVector2: [0, 0, 0, 0],
      unknownDword2: 0
    } as any)
  );
});

test("invalid token kind, required bool, index, name and extension are rejected", () => {
  const bad = [
    null,
    undefined,
    {},
    { kind: "other", flag13: false },
    { kind: "index", index: 1 },
    { kind: "index", index: 1, flag13: 0 },
    ...[-1, 8192, 0.5, NaN, Infinity, "1", true, null].map((index) => ({
      kind: "index",
      index,
      flag13: false
    })),
    ...["", "A".repeat(8192), "A\0B", "\n", "\x7f", "é", "僵尸", 1].map(
      (name) => ({ kind: "name", name, flag13: false })
    ),
    ...[-1, 0x100000000, 0.5, NaN, Infinity, "1", true, null].map((extra) => ({
      kind: "index",
      index: 1,
      flag13: false,
      extra
    }))
  ];
  for (const token of bad)
    assert.throws(() => pack({ ...value(), token } as any));
  for (const data of [null, undefined, false, {}])
    assert.throws(() => pack(data as any));
});

test("positive finite representable duration required in both directions", () => {
  for (const duration of [
    0,
    -0,
    -1,
    NaN,
    Infinity,
    -Infinity,
    1e100,
    1e-100,
    "1",
    null,
    true
  ]) {
    assert.throws(
      () => pack({ ...value(), duration } as any),
      String(duration)
    );
  }
  for (const duration of [0, -0, -1, NaN, Infinity, -Infinity]) {
    const bytes = Buffer.from(BASE);
    bytes.writeFloatLE(duration, 2);
    assert.throws(() => read(bytes), String(duration));
  }
});

test("every required/optional vector enforces four finite float32 components", () => {
  for (const field of [
    "vector30",
    "vector40",
    "vector60",
    "vector70"
  ] as const) {
    for (const invalid of [
      null,
      undefined,
      [],
      [1, 2, 3],
      [1, 2, 3, 4, 5],
      new Float32Array(4)
    ]) {
      assert.throws(
        () => pack({ ...value(undefined, 0x60), [field]: invalid } as any),
        field
      );
    }
    for (let at = 0; at < 4; at++) {
      for (const invalid of [NaN, Infinity, -Infinity, 1e100, "1", undefined]) {
        const vector: any[] = [1, 2, 3, 4];
        vector[at] = invalid;
        assert.throws(
          () => pack({ ...value(undefined, 0x60), [field]: vector } as any),
          `${field}[${at}]`
        );
      }
    }
  }
  const full = Buffer.from(
    "2381" + BASE_BODY + "6880" + VECTOR60 + VECTOR70,
    "hex"
  );
  for (const offset of [6, 22, 44, 60]) {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      const bytes = Buffer.from(full);
      bytes.writeFloatLE(invalid, offset);
      assert.throws(() => read(bytes), `wire vector at${offset}`);
    }
  }
});

test("u32/byte numeric bounds reject coercion and invalid flag-vector combinations", () => {
  for (const field of ["unknownDword50", "flags0", "flags1"] as const) {
    const tooBig = field === "unknownDword50" ? 0x100000000 : 256;
    for (const invalid of [
      -1,
      tooBig,
      0.5,
      NaN,
      Infinity,
      "1",
      null,
      true,
      undefined
    ]) {
      assert.throws(() => pack({ ...value(), [field]: invalid } as any), field);
    }
  }
  for (const field of ["vector60", "vector70"] as const) {
    assert.throws(() => pack({ ...value(), [field]: [1, 2, 3, 4] }));
    assert.throws(() =>
      pack({ ...value(undefined, 0x60), [field]: undefined })
    );
  }
});

test("opaque valid flag bits are preserved without assigning new native meanings", () => {
  for (const flags0 of [0, 1, 7, 8, 0x80, 0xff])
    for (const flags1 of [0, 1, 0x7f, 0x80, 0xff]) {
      const payload = { ...value(undefined, flags0 & 0x60), flags0, flags1 };
      const bytes = pack(payload);
      assert.equal(bytes[42], flags0);
      assert.equal(bytes[43], flags1);
      assert.deepEqual(read(bytes).value, payload);
    }
});

test("normal source DataSchema and protocol add GUID/opcode exactly once", () => {
  assert.equal(entry[1], 0x0f41);
  assert.deepEqual(
    schema.map((field: any) => field.name),
    ["characterId", "animation"]
  );
  const expected = whole(BASE),
    object = { characterId: GUID, animation: value() };
  const packedSchema = DataSchema.pack(schema, object);
  assert.equal(packedSchema.length, 52);
  assert.deepEqual(packedSchema.data, expected.subarray(2));
  assert.deepEqual(DataSchema.parse(schema, expected, 2).result, object);
  const wire = protocol.pack("Character.AnimationRequest", object);
  assert.ok(wire);
  assert.deepEqual(wire, expected);
  assert.equal(wire.length, 54);
  assert.deepEqual(nativeOracle(wire), { ...object, consumed: 54 });
  const parsed = protocol.parse(expected, GatewayChannels.Zone);
  assert.equal(parsed?.name, "Character.AnimationRequest");
  assert.deepEqual(parsed?.data, object);
});

test("source schema integration covers literal name+extension+both optional vectors", () => {
  const token: AnimationRequestToken2016 = {
    kind: "name",
    name: "Spawn",
    flag13: true,
    extra: 0x89abcdef
  };
  const expectedTail = Buffer.from(
    "0560537061776e00efcdab89" + BASE_BODY + "6880" + VECTOR60 + VECTOR70,
    "hex"
  );
  const expected = whole(expectedTail),
    object = { characterId: GUID, animation: value(token, 0x60) };
  assert.deepEqual(
    protocol.pack("Character.AnimationRequest", object),
    expected
  );
  assert.deepEqual(nativeOracle(expected), {
    ...object,
    consumed: expected.length
  });
  assert.deepEqual(DataSchema.parse(schema, expected, 2).result, object);
});

test("normal schema/protocol fail rather than emitting the former incomplete shape", (t) => {
  t.mock.method(console, "error", () => {});
  const oldObject = {
    characterId: GUID,
    unknownDword1: 0,
    unknownFloatVector1: [0, 0, 0, 0],
    unknownFloatVector2: [0, 0, 0, 0],
    unknownDword2: 0
  };
  assert.throws(() => DataSchema.pack(schema, oldObject));
  assert.equal(protocol.pack("Character.AnimationRequest", oldObject), null);
  assert.equal(
    protocol.pack("Character.AnimationRequest", { characterId: GUID }),
    null
  );
  assert.equal(
    protocol.parse(
      Buffer.concat([whole(BASE), Buffer.from([0])]),
      GatewayChannels.Zone
    ),
    null
  );
  const old = Buffer.from(
    "0f41" + GUID_BYTES + "23810000" + VECTOR30 + VECTOR40 + DWORD50,
    "hex"
  );
  assert.equal(protocol.parse(old, GatewayChannels.Zone), null);
});
