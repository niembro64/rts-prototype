// Laser sound system - manages continuous beam weapon audio

import type { WorldState } from '../WorldState';
import type { Entity, EntityId } from '../types';
import type { AudioEvent } from './types';
import { distance, getTargetRadius } from './combatUtils';
import { getWeaponWorldPosition } from '../../math';

// Reusable array for laser sound events (avoids per-frame allocation)
const _laserAudioEvents: AudioEvent[] = [];
const _laserStopOwner: AudioEvent[] = [];
const _laserStopTarget: AudioEvent[] = [];

// Emit laserStop events for all beam weapons on a dying entity (the beam owner).
// Must be called before the entity is removed from the world.
export function emitLaserStopsForEntity(entity: Entity): AudioEvent[] {
  _laserStopOwner.length = 0;
  if (!entity.weapons) return _laserStopOwner;

  for (let i = 0; i < entity.weapons.length; i++) {
    const config = entity.weapons[i].config;
    if (config.beamDuration !== undefined && config.cooldown === 0) {
      _laserStopOwner.push({
        type: 'laserStop',
        weaponId: config.id,
        x: entity.transform.x,
        y: entity.transform.y,
        entityId: entity.id * 100 + i,
      });
    }
  }
  return _laserStopOwner;
}

// Emit laserStop events for all beam weapons across the world that were targeting a dying entity.
// This ensures sounds stop immediately when the target dies rather than waiting for retarget.
export function emitLaserStopsForTarget(world: WorldState, targetId: EntityId): AudioEvent[] {
  _laserStopTarget.length = 0;

  for (const unit of world.getUnits()) {
    if (!unit.weapons || !unit.unit || unit.unit.hp <= 0) continue;

    for (let i = 0; i < unit.weapons.length; i++) {
      const weapon = unit.weapons[i];
      if (weapon.targetEntityId !== targetId) continue;
      const config = weapon.config;
      if (config.beamDuration === undefined || config.cooldown !== 0) continue;

      _laserStopTarget.push({
        type: 'laserStop',
        weaponId: config.id,
        x: unit.transform.x,
        y: unit.transform.y,
        entityId: unit.id * 100 + i,
      });
    }
  }
  return _laserStopTarget;
}

// Update laser sounds based on targeting state (not beam existence)
// This is called every frame to ensure sounds match targeting state
export function updateLaserSounds(world: WorldState): AudioEvent[] {
  _laserAudioEvents.length = 0;
  const audioEvents = _laserAudioEvents;

  for (const unit of world.getUnits()) {
    if (!unit.weapons || !unit.unit || !unit.ownership) continue;

    // Dead units must still emit laserStop so the client releases audio nodes
    const isDead = unit.unit.hp <= 0;

    const cos = unit.transform.rotCos ?? Math.cos(unit.transform.rotation);
    const sin = unit.transform.rotSin ?? Math.sin(unit.transform.rotation);

    // Check each weapon for beam sounds
    for (let i = 0; i < unit.weapons.length; i++) {
      const weapon = unit.weapons[i];
      const config = weapon.config;
      const isBeamWeapon = config.beamDuration !== undefined && config.cooldown === 0;

      if (!isBeamWeapon) continue;

      // Use unique entity ID based on unit ID and weapon index
      const soundEntityId = unit.id * 100 + i;

      // Dead units always get laserStop
      if (isDead) {
        audioEvents.push({
          type: 'laserStop',
          weaponId: config.id,
          x: unit.transform.x,
          y: unit.transform.y,
          entityId: soundEntityId,
        });
        continue;
      }

      // Check if weapon has a valid target in weapon's fire range
      let hasTargetInRange = false;
      if (weapon.targetEntityId !== null) {
        const target = world.getEntity(weapon.targetEntityId);
        if (target) {
          const targetIsUnit = target.unit && target.unit.hp > 0;
          const targetIsBuilding = target.building && target.building.hp > 0;
          if (targetIsUnit || targetIsBuilding) {
            // Calculate weapon position
            const wp = getWeaponWorldPosition(unit.transform.x, unit.transform.y, cos, sin, weapon.offsetX, weapon.offsetY);
            const weaponX = wp.x;
            const weaponY = wp.y;
            const dist = distance(weaponX, weaponY, target.transform.x, target.transform.y);
            const targetRadius = getTargetRadius(target);
            hasTargetInRange = dist <= weapon.fireRange + targetRadius;
          }
        }
      }

      if (hasTargetInRange) {
        audioEvents.push({
          type: 'laserStart',
          weaponId: config.id,
          x: unit.transform.x,
          y: unit.transform.y,
          entityId: soundEntityId,
        });
      } else {
        audioEvents.push({
          type: 'laserStop',
          weaponId: config.id,
          x: unit.transform.x,
          y: unit.transform.y,
          entityId: soundEntityId,
        });
      }
    }
  }

  return audioEvents;
}
