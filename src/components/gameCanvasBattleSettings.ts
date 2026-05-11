import { computed, type ComputedRef, type Ref } from 'vue';
import {
  BATTLE_CONFIG,
  getDefaultCap,
  getDefaultDemoUnits,
  saveForceFieldReflectionMode,
  saveDemoUnits,
  saveForceFieldsEnabled,
  saveMirrorsEnabled,
  saveStoredCap,
  type BattleMode,
} from '../battleBarConfig';
import type { ForceFieldReflectionMode } from '../types/shotTypes';
import type { NetworkServerSnapshotMeta } from '../game/network/NetworkTypes';
import type { GameConnection } from '../game/server/GameConnection';

export type GameCanvasBattleSettings = {
  currentAllowedUnits: ComputedRef<readonly string[]>;
  allDemoUnitsActive: ComputedRef<boolean>;
  currentMirrorsEnabled: ComputedRef<boolean>;
  currentForceFieldsEnabled: ComputedRef<boolean>;
  currentForceFieldReflectionMode: ComputedRef<ForceFieldReflectionMode>;
  toggleDemoUnitType(unitType: string): void;
  toggleAllDemoUnits(): void;
  changeMaxTotalUnits(value: number): void;
  setMirrorsEnabled(enabled: boolean): void;
  setForceFieldsEnabled(enabled: boolean): void;
  setForceFieldReflectionMode(mode: ForceFieldReflectionMode): void;
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
  const allDemoUnitsActive = computed(() =>
    demoUnitTypes.every((unitType) => currentAllowedUnits.value.includes(unitType)),
  );
  const currentMirrorsEnabled = computed(
    () => serverMetaFromSnapshot.value?.mirrorsEnabled ?? BATTLE_CONFIG.mirrorsEnabled.default,
  );
  const currentForceFieldsEnabled = computed(
    () => serverMetaFromSnapshot.value?.forceFieldsEnabled ?? BATTLE_CONFIG.forceFieldsEnabled.default,
  );
  const currentForceFieldReflectionMode = computed<ForceFieldReflectionMode>(
    () =>
      serverMetaFromSnapshot.value?.forceFieldReflectionMode ??
      BATTLE_CONFIG.forceFieldReflectionMode.default,
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

  function setMirrorsEnabled(enabled: boolean): void {
    getActiveConnection()?.sendCommand({ type: 'setMirrorsEnabled', tick: 0, enabled });
    saveMirrorsEnabled(enabled, currentBattleMode.value);
  }

  function setForceFieldsEnabled(enabled: boolean): void {
    getActiveConnection()?.sendCommand({ type: 'setForceFieldsEnabled', tick: 0, enabled });
    saveForceFieldsEnabled(enabled, currentBattleMode.value);
  }

  function setForceFieldReflectionMode(mode: ForceFieldReflectionMode): void {
    getActiveConnection()?.sendCommand({
      type: 'setForceFieldReflectionMode',
      tick: 0,
      mode,
    });
    saveForceFieldReflectionMode(mode, currentBattleMode.value);
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
    setMirrorsEnabled(BATTLE_CONFIG.mirrorsEnabled.default);
    setForceFieldsEnabled(BATTLE_CONFIG.forceFieldsEnabled.default);
    setForceFieldReflectionMode(BATTLE_CONFIG.forceFieldReflectionMode.default);
    resetTerrainDefaults();
    resetGridInfoToDefault();
    broadcastLobbySettingsIfHost();
  }

  return {
    currentAllowedUnits,
    allDemoUnitsActive,
    currentMirrorsEnabled,
    currentForceFieldsEnabled,
    currentForceFieldReflectionMode,
    toggleDemoUnitType,
    toggleAllDemoUnits,
    changeMaxTotalUnits,
    setMirrorsEnabled,
    setForceFieldsEnabled,
    setForceFieldReflectionMode,
    resetDemoDefaults,
  };
}
