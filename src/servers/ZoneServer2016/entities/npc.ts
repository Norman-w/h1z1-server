// ======================================================================
//
//   GNU GENERAL PUBLIC LICENSE
//   Version 3, 29 June 2007
//   copyright (C) 2020 - 2021 Quentin Gruber
//   copyright (C) 2021 - 2026 H1emu community
//
//   https://github.com/QuentinGruber/h1z1-server
//   https://www.npmjs.com/package/h1z1-server
//
//   Based on https://github.com/psemu/soe-network
// ======================================================================

import { DamageInfo } from "types/zoneserver";
import { ZoneServer2016 } from "../zoneserver";
import { BaseFullCharacter } from "./basefullcharacter";
import { ZoneClient2016 } from "../classes/zoneclient";
import {
  calculateNpcMotionSpeeds,
  createNpcPositionUpdate,
  eul2quat,
  getCurrentServerTimeWrapper,
  getDistance,
  getDistanceSquared,
  logClientActionToMongo,
  quat2heading
} from "../../../utils/utils";
import type {
  NpcMotionSample,
  NpcPositionUpdateMotion
} from "../../../utils/utils";
import { DB_COLLECTIONS, KILL_TYPE } from "../../../utils/enums";
import {
  Effects,
  Items,
  MeleeTypes,
  NpcIds,
  PositionUpdateType,
  ResourceIds,
  ResourceTypes
} from "../models/enums";
import { CommandInteractionString } from "types/zone2016packets";
import type {
  CharacterClearMovementRail,
  CharacterAggroLevel,
  CharacterExpectedSpeed,
  CharacterPlayAnimation,
  CharacterSetLookAt,
  CharacterSeekTarget,
  CharacterSeekTargetUpdate,
  CharacterUpdateCharacterState
} from "types/zone2016packets";
import { BaseEntity } from "./baseentity";
import { ChallengeType } from "../managers/challengemanager";
import { ProjectileEntity } from "./projectileentity";
import { JSM } from "../jsms/jsm";
import { Factions } from "../jsms/factions";
import { spawnGasCloudAt } from "../jsms/gasser.jsm";

/**
 * The retail hit-reaction writer quantizes the relative attacker heading into
 * four sectors before it raises the public `Flinch` event.  NPCs use the same
 * Zombie001/compatibility graph as players; omitting this graph input leaves a
 * hit with no directional leaf (or makes every hit use the same pose).
 */
const NATIVE_FLINCH_DIRECTION_DEGREES_PER_RADIAN = 180 / Math.PI;
const NATIVE_FLINCH_DIRECTION_OFFSET_DEGREES = 135;
const NATIVE_FLINCH_DIRECTION_SECTOR_DEGREES = 90;
const NATIVE_FLINCH_DIRECTION_SECTOR_COUNT = 4;
const NATIVE_FLINCH_DIRECTION_SECTOR_SCALE =
  -1 / NATIVE_FLINCH_DIRECTION_SECTOR_DEGREES;

/**
 * The authoritative melee envelope for an NPC's configured strike item.
 * Keeping this data-shaped lets AI consume the same RANGE/MELEE_DETECT
 * values as the player combat path instead of maintaining guessed distances.
 */
export interface NpcMeleeAttackProfile {
  itemDefinitionId: number;
  weaponDefinitionId: number;
  fireGroupId: number;
  fireModeId: number;
  range: number;
  detectWidth: number;
  detectHeight: number;
  fireDurationMs: number;
  /** Optional when the fire-mode animation clock equals fireDurationMs. */
  fireAnimDurationMs?: number;
  refireTimeMs: number;
}

/**
 * Provenance of the numbers returned by getMeleeAttackProfile().
 *
 * Animal actors currently do not have a checked-in animal weapon/fire-mode
 * definition.  They retain the Machete table only as a compatibility path so
 * the old test harness can still exercise a strike.  Keeping that fact next
 * to the profile prevents a table-shaped object from being mistaken for an
 * authoritative animal hit shape.
 */
export type NpcMeleeProfileSource =
  | "server-weapon-table"
  | "compatibility-proxy";

/**
 * Capability of the native animal combat branch.
 *
 * `nativeMeleeAnimationSource` is also retained on passive animals because
 * their client graph owns the hit-reaction clip.  It must therefore never be
 * used as an implicit attack capability: a Deer/Rabbit can be hit without
 * being allowed to enter the predator melee envelope.
 */
export type NpcNativeMeleeCapability = "none" | "attacker" | "passive";

export type NpcMeleeEnvelopeSource =
  | "server-weapon-table"
  | "compatibility-proxy"
  | "animal-engagement-projection"
  | "not-applicable"
  | "unavailable";

export interface NpcAnimationVerification {
  /** Public graph event name sent by the server, when one is used. */
  eventName: string | null;
  /** Native clip duration/play-speed mapping has not been live verified. */
  clockVerified: boolean;
  /** Native SwingContact -> damage acknowledgement has not been verified. */
  contactEventVerified: boolean;
  /** Native actor root motion has not been accepted as the position source. */
  rootMotionVerified: boolean;
}

/**
 * Runtime animation handoff exposed to the local animal test harness.
 *
 * `currentAnimation` is intentionally empty while a one-shot owns the graph,
 * so reporting only that field makes an active KnifeSlash/Flinch look like an
 * animation drop.  Keep the in-flight clip and its remaining native clock
 * explicit; this is diagnostics only and does not change the wire contract.
 */
export interface NpcAnimationRuntimeState {
  persistentAnimation: string | null;
  activeAnimation: string | null;
  activeAnimationRemainingMs: number | null;
  lastAnimationEvent: string | null;
}

/**
 * Authority/provenance contract for a native animal contact signal.
 *
 * The client graph contains `SwingContact`, but the server currently has no
 * recovered animal weapon shape to evaluate against it.  Keeping these
 * authorities separate prevents the AI engagement projection from being
 * reported as a native hitbox or a client acknowledgement.
 */
export interface NpcNativeContactContract {
  /** Native graph signal that brackets the species attack clip. */
  signal: "AnimalsPhysics.SwingContact" | null;
  /** Which side currently owns the signal. */
  clientAuthority: "client-local-graph" | "unavailable";
  /** Which side currently authorizes server-side damage. */
  serverDamageAuthority: "server-projection" | "server-weapon-table" | "unavailable";
  /**
   * Geometry used by the server-side gate, if one is authoritative.
   *
   * `native-client-shape-query-unavailable` is intentionally distinct from
   * `unrecovered`: static analysis has now shown that the retail animal path
   * does have a collision-component/pose query, but that query still runs in
   * the client and is not available to the server-side projection.
   */
  geometrySource:
    | "native-client-shape-query-unavailable"
    | "unrecovered"
    | "server-weapon-table"
    | "unavailable";
  /** True only after a live client capture proves the complete chain. */
  liveVerified: boolean;
}

/**
 * Normalized contact window exported by an actor's native animation graph.
 *
 * AnimalsPhysics stores SwingContact as a normalized interval on each
 * species' attack clip.  The server does not yet have the clip's absolute
 * clock, so callers scale this interval by the configured attack duration
 * instead of inventing a global millisecond offset.
 */
export interface NpcMeleeContactWindow {
  startFraction: number;
  endFraction: number;
}

/**
 * Conservative overlap of the ordinary Zombie001 SwingContact tracks.
 *
 * The loaded zombie graph selects its walker/runner attack leaf on the
 * client.  Static resource bindings currently recover ordinary contact
 * starts at 0.27999899 (runner) and 0.38666701 (walker/slow bite), with the
 * corresponding end points at 0.72000101 and 0.61333299.  Until the server
 * can observe the selected leaf, using the intersection keeps a server-side
 * projection fail-closed: it cannot authorize a hit before either recovered
 * leaf is in its contact phase.  This is deliberately a graph contract, not
 * a species-specific range/timing tweak.
 */
export const ZOMBIE_NATIVE_MELEE_CONTACT_WINDOW: NpcMeleeContactWindow =
  Object.freeze({
    startFraction: 0.386667,
    endFraction: 0.613333
  });

/** Last locomotion tuple emitted on the 2016 PlayerUpdatePosition wire path. */
export interface NpcWireMotionTelemetry {
  sequenceTime: number;
  stance: number;
  horizontalSpeed: number;
  verticalSpeed: number;
  orientation: number;
}

/**
 * The authored locomotion input domain recovered from AnimalsPhysicsX64.mrn.
 *
 * `BlendN1` is driven by `ControlParameters|VelocityLocalZ`; it contains a
 * continuous blend with the listed authored points rather than a server-side
 * walk/run enum.  The points are intentionally exposed as readonly data so
 * the AI can keep a continuous target (for example 3.75 or 6.5) while the
 * wire adapter can still reject an impossible value above the native graph's
 * upper bound.
 */
export interface NpcNativeLocomotionProfile {
  source: string;
  inputParameter: "VelocityLocalZ";
  minimumMovingSpeed: number;
  maximumSpeed: number;
  authoredSpeedBands: readonly number[];
}

/**
 * Authority for the visible NPC transform.
 *
 * The retail `Character.SeekTarget` packet installs a native controller; it
 * is not a passive animation hint.  A live probe showed that the client can
 * advance that controller between server `PlayerUpdatePosition` samples, so
 * sending both streams for the same actor creates two movers and makes the
 * feet/attack pose disagree with the replicated body.  Production NPCs are
 * therefore server-position authoritative until a complete native root-motion
 * and reconciliation contract is proven.  The native mode remains an
 * explicit opt-in for bounded experiments only.
 */
export type NpcMovementAuthority = "server-position" | "native-root-motion";

export const ANIMAL_NATIVE_LOCOMOTION_PROFILE: NpcNativeLocomotionProfile =
  Object.freeze({
    source: "AnimalsPhysicsX64.mrn:Idle_Locomotion|Locomotion|BlendN1",
    inputParameter: "VelocityLocalZ" as const,
    minimumMovingSpeed: 0.689,
    maximumSpeed: 8,
    authoredSpeedBands: Object.freeze([
      0.689, 1, 1.442, 2, 3, 4, 5, 6, 7, 8
    ])
  });

/**
 * Source-clip clocks recovered from the Zombie001 physics resource.
 *
 * These are graph action names, not weapon timings.  The old implementation
 * silently gave every unlisted action the 1430 ms compatibility clock.  That
 * made a StumbleA (4.066 s), CoverEars (4.667 s), or EatingDone (2.933 s)
 * hand the actor back to locomotion while the client was still rendering the
 * authored clip.  Keep the catalog shared by every zombie-derived entity so
 * the FSMs cannot drift by species.
 *
 * The values are rounded to the 30 FPS source frame boundary and are only
 * used for the wire action clock.  Events whose graph transition has no
 * unambiguous source clip intentionally remain on the compatibility fallback
 * below until the selector is recovered.
 */
export const ZOMBIE_NATIVE_ACTION_DURATION_MS: Readonly<
  Record<string, number>
> = Object.freeze({
  EatingDone: 2933,
  StumbleA: 4067,
  StumbleB: 2667,
  StumbleC: 2933,
  GrappleTell: 667,
  Spit: 2000,
  CoverEars: 4667,
  ExplodeContract: 3000,
  ExplodeExpand: 1000,
  PushbackNorthMedium: 1633,
  PushbackEastMedium: 2167,
  PushbackWestMedium: 2200,
  PushbackSouthMedium: 2167,
  BlowbackNorth: 2000,
  FallOverFence: 2000,
  /**
   * These public events are selected by the Zombie001 graph for the
   * corresponding resource clips.  They used to fall through to the generic
   * 1430 ms compatibility clock, which is shorter than the authored turn,
   * grapple, and lost-target clips.  That lets the FSM publish sprint/Idle
   * while the client is still rendering the recovery pose.  The values below
   * are the 30 FPS durations recovered from zombie-animation-mrn.json; where
   * both model variants expose the same clip length the public event is
   * unambiguous.  Variant-dependent 45-degree turns remain on the fallback
   * until the selector is recovered instead of choosing one model's timing.
   */
  TurnLeft90: 2333,
  TurnRight90: 2333,
  TurnLeft180: 2500,
  TurnRight180: 2500,
  LostTarget: 6000,
  Spawn: 5500,
  SpawnFromGround: 5500
});

/**
 * Scalar graph input consumed by the AnimalsPhysics attack speed modifiers.
 *
 * `Character.PlayAnimation` can carry one named scalar graph parameter in its
 * `animationType`/`unknownDword3` pair.  The animal MRN spells this input
 * `ControlParameters|NPC_AttackSpeed`; the retail writer supplies `1.0` when
 * the attack branch is entered.  Keep the value beside the event boundary so
 * it cannot be confused with the unrelated zombie-only `AttackRegion` input.
 */
const NATIVE_ANIMAL_ATTACK_SPEED_PARAMETER = "NPC_AttackSpeed";
const NATIVE_ANIMAL_ATTACK_SPEED = 1;

function createNpcMeleeDamageInfo(npc: {
  characterId: string;
  meleeWeaponItemDefinitionId: Items;
  npcMeleeDamage: number;
  state: { position: Float32Array };
}): DamageInfo {
  return {
    entity: npc.characterId,
    weapon: npc.meleeWeaponItemDefinitionId,
    damage: npc.npcMeleeDamage,
    causeBleed: false,
    meleeType: MeleeTypes.BLADE,
    hitReport: {
      sessionProjectileCount: 0,
      // This is the source GUID.  Putting the victim GUID here makes the PvE
      // guard in Character.damage() classify the hit as player self-damage.
      characterId: npc.characterId,
      position: npc.state.position.slice(),
      unknownFlag1: 0,
      unknownByte2: 0,
      totalShotCount: 0
    }
  };
}

export abstract class Npc extends BaseFullCharacter {
  private static readonly STANCE_STANDING = 1024;
  /**
   * Character.PlayAnimation's native duration field for the animal action
   * packet.  The client-side case-3 handler multiplies this uint32 by the
   * native 0.001 scale before writing `MeleeDuration`; keeping the FSM clock
   * on the same wire value prevents the server from resuming locomotion while
   * the client is still playing KnifeSlash.
   */
  private static readonly NATIVE_MELEE_ANIMATION_DURATION_MS = 1430;
  /**
   * Source durations for the two non-melee animal one-shots that the shared
   * AnimalsPhysics graph exposes by public event name.  Unlike the attack
   * branch, these clips have one unambiguous asset and the FSM already waits
   * for the same duration before returning to locomotion.
   *
   * Keep the generic attack clock as a compatibility fallback.  Concrete
   * animal entities override it with the native clip duration recovered from
   * their loaded resource table; actors without that mapping remain on the
   * observed network probe value until their graph path is closed.
   */
  private static readonly NATIVE_WOLF_HOWL_DURATION_MS = 5000;
  private static readonly NATIVE_BEAR_STANDUP_DURATION_MS = 5333;
  /**
   * Special Zombie001/Screamer actions whose FSM owns an explicit phase
   * clock.  These are not weapon-table values: they keep the server's
   * action boundary from resetting a graph one-shot halfway through the
   * existing rise/scream/cover/contract phase.
   */
  private static readonly ZOMBIE_COVER_EARS_DURATION_MS = 4667;
  private static readonly ZOMBIE_EXPLODE_CONTRACT_DURATION_MS = 3000;
  private static readonly ZOMBIE_GAS_CONVULSE_DURATION_MS = 5000;
  private static readonly SCREAMER_RISE_DURATION_MS = 1500;
  // ThirdPersonZombieScreamerPhysicsX64.mrn: Screamer_*_Scream is 100
  // frames at 30 FPS (3.333 s).  Keep the graph clock on the authored clip;
  // the old three-second timeout returned the actor to chase 333 ms early.
  private static readonly SCREAMER_SCREAM_DURATION_MS = 3333;
  /**
   * PlayerUpdatePosition stance bits used by the retail movement graph.
   *
   * 66560 = FORWARD | ON_GROUND (walk/locomotion graph)
   * 66565 = FORWARD | ON_GROUND | SPRINTING | FLAG21
   *
   * The old implementation emitted 66565 for every NPC sample.  That tells
   * the client that a patrol animal is sprinting even while the nav agent is
   * accelerating from rest, which is the source of the visible slide/start
   * mismatch.  Keep these values local to the NPC wire adapter so AI states
   * choose intent while the client still owns the actual animation graph.
   */
  private static readonly STANCE_MOVE_STANDING = 66560;
  private static readonly STANCE_MOVE_STANDING_SPRINTING = 66565;

  private locomotionMode: "walk" | "sprint" = "walk";
  /** Last movement speed advertised to the client movement controller. */
  private expectedSpeed?: number;
  /**
   * Native animals defer a positive ExpectedSpeed edge until the first
   * authoritative sample reaches the authored moving band.  Keeping the
   * target in `expectedSpeed` lets SeekTarget/Recast use the same value while
   * this pending edge prevents the client graph from starting a gait before
   * the server has published any matching displacement.
   */
  private pendingExpectedSpeed?: number;
  /**
   * Retail NPC locomotion selects the combat graph from character state, not
   * from Character.PlayAnimation.  Keep the state edge-triggered so an AI
   * tick cannot flood the reliable channel with identical flag packets.
   */
  private combatAnimationMode = false;
  /**
   * Last value sent through Character.AggroLevel/AnimalsPhysics Interest_Level.
   * This is edge-triggered because the packet is a graph input, not a tick
   * heartbeat; repeating it every AI tick only adds reliable-channel noise.
   */
  private lastAggroLevel?: number;
  /** Compatibility state for the legacy 0/1/2 locomotion API. */
  private lastLocomotionState?: 0 | 1 | 2;
  /**
   * Target GUID currently handed to the native client look/animation input.
   * `lookAtTarget` is only a server-side position used for orientation math;
   * the 2016 client needs the corresponding GUID through Character.SetLookAt
   * to resolve the target actor (including a target on a vehicle or step).
   */
  private lookAtCharacterId: string | null = null;

