// Capture-the-tile system — territory painting driven by unit presence
//
// Each mana/capture tile has independent flag heights per team (0–1).
// Units raise their own team's flag and lower all other teams' flags.
// Mana income is proportional to the sum of a team's flag heights.

import type { PlayerId } from './types';
import type { TileState, NetworkCaptureTile } from '@/types/capture';
import { CAPTURE_CONFIG } from '../../captureConfig';
import { getManaTileProductionPerSecond } from './manaProduction';
import {
  landCellCenterXForMetrics,
  landCellCenterYForMetrics,
  makeLandGridMetrics,
  packLandCellKey,
  unpackLandCellX,
  unpackLandCellY,
  writeLandCellBounds,
  type LandCellBounds,
  type LandGridMetrics,
} from '../landGrid';

export class CaptureSystem {
  private tiles: Map<number, TileState> = new Map();
  private dirtyTiles: Set<number> = new Set();
  /** Running per-player mana income totals (mana/sec), maintained
   *  incrementally by update() so getManaProductionRatesByPlayer()
   *  returns in O(1) instead of re-scanning every tile every tick.
   *  Each tile's contribution = ownership-height × tile-rate, where
   *  the tile rate comes from getManaTileProductionPerSecond (the
   *  same function the GRID renderer uses for colour brightness, so
   *  income and on-screen brightness share one source of truth). */
  private productionRates: Map<PlayerId, number> = new Map();

  /** Map dimensions cached from setMapSize(); needed to evaluate the
   *  hotspot multiplier at each tile centre. Defaults make the system
   *  fall back to the uniform behaviour if setMapSize was never
   *  called (e.g. an empty test harness). */
  private mapWidth = 0;
  private mapHeight = 0;
  private cellSize = 0;
  private landGrid: LandGridMetrics = makeLandGridMetrics(0, 0);
  private tileProductionCache: Map<number, number> = new Map();

  /** Tell the system the map it lives on so per-tile mana production
   *  rates can be computed. Must be called before update() runs.
   *  Idempotent — safe to call once at construction. */
  setMapSize(mapWidth: number, mapHeight: number, cellSize: number): void {
    if (
      this.mapWidth !== mapWidth ||
      this.mapHeight !== mapHeight ||
      this.cellSize !== cellSize
    ) {
      this.tileProductionCache.clear();
    }
    this.landGrid = makeLandGridMetrics(mapWidth, mapHeight, cellSize);
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.cellSize = this.landGrid.cellSize;
  }

  getCellSize(): number {
    return this.cellSize;
  }

  /** Mana per second a single tile produces when fully captured by
   *  one team. Computed from the cached map dimensions + cell size
   *  so the renderer and the income code stay in lockstep. Calling
   *  the helper with zeroed dimensions returns the perimeter base
   *  rate, which is the desired fallback when setMapSize hasn't
   *  been called yet (tests / empty harness). */
  private getTileProduction(key: number): number {
    if (this.cellSize <= 0) {
      return getManaTileProductionPerSecond(0, 0, 0, 0);
    }
    const cached = this.tileProductionCache.get(key);
    if (cached !== undefined) return cached;
    const cx = unpackLandCellX(key);
    const cy = unpackLandCellY(key);
    const wx = landCellCenterXForMetrics(this.landGrid, cx);
    const wy = landCellCenterYForMetrics(this.landGrid, cy);
    const production = getManaTileProductionPerSecond(wx, wy, this.mapWidth, this.mapHeight);
    this.tileProductionCache.set(key, production);
    return production;
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
          const cx = unpackLandCellX(key);
          const cy = unpackLandCellY(key);
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
    this.tileProductionCache.clear();
  }

