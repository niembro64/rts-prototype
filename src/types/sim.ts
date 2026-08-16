// Simulation entity types extracted from game/sim/types.ts

import type { TurretBlueprintId } from './blueprintIds';
import type { Vec3 } from './vec2';
import type {
  TurretAimStyle,
  TurretAngularActuator,
  TurretCooldownConfig,
  TurretEmitterKind,
  TurretIntelRequirement,
  TurretMountControlMode,
  TurretPresentation,
  TurretStationArticulation,
  UnitTurretHostAttachment,
  TurretRangeVolume,
  TurretSubmunitionEmitterConfig,
  SpawnTurretConfig,
  ResourcePylonConfig,
  UnitSupportSurface,
  SensorCapabilityConfig,
} from './blueprints';
import type {
  BuildingAnchorProfile,
  BuildingHoveringType,
  BuildingPlacementType,
  BuildingRenderProfile,
  BuildingBlueprintId,
  BuildingSupportSurface,
} from './buildingTypes';
import type {
  UnitAction,
  UnitPathPlan,
  WaypointType,
} from './commandTypes';
import type { TurretRangeOverrides, TurretRanges } from './combatTypes';
import { NO_ENTITY_ID, type EntityId, type PlayerId } from './entityTypes';
import type { UnitLocomotion, UnitSuspensionState } from './unitLocomotionTypes';
import type { ResourceCost } from './economyTypes';
import type {
  ActiveProjectileShot,
  BeamPoint,
  EmissionConfig,
  ProjectileType,
  ShotProfile,
} from './shotTypes';

export type {
  BuildingAnchorProfile,
  BuildingHoveringType,
  BuildingPlacementType,
  BuildingRenderProfile,
  BuildingBlueprintId,
  BuildingSupportSurface,
  StructureBlueprintId,
} from './buildingTypes';
export type {
  ActionType,
  UnitAction,
  UnitPathPlan,
  UnitPathPoint,
  WaypointType,
} from './commandTypes';
export type {
  HysteresisRange,
  TurretRangeOverrides,
  TurretRanges,
} from './combatTypes';
export type { EntityId, PlayerId } from './entityTypes';
export { NO_ENTITY_ID } from './entityTypes';
export type { UnitLocomotion } from './unitLocomotionTypes';
export type { ResourceCost } from './economyTypes';
export type {
  SensorCapabilityConfig,
  TurretAimStyle,
  TurretCooldownConfig,
  UnitSupportSurface,
} from './blueprints';
export type {
  ActiveProjectileShot,
  BeamReflectorKind,
  BeamPoint,
  BeamRay,
  ShieldBarrierConfig,
  ShieldConfig,
  EmissionConfig,
  LaserRay,
  
  ProjectileShot,
  ProjectileType,
  ShotConfig,
  ShotLocomotion,
  ShotLocomotionMedia,
  ShotLocomotionMediumPhysics,
  ShotLocomotionMotionModel,
  ShotLocomotionTerminalOutcome,
  ShotLocomotionTerminalPolicy,
  ShotLocomotionTransitionOutcome,
  ShotLocomotionTransitions,
  ShotProfile,
  ShotRuntimeProfile,
  ShotVisualProfile,
} from './shotTypes';
export {
  getEmissionBlueprintId,
  getShotMaxLifespan,
  isRayConfig,
  isRayType,
  isShieldConfig,
  isProjectileShot,
  isRocketLikeShot,
} from './shotTypes';

// Transform component - position and rotation in world space.
// The sim is fully 3D: (x, y) = ground-plane footprint, z = altitude
// (positive = up). `rotation` is yaw about the world z-axis (hull
// heading on the ground plane). Turret pitch is stored per-turret
// below, not here, because only turrets tilt up/down — hulls stay
// upright even under physics push-out.
export type Transform = {
  x: number;
  y: number;
  z: number;
  rotation: number;
  rotCos: number | null;
  rotSin: number | null;
};

export function createTransform(
  x: number,
  y: number,
  z: number,
  rotation: number,
): Transform {
  return {
    x,
    y,
    z,
    rotation,
    rotCos: null,
    rotSin: null,
  };
}

// Body component - reference to the 3D physics body.
type Body = {
  physicsBody: import('../game/server/PhysicsEngine3D').Body3D;
};

// Selectable tag component
type Selectable = {
  selected: boolean;
};

// Ownership component - which player owns this entity
type Ownership = {
  playerId: PlayerId;
};

export type EntityRadii = {
  /** Outer/render extent (formerly "visual"): drives mesh size, the LOD
   *  distance switch, and the selection volume. Renamed to a neutral name so it
   *  is not mistaken for the collision/hitbox radius (which combat + physics use). */
  other: number;
  hitbox: number;
  collision: number;
};

export type UnitMoveState = 'maneuver' | 'holdPosition' | 'roam';
export type UnitAirIdleState = 'fly' | 'land';
export type CombatTrajectoryMode = 'auto' | 'low' | 'high';
export type CombatFireState = 'fireAtWill' | 'returnFire' | 'holdFire' | 'defend' | 'fireAtAll';

// Cached shield panel geometry (pre-computed from blueprint at entity creation).
// halfWidth — half the panel's edge length (square panel, so the same
//             value is used for both the horizontal-edge half and the
//             vertical-edge half via `(topY - baseY) / 2`).
// offsetX  — distance from turret pivot to panel center along the rigid
//            arm's forward direction, resolved from mount-authored geometry.
// offsetY  — lateral pivot offset (zero for current single-arm panels;
//            non-zero would mount the arm off-center on the chassis).
// angle    — panel-yaw offset relative to turretShieldPanel yaw (zero today;
//            reserved for future multi-panel shield-panel configurations).
// baseY / topY — world-Z (above the unit's ground footprint) defining the
//                panel's vertical span. Both are derived in shieldPanelCache
//                from `mount.z * unitBodyRadius ± halfSide`, so their
//                midpoint is the rigid-arm pivot's Z.
export type CachedShieldPanel = {
  halfWidth: number;
  offsetX: number;
  offsetY: number;
  angle: number;
  baseY: number;
  topY: number;
};