  health: number;
  npcRenderDistance = 100;

  /** Attach the animation object to the npc itself (used for zombie animations) */
  override get attachedObjectTargetId(): string {
    return this.transientId.toString();
  }

  spawnerId: number;
  deathTime: number = 0;
  npcId: number = 0;
  faction: Factions = Factions.None;
  rewardItems: { itemDefId: number; weight: number }[] = [];
  flags = {
    bit0: 0,
    bit1: 0,
    bit2: 0,
    bit3: 0,
    bit4: 0,
    bit5: 0,
    bit6: 0,
    bit7: 0,
    nonAttackable: 0, // disables melee flinch
    bit9: 0,
    bit10: 0,
    bit11: 0,
    projectileCollision: 1,
    bit13: 0, // causes a crash if 1 with noCollide 1
    bit14: 0,
    bit15: 0,
    bit16: 0,
    bit17: 0,
    bit18: 0,
    bit19: 0,
    noCollide: 0, // determines if NpcCollision packet gets sent on player collide
    knockedOut: 0, // knockedOut = 1 will not show the entity if the value is sent immediatly at 1
    bit22: 0,
    bit23: 0
  };
  public get isAlive(): boolean {
    return this.deathTime == 0;
  }
  server: ZoneServer2016;
  npcMeleeDamage: number = 0;
  /** Explicit native-animal capability; never infer it from clip metadata. */
  nativeMeleeCapability: NpcNativeMeleeCapability = "none";
  /** Item whose weapon/fire-mode data defines the NPC strike envelope. */
  meleeWeaponItemDefinitionId: Items = Items.WEAPON_MACHETE01;
  /** Native locomotion graph contract for actors with AnimalsPhysics assets. */
  nativeLocomotionProfile?: NpcNativeLocomotionProfile;
  /**
   * Visible transform authority.  This defaults to the only path currently
   * proven to be coherent: Recast -> goTo() -> PlayerUpdatePosition.  Do not
   * infer native root motion from the presence of AnimalsPhysics assets.
   */
  movementAuthority: NpcMovementAuthority = "server-position";
  /**
   * Animals currently use the Machete table as a compatibility proxy.  A
   * future native animal weapon definition must opt into the table source
   * explicitly instead of silently changing the meaning of diagnostics.
   */
  meleeProfileSource: NpcMeleeProfileSource = "compatibility-proxy";
  /**
   * Source attack clip duration recovered from the actor's native MRN.
   *
   * This is separate from the compatibility weapon table: for native animals
   * the latter is not used as the contact geometry, while this value drives
   * the Character.PlayAnimation/MeleeDuration clock for an animal whose public
   * KnifeSlash event selects a known native clip.  Undefined keeps the old
   * 1430ms compatibility behavior for zombies, test doubles, and actors whose
   * graph mapping is not yet established.
   */
  nativeMeleeAnimationDurationMs?: number;
  /** Human-readable native clip/resource name for diagnostics. */
  nativeMeleeAnimationSource?: string;
  /** Source duration for the AnimalsPhysics MeleeFlinch reaction clip. */
  nativeMeleeFlinchAnimationDurationMs?: number;
  /**
   * Explicit AI engagement distance for a native animal attack.
   *
   * This is deliberately separate from the compatibility weapon table: the
   * FSM owns this projection until the native weapon/contact shape is mapped.
   * The value is installed by the production Bear/Wolf FSM and is also
   * exposed to `/ztest status` so a live capture can show the exact envelope
   * input instead of reporting `meleeInEnvelope: null`.
   */
  nativeMeleeEngagementRange?: number;
  /** Native animation contact interval, when the actor resource provides it. */
  meleeContactWindow?: NpcMeleeContactWindow;
  fsm?: JSM<string | number>;
  currentAnimation = "";
  /**
   * Persistent reset/loop clip kept behind an active one-shot.
   *
   * `currentAnimation` is intentionally cleared while a one-shot is playing
   * so a newly relevant observer does not receive a stale Idle packet before
   * the action. Keep the reset clip separately so the same observer can be
   * handed the in-flight action, or the reset clip after its native clock has
   * elapsed, instead of spawning an animal in the wrong pose.
   */
  private persistentAnimation = "";
  private activeAnimation?: {
    packet: CharacterPlayAnimation;
    expiresAt: number;
  };
  /**
   * A persistent reset was explicitly queued while the current one-shot was
   * still live.  A subsequent play of the same public event is then a new
   * lifecycle (for example, a wake-up after the target was lost), not a
   * duplicate tick that should restart the old clock.
   */
  private activeAnimationResetQueued = false;
  /**
   * Locomotion requested while a one-shot owns the client graph.
   *
   * Action FSMs normally call stopMovement() before playAnimation(), but hit
   * reactions and recovery transitions can arrive while an actor is already
   * moving.  Keeping the request here lets the native one-shot finish before
   * the same path/speed is resumed; emitting ExpectedSpeed while the pose is
   * still active is the shared source of run-in-place/slide artefacts.
   */
  private pendingAnimationSpeed?: number;
  /**
   * Expiry handoff for actors that have no AI tick at the action boundary.
   * The timer is only a delivery fallback; mutating API calls still flush the
   * same state synchronously so tests and FSM transitions remain deterministic.
   */
  private animationExpiryTimer?: ReturnType<typeof setTimeout>;
  /** Last graph event sent, including one-shot actions cleared from the loop. */
  lastAnimationEvent: string | null = null;
  lookAtTarget: Float32Array | null = null;
  isSelected: boolean = false;
  variant: string = "";
  /** Last position/time pair emitted in a PlayerUpdatePosition packet. */
  private lastMotionSample?: NpcMotionSample;
  /**
   * Number of consecutive moving position samples published since the last
   * standing/action boundary.
   *
   * A single non-zero Recast displacement is not yet enough evidence for a
   * generic Zombie001 actor to enter its walk/run graph: the first sample is
   * the acceleration hand-off and is exactly where the old client recordings
   * showed the feet still planting while the body had already started to
   * slide.  Animal graphs have an authored minimum input band, but generic
   * zombie resources do not expose one; for that family the causal evidence
   * is two adjacent moving samples, not a guessed speed threshold.
   */
  private movingMotionSamplesSinceStop = 0;
  /**
   * Position/time anchor emitted at an action/idle stop.
   *
   * `stopMovement()` intentionally clears `lastMotionSample` so a long idle
   * interval cannot be reported as a very slow movement step.  Without a
   * separate anchor, the first sample after an attack resumed from the
   * Recast velocity alone; that velocity can already be sprint-sized while
   * the first replicated displacement is still a short acceleration step.
   * Keeping the zero-speed anchor lets that first resumed sample use its real
   * displacement and avoids reintroducing the start-slide window.
   */
  private lastStoppedMotionSample?: NpcMotionSample;
  /** Read-only diagnostic mirror of the last position packet sent to clients. */
  lastWireMotion?: NpcWireMotionTelemetry;
  /**
   * Optional vertical offset used only by the local `/ztest slope` harness.
   *
   * The crowd agent must remain on the Recast surface so it can continue to
   * solve X/Z paths, while the replicated test origin may intentionally sit
   * above or below that surface.  Production entities leave this undefined;
   * when it is set, the zone path broadcaster adds it back to the crowd Y
   * sample before calling `goTo()`.
   */
  testHarnessVerticalOffset?: number;
  /**
   * Action/idle states own the NPC position.  Recast can expose an
   * interpolated residual sample after a move request is reset, so the zone
   * pathfinding broadcaster must suppress those samples until movement is
   * explicitly resumed.
   */
  private pathfindingMovementSuppressed = false;
  /**
   * Native client movement controller currently bound to this NPC.
   *
   * These fields are retained for diagnostics and for the explicit
   * `native-root-motion` experiment.  They are empty on production actors:
   * `Character.SeekTarget` can advance the client actor independently of the
   * server position stream, so it must not be installed as a supposedly
   * harmless animation context packet.
   */
  private nativeSeekTargetId: string | null = null;
  private nativeSeekTargetUpdateAt = 0;
  /**
   * The complete native seek packet last installed on the wire.
   *
   * AddLightweightNpc does not include the seek controller. A client that
   * enters relevance after an animal has already started chasing therefore
   * needs the original `Character.SeekTarget` edge, not only the next
   * rate-limited `SeekTargetUpdate`. Keep a private copy so the late
   * observer handoff can replay the same controller inputs without
   * broadcasting a duplicate edge to existing observers.
   */
  private nativeSeekTargetPacket?: CharacterSeekTarget;
  /**
   * Speed carried by the installed native seek controller.
   *
   * `Character.SeekTargetUpdate` only carries the target GUID.  Keep the
   * packet's speed separately so a later locomotion-speed transition can
   * replace the full controller input instead of leaving the client on the
   * old chase/flee speed while ExpectedSpeed and Recast have already moved
   * on.
   */
  private nativeSeekTargetSpeed?: number;
  /**
   * Target context requested while the first authoritative moving sample is
   * still pending.
   *
   * AnimalsPhysics consumes Character.SeekTarget as a controller input.  If
   * that input is installed on the same tick as a chase request, before
   * Recast has produced a moving PlayerUpdatePosition sample, the client can
   * advance the controller while the server is still standing.  That is the
   * start-slide/"漂移" window seen in captures.  Keep the intent, but defer
   * the wire edge until goTo() has measured a native moving band.
   */
  private pendingNativeSeekTarget?: {
    targetCharacterId: string;
    targetPosition: Float32Array;
    requestedAt: number;
    speedOverride?: number;
  };
  /** @deprecated Compatibility mirror for the older AI manager contract. */
  lastSeekTargetId: string | null = null;
  /** @deprecated Compatibility clock for the older AI manager contract. */
  lastSeekTargetUpdateTime = 0;

  /** GUID currently bound through Character.SeekTarget, for diagnostics. */
  get nativeSeekTarget(): string | null {
    return this.nativeSeekTargetId ?? this.lastSeekTargetId ?? null;
  }

  /** Speed carried by the currently installed native seek controller. */
  get nativeSeekTargetControllerSpeed(): number | null {
    return this.nativeSeekTargetSpeed ?? null;
  }

  /**
   * Whether the latest authoritative PlayerUpdatePosition sample has entered
   * the first authored AnimalsPhysics moving band.  This is intentionally a
   * measured state, not an inference from the FSM's requested speed: a chase
   * can have a positive target while Recast is still at rest.
   */
  get nativeGaitReady(): boolean {
    return (
      this.nativeLocomotionProfile !== undefined &&
      this.hasMeasuredNativeMovement()
    );
  }

  /** Positive ExpectedSpeed retained until the first native moving sample. */
  get pendingLocomotionTargetSpeed(): number | null {
    return this.pendingExpectedSpeed ?? null;
  }

  /** Character GUID retained until the first native moving sample. */
  get pendingNativeSeekTargetId(): string | null {
    return this.pendingNativeSeekTarget?.targetCharacterId ?? null;
  }

  /** Consecutive moving wire samples since the last stop/action boundary. */
  get authoritativeMovingSampleCount(): number {
    return this.movingMotionSamplesSinceStop ?? 0;
  }

  constructor(
    characterId: string,
    transientId: number,
    actorModelId: number,
    position: Float32Array,
    rotation: Float32Array,
    server: ZoneServer2016,
    spawnerId: number = 0,
    variant: string = ""
  ) {
    super(characterId, transientId, actorModelId, position, rotation, server);
    this.positionUpdateType = PositionUpdateType.MOVABLE;
    this.spawnerId = spawnerId;
    this.health = 10000;
    this.server = server;
    this.variant = variant;
    // Every lightweight NPC needs a persistent reset clip before its first
    // observer is converted to the full representation.  Concrete actors
    // replace this with their species-specific reset (for example
    // ScreamerReset) after their profile/FSM is installed; the base default
    // keeps BasicNpc, AI-disabled spawns, and unknown model fallbacks from
    // entering the client graph with no animation state at all.
    this.initializeAnimation("Idle");
    if (!process.env.DISABLE_AI && this.server.aiEnabled) {
      // Canonicalize the replicated spawn to the same nav point used by the
      // crowd agent.  `createAgent({ preserveSpawn: true })` prevents a
      // random de-stack offset, but it cannot make an off-mesh/raw terrain
      // coordinate equal to the agent's nearest polygon point.  If the raw
      // coordinate is left in state, the first pathfinding broadcast sends a
      // correction before the FSM has requested movement; the client renders
      // that correction as a one-frame slide/teleport and it also poisons the
      // first measured locomotion speed.  Do this before the entity can be
      // replicated so AddLightweightNpc and Recast share one authoritative
      // spawn point.  Preserve the wire vector's fourth component because it
      // is not part of navigation but some callers use it as homogeneous data.
      const navPosition = this.server.navManager.getClosestNavPointVec3(
        this.state.position
      );
      this.state.position = new Float32Array([
        navPosition.x,
        navPosition.y,
        navPosition.z,
        this.state.position[3] ?? 0
      ]);
      this.navAgent = this.server.navManager.createAgent(this.state.position, {
        preserveSpawn: true
      });
      // A crowd agent is created before a concrete subclass installs its
      // FSM.  Until that FSM accepts a patrol/chase target, Recast may still
      // expose separation/interpolation samples; publishing those for a
      // BasicNpc (which has no FSM at all) makes an otherwise inert actor
      // drift through the locomotion graph.  setSpeed(positive) is the sole
      // opt-in edge that releases this initial suppression for real NPCs.
      this.pathfindingMovementSuppressed = true;
    }
    // Production zones always install this manager, while isolated protocol
    // fixtures intentionally do not. NPC animation state must not depend on
    // an unrelated explosive subsystem being present.
    server.explosiveManager?.addEntity?.(this);
  }

  protected abstract addLoot(server: ZoneServer2016): void;
  protected abstract onHarvest(
    server: ZoneServer2016,
    client: ZoneClient2016
  ): void;
  protected abstract buildInteractionString(
    server: ZoneServer2016,
    client: ZoneClient2016
  ): void;

  setAnimation(animationName: string) {
    // A previous one-shot may have expired between two AI ticks.  Settle it
    // before installing the next persistent clip so the existing observers
    // see the same boundary as late observers and diagnostics.
    const expiredAnimation = this.flushExpiredAnimation();

    // Passive animal actors share the AnimalsPhysics attack resources with
    // predators, but those resources are reaction/diagnostic data only.  Do
    // not let a legacy reset/event caller turn a Deer or Rabbit into an
    // attacker by installing KnifeSlash as its persistent animation.
    if (
      animationName === "KnifeSlash" &&
      this.nativeMeleeCapability === "passive"
    ) {
      return;
    }

    // A hit reaction is a client-side one-shot with its own native clock.  A
    // predator can still reach its FSM attack boundary while that reaction
    // is playing; sending the normal Idle reset at that boundary would cut
    // the visible flinch short and make the graph disagree with the hit that
    // was just accepted.  Keep the new persistent loop for late observers,
    // but let the active reaction own existing observers until it expires.
    const activeUntil = this.activeAnimation?.expiresAt ?? 0;
    if (this.activeAnimation && Date.now() < activeUntil) {
      // Do not cut any native action short.  This is not limited to hit
      // reactions: EatingDone, CoverEars, Stumble, Howl, StandUp, Spit and
      // the special-zombie actions all have their own client clock.  The
      // requested loop is retained and is broadcast by the expiry handoff.
      this.persistentAnimation = animationName;
      this.currentAnimation = "";
      this.activeAnimationResetQueued = true;
      return;
    }

    // flushExpiredAnimation() already published this exact reset edge.  Do
    // not immediately publish a second identical edge from the FSM's
    // DoneAction transition; restarting the persistent loop on the same tick
    // is another form of animation-clock jitter.
    if (
      expiredAnimation &&
      !this.activeAnimation &&
      this.currentAnimation === animationName &&
      this.persistentAnimation === animationName
    ) {
      return;
    }
    this.currentAnimation = animationName;
    this.persistentAnimation = animationName;
    this.activeAnimation = undefined;
    this.activeAnimationResetQueued = false;
    this.lastAnimationEvent = animationName;
    this.server.sendDataToAllWithSpawnedEntity<CharacterPlayAnimation>(
      this.server._npcs,
      this.characterId,
      "Character.PlayAnimation",
      this.createVerifiedAnimationPacket(animationName)
    );
  }

  /**
   * Prime the persistent animation state before the NPC has observers.
   *
   * Production animal FSMs are constructed before AddLightweightNpc is sent.
   * Broadcasting an Idle event at that point is either a no-op or reaches an
   * incomplete observer set, while leaving currentAnimation empty means a
   * client that enters the render range later has no authoritative reset clip
   * to replay.  Keep this separate from setAnimation(): it records the state
   * for the spawn/late-observer handoff without manufacturing a live event.
   */
  initializeAnimation(animationName: string) {
    this.clearAnimationExpiryTimer();
    this.currentAnimation = animationName;
    this.persistentAnimation = animationName;
    this.activeAnimation = undefined;
    this.activeAnimationResetQueued = false;
    this.lastAnimationEvent = animationName;
  }

