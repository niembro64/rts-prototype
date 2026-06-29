import type { FootprintBounds } from '../ViewportFootprint';
import { IndexedEntityIdMap } from './IndexedEntityIdCollections';
import {
  CLIENT_RENDER_ENTITY_KIND_BUILDING,
  CLIENT_RENDER_ENTITY_KIND_UNIT,
  type ClientRenderEntityStateViews,
} from '../render3d/ClientRenderEntityStateSlab';
import type { EntityId } from '../sim/types';

const CLIENT_RENDER_CELL_SIZE = 512;
const CLIENT_RENDER_CELL_KEY_OFFSET = 1 << 20;
const CLIENT_RENDER_CELL_KEY_STRIDE = CLIENT_RENDER_CELL_KEY_OFFSET * 2 + 1;
const DEFAULT_MAX_ENTITY_PADDING = 350;

type ClientRenderCellKey = number;

type ClientRenderSpatialEntry = {
  entityId: EntityId;
  slot: number;
  kind: number;
  cellX: number;
  cellY: number;
  cellKey: ClientRenderCellKey;
  bucketIndex: number;
  padding: number;
};

export class ClientRenderSpatialIndex {
  private readonly buckets = new Map<ClientRenderCellKey, ClientRenderSpatialEntry[]>();
  private readonly entriesById = new IndexedEntityIdMap<ClientRenderSpatialEntry>();
  private maxEntityPadding = DEFAULT_MAX_ENTITY_PADDING;

  clear(): void {
    this.buckets.clear();
    this.entriesById.clear();
    this.maxEntityPadding = DEFAULT_MAX_ENTITY_PADDING;
  }

  getMaxEntityPadding(): number {
    return this.maxEntityPadding;
  }

  updateSlot(views: ClientRenderEntityStateViews, slot: number): void {
    const kind = views.kind[slot];
    const entityId = views.entityIds[slot] as EntityId;
    if (
      entityId <= 0 ||
      (kind !== CLIENT_RENDER_ENTITY_KIND_UNIT && kind !== CLIENT_RENDER_ENTITY_KIND_BUILDING)
    ) {
      if (entityId > 0) this.remove(entityId);
      return;
    }

    const cellX = this.cellCoord(views.x[slot]);
    const cellY = this.cellCoord(views.y[slot]);
    if (!Number.isFinite(cellX) || !Number.isFinite(cellY)) {
      this.remove(entityId);
      return;
    }
    const cellKey = this.cellKey(cellX, cellY);
    const padding = Math.max(DEFAULT_MAX_ENTITY_PADDING, views.renderScopePadding[slot]);
    let existing = this.entriesById.get(entityId);
    if (existing !== undefined && existing.slot !== slot) {
      this.remove(entityId);
      existing = undefined;
    }

    if (existing !== undefined && existing.cellKey === cellKey) {
      existing.slot = slot;
      existing.kind = kind;
      existing.cellX = cellX;
      existing.cellY = cellY;
      this.updateEntryPadding(existing, padding);
      return;
    }

    if (existing !== undefined) this.remove(entityId);
    const bucket = this.getOrCreateBucket(cellKey);
    const entry: ClientRenderSpatialEntry = {
      entityId,
      slot,
      kind,
      cellX,
      cellY,
      cellKey,
      bucketIndex: bucket.length,
      padding,
    };
    bucket.push(entry);
    this.entriesById.set(entityId, entry);
    if (padding > this.maxEntityPadding) this.maxEntityPadding = padding;
  }

  remove(id: EntityId): void {
    const entry = this.entriesById.get(id);
    if (entry === undefined) return;
    const bucket = this.buckets.get(entry.cellKey);
    if (bucket !== undefined) {
      const lastEntry = bucket.pop();
      if (lastEntry !== undefined && entry.bucketIndex < bucket.length) {
        bucket[entry.bucketIndex] = lastEntry;
        lastEntry.bucketIndex = entry.bucketIndex;
      }
      if (bucket.length === 0) this.buckets.delete(entry.cellKey);
    }
    this.entriesById.delete(id);
    if (entry.padding >= this.maxEntityPadding) this.recomputeMaxEntityPadding();
  }

  queryFilteredSlots(
    bounds: FootprintBounds,
    outUnitSlots: number[],
    outBuildingSlots: number[],
    includeSlot?: (slot: number) => boolean,
  ): void {
    outUnitSlots.length = 0;
    outBuildingSlots.length = 0;

    const minCellX = this.cellCoord(bounds.minX);
    const maxCellX = this.cellCoord(bounds.maxX);
    const minCellY = this.cellCoord(bounds.minY);
    const maxCellY = this.cellCoord(bounds.maxY);
    if (this.shouldQueryEntriesDirectly(minCellX, maxCellX, minCellY, maxCellY)) {
      for (const entry of this.entriesById.values()) {
        if (!this.entryIntersectsCells(entry, minCellX, maxCellX, minCellY, maxCellY)) continue;
        this.pushEntrySlots(entry, outUnitSlots, outBuildingSlots, includeSlot);
      }
      return;
    }

    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
        const bucket = this.buckets.get(this.cellKey(cellX, cellY));
        if (bucket === undefined) continue;
        for (let i = 0; i < bucket.length; i++) {
          this.pushEntrySlots(bucket[i], outUnitSlots, outBuildingSlots, includeSlot);
        }
      }
    }
  }

  private getOrCreateBucket(cellKey: ClientRenderCellKey): ClientRenderSpatialEntry[] {
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
    for (const entry of this.entriesById.values()) {
      if (entry.padding > next) next = entry.padding;
    }
    this.maxEntityPadding = next;
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

  private pushEntrySlots(
    entry: ClientRenderSpatialEntry,
    outUnitSlots: number[],
    outBuildingSlots: number[],
    includeSlot: ((slot: number) => boolean) | undefined,
  ): void {
    if (includeSlot !== undefined && !includeSlot(entry.slot)) return;
    if (entry.kind === CLIENT_RENDER_ENTITY_KIND_UNIT) outUnitSlots.push(entry.slot);
    else if (entry.kind === CLIENT_RENDER_ENTITY_KIND_BUILDING) outBuildingSlots.push(entry.slot);
  }

  private entryIntersectsCells(
    entry: ClientRenderSpatialEntry,
    minCellX: number,
    maxCellX: number,
    minCellY: number,
    maxCellY: number,
  ): boolean {
    return (
      entry.cellX >= minCellX &&
      entry.cellX <= maxCellX &&
      entry.cellY >= minCellY &&
      entry.cellY <= maxCellY
    );
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
