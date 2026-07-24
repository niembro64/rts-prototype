import type { Entity, BuildingBlueprintId, FactoryDefaultWaypoint } from '../sim/types';
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
  applyNetworkUnitCommandState,
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
import { isMetalExtractorBlueprintId } from '../../types/buildingTypes';
import {
  decodeFactoryProductionQueueInto,
  decodeFactoryProductionQuotaCountsInto,
  decodeFactoryProductionQuotasInto,
} from './factoryProductionQueueWire';
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
  if (entity.ownership?.playerId !== server.playerId) {
    entity.ownership = { playerId: server.playerId };
    cacheDirty = true;
  }
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
      applyNetworkUnitCombatMode(entity, su, isFull);
    }

    if (isFull && Array.isArray(su.turrets)) {
      refreshUnitTurretsFromNetwork(
        entity,
        entity.unit.unitBlueprintId,
        entity.unit.radius.other,
        su.turrets,
      );
    }

    if (isFull || cf! & ENTITY_CHANGED_ACTIONS) {
      if (su.actions !== null && su.actions !== undefined) {
        applyNetworkUnitActions(entity.unit, su.actions);
      }
      applyNetworkUnitCommandState(entity.unit, su, isFull);
    }

    applyNetworkTurretNonVisualState(entity, su.turrets);

    if (entity.builder && (
      su.buildTargetIdPresent
      || isFull
      || cf! & ENTITY_CHANGED_ACTIONS
    )) {
      entity.builder.currentBuildTarget = su.buildTargetId ?? NO_ENTITY_ID;
    }
    if (entity.builder && (
      su.builderPriorityLow !== null && su.builderPriorityLow !== undefined ||
      isFull
    )) {
      entity.builder.lowPriority = su.builderPriorityLow === true;
    }
    if (entity.factory && (
      su.carrierSpawnEnabled !== null && su.carrierSpawnEnabled !== undefined ||
      isFull
    )) {
      entity.factory.carrierSpawnEnabled = su.carrierSpawnEnabled !== false;
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
      const buildingConfig = getBuildingConfig(entity.buildingBlueprintId);
      entity.building.supportSurface = cloneBuildingSupportSurface(
        buildingConfig.supportSurface,
      );
      entity.building.placementType = buildingConfig.placementType;
      entity.building.hoveringType = buildingConfig.hoveringType;
      entity.building.hovering = buildingConfig.hovering;
      entity.building.targetRadius = buildingConfig.radius.hitbox;
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
        || isMetalExtractorBlueprintId(entity.buildingBlueprintId))
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
    entity.factory.repeatProduction = sf.repeat !== false;
    if (sf.paused !== undefined || isFull) {
      entity.factory.paused = sf.paused === true;
    }
    if (sf.moveState !== undefined || isFull) {
      entity.factory.moveState = sf.moveState ?? 'holdPosition';
    }
    if (sf.airIdleState !== undefined || isFull) {
      entity.factory.airIdleState = sf.airIdleState ?? 'land';
    }
    entity.factory.productionQueue = decodeFactoryProductionQueueInto(
      sf.queue,
      entity.factory.productionQueue,
    );
    decodeFactoryProductionQuotasInto(sf.quotas, entity.factory.productionQuotas);
    decodeFactoryProductionQuotaCountsInto(sf.quotaCounts, entity.factory.productionQuotaCounts);
    entity.factory.currentShellId = null;
    entity.factory.currentBuildProgress = sf.progress;
    entity.factory.isProducing = sf.producing;
    entity.factory.energyRateFraction = sf.energyRate ?? 0;
    entity.factory.metalRateFraction = sf.metalRate ?? 0;
    entity.factory.guardTargetId = sf.guardTargetId ?? null;
    if (sf.lowPriority !== undefined || isFull) {
      entity.factory.lowPriority = sf.lowPriority === true;
    }
    entity.factory.rallyX = sf.rally.pos.x;
    entity.factory.rallyY = sf.rally.pos.y;
    entity.factory.rallyZ = sf.rally.posZ;
    entity.factory.rallyType = sf.rally.type as 'move' | 'fight' | 'patrol';
    // Multi-leg default route (visualization only). Whenever the factory
    // sub rides the snapshot it carries the full route consistently, so
    // mirroring it straight onto the client component is safe.
    if (sf.route !== null && sf.route !== undefined) {
      const existing = entity.factory.defaultWaypoints;
      const route = existing !== null && existing.length === sf.route.length
        ? existing as FactoryDefaultWaypoint[]
        : new Array<FactoryDefaultWaypoint>(sf.route.length);
      for (let i = 0; i < sf.route.length; i++) {
        const src = sf.route[i];
        let dst = route[i];
        if (dst === undefined) {
          dst = { x: 0, y: 0, z: null, type: 'move' };
          route[i] = dst;
        }
        dst.x = src.pos.x;
        dst.y = src.pos.y;
        dst.z = src.posZ;
        dst.type = src.type as 'move' | 'fight' | 'patrol';
      }
      entity.factory.defaultWaypoints = route;
    } else {
      entity.factory.defaultWaypoints = null;
    }
  }

  return cacheDirty;
}
