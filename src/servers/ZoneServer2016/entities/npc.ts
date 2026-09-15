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

import { DamageInfo } from "types/zoneserver";
import { ZoneServer2016 } from "../zoneserver";
import { BaseFullCharacter } from "./basefullcharacter";
import { ZoneClient2016 } from "../classes/zoneclient";
import {
  chance,
  createNpcPositionUpdate,
  eul2quat,
  generateRandomGuid,
  getCurrentServerTimeWrapper,
  getDistance,
  logClientActionToMongo,
  quat2heading,
  randomIntFromInterval
} from "../../../utils/utils";
import { DB_COLLECTIONS, KILL_TYPE } from "../../../utils/enums";
import {
  Items,
  MaterialTypes,
  MeleeTypes,
  ModelIds,
  NpcIds,
  PositionUpdateType,
  StringIds
} from "../models/enums";
import { CommandInteractionString } from "types/zone2016packets";
import { BaseEntity } from "./baseentity";
import { ChallengeType } from "../managers/challengemanager";
import { ProjectileEntity } from "./projectileentity";
import { Lootbag } from "../entities/lootbag";
import { LoadoutContainer } from "../classes/loadoutcontainer";

/** NPC 位置广播节流（ms）。追逐时用更短间隔以便客户端线性插值/移动表现；客户端已证实 `Character.SeekTarget` 会安装主动追逐控制器，但位置包仍会明显影响表现平滑度。 */
const NPC_POSITION_BROADCAST_INTERVAL_MS = 500;
const NPC_POSITION_BROADCAST_CHASE_MS = 150;

/** Experimental packet timeline, not a delivery or client-acceptance record. */
type TestRouteMotion = {
  sequenceTime: number;
  elapsedMs: number;
  previousSequenceTime: number;
  previousPosition: [number, number];
};

/**
 * The server-side melee envelope resolved from the same item/weapon/fire-mode
 * tables used by the player combat path.  This is deliberately data-shaped:
 * attack reach must not be reintroduced as a second guessed constant in AI.
 */
export interface NpcMeleeAttackProfile {
  itemDefinitionId: number;
  weaponDefinitionId: number;
  fireGroupId: number;
  fireModeId: number;
  range: number;
  detectWidth: number;
  detectHeight: number;
  fireDurationMs: number;
  refireTimeMs: number;
}

function routeWireXZ(position: ArrayLike<number>): [number, number] {
  // Match packPositionUpdateData's centimetre grid before comparing endpoints.
  return [Math.round(position[0] * 100) / 100, Math.round(position[2] * 100) / 100];
}

function createNpcMeleeDamageInfo(npc: {
  characterId: string;
  meleeWeaponItemDefinitionId: Items;
  npcMeleeDamage: number;
  state: { position: Float32Array };
}): DamageInfo {
  return {
    entity: npc.characterId,
    weapon: npc.meleeWeaponItemDefinitionId,
    damage: npc.npcMeleeDamage,
    causeBleed: false, // another method for melees to apply bleeding
    meleeType: MeleeTypes.BLADE,
    hitReport: {
      sessionProjectileCount: 0,
      // `characterId` is the source of a damage report.  The old code put
      // the victim GUID here; Character.damage() consequently classified
      // the packet as a PvE player hit and returned before changing health
      // or sending ClientUpdate.DamageInfo.
      characterId: npc.characterId,
      position: npc.state.position.slice(),
      unknownFlag1: 0,
      unknownByte2: 0,
      totalShotCount: 0
    }
  };
}

