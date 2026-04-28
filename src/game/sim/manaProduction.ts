// Per-tile mana production — single source of truth for both the
// economy (how much mana a captured tile generates per second) and
// the GRID renderer (how bright that tile looks). A tile near the
// map center is in a "hotspot" disc whose multiplier ramps linearly
// from 1.0 at the disc edge up to `manaHotspotCenterMultiplier` at
// the exact center. Outside the disc the multiplier is exactly 1.0
// — uniform production, identical to the pre-hotspot behaviour.

import { CAPTURE_CONFIG } from '../../captureConfig';
import { MANA_PER_TILE_PER_SECOND, SPATIAL_GRID_CELL_SIZE } from '../../config';

/** Production multiplier for a tile whose centre is at (cellCenterX,
 *  cellCenterY) on a map of the given dimensions. Always ≥ 1. */
export function getManaTileMultiplier(
  cellCenterX: number,
  cellCenterY: number,
  mapWidth: number,
  mapHeight: number,
): number {
  const radiusFrac = CAPTURE_CONFIG.manaHotspotRadiusFraction;
  const centerMult = CAPTURE_CONFIG.manaHotspotCenterMultiplier;
  if (radiusFrac <= 0 || centerMult <= 1) return 1;
  const radius = Math.min(mapWidth, mapHeight) * radiusFrac;
  if (radius <= 0) return 1;
  const dx = cellCenterX - mapWidth / 2;
  const dy = cellCenterY - mapHeight / 2;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist >= radius) return 1;
  const t = 1 - dist / radius;
  return 1 + (centerMult - 1) * t;
}

/** Mana per second a tile produces when fully captured by a single
 *  player (height = 1). Multiplying by the player's flag height on
 *  that tile gives their actual income contribution. */
export function getManaTileProductionPerSecond(
  cellCenterX: number,
  cellCenterY: number,
  mapWidth: number,
  mapHeight: number,
): number {
  return (
    MANA_PER_TILE_PER_SECOND *
    getManaTileMultiplier(cellCenterX, cellCenterY, mapWidth, mapHeight)
  );
}

/** Peak per-tile production rate (mana/sec) used by the renderer to
 *  normalise colour brightness — a fully captured centre tile maps
 *  to brightness 1.0, a fully captured perimeter tile to
 *  1 / centerMultiplier. Always ≥ MANA_PER_TILE_PER_SECOND. */
export function getMaxManaTileProductionPerSecond(): number {
  const mult = Math.max(1, CAPTURE_CONFIG.manaHotspotCenterMultiplier);
  return MANA_PER_TILE_PER_SECOND * mult;
}

/** Same as getManaTileMultiplier but indexed by integer cell coords
 *  + cell size — the form the capture system and renderers
 *  consume. */
export function getManaCellMultiplier(
  cx: number,
  cy: number,
  cellSize: number,
  mapWidth: number,
  mapHeight: number,
): number {
  const size = cellSize > 0 ? cellSize : SPATIAL_GRID_CELL_SIZE;
  const wx = (cx + 0.5) * size;
  const wy = (cy + 0.5) * size;
  return getManaTileMultiplier(wx, wy, mapWidth, mapHeight);
}

// =============================================================================
// GRID-overlay colour model
// =============================================================================
//
// Colour brightness ties directly to a tile's mana-per-second so what
// you see on the GRID matches what you earn. Brightness factors into
// two axes that mirror the production formula:
//
//   production = MANA_PER_TILE × multiplier × dominantHeight
//                                ^^^^^^^^^^   ^^^^^^^^^^^^^^^
//                                glow axis    saturation axis
//
//   • SATURATION blends neutral → team colour, driven by the
//     dominant team's flag height. Identical to the pre-hotspot
//     behaviour — a fully captured tile saturates to its team's
//     primary colour regardless of where it is on the map.
//
//   • GLOW blends team colour → white, driven by how far the tile's
//     hotspot multiplier exceeds the perimeter baseline. Capped so
//     the brightest centre tile is visibly luminous yet still
//     readable as the team's colour, not pure white.
//
// Both factors are scaled by the GRID-overlay intensity so the OFF /
// LOW / MEDIUM / HIGH dimmer keeps tiles from screaming at low
// settings. Producing this from one helper means the 3D capture-tile
// mesh and the 2D minimap render IDENTICAL gradients.

/** Maximum lerp toward white at the hottest, fully captured tile.
 *  Lower → centre tiles stay closer to team colour; higher →
 *  centre tiles glow more aggressively. 0.6 reads as "noticeably
 *  brighter, still clearly the team's colour." */
export const CAPTURE_TILE_GLOW_CAP = 0.6;

/** Two-axis brightness factors for one captured tile, given the
 *  per-tile hotspot multiplier, the dominant team's flag height,
 *  and the global GRID-overlay intensity. The renderer then lerps
 *  neutral → team colour by `saturation`, then team colour → white
 *  by `glow`. Both factors are clamped to safe display ranges. */
export function getCaptureTileBlendFactors(
  tileMultiplier: number,
  dominantHeight: number,
  intensity: number,
): { saturation: number; glow: number } {
  const centerMult = Math.max(1, CAPTURE_CONFIG.manaHotspotCenterMultiplier);
  const saturation = Math.min(1, intensity * 3 * dominantHeight);
  const hotspotShare =
    centerMult > 1 ? (tileMultiplier - 1) / (centerMult - 1) : 0;
  const glow = Math.min(
    CAPTURE_TILE_GLOW_CAP,
    intensity * hotspotShare * dominantHeight,
  );
  return { saturation, glow };
}
