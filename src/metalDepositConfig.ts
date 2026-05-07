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
// Each ring also carries `dTerrainLevels`: a signed integer count of
// TERRAIN_D_TERRAIN steps above/below world height 0, before terrain
// CENTER polarity is applied. VALLEY inverts the level count, MOUNTAIN
// preserves it, and FLAT collapses it to 0. Around each pad the terrain
// blends smoothly from that derived height back to natural over
// `terrainBlendRadius` unless a ring overrides it with `blendRadius`.
//
// Special case — `radiusFraction: 0` is the map center: a single
// deposit is placed at (cx, cy) regardless of countPerPlayer / playerCount.

import { getPlayerBaseAngle } from './game/sim/playerLayout';
import { makeMapOvalMetrics, mapOvalPointAt } from './game/sim/mapOval';
import { TERRAIN_D_TERRAIN } from './game/sim/Terrain';
import { BUILD_GRID_CELL_SIZE, snapBuildingToGrid } from './game/sim/buildGrid';
import { terrainShapeSign, type TerrainShape } from './types/terrain';
import {
  METAL_DEPOSIT_FLAT_PAD_CELLS,
  METAL_DEPOSIT_RESOURCE_CELLS,
} from './config';

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
  /** Signed count of TERRAIN_D_TERRAIN steps before CENTER polarity. */
  dTerrainLevels: number;
  /** Optional world-unit blend width outside the circular flat pad.
   *  Defaults to METAL_DEPOSIT_CONFIG.terrainBlendRadius. Larger values
   *  make the deposit pad integrate more gradually with surrounding
   *  terrain. */
  blendRadius?: number;
};

