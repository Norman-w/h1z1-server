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

import { JSM } from "./jsm";
import type { Npc } from "../entities/npc";
import type { ZoneServer2016 } from "../zoneserver";
import type { Sound } from "../../../types/zoneserver";
import { NavManager } from "../../../utils/recast";
const debug = require("debug")("ai");
import {
  getDistance2d,
  getDistance,
  isFacingTarget
} from "../../../utils/utils";
import { Effects, NpcIds } from "../models/enums";
import { Factions, isHostile } from "./factions";
import {
  ZombieLoopingAnim,
  ZombieOneshotAnim,
  ZombieTransitions,
  ZombieEvents,
  shouldFinishZombieStumble,
  type ZombieInstance
} from "./zombie.jsm";

const BASE_SPEED = 1.0;
const MAX_SPEED = 3.0;
const AGITATION_DECAY_RATE = 1;
const AGITATION_INITIAL = 50;
const INVESTIGATE_TIMEOUT = 120;
const STUMBLE_CHANCE = 0.001;
const OVERRIDE_ACTION_SOUND_PRIORITY = 10;
const GAS_CHARGE_RANGE = 10;
const GAS_CHARGE_PER_CLIENT = 0.2;
const GAS_CHARGE_PER_ZOMBIE = 0.1;
const MELEE_SLASH_RANGE = 2;
const GAS_SPIT_RANGE = 10;
const GAS_CLOUD_RANGE = 10;
const GAS_DAMAGE_PER_TICK = 500;
const GAS_DAMAGE_TICK_MS = 1000;
const GAS_DAMAGE_DURATION_MS = 10000;

function pickPatrolPoint(
  server: ZoneServer2016,
  center: Float32Array
): Float32Array | null {
  const navCenter = NavManager.gameToNav(center);
  const { success, randomPoint } =
    server.navManager.navMeshQuery.findRandomPointAroundCircle(navCenter, 60);
  return success ? NavManager.navToGame(randomPoint) : null;
}

function moveToward(
  npc: Npc,
  target: Float32Array,
  server: ZoneServer2016
): boolean {
  if (!npc.navAgent) {
    npc.setLocomotionMode?.("walk");
    npc.stopMovement();
    return false;
  }
  try {
    const navTarget = server.navManager.getClosestNavPointVec3(target);
    if (npc.navAgent.requestMoveTarget(navTarget) === false) {
      // Do not leave the ranged/melee chase speed advertised after a rejected
      // target; that renders an in-place run while the server has no path.
      npc.setLocomotionMode?.("walk");
      npc.stopMovement();
      return false;
    }
  } catch {
    // An off-mesh projection is the same failed target installation.
    npc.setLocomotionMode?.("walk");
    npc.stopMovement();
    return false;
  }
  return true;
}

function listenToSounds(gasser: ZombieInstance, sounds: Sound[]): Sound | null {
  let nearest: Sound | null = null;
  let nearestDist = Infinity;
  let bestPriority = Number.NEGATIVE_INFINITY;
  for (const sound of sounds) {
    const dist = getDistance2d(gasser.npc.state.position, sound.position);
    if (dist < sound.radius) {
      gasser.agitation = Math.min(100, gasser.agitation + sound.agitation);
      const priority = sound.priority ?? 0;
      if (
        priority > bestPriority ||
        (priority === bestPriority && dist < nearestDist)
      ) {
        nearest = sound;
        bestPriority = priority;
        nearestDist = dist;
      }
    }
  }
  return nearest;
}

function applyDamageToTarget(zombie: ZombieInstance): void {
  if (!zombie.targetCharacterId) return;
  const character = zombie.server._characters[zombie.targetCharacterId];
  if (character?.isAlive) {
    zombie.npc.applyDamage(zombie.targetCharacterId);
    return;
  }
  const targetNpc = zombie.server._npcs[zombie.targetCharacterId];
  if (targetNpc && targetNpc.isAlive) {
    const damageInfo = {
      entity: zombie.npc.characterId,
      damage: zombie.npc.npcMeleeDamage
    };
    if (typeof targetNpc.applyNpcMeleeHit === "function") {
      targetNpc.applyNpcMeleeHit(zombie.server, damageInfo);
    } else {
      // Lightweight AI doubles may not expose the presentation-aware hook.
      targetNpc.damage(zombie.server, damageInfo);
    }
  }
}

function getMeleeRange(gasser: ZombieInstance): number {
  return (
    gasser.npc.getMeleeAttackRange?.(MELEE_SLASH_RANGE) ?? MELEE_SLASH_RANGE
  );
}

function getMeleeAttackDuration(gasser: ZombieInstance): number {
  return gasser.npc.getMeleeAttackAnimationDuration?.(1) ?? 1;
}

function getActionDuration(
  gasser: ZombieInstance,
  animationName: ZombieOneshotAnim
): number {
  const durationMs = gasser.npc.getAnimationDurationMs?.(animationName);
  if (Number.isFinite(durationMs) && (durationMs as number) > 0) {
    return (durationMs as number) / 1000;
  }
  return 1;
}

/** Keep recovery poses stationary until their public one-shot clocks finish. */
function isGasserRecoveryAnimationActive(gasser: ZombieInstance): boolean {
  const active = gasser.npc.getAnimationRuntimeState?.().activeAnimation;
  return active === ZombieOneshotAnim.EatingDone ||
    active === ZombieOneshotAnim.CoverEarsDone;
}

