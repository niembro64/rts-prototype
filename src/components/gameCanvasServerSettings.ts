import type { ComputedRef, Ref } from 'vue';
import {
  getDefaultGrid,
  saveStoredGrid,
  type BattleMode,
} from '../battleBarConfig';
import type { GameConnection } from '../game/server/GameConnection';
import {
  SERVER_CONFIG,
  normalizeSnapshotRate,
  saveKeyframeRatio,
  saveSnapshotRate,
  saveTickRate,
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
  function setNetworkUpdateRate(rate: SnapshotRate): void {
    const normalizedRate = normalizeSnapshotRate(rate);
    getActiveConnection()?.sendCommand({
      type: 'setSnapshotRate',
      tick: 0,
      rate: normalizedRate,
    });
    saveSnapshotRate(normalizedRate);
  }

  function setTickRateValue(rate: TickRate): void {
    getActiveConnection()?.sendCommand({ type: 'setTickRate', tick: 0, rate });
    saveTickRate(rate);
  }

  function setUnitGroundNormalEmaModeValue(mode: UnitGroundNormalEmaMode): void {
    getActiveConnection()?.sendCommand({ type: 'setUnitGroundNormalEmaMode', tick: 0, mode });
    saveUnitGroundNormalEmaMode(mode);
    serverUnitGroundNormalEmaMode.value = mode;
  }

  function setKeyframeRatioValue(ratio: KeyframeRatio): void {
    getActiveConnection()?.sendCommand({ type: 'setKeyframeRatio', tick: 0, ratio });
    saveKeyframeRatio(ratio);
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
    setTickRateValue(SERVER_CONFIG.tickRate.default);
    setNetworkUpdateRate(SERVER_CONFIG.snapshot.default);
    setKeyframeRatioValue(SERVER_CONFIG.keyframe.default);
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
