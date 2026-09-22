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
import {
  ANIMAL_NATIVE_LOCOMOTION_PROFILE,
  DEER_NATIVE_TURN_PROFILE,
  Npc
} from "./npc";
import { ANIMAL_PROFILE_IDS } from "./animalprofiles";
import { createDeer } from "../jsms/deer.jsm";
import { Factions } from "../jsms/factions";

export class Deer extends Npc {
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
    this.health = 7500;
    this.materialType = MaterialTypes.FLESH;
    this.npcMeleeDamage = 0;
    this.nativeMeleeCapability = "passive";
    this.profileId = ANIMAL_PROFILE_IDS.DEER;
    this.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
    this.nativeTurnProfile = DEER_NATIVE_TURN_PROFILE;
    // Passive animals still need an authoritative reset clip in their spawn
    // packet when the optional AI FSM is disabled.
    this.initializeAnimation("Idle");
    // Deer is passive in the current server FSM, but keep its native attack
    // metadata available to diagnostics/future behavior work.  The shared
    // graph resource is Animals_Buck001_Attack (80 frames at 30 FPS).
    this.nativeMeleeAnimationDurationMs = 2667;
    this.nativeMeleeAnimationSource = "Animals_Buck001_Attack";
    // Passive Deer still receives player hits; AnimalsX64 exposes its recoil
    // clip as a 30-frame resource-side candidate.
    this.nativeMeleeFlinchAnimationDurationMs = 1000;
    // Recorded for the shared AnimalsPhysics contract even though Deer is
    // passive and never enters the melee FSM.
    this.meleeContactWindow = {
      startFraction: 0.3,
      endFraction: 0.7
    };
    this.npcId = NpcIds.DEER;
    this.faction = Factions.PASSIVE;
    this.nameId = StringIds.DEER;
    this.rewardItems = [
      { itemDefId: Items.MEAT_VENISON, weight: 30 },
      { itemDefId: Items.ANIMAL_FAT, weight: 20 },
      { itemDefId: Items.DEER_BLADDER, weight: 10 }
    ];
    if (!process.env.DISABLE_AI && server.aiEnabled) {
      this.fsm = createDeer(this, server);
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