function getAttackForward(
  npc: Npc,
  targetPosition: Float32Array
): [number, number] | null {
  const yaw = npc.state.yaw;
  if (Number.isFinite(yaw)) {
    const forward: [number, number] = [Math.sin(yaw), Math.cos(yaw)];
    if (Math.hypot(forward[0], forward[1]) > Number.EPSILON) return forward;
  }
  const dx = targetPosition[0] - npc.state.position[0];
  const dz = targetPosition[2] - npc.state.position[2];
  const length = Math.hypot(dx, dz);
  return length > Number.EPSILON ? [dx / length, dz / length] : null;
}

function shouldOverrideAction(sound: Sound | null): boolean {
  if (!sound) return false;
  return (sound.priority ?? 0) >= OVERRIDE_ACTION_SOUND_PRIORITY;
}

function chargeGas(gasser: ZombieInstance): void {
  const origin = gasser.npc.state.position;
  const sz = 50;
  const cx = Math.floor(origin[0] / sz);
  const cz = Math.floor(origin[2] / sz);
  let nearbyClients = 0;
  let nearbyZombies = 0;

  // aiTargetSpatialMap already carries both alive characters (HUMAN) and alive
  // npcs with their faction, rebuilt every AI tick — reuse it instead of
  // scanning every client + every npc on the server for each gasser.
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const bucket = gasser.server.aiTargetSpatialMap.get(
        `${cx + dx},${cz + dz}`
      );
      if (!bucket) continue;
      for (const entry of bucket) {
        if (getDistance2d(origin, entry.position) > GAS_CHARGE_RANGE) continue;
        if (entry.faction === Factions.HUMAN) {
          nearbyClients++;
        } else if (
          entry.faction === Factions.ZOMBIE &&
          entry.id !== gasser.npc.characterId
        ) {
          nearbyZombies++;
        }
      }
    }
  }

  const chargeGain =
    nearbyClients * GAS_CHARGE_PER_CLIENT +
    nearbyZombies * GAS_CHARGE_PER_ZOMBIE;
  gasser.ChargeGas = Math.min(100, gasser.ChargeGas + chargeGain);
}

function trySeePlayer(gasser: ZombieInstance): boolean {
  const sz = 50;
  const pos = gasser.npc.state.position;
  const cx = Math.floor(pos[0] / sz);
  const cz = Math.floor(pos[2] / sz);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const bucket = gasser.server.aiTargetSpatialMap.get(
        `${cx + dx},${cz + dz}`
      );
      if (!bucket) continue;
      for (const entry of bucket) {
        if (entry.id === gasser.npc.characterId) continue;
        if (!isHostile(gasser.npc.faction, entry.faction)) continue;
        if (getDistance2d(pos, entry.position) < 10) {
          gasser.targetCharacterId = entry.id;
          gasser.event(ZombieEvents.SeePlayer);
          return true;
        }
      }
    }
  }
  return false;
}

function trySmellCorpse(gasser: ZombieInstance): boolean {
  if (gasser.hunger < 60) return false;
  for (const client of gasser.server.getClientsInRange(
    gasser.npc.state.position,
    30
  )) {
    if (client.character.isAlive) continue;
    gasser.corpseTargetId = client.character.characterId;
    gasser.event(ZombieEvents.SmellCorpse);
    return true;
  }
  return false;
}

function getChaseTarget(gasser: ZombieInstance): {
  position: Float32Array;
  isAlive: boolean;
  isVanished: boolean;
  isHidden: boolean;
} | null {
  if (!gasser.targetCharacterId) return null;
  const player = gasser.server._characters[gasser.targetCharacterId];
  if (player)
    return {
      position: player.state.position,
      isAlive: player.isAlive,
      isVanished: !!player.isVanished,
      isHidden: !!player.isHidden
    };
  const npc = gasser.server._npcs[gasser.targetCharacterId];
  if (npc)
    return {
      position: npc.state.position,
      isAlive: npc.isAlive,
      isVanished: false,
      isHidden: false
    };
  return null;
}

export function spawnGasCloudAt(
  server: ZoneServer2016,
  position: Float32Array,
  ownerCharacterId: string
): void {
  server.sendCompositeEffectToAllInRange(
    100,
    ownerCharacterId,
    position,
    Effects.PFX_Char_Zombie_Gasser_GasCloud
  );

  const ownerNpc = server._npcs[ownerCharacterId];
  if (ownerNpc?.npcId === NpcIds.GASSER) {
    for (const npc of Object.values(server._npcs)) {
      if (!npc.isAlive || npc.characterId === ownerCharacterId) continue;
      if (npc.faction !== Factions.ZOMBIE) continue;
      if (getDistance2d(position, npc.state.position) > GAS_CLOUD_RANGE)
        continue;
      if (npc.effectTags.includes(Effects.PFX_Char_Zombie_Gasser_Ambient))
        continue;
      if (
        Math.floor(Math.random() * 100) + 1 >
        server.worldObjectManager.chanceGasserPropagation
      )
        continue;

      npc.effectTags.push(Effects.PFX_Char_Zombie_Gasser_Ambient);
      server.sendDataToAllWithSpawnedEntity(
        server._npcs,
        npc.characterId,
        "Character.AddEffectTagCompositeEffect",
        {
          characterId: npc.characterId,
          unknownDword1: Effects.PFX_Char_Zombie_Gasser_Ambient,
          effectId: Effects.PFX_Char_Zombie_Gasser_Ambient,
          unknownGuid: ownerCharacterId,
          unknownDword2: 3
        }
      );
    }
  }

  const applyGasDamage = () => {
    for (const client of server.getClientsInRange(position, GAS_CLOUD_RANGE)) {
      const character = client.character;
      if (!character.isAlive) continue;
      if (server.checkRespirator(character)) continue;
      if (getDistance(character.state.position, position) > GAS_CLOUD_RANGE)
        continue;

      character.damage(server, {
        entity: ownerCharacterId || "Server.GasserGas",
        damage: GAS_DAMAGE_PER_TICK
      });

      server.sendDataToAllWithSpawnedEntity(
        server._characters,
        character.characterId,
        "Character.PlayAnimation",
        {
          characterId: character.characterId,
          animationName: "Action",
          animationType: "ActionType",
          unm4: 0,
          unknownDword1: 0,
          unknownByte1: 0,
          unknownDword2: 0,
          unknownByte1xda: 0,
          unknownDword3: 10
        }
      );
    }
  };

  applyGasDamage();
  const gasDamageInterval = setInterval(applyGasDamage, GAS_DAMAGE_TICK_MS);

  setTimeout(() => {
    clearInterval(gasDamageInterval);
  }, GAS_DAMAGE_DURATION_MS);
}

