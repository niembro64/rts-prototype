import { LAND_CELL_SIZE } from '../../config';
import type { Entity, EntityId } from '../sim/types';
import {
  getSurfaceHeight,
  getSurfaceNormal,
  getTerrainVersion,
  isWaterAt,
} from '../sim/Terrain';
import { SupportSurfaceIndex } from '../sim/supportSurfaceIndex';
import {
  createWorldSupportSurface,
  writeTerrainSupportSurface,
  type WorldSupportSurface,
} from '../sim/supportSurface';
import {
  getUnitGroundPenetration,
  isUnitGroundPenetrationInContact,
} from '../sim/unitGroundPhysics';

export type LocomotionSurfaceNormal = {
  nx: number;
  ny: number;
  nz: number;
};

export type LocomotionFootSurfaceSample = {
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

const locomotionSupportIndex = new SupportSurfaceIndex();

export function refreshLocomotionSupportSurfaces(supportEntities: Iterable<Entity>): void {
  locomotionSupportIndex.rebuild(supportEntities);
}

function getVisualSupportY(
  x: number,
  z: number,
  terrainY: number,
  ignoreEntityId: EntityId | null,
): number | null {
  return locomotionSupportIndex.sampleSupportTopZ(x, z, terrainY, { ignoreEntityId });
}

export function sampleLocomotionSupportSurface(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  bodyY: number | undefined = undefined,
  groundOffset: number | undefined = undefined,
  ignoreEntityId: EntityId | null = null,
  out: WorldSupportSurface = createWorldSupportSurface(),
): WorldSupportSurface {
  const terrainY = getSurfaceHeight(x, z, mapWidth, mapHeight, LAND_CELL_SIZE);
  writeTerrainSupportSurface(
    out,
    terrainY,
    getSurfaceNormal(x, z, mapWidth, mapHeight, LAND_CELL_SIZE),
    isWaterAt(x, z, mapWidth, mapHeight),
    getTerrainVersion(),
  );
  locomotionSupportIndex.sampleSupportSurface(
    x,
    z,
    terrainY,
    bodyY !== undefined && Number.isFinite(bodyY)
      ? { bodyZ: bodyY, groundOffset: groundOffset ?? 0, ignoreEntityId }
      : { ignoreEntityId },
    out,
  );
  return out;
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
  ignoreEntityId?: EntityId | null,
  out?: LocomotionPartClamp,
): LocomotionPartClamp {
  const groundY = getLocomotionSurfaceHeight(
    worldX,
    worldZ,
    mapWidth,
    mapHeight,
    ignoreEntityId,
  );
  const floorY = groundY + clearance;
  const result = out ?? { groundY: 0, renderedY: 0 };
  result.groundY = groundY;
  result.renderedY = naturalWorldY < floorY ? floorY : naturalWorldY;
  return result;
}

type LocomotionGroundContactSample = {
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
  ignoreEntityId?: EntityId | null,
): number {
  const terrainY = getSurfaceHeight(x, z, mapWidth, mapHeight, LAND_CELL_SIZE);
  return getVisualSupportY(x, z, terrainY, ignoreEntityId ?? null) ?? terrainY;
}

function sampleLocomotionGroundContact(
  entity: Entity,
  mapWidth: number,
  mapHeight: number,
): LocomotionGroundContactSample {
  const groundY = getLocomotionSurfaceHeight(
    entity.transform.x,
    entity.transform.y,
    mapWidth,
    mapHeight,
    entity.id,
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
  clearance: number,
  ignoreEntityId?: EntityId | null,
  out?: LocomotionFootSurfaceSample,
): LocomotionFootSurfaceSample {
  const groundY = getLocomotionSurfaceHeight(x, z, mapWidth, mapHeight, ignoreEntityId);
  const result = out ?? {
    groundY: 0,
    visualFootY: 0,
  };
  result.groundY = groundY;
  result.visualFootY = groundY + cylinderRadius + clearance;
  return result;
}
