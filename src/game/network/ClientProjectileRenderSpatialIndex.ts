import type { FootprintBounds } from '../ViewportFootprint';
import type { Entity, EntityId } from '../sim/types';
import {
  IndexedEntityIdMap,
  IndexedEntityIdSet,
} from './IndexedEntityIdCollections';
import {
  CLIENT_PROJECTILE_RENDER_FLAG_BURN_MARK,
  CLIENT_PROJECTILE_RENDER_FLAG_HAS_POINTS,
  CLIENT_PROJECTILE_RENDER_FLAG_LINE,
  CLIENT_PROJECTILE_RENDER_FLAG_SMOKE_TRAIL,
  CLIENT_PROJECTILE_RENDER_FLAG_TRAVELING,
  type ClientProjectileRenderStateViews,
} from './ClientProjectileRenderStateSlab';
import {
  cellBoundsIntersect,
  clientRenderCellCoord,
  clientRenderCellKey,
  createClientRenderCellBounds,
  shouldQuerySparseGridDirectly,
  writeClientRenderCellBounds,
} from './spatialGridQuery';
const CLIENT_PROJECTILE_RENDER_MAX_BUCKET_CELLS_PER_ENTRY = 256;

type ClientProjectileRenderCellKey = number | string;

type ClientProjectileRenderSpatialEntry = {
  entityId: EntityId;
  slot: number;
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

export type ClientProjectileRenderSlotLists = {
  traveling: number[];
  smokeTrail: number[];
  line: number[];
  burnMark: number[];
};

export class ClientProjectileRenderSpatialIndex {
  private readonly buckets = new Map<ClientProjectileRenderCellKey, ClientProjectileRenderBucket>();
  private readonly entries = new IndexedEntityIdMap<ClientProjectileRenderSpatialEntry>();
  private readonly unbucketedEntries = new Set<ClientProjectileRenderSpatialEntry>();
  private readonly querySeenIds = new IndexedEntityIdSet();
  private readonly queryCellBounds = createClientRenderCellBounds();

  clear(): void {
    this.buckets.clear();
    this.entries.clear();
    this.unbucketedEntries.clear();
    this.querySeenIds.clear();
  }

  updateSlot(views: ClientProjectileRenderStateViews, slot: number): void {
    const entityId = views.entityIds[slot] as EntityId;
    if (entityId <= 0 || views.flags[slot] === 0) {
      if (entityId > 0) this.remove(entityId);
      return;
    }

    const minCellX = clientRenderCellCoord(views.minX[slot]);
    const maxCellX = clientRenderCellCoord(views.maxX[slot]);
    const minCellY = clientRenderCellCoord(views.minY[slot]);
    const maxCellY = clientRenderCellCoord(views.maxY[slot]);
    if (
      !Number.isFinite(minCellX) ||
      !Number.isFinite(maxCellX) ||
      !Number.isFinite(minCellY) ||
      !Number.isFinite(maxCellY)
    ) {
      this.remove(entityId);
      return;
    }
    let existing = this.entries.get(entityId);
    if (existing !== undefined && existing.slot !== slot) {
      this.remove(entityId);
      existing = undefined;
    }
    if (
      existing !== undefined &&
      existing.minCellX === minCellX &&
      existing.maxCellX === maxCellX &&
      existing.minCellY === minCellY &&
      existing.maxCellY === maxCellY
    ) {
      existing.slot = slot;
      return;
    }

    let entry = existing;
    if (entry !== undefined) {
      this.removeEntryFromBuckets(entry);
      this.unbucketedEntries.delete(entry);
      entry.slot = slot;
      entry.minCellX = minCellX;
      entry.maxCellX = maxCellX;
      entry.minCellY = minCellY;
      entry.maxCellY = maxCellY;
      entry.cellKeys.length = 0;
      entry.bucketIndices.length = 0;
    } else {
      entry = {
        entityId,
        slot,
        minCellX,
        maxCellX,
        minCellY,
        maxCellY,
        cellKeys: [],
        bucketIndices: [],
      };
      this.entries.set(entityId, entry);
    }

    if (this.shouldStoreEntryUnbucketed(minCellX, maxCellX, minCellY, maxCellY)) {
      this.unbucketedEntries.add(entry);
      return;
    }

    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
        const key = clientRenderCellKey(cellX, cellY);
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
    out: ClientProjectileRenderSlotLists,
    views: ClientProjectileRenderStateViews,
  ): ClientProjectileRenderSlotLists {
    out.traveling.length = 0;
    out.smokeTrail.length = 0;
    out.line.length = 0;
    out.burnMark.length = 0;

    const seen = this.querySeenIds;
    seen.clear();

    const {
      minCellX,
      maxCellX,
      minCellY,
      maxCellY,
    } = writeClientRenderCellBounds(this.queryCellBounds, bounds);
    if (
      shouldQuerySparseGridDirectly(
        minCellX,
        maxCellX,
        minCellY,
        maxCellY,
        this.buckets.size,
      )
    ) {
      for (const entry of this.entries.values()) {
        if (
          !cellBoundsIntersect(
            entry.minCellX,
            entry.maxCellX,
            entry.minCellY,
            entry.maxCellY,
            minCellX,
            maxCellX,
            minCellY,
            maxCellY,
          )
        ) {
          continue;
        }
        this.pushEntryRenderLists(entry, views, out, seen);
      }
      return out;
    }

    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
        const bucket = this.buckets.get(clientRenderCellKey(cellX, cellY));
        if (bucket === undefined) continue;
        const entries = bucket.entries;
        for (let i = 0; i < entries.length; i++) {
          this.pushEntryRenderLists(entries[i], views, out, seen);
        }
      }
    }
    this.queryUnbucketedEntries(minCellX, maxCellX, minCellY, maxCellY, views, out, seen);
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

  private pushEntryRenderLists(
    entry: ClientProjectileRenderSpatialEntry,
    views: ClientProjectileRenderStateViews,
    out: ClientProjectileRenderSlotLists,
    seen: Set<EntityId>,
  ): void {
    const flags = views.flags[entry.slot];
    if ((flags & CLIENT_PROJECTILE_RENDER_FLAG_HAS_POINTS) !== 0) {
      if (seen.has(entry.entityId)) return;
      seen.add(entry.entityId);
    }
    if ((flags & CLIENT_PROJECTILE_RENDER_FLAG_TRAVELING) !== 0) out.traveling.push(entry.slot);
    if ((flags & CLIENT_PROJECTILE_RENDER_FLAG_SMOKE_TRAIL) !== 0) out.smokeTrail.push(entry.slot);
    if ((flags & CLIENT_PROJECTILE_RENDER_FLAG_LINE) !== 0) out.line.push(entry.slot);
    if ((flags & CLIENT_PROJECTILE_RENDER_FLAG_BURN_MARK) !== 0) out.burnMark.push(entry.slot);
  }

  private queryUnbucketedEntries(
    minCellX: number,
    maxCellX: number,
    minCellY: number,
    maxCellY: number,
    views: ClientProjectileRenderStateViews,
    out: ClientProjectileRenderSlotLists,
    seen: Set<EntityId>,
  ): void {
    if (this.unbucketedEntries.size === 0) return;
    for (const entry of this.unbucketedEntries) {
      if (
        !cellBoundsIntersect(
          entry.minCellX,
          entry.maxCellX,
          entry.minCellY,
          entry.maxCellY,
          minCellX,
          maxCellX,
          minCellY,
          maxCellY,
        )
      ) {
        continue;
      }
      this.pushEntryRenderLists(entry, views, out, seen);
    }
  }

  private getOrCreateBucket(cellKey: ClientProjectileRenderCellKey): ClientProjectileRenderBucket {
    let bucket = this.buckets.get(cellKey);
    if (bucket === undefined) {
      bucket = { entries: [], entryCellIndices: [] };
      this.buckets.set(cellKey, bucket);
    }
    return bucket;
  }

}
