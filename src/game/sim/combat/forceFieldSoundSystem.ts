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
  if (!entity.turrets) return _forceFieldStopOwner;

  for (let i = 0; i < entity.turrets.length; i++) {
    const config = entity.turrets[i].config;
    if (!config.forceField) continue;

    _forceFieldStopOwner.push({
      type: 'forceFieldStop',
      turretId: config.id,
      pos: { x: entity.transform.x, y: entity.transform.y },
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
    if (!unit.turrets || !unit.unit || !unit.ownership) continue;

    const isDead = unit.unit.hp <= 0;

    for (let i = 0; i < unit.turrets.length; i++) {
      const weapon = unit.turrets[i];
      const config = weapon.config;
      if (!config.forceField) continue;

      const soundEntityId = unit.id * 100 + i;
      const progress = weapon.forceField?.transition ?? (weapon.forceField?.range ?? 0);

      if (isDead || progress <= 0) {
        _forceFieldSimEvents.push({
          type: 'forceFieldStop',
          turretId: config.id,
          pos: { x: unit.transform.x, y: unit.transform.y },
          entityId: soundEntityId,
        });
      } else {
        _forceFieldSimEvents.push({
          type: 'forceFieldStart',
          turretId: config.id,
          pos: { x: unit.transform.x, y: unit.transform.y },
          entityId: soundEntityId,
        });
      }
    }
  }

  return _forceFieldSimEvents;
}
