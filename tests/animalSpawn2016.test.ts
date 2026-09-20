import assert from "node:assert/strict";
import test from "node:test";
import { LootSpawnWorker } from "../out/servers/ZoneServer2016/managers/lootspawnworker";
import { ModelIds } from "../out/servers/ZoneServer2016/models/enums";

test("rabbit spawn chance is independent from the generic NPC chance", async () => {
  const worker = new LootSpawnWorker({ groundTables: {}, containerTables: {} });
  try {
    const plan = await worker.createNpcPlan([], 2, 0, 100, 0, 0, 0, 1000);

    assert.ok(plan.length > 0, "rabbit spawners should honor chanceRabbit");
    assert.ok(plan.every((entry) => entry.modelId === ModelIds.RABBIT));
  } finally {
    await worker.stop();
  }
});
