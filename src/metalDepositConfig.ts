// Metal deposit map layout.
//
// Deposits are placed deterministically on a set of concentric rings.
// Each ring carries a per-player count: a player's radial slice
// (2π/playerCount wide, centered on their spawn angle from
// `getPlayerBaseAngle`) gets `countPerPlayer` deposits evenly spread
// across it. So a 6-player map with `countPerPlayer: 2` yields 12
// deposits in that ring; the same ring on a 4-player map yields 8.
//
// Rings can be phase-shifted independently with `sliceOffset`, expressed
// as a fraction of one player's slice width (= 2π / playerCount). The
// shift therefore SCALES with the number of map divisions: 0.25 = a
// quarter-slice (24° at 3 players, 18° at 5), 1.0 = one full slice (the
// next player's spoke), 0.5 = half a slice. Keeps rings from lining up
// on the same radial spokes without baking a player-count-specific
// radian value into config.
//
// Each deposit owns a square logical resource footprint on the fine
// build grid. The extractor building reads the same resource-cell
// config, while terrain flattening reads a separate flat-pad config.
// Resource coverage is exact and cell-based rather than radius-based.
//
// Each ring also carries `dTerrainLevels`. When set to an integer it
// is a signed count of TERRAIN_D_TERRAIN steps above/below world
// height 0, used as-authored — the CENTER bar's sign does NOT flip
// it. When set to `null` the pad sits at whatever height the natural
// (post-plateau, post-boundary) heightmap happens to be at the
// deposit's xy — only the vertical origin differs from the integer
// case. Around each pad the terrain blends smoothly from the derived
// height back to natural over the ring's `terrainBlendRadius`.
//
// Special case — `radiusFraction: 0` is the map center: a single
// deposit is placed at (cx, cy) regardless of countPerPlayer / playerCount.

import { getPlayerBaseAngle } from './game/sim/playerLayout';
import { makeMapOvalMetrics, mapOvalPointAt } from './game/sim/mapOval';
import { getTerrainHeight, TERRAIN_D_TERRAIN } from './game/sim/Terrain';
import { BUILD_GRID_CELL_SIZE, snapBuildingToGrid } from './game/sim/buildGrid';
import rawConfig from './metalDepositConfig.json';

export type DepositRing = {
  /** Distance from map center as a fraction of the oval-space
   *  (mapMinExtent/2 - margin). 0 = center (single deposit),
   *  1 = at the spawn oval edge. */
  radiusFraction: number;
  /** How many deposits each player's radial slice gets on this ring.
   *  Total deposits per ring = countPerPlayer × playerCount (with the
   *  center ring as a special case — always 1 regardless). */
  countPerPlayer: number;
  /** Angular phase offset as a fraction of one player's slice width
   *  (= 2π / playerCount). 0.5 shifts the ring's deposits by half a
   *  slice, 1.0 by a full slice (i.e. into the neighboring player's
   *  spoke). Scales automatically with player count: 0.25 means 30° at
   *  3 players, 18° at 5. Negative values rotate the other way. */
  sliceOffset?: number;
  /** Signed count of TERRAIN_D_TERRAIN steps above/below world height
   *  0, used as-authored regardless of the CENTER bar sign. Pass
   *  `null` to anchor the pad at the natural terrain height under the
   *  deposit's xy instead. */
  dTerrainLevels: number | null;
  /** Circular terrain-flattening diameter in fine building cells; can be
   *  larger than the resource footprint to give the extractor a clean
   *  buildable pad without increasing production area. */
  flatPadCells: number;
  /** World-unit width outside the circular flat pad where terrain eases
   *  back to the natural heightmap. Larger values make the deposit pad
   *  integrate more gradually with surrounding terrain. */
  terrainBlendRadius: number;
  /** Optional free-form note for the author — purely descriptive, not
   *  read by any runtime code. Useful for labeling where a ring sits
   *  ("inner near spawn", "back side cluster", etc.). */
  comment?: string;
};

/** Authored layout config for the metal deposit ring placer. Pure data
 *  lives in metalDepositConfig.json so both TypeScript and Rust/WASM
 *  can load the same source of truth. Field meanings:
 *    - `edgeMarginPx`: oval-space world units between the spawn oval
 *      and the outermost deposit ring (keeps deposits from clipping
 *      into commander spawns).
 *    - `coinHeight`: full visual coin thickness in world units; the
 *      renderer draws the upper half above the terrain and treats the
 *      equator as the ground contact edge. Purely cosmetic.
 *    - `resourceCells`: square logical metal-producing footprint in
 *      fine building cells. The extractor building footprint and
 *      visual deposit size use this.
 *    - `rings`: concentric deposit rings; order doesn't matter — the
 *      renderer and placement validator iterate over all of them. Each
 *      ring carries its own `flatPadCells` and `terrainBlendRadius`. */
export const METAL_DEPOSIT_CONFIG = {
  edgeMarginPx: rawConfig.edgeMarginPx,
  coinHeight: rawConfig.coinHeight,
  resourceCells: rawConfig.resourceCells,
  rings: rawConfig.rings as DepositRing[],
};

export type MetalDeposit = {
  /** Stable index — same number across all clients/peers in a session. */
  id: number;
  /** World-space center shared by the resource square and flat terrain pad. */
  x: number;
  y: number;
  /** Top-left build cell of the logical resource square. */
  gridX: number;
  gridY: number;
  /** Number of build cells on each side of the logical resource square. */
  resourceCells: number;
  /** Half-size of the logical resource square in world units. */
  resourceHalfSize: number;
  /** Radius of the circular flat terrain pad in world units. */
  flatPadRadius: number;
  /** Signed count of TERRAIN_D_TERRAIN steps, taken directly from the
   *  authored ring config. `null` means the pad rides the natural
   *  terrain height under the deposit's xy (see `height`). */
  dTerrainLevels: number | null;
  /** Signed z elevation (sim units) of this deposit's flat pad. */
  height: number;
  /** World-unit blend width outside the circular flat pad before natural
   *  terrain fully takes over. */
  blendRadius: number;
};

