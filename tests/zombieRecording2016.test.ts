import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LocalZombieRecorder } from "../src/servers/ZoneServer2016/test-zombie-recording";

function fixture(t: { after: (fn: () => void) => void }, settings: { startupMs?: number; finalizeMs?: number } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "h1z1-recorder-test-"));
  t.after(() => {
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(resolved), /^h1z1-recorder-test-/);
    assert.ok(!fs.lstatSync(directory).isSymbolicLink());
    fs.rmSync(resolved, { recursive: true });
  });
  const children: any[] = [];
  const recorder = new LocalZombieRecorder({ executable: process.execPath, outputRoot: directory,
    startupMs: settings.startupMs ?? 500, finalizeMs: settings.finalizeMs ?? 100,
    lifetimeMs: 2000,
    spawn(command, args, options) {
      assert.equal(command, process.execPath);
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      const child: any = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.run = args[1]; child.output = args[3]; child.stopData = ""; child.kills = 0;
      child.stdin.on("data", (data: Buffer) => { child.stopData += data.toString(); });
      child.kill = () => { child.kills++; setImmediate(() => child.emit("close", null)); return true; };
      child.message = (event: object) => child.stdout.write(JSON.stringify({ run: child.run, output: child.output, ...event }) + "\n");
      child.ready = () => child.message({ event: "ready", gamePid: 123 });
      child.save = () => {
        // Protocol fixture only, intentionally not an encoded-video verification.
        fs.writeFileSync(child.output, Buffer.alloc(64), { flag: "wx" });
        child.message({ event: "saved", frames: 20 });
        child.emit("close", 0);
      };
      children.push(child);
      return child;
    }
  });
  return { recorder, children, directory };
}

test("recording: saved requires ready, final file and child exit; evidence has matching UUID", async t => {
  const f = fixture(t), id = randomUUID(), session = f.recorder.start(id), child = f.children[0];
  let resolved = false; void session.ready.then(() => { resolved = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(resolved, false);
  child.ready(); assert.deepEqual(await session.ready, { output: child.output, gamePid: 123 });
  session.record?.({ id, event: "server_sample" }); session.stop(); session.stop();
  assert.equal(child.stopData, '{"action":"stop"}\n');
  child.save(); assert.equal((await session.done).state, "saved");
  assert.match(fs.readFileSync(path.join(f.directory, id, "events.jsonl"), "utf8"), /server_sample/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, id, "recording.json"), "utf8")).state, "saved");
});

test("recording: duplicate UUID and overlapping run never overwrite or spawn", async t => {
  const f = fixture(t), id = randomUUID(), session = f.recorder.start(id), child = f.children[0];
  assert.throws(() => f.recorder.start(randomUUID()), /not exited/);
  child.ready(); await session.ready; session.stop(); child.save(); await session.done;
  assert.throws(() => f.recorder.start(id), /EEXIST/); assert.equal(f.children.length, 1);
});

test("recording: malformed UUID cannot create output paths", t => {
  const f = fixture(t);
  for (const id of ["../escape", "123", "C:\\video", ""]) assert.throws(() => f.recorder.start(id), /UUID/);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test("recording: helper error before first frame rejects readiness and finalizes failure", async t => {
  const f = fixture(t), session = f.recorder.start(randomUUID()), child = f.children[0];
  child.message({ event: "error", message: "game_not_running" }); child.emit("close", 1);
  await assert.rejects(session.ready, /game_not_running/);
  assert.equal((await session.done).error, "game_not_running"); assert.ok(child.stopData.includes("stop"));
});

test("recording: stop during startup cannot be resurrected by late ready", async t => {
  const f = fixture(t), session = f.recorder.start(randomUUID()), child = f.children[0];
  session.stop(); child.ready(); child.emit("close", 0);
  await assert.rejects(session.ready, /before first/); assert.equal((await session.done).state, "failed");
});

test("recording: mismatched helper run identity fails closed", async t => {
  const f = fixture(t), session = f.recorder.start(randomUUID()), child = f.children[0];
  child.message({ event: "ready", gamePid: 123, run: randomUUID() }); child.emit("close", 1);
  await assert.rejects(session.ready, /identity_mismatch/); assert.equal((await session.done).state, "failed");
});

test("recording: saved without first frame or without file is not a successful recording", async t => {
  const f = fixture(t), session = f.recorder.start(randomUUID()), child = f.children[0];
  child.message({ event: "saved", frames: 1 }); child.emit("close", 0);
  await assert.rejects(session.ready, /invalid_saved/); assert.equal((await session.done).state, "failed");
  const next = f.recorder.start(randomUUID()), second = f.children[1];
  second.ready(); await next.ready; second.message({ event: "saved", frames: 1 }); second.emit("close", 0);
  assert.equal((await next.done).error, "recording_file_missing_or_empty");
});

test("recording: first frame timeout sends stop and reports failure", async t => {
  const f = fixture(t, { startupMs: 10 }), session = f.recorder.start(randomUUID()), child = f.children[0];
  const hold = setTimeout(() => {}, 1000); t.after(() => clearTimeout(hold));
  await assert.rejects(session.ready, /first_frame_timeout/);
  assert.ok(child.stopData.includes("stop")); child.emit("close", 0);
  assert.equal((await session.done).error, "recorder_first_frame_timeout");
});

test("recording: hung finalization kills only owned child, and is never marked saved", async t => {
  const f = fixture(t, { finalizeMs: 10 }), session = f.recorder.start(randomUUID()), child = f.children[0];
  const hold = setTimeout(() => {}, 1000); t.after(() => clearTimeout(hold));
  child.ready(); await session.ready; session.stop();
  assert.equal((await session.done).error, "recorder_finalize_timeout"); assert.equal(child.kills, 1);
});

test("recording: malformed or excessive protocol output stops recording", async t => {
  const f = fixture(t), session = f.recorder.start(randomUUID()), child = f.children[0];
  child.stdout.write("x".repeat(65537)); child.emit("close", 1);
  await assert.rejects(session.ready, /protocol_limit/); assert.equal((await session.done).state, "failed");
});

test("recording: unexpected successful child exit without saved event is failure", async t => {
  const f = fixture(t), session = f.recorder.start(randomUUID()), child = f.children[0];
  child.ready(); await session.ready; child.emit("close", 0);
  assert.equal((await session.done).error, "recorder_exited_without_saved_file");
});

for (const stream of ["stdin", "stdout", "stderr"]) {
  test(`recording: ${stream} errors stop and fail without uncaught stream errors`, async t => {
    const f = fixture(t), session = f.recorder.start(randomUUID()), child = f.children[0];
    child[stream].emit("error", Error("synthetic pipe failure")); child.emit("close", 1);
    await assert.rejects(session.ready, new RegExp("recorder_" + stream + "_failed"));
    assert.equal((await session.done).state, "failed"); assert.ok(child.stopData.includes("stop"));
    child[stream].emit("error", Error("late error must remain handled"));
  });
}

test("recording: ready must bind the exact output path", async t => {
  const f = fixture(t), session = f.recorder.start(randomUUID()), child = f.children[0];
  child.message({ event: "ready", gamePid: 123, output: undefined }); child.emit("close", 1);
  await assert.rejects(session.ready, /invalid_ready/); assert.equal((await session.done).state, "failed");
});
