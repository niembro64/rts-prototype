// Simulation entity types extracted from game/sim/types.ts

import type { BarrelShape } from './config';
import type { Vec2, Vec3 } from './vec2';

// Entity ID type for deterministic identification
export type EntityId = number;

// Player ID type
export type PlayerId = number;

// A single hysteresis pair: acquire (inner) < release (outer)
export type HysteresisRange = {
  acquire: number;
  release: number;
};

// Nullable hysteresis pair for per-weapon overrides (null = use global default)
export type HysteresisRangeOverride = {
  acquire: number | null;
  release: number | null;
};

// Computed absolute ranges for both weapon states (in world units)
export type TurretRanges = {
  tracking: HysteresisRange;
  engage: HysteresisRange;
};

// Range multipliers relative to weapon's base range
export type TurretRangeMultipliers = TurretRanges;

// Per-weapon range overrides (null = fall back to global default)
export type TurretRangeOverrides = {
  tracking: HysteresisRangeOverride;
  engage: HysteresisRangeOverride;
};

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
  rotCos?: number;
  rotSin?: number;
};

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

// Waypoint types for unit movement
export type WaypointType = 'move' | 'fight' | 'patrol';

// Single waypoint in a unit's path queue. Altitude (`z`) is optional —
// player-issued waypoints carry the click's actual 3D ground altitude
// (from CursorGround.pickSim) so renderers / handlers don't have to
// re-sample terrain to visualize them. AI-issued or path-expanded
// intermediate waypoints leave it undefined and fall back to a
// terrain sample at the (x, y).
export type Waypoint = {
  x: number;
  y: number;
  z?: number;
  type: WaypointType;
};

// Action types for unified action queue
export type ActionType = 'move' | 'fight' | 'patrol' | 'build' | 'repair' | 'attack';

// Building type identifiers
export type BuildingType = 'solar' | 'factory';

// Unified action for any unit command. Altitude (`z`) carries the
// actual 3D ground point the user clicked (from CursorGround.pickSim
// — the canonical "where on the rendered terrain is the cursor")
// through the command pipeline so renderers visualize waypoints at
// the precise altitude the player saw under the cursor, instead of
// extrapolating it back from (x, y) via a terrain re-sample. Optional
// because AI-issued / path-expanded intermediate waypoints don't
// have a click point — those callers leave it undefined and the
// renderer falls back to a fresh terrain sample.
export type UnitAction = {
  type: ActionType;
  x: number;
  y: number;
  z?: number;
  buildingType?: BuildingType;
  gridX?: number;
  gridY?: number;
  buildingId?: EntityId;
  targetId?: EntityId;
};

