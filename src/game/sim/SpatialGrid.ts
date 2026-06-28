import type { Entity, EntityId, PlayerId } from './types';
import { LAND_CELL_SIZE } from '../../config';
import {
  CANONICAL_LAND_CELL_SIZE,
  assertCanonicalLandCellSize,
} from '../landGrid';
import { TERRAIN_MAX_RENDER_Y, TILE_FLOOR_Y } from './terrain/terrainConfig';
import {
  getSimWasm,
  type SpatialApi,
} from '../sim-wasm/init';
import { entitySlotRegistry } from './EntitySlotRegistry';
import { projectileTypeToCode } from '../../types/network';

// Phase 7: the SpatialGrid lives in WASM linear memory. This file is
// now a thin JS-side wrapper that:
//   - delegates EntityId ↔ slot mapping to EntitySlotRegistry, which
//     also populates the canonical entity-state slab;
//   - exposes the same public API as the previous JS-only grid so no
//     caller is touched;
//   - reuses result arrays (queryResultUnits / Buildings / Projectiles
//     / All) so callers don't see new allocations.
//
// The reusable-result-array contract is preserved: callers must fully
// consume the result of one query before calling another, because the
// underlying WASM scratch buffer is re-written on every query call
// and the JS-side reusable arrays are overwritten in tandem.

// LOS query default — matches MAX_UNIT_SHOT_RADIUS in the Rust impl.
// Used implicitly by enemy-entities queries; JS-side wrapper passes
// raw radius and Rust adds the pad.

// Default Z band for ground-plane queries.
const DEFAULT_CIRCLE_Z_MIN = TILE_FLOOR_Y;

class SpatialGrid {
  private cellSize: number;

  // Reusable result arrays. Match the original contract: callers
  // must consume before issuing another query.
  private readonly queryResultUnits: Entity[] = [];
  private readonly queryResultBuildings: Entity[] = [];
  private readonly queryResultProjectiles: Entity[] = [];
  private readonly queryResultAll: Entity[] = [];

  private readonly _unitsAndProjResult: { units: Entity[]; projectiles: Entity[] } = {
    units: [], projectiles: [],
  };
  private readonly _unitsAndBuildingsResult: { units: Entity[]; buildings: Entity[] } = {
    units: [], buildings: [],
  };
  private readonly _queryResultUnitSlots: number[] = [];
  private readonly _queryResultBuildingSlots: number[] = [];
  private readonly _unitsAndBuildingsSlotsResult: {
    units: Entity[];
    buildings: Entity[];
    unitSlots: number[];
    buildingSlots: number[];
  } = {
    units: [],
    buildings: [],
    unitSlots: [],
    buildingSlots: [],
  };
  private readonly _rectResult: { units: Entity[]; buildings: Entity[] } = {
    units: [], buildings: [],
  };
  private readonly _slotQueryResult: { slots: Uint32Array; count: number } = {
    slots: new Uint32Array(0),
    count: 0,
  };

  private _projectileBatchCapacity = 0;
  private _projectileBatchSlots = new Uint32Array(0);
  private _projectileBatchX = new Float64Array(0);
  private _projectileBatchY = new Float64Array(0);
  private _projectileBatchZ = new Float64Array(0);
  private _projectileBatchVx = new Float64Array(0);
  private _projectileBatchVy = new Float64Array(0);
  private _projectileBatchVz = new Float64Array(0);
  private _projectileBatchHp = new Float64Array(0);
  private _projectileBatchMaxHp = new Float64Array(0);
  private _projectileBatchFlags = new Uint32Array(0);
  private _projectileBatchOwnerPlayerU32 = new Uint32Array(0);
  private _projectileBatchTypeCodes = new Uint32Array(0);
  private _projectileBatchOwnerPlayers = new Uint8Array(0);
  private _projectileBatchTypeFlags = new Uint8Array(0);
  private _projectileBatchRadiusCollision = new Float64Array(0);
  private _projectileBatchRadiusHitbox = new Float64Array(0);

  // Cached typed-array view over the WASM per-query scratch buffer
  // (Rust `scratch_u32: Vec<u32>`). Rebuilt only when the view goes
  // stale, which happens two ways: WASM linear memory grew (the old
  // ArrayBuffer detaches and `sim.memory.buffer` identity changes —
  // the same event PhysicsEngine3D tracks for refreshViews), or the
  // scratch Vec reallocated to a larger capacity (its data pointer
  // moves). Length is grown monotonically to the largest query seen,
  // so after warmup every query reuses the same view with no
  // allocation.
  private _scratchView: Uint32Array | null = null;
  private _scratchBuffer: ArrayBuffer | null = null;
  private _scratchPtr: number = -1;

