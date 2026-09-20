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
import { isHostile } from "./factions";
import { AnimalsAnimation } from "./wolf.jsm";

export const enum BearTransitions {
  Wander = "wander",
  StandingUp = "standingUp",
  Chase = "chase",
  Attack = "attack",
  Attacking = "attacking"
}

export const enum BearEvents {
  SpottedTarget = "spottedTarget",
  StandUpDone = "standUpDone",
  ReachTarget = "reachTarget",
  TargetBacked = "targetBacked",
  StartAttacking = "startAttacking",
  DoneAttacking = "doneAttacking",
  TargetKilled = "targetKilled",
  LostTarget = "lostTarget"
}

export interface BearInstance extends JSM<BearEvents> {
  id: string;
  state: BearTransitions;
  targetPos: Float32Array | null;
  wanderOrigin: Float32Array;
  patrolTimer: number;
  stateTimer: number;
  standUpTimer: number;
  isStandingUp: boolean;
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

const DETECT_RADIUS = 25;
const CHASE_LOSE_DIST = 60;
const ATTACK_RANGE = 2.5;
// AnimalsX64.mrn source clip:
// Animals_Bear001_RearUp = 160 frames at 30 FPS (5.333333 s).  Do not hand
// control back to the sprint graph while this public StandUp event is still
// playing; the old 2 s timer caused a visible walk/run handoff mid-pose.
const STANDUP_DURATION = 160 / 30;
const WANDER_SPEED = 3.25;
const CHASE_SPEED = 5;

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
    // CrowdAgent.requestMoveTarget() returns false when Recast rejects the
    // request (for example when the destination has no usable path).  Treat
    // that result as a failed locomotion transition: publishing sprint/expected
    // speed after a rejected request creates the exact stationary run/slide
    // window this FSM is meant to avoid.  Test doubles from the older harness
    // return void, so only an explicit false is considered rejection.
    if (npc.navAgent.requestMoveTarget(navTarget) === false) {
      npc.stopMovement();
      return false;
    }
  } catch {
    // A target can disappear between spatial selection and projection (or be
    // outside the loaded NavMesh).  Treat it like an explicit rejection.
    npc.stopMovement();
    return false;
  }
  // Use the retail seek controller as target/acceleration context while
  // Recast and PlayerUpdatePosition remain the authoritative server stream.
  // Patrol points do not have a character GUID and therefore do not install
  // a native seek rail.
  if (targetCharacterId) {
    npc.requestNativeSeekTarget?.(targetCharacterId, target, Date.now(), expectedSpeed);
  }
  return true;
}