// Unit component - movable entities. Velocities are 3D: X/Y are
// horizontal (ground-plane) motion, Z is vertical (for units that
// take off, get knocked up by explosions, or fall from overhangs).
//
// `velocityX/Y/Z` is the AUTHORITATIVE physics velocity, written only
// by syncFromPhysics on the server (and by the network drift code on
// the client). Anyone reading "how fast is this unit moving" — lead
// prediction, debris recoil, locomotion animation — should read these.
//
// `thrustDirX/Y` is the desired horizontal thrust vector mirrored into
// native entity-state drive-input rows for the force kernel. Its
// direction is the desired acceleration direction; its magnitude is
// clamped to [0, 1] and scales the unit's available propulsive force.
// Decoupling thrust from velocity prevents the action system from
// clobbering the velocity field mid-tick before turretSystem's lead
// math runs.
export type Unit = {
  unitBlueprintId: string;
  locomotion: UnitLocomotion;
  /** Unit radii in world units. `visual` is the drawn chassis/body
   *  authoring radius, `hitbox` is the damage collider, and `collision`
   *  is the unit-vs-unit physics/selection spacing radius. */
  radius: EntityRadii;
  /** World-space height of the unit's authored body center above terrain. */
  supportPointOffsetZ: number;
  /** Authored unit support proxy. Unit collision remains sphere-based;
   *  this separate proxy decides whether anything can stand on the unit. */
  supportSurface: UnitSupportSurface;
  mass: number;
  hp: number;
  maxHp: number;
  actions: UnitAction[];
  actionHash: number;
  /** BAR-style repeat command state. When enabled, completed queued
   *  player intents rotate to the back of the action queue so a multi-order
   *  chain loops until the player stops or clears it. */
  repeatQueue: boolean;
  /** Basic BAR-style positioning state. `maneuver` allows attack and
   *  guard actions to chase their targets but halts when weapons engage;
   *  `holdPosition` keeps the unit planted once targets are in range;
   *  `roam` keeps moving/chasing through engagements. Explicit
   *  move/fight/patrol waypoints still move. */
  moveState: UnitMoveState;
  /** BAR-style cloak intent. With the current prototype economy there
   *  is no cloak energy drain/delay yet, so authoritative `cloaked`
   *  follows this desired state immediately. */
  wantCloak: boolean;
  /** Authoritative visibility state. Filtered snapshots suppress
   *  foreign cloaked units unless the recipient has detector coverage. */
  cloaked: boolean;
  /** BAR cloak-firestate widget mirror. Cloaking stores the current fire
   *  state here, forces hold fire, and decloaking restores this value. */
  cloakRestoreFireState: CombatFireState | null;
  patrolStartIndex: number | null;
  /** Current route resolution for actions[0]. This is sim-only state:
   *  actions are durable player/factory waypoints, while activePath
   *  holds transient pathfinder points for the leg being executed. */
  activePath: UnitPathPlan | null;
  /** Plan-scheduler request state (PATH_REQUEST_NONE/FRESH/REFRESH). A unit
   *  holds at most one live queue entry; a popped entry whose lane no longer
   *  matches this field is skipped at serve time. Sim-only state. */
  pathRequestLane: number;
  /** Serve the queued request from the unit's live position and skip the
   *  shared formation corridor (stuck-replan semantics). */
  pathRequestForceLocal: boolean;
  /** Airborne-cruising loiter center. When a cruising unit exhausts its action
   *  queue, it keeps steering around this last destination instead of
   *  dropping thrust and drifting off-map. */
  airborneLoiterTargetX: number | null;
  airborneLoiterTargetY: number | null;
  airborneLoiterTargetZ: number | null;
  /** Airborne-cruising orbit direction around the loiter center. */
  airborneLoiterTurnSign: number | null;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  /** Desired thrust vector for this tick. Magnitude is a force fraction
   *  (0..1 after clamping); the action system encodes "stationary" as
   *  (0, 0). */
  thrustDirX: number;
  thrustDirY: number;
  /** Desired body-facing vector for this tick. This is intentionally
   *  separate from thrust: arrival control may request reverse thrust to
   *  brake, but that should not instantly flip the chassis heading. */
  headingDirX: number;
  headingDirY: number;
  /** Runtime spring state for the visible chassis relative to the
   *  locomotion anchor. Null means rigid legacy attachment. */
  suspension: UnitSuspensionState | null;
  shieldPanels: CachedShieldPanel[];
  shieldBoundRadius: number;
  /** Per-unit smoothed surface normal at the unit's footprint. The
   *  terrain mesh is piecewise-flat at the triangle level, so the raw
   *  normal SNAPS each time the unit crosses a triangle edge. The sim
   *  EMA-blends raw → stored every tick (see updateUnitGroundNormal) so chassis
   *  tilt, turret world mounts, and rendered tilt all read one
   *  smoothed-but-physically-grounded value. Initialized at spawn to
   *  the raw normal at the spawn position; written by the unit ground
   *  normal system. */
  surfaceNormal: { nx: number; ny: number; nz: number };
  /** Full 3-DOF orientation for the unit body. All units carry this
   *  state; `transform.rotation` remains the scalar yaw mirror for
   *  legacy systems that only need heading.
   *
   *  Convention: unit quaternion using ZYX intrinsic Euler order
   *  (yaw about world Z, pitch about body Y after yaw, roll about
   *  body X after yaw+pitch). Identity {x:0,y:0,z:0,w:1} matches
   *  transform.rotation = 0 with zero pitch/roll. Renderer/turret
   *  worldPos math can read transform.rotation (kept in sync to the
   *  quat's yaw component) when only heading matters. */
  orientation: { x: number; y: number; z: number; w: number } | null;
  /** Angular velocity 3-vector in world frame (rad/s). Paired with
   *  `orientation`; legacy/null-safe because older snapshots may omit it. */
  angularVelocity3: { x: number; y: number; z: number } | null;
  /** Consecutive ticks the unit has wanted to move but failed to make
   *  meaningful progress. Reset on either no-movement-intent ticks or
   *  ticks where physics velocity exceeds the stuck threshold. When
   *  this exceeds the simulation's stuck threshold the planner gets
   *  re-run from the unit's current position to the trip's final
   *  destination, replacing the stale path. Tick-only state, never
   *  serialised. */
  stuckTicks: number;
};

// Combat capability — separates "this entity has armed turrets"
// from "this entity is a unit chassis" or "this entity is a building
// footprint". Any entity that can target, rotate, and fire wears a
// CombatComponent. The combat pipeline iterates entities with
// `entity.combat` and never asks "is this a unit or a building?".
//
// hp/maxHp intentionally stay on the host component (Unit / Building)
// because every host has hp regardless of whether it has turrets — a
// commander shell has hp before its turrets are functional, a future
// transport unit would have hp without turrets, etc. CombatComponent
// owns ONLY combat-specific bookkeeping.
export type MountedCapabilityBase = {
  /** Stable authored attachment identity. It does not allocate an entity id
   *  unless the capability is independently targetable (attack turrets do). */
  mountId: string;
  /** Index in the host blueprint's attachment list. */
  mountIndex: number;
  /** Chassis-local attachment pivot in world units. */
  mount: Vec3;
  worldPos: Vec3;
  worldPosTick: number;
};

export type SensorMountCapability = MountedCapabilityBase & {
  kind: 'sensor';
  rangeVolume: TurretRangeVolume;
  sensors: SensorCapabilityConfig;
};

export type ResourceFlowMountCapability = MountedCapabilityBase & {
  kind: 'resourceFlow';
  resource: ResourcePylonConfig['resource'];
  role: 'extraction';
  radius: number;
};

/** Lightweight non-combat attachments. These deliberately carry no target,
 * aim, cooldown, burst, or firing FSM state. */
export type UtilityMountCapability =
  | SensorMountCapability
  | ResourceFlowMountCapability;

