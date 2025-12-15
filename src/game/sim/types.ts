// Entity ID type for deterministic identification
export type EntityId = number;

// Player ID type
export type PlayerId = number;

// Transform component - position and rotation in world space
export interface Transform {
  x: number;
  y: number;
  rotation: number;
}

// Body component - reference to Matter.js body
export interface Body {
  matterBody: MatterJS.BodyType;
}

// Selectable tag component
export interface Selectable {
  selected: boolean;
}

// Ownership component - which player owns this entity
export interface Ownership {
  playerId: PlayerId;
}

// Waypoint types for unit movement (legacy - used by factories for rally points)
export type WaypointType = 'move' | 'fight' | 'patrol';

// Single waypoint in a unit's path queue (legacy - used by factories)
export interface Waypoint {
  x: number;
  y: number;
  type: WaypointType;
}

// Action types for unified action queue
export type ActionType = 'move' | 'fight' | 'patrol' | 'build' | 'repair';

// Unified action for any unit command - replaces separate waypoints and buildQueue
export interface UnitAction {
  type: ActionType;
  // Target position (destination for all action types)
  x: number;
  y: number;
  // For build actions (commander only)
  buildingType?: BuildingType;
  gridX?: number;
  gridY?: number;
  buildingId?: EntityId;  // Set after building entity is created
  // For repair actions (commander only) - targetId is the entity to repair
  targetId?: EntityId;
}

// Unit component - movable entities
export interface Unit {
  moveSpeed: number;
  collisionRadius: number;  // Hitbox size for physics and click detection
  hp: number;
  maxHp: number;
  // Unified action queue - units process these in order
  actions: UnitAction[];
  // Index for patrol looping (points to first patrol action when looping)
  patrolStartIndex: number | null;
  // Movement velocity (for rendering movement direction)
  velocityX?: number;
  velocityY?: number;
  // Turret/weapon rotation (separate from body rotation)
  turretRotation?: number;
  // Turret turn rate (radians per second) - how fast the turret can rotate
  turretTurnRate: number;
  // Vision range - turret starts tracking when enemies are within this range
  visionRange: number;
}

// Building component - static structures
export interface Building {
  width: number;
  height: number;
  hp: number;
  maxHp: number;
}

// Weapon configuration - flexible system for any weapon type
export interface WeaponConfig {
  id: string;                    // Unique identifier (e.g., 'laser', 'minigun', 'cannon')
  damage: number;                // Base damage per hit
  range: number;                 // Attack range
  cooldown: number;              // Time between attacks (ms)

  // Projectile properties (optional based on weapon type)
  projectileSpeed?: number;      // Speed of projectile (undefined = hitscan)
  projectileRadius?: number;     // Size of projectile hitbox
  projectileLifespan?: number;   // Max time projectile exists (ms)

  // Beam/laser properties
  beamDuration?: number;         // How long beam persists (ms)
  beamWidth?: number;            // Width of beam hitbox

  // Spread/multi-shot properties
  pelletCount?: number;          // Number of projectiles per shot
  spreadAngle?: number;          // Angle of spread (radians)

  // AoE/splash properties
  splashRadius?: number;         // Radius of splash damage
  splashDamageFalloff?: number;  // Damage multiplier at edge (0-1)

  // Burst fire properties
  burstCount?: number;           // Shots per burst
  burstDelay?: number;           // Time between burst shots (ms)

  // Visual properties
  color?: number;                // Projectile/beam color
  trailLength?: number;          // Visual trail length

  // Future extensibility - any additional params
  [key: string]: unknown;
}

// Weapon component - attached to units
export interface Weapon {
  config: WeaponConfig;
  currentCooldown: number;       // Time until can fire again (ms)
  targetEntityId: EntityId | null; // Current target

  // Burst state
  burstShotsRemaining?: number;
  burstCooldown?: number;
}

// Projectile travel types
export type ProjectileType = 'instant' | 'traveling' | 'beam';

// Projectile component
export interface Projectile {
  ownerId: PlayerId;             // Who fired this
  sourceEntityId: EntityId;      // Which unit fired this
  config: WeaponConfig;          // Weapon that created this

  projectileType: ProjectileType;

  // Movement (for traveling projectiles)
  velocityX: number;
  velocityY: number;

  // Lifespan
  timeAlive: number;             // How long it's existed (ms)
  maxLifespan: number;           // When to remove (ms)

  // Beam specific
  startX?: number;               // Beam origin
  startY?: number;
  endX?: number;                 // Beam endpoint
  endY?: number;
  targetEntityId?: EntityId;     // Target for tracking beams (updates every frame)

