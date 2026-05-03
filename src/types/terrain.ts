/** Three named terrain shapes selectable from the lobby:
 *    - 'lake'     → negative amplitude: terrain dips below ground
 *                   level. Combined with WATER_LEVEL the basin
 *                   floods to make a body of water.
 *    - 'mountain' → positive amplitude: terrain rises above ground
 *                   level. No water (terrain stays above
 *                   WATER_LEVEL everywhere).
 *    - 'flat'     → zero amplitude: that component is suppressed,
 *                   leaving featureless ground. */
export type TerrainShape = 'lake' | 'mountain' | 'flat';
export type TerrainMapShape = 'square' | 'circle';

/** Shared sign convention for terrain-shaped height features.
 *  LAKE cuts below ground, MOUNTAIN rises above ground, FLAT removes
 *  the feature. */
export function terrainShapeSign(shape: TerrainShape): -1 | 0 | 1 {
  switch (shape) {
    case 'lake': return -1;
    case 'mountain': return 1;
    case 'flat': return 0;
    default: throw new Error(`Unknown terrain shape: ${shape as string}`);
  }
}
