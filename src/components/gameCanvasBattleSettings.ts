import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import {
  BATTLE_CONFIG,
  loadStoredConverterTax,
  loadStoredForceFieldsVisible,
  loadStoredFogOfWarEnabled,
  loadStoredSlowDownAtFinalWaypoint,
  normalizeConverterTax,
  saveConverterTax,
  loadBattleBuildingRoster,
  saveBattleBuildingRoster,
  saveBattleUnitRoster,
  saveForceFieldsVisible,
  saveFogOfWarEnabled,
  saveSlowDownAtFinalWaypoint,
  loadStoredSlopePathMode,
  saveSlopePathMode,
  loadStoredMetalCoverage,
  loadStoredLiquidSurfaceMode,
  setUnitCap,
  type BattleMode,
} from '../battleBarConfig';
import type { SlopePathMode } from '../types/slopePathMode';
import type { TerrainPrecedence } from '../types/terrainPrecedence';
import type {
  LiquidSurfaceMode,
  MetalCoverage,
} from '../types/worldSurfaceMode';
import type { NetworkServerSnapshotMeta } from '../game/network/NetworkTypes';
import type { GameConnection } from '../game/server/GameConnection';
import type { MapLandCellDimensions } from '../mapSizeConfig';
import {
  type BattlePreset,
  getModeDefaultPreset,
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
  currentForceFieldsVisible: ComputedRef<boolean>;
  /** Live per-player upgrade status: true while the LOCAL player owns a
   *  completed Shield-Aware Targeting Tech building. Read-only — the
   *  TARGETING readout is earned by building, not toggled. */
  localPlayerShieldAwareTargeting: ComputedRef<boolean>;
  /** Live per-player shield power: true while the LOCAL player's team holds
   *  at least one completed, switched-ON Shield Generator. */
  localPlayerShieldsPowered: ComputedRef<boolean>;
  currentFogOfWarEnabled: ComputedRef<boolean>;
  currentSlowDownAtFinalWaypoint: ComputedRef<boolean>;
  currentSlopePathMode: ComputedRef<SlopePathMode>;
  currentMetalCoverage: ComputedRef<MetalCoverage>;
  currentLiquidSurfaceMode: ComputedRef<LiquidSurfaceMode>;
  currentConverterTax: ComputedRef<number>;
  toggleDemoUnitBlueprintId(unitBlueprintId: string): void;
  toggleAllDemoUnits(): void;
  toggleDemoBuildingBlueprintId(buildingBlueprintId: string): void;
  toggleAllDemoBuildings(): void;
  changeEntityCountCap(value: number): void;
  setForceFieldsVisible(enabled: boolean): void;
  setFogOfWarEnabled(enabled: boolean): void;
  setSlowDownAtFinalWaypoint(enabled: boolean, broadcast?: boolean): void;
  setSlopePathMode(mode: SlopePathMode): void;
  setMetalCoverage(mode: MetalCoverage, broadcast?: boolean): void;
  setLiquidSurfaceMode(mode: LiquidSurfaceMode, broadcast?: boolean): void;
  setConverterTax(tax: number): void;
  resetDemoDefaults(): void;
  applyPreset(preset: BattlePreset): void;
};

type GameCanvasBattleSettingsOptions = {
  serverMetaFromSnapshot: Ref<NetworkServerSnapshotMeta | null>;
  /** The seat this client controls; selects its bit in the per-player
   *  upgrade masks mirrored through snapshot meta. */
  localPlayerId: Ref<number>;
  currentBattleMode: ComputedRef<BattleMode>;
  slowDownAtFinalWaypointStoreVersion: Ref<number>;
  worldSurfaceStoreVersion: Ref<number>;
  demoUnitBlueprintIds: readonly string[];
  demoBuildingBlueprintIds: readonly string[];
  getActiveConnection: () => GameConnection | null;
  broadcastLobbySettingsIfHost: () => void;
  applyCenterMagnitude: (value: number, broadcast?: boolean) => void;
  applyDividersMagnitude: (value: number, broadcast?: boolean) => void;
  applyPerimeterMagnitude: (value: number, broadcast?: boolean) => void;
  applyTerrainPrecedence: (
    value: TerrainPrecedence,
    broadcast?: boolean,
  ) => void;
  applyTerrainDTerrain: (value: number, broadcast?: boolean) => void;
  applyPlateauWallSlopeDegrees: (value: number, broadcast?: boolean) => void;
  applyMetalDepositStep: (value: number, broadcast?: boolean) => void;
  applyTerrainDetail: (value: number, broadcast?: boolean) => void;
  applyMetalCoverage: (mode: MetalCoverage, broadcast?: boolean) => void;
  applyLiquidSurfaceMode: (mode: LiquidSurfaceMode, broadcast?: boolean) => void;
  applyMapLandDimensions: (
    dimensions: MapLandCellDimensions,
    broadcast?: boolean,
  ) => void;
};

