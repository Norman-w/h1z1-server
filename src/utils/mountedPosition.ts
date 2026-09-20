// ======================================================================
//
//   GNU GENERAL PUBLIC LICENSE
//   Version 3, 29 June 2007
//   copyright (C) 2020 - 2021 Quentin Gruber
//   copyright (C) 2021 - 2026 H1emu community
//
//   https://github.com/QuentinGruber/h1z1-server
//   https://www.npmjs.com/package/h1z1-server
//
//   Based on https://github.com/psemu/soe-network
// ======================================================================

/** Which authoritative stream supplied a mounted character's world point. */
export type MountedPositionSource = "player-update" | "vehicle-root";

export interface MountedPositionResolution {
  position: Float32Array;
  source: MountedPositionSource;
  sequenceTime: number | null;
}

function asFinitePosition(value: unknown): Float32Array | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as ArrayLike<unknown>;
  if (candidate.length < 3) return null;
  const x = Number(candidate[0]);
  const y = Number(candidate[1]);
  const z = Number(candidate[2]);
  if (![x, y, z].every(Number.isFinite)) return null;
  const w = Number(candidate[3]);
  return new Float32Array([x, y, z, Number.isFinite(w) ? w : 1]);
}

function asSequenceTime(value: unknown): number | null {
  const sequenceTime = Number(value);
  return Number.isInteger(sequenceTime) && sequenceTime >= 0
    ? sequenceTime >>> 0
    : null;
}

/** Compare uint32 clocks while remaining correct across a wrap. */
function isAtOrAfter(candidate: number, reference: number): boolean {
  return ((candidate - reference) >>> 0) < 0x80000000;
}

/**
 * Compare two optional wire sequence clocks without duplicating uint32 wrap
 * handling in packet handlers.  An absent reference means there is no newer
 * authoritative sample to protect; an absent candidate is never current.
 */
export function isSequenceTimeAtOrAfter(
  candidate: unknown,
  reference: unknown
): boolean {
  const candidateTime = asSequenceTime(candidate);
  const referenceTime = asSequenceTime(reference);
  return (
    candidateTime !== null &&
    (referenceTime === null || isAtOrAfter(candidateTime, referenceTime))
  );
}

/**
 * Resolve a mounted character's target point without inventing a seat offset.
 *
 * A mounted client can send a character position stream as well as the managed
 * vehicle stream. When that character sample is at least as new as the
 * vehicle sample, it is the only server-observable world-space seat point and
 * must be retained for AI targeting. If no usable character sample exists,
 * the vehicle root remains the conservative fallback used by older clients.
 */
export function resolveMountedCharacterPosition(
  playerPosition: unknown,
  playerSequenceTime: unknown,
  vehiclePosition: unknown,
  vehicleSequenceTime: unknown
): MountedPositionResolution {
  const resolvedVehiclePosition = asFinitePosition(vehiclePosition);
  if (!resolvedVehiclePosition) {
    throw new Error("vehicle position is not a finite 3-D point");
  }

  const resolvedPlayerPosition = asFinitePosition(playerPosition);
  const playerClock = asSequenceTime(playerSequenceTime);
  const vehicleClock = asSequenceTime(vehicleSequenceTime);
  const playerIsCurrent =
    resolvedPlayerPosition !== null &&
    (vehicleClock === null ||
      isSequenceTimeAtOrAfter(playerClock, vehicleClock));

  if (playerIsCurrent) {
    return {
      position: resolvedPlayerPosition,
      source: "player-update",
      sequenceTime: playerClock
    };
  }

  return {
    position: resolvedVehiclePosition,
    source: "vehicle-root",
    sequenceTime: vehicleClock
  };
}
