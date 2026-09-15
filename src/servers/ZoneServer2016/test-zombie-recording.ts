import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CoupledZombieRecorder } from "./test-zombie-native-capture";

export interface ZombieRecordingReady { output: string; gamePid: number; gameCreateTimeFileTime?: string }
export interface ZombieRecordingContext { target: string; playerCharacterId: string; scene: string; distance: number; knownObstacle: string | null }
export interface ZombieRecordingResult {
  output: string; state: "saved" | "failed"; error?: string;
  nativeCapture?: object;
}
export interface ZombieRecordingSession {
  ready: Promise<ZombieRecordingReady>;
  /** Always resolves; includes finalization/child-exit failures, not gameplay PASS. */
  done: Promise<ZombieRecordingResult>;
  stop(): void;
  record?(event: object): void;
  nativeStatus?(): object;
}
export interface ZombieScenarioRecorder { start(runId: string, context?: ZombieRecordingContext): ZombieRecordingSession }

type SpawnRecorder = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
interface RecorderOptions {
  executable: string;
  outputRoot: string;
  spawn?: SpawnRecorder;
  startupMs?: number;
  finalizeMs?: number;
  lifetimeMs?: number;
}

/** Opt-in local developer recorder; no shell, hotkeys, audio, or desktop fallback. */
export class LocalZombieRecorder implements ZombieScenarioRecorder {
  private busy = false;
  constructor(private readonly options: RecorderOptions) {}

