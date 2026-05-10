import type { NetworkCaptureTile } from '@/types/capture';
import type { NetworkServerSnapshot } from './NetworkTypes';
import type { TerrainBuildabilityGrid } from '@/types/terrain';

const CAPTURE_TILE_POOL_FALLBACK_CAP = 256;

type CaptureTileChanges = {
  version: number;
  full: boolean;
  tiles: NetworkCaptureTile[];
};

export class ClientCaptureTileStore {
  private tileMap: Map<number, NetworkCaptureTile> = new Map();
  private tilesCache: NetworkCaptureTile[] = [];
  private dirtyTileMap: Map<number, NetworkCaptureTile> = new Map();
  private dirtyTilesScratch: NetworkCaptureTile[] = [];
  private tilePool: NetworkCaptureTile[] = [];
  private fullDirty = true;
  private tilesDirty = true;
  private version = 0;
  private cellSize = 0;
  private terrainBuildabilityGrid: TerrainBuildabilityGrid | null = null;

  setTerrainBuildabilityGrid(grid: TerrainBuildabilityGrid | null): void {
    this.terrainBuildabilityGrid = grid;
    if (grid) this.trimTilePool();
  }

  applySnapshot(
    capture: NetworkServerSnapshot['capture'] | undefined,
    isDelta: boolean,
  ): void {
    if (!capture) {
      if (!isDelta) {
        this.clearTileMaps();
        this.fullDirty = true;
        this.tilesDirty = true;
        this.version++;
      }
      return;
    }

    this.cellSize = capture.cellSize;
    if (!isDelta) {
      this.clearTileMaps();
      this.fullDirty = true;
    }

    for (const tile of capture.tiles) {
      const key = captureTileKey(tile.cx, tile.cy);
      if (captureHeightsEmpty(tile.heights)) {
        this.removeTile(key, tile);
      } else {
        this.upsertTile(key, tile);
      }
    }
    this.tilesDirty = true;
    this.version++;
  }

  getTiles(): NetworkCaptureTile[] {
    if (this.tilesDirty) {
      this.tilesCache.length = 0;
      for (const tile of this.tileMap.values()) {
        this.tilesCache.push(tile);
      }
      this.tilesDirty = false;
    }
    return this.tilesCache;
  }

  consumeChanges(): CaptureTileChanges {
    if (this.fullDirty) {
      this.fullDirty = false;
      this.dirtyTileMap.clear();
      return {
        version: this.version,
        full: true,
        tiles: this.getTiles(),
      };
    }

    if (this.dirtyTileMap.size === 0) {
      return {
        version: this.version,
        full: false,
        tiles: [],
      };
    }

    const tiles = this.dirtyTilesScratch;
    tiles.length = 0;
    for (const tile of this.dirtyTileMap.values()) {
      tiles.push(tile);
    }
    this.dirtyTileMap.clear();
    return {
      version: this.version,
      full: false,
      tiles,
    };
  }

  getCellSize(): number {
    return this.cellSize;
  }

  getVersion(): number {
    return this.version;
  }

  reset(): void {
    this.clearTileMaps();
    this.tilePool.length = 0;
    this.fullDirty = true;
    this.tilesDirty = true;
    this.version++;
    this.cellSize = 0;
    this.terrainBuildabilityGrid = null;
  }

  private removeTile(key: number, tile: NetworkCaptureTile): void {
    const removed = this.tileMap.get(key);
    const previousDirty = this.dirtyTileMap.get(key);
    if (removed) {
      this.tileMap.delete(key);
      this.releaseTile(removed);
    }
    if (!this.fullDirty) {
      const dirty = this.acquireTile(tile.cx, tile.cy, undefined);
      if (previousDirty && previousDirty !== removed) this.releaseTile(previousDirty);
      this.dirtyTileMap.set(key, dirty);
    }
  }

  private upsertTile(key: number, tile: NetworkCaptureTile): void {
    const copy = this.acquireTile(tile.cx, tile.cy, tile.heights);
    const previous = this.tileMap.get(key);
    const previousDirty = this.dirtyTileMap.get(key);
    if (previous) this.releaseTile(previous);
    this.tileMap.set(key, copy);
    if (!this.fullDirty) {
      if (previousDirty && previousDirty !== previous) this.releaseTile(previousDirty);
      this.dirtyTileMap.set(key, copy);
    }
  }

  private acquireTile(
    cx: number,
    cy: number,
    heights: NetworkCaptureTile['heights'] | undefined,
  ): NetworkCaptureTile {
    const tile = this.tilePool.pop() ?? { cx: 0, cy: 0, heights: {} };
    tile.cx = cx;
    tile.cy = cy;
    const dst = tile.heights;
    for (const key in dst) delete dst[key];
    if (heights) {
      for (const key in heights) dst[Number(key)] = heights[key];
    }
    return tile;
  }

  private releaseTile(tile: NetworkCaptureTile): void {
    for (const key in tile.heights) delete tile.heights[key];
    if (this.tilePool.length < this.getTilePoolLimit()) {
      this.tilePool.push(tile);
    }
  }

  private getTilePoolLimit(): number {
    const grid = this.terrainBuildabilityGrid;
    if (!grid) return CAPTURE_TILE_POOL_FALLBACK_CAP;
    return Math.max(0, grid.cellsX * grid.cellsY);
  }

  private trimTilePool(): void {
    const limit = this.getTilePoolLimit();
    if (this.tilePool.length > limit) {
      this.tilePool.length = limit;
    }
  }

  private clearTileMaps(): void {
    for (const [key, tile] of this.dirtyTileMap) {
      if (this.tileMap.get(key) !== tile) this.releaseTile(tile);
    }
    this.dirtyTileMap.clear();
    for (const tile of this.tileMap.values()) this.releaseTile(tile);
    this.tileMap.clear();
    this.tilesCache.length = 0;
    this.dirtyTilesScratch.length = 0;
  }
}

function captureTileKey(cx: number, cy: number): number {
  return ((cx + 32768) & 0xFFFF) << 16 | ((cy + 32768) & 0xFFFF);
}

function captureHeightsEmpty(heights: NetworkCaptureTile['heights']): boolean {
  for (const _key in heights) return false;
  return true;
}
