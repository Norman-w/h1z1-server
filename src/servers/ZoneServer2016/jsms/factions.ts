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

export enum Factions {
  None = 0,
  HUMAN = 1,
  ZOMBIE = 2,
  WOLF = 3,
  BEAR = 4,
  PASSIVE = 5
}

const HOSTILITY: Record<Factions, Factions[]> = {
  [Factions.None]: [],
  [Factions.HUMAN]: [],
  [Factions.ZOMBIE]: [
    Factions.HUMAN,
    Factions.WOLF,
    Factions.BEAR,
    Factions.PASSIVE
  ],
  [Factions.WOLF]: [Factions.HUMAN, Factions.ZOMBIE, Factions.PASSIVE],
  [Factions.BEAR]: [Factions.HUMAN, Factions.ZOMBIE],
  [Factions.PASSIVE]: []
};

export function isHostile(attacker: Factions, target: Factions): boolean {
  return HOSTILITY[attacker].includes(target);
}

/**
 * Passive wildlife reacts to the factions that can actually threaten it.
 *
 * This is intentionally not expressed as `faction !== PASSIVE`: the spatial
 * target map also contains neutral/unknown entries and other passive animals.
 * Treating those entries as threats makes deer/rabbits flee for no gameplay
 * reason and can leave them permanently in their flee loop.
 */
export function isThreatToPassive(faction: Factions): boolean {
  return (
    faction === Factions.HUMAN ||
    faction === Factions.ZOMBIE ||
    faction === Factions.WOLF ||
    faction === Factions.BEAR
  );
}
