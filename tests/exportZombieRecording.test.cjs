"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const cli = path.resolve(__dirname, "../scripts/export-zombie-recording.cjs");
const { MAX_LOG_BYTES, DEFAULT_OUT, parseArgs, selectRun, exportRecording } = require(cli);
const A = "aaaaaaaa-1111-2222-3333-444444444444";
const B = "bbbbbbbb-1111-2222-3333-444444444444";
const A2 = "aaaaaaaa-9999-2222-3333-444444444444";
const event = (id, name, details = {}) => ({ utc: "2026-09-10T01:00:00.000Z", id, event: name, ...details });
const line = e => `[ztest] ${JSON.stringify(e)}\n`;
const start = id => line(event(id, "position_instruction", { destination: [1, 2, 3, 1] }));
const close = (id, details = {}) => line(event(id, "closed", { state: "stopped", reason: "completed_observation_window", cleanupError: null, cleanupErrors: [], ...details }));
function fixture(t, text = start(A) + close(A)) {
  const tempRoot = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempRoot, "zombie-recording-test-"));
  t.after(() => {
    const target = path.resolve(dir), relative = path.relative(tempRoot, target);
    assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    assert.equal(path.dirname(target), tempRoot);
    assert(path.basename(target).startsWith("zombie-recording-test-"));
    const stat = fs.lstatSync(target);
    assert(stat.isDirectory() && !stat.isSymbolicLink());
    fs.rmSync(target, { recursive: true, force: true });
  });
  const log = path.join(dir, "source log.txt"), out = path.join(dir, "exports");
  fs.writeFileSync(log, text);
  return { dir, log, out };
}

test("CLI arguments require explicit log and strict selectors; default is repo-local", () => {
  assert.throws(() => parseArgs([]), /--log/);
  for (const args of [["--wat", "x"], ["--log"], ["--log", "--out"], ["--log", "x", "--log", "y"], ["--log", "x", "--run", "aaaaaaaa-1"], ["--log", "x", "toString", "y"]]) {
    assert.throws(() => parseArgs(args));
  }
  assert.deepEqual(parseArgs(["--log", "a b", "--run", "AAAAAAAA", "--out", "c d"]), { log: "a b", run: "AAAAAAAA", out: "c d" });
  assert.deepEqual(parseArgs(["--help"]), { help: true });
  assert.equal(DEFAULT_OUT, path.resolve(__dirname, "../tools/task-01a06a01/recordings"));
});

test("complete run exports only ztest JSON with original-source SHA and UTC", t => {
  const text = "unrelated normal log\n" + start(A) + line(event(A, "running", { utc: "2026-09-10T01:00:01.000Z", npc: "0x1" })) + close(A);
  const f = fixture(t, text), r = exportRecording(f);
  assert.equal(r.summary.runId, A);
  assert.equal(r.summary.source.sha256, crypto.createHash("sha256").update(text).digest("hex"));
  assert.equal(r.summary.source.bytesRead, Buffer.byteLength(text));
  assert.equal(r.summary.startedAtUtc, "2026-09-10T01:00:00.000Z");
  assert.equal(r.summary.runningAtUtc, "2026-09-10T01:00:01.000Z");
  assert.equal(r.summary.terminalMissing, false);
  assert.equal(r.summary.acceptance, "not_assessed_server_logs_cannot_establish_visual_pass");
  assert.equal(r.summary.eventCount, 3);
  const events = fs.readFileSync(r.eventsPath, "utf8").trimEnd().split("\n").map(JSON.parse);
  assert.deepEqual(events.map(e => e.event), ["position_instruction", "running", "closed"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(r.summaryPath, "utf8")), r.summary);
  assert.deepEqual(fs.readdirSync(r.directory).sort(), ["events.jsonl", "summary.json"]);
  assert.equal(fs.readFileSync(f.log, "utf8"), text);
});

test("latest start wins over old trailing cleanup, even with backward UTC", t => {
  const text = start(A) + close(A) + line(event(B, "position_instruction", { utc: "2026-09-09T23:59:00.000Z" })) +
    line(event(A, "cleanup_retry", { reason: "completed_observation_window", state: "stopped" }));
  const f = fixture(t, text), r = exportRecording(f);
  assert.equal(r.summary.runId, B);
  assert.equal(r.summary.eventCount, 1);
  assert.equal(r.summary.terminalMissing, true);
  assert.equal(r.summary.logCompleteness, "incomplete_terminal_missing");
  assert(r.summary.warnings.some(w => /not proof.*still active or passed/.test(w)));
});

test("explicit older run UUID and eight-character prefix are case insensitive", t => {
  const f = fixture(t, start(A) + close(A) + start(B));
  for (const run of [A.toUpperCase(), A.slice(0, 8).toUpperCase()]) {
    const r = exportRecording({ ...f, run });
    assert.equal(r.summary.runId, A);
    assert.equal(r.summary.terminalMissing, false);
  }
  assert.equal(selectRun(start(A.toUpperCase()), "aaaaaaaa").selected.id, A);
});

test("ambiguous prefix refuses rather than selecting one matching run", t => {
  const f = fixture(t, start(A) + start(A2));
  assert.throws(() => exportRecording({ ...f, run: "aaaaaaaa" }), /Ambiguous/);
  assert(!fs.existsSync(f.out));
  assert.equal(exportRecording({ ...f, run: A }).summary.runId, A);
});

