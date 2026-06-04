import type { Entity, EntityId } from './types';
import {
  SUPPORT_SURFACE_CONTACT_EPSILON,
  SUPPORT_SURFACE_FOOTPRINT_EPSILON,
  SUPPORT_SURFACE_VERTICAL_PROBE,
  writeBuildingSupportSurface,
  writeUnitSupportSurface,
  type WorldSupportSurface,
} from './supportSurface';

export type SupportSurfaceIndexQueryOptions = {
  bodyZ?: number;
  groundOffset?: number;
  includeBuildings?: boolean;
  includeUnits?: boolean;
  ignoreEntityId?: EntityId | null;
};

type BuildingSupportProxy = {
  kind: 'building';
  entity: Entity;
  entityId: EntityId;
  supportTopOffsetZ: number;
  supportHalfX: number;
  supportHalfY: number;
};

type UnitSupportProxy = {
  kind: 'unit';
  entity: Entity;
  entityId: EntityId;
  supportTopOffsetZ: number;
  supportRadius: number;
};

type SupportSurfaceProxy = BuildingSupportProxy | UnitSupportProxy;

const DEFAULT_SUPPORT_SURFACE_INDEX_CELL_SIZE = 192;
const SUPPORT_SURFACE_INDEX_COORD_OFFSET = 32768;

export class SupportSurfaceIndex {
  private readonly cellSize: number;
  private buckets = new Map<number, SupportSurfaceProxy[]>();

  constructor(cellSize: number = DEFAULT_SUPPORT_SURFACE_INDEX_CELL_SIZE) {
    this.cellSize = cellSize;
  }

  clear(): void {
    this.buckets.clear();
  }

  rebuild(supportEntities: Iterable<Entity>): void {
    this.clear();
    for (const entity of supportEntities) {
      this.addEntity(entity);
    }
  }

  addEntity(entity: Entity): void {
    const building = entity.building;
    if (building !== null) {
      const support = building.supportSurface;
      if (support.kind === 'boxTop') {
        this.addProxy({
          kind: 'building',
          entity,
          entityId: entity.id,
          supportTopOffsetZ: support.topZ,
          supportHalfX: support.width / 2,
          supportHalfY: support.height / 2,
        });
      }
      return;
    }

    const unit = entity.unit;
    if (unit === null || unit.hp <= 0) return;
    const support = unit.supportSurface;
    if (support.kind !== 'discTop') return;
    this.addProxy({
      kind: 'unit',
      entity,
      entityId: entity.id,
      supportTopOffsetZ: support.topZ,
      supportRadius: support.radius,
    });
  }

  sampleSupportTopZ(
    x: number,
    y: number,
    terrainGroundZ: number,
    options: SupportSurfaceIndexQueryOptions = {},
  ): number | null {
    const best = this.findBestProxy(x, y, terrainGroundZ, options);
    return best !== null ? best.topZ : null;
  }

  sampleSupportSurface(
    x: number,
    y: number,
    terrainGroundZ: number,
    options: SupportSurfaceIndexQueryOptions,
    out: WorldSupportSurface,
  ): WorldSupportSurface {
    const best = this.findBestProxy(x, y, terrainGroundZ, options);
    if (best === null || best.topZ <= out.groundZ) return out;

    if (best.proxy.kind === 'building') {
      return writeBuildingSupportSurface(out, best.topZ, best.proxy.entityId, best.proxy.entityId);
    }

    const unit = best.proxy.entity.unit;
    return writeUnitSupportSurface(
      out,
      best.topZ,
      best.proxy.entityId,
      best.proxy.entityId,
      unit !== null
        ? { x: unit.velocityX, y: unit.velocityY, z: unit.velocityZ }
        : undefined,
    );
  }

  private addProxy(proxy: SupportSurfaceProxy): void {
    const bounds = this.getProxyBounds(proxy);
    const minCellX = this.cellCoord(bounds.minX);
    const maxCellX = this.cellCoord(bounds.maxX);
    const minCellY = this.cellCoord(bounds.minY);
    const maxCellY = this.cellCoord(bounds.maxY);

    for (let cy = minCellY; cy <= maxCellY; cy++) {
      for (let cx = minCellX; cx <= maxCellX; cx++) {
        const key = this.cellKey(cx, cy);
        let bucket = this.buckets.get(key);
        if (bucket === undefined) {
          bucket = [];
          this.buckets.set(key, bucket);
        }
        bucket.push(proxy);
      }
    }
  }

