import type { Entity, EntityId, PlayerId } from './types';
import { SPATIAL_GRID_CELL_SIZE } from '../../config';
import {
  packLandCellKey,
  spatialCubeKeyToLandCellKey,
  unpackLandCellX,
  unpackLandCellY,
} from '../landGrid';

// Maximum shot collider radius any unit can have (hippo = 45). Used to pad cell search
// in queryEnemyEntitiesInRadius so units at tracking range + radius boundary aren't
// missed due to cell-level culling.
const MAX_UNIT_SHOT_RADIUS = 45;

/**
 * 3D voxel spatial hash for efficient sphere/segment range queries.
 *
 * The world is divided into uniform CUBES of side `cellSize`. The XY
 * footprint uses the same canonical LAND_CELL_SIZE as capture/mana
 * tiles and the player-client object LOD grid; Z still stacks into
 * cubes for projectile and altitude-aware queries. Every entity (unit
 * / projectile / building footprint) is bucketed into the cube that
 * contains its center; queries iterate only the cubes intersecting the
 * query volume.
 *
 * Ground convention: z=0 sits at the CENTER of the bottom cube, not
 * its lower edge. The bottom cube spans z ∈ [-cellSize/2, +cellSize/2);
 * units standing on the ground (z≈0) and units bobbing slightly
 * below (transient client prediction) all bucket to the same cube.
 * Above-ground cubes stack upward in `cellSize` increments.
 *
 * Cell key: 16-bit cx + 16-bit cy + 16-bit cz packed into a 48-bit
 * integer via multiplication. JavaScript number type handles 53-bit
 * integers safely, so the packed key fits with margin. Bit ops are
 * 32-bit-only in JS, so the key uses multiplication; the per-tick
 * cost difference is negligible because we hit Map.get with a single
 * number, not three.
 *
 * Uses INCREMENTAL UPDATES: units update only when they cross cube
 * boundaries. Buildings are static — added on creation, removed on
 * destruction. Buildings span the cubes their (width × height × depth)
 * footprint touches.
 *
 * Aircraft-ready: a bomber at (100, 100, 500) and a flak unit at
 * (100, 100, 10) with cellSize=100 occupy DIFFERENT cubes (cz=5 vs
 * cz=0), so a query around the flak unit's altitude no longer
 * traverses every projectile sitting in the airspace overhead.
 */

type GridCell = {
  units: Entity[];
  buildings: Entity[];
  projectiles: Entity[];
  landKey: number;
};

export type CaptureCell = { key: number; players: PlayerId[] };
type CaptureVote = { key: number; playerId: PlayerId };

// 16-bit bias for each axis — keeps Math.floor results positive
// before packing so the cell key is always a non-negative integer.
// Range: cell index ∈ [-32768, +32767], i.e. up to ~6.5M world units
// per axis at cellSize=100. Plenty for any reasonable map.
const CELL_BIAS = 32768;
const CELL_MASK = 0xFFFF;
// Power-of-two multipliers for packing (avoid bit shifts since JS bit
// ops truncate to 32 bits). cx occupies the high 16 bits, cy the
// middle 16, cz the low 16 — total 48 bits, well inside safe integers.
const CX_MULT = 0x100000000;     // 2^32
const CY_MULT = 0x10000;         // 2^16

export class SpatialGrid {
  private cellSize: number;
  private halfCellSize: number;
  private cells: Map<number, GridCell> = new Map();

  // Track which cell each unit is in (single cell per unit)
  private unitCellKey: Map<EntityId, number> = new Map();

  // Track which cells each building spans (may span multiple cells)
  private buildingCellKeys: Map<EntityId, number[]> = new Map();

  // Track which cell each projectile is in (single cell per projectile)
  private projectileCellKey: Map<EntityId, number> = new Map();

  // Incremental capture occupancy keyed by canonical 2D land cell.
  // Capture no longer has to scan every populated 3D cube each update;
  // units/buildings add or remove one vote when their land-cell
  // contribution changes.
  private captureByLandCell: Map<number, CaptureCell> = new Map();
  private captureResult: CaptureCell[] = [];
  private unitCaptureVotes: Map<EntityId, CaptureVote> = new Map();
  private buildingCaptureVotes: Map<EntityId, CaptureVote[]> = new Map();

  // Reusable dedup Set for multi-cell building queries (avoids per-query allocation)
  private _dedup: Set<EntityId> = new Set();

