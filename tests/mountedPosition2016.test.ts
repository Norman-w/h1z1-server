import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveMountedCharacterPosition
} from "../out/utils/mountedPosition";

const point = (x: number, y: number, z: number) =>
  new Float32Array([x, y, z, 1]);

test("mounted target keeps a current player world position over the vehicle root", () => {
  const result = resolveMountedCharacterPosition(
    point(10, 4.5, 20),
    120,
    point(10, 2, 20),
    119
  );

  assert.equal(result.source, "player-update");
  assert.deepEqual(Array.from(result.position), [10, 4.5, 20, 1]);
  assert.equal(result.sequenceTime, 120);
});

test("mounted target falls back to the vehicle root when the player sample is stale", () => {
  const result = resolveMountedCharacterPosition(
    point(10, 4.5, 20),
    118,
    point(12, 2, 20),
    119
  );

  assert.equal(result.source, "vehicle-root");
  assert.deepEqual(Array.from(result.position), [12, 2, 20, 1]);
  assert.equal(result.sequenceTime, 119);
});

test("mounted target comparison handles the uint32 clock wrap", () => {
  const result = resolveMountedCharacterPosition(
    point(10, 4.5, 20),
    0x00000010,
    point(10, 2, 20),
    0xfffffff0
  );

  assert.equal(result.source, "player-update");
});

test("mounted target rejects malformed player positions without inventing an offset", () => {
  const result = resolveMountedCharacterPosition(
    [10, Number.NaN, 20],
    120,
    point(10, 2, 20),
    119
  );

  assert.equal(result.source, "vehicle-root");
  assert.deepEqual(Array.from(result.position), [10, 2, 20, 1]);
});
