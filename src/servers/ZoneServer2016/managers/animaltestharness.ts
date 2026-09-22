import type { ZoneClient2016 } from "../classes/zoneclient";
import type { ZoneServer2016 } from "../zoneserver";
import type { Npc } from "../entities/npc";
import { Items, ModelIds, NpcIds } from "../models/enums";
import { NavManager } from "../../../utils/recast";

export type AnimalTestType =
  | "zombie"
  | "zombie_female"
  | "screamer"
  | "gasser"
  | "exploder"
  | "prototype_assault"
  | "prototype_hunter"
  | "prototype_sniper"
  | "deer"
  | "deer_buck"
  | "rabbit"
  | "wolf"
  | "bear"
  | "basic";

type AnimalRecipe = { modelId: number; npcId?: NpcIds };

type AnimalTestSpawnMeta = {
  requestedPosition: number[];
  actualPosition: number[];
  navPosition: number[] | null;
  navSnapDistance2d: number | null;
  navSnapDistance3d: number | null;
  navigationHeightOffset: number | null;
  projectedToNav: boolean;
};

export type AnimalTestSpawnResult = {
  characterId: string;
  type: AnimalTestType;
  position: number[];
  requestedPosition: number[];
  navPosition: number[] | null;
  navSnapDistance2d: number | null;
  navSnapDistance3d: number | null;
  navigationHeightOffset: number | null;
  projectedToNav: boolean;
};

export type AnimalHuntKitResult = {
  bowItemDefinitionId: Items;
  arrowsGranted: number;
  arrowsTotal: number;
  skinningKnifeGranted: boolean;
  activeLoadoutSlot: number;
};

export type AnimalHuntResult = {
  command: "hunt";
  rabbits: AnimalTestSpawnResult[];
  deer: AnimalTestSpawnResult[];
  kit: AnimalHuntKitResult;
};

const RECIPES: Record<AnimalTestType, AnimalRecipe> = {
  zombie: { modelId: ModelIds.ZOMBIE_MALE_WALKER },
  zombie_female: { modelId: ModelIds.ZOMBIE_FEMALE_WALKER },
  screamer: { modelId: ModelIds.ZOMBIE_SCREAMER },
  gasser: { modelId: ModelIds.ZOMBIE_MALE_WALKER, npcId: NpcIds.GASSER },
  exploder: { modelId: ModelIds.ZOMBIE_MALE_WALKER, npcId: NpcIds.EXPLODER },
  prototype_assault: {
    modelId: ModelIds.ZOMBIE_MALE_WALKER,
    npcId: NpcIds.PROTOTYPE_ASSAULT_ZOMBIE
  },
  prototype_hunter: {
    modelId: ModelIds.ZOMBIE_MALE_WALKER,
    npcId: NpcIds.PROTOTYPE_HUNTER_ZOMBIE
  },
  prototype_sniper: {
    modelId: ModelIds.ZOMBIE_MALE_WALKER,
    npcId: NpcIds.PROTOTYPE_SNIPER_ZOMBIE
  },
  deer: { modelId: ModelIds.DEER },
  deer_buck: { modelId: ModelIds.DEER_BUCK },
  rabbit: { modelId: ModelIds.RABBIT },
  wolf: { modelId: ModelIds.WOLF },
  bear: { modelId: ModelIds.BEAR },
  // BasicNpc is intentionally inert, but it still exercises the common NPC
  // spawn/idle animation contract used by unknown actor models.
  basic: { modelId: ModelIds.RAVEN }
};

/**
 * Small current-branch test harness.
 *
 * The old `/ztest` implementation depended on the removed AiManager and on
 * fields that belonged to the pre-upstream NPC implementation.  This harness
 * deliberately uses the production WorldObjectManager and the current NPC
 * FSM tick, so a test spawn exercises the same path as a world NPC.
 */
export class AnimalTestHarness {
  private testNpcIds = new Set<string>();
  private testNpcMeta = new Map<string, AnimalTestSpawnMeta>();
  private lastNpcId: string | null = null;

  constructor(private readonly server: ZoneServer2016) {}

