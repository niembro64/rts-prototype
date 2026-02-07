import type { Entity, EntityId, PlayerId } from './types';

/**
 * Spatial hash grid for efficient range queries.
 * Divides the world into cells and tracks which entities are in each cell.
 * This reduces O(n) searches to O(k) where k = entities in nearby cells.
 *
 * Uses INCREMENTAL UPDATES: units update only when they cross cell boundaries.
 * Buildings are static and only added/removed on creation/destruction.
 * Uses numeric cell keys (bit-packed) to avoid string allocation overhead.
 */

// Cell size should be roughly 1/2 to 1/3 of typical weapon range
const DEFAULT_CELL_SIZE = 150;

interface GridCell {
  units: Entity[];
  buildings: Entity[];
}

export class SpatialGrid {
  private cellSize: number;
  private cells: Map<number, GridCell> = new Map();

  // Track which cell each unit is in (single cell per unit)
  private unitCellKey: Map<EntityId, number> = new Map();

  // Track which cells each building spans (may span multiple cells)
  private buildingCellKeys: Map<EntityId, number[]> = new Map();

  // Reusable dedup Set for multi-cell building queries (avoids per-query allocation)
  private _dedup: Set<EntityId> = new Set();

  // Cached arrays to avoid allocations during queries
  private readonly queryResultUnits: Entity[] = [];
  private readonly queryResultBuildings: Entity[] = [];
  private readonly queryResultAll: Entity[] = [];
  private readonly nearbyCells: number[] = [];

  constructor(cellSize: number = DEFAULT_CELL_SIZE) {
    this.cellSize = cellSize;
  }

  /**
   * Get numeric cell key for a world position (bit-packed, no string allocation)
   */
  private getCellKey(x: number, y: number): number {
    const cx = (Math.floor(x / this.cellSize) + 32768) & 0xFFFF;
    const cy = (Math.floor(y / this.cellSize) + 32768) & 0xFFFF;
    return (cx << 16) | cy;
  }

  /**
   * Get or create a cell
   */
  private getOrCreateCell(key: number): GridCell {
    let cell = this.cells.get(key);
    if (!cell) {
      cell = { units: [], buildings: [] };
      this.cells.set(key, cell);
    }
    return cell;
  }

  /**
   * Full clear (for reset/restart)
   */
  clear(): void {
    for (const cell of this.cells.values()) {
      cell.units.length = 0;
      cell.buildings.length = 0;
    }
    this.unitCellKey.clear();
    this.buildingCellKeys.clear();
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

    const newKey = this.getCellKey(entity.transform.x, entity.transform.y);
    const oldKey = this.unitCellKey.get(entity.id);

    if (oldKey === newKey) return; // Same cell — no work needed

    // Remove from old cell (swap-remove for O(1))
    if (oldKey !== undefined) {
      const oldCell = this.cells.get(oldKey);
      if (oldCell) {
        const idx = oldCell.units.findIndex(e => e.id === entity.id);
        if (idx !== -1) {
          const last = oldCell.units.length - 1;
          if (idx !== last) oldCell.units[idx] = oldCell.units[last];
          oldCell.units.pop();
        }
      }
    }

    // Add to new cell
    const newCell = this.getOrCreateCell(newKey);
    newCell.units.push(entity);
    this.unitCellKey.set(entity.id, newKey);
  }

  /**
   * Remove a unit from the grid (on death)
   */
  removeUnit(id: EntityId): void {
    const key = this.unitCellKey.get(id);
    if (key === undefined) return;

    const cell = this.cells.get(key);
    if (cell) {
      const idx = cell.units.findIndex(e => e.id === id);
      if (idx !== -1) {
        const last = cell.units.length - 1;
        if (idx !== last) cell.units[idx] = cell.units[last];
        cell.units.pop();
      }
    }
    this.unitCellKey.delete(id);
  }

