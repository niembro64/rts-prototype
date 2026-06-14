// Shared entity cache manager - avoids allocating new arrays every frame
// Used by both WorldState (server) and ClientViewState (client)

import type { Entity, EntityId, PlayerId } from './types';
import { isRayType } from './types';
import { isBuildInProgress } from './buildableHelpers';
import { isMetalExtractorBlueprintId } from '../../types/buildingTypes';

const EMPTY_ENTITIES: Entity[] = [];

export class EntityCacheManager {
  private cachedUnits: Entity[] = [];
  private cachedBuildings: Entity[] = [];
  private cachedProjectiles: Entity[] = [];
  private cachedTravelingProjectiles: Entity[] = [];
  private cachedSmokeTrailProjectiles: Entity[] = [];
  private cachedLineProjectiles: Entity[] = [];
  private cachedDamagedUnits: Entity[] = [];
  private cachedHealthBarBuildings: Entity[] = [];
  /** Units / towers / buildings that need ANY HUD bar this frame: body
   *  damaged or build-in-progress. Superset of cachedDamagedUnits ∪
   *  cachedHealthBarBuildings. Selection is NOT folded in here — the cache is dirty-
   *  rebuilt and may not invalidate on selection — so the orchestrator
   *  applies the selection rule against the live entity ref. */
  private cachedHudEntities: Entity[] = [];
  /** Wind turbines specifically. Polled every sim tick by WindPowerTracker
   *  to apply per-player wind production deltas; far cheaper to walk this
   *  small list than to filter the full building array each tick. */
  private cachedWindBuildings: Entity[] = [];
  /** Solar collectors specifically. Filtered subset of
   *  cachedActiveStateBuildings — kept for legacy callers that target
   *  only solar (e.g. completion / spawn helpers). */
  private cachedSolarBuildings: Entity[] = [];
  /** Metal extractors specifically. Used by deposit ownership / income
   *  helpers that walk only this building blueprint. */
  private cachedExtractorBuildings: Entity[] = [];
  /** Resource converters specifically. The per-tick conversion pass
   *  walks only these — no need to scan every building each tick. */
  private cachedConverterBuildings: Entity[] = [];
  /** Every building that uses the shared BuildingActiveState fortify
   *  mechanic (solar + wind + extractor). updateBuildingActiveStates
   *  runs every tick and only touches this list. */
  private cachedActiveStateBuildings: Entity[] = [];
  /** Fabricators/factories specifically. AI production and factory
   *  production run every sim tick and should not scan every building
   *  just to find this subset. */
  private cachedFactoryBuildings: Entity[] = [];
  private cachedFactoriesByPlayer: Map<PlayerId, Entity[]> = new Map();
  private cachedShieldUnits: Entity[] = [];
  private cachedCommanderUnits: Entity[] = [];
  private cachedBuilderUnits: Entity[] = [];
  /** Every entity (unit OR building) with a CombatComponent that owns
   *  at least one non-visualOnly turret. The combat pipeline iterates
   *  this list and never branches on entity type — armed buildings are
   *  first-class participants alongside armed units. */
  private cachedArmedEntities: Entity[] = [];
  /** Entities with at least one beam-type turret. Populated alongside
   *  cachedShieldUnits so updateLaserSounds can iterate just the
   *  ~few percent of entities that actually fire beams instead of
   *  scanning every entity's turrets every tick. */
  private cachedBeamUnits: Entity[] = [];
  /** Units with shield panels (e.g. Loris). Used by the per-projectile
   *  panel-impact check so it doesn't scan every unit looking for a
   *  rare attribute. */
  private cachedShieldPanelUnits: Entity[] = [];
  private cachedAll: Entity[] = [];
  /** Units + buildings in one list, no projectiles. UI hot loops
   *  (minimap, name labels) want both kinds with one iteration; without
   *  this they were back-to-back walking getUnits() then getBuildings(). */
  private cachedUnitsAndBuildings: Entity[] = [];
  /** Every entity addressable by the combat targeting slab. Units,
   *  buildings, towers, and traveling shots all occupy target rows, so
   *  the per-tick stamp walks this maintained set instead of stitching
   *  broad category lists together each frame. */
  private cachedCombatTargetEntities: Entity[] = [];
  private cachedUnitsByPlayer: Map<PlayerId, Entity[]> = new Map();
  private cachedBuildingsByPlayer: Map<PlayerId, Entity[]> = new Map();
  private sortedEntities: Entity[] = [];
  private dirty: boolean = true;

  invalidate(): void {
    this.dirty = true;
  }

