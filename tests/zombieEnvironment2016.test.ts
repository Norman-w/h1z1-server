import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { enterTestZombieEnvironment } from "../src/servers/ZoneServer2016/test-zombie-environment";

const templates = JSON.parse(readFileSync("data/2016/dataSources/weather.json", "utf8"));
function fixture(frozen = false, dynamic = true) {
  const calls: string[] = [];
  const originalWeather = { ...templates.h1emubaseweather, skyClarity: 0.8, temperature: 31 };
  const worker = { refresh() { calls.push("worker-refresh"); return worker; } };
  const clock = {
    time: 12345, timeFrozen: frozen, timeFrozenByConfig: frozen, baseTimeMultiplier: 72,
    nightTimeMultiplier: 2, nightTimeMultiplierValue: 2, lastIngameTimeUpdate: { old: true } as object | null,
    stop() { calls.push("clock-stop"); this.timeFrozen = true; this.lastIngameTimeUpdate = null; },
    start() { calls.push("clock-start"); if (!this.timeFrozenByConfig) this.timeFrozen = false; }
  };
  const weather = { templates: structuredClone(templates), weather: originalWeather, dynamicEnabled: dynamic,
    dynamicWorker: worker, sendUpdateToAll() { calls.push("weather-send"); } };
  const server: any = { _soloMode: true, _clients: { 1: { id: 1 } }, inGameTimeManager: clock, weatherManager: weather,
    sendGameTimeSync() { calls.push("time-send"); } };
  return { server, clock, weather, worker, originalWeather, calls };
}

for (const frozen of [false, true]) for (const dynamic of [false, true]) {
  test(`fixed noon/clear and exact restoration frozen=${frozen} dynamic=${dynamic}`, () => {
    const s = fixture(frozen, dynamic), templateBefore = structuredClone(s.weather.templates);
    const h = enterTestZombieEnvironment(s.server);
    assert.equal(s.clock.time, 43200); assert.equal(s.clock.timeFrozen, true);
    assert.equal(s.weather.dynamicEnabled, false); assert.deepEqual(s.weather.weather, templates.h1emubaseweather);
    assert.notEqual(s.weather.weather, s.weather.templates.h1emubaseweather);
    assert.notEqual(s.weather.weather, s.originalWeather); assert.equal(s.weather.dynamicWorker, s.worker);
    const entered = s.calls.length; assert.equal(enterTestZombieEnvironment(s.server), h); assert.equal(s.calls.length, entered);
    h.restore(); assert.equal(s.clock.time, 12345); assert.equal(s.clock.timeFrozen, frozen);
    assert.equal(s.clock.baseTimeMultiplier, 72); assert.equal(s.clock.nightTimeMultiplier, 2);
    assert.equal(s.clock.timeFrozenByConfig, frozen); assert.equal(s.clock.lastIngameTimeUpdate, null);
    assert.deepEqual(s.weather.weather, s.originalWeather); assert.equal(s.weather.dynamicEnabled, dynamic);
    assert.deepEqual(s.weather.templates, templateBefore);
    assert.equal(s.calls.filter(c => c === "clock-start").length, frozen ? 0 : 1);
    assert.equal(s.calls.filter(c => c === "worker-refresh").length, dynamic ? 1 : 0);
    const restored = s.calls.length; h.restore(); assert.equal(s.calls.length, restored);
    const again = enterTestZombieEnvironment(s.server); assert.notEqual(again, h); again.restore();
  });
}

for (const invalid of ["remote", "missing_worker", "invalid_time", "invalid_multiplier", "unknown_flag", "mutated_template", "bad_snapshot"]) {
  test(`reject ${invalid} before any mutation`, () => {
    const s = fixture();
    if (invalid === "remote") s.server._soloMode = false;
    if (invalid === "missing_worker") s.weather.dynamicWorker = undefined as any;
    if (invalid === "invalid_time") s.clock.time = NaN;
    if (invalid === "invalid_multiplier") s.clock.baseTimeMultiplier = 0;
    if (invalid === "unknown_flag") s.clock.timeFrozen = undefined as any;
    if (invalid === "mutated_template") s.weather.templates.h1emubaseweather.globalPrecipitation = 1;
    if (invalid === "bad_snapshot") s.weather.weather.temperature = NaN;
    assert.throws(() => enterTestZombieEnvironment(s.server)); assert.deepEqual(s.calls, []);
  });
}

for (const failure of ["stop", "weather_send", "time_send"]) {
  test(`partial setup ${failure} rolls back its snapshot before throwing`, () => {
    const s = fixture(); let once = true;
    const field = failure === "stop" ? s.clock : failure === "weather_send" ? s.weather : s.server;
    const key = failure === "stop" ? "stop" : failure === "weather_send" ? "sendUpdateToAll" : "sendGameTimeSync";
    const original = (field as any)[key];
    (field as any)[key] = function(...args: any[]) { original.apply(this, args); if (once) { once = false; throw Error("injected"); } };
    assert.throws(() => enterTestZombieEnvironment(s.server), /injected/);
    assert.equal(s.clock.time, 12345); assert.equal(s.clock.timeFrozen, false);
    assert.equal(s.weather.dynamicEnabled, true); assert.deepEqual(s.weather.weather, s.originalWeather);
    assert.equal(s.calls.filter(c => c === "clock-start").length, 1);
    const next = enterTestZombieEnvironment(s.server); next.restore();
  });
}

test("restore tries both managers and broadcasts after a partial timer failure, then remains explicitly failed", () => {
  const s = fixture(), h = enterTestZombieEnvironment(s.server);
  s.worker.refresh = () => { s.calls.push("worker-refresh-failed"); throw Error("timer failed"); };
  assert.throws(h.restore, /restore_incomplete/);
  assert.equal(s.clock.time, 12345); assert.equal(s.clock.timeFrozen, false);
  assert.deepEqual(s.weather.weather, s.originalWeather);
  assert.equal(s.calls.slice(-2).join(","), "weather-send,time-send");
  const count = s.calls.length; assert.throws(h.restore, /restore_incomplete/); assert.equal(s.calls.length, count);
  assert.throws(() => enterTestZombieEnvironment(s.server), /restore_incomplete/);
});

test("manager or shared worker replacement is not overwritten by a stale restore handle", () => {
  for (const field of ["clock", "weather", "worker"]) {
    const s = fixture(), h = enterTestZombieEnvironment(s.server), before = s.calls.length;
    if (field === "clock") s.server.inGameTimeManager = { other: true };
    if (field === "weather") s.server.weatherManager = { other: true };
    if (field === "worker") s.weather.dynamicWorker = { refresh() { throw Error("foreign"); } } as any;
    assert.throws(h.restore, /owner_changed/); assert.equal(s.calls.length, before);
  }
});

test("a real expired Node timer is refreshed without replacement after disabled-weather return", async () => {
  const s = fixture(); let fired!: () => void, executed = 0;
  const observed = new Promise<void>(resolve => { fired = resolve; });
  const worker = setTimeout(() => { if (s.weather.dynamicEnabled) { executed++; fired(); } }, 5);
  s.weather.dynamicWorker = worker as any;
  const h = enterTestZombieEnvironment(s.server);
  try {
    await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(executed, 0);
    h.restore(); assert.equal(s.weather.dynamicWorker, worker);
    await Promise.race([observed, new Promise((_, reject) => setTimeout(() => reject(Error("refresh missing")), 500))]);
    assert.equal(executed, 1);
  } finally { clearTimeout(worker); }
});
