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
  normalizePlateauWallSlopeDegrees,
  normalizePerimeterMagnitude,
  normalizeTerrainDTerrain,
  normalizeTerrainDetail,
  savePlateauWallSlopeDegrees,
  saveCenterMagnitude,
  saveConverterTax,
  saveDividersMagnitude,
  saveMapLandDimensions,
  saveMetalDepositStep,
  savePerimeterMagnitude,
  saveStoredCap,
  saveTerrainDTerrain,
  saveTerrainDetail,
  type BattleMode,
} from '../battleBarConfig';
import type {
  LobbySettings,
  NetworkManager,
  NetworkRole,
} from '../game/network/NetworkManager';
import { setTerrainRuntimeConfig } from '../game/sim/Terrain';
import type { MapLandCellDimensions } from '../mapSizeConfig';

type GameCanvasLobbySettings = {
  currentLobbySettings(): LobbySettings;
  broadcastLobbySettingsIfHost(): void;
  applyCenterMagnitude(value: number, broadcast?: boolean): void;
  applyDividersMagnitude(value: number, broadcast?: boolean): void;
  applyPerimeterMagnitude(value: number, broadcast?: boolean): void;
  applyTerrainDTerrain(value: number, broadcast?: boolean): void;
  applyPlateauWallSlopeDegrees(value: number, broadcast?: boolean): void;
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
  perimeterMagnitude: Ref<number>;
  terrainDTerrain: Ref<number>;
  plateauWallSlopeDegrees: Ref<number>;
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
  perimeterMagnitude,
  terrainDTerrain,
  plateauWallSlopeDegrees,
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
      perimeterMagnitude: perimeterMagnitude.value,
      terrainDTerrain: terrainDTerrain.value,
      plateauWallSlopeDegrees: plateauWallSlopeDegrees.value,
      metalDepositStep: metalDepositStep.value,
      terrainDetail: terrainDetail.value,
    });
  }

  function currentLobbySettings(): LobbySettings {
    return {
      centerMagnitude: centerMagnitude.value,
      dividersMagnitude: dividersMagnitude.value,
      perimeterMagnitude: perimeterMagnitude.value,
      terrainDTerrain: terrainDTerrain.value,
      plateauWallSlopeDegrees: plateauWallSlopeDegrees.value,
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

  function applyPerimeterMagnitude(value: number, broadcast = true): void {
    const mode = currentBattleMode.value;
    const normalized = normalizePerimeterMagnitude(value);
    const changed = perimeterMagnitude.value !== normalized;
    perimeterMagnitude.value = normalized;
    savePerimeterMagnitude(normalized, mode);
    if (!changed) return;
    applyCurrentTerrainRuntimeConfig();
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

  function applyPlateauWallSlopeDegrees(
    value: number,
    broadcast = true,
  ): void {
    const mode = currentBattleMode.value;
    const normalized = normalizePlateauWallSlopeDegrees(value);
    const changed = plateauWallSlopeDegrees.value !== normalized;
    plateauWallSlopeDegrees.value = normalized;
    savePlateauWallSlopeDegrees(normalized, mode);
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
    const nextPerimeterMagnitude = normalizePerimeterMagnitude(
      settings.perimeterMagnitude,
    );
    const nextDTerrain =
      settings.terrainDTerrain === undefined
        ? terrainDTerrain.value
        : normalizeTerrainDTerrain(settings.terrainDTerrain);
    const nextPlateauWallSlopeDegrees =
      settings.plateauWallSlopeDegrees === undefined
        ? plateauWallSlopeDegrees.value
        : normalizePlateauWallSlopeDegrees(settings.plateauWallSlopeDegrees);
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
      nextPerimeterMagnitude !== perimeterMagnitude.value ||
      nextDTerrain !== terrainDTerrain.value ||
      nextPlateauWallSlopeDegrees !== plateauWallSlopeDegrees.value ||
      nextMetalDepositStep !== metalDepositStep.value ||
      nextTerrainDetail !== terrainDetail.value ||
      settings.mapWidthLandCells !== mapWidthLandCells.value ||
      settings.mapLengthLandCells !== mapLengthLandCells.value;

    centerMagnitude.value = nextCenterMagnitude;
    dividersMagnitude.value = nextDividersMagnitude;
    perimeterMagnitude.value = nextPerimeterMagnitude;
    terrainDTerrain.value = nextDTerrain;
    plateauWallSlopeDegrees.value = nextPlateauWallSlopeDegrees;
    metalDepositStep.value = nextMetalDepositStep;
    terrainDetail.value = nextTerrainDetail;
    mapWidthLandCells.value = settings.mapWidthLandCells;
    mapLengthLandCells.value = settings.mapLengthLandCells;
    saveCenterMagnitude(nextCenterMagnitude, 'real');
    saveDividersMagnitude(nextDividersMagnitude, 'real');
    savePerimeterMagnitude(nextPerimeterMagnitude, 'real');
    saveTerrainDTerrain(nextDTerrain, 'real');
    savePlateauWallSlopeDegrees(nextPlateauWallSlopeDegrees, 'real');
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
    const perimeterMagnitudeDefault = BATTLE_CONFIG.perimeterMagnitude.default;
    const dTerrainDefault = BATTLE_CONFIG.terrainDTerrain.default;
    const plateauWallSlopeDegreesDefault =
      BATTLE_CONFIG.plateauWallSlopeDegrees.default;
    const metalDepositStepDefault = BATTLE_CONFIG.metalDepositStep.default;
    const terrainDetailDefault = BATTLE_CONFIG.terrainDetail.default;
    const mapDimensionsDefault = getDefaultMapLandDimensions();
    if (
      centerMagnitude.value === centerMagnitudeDefault &&
      dividersMagnitude.value === dividersMagnitudeDefault &&
      perimeterMagnitude.value === perimeterMagnitudeDefault &&
      terrainDTerrain.value === dTerrainDefault &&
      plateauWallSlopeDegrees.value === plateauWallSlopeDegreesDefault &&
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
    perimeterMagnitude.value = perimeterMagnitudeDefault;
    terrainDTerrain.value = dTerrainDefault;
    plateauWallSlopeDegrees.value = plateauWallSlopeDegreesDefault;
    metalDepositStep.value = metalDepositStepDefault;
    terrainDetail.value = terrainDetailDefault;
    mapWidthLandCells.value = mapDimensionsDefault.widthLandCells;
    mapLengthLandCells.value = mapDimensionsDefault.lengthLandCells;
    saveCenterMagnitude(centerMagnitudeDefault, mode);
    saveDividersMagnitude(dividersMagnitudeDefault, mode);
    savePerimeterMagnitude(perimeterMagnitudeDefault, mode);
    saveTerrainDTerrain(dTerrainDefault, mode);
    savePlateauWallSlopeDegrees(plateauWallSlopeDegreesDefault, mode);
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
    applyPerimeterMagnitude,
    applyTerrainDTerrain,
    applyPlateauWallSlopeDegrees,
    applyMetalDepositStep,
    applyTerrainDetail,
    applyMapLandDimensions,
    applyLobbySettingsFromHost,
    resetTerrainDefaults,
  };
}
