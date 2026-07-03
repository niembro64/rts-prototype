import type { Entity, EntityId } from './types';
import {
  SUPPORT_SURFACE_CONTACT_EPSILON,
  SUPPORT_SURFACE_FOOTPRINT_EPSILON,
  writeBuildingSupportSurface,
  writeUnitSupportSurfaceVelocity,
  type WorldSupportSurface,
} from './supportSurface';

export type SupportSurfaceIndexQueryOptions = {
  bodyZ?: number;
  groundOffset?: number;
  includeBuildings?: boolean;
  includeUnits?: boolean;
  ignoreEntityId?: EntityId | null;
};

type SupportSurfaceProxyKind = 'building' | 'unit';

type SupportSurfaceProxy = {
  kind: SupportSurfaceProxyKind;
  entity: Entity | null;
  entityId: EntityId;
  supportTopOffsetZ: number;
  supportHalfX: number;
  supportHalfY: number;
  supportRadius: number;
  minCellX: number;
  maxCellX: number;
  minCellY: number;
  maxCellY: number;
  bucketKeys: number[];
  seenGeneration: number;
};

const DEFAULT_SUPPORT_SURFACE_INDEX_CELL_SIZE = 192;
const SUPPORT_SURFACE_INDEX_COORD_OFFSET = 32768;

export class SupportSurfaceIndex {
  private readonly cellSize: number;
  private readonly buckets = new Map<number, SupportSurfaceProxy[]>();
  private readonly proxies = new Map<EntityId, SupportSurfaceProxy>();
  private readonly proxyPool: SupportSurfaceProxy[] = [];
  private readonly staleProxyIds: EntityId[] = [];
  private updateGeneration = 0;
  private bestTopZ = Number.NEGATIVE_INFINITY;

  constructor(cellSize: number = DEFAULT_SUPPORT_SURFACE_INDEX_CELL_SIZE) {
    this.cellSize = cellSize;
  }

  clear(): void {
    for (const bucket of this.buckets.values()) bucket.length = 0;
    this.buckets.clear();
    for (const proxy of this.proxies.values()) {
      this.releaseProxy(proxy);
    }
    this.proxies.clear();
    this.staleProxyIds.length = 0;
    this.bestTopZ = Number.NEGATIVE_INFINITY;
  }

  rebuild(supportEntities: Iterable<Entity>): void {
    this.updateGeneration = (this.updateGeneration + 1) & 0x3fffffff;
    if (this.updateGeneration === 0) this.updateGeneration = 1;
    const generation = this.updateGeneration;

    if (Array.isArray(supportEntities)) {
      for (let i = 0; i < supportEntities.length; i++) {
        this.addOrUpdateEntity(supportEntities[i], generation);
      }
    } else {
      for (const entity of supportEntities) {
        this.addOrUpdateEntity(entity, generation);
      }
    }

    this.staleProxyIds.length = 0;
    for (const [id, proxy] of this.proxies) {
      if (proxy.seenGeneration !== generation) this.staleProxyIds.push(id);
    }
    for (let i = 0; i < this.staleProxyIds.length; i++) {
      this.removeProxyById(this.staleProxyIds[i]);
    }
    this.staleProxyIds.length = 0;
  }

  addEntity(entity: Entity): void {
    this.addOrUpdateEntity(entity, this.updateGeneration);
  }

  sampleSupportTopZ(
    x: number,
    y: number,
    terrainGroundZ: number,
    options: SupportSurfaceIndexQueryOptions = {},
  ): number | null {
    const best = this.findBestProxy(x, y, terrainGroundZ, options);
    return best !== null ? this.bestTopZ : null;
  }

  sampleSupportSurface(
    x: number,
    y: number,
    terrainGroundZ: number,
    options: SupportSurfaceIndexQueryOptions,
    out: WorldSupportSurface,
  ): WorldSupportSurface {
    const best = this.findBestProxy(x, y, terrainGroundZ, options);
    if (best === null || this.bestTopZ <= out.groundZ) return out;

    if (best.kind === 'building') {
      return writeBuildingSupportSurface(out, this.bestTopZ, best.entityId, best.entityId);
    }

    const unit = best.entity?.unit ?? null;
    return writeUnitSupportSurfaceVelocity(
      out,
      this.bestTopZ,
      best.entityId,
      best.entityId,
      unit?.velocityX ?? 0,
      unit?.velocityY ?? 0,
      unit?.velocityZ ?? 0,
    );
  }

