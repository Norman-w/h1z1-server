import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ZoneServer2016 } from "./zoneserver";
import type { ZoneClient2016 } from "./classes/zoneclient";
import type { TestZombieReplay } from "./test-zombie-replay";
import type { ZombieScenarioRecorder, ZombieRecordingSession, ZombieRecordingReady, ZombieRecordingResult } from "./test-zombie-recording";
import { enterTestZombieEnvironment } from "./test-zombie-environment";

// A reliable position receipt can arrive just after the first one-second
// polling window on a local client. The receipt is already fenced by count,
// movement version and (when available) sequence time, so this is only a
// bounded freshness guard—not an animation readiness signal.
const POSITION_RECEIPT_MAX_AGE_MS = 5000;

export interface ZombieTestScene {
  position: readonly [number, number, number, number];
  description: string;
  distance?: number;
  knownObstacle?: "fence-192060";
  movementMode?: "server" | "client-seek" | "mixed";
}
type ReplayStatus = {
  state: string; replayId?: string; target?: string; npcCharacterId?: string | null;
  requestId?: string; playerCharacterId?: string;
  distance?: number; knownObstacle?: "fence-192060";
  movementMode?: "server" | "client-seek" | "mixed";
  startedAt?: number | null; protectionApplied?: boolean; cleanupError?: string | null;
  reason?: string | null;
  spawnTaskPending?: boolean;
  prestartPositionFailure?: object | null;
};
interface Run {
  id: string; client: ZoneClient2016; character: ZoneClient2016["character"];
  target: string; playerCharacterId: string;
  scene: ZombieTestScene; phase: "recording" | "positioning" | "preparing" | "running";
  distance: number; knownObstacle?: "fence-192060";
  began: number; movedAt: number; receiptsBefore: number; sequenceBefore: number | null;
  diagnosticSequenceBefore: number;
  requestedVersion: number; positionWait?: string; runningSince?: number;
  replayId?: string; lastPrompt: number; restore: () => void;
  cleanupIdentity?: { replayId: string; target: string; npcCharacterId: string | null };
  timer?: ReturnType<typeof setInterval>; deadline?: ReturnType<typeof setTimeout>;
  recording?: ZombieRecordingSession; recordingReady?: ZombieRecordingReady;
  recordingResult?: ZombieRecordingResult; recordingStopRequested?: boolean;
  recordingLogError?: string; recordingStopError?: string;
}
type ReplayCleanup = { error: string | null; retryable: boolean };
interface PendingCleanup {
  run: Run; reason: string; replay: ReplayCleanup; environmentError: string | null;
}

/** Solo developer experiment. Logged positions are server observations, not native animation proof. */
export class TestZombieScenario {
  private active?: Run;
  private last: object = { state: "idle" };
  private cleanupBlocked = false;
  private pendingCleanup?: PendingCleanup;
  private disposed = false;
  private recordingPending?: Run;
  constructor(
    private readonly zone: ZoneServer2016,
    private readonly replay: Pick<TestZombieReplay, "getStatus" | "handle">,
    private readonly scenes: Readonly<Record<string, ZombieTestScene>>,
    private readonly environment = enterTestZombieEnvironment,
    private readonly now = () => performance.now(),
    private readonly log = (event: object) => console.log("[ztest] " + JSON.stringify(event)),
    private readonly recorder?: ZombieScenarioRecorder
  ) {}

  status(): object {
    const run = this.active;
    return run ? { id: run.id, state: run.phase, replayId: run.replayId ?? null,
      scene: run.scene.description, movementMode: run.scene.movementMode ?? "server",
      suiteVersion: 2, distance: run.distance, knownObstacle: run.knownObstacle ?? null,
      elapsedMs: this.now() - run.began, requestedVersion: run.requestedVersion,
      positionWait: run.positionWait ?? null, ...this.recordingStatus(run) } : this.recordingPending ?
      { ...this.last, ...this.recordingStatus(this.recordingPending) } : this.last;
  }

  isActive(): boolean { return this.active !== undefined || this.recordingPending !== undefined; }

