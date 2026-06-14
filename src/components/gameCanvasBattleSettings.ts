import { computed, type ComputedRef, type Ref } from 'vue';
import {
  BATTLE_CONFIG,
  loadStoredConverterTax,
  loadStoredFogOfWarEnabled,
  normalizeConverterTax,
  saveConverterTax,
  saveDemoUnits,
  saveShieldsObstructSight,
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
  getModeDefaultPreset,
  saveSelectedPresetName,
} from './battlePresets';

export type GameCanvasBattleSettings = {
  currentAllowedUnits: ComputedRef<readonly string[]>;
  /** Set-backed view of currentAllowedUnits so consumers in v-for
   *  templates can do O(1) membership lookups instead of array
   *  .includes on every parent re-render. */
  currentAllowedUnitsSet: ComputedRef<ReadonlySet<string>>;
  allDemoUnitsActive: ComputedRef<boolean>;
  currentShieldsObstructSight: ComputedRef<boolean>;
  currentFogOfWarEnabled: ComputedRef<boolean>;
  currentConverterTax: ComputedRef<number>;
  toggleDemoUnitBlueprintId(unitBlueprintId: string): void;
  toggleAllDemoUnits(): void;
  changeMaxTotalUnits(value: number): void;
  setShieldsObstructSight(enabled: boolean): void;
  setFogOfWarEnabled(enabled: boolean): void;
  setConverterTax(tax: number): void;
  resetDemoDefaults(): void;
  applyPreset(preset: BattlePreset): void;
};

export type GameCanvasBattleSettingsOptions = {
  serverMetaFromSnapshot: Ref<NetworkServerSnapshotMeta | null>;
  currentBattleMode: ComputedRef<BattleMode>;
  demoUnitBlueprintIds: readonly string[];
  getActiveConnection: () => GameConnection | null;
  resetGridInfoToDefault: () => void;
  broadcastLobbySettingsIfHost: () => void;
  applyCenterMagnitude: (value: number, broadcast?: boolean) => void;
  applyDividersMagnitude: (value: number, broadcast?: boolean) => void;
  applyTerrainMapShape: (shape: TerrainMapShape, broadcast?: boolean) => void;
  applyTerrainDTerrain: (value: number, broadcast?: boolean) => void;
  applyMetalDepositStep: (value: number, broadcast?: boolean) => void;
  applyTerrainDetail: (value: number, broadcast?: boolean) => void;
  applyMapLandDimensions: (
    dimensions: MapLandCellDimensions,
    broadcast?: boolean,
  ) => void;
};

