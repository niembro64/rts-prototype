// Laser sound system - manages continuous beam weapon audio

import type { WorldState } from '../WorldState';
import type { Entity, EntityId, TurretState } from '../types';
import { NO_ENTITY_ID } from '../types';
import { beamIndex } from '../BeamIndex';
import type { SimEvent } from './types';
import { CT_TURRET_STATE_ENGAGED } from '../../sim-wasm/init';
import { getBeamWeaponsTargeting } from './targetIndex';
import {
  readCombatTargetingTurretFsmInto,
  type CombatTargetingTurretFsmOut,
} from './targetingInputStamping';

// Reusable array for laser sound events (avoids per-frame allocation)
const _laserSimEvents: SimEvent[] = [];
const _laserStopOwner: SimEvent[] = [];
const _laserStopTarget: SimEvent[] = [];
const _laserFsm: CombatTargetingTurretFsmOut = {
  stateCode: CT_TURRET_STATE_ENGAGED,
  targetId: -1,
};
const LASER_SOUND_REFRESH_TICKS = 60;
const activeLaserSoundIds = new Set<number>();
let laserSoundRefreshTick = 0;

function turretSoundEntityId(entity: Entity, weaponIndex: number): EntityId {
  const turret = entity.combat?.turrets[weaponIndex];
  return turret !== undefined && turret.id !== NO_ENTITY_ID
    ? turret.id
    : entity.id * 100 + weaponIndex;
}

function isBeamEngagedWithTargetingState(
  unit: Entity,
  weaponIndex: number,
  jsState: TurretState,
  jsTargetId: EntityId | null,
): boolean {
  const priorityTargetPoint = unit.combat !== null ? unit.combat.priorityTargetPoint : null;
  if (!readCombatTargetingTurretFsmInto(unit, weaponIndex, _laserFsm)) {
    return jsState === 'engaged'
      && (jsTargetId !== null || priorityTargetPoint !== null);
  }
  return _laserFsm.stateCode === CT_TURRET_STATE_ENGAGED
    && (_laserFsm.targetId !== -1 || priorityTargetPoint !== null);
}

// Emit laserStop events for all beam weapons on a dying entity (the beam owner).
// Must be called before the entity is removed from the world.
export function emitLaserStopsForEntity(entity: Entity): SimEvent[] {
  _laserStopOwner.length = 0;
  if (entity.combat === null) return _laserStopOwner;
  const turrets = entity.combat.turrets;

  for (let i = 0; i < turrets.length; i++) {
    const config = turrets[i].config;
    const shot = config.shot;
    if (shot !== null && shot.type === 'beam') {
      const soundEntityId = turretSoundEntityId(entity, i);
      if (!activeLaserSoundIds.delete(soundEntityId)) continue;
      _laserStopOwner.push({
        type: 'laserStop',
        turretBlueprintId: config.turretBlueprintId,
        pos: { x: entity.transform.x, y: entity.transform.y, z: entity.transform.z },
        entityId: soundEntityId,
      });
    }
  }
  return _laserStopOwner;
}

// Emit laserStop events for all inactive beam weapons across the world that were
// targeting a dying entity. Active beams keep their sound until the sim removes
// the beam after its configured minimum on-time.
//
// Reads the inverse target index (targetIndex.ts) instead of scanning every
// unit × every turret on each death — at 1000 units × 8 turrets the old scan
// was the dominant cost during battle peaks.
export function emitLaserStopsForTarget(world: WorldState, targetId: EntityId): SimEvent[] {
  _laserStopTarget.length = 0;
  const refs = getBeamWeaponsTargeting(world, targetId);
  for (let r = 0; r < refs.length; r++) {
    const { unit, weaponIndex } = refs[r];
    if (!unit.combat || !unit.unit || unit.unit.hp <= 0) continue;
    const weapon = unit.combat.turrets[weaponIndex];
    if (!weapon) continue;
    if (beamIndex.hasActiveBeam(unit.id, weaponIndex)) continue;
    const config = weapon.config;
    const soundEntityId = turretSoundEntityId(unit, weaponIndex);
    if (!activeLaserSoundIds.delete(soundEntityId)) continue;
    _laserStopTarget.push({
      type: 'laserStop',
      turretBlueprintId: config.turretBlueprintId,
      pos: { x: unit.transform.x, y: unit.transform.y, z: unit.transform.z },
      entityId: soundEntityId,
    });
  }
  return _laserStopTarget;
}

// Update laser sounds based on targeting state and active beam existence.
// This is called every frame to ensure sounds match the sim beam lifetime.
// Iterates ONLY units that have at least one beam weapon (cached on
// the world via WorldState.getBeamUnits) — at typical compositions
// that's a small minority of units, so we avoid the all-units scan
// and per-turret type check the old loop did every tick.
export function updateLaserSounds(world: WorldState): SimEvent[] {
  _laserSimEvents.length = 0;
  const audioEvents = _laserSimEvents;
  laserSoundRefreshTick++;
  const shouldRefreshActive = laserSoundRefreshTick % LASER_SOUND_REFRESH_TICKS === 0;

  for (const unit of world.getBeamUnits()) {
    if (!unit.combat || !unit.unit || !unit.ownership) continue;

    // Dead units must still emit laserStop so the client releases audio nodes
    const isDead = unit.unit.hp <= 0;

    // Check each weapon for beam sounds
    const turrets = unit.combat.turrets;
    for (let i = 0; i < turrets.length; i++) {
      const weapon = turrets[i];
      const config = weapon.config;
      const shot = config.shot;
      const isBeamWeapon = shot !== null && shot.type === 'beam';

      if (!isBeamWeapon) continue;

      // Use unique entity ID based on unit ID and weapon index
      const soundEntityId = turretSoundEntityId(unit, i);
      const wasActive = activeLaserSoundIds.has(soundEntityId);

      // Dead units always get laserStop
      if (isDead) {
        if (!activeLaserSoundIds.delete(soundEntityId)) continue;
        audioEvents.push({
          type: 'laserStop',
          turretBlueprintId: config.turretBlueprintId,
          pos: { x: unit.transform.x, y: unit.transform.y, z: unit.transform.z },
          playerId: unit.ownership.playerId,
          entityId: soundEntityId,
        });
        continue;
      }

      // Targeting already validated the full 3D fire envelope, including
      // optional minimum fire range. Reuse that state here instead of
      // doing a second 2D distance check for every beam turret.
      const hasTargetInRange = isBeamEngagedWithTargetingState(
        unit,
        i,
        weapon.state,
        weapon.target,
      );
      const hasActiveBeam = beamIndex.hasActiveBeam(unit.id, i);

      if (hasTargetInRange || hasActiveBeam) {
        if (!wasActive) activeLaserSoundIds.add(soundEntityId);
        if (!wasActive || shouldRefreshActive) {
          audioEvents.push({
            type: 'laserStart',
            turretBlueprintId: config.turretBlueprintId,
            pos: { x: unit.transform.x, y: unit.transform.y, z: unit.transform.z },
            playerId: unit.ownership.playerId,
            entityId: soundEntityId,
          });
        }
      } else {
        if (!activeLaserSoundIds.delete(soundEntityId)) continue;
        audioEvents.push({
          type: 'laserStop',
          turretBlueprintId: config.turretBlueprintId,
          pos: { x: unit.transform.x, y: unit.transform.y, z: unit.transform.z },
          playerId: unit.ownership.playerId,
          entityId: soundEntityId,
        });
      }
    }
  }

  return audioEvents;
}

export function resetLaserSoundState(): void {
  activeLaserSoundIds.clear();
  laserSoundRefreshTick = 0;
}
