// ── Two-state hysteresis range system ──
// Each weapon has two states: tracking (turret aimed) and engaged (actively firing).
// Each state uses hysteresis: acquire at a tighter range, release at a wider range.
// This prevents state flickering when targets hover near boundaries.

/** A single hysteresis pair: acquire (inner) < release (outer) */
export interface HysteresisRange {
  acquire: number;
  release: number;
}

/** Nullable hysteresis pair for per-weapon overrides (null = use global default) */
export interface HysteresisRangeOverride {
  acquire: number | null;
  release: number | null;
}

/** Computed absolute ranges for both weapon states (in world units) */
export interface TurretRanges {
  tracking: HysteresisRange;  // outer awareness boundary (turret pre-aims)
  engage: HysteresisRange;    // firing boundary (weapon fires)
}

/** Range multipliers relative to weapon's base range */
export type TurretRangeMultipliers = TurretRanges;

/** Per-weapon range overrides (null = fall back to global default) */
export interface TurretRangeOverrides {
  tracking: HysteresisRangeOverride;
  engage: HysteresisRangeOverride;
}

// Entity ID type for deterministic identification
export type EntityId = number;

// Player ID type
export type PlayerId = number;

// Transform component - position and rotation in world space
export interface Transform {
  x: number;
  y: number;
  rotation: number;
  // Cached cos/sin of rotation — updated once per tick by Simulation.updateRotationCache()
  rotCos?: number;
  rotSin?: number;
}

// Body component - reference to physics body
export interface Body {
  physicsBody: import('../server/PhysicsEngine').PhysicsBody;
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
// Note: Vision/tracking range and fire range are per-weapon properties in UnitWeapon
// Note: Turret rotation is per-weapon - units have no control over weapons
export interface Unit {
  unitType: string;         // Unit type identifier (jackal, lynx, daddy, etc.)
  moveSpeed: number;
  drawScale: number;        // Visual radius for rendering and click detection
  physicsRadius: number;    // Hitbox radius for physics collisions and damage
  mass: number;             // Physics mass for force-based movement
  hp: number;
  maxHp: number;
  // Unified action queue - units process these in order
  actions: UnitAction[];
  // Index for patrol looping (points to first patrol action when looping)
  patrolStartIndex: number | null;
  // Movement velocity (for rendering movement direction)
  velocityX?: number;
  velocityY?: number;
}

// Building component - static structures
export interface Building {
  width: number;
  height: number;
  hp: number;
  maxHp: number;
}

// Force field zone configuration (push or pull)
export interface ForceFieldZoneConfig {
  innerRange: number;     // Inner edge radius (px)
  outerRange: number;     // Outer edge radius (px)
  color: number;          // Zone color (hex)
  alpha: number;          // Slice fill opacity
  particleAlpha: number;  // Particle dash peak opacity
  power: number | null;   // Force strength (push outward / pull inward); null = visual only, skip sim
  damage: number;         // Damage per second in this zone
}

// Weapon configuration - flexible system for any weapon type
export interface WeaponConfig {
  id: string;                    // Unique identifier (e.g., 'lightTurret', 'beamTurret', 'cannonTurret')
  projectileType?: string;       // Projectile stat key (e.g., 'lightShot', 'beamShot')
  turretShape?: import('../../config').TurretConfig; // Turret visual config (barrel type, dimensions, spin)
  range: number;                 // Attack range
  cooldown: number;              // Time between attacks (ms)

  // Structured collision and explosion data (from ShotBlueprint)
  collision?: {
    radius: number;              // Collision hitbox radius
    damage: number;              // Direct hit / collision zone damage
  };
  explosion?: {
    primary: { radius: number; damage: number; force: number; };
    secondary: { radius: number; damage: number; force: number; };
  };

  // Projectile properties (optional based on weapon type)
  projectileSpeed?: number;      // Speed of projectile (undefined = hitscan)
  projectileMass?: number;       // Mass of projectile (for momentum-based recoil/knockback)
  projectileLifespan?: number;   // Max time projectile exists (ms)

  // Grouped
  beam?: {
    duration?: number;           // How long beam persists (ms)
    width?: number;              // Visual width of beam line
  };
  spread?: {
    pelletCount?: number;        // Number of projectiles per shot
    angle?: number;              // Angle of spread (radians)
  };
  burst?: {
    count?: number;              // Shots per burst
    delay?: number;              // Time between burst shots (ms)
  };
  forceField?: {
    angle?: number;              // Constant angle of the force field (radians)
    transitionTime?: number;     // Time (ms) to transition between idle and attack range
    push?: ForceFieldZoneConfig | null; // Push zone config (null = no push zone)
    pull?: ForceFieldZoneConfig | null; // Pull zone config (null = no pull zone)
  };

  // AoE/splash properties
  splashOnExpiry?: boolean;        // If true, splash damage applies when projectile lifespan expires (not just on direct hit)

