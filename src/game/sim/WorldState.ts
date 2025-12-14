import type { Entity, EntityId, EntityType, PlayerId, WeaponConfig, Projectile, ProjectileType } from './types';
import { getWeaponConfig } from './weapons';

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

  // Map dimensions
  public readonly mapWidth: number = 2000;
  public readonly mapHeight: number = 2000;

  constructor(seed: number = 12345) {
    this.rng = new SeededRNG(seed);
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
  }

  // Remove entity from world
  removeEntity(id: EntityId): void {
    this.entities.delete(id);
  }

  // Get entity by ID
  getEntity(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  // Get all entities
  getAllEntities(): Entity[] {
    return Array.from(this.entities.values());
  }

  // Get entities by type
  getEntitiesByType(type: EntityType): Entity[] {
    return this.getAllEntities().filter((e) => e.type === type);
  }

  // Get all units
  getUnits(): Entity[] {
    return this.getEntitiesByType('unit');
  }

  // Get all buildings
  getBuildings(): Entity[] {
    return this.getEntitiesByType('building');
  }

  // Get all projectiles
  getProjectiles(): Entity[] {
    return this.getEntitiesByType('projectile');
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

  // Create a unit entity with player ownership and weapon
  createUnit(
    x: number,
    y: number,
    playerId: PlayerId,
    weaponId: string = 'minigun',
    radius: number = 15,
    moveSpeed: number = 100,
    turretTurnRate: number = 3, // radians per second (~172°/sec default)
    visionRange?: number // Optional - defaults to weapon range * 1.5
  ): Entity {
    const id = this.generateEntityId();
    const weaponConfig = getWeaponConfig(weaponId);

    // Default vision range to 1.5x weapon range
    const effectiveVisionRange = visionRange ?? weaponConfig.range * 1.5;

    const entity: Entity = {
      id,
      type: 'unit',
      transform: { x, y, rotation: 0 },
      selectable: { selected: false },
      ownership: { playerId },
      unit: {
        moveSpeed,
        radius,
        hp: 100,
        maxHp: 100,
        waypoints: [],
        patrolLoopIndex: null,
        turretRotation: 0, // Start facing same as body
        turretTurnRate,
        visionRange: effectiveVisionRange,
      },
      weapon: {
        config: weaponConfig,
        currentCooldown: 0,
        targetEntityId: null,
      },
    };
    return entity;
  }

  // Create a commander unit
  createCommander(
    x: number,
    y: number,
    playerId: PlayerId,
    config: {
      hp: number;
      radius: number;
      moveSpeed: number;
      buildRate: number;
      buildRange: number;
      weaponId: string;
      dgunCost: number;
      turretTurnRate?: number;
      visionRange?: number;
    }
  ): Entity {
    const id = this.generateEntityId();
    const weaponConfig = getWeaponConfig(config.weaponId);

    // Default vision range to 1.5x weapon range
    const effectiveVisionRange = config.visionRange ?? weaponConfig.range * 1.5;

    const entity: Entity = {
      id,
      type: 'unit',
      transform: { x, y, rotation: 0 },
      selectable: { selected: false },
      ownership: { playerId },
      unit: {
        moveSpeed: config.moveSpeed,
        radius: config.radius,
        hp: config.hp,
        maxHp: config.hp,
        waypoints: [],
        patrolLoopIndex: null,
        turretRotation: 0, // Start facing same as body
        turretTurnRate: config.turretTurnRate ?? 3, // Default ~172°/sec
        visionRange: effectiveVisionRange,
      },
      weapon: {
        config: weaponConfig,
        currentCooldown: 0,
        targetEntityId: null,
      },
      builder: {
        buildRate: config.buildRate,
        buildRange: config.buildRange,
        currentBuildTarget: null,
      },
      commander: {
        isDGunActive: false,
        dgunEnergyCost: config.dgunCost,
        buildQueue: [],
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
