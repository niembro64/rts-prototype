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
export type ActionType = 'move' | 'fight' | 'patrol' | 'build' | 'repair';

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

// Unit component - movable entities
export type Unit = {
  unitType: string;
  moveSpeed: number;
  drawScale: number;
  radiusColliderUnitShot: number;
  radiusColliderUnitUnit: number;
  mass: number;
  hp: number;
  maxHp: number;
  actions: UnitAction[];
  patrolStartIndex: number | null;
  velocityX?: number;
  velocityY?: number;
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

// Shot configuration (projectile/beam properties)
export type ShotConfig = {
  type?: string;
  speed?: number;
  mass?: number;
  lifespan?: number;
  collision?: { radius: number; damage: number };
  explosion?: {
    primary: { radius: number; damage: number; force: number };
    secondary: { radius: number; damage: number; force: number };
  };
  beam?: { duration?: number; width?: number };
  splashOnExpiry?: boolean;
  piercing?: boolean;
  homingTurnRate?: number;
  trailLength?: number;
};

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
  shot?: ShotConfig;
  forceField?: {
    angle?: number;
    transitionTime?: number;
    push?: ForceFieldZoneConfig | null;
    pull?: ForceFieldZoneConfig | null;
  };
  turretIndex?: number;
};

// Runtime turret instance (per-weapon state on a unit)
export type Turret = {
  config: TurretConfig;
  cooldown: number;
  target: EntityId | null;
  ranges: TurretRanges;
  tracking: boolean;
  engaged: boolean;
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
export type ProjectileType = 'instant' | 'traveling' | 'beam';

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
};

// Economy state per player
export type EconomyState = {
  stockpile: { curr: number; max: number };
  income: { base: number; production: number };
  expenditure: number;
};

// Buildable component
export type Buildable = {
  buildProgress: number;
  energyCost: number;
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
  energyProduction?: number;
  maxEnergyUseRate?: number;
};

// Unit build configuration
export type UnitBuildConfig = {
  unitId: string;
  name: string;
  energyCost: number;
  drawScale: number;
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
