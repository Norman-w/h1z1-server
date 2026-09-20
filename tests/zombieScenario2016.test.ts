import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { recordTestZombiePositionReceipt } from "../src/servers/ZoneServer2016/test-zombie-position-receipt";

// Use the actual pure heading implementation without loading unrelated utils
// dependencies into this isolated coordinator test.
const headingSource = fs.readFileSync("src/utils/utils.ts", "utf8")
  .match(/export function quat2heading\([\s\S]*?\n}/)?.[0];
assert.ok(headingSource, "quat2heading source is present");
const headingModule = { exports: {} as any };
vm.runInNewContext(ts.transpileModule(headingSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS }
}).outputText, { module: headingModule, exports: headingModule.exports });
const scenesModule = { exports: {} as any };
vm.runInNewContext(ts.transpileModule(fs.readFileSync("src/servers/ZoneServer2016/test-zombie-scenes.ts", "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS }
}).outputText, { module: scenesModule, exports: scenesModule.exports });
const baselineFile = ts.createSourceFile("test-zombie-in-front.ts",
  fs.readFileSync("src/servers/ZoneServer2016/test-zombie-in-front.ts", "utf8"), ts.ScriptTarget.Latest, true);
const baselineNode = baselineFile.statements.find(node => ts.isFunctionDeclaration(node) &&
  node.name?.text === "requestTestZombieClockBaseline");
assert.ok(baselineNode);
const baselineModule = { exports: {} as any };
vm.runInNewContext(ts.transpileModule(baselineNode.getText(baselineFile), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS }
}).outputText, { module: baselineModule, exports: baselineModule.exports,
  console: { log() {} }, get Date() { return Date; } });

function setup(t: TestContext, sceneOverrides: Record<string, any> = {}, recorder?: any) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 100000 });
  const module = { exports: {} as any };
  const source = ts.transpileModule(fs.readFileSync("src/servers/ZoneServer2016/test-zombie-scenario.ts", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, console,
    require: (name: string) => name === "./test-zombie-environment" ? {} :
      name === "../../utils/utils" ? headingModule.exports : require(name),
    get Date() { return Date; }, get setInterval() { return setInterval; }, get setTimeout() { return setTimeout; },
    get clearInterval() { return clearInterval; }, get clearTimeout() { return clearTimeout; } });
  let now = 0, entered = 0, restored = 0, loggerFails = false, restoreFails = false;
  const logs: any[] = [], messages: string[] = [], packets: any[] = [], calls: any[] = [];
  const client: any = { sessionId: 1, isLoading: false, isSynced: true, testZombieSpawned: true,
    testZombieMovementVersion: 1, vehicle: {}, isInAir: false,
    testZombieClockDiagnostics: { samples: 10, lastReceivedAt: 99999, lastSequenceTime: 100 },
    character: { characterId: "player", isAlive: true, isRespawning: false,
      state: { position: new Float32Array([5, 10, 5, 1]), rotation: new Float32Array([0, 0, 0, 1]) } } };
  const zone: any = { _soloMode: true, _clients: { 1: client }, _npcs: {}, _lastSpawnedNpcCharacterId: null,
    _protocol: { pack: (name: string, data: any) => { packets.push({ name, data }); return Buffer.alloc(38); } },
    sendRawDataReliable: () => {}, sendChatText: (_: any, text: string) => messages.push(text) };
  let state: any = { state: "idle" };
  const replay: any = { getStatus: () => state, handle: (request: any) => {
    calls.push(request);
    if (request.action === "prepare") {
      const p = client.character.state.position;
      zone._npcs.npc = { state: { position: new Float32Array([p[0], p[1], p[2] + request.distance, 1]),
        rotation: new Float32Array([0, 0, 0, 1]) }, behaviorState: 0 };
      state = { state: "paused", replayId: "r1", target: "1",
        requestId: request.requestId, playerCharacterId: request.expectedPlayerCharacterId,
        distance: request.distance, ...(request.knownObstacle ? { knownObstacle: request.knownObstacle } : {}),
        npcCharacterId: "npc", protectionApplied: true, cleanupError: null };
    }
    if (request.action === "start") state = { ...state, state: "running", startedAt: Date.now() };
    if (request.action === "finish") state = { ...state, state: "finished", protectionApplied: false, cleanupError: null };
    return state;
  } };
  const environment = () => { entered++; return { restore() { restored++; if (restoreFails) throw Error("restore failed"); } }; };
  const scenes = {
    flat: { position: [0, 10, 0, 1], description: "fixture flat" },
    slope: { position: [2, 11, 0, 1], description: "fixture slope" },
    fence: { ...scenesModule.exports.ZOMBIE_TEST_SCENES.fence, position: [...scenesModule.exports.ZOMBIE_TEST_SCENES.fence.position] },
    ...sceneOverrides
  };
  const controller = new module.exports.TestZombieScenario(zone, replay, scenes,
    environment, () => now, (event: any) => { if (loggerFails) throw Error("logger failed"); logs.push(event); }, recorder);
  t.after(() => controller.dispose());
  const tick = (ms: number) => { now += ms; t.mock.timers.tick(ms); };
  const receivePosition = (overrides: Record<string, any> = {}) => {
    const position = [...(packets.at(-1)?.data.position ?? [0, 10, 0, 1])];
    const receipt = { count: (client.testZombiePositionReceipt?.count ?? 0) + 1,
      character: client.character, playerCharacterId: client.character.characterId,
      position, rotation: Array.from(client.character.state.rotation ?? []), flags: 8191,
      sequenceTime: client.testZombieClockDiagnostics.lastSequenceTime + 1,
      receivedAt: Date.now(), movementVersion: packets.at(-1)?.data.unknownByte1, clockAligned: true,
      ...overrides };
    client.testZombiePositionReceipt = receipt;
    client.character.state.position = [...receipt.position];
    client.testZombieMovementVersion = receipt.movementVersion;
    client.testZombieClockDiagnostics = { samples: client.testZombieClockDiagnostics.samples + 1,
      lastReceivedAt: receipt.receivedAt, lastSequenceTime: receipt.sequenceTime };
  };
  const confirmPosition = () => { receivePosition(); tick(100); };
  const start = () => { controller.handle(client, ["flat"]); confirmPosition(); tick(100); tick(100); };
  return { controller, zone, client, replay, scenes, logs, messages, packets, calls, tick, confirmPosition, receivePosition, start,
    get entered() { return entered; }, get restored() { return restored; }, setState: (s: any) => { state = s; },
    failLogger: () => { loggerFails = true; }, failRestore: () => { restoreFails = true; }, setNow: (value: number) => { now = value; } };
}

