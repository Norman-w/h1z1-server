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
import { isHostile } from "./factions";

export const enum ZombieLoopingAnim {
  Idle = "Idle",
  idle = "idle",
  Eating = "Eating",
  FakeRagdoll = "FakeRagdoll",
  Alive = "Alive",
  DeathPose = "DeathPose",
  StopPhysics = "StopPhysics",
  TrueAnimation = "TrueAnimation",
  FalseAnimation = "FalseAnimation",
  StuckBehindFence = "StuckBehindFence",
  StuckBehindFenceReaching = "StuckBehindFenceReaching",
  StuckBehindObjectTall = "StuckBehindObjectTall",
  StuckBehindObjectShort = "StuckBehindObjectShort"
}

export const enum ZombieOneshotAnim {
  Flinch = "Flinch",
  Death = "Death",
  EatingDone = "EatingDone",
  DeathRagdoll = "DeathRagdoll",
  KnifeSlash = "KnifeSlash",
  MeleeFlinch = "MeleeFlinch",
  TurnLeft90 = "TurnLeft90",
  TurnRight90 = "TurnRight90",
  LostTarget = "LostTarget",
  GrappleTell = "GrappleTell",
  TurnLeft45 = "TurnLeft45",
  TurnRight45 = "TurnRight45",
  TurnRight180 = "TurnRight180",
  TurnLeft180 = "TurnLeft180",
  PushbackNorthMedium = "PushbackNorthMedium",
  PushbackEastMedium = "PushbackEastMedium",
  PushbackWestMedium = "PushbackWestMedium",
  PushbackSouthMedium = "PushbackSouthMedium",
  BlowbackNorth = "BlowbackNorth",
  FallOverFence = "FallOverFence",
  GetUp = "GetUp",
  Stun = "Stun",
  DeathRagdollAnywhere = "DeathRagdollAnywhere",
  StumbleA = "StumbleA",
  StumbleB = "StumbleB",
  StumbleC = "StumbleC",
  ExplodeContract = "ExplodeContract",
  ExplodeExpand = "ExplodeExpand",
  GasConvulse = "GasConvulse",
  Spawn = "Spawn",
  SpawnFromGround = "SpawnFromGround",
  Spit = "Spit",
  CoverEars = "CoverEars",
  CoverEarsDone = "CoverEarsDone",
  Stagger_Light = "Stagger_Light",
  Stagger_Medium = "Stagger_Medium",
  Stagger_Heavy = "Stagger_Heavy"
}

export const enum ZombieTransitions {
  Idle = "idle",
  Wander = "wander",
  Investigate = "investigate",
  Chase = "chase",
  Stumble = "stumble",
  Attack = "attack",
  Attacking = "attacking",
  Feed = "feed"
}

export const enum ZombieEvents {
  HearNoise = "hearNoise",
  SeePlayer = "seePlayer",
  SmellCorpse = "smellCorpse",
  NoiseTimeout = "noiseTimeout",
  ReachPlayer = "reachPlayer",
  LostPlayer = "lostPlayer",
  PlayerBacked = "playerBacked",
  PlayerKilled = "playerKilled",
  DoneFeeding = "doneFeeding",
  IdleTimeout = "idleTimeout",
  StartAttacking = "startAttacking",
  Spit = "spit",
  DoneAttacking = "doneAttacking",
  StartStumble = "startStumble",
  StumbleTimeout = "stumbleTimeout",
  CoverEars = "coverEars",
  ReleaseGas = "releaseGas"
}

export interface ZombieInstance extends JSM<ZombieEvents> {
  id: string;
  state: ZombieTransitions;
  hunger: number;
  agitation: number;
  targetPos: Float32Array | null;
  lastNoisePos: Float32Array | null;
  stateTimer: number;
  targetCharacterId: string | null;
  /** Horizontal direction captured when the current melee swing starts. */
  attackForward: [number, number] | null;
  /** A Zombie001 swing may authorize one server-side contact at most once. */
  attackDamageApplied: boolean;
  /** Last sampled strike-envelope result for a coarse tick crossing contact. */
  attackEnvelopeWasActive: boolean;
  /** The exact stumble clip selected for this recovery state. */
  stumbleAnimation?:
    | ZombieOneshotAnim.StumbleA
    | ZombieOneshotAnim.StumbleB
    | ZombieOneshotAnim.StumbleC;
  corpseTargetId: string | null;
  isEatingCorpse: boolean;
  lastAttackTime: number;
  wanderOrigin: Float32Array;
  isCoveringEars: boolean;
  ChargeGas: number;
  coverEarsTimer: number;
  npc: Npc;
  server: ZoneServer2016;
}

