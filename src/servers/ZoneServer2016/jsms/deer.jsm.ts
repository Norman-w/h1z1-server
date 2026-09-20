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
import { getDistance2d } from "../../../utils/utils";
import { isThreatToPassive } from "./factions";

const WANDER_SPEED = 3.0;
const FLEE_SPEED = 7.0;

export const enum AnimalsAnimation {
  Idle = "Idle",
  KnifeSlash = "KnifeSlash",
  Flinch = "Flinch",
  Death = "Death",
  WolfHowl = "WolfHowl",
  StandUp = "StandUp",
  Eating = "Eating",
  DeathRagdoll = "DeathRagdoll",
  DeathRagdollAnywhere = "DeathRagdollAnywhere",
  DeathPose = "DeathPose",
  Roar = "Roar",
  MeleeFlinch = "MeleeFlinch"
}

export const enum DeerTransitions {
  Wander = "wander",
  Flee = "flee"
}

export const enum DeerEvents {
  SpottedPlayer = "spottedPlayer",
  CalmedDown = "calmedDown",
  Destroyed = "destroyed"
}

export interface DeerInstance extends JSM<DeerEvents> {
  id: string;
  state: DeerTransitions;
  targetPos: Float32Array | null;
  wanderOrigin: Float32Array;
  patrolTimer: number;
  stateTimer: number;
  fleeCooldown: number;
  threatPos: Float32Array | null;
  npc: Npc;
  server: ZoneServer2016;
}

function pickPatrolPoint(
  server: ZoneServer2016,
  center: Float32Array
): Float32Array | null {
  const navCenter = NavManager.gameToNav(center);
  const { success, randomPoint } =
    server.navManager.navMeshQuery.findRandomPointAroundCircle(navCenter, 60);
  return success ? NavManager.navToGame(randomPoint) : null;
}

function pickFleePoint(
  npc: Npc,
  server: ZoneServer2016,
  threatPos: Float32Array
): Float32Array | null {
  const dx = npc.state.position[0] - threatPos[0];
  const dz = npc.state.position[2] - threatPos[2];
  const len = Math.sqrt(dx * dx + dz * dz) || 1;
  const fleeCenter = new Float32Array([
    npc.state.position[0] + (dx / len) * 50,
    npc.state.position[1],
    npc.state.position[2] + (dz / len) * 50,
    0
  ]);
  const navCenter = NavManager.gameToNav(fleeCenter);
  const { success, randomPoint } =
    server.navManager.navMeshQuery.findRandomPointAroundCircle(navCenter, 15);
  return success ? NavManager.navToGame(randomPoint) : fleeCenter;
}

function moveToward(
  npc: Npc,
  target: Float32Array,
  server: ZoneServer2016
): boolean {
  if (!npc.navAgent) return false;
  try {
    const navTarget = server.navManager.getClosestNavPointVec3(target);
    // Recast returns false when it cannot install the target.  A passive
    // animal must remain stopped in that case instead of advertising flee
    // sprint while its authoritative position does not advance.
    if (npc.navAgent.requestMoveTarget(navTarget) === false) {
      npc.stopMovement();
      return false;
    }
    return true;
  } catch {
    // A missing/off-mesh projection is also a failed flee installation.
    npc.stopMovement();
    return false;
  }
}

function installFleeTarget(deer: DeerInstance): boolean {
  if (!deer.threatPos) return false;
  const fleeTarget = pickFleePoint(deer.npc, deer.server, deer.threatPos);
  if (!fleeTarget || !moveToward(deer.npc, fleeTarget, deer.server)) {
    deer.targetPos = null;
    return false;
  }
  deer.targetPos = fleeTarget;
  return true;
}

function findThreat(deer: DeerInstance, radius: number): Float32Array | null {
  const sz = 50;
  const pos = deer.npc.state.position;
  const cx = Math.floor(pos[0] / sz);
  const cz = Math.floor(pos[2] / sz);
  let nearest: Float32Array | null = null;
  let nearestDistance = radius;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const bucket = deer.server.aiTargetSpatialMap.get(
        `${cx + dx},${cz + dz}`
      );
      if (!bucket) continue;
      for (const entry of bucket) {
        if (!isThreatToPassive(entry.faction)) continue;
        const distance = getDistance2d(pos, entry.position);
        if (distance < nearestDistance) {
          nearest = entry.position;
          nearestDistance = distance;
        }
      }
    }
  }
  return nearest;
}

