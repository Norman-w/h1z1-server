#!/usr/bin/env node
"use strict";

// Git-Bash diagnostic for the local DevHttpServerLite animal harness.  This
// deliberately exercises the production NPC classes through the HTTP API and
// emits one compact JSON document per production NPC recipe.  It is a probe,
// not a gameplay controller: all spawned entities are removed in finally.

const base = process.env.ZTEST_API ?? "http://127.0.0.1:13371";
const types = [
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
];
const sampleAtMs = [0, 250, 500, 1000, 1500, 2000, 3000, 4000, 5000, 6000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(pathname, init = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${pathname} returned non-JSON: ${text}`);
  }
  if (!response.ok) {
    throw new Error(`${pathname} ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function project(status, at) {
  const animal = status.animals?.[0];
  if (!animal) return { at, missing: true };
  return {
    at,
    state: animal.state,
    currentAnimation: animal.currentAnimation,
    activeAnimation: animal.animationRuntime?.activeAnimation ?? null,
    activeAnimationRemainingMs:
      animal.animationRuntime?.activeAnimationRemainingMs ?? null,
    expectedSpeed: animal.expectedSpeed,
    pendingExpectedSpeed: animal.pendingExpectedSpeed ?? null,
    pendingNativeSeekTargetId: animal.pendingNativeSeekTargetId ?? null,
    nativeGaitReady: animal.nativeGaitReady ?? null,
    authoritativeMovingSampleCount:
      animal.authoritativeMovingSampleCount ?? null,
    movementAuthority: animal.movementAuthority ?? null,
    wireSpeed: animal.wireMotion?.horizontalSpeed ?? null,
    wireVerticalSpeed: animal.wireMotion?.verticalSpeed ?? null,
    wireStance: animal.wireMotion?.stance ?? null,
    locomotionMode: animal.locomotionMode,
    combatAnimationMode: animal.combatAnimationMode,
    targetDistance2d: animal.targetDistance2d,
    targetDistance3d: animal.targetDistance3d,
    normalizedAttackPhase: animal.normalizedAttackPhase,
    contactWindowActive: animal.contactWindowActive,
    attackDamageApplied: animal.attackDamageApplied,
    attackEnvelopeWasActive: animal.attackEnvelopeWasActive,
    meleeInEnvelope: animal.meleeInEnvelope,
    navVelocity: animal.navVelocity,
    lastAnimationEvent: animal.lastAnimationEvent
  };
}

async function main() {
  await request("/api/god", {
    method: "POST",
    body: JSON.stringify({ enabled: true })
  });
  try {
    for (const type of types) {
      const spawned = await request("/api/animal-test", {
        method: "POST",
        body: JSON.stringify({ command: "flat", type, distance: 8, height: 0 })
      });
      const samples = [];
      let previousAt = 0;
      for (const at of sampleAtMs) {
        await sleep(at - previousAt);
        previousAt = at;
        samples.push(
          project(
            await request("/api/animal-test", {
              method: "POST",
              body: JSON.stringify({ command: "status" })
            }),
            at
          )
        );
      }
      console.log(JSON.stringify({ type, characterId: spawned.characterId, samples }));
    }
  } finally {
    await request("/api/animal-test", {
      method: "POST",
      body: JSON.stringify({ command: "stop" })
    }).catch((error) => {
      console.error(`cleanup failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
