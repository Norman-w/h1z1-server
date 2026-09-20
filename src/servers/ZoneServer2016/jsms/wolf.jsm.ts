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
import { Factions, isHostile } from "./factions";

export const enum AnimalsAnimation {
  Idle = "Idle",
  /** Public AnimalsPhysics event; it selects the species attack branch. */
  KnifeSlash = "KnifeSlash",
  Flinch = "Flinch",
  Death = "Death",
  WolfHowl = "WolfHowl",
  /** Public AnimalsPhysics event; Bear001 maps it to its rear-up clip. */
  StandUp = "StandUp",
  Eating = "Eating",
  DeathRagdoll = "DeathRagdoll",
  DeathRagdollAnywhere = "DeathRagdollAnywhere",
  DeathPose = "DeathPose",
  Roar = "Roar",
  MeleeFlinch = "MeleeFlinch"
}

export const enum WolfTransitions {
  Wander = "wander",
  Howling = "howling",
  Chase = "chase",
  Attack = "attack",
  Attacking = "attacking"
}

export const enum WolfEvents {
  SpottedTarget = "spottedTarget",
  HowlDone = "howlDone",
  AlertedByHowl = "alertedByHowl",
  ReachTarget = "reachTarget",
  TargetBacked = "targetBacked",
  StartAttacking = "startAttacking",
  DoneAttacking = "doneAttacking",
  TargetKilled = "targetKilled",
  LostTarget = "lostTarget"
}

export interface WolfInstance extends JSM<WolfEvents> {
  id: string;
  state: WolfTransitions;
  targetPos: Float32Array | null;
  wanderOrigin: Float32Array;
  patrolTimer: number;
  stateTimer: number;
  howlTimer: number;
  isHowling: boolean;
  threatPos: Float32Array | null;
  targetCharacterId: string | null;
  /** Horizontal direction captured when the current swing starts. */
  attackForward: [number, number] | null;
  /** Prevents a single swing from applying damage more than once. */
  attackDamageApplied: boolean;
  /** Last sampled target envelope state for the current swing tick. */
  attackEnvelopeWasActive: boolean;
  npc: Npc;
  server: ZoneServer2016;
}

const DETECT_RADIUS = 20;
const CHASE_LOSE_DIST = 50;
const ATTACK_RANGE = 2;
// AnimalsX64.mrn source clip:
// Animals_Wolf001_Howl = 150 frames at 30 FPS (5.000000 s).  The chase graph
// must not resume before the public WolfHowl event has finished.
const HOWL_DURATION = 150 / 30;
const HOWL_ALERT_RADIUS = 40;
const WANDER_SPEED = 3.75;
const CHASE_SPEED = 6.5;

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
  server: ZoneServer2016,
  targetCharacterId?: string | null,
  expectedSpeed?: number
): boolean {
  if (!npc.navAgent) return false;
  try {
    const navTarget = server.navManager.getClosestNavPointVec3(target);
    // Recast reports whether the target request was accepted.  Do not let a
    // rejected request leak a sprint intent into the client locomotion graph;
    // that otherwise renders an in-place run/slide while the server remains
    // stationary.  Legacy test doubles return void, so only false rejects.
    if (npc.navAgent.requestMoveTarget(navTarget) === false) {
      npc.stopMovement();
      return false;
    }
  } catch {
    // Projection can fail when a target leaves the loaded NavMesh between AI
    // selection and this tick.  Treat it exactly like a rejected request.
    npc.stopMovement();
    return false;
  }
  // Bear/Wolf chase uses the retail native target controller as an input
  // hint.  Recast remains the server-side mover and PlayerUpdatePosition is
  // still the single visible position stream.  Patrol points have no entity
  // GUID, so they intentionally stay on the normal nav path.
  if (targetCharacterId) {
    npc.requestNativeSeekTarget?.(targetCharacterId, target, Date.now(), expectedSpeed);
  }
  return true;
}

