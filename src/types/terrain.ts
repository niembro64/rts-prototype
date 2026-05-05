/** Three named terrain shapes selectable from the lobby:
 *    - 'valley'   → negative amplitude: terrain dips below ground
 *                   level. Combined with WATER_LEVEL the basin
 *                   floods to make a body of water.
 *    - 'mountain' → positive amplitude: terrain rises above ground
 *                   level. No water (terrain stays above
 *                   WATER_LEVEL everywhere).
 *    - 'flat'     → zero amplitude: that component is suppressed,
 *                   leaving featureless ground. */
export type TerrainShape = 'valley' | 'mountain' | 'flat';
export type TerrainMapShape = 'square' | 'circle';

/** Server-authored terrain mesh samples. Heights are row-major
 *  authoritative terrain vertices, not render LOD vertices:
 *  `heights[vy * verticesX + vx]`. */
export type TerrainTileMap = {
  mapWidth: number;
  mapHeight: number;
  cellSize: number;
  subdiv: number;
  cellsX: number;
  cellsY: number;
  verticesX: number;
  verticesY: number;
  version: number;
  heights: number[];
};

/** Shared sign convention for terrain-shaped height features.
 *  VALLEY cuts below ground, MOUNTAIN rises above ground, FLAT removes
 *  the feature. */
export function terrainShapeSign(shape: TerrainShape): -1 | 0 | 1 {
  switch (shape) {
    case 'valley': return -1;
    case 'mountain': return 1;
    case 'flat': return 0;
    default: throw new Error(`Unknown terrain shape: ${shape as string}`);
  }
}