  private assertReadyClient(client: ZoneClient2016): void {
    if (
      !this.server._soloMode ||
      Object.values(this.server._clients).length !== 1
    ) {
      throw new Error("Animal test requires one local solo client");
    }
    if (this.server._clients[client.sessionId] !== client) {
      throw new Error("Animal test client is no longer connected");
    }
    if (!client.character?.isAlive || client.character.isRespawning) {
      throw new Error("Enter the world alive before spawning an animal test");
    }
  }

  spawn(
    client: ZoneClient2016,
    type: AnimalTestType = "zombie",
    distance = 8,
    height = 0,
    projectToNav = false
  ): {
    characterId: string;
    type: AnimalTestType;
    position: number[];
    requestedPosition: number[];
    navPosition: number[] | null;
    navSnapDistance2d: number | null;
    navSnapDistance3d: number | null;
    navigationHeightOffset: number | null;
    projectedToNav: boolean;
  } {
    if (
      !this.server._soloMode ||
      Object.values(this.server._clients).length !== 1
    ) {
      throw new Error("Animal test requires one local solo client");
    }
    if (this.server._clients[client.sessionId] !== client) {
      throw new Error("Animal test client is no longer connected");
    }
    if (!client.character?.isAlive || client.character.isRespawning) {
      throw new Error("Enter the world alive before spawning an animal test");
    }

    const recipe = RECIPES[type];
    if (!recipe) throw new Error(`Unknown animal test type: ${type}`);
    if (!Number.isFinite(distance) || distance < 4 || distance > 30) {
      throw new Error("Animal test distance must be between 4 and 30 meters");
    }
    if (!Number.isFinite(height) || height < -5 || height > 10) {
      throw new Error("Animal test height must be between -5 and 10 meters");
    }

    // Keep the currently visible test NPC until the replacement has been
    // constructed and replicated successfully.  Eagerly calling `stop()`
    // here made a transient create/replication error look like an AI despawn:
    // repeated `/ztest` calls could leave the client with no test animal at
    // all.  Replacement is committed only after the new NPC is ready.
    const previousNpcIds = [...this.testNpcIds];

    const player = client.character;
    const yaw = Number.isFinite(player.state.yaw) ? player.state.yaw : 0;
    const directionX = Math.sin(yaw);
    const directionZ = Math.cos(yaw);
    const requestedPosition = new Float32Array([
      player.state.position[0] + directionX * distance,
      player.state.position[1] + height,
      player.state.position[2] + directionZ * distance,
      1
    ]);
    const nearestNavPoint = this.server.navManager?.navMeshQuery
      ? this.server.navManager.getClosestNavPointVec3(requestedPosition)
      : null;
    const navPosition = nearestNavPoint
      ? NavManager.navToGame(nearestNavPoint)
      : null;
    const navSnapDistance2d = navPosition
      ? Math.hypot(
          navPosition[0] - requestedPosition[0],
          navPosition[2] - requestedPosition[2]
        )
      : null;
    const navSnapDistance3d = navPosition
      ? Math.hypot(
          navPosition[0] - requestedPosition[0],
          navPosition[1] - requestedPosition[1],
          navPosition[2] - requestedPosition[2]
        )
      : null;
    // Flat tests are intended to validate the production FSM, not the
    // first-frame jump from an arbitrary point onto Recast's navmesh.  Keep
    // slope tests raw so their explicit height offset remains observable;
    // flat tests start on the nearest valid nav point and report the exact
    // projection so a bad test location cannot be mistaken for an AI bug.
    const position =
      projectToNav && navPosition
        ? new Float32Array([navPosition[0], navPosition[1], navPosition[2], 1])
        : requestedPosition;
    const rotation = player.state.lookAt.slice() as Float32Array;
    const npc = this.server.worldObjectManager.createNpc(
      this.server,
      recipe.modelId,
      position,
      rotation,
      0,
      recipe.npcId
    );

    if (!projectToNav) {
      // The production Npc constructor canonicalizes a spawn to the nearest
      // nav polygon so ambient/flat spawns cannot emit a first-frame
      // correction.  The slope harness is deliberately different: its
      // explicit height offset is a test input for 3-D reachability and must
      // remain visible in the replicated state.  Keep the crowd agent on the
      // valid nav point, but restore the requested network origin so the
      // capture can observe the height delta instead of silently flattening
      // the scenario at construction time.
      npc.state.position = requestedPosition;
      if (navPosition) {
        // Keep the crowd agent on the ground nav surface but preserve the
        // requested vertical separation in every later PlayerUpdatePosition
        // sample.  Without this offset, the next zone pathfinding tick would
        // immediately overwrite the raw slope/vehicle test height.
        npc.testHarnessVerticalOffset =
          requestedPosition[1] - navPosition[1];
      }
    } else {
      npc.testHarnessVerticalOffset = undefined;
    }

    // The production createAgent helper samples a random point on the nearby
    // polygon.  That is appropriate for ambient spawns, but a deterministic
    // local test must not begin 10+ metres away from the requested point.
    // Teleport the crowd agent to the exact projected point before
    // replication, then keep the authoritative game state on that same
    // point so the first pathfinding tick cannot produce a false jump.
    if (projectToNav && npc.navAgent && navPosition) {
      npc.navAgent.teleport({
        x: navPosition[0],
        y: navPosition[1],
        z: navPosition[2]
      });
      npc.state.position = new Float32Array([
        navPosition[0],
        navPosition[1],
        navPosition[2],
        1
      ]);
    }

    const actualPosition = Array.from(npc.state.position);
    const meta: AnimalTestSpawnMeta = {
      requestedPosition: Array.from(requestedPosition),
      actualPosition,
      navPosition: navPosition ? Array.from(navPosition) : null,
      navSnapDistance2d,
      navSnapDistance3d,
      navigationHeightOffset: navPosition
        ? requestedPosition[1] - navPosition[1]
        : null,
      projectedToNav: projectToNav
    };
    try {
      // Bypass the next world-cell scan for the local test client.  This is
      // still the production AddLightweightNpc/replication path.
      this.server.spawnEntityForClient(client, npc);
    } catch (error) {
      // Do not leave a half-replicated replacement in the world.  The old
      // test NPC is intentionally retained so the caller can retry safely.
      if (this.server._npcs[npc.characterId]) {
        this.server.deleteEntity(npc.characterId, this.server._npcs);
      }
      throw error;
    }

    // Commit the replacement only after construction and replication have
    // both succeeded.  Remove old test entities after the new one is visible
    // so a client never observes an empty `/ztest` slot during a normal
    // replacement.
    this.removeNpcIds(previousNpcIds);
    this.testNpcIds.clear();
    this.testNpcIds.add(npc.characterId);
    this.lastNpcId = npc.characterId;
    this.testNpcMeta.set(npc.characterId, meta);

    return {
      characterId: npc.characterId,
      type,
      position: actualPosition,
      requestedPosition: meta.requestedPosition,
      navPosition: meta.navPosition,
      navSnapDistance2d: meta.navSnapDistance2d,
      navSnapDistance3d: meta.navSnapDistance3d,
      navigationHeightOffset: meta.navigationHeightOffset,
      projectedToNav: meta.projectedToNav
    };
  }

