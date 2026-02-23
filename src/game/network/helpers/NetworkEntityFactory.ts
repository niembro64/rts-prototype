// Network entity creation helpers

import type { Entity, BuildingType, UnitAction } from '../../sim/types';
import type { NetworkEntity } from '../NetworkManager';
import { getWeaponConfig } from '../../sim/weapons';

/**
 * Create an Entity from NetworkEntity data
 */
export function createEntityFromNetwork(netEntity: NetworkEntity): Entity | null {
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
  netEntity: NetworkEntity,
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
        type: na.type as 'move' | 'patrol' | 'fight' | 'build' | 'repair',
        x: na.pos.x,
        y: na.pos.y,
        targetId: na.targetId,
        buildingType: na.buildingType as BuildingType | undefined,
        gridX: na.grid?.x,
        gridY: na.grid?.y,
        buildingId: na.buildingId,
      });
    }
  }

  const drawScale = u?.drawScale ?? 15;
  const entity: Entity = {
    id,
    type: 'unit',
    transform: { x, y, rotation },
    ownership: { playerId },
    selectable: { selected: false },
    unit: {
      unitType: u?.unitType ?? 'jackal',
      hp: u?.hp.curr ?? 100,
      maxHp: u?.hp.max ?? 100,
      drawScale,
      radiusColliderUnitShot: u?.collider.unitShot ?? drawScale,
      radiusColliderUnitUnit: u?.collider.unitUnit ?? drawScale,
      moveSpeed: u?.moveSpeed ?? 100,
      mass: u?.mass ?? 25,
      actions,
      patrolStartIndex: null,
      velocityX: u?.velocity.x ?? 0,
      velocityY: u?.velocity.y ?? 0,
    },
  };

  if (u?.weapons && u.weapons.length > 0) {
    const weapons = [];
    for (let i = 0; i < u.weapons.length; i++) {
      const nw = u.weapons[i];
      const t = nw.turret;
      weapons.push({
        config: getWeaponConfig(t.id),
        currentCooldown: 0,
        targetEntityId: nw.targetId ?? null,
        ranges: {
          tracking: { ...t.ranges.tracking },
          engage: { ...t.ranges.engage },
        },
        isTracking: nw.isTracking,
        isEngaged: nw.isEngaged,
        turretRotation: t.angular.rot,
        turretAngularVelocity: t.angular.vel,
        turretTurnAccel: t.angular.acc,
        turretDrag: t.angular.drag,
        offsetX: t.pos.offset.x,
        offsetY: t.pos.offset.y,
        currentForceFieldRange: nw.currentForceFieldRange,
      });
    }
    entity.weapons = weapons;
  }

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
  netEntity: NetworkEntity,
  id: number,
  x: number,
  y: number,
  rotation: number,
  playerId: number
): Entity {
  const b = netEntity.building;

  const entity: Entity = {
    id,
    type: 'building',
    transform: { x, y, rotation },
    ownership: { playerId },
    selectable: { selected: false },
    building: {
      width: b?.dim.x ?? 100,
      height: b?.dim.y ?? 100,
      hp: b?.hp.curr ?? 500,
      maxHp: b?.hp.max ?? 500,
    },
    buildable: {
      buildProgress: b?.build.progress ?? 1,
      isComplete: b?.build.complete ?? true,
      energyCost: 100,
      isGhost: false,
    },
    buildingType: b?.type as BuildingType | undefined,
  };

  const f = b?.factory;
  if (f) {
    // waypoints[0] = rally point, rest = user-set waypoints
    const wps = f.waypoints;
    const rally = wps[0];
    const waypoints: { x: number; y: number; type: 'move' | 'fight' | 'patrol' }[] = [];
    for (let i = 1; i < wps.length; i++) {
      const wp = wps[i];
      waypoints.push({ x: wp.pos.x, y: wp.pos.y, type: wp.type as 'move' | 'fight' | 'patrol' });
    }
    entity.factory = {
      buildQueue: f.queue,
      currentBuildProgress: f.progress ?? 0,
      currentBuildCost: 0,
      rallyX: rally?.pos.x ?? x,
      rallyY: rally?.pos.y ?? y + 100,
      isProducing: f.producing ?? false,
      waypoints,
    };
  }

  return entity;
}

function createProjectileFromNetwork(
  netEntity: NetworkEntity,
  id: number,
  x: number,
  y: number,
  rotation: number,
  playerId: number
): Entity {
  const s = netEntity.shot;

  return {
    id,
    type: 'shot',
    transform: { x, y, rotation },
    projectile: {
      ownerId: playerId,
      sourceEntityId: s?.source ?? 0,
      config: s?.weaponId
        ? { ...getWeaponConfig(s.weaponId), weaponIndex: s.weaponIndex }
        : {
          id: 'unknown',
          collision: { radius: 5, damage: 10 },
          range: 100,
          cooldown: 1000,
        },
      projectileType: (s?.type as 'instant' | 'traveling' | 'beam') ?? 'traveling',
      velocityX: s?.velocity?.x ?? 0,
      velocityY: s?.velocity?.y ?? 0,
      timeAlive: 0,
      maxLifespan: 2000,
      hitEntities: new Set(),
      maxHits: 1,
      startX: x,
      startY: y,
      endX: netEntity.posEnd?.x,
      endY: netEntity.posEnd?.y,
    },
  };
}
