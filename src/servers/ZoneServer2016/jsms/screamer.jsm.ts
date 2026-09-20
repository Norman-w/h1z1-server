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
import { NavManager } from "../../../utils/recast";
const debug = require("debug")("ai");
import {
  getDistance2d,
  getDistance,
  isFacingTarget
} from "../../../utils/utils";
import { ZombieWalker } from "../entities/zombiewalker";
import { MovementModifiers } from "../models/enums";
import { Factions } from "./factions";

export const enum ScreamerAnimations {
  Flinch = "Flinch",
  Death = "Death",
  DeathRagdoll = "DeathRagdoll",
  KnifeSlash = "KnifeSlash",
  MeleeFlinch = "MeleeFlinch",
  TurnLeft90 = "TurnLeft90",
  TurnRight90 = "TurnRight90",
  GrappleTell = "GrappleTell",
  TurnLeft45 = "TurnLeft45",
  TurnRight45 = "TurnRight45",
  Idle = "idle",
  TurnRight180 = "TurnRight180",
  TurnLeft180 = "TurnLeft180",
  PushbackNorthMedium = "PushbackNorthMedium",
  PushbackEastMedium = "PushbackEastMedium",
  PushbackWestMedium = "PushbackWestMedium",
  PushbackSouthMedium = "PushbackSouthMedium",
  Stun = "Stun",
  DeathPose = "DeathPose",
  Alive = "Alive",
  DeathRagdollAnywhere = "DeathRagdollAnywhere",
  StopPhysics = "StopPhysics",
  Scream = "Scream",
  Untie = "Untie",
  ScreamerRise = "ScreamerRise",
  ScreamerReset = "ScreamerReset"
}

export const enum Transitions {
  Sleep = "sleep",
  Rising = "rising",
  Wander = "wander",
  Screaming = "Screaming",
  Chase = "chase",
  Attack = "attack",
  Attacking = "attacking"
}

export const enum Events {
  ReachPlayer = "reachPlayer",
  LostPlayer = "lostPlayer",
  PlayerBacked = "playerBacked",
  PlayerKilled = "playerKilled",
  DoneFeeding = "doneFeeding",
  IdleTimeout = "idleTimeout",
  Destroyed = "destroyed",
  StartAttacking = "startAttacking",
  DoneAttacking = "doneAttacking",
  StartScreaming = "startScreaming",
  DoneScreaming = "doneScreaming",
  StartRising = "startRising",
  DoneRising = "doneRising"
}

export interface ScreamerInstance extends JSM<Events> {
  id: string;
  state: Transitions;
  agitation: number;
  targetPos: Float32Array | null;
  lastNoisePos: Float32Array | null;
  stateTimer: number;
  targetCharacterId: string | null;
  /** Horizontal direction captured when the current melee swing starts. */
  attackForward: [number, number] | null;
  attackDamageApplied: boolean;
  attackEnvelopeWasActive: boolean;
  wanderOrigin: Float32Array;
  armsFreed: boolean;
  screamCooldownTimer: number;
  npc: Npc;
  server: ZoneServer2016;
}

const BASE_SPEED = 1.5;
const MAX_SPEED = 4.0;
const AGITATION_DECAY_RATE = 1;
const AGITATION_INITIAL = 50;
// ThirdPersonZombieScreamerPhysicsX64.mrn exposes the Scream leaf as 100
// frames at 30 FPS.  This is the fallback for lightweight fixtures; real
// Npc instances resolve the same clock through getAnimationDurationMs().
const SCREAM_DURATION = 10 / 3;
const SCREAM_RADIUS = 50;
const PLAYER_DETECT_RADIUS = 25;
const SCREAM_COOLDOWN = 20;
const ATTRACT_RADIUS = 250;
const ATTRACT_AGITATION = 60;
const CIRCLE_RADIUS = 12;

function pickPatrolPoint(
  server: ZoneServer2016,
  center: Float32Array
): Float32Array | null {
  const navCenter = NavManager.gameToNav(center);
  const { success, randomPoint } =
    server.navManager.navMeshQuery.findRandomPointAroundCircle(navCenter, 60);
  return success ? NavManager.navToGame(randomPoint) : null;
}

