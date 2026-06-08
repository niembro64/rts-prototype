import type { FootprintBounds } from '../ViewportFootprint';
import type { Entity, EntityId } from '../sim/types';

const CLIENT_PROJECTILE_RENDER_CELL_SIZE = 512;
const CLIENT_PROJECTILE_RENDER_CELL_KEY_OFFSET = 1 << 20;
const CLIENT_PROJECTILE_RENDER_CELL_KEY_STRIDE = CLIENT_PROJECTILE_RENDER_CELL_KEY_OFFSET * 2 + 1;

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

export type ClientProjectileRenderLists = {
  traveling: Entity[];
  smokeTrail: Entity[];
  line: Entity[];
  burnMark: Entity[];
};

export class ClientProjectileRenderSpatialIndex {
  private readonly buckets = new Map<ClientProjectileRenderCellKey, Entity[]>();
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

    const cellKeys: ClientProjectileRenderCellKey[] = [];
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
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
        const bucket = this.buckets.get(this.cellKey(cellX, cellY));
        if (bucket === undefined) continue;
        for (let i = 0; i < bucket.length; i++) {
          const entity = bucket[i];
          const projectile = entity.projectile;
          if (projectile === null) continue;
          const points = projectile.points;
          if (points !== null && points.length > 0) {
            if (seen.has(entity.id)) continue;
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
      }
    }
    return out;
  }

  private repointBucketIndex(
    id: EntityId,
    cellKey: ClientProjectileRenderCellKey,
    nextIndex: number,
  ): void {
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

  private getOrCreateBucket(cellKey: ClientProjectileRenderCellKey): Entity[] {
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
