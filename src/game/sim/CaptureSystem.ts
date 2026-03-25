// Capture-the-tile system — territory painting driven by unit presence
//
// Each spatial grid cell has independent flag heights per team (0–1).
// Units raise their own team's flag and lower all other teams' flags.
// Mana income is proportional to the sum of a team's flag heights.

import type { PlayerId } from './types';
import type { TileState, NetworkCaptureTile } from '@/types/capture';
import { CAPTURE_CONFIG } from '../../captureConfig';

export class CaptureSystem {
  private tiles: Map<number, TileState> = new Map();
  private dirtyTiles: Set<number> = new Set();

  /** Process one tick. Each unit raises its team's flag and lowers others. */
  update(
    occupiedCells: { key: number; players: PlayerId[] }[],
    dtSec: number,
  ): void {
    const { raiseRatePerUnit, lowerRatePerUnit } = CAPTURE_CONFIG;

    for (let i = 0; i < occupiedCells.length; i++) {
      const { key, players } = occupiedCells[i];
      if (players.length === 0) continue;

      let tile = this.tiles.get(key);
      if (!tile) {
        tile = new Map();
        this.tiles.set(key, tile);
      }

      // Count units per team on this tile
      _unitCounts.clear();
      for (let j = 0; j < players.length; j++) {
        const pid = players[j];
        _unitCounts.set(pid, (_unitCounts.get(pid) ?? 0) + 1);
      }

      const totalUnits = players.length;
      let changed = false;

      // Raise flags for teams with units present
      for (const [pid, count] of _unitCounts) {
        const prev = tile.get(pid) ?? 0;
        const raised = Math.min(prev + count * raiseRatePerUnit * dtSec, 1);
        if (raised !== prev) {
          tile.set(pid, raised);
          changed = true;
        }
      }

      // Lower flags for teams WITHOUT units present (but who have a flag here)
      for (const [pid, height] of tile) {
        if (_unitCounts.has(pid)) continue; // they have units, already raised
        const lowered = height - totalUnits * lowerRatePerUnit * dtSec;
        if (lowered <= 0) {
          tile.delete(pid);
          changed = true;
        } else if (lowered !== height) {
          tile.set(pid, lowered);
          changed = true;
        }
      }

      // Clean up empty tiles
      if (tile.size === 0) {
        this.tiles.delete(key);
      }

      if (changed) {
        this.dirtyTiles.add(key);
      }
    }
  }

  /** Get tiles for a snapshot. Keyframe = all tiles. Delta = only changed tiles.
   *  Consumes the dirty set. Returns a reusable array — do NOT store. */
  consumeSnapshot(isDelta: boolean): NetworkCaptureTile[] {
    recycleTiles(_snapshotTiles);

    if (!isDelta) {
      // Keyframe: send all tiles
      for (const [key, tile] of this.tiles) {
        _snapshotTiles.push(tileToNetwork(key, tile));
      }
    } else {
      // Delta: only changed tiles
      for (const key of this.dirtyTiles) {
        const tile = this.tiles.get(key);
        if (tile) {
          _snapshotTiles.push(tileToNetwork(key, tile));
        } else {
          // Tile was fully cleared — send empty heights so client removes it
          const cx = ((key >> 16) & 0xFFFF) - 32768;
          const cy = (key & 0xFFFF) - 32768;
          _snapshotTiles.push(acquireTile(cx, cy));
        }
      }
    }

    this.dirtyTiles.clear();
    return _snapshotTiles;
  }

  /** Sum flag heights per player (for mana income). Reusable map — do NOT store. */
  getFlagSumsByPlayer(): Map<PlayerId, number> {
    _flagSums.clear();
    for (const [, tile] of this.tiles) {
      for (const [pid, height] of tile) {
        _flagSums.set(pid, (_flagSums.get(pid) ?? 0) + height);
      }
    }
    return _flagSums;
  }

  clear(): void {
    this.tiles.clear();
    this.dirtyTiles.clear();
  }
}

// --- Module-level reusable buffers ---

const _unitCounts: Map<PlayerId, number> = new Map();
const _flagSums: Map<PlayerId, number> = new Map();
const _snapshotTiles: NetworkCaptureTile[] = [];
const _tilePool: NetworkCaptureTile[] = [];

function acquireTile(cx: number, cy: number): NetworkCaptureTile {
  const t = _tilePool.length > 0 ? _tilePool.pop()! : { cx: 0, cy: 0, heights: {} };
  t.cx = cx;
  t.cy = cy;
  // Clear previous heights
  for (const k in t.heights) delete t.heights[k];
  return t;
}

function recycleTiles(tiles: NetworkCaptureTile[]): void {
  for (let i = 0; i < tiles.length; i++) _tilePool.push(tiles[i]);
  tiles.length = 0;
}

function tileToNetwork(key: number, tile: TileState): NetworkCaptureTile {
  const cx = ((key >> 16) & 0xFFFF) - 32768;
  const cy = (key & 0xFFFF) - 32768;
  const t = acquireTile(cx, cy);
  for (const [pid, h] of tile) {
    t.heights[pid as number] = h;
  }
  return t;
}
