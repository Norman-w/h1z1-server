/**
 * 【实验性】外置测试：人物刷新后视线前方刷一只僵尸（ZOMBIE_MALE_WALKER），走与正常 NPC 相同的刷怪路径。
 * 启用：在 firstRoutine 里加一行 testZombieInFrontOnSpawn(server, client);
 * 不用时删掉那一行即可。
 *
 * 最终目标：僵尸过来追人、明显动作攻击（移动+攻击动画可见）。以客户端为准，服务端为实验性。
 * 参见 PACKETS_AND_FUNCTIONS.md「先声明后使用」与前置条件调查。
 */

import { quat2heading } from "../../utils/utils";
import { Npc } from "./entities/npc";
import { ModelIds } from "./models/enums";
import { ZoneServer2016 } from "./zoneserver";
import type { ZoneClient2016 } from "./classes/zoneclient";
import { resolve } from "node:path";
import { loadForgelightTerrainCorridor } from "../../utils/forgelightTerrainAssets";
import { createForgelightTerrainFollowBinding } from "../../utils/forgelightTerrainFollow";
import { prepareTestZombieKnownFence, type TestZombieKnownFenceResource } from "./test-zombie-known-fence";

const SPAWN_DELAY_MS = 500;
/** 加入 AI 延迟（开始追人） */
const ADD_AI_DELAY_MS = 750;
/** 为 true 时：只正常刷出（客户端可见），永不加入 aiManager */
const TEST_ZOMBIE_NO_AI = process.env.TEST_ZOMBIE_NO_AI === "true";
const CLOCK_SAMPLE_MAX_AGE_MS = 1000;
const CLOCK_WAIT_LIMIT_MS = 30000;
/** Existing type11 profile selected for this experiment; not an original NPC-definition mapping. */
export const TEST_ZOMBIE_PROFILE_ID = 10;
const profileDefinitions: { profiles: { ID: number; profileData: { unknownByte1: number } }[] } =
  require("../../../data/2016/dataSources/ServerProfileDefinitions.json");

export interface TestZombieClockDiagnostics {
  samples: number;
  stanceRotationSamples: number;
  invalid: number;
  misaligned: number;
  aligned: number;
  lastReceivedAt: number;
  lastFlags: number | null;
  lastSequenceTime: number | null;
  lastServerTime: number | null;
  lastDeltaMs: number | null;
  lastResult: "invalid" | "misaligned" | "aligned";
}

