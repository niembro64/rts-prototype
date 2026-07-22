// Pathfinding debug grid — a presentation-side mirror of the pathfinder's
// cell-domain and configuration-space rules. The renderer owns terrain
// sampling; this module owns the policy that turns those sampled masks into
// the selected unit's visible route domain.

import {
  resolvePathfinderTraversalInput,
  type PathTerrainFilter,
  type PathfinderTraversalInput,
} from './pathfindingTraversal';
import type { UnitNavigationDomain } from '@/types/unitLocomotionTypes';
import {
  PATHFINDING_STABILITY_MIN_NORMAL_Z,
  PATHFINDING_WATER_BUFFER_CELLS,
} from './pathfindingTuning';

const CLEARANCE_UNREACHABLE = 0xffff;

export type PathfindingDebugGrid = {
  readonly waterBlocked: Uint8Array;
  readonly edgeBlocked: Uint8Array;
  readonly groundClearance: Uint16Array;
  readonly mediumClearance: Uint16Array;
  readonly waterClearance: Uint16Array;
  readonly waypointPassable: Uint8Array;
  readonly movePassable: Uint8Array;
};

export type PathfindingDebugTraversal = Readonly<{
  traversal: PathfinderTraversalInput;
  requiredNormalZ: number;
  hardClearanceCells: number;
}>;

export type PathfindingDebugGridInput = Readonly<{
  cellsX: number;
  cellsY: number;
  terrainWater: Uint8Array;
  terrainSubmerged: Uint8Array;
}>;

export type PathfindingDebugPassabilityInput = Readonly<{
  grid: PathfindingDebugGrid;
  terrainWater: Uint8Array;
  terrainSubmerged: Uint8Array;
  terrainNormalZ: Float32Array;
  traversal: PathfindingDebugTraversal;
  cellsX: number;
  cellsY: number;
}>;

function safeCellCount(cellCount: number): number {
  return Math.max(1, Math.floor(cellCount));
}

export function createPathfindingDebugGrid(cellCount: number): PathfindingDebugGrid {
  const count = safeCellCount(cellCount);
  return {
    waterBlocked: new Uint8Array(count),
    edgeBlocked: new Uint8Array(count),
    groundClearance: new Uint16Array(count),
    mediumClearance: new Uint16Array(count),
    waterClearance: new Uint16Array(count),
    waypointPassable: new Uint8Array(count),
    movePassable: new Uint8Array(count),
  };
}

export function ensurePathfindingDebugGrid(
  grid: PathfindingDebugGrid,
  cellCount: number,
): PathfindingDebugGrid {
  return grid.movePassable.length >= safeCellCount(cellCount)
    ? grid
    : createPathfindingDebugGrid(cellCount);
}

/** Mirrors `pathfinder_hard_clearance_cells_for_radius` in Rust. */
export function pathfinderHardClearanceCellsForRadius(radius: number, cellSize: number): number {
  if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(cellSize) || cellSize <= 0) {
    return 0;
  }
  return Math.ceil(radius / cellSize + 0.5);
}

/** Mirrors `pathfinder_required_water_clearance_cells` in Rust. */
export function pathfinderRequiredWaterClearanceCells(hardClearanceCells: number): number {
  const shoreBuffer = Math.max(0, PATHFINDING_WATER_BUFFER_CELLS);
  return hardClearanceCells > 0
    ? hardClearanceCells + shoreBuffer
    : shoreBuffer + 1;
}

export function createPathfindingDebugTraversal(
  terrainFilter: PathTerrainFilter | null,
  unitRadius: number,
  cellSize: number,
): PathfindingDebugTraversal {
  const traversal = resolvePathfinderTraversalInput(terrainFilter);
  return {
    traversal,
    requiredNormalZ: traversal.move.allowInAir
      ? 0
      : Math.max(PATHFINDING_STABILITY_MIN_NORMAL_Z, traversal.minStandstillNormalZ),
    hardClearanceCells: pathfinderHardClearanceCellsForRadius(unitRadius, cellSize),
  };
}

function rebuildClearanceDistance(clearance: Uint16Array, cellsX: number, cellsY: number): void {
  // Chebyshev cell distance: this is the same two-pass transform the
  // authoritative pathfinder uses for collision clearance.
  for (let gy = 0; gy < cellsY; gy++) {
    for (let gx = 0; gx < cellsX; gx++) {
      const index = gy * cellsX + gx;
      if (clearance[index] === 0) continue;
      let nearest = clearance[index];
      if (gx > 0) nearest = Math.min(nearest, clearance[index - 1] + 1);
      if (gy > 0) {
        const north = index - cellsX;
        nearest = Math.min(nearest, clearance[north] + 1);
        if (gx > 0) nearest = Math.min(nearest, clearance[north - 1] + 1);
        if (gx < cellsX - 1) nearest = Math.min(nearest, clearance[north + 1] + 1);
      }
      clearance[index] = Math.min(CLEARANCE_UNREACHABLE, nearest);
    }
  }
  for (let gy = cellsY - 1; gy >= 0; gy--) {
    for (let gx = cellsX - 1; gx >= 0; gx--) {
      const index = gy * cellsX + gx;
      if (clearance[index] === 0) continue;
      let nearest = clearance[index];
      if (gx < cellsX - 1) nearest = Math.min(nearest, clearance[index + 1] + 1);
      if (gy < cellsY - 1) {
        const south = index + cellsX;
        nearest = Math.min(nearest, clearance[south] + 1);
        if (gx < cellsX - 1) nearest = Math.min(nearest, clearance[south + 1] + 1);
        if (gx > 0) nearest = Math.min(nearest, clearance[south - 1] + 1);
      }
      clearance[index] = Math.min(CLEARANCE_UNREACHABLE, nearest);
    }
  }
}

