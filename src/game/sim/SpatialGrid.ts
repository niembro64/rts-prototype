import type { Entity, EntityId, PlayerId } from './types';
import { LAND_CELL_SIZE } from '../../config';
import {
  CANONICAL_LAND_CELL_SIZE,
  assertCanonicalLandCellSize,
} from '../landGrid';
import { isEntityActive } from './buildableHelpers';
import { TERRAIN_MAX_RENDER_Y, TILE_FLOOR_Y } from './terrain/terrainConfig';
import {
  getSimWasm,
  SPATIAL_KIND_UNIT,
  SPATIAL_KIND_BUILDING,
  SPATIAL_KIND_PROJECTILE,
  type SpatialApi,
} from '../sim-wasm/init';

// Phase 7: the SpatialGrid lives in WASM linear memory. This file is
// now a thin JS-side wrapper that:
//   - owns the EntityId ↔ slot mapping (Map<EntityId, slot>) +
//     reverse table (Entity[] indexed by slot) so query result slot
//     ids can be resolved back to live Entity refs;
//   - exposes the same public API as the previous JS-only grid so no
//     caller is touched;
//   - reuses result arrays (queryResultUnits / Buildings / Projectiles
//     / All) so callers don't see new allocations.
//
// The reusable-result-array contract is preserved: callers must fully
// consume the result of one query before calling another, because the
// underlying WASM scratch buffer is re-written on every query call
// and the JS-side reusable arrays are overwritten in tandem.

export type CaptureCell = { key: number; players: PlayerId[] };

// LOS query default — matches MAX_UNIT_SHOT_RADIUS in the Rust impl.
// Used implicitly by enemy-entities queries; JS-side wrapper passes
// raw radius and Rust adds the pad.

// Default Z band for ground-plane queries.
const DEFAULT_CIRCLE_Z_MIN = TILE_FLOOR_Y;
const DEFAULT_CIRCLE_Z_MAX = TERRAIN_MAX_RENDER_Y;

export class SpatialGrid {
  private cellSize: number;

  // Slot bookkeeping.
  private slotByEntityId: Map<EntityId, number> = new Map();
  private entityBySlot: (Entity | undefined)[] = [];

  // Track which kind each slot was last set to (so removeEntity can
  // dispatch correctly without consulting Rust).
  private kindBySlot: Uint8Array = new Uint8Array(1024);

  // Per-entity tracking flags — match the original JS grid's three
  // separate Maps. Used by removeEntity to pick the right teardown.
  private unitSlots: Set<EntityId> = new Set();
  private buildingSlots: Set<EntityId> = new Set();
  private projectileSlots: Set<EntityId> = new Set();

  // Reusable result arrays. Match the original contract: callers
  // must consume before issuing another query.
  private readonly queryResultUnits: Entity[] = [];
  private readonly queryResultBuildings: Entity[] = [];
  private readonly queryResultProjectiles: Entity[] = [];
  private readonly queryResultAll: Entity[] = [];
  private readonly captureResult: CaptureCell[] = [];

  private readonly _unitsAndProjResult: { units: Entity[]; projectiles: Entity[] } = {
    units: [], projectiles: [],
  };
  private readonly _unitsAndBuildingsResult: { units: Entity[]; buildings: Entity[] } = {
    units: [], buildings: [],
  };
  private readonly _rectResult: { units: Entity[]; buildings: Entity[] } = {
    units: [], buildings: [],
  };

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

