import { LAND_CELL_SIZE } from '../../config';
import {
  getSurfaceHeight,
  getSurfaceNormal,
  getTerrainBedHeight,
  getTerrainBedNormal,
  getTerrainVersion,
  isWaterAt,
} from './Terrain';
import type { Entity } from './types';
import {
  createWorldSupportSurface,
  writeTerrainSupportSurface,
  type WorldSupportSurface,
} from './supportSurface';
import {
  SupportSurfaceIndex,
  type SupportSurfaceIndexQueryOptions,
} from './supportSurfaceIndex';

const TERRAIN_NORMAL_CACHE_CELL_SIZE = 25;

export type SurfaceNormal = { nx: number; ny: number; nz: number };
export type SupportSurfaceQueryOptions = SupportSurfaceIndexQueryOptions;

export class WorldSupportSurfaceSampler {
  private surfaceNormalCache = new Map<number, SurfaceNormal>();
  private terrainBedNormalCache = new Map<number, SurfaceNormal>();
  private supportSurfaceIndex = new SupportSurfaceIndex();

  constructor(
    private readonly mapWidth: number,
    private readonly mapHeight: number,
  ) {}

  getGroundZ(x: number, y: number): number {
    return getSurfaceHeight(x, y, this.mapWidth, this.mapHeight, LAND_CELL_SIZE);
  }

  getTerrainBedZ(x: number, y: number): number {
    return getTerrainBedHeight(x, y, this.mapWidth, this.mapHeight, LAND_CELL_SIZE);
  }

  writeTerrainSupportSurfaceAt(
    x: number,
    y: number,
    terrainGroundZ: number,
    normal: SurfaceNormal,
    out: WorldSupportSurface = createWorldSupportSurface(),
  ): WorldSupportSurface {
    return writeTerrainSupportSurface(
      out,
      terrainGroundZ,
      normal,
      isWaterAt(x, y, this.mapWidth, this.mapHeight),
      getTerrainVersion(),
    );
  }

  refreshSupportSurfaceIndex(entities: readonly Entity[]): void {
    this.supportSurfaceIndex.rebuild(entities);
  }

  sampleSupportSurface(
    x: number,
    y: number,
    entities: readonly Entity[],
    options: SupportSurfaceQueryOptions = {},
    out: WorldSupportSurface = createWorldSupportSurface(),
  ): WorldSupportSurface {
    this.refreshSupportSurfaceIndex(entities);
    return this.sampleSupportSurfaceFromIndex(x, y, options, out);
  }

  sampleSupportSurfaceFromIndex(
    x: number,
    y: number,
    options: SupportSurfaceQueryOptions = {},
    out: WorldSupportSurface = createWorldSupportSurface(),
  ): WorldSupportSurface {
    const terrainGroundZ = this.getGroundZ(x, y);
    this.writeTerrainSupportSurfaceAt(
      x,
      y,
      terrainGroundZ,
      this.getCachedSurfaceNormal(x, y),
      out,
    );

    this.supportSurfaceIndex.sampleSupportSurface(x, y, terrainGroundZ, options, out);

    return out;
  }

  getCachedSurfaceNormal(x: number, y: number): SurfaceNormal {
    const key = this.surfaceNormalCacheKey(x, y);
    let normal = this.surfaceNormalCache.get(key);
    if (!normal) {
      normal = getSurfaceNormal(
        x, y,
        this.mapWidth, this.mapHeight,
        LAND_CELL_SIZE,
      );
      this.surfaceNormalCache.set(key, normal);
    }
    return normal;
  }

  getCachedTerrainBedNormal(x: number, y: number): SurfaceNormal {
    const key = this.surfaceNormalCacheKey(x, y);
    let normal = this.terrainBedNormalCache.get(key);
    if (!normal) {
      normal = getTerrainBedNormal(
        x, y,
        this.mapWidth, this.mapHeight,
        LAND_CELL_SIZE,
      );
      this.terrainBedNormalCache.set(key, normal);
    }
    return normal;
  }

  private surfaceNormalCacheKey(x: number, y: number): number {
    const cx = Math.floor(x / TERRAIN_NORMAL_CACHE_CELL_SIZE) + 32768;
    const cy = Math.floor(y / TERRAIN_NORMAL_CACHE_CELL_SIZE) + 32768;
    return cx * 0x10000 + cy;
  }
}
