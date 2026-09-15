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

import { getDistance, isPosInRadiusWithY } from "../../../utils/utils";
import { Character2016 } from "../entities/character";
import { ExplosiveEntity } from "../entities/explosiveentity";
import { Npc } from "../entities/npc";
import type { NpcMeleeAttackProfile } from "../entities/npc";
import { TrapEntity } from "../entities/trapentity";
import { ModelIds } from "../models/enums";
import { ZoneServer2016 } from "../zoneserver";
import { NavManager } from "../../../utils/recast";

const degradeTrapsCallTime = 1300_000;
const ttlExplosives = 3600_000 * 3;
/** Experimental server targeting/damage; the test encounter uses proxied movement. */
const zombieMeleeCooldownMs = 1500;
const zombieMeleeHitDelayMs = 450;
const testMeleeFacingChangeRadians = 2 * Math.PI / 180;
const zombieChaseSpeed = 2.5;
const aiTickDt = 0.1;
const NPC_SEEK_TARGET_UPDATE_INTERVAL_MS = 400;

/**
 * Advance one authoritative shadow sample without ever crossing the target.
 * The old direct interpolation used `speed * dt / distance` as an unbounded
 * fraction; a short target distance could therefore overshoot and make the
 * next sample point back through the target. This layer only enforces a finite,
 * bounded step; terrain/height policy belongs to the route provider or client.
 */
export function moveTowardTarget(
  position: Float32Array,
  target: Float32Array,
  speed: number,
  dt: number
): Float32Array {
  const dx = target[0] - position[0];
  const dy = target[1] - position[1];
  const dz = target[2] - position[2];
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!Number.isFinite(distance) || distance <= 1e-6) return position.slice();
  const maxStep = Math.max(0, Number.isFinite(speed) && Number.isFinite(dt) ? speed * dt : 0);
  if (maxStep <= 0) return position.slice();
  const fraction = Math.min(1, maxStep / distance);
  return new Float32Array([
    position[0] + dx * fraction,
    position[1] + dy * fraction,
    position[2] + dz * fraction
  ]);
}

function isZombie(npc: Npc): boolean {
  return (
    npc.actorModelId === ModelIds.ZOMBIE_FEMALE_WALKER ||
    npc.actorModelId === ModelIds.ZOMBIE_MALE_WALKER ||
    npc.actorModelId === ModelIds.ZOMBIE_SCREAMER ||
    npc.actorModelId === ModelIds.BEAR
  );
}

export class AiManager {
  trapEntities: Set<TrapEntity> = new Set();
  playerEntities: Set<Character2016> = new Set();
  explosiveEntities: Set<ExplosiveEntity> = new Set();
  npcEntities: Set<Npc> = new Set();
  systemsCallsTime: Map<string, number> = new Map();
  now: number = 0;
  constructor(public server: ZoneServer2016) {}
  addEntity(entity: unknown) {
    switch (true) {
      case entity instanceof TrapEntity: {
        this.trapEntities.add(entity);
        break;
      }
      case entity instanceof Character2016: {
        this.playerEntities.add(entity);
        break;
      }
      case entity instanceof ExplosiveEntity: {
        this.explosiveEntities.add(entity);
        break;
      }
      case entity instanceof Npc: {
        this.npcEntities.add(entity);
        break;
      }
    }
  }
  removeEntity(entity: unknown) {
    switch (true) {
      case entity instanceof TrapEntity: {
        this.trapEntities.delete(entity);
        break;
      }
      case entity instanceof Character2016: {
        this.playerEntities.delete(entity);
        break;
      }
      case entity instanceof ExplosiveEntity: {
        this.explosiveEntities.delete(entity);
        break;
      }
      case entity instanceof Npc: {
        this.npcEntities.delete(entity);
        break;
      }
    }
  }
  getEntitiesTotalNumber(): number {
    return (
      this.trapEntities.size +
      this.playerEntities.size +
      this.explosiveEntities.size +
      this.npcEntities.size
    );
  }
  getEntitiesStats(): string {
    return `Players: ${this.playerEntities.size}\nTraps: ${this.trapEntities.size}\nExplosive: ${this.explosiveEntities.size}\nNpcs: ${this.npcEntities.size}`;
  }

