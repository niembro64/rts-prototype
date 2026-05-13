import type { Entity, EntityId, EntityType, PlayerId, TurretConfig, Projectile, ProjectileConfig, ProjectileType, ProjectileShot, UnitLocomotion } from './types';
import type { MetalDeposit } from '../../metalDepositConfig';
import type { ShotId, TurretId } from '../../types/blueprintIds';
import { EntityCacheManager } from './EntityCacheManager';
import { getUnitBlueprint, getUnitLocomotion } from './blueprints';
import { cloneUnitLocomotion } from './locomotion';
import { createUnitRuntimeTurrets } from './runtimeTurrets';
import {
  MAX_TOTAL_UNITS,
  DEFAULT_MIRRORS_ENABLED,
  DEFAULT_FORCE_FIELDS_ENABLED,
  DEFAULT_FORCE_FIELDS_BLOCK_TARGETING,
  DEFAULT_FORCE_FIELD_REFLECTION_MODE,
  UNIT_HP_MULTIPLIER,
  UNIT_INITIAL_SPAWN_HEIGHT_ABOVE_GROUND,
  LAND_CELL_SIZE,
  DGUN_TERRAIN_FOLLOW_HEIGHT,
} from '../../config';
import type { ForceFieldReflectionMode } from '../../types/shotTypes';
import { getSurfaceHeight, getSurfaceNormal } from './Terrain';
import { buildMirrorPanelCache } from './mirrorPanelCache';
import { dropWeaponsForUnit } from './combat/targetIndex';
import { createProjectileConfigFromTurret } from './projectileConfigs';
import { createUnitSuspension } from './unitSuspension';
import { createUnitJump } from './unitJump';
import { applyEntitySensorBlueprint } from './cloakDetection';
import { ENTITY_CHANGED_HP } from '../../types/network';

const TERRAIN_NORMAL_CACHE_CELL_SIZE = 25;
const EMPTY_PLAYER_SET: ReadonlySet<PlayerId> = new Set();

/** Cell edge length (sim units) for the FOW-11 server-side shroud
 *  bitmaps. Larger = cheaper to update but coarser shroud; smaller =
 *  finer shroud edges but more cells per OR pass. 64 wu gives a
 *  ~64×64 bitmap on a 4096-wu map — small enough that a full keyframe
 *  ships in well under a kilobyte even before bit-packing. */
