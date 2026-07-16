import { computed, ref, type ComputedRef, type Ref } from 'vue';
import {
  BATTLE_CONFIG,
  loadStoredConverterTax,
  loadStoredForceFieldsVisible,
  loadStoredFogOfWarEnabled,
  normalizeConverterTax,
  saveConverterTax,
  saveDemoUnits,
  saveDemoBuildings,
  saveDemoTowers,
  loadStoredDemoBuildings,
  loadStoredDemoTowers,
  getDefaultDemoBuildings,
  getDefaultDemoTowers,
  saveForceFieldsVisible,
  saveShieldsObstructSight,
  saveFogOfWarEnabled,
  loadStoredSlopePathMode,
  saveSlopePathMode,
  saveStoredCap,
  type BattleMode,
} from '../battleBarConfig';
import type { SlopePathMode } from '../types/slopePathMode';
import type { NetworkServerSnapshotMeta } from '../game/network/NetworkTypes';
import type { GameConnection } from '../game/server/GameConnection';
import type { MapLandCellDimensions } from '../mapSizeConfig';
import {
  type BattlePreset,
  getModeDefaultPreset,
  saveSelectedPresetName,
} from './battlePresets';

type GameCanvasBattleSettings = {
  currentAllowedUnits: ComputedRef<readonly string[]>;
  /** Set-backed view of currentAllowedUnits so consumers in v-for
   *  templates can do O(1) membership lookups instead of array
   *  .includes on every parent re-render. */
  currentAllowedUnitsSet: ComputedRef<ReadonlySet<string>>;
  allDemoUnitsActive: ComputedRef<boolean>;
  currentAllowedBuildings: ComputedRef<readonly string[]>;
  currentAllowedBuildingsSet: ComputedRef<ReadonlySet<string>>;
  allDemoBuildingsActive: ComputedRef<boolean>;
  currentAllowedTowers: ComputedRef<readonly string[]>;
  currentAllowedTowersSet: ComputedRef<ReadonlySet<string>>;
  allDemoTowersActive: ComputedRef<boolean>;
  currentForceFieldsVisible: ComputedRef<boolean>;
  currentShieldsObstructSight: ComputedRef<boolean>;
  currentFogOfWarEnabled: ComputedRef<boolean>;
  currentSlopePathMode: ComputedRef<SlopePathMode>;
  currentConverterTax: ComputedRef<number>;
  toggleDemoUnitBlueprintId(unitBlueprintId: string): void;
  toggleAllDemoUnits(): void;
  toggleDemoBuildingBlueprintId(buildingBlueprintId: string): void;
  toggleAllDemoBuildings(): void;
  toggleDemoTowerBlueprintId(towerBlueprintId: string): void;
  toggleAllDemoTowers(): void;
  changeMaxTotalUnits(value: number): void;
  setForceFieldsVisible(enabled: boolean): void;
  setShieldsObstructSight(enabled: boolean): void;
  setFogOfWarEnabled(enabled: boolean): void;
  setSlopePathMode(mode: SlopePathMode): void;
  setConverterTax(tax: number): void;
  resetDemoDefaults(): void;
  applyPreset(preset: BattlePreset): void;
};