  private findBestProxy(
    x: number,
    y: number,
    terrainGroundZ: number,
    options: SupportSurfaceIndexQueryOptions,
  ): { proxy: SupportSurfaceProxy; topZ: number } | null {
    const bucket = this.buckets.get(this.cellKey(this.cellCoord(x), this.cellCoord(y)));
    if (bucket === undefined) return null;

    let bestProxy: SupportSurfaceProxy | null = null;
    let bestTopZ = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < bucket.length; i++) {
      const proxy = bucket[i];
      if (proxy.kind === 'building') {
        if (options.includeBuildings === false) continue;
      } else {
        if (options.includeUnits === false) continue;
        if (options.ignoreEntityId !== undefined && options.ignoreEntityId === proxy.entityId) {
          continue;
        }
        if (proxy.entity.unit === null || proxy.entity.unit.hp <= 0) continue;
      }

      const topZ = this.getProxyTopZ(proxy);
      if (topZ === null) continue;
      if (topZ <= bestTopZ) continue;
      if (topZ < terrainGroundZ - SUPPORT_SURFACE_CONTACT_EPSILON) continue;
      if (!this.containsPoint(proxy, x, y)) continue;
      if (!this.acceptsBodyHeight(topZ, options)) continue;

      bestProxy = proxy;
      bestTopZ = topZ;
    }

    return bestProxy !== null ? { proxy: bestProxy, topZ: bestTopZ } : null;
  }

  private getProxyBounds(proxy: SupportSurfaceProxy): {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  } {
    const tx = proxy.entity.transform.x;
    const ty = proxy.entity.transform.y;
    if (proxy.kind === 'building') {
      const halfX = proxy.supportHalfX + SUPPORT_SURFACE_FOOTPRINT_EPSILON;
      const halfY = proxy.supportHalfY + SUPPORT_SURFACE_FOOTPRINT_EPSILON;
      return {
        minX: tx - halfX,
        maxX: tx + halfX,
        minY: ty - halfY,
        maxY: ty + halfY,
      };
    }

    const radius = proxy.supportRadius + SUPPORT_SURFACE_FOOTPRINT_EPSILON;
    return {
      minX: tx - radius,
      maxX: tx + radius,
      minY: ty - radius,
      maxY: ty + radius,
    };
  }

  private getProxyTopZ(proxy: SupportSurfaceProxy): number | null {
    if (proxy.kind === 'building') {
      const building = proxy.entity.building;
      if (building === null) return null;
      return proxy.entity.transform.z - building.depth / 2 + proxy.supportTopOffsetZ;
    }

    const unit = proxy.entity.unit;
    if (unit === null || unit.hp <= 0) return null;
    return proxy.entity.transform.z - unit.bodyCenterHeight + proxy.supportTopOffsetZ;
  }

  private containsPoint(proxy: SupportSurfaceProxy, x: number, y: number): boolean {
    const dx = x - proxy.entity.transform.x;
    const dy = y - proxy.entity.transform.y;
    if (proxy.kind === 'building') {
      if (Math.abs(dx) > proxy.supportHalfX + SUPPORT_SURFACE_FOOTPRINT_EPSILON) {
        return false;
      }
      return Math.abs(dy) <= proxy.supportHalfY + SUPPORT_SURFACE_FOOTPRINT_EPSILON;
    }

    const radius = proxy.supportRadius + SUPPORT_SURFACE_FOOTPRINT_EPSILON;
    return dx * dx + dy * dy <= radius * radius;
  }

  private acceptsBodyHeight(
    topZ: number,
    options: SupportSurfaceIndexQueryOptions,
  ): boolean {
    const bodyZ = options.bodyZ;
    if (bodyZ === undefined || !Number.isFinite(bodyZ)) return true;

    const groundOffset = options.groundOffset !== undefined && Number.isFinite(options.groundOffset)
      ? options.groundOffset
      : 0;
    const groundPointZ = bodyZ - groundOffset;
    if (bodyZ < topZ - SUPPORT_SURFACE_CONTACT_EPSILON) return false;
    if (groundPointZ < topZ - SUPPORT_SURFACE_CONTACT_EPSILON) return false;
    return groundPointZ <= topZ + SUPPORT_SURFACE_VERTICAL_PROBE;
  }

  private cellCoord(value: number): number {
    return Math.floor(value / this.cellSize);
  }

  private cellKey(cx: number, cy: number): number {
    return (cx + SUPPORT_SURFACE_INDEX_COORD_OFFSET) * 0x10000
      + (cy + SUPPORT_SURFACE_INDEX_COORD_OFFSET);
  }
}
