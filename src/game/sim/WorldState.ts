import type { Entity, EntityId, EntityType, PlayerId, WeaponConfig, Projectile, ProjectileType } from './types';
import { getWeaponConfig } from './weapons';
import { getUnitDefinition } from './unitDefinitions';
import { MAX_TOTAL_UNITS, DEFAULT_TURRET_TURN_ACCEL, DEFAULT_TURRET_DRAG, RANGE_MULTIPLIERS } from '../../config';

// Seeded random number generator for determinism
export class SeededRNG {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  // Simple mulberry32 PRNG
  next(): number {
    let t = (this.seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Random in range [min, max)
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  // Get current seed for state saving
  getSeed(): number {
    return this.seed;
  }

  // Set seed for state restoration
  setSeed(seed: number): void {
    this.seed = seed;
  }
}

// World state holds all entities and game state
export class WorldState {
  private entities: Map<EntityId, Entity> = new Map();
  private nextEntityId: EntityId = 1;
  private tick: number = 0;
  public rng: SeededRNG;

  // Current player being controlled
  public activePlayerId: PlayerId = 1;

  // Number of players in the game (for unit cap calculation)
  public playerCount: number = 2;

  // Map dimensions
  public readonly mapWidth: number;
  public readonly mapHeight: number;

  // Runtime thrust multiplier (set by GameServer based on game/demo mode)
  public thrustMultiplier: number = 8.0;

  // === CACHED ENTITY ARRAYS (PERFORMANCE CRITICAL) ===
  // These caches avoid creating new arrays on every getUnits()/getBuildings()/getProjectiles() call
  // Invalidated when entities are added/removed
  private cachedUnits: Entity[] = [];
  private cachedBuildings: Entity[] = [];
  private cachedProjectiles: Entity[] = [];
  private cachedAllEntities: Entity[] = [];
  private cachesDirty: boolean = true;

  constructor(seed: number = 12345, mapWidth: number = 2000, mapHeight: number = 2000) {
    this.rng = new SeededRNG(seed);
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
  }

  // Rebuild entity caches if dirty (called once per frame typically)
  private rebuildCachesIfNeeded(): void {
    if (!this.cachesDirty) return;

    // Clear and rebuild - reuse existing arrays to avoid allocation
    this.cachedUnits.length = 0;
    this.cachedBuildings.length = 0;
    this.cachedProjectiles.length = 0;
    this.cachedAllEntities.length = 0;

    for (const entity of this.entities.values()) {
      this.cachedAllEntities.push(entity);
      switch (entity.type) {
        case 'unit':
          this.cachedUnits.push(entity);
          break;
        case 'building':
          this.cachedBuildings.push(entity);
          break;
        case 'projectile':
          this.cachedProjectiles.push(entity);
          break;
      }
    }

    this.cachesDirty = false;
  }

  // Get unit cap per player (total units / number of players)
  getUnitCapPerPlayer(): number {
    return Math.floor(MAX_TOTAL_UNITS / this.playerCount);
  }

  // Check if player can build more units
  canPlayerBuildUnit(playerId: PlayerId): boolean {
    const currentUnitCount = this.getUnitsByPlayer(playerId).length;
    return currentUnitCount < this.getUnitCapPerPlayer();
  }

  // Get remaining unit capacity for a player
  getRemainingUnitCapacity(playerId: PlayerId): number {
    const currentUnitCount = this.getUnitsByPlayer(playerId).length;
    return Math.max(0, this.getUnitCapPerPlayer() - currentUnitCount);
  }

  // Generate next deterministic entity ID
  generateEntityId(): EntityId {
    return this.nextEntityId++;
  }

  // Get current tick
  getTick(): number {
    return this.tick;
  }

  // Increment tick
  incrementTick(): void {
    this.tick++;
  }

  // Add entity to world
  addEntity(entity: Entity): void {
    this.entities.set(entity.id, entity);
    this.cachesDirty = true; // Invalidate caches
  }

  // Remove entity from world
  removeEntity(id: EntityId): void {
    this.entities.delete(id);
    this.cachesDirty = true; // Invalidate caches
  }

  // Get entity by ID
  getEntity(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  // Get all entities (cached - DO NOT MODIFY returned array)
  getAllEntities(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cachedAllEntities;
  }

  // Get entities by type (uses cache for common types)
  getEntitiesByType(type: EntityType): Entity[] {
    switch (type) {
      case 'unit':
        return this.getUnits();
      case 'building':
        return this.getBuildings();
      case 'projectile':
        return this.getProjectiles();
      default:
        return this.getAllEntities().filter((e) => e.type === type);
    }
  }

  // Get all units (cached - DO NOT MODIFY returned array)
  getUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cachedUnits;
  }

  // Get all buildings (cached - DO NOT MODIFY returned array)
  getBuildings(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cachedBuildings;
  }

  // Get all projectiles (cached - DO NOT MODIFY returned array)
  getProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cachedProjectiles;
  }

  // Get units by player
  getUnitsByPlayer(playerId: PlayerId): Entity[] {
    return this.getUnits().filter((e) => e.ownership?.playerId === playerId);
  }

  // Get enemy units (not owned by specified player)
  getEnemyUnits(playerId: PlayerId): Entity[] {
    return this.getUnits().filter((e) => e.ownership?.playerId !== playerId);
  }

  // Get all enemy entities (units and buildings)
  getEnemyEntities(playerId: PlayerId): Entity[] {
    return this.getAllEntities().filter(
      (e) => e.ownership?.playerId !== undefined &&
             e.ownership.playerId !== playerId &&
             (e.type === 'unit' || e.type === 'building')
    );
  }

  // Get commander for a player
  getCommander(playerId: PlayerId): Entity | undefined {
    return this.getUnits().find(
      (e) => e.ownership?.playerId === playerId && e.commander !== undefined
    );
  }

  // Get buildings by player
  getBuildingsByPlayer(playerId: PlayerId): Entity[] {
    return this.getBuildings().filter((e) => e.ownership?.playerId === playerId);
  }

  // Get factories by player
  getFactoriesByPlayer(playerId: PlayerId): Entity[] {
    return this.getBuildings().filter(
      (e) => e.ownership?.playerId === playerId && e.factory !== undefined
    );
  }

  // Check if a player's commander is alive
  isCommanderAlive(playerId: PlayerId): boolean {
    const commander = this.getCommander(playerId);
    return commander !== undefined && (commander.unit?.hp ?? 0) > 0;
  }

  // Get selected entities for active player
  getSelectedEntities(): Entity[] {
    return this.getAllEntities().filter(
      (e) => e.selectable?.selected && e.ownership?.playerId === this.activePlayerId
    );
  }

  // Get selected units for active player
  getSelectedUnits(): Entity[] {
    return this.getUnits().filter(
      (e) => e.selectable?.selected && e.ownership?.playerId === this.activePlayerId
    );
  }

  // Get selected factories for active player
  getSelectedFactories(): Entity[] {
    return this.getBuildings().filter(
      (e) => e.selectable?.selected && e.factory !== undefined && e.ownership?.playerId === this.activePlayerId
    );
  }

  // Entity count
  getEntityCount(): number {
    return this.entities.size;
  }

  // Clear all selections (only for active player's units)
  clearSelection(): void {
    for (const entity of this.entities.values()) {
      if (entity.selectable && entity.ownership?.playerId === this.activePlayerId) {
        entity.selectable.selected = false;
      }
    }
  }

  // Select entities by IDs (only if owned by active player)
  selectEntities(ids: EntityId[]): void {
    for (const id of ids) {
      const entity = this.entities.get(id);
      if (entity?.selectable && entity.ownership?.playerId === this.activePlayerId) {
        entity.selectable.selected = true;
      }
    }
  }

  // Switch active player
  setActivePlayer(playerId: PlayerId): void {
    // Clear current selections when switching
    this.clearSelection();
    this.activePlayerId = playerId;
  }

  // Create a base unit entity without weapons (weapons set separately)
  // Use this when you need to set up custom weapons arrays
  createUnitBase(
    x: number,
    y: number,
    playerId: PlayerId,
    unitType: string,
    collisionRadius: number = 15,
    moveSpeed: number = 100,
    mass: number = 25,
    hp: number = 100
  ): Entity {
    const id = this.generateEntityId();

    const entity: Entity = {
      id,
      type: 'unit',
      transform: { x, y, rotation: 0 },
      selectable: { selected: false },
      ownership: { playerId },
      unit: {
        unitType,
        moveSpeed,
        collisionRadius,
        mass,
        hp,
        maxHp: hp,
        actions: [],
        patrolStartIndex: null,
      },
      weapons: [], // Weapons set by caller
    };
    return entity;
  }

  // Create a unit entity with a single weapon using unit type
  // Unit type determines the weapon type via unit definitions
  // Weapons operate independently - unit has no control over them
  createUnit(
    x: number,
    y: number,
    playerId: PlayerId,
    unitType: string = 'jackal',
    collisionRadius: number = 15,
    moveSpeed: number = 100,
    mass: number = 25,
    turretTurnAccel?: number,   // Turret acceleration (rad/sec²) - uses weapon config or default
    turretDrag?: number,        // Turret drag (0-1) - uses weapon config or default
  ): Entity {
    // Look up unit definition to get weapon type
    const unitDef = getUnitDefinition(unitType);
    const weaponType = unitDef?.weaponType ?? 'gatling';
    const weaponConfig = getWeaponConfig(weaponType);

    // Range constraint: seeRange > fireRange > releaseRange > lockRange > fightstopRange
    const fireRange = weaponConfig.range;
    const seeRange = fireRange * RANGE_MULTIPLIERS.see;
    const releaseRange = fireRange * RANGE_MULTIPLIERS.release;
    const lockRange = fireRange * RANGE_MULTIPLIERS.lock;
    const fightstopRange = fireRange * RANGE_MULTIPLIERS.fightstop;

    // Turret physics - use provided values, weapon config, or global defaults
    const accel = turretTurnAccel ?? weaponConfig.turretTurnAccel ?? DEFAULT_TURRET_TURN_ACCEL;
    const drag = turretDrag ?? weaponConfig.turretDrag ?? DEFAULT_TURRET_DRAG;

    const entity = this.createUnitBase(x, y, playerId, unitType, collisionRadius, moveSpeed, mass, 100);

    // Set up single weapon
    entity.weapons = [{
      config: weaponConfig,
      currentCooldown: 0,
      targetEntityId: null,
      seeRange,
      fireRange,
      releaseRange,
      lockRange,
      fightstopRange,
      isLocked: false,
      turretRotation: 0,
      turretAngularVelocity: 0,
      turretTurnAccel: accel,
      turretDrag: drag,
      offsetX: 0,
      offsetY: 0,
      isFiring: false,
      inFightstopRange: false,
    }];

    return entity;
  }

  // Create a commander unit
  // All range properties are derived from weapon config using multipliers
  // Turret rotation uses acceleration-based physics
  createCommander(
    x: number,
    y: number,
    playerId: PlayerId,
    config: {
      hp: number;
      collisionRadius: number;
      moveSpeed: number;
      mass: number;
      buildRate: number;
      buildRange: number;
      weaponId: string;
      dgunCost: number;
      turretTurnAccel?: number;
      turretDrag?: number;
    }
  ): Entity {
    const id = this.generateEntityId();
    const weaponConfig = getWeaponConfig(config.weaponId);

    // Range constraint: seeRange > fireRange > releaseRange > lockRange > fightstopRange
    const fireRange = weaponConfig.range;
    const seeRange = fireRange * RANGE_MULTIPLIERS.see;
    const releaseRange = fireRange * RANGE_MULTIPLIERS.release;
    const lockRange = fireRange * RANGE_MULTIPLIERS.lock;
    const fightstopRange = fireRange * RANGE_MULTIPLIERS.fightstop;

    // Turret physics - use provided values, weapon config, or global defaults
    const turretTurnAccel = config.turretTurnAccel ?? weaponConfig.turretTurnAccel ?? DEFAULT_TURRET_TURN_ACCEL;
    const turretDrag = config.turretDrag ?? weaponConfig.turretDrag ?? DEFAULT_TURRET_DRAG;

    const entity: Entity = {
      id,
      type: 'unit',
      transform: { x, y, rotation: 0 },
      selectable: { selected: false },
      ownership: { playerId },
      unit: {
        unitType: 'commander',
        moveSpeed: config.moveSpeed,
        collisionRadius: config.collisionRadius,
        mass: config.mass,
        hp: config.hp,
        maxHp: config.hp,
        actions: [],
        patrolStartIndex: null,
      },
      // Single weapon in array
      // Weapons operate independently - unit has no control over them
      weapons: [{
        config: weaponConfig,
        currentCooldown: 0,
        targetEntityId: null,
        seeRange,
        fireRange,
        releaseRange,
        lockRange,
        fightstopRange,
        isLocked: false,
        turretRotation: 0,               // Weapon's independent turret rotation
        turretAngularVelocity: 0,        // Current angular velocity (rad/sec)
        turretTurnAccel,                 // Turret acceleration (rad/sec²)
        turretDrag,                      // Turret drag coefficient
        offsetX: 0,
        offsetY: 0,
        isFiring: false,                 // Weapon reports firing state to unit
        inFightstopRange: false,         // Weapon reports fightstop state to unit
      }],
      builder: {
        buildRate: config.buildRate,
        buildRange: config.buildRange,
        currentBuildTarget: null,
      },
      commander: {
        isDGunActive: false,
        dgunEnergyCost: config.dgunCost,
      },
    };

    return entity;
  }

  // Create a D-gun projectile
  createDGunProjectile(
    x: number,
    y: number,
    velocityX: number,
    velocityY: number,
    ownerId: PlayerId,
    sourceEntityId: EntityId,
    config: WeaponConfig
  ): Entity {
    const entity = this.createProjectile(x, y, velocityX, velocityY, ownerId, sourceEntityId, config, 'traveling');

    // Mark as D-gun projectile
    entity.dgunProjectile = { isDGun: true };

    // D-gun hits everything (infinite hits)
    if (entity.projectile) {
      entity.projectile.maxHits = Infinity;
    }

    return entity;
  }

  // Create a building entity
  createBuilding(x: number, y: number, width: number, height: number, playerId?: PlayerId): Entity {
    const id = this.generateEntityId();
    const entity: Entity = {
      id,
      type: 'building',
      transform: { x, y, rotation: 0 },
      building: {
        width,
        height,
        hp: 500,
        maxHp: 500,
      },
      selectable: { selected: false },
    };

    if (playerId !== undefined) {
      entity.ownership = { playerId };
    }

    return entity;
  }

  // Create a projectile entity
  createProjectile(
    x: number,
    y: number,
    velocityX: number,
    velocityY: number,
    ownerId: PlayerId,
    sourceEntityId: EntityId,
    config: WeaponConfig,
    projectileType: ProjectileType = 'traveling'
  ): Entity {
    const id = this.generateEntityId();

    // Calculate rotation from velocity
    const rotation = Math.atan2(velocityY, velocityX);

    // Determine max lifespan
    let maxLifespan = config.projectileLifespan ?? 2000;
    if (projectileType === 'beam') {
      maxLifespan = config.beamDuration ?? 150;
    } else if (projectileType === 'instant') {
      maxLifespan = 16; // One frame essentially
    }

    // Determine max hits (piercing or single hit)
    const maxHits = config.piercing ? Infinity : 1;

    const projectile: Projectile = {
      ownerId,
      sourceEntityId,
      config,
      projectileType,
      velocityX,
      velocityY,
      timeAlive: 0,
      maxLifespan,
      hitEntities: new Set(),
      maxHits,
    };

    const entity: Entity = {
      id,
      type: 'projectile',
      transform: { x, y, rotation },
      ownership: { playerId: ownerId },
      projectile,
    };

    return entity;
  }

  // Create a beam projectile (special case)
  createBeam(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    ownerId: PlayerId,
    sourceEntityId: EntityId,
    config: WeaponConfig
  ): Entity {
    const entity = this.createProjectile(startX, startY, 0, 0, ownerId, sourceEntityId, config, 'beam');

    if (entity.projectile) {
      entity.projectile.startX = startX;
      entity.projectile.startY = startY;
      entity.projectile.endX = endX;
      entity.projectile.endY = endY;
    }

    return entity;
  }
}
