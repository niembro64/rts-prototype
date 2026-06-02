import type {
  Entity,
  EntityId,
  EntityMeta,
  EntityMetaBlueprintKind,
  EntityMetaKind,
  EntityType,
  PlayerId,
  ShotSource,
  TurretConfig,
  Projectile,
  ProjectileConfig,
  ProjectileType,
  UnitLocomotion,
} from './types';
import {
  createCombatComponent,
  createEmptyEntityComponentSlots,
  createTransform,
  getEmissionBlueprintId,
  isProjectileShot,
  NO_ENTITY_ID,
  PROJECTILE_ABSENCE_SLOTS,
} from './types';
import type { MetalDeposit } from '../../metalDepositConfig';
import type { ResourceMovement } from './resourceMovement';
import { EntityCacheManager } from './EntityCacheManager';
import { getUnitBlueprint, getUnitLocomotion } from './blueprints';
import { cloneUnitLocomotion } from './locomotion';
import { createUnitRuntimeTurrets } from './runtimeTurrets';
import {
  MAX_TOTAL_UNITS,
  DEFAULT_TURRET_SHIELD_PANELS_ENABLED,
  DEFAULT_TURRET_SHIELD_SPHERES_ENABLED,
  DEFAULT_SHIELDS_OBSTRUCT_SIGHT,
  DEFAULT_SHIELD_REFLECTION_MODE,
  UNIT_HP_MULTIPLIER,
  UNIT_INITIAL_SPAWN_HEIGHT_ABOVE_GROUND,
  LAND_CELL_SIZE,
  DGUN_TERRAIN_FOLLOW_HEIGHT,
} from '../../config';
import type { ShieldReflectionMode } from '../../types/shotTypes';
import { getSurfaceHeight, getSurfaceNormal } from './Terrain';
import { buildShieldPanelCache } from './shieldPanelCache';
import { createProjectileConfigFromTurret } from './projectileConfigs';
import { ENTITY_CHANGED_HP } from '../../types/network';
import { isConstructionPieceMaterialized } from './buildableHelpers';

const TERRAIN_NORMAL_CACHE_CELL_SIZE = 25;
const EMPTY_PLAYER_SET: ReadonlySet<PlayerId> = new Set();

/** Temporary vision pulse owned by a single player, contributing a
 *  full-vision source for the ticks between spawn and expiresAtTick.
 *  See WorldState.scanPulses. */
export type ScanPulse = {
  playerId: PlayerId;
  x: number;
  y: number;
  z: number;
  radius: number;
  expiresAtTick: number;
};
type SurfaceNormal = { nx: number; ny: number; nz: number };

export type RemovedSnapshotEntity = {
  id: EntityId;
  playerId: PlayerId | null;
  x: number;
  y: number;
  // 'tower' rides the building ghost path on death — same static
  // last-seen-position semantics under FOW-02b.
  type: 'unit' | 'building' | 'tower';
};

