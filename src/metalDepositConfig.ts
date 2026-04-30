// Metal deposit map layout.
//
// Deposits are placed deterministically on a set of concentric rings.
// Each ring carries a per-player count: a player's radial slice
// (2π/playerCount wide, centered on their spawn angle from
// `getPlayerBaseAngle`) gets `countPerPlayer` deposits evenly spread
// across it. So a 6-player map with `countPerPlayer: 2` yields 12
// deposits in that ring; the same ring on a 4-player map yields 8.
//
// Each ring also carries a `height`: the z elevation the deposit's
// flat pad is forced to. height=0 stays at ground level; positive
// values raise the pad above natural terrain; negative values cut a
// pit. Around each pad the terrain blends smoothly from the deposit
// height back to natural over `DEPOSIT_FALLOFF` (Terrain.ts).
//
// Special case — `radiusFraction: 0` is the map center: a single
// deposit is placed at (cx, cy) regardless of countPerPlayer / playerCount.

import { getPlayerBaseAngle } from './game/sim/spawn';

export type DepositRing = {
  /** Distance from map center as a fraction of (mapMinExtent/2 - margin).
   *  0 = center (single deposit), 1 = at the spawn circle edge. */
  radiusFraction: number;
  /** How many deposits each player's radial slice gets on this ring.
   *  Total deposits per ring = countPerPlayer × playerCount (with the
   *  center ring as a special case — always 1 regardless). */
  countPerPlayer: number;
  /** Angular offset (radians) added to every deposit's angle on this
   *  ring. Use to interleave with adjacent rings (e.g. half a slice). */
  rotationOffset: number;
  /** World-unit radius around each deposit where terrain is forced to
   *  the ring's `height`. Tune up if the extractor's grid footprint
   *  doesn't clear the falloff edge. */
  flatRadius: number;
  /** Z elevation (sim units) of the flat pad. 0 = ground level; positive
   *  raises the deposit above natural terrain. */
  height: number;
};

export const METAL_DEPOSIT_CONFIG = {
  /** Margin (world units) between the spawn circle and the outermost
   *  deposit ring. Keeps deposits from clipping into commander spawns. */
  edgeMarginPx: 200,

  /** Visual marker radius — the disc rendered on the ground at each
   *  deposit's center. Sized so it's clearly readable at zoom-out
   *  without dominating the terrain. */
  markerRadius: 50,

  /** Concentric rings of deposits. Order doesn't matter — the renderer
   *  and placement validator iterate over all of them. */
  rings: [
    // Center deposit — single contested spot at the map's heart, on
    // ground level so the central arena stays open to fights.
    { radiusFraction: 0.1, countPerPlayer: 1, rotationOffset: 0, flatRadius: 80, height: 0 },

    // Inner ring — 1 deposit per player, sitting on a low rise so it
    // reads as a defensible knoll.
    { radiusFraction: 0.2, countPerPlayer: 1, rotationOffset: 0, flatRadius: 70, height: 60 },

    // Outer ring — 2 deposits per player, slightly raised. Closer to
    // bases and easier to defend.
    { radiusFraction: 0.3, countPerPlayer: 2, rotationOffset: 0, flatRadius: 60, height: 30 },
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
  /** Z elevation (sim units) of this deposit's flat pad. */
  height: number;
};

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
  const halfExtent = Math.min(mapWidth, mapHeight) / 2 - METAL_DEPOSIT_CONFIG.edgeMarginPx;
  const cx = mapWidth / 2;
  const cy = mapHeight / 2;
  const players = Math.max(1, playerCount);
  const sliceWidth = (2 * Math.PI) / players;
  let id = 0;

  for (const ring of METAL_DEPOSIT_CONFIG.rings) {
    const ringRadius = ring.radiusFraction * halfExtent;

    // Center: one deposit, regardless of countPerPlayer.
    if (ring.radiusFraction <= 1e-6) {
      deposits.push({ id: id++, x: cx, y: cy, flatRadius: ring.flatRadius, height: ring.height });
      continue;
    }

    for (let p = 0; p < players; p++) {
      const sliceCenter = getPlayerBaseAngle(p, players);
      for (let j = 0; j < ring.countPerPlayer; j++) {
        // Sub-slice midpoints: countPerPlayer=1 → t=0.5 → angle=sliceCenter;
        // countPerPlayer=2 → t=0.25, 0.75 → angles at ±sliceWidth/4 around centre.
        const t = (j + 0.5) / ring.countPerPlayer;
        const angleInSlice = -sliceWidth / 2 + t * sliceWidth;
        const angle = sliceCenter + angleInSlice + ring.rotationOffset;
        const x = cx + Math.cos(angle) * ringRadius;
        const y = cy + Math.sin(angle) * ringRadius;
        deposits.push({ id: id++, x, y, flatRadius: ring.flatRadius, height: ring.height });
      }
    }
  }

  return deposits;
}
