import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ZoneServer2016 } from "./zoneserver";
import type { ZoneClient2016 } from "./classes/zoneclient";
import type { Npc } from "./entities/npc";
import type { SpawnTestZombieOptions, spawnTestZombieForClient } from "./test-zombie-in-front";

const LEASE_MS = 120000;
const MAX_REQUESTS = 128;
// Experimental stalled-chase exit, not native collision or delivery evidence.
const ROUTE_NO_PROGRESS_MS = 3000;
const ROUTE_MIN_PROGRESS_XZ = 0.05;
// Receipt-only experiment bounds, not an animation/behavior delay.
const NPC_INGRESS_WINDOW_MS = 30000;
const NPC_INGRESS_MAX_RECORDS = 256;
const PLAYER_MOTION_WINDOW_MS = 30000;
const PLAYER_MOTION_MAX_INBOUND = 128;
const PLAYER_MOTION_MAX_OUTBOUND = 32;
type State = "preparing" | "waiting_full_data" | "waiting_ready" | "paused" |
  "start_requested" | "running" | "finished" | "failed";
type MovementMode = "server" | "client-seek" | "mixed";
type Prepare = {
  action: "prepare"; target: string; requestId: string;
  expectedPlayerCharacterId: string; expectedNpcCharacterId: string | null;
  distance: number; knownObstacle?: "fence-192060"; movementMode?: MovementMode;
  observeNpcIngress?: true; observePlayerMotion?: true;
};
type Control = {
  action: "start" | "finish"; target: string; replayId: string;
  expectedNpcCharacterId: string | null;
};

export class TestZombieReplayError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

function requireValue(condition: unknown, message: string, status = 409): asserts condition {
  if (!condition) throw new TestZombieReplayError(status, message);
}

