import type { EntityId, PlayerId } from './types';
import { magnitude } from '../math';

// Grid constants
export const GRID_CELL_SIZE = 20; // 20x20 world units per cell

// Grid cell state
export interface GridCell {
  occupied: boolean;
  entityId: EntityId | null;
  playerId: PlayerId | null;
}

// Building grid manager
export class BuildingGrid {
  private cells: Map<string, GridCell> = new Map();
  private gridWidth: number;
  private gridHeight: number;

  constructor(mapWidth: number, mapHeight: number) {
    this.gridWidth = Math.ceil(mapWidth / GRID_CELL_SIZE);
    this.gridHeight = Math.ceil(mapHeight / GRID_CELL_SIZE);
  }

  // Convert world coordinates to grid coordinates
  worldToGrid(worldX: number, worldY: number): { gx: number; gy: number } {
    return {
      gx: Math.floor(worldX / GRID_CELL_SIZE),
      gy: Math.floor(worldY / GRID_CELL_SIZE),
    };
  }

  // Convert grid coordinates to world coordinates (center of cell)
  gridToWorld(gx: number, gy: number): { x: number; y: number } {
    return {
      x: gx * GRID_CELL_SIZE + GRID_CELL_SIZE / 2,
      y: gy * GRID_CELL_SIZE + GRID_CELL_SIZE / 2,
    };
  }

  // Get the world position for the center of a building
  getBuildingCenter(gx: number, gy: number, gridWidth: number, gridHeight: number): { x: number; y: number } {
    return {
      x: gx * GRID_CELL_SIZE + (gridWidth * GRID_CELL_SIZE) / 2,
      y: gy * GRID_CELL_SIZE + (gridHeight * GRID_CELL_SIZE) / 2,
    };
  }

  // Snap world coordinates to grid (returns top-left corner of building)
  snapToGrid(worldX: number, worldY: number, gridWidth: number, gridHeight: number): { x: number; y: number } {
    // Find the grid cell for the center of where we're placing
    const centerGx = Math.floor(worldX / GRID_CELL_SIZE);
    const centerGy = Math.floor(worldY / GRID_CELL_SIZE);

    // Offset to get top-left based on building size
    const topLeftGx = centerGx - Math.floor(gridWidth / 2);
    const topLeftGy = centerGy - Math.floor(gridHeight / 2);

    return {
      x: topLeftGx * GRID_CELL_SIZE,
      y: topLeftGy * GRID_CELL_SIZE,
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
        if (cell?.occupied) {
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

  // Place a building (mark cells as occupied)
  place(gx: number, gy: number, gridWidth: number, gridHeight: number, entityId: EntityId, playerId: PlayerId): void {
    for (let dx = 0; dx < gridWidth; dx++) {
      for (let dy = 0; dy < gridHeight; dy++) {
        const cellX = gx + dx;
        const cellY = gy + dy;
        const key = this.getCellKey(cellX, cellY);
        this.cells.set(key, {
          occupied: true,
          entityId,
          playerId,
        });
      }
    }
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
    const searchRadius = Math.ceil(buildRange / GRID_CELL_SIZE) + Math.max(gridWidth, gridHeight);

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