  private ensureKindCapacity(slot: number): void {
    if (slot < this.kindBySlot.length) return;
    let cap = this.kindBySlot.length;
    while (cap <= slot) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.kindBySlot);
    this.kindBySlot = next;
  }

  private slotFor(entity: Entity): number {
    let slot = this.slotByEntityId.get(entity.id);
    if (slot === undefined) {
      slot = this.api().allocSlot();
      this.slotByEntityId.set(entity.id, slot);
      if (slot >= this.entityBySlot.length) {
        this.entityBySlot.length = slot + 1;
      }
      this.entityBySlot[slot] = entity;
      this.ensureKindCapacity(slot);
    } else {
      // Re-bind in case the Entity object identity changed across a
      // snapshot apply (defensive — should be stable today).
      this.entityBySlot[slot] = entity;
    }
    return slot;
  }

  private freeEntitySlot(id: EntityId): void {
    const slot = this.slotByEntityId.get(id);
    if (slot === undefined) return;
    this.api().unsetSlot(slot);
    this.api().freeSlot(slot);
    this.slotByEntityId.delete(id);
    this.entityBySlot[slot] = undefined;
    if (slot < this.kindBySlot.length) {
      this.kindBySlot[slot] = 0;
    }
  }

  clear(): void {
    this.api().clear();
    this.slotByEntityId.clear();
    this.entityBySlot.length = 0;
    this.kindBySlot.fill(0);
    this.unitSlots.clear();
    this.buildingSlots.clear();
    this.projectileSlots.clear();
  }

  // ===================== Mutations =====================

  updateUnit(entity: Entity): void {
    if (!entity.unit || entity.unit.hp <= 0) {
      this.removeUnit(entity.id);
      return;
    }
    const slot = this.slotFor(entity);
    this.kindBySlot[slot] = SPATIAL_KIND_UNIT;
    this.unitSlots.add(entity.id);
    this.api().setUnit(
      slot,
      entity.transform.x, entity.transform.y, entity.transform.z,
      entity.unit.radius.push, entity.unit.radius.shot,
      entity.ownership?.playerId ?? 0,
      1,
    );
  }

  removeUnit(id: EntityId): void {
    if (!this.unitSlots.delete(id)) return;
    this.freeEntitySlot(id);
  }

  updateProjectile(entity: Entity): void {
    if (!entity.projectile) return;
    const slot = this.slotFor(entity);
    this.kindBySlot[slot] = SPATIAL_KIND_PROJECTILE;
    this.projectileSlots.add(entity.id);
    this.api().setProjectile(
      slot,
      entity.transform.x, entity.transform.y, entity.transform.z,
      entity.projectile.ownerId ?? 0,
      entity.projectile.projectileType === 'projectile' ? 1 : 0,
    );
  }

  removeProjectile(id: EntityId): void {
    if (!this.projectileSlots.delete(id)) return;
    this.freeEntitySlot(id);
  }

  addBuilding(entity: Entity): void {
    if (!entity.building) return;
    if (this.buildingSlots.has(entity.id)) return;
    const slot = this.slotFor(entity);
    this.kindBySlot[slot] = SPATIAL_KIND_BUILDING;
    this.buildingSlots.add(entity.id);
    const b = entity.building;
    this.api().setBuilding(
      slot,
      entity.transform.x, entity.transform.y, entity.transform.z,
      b.width / 2, b.height / 2, b.depth / 2,
      entity.ownership?.playerId ?? 0,
      b.hp > 0 ? 1 : 0,
      isEntityActive(entity) ? 1 : 0,
    );
  }

  removeBuilding(id: EntityId): void {
    if (!this.buildingSlots.delete(id)) return;
    this.freeEntitySlot(id);
  }

  removeEntity(id: EntityId): void {
    if (this.unitSlots.has(id)) {
      this.removeUnit(id);
    } else if (this.buildingSlots.has(id)) {
      this.removeBuilding(id);
    } else if (this.projectileSlots.has(id)) {
      this.removeProjectile(id);
    }
  }

  syncBuildingCapture(entity: Entity): void {
    const slot = this.slotByEntityId.get(entity.id);
    if (slot === undefined) return;
    if (!entity.building) return;
    // Re-bucketing on geometry/owner change uses setBuilding — same
    // path as addBuilding, which re-runs the cell sweep + capture
    // resync. Buildings don't move so this is a rare path; the
    // common case is just the capture-vote refresh after isEntityActive
    // flips at construction completion.
    const b = entity.building;
    this.api().setBuilding(
      slot,
      entity.transform.x, entity.transform.y, entity.transform.z,
      b.width / 2, b.height / 2, b.depth / 2,
      entity.ownership?.playerId ?? 0,
      b.hp > 0 ? 1 : 0,
      isEntityActive(entity) ? 1 : 0,
    );
  }

  // ===================== Result readback helpers =====================

  /** Construct a Uint32Array view over the WASM scratch buffer for
   *  the just-completed query. The view is invalidated by the next
   *  query call — caller consumes immediately. */
  private readScratch(count: number): Uint32Array {
    const sim = getSimWasm()!;
    return new Uint32Array(sim.memory.buffer, sim.spatial.scratchPtr(), count);
  }

  private resolveSlots(slots: Uint32Array, out: Entity[]): void {
    out.length = 0;
    for (let i = 0; i < slots.length; i++) {
      const e = this.entityBySlot[slots[i]];
      if (e) out.push(e);
    }
  }

  private resolveSlotsRange(slots: Uint32Array, start: number, end: number, out: Entity[]): void {
    out.length = 0;
    for (let i = start; i < end; i++) {
      const e = this.entityBySlot[slots[i]];
      if (e) out.push(e);
    }
  }

  // ===================== Queries =====================

  queryUnitsInRadius(x: number, y: number, z: number, radius: number): Entity[] {
    const count = this.api().queryUnitsInRadius(x, y, z, radius, 0, 0);
    this.resolveSlots(this.readScratch(count), this.queryResultUnits);
    return this.queryResultUnits;
  }

  queryBuildingsInRadius(x: number, y: number, z: number, radius: number): Entity[] {
    const count = this.api().queryBuildingsInRadius(x, y, z, radius, 0, 0);
    this.resolveSlots(this.readScratch(count), this.queryResultBuildings);
    return this.queryResultBuildings;
  }

  queryUnitsAndBuildingsInRadius(
    x: number, y: number, z: number, radius: number,
  ): { units: Entity[]; buildings: Entity[] } {
    const total = this.api().queryUnitsAndBuildingsInRadius(x, y, z, radius);
    const slots = this.readScratch(total);
    const nUnits = slots[0];
    const nBuildings = slots[1];
    this.resolveSlotsRange(slots, 2, 2 + nUnits, this.queryResultUnits);
    this.resolveSlotsRange(slots, 2 + nUnits, 2 + nUnits + nBuildings, this.queryResultBuildings);
    this._unitsAndBuildingsResult.units = this.queryResultUnits;
    this._unitsAndBuildingsResult.buildings = this.queryResultBuildings;
    return this._unitsAndBuildingsResult;
  }

  queryUnitsAndBuildingsInRect2D(
    minX: number, maxX: number, minY: number, maxY: number,
  ): { units: Entity[]; buildings: Entity[] } {
    const total = this.api().queryUnitsAndBuildingsInRect2D(minX, maxX, minY, maxY);
    const slots = this.readScratch(total);
    const nUnits = slots[0];
    const nBuildings = slots[1];
    this.resolveSlotsRange(slots, 2, 2 + nUnits, this._rectResult.units);
    this.resolveSlotsRange(slots, 2 + nUnits, 2 + nUnits + nBuildings, this._rectResult.buildings);
    return this._rectResult;
  }

  queryEnemyUnitsInRadius(x: number, y: number, z: number, radius: number, excludePlayerId: PlayerId): Entity[] {
    const count = this.api().queryEnemyUnitsInRadius(x, y, z, radius, excludePlayerId);
    this.resolveSlots(this.readScratch(count), this.queryResultUnits);
    return this.queryResultUnits;
  }

  queryEnemyProjectilesInRadius(x: number, y: number, z: number, radius: number, excludePlayerId: PlayerId): Entity[] {
    const count = this.api().queryEnemyProjectilesInRadius(x, y, z, radius, excludePlayerId);
    this.resolveSlots(this.readScratch(count), this.queryResultProjectiles);
    return this.queryResultProjectiles;
  }

  queryEnemyUnitsAndProjectilesInRadius(
    x: number, y: number, z: number, radius: number, excludePlayerId: PlayerId,
  ): { units: Entity[]; projectiles: Entity[] } {
    const total = this.api().queryEnemyUnitsAndProjectilesInRadius(x, y, z, radius, excludePlayerId);
    const slots = this.readScratch(total);
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
    const slots = this.readScratch(total);
    const nUnits = slots[0];
    const nBuildings = slots[1];
    // Concatenate units + buildings into queryResultAll to match the
    // original behaviour of the JS impl which pushed both into the
    // same result array.
    this.queryResultAll.length = 0;
    for (let i = 2; i < 2 + nUnits + nBuildings; i++) {
      const e = this.entityBySlot[slots[i]];
      if (e) this.queryResultAll.push(e);
    }
    return this.queryResultAll;
  }

  queryEnemyEntitiesInCircle2D(
    x: number, y: number, radius: number, excludePlayerId: PlayerId,
    zMin: number = DEFAULT_CIRCLE_Z_MIN - this.cellSize,
    zMax: number = DEFAULT_CIRCLE_Z_MAX + this.cellSize * 2,
  ): Entity[] {
    const total = this.api().queryEnemyEntitiesInCircle2D(x, y, radius, excludePlayerId, zMin, zMax);
    const slots = this.readScratch(total);
    const nUnits = slots[0];
    const nBuildings = slots[1];
    this.queryResultAll.length = 0;
    for (let i = 2; i < 2 + nUnits + nBuildings; i++) {
      const e = this.entityBySlot[slots[i]];
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
    this.resolveSlots(this.readScratch(count), this.queryResultUnits);
    return this.queryResultUnits;
  }

  queryBuildingsAlongLine(
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    lineWidth: number,
  ): Entity[] {
    const count = this.api().queryBuildingsAlongLine(x1, y1, z1, x2, y2, z2, lineWidth);
    this.resolveSlots(this.readScratch(count), this.queryResultBuildings);
    return this.queryResultBuildings;
  }

  queryEntitiesAlongLine(
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    lineWidth: number,
  ): { units: Entity[]; buildings: Entity[] } {
    const total = this.api().queryEntitiesAlongLine(x1, y1, z1, x2, y2, z2, lineWidth);
    const slots = this.readScratch(total);
    const nUnits = slots[0];
    const nBuildings = slots[1];
    this.resolveSlotsRange(slots, 2, 2 + nUnits, this.queryResultUnits);
    this.resolveSlotsRange(slots, 2 + nUnits, 2 + nUnits + nBuildings, this.queryResultBuildings);
    this._unitsAndBuildingsResult.units = this.queryResultUnits;
    this._unitsAndBuildingsResult.buildings = this.queryResultBuildings;
    return this._unitsAndBuildingsResult;
  }

  // ===================== Capture / debug =====================

  getCellSize(): number {
    return this.cellSize;
  }

  /** Reusable CaptureCell array — DO NOT STORE THE REFERENCE. The
   *  underlying slots are written into the WASM scratch buffer and
   *  reconstructed JS-side per call. */
  getOccupiedCellsForCapture(): CaptureCell[] {
    const total = this.api().queryOccupiedCellsForCapture();
    const slots = this.readScratch(total);
    this.captureResult.length = 0;
    if (total === 0) return this.captureResult;
    const nCells = slots[0];
    let read = 1;
    for (let i = 0; i < nCells; i++) {
      // Rust wrote the land-cell key as i32 (the int32 bit pattern
      // matches JS `packLandCellKey` exactly); read it back via the
      // unsigned slot and re-interpret. Math.fround round-trip works
      // because the bit pattern is preserved.
      const keyU32 = slots[read++];
      const key = keyU32 | 0;  // ToInt32 — matches the JS path's key shape.
      const nPlayers = slots[read++];
      const players: PlayerId[] = [];
      for (let p = 0; p < nPlayers; p++) {
        players.push(slots[read++]);
      }
      this.captureResult.push({ key, players });
    }
    return this.captureResult;
  }

  /** Per-cell unique-player debug listing. Reusable array; do not
   *  store the reference. */
  getOccupiedCells(): { cell: { x: number; y: number; z: number }; players: number[] }[] {
    const total = this.api().queryOccupiedCellsDebug();
    const slots = this.readScratch(total);
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
