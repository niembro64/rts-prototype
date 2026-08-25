import { requireSimWasm } from '../sim-wasm/init';
import type { Entity } from './types';
import { getBuildingConfig } from './buildConfigs';
import {
  BUILD_GRID_CELL_SIZE,
  getRotatedBuildingPlacementFootprint,
} from './buildGrid';
import { PATHFINDING_ARRIVAL_RADIUS } from './pathfindingTuning';

const BUILD_TARGET_KIND_POINT = 0;
const BUILD_TARGET_KIND_BUILDING = 1;
const BUILD_TARGET_KIND_UNIT = 2;
const BUILD_FOOTPRINT_CLEARANCE_EPSILON_WORLD = 2;

function getBuildRange(entity: Entity): number {
  return entity.builder !== null ? entity.builder.buildRange : 0;
}

function getBuildTargetHorizontalDistance(builder: Entity, target: Entity): number {
  const sim = requireSimWasm('getBuildTargetHorizontalDistance');
  const building = target.building;
  const unit = target.unit;
  const targetKind = building !== null
    ? BUILD_TARGET_KIND_BUILDING
    : unit !== null
      ? BUILD_TARGET_KIND_UNIT
      : BUILD_TARGET_KIND_POINT;
  return sim.buildTargetHorizontalDistance(
    builder.transform.x,
    builder.transform.y,
    target.transform.x,
    target.transform.y,
    targetKind,
    building !== null ? building.width : 0,
    building !== null ? building.height : 0,
    unit !== null ? unit.radius.collision : 0,
  );
}

export function isBuildTargetInRange(builder: Entity, target: Entity): boolean {
  const range = getBuildRange(builder);
  if (range <= 0) return false;
  return getBuildTargetHorizontalDistance(builder, target) <= range;
}

/** True when the builder's collision disc is completely outside every
 * structural or construction-clearance cell reserved by a building shell.
 * Non-building construction targets (factory unit shells) have no placement
 * footprint and are therefore clear by definition. */
export function isBuilderClearOfBuildFootprint(builder: Entity, target: Entity): boolean {
  const builderRadius = builder.unit?.radius.collision;
  const buildingBlueprintId = target.buildingBlueprintId;
  if (builderRadius === undefined || buildingBlueprintId === null || target.building === null) {
    return true;
  }
  const config = getBuildingConfig(buildingBlueprintId);
  const footprint = getRotatedBuildingPlacementFootprint(
    config.placementFootprint,
    target.transform.rotation,
  );
  const left = target.transform.x - footprint.gridWidth * BUILD_GRID_CELL_SIZE / 2;
  const top = target.transform.y - footprint.gridHeight * BUILD_GRID_CELL_SIZE / 2;
  const clearance = builderRadius + BUILD_FOOTPRINT_CLEARANCE_EPSILON_WORLD;
  const clearanceSq = clearance * clearance;
  const builderX = builder.transform.x;
  const builderY = builder.transform.y;
  for (let i = 0; i < footprint.cells.length; i++) {
    const cell = footprint.cells[i];
    const minX = left + cell.dx * BUILD_GRID_CELL_SIZE;
    const minY = top + cell.dy * BUILD_GRID_CELL_SIZE;
    const closestX = Math.max(minX, Math.min(builderX, minX + BUILD_GRID_CELL_SIZE));
    const closestY = Math.max(minY, Math.min(builderY, minY + BUILD_GRID_CELL_SIZE));
    const dx = builderX - closestX;
    const dy = builderY - closestY;
    if (dx * dx + dy * dy <= clearanceSq) return false;
  }
  return true;
}

export function canApplyConstructionWork(builder: Entity, target: Entity): boolean {
  return isBuildTargetInRange(builder, target) &&
    isBuilderClearOfBuildFootprint(builder, target);
}

/** Deterministic escape/approach point beyond the complete rotated placement
 * bounds. The arrival-radius margin prevents waypoint completion while the
 * builder's collision disc still intersects a reserved cell. */
export function getBuildFootprintClearanceApproachPoint(
  builder: Entity,
  target: Entity,
): { x: number; y: number } | null {
  const builderRadius = builder.unit?.radius.collision;
  const buildingBlueprintId = target.buildingBlueprintId;
  if (builderRadius === undefined || buildingBlueprintId === null || target.building === null) {
    return null;
  }
  const config = getBuildingConfig(buildingBlueprintId);
  const footprint = getRotatedBuildingPlacementFootprint(
    config.placementFootprint,
    target.transform.rotation,
  );
  const halfWidth = footprint.gridWidth * BUILD_GRID_CELL_SIZE / 2 + builderRadius;
  const halfHeight = footprint.gridHeight * BUILD_GRID_CELL_SIZE / 2 + builderRadius;
  let dirX = builder.transform.x - target.transform.x;
  let dirY = builder.transform.y - target.transform.y;
  let length = Math.hypot(dirX, dirY);
  if (length <= 1e-6) {
    dirX = builder.unit?.headingDirX ?? Math.cos(builder.transform.rotation);
    dirY = builder.unit?.headingDirY ?? Math.sin(builder.transform.rotation);
    length = Math.hypot(dirX, dirY);
    if (length <= 1e-6) {
      dirX = 1;
      dirY = 0;
      length = 1;
    }
  }
  dirX /= length;
  dirY /= length;
  const exitX = Math.abs(dirX) > 1e-9 ? halfWidth / Math.abs(dirX) : Infinity;
  const exitY = Math.abs(dirY) > 1e-9 ? halfHeight / Math.abs(dirY) : Infinity;
  const standOff = Math.min(exitX, exitY) +
    PATHFINDING_ARRIVAL_RADIUS + BUILD_FOOTPRINT_CLEARANCE_EPSILON_WORLD;
  return {
    x: target.transform.x + dirX * standOff,
    y: target.transform.y + dirY * standOff,
  };
}

/** The builder's surface-to-surface distance to the target, and its build
 *  range, for callers that aim a NAVIGATION goal at a stand-off inside the
 *  range instead of the (building-blocked) target center. Returns null when
 *  the builder has no range. */
export function getBuildApproachMeasure(
  builder: Entity,
  target: Entity,
): { surfaceDistance: number; range: number } | null {
  const range = getBuildRange(builder);
  if (range <= 0) return null;
  return {
    surfaceDistance: getBuildTargetHorizontalDistance(builder, target),
    range,
  };
}

/** Build-range test against a world point with a circular footprint —
 *  the same surface-to-surface measure entity targets get, for work
 *  targets that are not entities (vegetation props). */
export function isBuildRadiusTargetInRange(
  builder: Entity,
  x: number,
  y: number,
  radius: number,
): boolean {
  const range = getBuildRange(builder);
  if (range <= 0) return false;
  const sim = requireSimWasm('isBuildRadiusTargetInRange');
  return sim.buildTargetHorizontalDistance(
    builder.transform.x,
    builder.transform.y,
    x,
    y,
    BUILD_TARGET_KIND_UNIT,
    0,
    0,
    radius,
  ) <= range;
}
