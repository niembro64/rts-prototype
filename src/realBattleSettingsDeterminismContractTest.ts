import {
  getModeDefaultEntityCountCap,
  getUnitCap,
  loadStoredCenterMagnitude,
  loadStoredConverterTax,
  loadStoredDividersMagnitude,
  loadStoredFogOfWarEnabled,
  loadStoredForceFieldsVisible,
  loadStoredLiquidSurfaceMode,
  loadStoredMapLandDimensions,
  loadStoredMetalDepositStep,
  loadStoredPerimeterMagnitude,
  loadStoredPathfindingCellConsolidation,
  loadStoredSimulationTickRate,
  loadStoredPlateauWallSlopeDegrees,
  loadStoredSlopePathMode,
  loadStoredSlowDownAtFinalWaypoint,
  loadStoredTerrainDTerrain,
  loadStoredTerrainDetail,
  loadStoredTerrainSurfaceMode,
  resetRealBattleSettings,
  saveCenterMagnitude,
  saveConverterTax,
  saveDividersMagnitude,
  saveFogOfWarEnabled,
  saveForceFieldsVisible,
  saveLiquidSurfaceMode,
  saveMapLandDimensions,
  saveMetalDepositStep,
  savePerimeterMagnitude,
  savePathfindingCellConsolidation,
  saveSimulationTickRate,
  savePlateauWallSlopeDegrees,
  saveSlopePathMode,
  saveSlowDownAtFinalWaypoint,
  saveTerrainDTerrain,
  saveTerrainDetail,
  saveTerrainSurfaceMode,
  setUnitCap,
} from './battleBarConfig';
import battleBarConfig from './battleBarConfig.json';
import serverBarConfig from './serverBarConfig.json';
import {
  loadStoredUnitGroundNormalEmaMode,
  saveUnitGroundNormalEmaMode,
} from './serverBarConfig';
import { UNIT_GROUND_NORMAL_EMA_MODE_DEFAULT } from './shellConfig';
import { getModeDefaultPreset } from './components/battlePresets';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[real battle determinism contract] ${message}`);
}

/** Every value a lobby session can change, paired with the loader that reads
 *  it back. One entry per BATTLE-bar setting that feeds the simulation. */
function mutateEveryRealSetting(): void {
  setUnitCap('real', 5000);
  saveForceFieldsVisible(false, 'real');
  saveFogOfWarEnabled(false, 'real');
  saveSlowDownAtFinalWaypoint(true, 'real');
  saveSlopePathMode('symmetric', 'real');
  saveTerrainSurfaceMode('metal', 'real');
  saveLiquidSurfaceMode('lava', 'real');
  saveConverterTax(0.1, 'real');
  saveCenterMagnitude(3200, 'real');
  saveDividersMagnitude(1600, 'real');
  savePerimeterMagnitude(800, 'real');
  saveTerrainDTerrain(800, 'real');
  savePlateauWallSlopeDegrees(45, 'real');
  saveMetalDepositStep(1600, 'real');
  saveTerrainDetail(16, 'real');
  savePathfindingCellConsolidation(5, 'real');
  saveSimulationTickRate(60, 'real');
  saveMapLandDimensions({ widthLandCells: 53, lengthLandCells: 53 }, 'real');
  // SERVER bar — a simulation setting, so it obeys the same rule.
  saveUnitGroundNormalEmaMode('snap', 'real');
}

/** Read every real setting back and compare against the authored defaults. */
function assertRealSettingsAtDefaults(context: string): void {
  const preset = getModeDefaultPreset('real');
  const checks: readonly [string, unknown, unknown][] = [
    ['cap', getUnitCap('real'), getModeDefaultEntityCountCap('real')],
    ['forceFieldsVisible', loadStoredForceFieldsVisible('real'), preset.forceFieldsVisible],
    ['fogOfWarEnabled', loadStoredFogOfWarEnabled('real'), preset.fogOfWarEnabled],
    [
      'slowDownAtFinalWaypoint',
      loadStoredSlowDownAtFinalWaypoint('real'),
      preset.slowDownAtFinalWaypoint,
    ],
    ['slopePathMode', loadStoredSlopePathMode('real'), preset.slopePathMode],
    ['terrainSurfaceMode', loadStoredTerrainSurfaceMode('real'), preset.terrainSurfaceMode],
    ['liquidSurfaceMode', loadStoredLiquidSurfaceMode('real'), preset.liquidSurfaceMode],
    ['converterTax', loadStoredConverterTax('real'), preset.converterTax],
    ['centerMagnitude', loadStoredCenterMagnitude('real'), preset.centerMagnitude],
    ['dividersMagnitude', loadStoredDividersMagnitude('real'), preset.dividersMagnitude],
    ['perimeterMagnitude', loadStoredPerimeterMagnitude('real'), preset.perimeterMagnitude],
    ['terrainDTerrain', loadStoredTerrainDTerrain('real'), preset.terrainDTerrain],
    [
      'plateauWallSlopeDegrees',
      loadStoredPlateauWallSlopeDegrees('real'),
      preset.plateauWallSlopeDegrees,
    ],
    ['metalDepositStep', loadStoredMetalDepositStep('real'), preset.metalDepositStep],
    ['terrainDetail', loadStoredTerrainDetail('real'), preset.terrainDetail],
    [
      'pathfindingCellConsolidation',
      loadStoredPathfindingCellConsolidation('real'),
      3,
    ],
    ['simulationTickRateHz', loadStoredSimulationTickRate('real'), 20],
    [
      'unitGroundNormalEmaMode',
      loadStoredUnitGroundNormalEmaMode('real'),
      UNIT_GROUND_NORMAL_EMA_MODE_DEFAULT,
    ],
  ];
  for (const [name, actual, expected] of checks) {
    assertContract(
      actual === expected,
      `${context}: real ${name} was ${String(actual)}, expected the authored default ${String(expected)}`,
    );
  }
  const dimensions = loadStoredMapLandDimensions('real');
  assertContract(
    dimensions.widthLandCells === preset.mapWidthLandCells &&
      dimensions.lengthLandCells === preset.mapLengthLandCells,
    `${context}: real map size was ${dimensions.widthLandCells}x${dimensions.lengthLandCells}, ` +
      `expected ${preset.mapWidthLandCells}x${preset.mapLengthLandCells}`,
  );
}

/**
 * A lobby must open identically every time, on every machine: no real-battle
 * setting may reach localStorage, and none may survive into the next session.
 * The demo is deliberately the opposite — it IS the persistent sandbox — so
 * this also proves a lobby cannot inherit demo customizations.
 */
export function runRealBattleSettingsDeterminismContractTest(): void {
  const realKeys = [
    ...Object.entries(battleBarConfig.storageKeys)
      .filter(([name]) => name.startsWith('real'))
      .map(([, key]) => key as string),
    // The SERVER bar namespaces its own real keys as `real-server-<suffix>`.
    ...Object.values(serverBarConfig.storageKeySuffixes).map(
      (suffix) => `real-server-${suffix as string}`,
    ),
  ];
  assertContract(realKeys.length > 0, 'no real-battle storage keys found to police');

  const savedRealKeyValues = new Map<string, string | null>();
  for (const key of realKeys) savedRealKeyValues.set(key, window.localStorage.getItem(key));

  try {
    // Seed every real key in the browser. Nothing should ever read these
    // again — a stale profile from an older build must not leak into a lobby.
    for (const key of realKeys) window.localStorage.setItem(key, 'stale-profile-value');

    resetRealBattleSettings();
    assertRealSettingsAtDefaults('a fresh lobby ignoring historical browser storage');

    mutateEveryRealSetting();
    assertContract(
      getUnitCap('real') === 5000,
      'a live lobby must still change its in-memory settings',
    );
    assertContract(
      loadStoredTerrainSurfaceMode('real') === 'metal' &&
        loadStoredConverterTax('real') === 0.1 &&
        loadStoredPathfindingCellConsolidation('real') === 5 &&
        loadStoredSimulationTickRate('real') === 60 &&
        loadStoredMapLandDimensions('real').widthLandCells === 53 &&
        loadStoredUnitGroundNormalEmaMode('real') === 'snap',
      'a live lobby must read back the settings it just changed',
    );

    for (const key of realKeys) {
      assertContract(
        window.localStorage.getItem(key) === 'stale-profile-value',
        `real setting ${key} was written to localStorage; real battles are session-only`,
      );
    }

    // Re-entering the lobby drops the session entirely.
    resetRealBattleSettings();
    assertRealSettingsAtDefaults('a new lobby session after a previous game');
  } finally {
    for (const [key, value] of savedRealKeyValues) {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    }
    resetRealBattleSettings();
  }
}
