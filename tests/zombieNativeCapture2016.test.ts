import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { CoupledZombieRecorder } from "../src/servers/ZoneServer2016/test-zombie-native-capture";
import type { ZombieRecordingReady, ZombieRecordingResult } from "../src/servers/ZoneServer2016/test-zombie-recording";

const scene = "Low-slope reference (0-1.79 deg, not perfectly flat; static clearance unverified)";
const context = { target: "17", playerCharacterId: "0x123", scene, distance: 12, knownObstacle: null };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(t: { after(fn: () => void): void }, opts: { startupMs?: number; stopMs?: number; worker?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "h1z1-coupled-test-")), id = randomUUID();
  const directory = path.join(root, id); fs.mkdirSync(directory);
  t.after(() => {
    const actual = fs.realpathSync(root);
    assert.equal(path.dirname(actual), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(actual), /^h1z1-coupled-test-/); assert.ok(!fs.lstatSync(root).isSymbolicLink());
    fs.rmSync(actual, { recursive: true });
  });
  let resolveReady!: (r: ZombieRecordingReady) => void, rejectReady!: (e: Error) => void;
  let resolveVideo!: (r: ZombieRecordingResult) => void;
  const video = { ready: new Promise<ZombieRecordingReady>((r, j) => { resolveReady = r; rejectReady = j; }),
    done: new Promise<ZombieRecordingResult>(r => { resolveVideo = r; }),
    stops: 0, stop() { this.stops++; }, events: [] as object[], record(e: object) { this.events.push(e); } };
  const output = path.join(directory, "game.mp4");
  const videoReady = { output, gamePid: 500, gameCreateTimeFileTime: "134337300184499603" };
  const children: any[] = [];
  const recorder = new CoupledZombieRecorder({ start: () => video }, {
    python: process.execPath, worker: opts.worker ?? process.execPath, startupMs: opts.startupMs ?? 1000,
    lifetimeMs: 5000, stopMs: opts.stopMs ?? 20,
    spawn(command, args, options) {
      assert.equal(command, process.execPath); assert.deepEqual(args, ["-B", process.execPath]);
      assert.equal(options.windowsHide, true); assert.equal(options.shell, false);
      const child: any = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.request = ""; child.kills = 0;
      child.stdin.on("data", (b: Buffer) => child.request += b.toString());
      child.kill = () => { child.kills++; setImmediate(() => child.emit("close", null)); return true; };
      child.message = (value: object) => child.stdout.write(JSON.stringify({ run_id: id, ...value }) + "\n");
      children.push(child); return child;
    }
  });
  const session = recorder.start(id, context);
  const finishVideo = () => resolveVideo({ output, state: "saved" });
  return { recorder, session, children, video, videoReady, directory, id, resolveReady, rejectReady, finishVideo };
}

test("native capture: video ready waits for exact-run arm; complete requires sample and process exit; durable evidence", async t => {
  const f = fixture(t); let ready = false, done = false;
  void f.session.ready.then(() => ready = true); void f.session.done.then(() => done = true);
  assert.equal(f.children.length, 0); f.resolveReady(f.videoReady); await flush();
  assert.equal(ready, false); const c = f.children[0], request = JSON.parse(c.request);
  assert.equal(request.run_id, f.id); assert.equal(request.target, "17"); assert.equal(request.client_pid, 500);
  assert.equal(request.client_filetime, f.videoReady.gameCreateTimeFileTime);
  c.message({ status: "SCENARIO_CAPTURE_ARMED", client_pid: 500 }); assert.deepEqual(await f.session.ready, f.videoReady);
  c.message({ status: "SLASH_RUN_BOUND", binding: { run_id: f.id, target: "17", player_character_id: "0x123", guid: "0xabc" } });
  const output = path.join(f.directory, "samples-fixture.jsonl");
  c.message({ status: "NATIVE_SAMPLE_READY", output, guid: "0xabc" });
  c.message({ status: "CAPTURE_COMPLETE", exit_code: 0, output });
  assert.equal(f.session.nativeStatus?.().state, "sampling"); c.emit("close", 0);
  assert.equal(f.session.nativeStatus?.().state, "complete");
  assert.equal(done, false); assert.throws(() => f.recorder.start(randomUUID(), context), /not exited/);
  f.session.stop(); f.finishVideo(); const result = await f.session.done;
  assert.equal(result.state, "saved"); assert.equal((result.nativeCapture as any).sampled, true);
  assert.match(fs.readFileSync(path.join(f.directory, "native-capture.jsonl"), "utf8"), /native_capture_finalized/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, "native-capture.json"), "utf8")).processExited, true);
});

