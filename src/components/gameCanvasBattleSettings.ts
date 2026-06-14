import { computed, type ComputedRef, type Ref } from 'vue';
import {
  BATTLE_CONFIG,
  loadStoredConverterTax,
  loadStoredForceFieldsVisible,
  loadStoredFogOfWarEnabled,
  normalizeConverterTax,
  saveConverterTax,
  saveDemoUnits,
  saveForceFieldsVisible,
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
  currentForceFieldsVisible: ComputedRef<boolean>;
  currentShieldsObstructSight: ComputedRef<boolean>;
  currentFogOfWarEnabled: ComputedRef<boolean>;
  currentConverterTax: ComputedRef<number>;
  toggleDemoUnitBlueprintId(unitBlueprintId: string): void;
  toggleAllDemoUnits(): void;
  changeMaxTotalUnits(value: number): void;
  setForceFieldsVisible(enabled: boolean): void;
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
  const currentForceFieldsVisible = computed(
    () =>
      serverMetaFromSnapshot.value?.forceFieldsVisible ??
      loadStoredForceFieldsVisible(currentBattleMode.value),
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
    const allowed = currentAllowedUnitsSet.value;
    const canSkipUnchanged = serverMetaFromSnapshot.value?.units.allowed !== undefined;
    const connection = getActiveConnection();
    for (const unitBlueprintId of demoUnitBlueprintIds) {
      if (canSkipUnchanged && allowed.has(unitBlueprintId) === enableAll) continue;
      connection?.sendCommand({
        type: 'setBackgroundUnitBlueprintEnabled',
        tick: 0,
        unitBlueprintId,
        enabled: enableAll,
      });
    }
    saveDemoUnits(enableAll ? [...demoUnitBlueprintIds] : []);
  }

  function changeMaxTotalUnits(value: number, broadcast = true): void {
    const mode = currentBattleMode.value;
    const authoritative = serverMetaFromSnapshot.value?.units.max;
    const changed = authoritative === undefined || authoritative !== value;
    if (changed) {
      getActiveConnection()?.sendCommand({
        type: 'setMaxTotalUnits',
        tick: 0,
        maxTotalUnits: value,
      });
    }
    saveStoredCap(mode, value);
    if (changed && broadcast && mode === 'real') broadcastLobbySettingsIfHost();
  }

  function setShieldsObstructSight(enabled: boolean): void {
    const authoritative = serverMetaFromSnapshot.value?.shieldsObstructSight;
    if (authoritative === undefined || authoritative !== enabled) {
      getActiveConnection()?.sendCommand({ type: 'setShieldsObstructSight', tick: 0, enabled });
    }
    saveShieldsObstructSight(enabled, currentBattleMode.value);
  }

  function setForceFieldsVisible(enabled: boolean, broadcast = true): void {
    const mode = currentBattleMode.value;
    const authoritative = serverMetaFromSnapshot.value?.forceFieldsVisible;
    const changed = authoritative === undefined || authoritative !== enabled;
    if (changed) {
      getActiveConnection()?.sendCommand({ type: 'setForceFieldsVisible', tick: 0, enabled });
    }
    saveForceFieldsVisible(enabled, mode);
    if (changed && broadcast && mode === 'real') broadcastLobbySettingsIfHost();
  }

  function setFogOfWarEnabled(enabled: boolean): void {
    // Fog of war is user-controllable only from the DEMO BATTLE bar.
    // Lobby preview is hardcoded off and real battle is hardcoded on,
    // so any caller in real mode (preset selection in the lobby, etc.)
    // is silently dropped here rather than mutating shared state.
    if (currentBattleMode.value !== 'demo') return;
    const authoritative = serverMetaFromSnapshot.value?.fogOfWarEnabled;
    if (authoritative === undefined || authoritative !== enabled) {
      getActiveConnection()?.sendCommand({ type: 'setFogOfWarEnabled', tick: 0, enabled });
    }
    saveFogOfWarEnabled(enabled, currentBattleMode.value);
  }

  function setConverterTax(tax: number, broadcast = true): void {
    const normalized = normalizeConverterTax(tax);
    const mode = currentBattleMode.value;
    const authoritative = serverMetaFromSnapshot.value?.converterTax;
    const changed = authoritative === undefined || Math.abs(authoritative - normalized) >= 1e-6;
    if (changed) {
      getActiveConnection()?.sendCommand({ type: 'setConverterTax', tick: 0, tax: normalized });
    }
    saveConverterTax(normalized, mode);
    if (changed && broadcast && mode === 'real') broadcastLobbySettingsIfHost();
  }

  function applyPreset(preset: BattlePreset): void {
    const presetSet = new Set(preset.units);
    const allowed = currentAllowedUnitsSet.value;
    const canSkipUnchanged = serverMetaFromSnapshot.value?.units.allowed !== undefined;
    const connection = getActiveConnection();
    for (const unitBlueprintId of demoUnitBlueprintIds) {
      const enabled = presetSet.has(unitBlueprintId);
      if (canSkipUnchanged && allowed.has(unitBlueprintId) === enabled) continue;
      connection?.sendCommand({
        type: 'setBackgroundUnitBlueprintEnabled',
        tick: 0,
        unitBlueprintId,
        enabled,
      });
    }
    saveDemoUnits([...preset.units]);
    changeMaxTotalUnits(preset.cap, false);
    setForceFieldsVisible(preset.forceFieldsVisible, false);
    setShieldsObstructSight(preset.shieldsObstructSight);
    setFogOfWarEnabled(preset.fogOfWarEnabled);
    setConverterTax(preset.converterTax, false);
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
    currentForceFieldsVisible,
    currentShieldsObstructSight,
    currentFogOfWarEnabled,
    currentConverterTax,
    toggleDemoUnitBlueprintId,
    toggleAllDemoUnits,
    changeMaxTotalUnits,
    setForceFieldsVisible,
    setShieldsObstructSight,
    setFogOfWarEnabled,
    setConverterTax,
    resetDemoDefaults,
    applyPreset,
  };
}
