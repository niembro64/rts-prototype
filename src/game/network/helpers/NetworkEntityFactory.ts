// Network entity creation helpers

import type { Entity, BuildingType, Turret, UnitAction } from '../../sim/types';
import type { NetworkServerSnapshotEntity, NetworkServerSnapshotTurret } from '../NetworkManager';
import { codeToActionType, codeToTurretState, codeToUnitType, codeToBuildingType, buildingTypeToCode, codeToProjectileType } from '../../../types/network';
import { getTurretConfig } from '../../sim/turretConfigs';
import { getUnitBlueprint, getUnitLocomotion } from '../../sim/blueprints';
import { getBuildingConfig } from '../../sim/buildConfigs';
import { GRID_CELL_SIZE } from '../../sim/grid';
import { buildMirrorPanelCache } from '../../sim/mirrorPanelCache';
import { createTurretsFromDefinition } from '../../sim/unitDefinitions';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function decodeNetworkUnitType(unitType: unknown): string {
  return isFiniteNumber(unitType) ? codeToUnitType(unitType) : 'jackal';
}

function decodeNetworkBuildingType(buildingType: unknown): BuildingType | null {
  if (!isFiniteNumber(buildingType)) return null;
  const decoded = codeToBuildingType(buildingType) as BuildingType;
  return buildingTypeToCode(decoded) === buildingType ? decoded : null;
}

function applyNetworkTurretState(turret: Turret, nw: NetworkServerSnapshotTurret): void {
  const wire = nw.turret;
  if (typeof wire.id === 'string' && wire.id !== turret.config.id) return;
  if (wire.ranges) {
    turret.ranges = {
      tracking: wire.ranges.tracking ? { ...wire.ranges.tracking } : null,
      fire: {
        min: wire.ranges.fire.min ? { ...wire.ranges.fire.min } : null,
        max: { ...wire.ranges.fire.max },
      },
    };
  }
  turret.target = nw.targetId ?? null;
  turret.state = codeToTurretState(nw.state);
  turret.rotation = wire.angular.rot;
  turret.pitch = wire.angular.pitch;
  turret.angularVelocity = wire.angular.vel;
  turret.pitchVelocity = 0;
  turret.turnAccel = wire.angular.acc;
  turret.drag = wire.angular.drag;
  turret.forceField = nw.currentForceFieldRange !== undefined && nw.currentForceFieldRange !== null
    ? { range: nw.currentForceFieldRange, transition: turret.forceField?.transition ?? 0 }
    : undefined;
}

export function createTurretsFromNetwork(
  unitType: string,
  bodyRadius: number,
  netTurrets: NetworkServerSnapshotTurret[] | undefined | null,
): Turret[] | undefined {
  if (!Array.isArray(netTurrets) || netTurrets.length === 0) return undefined;

  try {
    const canonical = createTurretsFromDefinition(unitType, bodyRadius);
    for (let i = 0; i < netTurrets.length && i < canonical.length; i++) {
      applyNetworkTurretState(canonical[i], netTurrets[i]);
    }
    return canonical;
  } catch {
    return undefined;
  }
}

export function refreshUnitTurretsFromNetwork(
  entity: Entity,
  unitType: string,
  bodyRadius: number,
  netTurrets: NetworkServerSnapshotTurret[] | undefined | null,
): void {
  const previous = entity.turrets;
  const turrets = createTurretsFromNetwork(unitType, bodyRadius, netTurrets);
  if (!turrets) {
    entity.turrets = undefined;
    return;
  }

  if (previous) {
    for (let i = 0; i < turrets.length && i < previous.length; i++) {
      const prev = previous[i];
      const next = turrets[i];
      next.cooldown = prev.cooldown;
      next.pitchVelocity = prev.pitchVelocity;
      next.barrelFireIndex = prev.barrelFireIndex;
      if (next.forceField && prev.forceField) {
        next.forceField.transition = prev.forceField.transition;
      }
    }
  }
  entity.turrets = turrets;
}

