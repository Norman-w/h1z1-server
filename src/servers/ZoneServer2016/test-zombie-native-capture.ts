import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ZombieScenarioRecorder, ZombieRecordingContext, ZombieRecordingSession, ZombieRecordingResult } from "./test-zombie-recording";

const FLAT = "Low-slope reference (0-1.79 deg, not perfectly flat; static clearance unverified)";
interface Options {
  python: string; worker: string;
  spawn?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
  startupMs?: number; lifetimeMs?: number; stopMs?: number;
}

/** Owns ONE read-only observer for this explicit command, never an unrelated future run. */
export class CoupledZombieRecorder implements ZombieScenarioRecorder {
  private busy = false;
  constructor(private readonly video: ZombieScenarioRecorder, private readonly options: Options) {}

  start(runId: string, context?: ZombieRecordingContext): ZombieRecordingSession {
    if (this.busy) throw Error("Previous coupled capture has not exited");
    if (!context) throw Error("Native capture requires command owner context");
    if (context.scene !== FLAT || context.distance !== 12 || context.knownObstacle !== null) {
      const session = this.video.start(runId, context);
      return { ...session, nativeStatus: () => ({ state: "not_requested", reason: "native_capture_flat_only" }) };
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId) ||
        !/^(0|[1-9][0-9]{0,9})$/.test(context.target) || Number(context.target) > 0xffffffff ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(context.playerCharacterId)) throw Error("Invalid native capture identity");
    const video = this.video.start(runId, context);
    this.busy = true;
    let child: ChildProcessWithoutNullStreams | undefined;
    let stopped = false, exited = false, finished = false, armed = false, sampled = false;
    let capturePath: string | undefined, failure: string | undefined, terminalOk = false;
    let logPath: string | undefined, manifestPath: string | undefined;
    let receivedBytes = 0, logBytes = 0, stderrBytes = 0, buffer = "";
    let status: Record<string, unknown> = { state: "waiting_video", runId };
    let readyResolve!: (ready: Awaited<ZombieRecordingSession["ready"]>) => void;
    let readyReject!: (error: Error) => void;
    let doneResolve!: (result: ZombieRecordingResult) => void;
    let nativeResolve!: () => void;
    const nativeDone = new Promise<void>(resolve => { nativeResolve = resolve; });
    const ready = new Promise<Awaited<ZombieRecordingSession["ready"]>>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    void ready.catch(() => {});
    const done = new Promise<ZombieRecordingResult>(resolve => { doneResolve = resolve; });
    let startup: ReturnType<typeof setTimeout> | undefined;
    let lifetime: ReturnType<typeof setTimeout> | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const append = (entry: object) => {
      const value = { utc: new Date().toISOString(), id: runId, ...entry };
      const line = JSON.stringify(value) + "\n";
      logBytes += Buffer.byteLength(line);
      if (logBytes > 256 * 1024) throw Error("native_capture_log_limit");
      if (!logPath) throw Error("native_capture_log_unavailable");
      fs.appendFileSync(logPath, line);
      video.record?.({ event: "native_capture", ...value });
    };
    const settleNative = () => {
      if (finished) return;
      finished = true;
      clearTimeout(startup); clearTimeout(lifetime); clearTimeout(stopTimer); clearTimeout(killTimer);
      if (!armed) readyReject(Error(failure ?? "native_capture_not_armed"));
      if (!failure && (!terminalOk || !sampled)) failure = "native_capture_missing_samples_or_completion";
      status = { state: failure ? "failed" : "complete", runId, sampled, output: capturePath ?? null,
        processExited: exited, error: failure ?? null };
      try {
        append({ event: "native_capture_finalized", ...status });
        fs.writeFileSync(manifestPath!, JSON.stringify(status, null, 2) + "\n", { flag: "wx" });
      } catch { failure ??= "native_capture_manifest_or_log_failed"; status = { ...status, state: "failed", error: failure }; }
      nativeResolve();
    };
    const stopChild = () => {
      if (!child || exited || finished || stopTimer) return;
      // Owned worker's stdin EOF is a cancellation signal. Escalate only this
      // ChildProcess handle, never search/kill by an old PID or process name.
      try { child.stdin.end(); } catch { failure ??= "native_capture_stop_pipe_failed"; }
      stopTimer = setTimeout(() => {
        if (exited || finished) return;
        failure ??= "native_capture_stop_timeout";
        try { child!.kill(); } catch { /* Do not release busy without close. */ }
        killTimer = setTimeout(() => { failure = "native_capture_termination_unconfirmed"; settleNative(); }, 2000);
        killTimer.unref?.();
      }, this.options.stopMs ?? 3000);
      stopTimer.unref?.();
    };
    const fail = (reason: string) => {
      if (finished) return;
      failure ??= reason;
      status = { ...status, state: "failed", error: failure };
      readyReject(Error(failure));
      try { append({ event: "native_capture_error", error: failure }); } catch { /* Retain failure in final result. */ }
      try { video.stop(); } catch { failure ??= "video_stop_failed"; }
      stopChild();
      if (!child) { exited = true; settleNative(); }
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (!finished) { failure ??= "native_capture_cancelled_before_complete"; readyReject(Error(failure)); }
      try { video.stop(); } finally {
        stopChild();
        if (!child && !finished) { exited = true; settleNative(); }
      }
    };
    // Video creates this exclusive run directory synchronously. Discover it only
    // through its verified ready output; pre-ready failure still reaches server log.
    void video.ready.then(videoReady => {
      if (stopped || finished) return;
      try {
        if (!videoReady.gameCreateTimeFileTime || !/^\d{18}$/.test(videoReady.gameCreateTimeFileTime))
          throw Error("recorder_game_creation_identity_missing");
        const directory = path.dirname(videoReady.output);
        if (!path.isAbsolute(videoReady.output) || path.basename(directory) !== runId || path.basename(videoReady.output) !== "game.mp4")
          throw Error("native_capture_recording_path_mismatch");
        logPath = path.join(directory, "native-capture.jsonl"); manifestPath = path.join(directory, "native-capture.json");
        fs.writeFileSync(logPath, "", { flag: "wx" });
        append({ event: "native_capture_starting", gamePid: videoReady.gamePid, target: context.target });
        for (const file of [this.options.python, this.options.worker])
          if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) throw Error("Native capture worker is not installed");
        const stderrPath = path.join(directory, "native-capture.stderr.log");
        fs.writeFileSync(stderrPath, "", { flag: "wx" });
        child = (this.options.spawn ?? spawn)(this.options.python, ["-B", this.options.worker], { windowsHide: true, shell: false });
        status = { state: "starting", runId, sampled: false };
        startup = setTimeout(() => fail("native_capture_arm_timeout"), this.options.startupMs ?? 8000);
        lifetime = setTimeout(() => fail("native_capture_lifetime_timeout"), this.options.lifetimeMs ?? 75000);
        startup.unref?.(); lifetime.unref?.();
        child.on("error", () => fail("native_capture_process_error"));
        for (const name of ["stdin", "stdout", "stderr"] as const)
          child[name].on("error", () => fail("native_capture_" + name + "_failed"));
        child.stderr.on("data", (data: Buffer) => {
          stderrBytes += data.length;
          if (stderrBytes > 65536) { fail("native_capture_stderr_limit"); return; }
          try { fs.appendFileSync(stderrPath, data); } catch { fail("native_capture_stderr_log_failed"); }
        });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (finished) return;
          receivedBytes += Buffer.byteLength(chunk);
          if (receivedBytes > 65536) { fail("native_capture_protocol_limit"); return; }
          buffer += chunk;
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
            if (!line) continue;
            try {
              const message = JSON.parse(line);
              if (message.run_id !== runId) throw Error("native_capture_run_mismatch");
              append({ event: "native_capture_message", message });
              if (message.status === "SCENARIO_CAPTURE_ARMED") {
                if (armed || stopped || message.client_pid !== videoReady.gamePid) throw Error("native_capture_invalid_arm");
                armed = true; clearTimeout(startup); status = { state: "armed", runId, sampled: false };
                readyResolve(videoReady);
              } else if (message.status === "SLASH_RUN_BOUND") {
                if (!armed || sampled || message.binding?.run_id !== runId || message.binding?.target !== context.target ||
                    message.binding?.player_character_id !== context.playerCharacterId) throw Error("native_capture_binding_mismatch");
                status = { state: "bound", runId, sampled: false, npc: message.binding.guid };
              } else if (message.status === "NATIVE_SAMPLE_READY") {
                if (status.state !== "bound" || sampled || typeof message.output !== "string" ||
                    message.guid !== status.npc || !path.isAbsolute(message.output)) throw Error("native_capture_invalid_sample_ready");
                sampled = true; capturePath = message.output;
                status = { ...status, state: "sampling", sampled, output: capturePath };
              } else if (message.status === "CAPTURE_COMPLETE") {
                if (!sampled || terminalOk || message.exit_code !== 0 || message.output !== capturePath) throw Error("native_capture_invalid_complete");
                terminalOk = true;
              } else if (message.status === "CAPTURE_FAILED") {
                fail(typeof message.reason === "string" ? message.reason.slice(0, 512) : "native_capture_failed");
              } else throw Error("native_capture_unknown_message");
            } catch (error) { fail(error instanceof Error ? error.message : "native_capture_bad_message"); }
          }
        });
        child.on("close", (code: number | null) => {
          exited = true;
          if (code !== 0) failure ??= "native_capture_exit_" + String(code);
          if (buffer.trim()) failure ??= "native_capture_partial_message";
          if (!terminalOk || !sampled || failure) {
            failure ??= "native_capture_exited_before_complete";
            try { video.stop(); } catch { /* Final result retains failure. */ }
          }
          settleNative();
        });
        child.stdin.write(JSON.stringify({ schema: "ztest-scenario-capture.v1", run_id: runId,
          target: context.target, player_character_id: context.playerCharacterId,
          client_pid: videoReady.gamePid, client_filetime: videoReady.gameCreateTimeFileTime,
          server_pid: process.pid, issued_at_unix: Date.now() / 1000 }) + "\n");
      } catch (error) { fail(error instanceof Error ? error.message : "native_capture_setup_failed"); }
    }, error => fail("video_ready_failed:" + String(error)));
    void video.done.then(async videoResult => {
      if (!finished) { failure ??= "recording_ended_before_native_complete"; stopChild(); if (!child) { exited = true; settleNative(); } }
      await nativeDone;
      if (exited) this.busy = false;
      doneResolve({ ...videoResult, ...(failure ? { state: "failed" as const, error: failure } : {}), nativeCapture: { ...status } });
    }, () => fail("video_finalization_unknown"));
    return { ready, done, stop, record: event => video.record?.(event), nativeStatus: () => ({ ...status }) };
  }
}