  stop(): number {
    const removed = this.removeNpcIds(this.testNpcIds);
    this.testNpcIds.clear();
    this.lastNpcId = null;
    return removed;
  }

  /**
   * Add the deterministic hunting equipment used by `/ztest hunt`.
   *
   * This deliberately goes through the normal inventory/loadout methods so
   * the test exercises the same active weapon and ammo replication path as a
   * real player.  It is not a second weapon implementation hidden in the
   * developer command.
   */
  prepareHuntKit(
    client: ZoneClient2016,
    arrowCount = 100
  ): AnimalHuntKitResult {
    this.assertReadyClient(client);
    if (!Number.isInteger(arrowCount) || arrowCount < 1 || arrowCount > 9999) {
      throw new Error("Hunt arrow count must be an integer between 1 and 9999");
    }

    const character = client.character;
    let bow = character.getLoadoutItemById(Items.WEAPON_BOW_WOOD);
    if (!bow) {
      const generatedBow = this.server.generateItem(
        Items.WEAPON_BOW_WOOD,
        1,
        true
      );
      if (!generatedBow) {
        throw new Error("Wooden bow item definition is unavailable");
      }
      character.lootItem(this.server, generatedBow, 1, true);
      bow = character.getLoadoutItemById(Items.WEAPON_BOW_WOOD);
    }
    if (!bow) throw new Error("Could not equip the wooden bow");
    if (character.currentLoadoutSlot !== bow.slotId) {
      this.server.switchLoadoutSlot(client, bow);
    }

    const arrowsBefore = character.getInventoryItemAmount(Items.AMMO_ARROW);
    const generatedArrows = this.server.generateItem(
      Items.AMMO_ARROW,
      arrowCount,
      true
    );
    if (!generatedArrows) {
      throw new Error("Wooden arrow item definition is unavailable");
    }
    character.lootItem(this.server, generatedArrows, arrowCount, true);
    const arrowsTotal = character.getInventoryItemAmount(Items.AMMO_ARROW);
    const arrowsGranted = Math.max(0, arrowsTotal - arrowsBefore);
    if (arrowsGranted < arrowCount) {
      throw new Error(
        `Could not add all hunting arrows (${arrowsGranted}/${arrowCount})`
      );
    }

    // A knife is helpful for the post-shot harvest check, but is optional so
    // an old data set without item 110 does not prevent the animal scene.
    const generatedKnife = this.server.generateItem(
      Items.SKINNING_KNIFE,
      1,
      true
    );
    let skinningKnifeGranted = false;
    if (generatedKnife) {
      character.lootItem(this.server, generatedKnife, 1, true);
      skinningKnifeGranted = !!character.getItemById(Items.SKINNING_KNIFE);
    }

    return {
      bowItemDefinitionId: Items.WEAPON_BOW_WOOD,
      arrowsGranted,
      arrowsTotal,
      skinningKnifeGranted,
      activeLoadoutSlot: character.currentLoadoutSlot
    };
  }

