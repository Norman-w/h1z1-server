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

/**
 * `AddLightweightNpc.profileId` is the record ID in
 * `ServerProfileDefinitions.json`, not the profile type stored in
 * `profileData.unknownByte1`.
 *
 * The records below are tied to the native animal profiles by the checked-in
 * 2016 data:
 *   - deer: record 19, type 22, name 1245 (Deer)
 *   - wolf: record 20, type 23, name 1213 (Wolf)
 *   - bear: record 80, type 24, name 1246 (Bear)
 *   - rabbit: record 85, type 26, name 21 (Rabbit)
 *
 * Keeping these IDs in one place prevents the old type numbers (22/23/24)
 * from being sent on the wire as if they were record IDs.  Deer buck uses
 * the same profile as deer doe because both models use the Deer001 graph.
 */
export const ANIMAL_PROFILE_IDS = Object.freeze({
  DEER: 19,
  RABBIT: 85,
  WOLF: 20,
  BEAR: 80
} as const);