test("valid final JSON without newline is ignored and source hash includes it", t => {
  const text = start(A) + close(A) + start(B).trimEnd();
  const r = exportRecording(fixture(t, text));
  assert.equal(r.summary.runId, A);
  assert.equal(r.summary.finalPartialLineIgnored, true);
  assert.equal(r.summary.source.sha256, crypto.createHash("sha256").update(text).digest("hex"));
  assert(!fs.readFileSync(r.eventsPath, "utf8").includes(B));
});

test("partial terminal never turns an unfinished run into a completed one", t => {
  const r = exportRecording(fixture(t, start(A) + close(A).trimEnd()));
  assert.equal(r.summary.eventCount, 1);
  assert.equal(r.summary.terminal, null);
  assert.equal(r.summary.terminalMissing, true);
});

test("CRLF and malformed ztest JSON are handled without unrelated-line promotion", t => {
  const text = start(A).replace(/\n/g, "\r\n") + "[ztest] {broken}\r\n" +
    "[ztest] null\n[ztest] []\n" + line({ id: A, event: "running", utc: "bad" }) +
    "prefix " + start(B) + JSON.stringify(event(B, "position_instruction")) + "\n" + close(A);
  const r = exportRecording(fixture(t, text));
  assert.equal(r.summary.runId, A);
  assert.equal(r.summary.eventCount, 2);
  assert.equal(r.summary.malformedZtestLines, 4);
});

test("terminal failure and cleanup failure are retained and never reported PASS", t => {
  const text = start(A) + line(event(A, "error", { message: "failed" })) +
    close(A, { reason: "position_not_confirmed", state: "cleanup_failed", cleanupError: "restore_failed", cleanupErrors: ["restore_failed"] });
  const r = exportRecording(fixture(t, text));
  assert.equal(r.summary.terminal.state, "cleanup_failed");
  assert.equal(r.summary.terminal.reason, "position_not_confirmed");
  assert.equal(r.summary.errorEvents.length, 1);
  assert.equal(r.summary.acceptance, "not_assessed_server_logs_cannot_establish_visual_pass");
  assert(r.summary.warnings.some(w => /do not label it PASS/.test(w)));
});

test("explicit run with missing start is a labeled partial log, not a default candidate", t => {
  const f = fixture(t, close(A));
  assert.throws(() => exportRecording(f), /position_instruction/);
  const r = exportRecording({ ...f, run: A });
  assert.equal(r.summary.startMissing, true);
  assert.equal(r.summary.startedAtUtc, null);
  assert(r.summary.warnings.some(w => /Start event missing/.test(w)));
});

test("empty, unrelated, only-partial, and unmatched logs do not create output", t => {
  for (const text of ["", "ordinary log\n", start(A).trimEnd()]) {
    const f = fixture(t, text);
    assert.throws(() => exportRecording(f), /No ztest run/);
    assert(!fs.existsSync(f.out));
  }
  const f = fixture(t);
  assert.throws(() => exportRecording({ ...f, run: B }), /No matching/);
  assert(!fs.existsSync(f.out));
});

test("oversized log is refused before reading contents or creating output", t => {
  const f = fixture(t);
  fs.truncateSync(f.log, MAX_LOG_BYTES + 1);
  assert.throws(() => exportRecording(f), /32 MiB/);
  assert(!fs.existsSync(f.out));
});

test("regular file required; missing log is not guessed", t => {
  const f = fixture(t);
  assert.throws(() => exportRecording({ ...f, log: f.dir }), /regular file/);
  assert.throws(() => exportRecording({ ...f, log: path.join(f.dir, "absent") }));
  assert.throws(() => exportRecording({ out: f.out }), /explicit log/);
  assert(!fs.existsSync(f.out));
});

test("repeated exports create separate exclusive directories and preserve older data", t => {
  const f = fixture(t), a = exportRecording(f);
  const before = fs.readFileSync(a.summaryPath);
  const b = exportRecording(f);
  assert.notEqual(a.directory, b.directory);
  assert.deepEqual(fs.readFileSync(a.summaryPath), before);
  assert.equal(fs.readdirSync(f.out).length, 2);
});

test("directory collision fails closed and cannot overwrite existing artifacts", t => {
  const f = fixture(t);
  const id = "00000000-1111-2222-3333-444444444444";
  t.mock.method(crypto, "randomUUID", () => id);
  const dir = path.join(f.out, `ztest-${A}-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summary.json"), "keep");
  assert.throws(() => exportRecording(f), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(dir, "summary.json"), "utf8"), "keep");
  assert(!fs.existsSync(path.join(dir, "events.jsonl")));
});

test("actual CLI works from another cwd and returns a nonzero failure status", t => {
  const f = fixture(t);
  const help = spawnSync(process.execPath, [cli, "--help"], { cwd: f.dir, encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--log <file>/);
  assert.match(help.stdout, /No video copied\/uploaded/);
  assert(!fs.existsSync(f.out));
  const good = spawnSync(process.execPath, [cli, "--log", f.log, "--out", f.out], { cwd: f.dir, encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(good.status, 0, good.stderr);
  const response = JSON.parse(good.stdout);
  assert.equal(response.runId, A);
  assert(fs.existsSync(path.join(response.directory, "summary.json")));
  const bad = spawnSync(process.execPath, [cli], { cwd: f.dir, encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--log/);
});
