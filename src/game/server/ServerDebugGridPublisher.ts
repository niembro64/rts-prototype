import {
  SERVER_GRID_DEBUG_INTERVAL_MS,
  SERVER_GRID_DEBUG_MAX_OCCUPIED_CELLS,
  SERVER_GRID_DEBUG_MAX_SEARCH_CELLS,
} from '../../config';
import type { NetworkServerSnapshotGridCell } from '../network/NetworkTypes';
import { spatialGrid } from '../sim/SpatialGrid';
import type { WorldState } from '../sim/WorldState';

const GRID_DEBUG_KEY_BIAS = 10000;
const GRID_DEBUG_KEY_BASE = 20000;
const GRID_DEBUG_KEY_Y_MULT = GRID_DEBUG_KEY_BASE;
const GRID_DEBUG_KEY_X_MULT = GRID_DEBUG_KEY_BASE * GRID_DEBUG_KEY_BASE;
const GRID_DEBUG_CELL_POOL_MAX =
  SERVER_GRID_DEBUG_MAX_OCCUPIED_CELLS + SERVER_GRID_DEBUG_MAX_SEARCH_CELLS;

export type ServerDebugGridSnapshot = {
  cells?: NetworkServerSnapshotGridCell[];
  searchCells?: NetworkServerSnapshotGridCell[];
  cellSize?: number;
};

