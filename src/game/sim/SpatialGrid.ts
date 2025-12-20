import type { Entity, EntityId, PlayerId } from './types';

/**
 * Spatial hash grid for efficient range queries.
 * Divides the world into cells and tracks which entities are in each cell.
 * This reduces O(n) searches to O(k) where k = entities in nearby cells.
 */

// Cell size should be roughly 1/2 to 1/3 of typical weapon range
const DEFAULT_CELL_SIZE = 150;

interface GridCell {
  units: Entity[];
  buildings: Entity[];
}

export class SpatialGrid {
  private cellSize: number;
  private cells: Map<string, GridCell> = new Map();
  private entityCells: Map<EntityId, string[]> = new Map(); // Track which cells each entity is in

  // Cached arrays to avoid allocations during queries
  private readonly queryResultUnits: Entity[] = [];
  private readonly queryResultBuildings: Entity[] = [];
  private readonly queryResultAll: Entity[] = [];
  private readonly nearbyCells: string[] = [];

  constructor(cellSize: number = DEFAULT_CELL_SIZE) {
    this.cellSize = cellSize;
  }

  /**
   * Get the cell key for a world position
   */
  private getCellKey(x: number, y: number): string {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    return `${cx},${cy}`;
  }

  /**
   * Get or create a cell
   */
  private getOrCreateCell(key: string): GridCell {
    let cell = this.cells.get(key);
    if (!cell) {
      cell = { units: [], buildings: [] };
      this.cells.set(key, cell);
    }
    return cell;
  }

  /**
   * Clear the grid (call at start of each frame before rebuilding)
   */
  clear(): void {
    // Clear all cells
    for (const cell of this.cells.values()) {
      cell.units.length = 0;
      cell.buildings.length = 0;
    }
    this.entityCells.clear();
  }

  /**
   * Add a unit to the grid
   */
  addUnit(entity: Entity): void {
    if (!entity.unit) return;

    const key = this.getCellKey(entity.transform.x, entity.transform.y);
    const cell = this.getOrCreateCell(key);
    cell.units.push(entity);

    // Track which cell this entity is in
    const cells = this.entityCells.get(entity.id);
    if (cells) {
      cells.push(key);
    } else {
      this.entityCells.set(entity.id, [key]);
    }
  }

  /**
   * Add a building to the grid (may span multiple cells)
   */
  addBuilding(entity: Entity): void {
    if (!entity.building) return;

    const { x, y } = entity.transform;
    const { width, height } = entity.building;

    // Calculate all cells this building overlaps
    const minCx = Math.floor((x - width / 2) / this.cellSize);
    const maxCx = Math.floor((x + width / 2) / this.cellSize);
    const minCy = Math.floor((y - height / 2) / this.cellSize);
    const maxCy = Math.floor((y + height / 2) / this.cellSize);

    const cells: string[] = [];

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const key = `${cx},${cy}`;
        const cell = this.getOrCreateCell(key);
        cell.buildings.push(entity);
        cells.push(key);
      }
    }

    this.entityCells.set(entity.id, cells);
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
        this.nearbyCells.push(`${cx},${cy}`);
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

    // Use a Set to avoid duplicates (buildings can span multiple cells)
    const seen = new Set<EntityId>();

    for (const key of this.nearbyCells) {
      const cell = this.cells.get(key);
      if (!cell) continue;

      for (const building of cell.buildings) {
        if (seen.has(building.id)) continue;
        seen.add(building.id);

        // For buildings, check distance to building center
        // (could be improved with proper AABB check)
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

    // Get units
    const units = this.queryUnitsInRadius(x, y, radius);
    for (const unit of units) {
      this.queryResultAll.push(unit);
    }

    // Get buildings
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
        // Skip units owned by the excluded player
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
    const seen = new Set<EntityId>();

    // Query units
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

      // Query buildings
      for (const building of cell.buildings) {
        if (building.ownership?.playerId === excludePlayerId) continue;
        if (seen.has(building.id)) continue;
        if (!building.building || building.building.hp <= 0) continue;
        seen.add(building.id);

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

    // Expand line bounds by half line width
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
        this.nearbyCells.push(`${cx},${cy}`);
      }
    }
  }

  /**
   * Query units along a line (for beam weapons)
   */
  queryUnitsAlongLine(x1: number, y1: number, x2: number, y2: number, lineWidth: number): Entity[] {
    this.queryResultUnits.length = 0;
    this.queryCellsAlongLine(x1, y1, x2, y2, lineWidth);

    const seen = new Set<EntityId>();

    for (const key of this.nearbyCells) {
      const cell = this.cells.get(key);
      if (!cell) continue;

      for (const unit of cell.units) {
        if (seen.has(unit.id)) continue;
        seen.add(unit.id);
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

    const seen = new Set<EntityId>();

    for (const key of this.nearbyCells) {
      const cell = this.cells.get(key);
      if (!cell) continue;

      for (const building of cell.buildings) {
        if (seen.has(building.id)) continue;
        seen.add(building.id);
        this.queryResultBuildings.push(building);
      }
    }

    return this.queryResultBuildings;
  }
}

// Singleton instance for the game
export const spatialGrid = new SpatialGrid();
