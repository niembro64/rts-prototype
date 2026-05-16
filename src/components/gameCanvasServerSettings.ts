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
  saveSimQuality,
  saveSimSignalStates,
  saveSnapshotRate,
  saveTickRate,
  saveTiltEmaMode,
  resetSimSignalStates,
} from '../serverBarConfig';
import { SERVER_SIM_QUALITY_DEFAULT } from '../serverSimLodConfig';
import type { TiltEmaMode } from '../shellConfig';
import type { KeyframeRatio, SnapshotRate, TickRate } from '../types/server';
import type { ServerSimQuality, ServerSimSignalStates } from '../types/serverSimLod';

export type GameCanvasServerSettings = {
  resetServerDefaults(): void;
  setNetworkUpdateRate(rate: SnapshotRate): void;
  setTickRateValue(rate: TickRate): void;
  setTiltEmaModeValue(mode: TiltEmaMode): void;
  setSimQualityValue(quality: ServerSimQuality): void;
  cycleServerSignal(signal: keyof ServerSimSignalStates): void;
  setKeyframeRatioValue(ratio: KeyframeRatio): void;
  toggleSendGridInfo(): void;
  resetGridInfoToDefault(): void;
};

export type GameCanvasServerSettingsOptions = {
  currentBattleMode: ComputedRef<BattleMode>;
  displayGridInfo: ComputedRef<boolean>;
  serverSimQuality: Ref<ServerSimQuality>;
  serverTiltEmaMode: Ref<TiltEmaMode>;
  serverSignalStates: Ref<ServerSimSignalStates>;
  getActiveConnection: () => GameConnection | null;
};

export function useGameCanvasServerSettings({
  currentBattleMode,
  displayGridInfo,
  serverSimQuality,
  serverTiltEmaMode,
  serverSignalStates,
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

  function setTiltEmaModeValue(mode: TiltEmaMode): void {
    getActiveConnection()?.sendCommand({ type: 'setTiltEmaMode', tick: 0, mode });
    saveTiltEmaMode(mode);
    serverTiltEmaMode.value = mode;
  }

  function setSimQualityValue(quality: ServerSimQuality): void {
    getActiveConnection()?.sendCommand({ type: 'setSimQuality', tick: 0, quality });
    saveSimQuality(quality);
    serverSimQuality.value = quality;
  }

  function cycleServerSignal(signal: keyof ServerSimSignalStates): void {
    const cur = serverSignalStates.value[signal];
    const next = cur === 'off' ? 'active' : cur === 'active' ? 'solo' : 'off';
    const updated: ServerSimSignalStates = { ...serverSignalStates.value, [signal]: next };
    if (next === 'solo') {
      (Object.keys(updated) as (keyof ServerSimSignalStates)[]).forEach((key) => {
        if (key !== signal && updated[key] === 'solo') updated[key] = 'active';
      });
    }
    serverSignalStates.value = updated;
    saveSimSignalStates(updated);
    getActiveConnection()?.sendCommand({
      type: 'setSimSignalStates',
      tick: 0,
      tps: updated.tps,
      cpu: updated.cpu,
      units: updated.units,
    });
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
    setSimQualityValue(SERVER_SIM_QUALITY_DEFAULT);
    const fresh = resetSimSignalStates();
    serverSignalStates.value = fresh;
    getActiveConnection()?.sendCommand({
      type: 'setSimSignalStates',
      tick: 0,
      tps: fresh.tps,
      cpu: fresh.cpu,
      units: fresh.units,
    });
  }

  return {
    resetServerDefaults,
    setNetworkUpdateRate,
    setTickRateValue,
    setTiltEmaModeValue,
    setSimQualityValue,
    cycleServerSignal,
    setKeyframeRatioValue,
    toggleSendGridInfo,
    resetGridInfoToDefault,
  };
}
