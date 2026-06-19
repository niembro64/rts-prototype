import { nextTick, type ComputedRef, type Ref } from 'vue';
import {
  BATTLE_CONFIG,
  getDefaultMapLandDimensions,
  loadStoredConverterTax,
  loadStoredRealCap,
  normalizeCenterMagnitude,
  normalizeConverterTax,
  normalizeDividersMagnitude,
  normalizeMetalDepositStep,
  normalizeTerrainDTerrain,
  normalizeTerrainDetail,
  saveCenterMagnitude,
  saveConverterTax,
  saveDividersMagnitude,
  saveMapLandDimensions,
  saveMetalDepositStep,
  saveStoredCap,
  saveTerrainDTerrain,
  saveTerrainDetail,
  saveTerrainMapShape,
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

type GameCanvasLobbySettings = {
  currentLobbySettings(): LobbySettings;
  broadcastLobbySettingsIfHost(): void;
  applyCenterMagnitude(value: number, broadcast?: boolean): void;
  applyDividersMagnitude(value: number, broadcast?: boolean): void;
  applyTerrainMapShape(shape: TerrainMapShape, broadcast?: boolean): void;
  applyTerrainDTerrain(value: number, broadcast?: boolean): void;
  applyMetalDepositStep(value: number, broadcast?: boolean): void;
  applyTerrainDetail(value: number, broadcast?: boolean): void;
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

type GameCanvasLobbySettingsOptions = {
  network: NetworkManager;
  currentBattleMode: ComputedRef<BattleMode>;
  networkRole: Ref<NetworkRole | null>;
  roomCode: Ref<string>;
  gameStarted: Ref<boolean>;
  centerMagnitude: Ref<number>;
  dividersMagnitude: Ref<number>;
  terrainMapShape: Ref<TerrainMapShape>;
  terrainDTerrain: Ref<number>;
  metalDepositStep: Ref<number>;
  terrainDetail: Ref<number>;
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
  terrainDTerrain,
  metalDepositStep,
  terrainDetail,
  mapWidthLandCells,
  mapLengthLandCells,
  stopBackgroundBattle,
  startBackgroundBattle,
}: GameCanvasLobbySettingsOptions): GameCanvasLobbySettings {
  let previewRestartQueued = false;

  function restartPreviewIfNeeded(): void {
    if (gameStarted.value) return;
    if (previewRestartQueued) return;
    previewRestartQueued = true;
    stopBackgroundBattle();
    nextTick(() => {
      previewRestartQueued = false;
      startBackgroundBattle();
    });
  }

  function applyCurrentTerrainRuntimeConfig(): void {
    setTerrainRuntimeConfig({
      centerMagnitude: centerMagnitude.value,
      dividersMagnitude: dividersMagnitude.value,
      terrainDTerrain: terrainDTerrain.value,
      metalDepositStep: metalDepositStep.value,
      terrainDetail: terrainDetail.value,
    });
  }

  function currentLobbySettings(): LobbySettings {
    return {
      centerMagnitude: centerMagnitude.value,
      dividersMagnitude: dividersMagnitude.value,
      terrainMapShape: terrainMapShape.value,
      terrainDTerrain: terrainDTerrain.value,
      metalDepositStep: metalDepositStep.value,
      terrainDetail: terrainDetail.value,
      mapWidthLandCells: mapWidthLandCells.value,
      mapLengthLandCells: mapLengthLandCells.value,
      maxTotalUnits: loadStoredRealCap(),
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
    const changed = centerMagnitude.value !== normalized;
    centerMagnitude.value = normalized;
    saveCenterMagnitude(normalized, mode);
    if (!changed) return;
    applyCurrentTerrainRuntimeConfig();
    restartPreviewIfNeeded();
    if (broadcast) broadcastLobbySettingsIfHost();
  }

  function applyDividersMagnitude(value: number, broadcast = true): void {
    const mode = currentBattleMode.value;
    const normalized = normalizeDividersMagnitude(value);
    const changed = dividersMagnitude.value !== normalized;
    dividersMagnitude.value = normalized;
    saveDividersMagnitude(normalized, mode);
    if (!changed) return;
    applyCurrentTerrainRuntimeConfig();
    restartPreviewIfNeeded();
    if (broadcast) broadcastLobbySettingsIfHost();
  }

  function applyTerrainMapShape(shape: TerrainMapShape, broadcast = true): void {
    const mode = currentBattleMode.value;
    const changed = terrainMapShape.value !== shape;
    terrainMapShape.value = shape;
    saveTerrainMapShape(shape, mode);
    if (!changed) return;
    restartPreviewIfNeeded();
    if (broadcast) broadcastLobbySettingsIfHost();
  }

  function applyTerrainDTerrain(value: number, broadcast = true): void {
    const mode = currentBattleMode.value;
    const normalized = normalizeTerrainDTerrain(value);
    const changed = terrainDTerrain.value !== normalized;
    terrainDTerrain.value = normalized;
    saveTerrainDTerrain(normalized, mode);
    if (!changed) return;
    applyCurrentTerrainRuntimeConfig();
    restartPreviewIfNeeded();
    if (broadcast) broadcastLobbySettingsIfHost();
  }

  function applyMetalDepositStep(value: number, broadcast = true): void {
    const mode = currentBattleMode.value;
    const normalized = normalizeMetalDepositStep(value);
    const changed = metalDepositStep.value !== normalized;
    metalDepositStep.value = normalized;
    saveMetalDepositStep(normalized, mode);
    if (!changed) return;
    applyCurrentTerrainRuntimeConfig();
    restartPreviewIfNeeded();
    if (broadcast) broadcastLobbySettingsIfHost();
  }

  function applyTerrainDetail(value: number, broadcast = true): void {
    const mode = currentBattleMode.value;
    const normalized = normalizeTerrainDetail(value);
    const changed = terrainDetail.value !== normalized;
    terrainDetail.value = normalized;
    saveTerrainDetail(normalized, mode);
    if (!changed) return;
    applyCurrentTerrainRuntimeConfig();
    restartPreviewIfNeeded();
    if (broadcast) broadcastLobbySettingsIfHost();
  }

  function applyMapLandDimensions(
    dimensions: MapLandCellDimensions,
    broadcast = true,
  ): void {
    const mode = currentBattleMode.value;
    const changed = !sameMapLandDimensions(
      {
        widthLandCells: mapWidthLandCells.value,
        lengthLandCells: mapLengthLandCells.value,
      },
      dimensions,
    );
    mapWidthLandCells.value = dimensions.widthLandCells;
    mapLengthLandCells.value = dimensions.lengthLandCells;
    saveMapLandDimensions(dimensions, mode);
    if (!changed) return;
    restartPreviewIfNeeded();
    if (broadcast) broadcastLobbySettingsIfHost();
  }

  function applyLobbySettingsFromHost(
    settings: LobbySettings,
    options: { restartPreview?: boolean } = {},
  ): void {
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
    const nextTerrainDetail =
      settings.terrainDetail === undefined
        ? terrainDetail.value
        : normalizeTerrainDetail(settings.terrainDetail);
    const changed =
      nextCenterMagnitude !== centerMagnitude.value ||
      nextDividersMagnitude !== dividersMagnitude.value ||
      settings.terrainMapShape !== terrainMapShape.value ||
      nextDTerrain !== terrainDTerrain.value ||
      nextMetalDepositStep !== metalDepositStep.value ||
      nextTerrainDetail !== terrainDetail.value ||
      settings.mapWidthLandCells !== mapWidthLandCells.value ||
      settings.mapLengthLandCells !== mapLengthLandCells.value;

    centerMagnitude.value = nextCenterMagnitude;
    dividersMagnitude.value = nextDividersMagnitude;
    terrainMapShape.value = settings.terrainMapShape;
    terrainDTerrain.value = nextDTerrain;
    metalDepositStep.value = nextMetalDepositStep;
    terrainDetail.value = nextTerrainDetail;
    mapWidthLandCells.value = settings.mapWidthLandCells;
    mapLengthLandCells.value = settings.mapLengthLandCells;
    saveCenterMagnitude(nextCenterMagnitude, 'real');
    saveDividersMagnitude(nextDividersMagnitude, 'real');
    saveTerrainMapShape(settings.terrainMapShape, 'real');
    saveTerrainDTerrain(nextDTerrain, 'real');
    saveMetalDepositStep(nextMetalDepositStep, 'real');
    saveTerrainDetail(nextTerrainDetail, 'real');
    saveMapLandDimensions(
      {
        widthLandCells: settings.mapWidthLandCells,
        lengthLandCells: settings.mapLengthLandCells,
      },
      'real',
    );
    if (settings.converterTax !== undefined) {
      saveConverterTax(normalizeConverterTax(settings.converterTax), 'real');
    }
    if (
      settings.maxTotalUnits !== undefined &&
      Number.isFinite(settings.maxTotalUnits) &&
      settings.maxTotalUnits > 0
    ) {
      saveStoredCap('real', settings.maxTotalUnits);
    }
    if (changed) {
      applyCurrentTerrainRuntimeConfig();
      setTerrainMapShape(settings.terrainMapShape);
    }

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
    const dTerrainDefault = BATTLE_CONFIG.terrainDTerrain.default;
    const metalDepositStepDefault = BATTLE_CONFIG.metalDepositStep.default;
    const terrainDetailDefault = BATTLE_CONFIG.terrainDetail.default;
    const mapDimensionsDefault = getDefaultMapLandDimensions();
    if (
      centerMagnitude.value === centerMagnitudeDefault &&
      dividersMagnitude.value === dividersMagnitudeDefault &&
      terrainMapShape.value === mapShapeDefault &&
      terrainDTerrain.value === dTerrainDefault &&
      metalDepositStep.value === metalDepositStepDefault &&
      terrainDetail.value === terrainDetailDefault &&
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
    terrainDTerrain.value = dTerrainDefault;
    metalDepositStep.value = metalDepositStepDefault;
    terrainDetail.value = terrainDetailDefault;
    mapWidthLandCells.value = mapDimensionsDefault.widthLandCells;
    mapLengthLandCells.value = mapDimensionsDefault.lengthLandCells;
    saveCenterMagnitude(centerMagnitudeDefault, mode);
    saveDividersMagnitude(dividersMagnitudeDefault, mode);
    saveTerrainMapShape(mapShapeDefault, mode);
    saveTerrainDTerrain(dTerrainDefault, mode);
    saveMetalDepositStep(metalDepositStepDefault, mode);
    saveTerrainDetail(terrainDetailDefault, mode);
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
    applyTerrainDTerrain,
    applyMetalDepositStep,
    applyTerrainDetail,
    applyMapLandDimensions,
    applyLobbySettingsFromHost,
    resetTerrainDefaults,
  };
}