  // Visual properties
  color?: number;                // Projectile/beam color
  trailLength?: number;          // Visual trail length

  // Turret rotation (acceleration-based physics)
  turretTurnAccel?: number;      // Turret acceleration toward target (radians/sec²)
  turretDrag?: number;           // Turret drag coefficient (0-1, per frame)

  // Piercing properties
  piercing?: boolean;            // Can pierce through multiple targets

  // Homing properties
  homingTurnRate?: number;       // If set, projectiles home toward weapon target at this turn rate (rad/sec)

  // Manual fire properties
  isManualFire?: boolean;        // Weapon only fires on explicit command, skips auto-targeting

  // Per-weapon range multiplier overrides (null → global default fallback)
  rangeMultiplierOverrides?: TurretRangeOverrides;

  // Weapon index (set at fire time for beam tracking)
  weaponIndex?: number;
}

// Unified weapon component - all units use an array of these
// Each weapon is fully self-contained and independent from other weapons
export interface UnitWeapon {
  config: WeaponConfig;
  currentCooldown: number;       // Time until can fire again (ms)
  targetEntityId: EntityId | null; // Current target

  // Per-weapon computed ranges (hysteresis pairs for tracking and engagement)
  ranges: TurretRanges;
  isTracking: boolean;           // Weapon has a target and turret is aimed at it
  isEngaged: boolean;            // Weapon is actively firing at its target

  // Turret rotation for this specific weapon (acceleration-based physics)
  turretRotation: number;           // Current angle (radians)
  turretAngularVelocity: number;    // Current rotational speed (radians/sec)
  turretTurnAccel: number;          // Acceleration toward target (radians/sec²)
  turretDrag: number;               // Drag coefficient (0-1, applied per frame as velocity *= 1-drag)

  // Offset from unit center (for rendering and firing origin)
  // Single-weapon units have offsetX=0, offsetY=0
  offsetX: number;
  offsetY: number;

  // Cached world-space weapon position (computed once per tick in targeting phase)
  worldX?: number;
  worldY?: number;


  // Burst state
  burstShotsRemaining?: number;
  burstCooldown?: number;

  // Force field state
  forceFieldTransitionProgress?: number;  // 0 = inner range, 1 = full range
  currentForceFieldRange?: number;        // Current dynamic outer radius
}

// Note: All weapons use two-state hysteresis targeting (tracking + engaged).
// No per-weapon targeting mode config needed.

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

  // Previous position (for swept collision detection - prevents tunneling)
  prevX?: number;
  prevY?: number;

  // Lifespan
  timeAlive: number;             // How long it's existed (ms)
  maxLifespan: number;           // When to remove (ms)

  // Beam specific
  startX?: number;               // Beam origin
  startY?: number;
  endX?: number;                 // Beam endpoint
  endY?: number;
  targetEntityId?: EntityId;     // Target for tracking beams (updates every frame)
  obstructionT?: number;         // Cached obstruction t value (0-1, undefined = no obstruction)
  obstructionTick?: number;      // Tick when obstruction was last computed

  // Tracking which entities were hit (for piercing or single-hit)
  hitEntities: Set<EntityId>;
  maxHits: number;               // How many entities it can hit (1 = single, Infinity = pierce all)

  // AoE tracking
  hasExploded?: boolean;

  // Source-entity exit guard (prevents self-damage until projectile clears source hitbox)
  hasLeftSource?: boolean;

  // Homing (heat-seeking) properties
  homingTargetId?: EntityId;    // Entity this projectile tracks (cleared if target dies)
  homingTurnRate?: number;      // Max turn rate in radians/sec
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
  isComplete: boolean;      // Whether construction is finished
  isGhost: boolean;         // Whether this is a placement ghost (not yet started)
}

// Builder component - for units that can construct
export interface Builder {
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
  energyProduction?: number; // For solar panels
}

// Unit build configuration (extends weapon config concept)
// Note: Vision/tracking range is now per-weapon, not per-unit
export interface UnitBuildConfig {
  weaponId: string;
  name: string;
  energyCost: number;
  drawScale: number;        // Visual radius
  physicsRadius: number;    // Physics hitbox radius
  moveSpeed: number;
  mass: number;             // Physics mass for force-based movement
  hp: number;
  // Per-weapon range settings (applied to each weapon created)
  weaponSeeRange?: number;  // Optional tracking range - defaults to weapon config range * 1.5
  weaponFireRange?: number; // Optional fire range - defaults to weapon config range
}

// Factory component - for unit production
export interface Factory {
  buildQueue: string[];     // Queue of weapon IDs to build
  currentBuildProgress: number;  // 0-1 for current unit
  currentBuildCost: number;      // Energy cost of current unit
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
  weapons?: UnitWeapon[];      // Array of weapons - all units use this
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