function fakeRecorder() {
  const sessions: any[] = [];
  const recorder = { start(id: string) {
    let readyResolve!: (value: any) => void, readyReject!: (error: Error) => void;
    let doneResolve!: (value: any) => void, doneReject!: (error: Error) => void;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
    const session = { id, ready, done, stops: 0, events: [] as any[],
      stop() { session.stops++; }, record(event: any) { session.events.push(event); },
      resolveReady: () => readyResolve({ output: `recordings/${id}/game.mp4`, gamePid: 123 }),
      rejectReady: () => readyReject(Error("capture unavailable")),
      finish: (state = "saved") => doneResolve({ output: `recordings/${id}/game.mp4`, state,
        ...(state === "failed" ? { error: "encoder failed" } : {}) }),
      rejectDone: () => doneReject(Error("contract violation")) };
    sessions.push(session); return session;
  } };
  return { recorder, sessions, get current() { return sessions.at(-1); } };
}

async function flushRecording() { await Promise.resolve(); await Promise.resolve(); }

test("recording reserves the run before ready, then takes fresh position baselines and a full positioning budget", async t => {
  const r = fakeRecorder(), s = setup(t, {}, r.recorder);
  s.controller.handle(s.client, ["flat"]);
  const id = s.controller.status().id;
  assert.equal(s.controller.status().state, "recording"); assert.equal(s.controller.isActive(), true);
  s.controller.handle(s.client, ["flat"]); s.controller.handle(s.client, ["status"]);
  assert.equal(r.sessions.length, 1); assert.equal(s.entered, 0); assert.equal(s.packets.length, 0); assert.equal(s.calls.length, 0);
  s.tick(11000);
  s.client.testZombieMovementVersion = 7;
  s.client.testZombieClockDiagnostics.lastSequenceTime = 500;
  s.client.testZombiePositionReceipt = { count: 4, sequenceTime: 450, clockAligned: true,
    character: s.client.character, playerCharacterId: "player" };
  r.current.resolveReady(); await flushRecording();
  assert.equal(s.controller.status().id, id); assert.equal(s.controller.status().state, "positioning");
  assert.equal(s.controller.status().elapsedMs, 0); assert.equal(s.entered, 1); assert.equal(s.packets.length, 1);
  assert.equal(s.packets[0].data.unknownByte1, 8); assert.equal(s.client.testZombieMovementVersion, 7);
  const instruction = s.logs.find(e => e.event === "position_instruction");
  assert.equal(instruction.receiptsBefore, 4); assert.equal(instruction.sequenceBefore, 450);
  assert.equal(instruction.diagnosticSequenceBefore, 500);
  assert.ok(s.logs.findIndex(e => e.event === "recording_ready") < s.logs.indexOf(instruction));
  s.tick(14900); assert.equal(s.controller.status().state, "positioning");
  s.confirmPosition(); s.tick(100); s.tick(100);
  assert.equal(s.controller.status().state, "running");
  for (let i = 0; i < 450; i++) s.tick(100);
  assert.equal(s.controller.status().reason, "completed_observation_window");
  assert.equal(r.current.stops, 1); assert.equal(s.restored, 1); assert.equal(s.controller.isActive(), true);
  assert.equal(s.controller.status().recording, "finalizing");
  s.controller.handle(s.client, ["flat"]); assert.equal(r.sessions.length, 1);
  r.current.finish(); await flushRecording();
  assert.equal(s.controller.isActive(), false); assert.equal(s.controller.status().recording, "saved");
  assert.ok(s.messages.at(-1)?.includes("Recording is evidence, not a PASS"));
  assert.ok(r.current.events.some((e: any) => e.event === "closed" && e.id === id));
  assert.ok(r.current.events.some((e: any) => e.event === "recording_saved" && e.id === id));
  s.controller.dispose(); assert.equal(r.current.stops, 1);
});

for (const changed of ["session", "client", "character", "characterId", "multi", "remote", "dead", "respawning", "loading", "sync", "spawn", "mounted", "version", "clock", "receipt", "replay", "time"]) {
  test(`recording ready rechecks ${changed} before any environment or positioning mutation`, async t => {
    const r = fakeRecorder(), s = setup(t, {}, r.recorder);
    s.controller.handle(s.client, ["flat"]);
    if (changed === "session") s.client.sessionId = 2;
    if (changed === "client") s.zone._clients[1] = {};
    if (changed === "character") s.client.character = { ...s.client.character };
    if (changed === "characterId") s.client.character.characterId = "replacement";
    if (changed === "multi") s.zone._clients[2] = {};
    if (changed === "remote") s.zone._soloMode = false;
    if (changed === "dead") s.client.character.isAlive = false;
    if (changed === "respawning") s.client.character.isRespawning = true;
    if (changed === "loading") s.client.isLoading = true;
    if (changed === "sync") s.client.isSynced = false;
    if (changed === "spawn") s.client.testZombieSpawned = false;
    if (changed === "mounted") s.client.vehicle.mountedVehicle = "vehicle";
    if (changed === "version") s.client.testZombieMovementVersion = 256;
    if (changed === "clock") s.client.testZombieClockDiagnostics.lastSequenceTime = NaN;
    if (changed === "receipt") s.client.testZombiePositionReceipt = { count: 0 };
    if (changed === "replay") s.setState({ state: "running", replayId: "foreign" });
    if (changed === "time") s.setNow(-1);
    r.current.resolveReady(); await flushRecording();
    assert.equal(s.controller.status().reason, "recording_setup_failed");
    assert.equal(s.entered, 0); assert.equal(s.packets.length, 0); assert.equal(s.calls.length, 0);
    assert.equal(r.current.stops, 1); r.current.finish("failed"); await flushRecording();
  });
}

for (const ending of ["stop", "dispose", "timeout", "rejection", "disconnect"]) {
  test(`recording startup ${ending} stops once and late ready never resurrects the run`, async t => {
    const r = fakeRecorder(), s = setup(t, {}, r.recorder);
    s.controller.handle(s.client, ["flat"]);
    if (ending === "stop") s.controller.handle(s.client, ["stop"]);
    if (ending === "dispose") s.controller.dispose();
    if (ending === "timeout") s.tick(12000);
    if (ending === "rejection") { r.current.rejectReady(); await flushRecording(); }
    if (ending === "disconnect") { s.zone._clients[1] = {}; s.tick(100); }
    assert.equal(r.current.stops, 1); assert.equal(s.controller.isActive(), true);
    r.current.resolveReady(); await flushRecording();
    assert.equal(s.entered, 0); assert.equal(s.packets.length, 0); assert.equal(s.calls.length, 0);
    r.current.finish("failed"); await flushRecording();
    assert.equal(s.controller.isActive(), false); assert.equal(s.controller.status().recording, "failed");
    s.controller.dispose(); assert.equal(r.current.stops, 1);
  });
}

