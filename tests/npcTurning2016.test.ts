import assert from "node:assert/strict";
import test from "node:test";
import {
  BEAR_NATIVE_TURN_PROFILE,
  Npc,
  WOLF_NATIVE_TURN_PROFILE,
  ZOMBIE_NATIVE_TURN_PROFILE
} from "../out/servers/ZoneServer2016/entities/npc";
import { getCurrentServerTimeWrapper } from "../out/utils/utils";

function makeNpc(profile: any) {
  const packets: any[] = [];
  const npc: any = Object.create(Npc.prototype);
  npc.characterId = "turn-test";
  npc.transientId = 1;
  npc.state = {
    position: new Float32Array([0, 0, 0, 1]),
    yaw: 0
  };
  npc.nativeTurnProfile = profile;
  npc.server = {
    _npcs: {},
    sendDataToAllWithSpawnedEntity(
      _entities: unknown,
      _characterId: string,
      packetName: string,
      payload: any
    ) {
      if (packetName === "PlayerUpdatePosition") {
        packets.push(payload.positionUpdate);
      }
    }
  };
  return { npc, packets };
}

test("native animal turns are limited by the authored source clock", () => {
  const { npc, packets } = makeNpc(BEAR_NATIVE_TURN_PROFILE);

  // Bear's authored 90° turn clip is 2 seconds.  One second of AI time may
  // therefore advance at most half of that body turn, not pivot to +90°.
  npc.lookAt(new Float32Array([10, 0, 0, 1]), 1);

  const motion = packets.at(-1);
  assert.ok(motion.angleChange > 0);
  assert.ok(motion.angleChange < Math.PI / 2);
  assert.ok(Math.abs(motion.angleChange - Math.PI / 4) < 1e-5);
  assert.equal(npc.lastTurnMotion.nativeTurnInput, "State_Turning/TurnRate");
  assert.equal(npc.lastTurnMotion.turnDirection, "positive");
  assert.ok(Math.abs(npc.lastTurnMotion.turnRateRadPerSec - Math.PI / 4) < 1e-5);
});

test("zombie turns use the 90/180 source clocks instead of a pivot", () => {
  const { npc, packets } = makeNpc(ZOMBIE_NATIVE_TURN_PROFILE);

  npc.lookAt(new Float32Array([0, 0, -10, 1]), 1);

  const motion = packets.at(-1);
  const expectedRate = Math.PI / 2.5;
  assert.ok(Math.abs(motion.angleChange) <= expectedRate + 1e-5);
  assert.ok(Math.abs(motion.angleChange) > 0);
  assert.equal(motion.nativeTurnInput, undefined);
  assert.equal(npc.lastWireMotion.nativeTurnInput, "State_Turning/TurnRate");
});

test("a native moving corner keeps the authoritative position but emits a bounded turn delta", () => {
  const { npc, packets } = makeNpc(WOLF_NATIVE_TURN_PROFILE);
  const now = getCurrentServerTimeWrapper().getTruncatedU32();
  npc.lastMotionSample = {
    sequenceTime: (now - 200) >>> 0,
    position: [0, 0, 0]
  };
  npc.state.yaw = 0;
  npc.goTo(new Float32Array([1, 0, 0, 1]));

  const motion = packets.at(-1);
  const expectedRate = (Math.PI / 2) / 0.933;
  assert.deepEqual(Array.from(npc.state.position), [1, 0, 0, 1]);
  assert.ok(npc.lastWireMotion.turnRateRadPerSec <= expectedRate + 1e-2);
  assert.ok(Math.abs(motion.angleChange) < Math.PI / 2);
  assert.equal(npc.lastWireMotion.nativeTurnInput, "State_Turning/TurnRate");
});