  // Tracking which entities were hit (for piercing or single-hit)
  hitEntities: Set<EntityId>;
  maxHits: number;               // How many entities it can hit (1 = single, Infinity = pierce all)

  // AoE tracking
  hasExploded?: boolean;
}

// ==================== ECONOMY & CONSTRUCTION ====================

// Economy state per player
export interface EconomyState {
  stockpile: number;        // Current energy
  maxStockpile: number;     // Max energy storage
  baseIncome: number;       // Minimum income (always received)
  production: number;       // Energy from solar panels
  expenditure: number;      // Current energy being spent (building/repairs)
}

// Buildable component - for entities under construction
export interface Buildable {
  buildProgress: number;    // 0-1 progress (1 = complete)
  energyCost: number;       // Total energy to build
  maxBuildRate: number;     // Max energy/sec that can be applied
  isComplete: boolean;      // Whether construction is finished
  isGhost: boolean;         // Whether this is a placement ghost (not yet started)
}

// Builder component - for units that can construct
export interface Builder {
  buildRate: number;        // Energy/sec this builder can contribute
  buildRange: number;       // Max distance to construction site
  currentBuildTarget: EntityId | null;  // What we're building/assisting
}

// Building type identifiers
export type BuildingType = 'solar' | 'factory';

// Building configuration
export interface BuildingConfig {
  id: BuildingType;
  name: string;
  gridWidth: number;        // Grid cells wide
  gridHeight: number;       // Grid cells tall
  hp: number;
  energyCost: number;
  maxBuildRate: number;     // Max energy/sec for construction
  energyProduction?: number; // For solar panels
  unitBuildRate?: number;   // For factories - max energy/sec for unit production
}

// Unit build configuration (extends weapon config concept)
export interface UnitBuildConfig {
  weaponId: string;
  name: string;
  energyCost: number;
  maxBuildRate: number;     // Max energy/sec for construction
  collisionRadius: number;  // Hitbox size for physics
  moveSpeed: number;
  hp: number;
  visionRange?: number;     // Optional - defaults to weapon range * 1.5
}

// Factory component - for unit production
export interface Factory {
  buildQueue: string[];     // Queue of weapon IDs to build
  currentBuildProgress: number;  // 0-1 for current unit
  currentBuildCost: number;      // Energy cost of current unit
  currentBuildRate: number;      // Max rate for current unit
  rallyX: number;           // Where completed units go (legacy, first waypoint)
  rallyY: number;
  isProducing: boolean;
  waypoints: Waypoint[];    // Waypoints inherited by produced units
}

// Commander component - special abilities
export interface Commander {
  isDGunActive: boolean;    // D-gun mode enabled
  dgunEnergyCost: number;   // Energy cost per d-gun shot
  // Note: buildQueue removed - now uses unit.actions for building/repair queue
}

// D-gun projectile marker
export interface DGunProjectile {
  isDGun: boolean;
}

// Entity type discriminator
export type EntityType = 'unit' | 'building' | 'projectile';

// Full entity data (components are optional based on entity type)
export interface Entity {
  id: EntityId;
  type: EntityType;
  transform: Transform;
  body?: Body;
  selectable?: Selectable;
  ownership?: Ownership;
  unit?: Unit;
  building?: Building;
  weapon?: Weapon;
  projectile?: Projectile;
  // New components
  buildable?: Buildable;
  builder?: Builder;
  factory?: Factory;
  commander?: Commander;
  dgunProjectile?: DGunProjectile;
  buildingType?: BuildingType;  // What kind of building this is
}

// Player colors - balanced for similar intensity/softness while remaining distinguishable
// All colors tuned to ~65% saturation and ~70% lightness for a cohesive soft look
export const PLAYER_COLORS: Record<PlayerId, { primary: number; secondary: number; name: string }> = {
  1: { primary: 0xe05858, secondary: 0xb84040, name: 'Red' },      // Soft coral red
  2: { primary: 0x5888e0, secondary: 0x4070b8, name: 'Blue' },     // Soft sky blue
  3: { primary: 0xd8c050, secondary: 0xb0a040, name: 'Yellow' },   // Soft gold yellow
  4: { primary: 0x58c058, secondary: 0x40a040, name: 'Green' },    // Soft grass green
  5: { primary: 0xa068d0, secondary: 0x8050b0, name: 'Purple' },   // Soft lavender purple
  6: { primary: 0xd88050, secondary: 0xb06840, name: 'Orange' },   // Soft peach orange
};

export const MAX_PLAYERS = 6;