test("a recorder throwing before returning its session cannot start a scene", t => {
  const s = setup(t, {}, { start() { throw Error("recorder unavailable"); } });
  assert.doesNotThrow(() => s.controller.handle(s.client, ["flat"]));
  assert.equal(s.entered, 0); assert.equal(s.packets.length, 0); assert.equal(s.calls.length, 0);
  assert.equal(s.controller.isActive(), false); assert.equal(s.controller.status().reason, "setup_failed");
});

for (const failure of ["logger", "chat"]) {
  test(`startup ${failure} failure still adopts and stops the recorder before late promises settle`, async t => {
    const r = fakeRecorder(), s = setup(t, {}, r.recorder);
    if (failure === "logger") s.failLogger();
    else s.zone.sendChatText = () => { throw Error("chat failed"); };
    assert.doesNotThrow(() => s.controller.handle(s.client, ["flat"]));
    assert.equal(r.current.stops, 1); assert.equal(s.entered, 0); assert.equal(s.packets.length, 0);
    r.current.rejectReady(); r.current.finish("failed"); await flushRecording();
    assert.equal(s.controller.isActive(), false); assert.equal(s.controller.status().recording, "failed");
  });
}

test("ready arriving at the startup deadline cannot bypass a delayed timeout callback", async t => {
  const r = fakeRecorder(), s = setup(t, {}, r.recorder);
  s.controller.handle(s.client, ["flat"]); s.setNow(12000);
  r.current.resolveReady(); await flushRecording();
  assert.equal(s.entered, 0); assert.equal(s.packets.length, 0); assert.equal(r.current.stops, 1);
  r.current.finish("failed"); await flushRecording();
});

for (const result of ["saved", "failed"]) {
  test(`unexpected early recorder ${result} closes the active exact replay`, async t => {
    const r = fakeRecorder(), s = setup(t, {}, r.recorder);
    s.controller.handle(s.client, ["flat"]); r.current.resolveReady(); await flushRecording();
    s.confirmPosition(); s.tick(100); s.tick(100);
    r.current.finish(result); await flushRecording();
    assert.equal(s.controller.status().reason, "recording_ended_early");
    assert.equal(s.controller.status().recording, result); assert.equal(s.restored, 1);
    assert.equal(s.calls.filter((x: any) => x.action === "finish").length, 1);
    assert.equal(r.current.stops, 1); assert.equal(s.controller.isActive(), false);
  });
}

test("a stopped recording's late ready cannot position or overwrite the next UUID", async t => {
  const r = fakeRecorder(), s = setup(t, {}, r.recorder);
  s.controller.handle(s.client, ["flat"]); const old = r.current;
  s.controller.handle(s.client, ["stop"]); old.finish(); await flushRecording();
  s.controller.handle(s.client, ["flat"]); const id = s.controller.status().id;
  assert.notEqual(id, old.id); old.resolveReady(); await flushRecording();
  assert.equal(s.controller.status().id, id); assert.equal(s.controller.status().state, "recording");
  assert.equal(s.entered, 0); assert.equal(s.packets.length, 0);
  r.current.resolveReady(); await flushRecording(); assert.equal(s.entered, 1);
  s.controller.handle(s.client, ["stop"]); r.current.finish(); await flushRecording();
});

for (const failure of ["send", "logger", "chat", "position_timeout", "overall_timeout", "replay_cleanup", "environment_restore", "record_copy", "stop"]) {
  test(`recording cleanup remains owned and once-only after ${failure}`, async t => {
    const r = fakeRecorder(), s = setup(t, {}, r.recorder);
    s.controller.handle(s.client, ["flat"]);
    if (failure === "send") s.zone.sendRawDataReliable = () => { throw Error("send failed"); };
    r.current.resolveReady(); await flushRecording();
    if (failure === "position_timeout") s.tick(15100);
    else if (failure !== "send") {
      s.confirmPosition(); s.tick(100); s.tick(100);
      if (failure === "logger") { s.failLogger(); s.tick(100); }
      else if (failure === "overall_timeout") s.tick(90000);
      else {
        if (failure === "chat") s.zone.sendChatText = () => { throw Error("chat failed"); };
        if (failure === "replay_cleanup") s.replay.handle = () => { throw Error("cleanup failed"); };
        if (failure === "environment_restore") s.failRestore();
        if (failure === "record_copy") r.current.record = () => { throw Error("copy failed"); };
        if (failure === "stop") r.current.stop = () => { r.current.stops++; throw Error("stop failed"); };
        s.controller.handle(s.client, ["stop"]);
      }
    }
    assert.equal(r.current.stops, 1); assert.equal(s.restored, 1);
    s.controller.handle(s.client, ["stop"]); assert.equal(r.current.stops, 1);
    assert.equal(s.controller.isActive(), true);
    r.current.finish(failure === "stop" ? "failed" : "saved"); await flushRecording();
    if (failure === "record_copy") assert.equal(s.controller.status().recordingLogError, "recording_event_copy_failed");
    assert.equal(s.controller.isActive(), false);
    if (["replay_cleanup", "environment_restore"].includes(failure)) {
      s.controller.handle(s.client, ["flat"]); assert.equal(r.sessions.length, 1);
    }
  });
}

test("unexpected done rejection retains the recording gate instead of claiming a stopped process", async t => {
  const r = fakeRecorder(), s = setup(t, {}, r.recorder);
  s.controller.handle(s.client, ["flat"]); r.current.rejectDone(); await flushRecording();
  assert.equal(s.controller.status().reason, "recording_finalization_unknown");
  assert.equal(r.current.stops, 1); assert.equal(s.controller.isActive(), true);
  s.controller.handle(s.client, ["flat"]); assert.equal(r.sessions.length, 1);
  r.current.rejectReady(); await flushRecording();
});

test("one slash command positions, starts the same replay and logs 45-second prompts before cleanup", t => {
  const s = setup(t); s.start();
  assert.equal(s.entered, 1); assert.equal(s.packets.length, 1);
  assert.equal(s.packets[0].data.unknownByte1, 2);
  assert.equal(s.calls[0].action, "prepare"); assert.equal(s.calls[1].action, "start");
  assert.equal(s.controller.status().state, "running");
  for (let i = 0; i < 450; i++) s.tick(100);
  assert.equal(s.controller.status().reason, "completed_observation_window");
  assert.equal(s.calls.filter((c: any) => c.action === "finish").length, 1); assert.equal(s.restored, 1);
  assert.equal(s.logs.filter(e => e.event === "operator_prompt").length, 5);
  assert.ok(s.logs.some(e => e.event === "server_sample" && e.meaning.includes("server state only")));
  s.controller.dispose(); assert.equal(s.restored, 1);
});

