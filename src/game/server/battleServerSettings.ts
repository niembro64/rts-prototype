import type { BattleMode } from '../../battleBarConfig';
import {
  loadStoredForceFieldReflectionMode,
  loadStoredForceFieldsObstructSight,
  loadStoredForceFieldsEnabled,
  loadStoredFogOfWarEnabled,
  loadStoredGrid,
  loadStoredMirrorsEnabled,
} from '../../battleBarConfig';
import {
  loadStoredKeyframeRatio,
  loadStoredSnapshotRate,
  loadStoredTickRate,
  loadStoredUnitGroundNormalEmaMode,
} from '../../serverBarConfig';
import type { GameServer } from './GameServer';
import type { CommandAuthority } from './commandAuthority';

export type StoredBattleServerSettingsOptions = {
  ipAddress?: string;
  maxTotalUnits?: number;
};

export function applyStoredBattleServerSettings(
  server: GameServer,
  mode: BattleMode,
  options: StoredBattleServerSettingsOptions = {},
): void {
  const authority: CommandAuthority = { mode: 'host-admin' };
  server.setTickRate(loadStoredTickRate());
  server.setSnapshotRate(loadStoredSnapshotRate());
  server.setKeyframeRatio(loadStoredKeyframeRatio());
  server.receiveCommand({
    type: 'setUnitGroundNormalEmaMode',
    tick: 0,
    mode: loadStoredUnitGroundNormalEmaMode(),
  }, authority);

  if (options.ipAddress !== undefined) {
    server.setIpAddress(options.ipAddress);
  }
  if (options.maxTotalUnits !== undefined) {
    server.receiveCommand({
      type: 'setMaxTotalUnits',
      tick: 0,
      maxTotalUnits: options.maxTotalUnits,
    }, authority);
  }

  server.receiveCommand({
    type: 'setMirrorsEnabled',
    tick: 0,
    enabled: loadStoredMirrorsEnabled(mode),
  }, authority);
  server.receiveCommand({
    type: 'setForceFieldsEnabled',
    tick: 0,
    enabled: loadStoredForceFieldsEnabled(mode),
  }, authority);
  server.receiveCommand({
    type: 'setForceFieldsObstructSight',
    tick: 0,
    enabled: loadStoredForceFieldsObstructSight(mode),
  }, authority);
  server.receiveCommand({
    type: 'setForceFieldReflectionMode',
    tick: 0,
    mode: loadStoredForceFieldReflectionMode(mode),
  }, authority);
  server.receiveCommand({
    type: 'setFogOfWarEnabled',
    tick: 0,
    enabled: loadStoredFogOfWarEnabled(mode),
  }, authority);
  server.receiveCommand({
    type: 'setSendGridInfo',
    tick: 0,
    enabled: loadStoredGrid(mode),
  }, authority);
}