const BASE_SPEED = 1.0;
const MAX_SPEED = 4.0;
const AGITATION_DECAY_RATE = 1;
const AGITATION_INITIAL = 50;
const INVESTIGATE_TIMEOUT = 120;
const STUMBLE_CHANCE = 0.001;
const OVERRIDE_ACTION_SOUND_PRIORITY = 10;

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
    // Callers historically set agitation/locomotion before requesting a
    // target.  A missing agent must therefore clear that intent itself or a
    // zombie can advertise sprint while its position remains stationary.
    npc.setLocomotionMode?.("walk");
    npc.stopMovement();
    return false;
  }
  try {
    const navTarget = server.navManager.getClosestNavPointVec3(target);
    if (npc.navAgent.requestMoveTarget(navTarget) === false) {
      // Recast explicitly rejected the target; keep the client in a standing
      // graph until a later AI tick can install a real path.
      npc.setLocomotionMode?.("walk");
      npc.stopMovement();
      return false;
    }
  } catch {
    // Projection can fail for an off-mesh/disconnected target.  Clear the
    // previously published speed before returning the failure to the FSM.
    npc.setLocomotionMode?.("walk");
    npc.stopMovement();
    return false;
  }
  return true;
}

function listenToSounds(zombie: ZombieInstance, sounds: Sound[]): Sound | null {
  let nearest: Sound | null = null;
  let nearestDist = Infinity;
  let bestPriority = Number.NEGATIVE_INFINITY;
  for (const sound of sounds) {
    const dist = getDistance2d(zombie.npc.state.position, sound.position);
    if (dist < sound.radius) {
      zombie.agitation = Math.min(100, zombie.agitation + sound.agitation);
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

function shouldOverrideAction(sound: Sound | null): boolean {
  if (!sound) return false;
  return (sound.priority ?? 0) >= OVERRIDE_ACTION_SOUND_PRIORITY;
}

function trySeePlayer(zombie: ZombieInstance): boolean {
  const sz = 50;
  const pos = zombie.npc.state.position;
  const cx = Math.floor(pos[0] / sz);
  const cz = Math.floor(pos[2] / sz);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const bucket = zombie.server.aiTargetSpatialMap.get(
        `${cx + dx},${cz + dz}`
      );
      if (!bucket) continue;
      for (const entry of bucket) {
        if (entry.id === zombie.npc.characterId) continue;
        if (!isHostile(zombie.npc.faction, entry.faction)) continue;
        if (getDistance2d(pos, entry.position) < 10) {
          zombie.targetCharacterId = entry.id;
          zombie.event(ZombieEvents.SeePlayer);
          return true;
        }
      }
    }
  }
  return false;
}

function trySmellCorpse(zombie: ZombieInstance): boolean {
  if (zombie.hunger < 60) return false;
  for (const client of zombie.server.getClientsInRange(
    zombie.npc.state.position,
    30
  )) {
    if (client.character.isAlive) continue;
    zombie.corpseTargetId = client.character.characterId;
    zombie.event(ZombieEvents.SmellCorpse);
    return true;
  }
  return false;
}

function getChaseTarget(zombie: ZombieInstance): {
  position: Float32Array;
  isAlive: boolean;
  isVanished: boolean;
  isHidden: boolean;
} | null {
  if (!zombie.targetCharacterId) return null;
  const player = zombie.server._characters[zombie.targetCharacterId];
  if (player)
    return {
      position: player.state.position,
      isAlive: player.isAlive,
      isVanished: !!player.isVanished,
      isHidden: !!player.isHidden
    };
  const npc = zombie.server._npcs[zombie.targetCharacterId];
  if (npc)
    return {
      position: npc.state.position,
      isAlive: npc.isAlive,
      isVanished: false,
      isHidden: false
    };
  return null;
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
    // NPC-origin melee contacts use the same presentation-aware hook as
    // player/projectile hits.  Calling damage() directly only changes health
    // and leaves the victim's native locomotion/attack pose untouched.
    if (typeof targetNpc.applyNpcMeleeHit === "function") {
      targetNpc.applyNpcMeleeHit(zombie.server, damageInfo);
    } else {
      // Keep lightweight AI doubles compatible with the old health-only path.
      targetNpc.damage(zombie.server, damageInfo);
    }
  }
}

function getMeleeRange(zombie: ZombieInstance): number {
  return zombie.npc.getMeleeAttackRange?.(2) ?? 2;
}

function getMeleeAttackDuration(zombie: ZombieInstance): number {
  return zombie.npc.getMeleeAttackAnimationDuration?.(1) ?? 1;
}

/**
 * The Stumble FSM must finish on the selected source clip, not on a generic
 * five-second AI timeout.  Production Npc instances own an activeAnimation
 * field; old lightweight fixtures do not, so retain their historical
 * timeout fallback without treating an overridden `isAnimationActive()` as
 * proof that a native clock is available.
 */
