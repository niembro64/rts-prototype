// Per-tile mana production — single source of truth for both the
// economy (mana/sec a team earns from each tile they own) and the
// GRID renderer (how bright each tile looks). One position-keyed
// function returns absolute mana/sec; the colour model is built on
// top of it so brightness in the overlay tracks income exactly.
//
// Production model:
//   • A tile fully captured by one team produces `tileRate` mana/sec
//     for that team. `tileRate` ramps linearly from
//     `manaPerTilePerimeter` at the edge of the central hotspot disc
//     up to `manaPerTilePerimeter × manaCenterTileMultiplier` at the
//     exact map centre, and is constant at the perimeter rate
//     everywhere outside the disc.
//   • A team's actual income from a tile is its FLAG HEIGHT (its
//     ownership ratio in [0, 1]) multiplied by `tileRate`. Multiple
//     teams on the same contested tile each earn proportional to
//     their height. There is no global MANA_PER_TILE constant — the
//     tile's rate is the only multiplicative factor besides the
//     team's ownership ratio.

import { CAPTURE_CONFIG } from '../../captureConfig';
import { SPATIAL_GRID_CELL_SIZE } from '../../config';

/** Mana per second a tile at (cellCenterX, cellCenterY) produces
 *  when fully captured by a single team (height = 1). Multiplying
 *  by a team's flag height on that tile gives that team's income
 *  contribution. */
export function getManaTileProductionPerSecond(
  cellCenterX: number,
  cellCenterY: number,
  mapWidth: number,
  mapHeight: number,
): number {
  const perimeter = CAPTURE_CONFIG.manaPerTilePerimeter;
  const centerMult = CAPTURE_CONFIG.manaCenterTileMultiplier;
  const radiusFrac = CAPTURE_CONFIG.manaHotspotRadiusFraction;
  if (radiusFrac <= 0 || centerMult <= 1) return perimeter;
  const radius = Math.min(mapWidth, mapHeight) * radiusFrac;
  if (radius <= 0) return perimeter;
  const dx = cellCenterX - mapWidth / 2;
  const dy = cellCenterY - mapHeight / 2;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist >= radius) return perimeter;
  const t = 1 - dist / radius;
  return perimeter * (1 + (centerMult - 1) * t);
}

/** Same as getManaTileProductionPerSecond but indexed by integer
 *  cell coords + cell size — the form the capture system and
 *  renderers consume. */
export function getManaCellProductionPerSecond(
  cx: number,
  cy: number,
  cellSize: number,
  mapWidth: number,
  mapHeight: number,
): number {
  const size = cellSize > 0 ? cellSize : SPATIAL_GRID_CELL_SIZE;
  const wx = (cx + 0.5) * size;
  const wy = (cy + 0.5) * size;
  return getManaTileProductionPerSecond(wx, wy, mapWidth, mapHeight);
}

// =============================================================================
// GRID-overlay colour model
// =============================================================================
//
// Tile brightness is split along two visual axes that mirror the
// production formula `tileIncome = ownershipHeight × tileRate`:
//
//   • SATURATION blends neutral → team colour, driven by the
//     dominant team's flag height (its ownership ratio). A fully
//     owned tile saturates to its team's primary colour regardless
//     of where it is on the map.
//   • GLOW blends team colour → white, driven by how much the
//     tile's production rate exceeds the perimeter baseline. Capped
//     so even the brightest centre tile reads as the team's colour
//     rather than washing out to pure white.
//
// Both factors scale by the GRID-overlay intensity (OFF / LOW /
// MEDIUM / HIGH dimmer). Both renderers (3D mesh + 2D minimap)
// consume this so they paint identical gradients.

/** Maximum lerp toward white at the hottest, fully-captured tile.
 *  Lower → centre tiles stay closer to team colour; higher →
 *  centre tiles glow more aggressively. 0.6 reads as "noticeably
 *  brighter, still clearly the team's colour." */
export const CAPTURE_TILE_GLOW_CAP = 0.6;

/** Two-axis brightness factors for one captured tile, given the
 *  tile's mana-per-second rate (from getManaTileProductionPerSecond),
 *  the dominant team's flag height, and the global GRID-overlay
 *  intensity. */
export function getCaptureTileBlendFactors(
  tileProductionPerSec: number,
  dominantHeight: number,
  intensity: number,
): { saturation: number; glow: number } {
  const perimeter = CAPTURE_CONFIG.manaPerTilePerimeter;
  const centerMult = CAPTURE_CONFIG.manaCenterTileMultiplier;
  const span = perimeter * (centerMult - 1);
  const hotspotShare =
    span > 0
      ? Math.max(0, Math.min(1, (tileProductionPerSec - perimeter) / span))
      : 0;
  const saturation = Math.min(1, intensity * 3 * dominantHeight);
  const glow = Math.min(
    CAPTURE_TILE_GLOW_CAP,
    intensity * hotspotShare * dominantHeight,
  );
  return { saturation, glow };
}
