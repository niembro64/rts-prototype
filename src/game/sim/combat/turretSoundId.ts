import { NO_ENTITY_ID, type Entity, type EntityId } from '../types';

export function resolveTurretSoundEntityId(
  entity: Entity,
  turretIndex: number,
): EntityId {
  const turret = entity.combat?.turrets[turretIndex];
  return turret !== undefined && turret.id !== NO_ENTITY_ID
    ? turret.id
    : entity.id * 100 + turretIndex;
}