function pickPointAroundPlayer(
  server: ZoneServer2016,
  playerPos: Float32Array
): Float32Array {
  const angle = Math.random() * Math.PI * 2;
  const target = new Float32Array([
    playerPos[0] + Math.cos(angle) * CIRCLE_RADIUS,
    playerPos[1],
    playerPos[2] + Math.sin(angle) * CIRCLE_RADIUS
  ]);
  return NavManager.navToGame(server.navManager.getClosestNavPointVec3(target));
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
      npc.setLocomotionMode?.("walk");
      npc.stopMovement();
      return false;
    }
  } catch {
    npc.setLocomotionMode?.("walk");
    npc.stopMovement();
    return false;
  }
  return true;
}

function hasLineOfSight(
  server: ZoneServer2016,
  from: Float32Array,
  to: Float32Array
): boolean {
  const result = server.navManager.raycast(from, to);
  return result.t >= 1;
}

function tryDetectPlayer(screamer: ScreamerInstance): boolean {
  const sz = 50;
  const pos = screamer.npc.state.position;
  const cx = Math.floor(pos[0] / sz);
  const cz = Math.floor(pos[2] / sz);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const bucket = screamer.server.aiTargetSpatialMap.get(
        `${cx + dx},${cz + dz}`
      );
      if (!bucket) continue;
      for (const entry of bucket) {
        if (entry.faction !== Factions.HUMAN) continue;
        const player = screamer.server._characters[entry.id];
        if (
          player &&
          (!player.isAlive || player.isVanished || player.isHidden)
        ) {
          continue;
        }
        if (getDistance2d(pos, entry.position) >= PLAYER_DETECT_RADIUS)
          continue;
        if (!hasLineOfSight(screamer.server, pos, entry.position)) continue;
        screamer.targetCharacterId = entry.id;
        screamer.event(Events.StartScreaming);
        return true;
      }
    }
  }
  return false;
}

function getChaseTarget(screamer: ScreamerInstance) {
  return screamer.targetCharacterId
    ? screamer.server._characters[screamer.targetCharacterId]
    : null;
}

function applyAgitation(screamer: ScreamerInstance): void {
  const speed =
    BASE_SPEED + (screamer.agitation / 100) * (MAX_SPEED - BASE_SPEED);
  screamer.npc.setSpeed(speed);
}

function getMeleeRange(screamer: ScreamerInstance): number {
  return screamer.npc.getMeleeAttackRange?.(2) ?? 2;
}

function getMeleeAttackDuration(screamer: ScreamerInstance): number {
  return screamer.npc.getMeleeAttackAnimationDuration?.(1) ?? 1;
}

function getActionDuration(
  screamer: ScreamerInstance,
  animationName: ScreamerAnimations,
  fallbackSeconds: number
): number {
  const durationMs = screamer.npc.getAnimationDurationMs?.(animationName);
  return Number.isFinite(durationMs) && (durationMs as number) > 0
    ? (durationMs as number) / 1000
    : fallbackSeconds;
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

function decayAgitation(screamer: ScreamerInstance, dt: number): void {
  screamer.agitation = Math.max(
    0,
    screamer.agitation - AGITATION_DECAY_RATE * dt
  );
}

function enterWander(screamer: ScreamerInstance): void {
  // The screamer can leave a sprint chase or melee state while still moving;
  // cancel that nav request before returning to the walk graph.
  screamer.npc.stopMovement();
  screamer.stateTimer = 0;
  screamer.agitation = AGITATION_INITIAL;
  screamer.targetCharacterId = null;
  screamer.attackForward = null;
  screamer.npc.setLookAtCharacter?.(null);
  screamer.npc.setCombatAnimationMode?.(false);
  screamer.npc.setLocomotionMode?.("walk");
  // Queue the sleeping/reset loop before any active scream/attack one-shot
  // expires.  A lost target during a special action must not leave a late
  // observer or the current client stuck on the previous pose.
  screamer.npc.setAnimation(ScreamerAnimations.ScreamerReset);
  screamer.npc.lookAtTarget = null;
  screamer.lastNoisePos = null;
  screamer.wanderOrigin = screamer.npc.state.position.slice() as Float32Array;
  screamer.targetPos = null;
  const activeAction = screamer.npc.getAnimationRuntimeState?.().activeAnimation;
  if (activeAction) {
    screamer.npc.setSpeed(0);
    return;
  }
  const pt = pickPatrolPoint(screamer.server, screamer.wanderOrigin);
  if (pt) {
    screamer.targetPos = pt;
    if (moveToward(screamer.npc, pt, screamer.server)) {
      applyAgitation(screamer);
    } else {
      screamer.targetPos = null;
      screamer.npc.setSpeed(0);
    }
  } else {
    screamer.npc.setSpeed(0);
  }
}

function screamAtNearbyZombies(screamer: ScreamerInstance): void {
  const sz = 50;
  const pos = screamer.npc.state.position;
  const cx = Math.floor(pos[0] / sz);
  const cz = Math.floor(pos[2] / sz);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const bucket = screamer.server.aiTargetSpatialMap.get(
        `${cx + dx},${cz + dz}`
      );
      if (!bucket) continue;
      for (const entry of bucket) {
        if (entry.faction !== Factions.ZOMBIE) continue;
        if (getDistance2d(pos, entry.position) > SCREAM_RADIUS) continue;
        const npc = screamer.server._npcs[entry.id];
        if (!npc?.fsm || !(npc instanceof ZombieWalker)) continue;
        (
          npc.fsm as unknown as { lastNoisePos: Float32Array | null }
        ).lastNoisePos = screamer.npc.state.position.slice() as Float32Array;
        npc.fsm.event("coverEars");
      }
    }
  }
}