export function useGameCanvasBattleSettings({
  serverMetaFromSnapshot,
  currentBattleMode,
  demoUnitBlueprintIds,
  getActiveConnection,
  resetGridInfoToDefault,
  broadcastLobbySettingsIfHost,
  applyCenterMagnitude,
  applyDividersMagnitude,
  applyTerrainMapShape,
  applyTerrainDTerrain,
  applyMetalDepositStep,
  applyTerrainDetail,
  applyMapLandDimensions,
}: GameCanvasBattleSettingsOptions): GameCanvasBattleSettings {
  const currentAllowedUnits = computed<readonly string[]>(
    () =>
      serverMetaFromSnapshot.value?.units.allowed ??
      demoUnitBlueprintIds.filter((unitBlueprintId) => BATTLE_CONFIG.units[unitBlueprintId]?.default ?? false),
  );
  const currentAllowedUnitsSet = computed<ReadonlySet<string>>(
    () => new Set(currentAllowedUnits.value),
  );
  const allDemoUnitsActive = computed(() => {
    const allowed = currentAllowedUnitsSet.value;
    for (let i = 0; i < demoUnitBlueprintIds.length; i++) {
      if (!allowed.has(demoUnitBlueprintIds[i])) return false;
    }
    return true;
  });
  const currentShieldsObstructSight = computed(
    () =>
      serverMetaFromSnapshot.value?.shieldsObstructSight ??
      BATTLE_CONFIG.shieldsObstructSight.default,
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

  function toggleDemoUnitBlueprintId(unitBlueprintId: string): void {
    const allowed = currentAllowedUnits.value;
    const current = allowed.includes(unitBlueprintId);
    getActiveConnection()?.sendCommand({
      type: 'setBackgroundUnitBlueprintEnabled',
      tick: 0,
      unitBlueprintId,
      enabled: !current,
    });

    const newList = current
      ? allowed.filter((unit) => unit !== unitBlueprintId)
      : [...allowed, unitBlueprintId];
    saveDemoUnits(newList);
  }

  function toggleAllDemoUnits(): void {
    const enableAll = !allDemoUnitsActive.value;
    for (const unitBlueprintId of demoUnitBlueprintIds) {
      getActiveConnection()?.sendCommand({
        type: 'setBackgroundUnitBlueprintEnabled',
        tick: 0,
        unitBlueprintId,
        enabled: enableAll,
      });
    }
    saveDemoUnits(enableAll ? [...demoUnitBlueprintIds] : []);
  }

  function changeMaxTotalUnits(value: number): void {
    getActiveConnection()?.sendCommand({
      type: 'setMaxTotalUnits',
      tick: 0,
      maxTotalUnits: value,
    });
    saveStoredCap(currentBattleMode.value, value);
    if (currentBattleMode.value === 'real') broadcastLobbySettingsIfHost();
  }

  function setShieldsObstructSight(enabled: boolean): void {
    getActiveConnection()?.sendCommand({ type: 'setShieldsObstructSight', tick: 0, enabled });
    saveShieldsObstructSight(enabled, currentBattleMode.value);
  }

  function setFogOfWarEnabled(enabled: boolean): void {
    // Fog of war is user-controllable only from the DEMO BATTLE bar.
    // Lobby preview is hardcoded off and real battle is hardcoded on,
    // so any caller in real mode (preset selection in the lobby, etc.)
    // is silently dropped here rather than mutating shared state.
    if (currentBattleMode.value !== 'demo') return;
    getActiveConnection()?.sendCommand({ type: 'setFogOfWarEnabled', tick: 0, enabled });
    saveFogOfWarEnabled(enabled, currentBattleMode.value);
  }

  function setConverterTax(tax: number): void {
    const normalized = normalizeConverterTax(tax);
    getActiveConnection()?.sendCommand({ type: 'setConverterTax', tick: 0, tax: normalized });
    saveConverterTax(normalized, currentBattleMode.value);
    if (currentBattleMode.value === 'real') broadcastLobbySettingsIfHost();
  }

  function applyPreset(preset: BattlePreset): void {
    const presetSet = new Set(preset.units);
    for (const unitBlueprintId of demoUnitBlueprintIds) {
      getActiveConnection()?.sendCommand({
        type: 'setBackgroundUnitBlueprintEnabled',
        tick: 0,
        unitBlueprintId,
        enabled: presetSet.has(unitBlueprintId),
      });
    }
    saveDemoUnits([...preset.units]);
    changeMaxTotalUnits(preset.cap);
    setShieldsObstructSight(preset.shieldsObstructSight);
    setFogOfWarEnabled(preset.fogOfWarEnabled);
    setConverterTax(preset.converterTax);
    applyCenterMagnitude(preset.centerMagnitude, false);
    applyDividersMagnitude(preset.dividersMagnitude, false);
    applyTerrainMapShape(preset.terrainMapShape, false);
    applyTerrainDTerrain(preset.terrainDTerrain, false);
    applyMetalDepositStep(preset.metalDepositStep, false);
    applyTerrainDetail(preset.terrainDetail, false);
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
    applyPreset(getModeDefaultPreset(currentBattleMode.value));
  }

  return {
    currentAllowedUnits,
    currentAllowedUnitsSet,
    allDemoUnitsActive,
    currentShieldsObstructSight,
    currentFogOfWarEnabled,
    currentConverterTax,
    toggleDemoUnitBlueprintId,
    toggleAllDemoUnits,
    changeMaxTotalUnits,
    setShieldsObstructSight,
    setFogOfWarEnabled,
    setConverterTax,
    resetDemoDefaults,
    applyPreset,
  };
}