for (const invalid of ["multi", "remote", "dead", "mounted", "loading", "version", "active_replay"]) {
  test(`preflight ${invalid} refuses before changing environment or sending a position`, t => {
    const s = setup(t);
    if (invalid === "multi") s.zone._clients[2] = {};
    if (invalid === "remote") s.zone._soloMode = false;
    if (invalid === "dead") s.client.character.isAlive = false;
    if (invalid === "mounted") s.client.vehicle.mountedVehicle = "vehicle";
    if (invalid === "loading") s.client.isLoading = true;
    if (invalid === "version") s.client.testZombieMovementVersion = undefined;
    if (invalid === "active_replay") s.setState({ state: "running" });
    s.controller.handle(s.client, ["flat"]); assert.equal(s.entered, 0); assert.equal(s.packets.length, 0);
  });
}

test("status/invalid arguments never mutate; overlapping slash runs do not reset the timer", t => {
  const s = setup(t);
  for (const args of [[], ["bad"], ["flat", "other"], ["status"]]) s.controller.handle(s.client, args);
  assert.equal(s.entered, 0);
  s.controller.handle(s.client, ["flat"]); s.controller.handle(s.client, ["slope"]);
  assert.equal(s.entered, 1); s.tick(15100); assert.equal(s.restored, 1);
  assert.equal(s.controller.status().reason, "position_not_confirmed");
});

test("stale sample, wrong location and airborne state cannot prepare a replay", t => {
  const s = setup(t); s.controller.handle(s.client, ["flat"]);
  s.tick(1000); assert.equal(s.calls.length, 0);
  s.client.character.state.position = new Float32Array([0, 10, 0, 1]); s.tick(100);
  assert.equal(s.calls.length, 0);
  s.client.isInAir = true; s.confirmPosition(); assert.equal(s.calls.length, 0);
  s.client.isInAir = false; s.tick(100); assert.equal(s.calls[0].action, "prepare");
});

test("operator stop and disconnect restore environment and finish the owned replay once", t => {
  const s = setup(t); s.start(); s.controller.handle(s.client, ["stop"]);
  assert.equal(s.restored, 1); assert.equal(s.controller.status().reason, "operator_stop");
  s.controller.handle(s.client, ["stop"]); assert.equal(s.restored, 1);
});

test("disconnect closes without posting feedback to a replacement client", t => {
  const s = setup(t); s.start(); const count = s.messages.length;
  s.zone._clients[1] = {}; s.tick(100);
  assert.equal(s.restored, 1); assert.equal(s.messages.length, count);
  assert.equal(s.controller.status().reason, "client_changed_or_unavailable");
});

test("a foreign replacement replay is not finished by old scenario cleanup", t => {
  const s = setup(t); s.start(); s.setState({ state: "running", replayId: "foreign", target: "1" });
  s.tick(100); assert.equal(s.calls.filter((c: any) => c.action === "finish").length, 0);
  assert.equal(s.restored, 1); assert.equal(s.controller.status().reason, "replay_identity_changed");
});

test("failed replay cleanup is visible and blocks another slash run", t => {
  const s = setup(t); s.start(); s.replay.handle = () => { throw Error("cleanup"); };
  s.controller.handle(s.client, ["stop"]);
  assert.equal(s.controller.status().cleanupError, "replay_cleanup_failed"); assert.equal(s.restored, 1);
  s.controller.handle(s.client, ["flat"]); assert.equal(s.entered, 1);
});

test("position send failure releases the environment without starting the replay", t => {
  const s = setup(t); s.zone.sendRawDataReliable = () => { throw Error("send"); };
  s.controller.handle(s.client, ["flat"]); assert.equal(s.restored, 1); assert.equal(s.calls.length, 0);
});

test("logger failure in a timer cannot prevent replay and environment cleanup", t => {
  const s = setup(t); s.start(); s.failLogger();
  assert.doesNotThrow(() => s.tick(100));
  assert.equal(s.controller.isActive(), false); assert.equal(s.restored, 1);
  assert.equal(s.calls.filter((c: any) => c.action === "finish").length, 1);
  assert.equal(s.controller.status().reason, "scenario_error");
});

test("broken chat transport during setup or final cleanup cannot escape or strand a run", t => {
  const s = setup(t); s.zone.sendChatText = () => { throw Error("transport failed"); };
  assert.doesNotThrow(() => s.controller.handle(s.client, ["flat"]));
  assert.equal(s.controller.isActive(), false); assert.equal(s.restored, 1);
  assert.doesNotThrow(() => s.controller.dispose());
});

test("stop retries retained NPC cleanup for the exact lease without restoring the environment twice", t => {
  const s = setup(t); s.start();
  const originalHandle = s.replay.handle;
  let attempts = 0;
  const finishRequests: any[] = [];
  s.replay.handle = (request: any) => {
    if (request.action === "finish") {
      finishRequests.push(request); attempts++;
      if (attempts === 1) {
        const failed = { ...s.replay.getStatus(), state: "failed", protectionApplied: true,
          cleanupError: "owned_npc_cleanup_incomplete_protection_retained_retry_finish" };
        s.setState(failed); return failed;
      }
    }
    return originalHandle(request);
  };
  s.controller.handle(s.client, ["stop"]);
  assert.equal(s.controller.status().state, "cleanup_failed");
  assert.equal(s.controller.status().cleanupRetryable, true); assert.equal(s.restored, 1);
  s.controller.handle(s.client, ["stop"]);
  assert.equal(s.controller.status().state, "stopped"); assert.equal(s.restored, 1);
  assert.deepEqual(finishRequests[1], finishRequests[0]);
  assert.equal(s.replay.getStatus().protectionApplied, false);
  s.controller.handle(s.client, ["flat"]); assert.equal(s.entered, 2);
});

test("environment restoration failure is retained and never retried by stop", t => {
  const s = setup(t); s.start(); s.failRestore(); s.controller.handle(s.client, ["stop"]);
  assert.equal(s.controller.status().cleanupError, "environment_restore_failed");
  const finishes = s.calls.filter((c: any) => c.action === "finish").length;
  s.controller.handle(s.client, ["stop"]); s.controller.handle(s.client, ["stop"]);
  assert.equal(s.restored, 1);
  assert.equal(s.calls.filter((c: any) => c.action === "finish").length, finishes);
  assert.ok(s.messages.at(-1)?.includes("not safely retryable"));
  s.controller.handle(s.client, ["flat"]); assert.equal(s.entered, 1);
});

