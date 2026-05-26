import { getDefaultPlayerName } from '@/playerNamesConfig';
import {
  BATTLE_HANDOFF_PROTOCOL,
  type BattleHandoff,
  type LobbySettings,
} from '@/types/network';
import type { PlayerId } from '../sim/types';
import type { LobbyPlayer } from './NetworkTypes';
import {
  assertBattleManifestHash,
  buildBattleManifest,
  hashBattleManifest,
  manifestSettingsToLobbySettings,
} from './BattleManifest';
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
  const normalizedRoomCode = normalizeRoomCode(roomCode);
  const players = normalizedPlayerIds.map((playerId) => {
    const existing = roster.get(playerId);
    return existing
      ? { ...existing }
      : createLobbyPlayer(playerId, getDefaultPlayerName(playerId), playerId === 1);
  });
  const manifest = buildBattleManifest({
    gameId,
    roomCode: normalizedRoomCode,
    hostPlayerId: 1 as PlayerId,
    playerIds: normalizedPlayerIds,
    players,
    settings,
  });
  return {
    protocol: BATTLE_HANDOFF_PROTOCOL,
    gameId,
    roomCode: normalizedRoomCode,
    hostPlayerId: 1 as PlayerId,
    playerIds: normalizedPlayerIds,
    players,
    settings: manifestSettingsToLobbySettings(manifest.settings),
    manifest,
    manifestHash: hashBattleManifest(manifest),
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
    const manifest = handoff.manifest;
    if (manifest === undefined || handoff.manifestHash === undefined) {
      return buildBattleHandoff(fallback);
    }
    if (manifest.gameId !== fallback.gameId) {
      throw new Error(
        `Battle manifest gameId mismatch: expected ${fallback.gameId}, got ${manifest.gameId}`,
      );
    }
    const manifestHash = assertBattleManifestHash(
      manifest,
      handoff.manifestHash,
    );
    const playerIds = normalizePlayerIds(
      manifest.playerSlots.map((slot) => slot.playerId),
    );
    return {
      ...handoff,
      roomCode: normalizeRoomCode(handoff.roomCode),
      playerIds,
      players: handoff.players.map((player) => ({ ...player })),
      settings: manifestSettingsToLobbySettings(manifest.settings),
      manifest,
      manifestHash,
    };
  }
  return buildBattleHandoff(fallback);
}

function normalizePlayerIds(playerIds: Iterable<PlayerId>): PlayerId[] {
  return [...new Set(playerIds)].sort((a, b) => a - b);
}