  // Cached arrays to avoid allocations during queries
  private readonly queryResultUnits: Entity[] = [];
  private readonly queryResultBuildings: Entity[] = [];
  private readonly queryResultProjectiles: Entity[] = [];
  private readonly queryResultAll: Entity[] = [];
  private readonly nearbyCells: number[] = [];

  constructor(cellSize: number = SPATIAL_GRID_CELL_SIZE) {
    this.cellSize = cellSize;
    this.halfCellSize = cellSize / 2;
  }

  /**
   * Pack a (cx, cy, cz) integer cell coordinate into a single numeric
   * key. Each axis is 16-bit biased; the packed value is a 48-bit
   * non-negative integer.
   */
  private packCell(cx: number, cy: number, cz: number): number {
    const cxB = (cx + CELL_BIAS) & CELL_MASK;
    const cyB = (cy + CELL_BIAS) & CELL_MASK;
    const czB = (cz + CELL_BIAS) & CELL_MASK;
    return cxB * CX_MULT + cyB * CY_MULT + czB;
  }

  /**
   * Get numeric cell key for a 3D world position.
   * Z is biased by half a cell so z=0 sits at the CENTER of cube 0
   * (cube 0 spans z ∈ [−cellSize/2, +cellSize/2)).
   */
  private getCellKey(x: number, y: number, z: number): number {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    const cz = Math.floor((z + this.halfCellSize) / this.cellSize);
    return this.packCell(cx, cy, cz);
  }

  /**
   * Get or create a cell
   */
  private getOrCreateCell(key: number): GridCell {
    let cell = this.cells.get(key);
    if (!cell) {
      cell = {
        units: [],
        buildings: [],
        projectiles: [],
        landKey: spatialCubeKeyToLandCellKey(key),
      };
      this.cells.set(key, cell);
    }
    return cell;
  }

  /**
   * Drop a cell from the map if it has no units, buildings, or
   * projectiles left. Without this, every cell that ever held an
   * entity (units do walk across the whole map) lives forever in
   * `this.cells` — a slow leak over a long game. Iteration paths
   * (queries, capture-cell traversal) only inspect populated cells,
   * so removing empties is purely an upkeep tax we pay at removal
   * time instead of bloating the map.
   */
  private pruneCellIfEmpty(key: number): void {
    const cell = this.cells.get(key);
    if (
      cell &&
      cell.units.length === 0 &&
      cell.buildings.length === 0 &&
      cell.projectiles.length === 0
    ) {
      this.cells.delete(key);
    }
  }

  private addCaptureVote(key: number, playerId: PlayerId): void {
    let entry = this.captureByLandCell.get(key);
    if (!entry) {
      entry = { key, players: [] };
      this.captureByLandCell.set(key, entry);
    }
    entry.players.push(playerId);
  }

  private removeCaptureVote(key: number, playerId: PlayerId): void {
    const entry = this.captureByLandCell.get(key);
    if (!entry) return;
    const players = entry.players;
    for (let i = players.length - 1; i >= 0; i--) {
      if (players[i] !== playerId) continue;
      const last = players.length - 1;
      if (i !== last) players[i] = players[last];
      players.pop();
      break;
    }
    if (players.length === 0) this.captureByLandCell.delete(key);
  }

  private removeUnitCaptureVote(id: EntityId): void {
    const previous = this.unitCaptureVotes.get(id);
    if (!previous) return;
    this.removeCaptureVote(previous.key, previous.playerId);
    this.unitCaptureVotes.delete(id);
  }

  private syncUnitCaptureVote(entity: Entity, cellKey: number | undefined): void {
    const playerId = entity.ownership?.playerId;
    const shouldVote =
      cellKey !== undefined &&
      playerId !== undefined &&
      !!entity.unit &&
      entity.unit.hp > 0;
    const previous = this.unitCaptureVotes.get(entity.id);
    if (!shouldVote) {
      if (previous) this.removeUnitCaptureVote(entity.id);
      return;
    }

    const key = spatialCubeKeyToLandCellKey(cellKey);
    if (previous && previous.key === key && previous.playerId === playerId) return;
    if (previous) this.removeCaptureVote(previous.key, previous.playerId);
    this.addCaptureVote(key, playerId);
    this.unitCaptureVotes.set(entity.id, { key, playerId });
  }

  private removeBuildingCaptureVotes(id: EntityId): void {
    const votes = this.buildingCaptureVotes.get(id);
    if (!votes) return;
    for (let i = 0; i < votes.length; i++) {
      const vote = votes[i];
      this.removeCaptureVote(vote.key, vote.playerId);
    }
    this.buildingCaptureVotes.delete(id);
  }

