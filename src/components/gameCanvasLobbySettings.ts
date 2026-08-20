import { nextTick, type ComputedRef, type Ref } from 'vue';
import type {
  LiquidSurfaceMode,
  MetalCoverage,
} from '../types/worldSurfaceMode';
import type { TerrainPrecedence } from '../types/terrainPrecedence';
import {
  isLiquidSurfaceMode,
  isMetalCoverage,
} from '../types/worldSurfaceMode';
import {
  setLiquidSurfaceMode,
  setMetalCoverage,
} from '../game/sim/worldSurfaceState';
import {
  loadStoredLiquidSurfaceMode,
  loadStoredMetalCoverage,
  saveLiquidSurfaceMode,
  saveMetalCoverage,
} from '../battleBarConfig';
import {
  BATTLE_CONFIG,
  getDefaultMapLandDimensions,
  loadStoredConverterTax,
  loadStoredSlowDownAtFinalWaypoint,
  getUnitCap,
  normalizeCenterMagnitude,
  normalizeRingMagnitude,
  normalizeConverterTax,
  normalizePathfindingCellConsolidation,
  normalizeSimulationTickRate,
  normalizeDividersMagnitude,
  normalizeMetalDepositStep,
  normalizePlateauWallSlopeDegrees,
  normalizePerimeterMagnitude,
  normalizeTerrainPrecedence,
  normalizeTerrainDTerrain,
  normalizeTerrainDetail,
  savePlateauWallSlopeDegrees,
  saveCenterMagnitude,
  saveRingMagnitude,
  saveConverterTax,
  savePathfindingCellConsolidation,
  saveSimulationTickRate,
  saveDividersMagnitude,
  saveMapLandDimensions,
  saveMetalDepositStep,
  savePerimeterMagnitude,
  saveTerrainPrecedence,
  setUnitCap,
  saveSlowDownAtFinalWaypoint,
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
import { applyWorldSurfaceSelection } from './gameCanvasWorldSurfaceSelection';
import { assertCurrentLobbySettings } from '../game/network/LobbySettingsContract';
import { normalizeLobbyName } from '../game/network/lobbyName';

type GameCanvasLobbySettings = {
  currentLobbySettings(): LobbySettings;
  applyLobbyName(value: string, broadcast?: boolean): void;
  broadcastLobbySettingsIfHost(): void;
  applyCenterMagnitude(value: number, broadcast?: boolean): void;
  applyRingMagnitude(value: number, broadcast?: boolean): void;
  applyDividersMagnitude(value: number, broadcast?: boolean): void;
  applyPerimeterMagnitude(value: number, broadcast?: boolean): void;
  applyTerrainPrecedence(value: TerrainPrecedence, broadcast?: boolean): void;
  applyTerrainDTerrain(value: number, broadcast?: boolean): void;
  applyPlateauWallSlopeDegrees(value: number, broadcast?: boolean): void;
  applyMetalDepositStep(value: number, broadcast?: boolean): void;
  applyTerrainDetail(value: number, broadcast?: boolean): void;
  applyPathfindingCellConsolidation(value: number, broadcast?: boolean): void;
  applySimulationTickRate(value: number, broadcast?: boolean): void;
  applyMetalCoverage(mode: MetalCoverage, broadcast?: boolean): void;
  applyLiquidSurfaceMode(mode: LiquidSurfaceMode, broadcast?: boolean): void;
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
  ringMagnitude: Ref<number>;
  dividersMagnitude: Ref<number>;
  perimeterMagnitude: Ref<number>;
  terrainPrecedence: Ref<TerrainPrecedence>;
  terrainDTerrain: Ref<number>;
  plateauWallSlopeDegrees: Ref<number>;
  metalDepositStep: Ref<number>;
  terrainDetail: Ref<number>;
  pathfindingCellConsolidation: Ref<number>;
  simulationTickRateHz: Ref<number>;
  mapWidthLandCells: Ref<number>;
  mapLengthLandCells: Ref<number>;
  /** What the host called this lobby. Session state, never persisted — a
   *  name belongs to one lobby, not to this browser. */
  lobbyName: Ref<string>;
  /** UI mirror of the host's declared side count. NetworkManager holds the
   *  authoritative copy; this ref is what the lobby renders, and it is
   *  written here so host edits and inbound host settings both land in one
   *  place. */
  allyTeamCount: Ref<number>;
  slowDownAtFinalWaypointStoreVersion: Ref<number>;
  worldSurfaceStoreVersion: Ref<number>;
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
  ringMagnitude,
  dividersMagnitude,
  perimeterMagnitude,
  terrainPrecedence,
  terrainDTerrain,
  plateauWallSlopeDegrees,
  metalDepositStep,
  terrainDetail,
  pathfindingCellConsolidation,
  simulationTickRateHz,
  mapWidthLandCells,
  mapLengthLandCells,
  lobbyName,
  allyTeamCount,
  slowDownAtFinalWaypointStoreVersion,
  worldSurfaceStoreVersion,
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
      ringMagnitude: ringMagnitude.value,
      dividersMagnitude: dividersMagnitude.value,
      perimeterMagnitude: perimeterMagnitude.value,
      terrainPrecedence: terrainPrecedence.value,
      terrainDTerrain: terrainDTerrain.value,
      plateauWallSlopeDegrees: plateauWallSlopeDegrees.value,
      metalDepositStep: metalDepositStep.value,
      terrainDetail: terrainDetail.value,
    });
  }

  function currentLobbySettings(): LobbySettings {
    return {
      lobbyName: normalizeLobbyName(lobbyName.value),
      centerMagnitude: centerMagnitude.value,
      ringMagnitude: ringMagnitude.value,
      dividersMagnitude: dividersMagnitude.value,
      perimeterMagnitude: perimeterMagnitude.value,
      terrainPrecedence: terrainPrecedence.value,
      terrainDTerrain: terrainDTerrain.value,
      plateauWallSlopeDegrees: plateauWallSlopeDegrees.value,
      metalDepositStep: metalDepositStep.value,
      terrainDetail: terrainDetail.value,
      mapWidthLandCells: mapWidthLandCells.value,
      mapLengthLandCells: mapLengthLandCells.value,
      entityCountCap: getUnitCap('real'),
      allyTeamCount: network.lobbyAllyTeamCount(),
      pathfindingCellConsolidationMultiplier:
        pathfindingCellConsolidation.value,
      simulationTickRateHz: simulationTickRateHz.value,
      converterTax: loadStoredConverterTax('real'),
      slowDownAtFinalWaypoint: loadStoredSlowDownAtFinalWaypoint('real'),
      metalCoverage: loadStoredMetalCoverage('real'),
      liquidSurfaceMode: loadStoredLiquidSurfaceMode('real'),
    };
  }

  function broadcastLobbySettingsIfHost(): void {
    if (networkRole.value === 'host' && roomCode.value !== '') {
      network.broadcastLobbySettings(currentLobbySettings());
    }
  }

  /** Host renames the lobby. Only the listing and the lobby screen change —
   *  no terrain, so nothing to rebuild and no preview restart. */
  function applyLobbyName(value: string, broadcast = true): void {
    const normalized = normalizeLobbyName(value);
    if (lobbyName.value === normalized) return;
    lobbyName.value = normalized;
    if (broadcast) {
      broadcastLobbySettingsIfHost();
      // The directory row carries the name, so it is stale the moment the
      // host retypes it. Republish rather than waiting out the heartbeat.
      network.refreshLobbyListing();
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

  function applyRingMagnitude(value: number, broadcast = true): void {
    const mode = currentBattleMode.value;
    const normalized = normalizeRingMagnitude(value);
    const changed = ringMagnitude.value !== normalized;
    ringMagnitude.value = normalized;
    saveRingMagnitude(normalized, mode);
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

  function applyTerrainPrecedence(
    value: TerrainPrecedence,
    broadcast = true,
  ): void {
    const mode = currentBattleMode.value;
    const normalized = normalizeTerrainPrecedence(value);
    const changed = terrainPrecedence.value !== normalized;
    terrainPrecedence.value = normalized;
    saveTerrainPrecedence(normalized, mode);
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

  function applyPathfindingCellConsolidation(
    value: number,
    broadcast = true,
  ): void {
    const mode = currentBattleMode.value;
    const normalized = normalizePathfindingCellConsolidation(value);
    const changed = pathfindingCellConsolidation.value !== normalized;
    pathfindingCellConsolidation.value = normalized;
    savePathfindingCellConsolidation(normalized, mode);
    if (!changed) return;
    restartPreviewIfNeeded();
    if (broadcast) broadcastLobbySettingsIfHost();
  }

  function applySimulationTickRate(
    value: number,
    broadcast = true,
  ): void {
    const mode = currentBattleMode.value;
    const normalized = normalizeSimulationTickRate(value, mode);
    const changed = simulationTickRateHz.value !== normalized;
    simulationTickRateHz.value = normalized;
    saveSimulationTickRate(normalized, mode);
    if (!changed) return;
    restartPreviewIfNeeded();
    if (broadcast) broadcastLobbySettingsIfHost();
  }

  // The two WORLD settings. Neither changes terrain GEOMETRY, so there is no
  // terrain runtime config to re-apply — but METAL decides how big the ore
  // bodies grow (and whether the whole map is ore), and LIQUID is baked into
  // the terrain mesh's per-vertex horizon liquid colour, so both need the
  // world rebuilt rather than just re-shaded.
  function applySurfaceMode<T extends string>({
    storedMode,
    nextMode,
    persist,
    installRuntime,
    broadcast,
  }: {
    storedMode: T;
    nextMode: T;
    persist: (mode: T) => void;
    installRuntime: (mode: T) => void;
    broadcast: boolean;
  }): void {
    applyWorldSurfaceSelection({
      storedMode,
      nextMode,
      persist,
      installRuntime,
      onChanged: () => {
        worldSurfaceStoreVersion.value++;
        restartPreviewIfNeeded();
        if (broadcast) broadcastLobbySettingsIfHost();
      },
    });
  }

  function applyMetalCoverage(mode: MetalCoverage, broadcast = true): void {
    const battleMode = currentBattleMode.value;
    applySurfaceMode({
      storedMode: loadStoredMetalCoverage(battleMode),
      nextMode: mode,
      persist: (nextMode) => saveMetalCoverage(nextMode, battleMode),
      installRuntime: setMetalCoverage,
      broadcast,
    });
  }

  function applyLiquidSurfaceMode(mode: LiquidSurfaceMode, broadcast = true): void {
    const battleMode = currentBattleMode.value;
    applySurfaceMode({
      storedMode: loadStoredLiquidSurfaceMode(battleMode),
      nextMode: mode,
      persist: (nextMode) => saveLiquidSurfaceMode(nextMode, battleMode),
      installRuntime: setLiquidSurfaceMode,
      broadcast,
    });
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
    assertCurrentLobbySettings(settings, 'host lobby settings');
    const nextCenterMagnitude = normalizeCenterMagnitude(settings.centerMagnitude);
    const nextRingMagnitude = normalizeRingMagnitude(settings.ringMagnitude);
    const nextDividersMagnitude = normalizeDividersMagnitude(
      settings.dividersMagnitude,
    );
    const nextPerimeterMagnitude = normalizePerimeterMagnitude(
      settings.perimeterMagnitude,
    );
    const nextTerrainPrecedence = normalizeTerrainPrecedence(
      settings.terrainPrecedence,
    );
    const nextDTerrain = normalizeTerrainDTerrain(settings.terrainDTerrain);
    const nextPlateauWallSlopeDegrees = normalizePlateauWallSlopeDegrees(
      settings.plateauWallSlopeDegrees,
    );
    const nextMetalDepositStep = normalizeMetalDepositStep(settings.metalDepositStep);
    const nextTerrainDetail = normalizeTerrainDetail(settings.terrainDetail);
    const nextPathfindingCellConsolidation =
      normalizePathfindingCellConsolidation(
        settings.pathfindingCellConsolidationMultiplier,
      );
    const nextSimulationTickRateHz = normalizeSimulationTickRate(
      settings.simulationTickRateHz,
      'real',
    );
    const nextSlowDownAtFinalWaypoint = settings.slowDownAtFinalWaypoint;
    if (!isMetalCoverage(settings.metalCoverage)) {
      throw new Error(`[lobby settings] invalid metalCoverage: ${String(settings.metalCoverage)}`);
    }
    if (!isLiquidSurfaceMode(settings.liquidSurfaceMode)) {
      throw new Error(`[lobby settings] invalid liquidSurfaceMode: ${String(settings.liquidSurfaceMode)}`);
    }
    if (!Number.isFinite(settings.entityCountCap) || settings.entityCountCap <= 0) {
      throw new Error(`[lobby settings] invalid entityCountCap: ${String(settings.entityCountCap)}`);
    }
    const nextMetalCoverage = settings.metalCoverage;
    const nextLiquidSurfaceMode = settings.liquidSurfaceMode;
    const metalCoverageChanged =
      nextMetalCoverage !== loadStoredMetalCoverage('real');
    const liquidSurfaceModeChanged =
      nextLiquidSurfaceMode !== loadStoredLiquidSurfaceMode('real');
    const slowDownAtFinalWaypointChanged =
      nextSlowDownAtFinalWaypoint !==
      loadStoredSlowDownAtFinalWaypoint('real');
    const changed =
      nextCenterMagnitude !== centerMagnitude.value ||
      nextRingMagnitude !== ringMagnitude.value ||
      nextDividersMagnitude !== dividersMagnitude.value ||
      nextPerimeterMagnitude !== perimeterMagnitude.value ||
      nextTerrainPrecedence !== terrainPrecedence.value ||
      nextDTerrain !== terrainDTerrain.value ||
      nextPlateauWallSlopeDegrees !== plateauWallSlopeDegrees.value ||
      nextMetalDepositStep !== metalDepositStep.value ||
      nextTerrainDetail !== terrainDetail.value ||
      nextPathfindingCellConsolidation !==
        pathfindingCellConsolidation.value ||
      nextSimulationTickRateHz !== simulationTickRateHz.value ||
      settings.mapWidthLandCells !== mapWidthLandCells.value ||
      settings.mapLengthLandCells !== mapLengthLandCells.value ||
      slowDownAtFinalWaypointChanged ||
      metalCoverageChanged ||
      liquidSurfaceModeChanged;

    centerMagnitude.value = nextCenterMagnitude;
    ringMagnitude.value = nextRingMagnitude;
    dividersMagnitude.value = nextDividersMagnitude;
    perimeterMagnitude.value = nextPerimeterMagnitude;
    terrainPrecedence.value = nextTerrainPrecedence;
    terrainDTerrain.value = nextDTerrain;
    plateauWallSlopeDegrees.value = nextPlateauWallSlopeDegrees;
    metalDepositStep.value = nextMetalDepositStep;
    terrainDetail.value = nextTerrainDetail;
    pathfindingCellConsolidation.value =
      nextPathfindingCellConsolidation;
    simulationTickRateHz.value = nextSimulationTickRateHz;
    mapWidthLandCells.value = settings.mapWidthLandCells;
    mapLengthLandCells.value = settings.mapLengthLandCells;
    saveCenterMagnitude(nextCenterMagnitude, 'real');
    saveRingMagnitude(nextRingMagnitude, 'real');
    saveDividersMagnitude(nextDividersMagnitude, 'real');
    savePerimeterMagnitude(nextPerimeterMagnitude, 'real');
    saveTerrainPrecedence(nextTerrainPrecedence, 'real');
    saveTerrainDTerrain(nextDTerrain, 'real');
    savePlateauWallSlopeDegrees(nextPlateauWallSlopeDegrees, 'real');
    saveMetalDepositStep(nextMetalDepositStep, 'real');
    saveTerrainDetail(nextTerrainDetail, 'real');
    savePathfindingCellConsolidation(
      nextPathfindingCellConsolidation,
      'real',
    );
    saveSimulationTickRate(nextSimulationTickRateHz, 'real');
    saveMapLandDimensions(
      {
        widthLandCells: settings.mapWidthLandCells,
        lengthLandCells: settings.mapLengthLandCells,
      },
      'real',
    );
    saveMetalCoverage(nextMetalCoverage, 'real');
    saveLiquidSurfaceMode(nextLiquidSurfaceMode, 'real');
    setMetalCoverage(nextMetalCoverage);
    setLiquidSurfaceMode(nextLiquidSurfaceMode);
    if (metalCoverageChanged || liquidSurfaceModeChanged) {
      worldSurfaceStoreVersion.value++;
    }
    saveConverterTax(normalizeConverterTax(settings.converterTax), 'real');
    saveSlowDownAtFinalWaypoint(nextSlowDownAtFinalWaypoint, 'real');
    if (slowDownAtFinalWaypointChanged) {
      slowDownAtFinalWaypointStoreVersion.value++;
    }
    setUnitCap('real', settings.entityCountCap);
    lobbyName.value = normalizeLobbyName(settings.lobbyName);
    // The host owns the side count; a client adopts it without answering
    // back. A change reshapes the terrain slices, so the preview restarts
    // for the same reason a map-size change does.
    const allyTeamCountChanged = network.applyLobbyAllyTeamCount(
      settings.allyTeamCount,
    );
    allyTeamCount.value = network.lobbyAllyTeamCount();
    if (changed || allyTeamCountChanged) {
      applyCurrentTerrainRuntimeConfig();
    }

    const restartPreview = options.restartPreview ?? true;
    if (
      restartPreview &&
      (changed || allyTeamCountChanged) &&
      !gameStarted.value &&
      currentBattleMode.value === 'real'
    ) {
      restartPreviewIfNeeded();
    }
  }

  function resetTerrainDefaults(): void {
    const mode = currentBattleMode.value;
    const centerMagnitudeDefault = BATTLE_CONFIG.centerMagnitude.default;
    const ringMagnitudeDefault = BATTLE_CONFIG.ringMagnitude.default;
    const dividersMagnitudeDefault = BATTLE_CONFIG.dividersMagnitude.default;
    const perimeterMagnitudeDefault = BATTLE_CONFIG.perimeterMagnitude.default;
    const terrainPrecedenceDefault = BATTLE_CONFIG.terrainPrecedence.default;
    const dTerrainDefault = BATTLE_CONFIG.terrainDTerrain.default;
    const plateauWallSlopeDegreesDefault =
      BATTLE_CONFIG.plateauWallSlopeDegrees.default;
    const metalDepositStepDefault = BATTLE_CONFIG.metalDepositStep.default;
    const terrainDetailDefault = BATTLE_CONFIG.terrainDetail.default;
    const pathfindingCellConsolidationDefault =
      BATTLE_CONFIG.pathfindingCellConsolidation.default;
    const simulationTickRateDefault = BATTLE_CONFIG.simulationTickRate.default;
    const mapDimensionsDefault = getDefaultMapLandDimensions();
    if (
      centerMagnitude.value === centerMagnitudeDefault &&
      ringMagnitude.value === ringMagnitudeDefault &&
      dividersMagnitude.value === dividersMagnitudeDefault &&
      perimeterMagnitude.value === perimeterMagnitudeDefault &&
      terrainPrecedence.value === terrainPrecedenceDefault &&
      terrainDTerrain.value === dTerrainDefault &&
      plateauWallSlopeDegrees.value === plateauWallSlopeDegreesDefault &&
      metalDepositStep.value === metalDepositStepDefault &&
      terrainDetail.value === terrainDetailDefault &&
      pathfindingCellConsolidation.value ===
        pathfindingCellConsolidationDefault &&
      simulationTickRateHz.value === simulationTickRateDefault &&
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
    ringMagnitude.value = ringMagnitudeDefault;
    dividersMagnitude.value = dividersMagnitudeDefault;
    perimeterMagnitude.value = perimeterMagnitudeDefault;
    terrainPrecedence.value = terrainPrecedenceDefault;
    terrainDTerrain.value = dTerrainDefault;
    plateauWallSlopeDegrees.value = plateauWallSlopeDegreesDefault;
    metalDepositStep.value = metalDepositStepDefault;
    terrainDetail.value = terrainDetailDefault;
    pathfindingCellConsolidation.value =
      pathfindingCellConsolidationDefault;
    simulationTickRateHz.value = simulationTickRateDefault;
    mapWidthLandCells.value = mapDimensionsDefault.widthLandCells;
    mapLengthLandCells.value = mapDimensionsDefault.lengthLandCells;
    saveCenterMagnitude(centerMagnitudeDefault, mode);
    saveRingMagnitude(ringMagnitudeDefault, mode);
    saveDividersMagnitude(dividersMagnitudeDefault, mode);
    savePerimeterMagnitude(perimeterMagnitudeDefault, mode);
    saveTerrainPrecedence(terrainPrecedenceDefault, mode);
    saveTerrainDTerrain(dTerrainDefault, mode);
    savePlateauWallSlopeDegrees(plateauWallSlopeDegreesDefault, mode);
    saveMetalDepositStep(metalDepositStepDefault, mode);
    saveTerrainDetail(terrainDetailDefault, mode);
    savePathfindingCellConsolidation(
      pathfindingCellConsolidationDefault,
      mode,
    );
    saveSimulationTickRate(simulationTickRateDefault, mode);
    saveMapLandDimensions(mapDimensionsDefault, mode);
    applyCurrentTerrainRuntimeConfig();
    restartPreviewIfNeeded();
  }

  return {
    currentLobbySettings,
    broadcastLobbySettingsIfHost,
    applyLobbyName,
    applyCenterMagnitude,
    applyRingMagnitude,
    applyDividersMagnitude,
    applyPerimeterMagnitude,
    applyTerrainPrecedence,
    applyTerrainDTerrain,
    applyPlateauWallSlopeDegrees,
    applyMetalDepositStep,
    applyTerrainDetail,
    applyPathfindingCellConsolidation,
    applySimulationTickRate,
    applyMetalCoverage,
    applyLiquidSurfaceMode,
    applyMapLandDimensions,
    applyLobbySettingsFromHost,
    resetTerrainDefaults,
  };
}