  constructor(cellSize: number = LAND_CELL_SIZE) {
    assertCanonicalLandCellSize('SpatialGrid cell size', cellSize);
    this.cellSize = CANONICAL_LAND_CELL_SIZE;
    // The WASM-side spatial_init is called inside initSimWasm, so by
    // the time any mutation/query method on this wrapper fires, the
    // Rust grid is ready. GameServer.create awaits initSimWasm before
    // any entity is created, so the no-await constructor here is
    // safe.
  }

  private api(): SpatialApi {
    return getSimWasm()!.spatial;
  }

  private ensureProjectileBatchCapacity(required: number): void {
    if (required <= this._projectileBatchCapacity) return;
    let cap = Math.max(32, this._projectileBatchCapacity);
    while (cap < required) cap *= 2;

    const slots = new Uint32Array(cap);
    slots.set(this._projectileBatchSlots);
    this._projectileBatchSlots = slots;

    const xs = new Float64Array(cap);
    xs.set(this._projectileBatchX);
    this._projectileBatchX = xs;

    const ys = new Float64Array(cap);
    ys.set(this._projectileBatchY);
    this._projectileBatchY = ys;

    const zs = new Float64Array(cap);
    zs.set(this._projectileBatchZ);
    this._projectileBatchZ = zs;

    const vxs = new Float64Array(cap);
    vxs.set(this._projectileBatchVx);
    this._projectileBatchVx = vxs;

    const vys = new Float64Array(cap);
    vys.set(this._projectileBatchVy);
    this._projectileBatchVy = vys;

    const vzs = new Float64Array(cap);
    vzs.set(this._projectileBatchVz);
    this._projectileBatchVz = vzs;

    const hps = new Float64Array(cap);
    hps.set(this._projectileBatchHp);
    this._projectileBatchHp = hps;

    const maxHps = new Float64Array(cap);
    maxHps.set(this._projectileBatchMaxHp);
    this._projectileBatchMaxHp = maxHps;

    const stateFlags = new Uint32Array(cap);
    stateFlags.set(this._projectileBatchFlags);
    this._projectileBatchFlags = stateFlags;

    const ownerU32 = new Uint32Array(cap);
    ownerU32.set(this._projectileBatchOwnerPlayerU32);
    this._projectileBatchOwnerPlayerU32 = ownerU32;

    const typeCodes = new Uint32Array(cap);
    typeCodes.set(this._projectileBatchTypeCodes);
    this._projectileBatchTypeCodes = typeCodes;

    const owners = new Uint8Array(cap);
    owners.set(this._projectileBatchOwnerPlayers);
    this._projectileBatchOwnerPlayers = owners;

    const flags = new Uint8Array(cap);
    flags.set(this._projectileBatchTypeFlags);
    this._projectileBatchTypeFlags = flags;

    const radiusCollision = new Float64Array(cap);
    radiusCollision.set(this._projectileBatchRadiusCollision);
    this._projectileBatchRadiusCollision = radiusCollision;

    const radiusHitbox = new Float64Array(cap);
    radiusHitbox.set(this._projectileBatchRadiusHitbox);
    this._projectileBatchRadiusHitbox = radiusHitbox;

    this._projectileBatchCapacity = cap;
  }

  /** Returns the WASM-pool slot for an entity, or -1 if the entity
   *  is not currently tracked by the grid. Used by other systems
   *  (entity-state, turret-pool) that share the slot space. */
  getSlot(entityId: EntityId): number {
    return entitySlotRegistry.getSlot(entityId);
  }

  getEntitySlot(entity: Entity): number {
    return entitySlotRegistry.getEntitySlot(entity);
  }

  /** Resolve a Rust spatial slot back to the live JS entity wrapper.
   *  Projectile collision kernels return slots so callers can avoid
   *  copying candidate id arrays back through another spatial query. */
  resolveSlot(slot: number): Entity | undefined {
    return entitySlotRegistry.resolveSlot(slot);
  }

  clear(): void {
    entitySlotRegistry.clear();
  }

  // ===================== Mutations =====================

  updateUnit(entity: Entity): void {
    entitySlotRegistry.setUnit(entity);
  }

