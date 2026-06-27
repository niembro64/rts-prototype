import type { FootprintBounds } from '../ViewportFootprint';
import type { Entity, EntityId } from '../sim/types';

const CLIENT_PROJECTILE_RENDER_CELL_SIZE = 512;
const CLIENT_PROJECTILE_RENDER_CELL_KEY_OFFSET = 1 << 20;
const CLIENT_PROJECTILE_RENDER_CELL_KEY_STRIDE = CLIENT_PROJECTILE_RENDER_CELL_KEY_OFFSET * 2 + 1;
const CLIENT_PROJECTILE_RENDER_MAX_BUCKET_CELLS_PER_ENTRY = 256;

type ClientProjectileRenderCellKey = number | string;

type ClientProjectileRenderSpatialEntry = {
  entity: Entity;
  minCellX: number;
  maxCellX: number;
  minCellY: number;
  maxCellY: number;
  cellKeys: ClientProjectileRenderCellKey[];
  bucketIndices: number[];
};

type ClientProjectileRenderBucket = {
  entries: ClientProjectileRenderSpatialEntry[];
  entryCellIndices: number[];
};

export type ClientProjectileRenderLists = {
  traveling: Entity[];
  smokeTrail: Entity[];
  line: Entity[];
  burnMark: Entity[];
};

export class ClientProjectileRenderSpatialIndex {
  private readonly buckets = new Map<ClientProjectileRenderCellKey, ClientProjectileRenderBucket>();
  private readonly entries = new Map<EntityId, ClientProjectileRenderSpatialEntry>();
  private readonly unbucketedEntries = new Set<ClientProjectileRenderSpatialEntry>();
  private readonly querySeenIds = new Set<EntityId>();
  private boundsMinX = 0;
  private boundsMaxX = 0;
  private boundsMinY = 0;
  private boundsMaxY = 0;

  clear(): void {
    this.buckets.clear();
    this.entries.clear();
    this.unbucketedEntries.clear();
    this.querySeenIds.clear();
  }