export class Npc extends BaseFullCharacter {
  health: number;
  npcRenderDistance = 100;
  lastMeleeAttackTime = 0;
  lastPositionBroadcastTime = 0;
  /** 当前寻敌目标 characterId，用于 `Character.SeekTarget` 仅在目标变化时重发。客户端侧该包会安装/替换 seek controller。 */
  lastSeekTargetId: string | null = null;
  /** 上次发 `Character.SeekTargetUpdate` 的时间，用于节流；客户端侧该包只更新已安装 seek controller 的目标 guid。 */
  lastSeekTargetUpdateTime: number = 0;
  /** 行为状态：供服务器权威 + MemberStatus 通知客户端。0=idle, 1=chase, 2=attack。以客户端为准，服务端为实验性。 */
  behaviorState: 0 | 1 | 2 = 0;
  /**
   * Production native-seek only: a melee-to-chase transition must publish the
   * current zero-speed anchor before the first shadow position step.  This is
   * a one-tick handoff barrier, not a speed/animation tuning knob.
   */
  productionMovementHandoffPending = false;
  /** Last locomotion graph state sent through the native state-update packet. */
  lastLocomotionState: 0 | 1 | 2 | null = null;
  /**
   * Ask the client to install its native seek controller. This is independent
   * from the server position stream: the production route uses both inputs
   * (the seek packet is the controller/target hint, while `PlayerUpdatePosition`
   * supplies the visible motion samples that the client locomotion graph needs).
   */
  clientDrivenSeek = false;
  /**
   * Isolated `/ztest seek` switch. It suppresses the server position stream so
   * the seek-only A/B remains a real negative control; production leaves this
   * false because the live mixed arm is the only one that shows trustworthy
   * continuous locomotion.
   */
  suppressServerPositionBroadcast = false;
  /** Test encounter: use the verified proxied motion path after clearing the spawn controller. */
  testServerDrivenMovement = false;
  /** Diagnostic attempts only, bounded for this NPC lifetime; never an ACK count. */
  private testPositionTraceCount = 0;
  /** One-shot diagnostic for the production native-seek authority; never affects behavior. */
  private productionSeekTraceLogged = false;
  /** One-shot diagnostic for production AI admission; never affects behavior. */
  productionAiTraceLogged = false;
  /** Bounded production shadow-step trace; it records target height as evidence, not control. */
  productionMoveTraceCount = 0;
  private testRoutePacket?: {
    sequenceTime: number;
    position: [number, number];
    movementVersion: number;
    ready: boolean;
  };
  /** Only this test owner can acknowledge full data and arm its encounter. */
  testFullDataOwner?: ZoneClient2016;
  /**
   * Optional test-scene reachability gate. Inputs are current absolute NETWORK
   * origins; the scene adapter must explicitly resolve its own contact heights.
   * This is an experimental obstacle policy, not a recovered native melee mask.
   */
  testMeleeReachability?: (
    attackerPosition: Float32Array,
    targetPosition: Float32Array
  ) => boolean;
  /** Bound route callback owns ground/origin conversion. Undefined means stop, never fallback. */
  testRouteStep?: (
    position: Float32Array,
    target: Float32Array,
    maxDistance: number
  ) => Float32Array | undefined;
  /** Optional per-replay route ownership, set before lifecycle.onSpawned; never shared or replaced. */
  testRouteResource?: { dispose(): void };
  testRouteStopped = false;
  /** 上次发给客户端动画图的 aggro 标量，用于避免重复广播。 */
  lastAggroLevel: number | null = null;
  /** 测试用：追逐/发包速度缩放（如 0.2 = 五分之一），仅测试僵尸设置，用于观察速度包是否生效 */
  testChaseSpeedScale: number = 1;
  spawnerId: number;
  deathTime: number = 0;
  npcId: number = 0;
  rewardItems: { itemDefId: number; weight: number }[] = [];
  flags = {
    bit0: 0,
    bit1: 0,
    bit2: 0,
    bit3: 0,
    bit4: 0,
    bit5: 0,
    bit6: 0,
    bit7: 0,
    nonAttackable: 0, // disables melee flinch
    bit9: 0,
    bit10: 0,
    bit11: 0,
    projectileCollision: 1,
    bit13: 0, // causes a crash if 1 with noCollide 1
    bit14: 0,
    bit15: 0,
    bit16: 0,
    bit17: 0,
    bit18: 0,
    bit19: 0,
    noCollide: 0, // determines if NpcCollision packet gets sent on player collide
    knockedOut: 0, // knockedOut = 1 will not show the entity if the value is sent immediatly at 1
    bit22: 0,
    bit23: 0
  };
  public get isAlive(): boolean {
    return this.deathTime == 0;
  }
  server: ZoneServer2016;
  npcMeleeDamage: number;
  /** Item definition whose weapon/fire-mode data defines the NPC strike. */
  meleeWeaponItemDefinitionId: Items = Items.WEAPON_MACHETE01;
  isSelected: boolean = false;
  constructor(
    characterId: string,
    transientId: number,
    actorModelId: number,
    position: Float32Array,
    rotation: Float32Array,
    server: ZoneServer2016,
    spawnerId: number = 0
  ) {
    super(characterId, transientId, actorModelId, position, rotation, server);
    this.positionUpdateType = PositionUpdateType.MOVABLE;
    this.movementVersion = 1;
    this.useCollision = 1;
    this.spawnerId = spawnerId;
    this.health = 10000;
    this.initNpcData();
    this.server = server;
    switch (actorModelId) {
      case ModelIds.ZOMBIE_FEMALE_WALKER:
      case ModelIds.ZOMBIE_MALE_WALKER:
        this.materialType = MaterialTypes.ZOMBIE;
        this.npcMeleeDamage = 2000;
        break;
      case ModelIds.ZOMBIE_SCREAMER:
        this.materialType = MaterialTypes.ZOMBIE;
        this.npcMeleeDamage = 3000;
        break;
      case ModelIds.DEER:
      case ModelIds.DEER_BUCK:
        this.materialType = MaterialTypes.FLESH;
        this.npcMeleeDamage = 0;
        break;
      case ModelIds.WOLF:
        this.materialType = MaterialTypes.FLESH;
        this.npcMeleeDamage = 2000;
        break;
      case ModelIds.BEAR:
        this.materialType = MaterialTypes.FLESH;
        this.npcMeleeDamage = 4000;
        break;
      default:
        this.materialType = MaterialTypes.FLESH;
        this.npcMeleeDamage = 0;
        break;
    }
    server.aiManager.addEntity(this);
  }

  /** 与 zoneserver.sendAnimationToAllWithSpawnedEntity 一致：补全 animationType、unknownDword3 等，便于客户端播走路/攻击 */
  playAnimation(
    animationName: string,
    options?: { animationType?: string; animationId?: number }
  ) {
    this.server.sendDataToAllWithSpawnedEntity(
      this.server._npcs,
      this.characterId,
      "Character.PlayAnimation",
      {
        characterId: this.characterId,
        animationName,
        animationType: options?.animationType ?? "ActionType",
        unm4: 0,
        unknownDword1: 1430,
        unknownByte1: 0,
        unknownDword2: 1430,
        unknownByte1xda: 0,
        unknownDword3: options?.animationId ?? 1430
      }
    );
  }

