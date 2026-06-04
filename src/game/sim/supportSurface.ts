import type { EntityId } from './types';
import { UNIT_GROUND_CONTACT_EPSILON } from './unitGroundPhysics';

export type SupportSurfaceKind = 'terrain' | 'water' | 'building' | 'unit';
export type SupportSurfaceMaterialKind = 'solid' | 'water';

export type WorldSupportSurface = {
  groundZ: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  supportEntityId: EntityId | null;
  supportKind: SupportSurfaceKind;
  materialKind: SupportSurfaceMaterialKind;
  supportVelocityX: number;
  supportVelocityY: number;
  supportVelocityZ: number;
  walkable: boolean;
  sourceKey: number;
};

export const SUPPORT_SURFACE_CONTACT_EPSILON = Math.max(UNIT_GROUND_CONTACT_EPSILON, 1);
export const SUPPORT_SURFACE_VERTICAL_PROBE = 8;
export const SUPPORT_SURFACE_FOOTPRINT_EPSILON = 0.5;

export function createWorldSupportSurface(): WorldSupportSurface {
  return {
    groundZ: 0,
    normalX: 0,
    normalY: 0,
    normalZ: 1,
    supportEntityId: null,
    supportKind: 'terrain',
    materialKind: 'solid',
    supportVelocityX: 0,
    supportVelocityY: 0,
    supportVelocityZ: 0,
    walkable: true,
    sourceKey: 0,
  };
}

export function writeTerrainSupportSurface(
  out: WorldSupportSurface,
  groundZ: number,
  normal: { nx: number; ny: number; nz: number },
  inWater: boolean,
  sourceKey: number,
): WorldSupportSurface {
  out.groundZ = groundZ;
  out.normalX = inWater ? 0 : normal.nx;
  out.normalY = inWater ? 0 : normal.ny;
  out.normalZ = inWater ? 1 : normal.nz;
  out.supportEntityId = null;
  out.supportKind = inWater ? 'water' : 'terrain';
  out.materialKind = inWater ? 'water' : 'solid';
  out.supportVelocityX = 0;
  out.supportVelocityY = 0;
  out.supportVelocityZ = 0;
  out.walkable = !inWater;
  out.sourceKey = sourceKey;
  return out;
}

export function writeBuildingSupportSurface(
  out: WorldSupportSurface,
  groundZ: number,
  supportEntityId: EntityId | null,
  sourceKey: number,
): WorldSupportSurface {
  out.groundZ = groundZ;
  out.normalX = 0;
  out.normalY = 0;
  out.normalZ = 1;
  out.supportEntityId = supportEntityId;
  out.supportKind = 'building';
  out.materialKind = 'solid';
  out.supportVelocityX = 0;
  out.supportVelocityY = 0;
  out.supportVelocityZ = 0;
  out.walkable = true;
  out.sourceKey = sourceKey;
  return out;
}

export function writeUnitSupportSurface(
  out: WorldSupportSurface,
  groundZ: number,
  supportEntityId: EntityId | null,
  sourceKey: number,
  supportVelocity: { x: number; y: number; z: number } | undefined = undefined,
): WorldSupportSurface {
  return writeUnitSupportSurfaceVelocity(
    out,
    groundZ,
    supportEntityId,
    sourceKey,
    supportVelocity?.x ?? 0,
    supportVelocity?.y ?? 0,
    supportVelocity?.z ?? 0,
  );
}

export function writeUnitSupportSurfaceVelocity(
  out: WorldSupportSurface,
  groundZ: number,
  supportEntityId: EntityId | null,
  sourceKey: number,
  supportVelocityX: number = 0,
  supportVelocityY: number = 0,
  supportVelocityZ: number = 0,
): WorldSupportSurface {
  out.groundZ = groundZ;
  out.normalX = 0;
  out.normalY = 0;
  out.normalZ = 1;
  out.supportEntityId = supportEntityId;
  out.supportKind = 'unit';
  out.materialKind = 'solid';
  out.supportVelocityX = supportVelocityX;
  out.supportVelocityY = supportVelocityY;
  out.supportVelocityZ = supportVelocityZ;
  out.walkable = true;
  out.sourceKey = sourceKey;
  return out;
}

export function copyWorldSupportSurface(
  from: WorldSupportSurface,
  out: WorldSupportSurface,
): WorldSupportSurface {
  out.groundZ = from.groundZ;
  out.normalX = from.normalX;
  out.normalY = from.normalY;
  out.normalZ = from.normalZ;
  out.supportEntityId = from.supportEntityId;
  out.supportKind = from.supportKind;
  out.materialKind = from.materialKind;
  out.supportVelocityX = from.supportVelocityX;
  out.supportVelocityY = from.supportVelocityY;
  out.supportVelocityZ = from.supportVelocityZ;
  out.walkable = from.walkable;
  out.sourceKey = from.sourceKey;
  return out;
}