  setSpeed(speed: number) {
    this.flushExpiredAnimation();
    const requestedSpeed = Number.isFinite(speed) ? Math.max(0, speed) : 0;
    // AnimalsPhysicsX64.mrn's authored blend ends at 8.0.  Keep values below
    // that cap continuous (the graph interpolates between its points), but do
    // not advertise an input the loaded native graph cannot represent.  NPCs
    // without an animal profile retain their existing unrestricted contract.
    const nativeMaxSpeed = this.nativeLocomotionProfile?.maximumSpeed;
    const boundedSpeed =
      nativeMaxSpeed !== undefined
        ? Math.min(requestedSpeed, nativeMaxSpeed)
        : requestedSpeed;

    // A one-shot owns the actor pose until the client-side clock expires.
    // Never re-enable the movement stream from an AI tick that happens to run
    // during that interval.  Retain the requested speed so the expiry handoff
    // can resume an already accepted path without making the FSM guess which
    // tick should restore it.
    const activeAnimation = this.activeAnimation;
    const activeAnimationName =
      typeof activeAnimation?.packet.animationName === "string"
        ? activeAnimation.packet.animationName
        : undefined;
    const actionStillActive =
      activeAnimation !== undefined &&
      (activeAnimationName
        ? this.isAnimationActive(activeAnimationName)
        : Date.now() < activeAnimation.expiresAt);
    if (boundedSpeed > 0 && actionStillActive) {
      this.pendingAnimationSpeed = boundedSpeed;
      this.pathfindingMovementSuppressed = true;
      const hadAdvertisedSpeed =
        this.expectedSpeed !== undefined && this.expectedSpeed > 0;
      this.expectedSpeed = 0;
      this.pendingExpectedSpeed = undefined;
      if (this.navAgent) {
        this.navAgent.maxSpeed = 0;
        this.navAgent.maxAcceleration = 0;
      }
      if (hadAdvertisedSpeed) this.emitExpectedSpeed(0);
      const motion = this.lastWireMotion;
      const hadMovingWireStance =
        motion !== undefined &&
        (motion.stance === Npc.STANCE_MOVE_STANDING ||
          motion.stance === Npc.STANCE_MOVE_STANDING_SPRINTING ||
          motion.horizontalSpeed > 1e-4 ||
          motion.verticalSpeed > 1e-4);
      if (hadAdvertisedSpeed || hadMovingWireStance) this.sendIdleStance();
      return;
    }
    if (boundedSpeed <= 0) this.pendingAnimationSpeed = undefined;
    // A positive movement intent is the hand-off back to the locomotion
    // stream.  Do this before the edge-triggered packet early return: a
    // chase may request the same speed immediately after an attack stop.
    if (boundedSpeed > 0) {
      this.pathfindingMovementSuppressed = false;
    }
    if (this.navAgent) {
      this.navAgent.maxSpeed = boundedSpeed;
      this.navAgent.maxAcceleration = boundedSpeed * 2.0;
    }

    // Zero is an action/idle boundary, even when a caller did not also call
    // stopMovement().  Some passive/roaming FSM branches only have a speed
    // edge available when a patrol target disappears.  Leaving the native
    // seek rail installed in that case lets the client continue steering
    // toward the previous target while the server advertises standing.
    // stopMovement() already clears the rail explicitly, so this is
    // edge-safe and does not duplicate its packet.
    if (boundedSpeed <= 0) {
      this.clearNativeSeekTarget();
    }

    // Recast's maxSpeed only changes the server-side steering constraint.  A
    // 2016 client also consumes Character.ExpectedSpeed when blending the
    // locomotion graph.  For every production server-position NPC, a positive
    // edge before the first authoritative moving sample can start the client
    // gait while the replicated body is still standing.  Retain the target
    // for Recast, but defer the wire edge until goTo() measures displacement.
    // Zero is always emitted immediately so an action or idle transition
    // cancels both the pending target and the old client gait.
    if (
      this.expectedSpeed === boundedSpeed &&
      (boundedSpeed <= 0 || this.pendingExpectedSpeed === undefined)
    ) {
      return;
    }
    this.expectedSpeed = boundedSpeed;
    const deferPositiveServerPositionEdge =
      boundedSpeed > 0 &&
      ((this.movementAuthority === "server-position" &&
        !this.hasMeasuredAuthoritativeMovement()) ||
        // Object.create(Npc.prototype) protocol fixtures predate the
        // authority field; preserve their established AnimalsPhysics gate.
        (this.nativeLocomotionProfile !== undefined &&
          !this.hasMeasuredNativeMovement()));
    if (deferPositiveServerPositionEdge) {
      this.pendingExpectedSpeed = boundedSpeed;
      return;
    }
    this.pendingExpectedSpeed = undefined;
    this.emitExpectedSpeed(boundedSpeed);
    // `setSpeed()` is also used by movement modifiers and test/control
    // paths that do not immediately call requestNativeSeekTarget().  If a
    // native rail is already installed, update its speed here so the client
    // cannot keep steering at the previous value after Recast and
    // ExpectedSpeed have changed.
    if (boundedSpeed > 0) {
      this.refreshNativeSeekTargetSpeed(boundedSpeed);
    }
  }

  private emitExpectedSpeed(speed: number) {
    this.server.sendDataToAllWithSpawnedEntity<CharacterExpectedSpeed>(
      this.server._npcs,
      this.characterId,
      "Character.ExpectedSpeed",
      { characterId: this.characterId, speed }
    );
  }

  /**
   * Replace only the speed/acceleration of an installed native seek rail.
   *
   * `Character.SeekTargetUpdate` has no speed field, while a full
   * `Character.SeekTarget` packet carries the controller values and the last
   * known target direction.  This helper is deliberately called from the
   * authoritative speed setter as well as the target-request path, so a
   * movement modifier cannot leave the client on a stale rail.
   */
  private refreshNativeSeekTargetSpeed(speed: number, now = Date.now()): boolean {
    const targetId = this.nativeSeekTargetId ?? this.lastSeekTargetId ?? null;
    const installedPacket = this.nativeSeekTargetPacket;
    if (
      !targetId ||
      !installedPacket ||
      !Number.isFinite(speed) ||
      speed <= 0
    ) {
      return false;
    }
    const installedSpeed = this.nativeSeekTargetSpeed;
    if (
      installedSpeed !== undefined &&
      Math.abs(installedSpeed - speed) <= 1e-3
    ) {
      return false;
    }

    const packet: CharacterSeekTarget = {
      ...installedPacket,
      characterId: this.characterId,
      TargetCharacterId: targetId,
      initSpeed: installedPacket.initSpeed ?? 0,
      acceleration: Math.max(2, speed * 3),
      speed,
      rotation: installedPacket.rotation
        ? new Float32Array(installedPacket.rotation)
        : new Float32Array([0, 0, 1, 0])
    };
    this.server.sendDataToAllWithSpawnedEntity<CharacterSeekTarget>(
      this.server._npcs,
      this.characterId,
      "Character.SeekTarget",
      packet
    );
    this.nativeSeekTargetPacket = {
      ...packet,
      rotation: packet.rotation
        ? new Float32Array(packet.rotation)
        : new Float32Array([0, 0, 1, 0])
    };
    this.nativeSeekTargetSpeed = speed;
    this.nativeSeekTargetUpdateAt = now;
    this.lastSeekTargetUpdateTime = now;
    return true;
  }

  /** Publish a deferred native gait speed once the measured band is active. */
  private flushPendingExpectedSpeed(): boolean {
    const pending = this.pendingExpectedSpeed;
    if (pending === undefined || !this.hasMeasuredAuthoritativeMovement()) {
      return false;
    }
    this.pendingExpectedSpeed = undefined;
    this.emitExpectedSpeed(pending);
    return true;
  }

  /**
   * Select the movement intent encoded in subsequent position samples.
   * Actual velocity is still measured from nav-agent/position samples; this
   * only selects the client's walk versus sprint locomotion graph.
   */
  setLocomotionMode(mode: "walk" | "sprint") {
    this.locomotionMode = mode;
  }

  /**
   * Desired speed sent through Character.ExpectedSpeed/Recast.
   *
   * This is deliberately separate from `lastWireMotion.horizontalSpeed`:
   * the former is the FSM/controller target, while the latter is measured
   * from the authoritative position stream.
   */
  get locomotionTargetSpeed(): number | undefined {
    return this.expectedSpeed;
  }

  /** Current walk/sprint intent selected by the active FSM state. */
  get locomotionIntent(): "walk" | "sprint" {
    return this.locomotionMode;
  }

  /** Whether the native combat locomotion graph is enabled. */
  get isCombatAnimationMode(): boolean {
    return this.combatAnimationMode === true;
  }

  /**
   * Legacy Object.create(Npc.prototype) protocol fixtures predate the
   * authority field.  Keep those isolated probes able to exercise the native
   * packet codec, while every constructed production NPC has the explicit
   * `server-position` default from the field initializer.
   */
  private isNativeRootMotionEnabled(): boolean {
    return (
      this.movementAuthority === "native-root-motion" ||
      this.movementAuthority === undefined
    );
  }

  /**
   * True once the authoritative position stream has produced a real moving
   * sample.  ExpectedSpeed is a graph/controller input while
   * PlayerUpdatePosition is the transform input; production server-position
   * NPCs must not publish the former before the latter for any model family.
   * AnimalsPhysics supplies its authored lower moving band; generic Zombie001
   * actors use two adjacent non-zero measured samples because the generic
   * zombie graph exposes no authored lower blend threshold.
   */
  private hasMeasuredAuthoritativeMovement(): boolean {
    const motion = this.lastWireMotion;
    if (!motion) return false;
    const minimumMovingSpeed =
      this.nativeLocomotionProfile?.minimumMovingSpeed ?? 1e-4;
    const hasNativeMovingInput =
      motion.horizontalSpeed >= minimumMovingSpeed ||
      motion.verticalSpeed > 1e-4;
    if (!hasNativeMovingInput) return false;
    // AnimalsPhysics has a verified authored minimum moving band.  Generic
    // Zombie001 resources expose no equivalent numeric threshold, so defer
    // their positive ExpectedSpeed edge until two adjacent moving samples
    // prove that the visible position stream has actually started.
    return (
      this.nativeLocomotionProfile !== undefined ||
      (this.movingMotionSamplesSinceStop ?? 0) >= 2
    );
  }

  /**
   * Install the retail native seek controller for a character target.
   *
   * `Character.SeekTarget` is a real client-side movement controller.  It is
   * kept behind the explicit `native-root-motion` authority because a live
   * probe showed that it can advance an actor between server position samples.
   * Production callers therefore use goTo()/PlayerUpdatePosition only until
   * native root motion has a proven reconciliation/ACK contract.
   *
   * An unchanged target update is sent at most every 400 ms while the GUID
   * and speed remain the same.  SeekTargetUpdate carries no position,
   * direction, or speed fields, so a real speed transition replaces the full
   * SeekTarget controller input immediately; repeating an unchanged update
   * more often cannot improve interpolation and only floods the reliable
   * channel.
   */
  requestNativeSeekTarget(
    targetCharacterId: string,
    targetPosition: Float32Array,
    now = Date.now(),
    speedOverride?: number
  ): boolean {
    // Do not let the AI accidentally create a second mover.  Bear/Wolf still
    // call this method as a compatibility boundary, but the default production
    // policy is server-position authority and must fail closed here.
    if (!Npc.prototype.isNativeRootMotionEnabled.call(this)) {
      const hadController =
        this.nativeSeekTargetId !== null ||
        this.lastSeekTargetId !== null ||
        this.pendingNativeSeekTarget !== undefined;
      if (hadController) this.clearNativeSeekTarget();
      return false;
    }

    const targetId = targetCharacterId ? String(targetCharacterId) : "";
    if (!targetId || targetId === this.characterId) return false;
    if (
      !targetPosition ||
      targetPosition.length < 3 ||
      !Number.isFinite(targetPosition[0]) ||
      !Number.isFinite(targetPosition[2])
    ) {
      return false;
    }

    const dx = targetPosition[0] - this.state.position[0];
    const dz = targetPosition[2] - this.state.position[2];
    const length = Math.hypot(dx, dz);
    if (!Number.isFinite(length) || length <= 1e-5) return false;

    // The native animal graph must not receive a target rail before the
    // authoritative movement stream proves that the actor has started.  The
    // Recast request and ExpectedSpeed edge can legitimately precede the
    // first crowd step; installing SeekTarget in that gap lets the client
    // render/advance a gait with no matching server displacement.
    if (
      this.nativeLocomotionProfile &&
      !this.hasMeasuredNativeMovement()
    ) {
      const pendingTarget = {
        targetCharacterId: targetId,
        targetPosition: new Float32Array([
          targetPosition[0],
          targetPosition[1] ?? 0,
          targetPosition[2],
          targetPosition[3] ?? 0
        ]),
        requestedAt: now,
        speedOverride
      };
      // If a previously installed rail survives into a zero-speed sample,
      // release it immediately.  Otherwise the client can continue steering
      // on the old target while Recast has already stopped; the next measured
      // gait will reinstall the newest deferred intent.
      if (
        (this.nativeSeekTargetId ?? this.lastSeekTargetId ?? null) !== null
      ) {
        this.clearNativeSeekTarget();
      }
      this.pendingNativeSeekTarget = pendingTarget;
      return true;
    }

    // setSpeed() is the source of truth for the dynamic animal gait.  The
    // native seek packet must use the same value instead of a fixed chase
    // speed, otherwise the client and Recast would select different clips.
    const requestedSpeed =
      speedOverride ?? this.expectedSpeed ?? this.navAgent?.maxSpeed ?? 0;
    const maximumSpeed = this.nativeLocomotionProfile?.maximumSpeed;
    const speed = Math.min(
      Number.isFinite(requestedSpeed) ? Math.max(0, requestedSpeed) : 0,
      maximumSpeed ?? Number.POSITIVE_INFINITY
    );
    if (speed <= 0) return false;

    const currentTargetId =
      this.nativeSeekTargetId ?? this.lastSeekTargetId ?? null;
    if (currentTargetId === targetId) {
      // SeekTargetUpdate has no speed field.  When the AI changes from walk
      // to sprint, applies a movement modifier, or otherwise changes the
      // target speed, replace the complete native controller input so its
      // acceleration/speed stays coherent with ExpectedSpeed and Recast.
      // The small epsilon only filters floating-point noise from modifiers;
      // actual authored speed transitions (for example 5 -> 6.5) are sent
      // immediately and do not wait for the 400 ms target refresh window.
      const installedSpeed = this.nativeSeekTargetSpeed;
      if (
        installedSpeed === undefined ||
        Math.abs(installedSpeed - speed) > 1e-3
      ) {
        const packet: CharacterSeekTarget = {
          characterId: this.characterId,
          TargetCharacterId: targetId,
          initSpeed: 0,
          acceleration: Math.max(2, speed * 3),
          speed,
          unknown8: 6,
          yRot: 0,
          rotation: new Float32Array([dx / length, 0, dz / length, 0])
        };
        this.server.sendDataToAllWithSpawnedEntity<CharacterSeekTarget>(
          this.server._npcs,
          this.characterId,
          "Character.SeekTarget",
          packet
        );
        this.nativeSeekTargetPacket = {
          ...packet,
          rotation: packet.rotation
            ? new Float32Array(packet.rotation)
            : new Float32Array([0, 0, 1, 0])
        };
        this.nativeSeekTargetSpeed = speed;
        this.nativeSeekTargetUpdateAt = now;
        this.lastSeekTargetUpdateTime = now;
        return true;
      }

      if (
        now - (this.nativeSeekTargetUpdateAt || this.lastSeekTargetUpdateTime) <
        400
      ) {
        return true;
      }
      this.nativeSeekTargetUpdateAt = now;
      this.lastSeekTargetUpdateTime = now;
      this.server.sendDataToAllWithSpawnedEntity<CharacterSeekTargetUpdate>(
        this.server._npcs,
        this.characterId,
        "Character.SeekTargetUpdate",
        {
          characterId: this.characterId,
          TargetCharacterId: targetId
        }
      );
      return true;
    }

    const packet: CharacterSeekTarget = {
      characterId: this.characterId,
      TargetCharacterId: targetId,
      initSpeed: 0,
      acceleration: Math.max(2, speed * 3),
      speed,
      // The native constructor reads this as the vertical/turning seek
      // parameter.  Keep the recovered production value; the direction is
      // carried separately in `rotation` below.
      unknown8: 6,
      yRot: 0,
      rotation: new Float32Array([dx / length, 0, dz / length, 0])
    };
    this.server.sendDataToAllWithSpawnedEntity<CharacterSeekTarget>(
      this.server._npcs,
      this.characterId,
      "Character.SeekTarget",
      packet
    );
    this.nativeSeekTargetPacket = {
      ...packet,
      rotation: packet.rotation
        ? new Float32Array(packet.rotation)
        : new Float32Array([0, 0, 1, 0])
    };
    this.nativeSeekTargetSpeed = speed;
    this.nativeSeekTargetId = targetId;
    this.lastSeekTargetId = targetId;
    this.nativeSeekTargetUpdateAt = now;
    this.lastSeekTargetUpdateTime = now;
    return true;
  }

  /** Whether the latest authoritative wire sample is in an animal gait band. */
  private hasMeasuredNativeMovement(): boolean {
    return (
      this.nativeLocomotionProfile !== undefined &&
      this.hasMeasuredAuthoritativeMovement()
    );
  }

  /** Install a deferred target rail after goTo() publishes a moving sample. */
  private flushPendingNativeSeekTarget(now = Date.now()): boolean {
    const pending = this.pendingNativeSeekTarget;
    if (!pending || !this.hasMeasuredNativeMovement()) return false;
    this.pendingNativeSeekTarget = undefined;
    // Preserve the AI request's clock edge.  Besides keeping the 400 ms
    // refresh window deterministic in tests, this prevents a delayed first
    // crowd step from artificially extending the initial target-update edge.
    const requestTime = Number.isFinite(pending.requestedAt)
      ? pending.requestedAt
      : now;
    return this.requestNativeSeekTarget(
      pending.targetCharacterId,
      pending.targetPosition,
      requestTime,
      pending.speedOverride
    );
  }

