import { nextTick, type ComputedRef, type Ref } from 'vue';
import {
  BATTLE_CONFIG,
  getDefaultMapLandDimensions,
  saveMapLandDimensions,
  saveTerrainCenter,
  saveTerrainDividers,
  saveTerrainMapShape,
  type BattleMode,
} from '../battleBarConfig';
import type {
  LobbySettings,
  NetworkManager,
  NetworkRole,
} from '../game/network/NetworkManager';
import { setTerrainCenterShape, setTerrainDividersShape, setTerrainMapShape } from '../game/sim/Terrain';
import type { MapLandCellDimensions } from '../mapSizeConfig';
import type { TerrainMapShape, TerrainShape } from '../types/terrain';

export type GameCanvasLobbySettings = {
  currentLobbySettings(): LobbySettings;
  broadcastLobbySettingsIfHost(): void;
  applyTerrainShape(
    kind: 'center' | 'dividers',
    shape: TerrainShape,
    broadcast?: boolean,
  ): void;
  applyTerrainMapShape(shape: TerrainMapShape, broadcast?: boolean): void;
  applyMapLandDimensions(
    dimensions: MapLandCellDimensions,
    broadcast?: boolean,
  ): void;
  applyLobbySettingsFromHost(
    settings: LobbySettings,
    options?: { restartPreview?: boolean },
  ): void;
  resetTerrainDefaults(): void;
};

export type GameCanvasLobbySettingsOptions = {
  network: NetworkManager;
  currentBattleMode: ComputedRef<BattleMode>;
  networkRole: Ref<NetworkRole | null>;
  roomCode: Ref<string>;
  gameStarted: Ref<boolean>;
  terrainCenter: Ref<TerrainShape>;
  terrainDividers: Ref<TerrainShape>;
  terrainMapShape: Ref<TerrainMapShape>;
  mapWidthLandCells: Ref<number>;
  mapLengthLandCells: Ref<number>;
  stopBackgroundBattle: () => void;
  startBackgroundBattle: () => void;
};

function sameMapLandDimensions(
  a: MapLandCellDimensions,
  b: MapLandCellDimensions,
): boolean {
  return (
    a.widthLandCells === b.widthLandCells &&
    a.lengthLandCells === b.lengthLandCells
  );
}

