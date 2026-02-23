// Laser sound system - manages continuous beam weapon audio

import type { WorldState } from '../WorldState';
import type { Entity, EntityId } from '../types';
import type { SimEvent } from './types';
import { distance, getTargetRadius } from './combatUtils';
import { getWeaponWorldPosition, getTransformCosSin } from '../../math';

// Reusable array for laser sound events (avoids per-frame allocation)
const _laserSimEvents: SimEvent[] = [];
const _laserStopOwner: SimEvent[] = [];
const _laserStopTarget: SimEvent[] = [];

// Emit laserStop events for all beam weapons on a dying entity (the beam owner).
// Must be called before the entity is removed from the world.
export function emitLaserStopsForEntity(entity: Entity): SimEvent[] {
  _laserStopOwner.length = 0;
  if (!entity.turrets) return _laserStopOwner;

  for (let i = 0; i < entity.turrets.length; i++) {
    const config = entity.turrets[i].config;
    if (config.shot?.beam !== undefined && config.cooldown === 0) {
      _laserStopOwner.push({
        type: 'laserStop',
        turretId: config.id,
        pos: { x: entity.transform.x, y: entity.transform.y },
        entityId: entity.id * 100 + i,
      });
    }
  }
  return _laserStopOwner;
}

// Emit laserStop events for all beam weapons across the world that were targeting a dying entity.
// This ensures sounds stop immediately when the target dies rather than waiting for retarget.
export function emitLaserStopsForTarget(world: WorldState, targetId: EntityId): SimEvent[] {
  _laserStopTarget.length = 0;

  for (const unit of world.getUnits()) {
    if (!unit.turrets || !unit.unit || unit.unit.hp <= 0) continue;

    for (let i = 0; i < unit.turrets.length; i++) {
      const weapon = unit.turrets[i];
      if (weapon.target !== targetId) continue;
      const config = weapon.config;
      if (config.shot?.beam === undefined || config.cooldown !== 0) continue;

      _laserStopTarget.push({
        type: 'laserStop',
        turretId: config.id,
        pos: { x: unit.transform.x, y: unit.transform.y },
        entityId: unit.id * 100 + i,
      });
    }
  }
  return _laserStopTarget;
}

// Update laser sounds based on targeting state (not beam existence)
// This is called every frame to ensure sounds match targeting state
export function updateLaserSounds(world: WorldState): SimEvent[] {
  _laserSimEvents.length = 0;
  const audioEvents = _laserSimEvents;

  for (const unit of world.getUnits()) {
    if (!unit.turrets || !unit.unit || !unit.ownership) continue;

    // Dead units must still emit laserStop so the client releases audio nodes
    const isDead = unit.unit.hp <= 0;

    const { cos, sin } = getTransformCosSin(unit.transform);

    // Check each weapon for beam sounds
    for (let i = 0; i < unit.turrets.length; i++) {
      const weapon = unit.turrets[i];
      const config = weapon.config;
      const isBeamWeapon = config.shot?.beam !== undefined && config.cooldown === 0;

      if (!isBeamWeapon) continue;

      // Use unique entity ID based on unit ID and weapon index
      const soundEntityId = unit.id * 100 + i;

      // Dead units always get laserStop
      if (isDead) {
        audioEvents.push({
          type: 'laserStop',
          turretId: config.id,
          pos: { x: unit.transform.x, y: unit.transform.y },
          entityId: soundEntityId,
        });
        continue;
      }

      // Check if weapon has a valid target in weapon's fire range
      let hasTargetInRange = false;
      if (weapon.target !== null) {
        const target = world.getEntity(weapon.target);
        if (target) {
          const targetIsUnit = target.unit && target.unit.hp > 0;
          const targetIsBuilding = target.building && target.building.hp > 0;
          if (targetIsUnit || targetIsBuilding) {
            // Calculate weapon position
            const wp = getWeaponWorldPosition(unit.transform.x, unit.transform.y, cos, sin, weapon.offset.x, weapon.offset.y);
            const weaponX = wp.x;
            const weaponY = wp.y;
            const dist = distance(weaponX, weaponY, target.transform.x, target.transform.y);
            const targetRadius = getTargetRadius(target);
            hasTargetInRange = dist <= weapon.ranges.engage.acquire + targetRadius;
          }
        }
      }

      if (hasTargetInRange) {
        audioEvents.push({
          type: 'laserStart',
          turretId: config.id,
          pos: { x: unit.transform.x, y: unit.transform.y },
          entityId: soundEntityId,
        });
      } else {
        audioEvents.push({
          type: 'laserStop',
          turretId: config.id,
          pos: { x: unit.transform.x, y: unit.transform.y },
          entityId: soundEntityId,
        });
      }
    }
  }

  return audioEvents;
}