  start(runId: string): ZombieRecordingSession {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId))
      throw Error("Invalid recording run UUID");
    if (this.busy) throw Error("Previous recording has not exited; inspect recorder status");
    if (!path.isAbsolute(this.options.executable) || !fs.statSync(this.options.executable).isFile())
      throw Error("Local recorder is not built");
    const root = path.resolve(this.options.outputRoot);
    fs.mkdirSync(root, { recursive: true });
    const directory = path.join(root, runId);
    // Exclusive directory prevents a repeat UUID from overwriting any prior evidence.
    fs.mkdirSync(directory);
    const output = path.join(directory, "game.mp4");
    const eventsPath = path.join(directory, "events.jsonl");
    fs.writeFileSync(eventsPath, "", { flag: "wx" });
    this.busy = true;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (this.options.spawn ?? spawn)(this.options.executable,
        ["--run", runId, "--output", output], { windowsHide: true, shell: false });
    } catch (error) {
      this.busy = false;
      throw error;
    }

    let readyResolve!: (result: ZombieRecordingReady) => void;
    let readyReject!: (error: Error) => void;
    let doneResolve!: (result: ZombieRecordingResult) => void;
    const ready = new Promise<ZombieRecordingReady>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    // A synchronous caller may fail during setup before attaching its continuation.
    void ready.catch(() => {});
    const done = new Promise<ZombieRecordingResult>(resolve => { doneResolve = resolve; });
    let readySeen = false, savedSeen = false, stopping = false, settled = false, exited = false;
    let failure: string | undefined, buffer = "", receivedBytes = 0, eventBytes = 0;
    let finalizeTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const append = (entry: object) => {
      try {
        const line = JSON.stringify(entry) + "\n";
        eventBytes += Buffer.byteLength(line);
        if (eventBytes > 2 * 1024 * 1024) throw Error("recording_event_log_limit");
        fs.appendFileSync(eventsPath, line);
      } catch { failure ??= "recording_event_log_failed"; }
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer); clearTimeout(lifetimeTimer);
      clearTimeout(finalizeTimer); clearTimeout(killTimer);
      if (!readySeen) readyReject(Error(failure ?? "Recording stopped before first encoded frame"));
      if (!savedSeen && !failure) failure = "recorder_exited_without_saved_file";
      if (!failure) {
        try {
          if (!fs.statSync(output).isFile() || fs.statSync(output).size < 32)
            failure = "recording_file_missing_or_empty";
        } catch { failure = "recording_file_missing_or_empty"; }
      }
      const result: ZombieRecordingResult = { output, state: failure ? "failed" : "saved", ...(failure ? { error: failure } : {}) };
      append({ utc: new Date().toISOString(), id: runId, event: "recorder_finalized", ...result, processExited: exited });
      if (failure) { result.state = "failed"; result.error = failure; }
      try { fs.writeFileSync(path.join(directory, "recording.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" }); }
      catch { result.state = "failed"; result.error = "recording_manifest_write_failed"; }
      // If termination cannot be confirmed, do not admit another recorder.
      if (exited) this.busy = false;
      doneResolve(result);
    };
    const stop = () => {
      if (stopping || settled) return;
      stopping = true;
      try { child.stdin.end(JSON.stringify({ action: "stop" }) + "\n"); }
      catch { failure ??= "recorder_stop_pipe_failed"; }
      finalizeTimer = setTimeout(() => {
        failure ??= "recorder_finalize_timeout";
        try { child.kill(); } catch { /* Keep ownership until exit is known. */ }
        killTimer = setTimeout(() => {
          failure = "recorder_termination_unconfirmed";
          settle();
        }, 2000);
        killTimer.unref?.();
      }, this.options.finalizeMs ?? 10000);
      finalizeTimer.unref?.();
    };
    const fail = (message: string) => {
      if (settled) return;
      failure ??= message;
      if (!readySeen) readyReject(Error(message));
      stop();
    };
    const startupTimer = setTimeout(() => fail("recorder_first_frame_timeout"), this.options.startupMs ?? 10000);
    const lifetimeTimer = setTimeout(() => fail("recorder_lifetime_timeout"), this.options.lifetimeMs ?? 110000);
    startupTimer.unref?.(); lifetimeTimer.unref?.();
    child.stdin.on("error", () => fail("recorder_stdin_failed"));
    child.stdout.on("error", () => fail("recorder_stdout_failed"));
    child.stderr.on("error", () => fail("recorder_stderr_failed"));
    child.on("error", () => { fail("recorder_process_error"); });
    child.stderr.on("data", () => { /* Drain diagnostics; only structured errors are recorded. */ });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      receivedBytes += Buffer.byteLength(chunk);
      if (receivedBytes > 65536) { fail("recorder_protocol_limit"); return; }
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.run !== runId || (event.output !== undefined && path.resolve(event.output) !== output))
            throw Error("recorder_identity_mismatch");
          append({ utc: new Date().toISOString(), id: runId, event: "recorder_message", message: event });
          if (event.event === "ready") {
            if (readySeen || savedSeen || event.output !== output || !Number.isSafeInteger(event.gamePid) || event.gamePid <= 0)
              throw Error("recorder_invalid_ready");
            if (!stopping && !failure) {
              readySeen = true; clearTimeout(startupTimer);
              readyResolve({ output, gamePid: event.gamePid,
                ...(typeof event.gameCreateTimeFileTime === "string" && /^\d{18}$/.test(event.gameCreateTimeFileTime)
                  ? { gameCreateTimeFileTime: event.gameCreateTimeFileTime } : {}) });
            }
          } else if (event.event === "saved") {
            if (savedSeen || !readySeen || event.output !== output || !Number.isSafeInteger(event.frames) || event.frames < 1)
              throw Error("recorder_invalid_saved");
            savedSeen = true;
            // Finalized video is not enough: wait for the owned process to exit.
            stop();
          } else if (event.event === "error") {
            fail(typeof event.message === "string" ? event.message.slice(0, 512) : "recorder_error");
          } else throw Error("recorder_unknown_event");
        } catch (error) { fail(error instanceof Error ? error.message : "recorder_invalid_message"); }
      }
    });
    child.on("close", (code: number | null) => {
      exited = true;
      if (code !== 0) failure ??= "recorder_process_exit_" + String(code);
      if (buffer.trim()) failure ??= "recorder_partial_message";
      if (settled) { this.busy = false; return; }
      settle();
    });
    // recorder_finalized is the sidecar's terminal event; later scenario chat
    // notifications remain in the main server log, not in a finalized manifest.
    return { ready, done, stop, record: entry => { if (!settled) append(entry); } };
  }
}

export function configuredZombieRecorder(): ZombieScenarioRecorder | undefined {
  if (process.env.ZTEST_RECORDING !== "1") return undefined;
  // Enabling recording is explicit and local; a missing helper fails the test, never silently skips recording.
  const video = new LocalZombieRecorder({
    executable: path.resolve("tools/ztest-recorder/publish/ZTestRecorder.exe"),
    outputRoot: path.resolve("tools/task-01a06a01/recordings")
  });
  if (process.env.ZTEST_NATIVE_CAPTURE !== "1") return video;
  return new CoupledZombieRecorder(video, {
    python: path.resolve("C:/Python312/python.exe"),
    worker: path.resolve("tools/task-01a06a01/capture_ztest_scenario.py")
  });
}
