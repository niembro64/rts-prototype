import type { Entity, BuildingType } from '../sim/types';
import type { NetworkServerSnapshotEntity } from './NetworkManager';
import {
  ENTITY_CHANGED_ACTIONS,
  ENTITY_CHANGED_BUILDING,
  ENTITY_CHANGED_COMBAT_MODE,
  ENTITY_CHANGED_FACTORY,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_SUSPENSION,
  codeToBuildingType,
  codeToUnitType,
} from '../../types/network';
import {
  applyNetworkTurretNonVisualState,
  refreshBuildingTurretsFromNetwork,
  refreshUnitTurretsFromNetwork,
} from './helpers';
import {
  applyNetworkUnitCombatMode,
  applyNetworkSuspensionState,
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
        su.build,
        getUnitBuildRequired(entity.unit.unitType),
      ) || cacheDirty;
    }
    applyNetworkUnitStaticFields(entity.unit, su);
    if (isFull || cf! & ENTITY_CHANGED_SUSPENSION) {
      applyNetworkSuspensionState(entity, su.suspension);
    }
    if (isFull || cf! & ENTITY_CHANGED_COMBAT_MODE) {
      applyNetworkUnitCombatMode(entity, su);
    }

    if (isFull && Array.isArray(su.turrets)) {
      refreshUnitTurretsFromNetwork(
        entity,
        entity.unit.unitType,
        entity.unit.radius.body,
        su.turrets,
      );
    }

    if (isFull || cf! & ENTITY_CHANGED_ACTIONS) {
      applyNetworkUnitActions(entity.unit, su.actions);
    }

    applyNetworkTurretNonVisualState(entity, su.turrets);

    if (entity.builder && (
      su.buildTargetId !== undefined
      || isFull
      || cf! & ENTITY_CHANGED_ACTIONS
    )) {
      entity.builder.currentBuildTarget = su.buildTargetId ?? null;
    }
  }

  const sb = server.building;
  if (entity.building) {
    if ((isFull || cf! & ENTITY_CHANGED_POS) && server.pos) {
      entity.transform.x = deqEntityPos(server.pos.x);
      entity.transform.y = deqEntityPos(server.pos.y);
      entity.transform.z = deqEntityPos(server.pos.z);
    }
    if ((isFull || cf! & ENTITY_CHANGED_ROT) && server.rotation !== undefined) {
      entity.transform.rotation = deqRot(server.rotation);
    }
  }

  if (entity.building && sb?.type !== undefined && isFull) {
    const buildingType = codeToBuildingType(sb.type);
    if (buildingType) entity.buildingType = buildingType as BuildingType;
  }

  if (entity.building && sb?.turrets) {
    if (isFull && entity.buildingType) {
      refreshBuildingTurretsFromNetwork(entity, entity.buildingType, sb.turrets);
    } else {
      applyNetworkTurretNonVisualState(entity, sb.turrets);
    }
  }

  if (entity.building && sb && (isFull || sb.metalExtractionRate !== undefined)) {
    entity.metalExtractionRate = sb.metalExtractionRate;
  }

  if (entity.building && sb?.hp && (isFull || cf! & ENTITY_CHANGED_HP)) {
    entity.building.hp = sb.hp.curr;
    entity.building.maxHp = sb.hp.max;
    cacheDirty = true;
  }

  if (entity.building && sb?.build && (isFull || cf! & ENTITY_CHANGED_BUILDING)) {
    cacheDirty = applyNetworkBuildState(
      entity,
      sb.build,
      getBuildingBuildRequired(entity.buildingType),
    ) || cacheDirty;
  }

  if (entity.building && sb && (isFull || cf! & ENTITY_CHANGED_BUILDING)) {
    // Wire field name is `solar` for legacy reasons; semantically the
    // shared BuildingActiveState open flag for solar / wind / extractor.
    if (sb.solar) {
      entity.building.activeState = {
        open: sb.solar.open,
        producing: entity.building.activeState?.producing ?? false,
        damageDelayMs: entity.building.activeState?.damageDelayMs ?? 0,
        reopenDelayMs: entity.building.activeState?.reopenDelayMs ?? 0,
      };
    } else if (
      isFull
      && (entity.buildingType === 'solar'
        || entity.buildingType === 'wind'
        || entity.buildingType === 'extractor')
    ) {
      entity.building.activeState = {
        open: entity.buildingType !== 'solar',
        producing: false,
        damageDelayMs: 0,
        reopenDelayMs: 0,
      };
    }
  }

  const sf = sb?.factory;
  if (entity.factory && sf && (isFull || cf! & ENTITY_CHANGED_FACTORY)) {
    const dst = entity.factory.buildQueue;
    const src = sf.queue;
    dst.length = 0;
    for (let i = 0; i < src.length; i++) {
      const unitType = codeToUnitType(src[i]);
      if (unitType) dst.push(unitType);
    }
    entity.factory.currentShellId = null;
    entity.factory.currentBuildProgress = sf.progress;
    entity.factory.isProducing = sf.producing;
    entity.factory.energyRateFraction = sf.energyRate ?? 0;
    entity.factory.metalRateFraction = sf.metalRate ?? 0;
    const wps = sf.waypoints;
    if (wps.length > 0) {
      entity.factory.rallyX = wps[0].pos.x;
      entity.factory.rallyY = wps[0].pos.y;
    }
    entity.factory.waypoints.length = Math.max(0, wps.length - 1);
    for (let i = 1; i < wps.length; i++) {
      entity.factory.waypoints[i - 1] = {
        x: wps[i].pos.x,
        y: wps[i].pos.y,
        z: wps[i].posZ,
        type: wps[i].type as 'move' | 'fight' | 'patrol',
      };
    }
  }

  return cacheDirty;
}
