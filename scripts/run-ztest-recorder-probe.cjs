#!/usr/bin/env node
"use strict";

// Small Windows-only bridge for the prebuilt recorder.  The recorder requires
// a live parent stdin so it can receive its JSON stop command; invoking the
// .exe directly from a shell closes that pipe before capture begins.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const [, , runId, outputPath, durationArg] = process.argv;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const durationMs = Number(durationArg ?? 8000);

if (!uuidPattern.test(runId ?? "")) {
  throw new Error("usage: node scripts/run-ztest-recorder-probe.cjs <UUID> <absolute .mp4> [durationMs]");
}
if (!path.isAbsolute(outputPath ?? "") || !outputPath.toLowerCase().endsWith(".mp4")) {
  throw new Error("output path must be an absolute .mp4 path");
}
if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 100000) {
  throw new Error("durationMs must be an integer from 1000 through 100000");
}
if (fs.existsSync(outputPath)) {
  throw new Error(`output already exists: ${outputPath}`);
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const recorderPath = path.resolve(
  __dirname,
  "../tools/ztest-recorder/publish/ZTestRecorder.exe"
);
const recorder = spawn(
  recorderPath,
  ["--run", runId, "--output", outputPath],
  { stdio: ["pipe", "inherit", "inherit"], windowsHide: true }
);

const stopTimer = setTimeout(() => {
  if (!recorder.stdin.destroyed) {
    recorder.stdin.end('{"action":"stop"}\n');
  }
}, durationMs);

recorder.once("error", (error) => {
  clearTimeout(stopTimer);
  throw error;
});
recorder.once("exit", (code, signal) => {
  clearTimeout(stopTimer);
  if (code !== 0) {
    process.exitCode = 1;
    console.error(`recorder exited with code=${code} signal=${signal ?? "none"}`);
    return;
  }
  console.log(`recording: ${outputPath}`);
});