export function createDeer(npc: Npc, server: ZoneServer2016): DeerInstance {
  const deer = new JSM(
    {
      [DeerTransitions.Wander]: (dt: number) => {
        deer.stateTimer += dt;
        if (deer.fleeCooldown > 0) deer.fleeCooldown -= dt;

        const wanderThreat = findThreat(deer, 20);
        if (wanderThreat && deer.fleeCooldown <= 0) {
          deer.threatPos = wanderThreat.slice() as Float32Array;
          deer.event(DeerEvents.SpottedPlayer);
          return;
        }

        deer.patrolTimer += dt;
        const arrived =
          deer.targetPos != null &&
          getDistance2d(deer.npc.state.position, deer.targetPos) < 3;

        if (arrived || deer.targetPos == null) {
          deer.patrolTimer = 0;
          const pt = pickPatrolPoint(deer.server, deer.wanderOrigin);
          if (pt) {
            deer.targetPos = pt;
            if (moveToward(deer.npc, pt, deer.server)) {
              deer.npc.setSpeed(WANDER_SPEED);
            } else {
              deer.targetPos = null;
              deer.npc.setSpeed(0);
            }
          } else {
            deer.targetPos = null;
            deer.npc.setSpeed(0);
          }
        }
      },

      [DeerTransitions.Flee]: (dt: number) => {
        deer.stateTimer += dt;

        const fleeThreat = findThreat(deer, 35);
        if (fleeThreat) {
          deer.threatPos = fleeThreat.slice() as Float32Array;
        }

        if (!fleeThreat || deer.stateTimer >= 10) {
          // Do not publish one more sprint intent on the same tick that the
          // threat has disappeared.  The transition's stopMovement() is the
          // single sprint -> idle handoff; sending FLEE_SPEED first creates a
          // transient run/slide before the zero-speed packet.
          deer.event(DeerEvents.CalmedDown);
          return;
        }

        const arrivedAtFlee =
          deer.targetPos != null &&
          getDistance2d(deer.npc.state.position, deer.targetPos) < 3;
        if (!deer.targetPos || arrivedAtFlee) {
          installFleeTarget(deer);
        }
        if (!deer.targetPos) {
          // A missing nav agent/target is not a valid run state.  Keep the
          // animal standing until a real flee path can be installed.
          deer.npc.setLocomotionMode?.("walk");
          deer.npc.setSpeed(0);
          return;
        }
        deer.npc.setLocomotionMode?.("sprint");
        deer.npc.setSpeed(FLEE_SPEED);
      }
    },
    [
      {
        eventId: DeerEvents.SpottedPlayer,
        from: [DeerTransitions.Wander],
        to: DeerTransitions.Flee,
        EnterTransition: () => {
          deer.stateTimer = 0;
          deer.npc.stopMovement();
          deer.targetPos = null;
          if (installFleeTarget(deer)) {
            deer.npc.setLocomotionMode?.("sprint");
            deer.npc.setSpeed(FLEE_SPEED);
          } else {
            deer.npc.setLocomotionMode?.("walk");
            deer.npc.setSpeed(0);
          }
        }
      },
      {
        eventId: DeerEvents.CalmedDown,
        from: [DeerTransitions.Flee],
        to: DeerTransitions.Wander,
        EnterTransition: () => {
          // Flee can be moving when the threat leaves.  Stop the old sprint
          // target before handing the animal back to the walk graph.
          deer.npc.stopMovement();
          deer.patrolTimer = 0;
          deer.stateTimer = 0;
          deer.npc.setLocomotionMode?.("walk");
          deer.npc.setSpeed(0);
          deer.fleeCooldown = 4;
          deer.threatPos = null;
          deer.targetPos = null;
          deer.wanderOrigin = deer.npc.state.position.slice() as Float32Array;
          const pt = pickPatrolPoint(deer.server, deer.wanderOrigin);
          if (pt) {
            deer.targetPos = pt;
            if (moveToward(deer.npc, pt, deer.server)) {
              deer.npc.setSpeed(WANDER_SPEED);
            } else {
              deer.targetPos = null;
            }
          }
          if (!deer.targetPos) deer.npc.setSpeed(0);
        }
      }
    ],
    DeerTransitions.Wander
  ) as unknown as DeerInstance;

  deer.onTransition = (from: string, to: string, eventId: string) => {
    debug(`[${deer.id}] ${from} → ${to} (${eventId})`);
  };
  deer.id = npc.characterId;
  deer.npc = npc;
  deer.server = server;
  deer.wanderOrigin = npc.state.position.slice() as Float32Array;
  deer.patrolTimer = 0;
  deer.stateTimer = 0;
  deer.fleeCooldown = 0;
  deer.threatPos = null;
  deer.npc.setLocomotionMode?.("walk");
  // Wander has no target until the first successful patrol lookup.  Publish
  // zero until then so a freshly spawned deer cannot advertise walking while
  // its position is still stationary.
  npc.initializeAnimation?.(AnimalsAnimation.Idle);
  npc.setSpeed(0);
  return deer;
}