for (const outcome of ["clean", "route_failed", "foreign", "environment_failed"]) {
  test(`new slash command reconciles a settled cancelled spawn only when its exact cleanup is safe: ${outcome}`, t => {
    const s = setup(t); s.start();
    const originalHandle = s.replay.handle;
    let finishedPending = false, finishCalls = 0;
    s.replay.handle = (request: any) => {
      if (request.action !== "finish") return originalHandle(request);
      finishCalls++;
      if (!finishedPending) {
        finishedPending = true;
        const pending = { ...s.replay.getStatus(), state: "finished", spawnTaskPending: true,
          cleanupError: "spawn_task_pending_cleanup_protection_retained", protectionApplied: true };
        s.setState(pending); return pending;
      }
      return s.replay.getStatus();
    };
    if (outcome === "environment_failed") s.failRestore();
    s.controller.handle(s.client, ["stop"]);
    assert.equal(s.controller.status().cleanupRetryable, true);
    s.controller.handle(s.client, ["flat"]);
    assert.equal(s.entered, 1); assert.equal(finishCalls, 1);
    const settled = { ...s.replay.getStatus(), spawnTaskPending: false, protectionApplied: false,
      cleanupError: outcome === "route_failed" ? "route_resource_disposal_failed_not_retried" : null };
    if (outcome === "foreign") settled.replayId = "newer-foreign-replay";
    s.setState(settled);
    const beforeStatus = s.controller.status();
    s.controller.handle(s.client, ["status"]);
    assert.equal(s.controller.status(), beforeStatus); assert.equal(finishCalls, 1);
    s.controller.handle(s.client, ["flat"]);
    assert.equal(s.entered, outcome === "clean" ? 2 : 1);
    assert.equal(finishCalls, outcome === "foreign" ? 1 : 2);
    assert.equal(s.restored, 1, "async completion never retries environment restoration");
    if (outcome !== "clean") assert.equal(s.controller.status().state, "cleanup_failed");
  });
}

test("NPC cleanup can be retried while an independent environment failure stays blocked", t => {
  const s = setup(t); s.start(); s.failRestore();
  const originalHandle = s.replay.handle;
  let fail = true;
  s.replay.handle = (request: any) => {
    if (request.action === "finish" && fail) {
      fail = false;
      const failed = { ...s.replay.getStatus(), state: "failed", protectionApplied: true,
        cleanupError: "owned_npc_cleanup_incomplete_protection_retained_retry_finish" };
      s.setState(failed); return failed;
    }
    return originalHandle(request);
  };
  s.controller.handle(s.client, ["stop"]);
  assert.equal(s.controller.status().cleanupErrors.length, 2);
  s.controller.handle(s.client, ["stop"]);
  assert.equal(s.replay.getStatus().protectionApplied, false);
  assert.equal(s.controller.status().cleanupError, "environment_restore_failed");
  assert.equal(s.controller.status().cleanupRetryable, false); assert.equal(s.restored, 1);
});

for (const replacement of ["replay", "request", "npc", "session", "player", "client_object"]) {
  test(`cleanup retry does not finish a replacement ${replacement}`, t => {
    const s = setup(t); s.start();
    let calls = 0;
    s.replay.handle = () => {
      calls++;
      const failed = { ...s.replay.getStatus(), state: "failed", protectionApplied: true,
        cleanupError: "owned_npc_cleanup_incomplete_protection_retained_retry_finish" };
      s.setState(failed); return failed;
    };
    s.controller.handle(s.client, ["stop"]);
    const foreign = { ...s.replay.getStatus() };
    if (replacement === "replay") foreign.replayId = "foreign";
    if (replacement === "request") foreign.requestId = "foreign";
    if (replacement === "npc") foreign.npcCharacterId = "foreign";
    if (replacement === "session") foreign.target = "2";
    if (replacement === "player") foreign.playerCharacterId = "foreign";
    s.setState(foreign);
    const operator = replacement === "client_object" ? { ...s.client } : s.client;
    if (replacement === "client_object") s.zone._clients[1] = operator;
    s.controller.handle(operator, ["stop"]);
    assert.equal(calls, 1); assert.equal(s.restored, 1);
    assert.equal(s.controller.status().state, "cleanup_failed");
  });
}

test("native route disposal failure is not retried by stop", t => {
  const s = setup(t); s.start(); let calls = 0;
  s.replay.handle = () => {
    calls++;
    const failed = { ...s.replay.getStatus(), state: "failed", protectionApplied: false,
      cleanupError: "route_resource_disposal_failed_not_retried" };
    s.setState(failed); return failed;
  };
  s.controller.handle(s.client, ["stop"]); s.controller.handle(s.client, ["stop"]);
  assert.equal(calls, 1); assert.equal(s.restored, 1);
  assert.equal(s.controller.status().cleanupRetryable, false);
});

test("prepare throwing after publishing its own lease still gets exact cleanup", t => {
  const s = setup(t); const originalHandle = s.replay.handle;
  s.replay.handle = (request: any) => {
    const result = originalHandle(request);
    if (request.action === "prepare") throw Error("published then failed");
    return result;
  };
  s.controller.handle(s.client, ["flat"]); s.confirmPosition();
  assert.equal(s.calls.filter((c: any) => c.action === "finish").length, 1);
  assert.equal(s.replay.getStatus().protectionApplied, false); assert.equal(s.restored, 1);
  assert.equal(s.controller.status().reason, "scenario_error");
});

test("prepare rejection cannot adopt a different request's lease for cleanup", t => {
  const s = setup(t); let finishes = 0;
  s.replay.handle = (request: any) => {
    if (request.action === "finish") finishes++;
    s.setState({ state: "running", replayId: "foreign", target: "1", requestId: "foreign",
      playerCharacterId: "player", npcCharacterId: "foreign", protectionApplied: true });
    throw Error("concurrent replay");
  };
  s.controller.handle(s.client, ["flat"]); s.confirmPosition();
  assert.equal(finishes, 0); assert.equal(s.restored, 1);
});

for (const changed of ["character_id", "session_id"]) {
  test(`changing the captured object's ${changed} still cleans up the original exact lease`, t => {
    const s = setup(t); s.start();
    if (changed === "character_id") s.client.character.characterId = "changed";
    else s.client.sessionId = 2;
    s.tick(100);
    const finish = s.calls.find((c: any) => c.action === "finish");
    assert.ok(finish); assert.equal(finish.target, "1"); assert.equal(finish.replayId, "r1");
    assert.equal(finish.expectedNpcCharacterId, "npc");
    assert.equal(s.replay.getStatus().protectionApplied, false); assert.equal(s.restored, 1);
  });
}

test("a confirmed position with a different facing cannot prepare outside the fixed corridor", t => {
  const s = setup(t);
  s.client.character.state.rotation = new Float32Array([0, Math.SQRT1_2, 0, Math.SQRT1_2]);
  s.controller.handle(s.client, ["flat"]); s.confirmPosition();
  assert.equal(s.calls.length, 0); assert.equal(s.controller.status().state, "positioning");
  s.client.character.state.rotation = new Float32Array([0, 0, 0, 1]); s.tick(100);
  assert.equal(s.calls[0].action, "prepare");
});

