import { computed, type ComputedRef, type Ref } from 'vue';
import {
  BATTLE_CONFIG,
  loadStoredConverterTax,
  loadStoredFogOfWarEnabled,
  normalizeConverterTax,
  saveConverterTax,
  saveDemoUnits,
  saveForceFieldsObstructSight,
  saveFogOfWarEnabled,
  saveStoredCap,
  type BattleMode,
} from '../battleBarConfig';
import type { NetworkServerSnapshotMeta } from '../game/network/NetworkTypes';
import type { GameConnection } from '../game/server/GameConnection';
import type { MapLandCellDimensions } from '../mapSizeConfig';
import type { TerrainMapShape } from '../types/terrain';
import {
  type BattlePreset,
  getDefaultPreset,
  saveSelectedPresetName,
} from './battlePresets';

export type GameCanvasBattleSettings = {
  currentAllowedUnits: ComputedRef<readonly string[]>;
  /** Set-backed view of currentAllowedUnits so consumers in v-for
   *  templates can do O(1) membership lookups instead of array
   *  .includes on every parent re-render. */
  currentAllowedUnitsSet: ComputedRef<ReadonlySet<string>>;
  allDemoUnitsActive: ComputedRef<boolean>;
  currentForceFieldsObstructSight: ComputedRef<boolean>;
  currentFogOfWarEnabled: ComputedRef<boolean>;
  currentConverterTax: ComputedRef<number>;
  toggleDemoUnitType(unitType: string): void;
  toggleAllDemoUnits(): void;
  changeMaxTotalUnits(value: number): void;
  setForceFieldsObstructSight(enabled: boolean): void;
  setFogOfWarEnabled(enabled: boolean): void;
  setConverterTax(tax: number): void;
  resetDemoDefaults(): void;
  applyPreset(preset: BattlePreset): void;
};

export type GameCanvasBattleSettingsOptions = {
  serverMetaFromSnapshot: Ref<NetworkServerSnapshotMeta | null>;
  currentBattleMode: ComputedRef<BattleMode>;
  demoUnitTypes: readonly string[];
  getActiveConnection: () => GameConnection | null;
  resetGridInfoToDefault: () => void;
  broadcastLobbySettingsIfHost: () => void;
  applyCenterMagnitude: (value: number, broadcast?: boolean) => void;
  applyDividersMagnitude: (value: number, broadcast?: boolean) => void;
  applyTerrainMapShape: (shape: TerrainMapShape, broadcast?: boolean) => void;
  applyTerrainDTerrain: (value: number, broadcast?: boolean) => void;
  applyMetalDepositStep: (value: number, broadcast?: boolean) => void;
  applyMapLandDimensions: (
    dimensions: MapLandCellDimensions,
    broadcast?: boolean,
  ) => void;
};

