import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Exercise the current AI source with fake timers and entity dependencies only.
// No out build, zone, process, sockets, live replay, or native client is started.
function sourceAi() {
  const filename = path.resolve("src/servers/ZoneServer2016/managers/aimanager.ts");
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true, fileName: filename
  });
  assert.deepEqual(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error), []);
  const module = { exports: {} };
  const dependencies: Record<string, unknown> = {
    "../../../utils/utils": { getDistance: (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) },
    "../../../utils/recast": { NavManager: class {} },
    "../entities/character": { Character2016: class {} },
    "../entities/explosiveentity": { ExplosiveEntity: class {} },
    "../entities/npc": { Npc: class {} },
    "../entities/trapentity": { TrapEntity: class {} },
    "../models/enums": { ModelIds: { ZOMBIE_FEMALE_WALKER: 1, ZOMBIE_MALE_WALKER: 2, ZOMBIE_SCREAMER: 3, BEAR: 4 } }
  };
  vm.runInNewContext(compiled.outputText, {
    module, exports: module.exports,
    require(name: string) {
      assert.ok(Object.prototype.hasOwnProperty.call(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    process: { env: {} }, console: { log() {}, error() {} },
    get Date() { return Date; }, get setTimeout() { return setTimeout; }
  }, { filename });
  return (module.exports as any).AiManager;
}

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 });
  const AiManager = sourceAi();
  let health = 10000;
  let bleeding = 0;
  const player = {
    characterId: "player", isAlive: true, isRespawning: false, godMode: true,
    state: { position: [0, 0, 0] }, getHealth: () => health,
    isGodMode() { return this.godMode; },
    // Model the observed legacy side effect, not a claimed native damage contract.
    OnMeleeHit: t.mock.fn(() => { bleeding += 20; if (!player.godMode) health -= 1000; })
  };
  const npc = {
    characterId: "zombie", actorModelId: 2, isAlive: true, behaviorState: 0,
    lastMeleeAttackTime: 0, testServerDrivenMovement: true, npcRenderDistance: 100,
    state: { position: [0, 0, 2] }, clearMovementController: t.mock.fn(),
    sendIdleStance: t.mock.fn(), sendLocomotionState: t.mock.fn(), sendAggroLevel: t.mock.fn(), setFacingToward: t.mock.fn(),
    triggerMeleeAttack: t.mock.fn(),
    getMeleeAttackProfile: () => ({
      itemDefinitionId: 83, weaponDefinitionId: 10, fireGroupId: 10, fireModeId: 13,
      range: 2.5, detectWidth: 1, detectHeight: 1,
      fireDurationMs: 850, refireTimeMs: 125
    }),
    applyDamage: t.mock.fn((id: string) => { assert.equal(id, "player"); player.OnMeleeHit(); })
  };
  const server = {
    getDevHttpPort: () => 13371, _lastSpawnedNpcCharacterId: "zombie",
    _testZombieChaseAttackCharacterId: "player", _npcs: { zombie: npc } as Record<string, typeof npc>
  };
  const ai = new AiManager(server);
  ai.playerEntities.add(player);
  const run = () => { ai.now = Date.now(); ai.runOneNpc(npc, false, {}); };
  return { ai, server, npc, player, run, bleeding: () => bleeding };
}

test("protected native-test melee keeps attack animation/cooldown but never enters hit side effects", t => {
  const s = setup(t);
  s.run();
  assert.equal(s.npc.triggerMeleeAttack.mock.callCount(), 1);
  assert.equal(s.npc.lastMeleeAttackTime, 10000);
  t.mock.timers.tick(450);
  assert.equal(s.npc.applyDamage.mock.callCount(), 0);
  assert.equal(s.player.OnMeleeHit.mock.callCount(), 0);
  assert.equal(s.bleeding(), 0);
  assert.equal(s.player.getHealth(), 10000);
  t.mock.timers.tick(1049); s.run();
  assert.equal(s.npc.triggerMeleeAttack.mock.callCount(), 1);
  t.mock.timers.tick(1); s.run();
  assert.equal(s.npc.triggerMeleeAttack.mock.callCount(), 2);
  assert.equal(s.npc.lastMeleeAttackTime, 11500);
  t.mock.timers.tick(450);
  assert.equal(s.player.OnMeleeHit.mock.callCount(), 0);
});

test("unprotected native-test melee still enters the existing hit path", t => {
  const s = setup(t); s.player.godMode = false;
  s.run(); t.mock.timers.tick(450);
  assert.equal(s.npc.applyDamage.mock.callCount(), 1);
  assert.equal(s.player.OnMeleeHit.mock.callCount(), 1);
  assert.equal(s.bleeding(), 20);
  assert.equal(s.player.getHealth(), 9000);
});

for (const enabledAtHit of [true, false]) {
  test(`native-test protection is checked at hit time: godMode=${enabledAtHit}`, t => {
    const s = setup(t); s.player.godMode = !enabledAtHit;
    s.run(); t.mock.timers.tick(449); s.player.godMode = enabledAtHit;
    t.mock.timers.tick(1);
    assert.equal(s.npc.triggerMeleeAttack.mock.callCount(), 1);
    assert.equal(s.player.OnMeleeHit.mock.callCount(), enabledAtHit ? 0 : 1);
  });
}

test("protection does not change non-server-driven NPC hit behavior", t => {
  const s = setup(t); s.npc.testServerDrivenMovement = false;
  s.run(); t.mock.timers.tick(450);
  assert.equal(s.player.OnMeleeHit.mock.callCount(), 1);
});

test("protection does not change non-test NPC hit behavior", t => {
  const s = setup(t); s.server._testZombieChaseAttackCharacterId = "";
  s.server.getDevHttpPort = () => 0;
  s.run(); t.mock.timers.tick(450);
  assert.equal(s.npc.triggerMeleeAttack.mock.callCount(), 1);
  assert.equal(s.player.OnMeleeHit.mock.callCount(), 1);
});

for (const replacement of [false, true]) {
  test(`cleanup registry identity still cancels a pending hit: replacement=${replacement}`, t => {
    const s = setup(t); s.run();
    if (replacement) s.server._npcs.zombie = { ...s.npc };
    else delete s.server._npcs.zombie;
    s.player.godMode = false;
    t.mock.timers.tick(450);
    assert.equal(s.player.OnMeleeHit.mock.callCount(), 0);
    assert.equal(s.bleeding(), 0);
  });
}
