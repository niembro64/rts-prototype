import type { BattleMode } from '../../battleBarConfig';
import {
  loadStoredFfAccelShots,
  loadStoredFfAccelUnits,
  loadStoredFiringForce,
  loadStoredGrid,
  loadStoredHitForce,
  loadStoredProjVelInherit,
} from '../../battleBarConfig';
import {
  loadStoredKeyframeRatio,
  loadStoredSnapshotRate,
  loadStoredTickRate,
} from '../../serverBarConfig';
import type { ServerSimQuality, ServerSimSignalStates } from '../../types/serverSimLod';
import type { GameServer } from './GameServer';

export type StoredBattleServerSettingsOptions = {
  ipAddress?: string;
  maxTotalUnits?: number;
  simQuality?: ServerSimQuality;
  simSignalStates?: ServerSimSignalStates;
  includeForceSettings?: boolean;
};

export function applyStoredBattleServerSettings(
  server: GameServer,
  mode: BattleMode,
  options: StoredBattleServerSettingsOptions = {},
): void {
  server.setTickRate(loadStoredTickRate());
  server.setSnapshotRate(loadStoredSnapshotRate());
  server.setKeyframeRatio(loadStoredKeyframeRatio());

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
    type: 'setProjVelInherit',
    tick: 0,
    enabled: loadStoredProjVelInherit(mode),
  });
  if (options.includeForceSettings) {
    server.receiveCommand({
      type: 'setFiringForce',
      tick: 0,
      enabled: loadStoredFiringForce(mode),
    });
    server.receiveCommand({
      type: 'setHitForce',
      tick: 0,
      enabled: loadStoredHitForce(mode),
    });
  }
  server.receiveCommand({
    type: 'setFfAccelUnits',
    tick: 0,
    enabled: loadStoredFfAccelUnits(mode),
  });
  server.receiveCommand({
    type: 'setFfAccelShots',
    tick: 0,
    enabled: loadStoredFfAccelShots(mode),
  });
  server.receiveCommand({
    type: 'setSendGridInfo',
    tick: 0,
    enabled: loadStoredGrid(mode),
  });
}