  /**
   * Resolve the NPC strike envelope from the authoritative item tables.
   *
   * Machete is the existing NPC melee item in this server.  Following its
   * item -> weapon -> fire group -> fire mode chain keeps RANGE and the native
   * MELEE_DETECT dimensions in one source of truth.  If any link is missing or
   * malformed we fail closed instead of silently falling back to a guessed
   * distance.
   */
  getMeleeAttackProfile(): NpcMeleeAttackProfile | undefined {
    const itemDefinitionId = this.meleeWeaponItemDefinitionId;
    if (!this.server || typeof this.server.getItemDefinition !== "function" ||
        typeof this.server.getWeaponDefinition !== "function" ||
        typeof this.server.getFiregroupDefinition !== "function" ||
        typeof this.server.getFiremodeDefinition !== "function") return;

    const itemDefinition = this.server.getItemDefinition(itemDefinitionId);
    const weaponDefinitionId = Number(itemDefinition?.PARAM1);
    if (!Number.isFinite(weaponDefinitionId) || weaponDefinitionId <= 0) return;

    const weaponDefinition = this.server.getWeaponDefinition(weaponDefinitionId);
    const fireGroupId = Number(weaponDefinition?.FIRE_GROUPS?.[0]?.FIRE_GROUP_ID);
    if (!Number.isFinite(fireGroupId) || fireGroupId <= 0) return;

    const firegroupDefinition = this.server.getFiregroupDefinition(fireGroupId);
    const fireModeId = Number(firegroupDefinition?.FIRE_MODES?.[0]?.FIRE_MODE_ID);
    if (!Number.isFinite(fireModeId) || fireModeId <= 0) return;

    const fireModeDefinition = this.server.getFiremodeDefinition(fireModeId);
    const range = Number(fireModeDefinition?.RANGE);
    const detectWidth = Number(weaponDefinition?.MELEE_DETECT?.MELEE_DETECT_WIDTH);
    const detectHeight = Number(weaponDefinition?.MELEE_DETECT?.MELEE_DETECT_HEIGHT);
    const fireDurationMs = Number(fireModeDefinition?.FIRE_DURATION_MS);
    const refireTimeMs = Number(fireModeDefinition?.REFIRE_TIME_MS);
    if (!Number.isFinite(range) || range <= 0 ||
        !Number.isFinite(detectWidth) || detectWidth < 0 ||
        !Number.isFinite(detectHeight) || detectHeight < 0 ||
        !Number.isFinite(fireDurationMs) || fireDurationMs < 0 ||
        !Number.isFinite(refireTimeMs) || refireTimeMs < 0) return;

    return {
      itemDefinitionId,
      weaponDefinitionId,
      fireGroupId,
      fireModeId,
      range,
      detectWidth,
      detectHeight,
      fireDurationMs,
      refireTimeMs
    };
  }

  applyDamage(characterId: string) {
    const client = this.server.getClientByCharId(characterId);
    if (client) {
      client.character.OnMeleeHit(this.server, createNpcMeleeDamageInfo(this));
    } else {
      console.log(
        `CharacterId ${characterId} not found when applying damage from npc`
      );
    }
  }

  /**
   * Test-only presentation probe: send the game's existing victim feedback
   * packet without entering OnMeleeHit (which also mutates bleeding). The
   * caller must already have passed the authoritative melee envelope; this
   * method deliberately has no range/timing policy of its own.
   */
  sendMeleeDamageFeedback(characterId: string): boolean {
    const client = this.server.getClientByCharId(characterId);
    if (!client || !client.character ||
        typeof client.character.sendDamageFeedback !== "function") return false;
    return client.character.sendDamageFeedback(
      this.server,
      createNpcMeleeDamageInfo(this)
    );
  }

  async damage(server: ZoneServer2016, damageInfo: DamageInfo) {
    let client = server.getClientByCharId(damageInfo.entity);
    if (!client) {
      const sourceEntity = server.getEntity(damageInfo.entity);
      if (sourceEntity instanceof ProjectileEntity) {
        client = server.getClientByCharId(sourceEntity.managerCharacterId);
      } else {
        return;
      }
    }
    const oldHealth = this.health;

    if ((this.health -= damageInfo.damage) <= 0 && this.isAlive) {
      this.deathTime = Date.now();
      this.flags.knockedOut = 1;

      // Custom lootbag for zombies
      switch (this.actorModelId) {
        case ModelIds.ZOMBIE_FEMALE_WALKER:
        case ModelIds.ZOMBIE_MALE_WALKER:
        case ModelIds.ZOMBIE_SCREAMER: {
          this.addZombieLoot(server);
          break;
        }
        default:
          server.worldObjectManager.createLootbag(server, this);
          break;
      }

      if (client) {
        if (this.npcId === NpcIds.ZOMBIE) {
          server.challengeManager.registerChallengeProgression(
            client,
            ChallengeType.BRAIN_DEAD,
            1
          );
        }
        if (!server._soloMode) {
          logClientActionToMongo(
            server._db.collection(DB_COLLECTIONS.KILLS),
            client,
            server._worldId,
            {
              type:
                this.npcId == NpcIds.ZOMBIE
                  ? KILL_TYPE.ZOMBIE
                  : KILL_TYPE.WILDLIFE
            }
          );
        }

        if (this.npcId == NpcIds.ZOMBIE)
          client.character.metrics.zombiesKilled++;
        else client.character.metrics.wildlifeKilled++;
      }
      for (const a in server._clients) {
        const c = server._clients[a];
        if (c.spawnedEntities.has(this)) {
          if (!c.isLoading) {
            server.sendData(c, "Character.StartMultiStateDeath", {
              data: {
                characterId: this.characterId,
                flag: 128,
                managerCharacterId: c.character.characterId
              }
            });
            server.sendData(c, "Character.ManagedObject", {
              objectCharacterId: this.characterId,
              characterId: c.character.characterId
            });
          } else {
            server.sendData(c, "Character.StartMultiStateDeath", {
              data: {
                characterId: this.characterId,
                flag: 0
              }
            });
          }
        }
      }
    }

    if (client) {
      const damageRecord = await server.generateDamageRecord(
        this.characterId,
        damageInfo,
        oldHealth
      );
      client.character.addCombatlogEntry(damageRecord);
    }
  }