function findTarget(wolf: WolfInstance): string | null {
  const sz = 50;
  const pos = wolf.npc.state.position;
  const cx = Math.floor(pos[0] / sz);
  const cz = Math.floor(pos[2] / sz);
  let nearestId: string | null = null;
  let nearestDistance = DETECT_RADIUS;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const bucket = wolf.server.aiTargetSpatialMap.get(
        `${cx + dx},${cz + dz}`
      );
      if (!bucket) continue;
      for (const entry of bucket) {
        if (entry.id === wolf.npc.characterId) continue;
        if (!isHostile(wolf.npc.faction, entry.faction)) continue;
        const distance = getDistance2d(pos, entry.position);
        if (distance < nearestDistance) {
          nearestId = entry.id;
          nearestDistance = distance;
        }
      }
    }
  }
  return nearestId;
}

function getTarget(
  wolf: WolfInstance
): { position: Float32Array; isAlive: boolean } | null {
  if (!wolf.targetCharacterId) return null;
  const player = wolf.server._characters[wolf.targetCharacterId];
  if (player) {
    if (player.isVanished || player.isHidden) return null;
    return { position: player.state.position, isAlive: player.isAlive };
  }
  const npc = wolf.server._npcs[wolf.targetCharacterId];
  if (npc) return { position: npc.state.position, isAlive: npc.isAlive };
  return null;
}

function alertNearbyWolves(wolf: WolfInstance): void {
  const sz = 50;
  const pos = wolf.npc.state.position;
  const cx = Math.floor(pos[0] / sz);
  const cz = Math.floor(pos[2] / sz);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const bucket = wolf.server.aiTargetSpatialMap.get(
        `${cx + dx},${cz + dz}`
      );
      if (!bucket) continue;
      for (const entry of bucket) {
        if (entry.faction !== Factions.WOLF) continue;
        if (entry.id === wolf.npc.characterId) continue;
        if (getDistance2d(pos, entry.position) > HOWL_ALERT_RADIUS) continue;
        const npc = wolf.server._npcs[entry.id];
        if (!npc?.fsm) continue;
        const packWolf = npc.fsm as unknown as WolfInstance;
        packWolf.threatPos = wolf.threatPos;
        packWolf.targetCharacterId = wolf.targetCharacterId;
        npc.fsm.event(WolfEvents.AlertedByHowl);
      }
    }
  }
}

function applyDamageToTarget(wolf: WolfInstance): void {
  if (!wolf.targetCharacterId) return;
  const character = wolf.server._characters[wolf.targetCharacterId];
  if (character?.isAlive) {
    wolf.npc.applyDamage(wolf.targetCharacterId);
    return;
  }
  const targetNpc = wolf.server._npcs[wolf.targetCharacterId];
  if (targetNpc && targetNpc.isAlive) {
    const damageInfo = {
      entity: wolf.npc.characterId,
      damage: wolf.npc.npcMeleeDamage
    };
    if (typeof targetNpc.applyNpcMeleeHit === "function") {
      targetNpc.applyNpcMeleeHit(wolf.server, damageInfo);
    } else {
      // Lightweight AI test doubles and legacy NPC adapters may not expose
      // the presentation-aware helper yet; preserve their health-only path.
      targetNpc.damage(wolf.server, damageInfo);
    }
  }
}

function getAttackRange(wolf: WolfInstance): number {
  return wolf.npc.getMeleeAttackRange?.(ATTACK_RANGE) ?? ATTACK_RANGE;
}

function getAttackDistance(
  wolf: WolfInstance,
  targetPosition: Float32Array
): number {
  return (
    wolf.npc.getMeleeTargetDistance?.(
      targetPosition,
      wolf.npc.state.position
    ) ?? getDistance(wolf.npc.state.position, targetPosition)
  );
}

