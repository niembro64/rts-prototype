// Shared entity cache manager - avoids allocating new arrays every frame
// Used by both WorldState (server) and ClientViewState (client)

import type { Entity, EntityId } from './types';

export class EntityCacheManager {
  private cachedUnits: Entity[] = [];
  private cachedBuildings: Entity[] = [];
  private cachedProjectiles: Entity[] = [];
  private cachedForceFieldUnits: Entity[] = [];
  private cachedAll: Entity[] = [];
  private dirty: boolean = true;

  invalidate(): void {
    this.dirty = true;
  }

  rebuildIfNeeded(entities: Map<EntityId, Entity>): void {
    if (!this.dirty) return;

    this.cachedUnits.length = 0;
    this.cachedBuildings.length = 0;
    this.cachedProjectiles.length = 0;
    this.cachedForceFieldUnits.length = 0;
    this.cachedAll.length = 0;

    for (const entity of entities.values()) {
      this.cachedAll.push(entity);
      switch (entity.type) {
        case 'unit':
          this.cachedUnits.push(entity);
          if (entity.weapons) {
            for (let i = 0; i < entity.weapons.length; i++) {
              if (entity.weapons[i].config.isForceField) {
                this.cachedForceFieldUnits.push(entity);
                break;
              }
            }
          }
          break;
        case 'building':
          this.cachedBuildings.push(entity);
          break;
        case 'projectile':
          this.cachedProjectiles.push(entity);
          break;
      }
    }

    this.dirty = false;
  }

  getUnits(): Entity[] {
    return this.cachedUnits;
  }

  getBuildings(): Entity[] {
    return this.cachedBuildings;
  }

  getProjectiles(): Entity[] {
    return this.cachedProjectiles;
  }

  getForceFieldUnits(): Entity[] {
    return this.cachedForceFieldUnits;
  }

  getAll(): Entity[] {
    return this.cachedAll;
  }
}
