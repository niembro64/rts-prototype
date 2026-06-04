import type { FootprintBounds } from '../ViewportFootprint';
import type { Entity, EntityId } from '../sim/types';

const CLIENT_PROJECTILE_RENDER_CELL_SIZE = 512;

type ClientProjectileRenderSpatialEntry = {
  entity: Entity;
  minCellX: number;
  maxCellX: number;
  minCellY: number;
  maxCellY: number;
  cellKeys: string[];
  bucketIndices: number[];
};

export type ClientProjectileRenderPredicate = (entity: Entity) => boolean;

export class ClientProjectileRenderSpatialIndex {
  private readonly buckets = new Map<string, Entity[]>();
  private readonly entries = new Map<EntityId, ClientProjectileRenderSpatialEntry>();
  private readonly querySeenIds = new Set<EntityId>();

  clear(): void {
    this.buckets.clear();
    this.entries.clear();
    this.querySeenIds.clear();
  }

  update(entity: Entity): void {
    if (entity.projectile === null) {
      this.remove(entity.id);
      return;
    }

    const bounds = this.boundsForProjectile(entity);
    const minCellX = this.cellCoord(bounds.minX);
    const maxCellX = this.cellCoord(bounds.maxX);
    const minCellY = this.cellCoord(bounds.minY);
    const maxCellY = this.cellCoord(bounds.maxY);
    const existing = this.entries.get(entity.id);
    if (
      existing !== undefined &&
      existing.minCellX === minCellX &&
      existing.maxCellX === maxCellX &&
      existing.minCellY === minCellY &&
      existing.maxCellY === maxCellY
    ) {
      existing.entity = entity;
      for (let i = 0; i < existing.cellKeys.length; i++) {
        const bucket = this.buckets.get(existing.cellKeys[i]);
        if (bucket !== undefined) bucket[existing.bucketIndices[i]] = entity;
      }
      return;
    }

    if (existing !== undefined) this.remove(entity.id);

    const cellKeys: string[] = [];
    const bucketIndices: number[] = [];
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
        const key = this.cellKey(cellX, cellY);
        const bucket = this.getOrCreateBucket(key);
        cellKeys.push(key);
        bucketIndices.push(bucket.length);
        bucket.push(entity);
      }
    }

    this.entries.set(entity.id, {
      entity,
      minCellX,
      maxCellX,
      minCellY,
      maxCellY,
      cellKeys,
      bucketIndices,
    });
  }

  remove(id: EntityId): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;

    for (let i = 0; i < entry.cellKeys.length; i++) {
      const key = entry.cellKeys[i];
      const bucket = this.buckets.get(key);
      if (bucket === undefined) continue;
      const bucketIndex = entry.bucketIndices[i];
      const last = bucket.pop();
      if (last !== undefined && bucketIndex < bucket.length) {
        bucket[bucketIndex] = last;
        this.repointBucketIndex(last.id, key, bucketIndex);
      }
      if (bucket.length === 0) this.buckets.delete(key);
    }
    this.entries.delete(id);
  }

  query(
    bounds: FootprintBounds,
    out: Entity[],
    predicate: ClientProjectileRenderPredicate,
  ): Entity[] {
    out.length = 0;
    const seen = this.querySeenIds;
    seen.clear();

    const minCellX = this.cellCoord(bounds.minX);
    const maxCellX = this.cellCoord(bounds.maxX);
    const minCellY = this.cellCoord(bounds.minY);
    const maxCellY = this.cellCoord(bounds.maxY);
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
        const bucket = this.buckets.get(this.cellKey(cellX, cellY));
        if (bucket === undefined) continue;
        for (let i = 0; i < bucket.length; i++) {
          const entity = bucket[i];
          if (seen.has(entity.id)) continue;
          seen.add(entity.id);
          if (predicate(entity)) out.push(entity);
        }
      }
    }
    return out;
  }

  private repointBucketIndex(id: EntityId, cellKey: string, nextIndex: number): void {
    const movedEntry = this.entries.get(id);
    if (movedEntry === undefined) return;
    for (let i = 0; i < movedEntry.cellKeys.length; i++) {
      if (movedEntry.cellKeys[i] === cellKey) {
        movedEntry.bucketIndices[i] = nextIndex;
        return;
      }
    }
  }

  private boundsForProjectile(entity: Entity): FootprintBounds {
    const projectile = entity.projectile;
    if (projectile?.points && projectile.points.length > 0) {
      let minX = entity.transform.x;
      let maxX = entity.transform.x;
      let minY = entity.transform.y;
      let maxY = entity.transform.y;
      for (const point of projectile.points) {
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.y > maxY) maxY = point.y;
      }
      return { minX, maxX, minY, maxY };
    }

    return {
      minX: entity.transform.x,
      maxX: entity.transform.x,
      minY: entity.transform.y,
      maxY: entity.transform.y,
    };
  }

  private getOrCreateBucket(cellKey: string): Entity[] {
    let bucket = this.buckets.get(cellKey);
    if (bucket === undefined) {
      bucket = [];
      this.buckets.set(cellKey, bucket);
    }
    return bucket;
  }

  private cellCoord(value: number): number {
    return Math.floor(value / CLIENT_PROJECTILE_RENDER_CELL_SIZE);
  }

  private cellKey(cellX: number, cellY: number): string {
    return `${cellX},${cellY}`;
  }
}
