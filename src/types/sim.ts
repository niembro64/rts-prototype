// Simulation entity types extracted from game/sim/types.ts

import type { BarrelShape } from './config';
import type { TurretBlueprintId } from './blueprintIds';
import type { Vec3 } from './vec2';
import type {
  TurretAimStyle,
  TurretCooldownConfig,
  TurretRadiusConfig,
  TurretRangeVolume,
  TurretSubmunitionEmitterConfig,
  UnitSupportSurface,
  SensorCapabilityConfig,
} from './blueprints';
import type {
  BuildingAnchorProfile,
  BuildingRenderProfile,
  BuildingBlueprintId,
  BuildingSupportSurface,
  StructureBlueprintId,
} from './buildingTypes';
import type {
  UnitAction,
  UnitPathPlan,
  WaypointType,
} from './commandTypes';
import type { TurretRangeOverrides, TurretRanges } from './combatTypes';
import type { ConstructionEmitterSize, ConstructionEmitterVisualSpec } from './constructionTypes';
import { NO_ENTITY_ID, type EntityId, type PlayerId } from './entityTypes';
import type { UnitLocomotion, UnitSuspensionState } from './locomotionTypes';
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
  Waypoint,
  WaypointType,
} from './commandTypes';
export type {
  FireEnvelope,
  HysteresisRange,
  HysteresisRangeMultiplier,
  TurretRangeOverrides,
  TurretRanges,
} from './combatTypes';
export type { EntityId, PlayerId } from './entityTypes';
export { NO_ENTITY_ID } from './entityTypes';
export type { UnitLocomotion } from './locomotionTypes';
export type { ResourceCost } from './economyTypes';
export type { ConstructionEmitterSize, ConstructionEmitterVisualSpec } from './constructionTypes';
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
  RayConfig,
  RayType,
  ProjectileShot,
  ProjectileType,
  ShotConfig,
  ShotProfile,
  ShotRuntimeProfile,
  ShotVisualProfile,
} from './shotTypes';
export {
  RAY_TYPES,
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
export type Body = {
  physicsBody: import('../game/server/PhysicsEngine3D').Body3D;
};

// Selectable tag component
export type Selectable = {
  selected: boolean;
};

// Ownership component - which player owns this entity
export type Ownership = {
  playerId: PlayerId;
};

export type EntityRadii = {
  visual: number;
  hitbox: number;
  collision: number;
};

export type UnitMoveState = 'maneuver' | 'holdPosition' | 'roam';
export type CombatTrajectoryMode = 'auto' | 'low' | 'high';

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
// `thrustDirX/Y` is the desired horizontal thrust vector that
// GameServer.applyForces reads to push the body. Its direction is the
// desired acceleration direction; its magnitude is clamped to [0, 1]
// and scales the unit's available drive force. Decoupling thrust from
// velocity prevents the action system from clobbering the velocity
// field mid-tick before turretSystem's lead math runs.
export type Unit = {
  unitBlueprintId: string;
  locomotion: UnitLocomotion;
  /** Unit radii in world units. `visual` is the drawn chassis/body
   *  authoring radius, `hitbox` is the damage collider, and `collision`
   *  is the unit-vs-unit physics/selection spacing radius. */
  radius: EntityRadii;
  /** World-space height of the unit's authored body center above terrain. */
  bodyCenterHeight: number;
  /** Authored unit support proxy. Unit collision remains sphere-based;
   *  this separate proxy decides whether anything can stand on the unit. */
  supportSurface: UnitSupportSurface;
  /** Authored full-sight sensor radius for this unit. Separate from
   *  weapon, tracking, radar, and builder action range. */
  fullVisionRadius: number;
  /** Authored sensor envelopes for sight/radar/detector/tracking/scan.
   *  `fullVisionRadius` remains a compatibility mirror of
   *  sensors.fullSightRadius. */
  sensors: SensorCapabilityConfig;
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
  patrolStartIndex: number | null;
  /** Current route resolution for actions[0]. This is sim-only state:
   *  actions are durable player/factory waypoints, while activePath
   *  holds transient pathfinder points for the leg being executed. */
  activePath: UnitPathPlan | null;
  /** Flying-only loiter center. When a flying unit exhausts its action
   *  queue, it keeps steering around this last destination instead of
   *  dropping thrust and drifting off-map. */
  flyingLoiterTargetX: number | null;
  flyingLoiterTargetY: number | null;
  flyingLoiterTargetZ: number | null;
  /** Flying-only orbit direction around the loiter center. */
  flyingLoiterTurnSign: number | null;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  /** Authoritative movement/traction acceleration applied this tick,
   *  excluding gravity, terrain spring, air/ground damping, and
   *  transient external forces. Sim-only server force state: it is not
   *  shipped on the wire and client prediction integrates from the
   *  last-seen velocity instead. */
  movementAccelX: number;
  movementAccelY: number;
  movementAccelZ: number;
  /** Desired thrust vector for this tick. Magnitude is a force fraction
   *  (0..1 after clamping); the action system encodes "stationary" as
   *  (0, 0). */
  thrustDirX: number;
  thrustDirY: number;
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
  /** Per-unit EMA accumulator for the jittered hoverHeightUpwardForce
   *  (airborne locomotion only). Updated each tick by UnitForceSystem
   *  when `locomotion.hoverHeightUpwardForceEMA > 0`; null until the
   *  first tick seeds it from the raw sample. Tick-only state, never
   *  serialised. */
  hoverHeightUpwardForceSmoothed: number | null;
  /** Full 3-DOF orientation, used by entities that need roll or
   *  arbitrary orientation (hover drones banking into turns, future
   *  ragdoll debris). Null for ground units that only need a yaw scalar
   *  — those continue to read transform.rotation as before.
   *
   *  Convention: unit quaternion using ZYX intrinsic Euler order
   *  (yaw about world Z, pitch about body Y after yaw, roll about
   *  body X after yaw+pitch). Identity {x:0,y:0,z:0,w:1} matches
   *  transform.rotation = 0 with zero pitch/roll. Renderer/turret
   *  worldPos math can read transform.rotation (kept in sync to the
   *  quat's yaw component) when only heading matters. */
  orientation: { x: number; y: number; z: number; w: number } | null;
  /** Angular velocity 3-vector in world frame (rad/s). Paired with
   *  `orientation`; null when orientation is null. */
  angularVelocity3: { x: number; y: number; z: number } | null;
  /** Angular acceleration 3-vector in world frame (rad/s²). Paired
   *  with `orientation`; null when orientation is null. */
  angularAcceleration3: { x: number; y: number; z: number } | null;
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
export type CombatComponent = {
  /** Runtime turret instances mounted on this entity. Built once at
   *  spawn from the host blueprint's `turrets[]` and persisted across
   *  the entity's lifetime. */
  turrets: Turret[];
  /** Player-controlled fire permission. False is hold-fire: weapons
   *  keep cooldown state but do not acquire, track, or fire at
   *  targets. Always present so command, targeting, and snapshot code
   *  all make an explicit fire/hold decision. */
  fireEnabled: boolean;
  /** Ballistic arc override for hosts with ballistic weapons. `auto`
   *  uses each turret blueprint's authored low/high arc; player
   *  commands can force all ballistic turrets on the host low or high. */
  trajectoryMode: CombatTrajectoryMode;
  /** Player attack-command target. `null` is the canonical "no
   *  priority target" value; setting an EntityId forces every turret
   *  on this entity toward it and fires as soon as it enters fire
   *  range, ignoring the auto-acquisition picker. */
  priorityTargetId: EntityId | null;
  /** Player attack-ground target. Sim-only; action snapshots carry
   *  the visible queued order while targeting/firing reads this per
   *  tick. `null` means no attack-ground point is queued. */
  priorityTargetPoint: Vec3 | null;
  /** Tick before which fully-idle armed entities can skip the
   *  targeting pass. Sentinel `-1` means "always run this tick";
   *  attack commands clear back to `-1` implicitly by setting
   *  priorityTargetId, and live/cooldown weapons process every tick. */
  nextCombatProbeTick: number;
};

export function createCombatComponent(turrets: Turret[]): CombatComponent {
  return {
    turrets,
    fireEnabled: true,
    trajectoryMode: 'auto',
    priorityTargetId: null,
    priorityTargetPoint: null,
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

export type Building = {
  width: number;
  height: number;
  depth: number;
  /** Authored support proxy. This is intentionally separate from the
   *  collision cuboid so a building can block one shape while exposing
   *  a different walkable top, pad, or no top support at all. */
  supportSurface: BuildingSupportSurface;
  hp: number;
  maxHp: number;
  /** sqrt(width² + height²) / 2 — precomputed at construction so the
   *  per-tick targeting/damage range checks don't recompute the
   *  bounding-circle radius for every candidate evaluation. Immutable
   *  for the life of the building (dimensions never change). */
  targetRadius: number;
  activeState: BuildingActiveState | null;
};

// Turret configuration (compiled turret definition)
export type TurretConfig = {
  turretBlueprintId: TurretBlueprintId;
  range: number;
  rangeVolume: TurretRangeVolume;
  cooldown: TurretCooldownConfig | null;
  color: number;
  barrel: BarrelShape;
  angular: { turnAccel: number; drag: number };
  rangeOverrides: TurretRangeOverrides;
  /** Smooth this turret's projectile spawn events across snapshot intervals. */
  eventsSmooth: boolean;
  spread: { pelletCount: number; angle: number } | null;
  burst: { count: number; delay: number } | null;
  isManualFire: boolean;
  passive: boolean;
  /** Actual terrain/entity line-of-sight gate for this turret. Cross
   *  shield sight obstruction is a separate battle setting. */
  requiresNonObstructedLineOfSight: boolean;
  /** Null for visual-only construction emitters. Those turrets
   *  mount renderer-owned construction hardware but do not represent a
   *  simulated weapon or projectile. */
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
  /** World-space radius of the rendered turret body sphere. */
  radius: TurretRadiusConfig;
  /** See TurretBlueprint.headOnly — turrets with no barrel visual.
   *  Rendered as a head sphere only; head color shifts halfway toward
   *  white when the turret is engaged. Head-only turrets skip yaw/pitch
   *  pose and rotation/pitch/velocity snapshots; beam/laser presentation
   *  travels through beam endpoint updates. */
  headOnly: boolean;
  /** Visual-only turret hardpoints do not acquire targets or fire.
   *  They exist so reusable turret art, such as construction emitters,
   *  can mount through the same blueprint path as combat turrets. */
  visualOnly: boolean;
  /** Host-directed turret. See TurretBlueprint.hostDirected. */
  hostDirected: boolean;
  /** Unit-mount authored fight/patrol stop gate. If true, this turret must
   *  be engaged before the host halts for fight/patrol combat. */
  requiredEngagedForFightStop: boolean;
  constructionEmitter: ConstructionEmitterVisualSpec | null;
  visualVariant: ConstructionEmitterSize | null;
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
  /** Source-turret visual barrel geometry. Present only for turret-fired shots. */
  barrel: BarrelShape | null;
  radius: TurretRadiusConfig | null;
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
  parentId: EntityId;
  rootHostId: EntityId;
  mountIndex: number;
  config: TurretConfig;
  target: EntityId | null;
  ranges: TurretRanges;
  state: TurretState;
  rotation: number;
  pitch: number;
  angularVelocity: number;
  /** Yaw angular acceleration (rad/s²) produced by this tick's
   *  damped-spring step (`α = k·(aim − rot) − c·ω`). Sim-only turret
   *  solver state: acceleration is not shipped on the wire and the
   *  client predicts from angular velocity plus EMA correction. */
  angularAcceleration: number;
  /** Angular velocity of the pitch axis (rad/s). Driven by the
   *  damped-spring integrator in turretSystem — the solver sets a
   *  target pitch each tick and the damper converges on it without
   *  overshoot, so tick-to-tick jitter in the ballistic solution
   *  (e.g. from moving targets) doesn't propagate into visible
   *  barrel oscillation. */
  pitchVelocity: number;
  /** Pitch angular acceleration (rad/s²); same sim-only shape as
   *  angularAcceleration, only for the elevation axis. */
  pitchAcceleration: number;
  turnAccel: number;
  drag: number;
  /** Chassis-local 3D weapon pivot in world units. Derived once from
   *  the owning unit blueprint's `turrets[i].mount` and used as the
   *  source of truth for sim targeting/firing and client rendering. */
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
  shield: { transition: number; range: number } | null;
  /** Round-robin pointer across the physical barrels on this turret.
   *  Each fired pellet picks barrelIndex = (barrelFireIndex + pellet)
   *  % barrelCount, then the pointer advances by the pellet count.
   *  Single-barrel turrets always see barrelIndex = 0. */
  barrelFireIndex: number;
};

// Projectile component. Fully 3D: velocity + prev/start/end points
// all carry altitude. Projectile gravity is applied in the sim's
// projectile system each tick (ballistic arc); beams and lasers
// ignore vz and gravity (they're instantaneous line weapons).
// Beam polylines (start → reflections → end) live in `points`; each
// point carries its own (vx, vy, vz) so reflected/redirected beams
// can extrapolate every vertex on the client between snapshots.
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
  projectileType: ProjectileType;
  /** Travelling shot health. Beams/lasers are sustained emissions and
   *  keep this at 0 so they are not damageable shot bodies. */
  hp: number;
  maxHp: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
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
  /** Beam/laser polyline. Index 0 = start (turret mount center), last = end
   *  (range/hit/ground/terminal reflector), middles = reflections.
   *  Reflection vertices carry reflector metadata via the legacy
   *  reflectorEntityId field plus reflectorKind/normal*. Null on
   *  non-line projectiles. Mutated in place — each re-trace resizes
   *  the array length and overwrites the per-vertex fields, so the
   *  array reference is stable. */
  points: BeamPoint[] | null;
  /** False when the path has no physical impact endpoint, such as a
   *  no-hit range boundary or BEAM_MAX_SEGMENTS ending on a reflector.
   *  The beam is still rendered, but no endpoint damage sphere applies. */
  endpointDamageable: boolean | null;
  segmentLimitReached: boolean;
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
  /** Traveling plasma/rocket shots can only collide/explode after their
   *  authored arming delay has elapsed. The projectile system flips
   *  this and resets collisionStart* to the arming point. */
  isArmed: boolean;
  /** False until the shot's active point has cleared the source unit's
   *  shot sphere. Source-clearance gating is retained for line shots
   *  whose endpoint damage starts inside the firing unit. */
  hasLeftSource: boolean;
  /** Sentinel `NO_ENTITY_ID` means this projectile is not homing. */
  homingTargetId: EntityId;
  homingTurnRate: number | null;
  lastSentVelX: number | null;
  lastSentVelY: number | null;
  lastSentVelZ: number | null;
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

export type ProjectileAbsenceSlots = Pick<Projectile,
  | 'prevX'
  | 'prevY'
  | 'prevZ'
  | 'collisionStartX'
  | 'collisionStartY'
  | 'collisionStartZ'
  | 'points'
  | 'endpointDamageable'
  | 'segmentLimitReached'
  | 'sourceBarrelIndex'
  | 'prevStartX'
  | 'prevStartY'
  | 'prevStartZ'
  | 'prevEndX'
  | 'prevEndY'
  | 'prevEndZ'
  | 'prevEndTick'
  | 'prevReflectionPoints'
  | 'targetEntityId'
  | 'obstructionT'
  | 'obstructionTick'
  | 'hasExploded'
  | 'homingTurnRate'
  | 'lastSentVelX'
  | 'lastSentVelY'
  | 'lastSentVelZ'
  | 'pendingReflectionX'
  | 'pendingReflectionY'
  | 'pendingReflectionZ'
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
  sourceBarrelIndex: -1,
  prevStartX: null,
  prevStartY: null,
  prevStartZ: null,
  prevEndX: null,
  prevEndY: null,
  prevEndZ: null,
  prevEndTick: -1,
  prevReflectionPoints: null,
  targetEntityId: NO_ENTITY_ID,
  obstructionT: null,
  obstructionTick: -1,
  hasExploded: false,
  homingTurnRate: null,
  lastSentVelX: null,
  lastSentVelY: null,
  lastSentVelZ: null,
  pendingReflectionX: null,
  pendingReflectionY: null,
  pendingReflectionZ: null,
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
  isGhost: boolean;
  /** True once construction was cancelled after at least one real
   *  piece materialized. Funding stops, but the piece records remain
   *  authoritative for rendering/targeting the partial assembly. */
  isInterrupted: boolean;
  healthBuildFraction: number;
  pieces: ConstructionPieceBuildRecord[];
};

/** Builder component. Gives a unit the ability to construct
 *  **buildings** (and assist/repair them) anywhere within `buildRange`.
 *  The host visualizes the work through a `turretConstruction` mount.
 *
 *  Builder ≠ factory: buildings come from builders, units come from
 *  factories. Currently mounted on commanders; the planned construction
 *  aircraft will use the same component with a hover locomotion. */
export type Builder = {
  buildRange: number;
  /** Max resource units per second this builder can add to each
   *  construction resource lane. Repair uses the same work-rate cap
   *  for its energy cost. */
  constructionRate: number;
  allowedBuildBlueprintIds: readonly StructureBlueprintId[];
  /** Sentinel `NO_ENTITY_ID` means no direct construction target. */
  currentBuildTarget: EntityId;
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
  hud: import('./blueprints').EntityHudBlueprint;
  sensors: SensorCapabilityConfig;
};

// Unit build configuration
export type UnitBuildConfig = {
  unitBlueprintId: string;
  name: string;
  cost: ResourceCost;
  radius: EntityRadii;
  bodyCenterHeight: number;
  supportSurface: UnitSupportSurface;
  locomotion: UnitLocomotion;
  mass: number;
  hp: number;
  fireRange: number | undefined;
};

// Factory component. The host (today: the fabricator platform) produces
// **units** from a fixed launch spot at the center of its footprint. The factory
// carries one active build selection: `selectedUnitBlueprintId` is either
// the unit blueprint to produce next/currently or null for off.
// `repeatProduction` decides whether that selection repeats forever or
// advances through `productionQueue` / clears after one completed unit.
// The factory
// spawns that selected unit as an airborne shell above its center bay; the
// shell then falls through normal physics and absorbs resources from the
// player's stockpiles via energyDistribution regardless of where it settles.
// `currentShellId` is the shell currently being funded (null while no
// unit is selected). Once the shell flips `isComplete`, the factory clears
// `currentShellId` so the same selected unit can repeat.
//
// Factory ≠ builder: factories produce units from a fixed center launch spot;
// builders (commanders, future construction aircraft) construct buildings
// at chosen locations.
//
// `currentBuildProgress` is the average fill ratio of that shell,
// kept as a pure UI/snapshot mirror so the production button can draw a
// single progress fraction without looking up the shell entity. On the
// server it is refreshed when resources flow into the shell; on the
// client it is populated from the wire's f.progress field.
export type Factory = {
  selectedUnitBlueprintId: string | null;
  repeatProduction: boolean;
  productionQueue: string[];
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
  type: WaypointType;
};

// Commander component
export type Commander = {
  isDGunActive: boolean;
  dgunEnergyCost: number;
};

// D-gun projectile marker
export type DGunProjectile = {
  isDGun: boolean;
  groundOffset: number;
};

// Entity type discriminator. Towers are the immobile peer of units: they
// mount turrets and carry a host-level lock-on, but have no locomotion.
// See budget_design_philosophy.html "Towers Are Static Hosts That Lock On And Fire".
export type EntityType = 'unit' | 'tower' | 'building' | 'shot';

export type EntityMetaKind = EntityType | 'turret';
export type EntityMetaBlueprintKind =
  | 'unit'
  | 'tower'
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

export type EntityComponentSlots = {
  body: Body | null;
  selectable: Selectable | null;
  ownership: Ownership | null;
  unit: Unit | null;
  building: Building | null;
  /** Combat capability — turrets + per-host bookkeeping. Present iff
   *  the entity has at least one runtime turret (combat OR visualOnly).
   *  The cache only adds entities to the armed list when at least one
   *  of those turrets is non-visualOnly. */
  combat: CombatComponent | null;
  projectile: Projectile | null;
  buildable: Buildable | null;
  builder: Builder | null;
  factory: Factory | null;
  commander: Commander | null;
  dgunProjectile: DGunProjectile | null;
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
    body: null,
    selectable: null,
    ownership: null,
    unit: null,
    building: null,
    combat: null,
    projectile: null,
    buildable: null,
    builder: null,
    factory: null,
    commander: null,
    dgunProjectile: null,
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