  addZombieLoot(server: ZoneServer2016) {
    const lootItems: any[] = [];

    const wornLetters = [
      Items.WORN_LETTER_CHURCH_PV,
      Items.WORN_LETTER_LJ_PV,
      Items.WORN_LETTER_MISTY_DAM,
      Items.WORN_LETTER_RADIO,
      Items.WORN_LETTER_RUBY_LAKE,
      Items.WORN_LETTER_TOXIC_LAKE,
      Items.WORN_LETTER_VILLAS,
      Items.WORN_LETTER_WATER_TOWER
    ];
    // Worn letter (4% chance, up to 2)
    if (chance(50)) {
      const randomWornLetter =
        wornLetters[randomIntFromInterval(0, wornLetters.length - 1)];
      const wornLetterItem = server.generateItem(randomWornLetter, 1);
      if (wornLetterItem) {
        lootItems.push(wornLetterItem);
      }
    }

    const GoodammoTypes = [
      Items.AMMO_12GA,
      Items.AMMO_223,
      Items.AMMO_308,
      Items.AMMO_762
    ];
    // Ammo (5% chance)
    if (chance(50)) {
      for (let i = 0; i < 2; i++) {
        const randomAmmo =
          GoodammoTypes[randomIntFromInterval(0, GoodammoTypes.length - 1)];
        const ammoCount = randomIntFromInterval(1, 3);
        const ammoItem = server.generateItem(randomAmmo, ammoCount);
        if (ammoItem) {
          lootItems.push(ammoItem);
        }
      }
    }

    const ammoTypes = [Items.AMMO_380, Items.AMMO_9MM, Items.AMMO_45];
    // Ammo (10% chance)
    if (chance(100)) {
      for (let i = 0; i < ammoTypes.length - 1; i++) {
        const randomAmmo =
          ammoTypes[randomIntFromInterval(0, ammoTypes.length - 1)];
        const ammoCount = randomIntFromInterval(1, 5);
        const ammoItem = server.generateItem(randomAmmo, ammoCount);
        if (ammoItem) {
          lootItems.push(ammoItem);
        }
      }
    }

    const specialItems = [
      Items.WEAPON_BOW_MAKESHIFT,
      Items.BACKPACK_BLUE_ORANGE,
      Items.CRUMPLED_NOTE,
      Items.REFRIGERATOR_NOTE
    ];
    // Special item (15% chance)
    if (chance(150)) {
      for (let i = 0; i < specialItems.length - 1; i++) {
        const randomSpecial =
          specialItems[randomIntFromInterval(0, specialItems.length - 1)];
        const specialItem = server.generateItem(randomSpecial, 1);
        if (specialItem) {
          lootItems.push(specialItem);
        }
      }
    }

    // Prototype item (1% chance)
    const PrototypeItems = [
      Items.PROTOTYPE_MECHANISM,
      Items.PROTOTYPE_RECEIVER,
      Items.PROTOTYPE_TRIGGER_ASSEMBLY
    ];
    if (chance(10)) {
      const randomSpecial =
        PrototypeItems[randomIntFromInterval(0, PrototypeItems.length - 1)];
      const specialItem = server.generateItem(randomSpecial, 1);
      if (specialItem) {
        lootItems.push(specialItem);
      }
    }

    // Cloth (80% chance)
    if (chance(800)) {
      const clothCount = randomIntFromInterval(1, 3);
      const clothItem = server.generateItem(Items.CLOTH, clothCount);
      if (clothItem) {
        lootItems.push(clothItem);
      }
    }

    // Only spawn lootbag if there is loot
    if (lootItems.length === 0) return;

    const characterId = generateRandomGuid();
    const lootbag = new Lootbag(
      characterId,
      server.getTransientId(characterId),
      ModelIds.LOOT_BAG_CLEAN,
      new Float32Array([
        this.state.position[0] + 0.7,
        this.state.position[1],
        this.state.position[2] + 0.7
      ]),
      new Float32Array([0, 0, 0, 0]),
      server
    );
    const container = lootbag.getContainer();

    for (const item of lootItems) {
      server.addContainerItem(lootbag, item, container as LoadoutContainer);
    }

    server._lootbags[characterId] = lootbag;
  }

  OnFullCharacterDataRequest(server: ZoneServer2016, client: ZoneClient2016) {
    server.sendData(client, "LightweightToFullNpc", this.pGetFull(server));

    if (this.onReadyCallback && (!this.testFullDataOwner || this.testFullDataOwner === client)) {
      this.onReadyCallback(client);
      delete this.onReadyCallback;
    }
  }

  OnExplosiveHit(server: ZoneServer2016, sourceEntity: BaseEntity): void {
    let damage = this.health + this.health / 2;

    const distance = getDistance(
      sourceEntity.state.position,
      this.state.position
    );
    if (distance > 5) return;
    if (distance > 1) damage /= distance;
    this.damage(server, {
      entity: sourceEntity.characterId,
      damage: damage
    });
  }

  OnProjectileHit(server: ZoneServer2016, damageInfo: DamageInfo) {
    if (
      server.isHeadshotOnly &&
      damageInfo.hitReport?.hitLocation != "HEAD" &&
      this.isAlive
    )
      return;
    const client = server.getClientByCharId(damageInfo.entity);
    if (client && this.isAlive) {
      const hasHelmetBefore = this.hasHelmet(server);
      const hasArmorBefore = this.hasArmor(server);
      server.sendHitmarker(
        client,
        damageInfo.hitReport?.hitLocation,
        this.hasHelmet(server),
        this.hasArmor(server),
        hasHelmetBefore,
        hasArmorBefore
      );
    }
    switch (damageInfo.hitReport?.hitLocation) {
      case "HEAD":
      case "GLASSES":
      case "NECK":
        damageInfo.damage *= 4;
        break;
      default:
        break;
    }
    this.damage(server, damageInfo);
  }