  /**
   * Release the native seek controller at an action/idle boundary.
   *
   * Without this explicit edge a client can continue the previous target
   * rail while the server has already emitted ExpectedSpeed=0 and the
   * standing PlayerUpdatePosition sample, which is the characteristic
   * pre-attack slide seen in the recordings.
   */
  clearNativeSeekTarget(force = false): boolean {
    const currentTargetId =
      this.nativeSeekTargetId ?? this.lastSeekTargetId ?? null;
    const hadPendingTarget = this.pendingNativeSeekTarget !== undefined;
    if (currentTargetId === null && !force) {
      // A chase can be cancelled during the Recast acceleration gap, before
      // any native rail was installed.  Clear the deferred intent without
      // manufacturing a ClearMovementRail packet for a controller that never
      // existed on the client.
      this.pendingNativeSeekTarget = undefined;
      return hadPendingTarget;
    }
    this.pendingNativeSeekTarget = undefined;
    this.nativeSeekTargetId = null;
    this.nativeSeekTargetPacket = undefined;
    this.nativeSeekTargetSpeed = undefined;
    this.lastSeekTargetId = null;
    this.nativeSeekTargetUpdateAt = 0;
    this.lastSeekTargetUpdateTime = 0;
    this.server.sendDataToAllWithSpawnedEntity<CharacterClearMovementRail>(
      this.server._npcs,
      this.characterId,
      "Character.ClearMovementRail",
      { characterId: this.characterId }
    );
    return true;
  }

  /**
   * Legacy/diagnostic name for the native combat-state input.
   *
   * Older zombie probes used 0 = ordinary locomotion, 1 = combat walk and
   * 2 = combat sprint.  The retail client does not receive those numbers as
   * an animation name: combat is selected by Character.UpdateCharacterState,
   * while walk versus sprint is carried by ExpectedSpeed and the measured
   * PlayerUpdatePosition stance.  Keep the old entry point, but route it to
   * the same packet contract instead of maintaining a second state machine.
   */
  sendLocomotionState(state: 0 | 1 | 2): boolean {
    if (state !== 0 && state !== 1 && state !== 2) return false;
    if (this.lastLocomotionState === state) return true;
    this.setCombatAnimationMode(state !== 0);
    this.lastLocomotionState = state;
    return true;
  }

  /**
   * Turn toward a target on the XZ plane without inventing a movement step.
   *
   * This is intentionally separate from lookAt(): the legacy AI calls this
   * just before its explicit idle/facing packet, whereas lookAt() publishes
   * that packet itself.  Keep both state representations in sync because the
   * modern wire path reads yaw and older probes read the quaternion rotation.
   */
  setFacingToward(targetPos: Float32Array, minHeadingChange = 0): boolean {
    const position = this.state.position;
    const dx = targetPos?.[0] - position[0];
    const dz = targetPos?.[2] - position[2];
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return false;
    if (Math.abs(dx) < 1e-5 && Math.abs(dz) < 1e-5) return false;

    const yaw = Math.atan2(dx, dz);
    if (!Number.isFinite(yaw)) return false;
    if (minHeadingChange > 0) {
      const rotation = this.state.rotation;
      if (
        !rotation ||
        rotation.length < 4 ||
        !Array.from(rotation).every(Number.isFinite) ||
        Math.hypot(...rotation) === 0
      ) {
        return false;
      }
      // The movement protocol quantizes the quaternion heading to one byte;
      // compare in the same representation so the deadband does not flap at
      // the 0/2π boundary.
      const lastHeading = (quat2heading(rotation) / 255) * 2 * Math.PI;
      const delta = Math.atan2(
        Math.sin(yaw - lastHeading),
        Math.cos(yaw - lastHeading)
      );
      if (Math.abs(delta) < minHeadingChange) return false;
    }

    this.state.yaw = yaw;
    this.state.rotation = eul2quat(new Float32Array([yaw, 0, 0]));
    return true;
  }

  /**
   * Feed the recovered AnimalsPhysics Interest_Level input when an AI path
   * has an explicit aggro transition.  Do not emit a heartbeat from the tick.
   */
  sendAggroLevel(level: number): boolean {
    if (!Number.isFinite(level)) return false;
    if (this.lastAggroLevel === level) return true;
    this.server.sendDataToAllWithSpawnedEntity<CharacterAggroLevel>(
      this.server._npcs,
      this.characterId,
      "Character.AggroLevel",
      { characterId: this.characterId, unknownDword1: level }
    );
    this.lastAggroLevel = level;
    return true;
  }

  /**
  * Compatibility entry point for the old AI manager.  It still emits the
  * complete verified native event, including the actor-specific duration,
  * through the same path as the current animal FSMs.
  */
  triggerMeleeAttack(): void {
    // Passive AnimalsPhysics actors retain attack/recoil metadata because the
    // shared graph contains those resources, but they must never be able to
    // enter the attack branch through this legacy compatibility entry point.
    // Their production FSMs already flee; this guard also closes old callers
    // that bypass the FSM and invoke the inherited method directly.
    if (this.nativeMeleeCapability === "passive") return;

    // Production Npc instances inherit the active-animation clock and replay
    // helpers.  A few legacy protocol probes deliberately use a plain object
    // with only the sender surface; keep those probes on the same complete
    // wire payload without requiring them to construct the whole entity.
    const self = this as unknown as {
      createVerifiedOneShotAnimationPacket?: unknown;
    };
    if (typeof self.createVerifiedOneShotAnimationPacket === "function") {
      Npc.prototype.playAnimation.call(this, "KnifeSlash");
      return;
    }
    this.server.sendDataToAllWithSpawnedEntity<CharacterPlayAnimation>(
      this.server._npcs,
      this.characterId,
      "Character.PlayAnimation",
      {
        characterId: this.characterId,
        animationName: "KnifeSlash",
        unm4: 0,
        unknownDword1: 0,
        unknownByte1: 0,
        unknownDword2: Npc.NATIVE_MELEE_ANIMATION_DURATION_MS,
        animationType: "",
        unknownByte1xda: 0,
        unknownDword3: 0
      }
    );
  }

  /**
   * Backwards-compatible name used by the older zombie AI manager and by
   * existing protocol probes.  New animal FSMs call
   * requestNativeSeekTarget() directly so the intent is explicit.
  */
  seekTarget(targetCharacterId: string, targetPosition: Float32Array): boolean {
    // `seekTarget()` is retained for old AI/test callers, but it is still a
    // real client-side movement controller.  Do not let that compatibility
    // entry point publish an ExpectedSpeed edge before
    // requestNativeSeekTarget() rejects the native rail in production's
    // server-position mode; doing so would leave the client locomotion graph
    // moving without a matching controller/position stream.
    if (!Npc.prototype.isNativeRootMotionEnabled.call(this)) return false;
    const dx = targetPosition[0] - this.state.position[0];
    const dz = targetPosition[2] - this.state.position[2];
    if (!Number.isFinite(dx) || !Number.isFinite(dz) || Math.hypot(dx, dz) <= 1e-5) {
      return false;
    }
    if ((this.nativeSeekTargetId ?? this.lastSeekTargetId ?? null) === null) {
      const scale = Number((this as Npc & { testChaseSpeedScale?: number }).testChaseSpeedScale);
      const fallbackSpeed = 2.5 * (Number.isFinite(scale) ? scale : 1);
      if (!(this.expectedSpeed && this.expectedSpeed > 0)) {
        this.expectedSpeed = fallbackSpeed;
        this.server.sendDataToAllWithSpawnedEntity<CharacterExpectedSpeed>(
          this.server._npcs,
          this.characterId,
          "Character.ExpectedSpeed",
          { characterId: this.characterId, speed: fallbackSpeed }
        );
      }
    }
    return Npc.prototype.requestNativeSeekTarget.call(
      this,
      targetCharacterId,
      targetPosition
    );
  }

  /** @deprecated Use requestNativeSeekTarget(); kept for old AI probes. */
  seekTargetUpdate(targetCharacterId: string): boolean {
    if (!Npc.prototype.isNativeRootMotionEnabled.call(this)) return false;
    const targetId = targetCharacterId ? String(targetCharacterId) : "";
    if (!targetId) return false;
    this.nativeSeekTargetId = targetId;
    this.lastSeekTargetId = targetId;
    this.nativeSeekTargetUpdateAt = Date.now();
    this.lastSeekTargetUpdateTime = this.nativeSeekTargetUpdateAt;
    this.server.sendDataToAllWithSpawnedEntity<CharacterSeekTargetUpdate>(
      this.server._npcs,
      this.characterId,
      "Character.SeekTargetUpdate",
      { characterId: this.characterId, TargetCharacterId: targetId }
    );
    return true;
  }

  /** @deprecated Use clearNativeSeekTarget(); kept for old AI probes. */
  clearMovementController(force = false): boolean {
    return Npc.prototype.clearNativeSeekTarget.call(this, force);
  }

  /** Return the audited native locomotion input domain for diagnostics. */
  getNativeLocomotionProfile(): NpcNativeLocomotionProfile | undefined {
    return this.nativeLocomotionProfile;
  }

  /** True while an action/idle transition owns the NPC's position. */
  get isPathfindingMovementSuppressed(): boolean {
    return this.pathfindingMovementSuppressed;
  }

  /**
   * Select the native NPC combat locomotion graph.
   *
   * Ghidra traces show the 2016 client chooses idle/walk/run versus combat
   * idle/chase from `states6.hidesHeat` (bit 2), with `states2.inCombat` kept
   * in sync by the normal server state packet.  PlayAnimation is retained for
   * one-shot actions (stand-up/howl/slash), but it is not the locomotion
   * contract for a lightweight NPC.
   */
  setCombatAnimationMode(enabled: boolean) {
    this.flushExpiredAnimation();
    const next = Boolean(enabled);
    if (next === this.combatAnimationMode) return;

    // AnimalsPhysics exposes Interest_Level as the native aggro input.  The
    // old NPC controller emitted Character.AggroLevel alongside its combat
    // state; omitting it here leaves the client in a combat locomotion packet
    // with a stale/zero interest value, which can keep an animal in the wrong
    // locomotion branch or delay the attack selector.  Both values are
    // edge-triggered and represent the same server FSM transition.
    const previousAggroLevel = this.lastAggroLevel;
    this.sendAggroLevel(next ? 1 : 0);
    try {
      this.combatAnimationMode = next;
      this.server.sendDataToAllWithSpawnedEntity<CharacterUpdateCharacterState>(
        this.server._npcs,
        this.characterId,
        "Character.UpdateCharacterState",
        this.createCombatAnimationState()
      );
    } catch (error) {
      // If the state packet fails after AggroLevel was accepted, preserve the
      // old logical mode and cache so the next AI tick retries both packets.
      // The sender may have thrown before the reliable queue accepted either
      // edge; retrying the pair is safer than leaving Interest_Level and the
      // combat bit out of sync.
      this.combatAnimationMode = !next;
      this.lastAggroLevel = previousAggroLevel;
      throw error;
    }
  }

  /**
   * Bind the native client look-at input to an entity GUID.
   *
   * Character.SetLookAt is an existing 2016 packet (opcode 0x0f08), not a
   * custom animation command.  Edge-triggering it keeps the reliable channel
   * quiet while an AI tick refreshes the same target, and clearing it on a
   * lost target prevents the next action from inheriting stale target context.
   */
  setLookAtCharacter(characterId: string | null | undefined): void {
    this.flushExpiredAnimation();
    const next = characterId ? String(characterId) : null;
    if (next === this.lookAtCharacterId) return;
    this.lookAtCharacterId = next;
    this.server.sendDataToAllWithSpawnedEntity<CharacterSetLookAt>(
      this.server._npcs,
      this.characterId,
      "Character.SetLookAt",
      {
        characterId: this.characterId,
        // The generated schema calls this field unknownQword2, while the
        // 2015/860 schema names the same wire slot targetCharacterId.
        unknownQword2: next ?? "0"
      }
    );
  }

  /** Current GUID bound through Character.SetLookAt, for diagnostics/tests. */
  get lookAtCharacter(): string | null {
    return this.lookAtCharacterId;
  }

  /**
   * Re-send state that is not part of AddLightweightNpc when a late observer
   * first spawns this NPC.  Without this handoff a client entering render
   * range during a chase starts with the default idle graph and may not see
   * the next state edge until the animal leaves combat.
   */
  sendInitialLocomotionState(client: ZoneClient2016) {
    // Relevance handoff must preserve the same causal order as the live
    // movement stream: position sample first, then the positive gait target,
    // then the native seek controller. Sending ExpectedSpeed first makes a
    // late observer enter a walk/sprint clip while it still renders the spawn
    // position, which is the same one-frame slide fixed in goTo().
    if (this.lastWireMotion !== undefined) {
      const motion: NpcPositionUpdateMotion = {
        stance: this.lastWireMotion.stance,
        engineRPM: 0,
        orientation: this.lastWireMotion.orientation,
        frontTilt: 0,
        sideTilt: 0,
        angleChange: 0,
        verticalSpeed: this.lastWireMotion.verticalSpeed,
        horizontalSpeed: this.lastWireMotion.horizontalSpeed
      };
      this.server.sendData(
        client,
        "PlayerUpdatePosition",
        {
          transientId: this.transientId,
          positionUpdate: {
            ...createNpcPositionUpdate(
              this.state.position,
              this.lastWireMotion.sequenceTime,
              motion
            ),
            unknown3_int8: this.movementVersion ?? 0
          }
        }
      );
    }
    if (
      this.expectedSpeed !== undefined &&
      this.pendingExpectedSpeed === undefined
    ) {
      this.server.sendData<CharacterExpectedSpeed>(
        client,
        "Character.ExpectedSpeed",
        { characterId: this.characterId, speed: this.expectedSpeed }
      );
    }
    // A native seek rail is never part of the production server-position
    // handoff.  It is replayed only for an explicitly opted-in
    // native-root-motion experiment, and only after a moving sample exists;
    // requestNativeSeekTarget() already guarantees that an installed packet
    // cannot predate that sample.  Keeping this guard here matters because a
    // late observer otherwise receives a second mover even though the live
    // NPC has been running on PlayerUpdatePosition alone.
    const nativeSeekTargetPacket = this.nativeSeekTargetPacket;
    if (
      Npc.prototype.isNativeRootMotionEnabled.call(this) &&
      nativeSeekTargetPacket &&
      this.lastWireMotion !== undefined &&
      (this.lastWireMotion.horizontalSpeed >=
        (this.nativeLocomotionProfile?.minimumMovingSpeed ?? 1e-4) ||
        this.lastWireMotion.verticalSpeed > 1e-4)
    ) {
      this.server.sendData<CharacterSeekTarget>(
        client,
        "Character.SeekTarget",
        {
          ...nativeSeekTargetPacket,
          rotation: nativeSeekTargetPacket.rotation
            ? new Float32Array(nativeSeekTargetPacket.rotation)
            : new Float32Array([0, 0, 1, 0])
        }
      );
    }
    // AggroLevel is also outside AddLightweightNpc.  Replay the last edge for
    // a late observer so AnimalsPhysics receives Interest_Level=1 together
    // with the combat state instead of waiting for the next target change.
    if (this.lastAggroLevel !== undefined) {
      this.server.sendData<CharacterAggroLevel>(
        client,
        "Character.AggroLevel",
        {
          characterId: this.characterId,
          unknownDword1: this.lastAggroLevel
        }
      );
    }
    // Character.SetLookAt is not part of AddLightweightNpc.  A client that
    // becomes relevant while an animal is already chasing would otherwise
    // receive the combat locomotion flags but no native target binding; the
    // animal can then enter KnifeSlash with a stale/default head-look context
    // until the next target transition.  Replay the current edge only when a
    // target is actually bound; the normal null-clearing edge is broadcast to
    // all existing observers when the FSM loses its target.
    if (typeof this.lookAtCharacterId === "string") {
      this.server.sendData<CharacterSetLookAt>(
        client,
        "Character.SetLookAt",
        {
          characterId: this.characterId,
          unknownQword2: this.lookAtCharacterId
        }
      );
    }
    if (this.combatAnimationMode) {
      this.server.sendData<CharacterUpdateCharacterState>(
        client,
        "Character.UpdateCharacterState",
        this.createCombatAnimationState()
      );
    }
  }

  private createCombatAnimationState(): CharacterUpdateCharacterState {
    const next = this.combatAnimationMode;
    return {
      characterId: this.characterId,
      states1: {
        visible: 1,
        afraid: 0,
        asleep: 0,
        silenced: 0,
        bound: 0,
        rooted: 0,
        stunned: 0,
        knockedOut: this.flags?.knockedOut ? 1 : 0
      },
      states2: {
        nonAttackable: this.flags?.nonAttackable ? 1 : 0,
        knockedBack: 0,
        confused: 0,
        goinghome: 0,
        inCombat: next ? 1 : 0,
        frozen: 0,
        berserk: 0,
        inScriptedAnimation: 0
      },
      states3: {
        pull: 0,
        revivable: 0,
        beingRevived: 0,
        cloaked: 0,
        interactBlocked: 0,
        nonHealable: 0,
        weaponFireBlocked: 0,
        nonResuppliable: 0
      },
      states4: {
        charging: 0,
        invincibility: 0,
        thrustPadded: 0,
        castingAbility: 0,
        userMovementDisabled: 0,
        flying: 0,
        hideCorpse: 0,
        gmHidden: 0
      },
      states5: {
        griefInvulnerability: 0,
        canSpawnTank: 0,
        inGravityField: 0,
        invulnerable: 0,
        friendlyFireImmunity: 0,
        riotShielded: 0,
        supplyingAmmo: 0,
        supplyingRepairs: 0
      },
      states6: {
        REUSE_ME_2: 0,
        ignitionLoweringIntoMatch: 0,
        hidesHeat: next ? 1 : 0,
        nearDeath: 0,
        dormant: 0,
        ignoreStatusNotUsed: 0,
        inWater: 0,
        disarmed: 0
      },
      states7: {
        doorState: 0,
        sitting: 0,
        error1: 0,
        error2: 0,
        handsUp: 0,
        bit5: 0,
        bit6: 0,
        bit7: 0
      },
      placeholder: 0,
      gameTime: getCurrentServerTimeWrapper().getTruncatedU32()
    };
  }

