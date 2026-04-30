import type { Entity } from './types';
import { getBuildingConfig } from './buildConfigs';
import { GRID_CELL_SIZE } from './grid';

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
  mapWidth?: number;
  mapHeight?: number;
  clampRadius?: number;
};

const FACTORY_CONSTRUCTION_RADIUS_CELLS = 6;
const FACTORY_BUILD_CLEARANCE = 16;
const FACTORY_BUILD_RADIUS_FRACTION = 0.72;
const _buildSpotDir = { x: 0, y: 0 };

export function getFactoryFootprintDimensions(): FactoryFootprintDimensions {
  const cfg = getBuildingConfig('factory');
  return {
    footprintWidth: cfg.gridWidth * GRID_CELL_SIZE,
    footprintHeight: cfg.gridHeight * GRID_CELL_SIZE,
    footprintDepth: cfg.gridDepth * GRID_CELL_SIZE,
    constructionRadius: getFactoryConstructionRadius(),
  };
}

export function getFactoryConstructionRadius(): number {
  return FACTORY_CONSTRUCTION_RADIUS_CELLS * GRID_CELL_SIZE;
}

export function getFactoryWaypointDirection(factory: Entity): { x: number; y: number } {
  writeFactoryWaypointDirection(factory, _buildSpotDir);
  return { x: _buildSpotDir.x, y: _buildSpotDir.y };
}

function writeFactoryWaypointDirection(factory: Entity, out: { x: number; y: number }): void {
  const factoryComp = factory.factory;
  const waypoint = factoryComp?.waypoints[0];
  const targetX = waypoint?.x ?? factoryComp?.rallyX ?? factory.transform.x + 1;
  const targetY = waypoint?.y ?? factoryComp?.rallyY ?? factory.transform.y;
  let dx = targetX - factory.transform.x;
  let dy = targetY - factory.transform.y;
  let len = Math.hypot(dx, dy);
  if (len < 1e-3) {
    dx = Math.cos(factory.transform.rotation);
    dy = Math.sin(factory.transform.rotation);
    len = Math.max(1e-3, Math.hypot(dx, dy));
  }
  out.x = dx / len;
  out.y = dy / len;
}

export function getFactoryBuildSpot(
  factory: Entity,
  unitRadius: number = 0,
  options: FactoryBuildSpotOptions = {},
  out?: FactoryBuildSpot,
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
  const clampRadius = Math.max(0, options.clampRadius ?? unitRadius);
  let x = factory.transform.x + localX;
  let y = factory.transform.y + localY;
  if (options.mapWidth !== undefined && Number.isFinite(options.mapWidth)) {
    x = Math.max(clampRadius, Math.min(options.mapWidth - clampRadius, x));
  }
  if (options.mapHeight !== undefined && Number.isFinite(options.mapHeight)) {
    y = Math.max(clampRadius, Math.min(options.mapHeight - clampRadius, y));
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