/** Record why an inbound timestamp does or does not acknowledge our clock. */
export function recordTestZombieClockSample(
  client: ZoneClient2016,
  sequenceTime: number,
  serverTime: number,
  flags?: number,
  movementVersion?: number,
  stance?: number
): void {
  if (!client.testZombieSpawned) return;
  const validU32 = (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
  const valid = validU32(sequenceTime) && validU32(serverTime);
  const diagnostics = client.testZombieClockDiagnostics ??= {
    samples: 0, stanceRotationSamples: 0, invalid: 0, misaligned: 0, aligned: 0,
    lastReceivedAt: 0, lastFlags: null, lastSequenceTime: null,
    lastServerTime: null, lastDeltaMs: null, lastResult: "invalid"
  };
  diagnostics.samples++;
  diagnostics.lastReceivedAt = Date.now();
  diagnostics.lastFlags = Number.isInteger(flags) ? flags! : null;
  diagnostics.lastSequenceTime = validU32(sequenceTime) ? sequenceTime : null;
  diagnostics.lastServerTime = validU32(serverTime) ? serverTime : null;
  // Signed modular subtraction also handles the uint32 millisecond wrap.
  diagnostics.lastDeltaMs = valid ? (sequenceTime - serverTime) | 0 : null;
  // Native1403717d0 reads the same clock header for stance+rotation (0x201).
  // This counts its presence; it never bypasses validation/alignment below.
  if (flags === 513) diagnostics.stanceRotationSamples++;
  if (!valid) {
    diagnostics.invalid++;
    diagnostics.lastResult = "invalid";
    return;
  }
  if (Number.isInteger(movementVersion) && movementVersion! >= 0 && movementVersion! <= 255)
    client.testZombieMovementVersion = movementVersion;
  if (validU32(stance!)) client.testZombieStance = stance;
  if (Math.abs(diagnostics.lastDeltaMs!) > 500) {
    diagnostics.misaligned++;
    diagnostics.lastResult = "misaligned";
    return;
  }
  diagnostics.aligned++;
  diagnostics.lastResult = "aligned";
  client.testZombieClockReadyAt = Date.now();
}

/**
 * Ask a stationary client for a real full baseline without moving its known pose.
 * Native1403d0d40 sends channel2 after1417f1c00 observes a changed version.
 * This request is NOT clock evidence: only the returned timestamp can arm AI.
 */
export interface TestZombieClockRequestBudget {
  count: number;
  readonly isCurrent: () => boolean;
}

export function requestTestZombieClockBaseline(
  server: ZoneServer2016, client: ZoneClient2016, budget?: TestZombieClockRequestBudget
): boolean {
  const now = Date.now();
  const sync = client.testZombieSynchronization;
  const sample = client.testZombieClockDiagnostics;
  const previous = client.testZombieClockResync;
  const version = client.testZombieMovementVersion;
  // An owned NPC gets one finite request budget for its whole prepare/release
  // lifetime. The client's pending version and cooldown remain global: a new
  // lease must not erase or skip an unacknowledged older request.
  if (budget !== undefined && (!budget || !Number.isInteger(budget.count) ||
      budget.count < 0 || budget.count >= 3 || typeof budget.isCurrent !== "function" ||
      !budget.isCurrent())) return false;
  if (!client.testZombieSpawned || client.isLoading || client.isInAir || client.vehicle?.mountedVehicle ||
      !client.character?.isAlive || client.character.isRespawning ||
      client.character.isMoving ||
      server._clients[client.sessionId] !== client ||
      !sync || sync.count < 1 || now - sync.repliedAt < 500 || now - sync.repliedAt > 10000 ||
      !sample || now - sample.lastReceivedAt < 1000 ||
      version === undefined || !Number.isInteger(version) || version < 0 || version > 255 ||
      (previous && ((!budget && previous.count >= 3) || now - previous.requestedAt < 2000 ||
        version !== previous.requestedVersion))) return false;
  const position = client.character.state?.position;
  const rotation = client.character.state?.rotation;
  if (!position || position.length < 3 || !rotation || rotation.length !== 4 ||
      !Array.from(position).every(Number.isFinite) || !Array.from(rotation).every(Number.isFinite)) return false;
  // Native140533550 masks W, normalizes XYZ and builds a basis against +Y.
  // This wire field is a direction, not the stored [x,y,z,w] quaternion.
  const norm = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]);
  if (!Number.isFinite(norm) || norm === 0) return false;
  const x = rotation[0] / norm, y = rotation[1] / norm;
  const z = rotation[2] / norm, w = rotation[3] / norm;
  const forwardX = 2 * (x * z + w * y);
  const forwardZ = 1 - 2 * (x * x + y * y);
  const horizontalNorm = Math.hypot(forwardX, forwardZ);
  // Reject a numerically vertical projection; do not invent a fallback facing.
  if (!Number.isFinite(horizontalNorm) || horizontalNorm <= 1e-6) return false;
  const requestedVersion = (version + 1) & 255;
  // Reliable transport already retries a request whose version was not echoed.
  // Do not race ahead through additional unobserved versions.
  if (previous?.requestedVersion === requestedVersion) return false;
  server.sendData(client, "ClientUpdate.UpdateLocation", {
    position: new Float32Array([position[0], position[1], position[2], 1]),
    rotation: new Float32Array([forwardX / horizontalNorm, 0, forwardZ / horizontalNorm, 0]),
    unknownBoolean1: true,
    unknownByte1: requestedVersion,
    triggerLoadingScreen: false
  });
  client.testZombieClockResync = {
    count: (previous?.count ?? 0) + 1, requestedAt: now, requestedVersion
  };
  if (budget) budget.count++;
  console.log(`[test-zombie] 请求原位完整位置回执: version=${version}->${requestedVersion}, attempt=${client.testZombieClockResync.count}, scope=${budget ? "owned" : "legacy"}, ownedAttempt=${budget?.count ?? null}`);
  return true;
}

/** Creator cleanup result bound to the original lease, including a cancelled one. */
export interface TestZombieUnpublishedCleanupFailure {
  npc?: Npc;
  npcCleanupFailed: boolean;
  routeResource?: Npc["testRouteResource"];
  routeDisposalAttempted: boolean;
  routeDisposalFailed: boolean;
}