  private createHuntNpc(
    client: ZoneClient2016,
    type: "rabbit" | "deer",
    requestedPosition: Float32Array
  ): AnimalTestSpawnResult {
    const recipe = RECIPES[type];
    const nearestNavPoint = this.server.navManager?.navMeshQuery
      ? this.server.navManager.getClosestNavPointVec3(requestedPosition)
      : null;
    const navPosition = nearestNavPoint
      ? NavManager.navToGame(nearestNavPoint)
      : null;
    const position = navPosition
      ? new Float32Array([navPosition[0], navPosition[1], navPosition[2], 1])
      : requestedPosition;
    const rotation = client.character.state.lookAt.slice() as Float32Array;
    const npc = this.server.worldObjectManager.createNpc(
      this.server,
      recipe.modelId,
      position,
      rotation,
      0,
      recipe.npcId
    );

    if (npc.navAgent && navPosition) {
      npc.navAgent.teleport({
        x: navPosition[0],
        y: navPosition[1],
        z: navPosition[2]
      });
      npc.state.position = new Float32Array([
        navPosition[0],
        navPosition[1],
        navPosition[2],
        1
      ]);
    }

    try {
      this.server.spawnEntityForClient(client, npc);
    } catch (error) {
      if (this.server._npcs[npc.characterId]) {
        this.server.deleteEntity(npc.characterId, this.server._npcs);
      }
      throw error;
    }

    const actualPosition = Array.from(npc.state.position);
    const meta: AnimalTestSpawnMeta = {
      requestedPosition: Array.from(requestedPosition),
      actualPosition,
      navPosition: navPosition ? Array.from(navPosition) : null,
      navSnapDistance2d: navPosition
        ? Math.hypot(
            navPosition[0] - requestedPosition[0],
            navPosition[2] - requestedPosition[2]
          )
        : null,
      navSnapDistance3d: navPosition
        ? Math.hypot(
            navPosition[0] - requestedPosition[0],
            navPosition[1] - requestedPosition[1],
            navPosition[2] - requestedPosition[2]
          )
        : null,
      navigationHeightOffset: navPosition
        ? requestedPosition[1] - navPosition[1]
        : null,
      projectedToNav: true
    };
    this.testNpcIds.add(npc.characterId);
    this.testNpcMeta.set(npc.characterId, meta);
    this.lastNpcId = npc.characterId;

    return {
      characterId: npc.characterId,
      type,
      position: actualPosition,
      requestedPosition: meta.requestedPosition,
      navPosition: meta.navPosition,
      navSnapDistance2d: meta.navSnapDistance2d,
      navSnapDistance3d: meta.navSnapDistance3d,
      navigationHeightOffset: meta.navigationHeightOffset,
      projectedToNav: true
    };
  }