  update(entity: Entity): void {
    if (entity.projectile === null) {
      this.remove(entity.id);
      return;
    }

    this.updateBoundsForProjectile(entity);
    const minCellX = this.cellCoord(this.boundsMinX);
    const maxCellX = this.cellCoord(this.boundsMaxX);
    const minCellY = this.cellCoord(this.boundsMinY);
    const maxCellY = this.cellCoord(this.boundsMaxY);
    if (
      !Number.isFinite(minCellX) ||
      !Number.isFinite(maxCellX) ||
      !Number.isFinite(minCellY) ||
      !Number.isFinite(maxCellY)
    ) {
      this.remove(entity.id);
      return;
    }
    const existing = this.entries.get(entity.id);
    if (
      existing !== undefined &&
      existing.minCellX === minCellX &&
      existing.maxCellX === maxCellX &&
      existing.minCellY === minCellY &&
      existing.maxCellY === maxCellY
    ) {
      existing.entity = entity;
      return;
    }

    let entry = existing;
    if (entry !== undefined) {
      this.removeEntryFromBuckets(entry);
      this.unbucketedEntries.delete(entry);
      entry.entity = entity;
      entry.minCellX = minCellX;
      entry.maxCellX = maxCellX;
      entry.minCellY = minCellY;
      entry.maxCellY = maxCellY;
      entry.cellKeys.length = 0;
      entry.bucketIndices.length = 0;
    } else {
      entry = {
        entity,
        minCellX,
        maxCellX,
        minCellY,
        maxCellY,
        cellKeys: [],
        bucketIndices: [],
      };
      this.entries.set(entity.id, entry);
    }

    if (this.shouldStoreEntryUnbucketed(minCellX, maxCellX, minCellY, maxCellY)) {
      this.unbucketedEntries.add(entry);
      return;
    }

    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
        const key = this.cellKey(cellX, cellY);
        const bucket = this.getOrCreateBucket(key);
        const entryCellIndex = entry.cellKeys.length;
        entry.cellKeys.push(key);
        entry.bucketIndices.push(bucket.entries.length);
        bucket.entries.push(entry);
        bucket.entryCellIndices.push(entryCellIndex);
      }
    }
  }

  remove(id: EntityId): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;

    this.removeEntryFromBuckets(entry);
    this.unbucketedEntries.delete(entry);
    this.entries.delete(id);
  }

  private removeEntryFromBuckets(entry: ClientProjectileRenderSpatialEntry): void {
    for (let i = 0; i < entry.cellKeys.length; i++) {
      const key = entry.cellKeys[i];
      const bucket = this.buckets.get(key);
      if (bucket === undefined) continue;
      const bucketIndex = entry.bucketIndices[i];
      const lastEntry = bucket.entries.pop();
      const lastEntryCellIndex = bucket.entryCellIndices.pop();
      if (
        lastEntry !== undefined &&
        lastEntryCellIndex !== undefined &&
        bucketIndex < bucket.entries.length
      ) {
        bucket.entries[bucketIndex] = lastEntry;
        bucket.entryCellIndices[bucketIndex] = lastEntryCellIndex;
        lastEntry.bucketIndices[lastEntryCellIndex] = bucketIndex;
      }
      if (bucket.entries.length === 0) this.buckets.delete(key);
    }
  }

  queryRenderLists(
    bounds: FootprintBounds,
    out: ClientProjectileRenderLists,
  ): ClientProjectileRenderLists {
    out.traveling.length = 0;
    out.smokeTrail.length = 0;
    out.line.length = 0;
    out.burnMark.length = 0;

    const seen = this.querySeenIds;
    seen.clear();

    const minCellX = this.cellCoord(bounds.minX);
    const maxCellX = this.cellCoord(bounds.maxX);
    const minCellY = this.cellCoord(bounds.minY);
    const maxCellY = this.cellCoord(bounds.maxY);
    if (this.shouldQueryEntriesDirectly(minCellX, maxCellX, minCellY, maxCellY)) {
      for (const entry of this.entries.values()) {
        if (
          entry.maxCellX < minCellX ||
          entry.minCellX > maxCellX ||
          entry.maxCellY < minCellY ||
          entry.minCellY > maxCellY
        ) {
          continue;
        }
        this.pushEntryRenderLists(entry.entity, out, seen);
      }
      return out;
    }

    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
        const bucket = this.buckets.get(this.cellKey(cellX, cellY));
        if (bucket === undefined) continue;
        const entries = bucket.entries;
        for (let i = 0; i < entries.length; i++) {
          this.pushEntryRenderLists(entries[i].entity, out, seen);
        }
      }
    }
    this.queryUnbucketedEntries(minCellX, maxCellX, minCellY, maxCellY, out, seen);
    return out;
  }

  private shouldStoreEntryUnbucketed(
    minCellX: number,
    maxCellX: number,
    minCellY: number,
    maxCellY: number,
  ): boolean {
    const width = maxCellX - minCellX + 1;
    const height = maxCellY - minCellY + 1;
    if (!(width > 0) || !(height > 0)) return true;
    const cells = width * height;
    return (
      !Number.isFinite(cells) ||
      cells > CLIENT_PROJECTILE_RENDER_MAX_BUCKET_CELLS_PER_ENTRY
    );
  }

  private shouldQueryEntriesDirectly(
    minCellX: number,
    maxCellX: number,
    minCellY: number,
    maxCellY: number,
  ): boolean {
    const width = maxCellX - minCellX + 1;
    const height = maxCellY - minCellY + 1;
    if (!(width > 0) || !(height > 0)) return true;
    const queriedCells = width * height;
    return !Number.isFinite(queriedCells) || queriedCells > this.buckets.size;
  }

  private pushEntryRenderLists(
    entity: Entity,
    out: ClientProjectileRenderLists,
    seen: Set<EntityId>,
  ): void {
    const projectile = entity.projectile;
    if (projectile === null) return;
    const points = projectile.points;
    if (points !== null && points.length > 0) {
      if (seen.has(entity.id)) return;
      seen.add(entity.id);
    }
    if (projectile.projectileType === 'projectile') {
      out.traveling.push(entity);
      if (projectile.config.shotProfile.visual.smokeTrail !== undefined) {
        out.smokeTrail.push(entity);
      }
      if (entity.dgunProjectile?.isDGun === true) {
        out.burnMark.push(entity);
      }
    } else {
      out.line.push(entity);
      out.burnMark.push(entity);
    }
  }

  private queryUnbucketedEntries(
    minCellX: number,
    maxCellX: number,
    minCellY: number,
    maxCellY: number,
    out: ClientProjectileRenderLists,
    seen: Set<EntityId>,
  ): void {
    if (this.unbucketedEntries.size === 0) return;
    for (const entry of this.unbucketedEntries) {
      if (
        entry.maxCellX < minCellX ||
        entry.minCellX > maxCellX ||
        entry.maxCellY < minCellY ||
        entry.minCellY > maxCellY
      ) {
        continue;
      }
      this.pushEntryRenderLists(entry.entity, out, seen);
    }
  }

  private updateBoundsForProjectile(entity: Entity): void {
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
      this.boundsMinX = minX;
      this.boundsMaxX = maxX;
      this.boundsMinY = minY;
      this.boundsMaxY = maxY;
      return;
    }

    this.boundsMinX = entity.transform.x;
    this.boundsMaxX = entity.transform.x;
    this.boundsMinY = entity.transform.y;
    this.boundsMaxY = entity.transform.y;
  }

  private getOrCreateBucket(cellKey: ClientProjectileRenderCellKey): ClientProjectileRenderBucket {
    let bucket = this.buckets.get(cellKey);
    if (bucket === undefined) {
      bucket = { entries: [], entryCellIndices: [] };
      this.buckets.set(cellKey, bucket);
    }
    return bucket;
  }

  private cellCoord(value: number): number {
    return Math.floor(value / CLIENT_PROJECTILE_RENDER_CELL_SIZE);
  }

  private cellKey(cellX: number, cellY: number): ClientProjectileRenderCellKey {
    if (
      cellX < -CLIENT_PROJECTILE_RENDER_CELL_KEY_OFFSET ||
      cellX > CLIENT_PROJECTILE_RENDER_CELL_KEY_OFFSET ||
      cellY < -CLIENT_PROJECTILE_RENDER_CELL_KEY_OFFSET ||
      cellY > CLIENT_PROJECTILE_RENDER_CELL_KEY_OFFSET
    ) {
      return `${cellX},${cellY}`;
    }
    return (
      (cellX + CLIENT_PROJECTILE_RENDER_CELL_KEY_OFFSET) *
      CLIENT_PROJECTILE_RENDER_CELL_KEY_STRIDE
    ) + cellY + CLIENT_PROJECTILE_RENDER_CELL_KEY_OFFSET;
  }
}