  /** Pre-capture every mana tile to the team whose radial sector
   *  contains it, so the map starts already partitioned along the
   *  same angular sectors the spawn-circle and terrain-divider
   *  ridges use.
   *
   *  Tiles fully inside one slice get height = ownerHeight for that
   *  team. Tiles that straddle a sector boundary are split by sampled
   *  area fraction, then written as sqrt(fraction) ownership heights:
   *  a tile 30% in A, 10% in B, 60% in C gets
   *  (sqrt(0.30), sqrt(0.10), sqrt(0.60)) × ownerHeight. This gives
   *  contested radial seam tiles a stronger visual/economy presence
   *  while still preserving each team's ordering by actual area share.
   *  The split is computed by sub-sampling the tile on a regular
   *  sub-grid and counting which slice each sample falls in; the centre
   *  tile naturally ends up shared roughly equally among all N teams,
   *  so there's no need for a separate neutral disc.
   *
   *  Sector math mirrors spawn.ts → getPlayerBaseAngle: player i is
   *  centred at `(i / N) * 2π + firstPlayerAngle`, so we shift each
   *  sample's angle by `-firstPlayerAngle + π/N` (half a sector
   *  width) before dividing into N buckets — the result lands
   *  player 0's sector at index 0.
   *
   *  Each touched tile is added to dirtyTiles so the next snapshot
   *  ships the ownership. Per-player production-rate totals are
   *  bumped so mana income reflects starting territory (plus its
   *  hotspot weighting) from frame 1.
   *
   *  Safe to call only on a fresh system — assumes no existing tiles. */
  initializeRadialOwnership(
    mapWidth: number,
    mapHeight: number,
    cellSize: number,
    playerIds: PlayerId[],
    firstPlayerAngle: number,
    ownerHeight: number,
  ): void {
    const N = playerIds.length;
    if (N <= 0 || ownerHeight <= 0) return;
    this.setMapSize(mapWidth, mapHeight, cellSize);

    const cx0 = mapWidth / 2;
    const cy0 = mapHeight / 2;
    const grid = this.landGrid;
    const cellsX = grid.cellsX;
    const cellsY = grid.cellsY;
    const sectorWidth = (Math.PI * 2) / N;
    const TWO_PI = Math.PI * 2;

    // Sub-sample each tile on an SxS grid and count which slice
    // each sample falls in. S=8 → 64 samples/tile, ~1.6% accuracy
    // on slice fractions, well below visual / sim discrimination.
    const S = 8;
    const sampleCounts = new Array<number>(N).fill(0);
    const totalSamples = S * S;
    const angleShift = -firstPlayerAngle + sectorWidth * 0.5;
    const bounds: LandCellBounds = { x0: 0, y0: 0, x1: 0, y1: 0 };

    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
        writeLandCellBounds(grid, cx, cy, bounds);
        const subStepX = (bounds.x1 - bounds.x0) / S;
        const subStepY = (bounds.y1 - bounds.y0) / S;
        const subStartX = subStepX * 0.5; // first sample at sub-cell centre
        const subStartY = subStepY * 0.5;

        for (let n = 0; n < N; n++) sampleCounts[n] = 0;

        for (let sj = 0; sj < S; sj++) {
          const dy = bounds.y0 + subStartY + sj * subStepY - cy0;
          for (let si = 0; si < S; si++) {
            const dx = bounds.x0 + subStartX + si * subStepX - cx0;
            let theta = Math.atan2(dy, dx) + angleShift;
            theta = ((theta % TWO_PI) + TWO_PI) % TWO_PI;
            const idx = Math.floor(theta / sectorWidth) % N;
            sampleCounts[idx]++;
          }
        }

        const key = packLandCellKey(cx, cy);
        // Per-tile mana production at the cell's centroid — same
        // rate the sim and renderer use for this tile.
        const tileProd = this.getTileProduction(key);
        const tile: TileState = new Map();
        for (let n = 0; n < N; n++) {
          const count = sampleCounts[n];
          if (count === 0) continue;
          const areaFraction = count / totalSamples;
          const height = ownerHeight * Math.sqrt(areaFraction);
          const pid = playerIds[n];
          tile.set(pid, height);
          this.productionRates.set(
            pid,
            (this.productionRates.get(pid) ?? 0) + height * tileProd,
          );
        }
        if (tile.size > 0) {
          this.tiles.set(key, tile);
          this.dirtyTiles.add(key);
        }
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
  const cx = unpackLandCellX(key);
  const cy = unpackLandCellY(key);
  const t = acquireTile(cx, cy);
  for (const [pid, h] of tile) {
    t.heights[pid as number] = h;
  }
  return t;
}