export type CombatComponent = {
  /** Runtime turret instances mounted on this entity. Built once at
   *  spawn from the host blueprint's `turrets[]` and persisted across
   *  the entity's lifetime. */
  turrets: Turret[];
  /** Mounted utility capabilities kept out of the attack-turret FSM. */
  utilityMounts: UtilityMountCapability[];
  /** Legacy player-controlled fire permission mirror. False is hard
   *  hold-fire for older snapshot consumers. */
  fireEnabled: boolean;
  /** Player-controlled fire state. BAR exposes Fire at will / Return fire /
   *  Hold fire by default, while its order-menu helper also supports direct
   *  Defend and Fire at all states. */
  fireState: CombatFireState;
  /** Ballistic arc override for hosts with ballistic weapons. `auto`
   *  uses each turret blueprint's authored low/high arc; player
   *  commands can force all ballistic turrets on the host low or high. */
  trajectoryMode: CombatTrajectoryMode;
  /** Host attack-command target. `null` is the canonical "no priority
   *  target" value. The host-to-emitter adapter projects it only onto
   *  compatible host-controlled attack mounts; other mounts keep their own
   *  policy and incompatible mounts fall back independently. */
  priorityTargetId: EntityId | null;
  /** Player attack-ground target. Sim-only; action snapshots carry
   *  the visible queued order while targeting/firing reads this per
   *  tick. `null` means no attack-ground point is queued. */
  priorityTargetPoint: Vec3 | null;
  /** One-shot player special fire. When true, the existing turret
   *  targeting/fire path uses `priorityTargetPoint` until a weapon
   *  actually launches, then clears both fields. */
  manualLaunchActive: boolean;
  /** Tick before which fully-idle armed entities can skip the
   *  targeting pass. Sentinel `-1` means "always run this tick";
   *  attack commands clear back to `-1` implicitly by setting
   *  priorityTargetId, and live/cooldown weapons process every tick. */
  nextCombatProbeTick: number;
};

export function createCombatComponent(
  turrets: Turret[],
  utilityMounts: UtilityMountCapability[] = [],
): CombatComponent {
  return {
    turrets,
    utilityMounts,
    fireEnabled: true,
    fireState: 'fireAtWill',
    trajectoryMode: 'auto',
    priorityTargetId: null,
    priorityTargetPoint: null,
    manualLaunchActive: false,
    nextCombatProbeTick: -1,
  };
}

// Building component - static structures with a real 3D extent.
// width (x-footprint) × height (y-footprint) × depth (z, vertical).
// The physics engine stores the building as a cuboid centered at
// (transform.x, transform.y, depth/2) so the base sits on the ground.
/** Shared "fortifiable producer" state for solar collectors, wind
 *  turbines, and metal extractors. See buildingActiveState.ts. */
export type BuildingActiveState = {
  /** The single ON/OFF flag. ON (true) = producing + normal damage; OFF
   *  (false) = not producing + fortified. It is the sole authoritative
   *  input for both production accounting and the renderer's open/closed
   *  pose — see "Producer Buildings Are ON/OFF" in budget_design_philosophy.html.
   *  False once the damage-grace timer expires or the building started
   *  closed. */
  open: boolean;
  /** Counts down from BUILDING_DAMAGE_DELAY_MS once the building has
   *  been hit. The transition to closed fires when this reaches zero. */
  damageDelayMs: number;
  /** Counts down from BUILDING_REOPEN_DELAY_MS while closed. The
   *  transition back to open fires when this reaches zero. */
  reopenDelayMs: number;
};

type Building = {
  width: number;
  height: number;
  depth: number;
  /** Authored support proxy. This is intentionally separate from the
   *  collision cuboid so a building can block one shape while exposing
   *  a different walkable top, pad, or no top support at all. */
  supportSurface: BuildingSupportSurface;
  /** Semantic placement/anchor domain. Construction occupancy remains one
   * shared X/Y grid regardless of this vertical placement policy. */
  placementType: BuildingPlacementType;
  /** Hovering structures (the fabricator torus) are intangible at ground
   *  level: no collision body, no support surface, and excluded from path-
   *  finding — units move under them freely and falling units pass through to
   *  the ground. They still reserve their footprint so nothing can be built on
   *  top of them. */
  hoveringType: BuildingHoveringType;
  hovering: boolean;
  hp: number;
  maxHp: number;
  /** Authored target radius. Most grounded structures use the footprint
   *  diagonal; hovering body shapes can override it to match their visible
   *  body instead of their reserved build footprint. */
  targetRadius: number;
  activeState: BuildingActiveState | null;
};

