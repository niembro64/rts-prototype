// Simulation entity types extracted from game/sim/types.ts

import type { BarrelShape } from './config';
import type { Vec2, Vec3 } from './vec2';

// Entity ID type for deterministic identification
export type EntityId = number;

// Player ID type
export type PlayerId = number;

// A single hysteresis pair. For outer/max ranges, acquire < release
// prevents flicker at the far edge. For minimum fire ranges, acquire
// is the distance required to start firing and release is the smaller
// distance where an already-firing weapon drops back to tracking.
export type HysteresisRange = {
  acquire: number;
  release: number;
  /** Precomputed squares for hot-path distance checks. */
  acquireSq?: number;
  releaseSq?: number;
};

// Multiplier pair authored directly on each turret blueprint.
export type HysteresisRangeMultiplier = {
  acquire: number;
  release: number;
};

// Computed absolute firing envelope. `max` is the outer fire range;
// `min` is the optional dead zone for mortars and other close-range-
// limited weapons — explicitly `null` when the turret can fire all the
// way down to point-blank.
export type FireEnvelope = {
  min: HysteresisRange | null;
  max: HysteresisRange;
};

// Computed absolute ranges for weapon states (in world units).
//
// `fire` is the firing envelope and is always present. `tracking` is
// the OPTIONAL outer awareness shell — when present, the turret will
// rotate toward an enemy that has entered tracking range even before
// the enemy enters the fire envelope. Set explicitly to `null` for
// turrets that don't need pre-rotation (most weapons).
export type TurretRanges = {
  tracking: HysteresisRange | null;
  fire: FireEnvelope;
};

