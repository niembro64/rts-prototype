// Attack target detection helper — find enemy units/buildings under cursor

import type { Entity, PlayerId } from '../../sim/types';
import {
  findPointTargetAt,
  isLivingPointTargetForPlayer,
} from './PointEntityTargetSearch';

export type { AttackEntitySource } from '@/types/input';
import type { AttackEntitySource } from '@/types/input';

export function isAttackableEnemyTarget(
  entity: Entity | null | undefined,
  playerId: PlayerId,
  arePlayersAllied: ((a: PlayerId, b: PlayerId) => boolean) | undefined = undefined,
): entity is Entity {
  return isLivingPointTargetForPlayer(
    entity,
    playerId,
    'enemy',
    arePlayersAllied,
  );
}

// Find an attackable enemy target at a world position
// Returns enemy units first (smaller targets), then buildings
export function findAttackTargetAt(
  entitySource: AttackEntitySource,
  worldX: number,
  worldY: number,
  playerId: PlayerId
): Entity | null {
  return findPointTargetAt(entitySource, worldX, worldY, playerId, 'enemy');
}