// Turret configuration (compiled turret definition)
export type TurretConfig = {
  turretBlueprintId: TurretBlueprintId;
  /** Authoritative effect family. It survives blueprint compilation and
   *  dispatches the emitter executor. */
  kind: TurretEmitterKind;
  /** The turret owns three distinct spatial facts. Engagement controls
   * target legality, observation contributes contacts to team intelligence,
   * and effect controls the emitted shot/ray/field reach. */
  targeting: {
    engagement: {
      range: number;
      rangeVolume: TurretRangeVolume;
      rangeOverrides: TurretRangeOverrides;
    };
    observation: {
      rangeVolume: TurretRangeVolume;
      sensors: SensorCapabilityConfig;
    };
    effect: {
      range: number;
      rangeVolume: TurretRangeVolume;
    };
    requiredIntel: TurretIntelRequirement;
  };
  cooldown: TurretCooldownConfig | null;
  launchForce: number;
  addTurretVelocityToEmissionLaunch: boolean;
  color: number;
  /** Number of deterministic QueryWeapon-style emission lanes. Every lane
   * resolves to an authoritative socket; barrel-index events carry the same
   * lane identity used to place the physical shot or ray. */
  emissionLaneCount: number;
  /** Physical rate/acceleration limits for the two local station joints. */
  angular: TurretAngularActuator;
  /** Smooth this turret's projectile spawn events across snapshot intervals. */
  eventsSmooth: boolean;
  spread: { pelletCount: number; angle: number } | null;
  burst: { count: number; delay: number } | null;
  passive: boolean;
  /** Actual terrain/entity line-of-sight gate for this turret. Cross
   *  shield sight obstruction is a separate battle setting. */
  requiresNonObstructedLineOfSight: boolean;
  /** Null for non-projectile utility emitters. Effect dispatch is governed by
   *  `kind`; callers must not infer behavior from this nullable field. */
  shot: EmissionConfig | null;
  /** Optional secondary projectile spray driven by this turret's own engagement. */
  submunitions: TurretSubmunitionEmitterConfig | null;
  /** Sentinel -1 when not bound to a host turret slot. */
  turretIndex: number;
  /** Explicit aiming solver mode. See TurretBlueprint.aimStyle. */
  aimStyle: TurretAimStyle;
  /** VLS: turret stays pitched straight up and fires every pellet
   *  into a random cone around vertical. See TurretBlueprint
   *  .verticalLauncher. */
  verticalLauncher: boolean;
  /** Initial-spawn pitch in radians applied once at turret creation.
   *  See TurretBlueprint.idlePitch. */
  idlePitch: number;
  /** Aim a fraction of the way to the target on the ground rather
   *  than at the target itself; the round detonates short and its
   *  submunitions (if any) bounce + spread the rest of the way. See
   *  TurretBlueprint.groundAimFraction. */
  groundAimFraction: number | null;
  /** Whether authoritative yaw/pitch motion is useful to clients. This is a
   * logical publication rule; visible host geometry is independently owned by
   * the mount's TurretPresentation. */
  aimMotionSnapshotVisible: boolean;
  /** Per-mount task source. Host consumes compatible host intents,
   *  autonomous runs a kind-specific policy, and manual waits for an ability. */
  controlMode: TurretMountControlMode;
  /** Stable sibling mount identity copied by a slaved targeting policy. */
  slavedToMountId: string | null;
  /** Unit-mount authored fight/patrol stop gate. If true, this turret must
   *  be engaged before the host halts for fight/patrol combat. */
  requiredEngagedForFightStop: boolean;
  /** Optional authoritative host-side piece attachment. The turret owns
   * yaw/pitch and firing policy; the host resolves the named piece chain into
   * the turret's AimFrom pivot and QueryWeapon emission sockets. */
  hostAttachment: UnitTurretHostAttachment | null;
  /** Mount-local traverse, rest, host-assist and shared-claim policy. */
  articulation: TurretStationArticulation;
  spawn: SpawnTurretConfig | null;
  resourcePylon: ResourcePylonConfig | null;
  /** LOCK-ON-03 — Compiled per-turret lock-on inclusion bitmasks. JS
   *  walks each turret blueprint once at config build and packs the
   *  authored inclusion arrays into these bitmasks so the per-tick
   *  stamping pass can copy raw integers onto the combat-targeting
   *  slab without re-walking blueprint strings. Mirror
   *  `CT_LOCK_ON_REL_INCLUDE_*` / `CT_LOCK_ON_FAM_INCLUDE_*` for the
   *  level-0 fields; lock-on is off by default, so an empty level-0
   *  mask locks onto nothing. Level-1 fields set bit `1 << wire_code`
   *  for each included blueprint id (current capacity = 32 ids per
   *  family); an empty level-1 mask applies no name restriction within
   *  an included family. */
  lockOnRelationshipIncludeMask: number;
  lockOnEntityFamilyIncludeMask: number;
  lockOnBuildingIncludeMask: number;
  lockOnTowerIncludeMask: number;
  lockOnUnitIncludeMask: number;
  lockOnTurretIncludeMask: number;
  lockOnShotIncludeMask: number;
  /** Compiled `lockOnRequiresTargetLockedOntoSelf` enum. Mirrors
   *  `CT_LOCK_ON_RECIPROCAL_*` in Rust/wasm. */
  lockOnRequiresTargetLockedOntoSelfMode: number;
};

// Runtime projectile configuration. This is intentionally smaller than
// TurretConfig: projectiles own a shot blueprint plus the small amount of
// source-turret metadata needed for active line weapons. A
// submunition can therefore be a real shot without masquerading as a turret.
export type ProjectileConfig = {
  shot: ActiveProjectileShot;
  shotProfile: ShotProfile;
  /** Real turret blueprint that authored this projectile, when one exists. */
  sourceTurretBlueprintId: TurretBlueprintId | null;
  /** Source-turret base range. Active line shots use the live turret's
   *  computed 2D fire circle while retracing; shot-only children keep 0. */
  range: number;
  /** Source-turret cooldown. Used when laser projectiles expire. */
  cooldown: TurretCooldownConfig | null;
  /** Source turret slot on the owning unit. Used by active beam bookkeeping. */
  turretIndex: number;
};

export type ShotSource = {
  /** Runtime EntityId of the mounted turret instance that fired this shot. */
  sourceTurretEntityId: EntityId | null;
  /** Runtime EntityId of the immediate top-level firing host. */
  sourceHostEntityId: EntityId;
  /** Runtime EntityId of the root host that owns the firing assembly. */
  sourceRootEntityId: EntityId;
  sourcePlayerId: PlayerId;
  /** Canonical team id at launch time. In FFA this equals sourcePlayerId. */
  sourceTeamId: number;
  sourceTurretBlueprintId: TurretBlueprintId | null;
  sourceShotBlueprintId: string;
  spawnTick: number;
  parentShotEntityId: EntityId | null;
};

// Turret FSM state: idle → tracking → engaged
export type TurretState = 'idle' | 'tracking' | 'engaged';

export type TurretEntityTaskOperation = 'attack';

export type TurretEntityTask = {
  kind: 'entity';
  operation: TurretEntityTaskOperation;
  targetId: EntityId;
};

export type TurretPointTask = {
  kind: 'point';
  operation: 'attackGround';
  x: number;
  y: number;
  z: number;
};

export type TurretTask = TurretEntityTask | TurretPointTask;

