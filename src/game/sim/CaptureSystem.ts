// Capture-the-tile system — territory painting driven by unit presence
//
// Each spatial grid cell has independent flag heights per team (0–1).
// Units raise their own team's flag and lower all other teams' flags.
// Mana income is proportional to the sum of a team's flag heights.

import type { PlayerId } from './types';
import type { TileState, NetworkCaptureTile } from '@/types/capture';
import { CAPTURE_CONFIG } from '../../captureConfig';
import { getManaTileProductionPerSecond } from './manaProduction';
import { MANA_PER_TILE_PER_SECOND } from '../../config';

export class CaptureSystem {
  private tiles: Map<number, TileState> = new Map();
  private dirtyTiles: Set<number> = new Set();
  /** Running per-player mana income totals (mana/sec), maintained
   *  incrementally by update() so getManaProductionRatesByPlayer()
   *  returns in O(1) instead of re-scanning every tile every tick.
   *  Each tile's contribution = height × MANA_PER_TILE_PER_SECOND ×
   *  hotspot-multiplier(tile-center) — the same multiplier the GRID
   *  renderer uses for tile colour brightness, so income and colour
   *  share one source of truth. */
  private productionRates: Map<PlayerId, number> = new Map();

  /** Map dimensions cached from setMapSize(); needed to evaluate the
   *  hotspot multiplier at each tile centre. Defaults make the system
   *  fall back to the uniform behaviour if setMapSize was never
   *  called (e.g. an empty test harness). */
  private mapWidth = 0;
  private mapHeight = 0;
  private cellSize = 0;

  /** Tell the system the map it lives on so per-tile mana production
   *  rates can be computed. Must be called before update() runs.
   *  Idempotent — safe to call once at construction. */
  setMapSize(mapWidth: number, mapHeight: number, cellSize: number): void {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.cellSize = cellSize;
  }

  /** Mana per second a single tile produces when fully captured by
   *  one team. Computed from the cached map dimensions + cell size
   *  so the renderer and the income code stay in lockstep. Returns
   *  the uniform base rate when setMapSize hasn't been called yet. */
  private getTileProduction(key: number): number {
    // No map size yet → uniform base rate (fallback for tests / empty harness).
    if (this.cellSize <= 0) return MANA_PER_TILE_PER_SECOND;
    const cx = ((key >> 16) & 0xFFFF) - 32768;
    const cy = (key & 0xFFFF) - 32768;
    const wx = (cx + 0.5) * this.cellSize;
    const wy = (cy + 0.5) * this.cellSize;
    return getManaTileProductionPerSecond(wx, wy, this.mapWidth, this.mapHeight);
  }

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
      // Per-tile mana-per-second rate (constant for this cell). Each
      // height delta contributes deltaHeight × tileProd to its
      // owning player's running income total.
      const tileProd = this.getTileProduction(key);

      // Raise flags for teams with units present
      for (const [pid, count] of _unitCounts) {
        const prev = tile.get(pid) ?? 0;
        const raised = Math.min(prev + count * raiseRatePerUnit * dtSec, 1);
        if (raised !== prev) {
          tile.set(pid, raised);
          changed = true;
          // Maintain the running per-player total incrementally so
          // getManaProductionRatesByPlayer doesn't need its own scan
          // over every tile.
          this.productionRates.set(
            pid,
            (this.productionRates.get(pid) ?? 0) + (raised - prev) * tileProd,
          );
        }
      }