  private checkTraps() {
    this.playerEntities.forEach((player) => {
      this.trapEntities.forEach((trap) => {
        if (trap.lastTrigger + trap.cooldown > this.now) {
          return;
        }
        const inRadius = isPosInRadiusWithY(
          trap.triggerRadiusX,
          player.state.position,
          trap.state.position,
          trap.triggerRadiusY
        );
        if (player.isAlive && inRadius) {
          trap.detonate(player.characterId);
        }
      });
    });
  }
  private checkExplosive() {
    this.playerEntities.forEach((player) => {
      this.explosiveEntities.forEach((explosive) => {
        const inRadius = isPosInRadiusWithY(
          0.6,
          player.state.position,
          explosive.state.position,
          0.5
        );
        if (player.isAlive && inRadius) {
          explosive.detonate(player.characterId);
        }
      });
    });
  }
  private degradeTraps() {
    this.trapEntities.forEach((trap) => {
      trap.damage(this.server, {
        damage: (trap.maxHealth * degradeTrapsCallTime) / trap.degradationTime,
        entity: "Server.degradeTraps"
      });
    });
  }
  private triggerOldExplosives() {
    this.explosiveEntities.forEach((explosive) => {
      if (explosive.creationTime + ttlExplosives < this.now) {
        explosive.detonate();
      }
    });
  }
  private executeScheduled(fn: () => void) {
    this.systemsCallsTime.set(fn.name, this.now);
    fn.bind(this)();
  }
  private scheduleExecute(fn: () => void, time: number) {
    if (this.systemsCallsTime.has(fn.name)) {
      const lastCall = this.systemsCallsTime.get(fn.name) as number;
      if (lastCall + time < this.now) {
        this.executeScheduled(fn);
      }
    } else {
      this.executeScheduled(fn);
    }
  }

  private getNearestPlayerInRange(npc: Npc): Character2016 | null {
    let nearest: Character2016 | null = null;
    let minDist = npc.npcRenderDistance;
    this.playerEntities.forEach((player) => {
      if (!player.isAlive) return;
      const d = getDistance(npc.state.position, player.state.position);
      if (d < minDist) {
        minDist = d;
        nearest = player;
      }
    });
    return nearest;
  }

  private getPlayerByCharacterId(characterId: string): Character2016 | null {
    for (const p of this.playerEntities) {
      if (p.characterId === characterId && p.isAlive) return p;
    }
    return null;
  }

  /**
   * Read the NPC's resolved weapon envelope.  A missing definition is an
   * unknown attack capability, not permission to use the former 2.5m guess.
   */
  private getMeleeAttackProfile(npc: Npc): NpcMeleeAttackProfile | undefined {
    try {
      const getter = (npc as Npc & {
        getMeleeAttackProfile?: () => NpcMeleeAttackProfile | undefined;
      }).getMeleeAttackProfile;
      if (typeof getter !== "function") return;
      const profile = getter.call(npc);
      if (!profile || !Number.isFinite(profile.range) || profile.range <= 0 ||
          !Number.isFinite(profile.detectWidth) || profile.detectWidth < 0 ||
          !Number.isFinite(profile.detectHeight) || profile.detectHeight < 0) return;
      return profile;
    } catch {
      // Definition tables can be reloaded independently of AI.  Never turn a
      // transient lookup failure into a permissive melee hit.
      return;
    }
  }

  /**
   * Test the server's conservative candidate envelope at the current target
   * positions. RANGE is the fire-mode reach and is still measured in full 3D
   * by this fallback. The native `MELEE_DETECT_*` fields belong to the local
   * weapon/contact query; they are not a world-space comparison between the two
   * network-origin Y values. This method is therefore only a candidate gate,
   * not a recovered mesh/capsule collision query.
   */
  private canMeleeContact(
    npc: Npc,
    target: Character2016,
    profile: NpcMeleeAttackProfile
  ): boolean {
    if (!this.canMeleeReach(npc, target)) return false;
    const distance = getDistance(npc.state.position, target.state.position);
    return Number.isFinite(distance) && distance <= profile.range;
  }