  OnMeleeHit(server: ZoneServer2016, damageInfo: DamageInfo) {
    if (!this.isAlive) return; // prevent dead npc despawning from melee dmg
    damageInfo.damage = damageInfo.damage / 1.5;
    this.damage(server, damageInfo);
  }

  destroy(server: ZoneServer2016): boolean {
    return server.deleteEntity(this.characterId, server._npcs);
  }

  initNpcData() {
    switch (this.actorModelId) {
      case ModelIds.ZOMBIE_SCREAMER:
        this.nameId = StringIds.BANSHEE;
        this.npcId = NpcIds.ZOMBIE;
        this.profileId = 11;
        break;
      case ModelIds.ZOMBIE_FEMALE_WALKER:
      case ModelIds.ZOMBIE_MALE_WALKER:
        this.nameId = StringIds.ZOMBIE_WALKER;
        this.rewardItems = [
          {
            itemDefId: Items.BRAIN_INFECTED,
            weight: 10
          }
        ];
        this.npcId = NpcIds.ZOMBIE;
        this.profileId = 11;
        break;
      case ModelIds.DEER_BUCK:
      case ModelIds.DEER:
        this.nameId = StringIds.DEER;
        this.rewardItems = [
          {
            itemDefId: Items.MEAT_VENISON,
            weight: 30
          },
          {
            itemDefId: Items.ANIMAL_FAT,
            weight: 20
          },
          {
            itemDefId: Items.DEER_BLADDER,
            weight: 10
          }
        ];
        this.npcId = NpcIds.DEER;
        this.profileId = 22;
        break;
      case ModelIds.WOLF:
        this.nameId = StringIds.WOLF;
        this.rewardItems = [
          {
            itemDefId: Items.MEAT_WOLF,
            weight: 30
          },
          {
            itemDefId: Items.ANIMAL_FAT,
            weight: 20
          }
        ];
        this.npcId = NpcIds.WOLF;
        this.profileId = 23;
        break;
      case ModelIds.BEAR:
        this.nameId = StringIds.BEAR;
        this.rewardItems = [
          {
            itemDefId: Items.MEAT_BEAR,
            weight: 40
          },
          {
            itemDefId: Items.ANIMAL_FAT,
            weight: 20
          }
        ];
        this.npcId = NpcIds.BEAR;
        this.profileId = 24;
        break;
    }
    this.npcDefinitionId = this.npcId;
  }

  OnPlayerSelect(server: ZoneServer2016, client: ZoneClient2016) {
    // Only one at a time
    if (this.isSelected) {
      return;
    }
    this.isSelected = true;
    // Unlock selection after 5sec
    // It's easier to do it that way that to make a whole sys with the utilizeHudTimer
    setTimeout(() => {
      this.isSelected = false;
    }, 5_100);
    const skinningKnife = client.character.getItemById(Items.SKINNING_KNIFE);
    if (!this.isAlive && skinningKnife) {
      server.utilizeHudTimer(client, this.nameId, 5000, 0, () => {
        switch (this.actorModelId) {
          case ModelIds.ZOMBIE_FEMALE_WALKER:
          case ModelIds.ZOMBIE_MALE_WALKER:
          case ModelIds.ZOMBIE_SCREAMER:
            const emptySyringe = client.character.getItemById(
              Items.SYRINGE_EMPTY
            );
            if (emptySyringe) {
              client.character.lootContainerItem(
                server,
                server.generateItem(Items.SYRINGE_INFECTED_BLOOD)
              );
              server.removeInventoryItem(client.character, emptySyringe);
              return;
            }
            this.triggerAwards(server, client, this.rewardItems);
            break;
          case ModelIds.DEER_BUCK:
          case ModelIds.DEER:
            this.triggerAwards(server, client, this.rewardItems);
            break;
          case ModelIds.BEAR:
            this.triggerAwards(server, client, this.rewardItems);
            break;
          case ModelIds.WOLF:
            this.triggerAwards(server, client, this.rewardItems);
            break;
        }
        server.damageItem(client.character, skinningKnife, 200);
        server.deleteEntity(this.characterId, server._npcs);
      });
    }
  }

  triggerAwards(
    server: ZoneServer2016,
    client: ZoneClient2016,
    rewardItems: { itemDefId: number; weight: number }[]
  ) {
    const ranges = [];
    const preRewardedItems: number[] = [];
    let cumulativeWeight = 0;
    for (const reward of rewardItems) {
      const range = {
        start: cumulativeWeight,
        end: cumulativeWeight + reward.weight,
        item: reward
      };
      ranges.push(range);
      cumulativeWeight = range.end;
    }

    const totalWeight = rewardItems.reduce((sum, item) => sum + item.weight, 0);
    let count = 1;

    let selectedRange = ranges[0];
    for (let i = 0; i < rewardItems.length; i++) {
      const randomValue = Math.random() * totalWeight;
      for (const range of ranges) {
        if (randomValue >= range.start && randomValue < range.end) {
          selectedRange = range;
          break; // Break out of the loop once a range is chosen
        }
      }

      if (!preRewardedItems.includes(selectedRange.item.itemDefId)) {
        preRewardedItems.push(selectedRange.item.itemDefId);

        if (
          Math.random() <= 0.4 &&
          selectedRange.item.itemDefId != Items.BRAIN_INFECTED
        ) {
          // 40% chance to spawn double rewards
          count = 2;
        }

        const rewardItem = server.generateItem(
          selectedRange.item.itemDefId,
          count
        );
        if (rewardItem) client.character.lootContainerItem(server, rewardItem);
      }
    }
  }