export function shouldFinishZombieStumble(zombie: ZombieInstance): boolean {
  if (!Object.prototype.hasOwnProperty.call(zombie.npc, "activeAnimation")) {
    return zombie.stateTimer >= 5;
  }
  const selected = zombie.stumbleAnimation;
  if (!selected) return zombie.stateTimer >= 5;
  const clipActive = zombie.npc.isAnimationActive?.(selected) ?? false;
  return zombie.stateTimer >= 0.25 && !clipActive;
}

/**
 * Recovery one-shots own the graph after an action state has logically
 * finished.  Starting a patrol on the same tick as EatingDone/CoverEarsDone
 * makes the server advertise locomotion while the client is still rendering
 * the recovery pose, which is another form of post-action slide.
 */
function isZombieRecoveryAnimationActive(zombie: ZombieInstance): boolean {
  const active = zombie.npc.getAnimationRuntimeState?.().activeAnimation;
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

function tickTimers(zombie: ZombieInstance, dt: number): void {
  zombie.hunger = Math.min(100, zombie.hunger + dt * 2);
  zombie.stateTimer += dt;
  zombie.lastAttackTime += dt;
}

function enterWander(zombie: ZombieInstance): void {
  // Returning from chase/attack/investigation must clear the old desired
  // velocity before advertising the normal walk graph.
  zombie.npc.stopMovement();
  zombie.stateTimer = 0;
  zombie.agitation = AGITATION_INITIAL;
  zombie.targetCharacterId = null;
  zombie.attackForward = null;
  zombie.npc.setCombatAnimationMode?.(false);
  zombie.npc.setLookAtCharacter?.(null);
  zombie.npc.setLocomotionMode?.("walk");
  // EatingDone/CoverEarsDone can still own the client graph when the FSM
  // enters Wander.  Queue the persistent reset now so the expiry handoff
  // cannot fall back to the old Eating/cover pose.
  zombie.npc.setAnimation(ZombieLoopingAnim.Idle);
  zombie.npc.lookAtTarget = null;
  zombie.wanderOrigin = zombie.npc.state.position.slice() as Float32Array;
  zombie.targetPos = null;
  if (isZombieRecoveryAnimationActive(zombie)) {
    // The next Wander tick will install a patrol after the recovery clock has
    // expired.  Keep both the nav agent and the client gait stopped meanwhile.
    zombie.npc.setSpeed(0);
    return;
  }
  const pt = pickPatrolPoint(zombie.server, zombie.wanderOrigin);
  if (pt) {
    zombie.targetPos = pt;
    if (moveToward(zombie.npc, pt, zombie.server)) {
      applyAgitation(zombie);
    } else {
      zombie.targetPos = null;
      zombie.npc.setSpeed(0);
    }
  } else {
    zombie.npc.setSpeed(0);
  }
}

function enterFeed(zombie: ZombieInstance): void {
  zombie.npc.stopMovement();
  zombie.npc.setCombatAnimationMode?.(false);
  zombie.npc.setLocomotionMode?.("walk");
  zombie.stateTimer = 0;
  zombie.targetCharacterId = null;
  zombie.attackForward = null;
  zombie.npc.setLookAtCharacter?.(null);
  zombie.npc.lookAtTarget = null;
  zombie.isEatingCorpse = false;
}

function applyAgitation(zombie: ZombieInstance) {
  const speed =
    BASE_SPEED + (zombie.agitation / 100) * (MAX_SPEED - BASE_SPEED);
  zombie.npc.setSpeed(speed);
}
function decayAgitation(zombie: ZombieInstance, dt: number) {
  zombie.agitation = Math.max(0, zombie.agitation - AGITATION_DECAY_RATE * dt);
}

export function createZombie(npc: Npc, server: ZoneServer2016): ZombieInstance {
  const zombie = new JSM(
    {
      [ZombieTransitions.Wander]: (dt: number) => {
        if (zombie.isCoveringEars) {
          zombie.coverEarsTimer += dt;
          const coverEarsClipActive =
            zombie.npc.isAnimationActive?.(ZombieOneshotAnim.CoverEars) ??
            false;
          if (zombie.coverEarsTimer >= 3 && !coverEarsClipActive) {
            zombie.isCoveringEars = false;
            zombie.npc.playAnimation(ZombieOneshotAnim.CoverEarsDone);
            if (zombie.lastNoisePos) {
              // swarm toward where the scream came from
              zombie.stateTimer = 0;
              zombie.agitation = 100;
              zombie.targetPos = zombie.lastNoisePos;
              zombie.event(ZombieEvents.HearNoise);
            } else {
              enterWander(zombie);
            }
          }
          return;
        }

        if (isZombieRecoveryAnimationActive(zombie)) {
          zombie.npc.stopMovement();
          zombie.npc.setLocomotionMode?.("walk");
          zombie.npc.setSpeed(0);
          return;
        }

        tickTimers(zombie, dt);

        if (trySeePlayer(zombie)) return;
        if (trySmellCorpse(zombie)) return;

        const nearestSound = listenToSounds(zombie, zombie.server.sounds);
        if (nearestSound) {
          zombie.lastNoisePos = nearestSound.position;
          zombie.event(ZombieEvents.HearNoise);
          return;
        }

        decayAgitation(zombie, dt);

        if (zombie.agitation === 0) {
          zombie.event(ZombieEvents.IdleTimeout);
          return;
        }

        const arrived =
          zombie.targetPos != null &&
          getDistance2d(zombie.npc.state.position, zombie.targetPos) < 3;

        if (arrived || zombie.targetPos == null) {
          const pt = pickPatrolPoint(zombie.server, zombie.wanderOrigin);
          if (pt) {
            zombie.targetPos = pt;
            if (!moveToward(zombie.npc, pt, zombie.server)) {
              zombie.targetPos = null;
              zombie.npc.setSpeed(0);
            } else {
              applyAgitation(zombie);
            }
          } else {
            zombie.targetPos = null;
            zombie.npc.stopMovement();
          }
        } else {
          // A positive ExpectedSpeed is valid only while the previously
          // accepted Recast target is still active. New patrol targets use
          // the guarded branch above so a rejected request cannot advertise
          // a run-in-place frame.
          applyAgitation(zombie);
        }
      },

      [ZombieTransitions.Idle]: (dt: number) => {
        tickTimers(zombie, dt);

        if (trySeePlayer(zombie)) return;

        const nearestSound = listenToSounds(zombie, zombie.server.sounds);
        if (nearestSound) {
          zombie.lastNoisePos = nearestSound.position;
          zombie.event(ZombieEvents.HearNoise);
          return;
        }

        trySmellCorpse(zombie);
      },

      [ZombieTransitions.Investigate]: (dt: number) => {
        tickTimers(zombie, dt);
        zombie.npc.setCombatAnimationMode?.(false);
        zombie.npc.setLocomotionMode?.("walk");

        if (trySeePlayer(zombie)) return;
        if (trySmellCorpse(zombie)) return;

        if (zombie.stateTimer >= INVESTIGATE_TIMEOUT) {
          zombie.event(ZombieEvents.NoiseTimeout);
          return;
        }

        if (
          zombie.lastNoisePos != null &&
          getDistance2d(zombie.npc.state.position, zombie.lastNoisePos) < 3
        ) {
          zombie.event(ZombieEvents.NoiseTimeout);
          return;
        }

        if (zombie.targetPos != null) {
          applyAgitation(zombie);
        } else {
          zombie.npc.setSpeed(0);
        }

        const nearestSound = listenToSounds(zombie, zombie.server.sounds);
        if (nearestSound) {
          zombie.lastNoisePos = nearestSound.position;
          if (shouldOverrideAction(nearestSound)) {
            zombie.event(ZombieEvents.HearNoise);
            return;
          }
          zombie.stateTimer = 0;
          zombie.targetPos = nearestSound.position;
          if (!moveToward(zombie.npc, zombie.targetPos, zombie.server)) {
            zombie.targetPos = null;
            zombie.npc.setSpeed(0);
          } else {
            applyAgitation(zombie);
          }
        }
      },

      [ZombieTransitions.Chase]: (dt: number) => {
        tickTimers(zombie, dt);
        zombie.npc.setCombatAnimationMode?.(true);
        zombie.npc.setLocomotionMode?.("sprint");
        const nearestSound = listenToSounds(zombie, zombie.server.sounds);
        if (nearestSound && shouldOverrideAction(nearestSound)) {
          zombie.lastNoisePos = nearestSound.position;
          zombie.event(ZombieEvents.HearNoise);
          return;
        }
        const chaseTarget = getChaseTarget(zombie);
        if (
          !chaseTarget ||
          !chaseTarget.isAlive ||
          chaseTarget.isVanished ||
          chaseTarget.isHidden
        ) {
          zombie.event(ZombieEvents.LostPlayer);
          return;
        }
        // The position target drives server steering, while the GUID binding
        // feeds the client's native head/turn branch.  Keeping both inputs in
        // sync prevents a chase from using a stale/default animation target
        // after a lightweight-to-full observer handoff.
        zombie.npc.setLookAtCharacter?.(zombie.targetCharacterId);

        const chaseDist = getDistance2d(
          zombie.npc.state.position,
          chaseTarget.position
        );
        const meleeRange = getMeleeRange(zombie);
        if (chaseDist > 50) {
          zombie.event(ZombieEvents.LostPlayer);
        } else if (chaseDist < meleeRange) {
          zombie.event(ZombieEvents.ReachPlayer);
        } else {
          if (trySmellCorpse(zombie)) return;
          if (Math.random() < STUMBLE_CHANCE) {
            zombie.event(ZombieEvents.StartStumble);
            return;
          }
          if (!moveToward(zombie.npc, chaseTarget.position, zombie.server)) {
            zombie.npc.setSpeed(0);
          } else {
            applyAgitation(zombie);
          }
        }
      },

      [ZombieTransitions.Stumble]: (dt: number) => {
        zombie.npc.setCombatAnimationMode?.(false);
        zombie.npc.setLocomotionMode?.("walk");
        const nearestSound = listenToSounds(zombie, zombie.server.sounds);
        if (nearestSound && shouldOverrideAction(nearestSound)) {
          zombie.lastNoisePos = nearestSound.position;
          zombie.event(ZombieEvents.HearNoise);
          return;
        }
        zombie.stateTimer += dt;
        if (shouldFinishZombieStumble(zombie)) {
          zombie.event(ZombieEvents.StumbleTimeout);
        }
      },

      [ZombieTransitions.Attack]: (dt: number) => {
        tickTimers(zombie, dt);
        zombie.npc.setCombatAnimationMode?.(true);
        const nearestSound = listenToSounds(zombie, zombie.server.sounds);
        if (nearestSound && shouldOverrideAction(nearestSound)) {
          zombie.lastNoisePos = nearestSound.position;
          zombie.event(ZombieEvents.HearNoise);
          return;
        }
        const attackTarget = getChaseTarget(zombie);
        if (!attackTarget || !attackTarget.isAlive) {
          if (zombie.hunger >= 30) {
            zombie.event(ZombieEvents.PlayerKilled);
          } else {
            zombie.event(ZombieEvents.LostPlayer);
          }
          return;
        }
        if (attackTarget.isVanished || attackTarget.isHidden) {
          zombie.event(ZombieEvents.LostPlayer);
          return;
        }
        zombie.npc.setLookAtCharacter?.(zombie.targetCharacterId);
        zombie.npc.lookAtTarget = attackTarget.position;
        // Range is only the outer reach.  Turn in place while waiting for the
        // target to enter the configured weapon strike envelope so a slash
        // cannot begin beside the player.
        zombie.npc.lookAt(attackTarget.position, dt);
        const attackDist = getDistance(
          zombie.npc.state.position,
          attackTarget.position
        );
        const meleeRange = getMeleeRange(zombie);
        if (attackDist >= meleeRange) {
          // Only the closing branch may advertise a non-zero chase speed.
          // Once inside the strike envelope, stopMovement() below owns the
          // zero-speed edge for the attack graph; applying agitation before
          // that call would alternate ExpectedSpeed between run and zero on
          // every AI tick and reintroduce the visible pre-swing slide.
          zombie.npc.setLocomotionMode?.("sprint");
          if (moveToward(zombie.npc, attackTarget.position, zombie.server)) {
            applyAgitation(zombie);
            zombie.event(ZombieEvents.PlayerBacked);
          } else {
            zombie.npc.setSpeed(0);
          }
        } else {
          // Combat idle is the state immediately before the slash.  Do not
          // leave the sprint intent/nav target active while the strike timer
          // is waiting, otherwise the client can slide into the hit pose.
          zombie.npc.setLocomotionMode?.("walk");
          zombie.npc.stopMovement();
          const inStrikeEnvelope =
            zombie.npc.isMeleeTargetInEnvelope?.(attackTarget.position) ?? true;
          const unobstructed =
            zombie.npc.hasMeleeLineOfSight?.(attackTarget.position) ?? true;
          if (zombie.lastAttackTime > 2 && inStrikeEnvelope && unobstructed)
            zombie.event(ZombieEvents.StartAttacking);
        }
      },

      [ZombieTransitions.Attacking]: (dt: number) => {
        const stateTimerBefore = zombie.stateTimer;
        zombie.hunger = Math.min(100, zombie.hunger + dt * 2);
        zombie.stateTimer += dt;
        zombie.lastAttackTime += dt;
        zombie.npc.setCombatAnimationMode?.(true);

        // KnifeSlash is an in-flight one-shot.  A high-priority sound may
        // change the next decision, but it must not pre-empt this state and
        // install a new nav target while the swing is still in its contact
        // window.  The completed action returns to Attack, where the next
        // tick can consume the sound normally.

        const attackTarget = getChaseTarget(zombie);

        if (attackTarget && zombie.targetCharacterId) {
          zombie.npc.setLookAtCharacter?.(zombie.targetCharacterId);
        }

        const attackDuration = getMeleeAttackDuration(zombie);
        const contactWindow = zombie.npc.getMeleeContactWindow?.();
        const contactStart = contactWindow
          ? attackDuration * contactWindow.startFraction
          : attackDuration;
        const contactEnd = contactWindow
          ? attackDuration * contactWindow.endFraction
          : attackDuration;
        // The server state timer is only an authorization window.  The
        // client-facing KnifeSlash one-shot must still be live when that
        // window is sampled; a reaction that replaced it cancels this swing.
        const attackClipState = zombie.npc.isAnimationActive?.(
          ZombieOneshotAnim.KnifeSlash
        );
        // SwingContact is a discrete native event.  A server tick can jump
        // across it, so authorize the interval when the sample crosses the
        // recovered window, but never after the one-shot has ended.
        const contactActive =
          (attackClipState ?? true) &&
          stateTimerBefore < attackDuration &&
          stateTimerBefore <= contactEnd &&
          zombie.stateTimer >= contactStart;
        if (!zombie.attackDamageApplied && contactActive) {
          if (
            attackTarget?.isAlive &&
            !attackTarget.isVanished &&
            !attackTarget.isHidden
          ) {
            const attackDist = getDistance(
              zombie.npc.state.position,
              attackTarget.position
            );
            const meleeRange = getMeleeRange(zombie);
            const facingTarget = isFacingTarget(
              zombie.npc.state.position,
              zombie.npc.state.yaw ?? 0,
              attackTarget.position
            );
            const inStrikeEnvelope =
              zombie.npc.isMeleeTargetInEnvelope?.(
                attackTarget.position,
                zombie.npc.state.position,
                zombie.attackForward ?? undefined
              ) ??
              (attackDist <= meleeRange && facingTarget);
            const unobstructed =
              zombie.npc.hasMeleeLineOfSight?.(attackTarget.position) ?? true;
            const crossedContactEnd =
              stateTimerBefore < contactEnd && zombie.stateTimer > contactEnd;
            if (
              inStrikeEnvelope &&
              unobstructed &&
              (!crossedContactEnd || zombie.attackEnvelopeWasActive)
            ) {
              applyDamageToTarget(zombie);
              zombie.attackDamageApplied = true;
            }
            zombie.attackEnvelopeWasActive = inStrikeEnvelope;
          } else {
            zombie.attackEnvelopeWasActive = false;
          }
        } else if (attackTarget?.isAlive) {
          const attackDist = getDistance(
            zombie.npc.state.position,
            attackTarget.position
          );
          const meleeRange = getMeleeRange(zombie);
          const facingTarget = isFacingTarget(
            zombie.npc.state.position,
            zombie.npc.state.yaw ?? 0,
            attackTarget.position
          );
          zombie.attackEnvelopeWasActive =
            zombie.npc.isMeleeTargetInEnvelope?.(
              attackTarget.position,
              zombie.npc.state.position,
              zombie.attackForward ?? undefined
            ) ?? (attackDist <= meleeRange && facingTarget);
        } else {
          zombie.attackEnvelopeWasActive = false;
        }

        if (
          zombie.stateTimer >= attackDuration &&
          !(attackClipState ?? false)
        ) {
          zombie.event(ZombieEvents.DoneAttacking);
        }
      },

      [ZombieTransitions.Feed]: (dt: number) => {
        zombie.stateTimer += dt;
        zombie.lastAttackTime += dt;
        zombie.npc.setCombatAnimationMode?.(false);
        zombie.npc.setLocomotionMode?.("walk");
        const nearestSound = listenToSounds(zombie, zombie.server.sounds);
        if (nearestSound && shouldOverrideAction(nearestSound)) {
          zombie.lastNoisePos = nearestSound.position;
          zombie.event(ZombieEvents.HearNoise);
          return;
        }

        if (zombie.corpseTargetId) {
          const corpse = zombie.server._characters[zombie.corpseTargetId];
          if (!corpse || corpse.isAlive) {
            zombie.corpseTargetId = null;
            zombie.isEatingCorpse = false;
            zombie.event(ZombieEvents.DoneFeeding);
            return;
          }
          if (!zombie.isEatingCorpse) {
            const dist = getDistance2d(
              zombie.npc.state.position,
              corpse.state.position
            );
            if (dist > 2) {
              // Feeding is an action state, but the approach to a corpse is
              // still locomotion.  Re-apply the agitation speed only on this
              // branch; once the zombie reaches the corpse, ExpectedSpeed
              // must stay zero while Eating owns the pose.
              zombie.npc.lookAtTarget = corpse.state.position;
              if (moveToward(zombie.npc, corpse.state.position, zombie.server)) {
                applyAgitation(zombie);
              } else {
                zombie.npc.setSpeed(0);
              }
              return;
            }
            zombie.npc.lookAtTarget = null;
            zombie.npc.stopMovement();
          }
        }

        if (!zombie.isEatingCorpse) {
          // No corpse approach is active now.  Keep the action boundary
          // stationary so a previous patrol/chase speed cannot leak into the
          // eating animation or its first standing sample.
          zombie.npc.setSpeed(0);
          // wait for the nav agent to fully decelerate before starting the anim
          const vel = zombie.npc.navAgent?.velocity();
          const speed = vel ? Math.sqrt(vel.x * vel.x + vel.z * vel.z) : 0;
          if (speed > 0.0) return;
          zombie.npc.setAnimation(ZombieLoopingAnim.Eating);
          zombie.isEatingCorpse = true;
          zombie.stateTimer = 0;
        } else {
          // Keep ExpectedSpeed zero for every subsequent eating tick.  The
          // old code called applyAgitation() unconditionally above, which
          // advertised walk speed while the nav target was already stopped.
          zombie.npc.setSpeed(0);
        }

        zombie.hunger = Math.max(0, zombie.hunger - dt * 15);
        if (zombie.hunger === 0) {
          zombie.npc.playAnimation(ZombieOneshotAnim.EatingDone);
          zombie.corpseTargetId = null;
          zombie.isEatingCorpse = false;
          zombie.event(ZombieEvents.DoneFeeding);
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
          zombie.stateTimer = 0;
          zombie.npc.setLocomotionMode?.("walk");
          zombie.targetCharacterId = null;
          zombie.attackForward = null;
          zombie.corpseTargetId = null;
          zombie.isEatingCorpse = false;
          zombie.npc.setLookAtCharacter?.(null);
          zombie.npc.lookAtTarget = null;
          zombie.targetPos = zombie.lastNoisePos;
          if (zombie.targetPos) {
            if (!moveToward(zombie.npc, zombie.targetPos, zombie.server)) {
              zombie.targetPos = null;
              zombie.npc.setSpeed(0);
            } else {
              applyAgitation(zombie);
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
          zombie.npc.lookAtTarget = null;
          // The pathfinding broadcaster runs independently of the FSM timer.
          // Publish the complete chase hand-off here, not on the next tick, so
          // a first movement sample cannot carry the previous walk stance or
          // zero/ambient speed into the sprint graph.
          zombie.npc.setCombatAnimationMode?.(true);
          zombie.npc.setLocomotionMode?.("sprint");
          const chaseTarget = getChaseTarget(zombie);
          if (chaseTarget) {
            zombie.npc.setLookAtCharacter?.(zombie.targetCharacterId);
            if (moveToward(zombie.npc, chaseTarget.position, zombie.server)) {
              applyAgitation(zombie);
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
        EnterTransition: () => enterFeed(zombie)
      },
      {
        eventId: ZombieEvents.NoiseTimeout,
        from: [ZombieTransitions.Investigate],
        to: ZombieTransitions.Wander,
        EnterTransition: () => enterWander(zombie)
      },
      {
        eventId: ZombieEvents.ReachPlayer,
        from: [ZombieTransitions.Chase],
        to: ZombieTransitions.Attack,
        EnterTransition: () => {
          zombie.npc.stopMovement();
          zombie.npc.setLocomotionMode?.("walk");
          zombie.lastAttackTime = 2;
        }
      },
      {
        eventId: ZombieEvents.StartStumble,
        from: [ZombieTransitions.Chase],
        to: ZombieTransitions.Stumble,
        EnterTransition: () => {
          zombie.npc.stopMovement();
          zombie.npc.setLocomotionMode?.("walk");
          zombie.stateTimer = 0;
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
          zombie.stumbleAnimation = selected;
          zombie.npc.playAnimation(selected);
        }
      },
      {
        eventId: ZombieEvents.StumbleTimeout,
        from: [ZombieTransitions.Stumble],
        to: ZombieTransitions.Chase,
        EnterTransition: () => {
          zombie.stateTimer = 0;
          zombie.stumbleAnimation = undefined;
          zombie.npc.setCombatAnimationMode?.(true);
          zombie.npc.setLocomotionMode?.("sprint");
          const chaseTarget = getChaseTarget(zombie);
          if (chaseTarget) {
            if (moveToward(zombie.npc, chaseTarget.position, zombie.server)) {
              applyAgitation(zombie);
            }
          }
        }
      },
      {
        eventId: ZombieEvents.StartAttacking,
        from: [ZombieTransitions.Attack],
        to: ZombieTransitions.Attacking,
        EnterTransition: () => {
          zombie.npc.stopMovement();
          zombie.npc.setLocomotionMode?.("walk");
          const target = getChaseTarget(zombie);
          zombie.attackForward = target
            ? getAttackForward(zombie.npc, target.position)
            : null;
          zombie.attackDamageApplied = false;
          zombie.attackEnvelopeWasActive = false;
          zombie.npc.playAnimation(ZombieOneshotAnim.KnifeSlash);
          zombie.stateTimer = 0;
          zombie.lastAttackTime = 0;
        }
      },
      {
        eventId: ZombieEvents.DoneAttacking,
        from: [ZombieTransitions.Attacking],
        to: ZombieTransitions.Attack,
        EnterTransition: () => {
          zombie.attackForward = null;
          zombie.attackDamageApplied = false;
          zombie.attackEnvelopeWasActive = false;
          // The shared KnifeSlash one-shot owns the client pose until its
          // native clock expires.  Once the Attacking state is allowed to
          // finish, explicitly hand existing observers back to the persistent
          // idle loop; late observers already receive the same reset through
          // Npc's animation runtime state.
          zombie.npc.setAnimation(ZombieLoopingAnim.Idle);
          zombie.lastAttackTime = 2;
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
        EnterTransition: () => enterWander(zombie)
      },
      {
        eventId: ZombieEvents.PlayerBacked,
        from: [ZombieTransitions.Attack],
        to: ZombieTransitions.Chase,
        EnterTransition: () => {
          zombie.npc.lookAtTarget = null;
          zombie.npc.setLookAtCharacter?.(null);
          zombie.npc.setCombatAnimationMode?.(true);
          zombie.npc.setLocomotionMode?.("sprint");
          const chaseTarget = getChaseTarget(zombie);
          if (chaseTarget) {
            zombie.npc.setLookAtCharacter?.(zombie.targetCharacterId);
            if (moveToward(zombie.npc, chaseTarget.position, zombie.server)) {
              applyAgitation(zombie);
            }
          }
        }
      },
      {
        eventId: ZombieEvents.PlayerKilled,
        from: [ZombieTransitions.Attack],
        to: ZombieTransitions.Feed,
        EnterTransition: () => enterFeed(zombie)
      },
      {
        eventId: ZombieEvents.DoneFeeding,
        from: [ZombieTransitions.Feed],
        to: ZombieTransitions.Wander,
        EnterTransition: () => enterWander(zombie)
      },
      {
        eventId: ZombieEvents.IdleTimeout,
        from: [ZombieTransitions.Wander],
        to: ZombieTransitions.Idle,
        EnterTransition: () => {
          zombie.stateTimer = 0;
          zombie.npc.stopMovement();
          zombie.npc.setAnimation(ZombieLoopingAnim.Idle);
        }
      },
      {
        eventId: ZombieEvents.CoverEars,
        from: null,
        to: ZombieTransitions.Wander,
        EnterTransition: () => {
          zombie.npc.stopMovement();
          zombie.npc.playAnimation(ZombieOneshotAnim.CoverEars);
          zombie.isCoveringEars = true;
          zombie.coverEarsTimer = 0;
          zombie.targetCharacterId = null;
          zombie.npc.setLookAtCharacter?.(null);
          zombie.npc.lookAtTarget = null;
          zombie.wanderOrigin =
            zombie.npc.state.position.slice() as Float32Array;
        }
      }
    ],
    ZombieTransitions.Wander
  ) as unknown as ZombieInstance;

  zombie.onTransition = (from: string, to: string, eventId: string) => {
    debug(`[${zombie.id}] ${from} → ${to} (${eventId})`);
  };
  zombie.id = npc.characterId;
  zombie.npc = npc;
  zombie.server = server;
  // The FSM is created before the first observer is converted from the
  // lightweight representation.  Prime the persistent loop now so the
  // initial spawn and the full-data replay both have a real reset clip rather
  // than relying on a later state transition to manufacture Idle.
  zombie.npc.initializeAnimation?.(ZombieLoopingAnim.Idle);
  zombie.hunger = 0;
  zombie.agitation = AGITATION_INITIAL;
  // The initial patrol target is requested before the first AI interval. Do
  // not advertise walk speed until Recast accepts that first target; a failed
  // spawn/mesh projection must remain a standing graph state.
  zombie.npc.setLocomotionMode?.("walk");
  zombie.wanderOrigin = npc.state.position.slice() as Float32Array;
  const initialPatrol = pickPatrolPoint(server, npc.state.position);
  zombie.targetPos = initialPatrol;
  if (initialPatrol) {
    if (moveToward(npc, initialPatrol, server)) {
      applyAgitation(zombie);
    } else {
      zombie.targetPos = null;
      npc.setSpeed(0);
    }
  } else {
    npc.setSpeed(0);
  }
  zombie.lastNoisePos = null;
  zombie.targetCharacterId = null;
  zombie.attackForward = null;
  zombie.attackDamageApplied = false;
  zombie.attackEnvelopeWasActive = false;
  zombie.corpseTargetId = null;
  zombie.isEatingCorpse = false;
  zombie.stateTimer = 0;
  zombie.lastAttackTime = 0;
  zombie.isCoveringEars = false;
  zombie.coverEarsTimer = 0;

  return zombie;
}
