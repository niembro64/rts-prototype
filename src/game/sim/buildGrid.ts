import type { EntityId, PlayerId } from './types';
import { magnitude } from '../math';

// Fine building footprint grid. This intentionally subdivides the
// canonical LAND_CELL_SIZE terrain cells.
export const BUILD_GRID_CELL_SIZE = 20; // 20x20 world units per cell

export type { GridCell } from '@/types/ui';
import type { GridCell } from '@/types/ui';

export type BuildingGridSnap = {
  /** Top-left occupied cell in the shared building grid. */
  gridX: number;
  gridY: number;
  /** World-space center of the building footprint. */
  x: number;
  y: number;
};

export function getBuildingCenterFromGrid(
  gridX: number,
  gridY: number,
  gridWidth: number,
  gridHeight: number,
): { x: number; y: number } {
  return {
    x: gridX * BUILD_GRID_CELL_SIZE + (gridWidth * BUILD_GRID_CELL_SIZE) / 2,
    y: gridY * BUILD_GRID_CELL_SIZE + (gridHeight * BUILD_GRID_CELL_SIZE) / 2,
  };
}

export type BuildingGridFootprint = {
  gridWidth: number;
  gridHeight: number;
};

export function isOddQuarterTurnGridRotation(rotation: number): boolean {
  if (!Number.isFinite(rotation)) return false;
  const quarterTurns = Math.round(rotation / (Math.PI / 2));
  return Math.abs(quarterTurns % 2) === 1;
}

export function getRotatedGridFootprint(
  gridWidth: number,
  gridHeight: number,
  rotation = 0,
): BuildingGridFootprint {
  const safeWidth = Math.max(1, Math.floor(gridWidth));
  const safeHeight = Math.max(1, Math.floor(gridHeight));
  return isOddQuarterTurnGridRotation(rotation)
    ? { gridWidth: safeHeight, gridHeight: safeWidth }
    : { gridWidth: safeWidth, gridHeight: safeHeight };
}

export function snapBuildingToGrid(
  worldX: number,
  worldY: number,
  gridWidth: number,
  gridHeight: number,
): BuildingGridSnap {
  const centerGx = Math.floor(worldX / BUILD_GRID_CELL_SIZE);
  const centerGy = Math.floor(worldY / BUILD_GRID_CELL_SIZE);
  const gridX = centerGx - Math.floor(gridWidth / 2);
  const gridY = centerGy - Math.floor(gridHeight / 2);
  const center = getBuildingCenterFromGrid(gridX, gridY, gridWidth, gridHeight);
  return { gridX, gridY, x: center.x, y: center.y };
}

// Building grid manager
export class BuildingGrid {
  private cells: Map<string, GridCell> = new Map();
  private gridWidth: number;
  private gridHeight: number;
  /** Monotonic version bumped on every mutation (place / remove).
   *  Caches that key off "the current set of occupied cells" read this
   *  and rebuild only when it differs from the recorded value. */
  private _version = 1;

  constructor(mapWidth: number, mapHeight: number) {
    this.gridWidth = Math.ceil(mapWidth / BUILD_GRID_CELL_SIZE);
    this.gridHeight = Math.ceil(mapHeight / BUILD_GRID_CELL_SIZE);
  }

  getVersion(): number {
    return this._version;
  }

  /** Iterate every occupied construction cell as `[gx, gy, cell]`
   *  triples. `blocksMovement=false` remains available for future
   *  reservation-only cells, but normal buildings occupy placement.
   *
   *  Movement pathfinding treats exact building footprints as one-way
   *  roof/support cells; this iterator still supplies those cells to
   *  the WASM planner so a unit already on a roof can leave it. */
  *occupiedCells(): IterableIterator<{ gx: number; gy: number; cell: GridCell }> {
    for (const [key, cell] of this.cells) {
      if (!cell.occupied) continue;
      if (cell.blocksMovement === false) continue;
      const comma = key.indexOf(',');
      const gx = +key.slice(0, comma);
      const gy = +key.slice(comma + 1);
      yield { gx, gy, cell };
    }
  }

  // Convert world coordinates to grid coordinates
  worldToGrid(worldX: number, worldY: number): { gx: number; gy: number } {
    return {
      gx: Math.floor(worldX / BUILD_GRID_CELL_SIZE),
      gy: Math.floor(worldY / BUILD_GRID_CELL_SIZE),
    };
  }

  // Convert grid coordinates to world coordinates (center of cell)
  gridToWorld(gx: number, gy: number): { x: number; y: number } {
    return {
      x: gx * BUILD_GRID_CELL_SIZE + BUILD_GRID_CELL_SIZE / 2,
      y: gy * BUILD_GRID_CELL_SIZE + BUILD_GRID_CELL_SIZE / 2,
    };
  }

  // Get the world position for the center of a building
  getBuildingCenter(gx: number, gy: number, gridWidth: number, gridHeight: number): { x: number; y: number } {
    return getBuildingCenterFromGrid(gx, gy, gridWidth, gridHeight);
  }

  // Snap world coordinates to grid (returns top-left corner of building)
  snapToGrid(worldX: number, worldY: number, gridWidth: number, gridHeight: number): { x: number; y: number } {
    const snapped = snapBuildingToGrid(worldX, worldY, gridWidth, gridHeight);
    return {
      x: snapped.gridX * BUILD_GRID_CELL_SIZE,
      y: snapped.gridY * BUILD_GRID_CELL_SIZE,
    };
  }