function token(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

/** Closed experiment schema: bounded distance or one named six-metre fence recipe; no raw overrides. */
export function parseTestZombieReplayRequest(value: unknown): Prepare | Control {
  requireValue(value && typeof value === "object" && !Array.isArray(value), "object_required", 400);
  const body = value as Record<string, unknown>;
  requireValue(typeof body.action === "string" && ["prepare", "start", "finish"].includes(body.action), "invalid_action", 400);
  const fields = body.action === "prepare"
    ? ["action", "target", "requestId", "expectedPlayerCharacterId", "expectedNpcCharacterId"]
    : ["action", "target", "replayId", "expectedNpcCharacterId"];
  const hasDistance = Object.prototype.hasOwnProperty.call(body, "distance");
  const hasKnownObstacle = Object.prototype.hasOwnProperty.call(body, "knownObstacle");
  const hasMovementMode = Object.prototype.hasOwnProperty.call(body, "movementMode");
  const hasIngress = Object.prototype.hasOwnProperty.call(body, "observeNpcIngress");
  const hasPlayerMotion = Object.prototype.hasOwnProperty.call(body, "observePlayerMotion");
  if (body.action === "prepare" && hasDistance) fields.push("distance");
  if (body.action === "prepare" && hasKnownObstacle) fields.push("knownObstacle");
  if (body.action === "prepare" && hasMovementMode) fields.push("movementMode");
  if (body.action === "prepare" && hasIngress) fields.push("observeNpcIngress");
  if (body.action === "prepare" && hasPlayerMotion) fields.push("observePlayerMotion");
  requireValue(Object.keys(body).length === fields.length && fields.every(key => Object.prototype.hasOwnProperty.call(body, key)), "unknown_or_missing_fields", 400);
  requireValue(typeof body.target === "string" && /^(0|[1-9][0-9]{0,9})$/.test(body.target), "exact_session_target_required", 400);
  requireValue(body.expectedNpcCharacterId === null || token(body.expectedNpcCharacterId), "invalid_expected_npc", 400);
  if (body.action === "prepare") {
    requireValue(token(body.requestId) && token(body.expectedPlayerCharacterId), "invalid_prepare_identity", 400);
    requireValue(!hasDistance || (typeof body.distance === "number" && Number.isFinite(body.distance) &&
      body.distance >= 6 && body.distance <= 12), "distance_must_be_finite_6_to_12", 400);
    requireValue(!hasKnownObstacle || body.knownObstacle === "fence-192060", "invalid_known_obstacle", 400);
    requireValue(!hasKnownObstacle || !hasDistance || body.distance === 6, "known_obstacle_distance_must_be_6", 400);
    requireValue(!hasMovementMode || body.movementMode === "server" || body.movementMode === "client-seek" || body.movementMode === "mixed",
      "invalid_movement_mode", 400);
    requireValue(body.movementMode !== "client-seek" || !hasKnownObstacle,
      "client_seek_known_obstacle_not_supported", 400);
    requireValue(!hasIngress || typeof body.observeNpcIngress === "boolean", "observe_npc_ingress_must_be_boolean", 400);
    requireValue(!hasPlayerMotion || typeof body.observePlayerMotion === "boolean", "observe_player_motion_must_be_boolean", 400);
  } else {
    requireValue(token(body.replayId), "invalid_replay_id", 400);
  }
  // Canonical order/default also make omitted distance and explicit 6 idempotent.
  return (body.action === "prepare" ? {
    action: body.action, target: body.target, requestId: body.requestId,
    expectedPlayerCharacterId: body.expectedPlayerCharacterId, expectedNpcCharacterId: body.expectedNpcCharacterId,
    distance: hasDistance ? body.distance : 6,
    ...(hasKnownObstacle ? { knownObstacle: body.knownObstacle } : {}),
    ...(hasMovementMode ? { movementMode: body.movementMode } : {}),
    ...(body.observeNpcIngress === true ? { observeNpcIngress: true } : {}),
    ...(body.observePlayerMotion === true ? { observePlayerMotion: true } : {})
  } : { action: body.action, target: body.target, replayId: body.replayId, expectedNpcCharacterId: body.expectedNpcCharacterId }) as Prepare | Control;
}

interface NpcIngressRecord {
  utcMs: number; monotonicMs: number; flags: number | null;
  parseError: boolean | null;
  sequenceTime: number | null; movementVersion: number | null;
  position: number[] | null; horizontalSpeed: number | null; verticalSpeed: number | null;
}

interface NpcIngressObservation {
  npc?: Npc; npcCharacterId?: string; transientId?: number;
  startedAt?: number; deadline?: number; lastObserved?: number;
  stoppedReason?: string; matchedPackets: number; records: NpcIngressRecord[];
}

const motionInteger = (value: unknown, maximum = 0xffffffff): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum ? value : null;
const motionVector = (value: unknown): number[] | null =>
  (Array.isArray(value) || value instanceof Float32Array) && (value.length === 3 || value.length === 4) &&
  Array.from(value).every(v => typeof v === "number" && Number.isFinite(v)) ? Array.from(value) as number[] : null;
interface PlayerMotionInbound {
  utcMs: number; monotonicMs: number; flags: number | null; parseError: boolean | null;
  position: number[] | null; stance: number | null; sequenceTime: number | null; movementVersion: number | null;
  positionAtReceipt: number[] | null; positionBefore: number[] | null; positionAfter: number[] | null;
  assigned: boolean; assignmentOutsideWindow: boolean | null;
}
interface PlayerMotionOutbound {
  utcMs: number; monotonicMs: number; packetName: "ClientUpdate.UpdateLocation" | "Character.Knockback";
  source: "typed" | "raw"; phase: "send_attempt"; transportOutcome: "not_observed";
  layout: "typed_fields" | "parsed_fixed_wire" | "layout_unknown"; wireLength: number | null; rawPrefix: string | null;
  position: number[] | null; movementVersion: number | null; triggerLoadingScreen: boolean | null;
  vector1: number[] | null; vector2: number[] | null; dword1: number | null; dword2: number | null;
}
interface PlayerMotionObservation {
  startedAt?: number; deadline?: number; lastObserved?: number; stoppedReason?: string;
  inboundCount: number; outboundCount: number; inbound: PlayerMotionInbound[]; outbound: PlayerMotionOutbound[];
}

interface Lease {
  replayId: string; request: Prepare; state: State; reason?: string;
  createdAt: number; expiresAt: number; fullDataAt?: number; pausedAt?: number; startedAt?: number; finishedAt?: number;
  client: ZoneClient2016; character: ZoneClient2016["character"];
  playerPosition: Float32Array; oldNpc: Npc | undefined; npc?: Npc;
  previousGodMode: boolean; protectionApplied: boolean; released: boolean;
  cleanupError?: string;
  spawnTaskStarted?: boolean;
  spawnTaskPending?: boolean;
  prestartPositionFailure?: { observedAt: number; prepared: number[]; current: number[] | null;
    deltaXZ: number | null; receipt: { count: number; sequenceTime: number; movementVersion: number;
      flags: number; position: readonly number[]; sameCharacter: boolean } | null };
  routeResource?: Npc["testRouteResource"];
  disposeRoute?: () => void;
  routeDisposalAttempted?: boolean;
  routeDisposalFailed?: boolean;
  progress?: { x: number; z: number; since: number; lastObserved: number };
  timer?: ReturnType<typeof setInterval>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  npcIngress?: NpcIngressObservation;
  playerMotion?: PlayerMotionObservation;
}

/** Local solo experiment only. It owns a lease/NPC, never the general AI loop. */
export class TestZombieReplay {
  private active?: Lease;
  private last?: Lease;
  private requestIds = new Set<string>();
  private disposed = false;
  private cleanupBlocked = false;
  // The incoming packet has only a transient ID, not a GUID/run nonce.
  private readonly observedIngressTransients = new Set<number>();

  constructor(
    private readonly zone: ZoneServer2016,
    private readonly spawn: typeof spawnTestZombieForClient,
    private readonly terrain: () => NonNullable<SpawnTestZombieOptions["terrain"]>,
    private readonly monotonicNow: () => number = () => performance.now()
  ) {}

  getStatus(): object {
    const lease = this.active ?? this.last;
    return {
      experiment: "local-terrain-locomotion-replay", distance: lease?.request.distance ?? 6,
      movementMode: lease?.request.movementMode ?? "server", profileId: 10, speedScale: 1,
      ...(lease?.request.knownObstacle ? { knownObstacle: lease.request.knownObstacle, otherCollisionCoverage: "unknown" } : {}),
      rendered: "not_observed_by_this_api",
      ...(lease ? {
        state: lease.state, replayId: lease.replayId, requestId: lease.request.requestId,
        target: lease.request.target, playerCharacterId: lease.request.expectedPlayerCharacterId,
        replacedNpcCharacterId: lease.request.expectedNpcCharacterId,
        npcCharacterId: lease.npc?.characterId ?? null, transientId: lease.npc?.transientId ?? null,
        createdAt: lease.createdAt, expiresAt: lease.expiresAt,
        fullDataAt: lease.fullDataAt ?? null, pausedAt: lease.pausedAt ?? null,
        startedAt: lease.startedAt ?? null, finishedAt: lease.finishedAt ?? null,
        protectionApplied: lease.protectionApplied, previousGodMode: lease.previousGodMode,
        reason: lease.reason ?? null, cleanupError: lease.cleanupError ?? null,
        spawnTaskPending: lease.spawnTaskPending === true,
        routeDisposalFailed: lease.routeDisposalFailed === true,
        playerPosition: Array.from(lease.playerPosition),
        prestartPositionFailure: lease.prestartPositionFailure ?? null,
        ...(lease.npcIngress ? { npcIngress: {
          scope: "parsed_npc_ingress_receipts_only_not_position_authority_or_native_animation",
          replayId: lease.replayId, requestId: lease.request.requestId,
          target: lease.request.target, playerCharacterId: lease.request.expectedPlayerCharacterId,
          npcCharacterId: lease.npcIngress.npcCharacterId ?? null,
          transientId: lease.npcIngress.transientId ?? null,
          windowMs: NPC_INGRESS_WINDOW_MS, maxRecords: NPC_INGRESS_MAX_RECORDS,
          startedMonotonicMs: lease.npcIngress.startedAt ?? null,
          deadlineMonotonicMs: lease.npcIngress.deadline ?? null,
          stoppedReason: lease.npcIngress.stoppedReason ?? null,
          matchedPackets: lease.npcIngress.matchedPackets,
          truncated: lease.npcIngress.matchedPackets > lease.npcIngress.records.length,
          records: lease.npcIngress.records.map(record => ({ ...record, position: record.position?.slice() ?? null }))
        } } : {}),
        ...(lease.playerMotion ? { playerMotion: {
          scope: "owned_player_parsed_ingress_assignment_and_selected_send_attempts_not_delivery_or_all_state_writers",
          windowMs: PLAYER_MOTION_WINDOW_MS, maxInbound: PLAYER_MOTION_MAX_INBOUND, maxOutbound: PLAYER_MOTION_MAX_OUTBOUND,
          inboundRetention: "last128", outboundRetention: "first32",
          assignmentScope: "assigned_true_requires_after_hook_false_alone_does_not_prove_no_write",
          startedMonotonicMs: lease.playerMotion.startedAt ?? null, deadlineMonotonicMs: lease.playerMotion.deadline ?? null,
          stoppedReason: lease.playerMotion.stoppedReason ?? null,
          inboundCount: lease.playerMotion.inboundCount, outboundCount: lease.playerMotion.outboundCount,
          droppedInbound: lease.playerMotion.inboundCount - lease.playerMotion.inbound.length,
          droppedOutbound: lease.playerMotion.outboundCount - lease.playerMotion.outbound.length,
          truncated: lease.playerMotion.inboundCount > lease.playerMotion.inbound.length || lease.playerMotion.outboundCount > lease.playerMotion.outbound.length,
          inbound: lease.playerMotion.inbound.map(r => ({ ...r, position: r.position?.slice() ?? null,
            positionAtReceipt: r.positionAtReceipt?.slice() ?? null, positionBefore: r.positionBefore?.slice() ?? null,
            positionAfter: r.positionAfter?.slice() ?? null })),
          outbound: lease.playerMotion.outbound.map(r => ({ ...r, position: r.position?.slice() ?? null,
            vector1: r.vector1?.slice() ?? null, vector2: r.vector2?.slice() ?? null }))
        } } : {})
      } : { state: "idle" })
    };
  }

  handle(value: unknown): object {
    const request = parseTestZombieReplayRequest(value);
    requireValue(!this.disposed, "replay_controller_stopped");
    requireValue(this.zone._soloMode === true, "solo_server_required");
    if (request.action === "prepare") {
      requireValue(!this.cleanupBlocked, "previous_cleanup_incomplete");
      return this.prepare(request);
    }
    const lease = this.active ?? this.last;
    requireValue(lease && lease.replayId === request.replayId && lease.request.target === request.target,
      "stale_replay_or_session");
    requireValue(request.expectedNpcCharacterId === (lease.npc?.characterId ?? null), "stale_npc_guid");
    // A repeated finish can observe the same terminal result, never a newer lease.
    if (request.action === "finish") {
      if (this.active === lease) this.close(lease, "finished", "explicit_finish");
      else if (lease.cleanupError) this.cleanup(lease);
      return this.getStatus();
    }
    requireValue(!this.cleanupBlocked, "previous_cleanup_incomplete");
    requireValue(this.active === lease && this.isCurrent(lease), "replay_not_current");
    requireValue(lease.state === "paused" || lease.state === "start_requested" || lease.state === "running", "not_paused_ready");
    requireValue(lease.fullDataAt !== undefined && lease.pausedAt !== undefined, "real_readiness_required");
    if (lease.state === "paused") {
      lease.released = true;
      lease.state = "start_requested";
    }
    return this.getStatus();
  }

  private prepare(request: Prepare): object {
    if (this.last?.request.requestId === request.requestId || this.active?.request.requestId === request.requestId) {
      const previous = this.active?.request.requestId === request.requestId ? this.active : this.last!;
      requireValue(JSON.stringify(previous.request) === JSON.stringify(request), "request_id_reused_with_different_identity");
      requireValue(!this.active || this.active === previous, "concurrent_replay");
      return this.getStatus();
    }
    requireValue(!this.active, "concurrent_replay");
    requireValue(!this.requestIds.has(request.requestId), "stale_request_id");
    requireValue(this.requestIds.size < MAX_REQUESTS, "replay_request_limit_reached");
    const clients = Object.values(this.zone._clients);
    requireValue(clients.length === 1, "exactly_one_client_required");
    const client = clients[0];
    requireValue(String(client.sessionId) === request.target && this.zone._clients[client.sessionId] === client, "session_mismatch");
    const character = client.character;
    requireValue(character?.characterId === request.expectedPlayerCharacterId, "player_identity_mismatch");
    requireValue(client.testZombieSpawned === true && character.initialized === true && !client.isLoading, "existing_in_world_test_client_required");
    requireValue(!client.vehicle?.mountedVehicle, "dismount_before_replay");
    requireValue(typeof character.godMode === "boolean", "unknown_god_mode_state");
    requireValue(character.isAlive ? !character.isRespawning : character.isRespawning, "normal_respawn_state_required");
    const position = character.state.position;
    requireValue(position?.length >= 3 && Array.from(position).every(Number.isFinite), "finite_player_position_required");
    const oldId = this.zone._lastSpawnedNpcCharacterId ?? null;
    requireValue(oldId === request.expectedNpcCharacterId, "stale_npc_guid");
    const oldNpc = oldId === null ? undefined : this.zone._npcs[oldId];
    const bySession = this.bySession();
    requireValue(oldId === null ? !bySession?.[request.target] :
      oldNpc && oldNpc.testFullDataOwner === client && bySession?.[request.target] === oldId, "existing_test_npc_owner_mismatch");
    const now = Date.now();
    const lease: Lease = {
      replayId: randomUUID(), request, state: "preparing", createdAt: now, expiresAt: now + LEASE_MS,
      client, character, playerPosition: position.slice(), oldNpc,
      previousGodMode: character.godMode, protectionApplied: false, released: false,
      ...(request.observeNpcIngress ? { npcIngress: { matchedPackets: 0, records: [] } } : {}),
      ...(request.observePlayerMotion ? { playerMotion: { inboundCount: 0, outboundCount: 0, inbound: [], outbound: [] } } : {})
    };
    this.active = lease;
    this.last = lease;
    this.requestIds.add(request.requestId);
    try {
      // Mark before invoking the setter so a partial setter failure is rolled back.
      lease.protectionApplied = true;
      this.zone.setGodMode(client, true);
      if (!character.isAlive) this.zone.respawnPlayer(client, lease.playerPosition.slice(), false);
      requireValue(client.character === character && character.isAlive && !character.isRespawning,
        "normal_respawn_declined_or_incomplete");
      requireValue(Array.from(lease.playerPosition).every((v, i) => v === character.state.position[i]), "respawn_changed_position");
      lease.timer = setInterval(() => {
        if (this.isCurrent(lease)) {
          this.checkRouteProgress(lease);
          this.ingressClock(lease);
          this.playerMotionContext(lease.client);
        }
      }, 100);
      lease.timer.unref?.();
      // Timer bound is independent of wall-clock corrections; GET cannot renew it.
      lease.deadlineTimer = setTimeout(() => this.close(lease, "failed", "lease_timeout"), LEASE_MS);
      lease.deadlineTimer.unref?.();
      this.spawn(this.zone, client, {
        delayMs: 0, addAiDelayMs: 750, noAi: false, distance: request.distance, profileId: 10,
        ...(request.knownObstacle ? { knownObstacle: request.knownObstacle } : {}),
        ...(request.movementMode ? { movementMode: request.movementMode } : {}),
        terrain: this.terrain(), logPrefix: "[test-zombie-replay]",
        lifecycle: {
          isCurrent: () => this.isCurrent(lease),
          onSpawnTaskStarted: () => {
            if (this.active !== lease || lease.spawnTaskStarted) return;
            lease.spawnTaskStarted = true;
            lease.spawnTaskPending = true;
          },
          onSpawnTaskSettled: () => {
            if (!lease.spawnTaskPending) return;
            lease.spawnTaskPending = false;
            // A cancelled preparation still owns its pending work. New prepare
            // stays blocked until this exact task has reported all cleanup.
            if (this.active !== lease) this.cleanup(lease);
          },
          onUnpublishedCleanupFailure: failure => {
            if (!lease.spawnTaskPending) return;
            if (failure.npcCleanupFailed && failure.npc) lease.npc = failure.npc;
            if (failure.routeResource) lease.routeResource = failure.routeResource;
            lease.routeDisposalAttempted = failure.routeDisposalAttempted;
            lease.routeDisposalFailed = failure.routeDisposalFailed;
            // The creator already attempted disposal; never install a retry
            // closure. The captured NPC alone may be retried by cleanup.
            lease.state = "failed";
            lease.reason = "unpublished_spawn_cleanup_failed";
          },
          onSpawned: (npc, claimOwnership) => {
            // Ownership transfers only once for this active lease. A cancelled
            // async creator retains its unpublished resource and must dispose it.
            if (this.active !== lease || lease.npc) return;
            const resource = npc.testRouteResource;
            let disposeRoute: (() => void) | undefined;
            let invalidResource = false;
            if (resource !== undefined) {
              try {
                const dispose = resource.dispose;
                if (typeof dispose !== "function") throw new Error("Invalid route resource");
                disposeRoute = () => dispose.call(resource);
              } catch {
                invalidResource = true;
              }
            }
            lease.npc = npc;
            lease.routeResource = resource;
            lease.disposeRoute = disposeRoute;
            lease.routeDisposalFailed = invalidResource;
            // Capture every cleanup responsibility before acknowledging. A
            // later callback failure must never return ownership to creator.
            claimOwnership();
            if (invalidResource) {
              this.close(lease, "failed", "route_resource_invalid");
              return;
            }
            if (this.isCurrent(lease)) lease.state = "waiting_full_data";
          },
          onFullData: () => {
            if (!this.isCurrent(lease)) return;
            lease.fullDataAt = Date.now();
            lease.state = "waiting_ready";
          },
          onPaused: () => {
            if (!this.isCurrent(lease)) return;
            lease.pausedAt = Date.now();
            lease.state = "paused";
            this.armNpcIngress(lease);
            const motion = lease.playerMotion;
            if (motion && motion.startedAt === undefined && !motion.stoppedReason) {
              try {
                const now = this.monotonicNow(), deadline = now + PLAYER_MOTION_WINDOW_MS;
                if (!Number.isFinite(now) || now < 0 || !Number.isFinite(deadline) || deadline <= now) throw Error("clock");
                motion.startedAt = motion.lastObserved = now; motion.deadline = deadline;
              } catch { motion.stoppedReason = "observation_clock_invalid"; }
            }
          },
          canStart: () => this.isCurrent(lease) && lease.released,
          onStarted: () => {
            if (!this.isCurrent(lease)) return;
            lease.state = "running";
            lease.startedAt = Date.now();
            this.checkRouteProgress(lease);
          },
          onFailure: () => this.close(lease, "failed", "spawn_or_readiness_failed")
        }
      });
    } catch (error) {
      this.close(lease, "failed", error instanceof TestZombieReplayError ? error.message : "prepare_failed");
      throw error instanceof TestZombieReplayError ? error : new TestZombieReplayError(500, "prepare_failed");
    }
    return this.getStatus();
  }

  private bySession(): Record<string, string> | undefined {
    return (this.zone as unknown as { _testZombieBySessionId?: Record<string, string> })._testZombieBySessionId;
  }

  private armNpcIngress(lease: Lease): void {
    const observation = lease.npcIngress, npc = lease.npc;
    if (!observation || observation.startedAt !== undefined || observation.stoppedReason) return;
    if (!npc || !Number.isInteger(npc.transientId) || npc.transientId < 0 || npc.transientId > 0xffffffff) {
      observation.stoppedReason = "invalid_subject";
      return;
    }
    if (this.observedIngressTransients.has(npc.transientId) || lease.oldNpc?.transientId === npc.transientId) {
      observation.stoppedReason = "observation_transient_reused";
      return;
    }
    this.observedIngressTransients.add(npc.transientId);
    observation.npc = npc;
    observation.npcCharacterId = npc.characterId;
    observation.transientId = npc.transientId;
    try {
      const now = this.monotonicNow();
      const deadline = now + NPC_INGRESS_WINDOW_MS;
      if (!Number.isFinite(now) || now < 0 || !Number.isFinite(deadline) || deadline <= now) throw new Error("invalid_clock");
      observation.startedAt = observation.lastObserved = now;
      observation.deadline = deadline;
    } catch { observation.stoppedReason = "observation_clock_invalid"; }
  }

  private ingressClock(lease: Lease): number | undefined {
    const observation = lease.npcIngress;
    if (!observation || observation.startedAt === undefined || observation.stoppedReason) return;
    try {
      const now = this.monotonicNow();
      if (!Number.isFinite(now) || now < observation.lastObserved!) throw new Error("invalid_clock");
      observation.lastObserved = now;
      if (now >= observation.deadline!) { observation.stoppedReason = "observation_window_elapsed"; return; }
      return now;
    } catch { observation.stoppedReason = "observation_clock_invalid"; }
  }

  /** Bounded parsed receipts only. Never calls lifecycle cleanup, grants control or applies/broadcasts movement. */
  observeNpcIngress(client: ZoneClient2016, packetData: unknown): void {
    const lease = this.active, observation = lease?.npcIngress;
    if (this.disposed || !lease || !observation || observation.stoppedReason ||
        observation.startedAt === undefined || client !== lease.client) return;
    try {
      const npc = observation.npc, id = observation.npcCharacterId, transient = observation.transientId;
      const utcMs = Date.now();
      if (!Number.isFinite(utcMs)) { observation.stoppedReason = "observation_clock_invalid"; return; }
      if (utcMs >= lease.expiresAt) { observation.stoppedReason = "observation_lease_expired"; return; }
      if (this.zone._soloMode !== true || String(lease.client.sessionId) !== lease.request.target ||
          Object.keys(this.zone._clients).length !== 1 || this.zone._clients[lease.client.sessionId] !== lease.client ||
          lease.client.character !== lease.character || lease.character.characterId !== lease.request.expectedPlayerCharacterId ||
          !lease.character.isAlive || lease.character.isRespawning ||
          !npc || lease.npc !== npc || npc.characterId !== id || npc.transientId !== transient || !npc.isAlive ||
          npc.testFullDataOwner !== client || npc.testRouteResource !== lease.routeResource ||
          this.zone._npcs[id!] !== npc || this.zone._lastSpawnedNpcCharacterId !== id ||
          this.bySession()?.[lease.request.target] !== id || this.zone._transientIds?.[transient!] !== id ||
          lease.state === "finished" || lease.state === "failed") {
        observation.stoppedReason = "observation_identity_changed";
        return;
      }
      const now = this.ingressClock(lease);
      if (now === undefined || !packetData || typeof packetData !== "object") return;
      const data = packetData as { transientId?: unknown; positionUpdate?: unknown };
      if (data.transientId !== transient) return;
      observation.matchedPackets = Math.min(Number.MAX_SAFE_INTEGER, observation.matchedPackets + 1);
      if (observation.records.length >= NPC_INGRESS_MAX_RECORDS) return;
      const update = data.positionUpdate && typeof data.positionUpdate === "object"
        ? data.positionUpdate as Record<string, unknown> : {};
      const integer = (value: unknown, maximum: number) => typeof value === "number" &&
        Number.isInteger(value) && value >= 0 && value <= maximum ? value : null;
      const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
      const value = update.position;
      const position = (Array.isArray(value) || value instanceof Float32Array) &&
        (value.length === 3 || value.length === 4) && Array.from(value).every(v => typeof v === "number" && Number.isFinite(v))
        ? Array.from(value) as number[] : null;
      observation.records.push({ utcMs, monotonicMs: now, flags: integer(update.flags, 0xffff),
        parseError: typeof update.parseError === "boolean" ? update.parseError : null,
        sequenceTime: integer(update.sequenceTime, 0xffffffff), movementVersion: integer(update.unknown3_int8, 0xff),
        position, horizontalSpeed: finite(update.horizontalSpeed), verticalSpeed: finite(update.verticalSpeed) });
    } catch { observation.stoppedReason = "observation_read_failed"; }
  }

  private playerMotionIdentity(lease: Lease, client: ZoneClient2016): boolean {
    const npc = lease.npc;
    return !this.disposed && this.active === lease && client === lease.client && this.zone._soloMode === true &&
      String(client.sessionId) === lease.request.target && Object.keys(this.zone._clients).length === 1 &&
      this.zone._clients[client.sessionId] === client && client.character === lease.character &&
      lease.character.characterId === lease.request.expectedPlayerCharacterId && lease.character.isAlive && !lease.character.isRespawning &&
      !!npc && npc.isAlive && npc.testFullDataOwner === client && npc.testRouteResource === lease.routeResource &&
      this.zone._npcs[npc.characterId] === npc && this.zone._lastSpawnedNpcCharacterId === npc.characterId &&
      this.bySession()?.[lease.request.target] === npc.characterId;
  }

  private playerMotionContext(client: ZoneClient2016) {
    const lease = this.active, observation = lease?.playerMotion;
    // Disabled/unrelated sessions never inspect packet fields or read clocks.
    if (!lease || !observation || observation.startedAt === undefined || observation.stoppedReason || client !== lease.client) return;
    try {
      if (!this.playerMotionIdentity(lease, client)) { observation.stoppedReason = "observation_identity_changed"; return; }
      const utcMs = Date.now(), now = this.monotonicNow();
      if (!Number.isFinite(utcMs) || !Number.isFinite(now) || now < observation.lastObserved!) throw Error("clock");
      observation.lastObserved = now;
      if (utcMs >= lease.expiresAt) { observation.stoppedReason = "observation_lease_expired"; return; }
      if (now >= observation.deadline!) { observation.stoppedReason = "observation_window_elapsed"; return; }
      return { lease, observation, utcMs, now };
    } catch { observation.stoppedReason = "observation_read_or_clock_failed"; }
  }

  /** Same synchronous handler only; receipt is not proof of assignment or player input. */
  observePlayerMotionIngress(client: ZoneClient2016, packetData: unknown): ((stage: "before" | "after") => void) | undefined {
    const context = this.playerMotionContext(client);
    if (!context) return;
    const { lease, observation, utcMs, now } = context;
    try {
      const data = packetData && typeof packetData === "object" ? packetData as Record<string, unknown> : {};
      const record: PlayerMotionInbound = { utcMs, monotonicMs: now, flags: motionInteger(data.flags, 0xffff),
        parseError: typeof data.parseError === "boolean" ? data.parseError : null,
        position: motionVector(data.position), stance: motionInteger(data.stance), sequenceTime: motionInteger(data.sequenceTime),
        movementVersion: motionInteger(data.unknown3_int8, 0xff), positionAtReceipt: motionVector(lease.character.state.position),
        positionBefore: null, positionAfter: null, assigned: false, assignmentOutsideWindow: null };
      observation.inboundCount = Math.min(Number.MAX_SAFE_INTEGER, observation.inboundCount + 1);
      if (observation.inbound.length === PLAYER_MOTION_MAX_INBOUND) observation.inbound.shift();
      observation.inbound.push(record);
      let beforeSeen = false;
      return stage => {
        try {
          if (!this.playerMotionIdentity(lease, client) ||
              (observation.stoppedReason && observation.stoppedReason !== "observation_window_elapsed")) return;
          // Finish an already admitted packet across the window edge; never admit
          // a new packet, renew the deadline, or complete an old lease's receipt.
          const at = this.monotonicNow();
          if (!Number.isFinite(at) || at < observation.lastObserved!) throw Error("clock");
          observation.lastObserved = at;
          record.assignmentOutsideWindow = record.assignmentOutsideWindow === true || at >= observation.deadline!;
          if (stage === "before" && !beforeSeen) {
            record.positionBefore = motionVector(lease.character.state.position); beforeSeen = true;
          } else if (stage === "after" && beforeSeen && !record.assigned) {
            record.positionAfter = motionVector(lease.character.state.position); record.assigned = true;
          }
        } catch { observation.stoppedReason = "observation_read_or_clock_failed"; }
      };
    } catch { observation.stoppedReason = "observation_read_failed"; }
  }

  /** Attempts only: no changed send result, gateway acknowledgement or client-delivery claim. */
  observePlayerMotionSend(client: ZoneClient2016, packetName: string, payload: unknown, raw?: Buffer): void {
    if (packetName !== "ClientUpdate.UpdateLocation" && packetName !== "Character.Knockback") return;
    const context = this.playerMotionContext(client);
    if (!context) return;
    const { observation, utcMs, now } = context;
    try {
      observation.outboundCount = Math.min(Number.MAX_SAFE_INTEGER, observation.outboundCount + 1);
      if (observation.outbound.length >= PLAYER_MOTION_MAX_OUTBOUND) return;
      let layout: PlayerMotionOutbound["layout"] = "typed_fields";
      if (raw) {
        layout = "layout_unknown"; payload = undefined;
        if (raw.length === (packetName === "ClientUpdate.UpdateLocation" ? 38 : 42)) {
          // Only two fixed schemas; never parse arbitrary/raw movement-channel traffic.
          try {
            const parsed = this.zone._protocol.parse(raw, 0);
            if (parsed?.name === packetName) { payload = parsed.data; layout = "parsed_fixed_wire"; }
          } catch { /* Retain the attempted opcode with unknown layout. */ }
        }
      }
      const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      observation.outbound.push({ utcMs, monotonicMs: now, packetName, source: raw ? "raw" : "typed",
        phase: "send_attempt", transportOutcome: "not_observed", layout,
        wireLength: raw ? raw.length : null, rawPrefix: raw ? raw.subarray(0, 42).toString("hex") : null,
        position: motionVector(data.position), movementVersion: motionInteger(data.unknownByte1, 0xff),
        triggerLoadingScreen: typeof data.triggerLoadingScreen === "boolean" ? data.triggerLoadingScreen : null,
        vector1: motionVector(data.unknownFloatVector1), vector2: motionVector(data.unknownFloatVector2),
        dword1: motionInteger(data.unknownDword1), dword2: motionInteger(data.unknownDword2) });
    } catch { observation.stoppedReason = "observation_read_failed"; }
  }

  private invalidReason(lease: Lease): string | undefined {
    if (Date.now() >= lease.expiresAt) return "lease_timeout";
    if (Object.keys(this.zone._clients).length !== 1 || this.zone._clients[lease.client.sessionId] !== lease.client) return "client_disconnected_or_changed";
    if (lease.client.character !== lease.character || lease.character.characterId !== lease.request.expectedPlayerCharacterId) return "player_identity_changed";
    if (!lease.character.isAlive || lease.character.isRespawning) return "player_not_alive";
    if (lease.character.godMode !== true) return "protection_changed";
    if (lease.client.vehicle?.mountedVehicle) return "player_mounted_vehicle";
    if (lease.state !== "running") {
      const pos = lease.character.state.position;
      const valid = pos && pos.length >= 3 && Array.from(pos).every(Number.isFinite);
      const deltaXZ = valid ? Math.hypot(pos[0] - lease.playerPosition[0], pos[2] - lease.playerPosition[2]) : null;
      if (!valid || deltaXZ! > 0.05) {
        const receipt = lease.client.testZombiePositionReceipt;
        lease.prestartPositionFailure = { observedAt: Date.now(), prepared: Array.from(lease.playerPosition),
          current: valid ? Array.from(pos) : null, deltaXZ,
          receipt: receipt ? { count: receipt.count, sequenceTime: receipt.sequenceTime,
            movementVersion: receipt.movementVersion, flags: receipt.flags, position: receipt.position,
            sameCharacter: receipt.character === lease.character } : null };
        return "player_moved_before_start";
      }
    }
    if (lease.npc) {
      if (this.zone._lastSpawnedNpcCharacterId !== lease.npc.characterId || this.zone._npcs[lease.npc.characterId] !== lease.npc ||
          this.bySession()?.[lease.request.target] !== lease.npc.characterId || !lease.npc.isAlive) return "owned_npc_changed_or_dead";
      if (lease.npc.testRouteResource !== lease.routeResource) return "route_resource_changed";
    } else {
      const oldId = this.zone._lastSpawnedNpcCharacterId ?? null;
      if (oldId !== lease.request.expectedNpcCharacterId || (oldId !== null && this.zone._npcs[oldId] !== lease.oldNpc)) return "previous_npc_changed";
    }
    return undefined;
  }

  private isCurrent(lease: Lease): boolean {
    if (this.active !== lease) return false;
    const reason = this.invalidReason(lease);
    if (reason) { this.close(lease, "failed", reason); return false; }
    return true;
  }

  private checkRouteProgress(lease: Lease): void {
    const npc = lease.npc;
    if (lease.state !== "running" || !npc?.testServerDrivenMovement ||
        typeof npc.testRouteStep !== "function" || npc.behaviorState !== 1) {
      lease.progress = undefined; // Paused/readiness/attacking time is not chase time.
      return;
    }
    let now: number;
    try { now = this.monotonicNow(); }
    catch { this.close(lease, "failed", "route_progress_clock_invalid"); return; }
    const prior = lease.progress, position = npc.state.position;
    if (!Number.isFinite(now) || now < 0 || (prior && now < prior.lastObserved)) {
      this.close(lease, "failed", "route_progress_clock_invalid"); return;
    }
    if (!position || position.length < 3 || ![position[0], position[1], position[2]].every(Number.isFinite)) {
      this.close(lease, "failed", "route_progress_position_invalid"); return;
    }
    // Observe committed server positions, never proposed route points or an ACK.
    // Net displacement from a fixed anchor ignores accumulated sub-threshold
    // jitter and allows detours away from the target. Target motion cannot reset it.
    if (!prior || Math.hypot(position[0] - prior.x, position[2] - prior.z) >= ROUTE_MIN_PROGRESS_XZ) {
      lease.progress = { x: position[0], z: position[2], since: now, lastObserved: now };
      return;
    }
    prior.lastObserved = now;
    if (now - prior.since >= ROUTE_NO_PROGRESS_MS) this.close(lease, "failed", "route_no_progress");
  }

  private close(lease: Lease, state: "finished" | "failed", reason: string): void {
    if (this.active !== lease) return;
    // Cancel callbacks first. All delayed work must check this exact lease.
    this.active = undefined;
    if (lease.npcIngress && !lease.npcIngress.stoppedReason) lease.npcIngress.stoppedReason = `lease_${reason}`;
    if (lease.playerMotion && !lease.playerMotion.stoppedReason) lease.playerMotion.stoppedReason = `lease_${reason}`;
    if (lease.timer) clearInterval(lease.timer);
    if (lease.deadlineTimer) clearTimeout(lease.deadlineTimer);
    lease.state = state;
    lease.reason = reason;
    lease.finishedAt = Date.now();
    this.cleanup(lease);
  }

  private cleanup(lease: Lease): void {
    const npc = lease.npc;
    let aiRemovalFailed = false;
    // AI uses its own collection. Even a replaced registry entry must not leave
    // the captured old object running; never remove the replacement object.
    if (npc) {
      try { this.zone.aiManager.removeEntity(npc); }
      catch { aiRemovalFailed = true; }
    }
    // Close route queries even if NPC removal failed. Never retry a native
    // destructor after a partial throw, and never dispose a replacement object.
    if (lease.disposeRoute && !lease.routeDisposalAttempted) {
      lease.routeDisposalAttempted = true;
      try { lease.disposeRoute(); }
      catch { lease.routeDisposalFailed = true; }
    }
    try {
      if (npc && this.zone._npcs[npc.characterId] === npc) {
        this.zone.deleteEntity(npc.characterId, this.zone._npcs);
      }
      // The native-test melee timer also checks registry object identity. Do not
      // revoke protection while a failed removal can still pass that guard.
      if (aiRemovalFailed || (npc && this.zone._npcs[npc.characterId] === npc)) throw new Error("cleanup_incomplete");
      if (npc && this.zone._lastSpawnedNpcCharacterId === npc.characterId && !this.zone._npcs[npc.characterId]) {
        this.zone._lastSpawnedNpcCharacterId = null;
        this.zone._testZombieWalkToCharacterId = null;
        this.zone._testZombieChaseAttackCharacterId = null;
      }
      const map = this.bySession();
      if (npc && map?.[lease.request.target] === npc.characterId && !this.zone._npcs[npc.characterId]) delete map[lease.request.target];
    } catch {
      lease.state = "failed";
      lease.cleanupError = "owned_npc_cleanup_incomplete_protection_retained_retry_finish";
      this.cleanupBlocked = true;
      return;
    }
    if (lease.spawnTaskPending) {
      lease.cleanupError = "spawn_task_pending_cleanup_protection_retained";
      this.cleanupBlocked = true;
      return;
    }
    this.cleanupBlocked = lease.routeDisposalFailed === true;
    lease.cleanupError = lease.routeDisposalFailed ? "route_resource_disposal_failed_not_retried" : undefined;
    if (lease.routeDisposalFailed) lease.state = "failed";
    if (lease.protectionApplied) {
      try {
        if (this.zone._clients[lease.client.sessionId] === lease.client && lease.client.character === lease.character) {
          this.zone.setGodMode(lease.client, lease.previousGodMode);
        } else {
          // Restore only the captured old character, never a replacement session.
          lease.character.godMode = lease.previousGodMode;
        }
      } catch {
        lease.character.godMode = lease.previousGodMode;
        lease.cleanupError = lease.cleanupError ?? "protection_state_restored_but_notification_failed";
      }
      lease.protectionApplied = false;
    }
  }

  dispose(): void {
    if (this.active) this.close(this.active, "finished", "http_server_stopped");
    this.disposed = true;
  }
}
