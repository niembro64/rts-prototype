import { nextTick, type ComputedRef, type Ref } from 'vue';
import {
  BATTLE_CONFIG,
  getDefaultMapLandDimensions,
  loadStoredConverterTax,
  loadStoredFogOfWarEnabled,
  normalizeCenterMagnitude,
  normalizeConverterTax,
  normalizeDividersMagnitude,
  normalizeTerrainDTerrain,
  normalizeTerrainPlateauAmount,
  saveCenterMagnitude,
  saveConverterTax,
  saveDividersMagnitude,
  saveMapLandDimensions,
  saveFogOfWarEnabled,
  saveTerrainDTerrain,
  saveTerrainMapShape,
  saveTerrainPlateauAmount,
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
  applyTerrainPlateauAmount(amount: number, broadcast?: boolean): void;
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
  centerMagnitude: Ref<number>;
  dividersMagnitude: Ref<number>;
  terrainMapShape: Ref<TerrainMapShape>;
  terrainPlateauAmount: Ref<number>;
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
  centerMagnitude,
  dividersMagnitude,
  terrainMapShape,
  terrainPlateauAmount,
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
      plateauAmount: terrainPlateauAmount.value,
      centerMagnitude: centerMagnitude.value,
      dividersMagnitude: dividersMagnitude.value,
      terrainDTerrain: terrainDTerrain.value,
    });
  }

  function currentLobbySettings(): LobbySettings {
    return {
      centerMagnitude: centerMagnitude.value,
      dividersMagnitude: dividersMagnitude.value,
      terrainMapShape: terrainMapShape.value,
      terrainPlateauAmount: terrainPlateauAmount.value,
      terrainDTerrain: terrainDTerrain.value,
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

  function applyTerrainPlateauAmount(
    amount: number,
    broadcast = true,
  ): void {
    const mode = currentBattleMode.value;
    const normalized = normalizeTerrainPlateauAmount(amount);
    terrainPlateauAmount.value = normalized;
    saveTerrainPlateauAmount(normalized, mode);
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
    const nextPlateauAmount =
      settings.terrainPlateauAmount === undefined
        ? terrainPlateauAmount.value
        : normalizeTerrainPlateauAmount(settings.terrainPlateauAmount);
    const nextCenterMagnitude = normalizeCenterMagnitude(settings.centerMagnitude);
    const nextDividersMagnitude = normalizeDividersMagnitude(
      settings.dividersMagnitude,
    );
    const nextDTerrain =
      settings.terrainDTerrain === undefined
        ? terrainDTerrain.value
        : normalizeTerrainDTerrain(settings.terrainDTerrain);
    const fogOfWarChanged =
      settings.fogOfWarEnabled !== undefined &&
      settings.fogOfWarEnabled !== loadStoredFogOfWarEnabled('real');
    const changed =
      nextCenterMagnitude !== centerMagnitude.value ||
      nextDividersMagnitude !== dividersMagnitude.value ||
      settings.terrainMapShape !== terrainMapShape.value ||
      nextPlateauAmount !== terrainPlateauAmount.value ||
      nextDTerrain !== terrainDTerrain.value ||
      settings.mapWidthLandCells !== mapWidthLandCells.value ||
      settings.mapLengthLandCells !== mapLengthLandCells.value ||
      fogOfWarChanged;

    centerMagnitude.value = nextCenterMagnitude;
    dividersMagnitude.value = nextDividersMagnitude;
    terrainMapShape.value = settings.terrainMapShape;
    terrainPlateauAmount.value = nextPlateauAmount;
    terrainDTerrain.value = nextDTerrain;
    mapWidthLandCells.value = settings.mapWidthLandCells;
    mapLengthLandCells.value = settings.mapLengthLandCells;
    saveCenterMagnitude(nextCenterMagnitude, 'real');
    saveDividersMagnitude(nextDividersMagnitude, 'real');
    saveTerrainMapShape(settings.terrainMapShape, 'real');
    saveTerrainPlateauAmount(nextPlateauAmount, 'real');
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
    const plateauAmountDefault = BATTLE_CONFIG.plateau.amount.default;
    const dTerrainDefault = BATTLE_CONFIG.terrainDTerrain.default;
    const mapDimensionsDefault = getDefaultMapLandDimensions();
    if (
      centerMagnitude.value === centerMagnitudeDefault &&
      dividersMagnitude.value === dividersMagnitudeDefault &&
      terrainMapShape.value === mapShapeDefault &&
      terrainPlateauAmount.value === plateauAmountDefault &&
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

    centerMagnitude.value = centerMagnitudeDefault;
    dividersMagnitude.value = dividersMagnitudeDefault;
    terrainMapShape.value = mapShapeDefault;
    terrainPlateauAmount.value = plateauAmountDefault;
    terrainDTerrain.value = dTerrainDefault;
    mapWidthLandCells.value = mapDimensionsDefault.widthLandCells;
    mapLengthLandCells.value = mapDimensionsDefault.lengthLandCells;
    saveCenterMagnitude(centerMagnitudeDefault, mode);
    saveDividersMagnitude(dividersMagnitudeDefault, mode);
    saveTerrainMapShape(mapShapeDefault, mode);
    saveTerrainPlateauAmount(plateauAmountDefault, mode);
    saveTerrainDTerrain(dTerrainDefault, mode);
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
    applyTerrainPlateauAmount,
    applyTerrainDTerrain,
    applyMapLandDimensions,
    applyLobbySettingsFromHost,
    resetTerrainDefaults,
  };
}