export function useGameCanvasLobbySettings({
  network,
  currentBattleMode,
  networkRole,
  roomCode,
  gameStarted,
  terrainCenter,
  terrainDividers,
  terrainMapShape,
  mapWidthLandCells,
  mapLengthLandCells,
  stopBackgroundBattle,
  startBackgroundBattle,
}: GameCanvasLobbySettingsOptions): GameCanvasLobbySettings {
  function restartPreviewIfNeeded(): void {
    if (gameStarted.value) return;
    stopBackgroundBattle();
    nextTick(() => {
      startBackgroundBattle();
    });
  }

  function currentLobbySettings(): LobbySettings {
    return {
      terrainCenter: terrainCenter.value,
      terrainDividers: terrainDividers.value,
      terrainMapShape: terrainMapShape.value,
      mapWidthLandCells: mapWidthLandCells.value,
      mapLengthLandCells: mapLengthLandCells.value,
    };
  }

  function broadcastLobbySettingsIfHost(): void {
    if (networkRole.value === 'host' && roomCode.value !== '') {
      network.broadcastLobbySettings(currentLobbySettings());
    }
  }

  function applyTerrainShape(
    kind: 'center' | 'dividers',
    shape: TerrainShape,
    broadcast = true,
  ): void {
    const mode = currentBattleMode.value;
    if (kind === 'center') {
      terrainCenter.value = shape;
      saveTerrainCenter(shape, mode);
    } else {
      terrainDividers.value = shape;
      saveTerrainDividers(shape, mode);
    }
    restartPreviewIfNeeded();
    if (broadcast) broadcastLobbySettingsIfHost();
  }

  function applyTerrainMapShape(shape: TerrainMapShape, broadcast = true): void {
    const mode = currentBattleMode.value;
    terrainMapShape.value = shape;
    saveTerrainMapShape(shape, mode);
    restartPreviewIfNeeded();
    if (broadcast) broadcastLobbySettingsIfHost();
  }

  function applyMapLandDimensions(
    dimensions: MapLandCellDimensions,
    broadcast = true,
  ): void {
    const mode = currentBattleMode.value;
    mapWidthLandCells.value = dimensions.widthLandCells;
    mapLengthLandCells.value = dimensions.lengthLandCells;
    saveMapLandDimensions(dimensions, mode);
    restartPreviewIfNeeded();
    if (broadcast) broadcastLobbySettingsIfHost();
  }

  function applyLobbySettingsFromHost(
    settings: LobbySettings,
    options: { restartPreview?: boolean } = {},
  ): void {
    const changed =
      settings.terrainCenter !== terrainCenter.value ||
      settings.terrainDividers !== terrainDividers.value ||
      settings.terrainMapShape !== terrainMapShape.value ||
      settings.mapWidthLandCells !== mapWidthLandCells.value ||
      settings.mapLengthLandCells !== mapLengthLandCells.value;

    terrainCenter.value = settings.terrainCenter;
    terrainDividers.value = settings.terrainDividers;
    terrainMapShape.value = settings.terrainMapShape;
    mapWidthLandCells.value = settings.mapWidthLandCells;
    mapLengthLandCells.value = settings.mapLengthLandCells;
    saveTerrainCenter(settings.terrainCenter, 'real');
    saveTerrainDividers(settings.terrainDividers, 'real');
    saveTerrainMapShape(settings.terrainMapShape, 'real');
    saveMapLandDimensions(
      {
        widthLandCells: settings.mapWidthLandCells,
        lengthLandCells: settings.mapLengthLandCells,
      },
      'real',
    );
    setTerrainCenterShape(settings.terrainCenter);
    setTerrainDividersShape(settings.terrainDividers);
    setTerrainMapShape(settings.terrainMapShape);

    const restartPreview = options.restartPreview ?? true;
    if (
      restartPreview &&
      changed &&
      !gameStarted.value &&
      currentBattleMode.value === 'real'
    ) {
      restartPreviewIfNeeded();
    }
  }

  function resetTerrainDefaults(): void {
    const mode = currentBattleMode.value;
    const centerDefault = BATTLE_CONFIG.center.default;
    const dividersDefault = BATTLE_CONFIG.dividers.default;
    const mapShapeDefault = BATTLE_CONFIG.mapShape.default;
    const mapDimensionsDefault = getDefaultMapLandDimensions();
    if (
      terrainCenter.value === centerDefault &&
      terrainDividers.value === dividersDefault &&
      terrainMapShape.value === mapShapeDefault &&
      sameMapLandDimensions(
        {
          widthLandCells: mapWidthLandCells.value,
          lengthLandCells: mapLengthLandCells.value,
        },
        mapDimensionsDefault,
      )
    ) {
      return;
    }

    terrainCenter.value = centerDefault;
    terrainDividers.value = dividersDefault;
    terrainMapShape.value = mapShapeDefault;
    mapWidthLandCells.value = mapDimensionsDefault.widthLandCells;
    mapLengthLandCells.value = mapDimensionsDefault.lengthLandCells;
    saveTerrainCenter(centerDefault, mode);
    saveTerrainDividers(dividersDefault, mode);
    saveTerrainMapShape(mapShapeDefault, mode);
    saveMapLandDimensions(mapDimensionsDefault, mode);
    restartPreviewIfNeeded();
  }

  return {
    currentLobbySettings,
    broadcastLobbySettingsIfHost,
    applyTerrainShape,
    applyTerrainMapShape,
    applyMapLandDimensions,
    applyLobbySettingsFromHost,
    resetTerrainDefaults,
  };
}
