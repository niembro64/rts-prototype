import { nextTick, type ComputedRef, type Ref } from 'vue';
import {
  BATTLE_CONFIG,
  getDefaultMapLandDimensions,
  loadStoredFogOfWarEnabled,
  normalizeTerrainDTerrain,
  normalizeTerrainPlateauEnabled,
  normalizeTerrainShapeMagnitude,
  saveMapLandDimensions,
  saveFogOfWarEnabled,
  saveTerrainCenter,
  saveTerrainDTerrain,
  saveTerrainDividers,
  saveTerrainMapShape,
  saveTerrainPlateauEnabled,
  saveTerrainShapeMagnitude,
  type BattleMode,
} from '../battleBarConfig';
import type {
  LobbySettings,
  NetworkManager,
  NetworkRole,
} from '../game/network/NetworkManager';
import {
  setTerrainCenterShape,
  setTerrainDividersShape,
  setTerrainMapShape,
  setTerrainRuntimeConfig,
} from '../game/sim/Terrain';
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
  applyTerrainPlateauEnabled(enabled: boolean, broadcast?: boolean): void;
  applyTerrainShapeMagnitude(value: number, broadcast?: boolean): void;
  applyTerrainDTerrain(value: number, broadcast?: boolean): void;
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
  terrainPlateauEnabled: Ref<boolean>;
  terrainShapeMagnitude: Ref<number>;
  terrainDTerrain: Ref<number>;
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
  terrainPlateauEnabled,
  terrainShapeMagnitude,
  terrainDTerrain,
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

  function applyCurrentTerrainRuntimeConfig(): void {
    setTerrainRuntimeConfig({
      plateauEnabled: terrainPlateauEnabled.value,
      terrainShapeMagnitude: terrainShapeMagnitude.value,
      terrainDTerrain: terrainDTerrain.value,
    });
  }

  function currentLobbySettings(): LobbySettings {
    return {
      terrainCenter: terrainCenter.value,
      terrainDividers: terrainDividers.value,
      terrainMapShape: terrainMapShape.value,
      terrainPlateauEnabled: terrainPlateauEnabled.value,
      terrainShapeMagnitude: terrainShapeMagnitude.value,
      terrainDTerrain: terrainDTerrain.value,
      mapWidthLandCells: mapWidthLandCells.value,
      mapLengthLandCells: mapLengthLandCells.value,
      fogOfWarEnabled: loadStoredFogOfWarEnabled('real'),
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

  function applyTerrainPlateauEnabled(
    enabled: boolean,
    broadcast = true,
  ): void {
    const mode = currentBattleMode.value;
    const normalized = normalizeTerrainPlateauEnabled(enabled);
    terrainPlateauEnabled.value = normalized;
    saveTerrainPlateauEnabled(normalized, mode);
    applyCurrentTerrainRuntimeConfig();
    restartPreviewIfNeeded();
    if (broadcast) broadcastLobbySettingsIfHost();
  }

  function applyTerrainShapeMagnitude(value: number, broadcast = true): void {
    const mode = currentBattleMode.value;
    const normalized = normalizeTerrainShapeMagnitude(value);
    terrainShapeMagnitude.value = normalized;
    saveTerrainShapeMagnitude(normalized, mode);
    applyCurrentTerrainRuntimeConfig();
    restartPreviewIfNeeded();
    if (broadcast) broadcastLobbySettingsIfHost();
  }

  function applyTerrainDTerrain(value: number, broadcast = true): void {
    const mode = currentBattleMode.value;
    const normalized = normalizeTerrainDTerrain(value);
    terrainDTerrain.value = normalized;
    saveTerrainDTerrain(normalized, mode);
    applyCurrentTerrainRuntimeConfig();
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
    const nextPlateauEnabled =
      settings.terrainPlateauEnabled === undefined
        ? terrainPlateauEnabled.value
        : normalizeTerrainPlateauEnabled(settings.terrainPlateauEnabled);
    const nextShapeMagnitude =
      settings.terrainShapeMagnitude === undefined
        ? terrainShapeMagnitude.value
        : normalizeTerrainShapeMagnitude(settings.terrainShapeMagnitude);
    const nextDTerrain =
      settings.terrainDTerrain === undefined
        ? terrainDTerrain.value
        : normalizeTerrainDTerrain(settings.terrainDTerrain);
    const fogOfWarChanged =
      settings.fogOfWarEnabled !== undefined &&
      settings.fogOfWarEnabled !== loadStoredFogOfWarEnabled('real');
    const changed =
      settings.terrainCenter !== terrainCenter.value ||
      settings.terrainDividers !== terrainDividers.value ||
      settings.terrainMapShape !== terrainMapShape.value ||
      nextPlateauEnabled !== terrainPlateauEnabled.value ||
      nextShapeMagnitude !== terrainShapeMagnitude.value ||
      nextDTerrain !== terrainDTerrain.value ||
      settings.mapWidthLandCells !== mapWidthLandCells.value ||
      settings.mapLengthLandCells !== mapLengthLandCells.value ||
      fogOfWarChanged;

    terrainCenter.value = settings.terrainCenter;
    terrainDividers.value = settings.terrainDividers;
    terrainMapShape.value = settings.terrainMapShape;
    terrainPlateauEnabled.value = nextPlateauEnabled;
    terrainShapeMagnitude.value = nextShapeMagnitude;
    terrainDTerrain.value = nextDTerrain;
    mapWidthLandCells.value = settings.mapWidthLandCells;
    mapLengthLandCells.value = settings.mapLengthLandCells;
    saveTerrainCenter(settings.terrainCenter, 'real');
    saveTerrainDividers(settings.terrainDividers, 'real');
    saveTerrainMapShape(settings.terrainMapShape, 'real');
    saveTerrainPlateauEnabled(nextPlateauEnabled, 'real');
    saveTerrainShapeMagnitude(nextShapeMagnitude, 'real');
    saveTerrainDTerrain(nextDTerrain, 'real');
    saveMapLandDimensions(
      {
        widthLandCells: settings.mapWidthLandCells,
        lengthLandCells: settings.mapLengthLandCells,
      },
      'real',
    );
    if (settings.fogOfWarEnabled !== undefined) {
      saveFogOfWarEnabled(settings.fogOfWarEnabled, 'real');
    }
    applyCurrentTerrainRuntimeConfig();
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
    const plateauEnabledDefault = BATTLE_CONFIG.plateau.enabled.default;
    const shapeMagnitudeDefault = BATTLE_CONFIG.terrainShapeMagnitude.default;
    const dTerrainDefault = BATTLE_CONFIG.terrainDTerrain.default;
    const mapDimensionsDefault = getDefaultMapLandDimensions();
    if (
      terrainCenter.value === centerDefault &&
      terrainDividers.value === dividersDefault &&
      terrainMapShape.value === mapShapeDefault &&
      terrainPlateauEnabled.value === plateauEnabledDefault &&
      terrainShapeMagnitude.value === shapeMagnitudeDefault &&
      terrainDTerrain.value === dTerrainDefault &&
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
    terrainPlateauEnabled.value = plateauEnabledDefault;
    terrainShapeMagnitude.value = shapeMagnitudeDefault;
    terrainDTerrain.value = dTerrainDefault;
    mapWidthLandCells.value = mapDimensionsDefault.widthLandCells;
    mapLengthLandCells.value = mapDimensionsDefault.lengthLandCells;
    saveTerrainCenter(centerDefault, mode);
    saveTerrainDividers(dividersDefault, mode);
    saveTerrainMapShape(mapShapeDefault, mode);
    saveTerrainPlateauEnabled(plateauEnabledDefault, mode);
    saveTerrainShapeMagnitude(shapeMagnitudeDefault, mode);
    saveTerrainDTerrain(dTerrainDefault, mode);
    saveMapLandDimensions(mapDimensionsDefault, mode);
    applyCurrentTerrainRuntimeConfig();
    restartPreviewIfNeeded();
  }

  return {
    currentLobbySettings,
    broadcastLobbySettingsIfHost,
    applyTerrainShape,
    applyTerrainMapShape,
    applyTerrainPlateauEnabled,
    applyTerrainShapeMagnitude,
    applyTerrainDTerrain,
    applyMapLandDimensions,
    applyLobbySettingsFromHost,
    resetTerrainDefaults,
  };
}
