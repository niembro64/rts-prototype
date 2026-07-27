import type { SimEvent } from './combat';
import type { Entity } from './types';

export function createSelfDestructEvent(
  entity: Entity,
  armed: boolean,
): SimEvent {
  return {
    type: armed ? 'selfDestructArmed' : 'selfDestructDisarmed',
    turretBlueprintId: '',
    sourceType: 'system',
    sourceKey: 'selfDestruct',
    playerId: entity.ownership !== null
      ? entity.ownership.playerId
      : undefined,
    entityId: entity.id,
    pos: {
      x: entity.transform.x,
      y: entity.transform.y,
      z: entity.transform.z,
    },
  };
}
