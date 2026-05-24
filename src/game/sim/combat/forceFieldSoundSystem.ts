// Force field sound system - manages continuous force field weapon audio
// Mirrors laserSoundSystem.ts pattern: emits forceFieldStart/forceFieldStop lifecycle events

import type { Entity } from '../types';
import type { SimEvent } from './types';

// Reusable arrays for force field sound events (avoids per-frame allocation)
const _forceFieldSimEvents: SimEvent[] = [];
const _forceFieldStopOwner: SimEvent[] = [];
const FORCE_FIELD_SOUND_REFRESH_TICKS = 60;
const activeForceFieldSoundIds = new Set<number>();
let forceFieldSoundRefreshTick = 0;

// Emit forceFieldStop events for all force field weapons on a dying entity.
// Must be called before the entity is removed from the world.
export function emitForceFieldStopsForEntity(entity: Entity): SimEvent[] {
  _forceFieldStopOwner.length = 0;
  if (entity.combat === null) return _forceFieldStopOwner;
  const turrets = entity.combat.turrets;

  for (let i = 0; i < turrets.length; i++) {
    const config = turrets[i].config;
    const shot = config.shot;
    if (shot === undefined || shot.type !== 'force') continue;

    const soundEntityId = entity.id * 100 + i;
    if (!activeForceFieldSoundIds.delete(soundEntityId)) continue;
    _forceFieldStopOwner.push({
      type: 'forceFieldStop',
      turretId: config.id,
      pos: { x: entity.transform.x, y: entity.transform.y, z: entity.transform.z },
      entityId: soundEntityId,
    });
  }
  return _forceFieldStopOwner;
}

// Update force field sounds based on transition progress
// Emits forceFieldStart when progress > 0, forceFieldStop when progress === 0 or unit is dead
export function updateForceFieldSounds(units: Entity[]): SimEvent[] {
  _forceFieldSimEvents.length = 0;
  forceFieldSoundRefreshTick++;
  const shouldRefreshActive = forceFieldSoundRefreshTick % FORCE_FIELD_SOUND_REFRESH_TICKS === 0;

  for (const unit of units) {
    if (!unit.combat || !unit.unit || !unit.ownership) continue;

    const isDead = unit.unit.hp <= 0;

    const turrets = unit.combat.turrets;
    for (let i = 0; i < turrets.length; i++) {
      const weapon = turrets[i];
      const config = weapon.config;
      const shot = config.shot;
      if (shot === undefined || shot.type !== 'force') continue;

      const soundEntityId = unit.id * 100 + i;
      const progress = weapon.forceField !== undefined ? weapon.forceField.transition : 0;
      const wasActive = activeForceFieldSoundIds.has(soundEntityId);

      if (isDead || progress <= 0) {
        if (!activeForceFieldSoundIds.delete(soundEntityId)) continue;
        _forceFieldSimEvents.push({
          type: 'forceFieldStop',
          turretId: config.id,
          pos: { x: unit.transform.x, y: unit.transform.y, z: unit.transform.z },
          playerId: unit.ownership.playerId,
          entityId: soundEntityId,
        });
      } else {
        if (!wasActive) activeForceFieldSoundIds.add(soundEntityId);
        if (!wasActive || shouldRefreshActive) {
          _forceFieldSimEvents.push({
            type: 'forceFieldStart',
            turretId: config.id,
            pos: { x: unit.transform.x, y: unit.transform.y, z: unit.transform.z },
            playerId: unit.ownership.playerId,
            entityId: soundEntityId,
          });
        }
      }
    }
  }

  return _forceFieldSimEvents;
}

export function resetForceFieldSoundState(): void {
  activeForceFieldSoundIds.clear();
  forceFieldSoundRefreshTick = 0;
}
