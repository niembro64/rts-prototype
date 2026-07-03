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
  private cachedFactoryUnits: Entity[] = [];
  private cachedFactoriesByPlayer: Map<PlayerId, Entity[]> = new Map();
  private cachedShieldUnits: Entity[] = [];
  private cachedCommanderUnits: Entity[] = [];
  private cachedBuilderUnits: Entity[] = [];
  /** Flying units specifically. Force and snapshot-delta passes poll these
   *  every tick; locomotion type is blueprint-static, so cache it with the
   *  other stable unit buckets instead of filtering all units repeatedly. */
  private cachedFlyingUnits: Entity[] = [];
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
  /** Entities whose authored top surface can be sampled as locomotion
   *  support. This is usually just buildings/towers; most units have
   *  supportSurface.none and should not be walked by the support index
   *  rebuild every force tick. */
  private cachedSupportSurfaceEntities: Entity[] = [];
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

  handleEntityAdded(entity: Entity): void {
    if (this.dirty) return;
    this.addEntityToCaches(entity, true, true);
  }

  handleEntityRemoved(entity: Entity): void {
    if (this.dirty) return;
    this.removeEntityFromCaches(entity);
  }

  refreshHealthBarEntity(entity: Entity): void {
    if (this.dirty) return;
    const buildInProgress = isBuildInProgress(entity.buildable);
    if (entity.unit !== null) {
      removeEntityFromList(this.cachedDamagedUnits, entity);
      removeEntityFromList(this.cachedHudEntities, entity);
      if ((entity.unit.hp > 0 && entity.unit.hp < entity.unit.maxHp) || buildInProgress) {
        insertEntityById(this.cachedDamagedUnits, entity);
        insertEntityById(this.cachedHudEntities, entity);
      }
      return;
    }
    if (entity.building !== null) {
      removeEntityFromList(this.cachedHealthBarBuildings, entity);
      removeEntityFromList(this.cachedHudEntities, entity);
      if ((entity.building.hp > 0 && entity.building.hp < entity.building.maxHp) || buildInProgress) {
        insertEntityById(this.cachedHealthBarBuildings, entity);
        insertEntityById(this.cachedHudEntities, entity);
      }
    }
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
    this.cachedFactoryUnits.length = 0;
    this.cachedShieldUnits.length = 0;
    this.cachedCommanderUnits.length = 0;
    this.cachedBuilderUnits.length = 0;
    this.cachedFlyingUnits.length = 0;
    this.cachedArmedEntities.length = 0;
    this.cachedBeamUnits.length = 0;
    this.cachedShieldPanelUnits.length = 0;
    this.cachedAll.length = 0;
    this.cachedUnitsAndBuildings.length = 0;
    this.cachedSupportSurfaceEntities.length = 0;
    this.cachedCombatTargetEntities.length = 0;
    for (const list of this.cachedUnitsByPlayer.values()) list.length = 0;
    for (const list of this.cachedBuildingsByPlayer.values()) list.length = 0;
    for (const list of this.cachedFactoriesByPlayer.values()) list.length = 0;

    this.sortedEntities.length = 0;
    for (const entity of entities.values()) this.sortedEntities.push(entity);
    this.sortedEntities.sort((a, b) => a.id - b.id);

    const sortedEntities = this.sortedEntities;
    for (let sortedIndex = 0; sortedIndex < sortedEntities.length; sortedIndex++) {
      this.addEntityToCaches(sortedEntities[sortedIndex], true, false);
    }

    this.dirty = false;
    return true;
  }

  private addEntityToCaches(entity: Entity, includeAll: boolean, sortedInsert: boolean): void {
    if (includeAll) addEntityToList(this.cachedAll, entity, sortedInsert);
    const ownership = entity.ownership;
    const buildInProgress = isBuildInProgress(entity.buildable);
    // Combat capability is host-agnostic: any entity with a
    // CombatComponent that owns a non-visualOnly turret enters the
    // armed list, regardless of whether it's a unit or a building.
    if (entity.combat) {
      const turrets = entity.combat.turrets;
      let hasShield = false;
      let hasBeam = false;
      let hasCombatTurret = false;
      for (let i = 0; i < turrets.length; i++) {
        const config = turrets[i].config;
        if (config.visualOnly) continue;
        hasCombatTurret = true;
        const shot = config.shot;
        if (shot === null) continue;
        const t = shot.type;
        if (t === 'shield' && shot.barrier !== undefined) hasShield = true;
        else if (t === 'beam') hasBeam = true;
        if (hasShield && hasBeam) break;
      }
      if (hasCombatTurret) addEntityToList(this.cachedArmedEntities, entity, sortedInsert);
      if (hasShield) addEntityToList(this.cachedShieldUnits, entity, sortedInsert);
      if (hasBeam) addEntityToList(this.cachedBeamUnits, entity, sortedInsert);
    }
    switch (entity.type) {
      case 'unit':
        addEntityToList(this.cachedUnits, entity, sortedInsert);
        addEntityToList(this.cachedUnitsAndBuildings, entity, sortedInsert);
        addEntityToList(this.cachedCombatTargetEntities, entity, sortedInsert);
        if (entity.unit !== null && entity.unit.supportSurface.kind === 'discTop') {
          addEntityToList(this.cachedSupportSurfaceEntities, entity, sortedInsert);
        }
        if (ownership !== null) {
          addEntityToList(this.getOrCreateUnitsByPlayer(ownership.playerId), entity, sortedInsert);
        }
        // Damaged-or-shell list: feeds HealthBar3D.perUnit. A unit
        // shell (incomplete buildable) belongs here too even though
        // its hp is 0 at spawn — the bar renderer needs to draw the
        // build bars regardless of HP.
        if (
          entity.unit
          && (
            (entity.unit.hp > 0 && entity.unit.hp < entity.unit.maxHp)
            || buildInProgress
          )
        ) {
          addEntityToList(this.cachedDamagedUnits, entity, sortedInsert);
          addEntityToList(this.cachedHudEntities, entity, sortedInsert);
        }
        if (entity.unit !== null && entity.unit.shieldPanels.length > 0) {
          addEntityToList(this.cachedShieldPanelUnits, entity, sortedInsert);
        }
        if (entity.unit !== null && entity.unit.locomotion.type === 'flying') {
          addEntityToList(this.cachedFlyingUnits, entity, sortedInsert);
        }
        if (entity.commander) addEntityToList(this.cachedCommanderUnits, entity, sortedInsert);
        if (entity.builder) addEntityToList(this.cachedBuilderUnits, entity, sortedInsert);
        // A unit that carries a factory component is a mobile factory (a
        // queen): it produces units exactly like a building factory, so it
        // joins the per-player factory bucket the production + funding passes
        // iterate.
        if (entity.factory) {
          addEntityToList(this.cachedFactoryUnits, entity, sortedInsert);
          if (ownership !== null) {
            addEntityToList(this.getOrCreateFactoriesByPlayer(ownership.playerId), entity, sortedInsert);
          }
        }
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
        addEntityToList(this.cachedBuildings, entity, sortedInsert);
        addEntityToList(this.cachedUnitsAndBuildings, entity, sortedInsert);
        addEntityToList(this.cachedCombatTargetEntities, entity, sortedInsert);
        if (entity.building !== null && entity.building.supportSurface.kind === 'boxTop') {
          addEntityToList(this.cachedSupportSurfaceEntities, entity, sortedInsert);
        }
        if (ownership !== null) {
          addEntityToList(this.getOrCreateBuildingsByPlayer(ownership.playerId), entity, sortedInsert);
        }
        if (
          entity.building
          && (
            (entity.building.hp > 0 && entity.building.hp < entity.building.maxHp)
            || buildInProgress
          )
        ) {
          addEntityToList(this.cachedHealthBarBuildings, entity, sortedInsert);
          addEntityToList(this.cachedHudEntities, entity, sortedInsert);
        }
        if (entity.buildingBlueprintId === 'buildingWind') {
          addEntityToList(this.cachedWindBuildings, entity, sortedInsert);
          addEntityToList(this.cachedActiveStateBuildings, entity, sortedInsert);
        } else if (entity.buildingBlueprintId === 'buildingSolar') {
          addEntityToList(this.cachedSolarBuildings, entity, sortedInsert);
          addEntityToList(this.cachedActiveStateBuildings, entity, sortedInsert);
        } else if (isMetalExtractorBlueprintId(entity.buildingBlueprintId)) {
          addEntityToList(this.cachedExtractorBuildings, entity, sortedInsert);
          addEntityToList(this.cachedActiveStateBuildings, entity, sortedInsert);
        } else if (entity.buildingBlueprintId === 'buildingResourceConverter') {
          addEntityToList(this.cachedConverterBuildings, entity, sortedInsert);
          addEntityToList(this.cachedActiveStateBuildings, entity, sortedInsert);
        } else if (entity.buildingBlueprintId === 'buildingRadar') {
          addEntityToList(this.cachedActiveStateBuildings, entity, sortedInsert);
        }
        if (entity.factory) {
          addEntityToList(this.cachedFactoryBuildings, entity, sortedInsert);
          if (ownership !== null) {
            addEntityToList(this.getOrCreateFactoriesByPlayer(ownership.playerId), entity, sortedInsert);
          }
        }
        break;
      case 'shot':
        this.addProjectileEntity(entity, false, sortedInsert);
        break;
    }
  }

  private removeEntityFromCaches(entity: Entity): void {
    removeEntityFromList(this.cachedAll, entity);
    removeEntityFromList(this.cachedUnits, entity);
    removeEntityFromList(this.cachedBuildings, entity);
    removeEntityFromList(this.cachedProjectiles, entity);
    removeEntityFromList(this.cachedTravelingProjectiles, entity);
    removeEntityFromList(this.cachedSmokeTrailProjectiles, entity);
    removeEntityFromList(this.cachedLineProjectiles, entity);
    removeEntityFromList(this.cachedDamagedUnits, entity);
    removeEntityFromList(this.cachedHealthBarBuildings, entity);
    removeEntityFromList(this.cachedHudEntities, entity);
    removeEntityFromList(this.cachedWindBuildings, entity);
    removeEntityFromList(this.cachedSolarBuildings, entity);
    removeEntityFromList(this.cachedExtractorBuildings, entity);
    removeEntityFromList(this.cachedConverterBuildings, entity);
    removeEntityFromList(this.cachedActiveStateBuildings, entity);
    removeEntityFromList(this.cachedFactoryBuildings, entity);
    removeEntityFromList(this.cachedFactoryUnits, entity);
    removeEntityFromList(this.cachedShieldUnits, entity);
    removeEntityFromList(this.cachedCommanderUnits, entity);
    removeEntityFromList(this.cachedBuilderUnits, entity);
    removeEntityFromList(this.cachedFlyingUnits, entity);
    removeEntityFromList(this.cachedArmedEntities, entity);
    removeEntityFromList(this.cachedBeamUnits, entity);
    removeEntityFromList(this.cachedShieldPanelUnits, entity);
    removeEntityFromList(this.cachedUnitsAndBuildings, entity);
    removeEntityFromList(this.cachedSupportSurfaceEntities, entity);
    removeEntityFromList(this.cachedCombatTargetEntities, entity);
    for (const list of this.cachedUnitsByPlayer.values()) removeEntityFromList(list, entity);
    for (const list of this.cachedBuildingsByPlayer.values()) removeEntityFromList(list, entity);
    for (const list of this.cachedFactoriesByPlayer.values()) removeEntityFromList(list, entity);
  }

  private addProjectileEntity(entity: Entity, includeAll: boolean, sortedInsert: boolean): void {
    addEntityToList(this.cachedProjectiles, entity, sortedInsert);
    if (includeAll) addEntityToList(this.cachedAll, entity, sortedInsert);
    if (entity.projectile !== null && entity.projectile.projectileType === 'projectile') {
      addEntityToList(this.cachedTravelingProjectiles, entity, sortedInsert);
      addEntityToList(this.cachedCombatTargetEntities, entity, sortedInsert);
      if (entity.projectile.config.shotProfile.visual.smokeTrail) {
        addEntityToList(this.cachedSmokeTrailProjectiles, entity, sortedInsert);
      }
    } else if (entity.projectile && isRayType(entity.projectile.projectileType)) {
      addEntityToList(this.cachedLineProjectiles, entity, sortedInsert);
    }
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

  getSupportSurfaceEntities(): Entity[] {
    return this.cachedSupportSurfaceEntities;
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

  getFactoryUnits(): Entity[] {
    return this.cachedFactoryUnits;
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

  getFlyingUnits(): Entity[] {
    return this.cachedFlyingUnits;
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

function addEntityToList(list: Entity[], entity: Entity, sortedInsert: boolean): void {
  if (sortedInsert) insertEntityById(list, entity);
  else list.push(entity);
}

function removeEntityFromList(list: Entity[], entity: Entity): void {
  const index = list.indexOf(entity);
  if (index >= 0) list.splice(index, 1);
}

function insertEntityById(list: Entity[], entity: Entity): void {
  let index = list.length;
  while (index > 0 && list[index - 1].id > entity.id) index--;
  list.splice(index, 0, entity);
}
