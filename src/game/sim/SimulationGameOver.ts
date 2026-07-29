import type { PlayerId } from './types';
import type { WorldState } from './WorldState';
import { ENTITY_CHANGED_HP } from '@/types/network';

export function resolveCommanderGameOverWinner(
  world: WorldState,
  playerIds: readonly PlayerId[],
): PlayerId | null {
  if (playerIds.length < 2) return null;

  // Count alive commanders without allocating a filtered array.
  let aliveCount = 0;
  let lastAliveId = 0;
  for (let i = 0; i < playerIds.length; i++) {
    if (world.isCommanderAlive(playerIds[i])) {
      aliveCount++;
      lastAliveId = playerIds[i];
    }
  }

  if (aliveCount === 1) return lastAliveId;
  // If no players remain somehow, pick the first player to preserve
  // the legacy draw/error behavior.
  return aliveCount === 0 && playerIds.length > 0 ? playerIds[0] : null;
}

/**
 * BAR-style team wipeout: victory is a latched match result, not a frozen
 * simulation. Route every defeated unit and building through the ordinary
 * zero-HP cleanup so their authored death explosions, audio, debris, and
 * callbacks still run while the winner keeps control of the surviving army.
 */
export function markDefeatedPlayerEntitiesForDestruction(
  world: WorldState,
  winnerId: PlayerId,
): void {
  const entities = world.getUnitsAndBuildings();
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    if (entity.ownership === null || entity.ownership.playerId === winnerId) continue;
    const hpState = entity.unit ?? entity.building;
    if (hpState === null || hpState.hp <= 0) continue;
    hpState.hp = 0;
    world.markSnapshotDirty(entity.id, ENTITY_CHANGED_HP);
  }
}