  OnInteractionString(server: ZoneServer2016, client: ZoneClient2016) {
    if (!this.isAlive && client.character.hasItem(Items.SKINNING_KNIFE)) {
      switch (this.actorModelId) {
        case ModelIds.ZOMBIE_FEMALE_WALKER:
        case ModelIds.ZOMBIE_MALE_WALKER:
        case ModelIds.ZOMBIE_SCREAMER:
          if (client.character.hasItem(Items.SYRINGE_EMPTY)) {
            this.sendInteractionString(server, client, StringIds.EXTRACT_BLOOD);
            return;
          }
          this.sendInteractionString(server, client, StringIds.HARVEST);
          break;
        case ModelIds.DEER_BUCK:
        case ModelIds.DEER:
        case ModelIds.WOLF:
        case ModelIds.BEAR:
          this.sendInteractionString(server, client, StringIds.HARVEST);
          break;
      }
    }
  }

  sendInteractionString(
    server: ZoneServer2016,
    client: ZoneClient2016,
    stringId: number
  ) {
    server.sendData<CommandInteractionString>(
      client,
      "Command.InteractionString",
      {
        guid: this.characterId,
        stringId: stringId
      }
    );
  }
  /** False only inspects the anchor; default primes without inventing a first 100ms. */
  beginTestRouteMotion(primeMissing = true): TestRouteMotion | undefined {
    if (!this.testServerDrivenMovement || !this.testRouteStep) return;
    const sequenceTime = getCurrentServerTimeWrapper().getTruncatedU32();
    const previous = this.testRoutePacket;
    const position = routeWireXZ(this.state.position);
    if (!position.every(Number.isFinite)) return;
    const elapsedMs = previous ? (sequenceTime - previous.sequenceTime) >>> 0 : 0;
    if (!previous || !previous.ready || previous.movementVersion !== this.movementVersion ||
      previous.position[0] !== position[0] || previous.position[1] !== position[1] ||
      elapsedMs >= 0x80000000) {
      if (primeMissing) this.sendIdleStance(true);
      return;
    }
    if (elapsedMs === 0) return; // No second movement at the same wire timestamp.
    return { sequenceTime, elapsedMs, previousSequenceTime: previous.sequenceTime,
      previousPosition: [...previous.position] };
  }

  /** A rejected route must not leave elapsed idle time available for movement. */
  invalidateTestRouteMotion() {
    this.testRoutePacket = undefined;
  }

  /**
   * 服务端位置广播；测试追逐仍是实验性刺激。
   * horizontalSpeed 同时影响原生移动及动画参数，不证明步态匹配。
   */
  goTo(
    position: Float32Array,
    forceBroadcast = false,
    testRouteHorizontalSpeed?: number,
    testRouteMotion?: TestRouteMotion
  ) {
    this.state.position = position;
    if (this.suppressServerPositionBroadcast) return;
    const now = Date.now();
    const intervalMs =
      this.behaviorState === 1
        ? NPC_POSITION_BROADCAST_CHASE_MS
        : NPC_POSITION_BROADCAST_INTERVAL_MS;
    if (!forceBroadcast && now - this.lastPositionBroadcastTime < intervalMs) return;
    this.lastPositionBroadcastTime = now;
    try {
      const isChasing = this.behaviorState === 1;
      // Route callers can pair quantized XZ endpoints with the very same u32
      // timeline carried by this packet. This is an input-consistency experiment,
      // not proof of instantaneous native velocity or correct foot contact.
      const routeSpeed = this.testServerDrivenMovement && this.testRouteStep &&
        typeof testRouteHorizontalSpeed === "number" &&
        Number.isFinite(testRouteHorizontalSpeed) && testRouteHorizontalSpeed >= 0
        ? testRouteHorizontalSpeed : undefined;
      const speed = isChasing ? (routeSpeed ?? 2.5 * this.testChaseSpeedScale) : 0;
      if (testRouteMotion && (!this.testServerDrivenMovement || !this.testRouteStep ||
        this.testRoutePacket?.sequenceTime !== testRouteMotion.previousSequenceTime ||
        this.testRoutePacket.movementVersion !== this.movementVersion || !this.testRoutePacket.ready)) {
        this.testRoutePacket = undefined;
        return false;
      }
      const gameTime = testRouteMotion?.sequenceTime ?? getCurrentServerTimeWrapper().getTruncatedU32();
      const positionUpdate = createNpcPositionUpdate(
        this.state.position,
        gameTime,
        this.state.rotation,
        isChasing,
        speed
      );
      positionUpdate.unknown3_int8 = this.movementVersion;
      if (isChasing && this.testServerDrivenMovement === true &&
        this.server._testZombieChaseAttackCharacterId &&
        this.server._lastSpawnedNpcCharacterId === this.characterId &&
        this.server._npcs[this.characterId] === this &&
        (this.testPositionTraceCount ?? 0) < 64) {
        this.testPositionTraceCount = (this.testPositionTraceCount ?? 0) + 1;
        try {
          // Synchronous diagnostic output perturbs timing: compare traced/untraced
          // trials. Node monotonic time is not a native frame clock or delivery ACK.
          console.log(JSON.stringify({
            event: "test_npc_position", phase: "send_attempt",
            scope: "Npc.goTo only; excludes sendIdleStance and other packets",
            traceIndex: this.testPositionTraceCount,
            guid: this.characterId, transientId: this.transientId,
            utcMs: Date.now(), monotonicMs: performance.now(),
            sequenceTime: positionUpdate.sequenceTime,
            position: positionUpdate.position,
            horizontalSpeed: positionUpdate.horizontalSpeed,
            forceBroadcast, movementVersion: positionUpdate.unknown3_int8,
            ...(testRouteMotion ? { speedBasis: "quantized_xz_sequence_interval",
              elapsedMs: testRouteMotion.elapsedMs,
              previousSequenceTime: testRouteMotion.previousSequenceTime,
              previousWireXZ: testRouteMotion.previousPosition } : {})
          }));
        } catch { /* A failed diagnostic must not suppress the existing send. */ }
      }
      this.server.sendDataToAllWithSpawnedEntity(
        this.server._npcs,
        this.characterId,
        "PlayerUpdatePosition",
        {
          transientId: this.transientId,
          positionUpdate
        }
      );
      // The void sender can silently decline to queue. This records only a
      // no-throw attempt; never label it as sent, delivered, accepted, or ACKed.
      if (this.testServerDrivenMovement && this.testRouteStep) {
        this.testRoutePacket = testRouteMotion ? {
          sequenceTime: gameTime, position: routeWireXZ(this.state.position),
          movementVersion: this.movementVersion, ready: true
        } : undefined;
      }
      return true;
    } catch (e) {
      this.testRoutePacket = undefined;
      console.error("[npc.goTo] 发包异常，避免拖垮服务端:", e);
      return false;
    }
  }