  /**
   * Revalidate a pending swing using the attack origin/direction and the
   * horizontal part of the server candidate envelope. `MELEE_DETECT_WIDTH` is
   * the only weapon-data dimension that can be projected onto the server's
   * currently available XZ heading. `MELEE_DETECT_HEIGHT` must not be compared
   * with `target.state.position[1] - attackOrigin[1]`: native contact uses the
   * actor/weapon collision shapes, which are absent from this server model.
   * Full 3D RANGE remains enforced by `canMeleeContact` before this method is
   * reached (and again at delayed impact).
   */
  private canMeleeImpact(
    npc: Npc,
    target: Character2016,
    profile: NpcMeleeAttackProfile,
    attackOrigin: Float32Array,
    attackForward: [number, number]
  ): boolean {
    if (!this.canMeleeReach(npc, target)) return false;
    if (attackOrigin.length < 3 || ![attackOrigin[0], attackOrigin[1], attackOrigin[2]].every(Number.isFinite))
      return false;
    const [forwardX, forwardZ] = attackForward;
    if (!Number.isFinite(forwardX) || !Number.isFinite(forwardZ)) return false;
    const forwardLength = Math.hypot(forwardX, forwardZ);
    if (!Number.isFinite(forwardLength) || forwardLength <= Number.EPSILON) return false;
    const fx = forwardX / forwardLength;
    const fz = forwardZ / forwardLength;
    const dx = target.state.position[0] - attackOrigin[0];
    const dz = target.state.position[2] - attackOrigin[2];
    if (![dx, dz].every(Number.isFinite)) return false;
    const along = dx * fx + dz * fz;
    const lateral = Math.abs(dx * fz - dz * fx);
    return along >= 0 && along <= profile.range &&
      lateral <= profile.detectWidth;
  }

  /** Capture the horizontal aim vector for a swing, independent of later target motion. */
  private getMeleeAttackForward(
    npc: Npc,
    target: Character2016
  ): [number, number] | undefined {
    // The strike travels along the NPC's post-facing heading, not along a
    // vector recomputed from the target at hit time.  Production NPCs carry a
    // quaternion after setFacingToward; prefer that authoritative orientation.
    // Test doubles may omit rotation, so the target vector remains a bounded
    // fallback for those fixtures only.
    const rotation = npc.state.rotation;
    if (rotation && rotation.length >= 4 && Array.from(rotation).every(Number.isFinite)) {
      const [x, y, z, w] = rotation;
      const rotatedForwardX = 2 * (w * y + x * z);
      const rotatedForwardZ = 1 - 2 * (y * y + x * x);
      const rotatedForwardLength = Math.hypot(rotatedForwardX, rotatedForwardZ);
      if (Number.isFinite(rotatedForwardLength) && rotatedForwardLength > Number.EPSILON)
        return [rotatedForwardX / rotatedForwardLength, rotatedForwardZ / rotatedForwardLength];
    }
    const dx = target.state.position[0] - npc.state.position[0];
    const dz = target.state.position[2] - npc.state.position[2];
    const length = Math.hypot(dx, dz);
    if (Number.isFinite(length) && length > Number.EPSILON) return [dx / length, dz / length];

    // Coincident horizontal origins have no target-derived heading.  In that
    // degenerate case use the NPC quaternion only as an orientation source;
    // never fabricate a default direction.
    if (!rotation || rotation.length < 4 || !Array.from(rotation).every(Number.isFinite)) return;
    const [x, y, z, w] = rotation;
    const forwardX = 2 * (w * y + x * z);
    const forwardZ = 1 - 2 * (y * y + x * x);
    const forwardLength = Math.hypot(forwardX, forwardZ);
    if (!Number.isFinite(forwardLength) || forwardLength <= Number.EPSILON) return;
    return [forwardX / forwardLength, forwardZ / forwardLength];
  }

  private canMeleeReach(npc: Npc, target: Character2016): boolean {
    if (target.isRespawning) return false;
    for (const position of [npc.state.position, target.state.position]) {
      if (position.length < 3 || ![position[0], position[1], position[2]].every(Number.isFinite))
        return false;
    }
    if (!npc.testMeleeReachability) return true;
    try {
      // Never treat a failed/unknown geometry query as permission to damage.
      return npc.testMeleeReachability(npc.state.position, target.state.position) === true;
    } catch {
      return false;
    }
  }

