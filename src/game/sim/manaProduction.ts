// Per-tile mana production — single source of truth for both the
// economy (mana/sec a team earns from each tile they own) and the
// GRID renderer (how bright each tile looks). One position-keyed
// function returns absolute mana/sec; the colour model is built on
// top of it so brightness in the overlay tracks income exactly.
//
// Production model:
//   • A tile fully captured by one team produces `tileRate` mana/sec
//     for that team. `tileRate` ramps linearly from the default
//     mana amount (`BASE_MANA_PER_SECOND`) at the edge of the
//     central hotspot disc up to
//     `BASE_MANA_PER_SECOND × MANA_CENTER_TILE_MULTIPLIER` at the
//     exact map centre, and is constant at the perimeter rate
//     everywhere outside the disc. There is no separately-defined
//     perimeter constant — the perimeter rate IS the default mana
//     amount.
//   • A team's actual income from a tile is its FLAG HEIGHT (its
//     ownership ratio in [0, 1]) multiplied by `tileRate`. Multiple
//     teams on the same contested tile each earn proportional to
//     their height.

import {
  MANA_CENTER_TILE_MULTIPLIER,
  MANA_HOTSPOT_RADIUS_FRACTION,
} from '../../captureConfig';
import { BASE_MANA_PER_SECOND, SPATIAL_GRID_CELL_SIZE } from '../../config';

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
  if (MANA_HOTSPOT_RADIUS_FRACTION <= 0 || MANA_CENTER_TILE_MULTIPLIER <= 1) {
    return BASE_MANA_PER_SECOND;
  }
  const radius = Math.min(mapWidth, mapHeight) * MANA_HOTSPOT_RADIUS_FRACTION;
  if (radius <= 0) return BASE_MANA_PER_SECOND;
  const dx = cellCenterX - mapWidth / 2;
  const dy = cellCenterY - mapHeight / 2;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist >= radius) return BASE_MANA_PER_SECOND;
  const t = 1 - dist / radius;
  return BASE_MANA_PER_SECOND * (1 + (MANA_CENTER_TILE_MULTIPLIER - 1) * t);
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
// Brightness is a single proportional axis that tracks the tile's
// total ownership × mana/sec:
//
//   mix = intensity × (totalOwnership × tileRate) / maxTileRate
//
// where `maxTileRate = BASE_MANA_PER_SECOND × MANA_CENTER_TILE_MULTIPLIER`
// — the rate of a fully-captured centre tile, the brightest tile
// the map can produce. `totalOwnership` is the SUM of every team's
// flag height on the tile, so a border tile shared 50/50 between
// two teams reads just as bright as a single-team tile (sum = 1.0
// in both cases). The blended team color is the area-weighted
// average of those teams' colors — see CaptureTileRenderer3D /
// Minimap.
//
// The GRID-overlay setting (OFF / LOW / MED / HI) sets `intensity`,
// which is the mix the brightest possible tile reaches; every
// other tile scales down in exact proportion to its mana-per-
// second. A perimeter tile fully captured renders at
// 1 / MANA_CENTER_TILE_MULTIPLIER of the centre tile's brightness,
// because that's exactly the ratio of mana income they produce.
// The 3D mesh and 2D minimap consume this same factor so both
// views paint identical gradients.

/** Direct lerp factor `mix ∈ [0, 1]` for blending neutral → team
 *  colour on one captured tile, given the tile's mana-per-second
 *  rate (from getManaTileProductionPerSecond), the tile's TOTAL
 *  ownership height (sum of every team's flag height on the tile),
 *  and the global GRID-overlay intensity. A fully-captured centre
 *  tile returns `intensity` exactly; every other tile scales down
 *  in proportion to its mana production × ownership. */
export function getCaptureTileBrightness(
  tileProductionPerSec: number,
  totalOwnershipHeight: number,
  intensity: number,
): number {
  const maxTileProd = BASE_MANA_PER_SECOND * MANA_CENTER_TILE_MULTIPLIER;
  if (maxTileProd <= 0 || intensity <= 0) return 0;
  const productionFraction =
    (totalOwnershipHeight * tileProductionPerSec) / maxTileProd;
  return Math.min(1, intensity * productionFraction);
}