  handle(client: ZoneClient2016, args: string[]): void {
    try {
      if (this.disposed) throw Error("Test controller stopped");
      if (args.length !== 1) throw Error("Usage: /ztest flat | slope | fence | seek | mixed | stop | status (v2)");
      if (!this.zone._soloMode || Object.values(this.zone._clients).length !== 1 ||
          this.zone._clients[client.sessionId] !== client) throw Error("Local solo client required");
      if (args[0] === "status") { this.tell(client, JSON.stringify(this.status())); return; }
      if (args[0] === "stop") {
        if (this.active && this.active.client !== client) throw Error("Different test owner");
        if (this.active) this.close(this.active, "operator_stop");
        else if (this.pendingCleanup) this.retryCleanup(client, this.pendingCleanup);
        else if (this.recordingPending) this.tell(client, "Recording is still finalizing; wait for its saved/failed result.");
        else this.tell(client, "No active test");
        return;
      }
      const scene = Object.hasOwn(this.scenes, args[0]) ? this.scenes[args[0]] : undefined;
      if (!scene) throw Error("Usage: /ztest flat | slope | fence | seek | mixed | stop | status (v2)");
      // A cancelled async creator can settle after this scenario closes. Only
      // reconcile that bounded wait on an explicit new command; status stays
      // read-only and ordinary cleanup failures still require exact recovery.
      if (this.pendingCleanup?.replay.error === "spawn_task_pending_cleanup_protection_retained" &&
          (this.replay.getStatus() as ReplayStatus).spawnTaskPending === false) {
        this.retryCleanup(client, this.pendingCleanup);
      }
      if (this.active || this.cleanupBlocked || this.recordingPending) throw Error("Previous test active, recording finalizing or cleanup incomplete");
      const baseline = this.positionBaseline(client);
      const { character } = baseline;
      if (scene.position.length !== 4 || !scene.position.every(Number.isFinite) || scene.position[3] !== 1)
        throw Error("Invalid fixed scene");
      const distance = scene.distance ?? 12, knownObstacle = scene.knownObstacle;
      if (!Number.isFinite(distance) || distance < 6 || distance > 12 ||
          (knownObstacle !== undefined && (knownObstacle !== "fence-192060" || distance !== 6)))
        throw Error("Invalid fixed scene recipe");
      const began = this.now();
      if (!Number.isFinite(began) || began < 0) throw Error("Invalid monotonic clock");
      const run: Run = { id: randomUUID(), client, character,
        target: String(client.sessionId), playerCharacterId: character.characterId,
        scene: { ...scene, position: [...scene.position] }, distance, knownObstacle, phase: this.recorder ? "recording" : "positioning",
        began, movedAt: Date.now(), receiptsBefore: baseline.receiptsBefore,
        sequenceBefore: baseline.sequenceBefore, diagnosticSequenceBefore: baseline.diagnosticSequenceBefore,
        requestedVersion: baseline.requestedVersion, lastPrompt: -1, restore() {} };
      this.active = run;
      try {
        run.timer = setInterval(() => this.tick(run), 100); run.timer.unref?.();
        if (this.recorder) this.beginRecording(run);
        else this.beginPositioning(run);
      } catch (error) { this.close(run, "setup_failed"); throw error; }
    } catch (error) {
      // A disconnected/broken chat transport must not escape the command handler.
      try { this.tell(client, error instanceof Error ? error.message : "Test command failed"); } catch { /* best effort */ }
    }
  }

  private positionBaseline(client: ZoneClient2016) {
    if (!this.zone._soloMode || this.zone._clients[client.sessionId] !== client || Object.values(this.zone._clients).length !== 1)
      throw Error("Local solo client required");
    const previous = this.replay.getStatus() as ReplayStatus;
    if (!["idle", "finished", "failed"].includes(previous.state) || previous.protectionApplied === true || previous.cleanupError)
      throw Error("Another replay is active or cleanup incomplete");
    const character = client.character, version = client.testZombieMovementVersion;
    const diagnosticSequenceBefore = client.testZombieClockDiagnostics?.lastSequenceTime;
    if (!character.isAlive || character.isRespawning || client.isLoading || !client.isSynced ||
        !client.testZombieSpawned || client.vehicle?.mountedVehicle || !Number.isInteger(version) ||
        version! < 0 || version! > 255 || !Number.isInteger(diagnosticSequenceBefore) ||
        diagnosticSequenceBefore! < 0 || diagnosticSequenceBefore! > 0xffffffff)
      throw Error("Enter world alive, unmounted; wait for movement sync");
    const receipt = client.testZombiePositionReceipt;
    if (receipt && (!Number.isSafeInteger(receipt.count) || receipt.count < 1 || receipt.count >= Number.MAX_SAFE_INTEGER ||
        receipt.clockAligned !== true || !Number.isInteger(receipt.sequenceTime) || receipt.sequenceTime < 0 ||
        receipt.sequenceTime > 0xffffffff)) throw Error("Invalid prior position receipt");
    // Misaligned diagnostic headers are not position ordering baselines. Only
    // actual same-owner aligned receipts establish the previous position epoch.
    const sequenceBefore = receipt?.character === character && receipt.playerCharacterId === character.characterId ? receipt.sequenceTime : null;
    return { character, requestedVersion: (version! + 1) & 255, diagnosticSequenceBefore: diagnosticSequenceBefore!,
      receiptsBefore: receipt?.count ?? 0, sequenceBefore };
  }

