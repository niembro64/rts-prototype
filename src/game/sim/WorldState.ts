import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
import type {
  Entity,
  EntityId,
  EntityMeta,
  EntityType,
  PlayerId,
  TurretConfig,
  ProjectileConfig,
  ProjectileType,
} from './types';
import {
  createEmptyEntityComponentSlots,
  createTransform,
} from './types';
import type { MetalDeposit } from '../../metalDepositConfig';
import type { ResourceMovement } from './resourceMovement';
import { EntityCacheManager } from './EntityCacheManager';
import { WorldEntityMetadata } from './WorldEntityMetadata';
import { SeededRNG } from './SeededRNG';
import {
  WorldProjectileFactory,
  type CreateProjectileProvenance,
} from './WorldProjectileFactory';
import {
  MAX_TOTAL_UNITS,
  DEFAULT_TURRET_SHIELD_PANELS_ENABLED,
  DEFAULT_TURRET_SHIELD_SPHERES_ENABLED,
  DEFAULT_SHIELDS_OBSTRUCT_SIGHT,
  DEFAULT_SHIELD_REFLECTION_MODE,
  DEFAULT_FORCE_FIELDS_VISIBLE,
} from '../../config';
import type { ShieldReflectionMode } from '../../types/shotTypes';
import {
  ENTITY_CHANGED_ACTIONS,
  ENTITY_CHANGED_BUILDING,
  ENTITY_CHANGED_COMBAT_MODE,
  ENTITY_CHANGED_FACTORY,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_TURRETS,
} from '../../types/network';
import { createCollisionTopBuildingSupportSurface } from './buildingSupportSurface';
import type { WorldSupportSurface } from './supportSurface';
import {
  WorldSupportSurfaceSampler,
  type SurfaceNormal,
  type SupportSurfaceQueryOptions,
} from './WorldSupportSurfaceSampler';
import {
  clearOwnedSelection,
  collectSelectedOwnedEntities,
  selectOwnedEntities,
} from './WorldSelection';
import {
  createUnitFromBlueprintEntity,
  type CreateUnitFromBlueprintOptions,
} from './WorldUnitFactory';

export { SeededRNG } from './SeededRNG';
export type { CreateProjectileProvenance } from './WorldProjectileFactory';

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
export type RemovedSnapshotEntity = {
  id: EntityId;
  playerId: PlayerId | null;
  x: number;
  y: number;
  // 'tower' rides the building ghost path on death — same static
  // last-seen-position semantics under FOW-02b.
  type: 'unit' | 'building' | 'tower';
};