  syncBuildingCapture(entity: Entity): void {
    this.removeBuildingCaptureVotes(entity.id);
    const playerId = entity.ownership?.playerId;
    const keys = this.buildingCellKeys.get(entity.id);
    if (
      playerId === undefined ||
      !keys ||
      !entity.building ||
      entity.building.hp <= 0 ||
      !entity.buildable?.isComplete
    ) {
      return;
    }

    const votes: CaptureVote[] = [];
    for (let i = 0; i < keys.length; i++) {
      const key = spatialCubeKeyToLandCellKey(keys[i]);
      this.addCaptureVote(key, playerId);
      votes.push({ key, playerId });
    }
    if (votes.length > 0) this.buildingCaptureVotes.set(entity.id, votes);
  }

  /**
   * Full clear (for reset/restart)
   */
  clear(): void {
    this.cells.clear();
    this.unitCellKey.clear();
    this.buildingCellKeys.clear();
    this.projectileCellKey.clear();
    this.captureByLandCell.clear();
    this.captureResult.length = 0;
    this.unitCaptureVotes.clear();
    this.buildingCaptureVotes.clear();
  }

  // === Unified single-cell entity tracking ===
  //
  // Units and projectiles each occupy exactly one grid cube; their
  // (insert / move / remove) bookkeeping is identical save for which
  // cell-array (`cell.units` vs `cell.projectiles`) and which key map
  // (`unitCellKey` vs `projectileCellKey`) they touch. The two helpers
  // below own the swap-remove + cell-prune logic so any future
  // optimization (cell-allocator, per-cell stats, dirty bits) lands
  // here once and benefits both categories. Buildings span a (multi-
  // cell) AABB and keep their own routines below.

  private removeFromCell(
    cellKey: number,
    id: EntityId,
    pickArr: (cell: GridCell) => Entity[],
  ): void {
    const cell = this.cells.get(cellKey);
    if (cell) {
      const arr = pickArr(cell);
      let idx = -1;
      for (let j = 0; j < arr.length; j++) {
        if (arr[j].id === id) { idx = j; break; }
      }
      if (idx !== -1) {
        const last = arr.length - 1;
        if (idx !== last) arr[idx] = arr[last];
        arr.pop();
      }
    }
    this.pruneCellIfEmpty(cellKey);
  }

  private updateSingleCellEntity(
    entity: Entity,
    keyMap: Map<EntityId, number>,
    pickArr: (cell: GridCell) => Entity[],
  ): number {
    const newKey = this.getCellKey(entity.transform.x, entity.transform.y, entity.transform.z);
    const oldKey = keyMap.get(entity.id);
    if (oldKey !== newKey) {
      if (oldKey !== undefined) this.removeFromCell(oldKey, entity.id, pickArr);
      pickArr(this.getOrCreateCell(newKey)).push(entity);
      keyMap.set(entity.id, newKey);
    }
    return newKey;
  }

  private removeSingleCellEntity(
    id: EntityId,
    keyMap: Map<EntityId, number>,
    pickArr: (cell: GridCell) => Entity[],
  ): void {
    const key = keyMap.get(id);
    if (key === undefined) return;
    this.removeFromCell(key, id, pickArr);
    keyMap.delete(id);
  }

  /**
   * Update a unit's position in the grid. O(1) if cell didn't change.
   * Also handles new units (not yet tracked) and dead units (removes them).
   */
  updateUnit(entity: Entity): void {
    if (!entity.unit || entity.unit.hp <= 0) {
      // Dead unit — remove if tracked
      this.removeUnit(entity.id);
      return;
    }
    const cellKey = this.updateSingleCellEntity(entity, this.unitCellKey, SpatialGrid._pickUnits);
    this.syncUnitCaptureVote(entity, cellKey);
  }

  /**
   * Remove a unit from the grid (on death)
   */
  removeUnit(id: EntityId): void {
    this.removeUnitCaptureVote(id);
    this.removeSingleCellEntity(id, this.unitCellKey, SpatialGrid._pickUnits);
  }

  /**
   * Update a projectile's position in the grid. O(1) if cell didn't change.
   */
  updateProjectile(entity: Entity): void {
    this.updateSingleCellEntity(entity, this.projectileCellKey, SpatialGrid._pickProjectiles);
  }

  /**
   * Remove a projectile from the grid (on despawn/collision)
   */
  removeProjectile(id: EntityId): void {
    this.removeSingleCellEntity(id, this.projectileCellKey, SpatialGrid._pickProjectiles);
  }