  /**
   * Resolve the NPC strike envelope from the server's item/weapon tables.
   * Returning undefined on an incomplete table is deliberate: callers can
   * keep a test-only fallback, while production never silently invents a new
   * attack range when the configured weapon data is unavailable.
   */
  getMeleeAttackProfile(): NpcMeleeAttackProfile | undefined {
    const itemDefinitionId = this.meleeWeaponItemDefinitionId;
    if (
      !this.server ||
      typeof this.server.getItemDefinition !== "function" ||
      typeof this.server.getWeaponDefinition !== "function" ||
      typeof this.server.getFiregroupDefinition !== "function" ||
      typeof this.server.getFiremodeDefinition !== "function"
    ) {
      return undefined;
    }

    const itemDefinition = this.server.getItemDefinition(itemDefinitionId);
    const weaponDefinitionId = Number(itemDefinition?.PARAM1);
    if (!Number.isFinite(weaponDefinitionId) || weaponDefinitionId <= 0)
      return undefined;

    const weaponDefinition =
      this.server.getWeaponDefinition(weaponDefinitionId);
    const fireGroupId = Number(
      weaponDefinition?.FIRE_GROUPS?.[0]?.FIRE_GROUP_ID
    );
    if (!Number.isFinite(fireGroupId) || fireGroupId <= 0) return undefined;

    const firegroupDefinition = this.server.getFiregroupDefinition(fireGroupId);
    const fireModeId = Number(
      firegroupDefinition?.FIRE_MODES?.[0]?.FIRE_MODE_ID
    );
    if (!Number.isFinite(fireModeId) || fireModeId <= 0) return undefined;

    const fireModeDefinition = this.server.getFiremodeDefinition(fireModeId);
    const range = Number(fireModeDefinition?.RANGE);
    const detectWidth = Number(
      weaponDefinition?.MELEE_DETECT?.MELEE_DETECT_WIDTH
    );
    const detectHeight = Number(
      weaponDefinition?.MELEE_DETECT?.MELEE_DETECT_HEIGHT
    );
    const fireDurationMs = Number(fireModeDefinition?.FIRE_DURATION_MS);
    const fireAnimDurationMs = Number(
      fireModeDefinition?.FIRE_ANIM_DURATION_MS ?? fireDurationMs
    );
    const refireTimeMs = Number(fireModeDefinition?.REFIRE_TIME_MS);
    if (
      !Number.isFinite(range) ||
      range <= 0 ||
      !Number.isFinite(detectWidth) ||
      detectWidth < 0 ||
      !Number.isFinite(detectHeight) ||
      detectHeight < 0 ||
      !Number.isFinite(fireDurationMs) ||
      fireDurationMs < 0 ||
      !Number.isFinite(fireAnimDurationMs) ||
      fireAnimDurationMs < 0 ||
      !Number.isFinite(refireTimeMs) ||
      refireTimeMs < 0
    ) {
      return undefined;
    }

    const profile: NpcMeleeAttackProfile = {
      itemDefinitionId,
      weaponDefinitionId,
      fireGroupId,
      fireModeId,
      range,
      detectWidth,
      detectHeight,
      fireDurationMs,
      refireTimeMs
    };
    // Keep the animation clock enumerable even when it matches the fire
    // duration.  Older callers (and the 2016 weapon-table contract) consume
    // this field directly; a distinct value still overrides the fire clock.
    profile.fireAnimDurationMs = fireAnimDurationMs;
    return profile;
  }

  /**
   * Explain whether the resolved table is authoritative for this actor.
   * The compatibility proxy intentionally remains usable by the test harness
   * but is never presented as an animal-native weapon definition.
   */
  getMeleeAttackProfileSource(): NpcMeleeProfileSource {
    return this.meleeProfileSource;
  }

