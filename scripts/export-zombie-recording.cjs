#!/usr/bin/env node
"use strict";

// Offline companion for a user-recorded video. No game, service or network access.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const MAX_LOG_BYTES = 32 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SELECTOR = /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const DEFAULT_OUT = path.resolve(__dirname, "../tools/task-01a06a01/recordings");
const SCOPE = "Server log events only: no video copied or inspected; no animation, contact, damage or visual PASS inferred.";

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i] === "--log" ? "log" : argv[i] === "--run" ? "run" : argv[i] === "--out" ? "out" : null;
    const value = argv[i + 1];
    if (!key || Object.hasOwn(result, key) || !value || value.startsWith("--")) {
      throw Error("Use --log <file> [--run <UUID|8-character-prefix>] [--out <parent-directory>]");
    }
    result[key] = value;
  }
  if (!result.log) throw Error("--log <explicit log file> is required");
  if (result.run && !SELECTOR.test(result.run)) throw Error("--run must be a UUID or exactly eight hexadecimal characters");
  return result;
}

function selectRun(text, selector) {
  if (selector !== undefined && (typeof selector !== "string" || !SELECTOR.test(selector))) {
    throw Error("--run must be a UUID or exactly eight hexadecimal characters");
  }
  const finalPartialLineIgnored = text.length > 0 && !text.endsWith("\n");
  const complete = finalPartialLineIgnored ? text.slice(0, text.lastIndexOf("\n") + 1) : text;
  const runs = new Map();
  let malformedZtestLines = 0;
  for (const [index, line] of complete.split(/\r?\n/).entries()) {
    if (!line.startsWith("[ztest] ")) continue;
    let event;
    try { event = JSON.parse(line.slice(8)); } catch { malformedZtestLines++; continue; }
    if (!event || Array.isArray(event) || typeof event !== "object" || typeof event.id !== "string" ||
      !UUID.test(event.id) || typeof event.event !== "string" || !event.event ||
      typeof event.utc !== "string" || !Number.isFinite(Date.parse(event.utc))) {
      malformedZtestLines++; continue;
    }
    const id = event.id.toLowerCase();
    const run = runs.get(id) ?? { id, events: [], lines: [], start: null, startLine: null };
    runs.set(id, run);
    run.events.push(event); run.lines.push(index + 1);
    // Start order is source-log order, not last activity or an old cleanup retry.
    if (event.event === "position_instruction" && run.start === null) {
      run.start = event; run.startLine = index + 1;
    }
  }
  let selected;
  if (selector !== undefined) {
    const matches = [...runs.values()].filter(r => r.id.startsWith(selector.toLowerCase()));
    if (matches.length > 1) throw Error("Ambiguous run prefix; supply the full UUID");
    selected = matches[0];
  } else {
    selected = [...runs.values()].filter(r => r.start !== null).sort((a, b) => b.startLine - a.startLine)[0];
  }
  if (!selected) throw Error(selector ? "No matching complete-line ztest run found" : "No ztest run with a complete position_instruction start event found");
  return { selected, malformedZtestLines, finalPartialLineIgnored };
}

function readSnapshot(file) {
  if (!fs.statSync(file).isFile()) throw Error("--log must identify a regular file");
  const fd = fs.openSync(file, "r");
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > MAX_LOG_BYTES) throw Error("Log exceeds the 32 MiB regular-file limit");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (n === 0) throw Error("Log was truncated during the bounded read; retry with a stable log");
      offset += n;
    }
    const after = fs.fstatSync(fd);
    if (after.size > MAX_LOG_BYTES) throw Error("Log exceeds the 32 MiB regular-file limit");
    return { bytes, changedDuringRead: before.size !== after.size || before.mtimeMs !== after.mtimeMs };
  } finally { fs.closeSync(fd); }
}