      // Lower flags for teams WITHOUT units present (but who have a flag here)
      for (const [pid, height] of tile) {
        if (_unitCounts.has(pid)) continue; // they have units, already raised
        const lowered = height - totalUnits * lowerRatePerUnit * dtSec;
        if (lowered <= 0) {
          tile.delete(pid);
          changed = true;
          // Removing the entry means the running total drops by the
          // FULL old height (the tile entry vanishes from this.tiles).
          const rate = (this.productionRates.get(pid) ?? 0) - height * tileProd;
          if (rate > 1e-9) this.productionRates.set(pid, rate);
          else this.productionRates.delete(pid);
        } else if (lowered !== height) {
          tile.set(pid, lowered);
          changed = true;
          this.productionRates.set(
            pid,
            (this.productionRates.get(pid) ?? 0) + (lowered - height) * tileProd,
          );
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

  /** Per-player mana income from territory, in mana per second.
   *  Already weighted by per-tile hotspot multipliers — no further
   *  scaling needed at the call site. Returns the live per-tick
   *  incremental total — do NOT store the reference, do NOT mutate. */
  getManaProductionRatesByPlayer(): Map<PlayerId, number> {
    return this.productionRates;
  }

  clear(): void {
    this.tiles.clear();
    this.dirtyTiles.clear();
    this.productionRates.clear();
  }

  /** Pre-capture every grid cell outside a central neutral disc to the
   *  team whose radial sector contains it, so the map starts already
   *  partitioned along the same angular sectors the spawn-circle and
   *  terrain-divider ridges use.
   *
   *  Sector math mirrors spawn.ts → getPlayerBaseAngle: player i is
   *  centered at `(i / N) * 2π + firstPlayerAngle`, so we shift the
   *  cell's angle by `-firstPlayerAngle + π/N` (half a sector width)
   *  before dividing into N buckets — the result lands player 0's
   *  sector at index 0.
   *
   *  Each touched tile is added to dirtyTiles so the very next snapshot
   *  (whether keyframe or delta) ships the new ownership. The running
   *  per-player production-rate total is bumped per team so mana
   *  income reflects starting territory (plus its hotspot weighting)
   *  before any unit moves.
   *
   *  Safe to call only on a fresh system — assumes no existing tiles. */
  initializeRadialOwnership(
    mapWidth: number,
    mapHeight: number,
    cellSize: number,
    playerIds: PlayerId[],
    firstPlayerAngle: number,
    neutralRadius: number,
    ownerHeight: number,
  ): void {
    const N = playerIds.length;
    if (N <= 0 || ownerHeight <= 0) return;

    const cx0 = mapWidth / 2;
    const cy0 = mapHeight / 2;
    const cellsX = Math.max(1, Math.ceil(mapWidth / cellSize));
    const cellsY = Math.max(1, Math.ceil(mapHeight / cellSize));
    const sectorWidth = (Math.PI * 2) / N;
    const neutralRadiusSq = neutralRadius * neutralRadius;
    const TWO_PI = Math.PI * 2;

    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
        // Cell centroid in world coords (matches the spatial-grid /
        // capture-tile encoding used everywhere else).
        const wx = (cx + 0.5) * cellSize;
        const wy = (cy + 0.5) * cellSize;
        const dx = wx - cx0;
        const dy = wy - cy0;
        if (dx * dx + dy * dy <= neutralRadiusSq) continue;

        // Angle in [0, 2π), then shift into the player-0-at-0 frame.
        let theta = Math.atan2(dy, dx) - firstPlayerAngle + sectorWidth * 0.5;
        theta = ((theta % TWO_PI) + TWO_PI) % TWO_PI;
        const idx = Math.floor(theta / sectorWidth) % N;
        const pid = playerIds[idx];

        const key = ((cx + 32768) << 16) | (cy + 32768);
        const tile: TileState = new Map();
        tile.set(pid, ownerHeight);
        this.tiles.set(key, tile);
        this.dirtyTiles.add(key);
        // Production rate increment uses the per-tile mana/sec rate
        // at this cell — center tiles inside the hotspot disc count
        // for more income from frame 1.
        const tileProd = getManaTileProductionPerSecond(wx, wy, mapWidth, mapHeight);
        this.productionRates.set(
          pid,
          (this.productionRates.get(pid) ?? 0) + ownerHeight * tileProd,
        );
      }
    }
  }
}

// --- Module-level reusable buffers ---

const _unitCounts: Map<PlayerId, number> = new Map();
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