  removeUnit(id: EntityId): void {
    entitySlotRegistry.removeUnit(id);
  }

  updateProjectile(entity: Entity): void {
    entitySlotRegistry.setProjectile(entity);
  }

  updateProjectiles(entities: readonly Entity[]): void {
    let count = 0;
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      const projectile = entity.projectile;
      if (!projectile) continue;

      this.ensureProjectileBatchCapacity(count + 1);
      const slot = entitySlotRegistry.bindProjectileForBatch(entity);
      if (slot < 0) continue;

      this._projectileBatchSlots[count] = slot;
      this._projectileBatchX[count] = entity.transform.x;
      this._projectileBatchY[count] = entity.transform.y;
      this._projectileBatchZ[count] = entity.transform.z;
      this._projectileBatchVx[count] = projectile.velocityX;
      this._projectileBatchVy[count] = projectile.velocityY;
      this._projectileBatchVz[count] = projectile.velocityZ;
      this._projectileBatchHp[count] = projectile.hp;
      this._projectileBatchMaxHp[count] = projectile.maxHp;
      this._projectileBatchFlags[count] = entitySlotRegistry.projectileHotFlags(entity);
      this._projectileBatchOwnerPlayerU32[count] = projectile.ownerId ?? 0;
      this._projectileBatchTypeCodes[count] = projectileTypeToCode(projectile.projectileType);
      this._projectileBatchOwnerPlayers[count] = projectile.ownerId ?? 0;
      this._projectileBatchTypeFlags[count] = projectile.projectileType === 'projectile' ? 1 : 0;
      this._projectileBatchRadiusCollision[count] =
        projectile.config.shotProfile.runtime.radius.collision;
      this._projectileBatchRadiusHitbox[count] =
        projectile.config.shotProfile.runtime.radius.hitbox;
      count++;
    }