  /** 僵尸 AI：Nav 寻路 + 近战；发包用 try-catch 防护，避免未捕获异常导致服务端挂掉。 */
  private runNpcs() {
    const nav = this.server.navManager;
    const navReady = nav.isReady;

    this.npcEntities.forEach((npc) => {
      try {
        this.runOneNpc(npc, navReady, nav);
      } catch (e) {
        console.error("[aimanager] runNpcs 单只 NPC 异常，避免拖垮服务端:", e);
      }
    });
    if (navReady) {
      try {
        nav.updt();
      } catch (e) {
        console.error("[aimanager] nav.updt 异常:", e);
      }
    }
    this.npcEntities.forEach((npc) => {
      try {
        this.runOneNpcMove(npc, navReady, nav);
      } catch (e) {
        console.error("[aimanager] runNpcs 移动单只 NPC 异常:", e);
      }
    });
  }

  private runOneNpc(
    npc: Npc,
    navReady: boolean,
    nav: import("../../../utils/recast").NavManager
  ) {
    if (!npc.isAlive || !isZombie(npc)) return;

    const devHttpOn = (this.server.getDevHttpPort?.() ?? 0) > 0;
    const disableAttack = process.env.DISABLE_ZOMBIE_ATTACK === "true";
    const walkToId = (this.server as unknown as { _testZombieWalkToCharacterId?: string | null })
      ._testZombieWalkToCharacterId;
    const chaseAttackId = (this.server as unknown as { _testZombieChaseAttackCharacterId?: string | null })
      ._testZombieChaseAttackCharacterId;
    const isTestZombieWalk =
      walkToId &&
      this.server._lastSpawnedNpcCharacterId === npc.characterId;
    const isTestZombieChaseAttack =
      chaseAttackId &&
      this.server._lastSpawnedNpcCharacterId === npc.characterId;
    const isProductionProbe =
      this.server._testSpeciesProbeNpcCharacterId === npc.characterId;

    // The dev HTTP guard pauses the ordinary world AI by default, but a
    // production-factory probe must still run its real targeting/movement path
    // so we can observe it with melee side effects disabled. Keep the two
    // concerns separate: disabling attack must never silently disable motion.
    // Test harnesses may pause unrelated world NPCs explicitly. Do not infer
    // this from the dev HTTP port: tests and normal deployments can expose the
    // same API while still expecting ordinary AI to run.
    const pauseOrdinaryAi = process.env.PAUSE_ORDINARY_NPC_AI === "true";
    if (pauseOrdinaryAi && !isTestZombieWalk && !isTestZombieChaseAttack &&
        !isProductionProbe) {
      if (npc.behaviorState !== 0) {
        npc.behaviorState = 0;
        npc.sendIdleStance();
        npc.sendLocomotionState(0);
      }
      npc.clearMovementController();
      npc.sendAggroLevel(0);
      return;
    }

    const target = isTestZombieChaseAttack
      ? this.getPlayerByCharacterId(chaseAttackId)
      : isTestZombieWalk
        ? this.getPlayerByCharacterId(walkToId)
        : this.getNearestPlayerInRange(npc);
    const dist = target
      ? getDistance(npc.state.position, target.state.position)
      : Number.POSITIVE_INFINITY;
    if (npc.clientDrivenSeek && !npc.testServerDrivenMovement &&
        this.server._lastSpawnedNpcCharacterId !== npc.characterId &&
        !npc.productionAiTraceLogged) {
      npc.productionAiTraceLogged = true;
      console.log(`[npc-production-ai] ${JSON.stringify({
        id: npc.characterId,
        modelId: npc.actorModelId,
        target: target?.characterId ?? null,
        distance: Number.isFinite(dist) ? Number(dist.toFixed(3)) : null,
        npcEntities: this.npcEntities.size,
        playerEntities: this.playerEntities.size,
        devHttpOn,
        disableAttack,
        clientDrivenSeek: npc.clientDrivenSeek
      })}`);
    }
    const meleeProfile = target ? this.getMeleeAttackProfile(npc) : undefined;
    const inMeleeRange = !!meleeProfile && Number.isFinite(dist) && dist <= meleeProfile.range;
    const meleeReachable = !!target && !!meleeProfile && inMeleeRange &&
      this.canMeleeContact(npc, target, meleeProfile);
    const newState: 0 | 1 | 2 = !target
      ? 0
      : inMeleeRange
        ? (meleeReachable ? 2 : npc.testRouteStep ? 1 : 0)
        : 1;
    if (npc.behaviorState !== newState) {
      const previousState = npc.behaviorState;
      npc.behaviorState = newState;
      try {
        if (newState === 0) {
          npc.productionMovementHandoffPending = false;
          npc.clearMovementController();
          npc.sendAggroLevel(0);
          npc.sendIdleStance();
          npc.sendLocomotionState(0);
        } else {
          npc.sendAggroLevel(1);
          if (newState === 2) {
            npc.productionMovementHandoffPending = false;
            npc.clearMovementController();
            // Once the native seek rail is released, publish the entity's
            // current server position as the authoritative zero-speed
            // boundary.  Without this handoff the client can resume an older
            // rail sample and visibly snap the NPC back at melee entry.
            // This is the explicit native-seek-to-melee stop handoff for both
            // bounded /ztest routes and production client-driven NPCs.
            if (npc.testServerDrivenMovement || npc.clientDrivenSeek)
              npc.sendIdleStance();
            npc.sendLocomotionState(2);
          } else {
            // Let the native graph see combat/chase before SeekTarget starts or
            // refreshes the movement controller on this same AI tick.
            const productionChaseHandoff = previousState === 2 &&
              npc.clientDrivenSeek && !npc.testServerDrivenMovement;
            if (productionChaseHandoff) {
              // The attack rail was already cleared on melee entry.  Re-publish
              // the current anchor with zero speed before switching the native
              // graph back to chase; runOneNpcMove consumes the pending barrier
              // so no position step can be paired with this state transition.
              npc.sendIdleStance();
              npc.productionMovementHandoffPending = true;
            } else {
              npc.productionMovementHandoffPending = false;
            }
            npc.sendLocomotionState(1);
          }
        }
      } catch (error) {
        // Retry this test-only transition before any attack after a failed stop.
        // No-throw sends still do not prove client delivery or acceptance.
        if (isTestZombieChaseAttack && npc.testServerDrivenMovement && newState === 2)
          npc.behaviorState = previousState;
        throw error;
      }
    }
    if (!target) {
      npc.clearMovementController();
      npc.sendAggroLevel(0);
      if (isTestZombieWalk) {
        (this.server as unknown as { _testZombieWalkToCharacterId?: string | null })
          ._testZombieWalkToCharacterId = null;
      }
      if (isTestZombieChaseAttack) {
        (this.server as unknown as { _testZombieChaseAttackCharacterId?: string | null })
          ._testZombieChaseAttackCharacterId = null;
      }
      return;
    }
    if (inMeleeRange && !isTestZombieWalk && meleeReachable && meleeProfile) {
      const testMeleeFacing = isTestZombieChaseAttack && npc.testServerDrivenMovement;
      // Temporary stimulus, not a native turn/idle contract: evaluate at the
      // existing 100ms AI tick, independently of attacks. The deadband compares
      // target yaw with the prior packet's quantized heading, not a minimum wire turn.
      if (testMeleeFacing) {
        const previousRotation = npc.state.rotation;
        if (npc.setFacingToward(target.state.position, testMeleeFacingChangeRadians)) {
          try {
            npc.sendIdleStance();
          } catch (error) {
            npc.state.rotation = previousRotation;
            throw error; // Preserve the pending facing and attack for a later AI tick.
          }
        }
      }
      if (this.now - npc.lastMeleeAttackTime >= zombieMeleeCooldownMs) {
        if (disableAttack) return;
        if (!testMeleeFacing) npc.setFacingToward(target.state.position);
        // Do not launch an attack merely because the target is inside RANGE.
        // RANGE is only the outer reach; the native MELEE_DETECT envelope must
        // also contain the current target before the swing is requested. The
        // same origin/forward snapshot is reused by the delayed impact gate.
        const attackOrigin = npc.state.position.slice();
        const attackForward = this.getMeleeAttackForward(npc, target);
        if (!attackForward || !this.canMeleeImpact(
          npc,
          target,
          meleeProfile,
          attackOrigin,
          attackForward
        )) return;
        npc.lastMeleeAttackTime = this.now;
        // Observation timestamps only: neither dispatch nor this experimental
        // timer proves the native animation's contact frame or a client ACK.
        const attackRequestedAt = Date.now();
        npc.triggerMeleeAttack();
        if (isTestZombieChaseAttack) {
          console.log(
            `[test-zombie] 请求 KnifeSlash 攻击事件: requestedAt=${attackRequestedAt}, npc=${npc.characterId}, target=${target.characterId}, experimentalHitDelayMs=${zombieMeleeHitDelayMs}, distance=${dist.toFixed(2)}, range=${meleeProfile.range}`
          );
        }
        const targetCharacterId = target.characterId;
        setTimeout(() => {
          if (this.server._npcs[npc.characterId] !== npc || !npc.isAlive) return;
          const currentTarget = this.getPlayerByCharacterId(targetCharacterId);
          if (!currentTarget) return;
          const currentProfile = this.getMeleeAttackProfile(npc);
          const hitDistance = getDistance(npc.state.position, currentTarget.state.position);
          if (!currentProfile || !Number.isFinite(hitDistance) ||
              !this.canMeleeContact(npc, currentTarget, currentProfile) ||
              !attackForward ||
              !this.canMeleeImpact(
                npc,
                currentTarget,
                currentProfile,
                attackOrigin,
                attackForward
              )) return;
          const healthBefore = currentTarget.getHealth();
          // Replay observation protection must gate the melee entry itself:
          // OnMeleeHit can add bleeding before Character.damage checks godMode.
          // Keep the native-test attack event and cooldown, but no health/bleed
          // side effects. The feedback probe uses the same accepted impact and
          // only asks the client to present its existing DamageInfo response.
          const protectedTestReplay = !!isTestZombieChaseAttack &&
            npc.testServerDrivenMovement && currentTarget.godMode === true;
          let damageFeedbackAttempted = false;
          if (protectedTestReplay) {
            const feedback = (npc as Npc & {
              sendMeleeDamageFeedback?: (characterId: string) => boolean;
            }).sendMeleeDamageFeedback;
            if (typeof feedback === "function")
              damageFeedbackAttempted = feedback.call(npc, targetCharacterId);
          } else {
            npc.applyDamage(targetCharacterId);
          }
          if (isTestZombieChaseAttack) {
            const healthAfter = currentTarget.getHealth();
            console.log(
              `[test-zombie] 近战命中检查: requestedAt=${attackRequestedAt}, checkedAt=${Date.now()}, npc=${npc.characterId}, target=${targetCharacterId}, distance=${hitDistance.toFixed(2)}, health=${healthBefore}->${healthAfter}, godMode=${currentTarget.isGodMode()}, respawning=${currentTarget.isRespawning}, protectedTestReplay=${protectedTestReplay}, damageFeedbackAttempted=${damageFeedbackAttempted}`
            );
          }
        }, zombieMeleeHitDelayMs);
      }
      return;
    }
    if (inMeleeRange && !meleeReachable && !npc.testRouteStep) return;
    if (inMeleeRange && meleeReachable && isTestZombieWalk && !isTestZombieChaseAttack) {
      (this.server as unknown as { _testZombieWalkToCharacterId?: string | null })
        ._testZombieWalkToCharacterId = null;
      npc.behaviorState = 0;
      npc.clearMovementController();
      npc.sendAggroLevel(0);
      npc.sendIdleStance();
      return;
    }
    if (npc.testRouteStep) return; // route step sets facing; do not install a seek/crowd controller
    npc.setFacingToward(target.state.position);
    if (!npc.testServerDrivenMovement) npc.seekTarget(target.characterId, target.state.position);
    if (!npc.testServerDrivenMovement && this.now - npc.lastSeekTargetUpdateTime >= NPC_SEEK_TARGET_UPDATE_INTERVAL_MS) {
      npc.lastSeekTargetUpdateTime = this.now;
      npc.seekTargetUpdate(target.characterId);
    }

    // Production native-seek NPCs deliberately do not enter the server's
    // recast crowd.  The seek packet remains a native target/acceleration hint;
    // visible motion comes from the single server position stream below.
    // Keeping a nav agent for every visible zombie/bear would make one player
    // activate hundreds of path requests in the same tick and can starve the
    // zone event loop before even the seek packet is emitted.  The server keeps
    // a lightweight shadow position in runOneNpcMove and publishes that stream
    // without giving up target/attack authority.
    if (npc.clientDrivenSeek && !npc.testServerDrivenMovement) return;

    if (navReady && !npc.skipNavAgent) {
      if (!npc.navAgent) {
        try {
          npc.navAgent = nav.createAgent(npc.state.position);
        } catch {
          return;
        }
      }
      npc.navAgent.requestMoveTarget(
        nav.getClosestNavPoint(target.state.position)
      );
    }
  }