  rebuildIfNeeded(entities: Map<EntityId, Entity>): boolean {
    if (!this.dirty) return false;

    this.cachedUnits.length = 0;
    this.cachedBuildings.length = 0;
    this.cachedProjectiles.length = 0;
    this.cachedTravelingProjectiles.length = 0;
    this.cachedSmokeTrailProjectiles.length = 0;
    this.cachedLineProjectiles.length = 0;
    this.cachedDamagedUnits.length = 0;
    this.cachedHealthBarBuildings.length = 0;
    this.cachedHudEntities.length = 0;
    this.cachedWindBuildings.length = 0;
    this.cachedSolarBuildings.length = 0;
    this.cachedExtractorBuildings.length = 0;
    this.cachedConverterBuildings.length = 0;
    this.cachedActiveStateBuildings.length = 0;
    this.cachedFactoryBuildings.length = 0;
    this.cachedShieldUnits.length = 0;
    this.cachedCommanderUnits.length = 0;
    this.cachedBuilderUnits.length = 0;
    this.cachedArmedEntities.length = 0;
    this.cachedBeamUnits.length = 0;
    this.cachedShieldPanelUnits.length = 0;
    this.cachedAll.length = 0;
    this.cachedUnitsAndBuildings.length = 0;
    this.cachedCombatTargetEntities.length = 0;
    for (const list of this.cachedUnitsByPlayer.values()) list.length = 0;
    for (const list of this.cachedBuildingsByPlayer.values()) list.length = 0;
    for (const list of this.cachedFactoriesByPlayer.values()) list.length = 0;

    this.sortedEntities.length = 0;
    for (const entity of entities.values()) this.sortedEntities.push(entity);
    this.sortedEntities.sort((a, b) => a.id - b.id);

    for (const entity of this.sortedEntities) {
      this.cachedAll.push(entity);
      const ownership = entity.ownership;
      // Combat capability is host-agnostic: any entity with a
      // CombatComponent that owns a non-visualOnly turret enters the
      // armed list, regardless of whether it's a unit or a building.
      if (entity.combat) {
        const turrets = entity.combat.turrets;
        let hasShield = false;
        let hasBeam = false;
        let hasCombatTurret = false;
        for (let i = 0; i < turrets.length; i++) {
          if (turrets[i].config.visualOnly) continue;
          hasCombatTurret = true;
          const shot = turrets[i].config.shot;
          if (shot === null) continue;
          const t = shot.type;
          if (t === 'shield' && shot.barrier !== undefined) hasShield = true;
          else if (t === 'beam') hasBeam = true;
          if (hasShield && hasBeam) break;
        }
        if (hasCombatTurret) this.cachedArmedEntities.push(entity);
        if (hasShield) this.cachedShieldUnits.push(entity);
        if (hasBeam) this.cachedBeamUnits.push(entity);
      }
      switch (entity.type) {
        case 'unit':
          this.cachedUnits.push(entity);
          this.cachedUnitsAndBuildings.push(entity);
          this.cachedCombatTargetEntities.push(entity);
          if (ownership !== null) {
            this.getOrCreateUnitsByPlayer(ownership.playerId).push(entity);
          }
          // Damaged-or-shell list: feeds HealthBar3D.perUnit. A unit
          // shell (incomplete buildable) belongs here too even though
          // its hp is 0 at spawn — the bar renderer needs to draw the
          // build bars regardless of HP.
          if (
            entity.unit
            && (
              (entity.unit.hp > 0 && entity.unit.hp < entity.unit.maxHp)
              || isBuildInProgress(entity.buildable)
            )
          ) {
            this.cachedDamagedUnits.push(entity);
          }
          // HUD list: body-damaged or build-in-progress. Mounted turrets
          // no longer have independent health/build bars.
          if (
            entity.unit
            && (
              (entity.unit.hp > 0 && entity.unit.hp < entity.unit.maxHp)
              || isBuildInProgress(entity.buildable)
            )
          ) {
            this.cachedHudEntities.push(entity);
          }
          if (entity.unit !== null && entity.unit.shieldPanels.length > 0) {
            this.cachedShieldPanelUnits.push(entity);
          }
          if (entity.commander) this.cachedCommanderUnits.push(entity);
          if (entity.builder) this.cachedBuilderUnits.push(entity);
          break;
        case 'building':
        case 'tower':
          // Towers and buildings share the static-entity caches —
          // every getBuildings() / getBuildingsByPlayer() / health-bar
          // / construction-shell consumer treats them identically.
          // The entity.type discriminator differentiates them for
          // selection-panel UI and combat targeting; everything else
          // reads the building component the same way. The producer
          // active-state caches (solar/wind/extractor/radar/converter)
          // are gated on buildingBlueprintId, so towers naturally don't enter
          // them. Factories (a tower-class buildingBlueprintId) still ride
          // the cachedFactoryBuildings list because the production
          // queue lives on the entity.factory component.
          this.cachedBuildings.push(entity);
          this.cachedUnitsAndBuildings.push(entity);
          this.cachedCombatTargetEntities.push(entity);
          if (ownership !== null) {
            this.getOrCreateBuildingsByPlayer(ownership.playerId).push(entity);
          }
          if (
            entity.building
            && (
              (entity.building.hp > 0 && entity.building.hp < entity.building.maxHp)
              || isBuildInProgress(entity.buildable)
            )
          ) {
            this.cachedHealthBarBuildings.push(entity);
          }
          // HUD list: body-damaged or build-in-progress. Mounted turrets
          // no longer have independent health/build bars.
          if (
            entity.building
            && (
              (entity.building.hp > 0 && entity.building.hp < entity.building.maxHp)
              || isBuildInProgress(entity.buildable)
            )
          ) {
            this.cachedHudEntities.push(entity);
          }
          if (entity.buildingBlueprintId === 'buildingWind') {
            this.cachedWindBuildings.push(entity);
            this.cachedActiveStateBuildings.push(entity);
          } else if (entity.buildingBlueprintId === 'buildingSolar') {
            this.cachedSolarBuildings.push(entity);
            this.cachedActiveStateBuildings.push(entity);
          } else if (isMetalExtractorBlueprintId(entity.buildingBlueprintId)) {
            this.cachedExtractorBuildings.push(entity);
            this.cachedActiveStateBuildings.push(entity);
          } else if (entity.buildingBlueprintId === 'buildingResourceConverter') {
            this.cachedConverterBuildings.push(entity);
            this.cachedActiveStateBuildings.push(entity);
          } else if (entity.buildingBlueprintId === 'buildingRadar') {
            this.cachedActiveStateBuildings.push(entity);
          }
          if (entity.factory) {
            this.cachedFactoryBuildings.push(entity);
            if (ownership !== null) {
              this.getOrCreateFactoriesByPlayer(ownership.playerId).push(entity);
            }
          }
          break;
        case 'shot':
          this.cachedProjectiles.push(entity);
          if (entity.projectile !== null && entity.projectile.projectileType === 'projectile') {
            this.cachedTravelingProjectiles.push(entity);
            this.cachedCombatTargetEntities.push(entity);
            if (entity.projectile.config.shotProfile.visual.smokeTrail) {
              this.cachedSmokeTrailProjectiles.push(entity);
            }
          } else if (entity.projectile && isRayType(entity.projectile.projectileType)) {
            this.cachedLineProjectiles.push(entity);
          }
          break;
      }
    }

    this.dirty = false;
    return true;
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

  private getOrCreateFactoriesByPlayer(playerId: PlayerId): Entity[] {
    let list = this.cachedFactoriesByPlayer.get(playerId);
    if (!list) {
      list = [];
      this.cachedFactoriesByPlayer.set(playerId, list);
    }
    return list;
  }

  getUnits(): Entity[] {
    return this.cachedUnits;
  }

  getBuildings(): Entity[] {
    return this.cachedBuildings;
  }

  getUnitsAndBuildings(): Entity[] {
    return this.cachedUnitsAndBuildings;
  }

  getCombatTargetEntities(): Entity[] {
    return this.cachedCombatTargetEntities;
  }

  getUnitsByPlayer(playerId: PlayerId): Entity[] {
    return this.cachedUnitsByPlayer.get(playerId) ?? EMPTY_ENTITIES;
  }

  getBuildingsByPlayer(playerId: PlayerId): Entity[] {
    return this.cachedBuildingsByPlayer.get(playerId) ?? EMPTY_ENTITIES;
  }

  getProjectiles(): Entity[] {
    return this.cachedProjectiles;
  }

  getTravelingProjectiles(): Entity[] {
    return this.cachedTravelingProjectiles;
  }

  getSmokeTrailProjectiles(): Entity[] {
    return this.cachedSmokeTrailProjectiles;
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

  getHudEntities(): Entity[] {
    return this.cachedHudEntities;
  }

  getWindBuildings(): Entity[] {
    return this.cachedWindBuildings;
  }

  getSolarBuildings(): Entity[] {
    return this.cachedSolarBuildings;
  }

  getExtractorBuildings(): Entity[] {
    return this.cachedExtractorBuildings;
  }

  getConverterBuildings(): Entity[] {
    return this.cachedConverterBuildings;
  }

  getActiveStateBuildings(): Entity[] {
    return this.cachedActiveStateBuildings;
  }

  getFactoryBuildings(): Entity[] {
    return this.cachedFactoryBuildings;
  }

  getFactoriesByPlayer(playerId: PlayerId): Entity[] {
    return this.cachedFactoriesByPlayer.get(playerId) ?? EMPTY_ENTITIES;
  }

  getShieldUnits(): Entity[] {
    return this.cachedShieldUnits;
  }

  getCommanderUnits(): Entity[] {
    return this.cachedCommanderUnits;
  }

  getBuilderUnits(): Entity[] {
    return this.cachedBuilderUnits;
  }

  getArmedEntities(): Entity[] {
    return this.cachedArmedEntities;
  }

  getBeamUnits(): Entity[] {
    return this.cachedBeamUnits;
  }

  getShieldPanelUnits(): Entity[] {
    return this.cachedShieldPanelUnits;
  }

  getAll(): Entity[] {
    return this.cachedAll;
  }
}
