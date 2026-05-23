import { getMapSize } from '../config';
import {
  loadStoredConverterTax,
  loadStoredMapLandDimensions,
  loadStoredRealCap,
  loadStoredTerrainCenter,
  loadStoredTerrainDividers,
  loadStoredTerrainMapShape,
  loadStoredTerrainRuntimeConfig,
  type BattleTerrainRuntimeConfig,
} from '../battleBarConfig';
import {
  setTerrainCenterShape,
  setTerrainDividersShape,
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
import type { TerrainMapShape, TerrainShape } from '../types/terrain';

export type RealBattleStartupTerrain = {
  terrainCenter: TerrainShape;
  terrainDividers: TerrainShape;
  terrainMapShape: TerrainMapShape;
  terrainRuntimeConfig: BattleTerrainRuntimeConfig;
  mapDimensions: MapLandCellDimensions;
  mapSize: { width: number; height: number };
};

export type CreateRealBattleServerOptions = {
  playerIds: PlayerId[];
  aiPlayerIds?: PlayerId[];
  terrain: RealBattleStartupTerrain;
};

export type StartRealBattleServerOptions = {
  ipAddress: string;
};

export function loadAndApplyRealBattleTerrain(): RealBattleStartupTerrain {
  const terrainCenter = loadStoredTerrainCenter('real');
  const terrainDividers = loadStoredTerrainDividers('real');
  const terrainMapShape = loadStoredTerrainMapShape('real');
  const terrainRuntimeConfig = loadStoredTerrainRuntimeConfig('real');
  const mapDimensions = loadStoredMapLandDimensions('real');
  const mapSize = getMapSize(
    false,
    mapDimensions.widthLandCells,
    mapDimensions.lengthLandCells,
  );
  setTerrainRuntimeConfig(terrainRuntimeConfig);
  setTerrainCenterShape(terrainCenter);
  setTerrainDividersShape(terrainDividers);
  setTerrainMapShape(terrainMapShape);
  return {
    terrainCenter,
    terrainDividers,
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
}: CreateRealBattleServerOptions): Promise<GameServer> {
  return GameServer.create({
    playerIds,
    aiPlayerIds,
    terrainCenter: terrain.terrainCenter,
    terrainDividers: terrain.terrainDividers,
    terrainMapShape: terrain.terrainMapShape,
    terrainPlateauEnabled: terrain.terrainRuntimeConfig.plateauEnabled,
    terrainShapeMagnitude: terrain.terrainRuntimeConfig.terrainShapeMagnitude,
    terrainDTerrain: terrain.terrainRuntimeConfig.terrainDTerrain,
    mapWidthLandCells: terrain.mapDimensions.widthLandCells,
    mapLengthLandCells: terrain.mapDimensions.lengthLandCells,
    converterTax: loadStoredConverterTax('real'),
  });
}

export function applySettingsAndStartRealBattleServer(
  server: GameServer,
  options: StartRealBattleServerOptions,
): void {
  applyStoredBattleServerSettings(server, 'real', {
    ipAddress: options.ipAddress,
    maxTotalUnits: loadStoredRealCap(),
  });
  server.start();
}
