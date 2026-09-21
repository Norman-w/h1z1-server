#!/usr/bin/env node
"use strict";

// Native Windows evidence runner for the current DevHttpServerLite NPC
// harness.  It deliberately records the game window and the server's status
// stream together; an MP4 without the authoritative state timeline cannot
// distinguish a client animation issue from a server state/position issue.
//
// Usage from Git Bash:
//   node scripts/run-animal-test-capture.cjs zombie 30000
//   node scripts/run-animal-test-capture.cjs deer 30000 C:/tmp/deer.mp4
//   node scripts/run-animal-test-capture.cjs bear 30000 C:/tmp/bear.mp4 300000
//
// The runner waits for exactly one alive client, so it is safe to start before
// entering the world.  It never searches for or kills an unrelated process;
// only the recorder child it owns receives the stop command.

const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const [
  ,
  ,
  type = "bear",
  durationArg = "30000",
  outputArg,
  clientWaitArg
] = process.argv;
// `/api/animal-test` is the shared deterministic NPC harness despite its
// historical name. Keep the capture runner in lock-step with the complete
// production recipe so every NPC graph (including prototype and inert
// fallback actors) can be checked with the same video/timeline contract.
const npcTypes = new Set([
  "zombie",
  "zombie_female",
  "screamer",
  "gasser",
  "exploder",
  "prototype_assault",
  "prototype_hunter",
  "prototype_sniper",
  "bear",
  "wolf",
  "deer",
  "deer_buck",
  "rabbit",
  "basic"
]);
const durationMs = Number(durationArg);
const distance = Number(process.env.ANIMAL_TEST_DISTANCE ?? "8");
const clientWaitMs = Number(
  clientWaitArg ?? process.env.ANIMAL_TEST_CLIENT_WAIT_MS ?? 300000
);
const apiBase = "http://127.0.0.1:13371";
const repo = path.resolve(__dirname, "..");
const recorderPath = path.join(repo, "tools", "ztest-recorder", "publish", "ZTestRecorder.exe");
const runId = randomUUID();
const output = path.resolve(
  outputArg ?? path.join(os.tmpdir(), `h1z1-${type}-${runId}.mp4`)
);
const timeline = `${output.slice(0, -4)}.jsonl`;

if (!npcTypes.has(type)) {
  throw new Error(`NPC type must be one of: ${[...npcTypes].join(", ")}`);
}
if (!Number.isInteger(durationMs) || durationMs < 5000 || durationMs > 90000) {
  throw new Error("durationMs must be an integer from 5000 through 90000");
}
if (!Number.isFinite(distance) || distance < 3 || distance > 40) {
  throw new Error("ANIMAL_TEST_DISTANCE must be a number from 3 through 40");
}
if (!Number.isInteger(clientWaitMs) || clientWaitMs < 5000 || clientWaitMs > 900000) {
  throw new Error("clientWaitMs must be an integer from 5000 through 900000");
}
if (!output.toLowerCase().endsWith(".mp4") || !path.isAbsolute(output)) {
  throw new Error("output must be an absolute .mp4 path");
}
if (fs.existsSync(output) || fs.existsSync(timeline)) {
  throw new Error(`output already exists: ${output} or ${timeline}`);
}
if (!fs.statSync(recorderPath, { throwIfNoEntry: false })?.isFile()) {
  throw new Error(`recorder is missing: ${recorderPath}`);
}
fs.mkdirSync(path.dirname(output), { recursive: true });
const timelineStream = fs.createWriteStream(timeline, { flags: "wx" });

let recorder;
let recorderReady = false;
let recorderSaved = false;
let recorderOutput = output;
let recorderBuffer = "";
let stopping = false;
let stopTimer;
let pollTimer;

function writeTimeline(event, details = {}) {
  timelineStream.write(`${JSON.stringify({
    utc: new Date().toISOString(),
    runId,
    event,
    ...details
  })}\n`);
}