for (const rotation of [undefined, [0, 0, 0, 0], [NaN, 0, 0, 1], [0, 0, 0, 2]]) {
  test(`invalid facing ${JSON.stringify(rotation)} cannot prepare`, t => {
    const s = setup(t); s.client.character.state.rotation = rotation;
    s.controller.handle(s.client, ["flat"]); s.confirmPosition();
    assert.equal(s.calls.length, 0); s.tick(15100);
    assert.equal(s.controller.status().reason, "position_not_confirmed"); assert.equal(s.restored, 1);
  });
}

for (const spawn of ["off_corridor", "missing", "nonfinite"]) {
  test(`paused NPC ${spawn} cannot start a substituted spawn corridor`, t => {
    const s = setup(t); const originalHandle = s.replay.handle;
    s.replay.handle = (request: any) => {
      const result = originalHandle(request);
      if (request.action === "prepare") {
        if (spawn === "off_corridor") s.zone._npcs.npc.state.position = new Float32Array([12, 10, 0, 1]);
        if (spawn === "missing") delete s.zone._npcs.npc;
        if (spawn === "nonfinite") s.zone._npcs.npc.state.position[0] = NaN;
      }
      return result;
    };
    s.controller.handle(s.client, ["flat"]); s.confirmPosition();
    assert.equal(s.calls[0].action, "prepare");
    s.tick(100);
    assert.equal(s.calls.filter((c: any) => c.action === "start").length, 0);
    assert.equal(s.calls.filter((c: any) => c.action === "finish").length, 1);
    assert.equal(s.controller.status().reason, "fixed_spawn_direction_not_confirmed");
    assert.equal(s.restored, 1);
  });
}

test("v2 fence uses its exact fixed player point and six-metre +Z named recipe with bounded prompts", t => {
  const s = setup(t); s.controller.handle(s.client, ["fence"]);
  assert.deepEqual(Array.from(s.packets[0].data.position), [189, 22.012500762939453, -925.219970703125, 1]);
  assert.deepEqual(Array.from(s.packets[0].data.rotation), [0, 0, 1, 0]);
  s.confirmPosition(); s.tick(100); s.tick(100);
  const prepare = s.calls.find((c: any) => c.action === "prepare");
  assert.equal(prepare.distance, 6); assert.equal(prepare.knownObstacle, "fence-192060");
  assert.equal(s.controller.status().suiteVersion, 2); assert.equal(s.controller.status().distance, 6);
  assert.equal(s.controller.status().knownObstacle, "fence-192060");
  assert.equal(s.controller.status().state, "running");
  for (let i = 0; i < 450; i++) s.tick(100);
  assert.equal(s.controller.status().reason, "completed_observation_window");
  assert.equal(s.restored, 1); assert.equal(s.calls.filter((c: any) => c.action === "finish").length, 1);
  assert.ok(s.messages.some(m => m.includes("WEST end")));
  assert.ok(s.messages.some(m => m.includes("between you and the zombie")));
  assert.ok(s.messages.some(m => m.includes("same side")));
  assert.ok(s.messages.some(m => m.includes("other collision is unknown")));
  assert.ok(s.messages.every(m => m.startsWith("[ztest v2]")));
});

test("flat and slope still prepare twelve metres without the fence option", t => {
  const s = setup(t);
  for (const scene of ["flat", "slope"]) {
    s.controller.handle(s.client, [scene]);
    s.confirmPosition();
    const prepare = s.calls.filter((c: any) => c.action === "prepare").at(-1);
    assert.equal(prepare.distance, 12); assert.equal(Object.hasOwn(prepare, "knownObstacle"), false);
    s.controller.handle(s.client, ["stop"]);
  }
  assert.equal(s.entered, 2); assert.equal(s.restored, 2);
});

for (const changed of [{ distance: 12 }, { distance: 6.5 }, { distance: "6" },
  { distance: undefined }, { knownObstacle: "fence-192179" }, { knownObstacle: null }]) {
  test(`invalid configured fence recipe ${JSON.stringify(changed)} fails before environment or position`, t => {
    const s = setup(t, { fence: { ...scenesModule.exports.ZOMBIE_TEST_SCENES.fence, ...changed } });
    s.controller.handle(s.client, ["fence"]);
    assert.equal(s.entered, 0); assert.equal(s.packets.length, 0); assert.equal(s.calls.length, 0);
  });
}

test("fence scene mutations after command entry cannot change this run's point or recipe", t => {
  const s = setup(t); s.controller.handle(s.client, ["fence"]);
  s.scenes.fence.distance = 12; s.scenes.fence.knownObstacle = "foreign"; s.scenes.fence.position[0] = 999;
  s.confirmPosition(); s.tick(100); s.tick(100);
  const prepare = s.calls.find((c: any) => c.action === "prepare");
  assert.equal(prepare.distance, 6); assert.equal(prepare.knownObstacle, "fence-192060");
  assert.equal(s.controller.status().state, "running");
});

test("fence cannot start if asynchronous spawn uses twelve metres instead of its selected six", t => {
  const s = setup(t); const originalHandle = s.replay.handle;
  s.replay.handle = (request: any) => {
    const result = originalHandle(request);
    if (request.action === "prepare") s.zone._npcs.npc.state.position[2] += 6;
    return result;
  };
  s.controller.handle(s.client, ["fence"]); s.confirmPosition(); s.tick(100);
  assert.equal(s.calls.filter((c: any) => c.action === "start").length, 0);
  assert.equal(s.controller.status().reason, "fixed_spawn_direction_not_confirmed"); assert.equal(s.restored, 1);
});

test("fence stops if replay selection changes and never starts the substituted recipe", t => {
  const s = setup(t); const originalHandle = s.replay.handle;
  s.replay.handle = (request: any) => {
    const result = originalHandle(request);
    if (request.action === "prepare") s.setState({ ...result, knownObstacle: undefined });
    return result;
  };
  s.controller.handle(s.client, ["fence"]); s.confirmPosition(); s.tick(100);
  assert.equal(s.calls.filter((c: any) => c.action === "start").length, 0);
  assert.equal(s.controller.status().reason, "replay_recipe_changed"); assert.equal(s.restored, 1);
  assert.equal(s.calls.filter((c: any) => c.action === "finish").length, 1);
});

test("stopping fence positioning restores environment without spawning or later starting", t => {
  const s = setup(t); s.controller.handle(s.client, ["fence"]); s.controller.handle(s.client, ["stop"]);
  s.confirmPosition(); s.tick(45000);
  assert.equal(s.calls.length, 0); assert.equal(s.restored, 1); assert.equal(s.controller.status().reason, "operator_stop");
});

