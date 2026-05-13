import type { BattleMode } from '../../battleBarConfig';
import {
  loadStoredForceFieldReflectionMode,
  loadStoredForceFieldsBlockTargeting,
  loadStoredForceFieldsEnabled,
  loadStoredFogOfWarEnabled,
  loadStoredGrid,
  loadStoredMirrorsEnabled,
} from '../../battleBarConfig';
import {
  loadStoredKeyframeRatio,
  loadStoredSnapshotRate,
  loadStoredTickRate,
  loadStoredTiltEmaMode,
} from '../../serverBarConfig';
import type { ServerSimQuality, ServerSimSignalStates } from '../../types/serverSimLod';
import type { GameServer } from './GameServer';

export type StoredBattleServerSettingsOptions = {
  ipAddress?: string;
  maxTotalUnits?: number;
  simQuality?: ServerSimQuality;
  simSignalStates?: ServerSimSignalStates;
};

export function applyStoredBattleServerSettings(
  server: GameServer,
  mode: BattleMode,
  options: StoredBattleServerSettingsOptions = {},
): void {
  server.setTickRate(loadStoredTickRate());
  server.setSnapshotRate(loadStoredSnapshotRate());
  server.setKeyframeRatio(loadStoredKeyframeRatio());
  server.receiveCommand({
    type: 'setTiltEmaMode',
    tick: 0,
    mode: loadStoredTiltEmaMode(),
  });

  if (options.simQuality !== undefined) {
    server.setSimQuality(options.simQuality);
  }
  if (options.simSignalStates) {
    server.receiveCommand({
      type: 'setSimSignalStates',
      tick: 0,
      tps: options.simSignalStates.tps,
      cpu: options.simSignalStates.cpu,
      units: options.simSignalStates.units,
    });
  }
  if (options.ipAddress !== undefined) {
    server.setIpAddress(options.ipAddress);
  }
  if (options.maxTotalUnits !== undefined) {
    server.receiveCommand({
      type: 'setMaxTotalUnits',
      tick: 0,
      maxTotalUnits: options.maxTotalUnits,
    });
  }

  server.receiveCommand({
    type: 'setMirrorsEnabled',
    tick: 0,
    enabled: loadStoredMirrorsEnabled(mode),
  });
  server.receiveCommand({
    type: 'setForceFieldsEnabled',
    tick: 0,
    enabled: loadStoredForceFieldsEnabled(mode),
  });
  server.receiveCommand({
    type: 'setForceFieldsBlockTargeting',
    tick: 0,
    enabled: loadStoredForceFieldsBlockTargeting(mode),
  });
  server.receiveCommand({
    type: 'setForceFieldReflectionMode',
    tick: 0,
    mode: loadStoredForceFieldReflectionMode(mode),
  });
  server.receiveCommand({
    type: 'setFogOfWarEnabled',
    tick: 0,
    enabled: loadStoredFogOfWarEnabled(mode),
  });
  server.receiveCommand({
    type: 'setSendGridInfo',
    tick: 0,
    enabled: loadStoredGrid(mode),
  });
}
