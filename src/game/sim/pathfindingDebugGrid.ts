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
import { PATHFINDING_WATER_BUFFER_CELLS } from './pathfindingTuning';
import { GRAVITY } from '@/config';
import { WATER_LEVEL } from './terrain/terrainConfig';

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
  requiredGroundNormalZ: number;
  bodyRadius: number;
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
  terrainMaxHeight: Float32Array;
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
    requiredGroundNormalZ: traversal.minGroundNormalZ,
    bodyRadius: Number.isFinite(unitRadius) && unitRadius > 0 ? unitRadius : 0.5,
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

function sphericalWaterFraction(originZ: number, radius: number): number {
  if (!Number.isFinite(originZ)) return 0;
  const safeRadius = Number.isFinite(radius) && radius > 0 ? radius : 0.5;
  const submergedHeight = Math.max(
    0,
    Math.min(2 * safeRadius, WATER_LEVEL - (originZ - safeRadius)),
  );
  if (submergedHeight <= 0) return 0;
  if (submergedHeight >= 2 * safeRadius) return 1;
  return Math.max(
    0,
    Math.min(
      1,
      submergedHeight * submergedHeight * (3 * safeRadius - submergedHeight) /
        (4 * safeRadius * safeRadius * safeRadius),
    ),
  );
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
  terrainMaxHeight: number,
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
  const waterFraction = sphericalWaterFraction(
    terrainMaxHeight + traversal.supportPointOffsetZ,
    debugTraversal.bodyRadius,
  );
  let required = maxContactSlopeNormalZ(
    traversal.safeDriveAccel,
    traversal.safeWaterDriveAccel * waterFraction,
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
    terrainMaxHeight,
    traversal: debugTraversal,
    cellsX,
    cellsY,
  } = input;
  const { requiredGroundNormalZ, hardClearanceCells } = debugTraversal;
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
        const requiredNormalZ = wet && domain.allowInWater
          ? requiredWaterNormalZForCell(
              debugTraversal,
              domain,
              terrainMaxHeight[index],
              requireWaypointHold,
            )
          : requiredGroundNormalZ;
        const terrainPassable = terrainNormalZ[index] >= requiredNormalZ;
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