// Runtime turret instance (per-weapon state on a unit).
// Full 3D aiming: `rotation` is yaw (horizontal heading, around z),
// `pitch` is elevation (vertical aim angle). Together they give a
// turret the two degrees of freedom needed to track targets above
// or below — aircraft, units on different elevations, targets
// behind a high-walled building. Pitch=0 is horizontal; positive
// pitches the barrel upward. `angularVelocity` is the yaw rate only;
// pitch is set directly each frame from the aim solution.
export type Turret = {
  /** Runtime identity for this mounted turret instance. Blueprint id lives on config.turretBlueprintId. */
  id: EntityId;
  /** Stable authored mount identity used by host capability routes. */
  mountId: string;
  parentId: EntityId;
  rootHostId: EntityId;
  mountIndex: number;
  config: TurretConfig;
  /** Host-authored physical representation for this mounted logical turret. */
  presentation: TurretPresentation;
  /** Current typed emitter assignment. `target` remains the compact entity-ID
   *  mirror used by snapshots and aiming when the task addresses an entity. */
  task: TurretTask | null;
  target: EntityId | null;
  ranges: TurretRanges;
  state: TurretState;
  /** Authoritative world-space yaw. This is always host-readable even when
   *  the host ignores it or merely echoes it through presentation joints. */
  rotation: number;
  /** Authoritative elevation. Like rotation, hosts may observe this value but
   *  never replace the turret's own aim through the attachment contract. */
  pitch: number;
  /** Authoritative joint coordinates relative to the moving host piece.
   * World yaw above is derived from parent yaw + localYaw. */
  localYaw: number;
  localPitch: number;
  localYawVelocity: number;
  localPitchVelocity: number;
  /** Time without a live tracking/committed-fire claim. Once the station's
   * restore delay expires, local joints return to their authored rest pose. */
  articulationIdleMs: number;
  /** Last moving-parent yaw used to derive world angular velocity. */
  articulationParentYaw: number;
  angularVelocity: number;
  /** Yaw angular acceleration (rad/s²) produced by this tick's bounded
   *  trapezoidal/triangular joint motor. Sim-only solver state: acceleration
   *  is not shipped on the wire and the renderer consumes adjacent
   *  authoritative fixed-tick orientations. */
  angularAcceleration: number;
  /** Angular velocity of the pitch axis (rad/s). Driven by the same bounded
   *  joint motor as yaw, with authored speed, acceleration, and hard stops. */
  pitchVelocity: number;
  /** Pitch angular acceleration (rad/s²); same sim-only shape as
   *  angularAcceleration, only for the elevation axis. */
  pitchAcceleration: number;
  /** Chassis-local fallback 3D weapon pivot in world units. Rigid mounts use
   * it directly; an authoritative host attachment resolves its moving piece
   * chain from the same blueprint and turret aim state. */
  mount: Vec3;
  /** Cached XY distance from host origin to `mount`. Immutable after
   *  construction; targeting stamping reads this every tick. */
  mountOffset2d: number;
  /** Sustained damage rate for target-priority scoring. Immutable
   *  after construction because shot config and cooldown are static. */
  sustainedDps: number;
  /** Cached authoritative world-space mount position, written by the
   *  targeting slab's Rust Pass 0 or by updateWeaponWorldKinematics
   *  fallback callers. Always-present (initialized to zero at turret
   *  construction). The cache is valid iff `worldPosTick >= 0`;
   *  consumers gate on that sentinel rather than on object presence.
   *  Sim-only hot-path state — snapshots ship rotation/pitch, not
   *  this derived value. */
  worldPos: Vec3;
  /** Cached world-space mount velocity computed from worldPos deltas
   *  when current, or zero when the cache has never been populated
   *  (`worldPosTick < 0`). This is the turret's own 3D motion, so
   *  moving/tilted/lateral mounts feed projectile lead and inherited
   *  launch-origin velocity correctly. */
  worldVelocity: Vec3;
  /** Simulation tick the worldPos/worldVelocity cache was last
   *  written. Sentinel `-1` = never computed; consumers check
   *  `worldPosTick >= 0` to know the cache is valid and
   *  `worldPosTick === currentTick` to know it's fresh this tick. */
  worldPosTick: number;
  /** Authoritative world yaw of the shared host piece driven by this turret
   * when it is selected as a bot's torso owner. NaN on non-owners and before
   * the first host-piece tick. */
  hostPieceYaw: number;
  /** Angular velocity of hostPieceYaw's bounded waist actuator. */
  hostPieceYawVelocity: number;
  /** Time without a station claim on the shared host piece. */
  hostPieceIdleMs: number;
  /** QueryWeapon sockets in turret-aim-local world units: +X forward, +Y
   * left, +Z up. One entry exists per emission lane. */
  emissionSockets: Vec3[];
  /** Last solver target yaw and pitch (radians), and the signed
   *  miss vector between them and `rotation` / `pitch`. Default 0
   *  before the first aim solve — which passes the within-tolerance
   *  fire gate, matching the previous "no aim computed yet means
   *  trivially aimed" semantic. */
  aimTargetYaw: number;
  aimTargetPitch: number;
  aimErrorYaw: number;
  aimErrorPitch: number;
  /** False when the current ballistic projectile aim has no exact
   *  gravity solution. Firing is held and entity locks are dropped so
   *  the turret does not spend shells on guaranteed-short fallback
   *  shots. Default true. */
  ballisticAimInRange: boolean;
  burst: { remaining: number; cooldown: number } | null;
  /** Shield field state. `onTimeMs` accumulates how long the field has
   *  been commanded-on in the current raise; the sim (and client
   *  prediction) hold the field up until it reaches
   *  SHIELD_MIN_ON_TIME_MS, debouncing rapid on/off flicker. Not
   *  shipped on the wire — only `range` is. */
  shield: { transition: number; range: number; onTimeMs: number } | null;
  /** Round-robin pointer across authoritative QueryWeapon sockets. */
  emissionLaneIndex: number;
  /** One-time deterministic delay applied to the first eligible attack-beam
   * pulse. This spreads newly-engaged beam batteries across a few fixed ticks;
   * subsequent pulses retain that phase through their fixed off cooldown. */
  beamPulseInitialDelayMs: number;
};

/** Open-loop trajectory captured once when an attack beam fires. Both
 * endpoints are constant-velocity world-space fits; those kinematic
 * coefficients remain immutable while the collision-ring schedule advances.
 * Neither turret nor beam reads the live target. */
export type BeamPulsePlan = {
  durationMs: number;
  sourceX: number;
  sourceY: number;
  sourceZ: number;
  sourceVelocityX: number;
  sourceVelocityY: number;
  sourceVelocityZ: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  targetVelocityX: number;
  targetVelocityY: number;
  targetVelocityZ: number;
  /** Finite source-turret effect radius used as the hard trace budget. */
  traceDistance: number;
  /** Stable hashed phase in the collision-sampling tick ring. */
  collisionSamplePhase: number;
  /** Next absolute authoritative simulation tick assigned to this beam. */
  nextCollisionSampleTick: number;
  /** Elapsed pulse time already integrated into endpoint damage. */
  lastCollisionSampleMs: number;
};

