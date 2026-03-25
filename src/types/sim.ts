// Simulation entity types extracted from game/sim/types.ts

import type { BarrelShape } from './config';
import type { Vec2 } from './vec2';

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

// Transform component - position and rotation in world space
export type Transform = {
  x: number;
  y: number;
  rotation: number;
  rotCos?: number;
  rotSin?: number;
};

// Body component - reference to physics body
export type Body = {
  physicsBody: import('../game/server/PhysicsEngine').PhysicsBody;
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

// Cached mirror panel geometry (pre-computed from blueprint at entity creation)
export type CachedMirrorPanel = {
  halfWidth: number;
  halfHeight: number;
  offsetX: number;
  offsetY: number;
  angle: number;
};

// Unit component - movable entities
export type Unit = {
  unitType: string;
  moveSpeed: number;
  radiusColliderUnitShot: number;
  radiusColliderUnitUnit: number;
  mass: number;
  hp: number;
  maxHp: number;
  actions: UnitAction[];
  patrolStartIndex: number | null;
  velocityX?: number;
  velocityY?: number;
  priorityTargetId?: EntityId;
  mirrorPanels: CachedMirrorPanel[];
  mirrorBoundRadius: number;
};

// Building component - static structures
export type Building = {
  width: number;
  height: number;
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
};

// Turret FSM state: idle → tracking → engaged
export type TurretState = 'idle' | 'tracking' | 'engaged';

// Runtime turret instance (per-weapon state on a unit)
export type Turret = {
  config: TurretConfig;
  cooldown: number;
  target: EntityId | null;
  ranges: TurretRanges;
  state: TurretState;
  rotation: number;
  angularVelocity: number;
  turnAccel: number;
  drag: number;
  offset: Vec2;
  worldPos?: Vec2;
  burst?: { remaining: number; cooldown: number };
  forceField?: { transition: number; range: number };
};

// Projectile travel types
export type ProjectileType = 'projectile' | 'beam' | 'laser';

// Projectile component
export type Projectile = {
  ownerId: PlayerId;
  sourceEntityId: EntityId;
  config: TurretConfig;
  projectileType: ProjectileType;
  velocityX: number;
  velocityY: number;
  prevX?: number;
  prevY?: number;
  timeAlive: number;
  maxLifespan: number;
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
  targetEntityId?: EntityId;
  obstructionT?: number;
  obstructionTick?: number;
  hitEntities: Set<EntityId>;
  maxHits: number;
  hasExploded?: boolean;
  hasLeftSource?: boolean;
  homingTargetId?: EntityId;
  homingTurnRate?: number;
  reflections?: { x: number; y: number; mirrorEntityId: EntityId }[];
  lastSentVelX?: number;
  lastSentVelY?: number;
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

// Building configuration
export type BuildingConfig = {
  id: BuildingType;
  name: string;
  gridWidth: number;
  gridHeight: number;
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
  radiusColliderUnitShot: number;
  radiusColliderUnitUnit: number;
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