  private ownerCurrent(run: Run): boolean {
    return this.zone._clients[run.client.sessionId] === run.client && run.client.character === run.character &&
      String(run.client.sessionId) === run.target && run.character.characterId === run.playerCharacterId &&
      Object.values(this.zone._clients).length === 1 && run.character.isAlive && !run.character.isRespawning &&
      !run.client.vehicle?.mountedVehicle;
  }

  private beginPositioning(run: Run): void {
    if (this.disposed || this.active !== run || !this.ownerCurrent(run)) throw Error("Test owner changed before positioning");
    // Recording startup is asynchronous: recompute every receipt/version/clock
    // baseline now, not from the command entry snapshot. No observed state is advanced.
    const baseline = this.positionBaseline(run.client);
    const began = this.now();
    if (!Number.isFinite(began) || began < run.began) throw Error("Invalid monotonic clock");
    const packet = this.zone._protocol.pack("ClientUpdate.UpdateLocation", {
      position: [...run.scene.position], rotation: [0, 0, 1, 0], unknownBoolean1: true,
      unknownByte1: baseline.requestedVersion, triggerLoadingScreen: false
    });
    if (!packet || packet.length !== 38) throw Error("Position packet not packed");
    const environment = this.environment(this.zone);
    run.restore = () => environment.restore();
    Object.assign(run, baseline, { began, movedAt: Date.now(), phase: "positioning" });
    clearTimeout(run.deadline);
    run.deadline = setTimeout(() => this.close(run, "overall_timeout"), 90000); run.deadline.unref?.();
    this.zone.sendRawDataReliable(run.client, packet);
    this.record(run, "position_instruction", { destination: run.scene.position, suiteVersion: 2, distance: run.distance,
      knownObstacle: run.knownObstacle ?? null, requestedVersion: run.requestedVersion, receiptsBefore: run.receiptsBefore,
      sequenceBefore: run.sequenceBefore, diagnosticSequenceBefore: run.diagnosticSequenceBefore,
      sequenceBeforeSource: run.sequenceBefore === null ? "no_same_owner_aligned_position_receipt" : "same_owner_aligned_position_receipt",
      meaning: "one position instruction, not collision clearance or native ACK" });
    this.tell(run.client, `${run.id.slice(0, 8)} ${run.scene.description}: setting clear noon. Stay still until START.`);
  }

  private beginRecording(run: Run): void {
    const session = this.recorder!.start(run.id, { target: run.target, playerCharacterId: run.playerCharacterId,
      scene: run.scene.description, distance: run.distance, knownObstacle: run.knownObstacle ?? null });
    run.recording = session;
    this.recordingPending = run;
    // Install both rejection handlers before logging or chat can throw. done is
    // contractually non-rejecting; a violation retains the gate rather than
    // claiming that an unconfirmed recorder process has stopped.
    void session.done.then(result => this.recordingDone(run, result), () => {
      if (this.active === run) this.close(run, "recording_finalization_unknown");
    }).catch(() => { if (this.active === run) this.close(run, "recording_callback_failed"); });
    void session.ready.then(ready => {
      if (this.disposed || this.active !== run || run.phase !== "recording") return;
      try {
        const age = this.now() - run.began;
        if (!Number.isFinite(age) || age < 0 || age >= 12000) throw Error("Recording startup deadline expired");
        run.recordingReady = ready;
        this.record(run, "recording_ready", { output: ready.output, gamePid: ready.gamePid });
        this.beginPositioning(run);
      } catch (error) {
        try { this.record(run, "recording_setup_failed", { message: error instanceof Error ? error.message : String(error) }); }
        catch { /* Always close even if diagnostics fail. */ }
        this.close(run, "recording_setup_failed");
      }
    }, () => { if (this.active === run) this.close(run, "recording_start_failed"); })
      .catch(() => { if (this.active === run) this.close(run, "recording_callback_failed"); });
    run.deadline = setTimeout(() => this.close(run, "recording_start_timeout"), 12000); run.deadline.unref?.();
    this.record(run, "recording_starting");
    this.tell(run.client, `${run.id.slice(0, 8)} starting local game-window recording; stay still.`);
  }