  /** Send zero-speed/idle input; other native graph states may still take priority. */
  sendIdleStance(primeTestRoute = false) {
    const gameTime = getCurrentServerTimeWrapper().getTruncatedU32();
    const positionUpdate = createNpcPositionUpdate(
      this.state.position,
      gameTime,
      this.state.rotation,
      false,
      0
    );
    positionUpdate.unknown3_int8 = this.movementVersion;
    try {
      this.server.sendDataToAllWithSpawnedEntity(
        this.server._npcs,
        this.characterId,
        "PlayerUpdatePosition",
        {
          transientId: this.transientId,
          positionUpdate
        }
      );
      if (this.testServerDrivenMovement && this.testRouteStep) {
        this.testRoutePacket = { sequenceTime: gameTime,
          position: routeWireXZ(this.state.position), movementVersion: this.movementVersion,
          ready: primeTestRoute };
      }
    } catch (error) {
      this.testRoutePacket = undefined;
      throw error;
    }
  }

  /**
   * Drive the native character-state graph instead of naming a locomotion
   * animation. `states6.hidesHeat` is the recovered combat-mode selector:
   * moving+combat enters native chase state 7, while stopped+combat enters
   * combat idle state 6; non-combat movement remains the normal walk/run path.
   */
  sendLocomotionState(state: 0 | 1 | 2): boolean {
    if (this.lastLocomotionState === state) return true;
    const inCombat = state !== 0;
    const ok = this.server.sendNpcCharacterStateBroadcast(this.characterId, {
      states1: { visible: 1 },
      states2: { inCombat: inCombat ? 1 : 0 },
      states6: { hidesHeat: inCombat ? 1 : 0 }
    });
    if (ok) this.lastLocomotionState = state;
    return ok;
  }

  /** 服务端朝向更新：让 NPC 的 state.rotation 面向目标点（XZ 平面）。 */
  setFacingToward(targetPos: Float32Array, minHeadingChange = 0): boolean {
    const p = this.state.position;
    const dx = targetPos[0] - p[0];
    const dz = targetPos[2] - p[2];
    if (Math.abs(dx) < 1e-5 && Math.abs(dz) < 1e-5) return false;
    const yaw = Math.atan2(dx, dz);
    if (minHeadingChange > 0) {
      const rotation = this.state.rotation;
      if (!rotation || rotation.length < 4 || !Array.from(rotation).every(Number.isFinite) ||
        Math.hypot(...rotation) === 0 || !Number.isFinite(yaw)) return false;
      // Test-only deadband against the existing packet's quantized heading.
      // Keep rotation unchanged below it so small target changes accumulate.
      const lastHeading = quat2heading(rotation) / 255 * 2 * Math.PI;
      const delta = Math.atan2(Math.sin(yaw - lastHeading), Math.cos(yaw - lastHeading));
      if (Math.abs(delta) < minHeadingChange) return false;
    }
    this.state.rotation = eul2quat(new Float32Array([yaw, 0, 0]));
    return true;
  }

