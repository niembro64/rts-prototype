import type { Entity, BuildingBlueprintId } from '../sim/types';
import { NO_ENTITY_ID } from '../sim/types';
import type { NetworkServerSnapshotEntity } from './NetworkManager';
import {
  ENTITY_CHANGED_ACTIONS,
  ENTITY_CHANGED_BUILDING,
  ENTITY_CHANGED_COMBAT_MODE,
  ENTITY_CHANGED_FACTORY,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  codeToBuildingBlueprintId,
  codeToUnitBlueprintId,
} from '../../types/network';
import {
  applyNetworkTurretNonVisualState,
  refreshBuildingTurretsFromNetwork,
  refreshUnitTurretsFromNetwork,
} from './helpers';
import {
  applyNetworkUnitCombatMode,
  applyNetworkUnitActions,
  applyNetworkUnitStaticFields,
} from './unitSnapshotFields';
import {
  dequantizeEntityPosition as deqEntityPos,
  dequantizeRotation as deqRot,
} from './snapshotQuantization';
import {
  applyNetworkBuildState,
  getBuildingBuildRequired,
  getUnitBuildRequired,
} from './ClientBuildStateApplier';
import { getBuildingConfig } from '../sim/buildConfigs';
import { cloneBuildingSupportSurface } from '../sim/buildingSupportSurface';

/**
 * Applies snapshot fields that should snap immediately instead of entering the
 * render-frame drift predictor: health, build progress, orders, targeting, and
 * factory/building state.
 */
