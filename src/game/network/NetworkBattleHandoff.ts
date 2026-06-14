import { getDefaultPlayerName } from '@/playerNamesConfig';
import { ARCHITECTURE_CONFIG } from '@/architectureConfig';
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

type BuildBattleHandoffOptions = {
  gameId: string;
  roomCode: string;
  playerIds: Iterable<PlayerId>;
  players: ReadonlyMap<PlayerId, LobbyPlayer>;
  settings: LobbySettings | undefined;
};

type BattleHandoffMessage = {
  gameId: string | undefined;
  playerIds: PlayerId[];
  handoff: BattleHandoff | undefined;
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
      : createLobbyPlayer(playerId, getDefaultPlayerName(playerId), playerId === 1);
  });
  const initialization = buildCanonicalMatchInitialization({
    gameId,
    roomCode,
    hostPlayerId: 1 as PlayerId,
    playerIds: normalizedPlayerIds,
    settings,
  });
  return {
    protocol: BATTLE_HANDOFF_PROTOCOL,
    gameId,
    roomCode,
    architecture: initialization.architecture.backend,
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
  fallback: BuildBattleHandoffOptions,
): BattleHandoff {
  const handoff = message.handoff;
  if (
    handoff &&
    handoff.protocol === BATTLE_HANDOFF_PROTOCOL &&
    handoff.gameId === fallback.gameId
  ) {
    const normalizedRoomCode = normalizeRoomCode(handoff.roomCode);
    const normalizedPlayerIds = normalizePlayerIds(handoff.playerIds);
    const initialization = buildCanonicalMatchInitialization({
      gameId: handoff.gameId,
      roomCode: normalizedRoomCode,
      hostPlayerId: handoff.hostPlayerId,
      playerIds: normalizedPlayerIds,
      settings: handoff.settings,
    });
    const initializationHash = hashCanonicalMatchInitialization(initialization);
    const receivedArchitecture = handoff.architecture ?? initialization.architecture.backend;
    if (receivedArchitecture !== ARCHITECTURE_CONFIG.backend) {
      throw new Error(
        `Battle architecture mismatch: host=${receivedArchitecture}, ` +
          `local=${ARCHITECTURE_CONFIG.backend}`,
      );
    }
    if (
      receivedArchitecture === 'deterministic-lockstep' &&
      handoff.initializationHash !== initializationHash
    ) {
      throw new Error(
        `Lockstep initialization hash mismatch: host=${handoff.initializationHash}, ` +
          `local=${initializationHash}`,
      );
    }
    return {
      ...handoff,
      architecture: receivedArchitecture,
      initialization,
      initializationHash,
      roomCode: normalizedRoomCode,
      playerIds: normalizedPlayerIds,
      players: handoff.players.map((player) => ({ ...player })),
    };
  }
  return buildBattleHandoff(fallback);
}

function normalizePlayerIds(playerIds: Iterable<PlayerId>): PlayerId[] {
  return [...new Set(playerIds)].sort((a, b) => a - b);
}
