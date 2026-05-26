import { getMapSize } from '../config';
import {
  loadStoredConverterTax,
  loadStoredMapLandDimensions,
  loadStoredRealCap,
  loadStoredTerrainMapShape,
  loadStoredTerrainRuntimeConfig,
  type BattleTerrainRuntimeConfig,
} from '../battleBarConfig';
import {
  setTerrainCenterMagnitude,
  setTerrainDividersMagnitude,
  setTerrainMapShape,
  setTerrainRuntimeConfig,
} from '../game/sim/Terrain';
import { GameServer } from '../game/server/GameServer';
import {
  LocalGameConnection,
  type LocalCommandAuthorityMode,
} from '../game/server/LocalGameConnection';
import { RemoteGameConnection } from '../game/server/RemoteGameConnection';
import { applyStoredBattleServerSettings } from '../game/server/battleServerSettings';
import type { GameConnection } from '../game/server/GameConnection';
import type { PlayerId } from '../game/sim/types';
import type { MapLandCellDimensions } from '../mapSizeConfig';
import type { BattleManifest } from '../types/network';
import type { TerrainMapShape } from '../types/terrain';

export type RealBattleStartupTerrain = {
  terrainMapShape: TerrainMapShape;
  terrainRuntimeConfig: BattleTerrainRuntimeConfig;
  mapDimensions: MapLandCellDimensions;
  mapSize: { width: number; height: number };
};

export type CreateRealBattleServerOptions = {
  playerIds: PlayerId[];
  aiPlayerIds?: PlayerId[];
  terrain: RealBattleStartupTerrain;
  manifest?: BattleManifest;
  onLoadingProgress?: (progress: number, phase?: string) => void | Promise<void>;
};

export type StartRealBattleServerOptions = {
  ipAddress: string;
  manifest?: BattleManifest;
};

export function loadAndApplyRealBattleTerrain(): RealBattleStartupTerrain {
  const terrainMapShape = loadStoredTerrainMapShape('real');
  const terrainRuntimeConfig = loadStoredTerrainRuntimeConfig('real');
  const mapDimensions = loadStoredMapLandDimensions('real');
  const mapSize = getMapSize(
    false,
    mapDimensions.widthLandCells,
    mapDimensions.lengthLandCells,
  );
  setTerrainRuntimeConfig(terrainRuntimeConfig);
  setTerrainCenterMagnitude(terrainRuntimeConfig.centerMagnitude);
  setTerrainDividersMagnitude(terrainRuntimeConfig.dividersMagnitude);
  setTerrainMapShape(terrainMapShape);
  return {
    terrainMapShape,
    terrainRuntimeConfig,
    mapDimensions,
    mapSize,
  };
}

export function createRemoteRealBattleConnection(): GameConnection {
  return new RemoteGameConnection();
}

export function createLocalRealBattleConnection(
  server: GameServer,
  localPlayerId: PlayerId | undefined,
  commandAuthorityMode: LocalCommandAuthorityMode = 'player',
): GameConnection {
  return new LocalGameConnection(server, localPlayerId, commandAuthorityMode);
}

export async function createRealBattleServer({
  playerIds,
  aiPlayerIds,
  terrain,
  manifest,
  onLoadingProgress,
}: CreateRealBattleServerOptions): Promise<GameServer> {
  return GameServer.create(
    {
      playerIds,
      aiPlayerIds,
      centerMagnitude: terrain.terrainRuntimeConfig.centerMagnitude,
      dividersMagnitude: terrain.terrainRuntimeConfig.dividersMagnitude,
      terrainMapShape: terrain.terrainMapShape,
      terrainDTerrain: terrain.terrainRuntimeConfig.terrainDTerrain,
      metalDepositStep: terrain.terrainRuntimeConfig.metalDepositStep,
      mapWidthLandCells: terrain.mapDimensions.widthLandCells,
      mapLengthLandCells: terrain.mapDimensions.lengthLandCells,
      converterTax: loadStoredConverterTax('real'),
      manifest,
    },
    {
      onProgress: onLoadingProgress,
    },
  );
}

export function applySettingsAndStartRealBattleServer(
  server: GameServer,
  options: StartRealBattleServerOptions,
): void {
  applyStoredBattleServerSettings(server, 'real', {
    ipAddress: options.ipAddress,
    maxTotalUnits: loadStoredRealCap(),
  });
  applyManifestServerSettings(server, options.manifest);
  server.start();
}

function applyManifestServerSettings(
  server: GameServer,
  manifest: BattleManifest | undefined,
): void {
  const settings = manifest?.settings;
  if (settings === undefined) return;
  const authority = { mode: 'host-admin' } as const;
  if (settings.fogOfWarEnabled !== null) {
    server.receiveCommand({
      type: 'setFogOfWarEnabled',
      tick: 0,
      enabled: settings.fogOfWarEnabled,
    }, authority);
  }
  if (settings.converterTax !== null) {
    server.receiveCommand({
      type: 'setConverterTax',
      tick: 0,
      tax: settings.converterTax,
    }, authority);
  }
}
