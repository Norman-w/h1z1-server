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
import { Items, MaterialTypes, NpcIds, StringIds } from "../models/enums";
import type { AddLightweightNpc } from "types/zone2016packets";
import {
  ANIMAL_NATIVE_LOCOMOTION_PROFILE,
  Npc,
  RABBIT_NATIVE_TURN_PROFILE
} from "./npc";
import { ANIMAL_PROFILE_IDS } from "./animalprofiles";
import { createRabbit } from "../jsms/rabbit.jsm";
import { Factions } from "../jsms/factions";

export class Rabbit extends Npc {
  override pGetLightweight(): AddLightweightNpc {
    return {
      ...super.pGetLightweight(),
      npcDefinitionId: NpcIds.RABBIT,
      useCollision: 1
    };
  }

  constructor(
    characterId: string,
    transientId: number,
    actorModelId: number,
    position: Float32Array,
    rotation: Float32Array,
    server: ZoneServer2016,
    spawnerId: number = 0
  ) {
    super(
      characterId,
      transientId,
      actorModelId,
      position,
      rotation,
      server,
      spawnerId
    );
    this.health = 1500;
    this.materialType = MaterialTypes.FLESH;
    this.npcMeleeDamage = 0;
    this.nativeMeleeCapability = "passive";
    this.profileId = ANIMAL_PROFILE_IDS.RABBIT;
    this.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
    this.nativeTurnProfile = RABBIT_NATIVE_TURN_PROFILE;
    // Preserve the persistent spawn reset even when AI is disabled and the
    // optional rabbit FSM is not constructed.
    this.initializeAnimation("Idle");
    // Rabbit is passive in the current server FSM.  Preserve the native clip
    // timing for diagnostics and any later attack-capability implementation.
    this.nativeMeleeAnimationDurationMs = 2333;
    this.nativeMeleeAnimationSource = "Animals_Rabbit001_Attack";
    // AnimalsX64 exposes Rabbit001 Flinch as the resource-side candidate for
    // the shared MeleeFlinch event (39 frames).
    this.nativeMeleeFlinchAnimationDurationMs = 1300;
    // Recorded for the shared AnimalsPhysics contract even though Rabbit is
    // passive and never enters the melee FSM.
    this.meleeContactWindow = {
      startFraction: 0.214286,
      endFraction: 0.785714
    };
    this.npcId = NpcIds.RABBIT;
    this.faction = Factions.PASSIVE;
    this.nameId = StringIds.RABBIT;
    this.rewardItems = [
      { itemDefId: Items.MEAT_RABBIT, weight: 30 },
      { itemDefId: Items.ANIMAL_FAT, weight: 10 }
    ];
    if (!process.env.DISABLE_AI && server.aiEnabled) {
      this.fsm = createRabbit(this, server);
    }
  }

  protected addLoot(_server: ZoneServer2016): void {}

  protected onHarvest(server: ZoneServer2016, client: ZoneClient2016): void {
    this.triggerAwards(server, client, this.rewardItems);
  }

  protected buildInteractionString(
    server: ZoneServer2016,
    client: ZoneClient2016
  ): void {
    this.sendInteractionString(server, client, StringIds.HARVEST);
  }
}
