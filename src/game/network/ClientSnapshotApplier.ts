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

type NetworkFactorySnapshot = NonNullable<
  NonNullable<NetworkServerSnapshotEntity['unit']>['factory']
>;

function applyNetworkFactorySnapshot(
  entity: Entity,
  snapshot: NetworkFactorySnapshot,
  isFull: boolean,
): void {
  const factory = entity.factory;
  if (factory === null) return;
  const selectedUnitBlueprintId = snapshot.selectedUnitBlueprintCode === null
    ? null
    : codeToUnitBlueprintId(snapshot.selectedUnitBlueprintCode);
  factory.selectedUnitBlueprintId = selectedUnitBlueprintId ?? null;
  factory.repeatProduction = snapshot.repeat !== false;
  if (snapshot.paused !== undefined || isFull) {
    factory.paused = snapshot.paused === true;
  }
  if (snapshot.moveState !== undefined || isFull) {
    factory.moveState = snapshot.moveState ?? (entity.unit !== null ? 'maneuver' : 'holdPosition');
  }
  if (snapshot.airIdleState !== undefined || isFull) {
    factory.airIdleState = snapshot.airIdleState ?? (entity.unit !== null ? 'fly' : 'land');
  }
  factory.productionQueue = decodeFactoryProductionQueueInto(
    snapshot.queue,
    factory.productionQueue,
  );
  decodeFactoryProductionQuotasInto(snapshot.quotas, factory.productionQuotas);
  decodeFactoryProductionQuotaCountsInto(snapshot.quotaCounts, factory.productionQuotaCounts);
  factory.currentShellId = null;
  factory.currentBuildProgress = snapshot.progress;
  factory.isProducing = snapshot.producing;
  factory.energyRateFraction = snapshot.energyRate ?? 0;
  factory.metalRateFraction = snapshot.metalRate ?? 0;
  factory.guardTargetId = snapshot.guardTargetId ?? null;
  if (snapshot.lowPriority !== undefined || isFull) {
    factory.lowPriority = snapshot.lowPriority === true;
  }
  factory.rallyX = snapshot.rally.pos.x;
  factory.rallyY = snapshot.rally.pos.y;
  factory.rallyZ = snapshot.rally.posZ;
  factory.rallyType = snapshot.rally.type as 'move' | 'fight' | 'patrol';

  if (snapshot.route !== null && snapshot.route !== undefined) {
    const existing = factory.defaultWaypoints;
    const route = existing !== null && existing.length === snapshot.route.length
      ? existing as FactoryDefaultWaypoint[]
      : new Array<FactoryDefaultWaypoint>(snapshot.route.length);
    for (let i = 0; i < snapshot.route.length; i++) {
      const src = snapshot.route[i];
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
    factory.defaultWaypoints = route;
  } else {
    factory.defaultWaypoints = null;
  }
}

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
    if (entity.builder?.workStation !== null && entity.builder?.workStation !== undefined) {
      const pose = su.workStation;
      if (pose !== null && pose !== undefined) {
        const station = entity.builder.workStation;
        station.localYaw = deqRot(pose.localYaw);
        station.localPitch = deqRot(pose.localPitch);
        station.localYawVelocity = deqRot(pose.localYawVelocity);
        station.localPitchVelocity = deqRot(pose.localPitchVelocity);
        station.targetEntityId = pose.targetActive ? 0 : NO_ENTITY_ID;
        station.aligned = pose.aligned;
        station.targetWorldYaw = deqRot(pose.targetWorldYaw);
        station.targetWorldPitch = deqRot(pose.targetWorldPitch);
      }
    }
    if (entity.factory && (
      su.carrierSpawnEnabled !== null && su.carrierSpawnEnabled !== undefined ||
      isFull
    )) {
      entity.factory.carrierSpawnEnabled = su.carrierSpawnEnabled !== false;
    }
    if (
      entity.factory !== null &&
      su.factory !== null &&
      su.factory !== undefined &&
      (isFull || cf! & ENTITY_CHANGED_FACTORY)
    ) {
      applyNetworkFactorySnapshot(entity, su.factory, isFull);
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
    applyNetworkFactorySnapshot(entity, sf, isFull);
  }

  return cacheDirty;
}
