// Server-side shroud history (issues.txt FOW-11).
//
// Each player carries an explored-tile bitmap on WorldState — one
// byte per (SHROUD_CELL_SIZE × SHROUD_CELL_SIZE) cell, 0 = never seen,
// 1 = ever seen. Once a cell flips to 1 it stays at 1 forever; the
// client renders cells as either "currently visible" (live vision),
// "explored-dark" (bitmap=1 but no live vision), or "unexplored"
// (bitmap=0). Snapshot serializer ships the recipient's bitmap on
// keyframes so reconnects / replays / mid-game joins restore the
// shroud state instead of starting blank.
//
// Allied players share their explored history: ORing a single ally's
// bitmap into the recipient's view is the team-vision shroud (FOW-06).
// We don't merge teams into a single bitmap on the server because
// alliances are not currently mid-game-mutable — but if they ever are,
// the per-player record stays correct regardless.

import type { WorldState } from './WorldState';
import { SHROUD_CELL_SIZE } from './WorldState';
import type { PlayerId, Entity } from './types';
import {
  canEntityProvideVision,
  getEntityVisionRadius,
} from '../network/stateSerializerVisibility';
import { markCircleScanline } from './circleFill';

/** Update cadence in ticks. Run the OR pass every Nth tick to amortize
 *  cost across the simulation loop — shroud is a low-frequency
 *  exploration record, not real-time tactical info. ~10 Hz at 60 Hz
 *  tick rate matches the client renderer's UPDATE_INTERVAL_MS. */
const UPDATE_EVERY_N_TICKS = 6;

/** Mark cells revealed by a player's current vision sources. Called by
 *  Simulation.update each tick (sub-sampled to UPDATE_EVERY_N_TICKS).
 *  Allocates the bitmap lazily so a player who never produces a
 *  vision source never owns one. Bumps the player's
 *  shroudBitmapVersions counter whenever at least one new cell
 *  flipped 0→1 so the publisher can detect "nothing changed since
 *  the last ship" (issues.txt FOW-OPT-02). */
export function updateShroudBitmaps(world: WorldState, tick: number): void {
  if (!world.fogOfWarEnabled) return;
  if (tick % UPDATE_EVERY_N_TICKS !== 0) return;

  for (let playerId = 1; playerId <= world.playerCount; playerId++) {
    let bitmap = world.shroudBitmaps.get(playerId);
    const gridW = world.shroudGridW;
    const gridH = world.shroudGridH;
    if (!bitmap) {
      bitmap = new Uint8Array(gridW * gridH);
      world.shroudBitmaps.set(playerId, bitmap);
    }
    let modified = revealForSources(
      bitmap,
      gridW,
      gridH,
      world.getUnitsByPlayer(playerId),
    );
    modified = revealForSources(
      bitmap,
      gridW,
      gridH,
      world.getBuildingsByPlayer(playerId),
    ) || modified;
    // Active scanner sweeps also count as exploration: a tile lit by
    // a sweep should stay in the dark-shroud state forever even after
    // the sweep ends, the same way a passing scout reveals tiles.
    modified = revealForScanPulses(bitmap, gridW, gridH, world, playerId) || modified;
    if (modified) {
      world.shroudBitmapVersions.set(
        playerId,
        (world.shroudBitmapVersions.get(playerId) ?? 0) + 1,
      );
    }
  }
}

function revealForSources(
  bitmap: Uint8Array,
  gridW: number,
  gridH: number,
  entities: readonly Entity[],
): boolean {
  let modified = false;
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    if (!canEntityProvideVision(entity)) continue;
    const radius = getEntityVisionRadius(entity);
    if (radius <= 0) continue;
    if (markCircle(
      bitmap,
      gridW,
      gridH,
      entity.transform.x,
      entity.transform.y,
      radius,
    )) {
      modified = true;
    }
  }
  return modified;
}