  // Get cell key for map
  private getCellKey(gx: number, gy: number): string {
    return `${gx},${gy}`;
  }

  // Get cell at grid coordinates
  getCell(gx: number, gy: number): GridCell | undefined {
    return this.cells.get(this.getCellKey(gx, gy));
  }

  // Check if a grid position is within map bounds
  isInBounds(gx: number, gy: number): boolean {
    return gx >= 0 && gx < this.gridWidth && gy >= 0 && gy < this.gridHeight;
  }

  // Check if we can place a building at the given grid position
  canPlace(gx: number, gy: number, gridWidth: number, gridHeight: number): boolean {
    // Check all cells the building would occupy
    for (let dx = 0; dx < gridWidth; dx++) {
      for (let dy = 0; dy < gridHeight; dy++) {
        const checkX = gx + dx;
        const checkY = gy + dy;

        // Check bounds
        if (!this.isInBounds(checkX, checkY)) {
          return false;
        }

        // Check if occupied
        const cell = this.getCell(checkX, checkY);
        if (cell !== undefined && cell.occupied) {
          return false;
        }
      }
    }
    return true;
  }

  // Check if we can place at world coordinates
  canPlaceAtWorld(worldX: number, worldY: number, gridWidth: number, gridHeight: number): boolean {
    const snapped = this.snapToGrid(worldX, worldY, gridWidth, gridHeight);
    const { gx, gy } = this.worldToGrid(snapped.x, snapped.y);
    return this.canPlace(gx, gy, gridWidth, gridHeight);
  }

  // Place a building (mark cells as occupied). When the physical
  // footprint is smaller than the placement footprint, the centered
  // clearance ring outside the physical rect still occupies placement
  // but never blocks movement — there is no body, roof, or support
  // surface over those cells, only a construction reservation.
  place(
    gx: number,
    gy: number,
    gridWidth: number,
    gridHeight: number,
    entityId: EntityId,
    playerId: PlayerId,
    blocksMovement: boolean = true,
    physicalGridWidth: number = gridWidth,
    physicalGridHeight: number = gridHeight,
  ): void {
    const insetX = Math.floor((gridWidth - physicalGridWidth) / 2);
    const insetY = Math.floor((gridHeight - physicalGridHeight) / 2);
    for (let dx = 0; dx < gridWidth; dx++) {
      for (let dy = 0; dy < gridHeight; dy++) {
        const cellX = gx + dx;
        const cellY = gy + dy;
        const physical =
          dx >= insetX && dx < insetX + physicalGridWidth &&
          dy >= insetY && dy < insetY + physicalGridHeight;
        const key = this.getCellKey(cellX, cellY);
        this.cells.set(key, {
          occupied: true,
          entityId,
          playerId,
          blocksMovement: physical && blocksMovement,
        });
      }
    }
    this._version++;
  }

  // Remove a building (clear cells)
  remove(gx: number, gy: number, gridWidth: number, gridHeight: number): void {
    for (let dx = 0; dx < gridWidth; dx++) {
      for (let dy = 0; dy < gridHeight; dy++) {
        const cellX = gx + dx;
        const cellY = gy + dy;
        const key = this.getCellKey(cellX, cellY);
        this.cells.delete(key);
      }
    }
    this._version++;
  }

  // Remove by entity ID (find and remove all cells for this entity)
  removeByEntityId(entityId: EntityId): void {
    const keysToRemove: string[] = [];
    for (const [key, cell] of this.cells) {
      if (cell.entityId === entityId) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      this.cells.delete(key);
    }
    if (keysToRemove.length > 0) this._version++;
  }

  // Get all valid placement positions for a building within commander's range
  getValidPlacements(
    commanderX: number,
    commanderY: number,
    buildRange: number,
    gridWidth: number,
    gridHeight: number
  ): { gx: number; gy: number }[] {
    const validPositions: { gx: number; gy: number }[] = [];

    // Convert commander position to grid
    const cmdGrid = this.worldToGrid(commanderX, commanderY);

    // Search area in grid cells
    const searchRadius =
      Math.ceil(buildRange / BUILD_GRID_CELL_SIZE) +
      Math.max(gridWidth, gridHeight);

    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
      for (let dy = -searchRadius; dy <= searchRadius; dy++) {
        const gx = cmdGrid.gx + dx;
        const gy = cmdGrid.gy + dy;

        // Check if placement is valid
        if (!this.canPlace(gx, gy, gridWidth, gridHeight)) {
          continue;
        }

        // Check if within build range (distance to building center)
        const buildingCenter = this.getBuildingCenter(gx, gy, gridWidth, gridHeight);
        const distX = buildingCenter.x - commanderX;
        const distY = buildingCenter.y - commanderY;
        const dist = magnitude(distX, distY);

        if (dist <= buildRange) {
          validPositions.push({ gx, gy });
        }
      }
    }

    return validPositions;
  }

  // Get grid dimensions
  getGridDimensions(): { width: number; height: number } {
    return { width: this.gridWidth, height: this.gridHeight };
  }
}
