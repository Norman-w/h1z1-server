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

const WANDER_SPEED = 1.75;
const FLEE_SPEED = 5.0;

export const enum RabbitTransitions {
  Idle = "idle",
  Wander = "wander",
  Flee = "flee"
}

export const enum RabbitEvents {
  FinishedIdle = "finishedIdle",
  Arrived = "arrived",
  SpottedPlayer = "spottedPlayer",
  CalmedDown = "calmedDown",
  Destroyed = "destroyed"
}

export interface RabbitInstance extends JSM<RabbitEvents> {
  id: string;
  state: RabbitTransitions;
  targetPos: Float32Array | null;
  wanderOrigin: Float32Array;
  stateTimer: number;
  idleDuration: number;
  fleeCooldown: number;
  threatPos: Float32Array | null;
  npc: Npc;
  server: ZoneServer2016;
}

function pickIdleDuration(): number {
  // brief idle between wanders
  return 2 + Math.random() * 3;
}

function pickWanderPoint(
  server: ZoneServer2016,
  center: Float32Array
): Float32Array | null {
  const navCenter = NavManager.gameToNav(center);
  const { success, randomPoint } =
    server.navManager.navMeshQuery.findRandomPointAroundCircle(navCenter, 30);
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
    // Preserve the server/client locomotion contract when Recast rejects a
    // target: no accepted path means no flee speed or sprint stance.
    if (npc.navAgent.requestMoveTarget(navTarget) === false) {
      npc.stopMovement();
      return false;
    }
    return true;
  } catch {
    // Treat an off-mesh projection like an explicit Recast rejection.
    npc.stopMovement();
    return false;
  }
}

function installFleeTarget(rabbit: RabbitInstance): boolean {
  if (!rabbit.threatPos) return false;
  const fleeTarget = pickFleePoint(
    rabbit.npc,
    rabbit.server,
    rabbit.threatPos
  );
  if (!fleeTarget || !moveToward(rabbit.npc, fleeTarget, rabbit.server)) {
    rabbit.targetPos = null;
    return false;
  }
  rabbit.targetPos = fleeTarget;
  return true;
}