function getAttackDuration(wolf: WolfInstance): number {
  return wolf.npc.getMeleeAttackAnimationDuration?.(1) ?? 1;
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

function enterWander(wolf: WolfInstance): void {
  // Clear any chase/attack velocity before changing the advertised stance
  // back to walking.  Setting only the new speed leaves a stale Recast target
  // active for one or more crowd steps and produces a visible slide.
  wolf.npc.stopMovement();
  wolf.stateTimer = 0;
  wolf.patrolTimer = 0;
  // Re-arm the public howl event for the next encounter.  Without clearing
  // this state, a target lost during/after Howling leaves the next detection
  // in a stale howl phase and the wolf resumes chase without its wake clip.
  wolf.howlTimer = 0;
  wolf.isHowling = false;
  wolf.targetCharacterId = null;
  wolf.attackForward = null;
  wolf.threatPos = null;
  wolf.npc.lookAtTarget = null;
  wolf.npc.setLookAtCharacter?.(null);
  wolf.npc.setCombatAnimationMode?.(false);
  wolf.npc.setLocomotionMode?.("walk");
  wolf.npc.setAnimation(AnimalsAnimation.Idle);
  wolf.wanderOrigin = wolf.npc.state.position.slice() as Float32Array;
  wolf.targetPos = null;
  wolf.npc.setSpeed(0);
  const pt = pickPatrolPoint(wolf.server, wolf.wanderOrigin);
  if (pt) {
    wolf.targetPos = pt;
    if (moveToward(wolf.npc, pt, wolf.server)) {
      wolf.npc.setSpeed(WANDER_SPEED);
    } else {
      wolf.targetPos = null;
    }
  }
  if (!wolf.targetPos) {
    wolf.npc.setSpeed(0);
  }
}

export function createWolf(npc: Npc, server: ZoneServer2016): WolfInstance {
  // Keep the explicit AI engagement projection on the actor so diagnostics
  // and the production FSM consume the same value.  This is not a recovered
  // animal weapon hitbox; it is the current native-contact boundary until
  // the client weapon shape is mapped.
  npc.nativeMeleeEngagementRange = ATTACK_RANGE;
  const wolf = new JSM(
    {
      [WolfTransitions.Wander]: (dt: number) => {
        wolf.stateTimer += dt;
        wolf.patrolTimer += dt;

        const targetId = findTarget(wolf);
        if (targetId !== null) {
          const target =
            wolf.server._characters[targetId] ?? wolf.server._npcs[targetId];
          wolf.targetCharacterId = targetId;
          wolf.threatPos = target.state.position.slice() as Float32Array;
          wolf.event(WolfEvents.SpottedTarget);
          return;
        }

        const arrived =
          wolf.targetPos != null &&
          getDistance2d(wolf.npc.state.position, wolf.targetPos) < 3;

        if (arrived || wolf.targetPos == null) {
          wolf.patrolTimer = 0;
          const pt = pickPatrolPoint(wolf.server, wolf.wanderOrigin);
          if (pt) {
            wolf.targetPos = pt;
            if (moveToward(wolf.npc, pt, wolf.server)) {
              wolf.npc.setSpeed(WANDER_SPEED);
            } else {
              wolf.targetPos = null;
              wolf.npc.setSpeed(0);
            }
          } else {
            wolf.targetPos = null;
            wolf.npc.setSpeed(0);
          }
        }
      },

      [WolfTransitions.Howling]: (dt: number) => {
        wolf.npc.stopMovement();

        if (!wolf.targetCharacterId) {
          wolf.event(WolfEvents.LostTarget);
          return;
        }
        const target = getTarget(wolf);
        if (!target || !target.isAlive) {
          wolf.event(WolfEvents.LostTarget);
          return;
        }

        if (!wolf.isHowling) {
          // wait for the nav agent to fully decelerate before starting the anim
          const vel = wolf.npc.navAgent?.velocity();
          const speed = vel ? Math.sqrt(vel.x * vel.x + vel.z * vel.z) : 0;
          if (speed > 0.0) return;
          wolf.npc.playAnimation(AnimalsAnimation.WolfHowl);
          wolf.isHowling = true;
          wolf.howlTimer = 0;
          return;
        }

        wolf.howlTimer += dt;
        // Keep the public WolfHowl event authoritative through its client
        // clock.  The server AI tick can land on the duration boundary before
        // the client's millisecond one-shot expires; resetting to Idle there
        // would visibly cut the howl and hand the sprint graph back early.
        const howlClipActive =
          wolf.npc.isAnimationActive?.(AnimalsAnimation.WolfHowl) ?? false;
        if (wolf.howlTimer >= HOWL_DURATION && !howlClipActive) {
          wolf.event(WolfEvents.HowlDone);
        }
      },

      [WolfTransitions.Chase]: (dt: number) => {
        wolf.stateTimer += dt;
        wolf.npc.setCombatAnimationMode?.(true);

        const target = getTarget(wolf);
        if (!target || !target.isAlive) {
          wolf.event(WolfEvents.LostTarget);
          return;
        }

        wolf.npc.lookAtTarget = target.position;
        const dist = getDistance2d(wolf.npc.state.position, target.position);
        const attackRange = getAttackRange(wolf);

        if (dist > CHASE_LOSE_DIST) {
          wolf.event(WolfEvents.LostTarget);
        } else if (dist < attackRange) {
          wolf.event(WolfEvents.ReachTarget);
        } else {
          // Re-enable sprint only after the target is still valid.  A lost
          // target must transition directly to enterWander()'s zero-speed
          // boundary without a stale chase-speed packet in between.
          const moveAccepted = moveToward(
            wolf.npc,
            target.position,
            wolf.server,
            wolf.targetCharacterId,
            CHASE_SPEED
          );
          if (!moveAccepted) {
            wolf.npc.stopMovement();
            wolf.event(WolfEvents.LostTarget);
            return;
          }
          wolf.npc.setLocomotionMode?.("sprint");
          wolf.npc.setSpeed(CHASE_SPEED);
        }
      },

      [WolfTransitions.Attack]: (dt: number) => {
        wolf.stateTimer += dt;
        wolf.npc.setCombatAnimationMode?.(true);

        const target = getTarget(wolf);
        if (!target) {
          wolf.event(WolfEvents.LostTarget);
          return;
        }
        if (!target.isAlive) {
          wolf.event(WolfEvents.TargetKilled);
          return;
        }

        wolf.npc.lookAtTarget = target.position;
        // Rotate in place until the target lies inside the weapon's narrow
        // lateral strike envelope; RANGE alone is only the outer reach.
        wolf.npc.lookAt(target.position, dt);

        const dist = getAttackDistance(wolf, target.position);
        const attackRange = getAttackRange(wolf);
        if (dist >= attackRange) {
          const moveAccepted = moveToward(
            wolf.npc,
            target.position,
            wolf.server,
            wolf.targetCharacterId,
            CHASE_SPEED
          );
          if (!moveAccepted) {
            wolf.npc.stopMovement();
            wolf.event(WolfEvents.LostTarget);
            return;
          }
          wolf.npc.setLocomotionMode?.("sprint");
          wolf.event(WolfEvents.TargetBacked);
        } else {
          wolf.npc.setLocomotionMode?.("walk");
          wolf.npc.stopMovement();
          const inStrikeEnvelope =
            wolf.npc.isMeleeTargetInEnvelope?.(
              target.position,
              wolf.npc.state.position,
              undefined,
              attackRange
            ) ?? true;
          const unobstructed =
            wolf.npc.hasMeleeLineOfSight?.(target.position) ?? true;
          if (wolf.stateTimer > 2 && inStrikeEnvelope && unobstructed) {
            wolf.event(WolfEvents.StartAttacking);
          }
        }
      },

      [WolfTransitions.Attacking]: (dt: number) => {
        const stateTimerBefore = wolf.stateTimer;
        wolf.stateTimer += dt;
        wolf.npc.setCombatAnimationMode?.(true);

        const target = getTarget(wolf);
        const attackDuration = getAttackDuration(wolf);
        const contactWindow = wolf.npc.getMeleeContactWindow?.();
        const contactStart = contactWindow
          ? attackDuration * contactWindow.startFraction
          : attackDuration;
        const contactEnd = contactWindow
          ? attackDuration * contactWindow.endFraction
          : attackDuration;
        // Do not let a stale server attack timer authorize contact after a
        // higher-priority one-shot (for example MeleeFlinch) replaced the
        // visible KnifeSlash graph edge.
        const attackClipState = wolf.npc.isAnimationActive?.(
          AnimalsAnimation.KnifeSlash
        );
        // The native graph exposes an interval, not a single server timer.
        // Sample the interval on every AI tick and include a tick that crosses
        // it.  Otherwise a busy server frame can skip the complete contact
        // window and lose the only hit opportunity for this swing.  Do not
        // allow a late post-clip tick to create a new hit.
        const contactActive =
          (attackClipState ?? true) &&
          stateTimerBefore < attackDuration &&
          stateTimerBefore <= contactEnd &&
          wolf.stateTimer >= contactStart;
        if (!wolf.attackDamageApplied && contactActive) {
          if (target?.isAlive) {
            const dist = getAttackDistance(wolf, target.position);
            const attackRange = getAttackRange(wolf);
            const facingTarget = isFacingTarget(
              wolf.npc.state.position,
              wolf.npc.state.yaw ?? 0,
              target.position
            );
            const inStrikeEnvelope =
              wolf.npc.isMeleeTargetInEnvelope?.(
                target.position,
                wolf.npc.state.position,
                wolf.attackForward ?? undefined,
                attackRange
              ) ??
              (dist <= attackRange && facingTarget);
            const unobstructed =
              wolf.npc.hasMeleeLineOfSight?.(target.position) ?? true;
            // If one tick crosses the end of SwingContact, the current
            // sample may be a target that only entered the envelope after
            // contact had already closed.  A previous in-envelope sample is
            // required for that late-crossing case; entering during the
            // active interval remains valid.
            const crossedContactEnd =
              stateTimerBefore < contactEnd && wolf.stateTimer > contactEnd;
            if (inStrikeEnvelope &&
              unobstructed &&
              (!crossedContactEnd || wolf.attackEnvelopeWasActive)) {
              applyDamageToTarget(wolf);
              wolf.attackDamageApplied = true;
            }
            wolf.attackEnvelopeWasActive = inStrikeEnvelope;
          } else {
            wolf.attackEnvelopeWasActive = false;
          }
        } else if (target?.isAlive) {
          const dist = getAttackDistance(wolf, target.position);
          const attackRange = getAttackRange(wolf);
          const facingTarget = isFacingTarget(
            wolf.npc.state.position,
            wolf.npc.state.yaw ?? 0,
            target.position
          );
          wolf.attackEnvelopeWasActive =
            wolf.npc.isMeleeTargetInEnvelope?.(
              target.position,
              wolf.npc.state.position,
              wolf.attackForward ?? undefined,
              attackRange
            ) ?? (dist <= attackRange && facingTarget);
        } else {
          wolf.attackEnvelopeWasActive = false;
        }
        if (wolf.stateTimer >= attackDuration && !(attackClipState ?? false)) {
          wolf.event(WolfEvents.DoneAttacking);
        }
      }
    },
    [
      {
        eventId: WolfEvents.SpottedTarget,
        from: [WolfTransitions.Wander],
        to: WolfTransitions.Howling,
        EnterTransition: () => {
          wolf.npc.stopMovement();
          wolf.isHowling = false;
          wolf.howlTimer = 0;
          wolf.npc.setLookAtCharacter?.(wolf.targetCharacterId);
          alertNearbyWolves(wolf);
        }
      },
      {
        eventId: WolfEvents.HowlDone,
        from: [WolfTransitions.Howling],
        to: WolfTransitions.Chase,
        EnterTransition: () => {
          wolf.npc.setAnimation(AnimalsAnimation.Idle);
          wolf.stateTimer = 0;
          const target = getTarget(wolf);
          if (!target || !target.isAlive || !wolf.threatPos) {
            // The target can disappear during the howl animation.  Avoid a
            // one-tick stale sprint packet; enterWander() owns the stop edge.
            wolf.event(WolfEvents.LostTarget);
            return;
          }
          wolf.npc.setCombatAnimationMode?.(true);
          wolf.npc.setLookAtCharacter?.(wolf.targetCharacterId);
          const moveAccepted = moveToward(
            wolf.npc,
            target.position,
            wolf.server,
            wolf.targetCharacterId,
            CHASE_SPEED
          );
          if (!moveAccepted) {
            wolf.event(WolfEvents.LostTarget);
            return;
          }
          wolf.npc.setLocomotionMode?.("sprint");
          wolf.npc.setSpeed(CHASE_SPEED);
        }
      },
      {
        eventId: WolfEvents.AlertedByHowl,
        from: [WolfTransitions.Wander],
        to: WolfTransitions.Chase,
        EnterTransition: () => {
          wolf.stateTimer = 0;
          wolf.npc.setLookAtCharacter?.(wolf.targetCharacterId);
          const target = getTarget(wolf);
          if (!target || !target.isAlive || !wolf.threatPos) {
            // A howl alert can arrive in the same server tick that its
            // source target dies or disconnects.  Do not publish a sprint
            // edge for that stale alert; go straight through the normal
            // zero-speed cleanup boundary.
            wolf.event(WolfEvents.LostTarget);
            return;
          }
          wolf.npc.setCombatAnimationMode?.(true);
          const moveAccepted = moveToward(
            wolf.npc,
            target.position,
            wolf.server,
            wolf.targetCharacterId,
            CHASE_SPEED
          );
          if (!moveAccepted) {
            wolf.event(WolfEvents.LostTarget);
            return;
          }
          wolf.npc.setLocomotionMode?.("sprint");
          wolf.npc.setSpeed(CHASE_SPEED);
        }
      },
      {
        eventId: WolfEvents.ReachTarget,
        from: [WolfTransitions.Chase],
        to: WolfTransitions.Attack,
        EnterTransition: () => {
          wolf.npc.stopMovement();
          wolf.npc.setLocomotionMode?.("walk");
          wolf.stateTimer = 2;
        }
      },
      {
        eventId: WolfEvents.TargetBacked,
        from: [WolfTransitions.Attack],
        to: WolfTransitions.Chase,
        EnterTransition: () => {
          wolf.npc.setLocomotionMode?.("sprint");
          wolf.npc.setSpeed(CHASE_SPEED);
        }
      },
      {
        eventId: WolfEvents.StartAttacking,
        from: [WolfTransitions.Attack],
        to: WolfTransitions.Attacking,
        EnterTransition: () => {
          wolf.npc.stopMovement();
          const target = getTarget(wolf);
          wolf.attackForward = target
            ? getAttackForward(wolf.npc, target.position)
            : null;
          wolf.attackDamageApplied = false;
          const attackRange = getAttackRange(wolf);
          wolf.attackEnvelopeWasActive = target
            ? wolf.npc.isMeleeTargetInEnvelope?.(
                target.position,
                wolf.npc.state.position,
                undefined,
                attackRange
              ) ??
              (getDistance(wolf.npc.state.position, target.position) <=
                attackRange &&
                isFacingTarget(
                  wolf.npc.state.position,
                  wolf.npc.state.yaw ?? 0,
                  target.position
                ))
            : false;
          // AnimalsPhysics exposes KnifeSlash in its public event table;
          // the graph then selects the species-specific attack clip.
          wolf.npc.playAnimation(AnimalsAnimation.KnifeSlash);
          wolf.stateTimer = 0;
        }
      },
      {
        eventId: WolfEvents.DoneAttacking,
        from: [WolfTransitions.Attacking],
        to: WolfTransitions.Attack,
        EnterTransition: () => {
          wolf.attackForward = null;
          // KnifeSlash is a one-shot.  Re-assert the shared idle event at the
          // exact clip boundary so the native graph and a late observer both
          // leave the attack branch instead of waiting for an unrelated
          // movement/state edge to reset the pose.
          wolf.npc.setAnimation(AnimalsAnimation.Idle);
          wolf.stateTimer = 2;
        }
      },
      {
        eventId: WolfEvents.TargetKilled,
        from: [WolfTransitions.Attack],
        to: WolfTransitions.Wander,
        EnterTransition: () => enterWander(wolf)
      },
      {
        eventId: WolfEvents.LostTarget,
        from: [
          WolfTransitions.Howling,
          WolfTransitions.Chase,
          WolfTransitions.Attack,
          WolfTransitions.Attacking
        ],
        to: WolfTransitions.Wander,
        EnterTransition: () => enterWander(wolf)
      }
    ],
    WolfTransitions.Wander
  ) as unknown as WolfInstance;

  wolf.onTransition = (from: string, to: string, eventId: string) => {
    debug(`[wolf:${wolf.id}] ${from} → ${to} (${eventId})`);
  };
  wolf.id = npc.characterId;
  wolf.npc = npc;
  wolf.server = server;
  wolf.wanderOrigin = npc.state.position.slice() as Float32Array;
  wolf.patrolTimer = 0;
  wolf.stateTimer = 0;
  wolf.howlTimer = 0;
  wolf.isHowling = false;
  wolf.threatPos = null;
  wolf.targetCharacterId = null;
  wolf.attackForward = null;
  wolf.attackDamageApplied = false;
  wolf.attackEnvelopeWasActive = false;
  // Wander starts without a patrol target.  Avoid sending a moving gait
  // until Recast has accepted the first target and can produce displacement.
  npc.initializeAnimation?.(AnimalsAnimation.Idle);
  npc.setSpeed(0);
  return wolf;
}
