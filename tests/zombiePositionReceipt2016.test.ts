import assert from "node:assert/strict";
import test from "node:test";
import { recordTestZombiePositionReceipt } from "../src/servers/ZoneServer2016/test-zombie-position-receipt";
import type { TestZombiePositionReceiptClient } from "../src/servers/ZoneServer2016/test-zombie-position-receipt";

function fixture() {
  const character = { characterId: "player", isAlive: true, isRespawning: false };
  const client: TestZombiePositionReceiptClient = {
    character, testZombieSpawned: true, isSynced: true, isLoading: false
  };
  const packet = { flags: 0x1fff, sequenceTime: 1000, unknown3_int8: 7,
    position: [1, 2, 3, 1], rotation: [0, 0, 0, 1] };
  return { character, client, packet };
}

test("records exact incoming data and identity without changing unrelated client state", () => {
  const s = fixture();
  const client = Object.assign(s.client, { testZombieMovementVersion: 6, testZombieClockReadyAt: 10,
    sendData: () => { throw Error("must not send"); } });
  const before = Date.now();
  assert.equal(recordTestZombiePositionReceipt(client, s.packet, 1000), true);
  const r = client.testZombiePositionReceipt!;
  assert.equal(r.character, s.character);
  assert.equal(r.playerCharacterId, "player");
  assert.equal(r.count, 1);
  assert.equal(r.flags, 0x1fff);
  assert.equal(r.sequenceTime, 1000);
  assert.equal(r.movementVersion, 7);
  assert.equal(r.clockAligned, true);
  assert.ok(r.receivedAt >= before && r.receivedAt <= Date.now());
  assert.deepEqual(r.position, s.packet.position);
  assert.deepEqual(r.rotation, s.packet.rotation);
  assert.equal(client.testZombieMovementVersion, 6);
  assert.equal(client.testZombieClockReadyAt, 10);
});

test("receipt and vectors are copied/frozen, while exact character remains unfrozen", () => {
  const s = fixture();
  assert.equal(recordTestZombiePositionReceipt(s.client, s.packet, 1000), true);
  const r = s.client.testZombiePositionReceipt!;
  s.packet.position[0] = 88;
  s.packet.rotation[3] = 88;
  assert.deepEqual(r.position, [1, 2, 3, 1]);
  assert.deepEqual(r.rotation, [0, 0, 0, 1]);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.position) && Object.isFrozen(r.rotation));
  assert.equal(Reflect.set(r, "count", 99), false);
  assert.equal(Reflect.set(r.position, "0", 99), false);
  assert.equal(Reflect.set(r.rotation!, "0", 99), false);
  assert.equal(Object.isFrozen(s.character), false);
});

for (const field of ["testZombieSpawned", "isSynced"] as const) {
  for (const value of [false, undefined, 1, "true"]) {
    test(`${field} must be strict true: ${String(value)}`, () => {
      const s = fixture(); (s.client as any)[field] = value;
      assert.equal(recordTestZombiePositionReceipt(s.client, s.packet, 1000), false);
      assert.equal(s.client.testZombiePositionReceipt, undefined);
    });
  }
}
for (const value of [true, undefined, 0, "false"]) {
  test(`loading must be strict false: ${String(value)}`, () => {
    const s = fixture(); (s.client as any).isLoading = value;
    assert.equal(recordTestZombiePositionReceipt(s.client, s.packet, 1000), false);
  });
}
for (const change of ["missing", "dead", "unknownAlive", "respawning", "unknownRespawning", "emptyId", "numericId"]) {
  test(`reject unavailable character: ${change}`, () => {
    const s = fixture();
    if (change === "missing") s.client.character = null;
    if (change === "dead") s.character.isAlive = false;
    if (change === "unknownAlive") delete (s.character as any).isAlive;
    if (change === "respawning") s.character.isRespawning = true;
    if (change === "unknownRespawning") delete (s.character as any).isRespawning;
    if (change === "emptyId") s.character.characterId = "";
    if (change === "numericId") (s.character as any).characterId = 1;
    assert.equal(recordTestZombiePositionReceipt(s.client, s.packet, 1000), false);
  });
}

for (const packet of [null, undefined, [], 1, "packet", {}, { parseError: true }, { flags: 0 }]) {
  test(`reject malformed packet ${JSON.stringify(packet)}`, () => {
    assert.equal(recordTestZombiePositionReceipt(fixture().client, packet, 1000), false);
  });
}
for (const flags of [0, 1, 0x201, -1, 0x10002, 2.5, NaN, Infinity, "2"]) {
  test(`reject absent position flag or invalid flags ${String(flags)}`, () => {
    const s = fixture();
    Object.assign(s.character, { state: { position: [1, 2, 3, 1] } });
    assert.equal(recordTestZombiePositionReceipt(s.client, { ...s.packet, flags }, 1000), false);
  });
}
for (const parseError of [true, 1, "false", null]) {
  test(`reject parse error marker ${String(parseError)}`, () => {
    const s = fixture();
    assert.equal(recordTestZombiePositionReceipt(s.client, { ...s.packet, parseError }, 1000), false);
  });
}
for (const position of [undefined, null, [], [1, 2, 3], [1, 2, 3, 0], [1, 2, 3, 1, 5],
  [NaN, 2, 3, 1], [1, Infinity, 3, 1], ["1", 2, 3, 1], { 0: 1, 1: 2, 2: 3, 3: 1, length: 4 }]) {
  test(`reject invalid position ${JSON.stringify(position)}`, () => {
    const s = fixture();
    assert.equal(recordTestZombiePositionReceipt(s.client, { ...s.packet, position }, 1000), false);
  });
}
test("an inherited/cached position does not constitute a packet position", () => {
  const s = fixture();
  const p = Object.assign(Object.create({ position: s.packet.position }), s.packet);
  delete p.position;
  assert.equal(recordTestZombiePositionReceipt(s.client, p, 1000), false);
});

