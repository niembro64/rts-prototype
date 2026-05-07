import type { Entity, PlayerId } from '../sim/types';

const ROCKET_REACQUIRE_RANGE_SQ = 800 * 800;

export type ClientRocketTargetSource = {
  getUnits(): Entity[];
  getBuildings(): Entity[];
  getFrameCounter(): number;
};

/** Client-side copy of the rocket fallback target selection. The
 *  finder owns its per-frame enemy cache so ClientViewState can keep
 *  projectile prediction orchestration separate from target scanning. */
export class ClientRocketTargetFinder {
  private readonly source: ClientRocketTargetSource;
  private enemyCache: Entity[] = [];
  private enemyCacheFrame = -1;
  private enemyCacheOwnerId: PlayerId | null = null;

  constructor(source: ClientRocketTargetSource) {
    this.source = source;
  }

  findNearestEnemyForRocket(projectile: Entity, ownerId: PlayerId): Entity | null {
    this.refreshEnemyCache(ownerId);
    let nearest: Entity | null = null;
    let nearestDistSq = ROCKET_REACQUIRE_RANGE_SQ;
    for (const entity of this.enemyCache) {
      const dx = entity.transform.x - projectile.transform.x;
      const dy = entity.transform.y - projectile.transform.y;
      const dz = entity.transform.z - projectile.transform.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearest = entity;
      }
    }
    return nearest;
  }

  clear(): void {
    this.enemyCache.length = 0;
    this.enemyCacheFrame = -1;
    this.enemyCacheOwnerId = null;
  }

  private refreshEnemyCache(ownerId: PlayerId): void {
    const frame = this.source.getFrameCounter();
    if (this.enemyCacheFrame === frame && this.enemyCacheOwnerId === ownerId) return;

    const list = this.enemyCache;
    list.length = 0;
    const units = this.source.getUnits();
    for (let i = 0; i < units.length; i++) {
      const entity = units[i];
      if (entity.ownership?.playerId === undefined || entity.ownership.playerId === ownerId) continue;
      if (!entity.unit || entity.unit.hp <= 0) continue;
      list.push(entity);
    }
    const buildings = this.source.getBuildings();
    for (let i = 0; i < buildings.length; i++) {
      const entity = buildings[i];
      if (entity.ownership?.playerId === undefined || entity.ownership.playerId === ownerId) continue;
      if (!entity.building || entity.building.hp <= 0) continue;
      list.push(entity);
    }
    this.enemyCacheFrame = frame;
    this.enemyCacheOwnerId = ownerId;
  }
}
