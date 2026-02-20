// Force field sound system - manages continuous force field weapon audio
// Mirrors laserSoundSystem.ts pattern: emits forceFieldStart/forceFieldStop lifecycle events

import type { Entity } from '../types';
import type { SimEvent } from './types';

// Reusable arrays for force field sound events (avoids per-frame allocation)
const _forceFieldSimEvents: SimEvent[] = [];
const _forceFieldStopOwner: SimEvent[] = [];

// Emit forceFieldStop events for all force field weapons on a dying entity.
// Must be called before the entity is removed from the world.
export function emitForceFieldStopsForEntity(entity: Entity): SimEvent[] {
  _forceFieldStopOwner.length = 0;
  if (!entity.weapons) return _forceFieldStopOwner;

  for (let i = 0; i < entity.weapons.length; i++) {
    const config = entity.weapons[i].config;
    if (!config.isForceField) continue;

    _forceFieldStopOwner.push({
      type: 'forceFieldStop',
      weaponId: config.id,
      x: entity.transform.x,
      y: entity.transform.y,
      entityId: entity.id * 100 + i,
    });
  }
  return _forceFieldStopOwner;
}

// Update force field sounds based on transition progress
// Emits forceFieldStart when progress > 0, forceFieldStop when progress === 0 or unit is dead
export function updateForceFieldSounds(units: Entity[]): SimEvent[] {
  _forceFieldSimEvents.length = 0;

  for (const unit of units) {
    if (!unit.weapons || !unit.unit || !unit.ownership) continue;

    const isDead = unit.unit.hp <= 0;

    for (let i = 0; i < unit.weapons.length; i++) {
      const weapon = unit.weapons[i];
      const config = weapon.config;
      if (!config.isForceField) continue;

      const soundEntityId = unit.id * 100 + i;
      const progress = weapon.forceFieldTransitionProgress ?? (weapon.currentForceFieldRange ?? 0);

      if (isDead || progress <= 0) {
        _forceFieldSimEvents.push({
          type: 'forceFieldStop',
          weaponId: config.id,
          x: unit.transform.x,
          y: unit.transform.y,
          entityId: soundEntityId,
        });
      } else {
        _forceFieldSimEvents.push({
          type: 'forceFieldStart',
          weaponId: config.id,
          x: unit.transform.x,
          y: unit.transform.y,
          entityId: soundEntityId,
        });
      }
    }
  }

  return _forceFieldSimEvents;
}