// Cached mirror panel geometry (pre-computed from blueprint at entity creation).
// halfWidth  — half the panel's edge length (along the horizontal edge direction).
// halfHeight — legacy 2D thickness value from the blueprint; unused in 3D
//              collision (panels are vertical infinitely-thin rectangles) but
//              kept so 2D art paths still read meaningful numbers.
// baseY/topY — world-y above the unit's ground footprint defining the
//              panel's vertical span. Shared across all of a unit's panels
//              because they all sit flush with the unit body (baseY=MIRROR_BASE_Y)
//              and run up to body-top + TURRET_HEIGHT (topY, per-unit).
export type CachedMirrorPanel = {
  halfWidth: number;
  halfHeight: number;
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
// `thrustDirX/Y` is the desired-thrust unit vector (the action system's
// "where do I want to go this tick?") that GameServer.applyForces
// reads to push the body. Decoupling thrust from velocity prevents the
// action system from clobbering the velocity field mid-tick before
// turretSystem's lead math runs.
export type Unit = {
  unitType: string;
  moveSpeed: number;
  unitRadiusCollider: { scale: number; shot: number; push: number };
  mass: number;
  hp: number;
  maxHp: number;
  actions: UnitAction[];
  patrolStartIndex: number | null;
  velocityX?: number;
  velocityY?: number;
  velocityZ?: number;
  /** Desired thrust direction for this tick. Magnitude is irrelevant
   *  (applyForces normalizes), but the action system encodes
   *  "stationary" as (0, 0). */
  thrustDirX?: number;
  thrustDirY?: number;
  priorityTargetId?: EntityId;
  mirrorPanels: CachedMirrorPanel[];
  mirrorBoundRadius: number;
  /** Consecutive ticks the unit has wanted to move but failed to make
   *  meaningful progress. Reset on either no-movement-intent ticks or
   *  ticks where physics velocity exceeds the stuck threshold. When
   *  this exceeds the simulation's stuck threshold the planner gets
   *  re-run from the unit's current position to the trip's final
   *  destination, replacing the stale path. Tick-only state, never
   *  serialised. */
  stuckTicks?: number;
};

// Building component - static structures with a real 3D extent.
// width (x-footprint) × height (y-footprint) × depth (z, vertical).
// The physics engine stores the building as a cuboid centered at
// (transform.x, transform.y, depth/2) so the base sits on the ground.
export type Building = {
  width: number;
  height: number;
  depth: number;
  hp: number;
  maxHp: number;
};

// Force field zone configuration (push or pull)
export type ForceFieldZoneConfig = {
  innerRange: number;
  outerRange: number;
  color: number;
  alpha: number;
  particleAlpha: number;
  power: number | null;
};

// Projectile shot — fire-and-forget, has mass, single-tick impact
export type ProjectileShot = {
  type: 'projectile';
  id: string;
  mass: number;
  launchForce: number;
  collision: { radius: number };
  /** Splash AoE — single radius, boolean damage + force application.
   *  See ShotExplosion in types/blueprints. */
  explosion?: { radius: number; damage: number; force: number };
  /** When true, run detonation logic (splash damage if `explosion`,
   *  submunition spawn if `submunitions`, audio either way) at the end
   *  of `lifespan`. See ProjectileShotBlueprint.detonateOnExpiry. */
  detonateOnExpiry?: boolean;
  lifespan?: number;
  homingTurnRate?: number;
  trailLength?: number;
  /** Cluster / flak-burst behavior — see SubmunitionSpec in types/blueprints.ts.
   *  Evaluated by the collision handler at the moment of explosion. */
  submunitions?: import('./blueprints').SubmunitionSpec;
  /** Rocket/missile flag — gravity is not applied to vz while this
   *  shot is in flight. Shared sim + client state so predicted arcs
   *  match authoritative arcs. Orthogonal to homingTurnRate. */
  ignoresGravity?: boolean;
  /** Cosmetic 3D-client trail config. Presence => smoke is on. See
   *  ProjectileShotBlueprint.smokeTrail / SmokeTrailSpec for fields. */
  smokeTrail?: import('./blueprints').SmokeTrailSpec;
  /** Cosmetic 3D-client mesh shape. 'cylinder' aligns with velocity
   *  for rockets/missiles; 'sphere' (default) is an isotropic ball.
   *  Sim collision is always sphere-based — see ShotCollision.radius. */
  shape?: 'sphere' | 'cylinder';
  /** When shape === 'cylinder', overrides the default rendered pill
   *  dimensions (multiples of collision.radius). */
  cylinderShape?: import('./blueprints').CylinderShapeSpec;
};

// Beam shot — continuous line from turret, per-tick damage (no cooldown)
export type BeamShot = {
  type: 'beam';
  id: string;
  dps: number;
  force: number;
  recoil: number;
  radius: number;
  width: number;
};

// Laser shot — pulsed line weapon with duration + cooldown
export type LaserShot = {
  type: 'laser';
  id: string;
  dps: number;
  force: number;
  recoil: number;
  radius: number;
  width: number;
  duration: number;
};

// Shared type for beam and laser (line weapons)
export type LineShot = BeamShot | LaserShot;

export function isLineShot(shot: ShotConfig): shot is LineShot {
  return shot.type === 'beam' || shot.type === 'laser';
}

// Force shot — continuous area effect around turret (pie-slice push/pull zones)
export type ForceShot = {
  type: 'force';
  angle: number;
  transitionTime: number;
  push?: ForceFieldZoneConfig;
  pull?: ForceFieldZoneConfig;
};

// Discriminated union of all shot types
export type ShotConfig = ProjectileShot | BeamShot | LaserShot | ForceShot;

// Turret configuration (compiled turret definition)
export type TurretConfig = {
  id: string;
  range: number;
  cooldown: number;
  color?: number;
  barrel?: BarrelShape;
  angular: { turnAccel: number; drag: number };
  rangeOverrides?: TurretRangeOverrides;
  spread?: { pelletCount?: number; angle?: number };
  burst?: { count?: number; delay?: number };
  isManualFire?: boolean;
  passive?: boolean;
  shot: ShotConfig;
  turretIndex?: number;
  /** Ballistic arc choice for the aim solver — `true` = lofted (high
   *  arc, mortar-style); `false`/omitted = flat (low arc, direct-fire
   *  style). See TurretBlueprint.highArc. */
  highArc?: boolean;
  /** VLS: turret stays pitched straight up and fires every pellet
   *  into a random cone around vertical. See TurretBlueprint
   *  .verticalLauncher. */
  verticalLauncher?: boolean;
  /** Aim a fraction of the way to the target on the ground rather
   *  than at the target itself; the round detonates short and its
   *  submunitions (if any) bounce + spread the rest of the way. See
   *  TurretBlueprint.groundAimFraction. */
  groundAimFraction?: number;
  /** World-space radius of the rendered turret-head sphere. Overrides
   *  the unit-scale-derived default. See TurretBlueprint.bodyRadius. */
  bodyRadius?: number;
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
  config: TurretConfig;
  cooldown: number;
  target: EntityId | null;
  ranges: TurretRanges;
  state: TurretState;
  rotation: number;
  pitch: number;
  angularVelocity: number;
  /** Angular velocity of the pitch axis (rad/s). Driven by the
   *  damped-spring integrator in turretSystem — the solver sets a
   *  target pitch each tick and the damper converges on it without
   *  overshoot, so tick-to-tick jitter in the ballistic solution
   *  (e.g. from moving targets) doesn't propagate into visible
   *  barrel oscillation. */
  pitchVelocity: number;
  turnAccel: number;
  drag: number;
  offset: Vec2;
  worldPos?: Vec3;
  burst?: { remaining: number; cooldown: number };
  forceField?: { transition: number; range: number };
  /** Round-robin pointer across the physical barrels on this turret.
   *  Each fired pellet picks barrelIndex = (barrelFireIndex + pellet) %
   *  barrelCount, then the pointer advances by the pellet count. Gives
   *  gatlings a visible per-shot barrel cycle without any floating
   *  spin-angle sync. Single-barrel turrets always see barrelIndex = 0. */
  barrelFireIndex?: number;
};

// Projectile travel types
export type ProjectileType = 'projectile' | 'beam' | 'laser';

// Projectile component. Fully 3D: velocity + prev/start/end points
// all carry altitude. Projectile gravity is applied in the sim's
// projectile system each tick (ballistic arc); beams and lasers
// ignore vz and gravity (they're instantaneous line weapons).
// Reflection points (mirror beams) also preserve z for 3D laser
// tracing.
export type Projectile = {
  ownerId: PlayerId;
  sourceEntityId: EntityId;
  config: TurretConfig;
  projectileType: ProjectileType;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  prevX?: number;
  prevY?: number;
  prevZ?: number;
  timeAlive: number;
  maxLifespan: number;
  startX?: number;
  startY?: number;
  startZ?: number;
  endX?: number;
  endY?: number;
  endZ?: number;
  targetEntityId?: EntityId;
  obstructionT?: number;
  obstructionTick?: number;
  hitEntities: Set<EntityId>;
  maxHits: number;
  hasExploded?: boolean;
  hasLeftSource?: boolean;
  homingTargetId?: EntityId;
  homingTurnRate?: number;
  reflections?: { x: number; y: number; z: number; mirrorEntityId: EntityId }[];
  lastSentVelX?: number;
  lastSentVelY?: number;
  lastSentVelZ?: number;
};

// Economy state per player
export type EconomyState = {
  stockpile: { curr: number; max: number };
  income: { base: number; production: number };
  expenditure: number;
  mana: {
    stockpile: { curr: number; max: number };
    income: { base: number; territory: number };
    expenditure: number;
  };
};

// Buildable component
export type Buildable = {
  buildProgress: number;
  energyCost: number;
  manaCost: number;
  isComplete: boolean;
  isGhost: boolean;
};

// Builder component
export type Builder = {
  buildRange: number;
  maxEnergyUseRate: number;
  currentBuildTarget: EntityId | null;
};

// Building configuration. gridWidth/gridHeight are the footprint on
// the ground plane (measured in grid cells); gridDepth is the
// vertical extent (how many cell-heights tall the building stands).
// The sim is fully 3D, so buildings need a real z-extent — it's a
// first-class property of the shape, not a render-only detail.
export type BuildingConfig = {
  id: BuildingType;
  name: string;
  gridWidth: number;
  gridHeight: number;
  gridDepth: number;
  hp: number;
  energyCost: number;
  manaCost: number;
  energyProduction?: number;
  maxEnergyUseRate?: number;
};

// Unit build configuration
export type UnitBuildConfig = {
  unitId: string;
  name: string;
  energyCost: number;
  unitRadiusCollider: { scale: number; shot: number; push: number };
  moveSpeed: number;
  mass: number;
  hp: number;
  seeRange?: number;
  fireRange?: number;
};

// Factory component
export type Factory = {
  buildQueue: string[];
  currentBuildProgress: number;
  currentBuildCost: number;
  currentBuildManaCost: number;
  rallyX: number;
  rallyY: number;
  isProducing: boolean;
  waypoints: Waypoint[];
};

// Commander component
export type Commander = {
  isDGunActive: boolean;
  dgunEnergyCost: number;
};

// D-gun projectile marker
export type DGunProjectile = {
  isDGun: boolean;
};

// Entity type discriminator
export type EntityType = 'unit' | 'building' | 'shot';

// Full entity data
export type Entity = {
  id: EntityId;
  type: EntityType;
  transform: Transform;
  body?: Body;
  selectable?: Selectable;
  ownership?: Ownership;
  unit?: Unit;
  building?: Building;
  turrets?: Turret[];
  projectile?: Projectile;
  buildable?: Buildable;
  builder?: Builder;
  factory?: Factory;
  commander?: Commander;
  dgunProjectile?: DGunProjectile;
  buildingType?: BuildingType;
};
