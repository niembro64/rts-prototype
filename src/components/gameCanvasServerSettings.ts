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
import { ARCHITECTURE_CONFIG } from '../architectureConfig';

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
  const usesAuthoritativeSnapshotTiming =
    ARCHITECTURE_CONFIG.backend === 'authoritative-server';

  function setNetworkUpdateRate(rate: SnapshotRate): void {
    if (!usesAuthoritativeSnapshotTiming) return;
    const normalizedRate = normalizeSnapshotRate(rate);
    getActiveConnection()?.sendCommand({
      type: 'setSnapshotRate',
      tick: 0,
      rate: normalizedRate,
    });
    saveSnapshotRate(normalizedRate, currentBattleMode.value);
  }

  function setTickRateValue(rate: TickRate): void {
    if (!usesAuthoritativeSnapshotTiming) return;
    getActiveConnection()?.sendCommand({ type: 'setTickRate', tick: 0, rate });
    saveTickRate(rate, currentBattleMode.value);
  }

  function setUnitGroundNormalEmaModeValue(mode: UnitGroundNormalEmaMode): void {
    getActiveConnection()?.sendCommand({ type: 'setUnitGroundNormalEmaMode', tick: 0, mode });
    saveUnitGroundNormalEmaMode(mode, currentBattleMode.value);
    serverUnitGroundNormalEmaMode.value = mode;
  }

  function setKeyframeRatioValue(ratio: KeyframeRatio): void {
    if (!usesAuthoritativeSnapshotTiming) return;
    getActiveConnection()?.sendCommand({ type: 'setKeyframeRatio', tick: 0, ratio });
    saveKeyframeRatio(ratio, currentBattleMode.value);
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
    if (!usesAuthoritativeSnapshotTiming) {
      setUnitGroundNormalEmaModeValue(SERVER_CONFIG.unitGroundNormalEma.default);
      return;
    }
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
