import { getMapSize } from '../config';
import {
  loadStoredMapLandDimensions,
  loadStoredRealCap,
  loadStoredTerrainCenter,
  loadStoredTerrainDividers,
  loadStoredTerrainMapShape,
} from '../battleBarConfig';
import { setTerrainCenterShape, setTerrainDividersShape, setTerrainMapShape } from '../game/sim/Terrain';
import { GameServer } from '../game/server/GameServer';
import { LocalGameConnection } from '../game/server/LocalGameConnection';
import { RemoteGameConnection } from '../game/server/RemoteGameConnection';
import { applyStoredBattleServerSettings } from '../game/server/battleServerSettings';
import type { GameConnection } from '../game/server/GameConnection';
import type { PlayerId } from '../game/sim/types';
import type { MapLandCellDimensions } from '../mapSizeConfig';
import type { TerrainMapShape, TerrainShape } from '../types/terrain';
import type { ServerSimQuality, ServerSimSignalStates } from '../types/serverSimLod';

export type RealBattleStartupTerrain = {
  terrainCenter: TerrainShape;
  terrainDividers: TerrainShape;
  terrainMapShape: TerrainMapShape;
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
  simQuality: ServerSimQuality;
  simSignalStates: ServerSimSignalStates;
};

export function loadAndApplyRealBattleTerrain(): RealBattleStartupTerrain {
  const terrainCenter = loadStoredTerrainCenter('real');
  const terrainDividers = loadStoredTerrainDividers('real');
  const terrainMapShape = loadStoredTerrainMapShape('real');
  const mapDimensions = loadStoredMapLandDimensions('real');
  const mapSize = getMapSize(
    false,
    mapDimensions.widthLandCells,
    mapDimensions.lengthLandCells,
  );
  setTerrainCenterShape(terrainCenter);
  setTerrainDividersShape(terrainDividers);
  setTerrainMapShape(terrainMapShape);
  return {
    terrainCenter,
    terrainDividers,
    terrainMapShape,
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
): GameConnection {
  return new LocalGameConnection(server, localPlayerId);
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
    mapWidthLandCells: terrain.mapDimensions.widthLandCells,
    mapLengthLandCells: terrain.mapDimensions.lengthLandCells,
  });
}

export function applySettingsAndStartRealBattleServer(
  server: GameServer,
  options: StartRealBattleServerOptions,
): void {
  applyStoredBattleServerSettings(server, 'real', {
    ipAddress: options.ipAddress,
    maxTotalUnits: loadStoredRealCap(),
    simQuality: options.simQuality,
    simSignalStates: options.simSignalStates,
  });
  server.start();
}