// Per-weapon fire-envelope multipliers authored directly on each turret
// blueprint.
//
// `engageRangeMin` is `null` when the weapon has no minimum firing
// distance (most direct-fire weapons). `trackingRange` is `null` when
// the turret only ever cares about the fire envelope (acquires +
// engages on contact); set non-null when the turret should be aware of
// — and rotate toward — enemies BEYOND its fire range, e.g. mirror
// turrets that need to be already pointed when an incoming beam lands.
// Tracking-range multipliers MUST exceed `engageRangeMax` so the
// tracking shell sits strictly outside the fire envelope.
export type TurretRangeOverrides = {
  engageRangeMax: HysteresisRangeMultiplier;
  engageRangeMin: HysteresisRangeMultiplier | null;
  trackingRange: HysteresisRangeMultiplier | null;
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
export type BuildingType = 'solar' | 'wind' | 'factory' | 'extractor';

// Unified action for any unit command. Altitude (`z`) carries the
// actual 3D ground point the user clicked (from CursorGround.pickSim
// — the canonical "where on the rendered terrain is the cursor")
// through the command pipeline so renderers visualize waypoints at
// the precise altitude the player saw under the cursor, instead of
// extrapolating it back from (x, y) via a terrain re-sample. Optional
// because AI-issued / path-expanded intermediate waypoints don't
// have a click point — those callers leave it undefined and the
// renderer falls back to a fresh terrain sample.
//
// `isPathExpansion` is true on every intermediate waypoint produced by
// JPS smoothing — the cells inserted along the route that the unit
// must visit but the user did NOT click. The user-clicked endpoint of
// a `findPath` query keeps it false/undefined. Renderers use this flag
// to draw "simple" waypoint visuals (just the user's click points,
// shortcut lines between them) vs. "detailed" (every intermediate
// drawn). Doesn't affect movement — the unit still walks every action.
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
  isPathExpansion?: boolean;
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

export type UnitLocomotion = {
  type: 'wheels' | 'treads' | 'legs';
  /** Authored propulsion scalar supplied by the locomotion blueprint.
   *  GameServer.applyForces converts this into actual 3D force using
   *  terrain tangent, mass, gravity, and external forces. */
  driveForce: number;
  /** Ground traction coefficient. This is the ability to couple drive
   *  force into terrain, not drag. */
  traction: number;
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
  locomotion: UnitLocomotion;
  /** Hit/push radii. `shot` is the projectile-vs-unit collider; `push`
   *  is the unit-vs-unit physics radius. Visual body size is the
   *  separate `bodyRadius` field below — historically `scale` lived
   *  here, but it was the unit's authored body size, not a collider. */
  unitRadiusCollider: { shot: number; push: number };
  /** Authored body radius (world units) — the unit's visible chassis
   *  size. Drives turret head defaults, chassis-mount offsets,
   *  mirror-panel sizing, click hit radius, and barrel placement. */
  bodyRadius: number;
  /** World-space height of the unit's authored body center above terrain.
   *  `unitRadiusCollider.push` remains the push/collision radius. */
  bodyCenterHeight: number;
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
  /** Per-tick combat hot-path masks, written by targetingSystem.
   *  Bit i set in activeTurretMask means turret i still needs rotation
   *  integration this tick; bit i set in firingTurretMask means turret i
   *  is eligible for the fire/recoil path. These are transient sim-only
   *  fields and are never serialized. */
  activeTurretMask?: number;
  firingTurretMask?: number;
  /** Tick before which fully-idle armed units can skip the targeting
   *  pass. Attack commands clear this implicitly by setting
   *  priorityTargetId, and live/cooldown weapons process every tick. */
  nextCombatProbeTick?: number;
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
export type SolarCollectorState = {
  open: boolean;
  producing: boolean;
  reopenDelayMs: number;
};

export type Building = {
  width: number;
  height: number;
  depth: number;
  hp: number;
  maxHp: number;
  /** sqrt(width² + height²) / 2 — precomputed at construction so the
   *  per-tick targeting/damage range checks don't recompute the
   *  bounding-circle radius for every candidate evaluation. Immutable
   *  for the life of the building (dimensions never change). */
  targetRadius: number;
  solar?: SolarCollectorState;
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
  /** Fractional per-instance variance applied to maxLifespan at
   *  projectile creation time. `0.1` means ±10%. */
  lifespanVariance?: number;
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
  /** Thin beam body radius used for obstruction/path tracing. */
  radius: number;
  width: number;
  /** Endpoint damage sphere. The beam line only chooses the terminal
   *  point; this sphere is the actual area that deals damage. */
  damageSphere: { radius: number };
};

// Laser shot — pulsed line weapon with duration + cooldown
export type LaserShot = {
  type: 'laser';
  id: string;
  dps: number;
  force: number;
  recoil: number;
  /** Thin laser body radius used for obstruction/path tracing. */
  radius: number;
  width: number;
  /** Endpoint damage sphere. The laser line only chooses the terminal
   *  point; this sphere is the actual area that deals damage. */
  damageSphere: { radius: number };
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
  rangeOverrides: TurretRangeOverrides;
  /** Smooth this turret's projectile spawn events across snapshot intervals. */
  eventsSmooth: boolean;
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
  /** Cached authoritative world-space mount position, written only by
   *  updateWeaponWorldKinematics. This is sim-only hot-path state;
   *  snapshots still serialize offset/rotation/pitch, not this derived
   *  value. */
  worldPos?: Vec3;
  /** Cached world-space mount velocity computed by
   *  updateWeaponWorldKinematics from worldPos deltas when current, or
   *  from the carrier's velocity as a stale/first-tick fallback. This is
   *  the turret's own 3D motion, so moving/tilted/offset mounts feed
   *  projectile lead and inherited muzzle velocity correctly. */
  worldVelocity?: Vec3;
  /** Simulation tick corresponding to worldPos/worldVelocity. */
  worldPosTick?: number;
  /** Last solver target and signed miss vector in radians. The firing
   *  path uses this to avoid spending shots while a damped turret is
   *  still visibly traversing toward a steep 3D target. */
  aimTargetYaw?: number;
  aimTargetPitch?: number;
  aimErrorYaw?: number;
  aimErrorPitch?: number;
  /** False when the current ballistic projectile aim has no exact
   *  gravity solution. The turret can keep tracking, but firing is held
   *  so it does not spend shells on guaranteed-short fallback shots. */
  ballisticAimInRange?: boolean;
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

/** One vertex of a beam/laser polyline. The same shape covers the
 *  start (muzzle), each mirror reflection, and the end (range
 *  truncation, ground hit, or unit hit). Each point carries its
 *  instantaneous 3D velocity in the world frame so the client can
 *  extrapolate every vertex independently between snapshots — no
 *  separate startVel/endVel fields, no separate reflections list.
 *  Intermediate (reflection) points carry the redirecting mirror's
 *  entityId; start and end leave it undefined. */
export type BeamPoint = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  mirrorEntityId?: EntityId;
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
  sourceEntityId: EntityId;
  config: TurretConfig;
  projectileType: ProjectileType;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  prevX?: number;
  prevY?: number;
  prevZ?: number;
  collisionStartX?: number;
  collisionStartY?: number;
  collisionStartZ?: number;
  timeAlive: number;
  maxLifespan: number;
  /** Beam/laser polyline. Index 0 = start (muzzle), last = end
   *  (range/hit/ground), middles = reflections (each carries its own
   *  mirrorEntityId). Undefined on non-line projectiles. Mutated in
   *  place — each re-trace resizes the array length and overwrites
   *  the per-vertex fields, so the array reference is stable. */
  points?: BeamPoint[];
  /** Internal: previous tick's start position. Used to compute the
   *  per-tick start-point velocity (points[0].vx/vy/vz). Not
   *  serialized. */
  prevStartX?: number;
  prevStartY?: number;
  prevStartZ?: number;
  /** Internal: previous re-trace tick's end position. Used to compute
   *  the end-point velocity across the re-trace stride. Not
   *  serialized. */
  prevEndX?: number;
  prevEndY?: number;
  prevEndZ?: number;
  /** Internal: tick at which prevEnd* was captured, used as the dt for
   *  the next end-velocity finite difference. Not serialized. */
  prevEndTick?: number;
  /** Internal: previous re-trace tick's reflection points keyed by
   *  mirrorEntityId. Used to finite-diff each reflection point's
   *  velocity across the re-trace stride. Not serialized. */
  prevReflectionPoints?: { mirrorEntityId: EntityId; x: number; y: number; z: number; tick: number }[];
  targetEntityId?: EntityId;
  obstructionT?: number;
  obstructionTick?: number;
  hitEntities?: Set<EntityId>;
  maxHits: number;
  hasExploded?: boolean;
  hasLeftSource?: boolean;
  homingTargetId?: EntityId;
  homingTurnRate?: number;
  lastSentVelX?: number;
  lastSentVelY?: number;
  lastSentVelZ?: number;
};

// Economy state per player. `resourceCost` on a buildable is the
// SAME number for energy + mana + metal — every build draws from
// all three pools in lockstep, gated by whichever is most scarce.
export type EconomyState = {
  stockpile: { curr: number; max: number };
  income: { base: number; production: number };
  expenditure: number;
  mana: {
    stockpile: { curr: number; max: number };
    income: { base: number; territory: number };
    expenditure: number;
  };
  metal: {
    stockpile: { curr: number; max: number };
    income: { base: number; extraction: number };
    expenditure: number;
  };
};

// Buildable component. `resourceCost` is the unified cost — the
// build pulls this number of energy AND this number of mana AND this
// number of metal to complete. See EconomyState above.
export type Buildable = {
  buildProgress: number;
  resourceCost: number;
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
  resourceCost: number;
  energyProduction?: number;
  metalProduction?: number;
  maxEnergyUseRate?: number;
};

// Unit build configuration
export type UnitBuildConfig = {
  unitId: string;
  name: string;
  resourceCost: number;
  unitRadiusCollider: { shot: number; push: number };
  bodyRadius: number;
  bodyCenterHeight: number;
  locomotion: UnitLocomotion;
  mass: number;
  hp: number;
  fireRange?: number;
};

// Factory component. `currentBuildResourceCost` is the unified cost
// of the unit currently in production (same number drawn from each
// of the three pools).
export type Factory = {
  buildQueue: string[];
  currentBuildProgress: number;
  currentBuildResourceCost: number;
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
  /** For extractors only — the id of the metal deposit this building
   *  mostly overlaps. Kept for debug/UI; production is cell-fractional. */
  metalDepositId?: number;
  /** For extractors only — actual metal/sec produced from covered deposit cells. */
  metalExtractionRate?: number;
};