/**
 * Create an Entity from NetworkServerSnapshotEntity data
 */
export function createEntityFromNetwork(netEntity: NetworkServerSnapshotEntity): Entity | null {
  const { id, type, pos, rotation, playerId } = netEntity;

  if (type === 'unit') {
    return createUnitFromNetwork(netEntity, id, pos.x, pos.y, rotation, playerId);
  }

  if (type === 'building') {
    return createBuildingFromNetwork(netEntity, id, pos.x, pos.y, rotation, playerId);
  }

  if (type === 'shot') {
    return createProjectileFromNetwork(netEntity, id, pos.x, pos.y, rotation, playerId);
  }

  return null;
}

function createUnitFromNetwork(
  netEntity: NetworkServerSnapshotEntity,
  id: number,
  x: number,
  y: number,
  rotation: number,
  playerId: number
): Entity {
  const u = netEntity.unit;

  const actions: UnitAction[] = [];
  if (u?.actions) {
    for (let i = 0; i < u.actions.length; i++) {
      const na = u.actions[i];
      if (!na.pos) continue;
      actions.push({
        type: codeToActionType(na.type) as 'move' | 'patrol' | 'fight' | 'build' | 'repair' | 'attack',
        x: na.pos.x,
        y: na.pos.y,
        z: na.posZ,
        isPathExpansion: na.pathExp,
        targetId: na.targetId,
        buildingType: na.buildingType as BuildingType | undefined,
        gridX: na.grid?.x,
        gridY: na.grid?.y,
        buildingId: na.buildingId,
      });
    }
  }

  const defaultRadius = 15;
  const unitType = decodeNetworkUnitType(u?.unitType);
  const entity: Entity = {
    id,
    type: 'unit',
    transform: { x, y, z: netEntity.pos.z, rotation },
    ownership: { playerId },
    selectable: { selected: false },
    unit: {
      unitType,
      hp: u?.hp.curr ?? 100,
      maxHp: u?.hp.max ?? 100,
      unitRadiusCollider: {
        shot: u?.collider?.shot ?? defaultRadius,
        push: u?.collider?.push ?? defaultRadius,
      },
      bodyRadius: u?.bodyRadius ?? defaultRadius,
      bodyCenterHeight: u?.bodyCenterHeight ?? u?.collider?.push ?? defaultRadius,
      locomotion: getUnitLocomotion(unitType),
      mass: u?.mass ?? 25,
      actions,
      patrolStartIndex: null,
      velocityX: u?.velocity?.x ?? 0,
      velocityY: u?.velocity?.y ?? 0,
      velocityZ: u?.velocity?.z ?? 0,
      mirrorPanels: [],
      mirrorBoundRadius: 0,
    },
  };

  entity.turrets = createTurretsFromNetwork(unitType, entity.unit!.bodyRadius, u?.turrets);

  // Cache mirror panels for fast beam collision checks. Same helper
  // runs on the host (WorldState.createUnitFromBlueprint) so the
  // hydrated client and the authoritative sim share one rectangle.
  try {
    const bp = getUnitBlueprint(entity.unit!.unitType);
    entity.unit!.mirrorBoundRadius = buildMirrorPanelCache(
      bp, entity.unit!.mirrorPanels,
    );
  } catch { /* */ }

  if (u?.isCommander) {
    entity.commander = {
      isDGunActive: false,
      dgunEnergyCost: 100,
    };
    entity.builder = {
      buildRange: 200,
      maxEnergyUseRate: 50,
      currentBuildTarget: u.buildTargetId ?? null,
    };
  }

  return entity;
}