export type CreateProjectileProvenance = {
  /** Runtime emission blueprint for this projectile body. Submunitions use child shot blueprint ids here. */
  shotBlueprintId?: string | null;
  /** Immutable source record. Submunitions pass a copy of their parent's source record. */
  shotSource?: ShotSource | null;
};

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
  private entityMetaById: Map<EntityId, EntityMeta> = new Map();
  private nextEntityId: EntityId = 1;
  private tick: number = 0;
  private buildingVersion: number = 0;
  private unitSetVersion: number = 0;
  private removedSnapshotEntities: RemovedSnapshotEntity[] = [];
  private snapshotDirtyIds = new Set<EntityId>();
  private snapshotDirtyFields = new Map<EntityId, number>();
  private pendingDeathCheckIds = new Set<EntityId>();
  private surfaceNormalCache = new Map<number, SurfaceNormal>();
  // Monotonically-growing upper bound on `getTargetRadius(e)` across all
  // unit/building entities ever added to this world. Used by the
  // targeting broadphase to expand its 2D circle query so large targets
  // whose edge falls within a weapon's range, but whose center sits
  // outside the unit-centered batch radius, still enter the candidate
  // array. Stale-too-large is harmless: per-candidate distance checks
  // still enforce the exact range contract.
  private maxTargetableRadius: number = 0;
  public rng: SeededRNG;

  // Current player being controlled
  public activePlayerId: PlayerId = 1;

  // Number of players in the game (for unit cap calculation)
  public playerCount: number = 2;

  /** Per-player alliance map (FOW-06). The set holds the
   *  OTHER players considered allies — a player is implicitly allied
   *  with themselves and that's never listed here. FFA: every set is
   *  empty (or absent), which is the default for a fresh world. Team
   *  play: pairs / triples / etc. of players list each other. The
   *  visibility filter unions all allied players' vision sources, and
   *  the snapshot serializer treats allied entities as friendly for
   *  private-detail and delta-resolution purposes. Populated at
   *  game start by ServerBootstrap when the lobby has team configuration;
   *  never mutated mid-game (alliances are not currently switchable). */
  public alliesByPlayer: Map<PlayerId, ReadonlySet<PlayerId>> = new Map();

  /** Active temporary vision pulses (FOW-14 — Starcraft
   *  scanner sweep / SupCom recon drone). Each pulse contributes a
   *  full-vision source to its owner's team for the ticks between
   *  spawn and expiresAtTick. Simulation prunes expired entries at
   *  the top of every tick; SnapshotVisibility iterates the live
   *  entries during forRecipient() to merge them with the recipient's
   *  durable vision sources. Pulses are scoped to playerId rather
   *  than an entity so a destroyed scan source doesn't truncate the
   *  reveal mid-sweep. */
  public scanPulses: ScanPulse[] = [];

  // Map dimensions
  public readonly mapWidth: number;
  public readonly mapHeight: number;

  // Metal deposits — fixed map features generated at world init.
  // Same list across all clients (deterministic from map size).
  public metalDeposits: MetalDeposit[] = [];

  // Runtime thrust multiplier (set by GameServer based on game/demo mode)
  public thrustMultiplier: number = 8.0;

  // Configurable unit cap (can be changed at runtime via command)
  public maxTotalUnits: number = MAX_TOTAL_UNITS;

  // Whether turretShieldPanels/panels participate in targeting and reflections
  public turretShieldPanelsEnabled: boolean = DEFAULT_TURRET_SHIELD_PANELS_ENABLED;
  // Whether shield turrets participate in targeting, simulation, and rendering
  public turretShieldSpheresEnabled: boolean = DEFAULT_TURRET_SHIELD_SPHERES_ENABLED;
  // Whether force material between a turret and its target obstructs
  // sight. Symmetric: active shield sphere boundaries and force
  // shield panels apply to every turret in either direction, regardless
  // of team.
  public shieldsObstructSight: boolean = DEFAULT_SHIELDS_OBSTRUCT_SIGHT;
  // Which shield boundary crossings reflect shots/beams.
  public shieldReflectionMode: ShieldReflectionMode = DEFAULT_SHIELD_REFLECTION_MODE;
  // Whether player-specific snapshots and the client fog overlay use vision.
  public fogOfWarEnabled: boolean = true;
  /** Tax (fraction in [0, 1)) applied to a resource converter's per-tick
   *  output. 0 = lossless; 0.5 = lose half of the source resource on
   *  every conversion. Read by economy.update each tick. */
  public converterTax: number = 0;
  /** Per-tick resource movement records. Cleared at the start of each
   *  simulation tick and filled by the resource movement system so
   *  accounting and renderer-facing pylon flow read one channel. */
  public resourceMovements: ResourceMovement[] = [];
  /** Optional server-side lifecycle hook. WorldState owns entity
   *  removal, but host-only systems such as physics own external
   *  resources that must be released before the entity disappears. */
  public onEntityRemoving: ((entity: Entity) => void) | null = null;
  /** Fired when a mobile host's authored body mass changes, so the physics
   *  owner can recompute the body's effective mass. WorldState has no physics
   *  handle, so the recompute is delegated to the host that wires this. */
  public onHostMassChanged: ((host: Entity) => void) | null = null;

  // === CACHED ENTITY ARRAYS (PERFORMANCE CRITICAL) ===
  // Shared cache manager avoids creating new arrays on every getUnits()/getBuildings()/getProjectiles() call
  private cache = new EntityCacheManager();

  // Reusable query result arrays for filtered queries (DO NOT STORE references to these)
  private _queryBuf: Entity[] = [];
  private _typedQueryBuf: Entity[] = [];
  private _selectedEntitiesBuf: Entity[] = [];
  private _selectedUnitsBuf: Entity[] = [];
  private _selectedFactoriesBuf: Entity[] = [];

  constructor(seed: number = 12345, mapWidth: number = 2000, mapHeight: number = 2000) {
    this.rng = new SeededRNG(seed);
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
  }

  /** Canonical ground-surface elevation at world point (x, y). One
   *  source of truth for "what is the ground here?" — sim, physics,
   *  client dead-reckoning, and the tile renderer all read the same
   *  authoritative triangle mesh. The surface returned matches what the
   *  player sees. */
  getGroundZ(x: number, y: number): number {
    return getSurfaceHeight(x, y, this.mapWidth, this.mapHeight, LAND_CELL_SIZE);
  }

  private surfaceNormalCacheKey(x: number, y: number): number {
    const cx = Math.floor(x / TERRAIN_NORMAL_CACHE_CELL_SIZE) + 32768;
    const cy = Math.floor(y / TERRAIN_NORMAL_CACHE_CELL_SIZE) + 32768;
    return cx * 0x10000 + cy;
  }

  getCachedSurfaceNormal(x: number, y: number): SurfaceNormal {
    const key = this.surfaceNormalCacheKey(x, y);
    let normal = this.surfaceNormalCache.get(key);
    if (!normal) {
      normal = getSurfaceNormal(
        x, y,
        this.mapWidth, this.mapHeight,
        LAND_CELL_SIZE,
      );
      this.surfaceNormalCache.set(key, normal);
    }
    return normal;
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
    const units = this.getUnitsByPlayer(playerId);
    return units.length < this.getUnitCapPerPlayer();
  }

  // Check if player can select another repeat-build unit. Repeat-build is
  // not a queue, so only live/shell units count against the cap.
  canPlayerQueueUnit(playerId: PlayerId): boolean {
    return this.canPlayerBuildUnit(playerId);
  }

  // Get remaining unit capacity for a player
  getRemainingUnitCapacity(playerId: PlayerId): number {
    const units = this.getUnitsByPlayer(playerId);
    return Math.max(0, this.getUnitCapPerPlayer() - units.length);
  }

  // Generate next deterministic entity ID
  generateEntityId(): EntityId {
    return this.nextEntityId++;
  }

  getEntityMeta(id: EntityId): EntityMeta | undefined {
    return this.entityMetaById.get(id);
  }

  resolveMountedTurret(id: EntityId): { host: Entity; turret: NonNullable<Entity['combat']>['turrets'][number] } | undefined {
    const meta = this.entityMetaById.get(id);
    if (meta === undefined || !meta.alive || meta.kind !== 'turret' || meta.parentId === null) {
      return undefined;
    }
    const host = this.entities.get(meta.parentId);
    if (host === undefined) return undefined;
    const combat = host.combat;
    if (combat === null) return undefined;
    const turret = combat.turrets[meta.mountIndex ?? -1];
    if (turret === undefined || turret.id !== id || !this.isHostBodyLive(host)) return undefined;
    return { host, turret };
  }

  private upsertEntityMeta(meta: EntityMeta): void {
    const previous = this.entityMetaById.get(meta.id);
    const generation = previous !== undefined && previous.alive
      ? previous.generation
      : (previous?.generation ?? 0) + 1;
    this.entityMetaById.set(meta.id, {
      ...meta,
      generation,
      alive: true,
    });
  }

  resolveEntityMeta(id: EntityId, generation: number): EntityMeta | undefined {
    const meta = this.entityMetaById.get(id);
    if (meta === undefined || !meta.alive || meta.generation !== generation) return undefined;
    return meta;
  }

  private entityBlueprintKind(entity: Entity): EntityMetaBlueprintKind {
    if (entity.type === 'unit') return 'unit';
    if (entity.type === 'tower') return 'tower';
    if (entity.type === 'building') return 'building';
    if (entity.type === 'shot') return 'shot';
    return 'none';
  }

  private entityBlueprintId(entity: Entity): string | null {
    if (entity.unit !== null) return entity.unit.unitBlueprintId;
    if (entity.buildingBlueprintId !== null) return entity.buildingBlueprintId;
    if (entity.projectile !== null) return entity.projectile.shotBlueprintId;
    return null;
  }

  private isHostBodyLive(entity: Entity): boolean {
    if (entity.unit !== null) return entity.unit.hp > 0 && isConstructionPieceMaterialized(entity, 'body');
    if (entity.building !== null) return entity.building.hp > 0 && isConstructionPieceMaterialized(entity, 'body');
    return false;
  }

  private registerEntityMetadata(entity: Entity): void {
    const ownerPlayerId = entity.ownership !== null ? entity.ownership.playerId : null;
    const teamId = ownerPlayerId !== null ? this.getTeamId(ownerPlayerId) : null;
    const entityKind: EntityMetaKind = entity.type;
    const rootHostId = entity.projectile !== null
      ? entity.projectile.shotSource.sourceRootEntityId
      : entity.id;
    const bodyTargetable =
      entity.unit !== null
        ? entity.unit.hp > 0 && isConstructionPieceMaterialized(entity, 'body')
        : (entity.building !== null
          ? entity.building.hp > 0 && isConstructionPieceMaterialized(entity, 'body')
          : (entity.projectile !== null ? entity.projectile.hp > 0 : false));
    this.upsertEntityMeta({
      id: entity.id,
      kind: entityKind,
      blueprintKind: this.entityBlueprintKind(entity),
      blueprintId: this.entityBlueprintId(entity),
      ownerPlayerId,
      teamId,
      parentId: null,
      rootHostId,
      mountIndex: null,
      storagePool: 'entities',
      storageSlot: entity.id,
      generation: 0,
      alive: true,
      targetable: bodyTargetable,
    });

    const combat = entity.combat;
    if (combat !== null) {
      for (let i = 0; i < combat.turrets.length; i++) {
        const turret = combat.turrets[i];
        if (turret.id === NO_ENTITY_ID) continue;
        if (!isConstructionPieceMaterialized(entity, 'body')) {
          this.markMetaDead(turret.id);
          continue;
        }
        if (!bodyTargetable) {
          this.markMetaDead(turret.id);
          continue;
        }
        this.upsertEntityMeta({
          id: turret.id,
          kind: 'turret',
          blueprintKind: 'turret',
          blueprintId: turret.config.turretBlueprintId,
          ownerPlayerId,
          teamId,
          parentId: turret.parentId,
          rootHostId: turret.rootHostId,
          mountIndex: turret.mountIndex,
          storagePool: 'combat.turrets',
          storageSlot: i,
          generation: 0,
          alive: true,
          targetable: !turret.config.visualOnly && bodyTargetable,
        });
      }
    }

  }

  private markMetaDead(id: EntityId): void {
    const previous = this.entityMetaById.get(id);
    if (previous === undefined || !previous.alive) return;
    this.entityMetaById.set(id, {
      ...previous,
      alive: false,
      targetable: false,
    });
  }

  markSubEntityMetadataDead(id: EntityId): void {
    this.markMetaDead(id);
  }

  refreshEntityMetadata(entity: Entity): void {
    this.registerEntityMetadata(entity);
  }

  setSubEntityMetadataTargetable(id: EntityId, targetable: boolean): void {
    const previous = this.entityMetaById.get(id);
    if (previous === undefined || !previous.alive || previous.storagePool === 'entities') return;
    const mountedTurret = previous.kind === 'turret' ? this.resolveMountedTurret(id) : undefined;
    const canEverTarget =
      mountedTurret !== undefined &&
      this.isHostBodyLive(mountedTurret.host) &&
      !mountedTurret.turret.config.visualOnly;
    const nextTargetable = targetable && canEverTarget;
    if (previous.targetable === nextTargetable) return;
    this.entityMetaById.set(id, {
      ...previous,
      targetable: nextTargetable,
    });
  }

  private markEntityMetadataDead(entity: Entity): void {
    this.markMetaDead(entity.id);
    const combat = entity.combat;
    if (combat !== null) {
      for (let i = 0; i < combat.turrets.length; i++) {
        this.markMetaDead(combat.turrets[i].id);
      }
    }
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
    this.registerEntityMetadata(entity);
    if (entity.type === 'unit') this.unitSetVersion++;
    // Towers share the buildingVersion bucket because their structural
    // shape (static, footprint, building component) matches buildings;
    // the entity.type discriminator is what selection/UI code reads.
    if (entity.type === 'building' || entity.type === 'tower') this.buildingVersion++;
    if (entity.type === 'unit' || entity.type === 'building' || entity.type === 'tower') {
      const r = entity.unit
        ? entity.unit.radius.hitbox
        : (entity.building ? entity.building.targetRadius : 0);
      if (r > this.maxTargetableRadius) this.maxTargetableRadius = r;
    }
    this.markSnapshotDirty(entity.id, 0xff);
    this.cache.invalidate();
  }

  /** Upper bound on `getTargetRadius(e)` for any unit/building entity
   *  in the world. Grows monotonically as larger entities spawn; never
   *  shrinks when entities die (stale-too-large just sizes broadphase
   *  queries slightly wider than strictly needed). */
  getMaxTargetableRadius(): number {
    return this.maxTargetableRadius;
  }

  // Remove entity from world
  removeEntity(id: EntityId): void {
    const entity = this.entities.get(id);
    if (entity !== undefined && this.onEntityRemoving !== null) this.onEntityRemoving(entity);
    if (entity !== undefined && entity.type === 'unit') this.unitSetVersion++;
    if (entity !== undefined && (entity.type === 'building' || entity.type === 'tower')) this.buildingVersion++;
    if (entity !== undefined && (entity.type === 'unit' || entity.type === 'building' || entity.type === 'tower')) {
      this.removedSnapshotEntities.push({
        id,
        playerId: entity.ownership !== null ? entity.ownership.playerId : null,
        x: entity.transform.x,
        y: entity.transform.y,
        type: entity.type,
      });
    }
    this.pendingDeathCheckIds.delete(id);
    this.snapshotDirtyIds.delete(id);
    this.snapshotDirtyFields.delete(id);
    if (entity !== undefined) this.markEntityMetadataDead(entity);
    this.entities.delete(id);
    this.cache.invalidate();
  }

  markSnapshotDirty(id: EntityId, fields: number): void {
    if (fields === 0) return;
    const entity = this.entities.get(id);
    if (!entity || (entity.type !== 'unit' && entity.type !== 'building' && entity.type !== 'tower')) return;
    if (fields & ENTITY_CHANGED_HP) this.pendingDeathCheckIds.add(id);
    this.snapshotDirtyIds.add(id);
    this.snapshotDirtyFields.set(id, (this.snapshotDirtyFields.get(id) ?? 0) | fields);
  }

  drainPendingDeathCheckIds(out: EntityId[]): void {
    out.length = 0;
    for (const id of this.pendingDeathCheckIds) out.push(id);
    this.pendingDeathCheckIds.clear();
  }

  clearPendingDeathCheckIds(): void {
    this.pendingDeathCheckIds.clear();
  }

  drainSnapshotDirtyEntities(outIds: EntityId[], outFields: number[]): void {
    outIds.length = 0;
    outFields.length = 0;
    for (const id of this.snapshotDirtyIds) {
      outIds.push(id);
      outFields.push(this.snapshotDirtyFields.get(id) ?? 0);
    }
    this.snapshotDirtyIds.clear();
    this.snapshotDirtyFields.clear();
  }

  drainRemovedSnapshotEntityIds(out: EntityId[]): void {
    for (let i = 0; i < this.removedSnapshotEntities.length; i++) {
      out.push(this.removedSnapshotEntities[i].id);
    }
    this.removedSnapshotEntities.length = 0;
  }

  drainRemovedSnapshotEntities(out: RemovedSnapshotEntity[]): void {
    for (let i = 0; i < this.removedSnapshotEntities.length; i++) {
      out.push(this.removedSnapshotEntities[i]);
    }
    this.removedSnapshotEntities.length = 0;
  }

  getBuildingVersion(): number {
    return this.buildingVersion;
  }

  getUnitSetVersion(): number {
    return this.unitSetVersion;
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
        return this.collectEntitiesByType(type, this._typedQueryBuf);
    }
  }

  private collectEntitiesByType(type: EntityType, out: Entity[]): Entity[] {
    out.length = 0;
    for (const e of this.getAllEntities()) {
      if (e.type === type) out.push(e);
    }
    return out;
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

  getTravelingProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getTravelingProjectiles();
  }

  getLineProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getLineProjectiles();
  }

  // Get units with shield weapons (cached - DO NOT MODIFY returned array)
  getShieldUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getShieldUnits();
  }

  getCommanderUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getCommanderUnits();
  }

  getBuilderUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getBuilderUnits();
  }

  /** Every entity that carries a CombatComponent with at least one
   *  non-visualOnly turret. Includes both armed units and armed
   *  buildings (megaBeam towers etc.) — the combat pipeline iterates
   *  this list and never branches on entity type. */
  getArmedEntities(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getArmedEntities();
  }

  // Get units with beam weapons (cached - DO NOT MODIFY returned array)
  getBeamUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getBeamUnits();
  }

  // Get units with shield panels (cached - DO NOT MODIFY returned array)
  getShieldPanelUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getShieldPanelUnits();
  }

  // Get wind turbine buildings (cached - DO NOT MODIFY returned array)
  getWindBuildings(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getWindBuildings();
  }

  // Get solar collector buildings (cached - DO NOT MODIFY returned array)
  getSolarBuildings(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getSolarBuildings();
  }

  // Get metal extractor buildings (cached - DO NOT MODIFY returned array)
  getExtractorBuildings(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getExtractorBuildings();
  }

  // Get resource converter buildings (cached - DO NOT MODIFY returned array)
  getConverterBuildings(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getConverterBuildings();
  }

  // Get every building that uses the shared BuildingActiveState fortify
  // mechanic — solar + wind + extractor.
  getActiveStateBuildings(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getActiveStateBuildings();
  }

  // Get fabricator/factory buildings (cached - DO NOT MODIFY returned array)
  getFactoryBuildings(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getFactoryBuildings();
  }

  // Get units by player — returns reusable array, DO NOT STORE the reference
  getUnitsByPlayer(playerId: PlayerId): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getUnitsByPlayer(playerId);
  }

  // Get enemy units (not owned by specified player) — returns reusable array
  getEnemyUnits(playerId: PlayerId): Entity[] {
    const buf = this._queryBuf;
    buf.length = 0;
    for (const e of this.getUnits()) {
      const ownership = e.ownership;
      if (ownership === null || ownership.playerId !== playerId) buf.push(e);
    }
    return buf;
  }

  // Get all enemy entities (units, towers, and buildings) — returns reusable array
  getEnemyEntities(playerId: PlayerId): Entity[] {
    const buf = this._queryBuf;
    buf.length = 0;
    for (const e of this.getAllEntities()) {
      if (e.ownership !== null &&
          e.ownership.playerId !== playerId &&
          (e.type === 'unit' || e.type === 'building' || e.type === 'tower')) {
        buf.push(e);
      }
    }
    return buf;
  }

  // Get commander for a player
  getCommander(playerId: PlayerId): Entity | undefined {
    for (const e of this.getCommanderUnits()) {
      if (e.ownership !== null && e.ownership.playerId === playerId) return e;
    }
    return undefined;
  }

  // Get buildings by player — returns reusable array, DO NOT STORE the reference
  getBuildingsByPlayer(playerId: PlayerId): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getBuildingsByPlayer(playerId);
  }

  /** Get the per-player ally set, NOT including the player itself.
   *  An empty set means FFA (no allies). The visibility filter and
   *  snapshot serializer iterate these to union allied vision
   *  sources and treat allied entities as friendly. See FOW-06. */
  getAllies(playerId: PlayerId): ReadonlySet<PlayerId> {
    return this.alliesByPlayer.get(playerId) ?? EMPTY_PLAYER_SET;
  }

  /** True when two players are on the same team (including the
   *  trivial self-allied case). Drives ownership-vs-recipient checks
   *  across the snapshot serializers. See FOW-06. */
  arePlayersAllied(a: PlayerId, b: PlayerId): boolean {
    if (a === b) return true;
    return this.getAllies(a).has(b);
  }

  /** Canonical team id for immutable provenance and entity metadata.
   *  FFA maps each player to their own id; allied players share the
   *  smallest player id in their alliance component. */
  getTeamId(playerId: PlayerId): number {
    let teamId = playerId;
    for (const allyId of this.getAllies(playerId)) {
      if (allyId < teamId) teamId = allyId;
    }
    return teamId;
  }

  /** Push a new scan pulse onto the active list. See FOW-14. */
  addScanPulse(pulse: ScanPulse): void {
    this.scanPulses.push(pulse);
  }

  /** Drop every scan pulse whose expiresAtTick has elapsed. Called by
   *  Simulation at the top of each tick — keeping the prune in one
   *  place means the snapshot serializer always sees a clean live
   *  list, and avoids per-recipient filtering of expired pulses. */
  pruneExpiredScanPulses(currentTick: number): void {
    const pulses = this.scanPulses;
    let writeIndex = 0;
    for (let i = 0; i < pulses.length; i++) {
      if (pulses[i].expiresAtTick > currentTick) {
        if (writeIndex !== i) pulses[writeIndex] = pulses[i];
        writeIndex++;
      }
    }
    pulses.length = writeIndex;
  }

  // Get factories by player
  getFactoriesByPlayer(playerId: PlayerId): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getFactoriesByPlayer(playerId);
  }

  // Check if a player's commander is alive
  isCommanderAlive(playerId: PlayerId): boolean {
    const commander = this.getCommander(playerId);
    return commander !== undefined && commander.unit !== null && commander.unit.hp > 0;
  }

  // Get selected entities for active player
  getSelectedEntities(): Entity[] {
    const out = this._selectedEntitiesBuf;
    out.length = 0;
    const playerId = this.activePlayerId;
    for (const e of this.getAllEntities()) {
      if (
        e.selectable !== null &&
        e.selectable.selected &&
        e.ownership !== null &&
        e.ownership.playerId === playerId
      ) {
        out.push(e);
      }
    }
    return out;
  }

  // Get selected units for active player
  getSelectedUnits(): Entity[] {
    const out = this._selectedUnitsBuf;
    out.length = 0;
    const playerId = this.activePlayerId;
    for (const e of this.getUnits()) {
      if (
        e.selectable !== null &&
        e.selectable.selected &&
        e.ownership !== null &&
        e.ownership.playerId === playerId
      ) {
        out.push(e);
      }
    }
    return out;
  }

  // Get selected factories for active player
  getSelectedFactories(): Entity[] {
    const out = this._selectedFactoriesBuf;
    out.length = 0;
    const playerId = this.activePlayerId;
    this.rebuildCachesIfNeeded();
    for (const e of this.cache.getFactoriesByPlayer(playerId)) {
      if (e.selectable !== null && e.selectable.selected) out.push(e);
    }
    return out;
  }

  // Entity count
  getEntityCount(): number {
    return this.entities.size;
  }

  // Clear all selections (only for active player's units)
  clearSelection(): void {
    for (const entity of this.entities.values()) {
      if (entity.selectable !== null && entity.ownership !== null && entity.ownership.playerId === this.activePlayerId) {
        entity.selectable.selected = false;
      }
    }
  }

  // Select entities by IDs (only if owned by active player)
  selectEntities(ids: EntityId[]): void {
    for (const id of ids) {
      const entity = this.entities.get(id);
      if (
        entity !== undefined &&
        entity.selectable !== null &&
        entity.ownership !== null &&
        entity.ownership.playerId === this.activePlayerId
      ) {
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

  // Internal shell used only by createUnitFromBlueprint. Public callers
  // must go through blueprints so stats, mounts, locomotion, and body
  // heights cannot drift from the authored unit data.
  private createUnitBase(
    x: number,
    y: number,
    playerId: PlayerId,
    unitBlueprintId: string,
    radius: { visual: number; hitbox: number; collision: number } = { visual: 15, hitbox: 15, collision: 15 },
    bodyCenterHeight: number = radius.collision,
    fullVisionRadius: number = 1200,
    locomotion: UnitLocomotion = getUnitLocomotion(unitBlueprintId),
    mass: number = 25,
    hp: number = 100,
  ): Entity {
    const id = this.generateEntityId();

    // Initial altitude = local terrain + the unit's stable spawn
    // center height. Ground units start just above their authored
    // body-center height so gravity/terrain spring settle them through
    // the same physics path. Airborne units start at the equilibrium
    // implied by their constant counter-gravity and inverse-distance
    // ground-effect lift; dropping them at ground height makes the
    // inverse-distance lift kick violently on the first tick.
    const groundZ = this.getGroundZ(x, y);
    const isAirborneLocomotion =
      locomotion.type === 'hover' || locomotion.type === 'flying';
    const spawnCenterHeight = isAirborneLocomotion &&
      locomotion.gravityCounterUpwardForceRatio !== undefined &&
      Number.isFinite(locomotion.gravityCounterUpwardForceRatio) &&
      locomotion.gravityCounterUpwardForceRatio < 1 &&
      locomotion.hoverHeightUpwardForce !== undefined &&
      Number.isFinite(locomotion.hoverHeightUpwardForce)
      ? locomotion.hoverHeightUpwardForce / (1 - locomotion.gravityCounterUpwardForceRatio)
      : bodyCenterHeight + UNIT_INITIAL_SPAWN_HEIGHT_ABOVE_GROUND;
    // Seed the per-unit smoothed normal with the raw normal at the
    // spawn position so the first tick after spawn doesn't snap from
    // the flat default to a tilted slope. The cache lookup also seeds
    // the cell entry for any downstream reader on this tick.
    const spawnNormal = this.getCachedSurfaceNormal(x, y);
    const entity: Entity = {
      ...createEmptyEntityComponentSlots(),
      id,
      type: 'unit',
      transform: createTransform(x, y, groundZ + spawnCenterHeight, 0),
      selectable: { selected: false },
      ownership: { playerId },
      unit: {
        unitBlueprintId,
        locomotion: cloneUnitLocomotion(locomotion),
        radius: { ...radius },
        bodyCenterHeight,
        fullVisionRadius,
        mass,
        hp,
        maxHp: hp,
        actions: [],
        actionHash: 0,
        patrolStartIndex: null,
        flyingLoiterTargetX: null,
        flyingLoiterTargetY: null,
        flyingLoiterTargetZ: null,
        flyingLoiterTurnSign: null,
        velocityX: 0,
        velocityY: 0,
        velocityZ: 0,
        movementAccelX: 0,
        movementAccelY: 0,
        movementAccelZ: 0,
        thrustDirX: 0,
        thrustDirY: 0,
        suspension: null,
        shieldPanels: [],
        shieldBoundRadius: 0,
        surfaceNormal: { nx: spawnNormal.nx, ny: spawnNormal.ny, nz: spawnNormal.nz },
        // Airborne units carry a full quaternion + ω-vector + α-vector
        // orientation triad so they can express roll (banking into a
        // turn). Ground units stay yaw-scalar-only (transform.rotation).
        // The identity quat matches transform.rotation = 0 with zero
        // pitch/roll, so spawning an airborne unit looks the same as
        // spawning a ground unit until forces start acting on it.
        orientation: isAirborneLocomotion
          ? { x: 0, y: 0, z: 0, w: 1 }
          : null,
        angularVelocity3: isAirborneLocomotion
          ? { x: 0, y: 0, z: 0 }
          : null,
        angularAcceleration3: isAirborneLocomotion
          ? { x: 0, y: 0, z: 0 }
          : null,
        hoverHeightUpwardForceSmoothed: null,
        stuckTicks: 0,
      },
      // combat is attached by the caller (createUnitFromBlueprint) once
      // it knows the runtime turret list. The base entity has no combat
      // component yet because not every caller wants one.
    };
    return entity;
  }

  // Create a unit from blueprint — unified factory for ALL unit blueprints including commander
  createUnitFromBlueprint(
    x: number,
    y: number,
    playerId: PlayerId,
    unitBlueprintId: string,
    options: { allocateSubEntityIds?: boolean } = {},
  ): Entity {
    const bp = getUnitBlueprint(unitBlueprintId);
    const allocateSubEntityIds = options.allocateSubEntityIds !== false;

    const entity = this.createUnitBase(
      x, y, playerId, unitBlueprintId,
      bp.radius,
      bp.bodyCenterHeight,
      bp.fullVisionRadius,
      getUnitLocomotion(unitBlueprintId),
      bp.mass,
      bp.hp * UNIT_HP_MULTIPLIER,
    );
    // Chassis suspension is renderer-owned visual state. The
    // authoritative host keeps it absent so turret mounts, targeting,
    // snapshots, and physics all read the rigid body anchor only.
    entity.unit!.suspension = null;

    // Create combat component (turrets + per-host bookkeeping) from
    // blueprint. Every unit blueprint declares at least one turret, so
    // every unit gets a combat component at spawn.
    entity.combat = createCombatComponent(createUnitRuntimeTurrets(
      unitBlueprintId,
      bp.radius.visual,
      entity.id,
      entity.id,
      allocateSubEntityIds ? () => this.generateEntityId() : null,
    ));

    // Cache shield panels for fast beam collision checks. Same helper
    // runs on the client (NetworkEntityFactory) so authoritative and
    // hydrated entities share one canonical rectangle.
    entity.unit!.shieldBoundRadius = buildShieldPanelCache(
      bp, entity.unit!.shieldPanels,
    );

    // Attach builder component if blueprint specifies it
    if (bp.builder) {
      entity.builder = {
        buildRange: bp.builder.buildRange,
        constructionRate: bp.builder.constructionRate,
        currentBuildTarget: NO_ENTITY_ID,
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

  // Create a D-gun projectile
  createDGunProjectile(
    x: number,
    y: number,
    velocityX: number,
    velocityY: number,
    ownerId: PlayerId,
    sourceEntityId: EntityId,
    config: TurretConfig,
    provenance: CreateProjectileProvenance | null = null,
  ): Entity {
    const entity = this.createProjectile(
      x, y, velocityX, velocityY, ownerId, sourceEntityId,
      createProjectileConfigFromTurret(config),
      'projectile',
      provenance,
    );

    // Mark as D-gun wave; projectile integration applies gravity plus
    // bounded vertical thrust to ride terrain at this offset.
    entity.dgunProjectile = {
      isDGun: true,
      groundOffset: DGUN_TERRAIN_FOLLOW_HEIGHT,
    };

    // D-gun hits everything (infinite hits)
    if (entity.projectile) {
      entity.projectile.maxHits = Infinity;
      const speed = Math.hypot(velocityX, velocityY);
      if (speed > 1e-6 && Number.isFinite(config.range) && config.range > 0) {
        entity.projectile.maxLifespan = (config.range / speed) * 1000;
      }
    }

    return entity;
  }

  // Create a building entity
  createBuilding(
    x: number, y: number,
    width: number, height: number, depth: number,
    playerId: PlayerId | null = null,
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
      ...createEmptyEntityComponentSlots(),
      id,
      type: 'building',
      transform: createTransform(x, y, baseZ + depth / 2, 0),
      building: {
        width,
        height,
        depth,
        hp: 500,
        maxHp: 500,
        targetRadius: Math.sqrt(width * width + height * height) / 2,
        activeState: null,
      },
      selectable: { selected: false },
    };

    if (playerId !== null) {
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
    config: ProjectileConfig,
    projectileType: ProjectileType = 'projectile',
    provenance: CreateProjectileProvenance | null = null,
  ): Entity {
    const id = this.generateEntityId();

    // Calculate rotation from velocity
    const rotation = Math.atan2(velocityY, velocityX);

    // Traveling projectile shots do not carry authored time-to-live values; they
    // terminate through collision/ground physics. Line shots still use
    // this runtime timeout for laser pulse duration.
    const maxLifespan = config.shotProfile.runtime.maxLifespan;
    const shotHealth = isProjectileShot(config.shot) ? config.shot.health : 0;

    // Always single hit (DGun overrides maxHits to Infinity after creation)
    const maxHits = 1;
    const shotBlueprintId = provenance !== null && provenance.shotBlueprintId !== undefined && provenance.shotBlueprintId !== null
      ? provenance.shotBlueprintId
      : getEmissionBlueprintId(config.shot);
    const shotSource: ShotSource = provenance !== null && provenance.shotSource !== undefined && provenance.shotSource !== null
      ? { ...provenance.shotSource }
      : {
        sourceTurretEntityId: null,
        sourceHostEntityId: sourceEntityId,
        sourceRootEntityId: sourceEntityId,
        sourcePlayerId: ownerId,
        sourceTeamId: this.getTeamId(ownerId),
        sourceTurretBlueprintId: config.sourceTurretBlueprintId,
        sourceShotBlueprintId: shotBlueprintId,
        spawnTick: this.tick,
        parentShotEntityId: null,
      };

    // createProjectile's z/vz defaults to "fired horizontally at
    // source turret height" — M6 (projectile ballistics) will override
    // these with per-turret pitch and ballistic solutions. The point
    // of this commit is just that the fields exist and get serialized.
    const projectile: Projectile = {
      ownerId,
      sourceEntityId,
      config,
      shotBlueprintId,
      shotSource,
      sourceTurretBlueprintId: shotSource.sourceTurretBlueprintId ?? config.sourceTurretBlueprintId,
      ...PROJECTILE_ABSENCE_SLOTS,
      projectileType,
      hp: shotHealth,
      maxHp: shotHealth,
      velocityX,
      velocityY,
      velocityZ: 0,
      timeAlive: 0,
      maxLifespan,
      hitEntities: new Set<EntityId>(),
      maxHits,
      isArmed: projectileType !== 'projectile' || config.shotProfile.runtime.armingDelayMs <= 0,
      hasLeftSource: false,
      homingTargetId: NO_ENTITY_ID,
      lastSentVelX: velocityX,
      lastSentVelY: velocityY,
      lastSentVelZ: 0,
    };

    const entity: Entity = {
      ...createEmptyEntityComponentSlots(),
      id,
      type: 'shot',
      transform: createTransform(x, y, 0, rotation),
      ownership: { playerId: ownerId },
      projectile,
    };

    return entity;
  }

  // Create a beam / laser projectile. Beams are instantaneous line
  // weapons — the z coord is the launch-origin altitude at the moment
  // of firing (same altitude for start and end; beams don't droop under
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
    config: ProjectileConfig,
    projectileType: 'beam' | 'laser' = 'beam',
    provenance: CreateProjectileProvenance | null = null,
  ): Entity {
    const entity = this.createProjectile(startX, startY, 0, 0, ownerId, sourceEntityId, config, projectileType, provenance);
    entity.transform.z = beamZ;

    if (entity.projectile) {
      // Seed a 2-point open-ended polyline (start, authored range end).
      // The per-tick beam handler will overwrite positions and
      // append/remove reflection vertices each re-trace; we own these
      // objects in place so the array reference is stable across the
      // projectile's lifetime.
      entity.projectile.points = [
        { x: startX, y: startY, z: beamZ, vx: 0, vy: 0, vz: 0 },
        { x: endX, y: endY, z: beamZ, vx: 0, vy: 0, vz: 0 },
      ];
      entity.projectile.endpointDamageable = false;
      entity.projectile.segmentLimitReached = false;
    }

    return entity;
  }
}