  private runOneNpcMove(
    npc: Npc,
    navReady: boolean,
    _nav: import("../../../utils/recast").NavManager
  ) {
    if (!npc.isAlive || !isZombie(npc)) return;
    const walkToId = (this.server as unknown as { _testZombieWalkToCharacterId?: string | null })
      ._testZombieWalkToCharacterId;
    const chaseAttackId = (this.server as unknown as { _testZombieChaseAttackCharacterId?: string | null })
      ._testZombieChaseAttackCharacterId;
    const isTestZombieWalk =
      walkToId &&
      this.server._lastSpawnedNpcCharacterId === npc.characterId;
    const isTestZombieChaseAttack =
      chaseAttackId &&
      this.server._lastSpawnedNpcCharacterId === npc.characterId;
    const isProductionProbe =
      this.server._testSpeciesProbeNpcCharacterId === npc.characterId;
    const pauseOrdinaryAi = process.env.PAUSE_ORDINARY_NPC_AI === "true";
    if (pauseOrdinaryAi && !isTestZombieWalk && !isTestZombieChaseAttack &&
        !isProductionProbe) return;

    const target = isTestZombieChaseAttack
      ? this.getPlayerByCharacterId(chaseAttackId)
      : isTestZombieWalk
        ? this.getPlayerByCharacterId(walkToId)
        : this.getNearestPlayerInRange(npc);
    if (!target) {
      npc.productionMovementHandoffPending = false;
      npc.lastSeekTargetId = null;
      if (isTestZombieWalk) {
        (this.server as unknown as { _testZombieWalkToCharacterId?: string | null })
          ._testZombieWalkToCharacterId = null;
      }
      if (isTestZombieChaseAttack) {
        (this.server as unknown as { _testZombieChaseAttackCharacterId?: string | null })
          ._testZombieChaseAttackCharacterId = null;
      }
      return;
    }

    const dist = getDistance(npc.state.position, target.state.position);
    if (!Number.isFinite(dist)) return;
    const meleeProfile = this.getMeleeAttackProfile(npc);
    const inMeleeRange = !!meleeProfile && dist <= meleeProfile.range;
    const meleeContact = !!meleeProfile && inMeleeRange &&
      this.canMeleeContact(npc, target, meleeProfile);
    // A non-route NPC must not keep stepping once it reaches the weapon's
    // candidate range, even if a transient obstruction/height check prevents a
    // strike. Route-bound test NPCs are allowed to continue until contact is
    // actually available so the route provider can take them around obstacles.
    if (inMeleeRange && (meleeContact || !npc.testRouteStep)) return;

    if (npc.productionMovementHandoffPending && npc.clientDrivenSeek &&
        !npc.testServerDrivenMovement) {
      // Consume exactly one AI tick after the 2→1 zero-speed anchor.  The next
      // tick is the first one allowed to publish a moving shadow position.
      npc.productionMovementHandoffPending = false;
      return;
    }

    if (npc.testRouteStep) {
      const speed = zombieChaseSpeed * (npc.testChaseSpeedScale ?? 1);
      const nominalBudget = speed * aiTickDt;
      // Inspect without priming: unknown routes still stop before any new anchor.
      const motion = npc.testServerDrivenMovement ? npc.beginTestRouteMotion(false) : undefined;
      // Short intervals must not consume a full nominal step. Long intervals do
      // not accumulate catch-up debt or enlarge the existing 3D/terrain bound.
      const budget = motion ? Math.min(nominalBudget, speed * motion.elapsedMs / 1000) : nominalBudget;
      let next: Float32Array | undefined;
      try {
        if (Number.isFinite(budget) && budget > 0) {
          next = npc.testRouteStep(npc.state.position.slice(), target.state.position.slice(), budget);
          if (next && (next.length < 3 || ![next[0], next[1], next[2]].every(Number.isFinite) ||
            getDistance(npc.state.position, next) > budget + 0.001)) next = undefined;
        }
      } catch { next = undefined; }
      if (!next || getDistance(npc.state.position, next) < 0.0001) {
        if (npc.testServerDrivenMovement) npc.invalidateTestRouteMotion();
        if (!npc.testRouteStopped) {
          npc.clearMovementController();
          npc.sendIdleStance();
        }
        npc.testRouteStopped = true;
        return;
      }
      // A new/restarted stream validates one route, then only primes this tick.
      // Duplicate timestamps also return here without movement or a new prime.
      if (npc.testServerDrivenMovement && !motion) {
        npc.beginTestRouteMotion();
        return;
      }
      npc.testRouteStopped = false;
      const previousPosition = npc.state.position.slice();
      const routeHorizontalSpeed = Math.hypot(
        motion ? Math.round(next[0] * 100) / 100 - motion.previousPosition[0] : next[0] - previousPosition[0],
        motion ? Math.round(next[2] * 100) / 100 - motion.previousPosition[1] : next[2] - previousPosition[2]
      ) / (motion ? motion.elapsedMs / 1000 : aiTickDt);
      npc.setFacingToward(next);
      npc.state.position = next.slice();
      if (npc.goTo(npc.state.position, true, routeHorizontalSpeed, motion) === false && motion) {
        npc.state.position = previousPosition; // Failed attempt is not a new route baseline.
      }
      return;
    }

    const nativeSeekProduction = npc.clientDrivenSeek && !npc.testServerDrivenMovement;
    if (nativeSeekProduction) {
      // Match the speed advertised by Character.ExpectedSpeed/SeekTarget. This
      // is the server shadow and the one visible position stream; the native
      // client rail supplies the target/acceleration hint and locomotion graph
      // context, but no second server mover is installed.
      const speedScale = npc.testChaseSpeedScale ?? 1;
      const previousPosition = npc.state.position.slice();
      npc.state.position = moveTowardTarget(
        previousPosition,
        target.state.position,
        zombieChaseSpeed * speedScale,
        aiTickDt
      );
      if (isProductionProbe && npc.productionMoveTraceCount < 96) {
        npc.productionMoveTraceCount += 1;
        console.log(`[npc-production-move] ${JSON.stringify({
          id: npc.characterId,
          traceIndex: npc.productionMoveTraceCount,
          behaviorState: npc.behaviorState,
          target: target.characterId,
          targetPosition: Array.from(target.state.position),
          before: Array.from(previousPosition),
          after: Array.from(npc.state.position),
          stepDistance: Number(getDistance(previousPosition, npc.state.position).toFixed(4)),
          targetDistance: Number(getDistance(previousPosition, target.state.position).toFixed(4)),
          speed: zombieChaseSpeed * speedScale,
          dt: aiTickDt
        })}`);
      }
      npc.goTo(npc.state.position);
      return;
    }

    if (navReady && npc.navAgent) {
      npc.state.position = NavManager.Vec3ToFloat32(
        npc.navAgent.interpolatedPosition
      );
    } else {
      // 无 nav 或 skipNavAgent：直线追人（测试僵尸可用 testChaseSpeedScale 降速以便观察包是否生效）
      const speedScale = npc.testChaseSpeedScale ?? 1;
      npc.state.position = moveTowardTarget(
        npc.state.position,
        target.state.position,
        zombieChaseSpeed * speedScale,
        aiTickDt
      );
    }
    npc.goTo(npc.state.position);
  }

  private _lastRunLogTime = 0;
  run() {
    this.now = Date.now();
    const doLog = this.npcEntities.size > 0 && this.now - this._lastRunLogTime >= 2000;
    if (doLog) {
      this._lastRunLogTime = this.now;
      // console.log("[aimanager] run 入口", new Date().toISOString());
    }
    this.checkTraps();
    this.checkExplosive();
    this.scheduleExecute(this.degradeTraps, degradeTrapsCallTime);
    this.scheduleExecute(this.triggerOldExplosives, 60_000);
    this.runNpcs();
    // if (doLog) console.log("[aimanager] run 出口", new Date().toISOString());
  }
}
