import { getDefaultPlayerName } from '@/playerNamesConfig';
import {
  BATTLE_HANDOFF_PROTOCOL,
  type BattleHandoff,
  type LobbySettings,
} from '@/types/network';
import {
  buildCanonicalMatchInitialization,
  hashCanonicalMatchInitialization,
} from '../architecture/CanonicalMatchInitialization';
import type { PlayerId } from '../sim/types';
import type { LobbyPlayer } from './NetworkTypes';
import { createLobbyPlayer } from './NetworkLobbyRoster';
import { normalizeRoomCode } from './NetworkRoomCode';
import { createHostGameGenerationSeed } from './gameGenerationSeed';
import { assertCurrentLobbySettings } from './LobbySettingsContract';

type BuildBattleHandoffOptions = {
  gameId: string;
  roomCode: string;
  playerIds: Iterable<PlayerId>;
  players: ReadonlyMap<PlayerId, LobbyPlayer>;
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
  settings,
}: BuildBattleHandoffOptions): BattleHandoff {
  const normalizedPlayerIds = normalizePlayerIds(playerIds);
  const players = new Array<LobbyPlayer>(normalizedPlayerIds.length);
  for (let i = 0; i < normalizedPlayerIds.length; i++) {
    const playerId = normalizedPlayerIds[i];
    const existing = roster.get(playerId);
    players[i] = existing
      ? { ...existing }
      : createLobbyPlayer(playerId, getDefaultPlayerName(playerId), playerId === 1);
  }
  const initialization = buildCanonicalMatchInitialization({
    gameId,
    roomCode,
    hostPlayerId: 1 as PlayerId,
    playerIds: normalizedPlayerIds,
    settings,
    gameGenerationSeed: createHostGameGenerationSeed(),
  });
  return {
    protocol: BATTLE_HANDOFF_PROTOCOL,
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
  if (handoff.protocol !== BATTLE_HANDOFF_PROTOCOL) {
    throw new Error(`Unsupported battle handoff protocol: ${String(handoff.protocol)}`);
  }
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
