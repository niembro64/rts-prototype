import type {
  BuildingPlacementFootprint,
  BuildingPlacementFootprintCell,
  EntityId,
  PlayerId,
} from './types';
import { magnitude } from '../math';

// Fine building footprint grid. This intentionally subdivides the
// canonical LAND_CELL_SIZE terrain cells.
export const BUILD_GRID_CELL_SIZE = 20; // 20x20 world units per cell

import type { GridCell } from '@/types/ui';

type BuildingGridSnap = {
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

type BuildingGridFootprint = {
  gridWidth: number;
  gridHeight: number;
};

const FOOTPRINT_STRUCTURE_CELL = '#';
const FOOTPRINT_CLEARANCE_CELL = '+';
const FOOTPRINT_EMPTY_CELL = '.';

/** Parse the compact blueprint mask used by every building. Rows are authored
 *  top-to-bottom. `#` is structure + reservation, `+` is construction-only
 *  clearance, and `.` is genuinely unused space inside the bounding box. */
export function parseBuildingPlacementFootprint(
  rows: readonly string[],
  label: string,
): BuildingPlacementFootprint {
  if (rows.length === 0 || rows[0].length === 0) {
    throw new Error(`Invalid ${label}: footprintMask must contain at least one non-empty row`);
  }
  const gridWidth = rows[0].length;
  const cells: BuildingPlacementFootprintCell[] = [];
  for (let dy = 0; dy < rows.length; dy++) {
    const row = rows[dy];
    if (row.length !== gridWidth) {
      throw new Error(
        `Invalid ${label}: footprintMask row ${dy} has width ${row.length}; expected ${gridWidth}`,
      );
    }
    for (let dx = 0; dx < gridWidth; dx++) {
      const value = row[dx];
      if (value === FOOTPRINT_EMPTY_CELL) continue;
      if (value !== FOOTPRINT_STRUCTURE_CELL && value !== FOOTPRINT_CLEARANCE_CELL) {
        throw new Error(
          `Invalid ${label}: footprintMask row ${dy}, column ${dx} uses "${value}"; expected #, +, or .`,
        );
      }
      cells.push({
        dx,
        dy,
        kind: value === FOOTPRINT_STRUCTURE_CELL ? 'structure' : 'clearance',
      });
    }
  }
  if (cells.length === 0) {
    throw new Error(`Invalid ${label}: footprintMask must reserve at least one cell`);
  }
  return {
    gridWidth,
    gridHeight: rows.length,
    cells,
  };
}

function getGridQuarterTurns(rotation: number): number {
  if (!Number.isFinite(rotation)) return 0;
  return ((Math.round(rotation / (Math.PI / 2)) % 4) + 4) % 4;
}

/** Rotate an authored cell mask in exact build-grid quarter turns. */
export function getRotatedBuildingPlacementFootprint(
  footprint: BuildingPlacementFootprint,
  rotation = 0,
): BuildingPlacementFootprint {
  const quarterTurns = getGridQuarterTurns(rotation);
  if (quarterTurns === 0) return footprint;
  const rotatedWidth = quarterTurns % 2 === 1
    ? footprint.gridHeight
    : footprint.gridWidth;
  const rotatedHeight = quarterTurns % 2 === 1
    ? footprint.gridWidth
    : footprint.gridHeight;
  const cells = new Array<BuildingPlacementFootprintCell>(footprint.cells.length);
  for (let i = 0; i < footprint.cells.length; i++) {
    const cell = footprint.cells[i];
    let dx: number;
    let dy: number;
    switch (quarterTurns) {
      case 1:
        dx = footprint.gridHeight - 1 - cell.dy;
        dy = cell.dx;
        break;
      case 2:
        dx = footprint.gridWidth - 1 - cell.dx;
        dy = footprint.gridHeight - 1 - cell.dy;
        break;
      default:
        dx = cell.dy;
        dy = footprint.gridWidth - 1 - cell.dx;
        break;
    }
    cells[i] = { dx, dy, kind: cell.kind };
  }
  return { gridWidth: rotatedWidth, gridHeight: rotatedHeight, cells };
}

export function isOddQuarterTurnGridRotation(rotation: number): boolean {
  return getGridQuarterTurns(rotation) % 2 === 1;
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
  private cells: Map<number, GridCell> = new Map();
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

  /** Iterate every occupied physical structure cell as `[gx, gy, cell]`
   *  triples. `blocksMovement=false` cells remain construction-only
   *  reservations with no pathfinding surface. */
  *occupiedCells(): IterableIterator<{ gx: number; gy: number; cell: GridCell }> {
    for (const [key, cell] of this.cells) {
      if (!cell.occupied) continue;
      if (cell.blocksMovement === false) continue;
      const gy = Math.floor(key / this.gridWidth);
      const gx = key - gy * this.gridWidth;
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
  private getCellKey(gx: number, gy: number): number {
    return gy * this.gridWidth + gx;
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
    // Preserve the historical empty-footprint result: the nested loops did
    // no work and accepted it regardless of origin.
    if (gridWidth <= 0 || gridHeight <= 0) return true;
    // Bounds are invariant across the footprint. Hoist them out of the hot
    // nested loop, then address the numeric map key directly row by row.
    if (
      gx < 0 || gy < 0 ||
      gx + gridWidth > this.gridWidth ||
      gy + gridHeight > this.gridHeight
    ) return false;
    for (let dy = 0; dy < gridHeight; dy++) {
      const rowKey = (gy + dy) * this.gridWidth + gx;
      for (let dx = 0; dx < gridWidth; dx++) {
        const cell = this.cells.get(rowKey + dx);
        if (cell !== undefined && cell.occupied) {
          return false;
        }
      }
    }
    return true;
  }

  canPlaceFootprint(
    gx: number,
    gy: number,
    footprint: BuildingPlacementFootprint,
  ): boolean {
    for (let i = 0; i < footprint.cells.length; i++) {
      const cell = footprint.cells[i];
      const cellX = gx + cell.dx;
      const cellY = gy + cell.dy;
      if (!this.isInBounds(cellX, cellY)) return false;
      if (this.cells.get(this.getCellKey(cellX, cellY))?.occupied === true) return false;
    }
    return true;
  }

  // Check if we can place at world coordinates
  canPlaceAtWorld(worldX: number, worldY: number, gridWidth: number, gridHeight: number): boolean {
    const snapped = this.snapToGrid(worldX, worldY, gridWidth, gridHeight);
    const { gx, gy } = this.worldToGrid(snapped.x, snapped.y);
    return this.canPlace(gx, gy, gridWidth, gridHeight);
  }

  // Legacy rectangular placement helper retained for low-level grid tests.
  // Blueprint buildings use placeFootprint below.
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
    pathTopZ: number = BUILD_GRID_CELL_SIZE,
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
          pathTopZ: physical && blocksMovement ? pathTopZ : undefined,
        });
      }
    }
    this._version++;
  }

  /** Place exactly the authored mask. Empty bounding-box corners stay free,
   *  and clearance cells reserve builds without entering the path layer. */
  placeFootprint(
    gx: number,
    gy: number,
    footprint: BuildingPlacementFootprint,
    entityId: EntityId,
    playerId: PlayerId,
    blocksMovement: boolean = true,
    pathTopZ: number = BUILD_GRID_CELL_SIZE,
  ): void {
    for (let i = 0; i < footprint.cells.length; i++) {
      const cell = footprint.cells[i];
      const movementCell = cell.kind === 'structure' && blocksMovement;
      this.cells.set(this.getCellKey(gx + cell.dx, gy + cell.dy), {
        occupied: true,
        entityId,
        playerId,
        blocksMovement: movementCell,
        pathTopZ: movementCell ? pathTopZ : undefined,
      });
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
    let removed = false;
    for (const [key, cell] of this.cells) {
      if (cell.entityId === entityId) {
        // Deleting the current Map entry while iterating is defined and does
        // not disturb the order of entries that remain.
        this.cells.delete(key);
        removed = true;
      }
    }
    if (removed) this._version++;
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
