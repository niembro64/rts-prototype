import { getDefaultPlayerName } from '@/playerNamesConfig';
import {
  BATTLE_HANDOFF_PROTOCOL,
  type BattleHandoff,
  type LobbySettings,
} from '@/types/network';
import type { PlayerId } from '../sim/types';
import type { LobbyPlayer } from './NetworkTypes';
import { normalizeRoomCode } from './NetworkRoomCode';

type BuildBattleHandoffOptions = {
  gameId: string;
  roomCode: string;
  playerIds: Iterable<PlayerId>;
  players: ReadonlyMap<PlayerId, LobbyPlayer>;
  settings?: LobbySettings;
};

type BattleHandoffMessage = {
  gameId?: string;
  playerIds: PlayerId[];
  handoff?: BattleHandoff;
};

export function buildBattleHandoff({
  gameId,
  roomCode,
  playerIds,
  players: roster,
  settings,
}: BuildBattleHandoffOptions): BattleHandoff {
  const normalizedPlayerIds = normalizePlayerIds(playerIds);
  const players = normalizedPlayerIds.map((playerId) => {
    const existing = roster.get(playerId);
    return existing
      ? { ...existing }
      : {
          playerId,
          name: getDefaultPlayerName(playerId),
          isHost: playerId === 1,
        };
  });
  return {
    protocol: BATTLE_HANDOFF_PROTOCOL,
    gameId,
    roomCode,
    hostPlayerId: 1 as PlayerId,
    playerIds: normalizedPlayerIds,
    players,
    settings,
  };
}

export function normalizeBattleHandoffMessage(
  message: BattleHandoffMessage,
  fallback: BuildBattleHandoffOptions,
): BattleHandoff {
  const handoff = message.handoff;
  if (
    handoff &&
    handoff.protocol === BATTLE_HANDOFF_PROTOCOL &&
    handoff.gameId === fallback.gameId
  ) {
    return {
      ...handoff,
      roomCode: normalizeRoomCode(handoff.roomCode),
      playerIds: normalizePlayerIds(handoff.playerIds),
      players: handoff.players.map((player) => ({ ...player })),
    };
  }
  return buildBattleHandoff(fallback);
}

export function applyBattleHandoffPlayers(
  roster: Map<PlayerId, LobbyPlayer>,
  handoff: BattleHandoff,
): void {
  for (const player of handoff.players) {
    roster.set(player.playerId, { ...player });
  }
}

function normalizePlayerIds(playerIds: Iterable<PlayerId>): PlayerId[] {
  return [...new Set(playerIds)].sort((a, b) => a - b);
}
