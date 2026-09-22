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

import { ZoneServer2016 } from "../zoneserver";
import { ZoneClient2016 } from "../classes/zoneclient";
import { ModelIds } from "../models/enums";
import { Npc, RAVEN_NATIVE_TURN_PROFILE } from "./npc";

// ponytail: inert NPC — spawns and stands there. No fsm, so no AI tick;
// no loot/harvest/interaction. Used as the fallback for unknown model ids.
export class BasicNpc extends Npc {
  constructor(
    characterId: string,
    transientId: number,
    actorModelId: number,
    position: Float32Array,
    rotation: Float32Array,
    server: ZoneServer2016,
    spawnerId: number = 0,
    variant: string = ""
  ) {
    super(
      characterId,
      transientId,
      actorModelId,
      position,
      rotation,
      server,
      spawnerId,
      variant
    );
    // Raven is an inert test/fallback entity today, but its client graph has
    // native continuous TurnLeft/TurnRight transitions. Preserve that graph
    // contract instead of treating it as an unknown model with a pivot turn.
    if (actorModelId === ModelIds.RAVEN) {
      this.nativeTurnProfile = RAVEN_NATIVE_TURN_PROFILE;
    }
  }

  protected addLoot(_server: ZoneServer2016): void {}

  protected onHarvest(_server: ZoneServer2016, _client: ZoneClient2016): void {}

  protected buildInteractionString(
    _server: ZoneServer2016,
    _client: ZoneClient2016
  ): void {}
}