// Projectile component. Fully 3D: velocity + prev/start/end points
// all carry altitude. Projectile gravity is applied in the sim's
// projectile system each tick (ballistic arc); beams and lasers
// ignore vz and gravity (they're instantaneous line weapons).
// Beam polylines (start → reflections → end) live in `points`; each
// point carries its own (vx, vy, vz) for diagnostics/wire compatibility.
// Presentation copies each sampled topology atomically because endpoints and
// reflector vertices are collision constraints rather than free particles.
export type Projectile = {
  ownerId: PlayerId;
  /** Legacy host shortcut. The full immutable provenance lives in shotSource. */
  sourceEntityId: EntityId;
  config: ProjectileConfig;
  /** Actual emission blueprint id. For travelling shots this is the
   *  shot blueprint id; for active beams/lasers it is the ray blueprint id. */
  shotBlueprintId: string;
  /** Immutable launch provenance, inherited by submunitions with parentShotEntityId updated. */
  shotSource: ShotSource;
  /** Real turret blueprint id that ultimately authored this projectile.
   *  Submunitions inherit this from their parent projectile. */
  sourceTurretBlueprintId: TurretBlueprintId | null;
  /** Immutable source row for this fired emission. Initialized from the shot
   *  spawn point on its first authoritative update. */
  emissionSourceMedium: 'aboveWater' | 'underwater' | null;
  projectileType: ProjectileType;
  /** Travelling shot health. Beams/lasers are sustained emissions and
   *  keep this at 0 so they are not damageable shot bodies. */
  hp: number;
  maxHp: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  /** Authoritative yaw rate in radians/second for presentation. */
  angularVelocity: number;
  prevX: number | null;
  prevY: number | null;
  prevZ: number | null;
  collisionStartX: number | null;
  collisionStartY: number | null;
  collisionStartZ: number | null;
  timeAlive: number;
  /** Finite runtime timeout for lasers and special projectile classes;
   *  Infinity for ordinary traveling shot bodies. */
  maxLifespan: number;
  /** Beam/laser polyline. Index 0 = selected QueryWeapon origin, last = end
   *  (range/hit/ground/terminal reflector), middles = reflections.
   *  Reflection vertices carry reflector metadata via the legacy
   *  reflectorEntityId field plus reflectorKind/normal*. Null on
   *  non-line projectiles. Mutated in place — each re-trace resizes
   *  the array length and overwrites the per-vertex fields, so the
   *  array reference is stable. */
  points: BeamPoint[] | null;
  /** False only when the terminal point must not emit endpoint damage, such
   *  as BEAM_MAX_SEGMENTS ending on a reflector. Body, terrain, and finite
   *  air-boundary terminations all produce the authored endpoint sphere. */
  endpointDamageable: boolean | null;
  segmentLimitReached: boolean;
  /** Authoritative committed trajectory for attack-beam pulses. Null for
   * travelling shots, lasers, and remotely hydrated presentation entities. */
  beamPulsePlan: BeamPulsePlan | null;
  /** Damage/force integration window produced by this tick's coarse beam
   * collision sample. Zero means the cached path must not deal damage again. */
  beamDamageWindowMs: number;
  /** Source barrel index for visual/audio cadence metadata on turret shots. */
  sourceBarrelIndex: number;
  /** Internal: previous tick's start position. Used to compute
   *  points[0] velocity. Not serialized. */
  prevStartX: number | null;
  prevStartY: number | null;
  prevStartZ: number | null;
  /** Internal: previous beam-trace tick's end position. Used to compute
   *  the end-point velocity. Not serialized. */
  prevEndX: number | null;
  prevEndY: number | null;
  prevEndZ: number | null;
  /** Internal: tick at which prevEnd* was captured, used as the dt for
   *  the next end-velocity finite difference. Not serialized. */
  prevEndTick: number;
  /** Internal: terminal-surface identity of the previous trace's final
   *  segment (entity the beam ended on; NO_ENTITY_ID for a free
   *  range/cylinder end). The endpoint finite-diff velocity is valid
   *  only while this is unchanged — a terminal-surface handoff is a
   *  discrete event and ships zero endpoint motion. Not serialized. */
  prevEndEntityId: EntityId;
  /** Internal: previous beam-trace tick's reflection points keyed by
   *  reflectorEntityId. Used to finite-diff each reflection point's
   *  velocity. Not serialized. */
  prevReflectionPoints: {
    reflectorEntityId: EntityId;
    x: number;
    y: number;
    z: number;
    tick: number;
  }[] | null;
  /** Sentinel NO_ENTITY_ID means no homing/line target. */
  targetEntityId: EntityId;
  obstructionT: number | null;
  obstructionTick: number;
  hitEntities: Set<EntityId>;
  maxHits: number;
  hasExploded: boolean;
  /** Traveling physical shots can only collide/explode after their
   *  hitbox fully clears the firing host's enlarged HIT-shaped ARM volume. The
   *  projectile system flips this and resets collisionStart* to the
   *  crossing point. */
  isArmed: boolean;
  /** False until the shot hitbox has fully cleared the source unit's
   *  source volume. Source-clearance gating is retained for line shots
   *  whose endpoint damage starts inside the firing unit. */
  hasLeftSource: boolean;
  /** Sentinel `NO_ENTITY_ID` means this projectile is not homing. */
  homingTargetId: EntityId;
  homingTurnRate: number | null;
  /** Client-only one-shot: exact shield / shield-panel contact
   *  point from the most recent reflection, sourced from the
   *  unquantized shieldImpact audio event. Consumed by the
   *  curved-cone tail renderer on the next frame as a forced trail
   *  stamp so the tail kinks exactly at the bounce surface instead of
   *  one tick past it. Cleared after consumption. */
  pendingReflectionX: number | null;
  pendingReflectionY: number | null;
  pendingReflectionZ: number | null;
};

type ProjectileAbsenceSlots = Pick<Projectile,
  | 'prevX'
  | 'prevY'
  | 'prevZ'
  | 'collisionStartX'
  | 'collisionStartY'
  | 'collisionStartZ'
  | 'points'
  | 'endpointDamageable'
  | 'segmentLimitReached'
  | 'beamPulsePlan'
  | 'beamDamageWindowMs'
  | 'sourceBarrelIndex'
  | 'emissionSourceMedium'
  | 'prevStartX'
  | 'prevStartY'
  | 'prevStartZ'
  | 'prevEndX'
  | 'prevEndY'
  | 'prevEndZ'
  | 'prevEndTick'
  | 'prevEndEntityId'
  | 'prevReflectionPoints'
  | 'targetEntityId'
  | 'obstructionT'
  | 'obstructionTick'
  | 'hasExploded'
  | 'homingTurnRate'
  | 'pendingReflectionX'
  | 'pendingReflectionY'
  | 'pendingReflectionZ'
  | 'angularVelocity'
>;

export const PROJECTILE_ABSENCE_SLOTS: Readonly<ProjectileAbsenceSlots> = {
  prevX: null,
  prevY: null,
  prevZ: null,
  collisionStartX: null,
  collisionStartY: null,
  collisionStartZ: null,
  points: null,
  endpointDamageable: null,
  segmentLimitReached: false,
  beamPulsePlan: null,
  beamDamageWindowMs: 0,
  sourceBarrelIndex: -1,
  emissionSourceMedium: null,
  prevStartX: null,
  prevStartY: null,
  prevStartZ: null,
  prevEndX: null,
  prevEndY: null,
  prevEndZ: null,
  prevEndTick: -1,
  prevEndEntityId: NO_ENTITY_ID,
  prevReflectionPoints: null,
  targetEntityId: NO_ENTITY_ID,
  obstructionT: null,
  obstructionTick: -1,
  hasExploded: false,
  homingTurnRate: null,
  pendingReflectionX: null,
  pendingReflectionY: null,
  pendingReflectionZ: null,
  angularVelocity: 0,
};

// Economy state per player. Each pool (energy / metal) has its
// own stockpile, income breakdown, and expenditure tally. Buildables
// author independent per-resource costs and
// each pool fills its own `paid` accumulator; the build is gated by
// whichever pool is most scarce. See ResourceCost / Buildable below.
export type EconomyState = {
  stockpile: { curr: number; max: number };
  income: { base: number; production: number };
  expenditure: number;
  metal: {
    stockpile: { curr: number; max: number };
    income: { base: number; extraction: number };
    expenditure: number;
  };
};

export type ConstructionPieceKind = 'body';

export type ConstructionPieceBuildRecord = {
  id: EntityId;
  kind: ConstructionPieceKind;
  mountIndex: number | null;
  paid: ResourceCost;
  required: ResourceCost;
  healthBuildFraction: number;
  isActive: boolean;
  isComplete: boolean;
};