  /**
   * Spawn a repeatable, ground-projected hunting range in front of the player.
   * Rabbits/deer remain outside their passive threat radius until the player
   * approaches or shoots, which keeps the initial bow draw observable.
   */
  spawnHunt(
    client: ZoneClient2016,
    rabbitCount = 3,
    deerCount = 3,
    arrowCount = 100
  ): AnimalHuntResult {
    this.assertReadyClient(client);
    if (
      !Number.isInteger(rabbitCount) ||
      rabbitCount < 0 ||
      rabbitCount > 8 ||
      !Number.isInteger(deerCount) ||
      deerCount < 0 ||
      deerCount > 8 ||
      rabbitCount + deerCount < 1 ||
      rabbitCount + deerCount > 12
    ) {
      throw new Error("Hunt counts must total 1-12 animals (each type 0-8)");
    }

    const kit = this.prepareHuntKit(client, arrowCount);
    const previousNpcIds = [...this.testNpcIds];
    const createdNpcIds: string[] = [];
    const rabbits: AnimalTestSpawnResult[] = [];
    const deer: AnimalTestSpawnResult[] = [];
    const player = client.character;
    const yaw = Number.isFinite(player.state.yaw) ? player.state.yaw : 0;
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    const positionAt = (distance: number, lateral: number): Float32Array =>
      new Float32Array([
        player.state.position[0] + forwardX * distance + rightX * lateral,
        player.state.position[1],
        player.state.position[2] + forwardZ * distance + rightZ * lateral,
        1
      ]);

    try {
      const rabbitLaterals = [-5, 0, 5, -8, 8, -2, 2, 0];
      for (let i = 0; i < rabbitCount; i++) {
        const result = this.createHuntNpc(
          client,
          "rabbit",
          positionAt(22, rabbitLaterals[i])
        );
        rabbits.push(result);
        createdNpcIds.push(result.characterId);
      }
      const deerLaterals = [-7, 0, 7, -10, 10, -3, 3, 0];
      for (let i = 0; i < deerCount; i++) {
        const result = this.createHuntNpc(
          client,
          "deer",
          positionAt(28, deerLaterals[i])
        );
        deer.push(result);
        createdNpcIds.push(result.characterId);
      }
    } catch (error) {
      this.removeNpcIds(createdNpcIds);
      this.lastNpcId = previousNpcIds[previousNpcIds.length - 1] ?? null;
      throw error;
    }

    this.removeNpcIds(previousNpcIds);
    return { command: "hunt", rabbits, deer, kit };
  }

  private removeNpcIds(characterIds: Iterable<string>): number {
    let removed = 0;
    for (const characterId of characterIds) {
      if (this.server._npcs[characterId]) {
        if (this.server.deleteEntity(characterId, this.server._npcs)) removed++;
      }
      this.testNpcMeta.delete(characterId);
      this.testNpcIds.delete(characterId);
    }
    return removed;
  }

