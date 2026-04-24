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

// Single waypoint in a unit's path queue
export type Waypoint = {
  x: number;
  y: number;
  type: WaypointType;
};

// Action types for unified action queue
export type ActionType = 'move' | 'fight' | 'patrol' | 'build' | 'repair' | 'attack';

// Building type identifiers
export type BuildingType = 'solar' | 'factory';

// Unified action for any unit command
export type UnitAction = {
  type: ActionType;
  x: number;
  y: number;
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
  priorityTargetId?: EntityId;
  mirrorPanels: CachedMirrorPanel[];
  mirrorBoundRadius: number;
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
  damage: number;
};

// Projectile shot — fire-and-forget, has mass, single-tick impact
export type ProjectileShot = {
  type: 'projectile';
  id: string;
  mass: number;
  launchForce: number;
  collision: { radius: number; damage: number };
  explosion?: {
    primary: { radius: number; damage: number; force: number };
    secondary: { radius: number; damage: number; force: number };
  };
  splashOnExpiry?: boolean;
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
