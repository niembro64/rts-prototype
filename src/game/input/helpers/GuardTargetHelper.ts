// Guard / assist target detection helper.

import type { Entity, PlayerId } from '../../sim/types';
import {
  findPointTargetAt,
  isLivingPointTargetForPlayer,
} from './PointEntityTargetSearch';

export type { GuardEntitySource } from '@/types/input';
import type { GuardEntitySource } from '@/types/input';

export function isGuardableFriendlyTarget(
  entity: Entity | null | undefined,
  playerId: PlayerId,
  arePlayersAllied: ((a: PlayerId, b: PlayerId) => boolean) | undefined = undefined,
): entity is Entity {
  return isLivingPointTargetForPlayer(
    entity,
    playerId,
    'friendly',
    arePlayersAllied,
  );
}

export function findGuardTargetAt(
  entitySource: GuardEntitySource,
  worldX: number,
  worldY: number,
  playerId: PlayerId,
): Entity | null {
  return findPointTargetAt(entitySource, worldX, worldY, playerId, 'friendly');
}
