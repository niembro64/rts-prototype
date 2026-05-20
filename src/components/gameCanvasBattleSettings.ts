import { computed, type ComputedRef, type Ref } from 'vue';
import {
  BATTLE_CONFIG,
  getDefaultCap,
  getDefaultFogOfWar,
  getDefaultDemoUnits,
  loadStoredFogOfWarEnabled,
  saveDemoUnits,
  saveForceFieldsBlockTargeting,
  saveFogOfWarEnabled,
  saveStoredCap,
  type BattleMode,
} from '../battleBarConfig';
import type { NetworkServerSnapshotMeta } from '../game/network/NetworkTypes';
import type { GameConnection } from '../game/server/GameConnection';

export type GameCanvasBattleSettings = {
  currentAllowedUnits: ComputedRef<readonly string[]>;
  /** Set-backed view of currentAllowedUnits so consumers in v-for
   *  templates can do O(1) membership lookups instead of array
   *  .includes on every parent re-render. */
  currentAllowedUnitsSet: ComputedRef<ReadonlySet<string>>;
  allDemoUnitsActive: ComputedRef<boolean>;
  currentForceFieldsBlockTargeting: ComputedRef<boolean>;
  currentFogOfWarEnabled: ComputedRef<boolean>;
  toggleDemoUnitType(unitType: string): void;
  toggleAllDemoUnits(): void;
  changeMaxTotalUnits(value: number): void;
  setForceFieldsBlockTargeting(enabled: boolean): void;
  setFogOfWarEnabled(enabled: boolean): void;
  resetDemoDefaults(): void;
};

export type GameCanvasBattleSettingsOptions = {
  serverMetaFromSnapshot: Ref<NetworkServerSnapshotMeta | null>;
  currentBattleMode: ComputedRef<BattleMode>;
  demoUnitTypes: readonly string[];
  getActiveConnection: () => GameConnection | null;
  resetTerrainDefaults: () => void;
  resetGridInfoToDefault: () => void;
  broadcastLobbySettingsIfHost: () => void;
};

export function useGameCanvasBattleSettings({
  serverMetaFromSnapshot,
  currentBattleMode,
  demoUnitTypes,
  getActiveConnection,
  resetTerrainDefaults,
  resetGridInfoToDefault,
  broadcastLobbySettingsIfHost,
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
  const currentForceFieldsBlockTargeting = computed(
    () =>
      serverMetaFromSnapshot.value?.forceFieldsBlockTargeting ??
      BATTLE_CONFIG.forceFieldsBlockTargeting.default,
  );
  const currentFogOfWarEnabled = computed(
    () =>
      serverMetaFromSnapshot.value?.fogOfWarEnabled ??
      loadStoredFogOfWarEnabled(currentBattleMode.value),
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

  function setForceFieldsBlockTargeting(enabled: boolean): void {
    getActiveConnection()?.sendCommand({ type: 'setForceFieldsBlockTargeting', tick: 0, enabled });
    saveForceFieldsBlockTargeting(enabled, currentBattleMode.value);
  }

  function setFogOfWarEnabled(enabled: boolean): void {
    getActiveConnection()?.sendCommand({ type: 'setFogOfWarEnabled', tick: 0, enabled });
    saveFogOfWarEnabled(enabled, currentBattleMode.value);
    if (currentBattleMode.value === 'real') broadcastLobbySettingsIfHost();
  }

  function resetDemoDefaults(): void {
    const defaultUnits = getDefaultDemoUnits();
    const defaultSet = new Set(defaultUnits);
    for (const unitType of demoUnitTypes) {
      getActiveConnection()?.sendCommand({
        type: 'setBackgroundUnitType',
        tick: 0,
        unitType,
        enabled: defaultSet.has(unitType),
      });
    }
    saveDemoUnits(defaultUnits);
    changeMaxTotalUnits(getDefaultCap(currentBattleMode.value));
    setForceFieldsBlockTargeting(BATTLE_CONFIG.forceFieldsBlockTargeting.default);
    setFogOfWarEnabled(getDefaultFogOfWar(currentBattleMode.value));
    resetTerrainDefaults();
    resetGridInfoToDefault();
    broadcastLobbySettingsIfHost();
  }

  return {
    currentAllowedUnits,
    currentAllowedUnitsSet,
    allDemoUnitsActive,
    currentForceFieldsBlockTargeting,
    currentFogOfWarEnabled,
    toggleDemoUnitType,
    toggleAllDemoUnits,
    changeMaxTotalUnits,
    setForceFieldsBlockTargeting,
    setFogOfWarEnabled,
    resetDemoDefaults,
  };
}