/** Optional experiment lifetime; never substitutes for the real readiness gates. */
export interface TestZombieLifecycle {
  isCurrent: () => boolean;
  // These bookkeeping hooks must not throw. A pending creator prevents another
  // replay from replacing its lease before asynchronous cleanup has completed.
  onSpawnTaskStarted: () => void;
  onSpawnTaskSettled: () => void;
  onUnpublishedCleanupFailure: (failure: TestZombieUnpublishedCleanupFailure) => void;
  onSpawned: (zombie: Npc, claimOwnership: () => void) => void;
  onFullData: () => void;
  onPaused: () => void;
  canStart: () => boolean;
  onStarted: () => void;
  onFailure: (error: unknown) => void;
}

export interface SpawnTestZombieOptions {
  delayMs?: number;
  addAiDelayMs?: number;
  noAi?: boolean;
  distance?: number;
  logPrefix?: string;
  profileId?: number;
  terrain?: { assetRoot: string; decoderPath: string };
  knownObstacle?: "fence-192060";
  /** Bounded A/B selector; omitted means the existing server position-stream route. */
  movementMode?: "server" | "client-seek" | "mixed";
  prepareReady?: () => boolean;
  lifecycle?: TestZombieLifecycle;
}

/**
 * Arm after handling the owning client's full-data request. This callback is
 * not an acknowledgement that the native client received or parsed our reply.
 */
export function armTestZombieOnFullData(
  server: ZoneServer2016,
  client: ZoneClient2016,
  zombie: Npc,
  options: SpawnTestZombieOptions = {}
): void {
  const createdAt = Date.now();
  const logPrefix = options.logPrefix ?? "[test-zombie]";
  const clockBudget: TestZombieClockRequestBudget | undefined = options.lifecycle
    ? { count: 0, isCurrent: () => options.lifecycle!.isCurrent() }
    : undefined;
  let ownerFullDataHandled = false;
  zombie.testFullDataOwner = client;
  zombie.onReadyCallback = (requestingClient) => {
    if (requestingClient !== client || ownerFullDataHandled ||
        (options.lifecycle && !options.lifecycle.isCurrent())) return;
    try {
      // The real request handler already sent its full-NPC reply. Complete the
      // existing initialization sequence only now; an unsolicited full reply at
      // spawn can remove the client's reason to request data and never arm us.
      // This helper repeats the full reply; neither send is a native parse ACK.
      server.sendStandardFullNpcInit(client, zombie);
    } catch (error) {
      if (options.lifecycle) {
        options.lifecycle.onFailure(error);
        return;
      }
      throw error;
    }
    // A saved/duplicate callback cannot start another waiter or refill budget.
    ownerFullDataHandled = true;
    options.lifecycle?.onFullData();
    console.log(
      `${logPrefix} 客户端请求完整 NPC 数据: id=${zombie.characterId}, elapsedMs=${Date.now() - createdAt}, owner=${requestingClient === client}`
    );
    if (options.noAi ?? TEST_ZOMBIE_NO_AI) return;
    const waitStartedAt = Date.now();
    let clockWaitWarningSent = false;
    let movementPrepared = false;
    const startWhenClockReady = () => {
      try {
      if (options.lifecycle && !options.lifecycle.isCurrent()) return;
      if (server._npcs[zombie.characterId] !== zombie || !zombie.isAlive) return;
      if (server._clients[client.sessionId] !== client) return;
      if (!client.character?.isAlive || client.character.isRespawning) return;
      // A prepared replay waits for explicit release, not a continuously fresh
      // clock. Preserve the limited baseline budget during camera/sampler setup.
      // Release falls through to the unchanged loading/clock/terrain gates below.
      if (movementPrepared && options.lifecycle && !options.lifecycle.canStart()) {
        if (options.lifecycle.isCurrent()) setTimeout(startWhenClockReady, 100);
        return;
      }
      if (client.isLoading) {
        setTimeout(startWhenClockReady, 100);
        return;
      }
      const clockAge = client.testZombieClockReadyAt === undefined
        ? Infinity : Date.now() - client.testZombieClockReadyAt;
      if (clockAge < 0 || clockAge > CLOCK_SAMPLE_MAX_AGE_MS) {
        requestTestZombieClockBaseline(server, client, clockBudget);
        if (Date.now() - waitStartedAt >= CLOCK_WAIT_LIMIT_MS) {
          if (!clockWaitWarningSent) {
            console.log(`${logPrefix} 未收到已对时的客户端位置包，保持静止并继续低频等待: id=${zombie.characterId}`);
            console.log(`${logPrefix} clock-diagnostic: ${JSON.stringify({ samples: client.testZombieClockDiagnostics ?? null, synchronization: client.testZombieSynchronization ?? null })}`);
            clockWaitWarningSent = true;
          }
          // A late valid clock sample must still be able to arm this encounter.
          // Retain the lifetime and clock checks above; never start on timeout.
          setTimeout(startWhenClockReady, 1000);
          return;
        }
        setTimeout(startWhenClockReady, 100);
        return;
      }
      if (zombie.testServerDrivenMovement) {
        if (!movementPrepared && options.prepareReady && !options.prepareReady()) {
          setTimeout(startWhenClockReady, 100);
          return;
        }
        if (!movementPrepared) {
          movementPrepared = true;
          // Infrastructure preparation is not animation completion or motion
          // ownership. A leased hold must not touch the client's controller.
          options.lifecycle?.onPaused();
        }
      } else if (options.lifecycle && !movementPrepared) {
        // The client-seek A/B has no server route step, but it still needs the
        // same lease pause/release handshake before the AI is admitted. Without
        // this branch it remains in waiting_ready forever and never sends
        // SeekTarget.
        if (options.prepareReady && !options.prepareReady()) {
          setTimeout(startWhenClockReady, 100);
          return;
        }
        movementPrepared = true;
        options.lifecycle.onPaused();
      }
      if (options.lifecycle) {
        if (!options.lifecycle.canStart() || (options.prepareReady && !options.prepareReady())) {
          setTimeout(startWhenClockReady, 100);
          return;
        }
        if (!options.lifecycle.isCurrent()) return;
      }
      // Only release plus the current identity/clock/terrain gates authorizes
      // this test handoff. Neither canStart nor the idle packet is a native ACK.
      // Unleased legacy encounters reach the same handoff without a hold.
      if (zombie.testServerDrivenMovement) {
        zombie.clearMovementController(true);
        zombie.sendIdleStance();
      }
      server._testZombieChaseAttackCharacterId = client.character.characterId;
      if (!server.aiManager.playerEntities.has(client.character)) {
        server.aiManager.addEntity(client.character);
      }
      server.aiManager.addEntity(zombie);
      options.lifecycle?.onStarted();
      console.log(`${logPrefix} 完整数据与客户端时钟确认后启动 ai: elapsedMs=${Date.now() - createdAt}, clockAgeMs=${clockAge}`);
      } catch (error) {
        if (options.lifecycle) options.lifecycle.onFailure(error);
        else throw error;
      }
    };
    setTimeout(startWhenClockReady, options.addAiDelayMs ?? ADD_AI_DELAY_MS);
  };
}