function spawnGasCloud(gasser: ZombieInstance): void {
  const targetCharacter =
    gasser.server._characters[gasser.targetCharacterId ?? ""];
  const targetNpc = gasser.server._npcs[gasser.targetCharacterId ?? ""];
  const targetPos =
    targetCharacter?.state.position ?? targetNpc?.state.position;
  if (!targetPos) return;

  spawnGasCloudAt(
    gasser.server,
    targetPos.slice() as Float32Array,
    gasser.npc.characterId
  );
}

function tickTimers(gasser: ZombieInstance, dt: number): void {
  gasser.hunger = Math.min(100, gasser.hunger + dt * 2);
  gasser.stateTimer += dt;
  gasser.lastAttackTime += dt;
}

function enterWander(gasser: ZombieInstance): void {
  // Do not carry a gas/melee chase impulse into the normal walk state.
  gasser.npc.stopMovement();
  gasser.stateTimer = 0;
  gasser.agitation = AGITATION_INITIAL;
  gasser.targetCharacterId = null;
  gasser.attackForward = null;
  gasser.npc.setLookAtCharacter?.(null);
  gasser.npc.setCombatAnimationMode?.(false);
  gasser.npc.setLocomotionMode?.("walk");
  // Queue the normal loop before a recovery one-shot expires.  Without this
  // edge an EatingDone transition can restore the previous Eating clip and
  // leave a live Gasser visibly frozen in its feeding pose.
  gasser.npc.setAnimation(ZombieLoopingAnim.Idle);
  gasser.npc.lookAtTarget = null;
  gasser.wanderOrigin = gasser.npc.state.position.slice() as Float32Array;
  gasser.targetPos = null;
  if (isGasserRecoveryAnimationActive(gasser)) {
    // EatingDone/CoverEarsDone are graph recovery edges.  Do not install a
    // patrol target until the client has returned to the persistent loop.
    gasser.npc.setSpeed(0);
    return;
  }
  const pt = pickPatrolPoint(gasser.server, gasser.wanderOrigin);
  if (pt) {
    gasser.targetPos = pt;
    if (moveToward(gasser.npc, pt, gasser.server)) {
      applyAgitation(gasser);
    } else {
      gasser.targetPos = null;
      gasser.npc.setSpeed(0);
    }
  } else {
    gasser.npc.setSpeed(0);
  }
}

function enterFeed(gasser: ZombieInstance): void {
  gasser.npc.stopMovement();
  gasser.npc.setCombatAnimationMode?.(false);
  gasser.npc.setLocomotionMode?.("walk");
  gasser.stateTimer = 0;
  gasser.targetCharacterId = null;
  gasser.attackForward = null;
  gasser.npc.setLookAtCharacter?.(null);
  gasser.npc.lookAtTarget = null;
  gasser.isEatingCorpse = false;
}

function applyAgitation(gasser: ZombieInstance) {
  const speed =
    BASE_SPEED + (gasser.agitation / 100) * (MAX_SPEED - BASE_SPEED);
  gasser.npc.setSpeed(speed);
}

function decayAgitation(gasser: ZombieInstance, dt: number) {
  gasser.agitation = Math.max(0, gasser.agitation - AGITATION_DECAY_RATE * dt);
}

