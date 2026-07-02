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
  NO_ENTITY_ID,
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
import { DEFAULT_SLOPE_PATH_MODE, type SlopePathMode } from '../../types/slopePathMode';
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
import { entitySlotRegistry } from './EntitySlotRegistry';

const EMPTY_PLAYER_SET: ReadonlySet<PlayerId> = new Set();

/** Temporary vision pulse owned by a single player, contributing a
 *  full-vision source for the ticks between spawn and expiresAtTick.
 *  See WorldState.scanPulses. */
type ScanPulse = {
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

// One pending init "spawn beam": the spawn turret on `sourceId` zaps the
// just-created `targetId` until `untilTick`. Presentation-only (see
// WorldState.spawnBeams) — never serialized.
export type SpawnBeamRegistration = {
  targetId: EntityId;
  sourceId: EntityId;
  untilTick: number;
};

// How long an init spawn-beam stays visible. 30 Hz sim → ~0.27s.
export const SPAWN_BEAM_DURATION_TICKS = 8;

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
  private snapshotDirtyIds: EntityId[] = [];
  private snapshotDirtyFieldsById: number[] = [];
  private pendingDeathCheckIds = new Set<EntityId>();
  private readonly factoryProducedUnitIdsByFactory = new Map<EntityId, Map<string, Set<EntityId>>>();
  private readonly factoryProducedUnitByUnitId = new Map<EntityId, { factoryId: EntityId; unitBlueprintId: string }>();
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

  // Transient, presentation-only init "spawn beam" registrations: a spawn
  // turret on `sourceId` briefly zaps the freshly-created `targetId` into
  // existence (the visible act of a spawn turret bringing an entity into
  // being). NOT serialized — purely a render channel, so it never touches the
  // lockstep checksum. The spray pass emits + skips expired entries; register
  // prunes in place so the list stays bounded even on peers that never run the
  // spray pass.
  public readonly spawnBeams: SpawnBeamRegistration[] = [];

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

  /** Armed self-destruct countdowns: entity id → the tick the blast
   *  fires (BAR-style). Armed by the selfDestruct command (which
   *  toggles), cancelled by Stop or by re-issuing selfDestruct;
   *  Simulation fires due entries once per tick after command
   *  processing so a same-tick Stop wins the tie. Command-driven and
   *  iterated in insertion order, so the map stays deterministic
   *  across lockstep peers. */
  public readonly armedSelfDestructs = new Map<EntityId, number>();

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
  // Slope-traversal policy for ground pathfinding. `directional` lets units
  // descend/fall any slope and only gates uphill; `symmetric` gates both.
  public slopePathMode: SlopePathMode = DEFAULT_SLOPE_PATH_MODE;
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

  refreshEntitySlotState(entity: Entity, dirtyFields = 0): void {
    const ownership = entity.ownership;
    const teamId = ownership !== null ? this.getTeamId(ownership.playerId) : undefined;
    if (dirtyFields !== 0) {
      entitySlotRegistry.markDirty(entity, dirtyFields, teamId);
      return;
    }
    entitySlotRegistry.refreshEntityState(entity, 0, teamId);
  }

  // Get current tick
  getTick(): number {
    return this.tick;
  }

  // Register an init spawn-beam (presentation-only). Prunes expired entries in
  // place first so the list stays bounded regardless of whether the spray pass
  // runs on this peer.
  registerSpawnBeam(targetId: EntityId, sourceId: EntityId): void {
    if (sourceId === NO_ENTITY_ID) return;
    let write = 0;
    for (let read = 0; read < this.spawnBeams.length; read++) {
      const beam = this.spawnBeams[read];
      if (beam.untilTick > this.tick) this.spawnBeams[write++] = beam;
    }
    this.spawnBeams.length = write;
    this.spawnBeams.push({ targetId, sourceId, untilTick: this.tick + SPAWN_BEAM_DURATION_TICKS });
  }

  recordFactoryProducedUnit(factoryId: EntityId, unit: Entity): void {
    const unitBlueprintId = unit.unit?.unitBlueprintId;
    if (unitBlueprintId === undefined) return;
    const factory = this.entities.get(factoryId);
    if (factory?.factory === null || factory?.factory === undefined) return;

    this.removeFactoryProducedUnitReference(unit.id);

    let byUnitBlueprint = this.factoryProducedUnitIdsByFactory.get(factoryId);
    if (byUnitBlueprint === undefined) {
      byUnitBlueprint = new Map();
      this.factoryProducedUnitIdsByFactory.set(factoryId, byUnitBlueprint);
    }
    let unitIds = byUnitBlueprint.get(unitBlueprintId);
    if (unitIds === undefined) {
      unitIds = new Set();
      byUnitBlueprint.set(unitBlueprintId, unitIds);
    }
    unitIds.add(unit.id);
    this.factoryProducedUnitByUnitId.set(unit.id, { factoryId, unitBlueprintId });
    if (this.syncFactoryProductionQuotaCountForUnit(factory, unitBlueprintId)) {
      this.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
    }
  }

  getFactoryProducedUnitCount(factoryId: EntityId, unitBlueprintId: string): number {
    return this.factoryProducedUnitIdsByFactory.get(factoryId)?.get(unitBlueprintId)?.size ?? 0;
  }

  syncFactoryProductionQuotaCounts(factory: Entity): boolean {
    const factoryComp = factory.factory;
    if (factoryComp === null) return false;

    let changed = false;
    const counts = factoryComp.productionQuotaCounts;
    for (const unitBlueprintId of Object.keys(counts)) {
      const quota = factoryComp.productionQuotas[unitBlueprintId];
      if (!Number.isFinite(quota) || quota <= 0) {
        delete counts[unitBlueprintId];
        changed = true;
      }
    }

    for (const [unitBlueprintId, rawQuota] of Object.entries(factoryComp.productionQuotas)) {
      const quota = Math.floor(rawQuota);
      if (quota <= 0 || !Number.isFinite(rawQuota)) continue;
      const current = this.getFactoryProducedUnitCount(factory.id, unitBlueprintId);
      if (counts[unitBlueprintId] !== current) {
        counts[unitBlueprintId] = current;
        changed = true;
      }
    }
    return changed;
  }

  private syncFactoryProductionQuotaCountForUnit(factory: Entity, unitBlueprintId: string): boolean {
    const factoryComp = factory.factory;
    if (factoryComp === null) return false;

    const quota = factoryComp.productionQuotas[unitBlueprintId];
    if (!Number.isFinite(quota) || quota <= 0) {
      if (factoryComp.productionQuotaCounts[unitBlueprintId] === undefined) return false;
      delete factoryComp.productionQuotaCounts[unitBlueprintId];
      return true;
    }

    const current = this.getFactoryProducedUnitCount(factory.id, unitBlueprintId);
    if (factoryComp.productionQuotaCounts[unitBlueprintId] === current) return false;
    factoryComp.productionQuotaCounts[unitBlueprintId] = current;
    return true;
  }

  private removeFactoryProducedUnitReference(unitId: EntityId): void {
    const produced = this.factoryProducedUnitByUnitId.get(unitId);
    if (produced === undefined) return;

    this.factoryProducedUnitByUnitId.delete(unitId);
    const byUnitBlueprint = this.factoryProducedUnitIdsByFactory.get(produced.factoryId);
    if (byUnitBlueprint !== undefined) {
      const unitIds = byUnitBlueprint.get(produced.unitBlueprintId);
      if (unitIds !== undefined) {
        unitIds.delete(unitId);
        if (unitIds.size === 0) byUnitBlueprint.delete(produced.unitBlueprintId);
      }
      if (byUnitBlueprint.size === 0) {
        this.factoryProducedUnitIdsByFactory.delete(produced.factoryId);
      }
    }

    const factory = this.entities.get(produced.factoryId);
    if (factory?.factory !== null && factory?.factory !== undefined) {
      if (this.syncFactoryProductionQuotaCountForUnit(factory, produced.unitBlueprintId)) {
        this.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
      }
    }
  }

  private clearFactoryProductionProvenanceForFactory(factoryId: EntityId): void {
    const byUnitBlueprint = this.factoryProducedUnitIdsByFactory.get(factoryId);
    if (byUnitBlueprint === undefined) return;
    for (const unitIds of byUnitBlueprint.values()) {
      for (const unitId of unitIds) {
        this.factoryProducedUnitByUnitId.delete(unitId);
      }
    }
    this.factoryProducedUnitIdsByFactory.delete(factoryId);
  }

  // Increment tick
  incrementTick(): void {
    this.tick++;
  }

  // Add entity to world
  addEntity(entity: Entity): void {
    this.entities.set(entity.id, entity);
    this.registerEntityMetadata(entity);
    this.refreshEntitySlotState(entity, 0xff);
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
        ? Math.max(entity.unit.radius.other, entity.unit.radius.hitbox, entity.unit.radius.collision)
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
    if (entity !== undefined) {
      this.removeFactoryProducedUnitReference(entity.id);
      if (entity.factory !== null) {
        this.clearFactoryProductionProvenanceForFactory(entity.id);
      }
    }
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
    this.snapshotDirtyFieldsById[id] = 0;
    if (entity !== undefined) this.markEntityMetadataDead(entity);
    if (entity !== undefined) entitySlotRegistry.unsetEntity(id);
    this.entities.delete(id);
    if (entity !== undefined) this.cache.handleEntityRemoved(entity);
  }

  setEntityOwner(entity: Entity, playerId: PlayerId): void {
    if (entity.ownership !== null && entity.ownership.playerId === playerId) return;
    this.removeFactoryProducedUnitReference(entity.id);
    if (entity.factory !== null) {
      this.clearFactoryProductionProvenanceForFactory(entity.id);
      for (const key of Object.keys(entity.factory.productionQuotas)) delete entity.factory.productionQuotas[key];
      for (const key of Object.keys(entity.factory.productionQuotaCounts)) delete entity.factory.productionQuotaCounts[key];
    }
    entity.ownership = { playerId };
    entitySlotRegistry.setOwnership(entity, this.getTeamId(playerId));
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
    this.refreshEntitySlotState(entity, fields);
    this.enqueueSnapshotDirty(id, fields);
  }

  /** Enqueue snapshot dirtiness after the caller has already updated
   *  EntitySlotRegistry/entity-state hot columns for this entity. */
  markSnapshotDirtyStateSynced(entity: Entity, fields: number): void {
    if (fields === 0) return;
    if (this.entities.get(entity.id) !== entity) return;
    if (entity.type !== 'unit' && entity.type !== 'building' && entity.type !== 'tower') return;
    this.enqueueSnapshotDirty(entity.id, fields);
  }

  private enqueueSnapshotDirty(id: EntityId, fields: number): void {
    if (fields & ENTITY_CHANGED_HP) this.pendingDeathCheckIds.add(id);
    const previousFields = this.snapshotDirtyFieldsById[id] ?? 0;
    if (previousFields === 0) this.snapshotDirtyIds.push(id);
    this.snapshotDirtyFieldsById[id] = previousFields | fields;
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

  drainSnapshotDirtyEntities(
    outIds: EntityId[],
    outFields: number[],
    outSlots?: number[],
  ): void {
    outIds.length = 0;
    outFields.length = 0;
    if (outSlots !== undefined) outSlots.length = 0;
    if (entitySlotRegistry.drainDirtySnapshotEntities(outIds, outFields, outSlots)) {
      for (let i = 0; i < this.snapshotDirtyIds.length; i++) {
        this.snapshotDirtyFieldsById[this.snapshotDirtyIds[i]] = 0;
      }
      this.snapshotDirtyIds.length = 0;
      return;
    }
    this.snapshotDirtyIds.sort((a, b) => a - b);
    for (let i = 0; i < this.snapshotDirtyIds.length; i++) {
      const id = this.snapshotDirtyIds[i];
      const fields = this.snapshotDirtyFieldsById[id] ?? 0;
      if (fields === 0) continue;
      outIds.push(id);
      outFields.push(fields);
      if (outSlots !== undefined) outSlots.push(entitySlotRegistry.getSlot(id));
      this.snapshotDirtyFieldsById[id] = 0;
    }
    this.snapshotDirtyIds.length = 0;
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

  /** Drop every unit's cached pathfinder plan so the next movement step
   *  re-plans under current policy. Used when a global pathfinding rule
   *  (slopePathMode) changes mid-battle so in-flight units re-route. */
  invalidateAllActivePaths(): void {
    for (const entity of this.getAllEntities()) {
      if (entity.unit !== null) entity.unit.activePath = null;
    }
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

  getFlyingUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getFlyingUnits();
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

  // Damaged-or-shell units (hp < maxHp, or an incomplete build shell). Used by
  // idle-builder auto-repair to find nearby damaged friendlies cheaply.
  getDamagedUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getDamagedUnits();
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

  /** Mobile factories: units that carry a factory component (queens). The
   *  production + funding passes iterate buildings then these, so a queen
   *  builds its bee/tick exactly like a building factory. */
  getFactoryUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getFactoryUnits();
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
        hovering: false,
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
