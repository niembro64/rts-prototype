// Shared entity cache manager - avoids allocating new arrays every frame
// Used by both WorldState (server) and ClientViewState (client)

import type { Entity, EntityId, PlayerId } from './types';

export class EntityCacheManager {
  private cachedUnits: Entity[] = [];
  private cachedBuildings: Entity[] = [];
  private cachedProjectiles: Entity[] = [];
  private cachedTravelingProjectiles: Entity[] = [];
  private cachedLineProjectiles: Entity[] = [];
  private cachedDamagedUnits: Entity[] = [];
  private cachedHealthBarBuildings: Entity[] = [];
  /** Wind turbines specifically. Polled every sim tick by WindPowerTracker
   *  to apply per-player wind production deltas; far cheaper to walk this
   *  small list than to filter the full building array each tick. */
  private cachedWindBuildings: Entity[] = [];
  /** Solar collectors specifically. updateSolarCollectors runs every
   *  tick and only acts on this building type — same caching rationale
   *  as wind. */
  private cachedSolarBuildings: Entity[] = [];
  private cachedForceFieldUnits: Entity[] = [];
  private cachedCommanderUnits: Entity[] = [];
  private cachedBuilderUnits: Entity[] = [];
  /** Units with at least one turret. Used by hot combat systems so
   *  workers, commanders, or future unarmed utility units do not pay
   *  weapon-loop costs every tick. */
  private cachedArmedUnits: Entity[] = [];
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
  private cachedUnitsByPlayer: Map<PlayerId, Entity[]> = new Map();
  private cachedBuildingsByPlayer: Map<PlayerId, Entity[]> = new Map();
  private dirty: boolean = true;

  invalidate(): void {
    this.dirty = true;
  }

  rebuildIfNeeded(entities: Map<EntityId, Entity>): void {
    if (!this.dirty) return;

    this.cachedUnits.length = 0;
    this.cachedBuildings.length = 0;
    this.cachedProjectiles.length = 0;
    this.cachedTravelingProjectiles.length = 0;
    this.cachedLineProjectiles.length = 0;
    this.cachedDamagedUnits.length = 0;
    this.cachedHealthBarBuildings.length = 0;
    this.cachedWindBuildings.length = 0;
    this.cachedSolarBuildings.length = 0;
    this.cachedForceFieldUnits.length = 0;
    this.cachedCommanderUnits.length = 0;
    this.cachedBuilderUnits.length = 0;
    this.cachedArmedUnits.length = 0;
    this.cachedBeamUnits.length = 0;
    this.cachedMirrorUnits.length = 0;
    this.cachedAll.length = 0;
    for (const list of this.cachedUnitsByPlayer.values()) list.length = 0;
    for (const list of this.cachedBuildingsByPlayer.values()) list.length = 0;

    for (const entity of entities.values()) {
      this.cachedAll.push(entity);
      switch (entity.type) {
        case 'unit':
          this.cachedUnits.push(entity);
          if (entity.ownership?.playerId !== undefined) {
            this.getOrCreateUnitsByPlayer(entity.ownership.playerId).push(entity);
          }
          if (entity.unit && entity.unit.hp > 0 && entity.unit.hp < entity.unit.maxHp) {
            this.cachedDamagedUnits.push(entity);
          }
          if (entity.turrets) {
            if (entity.turrets.length > 0) this.cachedArmedUnits.push(entity);
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
          if (entity.ownership?.playerId !== undefined) {
            this.getOrCreateBuildingsByPlayer(entity.ownership.playerId).push(entity);
          }
          if (
            entity.building &&
            entity.building.hp > 0 &&
            (entity.building.hp < entity.building.maxHp || (entity.buildable && !entity.buildable.isComplete))
          ) {
            this.cachedHealthBarBuildings.push(entity);
          }
          if (entity.buildingType === 'wind') {
            this.cachedWindBuildings.push(entity);
          } else if (entity.buildingType === 'solar') {
            this.cachedSolarBuildings.push(entity);
          }
          break;
        case 'shot':
          this.cachedProjectiles.push(entity);
          if (entity.projectile?.projectileType === 'projectile') {
            this.cachedTravelingProjectiles.push(entity);
          } else if (entity.projectile?.projectileType === 'beam' || entity.projectile?.projectileType === 'laser') {
            this.cachedLineProjectiles.push(entity);
          }
          break;
      }
    }

    this.dirty = false;
  }

  private getOrCreateUnitsByPlayer(playerId: PlayerId): Entity[] {
    let list = this.cachedUnitsByPlayer.get(playerId);
    if (!list) {
      list = [];
      this.cachedUnitsByPlayer.set(playerId, list);
    }
    return list;
  }

  private getOrCreateBuildingsByPlayer(playerId: PlayerId): Entity[] {
    let list = this.cachedBuildingsByPlayer.get(playerId);
    if (!list) {
      list = [];
      this.cachedBuildingsByPlayer.set(playerId, list);
    }
    return list;
  }

  getUnits(): Entity[] {
    return this.cachedUnits;
  }

  getBuildings(): Entity[] {
    return this.cachedBuildings;
  }

  getUnitsByPlayer(playerId: PlayerId): Entity[] {
    return this.cachedUnitsByPlayer.get(playerId) ?? [];
  }

  getBuildingsByPlayer(playerId: PlayerId): Entity[] {
    return this.cachedBuildingsByPlayer.get(playerId) ?? [];
  }

  getProjectiles(): Entity[] {
    return this.cachedProjectiles;
  }

  getTravelingProjectiles(): Entity[] {
    return this.cachedTravelingProjectiles;
  }

  getLineProjectiles(): Entity[] {
    return this.cachedLineProjectiles;
  }

  getDamagedUnits(): Entity[] {
    return this.cachedDamagedUnits;
  }

  getHealthBarBuildings(): Entity[] {
    return this.cachedHealthBarBuildings;
  }

  getWindBuildings(): Entity[] {
    return this.cachedWindBuildings;
  }

  getSolarBuildings(): Entity[] {
    return this.cachedSolarBuildings;
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

  getArmedUnits(): Entity[] {
    return this.cachedArmedUnits;
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