  private recordingStatus(run: Run): object {
    if (!run.recording) return {};
    return { recording: run.recordingResult?.state ?? (run.recordingStopRequested ? "finalizing" : run.recordingReady ? "recording" : "starting"),
      recordingOutput: run.recordingResult?.output ?? run.recordingReady?.output ?? null,
      recordingError: run.recordingResult?.error ?? run.recordingStopError ?? null, recordingLogError: run.recordingLogError ?? null,
      ...(run.recording.nativeStatus ? { nativeCapture: run.recording.nativeStatus() } : {}) };
  }

  private recordingDone(run: Run, result: ZombieRecordingResult): void {
    run.recordingResult = result;
    if (this.active === run) this.close(run, "recording_ended_early");
    if (this.recordingPending === run) this.recordingPending = undefined;
    if ((this.last as { id?: string }).id === run.id) this.last = { ...this.last, ...this.recordingStatus(run) };
    try { this.record(run, result.state === "saved" ? "recording_saved" : "recording_failed", result); }
    catch { /* Preserve status even when diagnostics cannot be written. */ }
    if (this.zone._clients[run.client.sessionId] === run.client && run.client.character === run.character) {
      try { this.tell(run.client, `${run.id.slice(0, 8)} recording ${result.state}: ${result.output}${result.error ? "; " + result.error : ""}. Recording is evidence, not a PASS.`); }
      catch { /* Finalization must not depend on chat availability. */ }
    }
  }