export const METAL_DEPOSIT_CONFIG = {
  /** Margin (oval-space world units) between the spawn oval and the outermost
   *  deposit ring. Keeps deposits from clipping into commander spawns. */
  edgeMarginPx: 200,

  /** Full visual coin thickness in world units. The renderer draws the
   *  upper half above the terrain and treats the equator as the ground
   *  contact edge, so no underside leaks through at grazing angles.
   *  Purely cosmetic — collision and pad height are unaffected. */
  coinHeight: 10,

  /** Square logical metal-producing footprint, in fine building cells.
   *  The extractor building footprint and visual deposit size use this. */
  resourceCells: METAL_DEPOSIT_RESOURCE_CELLS,

  /** Circular terrain-flattening diameter, in fine building cells. This
   *  can be larger than `resourceCells` to give the extractor a clean
   *  buildable pad without increasing production area. */
  flatPadCells: METAL_DEPOSIT_FLAT_PAD_CELLS,

  /** World-unit width outside each deposit's flat pad where terrain
   *  eases back to the natural heightmap. Keep this larger than a grid
   *  cell when deposits sit far above/below the surrounding land. */
  terrainBlendRadius: 600,

  /** Concentric rings of deposits. Order doesn't matter — the renderer
   *  and placement validator iterate over all of them. */

  rings: [
    {
      radiusFraction: 0.3,
      countPerPlayer: 1,
      sliceOffset: 0,
      dTerrainLevels: 0,
    },
    // {
    //   radiusFraction: 0.3,
    //   countPerPlayer: 2,
    //   sliceOffset: 0.1,
    //   dTerrainLevels: 0,
    // },
    // {
    //   radiusFraction: 0.4,
    //   countPerPlayer: 2,
    //   sliceOffset: 0.2,
    //   dTerrainLevels: 0,
    // },
    // {
    //   radiusFraction: 0.5,
    //   countPerPlayer: 2,
    //   sliceOffset: 0.3,
    //   dTerrainLevels: 0,
    // },
    {
      radiusFraction: 0.6,
      countPerPlayer: 2,
      sliceOffset: 0.4,
      dTerrainLevels: 0,
    },
    // {
    //   radiusFraction: 0.7,
    //   countPerPlayer: 2,
    //   sliceOffset: 0.5,
    //   dTerrainLevels: 0,
    // },
    {
      radiusFraction: 0.8,
      countPerPlayer: 2,
      sliceOffset: 0.6,
      dTerrainLevels: 0,
    },
  ] as DepositRing[],
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
  /** Signed count of TERRAIN_D_TERRAIN steps after CENTER polarity. */
  dTerrainLevels: number;
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
 * player count. Same `(mapWidth, mapHeight, playerCount,
 * terrainCenterShape)` always produces the same deposits in the same
 * order — fine to call independently on host and clients without
 * networking the list.
 */
export function generateMetalDeposits(
  mapWidth: number,
  mapHeight: number,
  playerCount: number,
  terrainCenterShape: TerrainShape = 'valley',
): MetalDeposit[] {
  const deposits: MetalDeposit[] = [];
  const ovalMetrics = makeMapOvalMetrics(mapWidth, mapHeight);
  const halfExtent = ovalMetrics.minDim / 2 - METAL_DEPOSIT_CONFIG.edgeMarginPx;
  const cx = ovalMetrics.cx;
  const cy = ovalMetrics.cy;
  const players = Math.max(1, playerCount);
  const sliceWidth = (2 * Math.PI) / players;
  let id = 0;
  const terrainSign = terrainShapeSign(terrainCenterShape);

  for (const ring of METAL_DEPOSIT_CONFIG.rings) {
    const ringRadius = ring.radiusFraction * halfExtent;
    const blendRadius =
      ring.blendRadius ?? METAL_DEPOSIT_CONFIG.terrainBlendRadius;
    const dTerrainLevels = signedMetalDepositDTerrainLevels(
      ring.dTerrainLevels,
      terrainSign,
    );
    const height = metalDepositHeightForDTerrainLevels(dTerrainLevels);
    // Slice-fraction offset: scaled by the player's slice width so the
    // configured value means the same thing (a fraction of one slice)
    // regardless of how many players are dividing the map.
    const ringAngularOffset = (ring.sliceOffset ?? 0) * sliceWidth;

    // Center: one deposit, regardless of countPerPlayer.
    if (ring.radiusFraction <= 1e-6) {
      deposits.push({
        id: id++,
        ...makeMetalDepositPlacement(cx, cy),
        dTerrainLevels,
        height,
        blendRadius,
      });
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
        deposits.push({
          id: id++,
          ...makeMetalDepositPlacement(point.x, point.y),
          dTerrainLevels,
          height,
          blendRadius,
        });
      }
    }
  }

  return deposits;
}

function makeMetalDepositPlacement(
  rawX: number,
  rawY: number,
): MetalDepositPlacement {
  const resourceCells = METAL_DEPOSIT_CONFIG.resourceCells;
  const flatPadCells = METAL_DEPOSIT_CONFIG.flatPadCells;
  const resourceHalfSize = (resourceCells * BUILD_GRID_CELL_SIZE) / 2;
  const flatPadRadius = (flatPadCells * BUILD_GRID_CELL_SIZE) / 2;
  const resourceHalfDiagonal = Math.SQRT2 * resourceHalfSize;
  if (flatPadRadius < resourceHalfDiagonal) {
    throw new Error(
      `METAL_DEPOSIT_CONFIG.flatPadCells (${flatPadCells}) must produce a circular radius >= the resource square half-diagonal (${resourceHalfDiagonal.toFixed(2)} world units)`,
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

function signedMetalDepositDTerrainLevels(
  levels: number,
  terrainSign: -1 | 0 | 1,
): number {
  if (!Number.isFinite(levels) || !Number.isInteger(levels)) {
    throw new Error(
      `Metal deposit dTerrainLevels must be a finite integer; received ${levels}`,
    );
  }
  return levels * terrainSign;
}

function metalDepositHeightForDTerrainLevels(levels: number): number {
  if (!Number.isFinite(levels) || !Number.isInteger(levels)) {
    throw new Error(
      `Metal deposit dTerrainLevels must be a finite integer; received ${levels}`,
    );
  }
  return levels * TERRAIN_D_TERRAIN;
}