test("a fresh clock/stance/rotation sample plus cached destination cannot confirm positioning", t => {
  const s = setup(t); s.client.character.state.position = [0, 10, 0, 1];
  s.controller.handle(s.client, ["flat"]);
  s.client.testZombieClockDiagnostics = { samples: 11, lastReceivedAt: Date.now(), lastSequenceTime: 101, lastFlags: 513 };
  s.tick(100);
  assert.equal(s.calls.length, 0);
  assert.equal(s.controller.status().positionWait, "new_position_receipt_missing");
  assert.equal(s.zone._lastSpawnedNpcCharacterId, null);
  s.tick(15100);
  assert.equal(s.controller.status().reason, "position_not_confirmed");
  assert.ok(s.logs.some(e => e.event === "positioning_closed" && e.waiting === "new_position_receipt_missing"));
});

for (const [name, overrides, expected] of [
  ["old version", { movementVersion: 1 }, "position_receipt_version_mismatch"],
  ["old sequence", { sequenceTime: 99 }, "position_receipt_sequence_not_new"],
  ["duplicate sequence", { sequenceTime: 100 }, "position_receipt_sequence_not_new"],
  ["old count", { count: 0 }, "new_position_receipt_missing"],
  ["old receipt", { receivedAt: 99999 }, "position_receipt_stale"],
  ["future receipt", { receivedAt: 100500 }, "position_receipt_stale"],
  ["different character object", { character: {} }, "position_receipt_owner_changed"],
  ["different character id", { playerCharacterId: "other" }, "position_receipt_owner_changed"],
  ["outside fixed point", { position: [0.3, 10, 0, 1] }, "position_outside_fixed_scene"]
] as const) {
  test(`position confirmation rejects ${name} without preparing or deleting a preview`, t => {
    const s = setup(t); s.zone._lastSpawnedNpcCharacterId = "preview";
    s.zone._npcs.preview = { characterId: "preview" };
    // Wire sequence order is anchored to a verified position receipt, not to
    // the unrelated clock diagnostic that can contain a misaligned timestamp.
    if (expected === "position_receipt_sequence_not_new")
      s.receivePosition({ sequenceTime: 100, movementVersion: 1 });
    s.controller.handle(s.client, ["flat"]); s.receivePosition(overrides); s.tick(100);
    assert.equal(s.calls.length, 0); assert.equal(s.controller.status().positionWait, expected);
    assert.equal(s.zone._lastSpawnedNpcCharacterId, "preview"); assert.ok(s.zone._npcs.preview);
  });
}

test("first real aligned position receipt is not ordered against an earlier misaligned clock diagnostic", t => {
  const s = setup(t);
  s.client.testZombieMovementVersion = 0;
  s.client.testZombieClockDiagnostics = { samples: 10, lastReceivedAt: 99999,
    lastSequenceTime: 19441036, lastServerTime: 4489900, lastResult: "misaligned" };
  assert.equal(s.client.testZombiePositionReceipt, undefined);
  s.controller.handle(s.client, ["flat"]);
  const instruction = s.logs.find(e => e.event === "position_instruction");
  assert.ok(instruction); assert.equal(instruction.receiptsBefore, 0);
  assert.equal(instruction.sequenceBefore ?? null, null);
  assert.equal(s.packets[0].data.unknownByte1, 1);

  // Execute the real observer on a newly applied raw packet. Neither its
  // coordinates nor the receipt are synthesized from the accumulated cache.
  s.tick(10);
  const packet = { flags: 8191, sequenceTime: 4489944, unknown3_int8: 1,
    position: [...s.packets[0].data.position], rotation: [0, 0, 0, 1] };
  s.client.character.state.position = packet.position;
  s.client.testZombieMovementVersion = 1;
  assert.equal(recordTestZombiePositionReceipt(s.client, packet, 4489944), true);
  assert.equal(s.client.testZombiePositionReceipt.count, 1);
  assert.equal(s.client.testZombiePositionReceipt.clockAligned, true);
  s.client.testZombieClockDiagnostics = { samples: 11, lastReceivedAt: Date.now(),
    lastSequenceTime: 4489944, lastServerTime: 4489944, lastResult: "aligned" };
  s.tick(100);
  assert.equal(s.calls.length, 1); assert.equal(s.calls[0].action, "prepare");
  const confirmed = s.logs.find(e => e.event === "position_confirmed");
  assert.ok(confirmed); assert.equal(confirmed.receipt.sequenceTime, 4489944);
  assert.equal(confirmed.receipt.count, 1); assert.equal(confirmed.receipt.flags, 8191);
});

test("existing same-character receipt anchors sequence even when newer diagnostics move backwards", t => {
  const s = setup(t);
  s.receivePosition({ sequenceTime: 1000, movementVersion: 1 });
  s.client.testZombieClockDiagnostics.lastSequenceTime = 1;
  s.controller.handle(s.client, ["flat"]);
  const instruction = s.logs.find(e => e.event === "position_instruction");
  assert.equal(instruction.receiptsBefore, 1); assert.equal(instruction.sequenceBefore, 1000);
  s.receivePosition({ sequenceTime: 999 }); s.tick(100);
  assert.equal(s.calls.length, 0);
  assert.equal(s.controller.status().positionWait, "position_receipt_sequence_not_new");
  s.receivePosition({ sequenceTime: 1001 }); s.tick(100);
  assert.equal(s.calls[0].action, "prepare");
});

for (const sequenceTime of [1000, 999, (1000 + 0x80000000) >>> 0]) {
  test(`same-character receipt baseline rejects non-forward sequence ${sequenceTime}`, t => {
    const s = setup(t); s.receivePosition({ sequenceTime: 1000, movementVersion: 1 });
    s.controller.handle(s.client, ["flat"]);
    s.receivePosition({ sequenceTime }); s.tick(100);
    assert.equal(s.calls.length, 0);
    assert.equal(s.controller.status().positionWait, "position_receipt_sequence_not_new");
  });
}

test("same-character verified receipt baseline accepts normal u32 sequence wrap", t => {
  const s = setup(t); s.receivePosition({ sequenceTime: 0xfffffff0, movementVersion: 1 });
  s.client.testZombieClockDiagnostics.lastSequenceTime = 19441036;
  s.controller.handle(s.client, ["flat"]);
  const instruction = s.logs.find(e => e.event === "position_instruction");
  assert.equal(instruction.sequenceBefore, 0xfffffff0);
  s.receivePosition({ sequenceTime: 5 }); s.tick(100);
  assert.equal(s.calls.length, 1); assert.equal(s.calls[0].action, "prepare");
});

test("a baseline receipt plus fresh clocks and cached coordinates is still not a new position receipt", t => {
  const s = setup(t); s.receivePosition({ sequenceTime: 1000, movementVersion: 1 });
  const oldReceipt = s.client.testZombiePositionReceipt;
  s.controller.handle(s.client, ["flat"]);
  s.client.testZombieMovementVersion = 2;
  s.client.testZombieClockDiagnostics = { samples: 11, lastReceivedAt: Date.now(),
    lastSequenceTime: 1001, lastFlags: 513, lastResult: "aligned" };
  s.tick(100);
  assert.equal(s.client.testZombiePositionReceipt, oldReceipt);
  assert.equal(s.calls.length, 0);
  assert.equal(s.controller.status().positionWait, "new_position_receipt_missing");
});