    if (count === 0) return;
    const updated = this.api().setProjectilesBatch(
      count,
      this._projectileBatchSlots.subarray(0, count),
      this._projectileBatchX.subarray(0, count),
      this._projectileBatchY.subarray(0, count),
      this._projectileBatchZ.subarray(0, count),
      this._projectileBatchOwnerPlayers.subarray(0, count),
      this._projectileBatchTypeFlags.subarray(0, count),
      this._projectileBatchRadiusCollision.subarray(0, count),
      this._projectileBatchRadiusHitbox.subarray(0, count),
    );
    if (updated !== count) {
      throw new Error(`SpatialGrid.updateProjectiles: batch updated ${updated}/${count} projectiles`);
    }
    const stateUpdated = entitySlotRegistry.setProjectilesHotBatch(
      count,
      this._projectileBatchSlots.subarray(0, count),
      this._projectileBatchX.subarray(0, count),
      this._projectileBatchY.subarray(0, count),
      this._projectileBatchZ.subarray(0, count),
      this._projectileBatchVx.subarray(0, count),
      this._projectileBatchVy.subarray(0, count),
      this._projectileBatchVz.subarray(0, count),
      this._projectileBatchHp.subarray(0, count),
      this._projectileBatchMaxHp.subarray(0, count),
      this._projectileBatchFlags.subarray(0, count),
      this._projectileBatchOwnerPlayerU32.subarray(0, count),
      this._projectileBatchTypeCodes.subarray(0, count),
      this._projectileBatchRadiusCollision.subarray(0, count),
      this._projectileBatchRadiusHitbox.subarray(0, count),
    );
    if (stateUpdated !== count) {
      throw new Error(`SpatialGrid.updateProjectiles: entity-state batch updated ${stateUpdated}/${count} projectiles`);
    }
  }

  removeProjectile(id: EntityId): void {
    entitySlotRegistry.removeProjectile(id);
  }

  addBuilding(entity: Entity): void {
    entitySlotRegistry.setBuilding(entity);
  }

  removeBuilding(id: EntityId): void {
    entitySlotRegistry.removeBuilding(id);
  }

  removeEntity(id: EntityId): void {
    entitySlotRegistry.unsetEntity(id);
  }

  // ===================== Result readback helpers =====================

  /** A Uint32Array view over the WASM scratch buffer that covers at
   *  least the first `count` elements written by the just-completed
   *  query. The returned view may be longer than `count` (it is sized
   *  to the largest query seen so far); callers must only read indices
   *  in `[0, count)`. The view is invalidated by the next query call —
   *  consume immediately. */
  private scratch(count: number): Uint32Array {
    const sim = getSimWasm()!;
    const buffer = sim.memory.buffer;
    const ptr = sim.spatial.scratchPtr();
    const view = this._scratchView;
    if (
      view === null ||
      this._scratchBuffer !== buffer ||
      this._scratchPtr !== ptr ||
      count > view.length
    ) {
      const len = view !== null && view.length > count ? view.length : count;
      const next = new Uint32Array(buffer, ptr, len);
      this._scratchView = next;
      this._scratchBuffer = buffer;
      this._scratchPtr = ptr;
      return next;
    }
    return view;
  }

  private resolveSlotsRange(slots: Uint32Array, start: number, end: number, out: Entity[]): void {
    out.length = 0;
    for (let i = start; i < end; i++) {
      const e = entitySlotRegistry.resolveSlot(slots[i]);
      if (e) out.push(e);
    }
  }

  private resolveSlotsRangeWithSlots(
    slots: Uint32Array,
    start: number,
    end: number,
    outEntities: Entity[],
    outSlots: number[],
  ): void {
    outEntities.length = 0;
    outSlots.length = 0;
    for (let i = start; i < end; i++) {
      const slot = slots[i];
      const e = entitySlotRegistry.resolveSlot(slot);
      if (!e) continue;
      outEntities.push(e);
      outSlots.push(slot);
    }
  }

  // ===================== Queries =====================

  queryUnitsInRadius(x: number, y: number, z: number, radius: number): Entity[] {
    const count = this.api().queryUnitsInRadius(x, y, z, radius, 0, 0);
    this.resolveSlotsRange(this.scratch(count), 0, count, this.queryResultUnits);
    return this.queryResultUnits;
  }

  queryBuildingsInRadius(x: number, y: number, z: number, radius: number): Entity[] {
    const count = this.api().queryBuildingsInRadius(x, y, z, radius, 0, 0);
    this.resolveSlotsRange(this.scratch(count), 0, count, this.queryResultBuildings);
    return this.queryResultBuildings;
  }

  queryUnitsAndBuildingsInRadius(
    x: number, y: number, z: number, radius: number,
  ): { units: Entity[]; buildings: Entity[] } {
    const total = this.api().queryUnitsAndBuildingsInRadius(x, y, z, radius);
    const slots = this.scratch(total);
    const nUnits = slots[0];
    const nBuildings = slots[1];
    this.resolveSlotsRange(slots, 2, 2 + nUnits, this.queryResultUnits);
    this.resolveSlotsRange(slots, 2 + nUnits, 2 + nUnits + nBuildings, this.queryResultBuildings);
    this._unitsAndBuildingsResult.units = this.queryResultUnits;
    this._unitsAndBuildingsResult.buildings = this.queryResultBuildings;
    return this._unitsAndBuildingsResult;
  }

  queryUnitsAndBuildingsSlotsInRadius(
    x: number, y: number, z: number, radius: number,
  ): { units: Entity[]; buildings: Entity[]; unitSlots: number[]; buildingSlots: number[] } {
    const total = this.api().queryUnitsAndBuildingsInRadius(x, y, z, radius);
    const slots = this.scratch(total);
    const nUnits = slots[0];
    const nBuildings = slots[1];
    this.resolveSlotsRangeWithSlots(
      slots,
      2,
      2 + nUnits,
      this.queryResultUnits,
      this._queryResultUnitSlots,
    );
    this.resolveSlotsRangeWithSlots(
      slots,
      2 + nUnits,
      2 + nUnits + nBuildings,
      this.queryResultBuildings,
      this._queryResultBuildingSlots,
    );
    this._unitsAndBuildingsSlotsResult.units = this.queryResultUnits;
    this._unitsAndBuildingsSlotsResult.buildings = this.queryResultBuildings;
    this._unitsAndBuildingsSlotsResult.unitSlots = this._queryResultUnitSlots;
    this._unitsAndBuildingsSlotsResult.buildingSlots = this._queryResultBuildingSlots;
    return this._unitsAndBuildingsSlotsResult;
  }

  queryUnitsAndBuildingsInRect2D(
    minX: number, maxX: number, minY: number, maxY: number,
  ): { units: Entity[]; buildings: Entity[] } {
    const total = this.api().queryUnitsAndBuildingsInRect2D(minX, maxX, minY, maxY);
    const slots = this.scratch(total);
    const nUnits = slots[0];
    const nBuildings = slots[1];
    this.resolveSlotsRange(slots, 2, 2 + nUnits, this._rectResult.units);
    this.resolveSlotsRange(slots, 2 + nUnits, 2 + nUnits + nBuildings, this._rectResult.buildings);
    return this._rectResult;
  }

  queryEnemyUnitsInRadius(x: number, y: number, z: number, radius: number, excludePlayerId: PlayerId): Entity[] {
    const count = this.api().queryEnemyUnitsInRadius(x, y, z, radius, excludePlayerId);
    this.resolveSlotsRange(this.scratch(count), 0, count, this.queryResultUnits);
    return this.queryResultUnits;
  }

  queryEnemyProjectilesInRadius(x: number, y: number, z: number, radius: number, excludePlayerId: PlayerId): Entity[] {
    const count = this.api().queryEnemyProjectilesInRadius(x, y, z, radius, excludePlayerId);
    this.resolveSlotsRange(this.scratch(count), 0, count, this.queryResultProjectiles);
    return this.queryResultProjectiles;
  }

  queryEnemyUnitsAndProjectilesInRadius(
    x: number, y: number, z: number, radius: number, excludePlayerId: PlayerId,
  ): { units: Entity[]; projectiles: Entity[] } {
    const total = this.api().queryEnemyUnitsAndProjectilesInRadius(x, y, z, radius, excludePlayerId);
    const slots = this.scratch(total);
    const nUnits = slots[0];
    const nProjectiles = slots[1];
    this.resolveSlotsRange(slots, 2, 2 + nUnits, this.queryResultUnits);
    this.resolveSlotsRange(slots, 2 + nUnits, 2 + nUnits + nProjectiles, this.queryResultProjectiles);
    this._unitsAndProjResult.units = this.queryResultUnits;
    this._unitsAndProjResult.projectiles = this.queryResultProjectiles;
    return this._unitsAndProjResult;
  }

  queryEnemyEntitiesInRadius(x: number, y: number, z: number, radius: number, excludePlayerId: PlayerId): Entity[] {
    const total = this.api().queryEnemyEntitiesInRadius(x, y, z, radius, excludePlayerId);
    const slots = this.scratch(total);
    const nUnits = slots[0];
    const nBuildings = slots[1];
    // Concatenate units + buildings into queryResultAll to match the
    // original behaviour of the JS impl which pushed both into the
    // same result array.
    this.queryResultAll.length = 0;
    for (let i = 2; i < 2 + nUnits + nBuildings; i++) {
      const e = entitySlotRegistry.resolveSlot(slots[i]);
      if (e) this.queryResultAll.push(e);
    }
    return this.queryResultAll;
  }

  queryEnemyEntitiesInCircle2D(
    x: number, y: number, radius: number, excludePlayerId: PlayerId,
    zMin: number = DEFAULT_CIRCLE_Z_MIN - this.cellSize,
    zMax: number = TERRAIN_MAX_RENDER_Y + this.cellSize * 2,
  ): Entity[] {
    const total = this.api().queryEnemyEntitiesInCircle2D(x, y, radius, excludePlayerId, zMin, zMax);
    const slots = this.scratch(total);
    const nUnits = slots[0];
    const nBuildings = slots[1];
    this.queryResultAll.length = 0;
    for (let i = 2; i < 2 + nUnits + nBuildings; i++) {
      const e = entitySlotRegistry.resolveSlot(slots[i]);
      if (e) this.queryResultAll.push(e);
    }
    return this.queryResultAll;
  }

  queryUnitsAlongLine(
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    lineWidth: number,
  ): Entity[] {
    const count = this.api().queryUnitsAlongLine(x1, y1, z1, x2, y2, z2, lineWidth);
    this.resolveSlotsRange(this.scratch(count), 0, count, this.queryResultUnits);
    return this.queryResultUnits;
  }

  queryUnitSlotsAlongLine(
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    lineWidth: number,
  ): { slots: Uint32Array; count: number } {
    const count = this.api().queryUnitsAlongLine(x1, y1, z1, x2, y2, z2, lineWidth);
    this._slotQueryResult.slots = this.scratch(count);
    this._slotQueryResult.count = count;
    return this._slotQueryResult;
  }

  queryBuildingsAlongLine(
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    lineWidth: number,
  ): Entity[] {
    const count = this.api().queryBuildingsAlongLine(x1, y1, z1, x2, y2, z2, lineWidth);
    this.resolveSlotsRange(this.scratch(count), 0, count, this.queryResultBuildings);
    return this.queryResultBuildings;
  }

  queryBuildingSlotsAlongLine(
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    lineWidth: number,
  ): { slots: Uint32Array; count: number } {
    const count = this.api().queryBuildingsAlongLine(x1, y1, z1, x2, y2, z2, lineWidth);
    this._slotQueryResult.slots = this.scratch(count);
    this._slotQueryResult.count = count;
    return this._slotQueryResult;
  }

  queryProjectilesAlongLine(
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    lineWidth: number,
  ): Entity[] {
    const count = this.api().queryProjectilesAlongLine(x1, y1, z1, x2, y2, z2, lineWidth);
    this.resolveSlotsRange(this.scratch(count), 0, count, this.queryResultProjectiles);
    return this.queryResultProjectiles;
  }

  queryProjectileSlotsAlongLine(
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    lineWidth: number,
  ): { slots: Uint32Array; count: number } {
    const count = this.api().queryProjectilesAlongLine(x1, y1, z1, x2, y2, z2, lineWidth);
    this._slotQueryResult.slots = this.scratch(count);
    this._slotQueryResult.count = count;
    return this._slotQueryResult;
  }

  queryEntitiesAlongLine(
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    lineWidth: number,
  ): { units: Entity[]; buildings: Entity[] } {
    const total = this.api().queryEntitiesAlongLine(x1, y1, z1, x2, y2, z2, lineWidth);
    const slots = this.scratch(total);
    const nUnits = slots[0];
    const nBuildings = slots[1];
    this.resolveSlotsRange(slots, 2, 2 + nUnits, this.queryResultUnits);
    this.resolveSlotsRange(slots, 2 + nUnits, 2 + nUnits + nBuildings, this.queryResultBuildings);
    this._unitsAndBuildingsResult.units = this.queryResultUnits;
    this._unitsAndBuildingsResult.buildings = this.queryResultBuildings;
    return this._unitsAndBuildingsResult;
  }

  queryEntitySlotsAlongLine(
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    lineWidth: number,
  ): { units: Entity[]; buildings: Entity[]; unitSlots: number[]; buildingSlots: number[] } {
    const total = this.api().queryEntitiesAlongLine(x1, y1, z1, x2, y2, z2, lineWidth);
    const slots = this.scratch(total);
    const nUnits = slots[0];
    const nBuildings = slots[1];
    this.resolveSlotsRangeWithSlots(
      slots,
      2,
      2 + nUnits,
      this.queryResultUnits,
      this._queryResultUnitSlots,
    );
    this.resolveSlotsRangeWithSlots(
      slots,
      2 + nUnits,
      2 + nUnits + nBuildings,
      this.queryResultBuildings,
      this._queryResultBuildingSlots,
    );
    this._unitsAndBuildingsSlotsResult.units = this.queryResultUnits;
    this._unitsAndBuildingsSlotsResult.buildings = this.queryResultBuildings;
    this._unitsAndBuildingsSlotsResult.unitSlots = this._queryResultUnitSlots;
    this._unitsAndBuildingsSlotsResult.buildingSlots = this._queryResultBuildingSlots;
    return this._unitsAndBuildingsSlotsResult;
  }

  // ===================== Debug =====================

  getCellSize(): number {
    return this.cellSize;
  }

  /** Per-cell unique-player debug listing. Reusable array; do not
   *  store the reference. */
  getOccupiedCells(): { cell: { x: number; y: number; z: number }; players: number[] }[] {
    const total = this.api().queryOccupiedCellsDebug();
    const slots = this.scratch(total);
    const result: { cell: { x: number; y: number; z: number }; players: number[] }[] = [];
    if (total === 0) return result;
    const nCells = slots[0];
    let read = 1;
    for (let i = 0; i < nCells; i++) {
      const cx = slots[read++] | 0;
      const cy = slots[read++] | 0;
      const cz = slots[read++] | 0;
      const nPlayers = slots[read++];
      const players: number[] = [];
      for (let p = 0; p < nPlayers; p++) {
        players.push(slots[read++]);
      }
      result.push({ cell: { x: cx, y: cy, z: cz }, players });
    }
    return result;
  }
}

// Singleton instance for the game
export const spatialGrid = new SpatialGrid();