function exportRecording({ log, run, out = DEFAULT_OUT }) {
  if (typeof log !== "string" || !log) throw Error("--log <explicit log file> is required");
  if (typeof out !== "string" || !out) throw Error("--out must be a parent directory");
  const sourcePath = path.resolve(log);
  const { bytes, changedDuringRead } = readSnapshot(sourcePath);
  const parsed = selectRun(bytes.toString("utf8"), run);
  const selected = parsed.selected;
  const terminal = selected.events.findLast(e => e.event === "closed" || e.event === "cleanup_retry") ?? null;
  const warnings = [SCOPE];
  if (parsed.finalPartialLineIgnored) warnings.push("The final unterminated line was ignored, even if it was valid JSON.");
  if (parsed.malformedZtestLines) warnings.push(`${parsed.malformedZtestLines} malformed ztest lines were ignored across the source snapshot.`);
  if (changedDuringRead) warnings.push("The source changed during reading; the hash covers only the bounded bytes read, not an atomic file snapshot.");
  if (!selected.start) warnings.push("Start event missing; this explicitly selected run may be only a partial log.");
  if (!terminal) warnings.push("Terminal event missing: incomplete in this snapshot, not proof the test is still active or passed.");
  const errors = selected.events.filter(e => e.event === "error");
  const eventCounts = new Map();
  for (const event of selected.events) eventCounts.set(event.event, (eventCounts.get(event.event) ?? 0) + 1);
  const terminalProblem = terminal && (terminal.state === "cleanup_failed" || terminal.cleanupError ||
    (Array.isArray(terminal.cleanupErrors) && terminal.cleanupErrors.length));
  if (errors.length || terminalProblem || (terminal && terminal.reason !== "completed_observation_window")) {
    warnings.push("This run contains an error, cleanup problem or non-completion termination; do not label it PASS.");
  }
  const summary = {
    schema: "zombie-recording-server-log-v1", scope: SCOPE, runId: selected.id,
    selection: run === undefined ? "latest_position_instruction_in_source_order" : "explicit_UUID_or_prefix",
    source: { path: sourcePath, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytesRead: bytes.length, maxBytes: MAX_LOG_BYTES, changedDuringRead },
    exportedAtUtc: new Date().toISOString(),
    firstEventUtc: selected.events[0].utc, lastEventUtc: selected.events.at(-1).utc,
    startedAtUtc: selected.start?.utc ?? null,
    runningAtUtc: selected.events.find(e => e.event === "running")?.utc ?? null,
    terminalAtUtc: terminal?.utc ?? null,
    startMissing: selected.start === null, terminalMissing: terminal === null,
    logCompleteness: terminal ? "terminal_event_present" : "incomplete_terminal_missing",
    terminal, errorEvents: errors,
    acceptance: "not_assessed_server_logs_cannot_establish_visual_pass",
    eventCount: selected.events.length,
    eventCounts: Object.fromEntries(eventCounts),
    sourceLines: selected.lines,
    malformedZtestLines: parsed.malformedZtestLines,
    finalPartialLineIgnored: parsed.finalPartialLineIgnored, warnings
  };
  const parent = path.resolve(out);
  fs.mkdirSync(parent, { recursive: true });
  const directory = path.join(parent, `ztest-${selected.id}-${crypto.randomUUID()}`);
  fs.mkdirSync(directory); // Exclusive: existing directory is an error, never reused.
  try {
    fs.writeFileSync(path.join(directory, "events.jsonl"), selected.events.map(e => JSON.stringify(e)).join("\n") + "\n", { flag: "wx" });
    fs.writeFileSync(path.join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
  } catch (error) {
    throw Error(`Export failed; partial directory retained without deletion: ${directory}. ${error.message}`);
  }
  return { directory, summaryPath: path.join(directory, "summary.json"), eventsPath: path.join(directory, "events.jsonl"), summary };
}

module.exports = { MAX_LOG_BYTES, DEFAULT_OUT, parseArgs, selectRun, exportRecording };
if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log("node scripts/export-zombie-recording.cjs --log <file> [--run <UUID|8-character-prefix>] [--out <parent-directory>]\nOffline only; writes an exclusive new directory. No video copied/uploaded and no visual PASS inferred.");
    else {
      const result = exportRecording(options);
      console.log(JSON.stringify({ directory: result.directory, runId: result.summary.runId, startedAtUtc: result.summary.startedAtUtc,
        terminalMissing: result.summary.terminalMissing, terminalReason: result.summary.terminal?.reason ?? null,
        warnings: result.summary.warnings }, null, 2));
    }
  } catch (error) { console.error(`Export failed: ${error.message}`); process.exitCode = 1; }
}