  /**
   * Add a building to the grid (may span multiple cells). Buildings don't move.
   * Safe to call multiple times — skips if already tracked.
   */
  addBuilding(entity: Entity): void {
    if (!entity.building) return;
    if (this.buildingCellKeys.has(entity.id)) return; // Already tracked

    const { x, y } = entity.transform;
    const { width, height } = entity.building;

    const minCx = Math.floor((x - width / 2) / this.cellSize);
    const maxCx = Math.floor((x + width / 2) / this.cellSize);
    const minCy = Math.floor((y - height / 2) / this.cellSize);
    const maxCy = Math.floor((y + height / 2) / this.cellSize);

    const keys: number[] = [];

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const key = ((cx + 32768) & 0xFFFF) << 16 | ((cy + 32768) & 0xFFFF);
        const cell = this.getOrCreateCell(key);
        cell.buildings.push(entity);
        keys.push(key);
      }
    }

    this.buildingCellKeys.set(entity.id, keys);
  }

  /**
   * Remove a building from the grid (on destruction)
   */
  removeBuilding(id: EntityId): void {
    const keys = this.buildingCellKeys.get(id);
    if (!keys) return;

    for (const key of keys) {
      const cell = this.cells.get(key);
      if (cell) {
        const idx = cell.buildings.findIndex(e => e.id === id);
        if (idx !== -1) {
          const last = cell.buildings.length - 1;
          if (idx !== last) cell.buildings[idx] = cell.buildings[last];
          cell.buildings.pop();
        }
      }
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
    }
  }

  /**
   * Get all cells within a radius of a point (for circular range queries)
   */
  private getCellsInRadius(x: number, y: number, radius: number): void {
    this.nearbyCells.length = 0;

    const minCx = Math.floor((x - radius) / this.cellSize);
    const maxCx = Math.floor((x + radius) / this.cellSize);
    const minCy = Math.floor((y - radius) / this.cellSize);
    const maxCy = Math.floor((y + radius) / this.cellSize);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        this.nearbyCells.push(((cx + 32768) & 0xFFFF) << 16 | ((cy + 32768) & 0xFFFF));
      }
    }
  }

  /**
   * Query units within a radius of a point
   * Returns a reused array - DO NOT STORE THE REFERENCE
   */
  queryUnitsInRadius(x: number, y: number, radius: number): Entity[] {
    this.queryResultUnits.length = 0;
    this.getCellsInRadius(x, y, radius);

    const radiusSq = radius * radius;

    for (const key of this.nearbyCells) {
      const cell = this.cells.get(key);
      if (!cell) continue;

      for (const unit of cell.units) {
        const dx = unit.transform.x - x;
        const dy = unit.transform.y - y;
        if (dx * dx + dy * dy <= radiusSq) {
          this.queryResultUnits.push(unit);
        }
      }
    }

    return this.queryResultUnits;
  }

  /**
   * Query buildings within a radius of a point
   * Returns a reused array - DO NOT STORE THE REFERENCE
   */
  queryBuildingsInRadius(x: number, y: number, radius: number): Entity[] {
    this.queryResultBuildings.length = 0;
    this.getCellsInRadius(x, y, radius);

    // Reusable dedup set (buildings can span multiple cells)
    this._dedup.clear();

    for (const key of this.nearbyCells) {
      const cell = this.cells.get(key);
      if (!cell) continue;

      for (const building of cell.buildings) {
        if (this._dedup.has(building.id)) continue;
        this._dedup.add(building.id);

        const dx = building.transform.x - x;
        const dy = building.transform.y - y;
        const buildingRadius = Math.max(building.building!.width, building.building!.height) / 2;
        const checkRadius = radius + buildingRadius;

        if (dx * dx + dy * dy <= checkRadius * checkRadius) {
          this.queryResultBuildings.push(building);
        }
      }
    }

    return this.queryResultBuildings;
  }

  /**
   * Query all entities (units + buildings) within a radius
   * Returns a reused array - DO NOT STORE THE REFERENCE
   */
  queryEntitiesInRadius(x: number, y: number, radius: number): Entity[] {
    this.queryResultAll.length = 0;

    const units = this.queryUnitsInRadius(x, y, radius);
    for (const unit of units) {
      this.queryResultAll.push(unit);
    }

    const buildings = this.queryBuildingsInRadius(x, y, radius);
    for (const building of buildings) {
      this.queryResultAll.push(building);
    }

    return this.queryResultAll;
  }

  /**
   * Query enemy units within a radius (filtered by player)
   * Returns a reused array - DO NOT STORE THE REFERENCE
   */
  queryEnemyUnitsInRadius(x: number, y: number, radius: number, excludePlayerId: PlayerId): Entity[] {
    this.queryResultUnits.length = 0;
    this.getCellsInRadius(x, y, radius);

    const radiusSq = radius * radius;

    for (const key of this.nearbyCells) {
      const cell = this.cells.get(key);
      if (!cell) continue;

      for (const unit of cell.units) {
        if (unit.ownership?.playerId === excludePlayerId) continue;

        const dx = unit.transform.x - x;
        const dy = unit.transform.y - y;
        if (dx * dx + dy * dy <= radiusSq) {
          this.queryResultUnits.push(unit);
        }
      }
    }

    return this.queryResultUnits;
  }

  /**
   * Query enemy entities (units + buildings) within a radius
   * Returns a reused array - DO NOT STORE THE REFERENCE
   */
  queryEnemyEntitiesInRadius(x: number, y: number, radius: number, excludePlayerId: PlayerId): Entity[] {
    this.queryResultAll.length = 0;
    this.getCellsInRadius(x, y, radius);

    const radiusSq = radius * radius;
    this._dedup.clear();

    for (const key of this.nearbyCells) {
      const cell = this.cells.get(key);
      if (!cell) continue;

      for (const unit of cell.units) {
        if (unit.ownership?.playerId === excludePlayerId) continue;
        if (!unit.unit || unit.unit.hp <= 0) continue;

        const dx = unit.transform.x - x;
        const dy = unit.transform.y - y;
        if (dx * dx + dy * dy <= radiusSq) {
          this.queryResultAll.push(unit);
        }
      }

      for (const building of cell.buildings) {
        if (building.ownership?.playerId === excludePlayerId) continue;
        if (this._dedup.has(building.id)) continue;
        if (!building.building || building.building.hp <= 0) continue;
        this._dedup.add(building.id);

        const dx = building.transform.x - x;
        const dy = building.transform.y - y;
        const buildingRadius = Math.max(building.building.width, building.building.height) / 2;
        const checkRadius = radius + buildingRadius;

        if (dx * dx + dy * dy <= checkRadius * checkRadius) {
          this.queryResultAll.push(building);
        }
      }
    }

    return this.queryResultAll;
  }

  /**
   * Get cells along a line (for beam collision)
   */
  queryCellsAlongLine(x1: number, y1: number, x2: number, y2: number, lineWidth: number): void {
    this.nearbyCells.length = 0;

    const halfWidth = lineWidth / 2;
    const minX = Math.min(x1, x2) - halfWidth;
    const maxX = Math.max(x1, x2) + halfWidth;
    const minY = Math.min(y1, y2) - halfWidth;
    const maxY = Math.max(y1, y2) + halfWidth;

    const minCx = Math.floor(minX / this.cellSize);
    const maxCx = Math.floor(maxX / this.cellSize);
    const minCy = Math.floor(minY / this.cellSize);
    const maxCy = Math.floor(maxY / this.cellSize);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        this.nearbyCells.push(((cx + 32768) & 0xFFFF) << 16 | ((cy + 32768) & 0xFFFF));
      }
    }
  }

  /**
   * Query units along a line (for beam weapons)
   */
  queryUnitsAlongLine(x1: number, y1: number, x2: number, y2: number, lineWidth: number): Entity[] {
    this.queryResultUnits.length = 0;
    this.queryCellsAlongLine(x1, y1, x2, y2, lineWidth);

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
   * Query buildings along a line (for beam weapons)
   */
  queryBuildingsAlongLine(x1: number, y1: number, x2: number, y2: number, lineWidth: number): Entity[] {
    this.queryResultBuildings.length = 0;
    this.queryCellsAlongLine(x1, y1, x2, y2, lineWidth);

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
}

// Singleton instance for the game
export const spatialGrid = new SpatialGrid();
