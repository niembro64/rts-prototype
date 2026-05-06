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

/** Server-authored terrain mesh samples.
 *
 *  Terrain topology is independent from LAND GRID gameplay cells. The
 *  authoritative mesh is a global bottom-up equilateral-triangle hierarchy:
 *  fine lattice triangles are grouped upward only when the larger triangle
 *  stays within terrain error constraints. The final baked mesh is fixed per
 *  match and shared by host sim, client prediction, and rendering.
 *
 *  LAND GRID cells remain useful for gameplay, overlays, and broad lookup.
 *  `meshCellTriangleOffsets` / `meshCellTriangleIndices` are an acceleration
 *  index from land cells to global terrain triangles; they do not define the
 *  terrain topology.
 *
 *  `meshTriangleLevels` gives each rendered triangle's hierarchy level.
 *  `meshTriangleNeighborIndices` and `meshTriangleNeighborLevels` are
 *  per-edge metadata: three entries per triangle. Map boundary edges use
 *  `-1`; non-boundary edges are repaired until they have either an exact
 *  neighbor or a highest-resolution overlapping neighbor recorded.
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
  readonly meshVertexCoords: readonly number[];
  readonly meshVertexHeights: readonly number[];
  readonly meshTriangleIndices: readonly number[];
  readonly meshTriangleLevels: readonly number[];
  readonly meshTriangleNeighborIndices: readonly number[];
  readonly meshTriangleNeighborLevels: readonly number[];
  readonly meshCellTriangleOffsets: readonly number[];
  readonly meshCellTriangleIndices: readonly number[];
};

/** Server-authored buildability grid for the building-placement
 *  cells. This is static for a match: terrain, water, and plateau
 *  eligibility are baked once by the host. Dynamic blockers such as
 *  buildings remain snapshot/state driven.
 *
 *  `flags[i]` is 1 when the cell is buildable terrain, 0 otherwise.
 *  `levels[i]` is the plateau level for buildable cells; consumers
 *  require all cells in a footprint to share one level. */
export type TerrainBuildabilityGrid = {
  readonly mapWidth: number;
  readonly mapHeight: number;
  readonly cellSize: number;
  readonly cellsX: number;
  readonly cellsY: number;
  readonly version: number;
  readonly configKey: string;
  readonly flags: readonly number[];
  readonly levels: readonly number[];
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
