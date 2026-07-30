/** The two world-material toggles (BATTLE bar WORLD group). Both are
 *  battle-level deterministic world state — they change extractor income and
 *  whether the liquid burns — so they live in WorldState and are included in
 *  the canonical state hash, exactly like slopePathMode. */

/** Ground material policy.
 *  - `normal` (default): the authored biome world — grass, rock, and discrete
 *    metal deposits at the placed deposit spots.
 *  - `metal`: the whole map is one metal ore body. Deposit placement still
 *    runs and still shapes the terrain (same pads, same plateaus, same
 *    heights), but no deposit crowns are built, EVERY build-grid cell counts
 *    as a metal cell, and the ground is shaded as polished metal. */
export type TerrainSurfaceMode = 'normal' | 'metal';

/** What fills the map below WATER_LEVEL.
 *  - `water` (default): the authored translucent sea.
 *  - `lava`: opaque molten rock that drains health very fast from anything
 *    touching its surface. */
export type LiquidSurfaceMode = 'water' | 'lava';

export const DEFAULT_TERRAIN_SURFACE_MODE: TerrainSurfaceMode = 'normal';
export const DEFAULT_LIQUID_SURFACE_MODE: LiquidSurfaceMode = 'water';

export function isTerrainSurfaceMode(value: unknown): value is TerrainSurfaceMode {
  return value === 'normal' || value === 'metal';
}

export function isLiquidSurfaceMode(value: unknown): value is LiquidSurfaceMode {
  return value === 'water' || value === 'lava';
}