function revealForScanPulses(
  bitmap: Uint8Array,
  gridW: number,
  gridH: number,
  world: WorldState,
  playerId: PlayerId,
): boolean {
  const pulses = world.scanPulses;
  let modified = false;
  for (let i = 0; i < pulses.length; i++) {
    const pulse = pulses[i];
    if (pulse.playerId !== playerId) continue;
    if (markCircle(bitmap, gridW, gridH, pulse.x, pulse.y, pulse.radius)) {
      modified = true;
    }
  }
  return modified;
}

function markCircle(
  bitmap: Uint8Array,
  gridW: number,
  gridH: number,
  cx: number,
  cy: number,
  radius: number,
): boolean {
  // Convert world units → cell units, then defer to the shared
  // scanline helper (issues.txt FOW-OPT-05). Cell-center sampling
  // (cellAnchor=0.5) matches the original per-cell test that used
  // `dx = x + 0.5 - cellCx`.
  const cellSize = SHROUD_CELL_SIZE;
  return markCircleScanline(
    bitmap,
    gridW,
    gridH,
    cx / cellSize,
    cy / cellSize,
    radius / cellSize,
    0.5,
  );
}

/** Sum of the recipient's and their allies' bitmap versions —
 *  monotonically increases iff the team-merged bitmap has new content
 *  since the last poll. The publisher caches the last-sent sum per
 *  listener and skips the shroud field entirely on keyframes where
 *  the sum is unchanged (issues.txt FOW-OPT-02). */
export function computeTeamShroudVersionSum(
  world: WorldState,
  recipientPlayerId: PlayerId,
): number {
  let sum = world.shroudBitmapVersions.get(recipientPlayerId) ?? 0;
  for (const allyId of world.getAllies(recipientPlayerId)) {
    sum += world.shroudBitmapVersions.get(allyId) ?? 0;
  }
  return sum;
}

/** Scratch byte-per-cell merge buffer. Sized lazily on first use and
 *  resized if the shroud grid grows; reused across recipients so the
 *  per-emit publish doesn't allocate gridW*gridH bytes per listener. */
let _mergeScratch: Uint8Array | null = null;

function getMergeScratch(size: number): Uint8Array {
  if (!_mergeScratch || _mergeScratch.length !== size) {
    _mergeScratch = new Uint8Array(size);
  } else {
    _mergeScratch.fill(0);
  }
  return _mergeScratch;
}

/** Compose a per-recipient view bitmap by ORing the recipient's own
 *  history with every ally's, then bit-pack to one bit per cell for
 *  the wire (issues.txt FOW-OPT-02 — 8× smaller payload). Returns a
 *  fresh packed Uint8Array (the merge scratch is shared, the packed
 *  result is not). Returns null only when both the recipient and
 *  every ally have a zero version sum (no exploration recorded yet)
 *  so the snapshot field stays absent. */
export function buildRecipientShroudView(
  world: WorldState,
  recipientPlayerId: PlayerId,
): Uint8Array | null {
  if (computeTeamShroudVersionSum(world, recipientPlayerId) === 0) return null;
  const gridSize = world.shroudGridW * world.shroudGridH;
  const scratch = getMergeScratch(gridSize);
  const ownBitmap = world.shroudBitmaps.get(recipientPlayerId);
  if (ownBitmap) orInto(scratch, ownBitmap);
  for (const allyId of world.getAllies(recipientPlayerId)) {
    const ally = world.shroudBitmaps.get(allyId);
    if (ally) orInto(scratch, ally);
  }
  return packBitmap(scratch);
}

function orInto(dst: Uint8Array, src: Uint8Array): void {
  const n = Math.min(dst.length, src.length);
  for (let i = 0; i < n; i++) {
    if (src[i]) dst[i] = 1;
  }
}

/** Pack a byte-per-cell bitmap (each byte 0 or 1) into a bit-per-cell
 *  Uint8Array. Bit order: cell index i lives in byte (i >> 3) at bit
 *  (i & 7). The client unpacks with the symmetric pattern; this is
 *  internal-only wire encoding, not externally consumed. */
function packBitmap(src: Uint8Array): Uint8Array {
  const packed = new Uint8Array((src.length + 7) >> 3);
  for (let i = 0; i < src.length; i++) {
    if (src[i]) packed[i >> 3] |= 1 << (i & 7);
  }
  return packed;
}