  private tell(client: ZoneClient2016, message: string): void {
    this.zone.sendChatText(client, "[ztest v2] " + message, true);
  }
  private record(run: Run, event: string, details: object = {}): void {
    const entry = { utc: new Date().toISOString(), id: run.id, event, ...details };
    try { this.log(entry); }
    finally {
      try { run.recording?.record?.(entry); }
      catch { run.recordingLogError = "recording_event_copy_failed"; }
    }
  }
  private tick(run: Run): void {
    if (this.active !== run) return;
    try {
      if (!this.ownerCurrent(run)) { this.close(run, "client_changed_or_unavailable"); return; }
      const age = this.now() - run.began;
      if (!Number.isFinite(age) || age < 0 || age > 90000) { this.close(run, "invalid_time_or_timeout"); return; }
      if (run.phase === "recording") {
        if (age >= 12000) this.close(run, "recording_start_timeout");
        return;
      }
      if (run.phase === "positioning") {
        if (age > 15000) { this.close(run, "position_not_confirmed"); return; }
        const waiting = this.positionWaitReason(run);
        if (waiting) {
          if (run.positionWait !== waiting) {
            run.positionWait = waiting;
            this.record(run, "position_wait", this.positionEvidence(run));
          }
          return;
        }
        run.positionWait = undefined;
        const p = run.character.state.position;
        // An explicit new slash test owns a new bounded clock-refresh epoch.
        // Rebase only after its real versioned position receipt is confirmed:
        // otherwise an earlier test's pending version/budget can strand this one.
        // Ordinary inbound traffic and automatic retries never reset the budget.
        this.record(run, "position_confirmed", { ...this.positionEvidence(run),
          previousClockRefresh: run.client.testZombieClockResync ?? null,
          clockRefreshScope: "three existing cooldown-limited attempts for this explicit run" });
        run.client.testZombieClockResync = { count: 0, requestedAt: run.movedAt,
          requestedVersion: run.requestedVersion };
        const result = this.replay.handle({ action: "prepare", target: run.target,
          requestId: "ztest-" + run.id, expectedPlayerCharacterId: run.playerCharacterId,
          expectedNpcCharacterId: this.zone._lastSpawnedNpcCharacterId ?? null, distance: run.distance,
          ...(run.scene.movementMode ? { movementMode: run.scene.movementMode } : {}),
          ...(run.knownObstacle ? { knownObstacle: run.knownObstacle } : {}) }) as ReplayStatus;
        run.replayId = result.replayId; run.phase = "preparing";
        this.record(run, "position_observed_and_prepare", { player: Array.from(p), replay: result,
          positionEvidence: this.positionEvidence(run) });
        return;
      }
      const state = this.replay.getStatus() as ReplayStatus;
      if (state.replayId !== run.replayId || state.target !== run.target) {
        this.close(run, "replay_identity_changed"); return;
      }
      if (state.distance !== run.distance || state.knownObstacle !== run.knownObstacle) {
        this.close(run, "replay_recipe_changed"); return;
      }
      if ((state.movementMode ?? "server") !== (run.scene.movementMode ?? "server")) {
        this.close(run, "replay_movement_mode_changed"); return;
      }
      if (["finished", "failed"].includes(state.state)) {
        if (state.prestartPositionFailure) this.record(run, "prestart_position_failure", state.prestartPositionFailure);
        this.close(run, state.reason ?? state.state); return;
      }
      if (state.state === "paused") {
        const npc = state.npcCharacterId ? this.zone._npcs[state.npcCharacterId] : undefined;
        const p = run.character.state.position, spawn = npc?.state.position;
        // A turn during async preparation must not substitute another corridor.
        if (!spawn || !Array.from(spawn).every(Number.isFinite) ||
            Math.hypot(spawn[0] - p[0], spawn[2] - p[2] - run.distance) > 0.05) {
          this.close(run, "fixed_spawn_direction_not_confirmed"); return;
        }
        this.replay.handle({ action: "start", target: state.target, replayId: state.replayId,
          expectedNpcCharacterId: state.npcCharacterId });
      }
      if (state.state !== "running") {
        if (age > 30000) this.close(run, "readiness_timeout");
        return;
      }
      if (run.runningSince === undefined) {
        run.runningSince = this.now(); run.phase = "running";
        this.record(run, "running", { replayId: run.replayId, npc: state.npcCharacterId });
      }
      const elapsed = this.now() - run.runningSince;
      if (elapsed >= 45000) { this.close(run, "completed_observation_window"); return; }
      const stage = Math.floor(elapsed / 10000);
      if (stage !== run.lastPrompt) {
        run.lastPrompt = stage;
        const prompts = run.knownObstacle ? [
          "START: stay here; watch the zombie go around the WEST end of this fence.",
          "Keep this fence between you and the zombie; watch for unwanted attacks through planks.",
          "Go around the WEST end to the same side; approach the zombie.",
          "On the same side, step into and out of melee range; watch attack timing.",
          "Stay still for 5 seconds. Only this named fence is checked; other collision is unknown."
        ] : run.scene.movementMode === "client-seek" ? [
          "START: client-seek-only A/B; stand still and watch approach/feet.",
          "Move sideways a few steps; this run should not send PlayerUpdatePosition.",
          "Back away, then stop; watch native seek restart and stop.",
          "Approach, then leave melee range; watch ClearMovementRail and attack timing.",
          "Stay still; test ends in 5 seconds."
        ] : run.scene.movementMode === "mixed" ? [
          "START: production-style mixed-input A/B; stand still and watch approach/feet.",
          "Move sideways a few steps; this path sends SeekTarget and PlayerUpdatePosition.",
          "Back away, then stop; watch for a snap, drift or duplicated movement.",
          "Approach, then leave melee range; watch ClearMovementRail and attack timing.",
          "Stay still; test ends in 5 seconds."
        ] : ["START: stand still; watch approach and feet.",
          "Move sideways a few steps; watch turning.", "Back away, then stop; watch chase restart and stop.",
          "Approach, then leave melee range; watch attack timing.", "Stay still; test ends in 5 seconds."];
        this.tell(run.client, prompts[stage]);
        this.record(run, "operator_prompt", { stage });
      }
      const npc = state.npcCharacterId ? this.zone._npcs[state.npcCharacterId] : undefined;
      this.record(run, "server_sample", { elapsedMs: elapsed, player: Array.from(run.character.state.position),
        npc: npc ? Array.from(npc.state.position) : null,
        rotation: npc ? Array.from(npc.state.rotation) : null, behavior: npc?.behaviorState,
        meaning: "server state only; animation/contact must be observed in game" });
    } catch (error) {
      try { this.record(run, "error", { message: error instanceof Error ? error.message : String(error) }); }
      catch { /* Cleanup must still run when the logger itself failed. */ }
      finally { this.close(run, "scenario_error"); }
    }
  }