function createBuildingFromNetwork(
  netEntity: NetworkServerSnapshotEntity,
  id: number,
  x: number,
  y: number,
  rotation: number,
  playerId: number
): Entity | null {
  const b = netEntity.building;
  const buildingType = decodeNetworkBuildingType(b?.type);
  if (!b || !buildingType) return null;

  // Static building facts are blueprint-derived on the client. The
  // snapshot overlays only dynamic state (hp, build progress, factory
  // queue, solar open state, extraction rate).
  const config = getBuildingConfig(buildingType);
  const width = config.gridWidth * GRID_CELL_SIZE;
  const height = config.gridHeight * GRID_CELL_SIZE;
  const depth = config.gridDepth * GRID_CELL_SIZE;
  const entity: Entity = {
    id,
    type: 'building',
    transform: { x, y, z: netEntity.pos.z, rotation },
    ownership: { playerId },
    selectable: { selected: false },
    building: {
      width,
      height,
      depth,
      hp: b.hp?.curr ?? config.hp,
      maxHp: b.hp?.max ?? config.hp,
      targetRadius: Math.sqrt(width * width + height * height) / 2,
      solar: buildingType === 'solar'
        ? { open: b.solar?.open ?? false, producing: false, reopenDelayMs: 0 }
        : undefined,
    },
    buildable: {
      buildProgress: b.build?.progress ?? 1,
      isComplete: b.build?.complete ?? true,
      resourceCost: config.resourceCost,
      isGhost: false,
    },
    buildingType,
    metalExtractionRate: buildingType === 'extractor'
      ? b.metalExtractionRate ?? 0
      : undefined,
  };

  const f = b?.factory;
  if (f) {
    // waypoints[0] = rally point, rest = user-set waypoints
    const wps = f.waypoints;
    const rally = wps[0];
    const waypoints: { x: number; y: number; z?: number; type: 'move' | 'fight' | 'patrol' }[] = [];
    for (let i = 1; i < wps.length; i++) {
      const wp = wps[i];
      waypoints.push({ x: wp.pos.x, y: wp.pos.y, z: wp.posZ, type: wp.type as 'move' | 'fight' | 'patrol' });
    }
    entity.factory = {
      buildQueue: f.queue.map(codeToUnitType),
      currentBuildProgress: f.progress ?? 0,
      currentBuildResourceCost: 0,
      rallyX: rally?.pos.x ?? x,
      rallyY: rally?.pos.y ?? y + 100,
      isProducing: f.producing ?? false,
      waypoints,
    };
  }

  return entity;
}

function createProjectileFromNetwork(
  netEntity: NetworkServerSnapshotEntity,
  id: number,
  x: number,
  y: number,
  rotation: number,
  playerId: number
): Entity | null {
  const s = netEntity.shot;
  if (!s?.turretId) return null;

  let config: ReturnType<typeof getTurretConfig>;
  try {
    config = { ...getTurretConfig(s.turretId), turretIndex: s.turretIndex };
  } catch {
    return null;
  }

  if (config.shot.type === 'force') return null;

  const projectileType = s.type !== undefined
    ? codeToProjectileType(s.type)
    : config.shot.type;
  const maxLifespan = config.shot.type === 'beam'
    ? Infinity
    : config.shot.type === 'laser'
      ? config.shot.duration
      : config.shot.lifespan ?? 2000;

  return {
    id,
    type: 'shot',
    transform: { x, y, z: netEntity.pos.z, rotation },
    projectile: {
      ownerId: playerId,
      sourceEntityId: s?.source ?? 0,
      config,
      projectileType,
      velocityX: s?.velocity?.x ?? 0,
      velocityY: s?.velocity?.y ?? 0,
      velocityZ: s?.velocity?.z ?? 0,
      timeAlive: 0,
      maxLifespan,
      hitEntities: new Set(),
      maxHits: 1,
      points: netEntity.posEnd ? [
        { x, y, z: netEntity.pos.z, vx: 0, vy: 0, vz: 0 },
        {
          x: netEntity.posEnd.x,
          y: netEntity.posEnd.y,
          z: netEntity.posEnd.z,
          vx: 0, vy: 0, vz: 0,
        },
      ] : undefined,
    },
  };
}