  // Static array selectors — declared once so the helpers above can
  // dispatch without allocating a closure per call.
  private static _pickUnits = (cell: GridCell): Entity[] => cell.units;
  private static _pickProjectiles = (cell: GridCell): Entity[] => cell.projectiles;

  /**
   * Add a building to the grid. Buildings span every cube their
   * (width × height × depth) AABB touches. The footprint is centered
   * on the building's transform XY; the vertical column runs from
   * `transform.z − depth/2` (base) up to `transform.z + depth/2`
   * (top). With non-flat terrain a building's base sits on the
   * local ground cube top, so two buildings of the same depth on
   * different terrain heights occupy different Z cubes. Buildings
   * don't move, so no incremental rebucket — only add (idempotent)
   * and remove on destruction.
   */
  addBuilding(entity: Entity): void {
    if (!entity.building) return;
    if (this.buildingCellKeys.has(entity.id)) return; // Already tracked

    const { x, y, z } = entity.transform;
    const { width, height, depth } = entity.building;
    const baseZ = z - depth / 2;
    const topZ = z + depth / 2;

    const minCx = Math.floor((x - width / 2) / this.cellSize);
    const maxCx = Math.floor((x + width / 2) / this.cellSize);
    const minCy = Math.floor((y - height / 2) / this.cellSize);
    const maxCy = Math.floor((y + height / 2) / this.cellSize);
    const minCz = Math.floor((baseZ + this.halfCellSize) / this.cellSize);
    const maxCz = Math.floor((topZ + this.halfCellSize) / this.cellSize);

    const keys: number[] = [];

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cz = minCz; cz <= maxCz; cz++) {
          const key = this.packCell(cx, cy, cz);
          const cell = this.getOrCreateCell(key);
          cell.buildings.push(entity);
          keys.push(key);
        }
      }
    }

    this.buildingCellKeys.set(entity.id, keys);
    this.syncBuildingCapture(entity);
  }

  /**
   * Remove a building from the grid (on destruction)
   */
  removeBuilding(id: EntityId): void {
    const keys = this.buildingCellKeys.get(id);
    if (!keys) return;
    this.removeBuildingCaptureVotes(id);

    for (const key of keys) {
      const cell = this.cells.get(key);
      if (cell) {
        let idx = -1;
        for (let j = 0; j < cell.buildings.length; j++) {
          if (cell.buildings[j].id === id) { idx = j; break; }
        }
        if (idx !== -1) {
          const last = cell.buildings.length - 1;
          if (idx !== last) cell.buildings[idx] = cell.buildings[last];
          cell.buildings.pop();
        }
      }
      this.pruneCellIfEmpty(key);
    }
    this.buildingCellKeys.delete(id);
  }

  /**
   * Remove any entity (unit or building) by ID
   */
  removeEntity(id: EntityId): void {
    if (this.unitCellKey.has(id)) {
      this.removeUnit(id);
    } else if (this.buildingCellKeys.has(id)) {
      this.removeBuilding(id);
    } else if (this.projectileCellKey.has(id)) {
      this.removeProjectile(id);
    }
  }

  /**
   * Collect cells whose cube intersects an axis-aligned cube of side
   * `2*radius` centered on (x, y, z). Used as the broad-phase volume
   * for sphere queries — the per-entity loop then refines with the
   * exact 3D distance test.
   */
  private getCellsInRadius(x: number, y: number, z: number, radius: number): void {
    this.nearbyCells.length = 0;

    const minCx = Math.floor((x - radius) / this.cellSize);
    const maxCx = Math.floor((x + radius) / this.cellSize);
    const minCy = Math.floor((y - radius) / this.cellSize);
    const maxCy = Math.floor((y + radius) / this.cellSize);
    const minCz = Math.floor((z - radius + this.halfCellSize) / this.cellSize);
    const maxCz = Math.floor((z + radius + this.halfCellSize) / this.cellSize);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cz = minCz; cz <= maxCz; cz++) {
          this.nearbyCells.push(this.packCell(cx, cy, cz));
        }
      }
    }
  }

  /**
   * Query units within a 3D sphere of `radius` around (x, y, z).
   * Returns a reused array — DO NOT STORE THE REFERENCE.
   */
  queryUnitsInRadius(x: number, y: number, z: number, radius: number): Entity[] {
    this.queryResultUnits.length = 0;
    this.getCellsInRadius(x, y, z, radius);

    const radiusSq = radius * radius;

    for (const key of this.nearbyCells) {
      const cell = this.cells.get(key);
      if (!cell) continue;

      for (const unit of cell.units) {
        const dx = unit.transform.x - x;
        const dy = unit.transform.y - y;
        const dz = unit.transform.z - z;
        if (dx * dx + dy * dy + dz * dz <= radiusSq) {
          this.queryResultUnits.push(unit);
        }
      }
    }

    return this.queryResultUnits;
  }

  /**
   * Query buildings within a 3D sphere of `radius` around (x, y, z).
   * Buildings are AABB columns from z=0 to z=depth — the test uses
   * sphere-vs-AABB closest-point distance so a sphere centered above
   * a tall building gets a hit, while a sphere centered far below
   * the ground plane (deep negative z) does not.
   * Returns a reused array — DO NOT STORE THE REFERENCE.
   */
  queryBuildingsInRadius(x: number, y: number, z: number, radius: number): Entity[] {
    this.queryResultBuildings.length = 0;
    this.getCellsInRadius(x, y, z, radius);

    // Reusable dedup set (buildings can span multiple cells)
    this._dedup.clear();

    const radiusSq = radius * radius;

    for (const key of this.nearbyCells) {
      const cell = this.cells.get(key);
      if (!cell) continue;

      for (const building of cell.buildings) {
        if (this._dedup.has(building.id)) continue;
        this._dedup.add(building.id);

        // Sphere-vs-AABB: closest point on the building box to the
        // query center, then squared distance compared to (radius)².
        // Building Z range is `transform.z ± depth/2` so terrain-lifted
        // buildings (base on a tall cube tile) test against the right
        // vertical column.
        const b = building.building!;
        const minX = building.transform.x - b.width / 2;
        const maxX = building.transform.x + b.width / 2;
        const minY = building.transform.y - b.height / 2;
        const maxY = building.transform.y + b.height / 2;
        const minZ = building.transform.z - b.depth / 2;
        const maxZ = building.transform.z + b.depth / 2;
        const cxp = x < minX ? minX : x > maxX ? maxX : x;
        const cyp = y < minY ? minY : y > maxY ? maxY : y;
        const czp = z < minZ ? minZ : z > maxZ ? maxZ : z;
        const dx = cxp - x;
        const dy = cyp - y;
        const dz = czp - z;

        if (dx * dx + dy * dy + dz * dz <= radiusSq) {
          this.queryResultBuildings.push(building);
        }
      }
    }

    return this.queryResultBuildings;
  }

  /**
   * Query all entities (units + buildings) within a 3D sphere
   * Returns a reused array - DO NOT STORE THE REFERENCE
   */
  queryEntitiesInRadius(x: number, y: number, z: number, radius: number): Entity[] {
    this.queryResultAll.length = 0;

    const units = this.queryUnitsInRadius(x, y, z, radius);
    for (const unit of units) {
      this.queryResultAll.push(unit);
    }

    const buildings = this.queryBuildingsInRadius(x, y, z, radius);
    for (const building of buildings) {
      this.queryResultAll.push(building);
    }

    return this.queryResultAll;
  }

  /**
   * Query enemy units within a 3D sphere (filtered by player)
   * Returns a reused array - DO NOT STORE THE REFERENCE
   */
  queryEnemyUnitsInRadius(x: number, y: number, z: number, radius: number, excludePlayerId: PlayerId): Entity[] {
    this.queryResultUnits.length = 0;
    this.getCellsInRadius(x, y, z, radius);

    const radiusSq = radius * radius;

    for (const key of this.nearbyCells) {
      const cell = this.cells.get(key);
      if (!cell) continue;

      for (const unit of cell.units) {
        if (unit.ownership?.playerId === excludePlayerId) continue;

        const dx = unit.transform.x - x;
        const dy = unit.transform.y - y;
        const dz = unit.transform.z - z;
        if (dx * dx + dy * dy + dz * dz <= radiusSq) {
          this.queryResultUnits.push(unit);
        }
      }
    }

    return this.queryResultUnits;
  }

  /**
   * Query enemy projectiles within a 3D sphere (filtered by owner player)
   * Only returns 'projectile' type projectiles. Returns a reused array - DO NOT STORE THE REFERENCE
   */
  queryEnemyProjectilesInRadius(x: number, y: number, z: number, radius: number, excludePlayerId: PlayerId): Entity[] {
    this.queryResultProjectiles.length = 0;
    this.getCellsInRadius(x, y, z, radius);

    const radiusSq = radius * radius;

    for (const key of this.nearbyCells) {
      const cell = this.cells.get(key);
      if (!cell) continue;

      for (const proj of cell.projectiles) {
        if (!proj.projectile || proj.projectile.projectileType !== 'projectile') continue;
        if (proj.projectile.ownerId === excludePlayerId) continue;

        const dx = proj.transform.x - x;
        const dy = proj.transform.y - y;
        const dz = proj.transform.z - z;
        if (dx * dx + dy * dy + dz * dz <= radiusSq) {
          this.queryResultProjectiles.push(proj);
        }
      }
    }

    return this.queryResultProjectiles;
  }

  /**
   * Combined enemy-units + enemy-projectiles query in a single
   * cell sweep. Force-field turrets need both, every tick — calling
   * the two solo helpers back-to-back rebuilds `nearbyCells` twice
   * for the same (x, y, z, radius). This single-sweep version fills
   * both reusable arrays in one pass over the cells. Returns the
   * shared `_unitsAndProjResult` wrapper — DO NOT STORE THE REFERENCE.
   */
  queryEnemyUnitsAndProjectilesInRadius(
    x: number, y: number, z: number, radius: number, excludePlayerId: PlayerId,
  ): { units: Entity[]; projectiles: Entity[] } {
    this.queryResultUnits.length = 0;
    this.queryResultProjectiles.length = 0;
    this.getCellsInRadius(x, y, z, radius);

    const radiusSq = radius * radius;

    for (const key of this.nearbyCells) {
      const cell = this.cells.get(key);
      if (!cell) continue;

      for (const unit of cell.units) {
        if (unit.ownership?.playerId === excludePlayerId) continue;
        const dx = unit.transform.x - x;
        const dy = unit.transform.y - y;
        const dz = unit.transform.z - z;
        if (dx * dx + dy * dy + dz * dz <= radiusSq) {
          this.queryResultUnits.push(unit);
        }
      }

      for (const proj of cell.projectiles) {
        if (!proj.projectile || proj.projectile.projectileType !== 'projectile') continue;
        if (proj.projectile.ownerId === excludePlayerId) continue;
        const dx = proj.transform.x - x;
        const dy = proj.transform.y - y;
        const dz = proj.transform.z - z;
        if (dx * dx + dy * dy + dz * dz <= radiusSq) {
          this.queryResultProjectiles.push(proj);
        }
      }
    }

    this._unitsAndProjResult.units = this.queryResultUnits;
    this._unitsAndProjResult.projectiles = this.queryResultProjectiles;
    return this._unitsAndProjResult;
  }
  private _unitsAndProjResult: { units: Entity[]; projectiles: Entity[] } = {
    units: [], projectiles: [],
  };

  /**
   * Query enemy entities (units + buildings) within a 3D sphere
   * Returns a reused array - DO NOT STORE THE REFERENCE
   */
  queryEnemyEntitiesInRadius(x: number, y: number, z: number, radius: number, excludePlayerId: PlayerId): Entity[] {
    this.queryResultAll.length = 0;
    // Pad cell search by max shot radius so units at radius + shot collider boundary
    // are in searched cells (per-unit distance check below does precise filtering)
    this.getCellsInRadius(x, y, z, radius + MAX_UNIT_SHOT_RADIUS);
    this._dedup.clear();

    for (const key of this.nearbyCells) {
      const cell = this.cells.get(key);
      if (!cell) continue;

      for (const unit of cell.units) {
        if (unit.ownership?.playerId === excludePlayerId) continue;
        if (!unit.unit || unit.unit.hp <= 0) continue;

        const dx = unit.transform.x - x;
        const dy = unit.transform.y - y;
        const dz = unit.transform.z - z;
        // Add unit shot collider radius to distance check (matches building behavior)
        // so units at edge of tracking range + radius are not incorrectly excluded
        const unitCheckRadius = radius + unit.unit.unitRadiusCollider.shot;
        if (dx * dx + dy * dy + dz * dz <= unitCheckRadius * unitCheckRadius) {
          this.queryResultAll.push(unit);
        }
      }

      for (const building of cell.buildings) {
        if (building.ownership?.playerId === excludePlayerId) continue;
        if (this._dedup.has(building.id)) continue;
        if (!building.building || building.building.hp <= 0) continue;
        this._dedup.add(building.id);

        // Sphere-vs-AABB closest-point distance (matches queryBuildingsInRadius).
        const b = building.building;
        const minX = building.transform.x - b.width / 2;
        const maxX = building.transform.x + b.width / 2;
        const minY = building.transform.y - b.height / 2;
        const maxY = building.transform.y + b.height / 2;
        const minZ = building.transform.z - b.depth / 2;
        const maxZ = building.transform.z + b.depth / 2;
        const cxp = x < minX ? minX : x > maxX ? maxX : x;
        const cyp = y < minY ? minY : y > maxY ? maxY : y;
        const czp = z < minZ ? minZ : z > maxZ ? maxZ : z;
        const dx = cxp - x;
        const dy = cyp - y;
        const dz = czp - z;

        if (dx * dx + dy * dy + dz * dz <= radius * radius) {
          this.queryResultAll.push(building);
        }
      }
    }

    return this.queryResultAll;
  }

  /**
   * Collect cells whose cube intersects the AABB around a 3D segment
   * (x1,y1,z1) → (x2,y2,z2) padded by `lineWidth/2` on every axis.
   * Beam paths arc through 3D space; this AABB is the loosest possible
   * broad-phase volume — the per-entity test downstream refines with
   * a real 3D segment-vs-sphere or segment-vs-AABB intersection.
   */
  queryCellsAlongLine(
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    lineWidth: number,
  ): void {
    this.nearbyCells.length = 0;

    const halfWidth = lineWidth / 2;
    const minX = Math.min(x1, x2) - halfWidth;
    const maxX = Math.max(x1, x2) + halfWidth;
    const minY = Math.min(y1, y2) - halfWidth;
    const maxY = Math.max(y1, y2) + halfWidth;
    const minZ = Math.min(z1, z2) - halfWidth;
    const maxZ = Math.max(z1, z2) + halfWidth;

    const minCx = Math.floor(minX / this.cellSize);
    const maxCx = Math.floor(maxX / this.cellSize);
    const minCy = Math.floor(minY / this.cellSize);
    const maxCy = Math.floor(maxY / this.cellSize);
    const minCz = Math.floor((minZ + this.halfCellSize) / this.cellSize);
    const maxCz = Math.floor((maxZ + this.halfCellSize) / this.cellSize);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cz = minCz; cz <= maxCz; cz++) {
          this.nearbyCells.push(this.packCell(cx, cy, cz));
        }
      }
    }
  }

  /**
   * Query units along a 3D segment (for beam weapons)
   */
  queryUnitsAlongLine(
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    lineWidth: number,
  ): Entity[] {
    this.queryResultUnits.length = 0;
    this.queryCellsAlongLine(x1, y1, z1, x2, y2, z2, lineWidth);

    this._dedup.clear();

    for (const key of this.nearbyCells) {
      const cell = this.cells.get(key);
      if (!cell) continue;

      for (const unit of cell.units) {
        if (this._dedup.has(unit.id)) continue;
        this._dedup.add(unit.id);
        this.queryResultUnits.push(unit);
      }
    }

    return this.queryResultUnits;
  }

  /**
   * Query buildings along a 3D segment (for beam weapons)
   */
  queryBuildingsAlongLine(
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    lineWidth: number,
  ): Entity[] {
    this.queryResultBuildings.length = 0;
    this.queryCellsAlongLine(x1, y1, z1, x2, y2, z2, lineWidth);

    this._dedup.clear();

    for (const key of this.nearbyCells) {
      const cell = this.cells.get(key);
      if (!cell) continue;

      for (const building of cell.buildings) {
        if (this._dedup.has(building.id)) continue;
        this._dedup.add(building.id);
        this.queryResultBuildings.push(building);
      }
    }

    return this.queryResultBuildings;
  }

  /**
   * Get the cell size (for client rendering)
   */
  getCellSize(): number {
    return this.cellSize;
  }

  /**
   * Get all occupied cells with player occupancy info (for debug visualization).
   * Returns array of { cell: { x, y, z }, players[] } for cells containing at least one unit.
   * Wire format extended with z so the client overlay can stack per altitude.
   */
  getOccupiedCells(): { cell: { x: number; y: number; z: number }; players: number[] }[] {
    const result: { cell: { x: number; y: number; z: number }; players: number[] }[] = [];
    const playerSet = new Set<number>();

    for (const [key, cell] of this.cells) {
      if (cell.units.length === 0) continue;

      // Decode bit-packed cell key: cx * 2^32 + cy * 2^16 + cz, each
      // axis biased by CELL_BIAS. Use Math.floor + arithmetic since
      // JS bit ops truncate to 32 bits.
      const cz = (key & CELL_MASK) - CELL_BIAS;
      const cy = (Math.floor(key / CY_MULT) & CELL_MASK) - CELL_BIAS;
      const cx = Math.floor(key / CX_MULT) - CELL_BIAS;

      // Collect unique player IDs in this cell
      playerSet.clear();
      for (const unit of cell.units) {
        if (unit.ownership?.playerId) {
          playerSet.add(unit.ownership.playerId);
        }
      }

      if (playerSet.size > 0) {
        result.push({ cell: { x: cx, y: cy, z: cz }, players: Array.from(playerSet) });
      }
    }

    return result;
  }

  /**
   * Get all occupied mana tiles with one player entry per unit/building (for capture system).
   * Unlike getOccupiedCells(), players are NOT deduplicated — 3 red units
   * on a tile yield [1,1,1] so the capture system can count them.
   * Buildings contribute one vote per spatial cell they span. Capture
   * tile size is normally the same as the spatial-grid XY size; the
   * aggregation path remains for diagnostics or future map variants.
   *
   * Territory capture is a GROUND concept: a tile is the XY footprint
   * of one or more columns of cubes. Units stacked in the air above the
   * same XY tile all vote into the same tile. The returned key is therefore
   * the 2D mana-tile (cx, cy) packed key, NOT the full 3D cube key — the
   * capture system stays 2D even though the spatial grid is 3D. When
   * aircraft arrive and the question of "do flying units capture?"
   * gets answered, gate the unit/building loop here on the unit's
   * altitude instead of changing the key shape.
   *
   * In the normal LAND_CELL_SIZE path this returns the incrementally
   * maintained capture map. The scan below is only for non-canonical
   * capture sizes.
   *
   * Returns a reusable array — do NOT store the reference.
   */
  getOccupiedCellsForCapture(captureCellSize: number = this.cellSize): CaptureCell[] {
    const tileCellSize = captureCellSize > 0 ? captureCellSize : this.cellSize;
    if (tileCellSize === this.cellSize) {
      this.captureResult.length = 0;
      for (const entry of this.captureByLandCell.values()) {
        if (entry.players.length > 0) this.captureResult.push(entry);
      }
      return this.captureResult;
    }

    // Return last tick's entries (and their inner players arrays) to
    // the pool — both get reused on this tick instead of reallocated.
    for (const c of _captureCells) _capturePool.push(c);
    _captureCells.length = 0;

    // Aggregate by 2D mana-tile key, summing contributions from every
    // cube in the Z column. With the canonical land-cell setup this is
    // a one-to-one XY mapping; if a caller passes a larger capture size,
    // fold several spatial columns into the same capture key.
    const byTile: Map<number, { key: number; players: PlayerId[] }> = _captureByTile;
    byTile.clear();
    const sameLandCellSize = tileCellSize === this.cellSize;
    const tileScale = sameLandCellSize ? 1 : this.cellSize / tileCellSize;

    for (const cell of this.cells.values()) {
      if (cell.units.length === 0 && cell.buildings.length === 0) continue;

      const tileKey = sameLandCellSize
        ? cell.landKey
        : packLandCellKey(
          Math.floor(unpackLandCellX(cell.landKey) * tileScale),
          Math.floor(unpackLandCellY(cell.landKey) * tileScale),
        );

      let entry = byTile.get(tileKey);
      if (!entry) {
        entry = _capturePool.pop() ?? { key: 0, players: [] };
        entry.players.length = 0;
        entry.key = tileKey;
        byTile.set(tileKey, entry);
      }

      for (const unit of cell.units) {
        if (unit.ownership?.playerId && unit.unit && unit.unit.hp > 0) {
          entry.players.push(unit.ownership.playerId);
        }
      }
      for (const b of cell.buildings) {
        // Only fully-built buildings contribute to tile ownership.
        // Ghost / under-construction buildings are visual placeholders
        // — they shouldn't paint territory until they actually become
        // a real, working building.
        if (
          b.ownership?.playerId
          && b.building && b.building.hp > 0
          && b.buildable?.isComplete
        ) {
          entry.players.push(b.ownership.playerId);
        }
      }
    }

    for (const entry of byTile.values()) {
      if (entry.players.length > 0) {
        _captureCells.push(entry);
      } else {
        _capturePool.push(entry);
      }
    }
    byTile.clear();
    return _captureCells;
  }
}

const _captureCells: { key: number; players: PlayerId[] }[] = [];
// Spare entries + inner players arrays, reused across calls. Grows to
// the peak occupied-cell count then stops; eliminates per-tick array
// allocations in the capture-tick hot path.
const _capturePool: { key: number; players: PlayerId[] }[] = [];
// Reusable XY-tile aggregator used by getOccupiedCellsForCapture to
// merge multiple Z-cubes that share an XY footprint into one capture
// tile entry. Cleared at the start of every call.
const _captureByTile: Map<number, { key: number; players: PlayerId[] }> = new Map();

// Singleton instance for the game
export const spatialGrid = new SpatialGrid();