  private positionWaitReason(run: Run): string | undefined {
    const client = run.client, receipt = client.testZombiePositionReceipt;
    if (client.isLoading || !client.isSynced) return "client_not_ready";
    if (!receipt || receipt.count <= run.receiptsBefore) return "new_position_receipt_missing";
    if (receipt.character !== run.character || receipt.playerCharacterId !== run.playerCharacterId)
      return "position_receipt_owner_changed";
    if (receipt.movementVersion !== run.requestedVersion) return "position_receipt_version_mismatch";
    if (client.testZombieMovementVersion !== run.requestedVersion) return "current_movement_version_changed";
    if (run.sequenceBefore !== null && ((receipt.sequenceTime - run.sequenceBefore) | 0) <= 0)
      return "position_receipt_sequence_not_new";
    const receiptAge = Date.now() - receipt.receivedAt;
    if (receipt.receivedAt < run.movedAt || receiptAge < 0 || receiptAge > POSITION_RECEIPT_MAX_AGE_MS)
      return "position_receipt_stale";
    if (client.isInAir) return "player_airborne";
    const p = run.character.state.position;
    if (!p || p.length !== 4 || !Array.from(p).every(Number.isFinite)) return "invalid_current_position";
    // Both views must describe the same actual applied packet, not a fresh
    // clock/rotation packet combined with an unrelated cached position.
    if ([0, 1, 2, 3].some(i => p[i] !== receipt.position[i])) return "position_changed_since_receipt";
    if (Math.hypot(p[0] - run.scene.position[0], p[2] - run.scene.position[2]) > 0.25 ||
        Math.abs(p[1] - run.scene.position[1]) > 1) return "position_outside_fixed_scene";
    const rotation = run.character.state.rotation;
    if (!rotation || rotation.length !== 4 || !Array.from(rotation).every(Number.isFinite) ||
        Math.abs(Math.hypot(...rotation) - 1) > 0.01) return "invalid_current_facing";
    // `ClientUpdate.UpdateLocation` teleports position but does not rotate the
    // player's camera on this client. The encounter spawn records the actual
    // current heading, so rejecting a valid receipt merely because the user
    // had looked elsewhere made `/ztest flat` fail before the NPC existed.
    // Camera direction is visual-test context, not a movement/animation ACK.
    return undefined;
  }

  private positionEvidence(run: Run): object {
    const receipt = run.client.testZombiePositionReceipt;
    const vector = (value: Float32Array | undefined) => value ? Array.from(value) : null;
    return { requestedVersion: run.requestedVersion, receiptsBefore: run.receiptsBefore,
      sequenceBefore: run.sequenceBefore, diagnosticSequenceBefore: run.diagnosticSequenceBefore,
      sequenceBeforeSource: run.sequenceBefore === null ? "no_same_owner_aligned_position_receipt" : "same_owner_aligned_position_receipt",
      waiting: run.positionWait ?? null,
      currentMovementVersion: run.client.testZombieMovementVersion ?? null,
      currentPosition: vector(run.character.state.position),
      currentRotation: vector(run.character.state.rotation),
      isLoading: run.client.isLoading, isSynced: run.client.isSynced, isInAir: run.client.isInAir,
      receipt: receipt ? { count: receipt.count, playerCharacterId: receipt.playerCharacterId,
        sameCharacter: receipt.character === run.character, receivedAt: receipt.receivedAt,
        sequenceTime: receipt.sequenceTime, flags: receipt.flags, movementVersion: receipt.movementVersion,
        position: receipt.position, rotation: receipt.rotation } : null,
      meaning: "actual inbound position receipt and current server state, not native animation readiness" };
  }

  private close(run: Run, reason: string): void {
    if (this.active !== run) return;
    if (run.phase === "positioning") {
      try { this.record(run, "positioning_closed", { reason, ...this.positionEvidence(run) }); }
      catch { /* Diagnostic failure must never prevent cleanup. */ }
    }
    this.active = undefined;
    clearInterval(run.timer); clearTimeout(run.deadline);
    const stopRecording = run.recording && !run.recordingStopRequested;
    if (stopRecording) run.recordingStopRequested = true;
    const replay = this.finishOwnedReplay(run);
    let environmentError: string | null = null;
    // Environment restoration can include a native/worker ownership failure;
    // unlike replay.finish it does not promise that another attempt is safe.
    try { run.restore(); } catch { environmentError = "environment_restore_failed"; }
    try { this.publishCleanup({ run, reason, replay, environmentError }, "closed"); }
    finally {
      if (stopRecording) {
        try { run.recording!.stop(); }
        catch {
          run.recordingStopError = "recording_stop_failed";
          this.last = { ...this.last, ...this.recordingStatus(run) };
        }
      }
    }
  }

