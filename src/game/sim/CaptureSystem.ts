// Capture-the-tile system — territory painting driven by unit presence
//
// Each spatial grid cell is a "flag pole". Units standing on a cell claim
// it for their team and raise the flag. Enemy units lower the flag.
// When the flag hits zero the cell becomes neutral, then the dominant
// team claims it and starts raising.

import type { PlayerId } from './types';
import type { TileState, NetworkCaptureTile } from '@/types/capture';
import { CAPTURE_CONFIG } from '../../captureConfig';

export class CaptureSystem {
  // key = bit-packed cell key (same as SpatialGrid), value = tile state
  private tiles: Map<number, TileState> = new Map();

  /** Process one tick of capture logic.
   *  `occupiedCells` comes straight from the spatial grid — only cells
   *  with at least one living unit are included.
   *  Each entry maps a cell key to an array of player IDs (one per unit). */
  update(
    occupiedCells: { key: number; players: PlayerId[] }[],
    dtSec: number,
  ): void {
    const { raiseRatePerUnit, lowerRatePerUnit, contestedDecay, contestedDecayRate } = CAPTURE_CONFIG;

    for (let i = 0; i < occupiedCells.length; i++) {
      const { key, players } = occupiedCells[i];
      if (players.length === 0) continue;

      let tile = this.tiles.get(key);
      if (!tile) {
        tile = { teamId: null, flagHeight: 0 };
        this.tiles.set(key, tile);
      }

      if (tile.teamId === null) {
        // Unclaimed — find dominant team
        const dominant = getDominantTeam(players);
        if (dominant.team !== null) {
          tile.teamId = dominant.team;
          tile.flagHeight = 0;
          // Apply raise in same tick
          const netFriendly = dominant.friendlyCount - dominant.enemyCount;
          if (netFriendly > 0) {
            tile.flagHeight = Math.min(netFriendly * raiseRatePerUnit * dtSec, 1);
          }
        }
        // else: tied, stays null
      } else {
        // Owned — count friendly vs enemy
        let friendly = 0;
        let enemy = 0;
        for (let j = 0; j < players.length; j++) {
          if (players[j] === tile.teamId) {
            friendly++;
          } else {
            enemy++;
          }
        }

        const net = friendly * raiseRatePerUnit - enemy * lowerRatePerUnit;

        if (net > 0) {
          // Raising
          tile.flagHeight = Math.min(tile.flagHeight + net * dtSec, 1);
        } else if (net < 0) {
          // Lowering
          tile.flagHeight += net * dtSec;
          if (tile.flagHeight <= 0) {
            // Flag hit zero — neutralize
            tile.flagHeight = 0;
            tile.teamId = null;
            // Immediately try to claim for dominant enemy
            const dominant = getDominantTeam(players);
            if (dominant.team !== null) {
              tile.teamId = dominant.team;
            }
          }
        } else if (contestedDecay && friendly === 0 && enemy === 0) {
          // No units but tile exists — shouldn't happen via occupiedCells
        } else if (contestedDecay && net === 0) {
          // Perfectly contested — decay
          tile.flagHeight = Math.max(tile.flagHeight - contestedDecayRate * dtSec, 0);
          if (tile.flagHeight <= 0) {
            tile.teamId = null;
          }
        }
      }
    }
  }

  /** Get all tiles that have a team (for network/rendering).
   *  Returns a reusable array — do NOT store the reference. */
  getOwnedTiles(): NetworkCaptureTile[] {
    _ownedTiles.length = 0;
    for (const [key, tile] of this.tiles) {
      if (tile.teamId === null) continue;
      const cx = ((key >> 16) & 0xFFFF) - 32768;
      const cy = (key & 0xFFFF) - 32768;
      _ownedTiles.push({ cx, cy, teamId: tile.teamId, flagHeight: tile.flagHeight });
    }
    return _ownedTiles;
  }

  /** Count owned tiles per player. Returns a reusable map — do NOT store. */
  getTileCountsByPlayer(): Map<PlayerId, number> {
    _tileCounts.clear();
    for (const [, tile] of this.tiles) {
      if (tile.teamId === null) continue;
      _tileCounts.set(tile.teamId, (_tileCounts.get(tile.teamId) ?? 0) + 1);
    }
    return _tileCounts;
  }

  clear(): void {
    this.tiles.clear();
  }
}

const _tileCounts: Map<PlayerId, number> = new Map();

// Reusable result buffer
const _ownedTiles: NetworkCaptureTile[] = [];

// Reusable per-team count buffer (up to 8 teams)
const _teamCounts: number[] = [];

type DominantResult = { team: PlayerId | null; friendlyCount: number; enemyCount: number };
const _dominantResult: DominantResult = { team: null, friendlyCount: 0, enemyCount: 0 };

/** Find the team with the most units. Returns null if tied. */
function getDominantTeam(players: PlayerId[]): DominantResult {
  _teamCounts.length = 0;
  let maxCount = 0;
  let maxTeam: PlayerId | null = null;
  let tied = false;

  for (let i = 0; i < players.length; i++) {
    const pid = players[i];
    const idx = pid as number;
    while (_teamCounts.length <= idx) _teamCounts.push(0);
    _teamCounts[idx]++;
    if (_teamCounts[idx] > maxCount) {
      maxCount = _teamCounts[idx];
      maxTeam = pid;
      tied = false;
    } else if (_teamCounts[idx] === maxCount) {
      tied = true;
    }
  }

  // Clean up for next call
  for (let i = 0; i < _teamCounts.length; i++) _teamCounts[i] = 0;

  _dominantResult.team = tied ? null : maxTeam;
  _dominantResult.friendlyCount = maxCount;
  _dominantResult.enemyCount = players.length - maxCount;
  return _dominantResult;
}