type MetalDepositPlacement = Pick<
  MetalDeposit,
  | 'x'
  | 'y'
  | 'gridX'
  | 'gridY'
  | 'resourceCells'
  | 'resourceHalfSize'
  | 'flatPadRadius'
>;

/**
 * Compute the deterministic deposit list for a map of given size and
 * player count. Same `(mapWidth, mapHeight, playerCount)` always
 * produces the same deposits in the same order — fine to call
 * independently on host and clients without networking the list.
 */
export function generateMetalDeposits(
  mapWidth: number,
  mapHeight: number,
  playerCount: number,
): MetalDeposit[] {
  const deposits: MetalDeposit[] = [];
  const ovalMetrics = makeMapOvalMetrics(mapWidth, mapHeight);
  const halfExtent = ovalMetrics.minDim / 2 - METAL_DEPOSIT_CONFIG.edgeMarginPx;
  const cx = ovalMetrics.cx;
  const cy = ovalMetrics.cy;
  const players = Math.max(1, playerCount);
  const sliceWidth = (2 * Math.PI) / players;
  let id = 0;

  for (const ring of METAL_DEPOSIT_CONFIG.rings) {
    const ringRadius = ring.radiusFraction * halfExtent;
    const flatPadCells = validMetalDepositFlatPadCells(ring.flatPadCells);
    const blendRadius = validMetalDepositTerrainBlendRadius(
      ring.terrainBlendRadius,
    );
    const dTerrainLevels = validMetalDepositDTerrainLevels(ring.dTerrainLevels);
    // Slice-fraction offset: scaled by the player's slice width so the
    // configured value means the same thing (a fraction of one slice)
    // regardless of how many players are dividing the map.
    const ringAngularOffset = (ring.sliceOffset ?? 0) * sliceWidth;
    const placeOne = (rawX: number, rawY: number): void => {
      const placement = makeMetalDepositPlacement(rawX, rawY, flatPadCells);
      // dTerrainLevels=null → ride the natural terrain at the snapped
      // pad center (post-snap so the published height matches where
      // the pad actually lives).
      const height =
        dTerrainLevels === null
          ? getTerrainHeight(placement.x, placement.y, mapWidth, mapHeight, false)
          : dTerrainLevels * TERRAIN_D_TERRAIN;
      deposits.push({
        id: id++,
        ...placement,
        dTerrainLevels,
        height,
        blendRadius,
      });
    };

    // Center: one deposit, regardless of countPerPlayer.
    if (ring.radiusFraction <= 1e-6) {
      placeOne(cx, cy);
      continue;
    }

    for (let p = 0; p < players; p++) {
      const sliceCenter = getPlayerBaseAngle(p, players);
      for (let j = 0; j < ring.countPerPlayer; j++) {
        // Sub-slice midpoints: countPerPlayer=1 → t=0.5 → angle=sliceCenter;
        // countPerPlayer=2 → t=0.25, 0.75 → angles at ±sliceWidth/4 around centre.
        const t = (j + 0.5) / ring.countPerPlayer;
        const angleInSlice = -sliceWidth / 2 + t * sliceWidth;
        const angle = sliceCenter + angleInSlice + ringAngularOffset;
        const point = mapOvalPointAt(ovalMetrics, angle, ringRadius);
        placeOne(point.x, point.y);
      }
    }
  }

  return deposits;
}

function makeMetalDepositPlacement(
  rawX: number,
  rawY: number,
  flatPadCells: number,
): MetalDepositPlacement {
  const resourceCells = METAL_DEPOSIT_CONFIG.resourceCells;
  const resourceHalfSize = (resourceCells * BUILD_GRID_CELL_SIZE) / 2;
  const flatPadRadius = (flatPadCells * BUILD_GRID_CELL_SIZE) / 2;
  const resourceHalfDiagonal = Math.SQRT2 * resourceHalfSize;
  if (flatPadRadius < resourceHalfDiagonal) {
    throw new Error(
      `Metal deposit ring flatPadCells (${flatPadCells}) must produce a circular radius >= the resource square half-diagonal (${resourceHalfDiagonal.toFixed(2)} world units)`,
    );
  }
  const snapped = snapBuildingToGrid(rawX, rawY, resourceCells, resourceCells);
  return {
    x: snapped.x,
    y: snapped.y,
    gridX: snapped.gridX,
    gridY: snapped.gridY,
    resourceCells,
    resourceHalfSize,
    flatPadRadius,
  };
}

function validMetalDepositDTerrainLevels(levels: number | null): number | null {
  if (levels === null) return null;
  if (!Number.isFinite(levels) || !Number.isInteger(levels)) {
    throw new Error(
      `Metal deposit dTerrainLevels must be a finite integer or null; received ${levels}`,
    );
  }
  return levels;
}

function validMetalDepositFlatPadCells(cells: number): number {
  if (!Number.isFinite(cells) || !Number.isInteger(cells) || cells <= 0) {
    throw new Error(
      `Metal deposit ring flatPadCells must be a positive integer; received ${cells}`,
    );
  }
  return cells;
}

function validMetalDepositTerrainBlendRadius(radius: number): number {
  if (!Number.isFinite(radius) || radius < 0) {
    throw new Error(
      `Metal deposit ring terrainBlendRadius must be a finite non-negative number; received ${radius}`,
    );
  }
  return radius;
}

