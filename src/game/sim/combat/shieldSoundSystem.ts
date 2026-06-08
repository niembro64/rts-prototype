// Shield sound system - manages continuous shield weapon audio
// Mirrors laserSoundSystem.ts pattern: emits shieldStart/shieldStop lifecycle events

import type { Entity } from '../types';
import { NO_ENTITY_ID, type EntityId } from '../types';
import type { SimEvent } from './types';

// Reusable arrays for shield sound events (avoids per-frame allocation)
const _shieldSimEvents: SimEvent[] = [];
const _shieldStopOwner: SimEvent[] = [];
const SHIELD_SOUND_REFRESH_TICKS = 60;
const activeShieldSoundIds = new Set<number>();
let shieldSoundRefreshTick = 0;

function turretSoundEntityId(entity: Entity, weaponIndex: number): EntityId {
  const turret = entity.combat?.turrets[weaponIndex];
  return turret !== undefined && turret.id !== NO_ENTITY_ID
    ? turret.id
    : entity.id * 100 + weaponIndex;
}

// Emit shieldStop events for all shield weapons on a dying entity.
// Must be called before the entity is removed from the world.
export function emitShieldStopsForEntity(entity: Entity): SimEvent[] {
  _shieldStopOwner.length = 0;
  if (entity.combat === null) return _shieldStopOwner;
  const turrets = entity.combat.turrets;

  for (let i = 0; i < turrets.length; i++) {
    const config = turrets[i].config;
    const shot = config.shot;
    if (shot === null || shot.type !== 'shield' || shot.barrier === undefined) continue;

    const soundEntityId = turretSoundEntityId(entity, i);
    if (!activeShieldSoundIds.delete(soundEntityId)) continue;
    _shieldStopOwner.push({
      type: 'shieldStop',
      turretBlueprintId: config.turretBlueprintId,
      pos: { x: entity.transform.x, y: entity.transform.y, z: entity.transform.z },
      entityId: soundEntityId,
    });
  }
  return _shieldStopOwner;
}

// Update shield sounds based on transition progress
// Emits shieldStart when progress > 0, shieldStop when progress === 0 or unit is dead
export function updateShieldSounds(units: Entity[]): SimEvent[] {
  _shieldSimEvents.length = 0;
  shieldSoundRefreshTick++;
  const shouldRefreshActive = shieldSoundRefreshTick % SHIELD_SOUND_REFRESH_TICKS === 0;

  for (const unit of units) {
    if (!unit.combat || !unit.unit || !unit.ownership) continue;

    const isDead = unit.unit.hp <= 0;

    const turrets = unit.combat.turrets;
    for (let i = 0; i < turrets.length; i++) {
      const weapon = turrets[i];
      const config = weapon.config;
      const shot = config.shot;
      if (shot === null || shot.type !== 'shield' || shot.barrier === undefined) continue;

      const soundEntityId = turretSoundEntityId(unit, i);
      const progress = weapon.shield !== null ? weapon.shield.transition : 0;
      const wasActive = activeShieldSoundIds.has(soundEntityId);

      if (isDead || progress <= 0) {
        if (!activeShieldSoundIds.delete(soundEntityId)) continue;
        _shieldSimEvents.push({
          type: 'shieldStop',
          turretBlueprintId: config.turretBlueprintId,
          pos: { x: unit.transform.x, y: unit.transform.y, z: unit.transform.z },
          playerId: unit.ownership.playerId,
          entityId: soundEntityId,
        });
      } else {
        if (!wasActive) activeShieldSoundIds.add(soundEntityId);
        if (!wasActive || shouldRefreshActive) {
          _shieldSimEvents.push({
            type: 'shieldStart',
            turretBlueprintId: config.turretBlueprintId,
            pos: { x: unit.transform.x, y: unit.transform.y, z: unit.transform.z },
            playerId: unit.ownership.playerId,
            entityId: soundEntityId,
          });
        }
      }
    }
  }

  return _shieldSimEvents;
}

export function resetShieldSoundState(): void {
  activeShieldSoundIds.clear();
  shieldSoundRefreshTick = 0;
}
