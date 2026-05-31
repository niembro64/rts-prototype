import type { Entity } from './types';
import { getTransformCosSin } from '../math';
import { getBuildingConfig } from './buildConfigs';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';
import { getSimWasm } from '../sim-wasm/init';

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
const FACTORY_BUILD_SPOT_STRIDE = 7;
const _buildSpotKernelOut = new Float64Array(FACTORY_BUILD_SPOT_STRIDE);

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
  writeFactoryBuildSpotKernel(factory, 0, null, _buildSpotKernelOut);
  out.x = _buildSpotKernelOut[4];
  out.y = _buildSpotKernelOut[5];
}

function writeFactoryBuildSpotKernel(
  factory: Entity,
  unitRadius: number,
  options: FactoryBuildSpotOptions | null,
  out: Float64Array,
): void {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('getFactoryBuildSpot: sim-wasm is not initialized');
  }

  const dims = getFactoryFootprintDimensions();
  const factoryComp = factory.factory;
  const rallyX = factoryComp === null
    ? factory.transform.x + 1
    : factoryComp.rallyX;
  const rallyY = factoryComp === null
    ? factory.transform.y
    : factoryComp.rallyY;
  const { cos, sin } = getTransformCosSin(factory.transform);
  const mapWidth = options === null || options.mapWidth === null
    ? Number.NaN
    : options.mapWidth;
  const mapHeight = options === null || options.mapHeight === null
    ? Number.NaN
    : options.mapHeight;
  const clampRadius = Math.max(
    0,
    options === null || options.clampRadius === null ? unitRadius : options.clampRadius,
  );

  if (sim.factoryBuildSpot(
    factory.transform.x,
    factory.transform.y,
    rallyX,
    rallyY,
    cos,
    sin,
    unitRadius,
    dims.footprintWidth,
    dims.footprintHeight,
    dims.constructionRadius,
    FACTORY_BUILD_CLEARANCE,
    FACTORY_BUILD_RADIUS_FRACTION,
    mapWidth,
    mapHeight,
    clampRadius,
    out,
  ) === 0) {
    throw new Error('getFactoryBuildSpot: factory_build_spot rejected its output buffer');
  }
}

export function getFactoryBuildSpot(
  factory: Entity,
  unitRadius: number = 0,
  options: FactoryBuildSpotOptions | null = null,
  out: FactoryBuildSpot | null = null,
): FactoryBuildSpot {
  writeFactoryBuildSpotKernel(factory, unitRadius, options, _buildSpotKernelOut);
  const result = out ?? {
    x: 0,
    y: 0,
    localX: 0,
    localY: 0,
    dirX: 0,
    dirY: 0,
    offset: 0,
  };
  result.x = _buildSpotKernelOut[0];
  result.y = _buildSpotKernelOut[1];
  result.localX = _buildSpotKernelOut[2];
  result.localY = _buildSpotKernelOut[3];
  result.dirX = _buildSpotKernelOut[4];
  result.dirY = _buildSpotKernelOut[5];
  result.offset = _buildSpotKernelOut[6];
  return result;
}