test("native capture: stop before video ready never launches child or resurrects", async t => {
  const f = fixture(t); f.session.stop(); f.resolveReady(f.videoReady); f.finishVideo();
  await assert.rejects(f.session.ready, /cancelled/); assert.equal((await f.session.done).state, "failed");
  assert.equal(f.children.length, 0);
});

test("native capture: absent recorder process lifetime rejects before child; no false ready", async t => {
  const f = fixture(t); f.resolveReady({ output: f.videoReady.output, gamePid: 500 }); await flush(); f.finishVideo();
  await assert.rejects(f.session.ready, /creation_identity_missing/);
  assert.equal((await f.session.done).state, "failed"); assert.equal(f.children.length, 0);
});

test("native capture: worker setup failure retained in durable manifest", async t => {
  const f = fixture(t, { worker: path.join(os.tmpdir(), "missing-native-worker-" + randomUUID()) });
  f.resolveReady(f.videoReady); await flush(); f.finishVideo();
  await assert.rejects(f.session.ready); assert.equal((await f.session.done).state, "failed");
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, "native-capture.json"), "utf8")).state, "failed");
});

for (const bad of ["wrong_run", "wrong_pid", "unknown_event", "complete_without_sample", "pipe_error", "malformed", "limit", "unexpected_exit"]) {
  test("native capture fails closed: " + bad, async t => {
    const f = fixture(t); f.resolveReady(f.videoReady); await flush(); const c = f.children[0];
    if (bad === "wrong_run") c.message({ status: "SCENARIO_CAPTURE_ARMED", client_pid: 500, run_id: randomUUID() });
    if (bad === "wrong_pid") c.message({ status: "SCENARIO_CAPTURE_ARMED", client_pid: 501 });
    if (bad === "unknown_event") c.message({ status: "unknown" });
    if (bad === "complete_without_sample") c.message({ status: "CAPTURE_COMPLETE", exit_code: 0 });
    if (bad === "pipe_error") c.stdout.emit("error", Error("fixture"));
    if (bad === "malformed") c.stdout.write("not json\n");
    if (bad === "limit") c.stdout.write("x".repeat(65537));
    c.emit("close", bad === "unexpected_exit" ? 0 : 1); f.finishVideo();
    await assert.rejects(f.session.ready); assert.equal((await f.session.done).state, "failed");
    assert.ok(f.video.stops > 0);
  });
}

test("native capture: startup watchdog cancels owned worker and never permits positioning", async t => {
  const keepAlive = setTimeout(() => {}, 2000); t.after(() => clearTimeout(keepAlive));
  const f = fixture(t, { startupMs: 10, stopMs: 10 }); f.resolveReady(f.videoReady); await flush();
  await assert.rejects(f.session.ready, /arm_timeout/); f.finishVideo();
  assert.equal((await f.session.done).state, "failed"); assert.equal(f.children[0].kills, 1);
});

test("native capture: recorder failure before ready settles without orphan process", async t => {
  const f = fixture(t); f.rejectReady(Error("recording failed")); await flush(); f.finishVideo();
  await assert.rejects(f.session.ready, /video_ready_failed/); assert.equal((await f.session.done).state, "failed");
  assert.equal(f.children.length, 0);
});