export class ServerDebugGridPublisher {
  private enabled = false;
  private cellsCache: NetworkServerSnapshotGridCell[] = [];
  private searchCellsCache: NetworkServerSnapshotGridCell[] = [];
  private cellPool: NetworkServerSnapshotGridCell[] = [];
  private searchCellMaskByKey = new Map<number, number>();
  private lastSnapshotMs = -Infinity;
  private forceRefresh = true;

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.forceRefresh = true;
    this.lastSnapshotMs = -Infinity;
    if (!enabled) {
      this.clear();
    }
  }

  clear(): void {
    this.releaseCells(this.cellsCache);
    this.releaseCells(this.searchCellsCache);
    this.cellPool.length = 0;
    this.searchCellMaskByKey.clear();
  }

  refresh(nowMs: number, world: WorldState): ServerDebugGridSnapshot {
    if (!this.enabled) return {};
    if (
      !this.forceRefresh &&
      nowMs - this.lastSnapshotMs < SERVER_GRID_DEBUG_INTERVAL_MS
    ) {
      return {};
    }

    this.forceRefresh = false;
    this.lastSnapshotMs = nowMs;
    this.computeOccupiedCells();
    this.computeSearchCells(world);
    // The internal cellsCache / searchCellsCache are recycled into the
    // cellPool on the next refresh — handing them straight to the
    // snapshot would let those mutations land in data the client (or
    // SnapshotBuffer) is still holding on the local-host path, where
    // there's no msgpack copy. Emit a fresh array of fresh cell objects
    // each refresh so emitted snapshots are immutable from here on.
    return {
      cells: this.snapshotCells(this.cellsCache),
      searchCells: this.snapshotCells(this.searchCellsCache),
      cellSize: spatialGrid.getCellSize(),
    };
  }

  private snapshotCells(
    src: NetworkServerSnapshotGridCell[],
  ): NetworkServerSnapshotGridCell[] {
    const out: NetworkServerSnapshotGridCell[] = new Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const s = src[i];
      out[i] = {
        cell: { x: s.cell.x, y: s.cell.y, z: s.cell.z },
        players: s.players.slice(),
      };
    }
    return out;
  }

  private acquireCell(
    cx: number,
    cy: number,
    cz: number,
    playersMask: number,
  ): NetworkServerSnapshotGridCell {
    const cell = this.cellPool.pop() ?? { cell: { x: 0, y: 0, z: 0 }, players: [] };
    cell.cell.x = cx;
    cell.cell.y = cy;
    cell.cell.z = cz;
    this.writePlayers(cell.players, playersMask);
    return cell;
  }

  private releaseCells(cells: NetworkServerSnapshotGridCell[]): void {
    for (let i = 0; i < cells.length; i++) {
      cells[i].players.length = 0;
      if (this.cellPool.length < GRID_DEBUG_CELL_POOL_MAX) {
        this.cellPool.push(cells[i]);
      }
    }
    cells.length = 0;
  }

  private writePlayers(players: number[], playersMask: number): void {
    players.length = 0;
    for (let playerId = 1; playerId <= 31; playerId++) {
      if ((playersMask & (1 << (playerId - 1))) !== 0) players.push(playerId);
    }
  }

  private playerMask(playerId: number | undefined): number {
    if (playerId === undefined || playerId < 1 || playerId > 31) return 0;
    return 1 << (playerId - 1);
  }

  private packCellKey(cx: number, cy: number, cz: number): number {
    return (
      (cx + GRID_DEBUG_KEY_BIAS) * GRID_DEBUG_KEY_X_MULT +
      (cy + GRID_DEBUG_KEY_BIAS) * GRID_DEBUG_KEY_Y_MULT +
      (cz + GRID_DEBUG_KEY_BIAS)
    );
  }

  private unpackCellKey(key: number): { cx: number; cy: number; cz: number } {
    const cz = (key % GRID_DEBUG_KEY_BASE) - GRID_DEBUG_KEY_BIAS;
    const cy = (Math.floor(key / GRID_DEBUG_KEY_Y_MULT) % GRID_DEBUG_KEY_BASE) - GRID_DEBUG_KEY_BIAS;
    const cx = Math.floor(key / GRID_DEBUG_KEY_X_MULT) - GRID_DEBUG_KEY_BIAS;
    return { cx, cy, cz };
  }

  private computeOccupiedCells(): void {
    this.releaseCells(this.cellsCache);
    const occupiedCells = spatialGrid.getOccupiedCells();
    const count = Math.min(occupiedCells.length, SERVER_GRID_DEBUG_MAX_OCCUPIED_CELLS);
    for (let i = 0; i < count; i++) {
      const src = occupiedCells[i];
      let mask = 0;
      for (let p = 0; p < src.players.length; p++) {
        mask |= this.playerMask(src.players[p]);
      }
      this.cellsCache.push(
        this.acquireCell(src.cell.x, src.cell.y, src.cell.z, mask),
      );
    }
  }

  private computeSearchCells(world: WorldState): void {
    this.releaseCells(this.searchCellsCache);
    this.searchCellMaskByKey.clear();
    const cellSize = spatialGrid.getCellSize();
    if (cellSize <= 0) return;

    for (const unit of world.getUnits()) {
      if (!unit.unit || unit.unit.hp <= 0) continue;
      const turrets = unit.combat?.turrets;
      if (!turrets || turrets.length === 0) continue;
      const playerId = unit.ownership?.playerId;
      if (playerId === undefined) continue;
      const playerMask = this.playerMask(playerId);
      if (playerMask === 0) continue;

      let maxSeeRange = 0;
      for (let i = 0; i < turrets.length; i++) {
        const r = turrets[i].ranges;
        const seeRange = (r.tracking ?? r.fire.max).release;
        if (seeRange > maxSeeRange) maxSeeRange = seeRange;
      }
      if (maxSeeRange <= 0) continue;

      const x = unit.transform.x;
      const y = unit.transform.y;
      const z = unit.transform.z;
      const halfCell = cellSize / 2;
      const minCx = Math.floor((x - maxSeeRange) / cellSize);
      const maxCx = Math.floor((x + maxSeeRange) / cellSize);
      const minCy = Math.floor((y - maxSeeRange) / cellSize);
      const maxCy = Math.floor((y + maxSeeRange) / cellSize);
      const minCz = Math.floor((z - maxSeeRange + halfCell) / cellSize);
      const maxCz = Math.floor((z + maxSeeRange + halfCell) / cellSize);

      for (let cz = minCz; cz <= maxCz; cz++) {
        for (let cy = minCy; cy <= maxCy; cy++) {
          for (let cx = minCx; cx <= maxCx; cx++) {
            const key = this.packCellKey(cx, cy, cz);
            const previousMask = this.searchCellMaskByKey.get(key);
            if (previousMask === undefined) {
              if (this.searchCellMaskByKey.size >= SERVER_GRID_DEBUG_MAX_SEARCH_CELLS) {
                continue;
              }
              this.searchCellMaskByKey.set(key, playerMask);
            } else if ((previousMask & playerMask) === 0) {
              this.searchCellMaskByKey.set(key, previousMask | playerMask);
            }
          }
        }
      }
    }

    for (const [key, playersMask] of this.searchCellMaskByKey) {
      const { cx, cy, cz } = this.unpackCellKey(key);
      this.searchCellsCache.push(
        this.acquireCell(cx, cy, cz, playersMask),
      );
    }
  }
}