/**
 * Rebuild the terrain configuration-space fields used by the PATH overlay.
 * `terrainWater` means any water touches the cell (the land
 * exclusion input); `terrainSubmerged` means the whole cell is below water
 * (the water-only occupancy input).
 */
export function rebuildPathfindingDebugGrid(
  grid: PathfindingDebugGrid,
  input: PathfindingDebugGridInput,
): void {
  const { cellsX, cellsY, terrainWater, terrainSubmerged } = input;
  const cellCount = cellsX * cellsY;
  const waterBuffer = PATHFINDING_WATER_BUFFER_CELLS;

  grid.waterBlocked.fill(0, 0, cellCount);
  grid.edgeBlocked.fill(0, 0, cellCount);
  for (let gy = 0; gy < cellsY; gy++) {
    for (let gx = 0; gx < cellsX; gx++) {
      const index = gy * cellsX + gx;
      const atEdge = waterBuffer > 0 &&
        (gx < waterBuffer || gy < waterBuffer ||
          gx >= cellsX - waterBuffer || gy >= cellsY - waterBuffer);
      if (atEdge) {
        grid.edgeBlocked[index] = 1;
        grid.waterBlocked[index] = 1;
        continue;
      }
      let blockedByWater = false;
      for (let dy = -waterBuffer; dy <= waterBuffer && !blockedByWater; dy++) {
        const rowOffset = (gy + dy) * cellsX;
        for (let dx = -waterBuffer; dx <= waterBuffer; dx++) {
          if (terrainWater[rowOffset + gx + dx] !== 0) {
            blockedByWater = true;
            break;
          }
        }
      }
      grid.waterBlocked[index] = blockedByWater ? 1 : 0;
    }
  }

  for (let index = 0; index < cellCount; index++) {
    grid.groundClearance[index] = grid.waterBlocked[index] !== 0
      ? 0
      : CLEARANCE_UNREACHABLE;
    grid.mediumClearance[index] = grid.edgeBlocked[index] !== 0
      ? 0
      : CLEARANCE_UNREACHABLE;
    grid.waterClearance[index] = terrainSubmerged[index] === 0 ||
      grid.edgeBlocked[index] !== 0
      ? 0
      : CLEARANCE_UNREACHABLE;
  }
  rebuildClearanceDistance(grid.groundClearance, cellsX, cellsY);
  rebuildClearanceDistance(grid.mediumClearance, cellsX, cellsY);
  rebuildClearanceDistance(grid.waterClearance, cellsX, cellsY);
}

function isWaterOnlyTraversal(domain: UnitNavigationDomain): boolean {
  return !domain.allowInAir && domain.allowInWater && !domain.allowOnGround;
}

function rebuildDomainPassability(
  output: Uint8Array,
  domain: UnitNavigationDomain,
  input: PathfindingDebugPassabilityInput,
): void {
  const {
    grid,
    terrainWater,
    terrainSubmerged,
    terrainNormalZ,
    traversal: debugTraversal,
    cellsX,
    cellsY,
  } = input;
  const { requiredNormalZ, hardClearanceCells } = debugTraversal;
  const waterOnly = isWaterOnlyTraversal(domain);
  const requiredWaterClearance = pathfinderRequiredWaterClearanceCells(hardClearanceCells);
  const cellCount = cellsX * cellsY;

  for (let index = 0; index < cellCount; index++) {
    let passable = domain.allowInAir;
    if (!passable) {
      if (grid.edgeBlocked[index] !== 0) {
        passable = false;
      } else if (waterOnly && terrainSubmerged[index] === 0) {
        passable = false;
      } else {
        const wet = terrainWater[index] !== 0;
        const terrainBlocked = grid.waterBlocked[index] !== 0;
        const passableByMedium = wet
          ? domain.allowInWater
          : terrainBlocked
            ? domain.allowInWater && domain.allowOnGround
            : domain.allowOnGround;
        const clearance = waterOnly
          ? grid.waterClearance[index]
          : wet || domain.allowInWater
            ? grid.mediumClearance[index]
            : grid.groundClearance[index];
        const requiredClearance = waterOnly
          ? requiredWaterClearance
          : hardClearanceCells;
        const terrainPassable = wet && domain.allowInWater
          ? true
          : terrainNormalZ[index] >= requiredNormalZ;
        passable = passableByMedium && clearance >= requiredClearance && terrainPassable;
      }
    }
    output[index] = passable ? 1 : 0;
  }
}

/** Fill both visible validity masks from their independent domains. */
export function rebuildPathfindingDebugPassability(
  input: PathfindingDebugPassabilityInput,
): void {
  rebuildDomainPassability(input.grid.waypointPassable, input.traversal.traversal.waypoint, input);
  rebuildDomainPassability(input.grid.movePassable, input.traversal.traversal.move, input);
}
