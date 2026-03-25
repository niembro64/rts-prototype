// Network entity creation helpers

import type { Entity, BuildingType, UnitAction } from '../../sim/types';
import type { NetworkServerSnapshotEntity } from '../NetworkManager';
import { getTurretConfig } from '../../sim/turretConfigs';
import { getUnitBlueprint, getTurretBlueprint } from '../../sim/blueprints';

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
        type: na.type as 'move' | 'patrol' | 'fight' | 'build' | 'repair' | 'attack',
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

  const radiusColliderUnitShot = u?.collider.unitShot ?? 15;
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
      radiusColliderUnitShot,
      radiusColliderUnitUnit: u?.collider.unitUnit ?? radiusColliderUnitShot,
      moveSpeed: u?.moveSpeed ?? 100,
      mass: u?.mass ?? 25,
      actions,
      patrolStartIndex: null,
      velocityX: u?.velocity.x ?? 0,
      velocityY: u?.velocity.y ?? 0,
      mirrorPanels: [],
      mirrorBoundRadius: 0,
    },
  };

  if (u?.turrets && u.turrets.length > 0) {
    const turrets = [];
    for (let i = 0; i < u.turrets.length; i++) {
      const nw = u.turrets[i];
      const t = nw.turret;
      turrets.push({
        config: getTurretConfig(t.id),
        cooldown: 0,
        target: nw.targetId ?? null,
        ranges: {
          tracking: { ...t.ranges.tracking },
          engage: { ...t.ranges.engage },
        },
        state: nw.state,
        rotation: t.angular.rot,
        angularVelocity: t.angular.vel,
        turnAccel: t.angular.acc,
        drag: t.angular.drag,
        offset: { x: t.pos.offset.x, y: t.pos.offset.y },
        forceField: nw.currentForceFieldRange !== undefined
          ? { range: nw.currentForceFieldRange, transition: 0 }
          : undefined,
      });
    }
    entity.turrets = turrets;
  }

  // Cache mirror panels for fast beam collision checks
  try {
    const bp = getUnitBlueprint(u?.unitType ?? 'jackal');
    for (const mount of bp.turrets) {
      const tb = getTurretBlueprint(mount.turretId);
      if (tb.mirrorPanels) {
        const panels = entity.unit!.mirrorPanels;
        let maxR = 0;
        for (const p of tb.mirrorPanels) {
          panels.push({
            halfWidth: p.width / 2,
            halfHeight: p.height / 2,
            offsetX: p.offsetX,
            offsetY: p.offsetY,
            angle: p.angle,
          });
          const dist = Math.sqrt(p.offsetX * p.offsetX + p.offsetY * p.offsetY) + p.width / 2;
          if (dist > maxR) maxR = dist;
        }
        entity.unit!.mirrorBoundRadius = maxR;
      }
    }
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
      manaCost: 0,
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
      currentBuildManaCost: 0,
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
): Entity {
  const s = netEntity.shot;

  return {
    id,
    type: 'shot',
    transform: { x, y, rotation },
    projectile: {
      ownerId: playerId,
      sourceEntityId: s?.source ?? 0,
      config: s?.turretId
        ? { ...getTurretConfig(s.turretId), turretIndex: s.turretIndex }
        : {
          id: 'unknown',
          angular: { turnAccel: 0, drag: 0 },
          shot: { type: 'projectile' as const, id: 'unknown', mass: 1, launchForce: 100, collision: { radius: 5, damage: 10 } },
          range: 100,
          cooldown: 1000,
        },
      projectileType: (s?.type as 'projectile' | 'beam' | 'laser') ?? 'projectile',
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
