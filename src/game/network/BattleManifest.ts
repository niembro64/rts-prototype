import { BATTLE_CONFIG } from '@/battleBarConfig';
import type {
  BattleManifest,
  BattleManifestPlayerSlot,
  BattleManifestSettings,
  BlueprintVersionStamps,
  LobbyPlayer,
  LobbySettings,
} from '@/types/network';
import {
  BATTLE_MANIFEST_PROTOCOL,
  BATTLE_MANIFEST_SCHEMA_VERSION,
  COMMAND_SCHEMA_VERSION,
} from '@/types/network';
import { canonicalBytes, canonicalHashValue } from '../canonicalData';
import { buildBlueprintVersionStamps } from '../sim/blueprints/versionStamps';
import { SIM_WASM_PACKAGE_VERSION } from '../sim-wasm/version';
import type { PlayerId } from '../sim/types';

export const DEFAULT_BATTLE_MAP_SEED = 0;
export const DEFAULT_INITIAL_RNG_SEED = 42;

export type BuildBattleManifestOptions = {
  gameId: string;
  roomCode: string;
  hostPlayerId?: PlayerId;
  playerIds: Iterable<PlayerId>;
  players: readonly BattleManifestPlayerInput[];
  settings: LobbySettings | BattleManifestSettings | undefined;
  mapSeed?: number;
  initialRngSeed?: number;
  simVersion?: string;
  blueprintVersions?: BlueprintVersionStamps;
};

export type BattleManifestPlayerInput =
  Pick<LobbyPlayer, 'playerId' | 'name' | 'isHost'>;

export function buildBattleManifest(options: BuildBattleManifestOptions): BattleManifest {
  const hostPlayerId = options.hostPlayerId ?? (1 as PlayerId);
  const playerIds = normalizePlayerIds(options.playerIds);
  const playerSlots = buildPlayerSlots(playerIds, options.players, hostPlayerId);
  return {
    protocol: BATTLE_MANIFEST_PROTOCOL,
    schemaVersion: BATTLE_MANIFEST_SCHEMA_VERSION,
    gameId: options.gameId,
    roomCode: options.roomCode,
    hostPlayerId,
    mapSeed: normalizeSeed(options.mapSeed, DEFAULT_BATTLE_MAP_SEED),
    initialRngSeed: normalizeSeed(
      options.initialRngSeed,
      DEFAULT_INITIAL_RNG_SEED,
    ),
    commandSchemaVersion: COMMAND_SCHEMA_VERSION,
    simVersion: options.simVersion ?? SIM_WASM_PACKAGE_VERSION,
    blueprintVersions: options.blueprintVersions ?? buildBlueprintVersionStamps(),
    settings: normalizeBattleManifestSettings(options.settings),
    playerSlots,
  };
}

export function battleManifestBytes(manifest: BattleManifest): Uint8Array {
  return canonicalBytes(manifest);
}

export function hashBattleManifest(manifest: BattleManifest): string {
  return canonicalHashValue(manifest);
}

export function assertBattleManifestHash(
  manifest: BattleManifest,
  expectedHash: string,
): string {
  const actualHash = hashBattleManifest(manifest);
  if (actualHash !== expectedHash) {
    throw new Error(
      `Battle manifest hash mismatch: expected ${expectedHash}, got ${actualHash}`,
    );
  }
  return actualHash;
}

export function normalizeBattleManifestSettings(
  settings: LobbySettings | BattleManifestSettings | undefined,
): BattleManifestSettings {
  return {
    centerMagnitude: finiteNumber(
      settings?.centerMagnitude,
      BATTLE_CONFIG.centerMagnitude.default,
    ),
    dividersMagnitude: finiteNumber(
      settings?.dividersMagnitude,
      BATTLE_CONFIG.dividersMagnitude.default,
    ),
    terrainMapShape: settings?.terrainMapShape ?? BATTLE_CONFIG.mapShape.default,
    terrainDTerrain: finiteNullableNumber(
      settings?.terrainDTerrain,
      BATTLE_CONFIG.terrainDTerrain.default,
    ),
    metalDepositStep: finiteNullableNumber(
      settings?.metalDepositStep,
      BATTLE_CONFIG.metalDepositStep.default,
    ),
    mapWidthLandCells: finiteInteger(
      settings?.mapWidthLandCells,
      BATTLE_CONFIG.mapSize.width.default,
    ),
    mapLengthLandCells: finiteInteger(
      settings?.mapLengthLandCells,
      BATTLE_CONFIG.mapSize.length.default,
    ),
    fogOfWarEnabled: typeof settings?.fogOfWarEnabled === 'boolean'
      ? settings.fogOfWarEnabled
      : null,
    converterTax: finiteNullableNumber(settings?.converterTax, null),
  };
}

export function manifestSettingsToLobbySettings(
  settings: BattleManifestSettings,
): LobbySettings {
  return {
    centerMagnitude: settings.centerMagnitude,
    dividersMagnitude: settings.dividersMagnitude,
    terrainMapShape: settings.terrainMapShape,
    terrainDTerrain: settings.terrainDTerrain ?? undefined,
    metalDepositStep: settings.metalDepositStep ?? undefined,
    mapWidthLandCells: settings.mapWidthLandCells,
    mapLengthLandCells: settings.mapLengthLandCells,
    fogOfWarEnabled: settings.fogOfWarEnabled ?? undefined,
    converterTax: settings.converterTax ?? undefined,
  };
}

function buildPlayerSlots(
  playerIds: readonly PlayerId[],
  players: readonly BattleManifestPlayerInput[],
  hostPlayerId: PlayerId,
): BattleManifestPlayerSlot[] {
  const playersById = new Map<PlayerId, BattleManifestPlayerInput>();
  for (const player of players) playersById.set(player.playerId, player);
  return playerIds.map((playerId) => {
    const player = playersById.get(playerId);
    return {
      playerId,
      teamId: playerId,
      name: player?.name ?? `Player ${playerId}`,
      isHost: player?.isHost ?? playerId === hostPlayerId,
    };
  });
}

function normalizePlayerIds(playerIds: Iterable<PlayerId>): PlayerId[] {
  return [...new Set(playerIds)].sort((a, b) => a - b);
}

function finiteNumber(value: number | null | undefined, fallback: number): number {
  return Number.isFinite(value) ? value as number : fallback;
}

function finiteInteger(value: number | null | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.trunc(value as number) : fallback;
}

function finiteNullableNumber(
  value: number | null | undefined,
  fallback: number | null,
): number | null {
  return Number.isFinite(value) ? value as number : fallback;
}

function normalizeSeed(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.trunc(value as number) >>> 0 : fallback;
}