export function useGameCanvasBattleSettings({
  serverMetaFromSnapshot,
  localPlayerId,
  currentBattleMode,
  slowDownAtFinalWaypointStoreVersion,
  worldSurfaceStoreVersion,
  demoUnitBlueprintIds,
  demoBuildingBlueprintIds,
  getActiveConnection,
  broadcastLobbySettingsIfHost,
  applyCenterMagnitude,
  applyDividersMagnitude,
  applyPerimeterMagnitude,
  applyTerrainPrecedence,
  applyTerrainDTerrain,
  applyPlateauWallSlopeDegrees,
  applyMetalDepositStep,
  applyTerrainDetail,
  applyMetalCoverage,
  applyLiquidSurfaceMode,
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

  // Building enablement (the BUILDINGS bar group). Unlike
  // units — which read their allowed set back from the authoritative
  // server snapshot — structure toggles are driven by a local ref seeded
  // from the mode's roster store (persistent Demo, in-memory Real). Each
  // toggle (a) sends the server command that
  // gates the next base spawn + live-removes existing structures and
  // (b) saves to that mode store, so the refs and server stay in lockstep without
  // adding structure fields to the snapshot meta wire format.
  const allowedBuildings = ref<string[]>(
    loadBattleBuildingRoster(currentBattleMode.value),
  );
  watch(currentBattleMode, (mode) => {
    allowedBuildings.value = loadBattleBuildingRoster(mode);
  }, { flush: 'sync' });
  const currentAllowedBuildings = computed<readonly string[]>(() => allowedBuildings.value);
  const currentAllowedBuildingsSet = computed<ReadonlySet<string>>(
    () => new Set(allowedBuildings.value),
  );
  const allDemoBuildingsActive = computed(() => {
    const allowed = currentAllowedBuildingsSet.value;
    for (let i = 0; i < demoBuildingBlueprintIds.length; i++) {
      if (!allowed.has(demoBuildingBlueprintIds[i])) return false;
    }
    return true;
  });
  // Diff a requested building roster against the current one, send only
  // changed ids, then persist the canonical blueprint order.
  function applyBuildingSelection(nextIds: readonly string[]): void {
    const next = new Set(nextIds);
    const connection = getActiveConnection();
    for (const buildingBlueprintId of demoBuildingBlueprintIds) {
      const enabled = next.has(buildingBlueprintId);
      if (allowedBuildings.value.includes(buildingBlueprintId) === enabled) continue;
      connection?.sendCommand({
        type: 'setBackgroundBuildingBlueprintEnabled',
        tick: 0,
        buildingBlueprintId,
        enabled,
      });
    }
    allowedBuildings.value = demoBuildingBlueprintIds.filter((id) => next.has(id));
    saveBattleBuildingRoster(allowedBuildings.value, currentBattleMode.value);
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
  function localPlayerHoldsMaskBit(mask: number | undefined): boolean {
    const playerId = localPlayerId.value;
    if (mask === undefined || playerId < 1 || playerId > 31) return false;
    return (mask & (1 << (playerId - 1))) !== 0;
  }
  const localPlayerShieldAwareTargeting = computed(() =>
    localPlayerHoldsMaskBit(
      serverMetaFromSnapshot.value?.shieldAwareTargetingPlayerMask,
    ));
  const localPlayerShieldsPowered = computed(() =>
    localPlayerHoldsMaskBit(serverMetaFromSnapshot.value?.shieldPowerPlayerMask));
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
  const currentSlowDownAtFinalWaypoint = computed(() => {
    void slowDownAtFinalWaypointStoreVersion.value;
    return loadStoredSlowDownAtFinalWaypoint(currentBattleMode.value);
  });
  // Slope mode is not mirrored on the snapshot meta (it would only matter for a
  // second player, and the toggle is demo-only), so the bar reflects the stored
  // value. The version ref re-reads it after each local toggle.
  const slopePathModeStoreVersion = ref(0);
  const currentSlopePathMode = computed<SlopePathMode>(() => {
    void slopePathModeStoreVersion.value;
    return loadStoredSlopePathMode(currentBattleMode.value);
  });
  // Same story as the slope mode: the WORLD toggles are not mirrored on the
  // snapshot meta, so the bar reflects the stored value and the version refs
  // re-read it after each local toggle.
  const currentMetalCoverage = computed<MetalCoverage>(() => {
    void worldSurfaceStoreVersion.value;
    return loadStoredMetalCoverage(currentBattleMode.value);
  });
  const currentLiquidSurfaceMode = computed<LiquidSurfaceMode>(() => {
    void worldSurfaceStoreVersion.value;
    return loadStoredLiquidSurfaceMode(currentBattleMode.value);
  });
  const currentConverterTax = computed(
    () =>
      serverMetaFromSnapshot.value?.converterTax ??
      loadStoredConverterTax(currentBattleMode.value),
  );

  function applyUnitSelection(nextIds: readonly string[]): void {
    const next = new Set(nextIds);
    const allowed = currentAllowedUnitsSet.value;
    const canSkipUnchanged = serverMetaFromSnapshot.value?.units.allowed !== undefined;
    const connection = getActiveConnection();
    for (const unitBlueprintId of demoUnitBlueprintIds) {
      const enabled = next.has(unitBlueprintId);
      if (canSkipUnchanged && allowed.has(unitBlueprintId) === enabled) continue;
      connection?.sendCommand({
        type: 'setBackgroundUnitBlueprintEnabled',
        tick: 0,
        unitBlueprintId,
        enabled,
      });
    }
    saveBattleUnitRoster(
      demoUnitBlueprintIds.filter((id) => next.has(id)),
      currentBattleMode.value,
    );
  }

  function toggleDemoUnitBlueprintId(unitBlueprintId: string): void {
    const allowed = currentAllowedUnits.value;
    const current = allowed.includes(unitBlueprintId);
    applyUnitSelection(
      current
        ? allowed.filter((unit) => unit !== unitBlueprintId)
        : [...allowed, unitBlueprintId],
    );
  }

  function toggleAllDemoUnits(): void {
    const enableAll = !allDemoUnitsActive.value;
    applyUnitSelection(enableAll ? demoUnitBlueprintIds : []);
  }

  function changeEntityCountCap(value: number, broadcast = true): void {
    const mode = currentBattleMode.value;
    const authoritative = serverMetaFromSnapshot.value?.units.max;
    const changed = authoritative === undefined || authoritative !== value;
    if (changed) {
      getActiveConnection()?.sendCommand({
        type: 'setEntityCountCap',
        tick: 0,
        entityCountCap: value,
      });
    }
    setUnitCap(mode, value);
    if (changed && broadcast && mode === 'real') broadcastLobbySettingsIfHost();
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

  function setSlowDownAtFinalWaypoint(enabled: boolean, broadcast = true): void {
    const mode = currentBattleMode.value;
    const changed = loadStoredSlowDownAtFinalWaypoint(mode) !== enabled;
    if (changed) {
      getActiveConnection()?.sendCommand({
        type: 'setSlowDownAtFinalWaypoint',
        tick: 0,
        enabled,
      });
    }
    saveSlowDownAtFinalWaypoint(enabled, mode);
    if (!changed) return;
    slowDownAtFinalWaypointStoreVersion.value++;
    if (broadcast && mode === 'real') broadcastLobbySettingsIfHost();
  }

  function setSlopePathMode(mode: SlopePathMode): void {
    // SLOPE LIMIT gates the DEMO battle only. The real lockstep game keeps the
    // default policy so every peer agrees without a per-peer stored value.
    if (currentBattleMode.value !== 'demo') return;
    getActiveConnection()?.sendCommand({ type: 'setSlopePathMode', tick: 0, mode });
    saveSlopePathMode(mode, currentBattleMode.value);
    slopePathModeStoreVersion.value++;
  }

  // Both WORLD toggles restart the battle: SURFACE decides whether deposit
  // crowns exist and which cells are metal, and LIQUID is baked into the
  // terrain mesh's per-vertex horizon liquid colour, so neither can be
  // re-shaded in place.
  function setMetalCoverage(mode: MetalCoverage, broadcast = true): void {
    getActiveConnection()?.sendCommand({ type: 'setMetalCoverage', tick: 0, mode });
    applyMetalCoverage(mode, broadcast);
  }

  function setLiquidSurfaceMode(mode: LiquidSurfaceMode, broadcast = true): void {
    getActiveConnection()?.sendCommand({ type: 'setLiquidSurfaceMode', tick: 0, mode });
    applyLiquidSurfaceMode(mode, broadcast);
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

  // Presets describe the MAP. The entity count cap is deliberately absent:
  // switching maps must never resize the battle, so only an explicit CAP
  // click moves it. Content rosters are independent session/sandbox choices;
  // applying a terrain preset must never replace them.
  function applyPreset(preset: BattlePreset): void {
    setFogOfWarEnabled(preset.fogOfWarEnabled);
    setSlowDownAtFinalWaypoint(preset.slowDownAtFinalWaypoint, false);
    setSlopePathMode(preset.slopePathMode);
    if (preset.metalCoverage !== currentMetalCoverage.value) {
      setMetalCoverage(preset.metalCoverage, false);
    }
    if (preset.liquidSurfaceMode !== currentLiquidSurfaceMode.value) {
      setLiquidSurfaceMode(preset.liquidSurfaceMode, false);
    }
    setConverterTax(preset.converterTax, false);
    applyCenterMagnitude(preset.centerMagnitude, false);
    applyDividersMagnitude(preset.dividersMagnitude, false);
    applyPerimeterMagnitude(preset.perimeterMagnitude, false);
    applyTerrainPrecedence(preset.terrainPrecedence, false);
    applyTerrainDTerrain(preset.terrainDTerrain, false);
    applyPlateauWallSlopeDegrees(preset.plateauWallSlopeDegrees, false);
    applyMetalDepositStep(preset.metalDepositStep, false);
    applyTerrainDetail(preset.terrainDetail, false);
    applyMapLandDimensions(
      {
        widthLandCells: preset.mapWidthLandCells,
        lengthLandCells: preset.mapLengthLandCells,
      },
      false,
    );
    broadcastLobbySettingsIfHost();
  }

  function resetDemoDefaults(): void {
    // DEFAULTS owns the mode policy, not a map preset: both contexts reset to
    // the complete current registries, Demo persists that choice, and Real
    // keeps it only for the current lobby/match session.
    applyUnitSelection(demoUnitBlueprintIds);
    applyBuildingSelection(demoBuildingBlueprintIds);
    applyPreset(getModeDefaultPreset(currentBattleMode.value));
  }

  return {
    currentAllowedUnits,
    currentAllowedUnitsSet,
    allDemoUnitsActive,
    currentAllowedBuildings,
    currentAllowedBuildingsSet,
    allDemoBuildingsActive,
    currentForceFieldsVisible,
    localPlayerShieldAwareTargeting,
    localPlayerShieldsPowered,
    currentFogOfWarEnabled,
    currentSlowDownAtFinalWaypoint,
    currentSlopePathMode,
    currentMetalCoverage,
    currentLiquidSurfaceMode,
    currentConverterTax,
    toggleDemoUnitBlueprintId,
    toggleAllDemoUnits,
    toggleDemoBuildingBlueprintId,
    toggleAllDemoBuildings,
    changeEntityCountCap,
    setForceFieldsVisible,
    setFogOfWarEnabled,
    setSlowDownAtFinalWaypoint,
    setSlopePathMode,
    setMetalCoverage,
    setLiquidSurfaceMode,
    setConverterTax,
    resetDemoDefaults,
    applyPreset,
  };
}
