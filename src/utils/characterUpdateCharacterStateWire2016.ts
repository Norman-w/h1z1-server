// ======================================================================
// Character.UpdateCharacterState (0x0f0a)：2016 客户端 FUN_1404f1080 case9。
// `FUN_1404f1080` 的 param_2 指向完整包头（包含 2B opcode），param_3
// 是这整个缓冲区的长度。它固定消费 22B：2B opcode + 8B characterId
// + 12B states/gameTime。H1EMU 的 schema 包正好就是原生 parser 需要的
// 形状；此前把 12B 尾误当成“还要再拼 22B payload”会导致 32B 包被
// parser 以“有剩余字节”为由拒绝。
// ======================================================================

/** characterId 之后的 schema 尾长度：7×states + placeholder + gameTime。 */
export const H1EMU_UCS_SCHEMA_TAIL_BYTES = 12;
/** 原生 case9 从完整包头读取的总长度。 */
export const CLIENT_1080_UCS_PACKET_BYTES = 2 + 8 + H1EMU_UCS_SCHEMA_TAIL_BYTES;

/**
 * 从 **含 2B opcode** 的完整 `pack` 缓冲读取 H1EMU schema 尾中的 Q1 与 gameTime。
 * Q1 = characterId 后第 1～8 字节（states1..7 + placeholder 共 8B，按 LE QWORD 解释）。
 */
export function extractUcsCase9Q1AndGameTimeFromH1emuPackedFullBuffer(
  packed: Buffer
): { q1: bigint; gameTime: number } | null {
  const need = CLIENT_1080_UCS_PACKET_BYTES;
  if (packed.length < need) return null;
  return {
    q1: packed.readBigUInt64LE(10),
    gameTime: packed.readUInt32LE(18)
  };
}

/**
 * 旧调试工具使用的 22B body 构造器：A0/A1/Q0/Q1/T0（小端）。
 * 生产 `Character.UpdateCharacterState` 不应直接使用这个 body；生产包
 * 必须保留 opcode + characterId，交给 schema 生成的完整 22B。
 */
export function buildUcsCase9WireBody22(fields: {
  a0?: number;
  a1?: number;
  q0?: bigint;
  q1?: bigint;
  gameTime?: number;
}): Buffer {
  const body = Buffer.allocUnsafe(22);
  body.writeUInt8(fields.a0 ?? 0, 0);
  body.writeInt8(Math.max(-128, Math.min(127, fields.a1 ?? 0)), 1);
  body.writeBigUInt64LE(fields.q0 ?? 0n, 2);
  body.writeBigUInt64LE(fields.q1 ?? 0n, 10);
  body.writeUInt32LE((fields.gameTime ?? 1) >>> 0, 18);
  return body;
}

/**
 * 校验并返回 H1EMU schema 生成的原生 case9 完整包。
 *
 * 函数名保留兼容旧 dev API；这里不再扩展或重排字节。原生 parser 的
 * 22B 读取范围已经包含 opcode 与 characterId，追加 10B 会让它拒绝包。
 */
export function expandH1emuUpdateCharacterStatePackToClient1080(
  fullPacked: Buffer
): Buffer | null {
  const extracted = extractUcsCase9Q1AndGameTimeFromH1emuPackedFullBuffer(fullPacked);
  if (!extracted || fullPacked.length !== CLIENT_1080_UCS_PACKET_BYTES) return null;
  return Buffer.from(fullPacked);
}
