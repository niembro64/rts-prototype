import type { Entity, PlayerId } from './types';
import { isBuildInProgress } from './buildableHelpers';

export function isCapturableTarget(target: Entity | null | undefined, playerId: PlayerId): target is Entity {
  if (target === null || target === undefined) return false;
  const ownership = target.ownership;
  if (ownership === null || ownership.playerId === playerId) return false;
  if (isBuildInProgress(target.buildable)) return false;
  if (target.unit !== null) return target.unit.hp > 0;
  if (target.building !== null) return target.building.hp > 0;
  return false;
}
