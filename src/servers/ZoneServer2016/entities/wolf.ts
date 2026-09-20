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
import {
  Items,
  MaterialTypes,
  ModelIds,
  NpcIds,
  StringIds
} from "../models/enums";
import { ANIMAL_NATIVE_LOCOMOTION_PROFILE, Npc } from "./npc";
import { ANIMAL_PROFILE_IDS } from "./animalprofiles";
import { createWolf } from "../jsms/wolf.jsm";
import { Factions } from "../jsms/factions";

export class Wolf extends Npc {
  constructor(
    characterId: string,
    transientId: number,
    position: Float32Array,
    rotation: Float32Array,
    server: ZoneServer2016,
    spawnerId: number = 0
  ) {
    super(
      characterId,
      transientId,
      ModelIds.WOLF,
      position,
      rotation,
      server,
      spawnerId
    );
    this.health = 7500;
    this.materialType = MaterialTypes.FLESH;
    this.npcMeleeDamage = 2000;
    this.nativeMeleeCapability = "attacker";
    this.profileId = ANIMAL_PROFILE_IDS.WOLF;
    this.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
    // Keep the spawn/late-observer reset clip available without relying on
    // the optional AI FSM being enabled.
    this.initializeAnimation("Idle");
    // AnimalsX64.mrn: Animals_Wolf001_AttackB = 50 frames at 30 FPS.
    // AnimalsPhysics' KnifeSlash event uses this actor resource for Wolf001;
    // keep the wire clock on the selected clip rather than the generic 1430ms
    // player-weapon compatibility value.
    this.nativeMeleeAnimationDurationMs = 1667;
    this.nativeMeleeAnimationSource = "Animals_Wolf001_AttackB";
    // AnimalsX64 exposes Wolf001 FlinchB as the resource-side candidate for
    // the shared MeleeFlinch event (30 frames).
    this.nativeMeleeFlinchAnimationDurationMs = 1000;
    // AnimalsPhysicsX64.mrn Wolf001 SwingContact interval: 0.26–0.74.
    this.meleeContactWindow = {
      startFraction: 0.259999,
      endFraction: 0.740001
    };
    this.npcId = NpcIds.WOLF;
    this.faction = Factions.WOLF;
    this.nameId = StringIds.WOLF;
    this.rewardItems = [
      { itemDefId: Items.MEAT_WOLF, weight: 30 },
      { itemDefId: Items.ANIMAL_FAT, weight: 20 }
    ];
    if (!process.env.DISABLE_AI && server.aiEnabled) {
      this.fsm = createWolf(this, server);
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
