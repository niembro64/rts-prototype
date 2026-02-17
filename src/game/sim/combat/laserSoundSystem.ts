// Laser sound system - manages continuous beam weapon audio

import type { WorldState } from '../WorldState';
import type { AudioEvent } from './types';
import { distance, getTargetRadius } from './combatUtils';
import { getWeaponWorldPosition } from '../../math';

// Reusable array for laser sound events (avoids per-frame allocation)
const _laserAudioEvents: AudioEvent[] = [];

// Update laser sounds based on targeting state (not beam existence)
// This is called every frame to ensure sounds match targeting state
export function updateLaserSounds(world: WorldState): AudioEvent[] {
  _laserAudioEvents.length = 0;
  const audioEvents = _laserAudioEvents;

  for (const unit of world.getUnits()) {
    if (!unit.weapons || !unit.unit || !unit.ownership) continue;
    if (unit.unit.hp <= 0) continue;

    const cos = unit.transform.rotCos ?? Math.cos(unit.transform.rotation);
    const sin = unit.transform.rotSin ?? Math.sin(unit.transform.rotation);

    // Check each weapon for beam sounds
    for (let i = 0; i < unit.weapons.length; i++) {
      const weapon = unit.weapons[i];
      const config = weapon.config;
      const isBeamWeapon = config.beamDuration !== undefined && config.cooldown === 0;

      if (!isBeamWeapon) continue;

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

      // Use unique entity ID based on unit ID and weapon index
      const soundEntityId = unit.id * 100 + i;

      if (hasTargetInRange) {
        audioEvents.push({
          type: 'laserStart',
          weaponId: config.audioId,
          x: unit.transform.x,
          y: unit.transform.y,
          entityId: soundEntityId,
        });
      } else {
        audioEvents.push({
          type: 'laserStop',
          weaponId: config.audioId,
          x: unit.transform.x,
          y: unit.transform.y,
          entityId: soundEntityId,
        });
      }
    }
  }

  return audioEvents;
}
