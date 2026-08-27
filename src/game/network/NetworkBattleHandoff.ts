import { getDefaultPlayerName } from '@/playerNamesConfig';
import {
  type BattleHandoff,
  type LobbySettings,
} from '@/types/network';
import {
  allyTeamByPlayerIdFromInitialization,
  buildCanonicalMatchInitialization,
  hashCanonicalMatchInitialization,
} from '../architecture/CanonicalMatchInitialization';
import { FIRST_ALLY_TEAM_ID } from '../sim/teamRoster';
import type { PlayerId } from '../sim/types';
import type { LobbyPlayer } from './NetworkTypes';
import { normalizeRoomCode } from './NetworkRoomCode';
import { createHostGameGenerationSeed } from './gameGenerationSeed';
import { assertCurrentLobbySettings } from './LobbySettingsContract';

type BuildBattleHandoffOptions = {
  gameId: string;
  roomCode: string;
  playerIds: Iterable<PlayerId>;
  /** The seated members, as the match sees them. */
  players: readonly LobbyPlayer[];
  /** Seat -> side, as the host seated them. Required: the lobby's TEAM
   *  assignment decides terrain slices, spawn arcs and who may shoot whom, so
   *  it belongs in the hashed initialization rather than being rediscovered
   *  from the roster later. */
  allyTeamByPlayerId: Readonly<Record<number, number>>;
  /** The two seat axes (src/game/sim/agentSeat.ts), destined for the hashed
   *  initialization: bot-driven seats, seats receiving base buildings, and
   *  the subset also receiving opening units. */
  aiPlayerIds: readonly PlayerId[];
  baseSeatPlayerIds: readonly PlayerId[];
  baseAndUnitsSeatPlayerIds: readonly PlayerId[];
  /** Sides the lobby declared, empty ones included. */
  allyTeamCount: number;
  settings: LobbySettings;
};

type BattleHandoffMessage = {
  gameId: string;
  playerIds: PlayerId[];
  handoff: BattleHandoff;
};

export function buildBattleHandoff({
  gameId,
  roomCode,
  playerIds,
  players: roster,
  allyTeamByPlayerId,
  allyTeamCount,
  aiPlayerIds,
  baseSeatPlayerIds,
  baseAndUnitsSeatPlayerIds,
  settings,
}: BuildBattleHandoffOptions): BattleHandoff {
  const normalizedPlayerIds = normalizePlayerIds(playerIds);
  const bySeat = new Map<PlayerId, LobbyPlayer>();
  for (const player of roster) bySeat.set(player.playerId, player);
  const players = new Array<LobbyPlayer>(normalizedPlayerIds.length);
  for (let i = 0; i < normalizedPlayerIds.length; i++) {
    const playerId = normalizedPlayerIds[i];
    const existing = bySeat.get(playerId);
    players[i] = existing
      ? { ...existing }
      : {
          playerId,
          name: getDefaultPlayerName(playerId),
          isHost: playerId === 1,
          allyTeamId: FIRST_ALLY_TEAM_ID,
          ipAddress: undefined,
          location: undefined,
          timezone: undefined,
          localTime: undefined,
        };
  }
  const initialization = buildCanonicalMatchInitialization({
    gameId,
    roomCode,
    hostPlayerId: 1 as PlayerId,
    playerIds: normalizedPlayerIds,
    allyTeamByPlayerId,
    allyTeamCount,
    aiPlayerIds,
    baseSeatPlayerIds,
    baseAndUnitsSeatPlayerIds,
    settings,
    gameGenerationSeed: createHostGameGenerationSeed(),
  });
  return {
    gameId,
    roomCode,
    initialization,
    initializationHash: hashCanonicalMatchInitialization(initialization),
    hostPlayerId: 1 as PlayerId,
    playerIds: normalizedPlayerIds,
    players,
    settings,
  };
}

export function normalizeBattleHandoffMessage(
  message: BattleHandoffMessage,
): BattleHandoff {
  const handoff = message.handoff;
  if (handoff.gameId !== message.gameId) {
    throw new Error(`Battle handoff game mismatch: message=${message.gameId}, handoff=${handoff.gameId}`);
  }
  assertCurrentLobbySettings(handoff.settings, 'battle handoff');
  const normalizedRoomCode = normalizeRoomCode(handoff.roomCode);
  const normalizedPlayerIds = normalizePlayerIds(handoff.playerIds);
  const messagePlayerIds = normalizePlayerIds(message.playerIds);
  if (normalizedPlayerIds.join(',') !== messagePlayerIds.join(',')) {
    throw new Error('Battle handoff roster does not match gameStart roster');
  }
  const initialization = buildCanonicalMatchInitialization({
    gameId: handoff.gameId,
    roomCode: normalizedRoomCode,
    hostPlayerId: handoff.hostPlayerId,
    playerIds: normalizedPlayerIds,
    allyTeamByPlayerId: allyTeamByPlayerIdFromInitialization(handoff.initialization),
    allyTeamCount: handoff.initialization.allyTeamCount,
    aiPlayerIds: handoff.initialization.aiPlayerIds,
    baseSeatPlayerIds: handoff.initialization.baseSeatPlayerIds,
    baseAndUnitsSeatPlayerIds:
      handoff.initialization.baseAndUnitsSeatPlayerIds ??
      handoff.initialization.baseSeatPlayerIds,
    settings: handoff.settings,
    gameGenerationSeed: handoff.initialization.gameGenerationSeed,
  });
  const initializationHash = hashCanonicalMatchInitialization(initialization);
  if (handoff.initializationHash !== initializationHash) {
    throw new Error(
      `Lockstep initialization hash mismatch: host=${handoff.initializationHash}, ` +
        `local=${initializationHash}`,
    );
  }
  return {
    ...handoff,
    initialization,
    initializationHash,
    roomCode: normalizedRoomCode,
    playerIds: normalizedPlayerIds,
    players: copyLobbyPlayers(handoff.players),
  };
}

function normalizePlayerIds(playerIds: Iterable<PlayerId>): PlayerId[] {
  return [...new Set(playerIds)].sort((a, b) => a - b);
}

function copyLobbyPlayers(players: readonly LobbyPlayer[]): LobbyPlayer[] {
  const copy = new Array<LobbyPlayer>(players.length);
  for (let i = 0; i < players.length; i++) copy[i] = { ...players[i] };
  return copy;
}