  status(): object {
    const animals = [...this.testNpcIds].flatMap((characterId) => {
      const npc = this.server._npcs[characterId];
      if (!npc) return [];
      const runtime = npc as unknown as Record<string, unknown>;
      // Target/timer state belongs to the JSM instance, while locomotion
      // state belongs to the NPC entity.  Keep both views in diagnostics so
      // a stuck nav approach can be distinguished from a target/state bug.
      const fsmRuntime = npc.fsm as unknown as
        Record<string, unknown> | undefined;
      const targetCharacterId =
        typeof fsmRuntime?.targetCharacterId === "string"
          ? fsmRuntime.targetCharacterId
          : null;
      const target = targetCharacterId
        ? (this.server._characters[targetCharacterId] ??
          this.server._npcs[targetCharacterId])
        : undefined;
      const targetClient =
        targetCharacterId &&
        typeof this.server.getClientByCharId === "function"
          ? this.server.getClientByCharId(targetCharacterId)
          : undefined;
      const targetMountedVehicleId =
        targetClient?.vehicle?.mountedVehicle ?? null;
      const targetMountedVehicle = targetMountedVehicleId
        ? this.server._vehicles?.[targetMountedVehicleId]
        : undefined;
      const targetMountedSeatId =
        targetMountedVehicle && targetCharacterId
          ? (targetMountedVehicle.getCharacterSeat?.(targetCharacterId) ?? null)
          : null;
      const targetPositionSource = targetMountedVehicleId
        ? (target as { lastMountedPositionSource?: string } | undefined)
            ?.lastMountedPositionSource ?? "unknown"
        : target
          ? "character-state"
          : null;
      const pos = npc.state.position;
      const targetPosition = target?.state?.position
        ? Array.from(target.state.position)
        : null;
      const targetNavPoint =
        target?.state?.position && this.server.navManager?.navMeshQuery
          ? this.server.navManager.getClosestNavPointVec3(target.state.position)
          : null;
      const targetNavPosition = targetNavPoint
        ? [targetNavPoint.x, targetNavPoint.y, targetNavPoint.z]
        : null;
      const targetDistance2d = target?.state?.position
        ? Math.hypot(
            target.state.position[0] - pos[0],
            target.state.position[2] - pos[2]
          )
        : null;
      // Keep the vertical component visible as well.  The horizontal value
      // drives target acquisition and the server-side native-animal
      // engagement projection; the client AnimalsPhysics graph still owns the
      // final 3-D shape/contact query.  A slope or mounted-player capture must
      // be able to distinguish those two decisions without inferring the
      // result from a video frame.
      const targetDistance3d = target?.state?.position
        ? Math.hypot(
            target.state.position[0] - pos[0],
            target.state.position[1] - pos[1],
            target.state.position[2] - pos[2]
          )
        : null;
      const targetHeightDelta = target?.state?.position
        ? target.state.position[1] - pos[1]
        : null;
      const targetNavDistance2d = targetNavPoint
        ? Math.hypot(targetNavPoint.x - pos[0], targetNavPoint.z - pos[2])
        : null;
      const cellSize = 50;
      const cx = Math.floor(pos[0] / cellSize);
      const cz = Math.floor(pos[2] / cellSize);
      const aiTargets: Array<Record<string, unknown>> = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = this.server.aiTargetSpatialMap.get(
            `${cx + dx},${cz + dz}`
          );
          if (!bucket) continue;
          for (const entry of bucket) {
            aiTargets.push({
              id: entry.id,
              faction: entry.faction,
              position: Array.from(entry.position),
              distance2d: Math.hypot(
                entry.position[0] - pos[0],
                entry.position[2] - pos[2]
              )
            });
          }
        }
      }
      // Diagnostics must not become a second failure source.  During early
      // server startup (and in lightweight test doubles) the weapon tables
      // may not be loaded yet; the production attack path already fails
      // closed in that case, while `/ztest status` should still return the
      // animal's locomotion/FSM state.
      let meleeProfile: ReturnType<Npc["getMeleeAttackProfile"]> | null = null;
      try {
        meleeProfile = npc.getMeleeAttackProfile?.() ?? null;
      } catch {
        meleeProfile = null;
      }
      const meleeProfileSource =
        npc.getMeleeAttackProfileSource?.() ??
        (meleeProfile ? "compatibility-proxy" : "unavailable");
      const meleeEnvelopeSource =
        npc.getMeleeAttackEnvelopeSource?.() ??
        (meleeProfile ? meleeProfileSource : "unavailable");
      const nativeMeleeCapability =
        npc.nativeMeleeCapability === "attacker" ||
        npc.nativeMeleeCapability === "passive" ||
        npc.nativeMeleeCapability === "none"
          ? npc.nativeMeleeCapability
          : null;
      const animationVerification = npc.getAnimationVerification?.(
        typeof runtime.lastAnimationEvent === "string"
          ? runtime.lastAnimationEvent
          : null
      ) ?? {
        eventName: null,
        clockVerified: false,
        contactEventVerified: false,
        rootMotionVerified: false
      };
      const animationRuntime = npc.getAnimationRuntimeState?.() ?? {
        persistentAnimation:
          typeof runtime.currentAnimation === "string" &&
          runtime.currentAnimation.length > 0
            ? runtime.currentAnimation
            : null,
        activeAnimation: null,
        activeAnimationRemainingMs: null,
        lastAnimationEvent:
          typeof runtime.lastAnimationEvent === "string"
            ? runtime.lastAnimationEvent
            : null
      };
      const nativeContactContract = npc.getNativeContactContract?.() ?? {
        signal: null,
        clientAuthority: "unavailable",
        serverDamageAuthority: "unavailable",
        geometrySource: "unavailable",
        liveVerified: false
      };
      const meleeAnimationDurationSeconds =
        npc.getMeleeAttackAnimationDuration?.(0) ?? null;
      const meleeAnimationDurationMs =
        meleeAnimationDurationSeconds !== null &&
        Number.isFinite(meleeAnimationDurationSeconds) &&
        meleeAnimationDurationSeconds > 0
          ? Math.round(meleeAnimationDurationSeconds * 1000)
          : null;
      const meleeAnimationDurationSource =
        meleeAnimationDurationMs === null
          ? "unavailable"
          : typeof runtime.nativeMeleeAnimationSource === "string"
            ? `native-asset:${runtime.nativeMeleeAnimationSource}`
          : meleeProfileSource === "compatibility-proxy"
            ? "Character.PlayAnimation.unknownDword2"
            : "server-weapon-table";
      const meleeContactWindow = npc.getMeleeContactWindow?.() ?? null;
      const meleeDamageTiming =
        npc.npcMeleeDamage <= 0
          ? "non-melee"
          : meleeContactWindow
            ? "normalized-contact-window-projection"
            : meleeAnimationDurationMs === null
              ? "unavailable"
              : "animation-end-compatibility";
      const stateTimer =
        typeof fsmRuntime?.stateTimer === "number" &&
        Number.isFinite(fsmRuntime.stateTimer)
          ? fsmRuntime.stateTimer
          : null;
      const attackDurationForPhase =
        meleeAnimationDurationSeconds !== null &&
        Number.isFinite(meleeAnimationDurationSeconds) &&
        meleeAnimationDurationSeconds > 0
          ? meleeAnimationDurationSeconds
          : null;
      const isAttackingState =
        typeof npc.fsm?.state === "string" &&
        npc.fsm.state.toLowerCase() === "attacking";
      const normalizedAttackPhase =
        isAttackingState &&
        stateTimer !== null &&
        attackDurationForPhase !== null
          ? Math.max(0, Math.min(1, stateTimer / attackDurationForPhase))
          : null;
      const contactWindowActive =
        normalizedAttackPhase !== null && meleeContactWindow
          ? normalizedAttackPhase >= meleeContactWindow.startFraction &&
            normalizedAttackPhase <= meleeContactWindow.endFraction
          : null;
      const attackDamageApplied =
        typeof fsmRuntime?.attackDamageApplied === "boolean"
          ? fsmRuntime.attackDamageApplied
          : null;
      const attackEnvelopeWasActive =
        typeof fsmRuntime?.attackEnvelopeWasActive === "boolean"
          ? fsmRuntime.attackEnvelopeWasActive
          : null;
      const velocity = npc.navAgent?.velocity();
      const attackForward = Array.isArray(fsmRuntime?.attackForward)
        ? fsmRuntime.attackForward.length === 2
          ? [
              Number(fsmRuntime.attackForward[0]),
              Number(fsmRuntime.attackForward[1])
            ] as [number, number]
          : null
        : null;
      const nativeMeleeEngagementRange =
        Number.isFinite(npc.nativeMeleeEngagementRange) &&
        (npc.nativeMeleeEngagementRange as number) > 0
          ? (npc.nativeMeleeEngagementRange as number)
          : null;
      let meleeInEnvelope: boolean | null = null;
      if (
        target?.state?.position &&
        npc.isMeleeTargetInEnvelope &&
        meleeEnvelopeSource !== "not-applicable" &&
        (meleeEnvelopeSource !== "animal-engagement-projection" ||
          nativeMeleeEngagementRange !== null)
      ) {
        try {
          meleeInEnvelope = npc.isMeleeTargetInEnvelope(
            target.state.position,
            npc.state.position,
            attackForward ?? undefined,
            nativeMeleeEngagementRange ?? undefined
          );
        } catch {
          meleeInEnvelope = null;
        }
      }
      return [
        {
          characterId,
          npcId: npc.npcId,
          actorModelId: npc.actorModelId,
          profileId: npc.profileId,
          position: Array.from(pos),
          spawn: this.testNpcMeta.get(characterId) ?? null,
          faction: npc.faction,
          state: npc.fsm?.state ?? null,
          // Keep the requested controller speed and the measured wire speed
          // separate. The former is a state target; the latter is what the
          // client receives in PlayerUpdatePosition.  A server-position NPC
          // deliberately has no positive Character.ExpectedSpeed rail, so
          // expose that channel independently instead of implying that the
          // target was also sent to the client.
          expectedSpeed: npc.locomotionTargetSpeed ?? null,
          advertisedLocomotionSpeed:
            typeof npc.advertisedLocomotionSpeed === "number"
              ? npc.advertisedLocomotionSpeed
              : null,
          nativeLocomotionProfile:
            npc.getNativeLocomotionProfile?.() ??
            npc.nativeLocomotionProfile ??
            null,
          movementAuthority:
            npc.movementAuthority === "native-root-motion"
              ? "native-root-motion"
              : "server-position",
          locomotionMode: npc.locomotionIntent,
          combatAnimationMode: npc.isCombatAnimationMode,
          wireMotion: npc.lastWireMotion ?? null,
          nativeGaitReady:
            typeof npc.nativeGaitReady === "boolean"
              ? npc.nativeGaitReady
              : null,
          authoritativeMovingSampleCount:
            Number.isFinite(npc.authoritativeMovingSampleCount)
              ? npc.authoritativeMovingSampleCount
              : null,
          pendingExpectedSpeed:
            typeof npc.pendingLocomotionTargetSpeed === "number"
              ? npc.pendingLocomotionTargetSpeed
              : null,
          pendingNativeSeekTargetId:
            typeof npc.pendingNativeSeekTargetId === "string"
              ? npc.pendingNativeSeekTargetId
              : null,
          currentAnimation: npc.currentAnimation,
          lastAnimationEvent: runtime.lastAnimationEvent ?? null,
          animationRuntime,
          lookAtCharacterId: npc.lookAtCharacter ?? null,
          nativeSeekTargetId: npc.nativeSeekTarget ?? null,
          nativeSeekTargetSpeed:
            typeof npc.nativeSeekTargetControllerSpeed === "number"
              ? npc.nativeSeekTargetControllerSpeed
              : null,
          attackForward,
          targetCharacterId,
          targetPosition,
          targetPositionSource,
          targetMountedVehicleId,
          targetMountedSeatId,
          targetVehiclePosition: targetMountedVehicle?.state?.position
            ? Array.from(targetMountedVehicle.state.position)
            : null,
          targetDistance2d,
          targetDistance3d,
          targetHeightDelta,
          targetNavPosition,
          targetNavDistance2d,
          meleeProfile,
          meleeProfileSource,
          meleeEnvelopeSource,
          nativeMeleeCapability,
          nativeMeleeEngagementRange,
          meleeAnimationDurationMs,
          meleeAnimationDurationSource,
          meleeContactWindow,
          meleeDamageTiming,
          normalizedAttackPhase,
          contactWindowActive,
          attackDamageApplied,
          attackEnvelopeWasActive,
          animationVerification,
          nativeContactContract,
          meleeInEnvelope,
          navVelocity: velocity
            ? { x: velocity.x, y: velocity.y, z: velocity.z }
            : null,
          stateTimer: fsmRuntime?.stateTimer ?? null,
          aiTargets
        }
      ];
    });
    return { lastNpcId: this.lastNpcId, animals };
  }

  owns(characterId: string): boolean {
    return this.testNpcIds.has(characterId);
  }
}