export function createGasser(npc: Npc, server: ZoneServer2016): ZombieInstance {
  // The three Gasser actions share one FSM state, but only KnifeSlash is a
  // melee strike. Keep the action edge separate so Spit/GasConvulse cannot
  // fall through to the melee damage branch at the end of the shared state.
  let attackAction: "melee" | "spit" | "gas" = "melee";
  // GasConvulse is followed by a short Stagger_Light recovery clip.  Keep
  // that handoff in the FSM instead of a wall-clock timeout: a delayed AI
  // tick, an interrupted action, or a late observer must not inject Stagger
  // into the next attack state.
  let gasStaggerStarted = false;

  const gasser = new JSM(
    {
      [ZombieTransitions.Wander]: (dt: number) => {
        if (gasser.isCoveringEars) {
          gasser.coverEarsTimer += dt;
          const coverEarsClipActive =
            gasser.npc.isAnimationActive?.(ZombieOneshotAnim.CoverEars) ??
            false;
          if (gasser.coverEarsTimer >= 3 && !coverEarsClipActive) {
            gasser.isCoveringEars = false;
            gasser.npc.playAnimation(ZombieOneshotAnim.CoverEarsDone);
            enterWander(gasser);
          }
          return;
        }

        if (isGasserRecoveryAnimationActive(gasser)) {
          gasser.npc.stopMovement();
          gasser.npc.setLocomotionMode?.("walk");
          gasser.npc.setSpeed(0);
          return;
        }

        tickTimers(gasser, dt);

        if (trySeePlayer(gasser)) return;
        if (trySmellCorpse(gasser)) return;

        const nearestSound = listenToSounds(gasser, gasser.server.sounds);
        if (nearestSound) {
          gasser.lastNoisePos = nearestSound.position;
          gasser.event(ZombieEvents.HearNoise);
          return;
        }

        decayAgitation(gasser, dt);

        if (gasser.agitation === 0) {
          gasser.event(ZombieEvents.IdleTimeout);
          return;
        }

        const arrived =
          gasser.targetPos != null &&
          getDistance2d(gasser.npc.state.position, gasser.targetPos) < 3;

        if (arrived || gasser.targetPos == null) {
          const pt = pickPatrolPoint(gasser.server, gasser.wanderOrigin);
          if (pt) {
            gasser.targetPos = pt;
            if (!moveToward(gasser.npc, pt, gasser.server)) {
              gasser.targetPos = null;
              gasser.npc.setSpeed(0);
            } else {
              applyAgitation(gasser);
            }
          } else {
            gasser.targetPos = null;
            gasser.npc.stopMovement();
          }
        } else {
          applyAgitation(gasser);
        }
      },

      [ZombieTransitions.Idle]: (dt: number) => {
        tickTimers(gasser, dt);

        if (trySeePlayer(gasser)) return;

        const nearestSound = listenToSounds(gasser, gasser.server.sounds);
        if (nearestSound) {
          gasser.lastNoisePos = nearestSound.position;
          gasser.event(ZombieEvents.HearNoise);
          return;
        }

        trySmellCorpse(gasser);
      },
      [ZombieTransitions.Investigate]: (dt: number) => {
        tickTimers(gasser, dt);
        gasser.npc.setCombatAnimationMode?.(false);
        gasser.npc.setLocomotionMode?.("walk");

        if (trySeePlayer(gasser)) return;
        if (trySmellCorpse(gasser)) return;

        if (gasser.stateTimer >= INVESTIGATE_TIMEOUT) {
          gasser.event(ZombieEvents.NoiseTimeout);
          return;
        }

        if (
          gasser.lastNoisePos != null &&
          getDistance2d(gasser.npc.state.position, gasser.lastNoisePos) < 3
        ) {
          gasser.event(ZombieEvents.NoiseTimeout);
          return;
        }

        if (gasser.targetPos != null) {
          applyAgitation(gasser);
        } else {
          gasser.npc.setSpeed(0);
        }

        const nearestSound = listenToSounds(gasser, gasser.server.sounds);
        if (nearestSound) {
          gasser.lastNoisePos = nearestSound.position;
          if (shouldOverrideAction(nearestSound)) {
            gasser.event(ZombieEvents.HearNoise);
            return;
          }
          gasser.stateTimer = 0;
          gasser.targetPos = nearestSound.position;
          if (!moveToward(gasser.npc, gasser.targetPos, gasser.server)) {
            gasser.targetPos = null;
            gasser.npc.setSpeed(0);
          } else {
            applyAgitation(gasser);
          }
        }
      },

      [ZombieTransitions.Chase]: (dt: number) => {
        tickTimers(gasser, dt);
        gasser.npc.setCombatAnimationMode?.(true);
        gasser.npc.setLocomotionMode?.("sprint");
        const nearestSound = listenToSounds(gasser, gasser.server.sounds);
        if (nearestSound && shouldOverrideAction(nearestSound)) {
          gasser.lastNoisePos = nearestSound.position;
          gasser.event(ZombieEvents.HearNoise);
          return;
        }
        const chaseTarget = getChaseTarget(gasser);
        if (
          !chaseTarget ||
          !chaseTarget.isAlive ||
          chaseTarget.isVanished ||
          chaseTarget.isHidden
        ) {
          gasser.event(ZombieEvents.LostPlayer);
          return;
        }
        gasser.npc.setLookAtCharacter?.(gasser.targetCharacterId);

        chargeGas(gasser);

        gasser.npc.lookAtTarget = chaseTarget.position;
        const chaseDist = getDistance2d(
          gasser.npc.state.position,
          chaseTarget.position
        );
        if (chaseDist > 50) {
          gasser.event(ZombieEvents.LostPlayer);
        } else if (chaseDist <= GAS_SPIT_RANGE) {
          gasser.event(ZombieEvents.ReachPlayer);
        } else {
          if (trySmellCorpse(gasser)) return;
          if (Math.random() < STUMBLE_CHANCE) {
            gasser.event(ZombieEvents.StartStumble);
            return;
          }
          if (!moveToward(gasser.npc, chaseTarget.position, gasser.server)) {
            gasser.npc.setSpeed(0);
          } else {
            applyAgitation(gasser);
          }
        }
      },

      [ZombieTransitions.Stumble]: (dt: number) => {
        gasser.npc.setCombatAnimationMode?.(false);
        gasser.npc.setLocomotionMode?.("walk");
        const nearestSound = listenToSounds(gasser, gasser.server.sounds);
        if (nearestSound && shouldOverrideAction(nearestSound)) {
          gasser.lastNoisePos = nearestSound.position;
          gasser.event(ZombieEvents.HearNoise);
          return;
        }
        gasser.stateTimer += dt;
        if (shouldFinishZombieStumble(gasser)) {
          gasser.event(ZombieEvents.StumbleTimeout);
        }
      },

      [ZombieTransitions.Attack]: (dt: number) => {
        tickTimers(gasser, dt);
        gasser.npc.setCombatAnimationMode?.(true);
        const nearestSound = listenToSounds(gasser, gasser.server.sounds);
        if (nearestSound && shouldOverrideAction(nearestSound)) {
          gasser.lastNoisePos = nearestSound.position;
          gasser.event(ZombieEvents.HearNoise);
          return;
        }
        const attackTarget = getChaseTarget(gasser);
        if (!attackTarget || !attackTarget.isAlive) {
          if (gasser.hunger >= 30) {
            gasser.event(ZombieEvents.PlayerKilled);
          } else {
            gasser.event(ZombieEvents.LostPlayer);
          }
          return;
        }
        if (attackTarget.isVanished || attackTarget.isHidden) {
          gasser.event(ZombieEvents.LostPlayer);
          return;
        }
        gasser.npc.setLookAtCharacter?.(gasser.targetCharacterId);

        chargeGas(gasser);

        gasser.npc.lookAtTarget = attackTarget.position;
        gasser.npc.lookAt(attackTarget.position, dt);
        const attackDist = getDistance(
          gasser.npc.state.position,
          attackTarget.position
        );
        const meleeRange = getMeleeRange(gasser);
        if (attackDist > GAS_SPIT_RANGE) {
          gasser.npc.setLocomotionMode?.("sprint");
          if (moveToward(gasser.npc, attackTarget.position, gasser.server)) {
            applyAgitation(gasser);
            gasser.event(ZombieEvents.PlayerBacked);
          } else {
            gasser.npc.setSpeed(0);
          }
        } else if (attackDist > meleeRange) {
          // Reaching the gas envelope does not mean the gasser is in melee
          // range.  Keep closing with the nav agent until the configured
          // weapon envelope is reached; otherwise it can remain in Attack at
          // 2..10m with maxSpeed=0 and never start a valid action.
          gasser.npc.setLocomotionMode?.("sprint");
          if (moveToward(gasser.npc, attackTarget.position, gasser.server)) {
            applyAgitation(gasser);
          } else {
            gasser.npc.setSpeed(0);
          }
        } else {
          // The gasser is inside its action envelope (melee or gas).  It must
          // hold position while the selected action starts; only the chase
          // branch above should publish sprint movement.
          gasser.npc.setLocomotionMode?.("walk");
          gasser.npc.stopMovement();
          const inStrikeEnvelope =
            gasser.npc.isMeleeTargetInEnvelope?.(attackTarget.position) ?? true;
          const unobstructed =
            gasser.npc.hasMeleeLineOfSight?.(attackTarget.position) ?? true;
          if (gasser.lastAttackTime > 2) {
            if (
              attackDist <= meleeRange &&
              inStrikeEnvelope &&
              unobstructed &&
              gasser.ChargeGas >= 100 &&
              Math.random() < 0.3
            ) {
              gasser.event(ZombieEvents.ReleaseGas);
            } else if (attackDist <= meleeRange && inStrikeEnvelope && unobstructed) {
              gasser.event(ZombieEvents.StartAttacking);
            }
          }
        }
      },

      [ZombieTransitions.Attacking]: (dt: number) => {
        const stateTimerBefore = gasser.stateTimer;
        gasser.hunger = Math.min(100, gasser.hunger + dt * 2);
        // All three actions are driven by the same client one-shot clock.
        // Advancing non-melee actions at 2x made the server enter the
        // recovery branch before Spit/GasConvulse had elapsed; the active
        // clip guard hid the error for production Npcs but left the FSM's
        // phase and diagnostics one action ahead.  Keep one authoritative
        // seconds clock and resolve the selected clip's duration below.
        gasser.stateTimer += dt;
        gasser.lastAttackTime += dt;
        gasser.npc.setCombatAnimationMode?.(true);
        chargeGas(gasser);

        // Do not interrupt KnifeSlash, Spit, or GasConvulse with a sound
        // transition.  The old branch could replace the active graph event
        // and install a chase target before SwingContact/convulsion finished;
        // consume the sound from Attack after this one-shot has handed back
        // to its persistent loop.

        const attackTarget = getChaseTarget(gasser);
        if (attackTarget && gasser.targetCharacterId) {
          gasser.npc.setLookAtCharacter?.(gasser.targetCharacterId);
        }

        const attackAnimation =
          attackAction === "melee"
            ? ZombieOneshotAnim.KnifeSlash
            : attackAction === "spit"
              ? ZombieOneshotAnim.Spit
              : gasStaggerStarted
              ? ZombieOneshotAnim.Stagger_Light
                : ZombieOneshotAnim.GasConvulse;
        const attackDuration =
          attackAction === "melee"
            ? getMeleeAttackDuration(gasser)
            : getActionDuration(gasser, attackAnimation);
        const attackClipState = gasser.npc.isAnimationActive?.(attackAnimation);

        if (
          attackAction === "gas" &&
          !gasStaggerStarted &&
          gasser.stateTimer >= attackDuration &&
          !(attackClipState ?? false)
        ) {
          // The gas cloud was emitted on ReleaseGas.  Only after the native
          // convulsion clock has ended may the recovery clip begin.
          gasStaggerStarted = true;
          gasser.stateTimer = 0;
          gasser.npc.playAnimation(ZombieOneshotAnim.Stagger_Light);
          return;
        }

        if (attackAction === "melee") {
          const contactWindow = gasser.npc.getMeleeContactWindow?.();
          const contactStart = contactWindow
            ? attackDuration * contactWindow.startFraction
            : attackDuration;
          const contactEnd = contactWindow
            ? attackDuration * contactWindow.endFraction
            : attackDuration;
          const contactActive =
            (attackClipState ?? true) &&
            stateTimerBefore < attackDuration &&
            stateTimerBefore <= contactEnd &&
            gasser.stateTimer >= contactStart;
          if (!gasser.attackDamageApplied && contactActive) {
            if (
              attackTarget?.isAlive &&
              !attackTarget.isVanished &&
              !attackTarget.isHidden
            ) {
              const facingTarget = isFacingTarget(
                gasser.npc.state.position,
                gasser.npc.state.yaw ?? 0,
                attackTarget.position
              );
              const inStrikeEnvelope =
                gasser.npc.isMeleeTargetInEnvelope?.(
                  attackTarget.position,
                  gasser.npc.state.position,
                  gasser.attackForward ?? undefined
                ) ??
                (getDistance(
                  gasser.npc.state.position,
                  attackTarget.position
                ) <= getMeleeRange(gasser) && facingTarget);
              const unobstructed =
                gasser.npc.hasMeleeLineOfSight?.(attackTarget.position) ?? true;
              const crossedContactEnd =
                stateTimerBefore < contactEnd && gasser.stateTimer > contactEnd;
              if (
                inStrikeEnvelope &&
                unobstructed &&
                (!crossedContactEnd || gasser.attackEnvelopeWasActive)
              ) {
                applyDamageToTarget(gasser);
                gasser.attackDamageApplied = true;
              }
              gasser.attackEnvelopeWasActive = inStrikeEnvelope;
            } else {
              gasser.attackEnvelopeWasActive = false;
            }
          } else if (attackTarget?.isAlive) {
            const facingTarget = isFacingTarget(
              gasser.npc.state.position,
              gasser.npc.state.yaw ?? 0,
              attackTarget.position
            );
            gasser.attackEnvelopeWasActive =
              gasser.npc.isMeleeTargetInEnvelope?.(
                attackTarget.position,
                gasser.npc.state.position,
                gasser.attackForward ?? undefined
              ) ??
              (getDistance(
                gasser.npc.state.position,
                attackTarget.position
              ) <= getMeleeRange(gasser) && facingTarget);
          } else {
            gasser.attackEnvelopeWasActive = false;
          }
        }

        if (gasser.stateTimer >= attackDuration && !(attackClipState ?? false)) {
          gasser.event(ZombieEvents.DoneAttacking);
        }
      },

      [ZombieTransitions.Feed]: (dt: number) => {
        gasser.stateTimer += dt;
        gasser.lastAttackTime += dt;
        gasser.npc.setCombatAnimationMode?.(false);
        gasser.npc.setLocomotionMode?.("walk");
        const nearestSound = listenToSounds(gasser, gasser.server.sounds);
        if (nearestSound && shouldOverrideAction(nearestSound)) {
          gasser.lastNoisePos = nearestSound.position;
          gasser.event(ZombieEvents.HearNoise);
          return;
        }

        if (gasser.corpseTargetId) {
          const corpse = gasser.server._characters[gasser.corpseTargetId];
          if (!corpse || corpse.isAlive) {
            gasser.corpseTargetId = null;
            gasser.isEatingCorpse = false;
            gasser.npc.setLookAtCharacter?.(null);
            gasser.event(ZombieEvents.DoneFeeding);
            return;
          }
          if (!gasser.isEatingCorpse) {
            const dist = getDistance2d(
              gasser.npc.state.position,
              corpse.state.position
            );
            if (dist > 2) {
              gasser.npc.lookAtTarget = corpse.state.position;
              if (moveToward(gasser.npc, corpse.state.position, gasser.server)) {
                applyAgitation(gasser);
              } else {
                gasser.npc.setSpeed(0);
              }
              return;
            }
            gasser.npc.lookAtTarget = null;
            gasser.npc.stopMovement();
          }
        }

        if (!gasser.isEatingCorpse) {
          gasser.npc.setSpeed(0);
          // wait for the nav agent to fully decelerate before starting the anim
          const vel = gasser.npc.navAgent?.velocity();
          const speed = vel ? Math.sqrt(vel.x * vel.x + vel.z * vel.z) : 0;
          if (speed > 0.0) return;
          gasser.npc.setAnimation(ZombieLoopingAnim.Eating);
          gasser.isEatingCorpse = true;
          gasser.stateTimer = 0;
        } else {
          gasser.npc.setSpeed(0);
        }

        gasser.hunger = Math.max(0, gasser.hunger - dt * 15);
        if (gasser.hunger === 0) {
          gasser.npc.playAnimation(ZombieOneshotAnim.EatingDone);
          gasser.corpseTargetId = null;
          gasser.isEatingCorpse = false;
          gasser.event(ZombieEvents.DoneFeeding);
        }
      }
    },
    [
      {
        eventId: ZombieEvents.HearNoise,
        from: [
          ZombieTransitions.Wander,
          ZombieTransitions.Idle,
          ZombieTransitions.Investigate,
          ZombieTransitions.Chase,
          ZombieTransitions.Stumble,
          ZombieTransitions.Attack,
          ZombieTransitions.Attacking,
          ZombieTransitions.Feed
        ],
        to: ZombieTransitions.Investigate,
        EnterTransition: () => {
          gasser.stateTimer = 0;
          gasser.npc.setLocomotionMode?.("walk");
          gasser.targetCharacterId = null;
          gasser.npc.setLookAtCharacter?.(null);
          gasser.corpseTargetId = null;
          gasser.isEatingCorpse = false;
          gasser.npc.lookAtTarget = null;
          gasser.npc.setLookAtCharacter?.(null);
          gasser.targetPos = gasser.lastNoisePos;
          if (gasser.targetPos) {
            if (!moveToward(gasser.npc, gasser.targetPos, gasser.server)) {
              gasser.targetPos = null;
              gasser.npc.setSpeed(0);
            } else {
              applyAgitation(gasser);
            }
          }
        }
      },
      {
        eventId: ZombieEvents.SeePlayer,
        from: [
          ZombieTransitions.Wander,
          ZombieTransitions.Investigate,
          ZombieTransitions.Idle
        ],
        to: ZombieTransitions.Chase,
        EnterTransition: () => {
          gasser.npc.setCombatAnimationMode?.(true);
          gasser.npc.setLocomotionMode?.("sprint");
          const chaseTarget = getChaseTarget(gasser);
          if (chaseTarget) {
            gasser.npc.setLookAtCharacter?.(gasser.targetCharacterId);
            if (moveToward(gasser.npc, chaseTarget.position, gasser.server)) {
              applyAgitation(gasser);
            }
          }
        }
      },
      {
        eventId: ZombieEvents.SmellCorpse,
        from: [
          ZombieTransitions.Wander,
          ZombieTransitions.Idle,
          ZombieTransitions.Investigate,
          ZombieTransitions.Chase
        ],
        to: ZombieTransitions.Feed,
        EnterTransition: () => enterFeed(gasser)
      },
      {
        eventId: ZombieEvents.NoiseTimeout,
        from: [ZombieTransitions.Investigate],
        to: ZombieTransitions.Wander,
        EnterTransition: () => enterWander(gasser)
      },
      {
        eventId: ZombieEvents.ReachPlayer,
        from: [ZombieTransitions.Chase],
        to: ZombieTransitions.Attack,
        EnterTransition: () => {
          gasser.npc.stopMovement();
          gasser.npc.setLocomotionMode?.("walk");
          gasser.lastAttackTime = 2;
        }
      },
      {
        eventId: ZombieEvents.StartStumble,
        from: [ZombieTransitions.Chase],
        to: ZombieTransitions.Stumble,
        EnterTransition: () => {
          gasser.npc.stopMovement();
          gasser.npc.setLocomotionMode?.("walk");
          gasser.stateTimer = 0;
          const anims: Array<
            | ZombieOneshotAnim.StumbleA
            | ZombieOneshotAnim.StumbleB
            | ZombieOneshotAnim.StumbleC
          > = [
            ZombieOneshotAnim.StumbleA,
            ZombieOneshotAnim.StumbleB,
            ZombieOneshotAnim.StumbleC
          ];
          const selected = anims[Math.floor(Math.random() * anims.length)];
          gasser.stumbleAnimation = selected;
          gasser.npc.playAnimation(selected);
        }
      },
      {
        eventId: ZombieEvents.StumbleTimeout,
        from: [ZombieTransitions.Stumble],
        to: ZombieTransitions.Chase,
        EnterTransition: () => {
          gasser.stateTimer = 0;
          gasser.stumbleAnimation = undefined;
          gasser.npc.setCombatAnimationMode?.(true);
          gasser.npc.setLocomotionMode?.("sprint");
          const chaseTarget = getChaseTarget(gasser);
          if (chaseTarget) {
            gasser.npc.setLookAtCharacter?.(gasser.targetCharacterId);
            if (moveToward(gasser.npc, chaseTarget.position, gasser.server)) {
              applyAgitation(gasser);
            }
          }
        }
      },
      {
        eventId: ZombieEvents.StartAttacking,
        from: [ZombieTransitions.Attack],
        to: ZombieTransitions.Attacking,
        EnterTransition: () => {
          attackAction = "melee";
          gasStaggerStarted = false;
          gasser.npc.stopMovement();
          gasser.npc.setLocomotionMode?.("walk");
          const target = getChaseTarget(gasser);
          gasser.attackForward = target
            ? getAttackForward(gasser.npc, target.position)
            : null;
          gasser.attackDamageApplied = false;
          gasser.attackEnvelopeWasActive = false;
          gasser.npc.playAnimation(ZombieOneshotAnim.KnifeSlash);
          gasser.stateTimer = 0;
          gasser.lastAttackTime = 0;
        }
      },
      {
        eventId: ZombieEvents.Spit,
        from: [ZombieTransitions.Attack],
        to: ZombieTransitions.Attacking,
        EnterTransition: () => {
          attackAction = "spit";
          gasStaggerStarted = false;
          gasser.attackForward = null;
          gasser.attackDamageApplied = false;
          gasser.attackEnvelopeWasActive = false;
          gasser.npc.stopMovement();
          gasser.npc.setLocomotionMode?.("walk");
          gasser.npc.playAnimation(ZombieOneshotAnim.Spit);
          gasser.stateTimer = 0;
          gasser.lastAttackTime = 0;
        }
      },
      {
        eventId: ZombieEvents.ReleaseGas,
        from: [ZombieTransitions.Attack],
        to: ZombieTransitions.Attacking,
        EnterTransition: () => {
          attackAction = "gas";
          gasser.attackForward = null;
          gasser.attackDamageApplied = false;
          gasser.attackEnvelopeWasActive = false;
          gasser.npc.stopMovement();
          gasser.npc.setLocomotionMode?.("walk");
          gasser.npc.lookAtTarget = null;
          gasser.npc.setLookAtCharacter?.(null);
          gasser.npc.playAnimation(ZombieOneshotAnim.GasConvulse);
          spawnGasCloud(gasser);
          gasStaggerStarted = false;
          gasser.ChargeGas = 0;
          gasser.stateTimer = 0;
          gasser.lastAttackTime = 2;
        }
      },
      {
        eventId: ZombieEvents.DoneAttacking,
        from: [ZombieTransitions.Attacking],
        to: ZombieTransitions.Attack,
        EnterTransition: () => {
          gasser.attackForward = null;
          gasser.attackDamageApplied = false;
          gasser.attackEnvelopeWasActive = false;
          gasStaggerStarted = false;
          // Spit/GasConvulse and KnifeSlash are all one-shot graph events.
          // Their shared Attacking state must end on a persistent reset rather
          // than leaving the last action pose latched for current observers.
          gasser.npc.setAnimation(ZombieLoopingAnim.Idle);
          gasser.lastAttackTime = 2;
        }
      },
      {
        eventId: ZombieEvents.LostPlayer,
        from: [
          ZombieTransitions.Chase,
          ZombieTransitions.Attack,
          ZombieTransitions.Stumble
        ],
        to: ZombieTransitions.Wander,
        EnterTransition: () => enterWander(gasser)
      },
      {
        eventId: ZombieEvents.PlayerBacked,
        from: [ZombieTransitions.Attack],
        to: ZombieTransitions.Chase,
        EnterTransition: () => {
          gasser.npc.setCombatAnimationMode?.(true);
          gasser.npc.setLocomotionMode?.("sprint");
          const chaseTarget = getChaseTarget(gasser);
          if (chaseTarget) {
            gasser.npc.setLookAtCharacter?.(gasser.targetCharacterId);
            if (moveToward(gasser.npc, chaseTarget.position, gasser.server)) {
              applyAgitation(gasser);
            }
          }
        }
      },
      {
        eventId: ZombieEvents.PlayerKilled,
        from: [ZombieTransitions.Attack],
        to: ZombieTransitions.Feed,
        EnterTransition: () => enterFeed(gasser)
      },
      {
        eventId: ZombieEvents.DoneFeeding,
        from: [ZombieTransitions.Feed],
        to: ZombieTransitions.Wander,
        EnterTransition: () => enterWander(gasser)
      },
      {
        eventId: ZombieEvents.IdleTimeout,
        from: [ZombieTransitions.Wander],
        to: ZombieTransitions.Idle,
        EnterTransition: () => {
          gasser.stateTimer = 0;
          gasser.npc.stopMovement();
          gasser.npc.setAnimation(ZombieLoopingAnim.Idle);
        }
      },
      {
        eventId: ZombieEvents.CoverEars,
        from: null,
        to: ZombieTransitions.Wander,
        EnterTransition: () => {
          gasser.npc.stopMovement();
          gasser.npc.playAnimation(ZombieOneshotAnim.CoverEars);
          gasser.isCoveringEars = true;
          gasser.coverEarsTimer = 0;
          gasser.targetCharacterId = null;
          gasser.npc.setLookAtCharacter?.(null);
          gasser.npc.lookAtTarget = null;
          gasser.wanderOrigin =
            gasser.npc.state.position.slice() as Float32Array;
        }
      }
    ],
    ZombieTransitions.Wander
  ) as unknown as ZombieInstance;

  gasser.onTransition = (from: string, to: string, eventId: string) => {
    debug(`[${gasser.id}] ${from} → ${to} (${eventId})`);
    debug(`  Position: ${gasser.npc.state.position.join(", ")}`);
    debug(`  Agitation: ${gasser.agitation}`);
    debug(`  Hunger: ${gasser.hunger}`);
    debug(`  ChargeGas: ${gasser.ChargeGas}`);
  };
  gasser.id = npc.characterId;
  gasser.npc = npc;
  gasser.server = server;
  gasser.npc.initializeAnimation?.(ZombieLoopingAnim.Idle);
  gasser.hunger = 0;
  gasser.agitation = AGITATION_INITIAL;
  // Configure the initial patrol before requesting its target.  Do not publish
  // a walk speed until Recast accepts the target, so an off-mesh spawn stays
  // in a standing graph instead of running in place for one observer frame.
  gasser.npc.setLocomotionMode?.("walk");
  gasser.wanderOrigin = npc.state.position.slice() as Float32Array;
  const initialPatrol = pickPatrolPoint(server, npc.state.position);
  gasser.targetPos = initialPatrol;
  if (initialPatrol) {
    if (moveToward(npc, initialPatrol, server)) {
      applyAgitation(gasser);
    } else {
      gasser.targetPos = null;
      npc.setSpeed(0);
    }
  } else {
    npc.setSpeed(0);
  }
  gasser.lastNoisePos = null;
  gasser.targetCharacterId = null;
  gasser.attackForward = null;
  gasser.attackDamageApplied = false;
  gasser.attackEnvelopeWasActive = false;
  gasStaggerStarted = false;
  gasser.corpseTargetId = null;
  gasser.isEatingCorpse = false;
  gasser.stateTimer = 0;
  gasser.lastAttackTime = 0;
  gasser.isCoveringEars = false;
  gasser.coverEarsTimer = 0;
  gasser.ChargeGas = 100;

  return gasser;
}
