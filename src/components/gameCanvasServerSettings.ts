import type { ComputedRef, Ref } from 'vue';
import {
  getDefaultGrid,
  saveStoredGrid,
  type BattleMode,
} from '../battleBarConfig';
import type { GameConnection } from '../game/server/GameConnection';
import {
  SERVER_CONFIG,
  saveUnitGroundNormalEmaMode,
} from '../serverBarConfig';
import type { UnitGroundNormalEmaMode } from '../shellConfig';
import type { KeyframeRatio, SnapshotRate, TickRate } from '../types/server';

export type GameCanvasServerSettings = {
  resetServerDefaults(): void;
  setNetworkUpdateRate(rate: SnapshotRate): void;
  setTickRateValue(rate: TickRate): void;
  setUnitGroundNormalEmaModeValue(mode: UnitGroundNormalEmaMode): void;
  setKeyframeRatioValue(ratio: KeyframeRatio): void;
  toggleSendGridInfo(): void;
  resetGridInfoToDefault(): void;
};

export type GameCanvasServerSettingsOptions = {
  currentBattleMode: ComputedRef<BattleMode>;
  displayGridInfo: ComputedRef<boolean>;
  serverUnitGroundNormalEmaMode: Ref<UnitGroundNormalEmaMode>;
  getActiveConnection: () => GameConnection | null;
};

export function useGameCanvasServerSettings({
  currentBattleMode,
  displayGridInfo,
  serverUnitGroundNormalEmaMode,
  getActiveConnection,
}: GameCanvasServerSettingsOptions): GameCanvasServerSettings {
  function setNetworkUpdateRate(_rate: SnapshotRate): void {
    // Snapshot cadence is no longer player-configurable in real battles.
  }

  function setTickRateValue(_rate: TickRate): void {
    // Deterministic-lockstep uses the fixed architecture-config step rate.
  }

  function setUnitGroundNormalEmaModeValue(mode: UnitGroundNormalEmaMode): void {
    getActiveConnection()?.sendCommand({ type: 'setUnitGroundNormalEmaMode', tick: 0, mode });
    saveUnitGroundNormalEmaMode(mode, currentBattleMode.value);
    serverUnitGroundNormalEmaMode.value = mode;
  }

  function setKeyframeRatioValue(_ratio: KeyframeRatio): void {
    // Full-keyframe cadence is internal presentation plumbing in lockstep.
  }

  function toggleSendGridInfo(): void {
    const current = displayGridInfo.value;
    getActiveConnection()?.sendCommand({
      type: 'setSendGridInfo',
      tick: 0,
      enabled: !current,
    });
    saveStoredGrid(currentBattleMode.value, !current);
  }

  function resetGridInfoToDefault(): void {
    const gridDefault = getDefaultGrid(currentBattleMode.value);
    if (displayGridInfo.value !== gridDefault) toggleSendGridInfo();
  }

  function resetServerDefaults(): void {
    setUnitGroundNormalEmaModeValue(SERVER_CONFIG.unitGroundNormalEma.default);
  }

  return {
    resetServerDefaults,
    setNetworkUpdateRate,
    setTickRateValue,
    setUnitGroundNormalEmaModeValue,
    setKeyframeRatioValue,
    toggleSendGridInfo,
    resetGridInfoToDefault,
  };
}