// Buildable component. While a unit/building is under construction it
// lives in the world as an inert "shell" — `paid` accumulates
// from the owner's stockpiles toward `required`. This
// component exists only while the entity is under construction; once
// activation succeeds, constructionLifecycle removes it. During
// construction, HP grows by the positive delta in average fill ratio;
// it is never reset upward to the current fill target, so damage taken
// while building remains damage. If construction is interrupted after
// pieces exist, the component remains with isInterrupted=true so those
// piece records continue to define the live partial assembly. `pieces`
// is the dependency-ordered resource ledger for the real assembly
// pieces; the aggregate `paid` counters remain the compact wire/UI
// mirror.
export type Buildable = {
  paid: ResourceCost;
  required: ResourceCost;
  isComplete: boolean;
  /** True once construction was cancelled after at least one real
   *  piece materialized. Funding stops, but the piece records remain
   *  authoritative for rendering/targeting the partial assembly. */
  isInterrupted: boolean;
  healthBuildFraction: number;
  pieces: ConstructionPieceBuildRecord[];
};

/** Builder component. Gives a unit the ability to construct
 *  **buildings** (and assist/repair them) anywhere within `buildRange`.
 *  The host visualizes realized work through its authored work emitter.
 *
 *  Builder ≠ factory: buildings come from builders, units come from
 *  factories. Currently mounted on commanders; the planned construction
 *  aircraft will use the same component with drone locomotion. */
export type Builder = {
  buildRange: number;
  /** BAR builder priority command mirror. Low priority is a resource-allocation
   *  preference; the prototype records the state for command/UI parity while
   *  current resource distribution remains unchanged. */
  lowPriority: boolean;
  /** Sentinel `NO_ENTITY_ID` means no direct construction target. */
  currentBuildTarget: EntityId;
  /** Runtime state for an articulated QueryWork station. Fixed host emitters
   * keep this null; articulated builders own their joint independently from
   * weapon turrets even when both arbitrate for the same parent piece. */
  workStation: BuilderWorkStationRuntime | null;
};

export type BuilderWorkStationRuntime = {
  localYaw: number;
  localPitch: number;
  localYawVelocity: number;
  localPitchVelocity: number;
  idleMs: number;
  /** World-space request presented to a shared parent such as a bot waist. */
  targetWorldYaw: number;
  targetWorldPitch: number;
  targetEntityId: EntityId;
  aligned: boolean;
  worldPosition: Vec3;
  worldVelocity: Vec3;
  worldPosTick: number;
};

type WreckSource =
  | {
      kind: 'unit';
      unitBlueprintId: string;
    }
  | {
      kind: 'building';
      buildingBlueprintId: BuildingBlueprintId;
      width: number;
      height: number;
      depth: number;
    };

type Wreck = {
  source: WreckSource;
  originalOwnerId: PlayerId | null;
  resurrectProgressMs: number;
  resurrectRequiredMs: number;
};

export type Transport = {
  capacity: number;
  loadedUnits: Entity[];
};

type Transported = {
  transportId: EntityId;
  slotIndex: number;
};

export type EntityHoldKind = 'production' | 'transportCargo';

export type EntityHold = {
  kind: EntityHoldKind;
  holderId: EntityId;
  slotIndex: number;
  /** Chassis-/building-local horizontal offset in sim coordinates. */
  localOffsetX: number;
  localOffsetY: number;
  /** Held entity base height above the holder's base, in sim Z. */
  localBaseZ: number;
  rotateWithHolder: boolean;
  inheritHolderRotation: boolean;
  /** Optional world yaw override while held. Null means use inheritance/current rotation policy. */
  worldRotation: number | null;
  inheritHolderVelocity: boolean;
};

// Building configuration. gridWidth/gridHeight are the footprint on
// the ground plane (measured in build-grid cells); gridDepth is the
// vertical extent measured in build-grid cell heights.
// The sim is fully 3D, so buildings need a real z-extent — it's a
// first-class property of the shape, not a render-only detail.
export type BuildingConfig = {
  buildingBlueprintId: BuildingBlueprintId;
  name: string;
  gridWidth: number;
  gridHeight: number;
  gridDepth: number;
  /** Bounding box for centered snapping/rotation of placementFootprint.
   *  These dimensions never imply that every enclosed cell is occupied. */
  placementGridWidth: number;
  placementGridHeight: number;
  /** Authored, non-rectangular construction reservation inside the placement
   *  bounding box. `structure` cells also contribute grounded locomotion
   *  obstruction; `clearance` cells reserve construction space only. */
  placementFootprint: BuildingPlacementFootprint;
  hp: number;
  cost: ResourceCost;
  energyProduction: number | null;
  metalProduction: number | null;
  /** Max resource units per second this building can add to each
   *  construction resource lane of its active shell. */
  constructionRate: number | null;
  /** Source-resource throughput (units per second) for a resource
   *  converter. Each tick, a completed converter consumes this much of
   *  whichever resource is in surplus (metal vs energy) and pays out
   *  the other resource minus the configured CONVERTER TAX. `null` for
   *  any non-converter building. */
  conversionRate: number | null;
  renderProfile: BuildingRenderProfile;
  visualHeight: number;
  anchorProfile: BuildingAnchorProfile;
  supportSurface: BuildingSupportSurface;
  placementType: BuildingPlacementType;
  /** Authored hovering classification. Null means grounded. */
  hoveringType: BuildingHoveringType;
  /** Derived compatibility flag for existing runtime branches. */
  hovering: boolean;
  hud: import('./blueprints').EntityHudBlueprint;
  radius: EntityRadii;
};

export type BuildingPlacementFootprintCell = {
  dx: number;
  dy: number;
  kind: 'structure' | 'clearance';
};

export type BuildingPlacementFootprint = {
  gridWidth: number;
  gridHeight: number;
  cells: readonly BuildingPlacementFootprintCell[];
};

// Unit build configuration
export type UnitBuildConfig = {
  unitBlueprintId: string;
  name: string;
  cost: ResourceCost;
  radius: EntityRadii;
  supportPointOffsetZ: number;
  supportSurface: UnitSupportSurface;
  locomotion: UnitLocomotion;
  mass: number;
  hp: number;
  fireRange: number | undefined;
};