// World state holds all entities and game state
export class WorldState {
  private entities: Map<EntityId, Entity> = new Map();
  private readonly entityMetadata: WorldEntityMetadata;
  private readonly projectileFactory: WorldProjectileFactory;
  private nextEntityId: EntityId = 1;
  private tick: number = 0;
  private buildingVersion: number = 0;
  private unitSetVersion: number = 0;
  private removedSnapshotEntities: RemovedSnapshotEntity[] = [];
  private snapshotDirtyIds = new Set<EntityId>();
  private snapshotDirtyFields = new Map<EntityId, number>();
  private pendingDeathCheckIds = new Set<EntityId>();
  private readonly supportSurfaceSampler: WorldSupportSurfaceSampler;
  // Monotonically-growing upper bound on `getTargetRadius(e)` across all
  // unit/building entities ever added to this world. Used by the
  // targeting broadphase to expand its 2D circle query so large targets
  // whose edge falls within a weapon's range, but whose center sits
  // outside the unit-centered batch radius, still enter the candidate
  // array. Stale-too-large is harmless: per-candidate distance checks
  // still enforce the exact range contract.
  private maxTargetableRadius: number = 0;
  // Monotonically-growing upper bound on snapshot visibility padding.
  // Visibility/radar broadphase queries need the target silhouette pad,
  // which is visual/hitbox/collision for units and footprint half-extent
  // for buildings. Stale-too-large mirrors maxTargetableRadius.
  private maxVisibilityPadding: number = 0;
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
  // Whether shield turrets participate in targeting and simulation.
  public turretShieldSpheresEnabled: boolean = DEFAULT_TURRET_SHIELD_SPHERES_ENABLED;
  // Whether force-field shield/panel material is rendered for players.
  // Rendering only; physical reflection/blocking stays active.
  public forceFieldsVisible: boolean = DEFAULT_FORCE_FIELDS_VISIBLE;
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
    this.entityMetadata = new WorldEntityMetadata(this.entities, (playerId) => this.getTeamId(playerId));
    this.projectileFactory = new WorldProjectileFactory({
      generateEntityId: () => this.generateEntityId(),
      getTeamId: (playerId) => this.getTeamId(playerId),
      getTick: () => this.tick,
    });
    this.rng = new SeededRNG(seed);
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.supportSurfaceSampler = new WorldSupportSurfaceSampler(mapWidth, mapHeight);
  }

  /** Terrain/water elevation at world point (x, y). Use
   *  sampleSupportSurface() when the caller needs the complete support
   *  contract including authored building/unit supports. */
  getGroundZ(x: number, y: number): number {
    return this.supportSurfaceSampler.getGroundZ(x, y);
  }

  writeTerrainSupportSurfaceAt(
    x: number,
    y: number,
    terrainGroundZ: number,
    normal: SurfaceNormal,
    out?: WorldSupportSurface,
  ): WorldSupportSurface {
    return this.supportSurfaceSampler.writeTerrainSupportSurfaceAt(x, y, terrainGroundZ, normal, out);
  }

  refreshSupportSurfaceIndex(): void {
    this.supportSurfaceSampler.refreshSupportSurfaceIndex(this.getUnitsAndBuildings());
  }

  sampleSupportSurface(
    x: number,
    y: number,
    options: SupportSurfaceQueryOptions = {},
    out?: WorldSupportSurface,
  ): WorldSupportSurface {
    return this.supportSurfaceSampler.sampleSupportSurface(x, y, this.getUnitsAndBuildings(), options, out);
  }

  sampleSupportSurfaceFromIndex(
    x: number,
    y: number,
    options: SupportSurfaceQueryOptions = {},
    out?: WorldSupportSurface,
  ): WorldSupportSurface {
    return this.supportSurfaceSampler.sampleSupportSurfaceFromIndex(x, y, options, out);
  }

  getCachedSurfaceNormal(x: number, y: number): SurfaceNormal {
    return this.supportSurfaceSampler.getCachedSurfaceNormal(x, y);
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

  getNextEntityId(): EntityId {
    return this.nextEntityId;
  }

  getEntityMeta(id: EntityId): EntityMeta | undefined {
    return this.entityMetadata.get(id);
  }

  resolveMountedTurret(id: EntityId): { host: Entity; turret: NonNullable<Entity['combat']>['turrets'][number] } | undefined {
    return this.entityMetadata.resolveMountedTurret(id);
  }

  resolveEntityMeta(id: EntityId, generation: number): EntityMeta | undefined {
    return this.entityMetadata.resolve(id, generation);
  }

  private registerEntityMetadata(entity: Entity): void {
    this.entityMetadata.register(entity);
  }

  markSubEntityMetadataDead(id: EntityId): void {
    this.entityMetadata.markSubEntityDead(id);
  }

  refreshEntityMetadata(entity: Entity): void {
    this.entityMetadata.refresh(entity);
  }

  setSubEntityMetadataTargetable(id: EntityId, targetable: boolean): void {
    this.entityMetadata.setSubEntityTargetable(id, targetable);
  }

  private markEntityMetadataDead(entity: Entity): void {
    this.entityMetadata.markEntityDead(entity);
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
      const visibilityPadding = entity.unit
        ? Math.max(entity.unit.radius.visual, entity.unit.radius.hitbox, entity.unit.radius.collision)
        : (entity.building ? Math.max(entity.building.width, entity.building.height) * 0.5 : 0);
      if (visibilityPadding > this.maxVisibilityPadding) this.maxVisibilityPadding = visibilityPadding;
    }
    this.markSnapshotDirty(entity.id, 0xff);
    this.cache.handleEntityAdded(entity);
  }

  /** Upper bound on `getTargetRadius(e)` for any unit/building entity
   *  in the world. Grows monotonically as larger entities spawn; never
   *  shrinks when entities die (stale-too-large just sizes broadphase
   *  queries slightly wider than strictly needed). */
  getMaxTargetableRadius(): number {
    return this.maxTargetableRadius;
  }

  /** Upper bound on getEntityVisibilityPadding(e) for any unit/building
   *  entity in the world. Grows monotonically so broadphase visibility
   *  candidate queries can stay conservative without rescanning every
   *  entity to rediscover the largest silhouette each snapshot. */
  getMaxVisibilityPadding(): number {
    return this.maxVisibilityPadding;
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
    if (entity !== undefined) this.cache.handleEntityRemoved(entity);
  }

  setEntityOwner(entity: Entity, playerId: PlayerId): void {
    if (entity.ownership !== null && entity.ownership.playerId === playerId) return;
    entity.ownership = { playerId };
    this.cache.invalidate();
    this.markSnapshotDirty(
      entity.id,
      ENTITY_CHANGED_ACTIONS |
        ENTITY_CHANGED_BUILDING |
        ENTITY_CHANGED_COMBAT_MODE |
        ENTITY_CHANGED_FACTORY |
        ENTITY_CHANGED_TURRETS,
    );
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
    out.sort((a, b) => a - b);
    this.pendingDeathCheckIds.clear();
  }

  clearPendingDeathCheckIds(): void {
    this.pendingDeathCheckIds.clear();
  }

  drainSnapshotDirtyEntities(outIds: EntityId[], outFields: number[]): void {
    outIds.length = 0;
    outFields.length = 0;
    for (const id of this.snapshotDirtyIds) outIds.push(id);
    outIds.sort((a, b) => a - b);
    for (let i = 0; i < outIds.length; i++) {
      const id = outIds[i];
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

  getUnitsAndBuildings(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getUnitsAndBuildings();
  }

  getCombatTargetEntities(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getCombatTargetEntities();
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

  // Get static entities that need body/build HUD bars (cached - DO NOT MODIFY returned array).
  getHealthBarBuildings(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getHealthBarBuildings();
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
    return collectSelectedOwnedEntities(
      this.getAllEntities(),
      this.activePlayerId,
      this._selectedEntitiesBuf,
    );
  }

  // Get selected units for active player
  getSelectedUnits(): Entity[] {
    return collectSelectedOwnedEntities(
      this.getUnits(),
      this.activePlayerId,
      this._selectedUnitsBuf,
    );
  }

  // Get selected factories for active player
  getSelectedFactories(): Entity[] {
    const playerId = this.activePlayerId;
    this.rebuildCachesIfNeeded();
    return collectSelectedOwnedEntities(
      this.cache.getFactoriesByPlayer(playerId),
      playerId,
      this._selectedFactoriesBuf,
    );
  }

  // Entity count
  getEntityCount(): number {
    return this.entities.size;
  }

  // Clear all selections (only for active player's units)
  clearSelection(): void {
    clearOwnedSelection(this.entities.values(), this.activePlayerId);
  }

  // Select entities by IDs (only if owned by active player)
  selectEntities(ids: EntityId[]): void {
    selectOwnedEntities(ids, this.entities, this.activePlayerId);
  }

  // Switch active player
  setActivePlayer(playerId: PlayerId): void {
    // Clear current selections when switching
    this.clearSelection();
    this.activePlayerId = playerId;
  }

  // Create a unit from blueprint — unified factory for ALL unit blueprints including commander
  createUnitFromBlueprint(
    x: number,
    y: number,
    playerId: PlayerId,
    unitBlueprintId: string,
    options: CreateUnitFromBlueprintOptions = {},
  ): Entity {
    return createUnitFromBlueprintEntity(
      {
        generateEntityId: () => this.generateEntityId(),
        sampleSupportSurface: (sx, sy) => this.sampleSupportSurface(sx, sy),
      },
      x,
      y,
      playerId,
      unitBlueprintId,
      options,
    );
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
    return this.projectileFactory.createDGunProjectile(
      x,
      y,
      velocityX,
      velocityY,
      ownerId,
      sourceEntityId,
      config,
      provenance,
    );
  }

  // Create a building entity
  createBuilding(
    x: number, y: number,
    width: number, height: number, depth: number,
    playerId: PlayerId | null = null,
    rotation = 0,
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
      transform: createTransform(x, y, baseZ + depth / 2, rotation),
      building: {
        width,
        height,
        depth,
        supportSurface: createCollisionTopBuildingSupportSurface(width, height, depth),
        hp: 500,
        maxHp: 500,
        targetRadius: DMath.sqrt(width * width + height * height) / 2,
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
    return this.projectileFactory.createProjectile(
      x,
      y,
      velocityX,
      velocityY,
      ownerId,
      sourceEntityId,
      config,
      projectileType,
      provenance,
    );
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
    return this.projectileFactory.createBeam(
      startX,
      startY,
      beamZ,
      endX,
      endY,
      ownerId,
      sourceEntityId,
      config,
      projectileType,
      provenance,
    );
  }
}