  private addOrUpdateEntity(entity: Entity, generation: number): void {
    const building = entity.building;
    let kind: SupportSurfaceProxyKind;
    let supportTopOffsetZ: number;
    let supportHalfX = 0;
    let supportHalfY = 0;
    let supportRadius = 0;

    if (building !== null) {
      const support = building.supportSurface;
      if (support.kind !== 'boxTop') {
        this.removeProxyById(entity.id);
        return;
      }
      kind = 'building';
      supportTopOffsetZ = support.topZ;
      supportHalfX = support.width / 2;
      supportHalfY = support.height / 2;
    } else {
      const unit = entity.unit;
      if (unit === null || unit.hp <= 0 || unit.supportSurface.kind !== 'discTop') {
        this.removeProxyById(entity.id);
        return;
      }
      kind = 'unit';
      supportTopOffsetZ = unit.supportSurface.topZ;
      supportRadius = unit.supportSurface.radius;
    }

    const tx = entity.transform.x;
    const ty = entity.transform.y;
    const padX = kind === 'building'
      ? supportHalfX + SUPPORT_SURFACE_FOOTPRINT_EPSILON
      : supportRadius + SUPPORT_SURFACE_FOOTPRINT_EPSILON;
    const padY = kind === 'building'
      ? supportHalfY + SUPPORT_SURFACE_FOOTPRINT_EPSILON
      : supportRadius + SUPPORT_SURFACE_FOOTPRINT_EPSILON;
    const minCellX = this.cellCoord(tx - padX);
    const maxCellX = this.cellCoord(tx + padX);
    const minCellY = this.cellCoord(ty - padY);
    const maxCellY = this.cellCoord(ty + padY);

    let proxy = this.proxies.get(entity.id);
    if (proxy === undefined) {
      proxy = this.acquireProxy();
      proxy.entityId = entity.id;
      this.proxies.set(entity.id, proxy);
    }

    const bucketBoundsChanged =
      proxy.bucketKeys.length === 0 ||
      proxy.minCellX !== minCellX ||
      proxy.maxCellX !== maxCellX ||
      proxy.minCellY !== minCellY ||
      proxy.maxCellY !== maxCellY;
    if (bucketBoundsChanged) this.unlinkProxy(proxy);

    proxy.kind = kind;
    proxy.entity = entity;
    proxy.entityId = entity.id;
    proxy.supportTopOffsetZ = supportTopOffsetZ;
    proxy.supportHalfX = supportHalfX;
    proxy.supportHalfY = supportHalfY;
    proxy.supportRadius = supportRadius;
    proxy.minCellX = minCellX;
    proxy.maxCellX = maxCellX;
    proxy.minCellY = minCellY;
    proxy.maxCellY = maxCellY;
    proxy.seenGeneration = generation;

    if (bucketBoundsChanged) this.linkProxy(proxy);
  }

  private acquireProxy(): SupportSurfaceProxy {
    const proxy = this.proxyPool.pop();
    if (proxy !== undefined) return proxy;
    return {
      kind: 'unit',
      entity: null,
      entityId: -1 as EntityId,
      supportTopOffsetZ: 0,
      supportHalfX: 0,
      supportHalfY: 0,
      supportRadius: 0,
      minCellX: 0,
      maxCellX: 0,
      minCellY: 0,
      maxCellY: 0,
      bucketKeys: [],
      seenGeneration: 0,
    };
  }

  private releaseProxy(proxy: SupportSurfaceProxy): void {
    proxy.entity = null;
    proxy.entityId = -1 as EntityId;
    proxy.bucketKeys.length = 0;
    proxy.seenGeneration = 0;
    this.proxyPool.push(proxy);
  }

  private removeProxyById(id: EntityId): void {
    const proxy = this.proxies.get(id);
    if (proxy === undefined) return;
    this.unlinkProxy(proxy);
    this.proxies.delete(id);
    this.releaseProxy(proxy);
  }