export function useGameCanvasBattleSettings({
  serverMetaFromSnapshot,
  currentBattleMode,
  demoUnitTypes,
  getActiveConnection,
  resetGridInfoToDefault,
  broadcastLobbySettingsIfHost,
  applyCenterMagnitude,
  applyDividersMagnitude,
  applyTerrainMapShape,
  applyTerrainDTerrain,
  applyMetalDepositStep,
  applyMapLandDimensions,
}: GameCanvasBattleSettingsOptions): GameCanvasBattleSettings {
  const currentAllowedUnits = computed<readonly string[]>(
    () =>
      serverMetaFromSnapshot.value?.units.allowed ??
      demoUnitTypes.filter((unitType) => BATTLE_CONFIG.units[unitType]?.default ?? false),
  );
  const currentAllowedUnitsSet = computed<ReadonlySet<string>>(
    () => new Set(currentAllowedUnits.value),
  );
  const allDemoUnitsActive = computed(() => {
    const allowed = currentAllowedUnitsSet.value;
    for (let i = 0; i < demoUnitTypes.length; i++) {
      if (!allowed.has(demoUnitTypes[i])) return false;
    }
    return true;
  });
  const currentForceFieldsObstructSight = computed(
    () =>
      serverMetaFromSnapshot.value?.forceFieldsObstructSight ??
      BATTLE_CONFIG.forceFieldsObstructSight.default,
  );
  const currentFogOfWarEnabled = computed(
    () =>
      serverMetaFromSnapshot.value?.fogOfWarEnabled ??
      loadStoredFogOfWarEnabled(currentBattleMode.value),
  );
  const currentConverterTax = computed(
    () =>
      serverMetaFromSnapshot.value?.converterTax ??
      loadStoredConverterTax(currentBattleMode.value),
  );

  function toggleDemoUnitType(unitType: string): void {
    const allowed = currentAllowedUnits.value;
    const current = allowed.includes(unitType);
    getActiveConnection()?.sendCommand({
      type: 'setBackgroundUnitType',
      tick: 0,
      unitType,
      enabled: !current,
    });

    const newList = current
      ? allowed.filter((unit) => unit !== unitType)
      : [...allowed, unitType];
    saveDemoUnits(newList);
  }

  function toggleAllDemoUnits(): void {
    const enableAll = !allDemoUnitsActive.value;
    for (const unitType of demoUnitTypes) {
      getActiveConnection()?.sendCommand({
        type: 'setBackgroundUnitType',
        tick: 0,
        unitType,
        enabled: enableAll,
      });
    }
    saveDemoUnits(enableAll ? [...demoUnitTypes] : []);
  }

  function changeMaxTotalUnits(value: number): void {
    getActiveConnection()?.sendCommand({
      type: 'setMaxTotalUnits',
      tick: 0,
      maxTotalUnits: value,
    });
    saveStoredCap(currentBattleMode.value, value);
  }

  function setForceFieldsObstructSight(enabled: boolean): void {
    getActiveConnection()?.sendCommand({ type: 'setForceFieldsObstructSight', tick: 0, enabled });
    saveForceFieldsObstructSight(enabled, currentBattleMode.value);
  }

  function setFogOfWarEnabled(enabled: boolean): void {
    getActiveConnection()?.sendCommand({ type: 'setFogOfWarEnabled', tick: 0, enabled });
    saveFogOfWarEnabled(enabled, currentBattleMode.value);
    if (currentBattleMode.value === 'real') broadcastLobbySettingsIfHost();
  }

  function setConverterTax(tax: number): void {
    const normalized = normalizeConverterTax(tax);
    getActiveConnection()?.sendCommand({ type: 'setConverterTax', tick: 0, tax: normalized });
    saveConverterTax(normalized, currentBattleMode.value);
    if (currentBattleMode.value === 'real') broadcastLobbySettingsIfHost();
  }

  function applyPreset(preset: BattlePreset): void {
    const presetSet = new Set(preset.units);
    for (const unitType of demoUnitTypes) {
      getActiveConnection()?.sendCommand({
        type: 'setBackgroundUnitType',
        tick: 0,
        unitType,
        enabled: presetSet.has(unitType),
      });
    }
    saveDemoUnits([...preset.units]);
    changeMaxTotalUnits(preset.cap);
    setForceFieldsObstructSight(preset.forceFieldsObstructSight);
    setFogOfWarEnabled(preset.fogOfWarEnabled);
    setConverterTax(preset.converterTax);
    applyCenterMagnitude(preset.centerMagnitude, false);
    applyDividersMagnitude(preset.dividersMagnitude, false);
    applyTerrainMapShape(preset.terrainMapShape, false);
    applyTerrainDTerrain(preset.terrainDTerrain, false);
    applyMetalDepositStep(preset.metalDepositStep, false);
    applyMapLandDimensions(
      {
        widthLandCells: preset.mapWidthLandCells,
        lengthLandCells: preset.mapLengthLandCells,
      },
      false,
    );
    resetGridInfoToDefault();
    saveSelectedPresetName(preset.name);
    broadcastLobbySettingsIfHost();
  }

  function resetDemoDefaults(): void {
    applyPreset(getDefaultPreset());
  }

  return {
    currentAllowedUnits,
    currentAllowedUnitsSet,
    allDemoUnitsActive,
    currentForceFieldsObstructSight,
    currentFogOfWarEnabled,
    currentConverterTax,
    toggleDemoUnitType,
    toggleAllDemoUnits,
    changeMaxTotalUnits,
    setForceFieldsObstructSight,
    setFogOfWarEnabled,
    setConverterTax,
    resetDemoDefaults,
    applyPreset,
  };
}