export const SHROUD_CELL_SIZE = 64;

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
  playerId?: PlayerId;
  x: number;
  y: number;
  type: 'unit' | 'building';
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
  private nextEntityId: EntityId = 1;
  private tick: number = 0;
  private buildingVersion: number = 0;
  private unitSetVersion: number = 0;
  private removedSnapshotEntities: RemovedSnapshotEntity[] = [];
  private snapshotDirtyIds = new Set<EntityId>();
  private snapshotDirtyFields = new Map<EntityId, number>();
  private pendingDeathCheckIds = new Set<EntityId>();
  private surfaceNormalCache = new Map<number, SurfaceNormal>();
  public rng: SeededRNG;

  // Current player being controlled
  public activePlayerId: PlayerId = 1;

  // Number of players in the game (for unit cap calculation)
  public playerCount: number = 2;

  /** Per-player alliance map (issues.txt FOW-06). The set holds the
   *  OTHER players considered allies — a player is implicitly allied
   *  with themselves and that's never listed here. FFA: every set is
   *  empty (or absent), which is the default for a fresh world. Team
   *  play: pairs / triples / etc. of players list each other. The
   *  visibility filter unions all allied players' vision sources, and
   *  the snapshot serializer treats allied entities as friendly for
   *  private-detail / delta-resolution / AOI purposes. Populated at
   *  game start by ServerBootstrap when the lobby has team configuration;
   *  never mutated mid-game (alliances are not currently switchable). */
  public alliesByPlayer: Map<PlayerId, ReadonlySet<PlayerId>> = new Map();

  /** Active temporary vision pulses (issues.txt FOW-14 — Starcraft
   *  scanner sweep / SupCom recon drone). Each pulse contributes a
   *  full-vision source to its owner's team for the ticks between
   *  spawn and expiresAtTick. Simulation prunes expired entries at
   *  the top of every tick; SnapshotVisibility iterates the live
   *  entries during forRecipient() to merge them with the recipient's
   *  durable vision sources. Pulses are scoped to playerId rather
   *  than an entity so a destroyed scan source doesn't truncate the
   *  reveal mid-sweep. */
  public scanPulses: ScanPulse[] = [];

  /** Per-player explored-tile bitmap (issues.txt FOW-11). One
   *  Uint8Array per player, sized shroudGridW × shroudGridH. A cell
   *  byte is 1 once the player (or one of their allies) has ever had
   *  a full-vision source covering it, and stays 1 forever. Server-
   *  authoritative copy; clients receive a snapshot on keyframes and
   *  seed FogOfWarShroudRenderer3D's local bitmap from it so
   *  reconnects, replays, and mid-game joins restore the shroud
   *  state. Updated lazily from updateShroudBitmaps() — the entries
   *  are created on first vision touch, not at construction. */
  public shroudBitmaps: Map<PlayerId, Uint8Array> = new Map();
  /** Per-player monotonic counter bumped by updateShroudBitmaps() each
   *  time at least one new cell flipped 0→1 for that player
   *  (issues.txt FOW-OPT-02). The publisher sums the recipient's and
   *  their allies' counters to derive a single team-version that only
   *  ever increases when the team-merged bitmap has new content;
   *  per-listener "have I shipped this yet?" tracking compares against
   *  this sum to skip resending the full bitmap on every keyframe. */
  public shroudBitmapVersions: Map<PlayerId, number> = new Map();
  /** Bitmask of player ids whose shroud bitmap actively feeds at least
   *  one snapshot listener's team-merged view (issues.txt FOW-OPT-12).
   *  Maintained by GameServer on listener add / remove: each listener
   *  contributes its own player + every ally to the mask. Bit p-1
   *  set ⇒ updateShroudBitmaps runs the OR pass for player p. When
   *  the mask is 0, no listener cares about any team's shroud and the
   *  whole routine no-ops. AI-only / background / spectator-only
   *  sessions hit this fast path naturally. */
  public shroudUpdatePlayerMask: number = 0;
  /** Bitmap cell dimensions for shroudBitmaps. Sized at construction
   *  so a scenario change (different map size) gets the right grid. */
  public readonly shroudGridW: number;
  public readonly shroudGridH: number;

  // Map dimensions
  public readonly mapWidth: number;
  public readonly mapHeight: number;

  // Metal deposits — fixed map features generated at world init.
  // Same list across all clients (deterministic from map size).
  public metalDeposits: MetalDeposit[] = [];

  // Binary deposit-ownership map. Key = depositId, value = the
  // EntityId of the COMPLETED extractor that has claimed this
  // deposit. A deposit is "free" iff not present in the map. Each
  // deposit can be owned by at most one extractor at a time; only
  // the owner produces metal income (and visually spins). When the
  // owner is destroyed, ownership is released and any other completed
  // extractor whose footprint still overlaps the deposit gets
  // promoted to the new owner. See metalDepositOwnership.ts for the
  // claim / release / transfer helpers.
  public depositOwners: Map<number, EntityId> = new Map();

  // Runtime thrust multiplier (set by GameServer based on game/demo mode)
  public thrustMultiplier: number = 8.0;

  // Configurable unit cap (can be changed at runtime via command)
  public maxTotalUnits: number = MAX_TOTAL_UNITS;

  // Whether mirror turrets/panels participate in targeting and reflections
  public mirrorsEnabled: boolean = DEFAULT_MIRRORS_ENABLED;
  // Whether force-field turrets participate in targeting, simulation, and rendering
  public forceFieldsEnabled: boolean = DEFAULT_FORCE_FIELDS_ENABLED;
  // Whether an active force field between a turret and its target blocks
  // lock-on. Symmetric: the field is a physical barrier and applies to
  // every turret in either direction, regardless of team. Future
  // "targeting brain" building upgrades will relax this on a per-player
  // basis (see hasForceFieldClearance options).
  public forceFieldsBlockTargeting: boolean = DEFAULT_FORCE_FIELDS_BLOCK_TARGETING;
  // Which force-field boundary crossings reflect shots/beams.
  public forceFieldReflectionMode: ForceFieldReflectionMode = DEFAULT_FORCE_FIELD_REFLECTION_MODE;
  // Whether player-specific snapshots and the client fog overlay use vision.
  public fogOfWarEnabled: boolean = true;
  /** Optional server-side lifecycle hook. WorldState owns entity
   *  removal, but host-only systems such as physics own external
   *  resources that must be released before the entity disappears. */
  public onEntityRemoving?: (entity: Entity) => void;

  // === CACHED ENTITY ARRAYS (PERFORMANCE CRITICAL) ===
  // Shared cache manager avoids creating new arrays on every getUnits()/getBuildings()/getProjectiles() call
  private cache = new EntityCacheManager();

  // Reusable query result arrays for filtered queries (DO NOT STORE references to these)
  private _queryBuf: Entity[] = [];

  constructor(seed: number = 12345, mapWidth: number = 2000, mapHeight: number = 2000) {
    this.rng = new SeededRNG(seed);
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.shroudGridW = Math.max(1, Math.ceil(mapWidth / SHROUD_CELL_SIZE));
    this.shroudGridH = Math.max(1, Math.ceil(mapHeight / SHROUD_CELL_SIZE));
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
    if (entity.type === 'unit') this.unitSetVersion++;
    if (entity.type === 'building') this.buildingVersion++;
    this.markSnapshotDirty(entity.id, 0xff);
    this.cache.invalidate();
  }

  // Remove entity from world
  removeEntity(id: EntityId): void {
    const entity = this.entities.get(id);
    if (entity) this.onEntityRemoving?.(entity);
    if (entity?.unit) {
      // Drop any inverse-target index entries that referred to this
      // unit's beam weapons before its bookkeeping is gone.
      dropWeaponsForUnit(entity);
    }
    if (entity?.type === 'unit') this.unitSetVersion++;
    if (entity?.type === 'building') this.buildingVersion++;
    if (entity?.type === 'unit' || entity?.type === 'building') {
      this.removedSnapshotEntities.push({
        id,
        playerId: entity.ownership?.playerId,
        x: entity.transform.x,
        y: entity.transform.y,
        type: entity.type,
      });
    }
    this.pendingDeathCheckIds.delete(id);
    this.snapshotDirtyIds.delete(id);
    this.snapshotDirtyFields.delete(id);
    this.entities.delete(id);
    this.cache.invalidate();
  }

  markSnapshotDirty(id: EntityId, fields: number): void {
    if (fields === 0) return;
    const entity = this.entities.get(id);
    if (!entity || (entity.type !== 'unit' && entity.type !== 'building')) return;
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

  getTravelingProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getTravelingProjectiles();
  }

  getLineProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getLineProjectiles();
  }

  // Get units with force field weapons (cached - DO NOT MODIFY returned array)
  getForceFieldUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getForceFieldUnits();
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

  // Get units with mirror panels (cached - DO NOT MODIFY returned array)
  getMirrorUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getMirrorUnits();
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
    for (const e of this.getCommanderUnits()) {
      if (e.ownership?.playerId === playerId) return e;
    }
    return undefined;
  }

  // Get buildings by player — returns reusable array, DO NOT STORE the reference
  getBuildingsByPlayer(playerId: PlayerId): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getBuildingsByPlayer(playerId);
  }

  /** Entities (unit + building) owned by `playerId` that carry a
   *  detector component (issues.txt FOW-OPT-19). Reusable array —
   *  DO NOT STORE the reference. Offline / construction-shell entries
   *  pass through; callers gate on getEntityDetectorRadius which
   *  reads the live entity state. */
  getDetectorsByPlayer(playerId: PlayerId): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getDetectorsByPlayer(playerId);
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

  // Internal shell used only by createUnitFromBlueprint. Public callers
  // must go through blueprints so stats, mounts, locomotion, and body
  // heights cannot drift from the authored unit data.
  private createUnitBase(
    x: number,
    y: number,
    playerId: PlayerId,
    unitType: string,
    radius: { body: number; shot: number; push: number } = { body: 15, shot: 15, push: 15 },
    bodyCenterHeight: number = radius.push,
    locomotion: UnitLocomotion = getUnitLocomotion(unitType),
    mass: number = 25,
    hp: number = 100,
  ): Entity {
    const id = this.generateEntityId();

    // Initial altitude = local terrain + authored body-center height
    // plus the shared spawn lift. The lift is measured at the
    // locomotion ground point, so gravity/terrain spring settle every
    // newly-created unit through the same physics path.
    const groundZ = this.getGroundZ(x, y);
    // Seed the per-unit smoothed normal with the raw normal at the
    // spawn position so the first tick after spawn doesn't snap from
    // the flat default to a tilted slope. The cache lookup also seeds
    // the cell entry for any downstream reader on this tick.
    const spawnNormal = this.getCachedSurfaceNormal(x, y);
    const entity: Entity = {
      id,
      type: 'unit',
      transform: {
        x,
        y,
        z: groundZ + bodyCenterHeight + UNIT_INITIAL_SPAWN_HEIGHT_ABOVE_GROUND,
        rotation: 0,
      },
      selectable: { selected: false },
      ownership: { playerId },
      unit: {
        unitType,
        locomotion: cloneUnitLocomotion(locomotion),
        radius: { ...radius },
        bodyCenterHeight,
        mass,
        hp,
        maxHp: hp,
        actions: [],
        actionHash: 0,
        patrolStartIndex: null,
        mirrorPanels: [],
        mirrorBoundRadius: 0,
        surfaceNormal: { nx: spawnNormal.nx, ny: spawnNormal.ny, nz: spawnNormal.nz },
      },
      // combat is attached by the caller (createUnitFromBlueprint) once
      // it knows the runtime turret list. The base entity has no combat
      // component yet because not every caller wants one.
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
      bp.radius,
      bp.bodyCenterHeight,
      getUnitLocomotion(unitId),
      bp.mass,
      bp.hp * UNIT_HP_MULTIPLIER,
    );
    entity.unit!.jump = createUnitJump(bp.locomotion.physics.jump);
    entity.unit!.suspension = createUnitSuspension(bp.suspension);
    applyEntitySensorBlueprint(entity, bp);

    // Create combat component (turrets + per-host bookkeeping) from
    // blueprint. Every unit blueprint declares at least one turret, so
    // every unit gets a combat component at spawn.
    entity.combat = {
      turrets: createUnitRuntimeTurrets(unitId, bp.radius.body),
      hasActiveCombat: false,
      activeTurretMask: 0,
      firingTurretMask: 0,
    };

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
        constructionRate: bp.builder.constructionRate,
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
    const entity = this.createProjectile(
      x, y, velocityX, velocityY, ownerId, sourceEntityId,
      createProjectileConfigFromTurret(config),
      'projectile',
    );

    // Mark as terrain-following D-gun wave.
    entity.dgunProjectile = {
      isDGun: true,
      terrainFollow: true,
      groundOffset: DGUN_TERRAIN_FOLLOW_HEIGHT,
    };

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
        targetRadius: Math.sqrt(width * width + height * height) / 2,
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
    config: ProjectileConfig,
    projectileType: ProjectileType = 'projectile',
    provenance?: { shotId?: ShotId; sourceTurretId?: TurretId },
  ): Entity {
    const id = this.generateEntityId();

    // Calculate rotation from velocity
    const rotation = Math.atan2(velocityY, velocityX);

    // Static (no-RNG) lifespan from shot type, then apply per-instance
    // variance for projectiles/rockets so each spawn gets a slightly
    // different fuse.
    let maxLifespan = config.shotProfile.runtime.maxLifespan;
    if (config.shotProfile.runtime.isProjectile) {
      const shot = config.shot as ProjectileShot;
      const variance = Math.max(0, shot.lifespanVariance ?? 0);
      if (variance > 0) {
        const factor = 1 + (this.rng.next() * 2 - 1) * variance;
        maxLifespan = Math.max(0, maxLifespan * factor);
      }
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
      shotId: provenance?.shotId ?? config.shot.id,
      sourceTurretId: provenance?.sourceTurretId ?? config.sourceTurretId,
      projectileType,
      velocityX,
      velocityY,
      velocityZ: 0,
      timeAlive: 0,
      maxLifespan,
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
    projectileType: 'beam' | 'laser' = 'beam'
  ): Entity {
    const entity = this.createProjectile(startX, startY, 0, 0, ownerId, sourceEntityId, config, projectileType);
    entity.transform.z = beamZ;

    if (entity.projectile) {
      // Seed a 2-point open-ended polyline (start, authored range end).
      // The per-tick beam handler will overwrite positions and
      // append/remove reflection vertices each re-trace; we own these
      // objects in place so the array reference is stable across the
      // projectile's lifetime.
      entity.projectile.points = [
        { x: startX, y: startY, z: beamZ, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0 },
        { x: endX, y: endY, z: beamZ, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0 },
      ];
      entity.projectile.endpointDamageable = false;
      entity.projectile.segmentLimitReached = false;
    }

    return entity;
  }
}