function findThreat(
  rabbit: RabbitInstance,
  radius: number
): Float32Array | null {
  const sz = 50;
  const pos = rabbit.npc.state.position;
  const cx = Math.floor(pos[0] / sz);
  const cz = Math.floor(pos[2] / sz);
  let nearest: Float32Array | null = null;
  let nearestDistance = radius;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const bucket = rabbit.server.aiTargetSpatialMap.get(
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

export function createRabbit(npc: Npc, server: ZoneServer2016): RabbitInstance {
  const rabbit = new JSM(
    {
      [RabbitTransitions.Idle]: (dt: number) => {
        rabbit.stateTimer += dt;
        // Idle has no nav target.  Keep the client locomotion input at zero
        // instead of leaving the previous wander speed attached to a
        // standing stance; ExpectedSpeed is consumed by the native graph
        // independently of the next position sample.
        rabbit.npc.setLocomotionMode?.("walk");
        rabbit.npc.setSpeed(0);
        if (rabbit.fleeCooldown > 0) rabbit.fleeCooldown -= dt;

        const idleThreat = findThreat(rabbit, 10);
        if (idleThreat && rabbit.fleeCooldown <= 0) {
          rabbit.threatPos = idleThreat.slice() as Float32Array;
          rabbit.event(RabbitEvents.SpottedPlayer);
          return;
        }

        if (rabbit.stateTimer >= rabbit.idleDuration) {
          rabbit.event(RabbitEvents.FinishedIdle);
        }
      },

      [RabbitTransitions.Wander]: (dt: number) => {
        rabbit.stateTimer += dt;
        rabbit.npc.setLocomotionMode?.("walk");
        // A failed/late patrol query leaves Wander without a target.  Do not
        // advertise a moving gait for that one-tick gap: the native graph
        // would receive walk intent while the authoritative nav agent has no
        // destination, which is the same stationary-walk/slide edge we avoid
        // for the other animals.
        if (!rabbit.targetPos) {
          rabbit.event(RabbitEvents.Arrived);
          return;
        }
        rabbit.npc.setSpeed(WANDER_SPEED);
        if (rabbit.fleeCooldown > 0) rabbit.fleeCooldown -= dt;

        const wanderThreat = findThreat(rabbit, 20);
        if (wanderThreat && rabbit.fleeCooldown <= 0) {
          rabbit.threatPos = wanderThreat.slice() as Float32Array;
          rabbit.event(RabbitEvents.SpottedPlayer);
          return;
        }

        const arrived =
          rabbit.targetPos != null &&
          getDistance2d(rabbit.npc.state.position, rabbit.targetPos) < 3;
        if (arrived || rabbit.targetPos == null || rabbit.stateTimer >= 8) {
          rabbit.event(RabbitEvents.Arrived);
        }
      },

      [RabbitTransitions.Flee]: (dt: number) => {
        rabbit.stateTimer += dt;

        const fleeThreat = findThreat(rabbit, 35);
        if (fleeThreat) {
          rabbit.threatPos = fleeThreat.slice() as Float32Array;
        }

        if (!fleeThreat || rabbit.stateTimer >= 10) {
          // Let CalmedDown own the sprint -> idle edge.  Advertising another
          // flee speed before stopMovement() would briefly re-enter the run
          // graph after the threat was already gone.
          rabbit.event(RabbitEvents.CalmedDown);
          return;
        }

        const arrivedAtFlee =
          rabbit.targetPos != null &&
          getDistance2d(rabbit.npc.state.position, rabbit.targetPos) < 3;
        if (!rabbit.targetPos || arrivedAtFlee) {
          installFleeTarget(rabbit);
        }
        if (!rabbit.targetPos) {
          // Do not advertise a sprint without an accepted flee path.  This
          // keeps a failed nav request from becoming an in-place run/slide.
          rabbit.npc.setLocomotionMode?.("walk");
          rabbit.npc.setSpeed(0);
          return;
        }
        rabbit.npc.setLocomotionMode?.("sprint");
        rabbit.npc.setSpeed(FLEE_SPEED);
      }
    },
    [
      {
        eventId: RabbitEvents.FinishedIdle,
        from: [RabbitTransitions.Idle],
        to: RabbitTransitions.Wander,
        EnterTransition: () => {
          rabbit.stateTimer = 0;
          rabbit.npc.setLocomotionMode?.("walk");
          // Publish the walk speed only after a valid patrol target and nav
          // request have both been accepted.
          rabbit.npc.setSpeed(0);
          const pt = pickWanderPoint(rabbit.server, rabbit.wanderOrigin);
          if (pt) {
            rabbit.targetPos = pt;
            if (moveToward(rabbit.npc, pt, rabbit.server)) {
              rabbit.npc.setSpeed(WANDER_SPEED);
            } else {
              rabbit.targetPos = null;
              rabbit.npc.setSpeed(0);
            }
          } else {
            rabbit.targetPos = null;
            rabbit.npc.setSpeed(0);
          }
        }
      },
      {
        eventId: RabbitEvents.Arrived,
        from: [RabbitTransitions.Wander],
        to: RabbitTransitions.Idle,
        EnterTransition: () => {
          // Arriving or calming cancels the previous flee path.  Without an
          // explicit stop the nav target survives the FSM transition and the
          // rabbit keeps sliding while its logical state is Idle.
          rabbit.npc.stopMovement();
          rabbit.stateTimer = 0;
          rabbit.npc.setLocomotionMode?.("walk");
          rabbit.npc.setSpeed(0);
          rabbit.idleDuration = pickIdleDuration();
          rabbit.targetPos = null;
          rabbit.wanderOrigin =
            rabbit.npc.state.position.slice() as Float32Array;
        }
      },
      {
        eventId: RabbitEvents.SpottedPlayer,
        from: [RabbitTransitions.Idle, RabbitTransitions.Wander],
        to: RabbitTransitions.Flee,
        EnterTransition: () => {
          rabbit.stateTimer = 0;
          rabbit.npc.stopMovement();
          rabbit.targetPos = null;
          if (installFleeTarget(rabbit)) {
            rabbit.npc.setLocomotionMode?.("sprint");
            rabbit.npc.setSpeed(FLEE_SPEED);
          } else {
            rabbit.npc.setLocomotionMode?.("walk");
            rabbit.npc.setSpeed(0);
          }
        }
      },
      {
        eventId: RabbitEvents.CalmedDown,
        from: [RabbitTransitions.Flee],
        to: RabbitTransitions.Idle,
        EnterTransition: () => {
          rabbit.npc.stopMovement();
          rabbit.stateTimer = 0;
          rabbit.npc.setLocomotionMode?.("walk");
          rabbit.npc.setSpeed(0);
          rabbit.idleDuration = pickIdleDuration();
          rabbit.fleeCooldown = 4;
          rabbit.threatPos = null;
          rabbit.targetPos = null;
          rabbit.wanderOrigin =
            rabbit.npc.state.position.slice() as Float32Array;
        }
      }
    ],
    RabbitTransitions.Idle
  ) as unknown as RabbitInstance;

  rabbit.onTransition = (from: string, to: string, eventId: string) => {
    debug(`[${rabbit.id}] ${from} → ${to} (${eventId})`);
  };
  rabbit.id = npc.characterId;
  rabbit.npc = npc;
  rabbit.server = server;
  rabbit.wanderOrigin = npc.state.position.slice() as Float32Array;
  rabbit.stateTimer = 0;
  rabbit.idleDuration = pickIdleDuration();
  rabbit.fleeCooldown = 0;
  rabbit.threatPos = null;
  rabbit.npc.setLocomotionMode?.("walk");
  // The initial FSM state is Idle, so do not advertise a walking speed until
  // FinishedIdle installs the first wander target.
  npc.initializeAnimation?.("Idle");
  npc.setSpeed(0);
  return rabbit;
}
