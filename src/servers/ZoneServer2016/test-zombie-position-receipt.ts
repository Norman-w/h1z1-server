/** A real inbound position observation, not a transport or animation-ready ACK. */
export interface TestZombiePositionReceipt {
  count: number;
  character: object;
  playerCharacterId: string;
  receivedAt: number;
  sequenceTime: number;
  flags: number;
  movementVersion: number;
  position: readonly [number, number, number, number];
  rotation: readonly [number, number, number, number] | null;
  clockAligned: true;
}

/** Structural input keeps this observer independent of the ZoneServer runtime. */
export interface TestZombiePositionReceiptClient {
  testZombieSpawned?: boolean;
  isSynced?: boolean;
  isLoading?: boolean;
  character?: {
    characterId?: string;
    isAlive?: boolean;
    isRespawning?: boolean;
  } | null;
  testZombiePositionReceipt?: TestZombiePositionReceipt;
}

const isU32 = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

function vector4(value: unknown): readonly [number, number, number, number] | null {
  if (!(Array.isArray(value) || value instanceof Float32Array) || value.length !== 4 ||
      !Array.from(value).every(item => typeof item === "number" && Number.isFinite(item))) {
    return null;
  }
  return Object.freeze([value[0], value[1], value[2], value[3]] as [number, number, number, number]);
}

/**
 * Call after this packet's gameplay position/rotation has been applied. Only raw
 * packet fields are copied; merged character state must never fill missing data.
 * This function neither sends packets nor changes clock-ready/observed-version.
 */
export function recordTestZombiePositionReceipt(
  client: TestZombiePositionReceiptClient,
  packet: unknown,
  serverTime: number
): boolean {
  const character = client.character;
  if (client.testZombieSpawned !== true || client.isSynced !== true || client.isLoading !== false ||
      !character || character.isAlive !== true || character.isRespawning !== false ||
      typeof character.characterId !== "string" || character.characterId.length === 0 ||
      !packet || typeof packet !== "object" || Array.isArray(packet)) {
    return false;
  }
  const data = packet as Record<string, unknown>;
  const flags = data.flags, sequenceTime = data.sequenceTime, movementVersion = data.unknown3_int8;
  if ((data.parseError !== undefined && data.parseError !== false) ||
      typeof flags !== "number" || !Number.isInteger(flags) || flags < 0 || flags > 0xffff || !(flags & 2) ||
      !isU32(sequenceTime) || !isU32(serverTime) ||
      typeof movementVersion !== "number" || !Number.isInteger(movementVersion) ||
      movementVersion < 0 || movementVersion > 255 ||
      Math.abs((sequenceTime - serverTime) | 0) > 500 ||
      !Object.prototype.hasOwnProperty.call(data, "position")) {
    return false;
  }
  const position = vector4(data.position);
  if (!position || position[3] !== 1) return false;

  const previous = client.testZombiePositionReceipt;
  if (previous && (!Number.isSafeInteger(previous.count) || previous.count < 1 ||
      previous.count >= Number.MAX_SAFE_INTEGER || !isU32(previous.sequenceTime))) {
    return false;
  }
  // Signed modular order accepts the normal u32 wrap, but not duplicates,
  // backwards packets or the ambiguous half-range jump. A new character may
  // restart its sequence; the observer count still advances across characters.
  if (previous?.character === character && ((sequenceTime - previous.sequenceTime) | 0) <= 0) {
    return false;
  }
  const receivedAt = Date.now();
  if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) return false;
  const rotation = (flags & 0x200) && Object.prototype.hasOwnProperty.call(data, "rotation")
    ? vector4(data.rotation) : null;
  client.testZombiePositionReceipt = Object.freeze({
    count: (previous?.count ?? 0) + 1,
    character,
    playerCharacterId: character.characterId,
    receivedAt,
    sequenceTime,
    flags,
    movementVersion,
    position,
    rotation,
    clockAligned: true
  });
  return true;
}