// Factory component. The host (fabricator platform or mobile queen-style
// producer) produces **units** from a production hold bay resolved by
// factoryProductionHold.ts. The factory carries one active build selection:
// `selectedUnitBlueprintId` is either the unit blueprint to produce
// next/currently or null for off.
// `repeatProduction` is the factory's BAR-style repeat switch: when true,
// the selected unit repeats; when false, completion advances through
// `productionQueue` / clears after the finite queue drains.
// The factory spawns that selected unit as an in-progress shell and holds it
// through the generic EntityHold relation while it absorbs resources from the
// player's stockpiles via energyDistribution.
// `currentShellId` is the shell currently being funded (null while no
// unit is selected). Once the shell flips `isComplete`, the factory clears
// `currentShellId` so the same selected unit can repeat.
//
// Factory ≠ builder: factories produce units from an owned hold bay; builders
// (commanders, future construction aircraft) construct buildings at chosen
// locations.
//
// `currentBuildProgress` is the average fill ratio of that shell,
// kept as a pure UI/snapshot mirror so the production button can draw a
// single progress fraction without looking up the shell entity. On the
// server it is refreshed when resources flow into the shell; on the
// client it is populated from the wire's f.progress field.
type Factory = {
  selectedUnitBlueprintId: string | null;
  /** BAR builder-priority command mirror for factory/lab resource priority. */
  lowPriority: boolean;
  /** BAR carrier spawn ON/OFF command mirror. Only mobile unit factories
   *  (queen-style spawn carriers) expose this in the command UI. */
  carrierSpawnEnabled: boolean;
  /** BAR MOVE_STATE command mirror for labs/factories. Produced land-page
   *  units inherit this state when they leave the factory. */
  moveState: UnitMoveState;
  /** BAR air-plant LAND_AT command mirror. Default `land` matches BAR's
   *  inserted air-factory command descriptor; `fly` maps to CMD.IDLEMODE 0. */
  airIdleState: UnitAirIdleState;
  repeatProduction: boolean;
  /** BAR Wait command mirror for factories/labs. Pauses production without
   *  clearing the current build selection, finite queue, quotas, or progress. */
  paused: boolean;
  productionQueue: string[];
  productionQuotas: Record<string, number>;
  /** Current BAR quota counts by unit blueprint, mirrored from the
   *  authoritative factory-produced-unit provenance index. */
  productionQuotaCounts: Record<string, number>;
  /** Repeat selection to restore after BAR quota one-shots finish. */
  resumeRepeatUnitBlueprintId: string | null;
  currentShellId: EntityId | null;
  currentBuildProgress: number;
  /** Server-owned default route for units this factory produces.
   *  Null means use the mutable single rally point below. The
   *  authoritative production system consumes the route at shell
   *  activation time. On the server it is the planned route; on the
   *  client it is a visualization-only mirror (snapshot `factory.route`)
   *  so the rally line can draw the fight leg + patrol loop, not just
   *  the single rally point. */
  defaultWaypoints: readonly FactoryDefaultWaypoint[] | null;
  rallyX: number;
  rallyY: number;
  rallyZ: number | null;
  rallyType: WaypointType;
  guardTargetId: EntityId | null;
  isProducing: boolean;
  /** Per-resource transfer rate this tick, expressed as a fraction
   *  (0..1) of the factory's `maxResourcePerTick` cap for the active
   *  shell. Drives the resource-ball flow at the factory's pylons
   *  in the 3D renderer. Reset to 0 between shells and whenever the
   *  factory isn't producing. */
  energyRateFraction: number;
  metalRateFraction: number;
};

export type FactoryDefaultWaypoint = {
  x: number;
  y: number;
  z: number | null;
  type: WaypointType | 'guard';
  targetId?: EntityId;
};

// Commander component
type Commander = {
  isDGunActive: boolean;
  dgunEnergyCost: number;
};

// D-gun projectile marker
type DGunProjectile = {
  isDGun: boolean;
  groundOffset: number;
};

// Entity type discriminator. Static hosts are buildings; mounted turrets own
// their combat, production, resource, and observation capabilities.
export type EntityType = 'unit' | 'building' | 'shot';

export type EntityMetaKind = EntityType | 'turret';
export type EntityMetaBlueprintKind =
  | 'unit'
  | 'building'
  | 'turret'
  | 'shot'
  | 'none';
export type EntityMetaStoragePool =
  | 'entities'
  | 'combat.turrets';

export type EntityMeta = {
  id: EntityId;
  kind: EntityMetaKind;
  blueprintKind: EntityMetaBlueprintKind;
  blueprintId: string | null;
  ownerPlayerId: PlayerId | null;
  teamId: number | null;
  parentId: EntityId | null;
  rootHostId: EntityId;
  mountIndex: number | null;
  storagePool: EntityMetaStoragePool;
  storageSlot: number;
  generation: number;
  alive: boolean;
  targetable: boolean;
};

/** Last hostile root host that dealt effective damage to this entity.
 * Guard retaliation reads this short-lived fact; it is deliberately not a
 * combat lock, command, or copy of the protected entity's current target. */
export type RecentAggression = {
  attackerRootHostId: EntityId;
  attackerTurretId: EntityId | null;
  hitTick: number;
};

export type EntityComponentSlots = {
  /** Stable native entity/spatial slot id, or -1 before registry binding. */
  entitySlotId: number;
  body: Body | null;
  selectable: Selectable | null;
  ownership: Ownership | null;
  unit: Unit | null;
  building: Building | null;
  /** Mounted emitter runtime plus per-host combat bookkeeping. Present iff
   *  the entity has at least one runtime turret/emitter. */
  combat: CombatComponent | null;
  /** Short-lived hostile-damage provenance used by guard retaliation. */
  recentAggression: RecentAggression | null;
  projectile: Projectile | null;
  buildable: Buildable | null;
  builder: Builder | null;
  factory: Factory | null;
  commander: Commander | null;
  dgunProjectile: DGunProjectile | null;
  wreck: Wreck | null;
  transport: Transport | null;
  transported: Transported | null;
  heldBy: EntityHold | null;
  buildingBlueprintId: BuildingBlueprintId | null;
  /** For extractors only — every deposit with at least one generated
   *  metal cell under this extractor's fixed build footprint. Output is
   *  computed from the covered metal-cell count, not from whole-deposit
   *  ownership.
   *  Null = inactive (no metal income, no rotor spin). */
  coveredDepositIds: number[] | null;
  /** For extractors only — actual metal/sec this extractor is
   *  producing right now: covered metal-cell count times the per-cell
   *  extractor rate, or 0 when inactive. Kept as a stored field (not
   *  derived) so the renderer's spin animator and the wire format
   *  can read it without re-running the ownership math each frame. */
  metalExtractionRate: number | null;
  /** Legacy cached blueprint full-vision radius. Sensor coverage no
   *  longer reads this because full sight is cheap to recompute and
   *  must not retain old turret-range-derived values across hot reloads. */
  _cachedFullVisionRadius: number;
};

export function createEmptyEntityComponentSlots(): EntityComponentSlots {
  return {
    entitySlotId: -1,
    body: null,
    selectable: null,
    ownership: null,
    unit: null,
    building: null,
    combat: null,
    recentAggression: null,
    projectile: null,
    buildable: null,
    builder: null,
    factory: null,
    commander: null,
    dgunProjectile: null,
    wreck: null,
    transport: null,
    transported: null,
    heldBy: null,
    buildingBlueprintId: null,
    coveredDepositIds: null,
    metalExtractionRate: null,
    _cachedFullVisionRadius: -1,
  };
}

// Full entity data
export type Entity = EntityComponentSlots & {
  id: EntityId;
  type: EntityType;
  transform: Transform;
};
