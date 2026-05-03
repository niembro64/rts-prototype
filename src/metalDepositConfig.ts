// Metal deposit map layout.
//
// Deposits are placed deterministically on a set of concentric rings.
// Each ring carries a per-player count: a player's radial slice
// (2π/playerCount wide, centered on their spawn angle from
// `getPlayerBaseAngle`) gets `countPerPlayer` deposits evenly spread
// across it. So a 6-player map with `countPerPlayer: 2` yields 12
// deposits in that ring; the same ring on a 4-player map yields 8.
//
// Rings can be phase-shifted independently with `phaseOffset`, expressed
// as a multiple of π radians. For example, 0.5 = π/2, 1 = π, and
// 2 = a full turn. Use this to keep rings from lining up on the same
// radial spokes.
//
// Each ring also carries `dTerrainLevels`: a signed integer count of
// TERRAIN_D_TERRAIN steps above/below world height 0, before terrain
// CENTER polarity is applied. LAKE inverts the level count, MOUNTAIN
// preserves it, and FLAT collapses it to 0. Around each pad the terrain
// blends smoothly from that derived height back to natural over
// `terrainBlendRadius` unless a ring overrides it with `blendRadius`.
//
// Special case — `radiusFraction: 0` is the map center: a single
// deposit is placed at (cx, cy) regardless of countPerPlayer / playerCount.

import { getPlayerBaseAngle } from './game/sim/spawn';
import { TERRAIN_D_TERRAIN } from './game/sim/Terrain';
import { terrainShapeSign, type TerrainShape } from './types/terrain';

export type DepositRing = {
  /** Distance from map center as a fraction of (mapMinExtent/2 - margin).
   *  0 = center (single deposit), 1 = at the spawn circle edge. */
  radiusFraction: number;
  /** How many deposits each player's radial slice gets on this ring.
   *  Total deposits per ring = countPerPlayer × playerCount (with the
   *  center ring as a special case — always 1 regardless). */
  countPerPlayer: number;
  /** Angular phase offset as a multiple of π radians. 0.5 = π/2,
   *  1 = π, 2 = full turn; negative values work too. */
  phaseOffset?: number;
  /** Absolute raw angular offset in radians, added after `phaseOffset`.
   *  Prefer `phaseOffset` for config values that should read in π units. */
  rotationOffset: number;
  /** World-unit radius around each deposit where terrain is forced to
   *  the ring's `height`. Tune up if the extractor's grid footprint
   *  doesn't clear the blend edge. */
  flatRadius: number;
  /** Signed count of TERRAIN_D_TERRAIN steps before CENTER polarity. */
  dTerrainLevels: number;
  /** Optional world-unit blend width outside `flatRadius`. Defaults to
   *  METAL_DEPOSIT_CONFIG.terrainBlendRadius. Larger values make the
   *  deposit pad integrate more gradually with surrounding terrain. */
  blendRadius?: number;
};

export const METAL_DEPOSIT_CONFIG = {
  /** Margin (world units) between the spawn circle and the outermost
   *  deposit ring. Keeps deposits from clipping into commander spawns. */
  edgeMarginPx: 200,

  /** Visual marker radius — the disc rendered on the ground at each
   *  deposit's center. Sized so it's clearly readable at zoom-out
   *  without dominating the terrain. */
  markerRadius: 50,

  /** World-unit width outside each deposit's flat pad where terrain
   *  eases back to the natural heightmap. Keep this larger than a grid
   *  cell when deposits sit far above/below the surrounding land. */
  terrainBlendRadius: 180,

  /** Concentric rings of deposits. Order doesn't matter — the renderer
   *  and placement validator iterate over all of them. */
  rings: [
    {
      radiusFraction: 0.2,
      countPerPlayer: 1,
      phaseOffset: 3,
      rotationOffset: 0.2,
      flatRadius: 200,
      dTerrainLevels: 1,
    },
    // {
    //   radiusFraction: 0.3,
    //   countPerPlayer: 2,
    //   phaseOffset: 0.25,
    //   rotationOffset: 0,
    //   flatRadius: 120,
    //   dTerrainLevels: 3,
    // },
    {
      radiusFraction: 0.5,
      countPerPlayer: 1,
      phaseOffset: -0.22,
      rotationOffset: 0,
      flatRadius: 200,
      dTerrainLevels: 2,
    },
    {
      radiusFraction: 0.75,
      countPerPlayer: 2,
      phaseOffset: 0.125,
      rotationOffset: 0,
      flatRadius: 120,
      dTerrainLevels: 1,
    },
    {
      radiusFraction: 0.95,
      countPerPlayer: 2,
      phaseOffset: -0.15,
      rotationOffset: 0,
      flatRadius: 200,
      dTerrainLevels: 1,
    },
  ] as DepositRing[],
};

export type MetalDeposit = {
  /** Stable index — same number across all clients/peers in a session. */
  id: number;
  /** World-space center of the deposit. */
  x: number;
  y: number;
  /** Radius around the center where terrain is flat at `height` and
   *  an extractor may be placed. Copied from the ring at gen time. */
  flatRadius: number;
  /** Signed count of TERRAIN_D_TERRAIN steps after CENTER polarity. */
  dTerrainLevels: number;
  /** Signed z elevation (sim units) of this deposit's flat pad. */
  height: number;
  /** World-unit blend width outside `flatRadius` before natural terrain
   *  fully takes over. */
  blendRadius: number;
};

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
  terrainCenterShape: TerrainShape = 'lake',
): MetalDeposit[] {
  const deposits: MetalDeposit[] = [];
  const halfExtent =
    Math.min(mapWidth, mapHeight) / 2 - METAL_DEPOSIT_CONFIG.edgeMarginPx;
  const cx = mapWidth / 2;
  const cy = mapHeight / 2;
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
    const ringAngularOffset =
      (ring.phaseOffset ?? 0) * Math.PI + ring.rotationOffset;

    // Center: one deposit, regardless of countPerPlayer.
    if (ring.radiusFraction <= 1e-6) {
      deposits.push({
        id: id++,
        x: cx,
        y: cy,
        flatRadius: ring.flatRadius,
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
        const x = cx + Math.cos(angle) * ringRadius;
        const y = cy + Math.sin(angle) * ringRadius;
        deposits.push({
          id: id++,
          x,
          y,
          flatRadius: ring.flatRadius,
          dTerrainLevels,
          height,
          blendRadius,
        });
      }
    }
  }

  return deposits;
}

function signedMetalDepositDTerrainLevels(levels: number, terrainSign: -1 | 0 | 1): number {
  if (!Number.isFinite(levels) || !Number.isInteger(levels)) {
    throw new Error(`Metal deposit dTerrainLevels must be a finite integer; received ${levels}`);
  }
  return levels * terrainSign;
}

function metalDepositHeightForDTerrainLevels(levels: number): number {
  if (!Number.isFinite(levels) || !Number.isInteger(levels)) {
    throw new Error(`Metal deposit dTerrainLevels must be a finite integer; received ${levels}`);
  }
  return levels * TERRAIN_D_TERRAIN;
}
