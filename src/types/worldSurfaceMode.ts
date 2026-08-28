/** The two world-material settings (BATTLE bar WORLD group). Both are
 *  battle-level deterministic world state — they change extractor income and
 *  whether the liquid exists/burns — so they live in WorldState and are included in
 *  the canonical state hash, exactly like slopePathMode. */

/** How much of the world is metal ore. One BATTLE-bar setting, four rungs.
 *  Every rung generates the SAME deposit placements and therefore the exact
 *  same terrain — same pads, same plateaus, same heights. All that moves is
 *  which cells are ore:
 *  - `none`: no metal anywhere. The deposits still shape the land, they just
 *    yield no ore body, so no extractor can be built.
 *  - `some`: one default-size ore body per deposit spot.
 *  - `more` (default): the per-ring authored ore sizes, so the middle of the
 *    map carries the big bodies.
 *  - `all`: the whole map is one metal ore body. No deposit ore bodies at all,
 *    EVERY build-grid cell counts as a metal cell, and the ground is shaded
 *    as polished metal. */
export type MetalCoverage = 'none' | 'some' | 'more' | 'all';

/** What fills the map below WATER_LEVEL.
 *  - `water` (default): the authored translucent sea.
 *  - `lava`: opaque molten rock that drains health very fast from anything
 *    touching its surface.
 *  - `none`: no liquid plane or liquid medium; the authored basin terrain is
 *    exposed as ordinary dry ground. */
export type LiquidSurfaceMode = 'water' | 'lava' | 'none';

export const DEFAULT_METAL_COVERAGE: MetalCoverage = 'more';
export const DEFAULT_LIQUID_SURFACE_MODE: LiquidSurfaceMode = 'water';

export const METAL_COVERAGES: readonly MetalCoverage[] = ['none', 'some', 'more', 'all'];
export const LIQUID_SURFACE_MODES: readonly LiquidSurfaceMode[] = ['water', 'lava', 'none'];

/** Bar buttons and the map sign both read these, so the four rungs are
 *  named the same everywhere the player sees them. */
export const METAL_COVERAGE_LABEL: Record<MetalCoverage, string> = {
  none: 'NONE',
  some: 'SOME',
  more: 'MORE',
  all: 'ALL',
};

export const LIQUID_SURFACE_MODE_LABEL: Record<LiquidSurfaceMode, string> = {
  water: 'WATER',
  lava: 'LAVA',
  none: 'NONE',
};

export function isMetalCoverage(value: unknown): value is MetalCoverage {
  return METAL_COVERAGES.includes(value as MetalCoverage);
}

/** ALL is the only rung where the ground itself is ore: no per-deposit ore
 *  bodies, every build cell pays metal, polished-metal shading, barren world. */
export function metalCoverageIsWholeMap(value: MetalCoverage): boolean {
  return value === 'all';
}

export function isLiquidSurfaceMode(value: unknown): value is LiquidSurfaceMode {
  return LIQUID_SURFACE_MODES.includes(value as LiquidSurfaceMode);
}
