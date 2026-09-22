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
import {
  ANIMAL_NATIVE_LOCOMOTION_PROFILE,
  BEAR_NATIVE_TURN_PROFILE,
  Npc
} from "./npc";
import { ANIMAL_PROFILE_IDS } from "./animalprofiles";
import { createBear } from "../jsms/bear.jsm";
import { Factions } from "../jsms/factions";

export class Bear extends Npc {
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
      ModelIds.BEAR,
      position,
      rotation,
      server,
      spawnerId
    );
    this.health = 20000;
    this.materialType = MaterialTypes.FLESH;
    this.npcMeleeDamage = 4000;
    this.nativeMeleeCapability = "attacker";
    this.profileId = ANIMAL_PROFILE_IDS.BEAR;
    this.nativeLocomotionProfile = ANIMAL_NATIVE_LOCOMOTION_PROFILE;
    this.nativeTurnProfile = BEAR_NATIVE_TURN_PROFILE;
    // AddLightweightNpc is sent after construction; keep a persistent reset
    // clip available even when AI is disabled and no FSM is created.
    this.initializeAnimation("Idle");
    // AnimalsPhysicsX64.mrn binds Bear001's attack branch to Attack01;
    // Animals_Bear001_Attack01 is 30 frames at 30 FPS (1.000s).  Attack02 is
    // present in the broad AnimalsX64 source table but is not referenced by
    // the loaded physics graph, so do not select it speculatively.
    this.nativeMeleeAnimationDurationMs = 1000;
    this.nativeMeleeAnimationSource = "Animals_Bear001_Attack01";
    // AnimalsX64 exposes Bear001 CmbtRecoil as the resource-side candidate
    // for the shared MeleeFlinch event (50 frames).
    this.nativeMeleeFlinchAnimationDurationMs = 1667;
    // AnimalsPhysicsX64.mrn Bear001 SwingContact interval: 0.266667–0.733333.
    // Keep this as a normalized native-graph window; the attack FSM scales it
    // by its resolved attack duration instead of using a guessed hit delay.
    this.meleeContactWindow = {
      startFraction: 0.266667,
      endFraction: 0.733333
    };
    this.npcId = NpcIds.BEAR;
    this.faction = Factions.BEAR;
    this.nameId = StringIds.BEAR;
    this.rewardItems = [
      { itemDefId: Items.MEAT_BEAR, weight: 40 },
      { itemDefId: Items.ANIMAL_FAT, weight: 20 }
    ];
    if (!process.env.DISABLE_AI && server.aiEnabled) {
      this.fsm = createBear(this, server);
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