  private finishOwnedReplay(run: Run): ReplayCleanup {
    try {
      const state = this.replay.getStatus() as ReplayStatus;
      const ownsRequest = state.requestId === "ztest-" + run.id &&
        state.target === run.target && state.playerCharacterId === run.playerCharacterId;
      // prepare can publish its lease, fail during setup/cleanup, and throw
      // before its caller can save replayId. Recover only this exact request.
      if (!run.replayId && ownsRequest && typeof state.replayId === "string") run.replayId = state.replayId;
      if (!run.replayId || state.replayId !== run.replayId || !ownsRequest) {
        return { error: run.cleanupIdentity ? "owned_replay_identity_changed" : null, retryable: false };
      }
      const npcCharacterId = state.npcCharacterId ?? null;
      if (run.cleanupIdentity && (run.cleanupIdentity.replayId !== state.replayId ||
          run.cleanupIdentity.target !== state.target || run.cleanupIdentity.npcCharacterId !== npcCharacterId)) {
        return { error: "owned_replay_identity_changed", retryable: false };
      }
      run.cleanupIdentity ??= { replayId: run.replayId, target: run.target, npcCharacterId };
      const identity = run.cleanupIdentity;
      const result = this.replay.handle({ action: "finish", target: identity.target, replayId: identity.replayId,
        expectedNpcCharacterId: identity.npcCharacterId }) as ReplayStatus;
      const error = result.cleanupError ?? (result.protectionApplied ? "protection_retained" : null);
      return { error, retryable: error === "owned_npc_cleanup_incomplete_protection_retained_retry_finish" ||
        error === "spawn_task_pending_cleanup_protection_retained" };
    } catch {
      // finish is idempotent for an exact lease. Never broaden a retry to a
      // replacement NPC or infer an owner when even the snapshot failed.
      return { error: "replay_cleanup_failed", retryable: run.cleanupIdentity !== undefined };
    }
  }

  private retryCleanup(client: ZoneClient2016, cleanup: PendingCleanup): void {
    const run = cleanup.run;
    if (client !== run.client || client.character !== run.character) throw Error("Different cleanup owner");
    if (!cleanup.replay.retryable) {
      this.tell(client, "Cleanup incomplete and not safely retryable; inspect /ztest status before administrator recovery.");
      return;
    }
    cleanup.replay = this.finishOwnedReplay(run);
    this.publishCleanup(cleanup, "cleanup_retry");
  }

  private publishCleanup(cleanup: PendingCleanup, event: string): void {
    const { run, reason } = cleanup;
    const cleanupErrors = [cleanup.replay.error, cleanup.environmentError].filter((error): error is string => error !== null);
    const cleanupError = cleanupErrors[0] ?? null;
    this.cleanupBlocked = cleanupErrors.length > 0;
    this.pendingCleanup = this.cleanupBlocked ? cleanup : undefined;
    this.last = { id: run.id, state: cleanupError ? "cleanup_failed" : "stopped", reason, cleanupError,
      cleanupErrors, cleanupRetryable: cleanup.replay.retryable, replayId: run.replayId ?? null,
      suiteVersion: 2, distance: run.distance, knownObstacle: run.knownObstacle ?? null,
      movementMode: run.scene.movementMode ?? "server", ...this.recordingStatus(run) };
    try { this.record(run, event, this.last); } catch { /* status retains the result */ }
    if (this.zone._clients[run.client.sessionId] === run.client) {
      try { this.tell(run.client, `${run.id.slice(0, 8)} ended: ${reason}${cleanupError ? "; " + cleanupError : ""}. Report what you saw; logs alone do not mean PASS.`); }
      catch { /* Cleanup is complete even if the final message cannot be sent. */ }
    }
  }

  dispose(): void {
    if (this.active) this.close(this.active, "server_stopped");
    this.disposed = true;
  }
}