  /**
   * 客户端已证实：`Character.SeekTarget` 是追击核心，会安装/替换 seek controller；
   * `Character.SeekTargetUpdate` 只更新其目标 guid；`Character.ExpectedSpeed` 是独立辅助标量，不是追击核心。
   * 历史字段 `rotation` 实际是方向向量：FUN_140b5d1a0 对其 x/z 做 atan2，
   * 对 -y/水平长度做 atan2；不能发送 state.rotation 四元数。步行初始方向保持水平。
   */
  seekTarget(targetCharacterId: string, targetPosition: Float32Array) {
    if (this.lastSeekTargetId === targetCharacterId) return;
    const dx = targetPosition[0] - this.state.position[0];
    const dz = targetPosition[2] - this.state.position[2];
    const length = Math.hypot(dx, dz);
    if (!Number.isFinite(length) || length < 1e-5) return;
    const isProductionNativeSeek = this.clientDrivenSeek &&
      !this.testServerDrivenMovement &&
      this.server._lastSpawnedNpcCharacterId !== this.characterId;
    if (isProductionNativeSeek && !this.productionSeekTraceLogged) {
      this.productionSeekTraceLogged = true;
      console.log(`[npc-production-seek] ${JSON.stringify({
        id: this.characterId,
        modelId: this.actorModelId,
        profileId: this.profileId,
        target: targetCharacterId,
        from: Array.from(this.state.position),
        to: Array.from(targetPosition),
        clientDrivenSeek: true
      })}`);
    }
    this.lastSeekTargetId = targetCharacterId;
    const speedScale = this.testChaseSpeedScale;
    const desiredSpeed = 2.5 * speedScale;
    if (this.server._lastSpawnedNpcCharacterId === this.characterId) {
      console.log(`[test-zombie] SeekTarget: time=${Date.now()}, id=${this.characterId}, target=${targetCharacterId}, from=${Array.from(this.state.position)}, to=${Array.from(targetPosition)}, direction=${dx / length},0,${dz / length},0, speed=${desiredSpeed}`);
    }
    this.server.sendDataToAllWithSpawnedEntity(
      this.server._npcs,
      this.characterId,
      "Character.ExpectedSpeed",
      { characterId: this.characterId, speed: desiredSpeed }
    );
    this.server.sendDataToAllWithSpawnedEntity(
      this.server._npcs,
      this.characterId,
      "Character.SeekTarget",
      {
        characterId: this.characterId,
        TargetCharacterId: targetCharacterId,
        initSpeed: 0,
        acceleration: Math.max(2, desiredSpeed * 3),
        speed: desiredSpeed,
        unknown8: 6,
        yRot: 0,
        rotation: new Float32Array([dx / length, 0, dz / length, 0])
      }
    );
  }

  /** 清除客户端 seek controller；进入攻击距离或失去目标时必须先调用。 */
  clearMovementController(force = false) {
    if (this.lastSeekTargetId === null && !force) return;
    if (this.server._lastSpawnedNpcCharacterId === this.characterId) {
      console.log(`[test-zombie] ClearMovementRail: time=${Date.now()}, id=${this.characterId}, position=${Array.from(this.state.position)}`);
    }
    this.lastSeekTargetId = null;
    this.lastSeekTargetUpdateTime = 0;
    this.server.sendDataToAllWithSpawnedEntity(
      this.server._npcs,
      this.characterId,
      "Character.ClearMovementRail",
      { characterId: this.characterId }
    );
  }

  /** `Character.AggroLevel` 在客户端动画图中写入 `Interest_Level` float。 */
  sendAggroLevel(level: number) {
    if (this.lastAggroLevel === level) return;
    this.lastAggroLevel = level;
    this.server.sendDataToAllWithSpawnedEntity(
      this.server._npcs,
      this.characterId,
      "Character.AggroLevel",
      { characterId: this.characterId, unknownDword1: level }
    );
  }

  /**
   * 2016 客户端实测：KnifeSlash 解析为消息 6，经节点 105 (Attack_Grapple)
   * 进入 AttackStand_Ping；已观察到挥臂动作。UCS bit 5 是运动清理路径，
   * 不能作为攻击触发器。1430 是本次实测包值，不代表已测定命中时刻。
   */
  triggerMeleeAttack() {
    this.server.sendDataToAllWithSpawnedEntity(
      this.server._npcs,
      this.characterId,
      "Character.PlayAnimation",
      {
        characterId: this.characterId,
        animationName: "KnifeSlash",
        unm4: 0,
        unknownDword1: 0,
        unknownByte1: 0,
        unknownDword2: 1430,
        animationType: "",
        unknownByte1xda: 0,
        unknownDword3: 0
      }
    );
  }

  /** 只发 `Character.SeekTargetUpdate`（当前已知客户端实际只消费目标 guid 更新）；由 aimanager 按 400ms 节流调用。 */
  seekTargetUpdate(targetCharacterId: string) {
    this.server.sendDataToAllWithSpawnedEntity(
      this.server._npcs,
      this.characterId,
      "Character.SeekTargetUpdate",
      {
        characterId: this.characterId,
        TargetCharacterId: targetCharacterId
      }
    );
  }

  /** `MemberStatus` 是单一布尔成员标记，并不是 idle/chase/attack 行为枚举。 */
  sendMemberStatus(state: 0 | 1 | 2) {
    this.server.sendDataToAllWithSpawnedEntity(
      this.server._npcs,
      this.characterId,
      "Character.MemberStatus",
      { characterId: this.characterId, unknownByte1: state ? 1 : 0 }
    );
  }

  /** 通知客户端该 NPC 由 managerCharacterId 管理（车辆式 managed-control 路径）。
   *  参照 assignManagedObject（车辆管理，已验证可用）：
   *  必须同时发 Character.ManagedObject + ClientUpdate.ManagedObjectResponseControl(control=true)，
   *  且必须发给特定管理者客户端，不能广播。
   *  但客户端 proxied-character 分发里 `Character.ManagedObject` 当前已证实会落到 no-op 退出路径，
   *  因此它不应再被视为普通僵尸追击/攻击动画的核心条件。 */
  sendManagedObject(managerCharacterId: string) {
    const client = this.server.getClientByCharId(managerCharacterId);
    if (!client) return;
    this.server.sendData(client, "Character.ManagedObject" as never, {
      objectCharacterId: this.characterId,
      characterId: managerCharacterId
    } as never);
    this.server.sendData(
      client,
      "ClientUpdate.ManagedObjectResponseControl" as never,
      {
        control: true,
        objectCharacterId: this.characterId
      } as never
    );
    if (!client.managedObjects.includes(this.characterId)) {
      client.managedObjects.push(this.characterId);
    }
  }
}
