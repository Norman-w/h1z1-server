import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateNpcMotionSpeeds,
  createNpcPositionUpdate,
  metersToFeet
} from "../out/utils/utils";

test("NPC motion speeds use the wire timestamp and feet-per-second units", () => {
  const speeds = calculateNpcMotionSpeeds(
    new Float32Array([1, 2, 0, 1]),
    1500,
    { sequenceTime: 1000, position: [0, 0, 0] }
  );

  assert.equal(speeds.horizontalSpeed, metersToFeet(2));
  assert.equal(speeds.verticalSpeed, metersToFeet(4));
});

test("NPC motion speed calculation handles timestamp wrap and rejects stale samples", () => {
  const position = new Float32Array([1, 0, 0, 1]);
  const expected = { horizontalSpeed: 0, verticalSpeed: 0 };

  assert.deepEqual(calculateNpcMotionSpeeds(position, 1000), expected);
  assert.deepEqual(
    calculateNpcMotionSpeeds(position, 1000, {
      sequenceTime: 1000,
      position: [0, 0, 0]
    }),
    expected
  );
  const wrappedSpeeds = calculateNpcMotionSpeeds(position, 100, {
    sequenceTime: 0xffff_ff00,
    position: [0, 0, 0]
  });
  assert.equal(wrappedSpeeds.horizontalSpeed, metersToFeet(1 / 0.356));
  assert.equal(wrappedSpeeds.verticalSpeed, 0);
  assert.deepEqual(
    calculateNpcMotionSpeeds(position, 10, {
      sequenceTime: 1000,
      position: [0, 0, 0]
    }),
    expected
  );
});

test("NPC position updates carry an explicit locomotion tuple", () => {
  const position = new Float32Array([4, 5, 6, 1]);
  const packet = createNpcPositionUpdate(position, 42, {
    stance: 66565,
    engineRPM: 0,
    orientation: 1.25,
    frontTilt: 0.1,
    sideTilt: -0.2,
    angleChange: 0.3,
    verticalSpeed: 0.4,
    horizontalSpeed: 2.5
  });

  assert.deepEqual(packet, {
    sequenceTime: 42,
    unknown3_int8: 0,
    stance: 66565,
    position: [4, 5, 6],
    engineRPM: 0,
    orientation: 1.25,
    frontTilt: 0.1,
    sideTilt: -0.2,
    angleChange: 0.3,
    verticalSpeed: 0.4,
    horizontalSpeed: 2.5
  });
  assert.notStrictEqual(packet.position, position);

  const idlePacket = createNpcPositionUpdate(position, 43, {
    stance: 1024,
    engineRPM: 0,
    orientation: 1.25,
    frontTilt: 0,
    sideTilt: 0,
    angleChange: 0.1,
    verticalSpeed: 0,
    horizontalSpeed: 0
  });
  assert.equal(idlePacket.stance, 1024);
  assert.equal(idlePacket.horizontalSpeed, 0);
  assert.equal(idlePacket.verticalSpeed, 0);
});
