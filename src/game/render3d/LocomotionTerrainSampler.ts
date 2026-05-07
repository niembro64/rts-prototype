import { LAND_CELL_SIZE } from '../../config';
import type { Entity } from '../sim/types';
import { getSurfaceHeight, getSurfaceNormal } from '../sim/Terrain';

export type LocomotionSurfaceNormal = {
  nx: number;
  ny: number;
  nz: number;
};

export type LocomotionFootSurfaceSample = LocomotionSurfaceNormal & {
  groundY: number;
  visualFootY: number;
};

export function getLocomotionSurfaceNormal(
  entity: Entity,
  mapWidth: number,
  mapHeight: number,
): LocomotionSurfaceNormal {
  return entity.unit?.surfaceNormal ?? getSurfaceNormal(
    entity.transform.x,
    entity.transform.y,
    mapWidth,
    mapHeight,
    LAND_CELL_SIZE,
  );
}

export function getLocomotionSurfaceHeight(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
): number {
  return getSurfaceHeight(x, z, mapWidth, mapHeight, LAND_CELL_SIZE);
}

export function sampleLocomotionFootSurface(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cylinderRadius: number,
  footPadHalfHeight: number,
  clearance: number,
): LocomotionFootSurfaceSample {
  const groundY = getLocomotionSurfaceHeight(x, z, mapWidth, mapHeight);
  const normal = getSurfaceNormal(x, z, mapWidth, mapHeight, LAND_CELL_SIZE);
  const normalY = Math.max(0.35, normal.nz);
  const padVerticalLift = (footPadHalfHeight + clearance) / normalY;
  const cylinderVerticalLift = cylinderRadius + clearance;
  return {
    groundY,
    visualFootY: groundY + Math.max(cylinderVerticalLift, padVerticalLift),
    nx: normal.nx,
    ny: normal.ny,
    nz: normal.nz,
  };
}
