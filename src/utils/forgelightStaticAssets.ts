import { XMLParser, XMLValidator } from "fast-xml-parser";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  decodeCollisionTriangles,
  StaticActorGeometry
} from "./forgelightGeometry";

type StaticDefinition =
  | {
      kind: "static";
      collisionFile: string;
      assetScale: number;
      collisionType: number;
    }
  | { kind: "unsupported"; reason: string };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  processEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true
});

/** Native 140734b10/ca0: absence preserves default, otherwise first character. */
function nativeFlag(value: unknown): boolean {
  return typeof value === "string" && /^[1tT]/.test(value);
}

function assetName(name: string, extension: string): boolean {
  return (
    name.length <= 240 &&
    !name.includes("..") &&
    /^[A-Za-z0-9_ .-]+$/.test(name) &&
    name.toLowerCase().endsWith(extension)
  );
}

/**
 * Conservative INITIAL static-obstacle policy, not a native physics/LOS mask.
 * Props and structures use ordinary direct-CDT creation despite differing
 * filter bits. Parented actors, changed doors/destructibles, terrain and actors
 * spawned from placers still require separate coverage/state management.
 */
export function parseStaticActorDefinition(xml: string): StaticDefinition {
  if (Buffer.byteLength(xml, "utf8") > 1024 * 1024)
    throw new Error("ADR exceeds 1 MiB limit");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("ADR DTD/entities are forbidden");
  if (XMLValidator.validate(xml) !== true) throw new Error("Malformed ADR XML");
  const document = parser.parse(xml);
  const root = document.ActorRuntime;
  if (
    !root ||
    typeof root !== "object" ||
    Array.isArray(root) ||
    Object.keys(document).length !== 1
  )
    throw new Error("ADR must have exactly one ActorRuntime root");
  const node = (name: string): Record<string, unknown> | undefined => {
    const value = root[name];
    if (Array.isArray(value)) throw new Error(`Duplicate ADR ${name}`);
    if (value === undefined || (typeof value === "string" && !value.trim()))
      return undefined;
    if (typeof value !== "object" || value === null)
      throw new Error(`Invalid ADR ${name}`);
    return value;
  };
  const unsupported = (reason: string): StaticDefinition => ({
    kind: "unsupported",
    reason
  });
  // Even an empty Skeleton element is distinct from an absent one: native
  // missing scale inside a present Skeleton can write zero, not default one.
  if (Object.prototype.hasOwnProperty.call(root, "Skeleton"))
    return unsupported("skeleton requires separate geometry/pose handling");
  const animation = node("AnimationNetwork");
  if (animation?.["@fileName"]) return unsupported("animated actor");
  const invisible = node("Invisible");
  if (invisible?.["@value"] !== "0")
    return unsupported("visibility/placer classification not established");
  const usage = node("Usage");
  if (nativeFlag(usage?.["@borrowSkeleton"]))
    return unsupported("borrowed skeleton requires parent pose");
  if (usage?.["@actorUsage"] !== "0")
    return unsupported("actor usage not established as static candidate");
  for (const name of [
    "ChildAttachSlotsEx",
    "ChildAttachSlots",
    "Parent",
    "ActorGroup"
  ]) {
    if (node(name))
      return unsupported("attachment/group requires resolved parent state");
  }
  const collision = node("CollisionData");
  if (!collision?.["@fileName"]) return unsupported("no direct collision data");
  const collisionFile = collision["@fileName"];
  if (typeof collisionFile !== "string" || !assetName(collisionFile, ".cdt"))
    return unsupported("collision data is not a safe direct CDT filename");
  const allowedAttributes = new Set([
    "@fileName",
    "@simpleCollisionFileName",
    "@createAsKinematic",
    "@useBoundingBox"
  ]);
  if (Object.keys(collision).some((key) => !allowedAttributes.has(key)))
    return unsupported("unrecognized CollisionData fields");
  if (collision["@simpleCollisionFileName"])
    return unsupported("alternate simple collision needs query selection");
  if (nativeFlag(collision["@createAsKinematic"]))
    return unsupported("kinematic collision");
  if (nativeFlag(collision["@useBoundingBox"]))
    return unsupported("bounding-box collision override");
  const typeText = node("CollisionType")?.["@type"];
  if (typeof typeText !== "string" || !/^\d+$/.test(typeText))
    return unsupported("missing or invalid collision type");
  const collisionType = Number(typeText);
  if (collisionType !== 0xf58be1cc && collisionType !== 0xedc05f26)
    return unsupported(
      "collision type not audited for initial static obstacles"
    );
  return { kind: "static", collisionFile, assetScale: 1, collisionType };
}

/** Keep XML/path handling outside the geometry loader; never fetch URLs. */
export function createStaticActorResolver(
  readAsset: (name: string) => Buffer
): (actor: string) => StaticActorGeometry {
  const cache = new Map<string, StaticActorGeometry>();
  return (actor) => {
    const prior = cache.get(actor);
    if (prior) return prior;
    let result: StaticActorGeometry;
    if (!assetName(actor, ".adr")) {
      result = {
        kind: "unsupported",
        reason: "not a safe standalone ADR name"
      };
    } else {
      try {
        const definition = parseStaticActorDefinition(
          readAsset(actor).toString("utf8")
        );
        if (definition.kind === "unsupported") result = definition;
        else {
          const meshes = decodeCollisionTriangles(
            readAsset(definition.collisionFile)
          );
          if (!meshes.some((mesh) => mesh.indices.length))
            throw new Error("Empty static collision mesh");
          result = {
            kind: "independent-static",
            assetScale: definition.assetScale,
            meshes
          };
        }
      } catch (error) {
        // Missing resources are explicit unknown coverage. Corrupt input or I/O
        // failures must abort scene publication, not quietly become free space.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        result = {
          kind: "unsupported",
          reason: "missing local ADR/CDT resource"
        };
      }
    }
    cache.set(actor, result);
    return result;
  };
}

export function createFileStaticActorResolver(
  assetRoot: string
): (actor: string) => StaticActorGeometry {
  const root = realpathSync(assetRoot);
  return createStaticActorResolver((name) => {
    // Name validation occurs before this callback, including for referenced CDT.
    const path = realpathSync(resolve(root, name));
    const child = relative(root, path);
    if (!child || child.startsWith("..") || isAbsolute(child))
      throw new Error("Asset path escapes root");
    const limit = name.toLowerCase().endsWith(".adr")
      ? 1024 * 1024
      : 64 * 1024 * 1024;
    if (statSync(path).size > limit)
      throw new Error("Static asset exceeds size limit");
    const bytes = readFileSync(path);
    if (bytes.length > limit)
      throw new Error("Static asset grew beyond size limit");
    return bytes;
  });
}
