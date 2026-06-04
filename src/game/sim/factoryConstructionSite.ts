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
  /** Local-space center-bay offset from the fabricator root. */
  localX: number;
  localY: number;
  /** Rally-facing direction retained for callers that need a heading. */
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
const _buildSpotDir = { x: 0, y: 0 };

export function getFactoryFootprintDimensions(): FactoryFootprintDimensions {
  const cfg = getBuildingConfig('towerFabricator');
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
  const rallyX = factoryComp === null
    ? factory.transform.x + 1
    : factoryComp.rallyX;
  const rallyY = factoryComp === null
    ? factory.transform.y
    : factoryComp.rallyY;
  const dx = rallyX - factory.transform.x;
  const dy = rallyY - factory.transform.y;
  const len = Math.hypot(dx, dy);
  if (len > 1e-6) {
    out.x = dx / len;
    out.y = dy / len;
    return;
  }
  const { cos, sin } = getTransformCosSin(factory.transform);
  out.x = cos;
  out.y = sin;
}

export function getFactoryBuildSpot(
  factory: Entity,
  _unitRadius: number = 0,
  _options: FactoryBuildSpotOptions | null = null,
  out: FactoryBuildSpot | null = null,
): FactoryBuildSpot {
  const result = out ?? {
    x: 0,
    y: 0,
    localX: 0,
    localY: 0,
    dirX: 0,
    dirY: 0,
    offset: 0,
  };
  writeFactoryWaypointDirection(factory, _buildSpotDir);
  result.x = factory.transform.x;
  result.y = factory.transform.y;
  result.localX = 0;
  result.localY = 0;
  result.dirX = _buildSpotDir.x;
  result.dirY = _buildSpotDir.y;
  result.offset = 0;
  return result;
}
