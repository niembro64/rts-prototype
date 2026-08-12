import type { PlayerId } from './types';
import type { WorldState } from './WorldState';

function playerHasLivingCommander(world: WorldState, playerId: PlayerId): boolean {
  const commanders = world.getCommanderUnits();
  for (let i = 0; i < commanders.length; i++) {
    const commander = commanders[i];
    if (
      commander.unit !== null &&
      commander.unit.hp > 0 &&
      commander.ownership?.playerId === playerId
    ) {
      return true;
    }
  }
  return false;
}

export function resolveCommanderGameOverWinner(
  world: WorldState,
  playerIds: readonly PlayerId[],
): PlayerId | null {
  if (playerIds.length < 2) return null;

  // Victory belongs to an ally team, not an individual seat. Several living
  // commanders are allowed as long as all of them belong to the same side.
  // `getTeamId` is the world's canonical alliance-component id.
  let survivingTeamId: number | null = null;
  for (let i = 0; i < playerIds.length; i++) {
    const playerId = playerIds[i];
    if (!playerHasLivingCommander(world, playerId)) continue;
    const teamId = world.getTeamId(playerId);
    if (survivingTeamId === null) survivingTeamId = teamId;
    else if (teamId !== survivingTeamId) return null;
  }

  // Zero surviving sides is not a win. For the one surviving side, return a
  // living member in stable roster order for the existing winnerId wire field.
  if (survivingTeamId === null) return null;
  for (let i = 0; i < playerIds.length; i++) {
    const playerId = playerIds[i];
    if (
      world.getTeamId(playerId) === survivingTeamId &&
      playerHasLivingCommander(world, playerId)
    ) {
      return playerId;
    }
  }
  return null;
}