export function snapClientNonVisualState(
  entity: Entity,
  server: NetworkServerSnapshotEntity,
): boolean {
  const cf = server.changedFields;
  const isFull = cf == null;
  const su = server.unit;
  let cacheDirty = false;
  if (entity.unit && su) {
    if ((isFull || cf! & ENTITY_CHANGED_HP) && su.hp) {
      entity.unit.hp = su.hp.curr;
      entity.unit.maxHp = su.hp.max;
      cacheDirty = true;
    }
    if (isFull || cf! & ENTITY_CHANGED_BUILDING) {
      cacheDirty = applyNetworkBuildState(
        entity,
        su.build ?? undefined,
        getUnitBuildRequired(entity.unit.unitBlueprintId),
      ) || cacheDirty;
    }
    applyNetworkUnitStaticFields(entity.unit, su);
    if (isFull || cf! & ENTITY_CHANGED_COMBAT_MODE) {
      applyNetworkUnitCombatMode(entity, su);
    }

    if (isFull && Array.isArray(su.turrets)) {
      refreshUnitTurretsFromNetwork(
        entity,
        entity.unit.unitBlueprintId,
        entity.unit.radius.visual,
        su.turrets,
      );
    }

    if (isFull || cf! & ENTITY_CHANGED_ACTIONS) {
      applyNetworkUnitActions(entity.unit, su.actions);
    }

    applyNetworkTurretNonVisualState(entity, su.turrets);

    if (entity.builder && (
      su.buildTargetIdPresent
      || isFull
      || cf! & ENTITY_CHANGED_ACTIONS
    )) {
      entity.builder.currentBuildTarget = su.buildTargetId ?? NO_ENTITY_ID;
    }
  }

  const sb = server.building;
  if (entity.building) {
    if ((isFull || cf! & ENTITY_CHANGED_POS) && server.pos) {
      entity.transform.x = deqEntityPos(server.pos.x);
      entity.transform.y = deqEntityPos(server.pos.y);
      entity.transform.z = deqEntityPos(server.pos.z);
    }
    if ((isFull || cf! & ENTITY_CHANGED_ROT) && server.rotation !== null) {
      entity.transform.rotation = deqRot(server.rotation);
    }
  }

  if (entity.building && sb !== null && sb.buildingBlueprintCode !== null && isFull) {
    const buildingBlueprintId = codeToBuildingBlueprintId(sb.buildingBlueprintCode);
    if (buildingBlueprintId) {
      entity.buildingBlueprintId = buildingBlueprintId as BuildingBlueprintId;
      entity.building.supportSurface = cloneBuildingSupportSurface(
        getBuildingConfig(entity.buildingBlueprintId).supportSurface,
      );
    }
  }

  if (entity.building && sb !== null && sb.turrets !== null) {
    if (isFull && entity.buildingBlueprintId) {
      refreshBuildingTurretsFromNetwork(entity, entity.buildingBlueprintId, sb.turrets);
    } else {
      applyNetworkTurretNonVisualState(entity, sb.turrets);
    }
  }

  if (entity.building && sb && (isFull || sb.metalExtractionRate !== null)) {
    entity.metalExtractionRate = sb.metalExtractionRate ?? null;
  }

  if (entity.building && sb !== null && sb.hp !== null && (isFull || cf! & ENTITY_CHANGED_HP)) {
    entity.building.hp = sb.hp.curr;
    entity.building.maxHp = sb.hp.max;
    cacheDirty = true;
  }

  if (entity.building && sb !== null && sb.build !== null && (isFull || cf! & ENTITY_CHANGED_BUILDING)) {
    cacheDirty = applyNetworkBuildState(
      entity,
      sb.build,
      getBuildingBuildRequired(entity.buildingBlueprintId),
    ) || cacheDirty;
  }

  if (entity.building && sb && (isFull || cf! & ENTITY_CHANGED_BUILDING)) {
    // Wire field name is `solar` for legacy reasons; semantically the
    // shared BuildingActiveState open flag for solar / wind / extractor.
    if (sb.solar) {
      const activeState = entity.building.activeState;
      entity.building.activeState = {
        open: sb.solar.open,
        damageDelayMs: activeState === null ? 0 : activeState.damageDelayMs,
        reopenDelayMs: activeState === null ? 0 : activeState.reopenDelayMs,
      };
    } else if (
      isFull
      && (entity.buildingBlueprintId === 'buildingSolar'
        || entity.buildingBlueprintId === 'buildingWind'
        || entity.buildingBlueprintId === 'buildingExtractor')
    ) {
      entity.building.activeState = {
        open: entity.buildingBlueprintId !== 'buildingSolar',
        damageDelayMs: 0,
        reopenDelayMs: 0,
      };
    }
  }

  const sf = sb !== null ? sb.factory : null;
  if (entity.factory && sf && (isFull || cf! & ENTITY_CHANGED_FACTORY)) {
    const selectedUnitBlueprintId = sf.selectedUnitBlueprintCode === null
      ? null
      : codeToUnitBlueprintId(sf.selectedUnitBlueprintCode);
    entity.factory.selectedUnitBlueprintId = selectedUnitBlueprintId ?? null;
    entity.factory.currentShellId = null;
    entity.factory.currentBuildProgress = sf.progress;
    entity.factory.isProducing = sf.producing;
    entity.factory.energyRateFraction = sf.energyRate ?? 0;
    entity.factory.metalRateFraction = sf.metalRate ?? 0;
    entity.factory.rallyX = sf.rally.pos.x;
    entity.factory.rallyY = sf.rally.pos.y;
    entity.factory.rallyZ = sf.rally.posZ;
    entity.factory.rallyType = sf.rally.type as 'move' | 'fight' | 'patrol';
    // Multi-leg default route (visualization only). Whenever the factory
    // sub rides the snapshot it carries the full route consistently, so
    // mirroring it straight onto the client component is safe.
    entity.factory.defaultWaypoints = sf.route !== null && sf.route !== undefined
      ? sf.route.map((w) => ({
          x: w.pos.x,
          y: w.pos.y,
          z: w.posZ,
          type: w.type as 'move' | 'fight' | 'patrol',
        }))
      : null;
  }

  return cacheDirty;
}
