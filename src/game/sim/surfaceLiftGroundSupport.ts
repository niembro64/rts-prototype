import type { WorldSupportSurface } from './supportSurface';

/** Surface-lift ground means solid support, never the presentation water
 * plane. A real solid support may still sit above the terrain bed. */
export function resolveSurfaceLiftGroundZ(
  sampledSupport: Pick<WorldSupportSurface, 'groundZ' | 'materialKind'>,
  terrainBedZ: number,
): number {
  return sampledSupport.materialKind === 'water'
    ? terrainBedZ
    : sampledSupport.groundZ;
}