export function spawnTestZombieForClient(
  server: ZoneServer2016,
  client: ZoneClient2016,
  options: SpawnTestZombieOptions = {}
): void {
  const delayMs = options.delayMs ?? SPAWN_DELAY_MS;
  const addAiDelayMs = options.addAiDelayMs ?? ADD_AI_DELAY_MS;
  const noAi = options.noAi ?? TEST_ZOMBIE_NO_AI;
  const distance = options.distance ?? 6;
  const logPrefix = options.logPrefix ?? "[test-zombie]";
  const profileId = options.profileId ?? TEST_ZOMBIE_PROFILE_ID;
  const movementMode = options.movementMode ?? "server";
  if (!Number.isInteger(profileId) || !profileDefinitions.profiles.some(
    profile => profile.ID === profileId && profile.profileData.unknownByte1 === 11
  )) throw new Error("Test zombie requires an existing type11 profile definition ID");
  if (movementMode !== "server" && movementMode !== "client-seek" && movementMode !== "mixed")
    throw new Error("Test zombie movement mode must be server, client-seek or mixed");
  if (options.knownObstacle !== undefined && (options.knownObstacle !== "fence-192060" ||
      !options.terrain || !options.lifecycle || distance !== 6))
    throw new Error("Known-fence requires an owned terrain replay at distance 6");
  if (options.knownObstacle !== undefined && movementMode !== "server")
    throw new Error("Known-fence route requires server movement mode");

  console.log(
    `${logPrefix} 已调度，${delayMs}ms 后刷怪（僵尸模型，${noAi ? "静止等待测试" : "目标：追人+明显动作攻击"}）`
  );
  let taskSettled = false;
  const settleTask = () => {
    if (taskSettled) return;
    taskSettled = true;
    options.lifecycle?.onSpawnTaskSettled();
  };
  const runSpawnTask = async () => {
    let routeResource: TestZombieKnownFenceResource | undefined;
    let creatorNpc: Npc | undefined;
    let ownershipTransferred = false;
    let failed = false;
    let failure: unknown;
    try {
      if (options.lifecycle && !options.lifecycle.isCurrent()) return;
      if (!client?.character?.state?.position) {
        console.log(`${logPrefix} 跳过：无角色位置`);
        return;
      }
      if (server._clients[client.sessionId] !== client || !client.character.isAlive || client.character.isRespawning) return;
      const pos = client.character.state.position.slice();
      const rot = client.character.state.rotation.slice();
      const heading = quat2heading(rot);
      const headingRad = (heading / 255) * 2 * Math.PI;
      let zombiePos: Float32Array = new Float32Array([
        pos[0] + Math.sin(headingRad) * distance,
        pos[1] + 0.7,
        pos[2] + Math.cos(headingRad) * distance
      ]);
      const zombieRot = new Float32Array(
        rot.length >= 4 ? [rot[0], rot[1], rot[2], rot[3]] : [0, 0, 0, 1]
      );
      const terrain = options.terrain ? await loadForgelightTerrainCorridor(
        options.terrain.assetRoot, options.terrain.decoderPath,
        [pos[0], pos[2]], [zombiePos[0], zombiePos[2]]
      ) : undefined;
      if (options.lifecycle && !options.lifecycle.isCurrent()) return;
      if (server._clients[client.sessionId] !== client || !client.character.isAlive || client.character.isRespawning) return;
      if (terrain) {
        const initial = createForgelightTerrainFollowBinding({
          terrain, standingPlayerPosition: pos,
          spawnXZ: [zombiePos[0], zombiePos[2]], npcVsPlayerOriginDelta: 0
        });
        if (!initial) throw new Error("No unambiguous terrain at player/spawn");
        zombiePos = initial.spawnPosition;
        // Initial placement uses the explicit experimental foot-origin zero.
        // Calibrate the fixed player/NPC origin assumption only after a fresh
        // clock sample and grounded player data, before movement starts.
        zombiePos[1] -= initial.npcOriginHeight;
      }
      if (options.knownObstacle) {
        routeResource = await prepareTestZombieKnownFence({ assetRoot: options.terrain!.assetRoot,
          terrain: terrain!, standingPlayerPosition: pos, spawnXZ: [zombiePos[0], zombiePos[2]] });
      }
      if (options.lifecycle && !options.lifecycle.isCurrent()) return;
      if (server._clients[client.sessionId] !== client || !client.character.isAlive || client.character.isRespawning) return;
      server.removeTestZombie();

      const characterId = server.generateGuid();
      const transientId = server.getTransientId(characterId);
      const zombie = new Npc(
        characterId,
        transientId,
        ModelIds.ZOMBIE_MALE_WALKER,
        zombiePos,
        zombieRot,
        server,
        0
      );
      // The constructor already registered AI. Retain the exact object before
      // any setup can throw, and make ordinary identity-checked cleanup usable.
      // This is not publication to the client or adoption by the replay lease.
      creatorNpc = zombie;
      server._npcs[characterId] = zombie;

      (zombie as any).skipNavAgent = true;
      zombie.profileId = profileId;
      if (movementMode === "client-seek") {
        // Deliberate A/B arm: normal AI emits SeekTarget/SeekTargetUpdate and
        // the explicit negative-control switch suppresses Npc.goTo's
        // PlayerUpdatePosition stream.
        zombie.clientDrivenSeek = true;
        zombie.suppressServerPositionBroadcast = true;
        zombie.testServerDrivenMovement = false;
      } else if (movementMode === "mixed") {
        // Production-style diagnostic arm: retain both the native seek rail
        // and the ordinary Npc.goTo position stream so their interaction can
        // be observed. This is also the production movement contract.
        zombie.clientDrivenSeek = true;
        zombie.suppressServerPositionBroadcast = false;
        zombie.testServerDrivenMovement = false;
      } else {
        // Existing /ztest flat/slope/fence route: server position stream only.
        zombie.clientDrivenSeek = false;
        zombie.suppressServerPositionBroadcast = false;
        zombie.testServerDrivenMovement = true;
      }
      zombie.testChaseSpeedScale = 1;
      if (routeResource) {
        zombie.testRouteResource = routeResource;
        zombie.testRouteStep = routeResource.testRouteStep;
        zombie.testMeleeReachability = routeResource.testMeleeReachability;
      }
      zombie.setFacingToward(pos);
      // Npc 构造函数会立即注册 AI；先撤下，确保首刷包完整到达后才开始追击。
      server.aiManager.removeEntity(zombie);
      server._lastSpawnedNpcCharacterId = characterId;
      if (!(server as any)._testZombieBySessionId) (server as any)._testZombieBySessionId = {};
      (server as any)._testZombieBySessionId[client.sessionId] = characterId;
      let lastCalibrationClock: number | undefined;
      let acceptedCalibrationPosition: number[] | undefined;
      let terrainWaitLogged = false;
      const prepareReady = terrain ? () => {
        // Retain the last explicitly received stance across position-only deltas.
        const stance = client.testZombieStance;
        if (client.isInAir || stance === undefined || !(stance & 0x400) || (stance & 0x30)) return false;
        // A paused replay may revisit an already accepted sample. Reuse only
        // that same grounded pose; changed/fresh poses still need calibration.
        const pose = Array.from(client.character.state.position);
        if (lastCalibrationClock === client.testZombieClockReadyAt) {
          return !!acceptedCalibrationPosition && pose.every((v, i) => v === acceptedCalibrationPosition![i]);
        }
        lastCalibrationClock = client.testZombieClockReadyAt;
        acceptedCalibrationPosition = undefined;
        const binding = createForgelightTerrainFollowBinding({
          terrain, standingPlayerPosition: client.character.state.position,
          spawnXZ: [zombie.state.position[0], zombie.state.position[2]],
          npcVsPlayerOriginDelta: 0 // measured-pose experiment, not a native model contract
        });
        // Do not calibrate from a falling/loading position metres above ground.
        if (!binding || Math.abs(binding.npcOriginHeight) > 0.15) {
          if (!terrainWaitLogged) console.log(`${logPrefix} 等待可标定的落地位置: origin=${binding?.npcOriginHeight ?? "unknown"}`);
          terrainWaitLogged = true;
          return false;
        }
        routeResource?.calibrate(binding);
        zombie.state.position = binding.spawnPosition;
        if (zombie.testServerDrivenMovement && !routeResource) zombie.testRouteStep = binding.testRouteStep;
        acceptedCalibrationPosition = pose;
        console.log(`${logPrefix} ${routeResource ? "known-fence-only" : "terrain-only"} 贴地移动已就绪: origin=${binding.npcOriginHeight}, position=${Array.from(binding.spawnPosition)}`);
        if (routeResource) console.log(`${logPrefix} obstacle-scope: ${JSON.stringify(routeResource.scope)}`);
        return true;
      } : undefined;
      armTestZombieOnFullData(server, client, zombie, { noAi, addAiDelayMs, logPrefix, prepareReady, lifecycle: options.lifecycle });
      if (options.lifecycle) {
        let acceptingClaim = true;
        try {
          options.lifecycle.onSpawned(zombie, () => {
            if (!acceptingClaim) throw new Error("Spawn ownership must be claimed synchronously");
            ownershipTransferred = true;
          });
        } finally {
          acceptingClaim = false;
        }
        if (!ownershipTransferred) throw new Error("Replay did not claim spawned NPC ownership");
      }
      if (options.lifecycle && !options.lifecycle.isCurrent()) return;
      client.spawnedEntities.add(zombie as never);
      server.addLightweightNpc(client, zombie);
      // The unleased login preview belongs to the normal registry only after
      // publication succeeds. A failed send still belongs to this creator.
      if (!options.lifecycle) ownershipTransferred = true;
      console.log(`${logPrefix} 已发送轻量 NPC 声明，等待所属客户端请求完整数据: ${characterId}, profileId=${profileId}`);

    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      let canSettle = true;
      if (!ownershipTransferred) {
        let npcCleanupFailed = false;
        let routeDisposalAttempted = false;
        let routeDisposalFailed = false;
        const npc = creatorNpc;
        if (npc) {
          // AI has its own collection; remove this object even if its registry
          // entry was replaced, and never delete the replacement's entry.
          try { server.aiManager.removeEntity(npc); }
          catch (error) {
            npcCleanupFailed = true;
            console.error(`${logPrefix} 未发布 NPC 的 AI 清理失败`, error);
          }
          try {
            if (server._npcs[npc.characterId] === npc) server.deleteEntity(npc.characterId, server._npcs);
            if (server._npcs[npc.characterId] === npc) throw new Error("Unpublished NPC cleanup incomplete");
            if (!server._npcs[npc.characterId]) {
              if (server._lastSpawnedNpcCharacterId === npc.characterId) {
                server._lastSpawnedNpcCharacterId = null;
                server._testZombieWalkToCharacterId = null;
                server._testZombieChaseAttackCharacterId = null;
              }
              const bySession = (server as unknown as { _testZombieBySessionId?: Record<string, string> })._testZombieBySessionId;
              if (bySession?.[client.sessionId] === npc.characterId) delete bySession[client.sessionId];
            }
          } catch (error) {
            npcCleanupFailed = true;
            console.error(`${logPrefix} 未发布 NPC 的实体清理失败`, error);
          }
        }
        if (routeResource) {
          // A native destructor may partially execute before throwing. Record
          // the attempt before calling it; neither creator nor lease retries it.
          routeDisposalAttempted = true;
          try { routeResource.dispose(); }
          catch (error) {
            routeDisposalFailed = true;
            console.error(`${logPrefix} 未发布的障碍资源释放失败`, error);
          }
        }
        if (npcCleanupFailed || routeDisposalFailed) {
          failed = true;
          failure ??= new Error("Unpublished spawn cleanup failed");
          try {
            options.lifecycle?.onUnpublishedCleanupFailure({ npc, npcCleanupFailed,
              routeResource, routeDisposalAttempted, routeDisposalFailed });
          } catch (error) {
            // Do not announce a clean settlement when the owner failed to keep
            // the captured cleanup failure. Retain its pending/protection gate.
            canSettle = false;
            console.error(`${logPrefix} 清理失败未能记入租约，保留创建中保护门`, error);
          }
        }
      }
      if (failed) {
        try { options.lifecycle?.onFailure(failure); }
        catch (error) {
          canSettle = false;
          console.error(`${logPrefix} 准备失败未能记入租约，保留创建中保护门`, error);
        }
        console.error(`${logPrefix} 测试遭遇准备失败，未使用猜测地形回退`, failure);
      }
      if (canSettle) {
        try { settleTask(); }
        catch (error) { console.error(`${logPrefix} 创建任务结算失败`, error); }
      }
    }
  };
  try {
    options.lifecycle?.onSpawnTaskStarted();
    setTimeout(runSpawnTask, delayMs);
  } catch (error) {
    // No async task exists if start bookkeeping or scheduling failed. Settle
    // even a partially completed start hook, then preserve the original error.
    try { options.lifecycle?.onFailure(error); }
    catch (reportError) { console.error(`${logPrefix} 同步创建失败未能记入租约`, reportError); }
    try { settleTask(); }
    catch (settleError) { console.error(`${logPrefix} 同步创建任务结算失败`, settleError); }
    throw error;
  }
}

export function testZombieInFrontOnSpawn(
  server: ZoneServer2016,
  client: ZoneClient2016
): void {
  spawnTestZombieForClient(server, client, {
    delayMs: SPAWN_DELAY_MS,
    addAiDelayMs: ADD_AI_DELAY_MS,
    // Login preview keeps full-data/clock observation, but never chases unattended.
    // Protected replay explicitly supplies noAi:false and its own start/lease gates.
    noAi: true,
    distance: 6,
    logPrefix: "[test-zombie]",
    terrain: getTestZombieTerrainOptions()
  });
}

export function getTestZombieTerrainOptions(): NonNullable<SpawnTestZombieOptions["terrain"]> {
  return {
    assetRoot: process.env.TEST_ZOMBIE_TERRAIN_ROOT ?? "D:/WindowsOnly/Games/H1EMU_Client/Resources/Assets/unpacked",
    decoderPath: process.env.TEST_ZOMBIE_TERRAIN_DECODER ?? resolve(__dirname, "../../../../cnkdec/bin/cnkdec.exe")
  };
}