function findTarget(bear: BearInstance): string | null {
  const sz = 50;
  const pos = bear.npc.state.position;
  const cx = Math.floor(pos[0] / sz);
  const cz = Math.floor(pos[2] / sz);
  let nearestId: string | null = null;
  let nearestDistance = DETECT_RADIUS;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const bucket = bear.server.aiTargetSpatialMap.get(
        `${cx + dx},${cz + dz}`
      );
      if (!bucket) continue;
      for (const entry of bucket) {
        if (entry.id === bear.npc.characterId) continue;
        if (!isHostile(bear.npc.faction, entry.faction)) continue;
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
  bear: BearInstance
): { position: Float32Array; isAlive: boolean } | null {
  if (!bear.targetCharacterId) return null;
  const player = bear.server._characters[bear.targetCharacterId];
  if (player) {
    if (player.isVanished || player.isHidden) return null;
    return { position: player.state.position, isAlive: player.isAlive };
  }
  const npc = bear.server._npcs[bear.targetCharacterId];
  if (npc) return { position: npc.state.position, isAlive: npc.isAlive };
  return null;
}

function applyDamageToTarget(bear: BearInstance): void {
  if (!bear.targetCharacterId) return;
  const character = bear.server._characters[bear.targetCharacterId];
  if (character?.isAlive) {
    bear.npc.applyDamage(bear.targetCharacterId);
    return;
  }
  const targetNpc = bear.server._npcs[bear.targetCharacterId];
  if (targetNpc && targetNpc.isAlive) {
    const damageInfo = {
      entity: bear.npc.characterId,
      damage: bear.npc.npcMeleeDamage
    };
    if (typeof targetNpc.applyNpcMeleeHit === "function") {
      targetNpc.applyNpcMeleeHit(bear.server, damageInfo);
    } else {
      // Lightweight AI test doubles and legacy NPC adapters may not expose
      // the presentation-aware helper yet; preserve their health-only path.
      targetNpc.damage(bear.server, damageInfo);
    }
  }
}

function getAttackRange(bear: BearInstance): number {
  return bear.npc.getMeleeAttackRange?.(ATTACK_RANGE) ?? ATTACK_RANGE;
}

function getAttackDistance(
  bear: BearInstance,
  targetPosition: Float32Array
): number {
  return (
    bear.npc.getMeleeTargetDistance?.(
      targetPosition,
      bear.npc.state.position
    ) ?? getDistance(bear.npc.state.position, targetPosition)
  );
}

function getAttackDuration(bear: BearInstance): number {
  return bear.npc.getMeleeAttackAnimationDuration?.(1) ?? 1;
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

function enterWander(bear: BearInstance): void {
  // A chase/attack transition can leave Recast with a non-zero desired
  // velocity.  Cancel it before publishing the walk state; otherwise the
  // client receives a walk stance while the authoritative agent still
  // carries the previous sprint impulse.
  bear.npc.stopMovement();
  bear.stateTimer = 0;
  bear.patrolTimer = 0;
  // A target can disappear during StandUp or after a completed swing.  The
  // next detection must start a fresh native wake one-shot; retaining these
  // flags would skip StandUp on the second encounter and hand the client
  // straight back to chase with a stale timer.
  bear.standUpTimer = 0;
  bear.isStandingUp = false;
  bear.targetCharacterId = null;
  bear.attackForward = null;
  bear.threatPos = null;
  bear.npc.lookAtTarget = null;
  bear.npc.setLookAtCharacter?.(null);
  bear.npc.setCombatAnimationMode?.(false);
  bear.npc.setLocomotionMode?.("walk");
  bear.npc.setAnimation(AnimalsAnimation.Idle);
  bear.wanderOrigin = bear.npc.state.position.slice() as Float32Array;
  bear.targetPos = null;
  // Do not advertise a walk before a patrol target has actually been
  // accepted by Recast.  A failed/late nav query must leave the animal in a
  // standing graph instead of producing a stationary walk/slide.
  bear.npc.setSpeed(0);
  const pt = pickPatrolPoint(bear.server, bear.wanderOrigin);
  if (pt) {
    bear.targetPos = pt;
    if (moveToward(bear.npc, pt, bear.server)) {
      bear.npc.setSpeed(WANDER_SPEED);
    } else {
      bear.targetPos = null;
    }
  }
}

export function createBear(npc: Npc, server: ZoneServer2016): BearInstance {
  // Keep the explicit AI engagement projection on the actor so diagnostics
  // and the production FSM consume the same value.  This is not a recovered
  // animal weapon hitbox; it is the current native-contact boundary until
  // the client weapon shape is mapped.
  npc.nativeMeleeEngagementRange = ATTACK_RANGE;
  const bear = new JSM(
    {
      [BearTransitions.Wander]: (dt: number) => {
        bear.stateTimer += dt;
        bear.patrolTimer += dt;

        const targetId = findTarget(bear);
        if (targetId !== null) {
          const target =
            bear.server._characters[targetId] ?? bear.server._npcs[targetId];
          bear.targetCharacterId = targetId;
          bear.threatPos = target.state.position.slice() as Float32Array;
          bear.event(BearEvents.SpottedTarget);
          return;
        }

        const arrived =
          bear.targetPos != null &&
          getDistance2d(bear.npc.state.position, bear.targetPos) < 3;

        if (arrived || bear.targetPos == null) {
          bear.patrolTimer = 0;
          const pt = pickPatrolPoint(bear.server, bear.wanderOrigin);
          if (pt) {
            bear.targetPos = pt;
            if (moveToward(bear.npc, pt, bear.server)) {
              bear.npc.setSpeed(WANDER_SPEED);
            } else {
              bear.targetPos = null;
              bear.npc.setSpeed(0);
            }
          } else {
            bear.targetPos = null;
            bear.npc.setSpeed(0);
          }
        }
      },

      [BearTransitions.StandingUp]: (dt: number) => {
        bear.npc.stopMovement();

        if (!bear.targetCharacterId) {
          bear.event(BearEvents.LostTarget);
          return;
        }
        const target = getTarget(bear);
        if (!target || !target.isAlive) {
          bear.event(BearEvents.LostTarget);
          return;
        }

        if (!bear.isStandingUp) {
          const vel = bear.npc.navAgent?.velocity();
          const speed = vel ? Math.sqrt(vel.x * vel.x + vel.z * vel.z) : 0;
          if (speed > 0.0) return;
          // StandUp is a public AnimalsPhysics event; Bear001 resolves it to
          // the BearStandUp/rear-up branch in the shared graph.
          bear.npc.playAnimation(AnimalsAnimation.StandUp);
          bear.isStandingUp = true;
          bear.standUpTimer = 0;
          return;
        }

        bear.standUpTimer += dt;
        // The FSM duration is derived from the same source clip, but the
        // client owns the actual PlayAnimation clock.  A coarse AI tick can
        // reach the logical duration a few milliseconds before that clock
        // expires; do not send Idle early and cut the rear-up pose short.
        const standUpClipActive =
          bear.npc.isAnimationActive?.(AnimalsAnimation.StandUp) ?? false;
        if (bear.standUpTimer >= STANDUP_DURATION && !standUpClipActive) {
          bear.event(BearEvents.StandUpDone);
        }
      },

      [BearTransitions.Chase]: (dt: number) => {
        bear.stateTimer += dt;
        bear.npc.setCombatAnimationMode?.(true);

        const target = getTarget(bear);
        if (!target || !target.isAlive) {
          bear.event(BearEvents.LostTarget);
          return;
        }

        bear.npc.lookAtTarget = target.position;
        const dist = getDistance2d(bear.npc.state.position, target.position);
        const attackRange = getAttackRange(bear);

        if (dist > CHASE_LOSE_DIST) {
          bear.event(BearEvents.LostTarget);
        } else if (dist < attackRange) {
          bear.event(BearEvents.ReachTarget);
        } else {
          // Only a valid, still-chased target may re-enable sprint.  If the
          // target vanished this tick, enterWander() owns the sole zero-speed
          // handoff instead of briefly publishing a stale chase speed first.
          const moveAccepted = moveToward(
            bear.npc,
            target.position,
            bear.server,
            bear.targetCharacterId,
            CHASE_SPEED
          );
          if (!moveAccepted) {
            bear.npc.stopMovement();
            bear.event(BearEvents.LostTarget);
            return;
          }
          bear.npc.setLocomotionMode?.("sprint");
          bear.npc.setSpeed(CHASE_SPEED);
        }
      },

      [BearTransitions.Attack]: (dt: number) => {
        bear.stateTimer += dt;
        // Keep the sprint graph while closing the final gap.  The transition
        // into Attacking stops navigation and publishes a standing sample.
        bear.npc.setCombatAnimationMode?.(true);

        const target = getTarget(bear);
        if (!target) {
          bear.event(BearEvents.LostTarget);
          return;
        }
        if (!target.isAlive) {
          bear.event(BearEvents.TargetKilled);
          return;
        }

        bear.npc.lookAtTarget = target.position;
        // Turn in place while the target is inside RANGE but outside the
        // weapon's lateral strike envelope.  Starting the swing from that
        // state used to make the bear play KnifeSlash beside the player.
        bear.npc.lookAt(target.position, dt);

        const dist = getAttackDistance(bear, target.position);
        const attackRange = getAttackRange(bear);
        if (dist >= attackRange) {
          const moveAccepted = moveToward(
            bear.npc,
            target.position,
            bear.server,
            bear.targetCharacterId,
            CHASE_SPEED
          );
          if (!moveAccepted) {
            bear.npc.stopMovement();
            bear.event(BearEvents.LostTarget);
            return;
          }
          bear.npc.setLocomotionMode?.("sprint");
          bear.event(BearEvents.TargetBacked);
        } else {
          // Inside the configured strike envelope the NPC must stop asking
          // Recast for forward motion.  Leaving the sprint intent active here
          // makes the client blend a chase graph into KnifeSlash and produces
          // the observed slide before the feet/attack pose settle.
          bear.npc.setLocomotionMode?.("walk");
          bear.npc.stopMovement();
          const inStrikeEnvelope =
            bear.npc.isMeleeTargetInEnvelope?.(
              target.position,
              bear.npc.state.position,
              undefined,
              attackRange
            ) ?? true;
          const unobstructed =
            bear.npc.hasMeleeLineOfSight?.(target.position) ?? true;
          if (bear.stateTimer > 2 && inStrikeEnvelope && unobstructed) {
            bear.event(BearEvents.StartAttacking);
          }
        }
      },

      [BearTransitions.Attacking]: (dt: number) => {
        const stateTimerBefore = bear.stateTimer;
        bear.stateTimer += dt;
        bear.npc.setCombatAnimationMode?.(true);

        const target = getTarget(bear);
        const attackDuration = getAttackDuration(bear);
        const contactWindow = bear.npc.getMeleeContactWindow?.();
        const contactStart = contactWindow
          ? attackDuration * contactWindow.startFraction
          : attackDuration;
        const contactEnd = contactWindow
          ? attackDuration * contactWindow.endFraction
          : attackDuration;
        // Damage is coupled to the same live one-shot that owns the client
        // pose.  If a reaction/recovery action replaced KnifeSlash, the FSM
        // timer can still be inside its old contact window, but that swing is
        // no longer the action the client is presenting and must not hit.
        // Legacy test doubles without the runtime contract remain permissive.
        const attackClipState = bear.npc.isAnimationActive?.(
          AnimalsAnimation.KnifeSlash
        );
        // SwingContact is an active interval in the native graph.  Treat a
        // tick that crosses the interval as contact too; otherwise one busy
        // server frame can jump from before SwingContact to after it and
        // silently lose the only hit opportunity for this swing.  The extra
        // duration guard prevents a very late tick from manufacturing a hit
        // after the native clip has already ended.
        const contactActive =
          (attackClipState ?? true) &&
          stateTimerBefore < attackDuration &&
          stateTimerBefore <= contactEnd &&
          bear.stateTimer >= contactStart;
        if (!bear.attackDamageApplied && contactActive) {
          if (target?.isAlive) {
            const dist = getAttackDistance(bear, target.position);
            const attackRange = getAttackRange(bear);
            const facingTarget = isFacingTarget(
              bear.npc.state.position,
              bear.npc.state.yaw ?? 0,
              target.position
            );
            const inStrikeEnvelope =
              bear.npc.isMeleeTargetInEnvelope?.(
                target.position,
                bear.npc.state.position,
                bear.attackForward ?? undefined,
                attackRange
              ) ??
              (dist <= attackRange && facingTarget);
            const unobstructed =
              bear.npc.hasMeleeLineOfSight?.(target.position) ?? true;
            // If one tick crosses the end of SwingContact, the current
            // sample may be a target that only entered the envelope after
            // contact had already closed.  A previous in-envelope sample is
            // required for that late-crossing case; entering during the
            // active interval remains valid.
            const crossedContactEnd =
              stateTimerBefore < contactEnd && bear.stateTimer > contactEnd;
            if (inStrikeEnvelope &&
              unobstructed &&
              (!crossedContactEnd || bear.attackEnvelopeWasActive)) {
              applyDamageToTarget(bear);
              bear.attackDamageApplied = true;
            }
            bear.attackEnvelopeWasActive = inStrikeEnvelope;
          } else {
            bear.attackEnvelopeWasActive = false;
          }
        } else if (target?.isAlive) {
          const dist = getAttackDistance(bear, target.position);
          const attackRange = getAttackRange(bear);
          const facingTarget = isFacingTarget(
            bear.npc.state.position,
            bear.npc.state.yaw ?? 0,
            target.position
          );
          bear.attackEnvelopeWasActive =
            bear.npc.isMeleeTargetInEnvelope?.(
              target.position,
              bear.npc.state.position,
              bear.attackForward ?? undefined,
              attackRange
            ) ?? (dist <= attackRange && facingTarget);
        } else {
          bear.attackEnvelopeWasActive = false;
        }
        if (bear.stateTimer >= attackDuration && !(attackClipState ?? false)) {
          bear.event(BearEvents.DoneAttacking);
        }
      }
    },
    [
      {
        eventId: BearEvents.SpottedTarget,
        from: [BearTransitions.Wander],
        to: BearTransitions.StandingUp,
        EnterTransition: () => {
          bear.npc.stopMovement();
          bear.isStandingUp = false;
          bear.standUpTimer = 0;
          bear.npc.setLookAtCharacter?.(bear.targetCharacterId);
        }
      },
      {
        eventId: BearEvents.StandUpDone,
        from: [BearTransitions.StandingUp],
        to: BearTransitions.Chase,
        EnterTransition: () => {
          bear.npc.setAnimation(AnimalsAnimation.Idle);
          bear.stateTimer = 0;
          const target = getTarget(bear);
          if (!target || !target.isAlive || !bear.threatPos) {
            // The target can disappear during the StandUp animation.  Do not
            // publish a sprint edge for that stale transition; let the normal
            // LostTarget -> enterWander cleanup own the zero-speed boundary.
            bear.event(BearEvents.LostTarget);
            return;
          }
          bear.npc.setCombatAnimationMode?.(true);
          bear.npc.setLookAtCharacter?.(bear.targetCharacterId);
          const moveAccepted = moveToward(
            bear.npc,
            target.position,
            bear.server,
            bear.targetCharacterId,
            CHASE_SPEED
          );
          if (!moveAccepted) {
            bear.event(BearEvents.LostTarget);
            return;
          }
          bear.npc.setLocomotionMode?.("sprint");
          bear.npc.setSpeed(CHASE_SPEED);
        }
      },
      {
        eventId: BearEvents.ReachTarget,
        from: [BearTransitions.Chase],
        to: BearTransitions.Attack,
        EnterTransition: () => {
          bear.npc.stopMovement();
          bear.npc.setLocomotionMode?.("walk");
          bear.stateTimer = 2;
        }
      },
      {
        eventId: BearEvents.TargetBacked,
        from: [BearTransitions.Attack],
        to: BearTransitions.Chase,
        EnterTransition: () => {
          bear.npc.setLocomotionMode?.("sprint");
          bear.npc.setSpeed(CHASE_SPEED);
        }
      },
      {
        eventId: BearEvents.StartAttacking,
        from: [BearTransitions.Attack],
        to: BearTransitions.Attacking,
        EnterTransition: () => {
          bear.npc.stopMovement();
          const target = getTarget(bear);
          bear.attackForward = target
            ? getAttackForward(bear.npc, target.position)
            : null;
          bear.attackDamageApplied = false;
          const attackRange = getAttackRange(bear);
          bear.attackEnvelopeWasActive = target
            ? bear.npc.isMeleeTargetInEnvelope?.(
                target.position,
                bear.npc.state.position,
                undefined,
                attackRange
              ) ??
              (getDistance(bear.npc.state.position, target.position) <=
                attackRange &&
                isFacingTarget(
                  bear.npc.state.position,
                  bear.npc.state.yaw ?? 0,
                  target.position
                ))
            : false;
          // AnimalsPhysics exposes KnifeSlash in its public event table;
          // Bear001 resolves it to the species-specific attack clip.
          bear.npc.playAnimation(AnimalsAnimation.KnifeSlash);
          bear.stateTimer = 0;
        }
      },
      {
        eventId: BearEvents.DoneAttacking,
        from: [BearTransitions.Attacking],
        to: BearTransitions.Attack,
        EnterTransition: () => {
          bear.attackForward = null;
          // KnifeSlash is a one-shot.  Re-assert the shared idle event at the
          // exact clip boundary so the native graph and a late observer both
          // leave the attack branch instead of waiting for an unrelated
          // movement/state edge to reset the pose.
          bear.npc.setAnimation(AnimalsAnimation.Idle);
          bear.stateTimer = 2;
        }
      },
      {
        eventId: BearEvents.TargetKilled,
        from: [BearTransitions.Attack],
        to: BearTransitions.Wander,
        EnterTransition: () => enterWander(bear)
      },
      {
        eventId: BearEvents.LostTarget,
        from: [
          BearTransitions.StandingUp,
          BearTransitions.Chase,
          BearTransitions.Attack,
          BearTransitions.Attacking
        ],
        to: BearTransitions.Wander,
        EnterTransition: () => enterWander(bear)
      }
    ],
    BearTransitions.Wander
  ) as unknown as BearInstance;

  bear.onTransition = (from: string, to: string, eventId: string) => {
    debug(`[bear:${bear.id}] ${from} → ${to} (${eventId})`);
  };
  bear.id = npc.characterId;
  bear.npc = npc;
  bear.server = server;
  bear.wanderOrigin = npc.state.position.slice() as Float32Array;
  bear.patrolTimer = 0;
  bear.stateTimer = 0;
  bear.standUpTimer = 0;
  bear.isStandingUp = false;
  bear.threatPos = null;
  bear.targetCharacterId = null;
  bear.attackForward = null;
  bear.attackDamageApplied = false;
  bear.attackEnvelopeWasActive = false;
  // The initial FSM state is Wander, but it has no target until the first
  // successful patrol query.  Keep the native locomotion graph idle during
  // that gap; the target-install path above publishes WANDER_SPEED.
  npc.initializeAnimation?.(AnimalsAnimation.Idle);
  npc.setSpeed(0);
  return bear;
}
