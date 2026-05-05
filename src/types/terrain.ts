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
 *  `heights[vy * verticesX + vx]`.
 *
 *  IMMUTABILITY CONTRACT: a TerrainTileMap is built once per match
 *  by `buildTerrainTileMap` and is never mutated thereafter. The
 *  authoritative-state setter (`setAuthoritativeTerrainTileMap`)
 *  bumps `version` whenever a fresh map replaces an old one.
 *  Snapshot cloning shares the SAME object reference across the
 *  source snapshot and any in-process clones — `cloneTerrainTileMap`
 *  is a passthrough. The `readonly` markers below make any
 *  accidental mutation a compile-time error so the assumption can't
 *  silently rot. */
export type TerrainTileMap = {
  readonly mapWidth: number;
  readonly mapHeight: number;
  readonly cellSize: number;
  readonly subdiv: number;
  readonly cellsX: number;
  readonly cellsY: number;
  readonly verticesX: number;
  readonly verticesY: number;
  readonly version: number;
  readonly heights: readonly number[];
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
