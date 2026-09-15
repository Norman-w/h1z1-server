import type { ZoneServer2016 } from "./zoneserver";

type EnvironmentHandle = { restore(): void };
type Entry = { handle: EnvironmentHandle; failure?: Error };
const active = new WeakMap<ZoneServer2016, Entry>();
const TEMPLATE = "h1emubaseweather";

/** Solo-server illumination updates only; no position, asset or config overrides from callers. */
export function enterTestZombieEnvironment(server: ZoneServer2016): EnvironmentHandle {
  if (server?._soloMode !== true) throw new Error("ztest_environment_requires_solo");
  const prior = active.get(server);
  if (prior?.failure) throw prior.failure;
  if (prior) return prior.handle;
  const clock = server.inGameTimeManager, weather = server.weatherManager;
  const worker = weather?.dynamicWorker;
  if (!clock || !weather || typeof clock.stop !== "function" || typeof clock.start !== "function" ||
      typeof server.sendGameTimeSync !== "function" || typeof weather.sendUpdateToAll !== "function" ||
      typeof clock.timeFrozen !== "boolean" || typeof clock.timeFrozenByConfig !== "boolean" ||
      typeof weather.dynamicEnabled !== "boolean" ||
      !Number.isFinite(clock.time) || clock.time < 0 || clock.time >= 86400 ||
      ![clock.baseTimeMultiplier, clock.nightTimeMultiplier, clock.nightTimeMultiplierValue].every(v => Number.isFinite(v) && v > 0) ||
      (!clock.timeFrozen && clock.timeFrozenByConfig) ||
      (weather.dynamicEnabled && typeof worker?.refresh !== "function"))
    throw new Error("ztest_environment_state_unknown");
  const cloneWeather = <T extends object>(value: T): T => {
    if (!value || Object.values(value).some(v => typeof v !== "string" && (typeof v !== "number" || !Number.isFinite(v))))
      throw new Error("ztest_weather_snapshot_invalid");
    return JSON.parse(JSON.stringify(value));
  };
  const clear = cloneWeather(weather.templates[TEMPLATE]);
  // Existing shipped preset: dry, low fog and ordinary daylight axes. Do not
  // silently accept a runtime-mutated rainy/night preset under the same name.
  if (clear.templateName !== TEMPLATE || clear.globalPrecipitation !== 0 || clear.rainMinStrength !== 0 ||
      clear.fogDensity !== 0.000235 || clear.skyClarity !== 0.2 || clear.overcast !== 25 ||
      clear.sunAxisX !== 38 || clear.sunAxisY !== 15 || clear.sunAxisZ !== 0)
    throw new Error("ztest_clear_weather_template_changed");
  const saved = {
    time: clock.time, frozen: clock.timeFrozen, frozenByConfig: clock.timeFrozenByConfig,
    multiplier: clock.baseTimeMultiplier, nightMultiplier: clock.nightTimeMultiplier,
    nightMultiplierValue: clock.nightTimeMultiplierValue,
    weather: cloneWeather(weather.weather), dynamic: weather.dynamicEnabled
  };
  let completed = false;
  const entry: Entry = { handle: { restore } };
  const sendTime = () => { for (const client of Object.values(server._clients)) server.sendGameTimeSync(client); };
  function restore(): void {
    if (entry.failure) throw entry.failure;
    if (completed) return;
    completed = true; // Never double-start timers after a partial exception.
    const errors: unknown[] = [];
    const attempt = (action: () => void) => { try { action(); } catch (e) { errors.push(e); } };
    if (server.inGameTimeManager !== clock || server.weatherManager !== weather || weather.dynamicWorker !== worker) {
      entry.failure = new Error("ztest_environment_owner_changed_restore_refused");
      throw entry.failure;
    }
    attempt(() => { weather.dynamicEnabled = false; });
    attempt(() => clock.stop());
    attempt(() => {
      clock.time = saved.time;
      clock.baseTimeMultiplier = saved.multiplier;
      clock.nightTimeMultiplier = saved.nightMultiplier;
      clock.nightTimeMultiplierValue = saved.nightMultiplierValue;
      clock.timeFrozenByConfig = saved.frozenByConfig;
      // stop() deliberately resets lastIngameTimeUpdate. Reusing the old anchor
      // would count the test's frozen duration as a catch-up game-time jump.
      if (!saved.frozen) clock.start();
    });
    attempt(() => { weather.weather = cloneWeather(saved.weather); });
    attempt(() => {
      weather.dynamicEnabled = saved.dynamic;
      // A disabled worker can fire and return without rescheduling. Refresh the
      // SAME timer once; do not destroy it or create a duplicate shared worker.
      if (saved.dynamic) worker.refresh();
    });
    attempt(() => weather.sendUpdateToAll(server));
    attempt(sendTime);
    if (errors.length) {
      entry.failure = new AggregateError(errors, "ztest_environment_restore_incomplete");
      throw entry.failure;
    }
    active.delete(server);
  }
  active.set(server, entry);
  try {
    weather.dynamicEnabled = false;
    clock.stop();
    if (clock.timeFrozen !== true) throw new Error("ztest_clock_stop_failed");
    clock.time = 12 * 3600;
    weather.weather = clear; // Owned clone, never mutate templates or the prior weather object.
    weather.sendUpdateToAll(server);
    sendTime();
    return entry.handle;
  } catch (error) {
    try { restore(); }
    catch (rollback) { throw new AggregateError([error, rollback], "ztest_environment_setup_and_restore_failed"); }
    throw error;
  }
}
