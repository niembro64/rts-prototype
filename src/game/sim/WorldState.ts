import type { Entity, EntityId, EntityType, PlayerId, TurretConfig, Projectile, ProjectileType } from './types';
import { EntityCacheManager } from './EntityCacheManager';
import { getTurretConfig, computeTurretRanges } from './turretConfigs';
import { getUnitBlueprint } from './blueprints';
import { createTurretsFromDefinition } from './unitDefinitions';
import { MAX_TOTAL_UNITS, DEFAULT_PROJ_VEL_INHERIT, DEFAULT_FIRING_FORCE, DEFAULT_HIT_FORCE, DEFAULT_FF_ACCEL_UNITS, DEFAULT_FF_ACCEL_SHOTS, UNIT_HP_MULTIPLIER, SPATIAL_GRID_CELL_SIZE } from '../../config';
import { getSurfaceHeight } from './Terrain';
import { buildMirrorPanelCache } from './mirrorPanelCache';
import { dropWeaponsForUnit } from './combat/targetIndex';

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
  private buildingVersion: number = 0;
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

  // Configurable unit cap (can be changed at runtime via command)
  public maxTotalUnits: number = MAX_TOTAL_UNITS;

  // Whether projectiles inherit their firing unit's velocity
  public projVelInherit: boolean = DEFAULT_PROJ_VEL_INHERIT;

  // Whether firing a weapon applies recoil to the firing unit
  public firingForce: boolean = DEFAULT_FIRING_FORCE;
  // Whether shots apply knockback to units they hit
  public hitForce: boolean = DEFAULT_HIT_FORCE;

  // Whether force fields accelerate enemy units
  public ffAccelUnits: boolean = DEFAULT_FF_ACCEL_UNITS;
  // Whether force fields accelerate enemy projectiles
  public ffAccelShots: boolean = DEFAULT_FF_ACCEL_SHOTS;

  // === CACHED ENTITY ARRAYS (PERFORMANCE CRITICAL) ===
  // Shared cache manager avoids creating new arrays on every getUnits()/getBuildings()/getProjectiles() call
  private cache = new EntityCacheManager();

  // Reusable query result arrays for filtered queries (DO NOT STORE references to these)
  private _queryBuf: Entity[] = [];

  constructor(seed: number = 12345, mapWidth: number = 2000, mapHeight: number = 2000) {
    this.rng = new SeededRNG(seed);
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
  }

  /** Canonical ground-surface elevation at world point (x, y). One
   *  source of truth for "what is the ground here?" — sim, physics,
   *  client dead-reckoning, and the tile renderer all read this
   *  bilinear interpolation of the 4 corner heights of the tile
   *  that contains (x, y). The surface returned matches what the
   *  player sees with no tile-center stepping. */
  getGroundZ(x: number, y: number): number {
    return getSurfaceHeight(x, y, this.mapWidth, this.mapHeight, SPATIAL_GRID_CELL_SIZE);
  }

  private rebuildCachesIfNeeded(): void {
    this.cache.rebuildIfNeeded(this.entities);
  }

  // Get unit cap per player (total units / number of players)
  getUnitCapPerPlayer(): number {
    return Math.floor(this.maxTotalUnits / this.playerCount);
  }

  // Check if player can build more units (existing units only, no queue accounting)
  canPlayerBuildUnit(playerId: PlayerId): boolean {
    const currentUnitCount = this.getUnitsByPlayer(playerId).length;
    return currentUnitCount < this.getUnitCapPerPlayer();
  }

  // Check if player can queue another unit (accounts for existing units + all queued units)
  canPlayerQueueUnit(playerId: PlayerId): boolean {
    const currentUnits = this.getUnitsByPlayer(playerId).length;
    const queuedUnits = this.getQueuedUnitCount(playerId);
    return (currentUnits + queuedUnits) < this.getUnitCapPerPlayer();
  }

  // Count units in factory build queues for a player
  getQueuedUnitCount(playerId: PlayerId): number {
    this.rebuildCachesIfNeeded();
    let count = 0;
    for (const entity of this.cache.getBuildings()) {
      if (!entity.factory || !entity.ownership) continue;
      if (entity.ownership.playerId !== playerId) continue;
      count += entity.factory.buildQueue.length;
    }
    return count;
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
    if (entity.type === 'building') this.buildingVersion++;
    this.cache.invalidate();
  }

  // Remove entity from world
  removeEntity(id: EntityId): void {
    const entity = this.entities.get(id);
    if (entity?.unit) {
      // Drop any inverse-target index entries that referred to this
      // unit's beam weapons before its bookkeeping is gone.
      dropWeaponsForUnit(entity);
    }
    if (entity?.type === 'building') this.buildingVersion++;
    this.entities.delete(id);
    this.cache.invalidate();
  }

  getBuildingVersion(): number {
    return this.buildingVersion;
  }

  // Get entity by ID
  getEntity(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  // Get all entities (cached - DO NOT MODIFY returned array)
  getAllEntities(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getAll();
  }

  // Get entities by type (uses cache for common types)
  getEntitiesByType(type: EntityType): Entity[] {
    switch (type) {
      case 'unit':
        return this.getUnits();
      case 'building':
        return this.getBuildings();
      case 'shot':
        return this.getProjectiles();
      default:
        return this.getAllEntities().filter((e) => e.type === type);
    }
  }

  // Get all units (cached - DO NOT MODIFY returned array)
  getUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getUnits();
  }

  // Get all buildings (cached - DO NOT MODIFY returned array)
  getBuildings(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getBuildings();
  }

  // Get all projectiles (cached - DO NOT MODIFY returned array)
  getProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getProjectiles();
  }

  // Get units with force field weapons (cached - DO NOT MODIFY returned array)
  getForceFieldUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getForceFieldUnits();
  }

  // Get units with beam weapons (cached - DO NOT MODIFY returned array)
  getBeamUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getBeamUnits();
  }

  // Get units with mirror panels (cached - DO NOT MODIFY returned array)
  getMirrorUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getMirrorUnits();
  }

  // Get units by player — returns reusable array, DO NOT STORE the reference
  getUnitsByPlayer(playerId: PlayerId): Entity[] {
    const buf = this._queryBuf;
    buf.length = 0;
    for (const e of this.getUnits()) {
      if (e.ownership?.playerId === playerId) buf.push(e);
    }
    return buf;
  }

  // Get enemy units (not owned by specified player) — returns reusable array
  getEnemyUnits(playerId: PlayerId): Entity[] {
    const buf = this._queryBuf;
    buf.length = 0;
    for (const e of this.getUnits()) {
      if (e.ownership?.playerId !== playerId) buf.push(e);
    }
    return buf;
  }

  // Get all enemy entities (units and buildings) — returns reusable array
  getEnemyEntities(playerId: PlayerId): Entity[] {
    const buf = this._queryBuf;
    buf.length = 0;
    for (const e of this.getAllEntities()) {
      if (e.ownership?.playerId !== undefined &&
          e.ownership.playerId !== playerId &&
          (e.type === 'unit' || e.type === 'building')) {
        buf.push(e);
      }
    }
    return buf;
  }

  // Get commander for a player
  getCommander(playerId: PlayerId): Entity | undefined {
    return this.getUnits().find(
      (e) => e.ownership?.playerId === playerId && e.commander !== undefined
    );
  }

  // Get buildings by player — returns reusable array, DO NOT STORE the reference
  getBuildingsByPlayer(playerId: PlayerId): Entity[] {
    const buf = this._queryBuf;
    buf.length = 0;
    for (const e of this.getBuildings()) {
      if (e.ownership?.playerId === playerId) buf.push(e);
    }
    return buf;
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

  // Create a base unit entity without turrets (turrets set separately)
  // Use this when you need to set up custom turrets arrays
  createUnitBase(
    x: number,
    y: number,
    playerId: PlayerId,
    unitType: string,
    unitRadiusCollider: { scale: number; shot: number; push: number } = { scale: 15, shot: 15, push: 15 },
    moveSpeed: number = 100,
    mass: number = 25,
    hp: number = 100,
  ): Entity {
    const id = this.generateEntityId();

    // Initial altitude = the local terrain height + the unit's sphere
    // radius (its sphere rests on the top face of the cube tile under
    // it). The physics engine clamps to the same terrain height on
    // its first step anyway, but seeding it avoids a visible snap for
    // any client that renders the entity before the first sim tick.
    // Units spawned in the central ripple disc come in already on top
    // of the elevated cubes; corner spawns sit at z = push as before.
    const groundZ = this.getGroundZ(x, y);
    const entity: Entity = {
      id,
      type: 'unit',
      transform: { x, y, z: groundZ + unitRadiusCollider.push, rotation: 0 },
      selectable: { selected: false },
      ownership: { playerId },
      unit: {
        unitType,
        moveSpeed,
        unitRadiusCollider: { ...unitRadiusCollider },
        mass,
        hp,
        maxHp: hp,
        actions: [],
        patrolStartIndex: null,
        mirrorPanels: [],
        mirrorBoundRadius: 0,
      },
      turrets: [], // Turrets set by caller
    };
    return entity;
  }

  // Create a unit from blueprint — unified factory for ALL unit types including commander
  createUnitFromBlueprint(
    x: number,
    y: number,
    playerId: PlayerId,
    unitId: string
  ): Entity {
    const bp = getUnitBlueprint(unitId);

    const entity = this.createUnitBase(
      x, y, playerId, unitId,
      bp.unitRadiusCollider,
      bp.moveSpeed,
      bp.mass,
      bp.hp * UNIT_HP_MULTIPLIER,
    );

    // Create turrets from blueprint definition
    entity.turrets = createTurretsFromDefinition(unitId, bp.unitRadiusCollider.scale);

    // Cache mirror panels for fast beam collision checks. Same helper
    // runs on the client (NetworkEntityFactory) so authoritative and
    // hydrated entities share one canonical rectangle.
    entity.unit!.mirrorBoundRadius = buildMirrorPanelCache(
      bp, entity.unit!.mirrorPanels,
    );

    // Attach builder component if blueprint specifies it
    if (bp.builder) {
      entity.builder = {
        buildRange: bp.builder.buildRange,
        maxEnergyUseRate: bp.builder.maxEnergyUseRate,
        currentBuildTarget: null,
      };
    }

    // Attach commander component if blueprint specifies dgun capability
    if (bp.dgun) {
      entity.commander = {
        isDGunActive: false,
        dgunEnergyCost: bp.dgun.energyCost,
      };
    }

    return entity;
  }

  // Legacy: Create a unit entity with a single weapon using unit type
  // @deprecated Use createUnitFromBlueprint instead
  createUnit(
    x: number,
    y: number,
    playerId: PlayerId,
    unitType: string = 'jackal',
    radiusColliderUnitShot: number = 15,
    moveSpeed: number = 100,
    mass: number = 25,
    turretTurnAccel?: number,
    turretDrag?: number,
  ): Entity {
    const bp = getUnitBlueprint(unitType);
    const turretType = bp?.turrets[0]?.turretId ?? 'lightTurret';
    const turretConfig = getTurretConfig(turretType);

    const ranges = computeTurretRanges(turretConfig);

    const accel = turretTurnAccel ?? turretConfig.angular.turnAccel;
    const drag = turretDrag ?? turretConfig.angular.drag;

    const entity = this.createUnitBase(x, y, playerId, unitType, { scale: radiusColliderUnitShot, shot: radiusColliderUnitShot, push: radiusColliderUnitShot }, moveSpeed, mass, 100);

    entity.turrets = [{
      config: turretConfig,
      cooldown: 0,
      target: null,
      ranges,
      state: 'idle',
      rotation: 0,
      pitch: 0,
      angularVelocity: 0,
      pitchVelocity: 0,
      turnAccel: accel,
      drag: drag,
      offset: { x: 0, y: 0 },
    }];

    return entity;
  }

  // Legacy: Create a commander unit
  // @deprecated Use createUnitFromBlueprint('commander') instead
  createCommander(
    x: number,
    y: number,
    playerId: PlayerId,
    _config?: unknown
  ): Entity {
    return this.createUnitFromBlueprint(x, y, playerId, 'commander');
  }

  // Create a D-gun projectile
  createDGunProjectile(
    x: number,
    y: number,
    velocityX: number,
    velocityY: number,
    ownerId: PlayerId,
    sourceEntityId: EntityId,
    config: TurretConfig
  ): Entity {
    const entity = this.createProjectile(x, y, velocityX, velocityY, ownerId, sourceEntityId, config, 'projectile');

    // Mark as D-gun projectile
    entity.dgunProjectile = { isDGun: true };

    // D-gun hits everything (infinite hits)
    if (entity.projectile) {
      entity.projectile.maxHits = Infinity;
    }

    return entity;
  }

  // Create a building entity
  createBuilding(
    x: number, y: number,
    width: number, height: number, depth: number,
    playerId?: PlayerId,
  ): Entity {
    const id = this.generateEntityId();
    // Transform.z is the building's vertical CENTER. Base sits on the
    // local terrain (cube top) under the building's footprint, so
    // center = groundZ + depth/2. The physics cuboid collider is
    // created with the same `baseZ` so the static AABB lines up.
    // Buildings placed in the ripple disc rise with the terrain;
    // anywhere else groundZ is 0 and behavior is unchanged.
    const baseZ = this.getGroundZ(x, y);
    const entity: Entity = {
      id,
      type: 'building',
      transform: { x, y, z: baseZ + depth / 2, rotation: 0 },
      building: {
        width,
        height,
        depth,
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
    config: TurretConfig,
    projectileType: ProjectileType = 'projectile'
  ): Entity {
    const id = this.generateEntityId();

    // Calculate rotation from velocity
    const rotation = Math.atan2(velocityY, velocityX);

    // Determine max lifespan based on shot type
    let maxLifespan: number;
    if (config.shot.type === 'beam') {
      maxLifespan = Infinity;
    } else if (config.shot.type === 'laser') {
      maxLifespan = config.shot.duration;
    } else if (config.shot.type === 'projectile') {
      maxLifespan = config.shot.lifespan ?? 2000;
    } else {
      maxLifespan = 2000;
    }

    // Always single hit (DGun overrides maxHits to Infinity after creation)
    const maxHits = 1;

    // createProjectile's z/vz defaults to "fired horizontally at
    // source turret height" — M6 (projectile ballistics) will override
    // these with per-turret pitch and ballistic solutions. The point
    // of this commit is just that the fields exist and get serialized.
    const projectile: Projectile = {
      ownerId,
      sourceEntityId,
      config,
      projectileType,
      velocityX,
      velocityY,
      velocityZ: 0,
      timeAlive: 0,
      maxLifespan,
      hitEntities: new Set(),
      maxHits,
      hasLeftSource: false,
      lastSentVelX: velocityX,
      lastSentVelY: velocityY,
      lastSentVelZ: 0,
    };

    const entity: Entity = {
      id,
      type: 'shot',
      transform: { x, y, z: 0, rotation },
      ownership: { playerId: ownerId },
      projectile,
    };

    return entity;
  }

  // Create a beam / laser projectile. Beams are instantaneous line
  // weapons — the z coord is the muzzle altitude at the moment of
  // firing (same altitude for start and end; beams don't droop under
  // gravity). Passing z lets the renderer draw the beam at the right
  // height and lets the damage system's line-sphere test find
  // targets at that altitude instead of assuming z=0.
  createBeam(
    startX: number,
    startY: number,
    beamZ: number,
    endX: number,
    endY: number,
    ownerId: PlayerId,
    sourceEntityId: EntityId,
    config: TurretConfig,
    projectileType: 'beam' | 'laser' = 'beam'
  ): Entity {
    const entity = this.createProjectile(startX, startY, 0, 0, ownerId, sourceEntityId, config, projectileType);
    entity.transform.z = beamZ;

    if (entity.projectile) {
      entity.projectile.startX = startX;
      entity.projectile.startY = startY;
      entity.projectile.startZ = beamZ;
      entity.projectile.endX = endX;
      entity.projectile.endY = endY;
      entity.projectile.endZ = beamZ;
    }

    return entity;
  }
}