type GameCanvasBattleSettingsOptions = {
  serverMetaFromSnapshot: Ref<NetworkServerSnapshotMeta | null>;
  currentBattleMode: ComputedRef<BattleMode>;
  demoUnitBlueprintIds: readonly string[];
  demoBuildingBlueprintIds: readonly string[];
  demoTowerBlueprintIds: readonly string[];
  getActiveConnection: () => GameConnection | null;
  broadcastLobbySettingsIfHost: () => void;
  applyCenterMagnitude: (value: number, broadcast?: boolean) => void;
  applyDividersMagnitude: (value: number, broadcast?: boolean) => void;
  applyPerimeterMagnitude: (value: number, broadcast?: boolean) => void;
  applyTerrainDTerrain: (value: number, broadcast?: boolean) => void;
  applyPlateauWallSlopeDegrees: (value: number, broadcast?: boolean) => void;
  applyWatersEdgeBeachSlopeDegrees: (value: number, broadcast?: boolean) => void;
  applyWatersEdgeCliffHeight: (value: number, broadcast?: boolean) => void;
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
  demoBuildingBlueprintIds,
  demoTowerBlueprintIds,
  getActiveConnection,
  broadcastLobbySettingsIfHost,
  applyCenterMagnitude,
  applyDividersMagnitude,
  applyPerimeterMagnitude,
  applyTerrainDTerrain,
  applyPlateauWallSlopeDegrees,
  applyWatersEdgeBeachSlopeDegrees,
  applyWatersEdgeCliffHeight,
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

  // Building / tower enablement (BUILDINGS / TOWERS bar groups). Unlike
  // units — which read their allowed set back from the authoritative
  // server snapshot — structure toggles are driven by local refs seeded
  // from localStorage. Each toggle (a) sends the server command that
  // gates the next base spawn + live-removes existing structures and
  // (b) persists, so the refs and the server stay in lockstep without
  // adding structure fields to the snapshot meta wire format.
  const allowedBuildings = ref<string[]>(
    loadStoredDemoBuildings() ?? getDefaultDemoBuildings(),
  );
  const allowedTowers = ref<string[]>(
    loadStoredDemoTowers() ?? getDefaultDemoTowers(),
  );
  const currentAllowedBuildings = computed<readonly string[]>(() => allowedBuildings.value);
  const currentAllowedBuildingsSet = computed<ReadonlySet<string>>(
    () => new Set(allowedBuildings.value),
  );
  const currentAllowedTowers = computed<readonly string[]>(() => allowedTowers.value);
  const currentAllowedTowersSet = computed<ReadonlySet<string>>(
    () => new Set(allowedTowers.value),
  );
  const allDemoBuildingsActive = computed(() => {
    const allowed = currentAllowedBuildingsSet.value;
    for (let i = 0; i < demoBuildingBlueprintIds.length; i++) {
      if (!allowed.has(demoBuildingBlueprintIds[i])) return false;
    }
    return true;
  });
  const allDemoTowersActive = computed(() => {
    const allowed = currentAllowedTowersSet.value;
    for (let i = 0; i < demoTowerBlueprintIds.length; i++) {
      if (!allowed.has(demoTowerBlueprintIds[i])) return false;
    }
    return true;
  });

  // Generic structure-selection applier shared by buildings and towers.
  // Diffs `nextIds` against the current ref, sends a command only for
  // ids whose enablement actually changed (so toggling one button
  // doesn't churn the others), then rewrites the ref in canonical
  // blueprint order and persists. The command shape differs only in the
  // type tag + id field name between the two structure kinds.
  function applyStructureSelection(
    kind: 'building' | 'tower',
    blueprintIds: readonly string[],
    allowedRef: Ref<string[]>,
    save: (ids: string[]) => void,
    nextIds: readonly string[],
  ): void {
    const next = new Set(nextIds);
    const connection = getActiveConnection();
    for (const blueprintId of blueprintIds) {
      const enabled = next.has(blueprintId);
      if (allowedRef.value.includes(blueprintId) === enabled) continue;
      connection?.sendCommand(
        kind === 'building'
          ? {
              type: 'setBackgroundBuildingBlueprintEnabled',
              tick: 0,
              buildingBlueprintId: blueprintId,
              enabled,
            }
          : {
              type: 'setBackgroundTowerBlueprintEnabled',
              tick: 0,
              towerBlueprintId: blueprintId,
              enabled,
            },
      );
    }
    allowedRef.value = blueprintIds.filter((id) => next.has(id));
    save(allowedRef.value);
  }

  function applyBuildingSelection(nextIds: readonly string[]): void {
    applyStructureSelection('building', demoBuildingBlueprintIds, allowedBuildings, saveDemoBuildings, nextIds);
  }
  function applyTowerSelection(nextIds: readonly string[]): void {
    applyStructureSelection('tower', demoTowerBlueprintIds, allowedTowers, saveDemoTowers, nextIds);
  }

  function toggleDemoBuildingBlueprintId(buildingBlueprintId: string): void {
    const current = allowedBuildings.value.includes(buildingBlueprintId);
    applyBuildingSelection(
      current
        ? allowedBuildings.value.filter((id) => id !== buildingBlueprintId)
        : [...allowedBuildings.value, buildingBlueprintId],
    );
  }
  function toggleAllDemoBuildings(): void {
    applyBuildingSelection(allDemoBuildingsActive.value ? [] : demoBuildingBlueprintIds);
  }
  function toggleDemoTowerBlueprintId(towerBlueprintId: string): void {
    const current = allowedTowers.value.includes(towerBlueprintId);
    applyTowerSelection(
      current
        ? allowedTowers.value.filter((id) => id !== towerBlueprintId)
        : [...allowedTowers.value, towerBlueprintId],
    );
  }
  function toggleAllDemoTowers(): void {
    applyTowerSelection(allDemoTowersActive.value ? [] : demoTowerBlueprintIds);
  }
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
  // Slope mode is not mirrored on the snapshot meta (it would only matter for a
  // second player, and the toggle is demo-only), so the bar reflects the stored
  // value. The version ref re-reads it after each local toggle.
  const slopePathModeStoreVersion = ref(0);
  const currentSlopePathMode = computed<SlopePathMode>(() => {
    void slopePathModeStoreVersion.value;
    return loadStoredSlopePathMode(currentBattleMode.value);
  });
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

  function setSlopePathMode(mode: SlopePathMode): void {
    // SLOPE LIMIT gates the DEMO battle only. The real lockstep game keeps the
    // default policy so every peer agrees without a per-peer stored value.
    if (currentBattleMode.value !== 'demo') return;
    getActiveConnection()?.sendCommand({ type: 'setSlopePathMode', tick: 0, mode });
    saveSlopePathMode(mode, currentBattleMode.value);
    slopePathModeStoreVersion.value++;
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
    applyBuildingSelection([...preset.buildings]);
    applyTowerSelection([...preset.towers]);
    changeMaxTotalUnits(preset.cap, false);
    setForceFieldsVisible(preset.forceFieldsVisible, false);
    setShieldsObstructSight(preset.shieldsObstructSight);
    setFogOfWarEnabled(preset.fogOfWarEnabled);
    setSlopePathMode(preset.slopePathMode);
    setConverterTax(preset.converterTax, false);
    applyCenterMagnitude(preset.centerMagnitude, false);
    applyDividersMagnitude(preset.dividersMagnitude, false);
    applyPerimeterMagnitude(preset.perimeterMagnitude, false);
    applyTerrainDTerrain(preset.terrainDTerrain, false);
    applyPlateauWallSlopeDegrees(preset.plateauWallSlopeDegrees, false);
    applyWatersEdgeBeachSlopeDegrees(preset.watersEdgeBeachSlopeDegrees, false);
    applyWatersEdgeCliffHeight(preset.watersEdgeCliffHeight, false);
    applyMetalDepositStep(preset.metalDepositStep, false);
    applyTerrainDetail(preset.terrainDetail, false);
    applyMapLandDimensions(
      {
        widthLandCells: preset.mapWidthLandCells,
        lengthLandCells: preset.mapLengthLandCells,
      },
      false,
    );
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
    currentAllowedBuildings,
    currentAllowedBuildingsSet,
    allDemoBuildingsActive,
    currentAllowedTowers,
    currentAllowedTowersSet,
    allDemoTowersActive,
    currentForceFieldsVisible,
    currentShieldsObstructSight,
    currentFogOfWarEnabled,
    currentSlopePathMode,
    currentConverterTax,
    toggleDemoUnitBlueprintId,
    toggleAllDemoUnits,
    toggleDemoBuildingBlueprintId,
    toggleAllDemoBuildings,
    toggleDemoTowerBlueprintId,
    toggleAllDemoTowers,
    changeMaxTotalUnits,
    setForceFieldsVisible,
    setShieldsObstructSight,
    setFogOfWarEnabled,
    setSlopePathMode,
    setConverterTax,
    resetDemoDefaults,
    applyPreset,
  };
}