function pushScreamSound(screamer: ScreamerInstance): void {
  screamer.server.pushSound({
    position: screamer.npc.state.position.slice() as Float32Array,
    radius: ATTRACT_RADIUS,
    agitation: ATTRACT_AGITATION,
    priority: 5
  });
}

function screamAtNearbyPlayers(screamer: ScreamerInstance): void {
  const sz = 50;
  const pos = screamer.npc.state.position;
  const cx = Math.floor(pos[0] / sz);
  const cz = Math.floor(pos[2] / sz);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const bucket = screamer.server.aiTargetSpatialMap.get(
        `${cx + dx},${cz + dz}`
      );
      if (!bucket) continue;
      for (const entry of bucket) {
        if (entry.faction !== Factions.HUMAN) continue;
        if (getDistance2d(pos, entry.position) > SCREAM_RADIUS) continue;
        const client = screamer.server.getClientByCharId(entry.id);
        if (!client || client.character.isVanished || client.character.isHidden)
          continue;
        screamer.server.applyMovementModifier(client, MovementModifiers.SCREAM);
      }
    }
  }
}

export function createScreamer(
  npc: Npc,
  server: ZoneServer2016
): ScreamerInstance {
  const screamer = new JSM(
    {
      [Transitions.Sleep]: (_dt: number) => {
        const sz = 50;
        const pos = screamer.npc.state.position;
        const cx = Math.floor(pos[0] / sz);
        const cz = Math.floor(pos[2] / sz);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            const bucket = screamer.server.aiTargetSpatialMap.get(
              `${cx + dx},${cz + dz}`
            );
            if (!bucket) continue;
            for (const entry of bucket) {
              if (entry.faction !== Factions.HUMAN) continue;
              const player = screamer.server._characters[entry.id];
              if (
                player &&
                (!player.isAlive || player.isVanished || player.isHidden)
              ) {
                continue;
              }
              if (getDistance2d(pos, entry.position) >= PLAYER_DETECT_RADIUS)
                continue;
              if (!hasLineOfSight(screamer.server, pos, entry.position))
                continue;
              screamer.targetCharacterId = entry.id;
              screamer.event(Events.StartRising);
              return;
            }
          }
        }
      },

      [Transitions.Rising]: (dt: number) => {
        screamer.stateTimer += dt;
        screamer.npc.setCombatAnimationMode?.(false);
        screamer.npc.setLocomotionMode?.("walk");
        screamer.npc.stopMovement();

        // The wake-up clip is a real one-shot.  Re-running detection on every
        // Rising tick used to fire StartScreaming a few frames after
        // ScreamerRise, replacing the rise packet before the NPC had stood up.
        // Keep detection behind the clip boundary: the target acquired in
        // Sleep remains the candidate, and a target that disappears during
        // the rise simply falls back to the normal wander handoff.
        const riseClipActive =
          screamer.npc.isAnimationActive?.(ScreamerAnimations.ScreamerRise) ??
          false;
        const riseDuration = getActionDuration(
          screamer,
          ScreamerAnimations.ScreamerRise,
          1.5
        );
        if (screamer.stateTimer < riseDuration || riseClipActive) return;

        if (tryDetectPlayer(screamer)) return;

        const target = getChaseTarget(screamer);
        if (
          target &&
          target.isAlive &&
          !target.isVanished &&
          !target.isHidden &&
          getDistance2d(
            screamer.npc.state.position,
            target.state.position
          ) < PLAYER_DETECT_RADIUS &&
          hasLineOfSight(
            screamer.server,
            screamer.npc.state.position,
            target.state.position
          )
        ) {
          screamer.event(Events.StartScreaming);
        } else {
          screamer.event(Events.DoneRising);
        }
      },

      [Transitions.Wander]: (dt: number) => {
        screamer.stateTimer += dt;
        screamer.npc.setCombatAnimationMode?.(false);
        screamer.npc.setLocomotionMode?.("walk");

        if (tryDetectPlayer(screamer)) return;

        decayAgitation(screamer, dt);

        if (screamer.agitation === 0) {
          screamer.event(Events.IdleTimeout);
          return;
        }

        const arrived =
          screamer.targetPos != null &&
          getDistance2d(screamer.npc.state.position, screamer.targetPos) < 3;

        if (arrived || screamer.targetPos == null) {
          const pt = pickPatrolPoint(screamer.server, screamer.wanderOrigin);
          if (pt) {
            screamer.targetPos = pt;
            // Recast must accept the target before the walk graph advertises
            // a positive speed.  Publishing agitation first lets a failed
            // patrol request briefly run the client in place and was the
            // remaining source of a visible slide in the screamer branch.
            if (!moveToward(screamer.npc, pt, screamer.server)) {
              screamer.targetPos = null;
              screamer.npc.setSpeed(0);
            } else {
              applyAgitation(screamer);
            }
          } else {
            screamer.targetPos = null;
            screamer.npc.stopMovement();
          }
        } else {
          // The existing target was accepted on the previous tick.  It is
          // safe to refresh the authored walk speed while that target is
          // still active; a new target always takes the guarded path above.
          applyAgitation(screamer);
        }
      },
      [Transitions.Screaming]: (dt: number) => {
        screamer.npc.setCombatAnimationMode?.(false);
        screamer.npc.setLocomotionMode?.("walk");
        screamer.stateTimer += dt;
        pushScreamSound(screamer);
        const chaseTarget = getChaseTarget(screamer);
        const screamClipActive =
          screamer.npc.isAnimationActive?.(ScreamerAnimations.Scream) ??
          false;
        // Losing the player must not cut the scream one-shot.  Finish the
        // authored vocal/action clip first, then choose chase or wander from
        // the target that is still available at that boundary.
        if (chaseTarget) {
          screamer.npc.setLookAtCharacter?.(screamer.targetCharacterId);
        }
        const screamDuration = getActionDuration(
          screamer,
          ScreamerAnimations.Scream,
          SCREAM_DURATION
        );
        if (screamer.stateTimer < screamDuration || screamClipActive) return;
        if (
          chaseTarget &&
          chaseTarget.isAlive &&
          !chaseTarget.isVanished &&
          !chaseTarget.isHidden
        ) {
          screamer.event(Events.DoneScreaming);
        } else {
          screamer.event(Events.LostPlayer);
        }
      },

      [Transitions.Chase]: (dt: number) => {
        screamer.stateTimer += dt;
        screamer.screamCooldownTimer += dt;

        // Health can free the screamer's arms while it is already moving.
        // Untie is a one-shot graph edge; do not let the next chase tick
        // replace it with sprint locomotion or KnifeSlash.
        if (
          screamer.armsFreed &&
          (screamer.npc.isAnimationActive?.(ScreamerAnimations.Untie) ?? false)
        ) {
          screamer.npc.stopMovement();
          screamer.npc.setCombatAnimationMode?.(false);
          screamer.npc.setLocomotionMode?.("walk");
          return;
        }

        screamer.npc.setCombatAnimationMode?.(true);
        screamer.npc.setLocomotionMode?.("sprint");

        const chaseTarget = getChaseTarget(screamer);
        if (
          !chaseTarget ||
          !chaseTarget.isAlive ||
          chaseTarget.isVanished ||
          chaseTarget.isHidden
        ) {
          screamer.event(Events.LostPlayer);
          return;
        }

        const chaseDist = getDistance2d(
          screamer.npc.state.position,
          chaseTarget.state.position
        );
        if (chaseDist > 80) {
          screamer.event(Events.LostPlayer);
          return;
        }

        // Phase 1 (arms still bound): never melee, just wander around the
        // player, re-screaming every SCREAM_COOLDOWN.
        if (!screamer.armsFreed) {
          screamer.npc.lookAtTarget = null;
          if (screamer.screamCooldownTimer >= SCREAM_COOLDOWN) {
            screamer.event(Events.StartScreaming);
            return;
          }
          const arrived =
            screamer.targetPos != null &&
            getDistance2d(screamer.npc.state.position, screamer.targetPos) < 3;
          if (arrived || screamer.targetPos == null) {
            screamer.targetPos = pickPointAroundPlayer(
              screamer.server,
              chaseTarget.state.position
            );
            if (
              screamer.targetPos &&
              moveToward(screamer.npc, screamer.targetPos, screamer.server)
            ) {
              applyAgitation(screamer);
            } else {
              screamer.targetPos = null;
              screamer.npc.setSpeed(0);
            }
          } else {
            applyAgitation(screamer);
          }
          return;
        }

        // Phase 2 (arms freed): melee.
        screamer.npc.lookAtTarget = chaseTarget.state.position;
        if (chaseDist < getMeleeRange(screamer)) {
          screamer.event(Events.ReachPlayer);
        } else {
          if (moveToward(screamer.npc, chaseTarget.state.position, screamer.server)) {
            applyAgitation(screamer);
          } else {
            screamer.npc.setSpeed(0);
          }
        }
      },

      [Transitions.Attack]: (dt: number) => {
        screamer.stateTimer += dt;

        if (
          screamer.armsFreed &&
          (screamer.npc.isAnimationActive?.(ScreamerAnimations.Untie) ?? false)
        ) {
          screamer.npc.stopMovement();
          screamer.npc.setCombatAnimationMode?.(false);
          screamer.npc.setLocomotionMode?.("walk");
          return;
        }

        screamer.npc.setCombatAnimationMode?.(true);

        const attackTarget = getChaseTarget(screamer);
        if (!attackTarget || !attackTarget.isAlive) {
          screamer.event(Events.PlayerKilled);
          return;
        }
        if (attackTarget.isVanished || attackTarget.isHidden) {
          screamer.event(Events.LostPlayer);
          return;
        }
        screamer.npc.setLookAtCharacter?.(screamer.targetCharacterId);
        screamer.npc.lookAtTarget = attackTarget.state.position;
        screamer.npc.lookAt(attackTarget.state.position, dt);
        const attackDist = getDistance(
          screamer.npc.state.position,
          attackTarget.state.position
        );
        const meleeRange = getMeleeRange(screamer);
        if (attackDist >= meleeRange) {
          screamer.npc.setLocomotionMode?.("sprint");
          const accepted = moveToward(
            screamer.npc,
            attackTarget.state.position,
            screamer.server
          );
          if (accepted) {
            applyAgitation(screamer);
            screamer.event(Events.PlayerBacked);
          } else {
            screamer.event(Events.LostPlayer);
          }
        } else {
          screamer.npc.setLocomotionMode?.("walk");
          screamer.npc.stopMovement();
          const inStrikeEnvelope =
            screamer.npc.isMeleeTargetInEnvelope?.(
              attackTarget.state.position
            ) ?? true;
          const unobstructed =
            screamer.npc.hasMeleeLineOfSight?.(attackTarget.state.position) ?? true;
          if (screamer.stateTimer > 2 && inStrikeEnvelope && unobstructed) {
            screamer.event(Events.StartAttacking);
          }
        }
      },

      [Transitions.Attacking]: (dt: number) => {
        const stateTimerBefore = screamer.stateTimer;
        screamer.npc.setCombatAnimationMode?.(true);
        screamer.npc.setLocomotionMode?.("walk");
        screamer.stateTimer += dt;

        const attackTarget = getChaseTarget(screamer);
        if (attackTarget && screamer.targetCharacterId) {
          screamer.npc.setLookAtCharacter?.(screamer.targetCharacterId);
        }

        const attackClipState = screamer.npc.isAnimationActive?.(
          ScreamerAnimations.KnifeSlash
        );
        const attackDuration = getMeleeAttackDuration(screamer);
        const contactWindow = screamer.npc.getMeleeContactWindow?.();
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
          screamer.stateTimer >= contactStart;
        if (!screamer.attackDamageApplied && contactActive) {
          if (
            attackTarget?.isAlive &&
            !attackTarget.isVanished &&
            !attackTarget.isHidden
          ) {
            const attackDist = getDistance(
              screamer.npc.state.position,
              attackTarget.state.position
            );
            const meleeRange = getMeleeRange(screamer);
            const facingTarget = isFacingTarget(
              screamer.npc.state.position,
              screamer.npc.state.yaw ?? 0,
              attackTarget.state.position
            );
            const inStrikeEnvelope =
              screamer.npc.isMeleeTargetInEnvelope?.(
                attackTarget.state.position,
                screamer.npc.state.position,
                screamer.attackForward ?? undefined
              ) ??
              (attackDist <= meleeRange && facingTarget);
            const unobstructed =
              screamer.npc.hasMeleeLineOfSight?.(attackTarget.state.position) ??
              true;
            const crossedContactEnd =
              stateTimerBefore < contactEnd && screamer.stateTimer > contactEnd;
            if (
              inStrikeEnvelope &&
              unobstructed &&
              (!crossedContactEnd || screamer.attackEnvelopeWasActive)
            ) {
              screamer.npc.applyDamage(screamer.targetCharacterId!);
              screamer.attackDamageApplied = true;
            }
            screamer.attackEnvelopeWasActive = inStrikeEnvelope;
          } else {
            screamer.attackEnvelopeWasActive = false;
          }
        } else if (attackTarget?.isAlive) {
          const attackDist = getDistance(
            screamer.npc.state.position,
            attackTarget.state.position
          );
          const meleeRange = getMeleeRange(screamer);
          const facingTarget = isFacingTarget(
            screamer.npc.state.position,
            screamer.npc.state.yaw ?? 0,
            attackTarget.state.position
          );
          screamer.attackEnvelopeWasActive =
            screamer.npc.isMeleeTargetInEnvelope?.(
              attackTarget.state.position,
              screamer.npc.state.position,
              screamer.attackForward ?? undefined
            ) ?? (attackDist <= meleeRange && facingTarget);
        } else {
          screamer.attackEnvelopeWasActive = false;
        }

        if (
          screamer.stateTimer >= attackDuration &&
          !(attackClipState ?? false)
        ) {
          screamer.event(Events.DoneAttacking);
        }
      }
    },
    [
      {
        eventId: Events.StartRising,
        from: [Transitions.Sleep],
        to: Transitions.Rising,
        EnterTransition: () => {
          screamer.stateTimer = 0;
          screamer.npc.playAnimation(ScreamerAnimations.ScreamerRise);
        }
      },
      {
        eventId: Events.DoneRising,
        from: [Transitions.Rising],
        to: Transitions.Wander,
        EnterTransition: () => {
          screamer.stateTimer = 0;
          screamer.targetCharacterId = null;
          screamer.npc.setLookAtCharacter?.(null);
          screamer.npc.setCombatAnimationMode?.(false);
          screamer.npc.setLocomotionMode?.("walk");
          screamer.npc.setAnimation(ScreamerAnimations.ScreamerReset);
          screamer.wanderOrigin = screamer.npc.state.position.slice() as Float32Array;
          screamer.targetPos = null;
        }
      },
      {
        eventId: Events.StartScreaming,
        from: [Transitions.Wander, Transitions.Chase, Transitions.Rising],
        to: Transitions.Screaming,
        EnterTransition: () => {
          screamer.npc.stopMovement();
          screamer.npc.setLocomotionMode?.("walk");
          screamer.npc.playAnimation(ScreamerAnimations.Scream);
          screamer.stateTimer = 0;
          screamAtNearbyZombies(screamer);
          screamAtNearbyPlayers(screamer);
        }
      },
      {
        eventId: Events.DoneScreaming,
        from: [Transitions.Screaming],
        to: Transitions.Chase,
        EnterTransition: () => {
          screamer.stateTimer = 0;
          screamer.screamCooldownTimer = 0;
          screamer.targetPos = null;
          screamer.npc.setLookAtCharacter?.(screamer.targetCharacterId);
          screamer.npc.setCombatAnimationMode?.(true);
          screamer.npc.setLocomotionMode?.("sprint");
          const target = getChaseTarget(screamer);
          if (
            target &&
            moveToward(screamer.npc, target.state.position, screamer.server)
          ) {
            applyAgitation(screamer);
          }
        }
      },
      {
        eventId: Events.ReachPlayer,
        from: [Transitions.Chase],
        to: Transitions.Attack,
        EnterTransition: () => {
          screamer.npc.stopMovement();
          screamer.npc.setLocomotionMode?.("walk");
          screamer.stateTimer = 2;
        }
      },
      {
        eventId: Events.LostPlayer,
        from: [
          Transitions.Chase,
          Transitions.Attack,
          Transitions.Attacking,
          Transitions.Screaming
        ],
        to: Transitions.Wander,
        EnterTransition: () => enterWander(screamer)
      },
      {
        eventId: Events.PlayerBacked,
        from: [Transitions.Attack],
        to: Transitions.Chase,
        EnterTransition: () => {
          screamer.npc.setCombatAnimationMode?.(true);
          screamer.npc.setLocomotionMode?.("sprint");
          const chaseTarget = getChaseTarget(screamer);
          if (
            chaseTarget &&
            moveToward(
              screamer.npc,
              chaseTarget.state.position,
              screamer.server
            )
          ) {
            applyAgitation(screamer);
          }
        }
      },
      {
        eventId: Events.StartAttacking,
        from: [Transitions.Attack],
        to: Transitions.Attacking,
        EnterTransition: () => {
          screamer.npc.stopMovement();
          screamer.npc.setLocomotionMode?.("walk");
          const target = getChaseTarget(screamer);
          screamer.attackForward = target
            ? getAttackForward(screamer.npc, target.state.position)
            : null;
          screamer.attackDamageApplied = false;
          screamer.attackEnvelopeWasActive = false;
          screamer.npc.playAnimation(ScreamerAnimations.KnifeSlash);
          screamer.stateTimer = 0;
        }
      },
      {
        eventId: Events.DoneAttacking,
        from: [Transitions.Attacking],
        to: Transitions.Attack,
        EnterTransition: () => {
          screamer.attackForward = null;
          screamer.attackDamageApplied = false;
          screamer.attackEnvelopeWasActive = false;
          screamer.npc.setAnimation(ScreamerAnimations.ScreamerReset);
          screamer.stateTimer = 2;
        }
      },
      {
        eventId: Events.PlayerKilled,
        from: [Transitions.Attack],
        to: Transitions.Wander,
        EnterTransition: () => enterWander(screamer)
      },
      {
        eventId: Events.IdleTimeout,
        from: [Transitions.Wander],
        to: Transitions.Sleep,
        EnterTransition: () => {
          screamer.stateTimer = 0;
          screamer.npc.stopMovement();
          screamer.npc.setAnimation(ScreamerAnimations.ScreamerReset);
        }
      }
    ],
    Transitions.Sleep
  ) as unknown as ScreamerInstance;

  screamer.onTransition = (from: string, to: string, eventId: string) => {
    debug(`[screamer:${screamer.id}] ${from} → ${to} (${eventId})`);
  };
  screamer.id = npc.characterId;
  screamer.npc = npc;
  screamer.server = server;
  screamer.agitation = AGITATION_INITIAL;
  screamer.wanderOrigin = npc.state.position.slice() as Float32Array;
  npc.setLocomotionMode?.("walk");
  screamer.targetPos = null;
  screamer.lastNoisePos = null;
  screamer.stateTimer = 0;
  screamer.targetCharacterId = null;
  screamer.attackForward = null;
  screamer.attackDamageApplied = false;
  screamer.attackEnvelopeWasActive = false;
  screamer.armsFreed = false;
  screamer.screamCooldownTimer = 0;

  npc.initializeAnimation?.(ScreamerAnimations.ScreamerReset);

  return screamer;
}