  /**
   * Describe the geometry source used by isMeleeTargetInEnvelope().  This is
   * intentionally separate from the profile provenance: an animal can expose
   * a compatibility Machete profile for legacy diagnostics while its actual
   * FSM envelope is the explicit engagement-range projection.
   */
  getMeleeAttackEnvelopeSource(): NpcMeleeEnvelopeSource {
    if (
      this.getNativeMeleeCapability() === "passive" &&
      this.hasNativeAnimalReactionProfile()
    ) {
      return "not-applicable";
    }
    if (this.usesNativeAnimalMeleeProjection()) {
      return "animal-engagement-projection";
    }
    try {
      return this.getMeleeAttackProfile()
        ? this.meleeProfileSource
        : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  /**
   * Animation evidence is deliberately conservative.  We know the graph
   * event names and normalized SwingContact windows from the packed resource,
   * but not the runtime clip clock, client contact acknowledgement, or root
   * motion ownership.  Expose those gaps to /ztest status instead of hiding
   * them behind the compatibility duration.
   */
  getAnimationVerification(eventName: string | null = null): NpcAnimationVerification {
    return {
      eventName,
      clockVerified: false,
      contactEventVerified: false,
      rootMotionVerified: false
    };
  }

  /**
   * Return the server's animation handoff state without treating a one-shot
   * as the persistent loop.  The optional clock is injectable for tests.
   */
  private flushExpiredAnimation(now = Date.now()): boolean {
    const active = this.activeAnimation;
    if (!active || now < active.expiresAt) return false;

    this.clearAnimationExpiryTimer();
    this.activeAnimation = undefined;
    this.activeAnimationResetQueued = false;
    const resetAnimation = this.persistentAnimation;
    this.currentAnimation = resetAnimation;

    // A dead NPC is already owned by StartMultiStateDeath/ragdoll.  Do not
    // send an Idle/reset packet after that lifecycle boundary.  Lightweight
    // protocol fixtures may not initialize deathTime, so only an explicit
    // non-zero numeric value is treated as dead here.
    const deathTime = (this as unknown as { deathTime?: unknown }).deathTime;
    const isDead = typeof deathTime === "number" && deathTime !== 0;
    if (!resetAnimation || isDead || !this.server) return true;

    // Existing observers need the same reset edge that a late observer gets
    // from getCurrentAnimationPacket().  Without this broadcast, a state
    // transition that follows EatingDone/CoverEars/Stumble/Howl can leave an
    // already-rendered actor in the completed one-shot until an unrelated
    // animation event happens.
    this.server.sendDataToAllWithSpawnedEntity<CharacterPlayAnimation>(
      this.server._npcs,
      this.characterId,
      "Character.PlayAnimation",
      this.createVerifiedAnimationPacket(resetAnimation)
    );

    // A hit/recovery edge may have suspended an existing chase path.  Resume
    // it only after the reset clip has been published and the one-shot clock
    // is definitely over; setSpeed() also applies the native first-sample
    // gating for AnimalsPhysics actors.
    const pendingAnimationSpeed = this.pendingAnimationSpeed;
    this.pendingAnimationSpeed = undefined;
    if (pendingAnimationSpeed !== undefined && this.isAlive) {
      this.setSpeed(pendingAnimationSpeed);
    }
    return true;
  }

  getAnimationRuntimeState(now = Date.now()): NpcAnimationRuntimeState {
    const active = this.activeAnimation;
    const activeIsLive = Boolean(active && now < active.expiresAt);
    if (active && !activeIsLive) {
      // This getter is used by /api/npcs and must not consume the expiry edge.
      // Clearing activeAnimation here used to make a status poll race the
      // next FSM tick: flushExpiredAnimation() then had nothing to settle and
      // existing observers never received the persistent reset packet.  Show
      // the settled persistent clip in diagnostics, but leave the live clock
      // for the next mutating path to flush and broadcast causally.
      this.currentAnimation = this.persistentAnimation;
    }

    const current = activeIsLive ? active : undefined;
    const activeAnimation =
      typeof current?.packet.animationName === "string"
        ? current.packet.animationName
        : null;
    return {
      persistentAnimation: this.persistentAnimation || null,
      activeAnimation,
      activeAnimationRemainingMs: current
        ? Math.max(0, current.expiresAt - now)
        : null,
      lastAnimationEvent: this.lastAnimationEvent
    };
  }

  /**
   * Tell an action FSM whether the client-side one-shot clock is still live.
   *
   * The FSM timer is sampled on the server AI interval, while the client
   * consumes `Character.PlayAnimation.unknownDword2` from its own clock.  A
   * delayed/oversized AI tick can therefore reach the logical duration while
   * the one-shot still has visible frames left.  Expose the existing runtime
   * clock as a small contract so action states can wait for the actual clip
   * boundary instead of cutting it off and handing locomotion back early.
   */
  isAnimationActive(animationName: string, now = Date.now()): boolean {
    if (!animationName) return false;
    const runtime = this.getAnimationRuntimeState(now);
    return (
      runtime.activeAnimation === animationName &&
      (runtime.activeAnimationRemainingMs ?? 0) > 0
    );
  }

  /**
   * Expose the native-contact boundary without conflating it with the AI
   * engagement range.  Animals have a client-local SwingContact signal, but
   * server damage still comes from the normalized-window projection until a
   * native weapon/contact shape is recovered and live-verified.
   */
  getNativeContactContract(): NpcNativeContactContract {
    if (
      this.getNativeMeleeCapability() === "passive" &&
      this.hasNativeAnimalReactionProfile()
    ) {
      return {
        // The resource still contains the shared attack/contact branch, but
        // the passive FSM never enters it and the server has no damage
        // authority for that branch.
        signal: "AnimalsPhysics.SwingContact",
        clientAuthority: "client-local-graph",
        serverDamageAuthority: "unavailable",
        geometrySource: "unavailable",
        liveVerified: false
      };
    }
    if (this.usesNativeAnimalMeleeProjection()) {
      return {
        signal: "AnimalsPhysics.SwingContact",
        clientAuthority: "client-local-graph",
        serverDamageAuthority: "server-projection",
        geometrySource: "native-client-shape-query-unavailable",
        liveVerified: false
      };
    }

    let hasServerProfile = false;
    try {
      hasServerProfile = this.getMeleeAttackProfile() !== undefined;
    } catch {
      hasServerProfile = false;
    }
    return {
      signal: null,
      clientAuthority: "unavailable",
      serverDamageAuthority: hasServerProfile
        ? "server-weapon-table"
        : "unavailable",
      geometrySource: hasServerProfile ? "server-weapon-table" : "unavailable",
      liveVerified: false
    };
  }

  /**
   * Animal actors have a native animation/contact contract but no recovered
   * animal weapon definition.  Their checked-in Machete profile is therefore
   * useful to generic NPC tests only; it must not silently become the animal's
   * attack reach.  Wolf/Bear pass their explicit AI engagement range to the
   * envelope check below.
   */
  private usesNativeAnimalMeleeProjection(): boolean {
    return (
      this.getNativeMeleeCapability() === "attacker" &&
      this.meleeProfileSource === "compatibility-proxy" &&
      typeof this.nativeMeleeAnimationSource === "string" &&
      this.nativeMeleeAnimationSource.length > 0
    );
  }

  /**
   * Resolve the explicit capability while keeping lightweight Object.create
   * test doubles backwards compatible.  Production Npc instances initialize
   * the field to `none`; a fixture that predates this field may still install
   * a native attack source and is treated as an attacker until it opts into
   * the explicit passive/none value.
   */
  private getNativeMeleeCapability(): NpcNativeMeleeCapability {
    if (
      this.nativeMeleeCapability === "attacker" ||
      this.nativeMeleeCapability === "passive" ||
      this.nativeMeleeCapability === "none"
    ) {
      return this.nativeMeleeCapability;
    }
    return typeof this.nativeMeleeAnimationSource === "string" &&
      this.nativeMeleeAnimationSource.length > 0
      ? "attacker"
      : "none";
  }

  /** Resolve the configured RANGE, with a test-only compatibility fallback. */
  getMeleeAttackRange(fallbackRange: number): number {
    if (this.usesNativeAnimalMeleeProjection()) {
      // This is an AI engagement distance, not a native weapon/contact shape.
      // Keep it on the actor once the production FSM has installed it.  The
      // fallback remains for lightweight test doubles and does not borrow the
      // unrelated Machete RANGE.
      return this.nativeMeleeEngagementRange ?? fallbackRange;
    }
    try {
      const range = this.getMeleeAttackProfile()?.range;
      return range !== undefined ? range : fallbackRange;
    } catch {
      // Lightweight test servers may expose the resolver methods before their
      // data tables are initialized.  Keep their explicit fallback without
      // weakening the production table-backed path.
      return fallbackRange;
    }
  }

  /**
   * Return the duration of the configured melee animation in seconds.
   *
   * AI state machines must not guess a fixed one-second swing when the
   * weapon table already carries the animation timing.  The fallback is kept
   * for lightweight test doubles and for NPCs whose item tables are absent.
   */
  getMeleeAttackAnimationDuration(fallbackSeconds: number): number {
    // The source clip duration is an actor-resource fact and takes priority
    // over the Machete compatibility envelope.  Its 850ms
    // FIRE_ANIM_DURATION_MS is a player-weapon value, not an animal attack
    // clock; using it would return the NPC to chase while the native one-shot
    // is still running.
    if (
      Number.isFinite(this.nativeMeleeAnimationDurationMs) &&
      (this.nativeMeleeAnimationDurationMs as number) > 0
    ) {
      return (this.nativeMeleeAnimationDurationMs as number) / 1000;
    }

    // Actors without a recovered native clip retain the live network probe
    // until their graph selector is mapped.  This is intentionally a
    // compatibility fallback, not a claim that all animals share 1430ms.
    if (this.meleeProfileSource === "compatibility-proxy") {
      return Npc.NATIVE_MELEE_ANIMATION_DURATION_MS / 1000;
    }
    try {
      const profile = this.getMeleeAttackProfile();
      const durationMs = profile?.fireAnimDurationMs ?? profile?.fireDurationMs;
      if (durationMs !== undefined && durationMs > 0) {
        return durationMs / 1000;
      }
    } catch {
      // Keep the explicit compatibility fallback for lightweight tests.
    }
    return fallbackSeconds;
  }

  /**
   * Return the actor-native normalized SwingContact interval when known.
   * Invalid or inverted intervals fail closed so an incomplete resource audit
   * cannot turn into an early server-side hit.
   */
  getMeleeContactWindow(): NpcMeleeContactWindow | undefined {
    const window = this.meleeContactWindow;
    if (!window) return undefined;
    if (
      !Number.isFinite(window.startFraction) ||
      !Number.isFinite(window.endFraction) ||
      window.startFraction < 0 ||
      window.endFraction > 1 ||
      window.startFraction > window.endFraction
    ) {
      return undefined;
    }
    return window;
  }

  /**
   * Check the server's known navigation line before projecting native melee
   * contact.  This is deliberately only an obstruction gate: the client
   * AnimalsPhysics graph still owns the animated 3-D actor/weapon shape.
   * Recast's raycast returns t=1 for an unobstructed segment and a value below
   * one for a hit.  Lightweight protocol fixtures without a NavManager keep
   * the legacy permissive result; a real zone always has the method and fails
   * closed when the query itself cannot be evaluated.
   */
  hasMeleeLineOfSight(targetPosition: Float32Array): boolean {
    const raycast = this.server?.navManager?.raycast;
    if (typeof raycast !== "function") return true;
    if (
      !targetPosition ||
      targetPosition.length < 3 ||
      !Array.from(targetPosition.slice(0, 3)).every(Number.isFinite)
    ) {
      return false;
    }
    try {
      const result = raycast.call(
        this.server.navManager,
        this.state.position,
        targetPosition
      );
      const typedResult = result as {
        success?: unknown;
        t?: unknown;
      };
      // Recast can return a finite `t` together with a failed query status.
      // Treat that as unknown/blocked rather than allowing a malformed or
      // off-mesh ray to authorize a native melee projection.  Lightweight
      // fixtures that only provide `t` remain compatible with the legacy
      // permissive test surface.
      if (
        typedResult.success !== undefined &&
        typedResult.success !== true
      ) {
        return false;
      }
      return (
        result !== null &&
        typeof result === "object" &&
        Number.isFinite(typedResult.t) &&
        Number(typedResult.t) >= 1
      );
    } catch {
      return false;
    }
  }

  /**
   * Return the distance used by the server-side melee candidate gate.
   *
   * Native animal contact is resolved by the client from an attack/actor
   * shape query, not from the two replicated entity origins.  The server does
   * not have those animated weapon and body shapes, so applying the origin Y
   * component to Bear/Wolf's engagement projection rejects valid car/step
   * candidates before the native graph can evaluate them.  Keep the existing
   * full 3-D weapon-table distance for generic NPCs, but make the native
   * animal projection horizontal—the same XZ engagement domain already used
   * by their chase state.  This is still a candidate gate, not a claim that
   * the server has recovered the native hitbox.
   */
  getMeleeTargetDistance(
    targetPosition: Float32Array,
    attackOrigin: Float32Array = this.state.position
  ): number {
    if (targetPosition.length < 3 || attackOrigin.length < 3) {
      return Number.POSITIVE_INFINITY;
    }
    const dx = targetPosition[0] - attackOrigin[0];
    const dy = targetPosition[1] - attackOrigin[1];
    const dz = targetPosition[2] - attackOrigin[2];
    if (![dx, dy, dz].every(Number.isFinite)) {
      return Number.POSITIVE_INFINITY;
    }
    return this.usesNativeAnimalMeleeProjection()
      ? Math.hypot(dx, dz)
      : Math.hypot(dx, dy, dz);
  }

  /**
   * Test a target against the server-side projection of the native melee
   * envelope.
   *
   * A server weapon profile uses its RANGE and MELEE_DETECT_WIDTH as a full
   * 3-D distance/forward-axis gate.  Native animals do not have a recovered
   * server weapon/contact shape: they use the explicit `rangeOverride` supplied
   * by their AI state as an engagement projection and intentionally do not
   * borrow the Machete width.  MELEE_DETECT_HEIGHT is not compared with the
   * network-origin Y values because native contact uses actor/weapon collision
   * shapes, not those origins.  The native candidate distance therefore uses
   * the XZ engagement domain; the client-side graph remains responsible for
   * the actual three-dimensional contact query.
   *
   * A missing profile fails closed.  Test doubles that do not implement this
   * method may keep their explicit compatibility fallback in the AI state
   * machine; production Npcs never fall back to a guessed distance when the
   * configured weapon table is unavailable.
   */
  isMeleeTargetInEnvelope(
    targetPosition: Float32Array,
    attackOrigin: Float32Array = this.state.position,
    attackForward?: [number, number],
    rangeOverride?: number
  ): boolean {
    // Passive native animals keep their attack clip metadata so the client
    // can play the correct reaction when hit, but their FSM has no strike
    // branch.  Fail closed here as well so a future caller cannot accidentally
    // turn the compatibility Machete profile into a Deer/Rabbit attack.
    if (
      this.getNativeMeleeCapability() === "passive" &&
      this.hasNativeAnimalReactionProfile()
    ) {
      return false;
    }
    const nativeAnimalProjection = this.usesNativeAnimalMeleeProjection();
    let profile: NpcMeleeAttackProfile | undefined;
    try {
      profile = this.getMeleeAttackProfile();
    } catch {
      // Native animals carry an explicit AI engagement projection and do not
      // use the compatibility Machete table for reach or width.  Do not make
      // their attack ability depend on an unrelated weapon-definition load;
      // the non-native table-backed path still fails closed below.
      if (!nativeAnimalProjection) return false;
    }
    if (
      (!nativeAnimalProjection && !profile) ||
      targetPosition.length < 3 ||
      attackOrigin.length < 3
    ) {
      return false;
    }

    const finitePosition = (position: Float32Array) =>
      Number.isFinite(position[0]) &&
      Number.isFinite(position[1]) &&
      Number.isFinite(position[2]);
    if (!finitePosition(targetPosition) || !finitePosition(attackOrigin)) {
      return false;
    }

    const envelopeRange = nativeAnimalProjection
      ? rangeOverride
      : profile?.range;
    if (
      !Number.isFinite(envelopeRange) ||
      (envelopeRange as number) <= 0
    ) {
      // A native animal must receive its explicit AI engagement distance; the
      // table's Machete RANGE is never a fallback for this path.
      return false;
    }

    const dx = targetPosition[0] - attackOrigin[0];
    const dz = targetPosition[2] - attackOrigin[2];
    const distance = this.getMeleeTargetDistance(targetPosition, attackOrigin);
    if (!Number.isFinite(distance) || distance > (envelopeRange as number)) {
      return false;
    }

    const forward = attackForward ?? this.getMeleeAttackForward(targetPosition, attackOrigin);
    if (!forward) return false;
    const forwardLength = Math.hypot(forward[0], forward[1]);
    if (!Number.isFinite(forwardLength) || forwardLength <= Number.EPSILON) {
      return false;
    }

    const fx = forward[0] / forwardLength;
    const fz = forward[1] / forwardLength;
    const along = dx * fx + dz * fz;
    const lateral = Math.abs(dx * fz - dz * fx);
    if (along < 0 || along > (envelopeRange as number)) return false;
    // The native graph's hand/claw collision shape is not recovered here.  A
    // forward engagement projection is preferable to applying the unrelated
    // Machete's 0.15m lateral width to a wolf/bear body.
    return (
      nativeAnimalProjection ||
      lateral <= (profile?.detectWidth ?? -1)
    );
  }

  /** Return the current horizontal swing direction, with a test-only target fallback. */
  private getMeleeAttackForward(
    targetPosition: Float32Array,
    attackOrigin: Float32Array
  ): [number, number] | undefined {
    const yaw = this.state.yaw;
    if (Number.isFinite(yaw)) {
      const forward: [number, number] = [Math.sin(yaw), Math.cos(yaw)];
      if (Math.hypot(forward[0], forward[1]) > Number.EPSILON) return forward;
    }

    // Lightweight test doubles may not carry a yaw.  Use the target vector
    // only as a bounded compatibility fallback; a real Npc is initialized
    // with a yaw and attack states turn it before this check.
    const dx = targetPosition[0] - attackOrigin[0];
    const dz = targetPosition[2] - attackOrigin[2];
    const length = Math.hypot(dx, dz);
    if (!Number.isFinite(length) || length <= Number.EPSILON) return undefined;
    return [dx / length, dz / length];
  }

  playAnimation(animationName: string, reactionSourceCharacterId?: string) {
    this.flushExpiredAnimation();
    // Keep the same capability boundary as setAnimation()/the legacy trigger
    // path.  Passive animals may still play Flinch/MeleeFlinch reactions, but
    // they must never enter the shared KnifeSlash attack branch.
    if (
      animationName === "KnifeSlash" &&
      this.nativeMeleeCapability === "passive"
    ) {
      return;
    }

    // A one-shot is a graph edge, not a tick heartbeat.  Several action FSMs
    // can legitimately observe the same transition while a coarse AI tick,
    // a damage reaction, or a late observer handoff is being processed.  If
    // the requested event is already live, re-sending it would restart the
    // client's native clock from frame zero and produce the exact visible
    // symptoms we are trying to eliminate: repeated stand-up/attack poses,
    // a foot plant that never completes, and an action that appears to slide
    // because its locomotion handoff is perpetually postponed.  Keep the
    // existing one-shot authoritative until its own wire clock expires.
    const activeAnimation = this.activeAnimation;
    if (
      activeAnimation &&
      Date.now() < activeAnimation.expiresAt &&
      activeAnimation.packet.animationName === animationName &&
      !this.activeAnimationResetQueued
    ) {
      return;
    }

    // The action edge can be emitted by damage/recovery paths that did not
    // first call stopMovement().  Suspend the authoritative path before the
    // packet so the client cannot keep blending the previous gait underneath
    // a Flinch, wake-up, attack, or special-zombie one-shot.
    this.suspendLocomotionForAnimation();

    // `currentAnimation` is only the persistent loop/reset clip replayed to a
    // late observer during AddLightweightNpc.  A one-shot action supersedes
    // that clip; retaining it would make a late observer receive a stale
    // Idle/Eating/Reset packet immediately before the current action state.
    this.currentAnimation = "";
    this.lastAnimationEvent = animationName;
    const packet = reactionSourceCharacterId
      ? this.createVerifiedHitReactionPacket(
          animationName,
          reactionSourceCharacterId
        )
      : this.createVerifiedOneShotAnimationPacket(animationName);
    const durationMs = Number(packet.unknownDword2);
    this.clearAnimationExpiryTimer();
    this.activeAnimation = {
      packet,
      // The client consumes unknownDword2 as a millisecond-scaled native
      // action clock. Retain the same one-shot for a late observer only while
      // that clock can still be active; after it expires, fall back to the
      // last persistent reset clip.
      expiresAt:
        Date.now() +
        (Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0)
    };
    this.activeAnimationResetQueued = false;
    this.armAnimationExpiryTimer(this.activeAnimation.expiresAt);
    this.server.sendDataToAllWithSpawnedEntity<CharacterPlayAnimation>(
      this.server._npcs,
      this.characterId,
      "Character.PlayAnimation",
      packet
    );
  }

  /**
   * Stop the visible locomotion stream for a newly started one-shot while
   * retaining an already requested path for the expiry handoff.
   */
  private suspendLocomotionForAnimation(): void {
    const resumeSpeed =
      this.expectedSpeed !== undefined && this.expectedSpeed > 0
        ? this.expectedSpeed
        : this.navAgent && this.navAgent.maxSpeed > 0
          ? this.navAgent.maxSpeed
          : undefined;
    if (resumeSpeed !== undefined) this.pendingAnimationSpeed = resumeSpeed;
    this.pathfindingMovementSuppressed = true;
    // Explicit native-root-motion experiments must obey the same action
    // boundary.  Otherwise the client-side seek controller can keep steering
    // while ExpectedSpeed/PlayerUpdatePosition have been stopped.
    this.clearNativeSeekTarget();
    const hadAdvertisedSpeed =
      this.expectedSpeed !== undefined && this.expectedSpeed > 0;
    this.expectedSpeed = 0;
    this.pendingExpectedSpeed = undefined;
    if (this.navAgent) {
      this.navAgent.maxSpeed = 0;
      this.navAgent.maxAcceleration = 0;
      this.navAgent.requestMoveVelocity?.({ x: 0, y: 0, z: 0 });
    }
    const motion = this.lastWireMotion;
    const hadMovingWireStance =
      motion !== undefined &&
      (motion.stance === Npc.STANCE_MOVE_STANDING ||
        motion.stance === Npc.STANCE_MOVE_STANDING_SPRINTING ||
        motion.horizontalSpeed > 1e-4 ||
        motion.verticalSpeed > 1e-4);
    if (hadAdvertisedSpeed) this.emitExpectedSpeed(0);
    if (hadAdvertisedSpeed || hadMovingWireStance) this.sendIdleStance();
  }

  /**
   * Keep the one-shot/reset boundary observable even when an actor has no
   * active FSM tick.  This is important for BasicNpc/AI-disabled spawns and
   * for a late transition out of a special action: relying only on the next
   * caller of flushExpiredAnimation() leaves existing observers in a stale
   * pose indefinitely.
   */
  private armAnimationExpiryTimer(expiresAt: number): void {
    const delay = Math.max(0, expiresAt - Date.now()) + 1;
    this.animationExpiryTimer = setTimeout(() => {
      this.animationExpiryTimer = undefined;
      this.flushExpiredAnimation();
    }, delay);
    // Timers must not keep a test/server process alive after the actor is no
    // longer referenced.  Production still receives the callback while the
    // event loop is active; unref only removes the process-liveness side effect.
    const timer = this.animationExpiryTimer as unknown as {
      unref?: () => void;
    };
    timer.unref?.();
  }

  private clearAnimationExpiryTimer(): void {
    if (this.animationExpiryTimer === undefined) return;
    clearTimeout(this.animationExpiryTimer);
    this.animationExpiryTimer = undefined;
  }

  /**
   * Return the complete action/reset packet for a late observer, if any.
   *
   * AddLightweightNpc is followed by this handoff. During an active one-shot,
   * replaying the persistent Idle clip would cancel or mask the action on the
   * newly relevant client; after the action clock expires, not replaying
   * anything would leave that client in the default graph forever.
   */
  getCurrentAnimationPacket(): CharacterPlayAnimation | undefined {
    // A relevance/full-data request can arrive in the small window after the
    // native action clock has elapsed but before the expiry timer callback is
    // serviced by the event loop.  Do not settle the private state here by
    // simply dropping activeAnimation: that leaves existing observers on the
    // old one-shot and leaves any pending movement speed suppressed.  Reuse
    // the causal expiry path so the reset edge, movement handoff, and late
    // observer all see the same lifecycle boundary.
    this.flushExpiredAnimation();
    if (this.activeAnimation) {
      if (Date.now() < this.activeAnimation.expiresAt) {
        return this.activeAnimation.packet;
      }
      // flushExpiredAnimation() normally consumes an expired action.  Keep a
      // defensive fallback for a partially initialized legacy test double
      // whose server/sender surface cannot publish the reset edge.
      this.clearAnimationExpiryTimer();
      this.activeAnimation = undefined;
      this.activeAnimationResetQueued = false;
      this.currentAnimation = this.persistentAnimation;
    }
    if (!this.currentAnimation && this.persistentAnimation) {
      this.currentAnimation = this.persistentAnimation;
    }
    if (!this.currentAnimation) return undefined;
    return this.createVerifiedAnimationPacket(this.currentAnimation);
  }

  /**
   * Build the complete native Character.PlayAnimation payload.
   *
   * The 2016 client parser does not treat the fields after animationName as
   * optional metadata: they are consumed by the animation-network event
   * handler.  A live KnifeSlash probe that reached AttackStand_Ping used
   * dword1=0, dword2=1430 and float3=0.  Supplying only animationName lets
   * DataSchema fill dword1/float3 with its historical 1430 defaults, which
   * changes the event parameters for every NPC one-shot and can leave the
   * attack transition out of sync with the movement stop.
   */
  private createVerifiedOneShotAnimationPacket(
    animationName: string
  ): CharacterPlayAnimation {
    return this.createVerifiedAnimationPacket(animationName);
  }

  /**
   * Add the native directional graph parameter to a Zombie001 hit reaction.
   * AnimalsPhysics has its own `MeleeFlinch` event and must not receive this
   * Zombie-only selector; the caller resolves the public event before using
   * this helper.
   */
  private createVerifiedHitReactionPacket(
    animationName: string,
    sourceCharacterId: string
  ): CharacterPlayAnimation {
    const packet = this.createVerifiedAnimationPacket(animationName);
    if (animationName !== "Flinch") return packet;
    const direction = this.getNativeFlinchDirection(sourceCharacterId);
    if (direction === undefined) return packet;
    packet.animationType = "FlinchDirection";
    packet.unknownDword3 = direction;
    return packet;
  }

  /**
   * Mirror the client-side four-sector heading conversion used by
   * `FUN_14051fb40`.  This uses actor yaw only, exactly like the player path;
   * if either entity has no finite heading the generic Flinch event remains a
   * safe fallback instead of inventing a direction from an arbitrary point.
   */
  private getNativeFlinchDirection(
    sourceCharacterId: string
  ): number | undefined {
    if (!sourceCharacterId || typeof this.server?.getEntity !== "function") {
      return undefined;
    }
    let source: { state?: { yaw?: number } } | undefined;
    try {
      source = this.server.getEntity(sourceCharacterId) as
        | { state?: { yaw?: number } }
        | undefined;
    } catch {
      return undefined;
    }
    const targetYaw = this.state?.yaw;
    const sourceYaw = source?.state?.yaw;
    if (!Number.isFinite(targetYaw) || !Number.isFinite(sourceYaw)) {
      return undefined;
    }

    let relativeDegrees =
      (targetYaw as number - (sourceYaw as number)) *
        NATIVE_FLINCH_DIRECTION_DEGREES_PER_RADIAN -
      NATIVE_FLINCH_DIRECTION_OFFSET_DEGREES;
    relativeDegrees %=
      NATIVE_FLINCH_DIRECTION_SECTOR_DEGREES *
      NATIVE_FLINCH_DIRECTION_SECTOR_COUNT;
    if (relativeDegrees < 0) relativeDegrees += 360;

    // The retail instruction is CVTTSS2SI: truncation toward zero, not floor.
    let direction = Math.trunc(
      relativeDegrees * NATIVE_FLINCH_DIRECTION_SECTOR_SCALE
    );
    if (direction < 0) direction += NATIVE_FLINCH_DIRECTION_SECTOR_COUNT;
    return Math.max(
      0,
      Math.min(NATIVE_FLINCH_DIRECTION_SECTOR_COUNT - 1, direction)
    );
  }

  /**
   * Build the same complete wire payload for a persistent/reset clip.
   *
   * `setAnimation()` is used after stand-up/howl/attack actions to hand the
   * entity back to its locomotion graph, and the exact same packet is replayed
   * when a late observer first sees the NPC.  Sending the short historical
   * object on those paths leaves the animation event with a different set of
   * defaults than the live one-shot path, so keep one payload contract for
   * every server-originated Character.PlayAnimation event.
   */
  private createVerifiedAnimationPacket(
    animationName: string
  ): CharacterPlayAnimation {
    const nativeAttackSpeed =
      animationName === "KnifeSlash" && this.hasNativeAnimalReactionProfile()
        ? NATIVE_ANIMAL_ATTACK_SPEED
        : undefined;
    return {
      characterId: this.characterId,
      animationName,
      unm4: 0,
      unknownDword1: 0,
      unknownByte1: 0,
      unknownDword2: this.getAnimationWireDurationMs(animationName),
      animationType:
        nativeAttackSpeed === undefined
          ? ""
          : NATIVE_ANIMAL_ATTACK_SPEED_PARAMETER,
      unknownByte1xda: 0,
      unknownDword3: nativeAttackSpeed ?? 0
    };
  }

  /**
   * Resolve the duration field carried by Character.PlayAnimation.
   *
   * The field is consumed by the native animation-network event handler as a
   * millisecond-scaled graph parameter.  Howl and StandUp have one
   * unambiguous public one-shot.  KnifeSlash uses the actor's recovered
   * native clip duration when the concrete animal entity has one; otherwise
   * it retains the 1430ms live probe as a bounded compatibility fallback.
   */
  private getAnimationWireDurationMs(animationName: string): number {
    const recoveredZombieActionDuration =
      ZOMBIE_NATIVE_ACTION_DURATION_MS[animationName];
    if (
      recoveredZombieActionDuration !== undefined &&
      Number.isFinite(recoveredZombieActionDuration) &&
      recoveredZombieActionDuration > 0
    ) {
      return recoveredZombieActionDuration;
    }
    switch (animationName) {
      case "WolfHowl":
        return Npc.NATIVE_WOLF_HOWL_DURATION_MS;
      case "StandUp":
        return Npc.NATIVE_BEAR_STANDUP_DURATION_MS;
      case "CoverEars":
        return Npc.ZOMBIE_COVER_EARS_DURATION_MS;
      case "ExplodeContract":
        return Npc.ZOMBIE_EXPLODE_CONTRACT_DURATION_MS;
      case "GasConvulse":
        return Npc.ZOMBIE_GAS_CONVULSE_DURATION_MS;
      case "ScreamerRise":
        return Npc.SCREAMER_RISE_DURATION_MS;
      case "Scream":
        return Npc.SCREAMER_SCREAM_DURATION_MS;
      case "KnifeSlash":
        if (
          Number.isFinite(this.nativeMeleeAnimationDurationMs) &&
          (this.nativeMeleeAnimationDurationMs as number) > 0
        ) {
          return Math.round(this.nativeMeleeAnimationDurationMs as number);
        }
        return Npc.NATIVE_MELEE_ANIMATION_DURATION_MS;
      case "MeleeFlinch":
      case "Flinch":
        if (
          Number.isFinite(this.nativeMeleeFlinchAnimationDurationMs) &&
          (this.nativeMeleeFlinchAnimationDurationMs as number) > 0
        ) {
          return Math.round(
            this.nativeMeleeFlinchAnimationDurationMs as number
          );
        }
        return Npc.NATIVE_MELEE_ANIMATION_DURATION_MS;
      default:
        return Npc.NATIVE_MELEE_ANIMATION_DURATION_MS;
    }
  }

  /**
   * Return the same action clock that will be carried in PlayAnimation.
   *
   * FSMs use this only as a diagnostics/compatibility boundary; the normal
   * completion test remains `isAnimationActive()`, which is based on the
   * installed expiry timestamp and therefore also handles a replacement
   * reaction cancelling the original action.
   */
  getAnimationDurationMs(animationName: string): number {
    return this.getAnimationWireDurationMs(animationName);
  }

  /**
   * AnimalsPhysics exposes its own reaction events.  Keep the profile check
   * in one place so player, projectile, and NPC-to-NPC hit paths cannot drift
   * into sending an animal event to zombies or compatibility-only actors.
   */
  private hasNativeAnimalReactionProfile(): boolean {
    return (
      this.nativeLocomotionProfile?.source ===
        ANIMAL_NATIVE_LOCOMOTION_PROFILE.source &&
      typeof this.nativeMeleeAnimationSource === "string" &&
      this.nativeMeleeAnimationSource.startsWith("Animals_")
    );
  }

  /**
   * Publish the hit-reaction edge for every NPC graph, not only AnimalsPhysics.
   *
   * The public event names are model-family specific: the recovered
   * AnimalsPhysics graph exposes `MeleeFlinch`, while the Zombie001 and
   * compatibility graphs expose `Flinch` for the same surviving melee-hit
   * presentation.  Resolve that distinction here so the four damage entry
   * points cannot accidentally send an animal event to a zombie (or leave a
   * zombie in its attack/locomotion pose).  The model's native graph owns the
   * actual clip; the server only publishes the event and its clock.
   * `nonAttackable` is the existing wire capability bit that explicitly
   * suppresses melee flinch for actors which opt out of that reaction.
   */
  private emitNpcHitReaction(
    animationName: "MeleeFlinch" | "Flinch",
    sourceCharacterId?: string
  ): void {
    if (!this.isAlive || this.flags?.nonAttackable) return;
    const resolvedAnimation =
      animationName === "MeleeFlinch" && this.hasNativeAnimalReactionProfile()
        ? "MeleeFlinch"
        : "Flinch";
    this.playAnimation(resolvedAnimation, sourceCharacterId);
  }

  /**
   * Deliver the normal client-side impact presentation for an NPC melee hit.
   *
   * `Character.damage()` deliberately returns early for god mode, but that
   * protection must not erase the hit presentation while we are validating
   * NPC contact in-game.  Keep the feedback packet separate from health and
   * bleed mutation so a protected player can still show the same directional
   * hit reaction as a real hit.  The helper is also useful for native/test
   * attack paths that intentionally suppress `OnMeleeHit`.
   */
  sendMeleeDamageFeedback(characterId: string): boolean {
    const client = this.server.getClientByCharId(characterId);
    const character = client?.character;
    if (
      client?.isLoading !== false ||
      !character ||
      character.isAlive === false ||
      character.isRespawning ||
      typeof character.sendDamageFeedback !== "function"
    ) {
      return false;
    }

    const damageInfo = createNpcMeleeDamageInfo(this);
    damageInfo.hitReport!.hitLocation = character.meleeHit?.abilityHitLocation;
    return Boolean(character.sendDamageFeedback(this.server, damageInfo));
  }

  removeEffectTag(effectId: number) {
    const index = this.effectTags.indexOf(effectId);
    if (index <= -1) return;
    this.effectTags.splice(index, 1);
    this.server.sendDataToAllWithSpawnedEntity(
      this.server._npcs,
      this.characterId,
      "Character.RemoveEffectTagCompositeEffect",
      {
        characterId: this.characterId,
        effectId: effectId,
        newEffectId: 0
      }
    );
  }

  applyDamage(characterId: string) {
    const client = this.server.getClientByCharId(characterId);
    if (client?.isLoading === false) {
      const damageInfo = createNpcMeleeDamageInfo(this);
      damageInfo.hitReport!.hitLocation =
        client.character.meleeHit.abilityHitLocation;

      // Protected/restarting players still receive the directional feedback
      // used by the client hit-reaction path, but no gameplay target (the
      // character or its mounted vehicle) should be damaged in that replay.
      const damageWillBeSuppressed =
        client.character.isGodMode?.() === true ||
        client.character.isAlive === false ||
        client.character.isRespawning === true;
      if (damageWillBeSuppressed) {
        this.sendMeleeDamageFeedback(characterId);
        // God/replay protection intentionally suppresses health mutation, but
        // it must not suppress the native player flinch used to verify the
        // contact phase in-game.
        client.character.sendNpcMeleeFlinch?.(this.server, damageInfo);
        return;
      }

      const mountedVehicleId = client.vehicle.mountedVehicle;
      if (mountedVehicleId) {
        const vehicle = this.server._vehicles[mountedVehicleId];
        if (vehicle) {
          // A mounted player's character remains a valid NPC melee target.
          // The old early return delegated only to Vehicle.OnMeleeHit; on a
          // PvE server that method intentionally ignores non-wrench vehicle
          // hits, so a zombie/bear could swing through a rider with no health
          // or hit-reaction update.  Preserve the vehicle hook for servers
          // that use it, but continue to the character hit path below.  Clone
          // the report because vehicle handlers are allowed to scale/mutate
          // their local damage record.
          vehicle.OnMeleeHit(this.server, {
            ...damageInfo,
            hitReport: damageInfo.hitReport
              ? { ...damageInfo.hitReport }
              : undefined
          });
        }
      }

      // Character.damage() emits the normal hit feedback after a successful
      // health mutation.  The protected path returned above, so the normal
      // path must not send a second presentation packet here.
      client.character.OnMeleeHit(this.server, damageInfo);
      // Character.damage() sends DamageInfo after the health update.  The
      // native player animation graph is a separate event, so emit its
      // Flinch event only when the target survived the accepted contact.
      if (client.character.isAlive) {
        client.character.sendNpcMeleeFlinch?.(this.server, damageInfo);
      }
      if (this.server.isSurvival() && this.server.infectionEnabled) {
        const virus = client.character._resources[ResourceIds.VIRUS];
        if (virus > 0) {
          client.character.immunity = Math.max(
            0,
            client.character.immunity - 50
          );
        } else {
          client.character._resources[ResourceIds.VIRUS] = 200;
          this.server.updateResource(
            client,
            client.character.characterId,
            200,
            ResourceIds.VIRUS,
            ResourceTypes.VIRUS
          );
        }
      }
    } else {
      console.log(
        `CharacterId ${characterId} not found when applying damage from npc`
      );
    }
  }

  /**
   * Apply an NPC-origin melee hit without using the player hit path.
   *
   * Bear/Wolf/zombie attacks on another NPC intentionally keep the full
   * configured NPC damage and must not run `OnMeleeHit()` (that hook applies
   * the player weapon scaling/durability contract).  They still need the same
   * graph hit-reaction edge as a player/projectile hit when the victim
   * survives.
   */
  applyNpcMeleeHit(server: ZoneServer2016, damageInfo: DamageInfo): void {
    if (!this.isAlive) return;
    void this.damage(server, damageInfo);
    // `damage()` updates deathTime synchronously before returning its
    // promise. A lethal hit belongs to the death graph, not a late reaction
    // one-shot on an already dead animal.
    this.emitNpcHitReaction("MeleeFlinch", damageInfo.entity);
  }

  async damage(server: ZoneServer2016, damageInfo: DamageInfo) {
    let client = server.getClientByCharId(damageInfo.entity);
    if (!client) {
      const sourceEntity = server.getEntity(damageInfo.entity);
      if (sourceEntity instanceof ProjectileEntity) {
        client = server.getClientByCharId(sourceEntity.managerCharacterId);
      }
    }
    const oldHealth = this.health;

    if ((this.health -= damageInfo.damage) <= 0 && this.isAlive) {
      this.deathTime = Date.now();
      this.flags.knockedOut = 1;

      // Death is an action boundary just like an attack/idle transition.
      // Clear Recast and the native seek rail before StartMultiStateDeath is
      // delivered; otherwise a predator that dies while chasing can keep its
      // previous target/velocity alive until the client finishes entering the
      // death graph, which renders as a corpse slide or a late foot step.
      this.stopMovement();

      this.addLoot(server);

      if (client) {
        if (this.npcId === NpcIds.ZOMBIE) {
          server.challengeManager.registerChallengeProgression(
            client,
            ChallengeType.BRAIN_DEAD,
            1
          );
        }
        if (!server._soloMode) {
          logClientActionToMongo(
            server._db.collection(DB_COLLECTIONS.KILLS),
            client,
            server._worldId,
            {
              type:
                this.npcId == NpcIds.ZOMBIE
                  ? KILL_TYPE.ZOMBIE
                  : KILL_TYPE.WILDLIFE
            }
          );
        }

        if (this.npcId == NpcIds.ZOMBIE)
          client.character.metrics.zombiesKilled++;
        else client.character.metrics.wildlifeKilled++;
      }
      const observers = server._entityObservers.get(this.characterId);
      if (observers) {
        for (const c of observers) {
          if (!c.isLoading) {
            server.sendData(c, "Character.StartMultiStateDeath", {
              data: {
                characterId: this.characterId,
                flag: 128,
                managerCharacterId: c.character.characterId
              }
            });
            server.sendData(c, "Character.ManagedObject", {
              objectCharacterId: this.characterId,
              characterId: c.character.characterId
            });
          } else {
            server.sendData(c, "Character.StartMultiStateDeath", {
              data: {
                characterId: this.characterId,
                flag: 0
              }
            });
          }
        }
      }
    }

    if (client) {
      const damageRecord = server.generateDamageRecord(
        this.characterId,
        damageInfo,
        oldHealth
      );
      client.character.addCombatlogEntry(damageRecord);
    }

    if (
      !this.isAlive &&
      this.effectTags.includes(Effects.PFX_Char_Zombie_Gasser_Ambient)
    ) {
      const GASSER_DEATH_EXPLOSION_RANGE = 10;
      const GASSER_DEATH_EXPLOSION_DAMAGE = Math.floor(10000 / 3);

      this.removeEffectTag(Effects.PFX_Char_Zombie_Gasser_Ambient);

      for (const character of Object.values(server._characters)) {
        if (!character.isAlive) continue;
        if (
          getDistanceSquared(character.state.position, this.state.position) >
          GASSER_DEATH_EXPLOSION_RANGE * GASSER_DEATH_EXPLOSION_RANGE
        )
          continue;

        character.damage(server, {
          entity: this.characterId,
          damage: GASSER_DEATH_EXPLOSION_DAMAGE
        });
      }

      server.sendCompositeEffectToAllInRange(
        100,
        this.characterId,
        this.state.position,
        Effects.PFX_Char_Zombie_Gasser_ExplosionGasCloud
      );

      spawnGasCloudAt(server, this.state.position, this.characterId);
    }
  }

  OnFullCharacterDataRequest(server: ZoneServer2016, client: ZoneClient2016) {
    server.sendData(client, "LightweightToFullNpc", this.pGetFull(server));

    // AddLightweightNpc is sent before the client asks for this full payload.
    // The initial animation/locomotion edges are normally sent alongside the
    // lightweight spawn, but a client can request the conversion after that
    // edge was queued (or while a one-shot is already in flight).  Replaying
    // the current graph inputs after LightweightToFullNpc makes the handoff
    // causal: the actor is complete before the client receives Idle, an
    // action clip, ExpectedSpeed, SeekTarget, look-at, or combat state.  The
    // optional calls keep the legacy readiness test doubles, which invoke
    // this prototype method with a partial object, compatible.
    const animationPacket = this.getCurrentAnimationPacket?.();
    if (animationPacket) {
      server.sendData(client, "Character.PlayAnimation", animationPacket);
    }
    this.sendInitialLocomotionState?.(client);

    if (this.onReadyCallback) {
      this.onReadyCallback(client);
      delete this.onReadyCallback;
    }
  }

  OnExplosiveHit(server: ZoneServer2016, sourceEntity: BaseEntity): void {
    let damage = this.health + this.health / 2;

    const distance = getDistance(
      sourceEntity.state.position,
      this.state.position
    );
    if (distance > 5) return;
    if (distance > 1) damage /= distance;
    void this.damage(server, {
      entity: sourceEntity.characterId,
      damage: damage
    });
    // Keep the general AnimalsPhysics reaction path in sync with projectile
    // hits.  Explosions can leave an animal alive; without this event its
    // locomotion/attack pose survives the accepted damage indefinitely.
    this.emitNpcHitReaction("Flinch", sourceEntity.characterId);
  }

  OnProjectileHit(server: ZoneServer2016, damageInfo: DamageInfo) {
    if (
      server.isHeadshotOnly &&
      damageInfo.hitReport?.hitLocation != "HEAD" &&
      this.isAlive
    )
      return;
    const client = server.getClientByCharId(damageInfo.entity);
    if (client && this.isAlive) {
      const hasHelmetBefore = this.hasHelmet(server);
      const hasArmorBefore = this.hasArmor(server);
      server.sendHitmarker(
        client,
        damageInfo.hitReport?.hitLocation,
        this.hasHelmet(server),
        this.hasArmor(server),
        hasHelmetBefore,
        hasArmorBefore
      );
    }
    switch (damageInfo.hitReport?.hitLocation) {
      case "HEAD":
      case "GLASSES":
      case "NECK":
        damageInfo.damage *= 4;
        break;
      default:
        break;
    }
    void this.damage(server, damageInfo);

    // Projectile hits use the public Flinch edge in both graph families.  The
    // helper is deliberately called after damage() so a lethal projectile
    // enters the death graph instead of receiving a late one-shot.
    this.emitNpcHitReaction("Flinch", damageInfo.entity);
  }

  OnMeleeHit(server: ZoneServer2016, damageInfo: DamageInfo) {
    if (!this.isAlive) return; // prevent dead npc despawning from melee dmg
    damageInfo.damage = damageInfo.damage / 1.5;
    void this.damage(server, damageInfo);

    // `emitNpcHitReaction` maps this melee request to the model-family event:
    // AnimalsPhysics receives MeleeFlinch, while Zombie001/compatibility NPCs
    // receive Flinch.  Every live NPC therefore leaves its current
    // locomotion/attack pose for the native hit-reaction branch.
    this.emitNpcHitReaction("MeleeFlinch", damageInfo.entity);

    const client = server.getClientByCharId(damageInfo.entity);
    if (!client) return;
    const weapon = client.character.getEquippedWeapon();
    if (!weapon) return;

    const durabilityDamage = server.getDurabilityDamage(
      weapon.itemDefinitionId
    );

    server.damageItem(client.character, weapon, durabilityDamage);
  }

  destroy(server: ZoneServer2016): boolean {
    return server.deleteEntity(this.characterId, server._npcs);
  }

  OnPlayerSelect(server: ZoneServer2016, client: ZoneClient2016) {
    // Only one at a time
    if (this.isSelected) {
      return;
    }
    this.isSelected = true;
    // Unlock selection after 5sec
    // It's easier to do it that way that to make a whole sys with the utilizeHudTimer
    setTimeout(() => {
      this.isSelected = false;
    }, 5_100);
    const skinningKnife = client.character.getItemById(Items.SKINNING_KNIFE);
    if (!this.isAlive && skinningKnife) {
      server.utilizeHudTimer(client, this.nameId, 5000, 0, () => {
        this.onHarvest(server, client);
        server.damageItem(client.character, skinningKnife, 200);
        server.deleteEntity(this.characterId, server._npcs);
      });
    }
  }

  triggerAwards(
    server: ZoneServer2016,
    client: ZoneClient2016,
    rewardItems: { itemDefId: number; weight: number }[]
  ) {
    const ranges = [];
    const preRewardedItems: number[] = [];
    let cumulativeWeight = 0;
    for (const reward of rewardItems) {
      const range = {
        start: cumulativeWeight,
        end: cumulativeWeight + reward.weight,
        item: reward
      };
      ranges.push(range);
      cumulativeWeight = range.end;
    }

    const totalWeight = rewardItems.reduce((sum, item) => sum + item.weight, 0);
    let count = 1;

    let selectedRange = ranges[0];
    for (let i = 0; i < rewardItems.length; i++) {
      const randomValue = Math.random() * totalWeight;
      for (const range of ranges) {
        if (randomValue >= range.start && randomValue < range.end) {
          selectedRange = range;
          break; // Break out of the loop once a range is chosen
        }
      }

      if (!preRewardedItems.includes(selectedRange.item.itemDefId)) {
        preRewardedItems.push(selectedRange.item.itemDefId);

        if (
          Math.random() <= 0.4 &&
          selectedRange.item.itemDefId != Items.BRAIN_INFECTED
        ) {
          // 40% chance to spawn double rewards
          count = 2;
        }

        const rewardItem = server.generateItem(
          selectedRange.item.itemDefId,
          count
        );
        if (rewardItem) client.character.lootContainerItem(server, rewardItem);
      }
    }
  }

  OnInteractionString(server: ZoneServer2016, client: ZoneClient2016) {
    if (!this.isAlive && client.character.hasItem(Items.SKINNING_KNIFE)) {
      this.buildInteractionString(server, client);
    }
  }

  sendInteractionString(
    server: ZoneServer2016,
    client: ZoneClient2016,
    stringId: number
  ) {
    server.sendData<CommandInteractionString>(
      client,
      "Command.InteractionString",
      {
        guid: this.characterId,
        stringId: stringId
      }
    );
  }

  stopMovement() {
    this.flushExpiredAnimation();
    // The client may still own a native seek rail even after Recast has been
    // reset.  Release that controller at the same boundary as the zero-speed
    // ExpectedSpeed/PlayerUpdatePosition handoff so an attack or idle state
    // cannot continue sliding toward the previous target.
    this.clearNativeSeekTarget();
    // Keep the last sample only long enough to determine whether the client
    // was in the locomotion stream.  Repeated stop calls are common while an
    // action state waits for the nav agent to decelerate, so emit the handoff
    // once and leave the sample cleared afterwards.
    const hadMotionSample = this.lastMotionSample !== undefined;
    // `lookAt()` deliberately clears lastMotionSample after publishing a
    // facing-only packet.  Other action transitions can reach this method
    // without that packet (for example a target/lifecycle edge), while the
    // client still holds the previous moving stance.  Preserve that edge
    // explicitly so ExpectedSpeed=0 is accompanied by the zero-speed wire
    // sample that ends the locomotion graph.
    const advertisedMotion = this.lastWireMotion;
    const hadAdvertisedMotion =
      this.expectedSpeed !== undefined && this.expectedSpeed > 0;
    const hadMovingWireStance =
      advertisedMotion !== undefined &&
      (advertisedMotion.stance === Npc.STANCE_MOVE_STANDING ||
        advertisedMotion.stance === Npc.STANCE_MOVE_STANDING_SPRINTING ||
        advertisedMotion.horizontalSpeed > 1e-4 ||
        advertisedMotion.verticalSpeed > 1e-4);
    this.pathfindingMovementSuppressed = true;
    this.lastMotionSample = undefined;
    this.movingMotionSamplesSinceStop = 0;
    this.locomotionMode = "walk";
    if (this.navAgent) {
      this.navAgent.resetMoveTarget();
      // Resetting a target only clears the path request; Recast can retain
      // the previous desired velocity for the next crowd step.  Submit an
      // explicit zero-velocity request so an action/idle transition cannot
      // leak the previous sprint into its animation window.
      this.navAgent.requestMoveVelocity?.({ x: 0, y: 0, z: 0 });
      // Keep the crowd's interpolated position on the same side of the
      // action boundary as the authoritative game state.  Otherwise a
      // resumed chase can publish a catch-up jump from a stale Recast sample.
      const testVerticalOffset =
        Number.isFinite(this.testHarnessVerticalOffset)
          ? (this.testHarnessVerticalOffset as number)
          : 0;
      this.navAgent.teleport?.({
        x: this.state.position[0],
        y: this.state.position[1] - testVerticalOffset,
        z: this.state.position[2]
      });
    }
    // Keep the client-side expected-speed controller in the same stopped
    // state as the authoritative nav agent.  Without this edge, a chase
    // leaves its sprint speed advertised through the attack wind-up even
    // though the position stream has already switched to an idle stance.
    this.setSpeed(0);
    if (hadMotionSample || hadAdvertisedMotion || hadMovingWireStance) {
      this.sendIdleStance();
    }
  }

  /**
   * Publish a zero-speed standing sample when navigation is cancelled.
   * `PlayerUpdatePosition` is the client's locomotion input; clearing the
   * Recast target alone leaves the last sprint sample active until another
   * position packet arrives, which can make action animations slide.
   */
  sendIdleStance() {
    const sequenceTime = getCurrentServerTimeWrapper().getTruncatedU32();
    const motion: NpcPositionUpdateMotion = {
      stance: Npc.STANCE_STANDING,
      engineRPM: 0,
      orientation: this.state.yaw ?? 0,
      frontTilt: 0,
      sideTilt: 0,
      angleChange: 0,
      verticalSpeed: 0,
      horizontalSpeed: 0
    };
    this.lastWireMotion = {
      sequenceTime,
      stance: motion.stance,
      horizontalSpeed: motion.horizontalSpeed,
      verticalSpeed: motion.verticalSpeed,
      orientation: motion.orientation
    };
    this.lastStoppedMotionSample = {
      sequenceTime,
      position: [
        this.state.position[0],
        this.state.position[1],
      this.state.position[2]
    ]
    };
    this.movingMotionSamplesSinceStop = 0;
    this.server.sendDataToAllWithSpawnedEntity(
      this.server._npcs,
      this.characterId,
      "PlayerUpdatePosition",
      {
        transientId: this.transientId,
        positionUpdate: {
          ...createNpcPositionUpdate(this.state.position, sequenceTime, motion),
          unknown3_int8: this.movementVersion ?? 0
        }
      }
    );
  }

  goTo(position: Float32Array) {
    const previousPosition = this.state.position;
    const movementDx = position[0] - previousPosition[0];
    const movementDy = position[1] - previousPosition[1];
    const movementDz = position[2] - previousPosition[2];
    const movementHorizontalDist = Math.hypot(movementDx, movementDz);
    // Recast may report a desired velocity on the first crowd tick before an
    // authoritative position displacement exists.  For native animals that
    // prediction must not select a moving gait, or the client can render the
    // observed start-slide while the server is still standing.
    const hasAuthoritativeDisplacement =
      movementHorizontalDist > 1e-4 || Math.abs(movementDy) > 1e-4;

    // A navmesh agent may take a corner or detour around an obstacle while
    // its target remains the player.  Facing that target on every position
    // sample makes the client blend a forward locomotion graph with a
    // sideways/diagonal displacement (the visible slide).  While moving,
    // orient from the authoritative displacement; only a stationary sample
    // uses lookAtTarget for an attack/facing update.
    // Vertical navmesh links/stair steps carry no horizontal displacement.
    // In that case retain the last heading unless there is a real horizontal
    // look-at target.  `atan2(0, 0)` would otherwise snap the NPC to yaw 0 on
    // every height-only sample.  The tilt is always derived from the actual
    // position delta; using lookAtTarget.y here makes a nearby player on a
    // vehicle/step incorrectly tilt the NPC while it is standing still.
    let dx = movementDx;
    let dz = movementDz;
    let orientation = this.state.yaw ?? 0;
    if (movementHorizontalDist <= 1e-4 && this.lookAtTarget) {
      const lookDx = this.lookAtTarget[0] - previousPosition[0];
      const lookDz = this.lookAtTarget[2] - previousPosition[2];
      if (Math.hypot(lookDx, lookDz) > 1e-4) {
        dx = lookDx;
        dz = lookDz;
        orientation = Math.atan2(lookDx, lookDz);
      }
    } else if (movementHorizontalDist > 1e-4) {
      orientation = Math.atan2(movementDx, movementDz);
    }

    const horizontalDist = Math.hypot(dx, dz);
    const prevOrientation = this.state.yaw ?? orientation;
    let angleChange = orientation - prevOrientation;
    // normalize to [-π, π]
    angleChange = Math.atan2(Math.sin(angleChange), Math.cos(angleChange));
    this.state.yaw = orientation;
    const frontTilt = Math.atan2(movementDy, movementHorizontalDist);

    const sinO = Math.sin(orientation);
    const cosO = Math.cos(orientation);

    const lateralDist = movementDx * cosO - movementDz * sinO;

    const sideTilt = Math.atan2(lateralDist, horizontalDist);

    this.state.position = position;
    // Keep the spawn/state quaternion coherent with the yaw carried by the
    // movement packet.  The client consumes the packet orientation for the
    // live sample, while a late observer or a re-spawn reads state.rotation;
    // leaving the latter at its old heading creates a one-frame turn snap.
    this.state.rotation = eul2quat(new Float32Array([orientation, 0, 0]));

    const sequenceTime = getCurrentServerTimeWrapper().getTruncatedU32();
    let horizontalSpeed: number;
    let verticalSpeed: number;
    const readNavVelocity = () => {
      if (!this.navAgent) return undefined;
      const vel = this.navAgent.velocity();
      return {
        horizontalSpeed: Math.sqrt(vel.x * vel.x + vel.z * vel.z),
        verticalSpeed: Math.abs(vel.y)
      };
    };
    const motionAnchor = this.lastMotionSample ?? this.lastStoppedMotionSample;
    const resumedFromStop =
      this.lastMotionSample === undefined &&
      this.lastStoppedMotionSample !== undefined;
    if (motionAnchor) {
      const elapsedMs =
        (sequenceTime - motionAnchor.sequenceTime) >>> 0;
      if (elapsedMs > 0 && elapsedMs < 0x80000000) {
        ({ horizontalSpeed, verticalSpeed } = calculateNpcMotionSpeeds(
          this.state.position,
          sequenceTime,
          motionAnchor
        ));
      } else if (resumedFromStop) {
        // A same-timestamp first sample has no measurable rate yet.  Keep it
        // standing instead of falling back to Recast's target velocity, which
        // would advertise a sprint before the wire displacement supports it.
        horizontalSpeed = 0;
        verticalSpeed = 0;
      } else {
        // Multiple Recast updates can share one wire millisecond.  The
        // displacement sample cannot produce a meaningful rate in that case;
        // use the nav agent's current velocity rather than falsely publishing
        // an idle stance and dropping a real chase/flee step.
        const velocity = readNavVelocity();
        horizontalSpeed = velocity?.horizontalSpeed ?? 0;
        verticalSpeed = velocity?.verticalSpeed ?? 0;
      }
    } else if (this.navAgent) {
      const vel = this.navAgent.velocity();
      // Recast, Character.ExpectedSpeed and PlayerUpdatePosition all use
      // the same world/game speed units. Do not convert the measured nav
      // velocity to feet here: doing so advertises (for example) ~16.4 while
      // ExpectedSpeed is 5, which makes the client movement graph blend the
      // wrong gait and is a direct source of slide/start mismatches.
      // A Recast velocity is a desired/steering value, not proof that this
      // authoritative position sample moved.  This applies to zombies and
      // generic NPCs as well as AnimalsPhysics actors: advertising a gait on
      // a stationary first crowd tick lets the client run in place and then
      // slide when the first real position sample arrives.
      if (!hasAuthoritativeDisplacement) {
        horizontalSpeed = 0;
        verticalSpeed = 0;
      } else {
        horizontalSpeed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
        verticalSpeed = Math.abs(vel.y);
      }
    } else {
      horizontalSpeed = 0;
      verticalSpeed = 0;
    }

    // A generic zombie has no recovered authored lower blend point like the
    // AnimalsPhysics graph.  Its first non-zero position packet is therefore
    // only the acceleration hand-off; keep the graph standing for that one
    // packet and require the next adjacent moving sample before selecting
    // walk/run.  This is a causal sample-count rule, not a guessed speed
    // threshold, and it also applies after an action/idle stop.
    const hasMeasuredMovingSample =
      hasAuthoritativeDisplacement &&
      (horizontalSpeed > 1e-4 || verticalSpeed > 1e-4);
    if (hasMeasuredMovingSample) {
      this.movingMotionSamplesSinceStop =
        (this.movingMotionSamplesSinceStop ?? 0) + 1;
    } else if (
      !hasAuthoritativeDisplacement &&
      horizontalSpeed <= 1e-4 &&
      verticalSpeed <= 1e-4
    ) {
      this.movingMotionSamplesSinceStop = 0;
    }

    // The mode is an intent, not proof that the nav agent has moved yet.
    // Recast commonly needs one crowd step to accelerate after a chase or
    // flee request.  Advertising walk/sprint during that zero-velocity step
    // makes the client blend a moving clip while the authoritative position
    // is still stationary (the visible slide/start mismatch).  Let the
    // measured horizontal/vertical displacement choose the moving stance;
    // a zero-speed sample is an explicit standing handoff.  Vertical-only
    // navmesh links remain moving so stairs/ledges do not get flattened into
    // idle samples.
    // AnimalsPhysics does not have a locomotion blend point for an arbitrary
    // non-zero horizontal velocity.  Its first authored moving band starts at
    // 0.689 (VelocityLocalZ); advertising a walk/sprint stance for Recast's
    // first 0.1..0.6 m/s acceleration sample makes the client enter a moving
    // clip before it has a valid gait input.  Generic Zombie001 resources do
    // not expose a verified lower band, so their first measured sample stays
    // standing and the second adjacent sample releases the gait.
    const horizontalMotionThreshold =
      this.nativeLocomotionProfile?.minimumMovingSpeed ?? 1e-4;
    const hasNativeMovingInput =
      horizontalSpeed >= horizontalMotionThreshold || verticalSpeed > 1e-4;
    const isMoving =
      hasNativeMovingInput &&
      (this.nativeLocomotionProfile !== undefined ||
        (this.movingMotionSamplesSinceStop ?? 0) >= 2);
    const motion: NpcPositionUpdateMotion = {
      stance: isMoving
        ? this.locomotionMode === "sprint"
          ? Npc.STANCE_MOVE_STANDING_SPRINTING
          : Npc.STANCE_MOVE_STANDING
        : Npc.STANCE_STANDING,
      engineRPM: 0,
      orientation,
      frontTilt,
      sideTilt,
      angleChange,
      verticalSpeed,
      horizontalSpeed
    };
    this.lastWireMotion = {
      sequenceTime,
      stance: motion.stance,
      horizontalSpeed: motion.horizontalSpeed,
      verticalSpeed: motion.verticalSpeed,
      orientation: motion.orientation
    };
    this.server.sendDataToAllWithSpawnedEntity(
      this.server._npcs,
      this.characterId,
      "PlayerUpdatePosition",
      {
        transientId: this.transientId,
        positionUpdate: {
          ...createNpcPositionUpdate(this.state.position, sequenceTime, motion),
          unknown3_int8: this.movementVersion ?? 0
        }
      }
    );
    this.lastMotionSample = {
      sequenceTime,
      position: [
        this.state.position[0],
        this.state.position[1],
        this.state.position[2]
      ]
    };
    // The stop anchor is consumed by this first resumed sample.  Subsequent
    // samples use the normal adjacent-position rate through lastMotionSample.
    this.lastStoppedMotionSample = undefined;
    // Publish the first position sample before the positive ExpectedSpeed
    // edge.  Both values are inputs to the native graph; reversing them lets
    // the client enter a walk/sprint clip while it is still rendering the old
    // standing position (the observed start-slide).  lastWireMotion was set
    // above, so the helper still sees this sample even though the packet order
    // now matches the causal order on the wire.
    if (isMoving) {
      this.flushPendingExpectedSpeed();
    }
    // Only now has the client received a position sample whose measured speed
    // selects an authored animal gait.  Install any target/acceleration
    // context requested by the FSM after that sample, never before it.
    if (isMoving) {
      this.flushPendingNativeSeekTarget();
    }
  }

  /**
   * Turns the NPC to face a target, clamped to maxTurnRateRadPerSec so a
   * stationary NPC (e.g. attacking a player it can't reach, like one on top
   * of a car) doesn't snap its facing instantly every AI tick.
   */
  lookAt(
    targetPosition: Float32Array,
    dt: number = 0,
    maxTurnRateRadPerSec: number = Math.PI
  ) {
    const dx = targetPosition[0] - this.state.position[0];
    const dz = targetPosition[2] - this.state.position[2];
    const targetOrientation = Math.atan2(dx, dz);
    const prevOrientation = this.state.yaw ?? targetOrientation;
    let angleChange = targetOrientation - prevOrientation;
    angleChange = Math.atan2(Math.sin(angleChange), Math.cos(angleChange));
    if (dt > 0) {
      const maxStep = maxTurnRateRadPerSec * dt;
      angleChange = Math.max(-maxStep, Math.min(maxStep, angleChange));
    }
    const orientation = prevOrientation + angleChange;
    this.state.yaw = orientation;
    this.state.rotation = eul2quat(new Float32Array([orientation, 0, 0]));

    const dy = targetPosition[1] - this.state.position[1];
    const horizontalDist = Math.sqrt(dx * dx + dz * dz);
    const frontTilt = Math.atan2(dy, horizontalDist);
    const sinO = Math.sin(orientation);
    const cosO = Math.cos(orientation);
    const lateralDist = dx * cosO - dz * sinO;
    const sideTilt = Math.atan2(lateralDist, horizontalDist);

    const sequenceTime = getCurrentServerTimeWrapper().getTruncatedU32();
    const motion: NpcPositionUpdateMotion = {
      stance: Npc.STANCE_STANDING,
      engineRPM: 0,
      orientation,
      frontTilt,
      sideTilt,
      angleChange,
      verticalSpeed: 0,
      horizontalSpeed: 0
    };
    this.lastWireMotion = {
      sequenceTime,
      stance: motion.stance,
      horizontalSpeed: motion.horizontalSpeed,
      verticalSpeed: motion.verticalSpeed,
      orientation: motion.orientation
    };
    this.lastStoppedMotionSample = {
      sequenceTime,
      position: [
        this.state.position[0],
        this.state.position[1],
        this.state.position[2]
      ]
    };
    this.server.sendDataToAllWithSpawnedEntity(
      this.server._npcs,
      this.characterId,
      "PlayerUpdatePosition",
      {
        transientId: this.transientId,
        positionUpdate: {
          ...createNpcPositionUpdate(this.state.position, sequenceTime, motion),
          unknown3_int8: this.movementVersion ?? 0
        }
      }
    );
    // A facing-only sample is stationary, but Attack states can immediately
    // choose the closing branch after this packet.  Keep the moving-sample
    // counter intact here; the explicit stopMovement() path resets it when
    // the actor truly enters an action/idle boundary.  Otherwise a zombie
    // that is just outside strike range would call lookAt() every AI tick and
    // permanently reset the two-sample generic locomotion gate, leaving it
    // with a moving body and a standing wire stance.
    this.lastMotionSample = undefined;
  }
}