test("replacing the character after a verified baseline fails closed even with a fresh replacement receipt", t => {
  const s = setup(t); s.receivePosition({ sequenceTime: 1000, movementVersion: 1 });
  s.controller.handle(s.client, ["flat"]);
  s.client.character = { ...s.client.character, state: { ...s.client.character.state } };
  s.receivePosition({ sequenceTime: 1001 }); s.tick(100);
  assert.equal(s.calls.length, 0); assert.equal(s.restored, 1);
  assert.equal(s.controller.status().reason, "client_changed_or_unavailable");
});

test("a different current cached position cannot reuse an earlier valid receipt", t => {
  const s = setup(t); s.controller.handle(s.client, ["flat"]); s.receivePosition();
  s.client.character.state.position = [0.1, 10, 0, 1]; s.tick(100);
  assert.equal(s.calls.length, 0);
  assert.equal(s.controller.status().positionWait, "position_changed_since_receipt");
  s.receivePosition(); s.tick(100); assert.equal(s.calls[0].action, "prepare");
});

test("a version request wraps255 to0 without updating the observed version or pose", t => {
  const s = setup(t); s.client.testZombieMovementVersion = 255;
  const position = s.client.character.state.position;
  s.controller.handle(s.client, ["flat"]);
  assert.equal(s.packets[0].data.unknownByte1, 0);
  assert.equal(s.client.testZombieMovementVersion, 255);
  assert.equal(s.client.character.state.position, position); assert.equal(s.calls.length, 0);
  s.confirmPosition(); assert.equal(s.calls[0].action, "prepare");
});

test("same-point consecutive rounds require independent new versioned position receipts", t => {
  const s = setup(t); s.start(); s.controller.handle(s.client, ["stop"]);
  const firstReceipt = s.client.testZombiePositionReceipt;
  const prepares = s.calls.filter((c: any) => c.action === "prepare").length;
  s.controller.handle(s.client, ["flat"]); s.tick(100);
  assert.equal(s.packets[1].data.unknownByte1, 3);
  assert.equal(s.client.testZombiePositionReceipt, firstReceipt);
  assert.equal(s.calls.filter((c: any) => c.action === "prepare").length, prepares);
  s.confirmPosition(); s.tick(100); s.tick(100);
  assert.equal(s.controller.status().state, "running");
  assert.equal(s.calls.filter((c: any) => c.action === "prepare").length, prepares + 1);
});

test("a position-only receipt keeps packet rotation unknown while separately checking current facing", t => {
  const s = setup(t); s.controller.handle(s.client, ["flat"]);
  s.receivePosition({ flags: 2, rotation: null }); s.tick(100);
  const event = s.logs.find(e => e.event === "position_observed_and_prepare");
  assert.ok(event); assert.equal(event.positionEvidence.receipt.rotation, null);
  assert.equal(s.calls[0].action, "prepare");
});

test("confirmed new slash epoch replaces an exhausted old baseline version without allowing unlimited refresh", t => {
  const s = setup(t);
  s.client.testZombieClockResync = { count: 3, requestedAt: 95000, requestedVersion: 1 };
  const old = s.client.testZombieClockResync;
  const sends: any[] = []; s.zone.sendData = (...args: any[]) => sends.push(args);
  s.client.testZombieSynchronization = { count: 1, repliedAt: Date.now() - 1000 };
  s.controller.handle(s.client, ["flat"]); s.tick(100);
  assert.equal(s.client.testZombieClockResync, old, "request alone cannot reset clock state");
  s.confirmPosition();
  assert.deepEqual(JSON.parse(JSON.stringify(s.client.testZombieClockResync)), {
    count: 0, requestedAt: 100000, requestedVersion: 2
  });
  assert.ok(s.logs.some(e => e.event === "position_confirmed" && e.previousClockRefresh === old));
  const refresh = () => baselineModule.exports.requestTestZombieClockBaseline(s.zone, s.client);
  assert.equal(refresh(), false, "new positioning request still enforces existing cooldown");
  for (let attempt = 1; attempt <= 3; attempt++) {
    s.tick(2000); s.client.testZombieSynchronization.repliedAt = Date.now() - 1000;
    assert.equal(refresh(), true);
    assert.equal(s.client.testZombieClockResync.count, attempt);
    assert.equal(s.client.testZombieClockResync.requestedVersion, attempt + 2);
    assert.equal(refresh(), false, "pending version cannot be advanced without echo");
    s.client.testZombieMovementVersion = attempt + 2;
    s.client.testZombieClockDiagnostics.lastReceivedAt = Date.now();
  }
  s.tick(2000); s.client.testZombieSynchronization.repliedAt = Date.now() - 1000;
  assert.equal(refresh(), false); assert.equal(sends.length, 3);
  assert.equal(s.client.testZombieClockResync.count, 3);
});

test("a failed position handshake cannot erase an old clock-refresh epoch", t => {
  const s = setup(t); const old = { count: 3, requestedAt: 95000, requestedVersion: 1 };
  s.client.testZombieClockResync = old; s.controller.handle(s.client, ["flat"]);
  s.receivePosition({ movementVersion: 1 }); s.tick(15100);
  assert.equal(s.client.testZombieClockResync, old);
  assert.equal(s.calls.length, 0); assert.equal(s.controller.status().reason, "position_not_confirmed");
});

for (const version of [1, 3]) {
  test(`a non-position header switching to version${version} cannot confirm an earlier version2 receipt`, t => {
    const s = setup(t); const old = { count: 3, requestedAt: 95000, requestedVersion: 1 };
    s.client.testZombieClockResync = old; s.controller.handle(s.client, ["flat"]);
    s.receivePosition();
    s.client.testZombieMovementVersion = version;
    s.client.testZombieClockDiagnostics.lastFlags = 513;
    s.client.testZombieClockDiagnostics.lastSequenceTime++;
    s.tick(100);
    assert.equal(s.controller.status().positionWait, "current_movement_version_changed");
    assert.equal(s.calls.length, 0); assert.equal(s.client.testZombieClockResync, old);
  });
}

test("ordinary samples and repeated ticks cannot reset the confirmed run's automatic refresh budget", t => {
  const s = setup(t); s.start();
  const epoch = s.client.testZombieClockResync;
  epoch.count = 2; epoch.requestedVersion = 4;
  s.receivePosition({ movementVersion: 4 });
  for (let i = 0; i < 10; i++) s.tick(100);
  assert.equal(s.client.testZombieClockResync, epoch); assert.equal(epoch.count, 2);
  assert.equal(s.logs.filter(e => e.event === "position_confirmed").length, 1);
});
