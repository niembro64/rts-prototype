import type { Entity } from './types';
import { getTransformCosSin } from '../math';
import { getBuildingConfig } from './buildConfigs';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';

export type FactoryFootprintDimensions = {
  footprintWidth: number;
  footprintHeight: number;
  footprintDepth: number;
  constructionRadius: number;
};

export type FactoryBuildSpot = {
  x: number;
  y: number;
  localX: number;
  localY: number;
  dirX: number;
  dirY: number;
  offset: number;
};

export type FactoryBuildSpotOptions = {
  mapWidth: number | null;
  mapHeight: number | null;
  clampRadius: number | null;
};

const FACTORY_CONSTRUCTION_RADIUS_CELLS = 6;
const FACTORY_BUILD_CLEARANCE = 16;
const FACTORY_BUILD_RADIUS_FRACTION = 0.72;
const _buildSpotDir = { x: 0, y: 0 };

export function getFactoryFootprintDimensions(): FactoryFootprintDimensions {
  const cfg = getBuildingConfig('factory');
  return {
    footprintWidth: cfg.gridWidth * BUILD_GRID_CELL_SIZE,
    footprintHeight: cfg.gridHeight * BUILD_GRID_CELL_SIZE,
    footprintDepth: cfg.gridDepth * BUILD_GRID_CELL_SIZE,
    constructionRadius: getFactoryConstructionRadius(),
  };
}

export function getFactoryConstructionRadius(): number {
  return FACTORY_CONSTRUCTION_RADIUS_CELLS * BUILD_GRID_CELL_SIZE;
}

export function getFactoryWaypointDirection(factory: Entity): { x: number; y: number } {
  writeFactoryWaypointDirection(factory, _buildSpotDir);
  return { x: _buildSpotDir.x, y: _buildSpotDir.y };
}

function writeFactoryWaypointDirection(factory: Entity, out: { x: number; y: number }): void {
  const factoryComp = factory.factory;
  const waypoint = factoryComp === null || factoryComp.waypoints.length === 0
    ? null
    : factoryComp.waypoints[0];
  const targetX = waypoint !== null
    ? waypoint.x
    : factoryComp === null
      ? factory.transform.x + 1
      : factoryComp.rallyX;
  const targetY = waypoint !== null
    ? waypoint.y
    : factoryComp === null
      ? factory.transform.y
      : factoryComp.rallyY;
  let dx = targetX - factory.transform.x;
  let dy = targetY - factory.transform.y;
  let len = Math.hypot(dx, dy);
  if (len < 1e-3) {
    const { cos, sin } = getTransformCosSin(factory.transform);
    dx = cos;
    dy = sin;
    len = Math.max(1e-3, Math.hypot(dx, dy));
  }
  out.x = dx / len;
  out.y = dy / len;
}

export function getFactoryBuildSpot(
  factory: Entity,
  unitRadius: number = 0,
  options: FactoryBuildSpotOptions | null = null,
  out: FactoryBuildSpot | null = null,
): FactoryBuildSpot {
  const dims = getFactoryFootprintDimensions();
  const dir = _buildSpotDir;
  writeFactoryWaypointDirection(factory, dir);
  const edgeAlongDir = Math.min(
    Math.abs(dir.x) > 1e-3 ? dims.footprintWidth / 2 / Math.abs(dir.x) : Number.POSITIVE_INFINITY,
    Math.abs(dir.y) > 1e-3 ? dims.footprintHeight / 2 / Math.abs(dir.y) : Number.POSITIVE_INFINITY,
  );
  const outsideFootprint = edgeAlongDir + Math.max(0, unitRadius) + FACTORY_BUILD_CLEARANCE;
  const preferredOffset = dims.constructionRadius * FACTORY_BUILD_RADIUS_FRACTION;
  const offset = Math.min(dims.constructionRadius, Math.max(outsideFootprint, preferredOffset));
  const localX = dir.x * offset;
  const localY = dir.y * offset;
  const mapWidth = options === null ? null : options.mapWidth;
  const mapHeight = options === null ? null : options.mapHeight;
  const clampRadius = Math.max(
    0,
    options === null || options.clampRadius === null ? unitRadius : options.clampRadius,
  );
  let x = factory.transform.x + localX;
  let y = factory.transform.y + localY;
  if (mapWidth !== null && Number.isFinite(mapWidth)) {
    x = Math.max(clampRadius, Math.min(mapWidth - clampRadius, x));
  }
  if (mapHeight !== null && Number.isFinite(mapHeight)) {
    y = Math.max(clampRadius, Math.min(mapHeight - clampRadius, y));
  }
  const result = out ?? {
    x: 0,
    y: 0,
    localX: 0,
    localY: 0,
    dirX: 0,
    dirY: 0,
    offset: 0,
  };
  result.x = x;
  result.y = y;
  result.localX = x - factory.transform.x;
  result.localY = y - factory.transform.y;
  result.dirX = dir.x;
  result.dirY = dir.y;
  result.offset = offset;
  return result;
}
