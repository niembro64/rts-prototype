import type { FootprintBounds } from '../ViewportFootprint';
import { getEntityRenderScopePadding } from '../entityRenderScope';
import type { Entity, EntityId } from '../sim/types';

const CLIENT_RENDER_CELL_SIZE = 512;
const CLIENT_RENDER_CELL_KEY_OFFSET = 1 << 20;
const CLIENT_RENDER_CELL_KEY_STRIDE = CLIENT_RENDER_CELL_KEY_OFFSET * 2 + 1;
const DEFAULT_MAX_ENTITY_PADDING = 350;

type ClientRenderCellKey = number;

type ClientRenderSpatialEntry = {
  entity: Entity;
  cellKey: ClientRenderCellKey;
  bucketIndex: number;
  padding: number;
};

export class ClientRenderSpatialIndex {
  private readonly buckets = new Map<ClientRenderCellKey, Entity[]>();
  private readonly entries = new Map<EntityId, ClientRenderSpatialEntry>();
  private maxEntityPadding = DEFAULT_MAX_ENTITY_PADDING;

  clear(): void {
    this.buckets.clear();
    this.entries.clear();
    this.maxEntityPadding = DEFAULT_MAX_ENTITY_PADDING;
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
    const padding = getEntityRenderScopePadding(entity);

    if (existing !== undefined && existing.cellKey === cellKey) {
      existing.entity = entity;
      this.updateEntryPadding(existing, padding);
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
      padding,
    };
    bucket.push(entity);
    this.entries.set(entity.id, entry);
    if (padding > this.maxEntityPadding) this.maxEntityPadding = padding;
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
    if (entry.padding >= this.maxEntityPadding) this.recomputeMaxEntityPadding();
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

  private getOrCreateBucket(cellKey: ClientRenderCellKey): Entity[] {
    let bucket = this.buckets.get(cellKey);
    if (bucket === undefined) {
      bucket = [];
      this.buckets.set(cellKey, bucket);
    }
    return bucket;
  }

  private updateEntryPadding(entry: ClientRenderSpatialEntry, padding: number): void {
    const previous = entry.padding;
    entry.padding = padding;
    if (padding >= this.maxEntityPadding) {
      this.maxEntityPadding = padding;
    } else if (previous >= this.maxEntityPadding) {
      this.recomputeMaxEntityPadding();
    }
  }

  private recomputeMaxEntityPadding(): void {
    let next = DEFAULT_MAX_ENTITY_PADDING;
    for (const entry of this.entries.values()) {
      if (entry.padding > next) next = entry.padding;
    }
    this.maxEntityPadding = next;
  }

  private cellKeyFor(x: number, y: number): ClientRenderCellKey {
    return this.cellKey(this.cellCoord(x), this.cellCoord(y));
  }

  private cellCoord(value: number): number {
    return Math.floor(value / CLIENT_RENDER_CELL_SIZE);
  }

  private cellKey(cellX: number, cellY: number): ClientRenderCellKey {
    return (
      (cellX + CLIENT_RENDER_CELL_KEY_OFFSET) *
      CLIENT_RENDER_CELL_KEY_STRIDE
    ) + cellY + CLIENT_RENDER_CELL_KEY_OFFSET;
  }
}
