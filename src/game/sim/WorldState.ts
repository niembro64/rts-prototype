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
import {
  buildAlliesByPlayer,
  buildFreeForAllRoster,
  getAllyTeamMembers,
  getOccupiedAllyTeamCount,
  type TeamRoster,
} from './teamRoster';
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
  DEFAULT_ENTITY_COUNT_CAP,
  DEFAULT_TURRET_SHIELD_PANELS_ENABLED,
  DEFAULT_TURRET_SHIELD_SPHERES_ENABLED,
  DEFAULT_SHIELD_REFLECTION_MODE,
  DEFAULT_FORCE_FIELDS_VISIBLE,
  DEFAULT_SLOW_DOWN_AT_FINAL_WAYPOINT,
  DEFAULT_PATHFINDING_CONSIDERS_UNITS,
} from '../../config';
import { isEntityActive } from './buildableHelpers';
import type { BuildingBlueprintId } from '../../types/blueprintIds';
import type { ShieldReflectionMode } from '../../types/shotTypes';
import { DEFAULT_SLOPE_PATH_MODE, type SlopePathMode } from '../../types/slopePathMode';
import {
  DEFAULT_LIQUID_SURFACE_MODE,
  DEFAULT_METAL_COVERAGE,
  type LiquidSurfaceMode,
  type MetalCoverage,
} from '../../types/worldSurfaceMode';
import {
  DEFAULT_AUTO_CONVERSION_ENERGY_AT,
  DEFAULT_AUTO_CONVERSION_METAL_AT,
} from '../../types/autoConversion';
import {
  DEFAULT_SIMULATION_TICK_RATE_HZ,
  simulationTicksForDefaultTicks,
  simulationTicksForSeconds,
  type SimulationTickRateHz,
} from '../../types/simulationTickRate';
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
  type: 'unit' | 'building';
};

/** Realized builder contribution for this tick. This transient presentation
 *  ledger is deliberately separate from resource movements: repair is free,
 *  and construction particles communicate work rather than payment lanes. */
type WorkMovement = {
  sourceEntityId: EntityId;
  targetEntityId: EntityId;
  operation: 'construct' | 'repair' | 'reclaim';
  amountPerSecond: number;
  /** World point for work targets that are not entities (vegetation
   *  props, which live in their own store). Null for entity targets —
   *  those read the live transform instead so the spray tracks a target
   *  that is still moving. */
  targetPoint: WorkMovementPoint | null;
};

