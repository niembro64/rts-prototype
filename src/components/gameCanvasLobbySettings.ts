import { nextTick, type ComputedRef, type Ref } from 'vue';
import {
  BATTLE_CONFIG,
  getDefaultMapLandDimensions,
  loadStoredConverterTax,
  loadStoredFogOfWarEnabled,
  normalizeCenterMagnitude,
  normalizeConverterTax,
  normalizeDividersMagnitude,
  normalizeMetalDepositStep,
  normalizeTerrainDTerrain,
  normalizeTerrainPlateauEnabled,
  saveCenterMagnitude,
  saveConverterTax,
  saveDividersMagnitude,
  saveMapLandDimensions,
  saveFogOfWarEnabled,
  saveMetalDepositStep,
  saveTerrainDTerrain,
  saveTerrainMapShape,
  saveTerrainPlateauEnabled,
  type BattleMode,
} from '../battleBarConfig';
import type {
  LobbySettings,
  NetworkManager,
  NetworkRole,
} from '../game/network/NetworkManager';
import {
  setTerrainMapShape,
  setTerrainRuntimeConfig,
} from '../game/sim/Terrain';
import type { MapLandCellDimensions } from '../mapSizeConfig';
import type { TerrainMapShape } from '../types/terrain';

export type GameCanvasLobbySettings = {
  currentLobbySettings(): LobbySettings;
  broadcastLobbySettingsIfHost(): void;
  applyCenterMagnitude(value: number, broadcast?: boolean): void;
  applyDividersMagnitude(value: number, broadcast?: boolean): void;
  applyTerrainMapShape(shape: TerrainMapShape, broadcast?: boolean): void;
  applyTerrainPlateauEnabled(enabled: boolean, broadcast?: boolean): void;
  applyTerrainDTerrain(value: number, broadcast?: boolean): void;
  applyMetalDepositStep(value: number, broadcast?: boolean): void;
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
  centerMagnitude: Ref<number>;
  dividersMagnitude: Ref<number>;
  terrainMapShape: Ref<TerrainMapShape>;
  terrainPlateauEnabled: Ref<boolean>;
  terrainDTerrain: Ref<number>;
  metalDepositStep: Ref<number>;
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
  centerMagnitude,
  dividersMagnitude,
  terrainMapShape,
  terrainPlateauEnabled,
  terrainDTerrain,
  metalDepositStep,
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
      centerMagnitude: centerMagnitude.value,
      dividersMagnitude: dividersMagnitude.value,
      terrainDTerrain: terrainDTerrain.value,
      metalDepositStep: metalDepositStep.value,
    });
  }

  function currentLobbySettings(): LobbySettings {
    return {
      centerMagnitude: centerMagnitude.value,
      dividersMagnitude: dividersMagnitude.value,
      terrainMapShape: terrainMapShape.value,
      terrainPlateauEnabled: terrainPlateauEnabled.value,
      terrainDTerrain: terrainDTerrain.value,
      metalDepositStep: metalDepositStep.value,
      mapWidthLandCells: mapWidthLandCells.value,
      mapLengthLandCells: mapLengthLandCells.value,
      fogOfWarEnabled: loadStoredFogOfWarEnabled('real'),
      converterTax: loadStoredConverterTax('real'),
    };
  }

  function broadcastLobbySettingsIfHost(): void {
    if (networkRole.value === 'host' && roomCode.value !== '') {
      network.broadcastLobbySettings(currentLobbySettings());
    }
  }

  function applyCenterMagnitude(value: number, broadcast = true): void {
    const mode = currentBattleMode.value;
    const normalized = normalizeCenterMagnitude(value);
    centerMagnitude.value = normalized;
    saveCenterMagnitude(normalized, mode);
    applyCurrentTerrainRuntimeConfig();
    restartPreviewIfNeeded();
    if (broadcast) broadcastLobbySettingsIfHost();
  }

  function applyDividersMagnitude(value: number, broadcast = true): void {
    const mode = currentBattleMode.value;
    const normalized = normalizeDividersMagnitude(value);
    dividersMagnitude.value = normalized;
    saveDividersMagnitude(normalized, mode);
    applyCurrentTerrainRuntimeConfig();
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

  function applyTerrainDTerrain(value: number, broadcast = true): void {
    const mode = currentBattleMode.value;
    const normalized = normalizeTerrainDTerrain(value);
    terrainDTerrain.value = normalized;
    saveTerrainDTerrain(normalized, mode);
    applyCurrentTerrainRuntimeConfig();
    restartPreviewIfNeeded();
    if (broadcast) broadcastLobbySettingsIfHost();
  }

  function applyMetalDepositStep(value: number, broadcast = true): void {
    const mode = currentBattleMode.value;
    const normalized = normalizeMetalDepositStep(value);
    metalDepositStep.value = normalized;
    saveMetalDepositStep(normalized, mode);
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
    const nextCenterMagnitude = normalizeCenterMagnitude(settings.centerMagnitude);
    const nextDividersMagnitude = normalizeDividersMagnitude(
      settings.dividersMagnitude,
    );
    const nextDTerrain =
      settings.terrainDTerrain === undefined
        ? terrainDTerrain.value
        : normalizeTerrainDTerrain(settings.terrainDTerrain);
    const nextMetalDepositStep =
      settings.metalDepositStep === undefined
        ? metalDepositStep.value
        : normalizeMetalDepositStep(settings.metalDepositStep);
    const fogOfWarChanged =
      settings.fogOfWarEnabled !== undefined &&
      settings.fogOfWarEnabled !== loadStoredFogOfWarEnabled('real');
    const changed =
      nextCenterMagnitude !== centerMagnitude.value ||
      nextDividersMagnitude !== dividersMagnitude.value ||
      settings.terrainMapShape !== terrainMapShape.value ||
      nextPlateauEnabled !== terrainPlateauEnabled.value ||
      nextDTerrain !== terrainDTerrain.value ||
      nextMetalDepositStep !== metalDepositStep.value ||
      settings.mapWidthLandCells !== mapWidthLandCells.value ||
      settings.mapLengthLandCells !== mapLengthLandCells.value ||
      fogOfWarChanged;

    centerMagnitude.value = nextCenterMagnitude;
    dividersMagnitude.value = nextDividersMagnitude;
    terrainMapShape.value = settings.terrainMapShape;
    terrainPlateauEnabled.value = nextPlateauEnabled;
    terrainDTerrain.value = nextDTerrain;
    metalDepositStep.value = nextMetalDepositStep;
    mapWidthLandCells.value = settings.mapWidthLandCells;
    mapLengthLandCells.value = settings.mapLengthLandCells;
    saveCenterMagnitude(nextCenterMagnitude, 'real');
    saveDividersMagnitude(nextDividersMagnitude, 'real');
    saveTerrainMapShape(settings.terrainMapShape, 'real');
    saveTerrainPlateauEnabled(nextPlateauEnabled, 'real');
    saveTerrainDTerrain(nextDTerrain, 'real');
    saveMetalDepositStep(nextMetalDepositStep, 'real');
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
    if (settings.converterTax !== undefined) {
      saveConverterTax(normalizeConverterTax(settings.converterTax), 'real');
    }
    applyCurrentTerrainRuntimeConfig();
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
    const centerMagnitudeDefault = BATTLE_CONFIG.centerMagnitude.default;
    const dividersMagnitudeDefault = BATTLE_CONFIG.dividersMagnitude.default;
    const mapShapeDefault = BATTLE_CONFIG.mapShape.default;
    const plateauEnabledDefault = BATTLE_CONFIG.plateau.enabled.default;
    const dTerrainDefault = BATTLE_CONFIG.terrainDTerrain.default;
    const metalDepositStepDefault = BATTLE_CONFIG.metalDepositStep.default;
    const mapDimensionsDefault = getDefaultMapLandDimensions();
    if (
      centerMagnitude.value === centerMagnitudeDefault &&
      dividersMagnitude.value === dividersMagnitudeDefault &&
      terrainMapShape.value === mapShapeDefault &&
      terrainPlateauEnabled.value === plateauEnabledDefault &&
      terrainDTerrain.value === dTerrainDefault &&
      metalDepositStep.value === metalDepositStepDefault &&
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

    centerMagnitude.value = centerMagnitudeDefault;
    dividersMagnitude.value = dividersMagnitudeDefault;
    terrainMapShape.value = mapShapeDefault;
    terrainPlateauEnabled.value = plateauEnabledDefault;
    terrainDTerrain.value = dTerrainDefault;
    metalDepositStep.value = metalDepositStepDefault;
    mapWidthLandCells.value = mapDimensionsDefault.widthLandCells;
    mapLengthLandCells.value = mapDimensionsDefault.lengthLandCells;
    saveCenterMagnitude(centerMagnitudeDefault, mode);
    saveDividersMagnitude(dividersMagnitudeDefault, mode);
    saveTerrainMapShape(mapShapeDefault, mode);
    saveTerrainPlateauEnabled(plateauEnabledDefault, mode);
    saveTerrainDTerrain(dTerrainDefault, mode);
    saveMetalDepositStep(metalDepositStepDefault, mode);
    saveMapLandDimensions(mapDimensionsDefault, mode);
    applyCurrentTerrainRuntimeConfig();
    restartPreviewIfNeeded();
  }

  return {
    currentLobbySettings,
    broadcastLobbySettingsIfHost,
    applyCenterMagnitude,
    applyDividersMagnitude,
    applyTerrainMapShape,
    applyTerrainPlateauEnabled,
    applyTerrainDTerrain,
    applyMetalDepositStep,
    applyMapLandDimensions,
    applyLobbySettingsFromHost,
    resetTerrainDefaults,
  };
}
