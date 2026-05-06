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
 *  `tileSubdivisions[cy * cellsX + cx]` is the authoritative render/sim
 *  subdivision selected for that land cell. Runtime terrain sampling uses
 *  that selected subdivision and the baked `tileVertexHeights` payload,
 *  whose vertices were sampled directly from the generated terrain curve
 *  after subdivision selection. Sim, client prediction, and rendering stay
 *  on the same adaptive two-triangle quad surface.
 *
 *  `tileEdgeSubdivisions[(tile * 4) + edge]` stores north/east/south/west
 *  edge resolutions after considering touching cells. `tileVertexCoords`,
 *  `tileVertexHeights`, and `tileTriangleIndices` store the final stitched
 *  per-cell mesh so low-resolution cells can add only the border vertices
 *  needed to match higher-resolution neighbors.
 *
 *  `heights` retains a max-resolution generator sample grid for snapshots
 *  and diagnostics. `centerHeights` / `centerFanMask` are legacy snapshot
 *  fields; authoritative topology now keeps every sub-quad on the classic
 *  two-triangle split and writes a zero center-fan mask.
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
  readonly centerHeights: readonly number[];
  readonly centerFanMask: readonly number[];
  readonly tileSubdivisions: readonly number[];
  readonly tileEdgeSubdivisions: readonly number[];
  readonly tileVertexOffsets: readonly number[];
  readonly tileVertexCoords: readonly number[];
  readonly tileVertexHeights: readonly number[];
  readonly tileTriangleOffsets: readonly number[];
  readonly tileTriangleIndices: readonly number[];
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
