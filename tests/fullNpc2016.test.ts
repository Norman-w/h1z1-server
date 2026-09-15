import assert from "node:assert/strict";
import test from "node:test";
import { H1Z1Protocol } from "../../h1z1-server";

const DataSchema = require("h1z1-dataschema").default;
const protocol = new H1Z1Protocol("ClientProtocol_1080");
const fullNpcSchema = protocol.H1Z1Packets.Packets[0xdb].schema;
const remoteIndex = fullNpcSchema.findIndex((field: any) => field.name === "remoteWeapons");
const tailIndex = fullNpcSchema.findIndex((field: any) => field.name === "unknownArray3");
const remotePacker = fullNpcSchema[remoteIndex].packer;

function npcPayload(transientId = 42) {
  return {
    transientId, characterId: "0x0102030405060708", attachmentData: [],
    effectTags: [], unknownData1: {}, targetData: {}, unknownArray1: [],
    unknownArray2: [], unknownArray3: { data: [] }, resources: { data: [] },
    unknownArray4: {}, unknownArray5: { data: [] }, remoteWeapons: { data: {} },
    itemsData: { items: [], unknownDword1: 0 }, unknownDword21: 0
  };
}

function packNpc(payload: ReturnType<typeof npcPayload>): Buffer {
  const packet = protocol.pack("LightweightToFullNpc", payload);
  assert.ok(packet);
  assert.equal(packet[0], 0xdb);
  return packet;
}

// Native 140366C73..140366D36: six signed-length blobs, then one DWORD.
// This deliberately does not call the TS schema parser. The empty-fixture
// prefix is checked separately; nonempty prefix variants are not modeled.
function readNativeTail(packet: Buffer, start: number) {
  let cursor = start;
  const lengths: number[] = [];
  for (let index = 0; index < 6; index++) {
    assert.ok(cursor + 4 <= packet.length, "missing blob length");
    const length = packet.readInt32LE(cursor);
    cursor += 4;
    assert.ok(length >= 0 && length <= packet.length - cursor, "invalid blob length");
    lengths.push(length);
    cursor += length;
  }
  assert.ok(cursor + 4 <= packet.length, "missing final DWORD");
  const finalDword = packet.readUInt32LE(cursor);
  cursor += 4;
  assert.equal(cursor, packet.length, "unexpected trailing bytes");
  return { lengths, finalDword };
}

function fieldOffset(payload: ReturnType<typeof npcPayload>, index: number) {
  return 1 + DataSchema.pack(fullNpcSchema.slice(0, index), payload).data.length;
}

test("ordinary NPC remote-weapons data retains its empty four-byte length", () => {
  for (const data of [{}, { data: {} }, { isVehicle: false }]) {
    assert.deepEqual(remotePacker(data), Buffer.alloc(4));
  }
});

test("vehicle remote-weapons encoding retains its two empty arrays", () => {
  const packed = remotePacker({ isVehicle: true, data: [], remoteWeaponExtra: [] });
  assert.equal(packed.toString("hex"), "080000000000000000000000");
});

test("full NPC packets satisfy the six-blob tail across transient ID widths", () => {
  for (const transientId of [0, 42, 63, 64, 16383, 16384, 45708, 65535]) {
    const payload = npcPayload(transientId);
    const packet = packNpc(payload);
    // Independently decoded empty 0xdb prefix: 1 opcode + variable transient
    // + 179 fixed/empty-field bytes. A three-byte transient reaches offset183.
    const nativeTailOffset = 180 + 1 + (packet[1] & 3);
    assert.equal(fieldOffset(payload, tailIndex), nativeTailOffset);
    const tail = readNativeTail(packet, nativeTailOffset);
    assert.deepEqual(tail.lengths, [4, 4, 4, 4, 0, 8]);
    assert.equal(tail.finalDword, 0);
    assert.equal(packet.readInt32LE(fieldOffset(payload, remoteIndex)), 0);
  }
});

test("omitting the remote-weapons length reproduces the native tail rejection", () => {
  const payload = npcPayload(45708);
  const packet = packNpc(payload);
  const remote = fieldOffset(payload, remoteIndex);
  const legacy = Buffer.concat([packet.subarray(0, remote), packet.subarray(remote + 4)]);
  assert.throws(() => readNativeTail(legacy, fieldOffset(payload, tailIndex)), /missing final DWORD/);
});

test("the final NPC DWORD is a field, not an implicit empty sixth blob", () => {
  const payload = npcPayload();
  payload.unknownDword21 = 0x12345678;
  const packet = packNpc(payload);
  assert.equal(readNativeTail(packet, fieldOffset(payload, tailIndex)).finalDword, 0x12345678);
  assert.throws(() => readNativeTail(packet.subarray(0, -1), fieldOffset(payload, tailIndex)), /missing final DWORD/);
});