  private linkProxy(proxy: SupportSurfaceProxy): void {
    for (let cy = proxy.minCellY; cy <= proxy.maxCellY; cy++) {
      for (let cx = proxy.minCellX; cx <= proxy.maxCellX; cx++) {
        const key = this.cellKey(cx, cy);
        let bucket = this.buckets.get(key);
        if (bucket === undefined) {
          bucket = [];
          this.buckets.set(key, bucket);
        }
        bucket.push(proxy);
        proxy.bucketKeys.push(key);
      }
    }
  }

  private unlinkProxy(proxy: SupportSurfaceProxy): void {
    const keys = proxy.bucketKeys;
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      const bucket = this.buckets.get(keys[keyIndex]);
      if (bucket === undefined) continue;
      for (let i = 0; i < bucket.length; i++) {
        if (bucket[i] !== proxy) continue;
        const last = bucket.pop();
        if (last !== undefined && i < bucket.length) bucket[i] = last;
        break;
      }
    }
    keys.length = 0;
  }

  private findBestProxy(
    x: number,
    y: number,
    terrainGroundZ: number,
    options: SupportSurfaceIndexQueryOptions,
  ): SupportSurfaceProxy | null {
    const bucket = this.buckets.get(this.cellKey(this.cellCoord(x), this.cellCoord(y)));
    if (bucket === undefined || bucket.length === 0) {
      this.bestTopZ = Number.NEGATIVE_INFINITY;
      return null;
    }

    let bestProxy: SupportSurfaceProxy | null = null;
    let bestTopZ = Number.NEGATIVE_INFINITY;
    const includeBuildings = options.includeBuildings !== false;
    const includeUnits = options.includeUnits !== false;
    const ignoreEntityId = options.ignoreEntityId;
    const bodyZ = options.bodyZ;
    const requireBodyHeight = bodyZ !== undefined && Number.isFinite(bodyZ);
    const contactEpsilon = SUPPORT_SURFACE_CONTACT_EPSILON;
    const footprintEpsilon = SUPPORT_SURFACE_FOOTPRINT_EPSILON;
    for (let i = 0; i < bucket.length; i++) {
      const proxy = bucket[i];
      const entity = proxy.entity;
      if (entity === null) continue;
      if (proxy.kind === 'building') {
        if (!includeBuildings) continue;
      } else {
        if (!includeUnits) continue;
        if (ignoreEntityId !== undefined && ignoreEntityId === proxy.entityId) {
          continue;
        }
        if (entity.unit === null || entity.unit.hp <= 0) continue;
      }

      let topZ: number;
      const dx = x - entity.transform.x;
      const dy = y - entity.transform.y;
      if (proxy.kind === 'building') {
        const building = entity.building;
        if (building === null) continue;
        if (Math.abs(dx) > proxy.supportHalfX + footprintEpsilon) continue;
        if (Math.abs(dy) > proxy.supportHalfY + footprintEpsilon) continue;
        topZ = entity.transform.z - building.depth / 2 + proxy.supportTopOffsetZ;
      } else {
        const unit = entity.unit;
        if (unit === null || unit.hp <= 0) continue;
        const radius = proxy.supportRadius + footprintEpsilon;
        if (dx * dx + dy * dy > radius * radius) continue;
        topZ = entity.transform.z - unit.bodyCenterHeight + proxy.supportTopOffsetZ;
      }
      if (topZ <= bestTopZ) continue;
      if (topZ < terrainGroundZ - contactEpsilon) continue;
      if (requireBodyHeight && bodyZ! < topZ - contactEpsilon) continue;

      bestProxy = proxy;
      bestTopZ = topZ;
    }

    this.bestTopZ = bestTopZ;
    return bestProxy;
  }

  private cellCoord(value: number): number {
    return Math.floor(value / this.cellSize);
  }

  private cellKey(cx: number, cy: number): number {
    return (cx + SUPPORT_SURFACE_INDEX_COORD_OFFSET) * 0x10000
      + (cy + SUPPORT_SURFACE_INDEX_COORD_OFFSET);
  }
}
