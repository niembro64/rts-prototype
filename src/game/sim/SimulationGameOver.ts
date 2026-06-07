import type { PlayerId } from './types';
import type { WorldState } from './WorldState';

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