async function fetchJson(pathname, init = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiBase}${pathname}`, {
      ...init,
      signal: controller.signal,
      headers: init.headers
        ? { "content-type": "application/json", ...init.headers }
        : { "content-type": "application/json" }
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (!response.ok) {
      throw new Error(`${response.status} ${JSON.stringify(body)}`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function stopRecorder() {
  if (!recorder || stopping || recorder.exitCode !== null || recorder.signalCode !== null) return;
  stopping = true;
  writeTimeline("recording_stop_requested");
  try { recorder.stdin.end('{"action":"stop"}\n'); }
  catch (error) { writeTimeline("recording_stop_pipe_error", { message: String(error) }); }
  stopTimer = setTimeout(() => {
    if (!recorderSaved) {
      writeTimeline("recording_stop_timeout");
      try { recorder.kill(); } catch { /* Keep final exit as the authority. */ }
    }
  }, 12000);
  stopTimer.unref?.();
}

function stopServerTest() {
  return fetchJson("/api/animal-test", {
    method: "POST",
    body: JSON.stringify({ command: "stop" })
  }).catch(error => {
    writeTimeline("server_stop_error", { message: error.message });
    return null;
  });
}

async function waitForPlayableClient() {
  const deadline = Date.now() + clientWaitMs;
  let lastWaitingReportAt = Date.now();
  let lastSnapshot = { ready: null, clientCount: null };
  console.log(JSON.stringify({ event: "waiting_for_client", message: "Enter the game world; recording starts automatically when the client is ready." }));
  while (Date.now() < deadline) {
    try {
      const clients = await fetchJson("/api/clients", {}, 3000);
      lastSnapshot = {
        ready: clients.ready === true,
        clientCount: Array.isArray(clients.clients) ? clients.clients.length : null
      };
      if (clients.ready === true && Array.isArray(clients.clients) && clients.clients.length === 1) {
        const client = clients.clients[0];
        if (client.isAlive === true && client.isLoading === false && client.isSynced === true) {
          writeTimeline("client_ready", { client });
          console.log(JSON.stringify({ event: "client_ready", characterId: client.characterId }));
          return client;
        }
      }
    } catch (error) {
      lastSnapshot = { ready: false, clientCount: null, error: error.message };
      writeTimeline("client_poll_error", { message: error.message });
    }
    const now = Date.now();
    // Keep a long wait observable without flooding stdout or the JSONL file.
    // This is especially useful when the client is sitting at the menu or an
    // RDP session has not yet entered the world: the process is alive, not
    // hung, and the latest server-side observation is explicit.
    if (now - lastWaitingReportAt >= 10000) {
      const remainingMs = Math.max(0, deadline - now);
      const waiting = {
        event: "waiting_for_client",
        elapsedMs: clientWaitMs - remainingMs,
        remainingMs,
        ...lastSnapshot
      };
      console.log(JSON.stringify(waiting));
      writeTimeline("waiting_for_client", waiting);
      lastWaitingReportAt = now;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("timed out waiting for one alive, synced client; enter the world first");
}

async function pollStatus() {
  try {
    const status = await fetchJson("/api/npcs", {}, 3000);
    writeTimeline("npc_status", status);
  } catch (error) {
    writeTimeline("npc_status_error", { message: error.message });
  }
}

async function main() {
  // ZTestRecorder intentionally caps a single capture at roughly 100 s.  Do
  // not start it while waiting for a client: otherwise a player who enters
  // after that cap gets only a startup frame and the outer wait reports a
  // misleading recorder failure.  Poll the server first, then launch the
  // recorder while the playable window is already present.
  const client = await waitForPlayableClient();

  recorder = spawn(recorderPath, ["--run", runId, "--output", output], {
    stdio: ["pipe", "pipe", "inherit"],
    // Windows Graphics Capture needs the recorder process to have a visible
    // desktop identity under RDP; hiding the child can prevent the first
    // source frame from being created even though the game window is alive.
    windowsHide: false,
    shell: false
  });
  writeTimeline("recording_starting", {
    output,
    type,
    durationMs,
    clientWaitMs
  });

  recorder.stdout.setEncoding("utf8");
  recorder.stdout.on("data", chunk => {
    recorderBuffer += chunk;
    let newline;
    while ((newline = recorderBuffer.indexOf("\n")) >= 0) {
      const line = recorderBuffer.slice(0, newline).trim();
      recorderBuffer = recorderBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch (error) {
        writeTimeline("recorder_protocol_error", { message: String(error), line: line.slice(0, 512) });
        continue;
      }
      writeTimeline("recorder_message", message);
      if (message.event === "ready") {
        if (message.run !== runId || message.output !== output || recorderReady) {
          writeTimeline("recorder_invalid_ready", { message });
          return;
        }
        recorderReady = true;
        recorderOutput = message.output;
      } else if (message.event === "saved") {
        if (message.run !== runId || message.output !== output || !Number.isInteger(message.frames) || message.frames < 1) {
          writeTimeline("recorder_invalid_saved", { message });
          return;
        }
        recorderSaved = true;
      } else if (message.event === "error") {
        writeTimeline("recorder_error", { message });
      }
    }
  });
  recorder.on("error", error => writeTimeline("recorder_process_error", { message: error.message }));
  recorder.on("close", (code, signal) => {
    writeTimeline("recorder_closed", { code, signal });
  });

  const readyDeadline = Date.now() + 15000;
  while (!recorderReady && Date.now() < readyDeadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!recorderReady) throw new Error("recorder did not produce a ready frame");
  console.log(JSON.stringify({ event: "recorder_ready", output }));

  await fetchJson("/api/god", { method: "POST", body: JSON.stringify({ enabled: true }) });
  writeTimeline("god_mode_enabled", { characterId: client.characterId });
  const spawnResult = await fetchJson("/api/animal-test", {
    method: "POST",
    body: JSON.stringify({ command: "flat", type, distance, height: 0 })
  });
  writeTimeline("animal_spawned", { distance, ...spawnResult });
  console.log(JSON.stringify({ event: "started", runId, type, distance, output, timeline, characterId: client.characterId }));

  pollTimer = setInterval(() => { void pollStatus(); }, 250);
  await new Promise(resolve => setTimeout(resolve, durationMs));
  await stopServerTest();
  clearInterval(pollTimer);
  pollTimer = undefined;
  stopRecorder();
  while (!recorderSaved && recorder.exitCode === null && recorder.signalCode === null) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  writeTimeline("complete", { recorderSaved, output: recorderOutput });
}

main().catch(async error => {
  writeTimeline("failed", { message: error instanceof Error ? error.message : String(error) });
  if (pollTimer) clearInterval(pollTimer);
  await stopServerTest();
  stopRecorder();
  process.exitCode = 1;
}).finally(() => {
  clearTimeout(stopTimer);
  timelineStream.end();
});