type WorkMovementPoint = {
  x: number;
  y: number;
  z: number;
  radius: number;
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
  private snapshotDirtyIds: EntityId[] = [];
  // Keyed sparsely: entity ids are monotonic and never recycled, so a
  // dense id-indexed array would grow with every entity ever spawned.
  private readonly snapshotDirtyFieldsById = new Map<EntityId, number>();
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
  private readonly rng: SeededRNG;

  public readonly workMovements: WorkMovement[] = [];
  private readonly workMovementPool: WorkMovement[] = [];

  // Current player being controlled
  public activePlayerId: PlayerId = 1;

  // Number of players in the game (layout + economy; the entity count
  // cap divides by SIDES, not by this)
  public playerCount: number = 2;

  /** Match-static authoritative cadence. Tick-based gameplay durations use
   *  this value so changing server Hz changes resolution, not game speed. */
  public simulationTickRateHz: SimulationTickRateHz =
    DEFAULT_SIMULATION_TICK_RATE_HZ;

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

  /** Who is on which side. Player -> team -> ally team, the three BAR
   *  ownership levels; see teamRoster.ts. Terrain dividers, spawn angles,
   *  and `alliesByPlayer` above are all derived from this one assignment
   *  rather than each re-deriving groupings from player ids. Defaults to
   *  free-for-all (every seat its own side) so a fresh world, a test
   *  fixture, or a reset path behaves exactly as it did before teams
   *  existed. */
  public teamRoster: TeamRoster = buildFreeForAllRoster([1 as PlayerId]);

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

  /** Unfinished shells that nobody funded this tick: entity id → seconds
   *  since the last construction work landed on them. constructionLifecycle
   *  owns every write, drops entries the moment funding resumes, and removes
   *  the frame outright once decay reaches zero progress. Derived state, so
   *  it is not serialized: every peer runs the same lifecycle pass. */
  public readonly unfundedBuildSeconds = new Map<EntityId, number>();

  /** Buildings added since the last tick that still need a collision body.
   *  A structure placed during play is the same obstacle as one placed at
   *  boot: Simulation drains this into `onBuildingSpawn`, which is where the
   *  static body is built. Without it a player-built structure had a
   *  pathfinding footprint but no physical presence, so a unit standing on
   *  the site was never pushed out of it. */
  public readonly pendingBuildingBodySpawns: Entity[] = [];

  // Map dimensions
  public readonly mapWidth: number;
  public readonly mapHeight: number;

  // Metal deposits — fixed map features generated at world init.
  // Same list across all clients (deterministic from map size).
  public metalDeposits: MetalDeposit[] = [];

  /** ENTITY COUNT CAP — the match's TOTAL entity budget (units + buildings),
   *  changeable at runtime via command. Nothing enforces this number
   *  directly: it is divided into per-side pools by
   *  `getTeamEntityCountCap()`, which is what production actually checks.
   *  Because it is a total, adding seats no longer multiplies sim load. */
  public entityCountCap: number = DEFAULT_ENTITY_COUNT_CAP;

  // Whether turretShieldPanels/panels participate in targeting and reflections
  public turretShieldPanelsEnabled: boolean = DEFAULT_TURRET_SHIELD_PANELS_ENABLED;
  // Whether shield turrets participate in targeting and simulation.
  public turretShieldSpheresEnabled: boolean = DEFAULT_TURRET_SHIELD_SPHERES_ENABLED;
  // Whether force-field shield/panel material is rendered for players.
  // Rendering only; physical reflection/blocking stays active.
  public forceFieldsVisible: boolean = DEFAULT_FORCE_FIELDS_VISIBLE;
  // Per-player shield-aware targeting is NOT a stored flag: it derives
  // deterministically from building ownership every time it is read.
  // See playerHasShieldAwareTargeting / getShieldAwareTargetingPlayerMask.
  // Which shield boundary crossings reflect shots/beams.
  public shieldReflectionMode: ShieldReflectionMode = DEFAULT_SHIELD_REFLECTION_MODE;
  // Whether player-specific snapshots and the client fog overlay use vision.
  public fogOfWarEnabled: boolean = true;
  /** P1-08: armed by the ONE code path that creates gather-wait actions
   *  from nothing (commandExecution); cleared when a full sweep finds no
   *  group anywhere. Queue COPIES can only exist while an original does,
   *  so a copy can never appear under a cleared flag. Deterministic:
   *  driven purely by lockstep commands and lockstep sweeps. */
  public gatherWaitsMayExist = false;
  /** P1-20: bumped whenever a building's producing eligibility can have
   *  changed outside lifecycle — an active-state open/close flip or a
   *  completion. Consumers pair it with getBuildingVersion() to cache
   *  per-player producer membership. */
  public buildingOpenStateVersion = 0;
  /** Whether ordinary final actions use velocity-aware braking before their
   *  last waypoint. Off preserves full thrust until the tight arrival gate. */
  public slowDownAtFinalWaypoint: boolean = DEFAULT_SLOW_DOWN_AT_FINAL_WAYPOINT;
  /** Whether pathfinding treats other units as obstacles. Driven purely by
   *  the lockstep BATTLE setting command; hashed with the rest of the
   *  gameplay settings. */
  public pathfindingConsidersUnits: boolean = DEFAULT_PATHFINDING_CONSIDERS_UNITS;
  // Slope-traversal policy for ground pathfinding. `directional` lets units
  // descend/fall any slope and only gates uphill; `symmetric` gates both.
  public slopePathMode: SlopePathMode = DEFAULT_SLOPE_PATH_MODE;
  // Ground material policy. `metal` treats every build-grid cell as metal ore
  // and suppresses the discrete deposit crowns; the deposits still shaped the
  // terrain. See types/worldSurfaceMode.
  public metalCoverage: MetalCoverage = DEFAULT_METAL_COVERAGE;
  // What fills the map below WATER_LEVEL. `lava` burns anything touching it.
  public liquidSurfaceMode: LiquidSurfaceMode = DEFAULT_LIQUID_SURFACE_MODE;
  /** Tax (fraction in [0, 1)) applied to a resource converter's per-tick
   *  output. 0 = lossless; 0.5 = lose half of the source resource on
   *  every conversion. Read by economy.update each tick. */
  public converterTax: number = 0;
  /** Per-player auto-conversion slider points (fractions of storage).
   *  Each resource has ONE point: the level above which converters send
   *  it toward the other resource, and the ceiling conversion may fill it
   *  to. Absent players use the defaults. Set by the
   *  setAutoConversionThresholds command; read by processConverters. */
  public autoConversionEnergyAt = new Map<PlayerId, number>();
  public autoConversionMetalAt = new Map<PlayerId, number>();

  getAutoConversionEnergyAt(playerId: PlayerId): number {
    return this.autoConversionEnergyAt.get(playerId)
      ?? DEFAULT_AUTO_CONVERSION_ENERGY_AT;
  }

  getAutoConversionMetalAt(playerId: PlayerId): number {
    return this.autoConversionMetalAt.get(playerId)
      ?? DEFAULT_AUTO_CONVERSION_METAL_AT;
  }
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
    this.entityMetadata = new WorldEntityMetadata(
      this.entities,
      (playerId) => this.getTeamId(playerId),
      () => this.simulationTickRateHz,
    );
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

  ticksForSeconds(seconds: number): number {
    return simulationTicksForSeconds(this.simulationTickRateHz, seconds);
  }

  ticksForDefaultTicks(defaultTicks: number): number {
    return simulationTicksForDefaultTicks(
      this.simulationTickRateHz,
      defaultTicks,
    );
  }

  /** Canonical simulation randomness. Callers provide the player whose
   * action/entity owns the outcome; the world supplies the current tick. */
  nextRandom(playerId: PlayerId = 0 as PlayerId): number {
    return this.rng.next(playerId, this.tick);
  }

  getGameGenerationSeed(): number {
    return this.rng.getGameGenerationSeed();
  }

  getRandomStreamState(): number {
    return this.rng.getSeed();
  }

  /** Terrain/water elevation at world point (x, y). Use
   *  sampleSupportSurface() when the caller needs the complete support
   *  contract including authored building/unit supports. */
  getGroundZ(x: number, y: number): number {
    return this.supportSurfaceSampler.getGroundZ(x, y);
  }

  /** Raw terrain mesh height under water as well as on land. Physics uses this
   *  as solid ground; gameplay surface queries should keep using getGroundZ(). */
  getTerrainBedZ(x: number, y: number): number {
    return this.supportSurfaceSampler.getTerrainBedZ(x, y);
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

  // Support-index rebuild gate. Within one frozen-positions window a
  // rebuild is pure recomputation of identical contents, so repeat
  // callers (per-spawn one-shot samples, the per-tick force pass) reuse
  // the index. The key invalidates on: membership change (cache
  // version), tick change, and the positions epoch that
  // ServerSimulationCore bumps after physics writes entity transforms —
  // without the epoch, an index built after movement would be reused by
  // the NEXT tick's spawn samples with stale positions.
  private supportIndexRebuiltTick = -1;
  private supportIndexMembershipVersion = -1;
  private supportIndexPositionsEpoch = -1;
  private supportPositionsEpoch = 0;

  /** Called by the simulation core after any phase that rewrites entity
   *  transforms wholesale (physics sync). Invalidates the support-index
   *  rebuild gate. */
  bumpSupportPositionsEpoch(): void {
    this.supportPositionsEpoch++;
  }

  refreshSupportSurfaceIndex(): void {
    const tick = this.getTick();
    const membershipVersion = this.cache.getSupportSurfaceEntityVersion();
    if (
      this.supportIndexRebuiltTick === tick &&
      this.supportIndexMembershipVersion === membershipVersion &&
      this.supportIndexPositionsEpoch === this.supportPositionsEpoch
    ) {
      return;
    }
    this.supportSurfaceSampler.refreshSupportSurfaceIndex(this.getSupportSurfaceEntities());
    this.supportIndexRebuiltTick = tick;
    this.supportIndexMembershipVersion = membershipVersion;
    this.supportIndexPositionsEpoch = this.supportPositionsEpoch;
  }

  sampleSupportSurface(
    x: number,
    y: number,
    options: SupportSurfaceQueryOptions = {},
    out?: WorldSupportSurface,
  ): WorldSupportSurface {
    this.refreshSupportSurfaceIndex();
    return this.supportSurfaceSampler.sampleSupportSurfaceFromIndex(x, y, options, out);
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

  getCachedTerrainBedNormal(x: number, y: number): SurfaceNormal {
    return this.supportSurfaceSampler.getCachedTerrainBedNormal(x, y);
  }

  private rebuildCachesIfNeeded(): void {
    this.cache.rebuildIfNeeded(this.entities);
  }

  /** TEAM ENTITY COUNT CAP — the share of `entityCountCap` one ally team may
   *  fill. The authored cap is the whole match's total; it is split evenly
   *  across the sides that actually have seats (an empty declared side gets
   *  a terrain slice, not a share) and the seats on a side then share their
   *  side's pool. Split by SIDE, never by seat: a lone player fields the
   *  same army as the three players opposite them, which is the point.
   *
   *  The floor's remainder (up to sides-1 entities) is simply unreachable;
   *  the cap is a load ceiling, not an accounting identity. */
  getTeamEntityCountCap(): number {
    const sides = getOccupiedAllyTeamCount(this.teamRoster);
    return Math.max(0, Math.floor(Math.max(0, this.entityCountCap) / sides));
  }

  /** Everything the cap counts, for one ally team: units AND buildings, all
   *  seats summed. Live and shell (under-construction) entities both count —
   *  a nanoframe already occupies its slot, which is what stops a queue from
   *  overshooting the cap. Both indexes are cached per player, so this is a
   *  handful of map lookups even at 10k entities. */
  getTeamEntityCount(playerId: PlayerId): number {
    const members = getAllyTeamMembers(this.teamRoster, playerId);
    let total = 0;
    for (let i = 0; i < members.length; i++) {
      total += this.getUnitsByPlayer(members[i]).length;
      total += this.getBuildingsByPlayer(members[i]).length;
    }
    return total;
  }

  /** Whether `playerId`'s SIDE has room for one more entity. Existing
   *  entities only — production consults this per item, so no queue
   *  accounting happens here. */
  canPlayerBuildEntity(playerId: PlayerId): boolean {
    return this.getTeamEntityCount(playerId) < this.getTeamEntityCountCap();
  }

  // Check if player can select another repeat-build item. Repeat-build is
  // not a queue, so only live/shell entities count against the cap.
  canPlayerQueueEntity(playerId: PlayerId): boolean {
    return this.canPlayerBuildEntity(playerId);
  }

  /** Room left in `playerId`'s SIDE pool. Teammates draw from the same
   *  number, first come first served — one seat may legitimately consume
   *  the whole side's share. */
  getRemainingTeamEntityCapacity(playerId: PlayerId): number {
    return Math.max(0, this.getTeamEntityCountCap() - this.getTeamEntityCount(playerId));
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
    this.entityMetadata.markEntityDead(entity, this.tick);
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

  beginWorkMovementTick(): void {
    this.workMovements.length = 0;
  }

  recordWorkMovement(
    sourceEntityId: EntityId,
    targetEntityId: EntityId,
    operation: WorkMovement['operation'],
    amountPerSecond: number,
    targetPoint: WorkMovementPoint | null = null,
  ): void {
    if (
      sourceEntityId === NO_ENTITY_ID ||
      !Number.isFinite(amountPerSecond) ||
      amountPerSecond <= 0
    ) return;
    const index = this.workMovements.length;
    let movement = this.workMovementPool[index];
    if (movement === undefined) {
      movement = {
        sourceEntityId,
        targetEntityId,
        operation,
        amountPerSecond,
        targetPoint: null,
      };
      this.workMovementPool[index] = movement;
    } else {
      movement.sourceEntityId = sourceEntityId;
      movement.targetEntityId = targetEntityId;
      movement.operation = operation;
      movement.amountPerSecond = amountPerSecond;
    }
    if (targetPoint === null) {
      movement.targetPoint = null;
    } else if (movement.targetPoint === null) {
      movement.targetPoint = {
        x: targetPoint.x,
        y: targetPoint.y,
        z: targetPoint.z,
        radius: targetPoint.radius,
      };
    } else {
      movement.targetPoint.x = targetPoint.x;
      movement.targetPoint.y = targetPoint.y;
      movement.targetPoint.z = targetPoint.z;
      movement.targetPoint.radius = targetPoint.radius;
    }
    this.workMovements.push(movement);
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
    if (entity.type === 'building') {
      this.buildingVersion++;
      if (entity.body === null) this.pendingBuildingBodySpawns.push(entity);
    }
    if (entity.type === 'unit' || entity.type === 'building') {
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
    if (entity !== undefined && (entity.type === 'building')) this.buildingVersion++;
    if (entity !== undefined && (entity.type === 'unit' || entity.type === 'building')) {
      this.removedSnapshotEntities.push({
        id,
        playerId: entity.ownership !== null ? entity.ownership.playerId : null,
        x: entity.transform.x,
        y: entity.transform.y,
        type: entity.type,
      });
    }
    this.pendingDeathCheckIds.delete(id);
    this.snapshotDirtyFieldsById.delete(id);
    this.unfundedBuildSeconds.delete(id);
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
    if (!entity || (entity.type !== 'unit' && entity.type !== 'building')) return;
    this.refreshEntitySlotState(entity, fields);
    this.enqueueSnapshotDirty(id, fields);
  }

  /** Enqueue snapshot dirtiness after the caller has already updated
   *  EntitySlotRegistry/entity-state hot columns for this entity. */
  markSnapshotDirtyStateSynced(entity: Entity, fields: number): void {
    if (fields === 0) return;
    if (this.entities.get(entity.id) !== entity) return;
    if (entity.type !== 'unit' && entity.type !== 'building') return;
    this.enqueueSnapshotDirty(entity.id, fields);
  }

  private enqueueSnapshotDirty(id: EntityId, fields: number): void {
    if (fields & ENTITY_CHANGED_HP) this.pendingDeathCheckIds.add(id);
    const previousFields = this.snapshotDirtyFieldsById.get(id) ?? 0;
    if (previousFields === 0) this.snapshotDirtyIds.push(id);
    this.snapshotDirtyFieldsById.set(id, previousFields | fields);
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
        this.snapshotDirtyFieldsById.delete(this.snapshotDirtyIds[i]);
      }
      this.snapshotDirtyIds.length = 0;
      return;
    }
    this.snapshotDirtyIds.sort((a, b) => a - b);
    for (let i = 0; i < this.snapshotDirtyIds.length; i++) {
      const id = this.snapshotDirtyIds[i];
      const fields = this.snapshotDirtyFieldsById.get(id) ?? 0;
      if (fields === 0) continue;
      outIds.push(id);
      outFields.push(fields);
      if (outSlots !== undefined) outSlots.push(entitySlotRegistry.getSlot(id));
      this.snapshotDirtyFieldsById.delete(id);
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

  getSupportSurfaceEntities(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getSupportSurfaceEntities();
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

  // Get units running a FIELD barrier (cached - DO NOT MODIFY returned array)
  getShieldUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getShieldUnits();
  }

  /** Every host carrying any shield emission — field barriers AND flat
   *  mirror panels. The powered-equipment pass walks this list so both
   *  shapes of the one force material answer to the same Shield
   *  Generator gate. (cached - DO NOT MODIFY returned array) */
  getShieldEquipmentUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getShieldEquipmentUnits();
  }

  getCommanderUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getCommanderUnits();
  }

  getBuilderUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getBuilderUnits();
  }

  getCruisingUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getCruisingUnits();
  }

  getCruisingUnitSlots(): readonly number[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getCruisingUnitSlots();
  }

  /** Every entity that carries a CombatComponent with at least one
   *  attack emitter. Includes both armed units and armed
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

  // Transport-capable units (superset predicate: entity.transport present).
  getTransportUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getTransportUnits();
  }

  // Entities still carrying a live buildable (nanoframes). Completion nulls
  // the component; the construction lifecycle prunes stale rows lazily via
  // pruneIncompleteBuildable, so only the sim-side walk may rely on this.
  getIncompleteBuildableUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getIncompleteBuildableUnits();
  }

  getIncompleteBuildableBuildings(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getIncompleteBuildableBuildings();
  }

  pruneIncompleteBuildable(entity: Entity): void {
    this.cache.pruneIncompleteBuildable(entity);
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
          (e.type === 'unit' || e.type === 'building')) {
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

  /** True while the player's ALLY TEAM owns at least one COMPLETED, alive,
   *  and OPEN building of the given blueprint.
   *
   *  Team-wide, like radar and sight: a tech structure is an installation the
   *  side runs, not a private one, and an ally standing next to your Shield
   *  Detection Lab can obviously see what it sees. Derived state: recomputed
   *  from the per-player building caches on every read, so completion,
   *  destruction, capture, and ON/OFF toggling all take effect the same tick
   *  without extra bookkeeping. The open requirement follows the powered-
   *  channel rule (BAR's on/offable Targeting Facility): a fortified or
   *  switched-off building grants nothing; buildings without an active-state
   *  mechanic count whenever completed. */
  teamHasCompletedBuilding(
    playerId: PlayerId,
    buildingBlueprintId: BuildingBlueprintId,
  ): boolean {
    if (this.playerHasCompletedBuilding(playerId, buildingBlueprintId)) return true;
    for (const allyId of this.getAllies(playerId)) {
      if (this.playerHasCompletedBuilding(allyId, buildingBlueprintId)) return true;
    }
    return false;
  }

  /** The single-seat half of teamHasCompletedBuilding. */
  playerHasCompletedBuilding(
    playerId: PlayerId,
    buildingBlueprintId: BuildingBlueprintId,
  ): boolean {
    const buildings = this.getBuildingsByPlayer(playerId);
    for (const building of buildings) {
      if (
        building.buildingBlueprintId !== buildingBlueprintId
        || !isEntityActive(building)
      ) {
        continue;
      }
      const activeState = building.building?.activeState ?? null;
      if (activeState !== null && !activeState.open) continue;
      return true;
    }
    return false;
  }

  /** The shield-aware targeting upgrade: granted while the player owns a
   *  completed Shield-Aware Targeting Tech building. Their turrets then
   *  reject locks whose line of sight crosses active force material. */
  playerHasShieldAwareTargeting(playerId: PlayerId): boolean {
    return this.teamHasCompletedBuilding(playerId, 'buildingShieldTargetingTech');
  }

  /** Shield power: every shield the team owns is raised while at least one
   *  Shield Generator on that team is completed and switched ON, and every one
   *  of them drops the moment the last generator goes dark. Nothing is gated at
   *  order time — shield-bearing units build freely and simply stand unshielded
   *  until their side has power. */
  playerHasShieldPower(playerId: PlayerId): boolean {
    return this.teamHasCompletedBuilding(playerId, 'buildingShieldTech');
  }

  /** Bitmask of players whose TEAM holds a completed building of the given
   *  blueprint, using the Rust targeting pool's player-bit convention
   *  (`combat_targeting_player_bit`): bit `playerId - 1`; ids outside
   *  [1, 31] carry no bit. Every seat on a side that owns one carries the
   *  bit, so the kernels need no notion of alliance to honour a team-wide
   *  installation. */
  getCompletedBuildingPlayerMask(buildingBlueprintId: BuildingBlueprintId): number {
    let mask = 0;
    const playerIds = this.teamRoster.playerIds;
    for (let i = 0; i < playerIds.length; i++) {
      const playerId = playerIds[i];
      if (playerId < 1 || playerId > 31) continue;
      if (this.teamHasCompletedBuilding(playerId, buildingBlueprintId)) {
        mask |= 1 << (playerId - 1);
      }
    }
    return mask >>> 0;
  }

  /** Per-player shield-aware targeting bits for the Rust batch kernel and
   *  snapshot meta. */
  getShieldAwareTargetingPlayerMask(): number {
    return this.getCompletedBuildingPlayerMask('buildingShieldTargetingTech');
  }

  /** Per-player shield-power bits. The shield update resolves this ONCE per
   *  tick and tests bits per shield host: the underlying scan walks every
   *  building each player owns, which is not something a per-host call can
   *  afford. Also carried in snapshot meta for the BATTLE bar readout. */
  getShieldPowerPlayerMask(): number {
    return this.getCompletedBuildingPlayerMask('buildingShieldTech');
  }

  /** The precision-fire upgrade: granted while the player owns a completed,
   *  switched-ON Precision Targeting Research Lab. Every authored firing
   *  randomness knob — aim spread cones, cooldown duration variance, beam
   *  pulse on/off variance — is then treated as zero for that player's
   *  turrets, so they fire exactly on their authored line and cadence. */
  playerHasPrecisionTargeting(playerId: PlayerId): boolean {
    return this.teamHasCompletedBuilding(playerId, 'buildingPrecisionTargetingTech');
  }

  /** Per-player precision-fire bits. The firing paths resolve this ONCE per
   *  tick and test bits per shot: the underlying scan walks every building the
   *  player owns, which is not something a per-shot call can afford. */
  getPrecisionTargetingPlayerMask(): number {
    return this.getCompletedBuildingPlayerMask('buildingPrecisionTargetingTech');
  }

  /** Install the roster and rebuild the alliance sets from it. This is the
   *  ONLY way alliances should be established: an ally team is the source
   *  of truth and `alliesByPlayer` is its cache, so the two cannot drift
   *  into a state where A is allied to B but B is on another side. */
  setTeamRoster(roster: TeamRoster): void {
    this.teamRoster = roster;
    this.alliesByPlayer = buildAlliesByPlayer(roster);
  }

  /** Number of sides in the match. Terrain dividers carve one slice each. */
  getAllyTeamCount(): number {
    return this.teamRoster.allyTeamIds.length;
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
    // Transform.z is the building's vertical CENTER. A newly created
    // building is normal/non-hovering, so its base sits on the solid terrain
    // bed even underwater. Blueprint application may mark it hovering; the
    // construction path then replaces this baseline with the visible
    // terrain/water surface plus the hovering building's placement policy.
    const baseZ = this.getTerrainBedZ(x, y);
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
        hoveringType: null,
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

  // Create a beam projectile. Beams are line
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
    projectileType: 'beam' = 'beam',
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
