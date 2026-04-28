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
