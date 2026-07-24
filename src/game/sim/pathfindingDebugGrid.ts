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
import { GRAVITY } from '@/config';

const CLEARANCE_UNREACHABLE = 0xffff;
const PATHFINDER_MAP_EDGE_BUFFER_CELLS = 2;

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
  requiredGroundNormalZ: number;
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

export function createPathfindingDebugTraversal(
  terrainFilter: PathTerrainFilter | null,
  unitRadius: number,
  cellSize: number,
): PathfindingDebugTraversal {
  const traversal = resolvePathfinderTraversalInput(terrainFilter);
  return {
    traversal,
    requiredGroundNormalZ: traversal.minGroundNormalZ,
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
 * `terrainWater` means the cell contains water; `terrainSubmerged` means it
 * contains no exposed terrain. A mixed cell has `terrainWater=1` and
 * `terrainSubmerged=0` and therefore exercises both medium cases.
 */
export function rebuildPathfindingDebugGrid(
  grid: PathfindingDebugGrid,
  input: PathfindingDebugGridInput,
): void {
  const { cellsX, cellsY, terrainWater, terrainSubmerged } = input;
  const cellCount = cellsX * cellsY;

  grid.waterBlocked.fill(0, 0, cellCount);
  grid.edgeBlocked.fill(0, 0, cellCount);
  for (let gy = 0; gy < cellsY; gy++) {
    for (let gx = 0; gx < cellsX; gx++) {
      const index = gy * cellsX + gx;
      const edgeBlocked =
        gx < PATHFINDER_MAP_EDGE_BUFFER_CELLS ||
        gy < PATHFINDER_MAP_EDGE_BUFFER_CELLS ||
        gx >= cellsX - PATHFINDER_MAP_EDGE_BUFFER_CELLS ||
        gy >= cellsY - PATHFINDER_MAP_EDGE_BUFFER_CELLS;
      grid.edgeBlocked[index] = edgeBlocked ? 1 : 0;
      grid.waterBlocked[index] =
        edgeBlocked || terrainWater[index] !== 0 ? 1 : 0;
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
  for (let gy = 0; gy < cellsY; gy++) {
    for (let gx = 0; gx < cellsX; gx++) {
      const index = gy * cellsX + gx;
      const edgeClearance = Math.max(
        0,
        Math.min(gx + 1, gy + 1, cellsX - gx, cellsY - gy),
      );
      grid.groundClearance[index] = Math.min(
        grid.groundClearance[index],
        edgeClearance,
      );
      grid.mediumClearance[index] = Math.min(
        grid.mediumClearance[index],
        edgeClearance,
      );
      grid.waterClearance[index] = Math.min(
        grid.waterClearance[index],
        edgeClearance,
      );
    }
  }
}

function allowsExposedCase(domain: UnitNavigationDomain): boolean {
  return domain.allowOnGround || domain.allowInAir;
}

/** Mirrors the monotone Coulomb + fluid force solve in Rust. */
function maxContactSlopeNormalZ(
  safeGroundAccel: number,
  safeWaterAccel: number,
  staticFrictionCoefficient: number,
): number {
  const ground = Math.max(0, safeGroundAccel);
  const water = Math.max(0, safeWaterAccel);
  const mu = Math.max(0, staticFrictionCoefficient);
  const halfPi = Math.PI * 0.5;
  const margin = (theta: number): number =>
    Math.min(ground, mu * GRAVITY * Math.max(0, Math.cos(theta))) + water -
    GRAVITY * Math.sin(theta);
  if (margin(halfPi) >= -1e-12) return 0;
  let low = 0;
  let high = halfPi;
  for (let i = 0; i < 64; i++) {
    const mid = (low + high) * 0.5;
    if (margin(mid) >= 0) low = mid;
    else high = mid;
  }
  return Math.cos(low);
}

function requiredWaterNormalZForCell(
  debugTraversal: PathfindingDebugTraversal,
  domain: UnitNavigationDomain,
  requireWaypointHold: boolean,
): number {
  const traversal = debugTraversal.traversal;
  if (domain.allowInAir || traversal.waterSurfaceSupported || !domain.allowOnGround) return 0;
  if (
    traversal.minGroundNormalZ <= 0 &&
    traversal.safeDriveAccel <= 0 &&
    traversal.safeWaterDriveAccel <= 0 &&
    traversal.staticFrictionCoefficient <= 0
  ) return 0;
  let required = maxContactSlopeNormalZ(
    traversal.safeDriveAccel,
    traversal.safeWaterDriveAccel,
    traversal.staticFrictionCoefficient,
  );
  if (requireWaypointHold) {
    required = Math.max(
      required,
      Math.cos(Math.atan(Math.max(0, traversal.staticFrictionCoefficient))),
    );
  }
  return Math.max(0, Math.min(1, required));
}

function rebuildDomainPassability(
  output: Uint8Array,
  domain: UnitNavigationDomain,
  requireWaypointHold: boolean,
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
  const { requiredGroundNormalZ, hardClearanceCells } = debugTraversal;
  const exposedAllowed = allowsExposedCase(domain);
  const cellCount = cellsX * cellsY;

  for (let index = 0; index < cellCount; index++) {
    const hasWater = terrainWater[index] !== 0;
    const hasExposed = terrainSubmerged[index] === 0;
    const passableByMedium =
      (domain.allowInAir || grid.edgeBlocked[index] === 0) &&
      (!hasExposed || exposedAllowed) &&
      (!hasWater || domain.allowInWater);
    const clearance = domain.allowInWater && !exposedAllowed
      ? grid.waterClearance[index]
      : domain.allowInWater && exposedAllowed
        ? grid.mediumClearance[index]
        : grid.groundClearance[index];
    const requiredClearance = domain.allowInAir ? 0 : hardClearanceCells;
    let requiredNormalZ = hasExposed && !domain.allowInAir
      ? requiredGroundNormalZ
      : 0;
    if (hasWater && domain.allowInWater && !domain.allowInAir) {
      requiredNormalZ = Math.max(
        requiredNormalZ,
        requiredWaterNormalZForCell(
          debugTraversal,
          domain,
          requireWaypointHold,
        ),
      );
    }
    const terrainPassable = terrainNormalZ[index] >= requiredNormalZ;
    const passable =
      passableByMedium &&
      clearance >= requiredClearance &&
      terrainPassable;
    output[index] = passable ? 1 : 0;
  }
}

/** Fill both visible validity masks from their independent domains. */
export function rebuildPathfindingDebugPassability(
  input: PathfindingDebugPassabilityInput,
): void {
  rebuildDomainPassability(
    input.grid.waypointPassable,
    input.traversal.traversal.waypoint,
    true,
    input,
  );
  rebuildDomainPassability(
    input.grid.movePassable,
    input.traversal.traversal.move,
    false,
    input,
  );
}
