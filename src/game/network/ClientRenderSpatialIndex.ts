import type { FootprintBounds } from '../ViewportFootprint';
import { getEntityRenderScopePadding } from '../entityRenderScope';
import type { Entity, EntityId } from '../sim/types';

const CLIENT_RENDER_CELL_SIZE = 512;

type ClientRenderSpatialEntry = {
  entity: Entity;
  cellKey: string;
  bucketIndex: number;
};

export class ClientRenderSpatialIndex {
  private readonly buckets = new Map<string, Entity[]>();
  private readonly entries = new Map<EntityId, ClientRenderSpatialEntry>();
  private maxEntityPadding = 350;

  clear(): void {
    this.buckets.clear();
    this.entries.clear();
    this.maxEntityPadding = 350;
  }

  getMaxEntityPadding(): number {
    return this.maxEntityPadding;
  }

  update(entity: Entity): void {
    if (entity.unit === null && entity.building === null) {
      this.remove(entity.id);
      return;
    }

    const cellKey = this.cellKeyFor(entity.transform.x, entity.transform.y);
    const existing = this.entries.get(entity.id);
    this.maxEntityPadding = Math.max(this.maxEntityPadding, getEntityRenderScopePadding(entity));

    if (existing !== undefined && existing.cellKey === cellKey) {
      existing.entity = entity;
      const bucket = this.buckets.get(cellKey);
      if (bucket !== undefined) bucket[existing.bucketIndex] = entity;
      return;
    }

    if (existing !== undefined) this.remove(entity.id);
    const bucket = this.getOrCreateBucket(cellKey);
    const entry: ClientRenderSpatialEntry = {
      entity,
      cellKey,
      bucketIndex: bucket.length,
    };
    bucket.push(entity);
    this.entries.set(entity.id, entry);
  }

  remove(id: EntityId): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    const bucket = this.buckets.get(entry.cellKey);
    if (bucket !== undefined) {
      const last = bucket.pop();
      if (last !== undefined && entry.bucketIndex < bucket.length) {
        bucket[entry.bucketIndex] = last;
        const moved = this.entries.get(last.id);
        if (moved !== undefined) moved.bucketIndex = entry.bucketIndex;
      }
      if (bucket.length === 0) this.buckets.delete(entry.cellKey);
    }
    this.entries.delete(id);
  }

  queryUnitsAndBuildings(
    bounds: FootprintBounds,
    outUnits: Entity[],
    outBuildings: Entity[],
  ): void {
    outUnits.length = 0;
    outBuildings.length = 0;

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
          if (entity.unit !== null) outUnits.push(entity);
          else if (entity.building !== null) outBuildings.push(entity);
        }
      }
    }
  }

  private getOrCreateBucket(cellKey: string): Entity[] {
    let bucket = this.buckets.get(cellKey);
    if (bucket === undefined) {
      bucket = [];
      this.buckets.set(cellKey, bucket);
    }
    return bucket;
  }

  private cellKeyFor(x: number, y: number): string {
    return this.cellKey(this.cellCoord(x), this.cellCoord(y));
  }

  private cellCoord(value: number): number {
    return Math.floor(value / CLIENT_RENDER_CELL_SIZE);
  }

  private cellKey(cellX: number, cellY: number): string {
    return `${cellX},${cellY}`;
  }
}
