/**
 * 离线校验：H1EMU DataSchema 对 states6（hidesHeat / nearDeath）打包字节偏移。
 * 运行：npx tsx tools/verify-states6-pack.ts
 */
import { H1Z1Protocol } from "../src/protocols/h1z1protocol";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const proto = new H1Z1Protocol("ClientProtocol_1080");

const base = {
  characterId: "0x00000000000000a1",
  states1: { visible: true },
  states2: {},
  states3: {},
  states4: {},
  states5: {},
  states6: {},
  states7: {},
  placeholder: 0,
  gameTime: 0x11223344
};

const p0 = proto.pack("Character.UpdateCharacterState", base);
assert(p0 != null && p0.length === 22, `expected pack len 22 (1080 UCS wire), got ${p0?.length}`);

/**
 * 完整包中 states6 为 schema 尾的第 6 字节，即偏移 10 + 5 = 15。
 */
const OFF_STATES6 = 15;

const pHeat = proto.pack("Character.UpdateCharacterState", {
  ...base,
  states6: { hidesHeat: true }
});
assert(pHeat != null, "pack hidesHeat");
const bHeat = pHeat.readUInt8(OFF_STATES6);
assert(bHeat === 0x04, `hidesHeat (bit2) expected byte 0x04 at offset ${OFF_STATES6}, got 0x${bHeat.toString(16)}`);

const pNear = proto.pack("Character.UpdateCharacterState", {
  ...base,
  states6: { nearDeath: true }
});
assert(pNear != null, "pack nearDeath");
const bNear = pNear.readUInt8(OFF_STATES6);
assert(bNear === 0x08, `nearDeath (bit3) expected 0x08, got 0x${bNear.toString(16)}`);

const pBoth = proto.pack("Character.UpdateCharacterState", {
  ...base,
  states6: { hidesHeat: true, nearDeath: true }
});
assert(pBoth != null, "pack both");
assert(
  pBoth.readUInt8(OFF_STATES6) === 0x0c,
  `combined expected 0x0c, got 0x${pBoth.readUInt8(OFF_STATES6).toString(16)}`
);

const q1 = pHeat.readBigUInt64LE(10);
const gt = pHeat.readUInt32LE(18);
assert(gt === 0x11223344, "gameTime tail (T0)");

console.log("[verify-states6-pack] OK", {
  offStates6: OFF_STATES6,
  hidesHeatByte: `0x${bHeat.toString(16)}`,
  nearDeathByte: `0x${bNear.toString(16)}`,
  q1HidesHeat: q1.toString(16),
  schemaTailHex: pHeat.subarray(10).toString("hex")
});