for (const field of ["sequenceTime", "unknown3_int8"] as const) {
  const maximum = field === "sequenceTime" ? 0xffffffff : 255;
  for (const value of [-1, maximum + 1, 1.5, NaN, Infinity, "1", undefined]) {
    test(`reject invalid ${field} ${String(value)}`, () => {
      const s = fixture();
      assert.equal(recordTestZombiePositionReceipt(s.client, { ...s.packet, [field]: value }, 1000), false);
    });
  }
}
for (const time of [-1, 0x100000000, 1.5, NaN, Infinity]) {
  test(`reject invalid server time ${String(time)}`, () => {
    const s = fixture(); assert.equal(recordTestZombiePositionReceipt(s.client, s.packet, time), false);
  });
}
for (const delta of [-501, -500, 0, 500, 501]) {
  test(`same-packet clock alignment boundary ${delta}ms`, () => {
    const s = fixture(); s.packet.sequenceTime = 1000 + delta;
    assert.equal(recordTestZombiePositionReceipt(s.client, s.packet, 1000), Math.abs(delta) <= 500);
  });
}
test("clock alignment uses signed modular subtraction across u32 wrap", () => {
  const s = fixture(); s.packet.sequenceTime = 20;
  assert.equal(recordTestZombiePositionReceipt(s.client, s.packet, 0xfffffff0), true);
});

test("same character rejects duplicate/backwards/half-range sequence without changing receipt", () => {
  const s = fixture(); recordTestZombiePositionReceipt(s.client, s.packet, 1000);
  const first = s.client.testZombiePositionReceipt;
  for (const sequenceTime of [1000, 999, (1000 + 0x80000000) >>> 0]) {
    assert.equal(recordTestZombiePositionReceipt(s.client, { ...s.packet, sequenceTime }, sequenceTime), false);
    assert.equal(s.client.testZombiePositionReceipt, first);
  }
  assert.equal(recordTestZombiePositionReceipt(s.client, { ...s.packet, sequenceTime: 1001 }, 1001), true);
  assert.equal(s.client.testZombiePositionReceipt!.count, 2);
});
test("same character accepts normal sequence wrap and version 255 then 0", () => {
  const s = fixture();
  assert.equal(recordTestZombiePositionReceipt(s.client,
    { ...s.packet, sequenceTime: 0xfffffff0, unknown3_int8: 255 }, 0xfffffff0), true);
  assert.equal(recordTestZombiePositionReceipt(s.client,
    { ...s.packet, sequenceTime: 5, unknown3_int8: 0 }, 5), true);
  assert.equal(s.client.testZombiePositionReceipt!.count, 2);
  assert.equal(s.client.testZombiePositionReceipt!.movementVersion, 0);
});
test("replacement character reference permits new sequence but preserves observer count", () => {
  const s = fixture(); recordTestZombiePositionReceipt(s.client, s.packet, 1000);
  const replacement = { ...s.character }; // Same GUID does not make it the same object.
  s.client.character = replacement;
  assert.equal(recordTestZombiePositionReceipt(s.client, { ...s.packet, sequenceTime: 1 }, 1), true);
  assert.equal(s.client.testZombiePositionReceipt!.character, replacement);
  assert.equal(s.client.testZombiePositionReceipt!.count, 2);
});

for (const rotation of [undefined, null, [], [0, 0, 1], [0, 0, 0, NaN], [0, 0, 0, Infinity], [0, 0, 0, "1"]]) {
  test(`invalid/absent rotation does not invalidate real position ${JSON.stringify(rotation)}`, () => {
    const s = fixture();
    assert.equal(recordTestZombiePositionReceipt(s.client, { ...s.packet, rotation }, 1000), true);
    assert.equal(s.client.testZombiePositionReceipt!.rotation, null);
  });
}
test("rotation without the wire rotation flag is never copied", () => {
  const s = fixture();
  assert.equal(recordTestZombiePositionReceipt(s.client, { ...s.packet, flags: 2 }, 1000), true);
  assert.equal(s.client.testZombiePositionReceipt!.rotation, null);
});
test("Float32 position/rotation are copied as immutable finite tuples", () => {
  const s = fixture(); const position = new Float32Array(s.packet.position), rotation = new Float32Array(s.packet.rotation);
  assert.equal(recordTestZombiePositionReceipt(s.client, { ...s.packet, position, rotation, parseError: false }, 1000), true);
  position[0] = 10; rotation[0] = 10;
  assert.deepEqual(s.client.testZombiePositionReceipt!.position, [1, 2, 3, 1]);
  assert.deepEqual(s.client.testZombiePositionReceipt!.rotation, [0, 0, 0, 1]);
});
test("counter exhaustion refuses rather than silently repeating an observer count", () => {
  const s = fixture(); recordTestZombiePositionReceipt(s.client, s.packet, 1000);
  s.client.testZombiePositionReceipt = { ...s.client.testZombiePositionReceipt!, count: Number.MAX_SAFE_INTEGER };
  const previous = s.client.testZombiePositionReceipt;
  assert.equal(recordTestZombiePositionReceipt(s.client, { ...s.packet, sequenceTime: 1001 }, 1001), false);
  assert.equal(s.client.testZombiePositionReceipt, previous);
});
