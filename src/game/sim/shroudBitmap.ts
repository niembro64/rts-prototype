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

/** Update cadence in ticks. Run the OR pass every Nth tick to amortize
 *  cost across the simulation loop — shroud is a low-frequency
 *  exploration record, not real-time tactical info. ~10 Hz at 60 Hz
 *  tick rate matches the client renderer's UPDATE_INTERVAL_MS. */
const UPDATE_EVERY_N_TICKS = 6;

/** Mark cells revealed by a player's current vision sources. Called by
 *  Simulation.update each tick (sub-sampled to UPDATE_EVERY_N_TICKS).
 *  Allocates the bitmap lazily so a player who never produces a
 *  vision source never owns one. */
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
    revealForSources(
      bitmap,
      gridW,
      gridH,
      world.getUnitsByPlayer(playerId),
    );
    revealForSources(
      bitmap,
      gridW,
      gridH,
      world.getBuildingsByPlayer(playerId),
    );
    // Active scanner sweeps also count as exploration: a tile lit by
    // a sweep should stay in the dark-shroud state forever even after
    // the sweep ends, the same way a passing scout reveals tiles.
    revealForScanPulses(bitmap, gridW, gridH, world, playerId);
  }
}

function revealForSources(
  bitmap: Uint8Array,
  gridW: number,
  gridH: number,
  entities: readonly Entity[],
): void {
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    if (!canEntityProvideVision(entity)) continue;
    const radius = getEntityVisionRadius(entity);
    if (radius <= 0) continue;
    markCircle(
      bitmap,
      gridW,
      gridH,
      entity.transform.x,
      entity.transform.y,
      radius,
    );
  }
}

function revealForScanPulses(
  bitmap: Uint8Array,
  gridW: number,
  gridH: number,
  world: WorldState,
  playerId: PlayerId,
): void {
  const pulses = world.scanPulses;
  for (let i = 0; i < pulses.length; i++) {
    const pulse = pulses[i];
    if (pulse.playerId !== playerId) continue;
    markCircle(bitmap, gridW, gridH, pulse.x, pulse.y, pulse.radius);
  }
}

function markCircle(
  bitmap: Uint8Array,
  gridW: number,
  gridH: number,
  cx: number,
  cy: number,
  radius: number,
): void {
  const cellSize = SHROUD_CELL_SIZE;
  const cellRadius = radius / cellSize;
  const cellCx = cx / cellSize;
  const cellCy = cy / cellSize;
  const minX = Math.max(0, Math.floor(cellCx - cellRadius));
  const maxX = Math.min(gridW - 1, Math.ceil(cellCx + cellRadius));
  const minY = Math.max(0, Math.floor(cellCy - cellRadius));
  const maxY = Math.min(gridH - 1, Math.ceil(cellCy + cellRadius));
  const r2 = cellRadius * cellRadius;
  for (let y = minY; y <= maxY; y++) {
    const dy = y + 0.5 - cellCy;
    const row = y * gridW;
    for (let x = minX; x <= maxX; x++) {
      const dx = x + 0.5 - cellCx;
      if (dx * dx + dy * dy <= r2) bitmap[row + x] = 1;
    }
  }
}

/** Compose a per-recipient view bitmap by ORing the recipient's own
 *  history with every ally's. Returns a fresh Uint8Array (sized to
 *  the shroud grid) so the serializer can ship it directly without
 *  worrying about aliasing the authoritative arrays. Returns null
 *  when the recipient has no recorded history yet — the snapshot
 *  field stays absent in that case. */
export function buildRecipientShroudView(
  world: WorldState,
  recipientPlayerId: PlayerId,
): Uint8Array | null {
  const allies = world.getAllies(recipientPlayerId);
  const ownBitmap = world.shroudBitmaps.get(recipientPlayerId);
  if (!ownBitmap && allies.size === 0) return null;
  const view = new Uint8Array(world.shroudGridW * world.shroudGridH);
  if (ownBitmap) orInto(view, ownBitmap);
  for (const allyId of allies) {
    const ally = world.shroudBitmaps.get(allyId);
    if (ally) orInto(view, ally);
  }
  // No allies, no own bitmap → all zeros; skip the alloc.
  for (let i = 0; i < view.length; i++) if (view[i]) return view;
  return null;
}

function orInto(dst: Uint8Array, src: Uint8Array): void {
  const n = Math.min(dst.length, src.length);
  for (let i = 0; i < n; i++) {
    if (src[i]) dst[i] = 1;
  }
}
