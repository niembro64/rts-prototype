// Network entity creation helpers

import type { Entity, BuildingType, UnitAction } from '../../sim/types';
import type { NetworkEntity } from '../NetworkManager';
import { getWeaponConfig } from '../../sim/weapons';

/**
 * Create an Entity from NetworkEntity data
 */
export function createEntityFromNetwork(netEntity: NetworkEntity): Entity | null {
  const { id, type, x, y, rotation, playerId } = netEntity;

  if (type === 'unit') {
    return createUnitFromNetwork(netEntity, id, x, y, rotation, playerId);
  }

  if (type === 'building') {
    return createBuildingFromNetwork(netEntity, id, x, y, rotation, playerId);
  }

  if (type === 'projectile') {
    return createProjectileFromNetwork(netEntity, id, x, y, rotation, playerId);
  }

  return null;
}

function createUnitFromNetwork(
  netEntity: NetworkEntity,
  id: number,
  x: number,
  y: number,
  rotation: number,
  playerId?: number
): Entity {
  const actions: UnitAction[] = [];
  if (netEntity.actions) {
    for (let i = 0; i < netEntity.actions.length; i++) {
      const na = netEntity.actions[i];
      if (na.x === undefined || na.y === undefined) continue;
      actions.push({
        type: na.type as 'move' | 'patrol' | 'fight' | 'build' | 'repair',
        x: na.x,
        y: na.y,
        targetId: na.targetId,
        buildingType: na.buildingType as BuildingType | undefined,
        gridX: na.gridX,
        gridY: na.gridY,
        buildingId: na.buildingId,
      });
    }
  }

  const entity: Entity = {
    id,
    type: 'unit',
    transform: { x, y, rotation },
    ownership: playerId !== undefined ? { playerId } : undefined,
    selectable: { selected: false },
    unit: {
      unitType: netEntity.unitType ?? 'jackal',
      hp: netEntity.hp ?? 100,
      maxHp: netEntity.maxHp ?? 100,
      collisionRadius: netEntity.collisionRadius ?? 15,
      physicsRadius: netEntity.physicsRadius ?? netEntity.collisionRadius ?? 15,
      moveSpeed: netEntity.moveSpeed ?? 100,
      mass: netEntity.mass ?? 25,
      actions,
      patrolStartIndex: null,
      velocityX: netEntity.velocityX ?? 0,
      velocityY: netEntity.velocityY ?? 0,
    },
  };

  if (netEntity.weapons && netEntity.weapons.length > 0) {
    const weapons = [];
    for (let i = 0; i < netEntity.weapons.length; i++) {
      const nw = netEntity.weapons[i];
      weapons.push({
        config: getWeaponConfig(nw.configId),
        currentCooldown: 0,
        targetEntityId: nw.targetId ?? null,
        seeRange: nw.seeRange,
        fireRange: nw.fireRange,
        releaseRange: nw.releaseRange,
        lockRange: nw.lockRange,
        fightstopRange: nw.fightstopRange,
        isLocked: false,
        turretRotation: nw.turretRotation,
        turretAngularVelocity: nw.turretAngularVelocity,
        turretTurnAccel: nw.turretTurnAccel,
        turretDrag: nw.turretDrag,
        offsetX: nw.offsetX,
        offsetY: nw.offsetY,
        isFiring: nw.isFiring,
        inFightstopRange: nw.inFightstopRange,
        currentForceFieldRange: nw.currentForceFieldRange,
      });
    }
    entity.weapons = weapons;
  }

  if (netEntity.isCommander) {
    entity.commander = {
      isDGunActive: false,
      dgunEnergyCost: 100,
    };
    entity.builder = {
      buildRange: 200,
      currentBuildTarget: netEntity.buildTargetId ?? null,
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
  playerId?: number
): Entity {
  const entity: Entity = {
    id,
    type: 'building',
    transform: { x, y, rotation },
    ownership: playerId !== undefined ? { playerId } : undefined,
    selectable: { selected: false },
    building: {
      width: netEntity.width ?? 100,
      height: netEntity.height ?? 100,
      hp: netEntity.hp ?? 500,
      maxHp: netEntity.maxHp ?? 500,
    },
    buildable: {
      buildProgress: netEntity.buildProgress ?? 1,
      isComplete: netEntity.isComplete ?? true,
      energyCost: 100,
      isGhost: false,
    },
    buildingType: netEntity.buildingType as BuildingType | undefined,
  };

  if (netEntity.buildQueue !== undefined) {
    const waypoints: { x: number; y: number; type: 'move' | 'fight' | 'patrol' }[] = [];
    if (netEntity.factoryWaypoints) {
      for (let i = 0; i < netEntity.factoryWaypoints.length; i++) {
        const wp = netEntity.factoryWaypoints[i];
        waypoints.push({ x: wp.x, y: wp.y, type: wp.type as 'move' | 'fight' | 'patrol' });
      }
    }
    entity.factory = {
      buildQueue: netEntity.buildQueue,
      currentBuildProgress: netEntity.factoryProgress ?? 0,
      currentBuildCost: 0,
      rallyX: netEntity.rallyX ?? x,
      rallyY: netEntity.rallyY ?? y + 100,
      isProducing: netEntity.isProducing ?? false,
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
  playerId?: number
): Entity {
  return {
    id,
    type: 'projectile',
    transform: { x, y, rotation },
    projectile: {
      ownerId: playerId ?? 1,
      sourceEntityId: netEntity.sourceEntityId ?? 0,
      config: netEntity.weaponId
        ? { ...getWeaponConfig(netEntity.weaponId), weaponIndex: netEntity.weaponIndex }
        : {
          id: 'unknown',
          damage: 10,
          range: 100,
          cooldown: 1000,
        },
      projectileType: (netEntity.projectileType as 'instant' | 'traveling' | 'beam') ?? 'traveling',
      velocityX: netEntity.velocityX ?? 0,
      velocityY: netEntity.velocityY ?? 0,
      timeAlive: 0,
      maxLifespan: 2000,
      hitEntities: new Set(),
      maxHits: 1,
      startX: netEntity.beamStartX,
      startY: netEntity.beamStartY,
      endX: netEntity.beamEndX,
      endY: netEntity.beamEndY,
    },
  };
}
