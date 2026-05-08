// Laser sound system - manages continuous beam weapon audio

import type { WorldState } from '../WorldState';
import type { Entity, EntityId } from '../types';
import type { SimEvent } from './types';
import { getBeamWeaponsTargeting } from './targetIndex';

// Reusable array for laser sound events (avoids per-frame allocation)
const _laserSimEvents: SimEvent[] = [];
const _laserStopOwner: SimEvent[] = [];
const _laserStopTarget: SimEvent[] = [];

// Emit laserStop events for all beam weapons on a dying entity (the beam owner).
// Must be called before the entity is removed from the world.
export function emitLaserStopsForEntity(entity: Entity): SimEvent[] {
  _laserStopOwner.length = 0;
  const turrets = entity.combat?.turrets;
  if (!turrets) return _laserStopOwner;

  for (let i = 0; i < turrets.length; i++) {
    const config = turrets[i].config;
    if (config.shot?.type === 'beam') {
      _laserStopOwner.push({
        type: 'laserStop',
        turretId: config.id,
        pos: { x: entity.transform.x, y: entity.transform.y, z: entity.transform.z },
        entityId: entity.id * 100 + i,
      });
    }
  }
  return _laserStopOwner;
}

// Emit laserStop events for all beam weapons across the world that were targeting a dying entity.
// This ensures sounds stop immediately when the target dies rather than waiting for retarget.
//
// Reads the inverse target index (targetIndex.ts) instead of scanning every
// unit × every turret on each death — at 1000 units × 8 turrets the old scan
// was the dominant cost during battle peaks.
export function emitLaserStopsForTarget(_world: WorldState, targetId: EntityId): SimEvent[] {
  _laserStopTarget.length = 0;
  const refs = getBeamWeaponsTargeting(targetId);
  for (let r = 0; r < refs.length; r++) {
    const { unit, weaponIndex } = refs[r];
    if (!unit.combat || !unit.unit || unit.unit.hp <= 0) continue;
    const weapon = unit.combat.turrets[weaponIndex];
    if (!weapon || weapon.target !== targetId) continue;
    const config = weapon.config;
    if (config.shot?.type !== 'beam') continue;
    _laserStopTarget.push({
      type: 'laserStop',
      turretId: config.id,
      pos: { x: unit.transform.x, y: unit.transform.y, z: unit.transform.z },
      entityId: unit.id * 100 + weaponIndex,
    });
  }
  return _laserStopTarget;
}

// Update laser sounds based on targeting state (not beam existence)
// This is called every frame to ensure sounds match targeting state.
// Iterates ONLY units that have at least one beam weapon (cached on
// the world via WorldState.getBeamUnits) — at typical compositions
// that's a small minority of units, so we avoid the all-units scan
// and per-turret type check the old loop did every tick.
export function updateLaserSounds(world: WorldState): SimEvent[] {
  _laserSimEvents.length = 0;
  const audioEvents = _laserSimEvents;

  for (const unit of world.getBeamUnits()) {
    if (!unit.combat || !unit.unit || !unit.ownership) continue;

    // Dead units must still emit laserStop so the client releases audio nodes
    const isDead = unit.unit.hp <= 0;

    // Check each weapon for beam sounds
    const turrets = unit.combat.turrets;
    for (let i = 0; i < turrets.length; i++) {
      const weapon = turrets[i];
      const config = weapon.config;
      const isBeamWeapon = config.shot?.type === 'beam';

      if (!isBeamWeapon) continue;

      // Use unique entity ID based on unit ID and weapon index
      const soundEntityId = unit.id * 100 + i;

      // Dead units always get laserStop
      if (isDead) {
        audioEvents.push({
          type: 'laserStop',
          turretId: config.id,
          pos: { x: unit.transform.x, y: unit.transform.y, z: unit.transform.z },
          entityId: soundEntityId,
        });
        continue;
      }

      // Targeting already validated the full 3D fire envelope, including
      // optional minimum fire range. Reuse that state here instead of
      // doing a second 2D distance check for every beam turret.
      const hasTargetInRange = weapon.target !== null && weapon.state === 'engaged';

      if (hasTargetInRange) {
        audioEvents.push({
          type: 'laserStart',
          turretId: config.id,
          pos: { x: unit.transform.x, y: unit.transform.y, z: unit.transform.z },
          entityId: soundEntityId,
        });
      } else {
        audioEvents.push({
          type: 'laserStop',
          turretId: config.id,
          pos: { x: unit.transform.x, y: unit.transform.y, z: unit.transform.z },
          entityId: soundEntityId,
        });
      }
    }
  }

  return audioEvents;
}
