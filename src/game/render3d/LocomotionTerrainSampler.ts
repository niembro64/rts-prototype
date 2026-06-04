import { LAND_CELL_SIZE } from '../../config';
import type { Entity } from '../sim/types';
import { getSurfaceHeight, getSurfaceNormal } from '../sim/Terrain';
import { sampleBuildingSupportTopZ } from '../sim/buildingSupportSurface';
import { SUPPORT_SURFACE_CONTACT_EPSILON } from '../sim/supportSurface';
import {
  getUnitGroundPenetration,
  isUnitGroundPenetrationInContact,
} from '../sim/unitGroundPhysics';

export type LocomotionSurfaceNormal = {
  nx: number;
  ny: number;
  nz: number;
};

export type LocomotionFootSurfaceSample = LocomotionSurfaceNormal & {
  groundY: number;
  visualFootY: number;
};

/** Per-part floor-clamp result. The visual rig hands in the part's
 *  natural world Y (what it would render at if support weren't a
 *  consideration) and gets back the rendered Y. The clamp is purely
 *  positional — the rig EMAs its movement-position channel toward
 *  this value every frame, no contact bit involved. */
export type LocomotionPartClamp = {
  /** Support height under the part's world XZ. */
  groundY: number;
  /** Where the part should actually render (Y in world units). Equal
   *  to `max(naturalWorldY, groundY + clearance)`. */
  renderedY: number;
};

const locomotionSupportBuildings: Entity[] = [];

export function refreshLocomotionSupportSurfaces(supportEntities: Iterable<Entity>): void {
  locomotionSupportBuildings.length = 0;
  for (const entity of supportEntities) {
    if (entity.building !== null) {
      locomotionSupportBuildings.push(entity);
    }
  }
}

function getVisualBuildingSupportY(x: number, z: number, terrainY: number): number | null {
  let bestTopY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < locomotionSupportBuildings.length; i++) {
    const entity = locomotionSupportBuildings[i];
    const topY = sampleBuildingSupportTopZ(entity, x, z, terrainY);
    if (topY === null) continue;

    if (topY > bestTopY) bestTopY = topY;
  }

  return bestTopY > Number.NEGATIVE_INFINITY ? bestTopY : null;
}

/** Floor-clamp one body-local part (a wheel center, a tread sample, a
 *  hover fan ring) against the support under its world XZ. The clamp
 *  is one-sided: parts can float above the ground but never tunnel
 *  through it. Use a positive `clearance` to push the rendered Y up
 *  by the part's "ground offset" (e.g. wheel radius), so the part's
 *  bottom rests on the support when that term wins. */
export function sampleLocomotionPartClamp(
  worldX: number,
  worldZ: number,
  naturalWorldY: number,
  clearance: number,
  mapWidth: number,
  mapHeight: number,
  out?: LocomotionPartClamp,
): LocomotionPartClamp {
  const groundY = getLocomotionSurfaceHeight(worldX, worldZ, mapWidth, mapHeight);
  const floorY = groundY + clearance;
  const result = out ?? { groundY: 0, renderedY: 0 };
  result.groundY = groundY;
  result.renderedY = naturalWorldY < floorY ? floorY : naturalWorldY;
  return result;
}

export type LocomotionGroundContactSample = {
  grounded: boolean;
  groundY: number;
  penetration: number;
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
  const terrainY = getSurfaceHeight(x, z, mapWidth, mapHeight, LAND_CELL_SIZE);
  return getVisualBuildingSupportY(x, z, terrainY) ?? terrainY;
}

export function sampleLocomotionGroundContact(
  entity: Entity,
  mapWidth: number,
  mapHeight: number,
): LocomotionGroundContactSample {
  const groundY = getLocomotionSurfaceHeight(
    entity.transform.x,
    entity.transform.y,
    mapWidth,
    mapHeight,
  );
  const unit = entity.unit;
  if (!unit) {
    return { grounded: false, groundY, penetration: Number.NEGATIVE_INFINITY };
  }

  const penetration = getUnitGroundPenetration(unit, entity.transform.z, groundY);
  const suspensionAllowsContact = unit.suspension?.legContact !== false;
  return {
    grounded:
      suspensionAllowsContact &&
      isUnitGroundPenetrationInContact(penetration),
    groundY,
    penetration,
  };
}

export function isLocomotionGrounded(
  entity: Entity,
  mapWidth: number,
  mapHeight: number,
): boolean {
  return sampleLocomotionGroundContact(entity, mapWidth, mapHeight).grounded;
}

export function sampleLocomotionFootSurface(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cylinderRadius: number,
  footPadHalfHeight: number,
  clearance: number,
  out?: LocomotionFootSurfaceSample,
): LocomotionFootSurfaceSample {
  const groundY = getLocomotionSurfaceHeight(x, z, mapWidth, mapHeight);
  const result = out ?? {
    groundY: 0,
    visualFootY: 0,
    nx: 0,
    ny: 0,
    nz: 1,
  };
  const terrainY = getSurfaceHeight(x, z, mapWidth, mapHeight, LAND_CELL_SIZE);
  if (groundY > terrainY + SUPPORT_SURFACE_CONTACT_EPSILON) {
    result.nx = 0;
    result.ny = 0;
    result.nz = 1;
  } else {
    getSurfaceNormal(x, z, mapWidth, mapHeight, LAND_CELL_SIZE, result);
  }
  const normalY = Math.max(0.35, result.nz);
  const padVerticalLift = (footPadHalfHeight + clearance) / normalY;
  const cylinderVerticalLift = cylinderRadius + clearance;
  result.groundY = groundY;
  result.visualFootY = groundY + Math.max(cylinderVerticalLift, padVerticalLift);
  return result;
}
