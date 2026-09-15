import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { GeometryBounds, StaticTriangleScene, TriangleMesh, transformActorLocalMesh, visitZonePlacementsV4 } from "../../utils/forgelightGeometry";
import { createStaticActorResolver } from "../../utils/forgelightStaticAssets";
import { ForgelightNavigation } from "../../utils/forgelightNavigation";
import { createForgelightKnownObstacleRoute, ForgelightKnownObstacleRouteOptions } from "../../utils/forgelightKnownObstacleRoute";
import type { ForgelightTerrainFollowBinding } from "../../utils/forgelightTerrainFollow";

const ACTOR = "Common_Props_Fences_WoodPlanksGreyPosts1x2.adr";
const COLLISION = "Common_Props_Fences_WoodPlanksGreyPosts1x2.cdt";
const ID = "192060:0:" + ACTOR;
const BOUNDS: GeometryBounds = { min: [184, 20, -927], max: [192, 27, -916] };
const PINS: Readonly<Record<string, string>> = {
  "Z1.zone": "7382b92d38374f05a64d47a3837ca18dac3315249b327fd609d797827deac08d",
  [ACTOR]: "21610d278e3a052bd281f6f6a888a19053f3db00065cc2f00277cc7da9398aa8",
  [COLLISION]: "7a1fe152264744b9a7320ff1c7f02d60b2704a711066d89c1b232b7701835223"
};

/** Stable encounter owner; all pre-start calibrations use this same NAV. */
export function createCalibratedTestZombieKnownFence(
  navigation: ForgelightKnownObstacleRouteOptions["navigation"]
) {
  const scene = navigation.scene, destroy = navigation.destroy.bind(navigation);
  let binding: ReturnType<typeof createForgelightKnownObstacleRoute> | undefined;
  let disposed = false, queried = false;
  const scope = Object.freeze({ mode: "only-known-obstacles", knownObstacleIds: Object.freeze([ID]),
    otherCollisionCoverage: "unknown", entityRadius: 0.3,
    meaning: "One fixed modeled fence only; experimental radius/probe heights, not native capsule or world coverage" });
  return {
    scope,
    calibrate(terrain: ForgelightTerrainFollowBinding): void {
      if (disposed || queried) throw Error("Known-fence calibration is closed");
      // Never retain a previous calibrated route after a failed fresh attempt.
      binding?.dispose(); binding = undefined;
      if (!Number.isFinite(terrain?.npcOriginHeight) || Math.abs(terrain.npcOriginHeight) > 0.15)
        throw Error("Known-fence grounded origin not established");
      binding = createForgelightKnownObstacleRoute({ navigation, terrain, scene, bounds: BOUNDS,
        knownObstacleIds: [ID], scopeLabel: "Fixed fence 192060 only; all other collision unknown",
        npcOriginHeight: terrain.npcOriginHeight, targetOriginHeight: terrain.npcOriginHeight,
        contactHeight: 1, routeProbeHeights: [0.3, 1, 1.6], entityRadius: 0.3,
        maxPathPoints: 128, maxPathLength: 50, navigationOwnership: "caller" });
    },
    testRouteStep(from: Float32Array, target: Float32Array, budget: number): Float32Array | undefined {
      if (disposed || !binding) return undefined;
      queried = true;
      return binding.testRouteStep(from, target, budget);
    },
    testMeleeReachability(from: Float32Array, target: Float32Array): boolean {
      if (disposed || !binding) return false;
      queried = true;
      return binding.testMeleeReachability(from, target);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try { binding?.dispose(); }
      finally { destroy(); }
    }
  };
}
export type TestZombieKnownFenceResource = ReturnType<typeof createCalibratedTestZombieKnownFence>;

async function readPinned(root: string, name: string): Promise<Buffer> {
  const file = await realpath(resolve(root, name)), child = relative(root, file);
  if (!child || child.startsWith("..") || isAbsolute(child)) throw Error("Known-fence asset escapes root");
  const limit = name === "Z1.zone" ? 256 * 1024 * 1024 : 1024 * 1024;
  const info = await stat(file);
  if (!info.isFile() || info.size <= 0 || info.size > limit) throw Error("Known-fence asset size bound");
  const bytes = await readFile(file);
  if (bytes.length > limit || createHash("sha256").update(bytes).digest("hex") !== PINS[name])
    throw Error("Known-fence asset identity mismatch");
  return bytes;
}

/** Loads only the fixed audited resource recipe; never a general world-coverage loader. */
export async function prepareTestZombieKnownFence(options: {
  assetRoot: string; terrain: TriangleMesh[]; standingPlayerPosition: Float32Array;
  spawnXZ: readonly [number, number];
}): Promise<TestZombieKnownFenceResource> {
  const p = options.standingPlayerPosition, s = options.spawnXZ;
  if (!p || p.length < 3 || !Array.from(p).every(Number.isFinite) || !s || s.length !== 2 ||
      !s.every(Number.isFinite) || Math.hypot(p[0] - 189, p[2] + 925.219970703125) > 0.3 ||
      Math.hypot(s[0] - 189, s[1] + 919.219970703125) > 0.3 || options.terrain.length !== 1)
    throw Error("Known-fence requires its fixed +Z6 scene and single terrain chunk");
  const root = await realpath(options.assetRoot);
  const bytes = new Map(await Promise.all(Object.keys(PINS).map(async name => [name, await readPinned(root, name)] as const)));
  let index = 0, placement: Parameters<Parameters<typeof visitZonePlacementsV4>[1]>[0] | undefined;
  visitZonePlacementsV4(bytes.get("Z1.zone")!, entry => { if (index++ === 192060) placement = entry; });
  if (!placement || placement.actor !== ACTOR) throw Error("Known-fence placement identity mismatch");
  const resource = createStaticActorResolver(name => {
    const content = bytes.get(name);
    if (!content) throw Error("Unexpected known-fence asset reference");
    return content;
  })(ACTOR);
  if (resource.kind !== "independent-static" || resource.meshes.length !== 1)
    throw Error("Known-fence static resource shape mismatch");
  const mesh = transformActorLocalMesh(resource.meshes[0], placement, resource.assetScale);
  if (mesh.indices.length !== 72) throw Error("Known-fence triangle identity mismatch");
  const scene = new StaticTriangleScene([{ id: ID, mesh }]);
  const navigation = await ForgelightNavigation.build(options.terrain[0], scene, BOUNDS);
  try { return createCalibratedTestZombieKnownFence(navigation); }
  catch (error) { navigation.destroy(); throw error; }
}
