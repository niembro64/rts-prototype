// Shared entity cache manager - avoids allocating new arrays every frame
// Used by both WorldState (server) and ClientViewState (client)

import type { Entity, EntityId } from './types';

export class EntityCacheManager {
  private cachedUnits: Entity[] = [];
  private cachedBuildings: Entity[] = [];
  private cachedProjectiles: Entity[] = [];
  private cachedForceFieldUnits: Entity[] = [];
  private cachedCommanderUnits: Entity[] = [];
  private cachedBuilderUnits: Entity[] = [];
  /** Units with at least one beam-type turret. Populated alongside
   *  cachedForceFieldUnits so updateLaserSounds can iterate just the
   *  ~few percent of units that actually fire beams instead of scanning
   *  every unit's turrets every tick. */
  private cachedBeamUnits: Entity[] = [];
  /** Units with mirror panels (e.g. Loris). Used by the per-projectile
   *  panel-impact check so it doesn't scan every unit looking for a
   *  rare attribute. */
  private cachedMirrorUnits: Entity[] = [];
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
    this.cachedCommanderUnits.length = 0;
    this.cachedBuilderUnits.length = 0;
    this.cachedBeamUnits.length = 0;
    this.cachedMirrorUnits.length = 0;
    this.cachedAll.length = 0;

    for (const entity of entities.values()) {
      this.cachedAll.push(entity);
      switch (entity.type) {
        case 'unit':
          this.cachedUnits.push(entity);
          if (entity.turrets) {
            let hasForceField = false;
            let hasBeam = false;
            for (let i = 0; i < entity.turrets.length; i++) {
              const t = entity.turrets[i].config.shot.type;
              if (t === 'force') hasForceField = true;
              else if (t === 'beam') hasBeam = true;
              if (hasForceField && hasBeam) break;
            }
            if (hasForceField) this.cachedForceFieldUnits.push(entity);
            if (hasBeam) this.cachedBeamUnits.push(entity);
          }
          if (entity.unit?.mirrorPanels && entity.unit.mirrorPanels.length > 0) {
            this.cachedMirrorUnits.push(entity);
          }
          if (entity.commander) this.cachedCommanderUnits.push(entity);
          if (entity.builder) this.cachedBuilderUnits.push(entity);
          break;
        case 'building':
          this.cachedBuildings.push(entity);
          break;
        case 'shot':
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

  getCommanderUnits(): Entity[] {
    return this.cachedCommanderUnits;
  }

  getBuilderUnits(): Entity[] {
    return this.cachedBuilderUnits;
  }

  getBeamUnits(): Entity[] {
    return this.cachedBeamUnits;
  }

  getMirrorUnits(): Entity[] {
    return this.cachedMirrorUnits;
  }

  getAll(): Entity[] {
    return this.cachedAll;
  }
}
