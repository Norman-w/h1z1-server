import type { ZombieTestScene } from "./test-zombie-scenario";

// Fixed experimental scenes, not certified static-collision clearance.
// Terrain evidence: tools/task-01a06a01/fixed-scenes-candidate-20260909.json.
// +Z12 path: face slope 10.10–15.05 degrees, existing terrain route 59 steps.
// Grounded inbound position must recalibrate Y before a replay may start.
export const ZOMBIE_TEST_SCENES: Readonly<Record<string, ZombieTestScene>> = {
  // Separate bounded search: flat-chunk-candidate-20260909.json.
  // Approximate flat reference, NOT a mathematically horizontal plane.
  flat: {
    position: [1492, 46.50728988647461, -648, 1],
    description: "Low-slope reference (0-1.79 deg, not perfectly flat; static clearance unverified)"
  },
  // A/B route: same fixed low-slope placement, but only the native client
  // seek rail is armed; Npc.goTo suppresses its PlayerUpdatePosition stream.
  seek: {
    position: [1492, 46.50728988647461, -648, 1],
    distance: 12,
    movementMode: "client-seek",
    description: "Client-seek-only A/B on low-slope reference (server position stream suppressed)"
  },
  mixed: {
    position: [1492, 46.50728988647461, -648, 1],
    distance: 12,
    movementMode: "mixed",
    description: "Production-style mixed SeekTarget + PlayerUpdatePosition A/B (diagnostic only)"
  },
  slope: {
    position: [1336, 42.929283142089844, -703.739990234375, 1],
    description: "Slope candidate (terrain face 10-15 deg; static clearance unverified)"
  },
  // known-fence-candidate-20260909.json and radius-screened replay evidence.
  // Only placement 192060's named CDT mesh is supplied; other collision UNKNOWN.
  fence: {
    position: [189, 22.012500762939453, -925.219970703125, 1],
    distance: 6,
    knownObstacle: "fence-192060",
    description: "Fence 192060: west-end detour and across/same-side melee (only named fence; other collision unknown)"
  }
};
